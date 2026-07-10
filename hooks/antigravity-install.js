#!/usr/bin/env node
// Merge Clawd Antigravity hooks into ~/.gemini/config/hooks.json.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const { stdoutForAntigravityEvent } = require("./antigravity-stdout");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  buildPortableStatuslineCommand,
  decodeWindowsEncodedCommand,
  extractFirstQuotedToken,
  windowsPowerShellBin,
} = require("./json-utils");

const HOOK_GROUP_ID = "clawd";
const MARKER = "antigravity-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".gemini", "config");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "hooks.json");
const STATUSLINE_MARKER = "antigravity-statusline.js";
const DEFAULT_STATUSLINE_SETTINGS_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli");
const DEFAULT_STATUSLINE_SETTINGS_PATH = path.join(DEFAULT_STATUSLINE_SETTINGS_DIR, "settings.json");

// PreToolUse intentionally NOT registered. Antigravity 1.0.1 LLMs proactively
// call the built-in `ask_permission` tool before sensitive actions, which then
// triggers agy's native 5-option menu — there's no way for a hook to suppress
// that menu. Layering a Clawd bubble on top of (or in front of) the native
// menu yields 8-10 confirmations for a single user task.
// Antigravity stays a state-only integration; agy native menu owns permission.
const ANTIGRAVITY_HOOK_EVENTS = [
  "PreInvocation",
  "PostToolUse",
  "PostInvocation",
  "Stop",
];
const DEFAULT_HOOK_TIMEOUT_SECONDS = 10;
// #568 budget: stdin timeout + child timeout must stay below
// DEFAULT_HOOK_TIMEOUT_SECONDS with real headroom, or the outer hooks.json
// timeout kills the wrapper before the fallback line is printed. Measured
// worst case (never-closed stdin + hung child) at 2+7 was 9.5-9.7s on a warm
// machine — a PowerShell cold start under AV scanning would blow past 10s —
// so the child watchdog stays at 6s to keep ~2s of startup headroom.
const FAIL_OPEN_CHILD_TIMEOUT_SECONDS = 6;
const FAIL_OPEN_STDIN_TIMEOUT_SECONDS = 2;

function fallbackStdoutForEvent(event) {
  return stdoutForAntigravityEvent(event);
}

function quoteShellSingleArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function quotePowerShellSingleArg(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeFailOpenTimeoutSeconds(options = {}) {
  const raw = Number(options.failOpenTimeoutSeconds);
  if (Number.isFinite(raw) && raw > 0) return Math.max(1, Math.floor(raw));
  return FAIL_OPEN_CHILD_TIMEOUT_SECONDS;
}

function normalizeStdinTimeoutSeconds(options = {}) {
  const raw = Number(options.stdinTimeoutSeconds);
  if (Number.isFinite(raw) && raw > 0) return Math.max(1, Math.floor(raw));
  return FAIL_OPEN_STDIN_TIMEOUT_SECONDS;
}

function quoteWindowsProcessArg(value) {
  const text = String(value);
  if (text && !/[\s"]/u.test(text)) return text;
  let out = '"';
  let backslashes = 0;
  for (const ch of text) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat((backslashes * 2) + 1);
      out += '"';
      backslashes = 0;
      continue;
    }
    out += "\\".repeat(backslashes);
    backslashes = 0;
    out += ch;
  }
  out += "\\".repeat(backslashes * 2);
  out += '"';
  return out;
}

function withFailOpenShellFallback(command, event, nodeBin, options = {}) {
  const fallback = quoteShellSingleArg(fallbackStdoutForEvent(event));
  const timeoutSeconds = normalizeFailOpenTimeoutSeconds(options);
  const stdinTimeoutSeconds = normalizeStdinTimeoutSeconds(options);
  const validatorScript = [
    "let s='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',c=>s+=c);",
    "process.stdin.on('end',()=>{",
    "try{const v=JSON.parse(s);if(!v||typeof v!=='object'||Array.isArray(v))process.exit(1);}",
    "catch{process.exit(1);}",
    "});",
  ].join("");
  const validatorCommand = [
    nodeBin,
    "-e",
    validatorScript,
  ].map(quoteShellSingleArg).join(" ");
  return [
    "tmp_dir=${TMPDIR:-/tmp}",
    "in_file=$(mktemp \"$tmp_dir/clawd-agy-in.XXXXXX\" 2>/dev/null || printf '%s/clawd-agy-in-%s' \"$tmp_dir\" \"$$\")",
    "out_file=$(mktemp \"$tmp_dir/clawd-agy-out.XXXXXX\" 2>/dev/null || printf '%s/clawd-agy-out-%s' \"$tmp_dir\" \"$$\")",
    "pid=",
    "watchdog=",
    // Do not trap TERM: macOS bash 3.2 may print run_pending_traps warnings when the watchdog is killed.
    "cleanup(){ trap - EXIT HUP INT TERM; [ -n \"$watchdog\" ] && kill \"$watchdog\" 2>/dev/null; [ -n \"$pid\" ] && kill \"$pid\" 2>/dev/null; rm -f \"$in_file\" \"$out_file\"; }",
    "trap cleanup EXIT HUP INT",
    // #568: IDE/App hook runners may never close our stdin, so the stdin read
    // needs its own watchdog. Background lists get /dev/null as stdin in
    // non-interactive shells; the 3<&0 group redirection hands the real stdin
    // to the background cat (and fails soft if fd 0 is somehow absent).
    "{ cat <&3 > \"$in_file\" 2>/dev/null & pid=$!; } 3<&0",
    // Watchdog subshells redirect stdout/stderr: a killed watchdog orphans its
    // sleep, and an orphan holding our stdout would stall a hook runner that
    // waits for pipe EOF instead of process exit.
    `( sleep ${stdinTimeoutSeconds}; kill "$pid" 2>/dev/null ) > /dev/null 2>&1 & watchdog=$!`,
    "wait \"$pid\" 2>/dev/null",
    "[ -n \"$watchdog\" ] && kill \"$watchdog\" 2>/dev/null",
    "[ -n \"$watchdog\" ] && wait \"$watchdog\" 2>/dev/null",
    "pid=",
    "watchdog=",
    `${command} < "$in_file" > "$out_file" 2>/dev/null & pid=$!`,
    `( sleep ${timeoutSeconds}; kill "$pid" 2>/dev/null ) > /dev/null 2>&1 & watchdog=$!`,
    "wait \"$pid\" 2>/dev/null",
    "status=$?",
    "[ -n \"$watchdog\" ] && kill \"$watchdog\" 2>/dev/null",
    "[ -n \"$watchdog\" ] && wait \"$watchdog\" 2>/dev/null",
    "pid=",
    "watchdog=",
    "out=$(cat \"$out_file\" 2>/dev/null)",
    `if [ "$status" -eq 0 ] && [ -n "$out" ] && printf '%s' "$out" | ${validatorCommand} 2>/dev/null; then printf '%s\\n' "$out"; else printf '%s\\n' ${fallback}; fi`,
    "exit 0",
  ].join("; ");
}

function buildWindowsEncodedFailOpenNodeHookCommand(nodeBin, hookScript, event, options = {}) {
  const fallback = fallbackStdoutForEvent(event);
  const timeoutMs = normalizeFailOpenTimeoutSeconds(options) * 1000;
  const stdinTimeoutMs = normalizeStdinTimeoutSeconds(options) * 1000;
  const childArgs = [
    quoteWindowsProcessArg(hookScript),
    quoteWindowsProcessArg(event),
  ].join(" ");
  const psCommand = [
    "$ErrorActionPreference='SilentlyContinue'",
    ";",
    "$ProgressPreference='SilentlyContinue'",
    ";",
    "$text=''",
    ";",
    // #638: .NET Framework's Process.Start() eagerly creates the StandardInput
    // StreamWriter on Console.InputEncoding with AutoFlush=true, which flushes
    // the encoding's preamble into the pipe at Start() itself — under a
    // CP-65001 console the hook's stdin would start with a 3-byte UTF-8 BOM
    // that JSON.parse rejects. Swap in a BOM-less UTF-8 before Start(), gated
    // on the current encoding actually carrying a preamble: the swap then
    // never changes the console codepage (65001 stays 65001), so there is no
    // cross-process console state to restore — concurrent wrappers cannot
    // race on it and a hard-killed wrapper leaves no residue. The swapped
    // encoding object is process-local and dies with the wrapper. Fail open
    // where no console exists (ANSI encodings carry no preamble anyway).
    "try { if ([Console]::InputEncoding.GetPreamble().Length -gt 0) { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } } catch {}",
    ";",
    "try {",
    "$psi = New-Object System.Diagnostics.ProcessStartInfo",
    ";",
    "$psi.FileName =",
    quotePowerShellSingleArg(nodeBin),
    ";",
    "$psi.Arguments =",
    quotePowerShellSingleArg(childArgs),
    ";",
    "$psi.UseShellExecute = $false",
    ";",
    "$psi.RedirectStandardInput = $true",
    ";",
    "$psi.RedirectStandardOutput = $true",
    ";",
    // #638 read side: without this, the StandardOutput reader decodes the
    // hook's UTF-8 stdout with Console.OutputEncoding — mojibake for any
    // non-ASCII in the hook's response under an ANSI console. Available on
    // .NET Framework 4.5+ (unlike StandardInputEncoding, which Framework
    // never got, hence the InputEncoding swap above) and process-local by
    // construction.
    "$psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    ";",
    "$psi.RedirectStandardError = $true",
    ";",
    "$psi.CreateNoWindow = $true",
    ";",
    "$proc = New-Object System.Diagnostics.Process",
    ";",
    "$proc.StartInfo = $psi",
    ";",
    "[void]$proc.Start()",
    ";",
    "$stdoutTask = $proc.StandardOutput.ReadToEndAsync()",
    ";",
    "$stderrTask = $proc.StandardError.ReadToEndAsync()",
    ";",
    // #568: the IDE/App hook runner may never close our stdin; a bare
    // ReadToEnd() would block until the outer hooks.json timeout kills us.
    // [Console]::In is a SyncTextReader whose ReadToEndAsync() runs
    // synchronously, so read the raw stdin stream instead — its async read
    // lets Wait() time out (dropping the payload; the hook fails open on {}).
    "$stdinText = ''",
    ";",
    `try { $stdinReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput()) ; $stdinTask = $stdinReader.ReadToEndAsync() ; if ($stdinTask.Wait(${stdinTimeoutMs})) { $stdinText = $stdinTask.Result } } catch {}`,
    ";",
    // Write raw UTF-8 bytes through the base stream rather than the
    // Console.InputEncoding StreamWriter, so this write stays correctly
    // encoded even where the InputEncoding pre-set above failed (#638).
    "$stdinBytes = [System.Text.Encoding]::UTF8.GetBytes($stdinText)",
    ";",
    "$stdinStream = $proc.StandardInput.BaseStream",
    ";",
    "$stdinStream.Write($stdinBytes, 0, $stdinBytes.Length)",
    ";",
    "$stdinStream.Close()",
    ";",
    `if ($proc.WaitForExit(${timeoutMs})) {`,
    "$proc.WaitForExit()",
    ";",
    "$out = $stdoutTask.Result",
    ";",
    "[void]$stderrTask.Result",
    ";",
    "if (($proc.ExitCode -eq 0) -and ($null -ne $out)) { $text=$out.TrimEnd(\"`r\", \"`n\") }",
    "} else {",
    "try { $proc.Kill() } catch {}",
    ";",
    "try { [void]$proc.WaitForExit(1000) } catch {}",
    ";",
    "$text=''",
    "}",
    "} catch { $text='' }",
    ";",
    "if ($text.Length -gt 0) { $trimmed=$text.Trim(); if (($trimmed.Length -lt 2) -or ($trimmed[0] -ne '{') -or ($trimmed[$trimmed.Length - 1] -ne '}')) { $text='' } else { try { $null = ($text | ConvertFrom-Json -ErrorAction Stop) } catch { $text='' } } }",
    ";",
    "if ($text.Length -gt 0) { [Console]::Out.WriteLine($text) } else { [Console]::Out.WriteLine(",
    quotePowerShellSingleArg(fallback),
    ") }",
    ";",
    "exit 0",
  ].join(" ");
  const encodedCommand = Buffer.from(psCommand, "utf16le").toString("base64");
  return `${windowsPowerShellBin(options)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
}

function buildAntigravityHookCommand(nodeBin, hookScript, event, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    return buildWindowsAntigravityHookCommand(nodeBin, hookScript, event, options);
  }
  // Single-quote each argv at the shell level so a node/hook/event path that
  // contains $ or backticks is never expanded by /bin/sh inside the $(...)
  // capture. (formatNodeHookCommand double-quotes, which leaks expansion.)
  const command = [nodeBin, hookScript, event].map(quoteShellSingleArg).join(" ");
  return withFailOpenShellFallback(command, event, nodeBin, options);
}

function buildWindowsAntigravityHookCommand(nodeBin, hookScript, event, options = {}) {
  return buildWindowsEncodedFailOpenNodeHookCommand(nodeBin, hookScript, event, options);
}

function extractNodeBinFromCommand(command) {
  const decoded = decodeWindowsEncodedCommand(command);
  const text = decoded || command;
  const quotedTokens = [];
  const quotedRe = /'((?:''|[^'])*)'|"((?:\\"|[^"])*)"/g;
  let match;
  while ((match = quotedRe.exec(text))) {
    if (match[1] !== undefined) quotedTokens.push(match[1].replace(/''/g, "'"));
    else quotedTokens.push(match[2].replace(/\\"/g, "\"").replace(/\\\\/g, "\\"));
  }
  for (let i = 1; i < quotedTokens.length; i++) {
    if (quotedTokens[i].includes(MARKER) && !quotedTokens[i - 1].includes(MARKER)) {
      return quotedTokens[i - 1];
    }
  }
  const token = extractFirstQuotedToken(text);
  if (!token || token.includes(MARKER)) return null;
  return token;
}

function collectHookCommandsFromEntries(entries) {
  const commands = [];
  if (!Array.isArray(entries)) return commands;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command === "string") {
      const decoded = decodeWindowsEncodedCommand(entry.command);
      if (entry.command.includes(MARKER) || (decoded && decoded.includes(MARKER))) {
        commands.push(entry.command);
      }
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook.command !== "string") continue;
      const decoded = decodeWindowsEncodedCommand(hook.command);
      if (hook.command.includes(MARKER) || (decoded && decoded.includes(MARKER))) {
        commands.push(hook.command);
      }
    }
  }
  return commands;
}

function extractExistingAntigravityNodeBin(existingGroup) {
  if (!existingGroup || typeof existingGroup !== "object") return null;
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    for (const command of collectHookCommandsFromEntries(existingGroup[event])) {
      const nodeBin = extractNodeBinFromCommand(command);
      if (nodeBin) return nodeBin;
    }
  }
  return null;
}

function resolveAntigravityNodeBin(options = {}) {
  if (options.nodeBin !== undefined) return options.nodeBin;
  return resolveNodeBin(options);
}

function buildHookHandler(command, timeout = DEFAULT_HOOK_TIMEOUT_SECONDS) {
  return { type: "command", command, timeout };
}

function buildAntigravityHooks(commandForEvent) {
  return {
    clawd: {
      PreInvocation: [buildHookHandler(commandForEvent("PreInvocation"))],
      PostToolUse: [{
        matcher: "*",
        hooks: [buildHookHandler(commandForEvent("PostToolUse"))],
      }],
      PostInvocation: [buildHookHandler(commandForEvent("PostInvocation"))],
      Stop: [buildHookHandler(commandForEvent("Stop"))],
    },
  };
}

function hasAntigravityConfig(homeDir) {
  return fs.existsSync(path.join(homeDir, ".gemini", "config"));
}

function readJsonIfExists(filePath) {
  try {
    return readJsonFile(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function normalizeSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function registerAntigravityHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const configPath = options.configPath || path.join(homeDir, ".gemini", "config", "hooks.json");

  if (!options.configPath && !hasAntigravityConfig(homeDir)) {
    if (!options.silent) console.log("Clawd: Antigravity config not found - skipping Antigravity hook registration");
    return { installed: false, added: 0, updated: 0, skipped: 0, configPath };
  }

  const settings = normalizeSettings(readJsonIfExists(configPath));
  const existingGroup = settings[HOOK_GROUP_ID] && typeof settings[HOOK_GROUP_ID] === "object" && !Array.isArray(settings[HOOK_GROUP_ID])
    ? settings[HOOK_GROUP_ID]
    : null;
  const hookScript = asarUnpackedPath(path.resolve(__dirname, "antigravity-hook.js").replace(/\\/g, "/"));
  const nodeBin = resolveAntigravityNodeBin(options)
    || extractExistingAntigravityNodeBin(existingGroup)
    || "node";
  const desiredGroup = buildAntigravityHooks((event) => buildAntigravityHookCommand(nodeBin, hookScript, event, options))[HOOK_GROUP_ID];

  let added = 0;
  let updated = 0;
  let skipped = 0;

  if (existingGroup && existingGroup.enabled === false) {
    desiredGroup.enabled = false;
  }

  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    const existingText = existingGroup ? JSON.stringify(existingGroup[event]) : null;
    const nextText = JSON.stringify(desiredGroup[event]);
    if (existingText === nextText) {
      skipped++;
    } else if (existingText === null) {
      added++;
    } else {
      updated++;
    }
  }

  const changed = !existingGroup || JSON.stringify(existingGroup) !== JSON.stringify(desiredGroup);
  if (changed) {
    settings[HOOK_GROUP_ID] = desiredGroup;
    writeJsonAtomic(configPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Antigravity hooks -> ${configPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { installed: true, added, updated, skipped, configPath };
}

function groupHasClawdMarker(group) {
  if (!group || typeof group !== "object" || Array.isArray(group)) return false;
  return ANTIGRAVITY_HOOK_EVENTS.some((event) =>
    collectHookCommandsFromEntries(group[event]).length > 0
  );
}

function unregisterAntigravityHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const configPath = options.configPath || path.join(homeDir, ".gemini", "config", "hooks.json");
  const settings = normalizeSettings(readJsonIfExists(configPath));
  const group = settings[HOOK_GROUP_ID];

  if (!groupHasClawdMarker(group)) {
    return { installed: !!group, removed: 0, changed: false, configPath };
  }

  delete settings[HOOK_GROUP_ID];
  const backupPath = writeJsonAtomicWithBackup(configPath, settings, options);
  if (!options.silent) console.log(`Clawd Antigravity hook group removed -> ${configPath}`);
  const result = { installed: true, removed: 1, changed: true, configPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

function hasAntigravityStatuslineSettings(homeDir) {
  return fs.existsSync(path.join(homeDir, ".gemini", "antigravity-cli"));
}

// On Windows this must NOT use quoteWindowsProcessArg for the interpreter:
// a quoted command token is a string literal under PowerShell and never
// executes, and agy's statusline runner shell is not pinned down the way
// its hook runner (cmd) is. buildPortableStatuslineCommand emits a form
// that parses identically under Git Bash, PowerShell, and cmd.
function buildAntigravityStatuslineCommand(nodeBin, scriptPath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") return buildPortableStatuslineCommand(nodeBin, scriptPath, options);
  return [nodeBin, scriptPath].map(quoteShellSingleArg).join(" ");
}

// Antigravity's statusLine setting is a single slot, not an event-keyed map
// like hooks.json - only one script can render the visible status line at a
// time. We only ever take that slot when it is empty or already ours, and
// unregister only clears it when the command still carries our marker. A
// user's own (or a third-party) statusline script is never touched.
function registerAntigravityStatusline(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const settingsPath = options.settingsPath || path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");

  if (!options.settingsPath && !hasAntigravityStatuslineSettings(homeDir)) {
    if (!options.silent) console.log("Clawd: Antigravity CLI settings not found - skipping statusline registration");
    return { installed: false, changed: false, skippedExisting: false, settingsPath };
  }

  const settings = normalizeSettings(readJsonIfExists(settingsPath));
  const existing = settings.statusLine && typeof settings.statusLine === "object" ? settings.statusLine : null;
  const existingIsOurs = !!(existing && typeof existing.command === "string" && existing.command.includes(STATUSLINE_MARKER));

  if (existing && !existingIsOurs) {
    if (!options.silent) console.log(`Clawd: existing Antigravity statusline detected at ${settingsPath} - leaving it in place`);
    return { installed: true, changed: false, skippedExisting: true, settingsPath };
  }

  const scriptPath = asarUnpackedPath(path.resolve(__dirname, "antigravity-statusline.js").replace(/\\/g, "/"));
  const nodeBin = resolveAntigravityNodeBin(options) || "node";
  const desired = {
    type: "",
    command: buildAntigravityStatuslineCommand(nodeBin, scriptPath, options),
    enabled: true,
  };

  const changed = !existing || JSON.stringify(existing) !== JSON.stringify(desired);
  if (changed) {
    settings.statusLine = desired;
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Antigravity statusline -> ${settingsPath}${changed ? " (updated)" : " (already up to date)"}`);
  }

  return { installed: true, changed, skippedExisting: false, settingsPath };
}

function unregisterAntigravityStatusline(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const settingsPath = options.settingsPath || path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
  const settings = normalizeSettings(readJsonIfExists(settingsPath));
  const existing = settings.statusLine && typeof settings.statusLine === "object" ? settings.statusLine : null;
  const existingIsOurs = !!(existing && typeof existing.command === "string" && existing.command.includes(STATUSLINE_MARKER));

  if (!existingIsOurs) {
    return { installed: !!existing, removed: 0, changed: false, settingsPath };
  }

  delete settings.statusLine;
  const backupPath = writeJsonAtomicWithBackup(settingsPath, settings, options);
  if (!options.silent) console.log(`Clawd Antigravity statusline removed -> ${settingsPath}`);
  const result = { installed: true, removed: 1, changed: true, settingsPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  HOOK_GROUP_ID,
  MARKER,
  STATUSLINE_MARKER,
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATUSLINE_SETTINGS_PATH,
  ANTIGRAVITY_HOOK_EVENTS,
  registerAntigravityHooks,
  unregisterAntigravityHooks,
  registerAntigravityStatusline,
  unregisterAntigravityStatusline,
  __test: {
    buildAntigravityHookCommand,
    buildAntigravityHooks,
    buildWindowsEncodedFailOpenNodeHookCommand,
    buildWindowsAntigravityHookCommand,
    decodeWindowsEncodedCommand,
    extractExistingAntigravityNodeBin,
    extractNodeBinFromCommand,
    fallbackStdoutForEvent,
    normalizeFailOpenTimeoutSeconds,
    normalizeStdinTimeoutSeconds,
    quoteWindowsProcessArg,
    groupHasClawdMarker,
    hasAntigravityConfig,
    normalizeSettings,
    resolveAntigravityNodeBin,
    withFailOpenShellFallback,
    hasAntigravityStatuslineSettings,
    buildAntigravityStatuslineCommand,
  },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      unregisterAntigravityHooks({});
      unregisterAntigravityStatusline({});
    } else {
      registerAntigravityHooks({});
      registerAntigravityStatusline({});
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
