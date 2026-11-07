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
  unregisterRemoteOwnedCodexHooks,
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
    // Codex trusts the resolved command shape. POSIX keeps a stable wrapper;
    // Windows uses a direct PowerShell call-operator command because Defender
    // flags the former inline data-sidecar dispatcher. In-place app upgrades
    // keep the direct path stable, while a real Node/hook path change requires
    // a fresh Codex /hooks review.
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
  unregisterRemoteOwnedCodexHooks,
};

// Validate the whole command line before touching any configuration. Unknown
// flags must fail closed: an older controller running this script with a new
// flag must not fall through into a local registration.
function runCli(argv = process.argv) {
  const args = argv.slice(2);
  let remote = false;
  let uninstall = false;
  let remoteUninstallOwned = false;
  let hooksDir = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--remote") {
      remote = true;
    } else if (arg === "--uninstall") {
      uninstall = true;
    } else if (arg === "--remote-uninstall-owned") {
      remoteUninstallOwned = true;
    } else if (arg === "--hooks-dir") {
      const value = args[i + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) {
        throw new Error("Remote owned uninstall requires --hooks-dir <dir>");
      }
      hooksDir = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (uninstall && remoteUninstallOwned) {
    throw new Error("--uninstall and --remote-uninstall-owned cannot be combined");
  }
  if (remoteUninstallOwned) {
    if (!hooksDir) throw new Error("Remote owned uninstall requires --hooks-dir <dir>");
    return unregisterRemoteOwnedCodexHooks({ hooksDir });
  }
  if (hooksDir) throw new Error("--hooks-dir is only valid with --remote-uninstall-owned");
  if (uninstall) return unregisterCodexHooks({});
  return registerCodexHooks({ remote });
}

if (require.main === module) {
  try {
    runCli();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
