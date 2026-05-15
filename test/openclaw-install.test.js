"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ensureOpenClawConfigLinked,
  hasIncludeDirective,
  registerOpenClawPlugin,
  resolvePluginDir,
  unregisterOpenClawPlugin,
} = require("../hooks/openclaw-install");

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-openclaw-install-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("openclaw plugin installer", () => {
  it("skips when OpenClaw is not installed and no config exists", () => {
    const root = makeTempDir();
    const stateDir = path.join(root, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");

    const result = registerOpenClawPlugin({
      stateDir,
      configPath,
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "openclaw-not-found");
    assert.strictEqual(fs.existsSync(configPath), false);
  });

  it("does not create OpenClaw config during startup sync", () => {
    const root = makeTempDir();
    const stateDir = path.join(root, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(stateDir, "openclaw.json");

    const result = registerOpenClawPlugin({
      stateDir,
      configPath,
      openclawCommandAvailable: true,
      silent: true,
    });

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "openclaw-config-missing");
    assert.strictEqual(fs.existsSync(configPath), false);
  });

  it("links the plugin into an existing strict JSON config", () => {
    const root = makeTempDir();
    const stateDir = path.join(root, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const pluginDir = "C:/clawd/hooks/openclaw-plugin";
    writeJson(configPath, { theme: "dark", plugins: { load: { paths: [] }, entries: {} } });

    const result = registerOpenClawPlugin({
      stateDir,
      configPath,
      pluginDir,
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.updated, true);
    const config = readJson(configPath);
    assert.strictEqual(config.theme, "dark");
    assert.deepStrictEqual(config.plugins.load.paths, [pluginDir]);
    assert.deepStrictEqual(config.plugins.entries["clawd-on-desk"], {
      enabled: true,
      hooks: { allowConversationAccess: false },
    });
  });

  it("is idempotent when the plugin is already linked", () => {
    const root = makeTempDir();
    const stateDir = path.join(root, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const pluginDir = "C:/clawd/hooks/openclaw-plugin";
    writeJson(configPath, {
      plugins: {
        load: { paths: [pluginDir] },
        entries: {
          "clawd-on-desk": {
            enabled: true,
            hooks: { allowConversationAccess: false },
          },
        },
      },
    });

    const result = registerOpenClawPlugin({
      stateDir,
      configPath,
      pluginDir,
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.updated, false);
  });

  it("updates stale absolute plugin paths by basename", () => {
    const root = makeTempDir();
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    const stalePath = "D:/old/hooks/openclaw-plugin";
    const pluginDir = "D:/new/hooks/openclaw-plugin";
    writeJson(configPath, {
      plugins: {
        load: { paths: [stalePath] },
        entries: { "clawd-on-desk": { enabled: false } },
      },
    });

    const result = registerOpenClawPlugin({
      configPath,
      pluginDir,
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.updated, true);
    const config = readJson(configPath);
    assert.deepStrictEqual(config.plugins.load.paths, [pluginDir]);
    assert.strictEqual(config.plugins.entries["clawd-on-desk"].enabled, true);
  });

  it("falls back instead of editing configs with include directives", () => {
    const root = makeTempDir();
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    writeJson(configPath, {
      plugins: {
        $include: "./plugins.json",
        load: { paths: [] },
      },
    });

    const result = registerOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "config-has-include");
    assert.deepStrictEqual(readJson(configPath).plugins.load.paths, []);
  });

  it("uses CLI fallback for JSON5 or missing config only when explicitly requested", () => {
    const root = makeTempDir();
    const stateDir = path.join(root, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(stateDir, "openclaw.json");
    const calls = [];

    const result = registerOpenClawPlugin({
      stateDir,
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: (command, args) => {
        calls.push([command, args]);
        return { status: 0, stdout: "Linked plugin path", stderr: "" };
      },
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
    assert.strictEqual(result.installed, true);
    assert.deepStrictEqual(calls, [[
      "openclaw",
      ["plugins", "install", "--link", "C:/clawd/hooks/openclaw-plugin"],
    ]]);
    assert.strictEqual(fs.existsSync(configPath), false);
  });

  it("unregisters the managed path from strict JSON config", () => {
    const root = makeTempDir();
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    const pluginDir = "C:/clawd/hooks/openclaw-plugin";
    writeJson(configPath, {
      plugins: {
        load: { paths: [pluginDir, "C:/other/plugin"] },
        entries: { "clawd-on-desk": { enabled: true } },
      },
    });

    const result = unregisterOpenClawPlugin({
      configPath,
      pluginDir,
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.removed, true);
    const config = readJson(configPath);
    assert.deepStrictEqual(config.plugins.load.paths, ["C:/other/plugin"]);
    assert.strictEqual(config.plugins.entries["clawd-on-desk"], undefined);
  });
});

describe("openclaw installer helpers", () => {
  it("detects include directives recursively", () => {
    assert.strictEqual(hasIncludeDirective({ plugins: { entries: { x: { $include: "./x.json" } } } }), true);
    assert.strictEqual(hasIncludeDirective({ plugins: { entries: { x: { include: ["./x.json"] } } } }), true);
    assert.strictEqual(hasIncludeDirective({ plugins: { load: { paths: [] } } }), false);
  });

  it("can link a minimal config object without clobbering other keys", () => {
    const config = { foo: true };
    const result = ensureOpenClawConfigLinked(config, "C:/clawd/hooks/openclaw-plugin");

    assert.deepStrictEqual(result, { updated: true });
    assert.strictEqual(config.foo, true);
    assert.deepStrictEqual(config.plugins.load.paths, ["C:/clawd/hooks/openclaw-plugin"]);
  });

  it("resolves a forward-slash plugin path and rewrites app.asar", () => {
    const result = resolvePluginDir("/Applications/Clawd.app/Contents/Resources/app.asar/hooks");

    assert.ok(result.endsWith("/openclaw-plugin"), `got: ${result}`);
    assert.ok(result.includes("app.asar.unpacked/hooks/openclaw-plugin"), `got: ${result}`);
    assert.ok(!result.includes("\\"));
  });
});
