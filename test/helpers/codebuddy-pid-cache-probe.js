"use strict";

// Run the shipped CodeBuddy hook and resolver against a synthetic CodeBuddy 5.x
// IDE process tree on Windows. Only the OS snapshot is replaced; cache files,
// liveness checks and lifecycle dispatch are real. The test process (the hook's
// parent) stands in for the long-lived agent-harness.exe and the test's own
// parent for the CodeBuddy main process, so both cached PIDs stay alive between
// spawned hook processes, exactly like a running IDE.
const fs = require("node:fs");
const cp = require("node:child_process");

Object.defineProperty(process, "platform", { value: "win32" });
const HARNESS_NAME = process.env.CLAWD_CB_HARNESS_NAME || "agent-harness.exe";
const MAIN_PID = Number(process.env.CLAWD_CB_MAIN_PID);
cp.execFileSync = (file, args, options) => {
  if (!/powershell/i.test(String(file)) || !args.join(" ").includes("Win32_Process")) {
    throw new Error(`unexpected process query: ${file}`);
  }
  fs.appendFileSync(process.env.CLAWD_CB_SNAPSHOTS, JSON.stringify({ timeout: options.timeout }) + "\n");
  return JSON.stringify({
    processes: [
      { ProcessId: process.pid, ParentProcessId: 7001, Name: "node.exe", CommandLine: "node codebuddy-hook.js", StartIdentity: "1" },
      { ProcessId: 7001, ParentProcessId: 7002, Name: "bash.exe", CommandLine: "bash -c hook", StartIdentity: "2" },
      { ProcessId: 7002, ParentProcessId: process.ppid, Name: "bash.exe", CommandLine: "bash", StartIdentity: "3" },
      { ProcessId: process.ppid, ParentProcessId: MAIN_PID, Name: HARNESS_NAME, CommandLine: "agent-harness.exe --stdio", StartIdentity: "4" },
      { ProcessId: MAIN_PID, ParentProcessId: 7005, Name: "CodeBuddy CN.exe", CommandLine: "CodeBuddy CN.exe", StartIdentity: "5" },
      { ProcessId: 7005, ParentProcessId: 0, Name: "explorer.exe", CommandLine: "explorer.exe", StartIdentity: "6" },
    ],
    foreground: { hwnd: null, pid: 0, className: "" },
  });
};

