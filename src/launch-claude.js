"use strict";

const { spawn, execFileSync } = require("child_process");
const { platform, homedir } = require("os");
const path = require("path");
const fs = require("fs");
const {
  quoteForCmd,
  quoteForPosixShellArg,
  escapeAppleScriptString,
} = require("./remote-ssh-quote");

const SAFE_CLAUDE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

// PowerShell single-quoted string quoting.
//
// Inside a PowerShell single-quoted string the only character that needs
// escaping is `'` itself (doubled). Single-quoted strings are fully literal:
// no `$`, backtick, `;`, `&`, `()` or `$()` interpolation happens. That means a
// user-supplied sessionId can't break out of the string or inject commands.
// The result must be embedded inside a `& <quoted> <quoted> ...` invocation by
// the caller. We keep this local rather than in remote-ssh-quote.js because no
// remote-ssh code path uses PowerShell.
function quoteForPowerShell(arg) {
  if (typeof arg !== "string") {
    throw new TypeError("quoteForPowerShell: arg must be a string");
  }
  return "'" + arg.replace(/'/g, "''") + "'";
}

function quoteCmdExecutablePath(arg) {
  if (typeof arg !== "string") {
    throw new TypeError("quoteCmdExecutablePath: arg must be a string");
  }
  if (arg.includes('"')) {
    throw new TypeError("quoteCmdExecutablePath: executable path must not contain double quotes");
  }
  return `"${arg}"`;
}

function buildCmdLaunchCommand(executablePath, args) {
  return `"${[quoteCmdExecutablePath(executablePath), ...args.map(quoteForCmd)].join(" ")}"`;
}

function normalizeClaudeSessionId(sessionId) {
  if (sessionId == null || sessionId === "") return "";
  if (typeof sessionId !== "string") {
    throw new TypeError("normalizeClaudeSessionId: sessionId must be a string");
  }
  const normalized = sessionId.trim();
  if (!normalized || !SAFE_CLAUDE_SESSION_ID.test(normalized)) {
    throw new Error("Invalid Claude session ID. Use only letters, numbers, underscores, and hyphens.");
  }
  return normalized;
}

// Spawn a detached terminal process. Resolves { ok: true } once the process
// itself starts (the "spawn" event), or { ok: false, error } if the OS refuses
// to launch it (e.g. wt.exe not installed). NOTE: this only observes whether
// the *terminal* launched — the terminal is detached with stdio ignored, so we
// can't see whether `claude` inside it succeeded. Resolving claude's real path
// up front (findClaudeCmd) is what guards the inner command; terminal-level
// fallback is purely about terminal availability. Same contract as
// remote-ssh-ipc's tryLaunch.
function tryLaunch(bin, args, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, opts);
    } catch (err) {
      resolve({ ok: false, error: err });
      return;
    }
    let resolved = false;
    const onSpawn = () => {
      if (resolved) return;
      resolved = true;
      child.removeListener("error", onError);
      child.on("error", () => {});
      try { child.unref(); } catch {}
      resolve({ ok: true, child });
    };
    const onError = (err) => {
      if (resolved) return;
      resolved = true;
      child.removeListener("spawn", onSpawn);
      resolve({ ok: false, error: err });
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function findClaudeCmd(plat = platform()) {
  // 1. Try system PATH lookup
  try {
    const cmd = plat === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["claude"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const lines = out.trim().split(/\r?\n/);
    for (const line of lines) {
      const p = line.trim();
      if (p && fs.existsSync(p)) return p;
    }
  } catch {}

  // 2. Check common npm global install locations
  const candidates = [];
  if (plat === "win32") {
    candidates.push(
      path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
      path.join(process.env.APPDATA || "", "npm", "claude"),
      path.join(process.env.LOCALAPPDATA || "", "npm", "claude.cmd"),
    );
  } else {
    candidates.push(
      path.join(homedir(), ".npm-global", "bin", "claude"),
      "/usr/local/bin/claude",
      path.join(homedir(), ".local", "bin", "claude"),
    );
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // 3. Fallback: return "claude" and let the shell resolve it
  return "claude";
}

function buildClaudeArgs(mode, sessionId) {
  const args = [];
  if (mode === "dangerous" || mode === "resume-dangerous") args.push("--dangerously-skip-permissions");
  if (mode === "continue") args.push("-c");
  if (mode === "resume" || mode === "resume-dangerous") {
    const normalizedSessionId = normalizeClaudeSessionId(sessionId);
    if (normalizedSessionId) args.push("--resume", normalizedSessionId);
  }
  return args;
}

// Build the ordered list of terminal launch candidates. Shell-backed
// candidates quote the resolved claude path and args for their shell layer; the
// only user-entered arg is the resume session ID, which buildClaudeArgs
// validates before this point. The argv-array candidates (wt.exe `--`) need no
// quoting — the OS passes argv verbatim without a shell.
function buildTerminalCandidates(claudePath, claudeArgs, plat = platform()) {
  if (plat === "win32") {
    // cmd.exe /k: command paths with spaces must use cmd's special
    // `""C:\Program Files\...\claude.cmd" args"` form. Plain quoteForCmd on
    // the first token starts with a caret-escaped quote, which cmd.exe does not
    // treat as the executable delimiter. Args still use quoteForCmd, and the
    // only user-entered arg (resume session ID) has already been allow-listed
    // before cmd.exe can pass it through an npm .cmd shim's second parse.
    const cmdLine = buildCmdLaunchCommand(claudePath, claudeArgs);
    // powershell.exe -Command: call operator `&` + single-quoted PS strings.
    const psCmd = "& " + [claudePath, ...claudeArgs].map(quoteForPowerShell).join(" ");
    return [
      { bin: "wt.exe", args: ["--", claudePath, ...claudeArgs] },
      {
        bin: "cmd.exe",
        args: ["/d", "/v:off", "/s", "/k", cmdLine],
        extraOpts: { shell: false, windowsVerbatimArguments: true },
      },
      { bin: "powershell.exe", args: ["-NoExit", "-Command", psCmd] },
    ];
  }

  if (plat === "darwin") {
    // Two-layer quoting: POSIX shell quote each token → join → AppleScript
    // string escape → embed in `do script "..."`.
    const cmd = [claudePath, ...claudeArgs].map(quoteForPosixShellArg).join(" ");
    const appleScript = `tell application "Terminal" to do script "${escapeAppleScriptString(cmd)}"`;
    return [{ bin: "osascript", args: ["-e", appleScript] }];
  }

  // Linux: POSIX shell quote each token, keep the terminal open after claude
  // exits with `; exec bash`. The whole string is one argv to `bash -c`.
  const cmd = [claudePath, ...claudeArgs].map(quoteForPosixShellArg).join(" ");
  const keepOpen = `${cmd}; exec bash`;
  return [
    { bin: "x-terminal-emulator", args: ["-e", "bash", "-c", keepOpen] },
    { bin: "xterm", args: ["-e", "bash", "-c", keepOpen] },
    { bin: "gnome-terminal", args: ["--", "bash", "-c", keepOpen] },
    { bin: "konsole", args: ["-e", "bash", "-c", keepOpen] },
    { bin: "alacritty", args: ["-e", "bash", "-c", keepOpen] },
    { bin: "kitty", args: ["--", "bash", "-c", keepOpen] },
  ];
}

async function launchClaudeSession(mode, cwd, sessionId, deps = {}) {
  const _platform = deps.platform || platform;
  const _findClaudeCmd = deps.findClaudeCmd || findClaudeCmd;
  const _tryLaunch = deps.tryLaunch || tryLaunch;

  const plat = _platform();
  const claudePath = _findClaudeCmd(plat);
  const claudeArgs = buildClaudeArgs(mode, sessionId);
  const workDir = cwd || homedir();
  const opts = { detached: true, stdio: "ignore", windowsHide: false, cwd: workDir };

  const candidates = buildTerminalCandidates(claudePath, claudeArgs, plat);
  let lastError = null;
  for (const candidate of candidates) {
    const result = await _tryLaunch(candidate.bin, candidate.args, {
      ...opts,
      ...(candidate.extraOpts || {}),
    });
    if (result.ok) return { ok: true, terminal: candidate.bin };
    lastError = result.error;
  }

  return {
    ok: false,
    message: (lastError && lastError.message) || "could not spawn terminal",
  };
}

module.exports = {
  launchClaudeSession,
  buildClaudeArgs,
  buildTerminalCandidates,
  findClaudeCmd,
  buildCmdLaunchCommand,
  normalizeClaudeSessionId,
  quoteCmdExecutablePath,
  quoteForPowerShell,
  tryLaunch,
};
