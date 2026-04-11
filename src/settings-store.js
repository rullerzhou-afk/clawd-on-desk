"use strict";

// ── Settings store ──
//
// A minimal in-memory state container that the controller wraps. The point of
// this module is to enforce **structurally** that nobody outside the controller
// can mutate state: `_commit` is captured in a closure inside the factory and
// only the immediate caller of `createStore()` ever sees it. The public API is
// `getSnapshot` + `subscribe` + `dispose`.
//
// Death-loop guard: `_commit(partial)` shallow-compares each key against the
// current snapshot. If nothing actually changed, no listeners fire — so a
// well-meaning subscriber that re-saves the snapshot can't trigger an infinite
// echo.
//
// Subscribers receive `{ changes, snapshot }` where `changes` is the partial
// that just landed (only keys whose values actually changed) and `snapshot` is
// the full new snapshot.

function createStore(initialSnapshot) {
  if (!initialSnapshot || typeof initialSnapshot !== "object") {
    throw new TypeError("createStore(initialSnapshot): initialSnapshot must be an object");
  }
  // Defensive copy so the caller can't mutate the store from the outside.
  let snapshot = { ...initialSnapshot };
  const listeners = new Set();
  let disposed = false;

  function getSnapshot() {
    // Return a shallow copy so callers can't mutate internal state by
    // grabbing the reference and assigning to it.
    return { ...snapshot };
  }

  function get(key) {
    return snapshot[key];
  }

  function subscribe(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("subscribe(fn): fn must be a function");
    }
    listeners.add(fn);
    return function unsubscribe() {
      listeners.delete(fn);
    };
  }

  // ── Closure-private mutator ──
  // Returned only via the factory return value, which the controller captures
  // and never re-exports. External callers literally can't reach this.
  function _commit(partial) {
    if (disposed) return { changed: false, changes: {} };
    if (!partial || typeof partial !== "object") {
      return { changed: false, changes: {} };
    }
    const changes = {};
    for (const key of Object.keys(partial)) {
      const next = partial[key];
      // Shallow equality check — primitives compare by value; objects always
      // count as a change (caller is responsible for not committing identical
      // object references unless they intend to broadcast).
      if (snapshot[key] !== next) {
        changes[key] = next;
      }
    }
    if (Object.keys(changes).length === 0) {
      return { changed: false, changes };
    }
    snapshot = { ...snapshot, ...changes };
    const broadcast = { changes, snapshot: { ...snapshot } };
    for (const fn of listeners) {
      try {
        fn(broadcast);
      } catch (err) {
        console.warn("Clawd: settings-store subscriber threw:", err && err.message);
      }
    }
    return { changed: true, changes };
  }

  function dispose() {
    disposed = true;
    listeners.clear();
  }

  return {
    getSnapshot,
    get,
    subscribe,
    dispose,
    // _commit is intentionally on the return object — only direct callers of
    // createStore() see it. The controller treats it as private.
    _commit,
  };
}

module.exports = { createStore };
