const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync: spawnProcessSync } = require("node:child_process");

const {
  HERMES_RESULT_SCHEMA_VERSION,
  PLUGIN_ID,
  MANAGED_PLUGIN_FILES,
  SSH_SECURE_MARKER_CONTENT,
  SSH_SECURE_MARKER_FILENAME,
  classifyManagedPluginDir,
  copyManagedPluginFiles,
  hermesHomesForSync,
  isHermesInstalled,
  parseHermesCliArgs,
  registerHermesPlugin,
  registerHermesPluginRemote,
  resolveHermesCommand,
  resolveHermesHome,
  toHermesCliResult,
  unregisterHermesPlugin,
  unregisterHermesPluginRemote,
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

function makeRemoteSourcePlugin() {
  const dir = makeTempDir("clawd-hermes-remote-source-");
  fs.writeFileSync(path.join(dir, "plugin.yaml"), "name: clawd-on-desk\n", "utf8");
  fs.writeFileSync(
    path.join(dir, "__init__.py"),
    'CLAWD_SERVER_ID = "clawd-on-desk"\n',
    "utf8"
  );
  return dir;
}

function pluginDirFor(home) {
  return path.join(home, "plugins", PLUGIN_ID);
}

function writeRemotePlugin(home, sourcePluginDir, options = {}) {
  const pluginDir = pluginDirFor(home);
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const name of MANAGED_PLUGIN_FILES) {
    const content = options.stale
      ? `${name} stale\n`
      : fs.readFileSync(path.join(sourcePluginDir, name));
    fs.writeFileSync(path.join(pluginDir, name), content);
  }
  if (options.marker) {
    fs.writeFileSync(
      path.join(pluginDir, SSH_SECURE_MARKER_FILENAME),
      SSH_SECURE_MARKER_CONTENT,
      { mode: 0o600 }
    );
  }
  return pluginDir;
}

function remoteSpawn(options = {}) {
  const calls = [];
  const fn = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    if (command === "systemctl") {
      return options.systemctl || {
        status: 0,
        stdout: "hermes-gateway.service loaded active running Hermes gateway\nhermes-old.service loaded inactive dead Old\n",
        stderr: "",
      };
    }
    if (args[0] === "plugins" && args[1] === "list") {
      if (options.unavailable) {
        const error = new Error("spawn hermes ENOENT");
        error.code = "ENOENT";
        return { error };
      }
      return options.list || {
        status: 0,
        stdout: JSON.stringify([{ name: PLUGIN_ID, status: "enabled" }]),
        stderr: "",
      };
    }
    if (args[0] === "plugins" && args[1] === "enable") {
      if (options.enableFailureHome === spawnOptions.env.HERMES_HOME) {
        return { status: 1, stdout: "", stderr: "enable failed" };
      }
      if (options.writeEnabledConfig !== false) {
        fs.writeFileSync(
          path.join(spawnOptions.env.HERMES_HOME, "config.yaml"),
          "plugins:\n  enabled:\n    - clawd-on-desk\n",
          "utf8"
        );
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

function snapshotTree(root) {
  const result = {};
  function visit(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const key = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        result[`${key}/`] = null;
        visit(fullPath, key);
      } else {
        result[key] = fs.readFileSync(fullPath).toString("hex");
      }
    }
  }
  visit(root, "");
  return result;
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

describe("remote mode", () => {
  it("parses every remote CLI flag and rejects invalid arguments", () => {
    assert.deepStrictEqual(parseHermesCliArgs([
      "--remote",
      "--json",
      "--uninstall",
      "--source-dir",
      "/tmp/source",
      "--target-home",
      "/home/u/.hermes",
      "--target-home",
      "/home/u/.hermes/profiles/z",
      "--target-home",
      "/home/u/.hermes/profiles/a",
      "--cli-timeout-ms",
      "17000",
    ]), {
      uninstall: true,
      jsonMode: true,
      remote: true,
      sourceDir: "/tmp/source",
      targetHomes: [
        "/home/u/.hermes",
        "/home/u/.hermes/profiles/a",
        "/home/u/.hermes/profiles/z",
      ],
      cliTimeoutMs: 17000,
      errors: [],
    });
    assert.ok(parseHermesCliArgs(["--remote"]).errors.some((error) => error.includes("--json")));
    assert.ok(parseHermesCliArgs(["--remote", "--json", "--source-dir", "relative", "--target-home", "/x"])
      .errors.some((error) => error.includes("absolute POSIX")));
    assert.ok(parseHermesCliArgs(["--remote", "--json", "--source-dir", "/x", "--target-home", "relative"])
      .errors.some((error) => error.includes("absolute POSIX")));
    assert.ok(parseHermesCliArgs(["--unknown"]).errors.some((error) => error.includes("Unknown argument")));
  });

  it("classifies absent, managed, legacy, and foreign plugin directories", () => {
    const sourcePluginDir = makeRemoteSourcePlugin();
    const absent = makeTempDir();
    assert.strictEqual(classifyManagedPluginDir(pluginDirFor(absent)), "absent");

    const managed = makeTempDir();
    const managedPlugin = writeRemotePlugin(managed, sourcePluginDir, { marker: true });
    assert.strictEqual(classifyManagedPluginDir(managedPlugin), "managed");
    const pycache = path.join(managedPlugin, "__pycache__");
    fs.mkdirSync(pycache);
    fs.writeFileSync(path.join(pycache, "x.pyc"), "cache", "utf8");
    assert.strictEqual(classifyManagedPluginDir(managedPlugin), "managed");

    const legacy = makeTempDir();
    const legacyPlugin = writeRemotePlugin(legacy, sourcePluginDir);
    assert.strictEqual(classifyManagedPluginDir(legacyPlugin), "legacy");
    fs.writeFileSync(path.join(legacyPlugin, "__init__.py"), "# no ownership evidence\n", "utf8");
    assert.strictEqual(classifyManagedPluginDir(legacyPlugin), "foreign");

    const extra = makeTempDir();
    const extraPlugin = writeRemotePlugin(extra, sourcePluginDir, { marker: true });
    fs.writeFileSync(path.join(extraPlugin, "extra.txt"), "foreign\n", "utf8");
    assert.strictEqual(classifyManagedPluginDir(extraPlugin), "foreign");

    const invalidCache = makeTempDir();
    const invalidCachePlugin = writeRemotePlugin(invalidCache, sourcePluginDir, { marker: true });
    fs.mkdirSync(path.join(invalidCachePlugin, "__pycache__"));
    fs.writeFileSync(path.join(invalidCachePlugin, "__pycache__", "note.txt"), "foreign\n", "utf8");
    assert.strictEqual(classifyManagedPluginDir(invalidCachePlugin), "foreign");
  });

  it("classifies symlinked plugin directories and managed leaves", {
    skip: process.platform === "win32" ? "Windows symlink creation requires elevated privileges" : false,
  }, () => {
    const sourcePluginDir = makeRemoteSourcePlugin();
    const symlinkHome = makeTempDir();
    const symlinkTarget = makeTempDir();
    writeRemotePlugin(symlinkTarget, sourcePluginDir, { marker: true });
    fs.mkdirSync(path.join(symlinkHome, "plugins"), { recursive: true });
    fs.symlinkSync(pluginDirFor(symlinkTarget), pluginDirFor(symlinkHome), "junction");
    assert.strictEqual(classifyManagedPluginDir(pluginDirFor(symlinkHome)), "symlink");

    const leafSymlinkHome = makeTempDir();
    const leafPlugin = pluginDirFor(leafSymlinkHome);
    fs.mkdirSync(leafPlugin, { recursive: true });
    fs.writeFileSync(path.join(leafPlugin, "plugin.yaml"), "name: clawd-on-desk\n", "utf8");
    fs.symlinkSync(path.join(sourcePluginDir, "__init__.py"), path.join(leafPlugin, "__init__.py"), "file");
    assert.strictEqual(classifyManagedPluginDir(leafPlugin), "symlink");
  });

  it("uses the remote root venv, sibling .local command, then bare Hermes", () => {
    const parent = makeTempDir();
    const rootHome = path.join(parent, ".hermes");
    const localCommand = path.join(parent, ".local", "bin", "hermes");
    const venvCommand = path.join(rootHome, "hermes-agent", "venv", "bin", "hermes");
    fs.mkdirSync(path.dirname(localCommand), { recursive: true });
    fs.writeFileSync(localCommand, "", "utf8");
    assert.strictEqual(resolveHermesCommand({ hermesHome: rootHome, env: {}, platform: "linux", remote: true }), localCommand);
    fs.mkdirSync(path.dirname(venvCommand), { recursive: true });
    fs.writeFileSync(venvCommand, "", "utf8");
    assert.strictEqual(resolveHermesCommand({ hermesHome: rootHome, env: {}, platform: "linux", remote: true }), venvCommand);
    fs.unlinkSync(venvCommand);
    fs.unlinkSync(localCommand);
    assert.strictEqual(resolveHermesCommand({ hermesHome: rootHome, env: {}, platform: "linux", remote: true }), "hermes");
  });

  it("installs, verifies, marks, hashes, and diagnoses every frozen target", () => {
    const sourcePluginDir = makeRemoteSourcePlugin();
    const rootHome = makeTempDir();
    const legacyHome = makeTempDir();
    const managedHome = makeTempDir();
    const legacyPlugin = writeRemotePlugin(legacyHome, sourcePluginDir);
    fs.writeFileSync(path.join(legacyPlugin, "plugin.yaml"), 'name: "clawd-on-desk"\n', "utf8");
    fs.writeFileSync(
      path.join(legacyPlugin, "__init__.py"),
      'CLAWD_SERVER_ID = "clawd-on-desk"\n# stale\n',
      "utf8"
    );
    writeRemotePlugin(managedHome, sourcePluginDir, { marker: true });
    const spawnSync = remoteSpawn();

    const result = registerHermesPluginRemote({
      sourcePluginDir,
      targetHomes: [rootHome, legacyHome, managedHome],
      hermesCommand: "hermes",
      spawnSync,
      env: {},
      timeoutMs: 16000,
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.remote, true);
    assert.strictEqual(result.cliCommand, "hermes");
    assert.deepStrictEqual(result.activeGatewayUnits, ["hermes-gateway.service"]);
    assert.deepStrictEqual(result.targets.map((target) => [target.plugin, target.action, target.activation]), [
      ["absent", "installed", "next-session"],
      ["legacy", "updated", "restart-required"],
      ["managed", "unchanged", "unchanged"],
    ]);
    const expectedHashes = Object.fromEntries(MANAGED_PLUGIN_FILES.map((name) => [
      name,
      crypto.createHash("sha256").update(fs.readFileSync(path.join(sourcePluginDir, name))).digest("hex"),
    ]));
    for (const target of result.targets) {
      assert.deepStrictEqual(target.hashes, expectedHashes);
      assert.strictEqual(target.enabled, true);
      assert.strictEqual(target.marker, true);
      const markerPath = path.join(pluginDirFor(target.home), SSH_SECURE_MARKER_FILENAME);
      assert.strictEqual(fs.readFileSync(markerPath, "utf8"), SSH_SECURE_MARKER_CONTENT);
      if (process.platform !== "win32") assert.strictEqual(fs.statSync(markerPath).mode & 0o777, 0o600);
    }
    assert.ok(spawnSync.calls.filter((call) => call.args[1] === "enable")
      .every((call) => call.options.timeout === 16000));
    const wire = toHermesCliResult(result, "install");
    assert.strictEqual(wire.remote, true);
    assert.deepStrictEqual(wire.targets, result.targets);
  });

  it("treats one target enable failure as a hard remote failure", () => {
    const sourcePluginDir = makeRemoteSourcePlugin();
    const rootHome = makeTempDir();
    const profileHome = makeTempDir();
    const spawnSync = remoteSpawn({ enableFailureHome: profileHome });
    const result = registerHermesPluginRemote({
      sourcePluginDir,
      targetHomes: [rootHome, profileHome],
      hermesCommand: "hermes",
      spawnSync,
      env: {},
    });

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.targets[0].status, "ok");
    assert.strictEqual(result.targets[1].reason, "hermes-cli-enable-failed");
    assert.strictEqual(fs.existsSync(path.join(pluginDirFor(rootHome), SSH_SECURE_MARKER_FILENAME)), true);
    assert.strictEqual(fs.existsSync(path.join(pluginDirFor(profileHome), SSH_SECURE_MARKER_FILENAME)), false);
  });

  it("leaves an ownership conflict byte-identical while processing other targets", () => {
    const sourcePluginDir = makeRemoteSourcePlugin();
    const foreignHome = makeTempDir();
    const goodHome = makeTempDir();
    const foreignPlugin = writeRemotePlugin(foreignHome, sourcePluginDir, { marker: true });
    fs.writeFileSync(path.join(foreignPlugin, "owner.txt"), "do not touch\n", "utf8");
    const before = snapshotTree(foreignHome);
    const result = registerHermesPluginRemote({
      sourcePluginDir,
      targetHomes: [foreignHome, goodHome],
      hermesCommand: "hermes",
      spawnSync: remoteSpawn(),
      env: {},
    });

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.targets[0].reason, "hermes-plugin-ownership-conflict");
    assert.match(result.targets[0].message, /owner\.txt/);
    assert.deepStrictEqual(snapshotTree(foreignHome), before);
    assert.strictEqual(result.targets[1].status, "ok");
  });

  it("does not write a marker when enable or managed-file readback cannot be verified", () => {
    const sourcePluginDir = makeRemoteSourcePlugin();
    const unverifiedHome = makeTempDir();
    const unverified = registerHermesPluginRemote({
      sourcePluginDir,
      targetHomes: [unverifiedHome],
      hermesCommand: "hermes",
      spawnSync: remoteSpawn({ writeEnabledConfig: false }),
      env: {},
    });
    assert.strictEqual(unverified.targets[0].reason, "hermes-enable-not-verified");
    assert.strictEqual(fs.existsSync(path.join(pluginDirFor(unverifiedHome), SSH_SECURE_MARKER_FILENAME)), false);

    const corruptHome = makeTempDir();
    const corrupt = registerHermesPluginRemote({
      sourcePluginDir,
      targetHomes: [corruptHome],
      hermesCommand: "hermes",
      spawnSync: remoteSpawn(),
      env: {},
      writeFileSync: (filePath, content, options) => {
        const corrupted = path.basename(filePath).startsWith(".plugin.yaml.clawd-")
          ? Buffer.from("corrupt\n")
          : content;
        fs.writeFileSync(filePath, corrupted, options);
      },
    });
    assert.strictEqual(corrupt.targets[0].reason, "hermes-readback-mismatch");
    assert.strictEqual(fs.existsSync(path.join(pluginDirFor(corruptHome), SSH_SECURE_MARKER_FILENAME)), false);
  });

  it("fails every target without mutation when the remote CLI is unavailable", () => {
    const sourcePluginDir = makeRemoteSourcePlugin();
    const rootHome = makeTempDir();
    const profileHome = makeTempDir();
    const result = registerHermesPluginRemote({
      sourcePluginDir,
      targetHomes: [rootHome, profileHome],
      hermesCommand: "hermes",
      spawnSync: remoteSpawn({ unavailable: true }),
      env: {},
    });

    assert.strictEqual(result.status, "error");
    assert.ok(result.targets.every((target) => target.reason === "hermes-cli-unavailable"));
    assert.strictEqual(fs.existsSync(path.join(rootHome, "plugins")), false);
    assert.strictEqual(fs.existsSync(path.join(profileHome, "plugins")), false);
  });

  it("uninstalls exact managed leaves, skips disable without config, and preserves foreign content", () => {
    const sourcePluginDir = makeRemoteSourcePlugin();
    const rootHome = makeTempDir();
    const foreignHome = makeTempDir();
    const residualHome = makeTempDir();
    fs.writeFileSync(path.join(rootHome, "config.yaml"), "plugins: {}\n", "utf8");
    const rootPlugin = writeRemotePlugin(rootHome, sourcePluginDir, { marker: true });
    const rootCache = path.join(rootPlugin, "__pycache__");
    fs.mkdirSync(rootCache);
    fs.writeFileSync(path.join(rootCache, "root.pyc"), "cache", "utf8");
    const foreignPlugin = writeRemotePlugin(foreignHome, sourcePluginDir, { marker: true });
    fs.writeFileSync(path.join(foreignPlugin, "foreign.txt"), "keep\n", "utf8");
    writeRemotePlugin(residualHome, sourcePluginDir, { marker: true });
    const foreignBefore = snapshotTree(foreignHome);
    const spawnSync = remoteSpawn();

    const result = unregisterHermesPluginRemote({
      targetHomes: [rootHome, foreignHome, residualHome],
      hermesCommand: "hermes",
      spawnSync,
      env: {},
    });

    assert.strictEqual(result.status, "warning");
    assert.deepStrictEqual(result.targets.map((target) => target.action), ["removed", "skipped", "removed"]);
    assert.strictEqual(result.targets[1].reason, "hermes-plugin-ownership-conflict");
    assert.strictEqual(fs.existsSync(rootPlugin), false);
    assert.strictEqual(fs.existsSync(pluginDirFor(residualHome)), false);
    assert.deepStrictEqual(snapshotTree(foreignHome), foreignBefore);
    assert.deepStrictEqual(
      spawnSync.calls.filter((call) => call.args[1] === "disable").map((call) => call.options.env.HERMES_HOME),
      [rootHome]
    );
  });

  it("prints one invalid-argument sentinel and exits non-zero for a malformed remote CLI", () => {
    const run = spawnProcessSync(process.execPath, [
      path.join(__dirname, "..", "hooks", "hermes-install.js"),
      "--remote",
      "--source-dir",
      "/tmp/source",
      "--target-home",
      "/home/u/.hermes",
    ], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.strictEqual(run.status, 1);
    const lines = run.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].startsWith("CLAWD_HERMES_RESULT_V1="));
    const result = JSON.parse(lines[0].slice("CLAWD_HERMES_RESULT_V1=".length));
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "invalid-arguments");
    assert.strictEqual(result.remote, true);
  });
});
