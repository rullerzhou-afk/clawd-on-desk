"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  MAX_CANONICAL_EVENT_BYTES,
  createCanonicalRecapEvent,
} = require("../src/recap-event");
const {
  createMemoryRecapSink,
  recordCanonicalRecapEvent,
} = require("../src/recap-sink");

describe("recap canonical event", () => {
  it("copies only the public allowlist and canonicalizes metrics", () => {
    const event = createCanonicalRecapEvent({
      occurredAt: 1788013260000,
      agentId: "claude-code",
      scope: "local",
      metrics: ["tool-call", "activity", "tool-call"],
      prompt: "secret",
      cwd: "/private/repo",
      toolName: "Bash",
      rawSessionId: "raw-secret",
    });
    assert.deepStrictEqual(event, {
      occurredAt: 1788013260000,
      agentId: "claude-code",
      scope: "local",
      metrics: ["activity", "tool-call"],
    });
    assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") <= MAX_CANONICAL_EVENT_BYTES);
  });

  it("rejects unknown metrics, invalid timestamps and missing activity", () => {
    assert.throws(() => createCanonicalRecapEvent({
      occurredAt: 1,
      agentId: "claude-code",
      scope: "local",
      metrics: ["activity", "token"],
    }));
    assert.throws(() => createCanonicalRecapEvent({
      occurredAt: -1,
      agentId: "claude-code",
      scope: "local",
      metrics: ["activity"],
    }));
    assert.throws(() => createCanonicalRecapEvent({
      occurredAt: 1,
      agentId: "claude-code",
      scope: "local",
      metrics: ["tool-call"],
    }));
  });

  it("keeps raw identities in the ephemeral sink side-channel", () => {
    const sink = createMemoryRecapSink({ captureEphemeralIdentity: true });
    recordCanonicalRecapEvent(sink, {
      occurredAt: 1788013260000,
      agentId: "claude-code",
      scope: "local",
      metrics: ["activity", "session-start"],
    }, {
      scopeId: "local",
      sessionId: "raw-secret",
      dedupeId: "session-start:raw-secret",
    });
    assert.strictEqual(JSON.stringify(sink.snapshot()).includes("raw-secret"), false);
    assert.strictEqual(sink.identitySnapshot()[0].sessionId, "raw-secret");
  });
});
