#!/usr/bin/env node
"use strict";

// One-shot executor for administrators' Windows SSH sessions.
//
// An elevated SSH token cannot reliably traverse junctions created by the
// logged-on, non-elevated desktop session. The only supported path is a
// limited (Medium) scheduled task that runs inside that desktop session. This
// script is the task's fixed entry point. It consumes a single-use operation
// token, re-checks the environment it was started in, runs one installer, and
// publishes one structured result file that the SSH-side caller can validate.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const LEASE_FILE = "lease.json";
const RESULT_FILE = "result.json";
const PENDING_SUFFIX = ".pending";
const CONSUMED_SUFFIX = ".consumed";
const TASK_SCHEMA_VERSION = 1;
const START_DEADLINE_MS = 60000;

// Integrity levels are identified by their mandatory-label SID, not by the
// localized display name, so this works on non-English Windows installs.
const INTEGRITY_SIDS = Object.freeze({
  "S-1-16-4096": "low",
  "S-1-16-8192": "medium",
  "S-1-16-12288": "high",
  "S-1-16-16384": "system",
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseIntegrityLevel(whoamiGroupsOutput) {
  const text = String(whoamiGroupsOutput || "");
  const match = text.match(/S-1-16-(4096|8192|12288|16384)/i);
  return match ? (INTEGRITY_SIDS[`S-1-16-${match[1]}`] || null) : null;
}

function parseUserSid(whoamiUserOutput) {
  const text = String(whoamiUserOutput || "");
  const match = text.match(/\b(S-1-\d+(?:-\d+)+)\b/);
  return match ? match[1] : null;
}

function runWhoami(deps, args) {
  const spawn = deps.spawnSync || spawnSync;
  const result = spawn("whoami", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: deps.whoamiTimeoutMs || 10000,
    ...(deps.env ? { env: deps.env } : {}),
  });
  if (!result || result.error || result.signal || result.status !== 0) return null;
  return String(result.stdout || "");
}

function currentUserSid(deps = {}) {
  if (typeof deps.currentUserSid === "function") return deps.currentUserSid();
  if (typeof deps.currentUserSid === "string") return deps.currentUserSid;
  return parseUserSid(runWhoami(deps, ["/user", "/fo", "csv", "/nh"]));
}

function currentIntegrityLevel(deps = {}) {
  if (typeof deps.currentIntegrity === "function") return deps.currentIntegrity();
  if (typeof deps.currentIntegrity === "string") return deps.currentIntegrity;
  return parseIntegrityLevel(runWhoami(deps, ["/groups", "/fo", "csv", "/nh"]));
}

function validateLease(lease) {
  if (!isPlainObject(lease) || lease.schemaVersion !== TASK_SCHEMA_VERSION) return false;
  if (typeof lease.operationId !== "string" || !/^[a-f0-9]{32,64}$/.test(lease.operationId)) return false;
  if (typeof lease.taskName !== "string" || !lease.taskName) return false;
  if (typeof lease.leaseId !== "string" || !/^[a-f0-9]{32}$/.test(lease.leaseId)) return false;
  if (!Number.isFinite(lease.createdAt) || lease.createdAt <= 0) return false;
  if (!Number.isFinite(lease.startDeadline) || lease.startDeadline <= lease.createdAt) return false;
  if (typeof lease.expectedUserSid !== "string" || !lease.expectedUserSid) return false;
  if (typeof lease.dshHome !== "string" || !lease.dshHome) return false;
  if (typeof lease.installScript !== "string" || !path.isAbsolute(lease.installScript)) return false;
  if (!Array.isArray(lease.installArgv) || lease.installArgv.some((value) => typeof value !== "string")) return false;
  if (!isPlainObject(lease.installEnv)
    || Object.entries(lease.installEnv).some(([key, value]) => typeof key !== "string" || typeof value !== "string")) {
    return false;
  }
  if (!Number.isInteger(lease.installerTimeoutMs) || lease.installerTimeoutMs <= 0) return false;
  return true;
}

function readLease(leaseDir) {
  try {
    const raw = fs.readFileSync(path.join(leaseDir, LEASE_FILE), "utf8");
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(temp, filePath);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch {}
    throw err;
  }
}

// Consume the one-shot token before any other work. A stale or replayed task
// (for example an operator running the task definition twice) cannot reach the
// installer because the pending file is already gone.
function consumeOperation(leaseDir, operationId) {
  const pending = path.join(leaseDir, `${operationId}${PENDING_SUFFIX}`);
  const consumed = path.join(leaseDir, `${operationId}${CONSUMED_SUFFIX}`);
  try {
    fs.renameSync(pending, consumed);
    return null;
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "EEXIST")) return "operation-already-consumed";
    return "operation-token-unreadable";
  }
}

function writeResult(leaseDir, result) {
  const filePath = path.join(leaseDir, RESULT_FILE);
  atomicWriteJson(filePath, result);
  return filePath;
}

// Exported with injectable dependencies so every refusal branch (and the
// result-file contract) is covered by ordinary unit tests on any host.
function runRemoteTask(argv, deps = {}) {
  const leaseDir = argv[0];
  const operationId = argv[1];
  const now = deps.now || (() => Date.now());
  const base = {
    schemaVersion: TASK_SCHEMA_VERSION,
    action: "installer",
    operationId: typeof operationId === "string" ? operationId : null,
    taskName: null,
    leaseId: null,
    installerExitCode: null,
    installerResult: null,
    finishedAt: new Date(now()).toISOString(),
  };

  let leaseValid = false;
  let leaseIdentity = null;
  function refuse(reason, extra = {}) {
    const value = { ...base, ...(leaseIdentity || {}), ...extra, status: "refused", reason };
    if (leaseValid) {
      try { writeResult(leaseDir, value); } catch {}
    }
    return value;
  }

  if (typeof leaseDir !== "string" || !path.isAbsolute(leaseDir)
    || typeof operationId !== "string" || !operationId) {
    return refuse("task_arguments_invalid");
  }
  const lease = readLease(leaseDir);
  if (!lease || !validateLease(lease)) {
    // Without a valid lease there is no task identity to bind the result to.
    return refuse("lease-invalid");
  }
  leaseValid = true;
  leaseIdentity = {
    taskName: lease.taskName,
    leaseId: lease.leaseId,
    operationId: lease.operationId,
    finishedAt: base.finishedAt,
  };
  if (lease.operationId !== operationId) return refuse("operation-id-mismatch");

  const tokenError = consumeOperation(leaseDir, operationId);
  if (tokenError) return refuse(tokenError);

  if (now() > lease.startDeadline) return refuse("operation-expired");

  const sid = currentUserSid(deps);
  if (!sid) return refuse("user_sid_unverifiable");
  if (sid !== lease.expectedUserSid) return refuse("user_sid_mismatch");

  const integrity = currentIntegrityLevel(deps);
  if (!integrity) return refuse("integrity_unverifiable");
  if (integrity !== "medium") return refuse("integrity_not_medium", { integrity });

  // Check the environment the task itself was started with. The lease's
  // installEnv is applied to the installer below and cannot prove anything
  // about the host session on its own.
  const taskEnv = deps.env || process.env;
  if (taskEnv.DSH_HOME !== undefined && taskEnv.DSH_HOME !== lease.dshHome) {
    return refuse("dsh_home_mismatch");
  }
  const env = { ...taskEnv, ...lease.installEnv };

  // Load the sentinel parser before doing any work: a load failure after the
  // installer ran would leave side effects without a result file.
  const { parseDshInstallerResult } = require("./dsh-install");
  const spawn = deps.spawnSync || spawnSync;
  const nodePath = deps.execPath || process.execPath;
  const installer = spawn(nodePath, [lease.installScript, ...lease.installArgv], {
    env,
    cwd: deps.cwd || path.dirname(lease.installScript),
    windowsHide: true,
    encoding: "utf8",
    timeout: lease.installerTimeoutMs,
  });
  const stdout = String((installer && installer.stdout) || "");
  const stderr = String((installer && installer.stderr) || (installer && installer.error && installer.error.message) || "");
  const launchError = installer && installer.error && installer.error.code !== "ETIMEDOUT"
    ? installer.error
    : null;
  const installerUnknown = !installer
    || Boolean(installer.signal)
    || Boolean(installer.error && installer.error.code === "ETIMEDOUT");
  const parsed = installerUnknown || launchError ? { ok: false } : parseDshInstallerResult(stdout);
  const result = {
    ...base,
    ...leaseIdentity,
    status: launchError ? "refused" : (installerUnknown ? "unknown" : "completed"),
    reason: launchError ? "installer_failed_to_start" : (installerUnknown ? "installer_result_unknown" : null),
    installerExitCode: installer && Number.isInteger(installer.status) ? installer.status : null,
    installerSignal: installer && installer.signal ? installer.signal : null,
    installerResult: parsed.ok ? parsed.result : null,
    installerResultError: parsed.ok ? null : (parsed.error || null),
    installerStdoutTail: stdout.slice(-2000),
    installerStderrTail: stderr.slice(-2000),
  };
  writeResult(leaseDir, result);
  return result;
}

if (require.main === module) {
  try {
    const result = runRemoteTask(process.argv.slice(2));
    process.exitCode = result && result.status === "unknown" ? 1 : 0;
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  LEASE_FILE,
  RESULT_FILE,
  PENDING_SUFFIX,
  CONSUMED_SUFFIX,
  START_DEADLINE_MS,
  TASK_SCHEMA_VERSION,
  parseIntegrityLevel,
  parseUserSid,
  currentUserSid,
  currentIntegrityLevel,
  validateLease,
  consumeOperation,
  runRemoteTask,
};
