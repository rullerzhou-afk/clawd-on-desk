const { describe, it } = require("node:test");
const assert = require("node:assert");
const registry = require("../agents/registry");

describe("Agent Registry", () => {
  it("should return all supported agents", () => {
    const agents = registry.getAllAgents();
    const ids = agents.map((a) => a.id);
    assert.deepStrictEqual(ids, [
      "claude-code",
      "codex",
      "copilot-cli",
      "gemini-cli",
      "cursor-agent",
      "codebuddy",
      "kiro-cli",
      "kimi-cli",
      "opencode",
      "pi",
      "openclaw",
      "hermes",
    ]);
  });

  it("should look up agents by ID", () => {
    assert.strictEqual(registry.getAgent("claude-code").name, "Claude Code");
    assert.strictEqual(registry.getAgent("codex").name, "Codex CLI");
    assert.strictEqual(registry.getAgent("copilot-cli").name, "Copilot CLI");
    assert.strictEqual(registry.getAgent("gemini-cli").name, "Gemini CLI");
    assert.strictEqual(registry.getAgent("cursor-agent").name, "Cursor Agent");
    assert.strictEqual(registry.getAgent("codebuddy").name, "CodeBuddy");
    assert.strictEqual(registry.getAgent("kiro-cli").name, "Kiro CLI");
    assert.strictEqual(registry.getAgent("pi").name, "Pi");
    assert.strictEqual(registry.getAgent("openclaw").name, "OpenClaw");
    assert.strictEqual(registry.getAgent("hermes").name, "Hermes Agent");
    assert.strictEqual(registry.getAgent("nonexistent"), undefined);
  });

  it("should return correct process names for Windows", () => {
    // Temporarily mock platform if needed — just check the data structure
    const cc = registry.getAgent("claude-code");
    assert.deepStrictEqual(cc.processNames.win, ["claude.exe"]);
    assert.deepStrictEqual(cc.processNames.mac, ["claude"]);

    const codex = registry.getAgent("codex");
    assert.deepStrictEqual(codex.processNames.win, ["codex.exe"]);

    const copilot = registry.getAgent("copilot-cli");
    assert.deepStrictEqual(copilot.processNames.win, ["copilot.exe"]);

    const gemini = registry.getAgent("gemini-cli");
    assert.deepStrictEqual(gemini.processNames.win, ["gemini.exe"]);

    const cursor = registry.getAgent("cursor-agent");
    assert.deepStrictEqual(cursor.processNames.win, ["Cursor.exe"]);

    const pi = registry.getAgent("pi");
    assert.deepStrictEqual(pi.processNames.win, ["pi.exe"]);

    const openclaw = registry.getAgent("openclaw");
    assert.deepStrictEqual(openclaw.processNames.win, []);

    const hermes = registry.getAgent("hermes");
    assert.deepStrictEqual(hermes.processNames.win, ["hermes.exe"]);
  });

  it("should include explicit Linux process names", () => {
    const cc = registry.getAgent("claude-code");
    assert.deepStrictEqual(cc.processNames.linux, ["claude"]);

    const codex = registry.getAgent("codex");
    assert.deepStrictEqual(codex.processNames.linux, ["codex"]);

    const copilot = registry.getAgent("copilot-cli");
    assert.deepStrictEqual(copilot.processNames.linux, ["copilot"]);

    const gemini = registry.getAgent("gemini-cli");
    assert.deepStrictEqual(gemini.processNames.linux, ["gemini"]);

    const cursor = registry.getAgent("cursor-agent");
    assert.deepStrictEqual(cursor.processNames.linux, ["cursor", "Cursor"]);

    const kiro = registry.getAgent("kiro-cli");
    assert.deepStrictEqual(kiro.processNames.linux, ["kiro-cli"]);

    const pi = registry.getAgent("pi");
    assert.deepStrictEqual(pi.processNames.linux, ["pi"]);

    const openclaw = registry.getAgent("openclaw");
    assert.deepStrictEqual(openclaw.processNames.linux, []);

    const hermes = registry.getAgent("hermes");
    assert.deepStrictEqual(hermes.processNames.linux, ["hermes"]);
  });

  it("should keep Kiro CLI process names narrowed to kiro-cli only", () => {
    const kiro = registry.getAgent("kiro-cli");
    assert.deepStrictEqual(kiro.processNames.win, ["kiro-cli.exe"]);
    assert.deepStrictEqual(kiro.processNames.mac, ["kiro-cli"]);
    assert.deepStrictEqual(kiro.processNames.linux, ["kiro-cli"]);
  });

  it("should aggregate all process names", () => {
    const all = registry.getAllProcessNames();
    assert.ok(all.length >= 5);
    const names = all.map((p) => p.name);
    // Should contain at least one entry per agent (platform-dependent)
    const agentIds = [...new Set(all.map((p) => p.agentId))];
    assert.ok(agentIds.includes("claude-code"));
    assert.ok(agentIds.includes("codex"));
    assert.ok(agentIds.includes("copilot-cli"));
    assert.ok(agentIds.includes("gemini-cli"));
    assert.ok(agentIds.includes("cursor-agent"));
    assert.ok(agentIds.includes("kiro-cli"));
    assert.ok(agentIds.includes("pi"));
    assert.ok(agentIds.includes("pi"));
    assert.ok(agentIds.includes("hermes"));
  });

  it("should have correct capabilities", () => {
    const cc = registry.getAgent("claude-code");
    assert.strictEqual(cc.capabilities.httpHook, true);
    assert.strictEqual(cc.capabilities.permissionApproval, true);
    assert.strictEqual(cc.capabilities.sessionEnd, true);
    assert.strictEqual(cc.capabilities.subagent, true);

    const codex = registry.getAgent("codex");
    assert.strictEqual(codex.capabilities.httpHook, false);
    assert.strictEqual(codex.capabilities.permissionApproval, true);
    assert.strictEqual(codex.capabilities.sessionEnd, false);
    assert.strictEqual(codex.capabilities.subagent, false);

    const copilot = registry.getAgent("copilot-cli");
    assert.strictEqual(copilot.capabilities.httpHook, false);
    assert.strictEqual(copilot.capabilities.permissionApproval, false);
    assert.strictEqual(copilot.capabilities.sessionEnd, true);
    assert.strictEqual(copilot.capabilities.subagent, true);

    const gemini = registry.getAgent("gemini-cli");
    assert.strictEqual(gemini.capabilities.httpHook, false);
    assert.strictEqual(gemini.capabilities.permissionApproval, false);
    assert.strictEqual(gemini.capabilities.notificationHook, true);
    assert.strictEqual(gemini.capabilities.sessionEnd, true);
    assert.strictEqual(gemini.capabilities.subagent, false);

    const cursor = registry.getAgent("cursor-agent");
    assert.strictEqual(cursor.capabilities.httpHook, false);
    assert.strictEqual(cursor.capabilities.permissionApproval, false);
    assert.strictEqual(cursor.capabilities.sessionEnd, true);
    assert.strictEqual(cursor.capabilities.subagent, true);

    const kiro = registry.getAgent("kiro-cli");
    assert.strictEqual(kiro.capabilities.httpHook, false);
    assert.strictEqual(kiro.capabilities.permissionApproval, false);
    assert.strictEqual(kiro.capabilities.sessionEnd, false);
    assert.strictEqual(kiro.capabilities.subagent, false);

    const pi = registry.getAgent("pi");
    assert.strictEqual(pi.capabilities.httpHook, false);
    assert.strictEqual(pi.capabilities.permissionApproval, true);
    assert.strictEqual(pi.capabilities.interactiveBubble, true);
    assert.strictEqual(pi.capabilities.sessionEnd, true);
    assert.strictEqual(pi.capabilities.subagent, false);

    const openclaw = registry.getAgent("openclaw");
    assert.strictEqual(openclaw.capabilities.httpHook, false);
    assert.strictEqual(openclaw.capabilities.permissionApproval, false);
    assert.strictEqual(openclaw.capabilities.interactiveBubble, false);
    assert.strictEqual(openclaw.capabilities.notificationHook, false);
    assert.strictEqual(openclaw.capabilities.sessionEnd, true);
    assert.strictEqual(openclaw.capabilities.subagent, false);

    const hermes = registry.getAgent("hermes");
    assert.strictEqual(hermes.capabilities.httpHook, false);
    assert.strictEqual(hermes.capabilities.permissionApproval, false);
    assert.strictEqual(hermes.capabilities.interactiveBubble, false);
    assert.strictEqual(hermes.capabilities.sessionEnd, true);
    assert.strictEqual(hermes.capabilities.subagent, false);
  });

  it("should have eventMap for hook-based agents", () => {
    const cc = registry.getAgent("claude-code");
    assert.strictEqual(cc.eventMap.SessionStart, "idle");
    assert.strictEqual(cc.eventMap.PreToolUse, "working");
    assert.strictEqual(cc.eventMap.Stop, "attention");

    const copilot = registry.getAgent("copilot-cli");
    assert.strictEqual(copilot.eventMap.sessionStart, "idle");
    assert.strictEqual(copilot.eventMap.preToolUse, "working");
    assert.strictEqual(copilot.eventMap.agentStop, "attention");

    const gemini = registry.getAgent("gemini-cli");
    assert.strictEqual(gemini.eventMap.SessionStart, "idle");
    assert.strictEqual(gemini.eventMap.BeforeTool, "working");
    assert.strictEqual(gemini.eventMap.AfterAgent, "idle");
    assert.strictEqual(gemini.eventMap.PreCompress, "idle");

    const cursor = registry.getAgent("cursor-agent");
    assert.strictEqual(cursor.eventMap.sessionStart, "idle");
    assert.strictEqual(cursor.eventMap.preToolUse, "working");
    assert.strictEqual(cursor.eventMap.afterAgentThought, "thinking");
    assert.strictEqual(cursor.eventMap.stop, "attention");

    const pi = registry.getAgent("pi");
    assert.strictEqual(pi.eventSource, "extension");
    assert.strictEqual(pi.eventMap.SessionStart, "idle");
    assert.strictEqual(pi.eventMap.UserPromptSubmit, "thinking");
    assert.strictEqual(pi.eventMap.PostToolUseFailure, "error");
    assert.strictEqual(pi.eventMap.PreCompact, "sweeping");

    const openclaw = registry.getAgent("openclaw");
    assert.strictEqual(openclaw.eventSource, "plugin-event");
    assert.strictEqual(openclaw.eventMap.SessionStart, "idle");
    assert.strictEqual(openclaw.eventMap.UserPromptSubmit, "thinking");
    assert.strictEqual(openclaw.eventMap.PostToolUseFailure, "error");
    assert.strictEqual(openclaw.eventMap.PreCompact, "sweeping");

    const hermes = registry.getAgent("hermes");
    assert.strictEqual(hermes.eventMap.SessionStart, "idle");
    assert.strictEqual(hermes.eventMap.PreToolUse, "working");
    assert.strictEqual(hermes.eventMap.Stop, "attention");
    assert.strictEqual(hermes.eventMap.SessionEnd, "sleeping");
  });

  it("treats Gemini CLI as a hook-only agent", () => {
    const gemini = registry.getAgent("gemini-cli");

    assert.strictEqual(gemini.eventSource, "hook");
    assert.ok(gemini.hookConfig);
    assert.strictEqual(gemini.hookConfig.configFormat, "gemini-settings-json");
    assert.strictEqual(gemini.logConfig, undefined);
  });

  it("should have logEventMap for poll-based agents", () => {
    const codex = registry.getAgent("codex");
    assert.strictEqual(codex.logEventMap["session_meta"], "idle");
    assert.strictEqual(codex.logEventMap["event_msg:task_started"], "thinking");
    assert.strictEqual(codex.logEventMap["event_msg:guardian_assessment"], "working");
    assert.strictEqual(codex.logEventMap["event_msg:exec_command_end"], "working");
    assert.strictEqual(codex.logEventMap["event_msg:patch_apply_end"], "working");
    assert.strictEqual(codex.logEventMap["event_msg:custom_tool_call_output"], "working");
    assert.strictEqual(codex.logEventMap["event_msg:task_complete"], "codex-turn-end");
    assert.strictEqual(codex.logEventMap["event_msg:turn_aborted"], "idle");
  });
});
