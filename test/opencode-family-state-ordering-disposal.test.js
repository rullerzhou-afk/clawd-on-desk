"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, beforeEach, describe, it } = require("node:test");
const { pathToFileURL } = require("node:url");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-family-ordering-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
const runtimeDir = path.join(TMP_HOME, ".clawd");
fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
const runtimePath = path.join(runtimeDir, "runtime.json");
fs.writeFileSync(runtimePath, JSON.stringify({
  app: "clawd-on-desk",
  port: 23333,
  ownerPid: process.pid,
}), { mode: 0o600 });
if (process.platform !== "win32") fs.chmodSync(runtimePath, 0o600);

const CONFIG = Object.freeze({
  agentId: "opencode",
  hookSource: "opencode-plugin",
  logFileName: "opencode-plugin.log",
  sessionIdPrefix: "opencode:",
});

let createOpencodeFamilyPlugin;
let fetchImpl;
let bridgePort = 43000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeHeaders(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [String(name).toLowerCase(), value])
  );
  return { get: (name) => normalized[String(name).toLowerCase()] || null };
}

function clawdResponse(body = null, { metadataAccepted = body && body.metadata_only === true } = {}) {
  const metadata = !!(body && body.metadata_only === true);
  return {
    status: metadata ? 204 : 200,
    headers: fakeHeaders({
      "x-clawd-server": "clawd-on-desk",
      ...(metadataAccepted ? { "x-clawd-metadata-accepted": "1" } : {}),
    }),
    text: async () => "ok",
  };
}

function untrustedResponse() {
  return {
    status: 200,
    headers: fakeHeaders(),
    text: async () => "not-clawd",
  };
}

function parseFetchCall(url, opts) {
  return {
    url: String(url),
    body: opts && opts.body ? JSON.parse(opts.body) : null,
  };
}

function createContext(directory) {
  return {
    serverUrl: "http://127.0.0.1:1/",
    directory,
    client: {
      _client: {
        post: async () => ({ data: {} }),
      },
    },
  };
}

async function waitFor(predicate, message, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function waitForQueueEmpty(plugin) {
  await waitFor(
    () => plugin.__test._statePostTailBySession.size === 0,
    "state delivery queue did not drain"
  );
}

function applyStateBody(serverSessions, body) {
  const id = body.session_id;
  if (body.metadata_only) {
    if (!serverSessions.has(id)) return;
    const current = serverSessions.get(id);
    serverSessions.set(id, { ...current, title: body.session_title || current.title });
    return;
  }
  if (body.event === "SessionEnd") {
    serverSessions.delete(id);
    return;
  }
  const current = serverSessions.get(id) || {};
  serverSessions.set(id, {
    ...current,
    state: body.state,
    title: body.session_title || current.title,
  });
}

async function emit(hooks, event) {
  await hooks.event({ event });
}

function lifecycle(type, sessionID, directory, title, extraInfo = {}) {
  return {
    type,
    properties: {
      sessionID,
      info: { id: sessionID, directory, ...(title ? { title } : {}), ...extraInfo },
    },
  };
}

function metadataState(sessionID, fields) {
  return {
    state: "idle",
    session_id: sessionID,
    event: "SessionUpdate",
    agent_id: "opencode",
    hook_source: "opencode-plugin",
    metadata_only: true,
    ...fields,
  };
}

function contextMessage(sessionID, used) {
  return {
    type: "message.updated",
    properties: {
      sessionID,
      info: {
        role: "assistant",
        providerID: "openai",
        modelID: "synthetic-model",
        tokens: { input: used },
      },
    },
  };
}

before(async () => {
  globalThis.fetch = (...args) => fetchImpl(...args);
  globalThis.Bun = {
    serve(options) {
      bridgePort += 1;
      return { port: bridgePort, fetch: options.fetch };
    },
  };
  const modulePath = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
  ({ createOpencodeFamilyPlugin } = await import(pathToFileURL(modulePath).href));
});

beforeEach(() => {
  fetchImpl = async (url, opts) => {
    const call = parseFetchCall(url, opts);
    return clawdResponse(call.body);
  };
});

after(() => {
  delete globalThis.fetch;
  delete globalThis.Bun;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("opencode-family per-session /state FIFO", () => {
  it("never creates an orphan default context bucket before a real session is created", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooks = await plugin(createContext(path.join(TMP_HOME, "no-default-context")));
    await emit(hooks, {
      type: "message.updated",
      properties: {
        info: {
          role: "assistant",
          providerID: "openai",
          modelID: "model",
          tokens: { input: 100 },
        },
      },
    });
    assert.strictEqual(plugin.__test._contextStateByInstance.size, 0);

    await emit(hooks, lifecycle(
      "session.created",
      "ses_real_after_malformed",
      path.join(TMP_HOME, "no-default-context"),
      "Real session"
    ));
    await waitForQueueEmpty(plugin);
    for (const sessions of plugin.__test._contextStateByInstance.values()) {
      assert.strictEqual(sessions.has("opencode:default"), false);
    }
  });

  it("keeps a delayed SessionStart before a later real-title metadata update", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooks = await plugin(createContext(path.join(TMP_HOME, "created-title")));
    const calls = [];
    const serverSessions = new Map();
    const startGate = deferred();

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      if (call.body.event === "SessionStart") {
        await startGate.promise;
      }
      applyStateBody(serverSessions, call.body);
      return clawdResponse(call.body);
    };

    await emit(hooks, lifecycle(
      "session.created",
      "ses_created",
      path.join(TMP_HOME, "created-title"),
      "New session"
    ));
    await waitFor(
      () => calls.some((call) => call.body.event === "SessionStart"),
      "delayed SessionStart never began"
    );

    await emit(hooks, lifecycle(
      "session.updated",
      "ses_created",
      path.join(TMP_HOME, "created-title"),
      "Real title"
    ));
    assert.strictEqual(
      calls.some((call) => call.body.metadata_only && call.body.session_title === "Real title"),
      false,
      "same-session rename overtook the delayed SessionStart"
    );

    startGate.resolve();
    await waitForQueueEmpty(plugin);
    assert.deepStrictEqual(
      calls.filter((call) => call.url.endsWith("/state")).map((call) => [call.body.event, call.body.session_title]),
      [
        ["SessionUpdate", "New session"],
        ["SessionStart", "New session"],
        ["SessionUpdate", "Real title"],
      ]
    );
    assert.strictEqual(serverSessions.get("opencode:ses_created").title, "Real title");
    assert.strictEqual(plugin.__test._statePostTailBySession.size, 0);
  });

  it("prevents an older lifecycle body from overwriting a later rename", async () => {
    const directory = path.join(TMP_HOME, "rename-order");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooks = await plugin(createContext(directory));
    const calls = [];
    const serverSessions = new Map();
    const lifecycleGate = deferred();
    let blockThinking = false;

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      if (blockThinking && call.body.event === "UserPromptSubmit") {
        await lifecycleGate.promise;
      }
      applyStateBody(serverSessions, call.body);
      return clawdResponse(call.body);
    };

    await emit(hooks, lifecycle("session.created", "ses_rename", directory, "Title A"));
    await waitForQueueEmpty(plugin);
    calls.length = 0;
    blockThinking = true;

    await emit(hooks, {
      type: "session.status",
      properties: { sessionID: "ses_rename", status: { type: "busy" } },
    });
    await waitFor(
      () => calls.some((call) => call.body.event === "UserPromptSubmit"),
      "delayed lifecycle request never began"
    );
    await emit(hooks, lifecycle("session.updated", "ses_rename", directory, "Title B"));
    assert.strictEqual(calls.some((call) => call.body.session_title === "Title B"), false);

    lifecycleGate.resolve();
    await waitForQueueEmpty(plugin);
    assert.deepStrictEqual(
      calls.map((call) => [call.body.event, call.body.session_title]),
      [["UserPromptSubmit", "Title A"], ["SessionUpdate", "Title B"]]
    );
    assert.strictEqual(serverSessions.get("opencode:ses_rename").title, "Title B");
  });

  it("continues after an exhausted delivery and removes success/failure tails", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    await plugin(createContext(path.join(TMP_HOME, "failure")));
    const calls = [];

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      return call.body.state === "thinking" ? untrustedResponse() : clawdResponse(call.body);
    };

    plugin.__test.postStateToClawd({
      state: "thinking",
      session_id: "opencode:ses_failure",
      event: "UserPromptSubmit",
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });
    plugin.__test.postStateToClawd({
      state: "working",
      session_id: "opencode:ses_failure",
      event: "PreToolUse",
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });

    await waitForQueueEmpty(plugin);
    assert.strictEqual(calls.filter((call) => call.body.state === "thinking").length, 5);
    assert.strictEqual(calls.filter((call) => call.body.state === "working").length, 1);
    assert.strictEqual(plugin.__test._statePostTailBySession.size, 0);
  });

  it("coalesces sustained states behind a slow in-flight delivery", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    await plugin(createContext(path.join(TMP_HOME, "coalesce")));
    const calls = [];
    const firstGate = deferred();

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      if (call.body.event === "UserPromptSubmit" && call.body.sequence === 0) {
        await firstGate.promise;
      }
      return clawdResponse(call.body);
    };

    plugin.__test.postStateToClawd({
      state: "thinking",
      session_id: "opencode:ses_coalesce",
      event: "UserPromptSubmit",
      sequence: 0,
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });
    await waitFor(() => calls.length === 1, "first state never began");

    for (let sequence = 1; sequence <= 100; sequence += 1) {
      plugin.__test.postStateToClawd({
        state: sequence % 2 ? "working" : "thinking",
        session_id: "opencode:ses_coalesce",
        event: sequence % 2 ? "PreToolUse" : "UserPromptSubmit",
        sequence,
        agent_id: "opencode",
        hook_source: "opencode-plugin",
      });
    }

    const queued = plugin.__test._statePostQueueBySession.get("opencode:ses_coalesce");
    assert.ok(queued);
    assert.strictEqual(queued.pending.length, 1);
    assert.strictEqual(calls.length, 1, "a queued state overtook the in-flight delivery");
    firstGate.resolve();
    await waitForQueueEmpty(plugin);

    assert.deepStrictEqual(calls.map((call) => call.body.sequence), [0, 100]);
    assert.strictEqual(plugin.__test._statePostQueueBySession.size, 0);
  });

  it("lets SessionEnd replace a stale sustained state pending behind a slow delivery", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    await plugin(createContext(path.join(TMP_HOME, "terminal-coalesce")));
    const calls = [];
    const firstGate = deferred();

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      if (call.body.sequence === 0) await firstGate.promise;
      return clawdResponse(call.body);
    };

    plugin.__test.postStateToClawd({
      state: "thinking",
      session_id: "opencode:ses_terminal",
      event: "UserPromptSubmit",
      sequence: 0,
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });
    await waitFor(() => calls.length === 1, "first state never began");
    plugin.__test.postStateToClawd({
      state: "working",
      session_id: "opencode:ses_terminal",
      event: "PreToolUse",
      sequence: 1,
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });
    plugin.__test.postStateToClawd({
      state: "sleeping",
      session_id: "opencode:ses_terminal",
      event: "SessionEnd",
      sequence: 2,
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });

    firstGate.resolve();
    await waitForQueueEmpty(plugin);
    assert.deepStrictEqual(calls.map((call) => [call.body.sequence, call.body.event]), [
      [0, "UserPromptSubmit"],
      [2, "SessionEnd"],
    ]);
  });

  it("hard-bounds a real event backlog across repeated error barriers", async () => {
    const directory = path.join(TMP_HOME, "bounded-barriers");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooks = await plugin(createContext(directory));
    const calls = [];
    const firstGate = deferred();

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      if (calls.length === 1) await firstGate.promise;
      return clawdResponse(call.body);
    };

    await emit(hooks, lifecycle("session.created", "ses_bounded", directory, "Bounded"));
    await waitFor(() => calls.length === 1, "first lifecycle request never began");

    for (let index = 0; index < 100; index += 1) {
      await emit(hooks, {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_bounded",
          part: { type: "tool", state: { status: "running" } },
        },
      });
      await emit(hooks, {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_bounded",
          part: { type: "tool", state: { status: "error" } },
        },
      });
      await emit(hooks, {
        type: "session.status",
        properties: { sessionID: "ses_bounded", status: { type: "busy" } },
      });
    }

    const queue = plugin.__test._statePostQueueBySession.get("opencode:ses_bounded");
    assert.ok(queue);
    assert.ok(queue.pending.length <= plugin.__test._statePostMaxPending);
    assert.strictEqual(calls.length, 1, "queued events overtook the in-flight delivery");

    firstGate.resolve();
    await waitForQueueEmpty(plugin);
    assert.ok(calls.length <= plugin.__test._statePostMaxPending + 1);
    assert.deepStrictEqual(
      [calls.at(-1).body.state, calls.at(-1).body.event],
      ["thinking", "UserPromptSubmit"],
      "the bounded queue did not retain the freshest state",
    );
    assert.strictEqual(plugin.__test._statePostQueueBySession.size, 0);
  });

  it("does not let overflow title metadata evict the freshest lifecycle state", async () => {
    const directory = path.join(TMP_HOME, "bounded-metadata");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooks = await plugin(createContext(directory));
    const calls = [];
    const firstGate = deferred();

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      if (calls.length === 1) await firstGate.promise;
      return clawdResponse(call.body);
    };

    await emit(hooks, lifecycle("session.created", "ses_metadata_bound", directory, "Old title"));
    await waitFor(() => calls.length === 1, "first lifecycle request never began");

    for (let index = 0; index < 40; index += 1) {
      await emit(hooks, {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_metadata_bound",
          part: { type: "tool", state: { status: "error" } },
        },
      });
      await emit(hooks, {
        type: "session.status",
        properties: { sessionID: "ses_metadata_bound", status: { type: "busy" } },
      });
    }
    await emit(hooks, lifecycle(
      "session.updated",
      "ses_metadata_bound",
      directory,
      "Fresh title",
    ));

    const queue = plugin.__test._statePostQueueBySession.get("opencode:ses_metadata_bound");
    assert.ok(queue);
    assert.ok(queue.pending.length <= plugin.__test._statePostMaxPending);

    firstGate.resolve();
    await waitForQueueEmpty(plugin);
    const lifecycleCalls = calls.filter((call) => !call.body.metadata_only);
    assert.deepStrictEqual(
      [lifecycleCalls.at(-1).body.state, lifecycleCalls.at(-1).body.event],
      ["thinking", "UserPromptSubmit"],
    );
    assert.strictEqual(
      calls.some((call) => call.body.metadata_only && call.body.session_title === "Fresh title"),
      true,
    );
  });

  it("keeps different sessions concurrent and /permission outside the state queue", async () => {
    const directory = path.join(TMP_HOME, "parallel");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooks = await plugin(createContext(directory));
    const calls = [];
    const stateGate = deferred();

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      if (call.url.endsWith("/state") && call.body.session_id === "opencode:ses_a") {
        await stateGate.promise;
      }
      return clawdResponse(call.body);
    };

    plugin.__test.postStateToClawd({
      state: "thinking",
      session_id: "opencode:ses_a",
      event: "UserPromptSubmit",
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });
    await waitFor(() => calls.some((call) => call.body.session_id === "opencode:ses_a"), "session A did not block");

    plugin.__test.postStateToClawd({
      state: "working",
      session_id: "opencode:ses_b",
      event: "PreToolUse",
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });
    await emit(hooks, {
      type: "permission.asked",
      properties: {
        id: "per_parallel",
        sessionID: "ses_a",
        permission: "bash",
        metadata: { command: "echo ok" },
        patterns: [],
        always: [],
      },
    });

    await waitFor(
      () => calls.some((call) => call.body.session_id === "opencode:ses_b"),
      "session B waited behind session A"
    );
    await waitFor(
      () => calls.some((call) => call.url.endsWith("/permission") && call.body.request_id === "per_parallel"),
      "permission waited behind the state queue"
    );
    assert.ok(plugin.__test._statePostTailBySession.has("opencode:ses_a"));

    stateGate.resolve();
    await waitForQueueEmpty(plugin);
  });

  it("snapshots a child SessionEnd before ownership cleanup and drains its tail", async () => {
    const directory = path.join(TMP_HOME, "delete-snapshot");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooks = await plugin(createContext(directory));
    const calls = [];
    const thinkingGate = deferred();
    let blockThinking = false;

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      if (blockThinking && call.body.event === "UserPromptSubmit" && call.body.session_id === "opencode:ses_child") {
        await thinkingGate.promise;
      }
      return clawdResponse(call.body);
    };

    await emit(hooks, lifecycle("session.created", "ses_root", directory, "Root"));
    await emit(hooks, lifecycle(
      "session.created",
      "ses_child",
      directory,
      "Final child title",
      { parentID: "ses_root" }
    ));
    await waitForQueueEmpty(plugin);
    calls.length = 0;
    blockThinking = true;

    await emit(hooks, {
      type: "session.status",
      properties: { sessionID: "ses_child", status: { type: "busy" } },
    });
    await waitFor(() => calls.some((call) => call.body.event === "UserPromptSubmit"), "child state did not block");
    await emit(hooks, lifecycle(
      "session.deleted",
      "ses_child",
      directory,
      "Final child title",
      { parentID: "ses_root" }
    ));

    assert.strictEqual(plugin.__test._sessionDirectoryById.has("opencode:ses_child"), false);
    assert.strictEqual(plugin.__test._sessionTitleById.has("opencode:ses_child"), false);
    assert.strictEqual(plugin.__test._sessionParentById.has("opencode:ses_child"), false);
    assert.strictEqual(calls.some((call) => call.body.event === "SessionEnd"), false);

    thinkingGate.resolve();
    await waitForQueueEmpty(plugin);
    const end = calls.find((call) => call.body.event === "SessionEnd");
    assert.ok(end, "queued child SessionEnd was lost");
    assert.strictEqual(end.body.cwd, directory);
    assert.strictEqual(end.body.session_title, "Final child title");
    assert.strictEqual(end.body.headless, true);
    assert.strictEqual(plugin.__test._statePostTailBySession.size, 0);
  });
});

describe("opencode-family queued metadata coalescing", () => {
  it("keeps queue-tail transport success separate from metadata acceptance", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const calls = [];
    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      return clawdResponse(call.body, { metadataAccepted: false });
    };

    const completion = plugin.__test.postStateToClawd(metadataState("opencode:ses_no_ack", {
      context_usage: { used: 10, limit: 100, source: "opencode" },
    }));
    const tail = plugin.__test._statePostTailBySession.get("opencode:ses_no_ack");
    assert.strictEqual(await completion, false, "the metadata snapshot must not report accepted");
    assert.strictEqual(await tail, true, "the queue tail remains a recognized-transport aggregate");
    assert.strictEqual(calls.length, 1, "recognized/no-ack must stop candidate scanning");
    assert.strictEqual(plugin.__test._cachedPort, 23333);
  });

  it("projects untrusted or thrown delivery to false snapshot and transport results", async () => {
    for (const mode of ["untrusted", "throw"]) {
      const plugin = createOpencodeFamilyPlugin(CONFIG);
      fetchImpl = mode === "throw"
        ? async () => { throw new Error("fetch failed"); }
        : async () => untrustedResponse();
      const completion = plugin.__test.postStateToClawd(metadataState(`opencode:ses_${mode}`, {
        context_usage: { used: 10, limit: 100, source: "opencode" },
      }));
      const tail = plugin.__test._statePostTailBySession.get(`opencode:ses_${mode}`);
      assert.strictEqual(await completion, false, `${mode} snapshot must fail`);
      assert.strictEqual(await tail, false, `${mode} transport aggregate must fail`);
    }
  });

  function startBlockedLifecycle(plugin, calls, sessionID = "opencode:ses_meta") {
    const gate = deferred();
    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      if (call.body.session_id === sessionID && call.body.metadata_only !== true && calls.length === 1) {
        await gate.promise;
      }
      return clawdResponse(call.body);
    };
    const active = plugin.__test.postStateToClawd({
      state: "thinking",
      session_id: sessionID,
      event: "UserPromptSubmit",
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });
    assert.strictEqual(calls.length, 1, "the lifecycle request did not enter the controlled gate");
    return { gate, active };
  }

  it("merges title then context without losing either field", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const calls = [];
    const { gate, active } = startBlockedLifecycle(plugin, calls);
    const title = plugin.__test.postStateToClawd(metadataState("opencode:ses_meta", {
      session_title: "A title",
    }));
    const context = plugin.__test.postStateToClawd(metadataState("opencode:ses_meta", {
      context_usage: { used: 10, limit: 100, source: "opencode" },
    }));

    gate.resolve();
    assert.strictEqual(await active, true);
    assert.strictEqual(await title, true);
    assert.strictEqual(await context, true);
    assert.deepStrictEqual(calls.map((call) => call.body.metadata_only), [undefined, true]);
    assert.strictEqual(calls[1].body.session_title, "A title");
    assert.deepStrictEqual(calls[1].body.context_usage, { used: 10, limit: 100, source: "opencode" });
  });

  it("merges context then title and preserves latest values within each kind", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const calls = [];
    const { gate, active } = startBlockedLifecycle(plugin, calls);
    const contextA = plugin.__test.postStateToClawd(metadataState("opencode:ses_meta", {
      context_usage: { used: 10, limit: 100, source: "opencode" },
    }));
    const contextB = plugin.__test.postStateToClawd(metadataState("opencode:ses_meta", {
      context_usage: { used: 20, limit: 100, source: "opencode" },
    }));
    const titleA = plugin.__test.postStateToClawd(metadataState("opencode:ses_meta", {
      session_title: "Old title",
    }));
    const titleB = plugin.__test.postStateToClawd(metadataState("opencode:ses_meta", {
      session_title: "Latest title",
    }));

    gate.resolve();
    assert.strictEqual(await active, true);
    assert.strictEqual(await contextA, false);
    assert.strictEqual(await titleA, false);
    assert.strictEqual(await contextB, true);
    assert.strictEqual(await titleB, true);
    const metadata = calls.filter((call) => call.body.metadata_only);
    assert.strictEqual(metadata.length, 1, "superseded metadata was replayed");
    assert.strictEqual(metadata[0].body.session_title, "Latest title");
    assert.deepStrictEqual(metadata[0].body.context_usage, { used: 20, limit: 100, source: "opencode" });
  });

  it("keeps lifecycle semantics separate from queued metadata", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const calls = [];
    const { gate, active } = startBlockedLifecycle(plugin, calls);
    const title = plugin.__test.postStateToClawd(metadataState("opencode:ses_meta", {
      session_title: "Title",
    }));
    const context = plugin.__test.postStateToClawd(metadataState("opencode:ses_meta", {
      context_usage: { used: 30, limit: 300, source: "opencode" },
    }));
    const lifecycleBody = plugin.__test.postStateToClawd({
      state: "working",
      session_id: "opencode:ses_meta",
      event: "PostToolUse",
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });

    gate.resolve();
    await Promise.all([active, title, context, lifecycleBody]);
    assert.deepStrictEqual(
      calls.map((call) => [call.body.event, call.body.metadata_only === true]),
      [
        ["UserPromptSubmit", false],
        ["SessionUpdate", true],
        ["PostToolUse", false],
      ]
    );
  });

  it("keeps different session queues concurrent", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const calls = [];
    const gateA = deferred();
    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      if (call.body.session_id === "opencode:ses_a") await gateA.promise;
      return clawdResponse(call.body);
    };

    const a = plugin.__test.postStateToClawd({
      state: "thinking",
      session_id: "opencode:ses_a",
      event: "UserPromptSubmit",
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });
    const b = plugin.__test.postStateToClawd(metadataState("opencode:ses_b", {
      context_usage: { used: 1, limit: 10, source: "opencode" },
    }));
    assert.strictEqual(calls.length, 2, "session B waited behind session A");
    assert.strictEqual(calls[1].body.session_id, "opencode:ses_b");
    gateA.resolve();
    await Promise.all([a, b]);
  });
});

describe("opencode-family directory-scoped instance disposal", () => {
  it("normalizes comparison keys without changing platform path semantics", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    assert.strictEqual(
      plugin.__test.normalizeDirectoryOwnershipKey("C:\\Proj\\child\\..\\", "win32"),
      plugin.__test.normalizeDirectoryOwnershipKey("c:/proj", "win32")
    );
    assert.strictEqual(
      plugin.__test.normalizeDirectoryOwnershipKey("/proj/./", "linux"),
      plugin.__test.normalizeDirectoryOwnershipKey("/proj", "linux")
    );
    assert.notStrictEqual(
      plugin.__test.normalizeDirectoryOwnershipKey("/Proj", "linux"),
      plugin.__test.normalizeDirectoryOwnershipKey("/proj", "linux")
    );
    assert.strictEqual(plugin.__test.normalizeDirectoryOwnershipKey("relative/path", "linux"), null);
  });

  it("disposes only the owning directory and preserves the other handler state", async () => {
    const directoryA = path.join(TMP_HOME, "Project-A");
    const directoryB = path.join(TMP_HOME, "Project-B");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooksA = await plugin(createContext(directoryA));
    const hooksB = await plugin(createContext(directoryB));
    const calls = [];

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      return clawdResponse(call.body);
    };

    await emit(hooksA, lifecycle("session.created", "a_root", directoryA, "A root"));
    await emit(hooksA, lifecycle("session.created", "a_child", directoryA, "A child", { parentID: "a_root" }));
    await emit(hooksB, lifecycle("session.created", "b_root", directoryB, "B root"));
    await emit(hooksB, lifecycle("session.created", "b_child", directoryB, "B child", { parentID: "b_root" }));
    await waitForQueueEmpty(plugin);

    for (const [hooks, id, sessionID] of [
      [hooksA, "per_a", "a_root"],
      [hooksB, "per_b", "b_root"],
    ]) {
      await emit(hooks, {
        type: "permission.asked",
        properties: { id, sessionID, permission: "bash", metadata: {}, patterns: [], always: [] },
      });
    }
    await waitFor(() => plugin.__test._permissionTargetByRequestId.size === 2, "permission targets missing");
    calls.length = 0;

    const equivalentA = process.platform === "win32"
      ? `${directoryA.toLowerCase().replaceAll("\\", "/")}/./`
      : `${directoryA}/./`;
    await emit(hooksA, {
      type: "server.instance.disposed",
      properties: { directory: equivalentA },
    });
    await waitForQueueEmpty(plugin);

    for (const id of ["opencode:a_root", "opencode:a_child"]) {
      assert.strictEqual(plugin.__test._sessionDirectoryById.has(id), false, `${id} directory leaked`);
      assert.strictEqual(plugin.__test._sessionTitleById.has(id), false, `${id} title leaked`);
      assert.strictEqual(plugin.__test._lastStatePerSession.has(id), false, `${id} dedup leaked`);
    }
    for (const id of ["opencode:b_root", "opencode:b_child"]) {
      assert.strictEqual(plugin.__test._sessionDirectoryById.has(id), true, `${id} directory was cleared`);
      assert.strictEqual(plugin.__test._sessionTitleById.has(id), true, `${id} title was cleared`);
      assert.strictEqual(plugin.__test._lastStatePerSession.has(id), true, `${id} dedup was cleared`);
    }
    assert.strictEqual(plugin.__test._sessionParentById.has("opencode:a_child"), false);
    assert.strictEqual(plugin.__test._sessionParentById.get("opencode:b_child"), "opencode:b_root");
    assert.strictEqual(plugin.__test._rootSessionId, null, "disposed A root fallback survived");
    assert.strictEqual(plugin.__test._lastSeenSessionId, "b_root", "live B latest fallback was cleared");
    assert.strictEqual(plugin.__test._permissionTargetByRequestId.has("per_a"), false);
    assert.strictEqual(plugin.__test._permissionTargetByRequestId.has("per_b"), true);
    const disposalEnds = calls.filter((call) => call.url.endsWith("/state"));
    assert.deepStrictEqual(
      disposalEnds.map((call) => call.body.session_id).sort(),
      ["opencode:a_child", "opencode:a_root"]
    );
    assert.ok(disposalEnds.every((call) => call.body.event === "SessionEnd"));

    calls.length = 0;
    await emit(hooksB, lifecycle("session.created", "b_child", directoryB, "B child", { parentID: "b_root" }));
    assert.strictEqual(plugin.__test._statePostTailBySession.has("opencode:b_child"), false);
    assert.strictEqual(calls.some((call) => call.url.endsWith("/state")), false, "B dedup state was not preserved");

    await emit(hooksB, {
      type: "session.status",
      properties: { sessionID: "b_child", status: { type: "busy" } },
    });
    await waitForQueueEmpty(plugin);
    const bState = calls.find((call) => call.body.event === "UserPromptSubmit");
    assert.ok(bState);
    assert.strictEqual(bState.body.cwd, directoryB);
    assert.strictEqual(bState.body.session_title, "B child");
    assert.strictEqual(bState.body.headless, true);

    calls.length = 0;
    await emit(hooksB, lifecycle("session.updated", "b_root", directoryB, "B renamed"));
    await waitForQueueEmpty(plugin);
    assert.ok(calls.some((call) => call.body.metadata_only && call.body.session_title === "B renamed"));
  });

  it("uses handler ownership for legacy sessions without info.directory", async () => {
    const directoryA = path.join(TMP_HOME, "legacy-a");
    const directoryB = path.join(TMP_HOME, "legacy-b");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooksA = await plugin(createContext(directoryA));
    const hooksB = await plugin(createContext(directoryB));
    const calls = [];

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      return clawdResponse(call.body);
    };

    await emit(hooksA, {
      type: "session.created",
      properties: { sessionID: "legacy_a", info: { id: "legacy_a", title: "A" } },
    });
    await emit(hooksB, {
      type: "session.created",
      properties: { sessionID: "legacy_b", info: { id: "legacy_b", title: "B" } },
    });
    await waitForQueueEmpty(plugin);
    assert.strictEqual(plugin.__test._hostEmitsSessionInfo, false);
    assert.strictEqual(plugin.__test._sessionDirectoryById.size, 0);
    assert.strictEqual(plugin.__test._sessionInstanceDirectoryById.get("opencode:legacy_a"), directoryA);
    assert.strictEqual(plugin.__test._sessionInstanceDirectoryById.get("opencode:legacy_b"), directoryB);
    calls.length = 0;

    await emit(hooksA, { type: "server.instance.disposed", properties: {} });
    await waitForQueueEmpty(plugin);

    assert.strictEqual(plugin.__test._sessionInstanceDirectoryById.has("opencode:legacy_a"), false);
    assert.strictEqual(plugin.__test._sessionTitleById.has("opencode:legacy_a"), false);
    assert.strictEqual(plugin.__test._lastStatePerSession.has("opencode:legacy_a"), false);
    assert.strictEqual(plugin.__test._sessionInstanceDirectoryById.get("opencode:legacy_b"), directoryB);
    assert.strictEqual(plugin.__test._sessionTitleById.get("opencode:legacy_b"), "B");
    assert.strictEqual(plugin.__test._lastStatePerSession.get("opencode:legacy_b"), "idle");
    assert.deepStrictEqual(
      calls.filter((call) => call.url.endsWith("/state")).map((call) => call.body.session_id),
      ["opencode:legacy_a"]
    );
  });

  it("keeps mixed-payload ownership scoped after the info-directory latch", async () => {
    const directoryA = path.join(TMP_HOME, "mixed-a");
    const directoryB = path.join(TMP_HOME, "mixed-b");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooksA = await plugin(createContext(directoryA));
    const hooksB = await plugin(createContext(directoryB));
    const calls = [];

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      return clawdResponse(call.body);
    };

    await emit(hooksA, lifecycle("session.created", "mixed_a", directoryA, "A"));
    assert.strictEqual(plugin.__test._hostEmitsSessionInfo, true);
    await emit(hooksB, {
      type: "session.status",
      properties: { sessionID: "mixed_b", status: { type: "busy" } },
    });
    await waitForQueueEmpty(plugin);

    assert.strictEqual(plugin.__test._sessionDirectoryById.has("opencode:mixed_b"), false);
    assert.strictEqual(plugin.__test._sessionInstanceDirectoryById.get("opencode:mixed_b"), directoryB);
    const firstB = calls.find((call) => call.body.session_id === "opencode:mixed_b");
    assert.ok(firstB);
    assert.strictEqual(Object.hasOwn(firstB.body, "cwd"), false, "mixed modern map miss leaked handler cwd");
    calls.length = 0;

    await emit(hooksA, {
      type: "server.instance.disposed",
      properties: { directory: directoryA },
    });
    await waitForQueueEmpty(plugin);

    assert.strictEqual(plugin.__test._sessionInstanceDirectoryById.get("opencode:mixed_b"), directoryB);
    assert.strictEqual(plugin.__test._lastStatePerSession.get("opencode:mixed_b"), "thinking");
    assert.strictEqual(plugin.__test._lastSeenSessionId, "mixed_b");
    assert.deepStrictEqual(
      calls.filter((call) => call.url.endsWith("/state")).map((call) => call.body.session_id),
      ["opencode:mixed_a"]
    );

    calls.length = 0;
    await emit(hooksB, { type: "session.error", properties: { sessionID: "mixed_b" } });
    await waitForQueueEmpty(plugin);
    const laterB = calls.find((call) => call.body.session_id === "opencode:mixed_b");
    assert.ok(laterB);
    assert.strictEqual(laterB.body.state, "error");
    assert.strictEqual(Object.hasOwn(laterB.body, "cwd"), false);
  });

  it("restores the previous active handler as the legacy cwd fallback", async () => {
    const directoryA = path.join(TMP_HOME, "fallback-a");
    const directoryB = path.join(TMP_HOME, "fallback-b");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    await plugin(createContext(directoryA));
    const hooksB = await plugin(createContext(directoryB));
    const calls = [];

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      return clawdResponse(call.body);
    };

    assert.strictEqual(plugin.__test._lastInitDirectory, directoryB);
    await emit(hooksB, {
      type: "server.instance.disposed",
      properties: { directory: directoryB },
    });
    assert.strictEqual(plugin.__test._lastInitDirectory, directoryA);

    plugin.__test.postStateToClawd({
      state: "thinking",
      event: "UserPromptSubmit",
      session_id: "opencode:legacy_unowned",
      agent_id: "opencode",
      hook_source: "opencode-plugin",
    });
    await waitForQueueEmpty(plugin);
    assert.strictEqual(calls.at(-1).body.cwd, directoryA);
  });

  it("treats disposed as cleanup-only even when it carries another session id", async () => {
    const directoryA = path.join(TMP_HOME, "sid-a");
    const directoryB = path.join(TMP_HOME, "sid-b");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooksA = await plugin(createContext(directoryA));
    const hooksB = await plugin(createContext(directoryB));
    const calls = [];

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      return clawdResponse(call.body);
    };

    await emit(hooksA, lifecycle("session.created", "sid_a", directoryA, "A"));
    await emit(hooksB, lifecycle("session.created", "sid_b", directoryB, "B"));
    await waitForQueueEmpty(plugin);
    calls.length = 0;

    await emit(hooksA, {
      type: "server.instance.disposed",
      properties: { directory: directoryA, sessionID: "sid_b" },
    });
    await waitForQueueEmpty(plugin);

    assert.strictEqual(plugin.__test._rootSessionId, null);
    assert.strictEqual(plugin.__test._lastSeenSessionId, "sid_b");
    assert.strictEqual(plugin.__test._sessionDirectoryById.has("opencode:sid_a"), false);
    assert.strictEqual(plugin.__test._sessionDirectoryById.get("opencode:sid_b"), directoryB);
    assert.deepStrictEqual(
      calls.filter((call) => call.url.endsWith("/state")).map((call) => call.body.session_id),
      ["opencode:sid_a"]
    );

    calls.length = 0;
    await emit(hooksA, {
      type: "session.status",
      properties: { sessionID: "sid_a", status: { type: "busy" } },
    });
    assert.strictEqual(plugin.__test._statePostTailBySession.has("opencode:sid_a"), false);
    assert.strictEqual(calls.length, 0, "disposed handler accepted a later event");
  });

  it("queues targeted SessionEnd behind an in-flight state so disposal cannot leave a ghost", async () => {
    const directoryA = path.join(TMP_HOME, "ghost-a");
    const directoryB = path.join(TMP_HOME, "ghost-b");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooksA = await plugin(createContext(directoryA));
    const hooksB = await plugin(createContext(directoryB));
    const calls = [];
    const serverSessions = new Map();
    const stateGate = deferred();
    let blockA = false;

    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      if (blockA && call.body.session_id === "opencode:ghost_a" && call.body.event === "UserPromptSubmit") {
        await stateGate.promise;
      }
      if (call.url.endsWith("/state")) applyStateBody(serverSessions, call.body);
      return clawdResponse(call.body);
    };

    await emit(hooksA, lifecycle("session.created", "ghost_a", directoryA, "A"));
    await emit(hooksB, lifecycle("session.created", "ghost_b", directoryB, "B"));
    await waitForQueueEmpty(plugin);
    calls.length = 0;
    blockA = true;

    await emit(hooksA, {
      type: "session.status",
      properties: { sessionID: "ghost_a", status: { type: "busy" } },
    });
    await waitFor(
      () => calls.some((call) => call.body.event === "UserPromptSubmit" && call.body.session_id === "opencode:ghost_a"),
      "A state never reached the delivery gate"
    );
    await emit(hooksA, {
      type: "server.instance.disposed",
      properties: { directory: directoryA },
    });
    assert.strictEqual(
      calls.some((call) => call.body.event === "SessionEnd" && call.body.session_id === "opencode:ghost_a"),
      false,
      "A SessionEnd overtook its blocked state"
    );

    await emit(hooksB, {
      type: "session.status",
      properties: { sessionID: "ghost_b", status: { type: "busy" } },
    });
    await waitFor(
      () => serverSessions.get("opencode:ghost_b")?.state === "thinking",
      "B was blocked by A's disposal queue"
    );

    stateGate.resolve();
    await waitForQueueEmpty(plugin);
    assert.strictEqual(serverSessions.has("opencode:ghost_a"), false);
    assert.strictEqual(serverSessions.get("opencode:ghost_b")?.state, "thinking");
    assert.strictEqual(plugin.__test._statePostTailBySession.size, 0);
  });

  it("falls back to conservative global cleanup when no directory is usable", async () => {
    const directoryA = path.join(TMP_HOME, "global-a");
    const directoryB = path.join(TMP_HOME, "global-b");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooks = await plugin(createContext(""));

    await emit(hooks, lifecycle("session.created", "global_a", directoryA, "A"));
    await emit(hooks, lifecycle("session.created", "global_b", directoryB, "B"));
    await waitForQueueEmpty(plugin);
    await emit(hooks, { type: "server.instance.disposed", properties: {} });
    await waitForQueueEmpty(plugin);

    assert.strictEqual(plugin.__test._sessionDirectoryById.size, 0);
    assert.strictEqual(plugin.__test._sessionTitleById.size, 0);
    assert.strictEqual(plugin.__test._lastStatePerSession.size, 0);
    assert.strictEqual(plugin.__test._sessionParentById.size, 0);
    assert.strictEqual(plugin.__test._rootSessionId, null);
    assert.strictEqual(plugin.__test._lastSeenSessionId, null);
  });
});

describe("opencode-family context usage event wiring", () => {
  it("routes a real message.updated hook event into metadata delivery", async () => {
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooks = await plugin(createContext(path.join(TMP_HOME, "context-wire")));
    const calls = [];
    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      return clawdResponse(call.body);
    };

    await emit(hooks, contextMessage("context_wire", 321));
    await waitFor(
      () => calls.some((call) => call.body.metadata_only === true),
      "message.updated never reached the context usage handler"
    );

    const metadata = calls.find((call) => call.body.metadata_only === true).body;
    assert.strictEqual(metadata.session_id, "opencode:context_wire");
    assert.deepStrictEqual(metadata.context_usage, {
      used: 321,
      limit: null,
      source: "opencode",
    });
  });

  it("a real session.created event invalidates the prior context generation", async () => {
    const directory = path.join(TMP_HOME, "context-reopen");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const hooks = await plugin(createContext(directory));

    await emit(hooks, contextMessage("context_reopen", 400));
    await waitFor(
      () => [...plugin.__test._contextStateByInstance.values()]
        .some((sessions) => sessions.has("opencode:context_reopen")),
      "the original context generation was not created"
    );
    await emit(hooks, lifecycle("session.created", "context_reopen", directory, "Reopened"));

    assert.strictEqual(
      [...plugin.__test._contextStateByInstance.values()]
        .some((sessions) => sessions.has("opencode:context_reopen")),
      false,
      "session reuse must remove the old provider lookup/dedup generation"
    );
  });

  it("instance disposal sends SessionEnd for a context-only session and clears its bucket", async () => {
    const directory = path.join(TMP_HOME, "context-dispose");
    const plugin = createOpencodeFamilyPlugin(CONFIG);
    const context = createContext(directory);
    const hooks = await plugin(context);
    const calls = [];
    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      return clawdResponse(call.body);
    };

    await emit(hooks, contextMessage("owned_context", 10));
    await waitFor(() => plugin.__test._contextStateByInstance.size === 1, "instance token was not established");
    const instanceToken = [...plugin.__test._contextStateByInstance.keys()][0];
    await plugin.__test.handleContextUsageEvent(
      contextMessage("context_only", 20),
      { client: context.client, instanceToken }
    );
    assert.ok(plugin.__test._contextStateByInstance.get(instanceToken).has("opencode:context_only"));
    calls.length = 0;

    await emit(hooks, {
      type: "server.instance.disposed",
      properties: { directory },
    });
    await waitForQueueEmpty(plugin);

    assert.ok(
      calls.some((call) => call.body.event === "SessionEnd"
        && call.body.session_id === "opencode:context_only"),
      "the disposal hook must terminate sessions known only to context telemetry"
    );
    assert.strictEqual(plugin.__test._contextStateByInstance.has(instanceToken), false);
  });
});

// #883: resume signals must hydrate metadata without synthesizing activity.
describe("opencode resume context hydration", () => {
  const directory = path.join(TMP_HOME, "resume-context");
  const sessionID = "ses_resume";
  const history = (used = 321, id = "msg_latest", created = 2, sid = sessionID) => ({
    info: { id, sessionID: sid, role: "assistant", time: { created, completed: created + 1 },
      providerID: "openai", modelID: "test-model", tokens: { input: used } },
    parts: [],
  });
  const resumed = (sid = sessionID) => lifecycle("session.updated", sid, directory);
  async function setup(messages, params = CONFIG, list = null) {
    const calls = [];
    const queries = [];
    fetchImpl = async (url, opts) => {
      const call = parseFetchCall(url, opts);
      calls.push(call);
      return clawdResponse(call.body);
    };
    const client = {
      session: { messages: async (options) => { queries.push(options); return messages(options); } },
      provider: { list: async () => ({ data: { all: [
        { id: "openai", models: { "test-model": { limit: { context: 1000 } } } },
      ] } }) },
    };
    if (list) client.session.list = list;
    const plugin = createOpencodeFamilyPlugin(params);
    const hooks = await plugin({ ...createContext(directory), client });
    return { plugin, hooks, client, calls, queries,
      metadata: () => calls.filter((call) => call.body.context_usage).map((call) => call.body) };
  }
  async function settle(plugin) {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    await waitForQueueEmpty(plugin);
  }

  it("hydrates an existing session on session.updated without another assistant event or lifecycle POST", async () => {
    const h = await setup(async () => ({ data: [history()] }));
    await emit(h.hooks, resumed());
    await settle(h.plugin);
    assert.strictEqual(h.metadata().length, 1);
    assert.deepStrictEqual(h.metadata()[0].context_usage, { used: 321, limit: 1000, source: "opencode" });
    assert.strictEqual(h.metadata()[0].metadata_only, true);
    assert.strictEqual(h.metadata()[0].session_id, "opencode:ses_resume");
    assert.strictEqual(h.calls.filter((call) => !call.body.metadata_only).length, 0);
    assert.strictEqual(h.plugin.__test._lastStatePerSession.size, 0);
    assert.strictEqual(h.queries[0].path.id, sessionID, "SDK receives the raw session id");
    assert.strictEqual(h.queries[0].query.directory, directory);
    assert.ok(h.queries[0].query.limit > 0 && h.queries[0].query.limit <= 100);
  });

  it("hydrates explicit TUI selection without treating it as session activity", async () => {
    const h = await setup(async () => [history()]);
    await emit(h.hooks, { type: "tui.session.select", properties: { sessionID } });
    await settle(h.plugin);
    assert.strictEqual(h.metadata().length, 1);
    assert.ok(h.calls.every((call) => call.body.metadata_only));
  });

  it("queues hydration behind the lifecycle that first makes a resumed session visible", async () => {
    const h = await setup(async () => ({ data: [history()] }));
    await emit(h.hooks, { type: "session.status", properties: { sessionID, status: { type: "busy" } } });
    await settle(h.plugin);
    assert.deepStrictEqual(h.calls.map((call) => call.body.metadata_only === true), [false, true]);
    assert.strictEqual(h.calls[0].body.event, "UserPromptSubmit");
    assert.strictEqual(h.plugin.__test._lastStatePerSession.get("opencode:ses_resume"), "thinking");
  });

  it("chooses the latest valid assistant by message order, including decreased usage after compaction", async () => {
    const h = await setup(async () => ({ data: [history(900, "msg_old", 1), history(100),
      { info: { id: "msg_user", sessionID, role: "user", time: { created: 3 } }, parts: [] },
      history(0, "msg_incomplete", 4), history(800, "msg_foreign", 5, "ses_other")] }));
    await emit(h.hooks, resumed());
    await settle(h.plugin);
    assert.deepStrictEqual(h.metadata().map((body) => body.context_usage.used), [100]);
  });

  it("coalesces repeated resume signals and stops querying after accepted hydration", async () => {
    const gate = deferred();
    const h = await setup(() => gate.promise);
    for (let i = 0; i < 10; i++) await emit(h.hooks, resumed());
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 1);
    gate.resolve({ data: [history()] });
    await settle(h.plugin);
    await emit(h.hooks, resumed());
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 1);
    assert.strictEqual(h.metadata().length, 1);
  });

  it("discards a delayed history result after a newer real-time sample, even when usage decreases", async () => {
    const gate = deferred();
    const h = await setup(() => gate.promise);
    await emit(h.hooks, resumed());
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 1);
    await emit(h.hooks, { type: "message.updated", properties: { info: history(50).info } });
    await settle(h.plugin);
    gate.resolve({ data: [history(900)] });
    await settle(h.plugin);
    assert.deepStrictEqual(h.metadata().map((body) => body.context_usage.used), [50]);
  });

  it("invalidates pending history even when the incoming assistant update has no usable tokens yet", async () => {
    const gate = deferred();
    const h = await setup(() => gate.promise);
    await emit(h.hooks, resumed());
    await settle(h.plugin);
    await emit(h.hooks, { type: "message.updated", properties: { info: history(0).info } });
    gate.resolve({ data: [history(900)] });
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 1);
    assert.strictEqual(h.metadata().length, 0);
  });

  for (const terminal of ["session.deleted", "server.instance.disposed"]) {
    it(`drops a history result after ${terminal}`, async () => {
      const gate = deferred();
      const h = await setup(() => gate.promise);
      await emit(h.hooks, resumed());
      await settle(h.plugin);
      assert.strictEqual(h.queries.length, 1);
      await emit(h.hooks, terminal === "session.deleted" ? lifecycle(terminal, sessionID, directory)
        : { type: terminal, properties: { directory } });
      gate.resolve({ data: [history()] });
      await settle(h.plugin);
      assert.strictEqual(h.metadata().length, 0);
      assert.strictEqual(h.plugin.__test._contextStateByInstance.size, 0);
    });
  }

  it("does not publish unknown usage or invent a zero percentage", async () => {
    for (const result of [{ data: [] }, { error: { message: "unavailable" } }, { data: [history(0)] },
      { data: [history(100, "msg_foreign", 1, "ses_other")] }]) {
      const h = await setup(async () => result);
      await emit(h.hooks, resumed());
      await settle(h.plugin);
      assert.strictEqual(h.queries.length, 1);
      assert.strictEqual(h.metadata().length, 0);
    }
  });

  it("preserves unknown model limit as null", async () => {
    const h = await setup(async () => ({ data: [history()] }));
    h.client.provider.list = async () => ({ data: { all: [] } });
    await emit(h.hooks, resumed());
    await settle(h.plugin);
    assert.deepStrictEqual(h.metadata().map((body) => body.context_usage), [
      { used: 321, limit: null, source: "opencode" },
    ]);
  });

  it("does not query MiMo, missing identities, conflicting identities, or another directory", async () => {
    const mimo = await setup(async () => ({ data: [history()] }), {
      ...CONFIG, agentId: "mimocode", hookSource: "mimocode-plugin", sessionIdPrefix: "mimocode:",
    });
    await emit(mimo.hooks, resumed());
    await settle(mimo.plugin);
    assert.strictEqual(mimo.queries.length, 0);
    const h = await setup(async () => ({ data: [history()] }));
    await emit(h.hooks, { type: "session.updated", properties: {} });
    await emit(h.hooks, lifecycle("session.updated", sessionID, directory, null, { id: "ses_other" }));
    await emit(h.hooks, lifecycle("session.updated", sessionID, directory + "-other"));
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 0);
  });

  it("cools down failed reads but replays an unaccepted sample without rereading history", async () => {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      let fail = true;
      const h = await setup(async () => { if (fail) throw new Error("offline"); return { data: [history()] }; });
      await emit(h.hooks, resumed());
      await settle(h.plugin);
      await emit(h.hooks, resumed());
      await settle(h.plugin);
      assert.strictEqual(h.queries.length, 1);
      fail = false;
      now += 31_000;
      fetchImpl = async () => clawdResponse(null, { metadataAccepted: false });
      await emit(h.hooks, resumed());
      await settle(h.plugin);
      assert.strictEqual(h.queries.length, 2);
      assert.strictEqual([...h.plugin.__test._contextStateByInstance.values()][0].get("opencode:ses_resume").delivered, null);
      fetchImpl = async (url, opts) => { const call = parseFetchCall(url, opts); h.calls.push(call); return clawdResponse(call.body); };
      await emit(h.hooks, resumed());
      await settle(h.plugin);
      assert.strictEqual(h.queries.length, 2);
      assert.strictEqual(h.metadata().length, 1);
    } finally { Date.now = originalNow; }
  });

  it("bounds concurrent history requests per instance", async () => {
    const gate = deferred();
    const h = await setup(() => gate.promise);
    for (let i = 0; i < 10; i++) await emit(h.hooks, resumed(`ses_${i}`));
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 4);
    gate.resolve({ data: [] });
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 10, "all original signals are served after capacity is freed");
    assert.strictEqual(new Set(h.queries.map((query) => query.path.id)).size, 10);
  });

  it("keeps client/directory lookups isolated across initialized instances", async () => {
    const h = await setup(async () => ({ data: [history(100)] }));
    const otherDirectory = directory + "-second";
    const otherQueries = [];
    const second = await h.plugin({ directory: otherDirectory, client: {
      ...h.client,
      session: { messages: async (options) => { otherQueries.push(options); return { data: [history(200, "msg_2", 2, "ses_second")] }; } },
    } });
    await emit(h.hooks, resumed());
    await emit(second, lifecycle("session.updated", "ses_second", otherDirectory));
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 1);
    assert.strictEqual(otherQueries.length, 1);
    assert.strictEqual(otherQueries[0].query.directory, otherDirectory);
    assert.deepStrictEqual(h.metadata().map((body) => [body.session_id, body.context_usage.used]), [
      ["opencode:ses_resume", 100], ["opencode:ses_second", 200],
    ]);
  });

  it("does not let old history overwrite a recreated generation", async () => {
    const old = deferred();
    let first = true;
    const h = await setup(() => { if (first) { first = false; return old.promise; } return { data: [history(50)] }; });
    await emit(h.hooks, resumed());
    await settle(h.plugin);
    await emit(h.hooks, lifecycle("session.deleted", sessionID, directory));
    await settle(h.plugin);
    await emit(h.hooks, lifecycle("session.created", sessionID, directory));
    await settle(h.plugin);
    old.resolve({ data: [history(900)] });
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 2);
    assert.deepStrictEqual(h.metadata().map((body) => body.context_usage.used), [50]);
  });

  it("keeps the history fence through a delayed model-limit lookup", async () => {
    const gate = deferred();
    let providerCalls = 0;
    const h = await setup(async () => ({ data: [history(900)] }));
    h.client.provider.list = () => { providerCalls++; return gate.promise; };
    await emit(h.hooks, resumed());
    await settle(h.plugin);
    assert.strictEqual(providerCalls, 1);
    await emit(h.hooks, { type: "message.updated", properties: { info: history(0).info } });
    gate.resolve({ data: { all: [] } });
    await settle(h.plugin);
    assert.strictEqual(h.metadata().length, 0);
  });

  it("times out a hung SDK without blocking the event hook or publishing metadata", async () => {
    const h = await setup(() => new Promise(() => {}));
    await emit(h.hooks, resumed());
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 1);
    await waitFor(() => h.queries[0].signal.aborted, "history request did not time out", 3000);
    await settle(h.plugin);
    assert.strictEqual(h.metadata().length, 0);
    assert.strictEqual([...h.plugin.__test._contextStateByInstance.values()][0].get("opencode:ses_resume").hydration, null);
  });

  it("hydrates recent directory-owned sessions at startup without lifecycle or fallback ownership", async () => {
    const listQueries = [];
    const h = await setup(async () => ({ data: [history()] }), CONFIG, async (options) => {
      listQueries.push(options);
      return { data: [
        { id: sessionID, directory, time: { updated: 10 } },
        { id: "ses_foreign", directory: directory + "-other", time: { updated: 20 } },
        { id: "ses_child", directory, parentID: sessionID, time: { updated: 30 } },
        { id: "ses_archived", directory, time: { updated: 40, archived: 50 } },
      ] };
    });
    await settle(h.plugin);
    assert.strictEqual(listQueries.length, 1);
    assert.strictEqual(listQueries[0].query.directory, directory);
    assert.ok(listQueries[0].query.limit > 0 && listQueries[0].query.limit <= 20);
    assert.strictEqual(h.queries.length, 1);
    assert.strictEqual(h.metadata().length, 1);
    assert.strictEqual(h.metadata()[0].cwd, directory);
    assert.ok(h.calls.every((call) => call.body.metadata_only));
    assert.strictEqual(h.plugin.__test._rootSessionId, null);
    assert.strictEqual(h.plugin.__test._lastSeenSessionId, null);
    assert.strictEqual(h.plugin.__test._sessionInstanceDirectoryById.size, 0);
    await emit(h.hooks, { type: "server.instance.disposed", properties: { directory } });
    await settle(h.plugin);
    assert.ok(h.calls.every((call) => call.body.metadata_only), "bootstrap-only sessions must not get SessionEnd");
    assert.strictEqual(h.plugin.__test._contextStateByInstance.size, 0);
  });

  it("discards an obsolete bootstrap list when a session is deleted while listing", async () => {
    const gate = deferred();
    let listed = false;
    const h = await setup(async () => ({ data: [history()] }), CONFIG, () => { listed = true; return gate.promise; });
    await settle(h.plugin);
    assert.strictEqual(listed, true);
    await emit(h.hooks, lifecycle("session.deleted", sessionID, directory));
    gate.resolve({ data: [{ id: sessionID, directory, time: { updated: 10 } }] });
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 0);
    assert.strictEqual(h.metadata().length, 0);
  });

  it("does not replace a session already observed live while bootstrap was listing", async () => {
    const gate = deferred();
    let listed = false;
    const h = await setup(async () => ({ data: [history(900)] }), CONFIG, () => { listed = true; return gate.promise; });
    await settle(h.plugin);
    assert.strictEqual(listed, true);
    await emit(h.hooks, { type: "message.updated", properties: { info: history(50).info } });
    await settle(h.plugin);
    gate.resolve({ data: [{ id: sessionID, directory, time: { updated: 10 } }] });
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 0);
    assert.deepStrictEqual(h.metadata().map((body) => body.context_usage.used), [50]);
  });

  it("caps bootstrap to the twenty most recent sessions without following history pages", async () => {
    const h = await setup(async () => ({ data: [] }), CONFIG, async () => ({ data:
      Array.from({ length: 30 }, (_, i) => ({ id: `ses_${i}`, directory, time: { updated: i } })),
    }));
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 20);
    assert.deepStrictEqual(h.queries.map((q) => q.path.id).sort(),
      Array.from({ length: 20 }, (_, i) => `ses_${i + 10}`).sort());
    assert.strictEqual(h.calls.length, 0);
  });

  it("honors the modern host dispose hook and cancels pending bootstrap without SessionEnd", async () => {
    const gate = deferred();
    let signal;
    const h = await setup(async () => ({ data: [history()] }), CONFIG,
      (options) => { signal = options.signal; return gate.promise; });
    await settle(h.plugin);
    assert.strictEqual(typeof h.hooks.dispose, "function");
    await h.hooks.dispose();
    assert.strictEqual(signal.aborted, true);
    gate.resolve({ data: [{ id: sessionID, directory }] });
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 0);
    assert.strictEqual(h.calls.length, 0);
    await emit(h.hooks, resumed());
    await settle(h.plugin);
    assert.strictEqual(h.queries.length, 0);
  });
});
