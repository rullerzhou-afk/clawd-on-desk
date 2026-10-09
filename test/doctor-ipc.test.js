const { describe, it } = require("node:test");
const assert = require("node:assert");
const { __test } = require("../src/doctor-ipc");

describe("Doctor IPC helpers", () => {
  it("single-flights concurrent doctor checks and resets after completion", async () => {
    let calls = 0;
    let resolveRun;
    const runChecks = __test.createDoctorRunChecksDeduper(() => {
      calls += 1;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    });

    const first = runChecks();
    const second = runChecks();

    assert.strictEqual(first, second);
    assert.strictEqual(calls, 1);

    resolveRun({ status: "ok" });
    assert.deepStrictEqual(await second, { status: "ok" });

    const third = runChecks();
    assert.notStrictEqual(third, first);
    assert.strictEqual(calls, 2);

    resolveRun({ status: "again" });
    assert.deepStrictEqual(await third, { status: "again" });
  });

  it("resets doctor checks after synchronous failures", async () => {
    let calls = 0;
    const runChecks = __test.createDoctorRunChecksDeduper(() => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { status: "recovered" };
    });

    await assert.rejects(runChecks(), /boom/);
    assert.deepStrictEqual(await runChecks(), { status: "recovered" });
    assert.strictEqual(calls, 2);
  });

  it("warms Windows desktop discovery before running checks without blocking the caller", async () => {
    const order = [];
    let releasePreheat;
    const runner = __test.createDoctorRunChecksRunner({
      platform: "win32",
      preheatDshDesktopDiscovery: () => {
        order.push("preheat");
        return new Promise((resolve) => { releasePreheat = resolve; });
      },
      runChecks: () => {
        order.push("checks");
        return { status: "ok" };
      },
    });

    const pending = runner();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepStrictEqual(order, ["preheat"]);
    releasePreheat();
    assert.deepStrictEqual(await pending, { status: "ok" });
    assert.deepStrictEqual(order, ["preheat", "checks"]);
  });

  it("still returns checks when the desktop preheat fails", async () => {
    const runner = __test.createDoctorRunChecksRunner({
      platform: "win32",
      preheatDshDesktopDiscovery: async () => { throw new Error("powershell unavailable"); },
      runChecks: () => ({ status: "ok" }),
    });
    assert.deepStrictEqual(await runner(), { status: "ok" });
  });

  it("never preheats on non-Windows platforms", async () => {
    let calls = 0;
    const runner = __test.createDoctorRunChecksRunner({
      platform: "darwin",
      preheatDshDesktopDiscovery: async () => { calls += 1; },
      runChecks: () => ({ status: "ok" }),
    });
    await runner();
    assert.strictEqual(calls, 0);
  });

  it("normalizes doctor:test-connection payloads to objects", () => {
    assert.deepStrictEqual(__test.normalizeDoctorConnectionTestPayload(null), {});
    assert.deepStrictEqual(__test.normalizeDoctorConnectionTestPayload("bad"), {});
    assert.deepStrictEqual(__test.normalizeDoctorConnectionTestPayload([]), {});
    assert.deepStrictEqual(__test.normalizeDoctorConnectionTestPayload({ durationMs: 1000 }), { durationMs: 1000 });
  });

  it("normalizes doctor:open-clawd-log payloads to string names only", () => {
    assert.deepStrictEqual(__test.normalizeDoctorOpenLogPayload(null), {});
    assert.deepStrictEqual(__test.normalizeDoctorOpenLogPayload("bad"), {});
    assert.deepStrictEqual(__test.normalizeDoctorOpenLogPayload({ name: 123 }), {});
    assert.deepStrictEqual(__test.normalizeDoctorOpenLogPayload({ name: "clawd.log" }), { name: "clawd.log" });
  });
});
