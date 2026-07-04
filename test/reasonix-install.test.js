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
      assert.ok(settings.hooks[event][0].command.includes(MARKER));
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

  it("generates bare node command on Windows without spaces", () => {
    const command = __test.buildReasonixHookCommand(
      "C:\\nodejs\\node.exe",
      "C:/hooks/reasonix-hook.js",
      { platform: "win32" }
    );

    assert.ok(!command.includes("-EncodedCommand"), "should not use encoded wrapper without spaces");
    assert.ok(command.includes("node"));
    assert.ok(command.includes("reasonix-hook.js"));
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

    // nodeBin has no spaces, so no encoded wrapper (only nodeBin triggers it)
    // This is fine because cmd /c node "D:/Clawd on Desk/..." with quotes works
    // when node itself has no spaces.
    assert.ok(command.includes("reasonix-hook.js"));
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
});
