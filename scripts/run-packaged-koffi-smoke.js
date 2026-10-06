#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getReleaseTarget } = require("../src/native-package-target");

function parseArgs(argv) {
  const options = { executable: "", targetId: "", output: "", timeoutMs: 60000, useXvfb: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--executable") options.executable = argv[++index] || "";
    else if (arg === "--target") options.targetId = argv[++index] || "";
    else if (arg === "--output") options.output = argv[++index] || "";
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--xvfb") options.useXvfb = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.executable) throw new Error("--executable is required");
  if (!options.targetId) throw new Error("--target is required");
  if (!options.output) throw new Error("--output is required");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error("--timeout-ms must be >= 1000");
  getReleaseTarget(options.targetId);
  options.executable = path.resolve(options.executable);
  options.output = path.resolve(options.output);
  return options;
}

function cleanupSmokeUserData(outputPath, report) {
  const candidate = report && report.runtime && report.runtime.userDataPath;
  if (!candidate) return { cleaned: false, reason: "not-reported" };
  const resolvedOutputParent = path.dirname(path.resolve(outputPath));
  const resolvedCandidate = path.resolve(candidate);
  if (path.dirname(resolvedCandidate) !== resolvedOutputParent ||
      !/^\.koffi-smoke-user-data-\d+$/.test(path.basename(resolvedCandidate))) {
    throw new Error(`Refusing unsafe smoke user-data cleanup path: ${resolvedCandidate}`);
  }
  if (!fs.existsSync(resolvedCandidate)) return { cleaned: false, reason: "already-absent" };
  const stat = fs.lstatSync(resolvedCandidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing non-directory smoke user-data cleanup path: ${resolvedCandidate}`);
  }
  fs.rmSync(resolvedCandidate, { recursive: true, force: false });
  return { cleaned: true, reason: "removed" };
}

function runPackagedSmoke(options) {
  if (!fs.existsSync(options.executable) || !fs.statSync(options.executable).isFile()) {
    throw new Error(`Packaged executable does not exist: ${options.executable}`);
  }
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.rmSync(options.output, { force: true });
  const appArgs = [
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-software-rasterizer",
    "--clawd-package-smoke",
    `--clawd-package-smoke-target=${options.targetId}`,
    `--clawd-package-smoke-output=${options.output}`,
  ];
  const command = options.useXvfb ? "xvfb-run" : options.executable;
  const args = options.useXvfb ? ["-a", options.executable, ...appArgs] : appArgs;
  const result = spawnSync(command, args, {
    cwd: path.dirname(options.executable),
    stdio: "inherit",
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const report = fs.existsSync(options.output)
    ? JSON.parse(fs.readFileSync(options.output, "utf8"))
    : null;
  if (report) {
    try {
      report.userDataCleanup = cleanupSmokeUserData(options.output, report);
      fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch (err) {
      process.stderr.write(`Packaged smoke user-data cleanup warning: ${err.message}\n`);
    }
  }
  if (result.status !== 0) {
    const detail = report && report.error ? `: ${report.error}` : "";
    throw new Error(`Packaged smoke exited with status ${result.status}${detail}`);
  }
  if (!report) throw new Error(`Packaged smoke did not write: ${options.output}`);
  if (report.ok !== true || report.target !== options.targetId) {
    throw new Error(`Packaged smoke report failed: ${JSON.stringify(report)}`);
  }
  return report;
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = runPackagedSmoke(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runCli();
  } catch (err) {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, cleanupSmokeUserData, runPackagedSmoke, runCli };
