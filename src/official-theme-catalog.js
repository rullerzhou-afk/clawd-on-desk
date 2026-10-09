"use strict";

// ── Official theme catalog ──
//
// The catalog is a small, strictly validated remote document that lists the
// officially distributed themes and points each one at a versioned GitHub
// Release asset. It is the *only* source of install URLs: the renderer passes
// a themeId, main re-resolves URL/version/bytes/sha from the last-known-good
// catalog it validated itself.
//
// Trust model (v1): repository control + HTTPS. SHA-256 pins the exact archive
// the catalog declares and detects transport/substitution errors; it is not an
// independent signature if the catalog repo account is compromised. An invalid
// or version-regressing catalog never overwrites the last-known-good cache.

const defaultFs = require("node:fs");
const defaultPath = require("node:path");

const CATALOG_URL = "https://raw.githubusercontent.com/rullerzhou-afk/clawd-themes/main/catalog-v1.json";
const CATALOG_REPOSITORY = "rullerzhou-afk/clawd-themes";
const CATALOG_HOST = "raw.githubusercontent.com";
const SCHEMA_VERSION = 1;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_CATALOG_ENTRIES = 200;
const DEFAULT_CATALOG_STALL_TIMEOUT_MS = 10 * 1000;
const DEFAULT_CATALOG_TOTAL_TIMEOUT_MS = 30 * 1000;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Per-entry hard ceilings. The catalog can declare anything smaller; it can
// never talk the app past these.
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const UNPACKED_MAX_BYTES = 256 * 1024 * 1024;
const MIN_ARCHIVE_BYTES = 1;
const MIN_UNPACKED_BYTES = 1;
const PREVIEW_MAX_BYTES = 1024 * 1024;
const MIN_PREVIEW_BYTES = 1;

// Download-time (archive) limits shared with the installer via the catalog
// entry. Kept here so there is one authoritative set of numbers.
const LIMITS = Object.freeze({
  archiveMaxBytes: ARCHIVE_MAX_BYTES,
  unpackedMaxBytes: UNPACKED_MAX_BYTES,
  perEntryMaxBytes: 48 * 1024 * 1024,
  maxEntries: 256,
  maxRedirects: 5,
});

const ERROR_CODES = Object.freeze({
  CATALOG_INVALID: "CATALOG_INVALID",
  CATALOG_OFFLINE: "CATALOG_OFFLINE",
  CATALOG_REGRESSION: "CATALOG_REGRESSION",
  THEME_NOT_FOUND: "THEME_NOT_FOUND",
  THEME_UNSUPPORTED_VERSION: "THEME_UNSUPPORTED_VERSION",
  DOWNLOAD_HOST_UNSUPPORTED: "DOWNLOAD_HOST_UNSUPPORTED",
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseSemver(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) return null;
  return value.split(".").map((part) => Number(part));
}

// Strict numeric compare. Deliberately NOT the updater's lenient
// split(".").map(Number) comparator: a catalog entry with a malformed version
// is dropped, not coerced.
function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function parseHttpsUrl(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url;
}

// Shared HTTPS shape gate for the initial GitHub URL. Redirect hosts get a
// stricter, separate host-allowlist check (validateRedirectUrl).
function checkHttpsShape(url) {
  if (!url || url.protocol !== "https:") return "must be an https: URL";
  if (url.username || url.password) return "must not embed credentials";
  if (url.hash) return "must not contain a fragment";
  const port = url.port === "" ? "443" : url.port;
  if (port !== "443") return `must use the default https port, got ${url.port}`;
  return null;
}

// Initial URL: exactly https://github.com/<repo>/releases/download/<tag>/<asset>
// where tag/asset are pinned to the catalog entry's id/version.
function validateArchiveUrl(rawUrl, { id, version }) {
  const errors = [];
  const url = parseHttpsUrl(rawUrl);
  const shapeError = checkHttpsShape(url);
  if (shapeError) return { ok: false, errors: [`archive.url ${shapeError}`] };
  if (url.hostname !== "github.com") {
    return { ok: false, errors: [`archive.url host must be github.com, got ${url.hostname}`] };
  }
  const expectedPath = `${CATALOG_REPOSITORY}/releases/download/${id}-v${version}/${id}-${version}.clawd-theme.zip`;
  if (url.search) {
    errors.push("archive.url must not contain a query string");
  }
  if (url.pathname !== `/${expectedPath}`) {
    errors.push(`archive.url path must be ${expectedPath}`);
  }
  return { ok: errors.length === 0, errors, url };
}

// License notice URL: only the immutable LICENSE file for this exact theme in
// the official catalog repository. The renderer can therefore treat the
// validated URL as display data without granting the catalog an arbitrary
// external-navigation target.
function validateLicenseNoticeUrl(rawUrl, { id }) {
  const errors = [];
  const url = parseHttpsUrl(rawUrl);
  const shapeError = checkHttpsShape(url);
  if (shapeError) return { ok: false, errors: [`license.noticeUrl ${shapeError}`] };
  if (url.hostname !== "github.com") {
    return { ok: false, errors: [`license.noticeUrl host must be github.com, got ${url.hostname}`] };
  }
  if (url.search) errors.push("license.noticeUrl must not contain a query string");
  const expectedPath = new RegExp(`^/${CATALOG_REPOSITORY}/blob/[0-9a-f]{40}/themes/${id}/LICENSE$`);
  if (!expectedPath.test(url.pathname)) {
    errors.push(`license.noticeUrl must pin themes/${id}/LICENSE to a 40-character commit in ${CATALOG_REPOSITORY}`);
  }
  return { ok: errors.length === 0, errors, url };
}

// Preview images are versioned GitHub Release assets beside the theme archive.
// Main downloads and verifies them before the renderer is given a local file
// URL; the catalog never becomes an arbitrary img-src list.
function validatePreviewUrl(rawUrl, { id, version }) {
  const errors = [];
  const url = parseHttpsUrl(rawUrl);
  const shapeError = checkHttpsShape(url);
  if (shapeError) return { ok: false, errors: [`preview.url ${shapeError}`] };
  if (url.hostname !== "github.com") {
    return { ok: false, errors: [`preview.url host must be github.com, got ${url.hostname}`] };
  }
  if (url.search) errors.push("preview.url must not contain a query string");
  const expectedPath = `/${CATALOG_REPOSITORY}/releases/download/${id}-v${version}/${id}-${version}.preview.webp`;
  if (url.pathname !== expectedPath) {
    errors.push(`preview.url path must be ${expectedPath}`);
  }
  return { ok: errors.length === 0, errors, url };
}

// Public animation showcase: each theme may link only to its matching,
// project-scoped Cloudflare Pages progress page. Keeping the shape fixed means
// the catalog cannot turn the Settings button into an arbitrary external link.
function validateShowcaseUrl(rawUrl, { id }) {
  const errors = [];
  const url = parseHttpsUrl(rawUrl);
  const shapeError = checkHttpsShape(url);
  if (shapeError) return { ok: false, errors: [`showcase.url ${shapeError}`] };
  const expectedHost = `${id}-art.pages.dev`;
  if (url.hostname !== expectedHost) {
    errors.push(`showcase.url host must be ${expectedHost}`);
  }
  if (url.pathname !== "/progress/") {
    errors.push("showcase.url path must be /progress/");
  }
  if (url.search) errors.push("showcase.url must not contain a query string");
  return { ok: errors.length === 0, errors, url };
}

// Central, app-side hardcoded allowlist. The catalog has no way to extend it;
// a GitHub CDN migration surfaces as DOWNLOAD_HOST_UNSUPPORTED.
const REDIRECT_HOST_ALLOWLIST = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

function validateRedirectUrl(rawUrl) {
  const url = parseHttpsUrl(rawUrl);
  const shapeError = checkHttpsShape(url);
  if (shapeError) return { ok: false, errors: [`redirect url ${shapeError}`] };
  if (!REDIRECT_HOST_ALLOWLIST.has(url.hostname)) {
    return {
      ok: false,
      errors: [`unsupported download host ${url.hostname}`],
      code: ERROR_CODES.DOWNLOAD_HOST_UNSUPPORTED,
    };
  }
  return { ok: true, errors: [], url };
}

function validateCatalogEntry(entry) {
  const errors = [];
  if (!isPlainObject(entry)) return { errors: ["theme entry must be an object"] };
  const { id, version } = entry;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    errors.push(`theme id must match ${ID_PATTERN}, got ${JSON.stringify(id)}`);
  }
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    errors.push(`theme "${id}" version must match ${VERSION_PATTERN}, got ${JSON.stringify(version)}`);
  }
  if (entry.name !== undefined && !isPlainObject(entry.name)) {
    errors.push(`theme "${id}" name must be an object of localized strings`);
  }
  if (entry.description !== undefined && !isPlainObject(entry.description)) {
    errors.push(`theme "${id}" description must be an object of localized strings`);
  }
  if (entry.minAppVersion !== undefined && parseSemver(entry.minAppVersion) === null) {
    errors.push(`theme "${id}" minAppVersion must match ${VERSION_PATTERN}`);
  }
  const archive = entry.archive;
  if (!isPlainObject(archive)) {
    errors.push(`theme "${id}" archive must be an object`);
  } else {
    if (typeof id === "string" && typeof version === "string" && VERSION_PATTERN.test(version)) {
      const urlResult = validateArchiveUrl(archive.url, { id, version });
      errors.push(...urlResult.errors);
    }
    if (!Number.isInteger(archive.bytes) || archive.bytes < MIN_ARCHIVE_BYTES || archive.bytes > ARCHIVE_MAX_BYTES) {
      errors.push(`theme "${id}" archive.bytes must be an integer in [${MIN_ARCHIVE_BYTES}, ${ARCHIVE_MAX_BYTES}]`);
    }
    if (!Number.isInteger(archive.unpackedBytes)
      || archive.unpackedBytes < MIN_UNPACKED_BYTES
      || archive.unpackedBytes > UNPACKED_MAX_BYTES) {
      errors.push(`theme "${id}" archive.unpackedBytes must be an integer in [${MIN_UNPACKED_BYTES}, ${UNPACKED_MAX_BYTES}]`);
    }
    if (typeof archive.sha256 !== "string" || !SHA256_PATTERN.test(archive.sha256)) {
      errors.push(`theme "${id}" archive.sha256 must be 64 lowercase hex characters`);
    }
  }
  if (entry.preview !== undefined) {
    if (!isPlainObject(entry.preview)) {
      errors.push(`theme "${id}" preview must be an object`);
    } else {
      if (typeof id === "string" && ID_PATTERN.test(id)) {
        const previewUrlResult = validatePreviewUrl(entry.preview.url, { id, version });
        errors.push(...previewUrlResult.errors.map((message) => `theme "${id}" ${message}`));
      }
      if (!Number.isInteger(entry.preview.bytes)
        || entry.preview.bytes < MIN_PREVIEW_BYTES
        || entry.preview.bytes > PREVIEW_MAX_BYTES) {
        errors.push(`theme "${id}" preview.bytes must be an integer in [${MIN_PREVIEW_BYTES}, ${PREVIEW_MAX_BYTES}]`);
      }
      if (typeof entry.preview.sha256 !== "string" || !SHA256_PATTERN.test(entry.preview.sha256)) {
        errors.push(`theme "${id}" preview.sha256 must be 64 lowercase hex characters`);
      }
    }
  }
  if (entry.showcase !== undefined) {
    if (!isPlainObject(entry.showcase)) {
      errors.push(`theme "${id}" showcase must be an object`);
    } else if (typeof id === "string" && ID_PATTERN.test(id)) {
      const showcaseUrlResult = validateShowcaseUrl(entry.showcase.url, { id });
      errors.push(...showcaseUrlResult.errors.map((message) => `theme "${id}" ${message}`));
    }
  }
  if (!isPlainObject(entry.license)) {
    errors.push(`theme "${id}" license must be an object`);
  } else {
    if (typeof entry.license.spdx !== "string" || !entry.license.spdx) {
      errors.push(`theme "${id}" license.spdx must be a non-empty string`);
    }
    if (typeof id === "string" && ID_PATTERN.test(id)) {
      const noticeUrlResult = validateLicenseNoticeUrl(entry.license.noticeUrl, { id });
      errors.push(...noticeUrlResult.errors.map((message) => `theme "${id}" ${message}`));
    }
    if (!isPlainObject(entry.license.notice)
      || Object.keys(normalizeLocalizedText(entry.license.notice, {})).length === 0) {
      errors.push(`theme "${id}" license.notice must be a non-empty localized text object`);
    }
  }
  return { errors };
}

function normalizeLocalizedText(value, fallback) {
  if (typeof value === "string" && value) return value;
  if (!isPlainObject(value)) return fallback;
  const out = {};
  for (const [lang, text] of Object.entries(value)) {
    if (typeof text === "string" && text) out[lang] = text;
  }
  return Object.keys(out).length > 0 ? out : fallback;
}

function normalizeCatalogEntry(entry) {
  return {
    id: entry.id,
    version: entry.version,
    name: normalizeLocalizedText(entry.name, entry.id),
    description: normalizeLocalizedText(entry.description, ""),
    minAppVersion: typeof entry.minAppVersion === "string" ? entry.minAppVersion : "0.0.0",
    archive: {
      url: entry.archive.url,
      bytes: entry.archive.bytes,
      unpackedBytes: entry.archive.unpackedBytes,
      sha256: entry.archive.sha256,
    },
    preview: isPlainObject(entry.preview)
      ? {
          url: entry.preview.url,
          bytes: entry.preview.bytes,
          sha256: entry.preview.sha256,
        }
      : null,
    showcase: isPlainObject(entry.showcase)
      ? { url: entry.showcase.url }
      : null,
    license: isPlainObject(entry.license)
      ? {
          spdx: typeof entry.license.spdx === "string" ? entry.license.spdx : "",
          noticeUrl: typeof entry.license.noticeUrl === "string" ? entry.license.noticeUrl : "",
          notice: normalizeLocalizedText(entry.license.notice, ""),
        }
      : { spdx: "", noticeUrl: "", notice: "" },
  };
}

function validateCatalogDocument(doc) {
  const errors = [];
  if (!isPlainObject(doc)) return { ok: false, errors: ["catalog must be a JSON object"] };
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`catalog schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!Number.isInteger(doc.catalogVersion) || doc.catalogVersion <= 0) {
    errors.push("catalog catalogVersion must be a positive integer");
  }
  if (!Array.isArray(doc.themes)) {
    errors.push("catalog themes must be an array");
    return { ok: false, errors };
  }
  if (doc.themes.length > MAX_CATALOG_ENTRIES) {
    errors.push(`catalog has ${doc.themes.length} entries; maximum is ${MAX_CATALOG_ENTRIES}`);
  }
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < doc.themes.length; index += 1) {
    const raw = doc.themes[index];
    const entryErrors = validateCatalogEntry(raw);
    if (entryErrors.errors.length > 0) {
      errors.push(...entryErrors.errors.map((message) => `themes[${index}]: ${message}`));
      continue;
    }
    if (seen.has(raw.id)) {
      errors.push(`themes[${index}]: duplicate theme id ${raw.id}`);
      continue;
    }
    seen.add(raw.id);
    normalized.push(normalizeCatalogEntry(raw));
  }
  return { ok: errors.length === 0, errors, catalog: { catalogVersion: doc.catalogVersion, themes: normalized } };
}

// Parse a raw response body after the caller enforced the byte ceiling. Any
// JSON/shape failure is a catalog failure, never a partial catalog.
function parseCatalogText(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`catalog is not valid JSON: ${err && err.message}`] };
  }
  return validateCatalogDocument(doc);
}

// A catalog can legitimately restate the same version, but it may never move
// the last-known-good version backwards.
function catalogVersionRegression(nextVersion, lastKnownGoodVersion) {
  if (!Number.isInteger(lastKnownGoodVersion)) return false;
  return nextVersion < lastKnownGoodVersion;
}

// ── Network ──

// Small, strictly bounded catalog fetch. Redirects are rejected outright: the
// endpoint is a fixed raw.githubusercontent.com URL and a redirect could only
// move the request to an unvetted host. The response is streamed and aborted as
// soon as it exceeds MAX_CATALOG_BYTES, so a hostile/broken server cannot make
// main buffer an unbounded body.
function fetchCatalogText({
  net,
  signal,
  requestImpl,
  stallTimeoutMs = DEFAULT_CATALOG_STALL_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_CATALOG_TOTAL_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  return new Promise((resolve, reject) => {
    const request = typeof requestImpl === "function"
      ? requestImpl
      : (options) => net.request(options);
    if (typeof request !== "function") {
      reject(Object.assign(new Error("official theme catalog requires a network client"), {
        code: ERROR_CODES.CATALOG_OFFLINE,
      }));
      return;
    }
    let settled = false;
    let req = null;
    let response = null;
    let stallTimer = null;
    let totalTimer = null;
    let abortListenerAttached = false;
    const clearTimers = () => {
      if (stallTimer !== null) clearTimeoutFn(stallTimer);
      if (totalTimer !== null) clearTimeoutFn(totalTimer);
      stallTimer = null;
      totalTimer = null;
    };
    const detachSignal = () => {
      if (!signal || !abortListenerAttached) return;
      signal.removeEventListener("abort", onAbort);
      abortListenerAttached = false;
    };
    const cleanup = () => {
      clearTimers();
      detachSignal();
    };
    const finish = (fn) => (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = finish(reject);
    const succeed = finish(resolve);
    const abortNetwork = () => {
      try { if (response && typeof response.destroy === "function") response.destroy(); } catch {}
      try { if (req && typeof req.abort === "function") req.abort(); } catch {}
    };
    const failOffline = (message) => {
      fail(Object.assign(new Error(message), { code: ERROR_CODES.CATALOG_OFFLINE }));
      abortNetwork();
    };
    const armStallTimer = () => {
      if (stallTimer !== null) clearTimeoutFn(stallTimer);
      if (!(stallTimeoutMs > 0)) return;
      stallTimer = setTimeoutFn(() => {
        stallTimer = null;
        failOffline("catalog request stalled");
      }, stallTimeoutMs);
    };

    try {
      req = request({
        method: "GET",
        url: CATALOG_URL,
        redirect: "manual",
        credentials: "omit",
        useSessionCookies: false,
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
    } catch (err) {
      fail(Object.assign(new Error(`catalog request failed: ${err && err.message}`), {
        code: ERROR_CODES.CATALOG_OFFLINE,
      }));
      return;
    }
    if (!req || typeof req.on !== "function") {
      fail(Object.assign(new Error("catalog network client returned no request"), {
        code: ERROR_CODES.CATALOG_OFFLINE,
      }));
      return;
    }

    function onAbort() {
      failOffline("catalog request aborted");
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      abortListenerAttached = true;
    }

    if (totalTimeoutMs > 0) {
      totalTimer = setTimeoutFn(() => {
        totalTimer = null;
        failOffline("catalog request exceeded its total deadline");
      }, totalTimeoutMs);
    }
    armStallTimer();

    req.on("redirect", () => {
      try { if (typeof req.abort === "function") req.abort(); } catch {}
      fail(Object.assign(new Error("catalog endpoint must not redirect"), {
        code: ERROR_CODES.CATALOG_OFFLINE,
      }));
    });
    req.on("error", (err) => {
      fail(Object.assign(new Error(`catalog request error: ${err && err.message}`), {
        code: ERROR_CODES.CATALOG_OFFLINE,
      }));
    });
    req.on("response", (incomingResponse) => {
      if (settled) return;
      response = incomingResponse;
      armStallTimer();
      const statusCode = response && response.statusCode;
      if (statusCode !== 200) {
        try { if (typeof response.resume === "function") response.resume(); } catch {}
        fail(Object.assign(new Error(`catalog request returned HTTP ${statusCode}`), {
          code: ERROR_CODES.CATALOG_OFFLINE,
        }));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        if (settled) return;
        armStallTimer();
        total += chunk.length;
        if (total > MAX_CATALOG_BYTES) {
          try { if (typeof response.destroy === "function") response.destroy(); } catch {}
          fail(Object.assign(new Error(`catalog exceeds ${MAX_CATALOG_BYTES} bytes`), {
            code: ERROR_CODES.CATALOG_INVALID,
          }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (err) => fail(Object.assign(new Error(`catalog response error: ${err && err.message}`), {
        code: ERROR_CODES.CATALOG_OFFLINE,
      })));
      response.on("end", () => {
        if (settled) return;
        succeed(Buffer.concat(chunks, total).toString("utf8"));
      });
    });
    if (typeof req.end === "function") req.end();
  });
}

// ── Cache ──

const CATALOG_SNAPSHOT_FILENAME = "official-theme-catalog-snapshot.json";

function catalogCacheDir(userDataDir, pathModule = defaultPath) {
  return pathModule.join(userDataDir, "official-theme");
}

function catalogCachePath(userDataDir, pathModule = defaultPath) {
  return pathModule.join(catalogCacheDir(userDataDir, pathModule), "catalog-v1.json");
}

function readCatalogCache({ fs = defaultFs, path = defaultPath, userDataDir } = {}) {
  if (!userDataDir) return null;
  const cachePath = catalogCachePath(userDataDir, path);
  const discard = () => {
    try { fs.rmSync(cachePath, { force: true }); } catch {}
    return null;
  };
  let raw;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch {
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return discard();
  }
  if (!isPlainObject(doc) || !isPlainObject(doc.catalog)) return discard();
  const result = validateCatalogDocument({ schemaVersion: SCHEMA_VERSION, ...doc.catalog });
  if (!result.ok || doc.schemaVersion !== SCHEMA_VERSION || !Number.isInteger(doc.catalogVersion)) {
    return discard();
  }
  // Cache version must match the embedded catalog version: a tampered or torn
  // cache is discarded rather than trusted.
  if (doc.catalogVersion !== result.catalog.catalogVersion) return discard();
  return {
    catalogVersion: result.catalog.catalogVersion,
    themes: result.catalog.themes,
    cachedAt: typeof doc.cachedAt === "string" ? doc.cachedAt : null,
  };
}

function writeCatalogCache({ fs = defaultFs, path = defaultPath, userDataDir, catalog, now }) {
  if (!userDataDir) return false;
  const dir = catalogCacheDir(userDataDir, path);
  const target = catalogCachePath(userDataDir, path);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: catalog.catalogVersion,
    cachedAt: typeof now === "function" ? now() : new Date().toISOString(),
    catalog: { schemaVersion: SCHEMA_VERSION, catalogVersion: catalog.catalogVersion, themes: catalog.themes },
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}

// ── Bundled snapshot ──
//
// A byte-for-byte snapshot of the published catalog ships inside the app. It is
// a last-resort LIST source when the network fetch fails and no valid disk
// cache exists; it is never written to disk, never replaces the online
// catalog, and carries no theme assets or previews. Reading it always goes
// through the same strict parse as a network response, so a corrupt or
// hand-edited snapshot is treated as absent.

function catalogSnapshotPath(pathModule = defaultPath, dir = __dirname) {
  return pathModule.join(dir, CATALOG_SNAPSHOT_FILENAME);
}

function readCatalogSnapshot({ fs = defaultFs, path = defaultPath, snapshotPath } = {}) {
  const target = snapshotPath || catalogSnapshotPath(path);
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    return null;
  }
  const parsed = parseCatalogText(raw);
  return parsed.ok ? parsed.catalog : null;
}

// ── Installed-state decoration ──

// Decides the per-theme officialThemeState from catalog + on-disk markers +
// app version. `installed` is a list of { id, version, repairRequired } from
// the manager's marker scan. `offline` never appears here: it is a list-level
// condition the caller renders alongside these per-theme states.
function deriveOfficialThemeState({ entry, installed, appVersion }) {
  if (!entry) {
    return { state: installed ? "repair-required" : "error", reason: "not-in-catalog" };
  }
  const minOk = compareSemver(appVersion, entry.minAppVersion);
  if (minOk === null || minOk < 0) {
    return { state: "update-app", reason: "min-app-version" };
  }
  if (!installed) return { state: "available" };
  if (installed.repairRequired) return { state: "repair-required" };
  const installedCmp = compareSemver(installed.version, entry.version);
  if (installedCmp !== null && installedCmp < 0) {
    return { state: "update-available", installedVersion: installed.version };
  }
  return { state: "installed", installedVersion: installed.version };
}

module.exports = {
  CATALOG_URL,
  CATALOG_REPOSITORY,
  CATALOG_HOST,
  SCHEMA_VERSION,
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ENTRIES,
  DEFAULT_CATALOG_STALL_TIMEOUT_MS,
  DEFAULT_CATALOG_TOTAL_TIMEOUT_MS,
  PREVIEW_MAX_BYTES,
  REDIRECT_HOST_ALLOWLIST,
  LIMITS,
  ERROR_CODES,
  compareSemver,
  parseSemver,
  validateArchiveUrl,
  validateLicenseNoticeUrl,
  validatePreviewUrl,
  validateShowcaseUrl,
  validateRedirectUrl,
  validateCatalogEntry,
  validateCatalogDocument,
  parseCatalogText,
  catalogVersionRegression,
  normalizeCatalogEntry,
  normalizeLocalizedText,
  fetchCatalogText,
  catalogCacheDir,
  catalogCachePath,
  readCatalogCache,
  writeCatalogCache,
  CATALOG_SNAPSHOT_FILENAME,
  catalogSnapshotPath,
  readCatalogSnapshot,
  deriveOfficialThemeState,
  isPlainObject,
};
