"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createTelegramNativeRunner } = require("../src/telegram-native-runner");
const { EVENTS } = require("../src/telegram-migration-state");
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

test("native runner requestApproval resolves allow for matching callback", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let allowData = "";
  let denyData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    assert.match(payload.text, /claude-code requests Bash/);
    assert.match(payload.text, /Summary: Run tests/);
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
  server.enqueueOk("editMessageReplyMarkup", { message_id: 99 });

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
  assert.match(allowData, /^clawdperm:[a-z0-9]+:allow$/);
  assert.match(denyData, /^clawdperm:[a-z0-9]+:deny$/);

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  assert.equal(decision, "allow");
  assert.equal(server.calls.some((call) => call.method === "answerCallbackQuery"), true);
  assert.equal(server.calls.some((call) => call.method === "editMessageReplyMarkup"), true);
  await runner.stop();
});

test("native runner requestApproval ignores wrong user and resolves later callback", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let denyData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    denyData = payload.reply_markup.inline_keyboard[0][1].callback_data;
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
          data: denyData,
        },
      },
      {
        update_id: 2,
        callback_query: {
          id: "cb-deny",
          from: { id: 777 },
          message: { message_id: 100, chat: { id: 123 } },
          data: denyData,
        },
      },
    ],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageReplyMarkup", { message_id: 100 });

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

  assert.equal(await decisionPromise, "deny");
  assert.equal(
    server.calls.filter((call) => call.method === "answerCallbackQuery").length,
    2,
  );
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
    const decision = await runner.requestApproval({ title: "x", detail: "y" });
    assert.equal(decision, null);
    releaseFirstPoll({ ok: true, result: [] });
    await runner.stop();
  }
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
