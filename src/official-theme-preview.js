"use strict";

// Small, verified thumbnails for official themes. The renderer only receives a
// local file URL after main has validated the commit-pinned URL, exact byte
// count and SHA-256 digest. Preview failure is non-fatal to theme discovery.

const crypto = require("node:crypto");
const defaultFs = require("node:fs");
const defaultPath = require("node:path");

const catalog = require("./official-theme-catalog");

const DEFAULT_PREVIEW_TIMEOUT_MS = 10 * 1000;

const PREVIEW_ERROR_CODES = Object.freeze({
  PREVIEW_FAILED: "OFFICIAL_THEME_PREVIEW_FAILED",
  PREVIEW_INTEGRITY: "OFFICIAL_THEME_PREVIEW_INTEGRITY",
  PREVIEW_STALLED: "OFFICIAL_THEME_PREVIEW_STALLED",
});

function previewError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function previewCacheDir(userDataDir, pathModule = defaultPath) {
  return pathModule.join(userDataDir, "official-theme", "previews");
}

function previewCachePath(entry, userDataDir, pathModule = defaultPath) {
  if (!entry || !entry.preview || !entry.id || !entry.version) return null;
  return pathModule.join(
    previewCacheDir(userDataDir, pathModule),
    `${entry.id}-${entry.version}-${entry.preview.sha256.slice(0, 16)}.webp`,
  );
}

function verifyPreviewBuffer(buffer, preview) {
  if (!Buffer.isBuffer(buffer) || !preview) return false;
  if (buffer.length !== preview.bytes || buffer.length > catalog.PREVIEW_MAX_BYTES) return false;
  return crypto.createHash("sha256").update(buffer).digest("hex") === preview.sha256;
}

function readVerifiedPreview({ fs = defaultFs, target, preview }) {
  try {
    const buffer = fs.readFileSync(target);
    if (verifyPreviewBuffer(buffer, preview)) return buffer;
  } catch {}
  try { fs.rmSync(target, { force: true }); } catch {}
  return null;
}

function buildPreviewRequestOptions(url) {
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

function ensurePreviewFile(options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const net = options.net;
  const requestImpl = options.requestImpl;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : DEFAULT_PREVIEW_TIMEOUT_MS;
  const { entry, userDataDir } = options;

  return new Promise((resolve, reject) => {
    if (!entry || !entry.preview || !userDataDir) {
      reject(previewError(PREVIEW_ERROR_CODES.PREVIEW_FAILED, "preview entry and userDataDir are required"));
      return;
    }
    const validated = catalog.validatePreviewUrl(entry.preview.url, { id: entry.id, version: entry.version });
    if (!validated.ok) {
      reject(previewError(PREVIEW_ERROR_CODES.PREVIEW_FAILED, validated.errors.join("; ")));
      return;
    }
    const target = previewCachePath(entry, userDataDir, path);
    if (readVerifiedPreview({ fs, target, preview: entry.preview })) {
      resolve({ path: target, cached: true });
      return;
    }

    const dir = previewCacheDir(userDataDir, path);
    const tmp = `${target}.part-${process.pid}-${Date.now()}`;
    let settled = false;
    let req = null;
    let response = null;
    let timer = null;
    let received = 0;
    let headerBytes = null;
    let redirects = 0;
    const chunks = [];

    const cleanup = () => {
      if (timer) clearTimeoutFn(timer);
      timer = null;
      try { fs.rmSync(tmp, { force: true }); } catch {}
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { if (response && typeof response.destroy === "function") response.destroy(); } catch {}
      try { if (req && typeof req.abort === "function") req.abort(); } catch {}
      reject(err);
    };
    const armTimeout = () => {
      if (timer) clearTimeoutFn(timer);
      if (!(timeoutMs > 0)) return;
      timer = setTimeoutFn(() => {
        timer = null;
        finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_STALLED, "preview download stalled"));
      }, timeoutMs);
    };
    const buildRequest = typeof requestImpl === "function"
      ? requestImpl
      : (requestOptions) => {
          if (!net || typeof net.request !== "function") throw new Error("preview download requires a network client");
          return net.request(requestOptions);
        };

    try {
      fs.mkdirSync(dir, { recursive: true });
      req = buildRequest(buildPreviewRequestOptions(entry.preview.url));
    } catch (err) {
      finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_FAILED, `preview request failed: ${err && err.message}`));
      return;
    }
    if (!req || typeof req.on !== "function") {
      finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_FAILED, "network client returned no request"));
      return;
    }

    req.on("redirect", (_statusCode, _method, redirectUrl) => {
      if (settled) return;
      if (redirects >= catalog.LIMITS.maxRedirects) {
        finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_FAILED, "too many preview redirects"));
        return;
      }
      const result = catalog.validateRedirectUrl(redirectUrl);
      if (!result.ok) {
        finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_FAILED, result.errors.join("; ")));
        return;
      }
      redirects += 1;
      try {
        if (typeof req.followRedirect === "function") req.followRedirect();
        else throw new Error("request cannot follow redirect");
      } catch (err) {
        finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_FAILED, `preview redirect failed: ${err && err.message}`));
      }
    });
    req.on("error", (err) => {
      finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_FAILED, `preview request error: ${err && err.message}`));
    });
    req.on("response", (res) => {
      if (settled) return;
      response = res;
      if (!res || res.statusCode !== 200) {
        finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_FAILED, `preview returned HTTP ${res && res.statusCode}`));
        return;
      }
      const rawLength = Array.isArray(res.headers && res.headers["content-length"])
        ? res.headers["content-length"][0]
        : res.headers && res.headers["content-length"];
      const parsedLength = Number(rawLength);
      if (Number.isFinite(parsedLength) && parsedLength >= 0) headerBytes = parsedLength;
      res.on("error", (err) => finishReject(previewError(
        PREVIEW_ERROR_CODES.PREVIEW_FAILED,
        `preview response error: ${err && err.message}`,
      )));
      res.on("aborted", () => finishReject(previewError(
        PREVIEW_ERROR_CODES.PREVIEW_FAILED,
        "preview response aborted",
      )));
      res.on("data", (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > entry.preview.bytes || received > catalog.PREVIEW_MAX_BYTES) {
          finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_INTEGRITY, "preview exceeds declared size"));
          return;
        }
        chunks.push(buffer);
        armTimeout();
      });
      res.on("end", () => {
        if (settled) return;
        if (headerBytes !== null && headerBytes !== received) {
          finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_INTEGRITY, "preview content-length mismatch"));
          return;
        }
        const buffer = Buffer.concat(chunks, received);
        if (!verifyPreviewBuffer(buffer, entry.preview)) {
          finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_INTEGRITY, "preview digest or size mismatch"));
          return;
        }
        try {
          fs.writeFileSync(tmp, buffer, { flag: "wx", mode: 0o600 });
          fs.renameSync(tmp, target);
        } catch (err) {
          cleanup();
          if (!readVerifiedPreview({ fs, target, preview: entry.preview })) {
            finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_FAILED, `preview cache write failed: ${err && err.message}`));
            return;
          }
        }
        settled = true;
        cleanup();
        resolve({ path: target, cached: false });
      });
    });

    armTimeout();
    try {
      if (typeof req.end === "function") req.end();
      else throw new Error("request cannot start");
    } catch (err) {
      finishReject(previewError(PREVIEW_ERROR_CODES.PREVIEW_FAILED, `preview request failed: ${err && err.message}`));
    }
  });
}

module.exports = {
  DEFAULT_PREVIEW_TIMEOUT_MS,
  PREVIEW_ERROR_CODES,
  previewCacheDir,
  previewCachePath,
  verifyPreviewBuffer,
  readVerifiedPreview,
  buildPreviewRequestOptions,
  ensurePreviewFile,
};
