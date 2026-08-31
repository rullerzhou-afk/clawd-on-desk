"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let bridgePromise;
function bridge() {
  bridgePromise ||= import(pathToFileURL(path.join(__dirname, "..", "hooks", "dsh-clawd-bridge", "lib", "index.js")).href);
  return bridgePromise;
}

test("DSH bridge maps only public session events and never copies tool arguments", async () => {
  const { mapSessionEvent, statePayload } = await bridge();
  assert.deepStrictEqual(mapSessionEvent({ type: "turn/start" }), { event: "UserPromptSubmit", state: "thinking" });
  assert.deepStrictEqual(mapSessionEvent({ type: "tool/call", data: { name: "bash", arguments: { secret: true } } }), {
    event: "PreToolUse",
    state: "working",
    toolName: "bash",
  });
  assert.deepStrictEqual(mapSessionEvent({
    type: "tool/result",
    data: { message: { content: [{ type: "tool_result", isError: true }] } },
  }), {
    event: "PostToolUseFailure",
    state: "error",
  });
  assert.deepStrictEqual(mapSessionEvent({ type: "turn/end", data: { reason: { kind: "error" } } }), {
    event: "StopFailure",
    state: "error",
  });
  assert.strictEqual(mapSessionEvent({ type: "compaction/prune", data: {} }), null);
  const payload = statePayload(
    { id: "s1", header: { cwd: "C:/repo", origin: "subagent" } },
    mapSessionEvent({ type: "tool/call", data: { name: "bash", arguments: { token: "never" } } }),
    { eventSeq: 7 },
  );
  assert.strictEqual(payload.session_id, "deepseek-harness:s1");
  assert.strictEqual(payload.event_seq, 7);
  assert.strictEqual(payload.headless, true);
  assert.strictEqual(payload.recap_is_subagent, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, "tool_input"), false);
  assert.strictEqual(JSON.stringify(payload).includes("never"), false);
});

test("DSH approval payload uses only ApprovalRequest public fields", async () => {
  const { buildApprovalPayload } = await bridge();
  const payload = buildApprovalPayload({
    agent: { session: { id: "s2", header: { cwd: "/repo", origin: "subagent" } } },
    toolName: "write_file",
    callId: "call-1",
    reason: "needs sandbox escalation",
    arguments: { secret: "must-not-cross" },
  });
  assert.deepStrictEqual(payload.tool_input, {});
  assert.strictEqual(payload.tool_use_id, "call-1");
  assert.strictEqual(payload.session_id, "deepseek-harness:s2");
  assert.strictEqual(payload.headless, true);
  assert.strictEqual(JSON.stringify(payload).includes("must-not-cross"), false);
});

test("DSH approval handler maps decisions and delegates every no-decision to next()", async () => {
  const { createApprovalHandler } = await bridge();
  const allow = createApprovalHandler(async () => ({ kind: "decision", decision: "allow" }));
  const deny = createApprovalHandler(async () => ({ kind: "decision", decision: "deny" }));
  const defer = createApprovalHandler(async () => ({ kind: "no-decision" }));
  assert.strictEqual(await allow({ toolName: "bash" }, async () => "native"), "allowed-once");
  assert.strictEqual(await deny({ toolName: "bash" }, async () => "native"), "rejected");
  let nextCalls = 0;
  assert.strictEqual(await defer({ toolName: "bash" }, async () => { nextCalls += 1; return "web-answerer"; }), "web-answerer");
  assert.strictEqual(nextCalls, 1);
  assert.strictEqual(await createApprovalHandler(async () => { throw new Error("offline"); })({}, async () => "native"), "native");
  nextCalls = 0;
  await assert.rejects(
    createApprovalHandler(async () => ({ kind: "no-decision" }))({}, async () => {
      nextCalls += 1;
      throw new Error("missing");
    }),
    /missing/,
  );
  assert.strictEqual(nextCalls, 1);
});

test("DSH approval handler honors abort without calling Clawd or downstream", async () => {
  const { createApprovalHandler } = await bridge();
  let called = false;
  const handler = createApprovalHandler(async () => { called = true; return { kind: "decision", decision: "allow" }; });
  const outcome = await handler({ signal: { aborted: true } }, async () => { called = true; return "native"; });
  assert.strictEqual(outcome, "cancelled");
  assert.strictEqual(called, false);
});

test("DSH approval handler delegates exactly once when plugin disposal aborts an in-flight request", async () => {
  const { createApprovalHandler } = await bridge();
  const lifetime = new AbortController();
  let downstreamCalls = 0;
  const handler = createApprovalHandler((_payload, { signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
  }), 1000, lifetime.signal);
  const pending = handler({ toolName: "bash" }, async () => { downstreamCalls += 1; return "native"; });
  lifetime.abort();
  assert.strictEqual(await pending, "native");
  assert.strictEqual(downstreamCalls, 1);
});

test("DSH approval handler gives asker cancellation priority over a simultaneous plugin disposal", async () => {
  const { createApprovalHandler } = await bridge();
  const lifetime = new AbortController();
  const asker = new AbortController();
  let downstreamCalls = 0;
  const handler = createApprovalHandler((_payload, { signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
  }), 1000, lifetime.signal);
  const pending = handler({ toolName: "bash", signal: asker.signal }, async () => {
    downstreamCalls += 1;
    return "native";
  });
  lifetime.abort();
  asker.abort();
  assert.strictEqual(await pending, "cancelled");
  assert.strictEqual(downstreamCalls, 0);
});

test("DSH approval handler delegates without contacting Clawd after plugin disposal", async () => {
  const { createApprovalHandler } = await bridge();
  const lifetime = new AbortController();
  lifetime.abort();
  let clawdCalls = 0;
  let downstreamCalls = 0;
  const handler = createApprovalHandler(async () => {
    clawdCalls += 1;
    return { kind: "decision", decision: "allow" };
  }, 1000, lifetime.signal);
  assert.strictEqual(await handler({}, async () => {
    downstreamCalls += 1;
    return "native";
  }), "native");
  assert.strictEqual(clawdCalls, 0);
  assert.strictEqual(downstreamCalls, 1);
});

test("DSH state sender preserves FIFO per session and can progress sessions independently", async () => {
  const { createStateSender } = await bridge();
  const controller = new AbortController();
  const calls = [];
  const resolvers = [];
  const sender = createStateSender(controller.signal, (payload) => new Promise((resolve) => {
    calls.push(payload);
    resolvers.push(resolve);
  }));
  sender.enqueue({ session_id: "deepseek-harness:a", event: "SessionStart" });
  sender.enqueue({ session_id: "deepseek-harness:a", event: "PreToolUse" });
  sender.enqueue({ session_id: "deepseek-harness:b", event: "SessionStart" });
  await Promise.resolve();
  assert.deepStrictEqual(calls.map((item) => `${item.session_id}:${item.event}`), [
    "deepseek-harness:a:SessionStart",
    "deepseek-harness:b:SessionStart",
  ]);
  resolvers[0]({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(calls[2].event, "PreToolUse");
  controller.abort();
  resolvers.slice(1).forEach((resolve) => resolve({ ok: true }));
});

test("DSH state sender keeps its pending queue bounded and preserves terminal state by eviction", async () => {
  const { createStateSender } = await bridge();
  const controller = new AbortController();
  let release;
  const sent = [];
  const sender = createStateSender(controller.signal, (payload) => {
    sent.push(payload);
    return new Promise((resolve) => { release = resolve; });
  });
  sender.enqueue({ session_id: "deepseek-harness:a", event: "SessionStart" });
  let accepted = 0;
  for (let seq = 0; seq < 40; seq += 1) {
    if (sender.enqueue({ session_id: "deepseek-harness:a", event: "PreToolUse", event_seq: seq })) accepted += 1;
  }
  assert.strictEqual(accepted, 32);
  assert.strictEqual(sender.enqueue({ session_id: "deepseek-harness:a", event: "SessionEnd", session_seq: 41 }), true);
  controller.abort();
  release({ ok: true });
  assert.strictEqual(sent[0].event, "SessionStart");
});

test("DSH plugin registers public seams only and contains session/created exceptions", async () => {
  const { apply } = await bridge();
  const listeners = new Map();
  const approvalListeners = [];
  let disposer = null;
  const approvalCtx = {
    on(name, handler, options) { approvalListeners.push({ name, handler, options }); },
  };
  const ctx = {
    on(name, handler) { listeners.set(name, handler); },
    inject(dependencies, register) {
      assert.deepStrictEqual(dependencies, ["approval"]);
      register(approvalCtx);
    },
    effect(factory) { disposer = factory(); },
  };
  apply(ctx);
  assert.deepStrictEqual([...listeners.keys()], ["session/created", "session/event", "session/disposed"]);
  assert.strictEqual(approvalListeners.length, 1);
  assert.strictEqual(approvalListeners[0].name, "approval/request");
  assert.deepStrictEqual(approvalListeners[0].options, { prepend: true });
  const hostileSession = {};
  Object.defineProperty(hostileSession, "id", { get() { throw new Error("observer bug"); } });
  assert.doesNotThrow(() => listeners.get("session/created")(hostileSession));
  assert.strictEqual(typeof disposer, "function");
  disposer();
});
