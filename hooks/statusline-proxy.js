#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code StatusLine Proxy
// Forwards usage data (rate_limits, cost, context_window) to Clawd server,
// then chains to the user's original statusLine command if configured.
//
// Usage in ~/.claude/settings.json:
//   "statusLine": {
//     "type": "command",
//     "command": "\"node\" \"path/to/statusline-proxy.js\" [original-command]"
//   }

const http = require("http");
const { spawn } = require("child_process");
const { readRuntimePort, DEFAULT_SERVER_PORT } = require("./server-config");

// Read all stdin
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  // Forward usage data to Clawd (fire-and-forget)
  forwardUsage(input);

  // Chain to original statusLine command if specified
  const originalCmd = process.argv[2];
  if (originalCmd) {
    chainOriginal(originalCmd, process.argv.slice(3), input);
  }
});

function forwardUsage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return; // invalid JSON, skip
  }

  // Only forward if there's usage-relevant data
  const payload = {};
  if (data.rate_limits) payload.rate_limits = data.rate_limits;
  if (data.cost) payload.cost = data.cost;
  if (data.model) payload.model = data.model;
  if (data.context_window) payload.context_window = data.context_window;

  if (Object.keys(payload).length === 0) return;

  const body = JSON.stringify(payload);
  const port = readRuntimePort() || DEFAULT_SERVER_PORT;

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/usage",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 200,
    },
    (res) => { res.resume(); } // drain response
  );

  req.on("error", () => {}); // silently ignore connection failures
  req.on("timeout", () => { req.destroy(); });
  req.end(body);
}

function chainOriginal(cmd, args, stdinData) {
  // The original command could be a quoted path or a shell command.
  // Spawn it and pipe the same stdin data.
  const isWin = process.platform === "win32";
  const child = spawn(cmd, args, {
    stdio: ["pipe", "inherit", "inherit"],
    shell: isWin, // use shell on Windows for proper command resolution
    windowsHide: true,
  });

  child.stdin.write(stdinData);
  child.stdin.end();

  child.on("exit", (code) => {
    process.exitCode = code || 0;
  });

  child.on("error", () => {
    // Original command failed — output nothing, let Claude Code show blank statusLine
  });
}
