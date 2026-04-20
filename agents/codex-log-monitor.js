// Codex CLI JSONL log monitor
// Polls ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl for state changes
// Zero dependencies (node built-ins only)

const fs = require("fs");
const path = require("path");
const os = require("os");

const APPROVAL_HEURISTIC_MS = 2000;
const MAX_TRACKED_FILES = 50;
const MAX_PARTIAL_BYTES = 65536;
const RECENT_DAY_DIR_CACHE_MS = 60 * 60 * 1000; // 1 hour

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
    this._recentDayDirsCache = [];
    this._recentDayDirsCacheAt = 0;
    this._recentDayDirsDateKey = "";
    this._activeDayDirsCache = null;
    this._activeDayDirsCacheAt = 0;
    this._startedAtMs = Date.now();
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
    this._startedAtMs = Date.now();
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

  _getSessionDirs() {
    const dirs = [];
    const seen = new Set();
    const addDir = (dir) => {
      if (!dir || seen.has(dir)) return;
      seen.add(dir);
      dirs.push(dir);
    };
    const now = new Date();
    for (let daysAgo = 0; daysAgo <= 2; daysAgo++) {
      const d = new Date(now);
      d.setDate(d.getDate() - daysAgo);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      addDir(path.join(this._baseDir, String(yyyy), mm, dd));
    }
    // Fallback: include most recent existing day dirs to handle
    // clock/timezone drift and `codex resume` of older sessions
    for (const dir of this._getCachedRecentExistingDayDirs(7)) addDir(dir);
    // Also include any day dir that has a recently-modified rollout file.
    // Covers Codex desktop app's long-lived conversations where new writes
    // keep landing in the ORIGINAL day dir (which can be weeks/months old).
    for (const dir of this._getActiveDayDirs()) addDir(dir);
    return dirs;
  }

  // Scan baseDir for any day dir containing a rollout-*.jsonl whose mtime
  // is within `withinMs`. Returns the set of such day dirs.
  // Cached for 5s to keep polling cheap.
  _getActiveDayDirs(withinMs = 5 * 60 * 1000) {
    const now = Date.now();
    if (this._activeDayDirsCache && now - this._activeDayDirsCacheAt < 5000) {
      return this._activeDayDirsCache;
    }
    const out = new Set();
    let years;
    try {
      years = fs.readdirSync(this._baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
        .map((d) => d.name);
    } catch {
      this._activeDayDirsCache = [];
      this._activeDayDirsCacheAt = now;
      return [];
    }
    for (const y of years) {
      const yPath = path.join(this._baseDir, y);
      let months;
      try {
        months = fs.readdirSync(yPath, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
          .map((d) => d.name);
      } catch { continue; }
      for (const m of months) {
        const mPath = path.join(yPath, m);
        let days;
        try {
          days = fs.readdirSync(mPath, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
            .map((d) => d.name);
        } catch { continue; }
        for (const day of days) {
          const dPath = path.join(mPath, day);
          let files;
          try {
            files = fs.readdirSync(dPath);
          } catch { continue; }
          for (const file of files) {
            if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
            try {
              const mtime = fs.statSync(path.join(dPath, file)).mtimeMs;
              if (now - mtime < withinMs) {
                out.add(dPath);
                break;
              }
            } catch {}
          }
        }
      }
    }
    this._activeDayDirsCache = Array.from(out);
    this._activeDayDirsCacheAt = now;
    return this._activeDayDirsCache;
  }

  _getCachedRecentExistingDayDirs(limit = 7) {
    const now = Date.now();
    const dateKey = this._getLocalDateKey();
    const cacheStale = now - this._recentDayDirsCacheAt > RECENT_DAY_DIR_CACHE_MS;
    const dayChanged = dateKey !== this._recentDayDirsDateKey;
    if (!this._recentDayDirsCache.length || cacheStale || dayChanged) {
      this._recentDayDirsCache = this._getRecentExistingDayDirs(limit);
      this._recentDayDirsCacheAt = now;
      this._recentDayDirsDateKey = dateKey;
    }
    return this._recentDayDirsCache.slice(0, limit);
  }

  _getLocalDateKey() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  _getRecentExistingDayDirs(limit = 7) {
    const out = [];
    let years;
    try {
      years = fs.readdirSync(this._baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return out;
    }
    for (const y of years) {
      const yPath = path.join(this._baseDir, y);
      let months;
      try {
        months = fs.readdirSync(yPath, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
          .map((d) => d.name)
          .sort((a, b) => b.localeCompare(a));
      } catch { continue; }
      for (const m of months) {
        const mPath = path.join(yPath, m);
        let days;
        try {
          days = fs.readdirSync(mPath, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
            .map((d) => d.name)
            .sort((a, b) => b.localeCompare(a));
        } catch { continue; }
        for (const d of days) {
          out.push(path.join(mPath, d));
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
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
      // Cap tracked files to prevent unbounded Map growth
      if (this._tracked.size >= MAX_TRACKED_FILES) {
        this._cleanStaleFiles();
        if (this._tracked.size >= MAX_TRACKED_FILES) return;
      }
      tracked = {
        offset: 0,
        sessionId: "codex:" + sessionId,
        filePath,
        cwd: "",
        sessionTitle: null,
        lastEventTime: Date.now(),
        lastState: null,
        partial: "",
        hadToolUse: false,
        agentPid: null,
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
    // Last element might be incomplete — save for next poll.
    // Cap at 64KB: lines larger than this (e.g. huge tool output) are discarded —
    // both halves will fail JSON.parse so one state update is silently lost, which
    // is harmless for the pet's display state.
    const remainder = lines.pop() || "";
    tracked.partial = remainder.length > MAX_PARTIAL_BYTES ? "" : remainder;

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

    // Skip historical events that predate monitor start — prevents replay
    // storms on app restart from driving stale state transitions
    if (obj && typeof obj.timestamp === "string") {
      const ts = Date.parse(obj.timestamp);
      if (Number.isFinite(ts) && ts < this._startedAtMs - 1500) return;
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

    // Extract Codex-authored session summary (turn_context.summary).
    // Updates tracked.sessionTitle in place; gets picked up by the next
    // _onStateChange call. Intentionally no metaOnly side-channel —
    // accepts brief staleness until the next state emit.
    const extractedTitle = this._extractSessionTitle(obj);
    if (extractedTitle && extractedTitle !== tracked.sessionTitle) {
      tracked.sessionTitle = extractedTitle;
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
      const agentPid = this._resolveTrackedAgentPid(tracked);
      this._onStateChange(tracked.sessionId, resolved, key, {
        cwd: tracked.cwd,
        sourcePid: agentPid,
        agentPid,
        sessionTitle: tracked.sessionTitle,
      });
      return;
    }

    // Approval heuristic: function_call starts a 2s timer — if no exec_command_end arrives,
    // assume Codex is waiting for user approval and emit codex-permission.
    // Explicit escalated requests (sandbox_permissions/justification) skip the timer.
    if (key === "response_item:function_call") {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
      const cmd = this._extractShellCommand(payload);
      if (cmd) {
        if (this._isExplicitApprovalRequest(payload)) {
          const agentPid = this._resolveTrackedAgentPid(tracked);
          tracked.lastEventTime = Date.now();
          this._onStateChange(tracked.sessionId, "codex-permission", key, {
            cwd: tracked.cwd,
            sourcePid: agentPid,
            agentPid,
            sessionTitle: tracked.sessionTitle,
            permissionDetail: { command: cmd, rawPayload: payload },
          });
          return;
        }
        tracked.approvalTimer = setTimeout(() => {
          tracked.approvalTimer = null;
          const agentPid = this._resolveTrackedAgentPid(tracked);
          tracked.lastEventTime = Date.now();
          this._onStateChange(tracked.sessionId, "codex-permission", key, {
            cwd: tracked.cwd,
            sourcePid: agentPid,
            agentPid,
            sessionTitle: tracked.sessionTitle,
            permissionDetail: { command: cmd, rawPayload: payload },
          });
        }, APPROVAL_HEURISTIC_MS);
      }
    }

    // Avoid spamming same state
    if (state === tracked.lastState && state === "working") return;
    tracked.lastState = state;
    tracked.lastEventTime = Date.now();

    const agentPid = this._resolveTrackedAgentPid(tracked);
    this._onStateChange(tracked.sessionId, state, key, {
      cwd: tracked.cwd,
      sourcePid: agentPid,
      agentPid,
      sessionTitle: tracked.sessionTitle,
    });
  }

  // Codex-authored session summary, extracted from turn_context.summary.
  // Filters "none" / "auto" placeholder values that Codex writes when
  // the model hasn't produced a real summary yet.
  _extractSessionTitle(obj) {
    if (!obj || typeof obj !== "object") return null;
    const payload = obj.payload && typeof obj.payload === "object" ? obj.payload : null;
    if (!payload) return null;
    if (obj.type === "turn_context" && typeof payload.summary === "string") {
      const summary = payload.summary.trim();
      if (summary && summary !== "none" && summary !== "auto") return summary;
    }
    return null;
  }

  // Extract shell command from function_call payload
  // shell_command: {"command":"...","workdir":"..."}
  // exec_command:  {"cmd":"...","workdir":"..."}
  _extractShellCommand(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (payload.name !== "shell_command" && payload.name !== "exec_command") return "";
    try {
      const args = typeof payload.arguments === "string"
        ? JSON.parse(payload.arguments) : payload.arguments;
      if (args && args.command) return String(args.command);
      if (args && args.cmd) return String(args.cmd);
    } catch {}
    return "";
  }

  _isExplicitApprovalRequest(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.name !== "shell_command" && payload.name !== "exec_command") return false;
    try {
      const args = typeof payload.arguments === "string"
        ? JSON.parse(payload.arguments) : payload.arguments;
      if (!args || typeof args !== "object") return false;
      if (args.sandbox_permissions === "require_escalated") return true;
      if (typeof args.justification === "string" && args.justification.trim()) return true;
    } catch {}
    return false;
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

  _resolveTrackedAgentPid(tracked) {
    if (tracked.agentPid && this._isProcessAlive(tracked.agentPid)) {
      return tracked.agentPid;
    }
    const pid = this._findCodexWriterPid(tracked.filePath);
    tracked.agentPid = pid || null;
    return tracked.agentPid;
  }

  _isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err && err.code === "EPERM";
    }
  }

  // Linux-only: find codex process that has the rollout file open via /proc
  _findCodexWriterPid(filePath) {
    if (process.platform !== "linux" || !filePath) return null;
    let procEntries;
    try {
      procEntries = fs.readdirSync("/proc", { withFileTypes: true });
    } catch {
      return null;
    }
    for (const ent of procEntries) {
      if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue;
      const pid = Number(ent.name);
      if (!Number.isFinite(pid) || pid <= 1) continue;
      // Fast prefilter: skip non-codex processes
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!cmd.includes("codex")) continue;
      } catch { continue; }
      let fds;
      try {
        fds = fs.readdirSync(`/proc/${pid}/fd`);
      } catch { continue; }
      for (const fd of fds) {
        try {
          const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (target === filePath) return pid;
        } catch {}
      }
    }
    return null;
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
          sourcePid: tracked.agentPid,
          agentPid: tracked.agentPid,
          sessionTitle: tracked.sessionTitle,
        });
        this._tracked.delete(filePath);
      }
    }
  }
}

module.exports = CodexLogMonitor;
