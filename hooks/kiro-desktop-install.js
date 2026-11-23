#!/usr/bin/env node
"use strict";
// This dedicated hooks file is only mutated by Clawd. Atomic replacement is
// sufficient here, without a shared-store lock across unrelated Kiro settings.
// KiroCrew's parser recognizes the same simple Node launcher shape, so reuse
// its strict token parsing while keeping the IDE's script ownership separate.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const { resolveNodeBin } = require("./server-config");
const { readJsonFile, writeJsonAtomic, asarUnpackedPath, formatNodeHookCommand } = require("./json-utils");
const { parseKiroCrewCommand } = require("./kirocrew-command");

const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".kiro");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "hooks", "clawd-on-desk.json");
const MARKER = "kiro-desktop-hook.js";
const KIRO_DESKTOP_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

function isOwnedKiroDesktopCommand(command) {
  // Both hosts use simple Node launchers. Basename ownership lets an app move
  // without leaving stale registrations, while rejecting marker substrings.
  const tokens = parseKiroCrewCommand(command);
  if (!tokens) return false;
  const basename = token => token.replace(/\\/g, "/").split("/").pop();
  return /^node(?:\.exe)?$/i.test(basename(tokens[0]))
    && basename(tokens[1]).toLowerCase() === MARKER;
}

function isOwnedEntry(entry) {
  return entry?.action?.type === "command" && isOwnedKiroDesktopCommand(entry.action.command);
}

function validateDocument(settings, hooksPath) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || !Array.isArray(settings.hooks)) {
    throw new Error(`Refusing to modify ${hooksPath}: expected an object with a hooks array`);
  }
  if (Object.hasOwn(settings, "version") && settings.version !== "v1") {
    throw new Error(`Refusing to modify ${hooksPath}: unsupported version`);
  }
}

function configPath(options) {
  return path.join(options.homeDir || os.homedir(), ".kiro", "hooks", "clawd-on-desk.json");
}

function registerKiroDesktopHooks(options = {}) {
  const hooksPath = configPath(options);
  let settings;
  try { settings = readJsonFile(hooksPath); }
  catch (err) {
    if (err.code !== "ENOENT") throw err;
    settings = { version: "v1", hooks: [] };
  }
  validateDocument(settings, hooksPath);
  const owned = settings.hooks.filter(isOwnedEntry);
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved || (owned.length && parseKiroCrewCommand(owned[0].action.command)[0]) || "node";
  const scriptPath = asarUnpackedPath(options.scriptPath || path.join(__dirname, MARKER));
  const command = formatNodeHookCommand(nodeBin, scriptPath, {
    platform: options.platform || process.platform,
    windowsWrapper: "none",
  });
  if (!isOwnedKiroDesktopCommand(command)) {
    throw new Error("Cannot safely manage Kiro IDE hooks: "
      + "the Node or script path contains unsupported characters, such as ! or %");
  }
  const hooks = KIRO_DESKTOP_HOOK_EVENTS.map(trigger => ({
    name: `Clawd ${trigger}`, trigger, action: { type: "command", command },
  }));
  const desired = { ...settings, version: "v1", hooks: [...settings.hooks.filter(entry => !isOwnedEntry(entry)), ...hooks] };
  const current = isDeepStrictEqual(settings, desired);
  if (!current) {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    writeJsonAtomic(hooksPath, desired);
  }
  // Count new triggers as additions and existing owned triggers as updates.
  const added = current ? 0 : hooks.filter(hook => !owned.some(entry => entry.trigger === hook.trigger)).length;
  return {
    added,
    updated: current ? 0 : hooks.length - added,
    skipped: current ? KIRO_DESKTOP_HOOK_EVENTS.length : 0,
    hooksPath,
  };
}

function unregisterKiroDesktopHooks(options = {}) {
  const hooksPath = configPath(options);
  let settings;
  try {
    settings = readJsonFile(hooksPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, hooksPath, registrationRemoved: true };
    return { removed: 0, changed: false, hooksPath, registrationRemoved: null, error: err.message };
  }

  try {
    validateDocument(settings, hooksPath);
    const hooks = settings.hooks.filter(entry => !isOwnedEntry(entry));
    const removed = settings.hooks.length - hooks.length;
    if (removed) {
      const onlyVersion = Object.keys(settings).every(key => key === "hooks" || key === "version");
      if (!hooks.length && onlyVersion) fs.unlinkSync(hooksPath);
      else writeJsonAtomic(hooksPath, { ...settings, hooks });
    }
    return { removed, changed: removed > 0, hooksPath, registrationRemoved: true };
  } catch (err) {
    return { removed: 0, changed: false, hooksPath, registrationRemoved: null, error: err.message };
  }
}

module.exports = { DEFAULT_PARENT_DIR, DEFAULT_CONFIG_PATH, MARKER, KIRO_DESKTOP_HOOK_EVENTS,
  isOwnedKiroDesktopCommand, registerKiroDesktopHooks, unregisterKiroDesktopHooks };
if (require.main === module) {
  try {
    const result = process.argv.includes("--uninstall") ? unregisterKiroDesktopHooks() : registerKiroDesktopHooks();
    if (result.registrationRemoved === null) throw new Error(result.error);
    console.log(result);
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
