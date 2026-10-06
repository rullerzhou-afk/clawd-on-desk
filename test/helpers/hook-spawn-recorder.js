"use strict";

// Process-spawn recorder that deliberately knows nothing about HTTP. Keeping
// this preload independent lets adapter tests connect to the fake Clawd HTTP
// responder while still proving that no PowerShell/cmd/other child process was
// created on the authoritative B1a path.

const fs = require("fs");
const cp = require("child_process");

const spawns = [];

function record(_kind, file) {
  // Preserve the historical probe shape (an array of executable/command
  // strings) so the broad #681 contract and the new composable recorder share
  // the same assertions.
  spawns.push(String(file || ""));
}

cp.execFileSync = function recordingExecFileSync(file) {
  record("execFileSync", file);
  throw Object.assign(new Error("spawn recorder blocked execFileSync"), { code: "ECLAWDSPAWNPROBE" });
};

cp.execSync = function recordingExecSync(command) {
  record("execSync", command);
  throw Object.assign(new Error("spawn recorder blocked execSync"), { code: "ECLAWDSPAWNPROBE" });
};

cp.spawnSync = function recordingSpawnSync(file) {
  record("spawnSync", file);
  return { pid: 0, status: 1, signal: null, stdout: null, stderr: null, error: new Error("spawn blocked") };
};

cp.spawn = function recordingSpawn(file) {
  record("spawn", file);
  throw Object.assign(new Error("spawn recorder blocked spawn"), { code: "ECLAWDSPAWNPROBE" });
};

cp.execFile = function recordingExecFile(file, ...args) {
  record("execFile", file);
  const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
  if (callback) process.nextTick(() => callback(new Error("spawn blocked"), "", ""));
  return null;
};

cp.exec = function recordingExec(command, ...args) {
  record("exec", command);
  const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
  if (callback) process.nextTick(() => callback(new Error("spawn blocked"), "", ""));
  return null;
};

process.on("exit", () => {
  const out = process.env.CLAWD_PROBE_OUT;
  if (!out) return;
  try { fs.writeFileSync(out, JSON.stringify(spawns), "utf8"); } catch {}
});
