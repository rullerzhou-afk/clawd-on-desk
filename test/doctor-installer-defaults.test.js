const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");

describe("installer default path exports", () => {
  it("exports default config locations for hook-based agents", () => {
    const home = os.homedir();
    const claude = require("../hooks/install");
    const codex = require("../hooks/codex-install");
    const cursor = require("../hooks/cursor-install");
    const gemini = require("../hooks/gemini-install");
    const codebuddy = require("../hooks/codebuddy-install");
    const kiro = require("../hooks/kiro-install");
    const kimi = require("../hooks/kimi-install");
    const opencode = require("../hooks/opencode-install");
    const pi = require("../hooks/pi-install");
    const hermes = require("../hooks/hermes-install");

    assert.strictEqual(claude.DEFAULT_PARENT_DIR, path.join(home, ".claude"));
    assert.strictEqual(claude.DEFAULT_CONFIG_PATH, path.join(home, ".claude", "settings.json"));

    assert.strictEqual(codex.DEFAULT_PARENT_DIR, path.join(home, ".codex"));
    assert.strictEqual(codex.DEFAULT_CONFIG_PATH, path.join(home, ".codex", "hooks.json"));
    assert.strictEqual(codex.DEFAULT_FEATURES_CONFIG, path.join(home, ".codex", "config.toml"));

    assert.strictEqual(cursor.DEFAULT_PARENT_DIR, path.join(home, ".cursor"));
    assert.strictEqual(cursor.DEFAULT_CONFIG_PATH, path.join(home, ".cursor", "hooks.json"));

    assert.strictEqual(gemini.DEFAULT_PARENT_DIR, path.join(home, ".gemini"));
    assert.strictEqual(gemini.DEFAULT_CONFIG_PATH, path.join(home, ".gemini", "settings.json"));

    assert.strictEqual(codebuddy.DEFAULT_PARENT_DIR, path.join(home, ".codebuddy"));
    assert.strictEqual(codebuddy.DEFAULT_CONFIG_PATH, path.join(home, ".codebuddy", "settings.json"));

    assert.strictEqual(kiro.DEFAULT_PARENT_DIR, path.join(home, ".kiro"));
    assert.strictEqual(kiro.DEFAULT_AGENTS_DIR, path.join(home, ".kiro", "agents"));

    assert.strictEqual(kimi.DEFAULT_PARENT_DIR, path.join(home, ".kimi"));
    assert.strictEqual(kimi.DEFAULT_CONFIG_PATH, path.join(home, ".kimi", "config.toml"));

    assert.strictEqual(opencode.DEFAULT_PARENT_DIR, path.join(home, ".config", "opencode"));
    assert.strictEqual(opencode.DEFAULT_CONFIG_PATH, path.join(home, ".config", "opencode", "opencode.json"));

    assert.strictEqual(pi.DEFAULT_PARENT_DIR, path.join(home, ".pi", "agent"));
    assert.strictEqual(pi.DEFAULT_EXTENSION_DIR, path.join(home, ".pi", "agent", "extensions", "clawd-on-desk"));

    assert.strictEqual(hermes.DEFAULT_PARENT_DIR, path.join(home, ".hermes"));
    assert.strictEqual(hermes.DEFAULT_PLUGIN_DIR, path.join(home, ".hermes", "plugins", "clawd-on-desk"));
  });
});
