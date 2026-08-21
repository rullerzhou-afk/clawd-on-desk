#!/usr/bin/env node
// Register Clawd's mimocode plugin in the user's global mimocode config.
//
// Thin wrapper over the shared opencode-family installer
// (hooks/opencode-family-install.js). It preserves the FULL legacy surface —
// named exports, return shapes (incl. the "mimocode-not-found" reason string
// that integration-sync branches on), and the CLI entry — see
// docs/project/agent-runtime-architecture.md.
//
// mimocode's config is JSONC (~/.config/mimocode/mimocode.jsonc), so the
// shared installer routes edits through hooks/opencode-family-jsonc.js
// (element-level jsonc-parser edits that preserve user comments).

const { makeFamilyInstaller } = require("./opencode-family-install");

const installer = makeFamilyInstaller("mimocode");

module.exports = {
  DEFAULT_PARENT_DIR: installer.DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH: installer.DEFAULT_CONFIG_PATH,
  registerMimocodePlugin: installer.register,
  unregisterMimocodePlugin: installer.unregister,
  resolvePluginDir: installer.resolvePluginDir,
  __test: installer.__test,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) installer.unregister({});
    else installer.register({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
