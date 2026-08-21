"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createTelegramNativeRunner } = require("../src/telegram-native-runner");
const { renderTelegramMarkdown } = require("../src/telegram-message-format");
const { EVENTS } = require("../src/telegram-migration-state");
const { createRemoteCardWorkRegistry } = require("../src/session-automation-remote");
const { createFakeTelegramServer } = require("./fakes/telegram-server");

const VALID_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_jklmnop";

function tokenStore(token = VALID_TOKEN) {
  return {
    async getToken() { return token; },
    async hasToken() { return !!token; },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("sendTestCard defers TEST_FAILED when Telegram sendMessage fails", async () => {
  const server = createFakeTelegramServer();
  const events = [];
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async (event) => { events.push(event); },
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });
  server.enqueueError("sendMessage", { status: 401, description: "Unauthorized" });

  await runner.sendTestCard();
  assert.deepEqual(events, [], "failure is deferred until caller can enter TESTING_NATIVE");

  await delay(5);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENTS.TEST_FAILED);
  assert.equal(events[0].errorClass, "401");
});

test("sendTestCard defers TEST_FAILED when chat id is missing", async () => {
  const events = [];
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: createFakeTelegramServer().transport,
    getDispatch: () => async (event) => { events.push(event); },
    getChatId: () => "",
    getAllowedUserId: () => "777",
  });

  await runner.sendTestCard();
  assert.deepEqual(events, []);
  await delay(5);
  assert.deepEqual(events, [{ type: EVENTS.TEST_FAILED, errorClass: "no_chat" }]);
});

test("native runner sends nonce card and dispatches TEST_SUCCESS for matching callback", async () => {
  const server = createFakeTelegramServer();
  const events = [];
  let runner;
  let releaseFirstPoll;
  let callbackData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    callbackData = payload.reply_markup.inline_keyboard[0][0].callback_data;
    return { ok: true, result: { message_id: 42, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      callback_query: {
        id: "cb-1",
        from: { id: 777 },
        message: { chat: { id: 123 } },
        data: callbackData,
      },
    }],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageReplyMarkup", { message_id: 42 });

  runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async (event) => {
      events.push(event);
      await runner.stop();
    },
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  assert.equal(server.calls[0].method, "getUpdates");

  await runner.sendTestCard();
  assert.match(callbackData, /^clawd-test:[a-z0-9]+$/);

  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();
  await tick();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENTS.TEST_SUCCESS);
  assert.equal(server.calls.some((call) => call.method === "answerCallbackQuery"), true);
  assert.equal(server.calls.some((call) => call.method === "editMessageReplyMarkup"), true);
  assert.equal(runner.isPolling(), false);
});

test("native runner processes a matching test callback returned by the initial poll", async () => {
  const server = createFakeTelegramServer();
  const events = [];
  let runner;
  let releaseFirstPoll;
  let callbackData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    callbackData = payload.reply_markup.inline_keyboard[0][0].callback_data;
    return { ok: true, result: { message_id: 43, chat: { id: 123 } } };
  });
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageReplyMarkup", { message_id: 43 });

  runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async (event) => {
      events.push(event);
      await runner.stop();
    },
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  try {
    await runner.start();
    await tick();
    assert.equal(server.calls.filter((call) => call.method === "getUpdates").length, 1);

    await runner.sendTestCard();
    assert.match(callbackData, /^clawd-test:[a-z0-9]+$/);

    releaseFirstPoll({
      ok: true,
      result: [{
        update_id: 1,
        callback_query: {
          id: "cb-initial-poll",
          from: { id: 777 },
          message: { message_id: 43, chat: { id: 123 } },
          data: callbackData,
        },
      }],
    });
    await tick();
    await tick();

    assert.deepEqual(events.map((event) => event.type), [EVENTS.TEST_SUCCESS]);
    assert.equal(server.calls.some((call) => call.method === "answerCallbackQuery"), true);
    assert.equal(server.calls.some((call) => call.method === "editMessageReplyMarkup"), true);
    assert.equal(
      server.calls.filter((call) => call.method === "getUpdates").length,
      1,
      "the callback must be handled from the initial response without a second poll",
    );
    assert.equal(runner.isPolling(), false);
  } finally {
    await runner.stop();
  }
});

test("native runner requestApproval resolves allow for matching callback", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let allowData = "";
  let denyData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    assert.match(payload.text, /claude-code requests Bash/);
    assert.match(payload.text, /Summary: Run tests/);
    assert.equal(payload.parse_mode, "HTML");
    const allCallbackData = payload.reply_markup.inline_keyboard
      .flatMap((row) => row)
      .map((button) => button.callback_data);
    assert.equal(
      allCallbackData.some((value) => typeof value === "string" && value.startsWith("ct:")),
      false,
      "the initial card must not expose session trust without the explicit capability"
    );
    allowData = payload.reply_markup.inline_keyboard[0][0].callback_data;
    denyData = payload.reply_markup.inline_keyboard[0][1].callback_data;
    return { ok: true, result: { message_id: 99, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      callback_query: {
        id: "cb-allow",
        from: { id: 777 },
        message: { message_id: 99, chat: { id: 123 } },
        data: allowData,
      },
    }],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 99 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
  });
  await tick();
  assert.match(allowData, /^cp:[a-z0-9]+:a$/);
  assert.match(denyData, /^cp:[a-z0-9]+:d$/);

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  assert.deepEqual(decision, { action: "allow" });
  // The toast and the card rewrite are fire-and-forget now; let them land.
  await tick();
  assert.equal(server.calls.some((call) => call.method === "answerCallbackQuery"), true);
  const allowEdit = server.calls.find((call) => call.method === "editMessageText");
  assert.ok(allowEdit, "tapping Allow rewrites the card body with the outcome");
  assert.equal(
    allowEdit.payload.text,
    "<b>claude-code requests Bash</b>\n\nSummary: Run tests\n\n<b>\u2705 Allowed</b>",
  );
  assert.equal(allowEdit.payload.parse_mode, "HTML");
  assert.equal(allowEdit.payload.reply_markup, undefined);
  await runner.stop();
});

test("native runner session trust uses two-step confirmation and keeps a persistent revoke button", async () => {
  const calls = [];
  let releaseFirstPoll;
  let releaseRevokePoll;
  let trustOpenData = "";
  let grantId = "grant-telegram-1";
  let runner;
  let pollCount = 0;
  const routeChangeGrantIds = [];
  const transport = async ({ method, payload, signal }) => {
    calls.push({ method, payload, signal });
    if (method === "sendMessage") {
      const trustRow = payload.reply_markup.inline_keyboard.at(-1);
      trustOpenData = trustRow[0].callback_data;
      return { ok: true, result: { message_id: 501, chat: { id: 123 } } };
    }
    if (method === "getUpdates") {
      pollCount += 1;
      if (pollCount === 1) {
        return new Promise((resolve) => { releaseFirstPoll = resolve; });
      }
      if (pollCount === 2) {
        const id = trustOpenData.match(/^ct:([a-z0-9]+):open$/)[1];
        return {
          ok: true,
          result: [
            {
              update_id: 1,
              callback_query: {
                id: "trust-open",
                from: { id: 777 },
                message: { message_id: 501, chat: { id: 123 } },
                data: trustOpenData,
              },
            },
            {
              update_id: 2,
              callback_query: {
                id: "trust-confirm",
                from: { id: 777 },
                message: { message_id: 501, chat: { id: 123 } },
                data: `ct:${id}:yes`,
              },
            },
          ],
        };
      }
      if (pollCount === 3) {
        return new Promise((resolve) => { releaseRevokePoll = resolve; });
      }
      return new Promise(() => {});
    }
    return { ok: true, result: method === "editMessageText" ? { message_id: 501 } : true };
  };

  runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    onSessionGrantRevoke: (clickedGrantId) => {
      assert.equal(clickedGrantId, grantId);
      runner.handleSessionAutomationChanges([{
        previous: { grantId },
        next: { grantId: "replacement-off", mode: "off" },
        reason: "remote-revoke",
      }]);
      return { status: "applied" };
    },
    onSessionAutomationRouteChange: (client) => {
      routeChangeGrantIds.push([...client.listActiveSessionAutomationGrantIds()]);
    },
  });
  runner.syncSessionAutomationRoute({
    enabled: true,
    allowedUserId: "777",
    chatId: "123",
    tokenRevision: 1,
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
    canOfferSessionTrust: true,
  });
  await tick();
  assert.match(trustOpenData, /^ct:[a-z0-9]+:open$/);
  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  assert.equal(decision.action, "session-trust");
  assert.ok(decision.cardHandle);

  const cardWork = runner.beginSessionTrustCandidate({
    grantId,
    cardHandle: decision.cardHandle,
  });
  assert.ok(cardWork);
  assert.equal(await runner.prepareSessionTrustCandidate(cardWork, { grantId }), true);
  assert.equal(runner.activateSessionTrustCandidate(cardWork, { grantId }), true);
  assert.equal(await runner.renderActiveSessionTrust(cardWork, {
    grantId,
    outcome: "activated",
  }), true);

  const editsBeforeRevoke = calls.filter((call) => call.method === "editMessageText");
  assert.equal(
    editsBeforeRevoke.every((call) => call.signal && typeof call.signal.aborted === "boolean"),
    true,
    "every session-trust edit must carry a cancellable deadline signal"
  );
  assert.match(editsBeforeRevoke[0].payload.text, /Confirm:/);
  const preparing = editsBeforeRevoke.find((call) => /Enabling session trust/.test(call.payload.text));
  assert.ok(preparing, "preparing edit must succeed before activation");
  assert.equal(
    preparing.payload.reply_markup.inline_keyboard[0][0].callback_data,
    `session-grant:revoke:${grantId}`,
  );
  const active = editsBeforeRevoke.find((call) => /Session trust is active/.test(call.payload.text));
  assert.ok(active);
  assert.equal(
    active.payload.reply_markup.inline_keyboard[0][0].callback_data,
    `session-grant:revoke:${grantId}`,
  );
  runner.syncSessionAutomationRoute({
    enabled: true,
    allowedUserId: "888",
    chatId: "123",
    tokenRevision: 1,
  });
  assert.deepEqual(
    routeChangeGrantIds,
    [[grantId]],
    "route-changing notification must enumerate the exact active grant before client state is lost"
  );

  releaseRevokePoll({
    ok: true,
    result: [{
      update_id: 3,
      callback_query: {
        id: "trust-revoke",
        from: { id: 777 },
        message: { message_id: 501, chat: { id: 123 } },
        data: `session-grant:revoke:${grantId}`,
      },
    }],
  });
  await tick();
  await tick();
  const terminal = calls
    .filter((call) => call.method === "editMessageText")
    .find((call) => /Session trust was revoked/.test(call.payload.text));
  assert.ok(terminal);
  assert.equal(terminal.payload.reply_markup, undefined);
  await runner.stop();
});

test("native runner keeps one-time approval usable when the session card-work cap is full", async () => {
  const registry = createRemoteCardWorkRegistry({ limit: 1 });
  assert.ok(registry.reserve("occupied", { messageId: 900 }));
  const calls = [];
  let releaseFirstPoll;
  let trustOpenData = "";
  let pollCount = 0;
  const transport = async ({ method, payload }) => {
    calls.push({ method, payload });
    if (method === "sendMessage") {
      trustOpenData = payload.reply_markup.inline_keyboard.at(-1)[0].callback_data;
      return { ok: true, result: { message_id: 502, chat: { id: 123 } } };
    }
    if (method === "getUpdates") {
      pollCount += 1;
      if (pollCount === 1) {
        return new Promise((resolve) => { releaseFirstPoll = resolve; });
      }
      if (pollCount === 2) {
        const id = trustOpenData.match(/^ct:([a-z0-9]+):open$/)[1];
        const message = { message_id: 502, chat: { id: 123 } };
        const from = { id: 777 };
        return {
          ok: true,
          result: [
            {
              update_id: 1,
              callback_query: {
                id: "cap-open",
                from,
                message,
                data: trustOpenData,
              },
            },
            {
              update_id: 2,
              callback_query: {
                id: "cap-confirm",
                from,
                message,
                data: `ct:${id}:yes`,
              },
            },
            {
              update_id: 3,
              callback_query: {
                id: "cap-allow",
                from,
                message,
                data: `cp:${id}:a`,
              },
            },
          ],
        };
      }
      return new Promise(() => {});
    }
    return { ok: true, result: method === "editMessageText" ? { message_id: 502 } : true };
  };
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    onSessionGrantRevoke: () => ({ status: "stale" }),
    sessionAutomationCardWorkRegistry: registry,
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
    canOfferSessionTrust: true,
  });
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  assert.deepEqual(await decisionPromise, { action: "allow" });
  const fallback = calls
    .filter((call) => call.method === "editMessageText")
    .find((call) => (
      call.payload.reply_markup
      && call.payload.reply_markup.inline_keyboard[0][0].callback_data.startsWith("cp:")
    ));
  assert.ok(fallback, "the original one-time Allow/Deny controls must be restored");
  assert.equal(registry.size(), 1, "the failed trust attempt must not consume another slot");
  await runner.stop();
});

test("native runner releases an issued session-trust handle that main never consumes", async () => {
  const registry = createRemoteCardWorkRegistry({ limit: 1 });
  const calls = [];
  let releaseFirstPoll;
  let trustOpenData = "";
  let pollCount = 0;
  const transport = async ({ method, payload, signal }) => {
    calls.push({ method, payload, signal });
    if (method === "sendMessage") {
      trustOpenData = payload.reply_markup.inline_keyboard.at(-1)[0].callback_data;
      return { ok: true, result: { message_id: 504, chat: { id: 123 } } };
    }
    if (method === "getUpdates") {
      pollCount += 1;
      if (pollCount === 1) {
        return new Promise((resolve) => { releaseFirstPoll = resolve; });
      }
      if (pollCount === 2) {
        const id = trustOpenData.match(/^ct:([a-z0-9]+):open$/)[1];
        const message = { message_id: 504, chat: { id: 123 } };
        const from = { id: 777 };
        return {
          ok: true,
          result: [
            {
              update_id: 1,
              callback_query: {
                id: "unused-open",
                from,
                message,
                data: trustOpenData,
              },
            },
            {
              update_id: 2,
              callback_query: {
                id: "unused-confirm",
                from,
                message,
                data: `ct:${id}:yes`,
              },
            },
          ],
        };
      }
      return new Promise(() => {});
    }
    return { ok: true, result: method === "editMessageText" ? { message_id: 504 } : true };
  };
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    onSessionGrantRevoke: () => ({ status: "stale" }),
    sessionAutomationCardWorkRegistry: registry,
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
    canOfferSessionTrust: true,
  });
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;

  assert.equal(registry.size(), 1);
  assert.equal(runner.discardSessionTrustCardHandle(decision.cardHandle, {
    reason: "permission-resolved",
  }), true);
  await tick();
  assert.equal(registry.size(), 0);
  const terminal = calls
    .filter((call) => call.method === "editMessageText")
    .find((call) => /handled elsewhere/i.test(call.payload.text));
  assert.ok(terminal);
  assert.equal(runner.discardSessionTrustCardHandle(decision.cardHandle), false);
  await runner.stop();
});

test("native runner rejects an issued session-trust handle after its route changes", async () => {
  const registry = createRemoteCardWorkRegistry({ limit: 1 });
  const edits = [];
  let releaseFirstPoll;
  let trustOpenData = "";
  let pollCount = 0;
  const transport = async ({ method, payload }) => {
    if (method === "sendMessage") {
      trustOpenData = payload.reply_markup.inline_keyboard.at(-1)[0].callback_data;
      return { ok: true, result: { message_id: 505, chat: { id: 123 } } };
    }
    if (method === "getUpdates") {
      pollCount += 1;
      if (pollCount === 1) {
        return new Promise((resolve) => { releaseFirstPoll = resolve; });
      }
      if (pollCount === 2) {
        const id = trustOpenData.match(/^ct:([a-z0-9]+):open$/)[1];
        const message = { message_id: 505, chat: { id: 123 } };
        const from = { id: 777 };
        return {
          ok: true,
          result: [
            {
              update_id: 1,
              callback_query: {
                id: "route-open",
                from,
                message,
                data: trustOpenData,
              },
            },
            {
              update_id: 2,
              callback_query: {
                id: "route-confirm",
                from,
                message,
                data: `ct:${id}:yes`,
              },
            },
          ],
        };
      }
      return new Promise(() => {});
    }
    if (method === "editMessageText") edits.push(payload);
    return { ok: true, result: method === "editMessageText" ? { message_id: 505 } : true };
  };
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    onSessionGrantRevoke: () => ({ status: "stale" }),
    onSessionAutomationRouteChange: () => {},
    sessionAutomationCardWorkRegistry: registry,
  });
  runner.syncSessionAutomationRoute({
    enabled: true,
    allowedUserId: "777",
    chatId: "123",
    tokenRevision: 1,
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
    canOfferSessionTrust: true,
  });
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;

  assert.equal(registry.size(), 1);
  runner.syncSessionAutomationRoute({
    enabled: true,
    allowedUserId: "888",
    chatId: "123",
    tokenRevision: 1,
  });
  assert.equal(runner.beginSessionTrustCandidate({
    grantId: "grant-after-route-change",
    cardHandle: decision.cardHandle,
  }), null);
  assert.equal(registry.size(), 1, "terminal cleanup owns the slot until its edit settles");
  await tick();
  await tick();
  assert.equal(registry.size(), 0);
  const terminal = edits.find((payload) => /not enabled/i.test(payload.text));
  assert.ok(terminal, "the consumed confirmation card must be terminalized");
  assert.strictEqual(terminal.reply_markup, undefined);
  assert.equal(runner.discardSessionTrustCardHandle(decision.cardHandle), false);
  await runner.stop();
});

test("native runner aborts a hung session-trust confirmation edit at its deadline", async () => {
  let releaseFirstPoll;
  let trustOpenData = "";
  let pollCount = 0;
  let editAborted = false;
  const calls = [];
  const transport = async ({ method, payload, signal }) => {
    calls.push({ method, payload, signal });
    if (method === "sendMessage") {
      trustOpenData = payload.reply_markup.inline_keyboard.at(-1)[0].callback_data;
      return { ok: true, result: { message_id: 503, chat: { id: 123 } } };
    }
    if (method === "getUpdates") {
      pollCount += 1;
      if (pollCount === 1) {
        return new Promise((resolve) => { releaseFirstPoll = resolve; });
      }
      if (pollCount === 2) {
        return {
          ok: true,
          result: [{
            update_id: 1,
            callback_query: {
              id: "hung-open",
              from: { id: 777 },
              message: { message_id: 503, chat: { id: 123 } },
              data: trustOpenData,
            },
          }],
        };
      }
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    }
    if (method === "editMessageText") {
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          editAborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    return { ok: true, result: true };
  };
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    sessionAutomationEditTimeoutMs: 5,
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
    canOfferSessionTrust: true,
  });
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  await delay(20);

  assert.equal(editAborted, true);
  assert.equal(runner._pendingApprovals.size, 1, "the ordinary approval remains pending");
  assert.equal(
    Array.from(runner._pendingApprovals.values())[0].trustConfirming,
    false,
    "failed confirmation edit must roll back the hidden trust-confirming state",
  );
  assert.equal(
    calls.some((call) => call.method === "answerCallbackQuery" && call.payload.text === "Unavailable"),
    true,
    "the user must receive existing unavailable feedback instead of losing the keyboard",
  );
  const confirmationEdit = calls.find((call) => call.method === "editMessageText");
  assert.equal(confirmationEdit.payload.parse_mode, "HTML");
  await runner.stop();
  assert.equal(await decisionPromise, null);
});

test("session-trust return failure keeps confirmation state and shows unavailable feedback", async () => {
  let releaseFirstPoll;
  let trustOpenData = "";
  let pollCount = 0;
  let editCount = 0;
  const calls = [];
  const transport = async ({ method, payload, signal }) => {
    calls.push({ method, payload, signal });
    if (method === "sendMessage") {
      trustOpenData = payload.reply_markup.inline_keyboard.at(-1)[0].callback_data;
      return { ok: true, result: { message_id: 504, chat: { id: 123 } } };
    }
    if (method === "getUpdates") {
      pollCount += 1;
      if (pollCount === 1) return new Promise((resolve) => { releaseFirstPoll = resolve; });
      if (pollCount === 2) {
        const id = trustOpenData.match(/^ct:([a-z0-9]+):open$/)[1];
        const message = { message_id: 504, chat: { id: 123 } };
        const from = { id: 777 };
        return {
          ok: true,
          result: [
            { update_id: 1, callback_query: { id: "return-open", from, message, data: trustOpenData } },
            { update_id: 2, callback_query: { id: "return-no", from, message, data: `ct:${id}:no` } },
          ],
        };
      }
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    if (method === "editMessageText") {
      editCount += 1;
      if (editCount === 2) {
        return { ok: false, status: 400, error_code: 400, description: "Bad Request: message can't be edited" };
      }
      return { ok: true, result: { message_id: 504 } };
    }
    return { ok: true, result: true };
  };
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
    canOfferSessionTrust: true,
  });
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();

  const entry = Array.from(runner._pendingApprovals.values())[0];
  assert.equal(entry.trustConfirming, true, "the visible confirmation card must remain the state truth");
  assert.equal(
    calls.some((call) => call.method === "answerCallbackQuery" && call.payload.text === "Unavailable"),
    true,
  );
  assert.equal(calls.some((call) => call.method === "editMessageReplyMarkup"), false);

  await runner.stop();
  assert.equal(await decisionPromise, null);
});

test("native runner does not send an approval card when allowedTgUserId is blank (fail-closed)", async () => {
  const server = createFakeTelegramServer();
  let sendCalled = false;

  server.enqueue("getUpdates", () => new Promise(() => {})); // hold the poll open
  server.enqueue("sendMessage", () => {
    sendCalled = true;
    return { ok: true, result: { message_id: 88, chat: { id: 123 } } };
  });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "", // blank — must authorize nobody, not everybody
  });

  await runner.start();
  await tick();
  // A blank allowedTgUserId used to fall open (any chat member could decide). It
  // now fails closed at the ENTRY: no actionable card is sent, and the request
  // resolves to no-decision so the hook falls back to its own prompt.
  const decision = await runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
  });
  assert.equal(decision, null, "a blank allowed user resolves to no-decision");
  assert.equal(sendCalled, false, "no actionable card is sent");
  await runner.stop();
});

test("native runner rejects a tap on a card whose allowed user was changed after send", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let allowData = "";
  let currentAllowed = "777"; // config in effect when the card is sent

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    allowData = payload.reply_markup.inline_keyboard[0][0].callback_data;
    return { ok: true, result: { message_id: 90, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      callback_query: {
        id: "cb-allow",
        from: { id: 777 }, // the ORIGINAL allowed user, revoked below
        message: { message_id: 90, chat: { id: 123 } },
        data: allowData,
      },
    }],
  }));
  server.enqueueOk("answerCallbackQuery", true);

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => currentAllowed, // live config, changes below
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({ title: "t", detail: "d" });
  await tick();
  assert.match(allowData, /^cp:[a-z0-9]+:a$/); // card was sent under user 777

  // The user changes the allowed Telegram user AFTER the card is out.
  currentAllowed = "888";

  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();

  // User 777 (now revoked) taps the stale card. The callback checks the CURRENT
  // config, not just the entry snapshot, so the tap is rejected — the decision
  // never resolves and the card is never rewritten with an outcome.
  const settled = await Promise.race([
    decisionPromise.then(() => "RESOLVED"),
    delay(20).then(() => "PENDING"),
  ]);
  assert.equal(settled, "PENDING", "a revoked user must not decide on an in-flight card");
  assert.equal(
    server.calls.some((call) => call.method === "editMessageText"),
    false,
    "no outcome should be written to the card",
  );
  await runner.stop();
});

test("native runner claims a Telegram tap atomically so a racing abort can't drop it", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let allowData = "";
  const controller = new AbortController();

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    allowData = payload.reply_markup.inline_keyboard[0][0].callback_data;
    return { ok: true, result: { message_id: 70, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      callback_query: {
        id: "cb-allow",
        from: { id: 777 },
        message: { message_id: 70, chat: { id: 123 } },
        data: allowData,
      },
    }],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 70 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval(
    { title: "claude-code requests Bash", detail: "Summary: Run tests" },
    { signal: controller.signal },
  );
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  // The tap is claimed synchronously, so the desktop answering immediately
  // afterwards (signal abort) is a no-op rather than a null drop.
  assert.deepEqual(decision, { action: "allow" });

  controller.abort();
  await tick();

  const edits = server.calls.filter((call) => call.method === "editMessageText");
  assert.equal(edits.length, 1, "the late abort must not fire a second, conflicting card rewrite");
  assert.equal(
    edits[0].payload.text,
    "<b>claude-code requests Bash</b>\n\nSummary: Run tests\n\n<b>\u2705 Allowed</b>",
  );
  assert.equal(edits[0].payload.parse_mode, "HTML");
  await runner.stop();
});

test("native runner requestApproval renders suggestions and returns suggestion decisions", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let suggestionData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    const keyboard = payload.reply_markup.inline_keyboard;
    assert.deepEqual(keyboard[0].map((button) => button.text), ["Allow once", "Deny"]);
    assert.equal(keyboard[1][0].text, "Always Bash");
    assert.equal(keyboard[2][0].text, "Auto edits");
    assert.match(keyboard[1][0].callback_data, /^cp:[a-z0-9]+:s0$/);
    assert.match(keyboard[2][0].callback_data, /^cp:[a-z0-9]+:s3$/);
    suggestionData = keyboard[2][0].callback_data;
    return { ok: true, result: { message_id: 101, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      callback_query: {
        id: "cb-suggestion",
        from: { id: 777 },
        message: { message_id: 101, chat: { id: 123 } },
        data: suggestionData,
      },
    }],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 101 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
    suggestions: [
      { index: 0, label: "Always Bash" },
      { index: 3, label: "Auto edits" },
    ],
  });
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  assert.deepEqual(decision, { action: "suggestion", index: 3 });
  await runner.stop();
});

test("native runner rejects forged suggestion callbacks and waits for a valid decision", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let forgedSuggestionData = "";
  let validSuggestionData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    const keyboard = payload.reply_markup.inline_keyboard;
    forgedSuggestionData = keyboard[0][0].callback_data.replace(/:a$/, ":s99");
    validSuggestionData = keyboard[1][0].callback_data;
    return { ok: true, result: { message_id: 102, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [
      {
        update_id: 1,
        callback_query: {
          id: "cb-forged",
          from: { id: 777 },
          message: { message_id: 102, chat: { id: 123 } },
          data: forgedSuggestionData,
        },
      },
      {
        update_id: 2,
        callback_query: {
          id: "cb-valid",
          from: { id: 777 },
          message: { message_id: 102, chat: { id: 123 } },
          data: validSuggestionData,
        },
      },
    ],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 102 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
    suggestions: [{ index: 0, label: "Always Bash" }],
  });
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  assert.deepEqual(decision, { action: "suggestion", index: 0 });
  // The valid tap's toast + card rewrite are fire-and-forget now; let them land.
  await tick();

  const callbackAnswers = server.calls.filter((call) => call.method === "answerCallbackQuery");
  assert.equal(callbackAnswers[0].payload.text, "Unavailable");
  assert.equal(callbackAnswers[1].payload.text, "Applied");
  const edits = server.calls.filter((call) => call.method === "editMessageText");
  assert.equal(edits.length, 1, "only the valid decision rewrites the card");
  assert.equal(
    edits[0].payload.text,
    "<b>claude-code requests Bash</b>\n\nSummary: Run tests\n\n<b>\u2705 Applied</b>",
  );
  assert.equal(edits[0].payload.parse_mode, "HTML");
  await runner.stop();
});

test("native runner requestApproval ignores wrong user and resolves later callback", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let denyData = "";
  let legacyDenyData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    denyData = payload.reply_markup.inline_keyboard[0][1].callback_data;
    assert.match(denyData, /^cp:([a-z0-9]+):d$/);
    legacyDenyData = denyData.replace(/^cp:([a-z0-9]+):d$/, "clawdperm:$1:deny");
    return { ok: true, result: { message_id: 100, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [
      {
        update_id: 1,
        callback_query: {
          id: "cb-wrong-user",
          from: { id: 999 },
          message: { message_id: 100, chat: { id: 123 } },
          data: legacyDenyData,
        },
      },
      {
        update_id: 2,
        callback_query: {
          id: "cb-deny",
          from: { id: 777 },
          message: { message_id: 100, chat: { id: 123 } },
          data: legacyDenyData,
        },
      },
    ],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 100 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
  });
  await tick();
  releaseFirstPoll({ ok: true, result: [] });

  assert.deepEqual(await decisionPromise, { action: "deny" });
  // The valid tap's toast + card rewrite are fire-and-forget now; let them land.
  await tick();
  assert.equal(
    server.calls.filter((call) => call.method === "answerCallbackQuery").length,
    2,
  );
  const denyEdit = server.calls.find((call) => call.method === "editMessageText");
  assert.ok(denyEdit, "tapping Deny rewrites the card body with the outcome");
  assert.equal(
    denyEdit.payload.text,
    "<b>claude-code requests Bash</b>\n\nSummary: Run tests\n\n<b>\u274C Denied</b>",
  );
  assert.equal(denyEdit.payload.parse_mode, "HTML");
  await runner.stop();
});

test("native runner reports approval delivery only after Telegram returns a message id", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueueOk("sendMessage", { message_id: 321, chat: { id: 123 } });
  server.enqueueOk("editMessageText", { message_id: 321 });
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });
  await runner.start();
  await tick();

  const delivered = [];
  const controller = new AbortController();
  const decisionPromise = runner.requestApproval(
    { title: "x", detail: "y" },
    { signal: controller.signal, onDelivered: (report) => delivered.push(report) },
  );
  assert.deepEqual(delivered, [], "starting requestApproval is not a delivery report");
  await tick();
  assert.deepEqual(delivered, [{ messageId: 321 }]);

  controller.abort();
  assert.equal(await decisionPromise, null);
  releaseFirstPoll({ ok: true, result: [] });
  await runner.stop();
});

test("native runner requestApproval resolves null on abort and send failure", async () => {
  {
    const server = createFakeTelegramServer();
    let releaseFirstPoll;
    server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
    server.enqueueOk("sendMessage", { message_id: 1 });

    const runner = createTelegramNativeRunner({
      tokenStore: tokenStore(),
      transport: server.transport,
      getDispatch: () => async () => {},
      getChatId: () => "123",
      getAllowedUserId: () => "777",
    });
    await runner.start();
    await tick();
    const controller = new AbortController();
    const promise = runner.requestApproval(
      { title: "x", detail: "y" },
      { signal: controller.signal },
    );
    controller.abort();
    assert.equal(await promise, null);
    releaseFirstPoll({ ok: true, result: [] });
    await runner.stop();
  }

  {
    const server = createFakeTelegramServer();
    let releaseFirstPoll;
    server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
    server.enqueueError("sendMessage", { status: 403, description: "Forbidden" });

    const runner = createTelegramNativeRunner({
      tokenStore: tokenStore(),
      transport: server.transport,
      getDispatch: () => async () => {},
      getChatId: () => "123",
      getAllowedUserId: () => "777",
    });
    await runner.start();
    await tick();
    const delivered = [];
    const decision = await runner.requestApproval(
      { title: "x", detail: "y" },
      { onDelivered: (report) => delivered.push(report) },
    );
    assert.equal(decision, null);
    assert.deepEqual(delivered, [], "a failed send must not report delivery");
    releaseFirstPoll({ ok: true, result: [] });
    await runner.stop();
  }
});

test("native runner aborts an in-flight approval send before a late Telegram success", async () => {
  const server = createFakeTelegramServer();
  const logs = [];
  let releaseFirstPoll;
  let releaseSend;

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", () => new Promise((resolve) => { releaseSend = resolve; }));

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    log: (level, message) => logs.push({ level, message }),
  });
  await runner.start();
  await tick();

  const controller = new AbortController();
  const delivered = [];
  const promise = runner.requestApproval(
    { title: "claude-code requests Bash", detail: "Summary: Run tests" },
    { signal: controller.signal, onDelivered: (report) => delivered.push(report) },
  );
  await tick();
  assert.equal(server.calls.filter((call) => call.method === "sendMessage").length, 1);

  controller.abort();
  assert.equal(await promise, null);
  await tick();

  releaseSend({ ok: true, result: { message_id: 44, chat: { id: 123 } } });
  await tick();
  await tick();

  assert.equal(
    logs.some((entry) => entry.message === "native approval card sent"),
    false,
    "aborted approval sends must not report a late card as delivered",
  );
  assert.deepEqual(delivered, [], "a late send result after abort must not report delivery");
  assert.equal(
    logs.some((entry) => entry.message === "native approval send aborted"),
    true,
    "abort should cancel the in-flight Telegram send",
  );

  releaseFirstPoll({ ok: true, result: [] });
  await runner.stop();
});

test("native runner rewrites approval card with status when resolved outside Telegram (abort)", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueueOk("sendMessage", { message_id: 99, chat: { id: 123 } });
  server.enqueueOk("editMessageText", { message_id: 99 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();

  const controller = new AbortController();
  const decisionPromise = runner.requestApproval(
    { title: "claude-code requests Bash", detail: "Summary: Run tests" },
    { signal: controller.signal },
  );
  // Let the card send resolve so the entry records its message id.
  await tick();
  assert.equal(server.calls.filter((call) => call.method === "sendMessage").length, 1);

  // The permission was resolved outside Telegram (desktop answer, DND, or a
  // dismissed bubble): the caller aborts the in-flight request.
  controller.abort();
  assert.equal(await decisionPromise, null);
  await tick();

  const editCalls = server.calls.filter((call) => call.method === "editMessageText");
  assert.equal(editCalls.length, 1, "stale approval card must be rewritten with the outcome");
  assert.equal(editCalls[0].payload.chat_id, "123");
  assert.equal(editCalls[0].payload.message_id, 99);
  assert.equal(
    editCalls[0].payload.text,
    "<b>claude-code requests Bash</b>\n\nSummary: Run tests\n\n<b>\u2705 Resolved outside Telegram</b>",
  );
  assert.equal(editCalls[0].payload.parse_mode, "HTML");
  assert.equal(
    editCalls[0].payload.reply_markup,
    undefined,
    "editMessageText without reply_markup drops the inline keyboard",
  );
  assert.equal(
    server.calls.some((call) => call.method === "editMessageReplyMarkup"),
    false,
    "no separate keyboard strip when the text rewrite succeeds",
  );

  releaseFirstPoll({ ok: true, result: [] });
  await runner.stop();
});

test("native runner appends timeout status when an approval expires", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueueOk("sendMessage", { message_id: 77, chat: { id: 123 } });
  server.enqueueOk("editMessageText", { message_id: 77 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    approvalTimeoutMs: 10,
  });

  await runner.start();
  await tick();

  const decisionPromise = runner.requestApproval({ title: "claude-code requests Bash", detail: "Summary: Run tests" });
  // The production approval timeout is unref'ed so it won't keep Clawd alive on
  // shutdown. Keep this test alive with a normal timer until that timeout fires.
  await delay(30);
  const decision = await decisionPromise;
  assert.equal(decision, null);
  await tick();

  const editCalls = server.calls.filter((call) => call.method === "editMessageText");
  assert.equal(editCalls.length, 1);
  assert.equal(editCalls[0].payload.message_id, 77);
  assert.equal(
    editCalls[0].payload.text,
    "<b>claude-code requests Bash</b>\n\nSummary: Run tests\n\n<b>\u23F3 Timed out</b>",
  );
  assert.equal(editCalls[0].payload.parse_mode, "HTML");

  releaseFirstPoll({ ok: true, result: [] });
  await runner.stop();
});

test("native runner appends session-ended status when polling stops with a pending approval", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueueOk("sendMessage", { message_id: 55, chat: { id: 123 } });
  server.enqueueOk("editMessageText", { message_id: 55 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();

  const decisionPromise = runner.requestApproval({ title: "claude-code requests Bash", detail: "Summary: Run tests" });
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  await runner.stop();
  assert.equal(await decisionPromise, null);
  await tick();

  const editCalls = server.calls.filter((call) => call.method === "editMessageText");
  assert.equal(editCalls.length, 1);
  assert.equal(editCalls[0].payload.message_id, 55);
  assert.equal(
    editCalls[0].payload.text,
    "<b>claude-code requests Bash</b>\n\nSummary: Run tests\n\n<b>\u23F9\uFE0F Session ended</b>",
  );
  assert.equal(editCalls[0].payload.parse_mode, "HTML");
});

test("native runner falls back to stripping the keyboard when the status rewrite fails", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueueOk("sendMessage", { message_id: 88, chat: { id: 123 } });
  server.enqueueError("editMessageText", { status: 400, description: "Bad Request: message can't be edited" });
  server.enqueueOk("editMessageReplyMarkup", { message_id: 88 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();

  const controller = new AbortController();
  const decisionPromise = runner.requestApproval(
    { title: "claude-code requests Bash", detail: "Summary: Run tests" },
    { signal: controller.signal },
  );
  await tick();

  controller.abort();
  assert.equal(await decisionPromise, null);
  await tick();
  await tick();

  const stripCalls = server.calls.filter((call) => call.method === "editMessageReplyMarkup");
  assert.equal(stripCalls.length, 1, "PR #446 guarantee: stale card must lose its keyboard even if the rewrite fails");
  assert.equal(stripCalls[0].payload.chat_id, "123");
  assert.equal(stripCalls[0].payload.message_id, 88);
  assert.deepEqual(stripCalls[0].payload.reply_markup, { inline_keyboard: [] });

  releaseFirstPoll({ ok: true, result: [] });
  await runner.stop();
});

test("native runner requestApproval is disabled until polling with a valid payload", async () => {
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: createFakeTelegramServer().transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  assert.equal(runner.isEnabled(), false);
  assert.equal(await runner.requestApproval({ title: "x", detail: "y" }), null);
  assert.equal(await runner.requestApproval({ title: "", detail: "y" }), null);
});

test("requestApproval plain-fallback preserves the keyboard and does not decide automatically", async () => {
  const server = createFakeTelegramServer();
  const controller = new AbortController();
  server.enqueue("getUpdates", () => new Promise(() => {}));
  server.enqueueError("sendMessage", {
    status: 400,
    description: "Bad Request: can't parse entities: Unsupported start tag",
  });
  server.enqueueOk("sendMessage", { message_id: 141, chat: { id: 123 } });
  server.enqueueOk("editMessageText", { message_id: 141 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });
  await runner.start();
  await tick();

  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
  }, { signal: controller.signal });
  await tick();

  const sends = server.calls.filter((call) => call.method === "sendMessage");
  assert.equal(sends.length, 2);
  assert.equal(sends[0].payload.parse_mode, "HTML");
  assert.equal(sends[1].payload.parse_mode, undefined);
  assert.deepEqual(sends[1].payload.reply_markup, sends[0].payload.reply_markup);
  assert.equal(runner._pendingApprovals.size, 1);

  controller.abort();
  assert.equal(await decisionPromise, null);
  await runner.stop();
});

test("requestApproval does not start a plain fallback after the caller aborts on the HTML failure", async () => {
  const controller = new AbortController();
  const calls = [];
  const transport = async ({ method, payload }) => {
    calls.push({ method, payload });
    if (method === "getUpdates") return new Promise(() => {});
    if (method === "sendMessage") {
      controller.abort();
      return {
        ok: false,
        status: 400,
        error_code: 400,
        description: "Bad Request: can't parse entities: Unsupported start tag",
      };
    }
    return { ok: true, result: true };
  };
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });
  await runner.start();
  await tick();

  const decision = await runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
  }, { signal: controller.signal });

  assert.equal(decision, null);
  const sends = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sends.length, 1, "aborted requests must not start the rendered-plain retry");
  assert.equal(sends[0].payload.parse_mode, "HTML");
  await runner.stop();
});

// ── R1a sendNotification ──────────────────────────────────────────────────

// Start polling against a getUpdates that never resolves so `polling` stays
// true (the gate sendNotification checks) without consuming scripted sends.
async function startPolling(server, opts = {}) {
  server.enqueue("getUpdates", () => new Promise(() => {}));
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    ...opts,
  });
  await runner.start();
  await tick();
  return runner;
}

test("sendNotification posts a plain message with no inline keyboard", async () => {
  const server = createFakeTelegramServer();
  const runner = await startPolling(server);
  server.enqueueOk("sendMessage", { message_id: 7 });

  const res = await runner.sendNotification("done: task X");
  assert.deepEqual(res, { ok: true, messageId: 7 });
  const send = server.calls.find((c) => c.method === "sendMessage");
  assert.equal(send.payload.chat_id, "123");
  assert.equal(send.payload.text, "done: task X");
  assert.equal(send.payload.parse_mode, undefined, "legacy strings must keep the existing wire contract");
  assert.equal(send.payload.reply_markup, undefined);
  await runner.stop();
});

test("sendNotification sends formatted messages as HTML", async () => {
  const server = createFakeTelegramServer();
  const runner = await startPolling(server);
  server.enqueueOk("sendMessage", { message_id: 8 });

  const message = renderTelegramMarkdown("**done** <redacted:token>");
  const res = await runner.sendNotification(message);
  assert.deepEqual(res, { ok: true, messageId: 8 });
  const send = server.calls.find((call) => call.method === "sendMessage");
  assert.equal(send.payload.parse_mode, "HTML");
  assert.equal(send.payload.text, "<b>done</b> &lt;redacted:token&gt;");
  await runner.stop();
});

test("sendNotification retries rendered plain text only for entity-parser 400", async () => {
  const server = createFakeTelegramServer();
  const runner = await startPolling(server);
  server.enqueueError("sendMessage", {
    status: 400,
    description: "Bad Request: can't parse entities: Unsupported start tag at byte offset 0",
  });
  server.enqueueOk("sendMessage", { message_id: 81 });

  const message = renderTelegramMarkdown("**done**");
  const res = await runner.sendNotification(message);
  assert.deepEqual(res, { ok: true, messageId: 81 });
  const sends = server.calls.filter((call) => call.method === "sendMessage");
  assert.equal(sends.length, 2);
  assert.equal(sends[0].payload.parse_mode, "HTML");
  assert.equal(sends[0].payload.text, "<b>done</b>");
  assert.equal(sends[1].payload.parse_mode, undefined);
  assert.equal(sends[1].payload.text, "done");
  await runner.stop();
});

test("sendNotification does not plain-retry unrelated 400 responses", async () => {
  const server = createFakeTelegramServer();
  const runner = await startPolling(server);
  server.enqueueError("sendMessage", {
    status: 400,
    description: "Bad Request: message is too long",
  });

  const res = await runner.sendNotification(renderTelegramMarkdown("**done**"));
  assert.deepEqual(res, { ok: false, errorClass: "400" });
  assert.equal(server.calls.filter((call) => call.method === "sendMessage").length, 1);
  await runner.stop();
});

test("sendNotification keeps the post-429 retry plain after HTML parse fallback", async () => {
  const server = createFakeTelegramServer();
  const slept = [];
  const runner = await startPolling(server, {
    sleep: async (ms) => { slept.push(ms); },
  });
  server.enqueueError("sendMessage", {
    status: 400,
    description: "Bad Request: CAN'T PARSE ENTITIES at byte offset 4",
  });
  server.enqueueError("sendMessage", { status: 429, parameters: { retry_after: 1 } });
  server.enqueueOk("sendMessage", { message_id: 82 });

  const res = await runner.sendNotification(renderTelegramMarkdown("**done**"));
  assert.deepEqual(res, { ok: true, messageId: 82 });
  assert.deepEqual(slept, [1000]);
  const sends = server.calls.filter((call) => call.method === "sendMessage");
  assert.equal(sends.length, 3);
  assert.equal(sends[0].payload.parse_mode, "HTML");
  assert.equal(sends[1].payload.parse_mode, undefined);
  assert.equal(sends[2].payload.parse_mode, undefined);
  assert.equal(sends[2].payload.text, "done");
  await runner.stop();
});

test("sendNotification returns not_active when not polling", async () => {
  const server = createFakeTelegramServer();
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });
  const res = await runner.sendNotification("nope");
  assert.deepEqual(res, { ok: false, errorClass: "not_active" });
  assert.equal(server.calls.length, 0, "must not call Telegram when inactive");
});

test("sendNotification returns not_active when chat id is missing", async () => {
  const server = createFakeTelegramServer();
  const runner = await startPolling(server, { getChatId: () => "" });
  const res = await runner.sendNotification("nope");
  assert.deepEqual(res, { ok: false, errorClass: "not_active" });
  await runner.stop();
});

test("sendNotification retries once on 429 then succeeds", async () => {
  const server = createFakeTelegramServer();
  const slept = [];
  const runner = await startPolling(server, {
    sleep: async (ms) => { slept.push(ms); },
  });
  server.enqueueError("sendMessage", { status: 429, parameters: { retry_after: 2 } });
  server.enqueueOk("sendMessage", { message_id: 9 });

  const res = await runner.sendNotification("retry me");
  assert.deepEqual(res, { ok: true, messageId: 9 });
  assert.deepEqual(slept, [2000], "honours retry_after seconds");
  assert.equal(server.calls.filter((c) => c.method === "sendMessage").length, 2);
  await runner.stop();
});

test("sendNotification re-reads chat id before the 429 retry", async () => {
  const server = createFakeTelegramServer();
  let chat = "123";
  const runner = await startPolling(server, {
    getChatId: () => chat,
    sleep: async () => { chat = ""; }, // user re-targets during retry_after
  });
  server.enqueueError("sendMessage", { status: 429, parameters: { retry_after: 1 } });

  const res = await runner.sendNotification("retarget mid-retry");
  assert.deepEqual(res, { ok: false, errorClass: "not_active" });
  // Only the first attempt hit the wire; the retry bailed on the cleared chat.
  assert.equal(server.calls.filter((c) => c.method === "sendMessage").length, 1);
  await runner.stop();
});

test("sendNotification bails when the chat target changes during the 429 retry", async () => {
  const server = createFakeTelegramServer();
  let chat = "123";
  const runner = await startPolling(server, {
    getChatId: () => chat,
    sleep: async () => { chat = "456"; }, // re-targeted to a DIFFERENT chat
  });
  server.enqueueError("sendMessage", { status: 429, parameters: { retry_after: 1 } });

  const res = await runner.sendNotification("retargeted mid-retry");
  assert.deepEqual(res, { ok: false, errorClass: "not_active" });
  assert.equal(server.calls.filter((c) => c.method === "sendMessage").length, 1,
    "must not re-fire the ping at the new chat");
  await runner.stop();
});

test("sendNotification drops on 403 without retrying", async () => {
  const server = createFakeTelegramServer();
  const runner = await startPolling(server);
  server.enqueueError("sendMessage", { status: 403, description: "bot was blocked" });

  const res = await runner.sendNotification("blocked");
  assert.deepEqual(res, { ok: false, errorClass: "403" });
  assert.equal(server.calls.filter((c) => c.method === "sendMessage").length, 1);
  await runner.stop();
});

// ── R2 /status command ────────────────────────────────────────────────────

test("native runner replies to /status from the configured Telegram user and chat", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let runner;
  const commands = [];

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      message: {
        message_id: 10,
        text: "/status all",
        from: { id: 777 },
        chat: { id: 123 },
      },
    }],
  }));
  server.enqueue("sendMessage", (payload) => {
    assert.equal(payload.chat_id, "123");
    assert.equal(payload.text, "status: all");
    assert.equal(payload.reply_markup, undefined);
    return { ok: true, result: { message_id: 11 } };
  });

  runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    onCommand: ({ command, args, chatId, fromId }) => {
      commands.push({ command, args, chatId, fromId });
      runner.stop();
      return "status: all";
    },
  });

  await runner.start();
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();
  await tick();

  assert.deepEqual(commands, [{
    command: "status",
    args: "all",
    chatId: "123",
    fromId: "777",
  }]);
  assert.equal(server.calls.filter((call) => call.method === "sendMessage").length, 1);
  assert.equal(runner.getStatus().pendingApprovalCount, 0);
  await runner.stop();
});

test("native runner ignores /status from the wrong Telegram user or chat", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let commandCount = 0;
  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [
      {
        update_id: 1,
        message: {
          text: "/status",
          from: { id: 999 },
          chat: { id: 123 },
        },
      },
      {
        update_id: 2,
        message: {
          text: "/status",
          from: { id: 777 },
          chat: { id: 456 },
        },
      },
    ],
  }));
  server.enqueue("getUpdates", () => new Promise(() => {}));

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    onCommand: () => {
      commandCount += 1;
      return "should not send";
    },
  });

  await runner.start();
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();

  assert.equal(commandCount, 0);
  assert.equal(server.calls.some((call) => call.method === "sendMessage"), false);
  await runner.stop();
});

test("native runner ignores /status while command handling is disabled", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let commandCount = 0;
  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      message: {
        text: "/status",
        from: { id: 777 },
        chat: { id: 123 },
      },
    }],
  }));
  server.enqueue("getUpdates", () => new Promise(() => {}));

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    isCommandEnabled: () => false,
    onCommand: () => {
      commandCount += 1;
      return "should not send";
    },
  });

  await runner.start();
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();

  assert.equal(commandCount, 0);
  assert.equal(server.calls.some((call) => call.method === "sendMessage"), false);
  await runner.stop();
});

// ── R3 direct-send text intake ─────────────────────────────────────────────

test("native runner routes allowed non-command text replies to the text handler", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let runner;
  const textMessages = [];

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      message: {
        message_id: 10,
        text: "continue from phone",
        from: { id: 777 },
        chat: { id: 123 },
        reply_to_message: {
          message_id: 44,
          from: { id: 999 }, // bot/self; auth must use outer message.from
        },
      },
    }],
  }));
  server.enqueue("sendMessage", (payload) => {
    assert.equal(payload.chat_id, "123");
    assert.equal(payload.text, "focused only");
    assert.equal(payload.reply_markup, undefined);
    return { ok: true, result: { message_id: 11 } };
  });

  runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    onCommand: () => { throw new Error("must not route text to command handler"); },
    onTextMessage: (payload) => {
      textMessages.push(payload);
      runner.stop();
      return { text: "focused only" };
    },
  });

  await runner.start();
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();
  await tick();

  assert.deepEqual(textMessages, [{
    text: "continue from phone",
    messageId: 10,
    replyToMessageId: 44,
    fromId: "777",
    chatId: "123",
  }]);
  assert.equal(server.calls.filter((call) => call.method === "sendMessage").length, 1);
  await runner.stop();
});

test("native runner ignores non-command text from the wrong Telegram user or chat", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let textCount = 0;
  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [
      {
        update_id: 1,
        message: {
          text: "continue",
          from: { id: 999 },
          chat: { id: 123 },
        },
      },
      {
        update_id: 2,
        message: {
          text: "continue",
          from: { id: 777 },
          chat: { id: 456 },
        },
      },
    ],
  }));
  server.enqueue("getUpdates", () => new Promise(() => {}));

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    onTextMessage: () => {
      textCount += 1;
      return "should not send";
    },
  });

  await runner.start();
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();

  assert.equal(textCount, 0);
  assert.equal(server.calls.some((call) => call.method === "sendMessage"), false);
  await runner.stop();
});

test("native runner keeps slash commands out of direct-send text handling", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let textCount = 0;
  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [
      {
        update_id: 1,
        message: {
          text: "/status",
          from: { id: 777 },
          chat: { id: 123 },
        },
      },
      {
        update_id: 2,
        message: {
          text: "/unknown hello",
          from: { id: 777 },
          chat: { id: 123 },
        },
      },
    ],
  }));
  server.enqueue("sendMessage", (payload) => {
    assert.equal(payload.text, "status ok");
    return { ok: true, result: { message_id: 11 } };
  });
  server.enqueue("getUpdates", () => new Promise(() => {}));

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    onCommand: () => "status ok",
    onTextMessage: () => {
      textCount += 1;
      return "should not send";
    },
  });

  await runner.start();
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();
  await tick();

  assert.equal(textCount, 0);
  assert.equal(server.calls.filter((call) => call.method === "sendMessage").length, 1);
  await runner.stop();
});

test("native runner suppresses text handling while direct-send text is disabled", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let textCount = 0;
  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      message: {
        text: "continue",
        from: { id: 777 },
        chat: { id: 123 },
      },
    }],
  }));
  server.enqueue("getUpdates", () => new Promise(() => {}));

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    isTextMessageEnabled: () => false,
    onTextMessage: () => {
      textCount += 1;
      return "should not send";
    },
  });

  await runner.start();
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();

  assert.equal(textCount, 0);
  assert.equal(server.calls.some((call) => call.method === "sendMessage"), false);
  await runner.stop();
});

test("native runner retries transient polling errors and keeps handling updates", async () => {
  const server = createFakeTelegramServer();
  let commandCount = 0;
  const slept = [];

  server.enqueue("getUpdates", () => {
    throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      message: {
        text: "/status",
        from: { id: 777 },
        chat: { id: 123 },
      },
    }],
  }));
  server.enqueue("sendMessage", (payload) => {
    assert.equal(payload.text, "still alive");
    return { ok: true, result: { message_id: 12 } };
  });

  let runner;
  runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    pollRetryInitialMs: 25,
    sleep: async (ms) => { slept.push(ms); },
    onCommand: () => {
      commandCount += 1;
      runner.stop();
      return "still alive";
    },
  });

  await runner.start();
  await tick();
  await tick();
  await tick();
  await tick();

  assert.deepEqual(slept, [25]);
  assert.equal(commandCount, 1);
  assert.equal(server.calls.filter((call) => call.method === "sendMessage").length, 1);
  await runner.stop();
});

test("native runner stops polling on fatal webhook conflicts", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  const events = [];
  let routeChanges = 0;

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueueError("getUpdates", {
    status: 409,
    description: "Conflict: can't use getUpdates method while webhook is active",
  });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async (event) => { events.push(event); },
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    onSessionAutomationRouteChange: () => { routeChanges += 1; },
  });

  await runner.start();
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();

  assert.equal(runner.isPolling(), false);
  assert.equal(runner.getStatus().lastError.errorClass, "409_webhook");
  assert.deepEqual(events, [], "active polling failures should not dispatch TEST_FAILED without a pending test");
  assert.equal(routeChanges, 1, "losing the callback route must tighten active session grants");
});

test("native runner reports initial webhook conflict during migration test setup", async () => {
  const server = createFakeTelegramServer();
  const events = [];
  let releaseSend;

  server.enqueueError("getUpdates", {
    status: 409,
    description: "Conflict: can't use getUpdates method while webhook is active",
  });
  server.enqueue("sendMessage", () => new Promise((resolve) => { releaseSend = resolve; }));

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async (event) => { events.push(event); },
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  const sendPromise = runner.sendTestCard();
  await tick();
  await tick();

  assert.equal(events.length, 1, "fatal setup errors should fail the migration test immediately");
  assert.equal(events[0].type, EVENTS.TEST_FAILED);
  assert.equal(events[0].errorClass, "409_webhook");
  assert.equal(runner.isPolling(), false);
  assert.equal(runner.getStatus().pendingTest, false);

  releaseSend({ ok: true, result: { message_id: 55, chat: { id: 123 } } });
  await sendPromise;
  assert.equal(runner.getStatus().pendingTest, false, "late sendMessage success must not resurrect the test card");
});
