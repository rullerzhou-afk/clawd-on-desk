"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const grok = require("../hooks/grok-install");
const {
  registerGrokHooks,
  unregisterGrokHooks,
  inspectGrokHookFile,
  resolveGrokConfigPath,
  resolveGrokHome,
  desiredHookCommand,
  GROK_HOOK_EVENTS,
  MANAGED_MARKER_KEY,
  MANAGED_MARKER_VALUE,
  CONFIG_FILE_NAME,
  PREVIEW_CONFIG_FILE_NAME,
} = grok;
const { detectAgentInstallation } = require("../src/agent-installation-detector");
const { getAgentDescriptor } = require("../src/doctor-detectors/agent-descriptors");
const { checkAgent } = require("../src/doctor-detectors/agent-integrations");
const { installAgentIntegration } = require("../src/settings-actions-agents");
const { buildCleanupOptionsForHome, cleanupIntegrations } = require("../hooks/cleanup-integrations");
const { DEFAULT_BACKUP_KEEP } = require("../hooks/json-utils");

const NODE_BIN = process.platform === "win32" ? "C:/nodejs/node.exe" : "/usr/local/bin/node";
// Platform-valid, genuinely distinct Node paths. The Windows portable writer
// normalizes any non-Windows absolute path to bare `node`, so a POSIX-looking
// fixture cannot represent a node-path upgrade on Windows.
const OLD_NODE_BIN = process.platform === "win32" ? "C:/node-old/node.exe" : "/old/node";
const NEW_NODE_BIN = process.platform === "win32" ? "C:/node-new/node.exe" : "/new/node";
function upgradeNodeBin(index) {
  return process.platform === "win32" ? `C:/node-${index}/node.exe` : `/node/${index}`;
}
const tempDirs = [];

function makeTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-grok-home-"));
  tempDirs.push(homeDir);
  return homeDir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readRaw(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function grokDir(homeDir, name = ".grok") {
  fs.mkdirSync(path.join(homeDir, name), { recursive: true });
}

function managedHandler(overrides = {}) {
  return {
    type: "command",
    command: "node /opt/clawd/hooks/grok-hook.js",
    timeout: 5,
    env: { [MANAGED_MARKER_KEY]: MANAGED_MARKER_VALUE },
    ...overrides,
  };
}

function listBackups(configPath) {
  const dir = path.dirname(configPath);
  const prefix = `${path.basename(configPath)}.clawd-cleanup-`;
  return fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".bak"));
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("Grok hook installer ownership", () => {
  it("exposes Grok's timeout in seconds via an exact per-event table", () => {
    assert.strictEqual(grok.DEFAULT_EVENT_TIMEOUT_SECONDS, 5);
    assert.strictEqual(grok.DEFAULT_EVENT_TIMEOUT_MS, undefined);
    assert.deepStrictEqual(
      Object.keys(grok.GROK_EVENT_TIMEOUT_SECONDS).sort(),
      [...GROK_HOOK_EVENTS].sort()
    );
    for (const event of GROK_HOOK_EVENTS) {
      assert.strictEqual(
        grok.grokEventTimeoutSeconds(event),
        event === "SessionEnd" ? null : 5,
        event
      );
    }
    // Unknown events must not silently inherit the default.
    assert.strictEqual(grok.grokEventTimeoutSeconds("UnknownEvent"), grok.UNSUPPORTED_EVENT_TIMEOUT);
    assert.notStrictEqual(grok.grokEventTimeoutSeconds("UnknownEvent"), 5);
    assert.notStrictEqual(grok.grokEventTimeoutSeconds("UnknownEvent"), null);
  });

  it("skips registration when the Grok home is missing", () => {
    const homeDir = makeTempHome();
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    assert.strictEqual(result.status, "skipped");
    assert.strictEqual(result.added, 0);
    assert.strictEqual(fs.existsSync(resolveGrokConfigPath({ homeDir })), false);
  });

  it("creates the canonical clawd-on-desk.json schema with exact owned handlers", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    assert.strictEqual(result.added, GROK_HOOK_EVENTS.length);
    const configPath = resolveGrokConfigPath({ homeDir });
    assert.strictEqual(path.basename(configPath), CONFIG_FILE_NAME);
    const doc = readJson(configPath);
    assert.deepStrictEqual(Object.keys(doc), ["hooks"]);
    for (const event of GROK_HOOK_EVENTS) {
      const entries = doc.hooks[event];
      assert.strictEqual(entries.length, 1, event);
      assert.strictEqual(entries[0].matcher, "");
      const handler = entries[0].hooks[0];
      assert.strictEqual(handler.type, "command");
      assert.ok(handler.command.includes("grok-hook.js"));
      assert.deepStrictEqual(handler.env, { [MANAGED_MARKER_KEY]: MANAGED_MARKER_VALUE });
      if (event === "SessionEnd") assert.strictEqual(handler.timeout, undefined);
      else assert.strictEqual(handler.timeout, 5, event);
    }
  });

  it("is a no-op on repeated install", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const before = readRaw(resolveGrokConfigPath({ homeDir }));
    const second = registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.skipped, GROK_HOOK_EVENTS.length);
    assert.strictEqual(readRaw(resolveGrokConfigPath({ homeDir })), before);
  });

  it("is a byte-for-byte no-op on repeated install with an explicit Windows nodeBin", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    const options = { homeDir, silent: true, nodeBin: "C:/nodejs/node.exe", platform: "win32" };
    registerGrokHooks(options);
    const configPath = resolveGrokConfigPath({ homeDir });
    const before = readRaw(configPath);
    const second = registerGrokHooks(options);
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.skipped, GROK_HOOK_EVENTS.length);
    assert.strictEqual(readRaw(configPath), before);
    assert.strictEqual(inspectGrokHookFile({ homeDir }).health, "healthy");
  });

  it("creates a recoverable backup with the original bytes on node-path upgrade", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: OLD_NODE_BIN });
    const configPath = resolveGrokConfigPath({ homeDir });
    const before = readRaw(configPath);
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: NEW_NODE_BIN });
    assert.strictEqual(result.updated, GROK_HOOK_EVENTS.length);
    assert.ok(result.backupPath, "upgrade must return a backup path");
    assert.strictEqual(fs.readFileSync(result.backupPath, "utf8"), before);
    const doc = readJson(configPath);
    for (const event of GROK_HOOK_EVENTS) {
      assert.ok(doc.hooks[event][0].hooks[0].command.includes(NEW_NODE_BIN), event);
    }
  });

  it("keeps a bounded number of backups across repeated upgrades", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    for (let index = 0; index < 8; index += 1) {
      registerGrokHooks({ homeDir, silent: true, nodeBin: upgradeNodeBin(index) });
    }
    const configPath = resolveGrokConfigPath({ homeDir });
    const backups = listBackups(configPath);
    assert.ok(backups.length > 0, "upgrades must have produced backups");
    assert.ok(backups.length <= DEFAULT_BACKUP_KEEP, `expected <= ${DEFAULT_BACKUP_KEEP}, got ${backups.length}`);
  });

  it("preserves an existing 0600 mode across an upgrade (backup stays 0600)", { skip: process.platform === "win32" }, () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: OLD_NODE_BIN });
    const configPath = resolveGrokConfigPath({ homeDir });
    fs.chmodSync(configPath, 0o600);
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: NEW_NODE_BIN });
    assert.strictEqual(result.updated, GROK_HOOK_EVENTS.length);
    assert.strictEqual(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.ok(result.backupPath);
    assert.strictEqual(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  });

  it("preserves an existing 0600 mode on a non-deleting uninstall", { skip: process.platform === "win32" }, () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      env: { TOKEN: "secret" },
      hooks: { Stop: [{ matcher: "", hooks: [managedHandler()] }] },
    });
    fs.chmodSync(configPath, 0o600);
    const result = unregisterGrokHooks({ homeDir, silent: true });
    assert.strictEqual(result.deletedFile, false);
    assert.strictEqual(fs.existsSync(configPath), true);
    assert.strictEqual(fs.statSync(configPath).mode & 0o777, 0o600);
  });

  it("keeps the original mode on the surviving file when the delete step fails", { skip: process.platform === "win32" }, () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const configPath = resolveGrokConfigPath({ homeDir });
    fs.chmodSync(configPath, 0o600);
    const failingFs = Object.create(fs);
    failingFs.unlinkSync = () => {
      const err = new Error("permission denied");
      err.code = "EACCES";
      throw err;
    };
    assert.throws(() => unregisterGrokHooks({ homeDir, silent: true, fs: failingFs }));
    assert.strictEqual(fs.existsSync(configPath), true);
    assert.strictEqual(fs.statSync(configPath).mode & 0o777, 0o600);
    const doc = readJson(configPath);
    assert.strictEqual(Object.keys(doc.hooks || {}).length, 0);
  });

  it("rejects a same-named foreign file byte-for-byte without a structured marker", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      env: { KEEP: "yes" },
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "python3 /tmp/user-audit.py" }] }],
      },
    });
    const before = readRaw(configPath);
    assert.throws(
      () => registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN }),
      /foreign|marker/i
    );
    assert.strictEqual(readRaw(configPath), before);
  });

  it("never owns a filename lookalike", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "node my-grok-hook.js.backup" }] }],
      },
    });
    const before = readRaw(configPath);
    assert.throws(() => registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN }));
    assert.strictEqual(readRaw(configPath), before);
    const inspected = inspectGrokHookFile({ homeDir });
    assert.strictEqual(inspected.health, "foreign-file");
    assert.strictEqual(inspected.managed, false);
  });

  it("fails closed on malformed JSON, top-level array, and non-object hooks", () => {
    const cases = {
      malformed: "{ not json",
      array: JSON.stringify([1, 2, 3]),
      "hooks-non-object": JSON.stringify({ hooks: [] }),
    };
    for (const [label, raw] of Object.entries(cases)) {
      const homeDir = makeTempHome();
      const configPath = resolveGrokConfigPath({ homeDir });
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, raw, "utf8");
      assert.throws(() => registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN }), undefined, label);
      assert.strictEqual(readRaw(configPath), raw, label);
    }
  });

  it("fails closed on malformed matcher/RawHandler shapes byte-for-byte", () => {
    const markerEntry = managedHandler();
    const validForeign = { type: "command", command: "python3 /tmp/other.py" };
    const withForeign = (stop) => ({
      hooks: { WorktreeCreate: [{ matcher: "", hooks: [validForeign] }], Stop: stop },
    });
    const noType = managedHandler();
    delete noType.type;
    const cases = {
      "matcher-not-string": withForeign([{ matcher: { bad: true }, hooks: [] }]),
      "matcher-numeric": withForeign([{ matcher: 7, hooks: [markerEntry] }]),
      "event-not-array": withForeign({}),
      "group-not-object": withForeign(["nope"]),
      "group-hooks-missing": withForeign([{ matcher: "" }]),
      "group-hooks-null": withForeign([{ matcher: "", hooks: null }]),
      "group-hooks-string": withForeign([{ matcher: "", hooks: "nope" }]),
      "handler-not-object": withForeign([{ matcher: "", hooks: ["nope"] }]),
      "handler-type-missing": withForeign([{ matcher: "", hooks: [noType] }]),
      "handler-type-not-string": withForeign([{ matcher: "", hooks: [managedHandler({ type: 123 })] }]),
      "handler-type-unsupported": withForeign([{ matcher: "", hooks: [managedHandler({ type: "url" })] }]),
      "handler-command-not-string": withForeign([{ matcher: "", hooks: [managedHandler({ command: {} })] }]),
      "handler-timeout-string": withForeign([{ matcher: "", hooks: [managedHandler({ timeout: "5" })] }]),
      "handler-timeout-negative": withForeign([{ matcher: "", hooks: [managedHandler({ timeout: -1 })] }]),
      "handler-timeout-fractional": withForeign([{ matcher: "", hooks: [managedHandler({ timeout: 5.5 })] }]),
      "handler-timeout-unsafe": withForeign([{ matcher: "", hooks: [managedHandler({ timeout: 2 ** 53 })] }]),
      "handler-timeout-null": withForeign([{ matcher: "", hooks: [managedHandler({ timeout: null })] }]),
      "handler-env-not-object": withForeign([{ matcher: "", hooks: [managedHandler({ env: "x" })] }]),
      "handler-env-numeric-value": withForeign([{ matcher: "", hooks: [managedHandler({ env: { [MANAGED_MARKER_KEY]: "v1", NUM: 1 } })] }]),
      // A flat marker-bearing RawHandler is not a valid MatcherGroup.
      "flat-marker-handler": withForeign([markerEntry]),
    };
    for (const [label, doc] of Object.entries(cases)) {
      const homeDir = makeTempHome();
      const configPath = resolveGrokConfigPath({ homeDir });
      writeJson(configPath, doc);
      const before = readRaw(configPath);
      assert.throws(() => registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN }), undefined, label);
      assert.strictEqual(readRaw(configPath), before, label);
      // The inspector must not report a file Grok would reject as healthy.
      assert.notStrictEqual(inspectGrokHookFile({ homeDir }).health, "healthy", label);
    }
  });

  it("leaves a flat-marker-only file untouched and reports it non-healthy", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, { hooks: { Stop: [managedHandler()] } });
    const before = readRaw(configPath);
    assert.throws(() => registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN }));
    assert.strictEqual(readRaw(configPath), before);
    assert.notStrictEqual(inspectGrokHookFile({ homeDir }).health, "healthy");
  });

  it("accepts the upstream-valid null matcher/env on foreign handlers", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const configPath = resolveGrokConfigPath({ homeDir });
    const doc = readJson(configPath);
    doc.hooks.Stop.push({
      matcher: null,
      hooks: [{ type: "command", command: "python3 /tmp/foreign.py", env: null }],
    });
    writeJson(configPath, doc);
    assert.strictEqual(inspectGrokHookFile({ homeDir }).health, "healthy");
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const after = readJson(configPath);
    assert.ok(after.hooks.Stop.some(
      (group) => group.matcher === null && group.hooks.some((handler) => handler.env === null)
    ), "null matcher/env foreign group must be preserved");
  });

  it("preserves unknown top-level keys, foreign events, and sibling handlers", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      env: { KEEP: "yes" },
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              managedHandler(),
              { type: "command", command: "python3 /tmp/user-audit.py" },
            ],
          },
        ],
        WorktreeCreate: [{ matcher: "", hooks: [{ type: "command", command: "python3 /tmp/other.py" }] }],
      },
    });
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    assert.ok(result.added > 0);
    const doc = readJson(configPath);
    assert.strictEqual(doc.env.KEEP, "yes");
    const stopCommands = doc.hooks.Stop.flatMap((group) => group.hooks.map((h) => h.command));
    assert.ok(stopCommands.some((command) => command.includes("user-audit.py")));
    assert.strictEqual(doc.hooks.WorktreeCreate[0].hooks[0].command, "python3 /tmp/other.py");
  });

  it("moves a managed handler out of a non-empty matcher without touching foreign siblings", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      hooks: {
        Stop: [
          {
            matcher: "Bash",
            hooks: [
              managedHandler(),
              { type: "command", command: "python3 /tmp/foreign.py" },
            ],
          },
        ],
      },
    });
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    assert.ok(result.added > 0 || result.updated > 0);
    const doc = readJson(configPath);
    const foreignGroup = doc.hooks.Stop.find((group) => group.matcher === "Bash");
    assert.ok(foreignGroup, "foreign matcher group must survive");
    assert.deepStrictEqual(
      foreignGroup.hooks.map((h) => h.command),
      ["python3 /tmp/foreign.py"]
    );
    const ownedGroups = doc.hooks.Stop.filter((group) => (group.hooks || []).some((h) => h.env && h.env[MANAGED_MARKER_KEY]));
    assert.strictEqual(ownedGroups.length, 1);
    assert.strictEqual(ownedGroups[0].matcher, "");
    assert.strictEqual(inspectGrokHookFile({ homeDir }).health, "healthy");
  });

  it("repairs a marker-owned noncanonical command on registration", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      hooks: {
        Stop: [{ matcher: "", hooks: [managedHandler({ command: "node /tmp/grok-hook.js && touch /tmp/x" })] }],
      },
    });
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    assert.ok(result.added > 0 || result.updated > 0);
    const inspected = inspectGrokHookFile({ homeDir });
    assert.strictEqual(inspected.health, "healthy");
    const doc = readJson(configPath);
    assert.strictEqual(
      doc.hooks.Stop[0].hooks[0].command,
      desiredHookCommand(NODE_BIN, grok.resolveHookScriptPath(), { platform: process.platform })
    );
  });

  it("reports a malformed foreign sibling beside canonical owned handlers as non-healthy", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const configPath = resolveGrokConfigPath({ homeDir });
    const doc = readJson(configPath);
    // A recognized event whose matcher group lacks the required `hooks` array:
    // Grok rejects the whole file, so Clawd must not report healthy or repair it.
    doc.hooks.UserPromptSubmit = [{ matcher: "" }];
    writeJson(configPath, doc);
    const before = readRaw(configPath);
    const inspected = inspectGrokHookFile({ homeDir });
    assert.strictEqual(inspected.health, "config-corrupt");
    assert.throws(() => registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN }));
    assert.strictEqual(readRaw(configPath), before);
  });

  it("collapses duplicate managed handlers across groups to one", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      hooks: {
        Stop: [
          { matcher: "", hooks: [managedHandler()] },
          { matcher: "", hooks: [managedHandler({ command: "node /other/grok-hook.js" }), { type: "command", command: "python3 /tmp/foreign.py" }] },
        ],
      },
    });
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const doc = readJson(configPath);
    const owned = doc.hooks.Stop.flatMap((group) => (group.hooks || []).filter((h) => h.env && h.env[MANAGED_MARKER_KEY]));
    assert.strictEqual(owned.length, 1);
    // The foreign sibling in the second group is preserved.
    const allCommands = doc.hooks.Stop.flatMap((group) => (group.hooks || []).map((h) => h.command));
    assert.ok(allCommands.includes("python3 /tmp/foreign.py"));
  });

  it("uninstalls only owned handlers and deletes a provably empty owned file", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const configPath = resolveGrokConfigPath({ homeDir });
    const before = readRaw(configPath);
    const removed = unregisterGrokHooks({ homeDir, silent: true });
    assert.strictEqual(removed.removed, GROK_HOOK_EVENTS.length);
    assert.strictEqual(removed.deletedFile, true);
    assert.strictEqual(fs.existsSync(configPath), false);
    // Mandatory backup with the pre-removal bytes.
    assert.strictEqual(fs.readFileSync(removed.backupPath, "utf8"), before);
  });

  it("preserves foreign data on uninstall and never deletes a foreign file", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      env: { KEEP: "yes" },
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              managedHandler(),
              { type: "command", command: "python3 /tmp/user-audit.py" },
            ],
          },
        ],
      },
    });
    const removed = unregisterGrokHooks({ homeDir, silent: true });
    assert.strictEqual(removed.removed, 1);
    assert.strictEqual(removed.deletedFile, false);
    const doc = readJson(configPath);
    assert.strictEqual(doc.env.KEEP, "yes");
    assert.strictEqual(doc.hooks.Stop[0].hooks[0].command, "python3 /tmp/user-audit.py");

    const untouched = makeTempHome();
    const foreignPath = resolveGrokConfigPath({ homeDir: untouched });
    writeJson(foreignPath, { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "python3 /tmp/user.py" }] }] } });
    const before = readRaw(foreignPath);
    const result = unregisterGrokHooks({ homeDir: untouched, silent: true });
    assert.strictEqual(result.removed, 0);
    assert.strictEqual(readRaw(foreignPath), before);
  });

  it("fails closed on uninstall when an owned file has a malformed touched shape", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      hooks: {
        Stop: [{ matcher: { bad: true }, hooks: [managedHandler()] }],
      },
    });
    const before = readRaw(configPath);
    assert.throws(() => unregisterGrokHooks({ homeDir, silent: true }), undefined);
    assert.strictEqual(readRaw(configPath), before);
  });

  it("fails closed on uninstall for a malformed unknown event holding an owned handler", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      hooks: {
        CustomEvent: [{ matcher: 7, hooks: [managedHandler()] }],
      },
    });
    const before = readRaw(configPath);
    assert.throws(() => unregisterGrokHooks({ homeDir, silent: true }), undefined);
    assert.strictEqual(readRaw(configPath), before);
  });

  it("removes an owned handler from an unknown event and preserves valid siblings", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      hooks: {
        CustomEvent: [
          { matcher: "", hooks: [managedHandler(), { type: "command", command: "python3 /tmp/other.py" }] },
        ],
      },
    });
    const result = unregisterGrokHooks({ homeDir, silent: true });
    assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.deletedFile, false);
    const doc = readJson(configPath);
    assert.deepStrictEqual(doc.hooks.CustomEvent[0].hooks, [
      { type: "command", command: "python3 /tmp/other.py" },
    ]);
  });

  it("keeps the file when an unknown non-array event remains after owned removal", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      hooks: {
        Stop: [{ matcher: "", hooks: [managedHandler()] }],
        // Foreign/unknown non-array value: never treated as empty.
        CustomEvent: { not: "an array" },
      },
    });
    const before = readRaw(configPath);
    const result = unregisterGrokHooks({ homeDir, silent: true });
    assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.deletedFile, false);
    assert.strictEqual(fs.existsSync(configPath), true);
    const doc = readJson(configPath);
    assert.deepStrictEqual(doc.hooks.CustomEvent, { not: "an array" });
    assert.strictEqual(doc.hooks.Stop, undefined);
    // Original bytes are recoverable from the backup.
    assert.strictEqual(fs.readFileSync(result.backupPath, "utf8"), before);
  });
});

describe("Grok stale PR-preview file (no mutation)", () => {
  it("returns needs-review and creates nothing when only clawd.json exists", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    const previewPath = path.join(path.dirname(resolveGrokConfigPath({ homeDir })), PREVIEW_CONFIG_FILE_NAME);
    writeJson(previewPath, { hooks: { Stop: [] } });
    const beforePreview = readRaw(previewPath);
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    assert.strictEqual(result.status, "needs-review");
    assert.strictEqual(result.reason, "grok-stale-preview");
    assert.strictEqual(fs.existsSync(resolveGrokConfigPath({ homeDir })), false);
    assert.strictEqual(readRaw(previewPath), beforePreview);
    const inspected = inspectGrokHookFile({ homeDir });
    assert.strictEqual(inspected.health, "needs-review");
    assert.strictEqual(inspected.stalePreview, true);
  });

  it("preserves both files byte-for-byte and offers no Fix when they coexist", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const configPath = resolveGrokConfigPath({ homeDir });
    const beforeConfig = readRaw(configPath);
    const previewPath = path.join(path.dirname(configPath), PREVIEW_CONFIG_FILE_NAME);
    writeJson(previewPath, { hooks: { Stop: [] } });
    const beforePreview = readRaw(previewPath);
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    assert.strictEqual(result.status, "needs-review");
    assert.strictEqual(readRaw(configPath), beforeConfig);
    assert.strictEqual(readRaw(previewPath), beforePreview);

    const descriptor = getAgentDescriptor("grok-build");
    const detail = checkAgent(descriptor, {
      fs,
      env: {},
      homeDir,
      platform: process.platform,
      prefs: { agents: { "grok-build": { integrationInstalled: true, enabled: true } } },
    });
    assert.strictEqual(detail.status, "needs-review");
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("blocks Settings Install from committing installed/enabled", async () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    const previewPath = path.join(path.dirname(resolveGrokConfigPath({ homeDir })), PREVIEW_CONFIG_FILE_NAME);
    writeJson(previewPath, { hooks: { Stop: [] } });
    const result = await installAgentIntegration({ agentId: "grok-build" }, {
      snapshot: {},
      syncIntegrationForAgent: async () => registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN }),
    });
    assert.notStrictEqual(result.status, "ok");
    assert.strictEqual(result.commit, undefined);
    assert.strictEqual(fs.existsSync(resolveGrokConfigPath({ homeDir })), false);
  });
});

describe("Grok GROK_HOME resolution", () => {
  it("prefers trimmed GROK_HOME, falls back on empty, and is consistent everywhere", () => {
    const homeDir = makeTempHome();
    const custom = path.join(homeDir, "custom-grok");
    fs.mkdirSync(custom, { recursive: true });
    assert.strictEqual(resolveGrokHome({ homeDir, env: { GROK_HOME: `  ${custom}  ` } }), custom);
    assert.strictEqual(resolveGrokHome({ homeDir, env: { GROK_HOME: "   " } }), path.join(homeDir, ".grok"));
    assert.strictEqual(resolveGrokHome({ homeDir, env: {} }), path.join(homeDir, ".grok"));

    const env = { GROK_HOME: custom };
    registerGrokHooks({ homeDir, env, silent: true, nodeBin: NODE_BIN });
    const expectedPath = path.join(custom, "hooks", CONFIG_FILE_NAME);
    assert.strictEqual(resolveGrokConfigPath({ homeDir, env }), expectedPath);
    assert.strictEqual(fs.existsSync(expectedPath), true);
    assert.strictEqual(fs.existsSync(path.join(homeDir, ".grok", "hooks", CONFIG_FILE_NAME)), false);

    const detected = detectAgentInstallation(getAgentDescriptor("grok-build"), { homeDir, env });
    assert.strictEqual(detected.paths.parentDir, custom);
    assert.strictEqual(detected.paths.configPath, expectedPath);
    assert.strictEqual(detected.clawdIntegration.detected, true);

    const inspected = inspectGrokHookFile({ homeDir, env });
    assert.strictEqual(inspected.grokHome, custom);
    assert.strictEqual(inspected.configPath, expectedPath);
    assert.strictEqual(inspected.health, "healthy");

    const plan = buildCleanupOptionsForHome(homeDir, { env, silent: true });
    assert.strictEqual(plan.byAgent["grok-build"].configPath, expectedPath);
  });

  it("cleans the custom GROK_HOME rather than the default home", async () => {
    const homeDir = makeTempHome();
    const custom = path.join(homeDir, "custom-grok");
    fs.mkdirSync(custom, { recursive: true });
    const env = { GROK_HOME: custom };
    registerGrokHooks({ homeDir, env, silent: true, nodeBin: NODE_BIN });
    await cleanupIntegrations({ homeDir, env, silent: true, hermesCommand: false });
    assert.strictEqual(fs.existsSync(resolveGrokConfigPath({ homeDir, env })), false);
  });
});

describe("Grok inspector and Doctor", () => {
  const prefs = { agents: { "grok-build": { integrationInstalled: true, enabled: true, permissionsEnabled: false } } };

  it("reports not-connected, healthy, incomplete, foreign, and corrupt", () => {
    const homeDir = makeTempHome();
    assert.strictEqual(inspectGrokHookFile({ homeDir }).health, "not-installed");
    grokDir(homeDir);
    assert.strictEqual(inspectGrokHookFile({ homeDir }).health, "not-connected");
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    assert.strictEqual(inspectGrokHookFile({ homeDir }).health, "healthy");
    const configPath = resolveGrokConfigPath({ homeDir });
    const doc = readJson(configPath);
    delete doc.hooks.Stop;
    writeJson(configPath, doc);
    assert.strictEqual(inspectGrokHookFile({ homeDir }).health, "incomplete");
    writeJson(configPath, { hooks: { Stop: [] } });
    assert.strictEqual(inspectGrokHookFile({ homeDir }).health, "foreign-file");
    fs.writeFileSync(configPath, "{ broken", "utf8");
    assert.strictEqual(inspectGrokHookFile({ homeDir }).health, "config-corrupt");
  });

  it("reports incomplete for wrong type, command, timeout, env, duplicates, or matcher", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const configPath = resolveGrokConfigPath({ homeDir });
    const snapshot = readRaw(configPath);
    const baseDoc = readJson(configPath);

    const mutations = {
      type: () => { const d = JSON.parse(snapshot); d.hooks.Stop[0].hooks[0].type = "http"; return d; },
      command: () => { const d = JSON.parse(snapshot); d.hooks.Stop[0].hooks[0].command = "node /opt/other.js"; return d; },
      timeout: () => { const d = JSON.parse(snapshot); d.hooks.Stop[0].hooks[0].timeout = 30; return d; },
      env: () => { const d = JSON.parse(snapshot); d.hooks.Stop[0].hooks[0].env.EXTRA = "1"; return d; },
      duplicate: () => { const d = JSON.parse(snapshot); d.hooks.Stop.push({ matcher: "", hooks: [managedHandler()] }); return d; },
      matcher: () => { const d = JSON.parse(snapshot); d.hooks.Stop[0].matcher = "Bash"; return d; },
      injection: () => { const d = JSON.parse(snapshot); d.hooks.Stop[0].hooks[0].command = "node /tmp/grok-hook.js && touch /tmp/x"; return d; },
      alternatePath: () => {
        const d = JSON.parse(snapshot);
        const alternate = path.join(path.dirname(grok.resolveHookScriptPath()), "other", "grok-hook.js").replace(/\\/g, "/");
        d.hooks.Stop[0].hooks[0].command = `node "${alternate}"`;
        return d;
      },
      extraArgument: () => { const d = JSON.parse(snapshot); d.hooks.Stop[0].hooks[0].command = `${d.hooks.Stop[0].hooks[0].command} --flag`; return d; },
      wrongInterpreter: () => { const d = JSON.parse(snapshot); d.hooks.Stop[0].hooks[0].command = `python3 "${grok.resolveHookScriptPath()}"`; return d; },
    };
    for (const [label, mutate] of Object.entries(mutations)) {
      writeJson(configPath, mutate());
      const inspected = inspectGrokHookFile({ homeDir });
      assert.strictEqual(inspected.health, "incomplete", label);
      assert.ok(inspected.problems.some((problem) => problem.startsWith("Stop:")), label);
    }
    writeJson(configPath, baseDoc);
    assert.strictEqual(inspectGrokHookFile({ homeDir }).health, "healthy");
  });

  it("reports zero legacy lookalikes for a canonical healthy install", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const inspected = inspectGrokHookFile({ homeDir });
    assert.strictEqual(inspected.health, "healthy");
    assert.strictEqual(inspected.legacyCommandLookalikes, undefined);
    assert.deepStrictEqual(inspected.warnings, []);
  });

  it("reports an unowned lookalike sibling inside a canonical group exactly once", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const configPath = resolveGrokConfigPath({ homeDir });
    const doc = readJson(configPath);
    doc.hooks.Stop[0].hooks.push({ type: "command", command: "node /tmp/grok-hook.js" });
    writeJson(configPath, doc);

    const inspected = inspectGrokHookFile({ homeDir });
    assert.strictEqual(inspected.health, "healthy");
    assert.strictEqual(inspected.legacyCommandLookalikes, 1);
    assert.ok(inspected.warnings.some((warning) => /grok-hook\.js/.test(warning)));

    // Diagnostic only: the unowned sibling is preserved, never rewritten.
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const after = readJson(configPath);
    assert.ok(after.hooks.Stop[0].hooks.some((handler) => handler.command === "node /tmp/grok-hook.js"));
  });

  it("warns about an unowned same-name lookalike without authorizing mutation", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "node /tmp/my-grok-hook.js.backup" }] }] },
    });
    const before = readRaw(configPath);
    const inspected = inspectGrokHookFile({ homeDir });
    assert.strictEqual(inspected.health, "foreign-file");
    assert.ok(inspected.legacyCommandLookalikes >= 1);
    assert.ok(inspected.warnings.some((warning) => /grok-hook\.js/.test(warning)));
    assert.throws(() => registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN }), /foreign|marker/i);
    assert.strictEqual(readRaw(configPath), before);
  });

  it("never emits a WSL command form for Grok, so Doctor needs no Fix", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    const descriptor = getAgentDescriptor("grok-build");
    const prev = process.env.CLAWD_WSL_DISTRO;
    process.env.CLAWD_WSL_DISTRO = "Ubuntu-Test";
    try {
      registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
      const inspected = inspectGrokHookFile({ homeDir });
      assert.strictEqual(inspected.health, "healthy");
      if (process.platform !== "win32") {
        const doc = readJson(resolveGrokConfigPath({ homeDir }));
        assert.ok(
          doc.hooks.Stop[0].hooks[0].command.startsWith('"'),
          `expected quoted POSIX form, got ${doc.hooks.Stop[0].hooks[0].command}`
        );
      }
      const detail = checkAgent(descriptor, {
        fs, env: {}, homeDir, platform: process.platform, prefs,
      });
      assert.strictEqual(detail.status, "ok");
      assert.strictEqual(detail.fixAction, undefined);
    } finally {
      if (prev === undefined) delete process.env.CLAWD_WSL_DISTRO;
      else process.env.CLAWD_WSL_DISTRO = prev;
    }
  });

  it("keeps a mixed-case Windows Node writer healthy with no Doctor Fix loop", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    const descriptor = getAgentDescriptor("grok-build");
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: "C:/Node/NODE.EXE", platform: "win32" });
    assert.strictEqual(result.added, GROK_HOOK_EVENTS.length);
    assert.strictEqual(inspectGrokHookFile({ homeDir }).health, "healthy");
    const doc = readJson(resolveGrokConfigPath({ homeDir }));
    assert.ok(doc.hooks.Stop[0].hooks[0].command.startsWith("C:/Node/NODE.EXE "));
    const detail = checkAgent(descriptor, {
      fs, env: {}, homeDir, platform: "win32", prefs,
    });
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("reports incomplete to the detector until an installer repair runs", () => {
    const homeDir = makeTempHome();
    grokDir(homeDir);
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const configPath = resolveGrokConfigPath({ homeDir });
    const doc = readJson(configPath);
    doc.hooks.Stop[0].hooks[0].timeout = 30;
    writeJson(configPath, doc);
    const descriptor = getAgentDescriptor("grok-build");
    const before = detectAgentInstallation(descriptor, { homeDir });
    assert.strictEqual(before.clawdIntegration.detected, false);
    assert.strictEqual(before.clawdIntegration.reason, "incomplete");
    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const after = detectAgentInstallation(descriptor, { homeDir });
    assert.strictEqual(after.clawdIntegration.detected, true);
  });

  it("maps inspector health to Doctor statuses and Fix availability", () => {
    const homeDir = makeTempHome();
    const descriptor = getAgentDescriptor("grok-build");
    assert.strictEqual(descriptor.configMode, "grok-hooks");
    assert.strictEqual(descriptor.marker, MANAGED_MARKER_KEY);

    const missing = checkAgent(descriptor, { fs, env: {}, homeDir, platform: process.platform, prefs });
    assert.strictEqual(missing.status, "not-installed");

    grokDir(homeDir);
    const notConnected = checkAgent(descriptor, { fs, env: {}, homeDir, platform: process.platform, prefs });
    assert.strictEqual(notConnected.status, "not-connected");
    assert.deepStrictEqual(notConnected.fixAction, { type: "agent-integration", agentId: "grok-build" });

    registerGrokHooks({ homeDir, silent: true, nodeBin: NODE_BIN });
    const healthy = checkAgent(descriptor, { fs, env: {}, homeDir, platform: process.platform, prefs });
    assert.strictEqual(healthy.status, "ok");

    const configPath = resolveGrokConfigPath({ homeDir });
    const doc = readJson(configPath);
    doc.hooks.Stop[0].hooks[0].timeout = 30;
    writeJson(configPath, doc);
    const broken = checkAgent(descriptor, { fs, env: {}, homeDir, platform: process.platform, prefs });
    assert.strictEqual(broken.status, "broken-path");
    assert.deepStrictEqual(broken.fixAction, { type: "agent-integration", agentId: "grok-build" });

    writeJson(configPath, { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "python3 /tmp/user.py" }] }] } });
    const foreign = checkAgent(descriptor, { fs, env: {}, homeDir, platform: process.platform, prefs });
    assert.strictEqual(foreign.status, "needs-review");
    assert.strictEqual(foreign.fixAction, undefined);
  });
});

describe("Grok installer Windows command form", () => {
  it("uses the portable wrapper without a PowerShell call operator", () => {
    const command = desiredHookCommand(
      "C:/Program Files/nodejs/node.exe",
      "C:/Clawd on Desk/hooks/grok-hook.js",
      { platform: "win32" }
    );
    assert.ok(!command.startsWith("& "));
    assert.ok(!command.includes("-EncodedCommand"));
    assert.ok(command.includes('"C:/Clawd on Desk/hooks/grok-hook.js"'));
    assert.strictEqual(command.startsWith("node "), true);

    const cleanNode = desiredHookCommand("C:/nodejs/node.exe", "C:/clawd/hooks/grok-hook.js", { platform: "win32" });
    assert.strictEqual(cleanNode.startsWith("C:/nodejs/node.exe "), true);

    const posix = desiredHookCommand("/usr/local/bin/node", "/opt/clawd/hooks/grok-hook.js", { platform: "linux" });
    assert.ok(posix.startsWith('"/usr/local/bin/node"'));
  });

  it("recognizes Windows node basenames case-insensitively without loosening other constraints", () => {
    const hookScript = grok.resolveHookScriptPath();
    for (const nodeBin of ["C:/Node/NODE.EXE", "C:/Node/Node", "c:/node/node.exe", "C:/Node/nOdE.ExE"]) {
      const command = desiredHookCommand(nodeBin, hookScript, { platform: "win32" });
      assert.ok(grok.parseCanonicalManagedCommand(command, hookScript), nodeBin);
    }
    // Only the basename casing is relaxed: path form, extra tokens, and any
    // shell operator must still be rejected.
    assert.strictEqual(
      grok.parseCanonicalManagedCommand(`C:/Node/NODE.EXE "${hookScript}" --flag`, hookScript),
      null
    );
    assert.strictEqual(
      grok.parseCanonicalManagedCommand(`C:/Node/NODE.EXE "${hookScript}" && touch /tmp/x`, hookScript),
      null
    );
    assert.strictEqual(
      grok.parseCanonicalManagedCommand(`C:/Node/NODE.EXE.CMD "${hookScript}"`, hookScript),
      null
    );
    assert.strictEqual(
      grok.parseCanonicalManagedCommand(`Node/NODE.EXE "${hookScript}"`, hookScript),
      null
    );
  });

  it("strictly recognizes only the canonical managed command", () => {
    const hookScript = grok.resolveHookScriptPath();
    const positives = [
      desiredHookCommand("/usr/local/bin/node", hookScript, { platform: "linux" }),
      desiredHookCommand("node", hookScript, { platform: "linux" }),
      desiredHookCommand("C:/nodejs/node.exe", hookScript, { platform: "win32" }),
      desiredHookCommand("C:/nodejs/node", hookScript, { platform: "win32" }),
      desiredHookCommand("C:/Program Files/nodejs/node.exe", hookScript, { platform: "win32" }),
      // Writer/inspector symmetry: an absolute Windows node token may omit .exe.
      `C:/nodejs/node "${hookScript}"`,
    ];
    for (const command of positives) {
      assert.ok(grok.parseCanonicalManagedCommand(command, hookScript), command);
    }

    const negativeScript = path.join(path.dirname(hookScript), "grok-hook.js").replace(/grok-hook\.js$/, "other/grok-hook.js");
    const negatives = [
      `node /tmp/grok-hook.js && touch /tmp/owned-command-injection`,
      `node "${negativeScript}"`,
      `${positives[0]} --flag`,
      `python3 "${hookScript}"`,
      `node "C:/other/grok-hook.js"`,
      `node ${hookScript}`,
      `"/usr/local/bin/node" "${hookScript}" extra`,
    ];
    for (const command of negatives) {
      assert.strictEqual(grok.parseCanonicalManagedCommand(command, hookScript), null, command);
    }
  });
});
