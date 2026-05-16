// test/nano-agent-install.test.js — Verifies the nano-agent installer merges
// hooks into ~/.config/nano/config.yaml without disturbing user content.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const yaml = require("js-yaml");

const {
  HOOK_NAME_PREFIX,
  NANO_COMMAND_HOOK_EVENTS,
  NANO_HTTP_HOOK_EVENTS,
  registerNanoAgentHooks,
  unregisterNanoAgentHooks,
} = require("../hooks/nano-agent-install");

const tempDirs = [];

function makeTempConfig(initial) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-nano-"));
  const configPath = path.join(tmpDir, "config.yaml");
  if (initial !== undefined) {
    const text = typeof initial === "string" ? initial : yaml.dump(initial);
    fs.writeFileSync(configPath, text, "utf8");
  }
  tempDirs.push(tmpDir);
  return configPath;
}

function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("nano-agent installer", () => {
  it("skips silently when the config file is missing", () => {
    const result = registerNanoAgentHooks({
      silent: true,
      configPath: path.join(os.tmpdir(), "clawd-nano-missing-" + Date.now(), "config.yaml"),
    });
    assert.strictEqual(result.status, "skipped");
    assert.strictEqual(result.reason, "config-missing");
    assert.strictEqual(result.added, 0);
  });

  it("registers all command + HTTP hooks on a fresh config", () => {
    const configPath = makeTempConfig({ api_key: "test", model: "deepseek-chat" });
    const result = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      scriptPath: "/opt/clawd/hooks/nano-agent-hook.js",
      port: 23333,
    });

    const expectedCount = NANO_COMMAND_HOOK_EVENTS.length + NANO_HTTP_HOOK_EVENTS.length;
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.added, expectedCount);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 0);

    const config = readYaml(configPath);
    assert.strictEqual(config.api_key, "test");
    assert.strictEqual(config.model, "deepseek-chat");
    assert.ok(config.security && Array.isArray(config.security.hooks));
    assert.strictEqual(config.security.hooks.length, expectedCount);

    for (const ev of NANO_COMMAND_HOOK_EVENTS) {
      const entry = config.security.hooks.find((h) => h.name === `${HOOK_NAME_PREFIX}${ev}`);
      assert.ok(entry, `expected entry for ${ev}`);
      assert.strictEqual(entry.event, ev);
      assert.strictEqual(entry.type, "command");
      assert.ok(entry.command.includes("/opt/clawd/hooks/nano-agent-hook.js"));
      assert.ok(entry.command.includes("/usr/local/bin/node"));
      assert.ok(entry.enabled);
    }
    for (const ev of NANO_HTTP_HOOK_EVENTS) {
      const entry = config.security.hooks.find((h) => h.name === `${HOOK_NAME_PREFIX}${ev}`);
      assert.ok(entry, `expected entry for ${ev}`);
      assert.strictEqual(entry.type, "http");
      assert.ok(entry.http.url.includes("/permission"));
      assert.ok(entry.http.url.includes("23333"));
    }
  });

  it("is idempotent on a second run", () => {
    const configPath = makeTempConfig({});
    const opts = {
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      scriptPath: "/opt/clawd/hooks/nano-agent-hook.js",
      port: 23333,
    };
    const first = registerNanoAgentHooks(opts);
    const second = registerNanoAgentHooks(opts);
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.skipped, first.added);
  });

  it("updates stale entries when nodeBin or port changes", () => {
    const configPath = makeTempConfig({});
    registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      scriptPath: "/opt/clawd/hooks/nano-agent-hook.js",
      port: 23333,
    });
    const result = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/opt/homebrew/bin/node",
      scriptPath: "/opt/clawd/hooks/nano-agent-hook.js",
      port: 23337,
    });
    const total = NANO_COMMAND_HOOK_EVENTS.length + NANO_HTTP_HOOK_EVENTS.length;
    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, total);

    const config = readYaml(configPath);
    const cmdEntry = config.security.hooks.find((h) => h.event === "pre_tool_use");
    assert.ok(cmdEntry.command.includes("/opt/homebrew/bin/node"));
    const httpEntry = config.security.hooks.find((h) => h.event === "permission_request");
    assert.ok(httpEntry.http.url.includes("23337"));
  });

  it("preserves user-authored entries in security.hooks", () => {
    const configPath = makeTempConfig({
      security: {
        allow_rules: ["Bash(git status:*)"],
        hooks: [
          {
            name: "user-block-rm",
            event: "pre_tool_use",
            pattern: "shell:rm*",
            command: "exit 2",
            enabled: true,
          },
        ],
      },
    });
    registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      scriptPath: "/opt/clawd/hooks/nano-agent-hook.js",
    });

    const config = readYaml(configPath);
    assert.deepStrictEqual(config.security.allow_rules, ["Bash(git status:*)"]);
    const userEntry = config.security.hooks.find((h) => h.name === "user-block-rm");
    assert.ok(userEntry, "user hook must survive merge");
    assert.strictEqual(userEntry.command, "exit 2");
  });

  it("rejects an incompatible security shape", () => {
    const configPath = makeTempConfig({ security: "not-an-object" });
    const result = registerNanoAgentHooks({ silent: true, configPath });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "config-shape-incompatible");
  });

  it("remote mode prefixes commands with CLAWD_REMOTE=1", () => {
    const configPath = makeTempConfig({});
    registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/bin/node",
      scriptPath: "/home/user/.claude/hooks/nano-agent-hook.js",
      remote: true,
    });
    const config = readYaml(configPath);
    const cmd = config.security.hooks.find((h) => h.event === "pre_tool_use").command;
    assert.ok(cmd.startsWith("CLAWD_REMOTE=1 "), `expected CLAWD_REMOTE prefix, got: ${cmd}`);
    assert.ok(cmd.includes("/home/user/.claude/hooks/nano-agent-hook.js"));
  });

  it("uninstall removes only clawd-on-desk entries", () => {
    const configPath = makeTempConfig({
      security: {
        hooks: [
          { name: "user-block-rm", event: "pre_tool_use", pattern: "shell:rm*", command: "exit 2", enabled: true },
        ],
      },
    });
    registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      scriptPath: "/opt/clawd/hooks/nano-agent-hook.js",
    });
    const total = NANO_COMMAND_HOOK_EVENTS.length + NANO_HTTP_HOOK_EVENTS.length;
    const removed = unregisterNanoAgentHooks({ silent: true, configPath });
    assert.strictEqual(removed.removed, total);

    const config = readYaml(configPath);
    assert.strictEqual(config.security.hooks.length, 1);
    assert.strictEqual(config.security.hooks[0].name, "user-block-rm");
  });
});
