const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const {
  CODEX_OFFICIAL_HOOK_EVENTS,
  registerCodexHooks,
} = require("../hooks/codex-install");
const {
  CODEX_WINDOWS_REMOTE_HOOKS_DISABLED,
  CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT,
  CODEX_WINDOWS_REMOTE_UNSAFE_PATH,
  classifyWindowsRemoteCodexHook,
  readCodexHooksFeatureState,
  registerCodexCommandHooks,
  unregisterRemoteOwnedCodexHooks,
} = require("../hooks/codex-install-utils");
const { createSpawnedHookHarness } = require("./helpers/spawned-hook");

const HOOKS_DIR = path.resolve(__dirname, "..", "hooks");
const HOOK_SCRIPT = path.join(HOOKS_DIR, "codex-hook.js").replace(/\\/g, "/");
const INSTALL_SCRIPT = path.join(HOOKS_DIR, "codex-install.js");
const LOCAL_WINDOWS_COMMAND = '"/bin/sh" "/mnt/c/Users/Ruller/.codex/clawd-hooks/codex-hook.js.sh"';
const LOCAL_WINDOWS_COMMAND_WINDOWS = '& "C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\Clawd on Desk\\resources\\app.asar.unpacked\\hooks\\codex-hook.js" --clawd-windows-stable';
const ORCA_HOOK = {
  type: "command",
  command: "C:\\Users\\Ruller\\.orca\\agent-hooks\\codex-hook.cmd",
  timeout: 30,
};
const tempDirs = [];

function makeTempCodexDir(initialHooks = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-"));
  const codexDir = path.join(tmpDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  if (initialHooks !== null) {
    fs.writeFileSync(path.join(codexDir, "hooks.json"), JSON.stringify(initialHooks, null, 2), "utf8");
  }
  tempDirs.push(tmpDir);
  return codexDir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function hooksPath(codexDir) {
  return path.join(codexDir, "hooks.json");
}

function remoteOptions(codexDir, extra = {}) {
  return {
    silent: true,
    codexDir,
    nodeBin: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
    remote: true,
    sshRemote: true,
    processEnv: {},
    ...extra,
  };
}

function localStableHook() {
  return {
    type: "command",
    command: LOCAL_WINDOWS_COMMAND,
    commandWindows: LOCAL_WINDOWS_COMMAND_WINDOWS,
    timeout: 30,
  };
}

function installedHook(codexDir, event = "SessionStart") {
  return readJson(hooksPath(codexDir)).hooks[event][0].hooks[0];
}

function seedEvent(codexDir, event, hooks) {
  const settings = fs.existsSync(hooksPath(codexDir)) ? readJson(hooksPath(codexDir)) : {};
  settings.hooks = settings.hooks || {};
  settings.hooks[event] = hooks.map((hook) => ({ hooks: [hook] }));
  writeJson(hooksPath(codexDir), settings);
}

function assertRejectedInstall(codexDir, pattern) {
  const before = fs.readFileSync(hooksPath(codexDir));
  const configPath = path.join(codexDir, "config.toml");
  try { fs.unlinkSync(configPath); } catch { /* absent */ }
  assert.throws(() => registerCodexHooks(remoteOptions(codexDir)), pattern);
  assert.deepStrictEqual(fs.readFileSync(hooksPath(codexDir)), before, "rejection must not rewrite hooks.json");
  assert.strictEqual(fs.existsSync(configPath), false, "rejection must not write config.toml");
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("issue #1316: Windows remote Codex installer ownership", () => {
  it("issue #1316: writes the remote flag and classifies a fresh entry as ours", () => {
    const codexDir = makeTempCodexDir();
    const result = registerCodexHooks(remoteOptions(codexDir));

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const hook = installedHook(codexDir);
    assert.match(hook.commandWindows, / "--clawd-ssh-remote"$/);
    assert.match(hook.command, / --clawd-wsl-interop --clawd-ssh-remote$/);
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(hook, { hooksDir: HOOKS_DIR }),
      "ours"
    );
  });

  it("issue #1316: keeps the legacy WSL remote form byte-for-byte and its interop warning", () => {
    const codexDir = makeTempCodexDir();
    const result = registerCodexHooks(remoteOptions(codexDir, {
      sshRemote: false,
      nodeBin: "C:\\node.exe",
    }));

    const hook = installedHook(codexDir);
    assert.strictEqual(
      hook.commandWindows,
      `$env:CLAWD_REMOTE='1'; & "C:\\node.exe" "${HOOK_SCRIPT}"`
    );
    assert.strictEqual(
      hook.command,
      `"/mnt/c/node.exe" "${HOOK_SCRIPT}" --clawd-wsl-interop`
    );
    assert.ok(result.warnings.some((warning) => /interop/.test(warning)));
  });

  it("issue #1316: migrates a local stable entry that sits before the deployment entry", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const settings = readJson(hooksPath(codexDir));
    settings.hooks.SessionStart.unshift({ hooks: [localStableHook()] });
    writeJson(hooksPath(codexDir), settings);

    const result = registerCodexHooks(remoteOptions(codexDir));

    const entries = readJson(hooksPath(codexDir)).hooks.SessionStart;
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].hooks.length, 1);
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(entries[0].hooks[0], { hooksDir: HOOKS_DIR }),
      "ours"
    );
    assert.doesNotMatch(JSON.stringify(entries), /app\.asar\.unpacked|clawd-hooks/);
  });

  it("issue #1316: leaves an independent third-party hook untouched", () => {
    const codexDir = makeTempCodexDir();
    seedEvent(codexDir, "SessionStart", [ORCA_HOOK]);
    registerCodexHooks(remoteOptions(codexDir));

    const entries = readJson(hooksPath(codexDir)).hooks.SessionStart;
    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries[0].hooks[0], ORCA_HOOK);
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(entries[1].hooks[0], { hooksDir: HOOKS_DIR }),
      "ours"
    );
  });

  it("issue #1316: rejects an unrecognised hooked entry before writing anything", () => {
    const codexDir = makeTempCodexDir();
    seedEvent(codexDir, "SessionStart", [{
      type: "command",
      command: '"C:\\tools\\node.exe" "C:\\odd\\codex-hook.js" --mystery',
      timeout: 30,
    }]);

    assertRejectedInstall(
      codexDir,
      new RegExp(`${CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT}: SessionStart has a unknown-clawd`)
    );
  });

  it("issue #1316: rejects a deployment commandWindows with a hand-edited command", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const settings = readJson(hooksPath(codexDir));
    settings.hooks.SessionStart[0].hooks[0].command = '"C:\\foreign\\tool.exe" --flag';
    writeJson(hooksPath(codexDir), settings);

    assertRejectedInstall(
      codexDir,
      new RegExp(`${CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT}: SessionStart has a conflict`)
    );
  });

  it("issue #1316: does not claim an unchanged path without the remote flag", () => {
    const codexDir = makeTempCodexDir();
    seedEvent(codexDir, "SessionStart", [{
      type: "command",
      commandWindows: `$env:CLAWD_REMOTE='1'; $env:CLAWD_SSH_REMOTE='1'; & "C:\\node.exe" "${HOOK_SCRIPT}"`,
      timeout: 30,
    }]);

    assertRejectedInstall(
      codexDir,
      new RegExp(`${CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT}: SessionStart has a unknown-clawd`)
    );
  });

  it("issue #1316: does not accept the flag when it hides in an extra argument", () => {
    const codexDir = makeTempCodexDir();
    seedEvent(codexDir, "SessionStart", [{
      type: "command",
      commandWindows: `$env:CLAWD_REMOTE='1'; & "C:\\node.exe" "${HOOK_SCRIPT}" "--clawd-ssh-remote-extra"`,
      timeout: 30,
    }]);

    assertRejectedInstall(
      codexDir,
      new RegExp(`${CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT}: SessionStart has a unknown-clawd`)
    );
  });

  it("issue #1316: does not accept a deployment command with an extra argument", () => {
    const codexDir = makeTempCodexDir();
    seedEvent(codexDir, "SessionStart", [{
      type: "command",
      commandWindows: `$env:CLAWD_REMOTE='1'; & "C:\\node.exe" "${HOOK_SCRIPT}" "--clawd-ssh-remote" "extra"`,
      timeout: 30,
    }]);

    assertRejectedInstall(
      codexDir,
      new RegExp(`${CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT}: SessionStart has a unknown-clawd`)
    );
  });

  it("issue #1316: does not accept curly quotes around an otherwise owned command", () => {
    const codexDir = makeTempCodexDir();
    seedEvent(codexDir, "SessionStart", [{
      type: "command",
      commandWindows: `$env:CLAWD_REMOTE='1'; & \u201CC:\\node.exe\u201D "${HOOK_SCRIPT}" "--clawd-ssh-remote"`,
      timeout: 30,
    }]);

    assertRejectedInstall(
      codexDir,
      new RegExp(`${CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT}: SessionStart has a unknown-clawd`)
    );
  });

  for (const unsafe of ["$", "`", "\u201C", "\u201D", "\u201E", '"']) {
    it(`issue #1316: refuses a Windows remote node path containing ${JSON.stringify(unsafe)}`, () => {
      const codexDir = makeTempCodexDir();
      const configPath = path.join(codexDir, "config.toml");

      assert.throws(
        () => registerCodexHooks(remoteOptions(codexDir, { nodeBin: `C:\\no${unsafe}de.exe` })),
        new RegExp(`${CODEX_WINDOWS_REMOTE_UNSAFE_PATH}: node path`)
      );
      assert.strictEqual(fs.existsSync(hooksPath(codexDir)), false);
      assert.strictEqual(fs.existsSync(configPath), false);
    });
  }

  it("issue #1316: keeps a single deployment entry when the same event has two", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const settings = readJson(hooksPath(codexDir));
    settings.hooks.SessionStart.push({ hooks: [{ ...settings.hooks.SessionStart[0].hooks[0] }] });
    writeJson(hooksPath(codexDir), settings);

    registerCodexHooks(remoteOptions(codexDir));

    const entries = readJson(hooksPath(codexDir)).hooks.SessionStart;
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(entries[0].hooks[0], { hooksDir: HOOKS_DIR }),
      "ours"
    );
  });

  it("issue #1316: is idempotent on a second remote install", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const before = fs.readFileSync(hooksPath(codexDir), "utf8");

    const result = registerCodexHooks(remoteOptions(codexDir));

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, CODEX_OFFICIAL_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(hooksPath(codexDir), "utf8"), before);
  });
});

describe("issue #1316: Windows remote Codex ownership edge cases", () => {
  function ourCommandWindows() {
    return `$env:CLAWD_REMOTE='1'; $env:CLAWD_SSH_REMOTE='1'; & "C:\\Program Files\\nodejs\\node.exe" "${HOOK_SCRIPT}" "--clawd-ssh-remote"`;
  }

  it("issue #1316: keeps a mixed group's top-level third-party command on uninstall", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const ours = installedHook(codexDir);
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: "manual",
          command: "C:\\third-party\\tool.exe --flag",
          timeout: 30,
          hooks: [ours],
        }],
      },
    };
    writeJson(hooksPath(codexDir), settings);

    const result = unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });

    assert.deepStrictEqual(result, { removed: 1, conflicts: 0, changed: true });
    const entry = readJson(hooksPath(codexDir)).hooks.SessionStart[0];
    assert.strictEqual(entry.command, "C:\\third-party\\tool.exe --flag");
    assert.strictEqual(entry.matcher, "manual");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, "hooks"), false);
  });

  it("issue #1316: keeps a mixed group's top-level command while migrating its nested hook", () => {
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          matcher: "manual",
          command: "C:\\third-party\\tool.exe --flag",
          timeout: 30,
          hooks: [localStableHook()],
        }],
      },
    });

    registerCodexHooks(remoteOptions(codexDir));

    const entry = readJson(hooksPath(codexDir)).hooks.SessionStart[0];
    assert.strictEqual(entry.command, "C:\\third-party\\tool.exe --flag");
    assert.strictEqual(entry.matcher, "manual");
    assert.strictEqual(entry.hooks.length, 1);
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(entry.hooks[0], { hooksDir: HOOKS_DIR }),
      "ours"
    );
  });

  it("issue #1316: keeps a mixed group's top-level command when an entry already exists", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const settings = readJson(hooksPath(codexDir));
    settings.hooks.SessionStart.push({
      matcher: "manual",
      command: "C:\\third-party\\tool.exe --flag",
      hooks: [localStableHook()],
    });
    writeJson(hooksPath(codexDir), settings);

    registerCodexHooks(remoteOptions(codexDir));

    const entries = readJson(hooksPath(codexDir)).hooks.SessionStart;
    const mixed = entries.find((entry) => entry.command === "C:\\third-party\\tool.exe --flag");
    assert.ok(mixed);
    assert.strictEqual(mixed.matcher, "manual");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(mixed, "hooks"), false);
    assert.strictEqual(
      entries.filter((entry) => entry.hooks && entry.hooks.some((hook) =>
        classifyWindowsRemoteCodexHook(hook, { hooksDir: HOOKS_DIR }) === "ours")).length,
      1
    );
  });

  it("issue #1316: migrates a local entry in place and keeps group-level fields", () => {
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [
          { hooks: [ORCA_HOOK] },
          {
            matcher: "manual",
            custom: { keep: true },
            hooks: [localStableHook()],
          },
        ],
      },
    });

    registerCodexHooks(remoteOptions(codexDir));

    const entries = readJson(hooksPath(codexDir)).hooks.SessionStart;
    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries[0].hooks[0], ORCA_HOOK);
    assert.strictEqual(entries[1].matcher, "manual");
    assert.deepStrictEqual(entries[1].custom, { keep: true });
    assert.strictEqual(entries[1].hooks.length, 1);
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(entries[1].hooks[0], { hooksDir: HOOKS_DIR }),
      "ours"
    );
  });

  it("issue #1316: does not claim a flagged command from another deployment directory", () => {
    const foreign = {
      type: "command",
      commandWindows: `$env:CLAWD_REMOTE='1'; & "C:\\node.exe" "C:\\Other\\hooks\\codex-hook.js" "--clawd-ssh-remote"`,
      timeout: 30,
    };
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(foreign, { hooksDir: HOOKS_DIR }),
      "unknown-clawd"
    );
    const codexDir = makeTempCodexDir({ hooks: { SessionStart: [{ hooks: [foreign] }] } });

    assertRejectedInstall(
      codexDir,
      new RegExp(`${CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT}: SessionStart has a unknown-clawd`)
    );
  });

  it("issue #1316: keeps a flagged command from another deployment on uninstall", () => {
    const foreign = {
      type: "command",
      commandWindows: `$env:CLAWD_REMOTE='1'; & "C:\\node.exe" "C:\\Other\\hooks\\codex-hook.js" "--clawd-ssh-remote"`,
      timeout: 30,
    };
    const codexDir = makeTempCodexDir();
    writeJson(hooksPath(codexDir), { hooks: { SessionStart: [{ hooks: [foreign] }] } });
    const before = fs.readFileSync(hooksPath(codexDir));

    const result = unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });

    assert.deepStrictEqual(result, { removed: 0, conflicts: 0, changed: false });
    assert.deepStrictEqual(fs.readFileSync(hooksPath(codexDir)), before);
  });

  it("issue #1316: treats an owned commandWindows with a flagless interop command as a conflict", () => {
    const hook = {
      type: "command",
      commandWindows: ourCommandWindows(),
      command: `"/mnt/c/node.exe" "${HOOK_SCRIPT}" --clawd-wsl-interop`,
      timeout: 30,
    };
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(hook, { hooksDir: HOOKS_DIR }),
      "conflict"
    );
    const codexDir = makeTempCodexDir({ hooks: { SessionStart: [{ hooks: [hook] }] } });

    assertRejectedInstall(
      codexDir,
      new RegExp(`${CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT}: SessionStart has a conflict`)
    );
  });

  it("issue #1316: does not treat a marker-containing helper path as a local entry", () => {
    const helper = {
      type: "command",
      commandWindows: `$env:CLAWD_REMOTE='1'; & "C:\\node.exe" "C:/tools/codex-hook.js-helpers/run.js"`,
      timeout: 30,
    };
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(helper, { hooksDir: HOOKS_DIR }),
      "unknown-clawd"
    );
    const codexDir = makeTempCodexDir({ hooks: { SessionStart: [{ hooks: [helper] }] } });

    assertRejectedInstall(
      codexDir,
      new RegExp(`${CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT}: SessionStart has a unknown-clawd`)
    );
  });

  it("issue #1316: installs and uninstalls a flat entry", () => {
    const codexDir = makeTempCodexDir({ hooks: { SessionStart: [localStableHook()] } });

    registerCodexHooks(remoteOptions(codexDir));

    const entries = readJson(hooksPath(codexDir)).hooks.SessionStart;
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(Array.isArray(entries[0].hooks), false);
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(entries[0], { hooksDir: HOOKS_DIR }),
      "ours"
    );

    const result = unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });
    assert.strictEqual(result.removed, CODEX_OFFICIAL_HOOK_EVENTS.length);
    assert.deepStrictEqual(readJson(hooksPath(codexDir)).hooks, {});
  });

  it("issue #1316: uninstalls a commandWindows-only deployment entry", () => {
    const codexDir = makeTempCodexDir({
      hooks: { SessionStart: [{ type: "command", commandWindows: ourCommandWindows(), timeout: 30 }] },
    });

    const result = unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });

    assert.strictEqual(result.removed, 1);
    assert.deepStrictEqual(readJson(hooksPath(codexDir)).hooks, {});
  });

  it("issue #1316: migrates a commandWindows-only local entry", () => {
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          type: "command",
          commandWindows: LOCAL_WINDOWS_COMMAND_WINDOWS,
          timeout: 30,
        }],
      },
    });

    registerCodexHooks(remoteOptions(codexDir));

    const entry = readJson(hooksPath(codexDir)).hooks.SessionStart[0];
    assert.strictEqual(Array.isArray(entry.hooks), false);
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(entry, { hooksDir: HOOKS_DIR }),
      "ours"
    );
  });

  it("issue #1316: refuses an unsafe hook script path", () => {
    const codexDir = makeTempCodexDir();

    assert.throws(
      () => registerCodexCommandHooks({
        silent: true,
        codexDir,
        nodeBin: "C:\\node.exe",
        platform: "win32",
        remote: true,
        sshRemote: true,
        processEnv: {},
        marker: "codex-hook.js",
        scriptName: "codex-hook$.js",
        events: ["SessionStart"],
      }),
      new RegExp(`${CODEX_WINDOWS_REMOTE_UNSAFE_PATH}: hook script path`)
    );
    assert.strictEqual(fs.existsSync(hooksPath(codexDir)), false);
    assert.strictEqual(fs.existsSync(path.join(codexDir, "config.toml")), false);
  });

  it("issue #1316: repairs a changed type and timeout on reinstall", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const settings = readJson(hooksPath(codexDir));
    settings.hooks.SessionStart[0].hooks[0].type = "prompt";
    settings.hooks.SessionStart[0].hooks[0].timeout = 99;
    writeJson(hooksPath(codexDir), settings);

    const result = registerCodexHooks(remoteOptions(codexDir));

    const hook = installedHook(codexDir);
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(hook.type, "command");
    assert.strictEqual(hook.timeout, 30);
  });

  for (const malformed of ["null", "[]", '"text"']) {
    it(`issue #1316: tolerates a non-object hooks.json (${malformed}) on install and uninstall`, () => {
      const installDir = makeTempCodexDir();
      fs.writeFileSync(hooksPath(installDir), malformed, "utf8");

      assert.doesNotThrow(() => registerCodexHooks(remoteOptions(installDir)));
      const settings = readJson(hooksPath(installDir));
      assert.strictEqual(Array.isArray(settings.hooks.SessionStart), true);

      const uninstallDir = makeTempCodexDir();
      fs.writeFileSync(hooksPath(uninstallDir), malformed, "utf8");
      assert.deepStrictEqual(
        unregisterRemoteOwnedCodexHooks({ codexDir: uninstallDir, hooksDir: HOOKS_DIR }),
        { removed: 0, conflicts: 0, changed: false }
      );
    });
  }

  it("issue #1316: keeps other top-level keys when hooks becomes empty", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const settings = readJson(hooksPath(codexDir));
    settings.version = 7;
    writeJson(hooksPath(codexDir), settings);

    unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });

    const after = readJson(hooksPath(codexDir));
    assert.strictEqual(after.version, 7);
    assert.deepStrictEqual(after.hooks, {});
  });

  it("issue #1316: treats a local entry with a marker-less command as a conflict", () => {
    const hook = {
      ...localStableHook(),
      command: '"C:\\foreign\\tool.exe" --flag',
    };
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(hook, { hooksDir: HOOKS_DIR }),
      "conflict"
    );
    const codexDir = makeTempCodexDir({ hooks: { SessionStart: [{ hooks: [hook] }] } });

    assertRejectedInstall(
      codexDir,
      new RegExp(`${CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT}: SessionStart has a conflict`)
    );
  });

  it("issue #1316: recognises local stable script names case-insensitively", () => {
    const upperStable = {
      type: "command",
      commandWindows: '& "C:\\Program Files\\nodejs\\node.exe" "C:\\App\\Hooks\\CODEX-HOOK.JS" --clawd-windows-stable',
      command: LOCAL_WINDOWS_COMMAND,
      timeout: 30,
    };
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(upperStable, { hooksDir: HOOKS_DIR }),
      "local-clawd"
    );

    const upperDirect = {
      type: "command",
      commandWindows: '& "C:\\Program Files\\nodejs\\node.exe" "C:\\App\\CODEX-HOOK.JS"',
      timeout: 30,
    };
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(upperDirect, { hooksDir: HOOKS_DIR }),
      "local-clawd"
    );

    const codexDir = makeTempCodexDir({ hooks: { SessionStart: [{ hooks: [upperDirect] }] } });
    registerCodexHooks(remoteOptions(codexDir));
    assert.strictEqual(
      classifyWindowsRemoteCodexHook(installedHook(codexDir), { hooksDir: HOOKS_DIR }),
      "ours"
    );
  });

  it("issue #1316: keeps the exact interop shape when CLAWD_WSL_DISTRO is inherited", () => {
    const previous = process.env.CLAWD_WSL_DISTRO;
    process.env.CLAWD_WSL_DISTRO = "Ubuntu";
    try {
      const codexDir = makeTempCodexDir();
      registerCodexHooks(remoteOptions(codexDir));

      const hook = installedHook(codexDir);
      assert.match(hook.command, /^"[^"]+" "[^"]+" --clawd-wsl-interop --clawd-ssh-remote$/);
      assert.strictEqual(
        classifyWindowsRemoteCodexHook(hook, { hooksDir: HOOKS_DIR }),
        "ours"
      );

      const second = registerCodexHooks(remoteOptions(codexDir));
      assert.strictEqual(second.added, 0);
      assert.strictEqual(second.updated, 0);
      assert.strictEqual(second.skipped, CODEX_OFFICIAL_HOOK_EVENTS.length);

      const result = unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });
      assert.strictEqual(result.removed, CODEX_OFFICIAL_HOOK_EVENTS.length);
    } finally {
      if (previous === undefined) delete process.env.CLAWD_WSL_DISTRO;
      else process.env.CLAWD_WSL_DISTRO = previous;
    }
  });

  for (const platform of ["linux", "win32"]) {
    it(`issue #1316: restores baseline config.toml ordering for a local ${platform} install`, () => {
      const codexDir = makeTempCodexDir();
      fs.writeFileSync(hooksPath(codexDir), "{ not json", "utf8");

      assert.throws(() => registerCodexHooks({
        silent: true,
        codexDir,
        nodeBin: platform === "win32" ? "C:\\node.exe" : "/usr/local/bin/node",
        platform,
      }));

      assert.strictEqual(
        fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"),
        "[features]\nhooks = true\n"
      );
    });
  }
});

describe("issue #1316: Codex hooks feature state", () => {
  for (const [label, text, expected] of [
    ["plain on", "[features]\nhooks = true\n", "on"],
    ["plain off", "[features]\nhooks = false\n", "off"],
    ["legacy key", "[features]\ncodex_hooks = true\n", "on"],
    ["comment line", "[features]\n# hooks = true\nhooks = false\n", "off"],
    ["spaced header", "[ features ]\nhooks = true\n", "on"],
    ["non-boolean", "[features]\nhooks = true.invalid\n", "invalid"],
    ["multi-line example after another section", "[features]\nhooks = false\n\n[other]\nnotes = \"\"\"\n[features]\nhooks = true\n\"\"\"\n", "off"],
    ["missing", "", "missing"],
  ]) {
    it(`issue #1316: reads ${label}`, () => {
      assert.strictEqual(readCodexHooksFeatureState(text), expected);
    });
  }
});

describe("issue #1316: Windows SSH remote refuses a disabled Codex hooks feature", () => {
  it("issue #1316: leaves hooks.json and config.toml untouched when hooks are explicitly off", () => {
    const codexDir = makeTempCodexDir();
    const configPath = path.join(codexDir, "config.toml");
    const hooksBefore = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "foreign" }] }] } }, null, 2);
    fs.writeFileSync(hooksPath(codexDir), hooksBefore, "utf8");
    fs.writeFileSync(configPath, "[features]\nhooks = false\n", "utf8");

    assert.throws(
      () => registerCodexHooks(remoteOptions(codexDir)),
      new RegExp(`${CODEX_WINDOWS_REMOTE_HOOKS_DISABLED}:`)
    );
    assert.strictEqual(fs.readFileSync(hooksPath(codexDir), "utf8"), hooksBefore);
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), "[features]\nhooks = false\n");
  });
});

describe("issue #1316: Windows remote Codex ownership unregister", () => {
  it("issue #1316: removes only the deployment entries and drops emptied events", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));

    const result = unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });

    assert.deepStrictEqual(result, {
      removed: CODEX_OFFICIAL_HOOK_EVENTS.length,
      conflicts: 0,
      changed: true,
    });
    assert.deepStrictEqual(readJson(hooksPath(codexDir)).hooks, {});
  });

  it("issue #1316: returns zeros when hooks.json does not exist", () => {
    const codexDir = makeTempCodexDir();
    assert.deepStrictEqual(
      unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR }),
      { removed: 0, conflicts: 0, changed: false }
    );
  });

  it("issue #1316: keeps local and third-party hooks beside the removed deployment entry", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const settings = readJson(hooksPath(codexDir));
    settings.hooks.SessionStart.unshift({ hooks: [localStableHook()] }, { hooks: [ORCA_HOOK] });
    writeJson(hooksPath(codexDir), settings);

    const result = unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });

    assert.strictEqual(result.removed, CODEX_OFFICIAL_HOOK_EVENTS.length);
    assert.strictEqual(result.conflicts, 0);
    const entries = readJson(hooksPath(codexDir)).hooks.SessionStart;
    assert.deepStrictEqual(entries[0].hooks[0], localStableHook());
    assert.deepStrictEqual(entries[1].hooks[0], ORCA_HOOK);
    assert.strictEqual(entries.length, 2);
  });

  it("issue #1316: keeps a conflicting entry and reports the conflict", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const settings = readJson(hooksPath(codexDir));
    settings.hooks = { SessionStart: settings.hooks.SessionStart };
    settings.hooks.SessionStart[0].hooks[0].command = '"C:\\foreign\\tool.exe" --flag';
    writeJson(hooksPath(codexDir), settings);
    const before = fs.readFileSync(hooksPath(codexDir));

    const result = unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });

    assert.deepStrictEqual(result, { removed: 0, conflicts: 1, changed: false });
    assert.deepStrictEqual(fs.readFileSync(hooksPath(codexDir)), before);
  });

  it("issue #1316: does not rewrite the file when nothing is owned", () => {
    const codexDir = makeTempCodexDir();
    seedEvent(codexDir, "SessionStart", [localStableHook(), ORCA_HOOK]);
    const before = fs.readFileSync(hooksPath(codexDir));

    const result = unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });

    assert.deepStrictEqual(result, { removed: 0, conflicts: 0, changed: false });
    assert.deepStrictEqual(fs.readFileSync(hooksPath(codexDir)), before);
  });

  it("issue #1316: writes the result without a BOM", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const pathToHooks = hooksPath(codexDir);
    const withoutBom = fs.readFileSync(pathToHooks);
    fs.writeFileSync(pathToHooks, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), withoutBom]));

    unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });

    const bytes = fs.readFileSync(pathToHooks);
    assert.notDeepStrictEqual(bytes.subarray(0, 3), Buffer.from([0xEF, 0xBB, 0xBF]));
  });

  it("issue #1316: leaves the local sidecar and config.toml alone", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));
    const sidecarDir = path.join(codexDir, "clawd-hooks");
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(path.join(sidecarDir, "codex-hook.js.windows.run"), "local sidecar", "utf8");
    const configPath = path.join(codexDir, "config.toml");
    const configBefore = fs.readFileSync(configPath);

    unregisterRemoteOwnedCodexHooks({ codexDir, hooksDir: HOOKS_DIR });

    assert.strictEqual(
      fs.readFileSync(path.join(sidecarDir, "codex-hook.js.windows.run"), "utf8"),
      "local sidecar"
    );
    assert.deepStrictEqual(fs.readFileSync(configPath), configBefore);
  });

  it("issue #1316: requires a hooks directory", () => {
    const codexDir = makeTempCodexDir();
    assert.throws(
      () => unregisterRemoteOwnedCodexHooks({ codexDir }),
      /Remote owned uninstall requires --hooks-dir/
    );
  });
});

describe("issue #1316: non-object hooks.json handling stays baseline outside Windows SSH remote", () => {
  function runInstall(codexDir, options) {
    return registerCodexHooks({ silent: true, codexDir, ...options });
  }

  for (const [label, options] of [
    ["local POSIX", { nodeBin: "/usr/local/bin/node", platform: "linux" }],
    ["local Windows", { nodeBin: "C:\\node.exe", platform: "win32" }],
    ["POSIX remote", { nodeBin: "/usr/local/bin/node", platform: "linux", remote: true, processEnv: {} }],
  ]) {
    it(`issue #1316: ${label} keeps the baseline null and [] behavior`, () => {
      const nullDir = makeTempCodexDir();
      fs.writeFileSync(hooksPath(nullDir), "null", "utf8");
      assert.throws(() => runInstall(nullDir, options), TypeError);
      assert.strictEqual(fs.readFileSync(hooksPath(nullDir), "utf8"), "null");
      assert.strictEqual(
        fs.readFileSync(path.join(nullDir, "config.toml"), "utf8"),
        "[features]\nhooks = true\n"
      );

      const arrayDir = makeTempCodexDir();
      fs.writeFileSync(hooksPath(arrayDir), "[]", "utf8");
      assert.doesNotThrow(() => runInstall(arrayDir, options));
      assert.strictEqual(fs.readFileSync(hooksPath(arrayDir), "utf8"), "[]");
      assert.strictEqual(
        fs.readFileSync(path.join(arrayDir, "config.toml"), "utf8"),
        "[features]\nhooks = true\n"
      );
    });
  }

  it("issue #1316: Windows SSH remote rewrites a non-object hooks.json normally", () => {
    const codexDir = makeTempCodexDir();
    fs.writeFileSync(hooksPath(codexDir), "[]", "utf8");

    registerCodexHooks(remoteOptions(codexDir));

    const settings = readJson(hooksPath(codexDir));
    assert.strictEqual(Array.isArray(settings.hooks.SessionStart), true);
  });
});

describe("issue #1316: Codex hooks.json BOM handling", () => {
  const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

  it("issue #1316: rewrites a BOM-prefixed file on a Windows host even when entries did not change", () => {
    const codexDir = makeTempCodexDir();
    const options = { silent: true, codexDir, nodeBin: "C:\\node.exe", platform: "win32" };
    registerCodexHooks(options);
    const before = readJson(hooksPath(codexDir));
    const withoutBom = fs.readFileSync(hooksPath(codexDir));
    fs.writeFileSync(hooksPath(codexDir), Buffer.concat([BOM, withoutBom]));

    const result = registerCodexHooks(options);

    const after = fs.readFileSync(hooksPath(codexDir));
    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.notDeepStrictEqual(after.subarray(0, 3), BOM);
    assert.deepStrictEqual(readJson(hooksPath(codexDir)), before);
  });

  it("issue #1316: leaves a BOM-prefixed file alone on a POSIX host", () => {
    const codexDir = makeTempCodexDir();
    const options = { silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" };
    registerCodexHooks(options);
    const withoutBom = fs.readFileSync(hooksPath(codexDir));
    fs.writeFileSync(hooksPath(codexDir), Buffer.concat([BOM, withoutBom]));

    const result = registerCodexHooks(options);

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.deepStrictEqual(fs.readFileSync(hooksPath(codexDir)).subarray(0, 3), BOM);
  });
});

describe("issue #1316: Codex installer CLI validation", () => {
  function runCli(args, codexDir) {
    const env = { ...process.env, CODEX_HOME: codexDir };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAWD_")) delete env[key];
    }
    return spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    });
  }

  it("issue #1316: fails on an unknown argument before writing any config", () => {
    const codexDir = makeTempCodexDir();
    const result = runCli(["--bogus"], codexDir);

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Unknown argument: --bogus/);
    assert.strictEqual(fs.existsSync(hooksPath(codexDir)), false);
    assert.strictEqual(fs.existsSync(path.join(codexDir, "config.toml")), false);
  });

  it("issue #1316: fails when --remote-uninstall-owned has no hooks directory", () => {
    const codexDir = makeTempCodexDir();
    const result = runCli(["--remote-uninstall-owned"], codexDir);

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Remote owned uninstall requires --hooks-dir/);
    assert.strictEqual(fs.existsSync(hooksPath(codexDir)), false);
  });

  it("issue #1316: rejects --hooks-dir without the remote owned uninstall mode", () => {
    const codexDir = makeTempCodexDir();
    const result = runCli(["--hooks-dir", HOOKS_DIR], codexDir);

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /--hooks-dir is only valid with --remote-uninstall-owned/);
  });

  it("issue #1316: removes deployment entries through the CLI", () => {
    const codexDir = makeTempCodexDir();
    registerCodexHooks(remoteOptions(codexDir));

    const result = runCli(["--remote-uninstall-owned", "--hooks-dir", HOOKS_DIR], codexDir);

    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(readJson(hooksPath(codexDir)).hooks, {});
  });

  it("issue #1316: exports the remote uninstall helper without install side effects on require", () => {
    const codexDir = makeTempCodexDir();
    const env = { ...process.env, CODEX_HOME: codexDir };
    const result = spawnSync(process.execPath, [
      "-e",
      `process.stdout.write(typeof require(${JSON.stringify(INSTALL_SCRIPT)}).unregisterRemoteOwnedCodexHooks)`,
    ], { env, encoding: "utf8", windowsHide: true, timeout: 20000 });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, "function");
    assert.strictEqual(fs.existsSync(hooksPath(codexDir)), false);
    assert.strictEqual(fs.existsSync(path.join(codexDir, "config.toml")), false);
  });
});

describe("issue #1316: codex-hook recognises the independent remote flag", () => {
  const IDENTITY = {
    version: 2,
    layoutVersion: 1,
    runtimeKey: "runtime-1",
    profileId: "profile-1",
    installId: "a".repeat(64),
    remotePort: 23335,
    routingNonce: "b".repeat(32),
    deployedAt: 1_700_000_000_000,
  };

  function withHookCopy(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-hook-copy-"));
    const hooksDir = path.join(root, "hooks");
    fs.cpSync(HOOKS_DIR, hooksDir, { recursive: true });
    try {
      return fn(root, hooksDir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  function writeIdentity(hooksDir) {
    fs.writeFileSync(path.join(hooksDir, "clawd-remote.json"), JSON.stringify(IDENTITY), "utf8");
    fs.writeFileSync(path.join(hooksDir, "clawd-ssh-secure-v1"), "clawd-ssh-secure-v1", "utf8");
    fs.writeFileSync(path.join(hooksDir, "clawd-host-prefix"), "remote-host", "utf8");
  }

  it("issue #1316: uses the identity beside the script and never scans local ports", () => {
    withHookCopy((root, hooksDir) => {
      writeIdentity(hooksDir);
      const harness = createSpawnedHookHarness({ home: path.join(root, "home") });
      try {
        const result = harness.run({
          script: path.join(hooksDir, "codex-hook.js"),
          args: ["SessionStart", "--clawd-ssh-remote"],
          payload: { hook_event_name: "SessionStart", session_id: "remote-flag", cwd: "C:\\work" },
          httpContract: "expect-attempt",
          env: { CLAWD_POST_RECORDER_SUCCEED: "1" },
          runtimeJson: { port: 23333 },
        });

        assert.strictEqual(result.status, 0, result.stderr);
        assert.ok(result.attempts.length > 0);
        assert.ok(result.attempts.every((attempt) => attempt.port === 23335));
        assert.strictEqual(
          result.attempts[0].headers["x-clawd-routing-nonce"],
          IDENTITY.routingNonce
        );
      } finally {
        harness.cleanup();
      }
    });
  });

  it("issue #1316: makes no attempt at all when the colocated identity is missing", () => {
    withHookCopy((root, hooksDir) => {
      const harness = createSpawnedHookHarness({ home: path.join(root, "home") });
      try {
        const result = harness.run({
          script: path.join(hooksDir, "codex-hook.js"),
          args: ["SessionStart", "--clawd-ssh-remote"],
          payload: { hook_event_name: "SessionStart", session_id: "remote-flag", cwd: "C:\\work" },
          httpContract: "expect-none",
          runtimeJson: { port: 23333 },
        });

        assert.strictEqual(result.status, 0, result.stderr);
        assert.deepStrictEqual(result.attempts, []);
      } finally {
        harness.cleanup();
      }
    });
  });

  it("issue #1316: keeps local discovery when the flag is absent", () => {
    withHookCopy((root, hooksDir) => {
      const harness = createSpawnedHookHarness({ home: path.join(root, "home") });
      try {
        const result = harness.run({
          script: path.join(hooksDir, "codex-hook.js"),
          args: ["SessionStart"],
          payload: { hook_event_name: "SessionStart", session_id: "local-hook", cwd: "C:\\work" },
          httpContract: "expect-attempt",
          env: { CLAWD_POST_RECORDER_SUCCEED: "1" },
          runtimeJson: { port: 23333 },
        });

        assert.strictEqual(result.status, 0, result.stderr);
        assert.ok(result.attempts.some((attempt) => attempt.port === 23333));
        assert.ok(result.attempts.every((attempt) => !attempt.headers || !attempt.headers["x-clawd-routing-nonce"]));
      } finally {
        harness.cleanup();
      }
    });
  });
});
