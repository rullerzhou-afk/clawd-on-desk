#!/usr/bin/env node
// Register Clawd's opencode plugin in the user's global opencode config.
//
// Thin wrapper over the shared opencode-family installer
// (hooks/opencode-family-install.js). It preserves the FULL legacy surface —
// named exports, return shapes (incl. the "opencode-not-found" reason string
// that integration-sync branches on), and the CLI entry — see
// docs/project/agent-runtime-architecture.md.

const { makeFamilyInstaller } = require("./opencode-family-install");

const installer = makeFamilyInstaller("opencode");

module.exports = {
  DEFAULT_PARENT_DIR: installer.DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH: installer.DEFAULT_CONFIG_PATH,
  registerOpencodePlugin: installer.register,
  unregisterOpencodePlugin: installer.unregister,
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
