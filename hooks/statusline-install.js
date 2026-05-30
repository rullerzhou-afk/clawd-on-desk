#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code statusLine tap installer
//
// Registers hooks/clawd-statusline-tap.js as the Claude Code `statusLine`
// command so the usage gauge gets live rate_limits from CC's stdin with zero
// usage-API calls. Marker-based and non-destructive:
//
//   - No existing statusLine  -> install ours bare.
//   - Existing statusLine that is NOT ours -> wrap it: our tap runs first, then
//     proxies stdin to the original command via `--chain "<original>"`, passing
//     its stdout straight through. The user's statusline keeps working.
//   - Existing statusLine that IS ours (marker present) -> refresh in place
//     (update node bin / script path, preserve the chained command).
//   - uninstall -> restore the chained original (or drop the entry if there was
//     none). Never touches a statusLine we don't own.
//
// This is intentionally gated: callers decide WHEN to register (e.g. only when
// Claude Code is enabled and hook management is on), so we never force-edit
// settings.json for users who don't run CC.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeJsonAtomic, asarUnpackedPath } = require("./json-utils");

const MARKER = "clawd-statusline-tap.js";

function defaultSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function defaultTapScriptPath() {
  return asarUnpackedPath(path.resolve(__dirname, "clawd-statusline-tap.js").replace(/\\/g, "/"));
}

function isOurStatusLine(statusLine) {
  return !!statusLine
    && typeof statusLine === "object"
    && typeof statusLine.command === "string"
    && statusLine.command.includes(MARKER);
}

// Pull the chained original command out of one of our tap commands, if any.
// Matches `--chain "<cmd>"` and `--chain '<cmd>'`. Returns null when absent.
function extractChainedCommand(command) {
  if (typeof command !== "string") return null;
  const dq = command.match(/--chain\s+"((?:\\.|[^"\\])*)"/);
  if (dq) return dq[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const sq = command.match(/--chain\s+'([^']*)'/);
  if (sq) return sq[1];
  return null;
}

// Build the tap command string. When `chainedCommand` is set we append a
// double-quoted `--chain "<cmd>"` so the original statusline is proxied.
function buildTapCommand(nodeBin, scriptPath, chainedCommand) {
  let command = `"${nodeBin}" "${scriptPath}"`;
  if (typeof chainedCommand === "string" && chainedCommand.trim()) {
    const escaped = chainedCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    command += ` --chain "${escaped}"`;
  }
  return { type: "command", command };
}

function readSettings(settingsPath, readFileSync) {
  try {
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Compute the next statusLine entry from the current one. Returns the merged
// command spec. Pure (no IO) so it's easy to test.
function planRegister(currentStatusLine, nodeBin, scriptPath) {
  if (isOurStatusLine(currentStatusLine)) {
    // Refresh ours in place, preserving any chained original.
    const chained = extractChainedCommand(currentStatusLine.command);
    return buildTapCommand(nodeBin, scriptPath, chained);
  }
  if (currentStatusLine && typeof currentStatusLine === "object"
      && typeof currentStatusLine.command === "string"
      && currentStatusLine.command.trim()) {
    // Wrap the user's existing statusline so it keeps rendering.
    return buildTapCommand(nodeBin, scriptPath, currentStatusLine.command);
  }
  return buildTapCommand(nodeBin, scriptPath, null);
}

// Compute the next statusLine after removing ours. Returns the restored chained
// command spec, or null to delete the entry. Pure.
function planUnregister(currentStatusLine) {
  if (!isOurStatusLine(currentStatusLine)) {
    // Not ours — leave whatever is there untouched.
    return { keep: true, statusLine: currentStatusLine };
  }
  const chained = extractChainedCommand(currentStatusLine.command);
  if (chained && chained.trim()) {
    return { keep: false, statusLine: { type: "command", command: chained } };
  }
  return { keep: false, statusLine: null };
}

function registerStatuslineTap(options = {}) {
  const settingsPath = options.settingsPath || defaultSettingsPath();
  const scriptPath = options.scriptPath || defaultTapScriptPath();
  const nodeBin = options.nodeBin || process.execPath || "node";
  const readFileSync = options.readFileSync || fs.readFileSync;
  const writeJson = options.writeJsonAtomic || writeJsonAtomic;

  const settings = readSettings(settingsPath, readFileSync);
  const before = JSON.stringify(settings.statusLine);
  settings.statusLine = planRegister(settings.statusLine, nodeBin, scriptPath);
  const after = JSON.stringify(settings.statusLine);
  const changed = before !== after;
  if (changed) writeJson(settingsPath, settings);
  return { changed, statusLine: settings.statusLine };
}

function unregisterStatuslineTap(options = {}) {
  const settingsPath = options.settingsPath || defaultSettingsPath();
  const readFileSync = options.readFileSync || fs.readFileSync;
  const writeJson = options.writeJsonAtomic || writeJsonAtomic;

  const settings = readSettings(settingsPath, readFileSync);
  const plan = planUnregister(settings.statusLine);
  if (plan.keep) return { changed: false, statusLine: settings.statusLine };

  if (plan.statusLine == null) delete settings.statusLine;
  else settings.statusLine = plan.statusLine;
  writeJson(settingsPath, settings);
  return { changed: true, statusLine: plan.statusLine };
}

module.exports = {
  MARKER,
  defaultSettingsPath,
  defaultTapScriptPath,
  isOurStatusLine,
  extractChainedCommand,
  buildTapCommand,
  planRegister,
  planUnregister,
  registerStatuslineTap,
  unregisterStatuslineTap,
};
