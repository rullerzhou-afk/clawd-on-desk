// opencode-family registry — single source of truth for opencode-derived
// runtimes that integrate via the shared family plugin / installer /
// permission path (see docs/project/agent-runtime-architecture.md).
//
// Membership is an EXPLICIT allowlist. Never infer it from
// eventSource === "plugin-event": openclaw and hermes also declare that
// eventSource but use entirely different plugin shapes and must stay
// independent. Joining the family requires satisfying the full opencode wire
// contract (session.* / message.part.updated event shapes, permission.asked
// payload, once/always/reject reply vocabulary, Bun CLI/TUI or Node Desktop
// runtime with a loopback reverse bridge,
// ctx.{client,serverUrl,directory} init, in-process plugin execution).
//
// NOTE for the plugin side: hooks/opencode-family-plugin/core.mjs runs inside
// the host process and cannot require this CJS module. Plugin entries
// pass their four identity params as literals; test/registry cross-checks
// assert the literals match this registry so they cannot drift.

const OPENCODE_FAMILY = Object.freeze({
  // #825: opencode's GLOBAL config is a merge of three files —
  // config.json → opencode.json → opencode.jsonc, later wins — and array
  // fields like "plugin" are REPLACED by the later file, not concatenated.
  // Upstream config.ts loadGlobal() collapses the three with a bare remeda
  // mergeDeep (arrays are not plain objects, so they are overwritten) and,
  // unlike project-level configs, never routes them through the
  // plugin_origins union. Verified against opencode 1.18.3 with an isolated
  // XDG_CONFIG_HOME + `opencode debug config`; config.ts is byte-identical
  // on 1.18.3 / 1.18.15 / dev. So a plugin entry written into opencode.json
  // is silently DEAD whenever an opencode.jsonc declares its own "plugin".
  //
  // configCandidates lists them highest-priority first (the same order
  // upstream's own globalConfigFile() picks a write target from): the
  // installer must edit the file whose "plugin" actually wins and sweep ALL
  // of them on uninstall. configFileName stays opencode.json — the
  // create-default when no candidate exists, and what the docs point at.
  opencode: Object.freeze({
    displayName: "OpenCode",
    sessionIdPrefix: "opencode:",
    hookSource: "opencode-plugin",
    pluginDirName: "opencode-plugin",
    logFileName: "opencode-plugin.log",
    configDirSegments: Object.freeze([".config", "opencode"]),
    configFileName: "opencode.json",
    configCandidates: Object.freeze(["opencode.jsonc", "opencode.json", "config.json"]),
    jsonc: true,
    schema: "https://opencode.ai/config.json",
  }),
  // MiMo Code — opencode-derived runtime with the identical plugin loader +
  // event wire contract. Its config is JSONC (comments/trailing commas
  // legal), so installer/doctor edits go through
  // hooks/opencode-family-jsonc.js instead of JSON.parse/stringify.
  //
  // Verified against MiMo Code v0.1.6 (config.ts:588-590, paths.ts:63-65,
  // plugin/install.ts:349-355): the global config is a MERGE of three files
  // — config.json → mimocode.json → mimocode.jsonc, later wins — and array
  // fields like "plugin" are REPLACED by the later file, not concatenated.
  // configCandidates lists them highest-priority first; the installer must
  // edit the file whose "plugin" actually wins and sweep ALL of them on
  // uninstall, or a masked entry could resurrect later (#607 review).
  // configFileName stays the create-default (MiMo's own starter file).
  // schema matches what MiMo v0.1.6 stamps into configs (config.ts:564-566).
  mimocode: Object.freeze({
    displayName: "MiMo Code",
    sessionIdPrefix: "mimocode:",
    hookSource: "mimocode-plugin",
    pluginDirName: "mimocode-plugin",
    logFileName: "mimocode-plugin.log",
    configDirSegments: Object.freeze([".config", "mimocode"]),
    configFileName: "mimocode.jsonc",
    configCandidates: Object.freeze(["mimocode.jsonc", "mimocode.json", "config.json"]),
    jsonc: true,
    schema: "https://mimo.xiaomi.com/mimocode/config.json",
  }),
});

// Clawd-internal event names (PascalCase) shared by every family member —
// the family plugin translates native opencode events into these. Reusing
// Claude Code event names lets state.js reuse existing transition logic
// (e.g. SubagentStop → working whitelist). Shared here so the per-agent
// configs cannot drift apart.
const FAMILY_EVENT_MAP = Object.freeze({
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  Stop: "attention",
  StopFailure: "error",
  PreCompact: "sweeping",
  PostCompact: "attention",
  // Phase 2: PermissionRequest rides a parallel channel (event permission.asked
  // → plugin POST /permission → bubble → bridge reply), not the agent eventMap.
  // Phase 3: SubagentStart/SubagentStop (subtask tracking)
});

const FAMILY_CAPABILITIES = Object.freeze({
  httpHook: false,          // family permission goes via plugin event forward, not HTTP blocking
  permissionApproval: true, // Clawd bubble → host REST reply through the reverse bridge
  sessionEnd: true,
  subagent: false,          // Phase 3 will flip to true once subtask lifecycle verified
});

function isOpencodeFamily(agentId) {
  return typeof agentId === "string" && Object.prototype.hasOwnProperty.call(OPENCODE_FAMILY, agentId);
}

// Permission entries keep the PUBLIC `agentId` field as the single identity
// truth (generic consumers: focus, auto-approve logging, remote-approval
// capability, disable-agent sweep — the latter two fall back to "claude-code"
// when agentId is missing, so family entries must never omit it).
function isOpencodeFamilyEntry(entry) {
  return !!entry && isOpencodeFamily(entry.agentId);
}

function getFamilyConfig(agentId) {
  return isOpencodeFamily(agentId) ? OPENCODE_FAMILY[agentId] : null;
}

module.exports = {
  OPENCODE_FAMILY,
  FAMILY_EVENT_MAP,
  FAMILY_CAPABILITIES,
  isOpencodeFamily,
  isOpencodeFamilyEntry,
  getFamilyConfig,
};
