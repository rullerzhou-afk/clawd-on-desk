"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  INTERNAL_WORKSPACE_AGENTS,
  deriveSessionBadge,
  deriveSourceInfo,
  isDoneEvent,
  isSessionInProgress,
  buildDisplaySessionTag,
  buildSessionSnapshotEntry,
  buildSessionSnapshot,
  getActiveSessionAliasKeys,
  sessionSnapshotSignature,
  sessionDisplayFolder,
  sessionDisplayTitle,
  normalizeTitle,
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

describe("isDoneEvent", () => {
  it("is the shared completion boundary for state arbitration and snapshots", () => {
    assert.strictEqual(isDoneEvent("Stop"), true);
    assert.strictEqual(isDoneEvent("event_msg:task_complete"), true);
    assert.strictEqual(isDoneEvent("PostCompact"), false);
  });
});

describe("normalizeTitle", () => {
  it("strips Unicode bidi formatting marks before UI snapshots", () => {
    assert.strictEqual(
      normalizeTitle("safe\u061c\u200efile\u202etxt.exe\u2066done\u2069"),
      "safe file txt.exe done"
    );
  });

  it("does not split astral characters or preserve unpaired surrogates", () => {
    const truncated = normalizeTitle(`${"A".repeat(78)}😀BC`);
    assert.strictEqual(truncated, `${"A".repeat(78)}😀…`);
    assert.strictEqual(truncated.isWellFormed(), true);
    assert.strictEqual(Array.from(truncated).length, 80);
    assert.strictEqual(normalizeTitle("before\uD83Dmiddle\uDC00after"), "before�middle�after");
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

describe("display session tags", () => {
  it("hashes legal canonical ids into stable 10-hex display tags", () => {
    const canonical = makeSessionKey({
      profileId: "local",
      rawSessionId: "token-1234567890-abcdef",
    });

    assert.strictEqual(canonical, "s1.bG9jYWw.dG9rZW4tMTIzNDU2Nzg5MC1hYmNkZWY");
    assert.strictEqual(buildDisplaySessionTag(canonical), "83aacb6af9");
    assert.match(buildDisplaySessionTag(canonical), /^[0-9a-f]{10}$/);
  });

  it("returns an empty tag for missing, non-string, or blank ids", () => {
    for (const value of [null, undefined, "", "   ", 42, true, {}, []]) {
      assert.strictEqual(buildDisplaySessionTag(value), "", String(value));
    }
  });

  it("distinguishes real Codex UUIDv7-shaped raw ids after canonicalization", () => {
    const first = makeSessionKey({
      profileId: "local",
      rawSessionId: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
    });
    const second = makeSessionKey({
      profileId: "local",
      rawSessionId: "codex:019e115b-4df2-7ed0-b90e-8e6345aca777",
    });

    assert.strictEqual(buildDisplaySessionTag(first), "732d7659d7");
    assert.strictEqual(buildDisplaySessionTag(second), "b8a6f6f6ac");
    assert.notStrictEqual(buildDisplaySessionTag(first), buildDisplaySessionTag(second));
  });

  it("distinguishes the same raw id in different remote profiles", () => {
    const rawSessionId = "same-visible-id";
    const a = makeSessionKey({ profileId: "profile-a", rawSessionId });
    const b = makeSessionKey({ profileId: "profile-b", rawSessionId });

    assert.notStrictEqual(buildDisplaySessionTag(a), buildDisplaySessionTag(b));
  });

  it("snapshot entries expose a tag derived only from the canonical id", () => {
    const id = makeSessionKey({ profileId: "local", rawSessionId: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777" });
    const withRaw = buildSessionSnapshotEntry(id, session("working", {
      rawSessionId: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
    }));
    const withoutRaw = buildSessionSnapshotEntry(id, session("working"));

    assert.strictEqual(withRaw.displaySessionTag, "732d7659d7");
    assert.strictEqual(withoutRaw.displaySessionTag, withRaw.displaySessionTag);
    for (const forbidden of ["s1.", "bG9", "codex:", "019e11"]) {
      assert.strictEqual(withRaw.displaySessionTag.includes(forbidden), false, forbidden);
    }
  });

  it("snapshot signature tracks the visible display session tag field", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["tagged", session("working")],
    ]), { statePriority: STATE_PRIORITY });
    const changed = JSON.parse(JSON.stringify(snapshot));
    changed.sessions[0].displaySessionTag = "deadbeef00";

    assert.notStrictEqual(sessionSnapshotSignature(snapshot), sessionSnapshotSignature(changed));
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

  it("keeps a local OpenCode working session in the blocker-facing in-progress set", () => {
    const active = session("working", { agentId: "opencode" });
    assert.strictEqual(isSessionInProgress(active), true);
    assert.strictEqual(isSessionInProgress({ ...active, state: "idle" }), false);
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
  it("publishes a cross-platform display folder without changing the raw cwd", () => {
    assert.strictEqual(
      sessionDisplayFolder("claude:abc123", session("working", { cwd: "C:\\work\\project\\" })),
      "project"
    );
    assert.strictEqual(
      sessionDisplayFolder("claude:abc123", session("working", { cwd: "/work/project/" })),
      "project"
    );

    const cwd = "/work/project";
    const snapshot = buildSessionSnapshot(new Map([
      ["claude:abc123", session("working", { cwd })],
    ]), { statePriority: STATE_PRIORITY });
    assert.strictEqual(snapshot.sessions[0].displayFolder, "project");
    assert.strictEqual(snapshot.sessions[0].cwd, cwd, "focus/open-folder keeps the full cwd");
  });

  it("derives normal project basenames independent of the host platform", () => {
    assert.strictEqual(
      sessionDisplayTitle("qoderwork:abc123", session("working", { cwd: "/home/me/projects/myapp" })),
      "myapp"
    );
    assert.strictEqual(
      sessionDisplayTitle("claude:abc123", session("working", { cwd: "C:\\Users\\me\\projects\\myapp" })),
      "myapp"
    );
    assert.strictEqual(
      sessionDisplayTitle("claude:abc123", session("working", { cwd: "\\\\server\\share\\projects\\myapp" })),
      "myapp"
    );
    assert.strictEqual(
      sessionDisplayTitle("claude:abc123", session("working", { cwd: "C:/Users/me/projects\\myapp" })),
      "myapp"
    );
    assert.strictEqual(
      sessionDisplayTitle("claude:abc123", session("working", { cwd: "//server/share/projects\\myapp" })),
      "myapp"
    );
    assert.strictEqual(
      sessionDisplayTitle("claude:abc123", session("working", { cwd: "//?/C:/Users/me/projects\\myapp" })),
      "myapp"
    );
  });

  it("preserves backslashes that are part of a POSIX path component", () => {
    assert.strictEqual(
      sessionDisplayTitle("claude:abc123", session("working", { cwd: "/tmp/project\\name" })),
      "project\\name"
    );
    assert.strictEqual(
      sessionDisplayTitle("claude:abc123", session("working", { cwd: "/\\mount/project\\name" })),
      "project\\name"
    );
  });

  it("falls back to the session id for filesystem roots", () => {
    for (const cwd of ["/", "C:\\"]) {
      assert.strictEqual(
        sessionDisplayTitle("claude:canonical", session("working", { cwd, rawSessionId: "root42" })),
        "root42"
      );
    }
  });

  it("skips QoderWork internal workspace cwds so the HUD never shows a raw workspace id", () => {
    assert.strictEqual(
      sessionDisplayTitle("qoderwork:abc123", session("working", { agentId: "qoderwork", cwd: "/Users/me/.qoderwork/workspace/mqgw60jiigjsjcid" })),
      "abc123"
    );
    assert.strictEqual(
      sessionDisplayTitle("qoderwork:abc123", session("working", { agentId: "qoderwork", cwd: "C:\\Users\\me\\.qoderwork\\workspace\\abc123" })),
      "abc123"
    );
    assert.strictEqual(
      sessionDisplayFolder("qoderwork:abc123", session("working", { agentId: "qoderwork", cwd: "/Users/me/.qoderwork/workspace/mqgw60jiigjsjcid" })),
      ""
    );
  });

  it("skips QoderWork internal workspace cwds with trailing separators", () => {
    assert.strictEqual(
      sessionDisplayTitle("qoderwork:abc123", session("working", { agentId: "qoderwork", cwd: "/Users/me/.qoderwork/workspace/opaque-id///" })),
      "abc123"
    );
    assert.strictEqual(
      sessionDisplayTitle("qoderwork:abc123", session("working", { agentId: "qoderwork", cwd: "C:\\Users\\me\\.qoderwork\\workspace\\opaque-id\\" })),
      "abc123"
    );
  });

  it("keeps the cwd basename for non-QoderWork agents even inside a QoderWork workspace dir", () => {
    assert.strictEqual(
      sessionDisplayTitle("claude:xyz789", session("working", { agentId: "claude-code", cwd: "/Users/me/.qoderwork/workspace/mqgw60jiigjsjcid" })),
      "mqgw60jiigjsjcid"
    );
  });

  // ── #843: QwenWork's internal workspace ──────────────────────────────────
  // qwenwork-hook.js correctly refuses to send cwd as session_title, but the
  // server-side basename fallback below is what actually reaches the HUD /
  // Dashboard / session menu — and it only knew about ~/.qoderwork/workspace,
  // so ~/.QwenWorkCN/workspace/<id> still surfaced as "mqgw60jiigjsjcid".
  describe("QwenWork internal workspace (#843)", () => {
    const qwen = (overrides) => session("working", { agentId: "qwenwork", ...overrides });

    it("skips the basename for macOS/POSIX workspace cwds", () => {
      assert.strictEqual(
        sessionDisplayTitle("qwenwork:abc123", qwen({ cwd: "/Users/me/.QwenWorkCN/workspace/mqgw60jiigjsjcid" })),
        "abc123"
      );
      assert.strictEqual(
        sessionDisplayFolder("qwenwork:abc123", qwen({ cwd: "/Users/me/.QwenWorkCN/workspace/mqgw60jiigjsjcid" })),
        ""
      );
    });

    it("skips the basename for Windows backslash workspace cwds", () => {
      assert.strictEqual(
        sessionDisplayTitle("qwenwork:abc123", qwen({ cwd: "C:\\Users\\me\\.QwenWorkCN\\workspace\\mqgw60jiigjsjcid" })),
        "abc123"
      );
    });

    it("matches .QwenWorkCN case-insensitively", () => {
      // macOS and Windows are both case-insensitive, so the reported cwd can
      // arrive in any spelling of the case-preserving on-disk directory.
      for (const dir of [".QwenWorkCN", ".qwenworkcn", ".QWENWORKCN", ".QwenWorkCn"]) {
        assert.strictEqual(
          sessionDisplayTitle("qwenwork:abc123", qwen({ cwd: `/Users/me/${dir}/workspace/mqgw60jiigjsjcid` })),
          "abc123",
          dir
        );
      }
    });

    it("skips the basename when only the session id is namespaced (agentId missing)", () => {
      // Older persisted sessions and menu callers can reach here with the
      // namespaced id but no agentId, so the prefix is the fallback signal.
      const withoutAgentId = {
        state: "working",
        updatedAt: 1000,
        recentEvents: [],
        cwd: "/Users/me/.QwenWorkCN/workspace/mqgw60jiigjsjcid",
      };
      assert.strictEqual(sessionDisplayTitle("qwenwork:abc123", withoutAgentId), "abc123");
    });

    it("strips the namespace before shortening so concurrent fallback titles remain distinct", () => {
      const cwd = "/Users/me/.QwenWorkCN/workspace/mqgw60jiigjsjcid";
      const first = sessionDisplayTitle("canonical-a", qwen({ rawSessionId: "qwenwork:abc123456789", cwd }));
      const second = sessionDisplayTitle("canonical-b", qwen({ rawSessionId: "qwenwork:xyz999456789", cwd }));

      assert.strictEqual(first, "abc123..");
      assert.strictEqual(second, "xyz999..");
      assert.notStrictEqual(first, second);
    });

    it("keeps a readable namespace fallback when the raw session id is only the prefix", () => {
      const cwd = "/Users/me/.QwenWorkCN/workspace/mqgw60jiigjsjcid";
      assert.strictEqual(
        sessionDisplayTitle("canonical", qwen({ rawSessionId: "qwenwork:", cwd })),
        "qwenwo.."
      );
      assert.strictEqual(
        sessionDisplayTitle("canonical", qwen({ rawSessionId: "qwenwork:   ", cwd })),
        "qwenwo.."
      );
    });

    it("suppresses workspace ids when cwd has trailing POSIX or Windows separators", () => {
      assert.strictEqual(
        sessionDisplayTitle("qwenwork:abc123", qwen({ cwd: "/Users/me/.QwenWorkCN/workspace/opaque-id///" })),
        "abc123"
      );
      assert.strictEqual(
        sessionDisplayTitle("qwenwork:abc123", qwen({ cwd: "C:\\Users\\me\\.QwenWorkCN\\workspace\\opaque-id\\" })),
        "abc123"
      );
    });

    it("lets an explicit agentId beat a contradictory session-id prefix", () => {
      // Tightening vs the previous QoderWork-only check, which OR'd the two
      // signals: a session that says it belongs to another agent is not
      // silently reclassified by its id string.
      assert.strictEqual(
        sessionDisplayTitle(
          "qwenwork:abc123",
          session("working", { agentId: "claude-code", cwd: "/Users/me/.QwenWorkCN/workspace/mqgw60jiigjsjcid" })
        ),
        "mqgw60jiigjsjcid"
      );
      assert.strictEqual(
        sessionDisplayTitle(
          "qwenwork:abc123",
          session("working", { agentId: "claude-code", cwd: "" })
        ),
        "qwenwo..",
        "the namespace is only stripped when it agrees with the explicit agent"
      );
    });

    it("keeps the basename for other agents inside the same directory", () => {
      // The suppression is an agent↔path pairing: for any other agent that
      // directory is just a cwd the user chose, so its name is real information.
      assert.strictEqual(
        sessionDisplayTitle(
          "claude:xyz789",
          session("working", { agentId: "claude-code", cwd: "/Users/me/.QwenWorkCN/workspace/mqgw60jiigjsjcid" })
        ),
        "mqgw60jiigjsjcid"
      );
      assert.strictEqual(
        sessionDisplayTitle(
          "qoderwork:xyz789",
          session("working", { agentId: "qoderwork", cwd: "/Users/me/.QwenWorkCN/workspace/mqgw60jiigjsjcid" })
        ),
        "mqgw60jiigjsjcid",
        "QoderWork must not inherit QwenWork's path rule"
      );
    });

    it("still shows the basename for ordinary QwenWork project cwds", () => {
      assert.strictEqual(
        sessionDisplayTitle("qwenwork:abc123", qwen({ cwd: "/Users/me/projects/myapp" })),
        "myapp"
      );
      // A path that merely lives under .QwenWorkCN but is not a workspace leaf.
      assert.strictEqual(
        sessionDisplayTitle("qwenwork:abc123", qwen({ cwd: "/Users/me/.QwenWorkCN/workspace/abc/src" })),
        "src"
      );
      assert.strictEqual(
        sessionDisplayTitle("qwenwork:abc123", qwen({ cwd: "C:\\Users\\me\\qwenwork-notes" })),
        "qwenwork-notes"
      );
    });

    it("still prefers a real session title over the id shortening", () => {
      assert.strictEqual(
        sessionDisplayTitle("qwenwork:abc123", qwen({
          cwd: "/Users/me/.QwenWorkCN/workspace/mqgw60jiigjsjcid",
          sessionTitle: "Refactor auth module",
        })),
        "Refactor auth module"
      );
    });
  });

  it("declares the internal-workspace suppression as an explicit agent/path pairing", () => {
    assert.deepStrictEqual(
      INTERNAL_WORKSPACE_AGENTS.map((entry) => entry.agentId).sort(),
      ["qoderwork", "qwenwork"]
    );
    for (const entry of INTERNAL_WORKSPACE_AGENTS) {
      assert.strictEqual(entry.sessionPrefix, `${entry.agentId}:`);
      assert.ok(entry.cwdPattern instanceof RegExp);
      assert.strictEqual(entry.cwdPattern.global, false, "a global regex would carry lastIndex between calls");
    }
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
  it("derives session automation fields and keeps hidden-session grants revocable as orphans", () => {
    const records = [
      {
        agentId: "claude-code",
        sessionId: "eligible",
        mode: "auto-tools",
        grantId: "g-current",
        displayLabel: "project",
        createdAt: 10,
      },
      {
        agentId: "claude-code",
        sessionId: "hidden",
        mode: "off",
        grantId: "g-orphan",
        displayLabel: "hidden project",
        createdAt: 20,
      },
      {
        agentId: "opencode",
        sessionId: "blocked",
        mode: "off",
        grantId: "g-blocked",
        displayLabel: "blocked project",
        createdAt: 30,
      },
    ];
    const snapshot = buildSessionSnapshot(new Map([
      ["eligible", session("working", {
        agentId: "claude-code",
        sessionAutomationIdentity: { eligible: true, reason: "verified" },
      })],
      ["blocked", session("working", {
        agentId: "opencode",
        sessionAutomationIdentity: { eligible: false, reason: "association-unverified" },
      })],
    ]), {
      permissionAutomationMode: "off",
      sessionAutomationRecords: records,
    });
    const byId = new Map(snapshot.sessions.map((entry) => [entry.id, entry]));
    assert.deepStrictEqual({
      mode: byId.get("eligible").sessionAutomationMode,
      grantId: byId.get("eligible").sessionAutomationGrantId,
      effective: byId.get("eligible").sessionAutomationEffectiveMode,
      canConfigure: byId.get("eligible").canConfigureSessionAutomation,
      disabledReason: byId.get("eligible").sessionAutomationDisabledReason,
    }, {
      mode: "auto-tools",
      grantId: "g-current",
      effective: "auto-tools",
      canConfigure: true,
      disabledReason: null,
    });
    assert.equal(byId.get("blocked").canConfigureSessionAutomation, false);
    assert.equal(byId.get("blocked").sessionAutomationDisabledReason, "association-unverified");
    assert.equal(
      byId.get("blocked").sessionAutomationEffectiveMode,
      "off",
      "an existing record remains the displayed effective mode even if the identity later becomes ineligible"
    );
    assert.deepStrictEqual(snapshot.sessionAutomationOrphans, [{
      agentId: "claude-code",
      sessionId: "hidden",
      mode: "off",
      sessionAutomationGrantId: "g-orphan",
      displayLabel: "hidden project",
      createdAt: 20,
    }]);
    assert.match(sessionSnapshotSignature(snapshot), /g-orphan/);
  });

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
    const rawCodexSessionId = "codex:019e115a-4df2-7ed0-b90e-8e6345aca777";
    const scopedCodexSessionId = makeSessionKey({
      profileId: "local",
      rawSessionId: rawCodexSessionId,
    });
    const snapshot = buildSessionSnapshot(new Map([
      ["terminal", session("working", { sourcePid: 123 })],
      ["webui", session("working", { sourcePid: 456, platform: "webui" })],
      ["remote-orca", session("working", {
        host: "remote-box",
        orcaPaneKey: "tab-remote:leaf-remote",
      })],
      [scopedCodexSessionId, session("working", {
        agentId: "codex",
        rawSessionId: rawCodexSessionId,
        codexOriginator: "codex_work_desktop",
        codexSource: "vscode",
      })],
    ]), { focusHostPlatform: "darwin" });

    const byId = new Map(snapshot.sessions.map((entry) => [entry.id, entry]));
    assert.strictEqual(byId.get("terminal").canFocus, true);
    assert.deepStrictEqual(byId.get("terminal").focusTarget, { type: "terminal", url: null });
    assert.strictEqual(byId.get("webui").canFocus, false);
    assert.strictEqual(byId.get("webui").focusTarget, null);
    assert.strictEqual(byId.get("remote-orca").canFocus, true);
    assert.deepStrictEqual(byId.get("remote-orca").focusTarget, { type: "terminal", url: null });
    assert.strictEqual(byId.get(scopedCodexSessionId).canFocus, true);
    assert.deepStrictEqual(byId.get(scopedCodexSessionId).focusTarget, {
      type: "codex-thread",
      url: "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777",
    });
    assert.strictEqual(byId.get(scopedCodexSessionId).codexSource, "vscode");
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
    const claudeId = makeSessionKey({ profileId: "local", rawSessionId: "claude-local" });
    const codexId = makeSessionKey({ profileId: "local", rawSessionId: "codex:abc" });
    const kiroId = makeSessionKey({ profileId: "local", rawSessionId: "default" });
    const sessions = new Map([
      [claudeId, session("working", {
        updatedAt: 3000,
        cwd: "/repo/a",
        agentId: "claude-code",
        profileId: "local",
        rawSessionId: "claude-local",
        sessionTitle: "Raw title",
      })],
      [codexId, session("thinking", {
        updatedAt: 2000,
        cwd: "/repo/b",
        agentId: "codex",
        profileId: "local",
        rawSessionId: "codex:abc",
        sessionTitle: "Auto Summary",
      })],
      [kiroId, session("working", {
        updatedAt: 1000,
        cwd: "/repo/c",
        agentId: "kiro-cli",
        profileId: "local",
        rawSessionId: "default",
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

    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === claudeId).displayTitle, "Claude review");
    const codex = snapshot.sessions.find((entry) => entry.id === codexId);
    assert.strictEqual(codex.sessionTitle, "Thread name");
    assert.strictEqual(codex.displayTitle, "Thread name");
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === kiroId).displayTitle, "Kiro repo C");

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
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(snapshot.sessions[0], "contextUsageOrigin"),
      false,
      "source authority is internal state, not renderer-facing data",
    );
  });

  it("carries the opencode source through snapshot entries (#830)", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["opencode:s1", session("working", {
        contextUsage: {
          used: 32000,
          limit: 128000,
          percent: 25,
          source: "opencode",
        },
      })],
    ]), { statePriority: STATE_PRIORITY });

    assert.deepStrictEqual(snapshot.sessions[0].contextUsage, {
      used: 32000,
      limit: 128000,
      percent: 25,
      source: "opencode",
    });
  });

  it("ignores internal context authority when computing the renderer snapshot signature", () => {
    const opts = { statePriority: STATE_PRIORITY };
    const transcript = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        contextUsage: { used: 1000, limit: 200000, percent: 1, source: "claude" },
        contextUsageOrigin: "claude-transcript",
      })],
    ]), opts);
    const statusline = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        contextUsage: { used: 1000, limit: 200000, percent: 1, source: "claude" },
        contextUsageOrigin: "claude-statusline",
      })],
    ]), opts);

    assert.strictEqual(sessionSnapshotSignature(transcript), sessionSnapshotSignature(statusline));
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

  it("snapshot signature tracks Spark group and lastSeenAt changes", () => {
    const base = { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null };
    const build = (usedPercent, updatedAt, lastSeenAt) => buildSessionSnapshot(new Map(), {
      ...base,
      accountQuota: [{
        host: null,
        codexSparkQuota: {
          group: { codexWeekly: { usedPercent, windowMinutes: 10080 } },
          updatedAt,
          lastSeenAt,
        },
      }],
    });
    const original = build(7, 1, 60000);
    const stampOnly = build(7, 2, 60000);
    const changedValue = build(9, 2, 60000);
    const changedSeen = build(7, 1, 120000);

    assert.strictEqual(sessionSnapshotSignature(original), sessionSnapshotSignature(stampOnly));
    assert.notStrictEqual(sessionSnapshotSignature(original), sessionSnapshotSignature(changedValue));
    assert.notStrictEqual(sessionSnapshotSignature(original), sessionSnapshotSignature(changedSeen));
  });

  it("snapshot signature tracks Kimi group and lastSeenAt changes", () => {
    const base = { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null };
    const build = (usedPercent, updatedAt, lastSeenAt) => buildSessionSnapshot(new Map(), {
      ...base,
      accountQuota: [{
        host: null,
        kimiQuota: {
          group: { kimiWeekly: { usedPercent, windowMinutes: 10080 } },
          updatedAt,
          lastSeenAt,
        },
      }],
    });
    const original = build(0, 1, 60000);
    assert.strictEqual(sessionSnapshotSignature(original), sessionSnapshotSignature(build(0, 2, 60000)));
    assert.notStrictEqual(sessionSnapshotSignature(original), sessionSnapshotSignature(build(1, 2, 60000)));
    assert.notStrictEqual(sessionSnapshotSignature(original), sessionSnapshotSignature(build(0, 1, 120000)));
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
