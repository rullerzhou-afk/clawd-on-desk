"use strict";

// ── Official theme installer ──
//
// Extracts a verified `.part` archive into a manager-owned staging directory,
// validates it with the real theme loader/schema (explicitly as
// `isBuiltin=false`), writes the ownership marker *inside staging*, and only
// then commits it with a same-volume rename. The marker-before-rename order is
// deliberate: the Codex Pet flow renames first and writes the marker after,
// which can leave a same-named directory that can never be managed.
//
// Every archive is untrusted input: paths, external attributes, byte counts and
// entry counts are all checked before anything lands on disk, and any failure
// removes staging without creating a target.

const defaultFs = require("node:fs");
const defaultPath = require("node:path");

const MARKER_FILENAME = ".clawd-official-theme.json";
const MARKER_SCHEMA_VERSION = 1;
const MARKER_MANAGED_BY = "clawd";
const MARKER_KIND = "official-theme";
// The only distribution repository a managed official-theme marker may name.
// A marker from anywhere else is foreign and must never be claimed/deleted.
const OFFICIAL_SOURCE_REPOSITORY = "rullerzhou-afk/clawd-themes";

const { ID_PATTERN, VERSION_PATTERN } = (() => ({
  ID_PATTERN: /^[a-z0-9][a-z0-9-]{0,63}$/,
  VERSION_PATTERN: /^\d+\.\d+\.\d+$/,
}))();
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const UNIX_MODE_SHIFT = 16;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

const INSTALL_ERROR_CODES = Object.freeze({
  ZIP_INVALID: "INSTALL_ZIP_INVALID",
  ZIP_ENTRY_PATH: "INSTALL_ZIP_ENTRY_PATH",
  ZIP_ENTRY_TYPE: "INSTALL_ZIP_ENTRY_TYPE",
  ZIP_DUPLICATE: "INSTALL_ZIP_DUPLICATE",
  ZIP_LIMIT: "INSTALL_ZIP_LIMIT",
  ZIP_ENCRYPTED: "INSTALL_ZIP_ENCRYPTED",
  ZIP64_UNSUPPORTED: "INSTALL_ZIP64_UNSUPPORTED",
  THEME_INVALID: "INSTALL_THEME_INVALID",
  MARKER_INVALID: "INSTALL_MARKER_INVALID",
  TARGET_CONFLICT: "INSTALL_TARGET_CONFLICT",
  COMMIT_FAILED: "INSTALL_COMMIT_FAILED",
  CANCELLED: "INSTALL_CANCELLED",
});

function installError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ── Marker ──

function buildMarker({ id, version, archiveSha256, sourceRepository, installedAt }) {
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    managedBy: MARKER_MANAGED_BY,
    kind: MARKER_KIND,
    id,
    version,
    archiveSha256,
    sourceRepository,
    installedAt,
  };
}

function isValidMarkerTimestamp(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function normalizeMarker(value) {
  if (!isPlainObject(value)) return null;
  if (value.schemaVersion !== MARKER_SCHEMA_VERSION) return null;
  if (value.managedBy !== MARKER_MANAGED_BY) return null;
  if (value.kind !== MARKER_KIND) return null;
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) return null;
  if (typeof value.version !== "string" || !VERSION_PATTERN.test(value.version)) return null;
  if (typeof value.archiveSha256 !== "string" || !SHA256_PATTERN.test(value.archiveSha256)) return null;
  // Ownership requires the exact distribution repository; a foreign or missing
  // source is not a managed official theme.
  if (value.sourceRepository !== OFFICIAL_SOURCE_REPOSITORY) return null;
  if (!isValidMarkerTimestamp(value.installedAt)) return null;
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    managedBy: MARKER_MANAGED_BY,
    kind: MARKER_KIND,
    id: value.id,
    version: value.version,
    archiveSha256: value.archiveSha256,
    sourceRepository: OFFICIAL_SOURCE_REPOSITORY,
    installedAt: value.installedAt,
  };
}

// A marker is only ever trusted from a plain regular file we can parse. A
// missing/corrupt/mismatched marker means "not managed": the official manager
// must then fail closed rather than overwrite or delete the directory.
function readOfficialThemeMarker(themeDir, deps = {}) {
  const fs = deps.fs || defaultFs;
  const path = deps.path || defaultPath;
  if (typeof themeDir !== "string" || !themeDir) return null;
  const markerPath = path.join(themeDir, MARKER_FILENAME);
  let stat;
  try {
    stat = fs.lstatSync(markerPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
  return normalizeMarker(raw);
}

function writeOfficialThemeMarker(themeDir, marker, deps = {}) {
  const fs = deps.fs || defaultFs;
  const path = deps.path || defaultPath;
  const normalized = normalizeMarker(marker);
  if (!normalized) throw installError(INSTALL_ERROR_CODES.MARKER_INVALID, "refusing to write an invalid official theme marker");
  const markerPath = path.join(themeDir, MARKER_FILENAME);
  const tmp = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
  fs.renameSync(tmp, markerPath);
  const readback = readOfficialThemeMarker(themeDir, deps);
  if (!readback || readback.id !== normalized.id || readback.version !== normalized.version
    || readback.archiveSha256 !== normalized.archiveSha256
    || readback.sourceRepository !== normalized.sourceRepository) {
    throw installError(INSTALL_ERROR_CODES.MARKER_INVALID, "official theme marker readback failed");
  }
  return readback;
}

function markersMatch(a, b) {
  const left = normalizeMarker(a);
  const right = normalizeMarker(b);
  if (!left || !right) return false;
  return left.id === right.id
    && left.version === right.version
    && left.archiveSha256 === right.archiveSha256
    && left.sourceRepository === right.sourceRepository;
}

// ── ZIP entry validation ──

function decodeZipMode(externalFileAttributes) {
  if (!Number.isInteger(externalFileAttributes) || externalFileAttributes < 0) return null;
  return (externalFileAttributes >>> UNIX_MODE_SHIFT) & 0xffff;
}

// Pure path gate: returns the staging-relative path for a regular file/dir or
// null with a reason. The archive must have exactly one top-level directory and
// its name must equal the catalog id.
function resolveArchiveEntryPath(rawFileName, id) {
  if (typeof rawFileName !== "string" || !rawFileName) {
    return { ok: false, reason: "empty entry name" };
  }
  if (rawFileName.includes("\\")) {
    return { ok: false, reason: "backslash path separator is not allowed" };
  }
  if (rawFileName.includes("\0")) {
    return { ok: false, reason: "NUL byte in entry name" };
  }
  if (rawFileName.startsWith("/") || /^[a-zA-Z]:/.test(rawFileName)) {
    return { ok: false, reason: "absolute path is not allowed" };
  }
  const isDirectoryEntry = rawFileName.endsWith("/");
  const segments = rawFileName.split("/");
  if (isDirectoryEntry) segments.pop();
  if (segments.length === 0) return { ok: false, reason: "empty entry path" };
  const cleaned = [];
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      return { ok: false, reason: "path traversal or empty segment is not allowed" };
    }
    cleaned.push(segment);
  }
  if (cleaned[0] !== id) {
    return { ok: false, reason: `entry is outside the top-level "${id}/" directory` };
  }
  const relativeSegments = cleaned.slice(1);
  return {
    ok: true,
    isDirectoryEntry,
    relativePath: relativeSegments.join("/"),
    isTopLevel: relativeSegments.length === 0,
  };
}

function zipEntryHasZip64(entry) {
  if (!entry) return false;
  if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff) return true;
  const fields = Array.isArray(entry.extraFields) ? entry.extraFields : [];
  return fields.some((field) => field && field.id === ZIP64_EXTRA_FIELD_ID);
}

function isEncryptedEntry(entry) {
  return !!(entry && ((entry.generalPurposeBitFlag || 0) & 0x1));
}

// ── Streaming extraction ──

function defaultOpenZip(partPath, yauzl) {
  return new Promise((resolve, reject) => {
    yauzl.open(partPath, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      validateEntrySizes: true,
      // Reject backslash separators instead of silently normalizing them.
      strictFileNames: true,
    }, (err, zipfile) => {
      if (err) reject(err);
      else resolve(zipfile);
    });
  });
}

function openEntryStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
  });
}

function writeEntryToFile({ fs, stream, destPath, onBytes, onCreate }) {
  return new Promise((resolve, reject) => {
    let out;
    try {
      out = fs.createWriteStream(destPath, { flags: "wx" });
      if (typeof onCreate === "function") onCreate(out);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch {}
      try { out.destroy(); } catch {}
      reject(err);
    };
    let readEnded = false;
    stream.on("error", fail);
    out.on("error", fail);
    // A cancelled/destroyed stream may emit close without error; settle so the
    // caller's await never hangs on a half-open entry. Guard the read close
    // with readEnded so the normal end->close sequence cannot look like failure.
    stream.on("close", () => {
      if (settled || readEnded) return;
      fail(new Error("read stream closed before the entry finished"));
    });
    out.on("close", () => {
      if (settled) return;
      fail(new Error("write stream closed before the entry finished"));
    });
    stream.on("data", (chunk) => {
      if (settled) return;
      try {
        onBytes(chunk.length);
      } catch (err) {
        fail(err);
        return;
      }
      if (!out.write(chunk)) {
        stream.pause();
        out.once("drain", () => { try { stream.resume(); } catch {} });
      }
    });
    stream.on("end", () => {
      if (settled) return;
      readEnded = true;
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  });
}

// Extracts `partPath` into `stagingDir`. `limits` is { maxEntries,
// perEntryMaxBytes, totalMaxBytes }. Absolute, escaping, duplicate,
// case-colliding, symlink/special, encrypted and ZIP64 entries are rejected.
async function extractArchiveToStaging(options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const yauzl = options.yauzl || require("yauzl");
  const { partPath, stagingDir, id, signal } = options;
  const limits = {
    maxEntries: options.maxEntries,
    perEntryMaxBytes: options.perEntryMaxBytes,
    totalMaxBytes: options.totalMaxBytes,
  };
  const openZip = options.openZip || ((p, z) => defaultOpenZip(p, z));

  fs.mkdirSync(stagingDir, { recursive: true });

  const seenPaths = new Set();
  let entryCount = 0;
  let totalUnpacked = 0;
  let zipfile = null;
  let aborted = false;
  let activeRead = null;
  let activeWrite = null;
  let innerFail = null;

  const destroyActive = () => {
    const read = activeRead;
    const write = activeWrite;
    activeRead = null;
    activeWrite = null;
    try { if (read && typeof read.destroy === "function") read.destroy(); } catch {}
    try { if (write && typeof write.destroy === "function") write.destroy(); } catch {}
  };

  // Abort must settle the extraction promise deterministically: close the zip,
  // destroy the in-flight entry/read and write streams, and reject once.
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    try { if (zipfile && typeof zipfile.close === "function") zipfile.close(); } catch {}
    destroyActive();
    if (typeof innerFail === "function") {
      innerFail(installError(INSTALL_ERROR_CODES.CANCELLED, "extraction cancelled"));
    }
  };
  if (signal) {
    if (signal.aborted) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
      throw installError(INSTALL_ERROR_CODES.CANCELLED, "extraction cancelled");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    try {
      zipfile = await openZip(partPath, yauzl);
    } catch (err) {
      throw installError(INSTALL_ERROR_CODES.ZIP_INVALID, `zip could not be opened: ${err && err.message}`);
    }

    if (aborted) throw installError(INSTALL_ERROR_CODES.CANCELLED, "extraction cancelled");

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn) => (value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const fail = finish((err) => {
        destroyActive();
        reject(err);
      });
      innerFail = fail;
      const succeed = finish(resolve);
      const next = () => {
        if (settled || aborted) return;
        try { zipfile.readEntry(); } catch (err) { fail(err); }
      };

      zipfile.on("error", (err) => fail(installError(INSTALL_ERROR_CODES.ZIP_INVALID, `zip error: ${err && err.message}`)));
      zipfile.on("end", () => succeed());
      zipfile.on("entry", (entry) => {
        (async () => {
          if (settled || aborted) return;
          entryCount += 1;
          if (entryCount > limits.maxEntries) {
            throw installError(INSTALL_ERROR_CODES.ZIP_LIMIT, `archive exceeds ${limits.maxEntries} entries`);
          }
          if (isEncryptedEntry(entry)) {
            throw installError(INSTALL_ERROR_CODES.ZIP_ENCRYPTED, "encrypted archive entries are not supported");
          }
          if (zipEntryHasZip64(entry)) {
            throw installError(INSTALL_ERROR_CODES.ZIP64_UNSUPPORTED, "ZIP64 entries are not supported");
          }
          const resolved = resolveArchiveEntryPath(entry.fileName, id);
          if (!resolved.ok) {
            throw installError(INSTALL_ERROR_CODES.ZIP_ENTRY_PATH, `invalid archive entry "${entry.fileName}": ${resolved.reason}`);
          }
          if (!resolved.isDirectoryEntry && resolved.relativePath === "") {
            throw installError(INSTALL_ERROR_CODES.ZIP_ENTRY_PATH, `archive entry "${entry.fileName}" must be the top-level directory`);
          }
          const mode = decodeZipMode(entry.externalFileAttributes);
          if (mode === null || (mode & S_IFMT) === 0) {
            throw installError(INSTALL_ERROR_CODES.ZIP_ENTRY_TYPE, `archive entry "${entry.fileName}" has no explicit Unix file mode`);
          }
          const fileType = mode & S_IFMT;
          const expectDirectory = resolved.isDirectoryEntry;
          if (expectDirectory && fileType !== S_IFDIR) {
            throw installError(INSTALL_ERROR_CODES.ZIP_ENTRY_TYPE, `archive entry "${entry.fileName}" is marked as a directory but carries a non-directory mode`);
          }
          if (!expectDirectory && fileType !== S_IFREG) {
            throw installError(INSTALL_ERROR_CODES.ZIP_ENTRY_TYPE, `archive entry "${entry.fileName}" is not a regular file`);
          }
          // Case-insensitive collisions on every platform: the official packs
          // are authored by us, and Windows would collide regardless.
          const collisionKey = resolved.relativePath.normalize("NFC").toLowerCase();
          if (seenPaths.has(collisionKey)) {
            throw installError(INSTALL_ERROR_CODES.ZIP_DUPLICATE, `duplicate or case-colliding archive entry "${entry.fileName}"`);
          }
          seenPaths.add(collisionKey);

          if (expectedRelPathUnsafe(resolved.relativePath)) {
            throw installError(INSTALL_ERROR_CODES.ZIP_ENTRY_PATH, `archive entry escapes staging: "${entry.fileName}"`);
          }

          if (resolved.isTopLevel && expectDirectory) {
            // The single top-level directory entry itself; staging already exists.
            next();
            return;
          }
          const destPath = path.join(stagingDir, ...resolved.relativePath.split("/"));
          if (!isInside(stagingDir, destPath, path)) {
            throw installError(INSTALL_ERROR_CODES.ZIP_ENTRY_PATH, `archive entry escapes staging: "${entry.fileName}"`);
          }

          if (expectDirectory) {
            fs.mkdirSync(destPath, { recursive: true });
            next();
            return;
          }

          if (!Number.isInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
            throw installError(INSTALL_ERROR_CODES.ZIP_INVALID, `archive entry "${entry.fileName}" has no valid size`);
          }
          if (entry.uncompressedSize > limits.perEntryMaxBytes) {
            throw installError(INSTALL_ERROR_CODES.ZIP_LIMIT, `archive entry "${entry.fileName}" exceeds ${limits.perEntryMaxBytes} bytes`);
          }
          if (totalUnpacked + entry.uncompressedSize > limits.totalMaxBytes) {
            throw installError(INSTALL_ERROR_CODES.ZIP_LIMIT, `archive exceeds ${limits.totalMaxBytes} unpacked bytes`);
          }

          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          const stream = await openEntryStream(zipfile, entry);
          if (settled || aborted) {
            try { if (typeof stream.destroy === "function") stream.destroy(); } catch {}
            return;
          }
          activeRead = stream;
          await writeEntryToFile({
            fs,
            stream,
            destPath,
            onCreate: (writeStream) => { activeWrite = writeStream; },
            onBytes: (bytes) => {
              totalUnpacked += bytes;
              if (totalUnpacked > limits.totalMaxBytes) {
                throw installError(INSTALL_ERROR_CODES.ZIP_LIMIT, `archive exceeds ${limits.totalMaxBytes} unpacked bytes`);
              }
            },
          });
          activeRead = null;
          activeWrite = null;
          next();
        })().catch(fail);
      });
      next();
    });

    if (aborted) throw installError(INSTALL_ERROR_CODES.CANCELLED, "extraction cancelled");
    return { entryCount, unpackedBytes: totalUnpacked };
  } catch (err) {
    // Any extraction failure removes staging: no visible half-install may
    // survive, and the manager never has to reason about a partial tree.
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    throw err;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try { if (zipfile && typeof zipfile.close === "function") zipfile.close(); } catch {}
  }
}

function expectedRelPathUnsafe(relativePath) {
  if (typeof relativePath !== "string") return true;
  if (relativePath.startsWith("/") || relativePath.startsWith("\\")) return true;
  if (/^[a-zA-Z]:/.test(relativePath)) return true;
  return relativePath.split(/[\\/]/).some((segment) => segment === "..");
}

function isInside(rootDir, candidatePath, pathModule = defaultPath) {
  const root = pathModule.resolve(rootDir);
  const candidate = pathModule.resolve(candidatePath);
  const relative = pathModule.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !pathModule.isAbsolute(relative));
}

// ── Commit ──

function lstatDirectory(pathModule, fs, target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw installError(INSTALL_ERROR_CODES.COMMIT_FAILED, `staging directory does not exist: ${target}`);
    }
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw installError(INSTALL_ERROR_CODES.COMMIT_FAILED, `refusing to use non-directory path ${target}`);
  }
  return stat;
}

// Commits a validated staging directory to `<userData>/themes/<id>/`. The
// caller holds the shared `theme` domain lock. `validateStaging` runs before
// the marker write, `validateTarget` after the rename.
function commitStagedInstall(options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const {
    stagingRoot, stagingDir, targetDir, themeCacheDir, id, marker,
    validateStaging, validateTarget, now,
  } = options;

  // Re-check the staging directory is the expected direct child and not a link.
  const stagingParent = path.resolve(path.dirname(stagingDir));
  if (stagingParent !== path.resolve(stagingRoot)) {
    throw installError(INSTALL_ERROR_CODES.COMMIT_FAILED, "staging directory is not inside the manager staging root");
  }
  lstatDirectory(path, fs, stagingDir);

  // Target must not exist in any form (managed or not).
  let targetStat = null;
  try { targetStat = fs.lstatSync(targetDir); } catch (err) { if (!err || err.code !== "ENOENT") throw err; }
  if (targetStat) {
    throw installError(INSTALL_ERROR_CODES.TARGET_CONFLICT, `theme directory already exists: ${targetDir}`);
  }

  if (typeof validateStaging === "function") {
    const result = validateStaging(stagingDir);
    if (!result || result.ok !== true) {
      throw installError(
        INSTALL_ERROR_CODES.THEME_INVALID,
        `staged theme failed validation: ${(result && result.errors && result.errors.join("; ")) || "unknown error"}`,
      );
    }
  }

  // The marker must exist and match before the rename is allowed to happen.
  const stagingMarker = readOfficialThemeMarker(stagingDir, { fs, path });
  if (!stagingMarker || !markersMatch(stagingMarker, marker)) {
    throw installError(INSTALL_ERROR_CODES.MARKER_INVALID, "staged official theme marker is missing or mismatched");
  }

  // Remove any stale theme cache for this id so same-size assets cannot hit an
  // old mtime+size cache entry. Best effort: a missing cache is fine.
  if (themeCacheDir) {
    try { fs.rmSync(path.join(themeCacheDir, id), { recursive: true, force: true }); } catch {}
  }

  try {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.renameSync(stagingDir, targetDir);
  } catch (err) {
    throw installError(INSTALL_ERROR_CODES.COMMIT_FAILED, `could not commit theme directory: ${err && err.message}`);
  }

  let readback = null;
  try {
    readback = typeof validateTarget === "function" ? validateTarget(targetDir) : { ok: true };
  } catch (err) {
    readback = { ok: false, errors: [err && err.message] };
  }

  if (!readback || readback.ok !== true) {
    return cleanupFailedCommit({
      fs, path, targetDir, marker, errors: (readback && readback.errors) || [],
    });
  }

  return { status: "installed", repairRequired: false, errors: [] };
}

// On a failed final readback, only delete the target we just created and only
// when its marker is complete. If deletion also fails, report repair-required
// and leave the scene alone.
function cleanupFailedCommit({ fs, path, targetDir, marker, errors = [] }) {
  const readbackErrors = Array.isArray(errors) ? errors.filter(Boolean) : [];
  const targetMarker = readOfficialThemeMarker(targetDir, { fs, path });
  if (!targetMarker || !markersMatch(targetMarker, marker)) {
    return {
      status: "repair-required",
      repairRequired: true,
      errors: [...readbackErrors, "marker mismatch after failed readback"],
    };
  }
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
  } catch {
    return {
      status: "repair-required",
      repairRequired: true,
      errors: [...readbackErrors, "could not remove failed install"],
    };
  }
  if (fs.existsSync(targetDir)) {
    return {
      status: "repair-required",
      repairRequired: true,
      errors: [...readbackErrors, "failed install directory still present"],
    };
  }
  return { status: "failed", repairRequired: false, errors: readbackErrors };
}

module.exports = {
  MARKER_FILENAME,
  MARKER_SCHEMA_VERSION,
  MARKER_MANAGED_BY,
  MARKER_KIND,
  OFFICIAL_SOURCE_REPOSITORY,
  INSTALL_ERROR_CODES,
  isValidMarkerTimestamp,
  buildMarker,
  normalizeMarker,
  markersMatch,
  readOfficialThemeMarker,
  writeOfficialThemeMarker,
  resolveArchiveEntryPath,
  decodeZipMode,
  zipEntryHasZip64,
  isEncryptedEntry,
  extractArchiveToStaging,
  commitStagedInstall,
  isInside,
  isPlainObject,
};
