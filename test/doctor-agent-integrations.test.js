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
const { getAgentDescriptor } = require("../src/doctor-detectors/agent-descriptors");
const { GEMINI_HOOK_EVENTS } = require("../hooks/gemini-install");
const { ANTIGRAVITY_HOOK_EVENTS, __test: antigravityInstallTest } = require("../hooks/antigravity-install");
const { QWEN_CODE_HOOK_EVENTS, buildQwenCodeHookCommand } = require("../hooks/qwen-code-install");
const { HOOK_ENTRIES: CODEWHALE_HOOK_ENTRIES } = require("../hooks/codewhale-install");
const { QODER_HOOK_EVENTS, buildQoderHookCommand } = require("../hooks/qoder-install");
const { KIMI_HOOK_EVENTS } = require("../hooks/kimi-install");
const {
  buildStableCodexHookCommand,
  materializeStableCodexHookLauncher,
} = require("../hooks/codex-install-utils");
const {
  computeCodexHookTrustedHash,
  findCodexHookTrustPositions,
} = require("../src/doctor-detectors/codex-features-check");
const { validateHookTarget } = require("../src/doctor-detectors/agent-node-bin-parser");
const {
  ZCODE_HOOK_EVENTS,
  buildZcodeHookCommand,
  buildZcodeProcessHook,
  timeoutMsForZcodeEvent,
} = require("../hooks/zcode-install");
const { TRAECODE_HOOK_EVENTS } = require("../hooks/traecode-install");
const {
  BRIDGE_PACKAGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  MANAGED_OWNER,
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSION,
  __test: dshInstallTest,
} = require("../hooks/dsh-install");

const DSH_BRIDGE_SOURCE_DIR = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");

// Complete healthy legacy Kimi config: every event registered, every command
// carrying the canonical argv mode flag.
function kimiLegacyToml({ events = KIMI_HOOK_EVENTS, command = '"node" "/app/hooks/kimi-hook.js" --permission-mode=suspect' } = {}) {
  return events.map((event) => [
    "[[hooks]]",
    `event = "${event}"`,
    `command = '${command}'`,
    'matcher = ""',
    "timeout = 30",
    "",
  ].join("\n")).join("\n");
}

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

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
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
    platform: options.platform,
    prefs: options.prefs || {},
    descriptors: [descriptor],
    server: options.server || null,
    validateCommand: options.validateCommand || (() => ({
      ok: true,
      nodeBin: "/node",
      scriptPath: "/app/hooks/test-hook.js",
    })),
    validateTarget: options.validateTarget || ((target) => ({
      ok: true,
      nodeBin: target.nodeBin,
      scriptPath: target.scriptPath,
    })),
    dshInstallRoot: options.dshInstallRoot,
    dshManagedRoot: options.dshManagedRoot || descriptor.dshManagedRoot,
  }).details[0];
}

function suspiciousShrinkGuardServer() {
  return {
    getClaudeHookGuardStatus: () => ({
      type: "suspicious-shrink",
      at: 1234,
      before: { keyCount: 5, hookCount: 12, thirdPartyHookCount: 2 },
      after: { keyCount: 1, hookCount: 0, thirdPartyHookCount: 0 },
    }),
  };
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

function antigravityDescriptor() {
  const root = makeTempDir();
  const parentDir = path.join(root, ".gemini", "config");
  return baseDescriptor({
    agentId: "antigravity-cli",
    agentName: "Antigravity CLI",
    marker: "antigravity-hook.js",
    parentDir,
    configPath: path.join(parentDir, "hooks.json"),
    configMode: "antigravity-hooks",
    hookEvents: ANTIGRAVITY_HOOK_EVENTS,
  });
}

function antigravityHooksConfig(commandForEvent = (event) => `"/node" "/app/hooks/antigravity-hook.js" ${event}`) {
  // D2: state-only — no PreToolUse.
  return {
    clawd: {
      PreInvocation: [{ type: "command", command: commandForEvent("PreInvocation") }],
      PostToolUse: [{
        matcher: "*",
        hooks: [{ type: "command", command: commandForEvent("PostToolUse") }],
      }],
      PostInvocation: [{ type: "command", command: commandForEvent("PostInvocation") }],
      Stop: [{ type: "command", command: commandForEvent("Stop") }],
    },
  };
}

function writeAntigravityHooks(descriptor, hooks = antigravityHooksConfig()) {
  writeJson(descriptor.configPath, hooks);
}

function qwenDescriptor() {
  const root = makeTempDir();
  const parentDir = path.join(root, ".qwen");
  return baseDescriptor({
    agentId: "qwen-code",
    agentName: "Qwen Code",
    marker: "qwen-code-hook.js",
    parentDir,
    configPath: path.join(parentDir, "settings.json"),
    configMode: "file",
    nested: true,
    hookEvents: QWEN_CODE_HOOK_EVENTS,
  });
}

function managedFileDescriptor(agentId, dirName) {
  const root = makeTempDir();
  const parentDir = path.join(root, dirName);
  return {
    ...getAgentDescriptor(agentId),
    parentDir,
    configPath: path.join(parentDir, "settings.json"),
  };
}

function qoderDescriptor() {
  return managedFileDescriptor("qoder", ".qoder");
}

function nestedHooksConfig(events, marker, commandForEvent = (event) => `"/node" "/app/hooks/${marker}" ${event}`) {
  const hooks = {};
  for (const event of events) {
    hooks[event] = [{
      matcher: "*",
      hooks: [{ name: "clawd", type: "command", command: commandForEvent(event) }],
    }];
  }
  return hooks;
}

function qoderHooksConfig(commandForEvent) {
  return nestedHooksConfig(QODER_HOOK_EVENTS, "qoder-hook.js", commandForEvent);
}

function reasonixDescriptor() {
  const descriptor = managedFileDescriptor("reasonix", ".reasonix");
  return {
    ...descriptor,
    configTargets: [{
      label: "current",
      parentDir: descriptor.parentDir,
      configPath: descriptor.configPath,
    }],
    preferExistingConfigFile: true,
  };
}

function qoderWorkDescriptor() {
  return managedFileDescriptor("qoderwork", ".qoderwork");
}

function workBuddyDescriptor() {
  const descriptor = managedFileDescriptor("workbuddy", ".workbuddy-ai");
  return {
    ...descriptor,
    configTargets: [{
      label: "workbuddy-ai",
      parentDir: descriptor.parentDir,
      configPath: descriptor.configPath,
    }],
  };
}

function flatHooksConfig(events, marker) {
  return Object.fromEntries(events.map((event) => [
    event,
    [{ match: "*", command: `"/node" "/app/hooks/${marker}" ${event}` }],
  ]));
}

function codewhaleDescriptor() {
  const root = makeTempDir();
  const parentDir = path.join(root, ".codewhale");
  return baseDescriptor({
    agentId: "codewhale",
    agentName: "CodeWhale",
    parentDir,
    configPath: path.join(parentDir, "config.toml"),
    commandMarker: "codewhale-hook.js",
    marker: "managed by clawd-on-desk",
    configMode: "codewhale-hooks-toml",
    hookEvents: CODEWHALE_HOOK_ENTRIES.map((entry) => entry[0]),
  });
}

function codewhaleToml(events = CODEWHALE_HOOK_ENTRIES.map((entry) => entry[0]), commandForEvent = (event) => `"/node" "/app/hooks/codewhale-hook.js" "${event}"`) {
  return [
    "[hooks]",
    "enabled = true",
    "",
    ...events.flatMap((event) => [
      "[[hooks.hooks]]",
      "# managed by clawd-on-desk",
      `event = "${event}"`,
      `command = '''${commandForEvent(event)}'''`,
      "background = true",
      "",
    ]),
  ].join("\n");
}

function qwenHooksConfig(commandForEvent = (event) => `"/node" "/app/hooks/qwen-code-hook.js" ${event}`) {
  const hooks = {};
  for (const event of QWEN_CODE_HOOK_EVENTS) {
    hooks[event] = [{
      matcher: "*",
      hooks: [{ name: "clawd", type: "command", command: commandForEvent(event) }],
    }];
  }
  return { hooks };
}

// ZCode config-file hooks nest under hooks.events.* (NOT hooks.*), and require
// hooks.enabled:true. The doctor's generic event scanner must follow
// descriptor.hookEventsContainer=["hooks","events"] to find them.
function zcodeDescriptor() {
  const root = makeTempDir();
  const parentDir = path.join(root, ".zcode", "cli");
  return baseDescriptor({
    agentId: "zcode",
    agentName: "ZCode",
    marker: "zcode-hook.js",
    parentDir,
    configPath: path.join(parentDir, "config.json"),
    configMode: "file",
    nested: true,
    hookEvents: ZCODE_HOOK_EVENTS,
    hookExecutorShape: "zcode-process",
    processHookTimeoutMsForEvent: timeoutMsForZcodeEvent,
    hookEventsContainer: ["hooks", "events"],
  });
}

function zcodeHooksConfig(hookForEvent = (event) => (
  buildZcodeProcessHook("/node", "/app/hooks/zcode-hook.js", event)
)) {
  const events = {};
  for (const event of ZCODE_HOOK_EVENTS) {
    events[event] = [{
      hooks: [hookForEvent(event)],
    }];
  }
  return { hooks: { enabled: true, events } };
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
    hooks[event] = [{ hooks: [{
      type: "command",
      command: `"/node" "/app/hooks/codex-hook.js" ${event}`,
      timeout: event === "PermissionRequest" ? 600 : 30,
    }] }];
  }
  return { hooks };
}

function codexTrustState(descriptor, settings, platform = process.platform) {
  const positions = findCodexHookTrustPositions(settings);
  return [
    "[features]",
    "hooks = true",
    "",
    ...positions.flatMap((position) => [
      `[hooks.state.'${descriptor.configPath}:${position.eventKey}:${position.entryIndex}:${position.hookIndex}']`,
      `trusted_hash = "${computeCodexHookTrustedHash(
        position.eventName,
        position.group,
        position.hook,
        platform
      )}"`,
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
  function dshDescriptor() {
    const root = makeTempDir();
    const parentDir = path.join(root, ".dsh");
    return baseDescriptor({
      agentId: "deepseek-harness",
      agentName: "DeepSeek Harness",
      eventSource: "plugin-event",
      parentDir,
      configPath: path.join(parentDir, "profiles", "web"),
      configMode: "dsh-plugin",
      dshManagedRoot: path.join(root, ".clawd", "integrations", "deepseek-harness"),
    });
  }

  function writeDshProfile(descriptor, mode) {
    const manifestPath = path.join(descriptor.configPath, "package.json");
    const manifest = {
      name: "dsh-profile-web",
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    };
    const pluginDir = path.join(descriptor.configPath, "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
    const bundleHash = dshInstallTest.hashBridgeDirectorySync(fs, DSH_BRIDGE_SOURCE_DIR);
    const generationDir = path.join(descriptor.dshManagedRoot, "generations", bundleHash);
    if (mode !== "absent") {
      manifest.dependencies[BRIDGE_PACKAGE_NAME] = mode === "healthy"
        ? `file:${generationDir}`
        : `file:${pluginDir}`;
      manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
    }
    writeJson(manifestPath, manifest);
    if (mode === "healthy" || mode === "foreign") {
      if (mode === "healthy") fs.cpSync(DSH_BRIDGE_SOURCE_DIR, pluginDir, { recursive: true });
      else writeJson(path.join(pluginDir, "package.json"), { name: BRIDGE_PACKAGE_NAME, version: "0.0.0" });
      if (mode === "healthy") {
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
      }
    }
  }

  it("reports DSH disk health from the managed plugin rather than host-home presence", () => {
    const descriptor = dshDescriptor();
    writeDshProfile(descriptor, "absent");
    const absent = runOne(descriptor);
    assert.strictEqual(absent.status, "not-connected");
    assert.strictEqual(absent.bridgeHealth, "absent");
    assert.deepStrictEqual(absent.fixAction, { type: "agent-integration", agentId: "deepseek-harness" });

    writeDshProfile(descriptor, "healthy");
    const healthy = runOne(descriptor);
    assert.strictEqual(healthy.status, "ok");
    assert.strictEqual(healthy.bridgeHealth, "healthy");
    assert.match(healthy.detail, /verified on disk/i);
    assert.match(healthy.detail, /restart any running dsh web/i);
  });

  it("does not offer Doctor Fix for a foreign same-name DSH plugin", () => {
    const descriptor = dshDescriptor();
    writeDshProfile(descriptor, "foreign");
    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "needs-review");
    assert.strictEqual(detail.bridgeHealth, "profile-entry-foreign-or-conflicting");
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("surfaces a persistent DSH unknown-mutation latch as repairable inspection required", () => {
    const descriptor = dshDescriptor();
    writeDshProfile(descriptor, "healthy");
    const managedRoot = path.join(path.dirname(descriptor.parentDir), ".clawd", "integrations", "deepseek-harness");
    writeJson(path.join(managedRoot, "inspection-required.json"), {
      owner: MANAGED_OWNER,
      schemaVersion: 1,
      reason: "plugin-add-unknown",
    });
    const detail = runOne(descriptor, { dshManagedRoot: managedRoot });
    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.bridgeHealth, "inspection-required");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "deepseek-harness" });
  });

  it("returns not-installed when parent dir is missing", () => {
    const detail = runOne(baseDescriptor());
    assert.strictEqual(detail.status, "not-installed");
    assert.strictEqual(detail.level, "info");
    assert.strictEqual(detail.parentDirExists, false);
  });

  it("reports not-managed before disabled for uninstalled agents", () => {
    const descriptor = baseDescriptor({ agentId: "gemini-cli" });
    const detail = runOne(descriptor, {
      prefs: {
        agents: {
          "gemini-cli": {
            integrationInstalled: false,
            enabled: false,
          },
        },
      },
    });

    assert.strictEqual(detail.status, "not-managed");
    assert.strictEqual(detail.level, "info");
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

  it("explains Claude hook loss when the suspicious-shrink guard recently fired", () => {
    const descriptor = baseDescriptor({
      agentId: "claude-code",
      agentName: "Claude Code",
      marker: "clawd-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, { hooks: {} });

    const detail = runOne(descriptor, {
      server: suspiciousShrinkGuardServer(),
    });

    assert.strictEqual(detail.status, "not-connected");
    assert.match(detail.detail, /paused automatic Claude hook repair/);
    assert.strictEqual(detail.claudeHookGuard.type, "suspicious-shrink");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "claude-code" });
  });

  it("does not show the Claude guard notice for other agents", () => {
    const descriptor = baseDescriptor();
    writeJson(descriptor.configPath, { hooks: {} });

    const detail = runOne(descriptor, {
      server: suspiciousShrinkGuardServer(),
    });

    assert.strictEqual(detail.status, "not-connected");
    assert.match(detail.detail, /has no test-hook\.js command/);
    assert.doesNotMatch(detail.detail, /paused automatic Claude hook repair/);
    assert.strictEqual(detail.claudeHookGuard, undefined);
  });

  it("does not show the Claude guard notice when Claude hooks are connected", () => {
    const descriptor = baseDescriptor({
      agentId: "claude-code",
      agentName: "Claude Code",
      marker: "clawd-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ command: '"/node" "/app/hooks/clawd-hook.js" Stop' }],
        }],
      },
    });

    const detail = runOne(descriptor, {
      server: suspiciousShrinkGuardServer(),
    });

    assert.strictEqual(detail.status, "ok");
    assert.doesNotMatch(detail.detail, /paused automatic Claude hook repair/);
    assert.strictEqual(detail.claudeHookGuard, undefined);
  });

  it("keeps the original Claude hook loss detail when no guard status is available", () => {
    const descriptor = baseDescriptor({
      agentId: "claude-code",
      agentName: "Claude Code",
      marker: "clawd-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, { hooks: {} });

    const detail = runOne(descriptor, {
      server: {},
    });

    assert.strictEqual(detail.status, "not-connected");
    assert.match(detail.detail, /has no clawd-hook\.js command/);
    assert.doesNotMatch(detail.detail, /paused automatic Claude hook repair/);
    assert.strictEqual(detail.claudeHookGuard, undefined);
  });

  it("reports source-script-missing without a configuration Repair when the runtime health says the source is gone", () => {
    const descriptor = baseDescriptor({
      agentId: "claude-code",
      agentName: "Claude Code",
      marker: "clawd-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, { hooks: {} });

    const detail = runOne(descriptor, {
      server: {
        getClaudeHookHealthStatus: () => ({
          status: "degraded",
          degradedReason: "source-script-missing",
          at: 5000,
        }),
      },
    });

    assert.strictEqual(detail.status, "source-script-missing");
    assert.match(detail.detail, /reinstall or re-extract/i);
    assert.strictEqual(detail.claudeHookRuntimeStatus.degradedReason, "source-script-missing");
    assert.strictEqual(detail.fixAction, undefined, "source-script-missing must not offer a configuration Repair");
  });

  it("explains when an env-indirected Claude hook is preserved because Node is unresolved (#852)", () => {
    const descriptor = baseDescriptor({
      agentId: "claude-code",
      agentName: "Claude Code",
      marker: "clawd-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, { hooks: {} });

    const detail = runOne(descriptor, {
      server: {
        getClaudeHookHealthStatus: () => ({
          status: "degraded",
          degradedReason: "env-hook-node-unresolved",
          at: 7000,
        }),
      },
    });

    assert.strictEqual(detail.status, "not-connected");
    assert.match(detail.detail, /CLAWD_NODE_BIN/);
    assert.strictEqual(detail.claudeHookRuntimeStatus.degradedReason, "env-hook-node-unresolved");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "claude-code" });
  });

  it("keeps an unverified env-indirected hook visible beside an otherwise valid Claude hook (#852)", () => {
    const descriptor = baseDescriptor({
      agentId: "claude-code",
      agentName: "Claude Code",
      marker: "clawd-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: '"node" "/app/hooks/clawd-hook.js" Stop' }] },
          { matcher: "", hooks: [{ type: "command", command: '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" Stop' }] },
        ],
      },
    });

    const detail = runOne(descriptor, {
      server: {
        getClaudeHookHealthStatus: () => ({
          status: "degraded",
          degradedReason: "env-indirection-unverified",
          at: 8000,
        }),
      },
    });

    assert.strictEqual(detail.status, "needs-review", "generic marker success must not hide the degraded env diagnostic");
    assert.strictEqual(detail.level, "warning");
    assert.match(detail.detail, /CLAWD_HOOK_PATH/);
    assert.strictEqual(detail.claudeHookRuntimeStatus.degradedReason, "env-indirection-unverified");
    assert.strictEqual(detail.fixAction, undefined, "unverified ownership must not offer a destructive automatic Fix");
  });

  it("does not let a stale env runtime diagnostic hide a corrupt Claude settings file (#852)", () => {
    const descriptor = baseDescriptor({
      agentId: "claude-code",
      agentName: "Claude Code",
      marker: "clawd-hook.js",
      nested: true,
    });
    writeText(descriptor.configPath, "{not-json");

    const detail = runOne(descriptor, {
      server: {
        getClaudeHookHealthStatus: () => ({
          status: "degraded",
          degradedReason: "env-indirection-unverified",
          at: 8100,
        }),
      },
    });

    assert.strictEqual(detail.status, "config-corrupt");
    assert.match(detail.detail, /parse|JSON|corrupt/i);
    assert.strictEqual(detail.claudeHookRuntimeStatus, undefined);
  });

  it("explains manual-fix-required while still offering an explicit Fix that can bypass the automatic cap", () => {
    const descriptor = baseDescriptor({
      agentId: "claude-code",
      agentName: "Claude Code",
      marker: "clawd-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, { hooks: {} });

    const detail = runOne(descriptor, {
      server: {
        getClaudeHookHealthStatus: () => ({
          status: "manual-fix-required",
          issueSignature: "v1:core-script-path",
          attempt: 3,
          message: "Claude hook repair did not verify healthy",
          at: 9000,
        }),
      },
    });

    assert.strictEqual(detail.status, "not-connected");
    assert.match(detail.detail, /failed 3 times/);
    assert.strictEqual(detail.claudeHookRuntimeStatus.status, "manual-fix-required");
    assert.strictEqual(detail.claudeHookRuntimeStatus.issueSignature, "v1:core-script-path");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "claude-code" });
  });

  it("explains a guarded state reported only through getClaudeHookHealthStatus (no legacy guard notice)", () => {
    const descriptor = baseDescriptor({
      agentId: "claude-code",
      agentName: "Claude Code",
      marker: "clawd-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, { hooks: {} });

    const detail = runOne(descriptor, {
      server: {
        getClaudeHookHealthStatus: () => ({ status: "guarded", issueSignature: "v1:managed-hooks", at: 3000 }),
      },
    });

    assert.strictEqual(detail.status, "not-connected");
    assert.match(detail.detail, /paused automatic Claude hook repair/);
    assert.strictEqual(detail.claudeHookRuntimeStatus.status, "guarded");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "claude-code" });
  });

  it("does not annotate a healthy disk state even if a stale runtime notice exists", () => {
    const descriptor = baseDescriptor({
      agentId: "claude-code",
      agentName: "Claude Code",
      marker: "clawd-hook.js",
      nested: true,
    });
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [{ matcher: "", hooks: [{ command: '"/node" "/app/hooks/clawd-hook.js" Stop' }] }],
      },
    });

    const detail = runOne(descriptor, {
      server: {
        getClaudeHookHealthStatus: () => ({ status: "manual-fix-required", issueSignature: "v1:core-script-path", at: 1000 }),
      },
    });

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.claudeHookRuntimeStatus, undefined);
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

  it("reports missing Antigravity hooks as repairable not-connected", () => {
    const descriptor = antigravityDescriptor();
    fs.mkdirSync(descriptor.parentDir, { recursive: true });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.eventSource, "hook");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "antigravity-cli" });
  });

  it("validates Antigravity hooks for every required event", () => {
    const descriptor = antigravityDescriptor();
    writeAntigravityHooks(descriptor);

    const seen = [];
    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        seen.push(command);
        return {
          ok: true,
          nodeBin: "/node",
          scriptPath: "/app/hooks/antigravity-hook.js",
        };
      },
    });

    assert.strictEqual(seen.length, ANTIGRAVITY_HOOK_EVENTS.length);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, ANTIGRAVITY_HOOK_EVENTS.length);
    assert.strictEqual(detail.scriptPath, "/app/hooks/antigravity-hook.js");
  });

  it("validates Windows Antigravity EncodedCommand hooks for every required event", () => {
    const descriptor = antigravityDescriptor();
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const scriptPath = "D:/app/hooks/antigravity-hook.js";
    writeAntigravityHooks(descriptor, antigravityHooksConfig((event) =>
      antigravityInstallTest.buildWindowsAntigravityHookCommand(
        nodeBin,
        scriptPath,
        event,
        {
          platform: "win32",
          powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        }
      )
    ));

    const seen = [];
    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        seen.push(command);
        assert.strictEqual(command.includes("antigravity-hook.js"), false);
        return {
          ok: true,
          nodeBin,
          scriptPath,
        };
      },
    });

    assert.strictEqual(seen.length, ANTIGRAVITY_HOOK_EVENTS.length);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, ANTIGRAVITY_HOOK_EVENTS.length);
    assert.strictEqual(detail.scriptPath, scriptPath);
  });

  it("warns when Antigravity hooks are missing any required event", () => {
    const descriptor = antigravityDescriptor();
    writeAntigravityHooks(descriptor, {
      clawd: {
        PreToolUse: [{
          matcher: "*",
          hooks: [{ type: "command", command: '"/node" "/app/hooks/antigravity-hook.js" PreToolUse' }],
        }],
      },
    });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.ok(detail.missingAntigravityHookEvents.includes("PreInvocation"));
    assert.ok(detail.missingAntigravityHookEvents.includes("Stop"));
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "antigravity-cli" });
  });

  it("returns broken-path when Antigravity hook commands fail validation", () => {
    const descriptor = antigravityDescriptor();
    writeAntigravityHooks(descriptor);

    const detail = runOne(descriptor, {
      validateCommand: () => ({
        ok: false,
        issue: "scriptPath-missing",
        nodeBin: "/node",
        scriptPath: "/missing/antigravity-hook.js",
      }),
    });

    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.hookCommandIssue, "scriptPath-missing");
    assert.strictEqual(detail.brokenAntigravityHookEvent, "PreInvocation");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "antigravity-cli" });
  });

  it("validates Qwen Code hooks for every required event", () => {
    const descriptor = qwenDescriptor();
    writeJson(descriptor.configPath, qwenHooksConfig());

    const seen = [];
    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        seen.push(command);
        return {
          ok: true,
          nodeBin: "/node",
          scriptPath: "/app/hooks/qwen-code-hook.js",
        };
      },
    });

    assert.strictEqual(seen.length, QWEN_CODE_HOOK_EVENTS.length);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, QWEN_CODE_HOOK_EVENTS.length);
    assert.strictEqual(detail.scriptPath, "/app/hooks/qwen-code-hook.js");
    assert.deepStrictEqual(detail.supplementary, {
      key: "qwen_hooks",
      value: "enabled",
      detail: "settings.json allows Clawd Qwen hooks",
    });
  });

  it("validates Windows Qwen Code EncodedCommand hooks for every required event", () => {
    const descriptor = qwenDescriptor();
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const scriptPath = "D:/app/hooks/qwen-code-hook.js";
    writeJson(descriptor.configPath, qwenHooksConfig((event) =>
      buildQwenCodeHookCommand(
        nodeBin,
        scriptPath,
        event,
        {
          platform: "win32",
          powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        }
      )
    ));

    const seen = [];
    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        seen.push(command);
        assert.strictEqual(command.includes("qwen-code-hook.js"), false);
        return {
          ok: true,
          nodeBin,
          scriptPath,
        };
      },
    });

    assert.strictEqual(seen.length, QWEN_CODE_HOOK_EVENTS.length);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, QWEN_CODE_HOOK_EVENTS.length);
    assert.strictEqual(detail.scriptPath, scriptPath);
  });

  it("warns when Qwen Code is missing any required hook event", () => {
    const descriptor = qwenDescriptor();
    writeJson(descriptor.configPath, {
      hooks: {
        PreToolUse: [{
          matcher: "*",
          hooks: [{ name: "clawd", type: "command", command: '"/node" "/app/hooks/qwen-code-hook.js" PreToolUse' }],
        }],
      },
    });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.ok(detail.missingQwenHookEvents.includes("SessionStart"));
    assert.ok(detail.missingQwenHookEvents.includes("PermissionRequest"));
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "qwen-code" });
  });

  it("does not offer automatic repair when Qwen hooks are disabled globally", () => {
    const descriptor = qwenDescriptor();
    writeJson(descriptor.configPath, {
      ...qwenHooksConfig(),
      disableAllHooks: true,
    });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.detail, "Qwen Code hooks are disabled in settings.json; Clawd preserves this user setting and will not receive hook events");
    assert.deepStrictEqual(detail.supplementary, {
      key: "qwen_hooks",
      value: "disabled-global",
      detail: "disableAllHooks is true",
    });
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("validates ZCode hooks nested under hooks.events.* for every required event", () => {
    // Regression: the generic event scanner only saw settings.hooks.<Event>,
    // so a correctly-installed ZCode config (hooks.events.*) was always reported
    // as not-connected. descriptor.hookEventsContainer routes the scan to the
    // nested container.
    const descriptor = zcodeDescriptor();
    writeJson(descriptor.configPath, zcodeHooksConfig());

    const seen = [];
    const detail = runOne(descriptor, {
      validateTarget: (target) => {
        seen.push(target);
        return { ok: true, ...target };
      },
    });

    assert.strictEqual(seen.length, ZCODE_HOOK_EVENTS.length);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, ZCODE_HOOK_EVENTS.length);
    assert.strictEqual(detail.scriptPath, "/app/hooks/zcode-hook.js");
    assert.deepStrictEqual(detail.supplementary, {
      key: "zcode_hooks",
      value: "enabled",
      detail: "config.json allows Clawd ZCode hooks",
    });
  });

  it("offers repair when ZCode hooks.enabled is absent rather than treating the runner as healthy", () => {
    const descriptor = zcodeDescriptor();
    const config = zcodeHooksConfig();
    delete config.hooks.enabled;
    writeJson(descriptor.configPath, config);

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.supplementary.value, "needs-enable");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "zcode" });
  });

  it("warns without Fix when ZCode hooks are explicitly disabled globally", () => {
    const descriptor = zcodeDescriptor();
    const config = zcodeHooksConfig();
    config.hooks.enabled = false;
    writeJson(descriptor.configPath, config);

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(
      detail.detail,
      "ZCode config-file hooks are disabled globally; Clawd preserves hooks.enabled=false and will not receive hook events"
    );
    assert.deepStrictEqual(detail.supplementary, {
      key: "zcode_hooks",
      value: "disabled-global",
      detail: "hooks.enabled is false",
    });
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("warns without Fix when a managed ZCode event hook has enabled:false", () => {
    const descriptor = zcodeDescriptor();
    const config = zcodeHooksConfig();
    config.hooks.events.PreToolUse[0].hooks[0].enabled = false;
    writeJson(descriptor.configPath, config);

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.deepStrictEqual(detail.supplementary, {
      key: "zcode_hooks",
      value: "disabled-events",
      detail: "Clawd hooks have enabled=false for: PreToolUse",
      disabledEvents: ["PreToolUse"],
    });
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("treats a ZCode event as active when one managed duplicate remains enabled", () => {
    const descriptor = zcodeDescriptor();
    const config = zcodeHooksConfig();
    config.hooks.events.Stop.push({
      hooks: [buildZcodeProcessHook("/node", "/app/hooks/zcode-hook.js", "Stop", {
        enabled: false,
      })],
    });
    writeJson(descriptor.configPath, config);

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.supplementary.value, "enabled");
  });

  it("offers Fix for unsupported entry-level enabled:false instead of preserving invalid schema", () => {
    const descriptor = zcodeDescriptor();
    const config = zcodeHooksConfig();
    config.hooks.events.PreToolUse[0].enabled = false;
    writeJson(descriptor.configPath, config);

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.supplementary.value, "invalid-wrapper");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "zcode" });
  });

  it("warns when ZCode hooks.events is missing any required event", () => {
    const descriptor = zcodeDescriptor();
    const config = zcodeHooksConfig();
    // Drop the Stop entry to simulate an incomplete install.
    delete config.hooks.events.Stop;
    writeJson(descriptor.configPath, config);

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.ok(detail.missingHookEvents.includes("Stop"));
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "zcode" });
  });

  it("reports a foreign PermissionRequest hook as a conflict without offering a Fix", () => {
    const descriptor = zcodeDescriptor();
    const config = zcodeHooksConfig();
    // Replace Clawd's entry with a user's own security hook.
    config.hooks.events.PermissionRequest = [{
      hooks: [{ type: "process", command: "/node", args: ["/Users/dev/security-hook.js", "PermissionRequest"], timeoutMs: 30000 }],
    }];
    writeJson(descriptor.configPath, config);

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.supplementary.value, "permission-conflict");
    assert.ok(detail.detail.includes("foreign PermissionRequest hook"));
    // A Fix would re-register Clawd's hook next to the foreign one and create
    // the exact last-wins override this report exists to prevent.
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("reports a nested non-command PermissionRequest hook as a conflict without offering a Fix", () => {
    const descriptor = zcodeDescriptor();
    const config = zcodeHooksConfig();
    config.hooks.events.PermissionRequest = [{
      hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 }],
    }];
    writeJson(descriptor.configPath, config);

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.supplementary.value, "permission-conflict");
    assert.ok(detail.detail.includes("foreign PermissionRequest hook"));
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("reports coexistence of Clawd and foreign PermissionRequest hooks as a conflict", () => {
    const descriptor = zcodeDescriptor();
    const config = zcodeHooksConfig();
    config.hooks.events.PermissionRequest.push({
      hooks: [{ type: "process", command: "/node", args: ["/Users/dev/security-hook.js", "PermissionRequest"], timeoutMs: 30000 }],
    });
    writeJson(descriptor.configPath, config);

    const detail = runOne(descriptor);

    assert.strictEqual(detail.supplementary.value, "permission-conflict");
    assert.ok(detail.detail.includes("coexists"));
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("validates Windows ZCode process hooks with a spaced absolute node path", () => {
    const descriptor = zcodeDescriptor();
    const scriptPath = "D:/app/hooks/zcode-hook.js";
    writeJson(descriptor.configPath, zcodeHooksConfig((event) => (
      buildZcodeProcessHook("C:\\Program Files\\nodejs\\node.exe", scriptPath, event)
    )));

    const detail = runOne(descriptor, {
      platform: "win32",
      validateTarget: (target) => {
        assert.deepStrictEqual(target, {
          nodeBin: "C:\\Program Files\\nodejs\\node.exe",
          scriptPath,
        });
        return { ok: true, ...target };
      },
    });

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, ZCODE_HOOK_EVENTS.length);
    assert.strictEqual(detail.scriptPath, scriptPath);
  });

  it("reports the failing ZCode process target without sending it through the command parser", () => {
    const descriptor = zcodeDescriptor();
    writeJson(descriptor.configPath, zcodeHooksConfig());
    let commandParserCalls = 0;

    const detail = runOne(descriptor, {
      validateCommand: () => {
        commandParserCalls++;
        return { ok: true };
      },
      validateTarget: (target) => ({
        ok: false,
        issue: "scriptPath-missing",
        ...target,
      }),
    });

    assert.strictEqual(commandParserCalls, 0);
    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.brokenHookEvent, "SessionStart");
    assert.strictEqual(detail.hookCommandIssue, "scriptPath-missing");
    assert.strictEqual(detail.nodeBin, "/node");
    assert.strictEqual(detail.scriptPath, "/app/hooks/zcode-hook.js");
  });

  it("rejects a ZCode process hook with a non-canonical event argv", () => {
    const descriptor = zcodeDescriptor();
    const config = zcodeHooksConfig();
    config.hooks.events.Stop[0].hooks[0].args[1] = "PreToolUse";
    writeJson(descriptor.configPath, config);

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.brokenHookEvent, "Stop");
    assert.strictEqual(detail.hookCommandIssue, "process-shape-invalid");
  });

  it("rejects a ZCode process hook with a non-canonical timeout", () => {
    const descriptor = zcodeDescriptor();
    const config = zcodeHooksConfig();
    config.hooks.events.SessionStart[0].hooks[0].timeoutMs = 30000;
    writeJson(descriptor.configPath, config);

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.brokenHookEvent, "SessionStart");
    assert.strictEqual(detail.hookCommandIssue, "process-shape-invalid");
  });

  it("still validates legacy Windows EncodedCommand hooks before migration", () => {
    const descriptor = zcodeDescriptor();
    const scriptPath = "D:/app/hooks/zcode-hook.js";
    writeJson(descriptor.configPath, zcodeHooksConfig((event) => ({
      type: "command",
      command: buildZcodeHookCommand(
        "C:\\Program Files\\nodejs\\node.exe",
        scriptPath,
        event,
        {
          platform: "win32",
          powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        }
      ),
      timeoutMs: 30000,
    })));

    const seen = [];
    const detail = runOne(descriptor, {
      platform: "win32",
      validateCommand: (command) => {
        seen.push(command);
        return { ok: true, nodeBin: "C:\\Program Files\\nodejs\\node.exe", scriptPath };
      },
    });

    assert.strictEqual(seen.length, ZCODE_HOOK_EVENTS.length);
    assert.strictEqual(detail.status, "ok");
  });

  it("validates Qoder state-only hooks through the generic file-mode path", () => {
    const descriptor = qoderDescriptor();
    writeJson(descriptor.configPath, { hooks: qoderHooksConfig() });

    const seen = [];
    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        seen.push(command);
        return { ok: true, nodeBin: "/node", scriptPath: "/app/hooks/qoder-hook.js" };
      },
    });

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, QODER_HOOK_EVENTS.length);
    assert.ok(seen.every((command) => command.includes("qoder-hook.js")));
  });

  it("annotates healthy TraeCode hooks with an enable-in-Trae notice", () => {
    const descriptor = managedFileDescriptor("traecode", ".trae-cn");
    writeJson(descriptor.configPath, { hooks: nestedHooksConfig(TRAECODE_HOOK_EVENTS, "traecode-hook.js") });

    const detail = runOne(descriptor, {
      validateCommand: () => ({ ok: true, nodeBin: "/node", scriptPath: "/app/hooks/traecode-hook.js" }),
    });

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, TRAECODE_HOOK_EVENTS.length);
    assert.match(detail.detail, /Settings → Hooks → Enable/);
    assert.match(detail.detail, /run mode: Sandbox/);
  });

  it("does not annotate TraeCode hooks when the integration is broken", () => {
    const descriptor = managedFileDescriptor("traecode", ".trae-cn");
    fs.mkdirSync(descriptor.parentDir, { recursive: true });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.doesNotMatch(detail.detail, /Settings → Hooks → Enable/);
  });

  it("detects portable Windows Qoder hooks (bash-safe form, marker in plain text)", () => {
    const descriptor = qoderDescriptor();
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const scriptPath = "D:/app/hooks/qoder-hook.js";
    writeJson(descriptor.configPath, { hooks: qoderHooksConfig((event) =>
      buildQoderHookCommand(nodeBin, scriptPath, event, { platform: "win32" })
    ) });

    const seen = [];
    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        seen.push(command);
        // Portable form keeps the marker in plain text and no backslashes.
        assert.strictEqual(command.includes("qoder-hook.js"), true);
        assert.strictEqual(command.includes("\\"), false);
        return { ok: true, nodeBin, scriptPath };
      },
    });

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, QODER_HOOK_EVENTS.length);
  });

  it("detects legacy Windows EncodedCommand Qoder hooks even though the marker is base64-wrapped", () => {
    const { buildWindowsEncodedNodeHookCommand } = require("../hooks/json-utils");
    const descriptor = qoderDescriptor();
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const scriptPath = "D:/app/hooks/qoder-hook.js";
    writeJson(descriptor.configPath, { hooks: qoderHooksConfig((event) =>
      buildWindowsEncodedNodeHookCommand(nodeBin, scriptPath, [event], {
        powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      })
    ) });

    const seen = [];
    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        seen.push(command);
        // Plain command text must not leak the marker — it lives in the base64 blob.
        assert.strictEqual(command.includes("qoder-hook.js"), false);
        return { ok: true, nodeBin, scriptPath };
      },
    });

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, QODER_HOOK_EVENTS.length);
  });

  it("warns and offers repair when Qoder has no Clawd hook", () => {
    const descriptor = qoderDescriptor();
    writeJson(descriptor.configPath, { hooks: {} });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.deepStrictEqual(detail.missingHookEvents, QODER_HOOK_EVENTS);
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "qoder" });
  });

  it("warns and offers repair when required file-mode hook events are missing", () => {
    for (const descriptor of [qoderDescriptor(), reasonixDescriptor(), qoderWorkDescriptor()]) {
      const hooks = descriptor.agentId === "reasonix"
        ? flatHooksConfig(descriptor.hookEvents, descriptor.marker)
        : nestedHooksConfig(descriptor.hookEvents, descriptor.marker);
      const firstEvent = descriptor.hookEvents[0];
      writeJson(descriptor.configPath, { hooks: { [firstEvent]: hooks[firstEvent] } });

      const detail = runOne(descriptor);
      assert.strictEqual(detail.status, "not-connected", descriptor.agentId);
      assert.strictEqual(detail.commandCount, 1, descriptor.agentId);
      assert.deepStrictEqual(detail.missingHookEvents, descriptor.hookEvents.slice(1), descriptor.agentId);
      assert.deepStrictEqual(detail.fixAction, {
        type: "agent-integration",
        agentId: descriptor.agentId,
      });
    }
  });

  it("checks the legacy Reasonix settings file when the current home has no settings", () => {
    const root = makeTempDir();
    const currentDir = path.join(root, "AppData", "Roaming", "reasonix");
    const legacyDir = path.join(root, ".reasonix");
    const descriptor = {
      ...getAgentDescriptor("reasonix"),
      parentDir: currentDir,
      configPath: path.join(currentDir, "settings.json"),
      configTargets: [
        {
          label: "current",
          parentDir: currentDir,
          configPath: path.join(currentDir, "settings.json"),
        },
        {
          label: "legacy",
          parentDir: legacyDir,
          configPath: path.join(legacyDir, "settings.json"),
        },
      ],
      preferExistingConfigFile: true,
    };
    fs.mkdirSync(currentDir, { recursive: true });
    writeJson(path.join(legacyDir, "settings.json"), {
      hooks: flatHooksConfig(descriptor.hookEvents, descriptor.marker),
    });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.configPath, path.join(legacyDir, "settings.json"));
    assert.strictEqual(detail.commandCount, descriptor.hookEvents.length);
  });

  it("validates every required WorkBuddy hook event", () => {
    const descriptor = workBuddyDescriptor();
    writeJson(descriptor.configPath, {
      hooks: nestedHooksConfig(descriptor.hookEvents, descriptor.marker),
    });

    const seen = [];
    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        seen.push(command);
        return { ok: true, nodeBin: "/node", scriptPath: "/app/hooks/workbuddy-hook.js" };
      },
    });

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, descriptor.hookEvents.length);
    assert.strictEqual(seen.length, descriptor.hookEvents.length);
    assert.ok(seen.every((command) => command.includes(descriptor.marker)));
  });

  it("does not treat a bare legacy WorkBuddy toolchain directory as active config", () => {
    const root = makeTempDir();
    const currentDir = path.join(root, ".workbuddy-ai");
    const legacyDir = path.join(root, ".workbuddy");
    const descriptor = {
      ...workBuddyDescriptor(),
      parentDir: currentDir,
      configPath: path.join(currentDir, "settings.json"),
      configTargets: [
        { label: "workbuddy-ai", parentDir: currentDir, configPath: path.join(currentDir, "settings.json") },
        { label: "legacy", parentDir: legacyDir, configPath: path.join(legacyDir, "settings.json") },
      ],
    };
    fs.mkdirSync(legacyDir, { recursive: true });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-installed");
    assert.strictEqual(detail.parentDirExists, false);
  });

  it("offers WorkBuddy repair when one required hook event is missing", () => {
    const descriptor = workBuddyDescriptor();
    const hooks = nestedHooksConfig(descriptor.hookEvents, descriptor.marker);
    const missingEvent = descriptor.hookEvents[4];
    delete hooks[missingEvent];
    writeJson(descriptor.configPath, { hooks });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.deepStrictEqual(detail.missingHookEvents, [missingEvent]);
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "workbuddy" });
  });

  it("reports the WorkBuddy event whose command path is broken", () => {
    const descriptor = workBuddyDescriptor();
    writeJson(descriptor.configPath, {
      hooks: nestedHooksConfig(descriptor.hookEvents, descriptor.marker),
    });
    const brokenEvent = descriptor.hookEvents[3];

    const detail = runOne(descriptor, {
      validateCommand: (command) => command.endsWith(` ${brokenEvent}`)
        ? {
          ok: false,
          issue: "scriptPath-missing",
          nodeBin: "/node",
          scriptPath: "/missing/workbuddy-hook.js",
        }
        : { ok: true, nodeBin: "/node", scriptPath: "/app/hooks/workbuddy-hook.js" },
    });

    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.brokenHookEvent, brokenEvent);
    assert.strictEqual(detail.hookCommandIssue, "scriptPath-missing");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "workbuddy" });
  });

  it("does not offer repair when a managed hook group is disabled", () => {
    for (const descriptor of [qoderDescriptor(), qoderWorkDescriptor()]) {
      writeJson(descriptor.configPath, {
        hooks: nestedHooksConfig(descriptor.hookEvents, descriptor.marker),
        hooksConfig: { disabled: ["clawd"] },
      });

      const detail = runOne(descriptor);
      assert.strictEqual(detail.status, "not-connected", descriptor.agentId);
      assert.strictEqual(detail.level, "warning", descriptor.agentId);
      assert.deepStrictEqual(detail.supplementary, {
        key: "hook_group",
        value: "disabled-clawd",
        detail: 'hooksConfig.disabled includes "clawd"',
      });
      assert.strictEqual(detail.fixAction, undefined, descriptor.agentId);
    }
  });

  it("does not offer repair when hooksConfig is globally disabled", () => {
    const descriptor = qoderDescriptor();
    writeJson(descriptor.configPath, {
      hooks: qoderHooksConfig(),
      hooksConfig: { enabled: false },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.deepStrictEqual(detail.supplementary, {
      key: "hook_group",
      value: "disabled-global",
      detail: "hooksConfig.enabled is false",
    });
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("ignores unrelated disabled hook groups", () => {
    const descriptor = qoderDescriptor();
    writeJson(descriptor.configPath, {
      hooks: qoderHooksConfig(),
      hooksConfig: { disabled: ["other"] },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.supplementary, undefined);
  });

  it("validates CodeWhale TOML hooks", () => {
    const descriptor = codewhaleDescriptor();
    writeText(descriptor.configPath, codewhaleToml());

    const seen = [];
    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        seen.push(command);
        return { ok: true, nodeBin: "/node", scriptPath: "/app/hooks/codewhale-hook.js" };
      },
    });

    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, CODEWHALE_HOOK_ENTRIES.length);
    assert.ok(seen.every((command) => command.includes("codewhale-hook.js")));
    assert.strictEqual(detail.scriptPath, "/app/hooks/codewhale-hook.js");
  });

  it("warns and offers repair when CodeWhale is missing managed hook events", () => {
    const descriptor = codewhaleDescriptor();
    writeText(descriptor.configPath, codewhaleToml(["session_start"]));

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.ok(detail.missingCodewhaleHookEvents.includes("session_end"));
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "codewhale" });
  });

  it("warns and offers repair when CodeWhale hooks are disabled", () => {
    const descriptor = codewhaleDescriptor();
    writeText(descriptor.configPath, codewhaleToml().replace("enabled = true", "enabled = false"));

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.deepStrictEqual(detail.supplementary, {
      key: "codewhale_hooks",
      value: "disabled",
      detail: "[hooks].enabled is false",
    });
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "codewhale" });
  });

  it("warns and offers repair when CodeWhale hook commands fail validation", () => {
    const descriptor = codewhaleDescriptor();
    writeText(descriptor.configPath, codewhaleToml());

    const detail = runOne(descriptor, {
      validateCommand: () => ({
        ok: false,
        reason: "missing-script",
        scriptPath: "/missing/codewhale-hook.js",
      }),
    });

    assert.strictEqual(detail.status, "broken-path");
    assert.match(detail.detail, /parse-failed/);
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "codewhale" });
  });

  it("does not offer automatic repair when Antigravity Clawd hooks are disabled", () => {
    const descriptor = antigravityDescriptor();
    writeAntigravityHooks(descriptor, {
      clawd: {
        enabled: false,
        ...antigravityHooksConfig().clawd,
      },
    });

    const detail = runOne(descriptor);

    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.detail, "Antigravity Clawd hooks are disabled in hooks.json; Clawd preserves this user setting and will not receive hook events");
    assert.deepStrictEqual(detail.supplementary, {
      key: "antigravity_hooks",
      value: "disabled-clawd",
      detail: "clawd.enabled is false",
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

  it("judges the kimi-code target when both generations exist (#563)", () => {
    const root = makeTempDir();
    const legacyDir = path.join(root, ".kimi");
    const kimiCodeDir = path.join(root, ".kimi-code");
    const descriptor = baseDescriptor({
      agentId: "kimi-cli",
      marker: "kimi-hook.js",
      configMode: "toml-text",
      parentDir: legacyDir,
      configPath: path.join(legacyDir, "config.toml"),
      configTargets: [
        { label: "kimi-code", parentDir: kimiCodeDir, configPath: path.join(kimiCodeDir, "config.toml") },
        { label: "legacy", parentDir: legacyDir, configPath: path.join(legacyDir, "config.toml") },
      ],
    });
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(kimiCodeDir, { recursive: true });
    // Legacy config carries a healthy hook; the kimi-code config is missing —
    // doctor must judge the kimi-code (priority) target and say not-connected.
    fs.writeFileSync(
      path.join(legacyDir, "config.toml"),
      '[[hooks]]\nevent = "Stop"\ncommand = \'"node" "/app/hooks/kimi-hook.js"\'\n',
      "utf8"
    );

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.ok(String(detail.configPath).includes(".kimi-code"));
  });

  it("falls back to the legacy target when kimi-code is absent (#563)", () => {
    const root = makeTempDir();
    const legacyDir = path.join(root, ".kimi");
    const kimiCodeDir = path.join(root, ".kimi-code");
    const descriptor = baseDescriptor({
      agentId: "kimi-cli",
      marker: "kimi-hook.js",
      configMode: "toml-text",
      parentDir: legacyDir,
      configPath: path.join(legacyDir, "config.toml"),
      configTargets: [
        { label: "kimi-code", parentDir: kimiCodeDir, configPath: path.join(kimiCodeDir, "config.toml") },
        { label: "legacy", parentDir: legacyDir, configPath: path.join(legacyDir, "config.toml") },
      ],
    });
    fs.mkdirSync(legacyDir, { recursive: true });
    // A COMPLETE healthy legacy install (all events + mode flag) — this test
    // is about target selection; completeness itself is covered by the
    // legacy-supplement suite below.
    fs.writeFileSync(path.join(legacyDir, "config.toml"), kimiLegacyToml(), "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
    const judged = String(detail.configPath);
    assert.ok(judged.includes(".kimi") && !judged.includes(".kimi-code"));
  });

  it("lists both generation dirs when neither exists (#563)", () => {
    const root = makeTempDir();
    const legacyDir = path.join(root, ".kimi");
    const kimiCodeDir = path.join(root, ".kimi-code");
    const descriptor = baseDescriptor({
      agentId: "kimi-cli",
      marker: "kimi-hook.js",
      configMode: "toml-text",
      parentDir: legacyDir,
      configPath: path.join(legacyDir, "config.toml"),
      configTargets: [
        { label: "kimi-code", parentDir: kimiCodeDir, configPath: path.join(kimiCodeDir, "config.toml") },
        { label: "legacy", parentDir: legacyDir, configPath: path.join(legacyDir, "config.toml") },
      ],
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-installed");
    assert.ok(detail.detail.includes(".kimi-code") && detail.detail.includes(".kimi"));
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


  // #544: Windows Clawd writes dual-field entries — commandWindows carries
  // the PowerShell form codex actually runs on Windows, command carries a
  // WSL-interop form only executable inside WSL. The doctor must validate
  // the field THIS platform's codex resolves; blanket-validating `command`
  // flagged every dual-field Windows install as broken-path, and Repair
  // regenerated the same fields forever.
  it("validates commandWindows on win32 for dual-field Codex entries (#544)", () => {
    const descriptor = codexDescriptor();
    const psForm = '& "C:\\Program Files\\nodejs\\node.exe" "D:/app/hooks/codex-hook.js"';
    const interopForm = '"/mnt/c/Program Files/nodejs/node.exe" "D:/app/hooks/codex-hook.js"';
    const settings = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: interopForm, commandWindows: psForm, timeout: 30 }] }],
      },
    };
    writeJson(descriptor.configPath, settings);
    fs.writeFileSync(descriptor.supplementary.configPath, codexTrustState(descriptor, settings, "win32"), "utf8");

    const seen = [];
    const result = checkAgentIntegrations({
      fs,
      prefs: {},
      descriptors: [descriptor],
      server: null,
      platform: "win32",
      validateCommand: (command) => {
        seen.push(command);
        return {
          ok: true,
          nodeBin: "C:\\Program Files\\nodejs\\node.exe",
          scriptPath: "D:/app/hooks/codex-hook.js",
        };
      },
    });

    assert.deepStrictEqual(seen, [psForm]);
    assert.strictEqual(result.details[0].status, "ok");
  });

  it("validates the POSIX command field for dual-field Codex entries off win32", () => {
    const descriptor = codexDescriptor();
    const psForm = '& "C:\\Program Files\\nodejs\\node.exe" "D:/app/hooks/codex-hook.js"';
    const interopForm = '"/mnt/c/Program Files/nodejs/node.exe" "D:/app/hooks/codex-hook.js"';
    const settings = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: interopForm, commandWindows: psForm, timeout: 30 }] }],
      },
    };
    writeJson(descriptor.configPath, settings);
    fs.writeFileSync(descriptor.supplementary.configPath, codexTrustState(descriptor, settings, "linux"), "utf8");

    const seen = [];
    const result = checkAgentIntegrations({
      fs,
      prefs: {},
      descriptors: [descriptor],
      server: null,
      platform: "linux",
      validateCommand: (command) => {
        seen.push(command);
        return { ok: true, nodeBin: "/mnt/c/Program Files/nodejs/node.exe", scriptPath: "D:/app/hooks/codex-hook.js" };
      },
    });

    assert.deepStrictEqual(seen, [interopForm]);
    assert.strictEqual(result.details[0].status, "ok");
  });

  it("reports a corrupt Codex stable-launcher manifest as repairable", () => {
    const descriptor = codexDescriptor();
    const target = path.join(descriptor.parentDir, "source", "codex-hook.js");
    writeText(target, "process.stdout.write('{}');\n");
    const stable = materializeStableCodexHookLauncher(target, {
      codexDir: descriptor.parentDir,
      nodeBin: process.execPath,
      platform: process.platform,
    });
    const command = buildStableCodexHookCommand(stable.launcherPath, process.platform);
    const settings = {
      hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 30 }] }] },
    };
    writeJson(descriptor.configPath, settings);
    fs.writeFileSync(
      descriptor.supplementary.configPath,
      codexTrustState(descriptor, settings, process.platform),
      "utf8"
    );
    fs.writeFileSync(stable.manifestPath, "{ corrupt", "utf8");

    const detail = runOne(descriptor, {
      platform: process.platform,
      validateTarget: validateHookTarget,
    });

    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.hookCommandIssue, "stable-manifest-invalid");
    assert.strictEqual(detail.scriptPath, stable.launcherPath);
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "codex" });
  });

  it("reports a missing Codex stable-launcher target as repairable", () => {
    const descriptor = codexDescriptor();
    const target = path.join(descriptor.parentDir, "source", "codex-hook.js");
    writeText(target, "process.stdout.write('{}');\n");
    const stable = materializeStableCodexHookLauncher(target, {
      codexDir: descriptor.parentDir,
      nodeBin: process.execPath,
      platform: process.platform,
    });
    const command = buildStableCodexHookCommand(stable.launcherPath, process.platform);
    const settings = {
      hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 30 }] }] },
    };
    writeJson(descriptor.configPath, settings);
    fs.writeFileSync(
      descriptor.supplementary.configPath,
      codexTrustState(descriptor, settings, process.platform),
      "utf8"
    );
    fs.unlinkSync(target);

    const detail = runOne(descriptor, {
      platform: process.platform,
      validateTarget: validateHookTarget,
    });

    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.hookCommandIssue, "scriptPath-missing");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "codex" });
  });

  it("reports Codex hooks=false even when hook registration is missing", () => {
    const descriptor = codexDescriptor();
    writeJson(descriptor.configPath, { hooks: {} });
    fs.writeFileSync(descriptor.supplementary.configPath, "[features]\nhooks = false\n", "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.deepStrictEqual(detail.supplementary, {
      key: "hooks",
      value: "disabled",
      detail: "hooks=false",
    });
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
    const settings = codexHooksConfig(events);
    writeJson(descriptor.configPath, settings);
    fs.writeFileSync(descriptor.supplementary.configPath, codexTrustState(descriptor, settings), "utf8");

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

  it("surfaces WHICH shared family file is missing in the broken-path detail", () => {
    const root = makeTempDir();
    const parentDir = path.join(root, ".config", "opencode");
    const hooksDir = path.join(root, "hooks");
    const pluginPath = path.join(hooksDir, "opencode-plugin");
    const familyDir = path.join(hooksDir, "opencode-family-plugin");
    // Entry + core present, session-ids MISSING — the packaging false-green
    // scenario the two-level closure check exists for (plan §3.4).
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, "index.mjs"), "export default async () => ({});\n", "utf8");
    fs.mkdirSync(familyDir, { recursive: true });
    fs.writeFileSync(path.join(familyDir, "core.mjs"), "export function createOpencodeFamilyPlugin() {}\n", "utf8");

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
    assert.strictEqual(detail.opencodeEntryIssue, "family-core-missing");
    // The modal renders detail verbatim (no i18n layer) — the user must see
    // a readable phrase AND the concrete missing path, not the raw key.
    assert.match(detail.detail, /shared opencode-family file/);
    assert.ok(
      detail.detail.includes(path.join(familyDir, "session-ids.mjs")),
      `detail should name the missing file: ${detail.detail}`
    );
  });

  function makeValidFamilyPlugin(root, pluginDirName) {
    const hooksDir = path.join(root, "hooks");
    const pluginPath = path.join(hooksDir, pluginDirName);
    const familyDir = path.join(hooksDir, "opencode-family-plugin");
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, "index.mjs"), "export default async () => ({});\n", "utf8");
    fs.mkdirSync(familyDir, { recursive: true });
    fs.writeFileSync(path.join(familyDir, "core.mjs"), "export function createOpencodeFamilyPlugin() {}\n", "utf8");
    fs.writeFileSync(path.join(familyDir, "session-ids.mjs"), "export function createSessionIdHelpers() {}\n", "utf8");
    return pluginPath;
  }

  function mimocodeDescriptor(root, overrides = {}) {
    const parentDir = path.join(root, ".config", "mimocode");
    fs.mkdirSync(parentDir, { recursive: true });
    return baseDescriptor({
      agentId: "mimocode",
      marker: "mimocode-plugin",
      parentDir,
      configPath: path.join(parentDir, "mimocode.jsonc"),
      detection: "opencode-plugin",
      configJsonc: true,
      ...overrides,
    });
  }

  it("parses mimocode's JSONC config (comments + trailing commas) as healthy, not config-corrupt", () => {
    const root = makeTempDir();
    const pluginPath = makeValidFamilyPlugin(root, "mimocode-plugin");
    const descriptor = mimocodeDescriptor(root);
    fs.writeFileSync(
      descriptor.configPath,
      `{\n  // Clawd pet plugin\n  "plugin": [\n    ${JSON.stringify(pluginPath)},\n  ],\n}\n`,
      "utf8"
    );

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok", `expected ok, got ${detail.status}: ${detail.detail}`);
  });

  it("still reports genuinely corrupt mimocode JSONC as config-corrupt", () => {
    const root = makeTempDir();
    const descriptor = mimocodeDescriptor(root);
    fs.writeFileSync(descriptor.configPath, '{\n  "plugin": [\n', "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "config-corrupt");
    assert.match(detail.detail, /invalid JSONC/);
  });

  it("routes ONLY configJsonc descriptors through the JSONC parser", () => {
    // Without the flag, the same commented config must fail JSON.parse — this
    // locks the routing to the descriptor flag rather than a blanket parser
    // swap (opencode.json stays strict JSON).
    const root = makeTempDir();
    const descriptor = mimocodeDescriptor(root, { configJsonc: undefined });
    fs.writeFileSync(descriptor.configPath, '{\n  // comment\n  "plugin": [],\n}\n', "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "config-corrupt");
  });

  function mimocodeMergedDescriptor(root, overrides = {}) {
    const parentDir = path.join(root, ".config", "mimocode");
    return mimocodeDescriptor(root, {
      configCandidates: ["mimocode.jsonc", "mimocode.json", "config.json"].map((name) => path.join(parentDir, name)),
      ...overrides,
    });
  }

  it("merged view: validates the live plugin owner (.json) when .jsonc exists without plugin", () => {
    const root = makeTempDir();
    const pluginPath = makeValidFamilyPlugin(root, "mimocode-plugin");
    const descriptor = mimocodeMergedDescriptor(root);
    fs.writeFileSync(path.join(path.dirname(descriptor.configPath), "mimocode.json"), JSON.stringify({ plugin: [pluginPath] }), "utf8");
    fs.writeFileSync(descriptor.configPath, '{\n  // prefs only\n  "model": "mimo/base",\n}\n', "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok", `expected ok, got ${detail.status}: ${detail.detail}`);
    assert.ok(detail.configPath.endsWith("mimocode.json"), "detail must point at the file whose plugin is live");
  });

  it("merged view: a managed entry MASKED by a higher-priority plugin array is not connected", () => {
    const root = makeTempDir();
    const pluginPath = makeValidFamilyPlugin(root, "mimocode-plugin");
    const descriptor = mimocodeMergedDescriptor(root);
    // .jsonc declares plugin (empty) → it REPLACES .json's array at runtime,
    // so the valid entry in .json is dead. The doctor must see the merge.
    fs.writeFileSync(descriptor.configPath, '{\n  "plugin": [],\n}\n', "utf8");
    fs.writeFileSync(path.join(path.dirname(descriptor.configPath), "mimocode.json"), JSON.stringify({ plugin: [pluginPath] }), "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected", `masked entry must not count: ${detail.detail}`);
  });

  it("merged view: no candidate exists → not-connected missing", () => {
    const root = makeTempDir();
    const descriptor = mimocodeMergedDescriptor(root);
    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.configFileExists, false);
  });

  it("merged view: a corrupt candidate is config-corrupt and names the file", () => {
    const root = makeTempDir();
    const descriptor = mimocodeMergedDescriptor(root);
    fs.writeFileSync(descriptor.configPath, '{\n  "plugin": [],\n}\n', "utf8");
    fs.writeFileSync(path.join(path.dirname(descriptor.configPath), "mimocode.json"), "{ broken", "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "config-corrupt");
    assert.ok(detail.detail.includes("mimocode.json"), `detail must name the corrupt file: ${detail.detail}`);
  });

  // #825: opencode's global config is a MERGE of config.json → opencode.json →
  // opencode.jsonc (later wins, "plugin" arrays REPLACED). The doctor must
  // validate the MERGED effective view — reading opencode.json alone reported
  // "plugin entry verified" while opencode was actually running the .jsonc
  // array with no Clawd plugin in it.
  function opencodeDescriptor(root, overrides = {}) {
    const parentDir = path.join(root, ".config", "opencode");
    fs.mkdirSync(parentDir, { recursive: true });
    return baseDescriptor({
      agentId: "opencode",
      marker: "opencode-plugin",
      parentDir,
      configPath: path.join(parentDir, "opencode.json"),
      detection: "opencode-plugin",
      configJsonc: true,
      configCandidates: ["opencode.jsonc", "opencode.json", "config.json"].map((n) => path.join(parentDir, n)),
      ...overrides,
    });
  }

  it("#825: reports NOT connected when opencode.jsonc masks a plugin entry in opencode.json", () => {
    const root = makeTempDir();
    const pluginPath = makeValidFamilyPlugin(root, "opencode-plugin");
    const descriptor = opencodeDescriptor(root);
    const dir = descriptor.parentDir;
    writeJson(path.join(dir, "opencode.json"), { plugin: [pluginPath] });
    writeText(path.join(dir, "opencode.jsonc"), '{\n  // the file opencode runs\n  "plugin": ["@vendor/other"],\n}\n');

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected", `expected not-connected, got ${detail.status}: ${detail.detail}`);
    assert.ok(
      detail.detail.includes("opencode.jsonc"),
      `detail must name the file opencode actually reads, got: ${detail.detail}`
    );
  });

  it("#825: reports ok when the plugin entry lives in the winning opencode.jsonc", () => {
    const root = makeTempDir();
    const pluginPath = makeValidFamilyPlugin(root, "opencode-plugin");
    const descriptor = opencodeDescriptor(root);
    const dir = descriptor.parentDir;
    writeJson(path.join(dir, "opencode.json"), { plugin: ["@vendor/other"] });
    writeText(path.join(dir, "opencode.jsonc"), `{\n  // live\n  "plugin": [${JSON.stringify(pluginPath)}],\n}\n`);

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok", `expected ok, got ${detail.status}: ${detail.detail}`);
    assert.ok(detail.detail.includes("opencode.jsonc"));
  });

  it("#825: honors opencode.json when a higher-priority opencode.jsonc declares NO plugin key", () => {
    // The discriminating case: .jsonc is the highest-priority EXISTING file but
    // does not declare "plugin", so opencode still runs .json's array. Picking
    // "first existing" instead of "first that declares plugin" would report a
    // healthy install as not-connected.
    const root = makeTempDir();
    const pluginPath = makeValidFamilyPlugin(root, "opencode-plugin");
    const descriptor = opencodeDescriptor(root);
    const dir = descriptor.parentDir;
    writeJson(path.join(dir, "opencode.json"), { plugin: [pluginPath] });
    writeText(path.join(dir, "opencode.jsonc"), '{\n  // model prefs only — no plugin key\n  "model": "anthropic/claude-sonnet-4-6",\n}\n');

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok", `expected ok, got ${detail.status}: ${detail.detail}`);
    assert.ok(
      detail.detail.includes("opencode.json") && !detail.detail.includes("opencode.jsonc"),
      `detail must name the live owner opencode.json, got: ${detail.detail}`
    );
  });

  it("#825: single opencode.json installs keep reporting ok (no regression)", () => {
    const root = makeTempDir();
    const pluginPath = makeValidFamilyPlugin(root, "opencode-plugin");
    const descriptor = opencodeDescriptor(root);
    writeJson(path.join(descriptor.parentDir, "opencode.json"), { plugin: [pluginPath] });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok", `expected ok, got ${detail.status}: ${detail.detail}`);
    assert.ok(detail.detail.includes("opencode.json"));
  });

  it("#825: a commented opencode.json is healthy, not config-corrupt", () => {
    const root = makeTempDir();
    const pluginPath = makeValidFamilyPlugin(root, "opencode-plugin");
    const descriptor = opencodeDescriptor(root);
    writeText(
      path.join(descriptor.parentDir, "opencode.json"),
      `{\n  // opencode parses .json with a JSONC reader too\n  "plugin": [${JSON.stringify(pluginPath)}],\n}\n`
    );

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok", `expected ok, got ${detail.status}: ${detail.detail}`);
  });

  it("descriptor configJsonc matches the family registry's jsonc flag (drift lock)", () => {
    // eslint-disable-next-line global-require
    const { AGENT_DESCRIPTORS } = require("../src/doctor-detectors/agent-descriptors");
    // eslint-disable-next-line global-require
    const { OPENCODE_FAMILY } = require("../agents/opencode-family");
    for (const [agentId, cfg] of Object.entries(OPENCODE_FAMILY)) {
      const descriptor = AGENT_DESCRIPTORS.find((d) => d.agentId === agentId);
      assert.ok(descriptor, `family member ${agentId} must have a doctor descriptor`);
      assert.strictEqual(
        !!descriptor.configJsonc,
        !!cfg.jsonc,
        `${agentId}: doctor descriptor configJsonc must mirror the registry's jsonc flag`
      );
      assert.ok(
        descriptor.configPath.endsWith(cfg.configFileName),
        `${agentId}: descriptor configPath must target ${cfg.configFileName}`
      );
      if (cfg.configCandidates) {
        assert.deepStrictEqual(
          (descriptor.configCandidates || []).map((p) => path.basename(p)),
          [...cfg.configCandidates],
          `${agentId}: descriptor configCandidates must mirror the registry (order matters — highest priority first)`
        );
      }
      // marker feeds the plugin-entry basename match; detection routes into
      // the family validator — a drift in either silently breaks the doctor
      // for a healthy install (R8 P2).
      assert.strictEqual(
        descriptor.marker,
        cfg.pluginDirName,
        `${agentId}: descriptor marker must equal the registry pluginDirName`
      );
      assert.strictEqual(
        descriptor.detection,
        "opencode-plugin",
        `${agentId}: family members must route through the opencode-plugin validator`
      );
    }
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

  it("aggregates all-info states as pass (no false critical) when nothing is active", () => {
    // none-global agents (info status `manual-only`) + missing agents only.
    // Every integration being disabled / manual / not installed is a user or
    // environment choice, not a fault, so the summary must stay green (#490).
    const result = checkAgentIntegrations({
      fs,
      descriptors: [
        baseDescriptor({ agentId: "hypothetical-none-global", configMode: "none-global" }),
        baseDescriptor({ agentId: "missing-agent" }),
      ],
    });
    assert.strictEqual(result.status, "pass");
    assert.strictEqual(result.level, null);
  });

  it("stays warning when a real problem coexists with info-only integrations", () => {
    // One auto-install agent with a missing config (not-connected → warning)
    // plus a disabled agent (info). The warning must still drive the summary;
    // the #490 de-escalation only applies when nothing is actually wrong.
    const brokenDescriptor = baseDescriptor({ agentId: "broken-agent", marker: "broken-hook.js" });
    fs.mkdirSync(brokenDescriptor.parentDir, { recursive: true });
    const disabledDescriptor = baseDescriptor({ agentId: "off-agent", marker: "off-hook.js" });

    const result = checkAgentIntegrations({
      fs,
      prefs: { agents: { "off-agent": { enabled: false } } },
      descriptors: [brokenDescriptor, disabledDescriptor],
    });

    assert.strictEqual(result.status, "warning");
    assert.strictEqual(result.level, "warning");
    assert.strictEqual(result.warningCount, 1);
    assert.strictEqual(result.okCount, 0);
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

// Legacy-supplement checks: the generic command check only asserts "some
// command exists and its script resolves"; these pin the completeness layer
// (13 events + consistent --permission-mode flag) that the suspect-default
// work depends on.
describe("kimi legacy permission-mode supplement", () => {
  function kimiDescriptor() {
    const root = makeTempDir();
    const legacyDir = path.join(root, ".kimi");
    const kimiCodeDir = path.join(root, ".kimi-code");
    return {
      descriptor: baseDescriptor({
        agentId: "kimi-cli",
        marker: "kimi-hook.js",
        configMode: "toml-text",
        parentDir: legacyDir,
        configPath: path.join(legacyDir, "config.toml"),
        configTargets: [
          { label: "kimi-code", parentDir: kimiCodeDir, configPath: path.join(kimiCodeDir, "config.toml") },
          { label: "legacy", parentDir: legacyDir, configPath: path.join(legacyDir, "config.toml") },
        ],
      }),
      legacyDir,
      kimiCodeDir,
    };
  }

  it("a complete argv-mode legacy install stays ok (explicit is a valid user choice too)", () => {
    const { descriptor, legacyDir } = kimiDescriptor();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(descriptor.configPath, kimiLegacyToml(), "utf8");
    assert.strictEqual(runOne(descriptor).status, "ok");

    fs.writeFileSync(
      descriptor.configPath,
      kimiLegacyToml({ command: '"node" "/app/hooks/kimi-hook.js" --permission-mode=explicit' }),
      "utf8"
    );
    assert.strictEqual(runOne(descriptor).status, "ok");
  });

  it("flags the retired env-prefix form even when the active kimi-code target is healthy", () => {
    const { descriptor, legacyDir, kimiCodeDir } = kimiDescriptor();
    fs.mkdirSync(kimiCodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(kimiCodeDir, "config.toml"),
      '[[hooks]]\nevent = "PermissionRequest"\ncommand = \'"node" "/app/hooks/kimi-hook.js"\'\nmatcher = ""\ntimeout = 30\n',
      "utf8"
    );
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      descriptor.configPath,
      kimiLegacyToml({ command: 'CLAWD_KIMI_PERMISSION_MODE=suspect "node" "/app/hooks/kimi-hook.js"' }),
      "utf8"
    );

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "needs-review");
    assert.ok(detail.detail.includes("retired env-prefix"));
    assert.deepStrictEqual(detail.supplementary, { key: "kimi_legacy_mode", value: "stale" });
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "kimi-cli" });
  });

  it("flags a command carrying BOTH the retired prefix and a valid argv flag (dead on Windows despite the flag)", () => {
    const { descriptor, legacyDir } = kimiDescriptor();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      descriptor.configPath,
      kimiLegacyToml({ command: 'CLAWD_KIMI_PERMISSION_MODE=explicit "node" "/app/hooks/kimi-hook.js" --permission-mode=suspect' }),
      "utf8"
    );

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "needs-review");
    assert.ok(detail.detail.includes("retired env-prefix"));
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "kimi-cli" });
  });

  it("flags missing --permission-mode flags on an otherwise valid legacy install", () => {
    const { descriptor, legacyDir } = kimiDescriptor();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      descriptor.configPath,
      kimiLegacyToml({ command: '"node" "/app/hooks/kimi-hook.js"' }),
      "utf8"
    );

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "needs-review");
    assert.ok(detail.detail.includes("--permission-mode flag"));
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "kimi-cli" });
  });

  it("flags an incomplete event set — only-Stop-registered no longer passes as healthy", () => {
    const { descriptor, legacyDir } = kimiDescriptor();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      descriptor.configPath,
      kimiLegacyToml({ events: ["Stop"] }),
      "utf8"
    );

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "needs-review");
    assert.ok(detail.detail.includes("missing hook events"));
    assert.ok(detail.detail.includes("PreToolUse"));
  });

  it("flags inconsistent mode values across commands", () => {
    const { descriptor, legacyDir } = kimiDescriptor();
    fs.mkdirSync(legacyDir, { recursive: true });
    const mixed = kimiLegacyToml().replace(
      "--permission-mode=suspect'",
      "--permission-mode=explicit'"
    );
    fs.writeFileSync(descriptor.configPath, mixed, "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "needs-review");
    assert.ok(detail.detail.includes("inconsistent --permission-mode"));
  });

  it("never masks a primary finding and skips when legacy carries no Clawd hooks", () => {
    const { descriptor, legacyDir, kimiCodeDir } = kimiDescriptor();
    // Primary finding: legacy active, config missing entirely.
    fs.mkdirSync(legacyDir, { recursive: true });
    const missing = runOne(descriptor);
    assert.strictEqual(missing.status, "not-connected");

    // kimi-code healthy + legacy dir exists but has no Clawd hooks: the
    // supplement must not invent a warning for a deliberate non-install.
    fs.mkdirSync(kimiCodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(kimiCodeDir, "config.toml"),
      '[[hooks]]\nevent = "PermissionRequest"\ncommand = \'"node" "/app/hooks/kimi-hook.js"\'\nmatcher = ""\ntimeout = 30\n',
      "utf8"
    );
    fs.writeFileSync(descriptor.configPath, 'default_model = "kimi-for-coding"\n', "utf8");
    const clean = runOne(descriptor);
    assert.strictEqual(clean.status, "ok");
  });
});
