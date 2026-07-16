"use strict";

// Server-owned, instance-level serialization primitive for every process-internal
// mutation of ~/.claude/settings.json (register/unregister hooks, statusline,
// auto-start). Concurrent read-modify-write from the fs watcher, periodic health
// audit, Settings actions, and Doctor would otherwise race and clobber each
// other; this queue guarantees at most one such operation is in flight at a
// time, in FIFO order.
//
// Deliberately NOT a module-level singleton: multiple server runtimes within
// one process (and tests, which create many) must get independent queues that
// never observe each other's operations. See src/server.js for the single
// instance created per running server and the business-level wrappers
// (syncClawdHooks, setClaudeAutoStart, uninstallClaudeHooks) built on top.

function createClaudeHookOperations(options = {}) {
  const shouldRunAutomatic = typeof options.shouldRunAutomatic === "function"
    ? options.shouldRunAutomatic
    : () => true;

  let tail = Promise.resolve();
  let disposed = false;

  /**
   * @param {{ source?: string, automatic?: boolean }} meta
   * @param {() => Promise<any>} task
   * @returns {Promise<any>} always resolves (never rejects) with either the
   *   task's own result or a { status: "error" | "skipped", ... } object.
   */
  function enqueue(meta, task) {
    const info = meta && typeof meta === "object" ? meta : {};
    const source = info.source || null;
    const automatic = info.automatic === true;

    if (disposed) {
      return Promise.resolve({ status: "error", message: "Claude hook operation queue disposed", source });
    }

    const run = async () => {
      // Re-check disposal/gate right before this operation actually executes —
      // not at enqueue time — so a user disabling Claude or turning off
      // auto-manage while this task was waiting behind an earlier one takes
      // effect immediately instead of one operation late.
      if (disposed) {
        return { status: "error", message: "Claude hook operation queue disposed", source };
      }
      if (automatic && !shouldRunAutomatic()) {
        return { status: "skipped", reason: "gate-closed", source };
      }
      try {
        return await task();
      } catch (err) {
        return { status: "error", message: err && err.message ? err.message : String(err), source };
      }
    };

    // Chain on both branches so one operation's failure can never leave the
    // tail permanently rejected and block everything queued after it.
    const settled = tail.then(run, run);
    tail = settled;
    return settled;
  }

  function dispose() {
    disposed = true;
  }

  function isDisposed() {
    return disposed;
  }

  return { enqueue, dispose, isDisposed };
}

module.exports = { createClaudeHookOperations };
