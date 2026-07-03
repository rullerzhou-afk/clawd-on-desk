const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  CODEX_OFFICIAL_HOOK_EVENTS,
  CODEX_STATE_HOOK_EVENTS,
  buildCodexStateHookCommand,
  registerCodexHooks,
  unregisterCodexHooks,
} = require("../hooks/codex-install");
const { CODEX_DEBUG_HOOK_EVENTS, registerCodexDebugHooks } = require("../hooks/codex-debug-install");

const MARKER = "codex-hook.js";
const DEBUG_MARKER = "codex-debug-hook.js";
const tempDirs = [];

function makeTempCodexDir(initialHooks = null, configText = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-install-"));
  const codexDir = path.join(tmpDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  if (initialHooks !== null) {
    fs.writeFileSync(path.join(codexDir, "hooks.json"), JSON.stringify(initialHooks, null, 2), "utf8");
  }
  if (configText !== null) {
    fs.writeFileSync(path.join(codexDir, "config.toml"), configText, "utf8");
  }
  tempDirs.push(tmpDir);
  return codexDir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Codex official hook installer", () => {
  it("registers official hook events on fresh install including PermissionRequest", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.added, CODEX_STATE_HOOK_EVENTS.length);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.configChanged, true);
    assert.deepStrictEqual(CODEX_STATE_HOOK_EVENTS, CODEX_OFFICIAL_HOOK_EVENTS);

    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]), `missing ${event}`);
      assert.strictEqual(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, "matcher"), false);
      const hook = entry.hooks[0];
      assert.strictEqual(hook.type, "command");
      assert.strictEqual(hook.timeout, event === "PermissionRequest" ? 600 : 30);
      assert.ok(hook.command.includes(MARKER));
      assert.ok(hook.command.includes("/usr/local/bin/node"));
    }
  });

  it("is idempotent on second run", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });
    const before = fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8");

    const result = registerCodexHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, CODEX_OFFICIAL_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8"), before);
  });

  it("coexists with debug hooks without updating them", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexDebugHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });

    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/opt/homebrew/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      const commands = settings.hooks[event].flatMap((entry) => entry.hooks.map((hook) => hook.command));
      assert.ok(commands.some((command) => command.includes(MARKER)));
      assert.ok(commands.some((command) => command.includes(DEBUG_MARKER)));
    }
    assert.ok(settings.hooks.PermissionRequest[0].hooks[0].command.includes(DEBUG_MARKER));
  });

  it("does not flip an explicit hooks=false", () => {
    const codexDir = makeTempCodexDir({}, "[features]\nhooks = false\n");
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.configChanged, false);
    assert.match(result.warnings[0], /hooks = false/);
    assert.strictEqual(
      fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"),
      "[features]\nhooks = false\n"
    );
  });

  it("migrates legacy codex_hooks=false without enabling it", () => {
    const codexDir = makeTempCodexDir({}, "[features]\ncodex_hooks = false\n");
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.configChanged, true);
    assert.match(result.warnings[0], /hooks = false/);
    assert.strictEqual(
      fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"),
      "[features]\nhooks = false\n"
    );
  });

  it("can force hooks=true during an explicit repair", () => {
    const codexDir = makeTempCodexDir({}, "[features]\nhooks = false\n");
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
      forceCodexHooksFeature: true,
    });

    assert.strictEqual(result.configChanged, true);
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(
      fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"),
      "[features]\nhooks = true\n"
    );
  });

  it("formats Windows commands for PowerShell execution", () => {
    const command = buildCodexStateHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "D:/animation/hooks/codex-hook.js",
      "win32"
    );

    assert.strictEqual(command, '& "C:\\Program Files\\nodejs\\node.exe" "D:/animation/hooks/codex-hook.js"');
  });

  it("registers remote hooks with CLAWD_REMOTE in the command environment", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
      remote: true,
    });

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    assert.strictEqual(
      command,
      "CLAWD_REMOTE='1' \"/usr/local/bin/node\" \"" + path.resolve(__dirname, "..", "hooks", "codex-hook.js").replace(/\\/g, "/") + "\""
    );
  });

  it("registers Windows remote hooks with a PowerShell env prefix on commandWindows only", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "C:\\node.exe",
      platform: "win32",
      remote: true,
    });

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    const hook = settings.hooks.SessionStart[0].hooks[0];
    const hookScript = path.resolve(__dirname, "..", "hooks", "codex-hook.js").replace(/\\/g, "/");
    // PowerShell env prefix lives on commandWindows (what Windows codex runs).
    assert.strictEqual(
      hook.commandWindows,
      `$env:CLAWD_REMOTE='1'; & "C:\\node.exe" "${hookScript}"`
    );
    // The POSIX command must NOT carry an env prefix: env vars don't cross
    // the WSL interop boundary, so a prefix would only mislead readers.
    assert.strictEqual(hook.command, `"/mnt/c/node.exe" "${hookScript}"`);
    assert.ok(result.warnings.some((w) => /interop/.test(w)));
  });

  it("unregisters only official state hooks", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexDebugHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });
    registerCodexHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });

    const result = unregisterCodexHooks({ silent: true, codexDir });

    assert.strictEqual(result.removed, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      const commands = settings.hooks[event].flatMap((entry) => entry.hooks.map((hook) => hook.command));
      assert.ok(!commands.some((command) => command.includes(MARKER)));
      assert.ok(commands.some((command) => command.includes(DEBUG_MARKER)));
    }
    assert.strictEqual(settings.hooks.PermissionRequest.length, 1);
    assert.strictEqual(CODEX_DEBUG_HOOK_EVENTS.includes("PermissionRequest"), true);
  });

  // Verifies the v0.7.x follow-up that points users at codex's `/hooks` review
  // step. Without this reminder, fresh installs leave hooks Active=0 and the
  // desktop pet stays silent until the user randomly discovers the review UI.
  it("emits a 'Next step: open codex CLI and run /hooks' reminder on non-silent install", () => {
    const codexDir = makeTempCodexDir({});
    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => captured.push(args.join(" "));
    try {
      registerCodexHooks({
        silent: false,
        codexDir,
        nodeBin: "/usr/local/bin/node",
        platform: "linux",
      });
    } finally {
      console.log = originalLog;
    }
    const joined = captured.join("\n");
    assert.match(joined, /Next step:.*codex.*\/hooks/i,
      "stdout must include the codex /hooks review reminder");
  });

  it("does NOT emit the reminder when silent: true (deploy / sync paths use silent)", () => {
    const codexDir = makeTempCodexDir({});
    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => captured.push(args.join(" "));
    try {
      registerCodexHooks({
        silent: true,
        codexDir,
        nodeBin: "/usr/local/bin/node",
        platform: "linux",
      });
    } finally {
      console.log = originalLog;
    }
    assert.equal(captured.length, 0, "silent install must not log reminder (or anything else)");
  });

  it("does NOT emit the reminder line on no-op re-install (summary lines still emit)", () => {
    // Semantics being asserted: "no-op re-install does not print the
    // /hooks-review reminder line". This is intentionally narrower than
    // "no-op re-install is fully silent on stdout" — `Clawd Codex hooks ->`
    // and `Added: 0, updated: 0, skipped: N` summary lines are useful for
    // CLI users who re-run the installer (they confirm the install is
    // already in place). Only the reminder is gated on actual changes,
    // so users don't get warning fatigue from re-running an idempotent
    // install.
    const codexDir = makeTempCodexDir({});
    // First install: changes happen, reminder fires.
    registerCodexHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });
    // Second install: idempotent, nothing added/updated/configChanged.
    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => captured.push(args.join(" "));
    try {
      registerCodexHooks({
        silent: false,
        codexDir,
        nodeBin: "/usr/local/bin/node",
        platform: "linux",
      });
    } finally {
      console.log = originalLog;
    }
    const joined = captured.join("\n");
    assert.equal(/Next step/i.test(joined), false,
      "no-op re-install must NOT print the reminder line");
    // Confirm summary lines DO still emit (this is the contract — keep
    // CLI feedback for users who want to verify the install state).
    assert.match(joined, /Clawd .* hooks/, "summary header should still print");
    assert.match(joined, /Added: 0/, "Added/updated/skipped count should still print");
  });
});

// #544: a hooks.json written by Windows Clawd may be shared with WSL codex
// through CODEX_HOME. Codex resolves commandWindows on Windows and command on
// POSIX, so Windows installs must write both fields: PowerShell syntax in
// commandWindows, a WSL-interop (Windows node.exe) form in command.
describe("Codex hooks on a Windows host write dual command fields (#544)", () => {
  const HOOK_SCRIPT = path.resolve(__dirname, "..", "hooks", "codex-hook.js").replace(/\\/g, "/");
  const {
    buildCodexHookPosixInteropCommand,
    windowsPathToWslPath,
  } = require("../hooks/codex-install-utils");

  it("translates Windows absolute paths to WSL /mnt form", () => {
    assert.strictEqual(
      windowsPathToWslPath("C:\\Program Files\\nodejs\\node.exe"),
      "/mnt/c/Program Files/nodejs/node.exe"
    );
    assert.strictEqual(windowsPathToWslPath("D:/Tool/Clawd on Desk/x.js"), "/mnt/d/Tool/Clawd on Desk/x.js");
    assert.strictEqual(windowsPathToWslPath("node"), null);
    assert.strictEqual(windowsPathToWslPath("/usr/bin/node"), null);
  });

  it("builds the interop command from a bare node bin by appending .exe", () => {
    assert.strictEqual(
      buildCodexHookPosixInteropCommand("node", "D:/x/codex-hook.js"),
      '"node.exe" "D:/x/codex-hook.js"'
    );
    assert.strictEqual(
      buildCodexHookPosixInteropCommand("node.exe", "D:/x/codex-hook.js"),
      '"node.exe" "D:/x/codex-hook.js"'
    );
  });

  it("fresh Windows install writes PowerShell commandWindows and interop command", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      const hook = settings.hooks[event][0].hooks[0];
      assert.strictEqual(
        hook.commandWindows,
        `& "C:\\Program Files\\nodejs\\node.exe" "${HOOK_SCRIPT}"`
      );
      assert.strictEqual(
        hook.command,
        `"/mnt/c/Program Files/nodejs/node.exe" "${HOOK_SCRIPT}"`
      );
    }
  });

  it("is idempotent on second Windows run", () => {
    const codexDir = makeTempCodexDir({});
    const opts = { silent: true, codexDir, nodeBin: "C:\\node.exe", platform: "win32" };
    registerCodexHooks(opts);
    const before = fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8");

    const result = registerCodexHooks(opts);

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, CODEX_OFFICIAL_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8"), before);
  });

  it("upgrades a legacy Windows entry (PowerShell command, no commandWindows) in place", () => {
    const legacyCommand = `& "node" "${HOOK_SCRIPT}"`;
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: legacyCommand, timeout: 30 }] }],
      },
    });

    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "node",
      platform: "win32",
    });

    assert.strictEqual(result.updated, 1);
    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length - 1);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    const hook = settings.hooks.SessionStart[0].hooks[0];
    // commandWindows takes over the exact PowerShell form command used to
    // hold, so Windows codex resolves the same string (trusted_hash intact).
    assert.strictEqual(hook.commandWindows, legacyCommand);
    assert.strictEqual(hook.command, `"node.exe" "${HOOK_SCRIPT}"`);
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
  });

  it("preserves a user-repaired node path found in commandWindows", () => {
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command: `"node.exe" "${HOOK_SCRIPT}"`,
            commandWindows: `& "E:\\custom\\node.exe" "${HOOK_SCRIPT}"`,
            timeout: 30,
          }],
        }],
      },
    });

    registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: null, // force the extract-existing fallback
      platform: "win32",
    });

    const settings = readJson(path.join(codexDir, "hooks.json"));
    const hook = settings.hooks.SessionStart[0].hooks[0];
    assert.strictEqual(hook.commandWindows, `& "E:\\custom\\node.exe" "${HOOK_SCRIPT}"`);
    assert.strictEqual(hook.command, `"/mnt/e/custom/node.exe" "${HOOK_SCRIPT}"`);
  });

  it("does not extract the derived /mnt interop path back as a node bin", () => {
    // command holds /mnt/c/... (derived); commandWindows holds the source of
    // truth. The fallback must not launder the POSIX form into commandWindows.
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command: `"/mnt/c/tools/node.exe" "${HOOK_SCRIPT}"`,
            commandWindows: `& "C:\\tools\\node.exe" "${HOOK_SCRIPT}"`,
            timeout: 30,
          }],
        }],
      },
    });

    registerCodexHooks({ silent: true, codexDir, nodeBin: null, platform: "win32" });

    const settings = readJson(path.join(codexDir, "hooks.json"));
    const hook = settings.hooks.SessionStart[0].hooks[0];
    assert.strictEqual(hook.commandWindows, `& "C:\\tools\\node.exe" "${HOOK_SCRIPT}"`);
    assert.strictEqual(hook.command, `"/mnt/c/tools/node.exe" "${HOOK_SCRIPT}"`);
  });

  it("POSIX installs never write commandWindows", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      const hook = settings.hooks[event][0].hooks[0];
      assert.strictEqual(Object.prototype.hasOwnProperty.call(hook, "commandWindows"), false);
    }
  });

  // codex review finding: a POSIX host must never claim an entry whose only
  // Clawd trace is a leftover commandWindows — its command may be a
  // third-party hook that reconciliation would silently overwrite.
  it("POSIX reconcile does not overwrite a third-party command with a leftover commandWindows", () => {
    const thirdParty = '"/usr/bin/some-other-tool" --flag';
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command: thirdParty,
            commandWindows: `& "node" "${HOOK_SCRIPT}"`,
            timeout: 30,
          }],
        }],
      },
    });

    registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    const settings = readJson(path.join(codexDir, "hooks.json"));
    const entries = settings.hooks.SessionStart;
    // The third-party hook survives untouched; Clawd appends its own entry.
    assert.strictEqual(entries[0].hooks[0].command, thirdParty);
    assert.strictEqual(entries.length, 2);
    assert.ok(entries[1].hooks[0].command.includes(MARKER));
  });

  // codex review finding: uninstall must match commandWindows too, so a
  // hand-edited command cannot shield a still-live commandWindows.
  it("uninstall removes an entry whose marker only survives in commandWindows", () => {
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command: '"/usr/bin/edited-away" --by-hand',
            commandWindows: `& "node" "${HOOK_SCRIPT}"`,
            timeout: 30,
          }],
        }],
      },
    });

    const result = unregisterCodexHooks({ silent: true, codexDir });

    assert.strictEqual(result.removed, 1);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(settings.hooks, "SessionStart"), false);
  });

  // codex review finding: a UNC node path has no /mnt translation and a
  // POSIX shell cannot exec the raw backslash form — fall back to bare
  // node.exe via the interop PATH. Forward-slash UNC form included.
  it("falls back to bare node.exe for a UNC node path in the interop command", () => {
    assert.strictEqual(
      buildCodexHookPosixInteropCommand("\\\\server\\share\\node.exe", "D:/x/codex-hook.js"),
      '"node.exe" "D:/x/codex-hook.js"'
    );
    assert.strictEqual(
      buildCodexHookPosixInteropCommand("//server/share/node.exe", "D:/x/codex-hook.js"),
      '"node.exe" "D:/x/codex-hook.js"'
    );
  });

  // Subagent review finding: an entry claimed through commandWindows whose
  // command was hand-edited (marker gone) must keep the user's command —
  // rewriting it would recreate the "reconcile wipes my manual fix" loop.
  it("preserves a hand-edited marker-less command while managing commandWindows", () => {
    const handEdit = '"/home/user/bin/my-codex-wrapper.sh"';
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command: handEdit,
            commandWindows: `& "node" "${HOOK_SCRIPT}"`,
            timeout: 30,
          }],
        }],
      },
    });

    registerCodexHooks({ silent: true, codexDir, nodeBin: "node", platform: "win32" });

    const settings = readJson(path.join(codexDir, "hooks.json"));
    const entries = settings.hooks.SessionStart;
    assert.strictEqual(entries.length, 1, "must not append a duplicate entry");
    assert.strictEqual(entries[0].hooks[0].command, handEdit);
    assert.strictEqual(entries[0].hooks[0].commandWindows, `& "node" "${HOOK_SCRIPT}"`);
  });

  // Subagent review finding: uninstall must not drop an entry whose nested
  // hooks emptied out but whose top level still carries a third-party
  // commandWindows.
  it("uninstall keeps an entry with a third-party top-level commandWindows", () => {
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          commandWindows: '& "C:\\third\\party.exe"',
          hooks: [{ type: "command", command: `"node.exe" "${HOOK_SCRIPT}"`, timeout: 30 }],
        }],
      },
    });

    const result = unregisterCodexHooks({ silent: true, codexDir });

    assert.strictEqual(result.removed, 1);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
    assert.strictEqual(settings.hooks.SessionStart[0].commandWindows, '& "C:\\third\\party.exe"');
    assert.deepStrictEqual(settings.hooks.SessionStart[0].hooks, []);
  });

  // Subagent review finding: the interop warning must apply the same filter
  // withCommandEnv does — an env object contributing nothing (invalid keys,
  // nullish values) must not warn, since repair escalates warnings to error.
  it("does not emit the interop env warning for a no-op env object", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "node",
      platform: "win32",
      env: { FOO: undefined, "1BAD": "x" },
    });

    assert.ok(!result.warnings.some((w) => /interop/.test(w)), "no-op env must not warn");
  });
});
