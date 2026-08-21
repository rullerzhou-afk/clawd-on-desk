"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  ZCODE_PERMISSION_HTTP_TIMEOUT_MS,
  buildPermissionBody,
  buildStateBody,
  buildZcodePermissionOutput,
  normalizeToolMatchValue,
  run,
  sanitizeZcodePermissionDecision,
  sanitizeZcodePermissionOutput,
  stdinParseErrorCategory,
} = require("../hooks/zcode-hook");

describe("ZCode hook PID lifecycle", () => {
  it("passes the raw session context to the resolver and reports cached fields", () => {
    let context = null;
    const body = buildStateBody("PreToolUse", {
      session_id: "sid-1",
      cwd: "D:/repo",
    }, (received) => {
      context = received;
      return {
        stablePid: 101,
        agentPid: 202,
        cacheSource: "v2",
      };
    });

    assert.deepStrictEqual(context, {
      namespace: "zcode",
      sessionId: "sid-1",
      cacheCwd: "D:/repo",
      lifecycle: "event",
      cacheable: true,
    });
    assert.strictEqual(body.session_id, "zcode:sid-1");
    assert.strictEqual(body.source_pid, 101);
    assert.strictEqual(body.agent_pid, 202);
  });

  it("keeps Stop on the event lifecycle so its cache is not dropped", async () => {
    let context = null;
    const result = await run({
      hook_event_name: "Stop",
      session_id: "sid-2",
      cwd: "D:/repo",
    }, null, {
      resolvePid(received) {
        context = received;
        return { stablePid: 101, agentPid: 202, cacheSource: "v2" };
      },
      postState(_body, _options, callback) {
        callback(true, 23333);
      },
    });

    assert.strictEqual(context.lifecycle, "event");
    assert.strictEqual(result.body.state, "attention");
    assert.strictEqual(result.processMeta.cacheSource, "v2");
  });

  it("does not resolve local process metadata for a remote event", () => {
    let calls = 0;
    const body = buildStateBody("SessionStart", {
      session_id: "sid-3",
      cwd: "/repo",
    }, () => {
      calls++;
      return {};
    }, {
      remote: true,
      host: "remote-box",
    });

    assert.strictEqual(calls, 0);
    assert.strictEqual(body.host, "remote-box");
  });

  it("carries a verified Orca pane key for local and secure remote focus", () => {
    const paneKey = "tab-1:leaf-2";
    const local = buildStateBody("SessionStart", { session_id: "local" }, () => ({}), {
      env: { TERM_PROGRAM: "Orca", ORCA_PANE_KEY: paneKey },
    });
    const remote = buildStateBody("SessionStart", { session_id: "remote" }, () => ({}), {
      remote: true,
      host: "remote-box",
      env: {
        CLAWD_REMOTE: "1",
        CLAWD_SSH_REMOTE: "1",
        ORCA_PANE_KEY: paneKey,
      },
    });

    assert.strictEqual(local.orca_pane_key, paneKey);
    assert.strictEqual(remote.orca_pane_key, paneKey);
  });

  it("rejects inherited or malformed Orca pane keys", () => {
    for (const env of [
      { TERM_PROGRAM: "Orca", ORCA_PANE_KEY: "tab-1:leaf-2", TMUX: "/tmp/tmux,1,0" },
      { TERM_PROGRAM: "Orca", ORCA_PANE_KEY: "not-a-pane-key" },
      { ORCA_PANE_KEY: "tab-1:leaf-2" },
      { CLAWD_REMOTE: "1", ORCA_PANE_KEY: "tab-1:leaf-2" },
    ]) {
      const body = buildStateBody("SessionStart", { session_id: "unsafe" }, () => ({}), { env });
      assert.strictEqual(body.orca_pane_key, undefined);
    }
  });

  it("reduces stdin parse failures to a fixed debug category", () => {
    const rawError = "SECRET_TOKEN is not valid JSON";
    assert.strictEqual(stdinParseErrorCategory(rawError), "invalid-json");
    assert.ok(!stdinParseErrorCategory(rawError).includes("SECRET_TOKEN"));
    assert.strictEqual(stdinParseErrorCategory(null), null);
  });
});
describe("ZCode hook PermissionRequest path", () => {
  it("builds a bounded permission body with the zcode session namespace", () => {
    let context = null;
    const body = buildPermissionBody("PermissionRequest", {
      session_id: "s1",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_use_id: "tool-1",
      permission_mode: "default",
      permission_suggestions: [{ type: "addRules" }],
    }, (received) => {
      context = received;
      return { stablePid: 101, agentPid: 202 };
    });

    assert.deepStrictEqual(context, {
      namespace: "zcode",
      sessionId: "s1",
      cacheCwd: "/repo",
      lifecycle: "event",
      cacheable: true,
    });
    assert.strictEqual(body.agent_id, "zcode");
    assert.strictEqual(body.session_id, "zcode:s1");
    assert.strictEqual(body.tool_name, "Bash");
    assert.deepStrictEqual(body.tool_input, { command: "npm test" });
    assert.strictEqual(body.tool_use_id, "tool-1");
    assert.strictEqual(body.permission_mode, "default");
    assert.strictEqual(body.source_pid, 101);
    assert.strictEqual(body.agent_pid, 202);
    // Suggestions are not forwarded to the bubble (qwen parity, later phase).
    assert.deepStrictEqual(body.permission_suggestions, []);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "state"), false);
  });

  it("fails closed to the state path when the tool name is missing or unknown", async () => {
    for (const payload of [
      { session_id: "s1", tool_input: {} },
      { session_id: "s1", tool_name: "   ", tool_input: {} },
      { session_id: "s1", tool_name: "unknown", tool_input: {} },
      { session_id: "s1", tool_name: "Unknown", tool_input: {} },
    ]) {
      assert.strictEqual(buildPermissionBody("PermissionRequest", payload, () => ({})), null);
    }

    let postedState = null;
    const result = await run({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "unknown",
    }, null, {
      resolvePid: () => ({}),
      postState(bodyStr, _options, callback) {
        postedState = JSON.parse(bodyStr);
        callback(true, 23333);
      },
    });

    assert.strictEqual(result.permission, undefined);
    assert.strictEqual(postedState.state, "notification");
    assert.strictEqual(postedState.event, "PermissionRequest");
    assert.strictEqual(result.stdout, "{}");
  });

  it("returns null for non-permission events", () => {
    assert.strictEqual(buildPermissionBody("PreToolUse", {
      session_id: "s1",
      tool_name: "Bash",
    }, () => ({})), null);
  });

  it("emits only the minimal ZCode-legal decision forms", () => {
    assert.strictEqual(buildZcodePermissionOutput({ behavior: "allow" }),
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
    assert.strictEqual(buildZcodePermissionOutput({ behavior: "deny", message: "not allowed" }),
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"not allowed"}}}');
    // allow never carries a message; unknown behaviors are no-decisions.
    assert.strictEqual(buildZcodePermissionOutput({ behavior: "allow", message: "x" }),
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
    assert.strictEqual(buildZcodePermissionOutput({ behavior: "ask" }), "{}");
    assert.strictEqual(buildZcodePermissionOutput(null), "{}");
  });

  it("sanitizes server responses against ZCode's strict union schema", () => {
    // Legal-but-unwanted fields (interrupt / updatedInput / permissionUpdates)
    // must be stripped, not forwarded.
    assert.strictEqual(
      sanitizeZcodePermissionOutput(
        '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"no","interrupt":true}}}'
      ),
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"no"}}}'
    );
    assert.strictEqual(
      sanitizeZcodePermissionOutput(
        '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"command":"evil"}}}}'
      ),
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    );
    // Malformed bodies never leak through.
    for (const raw of ["", "   ", "not json", "{}", "[]",
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","decision":{"behavior":"allow"}}}']) {
      assert.strictEqual(sanitizeZcodePermissionOutput(raw), "{}");
    }
    assert.deepStrictEqual(sanitizeZcodePermissionDecision({ behavior: "allow", updatedPermissions: [] }),
      { behavior: "allow" });
  });

  it("blocks on /permission with the long budget and skips the state post", async () => {
    let permissionCall = null;
    const result = await run({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }, null, {
      resolvePid: () => ({}),
      postState(_body, _options, callback) {
        callback(true, 23333);
        throw new Error("state must not post on the permission path");
      },
      postPermission(body, options, callback) {
        permissionCall = { body: JSON.parse(body), options };
        callback(true, 23333,
          '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
      },
    });

    assert.strictEqual(result.permission, true);
    assert.strictEqual(result.permissionBehavior, "allow");
    assert.strictEqual(result.posted, true);
    assert.strictEqual(result.stdout,
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
    assert.strictEqual(permissionCall.body.agent_id, "zcode");
    assert.strictEqual(permissionCall.options.timeoutMs, ZCODE_PERMISSION_HTTP_TIMEOUT_MS);
    assert.strictEqual(permissionCall.options.probeTimeoutMs, 100);
    assert.strictEqual(ZCODE_PERMISSION_HTTP_TIMEOUT_MS, 590000);
  });

  it("returns the exact no-decision stdout for failed permission posts", async () => {
    for (const responseBody of [null, "", "garbage"]) {
      const result = await run({
        hook_event_name: "PermissionRequest",
        session_id: "s1",
        tool_name: "Bash",
      }, null, {
        resolvePid: () => ({}),
        postPermission(_body, _options, callback) {
          callback(false, null, responseBody);
        },
      });
      assert.strictEqual(result.stdout, "{}");
      assert.strictEqual(result.permissionBehavior, null);
    }
  });

  it("normalizes oversized tool input the same way as the state path", () => {
    const huge = "x".repeat(500);
    const normalized = normalizeToolMatchValue({ command: huge });
    assert.strictEqual(normalized.command.length, 240);
    assert.ok(normalized.command.endsWith("..."));
  });

  it("fails closed when tool_input exceeds any content budget (long Bash with dangerous tail)", () => {
    // A >240-char command whose dangerous tail would be silently truncated by
    // the fingerprint normalizer — the bubble would show a harmless prefix
    // while Allow stays clickable.
    const longCommand = `${"echo padding;".repeat(30)} rm -rf /tmp/important`;
    assert.ok(longCommand.length > 240);
    assert.ok(longCommand.includes("rm -rf"));

    const body = buildPermissionBody("PermissionRequest", {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: longCommand },
    }, () => ({}));
    assert.strictEqual(body, null);
  });

  it("fails closed on every other lossy budget (array/key/depth), not just strings", () => {
    for (const toolInput of [
      { files: new Array(17).fill("a.txt") },
      { map: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 1])) },
      { a: { b: { c: { d: { e: { f: { g: "deep" } } } } } } },
    ]) {
      assert.strictEqual(buildPermissionBody("PermissionRequest", {
        session_id: "s1",
        tool_name: "Write",
        tool_input: toolInput,
      }, () => ({})), null, JSON.stringify(toolInput).slice(0, 40));
    }
  });

  it("sends within-budget tool_input verbatim and falls back to state on truncation", async () => {
    const exactCommand = "npm test -- --reporter dot";
    let permissionBody = null;
    const okResult = await run({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: exactCommand },
    }, null, {
      resolvePid: () => ({}),
      postPermission(bodyStr, _options, callback) {
        permissionBody = JSON.parse(bodyStr);
        callback(true, 23333, "{}");
      },
    });
    assert.deepStrictEqual(permissionBody.tool_input, { command: exactCommand });

    let statePosted = null;
    const truncatedResult = await run({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: `${"y".repeat(300)} rm -rf x` },
    }, null, {
      resolvePid: () => ({}),
      postState(bodyStr, _options, callback) {
        statePosted = JSON.parse(bodyStr);
        callback(true, 23333);
      },
      postPermission() {
        throw new Error("truncated input must not reach /permission");
      },
    });
    assert.strictEqual(truncatedResult.stdout, "{}");
    assert.strictEqual(statePosted.state, "notification");
    assert.strictEqual(statePosted.event, "PermissionRequest");
  });

  it("answers {} locally when the serialized permission body exceeds the server cap", async () => {
    // Every per-node budget passes (strings ≤240, arrays ≤16, keys ≤32,
    // depth ≤6), but 32 keys × 16-element arrays × 32 keys × 240 chars
    // serializes to several MiB — over the server's pre-parse cap.
    const wideInput = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [
      `group${i}`,
      Array.from({ length: 16 }, (__, j) => Object.fromEntries(
        Array.from({ length: 32 }, (___, k) => [`f${j}-${k}`, "x".repeat(240)])
      )),
    ]));
    assert.ok(Buffer.byteLength(JSON.stringify(wideInput)) > 512 * 1024);

    let posted = false;
    const result = await run({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Edit",
      tool_input: wideInput,
    }, null, {
      resolvePid: () => ({}),
      postPermission() {
        posted = true;
        throw new Error("oversized body must not be posted");
      },
    });

    assert.strictEqual(posted, false);
    assert.strictEqual(result.stdout, "{}");
    assert.strictEqual(result.permission, true);
    assert.strictEqual(result.permissionBehavior, null);
    assert.strictEqual(result.posted, false);
  });
});
