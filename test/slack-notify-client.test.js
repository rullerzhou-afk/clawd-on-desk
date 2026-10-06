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

// test/run-tests.js passes --test-timeout=120000, so a bare `await` on a promise
// a regression never settles only fails after the 120s per-test budget -- and
// without saying which lane or step stalled. Every assertion that depends on a
// lane making progress goes through this, so a regression fails in ~2s with the
// label.
function within(ms, promise, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(`<<TIMEOUT: ${label}>>`), ms)),
  ]);
}

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

// doneSnap entries carry NO assistant output, so buildCompletionMessage renders
// them identically whether or not outputMode is "full". Use this when the test
// is about the output section itself.
const doneSnapWithOutput = (ids, at = 1) => ({
  sessions: ids.map((id) => ({
    id, badge: "done", displayTitle: id,
    assistantLastOutput: `answer for ${id}`,
    lastEvent: { rawEvent: "Stop", at },
  })),
});

// The other completion family: badge "interrupted" with a failure event, which
// enqueues kind "completion-error". It must live on the completion lane and be
// governed by notifyOnError, exactly like a done notification.
const errorSnap = (ids, at = 1) => ({
  sessions: ids.map((id) => ({
    id, badge: "interrupted", displayTitle: id,
    lastEvent: { rawEvent: "StopFailure", at },
  })),
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

// B3: capacity is per lane, so an in-flight completion must not consume the
// permission lane's only slot. On a shared queue this returned queue-full.
test("B3 maxQueue one: an in-flight completion leaves the permission lane its own slot", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = makeFetch(async (_url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (body && /Permission needed/.test(body.text || "")) return okWebhook();
    await gate;
    return okWebhook();
  });
  const client = queueClient({ fetchImpl, maxQueue: 1 });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["active"], 2));

  try {
    const permission = await within(
      2000,
      client.notifyPermissionRequest({ title: "not dropped", toolName: "Bash" }),
      "B3 permission",
    );
    assert.equal(permission.ok, true, "the permission lane has its own capacity");
  } finally {
    release();
  }
  await within(2000, client.drained(), "B3 drain");
});

// B9: a permission transient failure is retried in place, ahead of the next
// queued permission (lane-internal FIFO). Unlike the old shared-FIFO test this
// no longer claims a later completion waits behind it.
test("B9 a permission transient failure is retried in place", async () => {
  let call = 0;
  const fetchImpl = makeFetch(() => {
    call += 1;
    if (call === 1) return { ok: false, status: 503, text: async () => "busy" };
    return okWebhook();
  });
  const client = queueClient({ fetchImpl, maxAttempts: 3 });
  client.prime({ sessions: [] });

  const first = client.notifyPermissionRequest({ title: "needs approval", toolName: "Bash" });
  const second = client.notifyPermissionRequest({ title: "second permission", toolName: "Bash" });
  const results = await within(2000, Promise.all([first, second]), "B9 permissions");

  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(fetchImpl.calls.length, 3);
  assert.match(fetchImpl.calls[0].body.text, /needs approval/);
  assert.equal(fetchImpl.calls[0].body.text, fetchImpl.calls[1].body.text, "permission is retried in place");
  assert.match(fetchImpl.calls[2].body.text, /second permission/, "the next permission follows the retry");
});

// ── Defect two: permission heads-ups get their own lane ──────────────────────

// B1: a completion whose fetch never returns used to head-of-line block the
// permission heads-up behind it. On a shared queue this times out here.
test("B1 a stalled completion does not hold back a permission heads-up", async () => {
  let releaseCompletion;
  const gate = new Promise((resolve) => { releaseCompletion = resolve; });
  let permissionLeftFirst = false;
  const fetchImpl = makeFetch(async (_url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (body && /Permission needed/.test(body.text || "")) {
      permissionLeftFirst = true;
      return okWebhook();
    }
    await gate;
    return okWebhook();
  });
  const client = queueClient({ fetchImpl });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["stalled"], 2));

  try {
    const permission = await within(
      2000,
      client.notifyPermissionRequest({ title: "comes first", toolName: "Bash" }),
      "B1 permission",
    );
    assert.equal(permission.ok, true);
    assert.equal(permissionLeftFirst, true, "the permission request left before the completion was released");
  } finally {
    releaseCompletion();
  }
  await within(2000, client.drained(), "B1 drain");
});

// F1: the OTHER completion kind (interrupted / error) must also live on the
// completion lane. If it did not, a stuck error notification would block the
// permission lane and re-create half of defect two.
test("F1 a stalled error completion also leaves the permission lane alone", async () => {
  let releaseCompletion;
  const gate = new Promise((resolve) => { releaseCompletion = resolve; });
  let permissionLeftFirst = false;
  const fetchImpl = makeFetch(async (_url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (body && /Permission needed/.test(body.text || "")) {
      permissionLeftFirst = true;
      return okWebhook();
    }
    await gate;
    return okWebhook();
  });
  const client = queueClient({ fetchImpl });
  client.prime({ sessions: [] });
  client.onSnapshot(errorSnap(["stalled-error"], 2));

  try {
    const permission = await within(
      2000,
      client.notifyPermissionRequest({ title: "error comes first", toolName: "Bash" }),
      "F1 permission",
    );
    assert.equal(permission.ok, true);
    assert.equal(permissionLeftFirst, true, "the permission left before the error completion was released");
  } finally {
    releaseCompletion();
  }
  await within(2000, client.drained(), "F1 drain");
});

// Y1: error completions are governed by notifyOnError, not notifyOnDone.
// automaticGateAllows must branch on kind, not reuse the done switch.
test("Y1 an error completion is cancelled when only notifyOnError is turned off", async () => {
  let config = { enabled: true, notifyOnDone: true, notifyOnError: true,
    notifyOnPermission: true, outputMode: "off" };
  let calls = 0;
  const warnings = [];
  const fetchImpl = makeFetch(() => {
    calls += 1;
    config = { ...config, notifyOnError: false }; // notifyOnDone stays on
    return { ok: false, status: 503, text: async () => "busy" };
  });
  const client = queueClient({
    getConfig: () => config,
    fetchImpl,
    log: (level, message) => { if (level === "warn") warnings.push(message); },
  });
  client.prime({ sessions: [] });
  client.onSnapshot(errorSnap(["error-off"], 2));
  await within(2000, client.drained(), "Y1 drain");

  assert.equal(fetchImpl.calls.length, 1, "the retry is stopped by the error switch");
  assert.equal(client._lastNotified.get("error-off"), "error-off:StopFailure:2");
  assert.ok(warnings.some((message) => /disabled/.test(message)), "the cancel is logged as disabled");
});

// B2: behind two completions that are permanently rate-limited the permission
// would only be reached after the user already answered at the desk, and the
// relevance check then cancels it. The virtual clock makes that measurable.
test("B2 a permission queued behind rate-limited completions goes out immediately", async () => {
  let now = 0;
  let permissionSentAt = null;
  const fetchImpl = makeFetch((_url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (body && /Permission needed/.test(body.text || "")) {
      permissionSentAt = now;
      return okWebhook();
    }
    return { ok: false, status: 429, headers: { get: () => "30" }, text: async () => "" };
  });
  const client = queueClient({
    fetchImpl,
    maxAttempts: 4,
    sleepImpl: (ms) => { now += ms; return Promise.resolve(); },
  });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["slow-1", "slow-2"], 2));

  const permission = await within(2000, client.notifyPermissionRequest(
    { title: "urgent", toolName: "Bash" },
    { isStillRelevant: () => now < 60000 }, // the user answers at virtual t=60s
  ), "B2 permission");

  assert.equal(permission.ok, true, "it must not wait behind the completion backlog");
  assert.equal(permissionSentAt, 0, "it goes out at virtual t=0");
  await within(2000, client.drained(), "B2 drain");
});

// B4: within one lane the bound is still active + pending, so the oldest
// pending permission is dropped and the drop is logged.
test("B4 the permission lane has its own bounded capacity", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = makeFetch(async () => { await gate; return okWebhook(); });
  const warnings = [];
  const client = queueClient({
    fetchImpl,
    maxQueue: 2,
    log: (level, message, meta) => { if (level === "warn") warnings.push({ message, meta }); },
  });
  client.prime({ sessions: [] });

  const p1 = client.notifyPermissionRequest({ title: "perm-1", toolName: "Bash" });
  const p2 = client.notifyPermissionRequest({ title: "perm-2", toolName: "Bash" });
  const p3 = client.notifyPermissionRequest({ title: "perm-3", toolName: "Bash" });
  // The overflow decision is synchronous at enqueue time; release now so the
  // two survivors can actually settle.
  release();

  const results = await within(2000, Promise.all([p1, p2, p3]), "B4 permissions");
  assert.equal(results[0].ok, true);
  assert.equal(results[1].errorClass, "queue-full", "the oldest pending permission is dropped");
  assert.equal(results[2].ok, true);
  await within(2000, client.drained(), "B4 drain");
  assert.ok(
    warnings.some((entry) => /queue full/i.test(entry.message) && entry.meta && entry.meta.kind === "permission"),
    "the drop is visible and attributed to the permission lane",
  );
  assert.equal(fetchImpl.calls.length, 2);
});

// B5: capacity one leaves no pending slot, so each lane drops the INCOMING item
// and settles it. That branch is live on both lanes and easy to leave untested.
test("B5 maxQueue one: each lane drops and settles the incoming item", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = makeFetch(async () => { await gate; return okWebhook(); });
  const client = queueClient({ fetchImpl, maxQueue: 1 });
  client.prime({ sessions: [] });

  // Permission lane: the first holds the lane, the second has no slot.
  const firstPermission = client.notifyPermissionRequest({ title: "holds-permission-lane", toolName: "Bash" });
  const secondPermission = await within(
    2000,
    client.notifyPermissionRequest({ title: "no-permission-slot", toolName: "Bash" }),
    "B5 permission",
  );
  assert.equal(secondPermission.errorClass, "queue-full");

  // Completion lane: the first holds the lane, the second is dropped and settled.
  client.onSnapshot(doneSnap(["holds-completion"], 2));
  client.onSnapshot(doneSnap(["holds-completion", "no-completion-slot"], 3));
  assert.equal(client._lastNotified.get("no-completion-slot"), "no-completion-slot:Stop:3");

  release();
  await within(2000, Promise.all([firstPermission, client.drained()]), "B5 drain");

  // Prove the dropped item also left the in-flight set: forget it, then replay
  // the same event. It can only be sent again if its key is no longer owned.
  // (Behavioural check, mirroring the permanent-failure test; no test seam.)
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["no-completion-slot"], 3));
  await within(2000, client.drained(), "B5 replay drain");

  assert.ok(
    fetchImpl.calls.some((call) => /no-completion-slot/.test(call.body.text)),
    "a settled drop must not stay in flight, or the replay could never send",
  );
});

// R1: the in-flight key must be released for error completions too, not only
// for done ones -- otherwise a later genuine retry of the same error event is
// silently swallowed as a duplicate. Same forget-and-replay technique as B5.
test("R1 a settled error completion also leaves the in-flight set", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = queueClient({ fetchImpl });
  client.prime({ sessions: [] });

  client.onSnapshot(errorSnap(["settled-error"], 2));
  await within(2000, client.drained(), "R1 first drain");
  assert.equal(fetchImpl.calls.length, 1, "the error completion is delivered");

  // Forget the settled event, then replay it: it can only send again if its key
  // is no longer owned in-flight.
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(errorSnap(["settled-error"], 2));
  await within(2000, client.drained(), "R1 replay drain");
  assert.equal(fetchImpl.calls.length, 2, "the replay must be able to send again");
});

// B6: drained() is the barrier behind most call-count assertions in this file.
// When the permission lane was added its terms went in untested: dropping them
// used to leave every test green.
test("B6 drained() waits for the permission lane, not just the completion lane", async () => {
  let releasePermission;
  const gate = new Promise((resolve) => { releasePermission = resolve; });
  const fetchImpl = makeFetch(async () => { await gate; return okWebhook(); });
  const client = queueClient({ fetchImpl });
  client.prime({ sessions: [] });
  const pending = client.notifyPermissionRequest({ title: "in flight", toolName: "Bash" });

  const outcome = await Promise.race([
    client.drained().then(() => "returned"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 40)),
  ]);
  assert.equal(outcome, "still waiting", "drained() must not return while a permission is in flight");

  releasePermission();
  await within(2000, Promise.all([pending, client.drained()]), "B6 drain");
  assert.equal(fetchImpl.calls.length, 1);
});

// B7: settle() resolves the item promise before the lane's .finally runs. A
// continuation that enqueues the next permission therefore relies on the
// .finally restart; drained() would mask that by restarting a pending lane
// itself, so this test deliberately does not call it first.
test("B7 the permission lane restarts from its finally when a continuation enqueues", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = queueClient({ fetchImpl, maxQueue: 3 });
  const chained = client.notifyPermissionRequest({ title: "restart-one", toolName: "Bash" })
    .then(() => client.notifyPermissionRequest({ title: "restart-two", toolName: "Bash" }));

  const second = await within(2000, chained, "B7 chained permission");
  assert.equal(second.ok, true);
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[0].body.text, /restart-one/);
  assert.match(fetchImpl.calls[1].body.text, /restart-two/);
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

// ── Defect one: a settings commit must not discard the backlog ──────────────
// These tests model how main.js composes the client: any slackNotify commit and
// every successful secrets write bumps a monotonic revision, which was injected
// as getConfigRevision and compared before every send. The option no longer
// exists (the client ignores it), and it is still passed here on purpose so that
// re-adding the compare makes them red again.

// A1: an unrelated preference change is the common case -- any slackNotify write
// bumped the revision, and a revision compare threw away the whole backlog.
test("A1 an unrelated preference change keeps the queued completions", async () => {
  let revision = 0;
  let config = { enabled: true, notifyOnDone: true, notifyOnError: true,
    notifyOnPermission: true, outputMode: "off" };
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls += 1;
    if (calls === 1) {
      // A settings commit lands during the first send.
      revision += 1;
      config = { ...config, notifyOnPermission: false }; // unrelated to completions
      return { ok: false, status: 503, text: async () => "busy" };
    }
    return okWebhook();
  });
  const client = createSlackNotifyClient({
    getConfig: () => config,
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "" }),
    getLang: () => "en",
    getConfigRevision: () => revision,
    retryBaseMs: 0,
    fetchImpl,
  });
  const ids = ["queued-1", "queued-2", "queued-3", "queued-4", "queued-5", "queued-6"];
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(ids, 2));
  await within(2000, client.drained(), "A1 drain");

  assert.equal(fetchImpl.calls.length, 7, "one 503 retry plus six deliveries");
  for (const id of ids) {
    assert.ok(
      fetchImpl.calls.some((call) => call.body.text.includes(id)),
      `${id} was delivered`,
    );
    assert.equal(client._lastNotified.get(id), `${id}:Stop:2`);
  }
});

// A2: the user re-pastes the identical webhook while Slack is rate-limiting.
// The secret bytes never change, so only a revision compare could cancel it.
test("A2 re-saving the same webhook during a 429 wait delivers every item exactly once", async () => {
  let revision = 0;
  const config = { enabled: true, notifyOnDone: true, notifyOnError: true,
    notifyOnPermission: true, outputMode: "off" };
  let calls = 0;
  const delivered = [];
  const fetchImpl = makeFetch(() => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 429, headers: { get: () => "30" }, text: async () => "" };
    }
    return okWebhook();
  });
  const client = createSlackNotifyClient({
    getConfig: () => config,
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "" }),
    getLang: () => "en",
    getConfigRevision: () => revision,
    retryBaseMs: 0,
    fetchImpl,
    sleepImpl: () => {
      revision += 1; // identical webhook, but the composition root bumped it
      return Promise.resolve();
    },
  });
  const ids = ["retry-1", "retry-2", "retry-3", "retry-4", "retry-5"];
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(ids, 2));
  await within(2000, client.drained(), "A2 drain");

  // Only the first attempt 429s; the other five calls are the deliveries.
  for (const call of fetchImpl.calls.slice(1)) {
    delivered.push((call.body.text.match(/retry-[1-5]/) || [null])[0]);
  }
  assert.deepEqual([...delivered].sort(), [...ids].sort());
  assert.equal(fetchImpl.calls.length, 6, "one 429 plus five deliveries, no duplicate");
});

// A3: a body with no assistant output renders identically either way. Deriving
// carriesOutput from outputMode cancelled these on narrowing and turned
// "6 queued, 4 dropped" into "6 queued, 6 dropped".
test("A3 narrowing outputMode keeps a queued body that carries no output", async () => {
  let revision = 0;
  let config = { enabled: true, notifyOnDone: true, notifyOnError: true,
    notifyOnPermission: true, outputMode: "full" };
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls += 1;
    if (calls === 1) {
      revision += 1;
      config = { ...config, outputMode: "off" };
      return { ok: false, status: 503, text: async () => "busy" };
    }
    return okWebhook();
  });
  const client = createSlackNotifyClient({
    getConfig: () => config,
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "" }),
    getLang: () => "en",
    getConfigRevision: () => revision,
    retryBaseMs: 0,
    fetchImpl,
  });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["no-output"], 2));
  await within(2000, client.drained(), "A3 drain");

  assert.equal(
    JSON.stringify(fetchImpl.calls[0].body).includes("Assistant output"),
    false,
    "premise: this body never carried assistant output",
  );
  assert.equal(fetchImpl.calls.length, 2, "a body with nothing to protect must still be retried");
});

// A4: the retained privacy invariant. A body formatted with the output still
// carries it after the user turns output off, so narrowing must cancel it.
test("A4 narrowing outputMode cancels a queued body that already carries the output", async () => {
  let revision = 0;
  let config = { enabled: true, notifyOnDone: true, notifyOnError: true,
    notifyOnPermission: true, outputMode: "full" };
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls += 1;
    if (calls === 1) {
      revision += 1;
      config = { ...config, outputMode: "off" };
      return { ok: false, status: 503, text: async () => "busy" };
    }
    return okWebhook();
  });
  const client = createSlackNotifyClient({
    getConfig: () => config,
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "" }),
    getLang: () => "en",
    getConfigRevision: () => revision,
    retryBaseMs: 0,
    fetchImpl,
  });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnapWithOutput(["carries-output"], 2));
  await within(2000, client.drained(), "A4 drain");

  assert.match(
    JSON.stringify(fetchImpl.calls[0].body),
    /answer for carries-output/,
    "premise: this body really carried the assistant output",
  );
  assert.equal(fetchImpl.calls.length, 1, "the opted-out body must not be retried");
  assert.equal(client._lastNotified.get("carries-output"), "carries-output:Stop:2");
});

// A5: widening is a pure loss, so the backlog must survive it.
test("A5 widening outputMode does not discard the queued backlog", async () => {
  let revision = 0;
  let config = { enabled: true, notifyOnDone: true, notifyOnError: true,
    notifyOnPermission: true, outputMode: "off" };
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls += 1;
    if (calls === 1) {
      revision += 1;
      config = { ...config, outputMode: "full" };
      return { ok: false, status: 503, text: async () => "busy" };
    }
    return okWebhook();
  });
  const client = createSlackNotifyClient({
    getConfig: () => config,
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "" }),
    getLang: () => "en",
    getConfigRevision: () => revision,
    retryBaseMs: 0,
    fetchImpl,
  });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["widened"], 2));
  await within(2000, client.drained(), "A5 drain");

  assert.equal(fetchImpl.calls.length, 2, "widening is a pure loss; the retry proceeds");
});

// F2: the default configuration has outputMode "off". A completion that HAS
// assistant output must still be delivered -- the output is simply omitted from
// the body. Dropping the `includeOutput &&` guard would cancel it before the
// first attempt, which is the most common configuration there is.
test("F2 outputMode off still delivers a completion that has assistant output", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = queueClient({ config: { outputMode: "off" }, fetchImpl });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnapWithOutput(["has-output"], 2));
  await within(2000, client.drained(), "F2 drain");

  assert.equal(fetchImpl.calls.length, 1);
  const body = JSON.stringify(fetchImpl.calls[0].body);
  assert.equal(body.includes("Assistant output"), false, "premise: outputMode off omits the section");
  assert.equal(body.includes("answer for has-output"), false, "premise: the output text is absent");
});

// A7: with the revision gone, the per-send automaticGateAllows check is the
// only thing that stops a queued item after its switch is turned off.
test("A7a a queued completion is cancelled when the master switch goes off", async () => {
  let config = { enabled: true, notifyOnDone: true, notifyOnError: true,
    notifyOnPermission: true, outputMode: "off" };
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls += 1;
    config = { ...config, enabled: false };
    return { ok: false, status: 503, text: async () => "busy" };
  });
  const client = queueClient({ getConfig: () => config, fetchImpl });
  client.prime({ sessions: [] });
  // A real backlog: the switch goes off while the first item is on its first
  // attempt. Every later item must also be stopped when its turn comes.
  const ids = ["cancel-me", "cancel-me-2", "cancel-me-3"];
  client.onSnapshot(doneSnap(ids, 2));
  await within(2000, client.drained(), "A7a drain");

  assert.equal(fetchImpl.calls.length, 1, "the post-retry gate check cancels it");
  for (const id of ids) assert.equal(client._lastNotified.get(id), `${id}:Stop:2`);
});

test("A7b a queued completion is cancelled when its class switch goes off", async () => {
  let config = { enabled: true, notifyOnDone: true, notifyOnError: true,
    notifyOnPermission: true, outputMode: "off" };
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls += 1;
    config = { ...config, notifyOnDone: false };
    return { ok: false, status: 503, text: async () => "busy" };
  });
  const client = queueClient({ getConfig: () => config, fetchImpl });
  client.prime({ sessions: [] });
  const ids = ["done-off", "done-off-2", "done-off-3"];
  client.onSnapshot(doneSnap(ids, 2));
  await within(2000, client.drained(), "A7b drain");

  assert.equal(fetchImpl.calls.length, 1);
  for (const id of ids) assert.equal(client._lastNotified.get(id), `${id}:Stop:2`);
});

test("A7c a queued permission is cancelled when its class switch goes off", async () => {
  let config = { enabled: true, notifyOnDone: true, notifyOnError: true,
    notifyOnPermission: true, outputMode: "off" };
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls += 1;
    config = { ...config, notifyOnPermission: false };
    return { ok: false, status: 503, text: async () => "busy" };
  });
  const client = queueClient({ getConfig: () => config, fetchImpl });
  client.prime({ sessions: [] });

  const result = await within(
    2000,
    client.notifyPermissionRequest({ title: "cancel-permission", toolName: "Bash" }),
    "A7c permission",
  );
  assert.equal(result.errorClass, "disabled");
  assert.equal(fetchImpl.calls.length, 1);
});

// A6: deliberate trade, from review. A queued item only reads the enable gate
// when its turn comes and before each of its own attempts, so a disable ->
// enable cycle that completes any time before that is invisible: the config is
// byte-identical again and destinationKey cannot see it. A monotonic config
// revision was the only signal that could, and it was dropped because it also
// cancelled on every unrelated preference change, destroying real backlogs on an
// ordinary click. This pins the trade. The getConfigRevision option no longer
// exists in the client; it is passed here on purpose so that re-adding a
// revision compare turns this test red.
test("A6 a master-switch cycle inside a retry backoff is delivered, by design", async () => {
  let revision = 0;
  let config = { enabled: true, notifyOnDone: true, notifyOnError: true,
    notifyOnPermission: true, outputMode: "off" };
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, text: async () => "busy" };
    return okWebhook();
  });
  const client = createSlackNotifyClient({
    getConfig: () => config,
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "" }),
    getLang: () => "en",
    getConfigRevision: () => revision,
    retryBaseMs: 0,
    fetchImpl,
    sleepImpl: () => {
      revision += 2;
      config = { ...config, enabled: false };
      config = { ...config, enabled: true }; // off then on: final bytes identical
      return Promise.resolve();
    },
  });
  client.prime({ sessions: [] });
  client.onSnapshot(doneSnap(["queued-before-the-switch"], 2));
  await within(2000, client.drained(), "A6 drain");

  assert.equal(fetchImpl.calls.length, 2, "the cycle is invisible and deliberately not detected");
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

  const irrelevant = await within(2000, client.notifyPermissionRequest(
    { title: "already resolved", toolName: "Bash" },
    { isStillRelevant: () => false },
  ), "irrelevant permission");
  // Second in the same lane: it only settles if the lane restarts after the
  // first one drains, so a bare await would hang the whole run on a regression.
  const throwing = await within(2000, client.notifyPermissionRequest(
    { title: "predicate failed", toolName: "Bash" },
    { isStillRelevant: () => { throw new Error("stale entry lookup failed"); } },
  ), "throwing predicate");

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

  const result = await within(2000, client.notifyPermissionRequest(
    { title: "resolved during backoff", toolName: "Bash" },
    { isStillRelevant: () => relevant },
  ), "relevance on retry");
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

// B8: the real proof that the lanes are separate is concurrency, not order.
// FIFO holds inside each lane (it would on a single queue too), but two lanes
// backlogged at once keep exactly two requests in flight, one per lane.
test("B8 both lanes together keep at most two requests in flight", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let inFlight = 0;
  let maxConcurrent = 0;
  const order = [];
  const fetchImpl = makeFetch(async (_url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    order.push(body && body.text);
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await gate;
    inFlight -= 1;
    return okWebhook();
  });
  const client = queueClient({ fetchImpl, maxQueue: 5 });
  client.prime({ sessions: [] });
  // Ids longer than six characters so the formatter does not treat the
  // displayTitle as a raw session id and blank it out.
  client.onSnapshot(doneSnap(["comp-01", "comp-02", "comp-03"], 2));
  const permissions = [
    client.notifyPermissionRequest({ title: "p1", toolName: "Bash" }),
    client.notifyPermissionRequest({ title: "p2", toolName: "Bash" }),
    client.notifyPermissionRequest({ title: "p3", toolName: "Bash" }),
  ];

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(inFlight, 2, "exactly one request per lane is in flight");
  } finally {
    release();
  }
  await within(2000, Promise.all(permissions), "B8 permissions");
  await within(2000, client.drained(), "B8 drain");

  assert.equal(fetchImpl.calls.length, 6);
  assert.equal(maxConcurrent, 2, "the two lanes never exceed two in-flight requests");
  const completions = order.filter((text) => /comp-0[1-3]/.test(text));
  assert.match(completions[0], /comp-01/);
  assert.match(completions[1], /comp-02/);
  assert.match(completions[2], /comp-03/);
  const permissionOrder = order.filter((text) => /Permission needed/.test(text));
  assert.match(permissionOrder[0], /p1/);
  assert.match(permissionOrder[1], /p2/);
  assert.match(permissionOrder[2], /p3/);
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

  await within(2000, client.drained(), "restarted drain");
  await within(2000, chained, "chained permission");
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

  const old = await within(2000, client.notifyPermissionRequest({ title: "old channel", toolName: "Bash" }), "old channel");
  assert.equal(old.errorClass, "stale-config");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].body.channel, "C-OLD");

  const fresh = await within(2000, client.notifyPermissionRequest({ title: "new channel", toolName: "Bash" }), "new channel");
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
