"use strict";

const path = require("path");
const { getAgent } = require("../../agents/registry");
const { getFamilyConfig } = require("../../agents/opencode-family");

const claude = require("../../hooks/install");
const codex = require("../../hooks/codex-install");
const copilot = require("../../hooks/copilot-install");
const cursor = require("../../hooks/cursor-install");
const gemini = require("../../hooks/gemini-install");
const antigravity = require("../../hooks/antigravity-install");
const codebuddy = require("../../hooks/codebuddy-install");
const kiro = require("../../hooks/kiro-install");
const kimi = require("../../hooks/kimi-install");
const qwen = require("../../hooks/qwen-code-install");
const zcode = require("../../hooks/zcode-install");
const codewhale = require("../../hooks/codewhale-install");
const opencode = require("../../hooks/opencode-install");
const mimocode = require("../../hooks/mimocode-install");
const pi = require("../../hooks/pi-install");
const openclaw = require("../../hooks/openclaw-install");
const hermes = require("../../hooks/hermes-install");
const qoder = require("../../hooks/qoder-install");
const reasonix = require("../../hooks/reasonix-install");
const qoderwork = require("../../hooks/qoderwork-install");
const qwenwork = require("../../hooks/qwenwork-install");
const workbuddy = require("../../hooks/workbuddy-install");
const traecode = require("../../hooks/traecode-install");
const dsh = require("../../hooks/dsh-install");

function agentName(agentId) {
  const agent = getAgent(agentId);
  return agent && agent.name ? agent.name : agentId;
}

function agentEventSource(agentId) {
  const agent = getAgent(agentId);
  return agent && agent.eventSource ? agent.eventSource : "hook";
}

const AGENT_DESCRIPTORS = Object.freeze([
  Object.freeze({
    agentId: "claude-code",
    agentName: agentName("claude-code"),
    eventSource: agentEventSource("claude-code"),
    parentDir: claude.DEFAULT_PARENT_DIR,
    configPath: claude.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: "clawd-hook.js",
    nested: true,
  }),
  Object.freeze({
    agentId: "codex",
    agentName: agentName("codex"),
    eventSource: agentEventSource("codex"),
    parentDir: codex.DEFAULT_PARENT_DIR,
    configPath: codex.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: "codex-hook.js",
    nested: true,
    supplementary: {
      key: "hooks",
      configPath: codex.DEFAULT_FEATURES_CONFIG,
    },
  }),
  Object.freeze({
    agentId: "copilot-cli",
    agentName: agentName("copilot-cli"),
    eventSource: agentEventSource("copilot-cli"),
    parentDir: copilot.resolveCopilotHome(),
    configPath: copilot.resolveCopilotHooksPath(),
    settingsPath: copilot.resolveCopilotSettingsPath(),
    configMode: "copilot-hooks",
    autoInstall: true,
    marker: copilot.MARKER,
    hookEvents: copilot.COPILOT_HOOK_EVENTS,
    scriptPath: path.join(__dirname, "..", "..", "hooks", "copilot-hook.js"),
  }),
  Object.freeze({
    agentId: "cursor-agent",
    agentName: agentName("cursor-agent"),
    eventSource: agentEventSource("cursor-agent"),
    parentDir: cursor.DEFAULT_PARENT_DIR,
    configPath: cursor.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: "cursor-hook.js",
    nested: false,
  }),
  Object.freeze({
    agentId: "gemini-cli",
    agentName: agentName("gemini-cli"),
    eventSource: agentEventSource("gemini-cli"),
    parentDir: gemini.DEFAULT_PARENT_DIR,
    configPath: gemini.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: "gemini-hook.js",
    nested: true,
  }),
  Object.freeze({
    agentId: "antigravity-cli",
    agentName: agentName("antigravity-cli"),
    eventSource: agentEventSource("antigravity-cli"),
    parentDir: antigravity.DEFAULT_PARENT_DIR,
    configPath: antigravity.DEFAULT_CONFIG_PATH,
    configMode: "antigravity-hooks",
    autoInstall: true,
    marker: antigravity.MARKER,
    hookEvents: antigravity.ANTIGRAVITY_HOOK_EVENTS,
  }),
  Object.freeze({
    agentId: "codebuddy",
    agentName: agentName("codebuddy"),
    eventSource: agentEventSource("codebuddy"),
    parentDir: codebuddy.DEFAULT_PARENT_DIR,
    configPath: codebuddy.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: "codebuddy-hook.js",
    nested: true,
  }),
  Object.freeze({
    agentId: "workbuddy",
    agentName: agentName("workbuddy"),
    eventSource: agentEventSource("workbuddy"),
    parentDir: workbuddy.DEFAULT_PARENT_DIR,
    configPath: workbuddy.DEFAULT_CONFIG_PATH,
    // Current WorkBuddy AI uses ~/.workbuddy-ai, while older WorkBuddy builds
    // used ~/.workbuddy. Prefer the current generation when both exist; the
    // legacy directory may still exist solely to hold WorkBuddy-managed
    // toolchain binaries and is not proof that its settings.json is active.
    configTargets: Object.freeze([
      Object.freeze({
        label: "workbuddy-ai",
        parentDir: workbuddy.CURRENT_PARENT_DIR,
        configPath: workbuddy.CURRENT_CONFIG_PATH,
      }),
      Object.freeze({
        label: "legacy",
        parentDir: workbuddy.LEGACY_PARENT_DIR,
        configPath: workbuddy.LEGACY_CONFIG_PATH,
      }),
    ]),
    configMode: "file",
    autoInstall: true,
    marker: workbuddy.MARKER,
    nested: true,
    hookEvents: workbuddy.WORKBUDDY_HOOK_EVENTS,
  }),
  Object.freeze({
    agentId: "kiro-cli",
    agentName: agentName("kiro-cli"),
    eventSource: agentEventSource("kiro-cli"),
    parentDir: kiro.DEFAULT_PARENT_DIR,
    configPath: kiro.DEFAULT_AGENTS_DIR,
    configMode: "dir",
    autoInstall: true,
    marker: "kiro-hook.js",
    nested: true,
  }),
  Object.freeze({
    agentId: "kimi-cli",
    agentName: agentName("kimi-cli"),
    eventSource: agentEventSource("kimi-cli"),
    parentDir: kimi.DEFAULT_PARENT_DIR,
    configPath: kimi.DEFAULT_CONFIG_PATH,
    // #563: the agent spans two generations with separate homes. Ordered by
    // priority — doctor reports the first target whose directory exists, so
    // a machine with both installed is judged by the modern kimi-code config.
    configTargets: Object.freeze([
      Object.freeze({
        label: "kimi-code",
        parentDir: kimi.KIMI_CODE_PARENT_DIR,
        configPath: kimi.KIMI_CODE_CONFIG_PATH,
      }),
      Object.freeze({
        label: "legacy",
        parentDir: kimi.DEFAULT_PARENT_DIR,
        configPath: kimi.DEFAULT_CONFIG_PATH,
      }),
    ]),
    configMode: "toml-text",
    autoInstall: true,
    marker: "kimi-hook.js",
  }),
  Object.freeze({
    agentId: "qwen-code",
    agentName: agentName("qwen-code"),
    eventSource: agentEventSource("qwen-code"),
    parentDir: qwen.DEFAULT_PARENT_DIR,
    configPath: qwen.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: qwen.MARKER,
    nested: true,
    hookEvents: qwen.QWEN_CODE_HOOK_EVENTS,
  }),
  Object.freeze({
    agentId: "zcode",
    agentName: agentName("zcode"),
    eventSource: agentEventSource("zcode"),
    parentDir: zcode.DEFAULT_PARENT_DIR,
    configPath: zcode.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: zcode.MARKER,
    nested: true,
    hookEvents: zcode.ZCODE_HOOK_EVENTS,
    hookExecutorShape: "zcode-process",
    processHookTimeoutMsForEvent: zcode.timeoutMsForZcodeEvent,
    // ZCode config-file hooks nest under hooks.events.* (NOT hooks.* like the
    // Claude/Qwen settings.json schema). Generic findHookCommandsForEvent reads
    // this to locate the per-event arrays; without it the doctor would scan the
    // wrong container and always report not-connected.
    hookEventsContainer: ["hooks", "events"],
  }),
  Object.freeze({
    agentId: "codewhale",
    agentName: agentName("codewhale"),
    eventSource: agentEventSource("codewhale"),
    parentDir: path.dirname(codewhale.resolveCodewhaleConfigPath()),
    configPath: codewhale.resolveCodewhaleConfigPath(),
    configMode: "codewhale-hooks-toml",
    autoInstall: true,
    marker: "managed by clawd-on-desk",
    commandMarker: "codewhale-hook.js",
    nested: true,
    hookEvents: codewhale.HOOK_ENTRIES.map((entry) => entry[0]),
  }),
  Object.freeze({
    agentId: "opencode",
    agentName: agentName("opencode"),
    eventSource: agentEventSource("opencode"),
    parentDir: opencode.DEFAULT_PARENT_DIR,
    configPath: opencode.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    // opencode registers a plugin directory, not a command hook script.
    // Detection matches an absolute plugin entry by basename.
    //
    // #825: the global config is a MERGE of config.json → opencode.json →
    // opencode.jsonc (later wins, "plugin" arrays REPLACED not concatenated).
    // configJsonc routes reads through the JSONC parser so a commented config
    // is not misreported as config-corrupt; configCandidates (highest-priority
    // first, from the family registry) makes the doctor validate the MERGED
    // effective plugin view instead of opencode.json alone — otherwise it
    // reports "plugin entry verified" while opencode runs the .jsonc array.
    configJsonc: true,
    configCandidates: Object.freeze(
      getFamilyConfig("opencode").configCandidates.map((name) => path.join(opencode.DEFAULT_PARENT_DIR, name))
    ),
    marker: "opencode-plugin",
    detection: "opencode-plugin",
  }),
  Object.freeze({
    agentId: "mimocode",
    agentName: agentName("mimocode"),
    eventSource: agentEventSource("mimocode"),
    parentDir: mimocode.DEFAULT_PARENT_DIR,
    configPath: mimocode.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    // mimocode is an opencode-family member and shares the same plugin
    // loader contract. Detection reuses the opencode-plugin validator path;
    // configJsonc routes reads through the JSONC parser so a commented
    // config is not misreported as config-corrupt, and configCandidates
    // (highest-priority first, from the family registry) makes the doctor
    // validate the MERGED effective plugin view rather than one fixed file.
    configJsonc: true,
    configCandidates: Object.freeze(
      getFamilyConfig("mimocode").configCandidates.map((name) => path.join(mimocode.DEFAULT_PARENT_DIR, name))
    ),
    // marker derives from the registry: it feeds the plugin-entry basename
    // match, so a drifted literal would report a healthy install as
    // not-connected (R8 P2).
    marker: getFamilyConfig("mimocode").pluginDirName,
    detection: "opencode-plugin",
  }),
  Object.freeze({
    agentId: "pi",
    agentName: agentName("pi"),
    eventSource: agentEventSource("pi"),
    parentDir: pi.DEFAULT_PARENT_DIR,
    configPath: pi.DEFAULT_EXTENSION_DIR,
    configMode: "pi-extension",
    autoInstall: true,
    marker: pi.EXTENSION_FILE,
    coreFile: pi.CORE_FILE,
    markerFile: pi.MARKER_FILE,
  }),
  Object.freeze({
    agentId: "openclaw",
    agentName: agentName("openclaw"),
    eventSource: agentEventSource("openclaw"),
    parentDir: openclaw.DEFAULT_STATE_DIR,
    configPath: openclaw.DEFAULT_CONFIG_PATH,
    configMode: "openclaw-plugin",
    autoInstall: true,
    marker: openclaw.PLUGIN_DIR_NAME,
    pluginId: openclaw.PLUGIN_ID,
    detection: "openclaw-plugin",
  }),
  Object.freeze({
    agentId: "hermes",
    agentName: agentName("hermes"),
    eventSource: agentEventSource("hermes"),
    parentDir: hermes.resolveHermesHome(),
    configPath: path.join(hermes.resolveHermesHome(), "plugins", hermes.PLUGIN_ID),
    configMode: "plugin-dir",
    autoInstall: true,
    marker: hermes.PLUGIN_ID,
    managedFiles: hermes.MANAGED_PLUGIN_FILES,
    configFilePath: path.join(hermes.resolveHermesHome(), "config.yaml"),
  }),
  Object.freeze({
    agentId: "qoder",
    agentName: agentName("qoder"),
    eventSource: agentEventSource("qoder"),
    parentDir: qoder.DEFAULT_PARENT_DIR,
    configPath: qoder.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: qoder.MARKER,
    nested: true,
    hookEvents: qoder.QODER_HOOK_EVENTS,
    hookGroupId: "clawd",
  }),
  Object.freeze({
    agentId: "reasonix",
    agentName: agentName("reasonix"),
    eventSource: agentEventSource("reasonix"),
    parentDir: reasonix.DEFAULT_PARENT_DIR,
    configPath: reasonix.DEFAULT_CONFIG_PATH,
    configTargets: reasonix.DEFAULT_CONFIG_TARGETS,
    preferExistingConfigFile: true,
    configMode: "file",
    autoInstall: true,
    marker: reasonix.MARKER,
    nested: true,
    hookEvents: reasonix.REASONIX_HOOK_EVENTS,
  }),
  Object.freeze({
    agentId: "qoderwork",
    agentName: agentName("qoderwork"),
    eventSource: agentEventSource("qoderwork"),
    parentDir: qoderwork.DEFAULT_PARENT_DIR,
    configPath: qoderwork.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: qoderwork.MARKER,
    nested: true,
    hookEvents: qoderwork.QODERWORK_HOOK_EVENTS,
    hookGroupId: "clawd",
  }),
  Object.freeze({
    agentId: "traecode",
    agentName: agentName("traecode"),
    eventSource: agentEventSource("traecode"),
    parentDir: traecode.DEFAULT_PARENT_DIR,
    configPath: traecode.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: traecode.MARKER,
    nested: true,
    hookEvents: traecode.TRAECODE_HOOK_EVENTS,
  }),
  Object.freeze({
    agentId: "qwenwork",
    agentName: agentName("qwenwork"),
    eventSource: agentEventSource("qwenwork"),
    parentDir: qwenwork.DEFAULT_PARENT_DIR,
    configPath: qwenwork.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: qwenwork.MARKER,
    nested: true,
    hookEvents: qwenwork.QWENWORK_HOOK_EVENTS,
    hookGroupId: "clawd",
  }),
  Object.freeze({
    agentId: "deepseek-harness",
    agentName: agentName("deepseek-harness"),
    eventSource: agentEventSource("deepseek-harness"),
    parentDir: dsh.resolveDshHome(),
    configPath: dsh.resolveDshProfileDir(dsh.resolveDshHome()),
    configMode: "dsh-plugin",
    autoInstall: true,
    detection: "dsh",
  }),
]);

function getAgentDescriptors() {
  return AGENT_DESCRIPTORS.map((descriptor) => ({ ...descriptor }));
}

function getAgentDescriptor(agentId) {
  const descriptor = AGENT_DESCRIPTORS.find((entry) => entry.agentId === agentId);
  return descriptor ? { ...descriptor } : null;
}

module.exports = {
  AGENT_DESCRIPTORS,
  getAgentDescriptors,
  getAgentDescriptor,
};
