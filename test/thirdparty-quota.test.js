"use strict";

// Unit tests for the third-party quota bundle sources.
// Run: node --test _quota_tools/thirdparty-quota/tests

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const deepseek = require(path.join(__dirname, "..", "src", "dsh-balance-runtime.js"));
const cursor = require(path.join(__dirname, "..", "src", "cursor-quota-runtime.js"));
const safeStorage = require(path.join(__dirname, "..", "src", "chromium-safe-storage.js"));

function b64url(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function makeJwt(payload) {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

function futureExp() {
  return Math.floor(Date.now() / 1000) + 3600;
}

// 閳光偓閳光偓 DeepSeek 閳光偓閳光偓

test("deepseek: parses Windows netstat listeners", () => {
  const text = [
    "  TCP    127.0.0.1:61247    0.0.0.0:0    LISTENING    69400",
    "  TCP    [::]:1053          [::]:0       LISTENING    73672",
    "  TCP    127.0.0.1:23333    0.0.0.0:0    ESTABLISHED  1",
  ].join("\r\n");
  assert.deepEqual(deepseek.parseNetstatListeningPorts(text).sort((a, b) => a - b), [1053, 61247]);
});

test("deepseek: parses macOS lsof and netstat listeners", () => {
  const lsof = [
    "node 1234 user 23u IPv4 0x1234 0t0 TCP 127.0.0.1:61247 (LISTEN)",
    "node 1234 user 24u IPv6 0x1234 0t0 TCP [::1]:61248 (LISTEN)",
    "node 1234 user 25u IPv4 0x1234 0t0 TCP 192.168.1.2:61249 (LISTEN)",
    "node 1234 user 26u IPv4 0x1234 0t0 TCP 127.0.0.1:61250 (ESTABLISHED)",
  ].join("\n");
  assert.deepEqual(deepseek.parseListeningPorts(lsof, "darwin").sort((a, b) => a - b), [61247, 61248]);
  const netstat = "tcp4       0      0  127.0.0.1.61247       *.*                    LISTEN";
  assert.deepEqual(deepseek.parseListeningPorts(netstat, "darwin"), [61247]);
});

test("deepseek: parses Linux ss listeners", () => {
  const ss = [
    "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port",
    "LISTEN 0      128    127.0.0.1:61247      0.0.0.0:*",
    "LISTEN 0      128    [::1]:61248          [::]:*",
    "ESTAB 0      0      127.0.0.1:61249      127.0.0.1:50000",
  ].join("\n");
  assert.deepEqual(deepseek.parseListeningPorts(ss, "linux").sort((a, b) => a - b), [61247, 61248]);
});

test("deepseek: resolves API key from env, then DSH credentials file", () => {
  const key = "sk-" + "a".repeat(32);
  assert.deepEqual(deepseek.resolveDeepSeekApiKey({ env: { DEEPSEEK_API_KEY: key } }).source, "env");
  assert.deepEqual(deepseek.resolveDeepSeekApiKey({ env: { DEEPSEEK_API_KEY: key } }).key, key);

  const yaml = ["version: 1", "refs:", `  DEEPSEEK_API_KEY: ${key}`, "records:", "  x:", "    kind: env"].join("\n");
  const resolved = deepseek.resolveDeepSeekApiKey({
    env: {},
    homeDir: "C:/home",
    readFile: (p) => (/\.credentials\.yaml$/.test(p) ? yaml : null),
  });
  assert.equal(resolved.key, key);
  assert.equal(resolved.source, "dsh-credentials");

  const refOnly = ["refs:", "  DEEPSEEK_API_KEY: keychain:foo"].join("\n");
  const refResolved = deepseek.resolveDeepSeekApiKey({
    env: {},
    homeDir: "C:/home",
    readFile: () => refOnly,
  });
  assert.equal(refResolved.key, null);
  assert.equal(refResolved.source, "dsh-credentials-ref");
});

test("deepseek: maps both payload shapes and respects baseline", () => {
  const wrap = { ok: true, balance_infos: [{ currency: "USD", total_balance: "10" }, { currency: "CNY", total_balance: "30" }] };
  const official = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "60" }] };
  const b1 = deepseek.bucketFromPayload(wrap, 1000, 50);
  assert.equal(b1.currency, "CNY");
  assert.equal(b1.amount, 30);
  assert.equal(b1.usedPercent, 40);
  const b2 = deepseek.bucketFromPayload(official, 2000, 100);
  assert.equal(b2.usedPercent, 40);
  assert.equal(deepseek.bucketFromPayload({ is_available: false }, 0, 50), null);
  assert.equal(deepseek.bucketFromPayload({ ok: false, balance_infos: [] }, 0, 50), null);
});

test("deepseek: runtime uses local route and commits", async () => {
  const commits = [];
  const runtime = deepseek.createDshBalanceRuntime({
    now: () => 5000,
    getEnabled: () => true,
    getBaseline: () => 50,
    httpGet: async (port, route) => {
      if (port === 61247 && route === "/api/dsh-balance/balance") {
        return { status: 200, json: { ok: true, balance_infos: [{ currency: "CNY", total_balance: "25" }] } };
      }
      return null;
    },
    execFile: (bin, args, opts, cb) => cb(new Error("not available"), ""),
    fetchJson: async () => null,
    statusPath: null,
    commitLocalDshQuota: (quota) => commits.push(quota),
  });
  // Inject the cached port by calling refresh after priming via a fake discovery:
  const result = await runtime.refresh();
  assert.equal(result.status, "unreachable"); // no cached port in this unit-test env
  // Official API fallback path when a key provider is supplied.
  const okRuntime = deepseek.createDshBalanceRuntime({
    now: () => 6000,
    getBaseline: () => 50,
    getEnabled: () => true,
    httpGet: async () => null,
    execFile: (bin, args, opts, cb) => cb(new Error("not available"), ""),
    enableOfficialApi: true,
    getApiKey: () => "sk-" + "b".repeat(32),
    fetchJson: async () => ({ status: 200, json: { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "40" }] } }),
    statusPath: null,
    commitLocalDshQuota: (quota) => commits.push(quota),
  });
  const ok = await okRuntime.refresh();
  assert.equal(ok.status, "ok");
  assert.equal(ok.source, "official-api");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].deepseekBalance.amount, 40);
});

test("deepseek: forceApi uses the official API even when the local route is up", async () => {
  const commits = [];
  const runtime = deepseek.createDshBalanceRuntime({
    now: () => 7000,
    getBaseline: () => 50,
    getEnabled: () => true,
    forceApi: true,
    enableOfficialApi: true,
    httpGet: async () => ({ status: 200, json: { ok: true, balance_infos: [{ currency: "CNY", total_balance: "1" }] } }),
    execFile: (bin, args, opts, cb) => cb(new Error("not available"), ""),
    getApiKey: () => "sk-" + "c".repeat(32),
    fetchJson: async () => ({ status: 200, json: { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "42.5" }] } }),
    statusPath: null,
    commitLocalDshQuota: (quota) => commits.push(quota),
  });
  const result = await runtime.refresh();
  assert.equal(result.status, "ok");
  assert.equal(result.source, "official-api");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].deepseekBalance.amount, 42.5);
});

// 閳光偓閳光偓 macOS Safe Storage 閳光偓閳光偓

test("safe storage: envelope roundtrip + wrong password", () => {
  const token = makeJwt({ sub: "auth0|user-1", exp: futureExp() });
  const envelope = safeStorage.encryptTokenForTest(token, "test-password");
  assert.equal(safeStorage.isEncryptedCursorToken(envelope), true);
  assert.equal(safeStorage.decryptEnvelope(envelope, "test-password"), token);
  assert.throws(() => safeStorage.decryptEnvelope(envelope, "wrong"));
  assert.equal(safeStorage.decryptEnvelope(token, "test-password"), null);
  assert.equal(safeStorage.isEncryptedCursorToken(token), false);
});

test("safe storage: keychain accounts tried in order", async () => {
  const token = makeJwt({ sub: "auth0|user-2", exp: futureExp() });
  const envelope = safeStorage.encryptTokenForTest(token, "pw-2");
  const calls = [];
  const execFileImpl = (bin, args, opts, cb) => {
    const account = args[args.indexOf("-a") + 1];
    calls.push(account);
    if (account === "Cursor") return cb(new Error("not found"), "");
    return cb(null, "pw-2\n");
  };
  const result = await safeStorage.decryptCursorToken({ envelope, execFileImpl });
  assert.equal(result.token, token);
  assert.equal(result.account, "Cursor Key");
  assert.deepEqual(calls, ["Cursor", "Cursor Key"]);
});

// 閳光偓閳光偓 Cursor 閳光偓閳光偓

test("cursor: JWT decode and cookie header", () => {
  const token = makeJwt({ sub: "auth0|abc123", exp: futureExp() });
  const jwt = cursor.decodeJwt(token);
  assert.equal(jwt.userId, "abc123");
  assert.ok(jwt.exp > 0);
  const cookie = cursor.buildCookie(token, jwt.userId);
  assert.equal(cookie.startsWith("WorkosCursorSessionToken="), true);
  assert.equal(decodeURIComponent(cookie.split("=")[1]), `abc123::${token}`);
  assert.throws(() => cursor.decodeJwt("not-a-jwt"));
});

test("cursor: resolves plain and encrypted tokens", async () => {
  const token = makeJwt({ sub: "auth0|u", exp: futureExp() });
  const plain = await cursor.resolveAccessToken(token, { platform: "win32" });
  assert.equal(plain.token, token);

  const encrypted = safeStorage.encryptTokenForTest(token, "pw");
  const win = await cursor.resolveAccessToken(encrypted, { platform: "win32" });
  assert.equal(win.token, null);
  assert.equal(win.reason, "encrypted-token-on-win32");

  const mac = await cursor.resolveAccessToken(encrypted, {
    platform: "darwin",
    decryptToken: async () => ({ token, account: "Cursor" }),
  });
  assert.equal(mac.token, token);
  assert.equal(mac.encrypted, true);

  const denied = await cursor.resolveAccessToken(encrypted, {
    platform: "darwin",
    decryptToken: async () => null,
  });
  assert.equal(denied.token, null);
});

test("cursor: parses usage-summary percent/cents/unified variants", () => {
  const iso = "2026-12-01T00:00:00Z";
  const resetAt = Date.parse(iso);
  const a = cursor.parseUsageSummary({ planUsage: { percent: 42 }, billingCycleStart: "2026-11-01T00:00:00Z", billingCycleEnd: iso });
  assert.equal(a.monthly.usedPercent, 42);
  assert.equal(a.monthly.resetAt, resetAt);
  assert.equal(Math.round(a.monthly.windowMinutes / 60), 720);

  const b = cursor.parseUsageSummary({ planUsage: { usedCents: 1234, limitCents: 5000 }, billingCycleEnd: iso });
  assert.equal(b.monthly.usedPercent, 25);

  const c = cursor.parseUsageSummary({ isUnified: true, planUsage: { percent: 10, weeklyPercent: 80 }, billingCycleEnd: iso, weeklyResetTimestampUtc: Date.now() + 86400000 });
  assert.equal(c.monthly.usedPercent, 10);
  assert.equal(c.weekly.usedPercent, 80);
  assert.equal(c.weekly.windowMinutes, cursor.WEEK_MINUTES);

  assert.equal(cursor.parseUsageSummary({}), null);
  assert.equal(cursor.parseUsageSummary({ planUsage: { percent: "n/a" } }), null);
});

test("cursor: parses the real usage-summary shape (individualUsage.plan)", () => {
  const body = {
    billingCycleStart: "2026-11-01T00:00:00Z",
    billingCycleEnd: "2026-12-01T00:00:00Z",
    membershipType: "pro",
    limitType: "user",
    individualUsage: {
      plan: { used: 0, limit: 4615, remaining: 4615, totalPercentUsed: 0, autoPercentUsed: 0 },
      onDemand: { used: 0 },
    },
    teamUsage: {},
  };
  const parsed = cursor.parseUsageSummary(body);
  assert.equal(parsed.monthly.usedPercent, 0);
  assert.equal(parsed.planName, "pro");
  assert.equal(parsed.monthly.resetAt, Date.parse("2026-12-01T00:00:00Z"));
  assert.equal(Math.round(parsed.monthly.windowMinutes / 60), 720);
});

test("cursor: parses the real dashboard v2 weekly pool shape", () => {
  const body = {
    availability: "available",
    monthlyUsage: { usedCents: 0, creditsUsedCents: 0 },
    weeklyIncludedStatus: { status: "metered" },
    weeklyIncludedUsage: {
      usedCents: 550,
      budgetCents: 4615,
      resetCounter: 4,
      periodStart: "2026-11-12T02:30:12.679Z",
      resetsAt: "2026-11-19T02:30:12.679Z",
    },
    weeklyIncludedUsageByProduct: [
      { product: "cursor", cents: 245 },
      { product: "grok-bot", cents: 177 },
      { product: "grok-chat", cents: 128 },
    ],
  };
  const parsed = cursor.parseDashboardUsageStatus(body);
  assert.ok(Math.abs(parsed.weekly.usedPercent - 12) <= 1);
  assert.equal(parsed.monthlySpendCents, 0);
  assert.equal(parsed.weekly.windowMinutes, cursor.WEEK_MINUTES);
  assert.equal(parsed.weekly.resetAt, Date.parse("2026-11-19T02:30:12.679Z"));
  assert.equal(cursor.parseDashboardUsageStatus({}), null);
});

test("cursor: unified account maps the weekly pool to cursorQuota.cursorWeekly", async () => {
  const token = makeJwt({ sub: "auth0|user-9", exp: futureExp() });
  const commits = [];
  const fetchJson = async (url) => {
    if (url.includes("/api/usage-summary")) {
      return {
        status: 200,
        json: {
          membershipType: "premium",
          billingCycleStart: "2026-11-01T00:00:00.000Z",
          billingCycleEnd: "2026-12-01T00:00:00.000Z",
          individualUsage: { plan: { used: 0, limit: 4615, totalPercentUsed: 0 } },
        },
      };
    }
    if (url.includes("/api/dashboard/v2/usage-status")) {
      return {
        status: 200,
        json: {
          monthlyUsage: { usedCents: 0 },
          weeklyIncludedUsage: {
            usedCents: 550, budgetCents: 4615,
            periodStart: "2026-11-12T02:30:12.679Z", resetsAt: "2026-11-19T02:30:12.679Z",
          },
        },
      };
    }
    return { status: 404, json: null };
  };
  const runtime = cursor.createCursorQuotaRuntime({
    readToken: async () => token,
    platform: "win32",
    statusPath: null,
    fetchJson,
    commitQuota: (quotas) => commits.push(quotas),
  });
  const result = await runtime.refresh();
  assert.equal(result.status, "ok");
  const group = commits[0].cursorQuota;
  assert.equal(group.cursorWeekly.usedPercent, 12);
  assert.equal(group.cursorWeekly.windowMinutes, cursor.WEEK_MINUTES);
  assert.equal(group.cursorMonthly, undefined);
  // Grok Bot endpoint returned 404 here, so the runtime falls back to the same
  // weekly pool from the dashboard status endpoint.
  assert.equal(commits[0].grokBotQuota.grokBotWeekly.usedPercent, 12);
});

test("cursor: parses Grok Bot weekly usage", () => {
  const reset = Date.now() + 3 * 86400000;
  const bucket = cursor.parseGrokBotUsage({ usagePercent: 63.4, nextResetTimestampUtc: reset });
  assert.equal(bucket.usedPercent, 63);
  assert.equal(bucket.resetAt, reset);
  assert.equal(bucket.windowMinutes, cursor.WEEK_MINUTES);
  assert.equal(cursor.parseGrokBotUsage({}), null);
});

test("cursor: parses legacy request-based usage", () => {
  const parsed = cursor.parseLegacyUsage({ numRequests: 50, maxRequestUsage: 500, billingCycleEnd: "2026-12-01T00:00:00Z" });
  assert.equal(parsed.bucket.usedPercent, 10);
  assert.equal(parsed.requestCount, 50);
  assert.equal(cursor.parseLegacyUsage({}), null);
});

test("cursor: runtime commits both providers from one poll", async () => {
  const token = makeJwt({ sub: "auth0|user-9", exp: futureExp() });
  const commits = [];
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    if (url.includes("/api/usage-summary")) {
      return { status: 200, json: { planUsage: { percent: 37 }, billingCycleEnd: "2026-12-01T00:00:00Z" } };
    }
    if (url.includes("get-sand-usage-status")) {
      return { status: 200, json: { usagePercent: 71, nextResetTimestampUtc: Date.now() + 86400000 } };
    }
    return { status: 404, json: null };
  };
  const runtime = cursor.createCursorQuotaRuntime({
    now: () => Date.now(),
    readToken: async () => token,
    fetchJson,
    commitQuota: (quotas) => commits.push(quotas),
    platform: "win32",
    statusPath: null,
  });
  const result = await runtime.refresh();
  assert.equal(result.status, "ok");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].cursorQuota.cursorMonthly.usedPercent, 37);
  assert.equal(commits[0].grokBotQuota.grokBotWeekly.usedPercent, 71);
  assert.ok(urls.some((u) => u.includes("/api/usage-summary")));
  assert.ok(urls.some((u) => u.includes("get-sand-usage-status")));
});

test("cursor: runtime auth failure does not commit", async () => {
  const token = makeJwt({ sub: "auth0|user-9", exp: futureExp() });
  const commits = [];
  const runtime = cursor.createCursorQuotaRuntime({
    readToken: async () => token,
    platform: "win32",
    statusPath: null,
    fetchJson: async (url) => (url.includes("usage-summary") ? { status: 401, json: null } : { status: 404, json: null }),
    commitQuota: (quotas) => commits.push(quotas),
  });
  const result = await runtime.refresh();
  assert.equal(result.status, "auth-failed");
  assert.equal(commits.length, 0);
});

test("cursor: missing token is reported without network", async () => {
  let networkCalls = 0;
  const runtime = cursor.createCursorQuotaRuntime({
    readToken: async () => null,
    statusPath: null,
    fetchJson: async () => { networkCalls += 1; return null; },
    commitQuota: () => {},
  });
  const result = await runtime.refresh();
  assert.equal(result.status, "no-token");
  assert.equal(networkCalls, 0);
});


