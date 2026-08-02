const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const CodexLogMonitor = require("../agents/codex-log-monitor");
const codexConfig = require("../agents/codex");

// Helper: create a temp session dir with today's date structure
function makeTempSessionDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
  const now = new Date();
  const dateDir = path.join(
    tmpDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );
  fs.mkdirSync(dateDir, { recursive: true });
  return { tmpDir, dateDir };
}

// Helper: create a config pointing to our temp dir
function makeConfig(tmpDir) {
  return {
    ...codexConfig,
    logConfig: { ...codexConfig.logConfig, sessionDir: tmpDir, pollIntervalMs: 100 },
  };
}

const TEST_FILENAME = "rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl";
const EXPECTED_SID = "codex:019d23d4-f1a9-7633-b9c7-758327137228";

describe("CodexLogMonitor", () => {
  let tmpDir, dateDir, monitor;

  beforeEach(() => {
    const dirs = makeTempSessionDir();
    tmpDir = dirs.tmpDir;
    dateDir = dirs.dateDir;
  });

  afterEach(() => {
    if (monitor) monitor.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should extract session ID from filename", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');

    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, (sid, state) => {
      assert.strictEqual(sid, EXPECTED_SID);
      assert.strictEqual(state, "idle");
      done();
    });
    monitor.start();
  });

  it("should map session_meta to idle", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/projects/foo"}}\n');

    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      assert.strictEqual(state, "idle");
      assert.strictEqual(extra.cwd, "/projects/foo");
      done();
    });
    monitor.start();
  });

  it("emits Codex Desktop session metadata from session_meta records", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/projects/foo",
        originator: "codex_work_desktop",
        source: "vscode",
      },
    }) + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].sid, EXPECTED_SID);
    assert.strictEqual(events[0].state, "idle");
    assert.strictEqual(events[0].extra.cwd, "/projects/foo");
    assert.strictEqual(events[0].extra.codexOriginator, "codex_work_desktop");
    assert.strictEqual(events[0].extra.codexSource, "vscode");
  });

  it("emits request_user_input and closes only the matching call", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo", source: "cli" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_question",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ] }] }),
        },
      }),
    ].join("\n") + "\n");

    const requests = [];
    const resolved = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
      onUserInputResolved: (...args) => resolved.push(args),
    });
    monitor._findCodexWriterPid = () => null;
    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0][0], EXPECTED_SID);
    assert.strictEqual(requests[0][1].callId, "call_question");
    assert.strictEqual(requests[0][2].cwd, "/projects/foo");

    fs.appendFileSync(testFile, JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "unrelated", output: "{}" },
    }) + "\n");
    monitor._pollFile(testFile, path.basename(testFile));
    assert.deepStrictEqual(resolved, []);

    fs.appendFileSync(testFile, JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_question", output: "{}" },
    }) + "\n");
    monitor._pollFile(testFile, path.basename(testFile));
    assert.deepStrictEqual(resolved, [[EXPECTED_SID, "call_question"]]);
  });

  it("does not flash a request_user_input already resolved before initial attach", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_done",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_done", output: "{}" },
      }),
    ].join("\n") + "\n");
    const requests = [];
    const resolved = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
      onUserInputResolved: (...args) => resolved.push(args),
    });
    monitor._pollFile(testFile, path.basename(testFile));
    assert.deepStrictEqual(requests, []);
    assert.deepStrictEqual(resolved, []);
  });

  it("recovers a still-open request_user_input from an old (>5min mtime) untracked file on startup", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_stale_pending",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 600000); // 10 minutes ago
    fs.utimesSync(testFile, oldTime, oldTime);

    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0][0], EXPECTED_SID);
      assert.strictEqual(requests[0][1].callId, "call_stale_pending");
      done();
    }, 300);
  });

  it("does not recover an old untracked file whose request_user_input was already resolved", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_stale_done",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_stale_done", output: "{}" },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const requests = [];
    let anyState = false;
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => { anyState = true; }, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor.start();

    setTimeout(() => {
      assert.deepStrictEqual(requests, []);
      assert.strictEqual(anyState, false, "an already-resolved old file must stay untracked, not just card-less");
      done();
    }, 300);
  });

  it("recovers and routes fresh Spark quota from an active Windows rollout whose mtime stayed old", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const timestamp = new Date().toISOString();
    const resetAt = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
    fs.writeFileSync(testFile, [
      JSON.stringify({ timestamp, type: "session_meta", payload: { cwd: "/projects/live-frozen-mtime" } }),
      JSON.stringify({
        timestamp,
        type: "turn_context",
        payload: { model: "gpt-5.3-codex-spark", effort: "low" },
      }),
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: {
              used_percent: 0,
              window_minutes: 10080,
              resets_at: resetAt,
            },
          },
        },
      }),
    ].join("\n") + "\n");
    const frozenTime = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(testFile, frozenTime, frozenTime);

    const states = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event, extra) => {
      states.push({ sid, state, event, extra });
    });
    monitor.start();

    setTimeout(() => {
      const quotaEvent = states.find((entry) => entry.event === "event_msg:token_count");
      assert.ok(quotaEvent, "fresh embedded activity must override a frozen old mtime");
      assert.strictEqual(quotaEvent.sid, EXPECTED_SID);
      assert.strictEqual(quotaEvent.extra.cwd, "/projects/live-frozen-mtime");
      assert.strictEqual(quotaEvent.extra.codexQuota, undefined);
      assert.strictEqual(quotaEvent.extra.codexSparkQuota.codexWeekly.usedPercent, 0);
      assert.ok(monitor._tracked.has(testFile), "the recovered active file must stay tracked");
      done();
    }, 300);
  });

  it("only sweeps for stale pending questions once, on the first poll after start", (_, done) => {
    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor.start();

    setTimeout(() => {
      // Drop in an old, untracked file with a pending question AFTER the
      // startup sweep already ran — this must not be recovered. Only the
      // one-time sweep at start() is allowed to look past the active window.
      const testFile = path.join(dateDir, TEST_FILENAME);
      fs.writeFileSync(testFile, JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_too_late",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }) + "\n");
      const oldTime = new Date(Date.now() - 600000);
      fs.utimesSync(testFile, oldTime, oldTime);

      setTimeout(() => {
        assert.deepStrictEqual(requests, [], "a file that only appears after the startup sweep must not be recovered");
        done();
      }, 300);
    }, 150);
  });

  it("recovers a pending request whose own timestamp is stale even though the file's mtime is fresh (token_count refresh)", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(testFile, JSON.stringify({
      type: "response_item",
      timestamp: oldTimestamp,
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_fresh_mtime_stale_ts",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    }) + "\n");
    // File was just written — mtime is "now", well inside BACKFILL_GRACE_MS,
    // so this attaches in LIVE mode (backfilling=false) despite the stale
    // embedded timestamp on the only line it contains.

    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0][1].callId, "call_fresh_mtime_stale_ts");
  });

  it("recovering a stale pending question does not replay the file's ordinary historical state", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/stale" } }),
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_amid_history",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const states = [];
    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      states.push({ state, event });
    }, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0][1].callId, "call_amid_history");
      assert.deepStrictEqual(states, [], "task_started/task_complete history must stay silent, only the pending question surfaces");
      done();
    }, 300);
  });

  it("backfill seeds account quota even when a recovered root question suppresses the state snapshot", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const timestamp = new Date().toISOString();
    const resetAt = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
    fs.writeFileSync(testFile, [
      JSON.stringify({ timestamp, type: "session_meta", payload: { cwd: "/projects/pending-quota" } }),
      JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 12, resets_at: resetAt },
          },
        },
      }),
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex_bengalfox",
            limit_name: "GPT-5.3-Codex-Spark",
            primary: { used_percent: 7, window_minutes: 10080, resets_at: resetAt },
          },
        },
      }),
      JSON.stringify({
        timestamp,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_pending_quota",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 60000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const states = [];
    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event, extra) => {
      states.push({ sid, state, event, extra });
    }, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(states.length, 1, "only quota metadata should emit beside the question card");
    assert.strictEqual(states[0].event, "event_msg:token_count");
    assert.strictEqual(states[0].state, "idle");
    assert.strictEqual(states[0].extra.codexQuota.codexFiveHour.usedPercent, 12);
    assert.strictEqual(states[0].extra.codexSparkQuota.codexWeekly.usedPercent, 7);
  });

  it("keeps a subagent's normal headless backfill snapshot when it has a pending question within the active window", (_, done) => {
    // Within ACTIVE_SESSION_WINDOW_MS (mtime 3 min old): discovered through
    // the normal slow-write-cadence path, so it runs the full _pollFile
    // pipeline and _emitBackfillSnapshot's subagent carve-out applies.
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: "/projects/sub",
          source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_role: "explorer" } } },
          agent_role: "explorer",
        },
      }),
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"ls\\"}"}}',
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_sub_pending",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");
    const recent = new Date(Date.now() - 3 * 60 * 1000);
    fs.utimesSync(testFile, recent, recent);

    const states = [];
    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event, extra) => {
      states.push({ state, event, headless: extra.headless });
    }, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor.start();

    setTimeout(() => {
      assert.deepStrictEqual(requests, [], "subagents never get a question card");
      assert.strictEqual(states.length, 1);
      assert.strictEqual(states[0].state, "working");
      assert.strictEqual(states[0].headless, true);
      done();
    }, 300);
  });

  it("recovering a stale (>5min) subagent file never shows a card and never crashes, even with a pending question", (_, done) => {
    // The bounded startup recovery sweep does not run the full state
    // pipeline (that's the point — see #707 follow-up review on read cost),
    // so it can't reconstruct a subagent's last sustained state the way the
    // active-window path above does. It only decides card-or-not, and a
    // subagent must never get a card either way.
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: "/projects/sub",
          source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_role: "explorer" } } },
          agent_role: "explorer",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_sub_stale",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor.start();

    setTimeout(() => {
      assert.deepStrictEqual(requests, [], "subagents never get a question card, recovered or not");
      done();
    }, 300);
  });

  it("does not resurrect a request_user_input abandoned by task_complete before the restart that recovers it", () => {
    // #707 follow-up review, finding 1: the recovery sweep must apply the
    // same "turn ended -> question moot" rule the live path applies, or a
    // long-dead request survives every future restart forever.
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_ended_before_restart",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    const recovered = monitor._recoverStalePendingUserInput(testFile, path.basename(testFile));
    assert.strictEqual(recovered, null, "task_complete after the request must prevent recovery, not just live clearing");
  });

  it("does not resurrect a request_user_input a turn_aborted already abandoned before the restart that recovers it", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_aborted_before_restart",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
      '{"type":"event_msg","payload":{"type":"turn_aborted"}}',
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {});
    const recovered = monitor._recoverStalePendingUserInput(testFile, path.basename(testFile));
    assert.strictEqual(recovered, null);
  });

  it("recovers a request that begins exactly at the 1 MiB tail boundary", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const sessionMetaLine = JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/boundary" } }) + "\n";
    const requestLine = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_exact_tail_boundary",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    }) + "\n";
    const tailWindow = 1024 * 1024;
    const fillerLength = tailWindow - Buffer.byteLength(requestLine, "utf8") - 1;
    assert.ok(fillerLength > 0);
    fs.writeFileSync(testFile, sessionMetaLine + requestLine + "x".repeat(fillerLength) + "\n", "utf8");
    assert.strictEqual(fs.statSync(testFile).size - tailWindow, Buffer.byteLength(sessionMetaLine, "utf8"));
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {});
    const recovered = monitor._recoverStalePendingUserInput(testFile, path.basename(testFile));

    assert.ok(recovered, "the complete first tail record must not be dropped");
    assert.ok(recovered.pendingUserInputs.has("call_exact_tail_boundary"));
  });

  it("does not recover a file older than RECOVERY_MAX_AGE_MS even with a genuinely unresolved question", () => {
    // #707 follow-up review, finding 3: without an age cap, a session killed
    // with an unanswered question resurrects as a permanent ghost card on
    // every future restart. This bounds the damage.
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_ancient",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    }) + "\n");
    const ancient = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h — past the 24h cap
    fs.utimesSync(testFile, ancient, ancient);

    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {});
    const recovered = monitor._recoverStalePendingUserInput(testFile, path.basename(testFile));
    assert.strictEqual(recovered, null);
  });

  it("does not lose a trailing partial line split by the recovery scan's read window", () => {
    // #700 follow-up: recovery must not silently swallow a line that's
    // genuinely still being appended. #700 removed the tracker's `partial`
    // buffer entirely (offset now stops at the last complete newline; an
    // incomplete tail is simply left on disk for the next poll to reread
    // whole), so recovery must follow the same convention instead of
    // consuming through true EOF and stashing the fragment separately.
    const testFile = path.join(dateDir, TEST_FILENAME);
    const sessionMetaLine = JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } });
    const requestLine = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_partial_tail",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    });
    fs.writeFileSync(
      testFile,
      sessionMetaLine + "\n"
      + requestLine + "\n"
      + '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_partial_ta' // deliberately unterminated
    );
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {});
    const recovered = monitor._recoverStalePendingUserInput(testFile, path.basename(testFile));
    assert.ok(recovered, "the request itself is still genuinely pending");
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(recovered, "partial"), false,
      "#700's tracker shape has no `partial` field — the incomplete tail stays on disk instead"
    );
    assert.strictEqual(
      recovered.offset,
      Buffer.byteLength(sessionMetaLine + "\n" + requestLine + "\n", "utf8"),
      "offset must stop at the last complete newline (matching _pollFile's own commit convention), not run through the unterminated tail"
    );
    assert.notStrictEqual(recovered.fileIdentity, null);

    // Completing the line on a normal poll must resolve the question — this
    // is what an unconditional offset-to-EOF would have permanently broken
    // once _pollFile stopped reading a `partial` prefix.
    monitor._tracked.set(testFile, recovered);
    fs.appendFileSync(testFile, 'il","output":"{}"}}\n');
    const resolved = [];
    monitor._onUserInputResolved = (...args) => resolved.push(args);
    monitor._pollFile(testFile, path.basename(testFile));
    assert.deepStrictEqual(resolved, [[recovered.sessionId, "call_partial_tail"]]);
  });

  it("seeds fileIdentity on the recovered tracker and mirrors it into the read-position ledger", () => {
    // _runRecoverySweep bypasses _pollFile's normal new-tracker construction,
    // which is where fileIdentity and _readPositions are otherwise populated
    // together. Leaving fileIdentity unset reads as "identity changed" on
    // the very next regular poll (undefined !== null, same as a real
    // identity string would), silently resetting the offset to EOF and
    // dropping whatever landed between the sweep and that poll. Leaving the
    // ledger unseeded defeats #700's own fix the next time this tracker is
    // evicted from both LRUs.
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_identity_check",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {});
    const expectedIdentity = monitor._getFileIdentity(fs.statSync(testFile));
    assert.notStrictEqual(expectedIdentity, null, "sanity: this file must have a real dev/ino identity");

    monitor._runRecoverySweep([{
      filePath: testFile,
      file: path.basename(testFile),
      mtimeMs: oldTime.getTime(),
      size: fs.statSync(testFile).size,
    }]);
    const tracked = monitor._tracked.get(testFile);
    assert.ok(tracked);
    assert.strictEqual(tracked.fileIdentity, expectedIdentity);
    assert.deepStrictEqual(monitor._readPositions.get(testFile), {
      offset: tracked.offset,
      identity: expectedIdentity,
    });

    // Prove the fix actually matters: a normal poll right after recovery
    // must not misfire the identityChanged guard and skip freshly appended
    // bytes.
    fs.appendFileSync(testFile, JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_identity_check", output: "{}" },
    }) + "\n");
    const resolved = [];
    monitor._onUserInputResolved = (...args) => resolved.push(args);
    monitor._pollFile(testFile, path.basename(testFile));
    assert.deepStrictEqual(resolved, [[tracked.sessionId, "call_identity_check"]]);
  });

  it("resets the recovery sweep on every real start(), not just the first one this instance ever saw", (_, done) => {
    // #707 follow-up review, finding 4: the agent gate can stop() then
    // start() the same CodexLogMonitor instance (disable -> re-enable Codex
    // within one Clawd process run).
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {});
    monitor.start();
    assert.strictEqual(monitor._didInitialRecoveryScan, true);
    monitor.stop();
    assert.strictEqual(monitor._interval, null);

    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_after_restart",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const requests = [];
    monitor._onUserInputRequest = (...args) => requests.push(args);
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(requests.length, 1, "the second start() must run its own recovery sweep");
      assert.strictEqual(requests[0][1].callId, "call_after_restart");
      done();
    }, 300);
  });

  it("correctly classifies a subagent whose session_meta exceeds the old 16KB head-scan bound", (_, done) => {
    // #707 follow-up review round 3, finding 1: a session_meta that runs
    // past a fixed head-read window makes JSON.parse throw on the truncated
    // fragment, and the caller silently defaults to "not a subagent" —
    // exactly backwards from the intended fail-closed behavior.
    const testFile = path.join(dateDir, TEST_FILENAME);
    const bigSessionMeta = JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/projects/sub-big",
        source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_role: "explorer" } } },
        agent_role: "explorer",
        _pad: "p".repeat(20000), // pushes this single line past the old fixed 16KB window
      },
    });
    fs.writeFileSync(testFile, [
      bigSessionMeta,
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_big_meta_sub",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor.start();

    setTimeout(() => {
      assert.deepStrictEqual(requests, [], "a subagent must not get a card even with an oversized session_meta line");
      done();
    }, 300);
  });

  it("still extracts cwd and recovers a root session whose session_meta exceeds the old 16KB head-scan bound", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const bigSessionMeta = JSON.stringify({
      type: "session_meta",
      payload: { cwd: "/projects/root-big", _pad: "p".repeat(20000) },
    });
    fs.writeFileSync(testFile, [
      bigSessionMeta,
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_big_meta_root",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0][1].callId, "call_big_meta_root");
      assert.strictEqual(requests[0][2].cwd, "/projects/root-big");
      done();
    }, 300);
  });

  it("fails closed (no recovery) when session_meta exceeds even the new head-line budget", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const hugeSessionMeta = JSON.stringify({
      type: "session_meta",
      payload: { cwd: "/projects/huge", _pad: "p".repeat(400 * 1024) }, // past RECOVERY_HEAD_LINE_MAX_BYTES (256KB)
    });
    fs.writeFileSync(testFile, [
      hugeSessionMeta,
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_huge_meta",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {});
    const recovered = monitor._recoverStalePendingUserInput(testFile, path.basename(testFile));
    assert.strictEqual(
      recovered, null,
      "must fail closed rather than guess a role when session_meta can't be read completely within budget"
    );
  });

  it("_readByteRange reports the true raw bytesRead, not a length re-derived from the decoded string", () => {
    // #707 follow-up review round 3, finding 2: reading raw bytes and then
    // computing Buffer.byteLength(decoded_string) are NOT interchangeable
    // when the read window starts mid-character.
    const testFile = path.join(dateDir, "utf8-boundary.jsonl");
    // "中" is 3 bytes in UTF-8. Reading starting 1 byte into one of them
    // makes the leading malformed byte decode as U+FFFD (3 UTF-8 bytes
    // itself) — its re-encoded length does not equal the 1 raw byte read.
    fs.writeFileSync(testFile, "中".repeat(50), "utf8");
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {});
    const { text, bytesRead } = monitor._readByteRange(testFile, 1, 30);
    assert.strictEqual(bytesRead, 30, "bytesRead must equal the raw byte count requested");
    assert.notStrictEqual(
      Buffer.byteLength(text, "utf8"), bytesRead,
      "sanity check: this exact case is where byteLength(text) would have been wrong"
    );
  });

  it("does not overshoot true EOF when the tail window starts mid-character, and still resolves after completion", () => {
    // #707 follow-up review round 3, finding 2 — full scenario: construct a
    // file where the 1MB tail window's start byte deterministically lands
    // inside a 3-byte CJK character, then verify the recovered offset never
    // exceeds true EOF and the question still resolves once its
    // function_call_output is appended.
    const testFile = path.join(dateDir, TEST_FILENAME);
    const CJK = "中";
    const CJK_BYTES = Buffer.byteLength(CJK, "utf8");
    assert.strictEqual(CJK_BYTES, 3);
    const sessionMetaLine = JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }) + "\n";
    const requestLine = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_utf8_boundary",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    }) + "\n";
    const TAIL_WINDOW = 1024 * 1024;
    const sessionMetaBytes = Buffer.byteLength(sessionMetaLine, "utf8");
    const paddingCharCount = Math.ceil(TAIL_WINDOW / CJK_BYTES) + 1000;
    const paddingBytes = paddingCharCount * CJK_BYTES;

    // Find a filler length (0-2 ASCII bytes, inserted AFTER the padding) that
    // puts the tail window's start byte strictly inside a CJK character
    // rather than on a clean 3-byte boundary. Filler placed BEFORE the
    // padding would shift both the window start and the padding start by the
    // same amount and cancel out — it has to go after.
    let filler = "";
    for (let k = 0; k < CJK_BYTES; k++) {
      const candidateFiller = "X".repeat(k);
      const totalSize = sessionMetaBytes + paddingBytes + candidateFiller.length + 1 /* \n */ + Buffer.byteLength(requestLine, "utf8");
      const tailStart = totalSize - TAIL_WINDOW;
      const offsetIntoPadding = tailStart - sessionMetaBytes;
      if (((offsetIntoPadding % CJK_BYTES) + CJK_BYTES) % CJK_BYTES !== 0) {
        filler = candidateFiller;
        break;
      }
    }

    fs.writeFileSync(testFile, sessionMetaLine + CJK.repeat(paddingCharCount) + filler + "\n" + requestLine, "utf8");
    const stat = fs.statSync(testFile);
    const tailStart = stat.size - TAIL_WINDOW;
    const offsetIntoPadding = tailStart - sessionMetaBytes;
    assert.notStrictEqual(
      offsetIntoPadding % CJK_BYTES, 0,
      "test construction sanity check: the tail window must start mid-character or this isn't exercising the bug"
    );
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {});
    const recovered = monitor._recoverStalePendingUserInput(testFile, path.basename(testFile));
    assert.ok(recovered, "the request must still be found despite the mid-character tail cut");
    assert.strictEqual(recovered.pendingUserInputs.size, 1);
    assert.ok(recovered.offset <= stat.size, `offset (${recovered.offset}) must not overshoot true EOF (${stat.size})`);

    monitor._tracked.set(testFile, recovered);
    fs.appendFileSync(testFile, JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_utf8_boundary", output: "{}" },
    }) + "\n");
    const resolved = [];
    monitor._onUserInputResolved = (...args) => resolved.push(args);
    monitor._pollFile(testFile, path.basename(testFile));
    assert.deepStrictEqual(resolved, [[recovered.sessionId, "call_utf8_boundary"]]);
  });

  it("caps the recovery sweep to RECOVERY_SWEEP_MAX_FILES, prioritizing the most recently modified candidates", (_, done) => {
    // #707 follow-up review round 3, finding 3: each candidate's own read is
    // bounded, but an unbounded NUMBER of candidates still adds up to
    // unbounded main-process blocking.
    const CANDIDATE_COUNT = 25; // > RECOVERY_SWEEP_MAX_FILES (20)
    for (let i = 0; i < CANDIDATE_COUNT; i++) {
      const uniqueName = `rollout-2026-03-25T15-10-51-${String(i).padStart(8, "0")}-f1a9-7633-b9c7-758327137228.jsonl`;
      const filePath = path.join(dateDir, uniqueName);
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: "session_meta", payload: { cwd: `/projects/n${i}` } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: `call_budget_${i}`,
            arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
          },
        }),
      ].join("\n") + "\n");
      // Spread mtimes across the recoverable range (10min .. ~24h ago); i=0
      // is the MOST recent and must always survive a budget cut.
      const ageMs = 600000 + i * 60 * 60 * 1000;
      const mtime = new Date(Date.now() - ageMs);
      fs.utimesSync(filePath, mtime, mtime);
    }

    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor.start();

    setTimeout(() => {
      assert.ok(requests.length <= 20, `sweep must not exceed RECOVERY_SWEEP_MAX_FILES, got ${requests.length}`);
      assert.ok(requests.length > 0, "at least the most recent candidates must still be recovered");
      const recoveredCallIds = requests.map((args) => args[1].callId);
      assert.ok(
        recoveredCallIds.includes("call_budget_0"),
        "the most recently modified candidate must survive the budget cut"
      );
      done();
    }, 800);
  });

  it("rejects a request whose own timestamp is 48h old even when the file's mtime is fresh (Desktop refresh bypass)", (_, done) => {
    // #707 follow-up review round 4, finding 1: the recovery sweep's own
    // age cap only protects files it actually opens (mtime outside the
    // active window). A file Codex Desktop refreshed back into the active
    // window attaches via the normal live path instead, which had no age
    // check at all.
    const testFile = path.join(dateDir, TEST_FILENAME);
    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: oldTimestamp,
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_desktop_refresh_bypass",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
    ].join("\n") + "\n");
    // mtime is "now" (just written) — well inside the active window, so this
    // attaches via the normal live path, not the recovery sweep.

    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor.start();

    setTimeout(() => {
      assert.deepStrictEqual(
        requests, [],
        "a 48h-old request must not flash a card just because the file's mtime is fresh"
      );
      done();
    }, 300);
  });

  it("does not reject a request with a genuinely recent embedded timestamp on the fresh-mtime attach path", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const recentTimestamp = new Date(Date.now() - 60 * 1000).toISOString();
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: recentTimestamp,
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_recent_ts",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");

    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0][1].callId, "call_recent_ts");
      done();
    }, 300);
  });

  it("does not overshoot RECOVERY_SWEEP_MAX_TOTAL_BYTES (20MB) even when the next candidate would push it over the line", () => {
    // #707 follow-up review round 4, finding 2: checking bytesScanned BEFORE
    // adding the next candidate's cost, not after — otherwise exactly one
    // over-budget candidate slips through whenever the running total lands
    // just under the cap.
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {});
    const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
    const perCandidateCost = 1.1 * 1024 * 1024; // matches the review's own repro numbers
    const candidateCount = Math.ceil(MAX_TOTAL_BYTES / perCandidateCost) + 3;
    const candidates = [];
    for (let i = 0; i < candidateCount; i++) {
      const testFile = path.join(
        dateDir,
        `rollout-2026-03-25T15-10-51-${String(i).padStart(8, "0")}-f1a9-7633-b9c7-758327137228.jsonl`
      );
      fs.writeFileSync(testFile, [
        JSON.stringify({ type: "session_meta", payload: { cwd: `/projects/n${i}` } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: `call_ledger_${i}`,
            arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
          },
        }),
      ].join("\n") + "\n");
      // The real file is tiny; the candidate's claimed size simulates a
      // large rollout so the byte budget (not RECOVERY_SWEEP_MAX_FILES) is
      // what actually gets exercised.
      candidates.push({
        filePath: testFile,
        file: path.basename(testFile),
        mtimeMs: Date.now() - i,
        size: perCandidateCost,
      });
    }

    monitor._runRecoverySweep(candidates);

    const maxCandidatesUnderBudget = Math.floor(MAX_TOTAL_BYTES / perCandidateCost);
    assert.ok(
      monitor._tracked.size <= maxCandidatesUnderBudget,
      `expected at most ${maxCandidatesUnderBudget} candidates processed within the 20MB budget, got ${monitor._tracked.size}`
    );
    assert.ok(monitor._tracked.size > 0, "at least some candidates within budget must still be recovered");
  });

  it("clears a pending question's card on task_complete even without a matching function_call_output", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_abandoned",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");

    const requests = [];
    const resolved = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: (...args) => requests.push(args),
      onUserInputResolved: (...args) => resolved.push(args),
    });
    monitor._pollFile(testFile, path.basename(testFile));
    assert.strictEqual(requests.length, 1);
    assert.deepStrictEqual(resolved, []);

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    monitor._pollFile(testFile, path.basename(testFile));

    assert.deepStrictEqual(resolved, [[EXPECTED_SID, "call_abandoned"]]);
  });

  it("clears a pending question's card on turn_aborted even without a matching function_call_output", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_aborted",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }),
    ].join("\n") + "\n");

    const resolved = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), () => {}, {
      onUserInputRequest: () => {},
      onUserInputResolved: (...args) => resolved.push(args),
    });
    monitor._pollFile(testFile, path.basename(testFile));
    assert.deepStrictEqual(resolved, []);

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"turn_aborted"}}\n');
    monitor._pollFile(testFile, path.basename(testFile));

    assert.deepStrictEqual(resolved, [[EXPECTED_SID, "call_aborted"]]);
  });

  it("uses stale Codex Desktop session_meta for later live events without replaying it", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, JSON.stringify({
      timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
      type: "session_meta",
      payload: {
        cwd: "/projects/foo",
        originator: "Codex Desktop",
        source: "vscode",
      },
    }) + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));
    assert.strictEqual(events.length, 0, "old session_meta must not emit idle");

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].sid, EXPECTED_SID);
    assert.strictEqual(events[0].state, "thinking");
    assert.strictEqual(events[0].extra.cwd, "/projects/foo");
    assert.strictEqual(events[0].extra.codexOriginator, "Codex Desktop");
    assert.strictEqual(events[0].extra.codexSource, "vscode");
  });

  it("preserves Codex Desktop session metadata across tracker retirement and resume", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/projects/foo",
        originator: "Codex Desktop",
        source: "vscode",
      },
    }) + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));
    const tracked = monitor._tracked.get(testFile);
    assert.ok(tracked);
    monitor._retireTrackedFile(testFile, tracked);

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].state, "thinking");
    assert.strictEqual(events[1].extra.codexOriginator, "Codex Desktop");
    assert.strictEqual(events[1].extra.codexSource, "vscode");
  });

  it("should map task_started to thinking", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 2) {
        assert.strictEqual(states[0], "idle");
        assert.strictEqual(states[1], "thinking");
        done();
      }
    });
    monitor.start();
  });

  it("should map function_call to working", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 2) {
        assert.strictEqual(states[1], "working");
        done();
      }
    });
    monitor.start();
  });

  it("should map task_complete to idle when no tools were used", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 3) {
        assert.deepStrictEqual(states, ["idle", "thinking", "idle"]);
        done();
      }
    });
    monitor.start();
  });

  it("should map no-tool task_complete to attention when assistant output is present", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"event_msg","payload":{"type":"agent_message","message":"Short answer."}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      states.push(state);
      if (state === "attention") {
        assert.deepStrictEqual(states, ["idle", "thinking", "attention"]);
        assert.strictEqual(extra.assistantLastOutput, "Short answer.");
        done();
      }
    });
    monitor.start();
  });

  it("should map task_complete to attention when tools were used", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"ls\\"}"}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "attention") {
        assert.deepStrictEqual(states, ["idle", "thinking", "working", "attention"]);
        done();
      }
    });
    monitor.start();
  });

  it("carries Codex assistant output on task_complete", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"ls\\"}"}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end"}}',
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Implemented the Codex fix." }],
        },
      }),
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      if (event === "event_msg:task_complete") {
        assert.strictEqual(state, "attention");
        assert.strictEqual(extra.assistantLastOutput, "Implemented the Codex fix.");
        assert.strictEqual(extra.assistantLastOutputTruncated, false);
        done();
      }
    });
    monitor.start();
  });

  it("clears Codex assistant output on a new task_started turn", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"event_msg","payload":{"type":"agent_message","message":"Previous answer"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"ls\\"}"}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const completions = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      if (event !== "event_msg:task_complete") return;
      completions.push(extra);
      if (completions.length === 2) {
        assert.strictEqual(completions[0].assistantLastOutput, "Previous answer");
        assert.strictEqual(Object.prototype.hasOwnProperty.call(completions[1], "assistantLastOutput"), false);
        done();
      }
    });
    monitor.start();
  });

  it("marks subagent emits headless and resolves task_complete to idle", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: "/projects/sub",
          source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_role: "explorer" } } },
          agent_role: "explorer",
        },
      }),
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"ls\\"}"}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ state, event, headless: extra.headless, cwd: extra.cwd });
      if (event === "event_msg:task_complete") {
        assert.deepStrictEqual(events.map((entry) => entry.state), ["idle", "thinking", "working", "idle"]);
        assert.ok(events.every((entry) => entry.headless === true));
        assert.ok(events.every((entry) => entry.cwd === "/projects/sub"));
        done();
      }
    });
    monitor.start();
  });

  it("should map turn_aborted to idle", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
      '{"type":"event_msg","payload":{"type":"turn_aborted"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 3) {
        assert.strictEqual(states[2], "idle");
        done();
      }
    });
    monitor.start();
  });

  it("should dedup repeated working states", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "attention") {
        // idle, thinking, working (deduped), attention — should be 4 not 6
        assert.deepStrictEqual(states, ["idle", "thinking", "working", "attention"]);
        done();
      }
    });
    monitor.start();
  });

  it("should handle incremental writes (tail behavior)", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "thinking") {
        assert.deepStrictEqual(states, ["idle", "thinking"]);
        done();
      }
    });
    monitor.start();

    // Append after a delay (simulates Codex writing during session)
    setTimeout(() => {
      fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    }, 200);
  });

  it("advances only by bytesRead when a poll encounters a short read", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const firstLine = '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n';
    fs.writeFileSync(testFile, firstLine +
      '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      events.push({ sid, state, event });
    });

    const originalReadSync = fs.readSync;
    fs.readSync = (fd, buffer, offset, length, position) =>
      originalReadSync(fd, buffer, offset, Math.min(length, Buffer.byteLength(firstLine)), position);
    try {
      monitor._poll();
    } finally {
      fs.readSync = originalReadSync;
    }
    assert.deepStrictEqual(events.map((entry) => entry.state), ["idle"]);

    monitor._poll();
    assert.deepStrictEqual(events.map((entry) => entry.state), ["idle", "thinking"]);
  });

  it("closes the rollout fd and preserves its offset when readSync throws", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');
    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state) => events.push({ sid, state }));

    const originalReadSync = fs.readSync;
    const originalCloseSync = fs.closeSync;
    let closes = 0;
    fs.readSync = () => { throw new Error("simulated read failure"); };
    fs.closeSync = (fd) => {
      closes += 1;
      return originalCloseSync(fd);
    };
    try {
      monitor._poll();
    } finally {
      fs.readSync = originalReadSync;
      fs.closeSync = originalCloseSync;
    }
    assert.strictEqual(closes, 1);
    assert.deepStrictEqual(events, []);

    monitor._poll();
    assert.deepStrictEqual(events.map((entry) => entry.state), ["idle"]);
  });

  it("keeps successfully read bytes when closeSync reports an error", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');
    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state) => events.push({ sid, state }));

    const originalCloseSync = fs.closeSync;
    fs.closeSync = (fd) => {
      originalCloseSync(fd);
      throw new Error("simulated close failure");
    };
    try {
      monitor._poll();
    } finally {
      fs.closeSync = originalCloseSync;
    }
    assert.deepStrictEqual(events.map((entry) => entry.state), ["idle"]);
  });

  it("recovers when a rollout is truncated between statSync and readSync", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');
    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      events.push({ sid, state, event });
    });
    monitor._poll();
    events.length = 0;
    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');

    const originalReadSync = fs.readSync;
    fs.readSync = () => {
      fs.truncateSync(testFile, 0);
      return 0;
    };
    try {
      monitor._poll();
    } finally {
      fs.readSync = originalReadSync;
    }
    assert.deepStrictEqual(events, []);

    monitor._poll();
    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._poll();
    assert.deepStrictEqual(events, [{
      sid: EXPECTED_SID,
      state: "thinking",
      event: "event_msg:task_started",
    }]);
  });

  it("uses birthtime identity when Windows reports dev and ino as zero", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const initial = '{"type":"session_meta","payload":{"cwd":"/old"}}\n';
    fs.writeFileSync(testFile, initial);
    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      events.push({ sid, state, event });
    });

    const originalStatSync = fs.statSync;
    const originalFstatSync = fs.fstatSync;
    let simulatedBirthtime = 1000;
    fs.statSync = (candidate) => {
      const stat = originalStatSync(candidate);
      if (candidate !== testFile) return stat;
      return { ...stat, dev: 0, ino: 0, birthtimeMs: simulatedBirthtime };
    };
    fs.fstatSync = (fd) => {
      const stat = originalFstatSync(fd);
      return { ...stat, dev: 0, ino: 0, birthtimeMs: simulatedBirthtime };
    };
    try {
      monitor._poll();
      events.length = 0;
      fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
      monitor._poll();
      assert.deepStrictEqual(events.map((entry) => entry.state), ["thinking"]);
      events.length = 0;

      const replacement = path.join(dateDir, "windows-zero-identity.jsonl");
      fs.writeFileSync(replacement, " ".repeat(Buffer.byteLength(initial)) +
        '{"type":"event_msg","payload":{"type":"task_started"}}\n');
      fs.renameSync(replacement, testFile);
      simulatedBirthtime = 2000;
      monitor._poll();
      assert.deepStrictEqual(events, []);

      fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
      monitor._poll();
      assert.deepStrictEqual(events.map((entry) => entry.state), ["thinking"]);
    } finally {
      fs.statSync = originalStatSync;
      fs.fstatSync = originalFstatSync;
    }
  });

  it("silently rebaselines an actively tracked rollout after truncation", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/old"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
    ].join("\n") + "\n");
    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      events.push({ sid, state, event });
    });
    monitor._poll();
    events.length = 0;

    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/new"}}\n');
    monitor._poll();
    assert.deepStrictEqual(events, []);

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._poll();
    assert.deepStrictEqual(events, [{
      sid: EXPECTED_SID,
      state: "thinking",
      event: "event_msg:task_started",
    }]);
  });

  it("silently rebaselines an actively tracked rollout after inode replacement", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const initial = '{"type":"session_meta","payload":{"cwd":"/old"}}\n';
    fs.writeFileSync(testFile, initial);
    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      events.push({ sid, state, event });
    });
    monitor._poll();
    events.length = 0;

    const replacement = path.join(dateDir, "active-replacement.jsonl");
    fs.writeFileSync(replacement, " ".repeat(Buffer.byteLength(initial)) +
      '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    fs.renameSync(replacement, testFile);
    monitor._poll();
    assert.deepStrictEqual(events, []);

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._poll();
    assert.deepStrictEqual(events, [{
      sid: EXPECTED_SID,
      state: "thinking",
      event: "event_msg:task_started",
    }]);
  });

  it("silently rebaselines when a rollout is replaced between statSync and openSync", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const initial = '{"type":"session_meta","payload":{"cwd":"/old"}}\n';
    const taskStarted = '{"type":"event_msg","payload":{"type":"task_started"}}\n';
    fs.writeFileSync(testFile, initial);
    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      events.push({ sid, state, event });
    });
    monitor._poll();
    events.length = 0;

    fs.appendFileSync(testFile, taskStarted);
    const replacement = path.join(dateDir, "stat-open-replacement.jsonl");
    fs.writeFileSync(replacement, " ".repeat(Buffer.byteLength(initial)) + taskStarted);
    const originalOpenSync = fs.openSync;
    let replaced = false;
    fs.openSync = (candidate, flags, mode) => {
      if (candidate === testFile && !replaced) {
        replaced = true;
        fs.renameSync(replacement, testFile);
      }
      return originalOpenSync(candidate, flags, mode);
    };
    try {
      monitor._poll();
    } finally {
      fs.openSync = originalOpenSync;
    }
    assert.strictEqual(replaced, true);
    assert.deepStrictEqual(events, []);

    fs.appendFileSync(testFile, taskStarted);
    monitor._poll();
    assert.deepStrictEqual(events, [{
      sid: EXPECTED_SID,
      state: "thinking",
      event: "event_msg:task_started",
    }]);
  });

  it("closes the rollout fd without advancing when fstatSync fails", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');
    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state) => events.push({ sid, state }));

    const originalOpenSync = fs.openSync;
    const originalFstatSync = fs.fstatSync;
    const originalCloseSync = fs.closeSync;
    let rolloutFd = null;
    let closes = 0;
    fs.openSync = (candidate, flags, mode) => {
      const fd = originalOpenSync(candidate, flags, mode);
      if (candidate === testFile) rolloutFd = fd;
      return fd;
    };
    fs.fstatSync = (fd) => {
      if (fd === rolloutFd) throw new Error("simulated fstat failure");
      return originalFstatSync(fd);
    };
    fs.closeSync = (fd) => {
      if (fd === rolloutFd) {
        closes += 1;
        rolloutFd = null;
      }
      return originalCloseSync(fd);
    };
    try {
      monitor._poll();
    } finally {
      fs.openSync = originalOpenSync;
      fs.fstatSync = originalFstatSync;
      fs.closeSync = originalCloseSync;
    }
    assert.strictEqual(closes, 1);
    assert.deepStrictEqual(events, []);
    assert.strictEqual(monitor._tracked.get(testFile).offset, 0);

    monitor._poll();
    assert.deepStrictEqual(events.map((entry) => entry.state), ["idle"]);
  });

  it("should ignore unmapped event types", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"event_msg","payload":{"type":"token_count"}}',
      '{"type":"response_item","payload":{"type":"reasoning"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 3) {
        // token_count and reasoning should be ignored; no tool use → idle
        assert.deepStrictEqual(states, ["idle", "thinking", "idle"]);
        done();
      }
    });
    monitor.start();
  });

  it("carries token_count context usage on the next mapped state update", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 999999 },
            last_token_usage: { total_tokens: 24846 },
            model_context_window: 258400,
          },
        },
      }),
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));

    assert.deepStrictEqual(events.map((entry) => entry.event), [
      "session_meta",
      "event_msg:task_started",
      "event_msg:token_count",
      "event_msg:task_complete",
    ]);
    assert.deepStrictEqual(events[2].extra.contextUsage, {
      used: 24846,
      limit: 258400,
      percent: 10,
      source: "codex",
    });
    assert.deepStrictEqual(events[3].extra.contextUsage, {
      used: 24846,
      limit: 258400,
      percent: 10,
      source: "codex",
    });
  });

  it("does not replay attention from a metadata-only token_count write (#535)", () => {
    // token_count is a metadata refresh, not a turn boundary — Codex Desktop
    // rewrites it on focus, long after a session went idle. Carrying lastState
    // verbatim re-announces the finished turn's one-shot `attention`, and the
    // pet celebrates work the user already watched complete.
    //
    // The consumer's preserveState does not save us: it pins the stored state
    // only, while state.js's one-shot branch plays whatever state it is handed
    // (`attention` is in ONESHOT_STATE_NAMES). So a stored-idle session still
    // animates unless the carry is filtered here.
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{}"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event) => {
      events.push({ state, event });
    });

    monitor._pollFile(testFile, path.basename(testFile));
    assert.strictEqual(events[events.length - 1].state, "attention",
      "the real turn end must still celebrate once");

    // Desktop refreshes token_count against the now-idle session.
    fs.appendFileSync(testFile, JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 2000 }, model_context_window: 200000 },
      },
    }) + "\n");
    monitor._pollFile(testFile, path.basename(testFile));

    const last = events[events.length - 1];
    assert.strictEqual(last.event, "event_msg:token_count");
    assert.strictEqual(last.state, "idle",
      `token_count must not re-emit the one-shot attention, got: ${last.state}`);
  });

  it("does not treat cumulative Codex total_token_usage as context-window usage", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 27799148 },
            model_context_window: 258400,
          },
        },
      }),
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(events.map((entry) => entry.event), [
      "session_meta",
      "event_msg:task_started",
      "event_msg:task_complete",
    ]);
    assert.strictEqual(events[2].extra.contextUsage, undefined);
  });

  it("emits token_count context usage even when token_count is the final live record", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 8118607 },
            last_token_usage: { total_tokens: 23959 },
            model_context_window: 258400,
          },
        },
      }),
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));

    assert.deepStrictEqual(events.map((entry) => entry.event), [
      "session_meta",
      "event_msg:task_started",
      "event_msg:token_count",
    ]);
    assert.deepStrictEqual(events[2].extra.contextUsage, {
      used: 23959,
      limit: 258400,
      percent: 9,
      source: "codex",
    });
  });

  it("carries token_count subscription quota with a fresh line timestamp", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const lineTimestamp = new Date().toISOString();
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      JSON.stringify({
        type: "event_msg",
        timestamp: lineTimestamp,
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1783669570 },
            secondary: { used_percent: 42.6, window_minutes: 10080, resets_at: 1784256370 },
          },
        },
      }),
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));

    const tokenEvent = events.find((entry) => entry.event === "event_msg:token_count");
    assert.ok(tokenEvent, "quota-only token_count must still emit a metadata event");
    // capturedAt = the line's own timestamp: the account store orders writes
    // by observation time, not receive time.
    const capturedAt = Date.parse(lineTimestamp);
    assert.deepStrictEqual(tokenEvent.extra.codexQuota, {
      codexFiveHour: {
        usedPercent: 1,
        windowMinutes: 300,
        resetAt: 1783669570000,
        capturedAt,
      },
      codexWeekly: {
        usedPercent: 43,
        windowMinutes: 10080,
        resetAt: 1784256370000,
        capturedAt,
      },
    });
  });

  it("routes fresh Spark quota separately without attaching it as generic quota", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const lineTimestamp = new Date().toISOString();
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      JSON.stringify({
        type: "event_msg",
        timestamp: lineTimestamp,
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex_bengalfox",
            limit_name: "GPT-5.3-Codex-Spark",
            primary: { used_percent: 7, window_minutes: 10080, resets_at: 1784256370 },
          },
        },
      }),
    ].join("\n") + "\n");

    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });
    monitor._pollFile(testFile, path.basename(testFile));

    const tokenEvent = events.find((entry) => entry.event === "event_msg:token_count");
    assert.ok(tokenEvent);
    assert.strictEqual(tokenEvent.extra.codexQuota, undefined);
    assert.deepStrictEqual(tokenEvent.extra.codexSparkQuota, {
      codexWeekly: {
        usedPercent: 7,
        windowMinutes: 10080,
        resetAt: 1784256370000,
        capturedAt: Date.parse(lineTimestamp),
      },
    });
  });

  it("routes generic codex quota by the current turn model and follows model switches", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const sparkTimestamp = new Date(Date.now() - 1000).toISOString();
    const mainTimestamp = new Date().toISOString();
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      JSON.stringify({
        type: "turn_context",
        timestamp: sparkTimestamp,
        payload: { model: "gpt-5.3-codex-spark", effort: "low" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: sparkTimestamp,
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 0, window_minutes: 10080 },
          },
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: mainTimestamp,
        payload: { model: "gpt-5.6-sol", effort: "xhigh" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: mainTimestamp,
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 14, window_minutes: 10080 },
          },
        },
      }),
    ].join("\n") + "\n");

    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event, extra) => {
      if (event === "event_msg:token_count") events.push(extra);
    });
    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].codexQuota, undefined);
    assert.strictEqual(events[0].codexSparkQuota.codexWeekly.usedPercent, 0);
    assert.strictEqual(events[1].codexSparkQuota, undefined);
    assert.strictEqual(events[1].codexQuota.codexWeekly.usedPercent, 14);
    const tracked = monitor._tracked.get(testFile);
    assert.strictEqual(tracked.codexQuotaProviderHint, "codexQuota");
  });

  it("drops token_count subscription quota from stale backfill replays but keeps context usage", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      JSON.stringify({
        type: "event_msg",
        // Older than CODEX_QUOTA_MAX_AGE_MS — a restart replay, not live data.
        // Posting it would stamp fresh arbitration metadata on stale quota.
        timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        payload: {
          type: "token_count",
          info: { last_token_usage: { total_tokens: 23959 }, model_context_window: 258400 },
          rate_limits: {
            primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1783669570 },
          },
        },
      }),
    ].join("\n") + "\n");
    // Backdate mtime past BACKFILL_GRACE_MS so the file replays as history:
    // backfill bypasses the line-level timestamp guard, which is exactly the
    // path where the quota freshness gate has to hold the line.
    const backfillTime = new Date(Date.now() - 60000);
    fs.utimesSync(testFile, backfillTime, backfillTime);

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(events.length, 1, "backfill must emit exactly one snapshot");
    assert.strictEqual(events[0].extra.codexQuota, undefined);
    assert.deepStrictEqual(events[0].extra.contextUsage, {
      used: 23959,
      limit: 258400,
      percent: 9,
      source: "codex",
    });
  });

  it("should skip old files (>5min mtime)", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');
    // Backdate mtime to 10 minutes ago — outside the 5 min active window
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const config = makeConfig(tmpDir);
    let called = false;
    monitor = new CodexLogMonitor(config, () => { called = true; });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(called, false, "should not have processed old file");
      done();
    }, 300);
  });

  it("picks up slow Codex desktop sessions (mtime 3 min old) and emits only live writes", (_, done) => {
    // Two guards bundled:
    //   1. #139 gap: _getActiveDayDirs + _poll both need to find a file
    //      whose last write is in the 2–5 min range. If the file wasn't
    //      picked up, the appended live write below would never emit.
    //   2. Replay protection: the historical session_meta line (3 min old)
    //      must NOT emit "idle" on attach — that would be a replay of a
    //      stale transition on Clawd restart. Backfill mode drops it.
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/projects/slow"}}\n');
    const recent = new Date(Date.now() - 3 * 60 * 1000);
    fs.utimesSync(testFile, recent, recent);

    const config = makeConfig(tmpDir);
    const seen = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      seen.push({ state, cwd: extra.cwd });
      if (state === "thinking") {
        // Historical session_meta must not appear; only the live task_started
        // after the append should fire.
        assert.strictEqual(seen.length, 1, `expected a single live emit, got: ${JSON.stringify(seen)}`);
        assert.strictEqual(extra.cwd, "/projects/slow");
        done();
      }
    });
    monitor.start();

    // Live append after monitor has attached. This is what the user's next
    // prompt would look like in a real slow session.
    setTimeout(() => {
      fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    }, 200);
  });

  it("backfills historical turns silently, then emits live turns normally", (_, done) => {
    // Simulates Clawd restart discovering a completed turn that finished
    // minutes ago. The historical task_started/function_call/task_complete
    // sequence must NOT emit — those states belong to the past. Only
    // content appended after monitor start should reach the callback.
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"ls\\"}"}}',
      '{"type":"event_msg","payload":{"type":"exec_command_end"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");
    // Backdate past the grace window so backfill engages.
    const recent = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(testFile, recent, recent);

    const config = makeConfig(tmpDir);
    const seen = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      seen.push(state);
      if (state === "thinking") {
        // Should only see the live task_started; the four historical
        // state-bearing events must have been swallowed by backfill.
        assert.deepStrictEqual(seen, ["thinking"]);
        done();
      }
    });
    monitor.start();

    setTimeout(() => {
      fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    }, 200);
  });

  it("emits the current thinking state once when attaching to a stale in-progress turn", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
    ].join("\n") + "\n");
    const recent = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(testFile, recent, recent);

    const config = makeConfig(tmpDir);
    const seen = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      seen.push(state);
    });
    monitor.start();

    setTimeout(() => {
      assert.deepStrictEqual(seen, ["thinking"]);
      done();
    }, 250);
  });

  it("emits working before attention when attaching mid-turn to a stale shell call", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          arguments: JSON.stringify({ command: "echo hi" }),
        },
      }),
    ].join("\n") + "\n");
    const recent = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(testFile, recent, recent);

    const config = makeConfig(tmpDir);
    const seen = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      seen.push(state);
      if (state === "attention") {
        assert.deepStrictEqual(seen, ["working", "attention"]);
        done();
      }
    });
    monitor.start();

    setTimeout(() => {
      fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    }, 200);
  });

  it("keeps history-only backfills instead of timing them out", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");
    const recent = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(testFile, recent, recent);

    const config = makeConfig(tmpDir);
    const seen = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      seen.push(state);
    });
    monitor.start();

    for (const tracked of monitor._tracked.values()) {
      tracked.lastEventTime = Date.now() - 301000;
    }
    monitor._pruneTrackedFilesIfNeeded();

    assert.deepStrictEqual(seen, []);
    assert.strictEqual(monitor._tracked.size, 1);
  });

  it("does not synthesize SessionEnd from a 5 minute idle log timeout", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
      if (events.length === 2) {
        for (const tracked of monitor._tracked.values()) {
          tracked.lastEventTime = Date.now() - 301000;
        }
        monitor._pruneTrackedFilesIfNeeded();

        assert.strictEqual(events.some((entry) => entry.event === "SessionEnd"), false);
        assert.strictEqual(monitor._tracked.size, 1);
        done();
      }
    });
    monitor.start();
  });

  it("prunes only never-emitted tracked files when the tracker reaches capacity", () => {
    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, () => {});

    monitor._tracked.set("visible-session", { hasEmittedState: true, lastEventTime: 1 });
    for (let i = 0; i < 49; i++) {
      monitor._tracked.set(`silent-backfill-${i}`, {
        hasEmittedState: false,
        lastEventTime: 2 + i,
      });
    }

    monitor._pruneTrackedFilesIfNeeded();

    assert.strictEqual(monitor._tracked.size, 49);
    assert.strictEqual(monitor._tracked.has("visible-session"), true);
    assert.strictEqual(monitor._tracked.has("silent-backfill-0"), false);
  });

  it("retired emitted trackers resume from their stored offset if the file becomes active again", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const initial = '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n';
    fs.writeFileSync(testFile, initial);

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, cwd: extra.cwd, contextUsage: extra.contextUsage });
    });

    monitor._tracked.set(testFile, {
      offset: Buffer.byteLength(initial),
      cwd: "/tmp",
      sessionTitle: null,
      lastState: "idle",
      lastStateEvent: "session_meta",
      hasEmittedState: true,
      hadToolUse: false,
      isSubagent: false,
      agentPid: null,
      contextUsage: { used: 1200, limit: 12000, percent: 10, source: "codex" },
      lastEventTime: 1,
    });
    for (let i = 0; i < 49; i++) {
      monitor._tracked.set(`visible-${i}`, {
        offset: 1,
        hasEmittedState: true,
        lastEventTime: 2 + i,
      });
    }

    monitor._pruneTrackedFilesIfNeeded();
    assert.strictEqual(monitor._tracked.has(testFile), false);
    assert.strictEqual(monitor._retiredTracked.has(testFile), true);

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._pollFile(testFile, TEST_FILENAME);

    assert.deepStrictEqual(events, [{
      sid: EXPECTED_SID,
      state: "thinking",
      event: "event_msg:task_started",
      cwd: "/tmp",
      contextUsage: { used: 1200, limit: 12000, percent: 10, source: "codex" },
    }]);
  });

  it("does not replay a rollout after its active and retired trackers are both evicted", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/target"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      events.push({ sid, state, event });
    });

    // Exercise the public polling seam throughout: first consume the target,
    // then force it out of both the 50 active and 100 retired tracker LRUs.
    monitor._poll();
    for (let i = 0; i < 150; i++) {
      const suffix = String(i + 1).padStart(12, "0");
      const fileName = `rollout-2026-03-25T15-11-51-019d23d4-f1a9-7633-b9c7-${suffix}.jsonl`;
      fs.writeFileSync(
        path.join(dateDir, fileName),
        `{"type":"session_meta","payload":{"cwd":"/filler-${i}"}}\n`
      );
    }
    monitor._poll();

    assert.strictEqual(monitor._tracked.has(testFile), false);
    assert.strictEqual(monitor._retiredTracked.has(testFile), false);
    events.length = 0;

    // A live append makes the old path discoverable again. Only that append
    // should emit; the historical thinking/working/attention turn must not.
    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._poll();

    assert.deepStrictEqual(events.filter((entry) => entry.sid === EXPECTED_SID), [{
      sid: EXPECTED_SID,
      state: "thinking",
      event: "event_msg:task_started",
    }]);
  });

  it("emits exactly one request when a pending question arrives after both trackers are evicted", () => {
    // #700/#707 integration: the read-position ledger must let a rollout
    // resume from its saved offset after eviction from both the 50-active
    // and 100-retired LRUs — this exercises that same real _poll() reattach
    // path for a request_user_input line rather than a plain state event.
    // The request must fire exactly once: not zero (silently absorbed by a
    // stale-identity reattach or a ledger that failed to survive eviction),
    // and not duplicated by initializingUserInputs' deferred-emit firing on
    // top of an inline one.
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/target"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n") + "\n");

    const states = [];
    const requests = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      states.push({ sid, state, event });
    }, {
      onUserInputRequest: (...args) => requests.push(args),
    });
    monitor._findCodexWriterPid = () => null;

    monitor._poll();
    for (let i = 0; i < 150; i++) {
      const suffix = String(i + 1).padStart(12, "0");
      const fileName = `rollout-2026-03-25T15-16-51-019d23d4-f1a9-7633-b9c7-${suffix}.jsonl`;
      fs.writeFileSync(
        path.join(dateDir, fileName),
        `{"type":"session_meta","payload":{"cwd":"/filler-${i}"}}\n`
      );
    }
    monitor._poll();

    assert.strictEqual(monitor._tracked.has(testFile), false);
    assert.strictEqual(monitor._retiredTracked.has(testFile), false);
    assert.strictEqual(monitor._readPositions.has(testFile), true, "the ledger must survive double eviction");
    states.length = 0;
    requests.length = 0;

    fs.appendFileSync(testFile, JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_after_double_eviction",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    }) + "\n");
    monitor._poll();

    assert.deepStrictEqual(
      states.filter((entry) => entry.sid === EXPECTED_SID), [],
      "the historical turn must not replay"
    );
    assert.strictEqual(requests.length, 1, "the fresh request must fire exactly once");
    assert.strictEqual(requests[0][0], EXPECTED_SID);
    assert.strictEqual(requests[0][1].callId, "call_after_double_eviction");
  });

  it("preserves an incomplete JSONL record across 150-file tracker churn", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile,
      '{"type":"session_meta","payload":{"cwd":"/target"}}\n' +
      '{"type":"event_msg","payload":{"type":"task_');
    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      events.push({ sid, state, event });
    });
    monitor._poll();

    for (let i = 0; i < 150; i++) {
      const suffix = String(i + 601).padStart(12, "0");
      const fileName = `rollout-2026-03-25T15-14-51-019d23d4-f1a9-7633-b9c7-${suffix}.jsonl`;
      fs.writeFileSync(path.join(dateDir, fileName), '{"type":"session_meta","payload":{}}\n');
    }
    monitor._poll();
    assert.strictEqual(monitor._tracked.has(testFile), false);
    assert.strictEqual(monitor._retiredTracked.has(testFile), false);
    events.length = 0;

    fs.appendFileSync(testFile, 'started"}}\n');
    monitor._poll();
    assert.deepStrictEqual(events.filter((entry) => entry.sid === EXPECTED_SID), [{
      sid: EXPECTED_SID,
      state: "thinking",
      event: "event_msg:task_started",
    }]);
  });

  it("silently rebaselines a truncated rollout after its rich trackers are evicted", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/old"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}',
    ].join("\n") + "\n");

    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      events.push({ sid, state, event });
    });
    monitor._poll();
    for (let i = 0; i < 150; i++) {
      const suffix = String(i + 201).padStart(12, "0");
      const fileName = `rollout-2026-03-25T15-12-51-019d23d4-f1a9-7633-b9c7-${suffix}.jsonl`;
      fs.writeFileSync(path.join(dateDir, fileName), '{"type":"session_meta","payload":{}}\n');
    }
    monitor._poll();
    assert.strictEqual(monitor._tracked.has(testFile), false);
    assert.strictEqual(monitor._retiredTracked.has(testFile), false);
    events.length = 0;

    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/replacement"}}\n');
    monitor._poll();
    assert.deepStrictEqual(events.filter((entry) => entry.sid === EXPECTED_SID), []);

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._poll();
    assert.deepStrictEqual(events.filter((entry) => entry.sid === EXPECTED_SID), [{
      sid: EXPECTED_SID,
      state: "thinking",
      event: "event_msg:task_started",
    }]);
  });

  it("silently rebaselines a replaced rollout after its rich trackers are evicted", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const initial = [
      '{"type":"session_meta","payload":{"cwd":"/old"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
    ].join("\n") + "\n";
    fs.writeFileSync(testFile, initial);

    const events = [];
    monitor = new CodexLogMonitor(makeConfig(tmpDir), (sid, state, event) => {
      events.push({ sid, state, event });
    });
    monitor._poll();
    for (let i = 0; i < 150; i++) {
      const suffix = String(i + 401).padStart(12, "0");
      const fileName = `rollout-2026-03-25T15-13-51-019d23d4-f1a9-7633-b9c7-${suffix}.jsonl`;
      fs.writeFileSync(path.join(dateDir, fileName), '{"type":"session_meta","payload":{}}\n');
    }
    monitor._poll();
    assert.strictEqual(monitor._tracked.has(testFile), false);
    assert.strictEqual(monitor._retiredTracked.has(testFile), false);
    events.length = 0;

    // Replace the inode with a larger file whose valid events begin exactly
    // at the old offset. Offset-only recovery would replay these records.
    const replacement = path.join(dateDir, "replacement.jsonl");
    fs.writeFileSync(replacement, " ".repeat(Buffer.byteLength(initial)) + [
      '{"type":"session_meta","payload":{"cwd":"/replacement"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
    ].join("\n") + "\n");
    fs.renameSync(replacement, testFile);
    monitor._poll();
    assert.deepStrictEqual(events.filter((entry) => entry.sid === EXPECTED_SID), []);

    fs.appendFileSync(testFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    monitor._poll();
    assert.deepStrictEqual(events.filter((entry) => entry.sid === EXPECTED_SID), [{
      sid: EXPECTED_SID,
      state: "thinking",
      event: "event_msg:task_started",
    }]);
  });

  it("includes token_count context usage in backfill snapshots", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const oldTimestamp = new Date(Date.now() - 60 * 1000).toISOString();
    fs.writeFileSync(testFile, [
      JSON.stringify({
        timestamp: oldTimestamp,
        type: "session_meta",
        payload: { cwd: "/tmp" },
      }),
      JSON.stringify({
        timestamp: oldTimestamp,
        type: "event_msg",
        payload: { type: "task_started" },
      }),
      JSON.stringify({
        timestamp: oldTimestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 50000 },
            model_context_window: 200000,
          },
        },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].state, "thinking");
    assert.deepStrictEqual(events[0].extra.contextUsage, {
      used: 50000,
      limit: 200000,
      percent: 25,
      source: "codex",
    });
  });

  it("emits token_count metadata when backfill has context usage but no sustained state", () => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    const oldTimestamp = new Date(Date.now() - 60 * 1000).toISOString();
    fs.writeFileSync(testFile, [
      JSON.stringify({
        timestamp: oldTimestamp,
        type: "session_meta",
        payload: { cwd: "/tmp" },
      }),
      JSON.stringify({
        timestamp: oldTimestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 64027 },
            model_context_window: 258400,
          },
        },
      }),
    ].join("\n") + "\n");
    const oldTime = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      events.push({ sid, state, event, extra });
    });

    monitor._pollFile(testFile, path.basename(testFile));

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].state, "idle");
    assert.strictEqual(events[0].event, "event_msg:token_count");
    assert.deepStrictEqual(events[0].extra.contextUsage, {
      used: 64027,
      limit: 258400,
      percent: 25,
      source: "codex",
    });
  });

  it("should handle corrupted JSON lines gracefully", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      'THIS IS NOT JSON',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
      if (states.length === 2) {
        // Should skip corrupted line and continue
        assert.deepStrictEqual(states, ["idle", "thinking"]);
        done();
      }
    });
    monitor.start();
  });

  // ── Shell function_call mapping tests ──

  it("should map shell function_call to working without inferring codex-permission", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          arguments: JSON.stringify({ command: "rm -rf node_modules" }),
        },
      }),
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      states.push(state);
      if (state === "working") assert.strictEqual(extra.cwd, "/projects/foo");
    });
    monitor.start();

    setTimeout(() => {
      assert.deepStrictEqual(states, ["idle", "working"]);
      assert.ok(!states.includes("codex-permission"), "JSONL must not synthesize approval notifications");
      done();
    }, 2300);
  });

  it("should keep command completion and guardian activity as working signals", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          arguments: JSON.stringify({ command: "npm run build" }),
        },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "guardian_assessment", status: "in_progress" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "exec_command_end" } }),
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
    });
    monitor.start();

    setTimeout(() => {
      assert.ok(!states.includes("codex-permission"));
      assert.deepStrictEqual(states, ["idle", "working"]);
      done();
    }, 100);
  });

  it("should map explicit escalated exec_command JSONL records to working only", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/foo" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "git push",
            sandbox_permissions: "require_escalated",
            justification: "needs network",
          }),
        },
      }),
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state) => {
      states.push(state);
    });
    monitor.start();

    setTimeout(() => {
      assert.deepStrictEqual(states, ["idle", "working"]);
      assert.ok(!states.includes("codex-permission"));
      done();
    }, 100);
  });

  it("should map non-shell function_call records to working without approval detail", (_, done) => {
    const testFile = path.join(dateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "web_search",
          arguments: JSON.stringify({ query: "test" }),
        },
      }),
    ].join("\n") + "\n");

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
      states.push(state);
      assert.strictEqual(extra.permissionDetail, undefined);
    });
    monitor.start();

    setTimeout(() => {
      assert.deepStrictEqual(states, ["idle", "working"]);
      done();
    }, 100);
  });

  describe("session title extraction (turn_context.summary)", () => {
    it("captures sessionTitle on next state emit after turn_context", (_, done) => {
      const testFile = path.join(dateDir, TEST_FILENAME);
      // turn_context carries the summary; session_meta (emitted after) triggers idle
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"Fix auth bug"}}',
        '{"type":"session_meta","payload":{"cwd":"/projects/foo"}}',
      ].join("\n") + "\n");

      const config = makeConfig(tmpDir);
      monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
        if (state !== "idle") return;
        assert.strictEqual(extra.sessionTitle, "Fix auth bug");
        done();
      });
      monitor.start();
    });

    it("ignores 'none' placeholder summary", (_, done) => {
      const testFile = path.join(dateDir, TEST_FILENAME);
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"none"}}',
        '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      ].join("\n") + "\n");

      const config = makeConfig(tmpDir);
      monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
        if (state !== "idle") return;
        assert.strictEqual(extra.sessionTitle, null);
        done();
      });
      monitor.start();
    });

    it("ignores 'auto' placeholder summary", (_, done) => {
      const testFile = path.join(dateDir, TEST_FILENAME);
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"auto"}}',
        '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
      ].join("\n") + "\n");

      const config = makeConfig(tmpDir);
      monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
        if (state !== "idle") return;
        assert.strictEqual(extra.sessionTitle, null);
        done();
      });
      monitor.start();
    });

    it("does not emit a 'metaOnly' event just to deliver title", (_, done) => {
      // Writing turn_context alone (with no followed mapped event) must NOT
      // trigger _onStateChange. Title delivery rides on the next mapped event.
      const testFile = path.join(dateDir, TEST_FILENAME);
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"Title Only"}}',
      ].join("\n") + "\n");

      const config = makeConfig(tmpDir);
      let emittedCount = 0;
      monitor = new CodexLogMonitor(config, () => { emittedCount++; });
      monitor.start();

      // Give the monitor a poll cycle (pollIntervalMs=100ms) to prove nothing fires
      setTimeout(() => {
        assert.strictEqual(emittedCount, 0, `expected no emits, got ${emittedCount}`);
        done();
      }, 300);
    });

    it("updates sessionTitle when a later turn_context replaces an earlier one", (_, done) => {
      const testFile = path.join(dateDir, TEST_FILENAME);
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"Old Title"}}',
        '{"type":"session_meta","payload":{"cwd":"/tmp"}}',
        '{"type":"turn_context","payload":{"summary":"New Title"}}',
        '{"type":"event_msg","payload":{"type":"task_started"}}',
      ].join("\n") + "\n");

      const config = makeConfig(tmpDir);
      const observed = [];
      monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
        observed.push({ state, title: extra.sessionTitle });
        // task_started → thinking: we should see the new title by this point
        if (state === "thinking") {
          assert.strictEqual(extra.sessionTitle, "New Title");
          done();
        }
      });
      monitor.start();
    });

    it("uses Codex /rename thread_name from session_index.jsonl", (_, done) => {
      const testFile = path.join(dateDir, TEST_FILENAME);
      fs.writeFileSync(testFile, [
        '{"type":"turn_context","payload":{"summary":"Auto Summary"}}',
        '{"type":"session_meta","payload":{"cwd":"/projects/foo"}}',
      ].join("\n") + "\n");
      const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-index-"));
      fs.writeFileSync(path.join(codexDir, "session_index.jsonl"), [
        JSON.stringify({
          id: "019d23d4-f1a9-7633-b9c7-758327137228",
          thread_name: "요구사항개선",
        }),
      ].join("\n") + "\n", "utf8");

      const config = makeConfig(tmpDir);
      monitor = new CodexLogMonitor(config, (sid, state, event, extra) => {
        if (state !== "idle") return;
        try {
          assert.strictEqual(extra.sessionTitle, "요구사항개선");
          done();
        } finally {
          fs.rmSync(codexDir, { recursive: true, force: true });
        }
      }, { codexDir });
      monitor.start();
    });
  });

  it("should process recent existing day dirs even if not today/yesterday", (_, done) => {
    const oldDateDir = path.join(tmpDir, "2024", "01", "02");
    fs.mkdirSync(oldDateDir, { recursive: true });
    const testFile = path.join(oldDateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');

    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, (sid, state) => {
      assert.strictEqual(sid, EXPECTED_SID);
      assert.strictEqual(state, "idle");
      done();
    });
    monitor.start();
  });

  it("should process recently modified rollout files even when their day dir falls outside the 7 newest by name", (_, done) => {
    const oldDateDir = path.join(tmpDir, "2024", "01", "02");
    fs.mkdirSync(oldDateDir, { recursive: true });
    const testFile = path.join(oldDateDir, TEST_FILENAME);
    fs.writeFileSync(testFile, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');

    // Create 8 lexically newer day dirs so the old dir is excluded from the
    // name-based fallback window that existed before the mtime scan.
    for (let day = 3; day <= 10; day++) {
      fs.mkdirSync(path.join(tmpDir, "2024", "01", String(day).padStart(2, "0")), {
        recursive: true,
      });
    }

    const config = makeConfig(tmpDir);
    monitor = new CodexLogMonitor(config, (sid, state) => {
      assert.strictEqual(sid, EXPECTED_SID);
      assert.strictEqual(state, "idle");
      done();
    });

    assert.strictEqual(
      monitor._getCachedRecentExistingDayDirs(7).includes(oldDateDir),
      false,
      "old dir should be outside the legacy name-based fallback window"
    );

    monitor.start();
  });
});
