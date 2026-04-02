#!/usr/bin/env node
// Merge Clawd CodeBuddy hooks into CodeBuddy settings (append-only, idempotent)
// Target: ~/.codebuddy/settings.json (CodeBuddy CLI user-level config)
// Format: same as Claude Code hooks — { matcher, hooks: [{ type, command }] }

const fs = require("fs");
const path = require("path");
const os = require("os");
const MARKER = "codebuddy-hook.js";

// CodeBuddy currently supports 7 hook events (as of v1.16.0)
// https://www.codebuddy.ai/docs/zh/cli/hooks
const CODEBUDDY_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "PreCompact",
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
 * Detect CodeBuddy settings directory.
 * Per official docs, the user-level config is ~/.codebuddy/settings.json
 */
function findCodeBuddySettingsDir() {
  const primary = path.join(os.homedir(), ".codebuddy");
  if (fs.existsSync(primary)) return primary;

  // Fallback: IDE-level paths (less reliable for hooks)
  const platform = process.platform;
  const candidates = [];
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    candidates.push(
      path.join(appData, "CodeBuddy CN", "User"),
      path.join(appData, "CodeBuddy", "User"),
    );
  } else if (platform === "darwin") {
    candidates.push(
      path.join(os.homedir(), "Library", "Application Support", "CodeBuddy CN", "User"),
      path.join(os.homedir(), "Library", "Application Support", "CodeBuddy", "User"),
    );
  } else {
    candidates.push(
      path.join(os.homedir(), ".config", "CodeBuddy CN", "User"),
      path.join(os.homedir(), ".config", "CodeBuddy", "User"),
    );
  }

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Register Clawd hooks into CodeBuddy settings.json
 * Uses Claude Code-compatible format: { matcher, hooks: [{ type, command }] }
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerCodeBuddyHooks(options = {}) {
  let settingsPath = options.settingsPath;

  if (!settingsPath) {
    const settingsDir = findCodeBuddySettingsDir();
    if (!settingsDir) {
      if (!options.silent) console.log("Clawd: CodeBuddy settings directory not found — skipping hook registration");
      return { added: 0, skipped: 0, updated: 0 };
    }
    settingsPath = path.join(settingsDir, "settings.json");
  }

  let hookScript = path.resolve(__dirname, "codebuddy-hook.js").replace(/\\/g, "/");
  hookScript = hookScript.replace("app.asar/", "app.asar.unpacked/");
  const desiredCommand = `node "${hookScript}"`;

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read CodeBuddy settings.json: ${err.message}`);
    }
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of CODEBUDDY_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];

    // Check if Clawd hook already exists in any entry
    let found = false;
    let stalePath = false;
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      // Search in the nested hooks array (Claude Code format)
      const innerHooks = entry.hooks;
      if (Array.isArray(innerHooks)) {
        for (const h of innerHooks) {
          if (!h || !h.command) continue;
          if (!h.command.includes(MARKER)) continue;
          found = true;
          if (h.command !== desiredCommand) {
            h.command = desiredCommand;
            stalePath = true;
          }
          break;
        }
      }
      // Also check flat format (legacy) for cleanup
      if (!found && entry.command && entry.command.includes(MARKER)) {
        found = true;
        // Migrate from flat to nested format
        entry.matcher = entry.matcher || "";
        entry.hooks = [{ type: "command", command: desiredCommand }];
        delete entry.command;
        delete entry.type;
        delete entry.name;
        stalePath = true;
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

    // Add new entry in Claude Code-compatible format
    arr.push({
      matcher: "",
      hooks: [{ type: "command", command: desiredCommand }],
    });
    added++;
    changed = true;
  }

  if (added > 0 || changed) {
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd CodeBuddy hooks → ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

module.exports = { registerCodeBuddyHooks, CODEBUDDY_HOOK_EVENTS, findCodeBuddySettingsDir };

if (require.main === module) {
  try {
    registerCodeBuddyHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
