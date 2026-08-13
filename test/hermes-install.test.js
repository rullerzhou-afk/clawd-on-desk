const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync: spawnProcessSync } = require("node:child_process");

const {
  HERMES_RESULT_SCHEMA_VERSION,
  PLUGIN_ID,
  MANAGED_PLUGIN_FILES,
  copyManagedPluginFiles,
  hermesHomesForSync,
  isHermesInstalled,
  registerHermesPlugin,
  resolveHermesHome,
  toHermesCliResult,
  unregisterHermesPlugin,
} = require("../hooks/hermes-install");

const tempDirs = [];

function makeTempDir(prefix = "clawd-hermes-install-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeSourcePlugin() {
  const dir = makeTempDir("clawd-hermes-source-");
  fs.writeFileSync(path.join(dir, "plugin.yaml"), "name: clawd-on-desk\n", "utf8");
  fs.writeFileSync(path.join(dir, "__init__.py"), "# plugin\n", "utf8");
  return dir;
}

function makeSpawn(status = 0, options = {}) {
  const calls = [];
  const fn = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    if (options.error) return { error: options.error };
    return {
      status,
      stdout: options.stdout || "",
      stderr: options.stderr || "",
    };
  };
  fn.calls = calls;
  return fn;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Hermes plugin installer", () => {
  it("copies managed plugin files and enables through Hermes CLI", () => {
    const sourcePluginDir = makeSourcePlugin();
    const hermesHome = makeTempDir();
    const spawnSync = makeSpawn();

    const result = registerHermesPlugin({
      silent: true,
      hermesHome,
      sourcePluginDir,
      hermesCommand: "hermes",
      spawnSync,
      env: {},
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.installed, MANAGED_PLUGIN_FILES.length);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.pluginDir, path.join(hermesHome, "plugins", PLUGIN_ID));
    assert.deepStrictEqual(spawnSync.calls.map((call) => call.args), [
      ["plugins", "enable", PLUGIN_ID],
    ]);
    assert.strictEqual(spawnSync.calls[0].options.env.HERMES_HOME, hermesHome);
    assert.strictEqual(
      fs.readFileSync(path.join(result.pluginDir, "plugin.yaml"), "utf8"),
      "name: clawd-on-desk\n"
    );
  });

  it("enables Clawd in every Hermes profile config", () => {
    const sourcePluginDir = makeSourcePlugin();
    const hermesHome = makeTempDir();
    const opsHome = path.join(hermesHome, "profiles", "ops");
    const browserHome = path.join(hermesHome, "profiles", "browser");
    const ignoredHome = path.join(hermesHome, "profiles", "scratch");
    fs.mkdirSync(opsHome, { recursive: true });
    fs.mkdirSync(browserHome, { recursive: true });
    fs.mkdirSync(ignoredHome, { recursive: true });
    fs.writeFileSync(path.join(opsHome, "config.yaml"), "plugins:\n  desktop_notify:\n    bell: true\n", "utf8");
    fs.writeFileSync(path.join(browserHome, "config.yaml"), "plugins:\n  enabled:\n  - other\n", "utf8");
    const spawnSync = makeSpawn();

    const result = registerHermesPlugin({
      silent: true,
      hermesHome,
      sourcePluginDir,
      hermesCommand: "hermes",
      spawnSync,
      env: {},
    });

    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(hermesHomesForSync({ hermesHome }), [hermesHome, browserHome, opsHome]);
    assert.deepStrictEqual(
      spawnSync.calls.map((call) => ({ args: call.args, hermesHome: call.options.env.HERMES_HOME })),
      [hermesHome, browserHome, opsHome].map((home) => ({
        args: ["plugins", "enable", PLUGIN_ID],
        hermesHome: home,
      }))
    );
    assert.deepStrictEqual(
      result.profileResults.map((entry) => entry.hermesHome),
      [hermesHome, browserHome, opsHome]
    );
    assert.ok(fs.existsSync(path.join(opsHome, "plugins", PLUGIN_ID, "__init__.py")));
    assert.ok(fs.existsSync(path.join(browserHome, "plugins", PLUGIN_ID, "__init__.py")));
    assert.ok(!fs.existsSync(path.join(ignoredHome, "plugins", PLUGIN_ID)));
  });

  it("reports partial profile sync without failing the primary Hermes home", () => {
    const sourcePluginDir = makeSourcePlugin();
    const hermesHome = makeTempDir();
    const opsHome = path.join(hermesHome, "profiles", "ops");
    const browserHome = path.join(hermesHome, "profiles", "browser");
    fs.mkdirSync(opsHome, { recursive: true });
    fs.mkdirSync(browserHome, { recursive: true });
    fs.writeFileSync(path.join(opsHome, "config.yaml"), "plugins: {}\n", "utf8");
    fs.writeFileSync(path.join(browserHome, "config.yaml"), "plugins: {}\n", "utf8");
    const calls = [];
    const spawnSync = (command, args, options) => {
      calls.push({ command, args, options });
      if (options.env.HERMES_HOME === opsHome) {
        return { status: 1, stdout: "", stderr: "profile enable failed" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = registerHermesPlugin({
      silent: true,
      hermesHome,
      sourcePluginDir,
      hermesCommand: "hermes",
      spawnSync,
      env: {},
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.profileStatus, "partial");
    assert.strictEqual(result.profileErrorCount, 1);
    assert.match(result.profileWarning, /profile enable failed/);
    assert.deepStrictEqual(calls.map((call) => call.options.env.HERMES_HOME), [hermesHome, browserHome, opsHome]);
    assert.deepStrictEqual(
      result.profileResults.map((entry) => [entry.hermesHome, entry.status]),
      [[hermesHome, "ok"], [browserHome, "ok"], [opsHome, "error"]]
    );
  });

  it("can skip Hermes profile sync when requested", () => {
    const sourcePluginDir = makeSourcePlugin();
    const hermesHome = makeTempDir();
    const opsHome = path.join(hermesHome, "profiles", "ops");
    fs.mkdirSync(opsHome, { recursive: true });
    fs.writeFileSync(path.join(opsHome, "config.yaml"), "plugins: {}\n", "utf8");
    const spawnSync = makeSpawn();

    const result = registerHermesPlugin({
      silent: true,
      hermesHome,
      sourcePluginDir,
      hermesCommand: "hermes",
      spawnSync,
      syncProfiles: false,
      env: {},
    });

    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(spawnSync.calls.map((call) => call.options.env.HERMES_HOME), [hermesHome]);
    assert.strictEqual(fs.existsSync(path.join(opsHome, "plugins", PLUGIN_ID)), false);
  });

  it("is idempotent when managed files already match", () => {
    const sourcePluginDir = makeSourcePlugin();
    const hermesHome = makeTempDir();
    const spawnSync = makeSpawn();

    registerHermesPlugin({
      silent: true,
      hermesHome,
      sourcePluginDir,
      hermesCommand: "hermes",
      spawnSync,
      env: {},
    });
    const second = registerHermesPlugin({
      silent: true,
      hermesHome,
      sourcePluginDir,
      hermesCommand: "hermes",
      spawnSync,
      env: {},
    });

    assert.strictEqual(second.status, "ok");
    assert.strictEqual(second.installed, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.skipped, MANAGED_PLUGIN_FILES.length);
  });

  it("updates stale managed files without deleting unmanaged plugin files", () => {
    const sourcePluginDir = makeSourcePlugin();
    const hermesHome = makeTempDir();
    const pluginDir = path.join(hermesHome, "plugins", PLUGIN_ID);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.yaml"), "old\n", "utf8");
    fs.writeFileSync(path.join(pluginDir, "custom.txt"), "keep\n", "utf8");

    const result = registerHermesPlugin({
      silent: true,
      hermesHome,
      sourcePluginDir,
      hermesCommand: "hermes",
      spawnSync: makeSpawn(),
      env: {},
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(fs.readFileSync(path.join(pluginDir, "custom.txt"), "utf8"), "keep\n");
  });

  it("does not edit config.yaml and returns a repairable error when CLI is unavailable", () => {
    const sourcePluginDir = makeSourcePlugin();
    const hermesHome = makeTempDir();
    const configPath = path.join(hermesHome, "config.yaml");
    fs.writeFileSync(configPath, "plugins:\n  enabled: []\n", "utf8");
    const enoent = new Error("spawn hermes ENOENT");
    enoent.code = "ENOENT";

    const result = registerHermesPlugin({
      silent: true,
      hermesHome,
      sourcePluginDir,
      hermesCommand: "hermes",
      spawnSync: makeSpawn(0, { error: enoent }),
      env: {},
    });

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "hermes-cli-unavailable");
    assert.match(result.message, /hermes plugins enable clawd-on-desk/);
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), "plugins:\n  enabled: []\n");
    assert.ok(fs.existsSync(path.join(result.pluginDir, "__init__.py")));
  });

  it("resolves HERMES_HOME before platform fallbacks", () => {
    const hermesHome = makeTempDir();
    const localAppData = makeTempDir();
    fs.mkdirSync(path.join(localAppData, "hermes"), { recursive: true });
    fs.writeFileSync(path.join(localAppData, "hermes", "config.yaml"), "x: y\n", "utf8");

    const resolved = resolveHermesHome({
      env: { HERMES_HOME: hermesHome, LOCALAPPDATA: localAppData },
      platform: "win32",
      homeDir: makeTempDir(),
    });

    assert.strictEqual(resolved, hermesHome);
  });

  it("uses LOCALAPPDATA/hermes on Windows when config.yaml exists", () => {
    const localAppData = makeTempDir();
    const localHermes = path.join(localAppData, "hermes");
    fs.mkdirSync(localHermes, { recursive: true });
    fs.writeFileSync(path.join(localHermes, "config.yaml"), "x: y\n", "utf8");

    const resolved = resolveHermesHome({
      env: { LOCALAPPDATA: localAppData },
      platform: "win32",
      homeDir: makeTempDir(),
    });

    assert.strictEqual(resolved, localHermes);
  });

  it("detects missing Hermes without creating the default home", () => {
    const homeDir = makeTempDir();
    const defaultHome = path.join(homeDir, ".hermes");

    const installed = isHermesInstalled({
      env: {},
      platform: "linux",
      homeDir,
    });

    assert.strictEqual(installed, false);
    assert.strictEqual(fs.existsSync(defaultHome), false);
  });

  it("detects Hermes from LOCALAPPDATA venv command without config.yaml", () => {
    const localAppData = makeTempDir();
    const command = path.join(localAppData, "hermes", "hermes-agent", "venv", "Scripts", "hermes.exe");
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, "", "utf8");

    const installed = isHermesInstalled({
      env: { LOCALAPPDATA: localAppData },
      platform: "win32",
      homeDir: makeTempDir(),
    });

    assert.strictEqual(installed, true);
  });

  it("uses LOCALAPPDATA/hermes as Hermes home when only the Windows venv command exists", () => {
    const sourcePluginDir = makeSourcePlugin();
    const localAppData = makeTempDir();
    const homeDir = makeTempDir();
    const localHermes = path.join(localAppData, "hermes");
    const command = path.join(localHermes, "hermes-agent", "venv", "Scripts", "hermes.exe");
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, "", "utf8");
    const spawnSync = makeSpawn();

    const result = registerHermesPlugin({
      silent: true,
      sourcePluginDir,
      env: { LOCALAPPDATA: localAppData },
      platform: "win32",
      homeDir,
      spawnSync,
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.hermesHome, localHermes);
    assert.strictEqual(result.pluginDir, path.join(localHermes, "plugins", PLUGIN_ID));
    assert.strictEqual(spawnSync.calls[0].command, command);
    assert.strictEqual(spawnSync.calls[0].options.env.HERMES_HOME, localHermes);
  });

  it("bounds Hermes CLI calls with a timeout and reports enable timeouts as repairable errors", () => {
    const sourcePluginDir = makeSourcePlugin();
    const hermesHome = makeTempDir();
    const timeout = new Error("spawnSync hermes ETIMEDOUT");
    timeout.code = "ETIMEDOUT";
    const spawnSync = makeSpawn(0, { error: timeout });

    const result = registerHermesPlugin({
      silent: true,
      hermesHome,
      sourcePluginDir,
      hermesCommand: "hermes",
      spawnSync,
      timeoutMs: 1234,
      env: {},
    });

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "hermes-cli-enable-failed");
    assert.match(result.message, /enabling failed/);
    assert.strictEqual(spawnSync.calls[0].options.timeout, 1234);
  });

  it("uninstaller disables through CLI and removes only the managed plugin directory", () => {
    const hermesHome = makeTempDir();
    const pluginDir = path.join(hermesHome, "plugins", PLUGIN_ID);
    const siblingDir = path.join(hermesHome, "plugins", "other-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.yaml"), "name: clawd-on-desk\n", "utf8");
    fs.writeFileSync(path.join(siblingDir, "plugin.yaml"), "name: other\n", "utf8");
    const spawnSync = makeSpawn();

    const result = unregisterHermesPlugin({
      silent: true,
      hermesHome,
      hermesCommand: "hermes",
      spawnSync,
      env: {},
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.removed, true);
    assert.deepStrictEqual(spawnSync.calls.map((call) => call.args), [
      ["plugins", "disable", PLUGIN_ID],
    ]);
    assert.strictEqual(fs.existsSync(pluginDir), false);
    assert.strictEqual(fs.existsSync(siblingDir), true);
  });

  it("uninstalls primary, configured profiles, and configless managed remnants symmetrically", () => {
    const hermesHome = makeTempDir();
    const configured = path.join(hermesHome, "profiles", "ops");
    const residual = path.join(hermesHome, "profiles", "old");
    fs.mkdirSync(path.join(hermesHome, "plugins", PLUGIN_ID), { recursive: true });
    fs.mkdirSync(path.join(configured, "plugins", PLUGIN_ID), { recursive: true });
    fs.mkdirSync(path.join(residual, "plugins", PLUGIN_ID), { recursive: true });
    fs.writeFileSync(path.join(hermesHome, "config.yaml"), "plugins: {}\n", "utf8");
    fs.writeFileSync(path.join(configured, "config.yaml"), "plugins: {}\n", "utf8");
    fs.writeFileSync(path.join(hermesHome, "plugins", PLUGIN_ID, "plugin.yaml"), "root\n", "utf8");
    fs.writeFileSync(path.join(configured, "plugins", PLUGIN_ID, "__init__.py"), "# configured\n", "utf8");
    fs.writeFileSync(path.join(residual, "plugins", PLUGIN_ID, "plugin.yaml"), "residual\n", "utf8");
    const spawnSync = makeSpawn();

    const result = unregisterHermesPlugin({
      silent: true,
      hermesHome,
      hermesCommand: "hermes",
      spawnSync,
      env: {},
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.removedCount, 3);
    assert.deepStrictEqual(
      spawnSync.calls.map((call) => call.options.env.HERMES_HOME).sort(),
      [hermesHome, configured].sort(),
      "configless residual must be removed without invoking Hermes CLI"
    );
    assert.strictEqual(fs.existsSync(path.join(hermesHome, "plugins", PLUGIN_ID)), false);
    assert.strictEqual(fs.existsSync(path.join(configured, "plugins", PLUGIN_ID)), false);
    assert.strictEqual(fs.existsSync(path.join(residual, "plugins", PLUGIN_ID)), false);
    assert.strictEqual(fs.existsSync(path.join(residual, "config.yaml")), false);
  });

  it("removes managed files but returns warnings when one profile cannot disable", () => {
    const hermesHome = makeTempDir();
    const profileHome = path.join(hermesHome, "profiles", "ops");
    for (const targetHome of [hermesHome, profileHome]) {
      fs.mkdirSync(path.join(targetHome, "plugins", PLUGIN_ID), { recursive: true });
      fs.writeFileSync(path.join(targetHome, "config.yaml"), "plugins: {}\n", "utf8");
      fs.writeFileSync(path.join(targetHome, "plugins", PLUGIN_ID, "plugin.yaml"), "managed\n", "utf8");
    }
    const calls = [];
    const spawnSync = (command, args, options) => {
      calls.push({ command, args, options });
      return options.env.HERMES_HOME === profileHome
        ? { status: 1, stdout: "", stderr: "profile disable failed" }
        : { status: 0, stdout: "", stderr: "" };
    };

    const result = unregisterHermesPlugin({ silent: true, hermesHome, hermesCommand: "hermes", spawnSync, env: {} });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /profile disable failed/);
    assert.strictEqual(fs.existsSync(path.join(profileHome, "plugins", PLUGIN_ID)), false);
    assert.strictEqual(calls.length, 2);
  });

  it("returns an error when a managed plugin directory cannot be removed", () => {
    const hermesHome = makeTempDir();
    const pluginDir = path.join(hermesHome, "plugins", PLUGIN_ID);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.yaml"), "managed\n", "utf8");
    const result = unregisterHermesPlugin({
      silent: true,
      hermesHome,
      hermesCommand: "hermes",
      spawnSync: makeSpawn(),
      rmSync: () => { throw new Error("locked"); },
      env: {},
    });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "hermes-plugin-remove-failed");
    assert.match(result.message, /locked/);
    assert.strictEqual(fs.existsSync(pluginDir), true);
  });

  it("preserves the old managed file when atomic replacement fails", () => {
    const sourcePluginDir = makeSourcePlugin();
    const pluginDir = makeTempDir();
    const dest = path.join(pluginDir, "plugin.yaml");
    fs.writeFileSync(dest, "old\n", "utf8");

    assert.throws(() => copyManagedPluginFiles({
      sourcePluginDir,
      pluginDir,
      renameSync: () => { throw new Error("rename failed"); },
    }), /rename failed/);
    assert.strictEqual(fs.readFileSync(dest, "utf8"), "old\n");
    assert.deepStrictEqual(
      fs.readdirSync(pluginDir).filter((name) => name.includes(".clawd-") && name.endsWith(".tmp")),
      []
    );
  });

  it("normalizes install and uninstall outcomes for the versioned CLI contract", () => {
    assert.deepStrictEqual(toHermesCliResult({ status: "ok", message: "done" }, "install"), {
      schemaVersion: HERMES_RESULT_SCHEMA_VERSION,
      operation: "install",
      status: "ok",
      message: "done",
      reason: null,
      warning: null,
      profileWarningCount: 0,
      profileErrorCount: 0,
    });
    const warning = toHermesCliResult({
      status: "ok",
      profileStatus: "partial",
      profileErrorCount: 2,
      message: "partial",
    }, "install");
    assert.strictEqual(warning.status, "warning");
    assert.strictEqual(warning.profileWarningCount, 2);
    assert.strictEqual(warning.warning, null);
    assert.match(toHermesCliResult({
      status: "ok",
      warnings: ["profile disable failed"],
      message: "removed with warnings",
    }, "uninstall").warning, /profile disable failed/);
    assert.strictEqual(toHermesCliResult({ status: "error", reason: "bad", message: "failed" }, "uninstall").status, "error");
  });

  it("prints one structured error sentinel when JSON-mode installation throws", () => {
    const hermesHome = makeTempDir();
    const pluginsDir = path.join(hermesHome, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, PLUGIN_ID), "blocks plugin directory creation\n", "utf8");

    const run = spawnProcessSync(process.execPath, [path.join(__dirname, "..", "hooks", "hermes-install.js"), "--json"], {
      encoding: "utf8",
      env: { ...process.env, HERMES_HOME: hermesHome },
      timeout: 10000,
      windowsHide: true,
    });

    assert.strictEqual(run.status, 1);
    const sentinelLines = run.stdout.split(/\r?\n/).filter((line) => line.startsWith("CLAWD_HERMES_RESULT_V1="));
    assert.strictEqual(sentinelLines.length, 1);
    const result = JSON.parse(sentinelLines[0].slice("CLAWD_HERMES_RESULT_V1=".length));
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "hermes-plugin-operation-threw");
  });
});
