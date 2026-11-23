"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createDeepseekBalanceRuntime, POLL_INTERVAL_MS } = require("../src/deepseek-balance-runtime");

const ID_A = "123e4567-e89b-42d3-a456-426614174000";
const ID_B = "123e4567-e89b-42d3-a456-426614174001";
const success = (amount = "100") => ({ kind: "success", value: {
  is_available: true, balance_infos: [{ currency: "CNY", total_balance: amount }],
} });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(options = {}) {
  let settings = { deepseekBalanceCollectionEnabled: options.enabled !== false,
    agents: { "deepseek-harness": { enabled: options.agentEnabled !== false } } };
  let credential = options.noKey ? null : { apiKey: "sk-private", credentialId: ID_A };
  let record = options.record || null;
  let time = 10000;
  const timers = new Map();
  let timerId = 0;
  const commits = [];
  let clears = 0;
  let coin = null;
  const statuses = [];
  let calls = 0;
  const signals = [];
  const credentialStore = {
    inspectMetadata: () => ({ configured: !!credential, credentialId: credential?.credentialId }),
    inspect: () => ({ configured: !!credential, decryptable: !!credential }),
    load: () => credential,
    save: (apiKey) => {
      if (options.saveFails) throw new Error("sk-private save failure");
      credential = { apiKey, credentialId: ID_B };
      return { credentialId: ID_B };
    },
    forget: () => { credential = null; },
  };
  const runtimeStore = {
    read: () => record,
    write: (value) => {
      if (options.writeFails) throw new Error("sk-private disk failure");
      record = value;
    },
  };
  const dependencies = {
    credentialStore,
    runtimeStore,
    client: { fetchBalance: (key, { signal }) => {
      calls++;
      signals.push(signal);
      return options.fetch ? options.fetch(key, signal) : Promise.resolve(success());
    } },
    getSettingsSnapshot: () => settings,
    setCollectionEnabled: async (enabled) => {
      settings = { ...settings, deepseekBalanceCollectionEnabled: enabled };
      if (options.notify) runtime.onSettingsChanged();
      return { status: "ok" };
    },
    commitLocalDeepseekQuota: (quota) => {
      commits.push(quota);
      coin = quota;
      return { accepted: true, persisted: !options.commitFails };
    },
    clearLocalDeepseekQuota: () => {
      clears++;
      coin = null;
      return { persisted: !options.clearFails };
    },
    onStatusChanged: () => statuses.push(runtime.getStatus()),
    now: () => time,
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, at: time + delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  };
  let runtime = createDeepseekBalanceRuntime(dependencies);
  return { get runtime() { return runtime; }, commits, timers, signals, statuses, credentialStore,
    get coin() { return coin; },
    restart() {
      runtime.dispose();
      runtime = createDeepseekBalanceRuntime(dependencies);
      return runtime.initialize();
    },
    get calls() { return calls; }, get clears() { return clears; }, get record() { return record; },
    get credential() { return credential; }, get settings() { return settings; },
    setEnabled(enabled) { settings.deepseekBalanceCollectionEnabled = enabled; },
    disableAgent() { settings.agents["deepseek-harness"].enabled = false; },
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
      await tick();
    },
  };
}

test("DeepSeek polling starts immediately, repeats every five minutes and stops at exit", async () => {
  const h = harness();
  await h.runtime.initialize(); await tick();
  assert.equal(h.calls, 1);
  await h.advance(POLL_INTERVAL_MS - 1); assert.equal(h.calls, 1);
  await h.advance(1); assert.equal(h.calls, 2);
  h.runtime.dispose();
  await h.advance(POLL_INTERVAL_MS); assert.equal(h.calls, 2);
  assert.equal(h.timers.size, 0);
});

test("DeepSeek collection and agent gates prevent requests and clear old coins", async () => {
  for (const options of [{ enabled: false }, { agentEnabled: false }, { noKey: true }]) {
    const h = harness(options);
    await h.runtime.initialize(); await tick();
    assert.equal(h.calls, 0); assert.ok(h.clears > 0);
    h.runtime.dispose();
  }
  const h = harness({ enabled: false });
  await h.runtime.initialize();
  h.setEnabled(true); h.runtime.onSettingsChanged(); await tick();
  assert.equal(h.calls, 1);
  h.disableAgent(); h.runtime.onSettingsChanged();
  assert.equal(h.timers.size, 0); assert.ok(h.clears > 0);
});

test("DeepSeek in-flight fence prevents concurrent refreshes and drops disabled responses", async () => {
  let resolve;
  const h = harness({ fetch: () => new Promise((done) => { resolve = done; }) });
  await h.runtime.initialize(); await tick();
  await h.advance(POLL_INTERVAL_MS);
  const duplicate = h.runtime.refresh(); await tick(); assert.equal(h.calls, 1);
  await duplicate;
  h.setEnabled(false); h.runtime.onSettingsChanged();
  assert.equal(h.signals[0].aborted, true);
  resolve(success()); await tick();
  assert.equal(h.commits.length, 0);
});

test("DeepSeek suspend/resume waits for an old request to settle before replacing it", async () => {
  const resolvers = [];
  const h = harness({ fetch: () => new Promise((done) => resolvers.push(done)) });
  await h.runtime.initialize(); await tick();
  h.runtime.suspend(); h.runtime.resume(); await tick();
  assert.equal(h.calls, 1);
  resolvers[0](success("1")); await tick();
  assert.equal(h.commits.length, 0);
  assert.equal(h.calls, 2);
  resolvers[1](success("90")); await tick();
  assert.equal(h.commits[0].deepseekBalance.amount, 90);
  h.runtime.suspend(); h.disableAgent(); h.runtime.resume(); await tick();
  assert.equal(h.calls, 2); assert.equal(h.timers.size, 0);
});

test("DeepSeek 401 stops polling until explicit reconnect", async () => {
  let result = success();
  const h = harness({ fetch: async () => result });
  await h.runtime.initialize(); await tick();
  result = { kind: "credential-rejected", statusCode: 401 };
  await h.advance(POLL_INTERVAL_MS);
  assert.equal(h.runtime.getStatus().state, "credential-rejected");
  assert.equal(h.timers.size, 0);
  const clears = h.clears;
  h.runtime.suspend(); h.runtime.resume(); h.runtime.onSettingsChanged();
  await h.advance(POLL_INTERVAL_MS); assert.equal(h.calls, 2);
  assert.equal(h.clears, clears);
  result = success("80");
  await h.runtime.reconnect(); await tick();
  assert.equal(h.calls, 3); assert.equal(h.timers.size, 1);
});

for (const kind of ["payment-required", "rate-limited", "server-error", "timeout", "network-error",
  "malformed-response"]) {
  test(`DeepSeek ${kind} preserves old quota and retries next period`, async () => {
    let result = success();
    const h = harness({ fetch: async () => result });
    await h.runtime.initialize(); await tick();
    const clears = h.clears;
    result = { kind };
    await h.advance(POLL_INTERVAL_MS);
    assert.equal(h.commits.length, 1); assert.equal(h.clears, clears);
    assert.equal(h.runtime.getStatus().reason, kind);
    result = success("70"); await h.advance(POLL_INTERVAL_MS);
    assert.equal(h.commits.length, 2);
    h.runtime.dispose();
  });
}

test("DeepSeek connect, disconnect and forget keep the key outside public status and prefs", async () => {
  const output = [];
  const originals = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...args) => output.push(args.join(" "));
  try {
    const h = harness({ enabled: false, noKey: true, notify: true });
    await h.runtime.connect("sk-private"); await tick();
    assert.equal(h.calls, 1); assert.equal(h.record.credentialId, ID_B);
    assert.doesNotMatch(JSON.stringify([h.runtime.getStatus(), h.settings, h.commits, output]), /sk-private/);
    assert.equal((await h.runtime.forget()).reason, "disconnect-required");
    await h.runtime.disconnect();
    assert.equal(h.credential.apiKey, "sk-private"); assert.equal(h.timers.size, 0);
    await h.runtime.forget(); assert.equal(h.credential, null); assert.equal(h.record, null);
  } finally { [console.log, console.warn, console.error] = originals; }
});

test("DeepSeek startup clears quota after interruption between credential and runtime writes", async () => {
  const h = harness({ record: { version: 1, credentialId: ID_B, currency: "CNY",
    baseline: 500, lastAmount: 400, capturedAt: 1000 } });
  await h.runtime.initialize(); await tick();
  assert.ok(h.clears >= 1);
  assert.equal(h.commits[0].deepseekBalance.baseline, 100);
  assert.equal(h.record.credentialId, ID_A);
  h.runtime.dispose();
});

test("DeepSeek runtime persistence failure clears a quota that could not be bound", async () => {
  const h = harness({ writeFails: true, record: { version: 1, credentialId: ID_A, currency: "CNY",
    baseline: 100, lastAmount: 100, capturedAt: 1000 } });
  await h.runtime.initialize(); await tick();
  assert.equal(h.commits.length, 1); assert.equal(h.clears, 1);
  assert.equal(h.runtime.getStatus().reason, "runtime-persistence-failed");
  h.runtime.dispose();
});


test("DeepSeek connecting a disabled agent saves opt-in without querying", async () => {
  const h = harness({ enabled: false, agentEnabled: false, notify: true });
  const result = await h.runtime.connect("sk-private");
  await tick();
  assert.equal(result.status, "ok");
  assert.equal(result.reason, "agent-disabled");
  assert.equal(h.calls, 0);
  assert.equal(h.runtime.getStatus().collectionEnabled, true);
});

test("DeepSeek exit aborts an active request and never accepts its late result", async () => {
  let resolve;
  const h = harness({ fetch: () => new Promise((done) => { resolve = done; }) });
  await h.runtime.initialize(); await tick();
  h.runtime.dispose();
  assert.equal(h.signals[0].aborted, true);
  resolve(success()); await tick();
  assert.equal(h.commits.length, 0);
  assert.equal(h.timers.size, 0);
});

test("DeepSeek discards a response when canonical opt-in changed without a callback", async () => {
  let resolve;
  const h = harness({ fetch: () => new Promise((done) => { resolve = done; }) });
  await h.runtime.initialize(); await tick();
  h.setEnabled(false);
  resolve(success()); await tick();
  assert.equal(h.commits.length, 0);
  h.runtime.dispose();
});


test("DeepSeek failed key replacement keeps the old connection polling", async () => {
  const h = harness({ saveFails: true });
  await h.runtime.initialize(); await tick();
  const result = await h.runtime.connect("sk-private-replacement");
  assert.equal(result.status, "error");
  assert.equal(result.reason, "credential-save-failed");
  assert.equal(h.credential.credentialId, ID_A);
  assert.equal(h.timers.size, 1);
  await tick();
  const before = h.calls;
  await h.advance(POLL_INTERVAL_MS);
  assert.equal(h.calls, before + 1);
  h.runtime.dispose();
});

test("DeepSeek reflected failures never enter public status, prefs, quota or logs", async () => {
  const output = [];
  const originals = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...args) => output.push(args.join(" "));
  try {
    const h = harness({ fetch: async () => { throw new Error("sk-private reflected failure"); } });
    await h.runtime.initialize(); await tick();
    assert.equal(h.runtime.getStatus().reason, "network-error");
    assert.doesNotMatch(JSON.stringify([h.runtime.getStatus(), h.settings, h.commits, output]), /sk-private/);
    h.runtime.dispose();
  } finally { [console.log, console.warn, console.error] = originals; }
});


for (const gate of ["collection", "agent"]) {
  test(`DeepSeek clearing ${gate} removes an already committed coin`, async () => {
    const h = harness();
    await h.runtime.initialize();
    await tick();
    assert.equal(h.coin.deepseekBalance.amount, 100);
    const before = h.clears;
    if (gate === "collection") h.setEnabled(false);
    else h.disableAgent();
    h.runtime.onSettingsChanged();
    assert.equal(h.clears, before + 1);
    assert.equal(h.coin, null);
    assert.equal(h.timers.size, 0);
    h.runtime.dispose();
  });
}

test("DeepSeek clears the coin on the next check after external credential deletion", async () => {
  const h = harness();
  await h.runtime.initialize();
  await tick();
  assert.equal(h.coin.deepseekBalance.amount, 100);
  const before = h.clears;
  h.credentialStore.forget();
  await h.advance(POLL_INTERVAL_MS);
  assert.equal(h.clears, before + 1);
  assert.equal(h.coin, null);
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls, 1);
});

test("DeepSeek rejects an in-flight result after external key replacement without a generation change", async () => {
  let resolve;
  const h = harness({ fetch: () => new Promise((done) => { resolve = done; }) });
  await h.runtime.initialize();
  h.credentialStore.save("sk-external-replacement");
  resolve(success());
  await tick();
  assert.equal(h.commits.length, 0);
  assert.equal(h.coin, null);
  h.runtime.dispose();
});

for (const hasBalance of [false, true]) {
  test(`DeepSeek persists a rejected key across restart with prior balance ${hasBalance}`, async () => {
    let result = hasBalance ? success() : { kind: "credential-rejected", statusCode: 401 };
    const h = harness({ fetch: async () => result });
    await h.runtime.initialize();
    await tick();
    if (hasBalance) {
      result = { kind: "credential-rejected", statusCode: 401 };
      await h.advance(POLL_INTERVAL_MS);
    }
    const before = h.calls;
    assert.equal(h.record.credentialId, ID_A);
    assert.equal(h.record.rejected, true);
    assert.equal(h.timers.size, 0);
    await h.restart();
    await tick();
    assert.equal(h.runtime.getStatus().state, "credential-rejected");
    assert.equal(h.calls, before);
    assert.equal(h.timers.size, 0);
    h.runtime.suspend();
    h.runtime.resume();
    await h.advance(POLL_INTERVAL_MS * 3);
    assert.equal(h.timers.size, 0);
    assert.equal(h.calls, before);
    result = success("80");
    await h.runtime.reconnect();
    await tick();
    assert.equal(h.calls, before + 1);
    assert.notEqual(h.record?.rejected, true);
    assert.equal(h.runtime.getStatus().state, "fresh");
    h.runtime.dispose();
  });
}

test("DeepSeek reports background refreshing, fresh and rejected status without credential data", async () => {
  let result = success();
  const h = harness({ fetch: async () => result });
  await h.runtime.initialize();
  await tick();
  assert.ok(h.statuses.some((status) => status.state === "refreshing"));
  assert.equal(h.statuses.at(-1).state, "fresh");
  result = { kind: "credential-rejected", statusCode: 401 };
  await h.advance(POLL_INTERVAL_MS);
  assert.equal(h.statuses.at(-1).state, "credential-rejected");
  assert.doesNotMatch(JSON.stringify(h.statuses), /sk-private/);
  h.runtime.dispose();
});


test("DeepSeek only applies a stored rejection to its matching credential", async () => {
  const h = harness({ record: { version: 1, credentialId: ID_B, rejected: true } });
  await h.runtime.initialize();
  await tick();
  assert.equal(h.calls, 1);
  assert.equal(h.runtime.getStatus().state, "fresh");
  assert.equal(h.record.credentialId, ID_A);
  h.runtime.dispose();
});

for (const action of ["replace", "forget"]) {
  test(`DeepSeek ${action} clears a persisted rejection`, async () => {
    let result = { kind: "credential-rejected", statusCode: 401 };
    const h = harness({ fetch: async () => result });
    await h.runtime.initialize();
    await tick();
    assert.equal(h.record.rejected, true);
    if (action === "replace") {
      result = success();
      await h.runtime.connect("sk-replacement");
      await tick();
      assert.equal(h.record.credentialId, ID_B);
      assert.notEqual(h.record.rejected, true);
      assert.equal(h.runtime.getStatus().state, "fresh");
    } else {
      await h.runtime.disconnect();
      await h.runtime.forget();
      assert.equal(h.record, null);
      assert.equal(h.credential, null);
    }
    h.runtime.dispose();
  });
}
