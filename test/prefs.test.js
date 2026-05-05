"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const prefs = require("../src/prefs");

const tempDirs = [];

function makeTempPath(name = "clawd-prefs.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-prefs-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("prefs.getDefaults", () => {
  it("returns a fresh snapshot every call (no shared object refs)", () => {
    const a = prefs.getDefaults();
    const b = prefs.getDefaults();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.agents, b.agents);
    assert.notStrictEqual(a.themeOverrides, b.themeOverrides);
    assert.notStrictEqual(a.shortcuts, b.shortcuts);
    assert.notStrictEqual(a.sessionAliases, b.sessionAliases);
    // Mutating one shouldn't affect the other
    a.agents["claude-code"].enabled = false;
    assert.strictEqual(b.agents["claude-code"].enabled, true);
  });

  it("includes the current schema version", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.version, prefs.CURRENT_VERSION);
  });

  it("defaults Claude hook management on and Start with Claude off", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.manageClaudeHooksAutomatically, true);
    assert.strictEqual(d.autoStartWithClaude, false);
    assert.strictEqual(d.lowPowerIdleMode, false);
    assert.strictEqual(d.allowEdgePinning, false);
    assert.strictEqual(d.keepSizeAcrossDisplays, false);
    assert.strictEqual(d.sessionHudEnabled, true);
    assert.strictEqual(d.sessionHudShowElapsed, true);
    assert.strictEqual(d.sessionHudCleanupDetached, false);
    assert.strictEqual(d.savedPixelWidth, 0);
    assert.strictEqual(d.savedPixelHeight, 0);
    assert.strictEqual(d.permissionBubblesEnabled, true);
    assert.strictEqual(d.notificationBubbleAutoCloseSeconds, 3);
    assert.strictEqual(d.updateBubbleAutoCloseSeconds, 9);
    assert.deepStrictEqual(d.sessionAliases, {});
  });

  it("seeds all known agents as enabled", () => {
    const d = prefs.getDefaults();
    for (const id of ["claude-code", "codex", "copilot-cli", "cursor-agent", "gemini-cli", "codebuddy", "kiro-cli", "kimi-cli", "opencode"]) {
      assert.strictEqual(d.agents[id].enabled, true, `${id} should default enabled`);
    }
  });

  it("seeds all known agents with permissionsEnabled=true", () => {
    const d = prefs.getDefaults();
    for (const id of ["claude-code", "codex", "copilot-cli", "cursor-agent", "gemini-cli", "codebuddy", "kiro-cli", "kimi-cli", "opencode"]) {
      assert.strictEqual(
        d.agents[id].permissionsEnabled,
        true,
        `${id} should default permissionsEnabled`
      );
    }
  });

  it("defaults Codex permissions to intercept mode", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.agents.codex.permissionMode, "intercept");
  });
});

describe("prefs.validate", () => {
  it("drops bad fields and falls back to defaults", () => {
    const v = prefs.validate({
      lang: "klingon",       // not in enum
      soundMuted: "yes",     // wrong type
      soundVolume: 2,        // out of range → default 1
      lowPowerIdleMode: "yes",
      x: NaN,                // not finite
      bubbleFollowPet: true, // ok
      sessionHudEnabled: "yes",
      sessionHudShowElapsed: "yes",
      sessionHudCleanupDetached: "yes",
      hideBubbles: 0,        // wrong type
      permissionBubblesEnabled: "yes",
      notificationBubbleAutoCloseSeconds: -1,
      updateBubbleAutoCloseSeconds: 3601,
      allowEdgePinning: "yes",
      savedPixelWidth: -1,
      savedPixelHeight: "286",
    });
    const d = prefs.getDefaults();
    assert.strictEqual(v.lang, d.lang);
    assert.strictEqual(v.soundMuted, false);
    assert.strictEqual(v.soundVolume, 1);
    assert.strictEqual(v.lowPowerIdleMode, false);
    assert.strictEqual(v.x, 0);
    assert.strictEqual(v.bubbleFollowPet, true);
    assert.strictEqual(v.sessionHudEnabled, true);
    assert.strictEqual(v.sessionHudShowElapsed, true);
    assert.strictEqual(v.sessionHudCleanupDetached, false);
    assert.strictEqual(v.hideBubbles, false);
    assert.strictEqual(v.permissionBubblesEnabled, true);
    assert.strictEqual(v.notificationBubbleAutoCloseSeconds, 3);
    assert.strictEqual(v.updateBubbleAutoCloseSeconds, 9);
    assert.strictEqual(v.allowEdgePinning, false);
    assert.strictEqual(v.savedPixelWidth, 0);
    assert.strictEqual(v.savedPixelHeight, 0);
  });

  it("backfills split bubble prefs from legacy hideBubbles=true", () => {
    const v = prefs.validate(prefs.migrate({ hideBubbles: true }));
    assert.strictEqual(v.hideBubbles, true);
    assert.strictEqual(v.permissionBubblesEnabled, false);
    assert.strictEqual(v.notificationBubbleAutoCloseSeconds, 0);
    assert.strictEqual(v.updateBubbleAutoCloseSeconds, 0);
  });

  it("backfills split bubble prefs from legacy hideBubbles=false", () => {
    const v = prefs.validate(prefs.migrate({ hideBubbles: false }));
    assert.strictEqual(v.hideBubbles, false);
    assert.strictEqual(v.permissionBubblesEnabled, true);
    assert.strictEqual(v.notificationBubbleAutoCloseSeconds, 3);
    assert.strictEqual(v.updateBubbleAutoCloseSeconds, 9);
  });

  it("preserves explicit split bubble prefs during legacy backfill", () => {
    const v = prefs.validate(prefs.migrate({
      hideBubbles: true,
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 12,
      updateBubbleAutoCloseSeconds: 8,
    }));
    assert.strictEqual(v.permissionBubblesEnabled, true);
    assert.strictEqual(v.notificationBubbleAutoCloseSeconds, 12);
    assert.strictEqual(v.updateBubbleAutoCloseSeconds, 8);
  });

  it("keeps valid fields verbatim", () => {
    const v = prefs.validate({
      lang: "ko",
      soundMuted: true,
      soundVolume: 0.4,
      lowPowerIdleMode: true,
      bubbleFollowPet: true,
      sessionHudEnabled: false,
      sessionHudShowElapsed: false,
      sessionHudCleanupDetached: true,
      allowEdgePinning: true,
      keepSizeAcrossDisplays: true,
      savedPixelWidth: 286,
      savedPixelHeight: 286,
      x: 100,
      y: -50,
      size: "P:15",
      miniEdge: "left",
      theme: "calico",
    });
    assert.strictEqual(v.lang, "ko");
    assert.strictEqual(v.soundMuted, true);
    assert.strictEqual(v.soundVolume, 0.4);
    assert.strictEqual(v.lowPowerIdleMode, true);
    assert.strictEqual(v.bubbleFollowPet, true);
    assert.strictEqual(v.sessionHudEnabled, false);
    assert.strictEqual(v.sessionHudShowElapsed, false);
    assert.strictEqual(v.sessionHudCleanupDetached, true);
    assert.strictEqual(v.allowEdgePinning, true);
    assert.strictEqual(v.keepSizeAcrossDisplays, true);
    assert.strictEqual(v.savedPixelWidth, 286);
    assert.strictEqual(v.savedPixelHeight, 286);
    assert.strictEqual(v.x, 100);
    assert.strictEqual(v.y, -50);
    assert.strictEqual(v.size, "P:15");
    assert.strictEqual(v.miniEdge, "left");
    assert.strictEqual(v.theme, "calico");
  });

  it("accepts soundVolume 0 (silent playback is valid)", () => {
    const v = prefs.validate({ soundVolume: 0 });
    assert.strictEqual(v.soundVolume, 0);
  });

  it("normalizes agents (drops malformed entries)", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: false },
        "bogus-entry": "not an object",
        "codex": { enabled: "true" }, // wrong type — should be dropped
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, false);
    // bogus + bad codex use defaults
    assert.strictEqual(v.agents.codex.enabled, true);
    assert.strictEqual(v.agents["bogus-entry"], undefined);
  });

  it("normalizes agents: preserves permissionsEnabled flag", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: true, permissionsEnabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, true);
    assert.strictEqual(v.agents["claude-code"].permissionsEnabled, false);
  });

  it("normalizes agents: fills missing permissionsEnabled from defaults", () => {
    // Pre-subgate prefs files only have { enabled: bool }. Normalization
    // must NOT strip them, but must also NOT invent permissionsEnabled=false
    // — defaults are true, and the gate reads "missing flag" as true anyway.
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, false);
    assert.strictEqual(v.agents["claude-code"].permissionsEnabled, true);
  });

  it("normalizes agents: drops non-boolean permissionsEnabled, keeps valid enabled", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: false, permissionsEnabled: "nope" },
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, false);
    // Bad flag falls back to the default for that agent (true), not dropped
    // altogether — the entry has a valid flag so it survives.
    assert.strictEqual(v.agents["claude-code"].permissionsEnabled, true);
  });

  it("normalizes agents: preserves notificationHookEnabled flag", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: true, notificationHookEnabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, true);
    assert.strictEqual(v.agents["claude-code"].notificationHookEnabled, false);
  });

  it("normalizes agents: preserves valid Codex permissionMode", () => {
    const v = prefs.validate({
      agents: {
        codex: { enabled: true, permissionMode: "intercept" },
      },
    });
    assert.strictEqual(v.agents.codex.enabled, true);
    assert.strictEqual(v.agents.codex.permissionMode, "intercept");
  });

  it("normalizes agents: drops invalid Codex permissionMode to intercept", () => {
    const v = prefs.validate({
      agents: {
        codex: { enabled: true, permissionMode: "auto" },
      },
    });
    assert.strictEqual(v.agents.codex.permissionMode, "intercept");
  });

  it("normalizes agents: fills missing notificationHookEnabled from defaults", () => {
    // Pre-flag prefs files don't carry notificationHookEnabled. The default
    // must be true so an upgrade doesn't silently suppress idle notifications
    // on users who never opted in.
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: true, permissionsEnabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].notificationHookEnabled, true);
  });

  it("seeds all known agents with notificationHookEnabled=true", () => {
    const d = prefs.getDefaults();
    for (const id of ["claude-code", "codex", "copilot-cli", "cursor-agent", "gemini-cli", "codebuddy", "kiro-cli", "opencode"]) {
      assert.strictEqual(
        d.agents[id].notificationHookEnabled,
        true,
        `${id} should default notificationHookEnabled`
      );
    }
  });

  it("returns defaults for null/non-object input", () => {
    const a = prefs.validate(null);
    const b = prefs.validate("not an object");
    const d = prefs.getDefaults();
    assert.deepStrictEqual(a, d);
    assert.deepStrictEqual(b, d);
  });

  it("positionDisplay defaults to null and round-trips a valid snapshot", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.positionDisplay, null);

    const v = prefs.validate({
      positionDisplay: {
        id: 42,
        scaleFactor: 2,
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 0, width: 2560, height: 1392 },
        stray: "ignored",
      },
    });
    assert.deepStrictEqual(v.positionDisplay, {
      id: 42,
      scaleFactor: 2,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 0, width: 2560, height: 1392 },
    });
  });

  it("positionDisplay drops malformed snapshots back to null", () => {
    for (const bad of [
      { positionDisplay: "not an object" },
      { positionDisplay: { bounds: null } },
      { positionDisplay: { bounds: { x: 0, y: 0, width: 0, height: 1080 } } },
      { positionDisplay: { bounds: { x: NaN, y: 0, width: 1920, height: 1080 } } },
    ]) {
      const v = prefs.validate(bad);
      assert.strictEqual(v.positionDisplay, null, `expected null for ${JSON.stringify(bad)}`);
    }
  });

  // Phase 3b-swap: themeVariant field
  it("themeVariant defaults to empty object (no migration needed)", () => {
    const d = prefs.getDefaults();
    assert.deepStrictEqual(d.themeVariant, {});
  });

  it("themeVariant drops malformed entries but keeps string/string pairs", () => {
    const v = prefs.validate({
      themeVariant: {
        clawd: "chill",
        calico: "default",
        bogus: 42,           // wrong value type
        "": "chill",         // empty themeId
        nullVal: "",         // empty variantId
      },
    });
    assert.deepStrictEqual(v.themeVariant, { clawd: "chill", calico: "default" });
  });

  it("themeVariant falls back to defaults when not an object", () => {
    const v = prefs.validate({ themeVariant: "nope" });
    assert.deepStrictEqual(v.themeVariant, {});
    const w = prefs.validate({ themeVariant: [1, 2] });
    assert.deepStrictEqual(w.themeVariant, {});
  });

  it("sessionAliases normalizes valid entries and drops malformed values", () => {
    const v = prefs.validate({
      sessionAliases: {
        "local|codex|s1": { title: "  Codex main  ", updatedAt: 100 },
        "local|codex|missing-time": { title: "Missing time" },
        "local|codex|empty": { title: "   ", updatedAt: 100 },
        "local|codex|bad": { title: 42, updatedAt: 100 },
      },
    });
    assert.strictEqual(v.sessionAliases["local|codex|s1"].title, "Codex main");
    assert.strictEqual(v.sessionAliases["local|codex|s1"].updatedAt, 100);
    assert.strictEqual(v.sessionAliases["local|codex|missing-time"].title, "Missing time");
    assert.strictEqual(typeof v.sessionAliases["local|codex|missing-time"].updatedAt, "number");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(v.sessionAliases, "local|codex|empty"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(v.sessionAliases, "local|codex|bad"), false);
  });

  it("sessionAliases falls back to defaults when not an object", () => {
    assert.deepStrictEqual(prefs.validate({ sessionAliases: "nope" }).sessionAliases, {});
    assert.deepStrictEqual(prefs.validate({ sessionAliases: [1, 2] }).sessionAliases, {});
  });

  it("drops legacy workspaceAliases because they are no longer in the schema", () => {
    const v = prefs.validate({
      workspaceAliases: {
        "local|d:/animation": "Clawd main repo",
      },
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(v, "workspaceAliases"), false);
    assert.deepStrictEqual(v.sessionAliases, {});
  });

  it("shortcuts defaults to the built-in shortcut map", () => {
    const d = prefs.getDefaults();
    assert.deepStrictEqual(d.shortcuts, {
      togglePet: "CommandOrControl+Shift+Alt+C",
      permissionAllow: "CommandOrControl+Shift+Y",
      permissionDeny: "CommandOrControl+Shift+N",
    });
  });

  it("shortcuts fills missing keys and normalizes valid values", () => {
    const v = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+K",
      },
    });
    assert.deepStrictEqual(v.shortcuts, {
      togglePet: "CommandOrControl+K",
      permissionAllow: "CommandOrControl+Shift+Y",
      permissionDeny: "CommandOrControl+Shift+N",
    });
  });

  it("shortcuts falls back to defaults for invalid or dangerous values", () => {
    const v = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+C",
        permissionAllow: "bad accelerator",
        permissionDeny: 42,
      },
    });
    assert.deepStrictEqual(v.shortcuts, {
      togglePet: "CommandOrControl+Shift+Alt+C",
      permissionAllow: "CommandOrControl+Shift+Y",
      permissionDeny: "CommandOrControl+Shift+N",
    });
  });

  it("shortcuts de-duplicates conflicting load-time values with default priority", () => {
    const v = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+K",
        permissionAllow: "Ctrl+K",
        permissionDeny: "Ctrl+Shift+Y",
      },
    });
    assert.deepStrictEqual(v.shortcuts, {
      togglePet: "CommandOrControl+K",
      permissionAllow: "CommandOrControl+Shift+Y",
      permissionDeny: "CommandOrControl+Shift+N",
    });
  });
});

describe("prefs.migrate", () => {
  it("upgrades v0 (no version field) to v1", () => {
    const raw = { lang: "zh", soundMuted: true };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 1);
    assert.ok(upgraded.agents && typeof upgraded.agents === "object");
    assert.ok(upgraded.themeOverrides && typeof upgraded.themeOverrides === "object");
    // Original fields preserved
    assert.strictEqual(upgraded.lang, "zh");
    assert.strictEqual(upgraded.soundMuted, true);
  });

  it("leaves v1 files alone", () => {
    const raw = {
      version: 1,
      lang: "en",
      agents: { "claude-code": { enabled: false } },
    };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 1);
    assert.strictEqual(upgraded.agents["claude-code"].enabled, false);
  });

  it("backfills positionSaved=true for files with non-zero x/y", () => {
    const raw = { version: 1, x: 500, y: 300 };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.positionSaved, true);
  });

  it("backfills positionSaved=false for files with x=0,y=0", () => {
    const raw = { version: 1, x: 0, y: 0 };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.positionSaved, false);
  });

  it("does not overwrite existing positionSaved field", () => {
    const raw = { version: 1, x: 0, y: 0, positionSaved: true };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.positionSaved, true);
  });
});

describe("prefs.load", () => {
  it("returns defaults for missing file (ENOENT) without backup", () => {
    const p = makeTempPath();
    const { snapshot, locked } = prefs.load(p);
    assert.strictEqual(locked, false);
    assert.deepStrictEqual(snapshot, prefs.getDefaults());
    // Should NOT have created a backup since file never existed
    assert.strictEqual(fs.existsSync(p + ".bak"), false);
  });

  it("backs up corrupt JSON and returns defaults", () => {
    const p = makeTempPath();
    fs.writeFileSync(p, "{ this is not valid json", "utf8");
    const { snapshot, locked } = prefs.load(p);
    assert.strictEqual(locked, false);
    assert.deepStrictEqual(snapshot, prefs.getDefaults());
    assert.strictEqual(fs.existsSync(p + ".bak"), true);
    assert.strictEqual(
      fs.readFileSync(p + ".bak", "utf8"),
      "{ this is not valid json"
    );
  });

  it("migrates a v0 file (no version field) on load", () => {
    const p = makeTempPath();
    fs.writeFileSync(
      p,
      JSON.stringify({ lang: "zh", x: 100, y: 200, size: "P:12" }),
      "utf8"
    );
    const { snapshot, locked } = prefs.load(p);
    assert.strictEqual(locked, false);
    assert.strictEqual(snapshot.version, 1);
    assert.strictEqual(snapshot.lang, "zh");
    assert.strictEqual(snapshot.x, 100);
    assert.strictEqual(snapshot.y, 200);
    assert.strictEqual(snapshot.size, "P:12");
    // New fields populated from defaults
    assert.ok(snapshot.agents);
    assert.ok(snapshot.themeOverrides);
  });

  it("returns locked=true and warns for future-version files", () => {
    const p = makeTempPath();
    fs.writeFileSync(
      p,
      JSON.stringify({ version: 999, lang: "en" }),
      "utf8"
    );
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
      const { snapshot, locked } = prefs.load(p);
      assert.strictEqual(locked, true);
      assert.strictEqual(snapshot.lang, "en");
      assert.strictEqual(warned, true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("prefs.save", () => {
  it("writes a valid snapshot that round-trips through load", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.lang = "zh";
    snap.bubbleFollowPet = true;
    snap.x = 42;
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.strictEqual(snapshot.lang, "zh");
    assert.strictEqual(snapshot.bubbleFollowPet, true);
    assert.strictEqual(snapshot.x, 42);
    assert.strictEqual(snapshot.version, 1);
  });

  it("validates before writing — bad fields fall back to defaults on disk", () => {
    const p = makeTempPath();
    const dirty = {
      ...prefs.getDefaults(),
      lang: "klingon",
      x: NaN,
    };
    prefs.save(p, dirty);
    const written = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(written.lang, "en");
    assert.strictEqual(written.x, 0);
  });

  it("round-trips themeOverrides with disabled: true", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        states: {
          sweeping: { disabled: true },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.states.sweeping, { disabled: true });
  });

  it("themeOverrides: nested state entry preserves file + transition while keeping disabled", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        states: {
          attention: {
            disabled: true,
            sourceThemeId: "clawd",
            file: "clawd-happy.svg",
            transition: { in: 100, out: 220 },
          },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.states.attention, {
      disabled: true,
      sourceThemeId: "clawd",
      file: "clawd-happy.svg",
      transition: { in: 100, out: 220 },
    });
  });

  it("themeOverrides: state/tier/timing entries round-trip in Path A schema", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        states: {
          attention: {
            file: "clawd-happy.svg",
            transition: { in: 80, out: 140 },
          },
        },
        tiers: {
          workingTiers: {
            "clawd-working-typing.svg": {
              file: "custom-working.svg",
              transition: { in: 0, out: 90 },
            },
          },
        },
        timings: {
          autoReturn: { attention: 2800 },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd, {
      states: {
        attention: {
          file: "clawd-happy.svg",
          transition: { in: 80, out: 140 },
        },
      },
      tiers: {
        workingTiers: {
          "clawd-working-typing.svg": {
            file: "custom-working.svg",
            transition: { in: 0, out: 90 },
          },
        },
      },
      timings: {
        autoReturn: { attention: 2800 },
      },
    });
  });

  it("themeOverrides.sounds: round-trips per-soundName file entries", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        sounds: {
          complete: { file: "my-done.mp3" },
          confirm: { file: "nope.wav" },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.sounds, {
      complete: { file: "my-done.mp3" },
      confirm: { file: "nope.wav" },
    });
  });

  it("themeOverrides.sounds: drops entries with invalid / empty file and non-string keys", () => {
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          sounds: {
            complete: { file: "ok.mp3" },
            confirm: { file: "" },    // empty
            weird:    { durationMs: 1000 }, // no file → dropped
            "":       { file: "x.mp3" }, // empty key → dropped
          },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides.clawd.sounds, {
      complete: { file: "ok.mp3" },
    });
  });

  it("themeOverrides.sounds: strips ancillary fields (durationMs / transition / sourceThemeId) — sounds only keep file", () => {
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          sounds: {
            complete: { file: "ok.mp3", durationMs: 1000, transition: { in: 50 }, sourceThemeId: "x" },
          },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides.clawd.sounds, {
      complete: { file: "ok.mp3" },
    });
  });

  it("themeOverrides.sounds: preserves originalName when valid, basename-strips and caps length", () => {
    // originalName is display-only — stores what the user picked before the
    // copy renamed it to `${soundName}${ext}`. Sanitised to guard hand-edited
    // pref files from shoving path traversal / absurd strings into the UI.
    const longName = "a".repeat(300) + ".mp3";
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          sounds: {
            complete: { file: "complete.mp3", originalName: "cat-demo.mp3" },
            confirm:  { file: "confirm.wav", originalName: "../../etc/passwd.wav" }, // basenamed
            hiss:     { file: "hiss.mp3", originalName: ".." },                      // dropped
            purr:     { file: "purr.mp3", originalName: "" },                        // dropped
            growl:    { file: "growl.mp3", originalName: longName },                 // capped
          },
        },
      },
    });
    assert.strictEqual(validated.themeOverrides.clawd.sounds.complete.originalName, "cat-demo.mp3");
    assert.strictEqual(validated.themeOverrides.clawd.sounds.confirm.originalName, "passwd.wav");
    assert.strictEqual(validated.themeOverrides.clawd.sounds.hiss.originalName, undefined);
    assert.strictEqual(validated.themeOverrides.clawd.sounds.purr.originalName, undefined);
    assert.strictEqual(validated.themeOverrides.clawd.sounds.growl.originalName.length, 256);
  });

  it("themeOverrides.sounds: rejects path-unsafe soundName keys and basename-sanitises file", () => {
    // soundName becomes a filename stem under sound-overrides/<themeId>/ —
    // a malicious theme or hand-edited pref must not be able to escape that
    // directory. File paths with separators get basename-stripped.
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          sounds: {
            complete:      { file: "ok.mp3" },
            "../../evil":  { file: "x.mp3" },           // unsafe key → dropped
            "foo/bar":     { file: "x.mp3" },           // unsafe key → dropped
            "spaces bad":  { file: "x.mp3" },           // unsafe key → dropped
            confirm:       { file: "../../etc/passwd" },// unsafe file → basenamed
            quiet:         { file: ".." },               // bare `..` → dropped
          },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides.clawd.sounds, {
      complete: { file: "ok.mp3" },
      confirm:  { file: "passwd" },
    });
  });

  it("themeOverrides: legacy flat state entries normalize into states map", () => {
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          attention: { disabled: true },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides, {
      clawd: {
        states: {
          attention: { disabled: true },
        },
      },
    });
  });

  it("themeOverrides: reactions round-trip with file + durationMs + transition", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        reactions: {
          clickLeft: {
            file: "my-poke.svg",
            durationMs: 2200,
            transition: { in: 50, out: 100 },
          },
          double: { file: "my-double.svg", durationMs: 4000 },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.reactions, {
      clickLeft: {
        file: "my-poke.svg",
        durationMs: 2200,
        transition: { in: 50, out: 100 },
      },
      double: { file: "my-double.svg", durationMs: 4000 },
    });
  });

  it("themeOverrides: hitbox.wide round-trips boolean per-file flags", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        hitbox: {
          wide: {
            "clawd-error.svg": true,
            "clawd-idle.svg": false,
          },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.hitbox, {
      wide: {
        "clawd-error.svg": true,
        "clawd-idle.svg": false,
      },
    });
  });

  it("themeOverrides: hitbox normalize drops non-boolean values", () => {
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          hitbox: {
            wide: {
              "ok.svg": true,
              "bad.svg": "yes",   // dropped
              "null-val.svg": null,  // dropped
            },
          },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides.clawd.hitbox, {
      wide: { "ok.svg": true },
    });
  });

  it("themeOverrides: normalize drops unknown reaction keys and strips durationMs from drag", () => {
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          reactions: {
            explode: { file: "bogus.svg" },           // invalid key
            drag: { file: "my-drag.svg", durationMs: 9999 },  // drag can't have duration
            clickLeft: { file: "p.svg" },             // valid
          },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides.clawd.reactions, {
      drag: { file: "my-drag.svg" },     // durationMs stripped
      clickLeft: { file: "p.svg" },
      // explode: absent
    });
  });
});
