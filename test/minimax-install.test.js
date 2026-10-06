const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  installMinimaxPlugin,
  unregisterMinimaxPlugin,
  readOwnership,
  resolveMinimaxDataDir,
  desiredManifest,
  buildDesiredHooksDocument,
  buildOwnerMarker,
  resolveHookScriptPath,
  MINIMAX_HOOK_EVENTS,
  OWNER_MARKER_FILE,
  PLUGIN_DIR_NAME,
  REMOVAL_PREFIX,
  STAGING_PREFIX,
  recordedNodeBin,
  resolveDesiredNodeBin,
  hooksReferenceClawdHook,
} = require("../hooks/minimax-install");
const { writeJsonAtomic } = require("../hooks/json-utils");

const MARKER = "minimax-hook.js";
const tempDirs = [];

function makeTempDataDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-minimax-"));
  tempDirs.push(tmpDir);
  return tmpDir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

// What the first (pre-marker) MiniMax build wrote: manifest + hooks, no marker.
function writePreMarkerInstall(pluginRoot, hooks) {
  writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), desiredManifest());
  writeJsonFile(
    path.join(pluginRoot, "hooks", "hooks.json"),
    hooks || buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node")
  );
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("MiniMax plugin installer", () => {
  it("writes the Clawd-owned plugin directory with a compatible manifest and CLAUDE-format hooks", () => {
    const dataDir = makeTempDataDir();
    const result = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });

    assert.strictEqual(result.added, MINIMAX_HOOK_EVENTS.length);

    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    // Ownership is a structured marker (the Pi extension's convention), never
    // a directory name, manifest name or basename.
    assert.deepStrictEqual(readJson(path.join(pluginRoot, OWNER_MARKER_FILE)), {
      app: "clawd-on-desk",
      integration: "minimax",
      managed: true,
      version: 1,
    });
    const manifest = readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
    assert.strictEqual(manifest.name, PLUGIN_DIR_NAME);
    assert.deepStrictEqual(manifest.hooks, ["hooks/hooks.json"]);

    const hooks = readJson(path.join(pluginRoot, "hooks", "hooks.json"));
    for (const event of MINIMAX_HOOK_EVENTS) {
      assert.ok(Array.isArray(hooks.hooks[event]), `missing hooks for ${event}`);
      assert.strictEqual(hooks.hooks[event].length, 1);
      const group = hooks.hooks[event][0];
      assert.strictEqual(group.matcher, undefined, "matcher omitted must match all tools");
      assert.ok(Array.isArray(group.hooks));
      const handler = group.hooks[0];
      assert.strictEqual(handler.type, "command");
      // Exec-form args: command is the bare node path, the hook script rides
      // in args — spawned directly, no shell, no quoting pitfalls.
      assert.strictEqual(handler.command, "/usr/local/bin/node");
      assert.deepStrictEqual(handler.args, [
        path.resolve(__dirname, "../hooks/minimax-hook.js").replace(/\\/g, "/"),
      ]);
      assert.ok(handler.args[0].includes(MARKER), `handler must reference the ${MARKER} marker`);
      assert.ok(Number.isInteger(handler.timeout) && handler.timeout >= 1 && handler.timeout <= 10,
        `timeout must be whole seconds within MiniMax's 1–10 clamp, got ${handler.timeout}`);
    }
    // PermissionRequest must never be registered (state-only Phase 1).
    assert.strictEqual(hooks.hooks.PermissionRequest, undefined);
    assert.strictEqual(hooks.hooks.Notification, undefined);
  });

  it("is idempotent on second run (skipped, bytes unchanged)", () => {
    const dataDir = makeTempDataDir();
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const hooksPath = path.join(dataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json");
    const before = fs.readFileSync(hooksPath, "utf8");

    const result = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, MINIMAX_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
  });

  it("refreshes the node path on an owned install (updated)", () => {
    const dataDir = makeTempDataDir();
    installMinimaxPlugin({ dataDir, nodeBin: "/old/node", silent: true });

    const result = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });

    assert.strictEqual(result.updated, MINIMAX_HOOK_EVENTS.length);
    const hooks = readJson(path.join(dataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json"));
    assert.strictEqual(hooks.hooks.Stop[0].hooks[0].command, "/usr/local/bin/node");
  });

  it("fails closed when a directory claims our manifest name but carries no ownership marker", () => {
    // A manifest name is not ownership. Without the structured marker, any
    // directory claiming our name could be silently overwritten or
    // recursively deleted.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: PLUGIN_DIR_NAME }),
      "utf8"
    );
    // Parseable hooks document but no minimax-hook.js reference anywhere.
    fs.writeFileSync(
      path.join(pluginRoot, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
      "utf8"
    );

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    const uninstalled = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(uninstalled.removed, 0, "uninstall must refuse without the marker");
    assert.ok(fs.existsSync(path.join(pluginRoot, "hooks", "hooks.json")), "directory must be untouched");
  });

  it("fails closed when the hooks document is corrupt in an owned-manifest directory", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: PLUGIN_DIR_NAME }),
      "utf8"
    );
    fs.writeFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "{corrupt", "utf8");

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    assert.strictEqual(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"), "{corrupt");
  });

  it("fails closed on an existing foreign directory and leaves its content untouched", () => {
    const dataDir = makeTempDataDir();
    const foreignRoot = path.join(dataDir, "plugins", "other-plugin");
    fs.mkdirSync(foreignRoot, { recursive: true });
    fs.writeFileSync(path.join(foreignRoot, "user.txt"), "keep me", "utf8");

    assert.throws(
      () => installMinimaxPlugin({ pluginRoot: foreignRoot, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    assert.strictEqual(fs.readFileSync(path.join(foreignRoot, "user.txt"), "utf8"), "keep me");
  });

  it("fails closed on a foreign MINIMAX-kind plugin (different manifest path)", () => {
    const dataDir = makeTempDataDir();
    const foreignRoot = path.join(dataDir, "plugins", "someone-else");
    fs.mkdirSync(path.join(foreignRoot, ".minimax-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(foreignRoot, ".minimax-plugin", "plugin.json"),
      JSON.stringify({ name: "someone-else" }),
      "utf8"
    );

    assert.throws(
      () => installMinimaxPlugin({ pluginRoot: foreignRoot, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    assert.ok(fs.existsSync(path.join(foreignRoot, ".minimax-plugin", "plugin.json")));
  });

  it("fails closed when the owned manifest is renamed to a foreign plugin name", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "not-clawd" }),
      "utf8"
    );

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
  });

  it("fails closed when the manifest file is unreadable", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "not json", "utf8");

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
  });

  it("skips install when the MiniMax data directory does not exist (not installed)", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-minimax-home-"));
    tempDirs.push(homeDir);
    const result = installMinimaxPlugin({ homeDir, nodeBin: "/usr/local/bin/node", silent: true });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(fs.existsSync(path.join(homeDir, ".minimax")), false);
  });

  it("honors MINIMAX_DATA_DIR over ~/.minimax", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-minimax-home2-"));
    const envDataDir = path.join(homeDir, "custom-data");
    fs.mkdirSync(envDataDir, { recursive: true });
    tempDirs.push(homeDir);

    const previous = process.env.MINIMAX_DATA_DIR;
    process.env.MINIMAX_DATA_DIR = envDataDir;
    try {
      assert.strictEqual(resolveMinimaxDataDir(homeDir), envDataDir);
      const result = installMinimaxPlugin({ nodeBin: "/usr/local/bin/node", silent: true });
      assert.strictEqual(result.added, MINIMAX_HOOK_EVENTS.length);
      assert.ok(fs.existsSync(path.join(envDataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json")));
    } finally {
      if (previous === undefined) delete process.env.MINIMAX_DATA_DIR;
      else process.env.MINIMAX_DATA_DIR = previous;
    }
  });

  it("falls back to MAVIS_DATA_DIR when MINIMAX_DATA_DIR is unset (upstream v0.5.1 precedence)", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-minimax-home3-"));
    const mavisDataDir = path.join(homeDir, "mavis-data");
    fs.mkdirSync(mavisDataDir, { recursive: true });
    tempDirs.push(homeDir);

    const previousMinimax = process.env.MINIMAX_DATA_DIR;
    const previousMavis = process.env.MAVIS_DATA_DIR;
    delete process.env.MINIMAX_DATA_DIR;
    process.env.MAVIS_DATA_DIR = mavisDataDir;
    try {
      assert.strictEqual(resolveMinimaxDataDir(homeDir), mavisDataDir);
      const result = installMinimaxPlugin({ nodeBin: "/usr/local/bin/node", silent: true });
      assert.strictEqual(result.added, MINIMAX_HOOK_EVENTS.length);
      assert.ok(fs.existsSync(path.join(mavisDataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json")));
    } finally {
      if (previousMinimax === undefined) delete process.env.MINIMAX_DATA_DIR;
      else process.env.MINIMAX_DATA_DIR = previousMinimax;
      if (previousMavis === undefined) delete process.env.MAVIS_DATA_DIR;
      else process.env.MAVIS_DATA_DIR = previousMavis;
    }
  });

  it("round-trips a custom data dir through install → unregister using the SAME resolution", () => {
    // Regression for the review finding: install honored MINIMAX_DATA_DIR but
    // the cleanup path hardcoded ~/.minimax, leaving the plugin behind. The
    // uninstaller must resolve through the identical helper.
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-minimax-home4-"));
    const envDataDir = path.join(homeDir, "envdata");
    fs.mkdirSync(envDataDir, { recursive: true });
    tempDirs.push(homeDir);

    const pluginRoot = path.join(envDataDir, "plugins", PLUGIN_DIR_NAME);
    let result = installMinimaxPlugin({
      homeDir,
      env: { MINIMAX_DATA_DIR: envDataDir },
      nodeBin: "/usr/local/bin/node",
      silent: true,
    });
    assert.strictEqual(result.added, MINIMAX_HOOK_EVENTS.length);
    assert.ok(fs.existsSync(pluginRoot));

    result = unregisterMinimaxPlugin({
      homeDir,
      env: { MINIMAX_DATA_DIR: envDataDir },
      silent: true,
    });
    assert.strictEqual(result.removed, MINIMAX_HOOK_EVENTS.length);
    assert.strictEqual(fs.existsSync(pluginRoot), false);
  });

  it("never overwrites or deletes a same-name foreign plugin (manifest claims clawd-state but no marker)", () => {
    const dataDir = makeTempDataDir();
    const foreignRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.join(foreignRoot, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(foreignRoot, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(foreignRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: PLUGIN_DIR_NAME, description: "someone else's plugin" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(foreignRoot, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo third-party" }] }] } }),
      "utf8"
    );
    const before = fs.readFileSync(path.join(foreignRoot, "hooks", "hooks.json"), "utf8");

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    const removed = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(removed.removed, 0);
    assert.strictEqual(fs.readFileSync(path.join(foreignRoot, "hooks", "hooks.json"), "utf8"), before);
  });

  it("unregister removes the owned plugin directory", () => {
    const dataDir = makeTempDataDir();
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });

    assert.strictEqual(result.removed, MINIMAX_HOOK_EVENTS.length);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.registrationRemoved, true);
    assert.strictEqual(fs.existsSync(pluginRoot), false);
    assert.deepStrictEqual(
      fs.readdirSync(dataDir).filter((name) => name.startsWith(REMOVAL_PREFIX) || name.startsWith(STAGING_PREFIX)),
      [],
      "the verified directory is moved aside and deleted without leftovers"
    );
  });

  it("unregister leaves foreign directories untouched", () => {
    const dataDir = makeTempDataDir();
    const foreignRoot = path.join(dataDir, "plugins", "other-plugin");
    fs.mkdirSync(foreignRoot, { recursive: true });
    fs.writeFileSync(path.join(foreignRoot, "user.txt"), "keep me", "utf8");

    const result = unregisterMinimaxPlugin({ pluginRoot: foreignRoot, silent: true });

    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(fs.readFileSync(path.join(foreignRoot, "user.txt"), "utf8"), "keep me");
  });

  it("unregister is a no-op when the plugin directory is absent", () => {
    const dataDir = makeTempDataDir();
    const result = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.registrationRemoved, true);
  });

  it("never adopts a same-name plugin that only mentions minimax-hook.js in an unrelated field", () => {
    // #1038 follow-up: the basename anywhere in the hooks JSON used to count
    // as ownership, which let Uninstall recursively delete a foreign plugin.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {
      name: PLUGIN_DIR_NAME,
      description: "unrelated plugin",
    });
    writeJsonFile(path.join(pluginRoot, "hooks", "hooks.json"), {
      note: "minimax-hook.js is an example filename",
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo third-party" }] }] },
    });
    const before = fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8");

    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: false, reason: "missing-marker" });
    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    const removed = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(removed.removed, 0);
    assert.strictEqual(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"), before);
  });

  function leftoverWorkDirs(parent) {
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent).filter((name) => name.startsWith(STAGING_PREFIX) || name.startsWith(REMOVAL_PREFIX));
  }

  it("a first install that fails at any step leaves nothing behind, and the retry succeeds", () => {
    // #1038 follow-up review F01: creating the root and then failing the first
    // write used to leave an empty, unprovable directory that blocked every
    // later install. First installs are now staged and published by rename.
    for (const failing of [OWNER_MARKER_FILE, "plugin.json", "hooks.json"]) {
      const dataDir = makeTempDataDir();
      const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
      const failOn = (filePath, data) => {
        if (path.basename(filePath) === failing) {
          const err = new Error("ENOSPC: no space left on device");
          err.code = "ENOSPC";
          throw err;
        }
        return writeJsonAtomic(filePath, data);
      };

      assert.throws(
        () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true, writeJsonAtomic: failOn }),
        /ENOSPC/,
        failing
      );
      assert.strictEqual(fs.existsSync(pluginRoot), false, `${failing}: no half-built plugin may be published`);
      assert.deepStrictEqual(leftoverWorkDirs(dataDir), [], `${failing}: staging must be cleaned up`);

      const retried = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
      assert.strictEqual(retried.added, MINIMAX_HOOK_EVENTS.length, failing);
      assert.deepStrictEqual(readOwnership(pluginRoot), { owned: true }, failing);
    }
  });

  it("an owned refresh interrupted between writes stays owned and the next install finishes it", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    const hooksPath = path.join(pluginRoot, "hooks", "hooks.json");
    installMinimaxPlugin({ dataDir, nodeBin: "/old/node", silent: true });
    const failHooks = (filePath, data) => {
      if (filePath === hooksPath) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return writeJsonAtomic(filePath, data);
    };

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true, writeJsonAtomic: failHooks }),
      /EACCES/
    );
    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: true });

    const repaired = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(repaired.updated, MINIMAX_HOOK_EVENTS.length);
    assert.strictEqual(readJson(hooksPath).hooks.Stop[0].hooks[0].command, "/usr/local/bin/node");
  });

  it("uninstall removes a half-written directory that holds only the ownership marker", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, OWNER_MARKER_FILE), buildOwnerMarker());

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });

    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.registrationRemoved, true);
    assert.strictEqual(fs.existsSync(pluginRoot), false);
    assert.deepStrictEqual(leftoverWorkDirs(dataDir), []);
  });

  it("refuses an unmarked pre-release install and reports it as still running Clawd's hook", () => {
    // #1038 follow-up review F05: a document fingerprint is not ownership, so
    // directories written before the marker existed are never adopted or
    // deleted. Uninstall reports them so Settings keeps the install intent.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writePreMarkerInstall(pluginRoot);
    writeJsonFile(path.join(pluginRoot, "notes.txt"), "user content");

    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: false, reason: "missing-marker" });
    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /missing-marker/
    );
    const result = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.registrationRemoved, false, "Settings must not commit uninstalled");
    assert.strictEqual(result.activeEntryRemaining, true);
    assert.deepStrictEqual(result.residualPaths, [pluginRoot]);
    assert.match(result.message, /Delete the directory manually/);
    assert.ok(fs.existsSync(path.join(pluginRoot, "notes.txt")), "nothing may be deleted");
  });

  it("reports a foreign directory that does not run Clawd's hook as nothing left registered", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME });
    writeJsonFile(path.join(pluginRoot, "hooks", "hooks.json"), {
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/usr/bin/node", args: ["/opt/vendor/audit.js"] }] }] },
    });

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });

    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.registrationRemoved, true);
    assert.strictEqual(result.residualPaths, undefined, "the directory is not Clawd's; it must not be reported as residue");
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes(pluginRoot), result.warnings[0]);
    assert.match(result.warnings[0], /Install will refuse/);
    assert.ok(fs.existsSync(path.join(pluginRoot, "hooks", "hooks.json")));
  });

  it("accepts only a well-formed, version-1 ownership marker for this integration", () => {
    const cases = [
      [{ app: "clawd-on-desk", integration: "pi", managed: true, version: 1 }, "foreign-owner-marker"],
      [{ app: "clawd-on-desk", integration: "minimax", managed: false, version: 1 }, "foreign-owner-marker"],
      [{ app: "clawd-on-desk", integration: "minimax", version: 1 }, "foreign-owner-marker"],
      [{ app: "clawd-on-desk", integration: "minimax", managed: "true", version: 1 }, "foreign-owner-marker"],
      [[], "foreign-owner-marker"],
      [{ app: "clawd-on-desk", integration: "minimax", managed: true, version: 99 }, "unsupported-owner-marker-version"],
      [{ app: "clawd-on-desk", integration: "minimax", managed: true }, "unsupported-owner-marker-version"],
    ];
    for (const [marker, reason] of cases) {
      const dataDir = makeTempDataDir();
      const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
      writePreMarkerInstall(pluginRoot);
      writeJsonFile(path.join(pluginRoot, OWNER_MARKER_FILE), marker);
      const label = JSON.stringify(marker);

      assert.deepStrictEqual(readOwnership(pluginRoot), { owned: false, reason }, label);
      assert.throws(() => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }), /not a Clawd plugin/, label);
      assert.strictEqual(unregisterMinimaxPlugin({ dataDir, silent: true }).removed, 0, label);
      assert.ok(fs.existsSync(path.join(pluginRoot, "hooks", "hooks.json")), label);
    }
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, OWNER_MARKER_FILE), "{not json", "utf8");
    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: false, reason: "unreadable-owner-marker" });
  });

  it("treats a symlinked plugin root as foreign and never writes or deletes through it", {
    skip: process.platform === "win32",
  }, () => {
    const dataDir = makeTempDataDir();
    const target = path.join(dataDir, "elsewhere", PLUGIN_DIR_NAME);
    installMinimaxPlugin({ pluginRoot: target, nodeBin: "/usr/local/bin/node", silent: true });
    const before = fs.readFileSync(path.join(target, "hooks", "hooks.json"), "utf8");
    const link = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, "dir");

    assert.deepStrictEqual(readOwnership(link), { owned: false, reason: "symlink-root" });
    assert.strictEqual(hooksReferenceClawdHook(link), null, "Clawd does not follow a linked root");
    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/other/node", silent: true }),
      /symlink-root/
    );
    const result = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.registrationRemoved, null);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "the link itself must survive");
    assert.strictEqual(fs.readFileSync(path.join(target, "hooks", "hooks.json"), "utf8"), before);
  });

  it("never trusts a symlinked ownership marker", { skip: process.platform === "win32" }, () => {
    // #1038 follow-up review F02: a linked marker could borrow a real Clawd
    // marker from elsewhere and get a foreign directory recursively deleted.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "foreign.txt"), "keep", "utf8");
    const borrowed = path.join(dataDir, "borrowed-marker.json");
    writeJsonFile(borrowed, buildOwnerMarker());
    fs.symlinkSync(borrowed, path.join(pluginRoot, OWNER_MARKER_FILE));

    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: false, reason: "symlinked-managed-path" });
    assert.strictEqual(unregisterMinimaxPlugin({ dataDir, silent: true }).removed, 0);
    assert.strictEqual(fs.readFileSync(path.join(pluginRoot, "foreign.txt"), "utf8"), "keep");
    assert.ok(fs.existsSync(borrowed));
  });

  it("never writes a Repair through a symlinked managed subdirectory", { skip: process.platform === "win32" }, () => {
    // #1038 follow-up review F03: a linked hooks/ (or .claude-plugin/) would
    // carry the rewrite to a file outside the plugin directory.
    for (const linked of ["hooks", ".claude-plugin"]) {
      const dataDir = makeTempDataDir();
      const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
      installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
      const outside = path.join(dataDir, "outside");
      fs.mkdirSync(outside);
      const outsideFile = path.join(outside, linked === "hooks" ? "hooks.json" : "plugin.json");
      writeJsonFile(outsideFile, { keep: "external" });
      fs.rmSync(path.join(pluginRoot, linked), { recursive: true });
      fs.symlinkSync(outside, path.join(pluginRoot, linked), "dir");

      assert.deepStrictEqual(readOwnership(pluginRoot), { owned: false, reason: "symlinked-managed-path" }, linked);
      assert.throws(
        () => installMinimaxPlugin({ dataDir, nodeBin: "/other/node", silent: true }),
        /symlinked-managed-path/,
        linked
      );
      assert.deepStrictEqual(readJson(outsideFile), { keep: "external" }, `${linked}: the outside file must be untouched`);
    }
  });

  it("keeps the recorded node binary when node detection fails", () => {
    const dataDir = makeTempDataDir();
    // A real node image: the fallback keeps the recorded path only after a
    // `--version` probe succeeds, so a fake executable would not qualify.
    const recordedNode = process.execPath;
    installMinimaxPlugin({ dataDir, nodeBin: recordedNode, silent: true });
    const hooksPath = path.join(dataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json");

    // nodeBin: null is what resolveNodeBin() returns when detection fails.
    const result = installMinimaxPlugin({ dataDir, nodeBin: null, silent: true });

    assert.strictEqual(result.skipped, MINIMAX_HOOK_EVENTS.length, "nothing to rewrite");
    for (const event of MINIMAX_HOOK_EVENTS) {
      assert.strictEqual(readJson(hooksPath).hooks[event][0].hooks[0].command, recordedNode, event);
    }
  });

  it("falls back to bare node only when the recorded node path no longer exists", () => {
    const dataDir = makeTempDataDir();
    installMinimaxPlugin({ dataDir, nodeBin: path.join(dataDir, "removed", "node"), silent: true });

    const result = installMinimaxPlugin({ dataDir, nodeBin: null, silent: true });

    assert.strictEqual(result.updated, MINIMAX_HOOK_EVENTS.length);
    const hooks = readJson(path.join(dataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json"));
    assert.strictEqual(hooks.hooks.Stop[0].hooks[0].command, "node");
  });

  it("never carries an edited or non-node command forward as the recorded node binary", () => {
    // #1038 follow-up review F06: one tampered handler used to be copied into
    // all ten. A recorded value must be the same Node binary everywhere.
    const dataDir = makeTempDataDir();
    const script = resolveHookScriptPath();
    const realNode = path.join(dataDir, "bin", "node");
    const echo = path.join(dataDir, "bin", "echo");
    for (const file of [realNode, echo]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "", { encoding: "utf8", mode: 0o755 });
    }
    // The first handler still names the real node, so only the "all handlers
    // agree" rule can reject this document.
    const mixed = buildDesiredHooksDocument(script, realNode);
    mixed.hooks.Stop[0].hooks[0] = { ...mixed.hooks.Stop[0].hooks[0], command: echo };
    const notNode = buildDesiredHooksDocument(script, echo);
    const foreignScript = buildDesiredHooksDocument("/opt/vendor/hooks/other.js", realNode);

    const acceptProbe = { probeNodeBin: () => true };
    assert.strictEqual(resolveDesiredNodeBin({ nodeBin: null, existingHooks: mixed, ...acceptProbe }), "node", "mixed commands");
    assert.strictEqual(resolveDesiredNodeBin({ nodeBin: null, existingHooks: notNode, ...acceptProbe }), "node", "not a node binary");
    assert.strictEqual(recordedNodeBin(foreignScript), null, "handlers that do not run our hook prove nothing");
    assert.strictEqual(resolveDesiredNodeBin({ nodeBin: null, existingHooks: buildDesiredHooksDocument(script, realNode), ...acceptProbe }), realNode);
    if (process.platform !== "win32") {
      fs.chmodSync(realNode, 0o644);
      assert.strictEqual(
        resolveDesiredNodeBin({ nodeBin: null, existingHooks: buildDesiredHooksDocument(script, realNode), ...acceptProbe }),
        "node",
        "a recorded path that is not executable is not kept"
      );
    }
  });

  it("keeps a recorded node path only when it actually runs as Node", () => {
    const dataDir = makeTempDataDir();
    const script = resolveHookScriptPath();
    const fakeNodeName = process.platform === "win32" ? "node.exe" : "node";
    const fakeNode = path.join(dataDir, "bin", fakeNodeName);
    fs.mkdirSync(path.dirname(fakeNode), { recursive: true });
    fs.writeFileSync(fakeNode, "", { encoding: "utf8", mode: 0o755 });

    // An empty executable named node exists and looks right, but ENOEXEC means
    // it would silently break every hook — so it must not be carried forward.
    assert.strictEqual(
      resolveDesiredNodeBin({ nodeBin: null, existingHooks: buildDesiredHooksDocument(script, fakeNode) }),
      "node",
      "a file that does not run as Node must not be recorded"
    );
    assert.strictEqual(
      resolveDesiredNodeBin({ nodeBin: null, existingHooks: buildDesiredHooksDocument(script, process.execPath) }),
      process.execPath,
      "a real node image is kept"
    );
  });

  it("treats a plugin root it cannot inspect as still present", (t) => {
    // #1038 round-3 R1-02: a permission error used to read as "not there", so
    // Uninstall reported success while the live plugin stayed on disk.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const realLstat = fs.lstatSync.bind(fs);
    t.mock.method(fs, "lstatSync", (target) => {
      if (target === pluginRoot) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return realLstat(target);
    });

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(result.registrationRemoved, null);
    assert.strictEqual(result.status, "error");
    assert.deepStrictEqual(result.residualPaths, [pluginRoot]);
    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /cannot inspect/
    );

    t.mock.restoreAll();
    assert.ok(fs.existsSync(path.join(pluginRoot, OWNER_MARKER_FILE)));
    assert.ok(fs.existsSync(path.join(pluginRoot, ".claude-plugin", "plugin.json")));
    assert.ok(fs.existsSync(path.join(pluginRoot, "hooks", "hooks.json")));
  });

  it("never treats a dangling symlink at the plugin root as absent", {
    skip: process.platform === "win32",
  }, () => {
    const dataDir = makeTempDataDir();
    const link = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(dataDir, "gone-away"), link, "dir");

    // existsSync reads a dangling link as absent; lstatState must not.
    assert.strictEqual(fs.existsSync(link), false);
    assert.deepStrictEqual(readOwnership(link), { owned: false, reason: "symlink-root" });
    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /symlink-root/
    );
    const result = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(result.removed, 0);
    // An existsSync-based root check would read a dangling link as absent and
    // wrongly report registrationRemoved:true.
    assert.strictEqual(result.registrationRemoved, null);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "the dangling link must survive");
  });

  it("stages a first install in the data directory, never inside plugins/", (t) => {
    for (const shape of ["dataDir", "pluginRoot"]) {
      const dataDir = makeTempDataDir();
      const realRename = fs.renameSync.bind(fs);
      const stagingParents = [];
      t.mock.method(fs, "renameSync", (from, to) => {
        if (path.basename(from).startsWith(STAGING_PREFIX)) stagingParents.push(path.dirname(from));
        return realRename(from, to);
      });
      try {
        const options = shape === "dataDir"
          ? { dataDir, nodeBin: "/usr/local/bin/node", silent: true }
          : { pluginRoot: path.join(dataDir, "plugins", PLUGIN_DIR_NAME), nodeBin: "/usr/local/bin/node", silent: true };
        const result = installMinimaxPlugin(options);
        assert.strictEqual(result.added, MINIMAX_HOOK_EVENTS.length, shape);
      } finally {
        t.mock.restoreAll();
      }
      assert.ok(stagingParents.length >= 1, shape);
      for (const parent of stagingParents) assert.strictEqual(parent, dataDir, shape);
    }
  });

  it("moves an uninstalled plugin out of plugins/ before deleting it", (t) => {
    for (const shape of ["dataDir", "pluginRoot"]) {
      const dataDir = makeTempDataDir();
      const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
      installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
      const realRename = fs.renameSync.bind(fs);
      const removalTargets = [];
      t.mock.method(fs, "renameSync", (from, to) => {
        if (path.basename(to).startsWith(REMOVAL_PREFIX)) removalTargets.push(to);
        return realRename(from, to);
      });
      let result;
      try {
        const options = shape === "dataDir" ? { dataDir, silent: true } : { pluginRoot, silent: true };
        result = unregisterMinimaxPlugin(options);
      } finally {
        t.mock.restoreAll();
      }
      assert.strictEqual(result.registrationRemoved, true, shape);
      assert.ok(removalTargets.length >= 1, shape);
      for (const target of removalTargets) assert.strictEqual(path.dirname(target), dataDir, shape);
    }
  });

  it("publishes a first install with one rename of a complete directory", (t) => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    const required = [OWNER_MARKER_FILE, path.join(".claude-plugin", "plugin.json"), path.join("hooks", "hooks.json")];
    const realRename = fs.renameSync.bind(fs);
    const publishRenames = [];
    t.mock.method(fs, "renameSync", (from, to) => {
      if (to === pluginRoot) {
        publishRenames.push({
          from,
          complete: required.every((rel) => fs.existsSync(path.join(from, rel))),
          rootBefore: fs.existsSync(pluginRoot),
        });
      }
      return realRename(from, to);
    });

    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });

    assert.strictEqual(publishRenames.length, 1, "the plugin is published with exactly one rename");
    assert.strictEqual(publishRenames[0].complete, true, "every file must exist in staging before publish");
    assert.strictEqual(publishRenames[0].rootBefore, false);
  });

  it("puts a moved directory back when it is no longer provably Clawd's", (t) => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const realRename = fs.renameSync.bind(fs);
    t.mock.method(fs, "renameSync", (from, to) => {
      realRename(from, to);
      if (path.basename(to).startsWith(REMOVAL_PREFIX)) {
        fs.writeFileSync(path.join(to, OWNER_MARKER_FILE), "{tampered", "utf8");
      }
    });

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });

    assert.strictEqual(result.registrationRemoved, false);
    assert.deepStrictEqual(result.residualPaths, [pluginRoot]);
    assert.ok(fs.existsSync(path.join(pluginRoot, "hooks", "hooks.json")));
    assert.deepStrictEqual(leftoverWorkDirs(dataDir), [], "the move must have been undone");
  });

  it("reports both locations when a moved directory can be neither verified nor put back", (t) => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const realRename = fs.renameSync.bind(fs);
    let removalPath = null;
    t.mock.method(fs, "renameSync", (from, to) => {
      realRename(from, to);
      if (path.basename(to).startsWith(REMOVAL_PREFIX)) {
        removalPath = to;
        fs.writeFileSync(path.join(to, OWNER_MARKER_FILE), "{tampered", "utf8");
        // Another instance publishes a fresh Clawd plugin at the original path,
        // so the move-back rename fails against a non-empty directory.
        fs.mkdirSync(path.join(pluginRoot, "hooks"), { recursive: true });
        fs.writeFileSync(
          path.join(pluginRoot, "hooks", "hooks.json"),
          JSON.stringify(buildDesiredHooksDocument(resolveHookScriptPath(), "/x/node")),
          "utf8"
        );
      }
    });

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });

    assert.strictEqual(result.registrationRemoved, null);
    assert.strictEqual(result.residualPaths.length, 2);
    assert.ok(result.residualPaths.includes(removalPath));
    assert.ok(result.residualPaths.includes(pluginRoot));
    assert.ok(fs.existsSync(removalPath));
    assert.ok(fs.existsSync(pluginRoot));
    assert.ok(result.message.includes(removalPath) && result.message.includes(pluginRoot), result.message);
  });

  it("treats an empty clawd-state directory as unclaimed", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(pluginRoot, { recursive: true });

    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: false, reason: "empty-directory" });
    const result = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(result.added, MINIMAX_HOOK_EVENTS.length);
    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: true });

    const otherDataDir = makeTempDataDir();
    fs.mkdirSync(path.join(otherDataDir, "plugins", PLUGIN_DIR_NAME), { recursive: true });
    const uninstalled = unregisterMinimaxPlugin({ dataDir: otherDataDir, silent: true });
    assert.strictEqual(uninstalled.registrationRemoved, true);
    assert.strictEqual(uninstalled.warnings, undefined);
  });

  it("never replaces a directory that gains content after the install check", () => {
    // #1038 round-3 R1-05: POSIX rename replaces an EMPTY target, so the check
    // and the publish must not be able to clobber a real directory.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    const writeHookSeam = (filePath, data) => {
      if (filePath.includes(STAGING_PREFIX) && path.basename(filePath) === "hooks.json") {
        fs.mkdirSync(pluginRoot, { recursive: true });
        fs.writeFileSync(path.join(pluginRoot, "user.txt"), "keep me", "utf8");
      }
      return writeJsonAtomic(filePath, data);
    };

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true, writeJsonAtomic: writeHookSeam }),
      // POSIX rename → ENOTEMPTY/EEXIST/ENOTDIR; Windows rename → EPERM/EACCES.
      /ENOTEMPTY|EEXIST|ENOTDIR|EPERM|EACCES|directory not empty/
    );
    assert.strictEqual(fs.readFileSync(path.join(pluginRoot, "user.txt"), "utf8"), "keep me");
    assert.deepStrictEqual(leftoverWorkDirs(dataDir), []);
  });

  it("replaces an empty directory that appears after the install check", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    const writeHookSeam = (filePath, data) => {
      if (filePath.includes(STAGING_PREFIX) && path.basename(filePath) === "hooks.json") {
        fs.mkdirSync(pluginRoot, { recursive: true });
      }
      return writeJsonAtomic(filePath, data);
    };

    const result = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true, writeJsonAtomic: writeHookSeam });
    assert.strictEqual(result.added, MINIMAX_HOOK_EVENTS.length);
    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: true });
  });

  it("finds a Clawd hook in the hooks document the manifest declares", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: "hooks/other.json" });
    writeJsonFile(
      path.join(pluginRoot, "hooks", "other.json"),
      buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node")
    );

    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
    const result = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(result.registrationRemoved, false);
    assert.strictEqual(result.activeEntryRemaining, true);
    assert.deepStrictEqual(result.residualPaths, [pluginRoot]);
    assert.ok(fs.existsSync(path.join(pluginRoot, "hooks", "other.json")));
  });

  it("finds a Clawd hook in an array-declared hooks document", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: [{ path: "./hooks/b.json" }] });
    writeJsonFile(
      path.join(pluginRoot, "hooks", "b.json"),
      buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node")
    );
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
  });

  it("finds a Clawd hook in an inlined manifest hooks document", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {
      name: PLUGIN_DIR_NAME,
      hooks: buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node"),
    });
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
  });

  it("finds a Clawd handler registered on any event, not just SessionStart", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME });
    const handler = { type: "command", command: "/usr/local/bin/node", args: [resolveHookScriptPath()] };
    writeJsonFile(path.join(pluginRoot, "hooks", "hooks.json"), { hooks: { PostCompact: [{ hooks: [handler] }] } });
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
  });

  it("reports an unmodellable manifest hooks value as unknown, not absent", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: 42 });
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), null);
  });

  it("never follows a manifest hook path outside the plugin directory", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: "../outside.json" });
    writeJsonFile(
      path.join(dataDir, "plugins", "outside.json"),
      buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node")
    );
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), null);
  });

  it("reports an unmodellable manifest format as unknown when no Clawd hook is found", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".minimax-plugin", "plugin.json"), { name: "someone-else" });
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), null);
  });

  it("reports a corrupt hooks document as unknown so Uninstall cannot claim success", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: ["hooks/hooks.json"] });
    fs.mkdirSync(path.join(pluginRoot, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "{corrupt", "utf8");

    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), null);
    assert.strictEqual(unregisterMinimaxPlugin({ dataDir, silent: true }).registrationRemoved, null);
  });

  it("reports a declared hooks document that does not exist as absent", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: "hooks/gone.json" });
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), false);
  });

  it("finds a Clawd hook in a bare (unwrapped) hooks document", () => {
    // MiniMax's readHooksEnvelope uses a plain-object `hooks` field as the
    // events map and otherwise treats the whole document as that map, so a bare
    // document runs too and must not read as absent.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME });
    const bare = buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node").hooks;
    writeJsonFile(path.join(pluginRoot, "hooks", "hooks.json"), bare);

    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
    assert.strictEqual(unregisterMinimaxPlugin({ dataDir, silent: true }).registrationRemoved, false);
  });

  it("trims a declared hooks path before resolving it", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: "  hooks/other.json  " });
    writeJsonFile(
      path.join(pluginRoot, "hooks", "other.json"),
      buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node")
    );
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
  });

  it("still counts Clawd's own hooks/hooks.json when the manifest declares another document", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: "hooks/other.json" });
    writeJsonFile(path.join(pluginRoot, "hooks", "other.json"), {
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/usr/bin/node", args: ["/opt/vendor/audit.js"] }] }] },
    });
    writeJsonFile(
      path.join(pluginRoot, "hooks", "hooks.json"),
      buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node")
    );
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
  });

  it("treats a symlinked hooks document as unconfirmable", { skip: process.platform === "win32" }, () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: "hooks/hooks.json" });
    const outside = path.join(dataDir, "outside-hooks");
    writeJsonFile(path.join(outside, "hooks.json"), {
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/usr/bin/node", args: ["/opt/vendor/audit.js"] }] }] },
    });
    fs.symlinkSync(outside, path.join(pluginRoot, "hooks"), "dir");

    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), null);
  });

  it("treats a plugin root under a non-directory parent as absent", () => {
    const dataDir = makeTempDataDir();
    fs.writeFileSync(path.join(dataDir, "plugins"), "not a directory", "utf8");
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);

    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: false, reason: "missing" });
    const result = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(result.registrationRemoved, true);
    assert.strictEqual(result.status, undefined);
  });

  it("reads a manifest hook path written with backslashes the way MiniMax does", () => {
    // MiniMax splits declared paths on both separators, so hooks\other.json is
    // hooks/other.json on every platform.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: "hooks\\other.json" });
    writeJsonFile(
      path.join(pluginRoot, "hooks", "other.json"),
      buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node")
    );
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
    assert.strictEqual(unregisterMinimaxPlugin({ dataDir, silent: true }).registrationRemoved, false);
  });

  it("counts a shell-form command handler that references Clawd's hook", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME });
    writeJsonFile(path.join(pluginRoot, "hooks", "hooks.json"), {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "\"/usr/local/bin/node\" \"/opt/clawd/hooks/minimax-hook.js\"" }] }] },
    });
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
    assert.strictEqual(unregisterMinimaxPlugin({ dataDir, silent: true }).registrationRemoved, false);
  });

  it("counts a handler whose commandWindows references Clawd's hook", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME });
    writeJsonFile(path.join(pluginRoot, "hooks", "hooks.json"), {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", commandWindows: "node \"C:\\clawd\\hooks\\minimax-hook.js\"" }] }] },
    });
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
  });

  it("counts a handler that references Clawd's hook outside args[0]", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME });
    writeJsonFile(path.join(pluginRoot, "hooks", "hooks.json"), {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/usr/bin/env", args: ["node", "/opt/clawd/hooks/minimax-hook.js"] }] }] },
    });
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
  });

  it("finds a Clawd handler declared in the second of two array documents", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: ["hooks/a.json", "hooks/b.json"] });
    writeJsonFile(path.join(pluginRoot, "hooks", "a.json"), {
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/usr/bin/node", args: ["/opt/vendor/audit.js"] }] }] },
    });
    writeJsonFile(
      path.join(pluginRoot, "hooks", "b.json"),
      buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node")
    );
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
  });

  it("finds a Clawd handler when the declared { path } has surrounding whitespace", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, hooks: { path: "  hooks/other.json  " } });
    writeJsonFile(
      path.join(pluginRoot, "hooks", "other.json"),
      buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node")
    );
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
  });

  it("reports a plugin reinstalled at the same path during uninstall", (t) => {
    // #R2-03: instance A removes the old plugin; instance B publishes a fresh
    // one at the same path before A returns. A must not claim uninstalled.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const realRename = fs.renameSync.bind(fs);
    let triggered = false;
    t.mock.method(fs, "renameSync", (from, to) => {
      realRename(from, to);
      if (!triggered && path.basename(to).startsWith(REMOVAL_PREFIX)) {
        triggered = true;
        installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
      }
    });

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });

    assert.strictEqual(result.registrationRemoved, false);
    assert.strictEqual(result.activeEntryRemaining, true);
    assert.ok(result.residualPaths.includes(pluginRoot));
    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: true });
    assert.deepStrictEqual(leftoverWorkDirs(dataDir), []);
  });

  it("stays removed when only a foreign non-Clawd directory reappears during uninstall", (t) => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const realRename = fs.renameSync.bind(fs);
    let triggered = false;
    t.mock.method(fs, "renameSync", (from, to) => {
      realRename(from, to);
      if (!triggered && path.basename(to).startsWith(REMOVAL_PREFIX)) {
        triggered = true;
        fs.mkdirSync(pluginRoot, { recursive: true });
        fs.writeFileSync(path.join(pluginRoot, "user.txt"), "keep", "utf8");
      }
    });

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });

    assert.strictEqual(result.registrationRemoved, true);
    assert.ok(result.warnings.some((warning) => warning.includes(pluginRoot)), JSON.stringify(result.warnings));
    assert.strictEqual(result.residualPaths, undefined, "a foreign directory is not Clawd's residue");
    assert.ok(fs.existsSync(path.join(pluginRoot, "user.txt")));
  });

  it("stays removed when only an empty directory reappears during uninstall", (t) => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const realRename = fs.renameSync.bind(fs);
    let triggered = false;
    t.mock.method(fs, "renameSync", (from, to) => {
      realRename(from, to);
      if (!triggered && path.basename(to).startsWith(REMOVAL_PREFIX)) {
        triggered = true;
        fs.mkdirSync(pluginRoot, { recursive: true });
      }
    });

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });

    assert.strictEqual(result.registrationRemoved, true);
    assert.strictEqual(result.warnings, undefined);
    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: false, reason: "empty-directory" });
  });

  it("reports a reinstall and the undeletable leftover together when both happen", (t) => {
    // The delete of the moved directory fails AND another instance publishes a
    // fresh plugin before the final re-check: the new plugin keeps the
    // registration, and the leftover is still reported.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const realRename = fs.renameSync.bind(fs);
    const realRm = fs.rmSync.bind(fs);
    let removalPath = null;
    t.mock.method(fs, "renameSync", (from, to) => {
      realRename(from, to);
      if (!removalPath && path.basename(to).startsWith(REMOVAL_PREFIX)) {
        removalPath = to;
        installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
      }
    });
    t.mock.method(fs, "rmSync", (target, rmOptions) => {
      if (path.basename(String(target)).startsWith(REMOVAL_PREFIX)) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return realRm(target, rmOptions);
    });

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });
    t.mock.restoreAll();

    assert.strictEqual(result.registrationRemoved, false);
    assert.strictEqual(result.activeEntryRemaining, true);
    assert.ok(result.residualPaths.includes(pluginRoot), JSON.stringify(result.residualPaths));
    assert.ok(result.residualPaths.includes(removalPath), JSON.stringify(result.residualPaths));
    assert.ok(result.warnings.some((warning) => warning.includes(removalPath)), JSON.stringify(result.warnings));
    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: true });
  });

  it("reports an uninstall as unconfirmed when the final re-check cannot inspect the root", (t) => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const realLstat = fs.lstatSync.bind(fs);
    const realRm = fs.rmSync.bind(fs);
    let removed = false;
    t.mock.method(fs, "rmSync", (target, rmOptions) => {
      const out = realRm(target, rmOptions);
      if (path.basename(String(target)).startsWith(REMOVAL_PREFIX)) removed = true;
      return out;
    });
    // Only after the old directory is gone: the re-check of the original
    // location hits a permission error instead of a clean "missing".
    t.mock.method(fs, "lstatSync", (target, ...rest) => {
      if (removed && target === pluginRoot) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return realLstat(target, ...rest);
    });

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });
    t.mock.restoreAll();

    assert.ok(removed, "the old directory was deleted before the re-check");
    assert.strictEqual(result.registrationRemoved, null);
    assert.ok(result.residualPaths.includes(pluginRoot), JSON.stringify(result.residualPaths));
  });

  it("matches Clawd's hook script name regardless of case", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME });
    writeJsonFile(path.join(pluginRoot, "hooks", "hooks.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "node /Opt/Clawd/Hooks/MiniMax-Hook.JS" }] }] },
    });
    assert.strictEqual(hooksReferenceClawdHook(pluginRoot), true);
  });

  it("registers exactly the 10 state events and never PermissionRequest", () => {
    assert.deepStrictEqual([...MINIMAX_HOOK_EVENTS].sort(), [
      "PostCompact",
      "PostToolUse",
      "PreCompact",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "SubagentStart",
      "SubagentStop",
      "UserPromptSubmit",
    ]);
    assert.ok(!MINIMAX_HOOK_EVENTS.includes("PermissionRequest"));
    assert.ok(!MINIMAX_HOOK_EVENTS.includes("Notification"));
  });
});
