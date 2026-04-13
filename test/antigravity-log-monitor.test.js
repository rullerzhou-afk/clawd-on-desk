const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const AntigravityLogMonitor = require("../agents/antigravity-log-monitor");
const antigravityConfig = require("../agents/antigravity");

function makeTempLogDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-test-"));
  const logDir = path.join(tmpDir, "20260413T213055");
  fs.mkdirSync(logDir, { recursive: true });
  return { tmpDir, logFile: path.join(logDir, "ls-main.log") };
}

function makeConfig(tmpDir, idleAfterMs = 120) {
  return {
    ...antigravityConfig,
    logConfig: {
      ...antigravityConfig.logConfig,
      logsDir: tmpDir,
      pollIntervalMs: 30,
      idleAfterMs,
      tailLinesOnStart: 50,
    },
  };
}

describe("AntigravityLogMonitor", () => {
  let tmpDir, logFile, monitor;

  beforeEach(() => {
    const dirs = makeTempLogDir();
    tmpDir = dirs.tmpDir;
    logFile = dirs.logFile;
  });

  afterEach(() => {
    if (monitor) monitor.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sees planner requests as thinking", (_, done) => {
    fs.writeFileSync(logFile, "I0413 22:00:32.692358 53208 planner_generator.go:283] Requesting planner with 38 chat messages\n");
    monitor = new AntigravityLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      assert.strictEqual(sid, "antigravity:main");
      assert.strictEqual(state, "thinking");
      assert.strictEqual(event, "BeforeAgent");
      done();
    });
    monitor.start();
  });

  it("sees overlay actions as working and uses cascade id", (_, done) => {
    fs.writeFileSync(logFile, 'I0413 21:52:31.254712 53208 operator.go:899] [overlay] Running JS: window.updateActuationOverlay({"cascadeId":"abc-123","displayString":"Getting DOM...","passthroughEnabled":true})\n');
    monitor = new AntigravityLogMonitor(makeConfig(tmpDir), (sid, state, event, extra) => {
      assert.strictEqual(sid, "antigravity:abc-123");
      assert.strictEqual(state, "working");
      assert.strictEqual(event, "BeforeTool");
      assert.strictEqual(extra.displayString, "Getting DOM...");
      done();
    });
    monitor.start();
  });

  it("ignores passthrough false overlay duplicates", async () => {
    fs.writeFileSync(logFile, 'I0413 21:52:31.254712 53208 operator.go:899] [overlay] Running JS: window.updateActuationOverlay({"cascadeId":"abc-123","displayString":"Getting DOM...","passthroughEnabled":false})\n');
    const seen = [];
    monitor = new AntigravityLogMonitor(makeConfig(tmpDir), (...args) => seen.push(args));
    monitor.start();
    await new Promise((r) => setTimeout(r, 120));
    assert.deepStrictEqual(seen, []);
  });

  it("sees cascade execution failures as error", (_, done) => {
    fs.writeFileSync(logFile, 'E0413 22:02:19.797888 53208 log.go:398] error executing cascade step: boom\n');
    monitor = new AntigravityLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      assert.strictEqual(sid, "antigravity:main");
      assert.strictEqual(state, "error");
      assert.strictEqual(event, "PostToolUseFailure");
      done();
    });
    monitor.start();
  });


  it("does not let planner chatter override active work", async () => {
    fs.writeFileSync(logFile, [
      'I0413 21:52:31.254712 53208 operator.go:899] [overlay] Running JS: window.updateActuationOverlay({"cascadeId":"busy-case","displayString":"Getting DOM...","passthroughEnabled":true})',
      'I0413 21:52:31.454712 53208 planner_generator.go:283] Requesting planner with 38 chat messages',
    ].join("\n") + "\n");
    const seen = [];
    monitor = new AntigravityLogMonitor(makeConfig(tmpDir, 500), (sid, state, event) => {
      seen.push([sid, state, event]);
    });
    monitor.start();
    await new Promise((r) => setTimeout(r, 150));
    assert.deepStrictEqual(seen, [["antigravity:busy-case", "working", "BeforeTool"]]);
  });

  it("treats screenshot capture as work too", (_, done) => {
    fs.writeFileSync(logFile, 'I0413 23:11:16.082014 53208 operator.go:899] [overlay] Running JS: window.updateActuationOverlay({"capturingScreenshot":true})\n');
    monitor = new AntigravityLogMonitor(makeConfig(tmpDir), (sid, state, event, extra) => {
      assert.strictEqual(sid, "antigravity:main");
      assert.strictEqual(state, "working");
      assert.strictEqual(event, "BeforeTool");
      assert.strictEqual(extra.displayString, "Taking screenshot...");
      done();
    });
    monitor.start();
  });
  it("falls back to idle after the activity goes quiet", async () => {
    fs.writeFileSync(logFile, 'I0413 21:52:31.254712 53208 operator.go:899] [overlay] Running JS: window.updateActuationOverlay({"cascadeId":"idle-case","displayString":"Clicking...","passthroughEnabled":true})\n');
    const seen = [];
    monitor = new AntigravityLogMonitor(makeConfig(tmpDir, 80), (sid, state, event) => {
      seen.push([sid, state, event]);
    });
    monitor.start();
    await new Promise((r) => setTimeout(r, 180));
    assert.deepStrictEqual(seen, [
      ["antigravity:idle-case", "working", "BeforeTool"],
      ["antigravity:idle-case", "idle", "SessionIdle"],
    ]);
  });
});
