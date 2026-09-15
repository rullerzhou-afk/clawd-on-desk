"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { writeJsonAtomic } = require("./json-utils");
const { getClaudeStopDisposition } = require("./claude-stop-disposition");

const LEASE_VERSION = 1;
const LEASE_DIR_NAME = "session-recovery-v1";
const LEASE_FILE_PREFIX = "session-recovery-v1-";
const MAX_LEASE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_LEASE_FILES = 100;
const MAX_LEASE_BYTES = 16 * 1024;
const TOMBSTONE_RETENTION_MS = 10 * 60 * 1000;
const LOCK_RETRY_COUNT = 40;
const LOCK_RETRY_MS = 5;
const SUSTAINED_STATES = new Set(["thinking", "working", "juggling"]);
const SUPPORTED_AGENT_IDS = new Set(["claude-code"]);
const TOMBSTONE_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "StopFailure",
  "ApiError",
]);
const ALLOWED_RECORD_KEYS = new Set([
  "version",
  "agentId",
  "sessionId",
  "active",
  "state",
  "eventAt",
  "validUntil",
  "pid",
  "sourcePid",
  "processStartIdentity",
  "sourceProcessStartIdentity",
  "cwd",
  "title",
]);

function isPositivePid(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeWindowsStartTicks(value) {
  const raw = String(value || "").trim();
  if (!/^\d+$/.test(raw)) return null;
  try {
    const ticks = BigInt(raw);
    if (ticks <= 0n) return null;
    // Win32_Process.CreationDate, used by the hook writer, has microsecond
    // precision. Get-Process.StartTime can retain the final 100ns digit, so
    // compare both sources at the writer's coarser precision.
    return (ticks - (ticks % 10n)).toString();
  } catch {
    return null;
  }
}

function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id === "default" || id.length > 256) return null;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(id)) return null;
  return id;
}

function normalizeAgentId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : null;
}

function normalizeCwd(value) {
  if (typeof value !== "string") return "";
  const cwd = value.trim();
  if (!cwd || cwd.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(cwd)) return "";
  return cwd;
}

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.length > 80 ? title.slice(0, 80) : title;
}

function getRecoveryDir(options = {}) {
  if (typeof options.recoveryDir === "string" && options.recoveryDir) {
    return path.resolve(options.recoveryDir);
  }
  return path.join(os.homedir(), ".clawd", LEASE_DIR_NAME);
}

function ensureRecoveryDir(options = {}) {
  const dir = getRecoveryDir(options);
  try {
    const parent = path.dirname(dir);
    let parentStat;
    try {
      parentStat = fs.lstatSync(parent);
    } catch (err) {
      if (!err || err.code !== "ENOENT") return null;
      const grandparentStat = fs.lstatSync(path.dirname(parent));
      if (!grandparentStat.isDirectory() || grandparentStat.isSymbolicLink()) return null;
      fs.mkdirSync(parent, { mode: 0o700 });
      parentStat = fs.lstatSync(parent);
    }
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return null;
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (err) { if (!err || err.code !== "EEXIST") return null; }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    try { fs.chmodSync(dir, 0o700); } catch {}
    return dir;
  } catch {
    return null;
  }
}

function leaseHash(agentId, sessionId) {
  return crypto.createHash("sha256").update(`${agentId}\0${sessionId}`).digest("hex").slice(0, 32);
}

function getLeaseFilePath(agentId, sessionId, options = {}) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedAgentId || !normalizedSessionId) return null;
  return path.join(
    getRecoveryDir(options),
    `${LEASE_FILE_PREFIX}${leaseHash(normalizedAgentId, normalizedSessionId)}.json`,
  );
}

function readLeaseFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_LEASE_BYTES) return null;
    const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return validateRecord(record, { filePath });
  } catch {
    return null;
  }
}

function validateRecord(record, options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (Object.keys(record).some((key) => !ALLOWED_RECORD_KEYS.has(key))) return null;
  if (record.version !== LEASE_VERSION) return null;
  const agentId = normalizeAgentId(record.agentId);
  const sessionId = normalizeSessionId(record.sessionId);
  if (!agentId || !SUPPORTED_AGENT_IDS.has(agentId) || !sessionId || agentId !== record.agentId || sessionId !== record.sessionId) return null;
  if (typeof record.active !== "boolean") return null;
  const state = record.state === null ? null : record.state;
  if (record.active ? !SUSTAINED_STATES.has(state) : state !== null) return null;
  if (!Number.isFinite(record.eventAt) || record.eventAt <= 0) return null;
  const validUntil = record.validUntil === null ? null : record.validUntil;
  if (validUntil !== null && (!record.active || !Number.isFinite(validUntil) || validUntil <= record.eventAt)) return null;
  const pid = record.pid === null ? null : record.pid;
  const sourcePid = record.sourcePid === null ? null : record.sourcePid;
  if (pid !== null && !isPositivePid(pid)) return null;
  if (sourcePid !== null && !isPositivePid(sourcePid)) return null;
  if (record.active && !pid && !sourcePid) return null;
  for (const key of ["processStartIdentity", "sourceProcessStartIdentity"]) {
    if (record[key] !== null && (typeof record[key] !== "string" || !record[key] || record[key].length > 160)) {
      return null;
    }
  }
  const cwd = normalizeCwd(record.cwd);
  if (cwd !== record.cwd) return null;
  const title = record.title === null ? null : normalizeTitle(record.title);
  if (title !== record.title) return null;
  if (options.filePath) {
    const expected = getLeaseFilePath(agentId, sessionId, { recoveryDir: path.dirname(options.filePath) });
    if (!expected || path.basename(expected) !== path.basename(options.filePath)) return null;
  }
  return {
    version: LEASE_VERSION,
    agentId,
    sessionId,
    active: record.active,
    state,
    eventAt: record.eventAt,
    validUntil,
    pid,
    sourcePid,
    processStartIdentity: record.processStartIdentity,
    sourceProcessStartIdentity: record.sourceProcessStartIdentity,
    cwd,
    title,
  };
}

function sleepSync(ms) {
  try {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, ms);
  } catch {}
}

function acquireLeaseLock(filePath, options = {}) {
  const lockPath = `${filePath}.lock`;
  const ownerPath = path.join(lockPath, "owner");
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const retryCount = options.nonBlocking === true ? 1 : LOCK_RETRY_COUNT;
  for (let attempt = 0; attempt < retryCount; attempt++) {
    const pendingPath = `${lockPath}.pending-${token}-${attempt}`;
    const pendingOwnerPath = path.join(pendingPath, "owner");
    try {
      fs.mkdirSync(pendingPath, { mode: 0o700 });
      fs.writeFileSync(pendingOwnerPath, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
      // Publish the complete lock directory atomically. A visible formal lock
      // therefore always has a complete owner record.
      fs.renameSync(pendingPath, lockPath);
      return { lockPath, ownerPath, token };
    } catch (err) {
      try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch {}
      if (!err || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(err.code)) return null;
      if (attempt + 1 < retryCount) sleepSync(LOCK_RETRY_MS);
    }
  }
  return null;
}

function releaseLeaseLock(lock) {
  if (!lock) return;
  try {
    if (fs.readFileSync(lock.ownerPath, "utf8") !== lock.token) return;
    fs.unlinkSync(lock.ownerPath);
    fs.rmdirSync(lock.lockPath);
  } catch {}
}

function quarantineAndRemoveLock(lockPath) {
  const quarantine = `${lockPath}.orphan-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(lockPath, quarantine);
    fs.rmSync(quarantine, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function getWindowsProcessStartIdentities(pids, options = {}) {
  const ids = [...new Set(pids.filter(isPositivePid))];
  if (!ids.length) return new Map();
  const run = typeof options.execFileSync === "function" ? options.execFileSync : execFileSync;
  const script = [
    `$ids = @(${ids.join(",")})`,
    "$rows = @($ids | ForEach-Object {",
    "  $proc = Get-Process -Id $_ -ErrorAction SilentlyContinue",
    "  if ($null -ne $proc) { [pscustomobject]@{ pid = [int]$proc.Id; start = $proc.StartTime.ToUniversalTime().Ticks.ToString() } }",
    "})",
    "$rows | ConvertTo-Json -Compress",
  ].join("\n");
  try {
    const raw = String(run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script,
    ], { encoding: "utf8", timeout: 3000, windowsHide: true }) || "").trim();
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const identities = new Map();
    for (const row of rows) {
      const pid = Number(row && (row.pid ?? row.Pid));
      const start = normalizeWindowsStartTicks(row && (row.start ?? row.Start));
      if (isPositivePid(pid) && start) identities.set(pid, `win32:${start}`);
    }
    return identities;
  } catch {
    return new Map();
  }
}

function getProcessStartIdentities(pids, options = {}) {
  if (typeof options.getProcessStartIdentities === "function") {
    const result = options.getProcessStartIdentities(pids);
    return result instanceof Map ? result : new Map();
  }
  const platform = options.platform || process.platform;
  if (platform === "win32") return getWindowsProcessStartIdentities(pids, options);
  const identities = new Map();
  for (const pid of pids) {
    const identity = getProcessStartIdentity(pid, options);
    if (identity) identities.set(pid, identity);
  }
  return identities;
}

function getProcessStartIdentity(pid, options = {}) {
  if (!isPositivePid(pid)) return null;
  const platform = options.platform || process.platform;
  try {
    if (platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      if (close < 0) return null;
      const fields = raw.slice(close + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : null;
    }
    if (platform === "darwin") {
      const run = typeof options.execFileSync === "function" ? options.execFileSync : execFileSync;
      const value = String(run("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1000,
        windowsHide: true,
      }) || "").trim();
      return value ? `darwin:${value}` : null;
    }
    if (platform === "win32") return getWindowsProcessStartIdentities([pid], options).get(pid) || null;
  } catch {}
  return null;
}

function pruneRecoveryLeaseFiles(dir, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const skipFilePath = typeof options.skipFilePath === "string"
    ? path.resolve(options.skipFilePath)
    : null;
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith(LEASE_FILE_PREFIX) && name.endsWith(".json"));
  } catch {
    return [];
  }
  const entries = names.map((name) => {
    const filePath = path.join(dir, name);
    return { name, filePath, record: readLeaseFile(filePath) };
  });

  function deleteInactiveIf(entry, predicate) {
    if (skipFilePath && path.resolve(entry.filePath) === skipFilePath) return false;
    const lock = acquireLeaseLock(entry.filePath);
    if (!lock) return false;
    try {
      const current = readLeaseFile(entry.filePath);
      if (!current || current.active || !predicate(current)) return false;
      fs.unlinkSync(entry.filePath);
      return true;
    } catch {
      return false;
    } finally {
      releaseLeaseLock(lock);
    }
  }

  for (const entry of entries) {
    if (entry.record && !entry.record.active && now - entry.record.eventAt > TOMBSTONE_RETENTION_MS) {
      entry.deleted = deleteInactiveIf(
        entry,
        (current) => now - current.eventAt > TOMBSTONE_RETENTION_MS,
      );
    }
  }
  let remaining = entries.filter((entry) => !entry.deleted);
  if (remaining.length > MAX_LEASE_FILES) {
    const removable = remaining
      .filter((entry) => entry.record && !entry.record.active)
      .sort((a, b) => a.record.eventAt - b.record.eventAt);
    for (const entry of removable) {
      if (remaining.length <= MAX_LEASE_FILES) break;
      if (deleteInactiveIf(entry, () => true)) {
        entry.deleted = true;
        remaining = remaining.filter((candidate) => candidate !== entry);
      }
    }
  }
  return remaining.map((entry) => entry.name);
}

function processAlive(pid, options = {}) {
  if (!isPositivePid(pid)) return false;
  const kill = typeof options.processKill === "function" ? options.processKill : process.kill;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === "EPERM");
  }
}

function cleanupOrphanedLeaseLocks(dir, options = {}) {
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".json.lock")
    && (!options.filePrefix || name.startsWith(options.filePrefix))); }
  catch { return; }
  for (const name of names) {
    const lockPath = path.join(dir, name);
    const ownerPath = path.join(lockPath, "owner");
    let token = "";
    try { token = fs.readFileSync(ownerPath, "utf8"); } catch {}
    const match = /^(\d+)-(\d+)-[0-9a-f]+$/.exec(token);
    if (!match) {
      if (options.requireDeadOwner === true) continue;
      // A writer can die after mkdir and before creating owner. Renaming is
      // atomic: a concurrently starting writer simply fails closed for this
      // event, while the next hook can acquire a clean lock.
      quarantineAndRemoveLock(lockPath);
      continue;
    }
    const ownerPid = Number(match[1]);
    if (options.requireDeadOwner === true) {
      if (!isPositivePid(ownerPid)) continue;
      try {
        (options.processKill || process.kill)(ownerPid, 0);
        continue;
      } catch (err) {
        if (!err || err.code !== "ESRCH") continue;
      }
    }
    if (isPositivePid(ownerPid) && processAlive(ownerPid, options)) continue;
    quarantineAndRemoveLock(lockPath);
  }
}

function classifyBody(body, options = {}) {
  if (!body || typeof body !== "object") return null;
  if (body.headless === true) return { active: false, state: null, terminal: false };
  if (body.event === "Stop") {
    const stopOptions = {
      backgroundTasksCount: body.background_tasks_count,
      sessionCronsCount: body.session_crons_count,
      stopHookActive: body.stop_hook_active,
      hasFinalAssistantText: typeof body.assistant_last_output === "string" && !!body.assistant_last_output,
      headless: body.headless,
      env: options.env,
    };
    const baseDisposition = getClaudeStopDisposition(stopOptions);
    const disposition = getClaudeStopDisposition({
      ...stopOptions,
      backgroundSubagentsCount: body.background_subagents_count,
    });
    if (disposition.kind === "complete") return { active: false, state: null, validForMs: 0, terminal: true };
    return {
      active: true,
      state: "working",
      validForMs: disposition.kind === "debounce" ? disposition.debounceMs : 0,
      terminal: false,
      // A typed background-subagent snapshot is live evidence for this process,
      // but a Stop hook must not turn that one observation into an unbounded
      // startup-recovery lease. Preserve a lease written by earlier sustained
      // lifecycle traffic byte-for-byte; create or refresh nothing when the
      // typed count is the only reason this Stop became a hard hold.
      preserveExistingEvidence: disposition.kind === "hold" && baseDisposition.kind !== "hold",
    };
  }
  if (SUSTAINED_STATES.has(body.state)) return { active: true, state: body.state, terminal: false };
  if (TOMBSTONE_EVENTS.has(body.event) || body.state === "idle" || body.state === "sleeping") {
    return { active: false, state: null, terminal: body.event !== "SessionStart" };
  }
  return null;
}

function updateRecoveryLeaseFromStateBody(body, options = {}) {
  if (options.remote === true || process.env.CLAWD_REMOTE || (body && body.wsl_distro)) {
    return { written: false, reason: "remote-filesystem" };
  }
  const agentId = normalizeAgentId(body && body.agent_id);
  const sessionId = normalizeSessionId(body && body.session_id);
  const classified = classifyBody(body, options);
  if (!agentId || !SUPPORTED_AGENT_IDS.has(agentId) || !sessionId || !classified) {
    return { written: false, reason: "unsupported" };
  }
  if (classified.preserveExistingEvidence === true) {
    const filePath = getLeaseFilePath(agentId, sessionId, {
      recoveryDir: getRecoveryDir(options),
    });
    if (!filePath) return { written: false, reason: "path" };
    try {
      if (!fs.existsSync(filePath)) return { written: false, reason: "no-existing-evidence" };
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return { written: false, reason: "unsafe-file" };
      }
    } catch {
      return { written: false, reason: "unsafe-file" };
    }
    const existing = readLeaseFile(filePath);
    if (!existing || !existing.active || !SUSTAINED_STATES.has(existing.state)) {
      return { written: false, reason: "no-active-evidence" };
    }
    return { written: false, reason: "preserved-existing-evidence", filePath, record: existing };
  }
  const dir = ensureRecoveryDir(options);
  const filePath = dir ? getLeaseFilePath(agentId, sessionId, { recoveryDir: dir }) : null;
  if (!filePath) return { written: false, reason: "path" };
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) return { written: false, reason: "unsafe-file" };
    }
  } catch {
    return { written: false, reason: "unsafe-file" };
  }
  const lock = acquireLeaseLock(filePath);
  if (!lock) return { written: false, reason: "locked" };
  try {
    const existing = readLeaseFile(filePath);
    const observedAt = Number.isFinite(options.eventAt) && options.eventAt > 0 ? options.eventAt : Date.now();
    // A half-millisecond terminal rank makes Stop/SessionEnd win ties between
    // async hook processes while still allowing same-tick SessionStart ->
    // UserPromptSubmit to become active.
    const eventAt = observedAt + (classified.terminal ? 0.5 : 0);
    if (existing && existing.eventAt > eventAt) return { written: false, reason: "older-event" };
    const pid = isPositivePid(body.agent_pid)
      ? Math.floor(body.agent_pid)
      : (existing && existing.pid) || null;
    const sourcePid = isPositivePid(body.source_pid)
      ? Math.floor(body.source_pid)
      : (existing && existing.sourcePid) || null;
    if (classified.active && !pid && !sourcePid) return { written: false, reason: "missing-pid" };
    const keptProcessIdentity = (typeof body._agentProcessStartIdentity === "string"
      ? body._agentProcessStartIdentity
      : null) || (pid && existing && existing.pid === pid ? existing.processStartIdentity : null);
    const keptSourceIdentity = (typeof body._sourceProcessStartIdentity === "string"
      ? body._sourceProcessStartIdentity
      : null) || (sourcePid && existing && existing.sourcePid === sourcePid
      ? existing.sourceProcessStartIdentity
      : null);
    const identityPids = [];
    if (pid && !keptProcessIdentity) identityPids.push(pid);
    if (sourcePid && !keptSourceIdentity) identityPids.push(sourcePid);
    const platform = options.platform || process.platform;
    // Windows hook adapters already took one process snapshot. Their private,
    // non-wire identity fields above are the only writer source; never spawn a
    // second PowerShell here, preserving the online=1/offline=0 contract.
    const canQueryIdentities = platform !== "win32"
      || typeof options.getProcessStartIdentities === "function";
    const identities = canQueryIdentities
      ? getProcessStartIdentities(identityPids, options)
      : new Map();
    const processStartIdentity = keptProcessIdentity || identities.get(pid) || null;
    const sourceProcessStartIdentity = keptSourceIdentity || identities.get(sourcePid) || null;
    if (classified.active && (
      (pid && !processStartIdentity) || (sourcePid && !sourceProcessStartIdentity)
    )) {
      return { written: false, reason: "missing-start-identity" };
    }
    const record = {
      version: LEASE_VERSION,
      agentId,
      sessionId,
      active: classified.active,
      state: classified.state,
      eventAt,
      validUntil: classified.validForMs > 0 ? eventAt + classified.validForMs : null,
      pid,
      sourcePid,
      processStartIdentity: processStartIdentity || null,
      sourceProcessStartIdentity: sourceProcessStartIdentity || null,
      cwd: normalizeCwd(body.cwd) || (existing && existing.cwd) || "",
      title: body._sessionTitleFromPrompt === true
        ? (existing && existing.title) || null
        : normalizeTitle(body.session_title) || (existing && existing.title) || null,
    };
    writeJsonAtomic(filePath, record);
    try { fs.chmodSync(filePath, 0o600); } catch {}
    // Do not ask the directory pruner to reacquire this record's lock.
    // Every deletion path locks and re-reads, so pruning after release remains
    // safe if another hook updates the record concurrently.
    releaseLeaseLock(lock);
    pruneRecoveryLeaseFiles(dir, { now: eventAt, skipFilePath: filePath });
    return { written: true, filePath, record };
  } catch {
    return { written: false, reason: "write-failed" };
  } finally {
    releaseLeaseLock(lock);
  }
}

function loadActiveRecoveryLeases(options = {}) {
  const dir = getRecoveryDir(options);
  try {
    const parentStat = fs.lstatSync(path.dirname(dir));
    const dirStat = fs.lstatSync(dir);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return [];
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  cleanupOrphanedLeaseLocks(dir, options);
  const names = pruneRecoveryLeaseFiles(dir, { now: options.now });
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
    ? options.maxAgeMs
    : MAX_LEASE_AGE_MS;
  const isAgentEnabled = typeof options.isAgentEnabled === "function" ? options.isAgentEnabled : () => true;
  const identityPids = [];
  for (const name of names) {
    const record = readLeaseFile(path.join(dir, name));
    if (record && record.active) identityPids.push(record.pid, record.sourcePid);
  }
  const currentIdentities = getProcessStartIdentities(identityPids, options);
  const requireStartIdentity = options.requireStartIdentity !== false;
  const leases = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    const record = readLeaseFile(filePath);
    if (!record || !record.active || !SUSTAINED_STATES.has(record.state)) continue;
    if (record.eventAt > now + 60_000) continue;
    if (now - record.eventAt > maxAgeMs) {
      const lock = acquireLeaseLock(filePath);
      try {
        const current = lock ? readLeaseFile(filePath) : null;
        if (current && current.active && now - current.eventAt > maxAgeMs) fs.unlinkSync(filePath);
      } catch {} finally { releaseLeaseLock(lock); }
      continue;
    }
    // A quiet-window Stop is provisional rather than durable evidence. The
    // short-lived hook cannot later promote it safely after a restart, so the
    // loader fails closed instead of restoring a row that could outlive the
    // original completion debounce.
    if (record.validUntil !== null) {
      if (record.validUntil <= now) {
        const lock = acquireLeaseLock(filePath);
        try {
          const current = lock ? readLeaseFile(filePath) : null;
          if (current && current.active && current.validUntil !== null && current.validUntil <= now) {
            fs.unlinkSync(filePath);
          }
        } catch {} finally { releaseLeaseLock(lock); }
      }
      continue;
    }
    if (!isAgentEnabled(record.agentId)) continue;
    if ((record.pid && !processAlive(record.pid, options))
      || (record.sourcePid && !processAlive(record.sourcePid, options))) {
      const lock = acquireLeaseLock(filePath);
      try {
        const current = lock ? readLeaseFile(filePath) : null;
        if (current && current.active && (
          (current.pid && !processAlive(current.pid, options))
          || (current.sourcePid && !processAlive(current.sourcePid, options))
        )) fs.unlinkSync(filePath);
      } catch {} finally { releaseLeaseLock(lock); }
      continue;
    }
    if (requireStartIdentity && (
      (record.pid && !record.processStartIdentity)
      || (record.sourcePid && !record.sourceProcessStartIdentity)
    )) continue;
    if (record.processStartIdentity) {
      const current = currentIdentities.get(record.pid);
      if (!current || current !== record.processStartIdentity) continue;
    }
    if (record.sourceProcessStartIdentity) {
      const current = currentIdentities.get(record.sourcePid);
      if (!current || current !== record.sourceProcessStartIdentity) continue;
    }
    leases.push(record);
  }
  if (leases.length > MAX_LEASE_FILES) return [];
  return leases.sort((a, b) => b.eventAt - a.eventAt);
}

module.exports = {
  LEASE_VERSION,
  // Exported so hooks/session-history.js can reuse this arbiter instead of
  // deciding "is this session still running" a second, divergent way.
  classifyStateBodyForRecovery: classifyBody,
  LEASE_FILE_PREFIX,
  MAX_LEASE_AGE_MS,
  MAX_LEASE_FILES,
  TOMBSTONE_RETENTION_MS,
  SUSTAINED_STATES,
  SUPPORTED_AGENT_IDS,
  getRecoveryDir,
  getLeaseFilePath,
  getProcessStartIdentity,
  getProcessStartIdentities,
  readLeaseFile,
  validateRecord,
  updateRecoveryLeaseFromStateBody,
  pruneRecoveryLeaseFiles,
  cleanupOrphanedLeaseLocks,
  acquireLeaseLock,
  releaseLeaseLock,
  loadActiveRecoveryLeases,
};
