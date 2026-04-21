const { describe, it } = require("node:test");
const assert = require("node:assert");
const KimiLogMonitor = require("../agents/kimi-log-monitor");

describe("KimiLogMonitor lifecycle (hook-only stub)", () => {
  it("constructor/start/stop do not throw", () => {
    const monitor = new KimiLogMonitor(
      { id: "kimi-cli" },
      () => {}
    );
    assert.doesNotThrow(() => monitor.start());
    assert.doesNotThrow(() => monitor.stop());
  });

  it("stop is idempotent", () => {
    const monitor = new KimiLogMonitor();
    assert.doesNotThrow(() => monitor.stop());
    assert.doesNotThrow(() => monitor.stop());
  });

  it("start-stop-start-stop sequence remains safe", () => {
    const monitor = new KimiLogMonitor();
    assert.doesNotThrow(() => monitor.start());
    assert.doesNotThrow(() => monitor.stop());
    assert.doesNotThrow(() => monitor.start());
    assert.doesNotThrow(() => monitor.stop());
  });
});
