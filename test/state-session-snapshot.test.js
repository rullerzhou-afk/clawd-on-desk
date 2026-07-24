"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  deriveSessionBadge,
  deriveSourceInfo,
  isSessionInProgress,
  buildSessionSnapshot,
  getActiveSessionAliasKeys,
  sessionSnapshotSignature,
  sessionDisplayTitle,
} = require("../src/state-session-snapshot");
const { makeSessionKey } = require("../src/session-key");
const { sessionAliasKey } = require("../src/session-alias");

describe("deriveSourceInfo", () => {
  it("derives WSL source from the wsl: host prefix", () => {
    assert.deepStrictEqual(deriveSourceInfo("wsl:Ubuntu"), {
      sourceType: "wsl",
      sourceLabel: "Ubuntu",
      displayLabel: "WSL: Ubuntu",
    });
  });

  it("falls back to a stable label for a bare wsl: prefix", () => {
    assert.deepStrictEqual(deriveSourceInfo("wsl:"), {
      sourceType: "wsl",
      sourceLabel: "unknown",
      displayLabel: "WSL: unknown",
    });
  });

  it("treats any other non-local host as ssh", () => {
    assert.deepStrictEqual(deriveSourceInfo("devbox"), {
      sourceType: "ssh",
      sourceLabel: "devbox",
      displayLabel: "devbox",
    });
  });

  it("treats empty, null, and 'local' hosts as local", () => {
    for (const host of ["", null, undefined, "local"]) {
      assert.deepStrictEqual(deriveSourceInfo(host), {
        sourceType: "local",
        sourceLabel: "",
        displayLabel: "",
      });
    }
  });
});

const STATE_PRIORITY = {
  error: 8,
  notification: 7,
  sweeping: 6,
  attention: 5,
  carrying: 4,
  juggling: 4,
  working: 3,
  thinking: 2,
  idle: 1,
  sleeping: 0,
};

function session(state, overrides = {}) {
  return {
    state,
    updatedAt: 1000,
    cwd: "",
    agentId: "claude-code",
    recentEvents: [],
    ...overrides,
  };
}

describe("startup-recovered session snapshots", () => {
  it("exposes the marker, disables focus, and includes marker changes in the signature", () => {
    const recovered = buildSessionSnapshot(new Map([
      ["real-session", session("working", { sourcePid: 123, startupRecovered: true })],
    ]), { statePriority: STATE_PRIORITY });
    const live = buildSessionSnapshot(new Map([
      ["real-session", session("working", { sourcePid: 123 })],
    ]), { statePriority: STATE_PRIORITY });

    assert.strictEqual(recovered.sessions[0].startupRecovered, true);
    assert.strictEqual(recovered.sessions[0].canFocus, false);
    assert.strictEqual(recovered.sessions[0].focusTarget, null);
    assert.strictEqual(live.sessions[0].startupRecovered, false);
    assert.notStrictEqual(sessionSnapshotSignature(recovered), sessionSnapshotSignature(live));
  });
});

describe("remote profile action ids", () => {
  it("keeps canonical ids for actions while rendering raw ids and profile-scoped aliases", () => {
    const rawSessionId = "same-visible-id";
    const aId = makeSessionKey({ profileId: "profile-a", rawSessionId });
    const bId = makeSessionKey({ profileId: "profile-b", rawSessionId });
    const aliases = {
      [sessionAliasKey("shared-host", "codex", rawSessionId, { profileId: "profile-a" })]: {
        title: "Alpha",
        updatedAt: 1000,
      },
      [sessionAliasKey("shared-host", "codex", rawSessionId, { profileId: "profile-b" })]: {
        title: "Beta",
        updatedAt: 1000,
      },
    };
    const snapshot = buildSessionSnapshot(new Map([
      [aId, session("working", {
        profileId: "profile-a",
        rawSessionId,
        host: "shared-host",
        agentId: "codex",
      })],
      [bId, session("thinking", {
        profileId: "profile-b",
        rawSessionId,
        host: "shared-host",
        agentId: "codex",
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      sessionAliases: aliases,
    });

    assert.deepStrictEqual(snapshot.sessions.map((entry) => entry.id).sort(), [aId, bId].sort());
    assert.deepStrictEqual(snapshot.sessions.map((entry) => entry.rawSessionId), [
      rawSessionId,
      rawSessionId,
    ]);
    assert.deepStrictEqual(
      Object.fromEntries(snapshot.sessions.map((entry) => [entry.profileId, entry.displayTitle])),
      { "profile-a": "Alpha", "profile-b": "Beta" },
    );
  });
});

describe("isSessionInProgress state mapping", () => {
  it("treats persisted running states as in-progress and idle/sleeping/headless as not", () => {
    assert.strictEqual(isSessionInProgress(session("working")), true);
    assert.strictEqual(isSessionInProgress(session("thinking")), true);
    assert.strictEqual(isSessionInProgress(session("juggling")), true);
    assert.strictEqual(isSessionInProgress(session("idle")), false);
    assert.strictEqual(isSessionInProgress(session("sleeping")), false);
  });

  it("never counts headless sessions, even when active", () => {
    assert.strictEqual(isSessionInProgress(session("working", { headless: true })), false);
    assert.strictEqual(isSessionInProgress(session("thinking", { headless: true })), false);
  });

  it("returns false for nullish sessions", () => {
    assert.strictEqual(isSessionInProgress(null), false);
    assert.strictEqual(isSessionInProgress(undefined), false);
  });
});

describe("sessionDisplayTitle cwd fallback", () => {
  it("falls back to path.basename(cwd) for normal project paths", () => {
    assert.strictEqual(
      sessionDisplayTitle("qoderwork:abc123", session("working", { cwd: "/home/me/projects/myapp" })),
      "myapp"
    );
  });

  it("skips QoderWork internal workspace cwds so the HUD never shows a raw workspace id", () => {
    assert.strictEqual(
      sessionDisplayTitle("qoderwork:abc123", session("working", { agentId: "qoderwork", cwd: "/Users/me/.qoderwork/workspace/mqgw60jiigjsjcid" })),
      "qoderw.."
    );
    assert.strictEqual(
      sessionDisplayTitle("qoderwork:abc123", session("working", { agentId: "qoderwork", cwd: "C:\\Users\\me\\.qoderwork\\workspace\\abc123" })),
      "qoderw.."
    );
  });

  it("keeps the cwd basename for non-QoderWork agents even inside a QoderWork workspace dir", () => {
    assert.strictEqual(
      sessionDisplayTitle("claude:xyz789", session("working", { agentId: "claude-code", cwd: "/Users/me/.qoderwork/workspace/mqgw60jiigjsjcid" })),
      "mqgw60jiigjsjcid"
    );
  });
});

describe("state-session-snapshot badges", () => {
  it("derives running, done, interrupted, and idle badges", () => {
    assert.strictEqual(deriveSessionBadge(session("working")), "running");
    assert.strictEqual(deriveSessionBadge(session("sleeping")), "idle");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "Stop", state: "idle", at: 1 }],
    })), "done");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "event_msg:task_complete", state: "attention", at: 1 }],
    })), "done");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      requiresCompletionAck: true,
      recentEvents: [{ event: "stale-cleanup", state: "sleeping", at: 1 }],
    })), "done");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "PostToolUseFailure", state: "idle", at: 1 }],
    })), "interrupted");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "StopFailure", state: "idle", at: 1 }],
    })), "interrupted");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "ApiError", state: "idle", at: 1 }],
    })), "interrupted");
    assert.strictEqual(deriveSessionBadge(null), "idle");
  });
});

describe("state-session-snapshot builder", () => {
  it("builds ordered dashboard/menu groups and HUD summary with injected deps", () => {
    const sessions = new Map([
      ["old-working", session("working", {
        updatedAt: 1000,
        cwd: "/tmp/old-project",
        sessionTitle: "Fix login",
        editor: "code",
        platform: "webui",
        model: "gpt-5.4",
        provider: "openai",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
      ["latest-remote", session("idle", {
        updatedAt: 3000,
        cwd: "/tmp/latest-project",
        agentId: "codex",
        host: "remote-box",
        headless: true,
        recentEvents: [{ event: "MysteryEvent", state: "idle", at: 2900 }],
      })],
      ["error-local", session("error", {
        updatedAt: 2000,
        cwd: "/tmp/error-project",
        agentId: "missing-agent",
      })],
    ]);

    const snapshot = buildSessionSnapshot(sessions, {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: (agentId) => agentId === "missing-agent" ? null : `icon:${agentId}`,
    });

    assert.deepStrictEqual(snapshot.orderedIds, ["latest-remote", "error-local", "old-working"]);
    assert.deepStrictEqual(snapshot.menuOrderedIds, ["error-local", "old-working", "latest-remote"]);
    assert.deepStrictEqual(snapshot.groups, [
      { host: "", ids: ["error-local", "old-working"], displayHost: "" },
      { host: "remote-box", ids: ["latest-remote"], displayHost: "remote-box" },
    ]);
    assert.strictEqual(snapshot.hudTotalNonIdle, 2);
    assert.strictEqual(snapshot.hudLastSessionId, "error-local");
    assert.strictEqual(snapshot.hudLastTitle, "error-project");
    assert.strictEqual(snapshot.lastSessionId, "latest-remote");
    assert.strictEqual(snapshot.lastTitle, "latest-project");

    const oldWorking = snapshot.sessions.find((entry) => entry.id === "old-working");
    assert.strictEqual(oldWorking.badge, "running");
    assert.strictEqual(oldWorking.iconUrl, "icon:claude-code");
    assert.strictEqual(oldWorking.platform, "webui");
    assert.strictEqual(oldWorking.model, "gpt-5.4");
    assert.strictEqual(oldWorking.provider, "openai");
    assert.strictEqual(oldWorking.editor, "code");
    assert.strictEqual(oldWorking.sessionTitle, "Fix login");
    assert.strictEqual(oldWorking.displayTitle, "Fix login");
    assert.deepStrictEqual(oldWorking.lastEvent, {
      labelKey: "eventLabelPreToolUse",
      rawEvent: "PreToolUse",
      at: 900,
    });

    const taskCompleteSnapshot = buildSessionSnapshot(new Map([
      ["remote-complete", session("idle", {
        agentId: "codex",
        host: "remote-box",
        recentEvents: [{ event: "event_msg:task_complete", state: "attention", at: 3300 }],
      })],
      ["local-complete", session("idle", {
        agentId: "codex",
        host: null,
        recentEvents: [{ event: "event_msg:task_complete", state: "attention", at: 3400 }],
      })],
      ["remote-stale-complete", session("idle", {
        agentId: "codex",
        host: "remote-box",
        requiresCompletionAck: true,
        recentEvents: [
          { event: "event_msg:task_complete", state: "attention", at: 3500 },
          { event: "stale-cleanup", state: "sleeping", at: 3600 },
        ],
      })],
    ]), { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    const taskComplete = taskCompleteSnapshot.sessions.find((entry) => entry.id === "remote-complete");
    assert.strictEqual(taskComplete.badge, "done");
    assert.deepStrictEqual(taskComplete.lastEvent, {
      labelKey: "eventLabelStop",
      rawEvent: "event_msg:task_complete",
      at: 3300,
    });
    const localComplete = taskCompleteSnapshot.sessions.find((entry) => entry.id === "local-complete");
    assert.strictEqual(localComplete.badge, "done");
    assert.strictEqual(localComplete.requiresCompletionAck, false);
    const staleComplete = taskCompleteSnapshot.sessions.find((entry) => entry.id === "remote-stale-complete");
    assert.strictEqual(staleComplete.badge, "done");
    assert.deepStrictEqual(staleComplete.lastEvent, {
      labelKey: "eventLabelStop",
      rawEvent: "event_msg:task_complete",
      at: 3500,
    });

    const latestRemote = snapshot.sessions.find((entry) => entry.id === "latest-remote");
    assert.strictEqual(latestRemote.headless, true);
    assert.strictEqual(latestRemote.displayTitle, "latest-project");
    assert.deepStrictEqual(latestRemote.lastEvent, {
      labelKey: null,
      rawEvent: "MysteryEvent",
      at: 2900,
    });
  });

  it("exposes focus target metadata for terminal and Codex Desktop sessions", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["terminal", session("working", { sourcePid: 123 })],
      ["webui", session("working", { sourcePid: 456, platform: "webui" })],
      ["codex:019e115a-4df2-7ed0-b90e-8e6345aca777", session("working", {
        agentId: "codex",
        codexOriginator: "codex_work_desktop",
        codexSource: "vscode",
      })],
    ]));

    const byId = new Map(snapshot.sessions.map((entry) => [entry.id, entry]));
    assert.strictEqual(byId.get("terminal").canFocus, true);
    assert.deepStrictEqual(byId.get("terminal").focusTarget, { type: "terminal", url: null });
    assert.strictEqual(byId.get("webui").canFocus, false);
    assert.strictEqual(byId.get("webui").focusTarget, null);
    assert.strictEqual(byId.get("codex:019e115a-4df2-7ed0-b90e-8e6345aca777").canFocus, true);
    assert.deepStrictEqual(byId.get("codex:019e115a-4df2-7ed0-b90e-8e6345aca777").focusTarget, {
      type: "codex-thread",
      url: "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777",
    });
    assert.strictEqual(byId.get("codex:019e115a-4df2-7ed0-b90e-8e6345aca777").codexSource, "vscode");
  });

  it("downgrades Codex Desktop focus targets on Windows snapshots", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["codex:019e115a-4df2-7ed0-b90e-8e6345aca777", session("working", {
        agentId: "codex",
        codexOriginator: "codex_work_desktop",
        sourcePid: 123,
      })],
      ["codex:019e115b-4df2-7ed0-b90e-8e6345aca777", session("working", {
        agentId: "codex",
        codexOriginator: "Codex Desktop",
      })],
    ]), { focusHostPlatform: "win32" });

    const byId = new Map(snapshot.sessions.map((entry) => [entry.id, entry]));
    assert.strictEqual(byId.get("codex:019e115a-4df2-7ed0-b90e-8e6345aca777").canFocus, true);
    assert.deepStrictEqual(byId.get("codex:019e115a-4df2-7ed0-b90e-8e6345aca777").focusTarget, {
      type: "terminal",
      url: null,
    });
    assert.strictEqual(byId.get("codex:019e115b-4df2-7ed0-b90e-8e6345aca777").canFocus, false);
    assert.strictEqual(byId.get("codex:019e115b-4df2-7ed0-b90e-8e6345aca777").focusTarget, null);

    const nonWindowsSnapshot = buildSessionSnapshot(new Map([
      ["codex:019e115b-4df2-7ed0-b90e-8e6345aca777", session("working", {
        agentId: "codex",
        codexOriginator: "Codex Desktop",
      })],
    ]), { focusHostPlatform: "darwin" });
    assert.deepStrictEqual(nonWindowsSnapshot.sessions[0].focusTarget, {
      type: "codex-thread",
      url: "codex://threads/019e115b-4df2-7ed0-b90e-8e6345aca777",
    });
  });

  it("exposes assistant last output for completion companion consumers", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["done", session("idle", {
        assistantLastOutput: "Final assistant text",
        assistantLastOutputTruncated: true,
        recentEvents: [{ event: "Stop", state: "attention", at: 1 }],
      })],
    ]));
    const entry = snapshot.sessions.find((s) => s.id === "done");
    assert.strictEqual(entry.assistantLastOutput, "Final assistant text");
    assert.strictEqual(entry.assistantLastOutputTruncated, true);
  });

  it("does not expose focus targets for sessions hidden from the focusable UI surface", () => {
    const hiddenEndedSession = session("idle", {
      sourcePid: 123,
      pidReachable: true,
      agentPid: null,
      recentEvents: [{ event: "Stop", state: "idle", at: 1 }],
    });
    const snapshot = buildSessionSnapshot(new Map([
      ["headless", session("working", { sourcePid: 123, headless: true })],
      ["sleeping", session("sleeping", { sourcePid: 123 })],
      ["remote", session("working", { sourcePid: 123, host: "remote-box" })],
      ["hidden", hiddenEndedSession],
      ["codex:019e115a-4df2-7ed0-b90e-8e6345aca777", session("working", {
        agentId: "codex",
        codexOriginator: "Codex Desktop",
        headless: true,
      })],
    ]), {
      sessionHudCleanupDetached: true,
      isProcessAlive: () => false,
    });

    for (const entry of snapshot.sessions) {
      assert.strictEqual(entry.canFocus, false, entry.id);
      assert.strictEqual(entry.focusTarget, null, entry.id);
    }
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "hidden").hiddenFromHud, true);
  });

  it("applies aliases, Codex thread names, and Kiro cwd-scoped alias keys", () => {
    const sessions = new Map([
      ["claude-local", session("working", {
        updatedAt: 3000,
        cwd: "/repo/a",
        agentId: "claude-code",
        sessionTitle: "Raw title",
      })],
      ["codex:abc", session("thinking", {
        updatedAt: 2000,
        cwd: "/repo/b",
        agentId: "codex",
        sessionTitle: "Auto Summary",
      })],
      ["default", session("working", {
        updatedAt: 1000,
        cwd: "/repo/c",
        agentId: "kiro-cli",
      })],
    ]);

    const snapshot = buildSessionSnapshot(sessions, {
      statePriority: STATE_PRIORITY,
      sessionAliases: {
        "local|claude-code|claude-local": { title: "Claude review", updatedAt: 100 },
        "local|kiro-cli|default": { title: "Legacy Kiro", updatedAt: 100 },
        "local|kiro-cli|default|cwd:%2Frepo%2Fc": { title: "Kiro repo C", updatedAt: 200 },
      },
      readCodexThreadName: (id) => id === "codex:abc" ? "Thread name" : null,
    });

    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "claude-local").displayTitle, "Claude review");
    const codex = snapshot.sessions.find((entry) => entry.id === "codex:abc");
    assert.strictEqual(codex.sessionTitle, "Thread name");
    assert.strictEqual(codex.displayTitle, "Thread name");
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "default").displayTitle, "Kiro repo C");

    assert.deepStrictEqual(
      [...getActiveSessionAliasKeys(sessions)].sort(),
      [
        "local|claude-code|claude-local",
        "local|codex|codex:abc",
        "local|kiro-cli|default|cwd:%2Frepo%2Fc",
      ].sort()
    );
  });

  it("includes contextUsage in snapshot entries", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        contextUsage: {
          used: 1000,
          limit: 200000,
          percent: 1,
          source: "claude",
        },
      })],
    ]), { statePriority: STATE_PRIORITY });

    assert.deepStrictEqual(snapshot.sessions[0].contextUsage, {
      used: 1000,
      limit: 200000,
      percent: 1,
      source: "claude",
    });
  });

  // Account quota is session-independent (src/state-account-quota.js): it
  // enters the snapshot as a top-level list injected by the caller, never
  // as a per-session field.
  it("passes the injected accountQuota through and defaults it to empty", () => {
    const accountQuota = [{
      host: null,
      claudeQuota: {
        group: { claudeWeekly: { usedPercent: 41, resetAt: 1738831180000 } },
        updatedAt: 1738000000000,
      },
    }];
    const withQuota = buildSessionSnapshot(new Map(), { statePriority: STATE_PRIORITY, accountQuota });
    const withoutQuota = buildSessionSnapshot(new Map(), { statePriority: STATE_PRIORITY });

    assert.deepStrictEqual(withQuota.accountQuota, accountQuota);
    assert.deepStrictEqual(withoutQuota.accountQuota, []);
    // Cloned at the boundary: a caller mutating the array it passed in must
    // not reach into the completed snapshot.
    accountQuota[0].claudeQuota.group.claudeWeekly.usedPercent = 99;
    assert.strictEqual(withQuota.accountQuota[0].claudeQuota.group.claudeWeekly.usedPercent, 41);
  });

  it("snapshot signature tracks accountQuota groups + lastSeenAt, not updatedAt stamps", () => {
    const base = { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null };
    const group = { claudeWeekly: { usedPercent: 41 } };
    const a = buildSessionSnapshot(new Map(), {
      ...base,
      accountQuota: [{ host: "pi", claudeQuota: { group, updatedAt: 1, lastSeenAt: 60000 } }],
    });
    const sameGroupNewStamp = buildSessionSnapshot(new Map(), {
      ...base,
      accountQuota: [{ host: "pi", claudeQuota: { group, updatedAt: 2, lastSeenAt: 60000 } }],
    });
    const changedGroup = buildSessionSnapshot(new Map(), {
      ...base,
      accountQuota: [{ host: "pi", claudeQuota: { group: { claudeWeekly: { usedPercent: 55 } }, updatedAt: 2, lastSeenAt: 60000 } }],
    });
    const newerSeen = buildSessionSnapshot(new Map(), {
      ...base,
      accountQuota: [{ host: "pi", claudeQuota: { group, updatedAt: 1, lastSeenAt: 120000 } }],
    });

    assert.strictEqual(
      sessionSnapshotSignature(a),
      sessionSnapshotSignature(sameGroupNewStamp),
      "a bare stamp change must not re-broadcast"
    );
    assert.notStrictEqual(sessionSnapshotSignature(a), sessionSnapshotSignature(changedGroup));
    // lastSeenAt is minute-quantized in the store snapshot; when it moves,
    // the freshness labels changed and the broadcast must go out.
    assert.notStrictEqual(sessionSnapshotSignature(a), sessionSnapshotSignature(newerSeen));
  });

  it("marks detached ended idle sessions hidden from HUD only when cleanup is enabled and pid is dead", () => {
    const sessions = new Map([
      ["done-local", session("idle", {
        updatedAt: 3000,
        sourcePid: 9999,
        pidReachable: true,
        recentEvents: [{ event: "Stop", state: "attention", at: 2900 }],
      })],
      ["idle-local", session("idle", {
        updatedAt: 2000,
        sourcePid: 9998,
        pidReachable: true,
        recentEvents: [{ event: "AfterAgent", state: "idle", at: 1900 }],
      })],
    ]);

    const snapshot = buildSessionSnapshot(sessions, {
      statePriority: STATE_PRIORITY,
      sessionHudCleanupDetached: true,
      isProcessAlive: () => false,
    });

    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "done-local").hiddenFromHud, true);
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "idle-local").hiddenFromHud, false);
    assert.strictEqual(snapshot.hudTotalNonIdle, 1);
    assert.strictEqual(snapshot.hudLastSessionId, "idle-local");
  });

  it("hides older local Codex sessions that share one agent process from HUD", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["codex:old", session("working", {
        agentId: "codex",
        agentPid: 4242,
        updatedAt: 1000,
        cwd: "/repo/old",
      })],
      ["codex:new", session("idle", {
        agentId: "codex",
        agentPid: 4242,
        updatedAt: 2000,
        cwd: "/repo/new",
        recentEvents: [{ event: "Stop", state: "attention", at: 1900 }],
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => null,
    });

    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "codex:old").hiddenFromHud, true);
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "codex:new").hiddenFromHud, false);
    assert.strictEqual(snapshot.hudTotalNonIdle, 1);
    assert.strictEqual(snapshot.hudLastSessionId, "codex:new");
    assert.deepStrictEqual(snapshot.orderedIds, ["codex:new", "codex:old"]);
    assert.deepStrictEqual(snapshot.groups, [{ host: "", ids: ["codex:new", "codex:old"], displayHost: "" }]);
  });

  it("keeps Codex Desktop sessions that share one agent process visible in HUD", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["codex:desktop-a", session("working", {
        agentId: "codex",
        agentPid: 4242,
        codexOriginator: "codex_work_desktop",
        updatedAt: 1000,
        cwd: "/repo/a",
      })],
      ["codex:desktop-b", session("thinking", {
        agentId: "codex",
        agentPid: 4242,
        codexOriginator: "codex_work_desktop",
        updatedAt: 2000,
        cwd: "/repo/b",
      })],
      ["codex:guardian", session("working", {
        agentId: "codex",
        agentPid: 4242,
        codexOriginator: "codex_work_desktop",
        headless: true,
        updatedAt: 3000,
        cwd: "/repo/b",
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => null,
    });

    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "codex:desktop-a").hiddenFromHud, false);
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "codex:desktop-b").hiddenFromHud, false);
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "codex:guardian").headless, true);
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "codex:guardian").hiddenFromHud, false);
    assert.strictEqual(snapshot.hudTotalNonIdle, 2);
    assert.strictEqual(snapshot.hudLastSessionId, "codex:desktop-b");
  });

  it("snapshot signatures include visible fields but ignore icon URL churn", () => {
    const base = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        updatedAt: 1000,
        sessionTitle: "Title",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => "icon:a",
    });
    const sameExceptIcon = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        updatedAt: 1000,
        sessionTitle: "Title",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => "icon:b",
    });
    const differentTitle = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        updatedAt: 1000,
        sessionTitle: "Other title",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => "icon:a",
    });

    assert.strictEqual(sessionSnapshotSignature(base), sessionSnapshotSignature(sameExceptIcon));
    assert.notStrictEqual(sessionSnapshotSignature(base), sessionSnapshotSignature(differentTitle));
  });

  // #590 B2 — metadataUpdatedAt is a display-arbitration freshness stamp: it
  // must reach renderers via the snapshot but stay out of the signature (like
  // updatedAt), so stamping it can never re-trigger a broadcast by itself.
  it("entry carries metadataUpdatedAt but the signature ignores it", () => {
    const opts = { statePriority: STATE_PRIORITY, getAgentIconUrl: () => "icon:a" };
    const stamped = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        updatedAt: 1000,
        metadataUpdatedAt: 5000,
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
    ]), opts);
    const restamped = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        updatedAt: 1000,
        metadataUpdatedAt: 9000,
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
    ]), opts);

    assert.strictEqual(stamped.sessions[0].metadataUpdatedAt, 5000);
    assert.strictEqual(sessionSnapshotSignature(stamped), sessionSnapshotSignature(restamped));
  });

  // ── PR2: requiresCompletionAck exposure ──
  it("entry includes requiresCompletionAck=false for normal sessions", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["a", session("idle", { recentEvents: [{ event: "PreToolUse", state: "idle", at: 1 }] })],
    ]), { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    const entry = snapshot.sessions.find((s) => s.id === "a");
    assert.strictEqual(entry.requiresCompletionAck, false);
  });

  it("entry includes requiresCompletionAck=true when the session flag is set", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["a", session("idle", {
        requiresCompletionAck: true,
        recentEvents: [{ event: "Stop", state: "idle", at: 1 }],
      })],
    ]), { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    const entry = snapshot.sessions.find((s) => s.id === "a");
    assert.strictEqual(entry.requiresCompletionAck, true);
  });

  it("ackedAt stays internal — does NOT appear in the snapshot entry", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["a", session("idle", { ackedAt: 12345, requiresCompletionAck: false })],
    ]), { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    const entry = snapshot.sessions.find((s) => s.id === "a");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, "ackedAt"), false);
  });

  it("snapshot signature changes when requiresCompletionAck flips", () => {
    const baseSessions = new Map([
      ["a", session("idle", { recentEvents: [{ event: "Stop", state: "idle", at: 1 }] })],
    ]);
    const flaggedSessions = new Map([
      ["a", session("idle", {
        requiresCompletionAck: true,
        recentEvents: [{ event: "Stop", state: "idle", at: 1 }],
      })],
    ]);
    const base = buildSessionSnapshot(baseSessions, { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    const flagged = buildSessionSnapshot(flaggedSessions, { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    assert.notStrictEqual(sessionSnapshotSignature(base), sessionSnapshotSignature(flagged));
  });

  it("exposes a resolved custom agent name and includes it in the snapshot signature", () => {
    const sessions = new Map([
      ["custom-session", session("working", { agentId: "custom-nova-0123456789ab" })],
    ]);
    const nova = buildSessionSnapshot(sessions, {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => null,
      resolveAgentDisplayName: () => "Nova AI",
    });
    const renamed = buildSessionSnapshot(sessions, {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => null,
      resolveAgentDisplayName: () => "Nova Desktop",
    });

    assert.strictEqual(nova.sessions[0].agentName, "Nova AI");
    assert.notStrictEqual(sessionSnapshotSignature(nova), sessionSnapshotSignature(renamed));
  });
});
