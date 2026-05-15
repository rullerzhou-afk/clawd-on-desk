const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  checkAgentIntegrations,
  findOpenClawPluginEntry,
  findOpencodePluginEntry,
} = require("../src/doctor-detectors/agent-integrations");
const { GEMINI_HOOK_EVENTS } = require("../hooks/gemini-install");

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-doctor-agent-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function baseDescriptor(overrides = {}) {
  const root = makeTempDir();
  const parentDir = path.join(root, ".agent");
  return {
    agentId: "test-agent",
    agentName: "Test Agent",
    eventSource: "hook",
    parentDir,
    configPath: path.join(parentDir, "settings.json"),
    configMode: "file",
    autoInstall: true,
    marker: "test-hook.js",
    nested: false,
    ...overrides,
  };
}

function runOne(descriptor, options = {}) {
  return checkAgentIntegrations({
    fs,
    prefs: options.prefs || {},
    descriptors: [descriptor],
    validateCommand: options.validateCommand || (() => ({
      ok: true,
      nodeBin: "/node",
      scriptPath: "/app/hooks/test-hook.js",
    })),
  }).details[0];
}

function geminiHooksConfig(commandForEvent = (event) => `"/node" "/app/hooks/gemini-hook.js" ${event}`) {
  const hooks = {};
  for (const event of GEMINI_HOOK_EVENTS) {
    hooks[event] = [{
      matcher: "*",
      hooks: [{ name: "clawd", type: "command", command: commandForEvent(event) }],
    }];
  }
  return hooks;
}

function codexDescriptor() {
  const root = makeTempDir();
  const parentDir = path.join(root, ".codex");
  return baseDescriptor({
    agentId: "codex",
    marker: "codex-hook.js",
    parentDir,
    configPath: path.join(parentDir, "hooks.json"),
    nested: true,
    supplementary: {
      key: "hooks",
      configPath: path.join(parentDir, "config.toml"),
    },
  });
}

function codexHooksConfig(events) {
  const hooks = {};
  for (const event of events) {
    hooks[event] = [{ hooks: [{ command: `"/node" "/app/hooks/codex-hook.js" ${event}` }] }];
  }
  return { hooks };
}

function codexTrustState(descriptor, events) {
  return [
    "[features]",
    "hooks = true",
    "",
    ...events.flatMap((event) => [
      `[hooks.state.'${descriptor.configPath}:${event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}:0:0']`,
      `trusted_hash = "sha256:${"a".repeat(64)}"`,
      "",
    ]),
  ].join("\n");
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("checkAgentIntegrations", () => {
  it("returns not-installed when parent dir is missing", () => {
    const detail = runOne(baseDescriptor());
    assert.strictEqual(detail.status, "not-installed");
    assert.strictEqual(detail.level, "info");
    assert.strictEqual(detail.parentDirExists, false);
  });

  it("keeps enabled Hermes missing install info-only when another integration is ok", () => {
    const okDescriptor = baseDescriptor({
      agentId: "ok-agent",
      marker: "ok-hook.js",
    });
    writeJson(okDescriptor.configPath, {
      hooks: {
        Stop: [{ command: '"/node" "/app/hooks/ok-hook.js" Stop' }],
      },
    });
    const hermesDescriptor = baseDescriptor({
      agentId: "hermes",
      marker: "clawd-on-desk",
      configMode: "plugin-dir",
    });

    const result = checkAgentIntegrations({
      fs,
      prefs: { agents: { hermes: { enabled: true } } },
      descriptors: [okDescriptor, hermesDescriptor],
      validateCommand: () => ({
        ok: true,
        nodeBin: "/node",
        scriptPath: "/app/hooks/ok-hook.js",
      }),
    });

    const hermes = result.details.find((detail) => detail.agentId === "hermes");
    assert.strictEqual(result.status, "pass");
    assert.strictEqual(hermes.status, "not-installed");
    assert.strictEqual(hermes.level, "info");
  });

  it("returns not-connected when config is missing for an auto-installed agent", () => {
    const descriptor = baseDescriptor();
    fs.mkdirSync(descriptor.parentDir, { recursive: true });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.configFileExists, false);
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "test-agent" });
  });

  it("returns config-corrupt when JSON parsing fails", () => {
    const descriptor = baseDescriptor();
    fs.mkdirSync(descriptor.parentDir, { recursive: true });
    fs.writeFileSync(descriptor.configPath, "{ nope", "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "config-corrupt");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("validates flat hook commands and marks ok", () => {
    const descriptor = baseDescriptor();
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [{ command: '"/node" "/app/hooks/test-hook.js"' }],
      },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, 1);
  });

  it("validates nested hook commands when descriptor requests nested mode", () => {
    const descriptor = baseDescriptor({ nested: true });
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [{
          hooks: [{ command: '"/node" "/app/hooks/test-hook.js"' }],
        }],
      },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
  });

  it("validates Gemini nested hook commands for every required event", () => {
    const descriptor = baseDescriptor({
      agentId: "gemini-cli",
      marker: "gemini-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, {
      hooks: geminiHooksConfig(),
    });

    const seen = [];
    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        seen.push(command);
        return {
          ok: true,
          nodeBin: "/node",
          scriptPath: "/app/hooks/gemini-hook.js",
        };
      },
    });

    assert.strictEqual(seen.length, GEMINI_HOOK_EVENTS.length);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, GEMINI_HOOK_EVENTS.length);
    assert.deepStrictEqual(detail.supplementary, {
      key: "gemini_hooks",
      value: "enabled",
      detail: "hooksConfig allows Clawd Gemini hooks",
    });
  });

  it("warns when Gemini is missing any required hook event", () => {
    const descriptor = baseDescriptor({
      agentId: "gemini-cli",
      marker: "gemini-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, {
      hooks: {
        BeforeTool: [{
          matcher: "*",
          hooks: [{ name: "clawd", type: "command", command: '"/node" "/app/hooks/gemini-hook.js" BeforeTool' }],
        }],
      },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.ok(detail.missingGeminiHookEvents.includes("SessionStart"));
    assert.ok(detail.missingGeminiHookEvents.includes("AfterTool"));
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "gemini-cli" });
  });

  it("turns Gemini ok into warning when hooksConfig.enabled=false", () => {
    const descriptor = baseDescriptor({
      agentId: "gemini-cli",
      marker: "gemini-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, {
      hooks: geminiHooksConfig(),
      hooksConfig: {
        enabled: false,
      },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.detail, "Gemini hooks are disabled in settings.json; Clawd preserves this user setting and will not receive hook events");
    assert.deepStrictEqual(detail.supplementary, {
      key: "gemini_hooks",
      value: "disabled-global",
      detail: "hooksConfig.enabled is false",
    });
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("reports disabled Gemini hooks even when command coverage is incomplete", () => {
    const descriptor = baseDescriptor({
      agentId: "gemini-cli",
      marker: "gemini-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, {
      hooks: {
        BeforeTool: [{
          matcher: "*",
          hooks: [{ name: "clawd", type: "command", command: '"/node" "/app/hooks/gemini-hook.js" BeforeTool' }],
        }],
      },
      hooksConfig: {
        enabled: false,
      },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.detail, "Gemini hooks are disabled in settings.json; Clawd preserves this user setting and will not receive hook events");
    assert.deepStrictEqual(detail.supplementary, {
      key: "gemini_hooks",
      value: "disabled-global",
      detail: "hooksConfig.enabled is false",
    });
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("turns Gemini ok into warning when hooksConfig.disabled includes clawd", () => {
    const descriptor = baseDescriptor({
      agentId: "gemini-cli",
      marker: "gemini-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, {
      hooks: geminiHooksConfig(),
      hooksConfig: {
        disabled: ["clawd"],
      },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.deepStrictEqual(detail.supplementary, {
      key: "gemini_hooks",
      value: "disabled-clawd",
      detail: 'hooksConfig.disabled includes "clawd"',
    });
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("does not treat legacy disabled Gemini hook command strings as a stable disabled signal", () => {
    const descriptor = baseDescriptor({
      agentId: "gemini-cli",
      marker: "gemini-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, {
      hooks: geminiHooksConfig(),
      hooksConfig: {
        disabled: ['"/node" "/app/hooks/gemini-hook.js" BeforeTool'],
      },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.level, null);
    assert.deepStrictEqual(detail.supplementary, {
      key: "gemini_hooks",
      value: "enabled",
      detail: "hooksConfig allows Clawd Gemini hooks",
    });
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("returns broken-path when all matching commands fail validation", () => {
    const descriptor = baseDescriptor();
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [{ command: '"/node" "/missing/test-hook.js"' }],
      },
    });

    const detail = runOne(descriptor, {
      validateCommand: () => ({
        ok: false,
        issue: "scriptPath-missing",
        nodeBin: "/node",
        scriptPath: "/missing/test-hook.js",
      }),
    });
    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.hookCommandIssue, "scriptPath-missing");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "test-agent" });
  });

  it("extracts Kimi TOML commands and validates scriptPath", () => {
    const root = makeTempDir();
    const parentDir = path.join(root, ".kimi");
    const descriptor = baseDescriptor({
      agentId: "kimi-cli",
      marker: "kimi-hook.js",
      configMode: "toml-text",
      parentDir,
      configPath: path.join(parentDir, "config.toml"),
    });
    fs.mkdirSync(descriptor.parentDir, { recursive: true });
    fs.writeFileSync(
      descriptor.configPath,
      '[[hooks]]\nevent = "Stop"\ncommand = \'"node" "/missing/kimi-hook.js"\'\n',
      "utf8"
    );

    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        assert.strictEqual(command, '"node" "/missing/kimi-hook.js"');
        return {
          ok: false,
          issue: "scriptPath-missing",
          nodeBin: "node",
          scriptPath: "/missing/kimi-hook.js",
        };
      },
    });
    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.hookCommandIssue, "scriptPath-missing");
  });

  it("turns Codex ok into warning when hooks=false", () => {
    const descriptor = codexDescriptor();
    writeJson(descriptor.configPath, codexHooksConfig(["Stop"]));
    fs.writeFileSync(descriptor.supplementary.configPath, "[features]\nhooks = false\n", "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.supplementary.value, "disabled");
    assert.deepStrictEqual(detail.fixAction, {
      type: "agent-integration",
      agentId: "codex",
      forceCodexHooksFeature: true,
    });
  });

  it("turns Codex ok into warning when hooks need Codex review", () => {
    const descriptor = codexDescriptor();
    writeJson(descriptor.configPath, codexHooksConfig(["PermissionRequest", "Stop"]));
    fs.writeFileSync(descriptor.supplementary.configPath, "[features]\nhooks = true\n", "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "needs-review");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.fixAction, undefined);
    assert.deepStrictEqual(detail.supplementary, {
      key: "hooks",
      value: "enabled",
      detail: "hooks=true",
    });
    assert.strictEqual(detail.codexHookTrust.value, "needs-review");
    assert.strictEqual(detail.codexHookTrust.totalCount, 2);
    assert.deepStrictEqual(detail.codexHookTrust.missingEvents, ["PermissionRequest", "Stop"]);
    assert.match(detail.codexHookTrust.detail, /Codex \/hooks review/);
  });

  it("keeps Codex ok when Codex hook trust state exists", () => {
    const descriptor = codexDescriptor();
    const events = ["PermissionRequest", "Stop"];
    writeJson(descriptor.configPath, codexHooksConfig(events));
    fs.writeFileSync(descriptor.supplementary.configPath, codexTrustState(descriptor, events), "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.level, null);
    assert.strictEqual(detail.fixAction, undefined);
    assert.strictEqual(detail.codexHookTrust.value, "trusted");
    assert.strictEqual(detail.codexHookTrust.trustedCount, 2);
  });

  it("scans Kiro agent configs and reports fully-valid files", () => {
    const root = makeTempDir();
    const agentsDir = path.join(root, ".kiro", "agents");
    const descriptor = baseDescriptor({
      agentId: "kiro-cli",
      marker: "kiro-hook.js",
      parentDir: path.join(root, ".kiro"),
      configPath: agentsDir,
      configMode: "dir",
      nested: true,
    });
    writeJson(path.join(agentsDir, "clawd.json"), {
      hooks: {
        stop: [{ hooks: [{ command: '"/node" "/app/hooks/kiro-hook.js"' }] }],
      },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
    assert.deepStrictEqual(detail.kiroScan.fullyValidFiles, ["clawd.json"]);
  });

  it("does not offer automatic repair when Kiro agent configs are corrupt", () => {
    const root = makeTempDir();
    const agentsDir = path.join(root, ".kiro", "agents");
    const descriptor = baseDescriptor({
      agentId: "kiro-cli",
      marker: "kiro-hook.js",
      parentDir: path.join(root, ".kiro"),
      configPath: agentsDir,
      configMode: "dir",
      nested: true,
    });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "broken.json"), "{ nope", "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "config-corrupt");
    assert.strictEqual(detail.fixAction, undefined);
  });

  function piDescriptor() {
    const root = makeTempDir();
    const parentDir = path.join(root, ".pi", "agent");
    return baseDescriptor({
      agentId: "pi",
      agentName: "Pi",
      eventSource: "extension",
      parentDir,
      configPath: path.join(parentDir, "extensions", "clawd-on-desk"),
      configMode: "pi-extension",
      marker: "index.ts",
      coreFile: "pi-extension-core.js",
      markerFile: ".clawd-managed.json",
    });
  }

  it("reports missing Pi extension as repairable not-connected", () => {
    const descriptor = piDescriptor();
    fs.mkdirSync(descriptor.parentDir, { recursive: true });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.eventSource, "extension");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "pi" });
  });

  it("reports unmanaged Pi extension directory as needs-review without repair action", () => {
    const descriptor = piDescriptor();
    fs.mkdirSync(descriptor.configPath, { recursive: true });
    fs.writeFileSync(path.join(descriptor.configPath, "index.ts"), "export default function() {}\n", "utf8");

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "needs-review");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("reports managed Pi extension as ok", () => {
    const descriptor = piDescriptor();
    writeJson(path.join(descriptor.configPath, ".clawd-managed.json"), {
      app: "clawd-on-desk",
      integration: "pi",
      managed: true,
    });
    fs.writeFileSync(path.join(descriptor.configPath, "index.ts"), "export default function() {}\n", "utf8");
    fs.writeFileSync(path.join(descriptor.configPath, "pi-extension-core.js"), "module.exports = {}\n", "utf8");

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.extensionFileExists, true);
    assert.strictEqual(detail.coreFileExists, true);
  });

  it("reports managed Pi extension with missing copied files as repairable broken-path", () => {
    const descriptor = piDescriptor();
    writeJson(path.join(descriptor.configPath, ".clawd-managed.json"), {
      app: "clawd-on-desk",
      integration: "pi",
      managed: true,
    });
    fs.writeFileSync(path.join(descriptor.configPath, "index.ts"), "export default function() {}\n", "utf8");

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.coreFileExists, false);
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "pi" });
  });

  it("reports opencode stale absolute plugin paths", () => {
    const root = makeTempDir();
    const parentDir = path.join(root, ".config", "opencode");
    const pluginPath = path.join(root, "missing", "opencode-plugin");
    const descriptor = baseDescriptor({
      agentId: "opencode",
      marker: "opencode-plugin",
      parentDir,
      configPath: path.join(parentDir, "opencode.json"),
      detection: "opencode-plugin",
    });
    writeJson(descriptor.configPath, { plugin: [pluginPath] });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.opencodeEntryIssue, "directory-missing");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "opencode" });
  });

  function openClawDescriptor() {
    const root = makeTempDir();
    const parentDir = path.join(root, ".openclaw");
    return baseDescriptor({
      agentId: "openclaw",
      agentName: "OpenClaw",
      eventSource: "plugin-event",
      parentDir,
      configPath: path.join(parentDir, "openclaw.json"),
      configMode: "openclaw-plugin",
      marker: "openclaw-plugin",
      pluginId: "clawd-on-desk",
    });
  }

  function makeOpenClawPluginDir(root) {
    const pluginDir = path.join(root, "hooks", "openclaw-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default { id: 'clawd-on-desk', register() {} };\n", "utf8");
    writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
      id: "clawd-on-desk",
      name: "Clawd on Desk",
      description: "test",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    });
    return pluginDir;
  }

  it("reports missing OpenClaw plugin config as repairable not-connected", () => {
    const descriptor = openClawDescriptor();
    fs.mkdirSync(descriptor.parentDir, { recursive: true });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.eventSource, "plugin-event");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "openclaw" });
  });

  it("reports OpenClaw JSON5 configs as needs-review instead of corrupting them", () => {
    const descriptor = openClawDescriptor();
    fs.mkdirSync(descriptor.parentDir, { recursive: true });
    fs.writeFileSync(descriptor.configPath, "{ // json5\n plugins: {} }\n", "utf8");

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "needs-review");
    assert.match(detail.detail, /not strict JSON/);
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("reports valid OpenClaw plugin paths as ok", () => {
    const descriptor = openClawDescriptor();
    const pluginDir = makeOpenClawPluginDir(path.dirname(descriptor.parentDir));
    writeJson(descriptor.configPath, {
      plugins: {
        load: { paths: [pluginDir] },
        entries: {
          "clawd-on-desk": {
            enabled: true,
            hooks: { allowConversationAccess: false },
          },
        },
      },
    });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.openclawEntry, pluginDir);
  });

  it("reports OpenClaw stale plugin paths as repairable broken-path", () => {
    const descriptor = openClawDescriptor();
    const pluginDir = path.join(path.dirname(descriptor.parentDir), "missing", "openclaw-plugin");
    writeJson(descriptor.configPath, {
      plugins: {
        load: { paths: [pluginDir] },
        entries: { "clawd-on-desk": { enabled: true } },
      },
    });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.openclawEntryIssue, "directory-missing");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "openclaw" });
  });

  it("checks Hermes plugin directory files and enabled marker", () => {
    const root = makeTempDir();
    const parentDir = path.join(root, ".hermes");
    const pluginDir = path.join(parentDir, "plugins", "clawd-on-desk");
    const descriptor = baseDescriptor({
      agentId: "hermes",
      marker: "clawd-on-desk",
      parentDir,
      configPath: pluginDir,
      configMode: "plugin-dir",
      managedFiles: ["plugin.yaml", "__init__.py"],
      configFilePath: path.join(parentDir, "config.yaml"),
    });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.yaml"), "name: clawd-on-desk\n", "utf8");
    fs.writeFileSync(path.join(pluginDir, "__init__.py"), "# plugin\n", "utf8");
    fs.writeFileSync(descriptor.configFilePath, "plugins:\n  enabled:\n    - clawd-on-desk\n", "utf8");

    const detail = runOne(descriptor, {
      prefs: { agents: { hermes: { enabled: true } } },
    });

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.pluginEnabled, true);
  });

  it("reports Hermes plugin directory missing managed files as repairable", () => {
    const root = makeTempDir();
    const parentDir = path.join(root, ".hermes");
    const pluginDir = path.join(parentDir, "plugins", "clawd-on-desk");
    const descriptor = baseDescriptor({
      agentId: "hermes",
      marker: "clawd-on-desk",
      parentDir,
      configPath: pluginDir,
      configMode: "plugin-dir",
      managedFiles: ["plugin.yaml", "__init__.py"],
      configFilePath: path.join(parentDir, "config.yaml"),
    });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.yaml"), "name: clawd-on-desk\n", "utf8");

    const detail = runOne(descriptor, {
      prefs: { agents: { hermes: { enabled: true } } },
    });

    assert.strictEqual(detail.status, "not-connected");
    assert.deepStrictEqual(detail.missingPluginFiles, ["__init__.py"]);
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "hermes" });
  });

  it("does not report Hermes ok when clawd-on-desk appears only in disabled plugins", () => {
    const root = makeTempDir();
    const parentDir = path.join(root, ".hermes");
    const pluginDir = path.join(parentDir, "plugins", "clawd-on-desk");
    const descriptor = baseDescriptor({
      agentId: "hermes",
      marker: "clawd-on-desk",
      parentDir,
      configPath: pluginDir,
      configMode: "plugin-dir",
      managedFiles: ["plugin.yaml", "__init__.py"],
      configFilePath: path.join(parentDir, "config.yaml"),
    });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.yaml"), "name: clawd-on-desk\n", "utf8");
    fs.writeFileSync(path.join(pluginDir, "__init__.py"), "# plugin\n", "utf8");
    fs.writeFileSync(
      descriptor.configFilePath,
      "plugins:\n  enabled: []\n  disabled:\n    - clawd-on-desk\n",
      "utf8"
    );

    const detail = runOne(descriptor, {
      prefs: { agents: { hermes: { enabled: true } } },
    });

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.pluginEnabled, false);
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "hermes" });
  });

  it("accepts Hermes inline enabled plugin lists", () => {
    const root = makeTempDir();
    const parentDir = path.join(root, ".hermes");
    const pluginDir = path.join(parentDir, "plugins", "clawd-on-desk");
    const descriptor = baseDescriptor({
      agentId: "hermes",
      marker: "clawd-on-desk",
      parentDir,
      configPath: pluginDir,
      configMode: "plugin-dir",
      managedFiles: ["plugin.yaml", "__init__.py"],
      configFilePath: path.join(parentDir, "config.yaml"),
    });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.yaml"), "name: clawd-on-desk\n", "utf8");
    fs.writeFileSync(path.join(pluginDir, "__init__.py"), "# plugin\n", "utf8");
    fs.writeFileSync(
      descriptor.configFilePath,
      "plugins:\n  enabled: [\"clawd-on-desk\"]\n  disabled: []\n",
      "utf8"
    );

    const detail = runOne(descriptor, {
      prefs: { agents: { hermes: { enabled: true } } },
    });

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.pluginEnabled, true);
  });

  it("keeps Hermes disabled as info-only by default", () => {
    const descriptor = baseDescriptor({
      agentId: "hermes",
      marker: "clawd-on-desk",
      configMode: "plugin-dir",
    });

    const detail = runOne(descriptor, {
      prefs: { agents: { hermes: { enabled: false } } },
    });

    assert.strictEqual(detail.status, "disabled");
    assert.strictEqual(detail.level, "info");
  });

  it("adds a non-failing note when per-agent permission bubbles are disabled", () => {
    const descriptor = baseDescriptor({ agentId: "codex", marker: "codex-hook.js" });
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [{ command: '"/node" "/app/hooks/codex-hook.js"' }],
      },
    });

    const detail = runOne(descriptor, {
      prefs: { agents: { codex: { enabled: true, permissionsEnabled: false } } },
    });
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.permissionsEnabled, false);
    assert.strictEqual(detail.permissionBubbleDetail, "permission bubbles disabled for this agent");
  });

  it("aggregates all-info states as critical when no integration is ok", () => {
    const result = checkAgentIntegrations({
      fs,
      descriptors: [
        baseDescriptor({ agentId: "copilot-cli", configMode: "none-global" }),
        baseDescriptor({ agentId: "missing-agent" }),
      ],
    });
    assert.strictEqual(result.status, "critical");
    assert.strictEqual(result.level, "critical");
  });

  it("keeps the integration summary in warning when Gemini hooks are disabled", () => {
    const descriptor = baseDescriptor({
      agentId: "gemini-cli",
      marker: "gemini-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, {
      hooks: geminiHooksConfig(),
      hooksConfig: {
        enabled: false,
      },
    });

    const result = checkAgentIntegrations({
      fs,
      descriptors: [descriptor],
      validateCommand: () => ({
        ok: true,
        nodeBin: "/node",
        scriptPath: "/app/hooks/gemini-hook.js",
      }),
    });
    assert.strictEqual(result.status, "warning");
    assert.strictEqual(result.level, "warning");
    assert.strictEqual(result.warningCount, 1);
    assert.strictEqual(result.okCount, 0);
  });
});

describe("findOpencodePluginEntry", () => {
  it("matches only absolute plugin entries by basename", () => {
    const absEntry = "C:\\clawd\\hooks\\opencode-plugin";
    assert.strictEqual(
      findOpencodePluginEntry(["vendor/opencode-plugin", absEntry], "opencode-plugin"),
      absEntry
    );
  });
});

describe("findOpenClawPluginEntry", () => {
  it("matches only absolute plugin entries by basename", () => {
    const absEntry = "C:\\clawd\\hooks\\openclaw-plugin";
    assert.strictEqual(
      findOpenClawPluginEntry(["vendor/openclaw-plugin", absEntry], "openclaw-plugin"),
      absEntry
    );
  });
});
