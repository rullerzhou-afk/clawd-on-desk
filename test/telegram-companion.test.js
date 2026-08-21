"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTelegramCompanion,
  formatNotification,
  formatTelegramNotificationMessage,
} = require("../src/telegram-companion");

function tick() {
  // Flush the fire-and-forget microtask chain in onSnapshot.
  return new Promise((resolve) => setImmediate(resolve));
}

function sentText(value) {
  return value && typeof value === "object" && typeof value.plainText === "string"
    ? value.plainText
    : String(value || "");
}

function doneEntry(overrides = {}) {
  return {
    id: "sess-aaaaaa1",
    agentId: "claude",
    displayTitle: "fix the bug",
    cwd: "/home/me/proj",
    host: null,
    badge: "done",
    lastEvent: { rawEvent: "Stop", at: 1000 },
    assistantLastOutput: null,
    assistantLastOutputTruncated: false,
    ...overrides,
  };
}

function makeClient() {
  const sent = [];
  return {
    sent,
    client: {
      sendNotification: async (text) => { sent.push(text); return { ok: true }; },
    },
  };
}

function makeCompanion({ enabled = true, client, getLang, getCompletionOutputMode, getNotifyOnComplete, formatText } = {}) {
  const sink = client || makeClient();
  const comp = createTelegramCompanion({
    getClient: () => sink.client,
    isEnabled: () => enabled,
    getLang,
    getCompletionOutputMode,
    getNotifyOnComplete,
    formatText,
  });
  return { comp, sent: sink.sent };
}

test("first snapshot primes dedupe without notifying", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sent, [], "backlog of already-finished sessions must not re-ping on start");
});

test("factory defaults to no completion output", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sent, [], "default factory should not send a bare ping");

  comp.onSnapshot({
    sessions: [doneEntry({
      lastEvent: { rawEvent: "Stop", at: 2000 },
      assistantLastOutput: "Implemented the fix.",
    })],
  });
  await tick();
  assert.deepEqual(sent, [], "default factory should not send assistant output");
});

test("factory sends assistant output only when full output is explicit", async () => {
  const { comp, sent } = makeCompanion({ getCompletionOutputMode: () => "full" });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [doneEntry({
      assistantLastOutput: "Implemented the fix.",
    })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sentText(sent[0]), /Assistant output:/);
  assert.match(sentText(sent[0]), /Implemented the fix/);
  assert.match(sent[0].html, /<b>Assistant output:<\/b>/);
});

test("notifies a fresh completion after priming", async () => {
  const { comp, sent } = makeCompanion({ getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] }); // prime empty
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sentText(sent[0]), /fix the bug/);
  assert.match(sentText(sent[0]), /done/);
});

test("registers completion notification message ids after successful sends", async () => {
  const registrations = [];
  const sink = {
    sent: [],
    client: {
      sendNotification: async (text) => {
        sink.sent.push(text);
        return { ok: true, messageId: 4242 };
      },
    },
  };
  const comp = createTelegramCompanion({
    getClient: () => sink.client,
    isEnabled: () => true,
    getNotifyOnComplete: () => true,
    onNotificationSent: (payload) => registrations.push({
      messageId: payload.messageId,
      sessionId: payload.entry && payload.entry.id,
    }),
  });

  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry({ id: "sess-for-map" })] });
  await tick();

  assert.equal(sink.sent.length, 1);
  assert.deepEqual(registrations, [{ messageId: 4242, sessionId: "sess-for-map" }]);
});

test("does not register direct-send mapping when notification delivery fails", async () => {
  const registrations = [];
  const comp = createTelegramCompanion({
    getClient: () => ({
      sendNotification: async () => ({ ok: false, errorClass: "403" }),
    }),
    isEnabled: () => true,
    getNotifyOnComplete: () => true,
    onNotificationSent: (payload) => registrations.push(payload),
  });

  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();

  assert.deepEqual(registrations, []);
});

test("dedupes repeated broadcasts of the same completion", async () => {
  const { comp, sent } = makeCompanion({ getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  // Same id + rawEvent + at — re-broadcast from ack / stale-cleanup.
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.equal(sent.length, 1, "must not re-notify the same completion");
});

test("a later completion on the same session (new at) notifies again", async () => {
  const { comp, sent } = makeCompanion({ getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  comp.onSnapshot({ sessions: [doneEntry({ lastEvent: { rawEvent: "Stop", at: 2000 } })] });
  await tick();
  assert.equal(sent.length, 2);
});

test("disabled: advances dedupe but sends nothing, and never backfills", async () => {
  const sink = makeClient();
  let enabled = false;
  const comp = createTelegramCompanion({
    getClient: () => sink.client,
    isEnabled: () => enabled,
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sink.sent, [], "no sends while disabled");
  // Flip on — the already-seen completion must not retroactively fire.
  enabled = true;
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sink.sent, [], "flipping the toggle on must not backfill old completions");
});

test("notifies each completing session with identity fields", async () => {
  const { comp, sent } = makeCompanion({ getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [
      doneEntry({ id: "sess-aaaaaa1", displayTitle: "task A", cwd: "/a/projA" }),
      doneEntry({ id: "sess-bbbbbb2", displayTitle: "task B", cwd: "C:\\work\\projB", host: "laptop" }),
    ],
  });
  await tick();
  assert.equal(sent.length, 2);
  const joined = sent.map(sentText).join("\n---\n");
  assert.match(joined, /task A/);
  assert.match(joined, /projA/);
  assert.match(joined, /task B/);
  assert.match(joined, /projB/); // Windows cwd basename
  assert.match(joined, /laptop/); // host
});

test("completion respects an explicitly hidden snapshot displayFolder", async () => {
  const opaque = "mqgw60jiigjsjcid";
  const { comp, sent } = makeCompanion({ getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry({
    id: "qwenwork:hidden",
    agentId: "qwenwork",
    cwd: `/Users/me/.QwenWorkCN/workspace/${opaque}`,
    displayFolder: "",
  })] });
  await tick();
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(sent[0]).includes(opaque));
});

test("ignores non-completion badges and events", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [
      doneEntry({ id: "r1", badge: "running", lastEvent: { rawEvent: "PreToolUse", at: 1 } }),
      doneEntry({ id: "i1", badge: "idle", lastEvent: { rawEvent: "Notification", at: 1 } }),
      // done badge but a non-completion rawEvent should not fire.
      doneEntry({ id: "d1", badge: "done", lastEvent: { rawEvent: "PostCompact", at: 1 } }),
    ],
  });
  await tick();
  assert.deepEqual(sent, []);
});

test("interrupted badge uses the warning marker", async () => {
  const { comp, sent } = makeCompanion({ getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [doneEntry({ badge: "interrupted", lastEvent: { rawEvent: "ApiError", at: 5 } })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sentText(sent[0]), /interrupted/);
});

test("completion notification follows the current Clawd language", async () => {
  let lang = "zh";
  const { comp, sent } = makeCompanion({ getLang: () => lang, getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sentText(sent[0]), /已完成/);
  assert.doesNotMatch(sentText(sent[0]), /\(done\)/);

  lang = "ja";
  comp.onSnapshot({ sessions: [doneEntry({ lastEvent: { rawEvent: "Stop", at: 2000 } })] });
  await tick();
  assert.equal(sent.length, 2);
  assert.match(sentText(sent[1]), /完了/);
});

test("output mode off keeps the R1a bare notification", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "off",
    getNotifyOnComplete: () => true,
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry({ assistantLastOutput: "assistant text" })] });
  await tick();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sentText(sent[0]), /assistant text/);
  assert.doesNotMatch(sentText(sent[0]), /Assistant output/);
});

test("full output mode appends redacted assistant text", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "full",
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [doneEntry({
      assistantLastOutput: `${"line ".repeat(600)}\nsecret=sk-1234567890abcdef\nTAIL`,
    })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sentText(sent[0]), /Assistant output \(truncated\):/);
  assert.match(sentText(sent[0]), /TAIL/);
  assert.match(sentText(sent[0]), /secret=<redacted>/);
  assert.doesNotMatch(sentText(sent[0]), /sk-1234567890abcdef/);
  assert.doesNotMatch(sentText(sent[0]), /Last output/);
});

test("full output mode with bare ping disabled skips completions with no assistant text", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "full",
    getNotifyOnComplete: () => false,
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sent, [], "no assistant text means no default bare completion ping");

  comp.onSnapshot({
    sessions: [doneEntry({
      lastEvent: { rawEvent: "Stop", at: 2000 },
      assistantLastOutput: "Implemented the fix.",
    })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sentText(sent[0]), /Assistant output:/);
  assert.match(sentText(sent[0]), /Implemented the fix/);
});

test("output mode off with bare ping disabled sends no completion message", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "off",
    getNotifyOnComplete: () => false,
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry({ assistantLastOutput: "assistant text" })] });
  await tick();
  assert.deepEqual(sent, []);
});

test("legacy tail output mode is treated as full output", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "tail",
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [doneEntry({ assistantLastOutput: "Implemented the fix." })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sentText(sent[0]), /Assistant output:/);
  assert.match(sentText(sent[0]), /Implemented the fix/);
  assert.doesNotMatch(sentText(sent[0]), /Last output/);
});

test("full output mode appends assistant text and marks extractor truncation", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "full",
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [doneEntry({
      assistantLastOutput: "Implemented X.\nTests pass.",
      assistantLastOutputTruncated: true,
    })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sentText(sent[0]), /Assistant output \(truncated\):/);
  assert.match(sentText(sent[0]), /Implemented X/);
  assert.match(sentText(sent[0]), /Tests pass/);
});

test("full output mode with bare ping enabled degrades to R1a when no assistant text is available", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "full",
    getNotifyOnComplete: () => true,
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sentText(sent[0]), /Assistant output/);
});

test("forgets sessions that drop out of the snapshot", async () => {
  const { comp } = makeCompanion();
  comp.onSnapshot({ sessions: [doneEntry()] }); // prime + record key
  comp.onSnapshot({ sessions: [] }); // session gone -> key dropped
  assert.equal(comp._lastNotified.size, 0);
});

test("formatNotification falls back to the session label and uses the display tag when title missing", () => {
  const text = formatNotification({
    id: "s1.bG9jYWw.c2Vzcy16enp6eno5",
    displaySessionTag: "deadbeef00",
    badge: "done",
    lastEvent: { rawEvent: "Stop", at: 1 },
  });
  assert.match(text, /session/);
  assert.match(text, /#deadbeef00/);
  assert.doesNotMatch(text, /s1\.bG9jYWw/);
  assert.doesNotMatch(text, /sess-z/);
});

test("formatted completion falls back to the session label and display tag when title missing", () => {
  const message = formatTelegramNotificationMessage({
    id: "s1.bG9jYWw.c2Vzcy16enp6eno5",
    displaySessionTag: "deadbeef00",
    badge: "done",
    lastEvent: { rawEvent: "Stop", at: 1 },
  });
  assert.match(message.plainText, /session/);
  assert.match(message.plainText, /#deadbeef00/);
  assert.doesNotMatch(message.plainText, /s1\.bG9jYWw/);
  assert.doesNotMatch(message.plainText, /sess-z/);
});

test("formatted completion parses only Assistant output and escapes metadata", () => {
  const message = formatTelegramNotificationMessage(doneEntry({
    displayTitle: "<b>title</b> @username",
    agentId: "agent<script>",
    cwd: "/tmp/folder<a>",
    assistantLastOutput: "**safe bold** <redacted:token>",
  }), {
    completionOutputMode: "full",
    includeBare: true,
    lang: "en",
  });

  assert.match(message.html, /<b>&lt;b&gt;title&lt;\/b&gt; ＠username<\/b>/);
  assert.match(message.html, /agent&lt;script&gt;/);
  assert.match(message.html, /folder&lt;a&gt;/);
  assert.match(message.html, /<b>safe bold<\/b> &lt;redacted:token&gt;/);
  assert.equal((message.html.match(/<a\b/g) || []).length, 0);
  assert.ok(message.htmlVisibleLength <= 3600);
  assert.ok(message.plainVisibleLength <= 3600);
});

test("formatted completion preserves the Assistant output budget and truncation state when composed", () => {
  const horizontalRules = "---\n\n".repeat(180);
  const source = horizontalRules + "word ".repeat(400).slice(0, 2599 - horizontalRules.length);
  assert.equal(source.length, 2599, "fixture must stay below the pre-Markdown 2600 limit");

  const message = formatTelegramNotificationMessage(doneEntry({
    assistantLastOutput: source,
  }), {
    completionOutputMode: "full",
    includeBare: true,
    lang: "en",
  });

  const label = "Assistant output (truncated):\n";
  const outputStart = message.plainText.indexOf(label);
  assert.notEqual(outputStart, -1);
  const renderedOutput = message.plainText.slice(outputStart + label.length);
  assert.ok(renderedOutput.length <= 2600, "composed output must retain its inner budget");
  assert.match(renderedOutput, /\n\.\.\. truncated$/);
  assert.equal(message.truncated, true);
  assert.ok(message.budgetLength <= 3600);
});

test("custom completion formatter keeps the legacy plain string contract", async () => {
  const { comp, sent } = makeCompanion({
    getNotifyOnComplete: () => true,
    formatText: () => "<b>legacy wire</b>",
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();

  assert.deepEqual(sent, ["<b>legacy wire</b>"]);
});

test("completion notifications use the snapshot display tag, not raw or canonical prefixes", () => {
  const { resolveSessionIdentity } = require("../src/session-key");
  const { buildSessionSnapshotEntry } = require("../src/state-session-snapshot");

  function entryFor(rawSessionId) {
    const identity = resolveSessionIdentity(rawSessionId);
    return buildSessionSnapshotEntry(identity.sessionId, {
      rawSessionId: identity.rawSessionId,
      agentId: "claude-code",
      state: "idle",
      cwd: null,
      sessionTitle: "Known task",
      recentEvents: [{ event: "Stop", state: "idle", at: Date.now() }],
    });
  }

  const a = entryFor("11111111-2222-3333-4444-555555555555");
  const b = entryFor("99999999-8888-7777-6666-aaaaaaaaaaaa");

  assert.ok(a.id.startsWith("s1."), "fixture must use a real namespaced key");
  const textA = sentText(formatNotification(a));
  const richA = formatTelegramNotificationMessage(a);
  const tagA = textA.match(/#([0-9a-f]{10})/);
  const tagB = sentText(formatNotification(b)).match(/#([0-9a-f]{10})/);
  assert.ok(tagA && tagB, "both notifications carry a session tag");
  assert.equal(tagA[1], a.displaySessionTag);
  assert.equal(tagA[1], "a0a040910c");
  assert.notEqual(tagA[1], tagB[1], "two sessions must not render the same tag");
  assert.ok(!tagA[1].startsWith("s1."), `tag must not be the key envelope: ${tagA[1]}`);
  assert.ok(!a.rawSessionId.startsWith(tagA[1]), "tag must not be a raw id prefix");
  assert.doesNotMatch(textA, /111111|s1\.bG9jYWw/);
  assert.doesNotMatch(richA.plainText, /111111|s1\.bG9jYWw/);
});

test("completion notification tags still distinguish sessions without rawSessionId", () => {
  const { resolveSessionIdentity } = require("../src/session-key");
  const { buildSessionSnapshotEntry } = require("../src/state-session-snapshot");

  function tagFor(rawSessionId) {
    const identity = resolveSessionIdentity(rawSessionId, "local");
    const entry = buildSessionSnapshotEntry(identity.sessionId, {
      agentId: "codex",
      state: "idle",
      cwd: null,
      recentEvents: [{ event: "Stop", state: "idle", at: Date.now() }],
    }); // deliberately no rawSessionId
    assert.equal(entry.rawSessionId, identity.sessionId, "fixture must exercise the fallback");
    return sentText(formatNotification(entry)).match(/#([0-9a-f]{10})/)[1];
  }

  const a = tagFor("11111111-2222-3333-4444-555555555555");
  const b = tagFor("99999999-8888-7777-6666-aaaaaaaaaaaa");
  assert.notEqual(a, b, "two sessions must not render the same tag");
  assert.ok(!a.startsWith("s1."), `tag must not be the key envelope: ${a}`);
  assert.equal(a, "a0a040910c");
});

test("completion formatter prefers an explicit snapshot display tag", () => {
  const entry = doneEntry({
    id: "s1.bG9jYWw.MTExMTExMTEtMjIyMi0zMzMzLTQ0NDQtNTU1NTU1NTU1NTU1",
    rawSessionId: "11111111-2222-3333-4444-555555555555",
    displaySessionTag: "deadbeef00",
  });

  const text = sentText(formatNotification(entry));
  const rich = formatTelegramNotificationMessage(entry);
  assert.match(text, /#deadbeef00/);
  assert.match(rich.plainText, /#deadbeef00/);
  assert.doesNotMatch(text, /#a0a040910c|111111|s1\.bG9jYWw/);
  assert.doesNotMatch(rich.plainText, /#a0a040910c|111111|s1\.bG9jYWw/);
});
