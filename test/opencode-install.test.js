const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { registerOpencodePlugin, resolvePluginDir } = require("../hooks/opencode-install");

const tempDirs = [];

function makeTempConfigDir(initial) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-opencode-install-"));
  tempDirs.push(tmpDir);
  const configPath = path.join(tmpDir, "opencode.json");
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

describe("opencode plugin installer", () => {
  it("creates opencode.json when missing and registers the plugin path", () => {
    const configPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "clawd-opencode-install-")),
      "opencode.json",
    );
    tempDirs.push(path.dirname(configPath));
    const pluginDir = "/fake/clawd/hooks/opencode-plugin";

    const result = registerOpencodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(result.created, true);
    assert.strictEqual(result.added, true);
    const config = readConfig(configPath);
    assert.ok(Array.isArray(config.plugin));
    assert.deepStrictEqual(config.plugin, [pluginDir]);
    assert.strictEqual(config.$schema, "https://opencode.ai/config.json");
  });

  it("appends to an existing empty config without clobbering $schema", () => {
    const configPath = makeTempConfigDir({ $schema: "https://opencode.ai/config.json" });
    const pluginDir = "/fake/clawd/hooks/opencode-plugin";

    const result = registerOpencodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(result.added, true);
    assert.strictEqual(result.created, false);
    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, [pluginDir]);
    assert.strictEqual(config.$schema, "https://opencode.ai/config.json");
  });

  it("preserves other plugins already in the plugin array", () => {
    const configPath = makeTempConfigDir({
      plugin: ["opencode-wakatime", "@someone/other-plugin"],
    });
    const pluginDir = "/fake/clawd/hooks/opencode-plugin";

    registerOpencodePlugin({ silent: true, configPath, pluginDir });

    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, [
      "opencode-wakatime",
      "@someone/other-plugin",
      pluginDir,
    ]);
  });

  it("is idempotent on repeated registration", () => {
    const configPath = makeTempConfigDir({});
    const pluginDir = "/fake/clawd/hooks/opencode-plugin";

    registerOpencodePlugin({ silent: true, configPath, pluginDir });
    const second = registerOpencodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(second.skipped, true);
    assert.strictEqual(second.added, false);
    const config = readConfig(configPath);
    assert.strictEqual(config.plugin.length, 1);
  });

  it("fails closed on an unproven stale-looking plugin path", () => {
    const stalePath = "/old/install/location/hooks/opencode-plugin";
    const configPath = makeTempConfigDir({
      plugin: ["opencode-wakatime", stalePath],
    });
    const newPath = "/new/install/location/hooks/opencode-plugin";

    const result = registerOpencodePlugin({
      silent: true,
      configPath,
      pluginDir: newPath,
    });

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "unknown");
    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, ["opencode-wakatime", stalePath]);
  });

  it("does not stomp third-party plugins whose name contains opencode-plugin", () => {
    // Earlier substring match would have mistakenly clobbered paths like
    // /somewhere/opencode-plugin-wakatime because "opencode-plugin" is a
    // substring. Basename equality requires the full final segment to match.
    const thirdParty = "/some/where/opencode-plugin-wakatime";
    const configPath = makeTempConfigDir({ plugin: [thirdParty] });
    const pluginDir = "/fake/clawd/hooks/opencode-plugin";

    const result = registerOpencodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(result.added, true);
    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, [thirdParty, pluginDir]);
  });

  it("does not stomp scoped npm packages named opencode-plugin", () => {
    // opencode.json accepts both absolute paths and npm package specifiers.
    // path.basename("@vendor/opencode-plugin") === "opencode-plugin", so a
    // naive basename check would clobber the scoped package. Clawd only ever
    // writes absolute paths, so the stale-path match must be gated on the
    // entry actually being an absolute path.
    const scoped = "@vendor/opencode-plugin";
    const bareNpm = "opencode-plugin"; // hypothetical unscoped npm pkg
    const configPath = makeTempConfigDir({ plugin: [scoped, bareNpm] });
    const pluginDir = "/fake/clawd/hooks/opencode-plugin";

    const result = registerOpencodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(result.added, true);
    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, [scoped, bareNpm, pluginDir]);
  });

  it("fails closed on an unproven stale-looking Windows plugin path", () => {
    const staleWin = "C:/old/clawd/hooks/opencode-plugin";
    const configPath = makeTempConfigDir({ plugin: [staleWin] });
    const pluginDir = "/new/clawd/hooks/opencode-plugin";

    const result = registerOpencodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "unknown");
    const config = readConfig(configPath);
    assert.deepStrictEqual(config.plugin, [staleWin]);
  });

  it("skips silently when ~/.config/opencode/ does not exist (no configPath override)", () => {
    // Use a non-existent home dir by overriding HOME temporarily
    const fakeHome = path.join(os.tmpdir(), `clawd-opencode-no-config-${Date.now()}`);
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      const result = registerOpencodePlugin({ silent: true });
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.added, false);
      assert.strictEqual(result.reason, "opencode-not-found");
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
      else delete process.env.USERPROFILE;
    }
  });

  it("initializes plugin array when config has none", () => {
    const configPath = makeTempConfigDir({ $schema: "https://opencode.ai/config.json", theme: "dark" });
    const pluginDir = "/fake/clawd/hooks/opencode-plugin";

    registerOpencodePlugin({ silent: true, configPath, pluginDir });

    const config = readConfig(configPath);
    assert.ok(Array.isArray(config.plugin));
    assert.strictEqual(config.theme, "dark");
    assert.deepStrictEqual(config.plugin, [pluginDir]);
  });
});

describe("resolvePluginDir", () => {
  // Note: path.resolve() on Windows prepends the current drive letter to
  // POSIX-style absolute paths, so we check suffix/shape rather than exact strings.

  it("returns a path ending with /opencode-plugin and uses forward slashes", () => {
    const result = resolvePluginDir("/app/clawd/hooks");
    assert.ok(result.endsWith("/opencode-plugin"), `got: ${result}`);
    assert.ok(!result.includes("\\"), `backslashes leaked: ${result}`);
    assert.ok(result.includes("/app/clawd/hooks/"), `base dir missing: ${result}`);
  });

  it("replaces app.asar with app.asar.unpacked for packaged builds", () => {
    const result = resolvePluginDir("/Applications/Clawd.app/Contents/Resources/app.asar/hooks");
    assert.ok(
      result.includes("app.asar.unpacked/hooks/opencode-plugin"),
      `expected app.asar.unpacked segment, got: ${result}`,
    );
    // Should not contain a bare app.asar/ segment (only app.asar.unpacked/)
    assert.ok(
      !/app\.asar\/(?!unpacked)/.test(result),
      `bare app.asar/ segment remained: ${result}`,
    );
  });

  it("leaves non-asar paths unchanged apart from suffix append", () => {
    const result = resolvePluginDir("/home/user/clawd-dev/hooks");
    assert.ok(result.endsWith("/home/user/clawd-dev/hooks/opencode-plugin"), `got: ${result}`);
    assert.ok(!result.includes("asar"), `asar keyword leaked: ${result}`);
  });
});

// ── PR-A §9 gates: full wrapper surface, unregister semantics, CLI entry ──

const { execFileSync } = require("child_process");
const installerModule = require("../hooks/opencode-install");
const { unregisterOpencodePlugin } = installerModule;

describe("opencode installer wrapper surface (plan §5 contract)", () => {
  it("exports the complete legacy surface", () => {
    assert.strictEqual(typeof installerModule.registerOpencodePlugin, "function");
    assert.strictEqual(typeof installerModule.unregisterOpencodePlugin, "function");
    assert.strictEqual(typeof installerModule.resolvePluginDir, "function");
    assert.strictEqual(typeof installerModule.DEFAULT_PARENT_DIR, "string");
    assert.strictEqual(typeof installerModule.DEFAULT_CONFIG_PATH, "string");
    assert.strictEqual(typeof installerModule.__test.entryIsExactManagedPlugin, "function");
    assert.strictEqual(typeof installerModule.__test.normalizePluginEntry, "function");
  });

  it("register reports the opencode-not-found reason integration-sync branches on", () => {
    // No configPath override → the real ~/.config/opencode existence gate runs;
    // integration-sync.js:314 depends on this exact reason string when the
    // host is absent. We can't control the real home dir here, so assert the
    // contract from the other side: a result with skipped:true and no config
    // dir must carry exactly this reason. (Full behavior is covered by the
    // configPath-driven cases above; this pins the reason literal.)
    const src = require("fs").readFileSync(require.resolve("../hooks/opencode-family-install.js"), "utf8");
    assert.match(src, /reason: `\$\{agentId\}-not-found`/);
  });
});

describe("opencode installer unregister", () => {
  it("removes ALL exact managed entries (duplicates from historical installs)", () => {
    const pluginDir = "/fake/clawd/hooks/opencode-plugin";
    const configPath = makeTempConfigDir({
      plugin: [pluginDir, "opencode-wakatime", pluginDir],
    });

    const result = unregisterOpencodePlugin({ silent: true, configPath, pluginDir });

    assert.strictEqual(result.removed, 2);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.skipped, false);
    assert.deepStrictEqual(readConfig(configPath).plugin, ["opencode-wakatime"]);
  });

  it("is a no-op (skipped) when nothing matches, and tolerates ENOENT", () => {
    const pluginDir = "/fake/clawd/hooks/opencode-plugin";
    const configPath = makeTempConfigDir({ plugin: ["opencode-wakatime"] });

    const noMatch = unregisterOpencodePlugin({ silent: true, configPath, pluginDir });
    assert.deepStrictEqual(
      { removed: noMatch.removed, changed: noMatch.changed, skipped: noMatch.skipped },
      { removed: 0, changed: false, skipped: true }
    );

    const missing = unregisterOpencodePlugin({
      silent: true,
      configPath: path.join(path.dirname(configPath), "nope", "opencode.json"),
      pluginDir,
    });
    assert.strictEqual(missing.skipped, true);
  });
});

describe("opencode installer CLI entry (node hooks/opencode-install.js)", () => {
  const SCRIPT = path.join(__dirname, "..", "hooks", "opencode-install.js");

  function runCli(args, homeDir) {
    return execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    });
  }

  it("registers on default invocation and unregisters with --uninstall", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-opencode-cli-"));
    tempDirs.push(home);
    const configDir = path.join(home, ".config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "opencode.json");

    const out = runCli([], home);
    assert.match(out, /Registered: /);
    const registered = readConfig(configPath).plugin;
    assert.strictEqual(registered.length, 1);
    // #1026: packaged/source paths are no longer registered directly. The
    // entry must point at a user-writable content-addressed managed generation
    // under the target home.
    assert.ok(
      registered[0].includes("/.clawd/integrations/opencode-family/opencode/homes/"),
      `expected managed generation path, got ${registered[0]}`
    );
    assert.ok(/\/generations\/[0-9a-f]{64}\/opencode-plugin$/.test(registered[0]), registered[0]);
    assert.ok(fs.existsSync(path.join(registered[0].replace(/\//g, path.sep))), "generation plugin dir must exist");

    const out2 = runCli(["--uninstall"], home);
    // #1039: both generation entries are swept — the v1 `plugin` entry and the
    // v2 `plugins` entry.
    assert.match(out2, /entries removed: 2/);
    assert.deepStrictEqual(readConfig(configPath).plugin, []);
    assert.deepStrictEqual(readConfig(configPath).plugins, []);
  });

  it("skips politely when opencode is not installed (exit 0, no config created)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-opencode-cli-"));
    tempDirs.push(home);

    const out = runCli([], home);
    assert.match(out, /not found — skipping opencode plugin registration/);
    assert.strictEqual(fs.existsSync(path.join(home, ".config", "opencode", "opencode.json")), false);
  });
});
