const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawn } = require("child_process");

const registry = require("../agents/registry");
const kirocrewAgent = require("../agents/kirocrew");
const {
  registerKiroCrewHooks,
  unregisterKiroCrewHooks,
  KIROCREW_HOOK_EVENTS,
  __test,
} = require("../hooks/kirocrew-install");

const BRIDGE = path.resolve(__dirname, "..", "hooks", "kirocrew-hook.js");
const SERVER_CONFIG = path.resolve(__dirname, "..", "hooks", "server-config.js");
const { buildKiroCrewHookPayload } = require("../hooks/kirocrew-hook-payload");
const tempDirs = [];

function startChildKiroCrewLock(lockPath, { directory = false } = {}) {
  const helperPath = path.resolve(__dirname, "..", "hooks", "kirocrew-store.js");
  const method = directory ? "acquireKiroCrewDirectoryLock" : "acquireKiroCrewLock";
  const source = [
    `const helper = require(${JSON.stringify(helperPath)});`,
    `const release = helper.${method}(${JSON.stringify(lockPath)});`,
    'if (typeof release !== "function") process.exit(5);',
    'process.stdout.write("ready\\n");',
    "process.stdin.resume();",
    'process.stdin.once("end", () => { release(); process.exit(0); });',
  ].join("\n");
  const child = spawn(process.execPath, ["-e", source], {
    cwd: path.resolve(__dirname, ".."),
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for child lock: ${stderr}`));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes("ready\n")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (stdout.includes("ready\n")) return;
      clearTimeout(timer);
      reject(new Error(`Lock child exited before acquiring (${code}): ${stderr}`));
    });
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.stdin.end();
  });
}

function makeTempCrewHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kirocrew-"));
  const crewDir = path.join(root, ".kiro", "crew");
  fs.mkdirSync(crewDir, { recursive: true });
  const hooksPath = path.join(crewDir, "hooks.json");
  tempDirs.push(root);
  return { root, crewDir, hooksPath };
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("KiroCrew agent descriptor", () => {
  it("is registered under the kirocrew id", () => {
    const a = registry.getAgent("kirocrew");
    assert.ok(a, "kirocrew agent should be in the registry");
    assert.strictEqual(a.id, "kirocrew");
    assert.strictEqual(a.name, "KiroCrew");
  });

  it("maps the four informational gateway events in PascalCase (no PreToolUse)", () => {
    // PreToolUse is intentionally absent — it fails closed in KiroCrew, so a
    // broken hook on that event would deny the tool. See hooks/kirocrew-hook.js.
    assert.deepStrictEqual(kirocrewAgent.eventMap, {
      AgentSpawn: "idle",
      UserPromptSubmit: "thinking",
      PostToolUse: "working",
      Stop: "attention",
    });
    assert.ok(!("PreToolUse" in kirocrewAgent.eventMap), "PreToolUse must not be mapped");
    assert.strictEqual(kirocrewAgent.stdinFormat, "PascalCase");
    assert.strictEqual(kirocrewAgent.eventSource, "hook");
  });

  it("registers exactly the four events (PreToolUse excluded)", () => {
    assert.deepStrictEqual([...KIROCREW_HOOK_EVENTS].sort(), [
      "AgentSpawn",
      "PostToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
    assert.ok(!KIROCREW_HOOK_EVENTS.includes("PreToolUse"));
  });

  it("declares no process names (the gateway is a background service)", () => {
    assert.deepStrictEqual(kirocrewAgent.processNames, { win: [], mac: [], linux: [] });
    const names = registry.getAllProcessNames().filter((p) => p.agentId === "kirocrew");
    assert.deepStrictEqual(names, []);
  });
});

describe("KiroCrew hook installer", () => {
  it("recognizes only exact two-token Node bridge commands", () => {
    const owns = __test.isOwnedKiroCrewCommand;
    assert.strictEqual(owns('"/usr/local/bin/node" "/old/path/kirocrew-hook.js"'), true);
    assert.strictEqual(owns('node /old/path/kirocrew-hook.js'), true);
    for (const platform of ["darwin", "linux", "win32"]) {
      const command = __test.formatHookCommand(
        platform === "win32" ? "C:/Program Files/nodejs/node.exe" : "/usr/local/bin/node",
        platform === "win32" ? "C:/Users/鹿鹿 User/hooks/kirocrew-hook.js" : "/Users/鹿鹿 User/hooks/kirocrew-hook.js",
        platform
      );
      assert.strictEqual(owns(command), true, `${platform} formatter output is recognized: ${command}`);
    }
    assert.strictEqual(owns("node /user/kirocrew-hook.js.backup"), false);
    assert.strictEqual(owns("echo kirocrew-hook.js"), false);
    assert.strictEqual(owns("node /user/kirocrew-hook.js --extra"), false);
    assert.strictEqual(owns("node /user/kirocrew-hook.js && echo foreign"), false);
    assert.strictEqual(owns('"$(echo /usr/bin)/node" "/user/kirocrew-hook.js"'), false);
    assert.strictEqual(owns('cmd /d /s /c ""%NODE_HOME%/node.exe" "C:/old/kirocrew-hook.js""'), false);
    assert.strictEqual(owns('cmd /d /s /c ""C:/Program Files/node.exe" "C:/User&Other/kirocrew-hook.js""'), false);
  });

  it("registers one hook per gateway event into hooks.json", () => {
    const { hooksPath } = makeTempCrewHome();
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: [] }));

    const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(result.added, KIROCREW_HOOK_EVENTS.length);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.gatewayRunning, false);

    const store = readJson(hooksPath);
    assert.strictEqual(store.hooks.length, KIROCREW_HOOK_EVENTS.length);
    const events = store.hooks.map((h) => h.event).sort();
    assert.deepStrictEqual(events, [...KIROCREW_HOOK_EVENTS].sort());
    for (const h of store.hooks) {
      assert.ok(h.command.includes(__test.MARKER), "command points at the bridge");
      assert.strictEqual(h.enabled, true);
      assert.ok(h.timeout >= 1 && h.timeout <= 300, "timeout within KiroCrew bounds");
      assert.strictEqual(h.matcher, "");
      assert.ok(typeof h.id === "string" && h.id.length > 0);
    }
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(hooksPath).mode & 0o777, 0o600, "published hooks.json remains owner-only");
    }
  });

  it("preserves a valid webhook-only context store and unknown fields", () => {
    const { hooksPath } = makeTempCrewHome();
    const original = { webhooks: [{ name: "agent" }], extra: { keep: true } };
    fs.writeFileSync(hooksPath, JSON.stringify(original));
    const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(result.status, "ok");
    const store = readJson(hooksPath);
    assert.deepStrictEqual(store.webhooks, original.webhooks);
    assert.deepStrictEqual(store.extra, original.extra);
    assert.strictEqual(store.hooks.length, KIROCREW_HOOK_EVENTS.length);
  });

  it("fails closed on malformed root/hooks shapes without changing bytes", () => {
    for (const raw of ["[]", "null", "{\"hooks\":{}}", "{\"hooks\":null}", "{ nope"]) {
      const { hooksPath } = makeTempCrewHome();
      fs.writeFileSync(hooksPath, raw);
      const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
      assert.strictEqual(result.status, "error", raw);
      assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), raw, "malformed store bytes remain untouched");
    }
  });

  it("refuses symlinked hooks.json without changing the target", { skip: process.platform === "win32" }, () => {
    const { crewDir, hooksPath } = makeTempCrewHome();
    const target = path.join(crewDir, "user-hooks.json");
    const before = '{"hooks":[],"foreign":true}\n';
    fs.writeFileSync(target, before, { mode: 0o644 });
    fs.symlinkSync(target, hooksPath);
    const originalMode = fs.statSync(target).mode & 0o777;

    const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(fs.lstatSync(hooksPath).isSymbolicLink(), true);
    assert.strictEqual(fs.readFileSync(target, "utf8"), before);
    assert.strictEqual(fs.statSync(target).mode & 0o777, originalMode);
  });

  it("removes the obsolete owned PreToolUse entry while preserving foreign entries", () => {
    const { hooksPath } = makeTempCrewHome();
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: [
      { event: "PreToolUse", command: '"/node" "/old/kirocrew-hook.js"' },
      { event: "PreToolUse", command: "echo foreign", name: "user" },
      { event: "PreToolUse", command: "node /user/kirocrew-hook.js.backup", id: "suffix" },
    ] }));
    const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.removedObsolete, 1);
    const hooks = readJson(hooksPath).hooks;
    assert.ok(hooks.some((hook) => hook.event === "PreToolUse" && hook.command === "echo foreign"));
    assert.deepStrictEqual(
      hooks.find((hook) => hook.id === "suffix"),
      { event: "PreToolUse", command: "node /user/kirocrew-hook.js.backup", id: "suffix" },
      "a marker suffix is not proof of ownership"
    );
    assert.ok(!hooks.some((hook) => hook.event === "PreToolUse" && __test.isOwnedKiroCrewCommand(hook.command)));
  });

  it("preserves marker-like foreign commands during install and uninstall", () => {
    const { hooksPath } = makeTempCrewHome();
    const foreign = [
      { id: "suffix", event: "PreToolUse", command: "node /user/kirocrew-hook.js.backup" },
      { id: "echo", event: "Stop", command: "echo kirocrew-hook.js" },
      { id: "composed", event: "AgentSpawn", command: "node /user/kirocrew-hook.js && echo foreign" },
    ];
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: foreign }));

    const installed = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(installed.status, "ok");
    assert.strictEqual(installed.added, KIROCREW_HOOK_EVENTS.length);
    let hooks = readJson(hooksPath).hooks;
    for (const original of foreign) {
      assert.deepStrictEqual(hooks.find((entry) => entry.id === original.id), original);
    }

    const removed = unregisterKiroCrewHooks({ hooksPath, silent: true });
    assert.strictEqual(removed.status, "ok");
    assert.strictEqual(removed.removed, KIROCREW_HOOK_EVENTS.length);
    hooks = readJson(hooksPath).hooks;
    assert.deepStrictEqual(hooks, foreign);
  });

  it("is idempotent on re-run (no duplicates)", () => {
    const { hooksPath } = makeTempCrewHome();
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: [] }));
    registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    const second = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.skipped, KIROCREW_HOOK_EVENTS.length);
    assert.strictEqual(readJson(hooksPath).hooks.length, KIROCREW_HOOK_EVENTS.length);
  });

  it("tightens permissions on an already-current store without losing unknown keys", () => {
    const { hooksPath } = makeTempCrewHome();
    const command = __test.formatHookCommand("/usr/local/bin/node", __test.getHookScriptPath());
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: KIROCREW_HOOK_EVENTS.map((event) => __test.makeHookEntry(event, command)),
      gatewayOptions: { preserve: true },
    }));
    if (process.platform !== "win32") fs.chmodSync(hooksPath, 0o644);
    const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.skipped, KIROCREW_HOOK_EVENTS.length);
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(hooksPath).mode & 0o777, 0o600);
    }
    assert.deepStrictEqual(readJson(hooksPath).gatewayOptions, { preserve: true });
  });

  it("refreshes a stale node/script path instead of duplicating", () => {
    const { hooksPath } = makeTempCrewHome();
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: [] }));
    registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });

    const store = readJson(hooksPath);
    const stop = store.hooks.find((h) => h.event === "Stop");
    stop.command = "node /old/path/kirocrew-hook.js";
    fs.writeFileSync(hooksPath, JSON.stringify(store));

    const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(result.added, 0);
    assert.strictEqual(readJson(hooksPath).hooks.length, KIROCREW_HOOK_EVENTS.length);
  });

  it("keeps the existing command when node cannot be resolved (no bare 'node')", () => {
    const { hooksPath } = makeTempCrewHome();
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: [] }));
    registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    const original = readJson(hooksPath).hooks.find((h) => h.event === "Stop").command;

    // nodeBin:null simulates resolveNodeBin() returning null — existing entries
    // must be left untouched rather than rewritten to a bare "node".
    const result = registerKiroCrewHooks({ hooksPath, nodeBin: null, silent: true });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "node-not-found");
    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    const after = readJson(hooksPath).hooks.find((h) => h.event === "Stop").command;
    assert.strictEqual(after, original, "existing command preserved");
    for (const h of readJson(hooksPath).hooks) {
      assert.ok(!/(^|["\s])node(["\s]|$)/.test(h.command) || h.command.includes("/"), "no bare node");
    }
  });

  it("creates no entries with a bare 'node' when node is unresolved and the store is empty", () => {
    const { hooksPath } = makeTempCrewHome();
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: [] }));
    const result = registerKiroCrewHooks({ hooksPath, nodeBin: null, silent: true });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "node-not-found");
    assert.strictEqual(result.added, 0);
    assert.strictEqual(readJson(hooksPath).hooks.length, 0);
  });

  it("refuses a desired command shape the ownership parser cannot later recognize", () => {
    const { hooksPath } = makeTempCrewHome();
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: [] }));
    const result = registerKiroCrewHooks({ hooksPath, nodeBin: "$HOME/bin/node", silent: true });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "unsupported-hook-command");
    assert.deepStrictEqual(readJson(hooksPath).hooks, []);

    const windowsResult = registerKiroCrewHooks({
      hooksPath,
      nodeBin: "C:/Program Files/Node&Other/node.exe",
      platform: "win32",
      silent: true,
    });
    assert.strictEqual(windowsResult.status, "error");
    assert.strictEqual(windowsResult.reason, "unsupported-hook-command");
    assert.deepStrictEqual(readJson(hooksPath).hooks, []);
  });

  it("preserves user-authored hooks and removes only ours on uninstall", () => {
    const { hooksPath } = makeTempCrewHome();
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: [{ id: "user0001", name: "my hook", event: "Stop", command: "echo hi", enabled: true }],
      })
    );
    registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(readJson(hooksPath).hooks.length, KIROCREW_HOOK_EVENTS.length + 1);

    const un = unregisterKiroCrewHooks({ hooksPath, silent: true });
    assert.strictEqual(un.registrationRemoved, true);
    assert.strictEqual(un.removed, KIROCREW_HOOK_EVENTS.length);
    const remaining = readJson(hooksPath).hooks;
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].id, "user0001");
  });

  it("skips registration when ~/.kiro/crew does not exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-nocrew-"));
    tempDirs.push(root);
    const hooksPath = path.join(root, ".kiro", "crew", "hooks.json");
    const result = registerKiroCrewHooks({ hooksPath, silent: true });
    assert.strictEqual(result.added, 0);
    assert.ok(!fs.existsSync(hooksPath));
  });

  it("refuses to write while the gateway is running, and reports it", () => {
    const { crewDir, hooksPath } = makeTempCrewHome();
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: [] }));
    // A live PID: this very test process is guaranteed alive.
    fs.writeFileSync(path.join(crewDir, "gateway.lock"), String(process.pid));

    const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.gatewayRunning, true);
    assert.strictEqual(result.blocked, "gateway-running");
    assert.strictEqual(result.status, "error");
    assert.strictEqual(readJson(hooksPath).hooks.length, 0, "nothing written under a running gateway");

    const un = unregisterKiroCrewHooks({ hooksPath, silent: true });
    assert.strictEqual(un.gatewayRunning, true);
    assert.strictEqual(un.blocked, "gateway-running");
    assert.strictEqual(un.registrationRemoved, false);
  });

  it("does not claim a missing hooks file is uninstalled when a gateway is live", () => {
    const { crewDir, hooksPath } = makeTempCrewHome();
    fs.writeFileSync(path.join(crewDir, "gateway.lock"), String(process.pid));
    const result = unregisterKiroCrewHooks({ hooksPath, silent: true });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.registrationRemoved, false);
    assert.strictEqual(result.blocked, "gateway-running");
  });

  it("does not read or write while another process holds upstream hooks.json.lock", async () => {
    const { hooksPath } = makeTempCrewHome();
    const before = '{"hooks":[],"foreign":true}\n';
    fs.writeFileSync(hooksPath, before);
    const child = await startChildKiroCrewLock(`${hooksPath}.lock`);
    try {
      const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
      assert.strictEqual(result.status, "error");
      assert.strictEqual(result.blocked, "locked");
      assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
      const un = unregisterKiroCrewHooks({ hooksPath, silent: true });
      assert.strictEqual(un.status, "error");
      assert.strictEqual(un.registrationRemoved, false);
      assert.strictEqual(un.blocked, "locked");
      assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
    } finally {
      await stopChild(child);
    }
  });

  it("refuses the native gateway lock even when gateway.lock has no PID", async () => {
    const { crewDir, hooksPath } = makeTempCrewHome();
    const gatewayLockPath = path.join(crewDir, "gateway.lock");
    const before = '{"hooks":[],"foreign":true}\n';
    fs.writeFileSync(hooksPath, before);
    fs.writeFileSync(gatewayLockPath, "");
    const child = await startChildKiroCrewLock(gatewayLockPath);
    try {
      const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
      assert.strictEqual(result.status, "error");
      assert.strictEqual(result.blocked, "gateway-running");
      assert.strictEqual(result.gatewayRunning, true);
      assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
      const un = unregisterKiroCrewHooks({ hooksPath, silent: true });
      assert.strictEqual(un.status, "error");
      assert.strictEqual(un.registrationRemoved, false);
      assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
    } finally {
      await stopChild(child);
    }
  });

  it("respects another process holding the upstream POSIX KiroCrew-home directory lock", { skip: process.platform === "win32" }, async () => {
    const { crewDir, hooksPath } = makeTempCrewHome();
    const before = '{"hooks":[],"foreign":true}\n';
    fs.writeFileSync(hooksPath, before);
    const child = await startChildKiroCrewLock(crewDir, { directory: true });
    try {
      const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
      assert.strictEqual(result.status, "error");
      assert.strictEqual(result.blocked, "gateway-running");
      assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
    } finally {
      await stopChild(child);
    }
  });

  it("writes when a stale gateway.lock points at a dead pid", () => {
    const { crewDir, hooksPath } = makeTempCrewHome();
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: [] }));
    // PID 1 exists but is not us; use an unlikely-high pid that is almost
    // certainly dead so kill(pid,0) throws ESRCH → gateway considered down.
    fs.writeFileSync(path.join(crewDir, "gateway.lock"), "2147483646");

    const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(result.gatewayRunning, false);
    assert.strictEqual(result.added, KIROCREW_HOOK_EVENTS.length);
  });

  it("force=true overrides the running-gateway guard", () => {
    const { crewDir, hooksPath } = makeTempCrewHome();
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: [] }));
    fs.writeFileSync(path.join(crewDir, "gateway.lock"), String(process.pid));

    const result = registerKiroCrewHooks({ hooksPath, nodeBin: "/usr/local/bin/node", silent: true, force: true });
    assert.strictEqual(result.added, KIROCREW_HOOK_EVENTS.length);
  });
});

describe("KiroCrew hook bridge", () => {
  // Exercise the real bridge entry point, but preload an isolated transport
  // stub that only writes the submitted JSON to a temp fixture. No test can
  // inherit or contact the user's Clawd server.
  function runBridge(eventName, stdin) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kirocrew-bridge-"));
    tempDirs.push(root);
    const capturePath = path.join(root, "payload.json");
    const preloadPath = path.join(root, "capture.js");
    fs.writeFileSync(preloadPath, [
      'const fs = require("fs");',
      `const config = require(${JSON.stringify(SERVER_CONFIG)});`,
      'config.postStateToRunningServer = (body, options, callback) => {',
      '  fs.writeFileSync(process.env.KIROCREW_TEST_CAPTURE, body, "utf8");',
      '  callback();',
      '};',
    ].join("\n"));
    const env = {
      PATH: process.env.PATH || "",
      HOME: root,
      USERPROFILE: root,
      TMPDIR: root,
      KIROCREW_HOOK_EVENT: eventName,
      KIROCREW_TEST_CAPTURE: capturePath,
    };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    try {
      execFileSync(process.execPath, ["--require", preloadPath, BRIDGE], {
        input: stdin,
        env,
        timeout: 5000,
      });
      return { status: 0, capturePath };
    } catch (err) {
      return { status: typeof err.status === "number" ? err.status : 1, capturePath };
    }
  }

  it("posts a mapped event through the isolated capture transport without project cwd", () => {
    const run = runBridge("PostToolUse", JSON.stringify({
      hook_event_name: "PostToolUse", session_key: "session-a", cwd: "/gateway/root",
    }));
    assert.strictEqual(run.status, 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(run.capturePath, "utf8")), {
      state: "working", session_id: "session-a", event: "PostToolUse", agent_id: "kirocrew",
    });
  });

  it("exits 0 on PreToolUse (unmapped) without submitting a state request", () => {
    const run = runBridge("PreToolUse", JSON.stringify({ hook_event_name: "PreToolUse" }));
    assert.strictEqual(run.status, 0);
    assert.ok(!fs.existsSync(run.capturePath));
  });

  it("exits 0 on an unmapped event", () => {
    const run = runBridge("FileCreated", JSON.stringify({ hook_event_name: "FileCreated" }));
    assert.strictEqual(run.status, 0);
    assert.ok(!fs.existsSync(run.capturePath));
  });

  it("keeps the existing env-event fallback for malformed stdin without network access", () => {
    const run = runBridge("Stop", "not json");
    assert.strictEqual(run.status, 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(run.capturePath, "utf8")), {
      state: "attention", session_id: "default", event: "Stop", agent_id: "kirocrew",
    });
  });
});

describe("KiroCrew bridge session + host attribution", () => {
  // Pull the bridge's pure helpers into this process by re-implementing the
  // require surface it uses, so we can assert body shape without a live server.
  // The bridge is a script, so we exercise its resolveSessionId indirectly via
  // a tiny inline copy guarded by the same precedence contract it documents.
  const resolveSessionId = require("../hooks/kirocrew-hook-session");

  it("prefers session_key, then parent_session_key, then session_id", () => {
    assert.strictEqual(resolveSessionId({ session_key: "A", parent_session_key: "B", session_id: "C" }), "A");
    assert.strictEqual(resolveSessionId({ parent_session_key: "B", session_id: "C" }), "B");
    assert.strictEqual(resolveSessionId({ session_id: "C" }), "C");
    assert.strictEqual(resolveSessionId({}), "default");
  });

  it("suffixes a subagent id so its events don't un-finish the parent", () => {
    assert.strictEqual(resolveSessionId({ session_key: "A", subagent_id: "s1" }), "A::sub:s1");
  });

  it("does not trust gateway cwd and ignores inherited object-property event names", () => {
    const body = buildKiroCrewHookPayload({
      hook_event_name: "AgentSpawn", session_key: "A", cwd: "/gateway/root",
    });
    assert.strictEqual(body.session_id, "A");
    assert.ok(!Object.prototype.hasOwnProperty.call(body, "cwd"));
    assert.strictEqual(buildKiroCrewHookPayload({ hook_event_name: "toString" }), null);
  });
});
