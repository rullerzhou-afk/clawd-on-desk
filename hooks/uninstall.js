#!/usr/bin/env node

const { unregisterHooks, unregisterClaudeStatusline } = require("./install.js");

function main() {
  const { removed, changed } = unregisterHooks();
  unregisterClaudeStatusline();
  console.log("Clawd Claude hooks uninstall complete");
  console.log(`  Removed: ${removed}`);
  console.log(`  Changed: ${changed}`);
  return { removed, changed };
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
