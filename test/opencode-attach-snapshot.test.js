"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSessionSnapshotEntry, sessionSnapshotSignature, buildSessionSnapshot } = require("../src/state-session-snapshot");

const session = {
  agentId: "opencode", rawSessionId: "opencode:ses_abc123", profileId: "local",
  state: "working", cwd: "C:\\test project", opencodeAttachSource: "opencode-plugin",
  opencodeAttachUrl: "http://127.0.0.1:4096/",
};

test("local OpenCode serve snapshot offers a secret-free new-terminal capability", () => {
  const row = buildSessionSnapshotEntry("local|opencode:ses_abc123", session, {}, { platform: "win32" });
  assert.equal(row.canOpenInTerminal, true);
  assert.equal(row.opencodeAttachUrl, undefined);
  assert.equal(JSON.stringify(row).includes("4096"), false);
});

test("attach capability is absent from unsupported session and host combinations", () => {
  for (const overrides of [
    { opencodeAttachUrl: null }, { opencodeAttachSource: "opencode-plugin-v2" },
    { agentId: "mimocode" }, { host: "remote" }, { wslDistro: "Ubuntu" },
    { profileId: "remote:one" }, { headless: true }, { state: "sleeping" },
    { rawSessionId: "opencode:default" }, { opencodeAttachUrl: "http://user:secret@localhost:4096/" },
  ]) {
    const row = buildSessionSnapshotEntry("s", { ...session, ...overrides }, {}, { platform: "win32" });
    assert.equal(row.canOpenInTerminal, false, JSON.stringify(overrides));
  }
  const row = buildSessionSnapshotEntry("s", session, {}, { platform: "darwin" });
  assert.equal(row.canOpenInTerminal, false);
});

test("attach capability changes participate in the snapshot signature", () => {
  const map = new Map([["s", session]]);
  const opts = { platform: "win32" };
  const before = buildSessionSnapshot(map, opts);
  map.set("s", { ...session, opencodeAttachUrl: null });
  const after = buildSessionSnapshot(map, opts);
  assert.notEqual(sessionSnapshotSignature(before), sessionSnapshotSignature(after));
});
