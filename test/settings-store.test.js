"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createStore } = require("../src/settings-store");

describe("createStore", () => {
  it("requires an initial snapshot object", () => {
    assert.throws(() => createStore(null), /must be an object/);
    assert.throws(() => createStore("nope"), /must be an object/);
  });

  it("getSnapshot returns a copy, not the internal reference", () => {
    const store = createStore({ a: 1, b: 2 });
    const snap = store.getSnapshot();
    snap.a = 999;
    assert.strictEqual(store.get("a"), 1);
  });

  it("get returns individual field values", () => {
    const store = createStore({ a: 1, b: "two" });
    assert.strictEqual(store.get("a"), 1);
    assert.strictEqual(store.get("b"), "two");
    assert.strictEqual(store.get("missing"), undefined);
  });
});

describe("store._commit (death-loop guard)", () => {
  it("no-ops when partial values match current snapshot", () => {
    const store = createStore({ a: 1, b: 2 });
    let calls = 0;
    store.subscribe(() => calls++);
    const result = store._commit({ a: 1, b: 2 });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(calls, 0);
  });

  it("commits and broadcasts only the keys that actually changed", () => {
    const store = createStore({ a: 1, b: 2, c: 3 });
    const broadcasts = [];
    store.subscribe((b) => broadcasts.push(b));
    const result = store._commit({ a: 1, b: 99, c: 3 });
    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual(result.changes, { b: 99 });
    assert.strictEqual(broadcasts.length, 1);
    assert.deepStrictEqual(broadcasts[0].changes, { b: 99 });
    assert.strictEqual(broadcasts[0].snapshot.b, 99);
    assert.strictEqual(store.get("b"), 99);
  });

  it("ignores invalid partial inputs without throwing", () => {
    const store = createStore({ a: 1 });
    assert.doesNotThrow(() => store._commit(null));
    assert.doesNotThrow(() => store._commit("nope"));
    assert.doesNotThrow(() => store._commit(undefined));
    assert.strictEqual(store.get("a"), 1);
  });
});

describe("store.subscribe", () => {
  it("requires a function", () => {
    const store = createStore({ a: 1 });
    assert.throws(() => store.subscribe("not a fn"), /must be a function/);
  });

  it("returns an unsubscribe function", () => {
    const store = createStore({ a: 1 });
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store._commit({ a: 2 });
    assert.strictEqual(calls, 1);
    off();
    store._commit({ a: 3 });
    assert.strictEqual(calls, 1, "unsubscribed handler should not fire");
  });

  it("isolates subscriber failures (one throws, others still run)", () => {
    const store = createStore({ a: 1 });
    let later = 0;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      store.subscribe(() => { throw new Error("boom"); });
      store.subscribe(() => later++);
      store._commit({ a: 2 });
    } finally {
      console.warn = originalWarn;
    }
    assert.strictEqual(later, 1);
  });
});

describe("store.dispose", () => {
  it("blocks further commits and clears listeners", () => {
    const store = createStore({ a: 1 });
    let calls = 0;
    store.subscribe(() => calls++);
    store.dispose();
    const result = store._commit({ a: 2 });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(calls, 0);
  });
});
