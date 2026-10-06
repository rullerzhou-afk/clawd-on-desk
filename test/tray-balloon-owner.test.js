"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { createTrayBalloonOwner } = require("../src/tray-balloon-owner");

class FakeTray extends EventEmitter {
  constructor() {
    super();
    this.payloads = [];
  }

  displayBalloon(payload) {
    this.payloads.push(payload);
  }
}

function makeTimers() {
  const pending = new Set();
  return {
    setTimeout(callback) {
      const token = { callback, unref() {} };
      pending.add(token);
      return token;
    },
    clearTimeout(token) {
      pending.delete(token);
    },
    flush() {
      for (const token of [...pending]) {
        pending.delete(token);
        token.callback();
      }
    },
    size: () => pending.size,
  };
}

test("a newer tray balloon revokes the previous click owner", () => {
  const tray = new FakeTray();
  const timers = makeTimers();
  const owner = createTrayBalloonOwner({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  let firstClicks = 0;
  let secondClicks = 0;

  assert.strictEqual(owner.show(tray, {
    title: "Telegram",
    content: "migrate",
    onClick: () => { firstClicks += 1; },
  }), true);
  assert.strictEqual(owner.show(tray, {
    title: "Codex",
    content: "repair hooks",
    onClick: () => { secondClicks += 1; },
  }), true);

  tray.emit("balloon-click");
  assert.strictEqual(firstClicks, 0);
  assert.strictEqual(secondClicks, 1);
  assert.strictEqual(tray.listenerCount("balloon-click"), 0);
  assert.strictEqual(tray.listenerCount("balloon-closed"), 0);
  assert.strictEqual(timers.size(), 0);
});

test("close, timeout, dispose, and display failure all remove stale listeners", () => {
  const tray = new FakeTray();
  const timers = makeTimers();
  const owner = createTrayBalloonOwner({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  owner.show(tray, { title: "one" });
  tray.emit("balloon-closed");
  assert.strictEqual(tray.listenerCount("balloon-click"), 0);

  owner.show(tray, { title: "two" });
  timers.flush();
  assert.strictEqual(tray.listenerCount("balloon-click"), 0);

  owner.show(tray, { title: "three" });
  owner.dispose();
  assert.strictEqual(tray.listenerCount("balloon-click"), 0);

  tray.displayBalloon = () => { throw new Error("balloon failed"); };
  assert.throws(() => owner.show(tray, { title: "four" }), /balloon failed/);
  assert.strictEqual(tray.listenerCount("balloon-click"), 0);
  assert.strictEqual(tray.listenerCount("balloon-closed"), 0);
  assert.strictEqual(timers.size(), 0);
});
