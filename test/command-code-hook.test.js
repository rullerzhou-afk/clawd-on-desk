const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createSpawnedHookHarness, SPAWN_RECORDER } = require("./helpers/spawned-hook");
const { SERVER_PORTS } = require("../hooks/server-config");
const {
  AGENT_ID,
  HOOK_MAP,
  SAFETY_TIMEOUT_MS,
  POST_EXIT_BACKSTOP_MS,
  isCommandCodeAgentCommandLine,
  normalizeSessionId,
  buildStateBody,
  pidCacheContext,
  shouldResolvePid,
  sendHookEvent,
  main,
} = require("../hooks/command-code-hook");
const { HOOK_TIMEOUT_SECONDS } = require("../hooks/command-code-install");

describe("Command Code hook runtime (Phase 1 state-only)", () => {
  it("maps the four documented events", () => {
    assert.strictEqual(HOOK_MAP.SessionStart.state, "idle");
    assert.strictEqual(HOOK_MAP.SessionStart.event, "SessionStart");
    assert.strictEqual(HOOK_MAP.PreToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PreToolUse.event, "PreToolUse");
    assert.strictEqual(HOOK_MAP.PostToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUse.event, "PostToolUse");
    // Stop is turn completion → attention, like the other Claude-style agents.
    assert.strictEqual(HOOK_MAP.Stop.state, "attention");
    assert.strictEqual(HOOK_MAP.Stop.event, "Stop");
    // There is no SessionEnd / Notification / PermissionRequest event.
    assert.strictEqual(HOOK_MAP.SessionEnd, undefined);
    assert.strictEqual(HOOK_MAP.Notification, undefined);
    assert.strictEqual(HOOK_MAP.PermissionRequest, undefined);
  });

  it("namespaces session ids as command-code:<raw> and drops placeholders", () => {
    assert.strictEqual(normalizeSessionId("abc"), "command-code:abc");
    assert.strictEqual(normalizeSessionId("  abc  "), "command-code:abc");
    assert.strictEqual(normalizeSessionId(""), "");
    assert.strictEqual(normalizeSessionId(null), "");
    assert.strictEqual(normalizeSessionId("default"), "");
    assert.strictEqual(normalizeSessionId("command-code:default"), "");
    assert.strictEqual(normalizeSessionId("x".repeat(201)), "");
    assert.strictEqual(normalizeSessionId("bad\nid"), "");
  });

  it("builds a state body with agent_id, namespaced session, tool metadata, and pid fields", () => {
    const body = buildStateBody({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: "/work",
      tool_name: "shell_command",
      permission_mode: "default",
      tool_input: { command: "npm test" },
    }, { pidMeta: { stablePid: 123, agentPid: 456 } });

    assert.strictEqual(body.agent_id, AGENT_ID);
    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.event, "PreToolUse");
    assert.strictEqual(body.session_id, "command-code:s1");
    assert.strictEqual(body.cwd, "/work");
    assert.strictEqual(body.tool_name, "shell_command");
    assert.strictEqual(body.source_pid, 123);
    assert.strictEqual(body.agent_pid, 456);
    // No prompt, tool input, or free-form content is ever forwarded.
    assert.strictEqual(body.tool_input, undefined);
    assert.strictEqual(body.prompt, undefined);
  });

  it("does not attach tool_name to lifecycle events", () => {
    const start = buildStateBody({ hook_event_name: "SessionStart", session_id: "s1" }, {});
    assert.strictEqual(start.state, "idle");
    assert.strictEqual(start.tool_name, undefined);

    const stop = buildStateBody({ hook_event_name: "Stop", session_id: "s1", stop_hook_active: false }, {});
    assert.strictEqual(stop.state, "attention");
    assert.strictEqual(stop.tool_name, undefined);
  });

  it("returns null for unmapped events, malformed payloads, and missing sessions", () => {
    assert.strictEqual(buildStateBody({ hook_event_name: "UserPromptSubmit", session_id: "s1" }, {}), null);
    assert.strictEqual(buildStateBody({ hook_event_name: "SessionEnd", session_id: "s1" }, {}), null);
    assert.strictEqual(buildStateBody({ hook_event_name: "PreToolUse" }, {}), null);
    assert.strictEqual(buildStateBody({ hook_event_name: "PreToolUse", session_id: "default" }, {}), null);
    assert.strictEqual(buildStateBody(null, {}), null);
    assert.strictEqual(buildStateBody([], {}), null);
    assert.strictEqual(buildStateBody("payload", {}), null);
  });

  it("uses host instead of local pid fields in remote mode", () => {
    const body = buildStateBody({ hook_event_name: "Stop", session_id: "s1" }, { remote: true, host: "myhost" });
    assert.strictEqual(body.host, "myhost");
    assert.strictEqual(body.source_pid, undefined);
    assert.strictEqual(body.agent_pid, undefined);
  });

  it("narrows command-line detection to the command-code package entry", () => {
    assert.strictEqual(
      isCommandCodeAgentCommandLine("node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\command-code\\dist\\index.mjs"),
      true
    );
    assert.strictEqual(
      isCommandCodeAgentCommandLine("/usr/local/lib/node_modules/command-code/dist/index.mjs"),
      true
    );
    assert.strictEqual(
      isCommandCodeAgentCommandLine("NODE /home/me/.bun/install/global/node_modules/command-code/dist/index.mjs"),
      true
    );
    // Must NOT match other executables or unrelated mentions.
    assert.strictEqual(isCommandCodeAgentCommandLine("node /home/me/command-code-notes/index.js"), false);
    assert.strictEqual(isCommandCodeAgentCommandLine("node /home/me/command-code/src/app.js"), false);
    assert.strictEqual(isCommandCodeAgentCommandLine("cmd.exe /c dir"), false);
    assert.strictEqual(isCommandCodeAgentCommandLine(""), false);
    assert.strictEqual(isCommandCodeAgentCommandLine(null), false);
  });

  it("builds the #634 resolver cache context from the raw session id and cwd", () => {
    assert.deepStrictEqual(pidCacheContext({ hook_event_name: "SessionStart", session_id: "s1", cwd: "D:/repo" }), {
      namespace: "command-code",
      sessionId: "command-code:s1",
      cacheCwd: "D:/repo",
      lifecycle: "start",
      cacheable: true,
    });
    assert.deepStrictEqual(pidCacheContext({ hook_event_name: "Stop", session_id: "s1", cwd: "D:/repo" }), {
      namespace: "command-code",
      sessionId: "command-code:s1",
      cacheCwd: "D:/repo",
      lifecycle: "event",
      cacheable: true,
    });
    // Placeholder / missing ids and missing cwd must never key a shared cache.
    assert.strictEqual(pidCacheContext({ hook_event_name: "Stop", session_id: "default", cwd: "D:/repo" }).cacheable, false);
    assert.strictEqual(pidCacheContext({ hook_event_name: "Stop", session_id: "s1" }).cacheable, false);
    assert.strictEqual(pidCacheContext({ hook_event_name: "Stop" }).cacheable, false);
  });

  it("resolves a pid only for mapped events and never in remote mode", () => {
    assert.strictEqual(shouldResolvePid({ hook_event_name: "Stop" }, {}), true);
    assert.strictEqual(shouldResolvePid({ hook_event_name: "PreToolUse" }, {}), true);
    assert.strictEqual(shouldResolvePid({ hook_event_name: "Stop" }, { CLAWD_REMOTE: "1" }), false);
    assert.strictEqual(shouldResolvePid({ hook_event_name: "UserPromptSubmit" }, {}), false);
    assert.strictEqual(shouldResolvePid(null, {}), false);
  });

  it("sendHookEvent always writes {} and posts the mapped Stop body", async () => {
    const posted = [];
    const result = await sendHookEvent(
      { hook_event_name: "Stop", session_id: "s1", cwd: "D:/repo" },
      {
        env: {},
        resolvePid: () => ({ stablePid: 7 }),
        postState: (bodyStr, _opts, cb) => { posted.push(JSON.parse(bodyStr)); cb(true, 23333); },
      }
    );
    assert.strictEqual(result.stdout, "{}\n");
    assert.strictEqual(result.posted, true);
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].state, "attention");
    assert.strictEqual(posted[0].agent_id, "command-code");
    assert.strictEqual(posted[0].session_id, "command-code:s1");
    assert.strictEqual(posted[0].source_pid, 7);
  });

  it("sendHookEvent returns {} and does not post for unmapped events or missing sessions", async () => {
    let postedCount = 0;
    for (const payload of [
      { hook_event_name: "UserPromptSubmit", session_id: "s1" },
      { hook_event_name: "PreToolUse" },
    ]) {
      const result = await sendHookEvent(payload, {
        env: {},
        postState: () => { postedCount++; },
      });
      assert.strictEqual(result.stdout, "{}\n");
      assert.strictEqual(result.posted, false);
    }
    assert.strictEqual(postedCount, 0);
  });

  // Reviewer nit on #1185: the 2s safety timer was shorter than the shared
  // resolver's 3s Windows snapshot budget, so a slow snapshot let the overdue
  // timer exit the process before the state POST left the socket. stdout must
  // therefore be answered before the walk, never instead of it.
  it("answers stdout before the pid walk and still posts under the re-armed backstop", async () => {
    const order = [];
    const posted = [];
    await new Promise((resolve) => {
      main({
        env: {},
        readStdinJson: () => Promise.resolve({
          hook_event_name: "PreToolUse",
          session_id: "s1",
          cwd: "D:/repo",
        }),
        writeStdout: (chunk, callback) => {
          order.push(`stdout:${chunk}`);
          if (typeof callback === "function") callback();
        },
        readHostPrefix: () => "",
        resolvePid: () => { order.push("resolve"); return { stablePid: 5 }; },
        postState: (bodyStr, _options, cb) => {
          order.push("post");
          posted.push(JSON.parse(bodyStr));
          cb(true, 23333);
        },
        exit: (code) => { order.push(`exit:${code}`); resolve(); },
      });
    });

    assert.deepStrictEqual(order, ["stdout:{}\n", "resolve", "post", "exit:0"]);
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].session_id, "command-code:s1");
    assert.strictEqual(posted[0].state, "working");
    assert.strictEqual(posted[0].source_pid, 5);
  });

  it("answers stdout and posts nothing for an unmapped event", async () => {
    const order = [];
    await new Promise((resolve) => {
      main({
        env: {},
        readStdinJson: () => Promise.resolve({ hook_event_name: "SessionEnd", session_id: "s1" }),
        writeStdout: (chunk, callback) => {
          order.push(`stdout:${chunk}`);
          if (typeof callback === "function") callback();
        },
        postState: () => { order.push("post"); },
        resolvePid: () => { order.push("resolve"); return {}; },
        exit: (code) => { order.push(`exit:${code}`); resolve(); },
      });
    });

    assert.deepStrictEqual(order, ["stdout:{}\n", "exit:0"]);
  });

  it("keeps the post backstop above the Windows snapshot budget and below the registered hook timeout", () => {
    assert.strictEqual(SAFETY_TIMEOUT_MS, 2000, "the guard only covers the stdin wait");
    assert.ok(
      POST_EXIT_BACKSTOP_MS > 3000,
      "must outlast the shared resolver's default Windows snapshot budget"
    );
    assert.ok(
      POST_EXIT_BACKSTOP_MS < HOOK_TIMEOUT_SECONDS * 1000,
      "must reap a wedged hook before Command Code aborts it"
    );
  });
});

// The reviewer's nit on #1185, exercised against the real script and a real
// socket: the 2s safety timer used to be armed across the synchronous
// process-tree walk while the shared resolver allows that snapshot 3s on
// Windows. A snapshot slower than 2s therefore let the overdue timer exit the
// hook while the state POST was still on the wire, and the session state never
// reached Clawd. A faked HTTP layer cannot show this — its responses are
// delivered on nextTick, which always wins over an overdue timer — so this
// test owns a real listener and asserts the server actually received the body.
describe("Command Code hook — real process, real socket, slow snapshot", { skip: process.platform !== "win32" }, () => {
  const HOOK_PATH = path.resolve(__dirname, "..", "hooks", "command-code-hook.js");
  const SLOW_SNAPSHOT_MS = 2200;
  let hookHarness;
  let server;
  let serverPort;
  let received;

  function listen(port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => { server.removeListener("listening", onListening); reject(err); };
      const onListening = () => { server.removeListener("error", onError); resolve(port); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
  }

  async function listenOnFirstFreePort() {
    let lastError = null;
    for (const port of SERVER_PORTS) {
      try {
        return await listen(port);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  // A real socket needs the test process to stay on the event loop, so this
  // cannot use the spawnSync-based helper.
  function spawnHook(payload, preloads, env) {
    return new Promise((resolve) => {
      const argv = [];
      for (const preload of preloads) argv.push("--require", preload);
      argv.push(HOOK_PATH);
      const child = spawn(process.execPath, argv, { env, windowsHide: true });
      let stdout = "";
      let stderr = "";
      // A wedged child must not hang the file (direct `node --test` runs have
      // no per-test timeout).
      const reaper = setTimeout(() => child.kill(), 15000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => {
        clearTimeout(reaper);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
  }

  function hookEnv(extra = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAWD_")) delete env[key];
    }
    for (const key of ["NODE_OPTIONS", "ORCA_PANE_KEY", "TMUX", "TMUX_PANE"]) delete env[key];
    return Object.assign(env, {
      HOME: hookHarness.home,
      USERPROFILE: hookHarness.home,
      APPDATA: path.join(hookHarness.home, "app-data"),
      LOCALAPPDATA: path.join(hookHarness.home, "local-app-data"),
      XDG_CONFIG_HOME: path.join(hookHarness.home, "xdg-config"),
      CLAWD_TEST_USER_DATA: hookHarness.userData,
      CLAWD_PROBE_OUT: path.join(hookHarness.home, "spawns.json"),
    }, extra);
  }

  before(async () => {
    hookHarness = createSpawnedHookHarness({ prefix: "clawd-command-code-slow-" });
    received = [];
    server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { "content-type": "application/json", "x-clawd-server": "clawd-on-desk" });
        res.end("{}");
      });
    });
    serverPort = await listenOnFirstFreePort();
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    hookHarness.cleanup();
  });

  it("still answers {} and delivers the state POST when the snapshot outruns the old 2s guard", async () => {
    fs.writeFileSync(
      path.join(hookHarness.home, ".clawd", "runtime.json"),
      JSON.stringify({ app: "clawd-on-desk", port: serverPort, ownerPid: process.pid }),
      "utf8"
    );
    const preloadPath = path.join(hookHarness.home, "slow-snapshot-preload.js");
    // Wraps whatever execFileSync the spawn recorder installed, so the walk is
    // still recorded as an attempted spawn — only the deadline changes. The
    // wait is a parked Atomics.wait, not a spin loop: the suite runs many files
    // in parallel and a busy core would skew other wall-clock tests.
    fs.writeFileSync(preloadPath, `
      const cp = require("child_process");
      const inner = cp.execFileSync;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      cp.execFileSync = function slowExecFileSync(file, ...rest) {
        if (!String(file).toLowerCase().includes("powershell")) return inner.apply(cp, [file, ...rest]);
        Atomics.wait(sleeper, 0, 0, ${SLOW_SNAPSHOT_MS});
        return inner.apply(cp, [file, ...rest]);
      };
    `, "utf8");

    const result = await spawnHook({
      hook_event_name: "PreToolUse",
      session_id: "s-slow",
      cwd: "D:/repo",
      tool_name: "shell_command",
    }, [SPAWN_RECORDER, preloadPath], hookEnv());

    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(result.stdout, "{}\n", "Command Code must always receive valid `{}`");
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(hookHarness.home, "spawns.json"), "utf8")),
      ["powershell.exe"],
      "the walk must really have run"
    );

    // Parsed defensively: other test files running in parallel also race for
    // the 23333-23337 range, so only our own session id is asserted on.
    const stateBodies = received
      .filter((entry) => entry.method === "POST" && entry.url === "/state")
      .map((entry) => { try { return JSON.parse(entry.body); } catch { return null; } })
      .filter(Boolean);
    const body = stateBodies.find((parsed) => parsed.session_id === "command-code:s-slow");
    assert.ok(body, `expected the state POST to reach Clawd; got ${JSON.stringify(received)}`);
    assert.strictEqual(body.agent_id, "command-code");
    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.tool_name, "shell_command");
  });
});
