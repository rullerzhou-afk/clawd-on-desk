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
  decodeWindowsEncodedCommand,
  extractFirstQuotedToken,
  windowsPowerShellBin,
} = require("./json-utils");

const HOOK_GROUP_ID = "clawd";
const MARKER = "antigravity-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".gemini", "config");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "hooks.json");

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
const FAIL_OPEN_CHILD_TIMEOUT_SECONDS = 8;

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
    "cleanup(){ [ -n \"$watchdog\" ] && kill \"$watchdog\" 2>/dev/null; [ -n \"$pid\" ] && kill \"$pid\" 2>/dev/null; rm -f \"$in_file\" \"$out_file\"; }",
    "trap cleanup EXIT HUP INT TERM",
    "cat > \"$in_file\" 2>/dev/null || :",
    `${command} < "$in_file" > "$out_file" 2>/dev/null & pid=$!`,
    `( sleep ${timeoutSeconds}; kill "$pid" 2>/dev/null ) & watchdog=$!`,
    "wait \"$pid\" 2>/dev/null",
    "status=$?",
    "kill \"$watchdog\" 2>/dev/null",
    "wait \"$watchdog\" 2>/dev/null",
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
    "$stdinText = [Console]::In.ReadToEnd()",
    ";",
    "$proc.StandardInput.Write($stdinText)",
    ";",
    "$proc.StandardInput.Close()",
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

module.exports = {
  HOOK_GROUP_ID,
  MARKER,
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  ANTIGRAVITY_HOOK_EVENTS,
  registerAntigravityHooks,
  unregisterAntigravityHooks,
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
    quoteWindowsProcessArg,
    groupHasClawdMarker,
    hasAntigravityConfig,
    normalizeSettings,
    resolveAntigravityNodeBin,
    withFailOpenShellFallback,
  },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterAntigravityHooks({});
    else registerAntigravityHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
