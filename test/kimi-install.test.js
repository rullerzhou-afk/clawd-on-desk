const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { registerKimiHooks, KIMI_HOOK_EVENTS } = require("../hooks/kimi-install");

const tempDirs = [];

function makeTempKimiHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kimi-"));
  const kimiDir = path.join(root, ".kimi");
  fs.mkdirSync(kimiDir, { recursive: true });
  tempDirs.push(root);
  return { root, kimiDir, settingsPath: path.join(kimiDir, "config.toml") };
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Kimi hook installer", () => {
  it("creates config.toml if it does not exist", () => {
    const { settingsPath } = makeTempKimiHome();

    const result = registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(fs.existsSync(settingsPath));
    const content = fs.readFileSync(settingsPath, "utf8");
    assert.ok(content.includes("[[hooks]]"));
    assert.ok(content.includes('event = "PreToolUse"'));
    assert.ok(content.includes("kimi-hook.js"));
    assert.ok(content.includes("/usr/local/bin/node"));
    assert.strictEqual(result.added, KIMI_HOOK_EVENTS.length);
  });

  it("replaces empty hooks = [] with [[hooks]] blocks", () => {
    const { settingsPath } = makeTempKimiHome();
    fs.writeFileSync(settingsPath, "default_model = \"kimi-for-coding\"\nhooks = []\n", "utf8");

    const result = registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    const content = fs.readFileSync(settingsPath, "utf8");
    assert.ok(!content.includes("hooks = []"));
    assert.ok(content.includes("[[hooks]]"));
    assert.strictEqual(result.added, KIMI_HOOK_EVENTS.length);
  });

  it("appends hooks to existing config.toml", () => {
    const { settingsPath } = makeTempKimiHome();
    fs.writeFileSync(
      settingsPath,
      'default_model = "kimi-for-coding"\n\n[[hooks]]\nevent = "SessionStart"\ncommand = "echo hello"\nmatcher = ""\ntimeout = 10\n',
      "utf8"
    );

    const result = registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    const content = fs.readFileSync(settingsPath, "utf8");
    assert.ok(content.includes('command = "echo hello"'));
    assert.ok(content.includes("kimi-hook.js"));
    assert.strictEqual(result.added, KIMI_HOOK_EVENTS.length);
  });

  it("skips when hooks are already registered", () => {
    const { settingsPath } = makeTempKimiHome();
    registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    const result = registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.skipped, 1);
  });

  it("updates stale hook paths without duplicating entries", () => {
    const { settingsPath } = makeTempKimiHome();
    fs.writeFileSync(
      settingsPath,
      'default_model = "kimi-for-coding"\n\n[[hooks]]\nevent = "PreToolUse"\ncommand = "/old/node /old/path/kimi-hook.js"\nmatcher = ""\ntimeout = 30\n',
      "utf8"
    );

    const result = registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    const content = fs.readFileSync(settingsPath, "utf8");
    assert.ok(!content.includes("/old/path/kimi-hook.js"));
    assert.ok(content.includes("/usr/local/bin/node"));
    assert.ok(content.includes("hooks/kimi-hook.js"));
    assert.ok(result.updated >= 1);
  });

  it("skips when ~/.kimi/ does not exist", () => {
    const { root } = makeTempKimiHome();
    const settingsPath = path.join(root, ".kimi-not-exist", "config.toml");
    const result = registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0 });
    assert.ok(!fs.existsSync(settingsPath));
  });
});
