// Gemini CLI session JSON monitor
// Polls ~/.gemini/tmp/*/chats/session-*.json for state changes
// Legacy only: Gemini CLI runtime integration is hook-only and does not start this monitor.

const fs = require("fs");
const path = require("path");
const os = require("os");

// Gemini writes gemini messages in two passes: text first (no toolCalls),
// then the same message updated with toolCalls after execution/approval.
// Auto-approved tools: ~1.5s gap.  User-approved tools: 10-60s gap.
// Defer long enough so most tool approvals complete before the timer fires.
// Pure text completions (no tools all turn) get feedback after this delay.
const DEFER_COMPLETION_MS = 4000;

const DEBUG = !!(process.env.CLAWD_DEBUG || process.env.CLAWD_DEBUG_GEMINI);

class GeminiLogMonitor {
  /**
   * @param {object} agentConfig - gemini-cli.js config (logConfig)
   * @param {function} onStateChange - (sessionId, state, event, extra) => void
   */
  constructor(agentConfig, onStateChange) {
    this._config = agentConfig;
    this._onStateChange = onStateChange;
    this._interval = null;
    this._tracked = new Map();
    this._pendingCompletions = new Map();
    this._baseDir = this._resolveBaseDir();
    this._cwdMap = null;
    this._projectsMtime = 0;
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
    for (const timer of this._pendingCompletions.values()) clearTimeout(timer);
    this._pendingCompletions.clear();
    this._tracked.clear();
  }

  _loadCwdMap() {
    const projectsPath = path.join(os.homedir(), ".gemini", "projects.json");
    let mtime;
    try {
      mtime = fs.statSync(projectsPath).mtimeMs;
    } catch {
      return;
    }
    if (this._cwdMap && mtime === this._projectsMtime) return;
    this._projectsMtime = mtime;
    try {
      const data = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
      if (data && data.projects) {
        this._cwdMap = {};
        for (const [physPath, dirName] of Object.entries(data.projects)) {
          this._cwdMap[dirName] = physPath;
        }
      }
    } catch {
      // corrupted file, keep old map
    }
  }

  _poll() {
    this._loadCwdMap();

    let projectDirs;
    try {
      projectDirs = fs.readdirSync(this._baseDir, { withFileTypes: true });
    } catch {
      return;
    }

    const now = Date.now();
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const projectDir = entry.name;
      const chatsDir = path.join(this._baseDir, projectDir, "chats");

      let files;
      try {
        files = fs.readdirSync(chatsDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.startsWith("session-") || !file.endsWith(".json")) continue;
        const filePath = path.join(chatsDir, file);

        if (!this._tracked.has(filePath)) {
          try {
            const mtime = fs.statSync(filePath).mtimeMs;
            if (now - mtime > 120000) continue;
          } catch {
            continue;
          }
        }

        this._pollFile(filePath, projectDir);
      }
    }

    this._cleanStale();
  }

  _pollFile(filePath, projectDir) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    const tracked = this._tracked.get(filePath);
    if (tracked && stat.mtimeMs === tracked.mtime) return;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return;
    }

    this._processSession(filePath, data, projectDir, stat.mtimeMs);
  }

  _processSession(filePath, data, projectDir, mtime) {
    const msgs = data.messages;
    if (!msgs || !msgs.length) return;
    const last = msgs[msgs.length - 1];

    if (DEBUG) this._debugLog(msgs.length, last);

    const tools = last.type === "gemini" ? last.toolCalls : undefined;
    const hasTools = !!(tools && tools.length);
    const tracked = this._tracked.get(filePath);

    if (last.type === "user") {
      this._cancelPending(filePath);
      if (tracked) tracked.turnHasTools = false;
      this._emitState(filePath, data, projectDir, mtime, msgs.length, false,
        "thinking", "UserPromptSubmit");
    } else if (last.type === "gemini") {
      if (hasTools) {
        this._cancelPending(filePath);
        const lastTool = tools[tools.length - 1];
        const state = lastTool.status === "error" ? "error" : "attention";
        const event = lastTool.status === "error" ? "PostToolUseFailure" : "Stop";
        this._emitState(filePath, data, projectDir, mtime, msgs.length, true,
          state, event);
        const t = this._tracked.get(filePath);
        if (t) t.turnHasTools = true;
      } else if (tracked && tracked.turnHasTools) {
        // Tools already triggered attention this turn — skip redundant follow-up
        tracked.mtime = mtime;
        tracked.msgCount = msgs.length;
        tracked.hasTools = false;
        tracked.lastEventTime = Date.now();
      } else {
        this._deferCompletion(filePath, data, projectDir, mtime, msgs.length);
      }
    }
  }

  _emitState(filePath, data, projectDir, mtime, msgCount, hasTools, state, event) {
    const tracked = this._tracked.get(filePath);
    if (tracked && tracked.lastState === state
        && tracked.msgCount === msgCount && tracked.hasTools === hasTools) {
      tracked.mtime = mtime;
      tracked.lastEventTime = Date.now();
      return;
    }

    const sessionId = "gemini:" + (data.sessionId || path.basename(filePath, ".json"));
    const cwd = (this._cwdMap && this._cwdMap[projectDir]) || "";

    const prev = this._tracked.get(filePath);
    this._tracked.set(filePath, {
      mtime, sessionId, lastState: state, lastEventTime: Date.now(),
      msgCount, hasTools, cwd, turnHasTools: (prev && prev.turnHasTools) || false,
    });

    this._onStateChange(sessionId, state, event, {
      cwd,
      sourcePid: null,
      agentPid: null,
      ...this._buildUsageExtra(data, sessionId, msgCount, event),
    });
  }

  _deferCompletion(filePath, data, projectDir, mtime, msgCount) {
    this._cancelPending(filePath);

    const sessionId = "gemini:" + (data.sessionId || path.basename(filePath, ".json"));
    const cwd = (this._cwdMap && this._cwdMap[projectDir]) || "";

    const existing = this._tracked.get(filePath);
    if (existing && existing.lastState === "attention"
        && existing.msgCount === msgCount && !existing.hasTools) {
      existing.mtime = mtime;
      existing.lastEventTime = Date.now();
      return;
    }

    if (existing) {
      existing.mtime = mtime;
      existing.lastEventTime = Date.now();
    } else {
      this._tracked.set(filePath, {
        mtime, sessionId, lastState: null, lastEventTime: Date.now(),
        msgCount, hasTools: false, cwd, turnHasTools: false,
      });
    }

    const timer = setTimeout(() => {
      this._pendingCompletions.delete(filePath);
      this._tracked.set(filePath, {
        mtime, sessionId, lastState: "attention", lastEventTime: Date.now(),
        msgCount, hasTools: false, cwd, turnHasTools: false,
      });
      this._onStateChange(sessionId, "attention", "Stop", {
        cwd,
        sourcePid: null,
        agentPid: null,
        ...this._buildUsageExtra(data, sessionId, msgCount, "Stop"),
      });
    }, DEFER_COMPLETION_MS);

    this._pendingCompletions.set(filePath, timer);
  }

  _cancelPending(filePath) {
    const timer = this._pendingCompletions.get(filePath);
    if (timer) {
      clearTimeout(timer);
      this._pendingCompletions.delete(filePath);
    }
  }

  _debugLog(msgCount, lastMsg) {
    if (!this._debugLogPath) {
      const dir = path.join(os.homedir(), ".clawd");
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      this._debugLogPath = path.join(dir, "gemini-debug.log");
    }
    const tools = lastMsg.toolCalls;
    const toolInfo = tools
      ? tools.map(t => `${t.name}(status=${JSON.stringify(t.status)})`).join(", ")
      : "none";
    const contentPreview = typeof lastMsg.content === "string"
      ? lastMsg.content.slice(0, 80).replace(/\n/g, "\\n")
      : JSON.stringify(lastMsg.content || "").slice(0, 80);
    const line = `[${new Date().toISOString()}] msgs=${msgCount} type=${lastMsg.type} tools=[${toolInfo}] | ${contentPreview}\n`;
    try {
      const { rotatedAppend } = require("../src/log-rotate");
      rotatedAppend(this._debugLogPath, line);
    } catch {
      try { fs.appendFileSync(this._debugLogPath, line); } catch {}
    }
  }

  _buildUsageExtra(data, sessionId, msgCount, event) {
    const msgs = data && Array.isArray(data.messages) ? data.messages : [];
    const last = msgs[msgs.length - 1];
    const tokens = last && last.tokens && typeof last.tokens === "object" ? last.tokens : null;
    if (!tokens) return {};
    return {
      tokenUsage: tokens,
      usageEventId: `${sessionId}:${msgCount}:${event || ""}`,
    };
  }

  _cleanStale() {
    const now = Date.now();
    for (const [filePath, tracked] of this._tracked) {
      if (now - tracked.lastEventTime > 300000) {
        this._cancelPending(filePath);
        this._onStateChange(tracked.sessionId, "sleeping", "SessionEnd", {
          cwd: tracked.cwd, sourcePid: null, agentPid: null,
        });
        this._tracked.delete(filePath);
      }
    }
  }
}

module.exports = GeminiLogMonitor;
