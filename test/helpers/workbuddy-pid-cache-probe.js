"use strict";

// Run the shipped hook and resolver against a synthetic Windows process tree.
// Only the OS snapshot is replaced; cache files, liveness checks and lifecycle
// dispatch are real. The test's parent is the live, long-lived WorkBuddy main.
const fs = require("node:fs");
const cp = require("node:child_process");

Object.defineProperty(process, "platform", { value: "win32" });
cp.execFileSync = (file, args, options) => {
  if (!/powershell/i.test(String(file)) || !args.join(" ").includes("Win32_Process")) {
    throw new Error(`unexpected process query: ${file}`);
  }
  fs.appendFileSync(process.env.CLAWD_WB_SNAPSHOTS, JSON.stringify({ timeout: options.timeout }) + "\n");
  return JSON.stringify({
    processes: [{
      ProcessId: process.ppid,
      ParentProcessId: 0,
      Name: "WorkBuddy.exe",
      CommandLine: '"C:/Program Files/WorkBuddy/WorkBuddy.exe"',
      StartIdentity: "100",
    }],
    foreground: { hwnd: null, pid: 0, className: "" },
  });
};
