#!/usr/bin/env node
// Clawd Desktop Pet — StatusLine Proxy Installer
// Registers Clawd's statusLine proxy into ~/.claude/settings.json
// Preserves the user's original statusLine command by chaining

const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeJsonAtomic, asarUnpackedPath } = require("./json-utils");
const { resolveNodeBin } = require("./server-config");

const PROXY_MARKER = "statusline-proxy.js";

/**
 * Register Clawd's statusLine proxy in Claude Code settings.
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath] - override for tests
 * @returns {{ added: boolean, updated: boolean }}
 */
function registerStatusLine(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".claude", "settings.json");
  const proxyScript = asarUnpackedPath(path.resolve(__dirname, "statusline-proxy.js").replace(/\\/g, "/"));

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") return { added: false, updated: false };
    // No settings file — nothing to do (hooks installer creates it)
  }

  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved || "node";

  const existing = settings.statusLine;
  let added = false;
  let updated = false;

  // Already registered — check if path needs updating
  if (existing && existing.type === "command" && typeof existing.command === "string" && existing.command.includes(PROXY_MARKER)) {
    // Extract original command from existing proxy invocation (everything after proxy script path)
    const originalCmd = extractOriginalFromProxy(existing.command);
    const desired = buildProxyCommand(nodeBin, proxyScript, originalCmd);
    if (existing.command !== desired) {
      existing.command = desired;
      updated = true;
      writeJsonAtomic(settingsPath, settings);
    }
    if (!options.silent && (added || updated)) {
      console.log(`Clawd: statusLine proxy ${updated ? "updated" : "unchanged"}`);
    }
    return { added, updated };
  }

  // Not registered — preserve original and wrap with proxy
  let originalCmd = null;
  if (existing && existing.type === "command" && typeof existing.command === "string") {
    originalCmd = existing.command;
  }

  settings.statusLine = {
    type: "command",
    command: buildProxyCommand(nodeBin, proxyScript, originalCmd),
    padding: (existing && typeof existing.padding === "number") ? existing.padding : 0,
  };
  added = true;

  writeJsonAtomic(settingsPath, settings);

  if (!options.silent) {
    console.log(`Clawd: statusLine proxy registered${originalCmd ? " (chaining original)" : ""}`);
  }
  return { added, updated };
}

function buildProxyCommand(nodeBin, proxyScript, originalCmd) {
  const base = `"${nodeBin}" "${proxyScript}"`;
  if (!originalCmd) return base;
  return `${base} ${originalCmd}`;
}

/**
 * Extract the original statusLine command from an existing proxy command string.
 * Format: "node" "path/to/statusline-proxy.js" original-command-here
 */
function extractOriginalFromProxy(command) {
  const idx = command.indexOf(PROXY_MARKER);
  if (idx === -1) return null;
  // Find the closing quote after the proxy script path
  const afterMarker = command.indexOf('"', idx);
  if (afterMarker === -1) return null;
  const rest = command.substring(afterMarker + 1).trim();
  return rest || null;
}

module.exports = { registerStatusLine };

if (require.main === module) {
  registerStatusLine();
}
