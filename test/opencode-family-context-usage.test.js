// #830 — opencode-family context usage reporting (message.updated → /state
// metadata_only). Covers: extraction formula (component sum incl. reasoning,
// matching the host's Context view — no `total` on public message tokens),
// model-limit resolution via provider.list() (SDK envelope, keyed models map,
// unknown provider/model, failure, TTL cache), wire-body shape,
// assistant-role/zero-token gating, and per-session dedup driven through the
// real event hook handler.

const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { pathToFileURL } = require("node:url");

async function loadCore() {
  const modulePath = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
  return import(pathToFileURL(modulePath).href);
}

const OPENCODE_PARAMS = Object.freeze({
  agentId: "opencode",
  hookSource: "opencode-plugin",
  logFileName: "opencode-plugin.log",
  sessionIdPrefix: "opencode:",
});

const MIMOCODE_PARAMS = Object.freeze({
  agentId: "mimocode",
  hookSource: "mimocode-plugin",
  logFileName: "mimocode-plugin.log",
  sessionIdPrefix: "mimocode:",
});

// Fake in-process SDK client. The normal SDK client returns the fields-style
// wrapper { data: { all: [...] }, request, response }; responseStyle:"data"
// callers receive { all: [...] } or { providers: [...] } directly. Counts
// calls so cache behavior is observable.
function makeFakeClient(providers, opts = {}) {
  const calls = { providerList: 0 };
  const list = async () => {
    calls.providerList += 1;
    if (opts.reject) throw new Error("provider.list boom");
    if (opts.envelope === "all") return { all: providers };
    if (opts.envelope === "providers") return { providers };
    return { data: { all: providers }, request: {}, response: {} };
  };
  return { client: { provider: { list } }, calls };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sdkProviderResult(providers) {
  return { data: { all: providers }, request: {}, response: {} };
}

function makeDeferredClient() {
  const pending = [];
  const calls = { providerList: 0 };
  const list = () => {
    calls.providerList += 1;
    const gate = deferred();
    pending.push(gate);
    return gate.promise;
  };
  return { client: { provider: { list } }, calls, pending };
}

function makeSequenceClient(results) {
  const calls = { providerList: 0 };
  const list = async () => {
    const result = results[calls.providerList++];
    if (result instanceof Error) throw result;
    return typeof result === "function" ? result() : result;
  };
  return { client: { provider: { list } }, calls };
}

// Captures every POST the plugin makes (headers carry the Clawd identity the
// port-discovery loop requires before trusting the port).
function installFetchStub({ accepted = () => true } = {}) {
  const posted = [];
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    attempts += 1;
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    const isAccepted = accepted(attempts, posted.at(-1));
    posted.at(-1).accepted = isAccepted;
    return {
      status: isAccepted ? 200 : 503,
      headers: { get: (name) => (name.toLowerCase() === "x-clawd-server" && isAccepted ? "clawd-on-desk" : null) },
      text: async () => "",
    };
  };
  return { posted, get attempts() { return attempts; }, restore: () => { globalThis.fetch = originalFetch; } };
}

// Real message.updated shape: event.properties.info is the Message object
// (assistant messages carry flat providerID/modelID + tokens);
// event.properties.sessionID sidecars the session.
function messageUpdatedEvent({
  sessionID = "ses_abc",
  infoSessionID,
  providerID = "openai",
  modelID = "deepseek-v4",
  role = "assistant",
  tokens,
} = {}) {
  const info = { role, providerID, modelID, time: 123 };
  if (infoSessionID !== undefined) info.sessionID = infoSessionID;
  if (tokens !== undefined) info.tokens = tokens;
  const properties = { messageID: "msg_1", info, time: 123 };
  if (sessionID !== null) properties.sessionID = sessionID;
  return {
    type: "message.updated",
    properties,
  };
}

describe("opencode-family message.updated → contextUsage (core.extractContextUsageUsed)", () => {
  let core;
  before(async () => { core = await loadCore(); });

  it("sums input + output + reasoning + cache read/write like the host Context view", () => {
    assert.strictEqual(
      core.extractContextUsageUsed({ input: 100, output: 200, reasoning: 150, cache: { read: 25, write: 50 } }),
      525
    );
    assert.strictEqual(
      core.extractContextUsageUsed({ input: 100, output: 200, cache: 25 }),
      325,
      "primitive cache is used as-is"
    );
    assert.strictEqual(
      core.extractContextUsageUsed({ input: 1.5, output: 0, reasoning: 0, cache: { read: 8, write: 2 } }),
      11.5,
      "object cache sums read AND write"
    );
    assert.strictEqual(
      core.extractContextUsageUsed({ input: "40", output: "60", reasoning: "50" }),
      150,
      "coerces string components"
    );
  });

  it("ignores `total` — it is an internal SessionV1 aggregate, not a message-token field", () => {
    assert.strictEqual(core.extractContextUsageUsed({ total: 1000 }), null);
    assert.strictEqual(core.extractContextUsageUsed({ total: 1000, input: 1, output: 2 }), 3);
  });

  it("returns null for payloads without usable numbers", () => {
    assert.strictEqual(core.extractContextUsageUsed(null), null);
    assert.strictEqual(core.extractContextUsageUsed(undefined), null);
    assert.strictEqual(core.extractContextUsageUsed({}), null);
    assert.strictEqual(core.extractContextUsageUsed("nope"), null);
    assert.strictEqual(core.extractContextUsageUsed({ used: 42 }), null, "used is not a token field");
    assert.strictEqual(core.extractContextUsageUsed({ input: null, output: null }), null);
    assert.strictEqual(core.extractContextUsageUsed({ reasoningOutput: 150 }), null, "old field name must not count");
  });
});

describe("opencode-family contextUsage limit resolution (resolveContextLimit)", () => {
  let core;
  before(async () => { core = await loadCore(); });

  it("unwraps the SDK fields-style {data:{all},request,response} envelope", async () => {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const { client } = makeFakeClient([
      {
        id: "openai",
        models: {
          "deepseek-v4": { limit: { context: 128000 } },
          "gpt-5": { limit: { context: 1000 } },
        },
      },
      { id: "anthropic", models: { "claude-x": { limit: { context: 200000 } } } },
    ]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "deepseek-v4", client), 128000);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "gpt-5", client), 1000);
    assert.strictEqual(await plugin.__test.resolveContextLimit("anthropic", "claude-x", client), 200000);
  });

  it("matches the provider by providerID, the model by modelID — never by modelID alone", async () => {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const { client } = makeFakeClient([
      { id: "openai", models: { "deepseek-v4": { limit: { context: 128000 } } } },
    ]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "deepseek-v4", client), 128000);
    assert.strictEqual(
      await plugin.__test.resolveContextLimit("deepseek-v4", "deepseek-v4", client),
      null,
      "passing the model id as provider id must not match"
    );
  });

  it("accepts a Map instance for provider.models", async () => {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const { client } = makeFakeClient([
      { id: "openai", models: new Map([["deepseek-v4", { limit: { context: 128000 } }]]) },
    ]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "deepseek-v4", client), 128000);
  });

  it("fails closed when only provider.options.limit is present", async () => {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const { client } = makeFakeClient([
      { id: "legacy", options: { limit: 240000 } },
    ]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("legacy", "any-model", client), null);
  });

  it("unwraps the live CLI envelope { all: [...] } (SDK ProviderListResponses)", async () => {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const { client } = makeFakeClient(
      [
        {
          id: "opencode-go",
          name: "opencode-go",
          env: [],
          models: { "deepseek-v4-flash": { id: "deepseek-v4-flash", limit: { context: 1000000, output: 64000 } } },
        },
        { id: "anthropic", models: { "claude-x": { limit: { context: 200000 } } } },
      ],
      { envelope: "all" }
    );
    assert.strictEqual(await plugin.__test.resolveContextLimit("opencode-go", "deepseek-v4-flash", client), 1000000);
    assert.strictEqual(await plugin.__test.resolveContextLimit("anthropic", "claude-x", client), 200000);
  });

  it("unwraps the /config/providers envelope { providers: [...] }", async () => {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const { client } = makeFakeClient(
      [{ id: "openai", models: { "deepseek-v4": { limit: { context: 128000 } } } }],
      { envelope: "providers" }
    );
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "deepseek-v4", client), 128000);
  });

  it("accepts an array-shaped models collection inside a supported provider payload", async () => {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const { client } = makeFakeClient([
      { id: "openai", models: [{ id: "deepseek-v4", limit: { context: 64000 } }] },
    ]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "deepseek-v4", client), 64000);
  });

  it("returns null for unknown providers/models and never throws on provider failure", async () => {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const ok = makeFakeClient([{ id: "openai", models: { known: { limit: { context: 64000 } } } }]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("nope", "known", ok.client), null);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "nope", ok.client), null);
    const boom = makeFakeClient([], { reject: true });
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "known", boom.client), null);
    const noClient = makeFakeClient([]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "known", null), null);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", null, noClient.client), null);
  });

  it("caches the resolved limit per provider+model for the TTL window", async () => {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const { client, calls } = makeFakeClient([
      { id: "openai", models: { "cached-model": { limit: { context: 96000 } } } },
    ]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "cached-model", client), 96000);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "cached-model", client), 96000);
    assert.strictEqual(calls.providerList, 1, "second call must hit the cache");
  });

  it("scopes the cache to the SDK client, not only provider/model ids", async () => {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const a = makeFakeClient([
      { id: "shared", models: { model: { limit: { context: 1000 } } } },
    ]);
    const b = makeFakeClient([
      { id: "shared", models: { model: { limit: { context: 2000 } } } },
    ]);

    assert.strictEqual(await plugin.__test.resolveContextLimit("shared", "model", a.client), 1000);
    assert.strictEqual(await plugin.__test.resolveContextLimit("shared", "model", b.client), 2000);
    assert.strictEqual(a.calls.providerList, 1);
    assert.strictEqual(b.calls.providerList, 1);
  });

  it("does not cache an unavailable limit as a normal positive result", async () => {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const client = makeSequenceClient([
      sdkProviderResult([{ id: "openai", models: {} }]),
      sdkProviderResult([{ id: "openai", models: { model: { limit: { context: 64000 } } } }]),
    ]);

    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "model", client.client), null);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "model", client.client), 64000);
    assert.strictEqual(client.calls.providerList, 2);
  });
});

describe("opencode-family contextUsage wire path (handleContextUsageEvent)", () => {
  let core;
  let stub;
  beforeEach(async () => { core = await loadCore(); stub = installFetchStub(); });
  afterEach(() => { stub.restore(); });

  function makePlugin() {
    const plugin = core.createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    plugin.__test._cachedPort = 23333; // skip runtime.json + port scan
    return plugin;
  }

  async function drive(plugin, event) {
    const pending = plugin.__test.handleContextUsageEvent(event, { client: makeFakeClient([
      { id: "openai", models: { "deepseek-v4": { limit: { context: 128000 } } } },
    ]).client });
    await pending;
  }

  it("POSTs a metadata_only contextUsage body carrying used + resolved limit", async () => {
    const plugin = makePlugin();
    await drive(plugin, messageUpdatedEvent({
      providerID: "openai",
      tokens: { input: 1000, output: 2000, reasoning: 500, cache: { read: 100, write: 200 } },
    }));

    assert.strictEqual(stub.posted.length, 1);
    const body = stub.posted[0].body;
    assert.strictEqual(stub.posted[0].url, "http://127.0.0.1:23333/state");
    assert.strictEqual(body.metadata_only, true);
    assert.strictEqual(body.agent_id, "opencode");
    assert.strictEqual(body.hook_source, "opencode-plugin");
    assert.strictEqual(body.session_id, "opencode:ses_abc");
    assert.deepStrictEqual(body.context_usage, { used: 3800, limit: 128000, source: "opencode" });
    assert.strictEqual(
      body.state,
      "idle",
      "metadata POST rides the serialized state channel; state scaffolding is inert on the route side (metadata_only short-circuits) but must not carry lifecycle meaning"
    );
    assert.strictEqual(body.event, "SessionUpdate");
  });

  it("uses the v1.1.25 info.sessionID and never posts under the message id", async () => {
    const plugin = makePlugin();
    await drive(plugin, messageUpdatedEvent({
      sessionID: null,
      infoSessionID: "ses_real",
      tokens: { input: 100, output: 50 },
    }));

    assert.strictEqual(stub.posted.length, 1);
    assert.strictEqual(stub.posted[0].body.session_id, "opencode:ses_real");
    assert.notStrictEqual(stub.posted[0].body.session_id, "opencode:msg_1");
  });

  it("keeps limit null for unknown providers/models", async () => {
    const plugin = makePlugin();
    await drive(plugin, messageUpdatedEvent({
      providerID: "unknown-provider",
      modelID: "unknown-model",
      tokens: { input: 40000, output: 2000 },
    }));

    assert.strictEqual(stub.posted.length, 1);
    assert.deepStrictEqual(stub.posted[0].body.context_usage, { used: 42000, limit: null, source: "opencode" });
  });

  it("skips non-assistant messages (user messages carry no assistant token totals)", async () => {
    const plugin = makePlugin();
    await drive(plugin, messageUpdatedEvent({ role: "user", tokens: { input: 1000, output: 2000 } }));
    assert.strictEqual(stub.posted.length, 0, "role:user must be dropped before POST");
    assert.strictEqual(plugin.__test._lastContextUsageBySession.size, 0);
  });

  it("skips zero-token refreshes (in-progress streaming messages)", async () => {
    const plugin = makePlugin();
    await drive(plugin, messageUpdatedEvent({ tokens: { input: 0, output: 0 } }));
    assert.strictEqual(stub.posted.length, 0);
  });

  it("dedups per session and skips identical refreshes entirely", async () => {
    const plugin = makePlugin();
    const ev = messageUpdatedEvent({ tokens: { input: 40000, output: 2000 } });
    await drive(plugin, ev);
    await drive(plugin, ev); // identical summary update
    assert.strictEqual(stub.posted.length, 1, "identical refresh must be dropped");

    await drive(plugin, messageUpdatedEvent({ tokens: { input: 41000, output: 2000 } }));
    assert.strictEqual(stub.posted.length, 2, "changed used must repost");
    assert.deepStrictEqual(stub.posted[1].body.context_usage, { used: 43000, limit: 128000, source: "opencode" });
  });

  it("publishes only the newest sample when provider lookups resolve out of order", async () => {
    const plugin = makePlugin();
    const provider = [{ id: "openai", models: { model: { limit: { context: 1000 } } } }];
    const lookup = makeDeferredClient();
    const first = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ modelID: "model", tokens: { input: 100 } }),
      { client: lookup.client, instanceToken: 1 }
    );
    const second = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ modelID: "model", tokens: { input: 200 } }),
      { client: lookup.client, instanceToken: 1 }
    );
    assert.strictEqual(lookup.pending.length, 2);

    lookup.pending[1].resolve(sdkProviderResult(provider));
    await second;
    lookup.pending[0].resolve(sdkProviderResult(provider));
    await first;

    assert.deepStrictEqual(
      stub.posted.filter((call) => call.accepted).map((call) => call.body.context_usage.used),
      [200]
    );
  });

  it("allows a legitimate lower used value from a newer compaction sample", async () => {
    const plugin = makePlugin();
    const provider = [{ id: "openai", models: { model: { limit: { context: 1000 } } } }];
    const lookup = makeDeferredClient();
    const first = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ modelID: "model", tokens: { input: 200 } }),
      { client: lookup.client, instanceToken: 1 }
    );
    const second = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ modelID: "model", tokens: { input: 100 } }),
      { client: lookup.client, instanceToken: 1 }
    );
    lookup.pending[1].resolve(sdkProviderResult(provider));
    await second;
    lookup.pending[0].resolve(sdkProviderResult(provider));
    await first;

    assert.deepStrictEqual(
      stub.posted.filter((call) => call.accepted).map((call) => call.body.context_usage.used),
      [100]
    );
  });

  it("publishes same used when provider/model or resolved limit changes", async () => {
    const plugin = makePlugin();
    const a = makeFakeClient([
      { id: "openai", models: { model_a: { limit: { context: 1000 } } } },
    ]);
    const b = makeFakeClient([
      { id: "anthropic", models: { model_b: { limit: { context: 2000 } } } },
    ]);

    await plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ providerID: "openai", modelID: "model_a", tokens: { input: 100 } }),
      { client: a.client, instanceToken: 1 }
    );
    await plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ providerID: "anthropic", modelID: "model_b", tokens: { input: 100 } }),
      { client: b.client, instanceToken: 1 }
    );

    assert.deepStrictEqual(
      stub.posted.filter((call) => call.accepted).map((call) => call.body.context_usage),
      [
        { used: 100, limit: 1000, source: "opencode" },
        { used: 100, limit: 2000, source: "opencode" },
      ]
    );
  });

  it("retries the same used value after an unavailable limit recovers", async () => {
    const plugin = makePlugin();
    const client = makeSequenceClient([
      sdkProviderResult([{ id: "openai", models: {} }]),
      sdkProviderResult([{ id: "openai", models: { model: { limit: { context: 1000 } } } }]),
    ]);
    const event = messageUpdatedEvent({ modelID: "model", tokens: { input: 100 } });

    await plugin.__test.handleContextUsageEvent(event, { client: client.client, instanceToken: 1 });
    await plugin.__test.handleContextUsageEvent(event, { client: client.client, instanceToken: 1 });

    assert.deepStrictEqual(
      stub.posted.filter((call) => call.accepted).map((call) => call.body.context_usage),
      [
        { used: 100, limit: null, source: "opencode" },
        { used: 100, limit: 1000, source: "opencode" },
      ]
    );
    assert.strictEqual(client.calls.providerList, 2);
  });

  it("does not advance the dedup baseline when the state delivery fails", async () => {
    const plugin = makePlugin();
    const failingThenHealthy = installFetchStub({ accepted: (attempt) => attempt > 5 });
    const client = makeFakeClient([
      { id: "openai", models: { model: { limit: { context: 1000 } } } },
    ]);
    const event = messageUpdatedEvent({ modelID: "model", tokens: { input: 100 } });

    await plugin.__test.handleContextUsageEvent(event, { client: client.client, instanceToken: 1 });
    await plugin.__test.handleContextUsageEvent(event, { client: client.client, instanceToken: 1 });

    assert.strictEqual(failingThenHealthy.posted.filter((call) => call.accepted).length, 1);
    assert.strictEqual(client.calls.providerList, 1, "the positive limit may be reused, but the sample must replay");
    failingThenHealthy.restore();
  });

  it("invalidates an old lookup when a session is deleted and recreated", async () => {
    const plugin = makePlugin();
    const lookup = makeDeferredClient();
    const oldLookup = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ tokens: { input: 100 } }),
      { client: lookup.client, instanceToken: 1 }
    );

    plugin.__test.cleanupContextState(new Set(["opencode:ses_abc"]), { instanceToken: 1 });
    const reopenedLookup = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ tokens: { input: 50 } }),
      { client: lookup.client, instanceToken: 1 }
    );
    assert.strictEqual(lookup.pending.length, 2);

    lookup.pending[1].resolve(sdkProviderResult([
      { id: "openai", models: { "deepseek-v4": { limit: { context: 1000 } } } },
    ]));
    await reopenedLookup;
    lookup.pending[0].resolve(sdkProviderResult([
      { id: "openai", models: { "deepseek-v4": { limit: { context: 1000 } } } },
    ]));
    await oldLookup;

    assert.deepStrictEqual(
      stub.posted.filter((call) => call.accepted).map((call) => call.body.context_usage.used),
      [50]
    );
    const state = plugin.__test._contextStateByInstance.get(1).get("opencode:ses_abc");
    assert.strictEqual(state.delivered.used, 50);
  });

  it("disposal clears only the disposed instance's context generations", async () => {
    const plugin = makePlugin();
    const a = makeDeferredClient();
    const b = makeDeferredClient();
    const oldA = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ sessionID: "ses_a", tokens: { input: 10 } }),
      { client: a.client, instanceToken: 1 }
    );
    const liveB = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ sessionID: "ses_b", tokens: { input: 20 } }),
      { client: b.client, instanceToken: 2 }
    );
    plugin.__test.cleanupContextState(new Set(["opencode:ses_a"]), {
      instanceToken: 1,
      clearInstance: true,
    });

    const provider = [{ id: "openai", models: { "deepseek-v4": { limit: { context: 1000 } } } }];
    b.pending[0].resolve(sdkProviderResult(provider));
    await liveB;
    a.pending[0].resolve(sdkProviderResult(provider));
    await oldA;

    assert.deepStrictEqual(
      stub.posted.filter((call) => call.accepted).map((call) => call.body.session_id),
      ["opencode:ses_b"]
    );
    assert.strictEqual(plugin.__test._contextStateByInstance.has(1), false);
    assert.strictEqual(plugin.__test._contextStateByInstance.has(2), true);
  });

  it("keeps context reporting explicitly OpenCode-only until MiMo has a proven contract", async () => {
    const plugin = core.createOpencodeFamilyPlugin(MIMOCODE_PARAMS);
    plugin.__test._cachedPort = 23333;
    const client = makeFakeClient([
      { id: "mimo", models: { model: { limit: { context: 1000 } } } },
    ]);

    await plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ tokens: { input: 100 } }),
      { client: client.client, instanceToken: 1 }
    );
    assert.strictEqual(stub.posted.length, 0);
  });

  it("keeps per-session dedup state independent across sessions", async () => {
    const plugin = makePlugin();
    await drive(plugin, messageUpdatedEvent({ sessionID: "ses_a", tokens: { input: 1000 } }));
    await drive(plugin, messageUpdatedEvent({ sessionID: "ses_b", tokens: { input: 1000 } }));
    assert.strictEqual(stub.posted.length, 2, "same used on different sessions must both post");
    assert.strictEqual(stub.posted[0].body.session_id, "opencode:ses_a");
    assert.strictEqual(stub.posted[1].body.session_id, "opencode:ses_b");
  });

  it("fails closed on token-less or malformed events — no dedup entry, no POST", async () => {
    const plugin = makePlugin();
    await drive(plugin, messageUpdatedEvent({ tokens: {} }));
    await drive(plugin, messageUpdatedEvent()); // no tokens key at all
    await drive(plugin, { type: "message.updated", properties: { sessionID: "ses_x", info: {} } });
    await drive(plugin, null);
    assert.strictEqual(stub.posted.length, 0);
    assert.strictEqual(plugin.__test._lastContextUsageBySession.size, 0);
  });

  it("builds a metadata_only body without lifecycle fields (buildContextUsageBody)", () => {
    const plugin = makePlugin();
    const body = plugin.__test.buildContextUsageBody("opencode:ses_abc", 3100, 128000);
    assert.deepStrictEqual(body, {
      agent_id: "opencode",
      hook_source: "opencode-plugin",
      session_id: "opencode:ses_abc",
      metadata_only: true,
      context_usage: { used: 3100, limit: 128000, source: "opencode" },
    });
    const noLimit = plugin.__test.buildContextUsageBody("opencode:ses_abc", 3100, null);
    assert.deepStrictEqual(noLimit.context_usage, { used: 3100, limit: null, source: "opencode" });
  });
});
