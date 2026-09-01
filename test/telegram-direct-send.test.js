"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MAX_MAPPINGS,
  buildWindowsPasteShortcutScript,
  createClipboardFallbackDeliveryAdapter,
  createTelegramDirectSend,
  createWindowsPasteOnlyDeliveryAdapter,
  normalizePromptText,
} = require("../src/telegram-direct-send");
const { buildSessionSnapshot } = require("../src/state-session-snapshot");

function localTerminalEntry(overrides = {}) {
  return {
    id: "sess-local-1",
    agentId: "claude-code",
    state: "idle",
    badge: "done",
    sourcePid: 1234,
    host: null,
    headless: false,
    hiddenFromHud: false,
    platform: null,
    ...overrides,
  };
}

function confirmedFocusResult(overrides = {}) {
  return {
    token: "focus-token-1",
    reason: "parent-direct",
    targetHwnd: "12345",
    foregroundHwnd: "12345",
    confirmed: true,
    status: "confirmed",
    ...overrides,
  };
}

test("direct send maps a completion notification reply to the exact local session and focuses only", async () => {
  const focused = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: (sessionId, options) => {
      focused.push({ sessionId, options });
      return confirmedFocusResult();
    },
    osPlatform: "win32",
  });

  assert.equal(direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" }), true);
  const res = await direct.handleTextMessage({
    text: "continue please",
    replyToMessageId: 42,
    messageId: 99,
    fromId: "777",
    chatId: "123",
  });

  assert.equal(res.status, "focused");
  assert.equal(res.sessionId, "sess-local-1");
  assert.equal(res.focusResult.confirmed, true);
  assert.equal(res.deliveryResult.status, "focus_only");
  assert.equal(direct._deliveries.get(res.deliveryId).status, "focused");
  assert.match(res.text, /focus-only dogfood mode/);
  assert.doesNotMatch(res.text, /continue please/);
  assert.deepEqual(focused, [{
    sessionId: "sess-local-1",
    options: {
      requestSource: "telegram-direct-send",
      fallbackEntry: localTerminalEntry(),
    },
  }]);
});

test("direct send routes replies to their own sessions when notifications overlap", async () => {
  const sessions = [
    localTerminalEntry({ id: "sess-alpha", sourcePid: 1111 }),
    localTerminalEntry({ id: "sess-beta", sourcePid: 2222 }),
  ];
  const focused = [];
  const delivered = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions }),
    focusSession: (sessionId) => {
      focused.push(sessionId);
      return confirmedFocusResult();
    },
    deliveryAdapter: {
      deliver: async ({ sessionId, promptText }) => {
        delivered.push({ sessionId, promptText });
        return { status: "pasted_without_enter", delivered: true };
      },
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 101, sessionId: "sess-alpha" });
  direct.registerCompletionNotification({ messageId: 202, sessionId: "sess-beta" });

  const betaReply = await direct.handleTextMessage({
    text: "continue beta",
    replyToMessageId: 202,
    messageId: 301,
  });
  const alphaReply = await direct.handleTextMessage({
    text: "continue alpha",
    replyToMessageId: 101,
    messageId: 302,
  });

  assert.equal(betaReply.sessionId, "sess-beta");
  assert.equal(alphaReply.sessionId, "sess-alpha");
  assert.deepEqual(focused, ["sess-beta", "sess-alpha"]);
  assert.deepEqual(delivered, [
    { sessionId: "sess-beta", promptText: "continue beta" },
    { sessionId: "sess-alpha", promptText: "continue alpha" },
  ]);
});

test("direct send serializes overlapping focus and delivery operations", async () => {
  const sessions = [
    localTerminalEntry({ id: "sess-alpha", sourcePid: 1111 }),
    localTerminalEntry({ id: "sess-beta", sourcePid: 2222 }),
  ];
  const events = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions }),
    focusSession: async (sessionId) => {
      events.push(`focus:${sessionId}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return confirmedFocusResult({ token: `token-${sessionId}` });
    },
    deliveryAdapter: {
      deliver: async ({ sessionId }) => {
        events.push(`deliver:${sessionId}`);
        return { status: "sent_with_enter", delivered: true, autoEnter: true };
      },
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 301, sessionId: "sess-alpha" });
  direct.registerCompletionNotification({ messageId: 302, sessionId: "sess-beta" });
  const [alpha, beta] = await Promise.all([
    direct.handleTextMessage({ text: "alpha", replyToMessageId: 301 }),
    direct.handleTextMessage({ text: "beta", replyToMessageId: 302 }),
  ]);

  assert.equal(alpha.status, "sent_with_enter");
  assert.equal(beta.status, "sent_with_enter");
  assert.deepEqual(events, [
    "focus:sess-alpha",
    "deliver:sess-alpha",
    "focus:sess-beta",
    "deliver:sess-beta",
  ]);
});

test("direct send prefers the matching chat when Telegram message ids repeat", async () => {
  const sessions = [
    localTerminalEntry({ id: "sess-one", sourcePid: 1111 }),
    localTerminalEntry({ id: "sess-two", sourcePid: 2222 }),
  ];
  const focused = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions }),
    focusSession: (sessionId) => {
      focused.push(sessionId);
      return confirmedFocusResult();
    },
    deliveryAdapter: {
      deliver: async () => ({ status: "sent_with_enter", delivered: true, autoEnter: true }),
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 77, chatId: "123", sessionId: "sess-one" });
  direct.registerCompletionNotification({ messageId: 77, chatId: "456", sessionId: "sess-two" });

  const result = await direct.handleTextMessage({
    text: "continue in two",
    replyToMessageId: 77,
    chatId: "456",
  });

  assert.equal(result.sessionId, "sess-two");
  assert.deepEqual(focused, ["sess-two"]);
});

test("direct send does not resolve a chat-scoped mapping from another chat", async () => {
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => { throw new Error("must not focus"); },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({
    messageId: 77,
    chatId: "123",
    sessionId: "sess-local-1",
  });

  const result = await direct.handleTextMessage({
    text: "wrong chat",
    replyToMessageId: 77,
    chatId: "456",
  });

  assert.equal(result.status, "unmapped");
});

test("direct send caps mappings and evicts the oldest chat-scoped entry", async () => {
  assert.equal(DEFAULT_MAX_MAPPINGS, 1000);
  const sessions = [
    localTerminalEntry({ id: "sess-old", sourcePid: 1001 }),
    localTerminalEntry({ id: "sess-middle", sourcePid: 1002 }),
    localTerminalEntry({ id: "sess-new", sourcePid: 1003 }),
  ];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    maxMappings: 2,
    getSessionSnapshot: () => ({ sessions }),
    focusSession: () => confirmedFocusResult(),
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 77, chatId: "123", sessionId: "sess-old" });
  direct.registerCompletionNotification({ messageId: 77, chatId: "456", sessionId: "sess-middle" });
  direct.registerCompletionNotification({ messageId: 88, chatId: "123", sessionId: "sess-new" });

  assert.equal(direct._mappings.size, 2);
  assert.equal((await direct.handleTextMessage({
    text: "old",
    replyToMessageId: 77,
    chatId: "123",
  })).status, "unmapped");
  assert.equal((await direct.handleTextMessage({
    text: "middle",
    replyToMessageId: 77,
    chatId: "456",
  })).sessionId, "sess-middle");
  assert.equal((await direct.handleTextMessage({
    text: "new",
    replyToMessageId: 88,
    chatId: "123",
  })).sessionId, "sess-new");
});

test("direct send consumes only the successfully submitted chat-scoped mapping", async () => {
  const sessions = [
    localTerminalEntry({ id: "sess-one", sourcePid: 1001 }),
    localTerminalEntry({ id: "sess-two", sourcePid: 1002 }),
  ];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions }),
    focusSession: () => confirmedFocusResult(),
    deliveryAdapter: {
      deliver: async () => ({ status: "sent_with_enter", delivered: true, autoEnter: true }),
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 77, chatId: "123", sessionId: "sess-one" });
  direct.registerCompletionNotification({ messageId: 77, chatId: "456", sessionId: "sess-two" });

  const sent = await direct.handleTextMessage({ text: "first", replyToMessageId: 77, chatId: "123" });
  const replay = await direct.handleTextMessage({ text: "again", replyToMessageId: 77, chatId: "123" });
  const otherChat = await direct.handleTextMessage({ text: "other", replyToMessageId: 77, chatId: "456" });

  assert.equal(sent.status, "sent_with_enter");
  assert.equal(replay.status, "unmapped");
  assert.equal(otherChat.sessionId, "sess-two");
});

test("direct send consumes mappings after uncertain console writes without fallback", async () => {
  for (const errorClass of ["partial_console_write", "console_input_result_unknown"]) {
    const fallbackWrites = [];
    const direct = createTelegramDirectSend({
      isEnabled: () => true,
      getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
      focusSession: () => { throw new Error("must not focus"); },
      deliveryAdapter: {
        requiresFocus: false,
        deliver: async () => ({ status: "failed", delivered: false, errorClass }),
      },
      fallbackAdapter: createClipboardFallbackDeliveryAdapter({
        clipboard: { writeText: (value) => fallbackWrites.push(value) },
      }),
      osPlatform: "win32",
    });

    direct.registerCompletionNotification({ messageId: 90, chatId: "123", sessionId: "sess-local-1" });
    const first = await direct.handleTextMessage({ text: "reply", replyToMessageId: 90, chatId: "123" });
    const replay = await direct.handleTextMessage({ text: "again", replyToMessageId: 90, chatId: "123" });

    assert.equal(first.status, "failed");
    assert.equal(first.deliveryResult.errorClass, errorClass);
    assert.equal(replay.status, "unmapped");
    assert.deepEqual(fallbackWrites, []);
  }
});

test("direct send queue continues after an earlier delivery rejects", async () => {
  let snapshotCalls = 0;
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) throw new Error("snapshot unavailable");
      return { sessions: [localTerminalEntry()] };
    },
    focusSession: () => confirmedFocusResult(),
    deliveryAdapter: {
      deliver: async () => ({ status: "sent_with_enter", delivered: true, autoEnter: true }),
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 81, sessionId: "sess-local-1" });
  direct.registerCompletionNotification({ messageId: 82, sessionId: "sess-local-1" });

  const first = direct.handleTextMessage({ text: "first", replyToMessageId: 81 });
  const second = direct.handleTextMessage({ text: "second", replyToMessageId: 82 });

  await assert.rejects(first, /snapshot unavailable/);
  const result = await second;
  assert.equal(result.status, "sent_with_enter");
});

test("direct send falls back to clipboard when the platform paste adapter is unsupported", async () => {
  const writes = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => confirmedFocusResult(),
    deliveryAdapter: createWindowsPasteOnlyDeliveryAdapter({
      osPlatform: "darwin",
      clipboard: { writeText: () => { throw new Error("must not touch paste clipboard"); } },
    }),
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: {
        writeText: (value, type) => writes.push({ value, type }),
        readText: () => "continue please",
      },
    }),
    osPlatform: "darwin",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({
    text: "continue please",
    replyToMessageId: 42,
    messageId: 99,
    fromId: "777",
    chatId: "123",
  });

  assert.equal(res.status, "fallback_copied");
  assert.equal(direct._deliveries.get(res.deliveryId).fallbackReason, "platform_unsupported");
  assert.deepEqual(writes, [{ value: "continue please", type: "clipboard" }]);
  assert.match(res.text, /Copied text to this computer's clipboard/);
  assert.doesNotMatch(res.text, /focus-only dogfood mode/);

  const retry = await direct.handleTextMessage({
    text: "continue please",
    replyToMessageId: 42,
    chatId: "123",
  });
  assert.equal(retry.status, "fallback_copied");
  assert.equal(writes.length, 2);
});

test("direct send treats bare carriage returns as multiline and falls back to clipboard", async () => {
  const pasteWrites = [];
  const fallbackWrites = [];
  const execCalls = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => confirmedFocusResult(),
    deliveryAdapter: createWindowsPasteOnlyDeliveryAdapter({
      osPlatform: "win32",
      clipboard: {
        readText: () => "previous",
        writeText: (value) => pasteWrites.push(value),
      },
      execFile: (cmd, args, opts, cb) => {
        execCalls.push({ cmd, args, opts });
        cb(null, "", "");
      },
    }),
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: {
        writeText: (value, type) => fallbackWrites.push({ value, type }),
        readText: () => "line one\nline two",
      },
    }),
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({
    text: "line one\rline two",
    replyToMessageId: 42,
    messageId: 99,
  });

  assert.equal(res.status, "fallback_copied");
  assert.equal(direct._deliveries.get(res.deliveryId).promptText, "line one\nline two");
  assert.equal(direct._deliveries.get(res.deliveryId).fallbackReason, "multiline_unsupported");
  assert.deepEqual(pasteWrites, []);
  assert.deepEqual(execCalls, []);
  assert.deepEqual(fallbackWrites, [{ value: "line one\nline two", type: "clipboard" }]);
});

test("direct send ignores normal text while the feature flag is disabled", async () => {
  const direct = createTelegramDirectSend({
    isEnabled: () => false,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => { throw new Error("must not focus"); },
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  assert.equal(await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 }), null);
});

test("direct send asks for a reply target when no completion mapping exists", async () => {
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => { throw new Error("must not focus"); },
  });

  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 404 });
  assert.equal(res.status, "unmapped");
  assert.match(res.text, /newly delivered Clawd completion notification/);
});

test("direct send falls back when the mapped session is no longer live", async () => {
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [] }),
    focusSession: () => { throw new Error("must not focus"); },
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 });
  assert.equal(res.status, "session_not_live");
});

test("direct send copies fallback when the mapped session is no longer live", async () => {
  const writes = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [] }),
    focusSession: () => { throw new Error("must not focus"); },
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: { writeText: (value) => writes.push(value) },
    }),
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({
    text: "continue from fallback",
    replyToMessageId: 42,
  });

  assert.equal(res.status, "fallback_copied");
  assert.equal(res.sessionId, "sess-local-1");
  assert.deepEqual(writes, ["continue from fallback"]);
  assert.equal(direct._deliveries.get(res.deliveryId).status, "fallback_copied");
  assert.equal(direct._deliveries.get(res.deliveryId).fallbackReason, "session_not_live");
  assert.match(res.text, /Copied text to this computer's clipboard/);
  assert.doesNotMatch(res.text, /continue from fallback/);
});

test("direct send never focuses remote, headless, sleeping, or permission-pending sessions", async () => {
  const blocked = [
    localTerminalEntry({ id: "remote", host: "server" }),
    localTerminalEntry({
      id: "remote-orca",
      host: "server",
      sourcePid: null,
      orcaPaneKey: "tab-remote:leaf-remote",
    }),
    localTerminalEntry({ id: "headless", headless: true }),
    localTerminalEntry({ id: "sleeping", state: "sleeping" }),
    localTerminalEntry({ id: "permission", state: "notification" }),
  ];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: blocked }),
    focusSession: () => { throw new Error("must not focus"); },
    osPlatform: "win32",
  });

  for (const entry of blocked) {
    direct.registerCompletionNotification({ messageId: entry.id.length + 100, sessionId: entry.id });
    const res = await direct.handleTextMessage({
      text: "continue",
      replyToMessageId: entry.id.length + 100,
    });
    assert.notEqual(res.status, "focused");
  }
});

test("direct send rejects sessions with an authoritative interactive pending permission", async () => {
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    getPendingPermissions: () => [{ sessionId: "sess-local-1", agentId: "claude-code" }],
    focusSession: () => { throw new Error("must not focus"); },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 });

  assert.equal(res.status, "permission_pending");
});

test("direct send does not treat passive notify entries as pending permissions", async () => {
  const focused = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    getPendingPermissions: () => [
      { sessionId: "sess-local-1", isCodexNotify: true },
      { sessionId: "sess-local-1", isKimiNotify: true },
      { sessionId: "sess-local-1", isCodexUserInputNotify: true },
    ],
    focusSession: (sessionId) => {
      focused.push(sessionId);
      return confirmedFocusResult();
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 });

  assert.equal(res.status, "focused");
  assert.deepEqual(focused, ["sess-local-1"]);
});

test("direct send falls back when focus has no confirmed result", async () => {
  const focused = [];
  const delivered = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: (sessionId) => {
      focused.push(sessionId);
      return {
        token: "focus-token-2",
        reason: "parent-direct",
        targetHwnd: "111",
        foregroundHwnd: "222",
        confirmed: false,
        status: "unconfirmed",
      };
    },
    deliveryAdapter: () => {
      delivered.push("called");
      throw new Error("must not deliver");
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 });

  assert.equal(res.status, "focus_unconfirmed");
  assert.equal(res.sessionId, "sess-local-1");
  assert.equal(res.focusResult.confirmed, false);
  assert.deepEqual(focused, ["sess-local-1"]);
  assert.deepEqual(delivered, []);
  assert.equal(direct._deliveries.get(res.deliveryId).status, "focus_unconfirmed");
  assert.match(res.text, /no text was pasted/);
  assert.doesNotMatch(res.text, /continue/);
});

test("direct send copies fallback when focus is unconfirmed without calling delivery adapter", async () => {
  const focused = [];
  const delivered = [];
  const writes = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: (sessionId) => {
      focused.push(sessionId);
      return {
        token: "focus-token-2",
        reason: "parent-direct",
        targetHwnd: "111",
        foregroundHwnd: "222",
        confirmed: false,
        status: "unconfirmed",
      };
    },
    deliveryAdapter: () => {
      delivered.push("called");
      throw new Error("must not deliver");
    },
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: { writeText: (value) => writes.push(value) },
    }),
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 });

  assert.equal(res.status, "fallback_copied");
  assert.equal(res.sessionId, "sess-local-1");
  assert.equal(res.focusResult.confirmed, false);
  assert.deepEqual(focused, ["sess-local-1"]);
  assert.deepEqual(delivered, []);
  assert.deepEqual(writes, ["continue"]);
  const delivery = direct._deliveries.get(res.deliveryId);
  assert.equal(delivery.status, "fallback_copied");
  assert.equal(delivery.errorClass, "focus_unconfirmed");
  assert.deepEqual(delivery.statusHistory.map((item) => item.status), [
    "received",
    "target_resolved",
    "focus_requested",
    "focus_unconfirmed",
    "fallback_copied",
  ]);
  assert.match(res.text, /Copied text to this computer's clipboard/);
  assert.doesNotMatch(res.text, /continue/);
});

test("direct send calls the delivery adapter only after confirmed focus and records the state machine", async () => {
  let ts = 5000;
  const calls = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    now: () => ts++,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => confirmedFocusResult({ token: "focus-token-3" }),
    deliveryAdapter: async (payload) => {
      calls.push(payload);
      return { status: "pasted_without_enter", delivered: true, autoEnter: false, clipboardRestored: true };
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({
    text: "  continue\r\nplease\u0007 ",
    replyToMessageId: 42,
    messageId: 100,
    fromId: "777",
    chatId: "123",
  });

  assert.equal(res.status, "pasted_without_enter");
  assert.equal(res.deliveryResult.delivered, true);
  assert.equal(res.deliveryResult.clipboardRestored, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].deliveryId, res.deliveryId);
  assert.equal(calls[0].promptText, "continue\nplease");
  assert.equal(calls[0].sessionId, "sess-local-1");
  assert.equal(calls[0].focusResult.token, "focus-token-3");
  assert.equal(calls[0].autoEnter, false);

  const delivery = direct._deliveries.get(res.deliveryId);
  assert.equal(delivery.promptText, "continue\nplease");
  assert.equal(delivery.sessionId, "sess-local-1");
  assert.equal(delivery.agentId, "claude-code");
  assert.equal(delivery.focusResult.confirmed, true);
  assert.equal(delivery.deliveryResult.status, "pasted_without_enter");
  assert.deepEqual(delivery.statusHistory.map((item) => item.status), [
    "received",
    "target_resolved",
    "focus_requested",
    "focus_confirmed",
    "delivery_attempted",
    "pasted_without_enter",
  ]);
  assert.doesNotMatch(res.text, /continue/);
  assert.match(res.text, /previous clipboard text was restored/);
  assert.doesNotMatch(res.text, /still on this computer's clipboard/);
});

test("direct send adapter failures become failed deliveries without logging prompt text", async () => {
  const logs = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => confirmedFocusResult(),
    deliveryAdapter: async () => {
      throw new Error("adapter failed after receiving secret prompt");
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({
    text: "secret prompt",
    replyToMessageId: 42,
  });

  assert.equal(res.status, "failed");
  assert.equal(res.deliveryResult.errorClass, "delivery_adapter_threw");
  assert.equal(direct._deliveries.get(res.deliveryId).status, "failed");
  assert.match(res.text, /target terminal|No text was pasted/i);
  assert.doesNotMatch(res.text, /secret prompt/);
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /secret prompt/);
});

test("direct send copies fallback after delivery adapter failure without logging prompt text", async () => {
  const logs = [];
  const writes = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => confirmedFocusResult(),
    deliveryAdapter: async () => ({
      status: "failed",
      delivered: false,
      errorClass: "paste_shortcut_failed",
    }),
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: { writeText: (value) => writes.push(value) },
    }),
    log: (level, message, meta) => logs.push({ level, message, meta }),
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({
    text: "secret prompt",
    replyToMessageId: 42,
  });

  assert.equal(res.status, "fallback_copied");
  assert.equal(res.deliveryResult.status, "fallback_copied");
  assert.deepEqual(writes, ["secret prompt"]);
  const delivery = direct._deliveries.get(res.deliveryId);
  assert.equal(delivery.status, "fallback_copied");
  assert.equal(delivery.fallbackReason, "paste_shortcut_failed");
  assert.deepEqual(delivery.statusHistory.map((item) => item.status), [
    "received",
    "target_resolved",
    "focus_requested",
    "focus_confirmed",
    "delivery_attempted",
    "failed",
    "fallback_copied",
  ]);
  assert.match(res.text, /Copied text to this computer's clipboard/);
  assert.doesNotMatch(res.text, /secret prompt/);
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /secret prompt/);
});

test("clipboard fallback adapter copies text and reports clipboard failures", async () => {
  const writes = [];
  let clipboardText = "";
  const adapter = createClipboardFallbackDeliveryAdapter({
    clipboard: {
      writeText: (value, type) => {
        writes.push({ value, type });
        clipboardText = value;
      },
      readText: (type) => {
        assert.equal(type, "clipboard");
        return clipboardText;
      },
    },
  });

  assert.deepEqual(await adapter.copy({ promptText: "manual fallback" }), {
    status: "fallback_copied",
    delivered: false,
    autoEnter: false,
    errorClass: null,
  });
  assert.deepEqual(writes, [{ value: "manual fallback", type: "clipboard" }]);

  const unavailable = await createClipboardFallbackDeliveryAdapter().copy({ promptText: "x" });
  assert.equal(unavailable.status, "failed");
  assert.equal(unavailable.errorClass, "clipboard_unavailable");

  const writeFailed = await createClipboardFallbackDeliveryAdapter({
    clipboard: { writeText: () => { throw new Error("denied"); } },
  }).copy({ promptText: "x" });
  assert.equal(writeFailed.status, "failed");
  assert.equal(writeFailed.errorClass, "clipboard_write_failed");

  const unconfirmed = await createClipboardFallbackDeliveryAdapter({
    clipboard: {
      writeText: () => {},
      readText: () => "",
    },
  }).copy({ promptText: "x" });
  assert.equal(unconfirmed.status, "failed");
  assert.equal(unconfirmed.errorClass, "clipboard_write_unconfirmed");
});

test("Windows paste-only adapter writes clipboard, waits before Ctrl+V, preserves clipboard, and never submits", async () => {
  const writes = [];
  const execCalls = [];
  const delays = [];
  let clipboardText = "previous text";
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: {
      readText: () => clipboardText,
      writeText: (value) => {
        writes.push(value);
        clipboardText = value;
      },
    },
    execFile: (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args, opts });
      cb(null, "", "");
    },
    delay: async (ms) => { delays.push(ms); },
    readyDelayMs: 25,
  });

  const res = await adapter.deliver({
    promptText: "continue please",
    focusResult: confirmedFocusResult(),
  });

  assert.equal(res.status, "pasted_without_enter");
  assert.equal(res.delivered, true);
  assert.equal(res.autoEnter, false);
  assert.deepEqual(writes, ["continue please"]);
  assert.deepEqual(delays, [25]);
  assert.equal(clipboardText, "continue please");
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].cmd, "powershell.exe");
  assert.deepEqual(execCalls[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  const script = execCalls[0].args[3];
  assert.match(script, /keybd_event\(0x11/);
  assert.match(script, /keybd_event\(0x56/);
  assert.doesNotMatch(script, /0x0D|VK_RETURN|Enter/i);
});

test("Windows paste-only adapter can restore clipboard on success when explicitly requested", async () => {
  const writes = [];
  const delays = [];
  let clipboardText = "previous text";
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: {
      readText: () => clipboardText,
      writeText: (value) => {
        writes.push(value);
        clipboardText = value;
      },
    },
    execFile: (cmd, args, opts, cb) => cb(null, "", ""),
    delay: async (ms) => { delays.push(ms); },
    readyDelayMs: 10,
    restoreDelayMs: 25,
    restoreClipboardOnSuccess: true,
  });

  const res = await adapter.deliver({
    promptText: "continue please",
    focusResult: confirmedFocusResult(),
  });

  assert.equal(res.status, "pasted_without_enter");
  assert.equal(res.clipboardRestored, true);
  assert.deepEqual(writes, ["continue please", "previous text"]);
  assert.deepEqual(delays, [10, 25]);
  assert.equal(clipboardText, "previous text");
});

test("Windows paste-only adapter waits longer for editor-hosted terminals", async () => {
  const delays = [];
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: {
      readText: () => "previous",
      writeText: () => {},
    },
    execFile: (cmd, args, opts, cb) => cb(null, "", ""),
    delay: async (ms) => { delays.push(ms); },
    readyDelayMs: 25,
  });

  const res = await adapter.deliver({
    promptText: "continue please",
    focusResult: confirmedFocusResult(),
    entry: localTerminalEntry({ editor: "code" }),
  });

  assert.equal(res.status, "pasted_without_enter");
  assert.deepEqual(delays, [1200]);
});

test("Windows paste-only adapter pastes into Orca only after an exact pane match", async () => {
  const delays = [];
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: {
      readText: () => "previous",
      writeText: () => {},
    },
    execFile: (cmd, args, opts, cb) => cb(null, "", ""),
    delay: async (ms) => { delays.push(ms); },
    readyDelayMs: 25,
  });

  const res = await adapter.deliver({
    promptText: "continue please",
    focusResult: confirmedFocusResult({
      orcaPane: { ok: true, match: "exact", reason: "orca-pane-switched" },
    }),
    entry: localTerminalEntry({ orcaPaneKey: "8ce1fff7-tab:9813824b-leaf" }),
  });

  assert.equal(res.status, "pasted_without_enter");
  // The switch is confirmed by now, so this is only the composer settling — the
  // old 1200ms was a blind guess at how long two CLI spawns would take.
  assert.deepEqual(delays, [1200]);
});

test("Windows paste-only adapter refuses to paste when the Orca pane is unconfirmed", async () => {
  // Orca confirms focus as soon as its window is raised, but the tab switch is two
  // further CLI spawns. Every one of these cases used to paste anyway and report
  // delivered, dropping the reply into whichever pane was previously active.
  const cases = [
    ["no outcome at all (cold CLI outlasting the wait)", undefined],
    ["a pane that is gone", { ok: false, match: null, reason: "orca-pane-not-found" }],
    ["a CLI that never answered", { ok: false, match: null, reason: "orca-cli-timeout" }],
    ["a rejected switch", { ok: false, match: null, reason: "orca-switch-failed" }],
    ["an ambiguous worktree", { ok: false, match: null, reason: "orca-pane-ambiguous" }],
    // Switched, but only to the right project — not provably the right composer.
    ["a worktree-only match", { ok: true, match: "cwd", reason: "orca-pane-switched" }],
  ];

  for (const [label, orcaPane] of cases) {
    const writes = [];
    const execCalls = [];
    const adapter = createWindowsPasteOnlyDeliveryAdapter({
      osPlatform: "win32",
      clipboard: {
        readText: () => "previous",
        writeText: (value) => writes.push(value),
      },
      execFile: (cmd, args, opts, cb) => { execCalls.push(args); cb(null, "", ""); },
      delay: async () => {},
      readyDelayMs: 25,
    });

    const res = await adapter.deliver({
      promptText: "continue please",
      focusResult: confirmedFocusResult({ orcaPane }),
      entry: localTerminalEntry({ orcaPaneKey: "8ce1fff7-tab:9813824b-leaf" }),
    });

    assert.equal(res.status, "failed", `${label} must not report a delivery`);
    assert.equal(res.delivered, false, `${label} must not report delivered`);
    assert.equal(res.errorClass, "orca_pane_unconfirmed", label);
    assert.deepEqual(execCalls, [], `${label} must not press Ctrl+V`);
    // The clipboard is the fallback surface, so it must be left untouched here for
    // the caller's clipboard fallback to own it.
    assert.deepEqual(writes, [], `${label} must not overwrite the clipboard`);
  }
});

test("Windows paste-only adapter ignores the pane gate for non-Orca sessions", async () => {
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: {
      readText: () => "previous",
      writeText: () => {},
    },
    execFile: (cmd, args, opts, cb) => cb(null, "", ""),
    delay: async () => {},
    readyDelayMs: 25,
  });

  // A plain terminal has no pane to confirm; gating it would break every non-Orca
  // Direct Send.
  const res = await adapter.deliver({
    promptText: "continue please",
    focusResult: confirmedFocusResult(),
    entry: localTerminalEntry({ editor: "code" }),
  });

  assert.equal(res.status, "pasted_without_enter");
});

test("direct send preserves editor metadata from real session snapshots for paste timing", async () => {
  const deliveredEntries = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => buildSessionSnapshot(new Map([
      ["sess-local-1", {
        agentId: "claude-code",
        state: "idle",
        updatedAt: 1000,
        sourcePid: 1234,
        editor: "code",
        recentEvents: [{ event: "Stop", at: 1000 }],
      }],
    ])),
    focusSession: () => confirmedFocusResult(),
    deliveryAdapter: {
      deliver: async (payload) => {
        deliveredEntries.push(payload.entry);
        return { status: "pasted_without_enter", delivered: true, autoEnter: false };
      },
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 });

  assert.equal(res.status, "pasted_without_enter");
  assert.equal(deliveredEntries.length, 1);
  assert.equal(deliveredEntries[0].editor, "code");
});

test("direct send gates the Orca paste using a real session snapshot", async () => {
  // The adapter test above hand-builds its entry, so it cannot see whether the
  // field survives buildSessionSnapshotEntry — which is a whitelist. Drive the
  // real adapter through the real snapshot builder instead: if the pane key is not
  // carried there, the gate never fires and an unconfirmed pane pastes anyway.
  const delays = [];
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: {
      readText: () => "previous",
      writeText: () => {},
    },
    execFile: (cmd, args, opts, cb) => cb(null, "", ""),
    delay: async (ms) => { delays.push(ms); },
    readyDelayMs: 25,
  });
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => buildSessionSnapshot(new Map([
      ["sess-local-1", {
        agentId: "claude-code",
        state: "idle",
        updatedAt: 1000,
        sourcePid: 1234,
        orcaPaneKey: "8ce1fff7-tab:9813824b-leaf",
        recentEvents: [{ event: "Stop", at: 1000 }],
      }],
    ])),
    focusSession: () => confirmedFocusResult({
      orcaPane: { ok: true, match: "exact", reason: "orca-pane-switched" },
    }),
    deliveryAdapter: adapter,
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 43, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 43 });

  assert.equal(res.status, "pasted_without_enter");
  assert.deepEqual(delays, [1200]);
});

test("direct send falls back to the clipboard when the Orca pane is unconfirmed", async () => {
  const writes = [];
  const execCalls = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => buildSessionSnapshot(new Map([
      ["sess-local-1", {
        agentId: "claude-code",
        state: "idle",
        updatedAt: 1000,
        sourcePid: 1234,
        orcaPaneKey: "8ce1fff7-tab:9813824b-leaf",
        recentEvents: [{ event: "Stop", at: 1000 }],
      }],
    ])),
    // The window came forward, so the focus itself is genuinely confirmed; only the
    // pane switch is not.
    focusSession: () => confirmedFocusResult({
      orcaPane: { ok: false, match: null, reason: "orca-cli-timeout" },
    }),
    deliveryAdapter: createWindowsPasteOnlyDeliveryAdapter({
      osPlatform: "win32",
      clipboard: { readText: () => "previous", writeText: () => {} },
      execFile: (cmd, args, opts, cb) => { execCalls.push(args); cb(null, "", ""); },
      delay: async () => {},
    }),
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: {
        writeText: (value, type) => writes.push({ value, type }),
        readText: () => "continue",
      },
    }),
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 44, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 44 });

  assert.equal(res.status, "fallback_copied");
  assert.equal(direct._deliveries.get(res.deliveryId).fallbackReason, "orca_pane_unconfirmed");
  assert.deepEqual(execCalls, [], "no paste may be attempted");
  assert.deepEqual(writes, [{ value: "continue", type: "clipboard" }]);
});

test("the focus gate carries the Orca pane outcome through to the adapter", async () => {
  // normalizeFocusGateResult is a whitelist: a field it does not name is dropped
  // between focusSession and the adapter, which would leave the gate reading
  // undefined on every real delivery while every hand-built test still passed.
  const seen = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => buildSessionSnapshot(new Map([
      ["sess-local-1", {
        agentId: "claude-code",
        state: "idle",
        updatedAt: 1000,
        sourcePid: 1234,
        orcaPaneKey: "8ce1fff7-tab:9813824b-leaf",
        recentEvents: [{ event: "Stop", at: 1000 }],
      }],
    ])),
    focusSession: () => confirmedFocusResult({
      orcaPane: { ok: true, match: "exact", reason: "orca-pane-switched" },
    }),
    deliveryAdapter: {
      deliver: async (payload) => {
        seen.push(payload.focusResult);
        return { status: "pasted_without_enter", delivered: true, autoEnter: false };
      },
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 45, sessionId: "sess-local-1" });
  await direct.handleTextMessage({ text: "continue", replyToMessageId: 45 });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].orcaPane, { ok: true, match: "exact", reason: "orca-pane-switched" });
});

test("Windows paste-only adapter refuses multiline text before touching clipboard or keyboard", async () => {
  const writes = [];
  const execCalls = [];
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: {
      readText: () => "previous",
      writeText: (value) => writes.push(value),
    },
    execFile: (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args, opts });
      cb(null, "", "");
    },
  });

  const res = await adapter.deliver({
    promptText: "line one\nline two",
    focusResult: confirmedFocusResult(),
  });

  assert.equal(res.status, "failed");
  assert.equal(res.errorClass, "multiline_unsupported");
  assert.deepEqual(writes, []);
  assert.deepEqual(execCalls, []);
});

test("Windows paste-only adapter requires confirmed focus even when called directly", async () => {
  const writes = [];
  const execCalls = [];
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: {
      readText: () => "previous",
      writeText: (value) => writes.push(value),
    },
    execFile: (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args, opts });
      cb(null, "", "");
    },
  });

  const res = await adapter.deliver({
    promptText: "continue",
    focusResult: { confirmed: false, reason: "hwnd-mismatch" },
  });

  assert.equal(res.status, "failed");
  assert.equal(res.errorClass, "focus_unconfirmed");
  assert.deepEqual(writes, []);
  assert.deepEqual(execCalls, []);
});

test("Windows paste-only adapter restores clipboard after paste shortcut failure", async () => {
  const writes = [];
  let clipboardText = "previous";
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: {
      readText: () => clipboardText,
      writeText: (value) => {
        writes.push(value);
        clipboardText = value;
      },
    },
    execFile: (cmd, args, opts, cb) => cb(new Error("shortcut failed")),
  });

  const res = await adapter.deliver({
    promptText: "continue",
    focusResult: confirmedFocusResult(),
  });

  assert.equal(res.status, "failed");
  assert.equal(res.errorClass, "paste_shortcut_failed");
  assert.deepEqual(writes, ["continue", "previous"]);
  assert.equal(clipboardText, "previous");
});

test("Windows paste-only adapter fails closed on unsupported platforms", async () => {
  const writes = [];
  const execCalls = [];
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "linux",
    clipboard: {
      readText: () => "previous",
      writeText: (value) => writes.push(value),
    },
    execFile: (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args, opts });
      cb(null, "", "");
    },
  });

  const res = await adapter.deliver({
    promptText: "continue",
    focusResult: confirmedFocusResult(),
  });

  assert.equal(res.status, "failed");
  assert.equal(res.errorClass, "platform_unsupported");
  assert.deepEqual(writes, []);
  assert.deepEqual(execCalls, []);
});

test("Windows paste-only adapter fails closed when clipboard writing is unavailable", async () => {
  const execCalls = [];
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: { readText: () => "previous" },
    execFile: (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args, opts });
      cb(null, "", "");
    },
  });

  const res = await adapter.deliver({
    promptText: "continue",
    focusResult: confirmedFocusResult(),
  });

  assert.equal(res.status, "failed");
  assert.equal(res.errorClass, "clipboard_unavailable");
  assert.deepEqual(execCalls, []);
});

test("Windows paste-only adapter does not send keys when clipboard write fails", async () => {
  const execCalls = [];
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: {
      readText: () => "previous",
      writeText: () => { throw new Error("clipboard denied"); },
    },
    execFile: (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args, opts });
      cb(null, "", "");
    },
  });

  const res = await adapter.deliver({
    promptText: "continue",
    focusResult: confirmedFocusResult(),
  });

  assert.equal(res.status, "failed");
  assert.equal(res.errorClass, "clipboard_write_failed");
  assert.deepEqual(execCalls, []);
});

test("Windows paste-only adapter reports delivered when only clipboard restore fails", async () => {
  const writes = [];
  let clipboardText = "previous";
  const adapter = createWindowsPasteOnlyDeliveryAdapter({
    osPlatform: "win32",
    clipboard: {
      readText: () => clipboardText,
      writeText: (value) => {
        writes.push(value);
        if (value === "previous") throw new Error("restore failed");
        clipboardText = value;
      },
    },
    execFile: (cmd, args, opts, cb) => cb(null, "", ""),
    restoreClipboardOnSuccess: true,
    delay: async () => {},
  });

  const res = await adapter.deliver({
    promptText: "continue",
    focusResult: confirmedFocusResult(),
  });

  assert.equal(res.status, "pasted_without_enter");
  assert.equal(res.delivered, true);
  assert.equal(res.errorClass, "clipboard_restore_failed");
  assert.deepEqual(writes, ["continue", "previous"]);
  assert.equal(clipboardText, "continue");
});

test("Windows paste shortcut script contains only Ctrl+V key events", () => {
  const script = buildWindowsPasteShortcutScript();
  assert.match(script, /0x11/);
  assert.match(script, /0x56/);
  assert.doesNotMatch(script, /0x0D|VK_RETURN|Enter/i);
});

test("direct send expires notification mappings", async () => {
  let ts = 1000;
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    now: () => ts,
    mappingTtlMs: 10,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => { throw new Error("must not focus"); },
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  ts += 11;
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 });
  assert.equal(res.status, "unmapped");
});

test("direct send reports a completion mapping as replyable only until it expires", () => {
  let ts = 1000;
  const target = localTerminalEntry({
    id: "sess-retained",
    rawSessionId: "raw-retained",
    agentPid: 4321,
  });
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    now: () => ts,
    mappingTtlMs: 10,
  });

  const context = direct.createCompletionNotificationContext(target);
  assert.equal(direct.registerCompletionNotification({
    messageId: 43,
    sessionId: target.id,
    notificationContext: context,
  }), true);
  assert.equal(direct.hasReplyableCompletionMapping(target.id, target), true);
  assert.equal(direct.hasReplyableCompletionMapping(target.id, {
    ...target,
    agentPid: 9876,
  }), false, "a reused session identity must not be retained by an older mapping");

  ts += 11;
  assert.equal(direct.hasReplyableCompletionMapping(target.id, target), false);
  assert.equal(direct._mappings.size, 0);
});

test("direct send stops reporting completion mappings after their native route changes", () => {
  let routeGeneration = 31;
  const target = localTerminalEntry({ id: "sess-route-retained", agentPid: 4331 });
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getRouteGeneration: () => routeGeneration,
  });
  const context = direct.createCompletionNotificationContext(target);

  assert.equal(direct.registerCompletionNotification({
    messageId: 44,
    chatId: "123",
    sessionId: target.id,
    notificationContext: context,
  }), true);
  assert.equal(direct.hasReplyableCompletionMapping(target.id, target), true);

  routeGeneration = 32;
  assert.equal(direct.hasReplyableCompletionMapping(target.id, target), false);
  assert.equal(direct._mappings.size, 0);
});

test("normalizePromptText keeps newlines but removes control characters", () => {
  assert.equal(normalizePromptText("  hi\r\nthere\u0007  "), "hi\nthere");
});

test("direct send keeps a mapping and copies fallback while the Console helper is quarantined", async () => {
  const fallbackWrites = [];
  let attempts = 0;
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => { throw new Error("must not focus"); },
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async () => {
        attempts += 1;
        return attempts === 1
          ? { status: "failed", delivered: false, errorClass: "console_input_helper_quarantined" }
          : { status: "sent_with_enter", delivered: true, autoEnter: true };
      },
    },
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: { writeText: (value) => fallbackWrites.push(value) },
    }),
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 91, chatId: "123", sessionId: "sess-local-1" });
  const quarantined = await direct.handleTextMessage({ text: "reply", replyToMessageId: 91, chatId: "123" });
  const retried = await direct.handleTextMessage({ text: "reply", replyToMessageId: 91, chatId: "123" });

  assert.equal(quarantined.status, "fallback_copied");
  assert.equal(
    direct._deliveries.get(quarantined.deliveryId).fallbackReason,
    "console_input_helper_quarantined",
  );
  assert.equal(retried.status, "sent_with_enter");
  assert.deepEqual(fallbackWrites, ["reply"]);
});

test("direct send preserves oversized replies and copies them without Console submission", async () => {
  const target = localTerminalEntry({ id: "sess-long-reply", agentPid: 2111 });
  const reply = `keep-all:${"x".repeat(3800)}`;
  const copied = [];
  let deliveryCount = 0;
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target] }),
    focusSession: () => { throw new Error("oversized reply must not focus"); },
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async () => {
        deliveryCount += 1;
        return { status: "sent_with_enter", delivered: true, autoEnter: true };
      },
    },
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: { writeText: (value) => copied.push(value) },
    }),
    osPlatform: "win32",
  });
  direct.registerCompletionNotification({
    messageId: 949,
    chatId: "123",
    sessionId: target.id,
    agentPid: target.agentPid,
  });

  assert.equal(normalizePromptText(reply), reply);
  const result = await direct.handleTextMessage({
    text: reply,
    replyToMessageId: 949,
    chatId: "123",
  });

  assert.equal(result.status, "fallback_copied");
  assert.equal(deliveryCount, 0);
  assert.deepEqual(copied, [reply]);
  assert.equal(direct._deliveries.get(result.deliveryId).fallbackReason, "reply_too_long");
  assert.equal(direct._mappings.size, 1, "manual clipboard fallback keeps the reply target reusable");
});

test("the delivery ack names the display tag, not the key envelope or raw prefix", () => {
  const { formatDeliveryAck } = require("../src/telegram-direct-send");
  const { resolveSessionIdentity } = require("../src/session-key");
  const t = (key) => (key === "directSendAckSent" ? "sent to {session}" : key);

  function ackFor(rawSessionId, overrides = {}) {
    const identity = resolveSessionIdentity(rawSessionId, "local");
    return formatDeliveryAck("sent_with_enter", {
      id: identity.sessionId,
      rawSessionId: identity.rawSessionId,
      ...overrides,
    }, null, t);
  }

  const a = ackFor("11111111-2222-3333-4444-555555555555");
  const b = ackFor("99999999-8888-7777-6666-aaaaaaaaaaaa");
  const explicit = ackFor("11111111-2222-3333-4444-555555555555", {
    displaySessionTag: "deadbeef00",
  });
  assert.notEqual(a, b, "two sessions must not produce the same ack");
  assert.ok(!a.includes("s1."), `ack must not carry the key envelope: ${a}`);
  assert.doesNotMatch(a, /111111/);
  assert.equal(a, "sent to a0a040910c");
  assert.equal(explicit, "sent to deadbeef00");
});

test("direct send rechecks session state after focus before invoking the delivery adapter", async () => {
  let session = localTerminalEntry();
  const deliveryCalls = [];
  const fallbackWrites = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [session] }),
    focusSession: async () => {
      await Promise.resolve();
      session = { ...session, state: "working", badge: "running" };
      return confirmedFocusResult();
    },
    deliveryAdapter: {
      deliver: async (payload) => {
        deliveryCalls.push(payload);
        return { status: "sent_with_enter", delivered: true, autoEnter: true };
      },
    },
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: { writeText: (value) => fallbackWrites.push(value) },
    }),
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 901, sessionId: session.id });
  const result = await direct.handleTextMessage({ text: "continue", replyToMessageId: 901 });

  assert.equal(result.status, "session_changed");
  assert.deepEqual(deliveryCalls, []);
  assert.deepEqual(fallbackWrites, []);
  assert.match(result.text, /session changed/i);
});

test("direct send rechecks pending permissions after focus before invoking the delivery adapter", async () => {
  const session = localTerminalEntry();
  let pendingPermissions = [];
  const deliveryCalls = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [session] }),
    getPendingPermissions: () => pendingPermissions,
    focusSession: async () => {
      await Promise.resolve();
      pendingPermissions = [{ sessionId: session.id, agentId: session.agentId }];
      return confirmedFocusResult();
    },
    deliveryAdapter: {
      deliver: async (payload) => {
        deliveryCalls.push(payload);
        return { status: "sent_with_enter", delivered: true, autoEnter: true };
      },
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 902, sessionId: session.id });
  const result = await direct.handleTextMessage({ text: "continue", replyToMessageId: 902 });

  assert.equal(result.status, "permission_pending");
  assert.deepEqual(deliveryCalls, []);
});

test("direct send uses a focusless terminal-channel adapter and passes peer session PIDs", async () => {
  const target = localTerminalEntry({ id: "sess-target", sourcePid: 1111, agentPid: 2111 });
  const peer = localTerminalEntry({ id: "sess-peer", sourcePid: 1222, agentPid: 2222 });
  const deliveries = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target, peer] }),
    focusSession: () => { throw new Error("focus must not run for terminal-channel delivery"); },
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async (payload) => {
        deliveries.push(payload);
        assert.deepEqual(await payload.validateBeforeInput(), {
          ok: true,
          otherSessionAgentPids: [2222],
        });
        return { status: "sent_with_enter", delivered: true, autoEnter: true };
      },
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({
    messageId: 950,
    chatId: "123",
    sessionId: target.id,
    sourcePid: target.sourcePid,
  });
  const result = await direct.handleTextMessage({
    text: "/compact",
    replyToMessageId: 950,
    chatId: "123",
  });

  assert.equal(result.status, "sent_with_enter");
  assert.equal(result.focusResult, null);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].entry.agentPid, 2111);
  assert.deepEqual(deliveries[0].otherSessionAgentPids, [2222]);
  assert.deepEqual(direct._deliveries.get(result.deliveryId).statusHistory.map((item) => item.status), [
    "received",
    "target_resolved",
    "target_revalidated",
    "delivery_attempted",
    "sent_with_enter",
  ]);
});

test("direct send rechecks its feature gate before Console input and does not fall back", async () => {
  const target = localTerminalEntry({ id: "sess-disable-race", sourcePid: 1111, agentPid: 2111 });
  let enabled = true;
  let fallbackCount = 0;
  const direct = createTelegramDirectSend({
    isEnabled: () => enabled,
    getSessionSnapshot: () => ({ sessions: [target] }),
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async (payload) => {
        enabled = false;
        const validation = await payload.validateBeforeInput();
        return {
          status: "failed",
          delivered: false,
          errorClass: validation.errorClass,
        };
      },
    },
    fallbackAdapter: {
      copy: async () => {
        fallbackCount += 1;
        return { status: "fallback_copied", delivered: false };
      },
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({
    messageId: 951,
    chatId: "123",
    sessionId: target.id,
    sourcePid: target.sourcePid,
    agentPid: target.agentPid,
  });
  const result = await direct.handleTextMessage({
    text: "continue",
    replyToMessageId: 951,
    chatId: "123",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.deliveryResult.errorClass, "direct_send_disabled");
  assert.equal(fallbackCount, 0);
  assert.equal(direct._mappings.size, 1);
});

test("direct send drops a queued reply whose original poll signal was aborted", async () => {
  const target = localTerminalEntry({ id: "sess-aborted-queue", agentPid: 2111 });
  let deliveryCount = 0;
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target] }),
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async () => {
        deliveryCount += 1;
        if (deliveryCount === 1) {
          firstStarted();
          await new Promise((resolve) => { releaseFirst = resolve; });
        }
        return { status: "focus_only", delivered: false };
      },
    },
    osPlatform: "win32",
  });
  direct.registerCompletionNotification({ messageId: 952, chatId: "123", sessionId: target.id });
  direct.registerCompletionNotification({ messageId: 953, chatId: "123", sessionId: target.id });

  const first = direct.handleTextMessage({ text: "first", replyToMessageId: 952, chatId: "123" });
  await started;
  const controller = new AbortController();
  const stale = direct.handleTextMessage({
    text: "stale",
    replyToMessageId: 953,
    chatId: "123",
    signal: controller.signal,
  });
  controller.abort();
  releaseFirst();

  assert.equal((await first).status, "focused");
  assert.equal(await stale, null);
  assert.equal(deliveryCount, 1);
});

test("direct send rejects an aborted signal at focus and Console validation without fallback", async () => {
  const target = localTerminalEntry({ id: "sess-aborted-input", agentPid: 2111 });
  let adapterCount = 0;
  let fallbackCount = 0;
  const focusAbort = new AbortController();
  const focusDirect = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target] }),
    focusSession: () => {
      focusAbort.abort();
      return confirmedFocusResult();
    },
    deliveryAdapter: {
      deliver: async () => {
        adapterCount += 1;
        return { status: "sent_with_enter", delivered: true };
      },
    },
    fallbackAdapter: { copy: async () => { fallbackCount += 1; } },
    osPlatform: "win32",
  });
  focusDirect.registerCompletionNotification({ messageId: 954, chatId: "123", sessionId: target.id });
  const focused = await focusDirect.handleTextMessage({
    text: "stale focus",
    replyToMessageId: 954,
    chatId: "123",
    signal: focusAbort.signal,
  });
  assert.equal(focused.status, "cancelled");

  const inputAbort = new AbortController();
  const inputDirect = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target] }),
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async (payload) => {
        adapterCount += 1;
        assert.equal(payload.signal, inputAbort.signal);
        inputAbort.abort();
        const validation = payload.validateBeforeInput();
        return { status: "failed", delivered: false, errorClass: validation.errorClass };
      },
    },
    fallbackAdapter: { copy: async () => { fallbackCount += 1; } },
    osPlatform: "win32",
  });
  inputDirect.registerCompletionNotification({ messageId: 955, chatId: "123", sessionId: target.id });
  const validated = await inputDirect.handleTextMessage({
    text: "stale input",
    replyToMessageId: 955,
    chatId: "123",
    signal: inputAbort.signal,
  });

  assert.equal(validated.deliveryResult.errorClass, "direct_send_cancelled");
  assert.equal(adapterCount, 1);
  assert.equal(fallbackCount, 0);
});

test("direct send invalidates old notification routes and accepts the new generation", () => {
  const direct = createTelegramDirectSend({ isEnabled: () => true });
  const oldContext = direct.createCompletionNotificationContext({ id: "sess-route" });

  direct.invalidateMappings();
  assert.equal(
    direct.isCompletionNotificationRouteCurrent(oldContext),
    false,
    "recipient and token invalidation must suppress a queued completion notification",
  );
  assert.equal(direct.isCompletionNotificationContextCurrent(oldContext), false);
  assert.equal(direct.registerCompletionNotification({
    messageId: 960,
    chatId: "123",
    sessionId: "sess-route",
    notificationContext: oldContext,
  }), false);

  const currentContext = direct.createCompletionNotificationContext({ id: "sess-route" });
  assert.equal(direct.registerCompletionNotification({
    messageId: 961,
    chatId: "123",
    sessionId: "sess-route",
    notificationContext: currentContext,
  }), true);
  assert.equal(direct._mappings.size, 1);
});

test("direct send mapping-only invalidation keeps the notification route current", () => {
  const direct = createTelegramDirectSend({ isEnabled: () => true });
  const context = direct.createCompletionNotificationContext({ id: "sess-toggle" });

  direct.invalidateMappings({ notificationRouteChanged: false });

  assert.equal(direct.isCompletionNotificationRouteCurrent(context), true);
  assert.equal(direct.isCompletionNotificationContextCurrent(context), false);
  assert.equal(direct.registerCompletionNotification({
    messageId: 9601,
    chatId: "123",
    sessionId: "sess-toggle",
    notificationContext: context,
  }), false);
});

test("direct send binds completion contexts to the active native polling route", () => {
  let generation = 11;
  let polling = true;
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getRouteGeneration: () => polling ? generation : null,
  });

  const context = direct.createCompletionNotificationContext({ id: "sess-native-route" });
  assert.equal(context.routeGeneration, 11);
  assert.equal(direct.isCompletionNotificationRouteCurrent(context), true);
  assert.equal(direct.isCompletionNotificationContextCurrent(context), true);

  polling = false;
  const stoppedContext = direct.createCompletionNotificationContext({ id: "sess-stopped-route" });
  assert.equal(stoppedContext.routeGeneration, null);
  assert.equal(direct.isCompletionNotificationRouteCurrent(context), false);
  assert.equal(direct.isCompletionNotificationRouteCurrent(stoppedContext), false);
  assert.equal(direct.isCompletionNotificationContextCurrent(context), false);
  assert.equal(direct.registerCompletionNotification({
    messageId: 9611,
    chatId: "123",
    sessionId: "sess-native-route",
    notificationContext: context,
  }), false);

  polling = true;
  generation = 12;
  assert.equal(direct.isCompletionNotificationContextCurrent(context), false);
});

test("direct send rejects context-free mappings when a native route is bound", () => {
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getRouteGeneration: () => 12,
  });

  assert.equal(direct.registerCompletionNotification({
    messageId: 96115,
    chatId: "123",
    sessionId: "sess-context-required",
  }), false);

  const incompleteContext = direct.createCompletionNotificationContext({
    id: "sess-context-required",
  });
  delete incompleteContext.routeGeneration;
  assert.equal(direct.registerCompletionNotification({
    messageId: 96116,
    chatId: "123",
    sessionId: "sess-context-required",
    notificationContext: incompleteContext,
  }), false);
  assert.equal(direct._mappings.size, 0);
});

test("direct send does not reuse a completion mapping after native polling restarts", async () => {
  let routeGeneration = 21;
  const target = localTerminalEntry({ id: "sess-restarted-route", agentPid: 2111 });
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getRouteGeneration: () => routeGeneration,
    getSessionSnapshot: () => ({ sessions: [target] }),
    focusSession: () => { throw new Error("stale mapping must not focus"); },
    osPlatform: "win32",
  });

  const context = direct.createCompletionNotificationContext({ id: target.id });
  assert.equal(direct.registerCompletionNotification({
    messageId: 9612,
    chatId: "123",
    sessionId: target.id,
    notificationContext: context,
  }), true);

  // The native runner increments its route generation on every stop/start,
  // even when the bot token and recipient remain unchanged.
  routeGeneration = 22;
  const result = await direct.handleTextMessage({
    text: "must not target the restarted route",
    replyToMessageId: 9612,
    chatId: "123",
  });
  assert.equal(result.status, "unmapped");
  assert.equal(direct._mappings.size, 0);
});

test("direct send captures the terminal identity when the completion is observed", async () => {
  const original = localTerminalEntry({ id: "sess-captured-identity", agentPid: 2111 });
  let current = original;
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [current] }),
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async () => ({ status: "sent_with_enter", delivered: true, autoEnter: true }),
    },
    osPlatform: "win32",
  });

  const context = direct.createCompletionNotificationContext({ id: original.id });
  // Simulate the Telegram send completing after the session id was reused by
  // a new agent process. Registration must retain the identity from the
  // completion snapshot, rather than the later callback arguments.
  current = { ...original, agentPid: 3222 };
  assert.equal(direct.registerCompletionNotification({
    messageId: 9613,
    chatId: "123",
    sessionId: original.id,
    agentPid: current.agentPid,
    notificationContext: context,
  }), true);

  const result = await direct.handleTextMessage({
    text: "must not target the reused process",
    replyToMessageId: 9613,
    chatId: "123",
  });
  assert.equal(result.status, "session_changed");
  assert.equal(direct._deliveries.get(result.deliveryId).errorClass, "session_identity_changed");
});

test("direct send falls back when Console input lacks a PID captured at notification time", async () => {
  const original = localTerminalEntry({ id: "sess-missing-captured-pid", agentPid: null });
  let current = original;
  let deliveryCount = 0;
  const copied = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [current] }),
    deliveryAdapter: {
      requiresFocus: false,
      requiresMappedAgentPid: true,
      deliver: async () => {
        deliveryCount += 1;
        return { status: "sent_with_enter", delivered: true, autoEnter: true };
      },
    },
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: { writeText: (value) => copied.push(value) },
    }),
    osPlatform: "win32",
  });

  const context = direct.createCompletionNotificationContext({ id: original.id });
  current = { ...original, agentPid: 3222 };
  assert.equal(direct.registerCompletionNotification({
    messageId: 9614,
    chatId: "123",
    sessionId: original.id,
    agentPid: current.agentPid,
    notificationContext: context,
  }), true);

  const result = await direct.handleTextMessage({
    text: "copy instead of targeting the later process",
    replyToMessageId: 9614,
    chatId: "123",
  });
  assert.equal(result.status, "fallback_copied");
  assert.equal(deliveryCount, 0);
  assert.deepEqual(copied, ["copy instead of targeting the later process"]);
});

test("direct send rejects an in-flight Console write after route invalidation", async () => {
  const target = localTerminalEntry({ id: "sess-route-race", agentPid: 2111 });
  let fallbackCount = 0;
  let direct;
  direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target] }),
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async (payload) => {
        direct.invalidateMappings();
        const validation = await payload.validateBeforeInput();
        return { status: "failed", delivered: false, errorClass: validation.errorClass };
      },
    },
    fallbackAdapter: {
      copy: async () => {
        fallbackCount += 1;
        return { status: "fallback_copied", delivered: false };
      },
    },
    osPlatform: "win32",
  });

  const context = direct.createCompletionNotificationContext({ id: target.id });
  direct.registerCompletionNotification({
    messageId: 962,
    chatId: "123",
    sessionId: target.id,
    notificationContext: context,
  });
  const result = await direct.handleTextMessage({
    text: "continue",
    replyToMessageId: 962,
    chatId: "123",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.deliveryResult.errorClass, "direct_send_disabled");
  assert.equal(fallbackCount, 0);
});

test("direct send suppresses a success returned after adapter route invalidation", async () => {
  const target = localTerminalEntry({ id: "sess-route-return-race", agentPid: 2111 });
  let releaseDelivery;
  let deliveryStarted;
  const started = new Promise((resolve) => { deliveryStarted = resolve; });
  let direct;
  direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target] }),
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async (payload) => {
        assert.equal(payload.validateBeforeInput().ok, true);
        deliveryStarted();
        await new Promise((resolve) => { releaseDelivery = resolve; });
        return { status: "sent_with_enter", delivered: true, autoEnter: true };
      },
    },
    fallbackAdapter: {
      copy: async () => ({ status: "fallback_copied", delivered: false }),
    },
    osPlatform: "win32",
  });

  const context = direct.createCompletionNotificationContext({ id: target.id });
  assert.equal(direct.registerCompletionNotification({
    messageId: 9621,
    chatId: "123",
    sessionId: target.id,
    notificationContext: context,
  }), true);

  const delivery = direct.handleTextMessage({
    text: "continue",
    replyToMessageId: 9621,
    chatId: "123",
  });
  await started;
  direct.invalidateMappings();
  releaseDelivery();

  const result = await delivery;
  const record = direct._deliveries.get(result.deliveryId);
  assert.equal(result.status, "disabled");
  assert.equal(result.deliveryResult.status, "failed");
  assert.equal(result.deliveryResult.errorClass, "direct_send_disabled");
  assert.equal(record.status, "disabled");
  assert.equal(record.errorClass, "direct_send_disabled");
  assert.equal(direct._mappings.size, 0);
});

test("direct send does not report a stale asynchronous fallback as copied", async () => {
  let releaseFallback;
  let fallbackStarted;
  const started = new Promise((resolve) => { fallbackStarted = resolve; });
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [] }),
    fallbackAdapter: {
      copy: async () => {
        fallbackStarted();
        return new Promise((resolve) => { releaseFallback = resolve; });
      },
    },
    osPlatform: "win32",
  });
  const context = direct.createCompletionNotificationContext({ id: "sess-stale-fallback" });
  direct.registerCompletionNotification({
    messageId: 965,
    chatId: "123",
    sessionId: "sess-stale-fallback",
    notificationContext: context,
  });

  const delivery = direct.handleTextMessage({
    text: "manual copy",
    replyToMessageId: 965,
    chatId: "123",
  });
  await started;
  direct.invalidateMappings();
  releaseFallback({ status: "fallback_copied", delivered: false });

  const result = await delivery;
  const record = direct._deliveries.get(result.deliveryId);
  assert.equal(result.status, "session_not_live");
  assert.equal(record.status, "disabled");
  assert.equal(record.errorClass, "direct_send_disabled");
  assert.equal(record.fallbackUncertain, true);
  assert.equal(record.deliveryResult.status, "fallback_copied");
});

test("direct send marks an aborted asynchronous fallback as cancelled", async () => {
  let releaseFallback;
  let fallbackStarted;
  const started = new Promise((resolve) => { fallbackStarted = resolve; });
  const controller = new AbortController();
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [] }),
    fallbackAdapter: {
      copy: async () => {
        fallbackStarted();
        return new Promise((resolve) => { releaseFallback = resolve; });
      },
    },
    osPlatform: "win32",
  });
  direct.registerCompletionNotification({
    messageId: 966,
    chatId: "123",
    sessionId: "sess-aborted-fallback",
  });

  const delivery = direct.handleTextMessage({
    text: "manual copy",
    replyToMessageId: 966,
    chatId: "123",
    signal: controller.signal,
  });
  await started;
  controller.abort();
  releaseFallback({ status: "fallback_copied", delivered: false });

  const result = await delivery;
  const record = direct._deliveries.get(result.deliveryId);
  assert.equal(result.status, "session_not_live");
  assert.equal(record.status, "cancelled");
  assert.equal(record.errorClass, "direct_send_cancelled");
  assert.equal(record.fallbackUncertain, true);
});

test("direct send retires every older notification for a submitted session", async () => {
  const target = localTerminalEntry({ id: "sess-watermark", agentPid: 2111 });
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target] }),
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async () => ({ status: "sent_with_enter", delivered: true, autoEnter: true }),
    },
    osPlatform: "win32",
  });

  const firstContext = direct.createCompletionNotificationContext({ id: target.id });
  const secondContext = direct.createCompletionNotificationContext({ id: target.id });
  const delayedContext = direct.createCompletionNotificationContext({ id: target.id });
  direct.registerCompletionNotification({
    messageId: 963,
    chatId: "123",
    sessionId: target.id,
    notificationContext: firstContext,
  });
  direct.registerCompletionNotification({
    messageId: 964,
    chatId: "123",
    sessionId: target.id,
    notificationContext: secondContext,
  });

  const sent = await direct.handleTextMessage({ text: "first", replyToMessageId: 963, chatId: "123" });
  const replay = await direct.handleTextMessage({ text: "second", replyToMessageId: 964, chatId: "123" });
  const delayedRegistered = direct.registerCompletionNotification({
    messageId: 965,
    chatId: "123",
    sessionId: target.id,
    notificationContext: delayedContext,
  });
  const freshContext = direct.createCompletionNotificationContext({ id: target.id });
  const freshRegistered = direct.registerCompletionNotification({
    messageId: 966,
    chatId: "123",
    sessionId: target.id,
    notificationContext: freshContext,
  });

  assert.equal(sent.status, "sent_with_enter");
  assert.equal(replay.status, "unmapped");
  assert.equal(delayedRegistered, false);
  assert.equal(freshRegistered, true);
});

test("direct send preserves a completion created after Console input before its result returns", async () => {
  const target = localTerminalEntry({ id: "sess-fast-completion", agentPid: 2111 });
  let deliveryCount = 0;
  let signalInputWritten;
  let releaseFirstDelivery;
  const inputWritten = new Promise((resolve) => { signalInputWritten = resolve; });
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target] }),
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async (payload) => {
        deliveryCount += 1;
        const validation = await payload.validateBeforeInput();
        assert.equal(validation.ok, true);
        if (deliveryCount === 1) {
          signalInputWritten();
          await new Promise((resolve) => { releaseFirstDelivery = resolve; });
        }
        return { status: "sent_with_enter", delivered: true, autoEnter: true };
      },
    },
    osPlatform: "win32",
  });

  const initialContext = direct.createCompletionNotificationContext({ id: target.id });
  direct.registerCompletionNotification({
    messageId: 969,
    chatId: "123",
    sessionId: target.id,
    notificationContext: initialContext,
  });

  const firstDelivery = direct.handleTextMessage({
    text: "first",
    replyToMessageId: 969,
    chatId: "123",
  });
  await inputWritten;

  const freshContext = direct.createCompletionNotificationContext({ id: target.id });
  assert.equal(direct.registerCompletionNotification({
    messageId: 970,
    chatId: "123",
    sessionId: target.id,
    notificationContext: freshContext,
  }), true);

  releaseFirstDelivery();
  assert.equal((await firstDelivery).status, "sent_with_enter");
  assert.equal(direct._mappings.size, 1);

  const secondDelivery = await direct.handleTextMessage({
    text: "second",
    replyToMessageId: 970,
    chatId: "123",
  });
  assert.equal(secondDelivery.status, "sent_with_enter");
  assert.equal(deliveryCount, 2);
});

test("direct send falls back when two visible sessions share one agent PID", async () => {
  const target = localTerminalEntry({ id: "sess-shared-a", sourcePid: 1111, agentPid: 2111 });
  const peer = localTerminalEntry({ id: "sess-shared-b", sourcePid: 1222, agentPid: 2111 });
  let deliveryCount = 0;
  const copied = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target, peer] }),
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async () => {
        deliveryCount += 1;
        return { status: "sent_with_enter", delivered: true };
      },
    },
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: { writeText: (value) => copied.push(value) },
    }),
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({
    messageId: 967,
    chatId: "123",
    sessionId: target.id,
    agentPid: target.agentPid,
  });
  const result = await direct.handleTextMessage({
    text: "manual only",
    replyToMessageId: 967,
    chatId: "123",
  });

  assert.equal(result.status, "fallback_copied");
  assert.equal(deliveryCount, 0);
  assert.deepEqual(copied, ["manual only"]);
});

test("direct send rejects an Orca pane identity change after focus", async () => {
  let current = localTerminalEntry({ id: "sess-orca-change", orcaPaneKey: "window:old" });
  let deliveryCount = 0;
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [current] }),
    focusSession: () => {
      current = { ...current, orcaPaneKey: "window:new" };
      return confirmedFocusResult({ orcaPane: { ok: true, match: "exact", reason: "exact" } });
    },
    deliveryAdapter: {
      deliver: async () => {
        deliveryCount += 1;
        return { status: "pasted_without_enter", delivered: true };
      },
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 968, sessionId: current.id });
  const result = await direct.handleTextMessage({ text: "continue", replyToMessageId: 968 });

  assert.equal(result.status, "session_changed");
  assert.equal(deliveryCount, 0);
});

test("direct send rejects a reused session id when the notification terminal changed", async () => {
  const current = localTerminalEntry({ sourcePid: 9999, agentPid: 2999 });
  const deliveries = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [current] }),
    focusSession: () => { throw new Error("must not focus"); },
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async (payload) => deliveries.push(payload),
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({
    messageId: 951,
    sessionId: current.id,
    sourcePid: 1234,
  });
  const result = await direct.handleTextMessage({ text: "continue", replyToMessageId: 951 });

  assert.equal(result.status, "session_changed");
  assert.deepEqual(deliveries, []);
});

test("direct send rejects a reused session when only the agent process changed", async () => {
  const current = localTerminalEntry({ sourcePid: 1234, agentPid: 2999 });
  const deliveries = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [current] }),
    focusSession: () => { throw new Error("must not focus"); },
    deliveryAdapter: {
      requiresFocus: false,
      deliver: async (payload) => deliveries.push(payload),
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({
    messageId: 952,
    sessionId: current.id,
    sourcePid: current.sourcePid,
    agentPid: 2111,
  });
  const result = await direct.handleTextMessage({ text: "continue", replyToMessageId: 952 });

  assert.equal(result.status, "session_changed");
  assert.deepEqual(deliveries, []);
});

test("direct send rejects a reused session when mapped UI identity changes", async () => {
  const identityFields = [
    ["rawSessionId", "raw-session:new"],
    ["agentId", "codex"],
    ["editor", "cursor"],
    ["wtHwnd", "12346"],
    ["orcaPaneKey", "window:new-pane"],
    ["codexOriginator", "codex_work_desktop"],
  ];

  for (let index = 0; index < identityFields.length; index += 1) {
    const [field, replacement] = identityFields[index];
    const messageId = 980 + index;
    const original = localTerminalEntry({
      id: `sess-ui-${field}`,
      rawSessionId: "raw-session:old",
      agentId: "claude-code",
      sourcePid: 1234,
      agentPid: 2111,
      editor: "code",
      wtHwnd: "12345",
      orcaPaneKey: "window:old-pane",
      codexOriginator: "codex-tui",
    });
    let current = original;
    const deliveries = [];
    const direct = createTelegramDirectSend({
      isEnabled: () => true,
      getSessionSnapshot: () => ({ sessions: [current] }),
      deliveryAdapter: {
        requiresFocus: false,
        deliver: async (payload) => {
          deliveries.push(payload);
          return { status: "sent_with_enter", delivered: true, autoEnter: true };
        },
      },
      osPlatform: "win32",
    });

    direct.registerCompletionNotification({
      messageId,
      chatId: "123",
      sessionId: original.id,
      rawSessionId: original.rawSessionId,
      agentId: original.agentId,
      sourcePid: original.sourcePid,
      agentPid: original.agentPid,
      editor: original.editor,
      wtHwnd: original.wtHwnd,
      orcaPaneKey: original.orcaPaneKey,
      codexOriginator: original.codexOriginator,
    });
    current = { ...original, [field]: replacement };

    const result = await direct.handleTextMessage({
      text: "must stay on the original terminal",
      replyToMessageId: messageId,
      chatId: "123",
    });
    assert.equal(result.status, "session_changed", field);
    assert.deepEqual(deliveries, [], field);
  }
});

test("direct send routes Codex Desktop replies through a focusless queue adapter", async () => {
  const threadId = "019e115a-4df2-7ed0-b90e-8e6345aca777";
  const desktop = localTerminalEntry({
    id: `codex:${threadId}`,
    rawSessionId: `codex:${threadId}`,
    agentId: "codex",
    codexOriginator: "codex_work_desktop",
    sourcePid: null,
    agentPid: 14220,
  });
  const focused = [];
  const delivered = [];
  const consoleAdapter = {
    deliver: async () => {
      throw new Error("Desktop replies must not use Console input");
    },
  };
  const queueAdapter = {
    requiresFocus: false,
    requiresFocusableTarget: false,
    requiresMappedAgentPid: false,
    requiresPidDisambiguation: false,
    canDeliver: (entry) => entry && entry.codexOriginator === "codex_work_desktop",
    deliver: async (payload) => {
      delivered.push({ sessionId: payload.sessionId, promptText: payload.promptText });
      return { status: "queued", delivered: true, autoEnter: true };
    },
  };
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [desktop] }),
    focusSession: (sessionId) => {
      focused.push(sessionId);
      return confirmedFocusResult();
    },
    deliveryAdapter: consoleAdapter,
    getDeliveryAdapter: ({ entry }) => entry.agentId === "codex" ? queueAdapter : consoleAdapter,
    osPlatform: "win32",
  });

  assert.equal(direct.registerCompletionNotification({
    messageId: 9971,
    sessionId: desktop.id,
    agentId: desktop.agentId,
    agentPid: desktop.agentPid,
  }), true);
  const result = await direct.handleTextMessage({
    text: "Please continue from Telegram",
    replyToMessageId: 9971,
  });

  assert.equal(result.status, "queued");
  assert.equal(result.deliveryResult.status, "queued");
  assert.match(result.text, /Codex session/);
  assert.deepEqual(focused, []);
  assert.deepEqual(delivered, [{
    sessionId: desktop.id,
    promptText: "Please continue from Telegram",
  }]);
});

test("direct send does not apply Console PID ambiguity to Codex Desktop queue sessions", async () => {
  const threadId = "019e115a-4df2-7ed0-b90e-8e6345aca777";
  const target = localTerminalEntry({
    id: `codex:${threadId}`,
    rawSessionId: `codex:${threadId}`,
    agentId: "codex",
    codexOriginator: "Codex Desktop",
    sourcePid: 14220,
    agentPid: 14220,
  });
  const peer = localTerminalEntry({
    id: "codex:019e115b-4df2-7ed0-b90e-8e6345aca777",
    rawSessionId: "codex:019e115b-4df2-7ed0-b90e-8e6345aca777",
    agentId: "codex",
    codexOriginator: "codex_work_desktop",
    sourcePid: 14220,
    agentPid: 14220,
  });
  let calls = 0;
  const queueAdapter = {
    requiresFocus: false,
    requiresFocusableTarget: false,
    requiresPidDisambiguation: false,
    canDeliver: () => true,
    deliver: async () => {
      calls += 1;
      return { status: "queued", delivered: true };
    },
  };
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target, peer] }),
    deliveryAdapter: queueAdapter,
    osPlatform: "win32",
  });
  assert.equal(direct.registerCompletionNotification({
    messageId: 9972,
    sessionId: target.id,
    agentId: target.agentId,
    agentPid: target.agentPid,
  }), true);
  const result = await direct.handleTextMessage({ text: "same app-server", replyToMessageId: 9972 });
  assert.equal(result.status, "queued");
  assert.equal(calls, 1);
});

test("direct send copies replies when an unknown Codex originator selects the queue guard", async () => {
  const target = localTerminalEntry({
    id: "codex:019e115c-4df2-7ed0-b90e-8e6345aca777",
    rawSessionId: "codex:019e115c-4df2-7ed0-b90e-8e6345aca777",
    agentId: "codex",
    codexOriginator: "future-unknown-client",
    sourcePid: 14220,
    agentPid: 14220,
  });
  let consoleCalls = 0;
  let queueCalls = 0;
  const copied = [];
  const consoleAdapter = {
    requiresFocus: false,
    deliver: async () => {
      consoleCalls += 1;
      return { status: "sent_with_enter", delivered: true };
    },
  };
  const queueGuardAdapter = {
    requiresFocus: false,
    requiresFocusableTarget: false,
    requiresMappedAgentPid: false,
    requiresPidDisambiguation: false,
    canDeliver: () => false,
    deliver: async () => {
      queueCalls += 1;
      return { status: "queued", delivered: true };
    },
  };
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [target] }),
    deliveryAdapter: consoleAdapter,
    getDeliveryAdapter: () => queueGuardAdapter,
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({
      clipboard: { writeText: (value) => copied.push(value) },
    }),
    osPlatform: "win32",
  });
  const context = direct.createCompletionNotificationContext(target);
  assert.equal(direct.registerCompletionNotification({
    messageId: 9973,
    chatId: "123",
    sessionId: target.id,
    notificationContext: context,
  }), true);

  const result = await direct.handleTextMessage({
    text: "keep this out of the shared app-server Console",
    replyToMessageId: 9973,
    chatId: "123",
  });

  assert.equal(result.status, "fallback_copied");
  assert.equal(consoleCalls, 0);
  assert.equal(queueCalls, 0);
  assert.deepEqual(copied, ["keep this out of the shared app-server Console"]);
});
