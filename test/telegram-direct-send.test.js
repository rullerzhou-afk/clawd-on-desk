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

test("normalizePromptText keeps newlines but removes control characters", () => {
  assert.equal(normalizePromptText("  hi\r\nthere\u0007  "), "hi\nthere");
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
