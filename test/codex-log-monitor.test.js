const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const CodexLogMonitor = require("../agents/codex-log-monitor");
const codexConfig = require("../agents/codex");

// Helper: create a temp session dir with today's date structure
function makeTempSessionDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
  const now = new Date();
  const dateDir = path.join(
    tmpDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );
  fs.mkdirSync(dateDir, { recursive: true });
  return { tmpDir, dateDir };
}

// Helper: create a config pointing to our temp dir
function makeConfig(tmpDir) {
  return {
    ...codexConfig,
    logConfig: { ...codexConfig.logConfig, sessionDir: tmpDir, pollIntervalMs: 100 },
  };
}

const TEST_FILENAME = "rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl";
const EXPECTED_SID = "codex:019d23d4-f1a9-7633-b9c7-758327137228";

describe("CodexLogMonitor", () => {
  let tmpDir, dateDir, monitor;

  beforeEach(() => {
    const dirs = makeTempSessionDir();
    tmpDir = dirs.tmpDir;
    dateDir = dirs.dateDir;
  });

  afterEach(() => {
    if (monitor) monitor.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should extract session ID from filename", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');

    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, (sid, state) => {
      assert.strictEqual(sid, EXPECTED_SID);
      assert.strictEqual(state, "idle");
      done();
    });
    monitor.start();
  });

  it("should map session_meta to idle", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/projects/foo"}}\n');

    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      assert.strictEqual(state, "idle");
      assert.strictEqual(extra.cwd, "/projects/foo");
      done();
    });
    monitor.start();
  });

  it("emits Codex Desktop session metadata from session_meta records", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/projects/foo",
        originator: "Codex Desktop",
        source: "vscode",
      },
    }) + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].sid, EXPECTED_SID);
    assert.strictEqual(events[0].state, "idle");
    assert.strictEqual(events[0].extra.cwd, "/projects/foo");
    assert.strictEqual(events[0].extra.codexOriginator, "Codex Desktop");
    assert.strictEqual(events[0].extra.codexSource, "vscode");
  });

  it("uses stale Codex Desktop session_meta for later live events without replaying it", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, JSON.stringify({
      timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
      type: "session_meta",
      payload: {
        cwd: "/projects/foo",
        originator: "Codex Desktop",
        source: "vscode",
      },
    }) + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));
    assert.strictEqual(events.length, 0, "old session_meta must not emit idle");

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].sid, EXPECTED_SID);
    assert.strictEqual(events[0].state, "thinking");
    assert.strictEqual(events[0].extra.cwd, "/projects/foo");
    assert.strictEqual(events[0].extra.codexOriginator, "Codex Desktop");
    assert.strictEqual(events[0].extra.codexSource, "vscode");
  });

  it("preserves Codex Desktop session metadata across tracker retirement and resume", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/projects/foo",
        originator: "Codex Desktop",
        source: "vscode",
      },
    }) + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));
    const tracked = monitor._tracked.get(testFile);
    assert.ok(tracked);
    monitor._retireTrackedFile(testFile, tracked);

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].state, "thinking");
    assert.strictEqual(events[1].extra.codexOriginator, "Codex Desktop");
    assert.strictEqual(events[1].extra.codexSource, "vscode");
  });

  it("should map task_started to thinking", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 2) {
        assert.strictEqual(states[0], "idle");
        assert.strictEqual(states[1], "thinking");
        done();
      }
    });
    monitor.start();
  });

  it("should map function_call to working", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 2) {
        assert.strictEqual(states[1], "working");
        done();
      }
    });
    monitor.start();
  });

  it("should map task_complete to idle when no tools were used", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 3) {
        assert.deepStrictEqual(states, ["idle", "thinking", "idle"]);
        done();
      }
    });
    monitor.start();
  });

  it("should map task_complete to attention when tools were used", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"ls\\"}"}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "attention") {
        assert.deepStrictEqual(states, ["idle", "thinking", "working", "attention"]);
        done();
      }
    });
    monitor.start();
  });

  it("marks subagent emits headless and resolves task_complete to idle", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: "/projects/sub",
          source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_role: "explorer" } } },
          agent_role: "explorer",
        },
      }),
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"ls\\"}"}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ state, event, headless: extra.headless, cwd: extra.cwd });
      if (event === "event_msg:task_complete") {
        assert.deepStrictEqual(events.map((entry) => entry.state), ["idle", "thinking", "working", "idle"]);
        assert.ok(events.every((entry) => entry.headless === true));
        assert.ok(events.every((entry) => entry.cwd === "/projects/sub"));
        done();
      }
    });
    monitor.start();
  });

  it("should map turn_aborted to idle", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
      '{"type":"event_msg","payload":{"type":"turn_aborted"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 3) {
        assert.strictEqual(states[2], "idle");
        done();
      }
    });
    monitor.start();
  });

  it("should dedup repeated working states", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "attention") {
        // idle, thinking, working (deduped), attention — should be 4 not 6
        assert.deepStrictEqual(states, ["idle", "thinking", "working", "attention"]);
        done();
      }
    });
    monitor.start();
  });

  it("should handle incremental writes (tail behavior)", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "thinking") {
        assert.deepStrictEqual(states, ["idle", "thinking"]);
        done();
      }
    });
    monitor.start();

    // Append after a delay (simulates Codex writing during session)
    setTimeout(() => {
      fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    }, 200);
  });

  it("should ignore unmapped event types", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"event_msg","payload":{"type":"token_count"}}',
      '{"type":"response_item","payload":{"type":"reasoning"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 3) {
        // token_count and reasoning should be ignored; no tool use → idle
        assert.deepStrictEqual(states, ["idle", "thinking", "idle"]);
        done();
      }
    });
    monitor.start();
  });

  it("should skip old files (>5min mtime)", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');
    // Backdate mtime to 10 minutes ago — outside the 5 min active window
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const config = makeConfig(tmpDir);
    let called = false;
    monitor = new CodexLogMonitor(config, () => { called = true; });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(called, false, "should not have processed old file");
      done();
    }, 300);
  });

  it("picks up slow Codex desktop sessions (mtime 3 min old) and emits only live writes", (_, done) => {
    // Two guards bundled:
    //   1. #139 gap: _getActiveDayDirs + _poll both need to find a file
    //      whose last write is in the 2–5 min range. If the file wasn't
    //      picked up, the appended live write below would never emit.
    //   2. Replay protection: the historical session_meta line (3 min old)
    //      must NOT emit "idle" on attach — that would be a replay of a
    //      stale transition on Clawd restart. Backfill mode drops it.
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/projects/slow"}}\n');
    const recent = new Date(Date.now() - 3 * 60 * 1000);
    fs.utimesSync(testFile, recent, recent);

    const config = makeConfig(tmpDir);
    const seen = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      seen.push({ state, cwd: extra.cwd });
      if (state === "thinking") {
        // Historical session_meta must not appear; only the live task_started
        // after the append should fire.
        assert.strictEqual(seen.length, 1, `expected a single live emit, got: ${JSON.stringify(seen)}`);
        assert.strictEqual(extra.cwd, "/projects/slow");
        done();
      }
    });
    monitor.start();

    // Live append after monitor has attached. This is what the user's next
    // prompt would look like in a real slow session.
    setTimeout(() => {
      fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    }, 200);
  });

  it("backfills historical turns silently, then emits live turns normally", (_, done) => {
    // Simulates Clawd restart discovering a completed turn that finished
    // minutes ago. The historical task_started/function_call/task_complete
    // sequence must NOT emit — those states belong to the past. Only
    // content appended after monitor start should reach the callback.
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"ls\\"}"}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");
    // Backdate past the grace window so backfill engages.
    const recent = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(testFile, recent, recent);

    const config = makeConfig(tmpDir);
    const seen = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      seen.push(state);
      if (state === "thinking") {
        // Should only see the live task_started; the four historical
        // state-bearing events must have been swallowed by backfill.
        assert.deepStrictEqual(seen, ["thinking"]);
        done();
      }
    });
    monitor.start();

    setTimeout(() => {
      fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    }, 200);
  });

  it("emits the current thinking state once when attaching to a stale in-progress turn", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
    ].join("\n") + "\n");
    const recent = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(testFile, recent, recent);

    const config = makeConfig(tmpDir);
    const seen = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      seen.push(state);
    });
    monitor.start();

    setTimeout(() => {
      assert.deepStrictEqual(seen, ["thinking"]);
      done();
    }, 250);
  });

  it("emits codex-permission before attention when attaching mid-turn to a stale pending shell call", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"echo hi\\"}"}}',
    ].join("\n") + "\n");
    const recent = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(testFile, recent, recent);

    const config = makeConfig(tmpDir);
    const seen = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      seen.push(state);
      if (state === "attention") {
        assert.deepStrictEqual(seen, ["codex-permission", "attention"]);
        done();
      }
    });
    monitor.start();

    setTimeout(() => {
      fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    }, 200);
  });

  it("keeps history-only backfills instead of timing them out", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");
    const recent = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(testFile, recent, recent);

    const config = makeConfig(tmpDir);
    const seen = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      seen.push(state);
    });
    monitor.start();

    for (const tracked of monitor._tracked.values()) {
      tracked.lastEventTime = Date.now() - 301000;
    }
    monitor._pruneTrackedFilesIfNeeded();

    assert.deepStrictEqual(seen, []);
    assert.strictEqual(monitor._tracked.size, 1);
  });

  it("does not synthesize SessionEnd from a 5 minute idle log timeout", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
      if (events.length === 2) {
        for (const tracked of monitor._tracked.values()) {
          tracked.lastEventTime = Date.now() - 301000;
        }
        monitor._pruneTrackedFilesIfNeeded();

        assert.strictEqual(events.some((entry) => entry.event === "SessionEnd"), false);
        assert.strictEqual(monitor._tracked.size, 1);
        done();
      }
    });
    monitor.start();
  });

  it("prunes only never-emitted tracked files when the tracker reaches capacity", () => {
    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, () => {});

    monitor._tracked.set("visible-session", { hasEmittedState: true, lastEventTime: 1 });
    for (let i = 0; i < 49; i++) {
      monitor._tracked.set(`silent-backfill-${i}`, {
        hasEmittedState: false,
        lastEventTime: 2 + i,
      });
    }

    monitor._pruneTrackedFilesIfNeeded();

    assert.strictEqual(monitor._tracked.size, 49);
    assert.strictEqual(monitor._tracked.has("visible-session"), true);
    assert.strictEqual(monitor._tracked.has("silent-backfill-0"), false);
  });

  it("retired emitted trackers resume from their stored offset if the file becomes active again", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const initial = '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n';
    fs.writeFileSync(testFile, initial);

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, cwd: extra.cwd });
    });

    monitor._tracked.set(testFile, {
      offset: Buffer.byteLength(initial),
      cwd: "/tmp",
      sessionTitle: null,
      lastState: "idle",
      lastStateEvent: "session_meta",
      hasEmittedState: true,
      hadToolUse: false,
      isSubagent: false,
      agentPid: null,
      lastEventTime: 1,
    });
    for (let i = 0; i < 49; i++) {
      monitor._tracked.set(`visible-${i}`, {
        offset: 1,
        hasEmittedState: true,
        lastEventTime: 2 + i,
      });
    }

    monitor._pruneTrackedFilesIfNeeded();
    assert.strictEqual(monitor._tracked.has(testFile), false);
    assert.strictEqual(monitor._retiredTracked.has(testFile), true);

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._pollFile(testFile, TEST_FILENAME);

    assert.deepStrictEqual(events, [{
      sid: EXPECTED_SID,
      state: "thinking",
      event: "event_msg:task_started",
      cwd: "/tmp",
    }]);
  });

  it("should handle corrupted JSON lines gracefully", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      'THIS IS NOT JSON',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 2) {
        // Should skip corrupted line and continue
        assert.deepStrictEqual(states, ["idle", "thinking"]);
        done();
      }
    });
    monitor.start();
  });

  // ── Approval heuristic tests ──

  it("should emit codex-permission after 2s timeout when no exec_command_end arrives", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    // function_call with shell_command but no exec_command_end following
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/projects/foo"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"rm -rf node_modules\\"}"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      states.push(state);
      if (state === "codex-permission") {
        assert.strictEqual(extra.permissionDetail.command, "rm -rf node_modules");
        assert.strictEqual(extra.cwd, "/projects/foo");
        done();
      }
    });
    monitor.start();
  });

  it("should NOT emit codex-permission if exec_command_end arrives within 2s", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    // function_call immediately followed by exec_command_end — auto-approved
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"ls\\"}"}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
    });
    monitor.start();

    // Wait 3s — if codex-permission doesn't appear, the timer was correctly cancelled
    setTimeout(() => {
      assert.ok(!states.includes("codex-permission"), "should not have emitted codex-permission");
      assert.ok(states.includes("idle"));
      assert.ok(states.includes("working"));
      done();
    }, 3000);
  });

  it("should NOT emit codex-permission if guardian assessment starts before command end", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"npm run build\\"}"}}',
      '{"type":"event_msg","payload":{"type":"guardian_assessment","status":"in_progress"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
    });
    monitor.start();

    setTimeout(() => {
      assert.ok(!states.includes("codex-permission"), "should not emit permission while auto-review is active");
      assert.ok(states.includes("working"));
      done();
    }, 3000);
  });

  it("should return to working when guardian approves after an explicit permission signal", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"npm run build\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"needs local build\\"}"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "codex-permission") {
        fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"guardian_assessment","status":"approved"}}\n');
      }
      if (state === "working" && states.includes("codex-permission")) {
        assert.deepStrictEqual(states, ["idle", "codex-permission", "working"]);
        done();
      }
    });
    monitor.start();
  });

  it("should NOT emit codex-permission for non-shell function calls", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    // web_search_call — not a shell command, no approval needed
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"web_search","arguments":"{\\"query\\":\\"test\\"}"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
    });
    monitor.start();

    setTimeout(() => {
      assert.ok(!states.includes("codex-permission"), "should not emit for non-shell calls");
      done();
    }, 3000);
  });

  it("should extract shell command from function_call arguments JSON", () => {
    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, () => {});
    // JSON string arguments
    assert.strictEqual(
      monitor._extractShellCommand({ name: "shell_command", arguments: '{"command":"ls -la"}' }),
      "ls -la"
    );
    // Object arguments
    assert.strictEqual(
      monitor._extractShellCommand({ name: "shell_command", arguments: { command: "git status" } }),
      "git status"
    );
    // exec_command with cmd field
    assert.strictEqual(
      monitor._extractShellCommand({ name: "exec_command", arguments: '{"cmd":"ls -la"}' }),
      "ls -la"
    );
    // Non-shell function
    assert.strictEqual(
      monitor._extractShellCommand({ name: "web_search", arguments: '{"query":"test"}' }),
      ""
    );
    // null/empty
    assert.strictEqual(monitor._extractShellCommand(null), "");
    assert.strictEqual(monitor._extractShellCommand({}), "");
  });

  it("should emit codex-permission for exec_command function calls", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/projects/foo"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"git status\\"}"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      if (state === "codex-permission") {
        assert.strictEqual(extra.permissionDetail.command, "git status");
        done();
      }
    });
    monitor.start();
  });

  it("should emit codex-permission immediately for explicit escalated requests", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/projects/foo"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"git push\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"needs network\\"}"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const startedAt = Date.now();
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      if (state === "codex-permission") {
        const elapsed = Date.now() - startedAt;
        // Should fire immediately (well under the 2s heuristic timer)
        assert.ok(elapsed < 1500, `expected immediate permission signal, got ${elapsed}ms`);
        assert.strictEqual(extra.permissionDetail.command, "git push");
        done();
      }
    });
    monitor.start();
  });

  describe("session title extraction (turn_context.summary)", () => {
    it("captures sessionTitle on next state emit after turn_context", (_, done) => {
      const testFile = path.join(dateDir, TEST_FILENAME);
      // turn_context carries the summary; session_meta (emitted after) triggers idle
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"Fix auth bug"}}',
        '{"type":"session_meta","payload":{"cwd":"/projects/foo"}}',
      ].join("\n") + "\n");

      const config = makeConfig(tmpDir);
      monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
        if (state !== "idle") return;
        assert.strictEqual(extra.sessionTitle, "Fix auth bug");
        done();
      });
      monitor.start();
    });

    it("ignores 'none' placeholder summary", (_, done) => {
      const testFile = path.join(dateDir, TEST_FILENAME);
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"none"}}',
        '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      ].join("\n") + "\n");

      const config = makeConfig(tmpDir);
      monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
        if (state !== "idle") return;
        assert.strictEqual(extra.sessionTitle, null);
        done();
      });
      monitor.start();
    });

    it("ignores 'auto' placeholder summary", (_, done) => {
      const testFile = path.join(dateDir, TEST_FILENAME);
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"auto"}}',
        '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      ].join("\n") + "\n");

      const config = makeConfig(tmpDir);
      monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
        if (state !== "idle") return;
        assert.strictEqual(extra.sessionTitle, null);
        done();
      });
      monitor.start();
    });

    it("does not emit a 'metaOnly' event just to deliver title", (_, done) => {
      // Writing turn_context alone (with no followed mapped event) must NOT
      // trigger _onStateChange. Title delivery rides on the next mapped event.
      const testFile = path.join(dateDir, TEST_FILENAME);
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"Title Only"}}',
      ].join("\n") + "\n");

      const config = makeConfig(tmpDir);
      let emittedCount = 0;
      monitor = new CodexLogMonitor(config, () => { emittedCount++; });
      monitor.start();

      // Give the monitor a poll cycle (pollIntervalMs=100ms) to prove nothing fires
      setTimeout(() => {
        assert.strictEqual(emittedCount, 0, `expected no emits, got ${emittedCount}`);
        done();
      }, 300);
    });

    it("updates sessionTitle when a later turn_context replaces an earlier one", (_, done) => {
      const testFile = path.join(dateDir, TEST_FILENAME);
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"Old Title"}}',
        '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
        '{"type":"turn_context","payload":{"summary":"New Title"}}',
        '{"type":"event_msg","payload":{"type":"task_started"}}',
      ].join("\n") + "\n");

      const config = makeConfig(tmpDir);
      const observed = [];
      monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
        observed.push({ state, title: extra.sessionTitle });
        // task_started → thinking: we should see the new title by this point
        if (state === "thinking") {
          assert.strictEqual(extra.sessionTitle, "New Title");
          done();
        }
      });
      monitor.start();
    });

    it("uses Codex /rename thread_name from session_index.jsonl", (_, done) => {
      const testFile = path.join(dateDir, TEST_FILENAME);
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"Auto Summary"}}',
        '{"type":"session_meta","payload":{"cwd":"/projects/foo"}}',
      ].join("\n") + "\n");
      const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-index-"));
      fs.writeFileSync(path.join(codexDir, "session_index.jsonl"), [
        JSON.stringify({
          id: "019d23d4-f1a9-7633-b9c7-758327137228",
          thread_name: "요구사항개선",
        }),
      ].join("\n") + "\n", "utf8");

      const config = makeConfig(tmpDir);
      monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
        if (state !== "idle") return;
        try {
          assert.strictEqual(extra.sessionTitle, "요구사항개선");
          done();
        } finally {
          fs.rmSync(codexDir, { recursive: true, force: true });
        }
      }, { codexDir });
      monitor.start();
    });
  });

  it("should process recent existing day dirs even if not today/yesterday", (_, done) => {
    const oldDateDir = path.join(tmpDir, "2024", "01", "02");
    fs.mkdirSync(oldDateDir, { recursive: true });
    const testFile = path.join(oldDateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');

    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, (sid, state) => {
      assert.strictEqual(sid, EXPECTED_SID);
      assert.strictEqual(state, "idle");
      done();
    });
    monitor.start();
  });

  it("should process recently modified rollout files even when their day dir falls outside the 7 newest by name", (_, done) => {
    const oldDateDir = path.join(tmpDir, "2024", "01", "02");
    fs.mkdirSync(oldDateDir, { recursive: true });
    const testFile = path.join(oldDateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');

    // Create 8 lexically newer day dirs so the old dir is excluded from the
    // name-based fallback window that existed before the mtime scan.
    for (let day = 3; day <= 10; day++) {
      fs.mkdirSync(path.join(tmpDir, "2024", "01", String(day).padStart(2, "0")), {
        recursive: true,
      });
    }

    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, (sid, state) => {
      assert.strictEqual(sid, EXPECTED_SID);
      assert.strictEqual(state, "idle");
      done();
    });

    assert.strictEqual(
      monitor._getCachedRecentExistingDayDirs(7).includes(oldDateDir),
      false,
      "old dir should be outside the legacy name-based fallback window"
    );

    monitor.start();
  });
});
