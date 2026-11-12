"use strict";

// ── Third-party quota bundle: Cursor plan usage + Grok Bot weekly quota ──
//
// Data path (read-only, no token refresh):
//   Cursor desktop state DB  →  ItemTable[cursorAuth/accessToken]  (plain JWT,
//   or `cursor-safe-storage:v1:` envelope decrypted via macOS Keychain)
//        → JWT payload { sub, exp } → userID
//        → Cookie: WorkosCursorSessionToken=<userID>::<token>
//        → cursor.com web APIs:
//             GET  /api/usage-summary                          (plan usage)
//             POST /api/dashboard/get-sand-usage-status        (Grok Bot weekly)
//             GET  /api/usage?user=<userID>                    (legacy fallback)
//
// Nothing is written: the DB is opened read-only, the token stays in memory and
// is never logged. A missing token, an expired JWT or any HTTP failure leaves
// the last known quota value in place (Clawd's store semantics).
//
// Endpoint field names are parsed tolerantly because these are non-public
// endpoints (see THIRD-PARTY-QUOTA-BUNDLE-PLAN.md): several plausible field
// spellings are accepted and non-matching payloads are ignored, never guessed.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const CURSOR_USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const CURSOR_USAGE_STATUS_URL = "https://cursor.com/api/dashboard/v2/usage-status?scope=user";
const CURSOR_LEGACY_USAGE_URL = "https://cursor.com/api/usage";
const CURSOR_ME_URL = "https://cursor.com/api/auth/me";
const GROK_BOT_USAGE_URL = "https://cursor.com/api/dashboard/get-sand-usage-status";
const API2_PERIOD_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const TOKEN_KEY = "cursorAuth/accessToken";
const ENCRYPTED_TOKEN_PREFIX = "cursor-safe-storage:v1:";
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_STATUS_PATH = path.join(os.homedir(), ".clawd", "third-party-quota-status.json");
// Debug dump: when this marker exists the next poll writes the raw (string-redacted
// only by omission of headers) endpoint bodies to DUMP_PATH for field mapping.
const DUMP_MARKER = path.join(os.homedir(), ".clawd", "cursor-quota-dump");
const DUMP_PATH = path.join(os.homedir(), ".clawd", "cursor-quota-dump.json");
const REQUEST_TIMEOUT_MS = 4000;
const MAX_TOKEN_LENGTH = 8192;
const BASE_HEADERS = Object.freeze({
  Accept: "application/json",
  Origin: "https://cursor.com",
  Referer: "https://cursor.com/dashboard",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0 Safari/537.36",
});
const MONTH_MINUTES = 30 * 24 * 60;
const WEEK_MINUTES = 7 * 24 * 60;

function cursorDbPath(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  if (platform === "win32") {
    const appData = (env.APPDATA || "").trim() || path.win32.join(homeDir, "AppData", "Roaming");
    return path.win32.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (platform === "darwin") {
    return path.posix.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  const xdg = (env.XDG_CONFIG_HOME || "").trim();
  const configHome = path.posix.isAbsolute(xdg) ? xdg : path.posix.join(homeDir, ".config");
  return path.posix.join(configHome, "Cursor", "User", "globalStorage", "state.vscdb");
}

function copyDbToTemp(dbPath, fsImpl = fs, osImpl = os, pathImpl = path) {
  const dir = fsImpl.mkdtempSync(pathImpl.join(osImpl.tmpdir(), "clawd-cursor-quota-"));
  const target = pathImpl.join(dir, "state.vscdb");
  fsImpl.copyFileSync(dbPath, target);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = dbPath + suffix;
    try {
      if (fsImpl.existsSync(sidecar)) fsImpl.copyFileSync(sidecar, target + suffix);
    } catch {
      // Sidecars are a consistency nicety; without them SQLite reads the main file.
    }
  }
  return target;
}

function readDbValue(dbPath, key, options = {}) {
  const fsImpl = options.fs || fs;
  if (!dbPath || !fsImpl.existsSync(dbPath)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null; // Node without node:sqlite: quota is optional, do not crash.
  }
  const tryOpen = (target) => {
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1").get(key);
      if (!row) return null;
      const raw = row.value;
      if (typeof raw === "string") return raw;
      if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
      return raw == null ? null : String(raw);
    } finally {
      try { db.close(); } catch {}
    }
  };
  try {
    return tryOpen(dbPath);
  } catch {
    // WAL-mode DBs can refuse a plain read-only open; read a consistent copy.
    try {
      const temp = copyDbToTemp(dbPath, fsImpl);
      try {
        return tryOpen(temp);
      } finally {
        try { fsImpl.rmSync(path.dirname(temp), { recursive: true, force: true }); } catch {}
      }
    } catch {
      return null;
    }
  }
}

function readAccessToken(options = {}) {
  const dbPath = options.dbPath || cursorDbPath(options);
  return readDbValue(dbPath, TOKEN_KEY, options);
}

function decodeJwt(token) {
  if (typeof token !== "string") throw new Error("not a token");
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) throw new Error("not a JWT");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("JWT payload is not JSON");
  }
  if (!payload || typeof payload !== "object") throw new Error("JWT payload is not an object");
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const userId = sub.split("|").filter(Boolean).pop() || "";
  const exp = Number(payload.exp);
  return { payload, sub, userId, exp: Number.isFinite(exp) && exp > 0 ? exp : null };
}

function buildCookie(token, userId) {
  return "WorkosCursorSessionToken=" + encodeURIComponent(`${userId}::${token}`);
}

// Resolve the raw DB value into a usable token. Plain JWTs need no Keychain
// access; encrypted envelopes only decrypt on macOS through the injected hook.
async function resolveAccessToken(rawValue, options = {}) {
  if (typeof rawValue !== "string") return { token: null, reason: "missing" };
  const value = rawValue.trim();
  if (!value || value.length > MAX_TOKEN_LENGTH) return { token: null, reason: "malformed" };
  if (!value.startsWith(ENCRYPTED_TOKEN_PREFIX)) return { token: value, encrypted: false, via: "plain" };
  const platform = options.platform || process.platform;
  if (platform !== "darwin") return { token: null, encrypted: true, reason: `encrypted-token-on-${platform}` };
  const decryptToken = options.decryptToken;
  if (typeof decryptToken !== "function") return { token: null, encrypted: true, reason: "no-decrypt-hook" };
  try {
    const decrypted = await decryptToken(value);
    if (decrypted && typeof decrypted === "object" && decrypted.token) {
      return { token: String(decrypted.token).trim(), encrypted: true, via: `keychain:${decrypted.account || "cursor"}` };
    }
    if (typeof decrypted === "string" && decrypted.trim()) return { token: decrypted.trim(), encrypted: true, via: "keychain" };
    return { token: null, encrypted: true, reason: "keychain-denied-or-undecryptable" };
  } catch {
    return { token: null, encrypted: true, reason: "decrypt-failed" };
  }
}

// ── Response parsing (tolerant; returns bucket shapes, never invents data) ──

function num(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseTime(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return null;
    if (value > 1e15) return Math.round(value / 1000); // microseconds
    if (value > 1e12) return Math.round(value); // milliseconds
    return Math.round(value * 1000); // seconds
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (/^\d+$/.test(text)) return parseTime(Number(text));
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function firstObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return {};
}

function buildBucket(usedPercent, resetAt, windowMinutes, nowMs) {
  const pct = clampPercent(usedPercent);
  if (pct == null) return null;
  const bucket = { usedPercent: pct };
  const reset = Number.isFinite(Number(resetAt)) ? Number(resetAt) : null;
  if (reset) bucket.resetAt = reset;
  const minutes = Number(windowMinutes);
  if (Number.isFinite(minutes) && minutes > 0) bucket.windowMinutes = Math.round(minutes);
  bucket.capturedAt = Number.isFinite(nowMs) ? nowMs : Date.now();
  return bucket;
}

// `/api/usage-summary` — plan usage (percent or dollar/request amounts), the
// billing-cycle window and (for unified accounts) a weekly pool marker.
function parseUsageSummary(body, nowMs = Date.now()) {
  if (!body || typeof body !== "object") return null;
  const data = firstObject(body.data, body);
  const individual = firstObject(data.individualUsage, data.individual_usage);
  const plan = firstObject(individual.plan, data.planUsage, data.plan_usage, data.usage, data);
  const percent = num(
    plan.totalPercentUsed,
    plan.total_percent_used,
    plan.percent,
    plan.usedPercent,
    plan.used_percentage,
    plan.usagePercent,
    plan.percentage,
    data.percentUsed,
    data.planUsagePercent,
  );
  let usedPercent = percent;
  if (usedPercent == null) {
    const usedCents = num(plan.usedCents, plan.totalCents, plan.used_cents, plan.used, data.usedCents);
    const limitCents = num(plan.limitCents, plan.totalLimitCents, plan.limit_cents, plan.limit, data.limitCents);
    if (usedCents != null && limitCents != null && limitCents > 0) usedPercent = (usedCents / limitCents) * 100;
  }
  if (usedPercent == null) {
    const used = num(plan.used, plan.numRequests, data.used);
    const limit = num(plan.limit, plan.maxRequestUsage, data.limit);
    if (used != null && limit != null && limit > 0) usedPercent = (used / limit) * 100;
  }
  const resetAt = parseTime(
    data.billingCycleEnd,
    data.billing_cycle_end,
    data.billingPeriodEnd,
    data.currentPeriodEnd,
    data.periodEnd,
    data.period_end,
    data.resetsAt,
    data.resetAt,
    plan.resetAt,
  );
  const startAt = parseTime(
    data.billingCycleStart,
    data.billing_cycle_start,
    data.billingPeriodStart,
    data.currentPeriodStart,
    data.periodStart,
    data.period_start,
  );
  let windowMinutes = null;
  if (resetAt && startAt && resetAt > startAt) windowMinutes = (resetAt - startAt) / 60000;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) windowMinutes = MONTH_MINUTES;
  const isUnified = data.isUnified === true || data.unified === true || data.is_unified === true;
  const planName = typeof data.membershipType === "string" ? data.membershipType
    : (typeof data.planName === "string" ? data.planName
      : (typeof data.plan === "string" ? data.plan : (typeof data.planType === "string" ? data.planType : null)));
  const monthly = usedPercent == null ? null : buildBucket(usedPercent, resetAt, windowMinutes, nowMs);
  const weekly = isUnified
    ? buildBucket(
      num(plan.weeklyPercent, plan.weekly_percent, data.weeklyPercent, data.weekly_percent),
      parseTime(data.weeklyResetAt, data.weekly_reset_at, data.weeklyResetTimestampUtc),
      WEEK_MINUTES,
      nowMs,
    )
    : null;
  if (!monthly && !weekly) return null;
  return { monthly, weekly, planName, isUnified, windowMinutes };
}

// `POST /api/dashboard/get-sand-usage-status` — Grok Bot weekly included usage.
function parseGrokBotUsage(body, nowMs = Date.now()) {
  if (!body || typeof body !== "object") return null;
  const data = firstObject(body.data, body);
  const percent = num(
    data.usagePercent,
    data.usage_percent,
    data.percent,
    data.usedPercent,
    data.totalUsagePercent,
  );
  if (percent == null) return null;
  const resetAt = parseTime(
    data.nextResetTimestampUtc,
    data.next_reset_timestamp_utc,
    data.nextResetTimestamp,
    data.nextResetTime,
    data.resetsAt,
    data.resetAt,
  );
  const windowMinutes = num(data.windowMinutes, data.window_minutes) || WEEK_MINUTES;
  return buildBucket(percent, resetAt, windowMinutes, nowMs);
}

// `GET /api/dashboard/v2/usage-status?scope=user` — monthly spend and the
// unified weekly included-usage pool (same number the Grok Bot card shows).
function parseDashboardUsageStatus(body, nowMs = Date.now()) {
  if (!body || typeof body !== "object") return null;
  const data = firstObject(body.data, body);
  const weekly = firstObject(data.weeklyIncludedUsage, data.weekly_included_usage);
  const usedCents = num(weekly.usedCents, weekly.used_cents);
  const budgetCents = num(weekly.budgetCents, weekly.budget_cents);
  let percent = null;
  if (usedCents != null && budgetCents != null && budgetCents > 0) percent = (usedCents / budgetCents) * 100;
  if (percent == null) percent = num(weekly.usagePercent, weekly.usage_percent, weekly.percent);
  const resetAt = parseTime(
    weekly.resetsAt,
    weekly.resets_at,
    weekly.nextResetTimestampUtc,
    weekly.next_reset_timestamp_utc,
    weekly.nextResetTimestamp,
    data.nextResetTimestampUtc,
  );
  const periodStart = parseTime(weekly.periodStart, weekly.period_start);
  let windowMinutes = WEEK_MINUTES;
  if (periodStart && resetAt && resetAt > periodStart) windowMinutes = (resetAt - periodStart) / 60000;
  const weeklyBucket = percent == null ? null : buildBucket(percent, resetAt, windowMinutes, nowMs);
  const monthly = firstObject(data.monthlyUsage, data.monthly_usage);
  const monthlySpendCents = num(monthly.usedCents, monthly.used_cents);
  if (!weeklyBucket && monthlySpendCents == null) return null;
  return { weekly: weeklyBucket, monthlySpendCents };
}

// `GET /api/usage?user=<id>` — legacy request-based plan.
function parseLegacyUsage(body, nowMs = Date.now()) {
  if (!body || typeof body !== "object") return null;
  const data = firstObject(body.data, body);
  const used = num(data.numRequests, data.num_requests, data.used, data.usage);
  const limit = num(data.maxRequestUsage, data.max_request_usage, data.limit, data.maxRequests);
  const percent = used != null && limit != null && limit > 0
    ? (used / limit) * 100
    : num(data.percent, data.usedPercent);
  if (percent == null) return null;
  const resetAt = parseTime(data.billingCycleEnd, data.periodEnd, data.resetAt);
  return { bucket: buildBucket(percent, resetAt, MONTH_MINUTES, nowMs), requestCount: used, requestLimit: limit };
}

// ── HTTP ──

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultFetchJson() {
  return async (url, options = {}) => {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const impl = (() => {
      try {
        const electron = require("electron");
        if (electron && electron.net && typeof electron.net.fetch === "function") return electron.net.fetch.bind(electron.net);
      } catch {}
      return typeof fetch === "function" ? fetch : null;
    })();
    if (!impl) {
      clearTimeout(timer);
      return null;
    }
    try {
      const res = await impl(url, {
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body,
        signal: controller.signal,
        redirect: "follow",
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, text };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

function createCursorQuotaRuntime(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULT_INTERVAL_MS;
  const platform = options.platform || process.platform;
  const fetchJson = typeof options.fetchJson === "function" ? options.fetchJson : defaultFetchJson();
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : () => {};
  const commitQuota = typeof options.commitQuota === "function" ? options.commitQuota : () => {};
  const readToken = typeof options.readToken === "function"
    ? options.readToken
    : () => readAccessToken({ platform, env: options.env, homeDir: options.homeDir, dbPath: options.dbPath });
  const decryptToken = typeof options.decryptToken === "function" ? options.decryptToken : null;

  let timer = null;
  let running = false;
  let lastError = null;
  let lastStatus = "idle";
  let lastBuckets = null;
  let warnedNoToken = false;
  const statusPath = options.statusPath === undefined ? DEFAULT_STATUS_PATH : options.statusPath;
  let lastDiagnostics = [];

  // Best-effort diagnostics for the (future) Settings status row and for
  // troubleshooting: status/error/timestamps only, never the token or cookie.
  function persistStatus() {
    if (!statusPath) return;
    try {
      const payload = {
        at: now(),
        status: lastStatus,
        error: lastError,
        providers: lastBuckets ? Object.keys(lastBuckets) : [],
        diagnostics: lastDiagnostics,
        platform,
      };
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      fs.writeFileSync(statusPath, JSON.stringify(payload, null, 2), "utf8");
    } catch {
      // Diagnostics must never affect quota collection.
    }
  }

  // Response metadata only (endpoint/status/top-level keys/numbers) so a failed
  // parse can be diagnosed without persisting bodies or credentials.
  function recordDiagnostic(endpoint, response) {
    const json = response && response.json;
    const numbers = [];
    const collectNumbers = (object, prefix = "", depth = 0) => {
      if (!object || typeof object !== "object" || depth > 2) return;
      for (const [key, value] of Object.entries(object)) {
        if (numbers.length >= 20) return;
        if (typeof value === "number" && Number.isFinite(value)) numbers.push(`${prefix}${key}=${value}`);
        else if (value && typeof value === "object" && !Array.isArray(value)) collectNumbers(value, `${prefix}${key}.`, depth + 1);
      }
    };
    if (json && typeof json === "object") collectNumbers(json);
    lastDiagnostics.push({
      endpoint,
      status: response ? response.status : null,
      bytes: response && typeof response.text === "string" ? response.text.length : null,
      keys: json && typeof json === "object" ? Object.keys(json).slice(0, 24) : null,
      numbers: numbers.slice(0, 20),
    });
  }

  async function resolveToken() {
    let raw;
    try {
      raw = await readToken();
    } catch (error) {
      lastError = "cursor-db-read-failed";
      return null;
    }
    if (!raw) {
      lastStatus = "no-token";
      if (!warnedNoToken) {
        warnedNoToken = true;
        logWarn("Cursor access token not found in state.vscdb (Cursor not signed in?)");
      }
      return null;
    }
    const resolved = await resolveAccessToken(raw, { platform, decryptToken });
    if (!resolved.token) {
      lastStatus = "token-unusable";
      lastError = resolved.reason || "token-unusable";
      return null;
    }
    let jwt;
    try {
      jwt = decodeJwt(resolved.token);
    } catch {
      lastStatus = "token-unusable";
      lastError = "jwt-parse-failed";
      return null;
    }
    if (jwt.exp && jwt.exp * 1000 <= now()) {
      lastStatus = "token-expired";
      lastError = "cursor-token-expired";
      return null;
    }
    return { token: resolved.token, jwt };
  }

  function headersFor(cookie) {
    return { ...BASE_HEADERS, Cookie: cookie };
  }

  async function pollOnce() {
    try {
      return await pollOnceImpl();
    } finally {
      persistStatus();
    }
  }

  async function pollOnceImpl() {
    let enabled = true;
    try {
      enabled = typeof options.getEnabled === "function" ? options.getEnabled() !== false : true;
    } catch {
      enabled = true;
    }
    if (!enabled) return { status: "disabled" };

    const session = await resolveToken();
    if (!session) return { status: lastStatus, error: lastError };
    const { token, jwt } = session;
    const userId = jwt.userId || "";
    const cookie = buildCookie(token, userId);
    const headers = headersFor(cookie);
    const nowMs = now();
    const quotas = {};
    lastDiagnostics = [];

    // 1) Cursor plan usage: web endpoints first, then the Connect API fallback.
    const summary = await fetchJson(CURSOR_USAGE_SUMMARY_URL, { headers, timeoutMs: REQUEST_TIMEOUT_MS });
    recordDiagnostic("usage-summary", summary);
    let parsed = summary && summary.status === 200 ? parseUsageSummary(summary.json, nowMs) : null;

    // The dashboard status endpoint carries the unified weekly included pool; it
    // is fetched on every poll and doubles as the Grok Bot weekly fallback.
    const usageStatus = await fetchJson(CURSOR_USAGE_STATUS_URL, { headers, timeoutMs: REQUEST_TIMEOUT_MS });
    recordDiagnostic("dashboard-v2-usage-status", usageStatus);
    const v2 = usageStatus && usageStatus.status === 200
      ? parseDashboardUsageStatus(usageStatus.json, nowMs)
      : null;
    if (!parsed && v2 && v2.weekly) {
      parsed = { monthly: null, weekly: v2.weekly, planName: null, isUnified: true, windowMinutes: WEEK_MINUTES };
    }
    if (!parsed && userId) {
      const legacy = await fetchJson(`${CURSOR_LEGACY_USAGE_URL}?user=${encodeURIComponent(userId)}`,
        { headers, timeoutMs: REQUEST_TIMEOUT_MS });
      recordDiagnostic("legacy-usage", legacy);
      const legacyParsed = legacy && legacy.status === 200 ? parseLegacyUsage(legacy.json, nowMs) : null;
      if (legacyParsed && legacyParsed.bucket) {
        parsed = { monthly: legacyParsed.bucket, weekly: null, planName: null, isUnified: false, windowMinutes: MONTH_MINUTES };
      }
    }
    if (!parsed) {
      const connect = await fetchJson(API2_PERIOD_USAGE_URL, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: "{}",
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      recordDiagnostic("api2-get-current-period-usage", connect);
      if (connect && connect.status === 200) parsed = parseUsageSummary(connect.json, nowMs);
    }
    if (parsed && (parsed.monthly || parsed.weekly)) {
      const group = {};
      // Cursor's own page for unified accounts shows the shared weekly included
      // usage (the same 12% the Cursor/Grok Bot UI displays); the monthly plan
      // row is a legacy 0%-until-spent meter, so it is only used as a fallback.
      if (v2 && v2.weekly) group.cursorWeekly = v2.weekly;
      else if (parsed.weekly) group.cursorWeekly = parsed.weekly;
      if (parsed.monthly && (parsed.monthly.usedPercent > 0 || !group.cursorWeekly)) {
        group.cursorMonthly = parsed.monthly;
      }
      quotas.cursorQuota = group;
      lastStatus = "ok";
    } else if (lastDiagnostics.some((entry) => entry.status === 401 || entry.status === 403)) {
      lastStatus = "auth-failed";
      lastError = "cursor-auth-http";
    } else {
      lastStatus = "usage-unavailable";
      lastError = "cursor-usage-unavailable";
    }

    // 2) Grok Bot weekly quota (same Cursor account session).
    const grok = await fetchJson(GROK_BOT_USAGE_URL, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    recordDiagnostic("grok-bot-usage", grok);
    let grokBucket = grok && grok.status === 200 ? parseGrokBotUsage(grok.json, nowMs) : null;
    if (!grokBucket && v2 && v2.weekly) grokBucket = v2.weekly;
    if (grokBucket) quotas.grokBotQuota = { grokBotWeekly: grokBucket };

    if (!Object.keys(quotas).length) {
      if (lastError) logWarn(lastError);
      return { status: lastStatus, error: lastError };
    }
    lastError = null;
    lastBuckets = quotas;
    try {
      if (fs.existsSync(DUMP_MARKER)) {
        fs.writeFileSync(DUMP_PATH, JSON.stringify({
          at: nowMs,
          parsed,
          usageSummary: summary ? summary.json : null,
          usageStatus: usageStatus ? usageStatus.json : null,
          grokBot: grok ? grok.json : null,
        }, null, 2), "utf8");
      }
    } catch {
      // Debug dump is best-effort only.
    }
    try {
      await commitQuota(quotas);
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
    return { status: "ok", quotas };
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
      return { running, status: lastStatus, error: lastError, lastBuckets };
    },
  };
}

module.exports = {
  createCursorQuotaRuntime,
  cursorDbPath,
  readDbValue,
  readAccessToken,
  decodeJwt,
  buildCookie,
  resolveAccessToken,
  parseUsageSummary,
  parseDashboardUsageStatus,
  parseGrokBotUsage,
  parseLegacyUsage,
  parseTime,
  readToken: readAccessToken,
  CURSOR_USAGE_SUMMARY_URL,
  CURSOR_LEGACY_USAGE_URL,
  GROK_BOT_USAGE_URL,
  DEFAULT_INTERVAL_MS,
  ENCRYPTED_TOKEN_PREFIX,
  WEEK_MINUTES,
  MONTH_MINUTES,
};
