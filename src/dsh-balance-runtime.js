"use strict";

// ── DeepSeek Harness prepaid balance → Clawd account quota ──
//
// DSH's desktop app serves the dsh-balance-widget host route on its dynamic
// loopback GUI port:
//     GET http://127.0.0.1:<port>/api/dsh-balance/balance
// The port is ephemeral per launch and is not published on disk, so we discover
// it from the OS TCP listener table (win32: `netstat -ano -p tcp`) and probe
// candidates for that exact route. This reads the same number DSH's own balance
// widget shows — no DSH plugin change, no DSH restart, no credential access.
//
// Everything here is best-effort: a missing DSH app, a closed port, a timeout or
// any malformed payload simply leaves the last known value in place.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const BALANCE_PATH = "/api/dsh-balance/balance";
// The pet-side ring is percentage-based; DeepSeek is a prepaid balance, so the
// bucket maps the balance against a fixed reference amount. usedPercent stays
// "how much of the reference has been consumed", i.e. a full ring means the
// balance is drained. Change this constant if the user prefers another scale.
const BALANCE_BASELINE_CNY = 50;
const POLL_INTERVAL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 400;
const REQUEST_TIMEOUT_MS = 2000;
const MAX_BODY_BYTES = 64 * 1024;
const PROBE_CONCURRENCY = 12;
const CACHE_PATH = path.join(os.homedir(), ".clawd", "dsh-balance-port.json");

// netstat lines look like:
//   TCP    127.0.0.1:61247    0.0.0.0:0    LISTENING    69400
//   TCP    [::]:1053          [::]:0       LISTENING    73672
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

// Only loopback routes matter; probing every listener is cheap (a few dozen
// ports) and avoids needing the exact DSH port anywhere.
async function listListeningPorts(execFileImpl) {
  if (process.platform !== "win32") return [];
  const stdout = await new Promise((resolve) => {
    try {
      execFileImpl("netstat", ["-ano", "-p", "tcp"], { windowsHide: true, timeout: 5000 }, (error, out) => {
        resolve(error ? "" : out || "");
      });
    } catch {
      resolve("");
    }
  });
  return parseNetstatListeningPorts(stdout);
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

function isBalancePayload(payload) {
  return !!payload && typeof payload === "object"
    && payload.ok === true
    && Array.isArray(payload.balance_infos);
}

// Map the official /user/balance payload (also what the widget route returns)
// onto the shared quota bucket shape. CNY wins when both currencies report.
// `baselineCny` is the user-configurable reference balance (Settings → Sessions
// → DSH balance baseline); it is read on every poll so changes apply live.
function bucketFromPayload(payload, nowMs = Date.now(), baselineCny = BALANCE_BASELINE_CNY) {
  const baseline = Number.isFinite(Number(baselineCny)) && Number(baselineCny) > 0
    ? Number(baselineCny)
    : BALANCE_BASELINE_CNY;
  const infos = Array.isArray(payload && payload.balance_infos) ? payload.balance_infos : [];
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
    usedPercent: Math.max(
      0,
      Math.min(100, Math.round((1 - picked.amount / baseline) * 100))
    ),
    amount: Math.round(picked.amount * 100) / 100,
    currency: picked.currency,
    capturedAt: nowMs,
  };
}

function createDshBalanceRuntime(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const httpGet = typeof options.httpGet === "function" ? options.httpGet : getJson;
  const execFileImpl = typeof options.execFile === "function" ? options.execFile : execFile;
  const listPorts = typeof options.listListeningPorts === "function"
    ? options.listListeningPorts
    : () => listListeningPorts(execFileImpl);
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : () => {};
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : POLL_INTERVAL_MS;
  // null disables the on-disk port cache (tests must never read/write the real
  // user's ~/.clawd while simulating discovery).
  const cachePath = options.cachePath === undefined ? CACHE_PATH : options.cachePath;

  let timer = null;
  let port = readCachedPort(cachePath);
  let running = false;
  let consecutiveFailures = 0;
  let lastBucket = null;
  let lastError = null;

  async function probePort(candidatePort) {
    const response = await httpGet(candidatePort, BALANCE_PATH, PROBE_TIMEOUT_MS);
    if (!response || response.status !== 200 || !isBalancePayload(response.json)) return null;
    return response.json;
  }

  async function discover() {
    const cached = port || readCachedPort(cachePath);
    let discovered = [];
    try {
      discovered = await listPorts();
    } catch {
      discovered = [];
    }
    const queue = [];
    const seen = new Set();
    const enqueue = (value) => {
      const candidate = Number(value);
      if (!Number.isInteger(candidate) || candidate <= 0 || candidate >= 65536) return;
      if (seen.has(candidate)) return;
      seen.add(candidate);
      queue.push(candidate);
    };
    // Prefer the cached/last-known port, then ephemeral-range ports (where the
    // DSH desktop GUI server lands), then everything else.
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

  async function pollOnce() {
    let enabled = true;
    try {
      enabled = typeof options.getEnabled === "function" ? options.getEnabled() !== false : true;
    } catch {
      enabled = true;
    }
    if (!enabled) return { status: "disabled" };

    let payload = null;
    if (port) {
      const response = await httpGet(port, BALANCE_PATH, REQUEST_TIMEOUT_MS);
      if (response && response.status === 200 && isBalancePayload(response.json)) payload = response.json;
    }
    if (!payload) {
      consecutiveFailures += 1;
      // First failure: the DSH app may have just launched on a new ephemeral
      // port, so rediscover immediately. While it stays closed, repeat the whole
      // listener scan only every fifth poll instead of every minute.
      const shouldDiscover = consecutiveFailures === 1 || consecutiveFailures % 5 === 0;
      if (shouldDiscover) {
        const discovered = await discover();
        if (discovered) {
          port = discovered.port;
          payload = discovered.payload;
          writeCachedPort(port, cachePath);
          consecutiveFailures = 0;
        }
      }
    }
    if (!payload) {
      lastError = "balance endpoint not reachable";
      if (consecutiveFailures === 1) logWarn("balance endpoint not reachable (DSH not running?)");
      return { status: "unreachable", failures: consecutiveFailures };
    }
    consecutiveFailures = 0;
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
    if (!bucket) return { status: "empty" };
    lastBucket = bucket;
    try {
      if (typeof options.commitLocalDshQuota === "function") {
        options.commitLocalDshQuota({ deepseekBalance: bucket });
      }
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
    return { status: "ok", bucket, port };
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
      return { running, port, lastBucket, lastError };
    },
  };
}

module.exports = {
  createDshBalanceRuntime,
  bucketFromPayload,
  parseNetstatListeningPorts,
  BALANCE_BASELINE_CNY,
  CACHE_PATH,
};
