// Codex CLI JSONL log monitor
// Polls ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl for state changes
// Zero dependencies (node built-ins only)

const fs = require("fs");
const path = require("path");
const os = require("os");

const APPROVAL_HEURISTIC_MS = 2000;

class CodexLogMonitor {
  /**
   * @param {object} agentConfig - codex.js config (logConfig + logEventMap)
   * @param {function} onStateChange - (sessionId, state, event, extra) => void
   */
  constructor(agentConfig, onStateChange) {
    this._config = agentConfig;
    this._onStateChange = onStateChange;
    this._interval = null;
    // Map<filePath, { offset, sessionId, cwd, lastEventTime, lastState, partial }>
    this._tracked = new Map();
    this._baseDir = this._resolveBaseDir();
  }

  _resolveBaseDir() {
    const dir = this._config.logConfig.sessionDir;
    if (dir.startsWith("~")) {
      return path.join(os.homedir(), dir.slice(1));
    }
    return dir;
  }

  start() {
    if (this._interval) return;
    // Initial scan
    this._poll();
    this._interval = setInterval(
      () => this._poll(),
      this._config.logConfig.pollIntervalMs || 1500
    );
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    for (const tracked of this._tracked.values()) {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
    }
    this._tracked.clear();
  }

  _poll() {
    const dirs = this._getSessionDirs();
    for (const dir of dirs) {
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue; // directory doesn't exist yet
      }
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
        const filePath = path.join(dir, file);
        // Skip files we're not already tracking if they haven't been written recently
        if (!this._tracked.has(filePath)) {
          try {
            const mtime = fs.statSync(filePath).mtimeMs;
            if (now - mtime > 120000) continue; // older than 2 min — completed session, skip
          } catch { continue; }
        }
        this._pollFile(filePath, file);
      }
    }
    this._cleanStaleFiles();
  }

  // Scan recent directories (supports codex resume of older sessions)
  _getSessionDirs() {
    const dirs = [];
    const now = new Date();
    for (let daysAgo = 0; daysAgo <= 7; daysAgo++) {
      const d = new Date(now);
      d.setDate(d.getDate() - daysAgo);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      dirs.push(path.join(this._baseDir, String(yyyy), mm, dd));
    }
    return dirs;
  }

  _pollFile(filePath, fileName) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    let tracked = this._tracked.get(filePath);
    if (!tracked) {
      // New file — extract session ID from filename
      // Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
      const sessionId = this._extractSessionId(fileName);
      if (!sessionId) return;
      tracked = {
        offset: 0,
        sessionId: "codex:" + sessionId,
        cwd: "",
        lastEventTime: Date.now(),
        lastState: null,
        partial: "", // incomplete line buffer
        hadToolUse: false,
      };
      this._tracked.set(filePath, tracked);
    }

    // No new data
    if (stat.size <= tracked.offset) return;

    // Read incremental bytes
    let buf;
    try {
      const fd = fs.openSync(filePath, "r");
      const readLen = stat.size - tracked.offset;
      buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, tracked.offset);
      fs.closeSync(fd);
    } catch {
      return;
    }
    tracked.offset = stat.size;

    // Split into lines, handle partial last line
    const text = tracked.partial + buf.toString("utf8");
    const lines = text.split("\n");
    // Last element might be incomplete — save for next poll
    tracked.partial = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      this._processLine(line, tracked);
    }
  }

  _processLine(line, tracked) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // corrupted line, skip
    }

    const type = obj.type;
    const payload = obj.payload;
    const subtype =
      payload && typeof payload === "object" ? payload.type || "" : "";

    // Build lookup key
    const key = subtype ? type + ":" + subtype : type;

    // Extract CWD from session_meta
    if (type === "session_meta" && payload) {
      tracked.cwd = payload.cwd || "";
    }

    // Approval heuristic: exec_command_end or function_call_output means command finished —
    // clear pending approval timer (these events are not in logEventMap)
    if (key === "event_msg:exec_command_end" || key === "response_item:function_call_output") {
      if (tracked.approvalTimer) {
        clearTimeout(tracked.approvalTimer);
        tracked.approvalTimer = null;
      }
    }

    // Look up state mapping
    const map = this._config.logEventMap;
    const state = map[key];
    if (state === undefined) return; // unmapped event, skip
    if (state === null) return; // explicitly ignored

    // Track tool use per turn — reset on task_started, set on function_call
    if (key === "event_msg:task_started") {
      tracked.hadToolUse = false;
    }
    if (key === "response_item:function_call") {
      tracked.hadToolUse = true;
    }

    // Turn-end: happy if tools were used this turn, idle otherwise
    if (state === "codex-turn-end") {
      if (tracked.approvalTimer) {
        clearTimeout(tracked.approvalTimer);
        tracked.approvalTimer = null;
      }
      const resolved = tracked.hadToolUse ? "attention" : "idle";
      tracked.hadToolUse = false;
      tracked.lastState = resolved;
      tracked.lastEventTime = Date.now();
      this._onStateChange(tracked.sessionId, resolved, key, {
        cwd: tracked.cwd,
        sourcePid: null,
        agentPid: null,
      });
      return;
    }

    // Approval heuristic: function_call starts a 2s timer — if no exec_command_end arrives,
    // assume Codex is waiting for user approval and emit codex-permission
    if (key === "response_item:function_call") {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
      const cmd = this._extractShellCommand(payload);
      if (cmd) {
        tracked.approvalTimer = setTimeout(() => {
          tracked.approvalTimer = null;
          tracked.lastEventTime = Date.now();
          this._onStateChange(tracked.sessionId, "codex-permission", key, {
            cwd: tracked.cwd,
            sourcePid: null,
            agentPid: null,
            permissionDetail: { command: cmd, rawPayload: payload },
          });
        }, APPROVAL_HEURISTIC_MS);
      }
    }

    // Avoid spamming same state
    if (state === tracked.lastState && state === "working") return;
    tracked.lastState = state;
    tracked.lastEventTime = Date.now();

    this._onStateChange(tracked.sessionId, state, key, {
      cwd: tracked.cwd,
      sourcePid: null, // JSONL doesn't contain terminal PID
      agentPid: null, // can't reliably match from log file
    });
  }

  // Extract shell command from function_call payload
  // payload.arguments is a JSON string: {"command":"...","workdir":"...","timeout_ms":...}
  _extractShellCommand(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (payload.name !== "shell_command") return "";
    try {
      const args = typeof payload.arguments === "string"
        ? JSON.parse(payload.arguments) : payload.arguments;
      if (args && args.command) return String(args.command);
    } catch {}
    return "";
  }

  // Extract UUID from rollout filename
  // rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl
  _extractSessionId(fileName) {
    // UUID v7 is the last 5 segments of the filename (before .jsonl)
    const base = fileName.replace(".jsonl", "");
    const parts = base.split("-");
    // UUID: last 5 parts (8-4-4-4-12 hex)
    if (parts.length < 10) return null;
    return parts.slice(-5).join("-");
  }

  // Remove files not updated for 5 minutes
  _cleanStaleFiles() {
    const now = Date.now();
    for (const [filePath, tracked] of this._tracked) {
      const age = now - tracked.lastEventTime;
      if (age > 300000) {
        // 5 min stale — notify session end and stop tracking
        if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
        this._onStateChange(tracked.sessionId, "sleeping", "stale-cleanup", {
          cwd: tracked.cwd,
          sourcePid: null,
          agentPid: null,
        });
        this._tracked.delete(filePath);
      }
    }
  }
}

module.exports = CodexLogMonitor;
