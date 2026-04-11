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
});

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
