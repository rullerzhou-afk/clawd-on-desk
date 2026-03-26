// Process tree utilities for Clawd
// Used by hooks and plugins to find terminal PID, editor detection, and agent PID

const { execSync } = require("child_process");
const path = require("path");

// Terminal app detection
const TERMINAL_NAMES_WIN = new Set([
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "code.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
  "conemu64.exe", "conemu.exe", "hyper.exe", "tabby.exe",
  "antigravity.exe", "warp.exe", "iterm.exe", "ghostty.exe",
]);
const TERMINAL_NAMES_MAC = new Set([
  "terminal", "iterm2", "alacritty", "wezterm-gui", "kitty",
  "hyper", "tabby", "warp", "ghostty",
]);

const SYSTEM_BOUNDARY_WIN = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);
const SYSTEM_BOUNDARY_MAC = new Set(["launchd", "init", "systemd"]);

// Editor detection — process name → URI scheme name (for VS Code/Cursor tab focus)
const EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor" };
const EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor" };

// Claude Code process detection
const CLAUDE_NAMES_WIN = new Set(["claude.exe"]);
const CLAUDE_NAMES_MAC = new Set(["claude"]);

// OpenCode/Crush process detection
const OPENCODE_NAMES_WIN = new Set(["opencode.exe", "crush.exe"]);
const OPENCODE_NAMES_MAC = new Set(["opencode", "crush"]);

/**
 * Walk the process tree to find stable terminal PID.
 * Returns an object with:
 * - stablePid: the terminal PID or highest non-system PID
 * - detectedEditor: "code" or "cursor" if detected
 * - agentPid: detected agent PID (claude/opencode/crush)
 * - pidChain: all PIDs visited during tree walk
 *
 * @param {object} options
 * @param {string[]} options.agentNames - Additional agent process names to detect
 * @param {string[]} options.agentPatterns - Patterns to match in node/bun command line
 * @returns {{ stablePid: number|null, detectedEditor: string|null, agentPid: number|null, pidChain: number[] }}
 */
function walkProcessTree(options = {}) {
  const { agentNames = [], agentPatterns = [] } = options;
  const isWin = process.platform === "win32";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : TERMINAL_NAMES_MAC;
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : SYSTEM_BOUNDARY_MAC;
  const editorMap = isWin ? EDITOR_MAP_WIN : EDITOR_MAP_MAC;

  // Default agent detection
  const claudeNames = isWin ? CLAUDE_NAMES_WIN : CLAUDE_NAMES_MAC;
  const opencodeNames = isWin ? OPENCODE_NAMES_WIN : OPENCODE_NAMES_MAC;
  const allAgentNames = new Set([...claudeNames, ...opencodeNames, ...agentNames]);

  let pid = process.ppid;
  let lastGoodPid = pid;
  let terminalPid = null;
  const pidChain = [];
  let detectedEditor = null;
  let agentPid = null;

  for (let i = 0; i < 8; i++) {
    let name, parentPid;
    try {
      if (isWin) {
        const out = execSync(
          `wmic process where "ProcessId=${pid}" get Name,ParentProcessId /format:csv`,
          { encoding: "utf8", timeout: 1500, windowsHide: true }
        );
        const lines = out.trim().split("\n").filter(l => l.includes(","));
        if (!lines.length) break;
        const parts = lines[lines.length - 1].split(",");
        name = (parts[1] || "").trim().toLowerCase();
        parentPid = parseInt(parts[2], 10);
      } else {
        const ppidOut = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        const commOut = execSync(`ps -o comm= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        name = path.basename(commOut).toLowerCase();
        // macOS: VS Code binary is "Electron" — check full comm path for editor detection
        if (!detectedEditor) {
          const fullLower = commOut.toLowerCase();
          if (fullLower.includes("visual studio code")) detectedEditor = "code";
          else if (fullLower.includes("cursor.app")) detectedEditor = "cursor";
        }
        parentPid = parseInt(ppidOut, 10);
      }
    } catch { break; }

    pidChain.push(pid);

    if (!detectedEditor && editorMap[name]) detectedEditor = editorMap[name];

    // Agent detection: direct binary match, or node/bun running agent
    if (!agentPid) {
      if (allAgentNames.has(name)) {
        agentPid = pid;
      } else if (name === "node.exe" || name === "node" || name === "bun") {
        try {
          const cmdOut = isWin
            ? execSync(`wmic process where "ProcessId=${pid}" get CommandLine /format:csv`,
                { encoding: "utf8", timeout: 500, windowsHide: true })
            : execSync(`ps -o command= -p ${pid}`, { encoding: "utf8", timeout: 500 });
          // Check for known agent patterns
          const patterns = ["claude-code", "@anthropic-ai", "opencode", "crush", ...agentPatterns];
          if (patterns.some(p => cmdOut.includes(p))) {
            agentPid = pid;
          }
        } catch {}
      }
    }

    if (systemBoundary.has(name)) break;
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }

  return {
    stablePid: terminalPid || lastGoodPid,
    detectedEditor,
    agentPid,
    pidChain,
  };
}

module.exports = {
  walkProcessTree,
  TERMINAL_NAMES_WIN,
  TERMINAL_NAMES_MAC,
  SYSTEM_BOUNDARY_WIN,
  SYSTEM_BOUNDARY_MAC,
  EDITOR_MAP_WIN,
  EDITOR_MAP_MAC,
  CLAUDE_NAMES_WIN,
  CLAUDE_NAMES_MAC,
  OPENCODE_NAMES_WIN,
  OPENCODE_NAMES_MAC,
};
