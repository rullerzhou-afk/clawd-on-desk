"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { freezeLocalTime, getSystemTimeZone, isValidTimeZone, parseLocalDate } = require("./recap-time");
const {
  RECAP_ATOMIC_TEMP_PATTERN,
  assertRecapPrivatePathSupported,
  hardenRecapPrivateDirectory,
} = require("./recap-private-permissions");

const SCHEMA_VERSION = 1;
const DEFAULT_ROOT = path.join(os.homedir(), ".clawd", "recap-v1");
const EVENT_RETENTION_DAYS = 14;
const DAILY_RETENTION_DAYS = 400;
const TEMP_FILE_TTL_MS = 24 * 60 * 60 * 1000;
const QUARANTINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const QUARANTINE_MAX_FILES = 16;
const QUARANTINE_MAX_BYTES = 1024 * 1024;
const MAX_MANAGED_JSON_BYTES = 8 * 1024 * 1024;
const MAX_META_BYTES = 64 * 1024;

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.parse(root).root === path.resolve(root)) {
    throw new TypeError("recap root must be a non-root absolute path");
  }
  return path.resolve(root);
}

function childPath(root, ...segments) {
  const base = assertRoot(root);
  const resolved = path.resolve(base, ...segments);
  if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("recap path escaped its root");
  }
  return resolved;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function unsafeLinkError(filePath) {
  const err = new Error(`recap managed path must not contain links or reparse points: ${filePath}`);
  err.code = "RECAP_UNSAFE_LINK";
  return err;
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function writeJsonAtomic(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function validMeta(value) {
  return !!(
    value
    && value.schemaVersion === SCHEMA_VERSION
    && Number.isSafeInteger(value.createdAt)
    && value.createdAt >= 0
    && typeof value.hmacSalt === "string"
    && /^[A-Za-z0-9_-]{40,64}$/.test(value.hmacSalt)
  );
}

function validCreatedLocalTime(value) {
  if (!value || !isValidTimeZone(value.timeZoneId) || !Number.isInteger(value.localHour)) return false;
  if (value.localHour < 0 || value.localHour > 23) return false;
  try {
    parseLocalDate(value.localDate);
    return true;
  } catch {
    return false;
  }
}

function createMeta(now = Date.now(), timeZone = getSystemTimeZone()) {
  const createdLocalTime = freezeLocalTime(now, timeZone);
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    createdLocalTime: {
      timeZoneId: createdLocalTime.timeZoneId,
      localDate: createdLocalTime.localDate,
      localHour: createdLocalTime.localHour,
    },
    hmacSalt: crypto.randomBytes(32).toString("base64url"),
    retention: {
      eventDays: EVENT_RETENTION_DAYS,
      dailyDays: DAILY_RETENTION_DAYS,
    },
  };
}

function createRecapStore(options = {}) {
  const root = assertRoot(options.root || DEFAULT_ROOT);
  const logWarn = options.logWarn || console.warn;
  const getTimeZone = options.getTimeZone || getSystemTimeZone;
  const assertPrivatePathSupported = options.assertPrivatePathSupported || assertRecapPrivatePathSupported;
  const hardenPrivateDirectory = options.hardenPrivateDirectory || hardenRecapPrivateDirectory;
  let meta = null;
  let canonicalRoot = null;
  let canonicalRootIdentity = null;
  let hardenedRootIdentity = null;

  function fileIdentity(stat) {
    return `${stat.dev}:${stat.ino}`;
  }

  function copyMeta(value) {
    return {
      ...value,
      createdLocalTime: value.createdLocalTime ? { ...value.createdLocalTime } : null,
      retention: { ...value.retention },
    };
  }

  function warn(message, err) {
    try {
      const detail = err && err.message ? err.message : err;
      if (detail === undefined) logWarn(message);
      else logWarn(message, detail);
    } catch {}
  }

  function pinRoot() {
    let stat;
    try { stat = fs.lstatSync(root, { bigint: true }); } catch (err) {
      if (err && err.code === "ENOENT") return false;
      throw err;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafeLinkError(root);
    const real = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
    canonicalRoot = path.resolve(real);
    canonicalRootIdentity = fileIdentity(stat);
    return true;
  }

  function assertManagedPath(filePath, optionsValue = {}) {
    const resolved = path.resolve(filePath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error("recap managed path escaped its root");
    }
    if (!canonicalRoot) return resolved;
    let rootStat;
    try { rootStat = fs.lstatSync(root, { bigint: true }); } catch (err) {
      if (err && err.code === "ENOENT" && optionsValue.allowMissingRoot === true) return resolved;
      throw err;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw unsafeLinkError(root);
    const currentRoot = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
    if (comparablePath(currentRoot) !== comparablePath(canonicalRoot)) throw unsafeLinkError(root);
    if (fileIdentity(rootStat) !== canonicalRootIdentity) throw unsafeLinkError(root);

    const relative = path.relative(root, resolved);
    if (!relative) return resolved;
    let lexical = root;
    let expected = canonicalRoot;
    for (const segment of relative.split(path.sep)) {
      lexical = path.join(lexical, segment);
      expected = path.join(expected, segment);
      let stat;
      try { stat = fs.lstatSync(lexical); } catch (err) {
        if (err && err.code === "ENOENT") break;
        throw err;
      }
      if (stat.isSymbolicLink()) throw unsafeLinkError(lexical);
      const real = fs.realpathSync.native ? fs.realpathSync.native(lexical) : fs.realpathSync(lexical);
      if (comparablePath(real) !== comparablePath(expected)) throw unsafeLinkError(lexical);
    }
    return resolved;
  }

  function managedChild(...segments) {
    return assertManagedPath(childPath(root, ...segments));
  }

  function listDirectory(...segments) {
    const target = segments.length > 0 ? managedChild(...segments) : assertManagedPath(root);
    return fs.readdirSync(target);
  }

  function cleanupTemps(referenceTime = Date.now()) {
    for (const name of listDirectory()) {
      if (!RECAP_ATOMIC_TEMP_PATTERN.test(name)) continue;
      const filePath = managedChild(name);
      let stat;
      try { stat = fs.lstatSync(filePath); } catch (err) {
        if (err && err.code === "ENOENT") continue;
        throw err;
      }
      if (stat.isSymbolicLink()) throw unsafeLinkError(filePath);
      if (referenceTime - stat.mtimeMs < TEMP_FILE_TTL_MS) continue;
      fs.rmSync(filePath, { recursive: stat.isDirectory(), force: true });
    }
  }

  function pruneQuarantine(referenceTime = Date.now()) {
    const dirPath = managedChild("quarantine");
    let names;
    try { names = listDirectory("quarantine"); } catch (err) {
      if (err && err.code === "ENOENT") return;
      throw err;
    }
    const entries = [];
    for (const name of names) {
      const filePath = managedChild("quarantine", name);
      let stat;
      try { stat = fs.lstatSync(filePath); } catch (err) {
        if (err && err.code === "ENOENT") continue;
        throw err;
      }
      if (stat.isSymbolicLink()) throw unsafeLinkError(filePath);
      if (!stat.isFile()) {
        // Quarantine is an internal flat file bucket. Keeping directories,
        // devices, or sockets would let them bypass both the byte cap and the
        // regular-file ownership model.
        fs.rmSync(filePath, { recursive: stat.isDirectory(), force: true });
        continue;
      }
      entries.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
    let keptFiles = 0;
    let keptBytes = 0;
    for (const entry of entries) {
      const expired = referenceTime - entry.mtimeMs >= QUARANTINE_TTL_MS;
      const overCap = keptFiles >= QUARANTINE_MAX_FILES || keptBytes + entry.size > QUARANTINE_MAX_BYTES;
      if (expired || overCap) {
        fs.rmSync(entry.filePath, { recursive: true, force: true });
      } else {
        keptFiles += 1;
        keptBytes += entry.size;
      }
    }
    // Re-check the directory itself immediately before returning so a swapped
    // junction cannot become the next operation's trusted parent.
    assertManagedPath(dirPath);
  }

  function initialize() {
    assertPrivatePathSupported(root);
    ensureDirectory(root);
    if (!pinRoot()) throw unsafeLinkError(root);
    // POSIX modes do not restrict an NTFS DACL. Harden the root before any
    // metadata or journal directory is created; children then inherit the
    // protected current-user/SYSTEM/Administrators ACL. Failure is fatal so a
    // redirected or shared HOME can never silently receive recap data.
    if (hardenedRootIdentity !== canonicalRootIdentity) {
      hardenPrivateDirectory(root, {
        expectedCanonicalRoot: canonicalRoot,
        expectedIdentity: canonicalRootIdentity,
      });
      hardenedRootIdentity = canonicalRootIdentity;
    }
    ensureDirectory(managedChild("events"));
    assertManagedPath(managedChild("events"));
    cleanupTemps(options.now ? options.now() : Date.now());
    pruneQuarantine(options.now ? options.now() : Date.now());
    const metaPath = managedChild("meta.json");
    let existing = null;
    let metaMissing = false;
    try {
      const metaStat = fs.lstatSync(metaPath);
      if (!metaStat.isFile() || metaStat.size > MAX_META_BYTES) {
        throw new Error("recap identity metadata is invalid; clear recap data to reset it");
      }
      existing = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch (err) {
      if (err && err.code === "ENOENT") metaMissing = true;
      else if (err instanceof SyntaxError || (err && ["EISDIR", "EINVAL"].includes(err.code))) {
        throw new Error("recap identity metadata is invalid; clear recap data to reset it");
      } else {
        // An unreadable salt is not the same as a missing one. Replacing it
        // could silently split old identities, so fail closed instead.
        throw err;
      }
    }
    if (validMeta(existing)) {
      meta = existing;
      // Freeze the civil start boundary once. Re-projecting createdAt in the
      // viewer's current zone would move the start date after travel.
      if (!validCreatedLocalTime(meta.createdLocalTime)) {
        const frozen = freezeLocalTime(meta.createdAt, getTimeZone());
        meta = {
          ...meta,
          createdLocalTime: {
            timeZoneId: frozen.timeZoneId,
            localDate: frozen.localDate,
            localHour: frozen.localHour,
          },
        };
        writeJsonAtomic(metaPath, meta);
      }
    } else {
      let eventNames = [];
      let rootNames = [];
      try { eventNames = listDirectory("events"); }
      catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
      try { rootNames = listDirectory(); } catch (err) { throw err; }
      const hasOldData = eventNames.length > 0 || rootNames.some((name) =>
        /^daily-\d{4}-\d{2}\.json$/.test(name)
        || /^coverage-\d{4}-\d{2}\.json$/.test(name)
        || name === "coverage-open.json");
      // The salt is the identity authority. Without it, old HMAC rows cannot
      // be compared with a new generation. Preserve the old files and stop
      // recording until the user explicitly clears them; never mix salts.
      if (!metaMissing || hasOldData) {
        throw new Error("recap identity metadata is unavailable; clear recap data to reset it");
      }
      meta = createMeta(options.now ? options.now() : Date.now(), getTimeZone());
      writeJsonAtomic(metaPath, meta);
    }
    return copyMeta(meta);
  }

  function getMeta() {
    if (!meta) initialize();
    return copyMeta(meta);
  }

  function hmac(namespace, ...values) {
    if (!meta) initialize();
    const digest = crypto.createHmac("sha256", Buffer.from(meta.hmacSalt, "base64url"));
    digest.update(String(namespace));
    for (const value of values) {
      digest.update("\0");
      digest.update(String(value || ""));
    }
    return `hmac:${digest.digest("base64url")}`;
  }

  function quarantine(filePath, label = "invalid") {
    const resolved = assertManagedPath(filePath);
    if (resolved === root) throw new Error("recap quarantine source escaped its root");
    const quarantineDir = managedChild("quarantine");
    ensureDirectory(quarantineDir);
    assertManagedPath(quarantineDir);
    const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, "-").slice(0, 32) || "invalid";
    const destination = managedChild(
      "quarantine",
      `${path.basename(resolved)}.${safeLabel}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`
    );
    fs.renameSync(resolved, destination);
    pruneQuarantine(options.now ? options.now() : Date.now());
    return destination;
  }

  function readManagedJson(filePath, fallback = null) {
    const resolved = assertManagedPath(filePath);
    let stat;
    try { stat = fs.lstatSync(resolved); } catch (err) {
      if (err && err.code === "ENOENT") return fallback;
      throw err;
    }
    if (!stat.isFile() || stat.size > MAX_MANAGED_JSON_BYTES) return fallback;
    return readJson(resolved, fallback);
  }

  function clear() {
    // Never recursively delete the configured root itself. Each known child is
    // resolved through childPath, so a malformed option cannot widen deletion.
    for (const name of ["events", "quarantine"]) {
      const dirPath = managedChild(name);
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
    let rootNames = [];
    try { rootNames = listDirectory(); } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    for (const name of rootNames) {
      if (
        /^daily-\d{4}-\d{2}\.json$/.test(name)
        || /^coverage-\d{4}-\d{2}\.json$/.test(name)
        || name === "coverage-open.json"
        || RECAP_ATOMIC_TEMP_PATTERN.test(name)
      ) {
        try { fs.rmSync(managedChild(name), { recursive: true, force: true }); } catch (err) {
          if (!err || err.code !== "ENOENT") throw err;
        }
      }
    }
    try { fs.rmSync(managedChild("meta.json"), { recursive: true, force: true }); } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
    meta = null;
    return initialize();
  }

  return Object.freeze({
    root,
    assertManagedPath,
    childPath: (...segments) => managedChild(...segments),
    clear,
    getMeta,
    hmac,
    initialize,
    quarantine,
    listDirectory,
    readJson: readManagedJson,
    writeJsonAtomic: (filePath, value) => writeJsonAtomic(assertManagedPath(filePath), value),
  });
}

module.exports = {
  DAILY_RETENTION_DAYS,
  DEFAULT_ROOT,
  EVENT_RETENTION_DAYS,
  MAX_MANAGED_JSON_BYTES,
  QUARANTINE_MAX_BYTES,
  QUARANTINE_MAX_FILES,
  QUARANTINE_TTL_MS,
  SCHEMA_VERSION,
  TEMP_FILE_TTL_MS,
  childPath,
  createRecapStore,
  readJson,
  writeJsonAtomic,
};
