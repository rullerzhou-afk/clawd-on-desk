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
    // Mutating one shouldn't affect the other
    a.agents["claude-code"].enabled = false;
    assert.strictEqual(b.agents["claude-code"].enabled, true);
  });

  it("includes the current schema version", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.version, prefs.CURRENT_VERSION);
  });

  it("seeds all known agents as enabled", () => {
    const d = prefs.getDefaults();
    for (const id of ["claude-code", "codex", "copilot-cli", "cursor-agent", "gemini-cli", "opencode"]) {
      assert.strictEqual(d.agents[id].enabled, true, `${id} should default enabled`);
    }
  });
});

describe("prefs.validate", () => {
  it("drops bad fields and falls back to defaults", () => {
    const v = prefs.validate({
      lang: "klingon",       // not in enum
      soundMuted: "yes",     // wrong type
      x: NaN,                // not finite
      bubbleFollowPet: true, // ok
      hideBubbles: 0,        // wrong type
    });
    const d = prefs.getDefaults();
    assert.strictEqual(v.lang, d.lang);
    assert.strictEqual(v.soundMuted, false);
    assert.strictEqual(v.x, 0);
    assert.strictEqual(v.bubbleFollowPet, true);
    assert.strictEqual(v.hideBubbles, false);
  });

  it("keeps valid fields verbatim", () => {
    const v = prefs.validate({
      lang: "zh",
      soundMuted: true,
      bubbleFollowPet: true,
      x: 100,
      y: -50,
      size: "P:15",
      miniEdge: "left",
      theme: "calico",
    });
    assert.strictEqual(v.lang, "zh");
    assert.strictEqual(v.soundMuted, true);
    assert.strictEqual(v.bubbleFollowPet, true);
    assert.strictEqual(v.x, 100);
    assert.strictEqual(v.y, -50);
    assert.strictEqual(v.size, "P:15");
    assert.strictEqual(v.miniEdge, "left");
    assert.strictEqual(v.theme, "calico");
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

  it("returns defaults for null/non-object input", () => {
    const a = prefs.validate(null);
    const b = prefs.validate("not an object");
    const d = prefs.getDefaults();
    assert.deepStrictEqual(a, d);
    assert.deepStrictEqual(b, d);
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
});
