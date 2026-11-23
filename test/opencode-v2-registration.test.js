"use strict";

// opencode v2 `plugins`-key registration tests (issue #1039).
//
// Runs the REAL opencode installer against temp homes and asserts the dual-key
// contract: the v1 `plugin` entry and the v2 `plugins` entry both point into
// the same managed generation, foreign entries (npm strings, v2-style
// `{ package, options }` objects, tuples) survive byte-for-byte, duplicates
// converge, fail-closed entries refuse mutation, and uninstall sweeps both
// keys while preserving everything foreign.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, after } = require("node:test");

const { registerOpencodePlugin, unregisterOpencodePlugin } = require("../hooks/opencode-install");
const v2Registry = require("../hooks/opencode-family-v2-registration");

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeHome(prefix = "clawd-v2reg-") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(home);
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  return home;
}

function configPath(home) {
  return path.join(home, ".config", "opencode", "opencode.json");
}

function readConfig(home) {
  return JSON.parse(fs.readFileSync(configPath(home), "utf8"));
}

function writeConfig(home, cfg) {
  fs.writeFileSync(configPath(home), JSON.stringify(cfg, null, 2));
}

function managedRoots(home) {
  return {
    homeDir: home,
    managedRoot: path.join(home, ".clawd", "integrations", "opencode-family"),
  };
}

describe("opencode v2 plugins-key registration", () => {
  it("registers only the v2 plugins key on a v2 host; foreign v2 shapes survive verbatim", () => {
    const home = makeHome();
    const foreignObject = { package: "some-opencode-plugin", options: { strict: true } };
    const foreignTuple = ["/opt/other-tools/legacy-plugin", { mode: "x" }];
    writeConfig(home, {
      $schema: "https://opencode.ai/config.json",
      plugins: ["oh-my-openagent@latest", foreignObject, foreignTuple],
    });

    const result = registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) });
    assert.strictEqual(result.status, "ok", result.message);

    const cfg = readConfig(home);
    // opencode 2.x rejects the v1 function entry, so the legacy `plugin` key is
    // never written on a v2 host.
    assert.ok(!Object.hasOwn(cfg, "plugin") || cfg.plugin.length === 0, "v1 plugin key is not registered on a v2 host");
    const v2Entry = cfg.plugins.find((entry) => typeof entry === "string" && entry.includes("opencode-plugin-v2"));
    assert.ok(v2Entry, "v2 plugins entry registered");
    assert.ok(v2Entry.includes("/generations/"), "v2 entry points at the managed generation");
    assert.strictEqual(path.basename(String(v2Entry)), "opencode-plugin-v2");
    assert.deepStrictEqual(
      cfg.plugins.filter((entry) => entry !== v2Entry),
      ["oh-my-openagent@latest", foreignObject, foreignTuple],
      "foreign entries preserved value-for-value"
    );
    assert.strictEqual(v2Registry.verifyV2RegisterPostcondition({
      cfg: require("../agents/opencode-family").getFamilyConfig("opencode"),
      configPath: configPath(home),
      makeContext: () => ({
        fs, platform: process.platform, pluginDirName: "opencode-plugin-v2",
        expectedCanonicalDir: String(v2Entry), targetRoot: null,
        sourcePluginDir: null, knownRegisteredPaths: new Set(),
        canonicalize: (v) => v, canonicalizeStrict: (v) => v,
        exists: () => true,
        inspectExpectedGeneration: () => ({ ok: true }),
        inspectManagedBoundary: () => ({ state: "owned" }),
        bundleBytesMatch: () => true,
        isClawdLike: () => false,
      }),
    }).ok, true);
  });

  it("converges duplicate v2 entries to exactly one", () => {
    const home = makeHome();
    const first = registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) });
    assert.strictEqual(first.status, "ok");
    const cfgBefore = readConfig(home);
    const v2Entry = cfgBefore.plugins.find((entry) => String(entry).includes("opencode-plugin-v2"));
    writeConfig(home, { ...cfgBefore, plugins: [v2Entry, v2Entry] });

    const second = registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) });
    assert.strictEqual(second.status, "ok", second.message);
    const cfgAfter = readConfig(home);
    const owned = cfgAfter.plugins.filter((entry) => String(entry).includes("opencode-plugin-v2"));
    assert.strictEqual(owned.length, 1, "duplicates converge");
  });

  it("sweeps a leftover owned v1 entry and restores the v2 entry on a v2 host", () => {
    const home = makeHome();
    assert.strictEqual(registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) }).status, "ok");

    // Simulate a pre-#1039 install: the v1 `plugin` entry exists (pointing at
    // the sibling v1 dir of the same generation) but the v2 key was never
    // written. opencode 2.x rejects that v1 function entry, so Repair must
    // sweep it and restore the v2 key.
    const cfg = readConfig(home);
    const v1Entry = path.join(path.dirname(cfg.plugins[0]), "opencode-plugin").replace(/\\/g, "/");
    writeConfig(home, { $schema: cfg.$schema, plugin: [v1Entry] });

    const repair = registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) });
    assert.strictEqual(repair.status, "ok", repair.message);
    const repaired = readConfig(home);
    assert.deepStrictEqual(repaired.plugin || [], [], "leftover v1 entry swept");
    assert.ok(
      (repaired.plugins || []).some((entry) => String(entry).includes("opencode-plugin-v2")),
      "v2 entry restored"
    );
  });

  it("PR #1182 follow-up: a dual-key v1.3.0 config sweeps only the v1 entry and prints the restart hint", () => {
    const home = makeHome();
    assert.strictEqual(registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) }).status, "ok");
    const cfg = readConfig(home);
    const v1Entry = path.join(path.dirname(cfg.plugins[0]), "opencode-plugin").replace(/\\/g, "/");
    // What v1.3.0 wrote on a v2 host: both keys, pointing at one generation.
    writeConfig(home, { $schema: cfg.$schema, plugin: [v1Entry], plugins: cfg.plugins });

    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    let repair;
    try {
      repair = registerOpencodePlugin({ v2Host: "v2", ...managedRoots(home) });
    } finally {
      console.log = originalLog;
    }
    assert.strictEqual(repair.status, "ok", repair.message);
    assert.strictEqual(repair.added, false, "nothing new registered");
    const repaired = readConfig(home);
    assert.deepStrictEqual(repaired.plugin, [], "v1 entry swept");
    assert.deepStrictEqual(repaired.plugins, cfg.plugins, "v2 entry untouched");
    const output = lines.join("\n");
    assert.match(output, /Removed the legacy v1 "plugin" entry/);
    // The running opencode service keeps the failed entry until it restarts.
    assert.match(output, /restart the opencode service/);

    // A second sync is a quiet no-op.
    const again = registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) });
    assert.strictEqual(again.skipped, true);
  });

  it("uninstall sweeps both keys and preserves foreign entries", () => {
    const home = makeHome();
    const foreignObject = { package: "keep-me", options: { a: 1 } };
    writeConfig(home, { plugins: ["third-party@latest", foreignObject] });
    assert.strictEqual(registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) }).status, "ok");
    assert.strictEqual(registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) }).status, "ok");

    const result = unregisterOpencodePlugin({ silent: true, ...managedRoots(home) });
    assert.strictEqual(result.status, "ok", result.message);
    assert.strictEqual(result.registrationRemoved, true);
    assert.strictEqual(result.activeEntryRemaining, false);

    const cfg = readConfig(home);
    assert.deepStrictEqual(cfg.plugin || [], [], "v1 key swept");
    assert.deepStrictEqual(cfg.plugins, ["third-party@latest", foreignObject], "v2 owned swept, foreign kept");
  });

  it("upstream #1045 review: a detected v1 host never writes the plugins key", () => {
    const home = makeHome();
    const result = registerOpencodePlugin({ silent: true, v2Host: "v1", ...managedRoots(home) });
    assert.strictEqual(result.status, "ok", result.message);

    const cfg = readConfig(home);
    assert.ok(Array.isArray(cfg.plugin) && cfg.plugin.length === 1, "v1 entry registered");
    assert.strictEqual(cfg.plugins, undefined, "opencode <= 1.18.15 must not see a plugins key");
  });

  it("upstream #1045 review: a detected v1 host sweeps a leftover owned v2 entry", () => {
    const home = makeHome();
    assert.strictEqual(registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) }).status, "ok");

    // The host downgraded to 1.x: the stale key would make <= 1.18.15 refuse
    // the whole config, so the next register (startup sync / Repair) sweeps it.
    const repair = registerOpencodePlugin({ silent: true, v2Host: "v1", ...managedRoots(home) });
    assert.strictEqual(repair.status, "ok", repair.message);
    assert.ok(
      repair.warnings.some((warning) => /leftover v2 plugins-key/.test(warning)),
      repair.warnings
    );

    const cfg = readConfig(home);
    assert.strictEqual(Object.hasOwn(cfg, "plugins"), false,
      "old v1 rejects the key itself, including an empty array");
    assert.ok(Array.isArray(cfg.plugin) && cfg.plugin.length === 1, "v1 entry survives the sweep");
  });

  it("removes the last owned v2 key without consuming JSONC comments or adjacent fields", () => {
    for (const position of ["first", "middle", "last"]) {
      const home = makeHome();
      registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) });
      const before = readConfig(home);
      const owned = JSON.stringify(before.plugins[0]);
      // A foreign v1 entry must survive the key surgery untouched.
      const plugin = `"plugin": ["third-party@latest"]`;
      const v2 = `"plugins" /* key note */ : [ /* list note */ ${owned} /* entry note */ ]`;
      const fields = position === "first" ? [v2, plugin, '"theme": "keep"']
        : position === "middle" ? [plugin, v2, '"theme": "keep"']
          : [plugin, '"theme": "keep"', v2];
      const text = `{\n// before fields\n${fields.join(", // between fields\n")}\n// after fields\n}\n`;
      fs.writeFileSync(configPath(home), text);

      const result = registerOpencodePlugin({ silent: true, v2Host: "v1", ...managedRoots(home) });
      assert.strictEqual(result.status, "ok", result.message);
      const after = fs.readFileSync(configPath(home), "utf8");
      const errors = [];
      const parsed = require("jsonc-parser").parse(after, errors);
      assert.deepStrictEqual(errors, [], after);
      assert.strictEqual(Object.hasOwn(parsed, "plugins"), false, after);
      // The v1-host register sweeps the v2 key and registers its own v1 entry;
      // the pre-existing foreign entry keeps its position untouched.
      assert.strictEqual(parsed.plugin[0], "third-party@latest");
      assert.ok(parsed.plugin.some((entry) => String(entry).includes("opencode-plugin")), "v1 entry registered");
      assert.strictEqual(parsed.theme, "keep");
      for (const note of ["key note", "list note", "entry note", "before fields", "between fields", "after fields"]) {
        assert.ok(after.includes(note), `${position}: lost ${note}`);
      }
    }
  });

  it("preserves foreign v2 entries and already-empty keys during a v1 sweep", () => {
    const home = makeHome();
    writeConfig(home, { plugins: ["third-party@latest"] });
    registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) });
    registerOpencodePlugin({ silent: true, v2Host: "v1", ...managedRoots(home) });
    assert.deepStrictEqual(readConfig(home).plugins, ["third-party@latest"]);

    writeConfig(home, { ...readConfig(home), plugins: [] });
    registerOpencodePlugin({ silent: true, v2Host: "v1", ...managedRoots(home) });
    assert.deepStrictEqual(readConfig(home).plugins, [], "an unowned empty key is not silently deleted");
  });

  it("uninstall removes the top-level key when its last owned v2 entry is removed", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) });
    const result = unregisterOpencodePlugin({ silent: true, ...managedRoots(home) });
    assert.strictEqual(result.status, "ok", result.message);
    assert.strictEqual(Object.hasOwn(readConfig(home), "plugins"), false);
  });

  it("upstream #1045 review: an unknown host never touches the plugins key", () => {
    const home = makeHome();
    const foreign = ["oh-my-openagent@latest"];
    writeConfig(home, { plugins: foreign.slice() });
    assert.strictEqual(
      registerOpencodePlugin({ silent: true, v2Host: "unknown", ...managedRoots(home) }).status,
      "ok"
    );
    let cfg = readConfig(home);
    assert.deepStrictEqual(cfg.plugins, foreign, "foreign plugins key untouched");
    assert.ok(Array.isArray(cfg.plugin) && cfg.plugin.length === 1, "v1 entry registered");

    // No plugins key is fabricated when none exists either.
    const bare = makeHome();
    assert.strictEqual(
      registerOpencodePlugin({ silent: true, v2Host: "unknown", ...managedRoots(bare) }).status,
      "ok"
    );
    cfg = readConfig(bare);
    assert.strictEqual(cfg.plugins, undefined);
    assert.ok(Array.isArray(cfg.plugin) && cfg.plugin.length === 1);
  });

  it("classifies v2-shape non-string entries as foreign (never owned)", () => {
    const ctx = {
      fs, platform: process.platform,
      pluginDirName: "opencode-plugin-v2",
      expectedCanonicalDir: "/gen/abc/opencode-plugin-v2",
      targetRoot: "/gen/abc",
      sourcePluginDir: null,
      knownRegisteredPaths: new Set(),
      canonicalize: (v) => v,
      exists: () => true,
      inspectExpectedGeneration: () => ({ ok: true }),
      inspectManagedBoundary: () => ({ state: "owned" }),
      bundleBytesMatch: () => false,
      isClawdLike: () => false,
    };
    const { entries } = v2Registry.classifyV2PluginEntries([
      "/gen/abc/opencode-plugin-v2",
      { package: "/gen/abc/opencode-plugin-v2", options: {} }, // even a Clawd-path object is foreign
      ["/gen/abc/opencode-plugin-v2", {}],                     // v1 tuple shape: foreign on v2 key
    ], ctx);
    assert.strictEqual(entries[0].category, "canonical-current");
    assert.strictEqual(entries[1].category, "foreign");
    assert.strictEqual(entries[1].reason, "v2-non-string-entry");
    assert.strictEqual(entries[2].category, "foreign");
    assert.strictEqual(entries[2].reason, "v2-non-string-entry");
  });

  it("PR #1045 follow-up: duplicate plugins keys abort register with a byte-identical config", () => {
    const home = makeHome();
    const text = '{\n  "plugin": ["third-party@latest"],\n  "plugins": ["/a/opencode-plugin-v2"],\n  "plugins": ["/b/opencode-plugin-v2"]\n}\n';
    fs.writeFileSync(configPath(home), text);
    const result = registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "config-corrupt");
    assert.strictEqual(fs.readFileSync(configPath(home), "utf8"), text, "config is never touched");
  });

  it("PR #1045 follow-up: duplicate plugins keys skip the v1-host sweep with a warning; v1 register succeeds", () => {
    const home = makeHome();
    const text = '{\n  "plugin": ["third-party@latest"],\n  "plugins": ["/a/opencode-plugin-v2"],\n  "plugins": ["/b/opencode-plugin-v2"]\n}\n';
    fs.writeFileSync(configPath(home), text);
    const result = registerOpencodePlugin({ silent: true, v2Host: "v1", ...managedRoots(home) });
    assert.strictEqual(result.status, "ok", result.message);
    assert.ok(
      result.warnings.some((w) => /v2 plugins-key leftover sweep skipped/.test(w)),
      result.warnings
    );
    assert.ok(
      result.warnings.some((w) => /duplicate top-level "plugins"/.test(w)),
      result.warnings
    );
    const cfg = readConfig(home);
    assert.ok(Array.isArray(cfg.plugin) && cfg.plugin.length >= 1, "v1 entry registered");
    // JSON.parse resolves the duplicate to its last value; the sweep must have
    // left that key completely untouched.
    assert.deepStrictEqual(cfg.plugins, ["/b/opencode-plugin-v2"]);
  });

  it("PR #1045 follow-up: duplicate plugins keys abort uninstall with a byte-identical config", () => {
    const home = makeHome();
    assert.strictEqual(registerOpencodePlugin({ silent: true, v2Host: "v2", ...managedRoots(home) }).status, "ok");
    // The config now carries a Clawd-owned v2 entry that uninstall WOULD remove.
    // Insert a duplicate top-level `plugins` key by text edit — JSON.parse
    // cannot express one.
    const registered = readConfig(home);
    assert.strictEqual(registered.plugins.length, 1);
    const text = fs.readFileSync(configPath(home), "utf8");
    const duplicated = text.replace(
      /("plugins"\s*:\s*\[[^\]]*\])/,
      (_match, first) => `${first},\n  "plugins": ["/a/opencode-plugin-v2"]`
    );
    assert.notStrictEqual(duplicated, text, "duplicate plugins key inserted");
    fs.writeFileSync(configPath(home), duplicated);

    const result = unregisterOpencodePlugin({ silent: true, ...managedRoots(home) });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "config-corrupt");
    assert.strictEqual(result.registrationRemoved, false);
    // Byte-identical proves the guard fired BEFORE any sweep mutated the file.
    assert.strictEqual(fs.readFileSync(configPath(home), "utf8"), duplicated, "config is never touched");
  });

  it("describeV2Remediation names the plugins key, not plugin", () => {
    const remediation = v2Registry.describeV2Remediation(
      { rawEntry: "/bad/path", index: 2 },
      "/tmp/opencode.json"
    );
    assert.ok(remediation.steps.join(" ").includes('"plugins"'));
    assert.strictEqual(remediation.index, 2);
  });
});
