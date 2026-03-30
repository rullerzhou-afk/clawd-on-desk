// src/server.js — HTTP server + routes (/state, /permission, /health)
// Extracted from main.js L1337-1528

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  DEFAULT_SERVER_PORT,
  clearRuntimeConfig,
  getPortCandidates,
  readRuntimePort,
  writeRuntimeConfig,
} = require("../hooks/server-config");

module.exports = function initServer(ctx) {

let httpServer = null;
let activeServerPort = null;

function getHookServerPort() {
  return activeServerPort || readRuntimePort() || DEFAULT_SERVER_PORT;
}

function syncClawdHooks() {
  try {
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

function syncCursorHooks() {
  try {
    const { registerCursorHooks } = require("../hooks/cursor-install.js");
    const { added, updated } = registerCursorHooks({ silent: true, port: getHookServerPort() });
    if (added > 0 || updated > 0) {
      console.log(`Clawd: synced Cursor hooks (added ${added}, updated ${updated})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync Cursor hooks:", err.message);
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

// Truncate large string values in objects (recursive) — bubble only needs a preview
const PREVIEW_MAX = 500;
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

// Watch ~/.claude/ directory for settings.json overwrites (e.g. CC-Switch)
// that wipe our hooks. Re-register when hooks disappear.
// Watch the directory (not the file) because atomic rename replaces the inode
// and fs.watch on the old file silently stops firing on Windows.
let settingsWatcher = null;
const HOOK_MARKER = "clawd-hook.js";
const SETTINGS_FILENAME = "settings.json";
function watchSettingsForHookLoss() {
  const settingsDir = path.join(os.homedir(), ".claude");
  const settingsPath = path.join(settingsDir, SETTINGS_FILENAME);
  let debounceTimer = null;
  let lastSyncTime = 0;
  try {
    settingsWatcher = fs.watch(settingsDir, (_event, filename) => {
      if (filename && filename !== SETTINGS_FILENAME) return;
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        // Rate-limit: don't re-sync within 5s to avoid write wars with CC-Switch
        if (Date.now() - lastSyncTime < 5000) return;
        try {
          const raw = fs.readFileSync(settingsPath, "utf-8");
          if (!raw.includes(HOOK_MARKER)) {
            console.log("Clawd: hooks wiped from settings.json — re-registering");
            lastSyncTime = Date.now();
            syncClawdHooks();
          }
        } catch {}
      }, 1000);
    });
    settingsWatcher.on("error", (err) => {
      console.warn("Clawd: settings watcher error:", err.message);
    });
  } catch (err) {
    console.warn("Clawd: failed to watch settings directory:", err.message);
  }
}

function startHttpServer() {
  httpServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/state") {
      sendStateHealthResponse(res);
    } else if (req.method === "POST" && req.url === "/state") {
      let body = "";
      let bodySize = 0;
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return;
        bodySize += chunk.length;
        if (bodySize > 1024) { tooLarge = true; return; }
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
          const { state, svg, session_id, event } = data;
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
          if (ctx.STATE_SVGS[state]) {
            const sid = session_id || "default";
            if (state.startsWith("mini-") && !svg) {
              res.writeHead(400);
              res.end("mini states require svg override");
              return;
            }
            if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "Stop") {
              for (const perm of [...ctx.pendingPermissions]) {
                if (perm.sessionId === sid) {
                  ctx.resolvePermissionEntry(perm, "deny", "User answered in terminal");
                }
              }
            }
            if (svg) {
              const safeSvg = path.basename(svg);
              ctx.setState(state, safeSvg);
            } else {
              ctx.updateSession(sid, state, event, source_pid, cwd, editor, pidChain, agentPid, agentId, host, headless, display_svg);
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

        if (ctx.doNotDisturb) {
          ctx.permLog("SKIPPED: DND mode");
          ctx.sendPermissionResponse(res, "deny", "Clawd is in Do Not Disturb mode");
          return;
        }

        try {
          const data = JSON.parse(body);
          const toolName = typeof data.tool_name === "string" ? data.tool_name : "Unknown";
          const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
          const toolInput = truncateDeep(rawInput);
          const sessionId = data.session_id || "default";
          const rawSuggestions = Array.isArray(data.permission_suggestions) ? data.permission_suggestions : [];
          // Merge multiple addRules suggestions (e.g. piped commands) into one button
          const addRulesItems = rawSuggestions.filter(s => s && s.type === "addRules");
          const suggestions = addRulesItems.length > 1
            ? [
                ...rawSuggestions.filter(s => s && s.type !== "addRules"),
                {
                  type: "addRules",
                  destination: addRulesItems[0].destination || "localSettings", // CC sends uniform destination per request
                  behavior: addRulesItems[0].behavior || "allow",
                  rules: addRulesItems.flatMap(s =>
                    Array.isArray(s.rules) ? s.rules : [{ toolName: s.toolName, ruleContent: s.ruleContent }]
                  ),
                },
              ]
            : rawSuggestions;

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

          // Elicitation (AskUserQuestion) — show notification bubble, not permission bubble.
          // User clicks "Go to Terminal" → deny → Claude Code falls back to terminal.
          if (toolName === "AskUserQuestion") {
            ctx.permLog(`ELICITATION: tool=${toolName} session=${sessionId}`);
            ctx.updateSession(sessionId, "notification", "Elicitation", null, "", null, null, null, "claude-code");

            const permEntry = { res, abortHandler: null, suggestions: [], sessionId, bubble: null, hideTimer: null, toolName, toolInput, resolvedSuggestion: null, createdAt: Date.now(), isElicitation: true };
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

          const permEntry = { res, abortHandler: null, suggestions, sessionId, bubble: null, hideTimer: null, toolName, toolInput, resolvedSuggestion: null, createdAt: Date.now() };
          const abortHandler = () => {
            if (res.writableFinished) return;
            ctx.permLog("abortHandler fired");
            ctx.resolvePermissionEntry(permEntry, "deny", "Client disconnected");
          };
          permEntry.abortHandler = abortHandler;
          res.on("close", abortHandler);

          ctx.pendingPermissions.push(permEntry);

          ctx.permLog(`showing bubble: tool=${toolName} session=${sessionId} suggestions=${suggestions.length} stack=${ctx.pendingPermissions.length}`);
          ctx.showPermissionBubble(permEntry);
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const listenPorts = getPortCandidates();
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
    writeRuntimeConfig(activeServerPort);
    console.log(`Clawd state server listening on 127.0.0.1:${activeServerPort}`);
    syncClawdHooks();
    syncCursorHooks();
    watchSettingsForHookLoss();
  });

  httpServer.listen(listenPorts[listenIndex], "127.0.0.1");
}

function cleanup() {
  clearRuntimeConfig();
  if (settingsWatcher) settingsWatcher.close();
  if (httpServer) httpServer.close();
}

return { startHttpServer, getHookServerPort, syncClawdHooks, syncCursorHooks, cleanup };

};
