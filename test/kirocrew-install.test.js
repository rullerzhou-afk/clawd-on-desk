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

  it("maps the five gateway events in PascalCase to pet states", () => {
    assert.deepStrictEqual(kirocrewAgent.eventMap, {
      AgentSpawn: "idle",
      UserPromptSubmit: "thinking",
      PreToolUse: "working",
      PostToolUse: "working",
      Stop: "attention",
    });
    assert.strictEqual(kirocrewAgent.stdinFormat, "PascalCase");
    assert.strictEqual(kirocrewAgent.eventSource, "hook");
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
});

describe("KiroCrew hook bridge", () => {
  // No pet server is running in the test env; the bridge must always exit 0 so
  // it never denies a PreToolUse call (which fails closed on any non-zero exit).
  function runBridge(eventName, stdin) {
    try {
      execFileSync(process.execPath, [BRIDGE], {
        input: stdin,
        env: { ...process.env, KIROCREW_HOOK_EVENT: eventName },
        timeout: 5000,
      });
      return 0;
    } catch (err) {
      return typeof err.status === "number" ? err.status : 1;
    }
  }

  it("exits 0 on a mapped event with no server running", () => {
    assert.strictEqual(runBridge("PreToolUse", JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/tmp/x" })), 0);
  });

  it("exits 0 on an unmapped event", () => {
    assert.strictEqual(runBridge("FileCreated", JSON.stringify({ hook_event_name: "FileCreated" })), 0);
  });

  it("exits 0 on malformed stdin", () => {
    assert.strictEqual(runBridge("Stop", "not json"), 0);
  });
});
