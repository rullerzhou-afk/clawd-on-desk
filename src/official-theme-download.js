"use strict";

// ── Official theme archive download ──
//
// Streams a single validated GitHub Release asset to a manager-owned `.part`
// file, updating SHA-256 incrementally so a 180 MiB archive never accumulates
// in memory. Every hop is validated before it is followed; the last-known-good
// catalog already fixed the expected byte count and digest.
//
// Deliberate trade-off vs the Codex Pet path: Electron main `net.request`
// inherits the system proxy / certificate environment but cannot pin a
// pre-resolved DNS result. v1 narrows the request surface instead — exact repo
// path on the initial URL, exact CDN host allowlist per hop, HTTPS/TLS, no
// credentials, and a fixed bytes/SHA-256 — and accepts that this does not reuse
// Codex Pet DNS pinning. That difference is exercised in tests and must be
// covered by the packaged real-network smoke (see the plan's evidence matrix).

const crypto = require("node:crypto");
const defaultFs = require("node:fs");
const defaultPath = require("node:path");

const catalog = require("./official-theme-catalog");
const { ERROR_CODES, LIMITS, validateArchiveUrl, validateRedirectUrl } = catalog;

const DEFAULT_STALL_TIMEOUT_MS = 30 * 1000;
const SPACE_HEADROOM_FLOOR_BYTES = 64 * 1024 * 1024;
const SPACE_HEADROOM_RATIO = 0.1;
const NONCE_PATTERN = /^[a-f0-9]{16,64}$/;

const DOWNLOAD_ERROR_CODES = Object.freeze({
  ...ERROR_CODES,
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
  DOWNLOAD_CANCELLED: "DOWNLOAD_CANCELLED",
  DOWNLOAD_STALLED: "DOWNLOAD_STALLED",
  DOWNLOAD_INTEGRITY: "DOWNLOAD_INTEGRITY",
  DOWNLOAD_DISK_SPACE: "DOWNLOAD_DISK_SPACE",
  DOWNLOAD_DISK_FULL: "DOWNLOAD_DISK_FULL",
});

function downloadError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function officialThemeDirs(userDataDir, pathModule = defaultPath) {
  return {
    downloads: pathModule.join(userDataDir, "theme-downloads", "official"),
    staging: pathModule.join(userDataDir, "theme-staging", "official"),
    themes: pathModule.join(userDataDir, "themes"),
    themeCache: pathModule.join(userDataDir, "theme-cache"),
    soundOverrides: pathModule.join(userDataDir, "sound-overrides"),
  };
}

function isSafeNonce(value) {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

// `<id>-<version>-<nonce>.part` / staging dir `<id>-<version>-<nonce>` — the
// only shapes the manager's startup sweeper will ever consider for cleanup.
function officialArtifactName(id, version, nonce, suffix = "") {
  return `${id}-${version}-${nonce}${suffix}`;
}

function parseOfficialArtifactName(name, pathModule = defaultPath) {
  if (typeof name !== "string" || !name) return null;
  const suffix = name.endsWith(".part") ? ".part" : "";
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  const match = stem.match(/^([a-z0-9][a-z0-9-]{0,63})-(\d+\.\d+\.\d+)-([a-f0-9]{16,64})$/);
  if (!match) return null;
  return { id: match[1], version: match[2], nonce: match[3], suffix, safeName: name };
}

function createNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function requiredSpaceBytes(entry) {
  const headroom = Math.max(SPACE_HEADROOM_FLOOR_BYTES, Math.ceil(entry.archive.bytes * SPACE_HEADROOM_RATIO));
  return entry.archive.bytes + entry.archive.unpackedBytes + headroom;
}

function defaultAvailableBytes(dir) {
  try {
    const stat = defaultFs.statfsSync(dir);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

function assertEnoughSpace({ entry, dir, statfs }) {
  const required = requiredSpaceBytes(entry);
  let available;
  try {
    available = statfs(dir);
  } catch {
    available = null;
  }
  if (available === null || available === undefined) return required;
  if (available < required) {
    throw downloadError(
      DOWNLOAD_ERROR_CODES.DOWNLOAD_DISK_SPACE,
      `not enough free space: need ~${required} bytes, have ${available}`,
    );
  }
  return required;
}

// The request options are part of the security contract, so they are built by a
// named helper and asserted verbatim in tests.
function buildRequestOptions(url) {
  return {
    method: "GET",
    url,
    redirect: "manual",
    credentials: "omit",
    useSessionCookies: false,
    referrerPolicy: "no-referrer",
    cache: "no-store",
  };
}

// Resolve once the output stream is unusable. Windows refuses to unlink a file
// whose handle is still open, so the `.part` removal must wait for this.
function waitForStreamClose(stream, alreadyClosed) {
  return new Promise((resolve) => {
    if (!stream || alreadyClosed) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      stream.once("close", finish);
      stream.once("error", finish);
      if (typeof stream.destroy === "function") stream.destroy();
      else if (typeof stream.end === "function") stream.end();
      else finish();
    } catch {
      finish();
    }
  });
}

// ── Single download ──

function downloadArchive(options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const net = options.net;
  const requestImpl = options.requestImpl;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const stallTimeoutMs = Number.isFinite(options.stallTimeoutMs)
    ? options.stallTimeoutMs
    : DEFAULT_STALL_TIMEOUT_MS;
  const statfs = options.statfs || ((dir) => defaultAvailableBytes(dir));
  const { entry, nonce, signal, onProgress, userDataDir } = options;

  return new Promise((resolve, reject) => {
    if (!entry || !entry.archive || !entry.id || !entry.version) {
      reject(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED, "downloadArchive requires a catalog entry"));
      return;
    }
    if (!isSafeNonce(nonce)) {
      reject(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED, "downloadArchive requires a safe nonce"));
      return;
    }
    const initial = validateArchiveUrl(entry.archive.url, { id: entry.id, version: entry.version });
    if (!initial.ok) {
      reject(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED, `invalid archive URL: ${initial.errors.join("; ")}`));
      return;
    }

    const dirs = officialThemeDirs(userDataDir, path);
    const partPath = path.join(dirs.downloads, officialArtifactName(entry.id, entry.version, nonce, ".part"));

    let settled = false;
    let stallTimer = null;
    let req = null;
    let response = null;
    let out = null;
    let outClosed = false;
    let hash = crypto.createHash("sha256");
    let received = 0;
    let headerBytes = null;
    let redirects = 0;
    let lastEmittedProgress = -1;
    let signalHandler = null;

    const clearStall = () => {
      if (stallTimer) {
        clearTimeoutFn(stallTimer);
        stallTimer = null;
      }
    };
    const detachSignal = () => {
      if (signal && signalHandler && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", signalHandler);
      }
      signalHandler = null;
    };

    // Single teardown for every failure: stop the network, stop writing, wait
    // for the file handle to close, then unlink the `.part`. Settled is already
    // set when this runs, so late data/end/error events are inert.
    const teardownAndReject = (err) => {
      clearStall();
      detachSignal();
      const res = response;
      const request = req;
      const stream = out;
      req = null;
      response = null;
      out = null;
      try { if (res && typeof res.removeAllListeners === "function") res.removeAllListeners(); } catch {}
      try { if (res && typeof res.destroy === "function") res.destroy(); } catch {}
      try { if (request && typeof request.removeAllListeners === "function") request.removeAllListeners(); } catch {}
      try { if (request && typeof request.abort === "function") request.abort(); } catch {}
      void (async () => {
        await waitForStreamClose(stream, outClosed || !stream);
        try { fs.rmSync(partPath, { force: true }); } catch {}
        reject(err);
      })();
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      teardownAndReject(err);
    };
    const succeed = (payload) => {
      if (settled) return;
      settled = true;
      clearStall();
      detachSignal();
      resolve(payload);
    };

    const buildRequest = typeof requestImpl === "function"
      ? requestImpl
      : (requestOptions) => {
          if (!net || typeof net.request !== "function") {
            throw new Error("official theme download requires a network client");
          }
          return net.request(requestOptions);
        };

    const emitProgress = () => {
      if (typeof onProgress !== "function") return;
      if (received === lastEmittedProgress) return;
      lastEmittedProgress = received;
      onProgress({
        id: entry.id,
        version: entry.version,
        receivedBytes: received,
        totalBytes: entry.archive.bytes,
      });
    };

    // Armed before the request is sent (request-to-first-byte) and re-armed on
    // every delivered byte / drain. A server that never responds therefore
    // stalls out with a stable error instead of hanging.
    const armStallTimer = () => {
      if (stallTimer) clearTimeoutFn(stallTimer);
      if (!(stallTimeoutMs > 0)) return;
      stallTimer = setTimeoutFn(() => {
        stallTimer = null;
        fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_STALLED, "download stalled: no bytes received"));
      }, stallTimeoutMs);
    };

    const failWrite = (err) => {
      const code = err && (err.code === "ENOSPC" || err.code === "EDQUOT")
        ? DOWNLOAD_ERROR_CODES.DOWNLOAD_DISK_FULL
        : DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED;
      fail(downloadError(code, `download write failed: ${err && err.message}`));
    };

    if (signal) {
      if (signal.aborted) {
        fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_CANCELLED, "download cancelled"));
        return;
      }
      signalHandler = () => fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_CANCELLED, "download cancelled"));
      signal.addEventListener("abort", signalHandler, { once: true });
    }

    const knownCodes = new Set(Object.values(DOWNLOAD_ERROR_CODES));
    try {
      fs.mkdirSync(dirs.downloads, { recursive: true });
      assertEnoughSpace({ entry, dir: dirs.downloads, statfs });
      out = fs.createWriteStream(partPath, { flags: "wx" });
      out.on("error", failWrite);
      out.on("close", () => { outClosed = true; });
    } catch (err) {
      if (err && err.code && knownCodes.has(err.code)) {
        fail(err);
      } else if (err && (err.code === "ENOSPC" || err.code === "EDQUOT")) {
        fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_DISK_FULL, `download could not start: ${err.message}`));
      } else {
        fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED, `download could not start: ${err && err.message}`));
      }
      return;
    }

    try {
      req = buildRequest(buildRequestOptions(entry.archive.url));
    } catch (err) {
      fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED, `download request failed: ${err && err.message}`));
      return;
    }
    if (!req || typeof req.on !== "function") {
      fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED, "network client returned no request"));
      return;
    }

    req.on("redirect", (_statusCode, _method, redirectUrl) => {
      // Manual mode cancels unless followRedirect() runs synchronously here.
      if (settled) return;
      if (redirects >= LIMITS.maxRedirects) {
        fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED, `too many redirects (>${LIMITS.maxRedirects})`));
        return;
      }
      const result = validateRedirectUrl(redirectUrl);
      if (!result.ok) {
        const code = result.code || DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED;
        fail(downloadError(code, result.errors.join("; ")));
        return;
      }
      redirects += 1;
      try {
        if (typeof req.followRedirect === "function") req.followRedirect();
        else throw new Error("request cannot follow redirect");
      } catch (err) {
        fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED, `followRedirect failed: ${err && err.message}`));
      }
    });

    req.on("error", (err) => {
      const code = err && (err.code === "ENOSPC" || err.code === "EDQUOT")
        ? DOWNLOAD_ERROR_CODES.DOWNLOAD_DISK_FULL
        : DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED;
      fail(downloadError(code, `download request error: ${err && err.message}`));
    });

    req.on("response", (res) => {
      if (settled) return;
      response = res;
      const statusCode = res && res.statusCode;
      if (statusCode !== 200) {
        try { if (typeof res.resume === "function") res.resume(); } catch {}
        fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED, `download returned HTTP ${statusCode}`));
        return;
      }
      const headers = (res && res.headers) || {};
      const rawLength = Array.isArray(headers["content-length"])
        ? headers["content-length"][0]
        : headers["content-length"];
      const parsed = Number(rawLength);
      if (Number.isFinite(parsed) && parsed >= 0) headerBytes = parsed;

      res.on("error", (err) => fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED, `download response error: ${err && err.message}`)));
      res.on("aborted", () => fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_CANCELLED, "download aborted by server")));
      res.on("data", (chunk) => {
        if (settled || !out) return;
        received += chunk.length;
        if (received > entry.archive.bytes || received > LIMITS.archiveMaxBytes) {
          fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_INTEGRITY, "downloaded bytes exceed the catalog size"));
          return;
        }
        hash.update(chunk);
        armStallTimer();
        emitProgress();
        let wrote = false;
        try {
          wrote = out.write(chunk);
        } catch (err) {
          failWrite(err);
          return;
        }
        if (!wrote) {
          try { if (typeof res.pause === "function") res.pause(); } catch {}
          out.once("drain", () => {
            if (settled) return;
            armStallTimer();
            try { if (typeof res.resume === "function") res.resume(); } catch {}
          });
        }
      });
      res.on("end", () => {
        if (settled || !out) return;
        clearStall();
        const finalize = () => {
          if (settled) return;
          if (headerBytes !== null && headerBytes !== received) {
            fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_INTEGRITY, `content-length ${headerBytes} != received ${received}`));
            return;
          }
          if (received !== entry.archive.bytes) {
            fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_INTEGRITY, `received ${received} bytes, expected ${entry.archive.bytes}`));
            return;
          }
          const sha256 = hash.digest("hex");
          if (sha256 !== entry.archive.sha256) {
            fail(downloadError(DOWNLOAD_ERROR_CODES.DOWNLOAD_INTEGRITY, "SHA-256 mismatch"));
            return;
          }
          emitProgress();
          succeed({ partPath, bytes: received, sha256 });
        };
        out.end(finalize);
      });
    });

    armStallTimer();
    if (!settled && typeof req.end === "function") req.end();
  });
}

module.exports = {
  DOWNLOAD_ERROR_CODES,
  DEFAULT_STALL_TIMEOUT_MS,
  SPACE_HEADROOM_FLOOR_BYTES,
  SPACE_HEADROOM_RATIO,
  officialThemeDirs,
  officialArtifactName,
  parseOfficialArtifactName,
  isSafeNonce,
  createNonce,
  requiredSpaceBytes,
  assertEnoughSpace,
  buildRequestOptions,
  waitForStreamClose,
  downloadArchive,
};
