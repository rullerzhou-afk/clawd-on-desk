"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
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
  assert.match(res.text, /Reply to a Clawd completion notification/);
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

test("direct send does not treat passive notify or hardware test entries as pending permissions", async () => {
  const focused = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    getPendingPermissions: () => [
      { sessionId: "sess-local-1", isCodexNotify: true },
      { sessionId: "sess-local-1", isKimiNotify: true },
      { sessionId: "sess-local-1", isHardwareBuddyTest: true },
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
      return { status: "pasted_without_enter", delivered: true, autoEnter: false };
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
  assert.match(res.text, /No text was pasted/);
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

test("normalizePromptText keeps newlines but removes control characters", () => {
  assert.equal(normalizePromptText("  hi\r\nthere\u0007  "), "hi\nthere");
});
