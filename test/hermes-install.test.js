const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  PLUGIN_ID,
  MANAGED_PLUGIN_FILES,
  isHermesInstalled,
  registerHermesPlugin,
  resolveHermesHome,
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
});
