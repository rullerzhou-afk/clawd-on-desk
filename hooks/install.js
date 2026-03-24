#!/usr/bin/env node
// Clawd Desktop Pet — Hook Installer
// Safely merges hook commands into ~/.claude/settings.json
// Does NOT overwrite existing hooks — appends to arrays

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
  // PermissionRequest: handled by HTTP_HOOKS (blocking), not command hook
  "Elicitation",
  "WorktreeCreate",
];

const MARKER = "clawd-hook.js";
const AUTO_START_MARKER = "auto-start.js";
const LEGACY_AUTO_START_MARKER = "auto-start.sh";
const HTTP_MARKER = "23333/permission";

// HTTP hooks: PermissionRequest uses bidirectional HTTP hook for permission decisions.
// Claude Code fires PermissionRequest for tools needing approval (primarily Bash).
// Edit/Write permissions are handled by Claude Code's own permission mode — not our hook.
const HTTP_HOOKS = {
  PermissionRequest: {
    matcher: "",
    hook: {
      type: "http",
      url: "http://127.0.0.1:23333/permission",
      timeout: 600,
    },
  },
};

/**
 * Register Clawd hooks into ~/.claude/settings.json.
 * Safe to call multiple times — skips already-registered hooks.
 * @param {object} [options]
 * @param {boolean} [options.silent] - suppress console output (for auto-registration)
 * @param {boolean} [options.autoStart] - register auto-start hook for SessionStart
 * @returns {{ added: number, skipped: number }}
 */
function registerHooks(options = {}) {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let hookScript = path.resolve(__dirname, "clawd-hook.js").replace(/\\/g, "/");
  // In packaged builds, __dirname points to app.asar (virtual); the actual
  // unpacked file lives under app.asar.unpacked (see package.json asarUnpack).
  hookScript = hookScript.replace("app.asar/", "app.asar.unpacked/");

  // Read existing settings
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
    }
  }

  if (!settings.hooks) settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let changed = false;

  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      // Preserve existing non-array config by wrapping it
      const existing = settings.hooks[event];
      settings.hooks[event] = existing && typeof existing === "object" ? [existing] : [];
      changed = true;  // format was normalized, need to persist
    }

    // Check if our hook is already registered (search nested hooks arrays too)
    const alreadyExists = settings.hooks[event].some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      // Flat format: { type, command }
      if (typeof entry.command === "string" && entry.command.includes(MARKER)) return true;
      // Nested format: { matcher, hooks: [{ type, command }] }
      if (Array.isArray(entry.hooks)) {
        return entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(MARKER));
      }
      return false;
    });

    if (alreadyExists) {
      skipped++;
      continue;
    }

    // Use nested format to match Claude Code's expected structure
    settings.hooks[event].push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: `node "${hookScript}" ${event}`,
        },
      ],
    });
    added++;
  }

  // Register auto-start hook for SessionStart (launches app if not running)
  if (options.autoStart) {
    let autoStartScript = path.resolve(__dirname, "auto-start.js").replace(/\\/g, "/");
    autoStartScript = autoStartScript.replace("app.asar/", "app.asar.unpacked/");

    if (!Array.isArray(settings.hooks.SessionStart)) {
      settings.hooks.SessionStart = [];
      changed = true;
    }

    const autoStartExists = settings.hooks.SessionStart.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (typeof entry.command === "string" && entry.command.includes(AUTO_START_MARKER)) return true;
      if (Array.isArray(entry.hooks)) {
        return entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(AUTO_START_MARKER));
      }
      return false;
    });

    if (!autoStartExists) {
      // Insert at index 0 — must run BEFORE clawd-hook.js so the app is starting
      settings.hooks.SessionStart.unshift({
        matcher: "",
        hooks: [{ type: "command", command: `node "${autoStartScript}"` }],
      });
      added++;
    } else {
      skipped++;
    }

    // Remove all legacy auto-start.sh entries if present
    const beforeLen = settings.hooks.SessionStart.length;
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter((entry) => {
      if (!entry || typeof entry !== "object") return true;
      if (typeof entry.command === "string" && entry.command.includes(LEGACY_AUTO_START_MARKER)) return false;
      if (Array.isArray(entry.hooks)) {
        if (entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(LEGACY_AUTO_START_MARKER))) return false;
      }
      return true;
    });
    if (settings.hooks.SessionStart.length < beforeLen) changed = true;
  }

  // Register HTTP hooks (permission decision collection)
  for (const [event, { matcher, hook }] of Object.entries(HTTP_HOOKS)) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    // Check if HTTP hook already registered (by URL marker + matcher)
    const httpExists = settings.hooks[event].some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      // Flat format: { type: "http", url }
      if (entry.type === "http" && typeof entry.url === "string" && entry.url.includes(HTTP_MARKER)) return true;
      // Nested format: { matcher, hooks: [{ type: "http", url }] }
      if (Array.isArray(entry.hooks)) {
        return entry.hooks.some((h) => h && h.type === "http" && typeof h.url === "string" && h.url.includes(HTTP_MARKER));
      }
      return false;
    });

    if (httpExists) {
      skipped++;
      continue;
    }

    settings.hooks[event].push({
      matcher,
      hooks: [hook],
    });
    added++;
  }

  // Only write if something changed (avoid unnecessary disk I/O)
  if (added > 0 || changed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  if (!options.silent) {
    console.log(`Clawd hooks installed to ${settingsPath}`);
    console.log(`  Added: ${added} hooks`);
    if (skipped > 0) console.log(`  Skipped: ${skipped} (already registered)`);
    console.log(`\nHook events: ${HOOK_EVENTS.join(", ")}`);
    if (Object.keys(HTTP_HOOKS).length > 0) {
      console.log(`HTTP hooks: ${Object.keys(HTTP_HOOKS).join(", ")}`);
    }
  }

  return { added, skipped };
}

/**
 * Remove the auto-start hook from SessionStart in ~/.claude/settings.json.
 * Also removes legacy auto-start.sh entries.
 * @returns {boolean} true if a hook was removed
 */
function unregisterAutoStart() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return false;
  }

  const arr = settings.hooks && settings.hooks.SessionStart;
  if (!Array.isArray(arr)) return false;

  const before = arr.length;
  settings.hooks.SessionStart = arr.filter((entry) => {
    if (!entry || typeof entry !== "object") return true;
    // Remove auto-start.js entries
    if (typeof entry.command === "string" && entry.command.includes(AUTO_START_MARKER)) return false;
    if (Array.isArray(entry.hooks)) {
      if (entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(AUTO_START_MARKER))) return false;
    }
    // Remove legacy auto-start.sh entries
    if (typeof entry.command === "string" && entry.command.includes(LEGACY_AUTO_START_MARKER)) return false;
    if (Array.isArray(entry.hooks)) {
      if (entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(LEGACY_AUTO_START_MARKER))) return false;
    }
    return true;
  });

  if (settings.hooks.SessionStart.length < before) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    return true;
  }
  return false;
}

/**
 * Check if the auto-start hook is currently registered in settings.json.
 * @returns {boolean}
 */
function isAutoStartRegistered() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const arr = settings.hooks && settings.hooks.SessionStart;
    if (!Array.isArray(arr)) return false;
    return arr.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (typeof entry.command === "string" && entry.command.includes(AUTO_START_MARKER)) return true;
      if (Array.isArray(entry.hooks)) {
        return entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(AUTO_START_MARKER));
      }
      return false;
    });
  } catch {
    return false;
  }
}

// Export for use by main.js
module.exports = { registerHooks, unregisterAutoStart, isAutoStartRegistered };

// CLI: run directly with `node hooks/install.js`
if (require.main === module) {
  try {
    registerHooks();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
