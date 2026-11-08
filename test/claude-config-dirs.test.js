"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const {
  MAX_CLAUDE_CONFIG_DIRS,
  normalizeClaudeConfigDir,
  normalizeClaudeConfigDirLabel,
  normalizeClaudeConfigDirEntries,
  sameClaudeConfigDir,
  resolvePrimaryClaudeConfigDir,
  deriveClaudeProfileLabel,
  effectiveClaudeConfigDirs,
  extraClaudeConfigDirs,
  claudeProfileLabelFor,
} = require("../hooks/claude-config-dirs");
const prefs = require("../src/prefs");

const linux = { platform: "linux", homeDir: "/home/u", env: {} };

describe("claude config dir normalization", () => {
  it("accepts absolute folders and strips trailing separators", () => {
    assert.strictEqual(normalizeClaudeConfigDir("/home/u/.claude-work/", linux), "/home/u/.claude-work");
    assert.strictEqual(normalizeClaudeConfigDir(" /home/u/a/../.claude ", linux), "/home/u/.claude");
    assert.strictEqual(normalizeClaudeConfigDir("/", linux), "/");
    assert.strictEqual(normalizeClaudeConfigDir("C:\\Users\\u\\.claude-work\\", { platform: "win32" }), "C:\\Users\\u\\.claude-work");
  });

  it("rejects relative, empty, control-character and non-string values", () => {
    for (const value of ["", "   ", ".claude", "~/.claude", "/a\nb", null, 42, {}]) {
      assert.strictEqual(normalizeClaudeConfigDir(value, linux), null, String(value));
    }
  });

  it("compares folders case-insensitively only on case-insensitive platforms", () => {
    assert.strictEqual(sameClaudeConfigDir("/Users/u/.Claude-Work", "/Users/u/.claude-work", { platform: "darwin" }), true);
    assert.strictEqual(sameClaudeConfigDir("/home/u/.Claude-Work", "/home/u/.claude-work", linux), false);
  });

  it("keeps labels short, single-line and trimmed", () => {
    assert.strictEqual(normalizeClaudeConfigDirLabel("  work\n stuff "), "work stuff");
    assert.strictEqual(normalizeClaudeConfigDirLabel("x".repeat(40)).length, 24);
    assert.strictEqual(normalizeClaudeConfigDirLabel(7), "");
  });

  it("dedupes and caps entries, accepting bare strings", () => {
    const raw = [
      "/home/u/.claude-work",
      { dir: "/home/u/.claude-work/", label: "dup" },
      { dir: "relative" },
      { dir: "/home/u/.claude-x", label: " X " },
      ...Array.from({ length: 20 }, (_, i) => ({ dir: `/home/u/p${i}` })),
    ];
    const out = normalizeClaudeConfigDirEntries(raw, linux);
    assert.strictEqual(out.length, MAX_CLAUDE_CONFIG_DIRS);
    assert.deepStrictEqual(out[0], { dir: "/home/u/.claude-work", label: "" });
    assert.deepStrictEqual(out[1], { dir: "/home/u/.claude-x", label: "X" });
  });
});

describe("claude profile labels", () => {
  it("derives a short name from the folder", () => {
    assert.strictEqual(deriveClaudeProfileLabel("/home/u/.claude", linux), "default");
    assert.strictEqual(deriveClaudeProfileLabel("/home/u/.claude-work", linux), "work");
    assert.strictEqual(deriveClaudeProfileLabel("/home/u/.claude_personal", linux), "personal");
    assert.strictEqual(deriveClaudeProfileLabel("/srv/claude/acme", linux), "acme");
    assert.strictEqual(deriveClaudeProfileLabel("/home/u/.claude2", linux), "claude2");
  });

  it("resolves the primary folder like the installer", () => {
    assert.strictEqual(resolvePrimaryClaudeConfigDir(linux), "/home/u/.claude");
    assert.strictEqual(
      resolvePrimaryClaudeConfigDir({ ...linux, env: { CLAUDE_CONFIG_DIR: "/home/u/.claude-work/" } }),
      "/home/u/.claude-work"
    );
  });

  it("lists the primary folder first and uses a primary entry only for its label", () => {
    const entries = [
      { dir: "/home/u/.claude-work", label: "" },
      { dir: "/home/u/.claude", label: "personal" },
    ];
    assert.deepStrictEqual(effectiveClaudeConfigDirs(entries, linux), [
      { dir: "/home/u/.claude", label: "personal", primary: true },
      { dir: "/home/u/.claude-work", label: "work", primary: false },
    ]);
    assert.deepStrictEqual(extraClaudeConfigDirs(entries, linux), ["/home/u/.claude-work"]);
  });

  it("follows an explicit primary folder", () => {
    const effective = effectiveClaudeConfigDirs([{ dir: "/home/u/.claude", label: "" }], {
      ...linux,
      primaryDir: "/home/u/.claude-work",
    });
    assert.deepStrictEqual(effective.map((entry) => [entry.dir, entry.label, entry.primary]), [
      ["/home/u/.claude-work", "work", true],
      ["/home/u/.claude", "default", false],
    ]);
  });

  it("labels sessions only when more than one folder is managed", () => {
    const single = effectiveClaudeConfigDirs([], linux);
    assert.strictEqual(claudeProfileLabelFor(null, single, linux), "");
    const both = effectiveClaudeConfigDirs([{ dir: "/home/u/.claude-work", label: "Job" }], linux);
    assert.strictEqual(claudeProfileLabelFor(null, both, linux), "default");
    assert.strictEqual(claudeProfileLabelFor("/home/u/.claude-work", both, linux), "Job");
    // A folder Clawd does not manage still gets a readable name.
    assert.strictEqual(claudeProfileLabelFor("/home/u/.claude-side", both, linux), "side");
  });
});

describe("prefs agents.claude-code.configDirs", () => {
  it("normalizes the folder list and leaves other agents alone", () => {
    // prefs.validate normalizes with the host's path rules, so build the
    // fixture as a host absolute path (D:\tmp\.claude-work on Windows).
    const workDir = path.resolve("/tmp/.claude-work");
    const out = prefs.validate({
      agents: {
        "claude-code": {
          integrationInstalled: true,
          enabled: true,
          configDirs: [{ dir: `${workDir}${path.sep}`, label: " work " }, { dir: "nope" }, 5],
        },
        codex: { enabled: true, configDirs: [{ dir: path.resolve("/tmp/x") }] },
      },
    });
    assert.deepStrictEqual(out.agents["claude-code"].configDirs, [{ dir: workDir, label: "work" }]);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(out.agents.codex, "configDirs"), false);
  });

  it("does not add the field to defaults", () => {
    const defaults = prefs.getDefaults();
    assert.strictEqual(Object.prototype.hasOwnProperty.call(defaults.agents["claude-code"], "configDirs"), false);
  });
});
