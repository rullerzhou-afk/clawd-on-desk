const { describe, it } = require("node:test");
const assert = require("node:assert");
const registry = require("../agents/registry");

describe("Agent Registry", () => {
  it("should return all supported agents", () => {
    const agents = registry.getAllAgents();
    const ids = agents.map((a) => a.id);
    assert.deepStrictEqual(ids, [
      "claude-code",
      "deepseek-harness",
      "codex",
      "copilot-cli",
      "gemini-cli",
      "antigravity-cli",
      "cursor-agent",
      "codebuddy",
      "kiro-cli",
      "kimi-cli",
      "qwen-code",
      "zcode",
      "codewhale",
      "opencode",
      "mimocode",
      "pi",
      "openclaw",
      "hermes",
      "qoder",
      "reasonix",
      "qoderwork",
      "qwenwork",
      "workbuddy",
    ]);
  });

  it("should look up agents by ID", () => {
    assert.strictEqual(registry.getAgent("claude-code").name, "Claude Code");
    assert.strictEqual(registry.getAgent("deepseek-harness").name, "DeepSeek Harness (web, experimental)");
    assert.strictEqual(registry.getAgent("codex").name, "Codex CLI");
    assert.strictEqual(registry.getAgent("copilot-cli").name, "Copilot CLI");
    assert.strictEqual(registry.getAgent("gemini-cli").name, "Gemini CLI");
    assert.strictEqual(registry.getAgent("antigravity-cli").name, "Antigravity CLI");
    assert.strictEqual(registry.getAgent("cursor-agent").name, "Cursor Agent");
    assert.strictEqual(registry.getAgent("codebuddy").name, "CodeBuddy");
    assert.strictEqual(registry.getAgent("kiro-cli").name, "Kiro CLI");
    assert.strictEqual(registry.getAgent("qwen-code").name, "Qwen Code");
    assert.strictEqual(registry.getAgent("codewhale").name, "CodeWhale");
    assert.strictEqual(registry.getAgent("pi").name, "Pi");
    assert.strictEqual(registry.getAgent("openclaw").name, "OpenClaw");
    assert.strictEqual(registry.getAgent("hermes").name, "Hermes Agent");
    assert.strictEqual(registry.getAgent("qoder").name, "Qoder");
    assert.strictEqual(registry.getAgent("reasonix").name, "Reasonix");
    assert.strictEqual(registry.getAgent("qoderwork").name, "QoderWork");
    assert.strictEqual(registry.getAgent("qwenwork").name, "QwenWork");
    assert.strictEqual(registry.getAgent("workbuddy").name, "WorkBuddy");
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

    const antigravity = registry.getAgent("antigravity-cli");
    assert.deepStrictEqual(antigravity.processNames.win, ["agy.exe"]);

    const cursor = registry.getAgent("cursor-agent");
    assert.deepStrictEqual(cursor.processNames.win, ["Cursor.exe"]);

    const pi = registry.getAgent("pi");
    assert.deepStrictEqual(pi.processNames.win, ["pi.exe"]);

    const openclaw = registry.getAgent("openclaw");
    assert.deepStrictEqual(openclaw.processNames.win, []);

    const hermes = registry.getAgent("hermes");
    assert.deepStrictEqual(hermes.processNames.win, ["hermes.exe"]);

    const qwen = registry.getAgent("qwen-code");
    assert.deepStrictEqual(qwen.processNames.win, ["qwen.exe"]);

    const codewhale = registry.getAgent("codewhale");
    assert.deepStrictEqual(codewhale.processNames.win, ["codewhale.exe"]);

    const qoder = registry.getAgent("qoder");
    assert.deepStrictEqual(qoder.processNames.win, ["qoder.exe", "qodercli.exe", "qoder-cli.exe"]);

    const reasonix = registry.getAgent("reasonix");
    assert.deepStrictEqual(reasonix.processNames.win, ["reasonix.exe", "reasonix-desktop.exe", "reasonix-cli.exe"]);

    const qoderwork = registry.getAgent("qoderwork");
    assert.deepStrictEqual(qoderwork.processNames.win, ["QoderWork.exe"]);

    const qwenwork = registry.getAgent("qwenwork");
    assert.deepStrictEqual(qwenwork.processNames.win, ["QwenWorkCN.exe"]);

    const workbuddy = registry.getAgent("workbuddy");
    assert.deepStrictEqual(workbuddy.processNames.win, ["WorkBuddy.exe", "workbuddy.exe"]);
    assert.deepStrictEqual(workbuddy.processNames.mac.slice(0, 2), [
      "WorkBuddy AI Helper",
      "WorkBuddy AI Helper (Renderer)",
    ]);
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

    const antigravity = registry.getAgent("antigravity-cli");
    assert.deepStrictEqual(antigravity.processNames.linux, ["agy"]);

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

    const qwen = registry.getAgent("qwen-code");
    assert.deepStrictEqual(qwen.processNames.linux, ["qwen"]);

    const codewhale = registry.getAgent("codewhale");
    assert.deepStrictEqual(codewhale.processNames.linux, ["codewhale"]);

    const qoder = registry.getAgent("qoder");
    assert.deepStrictEqual(qoder.processNames.linux, ["qoder", "qodercli", "qoder-cli"]);

    const reasonix = registry.getAgent("reasonix");
    assert.deepStrictEqual(reasonix.processNames.linux, ["reasonix", "reasonix-desktop"]);

    const qoderwork = registry.getAgent("qoderwork");
    assert.deepStrictEqual(qoderwork.processNames.linux, ["QoderWork"]);

    // #843: QwenWork ships macOS 14+ / Windows 10+ / HarmonyOS 6.1+ only
    // (https://qwenwork.cn/download). There is no Linux client, so the list is
    // deliberately empty rather than a speculative executable name.
    const qwenwork = registry.getAgent("qwenwork");
    assert.deepStrictEqual(qwenwork.processNames.linux, []);
    assert.deepStrictEqual(qwenwork.processNames.mac, ["QwenWorkCN", "千问办公"]);

    const workbuddy = registry.getAgent("workbuddy");
    assert.deepStrictEqual(workbuddy.processNames.linux, ["workbuddy", "WorkBuddy"]);
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
    assert.ok(agentIds.includes("antigravity-cli"));
    assert.ok(agentIds.includes("cursor-agent"));
    assert.ok(agentIds.includes("kiro-cli"));
    assert.ok(agentIds.includes("qwen-code"));
    assert.ok(agentIds.includes("codewhale"));
    assert.ok(agentIds.includes("pi"));
    assert.ok(agentIds.includes("pi"));
    assert.ok(agentIds.includes("hermes"));
  });

  it("requires every agent to declare an explicit startup recovery surface", () => {
    for (const agent of registry.getAllAgents()) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(agent, "startupRecoveryProcessNames"),
        `${agent.id} must explicitly declare startupRecoveryProcessNames`
      );
      for (const platform of ["win", "mac", "linux"]) {
        assert.ok(
          Array.isArray(agent.startupRecoveryProcessNames[platform]),
          `${agent.id} must declare startupRecoveryProcessNames.${platform}`
        );
      }
    }

    const startupAgentIds = new Set(
      registry.getStartupRecoveryProcessNames().map((entry) => entry.agentId)
    );
    assert.ok(startupAgentIds.has("mimocode"));
    assert.ok(startupAgentIds.has("qwen-code"));
    assert.ok(startupAgentIds.has("reasonix"));
    assert.ok(!startupAgentIds.has("cursor-agent"));
    assert.ok(!startupAgentIds.has("qoderwork"));
    assert.ok(!startupAgentIds.has("qwenwork"));
    assert.ok(!startupAgentIds.has("workbuddy"));

    // ZCode keeps only the unambiguous legacy `zcode-cli` in pure-name startup
    // recovery. Current macOS/Windows Electron Node-mode runtimes are matched
    // separately by the `zcode.cjs` command-line marker, never by the bare GUI
    // executable name.
    const zcode = registry.getAgent("zcode");
    assert.deepStrictEqual(zcode.startupRecoveryProcessNames, {
      win: [],
      mac: ["zcode-cli"],
      linux: ["zcode-cli"],
    });
  });

  it("keeps ambiguous GUI and POSIX process names out of startup recovery", () => {
    assert.deepStrictEqual(
      registry.getAgent("cursor-agent").startupRecoveryProcessNames,
      { win: [], mac: [], linux: [] }
    );
    assert.deepStrictEqual(
      registry.getAgent("qoderwork").startupRecoveryProcessNames,
      { win: [], mac: [], linux: [] }
    );
    assert.deepStrictEqual(
      registry.getAgent("qwenwork").startupRecoveryProcessNames,
      { win: [], mac: [], linux: [] }
    );
    assert.deepStrictEqual(
      registry.getAgent("workbuddy").startupRecoveryProcessNames,
      { win: [], mac: [], linux: [] }
    );
    assert.deepStrictEqual(
      registry.getAgent("pi").startupRecoveryProcessNames,
      { win: ["pi.exe"], mac: [], linux: [] }
    );
    assert.deepStrictEqual(
      registry.getAgent("qoder").startupRecoveryProcessNames.win,
      ["qodercli.exe", "qoder-cli.exe"]
    );
    assert.deepStrictEqual(
      registry.getAgent("reasonix").startupRecoveryProcessNames,
      { win: ["reasonix.exe", "reasonix-cli.exe"], mac: ["reasonix"], linux: ["reasonix"] }
    );
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
    assert.strictEqual(copilot.capabilities.permissionApproval, true);
    assert.strictEqual(copilot.capabilities.interactiveBubble, true);
    assert.strictEqual(copilot.capabilities.sessionEnd, true);
    assert.strictEqual(copilot.capabilities.subagent, true);

    const gemini = registry.getAgent("gemini-cli");
    assert.strictEqual(gemini.capabilities.httpHook, false);
    assert.strictEqual(gemini.capabilities.permissionApproval, false);
    assert.strictEqual(gemini.capabilities.notificationHook, true);
    assert.strictEqual(gemini.capabilities.sessionEnd, true);
    assert.strictEqual(gemini.capabilities.subagent, false);

    const antigravity = registry.getAgent("antigravity-cli");
    assert.strictEqual(antigravity.capabilities.httpHook, false);
    // D2: state-only integration, agy native menu owns permission flow.
    assert.strictEqual(antigravity.capabilities.permissionApproval, false);
    assert.strictEqual(antigravity.capabilities.interactiveBubble, false);
    assert.strictEqual(antigravity.capabilities.notificationHook, false);
    assert.strictEqual(antigravity.capabilities.sessionEnd, true);
    assert.strictEqual(antigravity.capabilities.subagent, true);

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
    assert.strictEqual(pi.capabilities.permissionApproval, false);
    assert.strictEqual(pi.capabilities.interactiveBubble, false);
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
    assert.strictEqual(hermes.capabilities.permissionApproval, true);
    assert.strictEqual(hermes.capabilities.interactiveBubble, true);
    assert.strictEqual(hermes.capabilities.sessionEnd, true);
    assert.strictEqual(hermes.capabilities.subagent, false);

    const qwen = registry.getAgent("qwen-code");
    assert.strictEqual(qwen.capabilities.httpHook, false);
    assert.strictEqual(qwen.capabilities.permissionApproval, true);
    assert.strictEqual(qwen.capabilities.interactiveBubble, true);
    assert.strictEqual(qwen.capabilities.notificationHook, true);
    assert.strictEqual(qwen.capabilities.sessionEnd, true);
    assert.strictEqual(qwen.capabilities.subagent, false);

    const codewhale = registry.getAgent("codewhale");
    assert.strictEqual(codewhale.capabilities.httpHook, false);
    assert.strictEqual(codewhale.capabilities.permissionApproval, false);
    assert.strictEqual(codewhale.capabilities.interactiveBubble, false);
    assert.strictEqual(codewhale.capabilities.notificationHook, true);
    assert.strictEqual(codewhale.capabilities.sessionEnd, true);
    assert.strictEqual(codewhale.capabilities.subagent, false);

    const qoder = registry.getAgent("qoder");
    assert.strictEqual(qoder.capabilities.httpHook, false);
    // Phase 1 state-only: no permission approval, no interactive bubble.
    assert.strictEqual(qoder.capabilities.permissionApproval, false);
    assert.strictEqual(qoder.capabilities.interactiveBubble, false);
    assert.strictEqual(qoder.capabilities.notificationHook, true);
    assert.strictEqual(qoder.capabilities.sessionEnd, true);
    assert.strictEqual(qoder.capabilities.subagent, false);

    const reasonix = registry.getAgent("reasonix");
    assert.strictEqual(reasonix.capabilities.httpHook, false);
    assert.strictEqual(reasonix.capabilities.permissionApproval, false);
    assert.strictEqual(reasonix.capabilities.interactiveBubble, false);
    assert.strictEqual(reasonix.capabilities.notificationHook, true);
    assert.strictEqual(reasonix.capabilities.sessionEnd, true);
    assert.strictEqual(reasonix.capabilities.subagent, true);

    const qoderwork = registry.getAgent("qoderwork");
    assert.strictEqual(qoderwork.capabilities.httpHook, false);
    assert.strictEqual(qoderwork.capabilities.permissionApproval, false);
    assert.strictEqual(qoderwork.capabilities.interactiveBubble, false);
    assert.strictEqual(qoderwork.capabilities.notificationHook, true);
    assert.strictEqual(qoderwork.capabilities.sessionEnd, true);
    assert.strictEqual(qoderwork.capabilities.subagent, false);

    const workbuddy = registry.getAgent("workbuddy");
    // State-only (#618): the desktop app resolves permissions in its own
    // native sandbox + GUI, so Clawd never registers a /permission HTTP hook
    // and never renders an approval bubble. It only mirrors state and pops a
    // waiting Notification.
    assert.strictEqual(workbuddy.capabilities.httpHook, false);
    assert.strictEqual(workbuddy.capabilities.permissionApproval, false);
    assert.strictEqual(workbuddy.capabilities.interactiveBubble, false);
    assert.strictEqual(workbuddy.capabilities.notificationHook, true);
    assert.strictEqual(workbuddy.capabilities.sessionEnd, true);
    assert.strictEqual(workbuddy.capabilities.subagent, false);
  });

  it("declares the mobile permission observation capability for every agent", () => {
    const enabled = [];
    for (const agent of registry.getAllAgents()) {
      assert.strictEqual(
        typeof agent.capabilities.mobilePermissionObservation,
        "boolean",
        `${agent.id} must explicitly declare mobilePermissionObservation`
      );
      if (agent.capabilities.mobilePermissionObservation) enabled.push(agent.id);
    }
    assert.deepStrictEqual(enabled.sort(), [
      "claude-code",
      "codebuddy",
      "codex",
      "hermes",
      "qwen-code",
    ]);
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

    const antigravity = registry.getAgent("antigravity-cli");
    assert.strictEqual(antigravity.eventMap.PreInvocation, "thinking");
    // D2: PreToolUse intentionally absent — agy native menu handles permission.
    assert.strictEqual(antigravity.eventMap.PreToolUse, undefined);
    assert.strictEqual(antigravity.eventMap.PostToolUse, "working");
    assert.strictEqual(antigravity.eventMap.Stop, "attention");

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

    const qwen = registry.getAgent("qwen-code");
    assert.strictEqual(qwen.eventMap.SessionStart, "idle");
    assert.strictEqual(qwen.eventMap.PreToolUse, "working");
    assert.strictEqual(qwen.eventMap.PermissionRequest, "notification");
    // qwen Stop plays the happy end-of-turn animation like other hook agents.
    // The PostToolUse → UserPromptSubmit self-submit that used to clobber it
    // is dropped by src/state.js's lastBoundaryAt filter.
    assert.strictEqual(qwen.eventMap.Stop, "attention");

    const codewhale = registry.getAgent("codewhale");
    assert.strictEqual(codewhale.eventSource, "hook");
    assert.strictEqual(codewhale.eventMap.SessionStart, "idle");
    assert.strictEqual(codewhale.eventMap.UserPromptSubmit, "thinking");
    assert.strictEqual(codewhale.eventMap.PostToolUseFailure, "error");
    assert.strictEqual(codewhale.eventMap.Notification, "attention");
    assert.strictEqual(codewhale.eventMap.Stop, undefined);
    assert.strictEqual(codewhale.eventMap.PreCompact, "sweeping");
    assert.strictEqual(codewhale.eventMap.SessionEnd, "sleeping");

    const qoder = registry.getAgent("qoder");
    assert.strictEqual(qoder.eventMap.SessionStart, "idle");
    assert.strictEqual(qoder.eventMap.PreToolUse, "working");
    assert.strictEqual(qoder.eventMap.PostToolUseFailure, "error");
    assert.strictEqual(qoder.eventMap.Stop, "attention");
    assert.strictEqual(qoder.eventMap.PermissionRequest, "notification");
    assert.strictEqual(qoder.eventMap.PermissionDenied, "notification");
    assert.strictEqual(qoder.eventMap.SessionEnd, "sleeping");

    const reasonix = registry.getAgent("reasonix");
    assert.strictEqual(reasonix.eventSource, "hook");
    assert.strictEqual(reasonix.eventMap.SessionStart, "idle");
    assert.strictEqual(reasonix.eventMap.UserPromptSubmit, "thinking");
    assert.strictEqual(reasonix.eventMap.PreToolUse, "working");
    assert.strictEqual(reasonix.eventMap.PostToolUse, "working");
    assert.strictEqual(reasonix.eventMap.Stop, "attention");
    assert.strictEqual(reasonix.eventMap.SubagentStop, "working");
    assert.strictEqual(reasonix.eventMap.Notification, "notification");
    assert.strictEqual(reasonix.eventMap.PreCompact, "sweeping");
    assert.strictEqual(reasonix.eventMap.SessionEnd, "sleeping");

    const qoderwork = registry.getAgent("qoderwork");
    assert.strictEqual(qoderwork.eventSource, "hook");
    assert.strictEqual(qoderwork.eventMap.SessionStart, "idle");
    assert.strictEqual(qoderwork.eventMap.UserPromptSubmit, "thinking");
    assert.strictEqual(qoderwork.eventMap.PreToolUse, "working");
    assert.strictEqual(qoderwork.eventMap.PostToolUseFailure, "error");
    assert.strictEqual(qoderwork.eventMap.Stop, "attention");
    // Permission events map to "working" (not "notification") to avoid
    // animation spam — QoderWork fires 40+ per task during normal tool use.
    assert.strictEqual(qoderwork.eventMap.PermissionRequest, "working");
    assert.strictEqual(qoderwork.eventMap.PermissionDenied, "working");
    assert.strictEqual(qoderwork.eventMap.SessionEnd, "sleeping");

    const workbuddy = registry.getAgent("workbuddy");
    assert.strictEqual(workbuddy.eventSource, "hook");
    assert.strictEqual(workbuddy.eventMap.SessionStart, "idle");
    assert.strictEqual(workbuddy.eventMap.UserPromptSubmit, "thinking");
    assert.strictEqual(workbuddy.eventMap.PreToolUse, "working");
    assert.strictEqual(workbuddy.eventMap.PostToolUse, "working");
    assert.strictEqual(workbuddy.eventMap.Stop, "attention");
    // #618: no PermissionRequest mapping — the kernel has no standalone
    // PermissionRequest event, and desktop approval never reaches Clawd.
    // Permission surfaces only through Notification.
    assert.strictEqual(workbuddy.eventMap.PermissionRequest, undefined);
    assert.strictEqual(workbuddy.eventMap.Notification, "notification");
    assert.strictEqual(workbuddy.eventMap.PreCompact, "sweeping");
    assert.strictEqual(workbuddy.eventMap.SessionEnd, "sleeping");
  });

  it("treats Gemini CLI as a hook-only agent", () => {
    const gemini = registry.getAgent("gemini-cli");

    assert.strictEqual(gemini.eventSource, "hook");
    assert.ok(gemini.hookConfig);
    assert.strictEqual(gemini.hookConfig.configFormat, "gemini-settings-json");
    assert.strictEqual(gemini.logConfig, undefined);
  });

  it("treats Antigravity CLI as a hook-only agent", () => {
    const antigravity = registry.getAgent("antigravity-cli");

    assert.strictEqual(antigravity.eventSource, "hook");
    assert.ok(antigravity.hookConfig);
    assert.strictEqual(antigravity.hookConfig.configFormat, "antigravity-hooks-json");
    assert.strictEqual(antigravity.logConfig, undefined);
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
