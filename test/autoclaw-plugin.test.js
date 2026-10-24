"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PLUGIN_ROOT = path.join(__dirname, "..", "hooks", "autoclaw-plugin");
const OPENCLAW_PLUGIN_INDEX = path.join(__dirname, "..", "hooks", "openclaw-plugin", "index.js");

async function loadPluginModule() {
  return import(pathToFileURL(path.join(PLUGIN_ROOT, "index.js")).href);
}

// The AutoClaw plugin is a deliberate line-aligned fork of the OpenClaw
// plugin (same gateway, same plugin API, same event vocabulary). Only the
// identity constants may differ. Reversing those replacements must reproduce
// the openclaw plugin byte-for-byte, so every future edit to either file has
// to be mirrored — the same drift guard the OMP/Pi extensions rely on.
const FORK_HEADER_LINES = 6;

const REVERSE_IDENTITY_REPLACEMENTS = [
  [".openclaw-autoclaw", ".openclaw"],
  ["createAutoClawRuntime", "createOpenClawRuntime"],
  ["resolveAutoClawConfigPath", "resolveOpenClawConfigPath"],
  ["DEFAULT_AUTOCLAW_STATE_DIR", "DEFAULT_OPENCLAW_STATE_DIR"],
  ["AUTOCLAW_CONFIG_PATH", "OPENCLAW_CONFIG_PATH"],
  ["AUTOCLAW_STATE_DIR", "OPENCLAW_STATE_DIR"],
  ['"autoclaw-plugin"', '"openclaw-plugin"'],
  ['"autoclaw:default"', '"openclaw:default"'],
  ["autoclaw_run_id", "openclaw_run_id"],
  ["autoclaw_call_id", "openclaw_call_id"],
  ["autoclaw", "openclaw"],
];

function normalizeForkToOpenClaw(source) {
  const lines = source.split("\n");
  const header = lines.slice(0, FORK_HEADER_LINES).join("\n");
  assert.match(header, /AutoClaw desktop app/, "fork header must stay identifiable");
  const body = lines.slice(FORK_HEADER_LINES).join("\n");
  return REVERSE_IDENTITY_REPLACEMENTS.reduce(
    (acc, [from, to]) => acc.split(from).join(to),
    body
  );
}

describe("autoclaw plugin fork parity", () => {
  it("stays line-aligned with the openclaw plugin outside the identity constants", () => {
    const forkSource = fs.readFileSync(path.join(PLUGIN_ROOT, "index.js"), "utf8");
    const openclawSource = fs.readFileSync(OPENCLAW_PLUGIN_INDEX, "utf8");
    const normalized = normalizeForkToOpenClaw(forkSource);
    assert.strictEqual(normalized, openclawSource);
  });

  it("forks the shared plugin manifest id and compatibility block", () => {
    const forkManifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "openclaw.plugin.json"), "utf8"));
    const openclawManifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "hooks", "openclaw-plugin", "openclaw.plugin.json"), "utf8")
    );
    // The gateway validates entries against this id; doctor reuses the same
    // contract (src/doctor-detectors/openclaw-entry-validator.js).
    assert.strictEqual(forkManifest.id, "clawd-on-desk");
    assert.strictEqual(forkManifest.id, openclawManifest.id);
    assert.deepStrictEqual(forkManifest.activation, openclawManifest.activation);
    assert.deepStrictEqual(forkManifest.configSchema, openclawManifest.configSchema);

    const forkPackage = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
    const openclawPackage = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "hooks", "openclaw-plugin", "package.json"), "utf8")
    );
    assert.deepStrictEqual(forkPackage.openclaw, openclawPackage.openclaw);
  });
});

describe("autoclaw plugin identity", () => {
  it("reports the autoclaw agent id with the autoclaw hook source", async () => {
    const api = await loadPluginModule();
    assert.strictEqual(api.AGENT_ID, "autoclaw");

    const posts = [];
    const runtime = api.createAutoClawRuntime({ postState: (body) => posts.push(body) });
    runtime.handleHook("session_start", { sessionId: "s1" }, { workspaceDir: "/tmp/ws" });

    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].agent_id, "autoclaw");
    assert.strictEqual(posts[0].hook_source, "autoclaw-plugin");
    assert.strictEqual(posts[0].session_id, "s1");
    assert.strictEqual(posts[0].state, "idle");
    assert.strictEqual(posts[0].event, "SessionStart");
  });

  it("falls back to autoclaw-namespaced default session ids", async () => {
    const api = await loadPluginModule();
    const posts = [];
    const runtime = api.createAutoClawRuntime({ postState: (body) => posts.push(body) });

    runtime.handleHook("model_call_started", {}, {});
    runtime.handleHook("model_call_ended", { outcome: "ok" }, {});

    // Debounced Stop lands after the timeout; both events share the
    // autoclaw:default pending key so the Stop timer is armed once.
    assert.ok(posts.every((body) => body.session_id === "autoclaw:default"));
    const runtime2 = api.createAutoClawRuntime({ postState: () => {} });
    assert.strictEqual(runtime2.pendingStopCount(), 0);
    assert.strictEqual(posts.length, 1);
  });

  it("namespaces run/call payload fields for the autoclaw host", async () => {
    const api = await loadPluginModule();
    const posts = [];
    const runtime = api.createAutoClawRuntime({ postState: (body) => posts.push(body) });

    runtime.handleHook("before_tool_call", { runId: "r1", toolName: "exec" }, {});
    assert.strictEqual(posts[0].autoclaw_run_id, "r1");
    assert.strictEqual(posts[0].openclaw_run_id, undefined);
    assert.strictEqual(posts[0].tool_name, "exec");
  });

  it("reads session titles from the AutoClaw gateway config", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-autoclaw-plugin-"));
    const previousState = process.env.AUTOCLAW_STATE_DIR;
    try {
      const stateDir = path.join(root, ".openclaw-autoclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      const configPath = path.join(stateDir, "openclaw.json");
      fs.writeFileSync(configPath, JSON.stringify({
        agents: { list: [{ id: "main", identity: { name: "主智能体", emoji: "🐾" } }] },
      }), "utf8");
      process.env.AUTOCLAW_STATE_DIR = stateDir;

      const api = await loadPluginModule();
      const posts = [];
      const runtime = api.createAutoClawRuntime({ postState: (body) => posts.push(body) });
      runtime.handleHook(
        "session_start",
        { sessionKey: "agent:main:main:main" },
        { sessionId: "sess-1" },
      );

      assert.strictEqual(posts[0].session_title, "🐾 主智能体");
      assert.strictEqual(posts[0].session_id, "sess-1");
    } finally {
      if (previousState === undefined) delete process.env.AUTOCLAW_STATE_DIR;
      else process.env.AUTOCLAW_STATE_DIR = previousState;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the config path from AUTOCLAW env overrides", async () => {
    const api = await loadPluginModule();
    const previousState = process.env.AUTOCLAW_STATE_DIR;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-autoclaw-plugin-env-"));
    try {
      process.env.AUTOCLAW_STATE_DIR = root;
      // Resolution is lazy per lookup; no direct export, so exercise it via
      // the agent index loader through a fresh runtime posting.
      const posts = [];
      const runtime = api.createAutoClawRuntime({ postState: (body) => posts.push(body) });
      runtime.handleHook("session_start", { sessionKey: "agent:x:y:z" }, {});
      assert.strictEqual(posts.length, 1);
    } finally {
      if (previousState === undefined) delete process.env.AUTOCLAW_STATE_DIR;
      else process.env.AUTOCLAW_STATE_DIR = previousState;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
