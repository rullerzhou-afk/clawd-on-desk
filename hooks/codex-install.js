#!/usr/bin/env node
// Merge Clawd Codex official hooks into ~/.codex/hooks.json.
//
// PermissionRequest is registered in Phase 2. Keep its output path constrained
// to behavior/message only; Codex currently fail-closes on several future
// decision fields.

const {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_FEATURES_CONFIG,
  CODEX_HOOK_EVENTS,
  buildCodexHookCommand,
  registerCodexCommandHooks,
  removeStableCodexHookLauncher,
  unregisterCodexCommandHooks,
} = require("./codex-install-utils");

const MARKER = "codex-hook.js";
const CODEX_OFFICIAL_HOOK_EVENTS = CODEX_HOOK_EVENTS;

function buildCodexStateHookCommand(nodeBin, hookScript, platform = process.platform) {
  return buildCodexHookCommand(nodeBin, hookScript, platform);
}

function registerCodexHooks(options = {}) {
  return registerCodexCommandHooks({
    ...options,
    marker: MARKER,
    scriptName: MARKER,
    events: CODEX_OFFICIAL_HOOK_EVENTS,
    label: "Codex official hooks",
    // Codex trusts the resolved command shape. Keep that command on a stable
    // per-CODEX_HOME platform entry (Windows data-sidecar dispatcher, POSIX
    // wrapper); Node and the active packaged/dev hook path can then change
    // without rewriting hooks.json.
    stableLauncher: options.remote !== true && options.stableLauncher !== false,
  });
}

function unregisterCodexHooks(options = {}) {
  const result = unregisterCodexCommandHooks({
    ...options,
    marker: MARKER,
    events: CODEX_OFFICIAL_HOOK_EVENTS,
  });
  const stableLauncher = removeStableCodexHookLauncher(options);
  return {
    ...result,
    changed: result.changed === true || stableLauncher.changed,
    stableLauncher,
  };
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_FEATURES_CONFIG,
  CODEX_OFFICIAL_HOOK_EVENTS,
  CODEX_STATE_HOOK_EVENTS: CODEX_OFFICIAL_HOOK_EVENTS,
  buildCodexStateHookCommand,
  registerCodexHooks,
  unregisterCodexHooks,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterCodexHooks({});
    else registerCodexHooks({ remote: process.argv.includes("--remote") });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
