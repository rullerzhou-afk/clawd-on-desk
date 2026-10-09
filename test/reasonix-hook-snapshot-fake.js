// Test preloader: replaces the resolver's platform process queries with a
// three-process tree — this hook's real parent pid, parented under Reasonix
// (pid 4000), then a system boundary (pid 5000). Lets PID-attribution tests
// assert stablePid/agentPid on Windows, macOS, and Linux without depending on
// the host's real process list. Unrelated execFileSync calls pass through.
const childProcess = require("child_process");
const fs = require("fs");

const realExecFileSync = childProcess.execFileSync;
const hookParentPid = process.ppid;

const SNAPSHOT = {
  processes: [
    {
      ProcessId: hookParentPid,
      ParentProcessId: 4000,
      Name: "node.exe",
      CommandLine: "node hooks/reasonix-hook.js",
      StartIdentity: "100",
    },
    {
      ProcessId: 4000,
      ParentProcessId: 5000,
      Name: "reasonix.exe",
      CommandLine: "reasonix.exe",
      StartIdentity: "90",
    },
    {
      ProcessId: 5000,
      ParentProcessId: 0,
      Name: "explorer.exe",
      CommandLine: "explorer.exe",
      StartIdentity: "1",
    },
  ],
  foreground: { hwnd: null, pid: 0, className: "" },
};

const POSIX_PROCESSES = new Map([
  [hookParentPid, { ppid: 4000, comm: "node", command: "node hooks/reasonix-hook.js" }],
  [4000, { ppid: 5000, comm: "reasonix", command: "reasonix" }],
  [5000, { ppid: 0, comm: process.platform === "darwin" ? "launchd" : "systemd", command: "system" }],
]);

childProcess.execFileSync = function (file, args, options) {
  const text = [file, ...(Array.isArray(args) ? args : [])].join(" ");
  if (/powershell(\.exe)?/i.test(String(file)) && text.includes("Win32_Process")) {
    const recordPath = process.env.CLAWD_TEST_REASONIX_SNAPSHOT_RECORD;
    if (recordPath) {
      try {
        fs.appendFileSync(recordPath, JSON.stringify({
          timeout: options && options.timeout,
          at: Date.now(),
        }) + "\n");
      } catch {}
    }
    const delayMs = Number(process.env.CLAWD_TEST_REASONIX_SNAPSHOT_DELAY_MS) || 0;
    if (delayMs > 0) {
      // Deliberately synchronous: this reproduces the exact property under
      // review — JS safety timers cannot run while execFileSync/WMI is blocked.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
    return JSON.stringify(SNAPSHOT);
  }
  if (String(file) === "ps" && Array.isArray(args)) {
    const field = args[1];
    const pid = Number(args[3]);
    const processInfo = POSIX_PROCESSES.get(pid);
    if (processInfo && args[0] === "-o" && args[2] === "-p") {
      if (field === "ppid=") return `${processInfo.ppid}\n`;
      if (field === "comm=") return `${processInfo.comm}\n`;
      if (field === "command=") return `${processInfo.command}\n`;
    }
  }
  return realExecFileSync.apply(this, arguments);
};
