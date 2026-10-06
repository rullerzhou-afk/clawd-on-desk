"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  BLOCK_STOP_REASON,
  EVENTS,
  appendRecord,
  buildRecord,
  buildSettings,
  claimBlockStopOnce,
} = require("../scripts/manual/claude-subagent-event-sampler");

function assertPrivatePosixMode(filePath) {
  // NTFS does not implement POSIX permission bits; Node reports the inherited
  // Windows ACL as 0666 even after open/fchmod requested 0600.
  if (process.platform === "win32") return;
  assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
}

describe("Claude subagent D0 event sampler", () => {
  it("records only the approved field whitelist and redacts the session id", () => {
    const record = buildRecord("PreToolUse", {
      hook_event_name: "PreToolUse",
      session_id: "secret-session",
      agent_id: "agent-child",
      agent_type: "Explore",
      tool_name: "Agent",
      tool_use_id: "tool-1",
      source: "startup",
      stop_hook_active: true,
      prompt: "must not leak",
      tool_input: { prompt: "must not leak" },
      cwd: "/private/project",
      transcript_path: "/private/transcript.jsonl",
    }, {
      caseId: "nested",
      salt: "test-salt",
      timestamp: "2026-08-14T00:00:00.000Z",
      monotonicNs: 123n,
    });

    assert.deepStrictEqual(Object.keys(record), [
      "format_version", "case_id", "sequence_ns", "timestamp", "argv_event",
      "payload_event", "session", "agent_id", "agent_type", "tool_name",
      "tool_use_id", "source", "reason", "stop_hook_active",
    ]);
    assert.notStrictEqual(record.session, "secret-session");
    assert.strictEqual(record.session.length, 16);
    assert.strictEqual(JSON.stringify(record).includes("must not leak"), false);
    assert.strictEqual(JSON.stringify(record).includes("/private"), false);
  });

  it("generates an isolated command hook for every D0 event", () => {
    const settings = buildSettings({
      scriptPath: "/tmp/sampler.js",
      nodeBin: "/tmp/node",
      logPath: "/tmp/events.jsonl",
      caseId: "two-concurrent",
      salt: "salt",
    });
    assert.deepStrictEqual(Object.keys(settings.hooks), [...EVENTS]);
    for (const event of EVENTS) {
      const hook = settings.hooks[event][0].hooks[0];
      assert.strictEqual(hook.type, "command");
      assert.match(hook.command, new RegExp(`--event '${event}'$`));
      assert.doesNotMatch(hook.command, /\$CLAWD_RAW_EVENT/);
      assert.match(hook.command, /record/);
      assert.match(hook.command, /events\.jsonl/);
    }
  });

  it("can append a one-shot SubagentStop blocker after passive recording", () => {
    const settings = buildSettings({
      scriptPath: "/tmp/sampler.js",
      nodeBin: "/tmp/node",
      logPath: "/tmp/events.jsonl",
      caseId: "blocked-stop",
      salt: "salt",
      blockStopMarker: "/tmp/block-once.marker",
    });
    const stopHooks = settings.hooks.SubagentStop[0].hooks;
    assert.strictEqual(stopHooks.length, 2);
    assert.match(stopHooks[0].command, /record/);
    assert.match(stopHooks[1].command, /block-stop-once/);
    assert.match(stopHooks[1].command, /block-once\.marker/);
    assert.strictEqual(BLOCK_STOP_REASON.includes("read-only tool"), true);
  });

  it("claims the stop blocker exactly once with a private marker", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-d0-block-test-"));
    const markerPath = path.join(dir, "block-once.marker");
    try {
      assert.strictEqual(claimBlockStopOnce(markerPath), true);
      assertPrivatePosixMode(markerPath);
      assert.strictEqual(claimBlockStopOnce(markerPath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses private POSIX mode where supported and refuses records beyond the cap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-d0-sampler-test-"));
    const logPath = path.join(dir, "events.jsonl");
    try {
      assert.strictEqual(appendRecord(logPath, { ok: true }, 1024), true);
      assertPrivatePosixMode(logPath);
      assert.strictEqual(appendRecord(logPath, { payload: "x".repeat(1024) }, 32), false);
      assert.deepStrictEqual(
        fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse),
        [{ ok: true }]
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
