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

const COMMAND_WITH_MARKER_REGEX = new RegExp(
  `command\\s*=\\s*"(?:\\\\.|[^"\\\\])*${MARKER}(?:\\\\.|[^"\\\\])*"|command\\s*=\\s*'[^']*${MARKER}[^']*'`
);

function normalizePermissionMode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === MODE_EXPLICIT || normalized === MODE_SUSPECT) return normalized;
  return null;
}

// Extract any existing CLAWD_KIMI_PERMISSION_MODE=... prefix from Clawd-owned
// hook command lines in config.toml. Used as a fallback when the caller did
// not pass an explicit mode AND no env var is set — without this, the startup
// auto-sync would silently strip the prefix written by a previous install,
// breaking the "persistent mode" promise documented in setup-guide.md.
function extractExistingPermissionMode(content) {
  if (typeof content !== "string" || !content) return null;
  // Match both quoting styles. The double-quoted branch must allow `\"` inside
  // because Clawd installer historically wrote `command = "...\"node\" \"...kimi-hook.js\""`.
  // A naive `[^"]*` truncates at the first `\"`, drops MARKER, and silently
  // returns null — which is exactly the regression that erased the user's
  // suspect-mode prefix on startup auto-sync.
  const lineRegex = /command\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')/g;
  let match;
  while ((match = lineRegex.exec(content)) !== null) {
    const value = match[1] || match[2] || "";
    if (!value.includes(MARKER)) continue;
    const modeMatch = value.match(/CLAWD_KIMI_PERMISSION_MODE=([A-Za-z]+)/);
    if (modeMatch) {
      const normalized = normalizePermissionMode(modeMatch[1]);
      if (normalized) return normalized;
    }
  }
  return null;
}

// Remove every [[hooks]] block whose command references Clawd's kimi-hook.js.
// A block ends at the next TOML section header (`[x]` or `[[x]]`) or EOF —
// NOT only at the next `[[hooks]]`. Using the narrower lookahead would cause
// a regex-based pass to greedily swallow any trailing `[server]`, `[mcp]`,
// `[[tools]]`, etc. that the user added after their hooks, silently deleting
// their own config. Walking line-by-line avoids that entirely.
function stripClawdKimiHookBlocks(content) {
  if (typeof content !== "string" || !content) return { content: "", removed: 0 };
  const HEADER_RE = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
  const HOOKS_HEADER_RE = /^\s*\[\[hooks\]\]\s*(?:#.*)?$/;
  const lines = content.split("\n");
  const output = [];
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (HOOKS_HEADER_RE.test(line)) {
      const start = i;
      let j = i + 1;
      while (j < lines.length && !HEADER_RE.test(lines[j])) j++;
      const block = lines.slice(start, j).join("\n");
      if (COMMAND_WITH_MARKER_REGEX.test(block)) {
        removed++;
      } else {
        output.push(block);
      }
      i = j;
    } else {
      output.push(line);
      i++;
    }
  }
  return { content: output.join("\n"), removed };
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

  // Priority: explicit caller option → env var → mode already baked into the
  // existing config.toml hook command. The fallback is critical for the
  // startup auto-sync path: Clawd launches without the env var, sees an
  // existing install that was done with CLAWD_KIMI_PERMISSION_MODE=suspect,
  // and MUST preserve that prefix so the user's persistent choice survives.
  const providedMode = normalizePermissionMode(
    options.permissionMode !== undefined
      ? options.permissionMode
      : process.env.CLAWD_KIMI_PERMISSION_MODE
  );
  const configuredMode = providedMode || extractExistingPermissionMode(content);
  const modePrefix = configuredMode ? `CLAWD_KIMI_PERMISSION_MODE=${configuredMode} ` : "";
  const desiredCommand = `${modePrefix}"${nodeBin}" "${hookScript}"`;

  // Check if our hooks are already registered (matches both single and double quotes)
  const markerRegex = new RegExp(COMMAND_WITH_MARKER_REGEX.source, "g");
  const existingMatches = [...content.matchAll(markerRegex)];

  if (existingMatches.length > 0) {
    // Normalize + de-duplicate all Clawd-owned Kimi hook blocks. A stale extra
    // block can fire duplicate PreToolUse events that cancel suspect timers and
    // suppress notification animation.
    const stripped = stripClawdKimiHookBlocks(content);
    let normalized = stripped.content;
    normalized = normalized.replace(/^hooks\s*=\s*\[\]\s*$/m, "");
    const hookBlocks = KIMI_HOOK_EVENTS.map((event) => `[[hooks]]
event = "${event}"
command = '${desiredCommand}'
matcher = ""
timeout = 30
`).join("\n");
    normalized = normalized.trimEnd() + "\n\n" + hookBlocks;
    const updated = normalized !== content ? 1 : 0;
    content = normalized;
    if (updated > 0) {
      fs.mkdirSync(kimiDir, { recursive: true });
      fs.writeFileSync(settingsPath, content);
    }
    if (!options.silent) {
      console.log(`Clawd Kimi hooks → ${settingsPath}`);
      if (updated > 0) {
        console.log(`  Updated: normalized ${existingMatches.length} existing hook command(s)`);
        if (stripped.removed > KIMI_HOOK_EVENTS.length) {
          console.log(`  Deduped: removed ${stripped.removed - KIMI_HOOK_EVENTS.length} duplicate block(s)`);
        }
      } else {
        console.log("  Skipped: already registered");
      }
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
  extractExistingPermissionMode,
  stripClawdKimiHookBlocks,
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
