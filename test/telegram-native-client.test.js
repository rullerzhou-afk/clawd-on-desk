"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TelegramNativeClient,
  TelegramApiError,
  ERROR_CLASSES,
  classifyError,
  pollWithConflictRetry,
  DEFAULT_RETRY_OPTS,
} = require("../src/telegram-native-client");
const { createFakeTelegramServer } = require("./fakes/telegram-server");

const VALID_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ-_0123456789";

function fakeTokenStore(token = VALID_TOKEN) {
  return {
    async getToken() { return token; },
    async hasToken() { return !!token; },
  };
}

function makeClient({ token = VALID_TOKEN } = {}) {
  const server = createFakeTelegramServer();
  const client = new TelegramNativeClient({
    tokenStore: fakeTokenStore(token),
    transport: server.transport,
  });
  return { client, server };
}

test("constructor rejects missing tokenStore / transport", () => {
  assert.throws(() => new TelegramNativeClient({}), /tokenStore.getToken is required/);
  assert.throws(
    () => new TelegramNativeClient({ tokenStore: fakeTokenStore() }),
    /transport function is required/,
  );
});

test("sendMessage: success returns result; token is NOT in transport args", async () => {
  const { client, server } = makeClient();
  server.enqueueOk("sendMessage", { message_id: 42, chat: { id: 1 } });
  const result = await client.sendMessage({ chat_id: 1, text: "hi" });
  assert.equal(result.message_id, 42);
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].token, undefined, "token must not be forwarded in per-call args");
  assert.deepEqual(server.calls[0].payload, { chat_id: 1, text: "hi" });
});

test("getMe / answerCallbackQuery / editMessageReplyMarkup roundtrip", async () => {
  const { client, server } = makeClient();
  server.enqueueOk("getMe", { id: 9, username: "fake_bot" });
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageReplyMarkup", { message_id: 11 });

  assert.equal((await client.getMe()).username, "fake_bot");
  assert.equal(await client.answerCallbackQuery({ callback_query_id: "x" }), true);
  assert.equal((await client.editMessageReplyMarkup({ chat_id: 1, message_id: 11 })).message_id, 11);
});

test("getUpdates advances offset to lastUpdate.update_id + 1", async () => {
  const { client, server } = makeClient();
  server.enqueueOk("getUpdates", [
    { update_id: 100 },
    { update_id: 105 },
  ]);
  server.enqueueOk("getUpdates", []);
  server.enqueueOk("getUpdates", [{ update_id: 200 }]);

  assert.equal(client.offset, 0);
  await client.getUpdates();
  assert.equal(client.offset, 106);
  await client.getUpdates();
  assert.equal(client.offset, 106, "empty batch must not regress offset");
  assert.equal(server.calls[1].payload.offset, 106);
  await client.getUpdates();
  assert.equal(client.offset, 201);
});

test("Missing token throws TOKEN_MISSING (does not call transport)", async () => {
  const server = createFakeTelegramServer();
  const client = new TelegramNativeClient({
    tokenStore: { async getToken() { return null; }, async hasToken() { return false; } },
    transport: server.transport,
  });
  await assert.rejects(
    () => client.getMe(),
    (err) => {
      assert.ok(err instanceof TelegramApiError);
      assert.equal(classifyError(err), ERROR_CLASSES.TOKEN_MISSING);
      return true;
    },
  );
  assert.equal(server.calls.length, 0);
});

test("Error classes: 401 unauthorized", async () => {
  const { client, server } = makeClient();
  server.enqueueError("sendMessage", { status: 401, description: "Unauthorized" });
  const err = await client.sendMessage({ chat_id: 1, text: "x" }).catch((e) => e);
  assert.equal(classifyError(err), ERROR_CLASSES.UNAUTHORIZED);
});

test("Error classes: 403 forbidden (bot blocked / not started)", async () => {
  const { client, server } = makeClient();
  server.enqueueError("sendMessage", {
    status: 403,
    description: "Forbidden: bot was blocked by the user",
  });
  const err = await client.sendMessage({ chat_id: 1, text: "x" }).catch((e) => e);
  assert.equal(classifyError(err), ERROR_CLASSES.FORBIDDEN);
});

test("Error classes: 400 bad request", async () => {
  const { client, server } = makeClient();
  server.enqueueError("sendMessage", { status: 400, description: "Bad Request: chat not found" });
  const err = await client.sendMessage({ chat_id: 999, text: "x" }).catch((e) => e);
  assert.equal(classifyError(err), ERROR_CLASSES.BAD_REQUEST);
});

test("Error classes: 409 conflict (another consumer polling)", async () => {
  const { client, server } = makeClient();
  server.enqueueError("getUpdates", {
    status: 409,
    description: "Conflict: terminated by other getUpdates request",
  });
  const err = await client.getUpdates().catch((e) => e);
  assert.equal(classifyError(err), ERROR_CLASSES.CONFLICT);
});

test("Error classes: 409 webhook conflict (distinct class)", async () => {
  const { client, server } = makeClient();
  server.enqueueError("getUpdates", {
    status: 409,
    description: "Conflict: can't use getUpdates method while webhook is active",
  });
  const err = await client.getUpdates().catch((e) => e);
  assert.equal(classifyError(err), ERROR_CLASSES.WEBHOOK_CONFLICT);
  assert.match(err.description, /webhook/);
});

test("Error classes: 429 rate limited exposes retry_after", async () => {
  const { client, server } = makeClient();
  server.enqueueError("sendMessage", {
    status: 429,
    description: "Too Many Requests",
    parameters: { retry_after: 5 },
  });
  const err = await client.sendMessage({ chat_id: 1, text: "x" }).catch((e) => e);
  assert.equal(classifyError(err), ERROR_CLASSES.RATE_LIMITED);
  assert.equal(err.parameters.retry_after, 5);
});

test("Error classes: 429 with retry_after=60 (>30s, UI shows wait prompt)", async () => {
  const { client, server } = makeClient();
  server.enqueueError("sendMessage", {
    status: 429,
    description: "Too Many Requests",
    parameters: { retry_after: 60 },
  });
  const err = await client.sendMessage({ chat_id: 1, text: "x" }).catch((e) => e);
  assert.equal(classifyError(err), ERROR_CLASSES.RATE_LIMITED);
  assert.equal(err.parameters.retry_after, 60);
});

test("Error classes: network error (ECONNREFUSED)", () => {
  const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.equal(classifyError(err), ERROR_CLASSES.NETWORK);
});

test("Error classes: undici fetch cause codes are network errors", () => {
  const err = Object.assign(new Error("fetch failed"), {
    cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
  });
  assert.equal(classifyError(err), ERROR_CLASSES.NETWORK);
});

test("Error classes: Chromium net::ERR_* connection failures are NETWORK (issue #359)", () => {
  for (const message of [
    "net::ERR_PROXY_CONNECTION_FAILED",
    "net::ERR_TUNNEL_CONNECTION_FAILED",
    "net::ERR_SOCKS_CONNECTION_FAILED",
    "net::ERR_NAME_NOT_RESOLVED",
    "net::ERR_CONNECTION_REFUSED",
    "net::ERR_CONNECTION_RESET",
    "net::ERR_TIMED_OUT",
    "net::ERR_INTERNET_DISCONNECTED",
  ]) {
    assert.equal(classifyError(new Error(message)), ERROR_CLASSES.NETWORK, message);
  }
});

test("Error classes: net::ERR_ABORTED is NETWORK, not TIMEOUT (must not exit poll loop)", () => {
  // A genuine user abort arrives as name === "AbortError" and is handled earlier.
  // An involuntary Chromium abort must be retried, so it must NOT map to TIMEOUT —
  // the poll loop exits on TIMEOUT (telegram-native-runner.js loop/loopFirst).
  assert.equal(classifyError(new Error("net::ERR_ABORTED")), ERROR_CLASSES.NETWORK);
});

test("Error classes: non-retryable net::ERR_* (cert / blocked) fall through to UNKNOWN", () => {
  assert.equal(classifyError(new Error("net::ERR_CERT_AUTHORITY_INVALID")), ERROR_CLASSES.UNKNOWN);
  assert.equal(classifyError(new Error("net::ERR_BLOCKED_BY_CLIENT")), ERROR_CLASSES.UNKNOWN);
});

test("Error classes: status=null but error_code=409 still classified as CONFLICT", () => {
  const err = new TelegramApiError({ status: null, code: 409, description: "Conflict" });
  assert.equal(classifyError(err), ERROR_CLASSES.CONFLICT);
});

test("Error classes: AbortError → TIMEOUT", () => {
  const err = new Error("aborted");
  err.name = "AbortError";
  assert.equal(classifyError(err), ERROR_CLASSES.TIMEOUT);
});

test("AbortController cancels in-flight getUpdates with AbortError", async () => {
  const { client, server } = makeClient();
  // Long-running response that never settles unless aborted.
  server.enqueue("getUpdates", () => new Promise(() => {}));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 5);
  const err = await client.getUpdates({ signal: ac.signal }).catch((e) => e);
  assert.ok(err instanceof Error, "expected an error");
  assert.equal(err.name, "AbortError");
  assert.equal(classifyError(err), ERROR_CLASSES.TIMEOUT);
});

test("Pre-aborted signal: transport refuses immediately, no call recorded", async () => {
  const { client, server } = makeClient();
  const ac = new AbortController();
  ac.abort();
  const err = await client.getUpdates({ signal: ac.signal }).catch((e) => e);
  assert.equal(err.name, "AbortError");
  assert.equal(server.calls.length, 0);
});

test("Wrong-user callback flow: client surfaces both updates; handler filters", async () => {
  // The client itself does not filter by user — the spike treats that as
  // handler-level concern (so a future approval module can choose to log
  // wrong-user attempts). This test pins that contract.
  const { client, server } = makeClient();
  server.enqueueOk("getUpdates", [
    { update_id: 1, callback_query: { id: "a", from: { id: 999 }, data: "test_ok" } },
    { update_id: 2, callback_query: { id: "b", from: { id: 100 }, data: "test_ok" } },
  ]);
  const updates = await client.getUpdates();
  assert.equal(updates.length, 2);

  const allowed = 100;
  const filtered = updates.filter((u) => u.callback_query.from.id === allowed);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].callback_query.from.id, allowed);
});

// ============================================================================
// pollWithConflictRetry — plan §116 (1s base / ×2 / cap 5s / 35s deadline)
// ============================================================================

function makeClock() {
  let t = 0;
  const slept = [];
  return {
    now: () => t,
    sleep(ms) {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    advance(ms) { t += ms; },
    slept,
  };
}

test("pollWithConflictRetry: succeeds first try without sleeping", async () => {
  const clock = makeClock();
  const out = await pollWithConflictRetry(async () => "ok", { now: clock.now, sleep: clock.sleep });
  assert.equal(out.result, "ok");
  assert.equal(out.attempts, 1);
  assert.deepEqual(clock.slept, []);
});

test("pollWithConflictRetry: retries through 409 conflicts, then succeeds", async () => {
  const clock = makeClock();
  let calls = 0;
  const out = await pollWithConflictRetry(
    async () => {
      calls += 1;
      if (calls <= 3) {
        throw new TelegramApiError({
          status: 409,
          description: "Conflict: terminated by other getUpdates request",
        });
      }
      return "released";
    },
    { now: clock.now, sleep: clock.sleep },
  );
  assert.equal(out.result, "released");
  assert.equal(out.attempts, 4);
  // 1s, 2s, 4s (exponential factor 2)
  assert.deepEqual(clock.slept, [1000, 2000, 4000]);
});

test("pollWithConflictRetry: caps backoff at maxDelayMs", async () => {
  const clock = makeClock();
  let calls = 0;
  await pollWithConflictRetry(
    async () => {
      calls += 1;
      if (calls <= 5) {
        throw new TelegramApiError({ status: 409, description: "Conflict" });
      }
      return "ok";
    },
    { now: clock.now, sleep: clock.sleep },
  );
  // 1, 2, 4, 5 (capped), 5
  assert.deepEqual(clock.slept, [1000, 2000, 4000, 5000, 5000]);
});

test("pollWithConflictRetry: hits 35s deadline → throws 409 with attempts metadata", async () => {
  const clock = makeClock();
  const err = await pollWithConflictRetry(
    async () => {
      throw new TelegramApiError({ status: 409, description: "Conflict" });
    },
    { now: clock.now, sleep: clock.sleep },
  ).catch((e) => e);
  assert.ok(err instanceof TelegramApiError);
  assert.equal(err.status, 409);
  assert.ok(err.parameters.attempts >= 5, "should record attempt count");
  assert.ok(err.parameters.elapsedMs >= DEFAULT_RETRY_OPTS.totalDeadlineMs);
});

test("pollWithConflictRetry: webhook conflict short-circuits (no retry)", async () => {
  const clock = makeClock();
  let calls = 0;
  const err = await pollWithConflictRetry(
    async () => {
      calls += 1;
      throw new TelegramApiError({
        status: 409,
        description: "Conflict: can't use getUpdates method while webhook is active",
      });
    },
    { now: clock.now, sleep: clock.sleep },
  ).catch((e) => e);
  assert.equal(calls, 1, "webhook conflict must not retry");
  assert.equal(classifyError(err), ERROR_CLASSES.WEBHOOK_CONFLICT);
});

test("pollWithConflictRetry: non-409 error rethrown immediately", async () => {
  const clock = makeClock();
  let calls = 0;
  const err = await pollWithConflictRetry(
    async () => {
      calls += 1;
      throw new TelegramApiError({ status: 401, description: "Unauthorized" });
    },
    { now: clock.now, sleep: clock.sleep },
  ).catch((e) => e);
  assert.equal(calls, 1);
  assert.equal(classifyError(err), ERROR_CLASSES.UNAUTHORIZED);
});

test("pollWithConflictRetry: external abort signal cancels mid-retry", async () => {
  const clock = makeClock();
  const ac = new AbortController();
  let calls = 0;
  const err = await pollWithConflictRetry(
    async () => {
      calls += 1;
      if (calls === 2) ac.abort();
      throw new TelegramApiError({ status: 409, description: "Conflict" });
    },
    { now: clock.now, sleep: clock.sleep, signal: ac.signal },
  ).catch((e) => e);
  assert.equal(err.name, "AbortError");
});

test("60s timeout scenario: long poll returns empty batch (no tap)", async () => {
  // The 60s timeout in the migration flow is enforced by the caller, not the
  // client. From the client's perspective an empty getUpdates is the normal
  // "no events" outcome — the migration manager interprets sustained empties
  // plus a wall-clock deadline as "user did not tap".
  const { client, server } = makeClient();
  server.enqueueOk("getUpdates", []);
  const updates = await client.getUpdates({ timeout: 60 });
  assert.deepEqual(updates, []);
  assert.equal(client.offset, 0, "empty batch does not change offset");
  assert.equal(server.calls[0].payload.timeout, 60);
});
