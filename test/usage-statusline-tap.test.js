"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  parseChainArg,
  extractWindow,
  buildSnapshot,
  isThrottled,
  processStdin,
  runChain,
} = require("../hooks/clawd-statusline-tap");

const NOW = 1778950000000; // fixed reference instant

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-tap-"));
}

const STDIN = JSON.stringify({
  // Sensitive fields that MUST NOT end up in the snapshot.
  session_id: "14e544ae-secret",
  transcript_path: "/home/u/.claude/projects/x.jsonl",
  cwd: "/home/u/secret-project",
  model: { id: "claude-opus", display_name: "Opus" },
  rate_limits: {
    five_hour: { used_percentage: 21, resets_at: 1778959800 },
    seven_day: { used_percentage: 9, resets_at: 1779127200 },
  },
});

test("parseChainArg reads --chain in both spaced and = forms", () => {
  assert.strictEqual(parseChainArg(["--chain", "node hud.js"]), "node hud.js");
  assert.strictEqual(parseChainArg(["--chain=node hud.js"]), "node hud.js");
  assert.strictEqual(parseChainArg(["--other", "x"]), null);
  assert.strictEqual(parseChainArg([]), null);
});

test("extractWindow keeps used_percentage/resets_at, rejects non-numeric", () => {
  assert.deepStrictEqual(extractWindow({ used_percentage: 21, resets_at: 5 }), {
    used_percentage: 21,
    resets_at: 5,
  });
  assert.deepStrictEqual(extractWindow({ used_percentage: 0 }), { used_percentage: 0 });
  assert.strictEqual(extractWindow({ resets_at: 5 }), null);
  assert.strictEqual(extractWindow(null), null);
});

test("buildSnapshot extracts only rate_limits and drops sensitive fields", () => {
  const snap = buildSnapshot(JSON.parse(STDIN), NOW);
  assert.deepStrictEqual(Object.keys(snap).sort(), ["five_hour", "seven_day", "updated_at"]);
  assert.strictEqual(snap.five_hour.used_percentage, 21);
  assert.strictEqual(snap.five_hour.resets_at, 1778959800);
  assert.strictEqual(snap.seven_day.used_percentage, 9);
  assert.strictEqual(snap.updated_at, new Date(NOW).toISOString());
  // No leakage.
  const text = JSON.stringify(snap);
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("session_id"));
  assert.ok(!text.includes("transcript_path"));
  assert.ok(!text.includes("cwd"));
});

test("buildSnapshot returns null when there are no rate_limits", () => {
  assert.strictEqual(buildSnapshot({ cwd: "/x" }, NOW), null);
  assert.strictEqual(buildSnapshot({ rate_limits: {} }, NOW), null);
});

test("processStdin writes an atomic 0600 snapshot with only usage data", () => {
  const dir = tmpDir();
  const snapshotPath = path.join(dir, "statusline.json");
  const res = processStdin(STDIN, { snapshotPath, now: () => NOW });
  assert.strictEqual(res.wrote, true);

  const written = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.strictEqual(written.five_hour.used_percentage, 21);
  assert.ok(!JSON.stringify(written).includes("secret"));
  const mode = fs.statSync(snapshotPath).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test("processStdin throttles a second write within the window", () => {
  const dir = tmpDir();
  const snapshotPath = path.join(dir, "statusline.json");
  const first = processStdin(STDIN, { snapshotPath, now: () => NOW, throttleMs: 30000 });
  assert.strictEqual(first.wrote, true);

  // 10s later -> throttled, file unchanged.
  const second = processStdin(STDIN, { snapshotPath, now: () => NOW + 10000, throttleMs: 30000 });
  assert.strictEqual(second.wrote, false);
  assert.strictEqual(second.reason, "throttled");

  // 31s later -> writes again.
  const third = processStdin(STDIN, { snapshotPath, now: () => NOW + 31000, throttleMs: 30000 });
  assert.strictEqual(third.wrote, true);
});

test("isThrottled is false when no prior snapshot or bad updated_at", () => {
  const dir = tmpDir();
  const p = path.join(dir, "statusline.json");
  assert.strictEqual(isThrottled(p, NOW, 30000, fs.readFileSync), false);
  fs.writeFileSync(p, JSON.stringify({ five_hour: { used_percentage: 1 } }));
  assert.strictEqual(isThrottled(p, NOW, 30000, fs.readFileSync), false);
});

test("processStdin no-ops on unparseable stdin", () => {
  const dir = tmpDir();
  const snapshotPath = path.join(dir, "statusline.json");
  const res = processStdin("{not json", { snapshotPath, now: () => NOW });
  assert.strictEqual(res.wrote, false);
  assert.strictEqual(res.reason, "unparseable");
  assert.strictEqual(fs.existsSync(snapshotPath), false);
});

test("runChain pipes raw stdin to the chained command's stdin (transparent proxy)", async () => {
  const child = new EventEmitter();
  const writes = [];
  let ended = false;
  child.stdin = {
    on: () => {},
    write: (data) => writes.push(data),
    end: () => { ended = true; },
  };
  let spawnedCmd = null;
  let spawnedOpts = null;
  const spawn = (cmd, opts) => { spawnedCmd = cmd; spawnedOpts = opts; return child; };

  const promise = runChain("node hud.js", STDIN, { spawn });
  child.emit("close", 0);
  await promise;

  assert.strictEqual(spawnedCmd, "node hud.js");
  assert.strictEqual(spawnedOpts.shell, true);
  // stdout inherited so the chained statusline renders straight through.
  assert.deepStrictEqual(spawnedOpts.stdio, ["pipe", "inherit", "inherit"]);
  assert.deepStrictEqual(writes, [STDIN]);
  assert.strictEqual(ended, true);
});

test("runChain resolves cleanly when the chained command errors", async () => {
  const child = new EventEmitter();
  child.stdin = { on: () => {}, write: () => {}, end: () => {} };
  const spawn = () => child;
  const promise = runChain("bad-cmd", STDIN, { spawn });
  child.emit("error", new Error("ENOENT"));
  await assert.doesNotReject(promise);
});
