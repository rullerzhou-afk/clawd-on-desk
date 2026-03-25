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

  it("should map task_complete to attention", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 2) {
        assert.strictEqual(states[1], "attention");
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
        // idle, working (deduped), attention — should be 3 not 5
        assert.strictEqual(states.length, 3);
        assert.deepStrictEqual(states, ["idle", "working", "attention"]);
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
      '{"type":"event_msg","payload":{"type":"token_count"}}',
      '{"type":"response_item","payload":{"type":"reasoning"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "attention") {
        // token_count and reasoning should be ignored
        assert.deepStrictEqual(states, ["idle", "attention"]);
        done();
      }
    });
    monitor.start();
  });

  it("should skip old files (>2min mtime)", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');
    // Backdate mtime to 10 minutes ago
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

  it("should handle corrupted JSON lines gracefully", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      'THIS IS NOT JSON',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "attention") {
        // Should skip corrupted line and continue
        assert.deepStrictEqual(states, ["idle", "attention"]);
        done();
      }
    });
    monitor.start();
  });
});
