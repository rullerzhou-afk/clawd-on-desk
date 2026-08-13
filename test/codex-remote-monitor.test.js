"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __test } = require("../hooks/codex-remote-monitor");

const ROLLOUT_NAME =
  "rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl";

function uniqueRolloutName(index) {
  return `rollout-2026-03-25T15-10-51-${String(index).padStart(8, "0")}-f1a9-7633-b9c7-758327137228.jsonl`;
}

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
        providerKey: "codexQuota",
        quota: {
          codexFiveHour: { usedPercent: 1, resetAt: 1783669570000 },
          codexWeekly: { usedPercent: 43, resetAt: 1784256370000 },
        },
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
    assert.strictEqual(body.codex_spark_quota, undefined);
  });

  it("builds Spark-only quota bodies without forwarding raw identity metadata", () => {
    const body = JSON.parse(__test.buildPostQuotaBody(
      "codex:s1",
      {
        providerKey: "codexSparkQuota",
        quota: {
          codexWeekly: { usedPercent: 7, windowMinutes: 10080 },
        },
      },
      "remote-box"
    ));

    assert.deepStrictEqual(body.codex_spark_quota, {
      codexWeekly: { usedPercent: 7, windowMinutes: 10080 },
    });
    assert.strictEqual(body.codex_quota, undefined);
    assert.strictEqual(body.limit_id, undefined);
    assert.strictEqual(body.limit_name, undefined);
    assert.strictEqual(body.plan_type, undefined);
    assert.strictEqual(body.model, undefined);
  });

  it("fails closed when asked to serialize an unknown quota provider", () => {
    assert.strictEqual(__test.buildPostQuotaBody(
      "codex:s1",
      {
        providerKey: "codexFutureQuota",
        quota: { codexWeekly: { usedPercent: 99, windowMinutes: 10080 } },
      },
      "remote-box"
    ), null);
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
        providerKey: "codexQuota",
        quota: {
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
        },
      }],
    ]);
  });

  it("posts fresh Spark reports through the independent provider envelope", () => {
    const entry = {
      sessionId: "codex:s1",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const quotaCalls = [];
    const lineTimestamp = new Date().toISOString();
    __test.processLine(JSON.stringify({
      type: "event_msg",
      timestamp: lineTimestamp,
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex_bengalfox",
          limit_name: "GPT-5.3-Codex-Spark",
          primary: { used_percent: 7, window_minutes: 10080 },
        },
      },
    }), entry, { postQuota: (...args) => quotaCalls.push(args) });

    assert.deepStrictEqual(quotaCalls, [[
      "codex:s1",
      {
        providerKey: "codexSparkQuota",
        quota: {
          codexWeekly: {
            usedPercent: 7,
            windowMinutes: 10080,
            capturedAt: Date.parse(lineTimestamp),
          },
        },
      },
    ]]);
  });

  it("routes a generic codex id by turn model and follows remote model switches", () => {
    const entry = {
      sessionId: "codex:s1",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const quotaCalls = [];
    const options = { postQuota: (...args) => quotaCalls.push(args) };
    const sparkTimestamp = new Date(Date.now() - 1000).toISOString();
    const mainTimestamp = new Date().toISOString();

    __test.processLine(JSON.stringify({
      type: "turn_context",
      timestamp: sparkTimestamp,
      payload: { model: "gpt-5.3-codex-spark", effort: "low" },
    }), entry, options);
    __test.processLine(JSON.stringify({
      type: "event_msg",
      timestamp: sparkTimestamp,
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 0, window_minutes: 10080 },
        },
      },
    }), entry, options);
    __test.processLine(JSON.stringify({
      type: "turn_context",
      timestamp: mainTimestamp,
      payload: { model: "gpt-5.6-sol", effort: "xhigh" },
    }), entry, options);
    __test.processLine(JSON.stringify({
      type: "event_msg",
      timestamp: mainTimestamp,
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 14, window_minutes: 10080 },
        },
      },
    }), entry, options);

    assert.deepStrictEqual(quotaCalls.map(([, report]) => ({
      providerKey: report.providerKey,
      usedPercent: report.quota.codexWeekly.usedPercent,
    })), [
      { providerKey: "codexSparkQuota", usedPercent: 0 },
      { providerKey: "codexQuota", usedPercent: 14 },
    ]);
    assert.strictEqual(entry.codexQuotaProviderHint, "codexQuota");
  });
});

describe("Codex remote monitor — stale-cleanup re-read dedup", () => {
  const tmpDirs = [];
  afterEach(() => {
    __test.resetMonitorStateForTests();
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

  it("caps one remote rollout read at 4 MiB and initializes only at snapshot EOF", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-large-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    const invalidLine = "x".repeat(1023) + "\n";
    fs.writeFileSync(filePath, JSON.stringify(META) + "\n" + invalidLine.repeat(5200));
    const s = spy();

    const first = __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const entry = __test.tracked.get(filePath);
    assert.ok(first.requestedBytes <= __test.MAX_POLL_READ_BYTES);
    assert.ok(first.bytesRead <= __test.MAX_POLL_READ_BYTES);
    assert.ok(entry.offset > 0 && entry.offset < fs.statSync(filePath).size);
    assert.strictEqual(entry.initializing, true);
    assert.strictEqual(__test.replayWork.has(filePath), true);

    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.strictEqual(entry.offset, fs.statSync(filePath).size);
    assert.strictEqual(entry.initializing, false);
    assert.strictEqual(__test.replayWork.has(filePath), false);
  });

  it("does not post a remote question resolved in a later quantum", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-cross-quantum-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    const request = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_cross_quantum",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick", options: [] }] }),
      },
    });
    const resolution = JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_remote_cross_quantum", output: "{}" },
    });
    const fillerLine = "x".repeat(1023) + "\n";
    fs.writeFileSync(filePath, [
      JSON.stringify(META),
      request,
      fillerLine.repeat(4200).slice(0, -1),
      resolution,
    ].join("\n") + "\n");
    const s = spy();

    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.strictEqual(__test.tracked.get(filePath).initializing, true);
    assert.strictEqual(s.posted.some((post) => post.event === "CodexUserInputRequest"), false);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.strictEqual(__test.tracked.get(filePath).initializing, false);
    assert.strictEqual(s.posted.some((post) => post.event === "CodexUserInputRequest"), false);
    assert.strictEqual(s.posted.some((post) => post.event === "CodexUserInputResolved"), false);
  });

  it("drops staged remote pending input when an initializing rollout truncates to empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-init-truncate-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    const request = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_truncated",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick", options: [] }] }),
      },
    });
    const fillerLine = "x".repeat(1023) + "\n";
    fs.writeFileSync(filePath, JSON.stringify(META) + "\n" + request + "\n" + fillerLine.repeat(4200));
    const s = spy();

    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const entry = __test.tracked.get(filePath);
    assert.strictEqual(entry.initializing, true);
    assert.strictEqual(entry.pendingUserInputs.size, 1);
    fs.truncateSync(filePath, 0);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.strictEqual(entry.offset, 0);
    assert.strictEqual(entry.initializing, false);
    assert.strictEqual(entry.pendingUserInputs.size, 0);
    assert.strictEqual(s.posted.some((post) => post.event === "CodexUserInputRequest"), false);
  });

  it("does not discard a remote >64 KiB short read before snapshot EOF", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-short-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    const record = JSON.stringify({
      type: "session_meta",
      payload: { cwd: "/short", blob: "界".repeat(80 * 1024) },
    }) + "\n";
    fs.writeFileSync(filePath, record);

    const originalReadSync = fs.readSync;
    fs.readSync = (fd, buffer, offset, length, position) =>
      originalReadSync(fd, buffer, offset, Math.min(length, 96 * 1024), position);
    try {
      const first = __test.pollFile(filePath, ROLLOUT_NAME, { postState: () => {} });
      assert.strictEqual(first.kind, "incomplete");
      assert.strictEqual(__test.tracked.get(filePath).offset, 0);
    } finally {
      fs.readSync = originalReadSync;
    }
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: () => {} });
    assert.strictEqual(__test.tracked.get(filePath).offset, Buffer.byteLength(record));
  });

  it("finalizes remote initialization at an incomplete snapshot EOF without caching partial", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-incomplete-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    fs.writeFileSync(filePath, '{"type":"event_msg","payload":{"type":"task_');
    const s = spy();

    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const entry = __test.tracked.get(filePath);
    assert.strictEqual(entry.offset, 0);
    assert.strictEqual(entry.initializing, false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, "partial"), false);

    fs.appendFileSync(filePath, 'started"}}\n');
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.deepStrictEqual(s.posted.map((event) => event.event), ["event_msg:task_started"]);
  });

  it("abandons a stuck remote replay at validated EOF without reposting lifecycle", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-stuck-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    const prefix = [
      JSON.stringify(META),
      JSON.stringify(STARTED),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "kept output" } }),
    ].join("\n") + "\n";
    const fillerLine = "x".repeat(1023) + "\n";
    const filler = fillerLine.repeat(Math.ceil(
      (4 * 1024 * 1024 + 4096 - Buffer.byteLength(prefix)) / Buffer.byteLength(fillerLine)
    ));
    fs.writeFileSync(filePath, prefix + filler);
    const s = spy();

    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const item = __test.replayWork.get(filePath);
    assert.ok(item);
    item.lastProgressAt = Date.now() - 31_000;
    s.posted.length = 0;
    const originalReadSync = fs.readSync;
    fs.readSync = () => 0;
    try {
      for (let i = 0; i < 8; i++) {
        __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
      }
    } finally {
      fs.readSync = originalReadSync;
    }
    const entry = __test.tracked.get(filePath);
    assert.strictEqual(__test.replayWork.has(filePath), false);
    assert.strictEqual(entry.offset, fs.statSync(filePath).size);
    assert.ok(entry.readBackoffUntil > Date.now());
    assert.strictEqual(entry.assistantLastOutput, "kept output");
    assert.deepStrictEqual(s.posted, []);

    appendLines(filePath, [COMPLETE]);
    assert.strictEqual(
      __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState }).kind,
      "backoff"
    );
    entry.readBackoffUntil = Date.now() - 1;
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.deepStrictEqual(s.posted, [{
      sessionId: "codex:019d23d4-f1a9-7633-b9c7-758327137228",
      state: "attention",
      event: "event_msg:task_complete",
    }]);
  });

  it("continues remote exponential backoff after a validated baseline keeps failing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-stuck-again-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    const prefix = JSON.stringify(META) + "\n";
    const fillerLine = "x".repeat(1023) + "\n";
    const filler = fillerLine.repeat(Math.ceil(
      (4 * 1024 * 1024 + 4096 - Buffer.byteLength(prefix)) / Buffer.byteLength(fillerLine)
    ));
    fs.writeFileSync(filePath, prefix + filler);

    __test.pollFile(filePath, ROLLOUT_NAME, { postState: () => {} });
    const item = __test.replayWork.get(filePath);
    item.lastProgressAt = Date.now() - 31_000;
    const originalReadSync = fs.readSync;
    fs.readSync = () => 0;
    try {
      for (let i = 0; i < 8; i++) __test.pollFile(filePath, ROLLOUT_NAME, { postState: () => {} });
    } finally {
      fs.readSync = originalReadSync;
    }

    const entry = __test.tracked.get(filePath);
    assert.strictEqual(entry.readBackoffLevel, 1);
    appendLines(filePath, [COMPLETE]);
    entry.readBackoffUntil = Date.now() - 1;
    const secondFailureStartedAt = Date.now();
    let reads = 0;
    fs.readSync = () => { reads += 1; return 0; };
    try {
      assert.strictEqual(
        __test.pollFile(filePath, ROLLOUT_NAME, { postState: () => {} }).kind,
        "no-progress"
      );
      assert.strictEqual(entry.readBackoffLevel, 2);
      assert.ok(
        entry.readBackoffUntil >= secondFailureStartedAt + 59_000,
        "the second remote failure epoch must back off for about 60 seconds"
      );
      assert.strictEqual(
        __test.pollFile(filePath, ROLLOUT_NAME, { postState: () => {} }).kind,
        "backoff"
      );
      assert.strictEqual(reads, 1);
    } finally {
      fs.readSync = originalReadSync;
    }
  });

  it("bounds one remote poll to 16 MiB and resumes the remaining backlog", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-poll-budget-"));
    tmpDirs.push(dir);
    const filePaths = [];
    for (let i = 0; i < 10; i++) {
      const filePath = path.join(dir, uniqueRolloutName(i));
      fs.writeFileSync(filePath, "");
      fs.truncateSync(filePath, 5 * 1024 * 1024);
      filePaths.push(filePath);
    }
    const requested = [];
    const originalReadSync = fs.readSync;
    const originalStatSync = fs.statSync;
    const originalBufferAlloc = Buffer.alloc;
    const allocations = [];
    let rolloutStats = 0;
    fs.readSync = (fd, buffer, offset, length, position) => {
      requested.push(length);
      return originalReadSync(fd, buffer, offset, length, position);
    };
    fs.statSync = (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith(dir + path.sep)) rolloutStats += 1;
      return originalStatSync(...args);
    };
    Buffer.alloc = (size, ...args) => {
      if (size > 0) allocations.push(size);
      return originalBufferAlloc(size, ...args);
    };
    try {
      __test.poll({ getSessionDirs: () => [dir], postState: () => {} });
    } finally {
      fs.readSync = originalReadSync;
      fs.statSync = originalStatSync;
      Buffer.alloc = originalBufferAlloc;
    }
    assert.ok(requested.every((length) => length <= __test.MAX_POLL_READ_BYTES));
    assert.strictEqual(
      requested.reduce((sum, length) => sum + length, 0),
      __test.MAX_POLL_TOTAL_REQUEST_BYTES
    );
    assert.ok(allocations.every((length) => length <= __test.MAX_POLL_READ_BYTES));
    assert.strictEqual(
      allocations.reduce((sum, length) => sum + length, 0),
      __test.MAX_POLL_TOTAL_REQUEST_BYTES
    );
    assert.ok(rolloutStats <= __test.MAX_POLL_FILE_ATTEMPTS);
    const firstOffsets = new Map(filePaths.map((filePath) => [
      filePath,
      __test.tracked.get(filePath) ? __test.tracked.get(filePath).offset : 0,
    ]));

    __test.poll({ getSessionDirs: () => [dir], postState: () => {} });
    assert.ok(filePaths.some((filePath) => (
      (__test.tracked.get(filePath) ? __test.tracked.get(filePath).offset : 0)
      > firstOffsets.get(filePath)
    )));
  });

  it("defers an intact remote 3 MiB quantum when only 1 MiB remains, then reads it whole", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-intact-budget-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    const fileSize = 3 * 1024 * 1024;
    fs.writeFileSync(filePath, "");
    fs.truncateSync(filePath, fileSize);

    const originalReadSync = fs.readSync;
    const requested = [];
    fs.readSync = (fd, buffer, offset, length, position) => {
      requested.push(length);
      return originalReadSync(fd, buffer, offset, length, position);
    };
    try {
      const constrained = { remainingRequestBytes: 1024 * 1024 };
      assert.deepStrictEqual(
        __test.pollFile(filePath, ROLLOUT_NAME, {
          pollContext: constrained,
          postState: () => {},
        }),
        { kind: "budget", requestedBytes: 0, bytesRead: 0 }
      );
      assert.deepStrictEqual(requested, [], "an undersized remote remainder must not issue a fragmentary read");
      assert.strictEqual(constrained.remainingRequestBytes, 1024 * 1024);
      assert.strictEqual(__test.tracked.get(filePath).offset, 0);

      const nextPoll = { remainingRequestBytes: 16 * 1024 * 1024 };
      const result = __test.pollFile(filePath, ROLLOUT_NAME, {
        pollContext: nextPoll,
        postState: () => {},
      });
      assert.strictEqual(result.kind, "discarded");
      assert.deepStrictEqual(requested, [fileSize]);
      assert.strictEqual(__test.tracked.get(filePath).offset, fileSize);
      assert.strictEqual(__test.replayWork.has(filePath), false);
    } finally {
      fs.readSync = originalReadSync;
    }
  });

  it("caps remote zero-byte candidate attempts at 64 and rotates to new paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-attempts-"));
    tmpDirs.push(dir);
    for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(dir, uniqueRolloutName(i)), "");
    const originalStatSync = fs.statSync;
    let current = null;
    const callsByPoll = [];
    fs.statSync = (...args) => {
      if (current && typeof args[0] === "string" && args[0].startsWith(dir + path.sep)) {
        current.push(args[0]);
      }
      return originalStatSync(...args);
    };
    try {
      current = [];
      __test.poll({ getSessionDirs: () => [dir], postState: () => {} });
      callsByPoll.push(current);
      current = [];
      __test.poll({ getSessionDirs: () => [dir], postState: () => {} });
      callsByPoll.push(current);
    } finally {
      fs.statSync = originalStatSync;
    }
    assert.ok(callsByPoll[0].length <= __test.MAX_POLL_FILE_ATTEMPTS);
    assert.ok(callsByPoll[1].length <= __test.MAX_POLL_FILE_ATTEMPTS);
    const first = new Set(callsByPoll[0]);
    assert.ok(callsByPoll[1].some((filePath) => !first.has(filePath)));
  });

  it("deduplicates a remote replay that is also present in directory discovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-dedup-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    fs.writeFileSync(filePath, "x".repeat(1023) + "\n");
    fs.truncateSync(filePath, 5 * 1024 * 1024);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: () => {} });
    const originalReadSync = fs.readSync;
    let reads = 0;
    fs.readSync = (...args) => { reads += 1; return originalReadSync(...args); };
    try {
      __test.poll({ getSessionDirs: () => [dir], postState: () => {} });
    } finally {
      fs.readSync = originalReadSync;
    }
    assert.strictEqual(reads, 1);
  });

  it("bounds remote replay admission and weights due deferred lanes 3:1", () => {
    const recentStat = { mtimeMs: Date.now() };
    for (let i = 0; i < __test.MAX_REPLAY_WORK_ITEMS; i++) {
      assert.strictEqual(
        __test.admitRemoteReplay(`recent-${i}`, uniqueRolloutName(i), {}, recentStat),
        true
      );
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-admission-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    fs.writeFileSync(filePath, "");
    fs.truncateSync(filePath, 5 * 1024 * 1024);
    const originalReadSync = fs.readSync;
    let reads = 0;
    fs.readSync = () => { reads += 1; return 0; };
    try {
      assert.strictEqual(__test.pollFile(filePath, ROLLOUT_NAME, { postState: () => {} }).kind, "deferred");
    } finally {
      fs.readSync = originalReadSync;
    }
    assert.strictEqual(reads, 0);
    assert.strictEqual(__test.tracked.has(filePath), false);
    assert.strictEqual(__test.deferredRecent.has(filePath), true);

    __test.resetMonitorStateForTests();
    const backgroundStat = { mtimeMs: Date.now() - 10 * 60 * 1000 };
    for (let i = 0; i < __test.MAX_BACKGROUND_REPLAY_WORK_ITEMS; i++) {
      assert.strictEqual(
        __test.admitRemoteReplay(`background-${i}`, uniqueRolloutName(i), {}, backgroundStat),
        true
      );
    }
    assert.strictEqual(
      __test.admitRemoteReplay("background-overflow", uniqueRolloutName(99), {}, backgroundStat),
      false
    );

    __test.resetMonitorStateForTests();
    for (let i = 0; i < 4; i++) {
      __test.enqueueRemoteDeferred(`r${i}`, uniqueRolloutName(i), recentStat, "recent");
    }
    for (let i = 0; i < 2; i++) {
      __test.enqueueRemoteDeferred(`b${i}`, uniqueRolloutName(i + 10), backgroundStat, "background");
    }
    assert.deepStrictEqual(
      __test.collectRemoteDeferredCandidates().map((entry) => entry.filePath),
      ["r0", "r1", "r2", "b0", "r3", "b1"]
    );
  });

  it("backs off a remote deferred path whose latest stat fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-missing-"));
    tmpDirs.push(dir);
    const missingFile = path.join(dir, ROLLOUT_NAME);
    __test.enqueueRemoteDeferred(missingFile, ROLLOUT_NAME, { mtimeMs: Date.now() }, "recent");
    const originalStatSync = fs.statSync;
    let missingStats = 0;
    fs.statSync = (filePath, ...args) => {
      if (filePath === missingFile) missingStats += 1;
      return originalStatSync(filePath, ...args);
    };
    try {
      __test.poll({ getSessionDirs: () => [dir], postState: () => {} });
      const deferred = __test.deferredRecent.get(missingFile);
      assert.strictEqual(deferred.retryLevel, 1);
      assert.ok(deferred.notBefore > Date.now());
      __test.poll({ getSessionDirs: () => [dir], postState: () => {} });
      assert.strictEqual(missingStats, 1);
    } finally {
      fs.statSync = originalStatSync;
    }
  });

  it("fails closed when an out-of-window replay reaches EOF with a staged question", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-out-window-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_out_of_window",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick", options: [] }] }),
      },
    };
    const prefix = [JSON.stringify(META), JSON.stringify(request)].join("\n") + "\n";
    const fillerLine = "x".repeat(1023) + "\n";
    fs.writeFileSync(filePath, prefix + fillerLine.repeat(4200));
    const s = spy();

    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState, inWindow: false });
    assert.strictEqual(__test.tracked.get(filePath).initializing, true);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState, inWindow: false });
    const entry = __test.tracked.get(filePath);
    assert.strictEqual(entry.initializing, false);
    assert.strictEqual(entry.pendingUserInputs.size, 0);
    assert.strictEqual(
      s.posted.some((post) => post.event === "CodexUserInputRequest"),
      false,
      "only the staged question is fail-closed; ordinary lifecycle remains live"
    );
    __test.pruneTrackedOutOfWindow({ getSessionDirs: () => [] });
    assert.strictEqual(__test.tracked.has(filePath), false);
  });

  it("keeps an LF-inclusive remote 4 MiB record and discards one byte over", () => {
    const cap = __test.MAX_POLL_READ_BYTES;
    const prefix = '{"type":"session_meta","payload":{"cwd":"/boundary","blob":"';
    const suffix = '"}}\n';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-boundary-"));
    tmpDirs.push(dir);
    const exactFile = path.join(dir, ROLLOUT_NAME);
    const exactRecord = prefix + "a".repeat(cap - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
    fs.writeFileSync(exactFile, exactRecord);
    assert.strictEqual(__test.pollFile(exactFile, ROLLOUT_NAME, { postState: () => {} }).kind, "progress");
    assert.strictEqual(__test.tracked.get(exactFile).offset, cap);

    __test.resetMonitorStateForTests();
    const oversizedName = uniqueRolloutName(999);
    const oversizedFile = path.join(dir, oversizedName);
    const oversizedRecord = prefix + "a".repeat(cap + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
    fs.writeFileSync(oversizedFile, oversizedRecord);
    assert.strictEqual(__test.pollFile(oversizedFile, oversizedName, { postState: () => {} }).kind, "discarded");
    assert.strictEqual(__test.tracked.get(oversizedFile).offset, cap);
    __test.pollFile(oversizedFile, oversizedName, { postState: () => {} });
    assert.strictEqual(__test.tracked.get(oversizedFile).offset, cap + 1);
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

  it("revalidates a cached remote recovery candidate before replacing a live tracker", () => {
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_recovery_race",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    const filePath = track([META, request]);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(filePath, old, old);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const liveTracker = __test.tracked.get(filePath);
    assert.strictEqual(s.posted.filter((post) => post.event === "CodexUserInputRequest").length, 1);
    const stat = fs.statSync(filePath);
    __test.startupRecoveryCandidates.set(filePath, {
      filePath,
      file: ROLLOUT_NAME,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });

    __test.runReadyRemoteRecovery({ remainingAttempts: 64, options: { postState: s.postState } });

    assert.strictEqual(s.posted.filter((post) => post.event === "CodexUserInputRequest").length, 1);
    assert.strictEqual(__test.tracked.get(filePath), liveTracker);
    assert.strictEqual(__test.startupRecoveryCandidates.has(filePath), false);
  });

  it("keeps a remote frozen-mtime candidate when it grows after the pinned stat", () => {
    const { dir, filePath } = tempRollout([META]);
    tmpDirs.push(dir);
    const frozen = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(filePath, frozen, frozen);
    const admissionStat = fs.statSync(filePath);
    __test.startupRecoveryCandidates.set(filePath, {
      filePath,
      file: ROLLOUT_NAME,
      mtimeMs: admissionStat.mtimeMs,
      size: admissionStat.size,
    });
    const s = spy();
    const originalReadSync = fs.readSync;
    let appended = false;
    fs.readSync = (...args) => {
      const bytesRead = originalReadSync(...args);
      if (!appended) {
        appended = true;
        appendLines(filePath, [{
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: "call_remote_frozen_growth",
            arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
          },
        }]);
        fs.utimesSync(filePath, frozen, frozen);
      }
      return bytesRead;
    };
    try {
      __test.runReadyRemoteRecovery({ remainingAttempts: 64, options: { postState: s.postState } });
    } finally {
      fs.readSync = originalReadSync;
    }

    assert.deepStrictEqual(s.posted, []);
    assert.strictEqual(__test.tracked.has(filePath), false);
    assert.strictEqual(__test.startupRecoveryCandidates.has(filePath), true);

    __test.runReadyRemoteRecovery({ remainingAttempts: 64, options: { postState: s.postState } });
    assert.strictEqual(s.posted.filter((post) => post.event === "CodexUserInputRequest").length, 1);
    assert.strictEqual(__test.tracked.has(filePath), true);
    assert.strictEqual(__test.startupRecoveryCandidates.has(filePath), false);
  });

  it("does not let remote empty recovery candidates crowd out a tiny valid request", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-tiny-crowdout-"));
    tmpDirs.push(dir);
    const oldBase = Date.now() - 10 * 60 * 1000;
    for (let i = 0; i < 15; i++) {
      const file = uniqueRolloutName(i + 900);
      const filePath = path.join(dir, file);
      fs.writeFileSync(filePath, "");
      const stamp = new Date(oldBase - i);
      fs.utimesSync(filePath, stamp, stamp);
      const stat = fs.statSync(filePath);
      __test.startupRecoveryCandidates.set(filePath, {
        filePath,
        file,
        mtimeMs: stat.mtimeMs,
        size: 0,
      });
    }
    const validFile = uniqueRolloutName(999);
    const validPath = path.join(dir, validFile);
    const request = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_remote_tiny_valid",
        arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
      },
    };
    fs.writeFileSync(validPath, [JSON.stringify(META), JSON.stringify(request)].join("\n") + "\n");
    const validStamp = new Date(oldBase - 60_000);
    fs.utimesSync(validPath, validStamp, validStamp);
    const validStat = fs.statSync(validPath);
    __test.startupRecoveryCandidates.set(validPath, {
      filePath: validPath,
      file: validFile,
      mtimeMs: validStat.mtimeMs,
      size: validStat.size,
    });
    const s = spy();

    __test.runReadyRemoteRecovery({ remainingAttempts: 64, options: { postState: s.postState } });

    assert.strictEqual(s.posted.filter((post) => post.event === "CodexUserInputRequest").length, 1);
    assert.strictEqual(__test.tracked.has(validPath), true);
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

  it("leaves a trailing incomplete recovery line on disk for the normal poll", () => {
    // Recovery must not silently swallow a line that's still being appended.
    // The committed offset remains at the prior LF, so the normal poll rereads
    // the whole record after the writer completes it.
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
    const incompleteTail = '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_remote_partial_ta';
    fs.appendFileSync(filePath, incompleteTail);
    const originalSize = fs.statSync(filePath).size;

    const s = spy();
    const entry = __test.recoverStalePendingUserInputEntry(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.ok(entry, "the request itself is still genuinely pending");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, "partial"), false);
    assert.strictEqual(
      entry.offset,
      originalSize - Buffer.byteLength(incompleteTail),
      "offset must stop after the last complete newline so the tail stays on disk"
    );

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

  it("remote recovery head and tail readers use raw short-read cursors with an 8-attempt cap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-short-recovery-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    const firstLine = JSON.stringify({
      type: "session_meta",
      payload: { cwd: "/repo/短读", pad: "中".repeat(6000) },
    });
    fs.writeFileSync(filePath, firstLine + "\n" + "tail-data");
    const expectedBytes = fs.readFileSync(filePath);
    const originalReadSync = fs.readSync;
    let calls = 0;
    fs.readSync = (fd, buffer, offset, length, position) => {
      calls += 1;
      return originalReadSync(fd, buffer, offset, Math.min(length, 4097), position);
    };
    try {
      assert.strictEqual(
        __test.readCompleteFirstLine(filePath, fs.statSync(filePath).size, 256 * 1024),
        firstLine
      );
      const exact = __test.readExactRange(filePath, 0, fs.statSync(filePath).size);
      assert.strictEqual(exact.complete, true);
      assert.deepStrictEqual(exact.buf, expectedBytes);
      assert.ok(calls <= 16);

      calls = 0;
      fs.readSync = (fd, buffer, offset, length, position) => {
        calls += 1;
        return originalReadSync(fd, buffer, offset, Math.min(length, 1), position);
      };
      assert.strictEqual(
        __test.readCompleteFirstLine(filePath, fs.statSync(filePath).size, 256 * 1024),
        null
      );
      assert.strictEqual(calls, 8);
      calls = 0;
      assert.strictEqual(__test.readExactRange(filePath, 0, 100).complete, false);
      assert.strictEqual(calls, 8);
    } finally {
      fs.readSync = originalReadSync;
    }
  });

  it("remote recovery head advances from the true short-read cursor", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-head-cursor-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    const firstLine = JSON.stringify({
      type: "session_meta",
      payload: { cwd: "/repo/短读游标", pad: "中".repeat(14000) },
    });
    fs.writeFileSync(filePath, firstLine + "\n" + "tail".repeat(4096));

    const originalReadSync = fs.readSync;
    const requested = [];
    let calls = 0;
    fs.readSync = (fd, buffer, offset, length, position) => {
      calls += 1;
      requested.push({ length, position });
      return originalReadSync(
        fd,
        buffer,
        offset,
        calls === 1 ? Math.min(length, 4097) : length,
        position
      );
    };
    try {
      assert.strictEqual(
        __test.readCompleteFirstLine(filePath, fs.statSync(filePath).size, 256 * 1024),
        firstLine
      );
    } finally {
      fs.readSync = originalReadSync;
    }
    assert.ok(requested[0].length > 4097, "the first remote read must actually be short");
    assert.strictEqual(requested[1].position, 4097, "the next remote read must resume at bytesRead");
    assert.ok(calls <= 8);
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
    const perCandidateSize = Math.floor(1.1 * 1024 * 1024);
    const perCandidateCost = 256 * 1024 + 1024 * 1024 + 1;
    const candidateCount = Math.ceil(MAX_TOTAL_BYTES / perCandidateCost) + 3;
    const candidates = [];
    for (let i = 0; i < candidateCount; i++) {
      const uniqueName = `rollout-2026-03-25T15-10-51-${String(i).padStart(8, "0")}-f1a9-7633-b9c7-758327137228.jsonl`;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-ledger-"));
      tmpDirs.push(dir);
      const filePath = path.join(dir, uniqueName);
      const head = JSON.stringify({ type: "session_meta", payload: { cwd: `/repo/n${i}` } }) + "\n";
      const request = JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: `call_remote_ledger_${i}`,
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }) + "\n";
      const fillerBytes = perCandidateSize - Buffer.byteLength(head) - Buffer.byteLength(request);
      fs.writeFileSync(filePath, head + "x".repeat(fillerBytes - 1) + "\n" + request);
      const stat = fs.statSync(filePath);
      candidates.push({ filePath, file: uniqueName, mtimeMs: Date.now() - i, size: stat.size });
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

  it("charges overlapping remote recovery reads to the real 20 MiB I/O budget", () => {
    const fileSize = 2 * 1024 * 1024;
    const headPrefix = '{"type":"session_meta","payload":{"cwd":"';
    const headSuffix = '"}}\n';
    const head = headPrefix
      + "h".repeat(256 * 1024 - Buffer.byteLength(headPrefix) - Buffer.byteLength(headSuffix))
      + headSuffix;
    const candidates = [];
    for (let i = 0; i < 17; i++) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-physical-budget-"));
      tmpDirs.push(dir);
      const file = uniqueRolloutName(i + 500);
      const filePath = path.join(dir, file);
      const request = JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: `call_remote_physical_budget_${i}`,
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }] }),
        },
      }) + "\n";
      const fillerBytes = fileSize - Buffer.byteLength(head) - Buffer.byteLength(request);
      fs.writeFileSync(filePath, head + "x".repeat(fillerBytes - 1) + "\n" + request);
      const stat = fs.statSync(filePath);
      candidates.push({ filePath, file, mtimeMs: stat.mtimeMs - i, size: stat.size });
    }
    const originalReadSync = fs.readSync;
    let requestedBytes = 0;
    fs.readSync = (fd, buffer, offset, length, position) => {
      requestedBytes += length;
      return originalReadSync(fd, buffer, offset, length, position);
    };
    try {
      __test.runRecoverySweep(candidates, { postState: () => {} });
    } finally {
      fs.readSync = originalReadSync;
    }
    assert.strictEqual(__test.tracked.size, 15);
    assert.ok(requestedBytes <= 20 * 1024 * 1024, `requested ${requestedBytes} bytes`);

    __test.resetMonitorStateForTests();
    requestedBytes = 0;
    const tailStart = fileSize - 1024 * 1024;
    fs.readSync = (fd, buffer, offset, length, position) => {
      requestedBytes += length;
      const boundedLength = position >= tailStart ? Math.min(length, 1) : length;
      return originalReadSync(fd, buffer, offset, boundedLength, position);
    };
    try {
      __test.runRecoverySweep(candidates, { postState: () => {} });
    } finally {
      fs.readSync = originalReadSync;
    }
    assert.ok(
      requestedBytes <= 20 * 1024 * 1024,
      `short-read retries requested ${requestedBytes} bytes`
    );
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

  it("does not post sleeping while a bounded remote replay is still initializing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-initializing-stale-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, ROLLOUT_NAME);
    fs.writeFileSync(filePath, JSON.stringify(META) + "\n");
    fs.truncateSync(filePath, 5 * 1024 * 1024);
    const s = spy();

    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const entry = __test.tracked.get(filePath);
    assert.ok(entry);
    assert.strictEqual(entry.initializing, true);
    entry.lastEventTime = Date.now() - __test.STALE_MS - 1000;
    const future = Date.now();

    __test.cleanStaleFiles({ postState: s.postState, now: () => future });
    assert.deepStrictEqual(s.posted.filter((post) => post.event === "stale-cleanup"), []);
    assert.strictEqual(entry.stale, false);

    entry.initializing = false;
    __test.cleanStaleFiles({ postState: s.postState, now: () => future });
    assert.strictEqual(
      s.posted.filter((post) => post.event === "stale-cleanup").length,
      1,
      "the same entry becomes eligible only after initialization finishes"
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
