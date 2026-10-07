const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const registry = require("../agents/registry");
const kirocrewAgent = require("../agents/kirocrew");
const {
  registerKiroCrewHooks,
  unregisterKiroCrewHooks,
  KIROCREW_HOOK_EVENTS,
  __test,
} = require("../hooks/kirocrew-install");

const BRIDGE = path.resolve(__dirname, "..", "hooks", "kirocrew-hook.js");
const tempDirs = [];

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
    assert.strictEqual(result.added, 0);
    assert.strictEqual(readJson(hooksPath).hooks.length, 0);
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
    assert.strictEqual(readJson(hooksPath).hooks.length, 0, "nothing written under a running gateway");

    const un = unregisterKiroCrewHooks({ hooksPath, silent: true });
    assert.strictEqual(un.gatewayRunning, true);
    assert.strictEqual(un.blocked, "gateway-running");
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
  // No pet server is running in the test env; the bridge must always exit 0.
  function runBridge(eventName, stdin, extraEnv = {}) {
    try {
      execFileSync(process.execPath, [BRIDGE], {
        input: stdin,
        env: { ...process.env, KIROCREW_HOOK_EVENT: eventName, ...extraEnv },
        timeout: 5000,
      });
      return 0;
    } catch (err) {
      return typeof err.status === "number" ? err.status : 1;
    }
  }

  it("exits 0 on a mapped event with no server running", () => {
    assert.strictEqual(runBridge("PostToolUse", JSON.stringify({ hook_event_name: "PostToolUse", cwd: "/tmp/x" })), 0);
  });

  it("exits 0 on PreToolUse (now unmapped — never denies a tool)", () => {
    assert.strictEqual(runBridge("PreToolUse", JSON.stringify({ hook_event_name: "PreToolUse" })), 0);
  });

  it("exits 0 on an unmapped event", () => {
    assert.strictEqual(runBridge("FileCreated", JSON.stringify({ hook_event_name: "FileCreated" })), 0);
  });

  it("exits 0 on malformed stdin", () => {
    assert.strictEqual(runBridge("Stop", "not json"), 0);
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
});
