// Shared utilities for hook installers (claude / cursor / gemini /
// codebuddy / opencode). Keeps config-file mutation behavior identical
// across agents so a fix in one place fixes all of them.

const fs = require("fs");
const path = require("path");

function stripUtf8Bom(text) {
  const value = String(text || "");
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function readTextFileStripBom(filePath, encoding = "utf-8") {
  return stripUtf8Bom(fs.readFileSync(filePath, encoding));
}

async function readTextFileStripBomAsync(filePath, encoding = "utf-8") {
  return stripUtf8Bom(await fs.promises.readFile(filePath, encoding));
}

function readJsonFile(filePath) {
  return JSON.parse(readTextFileStripBom(filePath, "utf-8"));
}

async function readJsonFileAsync(filePath) {
  return JSON.parse(await readTextFileStripBomAsync(filePath, "utf-8"));
}

function isAbsoluteCommandToken(token) {
  if (typeof token !== "string" || !token) return false;
  if (path.isAbsolute(token)) return true;
  return /^[A-Za-z]:[\\/]/.test(token) || token.startsWith("\\\\");
}

/**
 * Atomically write a JS object as pretty JSON. Writes to a sibling tmp file
 * then renames into place so concurrent readers never see a half-written
 * config. Creates the parent directory if missing. Cleans up the tmp file
 * on failure before re-throwing.
 */
function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

async function writeJsonAtomicAsync(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch {}
    throw err;
  }
}

function cleanupBackupPath(filePath, options = {}) {
  if (typeof options.backupPath === "string" && options.backupPath) return options.backupPath;
  const now = typeof options.now === "function" ? options.now() : new Date();
  const stamp = now instanceof Date && !Number.isNaN(now.getTime())
    ? now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)
    : String(Date.now());
  return `${filePath}.clawd-cleanup-${stamp}.bak`;
}

function uniqueBackupPath(filePath, options = {}) {
  const requested = cleanupBackupPath(filePath, options);
  if (typeof options.backupPath === "string" && options.backupPath) return requested;
  if (!fs.existsSync(requested)) return requested;
  const stem = requested.endsWith(".bak") ? requested.slice(0, -4) : requested;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}.${i}.bak`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${stem}.${process.pid}.${Date.now()}.bak`;
}

// Cap how many timestamped backups we keep for a single file. Without a cap, a
// config that gets rewritten repeatedly — e.g. the settings watcher
// re-registering hooks after another tool (CC-Switch) strips them — would
// accrue `.clawd-cleanup-*.bak` files without bound. 5 keeps a short history
// while staying bounded; override per-call with `backupKeep`.
const DEFAULT_BACKUP_KEEP = 5;

function resolveBackupKeep(options = {}) {
  return Number.isInteger(options.backupKeep) && options.backupKeep > 0
    ? options.backupKeep
    : DEFAULT_BACKUP_KEEP;
}

function ownBackupPrefix(filePath) {
  return `${path.basename(filePath)}.clawd-cleanup-`;
}

function isOwnBackupName(name, prefix) {
  return name.startsWith(prefix) && name.endsWith(".bak");
}

// Order backups by the timestamp encoded in their FILENAME, not by mtime.
// fs.copyFileSync inherits the SOURCE file's mtime (notably on Windows, via the
// CopyFile API), so a backup's mtime reflects the settings file's contents, not
// when the backup was taken — ordering by mtime can flag the just-written
// backup as "oldest" and delete it. The filename stamp comes from `new Date()`
// at creation time (see cleanupBackupPath), so it is the reliable creation
// order. Format: <prefix><stamp>[.<collision-n>][.<pid>.<ms>].bak
function backupOrderKey(name, prefix) {
  const body = name.slice(prefix.length, name.length - ".bak".length);
  const parts = body.split(".");
  // stamp is fixed-width digits (YYYYMMDDHHMMSSmmm); compare it as a STRING so
  // 17-digit values (which exceed Number.MAX_SAFE_INTEGER) keep full precision
  // and still sort chronologically. Collision suffixes (.1/.2, or the
  // .pid.ms fallback) compare numerically.
  return {
    stamp: parts[0] || "",
    suffixes: parts.slice(1).map((part) => {
      const n = Number(part);
      return Number.isFinite(n) ? n : Infinity; // unparseable → sort last (kept, not deleted)
    }),
  };
}

function compareBackupKeys(a, b) {
  if (a.stamp !== b.stamp) return a.stamp < b.stamp ? -1 : 1;
  const len = Math.max(a.suffixes.length, b.suffixes.length);
  for (let i = 0; i < len; i++) {
    const x = i < a.suffixes.length ? a.suffixes[i] : 0; // missing suffix (".bak") is earlier than ".1.bak"
    const y = i < b.suffixes.length ? b.suffixes[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function listOrderedBackups(names, prefix) {
  return names
    .map((name) => ({ name, key: backupOrderKey(name, prefix) }))
    .sort((a, b) => compareBackupKeys(a.key, b.key))
    .map((entry) => entry.name); // oldest first
}

// Decide which backups survive a prune: never drop the one we just wrote
// (keepPath), always preserve the oldest (the original pre-install snapshot,
// the most valuable restore point), and fill the rest of the budget with the
// most recent backups.
function backupSurvivors(orderedOldestFirst, keep, keepPath) {
  const survivors = new Set();
  const keepName = keepPath ? path.basename(keepPath) : null;
  if (keepName) survivors.add(keepName);
  if (keep >= 2 && orderedOldestFirst.length) survivors.add(orderedOldestFirst[0]);
  for (let i = orderedOldestFirst.length - 1; i >= 0 && survivors.size < keep; i--) {
    survivors.add(orderedOldestFirst[i]);
  }
  return survivors;
}

function pruneOldBackups(filePath, options = {}, keepPath = null) {
  // A caller-specified backupPath is managed by the caller — never sweep it.
  if (typeof options.backupPath === "string" && options.backupPath) return;
  const keep = resolveBackupKeep(options);
  const dir = path.dirname(filePath);
  const prefix = ownBackupPrefix(filePath);
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => isOwnBackupName(name, prefix));
  } catch {
    return;
  }
  if (names.length <= keep) return;
  const ordered = listOrderedBackups(names, prefix);
  const survivors = backupSurvivors(ordered, keep, keepPath);
  for (const name of ordered) {
    if (survivors.has(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch {}
  }
}

async function pruneOldBackupsAsync(filePath, options = {}, keepPath = null) {
  if (typeof options.backupPath === "string" && options.backupPath) return;
  const keep = resolveBackupKeep(options);
  const dir = path.dirname(filePath);
  const prefix = ownBackupPrefix(filePath);
  let names;
  try {
    names = (await fs.promises.readdir(dir)).filter((name) => isOwnBackupName(name, prefix));
  } catch {
    return;
  }
  if (names.length <= keep) return;
  const ordered = listOrderedBackups(names, prefix);
  const survivors = backupSurvivors(ordered, keep, keepPath);
  for (const name of ordered) {
    if (survivors.has(name)) continue;
    try { await fs.promises.unlink(path.join(dir, name)); } catch {}
  }
}

// How many fresh names to try when an auto-named backup collides mid-write.
const BACKUP_COPY_ATTEMPTS = 5;

function createBackup(filePath, options = {}) {
  if (options.backup !== true) return null;
  // A caller-specified backupPath is honored as-is — the caller owns the name
  // and expects an overwrite if it already exists.
  if (typeof options.backupPath === "string" && options.backupPath) {
    const backupPath = uniqueBackupPath(filePath, options);
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  }
  // Auto-named path: COPYFILE_EXCL makes the copy fail if the destination
  // already exists, closing the existsSync→copy TOCTOU window where two
  // processes pick the same name and one clobbers the other. On collision,
  // recompute a fresh unique name (uniqueBackupPath now sees the other file) and retry.
  let lastErr;
  for (let attempt = 0; attempt < BACKUP_COPY_ATTEMPTS; attempt++) {
    const backupPath = uniqueBackupPath(filePath, options);
    try {
      fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
      return backupPath;
    } catch (err) {
      lastErr = err;
      if (err.code === "EEXIST") continue; // a racing writer took this name; pick another
      throw err;
    }
  }
  throw lastErr;
}

async function createBackupAsync(filePath, options = {}) {
  if (options.backup !== true) return null;
  if (typeof options.backupPath === "string" && options.backupPath) {
    const backupPath = uniqueBackupPath(filePath, options);
    await fs.promises.copyFile(filePath, backupPath);
    return backupPath;
  }
  let lastErr;
  for (let attempt = 0; attempt < BACKUP_COPY_ATTEMPTS; attempt++) {
    const backupPath = uniqueBackupPath(filePath, options);
    try {
      await fs.promises.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL);
      return backupPath;
    } catch (err) {
      lastErr = err;
      if (err.code === "EEXIST") continue;
      throw err;
    }
  }
  throw lastErr;
}

function writeJsonAtomicWithBackup(filePath, data, options = {}) {
  const backupPath = createBackup(filePath, options);
  writeJsonAtomic(filePath, data);
  // Prune only after the live write succeeds (a failed write keeps the prior
  // backups), and pass the just-written backup so it is never the one deleted.
  if (backupPath) pruneOldBackups(filePath, options, backupPath);
  return backupPath;
}

async function writeJsonAtomicWithBackupAsync(filePath, data, options = {}) {
  const backupPath = await createBackupAsync(filePath, options);
  await writeJsonAtomicAsync(filePath, data);
  if (backupPath) await pruneOldBackupsAsync(filePath, options, backupPath);
  return backupPath;
}

function writeTextAtomic(filePath, text, encoding = "utf-8") {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, text, encoding);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function writeTextAtomicWithBackup(filePath, text, options = {}) {
  const backupPath = createBackup(filePath, options);
  writeTextAtomic(filePath, text, options.encoding || "utf-8");
  if (backupPath) pruneOldBackups(filePath, options, backupPath);
  return backupPath;
}

/**
 * Rewrite a path so it points at the asar.unpacked mirror instead of asar.
 * In packaged builds, __dirname resolves to the virtual app.asar/ tree, but
 * external processes (Claude/Cursor/Gemini/opencode) cannot read inside asar
 * and must use the physical copy under app.asar.unpacked/ (see package.json
 * "asarUnpack"). No-op for dev/source installs.
 */
function asarUnpackedPath(p) {
  return p.replace("app.asar/", "app.asar.unpacked/");
}

function quoteHookCommandArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

// WSL detection for the hook command format, mirroring install.js's
// resolveInstallWslDistro: CLAWD_WSL_DISTRO is injected by the Windows-side
// one-click deploy, WSL_DISTRO_NAME by WSL init itself. Gated on linux so a
// stale variable in some other environment cannot flip the format.
function resolveWslDistroEnv() {
  if (process.env.CLAWD_WSL_DISTRO) return process.env.CLAWD_WSL_DISTRO;
  if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
    return process.env.WSL_DISTRO_NAME;
  }
  return null;
}

function quotePowerShellSingleArg(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsPowerShellBin(options = {}) {
  if (options.powerShellBin) return options.powerShellBin;
  const root = (options.env && options.env.SystemRoot) || process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Build a PowerShell -EncodedCommand hook command. The node bin and every
 * argv are single-quoted at the PS level then base64 utf-16le encoded, so
 * the resulting flat command line survives both cmd.exe quote stripping
 * (qwen uses `cmd /d /s /c <command>`, which strips outer quotes under /s
 * and breaks any path with a space) and any agent that wraps the command
 * once more in its own shell. Used by Antigravity and Qwen Code installers.
 */
function buildWindowsEncodedNodeHookCommand(nodeBin, scriptPath, args, options = {}) {
  const argv = Array.isArray(args) ? args : [];
  const psCommand = [
    "&",
    quotePowerShellSingleArg(nodeBin),
    quotePowerShellSingleArg(scriptPath),
    ...argv.map((a) => quotePowerShellSingleArg(a)),
  ].join(" ");
  const encodedCommand = Buffer.from(psCommand, "utf16le").toString("base64");
  return `${windowsPowerShellBin(options)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
}

function decodeWindowsEncodedCommand(command) {
  const match = String(command || "").match(/(?:^|\s)-(?:EncodedCommand|enc|e)\s+([A-Za-z0-9+/=]+)/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf16le").trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function extractFirstQuotedToken(command) {
  const text = String(command || "").trim().replace(/^&\s+/, "");
  const single = text.match(/^'((?:''|[^'])*)'/);
  if (single) return single[1].replace(/''/g, "'");
  const double = text.match(/^"((?:\\"|[^"])*)"/);
  if (double) return double[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  const bare = text.match(/^(\S+)/);
  return bare ? bare[1] : null;
}

/**
 * Format a Node-based hook command consistently across installers.
 *
 * POSIX hook launchers can execute a plain quoted command. On Windows, some
 * launchers run through PowerShell, where a bare quoted executable is treated
 * as a string literal and must be prefixed with `&`; others (Qwen Code,
 * Antigravity) shell out through `cmd.exe /d /s /c <command>`, which mangles
 * any quoted path with a space — those use windowsWrapper:"encoded" to wrap
 * everything in PowerShell -EncodedCommand and bypass cmd's parser entirely.
 * Callers choose the wrapper that matches the target agent while sharing
 * the quoting rules.
 */
function formatNodeHookCommand(nodeBin, scriptPath, options = {}) {
  const platform = options.platform || process.platform;
  const args = Array.isArray(options.args) ? options.args : [];
  if (platform === "win32" && options.windowsWrapper === "encoded") {
    return buildWindowsEncodedNodeHookCommand(nodeBin, scriptPath, args, options);
  }
  // WSL: plain (unquoted) form. A quoted command without a shell field breaks
  // hook runners that naive-split on spaces (quotes become part of the
  // executable name — the root cause of silent WSL hook failures; see
  // install.js buildCommandHookSpec). Plain works under both naive-split and
  // sh -c semantics since WSL-side paths contain no spaces.
  const wslDistro = options.wslDistro !== undefined ? options.wslDistro : resolveWslDistroEnv();
  if (platform !== "win32" && wslDistro) {
    return [nodeBin, scriptPath, ...args].join(" ");
  }
  const command = [nodeBin, scriptPath, ...args].map(quoteHookCommandArg).join(" ");
  if (platform !== "win32") return command;

  const wrapper = options.windowsWrapper || "powershell";
  if (wrapper === "cmd") return `cmd /d /s /c "${command}"`;
  if (wrapper === "none") return command;
  return `& ${command}`;
}

// Characters that would need quoting (or would be rewritten) in at least one
// of Git Bash / PowerShell / cmd when they appear in an unquoted command
// token. A path containing any of these cannot be written portably, so the
// command falls back to a bare PATH lookup instead.
const NON_PORTABLE_COMMAND_TOKEN_RE = /[\s"'`&|<>^%!();,$*?#~={}[\]]/;

/**
 * Build a statusline command that parses in every shell the host agent might
 * run it under. Unlike hooks, statusLine settings have no `shell` field:
 * Claude Code runs the command through Git Bash when Git is installed
 * (nearly always - it's an install prerequisite) and PowerShell otherwise;
 * Antigravity is expected to use cmd like its hook runner. No QUOTED command
 * token parses in all of those: `& "..."` is PowerShell-only (bash: syntax
 * error), a bare `"..."` is a string literal in PowerShell (never executed),
 * and an unquoted backslash path is eaten by bash. So the interpreter token
 * must be unquoted: an absolute path only when it needs no quoting (no
 * spaces or shell-special characters), written with forward slashes, and a
 * bare `node` PATH lookup otherwise (the default install under
 * "C:\Program Files" is on PATH by the Node installer). The script path
 * stays double-quoted - a quoted *argument* is fine in all three shells.
 *
 * Known limit: inside double quotes, Git Bash/PowerShell still expand `$`
 * and backticks and cmd expands %VAR%, so an install path containing those
 * would be rewritten before node sees it. There is no quoting form that is
 * inert in all three shells (cmd has no single-quote), and the previous
 * PowerShell-only form had the same exposure - accepted, not a regression.
 */
function buildPortableStatuslineCommand(nodeBin, scriptPath, options = {}) {
  const platform = options.platform || process.platform;
  const script = String(scriptPath).replace(/\\/g, "/");
  if (platform !== "win32") return `"${nodeBin}" "${script}"`;
  const raw = String(nodeBin || "").trim();
  const nodeToken = /^[A-Za-z]:[\\/]/.test(raw) && !NON_PORTABLE_COMMAND_TOKEN_RE.test(raw)
    ? raw.replace(/\\/g, "/")
    : "node";
  return `${nodeToken} "${script}"`;
}

/**
 * Extract the first absolute node binary path from a list of command strings.
 * Scans each command for double-quoted tokens, ignores the hook script marker
 * itself, and returns the first token that looks like an absolute path
 * (POSIX `/`, Windows `C:\`, or UNC `\\server`).
 *
 * Used as a shared primitive so installers that don't share a settings.hooks
 * shape (e.g. Kimi's TOML) can still preserve a user-repaired Node path.
 *
 * @param {string[]} commands - Raw command strings (already unescaped)
 * @param {string}   marker   - Hook script filename to skip
 * @returns {string|null}
 */
function extractExistingNodeBinFromCommands(commands, marker) {
  if (!Array.isArray(commands) || typeof marker !== "string" || !marker) return null;
  for (const cmd of commands) {
    if (typeof cmd !== "string") continue;
    // Windows encoded-command form: decode first so we can extract the
    // single-quoted PowerShell token (`& 'C:\path\node.exe' '...'`).
    const decoded = decodeWindowsEncodedCommand(cmd);
    if (decoded) {
      const token = extractFirstQuotedToken(decoded);
      if (token && !token.includes(marker) && isAbsoluteCommandToken(token)) return token;
      continue;
    }
    const matches = cmd.matchAll(/"([^"]+)"/g);
    for (const match of matches) {
      const token = match && match[1];
      if (!token || token.includes(marker)) continue;
      if (isAbsoluteCommandToken(token)) return token;
    }
  }
  return null;
}

/**
 * Extract the existing absolute node binary path from hook commands that
 * contain `marker` (e.g. "cursor-hook.js").  Scans settings.hooks for
 * matching commands, then returns the first quoted token that is an
 * absolute path (and not the marker itself).
 *
 * @param {object} settings - Parsed JSON settings/config object
 * @param {string} marker   - Hook script filename to search for
 * @param {object} [options]
 * @param {boolean} [options.nested] - Also check entry.hooks[].command
 *   (CodeBuddy / Claude Code nested format)
 * @returns {string|null}
 */
function extractExistingNodeBin(settings, marker, options) {
  return extractExistingNodeBinFromCommands(findHookCommands(settings, marker, options), marker);
}

/**
 * Find every command hook string containing `marker` in a parsed settings
 * object. Supports flat entries (`{ command }`) and, when requested, Claude
 * compatible nested entries (`{ hooks: [{ command }] }`).
 *
 * @param {object} settings - Parsed JSON settings/config object
 * @param {string} marker   - Hook script filename to search for
 * @param {object} [options]
 * @param {boolean} [options.nested] - Also check entry.hooks[].command
 * @returns {string[]}
 */
function commandMatchesMarker(command, marker) {
  if (typeof command !== "string") return false;
  if (command.includes(marker)) return true;
  const decoded = decodeWindowsEncodedCommand(command);
  return !!(decoded && decoded.includes(marker));
}

function removeMatchingCommandHooks(entries, predicate) {
  if (!Array.isArray(entries)) return { entries, removed: 0, changed: false };

  let removed = 0;
  let changed = false;
  const nextEntries = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      nextEntries.push(entry);
      continue;
    }

    if (typeof entry.command === "string" && predicate(entry.command)) {
      removed++;
      changed = true;
      continue;
    }

    if (!Array.isArray(entry.hooks)) {
      nextEntries.push(entry);
      continue;
    }

    const nextHooks = entry.hooks.filter((hook) => {
      if (!hook || typeof hook.command !== "string") return true;
      if (!predicate(hook.command)) return true;
      removed++;
      changed = true;
      return false;
    });

    if (nextHooks.length === entry.hooks.length) {
      nextEntries.push(entry);
      continue;
    }

    if (nextHooks.length === 0 && typeof entry.command !== "string") continue;
    nextEntries.push({ ...entry, hooks: nextHooks });
  }

  return { entries: nextEntries, removed, changed };
}

function removeMatchingHttpHooks(entries, predicate) {
  if (!Array.isArray(entries)) return { entries, removed: 0, changed: false };

  let removed = 0;
  let changed = false;
  const nextEntries = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      nextEntries.push(entry);
      continue;
    }

    if (predicate(entry)) {
      removed++;
      changed = true;
      continue;
    }

    if (!Array.isArray(entry.hooks)) {
      nextEntries.push(entry);
      continue;
    }

    const nextHooks = entry.hooks.filter((hook) => {
      if (!predicate(hook)) return true;
      removed++;
      changed = true;
      return false;
    });

    if (nextHooks.length === entry.hooks.length) {
      nextEntries.push(entry);
      continue;
    }

    if (nextHooks.length === 0 && typeof entry.command !== "string" && entry.type !== "http") continue;
    nextEntries.push({ ...entry, hooks: nextHooks });
  }

  return { entries: nextEntries, removed, changed };
}

function findHookCommands(settings, marker, options) {
  if (!settings || !settings.hooks || typeof marker !== "string" || !marker) return [];
  const nested = options && options.nested;
  const commands = [];

  for (const entries of Object.values(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (nested && Array.isArray(entry.hooks)) {
        for (const h of entry.hooks) {
          if (h && commandMatchesMarker(h.command, marker)) {
            commands.push(h.command);
          }
        }
      }
      if (commandMatchesMarker(entry.command, marker)) {
        commands.push(entry.command);
      }
    }
  }
  return commands;
}

module.exports = {
  stripUtf8Bom,
  readTextFileStripBom,
  readTextFileStripBomAsync,
  readJsonFile,
  readJsonFileAsync,
  writeJsonAtomic,
  writeJsonAtomicAsync,
  writeJsonAtomicWithBackup,
  writeJsonAtomicWithBackupAsync,
  writeTextAtomic,
  writeTextAtomicWithBackup,
  createBackup,
  createBackupAsync,
  pruneOldBackups,
  pruneOldBackupsAsync,
  DEFAULT_BACKUP_KEEP,
  asarUnpackedPath,
  commandMatchesMarker,
  extractExistingNodeBin,
  extractExistingNodeBinFromCommands,
  findHookCommands,
  removeMatchingCommandHooks,
  removeMatchingHttpHooks,
  formatNodeHookCommand,
  resolveWslDistroEnv,
  buildPortableStatuslineCommand,
  buildWindowsEncodedNodeHookCommand,
  decodeWindowsEncodedCommand,
  extractFirstQuotedToken,
  quotePowerShellSingleArg,
  windowsPowerShellBin,
};
