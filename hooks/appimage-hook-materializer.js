"use strict";

// Shared, agent-agnostic AppImage hook materializer.
//
// AppImage mounts live under a transient FUSE path (/tmp/.mount_*). Persisting
// an absolute hook command that points into that mount dies as soon as the
// AppImage exits. This module copies the entry points and their static
// relative-require closure into a content-addressed, persistent generation
// under the user's home and returns the stable target paths callers must
// register.
//
// Leaf module by contract: it may only depend on Node builtins and the
// APPIMAGE marker constant in ./server-config. Importing hooks/install.js or
// hooks/codex-install-utils.js from here would create a cycle
// (install.js -> materializer -> install.js) and hand one side a half-built
// module.exports.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { APPIMAGE_HOOK_MARKER_FILE } = require("./server-config");

// Literal CJS requires used by our hooks, not a general JavaScript parser.
// Shared by install.js's dependency preflight and the closure collector below
// so both recognize the same whitespace / quote / extensionless grammar.
const HOOK_RELATIVE_REQUIRE_RE = /\brequire\s*\(\s*(["'])(\.\.?\/[^"'\r\n]+)\1\s*\)/g;

class AppImageHookMaterializerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "AppImageHookMaterializerError";
    this.code = code;
    this.details = details || null;
  }
}

function scanRelativeRequires(source) {
  const specs = [];
  for (const match of String(source || "").matchAll(HOOK_RELATIVE_REQUIRE_RE)) {
    specs.push(match[2]);
  }
  return specs;
}

function normalizeEntryPaths(entryPaths, options = {}) {
  const list = [];
  if (Array.isArray(entryPaths)) list.push(...entryPaths);
  else if (typeof entryPaths === "string" && entryPaths) list.push(entryPaths);
  if (Array.isArray(options.extraEntryPaths)) list.push(...options.extraEntryPaths);
  const seen = new Set();
  const normalized = [];
  for (const value of list) {
    if (typeof value !== "string" || !value) continue;
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

function isTextuallyInside(rootDir, target) {
  const relative = path.relative(rootDir, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Exact compatibility grammar for commands written by released AppImage
// builds before hook materialization existed. Basename alone is never enough:
// the path must be rooted in the AppImage FUSE mount and end at the packaged
// hooks entry. This is intentionally lexical because the old mount is normally
// gone by the time an upgrade repairs the persisted command.
function isLegacyAppImageHookPath(value, filename) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const escaped = String(filename || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped || /[\/\\]/.test(String(filename || ""))) return false;
  return new RegExp(
    // AppImage uses the first six basename characters plus six random
    // alphanumerics. Released Clawd artifacts used `Clawd-on-Desk-*` (and the
    // older electron-builder default `Clawd on Desk-*`), so their exact mount
    // prefixes are `Clawd-` and `Clawd `. A broad `Clawd*` prefix would still
    // claim an unrelated `ClawdSomething.AppImage` mount (`ClawdSXXXXXX`).
    `^/tmp/\\.mount_Clawd(?:-| )[A-Za-z0-9]{6}(?:/[^/]+)*/resources/app\\.asar\\.unpacked/hooks/${escaped}$`
  ).test(normalized);
}

// A sentinel-bearing command may survive a release change while its old
// content-addressed generation remains valid. Accept only the exact managed
// layout (one 20-hex generation directory plus the expected entry filename),
// never an arbitrary same-basename path.
function isManagedAppImageHookTarget(value, filename, options = {}) {
  const root = options.materializedRoot
    || path.join(options.homeDir || os.homedir(), ".clawd", "appimage-hooks");
  const normalizedRoot = String(path.resolve(root)).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedValue = String(value || "").replace(/\\/g, "/");
  const relative = normalizedValue.startsWith(`${normalizedRoot}/`)
    ? normalizedValue.slice(normalizedRoot.length + 1)
    : "";
  if (!relative) return false;
  const parts = relative.split("/");
  return parts.length === 2
    && /^[a-f0-9]{20}$/.test(parts[0])
    && parts[1] === filename;
}

// The hooks root is an explicit boundary, never "the common ancestor of every
// entry" — the latter would silently widen to the repo root when a caller adds
// an entry under agents/ or src/, accepting files outside hooks/. Callers that
// know the directory (the Claude resolver, install.js) pass `rootDir`; the
// compatibility wrapper safely defaults to the primary entry's own directory,
// which for a same-directory multi-entry bundle is order-independent.
function resolveHookRootDir(entryPaths, options = {}) {
  if (typeof options.rootDir === "string" && options.rootDir.trim()) {
    return path.resolve(options.rootDir.trim());
  }
  if (!entryPaths.length) {
    throw new AppImageHookMaterializerError(
      "NO_ENTRIES",
      "AppImage hook materialization requires at least one entry path"
    );
  }
  return path.dirname(entryPaths[0]);
}

// Returns the realpath, or null only when the path genuinely does not exist.
// Any other realpath failure (EACCES/EIO/ELOOP/...) must fail closed: treating
// it as "unverifiable, proceed" would let a symlink escape or an unreadable
// ancestor be trusted.
function realpathOrNull(target, fsApi, realpathSync) {
  const fn = typeof realpathSync === "function"
    ? realpathSync
    : (typeof fsApi.realpathSync === "function" ? fsApi.realpathSync.bind(fsApi) : null);
  if (!fn) return null; // no realpath capability injected (e.g. a minimal test fs)
  try {
    return fn(target);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw new AppImageHookMaterializerError(
      "REALPATH_FAILED",
      `Could not verify the real path of ${target}`,
      { path: target, cause: err && err.code ? err.code : "REALPATH_FAILED" }
    );
  }
}

function assertRealpathInsideRoot(target, rootDir, options) {
  const fsApi = options.fs || fs;
  const realpathSync = options.realpathSync;
  const realRoot = realpathOrNull(rootDir, fsApi, realpathSync);
  if (realRoot === null) return;
  const realTarget = realpathOrNull(target, fsApi, realpathSync);
  if (realTarget === null) return;
  if (!isTextuallyInside(realRoot, realTarget)) {
    throw new AppImageHookMaterializerError(
      "OUTSIDE_HOOKS",
      `AppImage hook dependency escaped hooks directory via symlink: ${target}`
    );
  }
}

// Read-only closure walk. Resolves static relative CJS requires from the
// explicit hooks root; anything outside that root (entry or dependency) is a
// structured OUTSIDE_HOOKS failure (never silently followed).
function collectRelativeHookClosure(entryPaths, options = {}) {
  const fsApi = options.fs || fs;
  const entries = normalizeEntryPaths(entryPaths, options);
  const rootDir = resolveHookRootDir(entries, options);
  const pending = [...entries];
  const files = new Map();

  while (pending.length > 0) {
    const current = pending.pop();
    if (files.has(current)) continue;
    if (!isTextuallyInside(rootDir, current)) {
      throw new AppImageHookMaterializerError(
        "OUTSIDE_HOOKS",
        `AppImage hook dependency escaped hooks directory: ${current}`
      );
    }
    let content;
    try {
      content = fsApi.readFileSync(current);
    } catch (err) {
      throw new AppImageHookMaterializerError(
        "READ_FAILED",
        `AppImage hook source is not readable: ${current}`,
        { path: current, cause: err && err.code ? err.code : "READ_FAILED" }
      );
    }
    assertRealpathInsideRoot(current, rootDir, options);
    files.set(current, content);

    const source = content.toString("utf8");
    for (const spec of scanRelativeRequires(source)) {
      const resolved = path.resolve(path.dirname(current), spec);
      const candidate = path.extname(resolved) ? resolved : `${resolved}.js`;
      if (!isTextuallyInside(rootDir, candidate)) {
        throw new AppImageHookMaterializerError(
          "OUTSIDE_HOOKS",
          `AppImage hook dependency escaped hooks directory: ${spec}`,
          { spec, from: current }
        );
      }
      pending.push(candidate);
    }
  }
  return { rootDir, files };
}

// Read-only planning: reads every source byte and computes the deterministic
// generation hash / target map, but never creates a directory or writes a
// file. Phase 1 keeps Codex's existing hash byte protocol exactly (the trimmed
// APPIMAGE value, each relative filename and byte, NUL separators, no schema
// tag) so a behavior-preserving refactor does not orphan existing Codex
// generations. `appImagePath` is NOT realpath-canonicalized — it is the exact
// (trimmed) value the caller supplies, matching the established Codex hash.
function planAppImageHookBundle(entryPaths, options = {}) {
  const fsApi = options.fs || fs;
  const platform = options.platform || process.platform;
  const rawAppImagePath = String(options.appImagePath || "").trim();
  if (!path.posix.isAbsolute(rawAppImagePath)) {
    throw new AppImageHookMaterializerError(
      "INVALID_APPIMAGE_PATH",
      "AppImage hook installation requires an absolute APPIMAGE path"
    );
  }
  const useDefaultRoot = !options.materializedRoot && !options.homeDir;
  if (platform !== process.platform && useDefaultRoot) {
    // A synthesized foreign platform must never fall through to the real
    // ~/.clawd. Tests must pin homeDir or materializedRoot explicitly.
    throw new AppImageHookMaterializerError(
      "UNCONTROLLED_ROOT",
      "AppImage hook materialization for an injected platform requires an explicit homeDir or materializedRoot"
    );
  }

  const entries = normalizeEntryPaths(entryPaths, options);
  const { rootDir, files } = collectRelativeHookClosure(entries, {
    fs: fsApi,
    realpathSync: options.realpathSync,
    rootDir: options.rootDir,
  });
  const ordered = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  const hasher = crypto.createHash("sha256");
  hasher.update(`${rawAppImagePath}\0`);
  for (const [filePath, content] of ordered) {
    hasher.update(`${path.relative(rootDir, filePath)}\0`);
    hasher.update(content);
    hasher.update("\0");
  }

  const materializedRoot = options.materializedRoot
    || path.join(options.homeDir || os.homedir(), ".clawd", "appimage-hooks");
  const generation = hasher.digest("hex");
  const generationDir = path.join(materializedRoot, generation.slice(0, 20));
  const markerPath = path.join(generationDir, APPIMAGE_HOOK_MARKER_FILE);

  const entryTargets = new Map();
  for (const entry of entries) {
    entryTargets.set(entry, path.join(generationDir, path.relative(rootDir, entry)));
  }

  return {
    appImagePath: rawAppImagePath,
    rootDir,
    materializedRoot,
    generation,
    generationDir,
    markerPath,
    entries,
    entryTargets,
    files: ordered.map(([sourcePath, content]) => ({
      sourcePath,
      relativePath: path.relative(rootDir, sourcePath),
      content,
    })),
  };
}

// Byte-exact completeness. existsSync alone is not enough: a truncated or
// same-named-but-wrong-content file would otherwise be trusted and registered.
function isAppImageHookBundleComplete(plan, options = {}) {
  const fsApi = options.fs || fs;
  try {
    if (String(fsApi.readFileSync(plan.markerPath, "utf8")).trim() !== plan.appImagePath) {
      return false;
    }
    for (const file of plan.files) {
      const target = path.join(plan.generationDir, file.relativePath);
      const actual = fsApi.readFileSync(target);
      if (!Buffer.isBuffer(actual) || !actual.equals(file.content)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function tightenDirMode(fsApi, dir) {
  if (process.platform === "win32") return;
  try {
    if (typeof fsApi.chmodSync === "function") fsApi.chmodSync(dir, 0o700);
  } catch {}
}

// Materialize a plan into its content-addressed generation. Concurrent callers
// racing on the same generation resolve through the same atomic-rename path as
// before: the loser confirms byte-completeness (winner's copy) and reuses it.
function materializeAppImageHookBundle(plan, options = {}) {
  const fsApi = options.fs || fs;

  const isComplete = () => isAppImageHookBundleComplete(plan, { fs: fsApi });
  // The materialized root may already exist with looser permissions (e.g. a
  // pre-#1027 install). Tighten it even when the generation itself is already
  // complete — completeness must never be a reason to leave 0755 behind.
  fsApi.mkdirSync(plan.materializedRoot, { recursive: true, mode: 0o700 });
  tightenDirMode(fsApi, plan.materializedRoot);
  if (isComplete()) return { ...plan, wrote: false, replaced: false };

  const stagingDir = `${plan.generationDir}.tmp-${process.pid}-${Date.now()}`;
  let replacedDir = null;
  let wrote = false;
  try {
    fsApi.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    tightenDirMode(fsApi, stagingDir);
    for (const file of plan.files) {
      const target = path.join(stagingDir, file.relativePath);
      fsApi.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fsApi.writeFileSync(target, file.content);
    }
    fsApi.writeFileSync(
      path.join(stagingDir, APPIMAGE_HOOK_MARKER_FILE),
      `${plan.appImagePath}\n`,
      { mode: 0o600 }
    );
    if (fsApi.existsSync(plan.generationDir) && !isComplete()) {
      replacedDir = `${plan.generationDir}.replaced-${process.pid}-${Date.now()}`;
      fsApi.renameSync(plan.generationDir, replacedDir);
    }
    try {
      fsApi.renameSync(stagingDir, plan.generationDir);
      wrote = true;
      // Re-verify bytes after the atomic rename: a concurrent writer could
      // have won the race with a complete copy, but a truncated/incomplete
      // generation must not be reported as materialized.
      if (!isComplete()) {
        throw new AppImageHookMaterializerError(
          "GENERATION_INCOMPLETE",
          `AppImage hook generation did not verify after rename: ${plan.generationDir}`
        );
      }
    } catch (err) {
      // Another process may have won the same content-addressed install.
      if (!isComplete()) {
        if (replacedDir && !fsApi.existsSync(plan.generationDir)) {
          try { fsApi.renameSync(replacedDir, plan.generationDir); } catch {}
        }
        throw err;
      }
      fsApi.rmSync(stagingDir, { recursive: true, force: true });
    }
    if (replacedDir) fsApi.rmSync(replacedDir, { recursive: true, force: true });
  } catch (err) {
    try {
      fsApi.rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    throw err;
  }
  return { ...plan, wrote, replaced: !!replacedDir };
}

// Compatibility wrapper: single entry plus optional extraEntryPaths, returns
// the materialized entry path (not the whole plan).
function materializeAppImageHookScript(entryPath, options = {}) {
  const plan = planAppImageHookBundle(entryPath, options);
  materializeAppImageHookBundle(plan, options);
  const target = plan.entryTargets.get(path.resolve(entryPath));
  if (!target) {
    throw new AppImageHookMaterializerError(
      "ENTRY_NOT_PLANNED",
      `AppImage hook entry was not part of the materialized bundle: ${entryPath}`
    );
  }
  return target;
}

module.exports = {
  APPIMAGE_HOOK_MARKER_FILE,
  HOOK_RELATIVE_REQUIRE_RE,
  AppImageHookMaterializerError,
  scanRelativeRequires,
  collectRelativeHookClosure,
  isLegacyAppImageHookPath,
  isManagedAppImageHookTarget,
  planAppImageHookBundle,
  isAppImageHookBundleComplete,
  materializeAppImageHookBundle,
  materializeAppImageHookScript,
};
