"use strict";

// Irreversible-action guard for permission automation.
//
// `detectIrreversible` (bubble-format.js) has been a display-only hint since
// #613. This suite pins the one place where that hint becomes a *decision*:
// an automatic allow (global auto-tools / unattended, or a per-session grant)
// must never fire for a destructive shell command or explicit delete tool.
// The request stays pending and takes the ordinary manual path (bubble,
// hotkey, Telegram / Lark) — exactly what "Question prompts only" would show.
//
// Questions, plan reviews and passive notifications are untouched: the guard
// only narrows AUTO_ALLOW for tool approvals.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const initPermission = require("../src/permission");
const {
  PERMISSION_AUTOMATION_MODE,
  AUTOMATION_ACTION,
  classifyPermissionInteraction,
  evaluatePermissionAutomation,
  describeAutomationHold,
} = require("../src/permission-automation-policy");
const { SUPPORTED_LANGS } = require("../src/i18n");

const bubbleRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "bubble-renderer.js"), "utf8");

function toolEntry(command, overrides = {}) {
  const toolName = overrides.toolName || "Bash";
  return {
    toolName,
    toolInput: overrides.toolInput || { command },
    agentId: overrides.agentId || "claude-code",
    interaction: classifyPermissionInteraction({
      agentId: overrides.agentId || "claude-code",
      toolName,
    }),
  };
}

function evaluate(mode, entry) {
  return evaluatePermissionAutomation({ mode, interaction: entry.interaction, entry });
}

describe("permission automation: irreversible guard (policy)", () => {
  const destructive = [
    ["force push", "git push --force origin main", "force-push"],
    ["rm -rf", "rm -rf build/", "file-delete"],
    ["npm publish", "npm publish --access public", "publish"],
    ["history rewrite", "git reset --hard HEAD~3", "history-rewrite"],
    ["chained after benign", "npm test && git push -f origin main", "force-push"],
  ];
  for (const mode of [PERMISSION_AUTOMATION_MODE.AUTO_TOOLS, PERMISSION_AUTOMATION_MODE.UNATTENDED]) {
    for (const [label, command, tag] of destructive) {
      it(`${mode}: defers ${label}`, () => {
        const entry = toolEntry(command);
        assert.strictEqual(evaluate(mode, entry), AUTOMATION_ACTION.DEFER);
        assert.deepStrictEqual(describeAutomationHold(entry), { reason: "irreversible", tag });
      });
    }
    it(`${mode}: still allows an ordinary tool request`, () => {
      const entry = toolEntry("npm test");
      assert.strictEqual(evaluate(mode, entry), AUTOMATION_ACTION.AUTO_ALLOW);
      assert.strictEqual(describeAutomationHold(entry), null);
    });
    it(`${mode}: quoted destructive text is not a hold (precision over recall)`, () => {
      const entry = toolEntry('git commit -m "git push --force"');
      assert.strictEqual(evaluate(mode, entry), AUTOMATION_ACTION.AUTO_ALLOW);
    });
  }

  it("defers explicit delete tools (delete_file) for every eligible adapter", () => {
    const entry = toolEntry(null, { toolName: "delete_file", toolInput: { path: "src/a.js" }, agentId: "codebuddy" });
    assert.strictEqual(evaluate(PERMISSION_AUTOMATION_MODE.UNATTENDED, entry), AUTOMATION_ACTION.DEFER);
    assert.deepStrictEqual(describeAutomationHold(entry), { reason: "irreversible", tag: "file-delete" });
  });

  // Every shell-shaped tool name that can reach AUTO_ALLOW must be inspected.
  // A name missing from SHELL_TOOLS is a silent hole, so this table is the
  // contract between the automation allowlist and the matcher.
  const shellAdapters = [
    ["codex", "Shell"],
    ["codex", "Bash"],
    ["claude-code", "Bash"],
    ["claude-code", "execute_bash"],
    ["claude-code", "run_shell_command"],
    ["claude-code", "powershell"],
    ["claude-code", "run_command"],
    ["qwen-code", "run_shell_command"],
    ["hermes", "execute_bash"],
    ["copilot-cli", "powershell"],
    ["copilot-cli", "bash"],
    ["codebuddy", "Bash"],
    ["opencode", "bash"],
  ];
  for (const [agentId, toolName] of shellAdapters) {
    it(`covers ${agentId} / ${toolName}`, () => {
      const entry = toolEntry("git branch -D main", { toolName, agentId });
      assert.strictEqual(
        evaluate(PERMISSION_AUTOMATION_MODE.AUTO_TOOLS, toolEntry("npm test", { toolName, agentId })),
        AUTOMATION_ACTION.AUTO_ALLOW,
        `${agentId}/${toolName} must be auto-eligible for this case to be meaningful`
      );
      assert.strictEqual(evaluate(PERMISSION_AUTOMATION_MODE.AUTO_TOOLS, entry), AUTOMATION_ACTION.DEFER);
      assert.deepStrictEqual(describeAutomationHold(entry), { reason: "irreversible", tag: "branch-delete" });
    });
  }

  it("flattens argv-array commands (Codex legacy shell / shell -c wrappers)", () => {
    const argv = toolEntry(null, { toolName: "Bash", agentId: "codex", toolInput: { command: ["git", "push", "--force", "origin", "main"] } });
    assert.deepStrictEqual(describeAutomationHold(argv), { reason: "irreversible", tag: "force-push" });
    const wrapped = toolEntry(null, { toolName: "Bash", agentId: "codex", toolInput: { command: ["bash", "-lc", "rm -rf build/"] } });
    assert.deepStrictEqual(describeAutomationHold(wrapped), { reason: "irreversible", tag: "file-delete" });
    const benign = toolEntry(null, { toolName: "Bash", agentId: "codex", toolInput: { command: ["npm", "test"] } });
    assert.strictEqual(describeAutomationHold(benign), null);
    // Not every array is argv: mixed types are left alone (no crash, no match).
    const weird = toolEntry(null, { toolName: "Bash", toolInput: { command: ["rm", { flag: "-rf" }, "/"] } });
    assert.strictEqual(describeAutomationHold(weird), null);
  });

  it("does not touch questions or plan reviews (unattended keeps auto-answer / auto-approve)", () => {
    const question = {
      toolName: "AskUserQuestion",
      toolInput: { questions: [{ question: "Delete everything?" }] },
      interaction: classifyPermissionInteraction({ agentId: "claude-code", toolName: "AskUserQuestion" }),
    };
    const plan = {
      toolName: "ExitPlanMode",
      toolInput: { plan: "rm -rf build/" },
      interaction: classifyPermissionInteraction({ agentId: "claude-code", toolName: "ExitPlanMode" }),
    };
    assert.strictEqual(evaluate(PERMISSION_AUTOMATION_MODE.UNATTENDED, question), AUTOMATION_ACTION.AUTO_ANSWER);
    assert.strictEqual(evaluate(PERMISSION_AUTOMATION_MODE.UNATTENDED, plan), AUTOMATION_ACTION.AUTO_ALLOW);
    assert.strictEqual(describeAutomationHold(question), null);
    assert.strictEqual(describeAutomationHold(plan), null);
  });

  it("names its own blind spots: MCP tools and non-shell inputs are not inspected", () => {
    // Coverage honesty: an MCP tool whose argument happens to be a shell
    // string, or a delete hidden inside a script file, is NOT caught. This
    // test documents the boundary so a future widening is a deliberate change.
    const mcp = toolEntry(null, {
      toolName: "mcp__shell__run",
      toolInput: { command: "rm -rf /" },
    });
    assert.strictEqual(evaluate(PERMISSION_AUTOMATION_MODE.UNATTENDED, mcp), AUTOMATION_ACTION.AUTO_ALLOW);
    assert.strictEqual(describeAutomationHold(mcp), null);
    const script = toolEntry("bash ./scripts/cleanup.sh");
    assert.strictEqual(evaluate(PERMISSION_AUTOMATION_MODE.UNATTENDED, script), AUTOMATION_ACTION.AUTO_ALLOW);
  });

  it("is inert when the guard is explicitly disabled by the caller", () => {
    const entry = toolEntry("git push --force origin main");
    const action = evaluatePermissionAutomation({
      mode: PERMISSION_AUTOMATION_MODE.UNATTENDED,
      interaction: entry.interaction,
      entry,
      guardIrreversible: false,
    });
    assert.strictEqual(action, AUTOMATION_ACTION.AUTO_ALLOW);
  });
});

function liveResponse(overrides = {}) {
  return {
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    end() { this.writableEnded = true; },
    on() {},
    removeListener() {},
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  return {
    focusTerminalForSession() {},
    getSettingsSnapshot: () => ({}),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    isCodexPermissionInterceptEnabled: () => true,
    getPermissionAutomationMode: () => "unattended",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    pendingPermissions: [],
    sessions: new Map(),
    sendPermissionResponse: () => {},
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    STATE_SVGS: {},
    setState: () => {},
    updateSession: () => {},
    ...overrides,
  };
}

function makePermEntry(command, overrides = {}) {
  return {
    res: liveResponse(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "session-guard",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    agentId: "claude-code",
    interaction: classifyPermissionInteraction({ agentId: "claude-code", toolName: "Bash" }),
    ...overrides,
  };
}

describe("permission automation: irreversible guard (chokepoints)", () => {
  it("unattended keeps a destructive request pending at showPermissionBubble", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry("rm -rf build/");
    perm.pendingPermissions.push(entry);
    // Without Electron the manual path throws while building the window —
    // the same signal the "mode off" test uses: automation did NOT short-circuit.
    assert.throws(() => perm.showPermissionBubble(entry));
    assert.strictEqual(perm.pendingPermissions.includes(entry), true, "must stay pending for a human");
    assert.strictEqual(entry.res.writableEnded, false, "no allow may be written");
    assert.deepStrictEqual(entry.automationHold, { reason: "irreversible", tag: "file-delete" });
    // The renderer learns WHY a card appeared through the bubble payload.
    assert.deepStrictEqual(
      perm.buildPermissionBubblePayload(entry).automationHold,
      { reason: "irreversible", tag: "file-delete" }
    );
  });

  it("unattended still auto-allows the ordinary sibling request", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry("npm test");
    perm.pendingPermissions.push(entry);
    perm.showPermissionBubble(entry);
    assert.strictEqual(perm.pendingPermissions.includes(entry), false);
    assert.strictEqual(entry.automationHold, undefined);
  });

  it("per-session grants cannot sweep a destructive request either", () => {
    const ctx = makeCtx({ getPermissionAutomationMode: () => "off" });
    const perm = initPermission(ctx);
    const entry = makePermEntry("git push --force origin main", {
      sessionAutomationIdentity: Object.freeze({ eligible: true, reason: "eligible" }),
    });
    perm.pendingPermissions.push(entry);
    assert.strictEqual(
      perm.canAutoResolvePendingPermission(entry, { sessionOnly: true, mode: "auto-tools" }),
      false
    );
    const benign = makePermEntry("npm test", {
      sessionAutomationIdentity: Object.freeze({ eligible: true, reason: "eligible" }),
    });
    perm.pendingPermissions.push(benign);
    assert.strictEqual(
      perm.canAutoResolvePendingPermission(benign, { sessionOnly: true, mode: "auto-tools" }),
      true
    );
  });
});

describe("permission automation: irreversible guard (wording)", () => {
  it("ships the paused-automation bubble line in every supported language", () => {
    const count = (bubbleRenderer.match(/irreversibleAutoHold:/g) || []).length;
    assert.strictEqual(count, SUPPORTED_LANGS.length);
  });

  it("promises only what the guard enforces in the automation confirm dialogs", () => {
    const { i18n } = require("../src/i18n");
    for (const lang of SUPPORTED_LANGS) {
      const note = i18n[lang].permissionAutomationIrreversibleGuardNote;
      assert.strictEqual(typeof note, "string", `${lang}.permissionAutomationIrreversibleGuardNote should exist`);
      assert.ok(note.length > 20, `${lang} guard note must be a sentence`);
      assert.ok(/4 ?KB/.test(note), `${lang} note must name the 4 KB cap`);
      assert.ok(/MCP/.test(note), `${lang} note must name the MCP blind spot`);
    }
    assert.ok(!/never auto-approved/.test(i18n.en.permissionAutomationIrreversibleGuardNote), "en wording must not over-promise");
  });

  it("both automation confirm dialogs (tray menu + Settings) append the guard note", () => {
    for (const file of ["menu.js", "settings-tab-general.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");
      const detailIdx = src.indexOf("permissionAutomationAutoToolsConfirmDetail");
      const noteIdx = src.indexOf('t("permissionAutomationIrreversibleGuardNote")', detailIdx);
      assert.ok(detailIdx !== -1 && noteIdx !== -1 && noteIdx - detailIdx < 200, `${file} must append the note to the confirm detail`);
    }
  });
});
