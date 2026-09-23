"use strict";

// opencode v2 runtime tests (issue #1039) — the `createOpencodeFamilyPluginV2`
// factory in hooks/opencode-family-plugin/core.mjs.
//
// The process runs with HOME pointed at a temp dir (set before the dynamic
// import, which is when core.mjs resolves ~/.clawd) and fetch is stubbed, so
// the evaluate-hook blocking POST and the state delivery queue run against
// captured in-memory calls. The mapping table mirrors the evidence captured in
// docs/investigations/opencode-v2-e1-evidence.md.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, before, after } = require("node:test");
const { pathToFileURL } = require("node:url");

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-v2-core-"));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
before(() => {
  process.env.HOME = TEMP_HOME;
  process.env.USERPROFILE = TEMP_HOME;
});
after(() => {
  process.env.HOME = ORIGINAL_HOME;
  process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  fs.rmSync(TEMP_HOME, { recursive: true, force: true });
});

const HOOKS_DIR = path.join(__dirname, "..", "hooks");
async function loadCore() {
  const modulePath = path.join(HOOKS_DIR, "opencode-family-plugin", "core.mjs");
  return import(pathToFileURL(modulePath).href);
}

const V2_PARAMS = Object.freeze({
  agentId: "opencode",
  hookSource: "opencode-plugin-v2",
  logFileName: "opencode-plugin-v2.log",
  sessionIdPrefix: "opencode:",
  pluginId: "clawd-on-desk-opencode",
  markerPluginDirName: "opencode-plugin",
});

// Fake fetch: records every call, answers as a Clawd-identity server.
function stubFetch(t) {
  const calls = [];
  let responder = () => ({ status: 200, headers: { get: () => CLAWD_ID }, text: async () => '{"decision":"allow"}' });
  const CLAWD_ID = "clawd-on-desk";
  const fake = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return responder(calls.length, calls[calls.length - 1]);
  };
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  t.after(() => { globalThis.fetch = original; });
  return {
    calls,
    respondWith(fn) { responder = fn; },
  };
}

function tick(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The strict permission-port reader requires a live-owner runtime.json with
// owner-only bytes; write one into the isolated HOME so evaluate tests have
// exactly one delivery candidate.
function writeRuntimeFile(t) {
  const clawdDir = path.join(TEMP_HOME, ".clawd");
  fs.mkdirSync(clawdDir, { recursive: true });
  const file = path.join(clawdDir, "runtime.json");
  fs.writeFileSync(file, JSON.stringify({
    app: "clawd-on-desk",
    port: 23334,
    ownerPid: process.pid,
  }), { mode: 0o600 });
  t.after(() => { try { fs.rmSync(file); } catch {} });
  return file;
}

async function makeDefinition() {
  const core = await loadCore();
  return { core, def: core.createOpencodeFamilyPluginV2(V2_PARAMS) };
}

describe("opencode v2 plugin definition", () => {
  it("requires all six identity params", async () => {
    const { createOpencodeFamilyPluginV2 } = await loadCore();
    assert.throws(() => createOpencodeFamilyPluginV2(), /agentId is required/);
    for (const key of Object.keys(V2_PARAMS)) {
      const params = { ...V2_PARAMS };
      delete params[key];
      assert.throws(() => createOpencodeFamilyPluginV2(params), new RegExp(`${key} is required`));
    }
  });

  it("default-exports exactly the { id, setup } definition surface", async () => {
    const { def } = await makeDefinition();
    assert.deepStrictEqual(Object.keys(def).sort(), ["id", "setup"]);
    assert.strictEqual(def.id, "clawd-on-desk-opencode");
    assert.strictEqual(typeof def.setup, "function");
  });
});

describe("opencode v2 event translation", () => {
  it("maps the evidence-anchored v2 event vocabulary", async () => {
    const { def } = await makeDefinition();
    const t = def.__test.translateV2Event;
    assert.deepStrictEqual(t("session.created", {}), { state: "idle", event: "SessionStart" });
    assert.deepStrictEqual(t("session.step.started", {}), { state: "thinking", event: "UserPromptSubmit" });
    assert.deepStrictEqual(t("session.reasoning.started", {}), { state: "thinking", event: "UserPromptSubmit" });
    assert.deepStrictEqual(t("session.status", { status: { type: "busy" } }), { state: "thinking", event: "UserPromptSubmit" });
    assert.deepStrictEqual(t("session.status", { status: { type: "idle" } }), { state: "attention", event: "Stop" });
    assert.deepStrictEqual(t("session.tool.called", {}), { state: "working", event: "PreToolUse" });
    assert.deepStrictEqual(t("session.tool.success", {}), { state: "working", event: "PostToolUse" });
    assert.deepStrictEqual(t("session.tool.error", {}), { state: "error", event: "PostToolUseFailure" });
    assert.deepStrictEqual(t("session.step.ended", { finish: "tool-calls" }), null);
    assert.deepStrictEqual(t("session.step.ended", { finish: "stop" }), { state: "attention", event: "Stop" });
    assert.deepStrictEqual(t("session.execution.succeeded", {}), { state: "attention", event: "Stop" });
    assert.deepStrictEqual(t("session.execution.failed", {}), { state: "error", event: "StopFailure" });
    assert.deepStrictEqual(t("session.error", {}), { state: "error", event: "StopFailure" });
    assert.deepStrictEqual(t("session.deleted", {}), { state: "sleeping", event: "SessionEnd" });
    // v1-era and unknown events must never map.
    assert.strictEqual(t("session.idle", {}), null);
    assert.strictEqual(t("message.part.updated", {}), null);
    assert.strictEqual(t("session.text.delta", {}), null);
    assert.strictEqual(t(null, {}), null);
  });
});

describe("opencode v2 event handler", () => {
  it("delivers the lifecycle chain with cwd, and ignores streaming noise", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const sid = "ses_v2chain";

    // Deliver each event before emitting the next (like a real stream spaced
    // out in time) so queued replaceable snapshots don't coalesce.
    def.__test.handleV2Event({
      type: "session.created",
      data: { sessionID: sid },
      location: { directory: "/tmp/proj" },
    });
    await tick();
    def.__test.handleV2Event({ type: "session.step.started", data: { sessionID: sid }, location: { directory: "/tmp/proj" } });
    await tick();
    def.__test.handleV2Event({ type: "session.text.delta", data: { sessionID: sid, delta: "hi" } });
    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: sid, id: "call_1", input: { command: "ls" } }, location: { directory: "/tmp/proj" } });
    await tick();
    def.__test.handleV2Event({ type: "session.step.ended", data: { sessionID: sid, finish: "tool-calls" } });
    def.__test.handleV2Event({ type: "session.tool.success", data: { sessionID: sid, id: "call_1" } });
    await tick();
    def.__test.handleV2Event({ type: "session.step.ended", data: { sessionID: sid, finish: "stop" } });
    await tick();
    def.__test.handleV2Event({ type: "session.execution.succeeded", data: { sessionID: sid } });
    await tick();

    const states = fetchStub.calls
      .filter((c) => c.url.endsWith("/state"))
      .map((c) => `${c.body.event}→${c.body.state}@${c.body.cwd}`);
    // PostToolUse dedups against PreToolUse (same working state), and
    // execution.succeeded dedups against step.ended stop — same v1 semantics.
    assert.deepStrictEqual(states, [
      "SessionStart→idle@/tmp/proj",
      "UserPromptSubmit→thinking@/tmp/proj",
      "PreToolUse→working@/tmp/proj",
      "Stop→attention@/tmp/proj",
    ]);
    for (const call of fetchStub.calls.filter((c) => c.url.endsWith("/state"))) {
      assert.strictEqual(call.body.agent_id, "opencode");
      assert.strictEqual(call.body.hook_source, "opencode-plugin-v2");
      assert.strictEqual(call.body.session_id, `opencode:${sid}`);
      // v2 runs in the shared service: no process-tree fields, ever.
      assert.strictEqual(call.body.source_pid, undefined);
      assert.strictEqual(call.body.pid_chain, undefined);
    }
  });

  it("pushes title and context-usage as metadata-only updates", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const sid = "ses_v2meta";

    def.__test.handleV2Event({ type: "session.renamed", data: { sessionID: sid, title: "Fix the flux" } });
    def.__test.handleV2Event({
      type: "session.usage.updated",
      data: { sessionID: sid, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 3 } } },
    });
    await tick();

    const metas = fetchStub.calls
      .filter((c) => c.url.endsWith("/state") && c.body.metadata_only === true);
    assert.strictEqual(metas.length, 2);
    assert.strictEqual(metas[0].body.session_title, "Fix the flux");
    assert.strictEqual(metas[0].body.event, "SessionUpdate");
    assert.strictEqual(metas[1].body.context_usage, 120);
  });

  it("omits cwd when the envelope has no location (fail-closed)", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    def.__test.handleV2Event({ type: "session.execution.succeeded", data: { sessionID: "ses_v2nocwd" } });
    await tick();
    const [call] = fetchStub.calls;
    assert.ok(call, "state delivered");
    assert.strictEqual(call.body.cwd, undefined);
  });
});

describe("opencode v2 permission evaluate hook", () => {
  function evaluation(overrides = {}) {
    return {
      sessionID: "ses_v2perm",
      action: "shell",
      resources: ["echo askme-123"],
      source: { type: "tool", id: "call_perm1" },
      effect: "ask",
      ...overrides,
    };
  }

  it("leaves a configured allow untouched and sends nothing", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const event = evaluation({ effect: "allow" });
    await def.__test.handleV2PermissionEvaluate(event);
    assert.strictEqual(event.effect, "allow");
    assert.strictEqual(fetchStub.calls.length, 0);
  });

  it("blocks on ask and applies the allow decision", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const event = evaluation();
    await def.__test.handleV2PermissionEvaluate(event);
    assert.strictEqual(event.effect, "allow");

    const [call] = fetchStub.calls;
    assert.ok(call.url.startsWith("http://127.0.0.1:"), call.url);
    assert.ok(call.url.endsWith("/permission"));
    assert.strictEqual(call.body.agent_id, "opencode");
    assert.strictEqual(call.body.hook_source, "opencode-plugin-v2");
    assert.strictEqual(call.body.tool_name, "shell");
    assert.strictEqual(call.body.session_id, "opencode:ses_v2perm");
    assert.deepStrictEqual(call.body.always, ["shell"]);
    assert.strictEqual(call.body.bridge_url, undefined, "v2 must not use the reverse bridge");
    assert.strictEqual(call.body.bridge_token, undefined);
  });

  it("records 'always' and auto-allows the next matching ask without a POST", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    fetchStub.respondWith(() => ({
      status: 200,
      headers: { get: () => "clawd-on-desk" },
      text: async () => '{"decision":"always"}',
    }));
    const first = evaluation();
    await def.__test.handleV2PermissionEvaluate(first);
    assert.strictEqual(first.effect, "allow");
    const postsAfterFirst = fetchStub.calls.length;

    const second = evaluation({ resources: ["rm -rf /"] });
    await def.__test.handleV2PermissionEvaluate(second);
    assert.strictEqual(second.effect, "allow");
    assert.strictEqual(fetchStub.calls.length, postsAfterFirst, "in-memory always must not re-POST");
  });

  it("applies deny with the message from Clawd", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    fetchStub.respondWith(() => ({
      status: 200,
      headers: { get: () => "clawd-on-desk" },
      text: async () => '{"decision":"deny","message":"nope"}',
    }));
    const event = evaluation();
    await def.__test.handleV2PermissionEvaluate(event);
    assert.strictEqual(event.effect, "deny");
    assert.strictEqual(event.message, "nope");
  });

  it("leaves the effect untouched on 204 / non-JSON / identity-less answers", async (t) => {
    const { def } = await makeDefinition();
    for (const responder of [
      () => ({ status: 204, headers: { get: () => "clawd-on-desk" }, text: async () => "" }),
      () => ({ status: 200, headers: { get: () => "clawd-on-desk" }, text: async () => "ok" }),
      () => ({ status: 200, headers: { get: () => null }, text: async () => '{"decision":"allow"}' }),
    ]) {
      const fetchStub = stubFetch(t);
      fetchStub.respondWith(responder);
      const event = evaluation();
      await def.__test.handleV2PermissionEvaluate(event);
      assert.strictEqual(event.effect, "ask", `effect must stay ask for ${responder}`);
    }
  });

  it("skips the POST entirely when the body is over budget", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const event = evaluation({ resources: ["x".repeat(600 * 1024)] });
    await def.__test.handleV2PermissionEvaluate(event);
    assert.strictEqual(event.effect, "ask");
    assert.strictEqual(fetchStub.calls.length, 0);
  });
});

describe("opencode v2 entry drift locks", () => {
  it("entry literals match the family registry's v2 fields", async () => {
    const source = fs.readFileSync(
      path.join(HOOKS_DIR, "opencode-plugin-v2", "index.mjs"),
      "utf8"
    );
    const family = require("../agents/opencode-family.js");
    const cfg = family.getFamilyConfig("opencode");
    assert.ok(source.includes('agentId: "opencode"'), "agentId literal");
    assert.ok(source.includes(`hookSource: "${cfg.v2HookSource}"`));
    assert.ok(source.includes(`pluginId: "${cfg.v2PluginId}"`));
    assert.ok(source.includes(`markerPluginDirName: "${cfg.pluginDirName}"`));
    assert.ok(source.includes(`sessionIdPrefix: "${cfg.sessionIdPrefix}"`));
    assert.ok(source.includes(`logFileName: "opencode-plugin-v2.log"`));
    // v2 entry must not import the SDK package (fails without plugin-local
    // node_modules) and must not add named exports.
    assert.ok(!/from ["']@opencode\//.test(source));
    assert.ok(!/export\s+(const|let|var|function|class|\{)/.test(source));
  });
});
