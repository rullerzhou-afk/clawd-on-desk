"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  messageToState, createLineSplitter, parseArgs, validateOptions,
} = require("../scripts/ntfy-bridge");

const AGENT = "custom-nova-ai-0123456789ab";
const msg = (tags, extra = {}) => ({ id: "x1", event: "message", topic: "t1", tags, ...extra });

describe("ntfy bridge", () => {
  it("maps a state tag to a /state body with a default event", () => {
    assert.deepStrictEqual(messageToState(msg(["clawd-working"]), AGENT), {
      agent_id: AGENT, session_id: "t1", state: "working", event: "PreToolUse",
    });
  });

  it("honours session and event tags", () => {
    const body = messageToState(msg(["clawd-attention", "clawd-session-job_7", "clawd-event-Stop"]), AGENT);
    assert.strictEqual(body.session_id, "job_7");
    assert.strictEqual(body.event, "Stop");
  });

  it("ignores unrelated, unknown-state, and non-message events", () => {
    assert.strictEqual(messageToState(msg(["deploy"]), AGENT), null);
    assert.strictEqual(messageToState(msg(["clawd-dancing"]), AGENT), null);
    assert.strictEqual(messageToState({ event: "keepalive", tags: ["clawd-idle"] }, AGENT), null);
    assert.strictEqual(messageToState(msg(undefined), AGENT), null);
  });

  it("drops unsafe session/event tag values instead of forwarding them", () => {
    const body = messageToState(msg(["clawd-idle", "clawd-session-a/b", "clawd-event-x y"]), AGENT);
    assert.strictEqual(body.session_id, "t1");
    assert.strictEqual(body.event, "SessionStart");
  });

  it("splits streamed chunks on newlines and buffers partial lines", () => {
    const lines = [];
    const feed = createLineSplitter((l) => lines.push(l));
    feed('{"a":1}\n{"b"');
    feed(':2}\n\n');
    assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}']);
  });

  it("validates options and reads env defaults", () => {
    const opts = parseArgs(["--topic", "abc"], { CLAWD_AGENT_ID: AGENT, NTFY_TOKEN: "tk" });
    assert.strictEqual(validateOptions(opts), null);
    assert.strictEqual(opts.token, "tk");
    assert.match(validateOptions(parseArgs([], {})), /topic/);
    assert.match(validateOptions({ topic: "a", agentId: AGENT, server: "ftp://x" }), /http/);
  });
});
