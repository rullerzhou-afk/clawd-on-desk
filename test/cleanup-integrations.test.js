const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  AGENT_CLEANERS,
  AGENT_DISPLAY_NAMES,
  MANAGED_AGENT_IDS,
  buildCleanupOptionsForHome,
  cleanupIntegrations,
} = require("../hooks/cleanup-integrations");
const { resolvePluginDir } = require("../hooks/opencode-install");
const { resolveManagedRoot: resolveDshManagedRoot } = require("../hooks/dsh-install");
const { registerQwenWorkHooks } = require("../hooks/qwenwork-install");
const { registerCodexHooks, CODEX_OFFICIAL_HOOK_EVENTS } = require("../hooks/codex-install");
const { stableCodexHookPaths } = require("../hooks/codex-install-utils");
const agentCommands = require("../src/settings-actions-agents");
const { MANAGED_CLEANUP_AGENT_IDS, commandRegistry } = require("../src/settings-actions");
const { createIntegrationSyncRuntime } = require("../src/integration-sync");
const prefs = require("../src/prefs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listCleanupBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.includes(".clawd-cleanup-") && name.endsWith(".bak"));
}

describe("cleanupIntegrations", () => {
  it("builds explicit cleanup path overrides for every managed agent", () => {
    const homeDir = path.join(os.tmpdir(), "clawd-target-home");
    const inheritedLocalAppData = path.join(os.tmpdir(), "admin-local-appdata");
    const targetLocalAppData = path.join(homeDir, "AppData", "Local");
    const targetAppData = path.join(homeDir, "AppData", "Roaming");
    const plan = buildCleanupOptionsForHome(homeDir, {
      env: {
        HERMES_HOME: path.join(os.tmpdir(), "admin-hermes"),
        REASONIX_HOME: path.join(os.tmpdir(), "admin-reasonix"),
        DSH_HOME: path.join(os.tmpdir(), "admin-dsh"),
        LOCALAPPDATA: inheritedLocalAppData,
        APPDATA: path.join(os.tmpdir(), "admin-appdata"),
      },
      hermesCommand: false,
      platform: "win32",
    });
    const missing = MANAGED_AGENT_IDS.filter((agentId) => !plan.byAgent[agentId]);

    assert.deepStrictEqual(missing, []);
    for (const agentId of MANAGED_AGENT_IDS) {
      assert.notStrictEqual(plan.byAgent[agentId], plan.common, `${agentId} must not fall back to common options`);
    }
    assert.strictEqual(plan.byAgent["claude-code"].settingsPath, path.join(homeDir, ".claude", "settings.json"));
    assert.strictEqual(plan.byAgent.codex.hooksPath, path.join(homeDir, ".codex", "hooks.json"));
    assert.strictEqual(plan.byAgent.codewhale.configPath, path.join(homeDir, ".codewhale", "config.toml"));
    assert.strictEqual(plan.byAgent.opencode.configPath, path.join(homeDir, ".config", "opencode", "opencode.json"));
    assert.strictEqual(plan.byAgent.pi.parentDir, path.join(homeDir, ".pi", "agent"));
    assert.deepStrictEqual(plan.byAgent.reasonix.settingsPaths, [
      path.join(targetAppData, "reasonix", "settings.json"),
      path.join(homeDir, ".reasonix", "settings.json"),
    ]);
    assert.strictEqual(plan.env.LOCALAPPDATA, targetLocalAppData);
    assert.strictEqual(plan.env.APPDATA, targetAppData);
    assert.strictEqual(plan.env.HERMES_HOME, undefined);
    assert.strictEqual(plan.env.REASONIX_HOME, undefined);
    assert.strictEqual(plan.env.DSH_HOME, path.resolve(path.join(os.tmpdir(), "admin-dsh")));
    assert.strictEqual(plan.byAgent["deepseek-harness"].dshHome, plan.env.DSH_HOME);
    assert.strictEqual(plan.byAgent["deepseek-harness"].env.DSH_HOME, plan.env.DSH_HOME);
    assert.strictEqual(plan.byAgent.hermes.env.LOCALAPPDATA, targetLocalAppData);
    assert.notStrictEqual(plan.byAgent.hermes.hermesHome, path.join(inheritedLocalAppData, "hermes"));
  });

  it("honors only an explicitly targeted DSH_HOME during alternate-home cleanup", () => {
    const homeDir = path.join(os.tmpdir(), "clawd-target-home-explicit-dsh");
    const dshHome = path.join(os.tmpdir(), "clawd-target-dsh");
    const plan = buildCleanupOptionsForHome(homeDir, {
      env: { DSH_HOME: dshHome },
    });
    assert.strictEqual(plan.env.DSH_HOME, path.resolve(dshHome));
    assert.strictEqual(plan.byAgent["deepseek-harness"].dshHome, path.resolve(dshHome));
    assert.strictEqual(plan.byAgent["deepseek-harness"].managedRoot, undefined);
    const defaultPlan = buildCleanupOptionsForHome(homeDir, {
      dshHome: path.join(homeDir, ".dsh"),
    });
    assert.notStrictEqual(
      resolveDshManagedRoot(plan.byAgent["deepseek-harness"]),
      resolveDshManagedRoot(defaultPlan.byAgent["deepseek-harness"]),
    );
  });

  it("does not inherit the process DSH_HOME for an explicit alternate home", () => {
    const previous = process.env.DSH_HOME;
    const homeDir = path.join(os.tmpdir(), "clawd-target-home-no-inherit-dsh");
    process.env.DSH_HOME = path.join(os.tmpdir(), "admin-process-dsh");
    try {
      const plan = buildCleanupOptionsForHome(homeDir);
      assert.strictEqual(plan.env.DSH_HOME, undefined);
      assert.strictEqual(plan.byAgent["deepseek-harness"].dshHome, path.join(homeDir, ".dsh"));
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });

  it("cleans hooks and stable launchers from an explicit custom CODEX_HOME", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cleanup-custom-codex-"));
    const homeDir = path.join(root, "home");
    const codexDir = path.join(root, "custom-codex");
    fs.mkdirSync(codexDir, { recursive: true });

    try {
      registerCodexHooks({
        silent: true,
        codexDir,
        nodeBin: process.execPath,
        platform: process.platform,
      });
      const stableDir = stableCodexHookPaths(codexDir).stableDir;
      assert.strictEqual(fs.existsSync(stableDir), true);

      const result = await cleanupIntegrations({
        homeDir,
        env: { CODEX_HOME: codexDir },
        backup: true,
        silent: true,
        hermesCommand: false,
      });
      const codex = result.agents.find((entry) => entry.agentId === "codex");

      assert.strictEqual(codex.status, "applied");
      assert.strictEqual(codex.removed, CODEX_OFFICIAL_HOOK_EVENTS.length);
      assert.strictEqual(fs.existsSync(stableDir), false);
      assert.deepStrictEqual(readJson(path.join(codexDir, "hooks.json")).hooks, {});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans Reasonix hooks from both current and legacy Windows homes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cleanup-reasonix-"));
    const homeDir = path.join(root, "home");
    const currentSettings = path.join(homeDir, "AppData", "Roaming", "reasonix", "settings.json");
    const legacySettings = path.join(homeDir, ".reasonix", "settings.json");
    for (const settingsPath of [currentSettings, legacySettings]) {
      writeJson(settingsPath, {
        hooks: {
          Stop: [
            { match: "*", command: 'node "C:/clawd/hooks/reasonix-hook.js"' },
            { match: "*", command: "echo keep-user-hook" },
          ],
        },
      });
    }

    try {
      const result = await cleanupIntegrations({
        homeDir,
        platform: "win32",
        env: { REASONIX_HOME: "" },
        backup: true,
        silent: true,
        hermesCommand: false,
      });
      const reasonix = result.agents.find((entry) => entry.agentId === "reasonix");

      assert.strictEqual(reasonix.status, "applied");
      assert.strictEqual(reasonix.removed, 2);
      for (const settingsPath of [currentSettings, legacySettings]) {
        assert.deepStrictEqual(readJson(settingsPath).hooks.Stop, [
          { match: "*", command: "echo keep-user-hook" },
        ]);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a partial Reasonix cleanup failure after still cleaning the other home", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cleanup-reasonix-error-"));
    const homeDir = path.join(root, "home");
    const currentSettings = path.join(homeDir, "AppData", "Roaming", "reasonix", "settings.json");
    const legacySettings = path.join(homeDir, ".reasonix", "settings.json");
    fs.mkdirSync(path.dirname(currentSettings), { recursive: true });
    fs.writeFileSync(currentSettings, "{ invalid json", "utf8");
    writeJson(legacySettings, {
      hooks: {
        Stop: [
          { match: "*", command: 'node "C:/clawd/hooks/reasonix-hook.js"' },
          { match: "*", command: "echo keep-user-hook" },
        ],
      },
    });

    try {
      const result = await cleanupIntegrations({
        homeDir,
        platform: "win32",
        backup: true,
        silent: true,
        hermesCommand: false,
      });
      const reasonix = result.agents.find((entry) => entry.agentId === "reasonix");

      assert.strictEqual(reasonix.status, "failed");
      assert.strictEqual(reasonix.removed, 1);
      assert.match(reasonix.error, /Failed to clean Reasonix hooks/);
      assert.strictEqual(result.summary.failed >= 1, true);
      assert.deepStrictEqual(readJson(legacySettings).hooks.Stop, [
        { match: "*", command: "echo keep-user-hook" },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes managed hooks/plugins safely, backs up once, and is idempotent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cleanup-"));
    const homeDir = path.join(root, "home");
    const pluginDir = resolvePluginDir();
    const codexPath = path.join(homeDir, ".codex", "hooks.json");
    const codewhalePath = path.join(homeDir, ".codewhale", "config.toml");
    const opencodePath = path.join(homeDir, ".config", "opencode", "opencode.json");
    const kiroTeamPath = path.join(homeDir, ".kiro", "agents", "team.json");
    const kiroClawdPath = path.join(homeDir, ".kiro", "agents", "clawd.json");

    writeJson(codexPath, {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: 'node "C:/clawd/hooks/codex-hook.js"' }] },
          { hooks: [{ type: "command", command: 'node "C:/clawd/hooks/codex-debug-hook.js"' }] },
          { hooks: [{ type: "command", command: 'node "C:/user/hooks/keep.js"' }] },
        ],
      },
    });
    fs.mkdirSync(path.dirname(codewhalePath), { recursive: true });
    fs.writeFileSync(
      codewhalePath,
      [
        "[hooks]",
        "enabled = true",
        "",
        "[[hooks.hooks]]",
        "# managed by clawd-on-desk",
        'event = "session_start"',
        'command = "\\"node\\" \\"C:/clawd/hooks/codewhale-hook.js\\" \\"session_start\\""',
        "",
        "[[hooks.hooks]]",
        'event = "session_start"',
        'command = "echo user-hook"',
        "",
      ].join("\n"),
      "utf8"
    );
    writeJson(opencodePath, {
      plugin: [
        pluginDir,
        "/somewhere/opencode-plugin",
        "opencode-wakatime",
      ],
    });
    writeJson(kiroTeamPath, {
      name: "team",
      hooks: {
        userPromptSubmit: [
          { command: 'node "C:/clawd/hooks/kiro-hook.js"' },
          { command: 'node "C:/user/hooks/keep.js"' },
        ],
      },
    });
    writeJson(kiroClawdPath, {
      name: "clawd",
      description: "customized",
      hooks: {
        stop: [{ command: 'node "C:/clawd/hooks/kiro-hook.js"' }],
      },
    });

    try {
      const result = await cleanupIntegrations({ homeDir, backup: true, silent: true, hermesCommand: false });
      assert.strictEqual(result.summary.failed, 0);
      assert.ok(result.summary.entriesRemoved >= 5);

      const codex = readJson(codexPath);
      assert.deepStrictEqual(codex.hooks.Stop, [
        { hooks: [{ type: "command", command: 'node "C:/user/hooks/keep.js"' }] },
      ]);
      assert.strictEqual(listCleanupBackups(path.dirname(codexPath)).length, 1);

      const codewhale = fs.readFileSync(codewhalePath, "utf8");
      assert.ok(!codewhale.includes("codewhale-hook.js"));
      assert.ok(codewhale.includes('command = "echo user-hook"'));

      const opencode = readJson(opencodePath);
      assert.deepStrictEqual(opencode.plugin, [
        "/somewhere/opencode-plugin",
        "opencode-wakatime",
      ]);
      assert.strictEqual(listCleanupBackups(path.dirname(opencodePath)).length, 1);

      const kiroTeam = readJson(kiroTeamPath);
      assert.deepStrictEqual(kiroTeam.hooks.userPromptSubmit, [
        { command: 'node "C:/user/hooks/keep.js"' },
      ]);
      assert.ok(fs.existsSync(kiroClawdPath), "cleanup must retain Kiro clawd.json");
      assert.deepStrictEqual(readJson(kiroClawdPath).hooks, {});
      const kiroAgent = result.agents.find((agent) => agent.agentId === "kiro-cli");
      assert.ok(kiroAgent.notes.some((note) => note.includes("clawd.json")));
      assert.deepStrictEqual(kiroAgent.warnings, []);
      assert.strictEqual(listCleanupBackups(path.dirname(kiroTeamPath)).length, 2);

      const backupCounts = {
        codex: listCleanupBackups(path.dirname(codexPath)).length,
        opencode: listCleanupBackups(path.dirname(opencodePath)).length,
        kiro: listCleanupBackups(path.dirname(kiroTeamPath)).length,
      };
      const second = await cleanupIntegrations({ homeDir, backup: true, silent: true, hermesCommand: false });
      assert.strictEqual(second.summary.failed, 0);
      assert.strictEqual(second.summary.entriesRemoved, 0);
      assert.deepStrictEqual({
        codex: listCleanupBackups(path.dirname(codexPath)).length,
        opencode: listCleanupBackups(path.dirname(opencodePath)).length,
        kiro: listCleanupBackups(path.dirname(kiroTeamPath)).length,
      }, backupCounts);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a precomputed Claude cleanup result instead of unregistering Claude a second time", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cleanup-claude-"));
    const homeDir = path.join(root, "home");
    const claudeSettingsPath = path.join(homeDir, ".claude", "settings.json");
    // A real Clawd hook that WOULD be removed if the generic claude-code
    // cleaner ran — asserting it survives proves the precomputed result path
    // is taken instead of a second, queue-external unregister.
    writeJson(claudeSettingsPath, {
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: 'node "C:/clawd/hooks/clawd-hook.js" Stop' }] }],
      },
    });

    try {
      const result = await cleanupIntegrations({
        homeDir,
        backup: true,
        silent: true,
        hermesCommand: false,
        claudeCleanupResult: { status: "ok", removed: 3, changed: true, backupPaths: ["/fake/backup.bak"] },
      });

      const claudeAgent = result.agents.find((agent) => agent.agentId === "claude-code");
      assert.strictEqual(claudeAgent.status, "applied");
      assert.strictEqual(claudeAgent.removed, 3);
      assert.deepStrictEqual(claudeAgent.backupPaths, ["/fake/backup.bak"]);
      assert.strictEqual(result.summary.entriesRemoved >= 3, true);

      const settingsAfter = readJson(claudeSettingsPath);
      assert.ok(
        settingsAfter.hooks.Stop.some((entry) => entry.hooks.some((h) => h.command.includes("clawd-hook.js"))),
        "the real settings.json must be untouched — the precomputed result replaces a second unregister call"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ── Cross-list completeness ────────────────────────────────────────────────
  // #843: cleanup kept its OWN managed list, so an agent could be added to
  // INSTALLABLE_AGENT_IDS (Settings Install/Uninstall) and to
  // MANAGED_CLEANUP_AGENT_IDS (About cleanup flips the prefs flags) while
  // cleanup-integrations silently had no cleaner for it. Every list-driven test
  // in this file iterates MANAGED_AGENT_IDS, so the gap self-certified as green:
  // the missing agent simply was not iterated. Lock the three lists together.
  it("keeps MANAGED_AGENT_IDS in lockstep with the installable and About-cleanup lists", () => {
    const managed = [...MANAGED_AGENT_IDS].sort();
    const installable = [...agentCommands.INSTALLABLE_AGENT_IDS].sort();
    const aboutCleanup = [...MANAGED_CLEANUP_AGENT_IDS].sort();

    assert.deepStrictEqual(
      managed,
      installable,
      "an agent Settings can Install/Uninstall must have a cleanup entry here — otherwise "
      + "integration-sync's real uninstall fallback returns false and the hooks stay on disk"
    );
    assert.deepStrictEqual(
      managed,
      aboutCleanup,
      "About cleanup flips integrationInstalled/enabled to false for every MANAGED_CLEANUP_AGENT_ID; "
      + "any id missing here would leave prefs claiming uninstalled while the hooks survive"
    );
  });

  it("gives every managed agent a cleaner, path overrides and a display name", () => {
    const homeDir = path.join(os.tmpdir(), "clawd-cleanup-completeness-home");
    const plan = buildCleanupOptionsForHome(homeDir, { hermesCommand: false, silent: true });

    const missingCleaner = MANAGED_AGENT_IDS.filter((id) => typeof AGENT_CLEANERS[id] !== "function");
    const missingOptions = MANAGED_AGENT_IDS.filter((id) => !plan.byAgent[id]);
    const missingDisplayName = MANAGED_AGENT_IDS.filter((id) => !AGENT_DISPLAY_NAMES[id]);

    // These three are exactly what integration-sync's real uninstall fallback
    // dereferences before it can uninstall anything.
    assert.deepStrictEqual(missingCleaner, []);
    assert.deepStrictEqual(missingOptions, []);
    assert.deepStrictEqual(missingDisplayName, []);
  });

  it("marks the claude-code agent failed when the precomputed cleanup result is an error", async () => {
    const homeDir = path.join(os.tmpdir(), "clawd-cleanup-claude-error-home");
    const result = await cleanupIntegrations({
      homeDir,
      backup: true,
      silent: true,
      hermesCommand: false,
      claudeCleanupResult: { status: "error", message: "queue disposed" },
    });

    const claudeAgent = result.agents.find((agent) => agent.agentId === "claude-code");
    assert.strictEqual(claudeAgent.status, "failed");
    assert.strictEqual(claudeAgent.error, "queue disposed");
    assert.strictEqual(result.summary.failed >= 1, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// #843 — QwenWork uninstall must close the loop all the way to disk.
//
// The PR wired qwenwork into INSTALLABLE_AGENT_IDS (Settings Install/Uninstall)
// and MANAGED_CLEANUP_AGENT_IDS (About cleanup), but not into
// cleanup-integrations. integration-sync's REAL uninstall fallback resolves its
// cleaner from AGENT_CLEANERS, so Uninstall returned
// "No automatic integration uninstall is available for qwenwork" and About
// cleanup flipped the prefs flags to false while ~/.QwenWorkCN/settings.json
// kept every Clawd hook. These tests run the real fallback — an injected fake
// uninstall impl would have passed against the broken build.
// ═════════════════════════════════════════════════════════════════════════════

describe("QwenWork integration cleanup (#843)", () => {
  const CLAWD_HOOK = (event) => `node "C:/clawd/hooks/qwenwork-hook.js" "${event}"`;
  const USER_HOOK = 'node "C:/me/hooks/my-audit.js"';
  const THIRD_PARTY_HOOK = 'node "C:/vendor/telemetry.js"';
  const IMPOSTOR_HOOK = 'node "C:/me/hooks/not-ours.js"';

  // A Clawd-owned entry written by an older build that used the PowerShell
  // -EncodedCommand wrapper: the marker only exists inside the base64 blob.
  function encodedClawdHook(event) {
    const inner = `& "node" "C:/clawd/hooks/qwenwork-hook.js" "${event}"`;
    const b64 = Buffer.from(inner, "utf16le").toString("base64");
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
  }

  function seedQwenWorkSettings(homeDir) {
    const settingsPath = path.join(homeDir, ".QwenWorkCN", "settings.json");
    writeJson(settingsPath, {
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ name: "clawd", type: "command", command: CLAWD_HOOK("PreToolUse") }] },
          { matcher: "*", hooks: [{ name: "my-audit", type: "command", command: USER_HOOK }] },
        ],
        // Mixed entry: ours shares one entry with a third-party hook. Only ours
        // may be stripped; the entry itself has to survive with the other hook.
        Stop: [
          {
            matcher: "*",
            hooks: [
              { name: "clawd", type: "command", command: CLAWD_HOOK("Stop") },
              { name: "vendor-telemetry", type: "command", command: THIRD_PARTY_HOOK },
            ],
          },
        ],
        // Legacy Clawd-owned entry (marker hidden inside -EncodedCommand).
        SessionEnd: [
          { matcher: "*", hooks: [{ name: "clawd", type: "command", command: encodedClawdHook("SessionEnd") }] },
        ],
        // A user hook that merely calls itself "clawd" — name is NOT ownership.
        Notification: [
          { matcher: "*", hooks: [{ name: "clawd", type: "command", command: IMPOSTOR_HOOK }] },
        ],
      },
      // Unrelated user config must be preserved verbatim.
      theme: "dark",
    });
    return settingsPath;
  }

  function assertOnlyClawdHooksRemoved(settingsPath) {
    const after = readJson(settingsPath);
    assert.deepStrictEqual(after.hooks.PreToolUse, [
      { matcher: "*", hooks: [{ name: "my-audit", type: "command", command: USER_HOOK }] },
    ]);
    assert.deepStrictEqual(
      after.hooks.Stop,
      [{ matcher: "*", hooks: [{ name: "vendor-telemetry", type: "command", command: THIRD_PARTY_HOOK }] }],
      "a mixed entry keeps the third-party hook and drops only the qwenwork-hook.js one"
    );
    assert.deepStrictEqual(after.hooks.SessionEnd, [], "the legacy -EncodedCommand Clawd entry is ours too");
    assert.deepStrictEqual(
      after.hooks.Notification,
      [{ matcher: "*", hooks: [{ name: "clawd", type: "command", command: IMPOSTOR_HOOK }] }],
      "a name of clawd alone must never authorize deleting a user hook"
    );
    assert.strictEqual(after.theme, "dark");
    return after;
  }

  it("cleanupIntegrations removes only marker-scoped Clawd hooks and is idempotent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cleanup-qwenwork-"));
    const homeDir = path.join(root, "home");
    const settingsPath = seedQwenWorkSettings(homeDir);
    const before = readJson(settingsPath);

    try {
      const result = await cleanupIntegrations({ homeDir, backup: true, silent: true, hermesCommand: false });
      const qwenwork = result.agents.find((entry) => entry.agentId === "qwenwork");

      assert.ok(qwenwork, "qwenwork must be one of the agents cleanup iterates");
      assert.strictEqual(qwenwork.displayName, "QwenWork");
      assert.strictEqual(qwenwork.status, "applied");
      assert.strictEqual(qwenwork.removed, 3, "PreToolUse + Stop + legacy encoded SessionEnd");
      assert.strictEqual(qwenwork.error, null);
      assert.strictEqual(qwenwork.backupPaths.length, 1);
      assert.deepStrictEqual(readJson(qwenwork.backupPaths[0]), before);
      assert.deepStrictEqual(listCleanupBackups(path.dirname(settingsPath)), [path.basename(qwenwork.backupPaths[0])]);

      assertOnlyClawdHooksRemoved(settingsPath);

      const afterFirst = fs.readFileSync(settingsPath, "utf8");
      const second = await cleanupIntegrations({ homeDir, backup: true, silent: true, hermesCommand: false });
      const qwenworkSecond = second.agents.find((entry) => entry.agentId === "qwenwork");

      assert.strictEqual(qwenworkSecond.status, "skipped");
      assert.strictEqual(qwenworkSecond.removed, 0);
      assert.deepStrictEqual(qwenworkSecond.backupPaths, []);
      assert.deepStrictEqual(listCleanupBackups(path.dirname(settingsPath)), [path.basename(qwenwork.backupPaths[0])]);
      assert.strictEqual(
        fs.readFileSync(settingsPath, "utf8"),
        afterFirst,
        "a second cleanup must not rewrite the file at all"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("integration-sync's real uninstall fallback removes the hooks from disk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-uninstall-qwenwork-"));
    const homeDir = path.join(root, "home");
    const settingsPath = seedQwenWorkSettings(homeDir);
    const before = readJson(settingsPath);

    try {
      // No uninstallIntegrationImpls: this exercises the AGENT_CLEANERS +
      // buildCleanupOptionsForHome path, which is what production uses.
      const runtime = createIntegrationSyncRuntime({
        ctx: { cleanupHomeDir: homeDir, cleanupOptions: { backup: true, hermesCommand: false } },
      });
      const result = runtime.uninstallIntegrationForAgent("qwenwork");

      assert.notStrictEqual(
        result,
        false,
        "false makes Settings report: No automatic integration uninstall is available for qwenwork"
      );
      assert.strictEqual(result.removed, 3);
      assert.strictEqual(result.changed, true);
      assert.ok(result.backupPath);
      assert.deepStrictEqual(readJson(result.backupPath), before);
      assertOnlyClawdHooksRemoved(settingsPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("Settings Uninstall returns ok and commits integrationInstalled/enabled=false", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-settings-uninstall-qwenwork-"));
    const homeDir = path.join(root, "home");
    const settingsPath = seedQwenWorkSettings(homeDir);
    const before = readJson(settingsPath);

    try {
      const runtime = createIntegrationSyncRuntime({
        ctx: { cleanupHomeDir: homeDir, cleanupOptions: { backup: true, hermesCommand: false } },
      });
      const snapshot = prefs.getDefaults();
      snapshot.agents = {
        ...snapshot.agents,
        qwenwork: { ...snapshot.agents.qwenwork, integrationInstalled: true, enabled: true },
      };

      const result = await agentCommands.uninstallAgentIntegration({ agentId: "qwenwork" }, {
        snapshot,
        uninstallIntegrationForAgent: runtime.uninstallIntegrationForAgent,
      });

      assert.strictEqual(result.status, "ok", result.message);
      assert.strictEqual(result.commit.agents.qwenwork.integrationInstalled, false);
      assert.strictEqual(result.commit.agents.qwenwork.enabled, false);
      assert.strictEqual(readJson(settingsPath).hooks.PreToolUse.length, 1);
      const backups = listCleanupBackups(path.dirname(settingsPath));
      assert.strictEqual(backups.length, 1);
      assert.deepStrictEqual(readJson(path.join(path.dirname(settingsPath), backups[0])), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("About cleanup leaves prefs and disk agreeing that QwenWork is uninstalled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-about-cleanup-qwenwork-"));
    const homeDir = path.join(root, "home");
    const settingsPath = seedQwenWorkSettings(homeDir);
    const before = readJson(settingsPath);

    try {
      const snapshot = prefs.getDefaults();
      snapshot.agents = {
        ...snapshot.agents,
        qwenwork: { ...snapshot.agents.qwenwork, integrationInstalled: true, enabled: true },
      };

      const result = await commandRegistry.cleanupIntegrations(null, {
        snapshot,
        writeCodexAutoStartGate: () => true,
        // The real cleanup, scoped to the temp home — the whole point of the
        // finding is that the prefs half used to succeed on its own.
        cleanupIntegrations: (options) => cleanupIntegrations({
          ...options,
          homeDir,
          silent: true,
          hermesCommand: false,
        }),
      });

      assert.strictEqual(result.status, "ok");
      assert.strictEqual(result.commit.agents.qwenwork.enabled, false);
      assert.strictEqual(result.commit.agents.qwenwork.integrationInstalled, false);

      const qwenwork = result.cleanup.agents.find((entry) => entry.agentId === "qwenwork");
      assert.strictEqual(qwenwork.status, "applied");
      assert.strictEqual(qwenwork.removed, 3);
      assert.strictEqual(qwenwork.backupPaths.length, 1);
      assert.deepStrictEqual(readJson(qwenwork.backupPaths[0]), before);

      const after = assertOnlyClawdHooksRemoved(settingsPath);
      assert.ok(
        !JSON.stringify(after).includes("qwenwork-hook.js"),
        "prefs said uninstalled, so no Clawd-owned QwenWork hook may survive on disk"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("Settings Install refuses invalid top-level and hooks roots, leaving prefs and disk unchanged", async () => {
    const cases = [
      { label: "top-level array", initial: [], error: /top level must be an object/ },
      { label: "hooks array", initial: { hooks: [], theme: "dark" }, error: /hooks must be an object keyed by event name/ },
    ];

    for (const testCase of cases) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-settings-install-qwenwork-invalid-"));
      const settingsPath = path.join(root, "home", ".QwenWorkCN", "settings.json");
      writeJson(settingsPath, testCase.initial);
      const before = fs.readFileSync(settingsPath, "utf8");

      try {
        const runtime = createIntegrationSyncRuntime({
          ctx: {
            syncQwenWorkHooksImpl: () => registerQwenWorkHooks({
              silent: true,
              settingsPath,
              nodeBin: process.execPath,
              platform: process.platform,
            }),
          },
        });
        const snapshot = prefs.getDefaults();
        snapshot.agents = {
          ...snapshot.agents,
          qwenwork: { ...snapshot.agents.qwenwork, integrationInstalled: false, enabled: false },
        };

        const result = await agentCommands.installAgentIntegration({ agentId: "qwenwork" }, {
          snapshot,
          syncIntegrationForAgent: runtime.syncIntegrationForAgent,
        });

        assert.strictEqual(result.status, "error", testCase.label);
        assert.match(result.message, testCase.error, testCase.label);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(result, "commit"), false, testCase.label);
        assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), before, testCase.label);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("uses ~/.QwenWorkCN/settings.json as the cleanup target", () => {
    const homeDir = path.join(os.tmpdir(), "clawd-qwenwork-plan-home");
    const plan = buildCleanupOptionsForHome(homeDir, { hermesCommand: false, silent: true });
    assert.strictEqual(plan.byAgent.qwenwork.settingsPath, path.join(homeDir, ".QwenWorkCN", "settings.json"));
  });
});
