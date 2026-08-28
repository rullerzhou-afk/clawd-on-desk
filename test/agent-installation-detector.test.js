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
const { registerZcodeHooks, unregisterZcodeHooks } = require("../hooks/zcode-install");
const { registerQoderHooks, unregisterQoderHooks } = require("../hooks/qoder-install");
const { registerCodeBuddyHooks, unregisterCodeBuddyHooks } = require("../hooks/codebuddy-install");
const { registerOpenClawPlugin, unregisterOpenClawPlugin } = require("../hooks/openclaw-install");
const { registerGeminiHooks, unregisterGeminiHooks } = require("../hooks/gemini-install");
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

function canonicalRealpath(filePath) {
  return fs.realpathSync.native
    ? fs.realpathSync.native(filePath)
    : fs.realpathSync(filePath);
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
  // #895 T11a/T11b: only Claude is skipped. Its parent dir is created by Clawd's
  // own default sync, so ~/.claude proves nothing; ~/.codex is never created by
  // Clawd, so it stays real evidence and Codex must be reported like any other
  // agent. This is one code-level route consistent with #895; the reporter's
  // exact on-disk layout remains unconfirmed.
  it("skips only the agent whose parent dir Clawd creates itself", () => {
    const homeDir = makeHome();

    const report = detectAgentInstallations({ homeDir, now: 12345 });

    assert.strictEqual(report.checkedAt, 12345);
    assert.deepStrictEqual(report.skippedAgentIds, ["claude-code"]);
    assert.ok(!byId(report, "claude-code"));
    assert.ok(byId(report, "qwen-code"));

    // Present in the report, and honestly negative on an empty home.
    const codex = byId(report, "codex");
    assert.ok(codex, "codex must be examined, not skipped");
    assert.strictEqual(codex.detectedInstalled, false);
    assert.strictEqual(codex.confidence, "low");
    assert.strictEqual(codex.reason, "not-found");
  });

  it("reports Codex from its own directory once it exists", () => {
    const homeDir = makeHome();
    mkdirp(path.join(homeDir, ".codex"));

    const codex = byId(detectAgentInstallations({ homeDir, now: 1 }), "codex");

    assert.strictEqual(codex.detectedInstalled, true);
    assert.strictEqual(codex.confidence, "medium");
    assert.strictEqual(codex.reason, "parent-dir");
  });

  // #895 T11c: the whole reason Codex may be detected from its directory is that
  // Clawd never creates it. Claude's installer does, which is why Claude stays
  // skipped. If either half of that asymmetry ever changes, this fails.
  it("keeps the create-vs-skip asymmetry the skip list is derived from", async () => {
    const codexHome = makeHome();
    const codexDir = path.join(codexHome, ".codex");
    require("../hooks/codex-install.js").registerCodexHooks({ silent: true, env: { CODEX_HOME: codexDir } });
    assert.strictEqual(fs.existsSync(codexDir), false, "Codex sync must not create ~/.codex");

    const claudeHome = makeHome();
    const claudeSettings = path.join(claudeHome, ".claude", "settings.json");
    await require("../hooks/install.js").registerHooksAsync({
      silent: true,
      homeDir: claudeHome,
      nodeBin: process.execPath,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });
    assert.strictEqual(fs.existsSync(claudeSettings), true, "Claude's production async sync creates ~/.claude");
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
    assert.strictEqual(dsh.clawdIntegration.paths.pluginDir, canonicalRealpath(pluginDir));
  });

  it("detects a DSH CLI on PATH before the profile home is initialized", {
    skip: process.platform !== "win32",
  }, () => {
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

  it("returns strict false for Gemini only when ~/.gemini is absent", () => {
    const homeDir = makeHome();
    const gemini = byId(detectAgentInstallations({ homeDir, now: 1, env: {} }), "gemini-cli");

    assert.strictEqual(gemini.detectedInstalled, false);
    assert.strictEqual(gemini.confidence, "low");
    assert.strictEqual(gemini.reason, "not-found");
  });

  for (const [label, populate] of [
    ["an empty shared parent", (g) => mkdirp(g)],
    ["Antigravity's config directory", (g) => writeJson(path.join(g, "config", "hooks.json"), { clawd: {} })],
    ["Antigravity's app directory", (g) => writeText(path.join(g, "antigravity", "state.pbtxt"), "")],
    ["Antigravity CLI's directory", (g) => writeJson(path.join(g, "antigravity-cli", "settings.json"), {})],
    ["an unknown file", (g) => writeText(path.join(g, "mystery"), "data")],
    ["a credential file", (g) => writeJson(path.join(g, "oauth_creds.json"), { token: "not-read" })],
    ["an extension directory", (g) => mkdirp(path.join(g, "extensions"))],
    ["settings-only content", (g) => writeJson(path.join(g, "settings.json"), { selectedAuthType: "oauth-personal" })],
    ["foreign hook-only settings", (g) => writeJson(path.join(g, "settings.json"), {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node third-party.js" }] }] },
    })],
  ]) {
    it(`treats Gemini ${label} as insufficient evidence`, () => {
      const homeDir = makeHome();
      populate(path.join(homeDir, ".gemini"));

      const gemini = byId(detectAgentInstallations({ homeDir, now: 1, env: {} }), "gemini-cli");

      assert.strictEqual(gemini.detectedInstalled, null);
      assert.strictEqual(gemini.confidence, "low");
      assert.strictEqual(gemini.reason, "insufficient-evidence");
    });
  }

  it("keeps Antigravity positive while Gemini is insufficient in the shared home", () => {
    const homeDir = makeHome();
    writeJson(path.join(homeDir, ".gemini", "config", "hooks.json"), { clawd: {} });
    writeText(path.join(homeDir, ".gemini", "antigravity", "antigravity_state.pbtxt"), "");
    writeJson(path.join(homeDir, ".gemini", "antigravity-cli", "settings.json"), {});

    const report = detectAgentInstallations({ homeDir, now: 1, env: {} });

    assert.strictEqual(byId(report, "gemini-cli").detectedInstalled, null);
    assert.strictEqual(byId(report, "gemini-cli").reason, "insufficient-evidence");
    assert.strictEqual(byId(report, "antigravity-cli").detectedInstalled, true);
  });

  for (const artifact of ["installation_id", "projects.json"]) {
    it(`detects Gemini from the pinned non-empty ${artifact} artifact`, () => {
      const homeDir = makeHome();
      writeText(path.join(homeDir, ".gemini", artifact), "product-owned");

      const gemini = byId(detectAgentInstallations({ homeDir, now: 1, env: {} }), "gemini-cli");

      assert.strictEqual(gemini.detectedInstalled, true);
      assert.strictEqual(gemini.confidence, "high");
      assert.strictEqual(gemini.reason, "product-artifact");
    });

    for (const shape of ["zero-byte", "directory", "symlink"]) {
      it(`rejects Gemini ${artifact} when it is a ${shape}`, () => {
        const homeDir = makeHome();
        const geminiDir = path.join(homeDir, ".gemini");
        const artifactPath = path.join(geminiDir, artifact);
        if (shape === "zero-byte") writeText(artifactPath, "");
        if (shape === "directory") mkdirp(artifactPath);
        if (shape === "symlink") {
          const targetPath = path.join(homeDir, "outside-artifact");
          writeText(targetPath, "product-owned");
          mkdirp(geminiDir);
          fs.symlinkSync(targetPath, artifactPath);
        }

        const gemini = byId(detectAgentInstallations({ homeDir, now: 1, env: {} }), "gemini-cli");

        assert.strictEqual(gemini.detectedInstalled, null);
        assert.strictEqual(gemini.reason, "insufficient-evidence");
      });
    }
  }

  it("detects Gemini artifacts from lstat metadata without listing the shared parent or reading artifact contents", () => {
    const homeDir = makeHome();
    const artifactPath = path.join(homeDir, ".gemini", "projects.json");
    writeText(artifactPath, "opaque-product-data");
    const readPaths = [];
    const fsImpl = {
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      readFileSync(filePath, ...args) {
        readPaths.push(filePath);
        if (filePath === artifactPath) throw new Error("artifact contents must not be read");
        return fs.readFileSync(filePath, ...args);
      },
      readdirSync() {
        throw new Error("Gemini product detection must not list ~/.gemini");
      },
    };

    const entry = detectAgentInstallation(getAgentDescriptor("gemini-cli"), {
      homeDir,
      now: 1,
      env: {},
      fs: fsImpl,
    });

    assert.strictEqual(entry.detectedInstalled, true);
    assert.strictEqual(entry.reason, "product-artifact");
    assert.strictEqual(readPaths.includes(artifactPath), false);
  });

  it("treats Gemini Clawd-only settings as integration evidence, not product proof", () => {
    const homeDir = makeHome();
    const settingsPath = path.join(homeDir, ".gemini", "settings.json");
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [{ hooks: [{ name: "clawd", type: "command", command: "node /app/hooks/gemini-hook.js SessionStart" }] }],
      },
    });

    const gemini = byId(detectAgentInstallations({ homeDir, now: 1 }), "gemini-cli");

    assert.strictEqual(gemini.detectedInstalled, null);
    assert.strictEqual(gemini.reason, "insufficient-evidence");
    assert.strictEqual(gemini.clawdIntegration.detected, true);
  });

  it("keeps exact Clawd register/unregister residue non-actionable for all five repaired agents", () => {
    const homeDir = makeHome();
    const pluginDir = path.join(homeDir, "managed", "openclaw-plugin");
    const openclawStateDir = path.join(homeDir, ".openclaw");
    const openclawConfigPath = path.join(openclawStateDir, "openclaw.json");
    for (const dirName of [".zcode", ".qoder", ".codebuddy", ".gemini", ".openclaw"]) {
      mkdirp(path.join(homeDir, dirName));
    }
    writeJson(openclawConfigPath, {});

    registerZcodeHooks({ homeDir, silent: true, nodeBin: process.execPath });
    registerQoderHooks({ homeDir, silent: true, nodeBin: process.execPath });
    registerCodeBuddyHooks({
      settingsPath: path.join(homeDir, ".codebuddy", "settings.json"),
      silent: true,
      nodeBin: process.execPath,
      permissionTarget: { mode: "local" },
    });
    registerGeminiHooks({ homeDir, silent: true, nodeBin: process.execPath });
    registerOpenClawPlugin({
      stateDir: openclawStateDir,
      configPath: openclawConfigPath,
      pluginDir,
      silent: true,
      openclawCommandAvailable: false,
    });

    const detect = (now) => detectAgentInstallations({ homeDir, now, env: {} });
    let report = detect(1);
    for (const agentId of ["zcode", "qoder", "codebuddy", "gemini-cli", "openclaw"]) {
      const entry = byId(report, agentId);
      assert.strictEqual(entry.detectedInstalled, null, `${agentId} installed Clawd-only config`);
      assert.strictEqual(entry.reason, "insufficient-evidence", `${agentId} installed reason`);
      assert.strictEqual(entry.clawdIntegration.detected, true, `${agentId} integration marker`);
    }

    unregisterZcodeHooks({ homeDir, silent: true });
    unregisterQoderHooks({ homeDir, silent: true });
    unregisterCodeBuddyHooks({ settingsPath: path.join(homeDir, ".codebuddy", "settings.json"), silent: true });
    unregisterGeminiHooks({ homeDir, silent: true });
    unregisterOpenClawPlugin({
      stateDir: openclawStateDir,
      configPath: openclawConfigPath,
      pluginDir,
      silent: true,
      openclawCommandAvailable: false,
    });

    report = detect(2);
    for (const agentId of ["zcode", "qoder", "codebuddy", "gemini-cli", "openclaw"]) {
      const entry = byId(report, agentId);
      assert.strictEqual(entry.detectedInstalled, null, `${agentId} unregister residue`);
      assert.strictEqual(entry.reason, "insufficient-evidence", `${agentId} residue reason`);
      assert.strictEqual(entry.clawdIntegration.detected, false, `${agentId} removed marker`);
    }
  });

  for (const fixture of [
    ["zcode", ".zcode/cli/config.json", { permissions: { defaultMode: "ask" } }],
    ["qoder", ".qoder/settings.json", { language: "en" }],
    ["codebuddy", ".codebuddy/settings.json", { model: "default" }],
    ["openclaw", ".openclaw/openclaw.json", { gateway: { port: 18789 } }],
  ]) {
    const [agentId, relativeConfigPath, config] = fixture;
    it(`detects source-pinned ${agentId} product config`, () => {
      const homeDir = makeHome();
      writeJson(path.join(homeDir, relativeConfigPath), config);

      const entry = byId(detectAgentInstallations({ homeDir, now: 1, env: {} }), agentId);

      assert.strictEqual(entry.detectedInstalled, true);
      assert.strictEqual(entry.confidence, "high");
      assert.strictEqual(entry.reason, "config-file");
    });
  }

  for (const fixture of [
    ["zcode", ".zcode/cli/config.json", { hooks: { enabled: true, events: { Stop: [{ type: "process", command: "node", args: ["third-party.js"] }] } } }],
    ["qoder", ".qoder/settings.json", { hooks: { Stop: [{ matcher: "*", hooks: [{ name: "clawd", type: "command", command: "node third-party.js" }] }] } }],
    ["codebuddy", ".codebuddy/settings.json", { hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "node third-party.js" }] }] } }],
    ["openclaw", ".openclaw/openclaw.json", { plugins: { load: { paths: ["/third-party/plugin"] }, entries: { third: {} } } }],
  ]) {
    const [agentId, relativeConfigPath, config] = fixture;
    it(`preserves a foreign ${agentId} hook/plugin as positive product evidence`, () => {
      const homeDir = makeHome();
      writeJson(path.join(homeDir, relativeConfigPath), config);

      const entry = byId(detectAgentInstallations({ homeDir, now: 1, env: {} }), agentId);

      assert.strictEqual(entry.detectedInstalled, true);
      assert.strictEqual(entry.confidence, "high");
      assert.strictEqual(entry.reason, "config-file");
    });
  }

  it("returns null for empty, malformed, and symlinked reporter config evidence", () => {
    const fixtures = [
      ["zcode", ".zcode/cli/config.json"],
      ["qoder", ".qoder/settings.json"],
      ["codebuddy", ".codebuddy/settings.json"],
    ];
    for (const [agentId, relativeConfigPath] of fixtures) {
      for (const shape of ["missing", "empty", "malformed", "symlink"]) {
        const homeDir = makeHome();
        const configPath = path.join(homeDir, relativeConfigPath);
        mkdirp(path.dirname(configPath));
        if (shape === "empty") writeText(configPath, "");
        if (shape === "malformed") writeText(configPath, "{");
        if (shape === "symlink") {
          const targetPath = path.join(homeDir, "outside.json");
          writeJson(targetPath, { language: "en" });
          fs.symlinkSync(targetPath, configPath);
        }

        const entry = byId(detectAgentInstallations({ homeDir, now: 1, env: {} }), agentId);
        assert.strictEqual(entry.detectedInstalled, null, `${agentId} ${shape}`);
        assert.strictEqual(entry.reason, "insufficient-evidence", `${agentId} ${shape} reason`);
      }
    }
  });

  it("fails an unreadable reporter config closed to insufficient evidence", () => {
    const homeDir = makeHome();
    const configPath = path.join(homeDir, ".qoder", "settings.json");
    writeJson(configPath, { language: "en" });
    const fsImpl = {
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      readdirSync: fs.readdirSync,
      readFileSync(filePath, ...args) {
        if (filePath === configPath) {
          const err = new Error("permission denied");
          err.code = "EACCES";
          throw err;
        }
        return fs.readFileSync(filePath, ...args);
      },
    };

    const entry = detectAgentInstallation(getAgentDescriptor("qoder"), {
      homeDir,
      now: 1,
      env: {},
      fs: fsImpl,
    });

    assert.strictEqual(entry.detectedInstalled, null);
    assert.strictEqual(entry.reason, "insufficient-evidence");
  });

  it("subtracts migrated ZCode and both exact CodeBuddy permission ownership shapes", () => {
    const zcodeHome = makeHome();
    writeJson(path.join(zcodeHome, ".zcode", "cli", "config.json"), {
      hooks: {
        enabled: true,
        events: {
          Stop: [{ type: "process", command: process.execPath, args: ["/app/hooks/clawd-hook.js", "Stop"] }],
        },
      },
    });
    const zcodeEntry = byId(detectAgentInstallations({ homeDir: zcodeHome, now: 1, env: {} }), "zcode");
    assert.strictEqual(zcodeEntry.detectedInstalled, null);

    for (const permissionHook of [
      { name: "clawd-on-desk.permission.v1", type: "http", url: "https://preserved.example/permission" },
      { name: "custom-name", type: "http", url: "http://127.0.0.1:23333/permission" },
    ]) {
      const codebuddyHome = makeHome();
      writeJson(path.join(codebuddyHome, ".codebuddy", "settings.json"), {
        hooks: { PermissionRequest: [{ hooks: [permissionHook] }] },
      });
      const entry = byId(detectAgentInstallations({ homeDir: codebuddyHome, now: 1, env: {} }), "codebuddy");
      assert.strictEqual(entry.detectedInstalled, null, JSON.stringify(permissionHook));
      assert.strictEqual(entry.reason, "insufficient-evidence");
    }
  });

  it("keeps mixed Clawd and foreign content positive for each ownership adapter", () => {
    const fixtures = [
      ["zcode", ".zcode/cli/config.json", {
        hooks: { enabled: true, events: { Stop: [
          { type: "process", command: process.execPath, args: ["/app/hooks/zcode-hook.js", "Stop"] },
          { type: "process", command: "node", args: ["third-party.js"] },
        ] } },
      }],
      ["qoder", ".qoder/settings.json", {
        hooks: { Stop: [{ hooks: [
          { type: "command", command: "node /app/hooks/qoder-hook.js Stop" },
          { type: "command", command: "node third-party.js" },
        ] }] },
      }],
      ["codebuddy", ".codebuddy/settings.json", {
        hooks: { PermissionRequest: [{ hooks: [
          { name: "clawd-on-desk.permission.v1", type: "http", url: "http://127.0.0.1:23333/permission" },
          { name: "third", type: "http", url: "https://third.example/permission" },
        ] }] },
      }],
      ["openclaw", ".openclaw/openclaw.json", {
        plugins: {
          load: { paths: ["/app/hooks/openclaw-plugin", "/third-party/plugin"] },
          entries: { "clawd-on-desk": { enabled: true }, third: { enabled: true } },
        },
      }],
    ];
    for (const [agentId, relativeConfigPath, config] of fixtures) {
      const homeDir = makeHome();
      writeJson(path.join(homeDir, relativeConfigPath), config);
      const entry = byId(detectAgentInstallations({ homeDir, now: 1, env: {} }), agentId);
      assert.strictEqual(entry.detectedInstalled, true, agentId);
      assert.strictEqual(entry.reason, "config-file", agentId);
    }
  });

  it("subtracts an owned hook leaf without hiding a foreign nested sibling", () => {
    const homeDir = makeHome();
    writeJson(path.join(homeDir, ".qoder", "settings.json"), {
      hooks: {
        Stop: [{
          type: "command",
          command: "node /app/hooks/qoder-hook.js Stop",
          hooks: [{ type: "command", command: "node third-party.js" }],
        }],
      },
    });

    const entry = byId(detectAgentInstallations({ homeDir, now: 1, env: {} }), "qoder");
    assert.strictEqual(entry.detectedInstalled, true);
    assert.strictEqual(entry.reason, "config-file");
  });

  it("keeps mixed Clawd and foreign Gemini hooks insufficient", () => {
    const homeDir = makeHome();
    writeJson(path.join(homeDir, ".gemini", "settings.json"), {
      hooks: {
        Stop: [{ hooks: [
          { type: "command", command: "node /app/hooks/gemini-hook.js Stop" },
          { type: "command", command: "node third-party.js" },
        ] }],
      },
    });

    const entry = byId(detectAgentInstallations({ homeDir, now: 1, env: {} }), "gemini-cli");
    assert.strictEqual(entry.detectedInstalled, null);
    assert.strictEqual(entry.reason, "insufficient-evidence");
    assert.strictEqual(entry.clawdIntegration.detected, true);
  });

  it("fails legal JSON5, malformed text, and config symlinks closed to insufficient OpenClaw evidence", () => {
    const json5Home = makeHome();
    writeText(path.join(json5Home, ".openclaw", "openclaw.json"), "{ gateway: { port: 18789 } }");
    const json5 = byId(detectAgentInstallations({ homeDir: json5Home, now: 1, env: {} }), "openclaw");
    assert.strictEqual(json5.detectedInstalled, null);
    assert.strictEqual(json5.confidence, "low");
    assert.strictEqual(json5.reason, "insufficient-evidence");

    const clawdJson5Home = makeHome();
    writeText(
      path.join(clawdJson5Home, ".openclaw", "openclaw.json"),
      '{ plugins: { load: { paths: ["/app/hooks/openclaw-plugin"] }, entries: { "clawd-on-desk": { enabled: true } } } }'
    );
    const clawdJson5 = byId(
      detectAgentInstallations({ homeDir: clawdJson5Home, now: 1, env: {} }),
      "openclaw"
    );
    assert.strictEqual(clawdJson5.detectedInstalled, null);
    assert.strictEqual(clawdJson5.reason, "insufficient-evidence");

    const malformedHome = makeHome();
    writeText(path.join(malformedHome, ".openclaw", "openclaw.json"), "{ definitely broken");
    const malformed = byId(detectAgentInstallations({ homeDir: malformedHome, now: 1, env: {} }), "openclaw");
    assert.strictEqual(malformed.detectedInstalled, null);
    assert.strictEqual(malformed.reason, "insufficient-evidence");

    const symlinkHome = makeHome();
    const configPath = path.join(symlinkHome, ".openclaw", "openclaw.json");
    const targetPath = path.join(symlinkHome, "outside.json5");
    writeText(targetPath, "{ gateway: { port: 18789 } }");
    mkdirp(path.dirname(configPath));
    fs.symlinkSync(targetPath, configPath);
    const symlink = byId(detectAgentInstallations({ homeDir: symlinkHome, now: 1, env: {} }), "openclaw");
    assert.strictEqual(symlink.detectedInstalled, null);
    assert.strictEqual(symlink.reason, "insufficient-evidence");
  });

  it("does not fall back to the default OpenClaw config when OPENCLAW_CONFIG_PATH is set", () => {
    const homeDir = makeHome();
    const stateDir = path.join(homeDir, ".openclaw");
    const explicitConfigPath = path.join(homeDir, "external", "openclaw.json");
    writeJson(path.join(stateDir, "openclaw.json"), { gateway: { port: 18789 } });

    const entry = byId(detectAgentInstallations({
      homeDir,
      now: 1,
      env: { OPENCLAW_CONFIG_PATH: explicitConfigPath },
    }), "openclaw");

    assert.strictEqual(entry.paths.configPath, explicitConfigPath);
    assert.strictEqual(entry.detectedInstalled, null);
    assert.strictEqual(entry.reason, "insufficient-evidence");
  });

  it("re-resolves env-dependent paths at detection time", () => {
    const homeDir = makeHome();
    const copilotHome = path.join(homeDir, "custom-copilot");
    const openclawConfigPath = path.join(homeDir, "custom-openclaw", "openclaw.json");
    const hermesHome = path.join(homeDir, "custom-hermes");
    mkdirp(copilotHome);
    writeJson(openclawConfigPath, { gateway: { port: 18789 } });
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
      lstatSync: fs.lstatSync,
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
