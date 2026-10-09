"use strict";

const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");
const { createCanonicalRecapEvent } = require("./recap-event");
const { getMetricSupport } = require("./recap-metrics");
const {
  addLocalDays,
  compareLocalDates,
  freezeLocalTime,
  getSystemTimeZone,
  isValidTimeZone,
  parseLocalDate,
} = require("./recap-time");
const { EVENT_RETENTION_DAYS } = require("./recap-store");

const MAX_PERSISTED_RECORD_BYTES = 2048;
// Bounds on one startup reconciliation. The async reader hands each accepted
// record to its caller instead of collecting them, so these cap the read and
// compute work and the size of the dedupe key tables. The record cap is the
// only guard against floods of blank or corrupt lines, which are short enough
// to fit many more under the byte cap.
const MAX_RETAINED_RESTORE_BYTES = 256 * 1024 * 1024;
const MAX_RETAINED_RESTORE_RECORDS = 1000000;
const RESTORE_READ_CHUNK_BYTES = 64 * 1024;
const HASH_PATTERN = /^hmac:[A-Za-z0-9_-]{40,64}$/;

function validHash(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function normalizeSupport(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || typeof value.sessionsStarted !== "boolean"
    || typeof value.turnsCompleted !== "boolean"
    || typeof value.toolCalls !== "boolean"
  ) return null;
  return {
    sessionsStarted: value.sessionsStarted,
    turnsCompleted: value.turnsCompleted,
    toolCalls: value.toolCalls,
  };
}

function normalizePersistedRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let canonical;
  try {
    canonical = createCanonicalRecapEvent(value);
    parseLocalDate(value.localDate);
  } catch {
    return null;
  }
  if (
    !isValidTimeZone(value.timeZoneId)
    || !Number.isInteger(value.utcOffsetMinutes)
    || value.utcOffsetMinutes < -24 * 60
    || value.utcOffsetMinutes > 24 * 60
    || !Number.isInteger(value.localHour)
    || value.localHour < 0
    || value.localHour > 23
    || !validHash(value.scopeKeyHash)
    || (value.sessionKeyHash !== undefined && !validHash(value.sessionKeyHash))
    || (value.dedupeKeyHash !== undefined && !validHash(value.dedupeKeyHash))
    || (value.sessionStartPartial !== undefined && typeof value.sessionStartPartial !== "boolean")
  ) return null;

  const frozen = freezeLocalTime(canonical.occurredAt, value.timeZoneId);
  const support = normalizeSupport(value.support);
  if (
    frozen.localDate !== value.localDate
    || frozen.localHour !== value.localHour
    || frozen.utcOffsetMinutes !== value.utcOffsetMinutes
    || !support
  ) return null;

  const record = {
    schemaVersion: 1,
    occurredAt: canonical.occurredAt,
    timeZoneId: value.timeZoneId,
    utcOffsetMinutes: value.utcOffsetMinutes,
    localDate: value.localDate,
    localHour: value.localHour,
    agentId: canonical.agentId,
    scope: canonical.scope,
    scopeKeyHash: value.scopeKeyHash,
    metrics: [...canonical.metrics],
    support,
  };
  if (value.sessionKeyHash) record.sessionKeyHash = value.sessionKeyHash;
  if (value.dedupeKeyHash) record.dedupeKeyHash = value.dedupeKeyHash;
  if (value.sessionStartPartial === true) record.sessionStartPartial = true;
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_PERSISTED_RECORD_BYTES) return null;
  return record;
}

function createRecapJournal(options = {}) {
  if (!options.store) throw new Error("createRecapJournal requires store");
  const store = options.store;
  const now = options.now || Date.now;
  const getTimeZone = options.getTimeZone || getSystemTimeZone;
  const logWarn = options.logWarn || console.warn;
  // Keep only the same rolling window as the files themselves. A process can
  // run for months, so a process-lifetime Set would leak memory and reject a
  // legitimately reused upstream id long after its journal record expired.
  const seenDedupe = new Map();
  let memoryGeneration = 0;

  function rememberDedupe(hash, localDate) {
    if (!hash) return;
    const existingDate = seenDedupe.get(hash);
    if (!existingDate || compareLocalDates(existingDate, localDate) < 0) {
      seenDedupe.set(hash, localDate);
    }
  }

  function warn(message, err) {
    try { logWarn(message, err && err.message ? err.message : err); } catch {}
  }

  function eventPath(localDate) {
    parseLocalDate(localDate);
    return store.childPath("events", `${localDate}.jsonl`);
  }

  function buildRecord(event, identity = {}) {
    const canonical = createCanonicalRecapEvent(event);
    const requestedTimeZone = getTimeZone();
    const timeZoneId = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : "UTC";
    const local = freezeLocalTime(canonical.occurredAt, timeZoneId);
    const scopeId = canonical.scope === "local" ? "local" : identity.scopeId || canonical.scope;
    const scopeKeyHash = store.hmac("scope", canonical.scope, scopeId);
    const record = {
      schemaVersion: 1,
      occurredAt: canonical.occurredAt,
      timeZoneId: local.timeZoneId,
      utcOffsetMinutes: local.utcOffsetMinutes,
      localDate: local.localDate,
      localHour: local.localHour,
      agentId: canonical.agentId,
      scope: canonical.scope,
      scopeKeyHash,
      metrics: [...canonical.metrics],
      support: getMetricSupport(canonical.agentId),
    };
    if (identity.sessionId) {
      record.sessionKeyHash = store.hmac(
        "session",
        canonical.agentId,
        canonical.scope,
        scopeId,
        identity.sessionId
      );
    }
    if (identity.dedupeId) {
      record.dedupeKeyHash = store.hmac(
        "dedupe",
        canonical.agentId,
        canonical.scope,
        scopeId,
        identity.sessionId || "",
        identity.dedupeId
      );
    }
    if (identity.sessionStartPartial === true) record.sessionStartPartial = true;
    const normalized = normalizePersistedRecord(record);
    if (!normalized) throw new TypeError("recap record could not be persisted safely");
    return normalized;
  }

  function append(record) {
    const normalized = normalizePersistedRecord(record);
    if (!normalized) throw new TypeError("invalid recap journal record");
    if (normalized.dedupeKeyHash && seenDedupe.has(normalized.dedupeKeyHash)) return false;
    const filePath = eventPath(normalized.localDate);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    let prefix = "";
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) {
        const fd = fs.openSync(filePath, "r");
        try {
          const last = Buffer.alloc(1);
          fs.readSync(fd, last, 0, 1, stat.size - 1);
          if (last[0] !== 0x0a) prefix = "\n";
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    fs.appendFileSync(filePath, `${prefix}${JSON.stringify(normalized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    rememberDedupe(normalized.dedupeKeyHash, normalized.localDate);
    return true;
  }

  function readDate(localDate) {
    let contents;
    try {
      contents = fs.readFileSync(eventPath(localDate), "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return [];
      throw err;
    }
    const records = [];
    const dedupeKeys = new Map();
    let warnedInvalid = false;
    for (const line of contents.split("\n")) {
      const result = normalizeLine(
        line,
        localDate,
        (record) => records.push(record),
        dedupeKeys,
        !warnedInvalid
      );
      if (result === "invalid") warnedInvalid = true;
    }
    return records;
  }

  function normalizeLine(line, localDate, accept, dedupeKeys = null, warnInvalid = true) {
    if (!line.trim()) return "blank";
    if (Buffer.byteLength(line, "utf8") > MAX_PERSISTED_RECORD_BYTES) {
      if (warnInvalid) warn("Clawd: ignored oversized recap journal line");
      return "invalid";
    }
    let parsed;
    try { parsed = JSON.parse(line); } catch {
      if (warnInvalid) warn("Clawd: ignored corrupt recap journal line");
      return "invalid";
    }
    const normalized = normalizePersistedRecord(parsed);
    if (!normalized || normalized.localDate !== localDate) {
      if (warnInvalid) warn("Clawd: ignored invalid recap journal record");
      return "invalid";
    }
    if (normalized.dedupeKeyHash && dedupeKeys) {
      if (dedupeKeys.has(normalized.dedupeKeyHash)) return "duplicate";
      dedupeKeys.set(normalized.dedupeKeyHash, normalized.localDate);
    }
    accept(normalized);
    return "accepted";
  }

  function retainedDates(anchorDate) {
    parseLocalDate(anchorDate);
    return Array.from({ length: EVENT_RETENTION_DAYS }, (_, index) =>
      addLocalDays(anchorDate, -(EVENT_RETENTION_DAYS - 1 - index)));
  }

  function loadRetained(anchorDate = freezeLocalTime(now(), getTimeZone()).localDate) {
    memoryGeneration += 1;
    seenDedupe.clear();
    const records = retainedDates(anchorDate).flatMap(readDate);
    for (const record of records) {
      rememberDedupe(record.dedupeKeyHash, record.localDate);
    }
    return records;
  }

  async function forEachRetainedAsync(anchorDate, onRecord, optionsValue = {}) {
    if (typeof onRecord !== "function") {
      throw new TypeError("forEachRetainedAsync requires an onRecord callback");
    }
    const dates = retainedDates(anchorDate);
    const snapshots = [];
    const generation = ++memoryGeneration;
    let totalBytes = 0;
    const maxBytes = Number.isSafeInteger(optionsValue.maxBytes) && optionsValue.maxBytes >= 0
      ? optionsValue.maxBytes
      : MAX_RETAINED_RESTORE_BYTES;
    const maxRecords = Number.isSafeInteger(optionsValue.maxRecords) && optionsValue.maxRecords >= 0
      ? optionsValue.maxRecords
      : MAX_RETAINED_RESTORE_RECORDS;
    for (const localDate of dates) {
      const filePath = eventPath(localDate);
      try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          const err = new Error("recap journal path must be a regular file");
          err.code = "RECAP_UNSAFE_LINK";
          throw err;
        }
        totalBytes += stat.size;
        snapshots.push({ localDate, filePath, size: stat.size });
      } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
    }

    if (totalBytes > maxBytes) return { dates, truncated: true };

    // Hash -> local date of the first accepted occurrence. Reads run from the
    // earliest date forward, so this is the disk copy a restart keeps. The
    // caller uses it to skip live replays of tickets already projected here.
    const restoredDedupeKeys = new Map();
    const yieldEvery = Number.isSafeInteger(optionsValue.yieldEvery) && optionsValue.yieldEvery > 0
      ? optionsValue.yieldEvery
      : 250;
    const yieldToMain = optionsValue.yieldToMain || (() => new Promise((resolve) => setImmediate(resolve)));
    let processed = 0;
    let warnedInvalid = false;
    for (const snapshot of snapshots) {
      if (snapshot.size <= 0) continue;
      let pending = "";
      let discardingOversizedLine = false;
      let position = 0;
      const decoder = new StringDecoder("utf8");
      while (position < snapshot.size) {
        if (generation !== memoryGeneration) {
          return { dates, truncated: false, aborted: true };
        }
        const requested = Math.min(RESTORE_READ_CHUNK_BYTES, snapshot.size - position);
        const buffer = Buffer.allocUnsafe(requested);
        let bytesRead = 0;
        const fd = fs.openSync(snapshot.filePath, "r");
        try {
          bytesRead = fs.readSync(fd, buffer, 0, requested, position);
        } finally {
          fs.closeSync(fd);
        }
        if (bytesRead <= 0) break;
        position += bytesRead;
        let chunk = decoder.write(buffer.subarray(0, bytesRead));
        if (discardingOversizedLine) {
          const newline = chunk.indexOf("\n");
          if (newline === -1) {
            await yieldToMain();
            if (generation !== memoryGeneration) {
              return { dates, truncated: false, aborted: true };
            }
            continue;
          }
          chunk = chunk.slice(newline + 1);
          discardingOversizedLine = false;
        }
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          processed += 1;
          if (processed > maxRecords) {
            return { dates, truncated: true };
          }
          if (line.trim()) {
            const result = normalizeLine(
              line,
              snapshot.localDate,
              onRecord,
              restoredDedupeKeys,
              !warnedInvalid
            );
            if (result === "invalid") warnedInvalid = true;
          }
          if (processed % yieldEvery === 0) {
            await yieldToMain();
            if (generation !== memoryGeneration) {
              return { dates, truncated: false, aborted: true };
            }
          }
        }
        if (Buffer.byteLength(pending, "utf8") > MAX_PERSISTED_RECORD_BYTES) {
          processed += 1;
          if (processed > maxRecords) return { dates, truncated: true };
          if (!warnedInvalid) warn("Clawd: ignored oversized recap journal line");
          warnedInvalid = true;
          pending = "";
          discardingOversizedLine = true;
        }
        // Handles are always closed before yielding, so Clear can remove the
        // events directory on Windows and resetMemory can abort promptly.
        await yieldToMain();
        if (generation !== memoryGeneration) {
          return { dates, truncated: false, aborted: true };
        }
      }
      pending += decoder.end();
      if (!discardingOversizedLine && pending.trim()) {
        processed += 1;
        if (processed > maxRecords) return { dates, truncated: true };
        const result = normalizeLine(
          pending,
          snapshot.localDate,
          onRecord,
          restoredDedupeKeys,
          !warnedInvalid
        );
        if (result === "invalid") warnedInvalid = true;
      }
      await yieldToMain();
      if (generation !== memoryGeneration) {
        return { dates, truncated: false, aborted: true };
      }
    }
    if (generation === memoryGeneration) {
      for (const [hash, localDate] of restoredDedupeKeys) {
        rememberDedupe(hash, localDate);
      }
    }
    return { dates, truncated: false, restoredDedupeKeys };
  }

  function resetMemory() {
    memoryGeneration += 1;
    seenDedupe.clear();
  }

  function prune(anchorDate = freezeLocalTime(now(), getTimeZone()).localDate) {
    const oldest = addLocalDays(anchorDate, -(EVENT_RETENTION_DAYS - 1));
    const dirPath = store.childPath("events");
    let names = [];
    try { names = fs.readdirSync(dirPath); } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    for (const name of names) {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!match) continue;
      try {
        if (compareLocalDates(match[1], oldest) < 0) fs.unlinkSync(store.childPath("events", name));
      } catch (err) {
        if (!err || err.code !== "ENOENT") warn("Clawd: recap event retention failed", err);
      }
    }
    for (const [hash, localDate] of seenDedupe) {
      if (compareLocalDates(localDate, oldest) < 0) seenDedupe.delete(hash);
    }
  }

  return Object.freeze({
    append,
    buildRecord,
    eventPath,
    forEachRetainedAsync,
    loadRetained,
    prune,
    readDate,
    resetMemory,
    retainedDates,
  });
}

module.exports = {
  MAX_PERSISTED_RECORD_BYTES,
  MAX_RETAINED_RESTORE_BYTES,
  MAX_RETAINED_RESTORE_RECORDS,
  RESTORE_READ_CHUNK_BYTES,
  createRecapJournal,
  normalizePersistedRecord,
};
