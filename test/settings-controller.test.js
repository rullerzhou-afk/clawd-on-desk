"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const prefs = require("../src/prefs");
const { createSettingsController } = require("../src/settings-controller");

const tempDirs = [];
function makeTempPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-controller-"));
  tempDirs.push(dir);
  return path.join(dir, "clawd-prefs.json");
}
afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("createSettingsController construction", () => {
  it("requires prefsPath or loadResult", () => {
    assert.throws(() => createSettingsController({}), /prefsPath or loadResult/);
  });

  it("loads defaults from missing file", () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    assert.strictEqual(ctrl.get("lang"), "en");
    assert.strictEqual(ctrl.get("soundMuted"), false);
    assert.strictEqual(ctrl.isLocked(), false);
  });

  it("respects locked state from future-version files", () => {
    const p = makeTempPath();
    fs.writeFileSync(p, JSON.stringify({ version: 999 }));
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const ctrl = createSettingsController({ prefsPath: p });
      assert.strictEqual(ctrl.isLocked(), true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("applyUpdate sync invariant", () => {
  it("sync action: returns a plain object, NOT a Promise, and the next sync read sees the new value", () => {
    // This is the contract that lets `ctx.lang = "zh"` work in sync menu setters
    // without microtask deferral. If applyUpdate were `async`, the commit
    // would slip past the next read on the same tick.
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(typeof r.then, "undefined", "sync action must return plain object");
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("lang"), "zh", "sync read after sync update sees new value");
  });

  it("async action: returns a Promise resolving to the same shape", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        lazy: async (v) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return typeof v === "string" ? { status: "ok" } : { status: "error", message: "bad" };
        },
      },
    });
    const ret = ctrl.applyUpdate("lazy", "hello");
    assert.strictEqual(typeof ret.then, "function", "async action must return a Promise");
    const r = await ret;
    assert.strictEqual(r.status, "ok");
  });

  it("serializes concurrent async updates on the same key (no race)", async () => {
    // Two rapid toggles on an async-effect key must run in order — otherwise
    // the slow one resolves last and stomps the quick one's commit.
    const order = [];
    let tick = 0;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        lang: requireEnumSync(),
        size: {
          validate: () => ({ status: "ok" }),
          effect: async (v) => {
            const mine = ++tick;
            order.push(`start:${mine}:${v}`);
            // First call takes longer, so without the lock it'd finish
            // after the second and overwrite the store.
            await new Promise((r) => setTimeout(r, mine === 1 ? 25 : 1));
            order.push(`end:${mine}:${v}`);
            return { status: "ok" };
          },
        },
      },
    });
    const first = ctrl.applyUpdate("size", "S");
    const second = ctrl.applyUpdate("size", "M");
    await Promise.all([first, second]);
    assert.deepStrictEqual(order, ["start:1:S", "end:1:S", "start:2:M", "end:2:M"]);
    assert.strictEqual(ctrl.get("size"), "M");
  });
});

// Tiny helper — must be sync because controller's applyUpdate stays sync
// when the entry is a plain function.
function requireEnumSync() {
  return (v) => (typeof v === "string" ? { status: "ok" } : { status: "error" });
}

describe("applyUpdate", () => {
  it("commits valid pure-data updates and persists to disk", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const r = await ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("lang"), "zh");
    // Persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(onDisk.lang, "zh");
  });

  it("rejects invalid values without touching the store", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const r = await ctrl.applyUpdate("lang", "klingon");
    assert.strictEqual(r.status, "error");
    assert.strictEqual(ctrl.get("lang"), "en");
    // File should not exist (no commit, no persist)
    assert.strictEqual(fs.existsSync(p), false);
  });

  it("returns noop:true when value is unchanged (no broadcast, no fsync)", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    let broadcasts = 0;
    ctrl.subscribe(() => broadcasts++);
    await ctrl.applyUpdate("lang", "zh"); // changes
    assert.strictEqual(broadcasts, 1);
    const r = await ctrl.applyUpdate("lang", "zh"); // same value
    assert.strictEqual(r.noop, true);
    assert.strictEqual(broadcasts, 1, "no second broadcast");
  });

  it("rejects unknown keys", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.applyUpdate("nonsense", true);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /unknown settings key/);
  });

  it("enforces cross-field constraints (showTray/showDock)", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    // Both default true; turning one off is allowed
    const r1 = await ctrl.applyUpdate("showTray", false);
    assert.strictEqual(r1.status, "ok");
    // Now showTray=false, showDock=true. Turning showDock off should fail.
    const r2 = await ctrl.applyUpdate("showDock", false);
    assert.strictEqual(r2.status, "error");
    assert.strictEqual(ctrl.get("showDock"), true);
  });

  it("propagates async action errors as { status: error }", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        boom: async () => { throw new Error("kaboom"); },
      },
    });
    const r = await ctrl.applyUpdate("boom", "anything");
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /kaboom/);
  });

  it("does not commit autoStartWithClaude when management-disabled effect returns noop", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      loadResult: {
        snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: false, autoStartWithClaude: false },
        locked: false,
      },
      injectedDeps: {
        installAutoStart: () => { throw new Error("should not run"); },
        uninstallAutoStart: () => { throw new Error("should not run"); },
      },
    });
    const r = await ctrl.applyUpdate("autoStartWithClaude", true);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.noop, true);
    assert.strictEqual(ctrl.get("autoStartWithClaude"), false);
  });
});

describe("applyBulk", () => {
  it("commits multiple fields atomically and broadcasts once", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    let broadcasts = 0;
    let lastChanges = null;
    ctrl.subscribe(({ changes }) => { broadcasts++; lastChanges = changes; });
    const r = await ctrl.applyBulk({ x: 100, y: 200, lang: "zh" });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(broadcasts, 1);
    assert.deepStrictEqual(lastChanges, { x: 100, y: 200, lang: "zh" });
    assert.strictEqual(ctrl.get("x"), 100);
    assert.strictEqual(ctrl.get("y"), 200);
    assert.strictEqual(ctrl.get("lang"), "zh");
  });

  it("rejects the entire bulk if any field fails validation", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.applyBulk({ x: 100, lang: "klingon" });
    assert.strictEqual(r.status, "error");
    // Neither field committed
    assert.strictEqual(ctrl.get("x"), 0);
    assert.strictEqual(ctrl.get("lang"), "en");
  });

  it("returns noop:true when nothing changed", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.applyBulk({ lang: "en", soundMuted: false });
    assert.strictEqual(r.noop, true);
  });

  it("rejects bulk that would violate cross-field constraints (showTray + showDock)", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    // Both start true. Trying to set both false in a single bulk should be
    // caught by post-validation even though each individual validator only
    // sees the pre-bulk snapshot.
    const r = await ctrl.applyBulk({ showTray: false, showDock: false });
    assert.strictEqual(r.status, "error");
    // Neither field committed — store still has both true
    assert.strictEqual(ctrl.get("showTray"), true);
    assert.strictEqual(ctrl.get("showDock"), true);
  });

  it("allows bulk with only one of showTray/showDock set to false", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.applyBulk({ showTray: false });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("showTray"), false);
    assert.strictEqual(ctrl.get("showDock"), true);
  });

  it("rejects effect-bearing keys to protect the no-rollback commit path", async () => {
    // applyBulk interleaves validators with effects; if a later key fails,
    // earlier effects have already executed. Callers should reach for
    // applyUpdate for system-backed keys. Enforced at the boundary so a
    // future bulk-window-bounds flush can't quietly sneak in a login item.
    let effectRan = false;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        x: (v) => (typeof v === "number" ? { status: "ok" } : { status: "error" }),
        dangerous: {
          validate: (v) => (typeof v === "boolean" ? { status: "ok" } : { status: "error" }),
          effect: () => {
            effectRan = true;
            return { status: "ok" };
          },
        },
      },
    });
    const r = await ctrl.applyBulk({ x: 100, dangerous: true });
    assert.strictEqual(r.status, "error");
    assert.ok(/applyBulk|applyUpdate/.test(r.message));
    assert.strictEqual(effectRan, false, "effect must not run on rejected bulk");
  });
});

describe("applyCommand", () => {
  it("rejects unknown commands", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.applyCommand("nope", {});
    assert.strictEqual(r.status, "error");
  });

  it("commits side-effect commands that return a `commit` field", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: {
        myCmd: async (payload) => ({
          status: "ok",
          commit: { lang: payload.lang },
        }),
      },
    });
    const r = await ctrl.applyCommand("myCmd", { lang: "zh" });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("lang"), "zh");
  });

  it("propagates command errors", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: {
        boom: () => ({ status: "error", message: "denied" }),
      },
    });
    const r = await ctrl.applyCommand("boom", {});
    assert.strictEqual(r.status, "error");
    assert.strictEqual(r.message, "denied");
  });

  it("defensive-validates commit payloads against the updateRegistry", async () => {
    // A buggy command could return an invalid commit; without the guard,
    // that shape would land in the store and persist to disk.
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: {
        naughty: () => ({ status: "ok", commit: { lang: "klingon" } }),
      },
    });
    const r = await ctrl.applyCommand("naughty", {});
    assert.strictEqual(r.status, "error");
    assert.ok(/klingon|lang/.test(r.message));
    // Store must remain at the default (unchanged)
    assert.strictEqual(ctrl.get("lang"), "en");
  });

  it("rejects commit keys unknown to the updateRegistry", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: {
        writeJunk: () => ({ status: "ok", commit: { notARealKey: 42 } }),
      },
    });
    const r = await ctrl.applyCommand("writeJunk", {});
    assert.strictEqual(r.status, "error");
    assert.ok(/notARealKey/.test(r.message));
  });

  it("serializes same-name commands so later calls see earlier effects", async () => {
    // Without per-key locking, two async calls could race and the
    // later-resolving effect would commit over the earlier one.
    const order = [];
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: {
        slow: async (payload) => {
          order.push(`start:${payload.tag}`);
          await new Promise((r) => setTimeout(r, payload.tag === "a" ? 20 : 1));
          order.push(`end:${payload.tag}`);
          return { status: "ok" };
        },
      },
    });
    const a = ctrl.applyCommand("slow", { tag: "a" });
    const b = ctrl.applyCommand("slow", { tag: "b" });
    await Promise.all([a, b]);
    assert.deepStrictEqual(order, ["start:a", "end:a", "start:b", "end:b"]);
  });

  it("applies uninstallHooks commit without clearing latent autoStartWithClaude preference", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      loadResult: {
        snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: true, autoStartWithClaude: true },
        locked: false,
      },
      commands: {
        uninstallHooks: () => ({ status: "ok", commit: { manageClaudeHooksAutomatically: false } }),
      },
    });
    const r = await ctrl.applyCommand("uninstallHooks", null);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("manageClaudeHooksAutomatically"), false);
    assert.strictEqual(ctrl.get("autoStartWithClaude"), true);
  });

  it("applies setSessionAlias through the default command registry and persists it", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({
      prefsPath: p,
      injectedDeps: {
        now: () => 1000,
        getActiveSessionAliasKeys: () => new Set(["local|codex|s1"]),
      },
    });

    const r = await ctrl.applyCommand("setSessionAlias", {
      host: null,
      agentId: "codex",
      sessionId: "s1",
      alias: "Codex main",
    });

    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(ctrl.get("sessionAliases"), {
      "local|codex|s1": { title: "Codex main", updatedAt: 1000 },
    });
    const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.deepStrictEqual(onDisk.sessionAliases, {
      "local|codex|s1": { title: "Codex main", updatedAt: 1000 },
    });
  });
});

describe("subscribe / subscribeKey", () => {
  it("subscribeKey only fires for matching key changes", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    let langCalls = 0;
    let langValue = null;
    ctrl.subscribeKey("lang", (val) => { langCalls++; langValue = val; });
    await ctrl.applyUpdate("soundMuted", true); // unrelated
    assert.strictEqual(langCalls, 0);
    await ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(langCalls, 1);
    assert.strictEqual(langValue, "zh");
  });

  it("multiple subscribers all fire on the same change", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    let a = 0, b = 0;
    ctrl.subscribe(() => a++);
    ctrl.subscribe(() => b++);
    await ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 1);
  });

  it("does not death-loop when a subscriber re-reads the snapshot", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    let calls = 0;
    ctrl.subscribe(() => {
      calls++;
      // Simulate a "re-save" that would cause a death loop in a naive store
      ctrl.persist();
    });
    await ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(calls, 1);
  });
});

describe("object-form entries (validate + effect pre-commit gate)", () => {
  it("runs validate then effect; commits only after both succeed", async () => {
    let effectCalls = 0;
    let lastEffectValue = null;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        gated: {
          validate: (v) => typeof v === "boolean"
            ? { status: "ok" }
            : { status: "error", message: "must be boolean" },
          effect: (v) => {
            effectCalls++;
            lastEffectValue = v;
            return { status: "ok" };
          },
        },
      },
    });
    const r = await ctrl.applyUpdate("gated", true);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(effectCalls, 1);
    assert.strictEqual(lastEffectValue, true);
    assert.strictEqual(ctrl.get("gated"), true);
  });

  it("does not run effect when validate fails", async () => {
    let effectCalls = 0;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        gated: {
          validate: () => ({ status: "error", message: "nope" }),
          effect: () => { effectCalls++; return { status: "ok" }; },
        },
      },
    });
    const r = await ctrl.applyUpdate("gated", true);
    assert.strictEqual(r.status, "error");
    assert.strictEqual(effectCalls, 0);
    assert.strictEqual(ctrl.get("gated"), undefined);
  });

  it("does not commit when effect fails (store stays clean)", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        gated: {
          validate: () => ({ status: "ok" }),
          effect: () => ({ status: "error", message: "system rejected" }),
        },
      },
    });
    let broadcasts = 0;
    ctrl.subscribe(() => broadcasts++);
    const r = await ctrl.applyUpdate("gated", true);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /system rejected/);
    assert.strictEqual(ctrl.get("gated"), undefined);
    assert.strictEqual(broadcasts, 0, "no broadcast on effect failure");
  });

  it("propagates effect throws as { status: error }", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        gated: {
          validate: () => ({ status: "ok" }),
          effect: () => { throw new Error("kaboom"); },
        },
      },
    });
    const r = await ctrl.applyUpdate("gated", true);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /kaboom/);
    assert.strictEqual(ctrl.get("gated"), undefined);
  });

  it("supports async effect", async () => {
    let resolved = false;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        gated: {
          validate: () => ({ status: "ok" }),
          effect: async () => {
            await new Promise((r) => setTimeout(r, 1));
            resolved = true;
            return { status: "ok" };
          },
        },
      },
    });
    const r = await ctrl.applyUpdate("gated", "anything");
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(resolved, true);
  });

  it("noop short-circuits before validate or effect", async () => {
    let validateCalls = 0;
    let effectCalls = 0;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        lang: {  // override built-in lang with a tracking gate
          validate: () => { validateCalls++; return { status: "ok" }; },
          effect: () => { effectCalls++; return { status: "ok" }; },
        },
      },
    });
    // Default lang is "en"; set to "en" again should noop.
    const r = await ctrl.applyUpdate("lang", "en");
    assert.strictEqual(r.noop, true);
    assert.strictEqual(validateCalls, 0);
    assert.strictEqual(effectCalls, 0);
  });
});

describe("hydrate (system → prefs import, no effect)", () => {
  it("runs validate but skips effect, then commits", async () => {
    let effectCalls = 0;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        sysBacked: {
          validate: (v) => typeof v === "boolean"
            ? { status: "ok" }
            : { status: "error", message: "bad" },
          effect: () => { effectCalls++; return { status: "ok" }; },
        },
      },
    });
    const r = await ctrl.hydrate({ sysBacked: true });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(effectCalls, 0, "effect must not run during hydrate");
    assert.strictEqual(ctrl.get("sysBacked"), true);
  });

  it("rejects partial that fails validate without committing anything", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        a: { validate: () => ({ status: "ok" }), effect: () => ({ status: "ok" }) },
        b: { validate: () => ({ status: "error", message: "bad b" }) },
      },
    });
    const r = await ctrl.hydrate({ a: 1, b: 2 });
    assert.strictEqual(r.status, "error");
    assert.strictEqual(ctrl.get("a"), undefined);
    assert.strictEqual(ctrl.get("b"), undefined);
  });

  it("rejects non-object input", () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = ctrl.hydrate(null);
    assert.strictEqual(r.status, "error");
  });

  it("commits multiple keys atomically with a single broadcast", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    let broadcasts = 0;
    let lastChanges = null;
    ctrl.subscribe(({ changes }) => { broadcasts++; lastChanges = changes; });
    // Use existing pure-data fields (function-form entries) — hydrate must
    // work for both function-form and object-form entries.
    const r = await ctrl.hydrate({ lang: "zh", soundMuted: true });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(broadcasts, 1);
    assert.deepStrictEqual(lastChanges, { lang: "zh", soundMuted: true });
  });

  it("noop when value already matches", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.hydrate({ lang: "en" }); // default
    assert.strictEqual(r.noop, true);
  });
});

describe("locked controller (future-version files)", () => {
  it("applyUpdate still validates and updates store but does not persist", async () => {
    const p = makeTempPath();
    fs.writeFileSync(p, JSON.stringify({ version: 999, lang: "en" }));
    const originalWarn = console.warn;
    console.warn = () => {};
    let ctrl;
    try {
      ctrl = createSettingsController({ prefsPath: p });
    } finally {
      console.warn = originalWarn;
    }
    const r = await ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("lang"), "zh");
    // On-disk file should still have version 999 (not overwritten)
    const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(onDisk.version, 999);
    assert.strictEqual(onDisk.lang, "en");
  });
});
