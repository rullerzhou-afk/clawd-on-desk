// #830 — opencode-family context usage reporting (message.updated → /state
// metadata_only). Covers: extraction formula (component sum incl. reasoning,
// matching the host's Context view — no `total` on public message tokens),
// model-limit resolution via provider.list() (SDK envelope, keyed models map,
// unknown provider/model, failure, TTL cache), wire-body shape,
// assistant-role/zero-token gating, and per-session dedup driven through the
// real event hook handler.

const { describe, it, before, beforeEach, afterEach, after, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("path");
const { pathToFileURL } = require("node:url");

const ORIGINAL_HOME = {
  HOME: {
    present: Object.prototype.hasOwnProperty.call(process.env, "HOME"),
    value: process.env.HOME,
  },
  USERPROFILE: {
    present: Object.prototype.hasOwnProperty.call(process.env, "USERPROFILE"),
    value: process.env.USERPROFILE,
  },
};
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-context-usage-"));
fs.mkdirSync(path.join(TMP_HOME, ".clawd"), { recursive: true });
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const trackedPlugins = new Set();

function createTrackedPlugin(core, params) {
  const plugin = core.createOpencodeFamilyPlugin(params);
  trackedPlugins.add(plugin);
  return plugin;
}

function restoreEnv(name) {
  const original = ORIGINAL_HOME[name];
  if (original.present) process.env[name] = original.value;
  else delete process.env[name];
}

after(async () => {
  try {
    await Promise.all([...trackedPlugins].map((plugin) => plugin.__test.flushDebugLog()));
  } finally {
    try {
      fs.rmSync(TMP_HOME, { recursive: true, force: true });
    } finally {
      restoreEnv("HOME");
      restoreEnv("USERPROFILE");
    }
  }
});

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

async function waitFor(predicate, message, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function makeSeedThenDeferredClient(seedProviders) {
  const pending = [];
  const calls = { providerList: 0 };
  const list = () => {
    calls.providerList += 1;
    if (calls.providerList === 1) return Promise.resolve(sdkProviderResult(seedProviders));
    const gate = deferred();
    pending.push(gate);
    return gate.promise;
  };
  return { client: { provider: { list } }, calls, pending };
}

// Captures every POST the plugin makes (headers carry the Clawd identity the
// port-discovery loop requires before trusting the port).
function installFetchStub({
  recognized = () => true,
  metadataAccepted = (_attempt, call) => call.body.metadata_only === true,
  beforeRespond = async () => {},
} = {}) {
  const posted = [];
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    attempts += 1;
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    const call = posted.at(-1);
    await beforeRespond(attempts, call);
    const isRecognized = recognized(attempts, call);
    const isMetadataAccepted = isRecognized
      && call.body.metadata_only === true
      && metadataAccepted(attempts, call);
    call.recognized = isRecognized;
    call.metadataAccepted = isMetadataAccepted;
    const responseHeaders = {
      ...(isRecognized ? { "x-clawd-server": "clawd-on-desk" } : {}),
      ...(isMetadataAccepted ? { "x-clawd-metadata-accepted": "1" } : {}),
    };
    return {
      status: isRecognized ? (call.body.metadata_only === true ? 204 : 200) : 503,
      headers: { get: (name) => responseHeaders[String(name).toLowerCase()] || null },
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
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
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
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
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
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
    const { client } = makeFakeClient([
      { id: "openai", models: new Map([["deepseek-v4", { limit: { context: 128000 } }]]) },
    ]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "deepseek-v4", client), 128000);
  });

  it("fails closed when only provider.options.limit is present", async () => {
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
    const { client } = makeFakeClient([
      { id: "legacy", options: { limit: 240000 } },
    ]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("legacy", "any-model", client), null);
  });

  it("unwraps the live CLI envelope { all: [...] } (SDK ProviderListResponses)", async () => {
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
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
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
    const { client } = makeFakeClient(
      [{ id: "openai", models: { "deepseek-v4": { limit: { context: 128000 } } } }],
      { envelope: "providers" }
    );
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "deepseek-v4", client), 128000);
  });

  it("accepts an array-shaped models collection inside a supported provider payload", async () => {
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
    const { client } = makeFakeClient([
      { id: "openai", models: [{ id: "deepseek-v4", limit: { context: 64000 } }] },
    ]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "deepseek-v4", client), 64000);
  });

  it("returns null for unknown providers/models and never throws on provider failure", async () => {
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
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
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
    const { client, calls } = makeFakeClient([
      { id: "openai", models: { "cached-model": { limit: { context: 96000 } } } },
    ]);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "cached-model", client), 96000);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "cached-model", client), 96000);
    assert.strictEqual(calls.providerList, 1, "second call must hit the cache");
  });

  it("scopes the cache to the SDK client, not only provider/model ids", async () => {
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
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
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
    const client = makeSequenceClient([
      sdkProviderResult([{ id: "openai", models: {} }]),
      sdkProviderResult([{ id: "openai", models: { model: { limit: { context: 64000 } } } }]),
    ]);

    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "model", client.client), null);
    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "model", client.client), 64000);
    assert.strictEqual(client.calls.providerList, 2);
  });

  it("keeps the latest-started same-key lookup in cache when an older lookup resolves last", async () => {
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
    const lookup = makeDeferredClient();
    const older = plugin.__test.resolveContextLimit("openai", "model", lookup.client);
    const newer = plugin.__test.resolveContextLimit("openai", "model", lookup.client);
    assert.strictEqual(lookup.pending.length, 2);

    lookup.pending[1].resolve(sdkProviderResult([
      { id: "openai", models: { model: { limit: { context: 2000 } } } },
    ]));
    assert.strictEqual(await newer, 2000);
    lookup.pending[0].resolve(sdkProviderResult([
      { id: "openai", models: { model: { limit: { context: 1000 } } } },
    ]));
    assert.strictEqual(await older, 1000, "a stale caller may still receive its own lookup result");

    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "model", lookup.client), 2000);
    assert.strictEqual(lookup.calls.providerList, 2, "the stale completion must not overwrite the newer cache entry");
  });

  it("caches the latest-started lookup when it also resolves last", async () => {
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
    const lookup = makeDeferredClient();
    const older = plugin.__test.resolveContextLimit("openai", "model", lookup.client);
    const newer = plugin.__test.resolveContextLimit("openai", "model", lookup.client);

    lookup.pending[0].resolve(sdkProviderResult([
      { id: "openai", models: { model: { limit: { context: 1000 } } } },
    ]));
    assert.strictEqual(await older, 1000);
    lookup.pending[1].resolve(sdkProviderResult([
      { id: "openai", models: { model: { limit: { context: 2000 } } } },
    ]));
    assert.strictEqual(await newer, 2000);

    assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "model", lookup.client), 2000);
    assert.strictEqual(lookup.calls.providerList, 2);
  });

  it("fences reverse completions after a positive cache entry expires", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1738400000000 });
    try {
      const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
      const lookup = makeSeedThenDeferredClient([
        { id: "openai", models: { model: { limit: { context: 1000 } } } },
      ]);
      assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "model", lookup.client), 1000);

      mock.timers.tick(60001);
      const older = plugin.__test.resolveContextLimit("openai", "model", lookup.client);
      const newer = plugin.__test.resolveContextLimit("openai", "model", lookup.client);
      assert.strictEqual(lookup.pending.length, 2);
      lookup.pending[1].resolve(sdkProviderResult([
        { id: "openai", models: { model: { limit: { context: 2000 } } } },
      ]));
      assert.strictEqual(await newer, 2000);
      lookup.pending[0].resolve(sdkProviderResult([
        { id: "openai", models: { model: { limit: { context: 1000 } } } },
      ]));
      assert.strictEqual(await older, 1000);

      assert.strictEqual(await plugin.__test.resolveContextLimit("openai", "model", lookup.client), 2000);
      assert.strictEqual(lookup.calls.providerList, 3, "seed + A + B only; the final read must be cached");
    } finally {
      mock.timers.reset();
    }
  });

  it("does not let an older positive lookup write behind a newer null result", async () => {
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
    const lookup = makeDeferredClient();
    const older = plugin.__test.resolveContextLimit("openai", "model", lookup.client);
    const newer = plugin.__test.resolveContextLimit("openai", "model", lookup.client);

    lookup.pending[1].resolve(sdkProviderResult([{ id: "openai", models: {} }]));
    assert.strictEqual(await newer, null);
    lookup.pending[0].resolve(sdkProviderResult([
      { id: "openai", models: { model: { limit: { context: 1000 } } } },
    ]));
    assert.strictEqual(await older, 1000);

    const retry = plugin.__test.resolveContextLimit("openai", "model", lookup.client);
    assert.strictEqual(lookup.pending.length, 3, "the newer null must leave the key retryable");
    lookup.pending[2].resolve(sdkProviderResult([
      { id: "openai", models: { model: { limit: { context: 3000 } } } },
    ]));
    assert.strictEqual(await retry, 3000);
    assert.strictEqual(lookup.calls.providerList, 3);
  });

  it("does not let an older positive lookup write behind a newer throw", async () => {
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
    const lookup = makeDeferredClient();
    const older = plugin.__test.resolveContextLimit("openai", "model", lookup.client);
    const newer = plugin.__test.resolveContextLimit("openai", "model", lookup.client);

    lookup.pending[1].reject(new Error("newer lookup failed"));
    assert.strictEqual(await newer, null);
    lookup.pending[0].resolve(sdkProviderResult([
      { id: "openai", models: { model: { limit: { context: 1000 } } } },
    ]));
    assert.strictEqual(await older, 1000);

    const retry = plugin.__test.resolveContextLimit("openai", "model", lookup.client);
    assert.strictEqual(lookup.pending.length, 3, "the newer throw must leave the key retryable");
    lookup.pending[2].resolve(sdkProviderResult([
      { id: "openai", models: { model: { limit: { context: 4000 } } } },
    ]));
    assert.strictEqual(await retry, 4000);
    assert.strictEqual(lookup.calls.providerList, 3);
  });

  it("keeps concurrent cache-write fences independent across provider/model keys", async () => {
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
    const lookup = makeDeferredClient();
    const a = plugin.__test.resolveContextLimit("provider-a", "model-a", lookup.client);
    const b = plugin.__test.resolveContextLimit("provider-b", "model-b", lookup.client);
    lookup.pending[1].resolve(sdkProviderResult([
      { id: "provider-b", models: { "model-b": { limit: { context: 2000 } } } },
    ]));
    lookup.pending[0].resolve(sdkProviderResult([
      { id: "provider-a", models: { "model-a": { limit: { context: 1000 } } } },
    ]));
    assert.strictEqual(await a, 1000);
    assert.strictEqual(await b, 2000);
    assert.strictEqual(await plugin.__test.resolveContextLimit("provider-a", "model-a", lookup.client), 1000);
    assert.strictEqual(await plugin.__test.resolveContextLimit("provider-b", "model-b", lookup.client), 2000);
    assert.strictEqual(lookup.calls.providerList, 2);
  });
});

describe("opencode-family contextUsage wire path (handleContextUsageEvent)", () => {
  let core;
  let stub;
  beforeEach(async () => { core = await loadCore(); stub = installFetchStub(); });
  afterEach(() => { stub.restore(); });

  function makePlugin() {
    const plugin = createTrackedPlugin(core, OPENCODE_PARAMS);
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

  it("writes reproducible resolved-limit evidence only inside the temporary HOME", async () => {
    const plugin = makePlugin();
    const event = messageUpdatedEvent({
      sessionID: "ses_log_evidence",
      tokens: { input: 321 },
    });
    event.properties.info.messageText = "SECRET_MESSAGE_BODY_MUST_NOT_BE_LOGGED";
    await drive(plugin, event);
    await plugin.__test.flushDebugLog();

    assert.ok(
      path.resolve(plugin.__test._debugLogPath).startsWith(path.resolve(TMP_HOME) + path.sep),
      plugin.__test._debugLogPath
    );
    const log = fs.readFileSync(plugin.__test._debugLogPath, "utf8");
    assert.match(
      log,
      /CTX resolved used=321 limit=128000 session=opencode:ses_log_evidence /,
      "manual evidence must contain both used and resolved limit"
    );
    assert.doesNotMatch(log, /SECRET_MESSAGE_BODY_MUST_NOT_BE_LOGGED/);
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

  it("uses an explicit top-level event.sessionID when the properties shapes omit it", async () => {
    const plugin = makePlugin();
    const event = messageUpdatedEvent({ sessionID: null, tokens: { input: 100 } });
    event.sessionID = "ses_top_level";
    await drive(plugin, event);

    assert.strictEqual(stub.posted.length, 1);
    assert.strictEqual(stub.posted[0].body.session_id, "opencode:ses_top_level");
  });

  it("fails closed on a token-bearing event without an explicit session id", async () => {
    const plugin = makePlugin();
    const client = makeFakeClient([
      { id: "openai", models: { "deepseek-v4": { limit: { context: 128000 } } } },
    ]);
    await plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ sessionID: null, tokens: { input: 100 } }),
      { client: client.client, instanceToken: 1 }
    );

    assert.strictEqual(client.calls.providerList, 0);
    assert.strictEqual(plugin.__test._contextStateByInstance.size, 0);
    assert.strictEqual(stub.posted.length, 0);
    plugin.__test.resetContextSession("ses_real", 1);
    assert.strictEqual(plugin.__test._contextStateByInstance.size, 0, "a later real session must not reveal an orphan default bucket");
  });

  it("never borrows a prior/root session for a token-bearing sessionless event", async () => {
    const plugin = makePlugin();
    plugin.__test._rootSessionId = "ses_previous";
    const client = makeFakeClient([
      { id: "openai", models: { "deepseek-v4": { limit: { context: 128000 } } } },
    ]);
    await plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ sessionID: null, tokens: { input: 100 } }),
      { client: client.client, instanceToken: 1 }
    );

    assert.strictEqual(client.calls.providerList, 0);
    assert.strictEqual(plugin.__test._contextStateByInstance.size, 0);
    assert.strictEqual(stub.posted.length, 0);
  });

  it("fails closed when assistant role is missing even with valid tokens and session id", async () => {
    const plugin = makePlugin();
    const client = makeFakeClient([
      { id: "openai", models: { "deepseek-v4": { limit: { context: 128000 } } } },
    ]);
    const event = messageUpdatedEvent({ tokens: { input: 100 } });
    delete event.properties.info.role;
    await plugin.__test.handleContextUsageEvent(
      event,
      { client: client.client, instanceToken: 1 }
    );

    assert.strictEqual(client.calls.providerList, 0);
    assert.strictEqual(plugin.__test._contextStateByInstance.size, 0);
    assert.strictEqual(stub.posted.length, 0);
  });

  it("never treats info.id as the message.updated session identity", async () => {
    const plugin = makePlugin();
    const event = messageUpdatedEvent({ sessionID: null, tokens: { input: 100 } });
    event.properties.info.id = "msg_not_a_session";
    const client = makeFakeClient([
      { id: "openai", models: { "deepseek-v4": { limit: { context: 128000 } } } },
    ]);
    await plugin.__test.handleContextUsageEvent(event, { client: client.client, instanceToken: 1 });

    assert.strictEqual(client.calls.providerList, 0);
    assert.strictEqual(plugin.__test._contextStateByInstance.size, 0);
    assert.strictEqual(stub.posted.length, 0);
  });

  it("fails closed on blank or non-string explicit session ids", async () => {
    const plugin = makePlugin();
    const client = makeFakeClient([
      { id: "openai", models: { "deepseek-v4": { limit: { context: 128000 } } } },
    ]);
    await plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ sessionID: "   ", tokens: { input: 100 } }),
      { client: client.client, instanceToken: 1 }
    );
    const nonString = messageUpdatedEvent({ sessionID: null, tokens: { input: 100 } });
    nonString.properties.sessionID = 42;
    await plugin.__test.handleContextUsageEvent(nonString, { client: client.client, instanceToken: 1 });

    assert.strictEqual(client.calls.providerList, 0);
    assert.strictEqual(plugin.__test._contextStateByInstance.size, 0);
    assert.strictEqual(stub.posted.length, 0);
  });

  it("rejects array-shaped info even when tokens and an external session id are valid", async () => {
    const plugin = makePlugin();
    const info = Object.assign([], {
      role: "assistant",
      providerID: "openai",
      modelID: "deepseek-v4",
      tokens: { input: 100 },
    });
    const client = makeFakeClient([
      { id: "openai", models: { "deepseek-v4": { limit: { context: 128000 } } } },
    ]);
    await plugin.__test.handleContextUsageEvent({
      type: "message.updated",
      properties: { sessionID: "ses_array", info },
    }, { client: client.client, instanceToken: 1 });

    assert.strictEqual(client.calls.providerList, 0);
    assert.strictEqual(plugin.__test._contextStateByInstance.size, 0);
    assert.strictEqual(stub.posted.length, 0);
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

  it("retries identical metadata until Clawd explicitly accepts it", async () => {
    stub.restore();
    let acceptMetadata = false;
    stub = installFetchStub({ metadataAccepted: () => acceptMetadata });
    const plugin = makePlugin();
    const client = makeFakeClient([
      { id: "openai", models: { model: { limit: { context: 1000 } } } },
    ]);
    const event = messageUpdatedEvent({ modelID: "model", tokens: { input: 100 } });

    await plugin.__test.handleContextUsageEvent(event, { client: client.client, instanceToken: 1 });
    await plugin.__test.handleContextUsageEvent(event, { client: client.client, instanceToken: 1 });
    assert.strictEqual(stub.posted.length, 2, "recognized/no-ack metadata must not advance the baseline");
    assert.strictEqual(stub.attempts, 2, "recognized/no-ack must stop scanning after the Clawd port");
    assert.strictEqual(
      plugin.__test._contextStateByInstance.get(1).get("opencode:ses_abc").delivered,
      null
    );

    acceptMetadata = true;
    await plugin.__test.handleContextUsageEvent(event, { client: client.client, instanceToken: 1 });
    await plugin.__test.handleContextUsageEvent(event, { client: client.client, instanceToken: 1 });
    assert.strictEqual(stub.posted.length, 3, "the first accepted retry becomes the stable dedup baseline");
    assert.strictEqual(
      plugin.__test._contextStateByInstance.get(1).get("opencode:ses_abc").delivered.used,
      100
    );
  });

  it("publishes only the newest sample when provider lookups resolve out of order", async () => {
    const plugin = makePlugin();
    const provider = [{ id: "openai", models: { model: { limit: { context: 1000 } } } }];
    const lookup = makeDeferredClient();
    const first = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ sessionID: "ses_stale_log", modelID: "model", tokens: { input: 100 } }),
      { client: lookup.client, instanceToken: 1 }
    );
    const second = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ sessionID: "ses_stale_log", modelID: "model", tokens: { input: 200 } }),
      { client: lookup.client, instanceToken: 1 }
    );
    assert.strictEqual(lookup.pending.length, 2);

    lookup.pending[1].resolve(sdkProviderResult(provider));
    await second;
    lookup.pending[0].resolve(sdkProviderResult(provider));
    await first;

    assert.deepStrictEqual(
      stub.posted.filter((call) => call.recognized).map((call) => call.body.context_usage.used),
      [200]
    );
    await plugin.__test.flushDebugLog();
    const log = fs.readFileSync(plugin.__test._debugLogPath, "utf8");
    assert.doesNotMatch(
      log,
      /CTX resolved used=100 .*session=opencode:ses_stale_log/,
      "a stale sample must not emit resolved-success evidence"
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
      stub.posted.filter((call) => call.recognized).map((call) => call.body.context_usage.used),
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
      stub.posted.filter((call) => call.recognized).map((call) => call.body.context_usage),
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
      stub.posted.filter((call) => call.recognized).map((call) => call.body.context_usage),
      [
        { used: 100, limit: null, source: "opencode" },
        { used: 100, limit: 1000, source: "opencode" },
      ]
    );
    assert.strictEqual(client.calls.providerList, 2);
  });

  it("does not advance the dedup baseline when the state delivery fails", async () => {
    const plugin = makePlugin();
    const failingThenHealthy = installFetchStub({ recognized: (attempt) => attempt > 5 });
    const client = makeFakeClient([
      { id: "openai", models: { model: { limit: { context: 1000 } } } },
    ]);
    const event = messageUpdatedEvent({ modelID: "model", tokens: { input: 100 } });

    await plugin.__test.handleContextUsageEvent(event, { client: client.client, instanceToken: 1 });
    await plugin.__test.handleContextUsageEvent(event, { client: client.client, instanceToken: 1 });

    assert.strictEqual(failingThenHealthy.posted.filter((call) => call.recognized).length, 1);
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
      stub.posted.filter((call) => call.recognized).map((call) => call.body.context_usage.used),
      [50]
    );
    const state = plugin.__test._contextStateByInstance.get(1).get("opencode:ses_abc");
    assert.strictEqual(state.delivered.used, 50);
  });

  it("cannot write an accepted old in-flight POST into a recreated context generation", async () => {
    stub.restore();
    const responseGate = deferred();
    let gateFirstResponse = true;
    stub = installFetchStub({
      beforeRespond: async () => {
        if (!gateFirstResponse) return;
        gateFirstResponse = false;
        await responseGate.promise;
      },
    });
    const plugin = makePlugin();
    const client = makeFakeClient([
      { id: "openai", models: { "deepseek-v4": { limit: { context: 1000 } } } },
    ]);
    const oldPost = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ tokens: { input: 100 } }),
      { client: client.client, instanceToken: 1 }
    );
    await waitFor(() => stub.posted.length === 1, "the old metadata POST did not enter the response gate");

    plugin.__test.cleanupContextState(new Set(["opencode:ses_abc"]), { instanceToken: 1 });
    const reopenedPost = plugin.__test.handleContextUsageEvent(
      messageUpdatedEvent({ tokens: { input: 50 } }),
      { client: client.client, instanceToken: 1 }
    );
    responseGate.resolve();
    await Promise.all([oldPost, reopenedPost]);

    assert.deepStrictEqual(stub.posted.map((call) => call.body.context_usage.used), [100, 50]);
    const state = plugin.__test._contextStateByInstance.get(1).get("opencode:ses_abc");
    assert.strictEqual(state.delivered.used, 50, "the accepted old response must not overwrite the new generation");
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
      stub.posted.filter((call) => call.recognized).map((call) => call.body.session_id),
      ["opencode:ses_b"]
    );
    assert.strictEqual(plugin.__test._contextStateByInstance.has(1), false);
    assert.strictEqual(plugin.__test._contextStateByInstance.has(2), true);
  });

  it("keeps context reporting explicitly OpenCode-only until MiMo has a proven contract", async () => {
    const plugin = createTrackedPlugin(core, MIMOCODE_PARAMS);
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
