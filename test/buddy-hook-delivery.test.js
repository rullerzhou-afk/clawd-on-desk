"use strict";

// #1104: CodeBuddy / WorkBuddy state hooks answer stdout before the synchronous
// process-tree walk, then re-arm the exit backstop so the fire-and-forget POST
// still leaves the process. The timing bugs here are invisible to unit tests,
// so this spawns the REAL hook against a test-owned receiver and inspects
// stdout bytes, exit code, POST count and the order of stdout vs. the blocking
// walk.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const PRELOAD = path.join(__dirname, "helpers", "buddy-hook-delivery-probe.js");
const TARGETS = [
  {
    name: "CodeBuddy",
    agentId: "codebuddy",
    backstopMs: 5000,
    script: path.resolve(__dirname, "..", "hooks", "codebuddy-hook.js"),
  },
  {
    name: "WorkBuddy",
    agentId: "workbuddy",
    backstopMs: process.platform === "win32" ? 7500 : 5000,
    script: path.resolve(__dirname, "..", "hooks", "workbuddy-hook.js"),
  },
];

// Preserve both the ordered event list and the numeric monotonic marks. The
// walk/stdout/send/exit events are appended synchronously inside the child, so
// their order in `order` is the true event order (parent scheduling cannot
// reorder them).
function readTimeline(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const marks = {};
  const order = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceAt = trimmed.indexOf(" ");
    const name = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
    order.push(name);
    if (spaceAt !== -1) {
      const value = Number(trimmed.slice(spaceAt + 1));
      if (Number.isFinite(value)) marks[name] = value;
    }
  }
  return { marks, order };
}

async function runBuddyHook(t, options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-buddy-delivery-"));
  const timelinePath = path.join(home, "timeline.txt");

  const posts = [];
  const sockets = new Set();
  let server = null;
  let child = null;
  // `closed` rejects on a spawn error and is only for the test body.
  // `childClosed` resolves on close and never rejects — teardown uses it so a
  // child 'error' cannot skip the receiver/HOME cleanup.
  let closed = null;
  let childClosed = null;
  let watchdog = null;

  // Register the single teardown before any await that can fail (mkdtemp
  // already succeeded), so a listen/EPERM error still removes HOME.
  t.after(async () => {
    if (watchdog) clearTimeout(watchdog);
    let reaped = true;
    try {
      if (child && childClosed) {
        // Wait for close whenever the child was spawned, even if exitCode is
        // already set but stdio has not closed yet.
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill(); } catch { /* the close wait below decides */ }
        }
        reaped = await Promise.race([
          childClosed.then(() => true),
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), 5000);
            if (typeof timer.unref === "function") timer.unref();
          }),
        ]);
      }
    } finally {
      // Stop the receiver: drop live sockets, then close the listener.
      try {
        if (server) {
          for (const socket of sockets) socket.destroy();
          await new Promise((resolve) => server.close(() => resolve()));
        }
      } finally {
        // Only then remove HOME. Async rm actually waits between retries;
        // fs.rmSync retryDelay does not reliably block on Windows.
        await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
    if (!reaped) throw new Error("test-owned hook child did not close within 5s");
  });

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method === "POST") posts.push(JSON.parse(body));
      res.setHeader("x-clawd-server", "clawd-on-desk");
      res.end("{}");
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAWD_")) delete env[key];
  }
  for (const key of [
    "NODE_OPTIONS",
    "TMUX",
    "TMUX_PANE",
    "ORCA_PANE_KEY",
    "WSL_DISTRO_NAME",
    "WSL_INTEROP",
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    CLAWD_BUDDY_HOME: home,
    CLAWD_BUDDY_PORT: String(server.address().port),
    CLAWD_BUDDY_WALK_MS: String(options.walkMs || 0),
    CLAWD_BUDDY_TIMELINE: timelinePath,
    CLAWD_BUDDY_STALL: options.stallDelivery ? "1" : "0",
    CLAWD_BUDDY_THROW: options.throwDelivery ? "1" : "0",
    CLAWD_BUDDY_PLATFORM: options.forceWindows ? "win32" : "",
  });

  child = spawn(process.execPath, ["--require", PRELOAD, options.script], {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // A failure must only terminate this test-owned child, never a user's app.
  watchdog = setTimeout(() => child.kill(), options.watchdogMs || 8000);
  child.stdin.on("error", () => {}); // The no-EOF case intentionally outlives the hook.

  childClosed = new Promise((resolve) => {
    child.once("close", () => resolve());
  });
  closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });

  if (!options.keepStdinOpen) {
    const payload = options.payload !== undefined
      ? options.payload
      : {
          hook_event_name: options.event || "PreToolUse",
          session_id: options.sessionId || "buddy-delivery-test",
          cwd: "D:/test",
        };
    child.stdin.end(options.input !== undefined ? options.input : JSON.stringify(payload));
  }

  const result = await closed;
  clearTimeout(watchdog);
  return {
    ...result,
    stdout,
    stderr,
    posts,
    timeline: readTimeline(timelinePath),
  };
}

function assertCleanEmptyJson(result) {
  assert.equal(result.signal, null, "hook must finish without the test watchdog");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "{}\n");
}

for (const target of TARGETS) {
  describe(`${target.name} hook delivery lifecycle`, () => {
    for (const [event, state] of [
      ["SessionStart", "idle"],
      ["PreToolUse", "working"],
      ["Stop", "attention"],
    ]) {
      it(`delivers ${event} when the process-tree walk exceeds the old safety timeout`, async (t) => {
        const result = await runBuddyHook(t, { script: target.script, event, walkMs: 1500 });
        assertCleanEmptyJson(result);
        assert.equal(result.posts.length, 1, "the receiver must actually get the event");
        assert.equal(result.posts[0].event, event);
        assert.equal(result.posts[0].state, state);
        assert.equal(result.posts[0].session_id, "buddy-delivery-test");
        assert.equal(result.posts[0].agent_id, target.agentId);

        // The walk really happened, in this process, and lasted past 800ms.
        assert.ok(result.timeline, "the fake walk must record its timeline");
        const { marks, order } = result.timeline;
        assert.ok(
          marks.walk_end - marks.walk_start >= 1200,
          `expected a >1.2s blocking walk, got ${JSON.stringify(marks)}`,
        );
        // The critical order is decided INSIDE the child: all timeline lines
        // are appended synchronously by one process, so the order cannot be
        // skewed by parent scheduling. Moving the stdout answer back after the
        // walk fails here.
        const stdoutAt = order.indexOf("stdout_write");
        const walkAt = order.indexOf("walk_start");
        assert.ok(stdoutAt !== -1, `stdout write must be recorded: ${order.join(",")}`);
        assert.ok(walkAt !== -1, `walk_start must be recorded: ${order.join(",")}`);
        assert.ok(
          stdoutAt < walkAt,
          `stdout write must precede walk_start, got order [${order.join(",")}]`,
        );
      });
    }

    it("reaps a stalled sender with its bounded exit backstop", async (t) => {
      const result = await runBuddyHook(t, {
        script: target.script,
        event: "PreToolUse",
        stallDelivery: true,
        watchdogMs: 15000,
      });
      assertCleanEmptyJson(result);
      assert.equal(result.posts.length, 0);
      // Both marks come from the child's own monotonic clock, so a slow cold
      // start cannot inflate the elapsed time and hide an 800ms backstop.
      const { send_start: sendStart, exit } = result.timeline.marks;
      assert.ok(Number.isFinite(sendStart), "the stalled sender must record send_start");
      assert.ok(Number.isFinite(exit), "the hook must record its exit");
      assert.ok(
        exit - sendStart >= target.backstopMs - 1000,
        `a stalled POST must survive the old 800ms timer (send_start=${sendStart}, exit=${exit})`,
      );
    });

    it("keeps valid stdout and a clean exit when the sender throws", async (t) => {
      const result = await runBuddyHook(t, {
        script: target.script,
        event: "PreToolUse",
        throwDelivery: true,
      });
      assertCleanEmptyJson(result);
      assert.equal(result.posts.length, 0);
    });

    it("answers and exits when stdin never closes", async (t) => {
      const result = await runBuddyHook(t, {
        script: target.script,
        keepStdinOpen: true,
      });
      assertCleanEmptyJson(result);
      assert.equal(result.posts.length, 0);
      const { stdin_start: stdinStart, exit } = result.timeline.marks;
      assert.ok(Number.isFinite(stdinStart), "the stdin reader must record stdin_start");
      assert.ok(Number.isFinite(exit), "the hook must record its exit");
      assert.ok(
        exit - stdinStart < 5000,
        `must not wait for stdin indefinitely (stdin_start=${stdinStart}, exit=${exit})`,
      );
    });

    it("answers and does not POST for malformed input", async (t) => {
      const result = await runBuddyHook(t, {
        script: target.script,
        input: "{invalid",
      });
      assertCleanEmptyJson(result);
      assert.equal(result.posts.length, 0);
    });
  });
}

describe("WorkBuddy hook delivery without a session id", () => {
  it("answers with an empty object and never contacts Clawd", async (t) => {
    const workbuddy = TARGETS.find((target) => target.agentId === "workbuddy");
    const result = await runBuddyHook(t, {
      script: workbuddy.script,
      payload: { hook_event_name: "UserPromptSubmit", prompt: "do a thing", cwd: "/tmp/repo" },
    });
    assertCleanEmptyJson(result);
    assert.equal(result.posts.length, 0);
  });
});

describe("WorkBuddy Windows snapshot deadline delivery", () => {
  it("delivers after a blocking walk reaches the 5s limit without delaying stdout", async (t) => {
    const workbuddy = TARGETS.find((target) => target.agentId === "workbuddy");
    const result = await runBuddyHook(t, {
      script: workbuddy.script,
      event: "Stop",
      walkMs: 5100,
      watchdogMs: 12000,
      forceWindows: true,
    });
    assertCleanEmptyJson(result);
    assert.equal(result.posts.length, 1, "the real receiver must get the event after the long walk");
    assert.equal(result.posts[0].event, "Stop");
    assert.equal(result.posts[0].agent_id, "workbuddy");
    const { order } = result.timeline;
    assert.ok(order.indexOf("stdout_write") < order.indexOf("walk_start"));
  });
});
