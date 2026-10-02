"use strict";
// Shared managed-generation primitives for opencode-family members with
// managedMaterialization:true (#1026).
//
// WHY THIS EXISTS
//   The packaged Clawd app ships its hooks under app.asar.unpacked next to
//   Program Files. opencode 1.18.31 silently skips plugin dirs it cannot read
//   there. The fix is not to copy files once, but to maintain a single,
//   content-addressed, verified generation under the target home and register
//   THAT. Content addressing keeps the bundle (four files, plus the opencode
//   v2 entry file) from tearing across
//   versions; the target owner record lets the plugin itself detect orphaned
//   generations after Clawd is deleted and go inert.
//
// LAYOUT (per target home):
//   <homeDir>/.clawd/integrations/opencode-family/<agentId>/
//     homes/<sha256(canonical-config-dir)>/
//       owner.json
//       mutation.lock/lock.json
//       generations/<bundleHash>/
//         manifest.json
//         <agentId>-plugin/index.mjs
//         <agentId>-plugin/package.json
//         opencode-family-plugin/core.mjs
//         opencode-family-plugin/session-ids.mjs
//         [<agentId>-plugin-v2/index.mjs]   ← opencode only, issue #1039
//
// SAFETY INVARIANTS (from the v3 plan):
//   - Source is read-only: nothing here ever mutates or chmods the source
//     plugin dir / app.asar.unpacked.
//   - New files are created by the current user and inherit the parent dir's
//     normal ACL. No chmod-to-readonly, no deny-write ACL, no W_OK probe.
//   - A generation dir with a matching hash whose content differs is a
//     conflict; it is never overwritten or "repaired" in place.
//   - All deletions prove the resolved path is inside the exact target
//     generations/ dir first. No recursive targetRoot/source cleanup.
//
// This module intentionally depends only on Node built-ins.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCHEMA = 1;
const TARGET_OWNER_LITERAL = "clawd-on-desk.opencode-family.target";
const GENERATION_OWNER_LITERAL = "clawd-on-desk.opencode-family";
const LOCK_OWNER_LITERAL = "clawd-on-desk.opencode-family.target.lock";
const SHARED_PLUGIN_DIR = "opencode-family-plugin";
const MANIFEST_NAME = "manifest.json";
const OWNER_NAME = "owner.json";
const LOCK_DIR_NAME = "mutation.lock";
const LOCK_FILE_NAME = "lock.json";
const DEFAULT_LOCK_TIMEOUT_MS = 60 * 1000;
const KNOWN_PATH_LIMIT = 16;

function familyManagedRoot(agentId) {
  return `.clawd/integrations/opencode-family/${agentId}`;
}

// One canonical path identity for target hashing, containment and entry
// equality (#1026 §4.2). Callers MUST use this instead of ad-hoc normalize
// so a junction/symlink/Windows subst alias cannot produce a different hash
// at one call site than another.
function resolveCanonical(target, platform, fsImpl) {
  const plat = platform || process.platform;
  const fsy = fsImpl || fs;
  const modifier = plat === "win32" ? path.win32 : path.posix;
  const normalize = (value) => modifier.normalize(value);
  let normalized = normalize(target);
  let resolved = false;
  const realpathSync = fsy && typeof fsy.realpathSync === "function"
    ? (typeof fsy.realpathSync.native === "function"
      ? (value) => fsy.realpathSync.native(value)
      : (value) => fsy.realpathSync(value))
    : null;
  if (realpathSync) {
    // The config leaf may not exist yet (for example, an explicit configPath
    // under a symlinked HOME). Resolve the nearest existing ancestor and add
    // the missing lexical suffix back. Creating those missing components as
    // ordinary directories preserves the identity; a later symlink may
    // intentionally resolve to a different filesystem identity.
    let cursor = normalized;
    const missingSuffix = [];
    while (cursor) {
      try {
        const real = realpathSync(cursor);
        if (real) {
          // Windows can report ENOENT (instead of ENOTDIR) for a missing path
          // below an existing file. If we walked up at least one component,
          // only a real directory may anchor the missing lexical suffix;
          // otherwise a file such as ~/.config could be mistaken for a safe
          // config-directory ancestor.
          if (missingSuffix.length > 0) {
            let isDirectory = false;
            try {
              isDirectory = fsy.statSync(real).isDirectory();
            } catch {}
            if (!isDirectory) break;
          }
          normalized = normalize(missingSuffix.length
            ? modifier.join(real, ...missingSuffix)
            : real);
          resolved = true;
        }
        break;
      } catch (err) {
        // ENOENT means the lexical leaf is missing, so walking to an existing
        // ancestor is safe. ENOTDIR means an existing component is a file (or
        // otherwise not traversable as a directory); never reinterpret that
        // conflict as a missing leaf and mint a managed identity beneath it.
        if (!err || err.code !== "ENOENT") break;
        const parent = modifier.dirname(cursor);
        if (!parent || parent === cursor) break;
        const basename = modifier.basename(cursor);
        if (!basename) break;
        missingSuffix.unshift(basename);
        cursor = parent;
      }
    }
  }
  // Keep the lexical normalized form when no ancestor can be resolved;
  // `resolved` stays false so mutation callers can fail closed.
  if (plat === "win32") normalized = normalized.toLowerCase();
  // path.win32.normalize keeps a trailing separator when the input had one;
  // drop it (except at a root) so identity is stable.
  const root = modifier.parse(normalized).root;
  while (normalized.length > root.length && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
    normalized = normalized.slice(0, -1);
  }
  return { canonical: normalized, resolved };
}

function canonicalizeTargetPath(target, platform, fsImpl) {
  if (typeof target !== "string" || !target) return null;
  return resolveCanonical(target, platform, fsImpl).canonical;
}

// Strict variant: returns null when the path cannot be resolved through
// realpath. Used to gate ownership of EXISTING entries, so a lexical fallback
// can never promote an unresolvable existing path to owned.
function canonicalizeTargetPathStrict(target, platform, fsImpl) {
  if (typeof target !== "string" || !target) return null;
  const { canonical, resolved } = resolveCanonical(target, platform, fsImpl);
  return resolved ? canonical : null;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Synchronous sleep used for the bounded interactive lock retry and the
// transient-rename retry. `Atomics.wait` blocks without spinning; the function
// is injectable so tests can assert the retry cadence deterministically.
function sleepSync(ms) {
  const wait = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (wait <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  } catch {
    const until = Date.now() + wait;
    while (Date.now() < until) { /* fallback busy wait */ }
  }
}



function isPathWithin(candidateCanonical, rootCanonical) {
  if (typeof candidateCanonical !== "string" || typeof rootCanonical !== "string") return false;
  // canonicalizeTargetPath keeps platform separators, so normalize both sides
  // to forward slashes before the prefix check (Windows uses "\\").
  const candidate = candidateCanonical.replace(/\\/g, "/");
  const rootRaw = rootCanonical.replace(/\\/g, "/");
  if (candidate === rootRaw) return true;
  const root = rootRaw.endsWith("/") ? rootRaw : `${rootRaw}/`;
  return candidate.startsWith(root);
}

function resolveManagedTarget(options = {}) {
  const cfg = options.cfg;
  const agentId = options.agentId;
  if (!cfg || !agentId) throw new Error("resolveManagedTarget: cfg and agentId are required");
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;

  let homeDir = null;
  if (typeof options.homeDir === "string" && options.homeDir.trim()) {
    homeDir = path.resolve(options.homeDir);
  }

  let configDir;
  if (typeof options.configPath === "string" && options.configPath) {
    configDir = path.dirname(path.resolve(options.configPath));
  } else if (homeDir) {
    configDir = path.join(homeDir, ...cfg.configDirSegments);
  } else {
    configDir = path.join(os.homedir(), ...cfg.configDirSegments);
  }

  const configIdentity = resolveCanonical(configDir, platform, fsImpl);
  const canonicalConfigDir = configIdentity.canonical;
  const configDirHash = sha256Hex(canonicalConfigDir);

  let agentRoot;
  if (typeof options.managedRoot === "string" && options.managedRoot.trim()) {
    agentRoot = path.resolve(options.managedRoot);
  } else {
    const baseHome = homeDir || os.homedir();
    agentRoot = path.join(baseHome, ...familyManagedRoot(agentId).split("/"));
  }

  const targetRoot = path.join(agentRoot, "homes", configDirHash);
  return {
    agentId,
    homeDir: homeDir || os.homedir(),
    configDir,
    canonicalConfigDir,
    canonicalConfigDirResolved: configIdentity.resolved,
    configDirHash,
    agentRoot,
    targetRoot,
    ownerPath: path.join(targetRoot, OWNER_NAME),
    lockPath: path.join(targetRoot, LOCK_DIR_NAME),
    lockFilePath: path.join(targetRoot, LOCK_DIR_NAME, LOCK_FILE_NAME),
    generationsDir: path.join(targetRoot, "generations"),
    configFileName: cfg.configFileName,
  };
}

function generationDir(target, bundleHash) {
  return path.join(target.generationsDir, bundleHash);
}

// ---------------------------------------------------------------------------
// Bundle / manifest
// ---------------------------------------------------------------------------

function bundleRelPaths(pluginDirName, v2PluginDirName) {
  const rels = [
    `${pluginDirName}/index.mjs`,
    `${pluginDirName}/package.json`,
    `${SHARED_PLUGIN_DIR}/core.mjs`,
    `${SHARED_PLUGIN_DIR}/session-ids.mjs`,
  ];
  // OpenCode 2.x entry (issue #1039): a single extra file — the v2 loader
  // resolves a directory specifier to its index.mjs without needing a
  // package.json (verified on 2.0.15). Members without a v2 entry (MiMo)
  // keep the four-file bundle.
  if (v2PluginDirName) rels.push(`${v2PluginDirName}/index.mjs`);
  return rels;
}

// Source root is the hooks/ directory that contains both <plugin>/ and
// opencode-family-plugin/. `sourcePluginDir` is the source <plugin>/ dir.
function readSourceBundle(cfg, sourcePluginDir, fsImpl) {
  const fsy = fsImpl || fs;
  const sourceRoot = path.dirname(sourcePluginDir);
  const files = [];
  for (const rel of bundleRelPaths(cfg.pluginDirName, cfg.v2PluginDirName)) {
    const abs = path.join(sourceRoot, ...rel.split("/"));
    let bytes;
    try {
      bytes = fsy.readFileSync(abs);
    } catch (err) {
      const error = new Error(`packaging error: cannot read source asset ${abs}: ${err.message}`);
      error.code = "packaging-error";
      error.reason = "packaging-error";
      error.missing = abs;
      throw error;
    }
    files.push({ rel, bytes });
  }
  return { sourceRoot, files };
}

function compareRelPaths(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : (a > b ? 1 : 0);
}

function computeBundleHash(agentId, files) {
  const hash = crypto.createHash("sha256");
  hash.update(`schema:${SCHEMA}\nagentId:${agentId}\n`);
  const sorted = [...files].sort((a, b) => compareRelPaths(a.rel, b.rel));
  for (const file of sorted) {
    const pathBuf = Buffer.from(file.rel, "utf8");
    hash.update(`${pathBuf.length}:`);
    hash.update(pathBuf);
    hash.update(`\n${file.bytes.length}:`);
    hash.update(file.bytes);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function buildManifest(agentId, files, bundleHash, clawdVersion) {
  const manifest = {
    schema: SCHEMA,
    owner: GENERATION_OWNER_LITERAL,
    agentId,
    bundleHash,
    sourceClawdVersion: typeof clawdVersion === "string" ? clawdVersion : null,
    files: {},
  };
  for (const file of files) {
    manifest.files[file.rel] = {
      sha256: sha256Hex(file.bytes),
      bytes: file.bytes.length,
    };
  }
  return manifest;
}

function readJsonSafe(fsImpl, filePath) {
  try {
    const text = fsImpl.readFileSync(filePath, "utf8");
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch {
    return null;
  }
}

// Validate a generation directory against its own manifest AND, when
// `expectedFiles` is supplied, against the current source bytes. This is the
// single inspector used by install, uninstall, Doctor and the classifier.
function inspectGeneration(genDir, cfg, agentId, options = {}) {
  const fsImpl = options.fs || fs;
  const rels = bundleRelPaths(cfg.pluginDirName, cfg.v2PluginDirName);
  const dirName = path.basename(genDir);

  // A committed generation directory is content-addressed: its name MUST be
  // the 64-hex bundle hash. Staging directories are only inspected with an
  // explicit expectedBundleHash.
  const expectedHash = options.expectedBundleHash || null;
  if (!expectedHash && !/^[0-9a-f]{64}$/.test(dirName)) {
    return { ok: false, reason: "generation-dir-not-content-addressed" };
  }

  const manifest = readJsonSafe(fsImpl, path.join(genDir, MANIFEST_NAME));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, reason: "manifest-missing" };
  }
  if (manifest.owner !== GENERATION_OWNER_LITERAL || manifest.schema !== SCHEMA) {
    return { ok: false, reason: "manifest-owner-mismatch" };
  }
  if (manifest.agentId !== agentId) return { ok: false, reason: "manifest-agent-mismatch" };
  if (typeof manifest.bundleHash !== "string" || !/^[0-9a-f]{64}$/.test(manifest.bundleHash)) {
    return { ok: false, reason: "manifest-hash-malformed" };
  }
  const effectiveExpected = expectedHash || dirName;
  if (manifest.bundleHash !== effectiveExpected) return { ok: false, reason: "manifest-hash-mismatch" };
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    return { ok: false, reason: "manifest-files-missing" };
  }
  // Exactly the contract paths — no extra, no missing. The pre-#1039 four-file
  // set remains a valid historical generation shape (owned-stale): registered
  // targets written by older Clawd versions must keep classifying as
  // owned-managed-stale so register can migrate them; anything else is a
  // tampered/incoherent manifest and fails closed.
  const manifestKeys = Object.keys(manifest.files).sort();
  const expectedKeys = [...rels].sort();
  const legacyKeys = cfg.v2PluginDirName
    ? [...bundleRelPaths(cfg.pluginDirName, null)].sort()
    : expectedKeys;
  const matchesSet = (keys) => manifestKeys.length === keys.length
    && manifestKeys.every((key, i) => key === keys[i]);
  if (!matchesSet(expectedKeys) && !matchesSet(legacyKeys)) {
    return { ok: false, reason: "manifest-file-set-mismatch" };
  }
  const relsToVerify = matchesSet(expectedKeys) ? rels : bundleRelPaths(cfg.pluginDirName, null);

  const byRel = new Map();
  for (const file of (options.files || [])) byRel.set(file.rel, file.bytes);

  const diskFiles = [];
  for (const rel of relsToVerify) {
    const entry = manifest.files[rel];
    if (!entry || typeof entry.sha256 !== "string" || !Number.isInteger(entry.bytes)) {
      return { ok: false, reason: "manifest-file-entry-missing", rel };
    }
    const abs = path.join(genDir, ...rel.split("/"));
    let bytes;
    try {
      bytes = fsImpl.readFileSync(abs);
    } catch {
      return { ok: false, reason: "generation-file-missing", rel, path: abs };
    }
    if (bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
      return { ok: false, reason: "generation-file-hash-mismatch", rel, path: abs };
    }
    if (byRel.has(rel)) {
      const expected = byRel.get(rel);
      if (!expected.equals(bytes)) return { ok: false, reason: "generation-source-mismatch", rel, path: abs };
    }
    diskFiles.push({ rel, bytes });
  }

  // Recompute the content address from the on-disk bytes; a self-consistent
  // forged manifest must not be trusted on its own.
  if (computeBundleHash(agentId, diskFiles) !== manifest.bundleHash) {
    return { ok: false, reason: "bundle-hash-recompute-mismatch" };
  }

  const indexSource = (() => {
    try { return fsImpl.readFileSync(path.join(genDir, `${cfg.pluginDirName}/index.mjs`), "utf8"); } catch { return null; }
  })();
  if (indexSource !== null && hasNamedExport(indexSource)) {
    return { ok: false, reason: "extra-module-exports" };
  }
  return { ok: true, manifest };
}

// Same single-default-export scan as the Doctor validator, duplicated so this
// module stays dependency-free for the standalone plugin bundle.
function hasNamedExport(source) {
  if (typeof source !== "string" || !source) return false;
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return /^[ \t]*export\s+(?!default\b)(?:const|let|var|function|class|async|\{|\*)/m.test(stripped);
}

// Compare an arbitrary plugin-dir copy's four files to the current source
// bundle without assuming any managed boundary. Used for verified-current-copy.
function bundleBytesMatch(pluginDir, cfg, sourceFiles, fsImpl) {
  const fsy = fsImpl || fs;
  const root = path.dirname(pluginDir);
  const byRel = new Map(sourceFiles.map((file) => [file.rel, file.bytes]));
  for (const rel of bundleRelPaths(cfg.pluginDirName, cfg.v2PluginDirName)) {
    const expected = byRel.get(rel);
    if (!expected) return false;
    const abs = path.join(root, ...rel.split("/"));
    let bytes;
    try {
      bytes = fsy.readFileSync(abs);
    } catch {
      return false;
    }
    if (!expected.equals(bytes)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Target lock
// ---------------------------------------------------------------------------

function makeLockRecord(operation, timeoutMs) {
  return {
    schema: SCHEMA,
    owner: LOCK_OWNER_LITERAL,
    token: crypto.randomBytes(16).toString("hex"),
    pid: process.pid,
    operation: typeof operation === "string" ? operation : "unknown",
    startedAt: new Date().toISOString(),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LOCK_TIMEOUT_MS,
  };
}

function readLockRecord(target, fsImpl) {
  const record = readJsonSafe(fsImpl, target.lockFilePath);
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.owner !== LOCK_OWNER_LITERAL || record.schema !== SCHEMA) return null;
  if (typeof record.token !== "string" || !record.token) return null;
  // PID must be a positive integer; a float/NaN/0/negative lock is corrupt and
  // never eligible for stale takeover.
  if (!Number.isInteger(record.pid) || record.pid <= 0) return null;
  if (typeof record.operation !== "string" || !record.operation) return null;
  if (!Number.isFinite(record.timeoutMs) || record.timeoutMs <= 0) return null;
  if (typeof record.startedAt !== "string" || !record.startedAt) return null;
  if (!Number.isFinite(Date.parse(record.startedAt))) return null;
  return record;
}

function pidIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") return true; // exists but not ours → treat as live/unknown
    if (err && err.code === "ESRCH") return false;
    return true; // unknown probe result → do not take over
  }
}

function lockIsStale(record, nowMs) {
  const started = Date.parse(record.startedAt);
  if (!Number.isFinite(started)) return false;
  return (nowMs - started) > (record.timeoutMs * 2);
}

const DEFAULT_LOCK_RETRY_DELAY_MS = 100;
const DEFAULT_RENAME_RETRY_DELAY_MS = 25;

// Cleanup after a failed lock-record write, WITHOUT ever deleting a record we
// cannot prove is ours. Returns a truthful inspection string.
function cleanupLockAfterWriteFailure(target, fsImpl, token) {
  const existing = readLockRecord(target, fsImpl);
  let filePresent = true;
  try { filePresent = fsImpl.existsSync(target.lockFilePath); } catch { filePresent = true; }

  if (existing && existing.token === token) {
    // Our own record: remove only it, then the exact empty directory.
    try { fsImpl.rmSync(target.lockFilePath, { force: true }); } catch {}
    try {
      fsImpl.rmdirSync(target.lockPath);
      return "lock.json write failed; our own record was removed and the exact directory cleaned";
    } catch {
      return "lock.json write failed; our own record was removed but the lock directory still contains unexpected content; inspect manually";
    }
  }

  // Foreign / corrupt / unreadable / absent record: never delete the file.
  try {
    fsImpl.rmdirSync(target.lockPath);
    return filePresent
      ? "lock.json write failed; the lock directory was cleaned"
      : "lock.json write failed; no target record was created and the empty lock directory was cleaned";
  } catch {
    return existing
      ? "lock.json write failed; a foreign or unexpected lock record was preserved; inspect manually"
      : "lock.json write failed; the lock directory is non-empty and was preserved; inspect manually";
  }
}

// Acquire the per-target mutation lock.
//
// `options.retry === true` (interactive Install/Repair/CLI/Uninstall/About
// cleanup) allows exactly one short, bounded wait + re-attempt against a valid
// live lock. Startup automatic never waits (single attempt). A corrupt/foreign
// lock is never retried or taken over. Stale takeover still requires a fully
// valid record, age > 2x owner timeout, and a PID probe that is definitely
// ESRCH; a successful takeover does not consume the retry budget.
//
// `options.sleep` is injectable for deterministic tests.
//
// Returns { ok:true, lock:{token, lockPath, record} } or
// { ok:false, reason:"locked", lockPath, inspection }.
function acquireTargetLock(target, options = {}) {
  const fsImpl = options.fs || fs;
  const operation = options.operation || "unknown";
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const sleep = typeof options.sleep === "function" ? options.sleep : sleepSync;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0
    ? options.retryDelayMs
    : DEFAULT_LOCK_RETRY_DELAY_MS;
  const interactive = options.retry === true;
  const attempts = Number.isInteger(options.retries) && options.retries > 0
    ? options.retries
    : (interactive ? 2 : 1);

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fsImpl.mkdirSync(target.targetRoot, { recursive: true });
      fsImpl.mkdirSync(target.lockPath);
      const record = makeLockRecord(operation, timeoutMs);
      try {
        writeFileAtomic(fsImpl, target.lockFilePath, JSON.stringify(record, null, 2));
      } catch (err) {
        // The target file is NOT proven ours: lock.json may have appeared from
        // a racing writer. Only delete it when a re-read proves this
        // invocation's exact token. Never recurse; preserve foreign content.
        const inspection = cleanupLockAfterWriteFailure(target, fsImpl, record.token);
        if (err && typeof err === "object") {
          err.lockPath = target.lockPath;
          err.inspection = inspection;
        }
        throw err;
      }
      return { ok: true, lock: { token: record.token, lockPath: target.lockPath, record } };
    } catch (err) {
      if (!err || (err.code !== "EEXIST" && err.code !== "ENOTEMPTY")) throw err;
    }

    const record = readLockRecord(target, fsImpl);
    if (!record) {
      // Lock dir exists but its owner record is corrupt/foreign. Never take
      // over and never wait on it: report the exact path for inspection.
      return {
        ok: false,
        reason: "locked",
        lockPath: target.lockPath,
        inspection: "corrupt-or-foreign lock owner record; inspect manually",
      };
    }

    const nowMs = Date.now();
    const quarantine = path.join(
      target.targetRoot,
      `.mutation-lock-quarantine-${record.pid}-${nowMs}-${crypto.randomBytes(4).toString("hex")}`
    );
    if (lockIsStale(record, nowMs) && !pidIsAlive(record.pid)) {
      try {
        fsImpl.renameSync(target.lockPath, quarantine);
      } catch (err) {
        return {
          ok: false,
          reason: "locked",
          lockPath: target.lockPath,
          inspection: `stale lock takeover failed: ${err && err.message}`,
        };
      }
      // Best-effort cleanup of the quarantined copy; the takeover already
      // succeeded atomically.
      try { fsImpl.rmSync(quarantine, { recursive: true, force: true }); } catch {}
      // A successful takeover must not consume the retry budget.
      attempt -= 1;
      continue;
    }

    // Valid live/held lock. Only an interactive caller with a remaining
    // attempt performs the one bounded wait + retry.
    const isLastAttempt = attempt >= attempts - 1;
    if (interactive && !isLastAttempt) {
      sleep(retryDelayMs);
      continue;
    }

    return {
      ok: false,
      reason: "locked",
      lockPath: target.lockPath,
      inspection: pidIsAlive(record.pid)
        ? `held by live pid ${record.pid} (operation ${record.operation})`
        : `held by pid ${record.pid} (operation ${record.operation})`,
    };
  }

  return { ok: false, reason: "locked", lockPath: target.lockPath, inspection: "lock contention" };
}

// Release only this invocation's lock. Deletes the verified lock record, then
// the now-empty exact lock directory. NO recursive fallback: unexpected
// content that appeared after the token check is preserved for inspection and
// the release truthfully reports failure.
function releaseTargetLock(target, lock, fsImpl) {
  const fsy = fsImpl || fs;
  if (!lock || typeof lock.token !== "string") return false;
  const record = readLockRecord(target, fsy);
  if (!record || record.token !== lock.token) return false;
  try {
    fsy.rmSync(target.lockFilePath, { force: true });
  } catch {
    return false;
  }
  try {
    fsy.rmdirSync(target.lockPath);
  } catch {
    // Non-empty / foreign content (or any failure) — leave it untouched.
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Owner record
// ---------------------------------------------------------------------------

function isAbsoluteAny(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
}

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

// The canonical source marker for an agent plugin: <root>/<pluginDirName>/index.mjs.
function expectedSourceMarker(root, pluginDirName) {
  return path.join(root, pluginDirName, "index.mjs");
}

// Structural owner-record validation (no filesystem liveness: a dead marker
// still yields `owned` so callers can take over / diagnose it).
//
// `options`: { agentId, pluginDirName, fs, platform }.
function validateOwnerShape(record, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  const pluginDirName = options.pluginDirName;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reason: "not-object" };
  }
  if (record.owner !== TARGET_OWNER_LITERAL || record.schema !== SCHEMA) {
    return { ok: false, reason: "owner-literal", foreign: true };
  }
  if (record.agentId !== options.agentId) {
    return { ok: false, reason: "agent-mismatch", foreign: true };
  }
  if (typeof record.canonicalConfigDir !== "string" || !record.canonicalConfigDir
      || !isAbsoluteAny(record.canonicalConfigDir)) {
    return { ok: false, reason: "canonical-config-dir" };
  }
  if (typeof record.configDirHash !== "string" || !/^[0-9a-f]{64}$/.test(record.configDirHash)) {
    return { ok: false, reason: "config-dir-hash" };
  }
  if (sha256Hex(record.canonicalConfigDir) !== record.configDirHash) {
    return { ok: false, reason: "config-dir-hash-mismatch" };
  }

  // Bounded, Clawd-written path evidence. A forged/oversized history must not
  // expand the classifier's ownership set.
  if (!Array.isArray(record.knownRegisteredPaths)) {
    return { ok: false, reason: "known-paths-not-array" };
  }
  if (record.knownRegisteredPaths.length > KNOWN_PATH_LIMIT) {
    return { ok: false, reason: "known-paths-over-cap" };
  }
  const seenCanonical = new Set();
  for (const value of record.knownRegisteredPaths) {
    if (typeof value !== "string" || !value || !isAbsoluteAny(value)) {
      return { ok: false, reason: "known-path-invalid" };
    }
    const canonical = canonicalizeTargetPath(value, platform, fsImpl);
    if (canonical === null) return { ok: false, reason: "known-path-unresolvable" };
    if (seenCanonical.has(canonical)) return { ok: false, reason: "known-path-duplicate" };
    seenCanonical.add(canonical);
  }

  const root = record.activeSourceRoot;
  const marker = record.activeSourceMarker;
  if (root === null || root === undefined) {
    // Released record: both source fields must be null together.
    if (marker !== null && marker !== undefined) return { ok: false, reason: "released-pairing" };
    return { ok: true, released: true };
  }
  if (typeof root !== "string" || !root || !isAbsoluteAny(root)) {
    return { ok: false, reason: "source-root" };
  }
  if (typeof marker !== "string" || !marker || !isAbsoluteAny(marker)) {
    return { ok: false, reason: "source-marker" };
  }
  if (typeof pluginDirName !== "string" || !pluginDirName) {
    return { ok: false, reason: "plugin-dir-name-missing" };
  }
  // Marker must be exactly <root>/<pluginDirName>/index.mjs under the shared
  // canonical identity (Windows case/alias folded; POSIX stays case-sensitive).
  const fold = platform === "win32" ? (value) => value.toLowerCase() : (value) => value;
  if (fold(path.posix.basename(normalizeSlashes(marker))) !== "index.mjs") {
    return { ok: false, reason: "marker-basename" };
  }
  const markerDir = path.dirname(marker);
  if (fold(path.posix.basename(normalizeSlashes(markerDir))) !== fold(pluginDirName)) {
    return { ok: false, reason: "marker-plugin-dir" };
  }
  if (canonicalizeTargetPath(path.dirname(markerDir), platform, fsImpl)
      !== canonicalizeTargetPath(root, platform, fsImpl)) {
    return { ok: false, reason: "marker-root-mismatch" };
  }
  return { ok: true, released: false };
}

// Is the recorded marker a live regular file right now? Directory / dangling
// symlink / unreadable → not live.
function isLiveSourceMarker(marker, fsImpl) {
  const fsy = fsImpl || fs;
  try {
    const stat = fsy.statSync(marker);
    return !!(stat && typeof stat.isFile === "function" && stat.isFile());
  } catch {
    return false;
  }
}

// `options`: { platform, pluginDirName }.
function readOwnerRecord(target, agentId, fsImpl, options = {}) {
  const fsy = fsImpl || fs;
  const platform = options.platform || process.platform;
  const pluginDirName = options.pluginDirName;
  let text;
  try {
    text = fsy.readFileSync(target.ownerPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { state: "missing", record: null };
    return { state: "corrupt", record: null, error: err };
  }
  let record;
  try {
    record = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch (err) {
    // A present-but-unparseable record must never be overwritten.
    return { state: "corrupt", record: null, error: err };
  }
  const shape = validateOwnerShape(record, { agentId, pluginDirName, fs: fsy, platform });
  if (!shape.ok) {
    return { state: shape.foreign ? "foreign" : "corrupt", record };
  }
  const sameConfigDir = canonicalizeTargetPath(record.canonicalConfigDir, platform, fsy) === target.canonicalConfigDir;
  if (!sameConfigDir || record.configDirHash !== target.configDirHash) {
    return { state: "mismatch", record };
  }
  return { state: shape.released ? "released" : "owned", record };
}

// `options`: { platform }.
function writeOwnerRecord(target, patch, fsImpl, options = {}) {
  const fsy = fsImpl || fs;
  const platform = options.platform || process.platform;
  fsy.mkdirSync(target.targetRoot, { recursive: true });
  const existing = readOwnerRecord(target, patch.agentId, fsy, options);
  const priorKnown = (existing.state === "owned" || existing.state === "released")
    ? (Array.isArray(existing.record.knownRegisteredPaths) ? existing.record.knownRegisteredPaths : [])
    : [];
  // The newly registered canonical path is ALWAYS retained; bounded history is
  // evicted oldest-first instead of dropping the current path at the cap.
  // Dedupe by canonical identity so we never write a record that our own
  // reader would reject as malformed.
  const known = [];
  const seen = new Set();
  const add = (value) => {
    if (typeof value !== "string" || !value || !isAbsoluteAny(value)) return;
    const canonical = canonicalizeTargetPath(value, platform, fsy);
    if (canonical === null || seen.has(canonical)) return;
    seen.add(canonical);
    known.push(value);
  };
  for (const value of (patch.knownRegisteredPaths || [])) {
    if (known.length >= KNOWN_PATH_LIMIT) break;
    add(value);
  }
  for (const value of priorKnown) {
    if (known.length >= KNOWN_PATH_LIMIT) break;
    add(value);
  }
  const record = {
    schema: SCHEMA,
    owner: TARGET_OWNER_LITERAL,
    agentId: patch.agentId,
    canonicalConfigDir: target.canonicalConfigDir,
    configDirHash: target.configDirHash,
    activeSourceRoot: patch.activeSourceRoot,
    activeSourceMarker: patch.activeSourceMarker,
    knownRegisteredPaths: known,
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(fsy, target.ownerPath, JSON.stringify(record, null, 2));
  return record;
}

// `options`: { platform, pluginDirName }.
function releaseOwnerRecord(target, agentId, sourceRoot, sourceMarker, fsImpl, options = {}) {
  const fsy = fsImpl || fs;
  const platform = options.platform || process.platform;
  const current = readOwnerRecord(target, agentId, fsy, options);
  if (current.state !== "owned") return { released: false, state: current.state, record: current.record };
  // Compare through the shared canonical identity (Windows case/alias folded),
  // using the operation's injected platform/filesystem.
  const sameRoot = canonicalizeTargetPath(current.record.activeSourceRoot, platform, fsy)
    === canonicalizeTargetPath(sourceRoot, platform, fsy);
  const sameMarker = canonicalizeTargetPath(current.record.activeSourceMarker, platform, fsy)
    === canonicalizeTargetPath(sourceMarker, platform, fsy);
  if (!sameRoot || !sameMarker) {
    return { released: false, state: "other-source", record: current.record };
  }
  const record = {
    ...current.record,
    activeSourceRoot: null,
    activeSourceMarker: null,
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(fsy, target.ownerPath, JSON.stringify(record, null, 2));
  return { released: true, record };
}

// ---------------------------------------------------------------------------
// Generation materialization
// ---------------------------------------------------------------------------

function writeFileAtomic(fsImpl, filePath, data, options = {}) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  fsImpl.mkdirSync(dir, { recursive: true, mode: options.dirMode });
  try {
    fsImpl.writeFileSync(tmpPath, data, options.mode === undefined ? undefined : { mode: options.mode });
    fsImpl.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fsImpl.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

// Create (or reuse) the current generation. Returns
// { ok:true, bundleHash, generationDir, pluginDir, reused } or
// { ok:false, reason } on conflict/packaging failure.
function materializeGeneration(target, cfg, sourcePluginDir, options = {}) {
  const fsImpl = options.fs || fs;
  let bundle;
  try {
    bundle = readSourceBundle(cfg, sourcePluginDir, fsImpl);
  } catch (err) {
    return { ok: false, reason: err.reason || "packaging-error", message: err.message, missing: err.missing };
  }
  const bundleHash = computeBundleHash(target.agentId, bundle.files);
  const genDir = generationDir(target, bundleHash);
  const pluginDir = path.join(genDir, cfg.pluginDirName);

  if (fsImpl.existsSync(genDir)) {
    const inspected = inspectGeneration(genDir, cfg, target.agentId, { fs: fsImpl, files: bundle.files });
    if (inspected.ok) return { ok: true, bundleHash, generationDir: genDir, pluginDir, reused: true, files: bundle.files };
    return { ok: false, reason: "generation-conflict", message: `existing generation ${genDir} does not match (${inspected.reason})` };
  }

  fsImpl.mkdirSync(target.generationsDir, { recursive: true });
  const staging = path.join(target.generationsDir, `.staging-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    fsImpl.mkdirSync(staging);
    for (const file of bundle.files) {
      const abs = path.join(staging, ...file.rel.split("/"));
      writeFileAtomic(fsImpl, abs, file.bytes, { mode: 0o600 });
    }
    const manifest = buildManifest(target.agentId, bundle.files, bundleHash, options.clawdVersion);
    writeFileAtomic(fsImpl, path.join(staging, MANIFEST_NAME), JSON.stringify(manifest, null, 2), { mode: 0o600 });

    // Re-read from staging and re-verify before promotion.
    const stagedCheck = inspectGeneration(staging, cfg, target.agentId, {
      fs: fsImpl,
      files: bundle.files,
      expectedBundleHash: bundleHash,
    });
    if (!stagedCheck.ok) {
      return { ok: false, reason: "generation-staging-verify-failed", message: stagedCheck.reason };
    }

    const sleep = typeof options.sleep === "function" ? options.sleep : sleepSync;
    const renameRetryDelayMs = Number.isFinite(options.renameRetryDelayMs) && options.renameRetryDelayMs >= 0
      ? options.renameRetryDelayMs
      : DEFAULT_RENAME_RETRY_DELAY_MS;
    const renameAttempts = 3;
    let renamed = false;
    let lastRenameErr = null;
    for (let attempt = 0; attempt < renameAttempts && !renamed; attempt++) {
      try {
        fsImpl.renameSync(staging, genDir);
        renamed = true;
      } catch (err) {
        lastRenameErr = err;
        if (err && (err.code === "EPERM" || err.code === "EACCES")) {
          if (fsImpl.existsSync(genDir)) {
            const inspected = inspectGeneration(genDir, cfg, target.agentId, { fs: fsImpl, files: bundle.files });
            if (inspected.ok) return { ok: true, bundleHash, generationDir: genDir, pluginDir, reused: true, files: bundle.files };
            return { ok: false, reason: "generation-conflict", message: `racing generation ${genDir} does not match` };
          }
          // Transient Windows EPERM/EACCES: short bounded delay before the
          // next attempt — never after the last one.
          if (attempt < renameAttempts - 1) sleep(renameRetryDelayMs);
          continue;
        }
        throw err;
      }
    }
    if (!renamed) {
      throw lastRenameErr || new Error("generation rename failed");
    }
    return { ok: true, bundleHash, generationDir: genDir, pluginDir, reused: false, files: bundle.files };
  } catch (err) {
    return { ok: false, reason: "generation-write-failed", message: err && err.message };
  } finally {
    // Only ever remove this invocation's staging dir, and only if it is still
    // inside the exact generations dir.
    const resolvedStaging = path.resolve(staging);
    if (isPathWithin(canonicalizeTargetPath(resolvedStaging, options.platform, fsImpl), canonicalizeTargetPath(target.generationsDir, options.platform, fsImpl))) {
      try { fsImpl.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
  }
}

// Move one content-addressed generation out of its canonical hash slot before
// best-effort cleanup or recovery.  The destination stays inside the exact
// generations/ directory and is deliberately non-canonical, so a later
// install can materialize the hash again without overwriting suspicious or
// partially deleted bytes in place.
function quarantineGeneration(target, genDir, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  const canonicalGenerations = canonicalizeTargetPath(target.generationsDir, platform, fsImpl);
  const canonicalGen = canonicalizeTargetPath(genDir, platform, fsImpl);
  const name = path.basename(genDir);
  const directParent = canonicalizeTargetPath(path.dirname(genDir), platform, fsImpl);
  if (!/^[0-9a-f]{64}$/.test(name)
      || canonicalGenerations === null
      || directParent !== canonicalGenerations
      || !isPathWithin(canonicalGen, canonicalGenerations)) {
    return { ok: false, reason: "generation-quarantine-boundary" };
  }
  const label = options.label === "cleanup" ? "cleanup" : "recovery";
  const quarantinePath = path.join(
    target.generationsDir,
    `.${label}-${name}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    fsImpl.renameSync(genDir, quarantinePath);
    return { ok: true, path: quarantinePath };
  } catch (err) {
    return {
      ok: false,
      reason: "generation-quarantine-failed",
      message: err && err.message ? err.message : "failed to quarantine generation",
    };
  }
}

module.exports = {
  SCHEMA,
  TARGET_OWNER_LITERAL,
  GENERATION_OWNER_LITERAL,
  LOCK_OWNER_LITERAL,
  SHARED_PLUGIN_DIR,
  MANIFEST_NAME,
  OWNER_NAME,
  LOCK_DIR_NAME,
  LOCK_FILE_NAME,
  DEFAULT_LOCK_TIMEOUT_MS,
  KNOWN_PATH_LIMIT,
  familyManagedRoot,
  canonicalizeTargetPath,
  canonicalizeTargetPathStrict,
  sha256Hex,
  isPathWithin,
  resolveManagedTarget,
  generationDir,
  bundleRelPaths,
  readSourceBundle,
  computeBundleHash,
  buildManifest,
  inspectGeneration,
  hasNamedExport,
  bundleBytesMatch,
  acquireTargetLock,
  releaseTargetLock,
  readOwnerRecord,
  writeOwnerRecord,
  releaseOwnerRecord,
  validateOwnerShape,
  isLiveSourceMarker,
  expectedSourceMarker,
  materializeGeneration,
  quarantineGeneration,
  sleepSync,
  writeFileAtomic,
  __test: { pidIsAlive, lockIsStale, readLockRecord, compareRelPaths },
};
