#!/usr/bin/env node
// Merge Clawd Gemini CLI hooks into ~/.gemini/settings.json (append-only, idempotent)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const { writeJsonAtomic, asarUnpackedPath, extractExistingNodeBin, formatNodeHookCommand } = require("./json-utils");
const MARKER = "gemini-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".gemini");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "settings.json");

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

function isClawdHookCommand(command) {
  return typeof command === "string" && command.includes(MARKER);
}

function buildGeminiHookEntry(command) {
  return {
    matcher: "*",
    hooks: [{ name: "clawd", type: "command", command }],
  };
}

function buildGeminiHookCommand(nodeBin, hookScript, event, options = {}) {
  const opts = options.windowsWrapper !== undefined ? options : { ...options, windowsWrapper: "none" };
  return formatNodeHookCommand(nodeBin, hookScript, { ...opts, args: [event] });
}

function replaceEntry(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function isDesiredGeminiHookEntry(entry, desiredCommand) {
  return !!(
    entry
    && typeof entry === "object"
    && entry.matcher === "*"
    && Array.isArray(entry.hooks)
    && entry.hooks.length === 1
    && entry.hooks[0]
    && entry.hooks[0].name === "clawd"
    && entry.hooks[0].type === "command"
    && entry.hooks[0].command === desiredCommand
  );
}

function normalizeGeminiHookEntries(entries, desiredCommand) {
  if (!Array.isArray(entries)) return { matched: false, changed: false };

  let matched = false;
  let changed = false;
  let dedicatedIndex = -1;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;

    if (isClawdHookCommand(entry.command)) {
      matched = true;
      if (dedicatedIndex === -1) {
        replaceEntry(entry, buildGeminiHookEntry(desiredCommand));
        dedicatedIndex = index;
        changed = true;
      } else {
        entries.splice(index, 1);
        index--;
        changed = true;
      }
      continue;
    }

    if (!Array.isArray(entry.hooks)) continue;
    const otherHooks = [];
    let clawdHookCount = 0;
    for (const hook of entry.hooks) {
      if (hook && isClawdHookCommand(hook.command)) {
        clawdHookCount++;
      } else {
        otherHooks.push(hook);
      }
    }
    if (clawdHookCount === 0) continue;

    matched = true;
    if (otherHooks.length > 0) {
      entry.hooks = otherHooks;
      changed = true;
      continue;
    }

    if (dedicatedIndex === -1) {
      if (!isDesiredGeminiHookEntry(entry, desiredCommand)) {
        replaceEntry(entry, buildGeminiHookEntry(desiredCommand));
        changed = true;
      }
      dedicatedIndex = index;
      continue;
    }

    entries.splice(index, 1);
    index--;
    changed = true;
  }

  if (!matched) return { matched: false, changed: false };

  if (dedicatedIndex === -1) {
    entries.push(buildGeminiHookEntry(desiredCommand));
    return { matched: true, changed: true };
  }

  const dedicatedEntry = entries[dedicatedIndex];
  if (!isDesiredGeminiHookEntry(dedicatedEntry, desiredCommand)) {
    replaceEntry(dedicatedEntry, buildGeminiHookEntry(desiredCommand));
    changed = true;
  }
  return { matched: true, changed };
}

function normalizeGeminiDisabledHooks(settings) {
  const hooksConfig = settings && typeof settings === "object" ? settings.hooksConfig : null;
  if (!hooksConfig || typeof hooksConfig !== "object" || !Array.isArray(hooksConfig.disabled)) return false;

  let changed = false;
  let sawClawd = false;
  const nextDisabled = [];

  for (const entry of hooksConfig.disabled) {
    if (entry === "clawd") {
      if (sawClawd) {
        changed = true;
        continue;
      }
      sawClawd = true;
      nextDisabled.push(entry);
      continue;
    }

    if (isClawdHookCommand(entry)) {
      if (!sawClawd) {
        nextDisabled.push("clawd");
        sawClawd = true;
      }
      changed = true;
      continue;
    }

    nextDisabled.push(entry);
  }

  if (changed) hooksConfig.disabled = nextDisabled;
  return changed;
}

/**
 * Register Clawd hooks into ~/.gemini/settings.json
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @param {string} [options.homeDir] internal override for tests
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerGeminiHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const settingsPath = options.settingsPath || path.join(homeDir, ".gemini", "settings.json");

  // Skip if ~/.gemini/ doesn't exist (Gemini CLI not installed)
  const geminiDir = path.dirname(settingsPath);
  if (!options.settingsPath && !fs.existsSync(geminiDir)) {
    if (!options.silent) console.log("Clawd: ~/.gemini/ not found — skipping Gemini hook registration");
    return { added: 0, skipped: 0, updated: 0 };
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "gemini-hook.js").replace(/\\/g, "/"));

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
    || extractExistingNodeBin(settings, MARKER, { nested: true })
    || "node";

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  if (normalizeGeminiDisabledHooks(settings)) changed = true;

  for (const event of GEMINI_HOOK_EVENTS) {
    const desiredCommand = buildGeminiHookCommand(nodeBin, hookScript, event);
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    const result = normalizeGeminiHookEntries(arr, desiredCommand);
    const found = result.matched;
    const entryChanged = result.changed;
    if (entryChanged) changed = true;

    if (found) {
      if (entryChanged) {
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    arr.push(buildGeminiHookEntry(desiredCommand));
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

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  registerGeminiHooks,
  GEMINI_HOOK_EVENTS,
  __test: { buildGeminiHookCommand },
};

if (require.main === module) {
  try {
    registerGeminiHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
