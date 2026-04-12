const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { registerKiroHooks, KIRO_HOOK_EVENTS } = require("../hooks/kiro-install");

const tempDirs = [];

function makeTempKiroHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kiro-"));
  const agentsDir = path.join(root, ".kiro", "agents");
  const settingsPath = path.join(root, ".kiro", "settings", "cli.json");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  tempDirs.push(root);
  return { root, agentsDir, settingsPath };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Kiro hook installer", () => {
  it("creates clawd.json from kiro_default template without changing cli settings", () => {
    const { agentsDir, settingsPath } = makeTempKiroHome();

    const result = registerKiroHooks({
      silent: true,
      agentsDir,
      nodeBin: "/usr/local/bin/node",
      syncClawdAgent(filePath) {
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            name: "clawd",
            description: "Default agent",
            prompt: "# Kiro CLI Default Agent",
            mcpServers: {},
            tools: ["*"],
            toolAliases: {},
            allowedTools: [],
            resources: [
              "file://AmazonQ.md",
              "file://AGENTS.md",
              "file://README.md",
            ],
            hooks: {},
            toolsSettings: {},
            includeMcpJson: true,
            model: null,
          }, null, 2),
          "utf8"
        );
      },
    });

    const clawdPath = path.join(agentsDir, "clawd.json");
    assert.ok(fs.existsSync(clawdPath));

    const clawdAgent = readJson(clawdPath);
    assert.strictEqual(clawdAgent.name, "clawd");
    assert.strictEqual(clawdAgent.description, "Default agent");
    assert.strictEqual(clawdAgent.prompt, "# Kiro CLI Default Agent");
    assert.deepStrictEqual(clawdAgent.tools, ["*"]);
    assert.deepStrictEqual(clawdAgent.resources, [
      "file://AmazonQ.md",
      "file://AGENTS.md",
      "file://README.md",
    ]);
    assert.strictEqual(clawdAgent.includeMcpJson, true);
    assert.strictEqual(clawdAgent.model, null);
    for (const event of KIRO_HOOK_EVENTS) {
      assert.ok(Array.isArray(clawdAgent.hooks[event]), `missing hooks for ${event}`);
      assert.strictEqual(clawdAgent.hooks[event].length, 1);
      assert.ok(clawdAgent.hooks[event][0].command.includes("kiro-hook.js"));
      assert.ok(clawdAgent.hooks[event][0].command.includes("/usr/local/bin/node"));
    }

    assert.strictEqual(fs.existsSync(settingsPath), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result, "defaultAgentUpdated"), false);
  });

  it("preserves existing cli settings untouched", () => {
    const { agentsDir, settingsPath } = makeTempKiroHome();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ chat: { defaultAgent: "team-agent" } }, null, 2),
      "utf8"
    );
    fs.writeFileSync(
      path.join(agentsDir, "team-agent.json"),
      JSON.stringify({ name: "team-agent", description: "Team agent" }, null, 2),
      "utf8"
    );

    const result = registerKiroHooks({
      silent: true,
      agentsDir,
      nodeBin: "/usr/local/bin/node",
    });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.chat.defaultAgent, "team-agent");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result, "defaultAgentUpdated"), false);

    const teamAgent = readJson(path.join(agentsDir, "team-agent.json"));
    for (const event of KIRO_HOOK_EVENTS) {
      assert.strictEqual(teamAgent.hooks[event].length, 1);
      assert.ok(teamAgent.hooks[event][0].command.includes("kiro-hook.js"));
    }
  });

  it("reseeds legacy hook-only clawd agent from kiro_default template", () => {
    const { agentsDir } = makeTempKiroHome();
    const clawdPath = path.join(agentsDir, "clawd.json");
    fs.writeFileSync(
      clawdPath,
      JSON.stringify({
        name: "clawd",
        description: "Clawd desktop pet hook integration",
        hooks: {
          stop: [{ command: "\"/old/node\" \"/old/path/kiro-hook.js\"" }],
        },
      }, null, 2),
      "utf8"
    );

    registerKiroHooks({
      silent: true,
      agentsDir,
      nodeBin: "/usr/local/bin/node",
      syncClawdAgent(filePath) {
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            name: "clawd",
            description: "Default agent",
            prompt: "# Kiro CLI Default Agent",
            tools: ["*"],
            resources: ["file://README.md"],
            hooks: {},
            includeMcpJson: true,
            model: null,
          }, null, 2),
          "utf8"
        );
      },
    });

    const clawdAgent = readJson(clawdPath);
    assert.strictEqual(clawdAgent.description, "Default agent");
    assert.strictEqual(clawdAgent.prompt, "# Kiro CLI Default Agent");
    assert.deepStrictEqual(clawdAgent.tools, ["*"]);
    assert.deepStrictEqual(clawdAgent.resources, ["file://README.md"]);
    assert.strictEqual(clawdAgent.hooks.stop.length, 1);
    assert.ok(clawdAgent.hooks.stop[0].command.includes("kiro-hook.js"));
    assert.ok(!clawdAgent.hooks.stop[0].command.includes("/old/path/"));
  });

  it("updates stale hook paths without duplicating entries", () => {
    const { agentsDir, settingsPath } = makeTempKiroHome();
    const clawdPath = path.join(agentsDir, "clawd.json");
    fs.writeFileSync(
      clawdPath,
      JSON.stringify({
        name: "clawd",
        description: "Clawd desktop pet hook integration",
        hooks: {
          stop: [{ command: "\"/old/node\" \"/old/path/kiro-hook.js\"" }],
          preToolUse: [
            { command: "\"/old/node\" \"/old/path/kiro-hook.js\"" },
          ],
        },
      }, null, 2),
      "utf8"
    );

    const result = registerKiroHooks({
      silent: true,
      agentsDir,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      syncClawdAgent(filePath) {
        // Preserve existing content — sync is not the focus of this test
        const current = readJson(filePath);
        return { synced: true, changed: false };
      },
    });

    const clawdAgent = readJson(clawdPath);
    assert.strictEqual(result.updated, 2);
    assert.strictEqual(clawdAgent.hooks.stop.length, 1);
    assert.ok(clawdAgent.hooks.stop[0].command.includes("/usr/local/bin/node"));
    assert.ok(clawdAgent.hooks.stop[0].command.includes("hooks/kiro-hook.js"));
    assert.ok(!clawdAgent.hooks.stop[0].command.includes("/old/path/"));
  });

  it("re-syncs clawd.json from the latest kiro_default template on every run", () => {
    const { agentsDir } = makeTempKiroHome();
    const clawdPath = path.join(agentsDir, "clawd.json");
    fs.writeFileSync(
      clawdPath,
      JSON.stringify({
        name: "clawd",
        description: "Old default agent",
        prompt: "outdated",
        tools: ["old-tool"],
        resources: ["file://OLD.md"],
        hooks: {
          stop: [{ command: "\"/usr/local/bin/node\" \"/tmp/kiro-hook.js\"" }],
        },
        includeMcpJson: false,
        model: "old-model",
      }, null, 2),
      "utf8"
    );

    const result = registerKiroHooks({
      silent: true,
      agentsDir,
      nodeBin: "/usr/local/bin/node",
      syncClawdAgent(filePath) {
        const current = readJson(filePath);
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            name: "clawd",
            description: "Default agent",
            prompt: "# Kiro CLI Default Agent",
            tools: ["*"],
            resources: ["file://README.md"],
            hooks: current.hooks || {},
            includeMcpJson: true,
            model: null,
          }, null, 2),
          "utf8"
        );
        return { synced: true, changed: true };
      },
    });

    const clawdAgent = readJson(clawdPath);
    assert.strictEqual(clawdAgent.description, "Default agent");
    assert.strictEqual(clawdAgent.prompt, "# Kiro CLI Default Agent");
    assert.deepStrictEqual(clawdAgent.tools, ["*"]);
    assert.deepStrictEqual(clawdAgent.resources, ["file://README.md"]);
    assert.strictEqual(clawdAgent.includeMcpJson, true);
    assert.strictEqual(clawdAgent.model, null);
    assert.ok(result.updated >= 1);
    assert.ok(clawdAgent.hooks.stop[0].command.includes("hooks/kiro-hook.js"));
  });

  it("EXCLUDED_KEYS filtering: model/includeMcpJson/description absent in real syncClawdAgentFromBuiltin", () => {
    const { agentsDir } = makeTempKiroHome();
    const clawdPath = path.join(agentsDir, "clawd.json");

    // Create a fake kiro-cli script that writes a template JSON
    const fakeBin = path.join(agentsDir, "fake-kiro-cli");
    const templateDir = path.join(agentsDir, "_template_out");
    fs.mkdirSync(templateDir, { recursive: true });
    const templateData = {
      name: "kiro_default",
      description: "Default agent",
      prompt: "# Default prompt",
      model: "claude-sonnet-4-20250514",
      includeMcpJson: true,
      tools: ["*"],
      resources: ["file://README.md"],
      mcpServers: { foo: { command: "bar" } },
      hooks: {},
    };
    // Fake script: on "agent create", write template JSON to the specified directory
    fs.writeFileSync(fakeBin, `#!/bin/sh
if [ "$1" = "agent" ] && [ "$2" = "create" ]; then
  name="$3"
  shift 3
  dir=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --directory) dir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cat > "$dir/$name.json" << 'TEMPLATE'
${JSON.stringify(templateData, null, 2)}
TEMPLATE
fi
`, "utf8");
    fs.chmodSync(fakeBin, 0o755);

    const { __test } = require("../hooks/kiro-install");
    const syncResult = __test.syncClawdAgentFromBuiltin(clawdPath, {
      homeDir: path.dirname(agentsDir),
      kiroCliCandidates: [fakeBin],
      silent: true,
    });

    assert.ok(syncResult.synced);
    assert.ok(fs.existsSync(clawdPath));

    const agent = readJson(clawdPath);
    // Name is always overridden to "clawd"
    assert.strictEqual(agent.name, "clawd");
    // Prompt, tools, resources, mcpServers should pass through
    assert.strictEqual(agent.prompt, "# Default prompt");
    assert.deepStrictEqual(agent.tools, ["*"]);
    assert.deepStrictEqual(agent.resources, ["file://README.md"]);
    assert.deepStrictEqual(agent.mcpServers, { foo: { command: "bar" } });
    // EXCLUDED_KEYS must NOT appear
    assert.strictEqual(Object.prototype.hasOwnProperty.call(agent, "model"), false,
      "model should be excluded");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(agent, "includeMcpJson"), false,
      "includeMcpJson should be excluded");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(agent, "description"), false,
      "description should be excluded");
    // hooks is in EXCLUDED_KEYS (skipped from template copy) but restored from
    // current config; since no prior file existed, it should be an empty object.
    assert.deepStrictEqual(agent.hooks, {});
  });

  it("fallback to minimal agent when kiro-cli is unavailable", () => {
    const { agentsDir } = makeTempKiroHome();
    const clawdPath = path.join(agentsDir, "clawd.json");

    const { __test } = require("../hooks/kiro-install");
    const syncResult = __test.syncClawdAgentFromBuiltin(clawdPath, {
      homeDir: path.dirname(agentsDir),
      kiroCliCandidates: ["/nonexistent/kiro-cli"],
      silent: true,
    });

    assert.ok(syncResult.synced);
    assert.ok(fs.existsSync(clawdPath));

    const agent = readJson(clawdPath);
    assert.strictEqual(agent.name, "clawd");
    assert.strictEqual(agent.description, "Clawd desktop pet hook integration");
    // No prompt/tools/resources in fallback
    assert.strictEqual(Object.prototype.hasOwnProperty.call(agent, "prompt"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(agent, "tools"), false);
  });
});
