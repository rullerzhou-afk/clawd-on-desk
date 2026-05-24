// Shared utilities for hook installers (claude / cursor / gemini /
// codebuddy / opencode). Keeps config-file mutation behavior identical
// across agents so a fix in one place fixes all of them.

const fs = require("fs");
const path = require("path");

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

/**
 * Format a Node-based hook command consistently across installers.
 *
 * POSIX hook launchers can execute a plain quoted command. On Windows, some
 * launchers run through PowerShell, where a bare quoted executable is treated
 * as a string literal and must be prefixed with `&`; others are more reliable
 * when explicitly routed through cmd.exe. Callers choose the wrapper that
 * matches the target agent while sharing the quoting rules.
 */
function formatNodeHookCommand(nodeBin, scriptPath, options = {}) {
  const platform = options.platform || process.platform;
  const args = Array.isArray(options.args) ? options.args : [];
  const command = [nodeBin, scriptPath, ...args].map(quoteHookCommandArg).join(" ");
  if (platform !== "win32") return command;

  const wrapper = options.windowsWrapper || "powershell";
  if (wrapper === "cmd") return `cmd /d /s /c "${command}"`;
  if (wrapper === "none") return command;
  return `& ${command}`;
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
          if (h && typeof h.command === "string" && h.command.includes(marker)) {
            commands.push(h.command);
          }
        }
      }
      if (typeof entry.command === "string" && entry.command.includes(marker)) {
        commands.push(entry.command);
      }
    }
  }
  return commands;
}

module.exports = {
  writeJsonAtomic,
  writeJsonAtomicAsync,
  asarUnpackedPath,
  extractExistingNodeBin,
  extractExistingNodeBinFromCommands,
  findHookCommands,
  formatNodeHookCommand,
};
