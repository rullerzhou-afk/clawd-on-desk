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
  if (!settings || !settings.hooks) return null;
  const nested = options && options.nested;

  for (const entries of Object.values(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;

      // Collect candidate command strings
      const cmds = [];
      if (nested && Array.isArray(entry.hooks)) {
        for (const h of entry.hooks) {
          if (h && typeof h.command === "string") cmds.push(h.command);
        }
      }
      if (typeof entry.command === "string") cmds.push(entry.command);

      for (const cmd of cmds) {
        if (!cmd.includes(marker)) continue;
        const matches = cmd.matchAll(/"([^"]+)"/g);
        for (const match of matches) {
          const token = match && match[1];
          if (!token || token.includes(marker)) continue;
          if (isAbsoluteCommandToken(token)) return token;
        }
      }
    }
  }
  return null;
}

module.exports = { writeJsonAtomic, asarUnpackedPath, extractExistingNodeBin };
