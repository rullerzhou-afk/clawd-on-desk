const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerKimiHooks,
  unregisterKimiHooks,
  KIMI_HOOK_EVENTS,
  KIMI_CODE_HOOK_EVENTS,
  normalizePermissionMode,
  extractExistingPermissionMode,
  validateKimiCodeHookBlocks,
  MODE_EXPLICIT,
  MODE_SUSPECT,
  FLAVOR_KIMI_CODE,
} = require("../hooks/kimi-install");

// Hook command format depends on real-environment WSL signals; clear them so
// assertions stay deterministic when the suite itself runs inside WSL.
delete process.env.CLAWD_WSL_DISTRO;
delete process.env.WSL_DISTRO_NAME;

const tempDirs = [];

function makeTempKimiHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kimi-"));
  const kimiDir = path.join(root, ".kimi");
  fs.mkdirSync(kimiDir, { recursive: true });
  tempDirs.push(root);
  return { root, kimiDir, settingsPath: path.join(kimiDir, "config.toml") };
}

function listCleanupBackups(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.clawd-cleanup-`));
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

  it("unregister removes only Clawd blocks and preserves following TOML sections", () => {
    const { settingsPath } = makeTempKimiHome();
    const content = [
      'default_model = "kimi-for-coding"',
      "",
      "[[hooks]]",
      'event = "SessionStart"',
      'command = \'"node" "/opt/clawd/hooks/kimi-hook.js"\'',
      'matcher = ""',
      "timeout = 30",
      "",
      "[[hooks]]",
      'event = "SessionStart"',
      'command = "echo user hook"',
      'matcher = ""',
      "timeout = 10",
      "",
      "[server]",
      "port = 8080",
      "",
      "[mcp]",
      "enabled = true",
      "",
      "[[tools]]",
      'name = "example"',
      "",
    ].join("\n");
    fs.writeFileSync(settingsPath, content, "utf8");

    const result = unregisterKimiHooks({ silent: true, settingsPath, backup: true });

    assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.changed, true);
    const after = fs.readFileSync(settingsPath, "utf8");
    assert.ok(!after.includes("kimi-hook.js"));
    assert.ok(after.includes('command = "echo user hook"'));
    assert.ok(after.includes("[server]"));
    assert.ok(after.includes("port = 8080"));
    assert.ok(after.includes("[mcp]"));
    assert.ok(after.includes("enabled = true"));
    assert.ok(after.includes("[[tools]]"));
    assert.ok(after.includes('name = "example"'));
    assert.strictEqual(listCleanupBackups(settingsPath).length, 1);

    const second = unregisterKimiHooks({ silent: true, settingsPath, backup: true });
    assert.strictEqual(second.removed, 0);
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.settingsPath, settingsPath);
    assert.strictEqual(second.backupPath, null);
    assert.strictEqual(listCleanupBackups(settingsPath).length, 1);
  });

  it("preserves an existing absolute Windows node path when detection fails", () => {
    // Issue #317 follow-up: Kimi TOML used to lose the user's manual
    // C:\Program Files\nodejs\node.exe repair on startup auto-sync because
    // no preservation chain existed for the kimi-install path.
    const { settingsPath } = makeTempKimiHome();
    const existingWinPath = "C:\\Program Files\\nodejs\\node.exe";
    const initial = [
      'default_model = "kimi-for-coding"',
      "",
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = '"${existingWinPath}" "/opt/clawd/hooks/kimi-hook.js"'`,
      'matcher = ""',
      "timeout = 30",
      "",
    ].join("\n");
    fs.writeFileSync(settingsPath, initial, "utf8");

    registerKimiHooks({ silent: true, settingsPath, nodeBin: null });

    const after = fs.readFileSync(settingsPath, "utf8");
    assert.ok(after.includes(existingWinPath), `expected ${existingWinPath} to be preserved`);
    assert.ok(!/command\s*=\s*'"node"/.test(after), "should not downgrade to bare node");
  });

  it("skips when ~/.kimi/ does not exist", () => {
    const { root } = makeTempKimiHome();
    const settingsPath = path.join(root, ".kimi-not-exist", "config.toml");
    const result = registerKimiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.updated, 0);
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

function makeTempKimiCodeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kimi-code-"));
  const kimiCodeDir = path.join(root, ".kimi-code");
  fs.mkdirSync(kimiCodeDir, { recursive: true });
  tempDirs.push(root);
  return { root, kimiCodeDir, settingsPath: path.join(kimiCodeDir, "config.toml") };
}

describe("Kimi Code hook installer (kimi-code flavor, #563)", () => {
  it("installs all 16 events without any env prefix", () => {
    const { settingsPath } = makeTempKimiCodeHome();

    const result = registerKimiHooks({
      silent: true,
      settingsPath,
      flavor: FLAVOR_KIMI_CODE,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      permissionMode: MODE_SUSPECT,
    });

    assert.strictEqual(result.added, KIMI_CODE_HOOK_EVENTS.length);
    const content = fs.readFileSync(settingsPath, "utf8");
    for (const event of ["PermissionRequest", "PermissionResult", "Interrupt"]) {
      assert.ok(content.includes(`event = "${event}"`), `missing ${event}`);
    }
    // POSIX env prefixes never execute under cmd.exe (kimi-code hook runner
    // is spawn(shell:true) → %COMSPEC%); the kimi-code target must never
    // carry one even when a permission mode is explicitly requested.
    assert.ok(!content.includes("CLAWD_KIMI_PERMISSION_MODE"));
  });

  it("creates a hooks-only config.toml without default_model", () => {
    const { kimiCodeDir, settingsPath } = makeTempKimiCodeHome();
    assert.ok(fs.existsSync(kimiCodeDir));
    assert.ok(!fs.existsSync(settingsPath));

    registerKimiHooks({
      silent: true,
      settingsPath,
      flavor: FLAVOR_KIMI_CODE,
      nodeBin: "/usr/local/bin/node",
    });

    const content = fs.readFileSync(settingsPath, "utf8");
    // A dangling default_model alias makes kimi-code's session-create fail;
    // the created file must be hooks-only.
    assert.ok(!content.includes("default_model"));
    assert.ok(content.includes("[[hooks]]"));
  });

  it("upgrades entries migrated verbatim from ~/.kimi (env-prefix ghosts)", () => {
    const { settingsPath } = makeTempKimiCodeHome();
    // What upstream's silent legacy migration writes when the old config was
    // installed with suspect mode: a dead-on-Windows env-prefix command.
    const migrated = [
      "[[hooks]]",
      'event = "SessionStart"',
      "command = 'CLAWD_KIMI_PERMISSION_MODE=suspect \"node\" \"/opt/clawd/hooks/kimi-hook.js\"'",
      'matcher = ""',
      "timeout = 30",
      "",
      "[[hooks]]",
      'event = "PreToolUse"',
      "command = 'CLAWD_KIMI_PERMISSION_MODE=suspect \"node\" \"/opt/clawd/hooks/kimi-hook.js\"'",
      'matcher = ""',
      "timeout = 30",
      "",
    ].join("\n");
    fs.writeFileSync(settingsPath, migrated, "utf8");

    const result = registerKimiHooks({
      silent: true,
      settingsPath,
      flavor: FLAVOR_KIMI_CODE,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.updated, 1);
    const content = fs.readFileSync(settingsPath, "utf8");
    assert.ok(!content.includes("CLAWD_KIMI_PERMISSION_MODE"));
    const blockCount = (content.match(/\[\[hooks\]\]/g) || []).length;
    assert.strictEqual(blockCount, KIMI_CODE_HOOK_EVENTS.length);
  });

  it("preserves user hooks and other sections while rewriting Clawd blocks", () => {
    const { settingsPath } = makeTempKimiCodeHome();
    const content = [
      'default_model = "kimi-k2.5"',
      "",
      "[providers.relay]",
      'type = "openai"',
      'base_url = "https://example.invalid/v1"',
      "",
      "[[hooks]]",
      'event = "Notification"',
      'command = "terminal-notifier -title Kimi"',
      'matcher = "task\\\\.completed"',
      "timeout = 10",
      "",
      "[[hooks]]",
      'event = "SessionStart"',
      "command = '\"node\" \"/opt/clawd/hooks/kimi-hook.js\"'",
      'matcher = ""',
      "timeout = 30",
      "",
    ].join("\n");
    fs.writeFileSync(settingsPath, content, "utf8");

    registerKimiHooks({
      silent: true,
      settingsPath,
      flavor: FLAVOR_KIMI_CODE,
      nodeBin: "/usr/local/bin/node",
    });

    const after = fs.readFileSync(settingsPath, "utf8");
    assert.ok(after.includes('default_model = "kimi-k2.5"'));
    assert.ok(after.includes("[providers.relay]"));
    assert.ok(after.includes("terminal-notifier -title Kimi"));
    const blockCount = (after.match(/\[\[hooks\]\]/g) || []).length;
    assert.strictEqual(blockCount, KIMI_CODE_HOOK_EVENTS.length + 1);
  });

  it("unregister clears both generations via settingsPaths", () => {
    const legacy = makeTempKimiHome();
    const kimiCode = makeTempKimiCodeHome();
    registerKimiHooks({ silent: true, settingsPath: legacy.settingsPath, nodeBin: "/usr/bin/node" });
    registerKimiHooks({
      silent: true,
      settingsPath: kimiCode.settingsPath,
      flavor: FLAVOR_KIMI_CODE,
      nodeBin: "/usr/bin/node",
    });

    const result = unregisterKimiHooks({
      silent: true,
      settingsPaths: [legacy.settingsPath, kimiCode.settingsPath],
    });

    assert.strictEqual(result.removed, KIMI_HOOK_EVENTS.length + KIMI_CODE_HOOK_EVENTS.length);
    assert.strictEqual(result.changed, true);
    assert.ok(!fs.readFileSync(legacy.settingsPath, "utf8").includes("kimi-hook.js"));
    assert.ok(!fs.readFileSync(kimiCode.settingsPath, "utf8").includes("kimi-hook.js"));
  });

  it("aggregateRegisterResults surfaces partial failure as an error status", () => {
    const { aggregateRegisterResults } = require("../hooks/kimi-install");
    const ok = { added: 0, skipped: 1, updated: 0, flavor: "legacy", settingsPath: "/a/.kimi/config.toml" };
    const bad = {
      added: 0, skipped: 0, updated: 0,
      flavor: "kimi-code", settingsPath: "/a/.kimi-code/config.toml",
      error: "validation failed",
    };

    // Partial failure: counts stay, but status must flip to error so
    // integration-sync does not report "ok" / "not installed".
    const partial = aggregateRegisterResults([ok, bad], [new Error("validation failed")]);
    assert.strictEqual(partial.status, "error");
    assert.ok(partial.message.includes(".kimi-code"));
    assert.strictEqual(partial.skipped, 1);

    // All targets failing throws (single-target contract).
    assert.throws(
      () => aggregateRegisterResults([{ ...bad }, { ...bad }], [new Error("x"), new Error("y")]),
      /x/
    );

    // No failure: no status field, counts only.
    const clean = aggregateRegisterResults([ok], []);
    assert.strictEqual(clean.status, undefined);
    assert.strictEqual(clean.skipped, 1);
  });

  it("validateKimiCodeHookBlocks rejects blocks the strict schema would drop", () => {
    assert.throws(
      () => validateKimiCodeHookBlocks('[[hooks]]\nevent = "NotARealEvent"\ncommand = \'x\'\nmatcher = ""\ntimeout = 30\n', KIMI_CODE_HOOK_EVENTS),
      /unknown event/
    );
    assert.throws(
      () => validateKimiCodeHookBlocks('[[hooks]]\nevent = "Stop"\ncommand = \'x\'\nmatcher = ""\ntimeout = 30\nenv = "X=1"\n', KIMI_CODE_HOOK_EVENTS),
      /illegal key/
    );
    assert.throws(
      () => validateKimiCodeHookBlocks('[[hooks]]\nevent = "Stop"\ncommand = \'x\'\nmatcher = ""\ntimeout = 999\n', KIMI_CODE_HOOK_EVENTS),
      /timeout out of range/
    );
    assert.throws(
      () => validateKimiCodeHookBlocks('[[hooks]]\nevent = "Stop"\ncommand = \'x\'\ntimeout = 30\n', KIMI_CODE_HOOK_EVENTS),
      /missing key "matcher"/
    );
  });
});
