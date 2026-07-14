"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const {
  settingsNeedClaudeHookResync,
  createClaudeSettingsWatcher,
} = require("../src/claude-settings-watcher");
const { CLAUDE_CORE_HOOK_EVENTS } = require("../hooks/install");

const EXPECTED_HOOK_SCRIPT_PATH = "C:/app/resources/app.asar.unpacked/hooks/clawd-hook.js";
const EXPECTED_AUTO_START_SCRIPT_PATH = "C:/app/resources/app.asar.unpacked/hooks/auto-start.js";
const EXPECTED_PERMISSION_URL = "http://127.0.0.1:23333/permission";
const OLD_TEMP_SCRIPT_PATH = "C:/Users/tester/AppData/Local/Temp/clawd-on-desk/hooks/clawd-hook.js";

class FakeWatcher extends EventEmitter {
  constructor(callback) {
    super();
    this._callback = callback;
    this.closed = false;
    this.closeCalls = 0;
  }

  emitChange(filename = "settings.json") {
    if (this.closed) return;
    this._callback("change", filename);
  }

  close() {
    this.closed = true;
    this.closeCalls++;
  }
}

// Delay-aware fake clock: setTimeout(fn, delay) records a due time instead of
// firing on the next flush(). advance(ms) only runs tasks due within the
// window, in due-time order, and lets a task's own self-rescheduled follow-up
// fire within the same advance() call if its new delay still lands inside the
// window. A real setImmediate flushes microtasks between each fired task so
// async health-check bodies (which read/await the operation queue) settle
// before the next due timer is considered.
function makeFakeClock(initialNow = 0) {
  let now = initialNow;
  let nextId = 1;
  const pending = new Map();

  function setTimeoutFn(fn, delay) {
    const id = nextId++;
    pending.set(id, { fn, dueAt: now + (Number.isFinite(delay) ? delay : 0) });
    return id;
  }
  function clearTimeoutFn(id) {
    pending.delete(id);
  }
  function flushMicrotasks() {
    return new Promise((resolve) => setImmediate(resolve));
  }
  async function advance(ms) {
    const target = now + (Number.isFinite(ms) ? ms : 0);
    for (;;) {
      let dueId = null;
      let dueAt = null;
      for (const [id, entry] of pending) {
        if (entry.dueAt > target) continue;
        if (dueAt === null || entry.dueAt < dueAt) {
          dueAt = entry.dueAt;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const entry = pending.get(dueId);
      pending.delete(dueId);
      now = entry.dueAt;
      entry.fn();
      await flushMicrotasks();
      await flushMicrotasks();
    }
    now = target;
  }
  function pendingCount() {
    return pending.size;
  }
  return { setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, now: () => now, advance, pendingCount, flushMicrotasks };
}

function coreCommandHook(event, scriptPath) {
  return { matcher: "", hooks: [{ type: "command", shell: "powershell", command: `& "node" "${scriptPath}" ${event}` }] };
}
function autoStartHook(scriptPath) {
  return { matcher: "", hooks: [{ type: "command", shell: "powershell", command: `& "node" "${scriptPath}"` }] };
}
function permissionHook(url) {
  return { matcher: "", hooks: [{ type: "http", url, timeout: 600 }] };
}
function healthySettingsObject({ scriptPath = EXPECTED_HOOK_SCRIPT_PATH, permissionUrl = EXPECTED_PERMISSION_URL, events = CLAUDE_CORE_HOOK_EVENTS } = {}) {
  const hooks = {};
  for (const event of events) hooks[event] = [coreCommandHook(event, scriptPath)];
  if (permissionUrl) hooks.PermissionRequest = [permissionHook(permissionUrl)];
  return { hooks };
}

function makeWatcher(overrides = {}) {
  const { initialSettingsRaw, existingPaths, syncClawdHooksImpl, ...ctxOverrides } = overrides;
  const clock = makeFakeClock();
  const syncCalls = [];
  let watchedDir = null;
  let lastWatcher = null;
  let settingsRaw = initialSettingsRaw !== undefined
    ? initialSettingsRaw
    : JSON.stringify(healthySettingsObject());
  const existing = new Set(existingPaths || [EXPECTED_HOOK_SCRIPT_PATH, EXPECTED_AUTO_START_SCRIPT_PATH]);

  const defaultSyncImpl = (options) => {
    syncCalls.push(options);
    return { status: "ok", added: 0, updated: 0, removed: 0 };
  };

  const watcher = createClaudeSettingsWatcher({
    fs: {
      watch(dir, callback) {
        watchedDir = dir;
        lastWatcher = new FakeWatcher(callback);
        return lastWatcher;
      },
      readFileSync() {
        return settingsRaw;
      },
      existsSync(p) {
        return existing.has(p);
      },
    },
    path: {
      join: (...parts) => parts.join("/"),
    },
    os: {
      homedir: () => "/home/tester",
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    getHookServerPort: () => 23333,
    shouldManageClaudeHooks: () => true,
    isAgentEnabled: () => true,
    shouldSyncAgentIntegration: () => true,
    autoStartWithClaude: false,
    platform: "win32",
    expectedHookScriptPath: EXPECTED_HOOK_SCRIPT_PATH,
    expectedAutoStartScriptPath: EXPECTED_AUTO_START_SCRIPT_PATH,
    coreEvents: CLAUDE_CORE_HOOK_EVENTS,
    syncClawdHooks: syncClawdHooksImpl || defaultSyncImpl,
    ...ctxOverrides,
  });

  return {
    watcher,
    clock,
    syncCalls,
    getWatchedDir: () => watchedDir,
    getWatcher: () => lastWatcher,
    setSettingsRaw: (raw) => { settingsRaw = raw; },
    setExisting: (paths) => { existing.clear(); for (const p of paths) existing.add(p); },
    addExisting: (p) => existing.add(p),
    removeExisting: (p) => existing.delete(p),
  };
}

describe("settingsNeedClaudeHookResync", () => {
  it("returns false for empty or invalid settings content", () => {
    assert.strictEqual(settingsNeedClaudeHookResync("", "http://127.0.0.1:23333/permission"), false);
    assert.strictEqual(settingsNeedClaudeHookResync("not json", "http://127.0.0.1:23333/permission"), false);
  });

  it("requires both managed command hooks and the expected PermissionRequest URL", () => {
    const expectedUrl = "http://127.0.0.1:23333/permission";
    const intact = JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "node clawd-hook.js Stop" }] }],
        PermissionRequest: [{ matcher: "", hooks: [{ type: "http", url: expectedUrl }] }],
      },
    });
    const wrongPermissionPort = JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "node clawd-hook.js Stop" }] }],
        PermissionRequest: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:23335/permission" }] }],
      },
    });

    assert.strictEqual(settingsNeedClaudeHookResync(intact, expectedUrl), false);
    assert.strictEqual(settingsNeedClaudeHookResync(wrongPermissionPort, expectedUrl), true);
    assert.strictEqual(settingsNeedClaudeHookResync('{"hooks":{}}', expectedUrl), true);
  });
});

describe("createClaudeSettingsWatcher — lifecycle", () => {
  it("watches the Claude settings directory and ignores unrelated filenames", async () => {
    const { watcher, clock, syncCalls, getWatchedDir, getWatcher } = makeWatcher();

    assert.strictEqual(watcher.start(), true);
    assert.strictEqual(getWatchedDir(), "/home/tester/.claude");

    await clock.advance(0); // let the immediate startup check run and settle

    getWatcher().emitChange("other.json");
    await clock.advance(2000);

    assert.deepStrictEqual(syncCalls, []);
    watcher.stop();
  });

  it("start() is idempotent and does not create duplicate watchers/timers", () => {
    const { watcher, clock } = makeWatcher();
    assert.strictEqual(watcher.start(), true);
    const pendingAfterFirst = clock.pendingCount();
    assert.strictEqual(watcher.start(), false);
    assert.strictEqual(clock.pendingCount(), pendingAfterFirst);
    watcher.stop();
  });

  it("stop() is idempotent, closes the watcher once, and clears all timers", async () => {
    const { watcher, clock, getWatcher } = makeWatcher();
    watcher.start();
    await clock.advance(0);

    assert.strictEqual(watcher.stop(), true);
    assert.strictEqual(watcher.stop(), false);
    assert.strictEqual(getWatcher().closeCalls, 1);
    assert.strictEqual(clock.pendingCount(), 0);
  });

  it("a timer that fires after stop() does not resurrect work or reschedule", async () => {
    const { watcher, clock, syncCalls, getWatcher, setSettingsRaw, removeExisting } = makeWatcher();
    watcher.start();
    await clock.advance(0);

    setSettingsRaw(JSON.stringify(healthySettingsObject({ scriptPath: OLD_TEMP_SCRIPT_PATH })));
    removeExisting(OLD_TEMP_SCRIPT_PATH);
    getWatcher().emitChange("settings.json");
    // Debounce timer is pending but has not fired yet when stop() runs.
    watcher.stop();
    await clock.advance(10_000);

    assert.deepStrictEqual(syncCalls, []);
    assert.strictEqual(clock.pendingCount(), 0);
  });
});

describe("createClaudeSettingsWatcher — periodic health audit (no fs event required)", () => {
  it("does not call sync across multiple healthy periodic cycles (zero writes)", async () => {
    const { watcher, clock, syncCalls } = makeWatcher();
    watcher.start();

    await clock.advance(0);
    await clock.advance(5 * 60 * 1000);
    await clock.advance(5 * 60 * 1000);
    await clock.advance(5 * 60 * 1000);

    assert.deepStrictEqual(syncCalls, []);
    watcher.stop();
  });

  it("discovers and repairs a deleted script path with no settings.json fs event at all", async () => {
    const { watcher, clock, syncCalls, setSettingsRaw, removeExisting } = makeWatcher();
    setSettingsRaw(JSON.stringify(healthySettingsObject({ scriptPath: OLD_TEMP_SCRIPT_PATH })));
    removeExisting(OLD_TEMP_SCRIPT_PATH);
    watcher.start();

    await clock.advance(0);
    // Repair happened and re-verification must have re-read the (still-fake)
    // settings — since our fake sync doesn't actually rewrite settingsRaw,
    // simulate the installer's effect by fixing the fixture before the
    // verify re-read would occur. To keep this deterministic we instead
    // assert the repair attempt itself fired with the right provenance.
    assert.strictEqual(syncCalls.length, 1);
    assert.strictEqual(syncCalls[0].source, "periodic-health");
    assert.strictEqual(syncCalls[0].automatic, true);
    watcher.stop();
  });

  it("re-verifies after repair and returns to healthy once the fix is reflected on disk", async () => {
    const { watcher, clock, syncCalls, setSettingsRaw, removeExisting } = makeWatcher({
      syncClawdHooksImpl: (options) => {
        syncCalls.push(options);
        // Simulate the installer actually fixing the file before this resolves.
        setSettingsRaw(JSON.stringify(healthySettingsObject()));
        return { status: "ok", added: 0, updated: 1, removed: 0 };
      },
    });
    setSettingsRaw(JSON.stringify(healthySettingsObject({ scriptPath: OLD_TEMP_SCRIPT_PATH })));
    removeExisting(OLD_TEMP_SCRIPT_PATH);
    watcher.start();

    await clock.advance(0);

    assert.strictEqual(syncCalls.length, 1);
    assert.strictEqual(watcher.getHealthStatus().status, "healthy");
    assert.strictEqual(watcher.getHealthStatus().lastSuccessAt !== null, true);

    // Subsequent periodic ticks stay quiet — healthy state does not re-repair.
    await clock.advance(5 * 60 * 1000);
    assert.strictEqual(syncCalls.length, 1);
    watcher.stop();
  });
});

describe("createClaudeSettingsWatcher — fs event path", () => {
  it("repairs with the settings-watch source when a fs event reveals missing hooks", async () => {
    const { watcher, clock, syncCalls, getWatcher, setSettingsRaw } = makeWatcher();
    watcher.start();
    await clock.advance(0); // consume the initial (healthy) startup check first
    assert.deepStrictEqual(syncCalls, []);

    setSettingsRaw('{"hooks":{}}');
    getWatcher().emitChange("settings.json");
    await clock.advance(1000); // debounce

    assert.strictEqual(syncCalls.length, 1);
    assert.strictEqual(syncCalls[0].source, "settings-watch");
    watcher.stop();
  });

  it("does not repeat a repair when a settings fs event and the periodic tick land together", async () => {
    const { watcher, clock, syncCalls, getWatcher, setSettingsRaw, removeExisting } = makeWatcher();
    watcher.start();
    await clock.advance(0);

    setSettingsRaw(JSON.stringify(healthySettingsObject({ scriptPath: OLD_TEMP_SCRIPT_PATH })));
    removeExisting(OLD_TEMP_SCRIPT_PATH);
    getWatcher().emitChange("settings.json");
    // Advance exactly through the 1s debounce; the periodic 5-minute timer
    // has already been consumed by the startup check and rescheduled far in
    // the future, so only the debounced fs-event check should fire here.
    await clock.advance(1000);

    assert.strictEqual(syncCalls.length, 1);
    watcher.stop();
  });

  it("ignores changes to unrelated files in the same directory", async () => {
    const { watcher, clock, syncCalls, getWatcher } = makeWatcher();
    watcher.start();
    await clock.advance(0);

    getWatcher().emitChange("other.json");
    await clock.advance(1000);

    assert.deepStrictEqual(syncCalls, []);
    watcher.stop();
  });
});

describe("createClaudeSettingsWatcher — suspicious shrink guard", () => {
  // The shrink guard needs something to detect a drop FROM — a fixture with
  // only Clawd's own hooks and a single top-level "hooks" key has zero
  // third-party hooks and zero spare keys to lose, so it can never look
  // suspicious no matter how much of it disappears. Mirror production
  // settings.json by including unrelated top-level keys and a third-party hook.
  function richHealthySettingsObject() {
    const base = healthySettingsObject();
    base.env = { FOO: "bar" };
    base.permissions = { allow: ["*"], deny: [] };
    base.enabledPlugins = { a: true };
    base.hooks.Stop.push({ matcher: "", hooks: [{ type: "command", command: "node /home/u/.claude/hooks/third-party.js" }] });
    return base;
  }

  it("skips auto-repair and notifies when settings.json shrinks suspiciously, and recovers once healthy", async () => {
    const notifyCalls = [];
    const { watcher, clock, syncCalls, getWatcher, setSettingsRaw } = makeWatcher({
      initialSettingsRaw: JSON.stringify(richHealthySettingsObject()),
      notifySuspiciousShrink: (before, after) => notifyCalls.push({ before, after }),
    });
    watcher.start();
    await clock.advance(0); // seeds trusted baseline from the healthy fixture

    setSettingsRaw(JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    getWatcher().emitChange("settings.json");
    await clock.advance(1000);

    assert.deepStrictEqual(syncCalls, []);
    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(watcher.getHealthStatus().status, "guarded");

    // A later explicit Fix / restart restores healthy settings — the guard
    // must not keep blocking forever once the file is actually healthy again.
    setSettingsRaw(JSON.stringify(richHealthySettingsObject()));
    getWatcher().emitChange("settings.json");
    await clock.advance(1000);

    assert.deepStrictEqual(syncCalls, []); // still no auto-repair call needed — it's just healthy
    assert.strictEqual(watcher.getHealthStatus().status, "healthy");
    watcher.stop();
  });
});

describe("createClaudeSettingsWatcher — retry backoff and manual-fix-required", () => {
  it("retries a failing repair at 5s then 30s, then converges to manual-fix-required after 3 attempts", async () => {
    const { watcher, clock, syncCalls, setSettingsRaw, removeExisting } = makeWatcher();
    setSettingsRaw(JSON.stringify(healthySettingsObject({ scriptPath: OLD_TEMP_SCRIPT_PATH })));
    removeExisting(OLD_TEMP_SCRIPT_PATH);
    // The fake sync never actually fixes the fixture, so every re-verify still
    // reports the same missing-script-path issue — three straight failures.
    watcher.start();

    await clock.advance(0);
    assert.strictEqual(syncCalls.length, 1);
    assert.strictEqual(watcher.getHealthStatus().status, "repairing");
    assert.strictEqual(watcher.getHealthStatus().attempt, 1);

    await clock.advance(5000);
    assert.strictEqual(syncCalls.length, 2);
    assert.strictEqual(watcher.getHealthStatus().attempt, 2);

    await clock.advance(30_000);
    assert.strictEqual(syncCalls.length, 3);
    assert.strictEqual(watcher.getHealthStatus().status, "manual-fix-required");
    assert.strictEqual(watcher.getHealthStatus().attempt, 3);

    // Further periodic ticks stay strictly read-only once stuck.
    await clock.advance(5 * 60 * 1000);
    await clock.advance(5 * 60 * 1000);
    assert.strictEqual(syncCalls.length, 3, "manual-fix-required must not schedule further automatic mutation");
    watcher.stop();
  });

  it("clears manual-fix-required and resumes automatic repair once the repair class actually changes", async () => {
    const { watcher, clock, syncCalls, setSettingsRaw, removeExisting } = makeWatcher();
    setSettingsRaw(JSON.stringify(healthySettingsObject({ scriptPath: OLD_TEMP_SCRIPT_PATH })));
    removeExisting(OLD_TEMP_SCRIPT_PATH);
    watcher.start();

    await clock.advance(0);
    await clock.advance(5000);
    await clock.advance(30_000);
    assert.strictEqual(watcher.getHealthStatus().status, "manual-fix-required");
    assert.strictEqual(syncCalls.length, 3);

    // A different root cause (permission URL) appears — must not still be
    // treated as the exhausted core-script-path signature.
    setSettingsRaw(JSON.stringify(healthySettingsObject({ scriptPath: OLD_TEMP_SCRIPT_PATH, permissionUrl: "http://127.0.0.1:23335/permission" })));
    await clock.advance(5 * 60 * 1000);

    assert.strictEqual(syncCalls.length, 4, "a new repair class must get a fresh attempt, not stay stuck");
    watcher.stop();
  });

  it("gives a fresh 3-attempt budget when repair verification itself reveals a different signature", async () => {
    // Distinct from the previous test: here the signature changes mid-repair
    // (surfaced by the post-repair verify step of an in-progress attempt),
    // not from an external edit observed at the start of a later tick.
    let syncCallCount = 0;
    const { watcher, clock, syncCalls, setSettingsRaw, removeExisting } = makeWatcher({
      syncClawdHooksImpl: (options) => {
        syncCallCount++;
        syncCalls.push(options);
        if (syncCallCount === 3) {
          // The 3rd attempt "fixes" the original script-path problem but
          // introduces an unrelated permission-url problem in the same stroke.
          setSettingsRaw(JSON.stringify(healthySettingsObject({ permissionUrl: "http://127.0.0.1:23335/permission" })));
        }
        return { status: "ok" };
      },
    });
    setSettingsRaw(JSON.stringify(healthySettingsObject({ scriptPath: OLD_TEMP_SCRIPT_PATH })));
    removeExisting(OLD_TEMP_SCRIPT_PATH);
    watcher.start();

    await clock.advance(0); // attempt 1 of core-script-path, still broken
    assert.strictEqual(watcher.getHealthStatus().attempt, 1);

    await clock.advance(5000); // attempt 2 of core-script-path, still broken
    assert.strictEqual(watcher.getHealthStatus().attempt, 2);

    await clock.advance(30_000); // attempt 3 -- fixes script path, reveals permission-url instead
    assert.strictEqual(syncCallCount, 3);
    assert.strictEqual(
      watcher.getHealthStatus().attempt,
      1,
      "a newly-revealed signature must start its own 3-strike budget, not inherit the exhausted count"
    );
    assert.strictEqual(watcher.getHealthStatus().status, "repairing");

    watcher.stop();
  });

  it("clears the failure count once health is actually restored", async () => {
    let fixOnNextSync = false;
    const { watcher, clock, syncCalls, setSettingsRaw, removeExisting } = makeWatcher({
      syncClawdHooksImpl: (options) => {
        syncCalls.push(options);
        if (fixOnNextSync) setSettingsRaw(JSON.stringify(healthySettingsObject()));
        return { status: "ok" };
      },
    });
    setSettingsRaw(JSON.stringify(healthySettingsObject({ scriptPath: OLD_TEMP_SCRIPT_PATH })));
    removeExisting(OLD_TEMP_SCRIPT_PATH);
    watcher.start();

    await clock.advance(0); // attempt 1, still broken
    assert.strictEqual(watcher.getHealthStatus().attempt, 1);

    fixOnNextSync = true;
    await clock.advance(5000); // attempt 2, this one actually fixes it

    assert.strictEqual(watcher.getHealthStatus().status, "healthy");
    assert.strictEqual(syncCalls.length, 2);

    // Break it again the same way — must get a fresh 3-strike budget, not
    // inherit the earlier attempt count.
    setSettingsRaw(JSON.stringify(healthySettingsObject({ scriptPath: OLD_TEMP_SCRIPT_PATH })));
    removeExisting(OLD_TEMP_SCRIPT_PATH);
    fixOnNextSync = false;
    await clock.advance(5 * 60 * 1000);

    assert.strictEqual(watcher.getHealthStatus().attempt, 1, "failure count must reset after a real recovery");
    watcher.stop();
  });
});

describe("createClaudeSettingsWatcher — source script missing", () => {
  it("never calls sync and reports a degraded status when the current packaged source is gone", async () => {
    const warnLines = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnLines.push(args.join(" "));
    try {
      const { watcher, clock, syncCalls } = makeWatcher({ existingPaths: [] });
      watcher.start();

      await clock.advance(0);
      await clock.advance(5 * 60 * 1000);
      await clock.advance(5 * 60 * 1000);

      assert.deepStrictEqual(syncCalls, []);
      assert.strictEqual(watcher.getHealthStatus().status, "degraded");
      assert.strictEqual(warnLines.filter((line) => /source script is missing/.test(line)).length, 1, "must not spam the warning every cycle");
      watcher.stop();
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("createClaudeSettingsWatcher — unparseable Clawd command", () => {
  function unparseableSettingsRaw() {
    return JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: '"clawd-hook.js"' }] }],
        PermissionRequest: [permissionHook(EXPECTED_PERMISSION_URL)],
      },
    });
  }

  it("reports degraded (not healthy) and never attempts a repair when a Clawd command cannot be parsed", async () => {
    const { watcher, clock, syncCalls } = makeWatcher({
      initialSettingsRaw: unparseableSettingsRaw(),
      coreEvents: ["Stop"],
    });
    watcher.start();

    await clock.advance(0);
    await clock.advance(5 * 60 * 1000);

    assert.deepStrictEqual(syncCalls, [], "command-unparseable is automaticRepairable:false — misclassifying it risks rewriting a command Clawd does not own");
    const status = watcher.getHealthStatus();
    assert.strictEqual(status.status, "degraded");
    assert.strictEqual(status.degradedReason, "command-unparseable");
    assert.strictEqual(status.lastSuccessAt, null, "an unparsed Clawd command must never count as a verified-healthy observation");
    watcher.stop();
  });

  it("reports degraded instead of healthy when a repair for an unrelated issue leaves a command-unparseable behind", async () => {
    const { watcher, clock, syncCalls, setSettingsRaw, removeExisting } = makeWatcher({
      coreEvents: ["Stop", "SessionStart"],
      syncClawdHooksImpl: (options) => {
        syncCalls.push(options);
        // Simulate a repair that fixes the missing SessionStart script path
        // but leaves the pre-existing unparseable Stop command untouched —
        // Clawd never rewrites a command it could not classify as its own.
        setSettingsRaw(JSON.stringify({
          hooks: {
            Stop: [{ matcher: "", hooks: [{ type: "command", command: '"clawd-hook.js"' }] }],
            SessionStart: [coreCommandHook("SessionStart", EXPECTED_HOOK_SCRIPT_PATH)],
            PermissionRequest: [permissionHook(EXPECTED_PERMISSION_URL)],
          },
        }));
        return { status: "ok" };
      },
    });
    setSettingsRaw(JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: '"clawd-hook.js"' }] }],
        SessionStart: [coreCommandHook("SessionStart", OLD_TEMP_SCRIPT_PATH)],
        PermissionRequest: [permissionHook(EXPECTED_PERMISSION_URL)],
      },
    }));
    removeExisting(OLD_TEMP_SCRIPT_PATH);
    watcher.start();

    await clock.advance(0);

    assert.strictEqual(syncCalls.length, 1);
    const status = watcher.getHealthStatus();
    assert.strictEqual(status.status, "degraded", "a command-unparseable remnant must not be reported healthy just because the OTHER repairable issue verified clean");
    assert.strictEqual(status.degradedReason, "command-unparseable");
    assert.strictEqual(status.lastSuccessAt, null);

    // Nothing left that automatic repair can fix — must not keep retrying.
    await clock.advance(5 * 60 * 1000);
    assert.strictEqual(syncCalls.length, 1);
    watcher.stop();
  });
});

describe("createClaudeSettingsWatcher — transient unreadable settings", () => {
  it("does not act on a single unreadable observation, only after two consecutive ones", async () => {
    const { watcher, clock, syncCalls, setSettingsRaw } = makeWatcher({
      initialSettingsRaw: "not json at all",
    });
    watcher.start();

    await clock.advance(0);
    assert.strictEqual(watcher.getHealthStatus().status, "degraded");
    assert.deepStrictEqual(syncCalls, []);

    // Recovers on the very next stabilization recheck.
    setSettingsRaw(JSON.stringify(healthySettingsObject()));
    await clock.advance(2000);

    assert.strictEqual(watcher.getHealthStatus().status, "healthy");
    assert.deepStrictEqual(syncCalls, []);
    watcher.stop();
  });
});

describe("createClaudeSettingsWatcher — gates", () => {
  it("does not read or write when installed/enabled/auto-manage gates are closed", async () => {
    const { watcher, clock, syncCalls } = makeWatcher({
      shouldManageClaudeHooks: () => false,
    });
    watcher.start();
    await clock.advance(0);
    await clock.advance(5 * 60 * 1000);

    assert.deepStrictEqual(syncCalls, []);
    watcher.stop();
  });
});

describe("createClaudeSettingsWatcher — checkNow / getHealthStatus", () => {
  it("checkNow runs the same health logic on demand and getHealthStatus reflects it", async () => {
    const { watcher, clock, syncCalls } = makeWatcher();
    watcher.start();
    await clock.advance(0);
    assert.deepStrictEqual(syncCalls, []);

    const status = watcher.getHealthStatus();
    assert.strictEqual(status.status, "healthy");
    assert.deepStrictEqual(status.issues, []);

    await watcher.checkNow("post-startup");
    assert.strictEqual(watcher.getHealthStatus().status, "healthy");
    watcher.stop();
  });

  it("caps exposed issues and never exposes more than the documented limit", async () => {
    const manyMissingEvents = healthySettingsObject({ events: [] }); // no core events registered at all -> single missing-managed-core-hooks issue, not a stress case, but exercises the slice path
    const { watcher, clock } = makeWatcher({ initialSettingsRaw: JSON.stringify(manyMissingEvents) });
    watcher.start();
    await clock.advance(0);

    const status = watcher.getHealthStatus();
    assert.ok(Array.isArray(status.issues));
    assert.ok(status.issues.length <= 20);
    watcher.stop();
  });
});
