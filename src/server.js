// src/server.js — HTTP server + routes (/state, /permission, /health)
// Extracted from main.js L1337-1528

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  DEFAULT_SERVER_PORT,
  buildPermissionUrl,
  clearRuntimeConfig,
  getPortCandidates,
  readRuntimePort,
  writeRuntimeConfig,
} = require("../hooks/server-config");

// ExitPlanMode (Plan Review) and AskUserQuestion (elicitation) happen to
// travel through /permission, but they're UX flows — not approvals the
// sub-gate is named for. Silencing them would break plan-mode and leave
// CC hanging on an elicitation.
//
// The aggregate/split permission bubble gates are also honored here:
// dropping the HTTP connection lets CC/codebuddy fall back to their terminal
// chat prompt. The previous behavior merely skipped showPermissionBubble,
// leaving the request parked in pendingPermissions — CC would then hang for
// 600s before timing out with nothing in the terminal.
function shouldBypassCCBubble(ctx, toolName, agentId) {
  if (toolName === "ExitPlanMode" || toolName === "AskUserQuestion") return false;
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled(agentId);
}

function shouldBypassOpencodeBubble(ctx) {
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("opencode");
}

function shouldBypassCodexBubble(ctx) {
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("codex");
}

function arePermissionBubblesEnabled(ctx) {
  if (typeof ctx.getBubblePolicy === "function") {
    try {
      const policy = ctx.getBubblePolicy("permission");
      if (policy && typeof policy.enabled === "boolean") return policy.enabled;
    } catch {}
  }
  return !ctx.hideBubbles;
}

// Truncate large string values in objects (recursive) — bubble only needs a preview
const PREVIEW_MAX = 500;
const MAX_PERMISSION_SUGGESTIONS = 20;
const MAX_ELICITATION_QUESTIONS = 5;
const MAX_ELICITATION_OPTIONS = 5;
const MAX_ELICITATION_HEADER = 48;
const MAX_ELICITATION_PROMPT = 240;
const MAX_ELICITATION_OPTION_LABEL = 80;
const MAX_ELICITATION_OPTION_DESCRIPTION = 160;
const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;

function truncateDeep(obj, depth) {
  if ((depth || 0) > 10) return obj;
  if (Array.isArray(obj)) return obj.map(v => truncateDeep(v, (depth || 0) + 1));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = truncateDeep(v, (depth || 0) + 1);
    return out;
  }
  return typeof obj === "string" && obj.length > PREVIEW_MAX
    ? obj.slice(0, PREVIEW_MAX) + "\u2026" : obj;
}

function clampPreviewText(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}\u2026` : trimmed;
}

function normalizePermissionSuggestions(rawSuggestions) {
  const suggestions = Array.isArray(rawSuggestions)
    ? rawSuggestions.filter((entry) => entry && typeof entry === "object")
    : [];
  const addRulesItems = suggestions.filter((entry) => entry.type === "addRules");
  const nonAddRules = suggestions.filter((entry) => entry.type !== "addRules");
  const mergedAddRules = addRulesItems.length > 1
    ? {
        type: "addRules",
        destination: addRulesItems[0].destination || "localSettings",
        behavior: addRulesItems[0].behavior || "allow",
        rules: addRulesItems.flatMap((entry) => (
          Array.isArray(entry.rules) ? entry.rules : [{ toolName: entry.toolName, ruleContent: entry.ruleContent }]
        )),
      }
    : addRulesItems[0] || null;

  if (!mergedAddRules) return nonAddRules.slice(0, MAX_PERMISSION_SUGGESTIONS);
  if (nonAddRules.length + 1 <= MAX_PERMISSION_SUGGESTIONS) return [...nonAddRules, mergedAddRules];
  return [
    ...nonAddRules.slice(0, MAX_PERMISSION_SUGGESTIONS - 1),
    mergedAddRules,
  ];
}

function normalizeElicitationToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return toolInput;
  if (!Array.isArray(toolInput.questions)) return toolInput;

  const questions = toolInput.questions
    .slice(0, MAX_ELICITATION_QUESTIONS)
    .map((question) => {
      if (!question || typeof question !== "object") return null;
      const options = Array.isArray(question.options)
        ? question.options
          .slice(0, MAX_ELICITATION_OPTIONS)
          .map((option) => {
            if (!option || typeof option !== "object") return null;
            return {
              ...option,
              label: clampPreviewText(option.label, MAX_ELICITATION_OPTION_LABEL),
              description: clampPreviewText(option.description, MAX_ELICITATION_OPTION_DESCRIPTION),
            };
          })
          .filter(Boolean)
        : [];

      const normalized = {
        ...question,
        header: clampPreviewText(question.header, MAX_ELICITATION_HEADER),
        question: clampPreviewText(question.question, MAX_ELICITATION_PROMPT),
        options,
      };
      if (!normalized.question) return null;
      return normalized;
    })
    .filter(Boolean);

  return {
    ...toolInput,
    questions,
  };
}

function normalizeHookToolUseId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeToolMatchValue(value, depth = 0) {
  if (depth > TOOL_MATCH_DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, TOOL_MATCH_ARRAY_MAX)
      .map((entry) => normalizeToolMatchValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, TOOL_MATCH_OBJECT_KEYS_MAX)) {
      out[key] = normalizeToolMatchValue(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > TOOL_MATCH_STRING_MAX
      ? `${value.slice(0, TOOL_MATCH_STRING_MAX - 1)}…`
      : value;
  }
  return value;
}

function buildToolInputFingerprint(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const normalized = normalizeToolMatchValue(toolInput);
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function normalizeCodexPermissionToolInput(rawInput, description) {
  const base = rawInput && typeof rawInput === "object" ? truncateDeep(rawInput) : {};
  const trimmedDescription = typeof description === "string" && description.trim()
    ? description.trim()
    : null;
  if (!trimmedDescription) return base;
  return {
    ...base,
    description: trimmedDescription,
  };
}

function sendCodexPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function findPendingPermissionForStateEvent(pendingPermissions, options) {
  const sessionId = typeof options.sessionId === "string" && options.sessionId
    ? options.sessionId
    : "default";
  const sessionPending = pendingPermissions.filter((perm) => (
    perm && perm.res && perm.sessionId === sessionId
  ));
  if (!sessionPending.length) return null;

  const toolUseId = normalizeHookToolUseId(options.toolUseId);
  if (toolUseId) {
    const matchByToolUseId = sessionPending.find((perm) => perm.toolUseId === toolUseId);
    if (matchByToolUseId) return matchByToolUseId;
  }

  const toolName = typeof options.toolName === "string" && options.toolName
    ? options.toolName
    : null;
  const toolInputFingerprint = typeof options.toolInputFingerprint === "string" && options.toolInputFingerprint
    ? options.toolInputFingerprint
    : null;
  if (toolName && toolInputFingerprint) {
    const matchesByFingerprint = sessionPending.filter((perm) => (
      perm.toolName === toolName
        && perm.toolInputFingerprint === toolInputFingerprint
        && (!toolUseId || !perm.toolUseId)
    ));
    if (matchesByFingerprint.length === 1) return matchesByFingerprint[0];
  }

  const allowSingletonFallback = options.allowSingletonFallback === true;
  return allowSingletonFallback && sessionPending.length === 1 ? sessionPending[0] : null;
}

const HOOK_MARKER = "clawd-hook.js";
const SETTINGS_FILENAME = "settings.json";
const CODEX_OFFICIAL_HOOK_SOURCE = "codex-official";
const MAX_CODEX_OFFICIAL_TURNS = 200;

function entriesContainCommandMarker(entries, marker) {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command === "string" && entry.command.includes(marker)) return true;
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook !== "object") continue;
      if (typeof hook.command === "string" && hook.command.includes(marker)) return true;
    }
  }
  return false;
}

function entriesContainHttpHookUrl(entries, expectedUrl) {
  if (!Array.isArray(entries) || !expectedUrl) return false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "http" && entry.url === expectedUrl) return true;
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook !== "object") continue;
      if (hook.type === "http" && hook.url === expectedUrl) return true;
    }
  }
  return false;
}

function settingsNeedClaudeHookResync(rawSettings, expectedPermissionUrl) {
  if (typeof rawSettings !== "string" || !rawSettings.trim()) return false;

  let parsed;
  try {
    parsed = JSON.parse(rawSettings);
  } catch {
    return false;
  }

  const hooks = parsed && typeof parsed === "object" ? parsed.hooks : null;
  if (!hooks || typeof hooks !== "object") return true;

  const hasManagedCommandHook = Object.values(hooks).some((entries) => (
    entriesContainCommandMarker(entries, HOOK_MARKER)
  ));
  const hasManagedPermissionHook = entriesContainHttpHookUrl(hooks.PermissionRequest, expectedPermissionUrl);
  return !hasManagedCommandHook || !hasManagedPermissionHook;
}

function pruneCodexOfficialTurns(turns) {
  if (!turns || turns.size <= MAX_CODEX_OFFICIAL_TURNS) return;
  const overflow = turns.size - MAX_CODEX_OFFICIAL_TURNS;
  let removed = 0;
  for (const key of turns.keys()) {
    turns.delete(key);
    removed++;
    if (removed >= overflow) break;
  }
}

function resolveCodexOfficialHookState(data, requestedState, turns) {
  if (!data || data.agent_id !== "codex" || data.hook_source !== CODEX_OFFICIAL_HOOK_SOURCE) {
    return { state: requestedState, drop: false };
  }

  const event = typeof data.event === "string" ? data.event : "";
  const turnId = typeof data.turn_id === "string" && data.turn_id ? data.turn_id : null;
  const sessionId = typeof data.session_id === "string" && data.session_id ? data.session_id : "default";

  if (event === "Stop" && data.stop_hook_active === true) {
    if (turnId && turns) turns.delete(turnId);
    return { state: requestedState, drop: true };
  }

  if (turnId && turns) {
    if (event === "UserPromptSubmit") {
      turns.set(turnId, { sessionId, hadToolUse: false });
      pruneCodexOfficialTurns(turns);
    } else if (event === "PreToolUse" || event === "PostToolUse") {
      const current = turns.get(turnId) || { sessionId, hadToolUse: false };
      current.sessionId = sessionId;
      current.hadToolUse = true;
      turns.set(turnId, current);
      pruneCodexOfficialTurns(turns);
    } else if (event === "Stop") {
      const current = turns.get(turnId);
      if (current) turns.delete(turnId);
      return { state: current && current.hadToolUse ? "attention" : "idle", drop: false };
    }
  } else if (event === "Stop") {
    return { state: "idle", drop: false };
  }

  return { state: requestedState, drop: false };
}

module.exports = function initServer(ctx) {

const fsApi = ctx.fs || fs;
const pathApi = ctx.path || path;
const osApi = ctx.os || os;
const createHttpServer = ctx.createHttpServer || http.createServer.bind(http);
const setImmediateFn = ctx.setImmediate || setImmediate;
const setTimeoutFn = ctx.setTimeout || setTimeout;
const clearTimeoutFn = ctx.clearTimeout || clearTimeout;
const nowFn = typeof ctx.now === "function" ? ctx.now : Date.now;
const clearRuntimeConfigFn = ctx.clearRuntimeConfig || clearRuntimeConfig;
const getPortCandidatesFn = ctx.getPortCandidates || getPortCandidates;
const readRuntimePortFn = ctx.readRuntimePort || readRuntimePort;
const writeRuntimeConfigFn = ctx.writeRuntimeConfig || writeRuntimeConfig;
const settingsWatchDebounceMs = Number.isFinite(ctx.settingsWatchDebounceMs) ? ctx.settingsWatchDebounceMs : 1000;
const settingsWatchRateLimitMs = Number.isFinite(ctx.settingsWatchRateLimitMs) ? ctx.settingsWatchRateLimitMs : 5000;

let httpServer = null;
let activeServerPort = null;
let settingsWatcher = null;
let settingsWatchDebounceTimer = null;
let settingsWatchLastSyncTime = 0;
const codexOfficialTurns = new Map();

function shouldManageClaudeHooks() {
  return ctx.manageClaudeHooksAutomatically !== false;
}

function isAgentEnabled(agentId) {
  if (typeof ctx.isAgentEnabled !== "function") return true;
  return ctx.isAgentEnabled(agentId) !== false;
}

function getClaudeSettingsDir() {
  return typeof ctx.claudeSettingsDir === "string"
    ? ctx.claudeSettingsDir
    : pathApi.join(osApi.homedir(), ".claude");
}

function getClaudeSettingsPath() {
  return typeof ctx.claudeSettingsPath === "string"
    ? ctx.claudeSettingsPath
    : pathApi.join(getClaudeSettingsDir(), SETTINGS_FILENAME);
}

function getHookServerPort() {
  return activeServerPort || readRuntimePortFn() || DEFAULT_SERVER_PORT;
}

function syncClawdHooks() {
  try {
    if (typeof ctx.syncClawdHooksImpl === "function") {
      return ctx.syncClawdHooksImpl({
        autoStart: ctx.autoStartWithClaude,
        port: getHookServerPort(),
      });
    }
    const { registerHooks } = require("../hooks/install.js");
    const { added, updated, removed } = registerHooks({
      silent: true,
      autoStart: ctx.autoStartWithClaude,
      port: getHookServerPort(),
    });
    if (added > 0 || updated > 0 || removed > 0) {
      console.log(`Clawd: synced hooks (added ${added}, updated ${updated}, removed ${removed})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync hooks:", err.message);
  }
}

function syncGeminiHooks() {
  try {
    if (typeof ctx.syncGeminiHooksImpl === "function") return ctx.syncGeminiHooksImpl();
    const { registerGeminiHooks } = require("../hooks/gemini-install.js");
    const { added, updated } = registerGeminiHooks({ silent: true });
    if (added > 0 || updated > 0) {
      console.log(`Clawd: synced Gemini hooks (added ${added}, updated ${updated})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync Gemini hooks:", err.message);
  }
}

function syncCodeBuddyHooks() {
  try {
    if (typeof ctx.syncCodeBuddyHooksImpl === "function") return ctx.syncCodeBuddyHooksImpl();
    const { registerCodeBuddyHooks } = require("../hooks/codebuddy-install.js");
    const { added, updated } = registerCodeBuddyHooks({ silent: true });
    if (added > 0 || updated > 0) {
      console.log(`Clawd: synced CodeBuddy hooks (added ${added}, updated ${updated})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync CodeBuddy hooks:", err.message);
  }
}

function syncKiroHooks() {
  try {
    if (typeof ctx.syncKiroHooksImpl === "function") return ctx.syncKiroHooksImpl();
    const { registerKiroHooks } = require("../hooks/kiro-install.js");
    const { added, updated } = registerKiroHooks({ silent: true });
    if (added > 0 || updated > 0) {
      console.log(`Clawd: synced Kiro hooks (added ${added}, updated ${updated})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync Kiro hooks:", err.message);
  }
}

function syncKimiHooks() {
  try {
    if (typeof ctx.syncKimiHooksImpl === "function") return ctx.syncKimiHooksImpl();
    const { registerKimiHooks } = require("../hooks/kimi-install.js");
    const { added, updated } = registerKimiHooks({ silent: true });
    if (added > 0 || updated > 0) {
      console.log(`Clawd: synced Kimi hooks (added ${added}, updated ${updated})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync Kimi hooks:", err.message);
  }
}

function syncCodexHooks() {
  try {
    if (typeof ctx.syncCodexHooksImpl === "function") return ctx.syncCodexHooksImpl();
    const { registerCodexHooks } = require("../hooks/codex-install.js");
    const { added, updated, warnings } = registerCodexHooks({ silent: true });
    if (added > 0 || updated > 0) {
      console.log(`Clawd: synced Codex hooks (added ${added}, updated ${updated})`);
    }
    if (Array.isArray(warnings)) {
      for (const warning of warnings) console.warn(`Clawd: Codex hook sync warning: ${warning}`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync Codex hooks:", err.message);
  }
}

function syncCursorHooks() {
  try {
    if (typeof ctx.syncCursorHooksImpl === "function") return ctx.syncCursorHooksImpl();
    const { registerCursorHooks } = require("../hooks/cursor-install.js");
    const { added, updated } = registerCursorHooks({ silent: true });
    if (added > 0 || updated > 0) {
      console.log(`Clawd: synced Cursor hooks (added ${added}, updated ${updated})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync Cursor hooks:", err.message);
  }
}

function syncOpencodePlugin() {
  try {
    if (typeof ctx.syncOpencodePluginImpl === "function") return ctx.syncOpencodePluginImpl();
    const { registerOpencodePlugin } = require("../hooks/opencode-install.js");
    const { added, created } = registerOpencodePlugin({ silent: true });
    if (added || created) {
      console.log(`Clawd: synced opencode plugin (added=${added}, created=${created})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync opencode plugin:", err.message);
  }
}

const AGENT_INTEGRATION_SYNCERS = Object.freeze({
  "gemini-cli": syncGeminiHooks,
  "cursor-agent": syncCursorHooks,
  codebuddy: syncCodeBuddyHooks,
  "kiro-cli": syncKiroHooks,
  "kimi-cli": syncKimiHooks,
  codex: syncCodexHooks,
  opencode: syncOpencodePlugin,
});

function syncIntegrationForAgent(agentId) {
  if (agentId === "claude-code") {
    if (!shouldManageClaudeHooks()) return false;
    syncClawdHooks();
    startClaudeSettingsWatcher();
    return true;
  }
  const sync = AGENT_INTEGRATION_SYNCERS[agentId];
  if (typeof sync !== "function") return false;
  sync();
  return true;
}

function stopIntegrationForAgent(agentId) {
  if (agentId !== "claude-code") return false;
  return stopClaudeSettingsWatcher();
}

function syncEnabledStartupIntegrations() {
  if (shouldManageClaudeHooks() && isAgentEnabled("claude-code")) {
    syncClawdHooks();
    startClaudeSettingsWatcher();
  }
  for (const [agentId, sync] of Object.entries(AGENT_INTEGRATION_SYNCERS)) {
    if (isAgentEnabled(agentId)) sync();
  }
}

function sendStateHealthResponse(res) {
  const body = JSON.stringify({ ok: true, app: CLAWD_SERVER_ID, port: getHookServerPort() });
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(body);
}

// Watch ~/.claude/ directory for settings.json overwrites (e.g. CC-Switch)
// that wipe our hooks. Re-register when hooks disappear.
// Watch the directory (not the file) because atomic rename replaces the inode
// and fs.watch on the old file silently stops firing on Windows.
function stopClaudeSettingsWatcher() {
  if (settingsWatchDebounceTimer) {
    clearTimeoutFn(settingsWatchDebounceTimer);
    settingsWatchDebounceTimer = null;
  }
  settingsWatchLastSyncTime = 0;
  if (!settingsWatcher) return false;
  try {
    settingsWatcher.close();
  } catch {}
  settingsWatcher = null;
  return true;
}

function startClaudeSettingsWatcher() {
  if (settingsWatcher) return false;
  const settingsDir = getClaudeSettingsDir();
  const settingsPath = getClaudeSettingsPath();
  try {
    settingsWatcher = fsApi.watch(settingsDir, (_event, filename) => {
      if (filename && filename !== SETTINGS_FILENAME) return;
      if (settingsWatchDebounceTimer) return;
      settingsWatchDebounceTimer = setTimeoutFn(() => {
        settingsWatchDebounceTimer = null;
        if (!shouldManageClaudeHooks() || !isAgentEnabled("claude-code")) return;
        // Rate-limit: don't re-sync within 5s to avoid write wars with CC-Switch
        if (nowFn() - settingsWatchLastSyncTime < settingsWatchRateLimitMs) return;
        try {
          const raw = fsApi.readFileSync(settingsPath, "utf-8");
          const expectedPermissionUrl = buildPermissionUrl(getHookServerPort());
          if (settingsNeedClaudeHookResync(raw, expectedPermissionUrl)) {
            console.log("Clawd: hooks missing from settings.json — re-registering");
            settingsWatchLastSyncTime = nowFn();
            syncClawdHooks();
          }
        } catch {}
      }, settingsWatchDebounceMs);
    });
    if (settingsWatcher && typeof settingsWatcher.on === "function") settingsWatcher.on("error", (err) => {
      console.warn("Clawd: settings watcher error:", err.message);
    });
    return true;
  } catch (err) {
    console.warn("Clawd: failed to watch settings directory:", err.message);
    settingsWatcher = null;
    return false;
  }
}

// /state POST body size cap. Raised from 1024 to 4096 to give new fields
// (session_title) headroom on top of cwd / pid_chain / host / etc. Still a
// local-only 127.0.0.1 endpoint — not an Internet DoS concern.
const MAX_STATE_BODY_BYTES = 4096;

function startHttpServer() {
  httpServer = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/state") {
      sendStateHealthResponse(res);
    } else if (req.method === "POST" && req.url === "/state") {
      let body = "";
      let bodySize = 0;
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return;
        bodySize += chunk.length;
        if (bodySize > MAX_STATE_BODY_BYTES) { tooLarge = true; return; }
        body += chunk;
      });
      req.on("end", () => {
        if (tooLarge) {
          res.writeHead(413);
          res.end("state payload too large");
          return;
        }
        try {
          const data = JSON.parse(body);
          let { state, svg, session_id, event } = data;
          let display_svg;
          if (data.display_svg === null) display_svg = null;
          else if (typeof data.display_svg === "string") display_svg = path.basename(data.display_svg);
          else display_svg = undefined;
          const source_pid = Number.isFinite(data.source_pid) && data.source_pid > 0 ? Math.floor(data.source_pid) : null;
          const cwd = typeof data.cwd === "string" ? data.cwd : "";
          const editor = (data.editor === "code" || data.editor === "cursor") ? data.editor : null;
          const pidChain = Array.isArray(data.pid_chain) ? data.pid_chain.filter(n => Number.isFinite(n) && n > 0) : null;
          const rawAgentPid = data.agent_pid ?? data.claude_pid ?? data.cursor_pid;
          const agentPid = Number.isFinite(rawAgentPid) && rawAgentPid > 0 ? Math.floor(rawAgentPid) : null;
          const agentId = typeof data.agent_id === "string" ? data.agent_id : "claude-code";
          const host = typeof data.host === "string" ? data.host : null;
          const headless = data.headless === true;
          const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : null;
          const toolUseId = normalizeHookToolUseId(
            data.tool_use_id ?? data.toolUseId ?? data.toolUseID
          );
          const toolInputFingerprint = typeof data.tool_input_fingerprint === "string" && data.tool_input_fingerprint
            ? data.tool_input_fingerprint
            : null;
          // Session title (Claude Code /rename or Codex turn_context.summary).
          // Non-string / empty values are silently dropped — matches the
          // "ignore + fall back" pattern used by cwd / agent_id above.
          const rawTitle = typeof data.session_title === "string" ? data.session_title.trim() : "";
          const sessionTitle = rawTitle || null;
          const permissionSuspect = data.permission_suspect === true;
          const hookSource = typeof data.hook_source === "string" ? data.hook_source : null;
          // Agent gate: user disabled this agent in the settings panel. Drop
          // with 204 so hook scripts get a quick no-op response instead of
          // hanging on our HTTP connection. Still surfaces as a success code
          // so hook exit behavior is unchanged.
          if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(agentId)) {
            res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
            res.end();
            return;
          }
          if (ctx.STATE_SVGS[state]) {
            const sid = session_id || "default";
            const codexHookState = resolveCodexOfficialHookState(data, state, codexOfficialTurns);
            if (codexHookState.drop) {
              res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
              res.end();
              return;
            }
            state = codexHookState.state;
            if (state.startsWith("mini-") && !svg) {
              res.writeHead(400);
              res.end("mini states require svg override");
              return;
            }
            if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "Stop") {
              const perm = findPendingPermissionForStateEvent(ctx.pendingPermissions, {
                sessionId: sid,
                toolName,
                toolUseId,
                toolInputFingerprint,
                allowSingletonFallback: event === "Stop",
              });
              if (perm) ctx.resolvePermissionEntry(perm, "deny", "User answered in terminal");
            }
            if (svg) {
              const safeSvg = path.basename(svg);
              ctx.setState(state, safeSvg);
            } else {
              ctx.updateSession(sid, state, event, {
                sourcePid: source_pid,
                cwd,
                editor,
                pidChain,
                agentPid,
                agentId,
                host,
                headless,
                displayHint: display_svg,
                sessionTitle,
                permissionSuspect,
                hookSource,
              });
            }
            res.writeHead(200, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
            res.end("ok");
          } else {
            res.writeHead(400);
            res.end("unknown state");
          }
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
    } else if (req.method === "POST" && req.url === "/permission") {
      ctx.permLog(`/permission hit | DND=${ctx.doNotDisturb} pending=${ctx.pendingPermissions.length}`);
      let body = "";
      let bodySize = 0;
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return;
        bodySize += chunk.length;
        if (bodySize > 524288) { tooLarge = true; return; }
        body += chunk;
      });
      req.on("end", () => {
        if (tooLarge) {
          ctx.permLog("SKIPPED: permission payload too large");
          ctx.sendPermissionResponse(res, "deny", "Permission request too large for Clawd bubble; answer in terminal");
          return;
        }

        let data;
        try {
          data = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end("bad json");
          return;
        }

        try {
          // ── opencode branch ──
          // opencode plugin (agents/opencode.js) posts fire-and-forget. We
          // always 200 ACK immediately; the user's decision routes through
          // a separate REST call to opencode's own server (see permission.js
          // replyOpencodePermission). This means no res is retained on the
          // permEntry, no res.on("close") abort handler, and hideBubbles
          // degrades to "TUI only" (plugin doesn't wait on us).
          //
          // DND handling is branch-specific: opencode cannot observe the
          // HTTP response (fire-and-forget), so a generic HTTP deny would
          // leave the TUI hanging until timeout. Instead we route DND
          // through the same reverse bridge the plugin uses for replies.
          if (data.agent_id === "opencode") {
            res.writeHead(200, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
            res.end("ok");

            // Agent gate: same silent-drop semantics as DND — plugin is
            // fire-and-forget, so 200 ACK satisfies it; skipping the bridge
            // reply lets the opencode TUI fall back to its built-in prompt.
            if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("opencode")) {
              ctx.permLog("opencode disabled → silent drop, TUI fallback");
              return;
            }

            const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "unknown";
            const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
            const toolInput = truncateDeep(rawInput);
            const sessionId = typeof data.session_id === "string" ? data.session_id : "default";
            const requestId = typeof data.request_id === "string" ? data.request_id : null;
            const bridgeUrl = typeof data.bridge_url === "string" ? data.bridge_url : "";
            const bridgeToken = typeof data.bridge_token === "string" ? data.bridge_token : "";
            const alwaysCandidates = Array.isArray(data.always) ? data.always : [];
            const patterns = Array.isArray(data.patterns) ? data.patterns : [];

            ctx.permLog(`opencode perm: tool=${toolName} session=${sessionId} req=${requestId} bridge=${bridgeUrl} always=${alwaysCandidates.length}`);

            // bridge_url/bridge_token are required — this is the reverse
            // channel Clawd uses to send the decision back to the plugin,
            // which then calls opencode's in-process Hono route. Without it
            // we have no way to resolve the pending permission.
            if (!requestId || !bridgeUrl || !bridgeToken) {
              const missing = !requestId ? "request_id" : (!bridgeUrl ? "bridge_url" : "bridge_token");
              ctx.permLog(`SKIPPED opencode perm: missing ${missing}`);
              return;
            }

            // DND: drop silently — do NOT reply via bridge. opencode TUI
            // will fall back to its built-in permission prompt so the user
            // can confirm in the terminal themselves. Spike 2026-04-06
            // confirmed this works: TUI shows Allow/Reject without hanging.
            if (ctx.doNotDisturb) {
              ctx.permLog(`opencode DND → silent drop, TUI fallback — request=${requestId}`);
              return;
            }

            // No HTTP connection to hold open — only degradation is to
            // not render a bubble and let the TUI prompt handle it.
            const opencodeSubGateBypass = shouldBypassOpencodeBubble(ctx);
            if (!arePermissionBubblesEnabled(ctx) || opencodeSubGateBypass) {
              ctx.permLog(`opencode bubble hidden: tool=${toolName} — TUI fallback (permissionBubblesEnabled=${arePermissionBubblesEnabled(ctx)} subGateBypass=${opencodeSubGateBypass})`);
              return;
            }

            const permEntry = {
              res: null,
              abortHandler: null,
              suggestions: [],
              sessionId,
              bubble: null,
              hideTimer: null,
              toolName,
              toolInput,
              resolvedSuggestion: null,
              createdAt: Date.now(),
              agentId: "opencode",
              isOpencode: true,
              opencodeRequestId: requestId,
              opencodeBridgeUrl: bridgeUrl,
              opencodeBridgeToken: bridgeToken,
              opencodeAlwaysCandidates: alwaysCandidates,
              opencodePatterns: patterns,
            };
            ctx.pendingPermissions.push(permEntry);
            // Play notification animation on the pet body so the bubble doesn't
            // appear "silently". Mirrors the Codex path (main.js showCodexNotifyBubble)
            // and the Elicitation branch below. state.js:581 has a special
            // PermissionRequest branch that setStates notification without
            // mutating session state — so working/thinking is preserved for resolve.
            ctx.updateSession(sessionId, "notification", "PermissionRequest", { agentId: "opencode" });
            ctx.permLog(`opencode showing bubble: tool=${toolName} session=${sessionId}`);
            try {
              ctx.showPermissionBubble(permEntry);
            } catch (bubbleErr) {
              // If bubble creation fails (BrowserWindow error, bad html,
              // window-positioning crash, etc), we have already 200-ACKed
              // the plugin and it is waiting for a bridge reply. Without
              // this rescue the permEntry would linger in pendingPermissions
              // until the opencode TUI hits its own timeout (minutes).
              // Pop the ghost entry and send an immediate reject so the
              // TUI unblocks and the user can re-answer in the terminal.
              ctx.permLog(`opencode bubble failed: ${bubbleErr && bubbleErr.message} — reject via bridge`);
              const popIdx = ctx.pendingPermissions.indexOf(permEntry);
              if (popIdx !== -1) ctx.pendingPermissions.splice(popIdx, 1);
              ctx.replyOpencodePermission({ bridgeUrl, bridgeToken, requestId, reply: "reject", toolName });
            }
            return;
          }

          // ── Codex official PermissionRequest branch ──
          // The hook is blocking, but fallback must be no-decision rather than
          // Deny: Codex will then continue to its native approval prompt.
          if (data.agent_id === "codex") {
            const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "Unknown";
            const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
            const description = typeof data.tool_input_description === "string" && data.tool_input_description
              ? data.tool_input_description
              : (typeof rawInput.description === "string" ? rawInput.description : "");
            const toolInput = normalizeCodexPermissionToolInput(rawInput, description);
            const sessionId = typeof data.session_id === "string" && data.session_id ? data.session_id : "codex:default";
            const toolUseId = normalizeHookToolUseId(
              data.tool_use_id ?? data.toolUseId ?? data.toolUseID
            );
            const toolInputFingerprint = typeof data.tool_input_fingerprint === "string" && data.tool_input_fingerprint
              ? data.tool_input_fingerprint
              : buildToolInputFingerprint(rawInput);

            if (ctx.doNotDisturb) {
              ctx.permLog(`codex DND -> no decision, native prompt fallback (tool=${toolName})`);
              sendCodexPermissionNoDecision(res);
              return;
            }

            if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("codex")) {
              ctx.permLog(`codex disabled -> no decision, native prompt fallback (tool=${toolName})`);
              sendCodexPermissionNoDecision(res);
              return;
            }

            if (shouldBypassCodexBubble(ctx)) {
              const reason = !arePermissionBubblesEnabled(ctx)
                ? "permission bubbles disabled"
                : "codex bubbles disabled";
              ctx.permLog(`${reason} -> no decision, native prompt fallback (tool=${toolName})`);
              sendCodexPermissionNoDecision(res);
              return;
            }

            const permEntry = {
              res,
              abortHandler: null,
              suggestions: [],
              sessionId,
              bubble: null,
              hideTimer: null,
              toolName,
              toolInput,
              toolUseId,
              toolInputFingerprint,
              resolvedSuggestion: null,
              createdAt: Date.now(),
              agentId: "codex",
              isCodex: true,
            };
            const abortHandler = () => {
              if (res.writableFinished) return;
              ctx.permLog("abortHandler fired (codex)");
              ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected");
            };
            permEntry.abortHandler = abortHandler;
            res.on("close", abortHandler);

            ctx.pendingPermissions.push(permEntry);
            ctx.updateSession(sessionId, "notification", "PermissionRequest", {
              agentId: "codex",
              hookSource: CODEX_OFFICIAL_HOOK_SOURCE,
            });

            ctx.permLog(`codex showing bubble: tool=${toolName} session=${sessionId} stack=${ctx.pendingPermissions.length}`);
            try {
              ctx.showPermissionBubble(permEntry);
            } catch (bubbleErr) {
              ctx.permLog(`codex bubble failed: ${bubbleErr && bubbleErr.message} -> no decision`);
              const popIdx = ctx.pendingPermissions.indexOf(permEntry);
              if (popIdx !== -1) ctx.pendingPermissions.splice(popIdx, 1);
              if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
              sendCodexPermissionNoDecision(res);
            }
            return;
          }

          // ── Claude Code branch ──
          // DND: destroy connection — do NOT send deny on the user's behalf.
          // CC falls back to its built-in chat permission prompt so the user
          // decides themselves. Spike 2026-04-07 confirmed: CC shows Allow/
          // Deny in chat, no hang, no timeout. Same pattern as opencode
          // silent drop (95cbfc7).
          if (ctx.doNotDisturb) {
            ctx.permLog("CC DND → destroy connection, CC chat fallback");
            res.destroy();
            return;
          }

          // Agent gate: mirror DND — destroy the connection so CC (or
          // codebuddy, since they share this path) falls back to its built-in
          // chat prompt. Any non-opencode agent_id passing through here
          // gets the same treatment.
          const ccAgentId = typeof data.agent_id === "string" && data.agent_id ? data.agent_id : "claude-code";
          if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(ccAgentId)) {
            ctx.permLog(`${ccAgentId} disabled → destroy connection, chat fallback`);
            res.destroy();
            return;
          }

          const toolName = typeof data.tool_name === "string" ? data.tool_name : "Unknown";
          const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
          const toolInput = truncateDeep(rawInput);
          const toolUseId = normalizeHookToolUseId(
            data.tool_use_id ?? data.toolUseId ?? data.toolUseID
          );
          const toolInputFingerprint = buildToolInputFingerprint(rawInput);
          const sessionId = data.session_id || "default";
          // Tag the permEntry with the source agent. Clawd's HTTP permission
          // path is shared between Claude Code and codebuddy (both set
          // capabilities.permissionApproval=true and POST here). Stamping lets
          // dismissPermissionsByAgent() clean up the right ones when the user
          // disables an agent mid-flight.
          const permAgentId = typeof data.agent_id === "string" && data.agent_id ? data.agent_id : "claude-code";
          const rawSuggestions = Array.isArray(data.permission_suggestions) ? data.permission_suggestions : [];
          const suggestions = normalizePermissionSuggestions(rawSuggestions);

          const existingSession = ctx.sessions.get(sessionId);
          if (existingSession && existingSession.headless) {
            ctx.permLog(`SKIPPED: headless session=${sessionId}`);
            ctx.sendPermissionResponse(res, "deny", "Non-interactive session; auto-denied");
            return;
          }

          if (ctx.PASSTHROUGH_TOOLS.has(toolName)) {
            ctx.permLog(`PASSTHROUGH: tool=${toolName} session=${sessionId}`);
            ctx.sendPermissionResponse(res, "allow");
            return;
          }

          if (shouldBypassCCBubble(ctx, toolName, permAgentId)) {
            const reason = !arePermissionBubblesEnabled(ctx)
              ? "permission bubbles disabled"
              : `${permAgentId} bubbles disabled`;
            ctx.permLog(`${reason} → destroy connection, chat fallback (tool=${toolName})`);
            res.destroy();
            return;
          }

          // Elicitation (AskUserQuestion) — show notification bubble, not permission bubble.
          // User clicks "Go to Terminal" → deny → Claude Code falls back to terminal.
          if (toolName === "AskUserQuestion") {
            const elicitationInput = normalizeElicitationToolInput(toolInput);
            ctx.permLog(`ELICITATION: tool=${toolName} session=${sessionId}`);
            ctx.updateSession(sessionId, "notification", "Elicitation", { agentId: "claude-code" });

            const permEntry = {
              res,
              abortHandler: null,
              suggestions: [],
              sessionId,
              bubble: null,
              hideTimer: null,
              toolName,
              toolInput: elicitationInput,
              toolUseId,
              toolInputFingerprint,
              resolvedSuggestion: null,
              createdAt: Date.now(),
              isElicitation: true,
              agentId: permAgentId,
            };
            const abortHandler = () => {
              if (res.writableFinished) return;
              ctx.permLog("abortHandler fired (elicitation)");
              ctx.resolvePermissionEntry(permEntry, "deny", "Client disconnected");
            };
            permEntry.abortHandler = abortHandler;
            res.on("close", abortHandler);
            ctx.pendingPermissions.push(permEntry);
            ctx.showPermissionBubble(permEntry);
            return;
          }

          const permEntry = {
            res,
            abortHandler: null,
            suggestions,
            sessionId,
            bubble: null,
            hideTimer: null,
            toolName,
            toolInput,
            toolUseId,
            toolInputFingerprint,
            resolvedSuggestion: null,
            createdAt: Date.now(),
            agentId: permAgentId,
          };
          const abortHandler = () => {
            if (res.writableFinished) return;
            ctx.permLog("abortHandler fired");
            ctx.resolvePermissionEntry(permEntry, "deny", "Client disconnected");
          };
          permEntry.abortHandler = abortHandler;
          res.on("close", abortHandler);

          ctx.pendingPermissions.push(permEntry);

          // Play notification animation on the pet body so the bubble doesn't
          // appear "silently". Mirrors the Codex path (main.js showCodexNotifyBubble)
          // and the Elicitation branch above. state.js:581 has a special
          // PermissionRequest branch that setStates notification without
          // mutating session state — so working/thinking is preserved for resolve.
          ctx.updateSession(sessionId, "notification", "PermissionRequest", { agentId: permAgentId });

          ctx.permLog(`showing bubble: tool=${toolName} session=${sessionId} suggestions=${suggestions.length} stack=${ctx.pendingPermissions.length}`);
          ctx.showPermissionBubble(permEntry);
        } catch (err) {
          ctx.permLog(`/permission handler error: ${err && err.message}`);
          // Response may already be sent (opencode branch 200-ACKs before
          // processing), so guard against a second writeHead.
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("internal error");
          }
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const listenPorts = getPortCandidatesFn();
  let listenIndex = 0;
  httpServer.on("error", (err) => {
    if (!activeServerPort && err.code === "EADDRINUSE" && listenIndex < listenPorts.length - 1) {
      listenIndex++;
      httpServer.listen(listenPorts[listenIndex], "127.0.0.1");
      return;
    }
    if (!activeServerPort && err.code === "EADDRINUSE") {
      const firstPort = listenPorts[0];
      const lastPort = listenPorts[listenPorts.length - 1];
      console.warn(`Ports ${firstPort}-${lastPort} are occupied — state sync and permission bubbles are disabled`);
    } else {
      console.error("HTTP server error:", err.message);
    }
  });

  httpServer.on("listening", () => {
    activeServerPort = listenPorts[listenIndex];
    writeRuntimeConfigFn(activeServerPort);
    console.log(`Clawd state server listening on 127.0.0.1:${activeServerPort}`);
    // Defer hook/plugin registration off the startup path. Each sync call
    // reads+parses+writes a config JSON (50-150ms cumulative on slow disks),
    // and they operate on independent files for independent agents, so
    // none of them need to block the HTTP server from accepting traffic.
    setImmediateFn(() => {
      syncEnabledStartupIntegrations();
    });
  });

  httpServer.listen(listenPorts[listenIndex], "127.0.0.1");
}

function cleanup() {
  clearRuntimeConfigFn();
  stopClaudeSettingsWatcher();
  if (httpServer) httpServer.close();
}

return {
  startHttpServer,
  getHookServerPort,
  syncClawdHooks,
  syncGeminiHooks,
  syncCursorHooks,
  syncCodeBuddyHooks,
  syncKiroHooks,
  syncKimiHooks,
  syncCodexHooks,
  syncOpencodePlugin,
  syncIntegrationForAgent,
  stopIntegrationForAgent,
  startClaudeSettingsWatcher,
  stopClaudeSettingsWatcher,
  cleanup,
};

};

module.exports.__test = {
  entriesContainCommandMarker,
  entriesContainHttpHookUrl,
  settingsNeedClaudeHookResync,
  shouldBypassCCBubble,
  shouldBypassCodexBubble,
  shouldBypassOpencodeBubble,
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  normalizeCodexPermissionToolInput,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
  findPendingPermissionForStateEvent,
  resolveCodexOfficialHookState,
};
