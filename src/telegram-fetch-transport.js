"use strict";

// Fetch transport for the native Telegram client (issue #359).
//
// Why this exists: in the Electron MAIN process, the global `fetch` is Node's
// (undici) fetch, which ignores the OS system-proxy settings and (by default)
// the HTTP(S)_PROXY env vars. That breaks Telegram remote approval whenever the
// user runs in "system proxy" mode (ClashX / Surge / Clash) instead of TUN mode:
// the bot's direct requests never traverse the proxy. TUN mode works only because
// it captures traffic at the routing layer.
//
// Fix: route the bot's HTTP through Electron's Chromium network stack via a
// dedicated in-memory `session.fetch`, with `setProxy({ mode: "system" })` so it
// follows the OS proxy (and PAC / SOCKS). The session is injected as a
// `sessionFactory` so this module stays unit-testable without a live Electron app;
// when no factory is supplied (tests / non-Electron) it falls back to plain fetch.
//
// Phase 1 scope (this file): system proxy + a CLAWD_TG_PROXY escape hatch
// (direct | system | <url>). Environment-variable proxy parsing (ALL_PROXY /
// HTTPS_PROXY) and NO_PROXY translation are Phase 2 and intentionally NOT here.

const TELEGRAM_API_BASE = "https://api.telegram.org";
// Probe URL for resolveProxy diagnostics — deliberately tokenless.
const PROXY_PROBE_URL = "https://api.telegram.org/";
const DEFAULT_RESOLVE_TIMEOUT_MS = 2000;

// Phase 1 proxy selection: CLAWD_TG_PROXY escape hatch, else follow the OS
// system proxy. Phase 2 will extend this with ALL_PROXY / HTTPS_PROXY +
// NO_PROXY → proxyBypassRules translation.
function resolveProxyConfig(env = {}) {
  const override = String((env && env.CLAWD_TG_PROXY) || "").trim();
  if (override === "direct") return { mode: "direct" };
  if (override === "system") return { mode: "system" };
  // Escape hatch: a raw proxy URL the user is responsible for formatting in
  // Chromium's proxyRules syntax (e.g. "socks5://127.0.0.1:7890").
  if (override) return { mode: "fixed_servers", proxyRules: override };
  return { mode: "system" };
}

// Log only the proxy TYPE tokens (PROXY / SOCKS5 / DIRECT), never host:port.
// resolveProxy() returns strings like "PROXY 127.0.0.1:7890; DIRECT".
function sanitizeProxy(resolved) {
  if (typeof resolved !== "string" || !resolved.trim()) return "unknown";
  const types = [];
  for (const part of resolved.split(/[;,]/)) {
    const token = part.trim().split(/\s+/)[0];
    if (token) types.push(token.toUpperCase());
  }
  return types.length ? Array.from(new Set(types)).join("+") : "unknown";
}

// resolveProxy has no AbortSignal; race a timeout so a hung lookup can't park the
// apply-chain (Codex review D). Returns the sanitized type string, or null.
function probeProxyType(ses, resolveTimeoutMs) {
  const probe = Promise.resolve()
    .then(() => ses.resolveProxy(PROXY_PROBE_URL))
    .then((resolved) => sanitizeProxy(resolved))
    .catch(() => null);
  const timeout = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), Math.max(1, resolveTimeoutMs));
    if (t && typeof t.unref === "function") t.unref();
  });
  return Promise.race([probe, timeout]);
}

// Returns a transport `async ({ method, payload, signal }) => response` matching
// the shape TelegramNativeClient expects.
function createTelegramFetchTransport({
  tokenStore,
  sessionFactory = null,
  env = process.env,
  fetchImpl = null,
  log = () => {},
  resolveTimeoutMs = DEFAULT_RESOLVE_TIMEOUT_MS,
} = {}) {
  if (!tokenStore || typeof tokenStore.getToken !== "function") {
    throw new TypeError("createTelegramFetchTransport: tokenStore.getToken is required");
  }

  // Per-transport state (NOT module-level — module singletons would leak across
  // transports and tests). Codex review [P1].
  let session = null;
  let appliedKey = "";
  let applyChain = null;

  // Lazily create the proxied session and apply the proxy config. Serialized via
  // an apply-promise chain so concurrent callers (long-poll, fire-and-forget
  // notifications, test card, approval cards) don't double-init or interleave
  // setProxy. The chain's .catch keeps it alive so one failed apply doesn't
  // permanently wedge later calls.
  function ensureSession() {
    const run = (applyChain || Promise.resolve()).catch(() => {}).then(async () => {
      const ses = session || (session = sessionFactory());
      const cfg = resolveProxyConfig(env);
      const key = JSON.stringify(cfg);
      if (key !== appliedKey) {
        await ses.setProxy(cfg);                          // 1) apply NEW proxy first
        if (appliedKey && typeof ses.closeAllConnections === "function") {
          // 2) only after setProxy succeeds, drop sockets pooled on the old proxy
          try { await ses.closeAllConnections(); } catch {}
        }
        appliedKey = key;                                 // 3) commit key last
        if (typeof ses.resolveProxy === "function") {
          const type = await probeProxyType(ses, resolveTimeoutMs);
          // The injected logger ultimately does a synchronous file write
          // (telegramApprovalLog → permLog → rotatedAppend) that can throw on a
          // bad path / EACCES. A best-effort diagnostic must never fail a request
          // whose proxy is already applied (Codex review [P2]; same rationale as
          // telegram-native-runner's safeLog).
          if (type) {
            try { log("debug", "telegram proxy resolved", { mode: cfg.mode, proxy: type }); } catch {}
          }
        }
      }
      return ses;
    });
    applyChain = run.catch(() => {});                     // stored chain swallows errors…
    return run;                                           // …but caller still sees the real error
  }

  return async ({ method, payload, signal }) => {
    const token = await tokenStore.getToken();
    if (!token) {
      return { ok: false, status: null, error_code: "TOKEN_MISSING", description: "no token" };
    }
    const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
    let res;
    try {
      // ensureSession() (proxy resolve + setProxy + closeAllConnections) lives
      // INSIDE this try so a setProxy/close failure flows through the same error
      // normalization as fetch, instead of escaping as a raw error.
      let doFetch;
      if (sessionFactory) {
        const ses = await ensureSession();
        doFetch = (u, init) => ses.fetch(u, init);        // do not destructure (needs `this`)
      } else {
        doFetch = fetchImpl || globalThis.fetch;          // non-Electron / test fallback
      }
      res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
        signal,
      });
    } catch (err) {
      // Genuine abort: the signal fired, or the impl threw an AbortError.
      // Don't only trust err.name — Chromium abort can surface as net::ERR_ABORTED
      // with the signal already aborted. Normalize to name="AbortError" so
      // classifyError → TIMEOUT and the poll loop exits cleanly.
      if ((signal && signal.aborted) || (err && err.name === "AbortError")) {
        if (err && err.name === "AbortError") throw err;
        const aborted = new Error("aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      throw Object.assign(new Error(err && err.message ? err.message : String(err)), {
        code: (err && (err.code || (err.cause && err.cause.code))) || undefined,
        causeCode: err && err.cause && err.cause.code,
      });
    }
    const status = res.status;
    let body;
    try { body = await res.json(); } catch { body = null; }
    if (!body) return { ok: false, status, error_code: status, description: res.statusText || "" };
    if (body.ok) return { ok: true, result: body.result };
    return {
      ok: false,
      status,
      error_code: body.error_code || status,
      description: body.description || "",
      parameters: body.parameters || {},
    };
  };
}

module.exports = {
  createTelegramFetchTransport,
  resolveProxyConfig,
  sanitizeProxy,
};
