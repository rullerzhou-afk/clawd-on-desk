#!/usr/bin/env node
// Merge Clawd Gemini CLI hooks into ~/.gemini/settings.json (append-only, idempotent)

const fs = require("fs");
const path = require("path");
const os = require("os");
const MARKER = "gemini-hook.js";

const GEMINI_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "BeforeAgent",
  "AfterAgent",
  "BeforeTool",
  "AfterTool",
  "Notification",
  "PreCompress",
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
 * Register Clawd hooks into ~/.gemini/settings.json
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerGeminiHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".gemini", "settings.json");

  // Skip if ~/.gemini/ doesn't exist (Gemini CLI not installed)
  const geminiDir = path.dirname(settingsPath);
  if (!options.settingsPath && !fs.existsSync(geminiDir)) {
    if (!options.silent) console.log("Clawd: ~/.gemini/ not found — skipping Gemini hook registration");
    return { added: 0, skipped: 0, updated: 0 };
  }

  let hookScript = path.resolve(__dirname, "gemini-hook.js").replace(/\\/g, "/");
  hookScript = hookScript.replace("app.asar/", "app.asar.unpacked/");
  const desiredCommand = `node "${hookScript}"`;

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
    }
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of GEMINI_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let stalePath = false;
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      const cmd = entry.command || "";
      if (!cmd.includes(MARKER)) continue;
      found = true;
      if (cmd !== desiredCommand) {
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

    arr.push({ type: "command", command: desiredCommand, name: "clawd" });
    added++;
    changed = true;
  }

  if (added > 0 || changed) {
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Gemini hooks → ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

module.exports = { registerGeminiHooks, GEMINI_HOOK_EVENTS };

if (require.main === module) {
  try {
    registerGeminiHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
