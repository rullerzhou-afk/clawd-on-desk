"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createDshBalanceRuntime,
  bucketFromPayload,
  parseNetstatListeningPorts,
  BALANCE_BASELINE_CNY,
} = require("../src/dsh-balance-runtime");
const { normalizeQuotaGroup } = require("../hooks/quota-bucket");

const NETSTAT_SAMPLE = [
  "  TCP    127.0.0.1:61247        0.0.0.0:0              LISTENING       69400",
  "  TCP    [::]:1053              [::]:0                 LISTENING       73672",
  "  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4",
  "  TCP    127.0.0.1:23333        0.0.0.0:0              LISTENING       7156",
  "  TCP    127.0.0.1:50000        127.0.0.1:61247        ESTABLISHED     1",
].join("\r\n");

function payload(totalBalance, currency = "CNY") {
  return {
    ok: true,
    is_available: true,
    balance_infos: [{ currency, total_balance: totalBalance, granted_balance: "0.00", topped_up_balance: totalBalance }],
  };
}

describe("DSH balance 鈥?listener parsing", () => {
  it("parses loopback + wildcard listeners and ignores established connections", () => {
    assert.deepStrictEqual(parseNetstatListeningPorts(NETSTAT_SAMPLE), [61247, 1053, 445, 23333]);
  });

  it("tolerates empty / garbage input", () => {
    assert.deepStrictEqual(parseNetstatListeningPorts(""), []);
    assert.deepStrictEqual(parseNetstatListeningPorts("TCP foo bar"), []);
    assert.deepStrictEqual(parseNetstatListeningPorts(null), []);
  });
});

describe("DSH balance 鈥?bucket mapping", () => {
  it("maps the 楼 balance onto usedPercent against the reference amount", () => {
    const bucket = bucketFromPayload(payload("50.00"), 1234, 50);
    assert.deepStrictEqual(bucket, {
      usedPercent: 0,
      amount: 50,
      currency: "CNY",
      capturedAt: 1234,
    });
    assert.strictEqual(bucketFromPayload(payload("37.50"), 1, 50).usedPercent, 25);
    assert.strictEqual(bucketFromPayload(payload("0.00"), 1, 50).usedPercent, 100);
  });

  it("clamps the percentage when the balance exceeds the reference amount", () => {
    assert.strictEqual(bucketFromPayload(payload("57.29"), 1, 50).usedPercent, 0);
    assert.strictEqual(bucketFromPayload(payload("10.00"), 1, 20).usedPercent, 50);
  });

  it("falls back to the built-in reference amount for invalid baselines", () => {
    assert.strictEqual(bucketFromPayload(payload("0"), 1, 0).usedPercent, 100);
    assert.strictEqual(bucketFromPayload(payload("0"), 1, null).usedPercent, 100);
    assert.strictEqual(
      bucketFromPayload(payload("0"), 1, Number.NaN).usedPercent,
      bucketFromPayload(payload("0"), 1, BALANCE_BASELINE_CNY).usedPercent
    );
  });

  it("prefers CNY over other currencies and rejects malformed payloads", () => {
    const both = { ok: true, balance_infos: [
      { currency: "USD", total_balance: "3.50" },
      { currency: "CNY", total_balance: "57.29" },
    ] };
    assert.strictEqual(bucketFromPayload(both, 1, 50).amount, 57.29);
    assert.strictEqual(bucketFromPayload(both, 1, 50).currency, "CNY");
    assert.strictEqual(bucketFromPayload({ ok: false }, 1, 50), null);
    assert.strictEqual(bucketFromPayload({ ok: true, balance_infos: [] }, 1, 50), null);
    assert.strictEqual(
      bucketFromPayload({ ok: true, balance_infos: [{ currency: "CNY", total_balance: "abc" }] }, 1, 50),
      null
    );
  });
});

describe("DSH balance 鈥?bucket passthrough in the account store", () => {
  it("keeps amount/currency next to usedPercent", () => {
    const group = normalizeQuotaGroup(
      { deepseekBalance: { usedPercent: 42, amount: 29, currency: "CNY", capturedAt: 1 } },
      ["deepseekBalance"]
    );
    assert.deepStrictEqual(group, {
      deepseekBalance: { usedPercent: 42, amount: 29, currency: "CNY", capturedAt: 1 },
    });
  });
});

describe("DSH balance 鈥?runtime polling", () => {
  function fakeTransport(options = {}) {
    const state = { spawns: 0, listCalls: 0, requests: [] };
    const httpGet = async (port, requestPath, timeoutMs) => {
      state.requests.push({ port, requestPath, timeoutMs });
      if (options.httpGet) return options.httpGet(port, requestPath, timeoutMs, state);
      return port === options.port ? { status: 200, json: payload(options.balance || "57.29") } : null;
    };
    const execFile = (command, args, execOptions, callback) => {
      state.spawns += 1;
      callback(null, NETSTAT_SAMPLE);
    };
    const listListeningPorts = () => {
      state.listCalls += 1;
      return options.list || parseNetstatListeningPorts(NETSTAT_SAMPLE);
    };
    return { state, httpGet, execFile, listListeningPorts };
  }

  it("discovers the balance route, commits a bucket and caches the port", async () => {
    const transport = fakeTransport({ port: 61247 });
    const commits = [];
    const runtime = createDshBalanceRuntime({
      httpGet: transport.httpGet,
      execFile: transport.execFile,
      listListeningPorts: transport.listListeningPorts,
      commitLocalDshQuota: (quota) => commits.push(quota),
      getEnabled: () => true,
      getBaseline: () => 50,
      intervalMs: 60_000,
      cachePath: null,
      now: () => 777,
    });
    const result = await runtime.refresh();
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.port, 61247);
    assert.deepStrictEqual(commits, [{
      deepseekBalance: { usedPercent: 0, amount: 57.29, currency: "CNY", capturedAt: 777 },
    }]);
    assert.strictEqual(transport.state.listCalls, 1);
    // The cached port is reused: a second poll must not scan listeners again.
    await runtime.refresh();
    assert.strictEqual(transport.state.listCalls, 1);
    assert.strictEqual(runtime.getStatus().port, 61247);
  });

  it("uses the configured baseline for the percentage", async () => {
    const transport = fakeTransport({ port: 61247, balance: "37.50" });
    const commits = [];
    const runtime = createDshBalanceRuntime({
      httpGet: transport.httpGet,
      execFile: transport.execFile,
      listListeningPorts: transport.listListeningPorts,
      commitLocalDshQuota: (quota) => commits.push(quota),
      getEnabled: () => true,
      getBaseline: () => 50,
      intervalMs: 60_000,
      cachePath: null,
      now: () => 1,
    });
    await runtime.refresh();
    assert.strictEqual(commits[0].deepseekBalance.usedPercent, 25);
  });

  it("honors the integration gate", async () => {
    const transport = fakeTransport({ port: 61247 });
    let enabled = false;
    const runtime = createDshBalanceRuntime({
      httpGet: transport.httpGet,
      execFile: transport.execFile,
      listListeningPorts: transport.listListeningPorts,
      commitLocalDshQuota: () => assert.fail("must not commit while disabled"),
      getEnabled: () => enabled,
      intervalMs: 60_000,
      cachePath: null,
    });
    assert.strictEqual((await runtime.refresh()).status, "disabled");
    enabled = true;
    assert.strictEqual((await runtime.refresh()).status, "ok");
  });

  it("backs off the listener scan while the DSH app is closed", async () => {
    const transport = fakeTransport({ port: null });
    const runtime = createDshBalanceRuntime({
      httpGet: transport.httpGet,
      execFile: transport.execFile,
      listListeningPorts: transport.listListeningPorts,
      commitLocalDshQuota: () => {},
      getEnabled: () => true,
      intervalMs: 60_000,
      cachePath: null,
    });
    for (let i = 0; i < 6; i += 1) await runtime.refresh();
    // Discovery runs on the first failure and then every fifth failure: 1, 5.
    assert.strictEqual(transport.state.listCalls, 2);
    assert.strictEqual(runtime.getStatus().lastError, "balance endpoint not reachable");
  });
});

