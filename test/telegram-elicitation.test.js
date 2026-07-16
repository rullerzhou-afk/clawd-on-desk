"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createTelegramNativeRunner } = require("../src/telegram-native-runner");
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

function makeRunner(server, overrides = {}) {
  return createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    // Whenever a test's scripted getUpdates responses run out mid-poll, the
    // runner logs and retries forever until stop() - harmless, but a
    // Promise.resolve()-based sleep never yields to the macrotask queue, so an
    // unthrottled retry loop starves every setImmediate/setTimeout in the
    // process (including this file's own tick()/delay() helpers) forever.
    // Routing the "instant" retry through setImmediate keeps it fast without
    // starving the event loop.
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    log: () => {},
    ...overrides,
  });
}

function singleQuestionPayload() {
  return {
    title: "claude-code needs input",
    questions: [
      { question: "Pick A or B", options: [{ label: "A" }, { label: "B" }] },
    ],
  };
}

function callbackUpdate({ id, messageId, fromId, data }) {
  return {
    update_id: id,
    callback_query: {
      id: `cb-${id}`,
      from: { id: fromId },
      message: { message_id: messageId, chat: { id: 123 } },
      data,
    },
  };
}

function textUpdate({ id, fromId, text, replyToMessageId }) {
  return {
    update_id: id,
    message: {
      message_id: id * 1000,
      from: { id: fromId },
      chat: { id: 123 },
      text,
      reply_to_message: replyToMessageId ? { message_id: replyToMessageId } : undefined,
    },
  };
}

test("requestElicitation resolves elicitation-submit when a single-select question is answered", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let optionData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    optionData = payload.reply_markup.inline_keyboard[0][0].callback_data;
    return { ok: true, result: { message_id: 501, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 1, messageId: 501, fromId: 777, data: optionData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 501 });

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(singleQuestionPayload());
  await tick();
  assert.match(optionData, /^cq:[a-z0-9]+:o0_0$/);

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  assert.deepEqual(decision, { type: "elicitation-submit", answers: { "Pick A or B": "A" } });

  await tick();
  const edit = server.calls.find((call) => call.method === "editMessageText");
  assert.ok(edit, "answering the last question rewrites the card with a submitted status");
  assert.match(edit.payload.text, /Submitted/);
  assert.equal(edit.payload.reply_markup, undefined);

  await runner.stop();
});

test("requestElicitation redacts secrets from the displayed question but keeps the raw answer key", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let sentText = "";
  let optionData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    sentText = payload.text;
    optionData = payload.reply_markup.inline_keyboard[0][0].callback_data;
    return { ok: true, result: { message_id: 601, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 1, messageId: 601, fromId: 777, data: optionData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 601 });

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation({
    title: "claude-code needs input",
    questions: [
      { question: "Rotate sk-abcdefghijklmnop1234 from .env?", options: [{ label: "Yes" }, { label: "No" }] },
    ],
  });
  await tick();

  // The card text sent to Telegram must not carry the key the agent quoted...
  assert.doesNotMatch(sentText, /sk-abcdefghijklmnop1234/);
  assert.match(sentText, /redacted:token/);

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  // ...but the answer still round-trips under the RAW question text as its key,
  // so redaction of the display never desyncs answer delivery to the agent.
  assert.deepEqual(decision, {
    type: "elicitation-submit",
    answers: { "Rotate sk-abcdefghijklmnop1234 from .env?": "Yes" },
  });

  await runner.stop();
});

test("requestElicitation advances through multiple questions and submits once all are answered", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let q1Data = "";
  let q2Data = "";

  const payload = {
    title: "claude-code needs input",
    questions: [
      { question: "Pick A or B", options: [{ label: "A" }, { label: "B" }] },
      { question: "Pick C or D", options: [{ label: "C" }, { label: "D" }] },
    ],
  };

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (msg) => {
    q1Data = msg.reply_markup.inline_keyboard[0][0].callback_data;
    return { ok: true, result: { message_id: 601, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 1, messageId: 601, fromId: 777, data: q1Data })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueue("editMessageText", (edit) => {
    assert.match(edit.text, /Question 2\/2/);
    q2Data = edit.reply_markup.inline_keyboard[0][0].callback_data;
    return { ok: true, result: { message_id: 601 } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 2, messageId: 601, fromId: 777, data: q2Data })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 601 });

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(payload);
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();
  await tick();
  assert.match(q2Data, /^cq:[a-z0-9]+:o1_0$/);

  const decision = await decisionPromise;
  assert.deepEqual(decision, {
    type: "elicitation-submit",
    answers: { "Pick A or B": "A", "Pick C or D": "C" },
  });

  await runner.stop();
});

test("requestElicitation still renders the card when a tap races ahead of the sendMessage response", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let releaseSend;

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", () => new Promise((resolve) => { releaseSend = resolve; }));

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(singleQuestionPayload());
  await tick();

  // The callback_data is generated synchronously before sendMessage is even
  // called, so a real Telegram tap can reach us before that call resolves -
  // and Telegram itself already knows the message_id it assigned, even
  // though our client hasn't read it back yet.
  const sendCall = server.calls.find((call) => call.method === "sendMessage");
  const optionData = sendCall.payload.reply_markup.inline_keyboard[0][0].callback_data;

  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 1, messageId: 950, fromId: 777, data: optionData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 950 });

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  assert.deepEqual(decision, { type: "elicitation-submit", answers: { "Pick A or B": "A" } });

  await tick();
  const edit = server.calls.find((call) => call.method === "editMessageText");
  assert.ok(edit, "the race must not silently drop the final card edit");
  assert.equal(edit.payload.message_id, 950);

  releaseSend({ ok: true, result: { message_id: 950, chat: { id: 123 } } });
  await runner.stop();
});

test("requestElicitation's back button re-renders the previous question without resolving", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let backData = "";

  const payload = {
    title: "claude-code needs input",
    questions: [
      { question: "Pick A or B", options: [{ label: "A" }, { label: "B" }] },
      { question: "Pick C or D", options: [{ label: "C" }, { label: "D" }] },
    ],
  };

  let q1OptionData = "";
  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (msg) => {
    q1OptionData = msg.reply_markup.inline_keyboard[0][0].callback_data;
    return { ok: true, result: { message_id: 701, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 1, messageId: 701, fromId: 777, data: q1OptionData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueue("editMessageText", (edit) => {
    assert.match(edit.text, /Question 2\/2/);
    backData = edit.reply_markup.inline_keyboard.flat().find((btn) => btn.callback_data.includes(":b1")).callback_data;
    return { ok: true, result: { message_id: 701 } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 2, messageId: 701, fromId: 777, data: backData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueue("editMessageText", (edit) => {
    assert.match(edit.text, /Question 1\/2/);
    return { ok: true, result: { message_id: 701 } };
  });

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(payload);
  await tick();
  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();
  await tick();
  await tick();

  assert.match(backData, /^cq:[a-z0-9]+:b1$/);
  let resolved = false;
  decisionPromise.then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, false, "going back must not resolve the elicitation");

  await runner.stop();
});

test("requestElicitation requires Confirm selection before advancing a multi-select question", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let optionAData = "";
  let confirmData = "";

  const payload = {
    title: "claude-code needs input",
    questions: [
      { question: "Pick your toppings", multiSelect: true, options: [{ label: "Cheese" }, { label: "Olives" }] },
    ],
  };

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (msg) => {
    optionAData = msg.reply_markup.inline_keyboard[0][0].callback_data;
    confirmData = msg.reply_markup.inline_keyboard.flat().find((btn) => btn.callback_data.includes(":c0")).callback_data;
    return { ok: true, result: { message_id: 801, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 1, messageId: 801, fromId: 777, data: optionAData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueue("editMessageText", (edit) => {
    // Toggling an option re-renders the same question with the choice checked,
    // without resolving or advancing.
    assert.match(edit.text, /Question 1\/1/);
    assert.match(edit.reply_markup.inline_keyboard[0][0].text, /^☑/);
    return { ok: true, result: { message_id: 801 } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 2, messageId: 801, fromId: 777, data: confirmData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 801 });

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(payload);
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();
  await tick();

  const decision = await decisionPromise;
  assert.deepEqual(decision, {
    type: "elicitation-submit",
    answers: { "Pick your toppings": "Cheese" },
  });

  await runner.stop();
});

test("requestElicitation answers the active question from a text reply after tapping Other", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let otherData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (msg) => {
    otherData = msg.reply_markup.inline_keyboard.flat().find((btn) => btn.callback_data.includes(":x0")).callback_data;
    return { ok: true, result: { message_id: 901, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 1, messageId: 901, fromId: 777, data: otherData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueue("editMessageText", (edit) => {
    assert.match(edit.text, /reply to this message/i);
    return { ok: true, result: { message_id: 901 } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [textUpdate({ id: 2, fromId: 777, text: "My custom answer", replyToMessageId: 901 })],
  }));
  server.enqueueOk("editMessageText", { message_id: 901 });

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(singleQuestionPayload());
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();
  await tick();

  const decision = await decisionPromise;
  assert.deepEqual(decision, {
    type: "elicitation-submit",
    answers: { "Pick A or B": "My custom answer" },
  });

  await runner.stop();
});

test("requestElicitation's Cancel button returns from the Other prompt to the option list", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let otherData = "";
  let cancelData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (msg) => {
    otherData = msg.reply_markup.inline_keyboard.flat().find((btn) => btn.callback_data.includes(":x0")).callback_data;
    return { ok: true, result: { message_id: 950, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 1, messageId: 950, fromId: 777, data: otherData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueue("editMessageText", (edit) => {
    assert.match(edit.text, /reply to this message/i);
    cancelData = edit.reply_markup.inline_keyboard.flat().find((btn) => btn.callback_data.includes(":z0")).callback_data;
    return { ok: true, result: { message_id: 950 } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 2, messageId: 950, fromId: 777, data: cancelData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueue("editMessageText", (edit) => {
    // Back on the option list for the same (still unanswered) question - not
    // stuck waiting for text, and not forced to bail out to the terminal.
    assert.doesNotMatch(edit.text, /reply to this message/i);
    assert.ok(edit.reply_markup.inline_keyboard.flat().some((btn) => btn.callback_data.endsWith(":o0_0")));
    return { ok: true, result: { message_id: 950 } };
  });

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(singleQuestionPayload());
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();
  await tick();
  await tick();

  let resolved = false;
  decisionPromise.then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, false, "cancelling Other must not resolve or advance the elicitation");

  await runner.stop();
});

test("requestElicitation still answers an Other reply that looks like a slash command", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let otherData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (msg) => {
    otherData = msg.reply_markup.inline_keyboard.flat().find((btn) => btn.callback_data.includes(":x0")).callback_data;
    return { ok: true, result: { message_id: 902, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 1, messageId: 902, fromId: 777, data: otherData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 902 });
  server.enqueue("getUpdates", () => ({
    ok: true,
    // "/tmp/output.log" parses as a slash command (command="tmp") - it must
    // still answer the pending question rather than being swallowed as an
    // unrecognized command.
    result: [textUpdate({ id: 2, fromId: 777, text: "/tmp/output.log", replyToMessageId: 902 })],
  }));
  server.enqueueOk("editMessageText", { message_id: 902 });

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(singleQuestionPayload());
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();
  await tick();

  const decision = await decisionPromise;
  assert.deepEqual(decision, {
    type: "elicitation-submit",
    answers: { "Pick A or B": "/tmp/output.log" },
  });

  await runner.stop();
});

test("requestElicitation does not send a card when allowedUser is unset (fail-closed)", async () => {
  const server = createFakeTelegramServer();
  let sendCalled = false;

  server.enqueue("getUpdates", () => new Promise(() => {})); // hold the poll open
  server.enqueue("sendMessage", () => {
    sendCalled = true;
    return { ok: true, result: { message_id: 1301, chat: { id: 123 } } };
  });

  const runner = makeRunner(server, { getAllowedUserId: () => "" });
  await runner.start();
  await tick();
  // An elicitation answer feeds straight into the agent's next step, so a blank
  // (misconfigured) allowedUser must not send an actionable card at all — it
  // fails closed at the entry and resolves to no-decision. (Rejection of a tap
  // from a DIFFERENT user is covered by the next test, where allowedUser is set.)
  const decision = await runner.requestElicitation(singleQuestionPayload());
  assert.equal(decision, null, "a blank allowedUser resolves to no-decision");
  assert.equal(sendCalled, false, "no elicitation card is sent");
  await runner.stop();
});

test("requestElicitation ignores option taps and Other replies from a different user", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let optionData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (msg) => {
    optionData = msg.reply_markup.inline_keyboard[0][0].callback_data;
    return { ok: true, result: { message_id: 1001, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 1, messageId: 1001, fromId: 999, data: optionData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(singleQuestionPayload());
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();

  let resolved = false;
  decisionPromise.then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, false, "a tap from an unauthorized user must not answer the question");

  await runner.stop();
});

test("requestElicitation resolves the string 'terminal' when the user picks Go to terminal", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let terminalData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (msg) => {
    terminalData = msg.reply_markup.inline_keyboard.flat().find((btn) => btn.callback_data.endsWith(":t")).callback_data;
    return { ok: true, result: { message_id: 1101, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [callbackUpdate({ id: 1, messageId: 1101, fromId: 777, data: terminalData })],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageText", { message_id: 1101 });

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(singleQuestionPayload());
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  assert.equal(decision, "terminal");

  await runner.stop();
});

test("requestElicitation resolves null and marks the card timed out when nothing happens", async () => {
  const server = createFakeTelegramServer();
  server.enqueue("getUpdates", () => new Promise(() => {})); // never resolves
  server.enqueueOk("sendMessage", { message_id: 1201, chat: { id: 123 } });
  server.enqueueOk("editMessageText", { message_id: 1201 });

  const runner = makeRunner(server, { elicitationTimeoutMs: 5 });
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(singleQuestionPayload());
  await tick();
  await delay(15);

  const decision = await decisionPromise;
  assert.equal(decision, null);
  const edit = server.calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.match(edit.payload.text, /Timed out/);

  await runner.stop();
});

test("requestElicitation resolves null when the caller aborts (desktop answered first)", async () => {
  const server = createFakeTelegramServer();
  const controller = new AbortController();
  server.enqueue("getUpdates", () => new Promise(() => {}));
  server.enqueueOk("sendMessage", { message_id: 1301, chat: { id: 123 } });
  server.enqueueOk("editMessageText", { message_id: 1301 });

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decisionPromise = runner.requestElicitation(singleQuestionPayload(), { signal: controller.signal });
  await tick();

  controller.abort();
  const decision = await decisionPromise;
  assert.equal(decision, null);

  await runner.stop();
});

test("requestElicitation resolves null when the initial card send fails", async () => {
  const server = createFakeTelegramServer();
  server.enqueue("getUpdates", () => new Promise(() => {}));
  server.enqueueError("sendMessage", { status: 401, description: "Unauthorized" });

  const runner = makeRunner(server);
  await runner.start();
  await tick();
  const decision = await runner.requestElicitation(singleQuestionPayload());
  assert.equal(decision, null);

  await runner.stop();
});
