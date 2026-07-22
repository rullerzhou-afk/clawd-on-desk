"use strict";

// IPC for the usage dashboard. `usage:stats` runs an incremental scan of the
// session logs (cheap after the first pass), merges into the keyed record
// store, then returns aggregated totals for several date ranges (today / last 7
// / last 30 / all) so the UI can switch instantly without re-scanning. No proxy.
//
// The scan is fs-heavy and synchronous, so by default it runs in a worker
// thread (usage-worker.js) to keep the Electron main thread responsive. If the
// worker can't be spawned (e.g. an asar packaging edge), it falls back to an
// inline main-thread scan — the previous behavior — so stats never break.

const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const records = require("./usage-records");
const { scanClaudeUsage, scanCodexUsage } = require("./usage-scan");
const { aggregateUsage, aggregateByModel, aggregateByAgent } = require("./usage-aggregate");

function aggregateAll(recs) {
  return { ...aggregateUsage(recs), byModel: aggregateByModel(recs), byAgent: aggregateByAgent(recs) };
}

function startOfTodayEpoch(nowEpoch) {
  const d = new Date(nowEpoch * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function buildRanges(recs, nowEpoch) {
  const from = (start) => recs.filter((r) => Number(r.ts || 0) >= start);
  const DAY = 86400;
  return {
    today: aggregateAll(from(startOfTodayEpoch(nowEpoch))),
    last7: aggregateAll(from(nowEpoch - 7 * DAY)),
    last30: aggregateAll(from(nowEpoch - 30 * DAY)),
    all: aggregateAll(recs),
  };
}

function syncAndAggregate({ fs, homeDir = os.homedir(), now } = {}) {
  const opts = fs ? { fs, homeDir } : { homeDir };
  const recMap = records.loadRecords(opts);
  const syncState = records.loadSyncState(opts);
  const a = scanClaudeUsage({ ...opts, records: recMap, syncState });
  const b = scanCodexUsage({ ...opts, records: a.records, syncState: a.syncState });
  if (a.imported > 0 || b.imported > 0) records.saveRecords(b.records, opts);
  records.saveSyncState(b.syncState, opts);
  const nowEpoch = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  return { ranges: buildRanges(Object.values(b.records), nowEpoch) };
}

// Inline (main-thread) scan — the fallback path and what the worker itself runs.
function runInline(opts) {
  try { return syncAndAggregate(opts); } catch { return { ranges: {} }; }
}

// Run the scan in a worker thread; fall back to an inline scan if the worker
// can't start or dies. Resolves to a { ranges } object and never rejects.
function runOffThread(opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    let worker;
    try {
      worker = new Worker(path.join(__dirname, "usage-worker.js"), {
        workerData: { homeDir: opts.homeDir || os.homedir() },
      });
    } catch {
      finish(runInline(opts));
      return;
    }
    worker.once("message", (msg) => {
      if (msg && msg.ok && msg.result) finish(msg.result);
      else if (!settled) finish(runInline(opts));
      worker.terminate();
    });
    worker.once("error", () => { if (!settled) finish(runInline(opts)); });
    worker.once("exit", (code) => { if (code !== 0 && !settled) finish(runInline(opts)); });
  });
}

// Coalesce concurrent callers (boot warm + a tab open) onto one scan so two
// workers never write the record store at once, and rapid re-opens don't
// re-scan. A later call after this one settles starts a fresh scan.
let _inFlight = null;
function syncAndAggregateOffThread(opts = {}) {
  if (_inFlight) return _inFlight;
  _inFlight = runOffThread(opts).finally(() => { _inFlight = null; });
  return _inFlight;
}

function registerUsageIpc({ ipcMain, sync = syncAndAggregateOffThread }) {
  ipcMain.handle("usage:stats", async () => {
    try { return await sync(); } catch { return { ranges: {} }; }
  });
}

module.exports = { registerUsageIpc, syncAndAggregate, syncAndAggregateOffThread, buildRanges };
