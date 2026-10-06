"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const HOOK = path.resolve(__dirname, "..", "hooks", "cursor-hook.js");
const PRELOAD = path.join(__dirname, "helpers", "cursor-hook-delivery-probe.js");

async function runHook(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cursor-delivery-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const posts = [];
  const sockets = new Set();
  let replySent = false;
  let stdoutBeforeReply = false;
  const server = http.createServer((req, res) => {
    if (options.dropConnections) {
      req.socket.destroy();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method === "POST") posts.push(JSON.parse(body));
      const respond = () => {
        if (req.method === "POST") replySent = true;
        res.setHeader("x-clawd-server", "clawd-on-desk");
        res.end("{}");
      };
      if (req.method === "POST" && options.replyDelayMs) setTimeout(respond, options.replyDelayMs);
      else respond();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("CLAWD_")) delete env[key];
  for (const key of ["NODE_OPTIONS", "GROK_HOOK_EVENT", "TMUX", "TMUX_PANE", "ORCA_PANE_KEY"]) delete env[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    CLAWD_DELIVERY_HOME: home,
    CLAWD_DELIVERY_PORT: String(server.address().port),
    CLAWD_DELIVERY_METADATA_DELAY: String(options.metadataDelayMs || 0),
    CLAWD_DELIVERY_STALL: options.stallDelivery ? "1" : "0",
    CLAWD_DELIVERY_THROW: options.throwDelivery ? "1" : "0",
  });
  const child = spawn(process.execPath, ["--require", PRELOAD, HOOK, "--clawd-cursor-hook=v1"], {
    env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    if (!replySent) stdoutBeforeReply = true;
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // A failure must only terminate this test-owned child, never a user's app.
  const watchdog = setTimeout(() => child.kill(), 7000);
  t.after(() => { clearTimeout(watchdog); if (child.exitCode === null) child.kill(); });
  child.stdin.on("error", () => {}); // The no-EOF case intentionally outlives the hook.
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  if (!options.keepStdinOpen) {
    const payload = {
      hook_event_name: options.event || "beforeSubmitPrompt",
      conversation_id: "cursor-delivery-test", workspace_roots: ["D:/test"],
      status: "completed", prompt: "test",
    };
    child.stdin.end(options.input !== undefined ? options.input : JSON.stringify(payload));
  }
  const result = await closed;
  clearTimeout(watchdog);
  return { ...result, stdout, stderr, posts, stdoutBeforeReply };
}

function assertCleanExit(result, expectedStdout) {
  assert.equal(result.signal, null, "hook must finish without the test watchdog");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, expectedStdout);
}

describe("Cursor hook delivery lifecycle", () => {
  for (const [event, expectedEvent, state] of [
    ["sessionStart", "SessionStart", "idle"],
    ["preToolUse", "PreToolUse", "working"],
    ["stop", "Stop", "attention"],
  ]) {
    it(`delivers ${event} after metadata takes longer than the old watchdog`, async (t) => {
      const result = await runHook(t, { event, metadataDelayMs: 1000 });
      assertCleanExit(result, "{}\n");
      assert.equal(result.posts.length, 1, "the receiver must actually get the event");
      assert.equal(result.posts[0].event, expectedEvent);
      assert.equal(result.posts[0].state, state);
      assert.equal(result.posts[0].session_id, "cursor-delivery-test");
      assert.equal(result.stdoutBeforeReply, false);
    });
  }

  it("waits for delivery before returning the prompt response", async (t) => {
    const result = await runHook(t, { replyDelayMs: 50 });
    assertCleanExit(result, '{"continue":true}\n');
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].event, "UserPromptSubmit");
    assert.equal(result.stdoutBeforeReply, false);
  });

  it("preserves the prompt response when Clawd cannot receive the event", async (t) => {
    const result = await runHook(t, { dropConnections: true });
    assertCleanExit(result, '{"continue":true}\n');
    assert.equal(result.posts.length, 0);
  });

  it("bounds a stalled delivery and still permits prompt submission", async (t) => {
    const result = await runHook(t, { stallDelivery: true });
    assertCleanExit(result, '{"continue":true}\n');
    assert.equal(result.posts.length, 0);
  });

  it("preserves the prompt response if the sender throws", async (t) => {
    const result = await runHook(t, { throwDelivery: true });
    assertCleanExit(result, '{"continue":true}\n');
    assert.equal(result.posts.length, 0);
  });

  it("still terminates with valid JSON when stdin never arrives or closes", async (t) => {
    const result = await runHook(t, { keepStdinOpen: true });
    assertCleanExit(result, "{}\n");
    assert.equal(result.posts.length, 0);
  });

  it("does not attempt delivery for malformed input", async (t) => {
    const result = await runHook(t, { input: "{invalid" });
    assertCleanExit(result, "{}\n");
    assert.equal(result.posts.length, 0);
  });
});
