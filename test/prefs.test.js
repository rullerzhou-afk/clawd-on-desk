"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const prefs = require("../src/prefs");

const tempDirs = [];

function makeTempPath(name = "clawd-prefs.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-prefs-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("prefs.getDefaults", () => {
  it("returns a fresh snapshot every call (no shared object refs)", () => {
    const a = prefs.getDefaults();
    const b = prefs.getDefaults();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.agents, b.agents);
    assert.notStrictEqual(a.themeOverrides, b.themeOverrides);
    assert.notStrictEqual(a.shortcuts, b.shortcuts);
    assert.notStrictEqual(a.sessionAliases, b.sessionAliases);
    assert.notStrictEqual(a.tgApproval, b.tgApproval);
    // Mutating one shouldn't affect the other
    a.agents["claude-code"].enabled = false;
    assert.strictEqual(b.agents["claude-code"].enabled, true);
  });

  it("includes the current schema version", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.version, prefs.CURRENT_VERSION);
  });

  it("defaults Claude hook management on and Start with Claude off", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.manageClaudeHooksAutomatically, true);
    assert.strictEqual(d.autoStartWithClaude, false);
    assert.strictEqual(d.lowPowerIdleMode, false);
    assert.strictEqual(d.allowEdgePinning, false);
    assert.strictEqual(d.disableMiniMode, false);
    assert.strictEqual(d.keepSizeAcrossDisplays, false);
    assert.strictEqual(d.sessionHudEnabled, true);
    assert.strictEqual(d.sessionHudShowStateLabels, true);
    assert.strictEqual(d.sessionHudShowElapsed, false);
    assert.strictEqual(d.sessionHudShowContextUsage, true);
    assert.strictEqual(d.sessionHudCleanupDetached, true);
    assert.strictEqual("sessionHudAutoHide" in d, false);
    assert.strictEqual(d.sessionHudPinned, false);
    assert.strictEqual(d.savedPixelWidth, 0);
    assert.strictEqual(d.savedPixelHeight, 0);
    assert.strictEqual(d.savedPixelWorkArea, null);
    assert.strictEqual(d.permissionBubblesEnabled, true);
    assert.strictEqual(d.notificationBubbleAutoCloseSeconds, 6);
    assert.strictEqual(d.updateBubbleAutoCloseSeconds, 9);
    assert.deepStrictEqual(d.sessionAliases, {});
    assert.deepStrictEqual(d.tgApproval, {
      enabled: false,
      allowedTgUserId: "",
      targetSessionKey: "",
      notifyOnComplete: false,
      completionOutputMode: "off",
      r3DirectSendEnabled: false,
    });
  });

  it("seeds only default-installed agents as enabled", () => {
    const d = prefs.getDefaults();
    for (const id of ["claude-code", "codex"]) {
      assert.strictEqual(d.agents[id].enabled, true, `${id} should default enabled`);
      assert.strictEqual(d.agents[id].integrationInstalled, true, `${id} should default installed`);
    }
    for (const id of ["copilot-cli", "cursor-agent", "gemini-cli", "antigravity-cli", "codebuddy", "kiro-cli", "kimi-cli", "qwen-code", "codewhale", "opencode", "pi", "openclaw", "hermes", "qoder"]) {
      assert.strictEqual(d.agents[id].enabled, false, `${id} should default disabled`);
      assert.strictEqual(d.agents[id].integrationInstalled, false, `${id} should default not installed`);
    }
  });

  it("seeds permission-capable agents with permissionsEnabled=true", () => {
    const d = prefs.getDefaults();
    // State-only integrations intentionally excluded — no bubble.
    for (const id of ["claude-code", "codex", "copilot-cli", "cursor-agent", "gemini-cli", "codebuddy", "kiro-cli", "kimi-cli", "qwen-code", "opencode", "hermes"]) {
      assert.strictEqual(
        d.agents[id].permissionsEnabled,
        true,
        `${id} should default permissionsEnabled`
      );
    }
    for (const id of ["antigravity-cli", "codewhale", "pi", "openclaw", "qoder"]) {
      assert.strictEqual(
        d.agents[id].permissionsEnabled,
        false,
        `${id} is state-only, permissionsEnabled must default to false`
      );
    }
  });

  it("seeds the subagent permission sub-gate on claude-code only (#451)", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.agents["claude-code"].subagentPermissionsEnabled, true);
    // Other agents must not carry the flag — normalizeAgents only accepts
    // flags present in an agent's default entry, which keeps this sub-gate
    // claude-code-scoped.
    for (const id of ["codex", "codebuddy", "hermes", "copilot-cli"]) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(d.agents[id], "subagentPermissionsEnabled"),
        false,
        `${id} must not carry subagentPermissionsEnabled`
      );
    }
  });

  it("defaults OpenClaw permission bubbles off", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.agents.openclaw.integrationInstalled, false);
    assert.strictEqual(d.agents.openclaw.enabled, false);
    assert.strictEqual(d.agents.openclaw.permissionsEnabled, false);
    assert.strictEqual(d.agents.openclaw.notificationHookEnabled, true);
  });

  it("defaults Qoder permission bubbles off (state-only)", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.agents.qoder.integrationInstalled, false);
    assert.strictEqual(d.agents.qoder.enabled, false);
    assert.strictEqual(d.agents.qoder.permissionsEnabled, false);
    assert.strictEqual(d.agents.qoder.notificationHookEnabled, true);
  });

  it("defaults CodeWhale permission bubbles off (state-only)", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.agents.codewhale.integrationInstalled, false);
    assert.strictEqual(d.agents.codewhale.enabled, false);
    assert.strictEqual(d.agents.codewhale.permissionsEnabled, false);
    assert.strictEqual(d.agents.codewhale.notificationHookEnabled, true);
  });

  it("defaults Pi permission bubbles off", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.agents.pi.integrationInstalled, false);
    assert.strictEqual(d.agents.pi.enabled, false);
    assert.strictEqual(d.agents.pi.permissionsEnabled, false);
    assert.strictEqual(d.agents.pi.notificationHookEnabled, true);
  });

  it("defaults Codex permissions to intercept mode", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.agents.codex.permissionMode, "intercept");
    assert.strictEqual(d.agents.codex.nativeNotificationSoundEnabled, false);
  });

  it("defaults Hardware Buddy to disabled state-only BLE", () => {
    const d = prefs.getDefaults();
    assert.deepStrictEqual(d.hardwareBuddy, {
      enabled: false,
      backend: "bleak",
      address: "",
      namePrefix: "Clawstick",
      permissionsEnabled: false,
      quickCommandsEnabled: false,
    });
  });
});

describe("prefs.validate", () => {
  it("drops bad fields and falls back to defaults", () => {
    const v = prefs.validate({
      lang: "klingon",       // not in enum
      soundMuted: "yes",     // wrong type
      soundVolume: 2,        // out of range → default 1
      lowPowerIdleMode: "yes",
      x: NaN,                // not finite
      bubbleFollowPet: true, // ok
      sessionHudEnabled: "yes",
      sessionHudShowStateLabels: "yes",
      sessionHudShowElapsed: "yes",
      sessionHudShowContextUsage: "yes",
      sessionHudCleanupDetached: "yes",
      hideBubbles: 0,        // wrong type
      permissionBubblesEnabled: "yes",
      notificationBubbleAutoCloseSeconds: -1,
      updateBubbleAutoCloseSeconds: 3601,
      allowEdgePinning: "yes",
      disableMiniMode: "yes",
      savedPixelWidth: -1,
      savedPixelHeight: "286",
      savedPixelWorkArea: "bogus",
    });
    const d = prefs.getDefaults();
    assert.strictEqual(v.lang, d.lang);
    assert.strictEqual(v.soundMuted, false);
    assert.strictEqual(v.soundVolume, 1);
    assert.strictEqual(v.lowPowerIdleMode, false);
    assert.strictEqual(v.x, 0);
    assert.strictEqual(v.bubbleFollowPet, true);
    assert.strictEqual(v.sessionHudEnabled, true);
    assert.strictEqual(v.sessionHudShowStateLabels, true);
    assert.strictEqual(v.sessionHudShowElapsed, false);
    assert.strictEqual(v.sessionHudShowContextUsage, true);
    assert.strictEqual(v.sessionHudCleanupDetached, true);
    assert.strictEqual(v.hideBubbles, false);
    assert.strictEqual(v.permissionBubblesEnabled, true);
    assert.strictEqual(v.notificationBubbleAutoCloseSeconds, 6);
    assert.strictEqual(v.updateBubbleAutoCloseSeconds, 9);
    assert.strictEqual(v.allowEdgePinning, false);
    assert.strictEqual(v.disableMiniMode, false);
    assert.strictEqual(v.savedPixelWidth, 0);
    assert.strictEqual(v.savedPixelHeight, 0);
    assert.strictEqual(v.savedPixelWorkArea, null);
  });

  it("backfills split bubble prefs from legacy hideBubbles=true", () => {
    const v = prefs.validate(prefs.migrate({ hideBubbles: true }));
    assert.strictEqual(v.hideBubbles, true);
    assert.strictEqual(v.permissionBubblesEnabled, false);
    assert.strictEqual(v.notificationBubbleAutoCloseSeconds, 0);
    assert.strictEqual(v.updateBubbleAutoCloseSeconds, 0);
  });

  it("backfills split bubble prefs from legacy hideBubbles=false", () => {
    const v = prefs.validate(prefs.migrate({ hideBubbles: false }));
    assert.strictEqual(v.hideBubbles, false);
    assert.strictEqual(v.permissionBubblesEnabled, true);
    assert.strictEqual(v.notificationBubbleAutoCloseSeconds, 6);
    assert.strictEqual(v.updateBubbleAutoCloseSeconds, 9);
  });

  it("preserves explicit split bubble prefs during legacy backfill", () => {
    const v = prefs.validate(prefs.migrate({
      hideBubbles: true,
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 12,
      updateBubbleAutoCloseSeconds: 8,
    }));
    assert.strictEqual(v.permissionBubblesEnabled, true);
    assert.strictEqual(v.notificationBubbleAutoCloseSeconds, 12);
    assert.strictEqual(v.updateBubbleAutoCloseSeconds, 8);
  });

  it("upgrades legacy default notification bubble duration during v3 migration", () => {
    const v = prefs.validate(prefs.migrate({
      version: 2,
      hideBubbles: false,
      notificationBubbleAutoCloseSeconds: 3,
    }));
    assert.strictEqual(v.version, prefs.CURRENT_VERSION);
    assert.strictEqual(v.notificationBubbleAutoCloseSeconds, 6);
  });

  it("preserves explicit notification bubble duration during v3 migration", () => {
    const v = prefs.validate(prefs.migrate({
      version: 2,
      hideBubbles: false,
      notificationBubbleAutoCloseSeconds: 12,
    }));
    assert.strictEqual(v.version, prefs.CURRENT_VERSION);
    assert.strictEqual(v.notificationBubbleAutoCloseSeconds, 12);
  });

  it("resets existing Pi permission prefs during v4 migration", () => {
    const v = prefs.validate(prefs.migrate({
      version: 3,
      agents: {
        pi: { enabled: true, permissionsEnabled: true, notificationHookEnabled: true },
      },
    }));

    assert.strictEqual(v.version, prefs.CURRENT_VERSION);
    assert.strictEqual(v.agents.pi.enabled, true);
    assert.strictEqual(v.agents.pi.permissionsEnabled, false);
    assert.strictEqual(v.agents.pi.notificationHookEnabled, true);
  });

  it("defaults missing Pi permission prefs off during migration", () => {
    const v = prefs.validate(prefs.migrate({
      version: 1,
      agents: {
        pi: { enabled: true, notificationHookEnabled: true },
      },
    }));

    assert.strictEqual(v.version, prefs.CURRENT_VERSION);
    assert.strictEqual(v.agents.pi.permissionsEnabled, false);
  });

  it("normalizes Telegram approval prefs without storing a token", () => {
    const v = prefs.validate({
      tgApproval: {
        enabled: true,
        allowedTgUserId: " 123456789 ",
        targetSessionKey: "987654321",
        botToken: "123:should-not-survive",
      },
    });
    assert.deepStrictEqual(v.tgApproval, {
      enabled: true,
      allowedTgUserId: "123456789",
      targetSessionKey: "telegram:987654321",
      notifyOnComplete: false,
      completionOutputMode: "off",
      r3DirectSendEnabled: false,
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(v.tgApproval, "botToken"), false);
  });

  it("keeps valid fields verbatim", () => {
    const v = prefs.validate({
      lang: "ko",
      soundMuted: true,
      soundVolume: 0.4,
      lowPowerIdleMode: true,
      bubbleFollowPet: true,
      sessionHudEnabled: false,
      sessionHudShowStateLabels: false,
      sessionHudShowElapsed: false,
      sessionHudShowContextUsage: false,
      sessionHudCleanupDetached: true,
      allowEdgePinning: true,
      disableMiniMode: true,
      keepSizeAcrossDisplays: true,
      savedPixelWidth: 286,
      savedPixelHeight: 286,
      savedPixelWorkArea: { width: 1920, height: 1080 },
      x: 100,
      y: -50,
      size: "P:15",
      miniEdge: "left",
      theme: "calico",
    });
    assert.strictEqual(v.lang, "ko");
    assert.strictEqual(v.soundMuted, true);
    assert.strictEqual(v.soundVolume, 0.4);
    assert.strictEqual(v.lowPowerIdleMode, true);
    assert.strictEqual(v.bubbleFollowPet, true);
    assert.strictEqual(v.sessionHudEnabled, false);
    assert.strictEqual(v.sessionHudShowStateLabels, false);
    assert.strictEqual(v.sessionHudShowElapsed, false);
    assert.strictEqual(v.sessionHudShowContextUsage, false);
    assert.strictEqual(v.sessionHudCleanupDetached, true);
    assert.strictEqual(v.allowEdgePinning, true);
    assert.strictEqual(v.disableMiniMode, true);
    assert.strictEqual(v.keepSizeAcrossDisplays, true);
    assert.strictEqual(v.savedPixelWidth, 286);
    assert.strictEqual(v.savedPixelHeight, 286);
    assert.deepStrictEqual(v.savedPixelWorkArea, { width: 1920, height: 1080 });
    assert.strictEqual(v.x, 100);
    assert.strictEqual(v.y, -50);
    assert.strictEqual(v.size, "P:15");
    assert.strictEqual(v.miniEdge, "left");
    assert.strictEqual(v.theme, "calico");
  });

  it("accepts soundVolume 0 (silent playback is valid)", () => {
    const v = prefs.validate({ soundVolume: 0 });
    assert.strictEqual(v.soundVolume, 0);
  });

  it("keeps textScale within 0.8–1.6 and defaults out-of-range values", () => {
    assert.strictEqual(prefs.validate({ textScale: 1.25 }).textScale, 1.25);
    assert.strictEqual(prefs.validate({ textScale: 0.8 }).textScale, 0.8);
    assert.strictEqual(prefs.validate({ textScale: 1.6 }).textScale, 1.6);
    assert.strictEqual(prefs.validate({ textScale: 0.5 }).textScale, 1);
    assert.strictEqual(prefs.validate({ textScale: 2 }).textScale, 1);
    assert.strictEqual(prefs.validate({ textScale: "1.2" }).textScale, 1);
    assert.strictEqual(prefs.getDefaults().textScale, 1);
  });

  it("normalizes agents (drops malformed entries)", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: false },
        "bogus-entry": "not an object",
        "codex": { enabled: "true" }, // wrong type — should be dropped
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, false);
    // bogus + bad codex use defaults
    assert.strictEqual(v.agents.codex.enabled, true);
    assert.strictEqual(v.agents["bogus-entry"], undefined);
  });

  it("normalizes agents: preserves permissionsEnabled flag", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: true, permissionsEnabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, true);
    assert.strictEqual(v.agents["claude-code"].permissionsEnabled, false);
  });

  it("normalizes agents: fills missing permissionsEnabled from defaults", () => {
    // Pre-subgate prefs files only have { enabled: bool }. Normalization
    // must NOT strip them, but must also NOT invent permissionsEnabled=false
    // — defaults are true, and the gate reads "missing flag" as true anyway.
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, false);
    assert.strictEqual(v.agents["claude-code"].permissionsEnabled, true);
  });

  it("normalizes agents: drops non-boolean permissionsEnabled, keeps valid enabled", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: false, permissionsEnabled: "nope" },
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, false);
    // Bad flag falls back to the default for that agent (true), not dropped
    // altogether — the entry has a valid flag so it survives.
    assert.strictEqual(v.agents["claude-code"].permissionsEnabled, true);
  });

  it("normalizes agents: preserves subagentPermissionsEnabled for claude-code, strips it elsewhere", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: true, subagentPermissionsEnabled: false },
        codex: { enabled: true, subagentPermissionsEnabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].subagentPermissionsEnabled, false);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(v.agents.codex, "subagentPermissionsEnabled"),
      false
    );
  });

  it("normalizes agents: fills missing subagentPermissionsEnabled from defaults (pre-#451 prefs)", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].subagentPermissionsEnabled, true);
  });

  it("normalizes agents: preserves Hermes permission/notification flags", () => {
    const v = prefs.validate({
      agents: {
        hermes: { enabled: true, permissionsEnabled: true, notificationHookEnabled: true },
      },
    });
    assert.deepStrictEqual(v.agents.hermes, {
      integrationInstalled: false,
      enabled: true,
      permissionsEnabled: true,
      notificationHookEnabled: true,
    });
  });

  it("normalizes agents: preserves Antigravity permission flag but strips notification flag", () => {
    const v = prefs.validate({
      agents: {
        "antigravity-cli": { enabled: false, permissionsEnabled: false, notificationHookEnabled: true },
      },
    });
    assert.deepStrictEqual(v.agents["antigravity-cli"], {
      integrationInstalled: false,
      enabled: false,
      permissionsEnabled: false,
    });
  });

  it("normalizes agents: preserves notificationHookEnabled flag", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: true, notificationHookEnabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, true);
    assert.strictEqual(v.agents["claude-code"].notificationHookEnabled, false);
  });

  it("normalizes agents: preserves integrationInstalled for every known agent", () => {
    const d = prefs.getDefaults();
    const inputAgents = {};
    for (const agentId of Object.keys(d.agents)) {
      inputAgents[agentId] = {
        integrationInstalled: !d.agents[agentId].integrationInstalled,
        enabled: d.agents[agentId].enabled,
      };
    }
    const v = prefs.validate({ agents: inputAgents });
    for (const agentId of Object.keys(d.agents)) {
      assert.strictEqual(
        v.agents[agentId].integrationInstalled,
        !d.agents[agentId].integrationInstalled,
        `${agentId} should preserve integrationInstalled`
      );
    }
  });

  it("normalizes agents: preserves valid Codex permissionMode", () => {
    const v = prefs.validate({
      agents: {
        codex: { enabled: true, permissionMode: "intercept", nativeNotificationSoundEnabled: false },
      },
    });
    assert.strictEqual(v.agents.codex.enabled, true);
    assert.strictEqual(v.agents.codex.permissionMode, "intercept");
    assert.strictEqual(v.agents.codex.nativeNotificationSoundEnabled, false);
  });

  it("normalizes agents: drops invalid Codex permissionMode to intercept", () => {
    const v = prefs.validate({
      agents: {
        codex: { enabled: true, permissionMode: "auto" },
      },
    });
    assert.strictEqual(v.agents.codex.permissionMode, "intercept");
  });

  it("normalizes agents: fills missing notificationHookEnabled from defaults", () => {
    // Pre-flag prefs files don't carry notificationHookEnabled. The default
    // must be true so an upgrade doesn't silently suppress idle notifications
    // on users who never opted in.
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: true, permissionsEnabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].notificationHookEnabled, true);
  });

  it("normalizes dismissed agent hint maps as true-only maps", () => {
    const v = prefs.validate({
      dismissedAgentInstallHints: {
        "qwen-code": true,
        hermes: false,
        "": true,
        pi: "yes",
      },
      dismissedAgentCleanupHints: {
        "copilot-cli": true,
        openclaw: false,
        "": true,
      },
    });

    assert.deepStrictEqual(v.dismissedAgentInstallHints, { "qwen-code": true });
    assert.deepStrictEqual(v.dismissedAgentCleanupHints, { "copilot-cli": true });
  });

  it("normalizes agents: fills missing Codex nativeNotificationSoundEnabled from defaults", () => {
    const v = prefs.validate({
      agents: {
        codex: { enabled: true, permissionMode: "native" },
      },
    });
    assert.strictEqual(v.agents.codex.nativeNotificationSoundEnabled, false);
  });

  it("seeds all known agents with notificationHookEnabled=true", () => {
    const d = prefs.getDefaults();
    for (const id of ["claude-code", "codex", "copilot-cli", "cursor-agent", "gemini-cli", "codebuddy", "kiro-cli", "kimi-cli", "qwen-code", "codewhale", "opencode", "pi", "openclaw", "hermes", "qoder", "reasonix"]) {
      assert.strictEqual(
        d.agents[id].notificationHookEnabled,
        true,
        `${id} should default notificationHookEnabled`
      );
    }
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(d.agents["antigravity-cli"], "notificationHookEnabled"),
      false,
      "antigravity-cli should not expose a dead notificationHookEnabled switch"
    );
  });

  it("returns defaults for null/non-object input", () => {
    const a = prefs.validate(null);
    const b = prefs.validate("not an object");
    const d = prefs.getDefaults();
    assert.deepStrictEqual(a, d);
    assert.deepStrictEqual(b, d);
  });

  it("positionDisplay defaults to null and round-trips a valid snapshot", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.positionDisplay, null);

    const v = prefs.validate({
      positionDisplay: {
        id: 42,
        scaleFactor: 2,
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 0, width: 2560, height: 1392 },
        stray: "ignored",
      },
    });
    assert.deepStrictEqual(v.positionDisplay, {
      id: 42,
      scaleFactor: 2,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 0, width: 2560, height: 1392 },
    });
  });

  it("positionDisplay drops malformed snapshots back to null", () => {
    for (const bad of [
      { positionDisplay: "not an object" },
      { positionDisplay: { bounds: null } },
      { positionDisplay: { bounds: { x: 0, y: 0, width: 0, height: 1080 } } },
      { positionDisplay: { bounds: { x: NaN, y: 0, width: 1920, height: 1080 } } },
    ]) {
      const v = prefs.validate(bad);
      assert.strictEqual(v.positionDisplay, null, `expected null for ${JSON.stringify(bad)}`);
    }
  });

  // Phase 3b-swap: themeVariant field
  it("themeVariant defaults to empty object (no migration needed)", () => {
    const d = prefs.getDefaults();
    assert.deepStrictEqual(d.themeVariant, {});
  });

  it("themeVariant drops malformed entries but keeps string/string pairs", () => {
    const v = prefs.validate({
      themeVariant: {
        clawd: "chill",
        calico: "default",
        bogus: 42,           // wrong value type
        "": "chill",         // empty themeId
        nullVal: "",         // empty variantId
      },
    });
    assert.deepStrictEqual(v.themeVariant, { clawd: "chill", calico: "default" });
  });

  it("themeVariant falls back to defaults when not an object", () => {
    const v = prefs.validate({ themeVariant: "nope" });
    assert.deepStrictEqual(v.themeVariant, {});
    const w = prefs.validate({ themeVariant: [1, 2] });
    assert.deepStrictEqual(w.themeVariant, {});
  });

  it("sessionAliases normalizes valid entries and drops malformed values", () => {
    const v = prefs.validate({
      sessionAliases: {
        "local|codex|s1": { title: "  Codex main  ", updatedAt: 100 },
        "local|codex|missing-time": { title: "Missing time" },
        "local|codex|empty": { title: "   ", updatedAt: 100 },
        "local|codex|bad": { title: 42, updatedAt: 100 },
      },
    });
    assert.strictEqual(v.sessionAliases["local|codex|s1"].title, "Codex main");
    assert.strictEqual(v.sessionAliases["local|codex|s1"].updatedAt, 100);
    assert.strictEqual(v.sessionAliases["local|codex|missing-time"].title, "Missing time");
    assert.strictEqual(typeof v.sessionAliases["local|codex|missing-time"].updatedAt, "number");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(v.sessionAliases, "local|codex|empty"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(v.sessionAliases, "local|codex|bad"), false);
  });

  it("sessionAliases falls back to defaults when not an object", () => {
    assert.deepStrictEqual(prefs.validate({ sessionAliases: "nope" }).sessionAliases, {});
    assert.deepStrictEqual(prefs.validate({ sessionAliases: [1, 2] }).sessionAliases, {});
  });

  it("drops legacy workspaceAliases because they are no longer in the schema", () => {
    const v = prefs.validate({
      workspaceAliases: {
        "local|d:/animation": "Clawd main repo",
      },
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(v, "workspaceAliases"), false);
    assert.deepStrictEqual(v.sessionAliases, {});
  });

  it("shortcuts defaults to the built-in shortcut map", () => {
    const d = prefs.getDefaults();
    assert.deepStrictEqual(d.shortcuts, {
      togglePet: "CommandOrControl+Shift+Alt+C",
      permissionAllow: "CommandOrControl+Shift+Y",
      permissionDeny: "CommandOrControl+Shift+N",
    });
  });

  it("shortcuts fills missing keys and normalizes valid values", () => {
    const v = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+K",
      },
    });
    assert.deepStrictEqual(v.shortcuts, {
      togglePet: "CommandOrControl+K",
      permissionAllow: "CommandOrControl+Shift+Y",
      permissionDeny: "CommandOrControl+Shift+N",
    });
  });

  it("shortcuts falls back to defaults for invalid or dangerous values", () => {
    const v = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+C",
        permissionAllow: "bad accelerator",
        permissionDeny: 42,
      },
    });
    assert.deepStrictEqual(v.shortcuts, {
      togglePet: "CommandOrControl+Shift+Alt+C",
      permissionAllow: "CommandOrControl+Shift+Y",
      permissionDeny: "CommandOrControl+Shift+N",
    });
  });

  it("shortcuts de-duplicates conflicting load-time values with default priority", () => {
    const v = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+K",
        permissionAllow: "Ctrl+K",
        permissionDeny: "Ctrl+Shift+Y",
      },
    });
    assert.deepStrictEqual(v.shortcuts, {
      togglePet: "CommandOrControl+K",
      permissionAllow: "CommandOrControl+Shift+Y",
      permissionDeny: "CommandOrControl+Shift+N",
    });
  });

  it("defaults the three stale-cleanup intervals to the historical constants", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.sessionStaleMs, 600000);
    assert.strictEqual(d.workingStaleMs, 300000);
    assert.strictEqual(d.detachedIdleStaleMs, 30000);
  });

  it("accepts sessionStaleMs=0 (disables idle-age cutoff)", () => {
    const v = prefs.validate({ sessionStaleMs: 0 });
    assert.strictEqual(v.sessionStaleMs, 0);
  });

  it("drops below-minimum non-zero sessionStaleMs back to default", () => {
    // 30s is below the 60s floor for non-zero values, so it should fall
    // back to the default rather than land on disk as an unsafe value.
    const v = prefs.validate({ sessionStaleMs: 30_000 });
    assert.strictEqual(v.sessionStaleMs, 600_000);
  });

  it("drops workingStaleMs=0 back to default (0 not allowed)", () => {
    const v = prefs.validate({ workingStaleMs: 0 });
    assert.strictEqual(v.workingStaleMs, 300_000);
  });

  it("drops detachedIdleStaleMs=0 back to default (0 not allowed)", () => {
    const v = prefs.validate({ detachedIdleStaleMs: 0 });
    assert.strictEqual(v.detachedIdleStaleMs, 30_000);
  });

  it("clamps a hand-edited inverted pair: workingStaleMs > sessionStaleMs", () => {
    const v = prefs.validate({
      sessionStaleMs: 120_000,
      workingStaleMs: 600_000,
    });
    assert.strictEqual(v.sessionStaleMs, 120_000);
    assert.strictEqual(v.workingStaleMs, 120_000);
  });

  it("leaves workingStaleMs alone when sessionStaleMs is disabled (=0)", () => {
    const v = prefs.validate({
      sessionStaleMs: 0,
      workingStaleMs: 600_000,
    });
    assert.strictEqual(v.sessionStaleMs, 0);
    assert.strictEqual(v.workingStaleMs, 600_000);
  });

  it("normalizes Hardware Buddy settings", () => {
    const v = prefs.validate({
      hardwareBuddy: {
        enabled: true,
        backend: "fake",
        address: "  FAKE:CLAWSTICK  ",
        namePrefix: "  Claude  ",
        permissionsEnabled: true,
        quickCommandsEnabled: true,
      },
    });
    assert.deepStrictEqual(v.hardwareBuddy, {
      enabled: true,
      backend: "fake",
      address: "FAKE:CLAWSTICK",
      namePrefix: "Claude",
      permissionsEnabled: true,
      quickCommandsEnabled: true,
    });
    assert.deepStrictEqual(prefs.validate({ hardwareBuddy: "bad" }).hardwareBuddy, prefs.getDefaults().hardwareBuddy);
  });
});

describe("prefs.migrate", () => {
  it("upgrades v0 (no version field) to the current version", () => {
    const raw = { lang: "zh", soundMuted: true };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, prefs.CURRENT_VERSION);
    assert.ok(upgraded.agents && typeof upgraded.agents === "object");
    assert.ok(upgraded.themeOverrides && typeof upgraded.themeOverrides === "object");
    // Original fields preserved
    assert.strictEqual(upgraded.lang, "zh");
    assert.strictEqual(upgraded.soundMuted, true);
  });

  it("migrates v1 files to the current version while preserving agent prefs", () => {
    const raw = {
      version: 1,
      lang: "en",
      agents: { "claude-code": { enabled: false } },
    };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, prefs.CURRENT_VERSION);
    assert.strictEqual(upgraded.agents["claude-code"].enabled, false);
  });

  it("backfills positionSaved=true for files with non-zero x/y", () => {
    const raw = { version: 1, x: 500, y: 300 };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.positionSaved, true);
  });

  it("backfills positionSaved=false for files with x=0,y=0", () => {
    const raw = { version: 1, x: 0, y: 0 };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.positionSaved, false);
  });

  it("does not overwrite existing positionSaved field", () => {
    const raw = { version: 1, x: 0, y: 0, positionSaved: true };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.positionSaved, true);
  });
});

describe("prefs.migrate v4 → v5 (sessionHudAutoHide removal)", () => {
  it("auto-pins users who had sessionHudAutoHide=false (always-show)", () => {
    const upgraded = prefs.migrate({
      version: 4,
      sessionHudAutoHide: false,
      sessionHudPinned: false,
    });
    assert.strictEqual(upgraded.sessionHudPinned, true);
    assert.strictEqual("sessionHudAutoHide" in upgraded, false);
    assert.strictEqual(upgraded.version, prefs.CURRENT_VERSION);
  });

  it("leaves pinned untouched for users who had auto-hide enabled", () => {
    const upgraded = prefs.migrate({
      version: 4,
      sessionHudAutoHide: true,
      sessionHudPinned: false,
    });
    assert.strictEqual(upgraded.sessionHudPinned, false);
    assert.strictEqual("sessionHudAutoHide" in upgraded, false);
  });

  it("respects existing pinned=true even when sessionHudAutoHide=false", () => {
    const upgraded = prefs.migrate({
      version: 4,
      sessionHudAutoHide: false,
      sessionHudPinned: true,
    });
    assert.strictEqual(upgraded.sessionHudPinned, true);
    assert.strictEqual("sessionHudAutoHide" in upgraded, false);
  });

  it("treats missing sessionHudAutoHide as no-op (no pin auto-set)", () => {
    const upgraded = prefs.migrate({
      version: 4,
      sessionHudPinned: false,
    });
    assert.strictEqual(upgraded.sessionHudPinned, false);
    assert.strictEqual("sessionHudAutoHide" in upgraded, false);
  });

  it("ignores non-boolean sessionHudAutoHide (only strict === false triggers pin)", () => {
    for (const bad of ["yes", null, 0, "false"]) {
      const upgraded = prefs.migrate({
        version: 4,
        sessionHudAutoHide: bad,
        sessionHudPinned: false,
      });
      assert.strictEqual(
        upgraded.sessionHudPinned,
        false,
        `bad value ${JSON.stringify(bad)} should not trigger pin`
      );
      assert.strictEqual("sessionHudAutoHide" in upgraded, false);
    }
  });

  it("is idempotent on v5 input (skips the v4→v5 branch)", () => {
    const upgraded = prefs.migrate({
      version: 5,
      sessionHudPinned: false,
    });
    assert.strictEqual(upgraded.sessionHudPinned, false);
    assert.strictEqual("sessionHudAutoHide" in upgraded, false);
    assert.strictEqual(upgraded.version, prefs.CURRENT_VERSION);
  });

  it("does not let validate() re-populate the deprecated field after save", () => {
    const validated = prefs.validate(prefs.migrate({
      version: 4,
      sessionHudAutoHide: false,
    }));
    assert.strictEqual("sessionHudAutoHide" in validated, false);
    assert.strictEqual(validated.sessionHudPinned, true);
  });
});

describe("prefs.migrate v6 → v7 (Codex Native prompt sound default)", () => {
  it("moves the early Codex Native prompt sound default to off", () => {
    const upgraded = prefs.migrate({
      version: 6,
      agents: {
        codex: {
          enabled: true,
          permissionsEnabled: true,
          permissionMode: "native",
          nativeNotificationSoundEnabled: true,
        },
      },
    });
    assert.strictEqual(upgraded.version, prefs.CURRENT_VERSION);
    assert.strictEqual(upgraded.agents.codex.nativeNotificationSoundEnabled, false);
  });
});

describe("prefs.migrate v7 → v8 (Telegram bare completion default)", () => {
  it("turns old persisted bare completion pings off", () => {
    const upgraded = prefs.migrate({
      version: 7,
      tgApproval: {
        enabled: true,
        allowedTgUserId: "123456789",
        targetSessionKey: "telegram:123456789",
        notifyOnComplete: true,
        completionOutputMode: "full",
      },
    });
    const validated = prefs.validate(upgraded);

    assert.strictEqual(validated.version, prefs.CURRENT_VERSION);
    assert.strictEqual(validated.tgApproval.notifyOnComplete, false);
    assert.strictEqual(validated.tgApproval.completionOutputMode, "full");
    assert.strictEqual(validated.tgApproval.enabled, true);
  });

  it("migrates older prefs without Telegram approval settings safely", () => {
    const upgraded = prefs.migrate({
      version: 6,
      lang: "zh",
    });
    const validated = prefs.validate(upgraded);

    assert.strictEqual(validated.version, prefs.CURRENT_VERSION);
    assert.strictEqual(validated.lang, "zh");
    assert.strictEqual(validated.tgApproval.notifyOnComplete, false);
    assert.strictEqual(validated.tgApproval.completionOutputMode, "off");
  });
});

describe("prefs.migrate v8 → v9 (auto-approve auto-pilot)", () => {
  it("defaults autoApproveAllPermissions to false for upgrading users", () => {
    const upgraded = prefs.migrate({ version: 8, lang: "en" });
    const validated = prefs.validate(upgraded);
    assert.strictEqual(validated.version, prefs.CURRENT_VERSION);
    assert.strictEqual(validated.autoApproveAllPermissions, false);
  });

  it("clears a planted autoApproveAllPermissions=true on upgrade (never inherit auto-approval)", () => {
    // A v8 prefs file could not have legitimately set this key — it didn't
    // exist yet. Migration must strip any stale/planted value so an upgrading
    // user never silently inherits "approve everything".
    const validated = prefs.validate(
      prefs.migrate({ version: 8, autoApproveAllPermissions: true })
    );
    assert.strictEqual(validated.autoApproveAllPermissions, false);
  });

  it("fresh defaults keep auto-pilot off", () => {
    assert.strictEqual(prefs.getDefaults().autoApproveAllPermissions, false);
  });
});

describe("prefs.migrate v9 → v10 (compact HUD defaults are fresh-install only)", () => {
  it("backfills the old HUD defaults for pre-v10 files missing the keys", () => {
    // save() normally bakes every key, but files from pre-HUD-toggle builds
    // (or hand-trimmed ones) lack these two — without the backfill validate()
    // would hand existing users the flipped fresh-install defaults.
    for (const version of [8, 9]) {
      const validated = prefs.validate(prefs.migrate({ version, lang: "en" }));
      assert.strictEqual(validated.version, prefs.CURRENT_VERSION);
      assert.strictEqual(validated.sessionHudShowElapsed, true, `v${version}: elapsed stays on for upgraders`);
      assert.strictEqual(validated.sessionHudCleanupDetached, false, `v${version}: cleanup stays off for upgraders`);
    }
  });

  it("preserves explicit values that match neither old nor new default", () => {
    const validated = prefs.validate(prefs.migrate({
      version: 9,
      sessionHudShowElapsed: false,
      sessionHudCleanupDetached: true,
    }));
    assert.strictEqual(validated.sessionHudShowElapsed, false);
    assert.strictEqual(validated.sessionHudCleanupDetached, true);
  });

  it("fresh defaults (no prefs file, migrate never runs) get the compact HUD", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.sessionHudShowElapsed, false);
    assert.strictEqual(d.sessionHudCleanupDetached, true);
  });

  it("is idempotent on v10 input (a fresh-install save is not re-backfilled)", () => {
    // A v10 file that legitimately lacks the keys does not exist (save()
    // bakes them), but the branch must still not fire for v10 input.
    const upgraded = prefs.migrate({ version: 10 });
    assert.strictEqual("sessionHudShowElapsed" in upgraded, false);
    assert.strictEqual("sessionHudCleanupDetached" in upgraded, false);
  });
});

describe("prefs.migrate v10 → v11 (on-demand agent integrations)", () => {
  it("keeps missing old agent entries on the v11 fresh defaults", () => {
    const validated = prefs.validate(prefs.migrate({ version: 10, lang: "en" }));
    assert.strictEqual(validated.version, prefs.CURRENT_VERSION);
    assert.strictEqual(validated.agents["claude-code"].integrationInstalled, true);
    assert.strictEqual(validated.agents["claude-code"].enabled, true);
    assert.strictEqual(validated.agents.codex.integrationInstalled, true);
    assert.strictEqual(validated.agents.codex.enabled, true);
    assert.strictEqual(validated.agents["gemini-cli"].integrationInstalled, false);
    assert.strictEqual(validated.agents["gemini-cli"].enabled, false);
  });

  it("preserves existing enabled flags while backfilling installed intent", () => {
    const validated = prefs.validate(prefs.migrate({
      version: 10,
      agents: {
        codex: { enabled: false },
        "copilot-cli": { enabled: true },
      },
    }));
    assert.strictEqual(validated.agents.codex.enabled, false);
    assert.strictEqual(validated.agents.codex.integrationInstalled, true);
    assert.strictEqual(validated.agents["copilot-cli"].enabled, true);
    assert.strictEqual(validated.agents["copilot-cli"].integrationInstalled, true);
  });

  it("does not mark agent entries missing from old prefs as installed", () => {
    const validated = prefs.validate(prefs.migrate({
      version: 10,
      agents: {
        "claude-code": { enabled: true },
        codex: { enabled: true },
        "copilot-cli": { enabled: true },
      },
    }));
    assert.strictEqual(validated.agents["copilot-cli"].integrationInstalled, true);
    assert.strictEqual(validated.agents.qoder.integrationInstalled, false);
    assert.strictEqual(validated.agents.qoder.enabled, false);
  });

  it("does not mark v0 default-seeded agent entries as installed", () => {
    const validated = prefs.validate(prefs.migrate({ lang: "en" }));
    assert.strictEqual(validated.version, prefs.CURRENT_VERSION);
    assert.strictEqual(validated.agents["claude-code"].integrationInstalled, true);
    assert.strictEqual(validated.agents.codex.integrationInstalled, true);
    assert.strictEqual(validated.agents["gemini-cli"].integrationInstalled, false);
    assert.strictEqual(validated.agents["gemini-cli"].enabled, false);
  });

  it("does not mark migration-created Pi or missing v0 agent entries as installed", () => {
    const validated = prefs.validate(prefs.migrate({
      agents: {
        "claude-code": { enabled: true },
        "gemini-cli": { enabled: true },
      },
    }));
    assert.strictEqual(validated.agents["gemini-cli"].integrationInstalled, true);
    assert.strictEqual(validated.agents.qoder.integrationInstalled, false);
    assert.strictEqual(validated.agents.qoder.enabled, false);
    assert.strictEqual(validated.agents.pi.integrationInstalled, false);
    assert.strictEqual(validated.agents.pi.enabled, true);
  });

  it("does not resurrect an integrationInstalled=false value from current-version prefs", () => {
    const validated = prefs.validate(prefs.migrate({
      version: prefs.CURRENT_VERSION,
      agents: {
        "copilot-cli": {
          integrationInstalled: false,
          enabled: false,
          permissionsEnabled: true,
          notificationHookEnabled: true,
        },
      },
    }));
    assert.strictEqual(validated.agents["copilot-cli"].integrationInstalled, false);
    assert.strictEqual(validated.agents["copilot-cli"].enabled, false);
  });
});

describe("prefs.migrate v11 → v12 (showDock default off for fresh installs)", () => {
  it("backfills showDock=true for a pre-v12 file that lacks it (existing user keeps the Dock)", () => {
    const validated = prefs.validate(prefs.migrate({ version: 11, lang: "en" }));
    assert.strictEqual(validated.version, prefs.CURRENT_VERSION);
    assert.strictEqual(validated.showDock, true);
  });

  it("preserves an explicit showDock=false from a pre-v12 file", () => {
    const validated = prefs.validate(prefs.migrate({ version: 11, showDock: false }));
    assert.strictEqual(validated.showDock, false);
  });

  it("fresh defaults (no prefs file, migrate never runs) get showDock off", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.showDock, false);
  });

  it("is idempotent on v12 input (a fresh-install save is not re-backfilled)", () => {
    const upgraded = prefs.migrate({ version: 12 });
    assert.strictEqual("showDock" in upgraded, false);
  });
});

describe("prefs ephemeral fields (auto-pilot does not persist)", () => {
  it("validate() never restores a persisted autoApproveAllPermissions=true", () => {
    assert.strictEqual(prefs.validate({ autoApproveAllPermissions: true }).autoApproveAllPermissions, false);
  });

  it("save() strips autoApproveAllPermissions from the on-disk file", () => {
    const p = makeTempPath();
    prefs.save(p, { ...prefs.getDefaults(), autoApproveAllPermissions: true, lang: "zh" });
    const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual("autoApproveAllPermissions" in onDisk, false, "ephemeral key must not be written");
    assert.strictEqual(onDisk.lang, "zh", "non-ephemeral fields still persist");
  });

  it("survives a quit/relaunch as OFF even after being enabled mid-session", () => {
    const p = makeTempPath();
    // Session 1: user turned auto-pilot on, then the app persisted prefs.
    prefs.save(p, { ...prefs.getDefaults(), autoApproveAllPermissions: true });
    // Session 2: next launch reads prefs from disk.
    const { snapshot } = prefs.load(p);
    assert.strictEqual(snapshot.autoApproveAllPermissions, false, "auto-pilot must be off on relaunch");
  });

  it("load() ignores a hand-edited autoApproveAllPermissions:true in the file", () => {
    const p = makeTempPath();
    fs.writeFileSync(p, JSON.stringify({ version: prefs.CURRENT_VERSION, autoApproveAllPermissions: true }));
    const { snapshot } = prefs.load(p);
    assert.strictEqual(snapshot.autoApproveAllPermissions, false);
  });
});

describe("prefs.load", () => {
  it("returns defaults for missing file (ENOENT) without backup", () => {
    const p = makeTempPath();
    const { snapshot, locked } = prefs.load(p);
    assert.strictEqual(locked, false);
    assert.deepStrictEqual(snapshot, prefs.getDefaults());
    // Should NOT have created a backup since file never existed
    assert.strictEqual(fs.existsSync(p + ".bak"), false);
  });

  it("backs up corrupt JSON and returns defaults", () => {
    const p = makeTempPath();
    fs.writeFileSync(p, "{ this is not valid json", "utf8");
    const { snapshot, locked } = prefs.load(p);
    assert.strictEqual(locked, false);
    assert.deepStrictEqual(snapshot, prefs.getDefaults());
    assert.strictEqual(fs.existsSync(p + ".bak"), true);
    assert.strictEqual(
      fs.readFileSync(p + ".bak", "utf8"),
      "{ this is not valid json"
    );
  });

  it("migrates a v0 file (no version field) on load", () => {
    const p = makeTempPath();
    fs.writeFileSync(
      p,
      JSON.stringify({ lang: "zh", x: 100, y: 200, size: "P:12" }),
      "utf8"
    );
    const { snapshot, locked } = prefs.load(p);
    assert.strictEqual(locked, false);
    assert.strictEqual(snapshot.version, prefs.CURRENT_VERSION);
    assert.strictEqual(snapshot.lang, "zh");
    assert.strictEqual(snapshot.x, 100);
    assert.strictEqual(snapshot.y, 200);
    assert.strictEqual(snapshot.size, "P:12");
    // New fields populated from defaults
    assert.ok(snapshot.agents);
    assert.ok(snapshot.themeOverrides);
  });

  it("loads v2 prefs without locking or warning", () => {
    const p = makeTempPath();
    fs.writeFileSync(
      p,
      JSON.stringify({ version: 2, lang: "zh" }),
      "utf8"
    );
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
      const { snapshot, locked } = prefs.load(p);
      assert.strictEqual(locked, false);
      assert.strictEqual(snapshot.version, prefs.CURRENT_VERSION);
      assert.strictEqual(snapshot.lang, "zh");
      assert.strictEqual(warned, false);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("returns locked=true and warns for future-version files", () => {
    const p = makeTempPath();
    fs.writeFileSync(
      p,
      JSON.stringify({ version: 999, lang: "en" }),
      "utf8"
    );
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
      const { snapshot, locked } = prefs.load(p);
      assert.strictEqual(locked, true);
      assert.strictEqual(snapshot.lang, "en");
      assert.strictEqual(warned, true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("prefs.save", () => {
  it("writes a valid snapshot that round-trips through load", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.lang = "zh";
    snap.bubbleFollowPet = true;
    snap.x = 42;
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.strictEqual(snapshot.lang, "zh");
    assert.strictEqual(snapshot.bubbleFollowPet, true);
    assert.strictEqual(snapshot.x, 42);
    assert.strictEqual(snapshot.version, prefs.CURRENT_VERSION);
  });

  it("validates before writing — bad fields fall back to defaults on disk", () => {
    const p = makeTempPath();
    const dirty = {
      ...prefs.getDefaults(),
      lang: "klingon",
      x: NaN,
    };
    prefs.save(p, dirty);
    const written = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(written.lang, "en");
    assert.strictEqual(written.x, 0);
  });

  it("round-trips themeOverrides with disabled: true", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        states: {
          sweeping: { disabled: true },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.states.sweeping, { disabled: true });
  });

  it("themeOverrides: nested state entry preserves file + transition while keeping disabled", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        states: {
          attention: {
            disabled: true,
            sourceThemeId: "clawd",
            file: "clawd-happy.svg",
            transition: { in: 100, out: 220 },
          },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.states.attention, {
      disabled: true,
      sourceThemeId: "clawd",
      file: "clawd-happy.svg",
      transition: { in: 100, out: 220 },
    });
  });

  it("themeOverrides: state/tier/timing entries round-trip in Path A schema", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        states: {
          attention: {
            file: "clawd-happy.svg",
            transition: { in: 80, out: 140 },
          },
        },
        tiers: {
          workingTiers: {
            "clawd-working-typing.svg": {
              file: "custom-working.svg",
              transition: { in: 0, out: 90 },
            },
          },
        },
        timings: {
          autoReturn: { attention: 2800 },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd, {
      states: {
        attention: {
          file: "clawd-happy.svg",
          transition: { in: 80, out: 140 },
        },
      },
      tiers: {
        workingTiers: {
          "clawd-working-typing.svg": {
            file: "custom-working.svg",
            transition: { in: 0, out: 90 },
          },
        },
      },
      timings: {
        autoReturn: { attention: 2800 },
      },
    });
  });

  it("themeOverrides.sounds: round-trips per-soundName file entries", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        sounds: {
          complete: { file: "my-done.mp3" },
          confirm: { file: "nope.wav" },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.sounds, {
      complete: { file: "my-done.mp3" },
      confirm: { file: "nope.wav" },
    });
  });

  it("themeOverrides.sounds: drops entries with invalid / empty file and non-string keys", () => {
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          sounds: {
            complete: { file: "ok.mp3" },
            confirm: { file: "" },    // empty
            weird:    { durationMs: 1000 }, // no file → dropped
            "":       { file: "x.mp3" }, // empty key → dropped
          },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides.clawd.sounds, {
      complete: { file: "ok.mp3" },
    });
  });

  it("themeOverrides.sounds: strips ancillary fields (durationMs / transition / sourceThemeId) — sounds only keep file", () => {
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          sounds: {
            complete: { file: "ok.mp3", durationMs: 1000, transition: { in: 50 }, sourceThemeId: "x" },
          },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides.clawd.sounds, {
      complete: { file: "ok.mp3" },
    });
  });

  it("themeOverrides.sounds: preserves originalName when valid, basename-strips and caps length", () => {
    // originalName is display-only — stores what the user picked before the
    // copy renamed it to `${soundName}${ext}`. Sanitised to guard hand-edited
    // pref files from shoving path traversal / absurd strings into the UI.
    const longName = "a".repeat(300) + ".mp3";
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          sounds: {
            complete: { file: "complete.mp3", originalName: "cat-demo.mp3" },
            confirm:  { file: "confirm.wav", originalName: "../../etc/passwd.wav" }, // basenamed
            hiss:     { file: "hiss.mp3", originalName: ".." },                      // dropped
            purr:     { file: "purr.mp3", originalName: "" },                        // dropped
            growl:    { file: "growl.mp3", originalName: longName },                 // capped
          },
        },
      },
    });
    assert.strictEqual(validated.themeOverrides.clawd.sounds.complete.originalName, "cat-demo.mp3");
    assert.strictEqual(validated.themeOverrides.clawd.sounds.confirm.originalName, "passwd.wav");
    assert.strictEqual(validated.themeOverrides.clawd.sounds.hiss.originalName, undefined);
    assert.strictEqual(validated.themeOverrides.clawd.sounds.purr.originalName, undefined);
    assert.strictEqual(validated.themeOverrides.clawd.sounds.growl.originalName.length, 256);
  });

  it("themeOverrides.sounds: rejects path-unsafe soundName keys and basename-sanitises file", () => {
    // soundName becomes a filename stem under sound-overrides/<themeId>/ —
    // a malicious theme or hand-edited pref must not be able to escape that
    // directory. File paths with separators get basename-stripped.
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          sounds: {
            complete:      { file: "ok.mp3" },
            "../../evil":  { file: "x.mp3" },           // unsafe key → dropped
            "foo/bar":     { file: "x.mp3" },           // unsafe key → dropped
            "spaces bad":  { file: "x.mp3" },           // unsafe key → dropped
            confirm:       { file: "../../etc/passwd" },// unsafe file → basenamed
            quiet:         { file: ".." },               // bare `..` → dropped
          },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides.clawd.sounds, {
      complete: { file: "ok.mp3" },
      confirm:  { file: "passwd" },
    });
  });

  it("themeOverrides: legacy flat state entries normalize into states map", () => {
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          attention: { disabled: true },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides, {
      clawd: {
        states: {
          attention: { disabled: true },
        },
      },
    });
  });

  it("themeOverrides: reactions round-trip with file + durationMs + transition", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        reactions: {
          clickLeft: {
            file: "my-poke.svg",
            durationMs: 2200,
            transition: { in: 50, out: 100 },
          },
          double: { file: "my-double.svg", durationMs: 4000 },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.reactions, {
      clickLeft: {
        file: "my-poke.svg",
        durationMs: 2200,
        transition: { in: 50, out: 100 },
      },
      double: { file: "my-double.svg", durationMs: 4000 },
    });
  });

  it("themeOverrides: hitbox.wide round-trips boolean per-file flags", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        hitbox: {
          wide: {
            "clawd-error.svg": true,
            "clawd-idle.svg": false,
          },
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.hitbox, {
      wide: {
        "clawd-error.svg": true,
        "clawd-idle.svg": false,
      },
    });
  });

  it("themeOverrides: hitbox normalize drops non-boolean values", () => {
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          hitbox: {
            wide: {
              "ok.svg": true,
              "bad.svg": "yes",   // dropped
              "null-val.svg": null,  // dropped
            },
          },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides.clawd.hitbox, {
      wide: { "ok.svg": true },
    });
  });

  it("themeOverrides: normalize drops unknown reaction keys and strips durationMs from drag", () => {
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      themeOverrides: {
        clawd: {
          reactions: {
            explode: { file: "bogus.svg" },           // invalid key
            drag: { file: "my-drag.svg", durationMs: 9999 },  // drag can't have duration
            clickLeft: { file: "p.svg" },             // valid
          },
        },
      },
    });
    assert.deepStrictEqual(validated.themeOverrides.clawd.reactions, {
      drag: { file: "my-drag.svg" },     // durationMs stripped
      clickLeft: { file: "p.svg" },
      // explode: absent
    });
  });
});

describe("prefs.tutorialSeen (first-run tutorial gate)", () => {
  it("defaults to false on fresh defaults", () => {
    assert.strictEqual(prefs.getDefaults().tutorialSeen, false);
  });

  it("persists true across a save/load round-trip", () => {
    const p = makeTempPath();
    prefs.save(p, { ...prefs.getDefaults(), tutorialSeen: true });
    assert.strictEqual(prefs.load(p).snapshot.tutorialSeen, true);
  });

  it("resolves to false for an existing-user file lacking the key (they see it once too)", () => {
    const p = makeTempPath();
    // Pre-tutorial prefs file: current version, no tutorialSeen key at all.
    fs.writeFileSync(p, JSON.stringify({ version: prefs.CURRENT_VERSION, showTray: true }));
    assert.strictEqual(prefs.load(p).snapshot.tutorialSeen, false);
  });

  it("is NOT backfilled to true by migrate (unlike showDock)", () => {
    const migrated = prefs.migrate({ version: 1 });
    assert.notStrictEqual(migrated.tutorialSeen, true);
    // migrate never adds it; validate fills the false default so the user is unseen.
    assert.strictEqual(prefs.validate(migrated).tutorialSeen, false);
  });
});

describe("prefs.load fresh flag (brand-new install detection)", () => {
  it("flags fresh: true when there is no prefs file", () => {
    const p = makeTempPath();          // temp dir exists, prefs file does not
    assert.strictEqual(prefs.load(p).fresh, true);
  });

  it("does NOT flag fresh once a file exists", () => {
    const p = makeTempPath();
    prefs.save(p, prefs.getDefaults());
    assert.notStrictEqual(prefs.load(p).fresh, true);
  });

  it("does NOT flag fresh for a corrupt file (returning user — keep their language)", () => {
    const p = makeTempPath();
    fs.writeFileSync(p, "{ this is not valid json ");
    assert.notStrictEqual(prefs.load(p).fresh, true);
  });
});

describe("prefs.mapLocaleToLang (device locale → UI language)", () => {
  const cases = [
    ["en-US", "en"], ["en", "en"],
    ["zh-CN", "zh"], ["zh-Hans", "zh"], ["zh", "zh"],
    ["zh-TW", "zh-TW"], ["zh-Hant", "zh-TW"], ["zh-HK", "zh-TW"], ["zh-Hant-TW", "zh-TW"],
    ["ko-KR", "ko"], ["ko", "ko"],
    ["ja-JP", "ja"], ["ja", "ja"],
    ["fr-FR", "en"], ["de", "en"],
  ];
  for (const [input, expected] of cases) {
    it(`maps ${input} -> ${expected}`, () => {
      assert.strictEqual(prefs.mapLocaleToLang(input), expected);
    });
  }

  it("falls back to en for empty / non-string input", () => {
    assert.strictEqual(prefs.mapLocaleToLang(""), "en");
    assert.strictEqual(prefs.mapLocaleToLang(undefined), "en");
    assert.strictEqual(prefs.mapLocaleToLang(null), "en");
    assert.strictEqual(prefs.mapLocaleToLang(123), "en");
  });

  it("only ever returns a value inside the lang enum", () => {
    const enumVals = new Set(["en", "zh", "zh-TW", "ko", "ja"]);
    for (const probe of ["xx", "ZH-tw", "JA", "en-GB", "pt-BR", ""]) {
      assert.ok(enumVals.has(prefs.mapLocaleToLang(probe)), `${probe} mapped outside enum`);
    }
  });
});
