"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { REPLAY_WINDOW_MS } = require("../src/dsh-focus-stream");

const filename = require.resolve("../hooks/dsh-clawd-bridge/lib/client.js");
const code = fs.readFileSync(filename, "utf8");

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const scheduled = [];
  return {
    timers,
    scheduled,
    now: () => now,
    setTimeout(fn, delay) {
      const id = ++nextId;
      timers.set(id, { fn, at: now + delay });
      scheduled.push({ delay, at: now });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
  };
}

function harness({ protocol = "dsh-app:", phase = "ready", readyOnSubscribe = false, throwOnOpen = false } = {}) {
  const clock = fakeClock();
  const sources = [];
  const opened = [];
  const subscribers = new Set();
  const cleanups = [];
  let definition;
  let unsubscribed = 0;
  class EventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.listeners = new Map();
      sources.push(this);
    }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    // Closed sources can still deliver queued callbacks; exercise the guards.
    emit(name, data) { this.listeners.get(name)?.({ data }); }
    close() { this.closed = true; }
  }
  const list = {
    getSnapshot: () => ({ phase }),
    subscribe(fn) {
      subscribers.add(fn);
      if (readyOnSubscribe) phase = "ready";
      return () => { subscribers.delete(fn); unsubscribed += 1; };
    },
  };
  const workspace = {
    openSession(id) {
      opened.push(id);
      if (throwOnOpen) throw new Error("unknown session");
    },
  };
  vm.runInNewContext(code, {
    window: { __ModuleLoader__: { load: (def) => { definition = def; } } },
    location: { protocol },
    EventSource,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  }, { filename });
  const plugin = definition.factory(() => { throw new Error("unexpected dependency"); });
  assert.deepEqual(Array.from(plugin.inject), ["uiWorkspace", "sessions"]);
  plugin.apply({
    get(name) {
      if (name === "uiWorkspace") return workspace;
      if (name === "sessions") return { list };
      assert.fail(`unexpected service ${name}`);
    },
    effect(fn) { cleanups.push(fn()); },
  });
  return {
    clock, sources, opened, subscribers,
    unsubscribed: () => unsubscribed,
    latest: () => sources.at(-1),
    setPhase(value) { phase = value; for (const fn of [...subscribers]) fn(); },
    unload() { for (const fn of cleanups) fn(); },
  };
}

function sendFocus(source, sessionId, clickId) {
  source.emit("focus", JSON.stringify({ sessionId, clickId }));
}

function failRound(h) {
  for (let port = 23333; port <= 23337; port += 1) {
    assert.equal(h.latest().url, `http://127.0.0.1:${port}/dsh/focus-stream`);
    h.latest().emit("error");
  }
}

describe("DSH browser session focus", () => {
  it("does not subscribe from an HTTP page", () => {
    const h = harness({ protocol: "http:" });
    assert.equal(h.sources.length, 0);
    assert.equal(h.clock.timers.size, 0);
  });

  it("probes ports in order and stops on the first open stream", () => {
    const h = harness();
    const first = h.latest();
    first.emit("error");
    assert.equal(first.closed, true);
    assert.equal(h.latest().url, "http://127.0.0.1:23334/dsh/focus-stream");
    h.latest().emit("open");
    h.clock.advance(60000);
    assert.equal(h.sources.length, 2);
    assert.equal(h.clock.timers.size, 0);
    h.unload();

    const allPorts = harness();
    failRound(allPorts);
    assert.equal(allPorts.sources.length, 5);
    assert.ok(allPorts.sources.every((source) => source.closed));
    allPorts.unload();
  });

  it("times out a silent probe after two seconds and ignores its late callbacks", () => {
    const h = harness();
    const first = h.latest();
    h.clock.advance(1999);
    assert.equal(h.sources.length, 1);
    assert.equal(first.closed, false);
    h.clock.advance(1);
    assert.equal(first.closed, true);
    assert.equal(h.sources.length, 2);
    first.emit("open");
    first.emit("error");
    sendFocus(first, "session-stale", "click-stale");
    assert.equal(h.sources.length, 2);
    assert.deepEqual(h.opened, []);
    assert.equal(h.clock.timers.size, 1);
    h.latest().emit("open");
    h.clock.advance(2000);
    assert.equal(h.sources.length, 2);
    h.unload();
  });

  it("backs off failed rounds and resets after a stream opens", () => {
    const h = harness();
    for (const delay of [3000, 6000, 12000, 15000, 15000]) {
      failRound(h);
      assert.equal(h.clock.scheduled.at(-1).delay, delay);
      const count = h.sources.length;
      h.clock.advance(delay - 1);
      assert.equal(h.sources.length, count);
      h.clock.advance(1);
      assert.equal(h.sources.length, count + 1);
    }
    const connected = h.latest();
    connected.emit("open");
    connected.emit("error");
    assert.equal(connected.closed, true);
    assert.equal(h.clock.scheduled.at(-1).delay, 3000);
    h.clock.advance(3000);
    failRound(h);
    assert.equal(h.clock.scheduled.at(-1).delay, 3000);
    h.unload();
  });

  it("reaches the last port within the replay budget after maximum backoff", () => {
    const h = harness();
    for (const delay of [3000, 6000, 12000]) {
      failRound(h);
      h.clock.advance(delay);
    }
    failRound(h);
    assert.equal(h.clock.scheduled.at(-1).delay, 15000);
    // The click lands just as the final round's 15-second backoff starts.
    const clickedAt = h.clock.now();
    h.clock.advance(15000);
    for (let index = 0; index < 4; index += 1) h.clock.advance(2000);
    assert.equal(h.latest().url, "http://127.0.0.1:23337/dsh/focus-stream");
    // Open at 1999ms to use almost all the fifth probe's budget without timing out.
    h.clock.advance(1999);
    h.latest().emit("open");
    sendFocus(h.latest(), "session-cold-start", "click-cold-start");
    assert.deepEqual(h.opened, ["session-cold-start"]);
    // Lock the relation between retry cap, probe timeout and replay window.
    assert.ok(h.clock.now() - clickedAt <= 25000);
    assert.ok(h.clock.now() - clickedAt < REPLAY_WINDOW_MS);
    h.unload();
  });

  it("opens a ready session once with its raw id", () => {
    const h = harness();
    h.latest().emit("open");
    sendFocus(h.latest(), "session-ready", "click-ready");
    h.setPhase("ready");
    assert.deepEqual(h.opened, ["session-ready"]);
    assert.equal(h.subscribers.size, 0);
    assert.equal(h.unsubscribed(), 1);
    assert.equal(h.clock.timers.size, 0);
    h.unload();
  });

  it("waits for a pending list and opens once when it becomes ready", () => {
    const h = harness({ phase: "pending" });
    h.latest().emit("open");
    sendFocus(h.latest(), "session-loading", "click-loading");
    assert.deepEqual(h.opened, []);
    assert.equal(h.subscribers.size, 1);
    h.clock.advance(19999);
    assert.deepEqual(h.opened, []);
    h.setPhase("ready");
    h.setPhase("ready");
    assert.deepEqual(h.opened, ["session-loading"]);
    assert.equal(h.subscribers.size, 0);
    assert.equal(h.clock.timers.size, 0);
    h.unload();
  });

  it("abandons a list that stays pending for twenty seconds", () => {
    const h = harness({ phase: "pending" });
    h.latest().emit("open");
    sendFocus(h.latest(), "session-too-late", "click-too-late");
    h.clock.advance(19999);
    assert.equal(h.subscribers.size, 1);
    h.clock.advance(1);
    assert.equal(h.subscribers.size, 0);
    assert.equal(h.clock.timers.size, 0);
    h.setPhase("ready");
    assert.deepEqual(h.opened, []);
    h.unload();
  });

  it("reads readiness after subscribing even without a store callback", () => {
    const h = harness({ phase: "pending", readyOnSubscribe: true });
    h.latest().emit("open");
    sendFocus(h.latest(), "session-race", "click-race");
    assert.deepEqual(h.opened, ["session-race"]);
    assert.equal(h.subscribers.size, 0);
    assert.equal(h.clock.timers.size, 0);
    h.unload();
  });

  it("keeps only the newest click while waiting for the list", () => {
    const h = harness({ phase: "pending" });
    h.latest().emit("open");
    sendFocus(h.latest(), "session-old", "click-old");
    h.clock.advance(1000);
    sendFocus(h.latest(), "session-new", "click-new");
    assert.equal(h.unsubscribed(), 1);
    assert.equal(h.subscribers.size, 1);
    assert.equal(h.clock.timers.size, 1);
    h.setPhase("ready");
    assert.deepEqual(h.opened, ["session-new"]);
    h.clock.advance(20000);
    assert.deepEqual(h.opened, ["session-new"]);
    h.unload();
  });

  it("ignores a replayed click after reconnect but accepts another click on the same session", () => {
    const h = harness();
    const first = h.latest();
    first.emit("open");
    sendFocus(first, "session-same", "click-first");
    first.emit("error");
    h.clock.advance(3000);
    h.latest().emit("open");
    sendFocus(h.latest(), "session-same", "click-first");
    assert.deepEqual(h.opened, ["session-same"]);
    sendFocus(h.latest(), "session-same", "click-second");
    assert.deepEqual(h.opened, ["session-same", "session-same"]);
    h.unload();
  });

  it("ignores malformed frames without changing a waiting target", () => {
    const h = harness({ phase: "pending" });
    h.latest().emit("open");
    sendFocus(h.latest(), "session-waiting", "click-waiting");
    for (const data of ["{bad", "null", "{}", JSON.stringify({ sessionId: "session-missing-click" })]) {
      assert.doesNotThrow(() => h.latest().emit("focus", data));
    }
    const invalidIds = ["", " ", 1, null, {}, []];
    invalidIds.forEach((sessionId, index) => sendFocus(h.latest(), sessionId, `click-invalid-${index}`));
    for (const clickId of ["", " ", 1, null, {}, []]) sendFocus(h.latest(), "session-invalid-click", clickId);
    assert.equal(h.subscribers.size, 1);
    assert.equal(h.unsubscribed(), 0);
    assert.deepEqual(h.opened, []);
    h.setPhase("ready");
    assert.deepEqual(h.opened, ["session-waiting"]);
    h.unload();
  });

  it("does not consume click ids from malformed frames", () => {
    const h = harness();
    h.latest().emit("open");
    // Check each malformed frame immediately against its valid replacement;
    // another valid click in between could conceal a consumed click id.
    ["", " ", 1, null, {}, []].forEach((sessionId, index) => {
      const clickId = `click-replacement-${index}`;
      const count = h.opened.length;
      sendFocus(h.latest(), sessionId, clickId);
      assert.equal(h.opened.length, count);
      sendFocus(h.latest(), "session-replacement", clickId);
      assert.equal(h.opened.length, count + 1);
      assert.equal(h.opened.at(-1), "session-replacement");
    });
    h.unload();
  });

  it("closes connecting and open sources and cancels all work on unload", () => {
    const probing = harness();
    const connecting = probing.latest();
    probing.unload();
    assert.equal(connecting.closed, true);
    assert.equal(probing.clock.timers.size, 0);
    connecting.emit("open");
    connecting.emit("error");
    probing.clock.advance(60000);
    assert.equal(probing.sources.length, 1);

    const h = harness({ phase: "pending" });
    const connected = h.latest();
    connected.emit("open");
    sendFocus(connected, "session-unloaded", "click-unloaded");
    h.unload();
    assert.equal(connected.closed, true);
    assert.equal(h.subscribers.size, 0);
    assert.equal(h.unsubscribed(), 1);
    assert.equal(h.clock.timers.size, 0);
    h.setPhase("ready");
    sendFocus(connected, "session-late", "click-late");
    connected.emit("error");
    h.clock.advance(60000);
    assert.deepEqual(h.opened, []);
    assert.equal(h.sources.length, 1);
    assert.equal(h.clock.timers.size, 0);

    const retrying = harness();
    failRound(retrying);
    retrying.unload();
    assert.equal(retrying.clock.timers.size, 0);
    retrying.clock.advance(60000);
    assert.equal(retrying.sources.length, 5);
  });

  it("contains an openSession error and does not retry a deleted session", () => {
    const h = harness({ throwOnOpen: true });
    h.latest().emit("open");
    assert.doesNotThrow(() => sendFocus(h.latest(), "session-deleted", "click-deleted"));
    h.setPhase("ready");
    sendFocus(h.latest(), "session-deleted", "click-deleted");
    assert.deepEqual(h.opened, ["session-deleted"]);
    assert.equal(h.clock.timers.size, 0);
    assert.equal(h.subscribers.size, 0);
    h.unload();
  });
});
