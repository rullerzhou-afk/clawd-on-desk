"use strict";

const http = require("node:http");

if (process.argv[2] === "attempt") {
  const request = http.request({
    host: "127.0.0.1",
    port: 23333,
    path: "/state",
    method: "POST",
  });
  request.on("error", () => process.exit(0));
  request.end("{}");
} else {
  process.stdout.write(JSON.stringify({
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    userData: process.env.CLAWD_TEST_USER_DATA,
    appData: process.env.APPDATA,
    codexHome: process.env.CODEX_HOME || null,
    nodeOptions: process.env.NODE_OPTIONS || null,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || null,
    grokHookEvent: process.env.GROK_HOOK_EVENT || null,
    orcaPaneKey: process.env.ORCA_PANE_KEY || null,
  }));
}
