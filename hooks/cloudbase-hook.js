// CloudBase CLI process monitor — detects tcb/cloudbase commands and maps to pet states
// Used by main.js; no hook system in the CLI, so we poll processes.
// Exit state (success/error) is handled by cloudbase-shell-hook.sh via ✖ detection.
// This monitor only handles: process appear → running state, process disappear → sleeping.

const { execSync } = require("child_process");

const cloudbaseConfig = require("../agents/cloudbase-cli");

// Sort command keys by length descending so longer matches win
const SORTED_COMMANDS = Object.keys(cloudbaseConfig.commandStateMap)
  .sort((a, b) => b.length - a.length);

class CloudbaseCliMonitor {
  /**
   * @param {function} onStateChange - callback(sessionId, state, meta)
   */
  constructor(onStateChange) {
    this._onStateChange = onStateChange;
    this._timer = null;
    this._trackedProcesses = new Map(); // pid → { state, commandLine, startTime }
    this._exitHolds = new Map();        // pid → { expireAt }
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll(), cloudbaseConfig.pollConfig.pollIntervalMs);
    this._poll();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._trackedProcesses.clear();
    this._exitHolds.clear();
  }

  _poll() {
    const currentPids = this._detectProcesses();
    const now = Date.now();

    // Track new processes
    for (const proc of currentPids) {
      if (!this._trackedProcesses.has(proc.pid)) {
        const state = this._matchCommandState(proc.commandLine);
        const info = { state, commandLine: proc.commandLine, startTime: now };
        this._trackedProcesses.set(proc.pid, info);

        this._onStateChange(
          `tcb-${proc.pid}`,
          state,
          { agent_id: "cloudbase-cli", agent_pid: proc.pid, cwd: proc.cwd || "" }
        );
      }
    }

    // Detect exited processes
    const currentPidSet = new Set(currentPids.map(p => p.pid));
    for (const [pid, info] of this._trackedProcesses) {
      if (!currentPidSet.has(pid)) {
        // Process exited — don't send exit state here.
        // The shell hook (cloudbase-shell-hook.sh) handles success/error detection
        // by checking for ✖ in command output. We just clean up and send SessionEnd
        // after a brief hold to let the shell hook's state display first.
        this._trackedProcesses.delete(pid);
        this._exitHolds.set(pid, {
          expireAt: now + cloudbaseConfig.pollConfig.exitHoldMs,
        });
      }
    }

    // Clean expired exit holds → send SessionEnd
    for (const [pid, hold] of this._exitHolds) {
      if (now >= hold.expireAt) {
        this._exitHolds.delete(pid);
        this._onStateChange(
          `tcb-${pid}`,
          "sleeping",
          { agent_id: "cloudbase-cli", event: "SessionEnd" }
        );
      }
    }
  }

  /**
   * Detect running tcb/cloudbase processes via system commands.
   * Returns array of { pid, commandLine, cwd }
   */
  _detectProcesses() {
    const isWin = process.platform === "win32";
    const results = [];

    try {
      if (isWin) {
        const out = execSync(
          'wmic process where "CommandLine like \'%cloudbase%\' or CommandLine like \'%tcb%\' or Name=\'tcb.exe\' or Name=\'cloudbase.exe\'" get ProcessId,CommandLine /format:csv',
          { encoding: "utf8", timeout: 3000, windowsHide: true }
        );
        for (const line of out.trim().split("\n")) {
          if (!line.includes(",")) continue;
          const parts = line.split(",");
          const cmdLine = (parts[1] || "").trim();
          const pid = parseInt(parts[2], 10);
          if (!pid || isNaN(pid)) continue;
          if (!this._isCloudbaseCommand(cmdLine)) continue;
          results.push({ pid, commandLine: cmdLine, cwd: "" });
        }
      } else {
        const out = execSync(
          "ps -eo pid,args 2>/dev/null || ps aux 2>/dev/null",
          { encoding: "utf8", timeout: 2000 }
        );
        for (const line of out.trim().split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const match = trimmed.match(/^\s*(\d+)\s+(.+)$/);
          if (!match) continue;
          const pid = parseInt(match[1], 10);
          const cmdLine = match[2];
          if (!pid || isNaN(pid)) continue;
          if (!this._isCloudbaseCommand(cmdLine)) continue;
          results.push({ pid, commandLine: cmdLine, cwd: "" });
        }
      }
    } catch {
      // Process detection failed silently
    }

    return results;
  }

  _isCloudbaseCommand(cmdLine) {
    if (!cmdLine) return false;
    const lower = cmdLine.toLowerCase();
    return (
      lower.includes("@cloudbase/cli") ||
      lower.includes("/tcb ") ||
      lower.includes("/cloudbase ") ||
      lower.includes("\\tcb ") ||
      lower.includes("\\cloudbase ") ||
      /\btcb\s/.test(lower) ||
      /\bcloudbase\s/.test(lower)
    );
  }

  _matchCommandState(cmdLine) {
    if (!cmdLine) return "idle";
    const lower = cmdLine.toLowerCase();
    for (const key of SORTED_COMMANDS) {
      if (lower.includes(key)) {
        return cloudbaseConfig.commandStateMap[key];
      }
    }
    return "working";
  }
}

module.exports = CloudbaseCliMonitor;
