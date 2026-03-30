#!/usr/bin/env node
// Merge Clawd Cursor Agent hooks into ~/.cursor/hooks.json (append-only, idempotent)

const fs = require("fs");
const path = require("path");
const os = require("os");
const MARKER = "cursor-hook.js";

const CURSOR_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "afterAgentThought",
  "stop",
];

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
 * Register Clawd hooks into ~/.cursor/hooks.json
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.hooksPath]
 * @param {number} [options.port]
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerCursorHooks(options = {}) {
  const hooksPath = options.hooksPath || path.join(os.homedir(), ".cursor", "hooks.json");
  let hookScript = path.resolve(__dirname, "cursor-hook.js").replace(/\\/g, "/");
  hookScript = hookScript.replace("app.asar/", "app.asar.unpacked/");
  const desiredCommand = `node "${hookScript}"`;

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read hooks.json: ${err.message}`);
    }
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  if (typeof settings.version !== "number") settings.version = 1;

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of CURSOR_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let stalePath = false;
    for (const entry of arr) {
      if (!entry || typeof entry !== "object" || typeof entry.command !== "string") continue;
      if (!entry.command.includes(MARKER)) continue;
      found = true;
      if (entry.command !== desiredCommand) {
        entry.command = desiredCommand;
        stalePath = true;
      }
      break;
    }

    if (found) {
      if (stalePath) {
        updated++;
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    arr.push({ command: desiredCommand });
    added++;
    changed = true;
  }

  if (added > 0 || changed) {
    writeJsonAtomic(hooksPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Cursor hooks → ${hooksPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

module.exports = { registerCursorHooks, CURSOR_HOOK_EVENTS };

if (require.main === module) {
  try {
    registerCursorHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
