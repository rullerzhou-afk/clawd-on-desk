const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  MANAGED_AGENT_IDS,
  buildCleanupOptionsForHome,
  cleanupIntegrations,
} = require("../hooks/cleanup-integrations");
const { resolvePluginDir } = require("../hooks/opencode-install");

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
    assert.strictEqual(plan.env.LOCALAPPDATA, targetLocalAppData);
    assert.strictEqual(plan.env.APPDATA, targetAppData);
    assert.strictEqual(plan.env.HERMES_HOME, undefined);
    assert.strictEqual(plan.byAgent.hermes.env.LOCALAPPDATA, targetLocalAppData);
    assert.notStrictEqual(plan.byAgent.hermes.hermesHome, path.join(inheritedLocalAppData, "hermes"));
  });

  it("removes managed hooks/plugins safely, backs up once, and is idempotent", () => {
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
      const result = cleanupIntegrations({ homeDir, backup: true, silent: true, hermesCommand: false });
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
      const second = cleanupIntegrations({ homeDir, backup: true, silent: true, hermesCommand: false });
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

  it("records a precomputed Claude cleanup result instead of unregistering Claude a second time", () => {
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
      const result = cleanupIntegrations({
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

  it("marks the claude-code agent failed when the precomputed cleanup result is an error", () => {
    const homeDir = path.join(os.tmpdir(), "clawd-cleanup-claude-error-home");
    const result = cleanupIntegrations({
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
