"use strict";

// ── Settings controller ──
//
// The single writer of the settings store. Combines:
//
//   - prefs.js (load/save/validate)
//   - settings-store.js (in-memory snapshot + subscribers)
//   - settings-actions.js (validators + commands)
//
// Public surface:
//
//   applyUpdate(key, value)        single-field update from menu/IPC
//   applyBulk(partial)             multi-field update (window bounds, mini state)
//   applyCommand(name, payload)    side-effect command (removeTheme, etc.) — always async
//   getSnapshot() / get(key)       read access
//   subscribe(fn) / subscribeKey(key, fn)   reactive side effects
//   persist()                      manual flush (idempotent — no-op if locked)
//
// **Sync vs async**: `applyUpdate` and `applyBulk` are isomorphic — they return
// a plain `{status, message?}` object synchronously when all involved actions
// are synchronous (the Phase 0 case), and a Promise wrapping the same shape
// when any action returned a thenable. This matters because the existing menu
// setters (`ctx.lang = "zh"`) are synchronous: if `applyUpdate` always returned
// a Promise, the store commit would be microtask-deferred and the next sync
// read wouldn't see the new value. `applyCommand` is always async (commands
// like `installHooks` do real file I/O).
//
// All write methods produce `{ status, message?, noop? }`. `status: 'ok'`
// means the field was either committed or already at the requested value
// (noop). `status: 'error'` means validation failed and the store wasn't
// touched.
//
// The store's `_commit` is captured here as a closure — callers of
// createSettingsController never see it, so the only way to mutate state is
// through this controller.

const { createStore } = require("./settings-store");
const prefsModule = require("./prefs");
const defaultActions = require("./settings-actions");

function createSettingsController({
  prefsPath,
  prefs = prefsModule,
  updates = defaultActions.updateRegistry,
  commands = defaultActions.commandRegistry,
  injectedDeps = {},
  loadResult = null, // optional pre-loaded { snapshot, locked } for tests
} = {}) {
  if (!prefsPath && !loadResult) {
    throw new TypeError(
      "createSettingsController: prefsPath or loadResult is required"
    );
  }

  const loaded = loadResult || prefs.load(prefsPath);
  const initialSnapshot = loaded.snapshot;
  let locked = !!loaded.locked;

  const store = createStore(initialSnapshot);

  // ── Internal helpers ──

  function buildDeps() {
    return {
      ...injectedDeps,
      snapshot: store.getSnapshot(),
    };
  }

  function persistInternal() {
    if (locked) return { status: "ok", noop: true, locked: true };
    if (!prefsPath) return { status: "ok", noop: true };
    try {
      prefs.save(prefsPath, store.getSnapshot());
      return { status: "ok" };
    } catch (err) {
      console.warn("Clawd: failed to persist prefs:", err && err.message);
      return { status: "error", message: err && err.message };
    }
  }

  function isThenable(v) {
    return v && typeof v.then === "function";
  }

  // Invoke a single validator. Returns either a sync result object or a
  // Promise resolving to one. Never throws — wraps thrown errors as
  // { status: "error" }.
  function invokeAction(key, value) {
    const action = updates[key];
    if (!action) {
      return { status: "error", message: `unknown settings key: ${key}` };
    }
    if (store.get(key) === value) {
      return { status: "ok", noop: true };
    }
    let raw;
    try {
      raw = action(value, buildDeps());
    } catch (err) {
      return { status: "error", message: `${key} action threw: ${err && err.message}` };
    }
    if (isThenable(raw)) {
      return raw.then(
        (r) => r || { status: "error", message: `${key}: action returned no result` },
        (err) => ({ status: "error", message: `${key} action threw: ${err && err.message}` })
      );
    }
    return raw || { status: "error", message: `${key}: action returned no result` };
  }

  // Commit one key/value after a successful validator result. Returns the
  // final response shape — either { status: "ok" } or a persist error.
  function finishSingle(key, value, actionResult) {
    if (!actionResult || actionResult.status !== "ok") {
      return actionResult || {
        status: "error",
        message: `${key}: action returned no result`,
      };
    }
    if (actionResult.noop) return { status: "ok", noop: true };
    const { changed } = store._commit({ [key]: value });
    if (changed) {
      const persisted = persistInternal();
      if (persisted.status !== "ok") return persisted;
    }
    return { status: "ok" };
  }

  // ── Public API ──

  // Sync-or-Promise: returns a plain result object when the action is sync,
  // a Promise wrapping one when the action is async. See file header.
  function applyUpdate(key, value) {
    const actionResult = invokeAction(key, value);
    if (isThenable(actionResult)) {
      return actionResult.then((r) => finishSingle(key, value, r));
    }
    return finishSingle(key, value, actionResult);
  }

  // Sync-or-Promise bulk update. Validates every key first; only commits if
  // every validator returns ok. If any validator is async, the whole call
  // resolves asynchronously.
  function applyBulk(partial) {
    if (!partial || typeof partial !== "object") {
      return { status: "error", message: "applyBulk: partial must be an object" };
    }
    const entries = Object.keys(partial).map((key) => ({
      key,
      value: partial[key],
      actionResult: invokeAction(key, partial[key]),
    }));
    const anyAsync = entries.some((e) => isThenable(e.actionResult));

    if (!anyAsync) {
      return finishBulk(entries);
    }
    return Promise.all(
      entries.map((e) =>
        Promise.resolve(e.actionResult).then((result) => ({ ...e, actionResult: result }))
      )
    ).then(finishBulk);
  }

  function finishBulk(entries) {
    const accumulated = {};
    for (const { key, value, actionResult } of entries) {
      if (!actionResult || actionResult.status !== "ok") {
        return actionResult || {
          status: "error",
          message: `${key}: action returned no result`,
        };
      }
      if (actionResult.noop) continue;
      accumulated[key] = value;
    }
    if (Object.keys(accumulated).length === 0) {
      return { status: "ok", noop: true };
    }
    const { changed } = store._commit(accumulated);
    if (changed) {
      const persisted = persistInternal();
      if (persisted.status !== "ok") return persisted;
    }
    return { status: "ok" };
  }

  async function applyCommand(name, payload) {
    const command = commands[name];
    if (!command) {
      return {
        status: "error",
        message: `unknown command: ${name}`,
      };
    }
    let result;
    try {
      result = await command(payload, buildDeps());
    } catch (err) {
      return {
        status: "error",
        message: `${name} command threw: ${err && err.message}`,
      };
    }
    if (!result || result.status !== "ok") {
      return result || {
        status: "error",
        message: `${name}: command returned no result`,
      };
    }
    if (result.commit && typeof result.commit === "object") {
      const { changed } = store._commit(result.commit);
      if (changed) {
        const persisted = persistInternal();
        if (persisted.status !== "ok") return persisted;
      }
    }
    return { status: "ok", message: result.message };
  }

  function getSnapshot() {
    return store.getSnapshot();
  }

  function get(key) {
    return store.get(key);
  }

  function subscribe(fn) {
    return store.subscribe(fn);
  }

  // Convenience: subscribe only for changes that touch a specific key.
  function subscribeKey(key, fn) {
    return store.subscribe(({ changes, snapshot }) => {
      if (key in changes) fn(changes[key], snapshot);
    });
  }

  // Manual persist (used by main.js before-quit if it just bulked runtime state).
  function persist() {
    return persistInternal();
  }

  function isLocked() {
    return locked;
  }

  function dispose() {
    store.dispose();
  }

  return {
    applyUpdate,
    applyBulk,
    applyCommand,
    getSnapshot,
    get,
    subscribe,
    subscribeKey,
    persist,
    isLocked,
    dispose,
  };
}

module.exports = { createSettingsController };
