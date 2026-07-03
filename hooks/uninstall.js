#!/usr/bin/env node

const { unregisterHooks, unregisterClaudeStatusline } = require("./install.js");

try {
  const { removed, changed } = unregisterHooks();
  unregisterClaudeStatusline();
  console.log("Clawd Claude hooks uninstall complete");
  console.log(`  Removed: ${removed}`);
  console.log(`  Changed: ${changed}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
