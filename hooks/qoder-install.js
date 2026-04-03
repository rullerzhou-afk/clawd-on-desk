#!/usr/bin/env node
// Merge Clawd Qoder hooks into ~/.qoder/settings.json (append-only, idempotent)
// Based on https://docs.qoder.com/zh/extensions/hooks

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const MARKER = "qoder-hook.js";

/** Extract the existing absolute node path from hook commands containing marker. */
function extractExistingNodeBin(settings, marker) {
  if (!settings || !settings.hooks) return null;
  for (const entries of Object.values(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      // Qoder uses nested format: entry.hooks[].command
      if (Array.isArray(entry.hooks)) {
        for (const hook of entry.hooks) {
          if (!hook || typeof hook !== "object" || typeof hook.command !== "string") continue;
          if (!hook.command.includes(marker)) continue;
          const qi = hook.command.indexOf('"');
          if (qi === -1) continue;
          const qe = hook.command.indexOf('"', qi + 1);
          if (qe === -1) continue;
          const first = hook.command.substring(qi + 1, qe);
          if (!first.includes(marker) && first.startsWith("/")) return first;
        }
      }
    }
  }
  return null;
}

// Qoder hook events to register
// Based on docs: UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop
const QODER_HOOK_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
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
 * Register Clawd hooks into ~/.qoder/settings.json
 * Qoder hook format:
 * {
 *   "hooks": {
 *     "EventName": [
 *       {
 *         "matcher": "...",
 *         "hooks": [
 *           { "type": "command", "command": "..." }
 *         ]
 *       }
 *     ]
 *   }
 * }
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerQoderHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".qoder", "settings.json");

  // Skip if ~/.qoder/ doesn't exist (Qoder not installed)
  const qoderDir = path.dirname(settingsPath);
  if (!options.settingsPath && !fs.existsSync(qoderDir)) {
    if (!options.silent) console.log("Clawd: ~/.qoder/ not found — skipping Qoder hook registration");
    return { added: 0, skipped: 0, updated: 0 };
  }

  let hookScript = path.resolve(__dirname, "qoder-hook.js").replace(/\\/g, "/");
  hookScript = hookScript.replace("app.asar/", "app.asar.unpacked/");

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
    }
  }

  // Resolve node path; if detection fails, preserve existing absolute path
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER)
    || "node";
  const desiredCommand = `"${nodeBin}" "${hookScript}"`;

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of QODER_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let stalePath = false;

    // Search for existing Clawd hook entry
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;

      // Check nested hooks array format (Qoder uses matcher + hooks structure)
      if (Array.isArray(entry.hooks)) {
        for (const hook of entry.hooks) {
          if (!hook || typeof hook !== "object" || typeof hook.command !== "string") continue;
          if (!hook.command.includes(MARKER)) continue;
          found = true;
          if (hook.command !== desiredCommand) {
            hook.command = desiredCommand;
            stalePath = true;
          }
          break;
        }
      }
      if (found) break;
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

    // Add new hook entry using Qoder's nested format
    arr.push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: desiredCommand,
        },
      ],
    });
    added++;
    changed = true;
  }

  if (added > 0 || changed) {
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Qoder hooks → ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

/**
 * Unregister Clawd hooks from ~/.qoder/settings.json
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @returns {{ removed: number }}
 */
function unregisterQoderHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".qoder", "settings.json");

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      return { removed: 0 };
    }
    throw new Error(`Failed to read settings.json: ${err.message}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { removed: 0 };
  }

  let removed = 0;
  let changed = false;

  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;

    const originalLen = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((entry) => {
      if (!entry || typeof entry !== "object") return true;

      // Check nested hooks array
      if (Array.isArray(entry.hooks)) {
        const hasClawdHook = entry.hooks.some(
          (hook) => hook && typeof hook.command === "string" && hook.command.includes(MARKER)
        );
        if (hasClawdHook) return false;
      }
      return true;
    });

    const removedCount = originalLen - settings.hooks[event].length;
    if (removedCount > 0) {
      removed += removedCount;
      changed = true;
    }
  }

  if (changed) {
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent && removed > 0) {
    console.log(`Clawd: Removed ${removed} Qoder hooks from ${settingsPath}`);
  }

  return { removed };
}

module.exports = { registerQoderHooks, unregisterQoderHooks };

// CLI execution
if (require.main === module) {
  registerQoderHooks({ silent: false });
}
