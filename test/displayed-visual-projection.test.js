"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  createDisplayedVisualProjection,
} = require("../src/displayed-visual-projection");
const policy = require("../src/pet-visual-swap-policy");

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

function requestInput(deliver, overrides = {}) {
  return {
    themeId: "clawd",
    logicalState: "idle",
    displayState: "idle",
    file: "clawd-idle-follow.svg",
    hitBox: { x: 2, y: 4, w: 11, h: 11 },
    source: "state",
    deliver,
    ...overrides,
  };
}

function ackFor(request, overrides = {}) {
  return {
    themeId: request.themeId,
    displayState: request.displayState,
    requestedFile: request.file,
    actualFile: request.file,
    channel: "object",
    verified: true,
    visualGeneration: request.visualGeneration,
    outcome: "swapped",
    ...overrides,
  };
}

describe("displayed visual projection", () => {
  it("derives the settlement deadline from the complete fallback chain", () => {
    assert.strictEqual(policy.SWAP_LOAD_FALLBACK_MS, 3000);
    assert.strictEqual(policy.ACCESSORY_SETTLE_TIMEOUT_MS, 3000);
    assert.strictEqual(policy.SWAP_VISIBILITY_RESCUE_BUFFER_MS, 750);
    assert.strictEqual(policy.VISUAL_SETTLEMENT_DEADLINE_MS, 9750);
  });

  it("commits one atomic tuple only after a verified swap ACK", () => {
    const delivered = [];
    const commits = [];
    const projection = createDisplayedVisualProjection({ onCommit: (tuple) => commits.push(tuple) });
    const request = projection.request(requestInput((payload) => delivered.push(payload)));
    assert.strictEqual(projection.getSnapshot().committed, null);
    assert.strictEqual(delivered[0].visualGeneration, request.visualGeneration);
    const result = projection.settle(ackFor(request));
    assert.strictEqual(result.status, "committed");
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(projection.getSnapshot().committed)),
      {
        displayState: "idle",
        file: "clawd-idle-follow.svg",
        hitBox: { x: 2, y: 4, w: 11, h: 11 },
        source: "state",
        visualGeneration: request.visualGeneration,
        themeId: "clawd",
        logicalState: "idle",
      }
    );
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(projection.getTerminal(request.visualGeneration).status, "committed");
  });

  it("settles already-displayed immediately and supersedes a retargeted generation", () => {
    const delivered = [];
    const projection = createDisplayedVisualProjection();
    const first = projection.request(requestInput((payload) => delivered.push(payload)));
    const second = projection.request(requestInput((payload) => delivered.push(payload), {
      displayState: "roam",
    }));
    assert.strictEqual(projection.getTerminal(first.visualGeneration).status, "superseded");
    assert.deepStrictEqual(
      projection.settle(ackFor(first)),
      { accepted: false, reason: "request-mismatch" }
    );
    const result = projection.settle(ackFor(second, { outcome: "already-displayed" }));
    assert.strictEqual(result.status, "committed");
    assert.strictEqual(result.committed.displayState, "roam");
  });

  it("projects a verified different-file fallback and never pairs it with the requested hitbox", () => {
    const projection = createDisplayedVisualProjection({
      projectActualFile: ({ actualFile }) => actualFile === "clawd-idle-static.png"
        ? { displayState: "idle", hitBox: { x: 1, y: 3, w: 13, h: 10 } }
        : null,
    });
    const request = projection.request(requestInput(() => true));
    const result = projection.settle(ackFor(request, {
      outcome: "fallback",
      channel: "img",
      actualFile: "clawd-idle-static.png",
    }));
    assert.strictEqual(result.status, "committed");
    assert.strictEqual(result.committed.file, "clawd-idle-static.png");
    assert.deepStrictEqual(result.committed.hitBox, { x: 1, y: 3, w: 13, h: 10 });
  });

  it("marks unverified, mismatched, and unprojectable results failed while retaining committed", () => {
    const projection = createDisplayedVisualProjection();
    const initial = projection.request(requestInput(() => true));
    projection.settle(ackFor(initial));
    const committed = projection.getSnapshot().committed;

    const unverified = projection.request(requestInput(() => true, { file: "clawd-happy.svg" }));
    assert.strictEqual(
      projection.settle(ackFor(unverified, { verified: false, actualFile: "clawd-happy.svg" })).status,
      "failed"
    );
    assert.strictEqual(projection.getSnapshot().committed, committed);

    const fallback = projection.request(requestInput(() => true, { file: "clawd-happy.svg" }));
    assert.strictEqual(
      projection.settle(ackFor(fallback, {
        outcome: "fallback",
        actualFile: "unknown.svg",
      })).status,
      "failed"
    );
    assert.strictEqual(projection.getSnapshot().committed, committed);
  });

  it("re-requests one timed-out logical visual and reloads at most once after two no-ACK requests", () => {
    const clock = createClock();
    const delivered = [];
    const reloads = [];
    const projection = createDisplayedVisualProjection({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onRendererUnresponsive: (detail) => reloads.push(detail),
    });
    const first = projection.request(requestInput((payload) => delivered.push(payload)));
    clock.advance(policy.VISUAL_SETTLEMENT_DEADLINE_MS);
    assert.strictEqual(projection.getTerminal(first.visualGeneration).status, "failed");
    assert.strictEqual(delivered.length, 2, "first timeout should create exactly one re-request");
    const retryGeneration = delivered[1].visualGeneration;
    clock.advance(policy.VISUAL_SETTLEMENT_DEADLINE_MS);
    assert.strictEqual(projection.getTerminal(retryGeneration).status, "failed");
    assert.strictEqual(delivered.length, 2, "retry budget is keyed to the logical visual");
    assert.strictEqual(reloads.length, 1);

    projection.request(requestInput((payload) => delivered.push(payload), { file: "clawd-happy.svg" }));
    clock.advance(2 * policy.VISUAL_SETTLEMENT_DEADLINE_MS);
    assert.strictEqual(reloads.length, 1, "renderer reload budget is session-wide");
  });

  it("never replays an expired reaction delivery", () => {
    const clock = createClock();
    const delivered = [];
    const settlements = [];
    const projection = createDisplayedVisualProjection({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const reaction = projection.request(requestInput(
      (payload) => delivered.push(payload),
      {
        source: "reaction",
        file: "clawd-react-left.svg",
        onLogicalSettlement: (result) => settlements.push(result),
      }
    ));

    clock.advance(policy.VISUAL_SETTLEMENT_DEADLINE_MS);
    assert.strictEqual(delivered.length, 1);
    assert.strictEqual(projection.getTerminal(reaction.visualGeneration).status, "failed");
    assert.deepStrictEqual(settlements.map((entry) => [entry.status, entry.detail]), [
      ["failed", "settlement-timeout"],
    ]);
  });

  it("counts no-ACK requests across logical-state changes for renderer recovery", () => {
    const clock = createClock();
    const reloads = [];
    const projection = createDisplayedVisualProjection({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onRendererUnresponsive: (detail) => reloads.push(detail),
    });

    projection.request(requestInput(() => true, {
      source: "reaction",
      file: "clawd-react-left.svg",
    }));
    clock.advance(policy.VISUAL_SETTLEMENT_DEADLINE_MS);
    projection.request(requestInput(() => true, {
      source: "reaction",
      logicalState: "working",
      displayState: "working",
      file: "clawd-react-right.svg",
    }));
    clock.advance(policy.VISUAL_SETTLEMENT_DEADLINE_MS);

    assert.strictEqual(reloads.length, 1);
  });

  it("settles one logical callback with the recovery generation that commits", () => {
    const clock = createClock();
    const delivered = [];
    const settlements = [];
    const projection = createDisplayedVisualProjection({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const first = projection.request(requestInput(
      (payload) => delivered.push(payload),
      { onLogicalSettlement: (result) => settlements.push(result) }
    ));

    clock.advance(policy.VISUAL_SETTLEMENT_DEADLINE_MS);
    assert.strictEqual(projection.getTerminal(first.visualGeneration).status, "failed");
    assert.strictEqual(settlements.length, 0, "the automatic recovery is not a logical terminal");

    const retry = delivered[1];
    projection.settle(ackFor(retry));
    assert.strictEqual(settlements.length, 1);
    assert.strictEqual(settlements[0].status, "committed");
    assert.strictEqual(settlements[0].visualGeneration, retry.visualGeneration);
    assert.strictEqual(settlements[0].visual.file, retry.file);
  });

  it("invalidates pending requests while optionally retaining the last committed tuple", () => {
    const settlements = [];
    const projection = createDisplayedVisualProjection();
    const first = projection.request(requestInput(() => true));
    projection.settle(ackFor(first));
    const committed = projection.getSnapshot().committed;
    const pending = projection.request(requestInput(() => true, {
      file: "clawd-happy.svg",
      onLogicalSettlement: (result) => settlements.push(result),
    }));

    projection.reset({
      themeId: "clawd",
      logicalState: "idle",
      detail: "renderer-process-gone",
      preserveCommitted: true,
    });
    assert.strictEqual(projection.getTerminal(pending.visualGeneration).status, "superseded");
    assert.strictEqual(settlements[0].status, "superseded");
    assert.strictEqual(projection.getSnapshot().committed, committed);

    projection.reset({ themeId: "calico", logicalState: "idle", detail: "theme-activation" });
    assert.strictEqual(projection.getSnapshot().committed, null);
    assert.strictEqual(projection.getSnapshot().themeId, "calico");
  });

  it("finishes reset before a settlement callback requests a replacement", () => {
    const delivered = [];
    const settlements = [];
    const projection = createDisplayedVisualProjection();
    let replacement = null;
    const pending = projection.request(requestInput(
      (payload) => delivered.push(payload),
      {
        file: "clawd-happy.svg",
        onLogicalSettlement: (result) => {
          settlements.push(result);
          replacement = projection.request(requestInput(
            (payload) => delivered.push(payload),
            { file: "clawd-idle-follow.svg" }
          ));
        },
      }
    ));

    projection.reset({
      themeId: "clawd",
      logicalState: "idle",
      detail: "renderer-process-gone",
      preserveCommitted: true,
    });

    assert.strictEqual(projection.getTerminal(pending.visualGeneration).status, "superseded");
    assert.strictEqual(settlements.length, 1, "the invalidated request settles exactly once");
    assert.strictEqual(settlements[0].visualGeneration, pending.visualGeneration);
    assert.strictEqual(projection.getSnapshot().requested.visualGeneration, replacement.visualGeneration);
    assert.strictEqual(delivered.length, 2, "the callback replacement reaches the renderer");
    assert.strictEqual(projection.settle(ackFor(replacement)).status, "committed");
  });

  it("clears a disposed request before notifying its settlement callback", () => {
    const projection = createDisplayedVisualProjection();
    let requestedDuringSettlement = "not-called";
    const pending = projection.request(requestInput(
      () => true,
      {
        onLogicalSettlement: () => {
          requestedDuringSettlement = projection.getSnapshot().requested;
        },
      }
    ));

    projection.dispose();

    assert.strictEqual(projection.getTerminal(pending.visualGeneration).status, "failed");
    assert.strictEqual(requestedDuringSettlement, null);
    assert.strictEqual(projection.getSnapshot().requested, null);
  });

  it("reprojects committed and pending hitboxes without changing their generations", () => {
    const projection = createDisplayedVisualProjection();
    const first = projection.request(requestInput(() => true));
    projection.settle(ackFor(first));
    const pending = projection.request(requestInput(() => true, { file: "clawd-happy.svg" }));

    projection.refreshHitBoxes((file) => ({ x: file.length, y: 1, w: 2, h: 3 }));
    const snapshot = projection.getSnapshot();
    assert.strictEqual(snapshot.committed.visualGeneration, first.visualGeneration);
    assert.strictEqual(snapshot.requested.visualGeneration, pending.visualGeneration);
    assert.deepStrictEqual(snapshot.committed.hitBox, { x: 21, y: 1, w: 2, h: 3 });
    assert.deepStrictEqual(snapshot.requested.hitBox, { x: 15, y: 1, w: 2, h: 3 });
    assert.deepStrictEqual(snapshot.requested.recoveryInput.hitBox, snapshot.requested.hitBox);
  });

  it("does not commit or wait forever when renderer delivery fails", () => {
    const projection = createDisplayedVisualProjection();
    const request = projection.request(requestInput(() => false));
    assert.strictEqual(projection.getSnapshot().requested, null);
    assert.strictEqual(projection.getSnapshot().committed, null);
    assert.strictEqual(projection.getTerminal(request.visualGeneration).status, "failed");
  });
});
