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
    assert.deepStrictEqual(t("session.text.started", {}), { state: "thinking", event: "UserPromptSubmit" });
    assert.deepStrictEqual(t("session.status", { status: { type: "busy" } }), { state: "thinking", event: "UserPromptSubmit" });
    assert.deepStrictEqual(t("session.status", { status: { type: "idle" } }), { state: "attention", event: "Stop" });
    assert.deepStrictEqual(t("session.tool.called", {}), { state: "working", event: "PreToolUse", identity: null });
    assert.deepStrictEqual(t("session.tool.called", { id: "call_a" }), {
      state: "working", event: "PreToolUse", identity: "call_a\u0000running",
    });
    assert.deepStrictEqual(t("session.tool.success", {}), { state: "working", event: "PostToolUse", identity: null });
    assert.deepStrictEqual(t("session.tool.error", {}), { state: "error", event: "PostToolUseFailure", identity: null });
    assert.deepStrictEqual(t("session.tool.failed", { id: "call_b" }), {
      state: "error", event: "PostToolUseFailure", identity: "call_b\u0000error",
    });
    assert.deepStrictEqual(t("session.step.ended", { finish: "tool-calls" }), null);
    assert.deepStrictEqual(t("session.step.ended", { finish: "stop" }), { state: "attention", event: "Stop" });
    assert.deepStrictEqual(t("session.execution.succeeded", {}), { state: "attention", event: "Stop" });
    assert.deepStrictEqual(t("session.execution.interrupted", { reason: "user" }), { state: "error", event: "StopFailure" });
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
    // Tool lifecycle events are recap's tool-call signal and never dedupe
    // away (parallel tools repeat the working state); execution.succeeded
    // still dedups against step.ended stop — same v1 semantics.
    assert.deepStrictEqual(states, [
      "SessionStart→idle@/tmp/proj",
      "UserPromptSubmit→thinking@/tmp/proj",
      "PreToolUse→working@/tmp/proj",
      "PostToolUse→working@/tmp/proj",
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
      type: "session.step.ended",
      data: {
        sessionID: sid,
        finish: "tool-calls",
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 3 } },
      },
    });
    await tick();

    const metas = fetchStub.calls
      .filter((c) => c.url.endsWith("/state") && c.body.metadata_only === true);
    assert.strictEqual(metas.length, 2);
    assert.strictEqual(metas[0].body.session_title, "Fix the flux");
    assert.strictEqual(metas[0].body.event, "SessionUpdate");
    assert.deepStrictEqual(metas[1].body.context_usage, { used: 120, limit: null, source: "opencode" });
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

  it("issue #1039 follow-up: terminal session events abort only that session's pending approvals", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const pending = [];
    t.after(() => { for (const item of pending) item.reject(new Error("test cleanup")); });
    fetchStub.respondWith((_, call) => {
      if (!call.url.endsWith("/permission")) {
        return { status: 204, headers: { get: () => "clawd-on-desk" }, text: async () => "" };
      }
      return new Promise((resolve, reject) => {
        const item = { signal: call.options.signal, body: call.body, reject };
        pending.push(item);
        call.options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    for (const terminal of ["session.execution.interrupted", "session.execution.failed", "session.execution.succeeded", "session.deleted"]) {
      const sid = `ses_${terminal.replaceAll(".", "_")}`;
      const affected = evaluation({ sessionID: sid, source: { type: "tool", id: sid } });
      const other = evaluation({ sessionID: `${sid}_other`, source: { type: "tool", id: `${sid}_other` } });
      const first = def.__test.handleV2PermissionEvaluate(affected);
      const second = def.__test.handleV2PermissionEvaluate(other);
      await tick(10);
      const affectedPost = pending.find((item) => item.body.session_id === `opencode:${sid}`);
      const otherPost = pending.find((item) => item.body.session_id === `opencode:${sid}_other`);
      assert.ok(affectedPost && otherPost);
      def.__test.handleV2Event({ type: terminal, data: { sessionID: sid } });
      await tick(10);
      assert.strictEqual(affectedPost.signal.aborted, true, terminal);
      assert.strictEqual(otherPost.signal.aborted, false, "other session remains pending");
      otherPost.signal.dispatchEvent(new Event("abort"));
      await Promise.all([first, second]);
      assert.strictEqual(affected.effect, "ask", "cancellation cannot grant a decision");
    }
  });

  it("issue #1039 follow-up: a late approval response cannot decide an interrupted ask", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    let answer;
    fetchStub.respondWith((_, call) => call.url.endsWith("/permission")
      ? new Promise((resolve) => { answer = () => resolve({
        status: 200, headers: { get: () => "clawd-on-desk" }, text: async () => '{"decision":"allow"}',
      }); })
      : { status: 204, headers: { get: () => "clawd-on-desk" }, text: async () => "" });
    const event = evaluation({ sessionID: "ses_late" });
    const awaiting = def.__test.handleV2PermissionEvaluate(event);
    await tick(10);
    const call = fetchStub.calls.find((item) => item.url.endsWith("/permission"));
    assert.ok(call && answer);
    def.__test.handleV2Event({ type: "session.execution.interrupted", data: { sessionID: "ses_late" } });
    assert.strictEqual(call.options.signal.aborted, true);
    answer();
    await awaiting;
    assert.strictEqual(event.effect, "ask");
  });

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

  it("PR #1045 follow-up: forwards every resource without a count cap", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const resources = Array.from({ length: 20 }, (_, i) => `res-${i}`);
    const event = evaluation({ resources });
    await def.__test.handleV2PermissionEvaluate(event);
    assert.strictEqual(fetchStub.calls.length, 1);
    assert.deepStrictEqual(fetchStub.calls[0].body.tool_input.resources, resources);
  });

  it("PR #1045 follow-up: never truncates a large object resource", async (t) => {
    const { def } = await makeDefinition();
    const big = { resource: "y".repeat(5000) };
    const body = def.__test.buildV2PermissionBody(evaluation({ resources: [big] }), "v2:call_obj");
    assert.deepStrictEqual(body.tool_input, { resource: JSON.stringify(big) });
    assert.ok(body.tool_input.resource.length > 4096, "the object must not be truncated at 4096 chars");
  });

  it("PR #1045 follow-up: a non-200 response is never a decision", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    for (const [status, decision] of [[403, "allow"], [500, "deny"]]) {
      fetchStub.calls.length = 0;
      fetchStub.respondWith(() => ({
        status,
        headers: { get: () => "clawd-on-desk" },
        text: async () => JSON.stringify({ decision }),
      }));
      const event = evaluation({ source: { type: "tool", id: `call_${status}` } });
      await def.__test.handleV2PermissionEvaluate(event);
      assert.strictEqual(event.effect, "ask", `status=${status} decision=${decision}`);
      assert.strictEqual(event.message, undefined);
      assert.strictEqual(fetchStub.calls.length, 1, "the response is still read");
    }
  });

  // E1/E2 evidence (docs/investigations/opencode-v2-e1-evidence.md): ONE tool
  // call can raise several DISTINCT asks (external_directory + edit) that share
  // source.id / request_id. Dedup must be ask-scoped, never tool-call-scoped, or
  // the second ask silently reuses the first decision (and an `always` grants a
  // rule for an action the user never saw).
  it("forwards distinct asks that share one tool-call id (allow)", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const first = evaluation({
      action: "external_directory",
      resources: ["/outside/dir/*"],
      source: { type: "tool", id: "call_same" },
    });
    const second = evaluation({
      action: "edit",
      resources: ["/outside/dir/file.txt"],
      source: { type: "tool", id: "call_same" },
    });
    await def.__test.handleV2PermissionEvaluate(first);
    await def.__test.handleV2PermissionEvaluate(second);
    assert.strictEqual(first.effect, "allow");
    assert.strictEqual(second.effect, "allow");
    assert.deepStrictEqual(fetchStub.calls.map((c) => c.body.tool_name), ["external_directory", "edit"]);
  });

  it("does not record an always rule for a distinct ask the user never saw", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    fetchStub.respondWith((n) => ({
      status: 200,
      headers: { get: () => "clawd-on-desk" },
      text: async () => JSON.stringify({ decision: n === 1 ? "always" : "allow" }),
    }));
    await def.__test.handleV2PermissionEvaluate(evaluation({
      action: "external_directory",
      resources: ["/outside/dir/*"],
      source: { type: "tool", id: "call_same" },
    }));
    await def.__test.handleV2PermissionEvaluate(evaluation({
      action: "edit",
      resources: ["/outside/dir/file.txt"],
      source: { type: "tool", id: "call_same" },
    }));
    assert.strictEqual(
      def.__test._alwaysAllowedBySessionAction.has("opencode:ses_v2perm\u0000edit"),
      false,
      "edit must not inherit the external_directory always rule"
    );
    assert.strictEqual(fetchStub.calls.length, 2, "both distinct asks were forwarded");
  });

  it("distinguishes asks by resources within one tool call and action", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    // Same session, tool-call id and action — only the resources differ.
    await def.__test.handleV2PermissionEvaluate(evaluation({
      action: "external_directory",
      resources: ["/outside/one/*"],
      source: { type: "tool", id: "call_res" },
    }));
    await def.__test.handleV2PermissionEvaluate(evaluation({
      action: "external_directory",
      resources: ["/outside/two/*"],
      source: { type: "tool", id: "call_res" },
    }));
    assert.strictEqual(fetchStub.calls.length, 2, "each distinct resource set is its own ask");
  });

  it("distinguishes asks by action within one tool call and resources", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    await def.__test.handleV2PermissionEvaluate(evaluation({
      action: "external_directory",
      resources: ["/outside/dir/*"],
      source: { type: "tool", id: "call_action" },
    }));
    await def.__test.handleV2PermissionEvaluate(evaluation({
      action: "edit",
      resources: ["/outside/dir/*"],
      source: { type: "tool", id: "call_action" },
    }));
    assert.strictEqual(fetchStub.calls.length, 2, "action is part of the ask identity");
  });

  // A later ask with identical content is a NEW ask and must reach Clawd again.
  // Only a currently-registered hook may answer; there is no content cache.
  it("re-asks Clawd after a no-decision (204) for an identical ask", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    fetchStub.respondWith(() => ({
      status: 204,
      headers: { get: () => "clawd-on-desk" },
      text: async () => "",
    }));
    const first = evaluation();
    await def.__test.handleV2PermissionEvaluate(first);
    assert.strictEqual(first.effect, "ask");
    const second = evaluation();
    await def.__test.handleV2PermissionEvaluate(second);
    assert.strictEqual(second.effect, "ask");
    assert.strictEqual(fetchStub.calls.length, 2, "an identical later ask is forwarded again");
  });

  it("re-asks Clawd after an allow for an identical ask", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const first = evaluation();
    await def.__test.handleV2PermissionEvaluate(first);
    assert.strictEqual(first.effect, "allow");
    const second = evaluation();
    await def.__test.handleV2PermissionEvaluate(second);
    assert.strictEqual(second.effect, "allow");
    assert.strictEqual(fetchStub.calls.length, 2, "an allow is not cached across asks");
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

// ---------------------------------------------------------------------------
// Review follow-ups (PR #1053): turn-start reporting, step-token context
// usage, recovered child identity, bounded hydration, interruption
// semantics, subscription failures, single V2 activation, per-copy gates.
// ---------------------------------------------------------------------------

// Minimal v2 ctx: a controllable event queue plus the optional model/session
// APIs the runtime consults for limits and identity hydration.
function v2Ctx(overrides = {}) {
  const queue = [];
  let notify = null;
  return {
    push(envelope) {
      queue.push(envelope);
      if (notify) {
        const wake = notify;
        notify = null;
        wake();
      }
    },
    ctx: {
      app: { name: "opencode", version: "2.0.15" },
      event: {
        subscribe() {
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  while (queue.length === 0) {
                    await new Promise((resolve) => { notify = resolve; });
                  }
                  return { value: queue.shift(), done: false };
                },
              };
            },
          };
        },
      },
      model: { list: async () => ({ data: [] }) },
      session: { get: async () => ({}) },
      ...overrides,
    },
  };
}

describe("opencode v2 review follow-ups", () => {
  it("reports thinking and a Stop for each consecutive text-only turn", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const sid = "ses_textturns";
    const turn = () => [
      { type: "session.step.started", data: { sessionID: sid } },
      { type: "session.reasoning.started", data: { sessionID: sid } },
      { type: "session.text.started", data: { sessionID: sid } },
      { type: "session.step.ended", data: { sessionID: sid, finish: "stop" } },
      { type: "session.execution.succeeded", data: { sessionID: sid } },
    ];
    for (const envelope of turn()) def.__test.handleV2Event(envelope);
    await tick(60);
    for (const envelope of turn()) def.__test.handleV2Event(envelope);
    await tick(60);

    const posts = fetchStub.calls.filter((c) => c.body && c.body.session_id === `opencode:${sid}`);
    assert.strictEqual(
      posts.filter((c) => c.body.event === "Stop").length,
      2,
      "each text-only turn ends with its own Stop"
    );
    assert.ok(
      posts.filter((c) => c.body.event === "UserPromptSubmit").length >= 2,
      "each text-only turn reports thinking"
    );
  });

  it("reports step tokens with the model limit resolved from the registry", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const { ctx } = v2Ctx({
      model: { list: async () => ({ data: [{ id: "gpt", providerID: "prov", limit: { context: 100000 } }] }) },
    });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);

    const sid = "ses_usage";
    def.__test.handleV2Event({ type: "session.created", data: { sessionID: sid } });
    def.__test.handleV2Event({
      type: "session.step.started",
      data: { sessionID: sid, model: { id: "gpt", providerID: "prov" } },
    });
    def.__test.handleV2Event({
      type: "session.step.ended",
      data: { sessionID: sid, finish: "stop", tokens: { input: 5, output: 4, reasoning: 3, cache: { read: 2, write: 1 } } },
    });
    await tick(80);

    const usages = fetchStub.calls.filter((c) => c.body && c.body.context_usage && c.body.session_id === `opencode:${sid}`);
    assert.ok(usages.length >= 1, "context usage POST");
    assert.deepStrictEqual(usages[usages.length - 1].body.context_usage, {
      used: 15,
      limit: 100000,
      source: "opencode",
    });
  });

  it("uses the created default model and re-pushes a first-observed sample", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const { ctx } = v2Ctx({
      model: { list: async () => ({ data: [{ id: "gpt", providerID: "prov", limit: { context: 100000 } }] }) },
      session: {
        get: async (input) => (input.sessionID === "ses_firstseen"
          ? { model: { id: "gpt", providerID: "prov" } }
          : {}),
      },
    });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);

    // Default model: created.model present, no step.started.
    def.__test.handleV2Event({
      type: "session.created",
      data: { sessionID: "ses_default", model: { id: "gpt", providerID: "prov" } },
    });
    def.__test.handleV2Event({
      type: "session.step.ended",
      data: { sessionID: "ses_default", finish: "stop", tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
    });

    // First-observed sample: only a step end exists; the identity hydration
    // supplies the model and the sample is re-pushed with the limit.
    def.__test.handleV2Event({
      type: "session.step.ended",
      data: { sessionID: "ses_firstseen", finish: "stop", tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } },
    });
    await tick(100);

    for (const sid of ["ses_default", "ses_firstseen"]) {
      const usages = fetchStub.calls.filter((c) => c.body && c.body.context_usage && c.body.session_id === `opencode:${sid}`);
      assert.ok(usages.length >= 1, `context usage POST for ${sid}`);
      assert.strictEqual(usages[usages.length - 1].body.context_usage.limit, 100000, `${sid} resolves its limit`);
    }
  });

  it("restores parent identity for a recovered child session without a lifecycle", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { ctx } = v2Ctx({
      session: {
        get: async () => {
          await gate;
          return { parentID: "ses_parent", title: "Child", location: { directory: "C:/proj" } };
        },
      },
    });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);

    // Both tool calls arrive while the lookup is still pending: they must be
    // staged rather than reported as root (the old test slept between them,
    // which hid this race).
    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: "ses_child", id: "call_c1" } });
    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: "ses_child", id: "call_c2" } });
    await tick(20);
    assert.strictEqual(
      fetchStub.calls.filter((c) => c.body && c.body.session_id === "opencode:ses_child").length,
      0,
      "no identity-dependent report before hydration resolves"
    );

    release();
    await tick(40);
    // A turn end after hydration still carries the recovered child classification.
    def.__test.handleV2Event({ type: "session.execution.succeeded", data: { sessionID: "ses_child" } });
    await tick(40);

    const posted = fetchStub.calls
      .filter((c) => c.body && c.body.session_id === "opencode:ses_child")
      .map((c) => c.body);
    const lifecycle = posted.filter((b) => b.event !== "SessionUpdate");
    assert.deepStrictEqual(
      lifecycle.map((b) => b.event),
      ["PreToolUse", "PreToolUse", "SessionEnd"],
      "each staged tool call replays exactly once; child completion is a SessionEnd"
    );
    for (const body of lifecycle) assert.strictEqual(body.headless, true, "every child report stays headless");
    assert.ok(!lifecycle.some((b) => b.event === "Stop"), "child completion is never a root Stop");
    assert.ok(!lifecycle.some((b) => b.event === "SessionStart"), "hydration invents no lifecycle");
    assert.ok(posted.some((b) => b.event === "SessionUpdate" && b.session_title === "Child"), "hydrated title reaches metadata");
  });

  it("keeps other sessions flowing while one identity lookup hangs", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const { ctx } = v2Ctx({
      session: {
        get: (input) => (input.sessionID === "ses_hung"
          ? new Promise(() => {})
          : Promise.resolve({})),
      },
    });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);

    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: "ses_hung", id: "call_h1" } });
    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: "ses_fast", id: "call_f1" } });
    await tick(60);

    const fast = fetchStub.calls.filter((c) => c.body && c.body.session_id === "opencode:ses_fast");
    assert.ok(fast.length > 0, "an unrelated session must not wait behind a hung lookup");
  });

  it("never retries a failed identity lookup", async (t) => {
    let calls = 0;
    const { def } = await makeDefinition();
    const { ctx } = v2Ctx({
      session: {
        get: async () => {
          calls += 1;
          throw new Error("lookup failed");
        },
      },
    });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);

    for (let i = 0; i < 3; i += 1) {
      def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: "ses_fail", id: `call_f${i}` } });
    }
    await tick(60);
    assert.strictEqual(calls, 1, "a failed lookup is attempted once");
  });

  it("an interruption clears state without counting a completed turn", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: "ses_int", id: "call_int" } });
    def.__test.handleV2Event({
      type: "session.execution.interrupted",
      data: { sessionID: "ses_int", reason: "user" },
    });
    await tick(60);

    const posts = fetchStub.calls.filter((c) => c.body && c.body.session_id === "opencode:ses_int");
    const last = posts[posts.length - 1];
    assert.deepStrictEqual(
      { state: last.body.state, event: last.body.event },
      { state: "error", event: "StopFailure" }
    );

    const { mapRecapMetrics } = require("../src/recap-metrics");
    assert.deepStrictEqual(
      mapRecapMetrics({ agentId: "opencode", event: last.body.event, completionAccepted: true }),
      ["activity"],
      "a cancelled turn must not increment completed turns"
    );
  });

  it("delivers each tool lifecycle identity exactly once", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const duplicate = { type: "session.tool.called", data: { sessionID: "ses_tool", id: "call_dup", input: {} } };
    def.__test.handleV2Event(duplicate);
    def.__test.handleV2Event(duplicate);
    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: "ses_tool", id: "call_dup2", input: {} } });
    await tick(60);

    const pres = fetchStub.calls.filter((c) => c.body && c.body.event === "PreToolUse" && c.body.session_id === "opencode:ses_tool");
    assert.strictEqual(pres.length, 2, "one PreToolUse per call identity");
  });

  it("classifies subscription aborts and surfaces unexpected stream failures", async (t) => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    t.after(() => process.removeListener("unhandledRejection", onRejection));

    const { def } = await makeDefinition();
    const cleanupBroken = await def.setup({
      app: {},
      event: {
        subscribe() {
          return {
            [Symbol.asyncIterator]() {
              return { next: async () => { throw new Error("stream broke"); } };
            },
          };
        },
      },
    });
    t.after(cleanupBroken);
    await tick(40);
    await def.__test.flushDebugLog();
    assert.match(
      fs.readFileSync(def.__test._debugLogPath, "utf8"),
      /EVENT stream error: stream broke/
    );

    // A dispose abort is intentional and must be logged as such. The next
    // setup resets the shared debug log, so read the first case before.
    const { def: def2 } = await makeDefinition();
    const cleanup = await def2.setup({
      app: {},
      event: {
        subscribe({ signal }) {
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise((_, reject) => {
                  signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
                }),
              };
            },
          };
        },
      },
    });
    await cleanup();
    await tick(40);
    await def2.__test.flushDebugLog();
    assert.match(
      fs.readFileSync(def2.__test._debugLogPath, "utf8"),
      /EVENT stream aborted by dispose/
    );
    assert.deepStrictEqual(rejections, [], "stream failures must not become unhandled rejections");
  });
});

// ---------------------------------------------------------------------------
// PR #1053 review: recovered-child identity hydration vs lifecycle dispatch.
// A recovered session's first events race the async ctx.session.get lookup. If
// they are dispatched before it settles, a child's tool call becomes a root
// PreToolUse and its turn end a root Stop, so HUD, completion and recap
// over-report. These lock the staging/replay contract.
// ---------------------------------------------------------------------------

function deferredLookup() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("opencode v2 recovered-child identity race", () => {
  it("stages a recovered child's tool + turn end until identity resolves", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const gate = deferredLookup();
    const { ctx } = v2Ctx({ session: { get: () => gate.promise } });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);
    const sid = "ses_race";

    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: sid, id: "call_race" } });
    def.__test.handleV2Event({ type: "session.execution.succeeded", data: { sessionID: sid } });
    await tick(20);
    assert.strictEqual(
      fetchStub.calls.filter((c) => c.body && c.body.session_id === `opencode:${sid}`).length,
      0,
      "nothing is posted for the session before hydration resolves"
    );

    gate.resolve({ parentID: "ses_root", title: "Recovered", location: { directory: "/tmp/child" } });
    await tick(40);

    const posted = fetchStub.calls
      .filter((c) => c.body && c.body.session_id === `opencode:${sid}`)
      .map((c) => c.body);
    const pres = posted.filter((b) => b.event === "PreToolUse");
    assert.strictEqual(pres.length, 1, "PreToolUse replays exactly once");
    assert.strictEqual(pres[0].headless, true);
    assert.strictEqual(pres[0].cwd, "/tmp/child", "hydrated cwd reaches the replayed event");
    assert.strictEqual(posted.filter((b) => b.event === "Stop").length, 0, "no root Stop");
    assert.strictEqual(posted.filter((b) => b.event === "SessionEnd").length, 1, "exactly one SessionEnd");
    const end = posted.find((b) => b.event === "SessionEnd");
    assert.strictEqual(end.headless, true);
    assert.strictEqual(end.state, "sleeping");
  });

  it("treats a child's first immediate turn end as SessionEnd", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const { ctx } = v2Ctx({ session: { get: async () => ({ parentID: "ses_root" }) } });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);

    // The lookup resolves on its own but never before this synchronous event.
    def.__test.handleV2Event({ type: "session.execution.succeeded", data: { sessionID: "ses_immediate" } });
    def.__test.handleV2Event({ type: "session.step.ended", data: { sessionID: "ses_step", finish: "stop" } });
    await tick(40);

    for (const sid of ["ses_immediate", "ses_step"]) {
      const posted = fetchStub.calls
        .filter((c) => c.body && c.body.session_id === `opencode:${sid}`)
        .map((c) => c.body);
      assert.strictEqual(posted.filter((b) => b.event === "Stop").length, 0, `${sid}: never a root Stop`);
      assert.strictEqual(posted.filter((b) => b.event === "SessionEnd").length, 1, `${sid}: one SessionEnd`);
    }
  });

  it("replays staged events as root in order when hydration fails", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const gate = deferredLookup();
    const { ctx } = v2Ctx({ session: { get: () => gate.promise } });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);
    const sid = "ses_failopen";

    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: sid, id: "call_fo" } });
    def.__test.handleV2Event({ type: "session.tool.success", data: { sessionID: sid, id: "call_fo" } });
    def.__test.handleV2Event({ type: "session.execution.succeeded", data: { sessionID: sid } });
    gate.reject(new Error("lookup down"));
    await tick(40);

    const posted = fetchStub.calls
      .filter((c) => c.body && c.body.session_id === `opencode:${sid}`)
      .map((c) => c.body);
    assert.deepStrictEqual(posted.map((b) => b.event), ["PreToolUse", "PostToolUse", "Stop"]);
    for (const body of posted) assert.notStrictEqual(body.headless, true, "failed lookup fails open as root");
  });

  it("does not let a hung child lookup delay another session", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const hung = deferredLookup();
    const { ctx } = v2Ctx({
      session: { get: async (input) => (input.sessionID === "ses_hung2" ? hung.promise : {}) },
    });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);

    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: "ses_hung2", id: "call_h2" } });
    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: "ses_free2", id: "call_f2" } });
    await tick(40);

    const free = fetchStub.calls.filter((c) => c.body && c.body.session_id === "opencode:ses_free2");
    assert.strictEqual(free.length, 1, "the unrelated session is not held back");
    assert.strictEqual(free[0].body.event, "PreToolUse");
    assert.strictEqual(
      fetchStub.calls.filter((c) => c.body && c.body.session_id === "opencode:ses_hung2").length,
      0,
      "the hung session stays staged"
    );
  });

  it("hard-caps staged identity events with an explicit drop-oldest overflow", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const gate = deferredLookup();
    const { ctx } = v2Ctx({ session: { get: () => gate.promise } });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);
    const sid = "ses_capped";
    const cap = def.__test._identityPendingMax;

    for (let i = 0; i < cap + 5; i += 1) {
      def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: sid, id: `call_cap_${i}` } });
    }
    const staged = def.__test._pendingIdentityBySession.get(`opencode:${sid}`);
    assert.strictEqual(staged.length, cap, "staged queue is hard-bounded");
    assert.strictEqual(staged[0].mapped.identity, "call_cap_5\u0000running", "overflow drops the oldest");

    gate.resolve({});
    await tick(60);
    assert.strictEqual(def.__test._pendingIdentityBySession.has(`opencode:${sid}`), false, "staging drains");
    assert.ok(fetchStub.calls.some((c) => c.body && c.body.session_id === `opencode:${sid}`));
  });

  it("lets a live session.created supersede a late recovery lookup", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const gate = deferredLookup();
    const { ctx } = v2Ctx({ session: { get: () => gate.promise } });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);
    const sid = "ses_live";

    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: sid, id: "call_live" } });
    // Live creation arrives before the stale lookup resolves: it is authoritative.
    def.__test.handleV2Event({ type: "session.created", data: { sessionID: sid } });
    await tick(20);
    const pre = fetchStub.calls.filter((c) => c.body && c.body.session_id === `opencode:${sid}` && c.body.event === "PreToolUse");
    assert.strictEqual(pre.length, 1);
    assert.notStrictEqual(pre[0].body.headless, true, "flushed with the live root classification");

    gate.resolve({ parentID: "ses_parent" });
    await tick(40);
    assert.strictEqual(
      def.__test._sessionParentById.has(`opencode:${sid}`),
      false,
      "a stale lookup must not set a parent after a live creation"
    );
  });

  it("replays a duplicate staged tool event exactly once", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const gate = deferredLookup();
    const { ctx } = v2Ctx({ session: { get: () => gate.promise } });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);
    const sid = "ses_dup";
    const duplicate = { type: "session.tool.called", data: { sessionID: sid, id: "call_dup9" } };
    def.__test.handleV2Event(duplicate);
    def.__test.handleV2Event(duplicate);
    gate.resolve({ parentID: "ses_parent" });
    await tick(40);
    const pres = fetchStub.calls.filter(
      (c) => c.body && c.body.session_id === `opencode:${sid}` && c.body.event === "PreToolUse"
    );
    assert.strictEqual(pres.length, 1);
  });

  it("rehydrates after dispose even when the pending lookup staged nothing", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const sid = "ses_rehydrate";

    // An ignored/metadata-only event opens a lookup but stages no mapped event.
    const cleanup1 = await def.setup({ app: {}, session: { get: () => new Promise(() => {}) } });
    def.__test.handleV2Event({ type: "session.usage.updated", data: { sessionID: sid } });
    await tick(20);
    assert.strictEqual(def.__test._hydrationState.get(`opencode:${sid}`), "pending");
    assert.deepStrictEqual(def.__test._pendingIdentityBySession.get(`opencode:${sid}`), []);

    // Dispose must clear the pending state even though the queue is empty.
    await cleanup1();
    assert.strictEqual(def.__test._hydrationState.has(`opencode:${sid}`), false, "pending state is cleared");
    assert.strictEqual(def.__test._pendingIdentityBySession.has(`opencode:${sid}`), false, "empty gate is cleared");

    // Re-setup with a working lookup must hydrate the same session from scratch.
    const cleanup2 = await def.setup({ app: {}, session: { get: async () => ({ parentID: "ses_parent" }) } });
    t.after(cleanup2);
    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: sid, id: "call_rehydrate" } });
    await tick(40);

    const posts = fetchStub.calls.filter((c) => c.body && c.body.session_id === `opencode:${sid}`);
    assert.strictEqual(posts.length, 1, "the event is not left permanently staged");
    assert.strictEqual(posts[0].body.event, "PreToolUse");
    assert.strictEqual(posts[0].body.headless, true, "rehydrated with the recovered child identity");
  });

  it("does not let a mid-replay terminal coalesce a staged event", async (t) => {
    const calls = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, options = {}) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) await firstGate;
      return {
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === "x-clawd-server" ? "clawd-on-desk" : null) },
        text: async () => "",
      };
    };
    t.after(() => { globalThis.fetch = original; });

    const { def } = await makeDefinition();
    let resolveIdentity;
    const identityGate = new Promise((resolve) => { resolveIdentity = resolve; });
    const cleanup = await def.setup({ app: {}, session: { get: () => identityGate } });
    t.after(cleanup);
    const sid = "ses_midflush";

    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: sid, id: "call_mid" } });
    resolveIdentity({ parentID: "ses_root", title: "Child" });
    // Wait until the hydration title POST is in flight: it is blocking the
    // serial per-session FIFO while the staged PreToolUse waits to drain.
    while (calls.length === 0) await tick(1);

    def.__test.handleV2Event({ type: "session.execution.succeeded", data: { sessionID: sid } });
    releaseFirst();
    await tick(80);

    const events = calls
      .filter((b) => b.session_id === `opencode:${sid}`)
      .map((b) => ({ event: b.event, headless: b.headless }));
    assert.deepStrictEqual(events, [
      { event: "SessionUpdate", headless: undefined },
      { event: "PreToolUse", headless: true },
      { event: "SessionEnd", headless: true },
    ]);
    assert.ok(!events.some((e) => e.event === "Stop"), "no root Stop");
  });

  it("orders a live session.created behind already-staged events", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const gate = deferredLookup();
    const { ctx } = v2Ctx({ session: { get: () => gate.promise } });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);
    const sid = "ses_created_order";

    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: sid, id: "call_co" } });
    // Live creation arrives with no parent: it supersedes the lookup and must
    // be delivered after the already-staged tool event, not raced with it.
    def.__test.handleV2Event({ type: "session.created", data: { sessionID: sid } });
    await tick(30);

    const events = fetchStub.calls
      .filter((c) => c.body && c.body.session_id === `opencode:${sid}`)
      .map((c) => c.body.event);
    assert.deepStrictEqual(events, ["PreToolUse", "SessionStart"]);

    gate.resolve({ parentID: "ses_parent" });
    await tick(30);
    assert.strictEqual(
      def.__test._sessionParentById.has(`opencode:${sid}`),
      false,
      "a stale lookup must not set a parent after a live creation"
    );
    const after = fetchStub.calls
      .filter((c) => c.body && c.body.session_id === `opencode:${sid}`)
      .map((c) => c.body.event);
    assert.deepStrictEqual(after, ["PreToolUse", "SessionStart"], "no late duplicate or loss");
  });

  it("stages a session.deleted turn end until a recovered child resolves", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const gate = deferredLookup();
    const { ctx } = v2Ctx({ session: { get: () => gate.promise } });
    const cleanup = await def.setup(ctx);
    t.after(cleanup);
    const sid = "ses_deleted";

    def.__test.handleV2Event({ type: "session.deleted", data: { sessionID: sid } });
    await tick(20);
    assert.strictEqual(
      fetchStub.calls.filter((c) => c.body && c.body.session_id === `opencode:${sid}`).length,
      0,
      "session.deleted is staged while identity is pending"
    );

    gate.resolve({ parentID: "ses_parent" });
    await tick(40);
    const ends = fetchStub.calls.filter(
      (c) => c.body && c.body.session_id === `opencode:${sid}` && c.body.event === "SessionEnd"
    );
    assert.strictEqual(ends.length, 1, "exactly one SessionEnd");
    assert.strictEqual(ends[0].body.headless, true);
    assert.strictEqual(ends[0].body.state, "sleeping");
  });

  it("discards staged recovery events on dispose", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const gate = deferredLookup();
    const { ctx } = v2Ctx({ session: { get: () => gate.promise } });
    const cleanup = await def.setup(ctx);
    const sid = "ses_dispose";

    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: sid, id: "call_dispose" } });
    await cleanup();
    assert.strictEqual(def.__test._pendingIdentityBySession.size, 0, "staging is discarded on dispose");
    gate.resolve({ parentID: "ses_parent" });
    await tick(40);
    assert.strictEqual(
      fetchStub.calls.filter((c) => c.body && c.body.session_id === `opencode:${sid}`).length,
      0,
      "a late lookup after dispose must not post"
    );
  });
});

describe("opencode v2 activation and ownership gates", () => {
  it("keeps exactly one V2-valid implementation across the dual entries", async () => {
    const v1 = await import(pathToFileURL(path.join(HOOKS_DIR, "opencode-plugin", "index.mjs")).href);
    const v2 = await import(pathToFileURL(path.join(HOOKS_DIR, "opencode-plugin-v2", "index.mjs")).href);
    assert.strictEqual(typeof v1.default, "function", "the v1 entry stays a function (the v2 loader rejects it)");
    assert.strictEqual(typeof v2.default, "object");
    assert.strictEqual(v2.default.id, "clawd-on-desk-opencode");
  });

  it("keeps an orphan managed copy inert even when a live copy is active", async (t) => {
    const fetchStub = stubFetch(t);
    const live = await makeDefinition();
    const liveCtx = v2Ctx();
    const liveCleanup = await live.def.setup(liveCtx.ctx);
    t.after(liveCleanup);

    const genDir = path.join(TEMP_HOME, "homes", "cfg", "generations", "a".repeat(64), "opencode-family-plugin");
    fs.mkdirSync(genDir, { recursive: true });
    for (const name of ["core.mjs", "session-ids.mjs"]) {
      fs.copyFileSync(path.join(HOOKS_DIR, "opencode-family-plugin", name), path.join(genDir, name));
    }
    const orphanCore = await import(pathToFileURL(path.join(genDir, "core.mjs")).href);
    const orphan = orphanCore.createOpencodeFamilyPluginV2(V2_PARAMS);
    const orphanCtx = v2Ctx();
    const orphanCleanup = await orphan.setup(orphanCtx.ctx);
    t.after(orphanCleanup);

    const envelope = { type: "session.created", data: { sessionID: "ses_copy" } };
    liveCtx.push(envelope);
    orphanCtx.push(envelope);
    await tick(80);

    assert.strictEqual(orphan.__test._lastStatePerSession.size, 0, "orphan copy stays inert");
    const starts = fetchStub.calls.filter((c) => c.body && c.body.event === "SessionStart");
    assert.strictEqual(starts.length, 1, "only the live copy reports");
  });
});

// ---------------------------------------------------------------------------
// opencode upstream v2.0.15 hook lifecycle
// (packages/plugin/src/promise/registration.ts; packages/plugin/src/promise/
// adapter.ts): `ctx.permission.hook()` returns Promise<Registration>, the host
// disposes registrations when the plugin scope closes, and setup's cleanup is
// awaited. Reload must not leak a live hook, and every ask is forwarded
// independently — there is no content de-dup.
// ---------------------------------------------------------------------------

// Fake host matching the upstream shape: hook() returns Promise<Registration>,
// tracks currently-live registrations (what the host would dispatch to), and
// supports deferred/rejected registration for lifecycle tests.
function v2SetupCtx(overrides = {}) {
  const queue = [];
  const waiters = [];
  const registrations = new Set();
  const handlers = [];
  let hookPlan = null;
  let disposePlan = null;
  let disposedCount = 0;
  let subscribedCount = 0;
  const ctx = {
    app: { name: "opencode", version: "2.0.15" },
    event: {
      subscribe({ signal } = {}) {
        subscribedCount += 1;
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (signal && signal.aborted) {
                  return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                }
                if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
                return new Promise((resolve, reject) => {
                  const waiter = { resolve };
                  waiters.push(waiter);
                  if (signal) {
                    signal.addEventListener("abort", () => {
                      const idx = waiters.indexOf(waiter);
                      if (idx >= 0) waiters.splice(idx, 1);
                      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                    }, { once: true });
                  }
                });
              },
            };
          },
        };
      },
    },
    permission: {
      hook(_name, handler) {
        handlers.push(handler);
        const planned = hookPlan ? hookPlan(handler) : Promise.resolve();
        return Promise.resolve(planned).then(() => {
          registrations.add(handler);
          return {
            dispose: async () => {
              registrations.delete(handler);
              disposedCount += 1;
              if (disposePlan) await disposePlan();
            },
          };
        });
      },
    },
    ...overrides,
  };
  return {
    ctx,
    handlers,
    get active() { return [...registrations]; },
    get disposedCount() { return disposedCount; },
    get subscribed() { return subscribedCount; },
    setHookPlan(fn) { hookPlan = fn; },
    setDisposePlan(fn) { disposePlan = fn; },
    // Mirror upstream hooks.ts trigger(): snapshot the live callback list at
    // dispatch start, then await each callback in sequence with the SAME event.
    async dispatch(event) {
      const list = [...registrations];
      for (const handler of list) {
        await handler(event);
      }
      return event;
    },
    push(envelope) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value: envelope, done: false });
      else queue.push(envelope);
    },
  };
}

function permissionAsk(overrides = {}) {
  return {
    sessionID: "ses_reload_perm",
    action: "shell",
    resources: ["rm -rf /"],
    source: { type: "tool", id: "call_reload" },
    effect: "ask",
    ...overrides,
  };
}

// Fail loudly if a returned setup promise does not settle quickly.
function settlesWithin(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      if (timer && typeof timer.unref === "function") timer.unref();
    }),
  ]);
}

// A SINGLE shared hook registry across setups, mirroring upstream hooks.ts: the
// callbacks map is a per-runtime singleton, so an old registration stays in the
// list until its (async) dispose completes, alongside the new one.
function v2HookHost() {
  const entries = [];
  let disposePlan = null;
  const ctxFor = (overrides = {}) => ({
    app: { name: "opencode", version: "2.0.15" },
    event: {
      subscribe() {
        return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } };
      },
    },
    permission: {
      hook(_name, handler) {
        // The entry only becomes effective when the registration resolves,
        // like the host's register().
        return Promise.resolve().then(() => {
          const entry = { handler, disposed: false };
          entries.push(entry);
          return {
            dispose: async () => {
              if (disposePlan) await disposePlan();
              entry.disposed = true;
            },
          };
        });
      },
    },
    ...overrides,
  });
  return {
    ctxFor,
    activeCount() { return entries.filter((entry) => !entry.disposed).length; },
    handlers() { return entries.filter((entry) => !entry.disposed).map((entry) => entry.handler); },
    setDisposePlan(fn) { disposePlan = fn; },
    // Upstream trigger(): snapshot the live list, await each callback in order,
    // same mutable event.
    async dispatch(event) {
      const list = entries.filter((entry) => !entry.disposed).map((entry) => entry.handler);
      for (const handler of list) await handler(event);
      return event;
    },
  };
}

describe("opencode v2 reload / dispose ownership", () => {
  it("a superseded disposer does not abort the current instance's subscription", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const first = v2SetupCtx();
    const cleanup1 = await def.setup(first.ctx);
    const second = v2SetupCtx();
    const cleanup2 = await def.setup(second.ctx);
    t.after(cleanup2);

    // The old host cleanup fires after its generation was already replaced.
    await cleanup1();

    second.push({ type: "session.created", data: { sessionID: "ses_reload" } });
    await tick(80);
    assert.ok(
      fetchStub.calls.some((c) => c.body && c.body.session_id === "opencode:ses_reload"),
      "the current subscription must keep receiving events"
    );
  });

  it("a superseded disposer does not clear the current instance's identity recovery", async (t) => {
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const first = v2SetupCtx();
    const cleanup1 = await def.setup(first.ctx);
    const second = v2SetupCtx({ session: { get: () => new Promise(() => {}) } });
    const cleanup2 = await def.setup(second.ctx);
    t.after(cleanup2);

    // Open a pending identity lookup on the CURRENT instance, then fire the
    // superseded generation's cleanup.
    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: "ses_guard", id: "call_g" } });
    await tick(20);
    assert.strictEqual(def.__test._hydrationState.get("opencode:ses_guard"), "pending");
    await cleanup1();
    assert.strictEqual(
      def.__test._hydrationState.get("opencode:ses_guard"),
      "pending",
      "the current instance's identity recovery must stay pending"
    );
    assert.ok(def.__test._pendingIdentityBySession.has("opencode:ses_guard"), "staged events stay staged");
    assert.strictEqual(fetchStub.calls.length, 0, "nothing is posted for the hung session");
  });

  it("disposes the Registration on cleanup; a later ask no longer reaches the plugin", async (t) => {
    // A runtime file gives the plugin a permission port, so "0 POSTs" proves the
    // disposed hook was never invoked — not merely that no port was available.
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const host = v2SetupCtx();
    const cleanup = await def.setup(host.ctx);
    // Setup returns before the detached registration resolves; wait for it so
    // cleanup exercises the MAIN path (dispose an already-effective
    // registration), not the late "resolves after retire" path.
    await tick(10);
    assert.strictEqual(host.active.length, 1, "one registration while live");
    assert.strictEqual(host.disposedCount, 0);
    await cleanup();
    assert.strictEqual(host.disposedCount, 1, "cleanup disposes the registration");
    assert.strictEqual(host.active.length, 0, "no registration remains active");
    await host.dispatch(permissionAsk());
    assert.strictEqual(fetchStub.calls.length, 0, "a disposed hook never receives an ask");
  });

  it("a reload disposes the previous registration, leaving one live hook and one POST", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const first = v2SetupCtx();
    const cleanup1 = await def.setup(first.ctx);
    // Establish the first registration before reloading so the reload's
    // teardown disposes an already-effective registration (main path).
    await tick(10);
    assert.strictEqual(first.active.length, 1);
    const second = v2SetupCtx();
    const cleanup2 = await def.setup(second.ctx);
    t.after(cleanup2);

    assert.strictEqual(first.disposedCount, 1, "the reload retired the old registration");
    assert.strictEqual(first.active.length, 0);
    assert.strictEqual(second.active.length, 1, "exactly one live registration");
    // Dispatch through what the host considers live: exactly one POST.
    const event = permissionAsk();
    await second.dispatch(event);
    assert.strictEqual(event.effect, "allow");
    assert.strictEqual(fetchStub.calls.length, 1, "one POST for one ask");

    // A late call of the superseded cleanup must not disturb the new instance.
    await cleanup1();
    assert.strictEqual(second.active.length, 1, "the new registration stays live");
  });

  it("tolerates a legacy synchronous unregister function from ctx.permission.hook", async (t) => {
    const { def } = await makeDefinition();
    let unregistered = 0;
    const cleanup = await def.setup({
      app: { name: "opencode", version: "2.0.15" },
      permission: {
        hook() {
          return () => { unregistered += 1; };
        },
      },
    });
    assert.strictEqual(unregistered, 0);
    await cleanup();
    assert.strictEqual(unregistered, 1, "the legacy unregister function is invoked on dispose");
  });

  it("keeps setup and event delivery alive when hook registration rejects", async (t) => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    t.after(() => process.removeListener("unhandledRejection", onRejection));

    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const host = v2SetupCtx();
    host.setHookPlan(() => Promise.reject(new Error("register boom")));
    const cleanup = await def.setup(host.ctx);
    t.after(cleanup);
    assert.strictEqual(host.active.length, 0, "no live registration");

    host.push({ type: "session.created", data: { sessionID: "ses_reject" } });
    await tick(80);
    await tick(20);
    assert.ok(
      fetchStub.calls.some((c) => c.body && c.body.session_id === "opencode:ses_reject"),
      "event subscription must continue without a hook"
    );
    assert.deepStrictEqual(rejections, [], "a rejected registration must not leak an unhandled rejection");
  });

  it("disposes a registration that resolves after the instance was retired", async (t) => {
    const { def } = await makeDefinition();
    let releaseRegistration;
    const gate = new Promise((resolve) => { releaseRegistration = resolve; });
    const first = v2SetupCtx();
    first.setHookPlan(() => gate);
    const firstSetup = def.setup(first.ctx); // parks on the pending registration

    const second = v2SetupCtx();
    const cleanup2 = await def.setup(second.ctx);
    t.after(cleanup2);
    // The second setup retired the first instance while its registration was
    // still in flight: it has no effective registration yet.
    assert.strictEqual(first.active.length, 0, "the late registration is not effective yet");
    assert.strictEqual(second.active.length, 1);

    releaseRegistration();
    await firstSetup;
    await tick(20);
    assert.strictEqual(first.disposedCount, 1, "the late registration was disposed immediately");
    assert.strictEqual(first.active.length, 0, "no live registration leaks from the retired instance");
  });

  // Robustness: setup must never wedge on the host. A never-settling previous
  // dispose or hook registration must not delay the new generation's event
  // subscription, and a slow previous dispose must not clear the current
  // instance's identity recovery.
  it("subscribes without waiting for the previous generation's dispose", async (t) => {
    const { def } = await makeDefinition();
    const first = v2SetupCtx();
    await def.setup(first.ctx);
    await tick(10);
    assert.strictEqual(first.active.length, 1, "previous registration established");
    first.setDisposePlan(() => new Promise(() => {})); // never settles

    const second = v2SetupCtx();
    const cleanup2 = await settlesWithin(def.setup(second.ctx), 300, "second setup");
    t.after(cleanup2);
    await tick(10);
    assert.strictEqual(second.subscribed, 1, "the new generation must subscribe to events");
    assert.strictEqual(second.active.length, 1, "its hook registration is live");
  });

  it("subscribes without waiting for ctx.permission.hook to resolve", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const host = v2SetupCtx();
    host.setHookPlan(() => new Promise(() => {})); // never settles
    const cleanup = await settlesWithin(def.setup(host.ctx), 300, "setup");
    t.after(cleanup);
    assert.strictEqual(host.subscribed, 1, "event subscription must not wait on the hook");

    host.push({ type: "session.created", data: { sessionID: "ses_nohook" } });
    await tick(80);
    assert.ok(
      fetchStub.calls.some((c) => c.body && c.body.session_id === "opencode:ses_nohook"),
      "state events must flow even without a resolved hook"
    );
  });

  it("a slow previous-generation dispose does not clear the new instance's identity recovery", async (t) => {
    const { def } = await makeDefinition();
    const first = v2SetupCtx();
    await def.setup(first.ctx);
    await tick(10);
    assert.strictEqual(first.active.length, 1, "previous registration established");
    first.setDisposePlan(() => new Promise((resolve) => setTimeout(resolve, 200)));

    const second = v2SetupCtx({ session: { get: () => new Promise(() => {}) } });
    const cleanup2 = await settlesWithin(def.setup(second.ctx), 300, "second setup");
    t.after(cleanup2);

    // Stage a pending identity lookup on the CURRENT instance.
    def.__test.handleV2Event({ type: "session.tool.called", data: { sessionID: "ses_slow", id: "call_slow" } });
    await tick(20);
    assert.strictEqual(def.__test._hydrationState.get("opencode:ses_slow"), "pending");

    // Wait past the previous generation's 200ms dispose. Its local teardown ran
    // synchronously at reload, so the late registration dispose must not touch
    // the new instance's state.
    await tick(260);
    assert.strictEqual(
      def.__test._hydrationState.get("opencode:ses_slow"),
      "pending",
      "the new instance's identity recovery must survive a slow previous dispose"
    );
    assert.ok(def.__test._pendingIdentityBySession.has("opencode:ses_slow"), "staged events stay staged");
  });

  // opencode upstream v2.0.15 (packages/core/src/plugin/hooks.ts) trigger()
  // calls EVERY still-registered callback in order with the same mutable event,
  // and our dispose is async — so a retired generation's callback can fire
  // during a reload window.
  it("a retired callback does not forward; the current registration POSTs once", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const host = v2HookHost();

    await def.setup(host.ctxFor());
    await tick(10);
    assert.strictEqual(host.activeCount(), 1, "previous registration effective");
    host.setDisposePlan(() => new Promise(() => {})); // old dispose never completes
    const cleanup2 = await def.setup(host.ctxFor());
    t.after(cleanup2);
    await tick(10);
    assert.strictEqual(host.activeCount(), 2, "old and new callbacks coexist during reload");
    const [retired, current] = host.handlers();
    assert.ok(retired && current && retired !== current, "old and new callbacks are distinct");

    // (i) The retired callback must not act even when invoked directly — this is
    // the case a sequential shared-event dispatch would hide, because an
    // "allow" from the old callback would short-circuit the new one.
    const staleEvent = permissionAsk();
    await retired(staleEvent);
    assert.strictEqual(fetchStub.calls.length, 0, "the retired callback must not POST");
    assert.strictEqual(staleEvent.effect, "ask");

    // (ii) Upstream-style dispatch (old then new, one shared event) resolves the
    // ask exactly once through the current callback.
    const event = permissionAsk();
    await host.dispatch(event);
    assert.strictEqual(fetchStub.calls.length, 1, "only the current callback forwards");
    assert.strictEqual(event.effect, "allow", "the current callback applied its decision");
  });

  it("an ask dispatched while only the retired callback is registered stays native (intentional)", async (t) => {
    writeRuntimeFile(t);
    const fetchStub = stubFetch(t);
    const { def } = await makeDefinition();
    const host = v2HookHost();

    await def.setup(host.ctxFor());
    await tick(10);
    assert.strictEqual(host.activeCount(), 1, "previous registration effective");
    host.setDisposePlan(() => new Promise(() => {})); // old callback stays registered

    // Reload, but dispatch BEFORE the new registration becomes effective: the
    // live list holds only the retired callback.
    const secondSetup = def.setup(host.ctxFor());
    const event = permissionAsk();
    await host.dispatch(event);
    assert.strictEqual(fetchStub.calls.length, 0, "a retired callback must not POST");
    assert.strictEqual(event.effect, "ask", "no decision — opencode's native prompt takes over");

    const cleanup2 = await secondSetup;
    t.after(cleanup2);
  });
});
