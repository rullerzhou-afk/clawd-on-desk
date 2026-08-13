"use strict";

const { getPlatformConfig } = require("../hooks/shared-process");
const {
  DEFAULT_MAX_DEPTH,
  MAX_PID,
  createWindowsProcessQuery,
  normalizePid,
  walkProcessAncestry,
} = require("./win-process-ancestry");

const WINDOWS_PROCESS_CHAIN_VERSION = 1;
const WINDOWS_PROCESS_CHAIN_MODES = new Set(["legacy", "shadow", "b1a-authoritative"]);
const B1A_AGENT_IDS = Object.freeze([
  "codex",
  "cursor-agent",
  "kiro-cli",
  "codebuddy",
  "reasonix",
]);

const BASE_CONFIG = getPlatformConfig({ platform: "win32" });
const CURSOR_CONFIG = getPlatformConfig({ platform: "win32", extraTerminals: { win: ["cursor.exe"] } });
const CODEBUDDY_CONFIG = getPlatformConfig({
  platform: "win32",
  extraTerminals: { win: ["codebuddy.exe"] },
  extraEditors: { win: { "codebuddy.exe": "codebuddy" } },
});

const AGENT_CONFIGS = Object.freeze({
  codex: Object.freeze({
    agentNames: new Set(["codex.exe"]),
    terminalNames: BASE_CONFIG.terminalNames,
    systemBoundary: BASE_CONFIG.systemBoundary,
    editorMap: BASE_CONFIG.editorMap,
  }),
  "cursor-agent": Object.freeze({
    agentNames: new Set(["cursor.exe"]),
    terminalNames: CURSOR_CONFIG.terminalNames,
    systemBoundary: CURSOR_CONFIG.systemBoundary,
    editorMap: CURSOR_CONFIG.editorMap,
    editorFallback: "cursor",
  }),
  "kiro-cli": Object.freeze({
    agentNames: new Set(["kiro-cli.exe"]),
    terminalNames: BASE_CONFIG.terminalNames,
    systemBoundary: BASE_CONFIG.systemBoundary,
    editorMap: BASE_CONFIG.editorMap,
  }),
  codebuddy: Object.freeze({
    agentNames: new Set(["codebuddy.exe"]),
    terminalNames: CODEBUDDY_CONFIG.terminalNames,
    systemBoundary: CODEBUDDY_CONFIG.systemBoundary,
    editorMap: CODEBUDDY_CONFIG.editorMap,
  }),
  reasonix: Object.freeze({
    agentNames: new Set(["reasonix.exe", "reasonix-desktop.exe", "reasonix-cli.exe"]),
    terminalNames: BASE_CONFIG.terminalNames,
    systemBoundary: BASE_CONFIG.systemBoundary,
    editorMap: BASE_CONFIG.editorMap,
  }),
});

function getB1aAgentConfig(agentId) {
  return AGENT_CONFIGS[agentId] || null;
}

function normalizeWindowsProcessChainMode(value) {
  return WINDOWS_PROCESS_CHAIN_MODES.has(value) ? value : "legacy";
}

function normalizeHookPidHeader(value) {
  if (Array.isArray(value)) return null;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const pid = Number(value);
  return normalizePid(pid);
}

function normalizeInstanceGeneration(value) {
  if (Array.isArray(value)) return null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 128 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  return text;
}

function assessWindowsProcessChainRequest(options = {}) {
  const agentId = typeof options.agentId === "string" ? options.agentId : "";
  const runtime = options.runtime;
  if (options.isWinHost !== true) return { eligible: false, reason: "off-windows", mode: "legacy", hookPid: null };
  if (options.remoteProfile) return { eligible: false, reason: "remote-profile", mode: "legacy", hookPid: null };
  const config = getB1aAgentConfig(agentId);
  if (!config) return { eligible: false, reason: "agent-not-allowlisted", mode: "legacy", hookPid: null };
  const mode = normalizeWindowsProcessChainMode(runtime && runtime.agents && runtime.agents[agentId]);
  if (mode === "legacy") return { eligible: false, reason: "legacy-mode", mode, hookPid: null };
  const requestGeneration = normalizeInstanceGeneration(options.instanceGeneration);
  if (!runtime
    || runtime.version !== WINDOWS_PROCESS_CHAIN_VERSION
    || !requestGeneration
    || requestGeneration !== runtime.instanceGeneration) {
    return { eligible: false, reason: "instance-mismatch", mode, hookPid: null };
  }
  if (options.effectiveHost) return { eligible: false, reason: "remote-host", mode, hookPid: null };
  if (options.effectiveWslDistro) return { eligible: false, reason: "wsl", mode, hookPid: null };
  if (options.effectivePlatform === "webui") return { eligible: false, reason: "webui", mode, hookPid: null };
  if (options.effectiveHeadless === true) return { eligible: false, reason: "headless", mode, hookPid: null };
  const hookPid = normalizeHookPidHeader(options.hookPidHeader);
  if (!hookPid) return { eligible: false, reason: "invalid-hook-pid", mode, hookPid: null };
  return { eligible: true, reason: null, mode, hookPid };
}

function unavailableResult(agentId, hookPid, reason, details = {}) {
  return {
    status: "unavailable",
    agentId,
    hookPid: normalizePid(hookPid),
    reason,
    sourcePid: null,
    agentPid: null,
    pidChain: null,
    editor: null,
    rawEditor: null,
    depth: 0,
    durationMs: 0,
    ...details,
  };
}

function classifyWalk(config, walk) {
  // Keep the intermediate name honest: legacy shared-process calls this the
  // last good PID, then applies terminalPid || lastGoodPid when it publishes
  // stablePid. Conflating the two loses terminal priority whenever a
  // non-terminal launcher exists outside the terminal in the bounded walk.
  let lastGoodPid = walk.nodes.length ? walk.nodes[0].pid : null;
  let terminalPid = null;
  let agentPid = null;
  let agentCreationTime = null;
  let rawEditor = null;

  for (const node of walk.nodes) {
    if (!rawEditor && Object.prototype.hasOwnProperty.call(config.editorMap, node.name)) {
      rawEditor = config.editorMap[node.name];
    }
    if (!agentPid && config.agentNames.has(node.name)) {
      agentPid = node.pid;
      agentCreationTime = node.creationTime;
    }
    if (config.systemBoundary.has(node.name)) break;
    if (config.terminalNames.has(node.name)) terminalPid = node.pid;
    lastGoodPid = node.pid;
  }

  return {
    lastGoodPid,
    terminalPid,
    agentPid,
    agentCreationTime,
    rawEditor,
    editor: rawEditor || config.editorFallback || null,
  };
}

function createServerWindowsProcessMetadataResolver(options = {}) {
  const queryProcess = options.queryProcess || createWindowsProcessQuery({
    isWin: options.isWin,
    koffi: options.koffi,
    onInitError: options.onInitError,
    onCallError: options.onCallError,
  });
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth > 0
    ? options.maxDepth
    : DEFAULT_MAX_DEPTH;

  const resolve = ({ agentId, hookPid, preferAgentPid = false } = {}) => {
    const startedAt = now();
    const config = getB1aAgentConfig(agentId);
    if (!config) return unavailableResult(agentId || null, hookPid, "agent-not-allowlisted");
    const normalizedHookPid = normalizePid(hookPid);
    if (!normalizedHookPid) return unavailableResult(agentId, hookPid, "invalid-hook-pid");

    const walk = walkProcessAncestry(normalizedHookPid, {
      queryProcess,
      maxDepth,
      systemBoundary: config.systemBoundary,
    });
    const durationMs = Math.max(0, now() - startedAt);
    if (walk.status !== "ok") {
      const agentSeenBeforeFailure = Array.isArray(walk.nodes)
        && walk.nodes.some((node) => config.agentNames.has(node.name));
      return unavailableResult(agentId, normalizedHookPid, walk.reason, {
        depth: walk.depth || 0,
        durationMs,
        walkStatus: walk.status,
        comparisonClass: agentSeenBeforeFailure
          ? "intentional-stricter-partial-failure"
          : "unavailable-before-agent",
        agentSeenBeforeFailure,
        failureStage: walk.failure && walk.failure.stage
          || (walk.reason === "hook-query-failed" ? "hook"
            : (walk.reason === "ancestor-query-failed" ? "ancestor" : "walk")),
        errorKind: walk.failure && walk.failure.errorKind ? walk.failure.errorKind : null,
      });
    }

    const classified = classifyWalk(config, walk);
    if (!classified.agentPid) {
      return unavailableResult(agentId, normalizedHookPid, "expected-agent-missing", {
        depth: walk.depth,
        durationMs,
        walkStatus: walk.status,
      });
    }

    const stablePid = classified.terminalPid || classified.lastGoodPid;
    const sourcePid = preferAgentPid ? classified.agentPid : stablePid;
    if (!sourcePid) {
      return unavailableResult(agentId, normalizedHookPid, "source-missing", {
        depth: walk.depth,
        durationMs,
        walkStatus: walk.status,
      });
    }

    return {
      status: "ok",
      agentId,
      hookPid: normalizedHookPid,
      reason: walk.reason,
      sourcePid,
      stablePid,
      terminalPid: classified.terminalPid,
      agentPid: classified.agentPid,
      pidChain: walk.nodes.map((node) => node.pid),
      editor: classified.editor,
      rawEditor: classified.rawEditor,
      depth: walk.depth,
      durationMs,
      hookCreationTime: walk.hook.creationTime,
      agentCreationTime: classified.agentCreationTime,
      sourceCreationTime: (walk.nodes.find((node) => node.pid === sourcePid) || {}).creationTime || null,
    };
  };

  resolve.available = queryProcess.available !== false;
  resolve.abi = queryProcess.abi || null;
  return resolve;
}

function processMetadataForState(result) {
  if (!result || result.status !== "ok") {
    return { sourcePid: null, agentPid: null, pidChain: null, editor: null };
  }
  return {
    sourcePid: result.sourcePid || null,
    agentPid: result.agentPid || null,
    pidChain: Array.isArray(result.pidChain) && result.pidChain.length ? result.pidChain.slice() : null,
    // Preserve the route's existing editor allowlist. The resolver may
    // classify raw names such as CodeBuddy for shadow diagnostics, but B1a is
    // not an editor-schema expansion.
    editor: result.editor === "code" || result.editor === "cursor" ? result.editor : null,
  };
}

function buildShadowComparison(legacy, candidate) {
  const oldValue = legacy && typeof legacy === "object" ? legacy : {};
  const next = processMetadataForState(candidate);
  const oldChain = Array.isArray(oldValue.pidChain) ? oldValue.pidChain : null;
  const sameChain = JSON.stringify(oldChain || null) === JSON.stringify(next.pidChain || null);
  return {
    sourcePid: (oldValue.sourcePid || null) === next.sourcePid,
    agentPid: (oldValue.agentPid || null) === next.agentPid,
    pidChain: sameChain,
    editor: (oldValue.editor || null) === next.editor,
    all: (oldValue.sourcePid || null) === next.sourcePid
      && (oldValue.agentPid || null) === next.agentPid
      && sameChain
      && (oldValue.editor || null) === next.editor,
  };
}

module.exports = {
  AGENT_CONFIGS,
  B1A_AGENT_IDS,
  MAX_PID,
  WINDOWS_PROCESS_CHAIN_MODES,
  WINDOWS_PROCESS_CHAIN_VERSION,
  buildShadowComparison,
  assessWindowsProcessChainRequest,
  createServerWindowsProcessMetadataResolver,
  getB1aAgentConfig,
  normalizeHookPidHeader,
  normalizeInstanceGeneration,
  normalizeWindowsProcessChainMode,
  processMetadataForState,
};
