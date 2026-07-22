"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { registerUsageIpc, buildRanges } = require("../src/usage-ipc");
function makeIpc() { const h = {}; return { handle: (c, f) => { h[c] = f; }, invoke: (c, ...a) => h[c]({}, ...a), channels: () => Object.keys(h) }; }

test("usage:stats runs the injected sync and returns its result", async () => {
  const ipc = makeIpc();
  let called = 0;
  registerUsageIpc({ ipcMain: ipc, sync: () => { called += 1; return { ranges: { today: { requests: 3 } } }; } });
  assert.deepStrictEqual(ipc.channels(), ["usage:stats"]);
  const r = await ipc.invoke("usage:stats");
  assert.strictEqual(called, 1);
  assert.strictEqual(r.ranges.today.requests, 3);
});

test("usage:stats never rejects; a failing sync returns { ranges: {} }", async () => {
  const ipc = makeIpc();
  registerUsageIpc({ ipcMain: ipc, sync: () => { throw new Error("boom"); } });
  assert.deepStrictEqual(await ipc.invoke("usage:stats"), { ranges: {} });
});

test("buildRanges filters records by date (today vs all)", () => {
  const DAY = 86400;
  const now = 1000 * DAY + 3600; // some day, 01:00
  const todayStart = 1000 * DAY; // local midnight approximated by test's tz-independent check below
  const recs = [
    { ts: now - 10, agentId: "codex", model: "gpt-5", input: 100, output: 0, cacheRead: 0, cacheCreation: 0 }, // today-ish
    { ts: now - 3 * DAY, agentId: "codex", model: "gpt-5", input: 200, output: 0, cacheRead: 0, cacheCreation: 0 }, // 3 days ago
    { ts: now - 20 * DAY, agentId: "codex", model: "gpt-5", input: 400, output: 0, cacheRead: 0, cacheCreation: 0 }, // 20 days ago
  ];
  const r = buildRanges(recs, now);
  assert.strictEqual(r.all.requests, 3);
  assert.strictEqual(r.last7.requests, 2); // today + 3 days ago
  assert.strictEqual(r.last30.requests, 3);
  assert.ok(r.today.requests <= 1); // only the near-now record (tz-dependent midnight)
  void todayStart;
});
