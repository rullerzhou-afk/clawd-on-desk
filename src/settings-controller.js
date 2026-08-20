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
//   hydrate(partial)               import external state into prefs WITHOUT
//                                    running pre-commit effects (used by startup
//                                    system-backed settings hydration)
//   getSnapshot() / get(key)       read access
//   subscribe(fn) / subscribeKey(key, fn)   reactive side effects
//   persist()                      manual flush (idempotent — no-op if locked)
//   isLocked() / hasReadFailure()  persistence / startup-authority state
//
// **updateRegistry entry shapes**: each entry in `updates` may be either
//
//   - a plain function `(value, deps) => result`            — pure validator,
//                                                              no side effect
//   - an object `{ validate, effect? }`                     — pre-commit gate:
//                                                              `validate` runs
//                                                              first, then `effect`
//                                                              touches the outside
//                                                              world. Either may
//                                                              return a Promise.
//                                                              If effect fails, the
//                                                              store is NOT committed.
//
// `hydrate()` invokes only the `validate` half (or the function-form entry as a
// pure validator) and skips `effect` entirely. This is the only way to import
// external state — like `app.getLoginItemSettings()` — into prefs without
// triggering a redundant write back to the system.
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
// An unreadable prefs file is a stronger condition than a readable
// future-version file. Both are `locked`, but only the unreadable path is also
// `recovered`. In that `locked && recovered` safe mode, user mutations and
// commands are rejected before validators/effects run: the in-memory snapshot
// is only defaults, so neither it nor any external side effect is authoritative.
// `hydrate()` remains available for startup imports of external truth; it skips
// pre-commit effects and still cannot write through the locked persistence gate.
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
  const readFailure = loaded.locked === true && loaded.recovered === true;

  const store = createStore(initialSnapshot);

  // Per-key/domain async serialization. When an async action is in flight for a
  // key, later writes on the same key queue after it instead of racing —
  // otherwise a slow-resolving effect could commit after a fast-resolving one
  // and flip the store back. Some actions can opt into a shared lock domain
  // when different settings/commands mutate the same external resource (for
  // example ~/.claude/settings.json). Sync actions on an idle key skip the lock
  // entirely so the common path stays synchronous (menu setters rely on that).
  // The Map self-cleans: once a tracked promise settles, its entry is removed
  // unless another call has already chained a newer one on top.
  const _asyncLocks = new Map();
  function _trackAsyncLock(lockKey, p) {
    _asyncLocks.set(lockKey, p);
    const cleanup = () => {
      if (_asyncLocks.get(lockKey) === p) _asyncLocks.delete(lockKey);
    };
    Promise.resolve(p).then(cleanup, cleanup);
  }

  // ── Internal helpers ──

  function buildDeps() {
    return {
      ...injectedDeps,
      snapshot: store.getSnapshot(),
    };
  }

  function persistInternal(snapshot = store.getSnapshot()) {
    if (locked) {
      return {
        status: "ok",
        noop: true,
        locked: true,
        ...(readFailure ? { readFailure: true } : {}),
      };
    }
    if (!prefsPath) return { status: "ok", noop: true };
    try {
      prefs.save(prefsPath, snapshot);
      return { status: "ok" };
    } catch (err) {
      console.warn("Clawd: failed to persist prefs:", err && err.message);
      return { status: "error", message: err && err.message };
    }
  }

  function isThenable(v) {
    return v && typeof v.then === "function";
  }

  function readFailureResult(operation) {
    return {
      status: "error",
      code: "prefs-read-failure",
      locked: true,
      readFailure: true,
      message:
        `Cannot ${operation}: the preferences file could not be read. ` +
        "Fix access to the file and restart Clawd before changing settings.",
    };
  }

  // Resolve an entry's validator function. Function-form entries ARE the
  // validator; object-form entries expose it as `.validate`.
  function resolveValidator(entry) {
    if (typeof entry === "function") return entry;
    if (entry && typeof entry.validate === "function") return entry.validate;
    return null;
  }

  function isCommandOnlyEntry(entry) {
    return Boolean(entry && typeof entry === "object" && entry.commandOnly === true);
  }

  function rejectCommandOnly(key, operation) {
    if (!isCommandOnlyEntry(updates[key])) return null;
    return {
      status: "error",
      message: `${key}: command-only setting cannot be changed via ${operation}`,
    };
  }

  function buildChangedPartial(partial, snapshot = store.getSnapshot()) {
    const changed = {};
    for (const key of Object.keys(partial || {})) {
      if (snapshot[key] !== partial[key]) changed[key] = partial[key];
    }
    return changed;
  }

  // Resolve an entry's pre-commit effect (object-form only). Function-form
  // entries have no effect by definition. Returns null if absent.
  function resolveEffect(entry) {
    if (entry && typeof entry === "object" && typeof entry.effect === "function") {
      return entry.effect;
    }
    return null;
  }

  function resolveUpdateLockKey(key) {
    const entry = updates[key];
    if (entry && typeof entry.lockKey === "string" && entry.lockKey) {
      return `domain:${entry.lockKey}`;
    }
    return `update:${key}`;
  }

  function resolveCommandLockKey(name) {
    const command = commands[name];
    if (command && typeof command.lockKey === "string" && command.lockKey) {
      return `domain:${command.lockKey}`;
    }
    return `cmd:${name}`;
  }

  // Run one fn (validator or effect) and normalize its return into a sync
  // object or a Promise resolving to one. Never throws.
  function runStep(label, fn, value, deps) {
    let raw;
    try {
      raw = fn(value, deps);
    } catch (err) {
      return { status: "error", message: `${label} threw: ${err && err.message}` };
    }
    if (isThenable(raw)) {
      return raw.then(
        (r) => r || { status: "error", message: `${label}: returned no result` },
        (err) => ({ status: "error", message: `${label} threw: ${err && err.message}` })
      );
    }
    return raw || { status: "error", message: `${label}: returned no result` };
  }

  // Invoke an entry's validator (always) followed by its effect (if any).
  // `options.skipEffect` true → only the validator runs (used by hydrate()).
  // Returns either a sync result object or a Promise resolving to one.
  function invokeAction(key, value, options = {}) {
    const entry = updates[key];
    if (!entry) {
      return { status: "error", message: `unknown settings key: ${key}` };
    }
    if (store.get(key) === value) {
      return { status: "ok", noop: true };
    }
    if (readFailure && options.allowDuringReadFailure !== true) {
      return readFailureResult(`change ${key}`);
    }
    const validator = resolveValidator(entry);
    if (!validator) {
      return { status: "error", message: `${key}: entry has no validator` };
    }
    const validateResult = runStep(`${key} validate`, validator, value, buildDeps());

    const effect = options.skipEffect ? null : resolveEffect(entry);
    if (!effect) return validateResult;

    // Effect runs only if validate succeeded.
    function maybeRunEffect(r) {
      if (!r || r.status !== "ok" || r.noop) return r;
      return runStep(`${key} effect`, effect, value, buildDeps());
    }

    if (isThenable(validateResult)) {
      return validateResult.then(maybeRunEffect);
    }
    return maybeRunEffect(validateResult);
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
    const currentSnapshot = store.getSnapshot();
    const changedPartial = buildChangedPartial({ [key]: value }, currentSnapshot);
    if (Object.keys(changedPartial).length > 0) {
      const persisted = persistInternal({ ...currentSnapshot, ...changedPartial });
      if (persisted.status !== "ok") return persisted;
      store._commit(changedPartial);
    }
    return { status: "ok" };
  }

  // ── Public API ──

  // Sync-or-Promise: returns a plain result object when the action is sync,
  // a Promise wrapping one when the action is async. See file header.
  //
  // Per-key serialization: if an async action is already in flight for this
  // key, wait behind it before starting — even sync calls become async here,
  // because returning sync `{ok}` while a pending commit is about to stomp
  // the same key would be a lie.
  function applyUpdate(key, value) {
    const commandOnlyError = rejectCommandOnly(key, "applyUpdate");
    if (commandOnlyError) return commandOnlyError;
    const lockKey = resolveUpdateLockKey(key);
    const pending = _asyncLocks.get(lockKey);
    if (pending) {
      const next = pending.then(
        () => _doApplyUpdate(key, value),
        () => _doApplyUpdate(key, value)
      );
      _trackAsyncLock(lockKey, next);
      return next;
    }
    const actionResult = invokeAction(key, value);
    if (!isThenable(actionResult)) {
      return finishSingle(key, value, actionResult);
    }
    const next = actionResult.then((r) => finishSingle(key, value, r));
    _trackAsyncLock(lockKey, next);
    return next;
  }

  function _doApplyUpdate(key, value) {
    const commandOnlyError = rejectCommandOnly(key, "applyUpdate");
    if (commandOnlyError) return commandOnlyError;
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
    // Effect-bearing keys belong on applyUpdate's single-field path: bulk
    // interleaves validators with effects, so a failure on key N leaves
    // keys 0..N-1 with their effects already executed and no rollback
    // hook. Reject at the boundary — callers (menu/runtime state flush)
    // only ever bulk pure-data fields. If a real use case appears, the
    // fix is to run all validators first, then all effects with explicit
    // rollback — not to relax this guard.
    for (const key of Object.keys(partial)) {
      const entry = updates[key];
      const commandOnlyError = rejectCommandOnly(key, "applyBulk");
      if (commandOnlyError) return commandOnlyError;
      if (entry && resolveEffect(entry)) {
        return {
          status: "error",
          message: `${key}: effect-bearing keys cannot be updated via applyBulk — use applyUpdate`,
        };
      }
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
    // Post-validation: re-run validators against the merged snapshot so
    // cross-field constraints (e.g. showTray + showDock) see the combined
    // state, not just the pre-bulk snapshot each individual invoke saw.
    const mergedSnapshot = { ...store.getSnapshot(), ...accumulated };
    const mergedDeps = { ...injectedDeps, snapshot: mergedSnapshot };
    for (const key of Object.keys(accumulated)) {
      const entry = updates[key];
      const validator = entry && resolveValidator(entry);
      if (!validator) continue;
      const recheck = runStep(`${key} post-validate`, validator, accumulated[key], mergedDeps);
      if (isThenable(recheck)) {
        // Async validators in bulk: only the first async key is awaited;
        // remaining keys are skipped. This is acceptable because all current
        // validators are synchronous. If async validators are added later
        // and used in bulk paths, refactor to Promise.all().
        return recheck.then((r) => {
          if (!r || r.status !== "ok") return r;
          return commitBulk(accumulated);
        });
      }
      if (!recheck || recheck.status !== "ok") return recheck;
    }
    return commitBulk(accumulated);
  }

  function commitBulk(accumulated) {
    const currentSnapshot = store.getSnapshot();
    const changedPartial = buildChangedPartial(accumulated, currentSnapshot);
    if (Object.keys(changedPartial).length > 0) {
      const persisted = persistInternal({ ...currentSnapshot, ...changedPartial });
      if (persisted.status !== "ok") return persisted;
      store._commit(changedPartial);
    }
    return { status: "ok" };
  }

  // Import external state into prefs WITHOUT running pre-commit effects.
  // This is the only correct way to push system-backed values (e.g. from
  // `app.getLoginItemSettings()`) into the store. Going through `applyUpdate`
  // would re-run the effect, which writes BACK to the system — harmless but
  // wasteful, and conceptually backwards.
  //
  // Sync-or-Promise like applyBulk. Validators still run; commit is atomic
  // across all keys. Returns the same `{ status, message?, noop? }` shape.
  function hydrate(partial) {
    if (!partial || typeof partial !== "object") {
      return { status: "error", message: "hydrate: partial must be an object" };
    }
    for (const key of Object.keys(partial)) {
      const commandOnlyError = rejectCommandOnly(key, "hydrate");
      if (commandOnlyError) return commandOnlyError;
    }
    const entries = Object.keys(partial).map((key) => ({
      key,
      value: partial[key],
      actionResult: invokeAction(key, partial[key], {
        skipEffect: true,
        allowDuringReadFailure: true,
      }),
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

  // Serialize commands by name/domain — same-name rapid toggles would otherwise
  // race and the later-resolving one would commit over the earlier.
  function applyCommand(name, payload) {
    const lockKey = resolveCommandLockKey(name);
    const prev = _asyncLocks.get(lockKey);
    const run = () => _doApplyCommand(name, payload);
    const next = prev ? prev.then(run, run) : run();
    _trackAsyncLock(lockKey, next);
    return next;
  }

  async function _doApplyCommand(name, payload) {
    const command = commands[name];
    if (!command) {
      return {
        status: "error",
        message: `unknown command: ${name}`,
      };
    }
    if (readFailure) return readFailureResult(`run ${name}`);
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
    // Commands may perform an irreversible pre-commit phase (for example,
    // rotating the mobile access token). If the later defensive validation or
    // persistence step fails, retain that safe phase metadata so the UI can
    // truthfully tell the user that re-pairing is already required. The actual
    // controller error always remains authoritative.
    const { status: _status, message: _message, commit: _phaseCommit, ...phaseMeta } = result;
    const withPhaseMeta = (error) => ({
      ...phaseMeta,
      ...(error || {}),
      status: (error && error.status) || "error",
      message: error && error.message,
    });
    if (result.commit && typeof result.commit === "object") {
      // Defensive validate: commands produce arbitrary commit payloads, but
      // they still have to pass the same schema gates `applyUpdate` enforces.
      // Without this, a buggy command could persist a prefs snapshot the
      // validator would have rejected (e.g. setAgentFlag writing a
      // non-object `agents` field). We re-run the validator against a merged
      // snapshot so cross-field checks (showTray/showDock) see the final
      // state.
      const mergedSnapshot = { ...store.getSnapshot(), ...result.commit };
      const commitDeps = { ...injectedDeps, snapshot: mergedSnapshot };
      for (const key of Object.keys(result.commit)) {
        const entry = updates[key];
        if (!entry) {
          return withPhaseMeta({
            status: "error",
            message: `${name} commit: unknown settings key ${key}`,
          });
        }
        const validator = resolveValidator(entry);
        if (!validator) continue;
        const recheck = runStep(
          `${name} commit validate ${key}`,
          validator,
          result.commit[key],
          commitDeps
        );
        // Validators today are sync — commands are one-shots and defensive
        // validation is meant to be a cheap gate, not an effect pipeline.
        // If a real async validator appears later we can refactor; for now
        // treat it as a programming error.
        if (isThenable(recheck)) {
          return withPhaseMeta({
            status: "error",
            message: `${name} commit ${key}: async validators unsupported in commit path`,
          });
        }
        if (!recheck || recheck.status !== "ok") return withPhaseMeta(recheck);
      }
      const currentSnapshot = store.getSnapshot();
      const changedPartial = buildChangedPartial(result.commit, currentSnapshot);
      if (Object.keys(changedPartial).length > 0) {
        const persisted = persistInternal({
          ...currentSnapshot,
          ...changedPartial,
        });
        if (persisted.status !== "ok") return withPhaseMeta(persisted);
        store._commit(changedPartial);
      }
    }
    // Pass through command-produced metadata (noop / reason / targetDrift /
    // anything a future command needs the IPC layer to see). Strip `commit`
    // since that's a controller-internal payload, not for callers.
    const { commit: _commit, ...meta } = result;
    return { ...meta, status: "ok", message: result.message };
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

  function hasReadFailure() {
    return readFailure;
  }

  function dispose() {
    store.dispose();
  }

  return {
    applyUpdate,
    applyBulk,
    applyCommand,
    hydrate,
    getSnapshot,
    get,
    subscribe,
    subscribeKey,
    persist,
    isLocked,
    hasReadFailure,
    dispose,
  };
}

module.exports = { createSettingsController };
