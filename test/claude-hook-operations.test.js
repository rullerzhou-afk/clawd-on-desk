"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createClaudeHookOperations } = require("../src/claude-hook-operations");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createClaudeHookOperations", () => {
  it("serializes operations to at most one in flight at a time, in FIFO order", async () => {
    const ops = createClaudeHookOperations();
    const log = [];
    let active = 0;
    let maxActive = 0;

    const p1 = ops.enqueue({ source: "a" }, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push("a-start");
      await wait(20);
      log.push("a-end");
      active--;
      return { status: "ok", source: "a" };
    });
    const p2 = ops.enqueue({ source: "b" }, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push("b-start");
      log.push("b-end");
      active--;
      return { status: "ok", source: "b" };
    });

    await Promise.all([p1, p2]);

    assert.deepStrictEqual(log, ["a-start", "a-end", "b-start", "b-end"]);
    assert.strictEqual(maxActive, 1);
  });

  it("continues processing queued work after an earlier task throws", async () => {
    const ops = createClaudeHookOperations();

    const p1 = ops.enqueue({ source: "a" }, async () => {
      throw new Error("boom");
    });
    const p2 = ops.enqueue({ source: "b" }, async () => ({ status: "ok", ran: true }));

    const r1 = await p1;
    const r2 = await p2;

    assert.strictEqual(r1.status, "error");
    assert.match(r1.message, /boom/);
    assert.deepStrictEqual(r2, { status: "ok", ran: true });
  });

  it("continues processing queued work after an earlier task rejects its promise", async () => {
    const ops = createClaudeHookOperations();

    const p1 = ops.enqueue({ source: "a" }, () => Promise.reject(new Error("async boom")));
    const p2 = ops.enqueue({ source: "b" }, async () => ({ status: "ok" }));

    const r1 = await p1;
    const r2 = await p2;

    assert.strictEqual(r1.status, "error");
    assert.match(r1.message, /async boom/);
    assert.strictEqual(r2.status, "ok");
  });

  it("re-checks the automatic gate right before execution, not at enqueue time", async () => {
    let gateOpen = true;
    const ops = createClaudeHookOperations({ shouldRunAutomatic: () => gateOpen });
    const calls = [];

    // Enqueued while the gate is open, but does not run until after the
    // blocker ahead of it closes the gate.
    const blocker = ops.enqueue({ source: "blocker", automatic: false }, async () => {
      await wait(20);
      gateOpen = false;
      calls.push("blocker");
      return { status: "ok" };
    });
    const auto = ops.enqueue({ source: "auto", automatic: true }, async () => {
      calls.push("auto-ran");
      return { status: "ok" };
    });

    const [, autoResult] = await Promise.all([blocker, auto]);

    assert.deepStrictEqual(calls, ["blocker"]);
    assert.deepStrictEqual(autoResult, { status: "skipped", reason: "gate-closed", source: "auto" });
  });

  it("runs an automatic task normally while the gate stays open", async () => {
    const ops = createClaudeHookOperations({ shouldRunAutomatic: () => true });
    const result = await ops.enqueue({ source: "watcher", automatic: true }, async () => ({ status: "ok" }));
    assert.deepStrictEqual(result, { status: "ok" });
  });

  it("does not let a closed automatic gate block an explicit manual task (Doctor Fix / Settings Install)", async () => {
    const ops = createClaudeHookOperations({ shouldRunAutomatic: () => false });
    let taskRan = false;

    const result = await ops.enqueue({ source: "doctor-fix", automatic: false }, async () => {
      taskRan = true;
      return { status: "ok" };
    });

    assert.strictEqual(taskRan, true);
    assert.deepStrictEqual(result, { status: "ok" });
  });

  it("keeps two independent instances from observing each other's queue", async () => {
    const opsA = createClaudeHookOperations();
    const opsB = createClaudeHookOperations();
    const log = [];

    const slowA = opsA.enqueue({ source: "a" }, async () => {
      await wait(30);
      log.push("a-done");
      return { status: "ok" };
    });
    const quickB = opsB.enqueue({ source: "b" }, async () => {
      log.push("b-done");
      return { status: "ok" };
    });

    await quickB;
    assert.deepStrictEqual(log, ["b-done"], "B's own queue must not wait behind an unrelated instance's task");

    await slowA;
    assert.deepStrictEqual(log, ["b-done", "a-done"]);
  });

  it("rejects new work immediately after dispose without invoking the task", async () => {
    const ops = createClaudeHookOperations();
    ops.dispose();
    let taskCalled = false;

    const result = await ops.enqueue({ source: "x", automatic: false }, async () => {
      taskCalled = true;
      return { status: "ok" };
    });

    assert.strictEqual(taskCalled, false);
    assert.strictEqual(result.status, "error");
    assert.strictEqual(ops.isDisposed(), true);
  });

  it("stops an already-queued task from executing once disposed mid-flight", async () => {
    const ops = createClaudeHookOperations();
    let secondCalled = false;

    const p1 = ops.enqueue({ source: "a" }, async () => {
      await wait(20);
      ops.dispose();
      return { status: "ok" };
    });
    const p2 = ops.enqueue({ source: "b" }, async () => {
      secondCalled = true;
      return { status: "ok" };
    });

    await p1;
    const r2 = await p2;

    assert.strictEqual(secondCalled, false);
    assert.strictEqual(r2.status, "error");
  });

  it("never rejects the returned promise, even when the task throws synchronously", async () => {
    const ops = createClaudeHookOperations();
    await assert.doesNotReject(
      ops.enqueue({ source: "sync-throw" }, () => {
        throw new Error("sync boom");
      })
    );
  });
});
