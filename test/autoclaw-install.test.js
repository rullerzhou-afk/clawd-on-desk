"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  DEFAULT_CONFIG_PATH,
  DEFAULT_EXTENSIONS_DIR,
  DEFAULT_STATE_DIR,
  EXTENSION_DIR_NAME,
  MARKER_FILE,
  PLUGIN_FILES,
  ensurePluginEntry,
  hasIncludeDirective,
  inspectAutoClawExtension,
  isManagedPluginPath,
  registerAutoClawPlugin,
  resolveAutoClawPaths,
  resolvePluginDir,
  unregisterAutoClawPlugin,
} = require("../hooks/autoclaw-install");

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-autoclaw-install-"));
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

// A fixture mirroring the real layout: a source plugin dir (what ships with
// Clawd) and an AutoClaw state dir whose openclaw.json the app already wrote.
function makeFixture(config = { agents: { list: [] }, plugins: { load: { paths: ["/Applications/AutoClaw.app/Contents/Resources/extensions"] }, entries: { "autoclaw-stop-hook": { enabled: true } } } }) {
  const root = makeTempDir();
  const pluginDir = path.join(root, "hooks", "autoclaw-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.js"), "export default { id: 'clawd-on-desk', register() {} };\n", "utf8");
  writeJson(path.join(pluginDir, "package.json"), { name: "clawd-on-desk-autoclaw", type: "module", main: "./index.js" });
  writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id: "clawd-on-desk",
    name: "Clawd on Desk",
    description: "test",
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  const stateDir = path.join(root, ".openclaw-autoclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  if (config) writeJson(configPath, config);
  const extensionsDir = path.join(stateDir, "extensions");
  const extensionDir = path.join(extensionsDir, EXTENSION_DIR_NAME);
  const opts = { stateDir, configPath, extensionsDir, pluginDir, silent: true };
  return { root, pluginDir, stateDir, configPath, extensionsDir, extensionDir, opts };
}

function listStagingLeftovers(stateDir) {
  if (!fs.existsSync(stateDir)) return [];
  return fs.readdirSync(stateDir).filter((name) => name.startsWith(".clawd-autoclaw-"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("autoclaw plugin installer defaults", () => {
  it("targets the AutoClaw embedded gateway state dir and user extension root", () => {
    assert.strictEqual(DEFAULT_STATE_DIR, path.join(os.homedir(), ".openclaw-autoclaw"));
    assert.strictEqual(DEFAULT_CONFIG_PATH, path.join(DEFAULT_STATE_DIR, "openclaw.json"));
    assert.strictEqual(DEFAULT_EXTENSIONS_DIR, path.join(DEFAULT_STATE_DIR, "extensions"));
    assert.strictEqual(EXTENSION_DIR_NAME, "clawd-on-desk");
    assert.deepStrictEqual(PLUGIN_FILES, ["index.js", "package.json", "openclaw.plugin.json"]);
  });

  it("resolves paths from AUTOCLAW env overrides before defaults", () => {
    const env = {
      AUTOCLAW_STATE_DIR: "/tmp/ac-state",
      AUTOCLAW_CONFIG_PATH: "/tmp/ac-config.json",
    };
    assert.deepStrictEqual(resolveAutoClawPaths({ env }), {
      stateDir: "/tmp/ac-state",
      configPath: "/tmp/ac-config.json",
      extensionsDir: path.join("/tmp/ac-state", "extensions"),
      extensionDir: path.join("/tmp/ac-state", "extensions", "clawd-on-desk"),
    });
    assert.deepStrictEqual(resolveAutoClawPaths({ env: {} }), {
      stateDir: DEFAULT_STATE_DIR,
      configPath: DEFAULT_CONFIG_PATH,
      extensionsDir: DEFAULT_EXTENSIONS_DIR,
      extensionDir: path.join(DEFAULT_EXTENSIONS_DIR, "clawd-on-desk"),
    });
  });

  it("resolves a forward-slash source plugin dir", () => {
    const result = resolvePluginDir("/Applications/Clawd.app/Contents/Resources/app.asar/hooks");
    assert.ok(result.endsWith("/autoclaw-plugin"), `got: ${result}`);
    assert.ok(!result.includes("\\"));
  });
});

describe("autoclaw plugin installer", () => {
  it("skips when the AutoClaw gateway config does not exist yet", () => {
    const fx = makeFixture(null);

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "autoclaw-not-found");
    // No CLI fallback and no bootstrap: the app-authored state dir and
    // extension root must stay untouched.
    assert.strictEqual(fs.existsSync(fx.stateDir), false);
    assert.strictEqual(fs.existsSync(fx.extensionsDir), false);
  });

  it("skips when only the state dir exists but the config was never written", () => {
    const fx = makeFixture(null);
    fs.mkdirSync(fx.stateDir, { recursive: true });

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "autoclaw-not-found");
    assert.strictEqual(fs.existsSync(fx.extensionsDir), false);
  });

  it("materializes a marker-owned copy into extensions/ and enables the entry without touching load.paths", () => {
    const fx = makeFixture();

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.updated, true);
    assert.strictEqual(result.filesUpdated, true);
    assert.strictEqual(result.restartRequired, true);
    assert.strictEqual(result.extensionDir, fx.extensionDir);

    for (const name of PLUGIN_FILES) {
      assert.ok(
        fs.readFileSync(path.join(fx.extensionDir, name)).equals(fs.readFileSync(path.join(fx.pluginDir, name))),
        `${name} must be a byte-identical copy`
      );
    }
    const marker = readJson(path.join(fx.extensionDir, MARKER_FILE));
    assert.strictEqual(marker.owner, "clawd-on-desk");
    assert.strictEqual(marker.pluginId, "clawd-on-desk");
    assert.strictEqual(marker.agentId, "autoclaw");
    assert.deepStrictEqual(Object.keys(marker.filesSha256).sort(), [...PLUGIN_FILES].sort());

    const config = readJson(fx.configPath);
    assert.deepStrictEqual(config.agents, { list: [] });
    assert.deepStrictEqual(config.plugins.entries["clawd-on-desk"], {
      enabled: true,
      hooks: { allowConversationAccess: false },
    });
    assert.strictEqual(config.plugins.entries["autoclaw-stop-hook"].enabled, true);
    // AutoClaw keeps load.paths but deletes unknown entries; a linked load
    // path would also make the gateway see the plugin id twice.
    assert.deepStrictEqual(config.plugins.load.paths, ["/Applications/AutoClaw.app/Contents/Resources/extensions"]);
    assert.deepStrictEqual(listStagingLeftovers(fx.stateDir), []);
  });

  it("is idempotent once the copy and the entry are current", () => {
    const fx = makeFixture();
    registerAutoClawPlugin(fx.opts);
    const markerBefore = fs.readFileSync(path.join(fx.extensionDir, MARKER_FILE), "utf8");

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.updated, false);
    assert.strictEqual(result.filesUpdated, false);
    assert.strictEqual(result.restartRequired, false);
    assert.strictEqual(fs.readFileSync(path.join(fx.extensionDir, MARKER_FILE), "utf8"), markerBefore);
  });

  it("re-materializes an owned copy whose files drifted from the current source", () => {
    const fx = makeFixture();
    registerAutoClawPlugin(fx.opts);
    fs.writeFileSync(path.join(fx.pluginDir, "index.js"), "export default { id: 'clawd-on-desk', register() { /* v2 */ } };\n", "utf8");
    assert.strictEqual(inspectAutoClawExtension(fx.opts).state, "owned-stale");

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.filesUpdated, true);
    assert.strictEqual(result.restartRequired, true);
    assert.ok(fs.readFileSync(path.join(fx.extensionDir, "index.js"), "utf8").includes("v2"));
    assert.strictEqual(inspectAutoClawExtension(fx.opts).state, "owned");
    assert.deepStrictEqual(listStagingLeftovers(fx.stateDir), []);
  });

  it("refuses to replace a foreign extension dir and leaves the config untouched", () => {
    const fx = makeFixture();
    fs.mkdirSync(fx.extensionDir, { recursive: true });
    fs.writeFileSync(path.join(fx.extensionDir, "index.js"), "export default { id: 'someone-else' };\n", "utf8");
    const configBefore = fs.readFileSync(fx.configPath, "utf8");

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "extension-dir-foreign");
    assert.strictEqual(fs.readFileSync(path.join(fx.extensionDir, "index.js"), "utf8"), "export default { id: 'someone-else' };\n");
    assert.strictEqual(fs.existsSync(path.join(fx.extensionDir, MARKER_FILE)), false);
    // Enabling the entry would activate the foreign code under our id.
    assert.strictEqual(fs.readFileSync(fx.configPath, "utf8"), configBefore);
  });

  it("treats a corrupt ownership marker as foreign", () => {
    const fx = makeFixture();
    fs.mkdirSync(fx.extensionDir, { recursive: true });
    fs.writeFileSync(path.join(fx.extensionDir, MARKER_FILE), "{ not json", "utf8");
    fs.writeFileSync(path.join(fx.extensionDir, "index.js"), "x", "utf8");

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.reason, "extension-dir-foreign");
  });

  it("claims an empty extension dir", () => {
    const fx = makeFixture();
    fs.mkdirSync(fx.extensionDir, { recursive: true });

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.filesUpdated, true);
    assert.ok(fs.existsSync(path.join(fx.extensionDir, MARKER_FILE)));
  });

  it("migrates a legacy linked load path left by the first integration shape", () => {
    const fx = makeFixture({
      plugins: {
        load: { paths: ["/Applications/AutoClaw.app/Contents/Resources/extensions", "/old/clawd/hooks/autoclaw-plugin"] },
        entries: {},
      },
    });

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.installed, true);
    const config = readJson(fx.configPath);
    assert.deepStrictEqual(config.plugins.load.paths, ["/Applications/AutoClaw.app/Contents/Resources/extensions"]);
    assert.strictEqual(config.plugins.entries["clawd-on-desk"].enabled, true);
  });

  it("falls back instead of editing configs with include directives", () => {
    const fx = makeFixture({ plugins: { $include: "./plugins.json", entries: {} } });

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "config-has-include");
    assert.strictEqual(fs.existsSync(fx.extensionsDir), false);
  });

  it("reports non-strict JSON without mutating anything", () => {
    const fx = makeFixture(null);
    fs.mkdirSync(fx.stateDir, { recursive: true });
    fs.writeFileSync(fx.configPath, "{ // jsonc\n}", "utf8");

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "autoclaw-config-not-strict-json");
    assert.strictEqual(fs.readFileSync(fx.configPath, "utf8"), "{ // jsonc\n}");
    assert.strictEqual(fs.existsSync(fx.extensionsDir), false);
  });

  it("reports a missing plugin source without touching the target", () => {
    const fx = makeFixture();
    fs.rmSync(path.join(fx.pluginDir, "openclaw.plugin.json"));

    const result = registerAutoClawPlugin(fx.opts);

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "plugin-source-missing");
    assert.strictEqual(fs.existsSync(fx.extensionsDir), false);
    assert.strictEqual(readJson(fx.configPath).plugins.entries["clawd-on-desk"], undefined);
  });

  it("unregisters the entry, the legacy load path and the owned copy, keeping bundled plugins", () => {
    const fx = makeFixture({
      agents: { list: [] },
      plugins: {
        load: { paths: ["/Applications/AutoClaw.app/Contents/Resources/extensions", "/old/clawd/hooks/autoclaw-plugin"] },
        entries: { "autoclaw-stop-hook": { enabled: true } },
      },
    });
    registerAutoClawPlugin(fx.opts);
    assert.ok(fs.existsSync(fx.extensionDir));

    const result = unregisterAutoClawPlugin({ ...fx.opts, backup: true });

    assert.strictEqual(result.removed, true);
    assert.strictEqual(result.warning, undefined);
    assert.strictEqual(fs.existsSync(fx.extensionDir), false);
    assert.deepStrictEqual(listStagingLeftovers(fx.stateDir), []);
    const config = readJson(fx.configPath);
    assert.strictEqual(config.plugins.entries["clawd-on-desk"], undefined);
    assert.strictEqual(config.plugins.entries["autoclaw-stop-hook"].enabled, true);
    assert.deepStrictEqual(config.plugins.load.paths, ["/Applications/AutoClaw.app/Contents/Resources/extensions"]);
    assert.strictEqual(config.agents.list.length, 0);
    assert.ok(result.backupPath && fs.existsSync(result.backupPath));
  });

  it("leaves a foreign extension dir in place on uninstall and reports it", () => {
    const fx = makeFixture({ plugins: { entries: { "clawd-on-desk": { enabled: true } } } });
    fs.mkdirSync(fx.extensionDir, { recursive: true });
    fs.writeFileSync(path.join(fx.extensionDir, "index.js"), "foreign", "utf8");

    const result = unregisterAutoClawPlugin(fx.opts);

    assert.strictEqual(result.removed, true);
    assert.match(result.warning, /foreign/);
    assert.strictEqual(fs.readFileSync(path.join(fx.extensionDir, "index.js"), "utf8"), "foreign");
    assert.strictEqual(readJson(fx.configPath).plugins.entries["clawd-on-desk"], undefined);
  });

  it("reports skipped instead of removed when nothing is registered", () => {
    const fx = makeFixture({ plugins: { entries: {} } });

    const result = unregisterAutoClawPlugin(fx.opts);

    assert.strictEqual(result.removed, false);
    assert.strictEqual(result.skipped, true);
  });

  it("uninstalls cleanly when the config is already gone", () => {
    const fx = makeFixture(null);
    const result = unregisterAutoClawPlugin(fx.opts);
    assert.strictEqual(result.removed, false);
    assert.strictEqual(result.skipped, true);
  });
});

describe("autoclaw installer helpers", () => {
  it("keeps the legacy managed-path ownership rule scoped to the autoclaw-plugin basename", () => {
    const current = "C:/current/hooks/autoclaw-plugin";
    assert.strictEqual(isManagedPluginPath(current, current), true);
    assert.strictEqual(isManagedPluginPath("D:/stale/hooks/autoclaw-plugin", current), true);
    assert.strictEqual(isManagedPluginPath("relative/autoclaw-plugin", current), false);
    assert.strictEqual(isManagedPluginPath("C:/other/plugin", current), false);
    assert.strictEqual(isManagedPluginPath("C:/clawd/hooks/openclaw-plugin", current), false);
  });

  it("detects include directives recursively", () => {
    assert.strictEqual(hasIncludeDirective({ plugins: { entries: { x: { $include: "./x.json" } } } }), true);
    assert.strictEqual(hasIncludeDirective({ plugins: { entries: { x: { include: ["./x.json"] } } } }), true);
    assert.strictEqual(hasIncludeDirective({ plugins: { load: { paths: [] } } }), false);
  });

  it("adds only the entry to a minimal config object", () => {
    const config = { foo: true };
    const result = ensurePluginEntry(config);

    assert.deepStrictEqual(result, { updated: true });
    assert.strictEqual(config.foo, true);
    assert.strictEqual(config.plugins.load, undefined);
    assert.deepStrictEqual(config.plugins.entries["clawd-on-desk"], {
      enabled: true,
      hooks: { allowConversationAccess: false },
    });
  });

  it("ships a plugin source that satisfies the shared openclaw-plugin doctor contract", () => {
    const { validateOpenClawEntry } = require("../src/doctor-detectors/openclaw-entry-validator");
    const pluginDir = path.join(__dirname, "..", "hooks", "autoclaw-plugin");

    assert.deepStrictEqual(validateOpenClawEntry(pluginDir), { ok: true });
    for (const name of PLUGIN_FILES) {
      assert.ok(fs.existsSync(path.join(pluginDir, name)), `${name} must ship with the plugin`);
    }
  });
});
