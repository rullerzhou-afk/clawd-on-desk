"use strict";

// #1006: exercise the Node plugin and the real route/state acceptance contract.
// Only the OpenCode SDK history and the in-process HTTP transport are fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { syncBuiltinESMExports } = require("node:module");
const { pathToFileURL } = require("node:url");
const { before, after, it, mock } = require("node:test");
const { handleStatePost } = require("../src/server-route-state");
const { makeSessionKey } = require("../src/session-key");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-hydration-scheduling-"));
const directory = path.join(TEMP_DIR, "project");
const originalFetch = globalThis.fetch;
const originalBun = globalThis.Bun;
let createOpencodeFamilyPlugin;
themeLoader.init(path.join(__dirname, "..", "src"));
const theme = themeLoader.loadTheme("clawd");

before(async () => {
  mock.method(os, "homedir", () => TEMP_DIR);
  syncBuiltinESMExports();
  delete globalThis.Bun;
  const runtimeDir = path.join(TEMP_DIR, ".clawd");
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  fs.writeFileSync(path.join(runtimeDir, "runtime.json"), JSON.stringify({
    app: "clawd-on-desk", port: 23333, ownerPid: process.pid,
  }), { mode: 0o600 });
  ({ createOpencodeFamilyPlugin } = await import(pathToFileURL(
    path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs")
  ).href));
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalBun === undefined) delete globalThis.Bun;
  else globalThis.Bun = originalBun;
  mock.restoreAll();
  syncBuiltinESMExports();
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function history(id, used = 320) {
  return { info: {
    id: `msg_${id}`, sessionID: id, role: "assistant",
    time: { created: 1, completed: 2 }, providerID: "fixture", modelID: "model",
    tokens: { input: used },
  }, parts: [] };
}

const key = (id) => makeSessionKey({ profileId: "local", rawSessionId: `opencode:${id}` });
const status = (id) => ({ type: "session.status", properties: { sessionID: id, status: { type: "busy" } } });
const select = (id) => ({ type: "tui.session.select", properties: { sessionID: id } });

async function settle(plugin) {
  // All fixtures resolve without wall-clock I/O. Flush microtasks, route events
  // and the serialized POST queues, without emitting a second resume signal.
  await flushTurns();
  await Promise.all([...plugin.__test._statePostTailBySession.values()]);
}

async function flushTurns() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function setup(t, { list, messages = async ({ path: p }) => ({ data: [history(p.id)] }) } = {}) {
  const noop = () => {};
  const ctx = {
    lang: "en", theme, doNotDisturb: false, miniTransitioning: false, miniMode: false,
    mouseOverPet: false, idlePaused: false, forceEyeResend: false, eyePauseUntil: 0,
    mouseStillSince: Date.now(), playSound: noop, sendToRenderer: noop, syncHitWin: noop,
    sendToHitWin: noop, buildContextMenu: noop, buildTrayMenu: noop, pendingPermissions: [],
    getCursorScreenPoint: () => ({ x: 0, y: 0 }), isAgentEnabled: () => true,
    permLog: noop, resolvePermissionEntry: noop,
  };
  const api = initState(ctx);
  Object.assign(ctx, api);
  const posts = [];
  const queries = [];
  let active = 0;
  let peak = 0;
  const responseGates = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const req = new EventEmitter();
    req.headers = {};
    const record = { body };
    posts.push(record);
    const response = await new Promise((resolve) => {
      let code;
      let headers;
      const res = {
        writeHead(statusCode, values) { code = statusCode; headers = values; },
        end() {
          record.status = code;
          record.accepted = headers["X-Clawd-Metadata-Accepted"] === "1"
            || headers["x-clawd-metadata-accepted"] === "1";
          resolve({ status: code, headers: new Headers(headers), text: async () => "" });
        },
      };
      handleStatePost(req, res, {
        ctx, createRequestHookRecorder: () => ({
          acceptedUnlessDnd: noop, droppedByDisabled: noop, droppedByDnd: noop,
          droppedInvalidAgent: noop, droppedUnsupported: noop,
        }), shouldDropForDnd: () => false, codexOfficialTurns: new Map(), isWinHost: false,
      });
      setImmediate(() => { req.emit("data", Buffer.from(options.body)); req.emit("end"); });
    });
    const gate = responseGates.find((candidate) => candidate.match(record));
    if (gate) { gate.match = () => false; await gate.promise; }
    return response;
  };
  const client = {
    _client: { post: async () => ({ data: {} }) },
    session: {
      messages: async (options) => {
        queries.push(options);
        active++;
        peak = Math.max(peak, active);
        try { return await messages(options); } finally { active--; }
      },
      ...(list ? { list: async () => typeof list === "function" ? list() : ({ data: list }) } : {}),
    },
    provider: { list: async () => ({ data: { all: [
      { id: "fixture", models: { model: { limit: { context: 1000 } } } },
    ] } }) },
  };
  const plugin = createOpencodeFamilyPlugin({
    agentId: "opencode", hookSource: "opencode-plugin", sessionIdPrefix: "opencode:",
    logFileName: "opencode-plugin.log",
  });
  const hooks = await plugin({ directory, client });
  const instances = [hooks];
  t.after(async () => {
    for (const gate of responseGates) gate.resolve();
    for (const instance of instances) await instance.dispose();
    await settle(plugin);
    await plugin.__test.closeBridgeForTest();
    await plugin.__test.flushDebugLog();
    api.cleanup();
  });
  assert.equal(plugin.__test._bridgeRuntime, "node");
  return {
    plugin, hooks, api, client, posts, queries, responseGates, instances,
    peak: () => peak,
    usage: (id) => api.sessions.get(key(id))?.contextUsage ?? undefined,
    emit: (event) => hooks.event({ event }),
    seed: (id) => api.updateSession(key(id), "working", "PreToolUse", {
      cwd: directory, agentId: "opencode", profileId: "local", rawSessionId: `opencode:${id}`,
    }),
  };
}

it("counts an in-flight bootstrap list against the same four-request capacity", async (t) => {
  const listGate = deferred();
  const messagesGate = deferred();
  const h = await setup(t, {
    list: () => listGate.promise,
    messages: async ({ path: p }) => { await messagesGate.promise; return { data: [history(p.id)] }; },
  });
  t.after(() => { listGate.resolve({ data: [] }); messagesGate.resolve(); });
  for (let i = 0; i < 4; i++) await h.emit(status(`s${i}`));
  await settle(h.plugin);
  assert.equal(h.queries.length, 3, "the list still owns one slot");
  listGate.resolve({ data: [] });
  await settle(h.plugin);
  assert.equal(h.queries.length, 4);
  messagesGate.resolve();
  await settle(h.plugin);
  assert.equal(h.usage("s3")?.used, 320);
});

it("an explicit selection precedes unserved bootstrap candidates", async (t) => {
  const gate = deferred();
  const h = await setup(t, {
    list: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, directory, time: { updated: 10 - i } })),
    messages: async ({ path: p }) => {
      if (Number(p.id.slice(1)) < 4) await gate.promise;
      return { data: [history(p.id)] };
    },
  });
  t.after(() => gate.resolve());
  await settle(h.plugin);
  h.seed("s9");
  await h.emit(select("s9"));
  gate.resolve();
  await settle(h.plugin);
  assert.equal(h.queries[4].path.id, "s9");
  assert.equal(h.queries.length, 10);
  assert.equal(h.usage("s9")?.used, 320);
});

it("a timed-out read releases capacity and cannot publish its late result", async (t) => {
  const gate = deferred();
  const h = await setup(t, { messages: async ({ path: p }) => {
    if (p.id !== "waiting") await gate.promise; // Deliberately ignores AbortSignal.
    return { data: [history(p.id)] };
  } });
  t.after(() => gate.resolve());
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  for (let i = 0; i < 4; i++) await h.emit(status(`busy${i}`));
  await h.emit(status("waiting"));
  await settle(h.plugin);
  assert.equal(h.queries.length, 4);
  t.mock.timers.tick(2001);
  await settle(h.plugin);
  assert.equal(h.usage("waiting")?.used, 320);
  assert.ok(h.queries.slice(0, 4).every((q) => q.signal.aborted));
  gate.resolve();
  await settle(h.plugin);
  for (let i = 0; i < 4; i++) assert.equal(h.usage(`busy${i}`), undefined);
});

it("a new generation discards the cached predecessor and hydrates fresh history", async (t) => {
  let used = 900;
  const h = await setup(t, {
    list: [{ id: "reused", directory }],
    messages: async ({ path: p }) => ({ data: [history(p.id, used)] }),
  });
  await settle(h.plugin);
  assert.equal(h.api.sessions.size, 0);
  used = 50;
  await h.emit({ type: "session.created", properties: { info: { id: "reused", directory } } });
  await settle(h.plugin);
  assert.equal(h.usage("reused")?.used, 50);
  assert.equal(h.queries.length, 2);
  assert.ok(!h.posts.some((p) => p.accepted && p.body.context_usage?.used === 900));
});

it("disposal clears one instance's pending work without affecting another client/directory", async (t) => {
  const gate = deferred();
  const h = await setup(t, { messages: async ({ path: p }) => {
    await gate.promise; return { data: [history(p.id)] };
  } });
  t.after(() => gate.resolve());
  for (let i = 0; i < 5; i++) await h.emit(select(`first${i}`));
  const otherQueries = [];
  const otherDirectory = path.join(TEMP_DIR, "other-project");
  const second = await h.plugin({ directory: otherDirectory, client: {
    ...h.client,
    session: { messages: async (options) => {
      otherQueries.push(options);
      await gate.promise;
      return { data: [history(options.path.id, 50)] };
    } },
  } });
  h.instances.push(second);
  for (let i = 0; i < 5; i++) {
    await second.event({ event: status(`second${i}`) });
  }
  await settle(h.plugin);
  assert.equal(h.queries.length, 4);
  assert.equal(otherQueries.length, 4);
  await h.hooks.dispose();
  gate.resolve();
  await settle(h.plugin);
  assert.equal(h.queries.length, 4);
  assert.equal(otherQueries.length, 5);
  assert.ok(otherQueries.every((q) => q.query.directory === otherDirectory));
  assert.equal(h.usage("second4")?.used, 50);
  assert.equal(h.plugin.__test._contextStateByInstance.size, 1);
});

it("bounds retained intents and evicts unserved bootstrap work before recent selections", async (t) => {
  const gate = deferred();
  const h = await setup(t, {
    list: Array.from({ length: 20 }, (_, i) => ({ id: `bootstrap${i}`, directory, time: { updated: 20 - i } })),
    messages: async ({ path: p }) => { await gate.promise; return { data: [history(p.id)] }; },
  });
  t.after(() => gate.resolve());
  await settle(h.plugin);
  // Synchronous burst: capacity stays occupied while intents reach their cap.
  for (let i = 0; i < 1010; i++) void h.emit(select(`selected${i}`));
  const states = [...h.plugin.__test._contextStateByInstance.values()][0];
  assert.equal(states.size, 1024);
  assert.equal([...states.values()].filter((state) => state.pendingHydration).length, 1020);
  assert.ok(states.has("opencode:selected0"));
  assert.ok(states.has("opencode:selected1009"));
  assert.equal(states.has("opencode:bootstrap4"), false);
  assert.equal(h.queries.length, 4);
  // Cancel instead of actually querying a thousand fixture sessions.
  await h.hooks.dispose();
  gate.resolve();
  await settle(h.plugin);
  assert.equal(h.queries.length, 4);
  assert.equal(h.plugin.__test._contextStateByInstance.size, 0);
});

it("control: hydrates after the first normal lifecycle event through the real route", async (t) => {
  const h = await setup(t);
  await h.emit(status("control"));
  await settle(h.plugin);
  assert.equal(h.usage("control")?.used, 320);
  assert.deepEqual(h.posts.map((p) => p.body.metadata_only === true), [false, true]);
  assert.equal(h.posts.at(-1).accepted, true);
});

it("replays unaccepted bootstrap context after one lifecycle event inside the cooldown", async (t) => {
  const h = await setup(t, { list: [{ id: "late", directory }] });
  await settle(h.plugin);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].status, 204);
  assert.equal(h.posts[0].accepted, false);
  assert.equal(h.api.sessions.size, 0, "bootstrap must not create a session");
  await h.emit(status("late"));
  await settle(h.plugin);
  assert.equal(h.api.sessions.size, 1);
  assert.equal(h.usage("late")?.used, 320, "one lifecycle signal must recover the undelivered sample");
  assert.equal(h.queries.length, 1, "replay does not need another history read");
});

it("serves the selected fifth bootstrap session when a history slot is freed", async (t) => {
  const gate = deferred();
  const ids = ["one", "two", "three", "four", "five"];
  const h = await setup(t, {
    list: ids.map((id, i) => ({ id, directory, time: { updated: 10 - i } })),
    messages: async ({ path: p }) => {
      if (p.id !== "five") await gate.promise;
      return { data: [history(p.id)] };
    },
  });
  t.after(() => gate.resolve());
  await settle(h.plugin);
  assert.equal(h.queries.length, 4);
  h.seed("five");
  await h.emit(select("five"));
  assert.equal(h.queries.length, 4);
  gate.resolve();
  await settle(h.plugin);
  assert.equal(h.usage("five")?.used, 320, "the original selection must survive full capacity");
  assert.deepEqual(h.queries.map((q) => q.path.id), ids);
  assert.equal(h.peak(), 4);
});

it("retains a lifecycle signal while the unaccepted bootstrap POST is still pending", async (t) => {
  const h = await setup(t, { list: [{ id: "late", directory }] });
  const gate = { ...deferred(), match: (p) => p.body.metadata_only };
  h.responseGates.push(gate);
  await flushTurns();
  assert.equal(h.posts[0].accepted, false);
  await h.emit(status("late"));
  gate.resolve();
  await settle(h.plugin);
  assert.equal(h.usage("late")?.used, 320);
  assert.equal(h.queries.length, 1);
});

it("drains capacity-blocked event requests without bootstrap or another event", async (t) => {
  const gate = deferred();
  const h = await setup(t, { messages: async ({ path: p }) => {
    if (Number(p.id.slice(1)) < 4) await gate.promise;
    return { data: [history(p.id)] };
  } });
  t.after(() => gate.resolve());
  for (let i = 0; i < 10; i++) {
    h.seed(`s${i}`);
    await h.emit(select(`s${i}`));
    await h.emit(select(`s${i}`));
  }
  await settle(h.plugin);
  assert.equal(h.queries.length, 4);
  gate.resolve();
  await settle(h.plugin);
  assert.equal(h.queries.length, 10);
  assert.equal(new Set(h.queries.map((q) => q.path.id)).size, 10);
  assert.equal(h.usage("s9")?.used, 320);
  assert.equal(h.peak(), 4);
});

it("services one signal retained during SDK failure cooldown without polling forever", async (t) => {
  let fail = true;
  const h = await setup(t, { messages: async ({ path: p }) => {
    if (fail) throw new Error("offline");
    return { data: [history(p.id)] };
  } });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  await h.emit(status("retry"));
  await settle(h.plugin);
  await h.emit(select("retry"));
  await settle(h.plugin);
  assert.equal(h.queries.length, 1);
  t.mock.timers.tick(30_001);
  await settle(h.plugin);
  assert.equal(h.queries.length, 2, "the retained signal must wake once at cooldown expiry");
  t.mock.timers.tick(90_000);
  await settle(h.plugin);
  assert.equal(h.queries.length, 2, "a failed retry must not create a recurring poll");
  fail = false;
  await h.emit(select("retry"));
  await settle(h.plugin);
  assert.equal(h.usage("retry")?.used, 320);
});

const terminal = (kind, id) => kind === "session.deleted"
  ? { type: kind, properties: { info: { id, directory } } }
  : { type: kind, properties: { directory } };

for (const kind of ["session.deleted", "server.instance.disposed", "dispose"]) {
  it(`cancels a capacity-blocked selection on ${kind}`, async (t) => {
    const gate = deferred();
    const h = await setup(t, { messages: async ({ path: p }) => {
      if (p.id !== "waiting") await gate.promise;
      return { data: [history(p.id)] };
    } });
    t.after(() => gate.resolve());
    for (let i = 0; i < 4; i++) await h.emit(select(`busy${i}`));
    await h.emit(select("waiting"));
    if (kind === "dispose") await h.hooks.dispose();
    else await h.emit(terminal(kind, "waiting"));
    gate.resolve();
    await settle(h.plugin);
    assert.ok(!h.queries.some((q) => q.path.id === "waiting"));
    assert.equal(h.usage("waiting"), undefined);
  });

  it(`clears an unaccepted sample and a cooldown wakeup on ${kind}`, async (t) => {
    const h = await setup(t, { list: [{ id: "cached", directory }], messages: async ({ path: p }) => {
      if (p.id === "retry") throw new Error("offline");
      return { data: [history(p.id)] };
    } });
    await settle(h.plugin);
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    await h.emit(select("retry"));
    await settle(h.plugin);
    await h.emit(select("retry"));
    if (kind === "dispose") await h.hooks.dispose();
    else {
      await h.emit(terminal(kind, "cached"));
      if (kind === "session.deleted") await h.emit(terminal(kind, "retry"));
    }
    await settle(h.plugin);
    const count = h.queries.length;
    t.mock.timers.tick(31_000);
    await settle(h.plugin);
    assert.equal(h.queries.length, count);
    assert.equal(h.plugin.__test._contextStateByInstance.size, 0);
    assert.ok(h.posts.filter((p) => p.body.metadata_only).every((p) => !p.accepted));
  });
}

for (const used of [50, 0]) {
  it(`new live context (${used} tokens) invalidates a selection waiting for capacity`, async (t) => {
    const gate = deferred();
    const h = await setup(t, { messages: async ({ path: p }) => {
      if (p.id !== "waiting") await gate.promise;
      return { data: [history(p.id, 900)] };
    } });
    t.after(() => gate.resolve());
    for (let i = 0; i < 4; i++) await h.emit(select(`busy${i}`));
    h.seed("waiting");
    await h.emit(select("waiting"));
    await h.emit({ type: "message.updated", properties: { info: history("waiting", used).info } });
    gate.resolve();
    await settle(h.plugin);
    assert.ok(!h.queries.some((q) => q.path.id === "waiting"));
    assert.equal(h.usage("waiting")?.used, used || undefined);
  });

  it(`new live context (${used} tokens) invalidates cached replay behind a slow lifecycle POST`, async (t) => {
    const h = await setup(t, { list: [{ id: "late", directory }] });
    await settle(h.plugin);
    const gate = { ...deferred(), match: (p) => !p.body.metadata_only };
    h.responseGates.push(gate);
    await h.emit(status("late"));
    await flushTurns();
    await h.emit({ type: "message.updated", properties: { info: history("late", used).info } });
    gate.resolve();
    await settle(h.plugin);
    assert.equal(h.usage("late")?.used, used || undefined);
    assert.ok(!h.posts.some((p) => p.accepted && p.body.context_usage?.used === 320));
  });
}

for (const titleFirst of [false, true]) {
  it(`preserves a title merged ${titleFirst ? "before" : "after"} a stale cached context replay`, async (t) => {
    const h = await setup(t, { list: [{ id: "late", directory }] });
    await settle(h.plugin);
    const gate = { ...deferred(), match: (p) => !p.body.metadata_only };
    h.responseGates.push(gate);
    const lifecycle = h.emit(status("late"));
    if (!titleFirst) await flushTurns();
    await h.emit({ type: "session.updated", properties: { info: { id: "late", directory, title: "Renamed session" } } });
    await lifecycle;
    await flushTurns();
    await h.emit({ type: "message.updated", properties: { info: history("late", 0).info } });
    gate.resolve();
    await settle(h.plugin);
    assert.equal(h.usage("late"), undefined);
    assert.equal(h.api.sessions.get(key("late")).sessionTitle, "Renamed session");
    assert.ok(h.posts.some((p) => p.accepted && p.body.session_title === "Renamed session" && !p.body.context_usage));
  });
}
