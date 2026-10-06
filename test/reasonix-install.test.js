const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  MARKER,
  REASONIX_HOOK_EVENTS,
  registerReasonixHooks,
  unregisterReasonixHooks,
  __test,
} = require("../hooks/reasonix-install");
const { decodeWindowsEncodedCommand } = require("../hooks/json-utils");

const tempDirs = [];

function makeTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reasonix-home-"));
  tempDirs.push(home);
  fs.mkdirSync(path.join(home, ".reasonix"), { recursive: true });
  return home;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Reasonix hook installer", () => {
  it("resolves the current Reasonix home on Windows", () => {
    const appData = "C:\\Users\\Alice\\AppData\\Roaming";
    const userHomeDir = "C:\\Users\\Alice";

    assert.strictEqual(
      __test.resolveReasonixHome({ platform: "win32", env: { APPDATA: appData }, userHomeDir }),
      path.join(appData, "reasonix")
    );
    assert.strictEqual(
      __test.resolveReasonixHome({ platform: "win32", env: {}, userHomeDir }),
      path.join(userHomeDir, "AppData", "Roaming", "reasonix")
    );
    assert.strictEqual(
      __test.resolveReasonixHome({ platform: "win32", env: { REASONIX_HOME: "~/portable-reasonix" }, userHomeDir }),
      path.resolve(userHomeDir, "portable-reasonix")
    );
  });

  it("expands Reasonix environment references and defaults before resolving the home", () => {
    const localAppData = path.join(os.tmpdir(), "reasonix-local-appdata");
    const fallbackHome = path.join(os.tmpdir(), "reasonix-fallback");
    const userHomeDir = path.join(os.tmpdir(), "reasonix-user");

    assert.strictEqual(
      __test.resolveReasonixHome({
        platform: "win32",
        env: {
          LOCALAPPDATA: localAppData,
          REASONIX_HOME: "${LOCALAPPDATA}/rx",
        },
        userHomeDir,
      }),
      path.resolve(localAppData, "rx")
    );
    assert.strictEqual(
      __test.resolveReasonixHome({
        platform: "win32",
        env: { REASONIX_HOME: `\${MISSING:-${fallbackHome}}` },
        userHomeDir,
      }),
      path.resolve(fallbackHome)
    );
    assert.strictEqual(
      __test.resolveReasonixHome({
        platform: "win32",
        env: {
          APPDATA: path.join(userHomeDir, "AppData", "Roaming"),
          REASONIX_HOME: "${MISSING}",
        },
        userHomeDir,
      }),
      ""
    );
  });

  it("fails closed when REASONIX_HOME contains a fallback-less unresolved variable", () => {
    const options = {
      platform: "linux",
      env: { REASONIX_HOME: "${MISSING}" },
      userHomeDir: path.join(os.tmpdir(), "reasonix-user"),
    };

    assert.deepStrictEqual(__test.resolveReasonixHome(options), "");
    assert.deepStrictEqual(__test.selectReasonixSettingsPath(options), "");
    assert.deepStrictEqual(
      require("../hooks/reasonix-install").resolveReasonixConfigTargets(options),
      []
    );

    const result = registerReasonixHooks({ ...options, silent: true });
    assert.strictEqual(result.status, "skipped");
    assert.strictEqual(result.reason, "reasonix-home-invalid");
    assert.strictEqual(result.added, 0);
    assert.throws(
      () => registerReasonixHooks(options),
      /REASONIX_HOME contains an unresolved variable/
    );

    const uninstall = unregisterReasonixHooks({ ...options, silent: true });
    assert.strictEqual(uninstall.status, "skipped");
    assert.deepStrictEqual(uninstall.settingsPaths, []);
  });

  it("rejects unresolved variables even when a suffix would otherwise become an absolute path", () => {
    const base = {
      platform: "linux",
      userHomeDir: path.join(os.tmpdir(), "reasonix-user"),
    };
    for (const configuredHome of ["${MISSING}/tmp", "$MISSING/tmp"]) {
      const options = { ...base, env: { REASONIX_HOME: configuredHome } };
      assert.strictEqual(__test.resolveReasonixHome(options), "", configuredHome);
      assert.deepStrictEqual(
        require("../hooks/reasonix-install").resolveReasonixConfigTargets(options),
        [],
        configuredHome,
      );
    }
  });

  it("expands a present bare variable while retaining the braced fallback contract", () => {
    const userHomeDir = path.join(os.tmpdir(), "reasonix-user");
    const portable = path.join(userHomeDir, "portable");
    assert.strictEqual(
      __test.resolveReasonixHome({
        platform: "linux",
        userHomeDir,
        env: { REASONIX_HOME: "$PORTABLE/reasonix", PORTABLE: portable },
      }),
      path.join(portable, "reasonix"),
    );
    assert.strictEqual(
      __test.resolveReasonixHome({
        platform: "linux",
        userHomeDir,
        env: { REASONIX_HOME: "${MISSING:-fallback}/reasonix" },
      }),
      path.resolve("fallback/reasonix"),
    );
  });

  it("resolves the legacy Windows home only for non-isolated runtimes", () => {
    const userHomeDir = path.join(os.tmpdir(), "reasonix-user");
    const appData = path.join(userHomeDir, "AppData", "Roaming");

    assert.strictEqual(
      __test.resolveLegacyReasonixHome({
        platform: "win32",
        env: { APPDATA: appData },
        userHomeDir,
      }),
      path.join(userHomeDir, ".reasonix")
    );
    assert.strictEqual(
      __test.resolveLegacyReasonixHome({
        platform: "win32",
        env: { APPDATA: appData, REASONIX_HOME: path.join(userHomeDir, "portable") },
        userHomeDir,
      }),
      ""
    );
    assert.strictEqual(
      __test.resolveLegacyReasonixHome({
        platform: "win32",
        env: { APPDATA: appData, REASONIX_HOME: "${MISSING}" },
        userHomeDir,
      }),
      ""
    );
    assert.strictEqual(
      __test.resolveLegacyReasonixHome({ platform: "linux", env: {}, userHomeDir }),
      ""
    );
  });

  it("installs into the Windows Reasonix home under APPDATA", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reasonix-appdata-"));
    tempDirs.push(root);
    const appData = path.join(root, "Roaming");
    const reasonixHome = path.join(appData, "reasonix");
    fs.mkdirSync(reasonixHome, { recursive: true });

    const result = registerReasonixHooks({
      silent: true,
      platform: "win32",
      env: { APPDATA: appData },
      userHomeDir: path.join(root, "Home"),
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    assert.strictEqual(result.added, REASONIX_HOOK_EVENTS.length);
    assert.ok(fs.existsSync(path.join(reasonixHome, "settings.json")));
    assert.ok(!fs.existsSync(path.join(root, "Home", ".reasonix", "settings.json")));
  });

  it("installs into the legacy Windows home when it is the only Reasonix home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reasonix-legacy-"));
    tempDirs.push(root);
    const userHomeDir = path.join(root, "Home");
    const appData = path.join(root, "Roaming");
    const legacyHome = path.join(userHomeDir, ".reasonix");
    fs.mkdirSync(legacyHome, { recursive: true });

    const result = registerReasonixHooks({
      silent: true,
      platform: "win32",
      env: { APPDATA: appData },
      userHomeDir,
      nodeBin: "D:\\npm\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    assert.strictEqual(result.added, REASONIX_HOOK_EVENTS.length);
    assert.ok(fs.existsSync(path.join(legacyHome, "settings.json")));
    assert.ok(!fs.existsSync(path.join(appData, "reasonix", "settings.json")));
  });

  it("keeps using an active legacy settings file when the current home is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reasonix-fallback-"));
    tempDirs.push(root);
    const userHomeDir = path.join(root, "Home");
    const appData = path.join(root, "Roaming");
    const currentHome = path.join(appData, "reasonix");
    const legacySettings = path.join(userHomeDir, ".reasonix", "settings.json");
    fs.mkdirSync(currentHome, { recursive: true });
    fs.mkdirSync(path.dirname(legacySettings), { recursive: true });
    fs.writeFileSync(legacySettings, JSON.stringify({
      hooks: { Stop: [{ match: "*", command: "echo user-hook" }] },
    }));

    registerReasonixHooks({
      silent: true,
      platform: "win32",
      env: { APPDATA: appData },
      userHomeDir,
      nodeBin: "D:\\npm\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    assert.ok(!fs.existsSync(path.join(currentHome, "settings.json")));
    const stopCommands = readJson(legacySettings).hooks.Stop.map((entry) => entry.command);
    assert.ok(stopCommands.includes("echo user-hook"));
    assert.ok(stopCommands.some((command) =>
      (decodeWindowsEncodedCommand(command) || command).includes(MARKER)
    ));
  });

  it("installs all hook events with reasonix-hook.js marker", () => {
    const homeDir = makeTempHome();
    const result = registerReasonixHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.added, REASONIX_HOOK_EVENTS.length);
    assert.strictEqual(result.skipped, 0);

    const settings = readJson(path.join(homeDir, ".reasonix", "settings.json"));
    for (const event of REASONIX_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]), `missing ${event}`);
      assert.strictEqual(settings.hooks[event].length, 1);
      const command = settings.hooks[event][0].command;
      assert.ok((decodeWindowsEncodedCommand(command) || command).includes(MARKER));
    }
  });

  it("is idempotent on second run", () => {
    const homeDir = makeTempHome();
    registerReasonixHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    const result = registerReasonixHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.skipped, REASONIX_HOOK_EVENTS.length);
  });

  it("is idempotent for Windows EncodedCommand hooks", () => {
    const homeDir = makeTempHome();
    const options = {
      silent: true,
      homeDir,
      platform: "win32",
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    };

    const first = registerReasonixHooks(options);
    const second = registerReasonixHooks(options);

    assert.strictEqual(first.added, REASONIX_HOOK_EVENTS.length);
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.skipped, REASONIX_HOOK_EVENTS.length);

    const settings = readJson(path.join(homeDir, ".reasonix", "settings.json"));
    for (const event of REASONIX_HOOK_EVENTS) {
      assert.strictEqual(settings.hooks[event].length, 1, `duplicate encoded hook for ${event}`);
      assert.match(settings.hooks[event][0].command, /-EncodedCommand /);
      assert.match(decodeWindowsEncodedCommand(settings.hooks[event][0].command), /reasonix-hook\.js/);
    }
  });

  it("rewrites and dedupes existing Windows EncodedCommand hooks", () => {
    const homeDir = makeTempHome();
    const settingsPath = path.join(homeDir, ".reasonix", "settings.json");
    const options = {
      silent: true,
      homeDir,
      platform: "win32",
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    };
    const staleCommand = __test.buildReasonixHookCommand(
      "C:\\Old Node\\node.exe",
      "C:/old-clawd/hooks/reasonix-hook.js",
      options
    );
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { match: "*", command: staleCommand },
          { match: "*", command: "echo user-hook" },
          { match: "*", command: staleCommand },
        ],
      },
    }));

    const result = registerReasonixHooks(options);

    assert.strictEqual(result.added, REASONIX_HOOK_EVENTS.length - 1);
    assert.strictEqual(result.updated, 1);
    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.Stop.length, 2);
    assert.strictEqual(settings.hooks.Stop[1].command, "echo user-hook");
    const decoded = decodeWindowsEncodedCommand(settings.hooks.Stop[0].command);
    assert.match(decoded, /reasonix-hook\.js/);
    assert.doesNotMatch(decoded, /old-clawd/);
    assert.match(decoded, /C:\\Program Files\\nodejs\\node\.exe/);
  });

  it("uses PowerShell EncodedCommand on Windows even when paths have no spaces", () => {
    const nodeBin = "C:\\nodejs\\node.exe";
    const scriptPath = "C:/hooks/reasonix-hook.js";
    const command = __test.buildReasonixHookCommand(
      nodeBin,
      scriptPath,
      { platform: "win32", powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }
    );

    assert.ok(command.includes("-EncodedCommand"));
    const decoded = decodeWindowsEncodedCommand(command);
    assert.ok(decoded.includes(nodeBin));
    assert.ok(decoded.includes(scriptPath));
  });

  it("uses PowerShell EncodedCommand on Windows when node path has spaces", () => {
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const scriptPath = "D:/clawd/Clawd on Desk/resources/hooks/reasonix-hook.js";
    const command = __test.buildReasonixHookCommand(
      nodeBin,
      scriptPath,
      { platform: "win32", powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }
    );

    assert.ok(
      command.includes("-EncodedCommand"),
      "should use PowerShell encoded wrapper when node path has spaces"
    );
    assert.ok(command.startsWith("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"));

    const decoded = decodeWindowsEncodedCommand(command);
    assert.ok(decoded.includes(nodeBin), "encoded command should contain the absolute node path");
    assert.ok(decoded.includes(scriptPath), "encoded command should contain the script path");
    assert.ok(decoded.includes(MARKER), "encoded command should contain the marker");
  });

  it("uses PowerShell EncodedCommand on Windows when script path has spaces", () => {
    const nodeBin = "C:\\nodejs\\node.exe";
    const scriptPath = "D:/Clawd on Desk/hooks/reasonix-hook.js";
    const command = __test.buildReasonixHookCommand(
      nodeBin,
      scriptPath,
      { platform: "win32", powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }
    );

    assert.ok(command.includes("-EncodedCommand"));
    const decoded = decodeWindowsEncodedCommand(command);
    assert.ok(decoded.includes(nodeBin));
    assert.ok(decoded.includes(scriptPath));
    assert.ok(decoded.includes(MARKER));
  });

  it("emits a plain quoted command on non-Windows platforms", () => {
    const command = __test.buildReasonixHookCommand(
      "/usr/local/bin/node",
      "/home/u/clawd/hooks/reasonix-hook.js",
      { platform: "linux" }
    );

    assert.ok(!command.includes("-EncodedCommand"));
    assert.ok(command.includes("/usr/local/bin/node"));
    assert.ok(command.includes(MARKER));
  });

  it("uninstall removes only Clawd entries", () => {
    const homeDir = makeTempHome();
    const settingsPath = path.join(homeDir, ".reasonix", "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { match: "*", command: "echo user-hook" },
        ],
      },
    }));

    registerReasonixHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    const result = unregisterReasonixHooks({ silent: true, homeDir });

    assert.ok(result.removed > 0);
    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.Stop.length, 1);
    assert.strictEqual(settings.hooks.Stop[0].command, "echo user-hook");
  });

  it("uninstall removes Clawd hooks from both current and legacy Windows settings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reasonix-uninstall-"));
    tempDirs.push(root);
    const userHomeDir = path.join(root, "Home");
    const appData = path.join(root, "Roaming");
    const currentSettings = path.join(appData, "reasonix", "settings.json");
    const legacySettings = path.join(userHomeDir, ".reasonix", "settings.json");
    const clawdCommand = '"D:\\npm\\node.exe" "D:/Clawd on Desk/hooks/reasonix-hook.js"';
    for (const settingsPath of [currentSettings, legacySettings]) {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          Stop: [
            { match: "*", command: clawdCommand },
            { match: "*", command: "echo user-hook" },
          ],
        },
      }));
    }

    const result = unregisterReasonixHooks({
      silent: true,
      platform: "win32",
      env: { APPDATA: appData },
      userHomeDir,
    });

    assert.strictEqual(result.removed, 2);
    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual(result.settingsPaths, [currentSettings, legacySettings]);
    for (const settingsPath of [currentSettings, legacySettings]) {
      assert.deepStrictEqual(readJson(settingsPath).hooks.Stop, [
        { match: "*", command: "echo user-hook" },
      ]);
    }
  });

  it("continues cleaning the legacy settings when the current settings are invalid", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reasonix-uninstall-error-"));
    tempDirs.push(root);
    const userHomeDir = path.join(root, "Home");
    const appData = path.join(root, "Roaming");
    const currentSettings = path.join(appData, "reasonix", "settings.json");
    const legacySettings = path.join(userHomeDir, ".reasonix", "settings.json");
    fs.mkdirSync(path.dirname(currentSettings), { recursive: true });
    fs.writeFileSync(currentSettings, "{ invalid json", "utf8");
    fs.mkdirSync(path.dirname(legacySettings), { recursive: true });
    fs.writeFileSync(legacySettings, JSON.stringify({
      hooks: {
        Stop: [
          { match: "*", command: 'node "C:/clawd/hooks/reasonix-hook.js"' },
          { match: "*", command: "echo user-hook" },
        ],
      },
    }));

    const result = unregisterReasonixHooks({
      silent: true,
      platform: "win32",
      env: { APPDATA: appData },
      userHomeDir,
    });

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].settingsPath, currentSettings);
    assert.strictEqual(fs.readFileSync(currentSettings, "utf8"), "{ invalid json");
    assert.deepStrictEqual(readJson(legacySettings).hooks.Stop, [
      { match: "*", command: "echo user-hook" },
    ]);
  });
});
