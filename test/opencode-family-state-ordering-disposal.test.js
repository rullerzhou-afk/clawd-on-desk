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
