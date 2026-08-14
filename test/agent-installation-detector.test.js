"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  detectAgentInstallation,
  detectAgentInstallations,
} = require("../src/agent-installation-detector");
const { getAgentDescriptor } = require("../src/doctor-detectors/agent-descriptors");
const { registerReasonixHooks } = require("../hooks/reasonix-install");
const {
  BRIDGE_PACKAGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  MANAGED_OWNER,
  resolveManagedRoot,
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSION,
  __test: dshInstallTest,
} = require("../hooks/dsh-install");

const DSH_BRIDGE_SOURCE_DIR = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");

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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

  it("detects DSH host installation separately from a verified managed plugin", () => {
    const homeDir = makeHome();
    const dshHome = path.join(homeDir, ".dsh");
    const profileDir = path.join(dshHome, "profiles", "web");
    const profileManifestPath = path.join(profileDir, "package.json");
    writeJson(profileManifestPath, {
      name: "dsh-profile-web",
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    });

    let report = detectAgentInstallations({ homeDir, now: 1, env: {} });
    let dsh = byId(report, "deepseek-harness");
    assert.strictEqual(dsh.detectedInstalled, true);
    assert.strictEqual(dsh.clawdIntegration.detected, false);
    assert.strictEqual(dsh.clawdIntegration.reason, "absent");
    assert.strictEqual(dsh.paths.parentDir, dshHome);

    const pluginDir = path.join(profileDir, "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
    const bundleHash = dshInstallTest.hashBridgeDirectorySync(fs, DSH_BRIDGE_SOURCE_DIR);
    const generationDir = path.join(
      resolveManagedRoot({ homeDir, dshHome }),
      "generations",
      bundleHash,
    );
    const manifest = readJson(profileManifestPath);
    manifest.dependencies[BRIDGE_PACKAGE_NAME] = `file:${generationDir}`;
    manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
    writeJson(profileManifestPath, manifest);
    fs.cpSync(DSH_BRIDGE_SOURCE_DIR, pluginDir, { recursive: true });
    fs.cpSync(DSH_BRIDGE_SOURCE_DIR, generationDir, { recursive: true });
    const marker = {
      owner: MANAGED_OWNER,
      schemaVersion: 1,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      bundleHash,
      supportedDshRange: SUPPORTED_DSH_RANGE,
      installedDshVersion: SUPPORTED_DSH_VERSION,
    };
    writeJson(path.join(pluginDir, "clawd-manifest.json"), marker);
    writeJson(path.join(generationDir, "clawd-manifest.json"), marker);

    report = detectAgentInstallations({ homeDir, now: 2, env: {} });
    dsh = byId(report, "deepseek-harness");
    assert.strictEqual(dsh.clawdIntegration.detected, true);
    assert.strictEqual(dsh.clawdIntegration.reason, "managed-plugin");
    assert.strictEqual(dsh.clawdIntegration.paths.pluginDir, pluginDir);
  });

  it("detects a DSH CLI on PATH before the profile home is initialized", () => {
    const homeDir = makeHome();
    const binDir = path.join(homeDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, "dsh.cmd");
    fs.writeFileSync(shim, "@echo off\r\n", "utf8");
    const report = detectAgentInstallations({
      homeDir,
      now: 1,
      platform: "win32",
      env: { PATH: binDir },
    });
    const dsh = byId(report, "deepseek-harness");
    assert.strictEqual(dsh.detectedInstalled, true);
    assert.strictEqual(dsh.reason, "command-path");
    assert.deepStrictEqual(dsh.paths.commandPaths, [shim]);
  });

  it("detects a Windows Reasonix installation from the legacy fallback home", () => {
    const homeDir = makeHome();
    const appData = path.join(homeDir, "AppData", "Roaming");
    const legacySettings = path.join(homeDir, ".reasonix", "settings.json");
    const marker = getAgentDescriptor("reasonix").marker;
    writeJson(legacySettings, {
      hooks: {
        Stop: [{ match: "*", command: `"node" "/app/hooks/${marker}"` }],
      },
    });

    const report = detectAgentInstallations({
      homeDir,
      platform: "win32",
      env: { APPDATA: appData },
      now: 1,
    });
    const reasonix = byId(report, "reasonix");

    assert.strictEqual(reasonix.detectedInstalled, true);
    assert.strictEqual(reasonix.reason, "parent-dir");
    assert.strictEqual(reasonix.detail, `${path.join(homeDir, ".reasonix")} exists`);
    assert.deepStrictEqual(
      reasonix.paths.configTargets.map((target) => target.label),
      ["current", "legacy"]
    );
    assert.strictEqual(reasonix.clawdIntegration.detected, true);
    assert.strictEqual(reasonix.clawdIntegration.paths.configPath, legacySettings);
  });

  it("recognizes installer-produced Windows EncodedCommand Reasonix hooks", () => {
    const homeDir = makeHome();
    const appData = path.join(homeDir, "AppData", "Roaming");
    const settingsPath = path.join(appData, "reasonix", "settings.json");
    const marker = getAgentDescriptor("reasonix").marker;
    mkdirp(path.dirname(settingsPath));

    const installed = registerReasonixHooks({
      silent: true,
      platform: "win32",
      env: { APPDATA: appData },
      userHomeDir: homeDir,
      nodeBin: "D:\\npm\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });
    const raw = fs.readFileSync(settingsPath, "utf8");

    assert.strictEqual(installed.added, 9);
    assert.match(raw, /-EncodedCommand /);
    assert.strictEqual(raw.includes(marker), false, "marker should be hidden inside base64");

    const report = detectAgentInstallations({
      homeDir,
      platform: "win32",
      env: { APPDATA: appData },
      now: 1,
    });
    const reasonix = byId(report, "reasonix");

    assert.strictEqual(reasonix.clawdIntegration.detected, true);
    assert.strictEqual(reasonix.clawdIntegration.paths.configPath, settingsPath);
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

  it("detects supported agents from custom discovery paths", () => {
    const homeDir = makeHome();
    const customConfigDir = path.join(homeDir, "custom-qwen-config");
    mkdirp(customConfigDir);

    const report = detectAgentInstallations({
      homeDir,
      now: 1,
      snapshot: {
        agents: {
          "qwen-code": { customDiscoveryPaths: [customConfigDir] },
        },
      },
    });
    const qwen = byId(report, "qwen-code");

    assert.strictEqual(qwen.detectedInstalled, true);
    assert.strictEqual(qwen.confidence, "medium");
    assert.strictEqual(qwen.reason, "custom-path");
    assert.match(qwen.detail, /custom-qwen-config/);
    assert.match(qwen.detail, /User-provided path/);
  });

  it("reports the shared custom tool discovery slot separately", () => {
    const homeDir = makeHome();
    const customExe = path.join(homeDir, "CustomAI.exe");
    writeText(customExe, "");
    fs.chmodSync(customExe, 0o755);

    const report = detectAgentInstallations({
      homeDir,
      now: 1,
      snapshot: {
        customToolDiscoveryPaths: [customExe, path.join(homeDir, "missing")],
      },
    });

    assert.strictEqual(report.customTools.length, 2);
    assert.strictEqual(report.customTools[0].detectedInstalled, true);
    assert.strictEqual(report.customTools[0].confidence, "high");
    assert.strictEqual(report.customTools[0].reason, "application-recognized");
    assert.strictEqual(report.customTools[0].kind, "file");
    assert.strictEqual(report.customTools[0].application.name, "CustomAI");
    assert.strictEqual(report.customTools[0].application.added, false);
    assert.strictEqual(report.customTools[1].detectedInstalled, false);
  });

  it("reports registered custom executables independently from discovery paths", () => {
    const homeDir = makeHome();
    const executablePath = path.join(homeDir, "NovaAI.exe");
    writeText(executablePath, "");
    const application = {
      id: "custom-nova-ai-0123456789ab",
      executablePath,
    };

    const present = detectAgentInstallations({
      homeDir,
      now: 1,
      snapshot: { customApplications: [application], customToolDiscoveryPaths: [] },
    });
    assert.deepStrictEqual(present.customTools, []);
    assert.strictEqual(present.customAgents.length, 1);
    assert.strictEqual(present.customAgents[0].agentId, application.id);
    assert.strictEqual(present.customAgents[0].detectedInstalled, true);

    fs.rmSync(executablePath);
    const missing = detectAgentInstallations({
      homeDir,
      now: 2,
      snapshot: { customApplications: [application], customToolDiscoveryPaths: [] },
    });
    assert.strictEqual(missing.customAgents[0].detectedInstalled, false);
  });

  it("does not infer built-in agent installs from generic Windows app-name guesses", () => {
    const root = makeHome();
    const localAppData = path.join(root, "LocalAppData");
    const executable = path.join(localAppData, "Programs", "Nova AI", "Nova AI.exe");
    writeText(executable, "");
    const descriptor = {
      agentId: "nova-ai",
      agentName: "Nova AI",
      parentDir: path.join(root, ".nova-ai"),
      configPath: path.join(root, ".nova-ai", "settings.json"),
      marker: "clawd",
    };
    const result = detectAgentInstallation(descriptor, {
      homeDir: root,
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
    });
    assert.strictEqual(result.detectedInstalled, false);
    assert.strictEqual(result.confidence, "low");
    assert.strictEqual(result.reason, "not-found");
  });

  describe("kimi dual-generation detection (#563)", () => {
    it("detects an install when only ~/.kimi-code exists", () => {
      const homeDir = makeHome();
      mkdirp(path.join(homeDir, ".kimi-code"));

      const report = detectAgentInstallations({ homeDir, now: 1, env: {} });
      const kimi = byId(report, "kimi-cli");

      assert.strictEqual(kimi.detectedInstalled, true);
      assert.strictEqual(kimi.confidence, "high");
      assert.strictEqual(kimi.reason, "parent-dir");
      assert.ok(kimi.detail.includes(".kimi-code"), `detail should name .kimi-code: ${kimi.detail}`);
    });

    it("detects an install when only legacy ~/.kimi exists", () => {
      const homeDir = makeHome();
      mkdirp(path.join(homeDir, ".kimi"));

      const report = detectAgentInstallations({ homeDir, now: 1, env: {} });
      const kimi = byId(report, "kimi-cli");

      assert.strictEqual(kimi.detectedInstalled, true);
      assert.strictEqual(kimi.reason, "parent-dir");
    });

    it("reports not installed when neither generation directory exists", () => {
      const homeDir = makeHome();

      const report = detectAgentInstallations({ homeDir, now: 1, env: {} });
      const kimi = byId(report, "kimi-cli");

      assert.strictEqual(kimi.detectedInstalled, false);
    });

    it("finds the Clawd marker in the kimi-code config when legacy has none", () => {
      const homeDir = makeHome();
      mkdirp(path.join(homeDir, ".kimi"));
      writeText(
        path.join(homeDir, ".kimi-code", "config.toml"),
        "[[hooks]]\nevent = \"SessionStart\"\ncommand = '\"node\" \"/app/hooks/kimi-hook.js\"'\nmatcher = \"\"\ntimeout = 30\n"
      );

      const report = detectAgentInstallations({ homeDir, now: 1, env: {} });
      const kimi = byId(report, "kimi-cli");

      assert.strictEqual(kimi.detectedInstalled, true);
      assert.strictEqual(kimi.clawdIntegration.detected, true);
      assert.strictEqual(kimi.clawdIntegration.reason, "marker-found");
      assert.ok(kimi.clawdIntegration.detail.includes(".kimi-code"));
    });
  });

  describe("WorkBuddy dual-generation detection", () => {
    it("prefers current ~/.workbuddy-ai when current and legacy directories both exist", () => {
      const homeDir = makeHome();
      mkdirp(path.join(homeDir, ".workbuddy-ai"));
      mkdirp(path.join(homeDir, ".workbuddy"));

      const report = detectAgentInstallations({ homeDir, now: 1, env: {} });
      const workbuddy = byId(report, "workbuddy");

      assert.strictEqual(workbuddy.detectedInstalled, true);
      assert.strictEqual(workbuddy.confidence, "high");
      assert.ok(workbuddy.detail.includes(".workbuddy-ai"), workbuddy.detail);
    });

    it("falls back to legacy ~/.workbuddy and finds its Clawd marker", () => {
      const homeDir = makeHome();
      writeJson(path.join(homeDir, ".workbuddy", "settings.json"), {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: '"node" "/app/hooks/workbuddy-hook.js"' }] }],
        },
      });

      const report = detectAgentInstallations({ homeDir, now: 1, env: {} });
      const workbuddy = byId(report, "workbuddy");

      assert.strictEqual(workbuddy.detectedInstalled, true);
      assert.ok(workbuddy.detail.includes(".workbuddy"), workbuddy.detail);
      assert.strictEqual(workbuddy.clawdIntegration.detected, true);
      assert.ok(workbuddy.clawdIntegration.detail.includes(".workbuddy"));
    });

    it("ignores a bare legacy toolchain directory without settings.json", () => {
      const homeDir = makeHome();
      mkdirp(path.join(homeDir, ".workbuddy"));

      const report = detectAgentInstallations({ homeDir, now: 1, env: {} });
      const workbuddy = byId(report, "workbuddy");

      assert.strictEqual(workbuddy.detectedInstalled, false);
      assert.strictEqual(workbuddy.clawdIntegration.detected, false);
    });
  });
});
