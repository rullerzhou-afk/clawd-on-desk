// Kimi CLI log monitor
// Polls ~/.kimi/logs/kimi*.log for state changes
// Zero dependencies (node built-ins only)

const fs = require("fs");
const path = require("path");
const os = require("os");

const MAX_TRACKED_FILES = 10;
const MAX_PARTIAL_BYTES = 65536;

class KimiLogMonitor {
  /**
   * @param {object} agentConfig - kimi-cli.js config
   * @param {function} onStateChange - (sessionId, state, event, extra) => void
   */
  constructor(agentConfig, onStateChange) {
    this._config = agentConfig;
    this._onStateChange = onStateChange;
    this._interval = null;
    this._logDir = this._resolveDir(agentConfig.logConfig.logDir);
    this._filePattern = agentConfig.logConfig.filePattern || "kimi*.log";
    this._pollIntervalMs = agentConfig.logConfig.pollIntervalMs || 1500;
    this._turnEndDeferMs = agentConfig.logConfig.turnEndDeferMs || 3000;
    this._staleTimeoutMs = agentConfig.logConfig.staleTimeoutMs || 300000;
    // Map<filePath, { offset, sessionId, lastEventTime, lastState, partial, hadToolUse, turnEndTimer }>
    this._tracked = new Map();
    this._startedAtMs = Date.now();
  }

  _resolveDir(dir) {
    if (dir.startsWith("~")) {
      return path.join(os.homedir(), dir.slice(1));
    }
    return dir;
  }

  start() {
    if (this._interval) return;
    this._startedAtMs = Date.now();
    this._poll();
    this._interval = setInterval(() => this._poll(), this._pollIntervalMs);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    for (const [fp, watcher] of this._watchers) {
      try { watcher.close(); } catch {}
    }
    this._watchers.clear();
    for (const tracked of this._tracked.values()) {
      if (tracked.turnEndTimer) {
        clearTimeout(tracked.turnEndTimer);
        tracked.turnEndTimer = null;
      }
    }
    this._tracked.clear();
  }

  _poll() {
    let files;
    try {
      files = fs.readdirSync(this._logDir);
    } catch {
      return; // log dir doesn't exist yet
    }

    const now = Date.now();
    const matched = files
      .filter((f) => this._matchPattern(f))
      .map((f) => {
        const fp = path.join(this._logDir, f);
        try {
          const stat = fs.statSync(fp);
          return { filePath: fp, mtime: stat.mtimeMs, size: stat.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      // Sort by mtime desc — latest log first
      .sort((a, b) => b.mtime - a.mtime);

    // Only track the most recent file(s) that have been written to recently
    for (const entry of matched) {
      const filePath = entry.filePath;
      const isTracked = this._tracked.has(filePath);
      if (!isTracked) {
        // Skip old files that haven't been written to recently
        if (now - entry.mtime > 120000) continue; // older than 2 min
        if (this._tracked.size >= MAX_TRACKED_FILES) {
          this._cleanStaleFiles();
          if (this._tracked.size >= MAX_TRACKED_FILES) continue;
        }
        this._tracked.set(filePath, {
          offset: 0,
          sessionId: null,
          filePath,
          lastEventTime: now,
          lastState: null,
          lastEvent: null,
          partial: "",
          hadToolUse: false,
          turnEndTimer: null,
        });
      }
      this._pollFile(filePath);
    }

    this._cleanStaleFiles();
  }

  _matchPattern(fileName) {
    // Convert glob-like pattern to simple check
    // e.g. "kimi*.log" matches "kimi.log", "kimi.2026-04-13_10-55-25_092015.log"
    const pat = this._filePattern;
    if (pat.endsWith("*.log")) {
      const prefix = pat.slice(0, -5); // "kimi"
      return fileName.startsWith(prefix) && fileName.endsWith(".log");
    }
    if (pat.includes("*")) {
      const parts = pat.split("*");
      if (parts.length === 2) {
        return fileName.startsWith(parts[0]) && fileName.endsWith(parts[1]);
      }
    }
    return fileName === pat;
  }

  _pollFile(filePath) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    const tracked = this._tracked.get(filePath);
    if (!tracked) return;

    if (stat.size <= tracked.offset) return;

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

    const text = tracked.partial + buf.toString("utf8");
    const lines = text.split("\n");
    const remainder = lines.pop() || "";
    tracked.partial = remainder.length > MAX_PARTIAL_BYTES ? "" : remainder;

    for (const line of lines) {
      if (!line.trim()) continue;
      this._processLine(line, tracked);
    }
  }

  _setupWatcher(filePath) {
    if (this._watchers.has(filePath)) return;
    try {
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType === "change") {
          this._pollFile(filePath);
        }
      });
      this._watchers.set(filePath, watcher);
    } catch {
      // fs.watch may fail on some filesystems; polling will still work.
    }
  }

  _processLine(line, tracked) {
    // Skip historical events that predate monitor start
    const ts = this._extractTimestamp(line);
    if (ts && ts < this._startedAtMs - 1500) return;

    // Extract session UUID from the line if present (most Kimi log lines
    // carry the session id after the logger name).
    const lineSessionMatch = line.match(/\s([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\s+-/);
    if (lineSessionMatch) {
      const newSid = "kimi-cli:" + lineSessionMatch[1];
      // If the session ID has changed (e.g. from fallback to real UUID),
      // end the old session so Clawd doesn't leave a stale session stuck
      // in its previous state forever.
      if (tracked.sessionId && tracked.sessionId !== newSid) {
        this._onStateChange(tracked.sessionId, "sleeping", "SessionEnd", {
          cwd: "", sourcePid: null, agentPid: null, sessionTitle: null,
        });
      }
      tracked.sessionId = newSid;
    }

    // Session start / resume
    const sessionMatch = line.match(/(?:Created new session|Resuming session): ([a-f0-9-]+)/);
    if (sessionMatch) {
      tracked.sessionId = "kimi-cli:" + sessionMatch[1];
      tracked.hadToolUse = false;
      this._clearTurnEndTimer(tracked);
      this._emit(tracked, "idle", "session_start");
      return;
    }

    // User input — beginning of a new turn
    if (line.includes("Running soul with user input:")) {
      tracked.hadToolUse = false;
      this._clearTurnEndTimer(tracked);
      this._emit(tracked, "thinking", "user_input");
      return;
    }

    // Tool completion
    const toolMatch = line.match(/Tool (\w+) completed in ([\d.]+)s/);
    if (toolMatch) {
      tracked.hadToolUse = true;
      this._clearTurnEndTimer(tracked);
      const toolName = toolMatch[1];
      const durationSec = parseFloat(toolMatch[2]);
      const eventKey = `tool_${toolName.toLowerCase()}`;

      if (toolName === "Agent") {
        this._emit(tracked, "juggling", eventKey);
      } else if (toolName === "AskUserQuestion") {
        // AskUserQuestion means the user just finished answering a question.
        // Long duration (>5s) likely means the user was actively thinking;
        // send a notification nudge so they know Kimi received the answer.
        this._emit(tracked, "attention", eventKey);
        if (durationSec > 5) {
          this._emit(tracked, "notification", `${eventKey}-nudge`);
        }
      } else {
        this._emit(tracked, "working", eventKey);
      }
      return;
    }

    // LLM step completion — defer turn-end decision
    if (line.includes("LLM step completed in")) {
      // Cancel any existing turn-end timer
      this._clearTurnEndTimer(tracked);

      // Fast path: if this looks like a pure-text final answer (small output,
      // no tools used this turn), go straight to attention/idle without
      // the defer delay so the pet doesn't stay "working" after the user
      // already sees the answer in the terminal.
      const outputMatch = line.match(/output=(\d+)/);
      const outputTokens = outputMatch ? parseInt(outputMatch[1], 10) : 0;
      const isLikelyFinalAnswer = outputTokens > 0 && outputTokens < 300 && !tracked.hadToolUse;

      if (isLikelyFinalAnswer) {
        // Use notification (priority 7) instead of attention (priority 5) so
        // it forcefully interrupts any ongoing thinking/working animation
        // and bypasses the 1s min-display hold.
        this._emit(tracked, "notification", "turn_end");
        return;
      }

      // Emit working immediately (LLM finished thinking; either tools are
      // running or the turn is about to end)
      this._emit(tracked, "working", "llm_step");
      // Start deferred turn-end: if no new tool events arrive within the
      // defer window, treat this as the end of the turn.
      tracked.turnEndTimer = setTimeout(() => {
        tracked.turnEndTimer = null;
        const resolved = tracked.hadToolUse ? "attention" : "idle";
        tracked.hadToolUse = false;
        this._emit(tracked, resolved, "turn_end");
      }, this._turnEndDeferMs);
      return;
    }
  }

  _extractTimestamp(line) {
    // e.g. "2026-04-20 12:45:58.765 | INFO ..."
    const m = line.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    const ts = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
    return Number.isFinite(ts) ? ts : null;
  }

  _clearTurnEndTimer(tracked) {
    if (tracked.turnEndTimer) {
      clearTimeout(tracked.turnEndTimer);
      tracked.turnEndTimer = null;
    }
  }

  _emit(tracked, state, event) {
    // Avoid spamming identical state+event pairs, but still allow refreshing
    // the same state when the underlying event differs (e.g. consecutive
    // llm_step events should reset the turn-end timer even if the visible
    // state doesn't change, so the session updatedAt is refreshed).
    if (state === tracked.lastState && event === tracked.lastEvent) return;
    tracked.lastState = state;
    tracked.lastEvent = event;
    tracked.lastEventTime = Date.now();

    if (!tracked.sessionId) {
      // Derive a fallback session id from the filename if we haven't seen
      // an explicit session start yet.
      const base = path.basename(tracked.filePath, ".log");
      tracked.sessionId = "kimi-cli:" + base;
    }

    this._onStateChange(tracked.sessionId, state, event, {
      cwd: "",
      sourcePid: null,
      agentPid: null,
      sessionTitle: null,
    });
  }

  _cleanStaleFiles() {
    const now = Date.now();
    for (const [filePath, tracked] of this._tracked) {
      const age = now - tracked.lastEventTime;
      if (age > this._staleTimeoutMs) {
        this._clearTurnEndTimer(tracked);
        this._onStateChange(tracked.sessionId, "sleeping", "stale-cleanup", {
          cwd: "",
          sourcePid: null,
          agentPid: null,
          sessionTitle: null,
        });
        this._tracked.delete(filePath);
      }
    }
  }
}

module.exports = KimiLogMonitor;
