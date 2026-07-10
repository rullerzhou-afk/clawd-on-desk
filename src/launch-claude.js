"use strict";

const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
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

const execFileAsync = promisify(execFile);

async function findClaudeCmd(plat = platform(), deps = {}) {
  const _execFileAsync = deps.execFileAsync || execFileAsync;
  const _existsSync = deps.existsSync || fs.existsSync;

  // 1. Try system PATH lookup. This runs async on purpose: the old
  // execFileSync('where'/'which', {timeout:5000}) blocked the Electron main
  // process event loop — which also drives rendering, drag, and topmost — so a
  // slow PATH (huge PATH, mapped network drives) froze the pet for up to 5s on
  // New Session. execFile lets the 5s timeout elapse without stalling the loop.
  try {
    const cmd = plat === "win32" ? "where" : "which";
    const { stdout } = await _execFileAsync(cmd, ["claude"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const existing = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((p) => p && _existsSync(p));
    if (plat === "win32") {
      // npm installs `claude` as BOTH an extensionless POSIX shell script and a
      // launchable shim (claude.cmd) in the same directory, and `where claude`
      // can list the extensionless script first. Handing that script to a
      // terminal raises ERROR_BAD_EXE_FORMAT (0x800700c1): it is not a PE/Win32
      // image, and nothing in our launch path (wt/cmd/powershell) runs POSIX
      // scripts. So prefer a Windows-launchable extension; if `where` surfaced
      // only the extensionless script, probe for its launchable sibling. Only
      // when neither exists do we fall through to the stage-2 npm locations
      // rather than returning the unrunnable script.
      const launchable = existing.find((p) => /\.(com|exe|bat|cmd)$/i.test(p));
      if (launchable) return launchable;
      for (const p of existing) {
        for (const ext of [".cmd", ".exe", ".bat", ".com"]) {
          if (_existsSync(p + ext)) return p + ext;
        }
      }
    } else if (existing.length) {
      return existing[0];
    }
  } catch {}

  // 2. Check common npm global install locations. On Windows we only offer the
  // launchable .cmd shim — never the extensionless POSIX script (see above).
  const candidates = [];
  if (plat === "win32") {
    candidates.push(
      path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
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
    if (_existsSync(p)) return p;
  }

  // 3. Fallback: return "claude" and let the shell resolve it. cmd.exe (the
  // wt/cmd launch layer) resolves a bare name through PATHEXT and so still
  // picks the .cmd shim over the extensionless script.
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
function buildTerminalCandidates(claudePath, claudeArgs, plat = platform(), workDir) {
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
    // wt.exe runs its commandline through CreateProcess (no shell), which cannot
    // execute an npm .cmd/.bat shim or an extensionless POSIX script directly —
    // that raises ERROR_BAD_EXE_FORMAT (0x800700c1). Route the tab through
    // cmd.exe (a real PE), which resolves and runs the shim.
    //
    // Two quoting hazards, both neutralized by the `call "<path>"` prefix:
    //  - Windows Terminal re-tokenizes the args after `--` and re-quotes only
    //    those containing spaces, so we can't rely on our own quotes surviving
    //    verbatim (windowsVerbatimArguments only protects the Node->wt hop).
    //  - cmd.exe's /K strips a *leading* quote unless a narrow preserve rule
    //    holds, which breaks paths like `C:\Program Files (x86)\...`.
    // Prefixing `call` means the /K command never begins with a quote, so cmd
    // keeps the quoted path intact whether wt forwarded it raw or re-quoted it.
    // (We still avoid cmdLine's `/s ""..""` idiom: cmd.exe understands it but
    // wt's tokenizer mangles it.) This path still needs real-Windows validation.
    return [
      {
        bin: "wt.exe",
        args: ["--", "cmd.exe", "/d", "/v:off", "/k", "call", quoteCmdExecutablePath(claudePath), ...claudeArgs],
        extraOpts: { shell: false, windowsVerbatimArguments: true },
      },
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
    // Terminal.app's `do script` shell always starts at $HOME — it does NOT
    // inherit the osascript process cwd — so the working directory must be an
    // explicit `cd` inside the command (`--` guards leading-dash dir names).
    const claudeCmd = [claudePath, ...claudeArgs].map(quoteForPosixShellArg).join(" ");
    const cmd = workDir ? `cd -- ${quoteForPosixShellArg(workDir)} && ${claudeCmd}` : claudeCmd;
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

// #459: open a plain terminal at a directory without launching any agent.
// Same candidate philosophy as buildTerminalCandidates, but the "inner
// command" is just establishing the working directory and leaving a shell.
function buildShellTerminalCandidates(dir, plat = platform()) {
  if (plat === "win32") {
    // NTFS forbids `"` in paths; reject anyway so a crafted string can never
    // splice extra cmd.exe commands after the embedded quote.
    if (dir.includes('"')) {
      throw new TypeError("buildShellTerminalCandidates: dir must not contain double quotes");
    }
    const candidates = [
      // wt -d is a native flag (no shim → no 0x800700c1 class); Node's default
      // arg quoting protects spaces. tryLaunch can only observe whether wt
      // itself spawned, not whether the tab landed in `dir`.
      { bin: "wt.exe", args: ["-d", dir] },
    ];
    // cmd.exe quoting matrix for the quoted `cd /d "<dir>"` payload: `^ & ( )`
    // are literal inside the quotes, `!` stays literal because we pass /v:off,
    // `"` is rejected above — but `%VAR%` expands on the cmd command line EVEN
    // inside quotes and has no command-line escape (caret can't escape %, %%
    // only works in batch files). A %-containing dir therefore skips cmd and
    // falls through to wt / PowerShell, which pass the path literally.
    if (!dir.includes("%")) {
      // Single pre-quoted string after /k — same "command must not start with
      // a quote" rule as buildTerminalCandidates, satisfied by the `cd` prefix.
      candidates.push({
        bin: "cmd.exe",
        args: ["/d", "/v:off", "/s", "/k", `cd /d "${dir}"`],
        extraOpts: { shell: false, windowsVerbatimArguments: true },
      });
    }
    candidates.push(
      // -LiteralPath: plain Set-Location glob-expands `[]` / `?` in paths.
      {
        bin: "powershell.exe",
        args: ["-NoExit", "-Command", `Set-Location -LiteralPath ${quoteForPowerShell(dir)}`],
      },
    );
    return candidates;
  }

  if (plat === "darwin") {
    // Same two-layer quoting and explicit-cd constraint as the darwin branch
    // of buildTerminalCandidates (do script shells start at $HOME).
    const cmd = `cd -- ${quoteForPosixShellArg(dir)} && clear`;
    const appleScript = `tell application "Terminal" to do script "${escapeAppleScriptString(cmd)}"`;
    return [{ bin: "osascript", args: ["-e", appleScript] }];
  }

  // Linux terminals inherit the spawn cwd, so the command only needs to keep
  // the shell alive.
  return [
    { bin: "x-terminal-emulator", args: ["-e", "bash", "-c", "exec bash"] },
    { bin: "xterm", args: ["-e", "bash", "-c", "exec bash"] },
    { bin: "gnome-terminal", args: ["--", "bash", "-c", "exec bash"] },
    { bin: "konsole", args: ["-e", "bash", "-c", "exec bash"] },
    { bin: "alacritty", args: ["-e", "bash", "-c", "exec bash"] },
    { bin: "kitty", args: ["--", "bash", "-c", "exec bash"] },
  ];
}

async function openTerminalAt(dir, deps = {}) {
  const _platform = deps.platform || platform;
  const _tryLaunch = deps.tryLaunch || tryLaunch;

  if (typeof dir !== "string" || !dir) {
    return { ok: false, message: "openTerminalAt: dir must be a non-empty string" };
  }

  const plat = _platform();
  const opts = { detached: true, stdio: "ignore", windowsHide: false, cwd: dir };

  let candidates;
  try {
    candidates = buildShellTerminalCandidates(dir, plat);
  } catch (err) {
    return { ok: false, message: err.message };
  }
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

async function launchClaudeSession(mode, cwd, sessionId, deps = {}) {
  const _platform = deps.platform || platform;
  const _findClaudeCmd = deps.findClaudeCmd || findClaudeCmd;
  const _tryLaunch = deps.tryLaunch || tryLaunch;

  const plat = _platform();
  const claudePath = await _findClaudeCmd(plat);
  const claudeArgs = buildClaudeArgs(mode, sessionId);
  const workDir = cwd || homedir();
  const opts = { detached: true, stdio: "ignore", windowsHide: false, cwd: workDir };

  const candidates = buildTerminalCandidates(claudePath, claudeArgs, plat, workDir);
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
  buildShellTerminalCandidates,
  openTerminalAt,
  findClaudeCmd,
  buildCmdLaunchCommand,
  normalizeClaudeSessionId,
  quoteCmdExecutablePath,
  quoteForPowerShell,
  tryLaunch,
};
