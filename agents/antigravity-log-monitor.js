const fs = require("fs");
const path = require("path");
const os = require("os");

class AntigravityLogMonitor {
  constructor(agentConfig, onStateChange) {
    this._config = agentConfig;
    this._onStateChange = onStateChange;
    this._interval = null;
    this._baseDir = this._resolveBaseDir();
    this._trackedFile = null;
    this._lineCount = 0;
    this._lastState = null;
    this._lastSessionId = "antigravity:main";
    this._idleTimer = null;
    this._lastAgentPid = null;
    this._lastWorkAt = 0;
  }

  _resolveBaseDir() {
    const dir = this._config.logConfig.logsDir;
    if (dir.startsWith("~")) return path.join(os.homedir(), dir.slice(1));
    return dir;
  }

  start() {
    if (this._interval) return;
    this._poll();
    this._interval = setInterval(() => this._poll(), this._config.logConfig.pollIntervalMs || 1500);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this._trackedFile = null;
    this._lineCount = 0;
    this._lastState = null;
  }

  _poll() {
    const latest = this._findLatestLogFile();
    if (!latest) return;
    const switched = latest !== this._trackedFile;
    this._trackedFile = latest;

    let text;
    try {
      text = fs.readFileSync(latest, "utf8");
    } catch {
      return;
    }

    const lines = text.split(/\r?\n/).filter(Boolean);
    const startIndex = switched
      ? Math.max(0, lines.length - (this._config.logConfig.tailLinesOnStart || 200))
      : Math.min(this._lineCount, lines.length);
    const freshLines = lines.slice(startIndex);
    this._lineCount = lines.length;

    for (const line of freshLines) this._processLine(line);
  }

  _findLatestLogFile() {
    let dirs;
    try {
      dirs = fs.readdirSync(this._baseDir, { withFileTypes: true });
    } catch {
      return null;
    }

    let best = null;
    let bestMtime = -1;
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(this._baseDir, entry.name, this._config.logConfig.fileName);
      try {
        const stat = fs.statSync(candidate);
        if (stat.mtimeMs > bestMtime) {
          best = candidate;
          bestMtime = stat.mtimeMs;
        }
      } catch {}
    }
    return best;
  }

  _processLine(line) {
    const plannerMatch = line.match(/planner_generator\.go:283\] Requesting planner/);
    if (plannerMatch) {
      const now = Date.now();
      if (now - this._lastWorkAt > 2500) {
        this._emit(this._lastSessionId, "thinking", "BeforeAgent");
      }
      return;
    }

    const overlayMatch = line.match(/updateActuationOverlay\((\{.*\})\)/);
    if (overlayMatch) {
      let payload;
      try {
        payload = JSON.parse(overlayMatch[1]);
      } catch {
        return;
      }
      if (payload.cascadeId) this._lastSessionId = `antigravity:${payload.cascadeId}`;
      if (payload.passthroughEnabled === false) return;
      if (payload.capturingScreenshot === true && !payload.displayString) {
        this._lastWorkAt = Date.now();
        this._emit(this._lastSessionId, "working", "BeforeTool", "Taking screenshot...");
        return;
      }
      this._lastWorkAt = Date.now();
      this._emit(this._lastSessionId, "working", "BeforeTool", payload.displayString || null);
      return;
    }

    if (/error executing cascade step:/i.test(line)) {
      this._emit(this._lastSessionId, "error", "PostToolUseFailure");
    }
  }

  _emit(sessionId, state, event, displayString = null) {
    this._lastState = state;
    const extra = {
      cwd: "",
      sourcePid: null,
      agentPid: this._lastAgentPid,
      display_svg: null,
    };
    if (displayString) extra.displayString = displayString;
    this._onStateChange(sessionId, state, event, extra);
    this._scheduleIdle(sessionId, extra);
  }

  _scheduleIdle(sessionId, extra) {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this._lastState = "idle";
      this._onStateChange(sessionId, "idle", "SessionIdle", extra);
    }, this._config.logConfig.idleAfterMs || 6000);
  }
}

module.exports = AntigravityLogMonitor;
