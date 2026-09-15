"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  encodeClaudeProjectDir,
  getClaudeProjectsDir,
  probeTranscript,
  loadResumableSessionHistory,
  resolveResumeTarget,
} = require("../src/session-history-loader");
const { recordSessionHistoryFromStateBody } = require("../hooks/session-history");

describe("session history loader", () => {
  let root;
  let historyDir;
  let claudeProjectsDir;
  let projectCwd;
  const T0 = 1_700_000_000_000;
  const BOOT_A = T0 - 3_600_000;
  const BOOT_B = T0 + 600_000;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-history-loader-"));
    historyDir = path.join(root, "history");
    claudeProjectsDir = path.join(root, "claude-projects");
    projectCwd = path.join(root, "project");
    fs.mkdirSync(historyDir, { recursive: true });
    fs.mkdirSync(claudeProjectsDir, { recursive: true });
    fs.mkdirSync(projectCwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function record(sessionId, eventAt, boot = BOOT_A, overrides = {}) {
    return recordSessionHistoryFromStateBody({
      agent_id: "claude-code",
      session_id: sessionId,
      event: "UserPromptSubmit",
      state: "working",
      agent_pid: process.pid,
      source_pid: process.pid,
      cwd: projectCwd,
      session_title: `Session ${sessionId}`,
      ...overrides,
    }, { historyDir, eventAt, uptime: () => (eventAt - boot) / 1000 });
  }

  function writeTranscript(sessionId, cwd = projectCwd) {
    const dir = path.join(claudeProjectsDir, encodeClaudeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
  }

  function loadOpts(extra = {}) {
    return {
      historyDir,
      claudeProjectsDir,
      now: BOOT_B + 60_000,
      uptime: () => 60,
      ...extra,
    };
  }

  describe("project directory encoding", () => {
    it("maps every character outside [A-Za-z0-9-] to a dash", () => {
      assert.equal(
        encodeClaudeProjectDir("/Users/me/Workspace/Work"),
        "-Users-me-Workspace-Work",
      );
      // Two CJK characters collapse to two dashes, matching Claude Code.
      assert.equal(
        encodeClaudeProjectDir("/Users/me/Workspace/在场"),
        "-Users-me-Workspace---",
      );
      assert.equal(encodeClaudeProjectDir("/a.b/c_d"), "-a-b-c-d");
      assert.equal(encodeClaudeProjectDir(""), null);
    });
  });

  describe("transcript probing", () => {
    it("honours the configured Claude home without probing the default account", () => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      try {
        process.env.CLAUDE_CONFIG_DIR = path.join(root, "custom-claude");
        assert.equal(getClaudeProjectsDir(), path.join(root, "custom-claude", "projects"));
        assert.equal(getClaudeProjectsDir(loadOpts()), claudeProjectsDir);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });

    it("rejects path-bearing IDs before any transcript filesystem access", (t) => {
      const reads = t.mock.method(fs, "lstatSync", () => { throw new Error("must not read"); });
      for (const id of ["../secret", "x/y", "x\\y", "", "   ", "a\n"]) {
        assert.equal(probeTranscript("claude-code", id, projectCwd, loadOpts()), null);
      }
      assert.equal(reads.mock.callCount(), 0);
    });

    it("treats access and I/O errors as unknown, not missing", (t) => {
      writeTranscript("has-transcript");
      const lstat = fs.lstatSync;
      t.mock.method(fs, "lstatSync", (file, ...args) => {
        if (String(file).endsWith("has-transcript.jsonl")) {
          throw Object.assign(new Error("unreadable"), { code: "EACCES" });
        }
        return lstat(file, ...args);
      });
      assert.equal(probeTranscript("claude-code", "has-transcript", projectCwd, loadOpts()), null);
    });

    it("reports present, confidently missing, and unknown distinctly", () => {
      writeTranscript("has-transcript");

      assert.equal(
        probeTranscript("claude-code", "has-transcript", projectCwd, loadOpts()),
        true,
      );
      // Project dir exists, this transcript does not -> a confident no.
      assert.equal(
        probeTranscript("claude-code", "no-transcript", projectCwd, loadOpts()),
        false,
      );
      // No project dir at all -> unknown, never a claim.
      assert.equal(
        probeTranscript("claude-code", "anything", path.join(root, "elsewhere"), loadOpts()),
        null,
      );
      // Another agent's layout is not ours to interpret.
      assert.equal(probeTranscript("codex", "x", projectCwd, loadOpts()), null);
    });
  });

  describe("resume list", () => {
    it("offers interrupted rows first and flags a missing transcript", () => {
      record("interrupted-one", T0);
      record("ended-one", T0 + 1000, BOOT_A, { event: "SessionEnd", state: "idle" });
      writeTranscript("ended-one");

      const rows = loadResumableSessionHistory(loadOpts());
      assert.deepEqual(rows.map((r) => r.sessionId), ["interrupted-one", "ended-one"]);
      assert.equal(rows[0].interrupted, true);
      assert.equal(rows[0].transcriptPresent, false, "no transcript was written for it");
      assert.equal(rows[1].interrupted, false);
      assert.equal(rows[1].transcriptPresent, true);
      assert.equal(rows[0].cwd, projectCwd);
    });

    it("still offers a row whose transcript state is unknown", () => {
      // No project directory at all, so the probe cannot tell.
      record("unknowable", T0);
      const rows = loadResumableSessionHistory(loadOpts());
      assert.equal(rows.length, 1);
      assert.equal(rows[0].transcriptPresent, null);
    });

    it("hides sessions that are already live on screen", () => {
      record("running-now", T0);
      record("finished", T0 + 1000, BOOT_A, { event: "SessionEnd", state: "idle" });

      const rows = loadResumableSessionHistory(loadOpts({
        activeRawSessionIds: new Set(["running-now"]),
      }));
      assert.deepEqual(rows.map((r) => r.sessionId), ["finished"]);
    });

    it("honours the row limit after the active filter", () => {
      for (let i = 0; i < 5; i++) record(`s-${i}`, T0 + i * 1000);
      const rows = loadResumableSessionHistory(loadOpts({
        limit: 2,
        activeRawSessionIds: new Set(["s-4"]),
      }));
      assert.equal(rows.length, 2);
      assert.ok(!rows.some((r) => r.sessionId === "s-4"));
    });

    it("never returns prompts or responses", () => {
      record("s", T0, BOOT_A, { assistant_last_output: "secret", prompt: "secret" });
      const [row] = loadResumableSessionHistory(loadOpts());
      assert.ok(!JSON.stringify(row).includes("secret"));
    });
  });

  describe("resume target resolution", () => {
    it("reads the working directory from the store, not from the caller", () => {
      record("target", T0);
      const resolved = resolveResumeTarget("claude-code", "target", loadOpts());
      assert.deepEqual(resolved, {
        agentId: "claude-code",
        sessionId: "target",
        cwd: projectCwd,
      });
    });

    it("refuses unknown rows and vanished folders", () => {
      record("target", T0);
      assert.equal(resolveResumeTarget("claude-code", "never-seen", loadOpts()), null);
      assert.equal(resolveResumeTarget("codex", "target", loadOpts()), null);
      assert.equal(resolveResumeTarget(null, "target", loadOpts()), null);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      assert.equal(
        resolveResumeTarget("claude-code", "target", loadOpts()),
        null,
        "a deleted project folder must not be relaunched into",
      );
    });
  });
});
