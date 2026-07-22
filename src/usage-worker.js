"use strict";

// Worker-thread entry for the usage dashboard. Runs the synchronous, fs-heavy
// session-log scan + aggregation OFF the Electron main thread so the UI never
// blocks (first boot can read many megabytes of JSONL). Requires only pure-Node
// modules — no electron — so it loads cleanly in a worker. Posts back
// { ok, result } on success or { ok:false, error } on failure; usage-ipc falls
// back to an inline main-thread scan if this worker is ever unavailable, so
// behavior degrades to the previous path rather than losing stats.

const { parentPort, workerData } = require("worker_threads");
const { syncAndAggregate } = require("./usage-ipc");

try {
  const homeDir = (workerData && workerData.homeDir) || undefined;
  const result = syncAndAggregate(homeDir ? { homeDir } : {});
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
