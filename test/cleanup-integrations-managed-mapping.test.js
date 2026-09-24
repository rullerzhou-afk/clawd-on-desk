"use strict";

// #1026 r1: About-cleanup mapping must mark an agent failed when a cleaner
// returns status "ok" but a structured signal proves an active registration
// remains. Exercised at the REAL cleanupIntegrations() mapping layer.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, afterEach } = require("node:test");

const { cleanupIntegrations } = require("../hooks/cleanup-integrations");
const { registerOpencodePlugin } = require("../hooks/opencode-install");

const tempDirs = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function opencodeAgent(result) {
  return result.agents.find((agent) => agent.agentId === "opencode");
}

describe("#1026 r1 cleanupIntegrations structured-result mapping", () => {
  it("marks opencode failed (and increments summary.failed) when an active modified entry remains", async () => {
    const home = tmp("clawd-cleanup-map-fail-");
    const configDir = path.join(home, ".config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    const copy = path.join(home, "workaround", "opencode-plugin");
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, "index.mjs"), "// modified clawd-like\n");
    fs.mkdirSync(path.join(home, "workaround", "opencode-family-plugin"), { recursive: true });
    fs.writeFileSync(path.join(home, "workaround", "opencode-family-plugin", "core.mjs"), "");
    fs.writeFileSync(
      path.join(configDir, "opencode.json"),
      JSON.stringify({ plugin: [copy.replace(/\\/g, "/")] }, null, 2)
    );

    const result = await cleanupIntegrations({ homeDir: home, silent: true });
    const agent = opencodeAgent(result);
    assert.strictEqual(agent.status, "failed");
    assert.strictEqual(agent.registrationRemoved, false);
    assert.strictEqual(agent.activeEntryRemaining, true);
    assert.ok(result.summary.failed >= 1);
    // The config and the active entry are still intact.
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")).plugin,
      [copy.replace(/\\/g, "/")]
    );
  });

  it("keeps the success case: registration removed leaves no active entry", async () => {
    const home = tmp("clawd-cleanup-map-ok-");
    fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });

    const result = await cleanupIntegrations({ homeDir: home, silent: true });
    const agent = opencodeAgent(result);
    assert.strictEqual(agent.registrationRemoved, true);
    assert.strictEqual(agent.activeEntryRemaining, false);
    assert.notStrictEqual(agent.status, "failed");
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8")).plugin,
      []
    );
  });
});
