"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  detectAgentInstallations,
} = require("../src/agent-installation-detector");
const { getAgentDescriptor } = require("../src/doctor-detectors/agent-descriptors");

const tempDirs = [];

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-agent-detect-"));
  tempDirs.push(dir);
  return dir;
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeText(filePath, value = "") {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, value, "utf8");
}

function byId(report, agentId) {
  return report.agents.find((entry) => entry.agentId === agentId);
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("agent installation detector", () => {
  it("skips default integrations and returns runtime-only checkedAt metadata", () => {
    const homeDir = makeHome();

    const report = detectAgentInstallations({ homeDir, now: 12345 });

    assert.strictEqual(report.checkedAt, 12345);
    assert.deepStrictEqual(report.skippedAgentIds, ["claude-code", "codex"]);
    assert.ok(!byId(report, "claude-code"));
    assert.ok(!byId(report, "codex"));
    assert.ok(byId(report, "qwen-code"));
  });

  it("detects generic parent-directory agents and reports Clawd marker presence separately", () => {
    const homeDir = makeHome();
    const qwenDir = path.join(homeDir, ".qwen");
    const codewhaleDir = path.join(homeDir, ".codewhale");
    const marker = getAgentDescriptor("qwen-code").marker;
    mkdirp(qwenDir);
    mkdirp(codewhaleDir);
    writeJson(path.join(qwenDir, "settings.json"), {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `"node" "/app/hooks/${marker}" SessionStart` }] }],
      },
    });

    const report = detectAgentInstallations({ homeDir, now: 1, env: {} });
    const qwen = byId(report, "qwen-code");
    const codewhale = byId(report, "codewhale");

    assert.strictEqual(qwen.detectedInstalled, true);
    assert.strictEqual(qwen.confidence, "high");
    assert.strictEqual(qwen.reason, "parent-dir");
    assert.strictEqual(qwen.clawdIntegration.detected, true);
    assert.strictEqual(qwen.clawdIntegration.reason, "marker-found");
    assert.strictEqual(codewhale.detectedInstalled, true);
    assert.strictEqual(codewhale.confidence, "high");
    assert.strictEqual(codewhale.reason, "parent-dir");
  });

  it("does not confuse Antigravity's ~/.gemini/config with Gemini CLI", () => {
    const homeDir = makeHome();
    writeJson(path.join(homeDir, ".gemini", "config", "hooks.json"), {
      clawd: {
        PreInvocation: [{ type: "command", command: "node /app/hooks/antigravity-hook.js PreInvocation" }],
      },
    });
    writeText(path.join(homeDir, ".gemini", ".DS_Store"), "Finder metadata");
    writeText(path.join(homeDir, ".gemini", "session.tmp"), "temporary file");
    writeText(path.join(homeDir, ".gemini", "settings.json.backup"), "backup file");
    writeText(path.join(homeDir, ".gemini", ".config.swp"), "swap file");

    const report = detectAgentInstallations({ homeDir, now: 1, env: {} });
    const gemini = byId(report, "gemini-cli");
    const antigravity = byId(report, "antigravity-cli");

    assert.strictEqual(gemini.detectedInstalled, false);
    assert.strictEqual(gemini.reason, "not-found");
    assert.strictEqual(antigravity.detectedInstalled, true);
    assert.strictEqual(antigravity.confidence, "medium");
    assert.strictEqual(antigravity.reason, "parent-dir");
  });

  it("treats Gemini Clawd-only settings as integration marker, not install proof", () => {
    const homeDir = makeHome();
    const settingsPath = path.join(homeDir, ".gemini", "settings.json");
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [{ hooks: [{ name: "clawd", type: "command", command: "node /app/hooks/gemini-hook.js SessionStart" }] }],
      },
    });

    let report = detectAgentInstallations({ homeDir, now: 1 });
    let gemini = byId(report, "gemini-cli");
    assert.strictEqual(gemini.detectedInstalled, false);
    assert.match(gemini.detail, /only Clawd-managed/);
    assert.strictEqual(gemini.clawdIntegration.detected, true);

    writeJson(settingsPath, {
      selectedAuthType: "oauth-personal",
      hooks: {
        SessionStart: [{ hooks: [{ name: "clawd", type: "command", command: "node /app/hooks/gemini-hook.js SessionStart" }] }],
      },
    });

    report = detectAgentInstallations({ homeDir, now: 2 });
    gemini = byId(report, "gemini-cli");
    assert.strictEqual(gemini.detectedInstalled, true);
    assert.strictEqual(gemini.confidence, "high");
    assert.strictEqual(gemini.reason, "config-file");
  });

  it("re-resolves env-dependent paths at detection time", () => {
    const homeDir = makeHome();
    const copilotHome = path.join(homeDir, "custom-copilot");
    const openclawConfigPath = path.join(homeDir, "custom-openclaw", "openclaw.json");
    const hermesHome = path.join(homeDir, "custom-hermes");
    mkdirp(copilotHome);
    writeJson(openclawConfigPath, { plugins: {} });
    writeText(path.join(hermesHome, "config.yaml"), "plugins: []\n");

    const report = detectAgentInstallations({
      homeDir,
      now: 1,
      env: {
        COPILOT_HOME: copilotHome,
        OPENCLAW_CONFIG_PATH: openclawConfigPath,
        HERMES_HOME: hermesHome,
      },
    });

    const copilot = byId(report, "copilot-cli");
    const openclaw = byId(report, "openclaw");
    const hermes = byId(report, "hermes");

    assert.strictEqual(copilot.detectedInstalled, true);
    assert.strictEqual(copilot.paths.parentDir, copilotHome);
    assert.strictEqual(openclaw.detectedInstalled, true);
    assert.strictEqual(openclaw.paths.configPath, openclawConfigPath);
    assert.strictEqual(openclaw.reason, "config-file");
    assert.strictEqual(hermes.detectedInstalled, true);
    assert.strictEqual(hermes.paths.hermesHome, hermesHome);
    assert.strictEqual(hermes.reason, "config-file");
  });

  it("treats a bare Hermes home directory as low-confidence residue", () => {
    const homeDir = makeHome();
    mkdirp(path.join(homeDir, ".hermes"));

    const report = detectAgentInstallations({ homeDir, now: 1, env: {} });
    const hermes = byId(report, "hermes");

    assert.strictEqual(hermes.detectedInstalled, true);
    assert.strictEqual(hermes.confidence, "low");
    assert.strictEqual(hermes.reason, "parent-dir");
  });

  it("uses only read-style fs operations", () => {
    const homeDir = makeHome();
    mkdirp(path.join(homeDir, ".config", "opencode"));
    const fsReadOnly = new Proxy({
      statSync: fs.statSync,
      readFileSync: fs.readFileSync,
      readdirSync: fs.readdirSync,
    }, {
      get(target, property) {
        if (property in target) return target[property];
        throw new Error(`Unexpected fs write or mutation method: ${String(property)}`);
      },
    });

    const report = detectAgentInstallations({ homeDir, fs: fsReadOnly, now: 1 });

    assert.strictEqual(byId(report, "opencode").detectedInstalled, true);
  });
});
