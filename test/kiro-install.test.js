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

  it("EXCLUDED_KEYS filtering: model/includeMcpJson absent, description always Clawd's", {
    skip: process.platform === "win32" ? "fake kiro-cli uses POSIX shell script" : false,
  }, () => {
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
    assert.strictEqual(agent.description, "Clawd desktop pet hook integration");
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

  it("formatHookCommand wraps Windows commands with PowerShell call operator", () => {
    const { __test } = require("../hooks/kiro-install");
    const { formatHookCommand } = __test;

    // mac/linux: bare quoted strings work in /bin/sh -c
    assert.strictEqual(
      formatHookCommand("/usr/local/bin/node", "/path/to/kiro-hook.js", "darwin"),
      `"/usr/local/bin/node" "/path/to/kiro-hook.js"`
    );
    assert.strictEqual(
      formatHookCommand("/usr/bin/node", "/opt/kiro-hook.js", "linux"),
      `"/usr/bin/node" "/opt/kiro-hook.js"`
    );

    // Windows: PowerShell parses bare "node" as a string literal — needs `& `
    assert.strictEqual(
      formatHookCommand("node", "D:/animation/hooks/kiro-hook.js", "win32"),
      `& "node" "D:/animation/hooks/kiro-hook.js"`
    );
  });

  it("getKiroCliCandidates returns Windows install paths on win32", () => {
    const { __test } = require("../hooks/kiro-install");
    const { getKiroCliCandidates } = __test;

    const winCandidates = getKiroCliCandidates(
      "C:\\Users\\test",
      "win32",
      { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", ProgramFiles: "C:\\Program Files" }
    );
    assert.ok(
      winCandidates.includes("C:\\Users\\test\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe"),
      "must include LOCALAPPDATA install path (default install location)"
    );
    assert.ok(
      winCandidates.includes("C:\\Program Files\\Kiro-Cli\\kiro-cli.exe"),
      "must include ProgramFiles fallback (in case installer location changes)"
    );
    assert.ok(winCandidates.includes("kiro-cli.exe"), "must keep PATH lookup");

    // posix candidates unchanged (path.join uses native sep, so reconstruct
    // the expected ~/.local/bin entry with path.join too)
    const linuxCandidates = getKiroCliCandidates("/home/test", "linux");
    assert.ok(linuxCandidates.includes(path.join("/home/test", ".local", "bin", "kiro-cli")));
    assert.ok(linuxCandidates.includes("/opt/homebrew/bin/kiro-cli"));
  });

  it("generated hook commands use PowerShell-safe format on Windows", () => {
    const { agentsDir } = makeTempKiroHome();

    registerKiroHooks({
      silent: true,
      agentsDir,
      nodeBin: "node",
      platform: "win32",
      syncClawdAgent(filePath) {
        fs.writeFileSync(
          filePath,
          JSON.stringify({ name: "clawd", description: "x", hooks: {} }, null, 2),
          "utf8"
        );
      },
    });

    const clawdAgent = readJson(path.join(agentsDir, "clawd.json"));
    for (const event of KIRO_HOOK_EVENTS) {
      const cmd = clawdAgent.hooks[event][0].command;
      assert.ok(cmd.startsWith("& "), `${event} must start with PowerShell call operator: ${cmd}`);
      assert.ok(cmd.includes("kiro-hook.js"));
    }
  });

  it("trusts the template file when EDITOR mis-fires (non-zero spawn exit)", {
    skip: process.platform === "win32" ? "fake kiro-cli uses POSIX shell" : false,
  }, () => {
    const { agentsDir } = makeTempKiroHome();
    const clawdPath = path.join(agentsDir, "clawd.json");

    // Fake kiro-cli: write the file, then exit 1 (simulates EDITOR mis-fire on Windows)
    const fakeBin = path.join(agentsDir, "fake-kiro-cli-failexit");
    const templateData = {
      name: "kiro_default",
      description: "Default agent",
      prompt: "# Survived non-zero exit",
      tools: ["*"],
      resources: ["file://README.md"],
      hooks: {},
    };
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
exit 1
`, "utf8");
    fs.chmodSync(fakeBin, 0o755);

    const { __test } = require("../hooks/kiro-install");
    const result = __test.generateClawdTemplateFromBuiltin({
      homeDir: path.dirname(agentsDir),
      kiroCliCandidates: [fakeBin],
    });

    assert.ok(result.template, "template should be returned even when fake bin exits 1");
    assert.strictEqual(result.template.prompt, "# Survived non-zero exit");
  });

  it("fallback preserves existing clawd.json when kiro-cli is unavailable", () => {
    const { agentsDir } = makeTempKiroHome();
    const clawdPath = path.join(agentsDir, "clawd.json");

    // Pre-seed a full clawd.json (simulates a prior successful sync)
    const preExisting = {
      name: "clawd",
      description: "Clawd desktop pet hook integration",
      prompt: "# Custom prompt from previous run",
      tools: ["*"],
      resources: ["file://README.md"],
      mcpServers: { foo: { command: "bar" } },
      hooks: { stop: [{ command: "node /path/to/kiro-hook.js" }] },
    };
    fs.writeFileSync(clawdPath, JSON.stringify(preExisting, null, 2), "utf8");

    const { __test } = require("../hooks/kiro-install");
    const syncResult = __test.syncClawdAgentFromBuiltin(clawdPath, {
      homeDir: path.dirname(agentsDir),
      kiroCliCandidates: ["/nonexistent/kiro-cli"],
      silent: true,
    });

    assert.ok(syncResult.synced);
    assert.strictEqual(syncResult.changed, false, "should not touch existing file");
    assert.deepStrictEqual(readJson(clawdPath), preExisting, "content must be byte-identical");
  });
});
