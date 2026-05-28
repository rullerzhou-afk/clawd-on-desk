const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const GeminiLogMonitor = require("../agents/gemini-log-monitor");
const geminiConfig = require("../agents/gemini-cli");

const LEGACY_GEMINI_LOG_CONFIG = {
  sessionDir: "~/.gemini/tmp",
  pollIntervalMs: 1500,
};

// Helper: create temp dir mimicking ~/.gemini/tmp/{projectDir}/chats/
function makeTempGeminiDir(projectDir = "animation") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-"));
  const chatsDir = path.join(tmpDir, projectDir, "chats");
  fs.mkdirSync(chatsDir, { recursive: true });
  return { tmpDir, chatsDir, projectDir };
}

// Helper: create a config pointing to our temp dir
function makeConfig(tmpDir) {
  return {
    ...geminiConfig,
    logConfig: { ...LEGACY_GEMINI_LOG_CONFIG, sessionDir: tmpDir, pollIntervalMs: 100 },
  };
}

// Helper: build a session JSON file
function makeSessionJson(messages, sessionId = "test-session-id") {
  return JSON.stringify({
    sessionId,
    projectHash: "abc123",
    startTime: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    messages,
    kind: "main",
  });
}

const SESSION_FILE = "session-2026-04-04T08-00-00-abcd1234.json";

describe("GeminiLogMonitor", () => {
  let tmpDir, chatsDir, projectDir, monitor;

  beforeEach(() => {
    const dirs = makeTempGeminiDir();
    tmpDir = dirs.tmpDir;
    chatsDir = dirs.chatsDir;
    projectDir = dirs.projectDir;
  });

  afterEach(() => {
    if (monitor) monitor.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should detect user message as thinking (immediate)", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid, state, event) => {
      assert.strictEqual(sid, "gemini:test-session-id");
      assert.strictEqual(state, "thinking");
      assert.strictEqual(event, "UserPromptSubmit");
      done();
    });
    monitor.start();
  });

  it("should emit attention immediately for gemini with toolCalls", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "list files" }] },
      {
        type: "gemini",
        content: "Here are the files",
        tokens: { input: 10, output: 20 },
        toolCalls: [
          { name: "list_files", status: "success", args: {}, displayName: "ListFiles" },
        ],
      },
    ]));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid, state, event, extra) => {
      if (state === "attention") {
        assert.strictEqual(event, "Stop");
        assert.deepStrictEqual(extra.tokenUsage, { input: 10, output: 20 });
        assert.strictEqual(extra.usageEventId, `${sid}:2:Stop`);
        done();
      }
    });
    monitor.start();
  });

  it("should defer attention for gemini text without toolCalls (4s)", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
      { type: "gemini", content: "Hi there!", tokens: { input: 10, output: 5 } },
    ]));

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      states.push(state);
    });
    monitor.start();

    // Should NOT have emitted attention within 2s (defer is 4s)
    setTimeout(() => {
      const attentionCalls = states.filter(s => s === "attention");
      assert.strictEqual(attentionCalls.length, 0, "should not emit attention before defer period");
    }, 2000);

    // Should have emitted attention after ~4s defer
    setTimeout(() => {
      assert.ok(states.includes("attention"), `should emit attention after defer, got: ${states}`);
      done();
    }, 6000);
  });

  it("should cancel deferred attention when toolCalls arrive (auto-approved)", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    // Step 1: user message → thinking
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "delete file" }] },
    ]));

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "attention") {
        // Should go thinking → attention directly, no idle flash
        assert.deepStrictEqual(states, ["thinking", "attention"]);
        done();
      }
    });
    monitor.start();

    // Step 2: 300ms — gemini text, no toolCalls (deferred idle starts)
    setTimeout(() => {
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "delete file" }] },
        { type: "gemini", content: "I will delete it", tokens: { input: 5, output: 5 } },
      ]));
    }, 300);

    // Step 3: 800ms — toolCalls arrive (within 2s defer) → cancel idle, emit attention
    setTimeout(() => {
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "delete file" }] },
        {
          type: "gemini",
          content: "I will delete it",
          tokens: { input: 5, output: 10 },
          toolCalls: [{ name: "run_shell_command", status: "success", args: {} }],
        },
      ]));
    }, 800);
  });

  it("should cancel deferred attention when user sends new message", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
      { type: "gemini", content: "Hi!", tokens: { input: 5, output: 3 } },
    ]));

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      states.push(state);
    });
    monitor.start();

    // 500ms: user sends new message (before 4s defer fires)
    setTimeout(() => {
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "hello" }] },
        { type: "gemini", content: "Hi!", tokens: { input: 5, output: 3 } },
        { type: "user", content: [{ text: "follow up" }] },
      ]));
    }, 500);

    // After 6s: deferred attention should NOT have been emitted
    setTimeout(() => {
      assert.ok(!states.includes("attention"),
        `deferred attention should have been cancelled, got: ${states}`);
      assert.ok(states.includes("thinking"));
      done();
    }, 6000);
  });

  it("should detect tool error as error state", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "read file" }] },
      {
        type: "gemini",
        content: "Failed",
        tokens: { input: 10, output: 5 },
        toolCalls: [
          { name: "read_file", status: "error", args: { path: "/bad" }, displayName: "ReadFile" },
        ],
      },
    ]));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid, state, event) => {
      if (state === "error") {
        assert.strictEqual(event, "PostToolUseFailure");
        done();
      }
    });
    monitor.start();
  });

  it("should use last tool status when multiple toolCalls", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "do things" }] },
      {
        type: "gemini",
        content: "Done",
        tokens: { input: 10, output: 20 },
        toolCalls: [
          { name: "read_file", status: "success", args: {} },
          { name: "write_file", status: "error", args: {} },
        ],
      },
    ]));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      if (state === "error") {
        done();
      }
    });
    monitor.start();
  });

  it("should dedup: same state + same msgCount + same hasTools → no re-emit", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    const calls = [];
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      calls.push(state);
    });
    monitor.start();

    // Touch the file to update mtime but keep same content
    setTimeout(() => {
      const content = fs.readFileSync(filePath, "utf8");
      fs.writeFileSync(filePath, content);
    }, 200);

    setTimeout(() => {
      assert.strictEqual(calls.length, 1, `expected 1 call, got ${calls.length}: ${calls}`);
      assert.strictEqual(calls[0], "thinking");
      done();
    }, 600);
  });

  it("should skip follow-up text after tools complete in same turn", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    // Step 1: user message
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "do stuff" }] },
    ]));

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      states.push(state);
    });
    monitor.start();

    // Step 2: gemini with tools → attention, turnHasTools=true
    setTimeout(() => {
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "do stuff" }] },
        {
          type: "gemini", content: "Done",
          tokens: { input: 5, output: 5 },
          toolCalls: [{ name: "read_file", status: "success", args: {} }],
        },
      ]));
    }, 200);

    // Step 3: follow-up text (no tools) → should be SKIPPED (turnHasTools=true)
    setTimeout(() => {
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "do stuff" }] },
        {
          type: "gemini", content: "Done",
          tokens: { input: 5, output: 5 },
          toolCalls: [{ name: "read_file", status: "success", args: {} }],
        },
        { type: "gemini", content: "Summary", tokens: { input: 5, output: 10 } },
      ]));
    }, 500);

    // Only 1 attention (from tools), follow-up text skipped
    setTimeout(() => {
      const attentionCalls = states.filter(s => s === "attention");
      assert.strictEqual(attentionCalls.length, 1,
        `expected 1 attention (tools only), got ${attentionCalls.length}: ${states}`);
      done();
    }, 2000);
  });

  it("should reset turnHasTools on new user message", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    // Step 1: user message
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "turn 1" }] },
    ]));

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      states.push(state);
    });
    monitor.start();

    // Step 2: gemini with tools → attention, turnHasTools=true
    setTimeout(() => {
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "turn 1" }] },
        {
          type: "gemini", content: "Done",
          tokens: { input: 5, output: 5 },
          toolCalls: [{ name: "read_file", status: "success", args: {} }],
        },
      ]));
    }, 200);

    // Step 3: new user message → resets turnHasTools
    setTimeout(() => {
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "turn 1" }] },
        {
          type: "gemini", content: "Done",
          tokens: { input: 5, output: 5 },
          toolCalls: [{ name: "read_file", status: "success", args: {} }],
        },
        { type: "user", content: [{ text: "turn 2" }] },
      ]));
    }, 400);

    // Step 4: gemini text without tools → should NOT be skipped (new turn, turnHasTools reset)
    setTimeout(() => {
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "turn 1" }] },
        {
          type: "gemini", content: "Done",
          tokens: { input: 5, output: 5 },
          toolCalls: [{ name: "read_file", status: "success", args: {} }],
        },
        { type: "user", content: [{ text: "turn 2" }] },
        { type: "gemini", content: "Reply", tokens: { input: 5, output: 5 } },
      ]));
    }, 600);

    // Check states: thinking → attention → thinking → (deferred pending, not yet fired)
    setTimeout(() => {
      const thinkingCount = states.filter(s => s === "thinking").length;
      assert.ok(thinkingCount >= 2,
        `should have 2+ thinking events (turnHasTools reset), got: ${states}`);
      assert.ok(states.includes("attention"), `should have attention: ${states}`);
      // Verify a pending deferred exists (from step 4 gemini-no-tools)
      assert.strictEqual(monitor._pendingCompletions.size, 1,
        "should have a pending deferred completion");
      done();
    }, 1500);
  });

  it("should skip mtime-unchanged files", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    let callCount = 0;
    monitor = new GeminiLogMonitor(config, () => {
      callCount++;
    });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(callCount, 1);
      done();
    }, 500);
  });

  it("should detect incremental changes (user → gemini with tools)", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "attention") {
        assert.deepStrictEqual(states, ["thinking", "attention"]);
        done();
      }
    });
    monitor.start();

    setTimeout(() => {
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "hello" }] },
        {
          type: "gemini", content: "Done!",
          tokens: { input: 5, output: 3 },
          toolCalls: [{ name: "read_file", status: "success", args: {} }],
        },
      ]));
    }, 250);
  });

  it("should skip old files (>2min mtime)", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(filePath, oldTime, oldTime);

    const config = makeConfig(tmpDir);
    let called = false;
    monitor = new GeminiLogMonitor(config, () => { called = true; });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(called, false, "should not have processed old file");
      done();
    }, 300);
  });

  it("should handle corrupted JSON gracefully", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, "THIS IS NOT JSON");

    const config = makeConfig(tmpDir);
    let called = false;
    monitor = new GeminiLogMonitor(config, () => { called = true; });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(called, false, "should not crash on bad JSON");
      done();
    }, 300);
  });

  it("should handle empty messages array", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([]));

    const config = makeConfig(tmpDir);
    let called = false;
    monitor = new GeminiLogMonitor(config, () => { called = true; });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(called, false, "should not emit for empty messages");
      done();
    }, 300);
  });

  it("should emit SessionEnd for stale sessions (5min)", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid, state, event) => {
      if (state === "sleeping" && event === "SessionEnd") {
        done();
      }
    });
    monitor.start();

    setTimeout(() => {
      for (const tracked of monitor._tracked.values()) {
        tracked.lastEventTime = Date.now() - 400000;
      }
    }, 200);
  });

  it("should resolve cwd from projects.json", (_, done) => {
    const geminiDir = path.join(tmpDir, ".gemini-projects");
    fs.mkdirSync(geminiDir, { recursive: true });
    const projectsPath = path.join(geminiDir, "projects.json");
    fs.writeFileSync(projectsPath, JSON.stringify({
      projects: { "d:\\animation": "animation", "c:\\users\\ruller": "ruller" },
    }));

    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid, state, event, extra) => {
      assert.strictEqual(extra.cwd, "d:\\animation");
      done();
    });

    monitor._loadCwdMap = function () {
      try {
        const mtime = fs.statSync(projectsPath).mtimeMs;
        if (this._cwdMap && mtime === this._projectsMtime) return;
        this._projectsMtime = mtime;
        const data = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
        if (data && data.projects) {
          this._cwdMap = {};
          for (const [physPath, dirName] of Object.entries(data.projects)) {
            this._cwdMap[dirName] = physPath;
          }
        }
      } catch {}
    }.bind(monitor);

    monitor.start();
  });

  it("should reload cwdMap when projects.json changes", (_, done) => {
    const geminiDir = path.join(tmpDir, ".gemini-projects");
    fs.mkdirSync(geminiDir, { recursive: true });
    const projectsPath = path.join(geminiDir, "projects.json");
    fs.writeFileSync(projectsPath, JSON.stringify({
      projects: { "c:\\old": "animation" },
    }));

    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    const cwds = [];
    monitor = new GeminiLogMonitor(config, (sid, state, event, extra) => {
      cwds.push(extra.cwd);
    });

    monitor._loadCwdMap = function () {
      try {
        const mtime = fs.statSync(projectsPath).mtimeMs;
        if (this._cwdMap && mtime === this._projectsMtime) return;
        this._projectsMtime = mtime;
        const data = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
        if (data && data.projects) {
          this._cwdMap = {};
          for (const [physPath, dirName] of Object.entries(data.projects)) {
            this._cwdMap[dirName] = physPath;
          }
        }
      } catch {}
    }.bind(monitor);

    monitor.start();

    setTimeout(() => {
      assert.strictEqual(cwds[0], "c:\\old");
      fs.writeFileSync(projectsPath, JSON.stringify({
        projects: { "d:\\new-project": "animation" },
      }));
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "hello" }] },
        {
          type: "gemini", content: "reply",
          tokens: { input: 5, output: 3 },
          toolCalls: [{ name: "read_file", status: "success", args: {} }],
        },
      ]));
    }, 250);

    setTimeout(() => {
      assert.ok(cwds.length >= 2, `expected at least 2 calls, got ${cwds.length}`);
      assert.strictEqual(cwds[cwds.length - 1], "d:\\new-project");
      done();
    }, 600);
  });

  it("should ignore unknown message types", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "system", content: "some system thing" },
    ]));

    const config = makeConfig(tmpDir);
    let called = false;
    monitor = new GeminiLogMonitor(config, () => { called = true; });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(called, false, "should not emit for unknown message type");
      done();
    }, 300);
  });

  it("should track multiple project directories independently", (_, done) => {
    const chatsDir2 = path.join(tmpDir, "otherproject", "chats");
    fs.mkdirSync(chatsDir2, { recursive: true });

    const file1 = path.join(chatsDir, SESSION_FILE);
    const file2 = path.join(chatsDir2, "session-2026-04-04T09-00-00-efgh5678.json");

    fs.writeFileSync(file1, makeSessionJson(
      [{ type: "user", content: [{ text: "in animation" }] }],
      "session-aaa"
    ));
    fs.writeFileSync(file2, makeSessionJson(
      [{ type: "user", content: [{ text: "in other" }] }],
      "session-bbb"
    ));

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      events.push({ sid, state });
      if (events.length === 2) {
        const sids = events.map(e => e.sid).sort();
        assert.ok(sids.includes("gemini:session-aaa"));
        assert.ok(sids.includes("gemini:session-bbb"));
        done();
      }
    });
    monitor.start();
  });

  it("should fall back to filename as sessionId when data.sessionId is missing", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    const data = {
      projectHash: "abc",
      messages: [{ type: "user", content: [{ text: "hi" }] }],
    };
    fs.writeFileSync(filePath, JSON.stringify(data));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid) => {
      assert.strictEqual(sid, "gemini:session-2026-04-04T08-00-00-abcd1234");
      done();
    });
    monitor.start();
  });
});
