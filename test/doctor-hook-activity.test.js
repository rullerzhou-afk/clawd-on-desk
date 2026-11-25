"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createConnectionTestDeduper,
  evaluateConnectionTest,
  runConnectionTest,
  scanFileMtimeActivity,
} = require("../src/doctor-hook-activity");

function makeTempHome(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-doctor-activity-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return homeDir;
}

function writeCodexRollout(codexHome) {
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "28");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout-2026-04-28T00-00-00-11111111-2222-3333-4444-555555555555.jsonl"), "{}\n");
}

describe("doctor hook activity connection test", () => {
  it("passes when any HTTP event was accepted", () => {
    const result = evaluateConnectionTest({
      events: [{ agentId: "codex", route: "state", outcome: "accepted" }],
    });

    assert.strictEqual(result.status, "http-verified");
    assert.strictEqual(result.level, null);
    assert.match(result.detail, /codex/);
  });

  it("uses the resolved custom application name in summaries", () => {
    const result = evaluateConnectionTest({
      events: [{
        agentId: "custom-nova-0123456789ab",
        route: "state",
        outcome: "accepted",
      }],
      resolveAgentDisplayName: () => "Nova AI",
    });

    assert.strictEqual(result.status, "http-verified");
    assert.match(result.detail, /Nova AI/);
    assert.doesNotMatch(result.detail, /custom-nova/);
  });

  it("warns when HTTP works but events are dropped by gates", () => {
    const result = evaluateConnectionTest({
      events: [
        { agentId: "claude-code", route: "state", outcome: "dropped-by-dnd" },
        { agentId: "codex", route: "permission", outcome: "dropped-by-disabled" },
      ],
    });

    assert.strictEqual(result.status, "http-dropped");
    assert.strictEqual(result.level, "warning");
    assert.match(result.detail, /dropped-by-disabled/);
    assert.match(result.detail, /dropped-by-dnd/);
  });

  it("treats invalid and unsupported custom activity as dropped, never verified", () => {
    const result = evaluateConnectionTest({
      events: [
        { agentId: "rejected-custom", route: "state", outcome: "dropped-invalid-agent" },
        { agentId: "custom-nova-0123456789ab", route: "permission", outcome: "dropped-unsupported" },
      ],
    });

    assert.strictEqual(result.status, "http-dropped");
    assert.strictEqual(result.level, "warning");
  });

  it("warns when Codex fallback files changed but no HTTP event arrived", () => {
    const result = evaluateConnectionTest({
      fileActivity: [{ agentId: "codex", source: "file-mtime", count: 1 }],
    });

    assert.strictEqual(result.status, "http-blocked");
    assert.strictEqual(result.level, "warning");
    assert.match(result.detail, /codex/);
  });

  it("points to Codex hook review before blaming the HTTP path", () => {
    const result = evaluateConnectionTest({
      fileActivity: [{ agentId: "codex", source: "file-mtime", count: 1 }],
      codexHookHealth: { signature: "needs-review", status: "needs-review" },
    });

    assert.strictEqual(result.status, "hooks-need-review");
    assert.strictEqual(result.level, "warning");
    assert.match(result.detail, /\/hooks/);
    assert.doesNotMatch(result.detail, /HTTP works|likely/i);
  });

  it("points to optional Codex hook review before blaming the HTTP path", () => {
    const result = evaluateConnectionTest({
      fileActivity: [{ agentId: "codex", source: "file-mtime", count: 1 }],
      codexHookHealth: { signature: "needs-review-optional", status: "needs-review" },
    });

    assert.strictEqual(result.status, "hooks-need-review");
    assert.strictEqual(result.level, "warning");
    assert.match(result.detail, /\/hooks/);
    assert.doesNotMatch(result.detail, /HTTP works|likely/i);
  });

  it("keeps observed HTTP outcomes ahead of Codex hook review state", () => {
    const shared = {
      fileActivity: [{ agentId: "codex", source: "file-mtime", count: 1 }],
      codexHookHealth: { signature: "needs-review", status: "needs-review" },
    };
    const accepted = evaluateConnectionTest({
      ...shared,
      events: [{ agentId: "claude-code", route: "state", outcome: "accepted" }],
    });
    const dropped = evaluateConnectionTest({
      ...shared,
      events: [{ agentId: "codex", route: "state", outcome: "dropped-by-disabled" }],
    });

    assert.strictEqual(accepted.status, "http-verified");
    assert.strictEqual(dropped.status, "http-dropped");
  });

  it("requires matching Codex activity before using its hook review state", () => {
    const health = { signature: "needs-review", status: "needs-review" };
    assert.strictEqual(evaluateConnectionTest({ codexHookHealth: health }).status, "no-activity");
    assert.strictEqual(evaluateConnectionTest({
      fileActivity: [{ agentId: "claude-code", source: "file-mtime", count: 1 }],
      codexHookHealth: health,
    }).status, "http-blocked");
    assert.strictEqual(evaluateConnectionTest({
      fileActivity: [{ agentId: "codex", source: "file-mtime", count: 1 }],
      codexHookHealth: { signature: null, status: "ok" },
    }).status, "http-blocked");
  });

  it("warns when nothing changed during the window", () => {
    const result = evaluateConnectionTest({});

    assert.strictEqual(result.status, "no-activity");
    assert.strictEqual(result.level, "warning");
  });

  it("scans only Codex fallback mtime activity without collecting file names in the summary", (t) => {
    const homeDir = makeTempHome(t);
    const geminiDir = path.join(homeDir, ".gemini", "tmp", "project", "chats");
    writeCodexRollout(path.join(homeDir, ".codex"));
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(path.join(geminiDir, "session-abc.json"), "{}");

    const activity = scanFileMtimeActivity({ homeDir, env: {}, since: 0 });

    assert.deepStrictEqual(activity.map((entry) => entry.agentId).sort(), ["codex"]);
    assert.ok(activity.every((entry) => !Object.prototype.hasOwnProperty.call(entry, "path")));
  });

  it("PR #1196 follow-up: finds rollout activity in an absolute CODEX_HOME", (t) => {
    const homeDir = makeTempHome(t);
    const codexHome = path.join(homeDir, "codex-dev");
    writeCodexRollout(codexHome);

    const activity = scanFileMtimeActivity({ homeDir, env: { CODEX_HOME: codexHome }, since: 0 });

    assert.deepStrictEqual(activity.map((entry) => entry.agentId), ["codex"]);
  });

  it("PR #1196 follow-up: skips the default home when CODEX_HOME is set", (t) => {
    const homeDir = makeTempHome(t);
    const codexHome = path.join(homeDir, "codex-dev");
    fs.mkdirSync(codexHome);
    writeCodexRollout(path.join(homeDir, ".codex"));

    const activity = scanFileMtimeActivity({ homeDir, env: { CODEX_HOME: codexHome }, since: 0 });

    assert.deepStrictEqual(activity, []);
  });

  it("PR #1196 follow-up: falls back for unset, empty, and whitespace-only CODEX_HOME", (t) => {
    const homeDir = makeTempHome(t);
    writeCodexRollout(path.join(homeDir, ".codex"));

    for (const env of [{}, { CODEX_HOME: "" }, { CODEX_HOME: " \t " }]) {
      const activity = scanFileMtimeActivity({ homeDir, env, since: 0 });
      assert.deepStrictEqual(activity.map((entry) => entry.agentId), ["codex"],
        `CODEX_HOME=${JSON.stringify(env.CODEX_HOME)}`);
    }
  });

  it("PR #1196 follow-up: trims whitespace around an absolute CODEX_HOME", (t) => {
    const homeDir = makeTempHome(t);
    const codexHome = path.join(homeDir, "codex-dev");
    writeCodexRollout(codexHome);

    const activity = scanFileMtimeActivity({ homeDir, env: { CODEX_HOME: ` \t${codexHome} \t` }, since: 0 });

    assert.deepStrictEqual(activity.map((entry) => entry.agentId), ["codex"]);
  });

  it("PR #1196 follow-up: preserves relative and literal tilde CODEX_HOME paths", (t) => {
    const homeDir = makeTempHome(t);

    for (const codexHome of ["codex-dev", "~/codex-dev"]) {
      const scannedDirs = [];
      scanFileMtimeActivity({
        homeDir,
        env: { CODEX_HOME: codexHome },
        fs: {
          readdirSync(dir) {
            scannedDirs.push(dir);
            return [];
          },
        },
      });
      assert.strictEqual(scannedDirs[0], path.join(codexHome, "sessions"));
    }
  });

  it("PR #1196 follow-up: counts a rollout only from the hook installation home", async (t) => {
    const homeDir = makeTempHome(t);
    const profileHome = path.join(homeDir, ".codex-work");
    writeCodexRollout(profileHome);

    const options = {
      homeDir,
      events: [],
      startedAt: 0,
      durationMs: 1000,
      setTimeout: (fn) => fn(),
    };

    // Extra profiles have no Clawd hooks, so their logs do not count in the connection test.
    const extraProfileResult = await runConnectionTest({ ...options, env: {} });
    assert.strictEqual(extraProfileResult.status, "no-activity");

    const hookHomeResult = await runConnectionTest({ ...options, env: { CODEX_HOME: profileHome } });
    assert.strictEqual(hookHomeResult.status, "http-blocked");
  });

  it("waits for the requested window and then evaluates server events", async () => {
    let waited = 0;
    const result = await runConnectionTest({
      durationMs: 1000,
      startedAt: Date.now() - 1,
      setTimeout: (fn, ms) => {
        waited = ms;
        fn();
      },
      server: {
        getRecentHookEvents: () => [{ agentId: "codex", route: "state", outcome: "accepted" }],
      },
      fileActivity: [],
    });

    assert.strictEqual(waited, 1000);
    assert.strictEqual(result.status, "http-verified");
    assert.strictEqual(result.events.length, 1);
  });

  it("reads current Codex hook health after the observation window", async () => {
    const calls = [];
    const result = await runConnectionTest({
      durationMs: 1000,
      setTimeout: (fn) => {
        calls.push("wait");
        fn();
      },
      fileActivity: [{ agentId: "codex", source: "file-mtime", count: 1 }],
      getCodexHookHealth: () => {
        calls.push("health");
        return { signature: "needs-review", status: "needs-review" };
      },
    });

    assert.deepStrictEqual(calls, ["wait", "health"]);
    assert.strictEqual(result.status, "hooks-need-review");
  });

  it("degrades to the existing HTTP warning when the health probe fails", async () => {
    const result = await runConnectionTest({
      durationMs: 1000,
      setTimeout: (fn) => fn(),
      fileActivity: [{ agentId: "codex", source: "file-mtime", count: 1 }],
      getCodexHookHealth: () => {
        throw new Error("probe failed");
      },
    });

    assert.strictEqual(result.status, "http-blocked");
  });

  it("deduplicates concurrent connection tests and resets after completion", async () => {
    let calls = 0;
    const resolvers = [];
    const completed = [];
    const runGuarded = createConnectionTestDeduper((input) => {
      calls++;
      return new Promise((resolve) => {
        resolvers.push(() => resolve({ status: "ok", marker: input.marker }));
      });
    }, {
      onResult: (result) => completed.push(result.marker),
    });

    const first = runGuarded({ marker: "first" });
    const second = runGuarded({ marker: "second" });
    assert.strictEqual(first, second);
    assert.strictEqual(calls, 1);

    resolvers.shift()();
    assert.deepStrictEqual(await second, { status: "ok", marker: "first" });
    assert.deepStrictEqual(completed, ["first"]);

    const third = runGuarded({ marker: "third" });
    assert.notStrictEqual(third, first);
    assert.strictEqual(calls, 2);
    resolvers.shift()();
    assert.deepStrictEqual(await third, { status: "ok", marker: "third" });
    assert.deepStrictEqual(completed, ["first", "third"]);
  });

  it("runs the live hook-health probe once for a single-flighted test", async () => {
    let healthCalls = 0;
    const runGuarded = createConnectionTestDeduper((input) => runConnectionTest({
      ...input,
      durationMs: 1000,
      setTimeout: (fn) => fn(),
      fileActivity: [{ agentId: "codex", source: "file-mtime", count: 1 }],
      getCodexHookHealth: () => {
        healthCalls++;
        return { signature: "needs-review", status: "needs-review" };
      },
    }));

    const first = runGuarded({ marker: "first" });
    const second = runGuarded({ marker: "second" });
    assert.strictEqual(first, second);
    assert.strictEqual((await first).status, "hooks-need-review");
    assert.strictEqual(healthCalls, 1);
  });
});
