#!/usr/bin/env node
// Merge Clawd Kimi CLI hooks into ~/.kimi/config.toml (append-only, idempotent)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const { asarUnpackedPath } = require("./json-utils");
const MARKER = "kimi-hook.js";
const MODE_EXPLICIT = "explicit";
const MODE_SUSPECT = "suspect";

const KIMI_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
];

function normalizePermissionMode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === MODE_EXPLICIT || normalized === MODE_SUSPECT) return normalized;
  return null;
}

/**
 * Register Clawd hooks into ~/.kimi/config.toml
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerKimiHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".kimi", "config.toml");

  // Skip if target Kimi config directory doesn't exist (Kimi CLI not installed
  // or custom path points to a non-existent home).
  const kimiDir = path.dirname(settingsPath);
  if (!fs.existsSync(kimiDir)) {
    if (!options.silent) console.log("Clawd: ~/.kimi/ not found — skipping Kimi hook registration");
    return { added: 0, skipped: 0, updated: 0 };
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "kimi-hook.js").replace(/\\/g, "/"));
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved || "node";
  const configuredMode = normalizePermissionMode(
    options.permissionMode !== undefined
      ? options.permissionMode
      : process.env.CLAWD_KIMI_PERMISSION_MODE
  );
  const modePrefix = configuredMode ? `CLAWD_KIMI_PERMISSION_MODE=${configuredMode} ` : "";
  const desiredCommand = `${modePrefix}"${nodeBin}" "${hookScript}"`;

  let content = "";
  try {
    content = fs.readFileSync(settingsPath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read config.toml: ${err.message}`);
    }
    // Create a minimal config.toml if it doesn't exist
    content = 'default_model = "kimi-for-coding"\n';
  }

  // Check if our hooks are already registered (matches both single and double quotes)
  const markerRegex = new RegExp(`command\\s*=\\s*"[^"]*${MARKER}[^"]*"|command\\s*=\\s*'[^']*${MARKER}[^']*'`, "g");
  const existingMatches = [...content.matchAll(markerRegex)];

  if (existingMatches.length > 0) {
    let updated = 0;
    for (const match of existingMatches) {
      const fullMatch = match[0];
      const expected = `command = '${desiredCommand}'`;
      if (fullMatch !== expected) {
        content = content.replace(fullMatch, expected);
        updated++;
      }
    }
    if (updated > 0) {
      fs.mkdirSync(kimiDir, { recursive: true });
      fs.writeFileSync(settingsPath, content);
    }
    if (!options.silent) {
      console.log(`Clawd Kimi hooks → ${settingsPath}`);
      console.log(`  Skipped: already registered${updated > 0 ? `, updated: ${updated}` : ""}`);
    }
    return { added: 0, skipped: 1, updated };
  }

  // Remove empty `hooks = []` since we need to use [[hooks]] array-of-tables syntax
  content = content.replace(/^hooks\s*=\s*\[\]\s*$/m, "");

  // Build hook blocks — use single quotes for command so embedded double quotes are safe
  const hookBlocks = KIMI_HOOK_EVENTS.map((event) => `[[hooks]]
event = "${event}"
command = '${desiredCommand}'
matcher = ""
timeout = 30
`).join("\n");

  // Append to file
  content = content.trimEnd() + "\n\n" + hookBlocks;

  fs.mkdirSync(kimiDir, { recursive: true });
  fs.writeFileSync(settingsPath, content);

  if (!options.silent) {
    console.log(`Clawd Kimi hooks → ${settingsPath}`);
    console.log(`  Added: ${KIMI_HOOK_EVENTS.length} hooks`);
  }

  return { added: KIMI_HOOK_EVENTS.length, skipped: 0, updated: 0 };
}

module.exports = {
  registerKimiHooks,
  KIMI_HOOK_EVENTS,
  normalizePermissionMode,
  MODE_EXPLICIT,
  MODE_SUSPECT,
};

if (require.main === module) {
  try {
    registerKimiHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
