"use strict";

// 鈹€鈹€ Third-party quota bundle: DeepSeek prepaid balance 鈫?Clawd account quota 鈹€鈹€
//
// Replaces the original local-only DSH balance runtime. Two data sources, in order:
//
//   1. DSH desktop loopback route (zero egress, needs DSH running):
//        GET http://127.0.0.1:<port>/api/dsh-balance/balance
//      Port is ephemeral; discovered from the OS listener table
//      (win32 netstat / darwin lsof / linux ss|lsof|netstat) and cached.
//
//   2. Official DeepSeek endpoint (no DSH, no plugin required):
//        GET https://api.deepseek.com/user/balance      Authorization: Bearer <key>
//      Key resolved from: explicit option 鈫?DEEPSEEK_API_KEY env 鈫?//      $DSH_HOME/.credentials.yaml (default ~/.dsh) refs entry 鈫?none.
//      The credentials file is only ever read; the key never leaves memory.
//
// Both payload shapes are accepted: `{ ok: true, balance_infos: [...] }` (DSH
// route wrapper) and `{ is_available, balance_infos: [...] }` (official API).
// Everything is best-effort: any failure keeps the last known value in place.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const BALANCE_PATH = "/api/dsh-balance/balance";
const OFFICIAL_BALANCE_URL = "https://api.deepseek.com/user/balance";
const BALANCE_BASELINE_CNY = 50;
const POLL_INTERVAL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 400;
const REQUEST_TIMEOUT_MS = 4000;
const MAX_BODY_BYTES = 64 * 1024;
const PROBE_CONCURRENCY = 12;
const CACHE_PATH = path.join(os.homedir(), ".clawd", "dsh-balance-port.json");
const STATUS_PATH = path.join(os.homedir(), ".clawd", "deepseek-quota-status.json");
// Debug/verification hook: when this marker file exists the runtime skips the
// DSH loopback route and uses the official API first (falling back to the route
// only if the API is unreachable). Lets the plugin-free path be tested while
// DSH is still running.
const FORCE_API_MARKER = path.join(os.homedir(), ".clawd", "deepseek-quota-force-api");
const API_KEY_ENV = "DEEPSEEK_API_KEY";
const API_KEY_MAX_LENGTH = 512;

function parseNetstatListeningPorts(text) {
  const ports = new Set();
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/LISTENING/i.test(line)) continue;
    const match = line.match(/(?:^|\s)(?:\[[^\]]+\]|[0-9.]+):(\d{1,5})\s/);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
  }
  return [...ports];
}

// macOS `lsof -nP -iTCP -sTCP:LISTEN`:
//   node  1234 user   23u  IPv4 0x... 0t0 TCP 127.0.0.1:61247 (LISTEN)
// Linux `ss -ltn`:
//   LISTEN 0 128 127.0.0.1:61247 0.0.0.0:*
// macOS netstat:
//   tcp4 0 0 127.0.0.1.61247 *.* LISTEN
const LOOPBACK_HOSTS = /^(?:127\.0\.0\.1|localhost|\[?::1\]?)$/;

function parseListeningPorts(text, platform = process.platform) {
  const ports = new Set();
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let host = "";
    let port = null;
    if (platform === "win32") {
      if (!/LISTENING/i.test(line)) continue;
      const m = line.match(/(?:^|\s)(?:\[[^\]]+\]|[0-9.]+):(\d{1,5})\s/);
      if (!m) continue;
      port = Number(m[1]);
    } else if (platform === "darwin" && /\(LISTEN\)/.test(line)) {
      const m = line.match(/(?:TCP|UDP)\s+(\[[^\]]+\]|[0-9.]+|localhost):(\d{1,5})\s+\(LISTEN\)/);
      if (!m) continue;
      host = m[1];
      port = Number(m[2]);
    } else if (platform === "linux" && /^LISTEN\b/.test(line)) {
      const m = line.match(/^(?:LISTEN)\s+\d+\s+\d+\s+(\[[^\]]+\]|[0-9.]+):(\d{1,5})/);
      if (!m) continue;
      host = m[1];
      port = Number(m[2]);
    } else if (platform === "darwin" && /\bLISTEN\b/.test(line)) {
      // netstat fallback: 127.0.0.1.61247
      const m = line.match(/(?:^|\s)([0-9.]+)\.(\d{1,5})\s+\S+\s+LISTEN/);
      if (!m) continue;
      host = m[1];
      port = Number(m[2]);
    }
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    if (host && !LOOPBACK_HOSTS.test(host.replace(/^\[|\]$/g, ""))) continue;
    ports.add(port);
  }
  return [...ports];
}

function listListeningPorts(execFileImpl, platform = process.platform) {
  const command = platform === "win32"
    ? { bin: "netstat", args: ["-ano", "-p", "tcp"] }
    : platform === "darwin"
      ? { bin: "lsof", args: ["-nP", "-iTCP", "-sTCP:LISTEN"] }
      : { bin: "ss", args: ["-ltn"] };
  return new Promise((resolve) => {
    try {
      execFileImpl(command.bin, command.args, { windowsHide: true, timeout: 5000 }, (error, out) => {
        if (error || !out) return resolve([]);
        const ports = parseListeningPorts(out, platform);
        if (ports.length || platform === "win32") return resolve(ports);
        // Linux/macOS fallback when ss/lsof is unavailable.
        const fallback = platform === "linux"
          ? { bin: "lsof", args: ["-nP", "-iTCP", "-sTCP:LISTEN"] }
          : { bin: "netstat", args: ["-an", "-p", "tcp"] };
        execFileImpl(fallback.bin, fallback.args, { windowsHide: true, timeout: 5000 }, (err2, out2) => {
          resolve(err2 || !out2 ? [] : parseListeningPorts(out2, platform));
        });
      });
    } catch {
      resolve([]);
    }
  });
}

function getJson(port, requestPath, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = http.get({ host: "127.0.0.1", port, path: requestPath, timeout: timeoutMs }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > MAX_BODY_BYTES) {
            try { req.destroy(); } catch {}
            finish(null);
          }
        });
        res.on("end", () => {
          let json;
          try { json = JSON.parse(body); } catch { finish(null); return; }
          finish({ status: res.statusCode, json });
        });
        res.on("error", () => finish(null));
      });
    } catch {
      finish(null);
      return;
    }
    req.on("error", () => finish(null));
    req.on("timeout", () => {
      try { req.destroy(); } catch {}
      finish(null);
    });
  });
}

function readCachedPort(cachePath = CACHE_PATH) {
  if (!cachePath) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const port = Number(raw && raw.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function writeCachedPort(port, cachePath = CACHE_PATH) {
  if (!cachePath) return;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ port, updatedAt: Date.now() }), "utf8");
  } catch {
    // Cache is an optimization only.
  }
}

// Accept both the DSH route wrapper ({ok:true,...}) and the official API body
// ({is_available, balance_infos}). Returns a normalized object or null.
function normalizeBalancePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const ok = payload.ok === true || payload.ok === undefined;
  if (!ok) return null;
  if (!Array.isArray(payload.balance_infos)) return null;
  return payload;
}

function isBalancePayload(payload) {
  return normalizeBalancePayload(payload) !== null;
}

function bucketFromPayload(payload, nowMs = Date.now(), baselineCny = BALANCE_BASELINE_CNY) {
  const normalized = normalizeBalancePayload(payload);
  if (!normalized) return null;
  const baseline = Number.isFinite(Number(baselineCny)) && Number(baselineCny) > 0
    ? Number(baselineCny)
    : BALANCE_BASELINE_CNY;
  const infos = normalized.balance_infos;
  let picked = null;
  for (const info of infos) {
    if (!info || typeof info !== "object") continue;
    const currency = typeof info.currency === "string" && /^[A-Z]{2,4}$/.test(info.currency)
      ? info.currency
      : "CNY";
    const amount = Number(info.total_balance);
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (!picked || currency === "CNY") picked = { currency, amount };
    if (currency === "CNY") break;
  }
  if (!picked) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round((1 - picked.amount / baseline) * 100))),
    amount: Math.round(picked.amount * 100) / 100,
    currency: picked.currency,
    capturedAt: nowMs,
  };
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// Minimal reader for the DSH credentials file. Only the `refs:` block matters;
// values there can be a plain secret ("sk-...") or an opaque ref, which we skip.
// Nothing is written back and the value never leaves this function's caller.
function resolveDeepSeekApiKey(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const readFile = typeof options.readFile === "function" ? options.readFile : readTextFile;
  const fromEnv = env && typeof env[API_KEY_ENV] === "string" ? env[API_KEY_ENV].trim() : "";
  if (isPlausibleApiKey(fromEnv)) return { key: fromEnv, source: "env" };

  const dshHome = (env && typeof env.DSH_HOME === "string" && env.DSH_HOME.trim())
    ? env.DSH_HOME.trim()
    : path.join(homeDir, ".dsh");
  const credentialsPath = path.join(dshHome, ".credentials.yaml");
  const text = readFile(credentialsPath);
  if (!text) return { key: null, source: null, credentialsPath };

  const lines = String(text).split(/\r?\n/);
  let inRefs = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) {
      inRefs = /^refs\s*:/.test(line);
      continue;
    }
    if (!inRefs) continue;
    const match = line.match(/^\s{2,}([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    if (match[1] !== API_KEY_ENV) continue;
    const value = stripYamlScalar(match[2]);
    if (isPlausibleApiKey(value)) return { key: value, source: "dsh-credentials", credentialsPath };
    // Non-secret reference (env:, keychain:, vault:) 鈥?do not use it here.
    return { key: null, source: "dsh-credentials-ref", refKind: value.split(":")[0] || "unknown", credentialsPath };
  }
  return { key: null, source: null, credentialsPath };
}

function stripYamlScalar(value) {
  let text = String(value == null ? "" : value).trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  const hashIndex = text.indexOf(" #");
  if (hashIndex >= 0) text = text.slice(0, hashIndex).trim();
  return text;
}

function isPlausibleApiKey(value) {
  return typeof value === "string"
    && value.length >= 20
    && value.length <= API_KEY_MAX_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value)
    && value.startsWith("sk-");
}

// Default JSON fetch for the official endpoint. Electron main prefers
// `net.fetch` so the system proxy is honored; Node tests fall back to fetch.
function defaultFetchJson(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  const headers = options.headers || {};
  const tryFetch = (impl) => impl(url, { method: "GET", headers, signal: options.signal });
  let implPromise;
  try {
    const electron = require("electron");
    if (electron && electron.net && typeof electron.net.fetch === "function") {
      implPromise = tryFetch(electron.net.fetch);
    }
  } catch {
    // Not running inside Electron (tests / plain Node).
  }
  if (!implPromise) {
    if (typeof fetch !== "function") return Promise.resolve(null);
    implPromise = tryFetch(fetch);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return implPromise
    .then(async (res) => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json };
    })
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

function createDshBalanceRuntime(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const httpGet = typeof options.httpGet === "function" ? options.httpGet : getJson;
  const execFileImpl = typeof options.execFile === "function" ? options.execFile : execFile;
  const fetchJson = typeof options.fetchJson === "function" ? options.fetchJson : defaultFetchJson;
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : () => {};
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : POLL_INTERVAL_MS;
  const platform = options.platform || process.platform;
  const cachePath = options.cachePath === undefined ? CACHE_PATH : options.cachePath;
  // Official API fallback is opt-in so library consumers (and the test suite)
  // never touch the network or the local credential store unless the app wires
  // it explicitly.
  const allowOfficialApi = options.enableOfficialApi === true;
  const listPorts = typeof options.listListeningPorts === "function"
    ? options.listListeningPorts
    : () => listListeningPorts(execFileImpl, platform);

  let timer = null;
  let port = readCachedPort(cachePath);
  let running = false;
  let consecutiveFailures = 0;
  let lastBucket = null;
  let lastError = null;
  let lastSource = null;

  function getApiKey() {
    try {
      if (typeof options.getApiKey === "function") {
        const value = options.getApiKey();
        if (isPlausibleApiKey(value)) return value;
      }
    } catch {
      // fall through to resolver
    }
    try {
      if (options.resolveApiKey === false) return null;
      const resolved = resolveDeepSeekApiKey({ env: options.env, homeDir: options.homeDir });
      return resolved && resolved.key ? resolved.key : null;
    } catch {
      return null;
    }
  }

  async function probePort(candidatePort) {
    const response = await httpGet(candidatePort, BALANCE_PATH, PROBE_TIMEOUT_MS);
    if (!response || response.status !== 200 || !isBalancePayload(response.json)) return null;
    return response.json;
  }

  async function discover() {
    const cached = port || readCachedPort(cachePath);
    const discovered = await listPorts();
    const queue = [];
    const seen = new Set();
    const enqueue = (value) => {
      const candidate = Number(value);
      if (!Number.isInteger(candidate) || candidate <= 0 || candidate >= 65536) return;
      if (seen.has(candidate)) return;
      seen.add(candidate);
      queue.push(candidate);
    };
    enqueue(cached);
    const rest = discovered.filter((candidate) => candidate !== cached);
    for (const candidate of rest) if (candidate >= 49152) enqueue(candidate);
    for (const candidate of rest) if (candidate < 49152 && candidate >= 1024) enqueue(candidate);
    for (const candidate of rest) if (candidate < 1024) enqueue(candidate);

    let found = null;
    const worker = async () => {
      while (!found && queue.length) {
        const candidate = queue.shift();
        const payload = await probePort(candidate);
        if (payload && !found) found = { port: candidate, payload };
      }
    };
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
    return found;
  }

  async function fetchOfficial() {
    if (!allowOfficialApi) return null;
    const apiKey = getApiKey();
    if (!apiKey) return null;
    const response = await fetchJson(OFFICIAL_BALANCE_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response || response.status !== 200 || !isBalancePayload(response.json)) return null;
    return response.json;
  }

  function forceApiEnabled() {
    if (options.forceApi === true) return true;
    if (options.forceApi === false) return false;
    try {
      return fs.existsSync(FORCE_API_MARKER);
    } catch {
      return false;
    }
  }

  function writeStatus(payload) {
    const statusPath = options.statusPath === undefined ? STATUS_PATH : options.statusPath;
    if (!statusPath) return;
    try {
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      fs.writeFileSync(statusPath, JSON.stringify(payload, null, 2), "utf8");
    } catch {
      // Diagnostics must never affect quota collection.
    }
  }

  async function pollOnce() {
    let enabled = true;
    try {
      enabled = typeof options.getEnabled === "function" ? options.getEnabled() !== false : true;
    } catch {
      enabled = true;
    }
    if (!enabled) {
      writeStatus({ at: now(), status: "disabled", source: lastSource, error: lastError });
      return { status: "disabled" };
    }

    const forceApi = forceApiEnabled();
    let payload = null;
    let source = null;
    let usedPort = null;
    let apiAttempted = false;
    let apiOk = false;
    let routeAttempted = false;
    let routeOk = false;

    const tryRoute = async () => {
      routeAttempted = true;
      if (port) {
        const response = await httpGet(port, BALANCE_PATH, REQUEST_TIMEOUT_MS);
        if (response && response.status === 200 && isBalancePayload(response.json)) {
          payload = response.json;
          source = "local-route";
          usedPort = port;
          routeOk = true;
          return;
        }
      }
      consecutiveFailures += 1;
      const shouldDiscover = consecutiveFailures === 1 || consecutiveFailures % 5 === 0;
      if (shouldDiscover) {
        const discovered = await discover();
        if (discovered) {
          port = discovered.port;
          payload = discovered.payload;
          source = "local-route";
          usedPort = port;
          writeCachedPort(port, cachePath);
          consecutiveFailures = 0;
          routeOk = true;
        }
      }
    };

    // Normal order: DSH loopback route first (zero egress). When the
    // verification marker is present the official API is attempted first so the
    // plugin-free path can be exercised while DSH is still running.
    if (!forceApi) await tryRoute();
    if (!payload) {
      apiAttempted = true;
      payload = await fetchOfficial();
      if (payload) {
        source = "official-api";
        apiOk = true;
        consecutiveFailures = 0;
      }
    }
    if (!payload && forceApi) await tryRoute();

    if (!payload) {
      lastError = "balance endpoint not reachable";
      if (consecutiveFailures === 1) logWarn(lastError);
      writeStatus({
        at: now(), status: "unreachable", source: null, error: lastError,
        apiAttempted, apiOk, routeAttempted, routeOk, forceApi,
      });
      return { status: "unreachable", failures: consecutiveFailures };
    }
    lastError = null;
    let baseline = BALANCE_BASELINE_CNY;
    try {
      if (typeof options.getBaseline === "function") {
        const configured = Number(options.getBaseline());
        if (Number.isFinite(configured) && configured > 0) baseline = configured;
      }
    } catch {
      baseline = BALANCE_BASELINE_CNY;
    }
    const bucket = bucketFromPayload(payload, now(), baseline);
    if (!bucket) {
      writeStatus({ at: now(), status: "empty", source, apiAttempted, apiOk, routeAttempted, routeOk, forceApi });
      return { status: "empty", source };
    }
    lastBucket = bucket;
    lastSource = source;
    try {
      if (typeof options.commitLocalDshQuota === "function") {
        options.commitLocalDshQuota({ deepseekBalance: bucket });
      }
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
    writeStatus({
      at: now(), status: "ok", source, error: lastError,
      amount: bucket.amount, currency: bucket.currency, usedPercent: bucket.usedPercent,
      apiAttempted, apiOk, routeAttempted, routeOk, forceApi, port: usedPort,
    });
    return { status: "ok", bucket, port: usedPort, source };
  }

  return {
    start() {
      if (running) return;
      running = true;
      void pollOnce();
      timer = setInterval(() => { void pollOnce(); }, intervalMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    },
    stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
    refresh: pollOnce,
    getStatus() {
      return { running, port, lastBucket, lastError, source: lastSource };
    },
  };
}

module.exports = {
  createDshBalanceRuntime,
  bucketFromPayload,
  normalizeBalancePayload,
  parseNetstatListeningPorts,
  parseListeningPorts,
  listListeningPorts,
  resolveDeepSeekApiKey,
  isPlausibleApiKey,
  BALANCE_BASELINE_CNY,
  CACHE_PATH,
  STATUS_PATH,
  FORCE_API_MARKER,
  OFFICIAL_BALANCE_URL,
  API_KEY_ENV,
};


