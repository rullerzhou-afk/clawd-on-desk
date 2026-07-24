"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __test } = require("../hooks/codex-remote-monitor");

const ROLLOUT_NAME =
  "rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl";

function tempRollout(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-"));
  const filePath = path.join(dir, ROLLOUT_NAME);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { dir, filePath };
}

function appendLines(filePath, lines) {
  fs.appendFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const META = { type: "session_meta", payload: { cwd: "/repo" } };
const STARTED = { type: "event_msg", payload: { type: "task_started" } };
const COMPLETE = { type: "event_msg", payload: { type: "task_complete" } };
const FUNC = { type: "response_item", payload: { type: "function_call" } };

describe("Codex remote monitor", () => {
  it("exits only after the bounded delivery-failure threshold and resets on success", () => {
    let now = 1_000;
    let exits = 0;
    const watchdog = __test.createDeliveryWatchdog({
      now: () => now,
      exit: () => { exits += 1; },
      thresholdMs: 100,
    });
    now = 1_099;
    assert.strictEqual(watchdog.record(false), false);
    assert.strictEqual(exits, 0);
    assert.strictEqual(watchdog.record(true), false);
    now = 1_198;
    assert.strictEqual(watchdog.record(false), false);
    now = 1_199;
    assert.strictEqual(watchdog.record(false), true);
    assert.strictEqual(exits, 1);
    now = 2_000;
    assert.strictEqual(watchdog.record(false), false);
    assert.strictEqual(exits, 1);
    assert.strictEqual(__test.DELIVERY_FAILURE_EXIT_MS, 24 * 60 * 60 * 1000);
  });

  it("builds root state bodies with headless false", () => {
    const body = JSON.parse(__test.buildPostStateBody(
      "codex:s1",
      "attention",
      "event_msg:task_complete",
      "/repo",
      false,
      "remote-box"
    ));

    assert.strictEqual(body.agent_id, "codex");
    assert.strictEqual(body.state, "attention");
    assert.strictEqual(body.cwd, "/repo");
    assert.strictEqual(body.host, "remote-box");
    assert.strictEqual(body.headless, false);
  });

  it("builds state bodies with assistant output when provided", () => {
    const body = JSON.parse(__test.buildPostStateBody(
      "codex:s1",
      "attention",
      "event_msg:task_complete",
      "/repo",
      false,
      "remote-box",
      { assistantLastOutput: "Done from remote Codex.", assistantLastOutputTruncated: true }
    ));

    assert.strictEqual(body.assistant_last_output, "Done from remote Codex.");
    assert.strictEqual(body.assistant_last_output_truncated, true);
  });

  it("carries assistant output on remote task_complete posts", () => {
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "Remote Codex answer" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    const complete = posted.find((body) => body.event === "event_msg:task_complete");
    assert.strictEqual(complete.assistant_last_output, "Remote Codex answer");
  });

  it("posts request_user_input details and a correlated resolution", () => {
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
      pendingUserInputs: new Map(),
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId, state, event, cwd, isSubagent, "remote-box", extra
      )));
    };
    __test.processLine(JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [
          { label: "A", description: "First" },
          { label: "B", description: "Second" },
        ] }] }),
      },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_remote", output: "{}" },
    }), entry, { postState });

    assert.strictEqual(posted[0].event, "CodexUserInputRequest");
    assert.strictEqual(posted[0].codex_user_input.call_id, "call_remote");
    assert.strictEqual(posted[0].codex_user_input.questions[0].question, "Pick one");
    assert.strictEqual(posted[1].event, "CodexUserInputResolved");
    assert.deepStrictEqual(posted[1].codex_user_input, { phase: "resolved", call_id: "call_remote" });
  });

  it("marks subagent bodies headless and maps task_complete to idle", () => {
    const entry = {
      sessionId: "codex:sub",
      cwd: "",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box"
      )));
    };

    __test.processLine(JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/repo/sub",
        source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_role: "worker" } } },
        agent_role: "worker",
      },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    assert.strictEqual(posted[0].state, "idle");
    assert.strictEqual(posted[0].headless, true);
    assert.strictEqual(posted[1].state, "idle");
    assert.strictEqual(posted[1].event, "event_msg:task_complete");
    assert.strictEqual(posted[1].headless, true);
  });

  it("builds metadata_only quota bodies on the lifecycle session_id namespace", () => {
    const body = JSON.parse(__test.buildPostQuotaBody(
      "codex:s1",
      {
        codexFiveHour: { usedPercent: 1, resetAt: 1783669570000 },
        codexWeekly: { usedPercent: 43, resetAt: 1784256370000 },
      },
      "remote-box"
    ));

    assert.strictEqual(body.metadata_only, true);
    assert.strictEqual(body.preserve_state, true);
    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.session_id, "codex:s1");
    assert.strictEqual(body.agent_id, "codex");
    assert.strictEqual(body.host, "remote-box");
    assert.deepStrictEqual(body.codex_quota, {
      codexFiveHour: { usedPercent: 1, resetAt: 1783669570000 },
      codexWeekly: { usedPercent: 43, resetAt: 1784256370000 },
    });
    assert.strictEqual(body.event, undefined);
  });

  it("posts quota for fresh token_count lines and drops stale replays", () => {
    const entry = {
      sessionId: "codex:s1",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const stateCalls = [];
    const quotaCalls = [];
    const options = {
      postState: (...args) => stateCalls.push(args),
      postQuota: (...args) => quotaCalls.push(args),
    };
    const rateLimits = {
      primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1783669570 },
      secondary: { used_percent: 42.6, window_minutes: 10080, resets_at: 1784256370 },
    };

    const lineTimestamp = new Date().toISOString();
    __test.processLine(JSON.stringify({
      type: "event_msg",
      timestamp: lineTimestamp,
      payload: { type: "token_count", rate_limits: rateLimits },
    }), entry, options);
    __test.processLine(JSON.stringify({
      type: "event_msg",
      // A restart replay: pollFile re-reads recent files from offset 0.
      timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      payload: { type: "token_count", rate_limits: rateLimits },
    }), entry, options);

    // token_count is telemetry: no lifecycle post either way.
    assert.strictEqual(stateCalls.length, 0);
    const capturedAt = Date.parse(lineTimestamp);
    assert.deepStrictEqual(quotaCalls, [
      ["codex:s1", {
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
      }],
    ]);
  });
});

describe("Codex remote monitor — stale-cleanup re-read dedup", () => {
  const tmpDirs = [];
  afterEach(() => {
    __test.tracked.clear();
    while (tmpDirs.length) {
      try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch {}
    }
  });

  function track(lines) {
    const { dir, filePath } = tempRollout(lines);
    tmpDirs.push(dir);
    return filePath;
  }

  function spy() {
    const posted = [];
    return {
      posted,
      postState: (sessionId, state, event) => posted.push({ sessionId, state, event }),
    };
  }

  it("does not re-emit historical task_complete after a stale window + resume", () => {
    const filePath = track([META, STARTED, COMPLETE]);
    const s = spy();

    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const completes1 = s.posted.filter((p) => p.event === "event_msg:task_complete");
    assert.strictEqual(completes1.length, 1, "first completion fires once");

    // Idle past the stale threshold: posts sleeping once, KEEPS the entry+offset.
    __test.cleanStaleFiles({ postState: s.postState, now: () => Date.now() + __test.STALE_MS + 1 });
    assert.strictEqual(
      s.posted.filter((p) => p.event === "stale-cleanup").length, 1,
      "sleeping posted once on going stale"
    );

    // Resume appends a brand-new line. The retained offset means only this new
    // line is processed — the old task_complete is never re-read.
    appendLines(filePath, [STARTED]);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "event_msg:task_complete").length, 1,
      "historical task_complete must not re-fire on resume"
    );
  });

  it("recoverStalePendingUserInputEntry returns a ready-to-track entry and emits the pending request", () => {
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_stale",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const filePath = track([META, request]);
    const s = spy();

    const entry = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.ok(entry, "expected a recovered entry");
    assert.strictEqual(entry.pendingUserInputs.size, 1);
    assert.strictEqual(entry.cwd, "/repo");
    assert.strictEqual(entry.initializing, false);
    assert.strictEqual(s.posted.length, 1);
    assert.strictEqual(s.posted[0].event, "CodexUserInputRequest");

    // The entry's offset is caught up to EOF, so a normal poll right after
    // sees no new bytes and replays nothing from this file's history.
    __test.tracked.set(filePath, entry);
    const s2 = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s2.postState });
    assert.deepStrictEqual(s2.posted, []);
  });

  it("recoverStalePendingUserInputEntry returns null once the question is already resolved", () => {
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_done",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const output = {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_remote_done", output: "{}" },
    };
    const filePath = track([META, request, output]);
    const s = spy();

    const entry = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(entry, null);
    assert.deepStrictEqual(s.posted, []);
  });

  it("does not resurrect a request abandoned by task_complete before the restart that recovers it", () => {
    // #707 follow-up review, finding 1: without this, a request the LIVE
    // path would have cleared on task_complete gets recovered as still-open
    // on every future restart, since the recovery scan only originally
    // looked at request/resolved pairing.
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_ended",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const filePath = track([META, request, COMPLETE]);
    const s = spy();

    const entry = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(entry, null);
    assert.deepStrictEqual(s.posted, []);
  });

  it("does not resurrect a request abandoned by turn_aborted before the restart that recovers it", () => {
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_aborted",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const ABORTED = { type: "event_msg", payload: { type: "turn_aborted" } };
    const filePath = track([META, request, ABORTED]);
    const s = spy();

    const entry = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(entry, null);
  });

  it("recovers a request that begins exactly at the 1 MiB tail boundary", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-boundary-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    const sessionMetaLine = JSON.stringify(META) + "\n";
    const requestLine = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_exact_tail_boundary",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    }) + "\n";
    const tailWindow = 1024 * 1024;
    const fillerLength = tailWindow - Buffer.byteLength(requestLine, "utf8") - 1;
    assert.ok(fillerLength > 0);
    fs.writeFileSync(filePath, sessionMetaLine + requestLine + "x".repeat(fillerLength) + "\n", "utf8");
    assert.strictEqual(fs.statSync(filePath).size - tailWindow, Buffer.byteLength(sessionMetaLine, "utf8"));
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(filePath, oldTime, oldTime);
    const s = spy();

    const entry = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.ok(entry, "the complete first tail record must not be dropped");
    assert.ok(entry.pendingUserInputs.has("call_remote_exact_tail_boundary"));
    assert.strictEqual(s.posted.length, 1);
  });

  it("does not recover a file older than RECOVERY_MAX_AGE_MS even with a genuinely unresolved question", () => {
    // #707 follow-up review, finding 3: without an age cap, a session killed
    // with an unanswered question resurrects as a permanent ghost card on
    // every future restart. This bounds the damage.
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_ancient",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const filePath = track([META, request]);
    const ancient = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h — past the 24h cap
    fs.utimesSync(filePath, ancient, ancient);
    const s = spy();

    const entry = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(entry, null);
    assert.deepStrictEqual(s.posted, []);
  });

  it("does not lose a trailing partial line split by the recovery scan's read window", () => {
    // #707 follow-up review, finding 5: recovery must not silently swallow a
    // line that's genuinely still being appended — the caller resumes
    // exactly where the scan stopped, so the partial has to survive intact
    // for the next normal poll to complete it.
    const requestLine = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_partial_tail",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const filePath = track([META, requestLine]);
    // Deliberately append an unterminated, truncated line.
    fs.appendFileSync(filePath, '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_remote_partial_ta');
    const originalSize = fs.statSync(filePath).size;

    const s = spy();
    const entry = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.ok(entry, "the request itself is still genuinely pending");
    assert.strictEqual(entry.partial, '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_remote_partial_ta');
    assert.strictEqual(entry.offset, originalSize, "offset must land at true EOF with the partial preserved separately");

    // Completing the line on a normal poll must resolve the question — this
    // is what an unconditional offset-to-EOF-with-no-partial would have
    // permanently broken.
    __test.tracked.set(filePath, entry);
    fs.appendFileSync(filePath, 'il","output":"{}"}}\n');
    const s2 = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s2.postState });
    assert.ok(s2.posted.some((p) => p.event === "CodexUserInputResolved"));
  });

  it("correctly classifies a subagent whose session_meta exceeds the old 16KB head-scan bound", () => {
    // #707 follow-up review round 3, finding 1: a session_meta that runs
    // past a fixed head-read window makes JSON.parse throw on the truncated
    // fragment, and the caller silently defaults to "not a subagent" —
    // exactly backwards from the intended fail-closed behavior.
    const bigSessionMeta = {
      type: "session_meta",
      payload: {
        cwd: "/repo/sub-big",
        source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_role: "explorer" } } },
        agent_role: "explorer",
        _pad: "p".repeat(20000),
      },
    };
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_big_meta_sub",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const filePath = track([bigSessionMeta, request]);
    const s = spy();

    const entry = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.ok(entry, "the request is genuinely pending — this must not be rejected as a whole");
    assert.strictEqual(entry.isSubagent, true);
    assert.deepStrictEqual(s.posted, [], "a subagent must not get a card even with an oversized session_meta line");
  });

  it("still extracts cwd and recovers a root session whose session_meta exceeds the old 16KB head-scan bound", () => {
    const bigSessionMeta = {
      type: "session_meta",
      payload: { cwd: "/repo/root-big", _pad: "p".repeat(20000) },
    };
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_big_meta_root",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const filePath = track([bigSessionMeta, request]);
    const s = spy();

    const entry = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.ok(entry);
    assert.strictEqual(entry.isSubagent, false);
    assert.strictEqual(entry.cwd, "/repo/root-big");
    assert.strictEqual(s.posted.length, 1);
    assert.strictEqual(s.posted[0].event, "CodexUserInputRequest");
  });

  it("fails closed (no recovery) when session_meta exceeds even the new head-line budget", () => {
    const hugeSessionMeta = {
      type: "session_meta",
      payload: { cwd: "/repo/huge", _pad: "p".repeat(400 * 1024) }, // past RECOVERY_HEAD_LINE_MAX_BYTES (256KB)
    };
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_huge_meta",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const filePath = track([hugeSessionMeta, request]);

    const entry = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, {});
    assert.strictEqual(
      entry, null,
      "must fail closed rather than guess a role when session_meta can't be read completely within budget"
    );
  });

  it("readByteRange reports the true raw bytesRead, not a length re-derived from the decoded string", () => {
    // #707 follow-up review round 3, finding 2: reading raw bytes and then
    // computing Buffer.byteLength(decoded_string) are NOT interchangeable
    // when the read window starts mid-character.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    // "中" is 3 bytes in UTF-8. Reading starting 1 byte into one of them
    // makes the leading malformed byte decode as U+FFFD (3 UTF-8 bytes
    // itself) — its re-encoded length does not equal the 1 raw byte read.
    fs.writeFileSync(filePath, "中".repeat(50), "utf8");
    const { text, bytesRead } = __test.readByteRange(filePath, 1, 30);
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
    const CJK = "中";
    const CJK_BYTES = Buffer.byteLength(CJK, "utf8");
    assert.strictEqual(CJK_BYTES, 3);
    const sessionMetaLine = JSON.stringify(META) + "\n";
    const requestLine = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_utf8_boundary",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    }) + "\n";
    const TAIL_WINDOW = 1024 * 1024;
    const sessionMetaBytes = Buffer.byteLength(sessionMetaLine, "utf8");
    const paddingCharCount = Math.ceil(TAIL_WINDOW / CJK_BYTES) + 1000;
    const paddingBytes = paddingCharCount * CJK_BYTES;

    // Find a filler length (0-2 ASCII bytes, inserted AFTER the padding)
    // that puts the tail window's start byte strictly inside a CJK
    // character rather than on a clean 3-byte boundary.
    let filler = "";
    for (let k = 0; k < CJK_BYTES; k++) {
      const candidateFiller = "X".repeat(k);
      const totalSize = sessionMetaBytes + paddingBytes + candidateFiller.length + 1 + Buffer.byteLength(requestLine, "utf8");
      const tailStart = totalSize - TAIL_WINDOW;
      const offsetIntoPadding = tailStart - sessionMetaBytes;
      if (((offsetIntoPadding % CJK_BYTES) + CJK_BYTES) % CJK_BYTES !== 0) {
        filler = candidateFiller;
        break;
      }
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    fs.writeFileSync(filePath, sessionMetaLine + CJK.repeat(paddingCharCount) + filler + "\n" + requestLine, "utf8");
    const stat = fs.statSync(filePath);
    const tailStart = stat.size - TAIL_WINDOW;
    const offsetIntoPadding = tailStart - sessionMetaBytes;
    assert.notStrictEqual(
      offsetIntoPadding % CJK_BYTES, 0,
      "test construction sanity check: the tail window must start mid-character or this isn't exercising the bug"
    );

    const s = spy();
    const recovered = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.ok(recovered, "the request must still be found despite the mid-character tail cut");
    assert.strictEqual(recovered.pendingUserInputs.size, 1);
    assert.ok(recovered.offset <= stat.size, `offset (${recovered.offset}) must not overshoot true EOF (${stat.size})`);

    __test.tracked.set(filePath, recovered);
    fs.appendFileSync(filePath, JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_remote_utf8_boundary", output: "{}" },
    }) + "\n");
    const s2 = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s2.postState });
    assert.ok(s2.posted.some((p) => p.event === "CodexUserInputResolved"));
  });

  it("caps the recovery sweep to RECOVERY_SWEEP_MAX_FILES, prioritizing the most recently modified candidates", () => {
    // #707 follow-up review round 3, finding 3: each candidate's own read is
    // bounded, but an unbounded NUMBER of candidates still adds up to
    // unbounded blocking.
    const CANDIDATE_COUNT = 25; // > RECOVERY_SWEEP_MAX_FILES (20)
    const candidates = [];
    for (let i = 0; i < CANDIDATE_COUNT; i++) {
      const uniqueName = `rollout-2026-03-25T15-10-51-${String(i).padStart(8, "0")}-f1a9-7633-b9c7-758327137228.jsonl`;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-budget-"));
      tmpDirs.push(dir);
      const filePath = path.join(dir, uniqueName);
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: "session_meta", payload: { cwd: `/repo/n${i}` } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: `call_remote_budget_${i}`,
            arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
          },
        }),
      ].join("\n") + "\n");
      const stat = fs.statSync(filePath);
      // i=0 is the MOST recent and must always survive a budget cut.
      candidates.push({
        filePath,
        file: uniqueName,
        mtimeMs: Date.now() - (600000 + i * 60 * 60 * 1000),
        size: stat.size,
      });
    }

    const s = spy();
    __test.runRecoverySweep(candidates, { postState: s.postState });

    const recoveredSessionIds = s.posted
      .filter((p) => p.event === "CodexUserInputRequest")
      .map((p) => p.sessionId);
    assert.ok(recoveredSessionIds.length <= 20, `sweep must not exceed RECOVERY_SWEEP_MAX_FILES, got ${recoveredSessionIds.length}`);
    assert.ok(recoveredSessionIds.length > 0, "at least the most recent candidates must still be recovered");
    // candidates[0] (i=0) is the most recently modified — extractSessionId
    // takes the filename's last 5 dash-separated segments.
    assert.ok(
      recoveredSessionIds.includes("codex:00000000-f1a9-7633-b9c7-758327137228"),
      "the most recently modified candidate must survive the budget cut"
    );
  });

  it("rejects a request whose own timestamp is 48h old even when the file's mtime is fresh (Desktop refresh bypass)", () => {
    // #707 follow-up review round 4, finding 1: the recovery sweep's own
    // age cap only protects files it actually opens (mtime outside the
    // active window). A file whose mtime got refreshed back into the
    // active window attaches via the normal live path instead, which had
    // no age check at all.
    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const request = {
      type: "response_item",
      timestamp: oldTimestamp,
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_desktop_refresh_bypass",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    // track() writes with a fresh mtime (just now) — attaches via the
    // normal live path, not the recovery sweep.
    const filePath = track([META, request]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.deepStrictEqual(
      s.posted.filter((p) => p.event === "CodexUserInputRequest"), [],
      "a 48h-old request must not flash a card just because the file's mtime is fresh"
    );
  });

  it("does not reject a request with a genuinely recent embedded timestamp on the fresh-mtime attach path", () => {
    const recentTimestamp = new Date(Date.now() - 60 * 1000).toISOString();
    const request = {
      type: "response_item",
      timestamp: recentTimestamp,
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_recent_ts",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const filePath = track([META, request]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.ok(s.posted.some((p) => p.event === "CodexUserInputRequest"));
  });

  it("does not overshoot RECOVERY_SWEEP_MAX_TOTAL_BYTES (20MB) even when the next candidate would push it over the line", () => {
    // #707 follow-up review round 4, finding 2: checking bytesScanned BEFORE
    // adding the next candidate's cost, not after.
    const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
    const perCandidateCost = 1.1 * 1024 * 1024; // matches the review's own repro numbers
    const candidateCount = Math.ceil(MAX_TOTAL_BYTES / perCandidateCost) + 3;
    const candidates = [];
    for (let i = 0; i < candidateCount; i++) {
      const uniqueName = `rollout-2026-03-25T15-10-51-${String(i).padStart(8, "0")}-f1a9-7633-b9c7-758327137228.jsonl`;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-ledger-"));
      tmpDirs.push(dir);
      const filePath = path.join(dir, uniqueName);
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: "session_meta", payload: { cwd: `/repo/n${i}` } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: `call_remote_ledger_${i}`,
            arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
          },
        }),
      ].join("\n") + "\n");
      // The real file is tiny; the candidate's claimed size simulates a
      // large rollout so the byte budget is what actually gets exercised.
      candidates.push({ filePath, file: uniqueName, mtimeMs: Date.now() - i, size: perCandidateCost });
    }

    const s = spy();
    __test.runRecoverySweep(candidates, { postState: s.postState });

    const recoveredCount = s.posted.filter((p) => p.event === "CodexUserInputRequest").length;
    const maxCandidatesUnderBudget = Math.floor(MAX_TOTAL_BYTES / perCandidateCost);
    assert.ok(
      recoveredCount <= maxCandidatesUnderBudget,
      `expected at most ${maxCandidatesUnderBudget} candidates processed within the 20MB budget, got ${recoveredCount}`
    );
    assert.ok(recoveredCount > 0);
  });

  it("refreshes staleness bookkeeping on a request_user_input notification, not just the generic path", () => {
    const filePath = track([META]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    // Backdate as if this session has already been quiet long enough to be
    // due for the next stale sweep.
    __test.tracked.get(filePath).lastEventTime = Date.now() - __test.STALE_MS - 1000;

    appendLines(filePath, [{
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_wake",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    }]);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.ok(s.posted.some((p) => p.event === "CodexUserInputRequest"), "notification must post");

    __test.cleanStaleFiles({ postState: s.postState, now: () => Date.now() });
    assert.deepStrictEqual(
      s.posted.filter((p) => p.event === "stale-cleanup"), [],
      "a session that just posted a live notification must not immediately be flipped back to sleeping"
    );
  });

  it("clears a pending question's card on task_complete even without a matching function_call_output", () => {
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_abandoned",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const filePath = track([META, request]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.ok(s.posted.some((p) => p.event === "CodexUserInputRequest"));

    appendLines(filePath, [COMPLETE]);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.ok(
      s.posted.some((p) => p.event === "CodexUserInputResolved"),
      "task_complete must clear a still-open card"
    );
    assert.strictEqual(__test.tracked.get(filePath).pendingUserInputs.size, 0);
  });

  it("reconstructs pending questions on initial attach without flashing resolved history", () => {
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_initial",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const output = {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_initial", output: "{}" },
    };
    const resolvedFile = track([META, request, output]);
    const resolvedSpy = spy();
    __test.pollFile(resolvedFile, ROLLOUT_NAME, { postState: resolvedSpy.postState });
    assert.strictEqual(
      resolvedSpy.posted.filter((post) => post.event === "CodexUserInputRequest").length,
      0
    );

    const pendingFile = track([META, request]);
    const pendingSpy = spy();
    __test.pollFile(pendingFile, ROLLOUT_NAME, { postState: pendingSpy.postState });
    assert.strictEqual(
      pendingSpy.posted.filter((post) => post.event === "CodexUserInputRequest").length,
      1
    );
  });

  it("still fires a genuinely new completion after resume", () => {
    const filePath = track([META, STARTED, COMPLETE]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    __test.cleanStaleFiles({ postState: s.postState, now: () => Date.now() + __test.STALE_MS + 1 });

    // The resumed turn completes again — a real second completion.
    appendLines(filePath, [STARTED, COMPLETE]);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "event_msg:task_complete").length, 2,
      "a real new completion after resume still fires"
    );
  });

  it("posts sleeping only once while a session stays idle", () => {
    const filePath = track([META, STARTED]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    const future = () => Date.now() + __test.STALE_MS + 1;
    __test.cleanStaleFiles({ postState: s.postState, now: future });
    __test.cleanStaleFiles({ postState: s.postState, now: future });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "stale-cleanup").length, 1,
      "stale-cleanup must not re-post sleeping every tick"
    );
  });

  it("re-reads from 0 when the rollout file is truncated/rotated", () => {
    const filePath = track([META, STARTED]); // idle, thinking
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.strictEqual(s.posted.filter((p) => p.event === "event_msg:task_complete").length, 0);

    // Recreate the file smaller than the retained offset (rotation/truncation).
    fs.writeFileSync(filePath, JSON.stringify(COMPLETE) + "\n");
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "event_msg:task_complete").length, 1,
      "truncated file must restart at offset 0 instead of skipping new content"
    );
  });

  it("wakes a stale session on the next working event", () => {
    const filePath = track([META, FUNC]); // idle, working
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const workingBefore = s.posted.filter((p) => p.state === "working").length;
    assert.strictEqual(workingBefore, 1);

    __test.cleanStaleFiles({ postState: s.postState, now: () => Date.now() + __test.STALE_MS + 1 });
    assert.strictEqual(__test.tracked.get(filePath).stale, true);

    // Same working-mapped event after going stale must wake the pet, not be
    // swallowed by the same-state dedup.
    appendLines(filePath, [FUNC]);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.state === "working").length, 2,
      "next working event after stale must re-post working"
    );
    assert.strictEqual(__test.tracked.get(filePath).stale, false, "stale cleared on wake");
  });

  it("prunes tracked entries whose directory left the scan window", () => {
    const filePath = track([META, STARTED]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.strictEqual(__test.tracked.has(filePath), true);

    // Simulate the day rolling over: the file's dir is no longer in-window.
    __test.pruneTrackedOutOfWindow({ getSessionDirs: () => ["/some/other/window/dir"] });
    assert.strictEqual(__test.tracked.has(filePath), false, "out-of-window entry pruned");
  });
});
