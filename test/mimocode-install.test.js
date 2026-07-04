const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { registerMimocodePlugin, resolvePluginDir } = require("../hooks/mimocode-install");

const tempDirs = [];

function makeTempConfigDir(initial) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-mimocode-install-"));
  tempDirs.push(tmpDir);
  const configPath = path.join(tmpDir, "mimocode.jsonc");
  if (initial !== undefined) {
    fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), "utf8");
  }
  return configPath;
}

function readConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("mimocode plugin installer", () => {
  it("creates mimocode.jsonc when missing and registers the plugin path", () => {
    const configPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "clawd-mimocode-install-")),
      "mimocode.jsonc",
    );
    tempDirs.push(path.dirname(configPath));
    const pluginDir = "/fake/clawd/hooks/mimocode-plugin";

    const result = registerMimocodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(result.created, true);
    assert.strictEqual(result.added, true);
    const config = readConfig(configPath);
    assert.ok(Array.isArray(config.plugin));
    assert.deepStrictEqual(config.plugin, [pluginDir]);
    assert.strictEqual(config.$schema, "https://opencode.ai/config.json");
  });

  it("appends to an existing empty config without clobbering $schema", () => {
    const configPath = makeTempConfigDir({ $schema: "https://opencode.ai/config.json" });
    const pluginDir = "/fake/clawd/hooks/mimocode-plugin";

    const result = registerMimocodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(result.added, true);
    assert.strictEqual(result.created, false);
    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, [pluginDir]);
    assert.strictEqual(config.$schema, "https://opencode.ai/config.json");
  });

  it("preserves other plugins already in the plugin array", () => {
    const configPath = makeTempConfigDir({
      plugin: ["mimocode-wakatime", "@someone/other-plugin"],
    });
    const pluginDir = "/fake/clawd/hooks/mimocode-plugin";

    registerMimocodePlugin({ silent: true, configPath, pluginDir });

    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, [
      "mimocode-wakatime",
      "@someone/other-plugin",
      pluginDir,
    ]);
  });

  it("is idempotent on repeated registration", () => {
    const configPath = makeTempConfigDir({});
    const pluginDir = "/fake/clawd/hooks/mimocode-plugin";

    registerMimocodePlugin({ silent: true, configPath, pluginDir });
    const second = registerMimocodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(second.skipped, true);
    assert.strictEqual(second.added, false);
    const config = readConfig(configPath);
    assert.strictEqual(config.plugin.length, 1);
  });

  it("updates stale plugin paths in place by directory basename match", () => {
    const stalePath = "/old/install/location/hooks/mimocode-plugin";
    const configPath = makeTempConfigDir({
      plugin: ["mimocode-wakatime", stalePath],
    });
    const newPath = "/new/install/location/hooks/mimocode-plugin";

    const result = registerMimocodePlugin({
      silent: true,
      configPath,
      pluginDir: newPath,
    });

    assert.strictEqual(result.added, true);
    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, ["mimocode-wakatime", newPath]);
  });

  it("does not stomp third-party plugins whose name contains mimocode-plugin", () => {
    const thirdParty = "/some/where/mimocode-plugin-wakatime";
    const configPath = makeTempConfigDir({ plugin: [thirdParty] });
    const pluginDir = "/fake/clawd/hooks/mimocode-plugin";

    const result = registerMimocodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(result.added, true);
    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, [thirdParty, pluginDir]);
  });

  it("does not stomp scoped npm packages named mimocode-plugin", () => {
    const scoped = "@vendor/mimocode-plugin";
    const bareNpm = "mimocode-plugin";
    const configPath = makeTempConfigDir({ plugin: [scoped, bareNpm] });
    const pluginDir = "/fake/clawd/hooks/mimocode-plugin";

    const result = registerMimocodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(result.added, true);
    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, [scoped, bareNpm, pluginDir]);
  });

  it("updates stale Windows absolute plugin paths", () => {
    const staleWin = "C:/old/clawd/hooks/mimocode-plugin";
    const configPath = makeTempConfigDir({ plugin: [staleWin] });
    const pluginDir = "/new/clawd/hooks/mimocode-plugin";

    const result = registerMimocodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(result.added, true);
    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, [pluginDir]);
  });

  it("skips silently when ~/.config/mimocode/ does not exist (no configPath override)", () => {
    const fakeHome = path.join(os.tmpdir(), `clawd-mimocode-no-config-${Date.now()}`);
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      const result = registerMimocodePlugin({ silent: true });
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.added, false);
      assert.strictEqual(result.reason, "mimocode-not-found");
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
      else delete process.env.USERPROFILE;
    }
  });

  it("initializes plugin array when config has none", () => {
    const configPath = makeTempConfigDir({ $schema: "https://opencode.ai/config.json", theme: "dark" });
    const pluginDir = "/fake/clawd/hooks/mimocode-plugin";

    registerMimocodePlugin({ silent: true, configPath, pluginDir });

    const config = readConfig(configPath);
    assert.ok(Array.isArray(config.plugin));
    assert.strictEqual(config.theme, "dark");
    assert.deepStrictEqual(config.plugin, [pluginDir]);
  });
});

describe("resolvePluginDir (mimocode)", () => {
  it("returns a path ending with /mimocode-plugin and uses forward slashes", () => {
    const result = resolvePluginDir("/app/clawd/hooks");
    assert.ok(result.endsWith("/mimocode-plugin"), `got: ${result}`);
    assert.ok(!result.includes("\\"), `backslashes leaked: ${result}`);
    assert.ok(result.includes("/app/clawd/hooks/"), `base dir missing: ${result}`);
  });

  it("replaces app.asar with app.asar.unpacked for packaged builds", () => {
    const result = resolvePluginDir("/Applications/Clawd.app/Contents/Resources/app.asar/hooks");
    assert.ok(
      result.includes("app.asar.unpacked/hooks/mimocode-plugin"),
      `expected app.asar.unpacked segment, got: ${result}`,
    );
    assert.ok(
      !/app\.asar\/(?!unpacked)/.test(result),
      `bare app.asar/ segment remained: ${result}`,
    );
  });

  it("leaves non-asar paths unchanged apart from suffix append", () => {
    const result = resolvePluginDir("/home/user/clawd-dev/hooks");
    assert.ok(result.endsWith("/home/user/clawd-dev/hooks/mimocode-plugin"), `got: ${result}`);
    assert.ok(!result.includes("asar"), `asar keyword leaked: ${result}`);
  });
});
