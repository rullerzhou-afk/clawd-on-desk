"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createSlackNotifyClient,
  isCompletion,
  dedupeKey,
  classifyHttpStatus,
  classifySlackApiError,
} = require("../src/slack-notify-client");

const WEBHOOK = "https://hooks.slack.com/services/T/B/xxx";

function makeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, headers: (opts && opts.headers) || {}, body, opts: opts || {} });
    return responder(url, opts);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function okWebhook() {
  return { ok: true, status: 200, text: async () => "ok" };
}

function baseClient(overrides = {}) {
  return createSlackNotifyClient({
    getConfig: () => ({
      enabled: true,
      channelId: "",
      notifyOnDone: true,
      notifyOnError: true,
      notifyOnPermission: true,
      outputMode: "off",
      ...overrides.config,
    }),
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "", ...overrides.secrets }),
    getLang: () => "en",
    fetchImpl: overrides.fetchImpl || makeFetch(okWebhook),
  });
}

test("isCompletion / dedupeKey gate on badge + completion event", () => {
  assert.ok(isCompletion({ id: "s", badge: "done", lastEvent: { rawEvent: "Stop", at: 1 } }));
  assert.ok(!isCompletion({ id: "s", badge: "thinking", lastEvent: { rawEvent: "Stop", at: 1 } }));
  assert.ok(!isCompletion({ id: "s", badge: "done", lastEvent: { rawEvent: "Random", at: 1 } }));
  assert.equal(dedupeKey({ id: "s", lastEvent: { rawEvent: "Stop", at: 5 } }), "s:Stop:5");
});

test("classifyHttpStatus maps common failures", () => {
  assert.equal(classifyHttpStatus(429), "rate-limited");
  assert.equal(classifyHttpStatus(403), "unauthorized");
  assert.equal(classifyHttpStatus(404), "not-found");
  assert.equal(classifyHttpStatus(500), "http-500");
});

test("classifySlackApiError normalizes retry/auth classes and bounds unknown codes", () => {
  assert.equal(classifySlackApiError("ratelimited"), "rate-limited");
  assert.equal(classifySlackApiError("rate_limited"), "rate-limited");
  assert.equal(classifySlackApiError("invalid_auth"), "unauthorized");
  assert.equal(classifySlackApiError("token_revoked"), "unauthorized");
  assert.equal(classifySlackApiError("channel_not_found"), "slack-channel_not_found");
  assert.equal(classifySlackApiError("BAD VALUE!"), "slack-bad-value");
  assert.ok(classifySlackApiError("x".repeat(200)).length <= "slack-".length + 64);
});

test("getStatus reflects readiness and transport", () => {
  const client = baseClient();
  const s = client.getStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.configured, true);
  assert.equal(s.transportConfigured, true);
  assert.equal(s.ready, true);
  assert.equal(s.transport, "webhook");
  assert.equal(s.supportsApproval, false);
});

test("getStatus does not call a stored bot token configured without a channel", () => {
  const client = createSlackNotifyClient({
    getConfig: () => ({ enabled: false, channelId: "" }),
    getSecrets: () => ({ webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" }),
  });
  const status = client.getStatus();
  assert.equal(status.credentialsPresent, true);
  assert.equal(status.transportConfigured, false);
  assert.equal(status.configured, false);
  assert.equal(status.ready, false);
  assert.equal(status.transport, null);
});

test("sendTest posts a webhook payload and reports ok", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  const res = await client.sendTest();
  assert.equal(res.status, "ok");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, WEBHOOK);
  assert.ok(Array.isArray(fetchImpl.calls[0].body.blocks));
});

test("bot transport posts to chat.postMessage with auth + channel", async () => {
  const fetchImpl = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) }));
  const client = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" },
    fetchImpl,
  });
  const res = await client.sendMessage({ text: "hi", blocks: [] });
  assert.equal(res.ok, true);
  assert.equal(res.messageId, "1.2");
  const call = fetchImpl.calls[0];
  assert.ok(call.url.includes("chat.postMessage"));
  assert.equal(call.body.channel, "C99");
  assert.match(call.headers.authorization, /^Bearer xoxb-/);
});

test("chat.postMessage ok:false surfaces the slack error", async () => {
  const fetchImpl = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: "channel_not_found" }) }));
  const client = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" },
    fetchImpl,
  });
  const res = await client.sendMessage({ text: "hi", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "slack-channel_not_found");
});

test("unconfigured client degrades without throwing", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = createSlackNotifyClient({
    getConfig: () => ({ enabled: true }),
    getSecrets: () => ({}),
    fetchImpl,
  });
  const res = await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "missing-secret");
  assert.equal(fetchImpl.calls.length, 0); // never hit the network
  const test = await client.sendTest();
  assert.equal(test.status, "error");
});

// A 3xx from either endpoint would otherwise move the request — and, on the bot
// transport, the Authorization header — to a host the webhook pin never vetted.
test("outbound requests refuse to follow redirects", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(fetchImpl.calls[0].opts.redirect, "error");

  const botFetch = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) }));
  const bot = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" },
    fetchImpl: botFetch,
  });
  await bot.sendMessage({ text: "x", blocks: [] });
  assert.equal(botFetch.calls[0].opts.redirect, "error");
});

test("a redirect rejection is caught like any other transport failure", async () => {
  // What fetch actually does with redirect: "error" — reject, not resolve.
  const fetchImpl = makeFetch(() => { throw new TypeError("unexpected redirect"); });
  const client = baseClient({ fetchImpl });
  const res = await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "network");
});

test("network failure is caught and classified", async () => {
  const fetchImpl = makeFetch(() => { throw new Error("boom"); });
  const client = baseClient({ fetchImpl });
  const res = await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "network");
});

test("onSnapshot primes on first call, then sends once per new event", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  const snap = (at) => ({ sessions: [{ id: "s1", badge: "done", displayTitle: "T", lastEvent: { rawEvent: "Stop", at } }] });
  client.onSnapshot(snap(1)); // prime — no send
  client.onSnapshot(snap(1)); // same event — deduped
  client.onSnapshot(snap(2)); // new event — one send
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchImpl.calls.length, 1);
});

test("onSnapshot honors per-event gating", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ config: { notifyOnError: false }, fetchImpl });
  // prime with an unrelated running session so the map is primed
  client.onSnapshot({ sessions: [] });
  client.onSnapshot({ sessions: [{ id: "e1", badge: "interrupted", displayTitle: "T", lastEvent: { rawEvent: "ApiError", at: 1 } }] });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchImpl.calls.length, 0); // error notifications disabled
});

test("notifyPermissionRequest respects the toggle and readiness", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  const res = await client.notifyPermissionRequest({ title: "needs you", toolName: "Bash" });
  assert.equal(res.ok, true);
  assert.equal(fetchImpl.calls.length, 1);

  const fetchImpl2 = makeFetch(okWebhook);
  const off = baseClient({ config: { notifyOnPermission: false }, fetchImpl: fetchImpl2 });
  const res2 = await off.notifyPermissionRequest({ title: "x" });
  assert.equal(res2.ok, false);
  assert.equal(fetchImpl2.calls.length, 0);
});

// Defence in depth. The formatter redacts what it renders, but sendMessage is
// the last place the payload can be inspected before it leaves the process, and
// the one place that knows the *currently configured* credentials. A value that
// reached a field the formatter never sanitised — or a future caller that builds
// its own message — must still not carry the webhook out to the channel that
// webhook unlocks.
test("the configured webhook never survives into the outbound body", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  // Straight into sendMessage, so the formatter's redaction is bypassed
  // entirely and only the last-mile scrub can catch it.
  await client.sendMessage({ text: `deploy ${WEBHOOK} now`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `see ${WEBHOOK}` } },
  ] });

  const raw = JSON.stringify(fetchImpl.calls[0].body);
  assert.ok(!raw.includes(WEBHOOK), "the webhook URL must not appear in the body");
  assert.ok(raw.includes("redacted"), "it should be visibly redacted, not silently dropped");
  // The POST target is still the real webhook — only the payload is scrubbed.
  assert.equal(fetchImpl.calls[0].url, WEBHOOK);
});

test("the configured bot token never survives into the outbound body", async () => {
  const token = "xoxb-123456789-abcdefghij";
  const fetchImpl = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) }));
  const client = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: token },
    fetchImpl,
  });
  await client.sendMessage({ text: `token is ${token}`, blocks: [] });

  const raw = JSON.stringify(fetchImpl.calls[0].body);
  assert.ok(!raw.includes(token), "the bot token must not appear in the body");
  // It still authenticates the request.
  assert.match(fetchImpl.calls[0].headers.authorization, /^Bearer xoxb-/);
});

// Slack unfurls links by default and fetches whatever URL a message contains,
// pulling title/preview/thumbnail into the channel. Slack's own security guidance
// calls out LLM-derived URLs as an exfiltration risk, and agent output is exactly
// that, so both transports opt out.
test("link and media unfurling are disabled on both transports", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(fetchImpl.calls[0].body.unfurl_links, false);
  assert.equal(fetchImpl.calls[0].body.unfurl_media, false);

  const botFetch = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) }));
  const bot = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" },
    fetchImpl: botFetch,
  });
  await bot.sendMessage({ text: "x", blocks: [] });
  assert.equal(botFetch.calls[0].body.unfurl_links, false);
  assert.equal(botFetch.calls[0].body.unfurl_media, false);
});

// The review asked for this specific shape: put the credential in every field an
// agent or user can influence, then assert on the *final serialized fetch body*
// rather than on any intermediate string.
test("no field can carry the webhook out — title, output, metadata, permission detail", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ config: { outputMode: "full" }, fetchImpl });

  client.onSnapshot({ sessions: [] }); // prime
  client.onSnapshot({ sessions: [{
    id: "s1",
    badge: "done",
    displayTitle: `ship ${WEBHOOK}`,
    cwd: `/srv/${WEBHOOK}`,
    host: WEBHOOK,
    agentId: "claude-code",
    assistantLastOutput: `curl -X POST ${WEBHOOK}`,
    lastEvent: { rawEvent: "Stop", at: 2 },
  }] });
  await new Promise((r) => setTimeout(r, 30));

  await client.notifyPermissionRequest({
    title: `approve ${WEBHOOK}`,
    toolName: "Bash",
    agentId: "claude-code",
    folder: `/w/${WEBHOOK}`,
    summary: `post to ${WEBHOOK}`,
  });

  assert.ok(fetchImpl.calls.length >= 2, "both a completion and a permission message were sent");
  for (const call of fetchImpl.calls) {
    const raw = JSON.stringify(call.body);
    assert.ok(!raw.includes(WEBHOOK), `webhook leaked into: ${raw.slice(0, 200)}`);
    // The distinctive path segment must not survive in pieces either.
    assert.ok(!raw.includes("/services/T/B/xxx"), "the secret path segment leaked");
  }
});

// ── Delivery is a queue, not a fan-out ──────────────────────────────────────
// Review item 2. Previously every completion in a snapshot was dispatched in
// parallel with the dedupe key committed *before* the send, so a 429 or a blip
// lost the message permanently and replaying the snapshot skipped it.

function queueClient(overrides = {}) {
  return createSlackNotifyClient({
    getConfig: () => ({ enabled: true, notifyOnDone: true, notifyOnError: true,
      notifyOnPermission: true, outputMode: "off", ...overrides.config }),
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "" }),
    getLang: () => "en",
    retryBaseMs: 0, // deterministic: no real waiting in tests
    ...overrides,
  });
}

const doneSnap = (ids, at = 1) => ({
  sessions: ids.map((id) => ({ id, badge: "done", displayTitle: id, lastEvent: { rawEvent: "Stop", at } })),
});

test("completions are delivered one at a time, not fired in parallel", async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const fetchImpl = makeFetch(async () => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return okWebhook();
  });
  const client = queueClient({ fetchImpl });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["a", "b", "c"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(maxConcurrent, 1, "a burst must not open three sockets at once");
});

test("a transient failure is retried instead of being lost", async () => {
  let n = 0;
  const fetchImpl = makeFetch(() => {
    n += 1;
    if (n === 1) return { ok: false, status: 503, text: async () => "busy" };
    return okWebhook();
  });
  const client = queueClient({ fetchImpl });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["s1"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 2, "the 503 should be retried once and then succeed");
});

test("429 waits for Retry-After before retrying", async () => {
  const waits = [];
  let n = 0;
  const fetchImpl = makeFetch(() => {
    n += 1;
    if (n === 1) {
      return { ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "2" : null) }, text: async () => "" };
    }
    return okWebhook();
  });
  const client = queueClient({ fetchImpl, sleepImpl: (ms) => { waits.push(ms); return Promise.resolve(); } });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["s1"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(waits[0], 2000, "Retry-After is seconds; honour it rather than the default backoff");
});

test("a permanent 4xx is not retried", async () => {
  const fetchImpl = makeFetch(() => ({ ok: false, status: 404, text: async () => "no_service" }));
  const client = queueClient({ fetchImpl });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["s1"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 1, "a revoked webhook must not loop");
});

test("retries are capped, and a give-up does not re-enqueue forever", async () => {
  const fetchImpl = makeFetch(() => ({ ok: false, status: 500, text: async () => "boom" }));
  const client = queueClient({ fetchImpl, maxAttempts: 3 });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["s1"], 2));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 3, "attempts are bounded");

  // Replaying the same snapshot must not restart the cycle.
  client.onSnapshot(doneSnap(["s1"], 2));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 3, "the exhausted event is not retried on replay");
});

test("the queue is bounded and drops the oldest rather than growing without limit", async () => {
  const warnings = [];
  const fetchImpl = makeFetch(async () => { await new Promise((r) => setTimeout(r, 3)); return okWebhook(); });
  const client = queueClient({
    fetchImpl,
    maxQueue: 3,
    log: (level, message) => { if (level === "warn") warnings.push(message); },
  });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["a", "b", "c", "d", "e", "f", "g", "h"], 2));
  await client.drained();

  assert.ok(fetchImpl.calls.length <= 4, `bounded, got ${fetchImpl.calls.length}`);
  assert.ok(warnings.some((w) => /queue/i.test(w)), "dropping must be visible, not silent");
});

test("a repeat snapshot does not enqueue an event that is still in flight", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = makeFetch(async () => { await gate; return okWebhook(); });
  const client = queueClient({ fetchImpl });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["s1"], 2));
  client.onSnapshot(doneSnap(["s1"], 2)); // same event, still sending
  release();
  await client.drained();

  assert.equal(fetchImpl.calls.length, 1);
});

test("queue overflow never removes the active item or silently leaks the next dedupe key", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const fetchImpl = makeFetch(async () => {
    calls += 1;
    if (calls === 1) await firstGate;
    return okWebhook();
  });
  const warnings = [];
  const client = queueClient({
    fetchImpl,
    maxQueue: 2,
    log: (level, message, meta) => {
      if (level === "warn") warnings.push({ message, meta });
    },
  });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["a", "b", "c", "d"], 2));

  assert.equal(fetchImpl.calls.length, 1, "a is active before the burst overflows pending work");
  releaseFirst();
  await client.drained();

  assert.equal(fetchImpl.calls.length, 2, "strict capacity=2 retains the active item plus the newest pending item");
  assert.match(fetchImpl.calls[0].body.text, /a/);
  assert.match(fetchImpl.calls[1].body.text, /d/);
  assert.deepEqual(
    warnings.filter((entry) => /queue full/i.test(entry.message)).map((entry) => entry.meta.id),
    ["b", "c"],
    "every overflow drop is explicit and attributed to the item that was dropped"
  );
  assert.equal(client._lastNotified.get("c"), "c:Stop:2", "the formerly leaked item is settled");

  client.onSnapshot(doneSnap(["a", "b", "c", "d"], 2));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 2, "settled overflow drops are not replayed forever");
});

test("capacity one drops and settles an incoming permission while another item is active", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const fetchImpl = makeFetch(async () => {
    await firstGate;
    return okWebhook();
  });
  const warnings = [];
  const client = queueClient({
    fetchImpl,
    maxQueue: 1,
    log: (level, message, meta) => {
      if (level === "warn") warnings.push({ message, meta });
    },
  });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["active"], 2));
  const permission = await client.notifyPermissionRequest({ title: "blocked permission", toolName: "Bash" });
  assert.equal(permission.errorClass, "queue-full");
  assert.ok(warnings.some((entry) => /permission.*queue full/i.test(entry.message)));
  releaseFirst();
  await client.drained();
  assert.equal(fetchImpl.calls.length, 1);
});

test("permission notifications share completion FIFO and bounded retry", async () => {
  let call = 0;
  const fetchImpl = makeFetch(() => {
    call += 1;
    if (call === 1) return { ok: false, status: 503, text: async () => "busy" };
    return okWebhook();
  });
  const client = queueClient({ fetchImpl, maxAttempts: 3 });
  client.prime({ sessions: [] });

  const permission = client.notifyPermissionRequest({ title: "needs approval", toolName: "Bash" });
  client.onSnapshot(doneSnap(["after-permission"], 2));
  assert.equal((await permission).ok, true);
  await client.drained();

  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(fetchImpl.calls[0].body.text, fetchImpl.calls[1].body.text, "permission is retried in place");
  assert.match(fetchImpl.calls[2].body.text, /after-permission/, "later completion waits behind the retry");
});

test("bot HTTP 429 is classified before its JSON body and honours Retry-After", async () => {
  const waits = [];
  let call = 0;
  const fetchImpl = makeFetch(() => {
    call += 1;
    if (call === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => (String(name).toLowerCase() === "retry-after" ? "2" : null) },
        text: async () => JSON.stringify({ ok: false, error: "ratelimited" }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) };
  });
  const client = queueClient({
    config: { channelId: "C99" },
    getSecrets: () => ({ webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" }),
    fetchImpl,
    sleepImpl: (ms) => { waits.push(ms); return Promise.resolve(); },
  });

  const result = await client.notifyPermissionRequest({ title: "needs approval", toolName: "Bash" });
  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(waits, [2000]);
});

test("bot JSON ratelimited on HTTP 200 is normalized into the retry class", async () => {
  let call = 0;
  const fetchImpl = makeFetch(() => {
    call += 1;
    if (call === 1) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: "ratelimited" }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) };
  });
  const client = queueClient({
    config: { channelId: "C99" },
    getSecrets: () => ({ webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" }),
    fetchImpl,
  });

  assert.equal((await client.notifyPermissionRequest({ title: "x", toolName: "Bash" })).ok, true);
  assert.equal(fetchImpl.calls.length, 2);
});

test("bot HTTP 5xx remains retryable even when Slack also returns an error body", async () => {
  let call = 0;
  const fetchImpl = makeFetch(() => {
    call += 1;
    if (call === 1) {
      return { ok: false, status: 500, text: async () => JSON.stringify({ ok: false, error: "fatal_error" }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) };
  });
  const client = queueClient({
    config: { channelId: "C99" },
    getSecrets: () => ({ webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" }),
    fetchImpl,
  });

  assert.equal((await client.notifyPermissionRequest({ title: "x", toolName: "Bash" })).ok, true);
  assert.equal(fetchImpl.calls.length, 2);
});

test("an automatic retry is cancelled instead of crossing to a changed webhook", async () => {
  let secrets = { webhookUrl: WEBHOOK, botToken: "" };
  let revision = 1;
  const replacement = "https://hooks.slack.com/services/T/B/replacement";
  const fetchImpl = makeFetch(() => ({ ok: false, status: 503, text: async () => "busy" }));
  const client = queueClient({
    getSecrets: () => secrets,
    getConfigRevision: () => revision,
    fetchImpl,
    sleepImpl: () => {
      secrets = { webhookUrl: replacement, botToken: "" };
      revision += 1;
      return Promise.resolve();
    },
  });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["old-route"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, WEBHOOK);
  assert.equal(client._lastNotified.get("old-route"), "old-route:Stop:2");
});

test("config revision cancels disable-and-reenable even when the destination returns to the same value", async () => {
  let revision = 7;
  const fetchImpl = makeFetch(() => ({ ok: false, status: 503, text: async () => "busy" }));
  const client = queueClient({
    getConfigRevision: () => revision,
    fetchImpl,
    sleepImpl: () => {
      // The final config/destination is byte-for-byte identical; only the
      // monotonic main-process revision can prove that it changed in between.
      revision += 2;
      return Promise.resolve();
    },
  });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["old-generation"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(client._lastNotified.get("old-generation"), "old-generation:Stop:2");
});

test("destination digest catches an out-of-band secret change without a revision bump", async () => {
  let secrets = { webhookUrl: WEBHOOK, botToken: "" };
  const fetchImpl = makeFetch(() => ({ ok: false, status: 503, text: async () => "busy" }));
  const client = queueClient({
    getSecrets: () => secrets,
    fetchImpl,
    sleepImpl: () => {
      secrets = { webhookUrl: "https://hooks.slack.com/services/T/B/out-of-band", botToken: "" };
      return Promise.resolve();
    },
  });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["external-edit"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, WEBHOOK);
});

test("an enabled notifier settles completions while transport is missing instead of backfilling them later", async () => {
  let secrets = { webhookUrl: "", botToken: "" };
  const fetchImpl = makeFetch(okWebhook);
  const client = queueClient({ getSecrets: () => secrets, fetchImpl });
  client.prime({ sessions: [] });

  client.onSnapshot(doneSnap(["while-unconfigured"], 2));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(client._lastNotified.get("while-unconfigured"), "while-unconfigured:Stop:2");

  secrets = { webhookUrl: WEBHOOK, botToken: "" };
  client.onSnapshot(doneSnap(["while-unconfigured"], 2));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 0, "restoring credentials must not replay historical completion events");

  client.onSnapshot(doneSnap(["while-unconfigured"], 3));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 1, "a genuinely new completion still sends");
});

test("permission relevance is checked before its first send and a throwing predicate fails closed", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = queueClient({ fetchImpl });

  const irrelevant = await client.notifyPermissionRequest(
    { title: "already resolved", toolName: "Bash" },
    { isStillRelevant: () => false },
  );
  const throwing = await client.notifyPermissionRequest(
    { title: "predicate failed", toolName: "Bash" },
    { isStillRelevant: () => { throw new Error("stale entry lookup failed"); } },
  );

  assert.equal(irrelevant.errorClass, "cancelled");
  assert.equal(throwing.errorClass, "cancelled");
  assert.equal(fetchImpl.calls.length, 0);
});

test("permission relevance is checked again before retry", async () => {
  let relevant = true;
  const fetchImpl = makeFetch(() => ({ ok: false, status: 503, text: async () => "busy" }));
  const client = queueClient({
    fetchImpl,
    sleepImpl: () => { relevant = false; return Promise.resolve(); },
  });

  const result = await client.notifyPermissionRequest(
    { title: "resolved during backoff", toolName: "Bash" },
    { isStillRelevant: () => relevant },
  );
  assert.equal(result.errorClass, "cancelled");
  assert.equal(fetchImpl.calls.length, 1, "the stale request must not make its retry attempt");
});

test("Slack transient JSON errors retry on HTTP 200", async () => {
  for (const slackError of ["internal_error", "service_unavailable", "fatal_error", "request_timeout"]) {
    let call = 0;
    const fetchImpl = makeFetch(() => {
      call += 1;
      if (call === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: slackError }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) };
    });
    const client = queueClient({
      config: { channelId: "C99" },
      getSecrets: () => ({ webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" }),
      fetchImpl,
    });

    const result = await client.notifyPermissionRequest({ title: slackError, toolName: "Bash" });
    assert.equal(result.ok, true, slackError);
    assert.equal(fetchImpl.calls.length, 2, `${slackError} should retry once`);
  }
});

test("a 2xx response body read failure retries consistently for webhook and bot", async () => {
  for (const transport of ["webhook", "bot"]) {
    let call = 0;
    const fetchImpl = makeFetch(() => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => { throw new Error("body stream reset"); },
        };
      }
      return transport === "webhook"
        ? okWebhook()
        : { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) };
    });
    const client = queueClient({
      config: transport === "bot" ? { channelId: "C99" } : {},
      getSecrets: () => transport === "bot"
        ? { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" }
        : { webhookUrl: WEBHOOK, botToken: "" },
      fetchImpl,
    });

    assert.equal((await client.notifyPermissionRequest({ title: transport, toolName: "Bash" })).ok, true);
    assert.equal(fetchImpl.calls.length, 2, `${transport} should retry an unreadable successful response`);
  }
});

test("HTTP failure status remains authoritative when its body cannot be read", async () => {
  for (const transport of ["webhook", "bot"]) {
    const fetchImpl = makeFetch(() => ({
      ok: false,
      status: 404,
      text: async () => { throw new Error("body stream reset"); },
    }));
    const client = queueClient({
      config: transport === "bot" ? { channelId: "C99" } : {},
      getSecrets: () => transport === "bot"
        ? { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" }
        : { webhookUrl: WEBHOOK, botToken: "" },
      fetchImpl,
    });

    const result = await client.notifyPermissionRequest({ title: `deleted ${transport}`, toolName: "Bash" });
    assert.equal(result.errorClass, "not-found");
    assert.equal(fetchImpl.calls.length, 1, `${transport} permanent HTTP status must not become a body-read retry`);
  }
});

test("mixed automatic notifications preserve exact enqueue FIFO", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = queueClient({ fetchImpl, maxQueue: 5 });
  client.prime({ sessions: [] });

  const first = client.notifyPermissionRequest({ title: "fifo-one", toolName: "Bash" });
  const second = client.notifyPermissionRequest({ title: "fifo-two", toolName: "Bash" });
  client.onSnapshot(doneSnap(["fifo-three"], 2));
  await Promise.all([first, second]);
  await client.drained();

  assert.equal(fetchImpl.calls.length, 3);
  assert.match(fetchImpl.calls[0].body.text, /fifo-one/);
  assert.match(fetchImpl.calls[1].body.text, /fifo-two/);
  assert.match(fetchImpl.calls[2].body.text, /fifo-three/);
});

test("capacity three keeps the active item and exact newest pending survivor ids", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let call = 0;
  const fetchImpl = makeFetch(async () => {
    call += 1;
    if (call === 1) await firstGate;
    return okWebhook();
  });
  const dropped = [];
  const client = queueClient({
    fetchImpl,
    maxQueue: 3,
    log: (level, message, meta) => {
      if (level === "warn" && /queue full/i.test(message)) dropped.push(meta.id);
    },
  });
  client.prime({ sessions: [] });
  client.onSnapshot({
    sessions: ["cap-a", "cap-b", "cap-c", "cap-d", "cap-e"].map((id) => ({
      id,
      badge: "done",
      displayTitle: `title-${id}`,
      lastEvent: { rawEvent: "Stop", at: 2 },
    })),
  });
  releaseFirst();
  await client.drained();

  assert.deepEqual(dropped, ["cap-b", "cap-c"]);
  assert.equal(fetchImpl.calls.length, 3);
  assert.match(fetchImpl.calls[0].body.text, /title-cap-a/);
  assert.match(fetchImpl.calls[1].body.text, /title-cap-d/);
  assert.match(fetchImpl.calls[2].body.text, /title-cap-e/);
});

test("permanent completion failure settles, advances FIFO, and clears in-flight ownership", async () => {
  let call = 0;
  const fetchImpl = makeFetch(() => {
    call += 1;
    if (call === 1) return { ok: false, status: 404, text: async () => "no_service" };
    return okWebhook();
  });
  const client = queueClient({ fetchImpl });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["permanent-a", "after-permanent"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 2, "the permanent item is attempted once and does not block its successor");
  assert.equal(client._lastNotified.get("permanent-a"), "permanent-a:Stop:2");
  assert.equal(client._lastNotified.get("after-permanent"), "after-permanent:Stop:2");

  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["permanent-a"], 2));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 3, "after history pruning, the key can enqueue again only if in-flight was cleared");
});

test("timeout aborts each fetch and bounded retry settles with timeout", async () => {
  const signals = [];
  const fetchImpl = makeFetch((_url, opts) => new Promise((_resolve, reject) => {
    signals.push(opts.signal);
    opts.signal.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    }, { once: true });
  }));
  const client = queueClient({ fetchImpl, timeoutMs: 5, maxAttempts: 2 });

  const result = await client.notifyPermissionRequest({ title: "timeout", toolName: "Bash" });
  assert.equal(result.errorClass, "timeout");
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(signals.every((signal) => signal && signal.aborted), "each attempt owns an aborted signal");
});

test("an abort while reading a successful response body is still classified as timeout", async () => {
  const fetchImpl = makeFetch((_url, opts) => ({
    ok: true,
    status: 200,
    text: () => new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("body aborted");
        err.name = "AbortError";
        reject(err);
      }, { once: true });
    }),
  }));
  const client = queueClient({ fetchImpl, timeoutMs: 5, maxAttempts: 1 });

  const result = await client.notifyPermissionRequest({ title: "body timeout", toolName: "Bash" });
  assert.equal(result.errorClass, "timeout");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].opts.signal.aborted, true);
});

test("Retry-After is clamped to the configured maximum delay", async () => {
  const waits = [];
  let call = 0;
  const fetchImpl = makeFetch(() => {
    call += 1;
    if (call === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => "999999" },
        text: async () => "rate_limited",
      };
    }
    return okWebhook();
  });
  const client = queueClient({
    fetchImpl,
    maxRetryDelayMs: 75,
    sleepImpl: (ms) => { waits.push(ms); return Promise.resolve(); },
  });

  assert.equal((await client.notifyPermissionRequest({ title: "clamp", toolName: "Bash" })).ok, true);
  assert.deepEqual(waits, [75]);
});

test("drained follows work enqueued by a settle continuation into the restarted drain", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = queueClient({ fetchImpl, maxQueue: 3 });
  const chained = client.notifyPermissionRequest({ title: "restart-one", toolName: "Bash" })
    .then(() => client.notifyPermissionRequest({ title: "restart-two", toolName: "Bash" }));

  await client.drained();
  await chained;
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[0].body.text, /restart-one/);
  assert.match(fetchImpl.calls[1].body.text, /restart-two/);
});

test("bot destination digest includes the channel id", async () => {
  let channelId = "C-OLD";
  let call = 0;
  const fetchImpl = makeFetch(() => {
    call += 1;
    if (call === 1) return { ok: false, status: 503, text: async () => "busy" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) };
  });
  const client = createSlackNotifyClient({
    getConfig: () => ({
      enabled: true,
      channelId,
      notifyOnDone: true,
      notifyOnError: true,
      notifyOnPermission: true,
      outputMode: "off",
    }),
    getSecrets: () => ({ webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" }),
    fetchImpl,
    retryBaseMs: 0,
    sleepImpl: () => { channelId = "C-NEW"; return Promise.resolve(); },
  });

  const old = await client.notifyPermissionRequest({ title: "old channel", toolName: "Bash" });
  assert.equal(old.errorClass, "stale-config");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].body.channel, "C-OLD");

  const fresh = await client.notifyPermissionRequest({ title: "new channel", toolName: "Bash" });
  assert.equal(fresh.ok, true);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].body.channel, "C-NEW");
});

// ── Startup recovery ────────────────────────────────────────────────────────
// Clawd rebuilds a snapshot for sessions that survived a restart, but it only
// reached Dashboard/HUD. Slack's first snapshot was therefore a later Stop,
// which the unconditional priming branch swallowed.

test("prime records history without sending, so old completions are not backfilled", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = queueClient({ fetchImpl });
  client.prime(doneSnap(["old"], 1));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 0, "a completion that happened before startup is history");

  client.onSnapshot(doneSnap(["old"], 1));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 0, "and it stays history when the same snapshot arrives");
});

test("a session recovered as working still notifies when it later stops", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = queueClient({ fetchImpl });
  // What startup recovery actually produces: live sessions, not completions.
  client.prime({ sessions: [{ id: "s1", badge: "working", displayTitle: "T", lastEvent: { rawEvent: "PreToolUse", at: 1 } }] });
  client.onSnapshot(doneSnap(["s1"], 5));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 1, "the first real completion after startup must be delivered");
});

test("startup recovery actually primes the notifier in main.js", () => {
  // The recovery path lives in main.js, which cannot be required here (Electron).
  // Without this, prime() could be perfectly correct and still never called —
  // exactly the failure mode the queue tests above cannot see.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const recoveryBlock = source.slice(source.indexOf("const recoveredSnapshot ="));
  assert.ok(recoveryBlock, "startup recovery block not found — did it move?");
  assert.match(
    recoveryBlock.slice(0, 900),
    /getSlackNotifyClient\(\)\.prime\(recoveredSnapshot\)/,
    "the recovered snapshot must be handed to the Slack notifier"
  );
});

test("main.js advances and injects the Slack configuration revision", () => {
  // The client can detect out-of-band destination changes by digest, but only
  // the composition root can prove that disable -> enable or a credential
  // change returned to the same bytes in between retries.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

  assert.match(source, /let slackNotifyConfigRevision = 0;/);
  assert.match(source, /getConfigRevision:\s*\(\) => slackNotifyConfigRevision/);
  assert.match(
    source,
    /if \(result && result\.status === "ok"\) \{\s*slackNotifyConfigRevision \+= 1;/,
    "a successful secret write must invalidate old automatic work"
  );
  assert.match(
    source,
    /subscribeKey\("slackNotify", \(\) => \{\s*slackNotifyConfigRevision \+= 1;/,
    "every committed Slack preference change must advance the generation"
  );
});

// ── Send Test during setup, and stable error codes (review item 3) ──────────

test("Send Test works while continuous notifications are still switched off", async () => {
  // Testing the connection is exactly what you do *before* turning sending on.
  const fetchImpl = makeFetch(okWebhook);
  const client = createSlackNotifyClient({
    getConfig: () => ({ enabled: false, notifyOnDone: true, notifyOnError: true, notifyOnPermission: true, outputMode: "off" }),
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "" }),
    getLang: () => "en",
    fetchImpl,
  });

  const res = await client.sendTest();
  assert.equal(res.status, "ok");
  assert.equal(fetchImpl.calls.length, 1);
});

test("Send Test is a direct diagnostic and does not enter automatic retry", async () => {
  const fetchImpl = makeFetch(() => ({ ok: false, status: 503, text: async () => "busy" }));
  const client = createSlackNotifyClient({
    getConfig: () => ({ enabled: false }),
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "" }),
    fetchImpl,
    maxAttempts: 4,
    retryBaseMs: 0,
  });

  const result = await client.sendTest();
  assert.equal(result.status, "error");
  assert.equal(result.code, "http-503");
  assert.equal(fetchImpl.calls.length, 1);
});

test("a disabled notifier still sends nothing on its own", async () => {
  // The switch must keep meaning something: Send Test is an explicit action,
  // completions and permissions are not.
  const fetchImpl = makeFetch(okWebhook);
  const client = createSlackNotifyClient({
    getConfig: () => ({ enabled: false, notifyOnDone: true, notifyOnError: true, notifyOnPermission: true, outputMode: "off" }),
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "" }),
    fetchImpl,
    retryBaseMs: 0,
  });
  client.prime({ sessions: [] });
  client.onSnapshot({ sessions: [{ id: "s1", badge: "done", displayTitle: "T", lastEvent: { rawEvent: "Stop", at: 2 } }] });
  await client.drained();
  await client.notifyPermissionRequest({ title: "x", toolName: "Bash" });

  assert.equal(fetchImpl.calls.length, 0);
});

test("Send Test reports a stable code the UI can localize", async () => {
  // "Slack rejected the message" for every failure tells the user nothing about
  // what to change. The code names the cause; the message stays English for logs.
  const cases = [
    [{ ok: false, status: 404, text: async () => "no_service" }, "not-found"],
    [{ ok: false, status: 403, text: async () => "invalid_token" }, "unauthorized"],
    [{ ok: false, status: 429, text: async () => "" }, "rate-limited"],
  ];
  for (const [response, expected] of cases) {
    const client = baseClient({ fetchImpl: makeFetch(() => response) });
    const res = await client.sendTest();
    assert.equal(res.status, "error");
    assert.equal(res.code, expected, `HTTP ${response.status} should surface as ${expected}`);
  }

  const unconfigured = createSlackNotifyClient({ getConfig: () => ({ enabled: true }), getSecrets: () => ({}) });
  assert.equal((await unconfigured.sendTest()).code, "missing-secret");
});
