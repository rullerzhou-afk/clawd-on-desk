const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerKimiHooks,
  KIMI_HOOK_EVENTS,
  normalizePermissionMode,
  extractExistingPermissionMode,
  MODE_EXPLICIT,
  MODE_SUSPECT,
} = require("../hooks/kimi-install");

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

  it("deduplicates repeated Clawd Kimi hook blocks", () => {
    const { settingsPath } = makeTempKimiHome();
    const repeatedBlocks = KIMI_HOOK_EVENTS.map((event) => `[[hooks]]
event = "${event}"
command = '"/usr/local/bin/node" "/old/path/kimi-hook.js"'
matcher = ""
timeout = 30
`).join("\n");
    fs.writeFileSync(
      settingsPath,
      `default_model = "kimi-for-coding"\n\n${repeatedBlocks}\n${repeatedBlocks}\n`,
      "utf8"
    );

    const result = registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionMode: MODE_SUSPECT,
    });

    const content = fs.readFileSync(settingsPath, "utf8");
    const blocks = [...content.matchAll(/\[\[hooks\]\][\s\S]*?(?=\n\[\[hooks\]\]|\s*$)/g)].map((m) => m[0]);
    const clawdBlocks = blocks.filter((block) => (
      /command\s*=\s*(?:"[^"]*kimi-hook\.js[^"]*"|'[^']*kimi-hook\.js[^']*')/.test(block)
    ));
    assert.strictEqual(clawdBlocks.length, KIMI_HOOK_EVENTS.length);
    for (const event of KIMI_HOOK_EVENTS) {
      const count = clawdBlocks.filter((block) => block.includes(`event = "${event}"`)).length;
      assert.strictEqual(count, 1, `event ${event} should appear exactly once`);
    }
    assert.ok(content.includes("CLAWD_KIMI_PERMISSION_MODE=suspect"));
    assert.ok(result.updated >= 1);
  });

  it("matches and normalizes double-quoted command strings with escaped quotes", () => {
    const { settingsPath } = makeTempKimiHome();
    const escapedCommand = 'command = "CLAWD_KIMI_PERMISSION_MODE=suspect \\"/usr/local/bin/node\\" \\"/old/path/kimi-hook.js\\""';
    fs.writeFileSync(
      settingsPath,
      `default_model = "kimi-for-coding"\n\n[[hooks]]\nevent = "PreToolUse"\n${escapedCommand}\nmatcher = ""\ntimeout = 30\n`,
      "utf8"
    );
    const result = registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionMode: MODE_SUSPECT,
    });
    const content = fs.readFileSync(settingsPath, "utf8");
    const commandLines = content.match(/command\s*=\s*.+/g) || [];
    const markerCommands = commandLines.filter((line) => line.includes("kimi-hook.js"));
    assert.strictEqual(markerCommands.length, KIMI_HOOK_EVENTS.length);
    assert.ok(result.updated >= 1);
  });

  it("preserves user-authored sections that follow Clawd hook blocks", () => {
    // Regression: the old lookahead-based strip greedily swallowed anything
    // between the first Clawd [[hooks]] and EOF, wiping user-added tables
    // like [server] / [[tools]] / [mcp] on every startup auto-sync.
    const { settingsPath } = makeTempKimiHome();
    const legacy = [
      'default_model = "kimi-for-coding"',
      "",
      "[[hooks]]",
      'event = "PreToolUse"',
      "command = '\"node\" \"/opt/clawd/hooks/kimi-hook.js\"'",
      'matcher = ""',
      "timeout = 30",
      "",
      "[server]",
      "port = 8080",
      "",
      "[[tools]]",
      'name = "example"',
      "",
      "[mcp]",
      'enabled = true',
      "",
    ].join("\n");
    fs.writeFileSync(settingsPath, legacy, "utf8");

    registerKimiHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const after = fs.readFileSync(settingsPath, "utf8");
    assert.ok(after.includes("[server]"), "user-added [server] section must survive");
    assert.ok(after.includes("port = 8080"), "[server] content must survive");
    assert.ok(after.includes("[[tools]]"), "user-added [[tools]] must survive");
    assert.ok(after.includes('name = "example"'), "[[tools]] content must survive");
    assert.ok(after.includes("[mcp]"), "user-added [mcp] section must survive");
    assert.ok(after.includes("enabled = true"), "[mcp] content must survive");
    const markerLines = after.match(/command\s*=.*kimi-hook\.js/g) || [];
    assert.strictEqual(markerLines.length, KIMI_HOOK_EVENTS.length);
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

  it("writes CLAWD_KIMI_PERMISSION_MODE into hook command when provided", () => {
    const { settingsPath } = makeTempKimiHome();
    registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionMode: MODE_SUSPECT,
    });
    const content = fs.readFileSync(settingsPath, "utf8");
    assert.ok(content.includes("CLAWD_KIMI_PERMISSION_MODE=suspect"));
  });

  it("normalizes permission mode values", () => {
    assert.strictEqual(normalizePermissionMode("explicit"), MODE_EXPLICIT);
    assert.strictEqual(normalizePermissionMode("suspect"), MODE_SUSPECT);
    assert.strictEqual(normalizePermissionMode("SUSPECT"), MODE_SUSPECT);
    assert.strictEqual(normalizePermissionMode("  explicit  "), MODE_EXPLICIT);
    assert.strictEqual(normalizePermissionMode("other"), null);
  });

  it("extracts the permission mode baked into an existing command line", () => {
    const content = `
[[hooks]]
event = "PreToolUse"
command = 'CLAWD_KIMI_PERMISSION_MODE=suspect "/usr/bin/node" "/some/path/kimi-hook.js"'
`;
    assert.strictEqual(extractExistingPermissionMode(content), MODE_SUSPECT);
    assert.strictEqual(extractExistingPermissionMode(""), null);
    assert.strictEqual(extractExistingPermissionMode("command = \"echo hello\""), null);
  });

  it("preserves existing CLAWD_KIMI_PERMISSION_MODE across env-less re-syncs", () => {
    const { settingsPath } = makeTempKimiHome();

    // First install: user explicitly opts into suspect mode.
    registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionMode: MODE_SUSPECT,
    });
    const afterFirst = fs.readFileSync(settingsPath, "utf8");
    assert.ok(afterFirst.includes("CLAWD_KIMI_PERMISSION_MODE=suspect"));

    // Second install emulates Clawd's startup auto-sync when the env var
    // is NOT set. Before the fix this path silently stripped the prefix.
    const prevEnv = process.env.CLAWD_KIMI_PERMISSION_MODE;
    delete process.env.CLAWD_KIMI_PERMISSION_MODE;
    try {
      registerKimiHooks({
        silent: true,
        settingsPath,
        nodeBin: "/usr/local/bin/node",
      });
    } finally {
      if (prevEnv === undefined) delete process.env.CLAWD_KIMI_PERMISSION_MODE;
      else process.env.CLAWD_KIMI_PERMISSION_MODE = prevEnv;
    }

    const afterSecond = fs.readFileSync(settingsPath, "utf8");
    assert.ok(
      afterSecond.includes("CLAWD_KIMI_PERMISSION_MODE=suspect"),
      "env-less re-sync should preserve the previously written mode prefix"
    );
  });

  it("extracts mode from double-quoted commands with escaped inner quotes", () => {
    // Reproduces the historical config.toml shape that broke env-less re-sync:
    // outer "..." with internal \"...\" around the node path. The naive
    // [^"]* regex truncated before MARKER and silently returned null.
    const toml = [
      "[[hooks]]",
      'event = "PreToolUse"',
      'command = "CLAWD_KIMI_PERMISSION_MODE=suspect \\"/usr/local/bin/node\\" \\"/opt/clawd/hooks/kimi-hook.js\\""',
      'matcher = ""',
      "timeout = 30",
      "",
    ].join("\n");
    assert.strictEqual(extractExistingPermissionMode(toml), MODE_SUSPECT);
  });

  it("preserves mode across re-sync when prior config used escaped double quotes", () => {
    const { settingsPath } = makeTempKimiHome();
    // Hand-written config that mirrors the legacy shape (double-quoted +
    // escaped inner quotes). Without the regex fix, this would be normalised
    // away because extractExistingPermissionMode's [^"]* truncated at \".
    const legacyBlocks = KIMI_HOOK_EVENTS.map((event) => [
      "[[hooks]]",
      `event = "${event}"`,
      'command = "CLAWD_KIMI_PERMISSION_MODE=suspect \\"/usr/local/bin/node\\" \\"/opt/clawd/hooks/kimi-hook.js\\""',
      'matcher = ""',
      "timeout = 30",
      "",
    ].join("\n")).join("\n");
    const legacy = `default_model = "kimi-for-coding"\n\n${legacyBlocks}`;
    fs.writeFileSync(settingsPath, legacy, "utf8");

    const prevEnv = process.env.CLAWD_KIMI_PERMISSION_MODE;
    delete process.env.CLAWD_KIMI_PERMISSION_MODE;
    try {
      registerKimiHooks({
        silent: true,
        settingsPath,
        nodeBin: "/usr/local/bin/node",
      });
    } finally {
      if (prevEnv === undefined) delete process.env.CLAWD_KIMI_PERMISSION_MODE;
      else process.env.CLAWD_KIMI_PERMISSION_MODE = prevEnv;
    }

    const after = fs.readFileSync(settingsPath, "utf8");
    assert.ok(
      after.includes("CLAWD_KIMI_PERMISSION_MODE=suspect"),
      "legacy escaped-quote install should keep suspect mode after env-less re-sync"
    );
  });

  it("explicit override wins over the previously written mode", () => {
    const { settingsPath } = makeTempKimiHome();
    registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionMode: MODE_SUSPECT,
    });

    // Caller explicitly switches to explicit — must overwrite the previous
    // suspect prefix, not fall through to the preserve fallback.
    registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionMode: MODE_EXPLICIT,
    });

    const content = fs.readFileSync(settingsPath, "utf8");
    assert.ok(content.includes("CLAWD_KIMI_PERMISSION_MODE=explicit"));
    assert.ok(!content.includes("CLAWD_KIMI_PERMISSION_MODE=suspect"));
  });
});
