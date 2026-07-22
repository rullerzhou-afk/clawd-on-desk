"use strict";

// IPC for the usage dashboard. `usage:stats` runs an incremental scan of the
// session logs (cheap after the first pass), merges into the keyed record
// store, then returns aggregated totals for several date ranges (today / last 7
// / last 30 / all) so the UI can switch instantly without re-scanning. No proxy.

const os = require("os");
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

function registerUsageIpc({ ipcMain, sync = syncAndAggregate }) {
  ipcMain.handle("usage:stats", () => {
    try { return sync(); } catch { return { ranges: {} }; }
  });
}

module.exports = { registerUsageIpc, syncAndAggregate, buildRanges };
