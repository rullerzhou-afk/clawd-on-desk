"use strict";

// Real localhost Clawd ingress and native question HTTP routes. Electron is
// mocked; no agent/model, credentials, user configuration or GUI is started.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");
const { test, before, after } = require("node:test");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-question-transport-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
fs.mkdirSync(path.join(home, ".clawd"), { mode: 0o700 });
fs.writeFileSync(path.join(home, ".clawd", "runtime.json"), JSON.stringify({
  app: "clawd-on-desk", port: 23333, ownerPid: process.pid,
}), { mode: 0o600 });

const originalLoad = Module._load;
Module._load = function (name) {
  if (name === "electron") return { BrowserWindow: { fromWebContents: sender => sender.__window },
    globalShortcut: { register: () => true, unregister() {}, isRegistered: () => false } };
  return originalLoad.apply(this, arguments);
};
const { createPermissionIngressHarness, waitUntil } = require("./helpers/permission-ingress-harness");
Module._load = originalLoad;
const realFetch = globalThis.fetch;
let createPlugin;
let activeClawd;
let receiptOutcomes = [];
before(async () => {
  globalThis.fetch = (url, options) => {
    const target = new URL(url);
    // Map the synthetic runtime owner to this test's ephemeral server. Never
    // contact a developer's real 23333 listener or scan other ports.
    if (target.origin === "http://127.0.0.1:23333" && target.pathname === "/question") {
      const packet = JSON.parse(options.body);
      if (packet.question_result) receiptOutcomes.push(packet.question_result);
      return realFetch(`http://127.0.0.1:${activeClawd.port}/question`, options);
    }
    return Promise.resolve(new Response("", { status: 503 }));
  };
  ({ createOpencodeFamilyPlugin: createPlugin } = await import(pathToFileURL(
    path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs")).href));
});
after(async () => {
  globalThis.fetch = realFetch;
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function nativeQuestion(id = "que_test", sessionID = "ses_test") {
  return { id, sessionID, tool: { messageID: "msg_test", callID: "call_test" }, questions: [
    { header: "Pick", question: "Which labels?", options: [{ label: "A, B", description: "One" }, { label: "C", description: "Two" }], multiple: true, custom: false },
    { header: "Text", question: "Explain", options: [], custom: true },
  ] };
}

async function nativeHost(t, version) {
  const pending = new Map(); const posts = []; const sdkCalls = [];
  const callbacks = { beforeResponse: null, beforePost: null, failPost: false, replyValue: true };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/global/health") {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ healthy: true, version })); return;
    }
    if (req.method === "GET" && url.pathname === "/question") {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify([...pending.values()])); return;
    }
    if (req.method === "POST" && /^\/question\/que[A-Za-z0-9_-]+\/reply$/.test(url.pathname)) {
      let body = ""; for await (const chunk of req) body += chunk;
      const id = url.pathname.split("/")[2];
      posts.push({ id, body: JSON.parse(body), directory: url.searchParams.get("directory") });
      if (callbacks.beforePost) await callbacks.beforePost(id);
      if (callbacks.failPost) { res.writeHead(500); res.end(); return; }
      if (!pending.has(id)) { res.writeHead(404); res.end(); return; }
      const question = pending.get(id);
      pending.delete(id);
      if (callbacks.beforeResponse) await callbacks.beforeResponse(id, question, JSON.parse(body).answers);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(callbacks.replyValue)); return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://0.0.0.0:${server.address().port}`;
  async function call(method, args) {
    sdkCalls.push(args);
    let relative = args.url;
    for (const [key, value] of Object.entries(args.path || {})) relative = relative.replace(`{${key}}`, encodeURIComponent(value));
    const url = new URL(relative, args.baseUrl || baseUrl);
    for (const [key, value] of Object.entries(args.query || {})) url.searchParams.set(key, value);
    const response = await realFetch(url, { method, signal: args.signal, headers: args.headers,
      ...(args.body ? { body: JSON.stringify(args.body) } : {}) });
    if (!response.ok) return { error: {}, response };
    return { data: await response.json(), response };
  }
  return { pending, posts, sdkCalls, callbacks, client: { _client: {
    getConfig: () => ({ baseUrl }), get: args => call("GET", args), post: args => call("POST", args),
  } } };
}

async function setup(t, agentId = "opencode", version = "1.18.31") {
  receiptOutcomes = [];
  const h = activeClawd = await createPermissionIngressHarness();
  t.after(() => h.close());
  const host = await nativeHost(t, version);
  const plugin = createPlugin({ agentId, hookSource: `${agentId}-plugin`, logFileName: `${agentId}.log`, sessionIdPrefix: `${agentId}:` });
  const hooks = await plugin({ client: host.client, directory: "/synthetic/project", serverUrl: "http://127.0.0.1:1" });
  host.callbacks.beforeResponse = async (id, question, answers) => hooks.event({ event: {
    type: "question.replied", properties: { requestID: id, sessionID: question.sessionID, answers },
  } });
  t.after(async () => { await hooks.dispose(); await plugin.__test.closeBridgeForTest(); await plugin.__test.flushDebugLog(); });
  function ask(question) {
    host.pending.set(question.id, question);
    return hooks.event({ event: { type: "question.asked", properties: question } });
  }
  function answer(entry, values = { 0: ["A, B", "C"], 1: ["User text"] }) {
    entry.bubble = { isDestroyed: () => false };
    h.permission.handleDecide({ sender: { __window: entry.bubble } }, { type: "elicitation-submit", answers: values });
  }
  return { h, host, plugin, hooks, ask, answer, receipts: receiptOutcomes };
}

for (const [agent, version] of [["opencode", "1.18.31"], ["mimocode", "0.1.15"]]) {
  test(`${agent} full HTTP round trip sends exact ordered arrays once`, async t => {
    const { h, host, plugin, ask, answer, receipts } = await setup(t, agent, version);
    const question = nativeQuestion();
    await ask(question); const target = plugin.__test._questionsById.get(question.id);
    await ask(question); // duplicate native event cannot create another waiter
    await waitUntil(() => h.shown.length === 1, "question must reach Clawd");
    answer(h.shown[0]); answer(h.shown[0]); await target.completion;
    assert.deepEqual(host.posts, [{ id: question.id, directory: "/synthetic/project", body: { answers: [["A, B", "C"], ["User text"]] } }]);
    assert.equal(plugin.__test._questionsById.size, 0);
    assert.deepEqual(receipts, ["accepted"]);
    assert.ok(host.sdkCalls.every(call => call.baseUrl.startsWith("http://127.0.0.1:")), "wildcard client rewritten per call");
  });
}

test("OpenCode accepts RPC true before a delayed native replied event arrives", async t => {
  const { h, host, plugin, hooks, ask, answer, receipts } = await setup(t, "opencode", "1.18.35");
  host.callbacks.beforeResponse = null;
  const question = nativeQuestion(); await ask(question); const target = plugin.__test._questionsById.get(question.id);
  await waitUntil(() => h.shown.length === 1, "question must reach Clawd");
  answer(h.shown[0]); await target.completion;
  assert.equal(target.observedNativeReply, null);
  assert.deepEqual(receipts, ["accepted"]);
  assert.equal(h.permission.pendingPermissions.length, 0);
  await hooks.event({ event: { type: "question.replied", properties: {
    requestID: question.id, sessionID: question.sessionID, answers: host.posts[0].body.answers,
  } } });
  assert.equal(host.posts.length, 1); assert.deepEqual(receipts, ["accepted"]);
});

test("OpenCode RPC 404 resolves elsewhere without a native replied event", async t => {
  const { h, host, plugin, ask, answer, receipts } = await setup(t);
  host.callbacks.beforeResponse = null;
  host.callbacks.beforePost = id => { host.pending.delete(id); };
  const question = nativeQuestion(); await ask(question); const target = plugin.__test._questionsById.get(question.id);
  await waitUntil(() => h.shown.length === 1, "question must reach Clawd");
  answer(h.shown[0]); await target.completion;
  assert.equal(target.observedNativeReply, null);
  assert.deepEqual(receipts, ["resolved-elsewhere"]);
  assert.equal(host.posts.length, 1); assert.equal(h.permission.pendingPermissions.length, 0);
});

test("OpenCode false RPC stays unknown even if an event arrived before it", async t => {
  const { h, host, plugin, ask, answer, receipts } = await setup(t);
  host.callbacks.replyValue = false;
  const question = nativeQuestion(); await ask(question); const target = plugin.__test._questionsById.get(question.id);
  await waitUntil(() => h.shown.length === 1, "question must reach Clawd");
  answer(h.shown[0]); await target.completion;
  assert.deepEqual(target.observedNativeReply, host.posts[0].body.answers);
  assert.deepEqual(receipts, ["unknown"]);
  assert.equal(h.shown[0].questionDeliveryUnconfirmed, true);
  assert.equal(host.posts.length, 1);
});

test("own native resolution event does not abort the reply before its tool waiter completes", async t => {
  const { h, host, plugin, hooks, ask, answer } = await setup(t);
  const question = nativeQuestion(); await ask(question); const target = plugin.__test._questionsById.get(question.id);
  host.callbacks.beforeResponse = async (id, nativeRequest, answers) => {
    await hooks.event({ event: { type: "question.replied", properties: { requestID: id, sessionID: nativeRequest.sessionID, answers } } });
    assert.equal(target.controller.signal.aborted, false, "native resolved event must not interrupt its own committing RPC");
  };
  await waitUntil(() => h.shown.length === 1, "question must reach Clawd");
  answer(h.shown[0]); await target.completion;
  assert.equal(host.posts.length, 1);
});

test("native answer/cancel clears the matching card without a second answer", async t => {
  const { h, host, plugin, hooks, ask, answer } = await setup(t);
  for (const event of ["question.replied", "question.rejected"]) {
    const question = nativeQuestion(`que_${event.split(".")[1]}`);
    await ask(question); const target = plugin.__test._questionsById.get(question.id);
    await waitUntil(() => h.permission.pendingPermissions.length === 1, "question must reach Clawd");
    const entry = h.permission.pendingPermissions[0]; host.pending.delete(question.id);
    await hooks.event({ event: { type: event, properties: { sessionID: question.sessionID, requestID: question.id } } });
    await target.completion;
    await waitUntil(() => !h.permission.pendingPermissions.length, "native resolution must remove card");
    answer(entry);
  }
  assert.equal(host.posts.length, 0);
});

test("native API failure keeps a non-resubmittable fallback and never retries", async t => {
  const { h, host, plugin, ask, answer, receipts } = await setup(t);
  host.callbacks.failPost = true;
  const question = nativeQuestion(); await ask(question); const target = plugin.__test._questionsById.get(question.id);
  await waitUntil(() => h.shown.length === 1, "question must reach Clawd");
  answer(h.shown[0]); await target.completion;
  assert.equal(host.posts.length, 1);
  assert.deepEqual(receipts, ["native-fallback"]);
  assert.ok(host.pending.has(question.id));
  assert.equal(h.shown[0].questionDeliveryUnconfirmed, true);
  assert.equal(h.shown[0].interaction.capabilities.answerQuestions, false);
  answer(h.shown[0]); assert.equal(host.posts.length, 1);
});

test("MiMo RPC true without its exact event stays unconfirmed after a late event", async t => {
  const { h, host, plugin, hooks, ask, answer, receipts } = await setup(t, "mimocode", "0.1.15");
  host.callbacks.beforeResponse = null;
  const question = nativeQuestion(); await ask(question); const target = plugin.__test._questionsById.get(question.id);
  await waitUntil(() => h.shown.length === 1, "question must reach Clawd");
  answer(h.shown[0]); await target.completion;
  assert.equal(host.posts.length, 1);
  assert.deepEqual(receipts, ["unknown"]);
  assert.equal(h.shown[0].questionDeliveryUnconfirmed, true);
  await hooks.event({ event: { type: "question.replied", properties: {
    requestID: question.id, sessionID: question.sessionID, answers: host.posts[0].body.answers,
  } } });
  assert.equal(h.permission.pendingPermissions.length, 1);
  assert.equal(h.shown[0].interaction.capabilities.answerQuestions, false);
  assert.equal(h.shown[0].questionDeliveryUnconfirmed, true);
  assert.deepEqual(receipts, ["unknown"]);
});

test("changed native questions and unknown versions never receive an answer", async t => {
  const { h, host, plugin, ask, answer } = await setup(t);
  const question = nativeQuestion(); await ask(question);
  const target = plugin.__test._questionsById.get(question.id);
  await waitUntil(() => h.shown.length === 1, "question must reach Clawd");
  const replacement = structuredClone(question); replacement.questions[0].question = "Changed while pending";
  host.pending.set(question.id, replacement);
  answer(h.shown[0]); await target.completion;
  assert.equal(host.posts.length, 0); assert.ok(host.pending.has(question.id));
  assert.equal(h.shown[0].questionDeliveryUnconfirmed, true);
});

test("noncanonical native host versions never enable the question channel", async t => {
  const { h, host, plugin, ask } = await setup(t, "opencode", "01.018.0031");
  const question = nativeQuestion(); await ask(question);
  await plugin.__test._questionsById.get(question.id).completion;
  assert.equal(h.shown.length, 0); assert.equal(host.posts.length, 0); assert.ok(host.pending.has(question.id));
});

test("unsupported published generation keeps the original native question", async t => {
  const { h, host, plugin, ask } = await setup(t, "opencode", "2.0.15");
  const question = nativeQuestion(); await ask(question);
  await plugin.__test._questionsById.get(question.id).completion;
  assert.equal(h.shown.length, 0); assert.equal(host.posts.length, 0); assert.ok(host.pending.has(question.id));
});

test("interleaved plugin instances keep each native client and directory bound", async t => {
  const { h, host, plugin, ask, answer } = await setup(t);
  const secondHost = await nativeHost(t, "1.18.31");
  const secondHooks = await plugin({ client: secondHost.client, directory: "/synthetic/second", serverUrl: "http://127.0.0.1:1" });
  secondHost.callbacks.beforeResponse = async (id, question, answers) => secondHooks.event({ event: {
    type: "question.replied", properties: { requestID: id, sessionID: question.sessionID, answers },
  } });
  t.after(() => secondHooks.dispose());
  const first = nativeQuestion("que_first", "ses_first");
  const second = nativeQuestion("que_second", "ses_second");
  await ask(first); secondHost.pending.set(second.id, second);
  await secondHooks.event({ event: { type: "question.asked", properties: second } });
  const firstTarget = plugin.__test._questionsById.get(first.id);
  const secondTarget = plugin.__test._questionsById.get(second.id);
  await waitUntil(() => h.permission.pendingPermissions.length === 2, "both instances should reach Clawd");
  answer(h.shown.find(entry => entry.familyRequestId === second.id));
  answer(h.shown.find(entry => entry.familyRequestId === first.id));
  await Promise.all([firstTarget.completion, secondTarget.completion]);
  assert.equal(host.posts[0].id, first.id); assert.equal(host.posts[0].directory, "/synthetic/project");
  assert.equal(secondHost.posts[0].id, second.id); assert.equal(secondHost.posts[0].directory, "/synthetic/second");
});

test("instance disposal cancels its long poll and leaves native pending state", async t => {
  const { h, host, plugin, hooks, ask } = await setup(t);
  const question = nativeQuestion(); await ask(question); const target = plugin.__test._questionsById.get(question.id);
  await waitUntil(() => h.shown.length === 1, "question must reach Clawd");
  await hooks.dispose(); await target.completion;
  await waitUntil(() => !h.permission.pendingPermissions.length, "dispose should clean card");
  assert.equal(host.posts.length, 0); assert.ok(host.pending.has(question.id));
});
