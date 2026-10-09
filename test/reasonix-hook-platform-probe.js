// Test preloader: runs reasonix-hook.js under a synthetic platform and records
// every synchronous child-process attempt. Blocking Reasonix events must not
// reach the POSIX ps/tmux resolver path at all.
const childProcess = require("child_process");
const fs = require("fs");

const platform = String(process.env.CLAWD_TEST_PLATFORM || "").trim();
if (platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
}

const spawns = [];
childProcess.execFileSync = function (file, args) {
  spawns.push({ file: String(file), args: Array.isArray(args) ? args.map(String) : [] });
  throw Object.assign(new Error("unexpected synchronous resolver spawn"), { code: "ETESTSPAWN" });
};

process.on("exit", () => {
  const out = process.env.CLAWD_TEST_SYNC_SPAWN_RECORD;
  if (!out) return;
  try { fs.writeFileSync(out, JSON.stringify(spawns), "utf8"); } catch {}
});
