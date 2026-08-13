// opencode-family shared core — factory isolation, prefix matrix, and
// registry↔entry cross-checks (plan-opencode-family-shared-integration.md §9).

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("node:url");

const {
  OPENCODE_FAMILY,
  FAMILY_EVENT_MAP,
  FAMILY_CAPABILITIES,
  isOpencodeFamily,
  isOpencodeFamilyEntry,
} = require("../agents/opencode-family");

const { NESTED_TERMINAL_ENV } = require("../hooks/shared-process");

const HOOKS_DIR = path.join(__dirname, "..", "hooks");

async function loadCore() {
  const modulePath = path.join(HOOKS_DIR, "opencode-family-plugin", "core.mjs");
  return import(pathToFileURL(modulePath).href);
}

async function loadSessionIds() {
  const modulePath = path.join(HOOKS_DIR, "opencode-family-plugin", "session-ids.mjs");
  return import(pathToFileURL(modulePath).href);
}

const OPENCODE_PARAMS = Object.freeze({
  agentId: "opencode",
  hookSource: "opencode-plugin",
  logFileName: "opencode-plugin.log",
  sessionIdPrefix: "opencode:",
});
// mimocode lands with the #607 rebase; the factory must already support any
// second member — use its future params to prove instance isolation today.
const MIMOCODE_PARAMS = Object.freeze({
  agentId: "mimocode",
  hookSource: "mimocode-plugin",
  logFileName: "mimocode-plugin.log",
  sessionIdPrefix: "mimocode:",
});

describe("opencode-family plugin factory", () => {
  it("requires all four identity params", async () => {
    const { createOpencodeFamilyPlugin } = await loadCore();
    assert.throws(() => createOpencodeFamilyPlugin(), /agentId is required/);
    for (const missing of ["agentId", "hookSource", "logFileName", "sessionIdPrefix"]) {
      const params = { ...OPENCODE_PARAMS };
      delete params[missing];
      assert.throws(
        () => createOpencodeFamilyPlugin(params),
        new RegExp(`${missing} is required`),
        `expected missing ${missing} to throw`
      );
    }
  });

  it("keeps two instances fully isolated (state maps + prefixes)", async () => {
    const { createOpencodeFamilyPlugin } = await loadCore();
    const oc = createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const mc = createOpencodeFamilyPlugin(MIMOCODE_PARAMS);

    // Separate mutable state: the parent maps are distinct objects.
    assert.notStrictEqual(oc.__test._sessionParentById, mc.__test._sessionParentById);

    // Same raw session id yields per-agent namespaced ids — the #607-review
    // collision scenario (state.js keys sessions by session_id alone).
    const ocBody = oc.__test.buildStateBody("idle", "SessionStart", "ses_123");
    const mcBody = mc.__test.buildStateBody("idle", "SessionStart", "ses_123");
    assert.strictEqual(ocBody.session_id, "opencode:ses_123");
    assert.strictEqual(mcBody.session_id, "mimocode:ses_123");
    assert.strictEqual(ocBody.agent_id, "opencode");
    assert.strictEqual(mcBody.agent_id, "mimocode");
    assert.strictEqual(ocBody.hook_source, "opencode-plugin");
    assert.strictEqual(mcBody.hook_source, "mimocode-plugin");

    // Child bookkeeping in one instance never leaks into the other.
    oc.__test._sessionParentById.set("opencode:ses_child", "opencode:ses_root");
    assert.strictEqual(
      oc.__test.buildStateBody("working", "PreToolUse", "ses_child").headless,
      true
    );
    assert.strictEqual(
      mc.__test.buildStateBody("working", "PreToolUse", "ses_child").headless,
      undefined
    );
    const mcIdle = mc.__test.translateEvent({ type: "session.idle", properties: { sessionID: "ses_child" } });
    assert.strictEqual(mcIdle.event, "Stop"); // not SessionEnd — no cross-instance child state
    oc.__test._sessionParentById.clear();
  });

  it("keeps genuine root completion and deletion lifecycle events authoritative", async () => {
    const { createOpencodeFamilyPlugin } = await loadCore();
    const plugin = createOpencodeFamilyPlugin(OPENCODE_PARAMS);

    assert.deepStrictEqual(
      plugin.__test.translateEvent({
        type: "session.idle",
        properties: { sessionID: "ses_root" },
      }),
      { state: "attention", event: "Stop" },
    );
    assert.deepStrictEqual(
      plugin.__test.translateEvent({
        type: "session.deleted",
        properties: { sessionID: "ses_root" },
      }),
      { state: "sleeping", event: "SessionEnd" },
    );
  });

  it("isolates the FULL per-instance state bag (log path, dedup, port cache, bridge)", async () => {
    const { createOpencodeFamilyPlugin } = await loadCore();
    const oc = createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const mc = createOpencodeFamilyPlugin(MIMOCODE_PARAMS);

    // logFileName actually binds per instance — a hardcoded DEBUG_LOG_PATH
    // (the reviewer's surviving mutation) must fail here.
    assert.ok(oc.__test._debugLogPath.endsWith("opencode-plugin.log"), oc.__test._debugLogPath);
    assert.ok(mc.__test._debugLogPath.endsWith("mimocode-plugin.log"), mc.__test._debugLogPath);
    assert.notStrictEqual(oc.__test._debugLogPath, mc.__test._debugLogPath);

    // Per-session dedup map: distinct objects, no cross-instance visibility.
    assert.notStrictEqual(oc.__test._lastStatePerSession, mc.__test._lastStatePerSession);
    assert.notStrictEqual(oc.__test._statePostTailBySession, mc.__test._statePostTailBySession);
    assert.notStrictEqual(oc.__test._sessionInstanceDirectoryById, mc.__test._sessionInstanceDirectoryById);
    assert.notStrictEqual(oc.__test._permissionTargetByRequestId, mc.__test._permissionTargetByRequestId);
    oc.__test._lastStatePerSession.set("opencode:ses_x", "working");
    assert.strictEqual(mc.__test._lastStatePerSession.size, 0);
    oc.__test._lastStatePerSession.clear();

    // Port cache: live getter/setter into the closure, isolated per instance.
    assert.strictEqual(oc.__test._cachedPort, null);
    oc.__test._cachedPort = 23334;
    assert.strictEqual(oc.__test._cachedPort, 23334); // getter reads live state
    assert.strictEqual(mc.__test._cachedPort, null);   // not shared
    oc.__test._cachedPort = null;

    // Bridge state starts empty in both (startBridge only runs at plugin init
    // under Bun); pid chains are distinct arrays.
    assert.strictEqual(oc.__test._bridgeUrl, "");
    assert.strictEqual(mc.__test._bridgeUrl, "");
    assert.strictEqual(oc.__test._bridgeTokenHex, "");
    assert.notStrictEqual(oc.__test._pidChain, mc.__test._pidChain);
  });

  it("isolates authoritative session directories and the info latch per factory", async () => {
    const { createOpencodeFamilyPlugin } = await loadCore();
    const oc = createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const mc = createOpencodeFamilyPlugin(MIMOCODE_PARAMS);

    assert.notStrictEqual(oc.__test._sessionDirectoryById, mc.__test._sessionDirectoryById);
    assert.strictEqual(oc.__test._hostEmitsSessionInfo, false);
    assert.strictEqual(mc.__test._hostEmitsSessionInfo, false);

    oc.__test.captureSessionDirectory({
      type: "session.created",
      properties: {
        sessionID: "ses_shared",
        info: { id: "opencode:ses_shared", directory: "C:\\active" },
      },
    });

    assert.strictEqual(oc.__test._hostEmitsSessionInfo, true);
    assert.strictEqual(mc.__test._hostEmitsSessionInfo, false);
    assert.deepStrictEqual(oc.__test.resolveSessionDirectory("ses_shared"), {
      directory: "C:\\active",
      source: "session-info",
    });
    assert.deepStrictEqual(mc.__test.resolveSessionDirectory("ses_shared"), {
      directory: null,
      source: "none",
    });
  });

  it("fails directory capture closed on mismatched or invalid session info", async () => {
    const { createOpencodeFamilyPlugin } = await loadCore();
    const plugin = createOpencodeFamilyPlugin(OPENCODE_PARAMS);

    assert.strictEqual(
      plugin.__test.captureSessionDirectory({
        type: "session.created",
        properties: {
          sessionID: "ses_wire",
          info: { id: "ses_other", directory: "C:\\wrong" },
        },
      }),
      null
    );
    assert.strictEqual(plugin.__test._sessionDirectoryById.size, 0);
    assert.strictEqual(plugin.__test._hostEmitsSessionInfo, false);

    assert.strictEqual(
      plugin.__test.captureSessionDirectory({
        type: "session.updated",
        properties: {
          sessionID: "ses_wire",
          info: { id: "ses_wire", directory: "   " },
        },
      }),
      null
    );
    assert.strictEqual(plugin.__test._sessionDirectoryById.size, 0);
    assert.strictEqual(plugin.__test._hostEmitsSessionInfo, false);
  });

  it("updates one session directory and cleans it only in the after-send phase", async () => {
    const { createOpencodeFamilyPlugin } = await loadCore();
    const plugin = createOpencodeFamilyPlugin(OPENCODE_PARAMS);
    const created = {
      type: "session.created",
      properties: { sessionID: "ses_a", info: { id: "ses_a", directory: "C:\\old" } },
    };
    const updated = {
      type: "session.updated",
      properties: { sessionID: "ses_a", info: { id: "ses_a", directory: "C:\\new" } },
    };
    const deleted = {
      type: "session.deleted",
      properties: { sessionID: "ses_a", info: { id: "ses_a", directory: "C:\\new" } },
    };

    plugin.__test.captureSessionDirectory(created);
    plugin.__test.captureSessionDirectory(updated);
    assert.strictEqual(plugin.__test._sessionDirectoryById.get("opencode:ses_a"), "C:\\new");
    plugin.__test.captureSessionDirectory({
      type: "session.updated",
      properties: { sessionID: "ses_a", info: { id: "ses_a", directory: "  " } },
    });
    assert.strictEqual(
      plugin.__test._sessionDirectoryById.get("opencode:ses_a"),
      "C:\\new",
      "an invalid update must not clear the last authoritative directory"
    );

    plugin.__test.cleanupSessionDirectory(deleted, "before-send");
    assert.strictEqual(
      plugin.__test._sessionDirectoryById.get("opencode:ses_a"),
      "C:\\new",
      "deleted directory must remain available for SessionEnd serialization"
    );
    plugin.__test.cleanupSessionDirectory(deleted, "after-send");
    assert.strictEqual(plugin.__test._sessionDirectoryById.has("opencode:ses_a"), false);

    plugin.__test.captureSessionDirectory(created);
    plugin.__test.cleanupSessionDirectory(
      { type: "server.instance.disposed", properties: {} },
      "before-send"
    );
    assert.strictEqual(plugin.__test._sessionDirectoryById.size, 0);
  });
});

describe("opencode-family Windows GUI host focus identity", () => {
  it("stops at the outermost OpenChamber process instead of its launcher editor", async () => {
    const { resolveWindowsStableProcess } = await loadCore();
    const snapshot = new Map([
      [101, { name: "opencode.exe", ppid: 102 }],
      [102, { name: "cmd.exe", ppid: 103 }],
      [103, { name: "openchamber.exe", ppid: 104 }],
      [104, { name: "openchamber.exe", ppid: 105 }],
      [105, { name: "powershell.exe", ppid: 106 }],
      [106, { name: "code.exe", ppid: 107 }],
      [107, { name: "explorer.exe", ppid: 0 }],
    ]);

    assert.deepStrictEqual(resolveWindowsStableProcess(101, snapshot), {
      stablePid: 104,
      pidChain: [101, 102, 103, 104],
      detectedEditor: null,
    });
  });

  it("keeps the outermost-terminal behavior for direct CLI sessions", async () => {
    const { resolveWindowsStableProcess } = await loadCore();
    const snapshot = new Map([
      [201, { name: "opencode.exe", ppid: 202 }],
      [202, { name: "node.exe", ppid: 203 }],
      [203, { name: "powershell.exe", ppid: 204 }],
      [204, { name: "code.exe", ppid: 205 }],
      [205, { name: "explorer.exe", ppid: 0 }],
    ]);

    assert.deepStrictEqual(resolveWindowsStableProcess(201, snapshot), {
      stablePid: 204,
      pidChain: [201, 202, 203, 204, 205],
      detectedEditor: "code",
    });
  });
});

describe("opencode-family session-id helpers (prefix matrix)", () => {
  for (const prefix of ["opencode:", "mimocode:"]) {
    it(`${prefix} raw + prefixed child lookup`, async () => {
      const { createSessionIdHelpers } = await loadSessionIds();
      const ids = createSessionIdHelpers(prefix);
      const map = new Map();
      map.set(`${prefix}ses_child1`, `${prefix}ses_root`);
      map.set(`${prefix}ses_child2`, `${prefix}ses_root`);

      // raw and already-prefixed forms both hit
      assert.strictEqual(ids.isChildSessionId("ses_child1", map), true);
      assert.strictEqual(ids.isChildSessionId(`${prefix}ses_child1`, map), true);
      assert.strictEqual(ids.isChildSessionId("ses_root", map), false);
    });
  }

  it("helpers from one prefix never match another prefix's map keys", async () => {
    const { createSessionIdHelpers } = await loadSessionIds();
    const oc = createSessionIdHelpers("opencode:");
    const mimoMap = new Map([["mimocode:ses_child", "mimocode:ses_root"]]);

    // The v3-review blocker scenario: an opencode-prefixed lookup against a
    // mimocode-keyed map must MISS — proving these helpers are prefix-bound
    // and must come from the factory, never shared verbatim.
    assert.strictEqual(oc.isChildSessionId("ses_child", mimoMap), false);
  });

  it("DEFAULT_SESSION_ID and resolve fallback follow the prefix", async () => {
    const { createSessionIdHelpers } = await loadSessionIds();
    const mc = createSessionIdHelpers("mimocode:");
    assert.strictEqual(mc.DEFAULT_SESSION_ID, "mimocode:default");
    assert.strictEqual(mc.resolveSessionId(null, null), "mimocode:default");
    assert.strictEqual(mc.resolveSessionId("ses_a", null), "mimocode:ses_a");
  });
});

describe("opencode-family registry", () => {
  it("membership is the explicit allowlist, never eventSource inference", () => {
    assert.strictEqual(isOpencodeFamily("opencode"), true);
    // plugin-event agents that are NOT family members (plan §7):
    assert.strictEqual(isOpencodeFamily("openclaw"), false);
    assert.strictEqual(isOpencodeFamily("hermes"), false);
    assert.strictEqual(isOpencodeFamily("claude-code"), false);
    assert.strictEqual(isOpencodeFamily(null), false);
  });

  it("isOpencodeFamilyEntry keys off the PUBLIC agentId field", () => {
    assert.strictEqual(isOpencodeFamilyEntry({ agentId: "opencode" }), true);
    assert.strictEqual(isOpencodeFamilyEntry({ agentId: "claude-code" }), false);
    assert.strictEqual(isOpencodeFamilyEntry({ familyAgentId: "opencode" }), false);
    assert.strictEqual(isOpencodeFamilyEntry(null), false);
  });

  it("EVERY member's agents/<id>.js sources the shared family contract by REFERENCE", () => {
    // strictEqual (same object), not deepStrictEqual: a look-alike copy with
    // one drifted value (e.g. Stop: "idle", or permissionApproval: false —
    // which silently kills the member's permission bubbles) must fail here
    // (dual-review S-F2).
    for (const agentId of Object.keys(OPENCODE_FAMILY)) {
      // eslint-disable-next-line global-require
      const agent = require(`../agents/${agentId}`);
      assert.strictEqual(agent.eventMap, FAMILY_EVENT_MAP, `${agentId} eventMap must be the shared object`);
      assert.strictEqual(agent.capabilities, FAMILY_CAPABILITIES, `${agentId} capabilities must be the shared object`);
      assert.strictEqual(agent.eventSource, "plugin-event");
      assert.strictEqual(agent.id, agentId);
    }
  });

  it("every member's logFileName is in the doctor's default log allowlist", () => {
    // doctor-logs falls back to this basename list when picking the most
    // recent log; a typo'd entry silently drops the member from that path.
    // eslint-disable-next-line global-require
    const { DEFAULT_LOG_BASENAMES } = require("../src/doctor-logs");
    for (const [agentId, cfg] of Object.entries(OPENCODE_FAMILY)) {
      assert.ok(
        DEFAULT_LOG_BASENAMES.includes(cfg.logFileName),
        `${agentId}: ${cfg.logFileName} missing from doctor-logs DEFAULT_LOG_BASENAMES`
      );
    }
  });

  it("every member's plugin entry literals match the registry (no drift)", async () => {
    // The Bun-side entries cannot require this CJS registry, so they repeat
    // the four identity params as literals — this test is the drift lock
    // (plan §3.1 CJS/ESM note).
    for (const [agentId, cfg] of Object.entries(OPENCODE_FAMILY)) {
      const entryPath = path.join(HOOKS_DIR, cfg.pluginDirName, "index.mjs");
      // Every registry member ships its thin entry — a missing one must fail
      // loudly here, not silently skip (the pre-#607 escape hatch is gone).
      assert.ok(fs.existsSync(entryPath), `${agentId} plugin entry missing: ${entryPath}`);
      const source = fs.readFileSync(entryPath, "utf8");
      const expectations = {
        agentId,
        hookSource: cfg.hookSource,
        logFileName: cfg.logFileName,
        sessionIdPrefix: cfg.sessionIdPrefix,
      };
      for (const [key, expected] of Object.entries(expectations)) {
        const m = source.match(new RegExp(`${key}:\\s*"([^"]+)"`));
        assert.ok(m, `${entryPath} must set ${key} as a string literal`);
        assert.strictEqual(m[1], expected, `${entryPath} ${key} drifted from the registry`);
      }

      // #413: the entry module must have exactly one export — default.
      const mod = await import(pathToFileURL(entryPath).href);
      assert.deepStrictEqual(Object.keys(mod), ["default"]);
      assert.strictEqual(typeof mod.default, "function");
    }
  });

  it("registered plugin path is byte-identical to the pre-refactor installer", () => {
    // Existing user configs hold the absolute path of hooks/opencode-plugin.
    // The shared installer must keep producing exactly that string — dev and
    // packaged (asar.unpacked) shapes — or every install would need a config
    // migration (plan §3.2).
    const { resolvePluginDir } = require("../hooks/opencode-install");
    if (process.platform === "win32") {
      assert.strictEqual(resolvePluginDir("D:/app/clawd/hooks"), "D:/app/clawd/hooks/opencode-plugin");
      assert.strictEqual(
        resolvePluginDir("D:/app/Clawd/resources/app.asar/hooks"),
        "D:/app/Clawd/resources/app.asar.unpacked/hooks/opencode-plugin"
      );
    } else {
      assert.strictEqual(resolvePluginDir("/app/clawd/hooks"), "/app/clawd/hooks/opencode-plugin");
      assert.strictEqual(
        resolvePluginDir("/Applications/Clawd.app/Contents/Resources/app.asar/hooks"),
        "/Applications/Clawd.app/Contents/Resources/app.asar.unpacked/hooks/opencode-plugin"
      );
    }
    // The shared core dir must never leak into the registered string.
    assert.strictEqual(resolvePluginDir("/x/hooks").includes("opencode-family-plugin"), false);
  });

  it("registry config paths match the installer defaults", () => {
    const opencodeInstall = require("../hooks/opencode-install");
    const cfg = OPENCODE_FAMILY.opencode;
    const os = require("os");
    assert.strictEqual(
      opencodeInstall.DEFAULT_PARENT_DIR,
      path.join(os.homedir(), ...cfg.configDirSegments)
    );
    assert.strictEqual(
      opencodeInstall.DEFAULT_CONFIG_PATH,
      path.join(os.homedir(), ...cfg.configDirSegments, cfg.configFileName)
    );
  });
});

describe("opencode-family Orca pane key", () => {
  it("derives the pane key from the environment alone", async () => {
    const { orcaPaneKeyFromEnv } = await loadCore();
    assert.strictEqual(orcaPaneKeyFromEnv({ TERM_PROGRAM: "Orca", ORCA_PANE_KEY: "tab-1:leaf-1" }), "tab-1:leaf-1");
    // Inherited by a child shell without the TERM_PROGRAM confirmation.
    assert.strictEqual(orcaPaneKeyFromEnv({ ORCA_PANE_KEY: "tab-1:leaf-1" }), null);
    assert.strictEqual(orcaPaneKeyFromEnv({ TERM_PROGRAM: "Orca", ORCA_PANE_KEY: "no-separator" }), null);
    for (const marker of NESTED_TERMINAL_ENV) {
      assert.strictEqual(
        orcaPaneKeyFromEnv({ TERM_PROGRAM: "Orca", ORCA_PANE_KEY: "tab-1:leaf-1", [marker]: "1" }),
        null,
        `${marker} must veto the pane key`
      );
    }
  });

  it("emits the pane key outside the process-walk gate", () => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, "opencode-family-plugin", "core.mjs"), "utf8");
    const lines = src.split(/\r?\n/);
    const gate = lines.findIndex((line) => line.includes("if (_stablePid) {"));
    assert.ok(gate > 0, "expected the process-walk gate");
    const gateEnd = lines.findIndex((line, i) => i > gate && line.trim() === "}");
    const emit = lines.findIndex((line) => line.includes("outbound.orca_pane_key"));
    // Orca's detached daemon is exactly the case where the walk reports no
    // terminal, so a pane key emitted inside that gate would never ship for the
    // sessions the feature exists to focus.
    assert.ok(gateEnd > gate && emit > gateEnd,
      "the pane key must be emitted outside the _stablePid gate");
  });
});
