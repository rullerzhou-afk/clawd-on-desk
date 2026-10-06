"use strict";

// Persistent DSH notices. This module is deliberately standalone: it only reads
// and writes notice files, and the caller passes the managed root and profile.
// Keeping it free of dsh-install.js avoids a require cycle.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const NOTICE_OWNER = "clawd-on-desk";
const NOTICE_SCHEMA_VERSION = 1;
// Lower rank shows first.
const NOTICE_PRIORITY = Object.freeze({
  "restart-required": 0,
  "failed-target": 1,
  "manual-command": 2,
  "first-install": 3,
});
const FAILURE_PATH_KEYS = ["residuePath", "referencePath", "lockPath", "repairPath", "healthReason", "cleanupReason"];

function noticesPath(managedRoot, profile) {
  return path.join(managedRoot, `notices-${profile}.json`);
}

function isValidNoticeFile(parsed) {
  return !!(
    parsed
    && typeof parsed === "object"
    && parsed.owner === NOTICE_OWNER
    && parsed.schemaVersion === NOTICE_SCHEMA_VERSION
    && Array.isArray(parsed.notices)
  );
}

function sortNotices(notices) {
  return notices.slice().sort((left, right) => {
    const rankLeft = NOTICE_PRIORITY[left.kind] === undefined ? 99 : NOTICE_PRIORITY[left.kind];
    const rankRight = NOTICE_PRIORITY[right.kind] === undefined ? 99 : NOTICE_PRIORITY[right.kind];
    if (rankLeft !== rankRight) return rankLeft - rankRight;
    return (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0);
  });
}

function makeNotice(id, kind, profile, bundleHash, payload) {
  return {
    id,
    kind,
    profile,
    ...(bundleHash ? { bundleHash } : {}),
    payload: payload || {},
    createdAt: new Date().toISOString(),
    acknowledged: false,
  };
}

// The identity of a notice within its kind: two outcomes with the same key
// describe the same thing and refresh one record instead of accumulating.
function noticeKey(notice) {
  switch (notice.kind) {
    case "restart-required":
    case "first-install":
      return `hash:${notice.bundleHash || ""}`;
    case "manual-command":
      return `command:${Array.isArray(notice.payload && notice.payload.commands) ? notice.payload.commands.join("\n") : ""}`;
    case "failed-target":
      return `failure:${(notice.payload && notice.payload.operation) || ""}:${(notice.payload && notice.payload.reason) || ""}`;
    default:
      return `id:${notice.id}`;
  }
}

// Enforce one notice per kind. Same key keeps id/createdAt/acknowledged and
// only refreshes payload (+bundleHash); a new key replaces the old record with
// a fresh, unacknowledged one. The key is derived from the record itself so the
// format lives in exactly one place (noticeKey).
function putNotice(notices, { kind, profile, id, bundleHash, payload }) {
  const candidate = makeNotice(id, kind, profile, bundleHash, payload);
  const key = noticeKey(candidate);
  const existing = notices.find((notice) => notice.kind === kind);
  if (existing && noticeKey(existing) === key) {
    existing.payload = payload || {};
    if (bundleHash) existing.bundleHash = bundleHash;
    else delete existing.bundleHash;
    return notices;
  }
  const rest = notices.filter((notice) => notice.kind !== kind);
  return [...rest, candidate];
}

function bundleId(kind, bundleHash) {
  return `${kind}:${bundleHash}`;
}

function putBundleNotice(notices, kind, profile, bundleHash) {
  if (!bundleHash) return notices;
  return putNotice(notices, {
    kind,
    profile,
    id: bundleId(kind, bundleHash),
    bundleHash,
    payload: {},
  });
}

// A manual command is keyed by its content, not by the generation it targets:
// the same generation can be named by an add, a remove and a two-step repair,
// which are different instructions the user must see separately.
function manualCommandKey(commands) {
  return commands.join("\n");
}

function putManualNotice(notices, profile, outcome) {
  const commands = outcome.manualCommands.slice();
  const text = manualCommandKey(commands);
  return putNotice(notices, {
    kind: "manual-command",
    profile,
    id: `manual-command:${crypto.createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
    bundleHash: outcome.manualBundleHash || null,
    payload: { commands },
  });
}

// `{ notices, sequence, error }`. A bad/unreadable file yields an empty list
// plus an error so the caller can report it instead of silently overwriting.
async function readDshNotices(managedRoot, profile, deps = {}) {
  const readFile = deps.readFile || fsp.readFile.bind(fsp);
  const filePath = noticesPath(managedRoot, profile);
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { notices: [], sequence: 0, error: null };
    return { notices: [], sequence: 0, error: `notices-unreadable:${filePath}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return { notices: [], sequence: 0, error: `notices-invalid:${filePath}` };
  }
  if (!isValidNoticeFile(parsed)) {
    return { notices: [], sequence: 0, error: `notices-invalid:${filePath}` };
  }
  return {
    notices: sortNotices(parsed.notices),
    sequence: Number.isInteger(parsed.failedSequence) && parsed.failedSequence >= 0 ? parsed.failedSequence : 0,
    error: null,
  };
}

// Atomic replace: write a sibling temp file then rename. A file we cannot prove
// is ours is never overwritten.
async function writeDshNotices(managedRoot, profile, notices, sequence, deps = {}) {
  const filePath = noticesPath(managedRoot, profile);
  const existing = await readDshNotices(managedRoot, profile, deps);
  if (existing.error) return { notices: existing.notices, error: existing.error };
  const mkdir = deps.mkdir || fsp.mkdir.bind(fsp);
  const writeFile = deps.writeFile || fsp.writeFile.bind(fsp);
  const rename = deps.rename || fsp.rename.bind(fsp);
  const tempPath = `${filePath}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  const body = {
    owner: NOTICE_OWNER,
    schemaVersion: NOTICE_SCHEMA_VERSION,
    notices,
    ...(sequence ? { failedSequence: sequence } : {}),
  };
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (err) {
    try { await fsp.rm(tempPath, { force: true }); } catch {}
    return { notices: existing.notices, error: `notices-write-failed:${filePath}` };
  }
  return { notices: sortNotices(notices), error: null };
}

function failureCategory(operation) {
  // "Uninstall did not finish" and "install is not healthy" are different asks
  // even when the upstream reason code is identical, so the category is part of
  // the key and lets a previously acknowledged install failure reappear.
  return operation === "uninstall" ? "uninstall" : "install";
}

function failurePayload(failure, operation) {
  const payload = {
    operation: failureCategory(operation),
    reason: failure.reason || null,
    targetReason: failure.targetReason || null,
    message: failure.message || null,
  };
  for (const key of FAILURE_PATH_KEYS) {
    if (failure[key] !== undefined && failure[key] !== null) payload[key] = failure[key];
  }
  return payload;
}

function upsertFailedNotice(notices, sequence, profile, outcome) {
  const payload = failurePayload(outcome.failure, outcome.operation);
  const existing = notices.find((notice) => notice.kind === "failed-target");
  // Probe the key through noticeKey so the format is not duplicated here.
  const probe = makeNotice("failed-target:probe", "failed-target", profile, null, payload);
  const same = existing && noticeKey(existing) === noticeKey(probe);
  // Same category and reason: keep the id; otherwise the sequence advances so
  // an acknowledged failure that recurs after a success gets a new id instead
  // of staying silently acknowledged.
  const next = same ? sequence : sequence + 1;
  const id = same ? existing.id : `failed-target:${payload.reason}:${next}`;
  return {
    notices: putNotice(notices, { kind: "failed-target", profile, id, bundleHash: null, payload }),
    sequence: next,
  };
}

function hasManualCommand(outcome) {
  return Array.isArray(outcome.manualCommands) && outcome.manualCommands.length > 0;
}

// Persist only when something actually changed: startup sync walks every
// profile on every launch and must not rewrite identical files. An unchanged
// empty result also means a profile with no notices never gets a file, because
// its read (sequence 0, notices []) compares equal to the computed result.
// `beforeJson` is the serialized read taken before the rules mutate any record.
async function commitDshNotices(managedRoot, profile, notices, sequence, before, deps) {
  const sorted = sortNotices(notices);
  if (sequence === before.sequence && JSON.stringify(sorted) === before.json) {
    return { notices: sorted, error: null };
  }
  return writeDshNotices(managedRoot, profile, sorted, sequence, deps);
}

// outcome: { operation, status?, failure?, notApplicable?, removedOk?,
//   bundleHash?, restartRequired?, firstInstall?, manualCommands?, manualBundleHash? }
async function applyDshNoticeOutcome(managedRoot, profile, outcome = {}, deps = {}) {
  const read = await readDshNotices(managedRoot, profile, deps);
  if (read.error) return { notices: read.notices, error: read.error };
  const before = { sequence: read.sequence || 0, json: JSON.stringify(read.notices) };
  let notices = read.notices;
  let sequence = read.sequence || 0;

  if (outcome.operation === "uninstall") {
    // A confirmed-gone or never-present registration has nothing left to say.
    // The sequence survives so ids are never reused in this profile.
    if (outcome.notApplicable || outcome.removedOk) {
      return commitDshNotices(managedRoot, profile, [], sequence, before, deps);
    }
    // The plugin is still registered. Old manual commands are add commands --
    // the opposite of what the user now wants -- so drop them first.
    notices = notices.filter((notice) => notice.kind !== "manual-command");
    if (outcome.failure) ({ notices, sequence } = upsertFailedNotice(notices, sequence, profile, outcome));
    if (hasManualCommand(outcome)) notices = putManualNotice(notices, profile, outcome);
    return commitDshNotices(managedRoot, profile, notices, sequence, before, deps);
  }

  if (outcome.notApplicable) {
    // A profile Clawd no longer touches has no failing target to report.
    notices = notices.filter((notice) => notice.kind !== "failed-target");
  } else if (outcome.failure) {
    ({ notices, sequence } = upsertFailedNotice(notices, sequence, profile, outcome));
  } else {
    // Success or skip: the previous failure no longer applies.
    notices = notices.filter((notice) => notice.kind !== "failed-target");
    if (outcome.restartRequired) {
      notices = putBundleNotice(notices, "restart-required", profile, outcome.bundleHash);
    }
    if (outcome.firstInstall) {
      notices = putBundleNotice(notices, "first-install", profile, outcome.bundleHash);
    }
  }

  if (hasManualCommand(outcome)) {
    notices = putManualNotice(notices, profile, outcome);
  } else if (profile === "web" && outcome.status === "ok") {
    // The manual anchor converged; stale commands must not linger.
    notices = notices.filter((notice) => notice.kind !== "manual-command");
  }

  return commitDshNotices(managedRoot, profile, notices, sequence, before, deps);
}

async function acknowledgeDshNotice(managedRoot, profile, id, deps = {}) {
  const read = await readDshNotices(managedRoot, profile, deps);
  if (read.error) return { found: false, error: read.error };
  const notice = read.notices.find((entry) => entry.id === id);
  if (!notice) return { found: false, error: null };
  if (notice.acknowledged !== true) {
    notice.acknowledged = true;
    const written = await writeDshNotices(managedRoot, profile, read.notices, read.sequence, deps);
    if (written.error) return { found: true, error: written.error };
  }
  return { found: true, error: null };
}

async function clearDshNotices(managedRoot, profile, deps = {}) {
  const read = await readDshNotices(managedRoot, profile, deps);
  if (read.error) return { error: read.error };
  if (read.notices.length === 0 && !read.sequence) return { error: null };
  // Keep failedSequence: reusing an id after a clear could let an old
  // acknowledgement land on a brand-new record.
  return writeDshNotices(managedRoot, profile, [], read.sequence, deps);
}

module.exports = {
  NOTICE_OWNER,
  NOTICE_SCHEMA_VERSION,
  NOTICE_PRIORITY,
  noticesPath,
  readDshNotices,
  writeDshNotices,
  applyDshNoticeOutcome,
  acknowledgeDshNotice,
  clearDshNotices,
};
