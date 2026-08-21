"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  FeishuApprovalClient,
  buildApprovalCard,
  buildSessionTrustConfirmCard,
  buildSessionTrustStatusCard,
  buildElicitationCard,
  buildStatusCard,
  buildElicitationStatusCard,
  normalizeApprovalPayload,
  normalizeElicitationPayload,
  normalizeActionEvent,
  normalizeSessionAutomationActionEvent,
  normalizeElicitationActionEvent,
  SILENT_LARK_LOGGER,
  createLarkClient,
  createDeadlineHttpInstance,
  createWsClient,
  lookupOpenIdByEmail,
} = require("../src/feishu-approval-client");
const { createTranslator, i18n, SUPPORTED_LANGS } = require("../src/i18n");
const { createRemoteCardWorkRegistry } = require("../src/session-automation-remote");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Mirrors the real @larksuiteoapi/node-sdk shape closely enough to capture what
// the factories pass down. Domain.Feishu is 0 and Domain.Lark is 1 in the real
// SDK — the 0 is the whole point of these tests.
function fakeSdk(overrides = {}) {
  const captured = { client: [], ws: [], dispatcher: [], cache: [] };
  const sdk = {
    Domain: { Feishu: 0, Lark: 1 },
    AppType: { SelfBuild: 0, ISV: 1 },
    LoggerLevel: { warn: 2 },
    defaultHttpInstance: {},
    DefaultCache: function DefaultCache() { captured.cache.push(this); },
    Client: function Client(params) { captured.client.push(params); this.im = { v1: { message: {} } }; },
    WSClient: function WSClient(params) { captured.ws.push(params); this.start = async () => {}; this.close = () => {}; },
    EventDispatcher: function EventDispatcher(params) {
      captured.dispatcher.push(params);
      this.register = () => this;
    },
    ...overrides,
  };
  return { sdk, captured };
}

test("buildApprovalCard creates an interactive allow deny card", () => {
  const card = buildApprovalCard({
    title: "claude-code requests Bash",
    agentId: "claude-code",
    toolName: "Bash",
    folder: "project-alpha",
    summary: "Run tests",
    suggestions: [{ index: 0, label: "自动接受编辑" }],
  }, { requestId: "req_1" });
  assert.equal(card.config.update_multi, true);
  // No render context supplied -> English, the neutral default.
  assert.equal(card.header.title.content, "Permission request: claude-code");
  assert.match(card.elements[0].text.content, /Agent/);
  assert.match(card.elements[0].text.content, /Summary/);
  const action = card.elements.find((element) => element.tag === "action");
  assert.equal(action.actions.length, 3);
  assert.equal(action.actions[0].text.content, "Approve once");
  assert.equal(action.actions[1].text.content, "Deny");
  assert.equal(action.actions[2].text.content, "Go to terminal");
  assert.deepEqual(action.actions[0].value, { requestId: "req_1", decision: "allow" });
  assert.deepEqual(action.actions[1].value, { requestId: "req_1", decision: "deny" });
  const secondAction = card.elements.filter((element) => element.tag === "action")[1];
  assert.equal(secondAction.actions[0].text.content, "自动接受编辑");
  assert.deepEqual(secondAction.actions[0].value, { requestId: "req_1", decision: "suggestion:0" });
  const allActions = card.elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions);
  assert.equal(
    allActions.some((button) => button.value && button.value.kind === "session-trust-open"),
    false,
    "the initial card must not expose session trust without the explicit capability"
  );
});

test("DeepSeek Harness remote approval cards omit the meaningless terminal action", () => {
  const card = buildApprovalCard({
    title: "deepseek-harness requests pwsh",
    agentId: "deepseek-harness",
    toolName: "pwsh",
    summary: "Run a command",
  }, { requestId: "req_dsh" });
  const actions = card.elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions);
  assert.deepEqual(actions.map((action) => action.value.decision), ["allow", "deny"]);
  assert.equal(actions.some((action) => action.text.content === "Go to terminal"), false);
});

test("Feishu session automation actions use a namespace disjoint from ordinary decisions", () => {
  const card = buildApprovalCard({
    title: "Run",
    canOfferSessionTrust: true,
  }, { requestId: "req_trust" });
  const actions = card.elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions);
  const trust = actions.find((action) => action.value && action.value.kind === "session-trust-open");
  assert.ok(trust);
  assert.equal(normalizeActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: trust.value },
  }, "open_id"), null, "session trust must never parse as a one-time decision");
  assert.deepEqual(normalizeSessionAutomationActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: trust.value },
  }, "open_id"), {
    operatorId: "ou_1",
    requestId: "req_trust",
    kind: "session-trust-open",
  });
  assert.deepEqual(normalizeSessionAutomationActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: { action: "session-grant:revoke:grant-1" } },
  }, "open_id"), {
    operatorId: "ou_1",
    kind: "persistent-revoke",
    grantId: "grant-1",
  });
  assert.equal(normalizeSessionAutomationActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: { requestId: "req_trust", decision: "allow" } },
  }, "open_id"), null);
});

test("FeishuApprovalClient confirms session trust, prepares before activation, and revokes from the old card", async () => {
  const sent = [];
  const patched = [];
  let client;
  const fakeClient = {
    im: { v1: { message: {
      create: async (payload) => {
        sent.push(payload);
        return { data: { message_id: "om_trust" } };
      },
      patch: async (payload) => {
        patched.push(payload);
        return { data: {} };
      },
    } } },
  };
  const grantId = "grant-feishu-1";
  client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
    onSessionGrantRevoke: (clickedGrantId) => {
      assert.equal(clickedGrantId, grantId);
      client.handleSessionAutomationChanges([{
        previous: { grantId },
        next: { grantId: "off-replacement", mode: "off" },
        reason: "remote-revoke",
      }]);
      return { status: "applied" };
    },
  });

  const decisionPromise = client.requestApproval({
    title: "Run",
    detail: "Summary: Run tests",
    canOfferSessionTrust: true,
  });
  await flush();
  const original = JSON.parse(sent[0].data.content);
  const actions = original.elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions);
  const trustOpen = actions.find((action) => action.value && action.value.kind === "session-trust-open");
  assert.ok(trustOpen);
  const requestId = trustOpen.value.requestId;

  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: trustOpen.value },
  }), true);
  await flush();
  const confirmCard = JSON.parse(patched.at(-1).data.content);
  const confirmAction = confirmCard.elements
    .find((element) => element.tag === "action")
    .actions.find((action) => action.value.kind === "session-trust-confirm");
  assert.deepEqual(confirmAction.value, { requestId, kind: "session-trust-confirm" });

  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: confirmAction.value },
  }), true);
  const decision = await decisionPromise;
  assert.equal(decision.action, "session-trust");
  const work = client.beginSessionTrustCandidate({
    grantId,
    cardHandle: decision.cardHandle,
  });
  assert.ok(work);
  assert.equal(await client.prepareSessionTrustCandidate(work, { grantId }), true);
  const preparing = JSON.parse(patched.at(-1).data.content);
  const preparingAction = preparing.elements
    .find((element) => element.tag === "action")
    .actions[0];
  assert.deepEqual(preparingAction.value, {
    action: `session-grant:revoke:${grantId}`,
  });
  assert.equal(client.activateSessionTrustCandidate(work, { grantId }), true);
  assert.equal(await client.renderActiveSessionTrust(work, {
    grantId,
    outcome: "activated",
  }), true);

  const firstClient = client;
  client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
    sessionAutomationCardWork: firstClient.sessionAutomationCardWork,
    onSessionGrantRevoke: (clickedGrantId) => {
      assert.equal(clickedGrantId, grantId);
      client.handleSessionAutomationChanges([{
        previous: { grantId },
        next: { grantId: "off-replacement", mode: "off" },
        reason: "remote-revoke",
      }]);
      return { status: "applied" };
    },
  });
  assert.deepEqual(client.listActiveSessionAutomationGrantIds(), [grantId],
    "same-route client rebuild must hand off the active-card index");

  assert.equal(client.handleCardAction({
    operator: { open_id: "not-current" },
    action: { value: preparingAction.value },
  }), false);
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: preparingAction.value },
  }), true);
  await flush();
  await flush();
  const revoked = JSON.parse(patched.at(-1).data.content);
  assert.match(revoked.elements[1].text.content, /revoked/i);
  assert.equal(revoked.elements.some((element) => element.tag === "action"), false);
});

test("Feishu keeps one-time approval usable when the session card-work cap is full", async () => {
  const sent = [];
  const patched = [];
  const registry = createRemoteCardWorkRegistry({ limit: 1 });
  assert.ok(registry.reserve("occupied", { messageId: "om_occupied" }));
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    sessionAutomationCardWork: registry,
    onSessionGrantRevoke: () => ({ status: "stale" }),
    larkClient: {
      im: { v1: { message: {
        create: async (payload) => {
          sent.push(payload);
          return { data: { message_id: "om_cap" } };
        },
        patch: async (payload) => {
          patched.push(payload);
          return { data: {} };
        },
      } } },
    },
  });
  const decisionPromise = client.requestApproval({
    title: "Run",
    detail: "Summary: Run tests",
    canOfferSessionTrust: true,
  });
  await flush();
  const initial = JSON.parse(sent[0].data.content);
  const initialActions = initial.elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions);
  const trustOpen = initialActions.find((action) => action.value.kind === "session-trust-open");
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: trustOpen.value },
  }), true);
  await flush();
  const confirmCard = JSON.parse(patched.at(-1).data.content);
  const confirm = confirmCard.elements
    .find((element) => element.tag === "action")
    .actions.find((action) => action.value.kind === "session-trust-confirm");
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: confirm.value },
  }), true);
  await flush();
  const fallback = JSON.parse(patched.at(-1).data.content);
  const fallbackActions = fallback.elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions);
  const allow = fallbackActions.find((action) => action.value.decision === "allow");
  assert.ok(allow, "the original one-time Allow/Deny controls must be restored");
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: allow.value },
  }), true);
  assert.equal(await decisionPromise, "allow");
  assert.equal(registry.size(), 1, "the failed trust attempt must not consume another slot");
});

test("Feishu releases an issued session-trust handle that main never consumes", async () => {
  const sent = [];
  const patched = [];
  const registry = createRemoteCardWorkRegistry({ limit: 1 });
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    sessionAutomationCardWork: registry,
    onSessionGrantRevoke: () => ({ status: "stale" }),
    larkClient: {
      im: { v1: { message: {
        create: async (payload) => {
          sent.push(payload);
          return { data: { message_id: "om_unused" } };
        },
        patch: async (payload) => {
          patched.push(payload);
          return { data: {} };
        },
      } } },
    },
  });
  const decisionPromise = client.requestApproval({
    title: "Run",
    detail: "Summary: Run tests",
    canOfferSessionTrust: true,
  });
  await flush();
  const original = JSON.parse(sent[0].data.content);
  const open = original.elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions)
    .find((action) => action.value.kind === "session-trust-open");
  client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: open.value },
  });
  await flush();
  const confirmation = JSON.parse(patched.at(-1).data.content);
  const confirm = confirmation.elements
    .find((element) => element.tag === "action")
    .actions.find((action) => action.value.kind === "session-trust-confirm");
  client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: confirm.value },
  });
  const decision = await decisionPromise;

  assert.equal(registry.size(), 1);
  assert.equal(client.discardSessionTrustCardHandle(decision.cardHandle, {
    reason: "permission-resolved",
  }), true);
  await flush();
  assert.equal(registry.size(), 0);
  const terminal = JSON.parse(patched.at(-1).data.content);
  assert.equal(terminal.elements.some((element) => element.tag === "action"), false);
  assert.equal(client.discardSessionTrustCardHandle(decision.cardHandle), false);
});

test("Feishu terminalizes a consumed trust confirmation after its route turns stale", async () => {
  const sent = [];
  const patched = [];
  const registry = createRemoteCardWorkRegistry({ limit: 1 });
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    sessionAutomationCardWork: registry,
    onSessionGrantRevoke: () => ({ status: "stale" }),
    larkClient: {
      im: { v1: { message: {
        create: async (payload) => {
          sent.push(payload);
          return { data: { message_id: "om_route_stale" } };
        },
        patch: async (payload) => {
          patched.push(payload);
          return { data: {} };
        },
      } } },
    },
  });
  const decisionPromise = client.requestApproval({
    title: "Run",
    detail: "Summary: Run tests",
    canOfferSessionTrust: true,
  });
  await flush();
  const original = JSON.parse(sent[0].data.content);
  const open = original.elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions)
    .find((action) => action.value.kind === "session-trust-open");
  client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: open.value },
  });
  await flush();
  const confirmation = JSON.parse(patched.at(-1).data.content);
  const confirm = confirmation.elements
    .find((element) => element.tag === "action")
    .actions.find((action) => action.value.kind === "session-trust-confirm");
  client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: confirm.value },
  });
  const decision = await decisionPromise;

  client.markSessionAutomationRouteStale();
  assert.equal(client.beginSessionTrustCandidate({
    grantId: "grant-after-route-change",
    cardHandle: decision.cardHandle,
  }), null);
  assert.equal(registry.size(), 1, "terminal cleanup owns the slot until patch settles");
  await flush();
  await flush();
  assert.equal(registry.size(), 0);
  const terminal = JSON.parse(patched.at(-1).data.content);
  assert.match(terminal.elements[1].text.content, /not enabled/i);
  assert.equal(terminal.elements.some((element) => element.tag === "action"), false);
  assert.equal(client.discardSessionTrustCardHandle(decision.cardHandle), false);
});

test("Feishu REST deadline wrapper applies a finite timeout without mutating the shared SDK client", async () => {
  const seen = [];
  const base = {
    request: async (options) => { seen.push(options); return {}; },
    post: async (_url, _data, options) => { seen.push(options); return {}; },
  };
  const wrapped = createDeadlineHttpInstance(base, 4321);
  await wrapped.request({ url: "/x" });
  await wrapped.post("/x", {}, { timeout: 9000 });
  assert.deepEqual(seen.map((options) => options.timeout), [4321, 4321]);
  assert.equal(Object.prototype.hasOwnProperty.call(base, "timeout"), false);
  const controller = new AbortController();
  await wrapped.runWithSignal(controller.signal, () => wrapped.request({ url: "/signal" }));
  assert.equal(seen.at(-1).signal, controller.signal);

  const confirm = buildSessionTrustConfirmCard(
    { title: "Run" },
    { requestId: "r" }
  );
  const active = buildSessionTrustStatusCard(
    { title: "Run" },
    { grantId: "g", statusKey: "feishuSessionTrustActiveStatus" }
  );
  assert.ok(confirm.elements.some((element) => element.tag === "action"));
  assert.deepEqual(
    active.elements.find((element) => element.tag === "action").actions[0].value,
    { action: "session-grant:revoke:g" }
  );
});

test("Feishu REST deadline wrapper accepts the callable Axios shape used by the real SDK", async () => {
  const seen = [];
  const axiosLike = function axiosLike() {};
  axiosLike.request = async (options) => {
    seen.push(options);
    return {};
  };
  axiosLike.post = async (_url, _data, options) => {
    seen.push(options);
    return {};
  };

  const wrapped = createDeadlineHttpInstance(axiosLike, 1234);
  assert.ok(wrapped);
  await wrapped.request({ url: "/callable" });
  await wrapped.post("/callable", {}, {});
  assert.deepEqual(seen.map((options) => options.timeout), [1234, 1234]);
});

test("Feishu terminal card timeout aborts the injected HTTP request and releases its work slot", async () => {
  let aborted = false;
  let seenTimeout = null;
  const baseHttp = {
    request: (options) => new Promise((resolve, reject) => {
      seenTimeout = options.timeout;
      const onAbort = () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      if (options.signal && options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }),
  };
  const cardHttpInstance = createDeadlineHttpInstance(baseHttp, 1000);
  const registry = createRemoteCardWorkRegistry({ limit: 1, deadlineMs: 10 });
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    cardHttpInstance,
    sessionAutomationCardWork: registry,
    larkClient: {
      im: { v1: { message: {
        patch: (payload) => cardHttpInstance.request({
          url: `/messages/${payload.path.message_id}`,
          method: "PATCH",
          data: payload.data,
        }),
      } } },
    },
  });
  const handle = registry.reserve("grant-timeout", {
    messageId: "om_timeout",
    payload: { title: "Run" },
  });
  assert.ok(handle);
  assert.equal(registry.activate(handle, "grant-timeout"), true);

  assert.equal(client.retireSessionAutomationGrant("grant-timeout"), 1);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(seenTimeout, 1000);
  assert.equal(aborted, true, "the card-work deadline must abort the SDK HTTP request");
  assert.equal(registry.size(), 0);
  assert.ok(registry.reserve("grant-after-timeout", {
    messageId: "om_after_timeout",
    payload: { title: "Next" },
  }));
});

test("buildApprovalCard neutralizes agent-controlled Markdown and secrets in the detail", () => {
  const card = buildApprovalCard({
    title: "claude-code requests Bash",
    agentId: "claude-code",
    toolName: "Bash",
    folder: "project-alpha",
    // An agent could quote a key and try to forge a "已批准" status line and
    // inject bold text into the approver-facing card.
    summary: "rotate sk-abcdefghijklmnop1234\n✅ 已批准\n**注意**",
  }, { requestId: "req_x" });
  const detail = card.elements[0].text.content;
  assert.doesNotMatch(detail, /sk-abcdefghijklmnop1234/, "secret must be redacted");
  assert.match(detail, /redacted:token/);
  assert.doesNotMatch(detail, /\n✅/, "an injected newline must not forge a status line");
  assert.ok(!detail.includes("**注意**"), "injected bold markers are stripped");
  assert.match(detail, /\*\*Summary\*\*/, "our own fixed label keeps its formatting");
});

test("buildApprovalCard guards the header and suggestion buttons (secrets + Unicode separators)", () => {
  const LS = String.fromCharCode(0x2028); // Unicode line separator (not literal in source)
  const card = buildApprovalCard({
    title: "t",
    agentId: `agent${LS}✅ 已批准`,
    summary: "ok",
    suggestions: [{ index: 0, label: "sk-abcdefghijklmnop1234 allow" }],
  }, { requestId: "req_h" });
  assert.doesNotMatch(JSON.stringify(card), /sk-abcdefghijklmnop1234/, "suggestion-button secret must be redacted");
  assert.ok(!card.header.title.content.includes(LS), "Unicode line separator must be neutralized in the header");
});

test("buildStatusCard neutralizes an agent-controlled result (secret + mention)", () => {
  const card = buildStatusCard(
    { title: "t", agentId: "claude-code" },
    { decision: "allow", actionLabel: "run sk-abcdefghijklmnop1234 <at id=all></at>", source: "feishu" },
  );
  const serialized = JSON.stringify(card);
  assert.doesNotMatch(serialized, /sk-abcdefghijklmnop1234/, "a secret in the result must be redacted");
  assert.ok(!serialized.includes("<at id=all>"), "a mention injected via the result must be stripped");
});

test("buildApprovalCard strips zero-width / bidi / format controls from the header", () => {
  // Arabic Letter Mark, Word Joiner, Mongolian Vowel Separator, a deprecated
  // format control, zero-width space, and a Unicode line separator.
  const controls = [0x061c, 0x2060, 0x180e, 0x206a, 0x200b, 0x2028].map((c) => String.fromCharCode(c));
  const card = buildApprovalCard(
    { title: "t", agentId: `a${controls.join("")}b`, summary: "ok" },
    { requestId: "req_z" },
  );
  for (const ch of controls) {
    assert.ok(
      !card.header.title.content.includes(ch),
      `U+${ch.charCodeAt(0).toString(16).toUpperCase()} must be stripped from the header`,
    );
  }
});

test("FeishuApprovalClient sends a card and resolves from card action", async () => {
  const sent = [];
  const updated = [];
  const logs = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async (payload) => {
        sent.push(payload);
        return { data: { message_id: "om_1" } };
      },
      patch: async (payload) => {
        updated.push(payload);
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const decisionPromise = client.requestApproval({ title: "Run", detail: "Summary: Run tests" });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.receive_id_type, "open_id");
  assert.equal(sent[0].data.receive_id, "ou_1");
  assert.equal(sent[0].data.msg_type, "interactive");
  const requestId = JSON.parse(sent[0].data.content).elements[1].actions[0].value.requestId;
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "allow" } },
  }), true);

  assert.equal(await decisionPromise, "allow");
  // The card patch is best-effort and runs after the local decision resolves.
  await flush();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].path.message_id, "om_1");
  assert.match(JSON.parse(updated[0].data.content).header.title.content, /Approved/);
  assert.deepEqual(logs.filter((entry) => entry.level === "debug").map((entry) => ({
    message: entry.message,
    requestIdPrefix: String(entry.meta.requestId || "").slice(0, 3),
    decision: entry.meta.decision || "",
    matched: entry.meta.matched,
  })), [
    { message: "card sent", requestIdPrefix: "fs_", decision: "", matched: undefined },
    { message: "card action received", requestIdPrefix: "fs_", decision: "allow", matched: true },
  ]);
});

test("FeishuApprovalClient resolves on the first card action; late duplicates are no-ops", async () => {
  const sent = [];
  const patches = [];
  let releasePatch;
  const patchGate = new Promise((resolve) => { releasePatch = resolve; });
  const fakeClient = {
    im: { v1: { message: {
      create: async (payload) => {
        sent.push(payload);
        return { data: { message_id: "om_1" } };
      },
      patch: async (payload) => {
        patches.push(payload);
        await patchGate;
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });

  const decisionPromise = client.requestApproval({ title: "Run", detail: "Summary: Run tests" });
  await flush();
  const requestId = JSON.parse(sent[0].data.content).elements[1].actions[0].value.requestId;

  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "allow" } },
  }), true);
  // A second click racing the (still unfinished) card patch must not enter the
  // decision flow: the first action already settled the request.
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "deny" } },
  }), false);

  // The local decision is the first click, available before the patch finishes.
  assert.equal(await decisionPromise, "allow");

  releasePatch();
  await flush();
  assert.equal(patches.length, 1);
  assert.match(JSON.parse(patches[0].data.content).header.title.content, /Approved/);
});

test("FeishuApprovalClient reports running only after WS ready", async () => {
  let wsParams;
  const fakeWs = {
    startCalls: 0,
    state: "idle",
    getConnectionStatus() {
      return { state: this.state, reconnectAttempts: 0 };
    },
    async start() {
      this.startCalls += 1;
      this.state = "connecting";
    },
    close() {
      this.state = "idle";
    },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    wsFactory: (params) => {
      wsParams = params;
      return { wsClient: fakeWs, dispatcher: {} };
    },
  });

  assert.equal(client.getStatus().status, "ready");
  await client.start();
  assert.equal(client.getStatus().status, "starting");
  assert.equal(client.isConnected(), false);

  wsParams.onReady();
  assert.equal(client.getStatus().status, "running");
  assert.equal(client.isConnected(), true);
});

test("FeishuApprovalClient marks WS error failed and recreates on restart", async () => {
  const created = [];
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    wsFactory: (params) => {
      const fakeWs = {
        state: "idle",
        closed: false,
        getConnectionStatus() {
          return { state: this.state, reconnectAttempts: 0 };
        },
        async start() {
          this.state = "connecting";
        },
        close() {
          this.closed = true;
          this.state = "idle";
        },
      };
      created.push({ params, fakeWs });
      return { wsClient: fakeWs, dispatcher: {} };
    },
  });

  await client.start();
  created[0].params.onError(new Error("long connection disabled"));
  assert.equal(client.getStatus().status, "failed");
  assert.equal(client.getStatus().errorCode, "sdk-request-failed");
  assert.equal(client.getStatus().message, "Feishu/Lark long connection failed.");
  assert.equal(client.isConnected(), false);

  await client.start();
  assert.equal(created.length, 2);
  assert.equal(created[0].fakeWs.closed, true);
  assert.equal(client.getStatus().status, "starting");
});

test("FeishuApprovalClient marks initial connection failed after configured timeout", async () => {
  const logs = [];
  let wsParams;
  const fakeWs = {
    state: "idle",
    closed: false,
    getConnectionStatus() {
      return { state: this.state, reconnectAttempts: 0 };
    },
    async start() {
      this.state = "connecting";
    },
    close() {
      this.closed = true;
      this.state = "idle";
    },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    connectionTimeoutSeconds: 0.02,
    wsFactory: (params) => {
      wsParams = params;
      return { wsClient: fakeWs, dispatcher: {} };
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  await client.start();
  assert.equal(client.getStatus().status, "starting");
  await new Promise((resolve) => setTimeout(resolve, 40));

  const failed = client.getStatus();
  assert.equal(failed.status, "failed");
  assert.match(failed.message, /20ms/);
  assert.equal(fakeWs.closed, false);
  assert.equal(logs.some((entry) => entry.message === "connection timeout"), true);

  wsParams.onReady();
  assert.equal(client.getStatus().status, "running");
});

test("FeishuApprovalClient notifies status changes during connection lifecycle", async () => {
  const notifications = [];
  let wsParams;
  const fakeWs = {
    state: "idle",
    getConnectionStatus() {
      return { state: this.state, reconnectAttempts: 0 };
    },
    async start() {
      this.state = "connecting";
    },
    close() {
      this.state = "idle";
    },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    connectionTimeoutSeconds: 0.02,
    wsFactory: (params) => {
      wsParams = params;
      return { wsClient: fakeWs, dispatcher: {} };
    },
    onStatusChange: (status) => notifications.push(status.status),
  });

  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  fakeWs.state = "connected";
  wsParams.onReady();

  assert.deepEqual(notifications, ["starting", "failed", "running"]);
});

test("FeishuApprovalClient marks reconnect failed after timeout and recovers on reconnected", async () => {
  let wsParams;
  const fakeWs = {
    state: "idle",
    getConnectionStatus() {
      return { state: this.state, reconnectAttempts: 1 };
    },
    async start() {
      this.state = "connecting";
    },
    close() {
      this.state = "idle";
    },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    connectionTimeoutSeconds: 0.02,
    wsFactory: (params) => {
      wsParams = params;
      return { wsClient: fakeWs, dispatcher: {} };
    },
  });

  await client.start();
  wsParams.onReady();
  assert.equal(client.getStatus().status, "running");

  fakeWs.state = "reconnecting";
  wsParams.onReconnecting();
  assert.equal(client.getStatus().status, "starting");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(client.getStatus().status, "failed");
  assert.match(client.getStatus().message, /reconnect/i);

  fakeWs.state = "connected";
  wsParams.onReconnected();
  assert.equal(client.getStatus().status, "running");
});

test("FeishuApprovalClient follows SDK reconnecting state after a ready connection", async () => {
  let wsParams;
  const fakeWs = {
    state: "idle",
    getConnectionStatus() {
      return { state: this.state, reconnectAttempts: 1 };
    },
    async start() {
      this.state = "connecting";
    },
    close() {
      this.state = "idle";
    },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    connectionTimeoutSeconds: 1,
    wsFactory: (params) => {
      wsParams = params;
      return { wsClient: fakeWs, dispatcher: {} };
    },
  });

  await client.start();
  wsParams.onReady();
  assert.equal(client.getStatus().status, "running");

  fakeWs.state = "reconnecting";
  assert.equal(client.getStatus().status, "starting");
  fakeWs.state = "failed";
  assert.equal(client.getStatus().status, "failed");
});

test("FeishuApprovalClient ignores stale WS callbacks from a replaced generation", async () => {
  const created = [];
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    connectionTimeoutSeconds: 0.02,
    wsFactory: (params) => {
      const fakeWs = {
        state: "idle",
        closed: false,
        getConnectionStatus() {
          return { state: this.state, reconnectAttempts: 0 };
        },
        async start() {
          this.state = "connecting";
        },
        close() {
          this.closed = true;
          this.state = "idle";
        },
      };
      created.push({ params, fakeWs });
      return { wsClient: fakeWs, dispatcher: {} };
    },
  });

  await client.start();
  created[0].params.onError(new Error("gen1 failed"));
  assert.equal(client.getStatus().status, "failed");

  await client.start();
  assert.equal(created.length, 2);
  assert.equal(client.getStatus().status, "starting");

  // A late callback from the replaced connection must not mark the new one
  // as running…
  created[0].params.onReady();
  assert.equal(client.getStatus().status, "starting");
  assert.equal(client.isConnected(), false);

  // …and must not have cleared the new connection's timeout watchdog.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(client.getStatus().status, "failed");

  // The current generation still reports normally.
  created[1].params.onReady();
  assert.equal(client.getStatus().status, "running");
});

test("FeishuApprovalClient ignores WS callbacks arriving after close()", async () => {
  const created = [];
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    wsFactory: (params) => {
      const fakeWs = {
        state: "idle",
        getConnectionStatus() {
          return { state: this.state, reconnectAttempts: 0 };
        },
        async start() {
          this.state = "connecting";
        },
        close() {
          this.state = "idle";
        },
      };
      created.push({ params, fakeWs });
      return { wsClient: fakeWs, dispatcher: {} };
    },
  });

  await client.start();
  client.close();
  assert.equal(client.getStatus().status, "ready");

  created[0].params.onReady();
  assert.equal(client.getStatus().status, "ready");
  assert.equal(client.isConnected(), false);
});

test("FeishuApprovalClient does not send approval card until WS is connected", async () => {
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
  });

  assert.equal(client.isConnected(), false);
  assert.equal(client.getStatus().status, "ready");
});

test("FeishuApprovalClient resolves terminal action and external desktop updates card", async () => {
  const sent = [];
  const updated = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async (payload) => {
        sent.push(payload);
        return { data: { message_id: "om_1" } };
      },
      patch: async (payload) => {
        updated.push(payload);
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });
  const ac = new AbortController();

  const decisionPromise = client.requestApproval(
    { title: "Run", detail: "Summary: Run tests" },
    { signal: ac.signal }
  );
  await Promise.resolve();
  const requestId = JSON.parse(sent[0].data.content).elements[1].actions[2].value.requestId;
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "terminal" } },
  }), true);
  assert.equal(await decisionPromise, "terminal");
  // The card patch is best-effort and runs after the local decision resolves.
  await flush();
  assert.match(JSON.parse(updated[0].data.content).header.title.content, /Moved to the terminal/);

  const ac2 = new AbortController();
  const secondPromise = client.requestApproval(
    { title: "Run", detail: "Summary: Run tests" },
    { signal: ac2.signal }
  );
  await Promise.resolve();
  assert.equal(client.resolveApprovalExternally(ac2.signal, {
    decision: "deny",
    actionLabel: "Denied",
    source: "desktop",
  }), true);
  assert.equal(await secondPromise, null);
  await flush();
  assert.match(JSON.parse(updated[1].data.content).header.title.content, /Denied/);
  assert.match(JSON.parse(updated[1].data.content).elements[0].text.content, /Desktop bubble/);
});

test("FeishuApprovalClient can update card after local decision before send resolves", async () => {
  let resolveCreate;
  const updated = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async () => new Promise((resolve) => { resolveCreate = resolve; }),
      patch: async (payload) => {
        updated.push(payload);
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });
  const ac = new AbortController();
  const decisionPromise = client.requestApproval(
    { title: "Run", detail: "Summary: Run tests" },
    { signal: ac.signal }
  );

  await Promise.resolve();
  assert.equal(client.resolveApprovalExternally(ac.signal, {
    decision: "allow",
    actionLabel: "Approved once",
    source: "desktop",
  }), true);
  resolveCreate({ data: { message_id: "om_late" } });

  assert.equal(await decisionPromise, null);
  await flush();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].path.message_id, "om_late");
  assert.match(JSON.parse(updated[0].data.content).elements[0].text.content, /Desktop bubble/);
});

test("FeishuApprovalClient keeps a terminal decision behind an older session-trust patch", async () => {
  const sent = [];
  const patchCalls = [];
  const appliedCards = [];
  let releaseCancelPatch;
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: {
      im: { v1: { message: {
        create: async (payload) => {
          sent.push(payload);
          return { data: { message_id: "om_ordered_terminal" } };
        },
        patch: async (payload) => {
          patchCalls.push(payload);
          if (patchCalls.length === 2) {
            return new Promise((resolve) => {
              releaseCancelPatch = () => {
                appliedCards.push(payload);
                resolve({ data: {} });
              };
            });
          }
          appliedCards.push(payload);
          return { data: {} };
        },
      } } },
    },
  });
  const decisionPromise = client.requestApproval({
    title: "Run",
    detail: "Summary: Run tests",
    canOfferSessionTrust: true,
  });
  await flush();
  const initialCard = JSON.parse(sent[0].data.content);
  const trustOpen = initialCard.elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions)
    .find((button) => button.value && button.value.kind === "session-trust-open");
  const requestId = trustOpen.value.requestId;

  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: trustOpen.value },
  }), true);
  await flush();
  assert.equal(patchCalls.length, 1, "the confirmation card is applied first");

  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, kind: "session-trust-cancel" } },
  }), true);
  await flush();
  assert.equal(patchCalls.length, 2, "the cancellation patch is now in flight");

  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "deny" } },
  }), true);
  assert.equal(await decisionPromise, "deny");
  await flush();
  assert.equal(patchCalls.length, 2, "the terminal patch must wait behind the older cancellation patch");

  releaseCancelPatch();
  await client.close();
  assert.equal(patchCalls.length, 3);
  assert.equal(appliedCards.length, 3);
  const finalCard = JSON.parse(appliedCards.at(-1).data.content);
  assert.match(finalCard.header.title.content, /Denied/);
  assert.equal(finalCard.elements.some((element) => element.tag === "action"), false);
});

test("FeishuApprovalClient closes the decision race before an external terminal patch settles", async () => {
  const sent = [];
  const updated = [];
  let resolvePatch;
  const fakeClient = {
    im: { v1: { message: {
      create: async (payload) => {
        sent.push(payload);
        return { data: { message_id: "om_external" } };
      },
      patch: async (payload) => {
        updated.push(payload);
        if (updated.length === 1) {
          return new Promise((resolve) => { resolvePatch = resolve; });
        }
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
    terminalCardReplayDelayMs: 0,
  });
  const ac = new AbortController();
  const decisionPromise = client.requestApproval(
    { title: "Run", detail: "Summary: Run tests" },
    { signal: ac.signal }
  );
  await flush();
  const requestId = JSON.parse(sent[0].data.content).elements[1].actions[2].value.requestId;

  assert.equal(client.resolveApprovalExternally(ac.signal, {
    decision: "allow",
    actionLabel: "Approved once",
    source: "desktop",
  }), true);
  assert.equal(await decisionPromise, null, "the desktop decision must resolve before the patch");
  await flush();
  assert.equal(updated.length, 1);
  assert.equal(client.pending.size, 0);
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_other" },
    action: { value: { requestId, decision: "deny" } },
  }), false, "another operator cannot refresh a terminal card");
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId: "fs_000000000000000000000000", decision: "deny" } },
  }), false, "an unknown request cannot refresh a terminal card");
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "deny" } },
  }), false, "a Feishu click after the desktop decision must be stale");
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "deny" } },
  }), false, "duplicate stale clicks remain non-decisions");
  assert.equal(updated.length, 1, "stale callbacks must not race the in-flight terminal patch");

  let closeSettled = false;
  const closePromise = client.close();
  closePromise.then(() => { closeSettled = true; });
  await Promise.resolve();
  assert.equal(closeSettled, false, "close must retain the external terminal patch");

  resolvePatch({ data: {} });
  await closePromise;
  assert.equal(closeSettled, true);
  await flush();
  assert.equal(updated.length, 2, "stale callbacks coalesce into one serialized terminal replay");
  assert.deepEqual(updated[1], updated[0], "the replay must restore the original desktop outcome");
  assert.equal(client.terminalCardUpdates.size, 0);
});

test("FeishuApprovalClient expires retained terminal cards without further activity", async () => {
  const fakeClient = {
    im: { v1: { message: {
      create: async () => ({ data: { message_id: "om_terminal_ttl" } }),
      patch: async () => ({ data: {} }),
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
    recentTerminalCardTtlMs: 5,
  });
  const ac = new AbortController();
  const decisionPromise = client.requestApproval(
    { title: "Run", detail: "Summary: Run tests" },
    { signal: ac.signal }
  );
  await flush();

  assert.equal(client.resolveApprovalExternally(ac.signal, {
    decision: "allow",
    source: "desktop",
  }), true);
  assert.equal(await decisionPromise, null);
  await flush();
  assert.equal(client.recentTerminalCards.size, 1);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.recentTerminalCards.size, 0);
  assert.equal(client.recentTerminalExpiryTimer, null);
  await client.close();
});

test("FeishuApprovalClient preserves the stale-action replay window across a transport restart", async () => {
  const sent = [];
  const patched = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async (payload) => {
        sent.push(payload);
        return { data: { message_id: "om_restart_replay" } };
      },
      patch: async (payload) => {
        patched.push(payload);
        return { data: {} };
      },
    } } },
  };
  const makeWsClient = () => ({
    start: async () => {},
    close: () => {},
    getConnectionStatus: () => ({ state: "failed", reconnectAttempts: 0 }),
  });
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
    wsClient: makeWsClient(),
    wsFactory: () => ({ wsClient: makeWsClient(), dispatcher: {} }),
    terminalCardReplayDelayMs: 0,
  });
  const ac = new AbortController();
  const decisionPromise = client.requestApproval(
    { title: "Run", detail: "Summary: Run tests" },
    { signal: ac.signal }
  );
  await flush();
  const requestId = JSON.parse(sent[0].data.content).elements[1].actions[2].value.requestId;

  assert.equal(client.resolveApprovalExternally(ac.signal, {
    decision: "allow",
    source: "desktop",
  }), true);
  assert.equal(await decisionPromise, null);
  await flush();
  assert.equal(patched.length, 1);

  await client.start();
  assert.equal(client.recentTerminalCards.size, 1);
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "deny" } },
  }), false);
  await client.close();
  assert.equal(patched.length, 2);
  assert.deepEqual(patched[1], patched[0]);
});

test("FeishuApprovalClient serializes elicitation navigation before terminal replay", async () => {
  const sent = [];
  const patchCalls = [];
  const appliedCards = [];
  let releaseNavigationPatch;
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    terminalCardReplayDelayMs: 0,
    larkClient: {
      im: { v1: { message: {
        create: async (payload) => {
          sent.push(payload);
          return { data: { message_id: "om_elicitation_order" } };
        },
        patch: async (payload) => {
          patchCalls.push(payload);
          if (patchCalls.length === 1) {
            return new Promise((resolve) => {
              releaseNavigationPatch = () => {
                appliedCards.push(payload);
                resolve({ data: {} });
              };
            });
          }
          appliedCards.push(payload);
          return { data: {} };
        },
      } } },
    },
  });
  const ac = new AbortController();
  const answerPromise = client.requestElicitation({
    title: "Need input",
    questions: [
      { question: "First?", options: [{ label: "Yes" }] },
      { question: "Second?", options: [{ label: "No" }] },
    ],
  }, { signal: ac.signal });
  await flush();
  const firstCard = JSON.parse(sent[0].data.content);
  const requestId = firstCard.elements
    .find((element) => element.tag === "form")
    .elements.find((element) => element.tag === "button").value.requestId;
  const staleStep = {
    operator: { open_id: "ou_1" },
    action: {
      value: { requestId, kind: "elicitation-step", questionIndex: 0, final: false },
      form_value: { q_0: "0" },
    },
  };

  assert.equal(client.handleCardAction(staleStep), true);
  await flush();
  assert.equal(patchCalls.length, 1);
  assert.equal(client.resolveApprovalExternally(ac.signal, {
    decision: "no-decision",
    source: "desktop",
  }), true);
  assert.equal(await answerPromise, null);
  assert.equal(client.handleCardAction(staleStep), false);
  await flush();
  assert.equal(patchCalls.length, 1, "terminal work waits behind the old navigation patch");

  releaseNavigationPatch();
  await client.close();
  assert.equal(patchCalls.length, 3, "the terminal patch and one stale-action replay both run last");
  assert.equal(appliedCards.length, 3);
  const terminal = JSON.parse(appliedCards.at(-1).data.content);
  assert.equal(terminal.elements.some((element) => element.tag === "form"), false);
  assert.deepEqual(patchCalls[2], patchCalls[1]);
});

test("FeishuApprovalClient ignores non-approver actions and aborts pending request", async () => {
  const updated = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async () => ({ data: { message_id: "om_1" } }),
      patch: async (payload) => {
        updated.push(payload);
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });
  const ac = new AbortController();
  const promise = client.requestApproval({ title: "Run", detail: "Summary" }, { signal: ac.signal });
  await Promise.resolve();
  const requestId = Array.from(client.pending.keys())[0];
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_other" },
    action: { value: { requestId, decision: "deny" } },
  }), false);
  assert.equal(client.pending.size, 1);
  ac.abort();
  assert.equal(await promise, null);
  assert.equal(client.pending.size, 0);
  await flush();
  assert.equal(updated.length, 0, "normal approval aborts must not patch the card");
});

test("FeishuApprovalClient aborts immediately then expires a test card asynchronously", async () => {
  let resolveCreate;
  const updated = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async () => new Promise((resolve) => { resolveCreate = resolve; }),
      patch: async (payload) => {
        updated.push(payload);
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });
  const ac = new AbortController();
  const promise = client.requestApproval(
    { title: "Test", detail: "Waiting for a response" },
    { signal: ac.signal, abortOutcome: { decision: "no-decision" } },
  );
  await Promise.resolve();

  ac.abort();
  assert.equal(await promise, null, "abort result must not wait for card sending");
  assert.equal(client.pending.size, 0, "abort must clear pending immediately");
  assert.equal(updated.length, 0);

  resolveCreate({ data: { message_id: "om_late" } });
  await flush();
  await flush();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].path.message_id, "om_late");
  const card = JSON.parse(updated[0].data.content);
  assert.ok(!card.elements.some((element) => element.tag === "action"));
  assert.match(card.header.title.content, /Cancelled/);
});

test("FeishuApprovalClient keeps the abort result when async expiry update fails", async () => {
  const logs = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async () => ({ data: { message_id: "om_1" } }),
      patch: async () => { throw new Error("patch failed with private payload"); },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });
  const ac = new AbortController();
  const promise = client.requestApproval(
    { title: "Test", detail: "Waiting" },
    { signal: ac.signal, abortOutcome: { decision: "no-decision" } },
  );
  await Promise.resolve();

  ac.abort();
  assert.equal(await promise, null);
  assert.equal(client.pending.size, 0);
  await flush();
  await flush();
  assert.deepEqual(logs.find((entry) => entry.message === "abort card update failed"), {
    level: "warn",
    message: "abort card update failed",
    meta: { stage: "update-card" },
  });
  assert.ok(!JSON.stringify(logs).includes("private payload"));
});

function createTestCardLifecycleHarness({
  create = async () => ({ data: { message_id: "om_test" } }),
  patch = async () => ({ data: {} }),
  log,
  payload = { title: "Test", detail: "Waiting" },
  signal,
  abortOutcome,
} = {}) {
  const updated = [];
  const fakeClient = {
    im: { v1: { message: {
      create: (...args) => create(...args),
      patch: async (request) => {
        updated.push(request);
        return patch(request);
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
    log,
  });
  const requestOptions = {};
  if (signal) requestOptions.signal = signal;
  if (abortOutcome) requestOptions.abortOutcome = abortOutcome;
  return {
    client,
    updated,
    requestApproval: () => client.requestApproval(payload, requestOptions),
    parseLastPatchedCard: () => JSON.parse(updated[updated.length - 1].data.content),
  };
}

test("FeishuApprovalClient terminalizes an already-sent test card when the client closes", async () => {
  const { client, updated, requestApproval, parseLastPatchedCard } = createTestCardLifecycleHarness({
    create: async () => ({ data: { message_id: "om_close_sent" } }),
    payload: { title: "Test", detail: "Waiting for a response" },
    abortOutcome: { decision: "no-decision" },
  });
  const promise = requestApproval();
  await flush();
  await flush();
  assert.equal(client.pending.size, 1);
  const requestId = Array.from(client.pending.keys())[0];
  assert.equal(typeof requestId, "string");
  assert.ok(requestId.startsWith("fs_"));

  client.close();
  assert.equal(client.pending.size, 0, "close must clear pending immediately");
  assert.equal(await promise, null, "close must resolve the request immediately");

  await flush();
  await flush();
  assert.equal(updated.length, 1, "already-sent cards must receive exactly one terminal patch");
  assert.equal(updated[0].path.message_id, "om_close_sent");
  const card = parseLastPatchedCard();
  assert.ok(!card.elements.some((element) => element.tag === "action"));
  assert.match(card.header.title.content, /Cancelled/);

  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "allow" } },
  }), false);
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "deny" } },
  }), false);
  assert.equal(updated.length, 1);
});

test("FeishuApprovalClient close waits for the test-card terminal patch", async () => {
  let resolvePatch;
  const patchFinished = new Promise((resolve) => { resolvePatch = resolve; });
  const { client, requestApproval } = createTestCardLifecycleHarness({
    create: async () => ({ data: { message_id: "om_close_drain" } }),
    patch: async () => patchFinished,
    abortOutcome: { decision: "no-decision" },
  });
  const approval = requestApproval();
  await flush();
  await flush();

  const closeResult = client.close();
  assert.equal(typeof closeResult?.then, "function", "close must expose its terminal-card drain");
  assert.equal(await approval, null);

  let closeSettled = false;
  closeResult.then(() => { closeSettled = true; });
  await flush();
  assert.equal(closeSettled, false, "close must remain pending while the terminal patch is in flight");

  resolvePatch({ data: {} });
  await closeResult;
  assert.equal(closeSettled, true);
});

test("FeishuApprovalClient close waits for an answered test-card patch", async () => {
  let resolvePatch;
  const patchFinished = new Promise((resolve) => { resolvePatch = resolve; });
  const { client, updated, requestApproval } = createTestCardLifecycleHarness({
    create: async () => ({ data: { message_id: "om_answered_close_drain" } }),
    patch: async () => patchFinished,
    abortOutcome: { decision: "no-decision" },
  });
  const approval = requestApproval();
  await flush();
  await flush();
  const requestId = Array.from(client.pending.keys())[0];

  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "allow" } },
  }), true);
  assert.equal(await approval, "allow");

  const closeResult = client.close();
  let closeSettled = false;
  closeResult.then(() => { closeSettled = true; });
  await flush();
  assert.equal(updated.length, 1);
  assert.equal(closeSettled, false, "close must wait for the answered-card patch already in flight");

  resolvePatch({ data: {} });
  await closeResult;
  assert.equal(closeSettled, true);
});

test("FeishuApprovalClient terminalizes a late-sent test card after close()", async () => {
  let resolveCreate;
  let resolvePatch;
  const patchFinished = new Promise((resolve) => { resolvePatch = resolve; });
  const harness = createTestCardLifecycleHarness({
    create: async () => new Promise((resolve) => { resolveCreate = resolve; }),
    patch: async () => patchFinished,
    payload: { title: "Test", detail: "Waiting for a response" },
    abortOutcome: { decision: "no-decision" },
  });
  const { client, updated } = harness;
  const promise = harness.requestApproval();
  await Promise.resolve();
  assert.equal(client.pending.size, 1);

  const closeResult = client.close();
  assert.equal(await promise, null, "close must not wait for create()");
  assert.equal(client.pending.size, 0);
  assert.equal(updated.length, 0);

  resolveCreate({ data: { message_id: "om_close_late" } });
  await flush();
  await flush();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].path.message_id, "om_close_late");
  let closeSettled = false;
  closeResult.then(() => { closeSettled = true; });
  await flush();
  assert.equal(closeSettled, false, "close must wait for the late terminal patch");
  const card = harness.parseLastPatchedCard();
  assert.ok(!card.elements.some((element) => element.tag === "action"));
  assert.match(card.header.title.content, /Cancelled/);

  resolvePatch({ data: {} });
  await closeResult;
});

test("FeishuApprovalClient keeps the close result when terminal patch fails", async () => {
  const logs = [];
  const { client, requestApproval } = createTestCardLifecycleHarness({
    create: async () => ({ data: { message_id: "om_close_fail" } }),
    patch: async () => {
      throw new Error("patch failed with private payload CLOSE_SECRET_SENTINEL");
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    abortOutcome: { decision: "no-decision" },
  });
  const promise = requestApproval();
  await flush();
  await flush();

  client.close();
  assert.equal(await promise, null);
  assert.equal(client.pending.size, 0);
  await flush();
  await flush();
  assert.deepEqual(logs.find((entry) => entry.message === "abort card update failed"), {
    level: "warn",
    message: "abort card update failed",
    meta: { stage: "update-card" },
  });
  assert.ok(!JSON.stringify(logs).includes("CLOSE_SECRET_SENTINEL"));
  assert.ok(!JSON.stringify(logs).includes("private payload"));
});

test("FeishuApprovalClient close without abortOutcome does not patch the card", async () => {
  const { client, updated, requestApproval } = createTestCardLifecycleHarness({
    create: async () => ({ data: { message_id: "om_normal_close" } }),
    payload: { title: "Run", detail: "Summary" },
  });
  const promise = requestApproval();
  await flush();
  await flush();
  assert.equal(client.pending.size, 1);

  client.close();
  assert.equal(await promise, null);
  assert.equal(client.pending.size, 0);
  await flush();
  await flush();
  assert.equal(updated.length, 0, "ordinary approvals must not receive a terminal patch on close");
});

test("FeishuApprovalClient timer abort and close terminalizes a test card only once", async () => {
  const ac = new AbortController();
  let resolvePatch;
  const patchFinished = new Promise((resolve) => { resolvePatch = resolve; });
  const { client, updated, requestApproval, parseLastPatchedCard } = createTestCardLifecycleHarness({
    create: async () => ({ data: { message_id: "om_once" } }),
    patch: async () => patchFinished,
    signal: ac.signal,
    abortOutcome: { decision: "no-decision" },
  });
  const promise = requestApproval();
  await flush();
  await flush();
  const requestId = Array.from(client.pending.keys())[0];

  ac.abort();
  const closeResult = client.close();
  assert.equal(await promise, null);
  assert.equal(client.pending.size, 0);
  await flush();
  assert.equal(updated.length, 1, "abort and close must share one idempotent terminal patch");
  let closeSettled = false;
  closeResult.then(() => { closeSettled = true; });
  await flush();
  assert.equal(closeSettled, false, "close must wait for the terminal patch already started by abort");

  resolvePatch({ data: {} });
  await closeResult;
  assert.equal(updated[0].path.message_id, "om_once");
  assert.ok(!parseLastPatchedCard().elements.some((element) => element.tag === "action"));
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "allow" } },
  }), false);
});

test("FeishuApprovalClient close then late timer abort still terminalizes a test card only once", async () => {
  const ac = new AbortController();
  const { client, updated, requestApproval } = createTestCardLifecycleHarness({
    create: async () => ({ data: { message_id: "om_close_then_abort" } }),
    signal: ac.signal,
    abortOutcome: { decision: "no-decision" },
  });
  const promise = requestApproval();
  await flush();
  await flush();

  client.close();
  assert.equal(await promise, null);
  assert.equal(client.pending.size, 0);
  ac.abort();
  await flush();
  await flush();
  assert.equal(updated.length, 1, "late abort after close must not double-patch");
});

test("FeishuApprovalClient entry terminalizer runs once across repeated calls and close", async () => {
  let resolveCreate;
  const harness = createTestCardLifecycleHarness({
    create: async () => new Promise((resolve) => { resolveCreate = resolve; }),
    abortOutcome: { decision: "no-decision" },
  });
  const { client, updated } = harness;
  const promise = harness.requestApproval();
  await Promise.resolve();
  assert.equal(client.pending.size, 1);
  const requestId = client.pending.keys().next().value;
  const entry = client.pending.get(requestId);
  assert.equal(typeof entry.terminalizeAbortOutcome, "function");

  entry.terminalizeAbortOutcome();
  entry.terminalizeAbortOutcome();
  client.close();
  assert.equal(await promise, null);
  assert.equal(client.pending.size, 0);
  assert.equal(updated.length, 0);

  resolveCreate({ data: { message_id: "om_repeated" } });
  await flush();
  await flush();
  entry.terminalizeAbortOutcome();
  await flush();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].path.message_id, "om_repeated");
  const card = harness.parseLastPatchedCard();
  assert.ok(!card.elements.some((element) => element.tag === "action"));
  assert.equal(client.pending.size, 0);
  assert.equal(await promise, null);
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "allow" } },
  }), false);
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "deny" } },
  }), false);
});

test("pure helpers validate payloads and card action events", () => {
  assert.deepEqual(normalizeApprovalPayload({ title: "  hi ", detail: 42, extra: true }), {
    title: "hi",
    detail: "42",
    agentId: "",
    toolName: "",
    folder: "",
    summary: "",
    suggestions: [],
    canOfferSessionTrust: false,
  });
  assert.throws(() => normalizeApprovalPayload({ title: "" }), /title/);
  assert.deepEqual(normalizeActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: JSON.stringify({ requestId: "req_1", decision: "deny" }) },
  }, "open_id"), {
    operatorId: "ou_1",
    requestId: "req_1",
    decision: "deny",
  });
  assert.deepEqual(normalizeActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: { requestId: "req_1", decision: "suggestion:2" } },
  }, "open_id"), {
    operatorId: "ou_1",
    requestId: "req_1",
    decision: "suggestion:2",
  });
  assert.deepEqual(normalizeActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: { requestId: "req_1", decision: "terminal" } },
  }, "open_id"), {
    operatorId: "ou_1",
    requestId: "req_1",
    decision: "terminal",
  });
  assert.equal(normalizeActionEvent({ action: { value: { requestId: "req_1", decision: "later" } } }, "open_id"), null);
});

test("buildElicitationCard redacts secrets and strips Markdown from question text", () => {
  const card = buildElicitationCard({
    title: "claude-code needs input",
    agentId: "claude-code",
    folder: "project-alpha",
    questions: [{
      header: "轮换密钥",
      question: "在 .env 找到 sk-abcdefghijklmnop1234，要轮换吗？\n✅ 已确认",
      options: [{ label: "是", description: "" }],
    }],
  }, { requestId: "req_qx" });
  const questionDiv = card.elements.find(
    (element) => element.tag === "div" && /轮换密钥/.test(element.text.content),
  );
  assert.ok(questionDiv, "question text is rendered");
  const content = questionDiv.text.content;
  assert.doesNotMatch(content, /sk-abcdefghijklmnop1234/, "a key quoted in a question must not leak");
  assert.match(content, /redacted:token/);
  assert.doesNotMatch(content, /\n✅/, "an injected newline must not forge a line");
});

test("buildElicitationCard creates a form stepper with selection and other input", () => {
  const card = buildElicitationCard({
    title: "claude-code needs input",
    agentId: "claude-code",
    folder: "project-alpha",
    questions: [{
      header: "当前任务",
      question: "您当前正在进行什么类型的工作？",
      multiSelect: true,
      options: [
        { label: "开发新功能", description: "正在开发新的业务功能或模块" },
        { label: "修复Bug", description: "正在排查和修复代码问题" },
      ],
    }, {
      header: "约束条件",
      question: "有什么特别的约束？",
      options: [],
    }],
  }, { requestId: "req_q" });

  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.title.content, "Input needed: claude-code");
  assert.ok(card.elements.some((element) => element.tag === "div" && /1 \/ 2/.test(element.text.content)));
  assert.equal(card.elements.some((element) => (
    element.tag === "action"
    && element.actions.some((action) => action.value && action.value.kind === "elicitation-option")
  )), false);
  const form = card.elements.find((element) => element.tag === "form");
  assert.ok(form);
  assert.equal(form.name, "elicitation_form_0");
  const select = form.elements.find((element) => element.name === "q_0");
  assert.ok(select);
  assert.equal(select.tag, "multi_select_static");
  assert.equal(select.options.length, 2);
  assert.equal(select.options[0].text.content, "开发新功能");
  const other = form.elements.find((element) => element.tag === "input" && element.name === "q_0_other");
  assert.ok(other);
  const submit = form.elements.find((element) => element.tag === "button");
  assert.equal(submit.action_type, "form_submit");
  assert.equal(submit.name, "elicitation_next_0");
  assert.deepEqual(submit.value, {
    requestId: "req_q",
    kind: "elicitation-step",
    questionIndex: 0,
    final: false,
  });

  const restored = buildElicitationCard({
    title: "claude-code needs input",
    questions: [{
      index: 0,
      question: "您当前正在进行什么类型的工作？",
      multiSelect: true,
      options: [{ label: "开发新功能" }, { label: "修复Bug" }],
    }],
  }, {
    requestId: "req_q",
    answers: { "0": "开发新功能, 自定义工作" },
  });
  const restoredForm = restored.elements.find((element) => element.tag === "form");
  const restoredSelect = restoredForm.elements.find((element) => element.name === "q_0");
  const restoredOther = restoredForm.elements.find((element) => element.name === "q_0_other");
  assert.deepEqual(restoredSelect.selected_values, ["0"]); // option INDEX, not the raw label
  assert.equal(restoredOther.default_value, "自定义工作");
});

test("buildElicitationCard uses opaque option indices so a secret label never rides the wire", () => {
  const card = buildElicitationCard({
    title: "claude-code needs input",
    questions: [{
      question: "Pick a key",
      options: [{ label: "sk-abcdefghijklmnop1234" }, { label: "safe" }],
    }],
  }, { requestId: "req_sec" });
  // The raw secret label must not appear ANYWHERE in the outbound card JSON —
  // not in display text (redacted) and not in the option value (now an index).
  assert.doesNotMatch(JSON.stringify(card), /sk-abcdefghijklmnop1234/);
  const form = card.elements.find((e) => e.tag === "form");
  const select = form.elements.find((e) => e.name === "q_0");
  assert.deepEqual(select.options.map((o) => o.value), ["0", "1"]);
});

test("FeishuApprovalClient only resolves elicitation after final step submit", async () => {
  const sent = [];
  const updated = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async (payload) => {
        sent.push(payload);
        return { data: { message_id: "om_q" } };
      },
      patch: async (payload) => {
        updated.push(payload);
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });

  let resolved = false;
  const promise = client.requestElicitation({
    title: "Need input",
    questions: [
      {
        question: "Current work?",
        multiSelect: true,
        options: [{ label: "Feature", description: "Build new flow" }, { label: "Bugfix" }],
      },
      { question: "Constraints?", options: [] },
    ],
  }).then((value) => {
    resolved = true;
    return value;
  });
  await Promise.resolve();
  const firstCard = JSON.parse(sent[0].data.content);
  const requestId = firstCard.elements.find((element) => element.tag === "form")
    .elements.find((element) => element.tag === "button").value.requestId;
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: {
      value: { requestId, kind: "elicitation-step", questionIndex: 0, final: false },
      form_value: {
        q_0: ["0", "1"], // option indices (Feature=0, Bugfix=1), not raw labels
        q_0_other: "API cleanup",
      },
    },
  }), true);
  await Promise.resolve();
  await flush();
  assert.equal(resolved, false);
  assert.equal(updated.length, 1);
  const secondCard = JSON.parse(updated[0].data.content);
  assert.ok(secondCard.elements.some((element) => element.tag === "div" && /2 \/ 2/.test(element.text.content)));

  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: {
      value: { requestId, kind: "elicitation-step", questionIndex: 1, final: true },
      form_value: { q_1_other: "Keep API stable" },
    },
  }), true);
  assert.deepEqual(await promise, {
    type: "elicitation-submit",
    answers: {
      "0": "Feature, Bugfix, API cleanup",
      "1": "Keep API stable",
    },
  });
  await flush();
  assert.match(JSON.parse(updated[1].data.content).header.title.content, /Input submitted/);
});

test("FeishuApprovalClient supports back navigation without resolving elicitation", async () => {
  const sent = [];
  const updated = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async (payload) => {
        sent.push(payload);
        return { data: { message_id: "om_multi" } };
      },
      patch: async (payload) => {
        updated.push(payload);
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });

  let resolved = false;
  const promise = client.requestElicitation({
    title: "Need input",
    questions: [
      { question: "Current work?", options: [{ label: "Feature", description: "Build new flow" }] },
      { question: "Constraints?", options: [] },
    ],
  }).then((value) => {
    resolved = true;
    return value;
  });
  await Promise.resolve();
  const firstCard = JSON.parse(sent[0].data.content);
  const requestId = firstCard.elements.find((element) => element.tag === "form")
    .elements.find((element) => element.tag === "button").value.requestId;
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: {
      value: { requestId, kind: "elicitation-step", questionIndex: 0, final: false },
      form_value: { q_0: "0" }, // option index (Feature=0)
    },
  }), true);
  await Promise.resolve();
  await Promise.resolve();
  await flush();
  assert.equal(resolved, false);
  assert.equal(updated.length, 1);
  const secondCard = JSON.parse(updated[0].data.content);
  assert.ok(secondCard.elements.some((element) => element.tag === "div" && /2 \/ 2/.test(element.text.content)));

  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: {
      value: { requestId, kind: "elicitation-back", questionIndex: 1 },
    },
  }), true);
  await Promise.resolve();
  await flush();
  assert.equal(resolved, false);
  assert.equal(updated.length, 2);
  const backCard = JSON.parse(updated[1].data.content);
  assert.ok(backCard.elements.some((element) => element.tag === "div" && /1 \/ 2/.test(element.text.content)));

  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: {
      value: { requestId, kind: "elicitation-step", questionIndex: 0, final: false },
      form_value: { q_0_other: "Custom feature" },
    },
  }), true);
  await Promise.resolve();
  await flush();
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: {
      value: { requestId, kind: "elicitation-step", questionIndex: 1, final: true },
      form_value: { q_1_other: "Keep API stable" },
    },
  }), true);

  assert.deepEqual(await promise, {
    type: "elicitation-submit",
    answers: {
      "0": "Custom feature",
      "1": "Keep API stable",
    },
  });
});

test("Feishu elicitation helpers validate payloads and action events", () => {
  assert.deepEqual(normalizeElicitationPayload({
    title: " Need input ",
    agentId: "claude-code",
    folder: "project-alpha",
    questions: [{
      header: " H ",
      question: " Q? ",
      options: [{ label: " A ", description: " D " }, { label: "" }],
    }],
  }), {
    title: "Need input",
    detail: "",
    agentId: "claude-code",
    folder: "project-alpha",
    questions: [{
      index: 0,
      header: "H",
      question: "Q?",
      multiSelect: false,
      options: [{ label: "A", description: "D" }],
    }],
  });
  assert.throws(() => normalizeElicitationPayload({ title: "x", questions: [] }), /questions/);
  // A dropped invalid question must not shift later questions' answer keys:
  // `index` stays pinned to the position in the ORIGINAL questions array.
  const shifted = normalizeElicitationPayload({
    title: "Need input",
    questions: [
      { question: "   " },
      { question: `Long? ${"x".repeat(300)}` },
    ],
  });
  assert.equal(shifted.questions.length, 1);
  assert.equal(shifted.questions[0].index, 1);
  assert.equal(shifted.questions[0].question.length, 240);
  assert.deepEqual(normalizeElicitationActionEvent({
    operator: { open_id: "ou_1" },
    action: {
      value: JSON.stringify({
        requestId: "req_q",
        kind: "elicitation-step",
        questionIndex: 0,
        final: true,
      }),
      form_value: { q_0: [{ value: "0", text: { content: "A" } }], q_0_other: "typed answer" },
    },
  }, [{ index: 0, question: "Q?", multiSelect: true, options: [{ label: "A" }] }], "open_id"), {
    operatorId: "ou_1",
      requestId: "req_q",
      decision: { type: "elicitation-step", questionIndex: 0, final: true, answers: { "0": "A, typed answer" } },
  });
  assert.equal(normalizeElicitationActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: { requestId: "req_q", kind: "elicitation-step", questionIndex: 0 }, form_value: {} },
  }, [{ question: "Q?", options: [] }], "open_id"), null);
});

// ── Approver id types ──
// All three are supported paths, so all three need the send parameter AND the
// callback-matching side covered. open_id alone leaves the id types that most
// need checking (union_id/user_id, and their camelCase aliases) unverified.

const ID_TYPE_CASES = [
  { idType: "open_id", approverId: "ou_approver", snake: "open_id", camel: "openId" },
  { idType: "union_id", approverId: "on_approver", snake: "union_id", camel: "unionId" },
  { idType: "user_id", approverId: "uid_approver", snake: "user_id", camel: "userId" },
];

test("sendCard sends receive_id_type matching the configured id type", async () => {
  for (const { idType, approverId } of ID_TYPE_CASES) {
    const sent = [];
    const client = new FeishuApprovalClient({
      appId: "cli_1",
      appSecret: "s",
      approverId,
      idType,
      larkClient: { im: { v1: { message: {
        create: async (payload) => { sent.push(payload); return { data: { message_id: "om_1" } }; },
        patch: async () => ({ data: {} }),
      } } } },
    });
    client.requestApproval({ title: "Run", detail: "Summary" });
    await flush();
    assert.equal(sent[0].params.receive_id_type, idType, `${idType}: approval receive_id_type`);
    assert.equal(sent[0].data.receive_id, approverId, `${idType}: approval receive_id`);

    client.requestElicitation({ title: "Q", questions: [{ question: "Which?", options: [{ label: "A" }] }] });
    await flush();
    assert.equal(sent[1].params.receive_id_type, idType, `${idType}: elicitation receive_id_type`);
    assert.equal(sent[1].data.receive_id, approverId, `${idType}: elicitation receive_id`);
  }
});

test("approval callbacks match the approver under each id type, in snake and camel case", () => {
  for (const { idType, approverId, snake, camel } of ID_TYPE_CASES) {
    for (const key of [snake, camel]) {
      const action = normalizeActionEvent({
        operator: { [key]: approverId },
        action: { value: { requestId: "r1", decision: "allow" } },
      }, idType);
      assert.equal(action.operatorId, approverId, `${idType}: operator.${key} should be read`);
      assert.equal(action.decision, "allow");

      // Some payloads carry the id at the top level instead of under operator.
      const flat = normalizeActionEvent({
        [key]: approverId,
        operator: {},
        action: { value: { requestId: "r1", decision: "deny" } },
      }, idType);
      assert.equal(flat.operatorId, approverId, `${idType}: top-level ${key} should be read`);
    }

    // An id of a DIFFERENT type must not be mistaken for the approver — that
    // would let the wrong identity resolve a permission.
    for (const other of ID_TYPE_CASES.filter((c) => c.idType !== idType)) {
      const mismatched = normalizeActionEvent({
        operator: { [other.snake]: other.approverId },
        action: { value: { requestId: "r1", decision: "allow" } },
      }, idType);
      assert.equal(mismatched.operatorId, "", `${idType}: must not read ${other.snake} as the approver`);
    }
  }
});

test("the client only accepts a decision from the approver under each id type", async () => {
  for (const { idType, approverId, snake } of ID_TYPE_CASES) {
    const client = new FeishuApprovalClient({
      appId: "cli_1",
      appSecret: "s",
      approverId,
      idType,
      larkClient: { im: { v1: { message: {
        create: async () => ({ data: { message_id: "om_1" } }),
        patch: async () => ({ data: {} }),
      } } } },
    });
    const decision = client.requestApproval({ title: "Run", detail: "Summary" });
    await flush();
    const requestId = [...client.pending.keys()][0];

    // Somebody else pressing the button must be ignored.
    assert.equal(client.handleCardAction({
      operator: { [snake]: "someone_else" },
      action: { value: { requestId, decision: "allow" } },
    }), false, `${idType}: a non-approver must not resolve the request`);

    assert.equal(client.handleCardAction({
      operator: { [snake]: approverId },
      action: { value: { requestId, decision: "allow" } },
    }), true, `${idType}: the approver must resolve the request`);
    assert.equal(await decision, "allow", `${idType}: decision`);
  }
});

test("elicitation callbacks match the approver under each id type", () => {
  const questions = [{ index: 0, question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: false }];
  for (const { idType, approverId, snake, camel } of ID_TYPE_CASES) {
    for (const key of [snake, camel]) {
      const step = normalizeElicitationActionEvent({
        operator: { [key]: approverId },
        action: {
          value: { requestId: "r1", kind: "elicitation-step", questionIndex: 0, final: true },
          form_value: { q_0: "0" },
        },
      }, questions, idType);
      assert.equal(step.operatorId, approverId, `${idType}: elicitation operator.${key}`);
      assert.equal(step.decision.type, "elicitation-step");
      assert.deepEqual(step.decision.answers, { "0": "A" });

      const terminal = normalizeElicitationActionEvent({
        operator: { [key]: approverId },
        action: { value: { requestId: "r1", decision: "terminal" } },
      }, questions, idType);
      assert.equal(terminal.operatorId, approverId, `${idType}: elicitation terminal operator.${key}`);
      assert.equal(terminal.decision, "terminal");
    }

    for (const other of ID_TYPE_CASES.filter((c) => c.idType !== idType)) {
      const mismatched = normalizeElicitationActionEvent({
        operator: { [other.snake]: other.approverId },
        action: { value: { requestId: "r1", decision: "terminal" } },
      }, questions, idType);
      assert.equal(mismatched.operatorId, "", `${idType}: must not read ${other.snake} in elicitation`);
    }
  }
});

// ── Card localization + brand ──

test("card keys exist in every supported language", () => {
  const cardKeys = Object.keys(i18n.en).filter((key) => key.startsWith("feishuCard"));
  assert.ok(cardKeys.length >= 40, `expected the full card key set, got ${cardKeys.length}`);
  for (const lang of SUPPORTED_LANGS) {
    for (const key of cardKeys) {
      assert.equal(typeof i18n[lang][key], "string", `${lang}.${key} must be a string`);
      assert.ok(i18n[lang][key].length, `${lang}.${key} must not be empty`);
    }
  }
});

test("approval cards render in the caller's language, not a hardcoded one", () => {
  const payload = { title: "t", agentId: "claude-code", toolName: "Bash", folder: "proj", summary: "Run tests" };
  const expectations = {
    en: { header: "Permission request: claude-code", allow: "Approve once" },
    zh: { header: "权限确认：claude-code", allow: "批准一次" },
    ko: { header: "권한 확인: claude-code", allow: "한 번 승인" },
    ja: { header: "権限確認：claude-code", allow: "1回だけ許可" },
    "zh-TW": { header: "權限確認：claude-code", allow: "批准一次" },
  };
  for (const [lang, expected] of Object.entries(expectations)) {
    const t = createTranslator(() => lang);
    const card = buildApprovalCard(payload, { requestId: "r" }, { t, platform: "feishu" });
    assert.equal(card.header.title.content, expected.header, `${lang} header`);
    const actions = card.elements.find((el) => el.tag === "action");
    assert.equal(actions.actions[0].text.content, expected.allow, `${lang} allow button`);
    assert.match(card.elements[0].text.content, new RegExp(i18n[lang].feishuCardFieldAgent), `${lang} agent label`);
  }
});

// The v0.12.0 defect: cards were Simplified Chinese no matter the language, so
// a Lark user on English got Chinese buttons.
test("a non-Chinese card leaks no Simplified-Chinese and no wrong brand", () => {
  const CJK = /[一-鿿]/;
  for (const lang of ["en", "ko", "ja"]) {
    const t = createTranslator(() => lang);
    const ctx = { t, platform: "lark" };
    const approval = JSON.stringify(buildApprovalCard(
      { title: "t", agentId: "claude-code", summary: "Run tests" }, { requestId: "r" }, ctx
    ));
    const status = JSON.stringify(buildStatusCard(
      { title: "t", agentId: "claude-code" }, { decision: "allow", source: "feishu" }, ctx
    ));
    const elicitation = JSON.stringify(buildElicitationCard(
      { title: "t", agentId: "claude-code", questions: [{ question: "Which?", options: [{ label: "A" }] }] },
      { requestId: "r" },
      ctx
    ));
    for (const [name, serialized] of [["approval", approval], ["status", status], ["elicitation", elicitation]]) {
      if (lang === "ja") continue; // ja legitimately uses kanji
      assert.doesNotMatch(serialized, CJK, `${lang} ${name} card must not contain Chinese characters`);
    }
    assert.doesNotMatch(status, /飞书|Feishu/, `${lang} Lark status card must not say Feishu`);
  }
});

test("the status card source label follows the platform, not the internal routing value", () => {
  const payload = { title: "t", agentId: "claude-code" };
  // source stays "feishu" internally on BOTH platforms; only the label differs.
  const outcome = { decision: "allow", source: "feishu" };

  const larkEn = buildStatusCard(payload, outcome, { t: createTranslator(() => "en"), platform: "lark" });
  assert.match(larkEn.elements[0].text.content, /Lark card/);
  assert.doesNotMatch(larkEn.elements[0].text.content, /Feishu/);

  const feishuEn = buildStatusCard(payload, outcome, { t: createTranslator(() => "en"), platform: "feishu" });
  assert.match(feishuEn.elements[0].text.content, /Feishu card/);
  assert.doesNotMatch(feishuEn.elements[0].text.content, /Lark/);

  const larkZh = buildStatusCard(payload, outcome, { t: createTranslator(() => "zh"), platform: "lark" });
  assert.match(larkZh.elements[0].text.content, /Lark 卡片/);
  assert.doesNotMatch(larkZh.elements[0].text.content, /飞书卡片/);

  const feishuZh = buildStatusCard(payload, outcome, { t: createTranslator(() => "zh"), platform: "feishu" });
  assert.match(feishuZh.elements[0].text.content, /飞书卡片/);

  // A desktop-side decision is platform-independent.
  const desktop = buildStatusCard(payload, { decision: "deny", source: "desktop" }, {
    t: createTranslator(() => "en"), platform: "lark",
  });
  assert.match(desktop.elements[0].text.content, /Desktop bubble/);
});

test("elicitation status cards localize and brand correctly", () => {
  const payload = { title: "t", agentId: "a", questions: [{ question: "Which?", options: [] }] };
  const larkEn = buildElicitationStatusCard(payload, { decision: "elicitation-submit", source: "feishu" }, {
    t: createTranslator(() => "en"), platform: "lark",
  });
  assert.equal(larkEn.header.title.content, "Input submitted");
  assert.match(larkEn.elements[0].text.content, /Lark card/);

  const feishuJa = buildElicitationStatusCard(payload, { decision: "terminal", source: "feishu" }, {
    t: createTranslator(() => "ja"), platform: "feishu",
  });
  assert.equal(feishuJa.header.title.content, i18n.ja.feishuCardStatusTerminalTitle);
  assert.match(feishuJa.elements[0].text.content, /Feishu カード/);
});

test("the client renders cards in the language getLang reports at send time", async () => {
  let lang = "en";
  const sent = [];
  const client = new FeishuApprovalClient({
    appId: "cli_1",
    appSecret: "s",
    approverId: "ou_1",
    platform: "lark",
    getLang: () => lang,
    larkClient: { im: { v1: { message: {
      create: async (payload) => { sent.push(JSON.parse(payload.data.content)); return { data: { message_id: "om_1" } }; },
      patch: async () => ({ data: {} }),
    } } } },
  });

  client.requestApproval({ title: "Run", agentId: "claude-code" });
  await flush();
  assert.equal(sent[0].header.title.content, "Permission request: claude-code");

  // A language switch must take effect without rebuilding the client (which
  // would drop the long connection).
  lang = "ko";
  client.requestApproval({ title: "Run", agentId: "claude-code" });
  await flush();
  assert.equal(sent[1].header.title.content, "권한 확인: claude-code");
});

// ── Platform -> SDK domain ──
// These drive the real exported factories with a fake SDK injected as
// `config.lark`. Going through `larkClient` / `wsFactory` instead would bypass
// the very code that picks the domain.

test("createLarkClient sends the REST client to the Feishu domain, accepting the numeric 0", () => {
  const { sdk, captured } = fakeSdk();
  createLarkClient({ appId: "cli_1", appSecret: "s", lark: sdk, platform: "feishu" });
  assert.equal(captured.client.length, 1);
  // Strict compare, never assert.ok: Domain.Feishu === 0 is falsy but valid.
  assert.strictEqual(captured.client[0].domain, sdk.Domain.Feishu);
  assert.strictEqual(captured.client[0].domain, 0);
  assert.strictEqual(captured.client[0].appType, sdk.AppType.SelfBuild);
});

test("createLarkClient sends the REST client to the Lark domain", () => {
  const { sdk, captured } = fakeSdk();
  createLarkClient({ appId: "cli_1", appSecret: "s", lark: sdk, platform: "lark" });
  assert.strictEqual(captured.client[0].domain, sdk.Domain.Lark);
  assert.strictEqual(captured.client[0].domain, 1);
});

test("lookupOpenIdByEmail resolves an email to open_id on the selected platform", async () => {
  const requests = [];
  const { sdk, captured } = fakeSdk({
    Client: function Client(params) {
      captured.client.push(params);
      this.contact = { v3: { user: {
        batchGetId: async (payload) => {
          requests.push(payload);
          return { code: 0, data: { user_list: [{ email: "person@example.com", user_id: "ou_123" }] } };
        },
      } } };
    },
  });

  const result = await lookupOpenIdByEmail({
    platform: "lark",
    appId: "cli_transient",
    appSecret: "transient-secret",
    email: "person@example.com",
    lark: sdk,
  });

  assert.deepEqual(result, { status: "ok", approverId: "ou_123" });
  assert.deepEqual(requests, [{
    data: { emails: ["person@example.com"] },
    params: { user_id_type: "open_id" },
  }]);
  assert.strictEqual(captured.client[0].domain, sdk.Domain.Lark);
});

test("lookupOpenIdByEmail maps stable business failures without leaking sensitive input", async () => {
  const sensitive = {
    email: "private@example.com",
    appSecret: "super-secret-value",
  };
  const cases = [
    [{ code: 99991672, msg: `scope denied for ${sensitive.email}` }, "missing-contact-scope"],
    [{ code: 0, data: { user_list: [] } }, "approver-not-found"],
    [{ code: 12345, msg: sensitive.appSecret }, "lookup-failed"],
  ];

  for (const [response, expectedCode] of cases) {
    const logs = [];
    const { sdk } = fakeSdk({
      Client: function Client() {
        this.contact = { v3: { user: { batchGetId: async () => response } } };
      },
    });
    const result = await lookupOpenIdByEmail({
      platform: "feishu",
      appId: "cli_test",
      appSecret: sensitive.appSecret,
      email: sensitive.email,
      lark: sdk,
      log: (level, message, meta) => logs.push({ level, message, meta }),
    });

    assert.deepEqual(result, { status: "error", code: expectedCode });
    const serialized = JSON.stringify({ result, logs });
    assert.ok(!serialized.includes(sensitive.email));
    assert.ok(!serialized.includes(sensitive.appSecret));
    assert.ok(!serialized.includes("scope denied"));
    assert.ok(!serialized.includes("request"));
  }
});

test("lookupOpenIdByEmail maps rejected SDK calls using only safe diagnostic metadata", async () => {
  const logs = [];
  const error = new Error("private@example.com super-secret-value");
  error.response = {
    status: 403,
    data: { code: 99991672, msg: "private@example.com" },
    config: { data: { emails: ["private@example.com"] }, headers: { authorization: "Bearer token" } },
  };
  const { sdk } = fakeSdk({
    Client: function Client() {
      this.contact = { v3: { user: { batchGetId: async () => { throw error; } } } };
    },
  });

  const result = await lookupOpenIdByEmail({
    platform: "feishu",
    appId: "cli_test",
    appSecret: "super-secret-value",
    email: "private@example.com",
    lark: sdk,
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  assert.deepEqual(result, { status: "error", code: "missing-contact-scope" });
  assert.deepEqual(logs, [{
    level: "warn",
    message: "email lookup failed",
    meta: {
      code: "missing-contact-scope",
      stage: "lookup",
      httpStatus: 403,
      businessCode: 99991672,
    },
  }]);
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes("private@example.com"));
  assert.ok(!serialized.includes("super-secret-value"));
  assert.ok(!serialized.includes("Bearer token"));
});

test("createWsClient sends the long connection to the domain matching the platform", () => {
  for (const [platform, expected] of [["feishu", 0], ["lark", 1]]) {
    const { sdk, captured } = fakeSdk();
    createWsClient({ appId: "cli_1", appSecret: "s", lark: sdk, platform });
    assert.equal(captured.ws.length, 1);
    assert.strictEqual(captured.ws[0].domain, expected, `${platform} WS domain`);
    assert.strictEqual(
      captured.ws[0].domain,
      platform === "lark" ? sdk.Domain.Lark : sdk.Domain.Feishu
    );
  }
});

// The #493 failure mode: cards send fine over REST while the callback long
// connection sits on the other platform, so no button press ever arrives.
test("REST and WS land on the same domain for a given platform", () => {
  for (const platform of ["feishu", "lark"]) {
    const { sdk, captured } = fakeSdk();
    createLarkClient({ appId: "cli_1", appSecret: "s", lark: sdk, platform });
    createWsClient({ appId: "cli_1", appSecret: "s", lark: sdk, platform });
    assert.strictEqual(captured.client[0].domain, captured.ws[0].domain, `${platform} REST/WS domain mismatch`);
  }
});

test("createLarkClient/createWsClient default an unknown or missing platform to Feishu", () => {
  for (const platform of [undefined, "", "nope", "LARK", null]) {
    const { sdk, captured } = fakeSdk();
    createLarkClient({ appId: "cli_1", appSecret: "s", lark: sdk, platform });
    createWsClient({ appId: "cli_1", appSecret: "s", lark: sdk, platform });
    assert.strictEqual(captured.client[0].domain, sdk.Domain.Feishu, `REST for ${JSON.stringify(platform)}`);
    assert.strictEqual(captured.ws[0].domain, sdk.Domain.Feishu, `WS for ${JSON.stringify(platform)}`);
  }
});

test("a fake SDK without Domain still works for Feishu but fails loudly for Lark", () => {
  // No Domain -> omit the field: the SDK's own default is Feishu, so Feishu
  // still lands on the right host.
  const { sdk, captured } = fakeSdk({ Domain: undefined });
  createLarkClient({ appId: "cli_1", appSecret: "s", lark: sdk, platform: "feishu" });
  createWsClient({ appId: "cli_1", appSecret: "s", lark: sdk, platform: "feishu" });
  assert.strictEqual(captured.client[0].domain, undefined);
  assert.strictEqual(captured.ws[0].domain, undefined);

  // Lark cannot be expressed without the enum. Silently falling back to Feishu
  // would ship Lark credentials to the Feishu host, so it must throw.
  const bare = fakeSdk({ Domain: undefined }).sdk;
  assert.throws(
    () => createLarkClient({ appId: "cli_1", appSecret: "s", lark: bare, platform: "lark" }),
    /Domain\.Lark/
  );
  assert.throws(
    () => createWsClient({ appId: "cli_1", appSecret: "s", lark: bare, platform: "lark" }),
    /Domain\.Lark/
  );

  // Same for an SDK that has Domain but no Lark member.
  const partial = fakeSdk({ Domain: { Feishu: 0 } }).sdk;
  assert.throws(
    () => createLarkClient({ appId: "cli_1", appSecret: "s", lark: partial, platform: "lark" }),
    /Domain\.Lark/
  );
  assert.throws(
    () => createWsClient({ appId: "cli_1", appSecret: "s", lark: partial, platform: "lark" }),
    /Domain\.Lark/
  );
});

test("REST WS and EventDispatcher factories receive the complete safe logger and isolated caches", () => {
  const { sdk, captured } = fakeSdk();
  const restHttpInstance = { request: async () => ({}), post: async () => ({}) };
  const wsHttpInstance = { request: async () => ({}) };

  createLarkClient({
    appId: "cli_factory_security",
    appSecret: "synthetic_factory_secret",
    lark: sdk,
    platform: "feishu",
    httpInstance: restHttpInstance,
  });
  createWsClient({
    appId: "cli_factory_security",
    appSecret: "synthetic_factory_secret",
    lark: sdk,
    platform: "feishu",
    httpInstance: wsHttpInstance,
  });

  assert.strictEqual(captured.client[0].logger, SILENT_LARK_LOGGER);
  assert.ok(captured.client[0].cache);
  assert.strictEqual(captured.client[0].httpInstance, restHttpInstance);
  assert.strictEqual(captured.dispatcher[0].logger, SILENT_LARK_LOGGER);
  assert.ok(captured.dispatcher[0].cache);
  assert.notStrictEqual(captured.dispatcher[0].cache, captured.client[0].cache);
  assert.strictEqual(captured.ws[0].logger, SILENT_LARK_LOGGER);
  assert.strictEqual(captured.ws[0].httpInstance, wsHttpInstance);
  assert.equal(Object.prototype.hasOwnProperty.call(captured.ws[0], "cache"), false);
  assert.equal(captured.cache.length, 2);
});

test("lookup and runtime REST clients retain deadline timeout and abort signal after logger/cache injection", async () => {
  const lookupRequests = [];
  const lookupBaseHttp = {
    request: async (options) => {
      lookupRequests.push(options);
      return { code: 0, data: { user_list: [{ user_id: "ou_deadline_lookup" }] } };
    },
  };
  const lookupHarness = fakeSdk({
    defaultHttpInstance: lookupBaseHttp,
    Client: function Client(params) {
      lookupHarness.captured.client.push(params);
      this.contact = { v3: { user: {
        batchGetId: (payload) => params.httpInstance.request({
          url: "/contact/v3/users/batch_get_id",
          method: "POST",
          data: payload.data,
          params: payload.params,
        }),
      } } };
    },
  });
  const lookupAbort = new AbortController();
  const lookupResult = await lookupOpenIdByEmail({
    appId: "cli_lookup_deadline",
    appSecret: "synthetic_lookup_deadline_secret",
    email: "lookup-deadline@example.invalid",
    lark: lookupHarness.sdk,
    platform: "feishu",
    requestTimeoutMs: 2468,
    signal: lookupAbort.signal,
  });
  assert.deepEqual(lookupResult, { status: "ok", approverId: "ou_deadline_lookup" });
  assert.equal(lookupRequests.length, 1);
  assert.equal(lookupRequests[0].timeout, 2468);
  assert.strictEqual(lookupRequests[0].signal, lookupAbort.signal);
  assert.ok(lookupHarness.captured.client[0].httpInstance);
  assert.equal(typeof lookupHarness.captured.client[0].httpInstance.runWithSignal, "function");
  assert.strictEqual(lookupHarness.captured.client[0].logger, SILENT_LARK_LOGGER);
  assert.ok(lookupHarness.captured.client[0].cache);

  const runtimeRequests = [];
  const runtimeBaseHttp = {
    request: async (options) => {
      runtimeRequests.push(options);
      return { code: 0, data: {} };
    },
  };
  const runtimeHarness = fakeSdk({
    defaultHttpInstance: runtimeBaseHttp,
    Client: function Client(params) {
      runtimeHarness.captured.client.push(params);
      this.im = { v1: { message: {
        patch: (payload) => params.httpInstance.request({
          url: `/messages/${payload.path.message_id}`,
          method: "PATCH",
          data: payload.data,
        }),
      } } };
    },
  });
  const client = new FeishuApprovalClient({
    appId: "cli_runtime_deadline",
    appSecret: "synthetic_runtime_deadline_secret",
    approverId: "ou_runtime_deadline",
    lark: runtimeHarness.sdk,
    platform: "lark",
    cardRequestTimeoutMs: 3579,
  });
  const runtimeApi = client.messageApi();
  assert.ok(runtimeApi);
  assert.ok(client.cardHttpInstance);
  assert.ok(client.larkClient);
  assert.strictEqual(runtimeHarness.captured.client[0].httpInstance, client.cardHttpInstance);
  assert.strictEqual(runtimeHarness.captured.client[0].logger, SILENT_LARK_LOGGER);
  assert.ok(runtimeHarness.captured.client[0].cache);
  const runtimeAbort = new AbortController();
  await client.patchCard("om_runtime_deadline", { type: "card" }, { signal: runtimeAbort.signal });
  assert.equal(runtimeRequests.length, 1);
  assert.equal(runtimeRequests[0].timeout, 3579);
  assert.strictEqual(runtimeRequests[0].signal, runtimeAbort.signal);
});

// Assembly, not just the helper: the platform has to survive the trip from the
// client's constructor into whatever the factories build.
test("FeishuApprovalClient propagates its platform to the WS factory and the REST client", async () => {
  for (const [platform, expected] of [["feishu", 0], ["lark", 1]]) {
    const { sdk, captured } = fakeSdk();
    const client = new FeishuApprovalClient({
      appId: "cli_1",
      appSecret: "s",
      approverId: "ou_1",
      idType: "open_id",
      platform,
      lark: sdk,
    });
    await client.start();
    assert.strictEqual(captured.ws[0].domain, expected, `${platform}: WS domain`);

    // messageApi() builds the REST client lazily through createLarkClient.
    client.messageApi();
    assert.strictEqual(captured.client[0].domain, expected, `${platform}: REST domain`);
    client.close();
  }
});

test("FeishuApprovalClient hands the platform to an injected wsFactory", async () => {
  const seen = [];
  for (const platform of ["feishu", "lark", undefined]) {
    const client = new FeishuApprovalClient({
      appId: "cli_1",
      appSecret: "s",
      approverId: "ou_1",
      platform,
      wsFactory: (params) => {
        seen.push(params.platform);
        return { wsClient: { start: async () => {}, close: () => {} }, dispatcher: {} };
      },
    });
    await client.start();
    client.close();
  }
  assert.deepEqual(seen, ["feishu", "lark", "feishu"]);
});

// Real-machine finding (2026-07-15): a live Lark stepper logged every step as
// `decision=[object Object]`, because the logger stringifies whatever it gets
// and elicitation decisions are objects. That is the only diagnostic this
// channel has, so the shape has to survive — without dragging the answers in.
test("elicitation steps log a readable decision shape, never [object Object]", async () => {
  const logs = [];
  const client = new FeishuApprovalClient({
    appId: "cli_1",
    appSecret: "s",
    approverId: "ou_1",
    idType: "open_id",
    log: (level, message, meta) => logs.push({ level, message, meta }),
    larkClient: { im: { v1: { message: {
      create: async () => ({ data: { message_id: "om_1" } }),
      patch: async () => ({ data: {} }),
    } } } },
  });
  client.requestElicitation({
    title: "Q",
    questions: [
      { question: "First?", options: [{ label: "A" }, { label: "B" }] },
      { question: "Second?", options: [{ label: "C" }] },
    ],
  });
  await flush();
  const requestId = [...client.pending.keys()][0];

  client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, kind: "elicitation-step", questionIndex: 0, final: false }, form_value: { q_0: "0" } },
  });
  client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, kind: "elicitation-back", questionIndex: 1 } },
  });

  const decisions = logs.filter((l) => l.message === "card action received").map((l) => l.meta.decision);
  assert.equal(decisions.length, 2);
  for (const d of decisions) {
    assert.ok(!String(d).includes("[object Object]"), `unreadable decision logged: ${d}`);
  }
  assert.equal(decisions[0], "elicitation-step:q0:answers=1");
  assert.equal(decisions[1], "elicitation-back:q1");

  // The answers themselves are user/agent content and must not ride the log.
  assert.ok(!JSON.stringify(logs).includes("First?"), "question text must not be logged");
  client.close();
});

test("approval decisions still log as plain strings", async () => {
  const logs = [];
  const client = new FeishuApprovalClient({
    appId: "cli_1",
    appSecret: "s",
    approverId: "ou_1",
    log: (level, message, meta) => logs.push({ level, message, meta }),
    larkClient: { im: { v1: { message: {
      create: async () => ({ data: { message_id: "om_1" } }),
      patch: async () => ({ data: {} }),
    } } } },
  });
  const p = client.requestApproval({ title: "Run", detail: "d" });
  await flush();
  const requestId = [...client.pending.keys()][0];
  client.handleCardAction({ operator: { open_id: "ou_1" }, action: { value: { requestId, decision: "deny" } } });
  assert.equal(await p, "deny");
  assert.equal(logs.find((l) => l.message === "card action received").meta.decision, "deny");
  client.close();
});

// Real-machine finding (2026-07-15): pointing a real Lark app at
// open.feishu.cn does NOT fail at the token or bot-info endpoints — those
// accept the app on either gateway. It fails at the WS endpoint, with
// `code=1000040351, msg=Incorrect domain name`. That is the #493 shape exactly
// (cards send, callbacks never arrive) and the most likely user mistake, so it
// gets a stable code instead of leaking "pullConnectConfig failed: …".
test("a wrong-platform gateway rejection is tagged without exposing raw SDK diagnostics", async () => {
  const sensitive = "sensitive_app_secret_123";
  const logs = [];
  const client = new FeishuApprovalClient({
    appId: "cli_1",
    appSecret: "s",
    approverId: "ou_1",
    platform: "feishu",
    wsFactory: (params) => {
      setImmediate(() => params.onError(new Error(
        `pullConnectConfig failed: code=1000040351, msg=Incorrect domain name, secret=${sensitive}`
      )));
      return { wsClient: { start: async () => {}, close: () => {} }, dispatcher: {} };
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });
  await client.start();
  await flush();
  const status = client.getStatus();
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "wrong-platform");
  assert.match(status.message, /Incorrect domain name/);
  assert.equal(JSON.stringify({ status, logs }).includes(sensitive), false);
  assert.equal(JSON.stringify({ status, logs }).includes("pullConnectConfig"), false);
  client.close();
});

test("an unrelated SDK failure becomes a stable sanitized classification", async () => {
  const sensitive = "secret-review@example.com sensitive_app_secret_123";
  const logs = [];
  const client = new FeishuApprovalClient({
    appId: "cli_1",
    appSecret: "s",
    approverId: "ou_1",
    platform: "lark",
    wsFactory: (params) => {
      setImmediate(() => params.onError(new Error(`app ticket is invalid ${sensitive}`)));
      return { wsClient: { start: async () => {}, close: () => {} }, dispatcher: {} };
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });
  await client.start();
  await flush();
  const status = client.getStatus();
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "sdk-request-failed");
  assert.equal(status.message, "Feishu/Lark long connection failed.");
  assert.equal(JSON.stringify({ status, logs }).includes(sensitive), false);
  client.close();
});

test("FeishuApprovalClient reports approval and elicitation delivery after receiving message ids", async () => {
  const messageIds = ["om_approval_delivered", "om_question_delivered"];
  const fakeClient = {
    im: { v1: { message: {
      create: async () => ({ data: { message_id: messageIds.shift() } }),
      patch: async () => ({ data: {} }),
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });

  const approvalReports = [];
  const approvalController = new AbortController();
  const approvalPromise = client.requestApproval(
    { title: "Run", detail: "Summary" },
    {
      signal: approvalController.signal,
      onDelivered: (report) => approvalReports.push(report),
    },
  );
  assert.deepEqual(approvalReports, []);
  await flush();
  assert.deepEqual(approvalReports, [{ messageId: "om_approval_delivered" }]);
  approvalController.abort();
  assert.equal(await approvalPromise, null);

  const questionReports = [];
  const questionController = new AbortController();
  const questionPromise = client.requestElicitation(
    { title: "Question", questions: [{ question: "Which?", options: [{ label: "A" }] }] },
    {
      signal: questionController.signal,
      onDelivered: (report) => questionReports.push(report),
    },
  );
  assert.deepEqual(questionReports, []);
  await flush();
  assert.deepEqual(questionReports, [{ messageId: "om_question_delivered" }]);
  questionController.abort();
  assert.equal(await questionPromise, null);
});

test("FeishuApprovalClient resolves null on send failure by default but rejects with rejectOnSendError", async () => {
  const sensitive = "secret-review@example.com sensitive_app_secret_123";
  const sendError = new Error(`invalid receive_id ${sensitive}`);
  const fakeClient = {
    im: { v1: { message: {
      create: async () => { throw sendError; },
      patch: async () => ({ data: {} }),
    } } },
  };
  const logs = [];
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_bad",
    idType: "open_id",
    larkClient: fakeClient,
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  // Approval callers keep the null contract so they can fall back to the
  // local permission bubble.
  const delivered = [];
  assert.equal(await client.requestApproval(
    { title: "Run", detail: "Summary" },
    { onDelivered: (report) => delivered.push(report) },
  ), null);
  assert.deepEqual(delivered, [], "a failed send must not report delivery");

  assert.equal(await client.requestElicitation(
    { title: "Question", questions: [{ question: "Which?", options: [{ label: "A" }] }] },
    { onDelivered: (report) => delivered.push(report) },
  ), null);
  assert.deepEqual(delivered, [], "a failed elicitation send must not report delivery");

  // The settings test path opts into rejection so a send failure is not
  // misreported as "card sent but nobody pressed a button" (#493 review).
  await assert.rejects(
    client.requestApproval({ title: "Run", detail: "Summary" }, { rejectOnSendError: true }),
    (error) => error && error.code === "sdk-request-failed"
      && error.message === "Feishu/Lark SDK request failed."
  );
  assert.equal(client.pending.size, 0);
  assert.equal(logs.filter((entry) => entry.level === "warn" && entry.message === "send failed").length, 2);
  assert.equal(JSON.stringify(logs).includes(sensitive), false);
});

// ---------------------------------------------------------------------------
// Shared response assertion at every im.v1.message create/patch boundary.
// The SDK resolves these calls even when the business `code` is nonzero, so
// each boundary must reject such responses instead of reporting success.
// One table row per call site; every scenario below loops over the table.
// ---------------------------------------------------------------------------

const RESPONSE_LEAK = "leak-app-secret leak-review@example.com t-leak-tenant-token";

const approvalBoundaryPayload = normalizeApprovalPayload({ title: "Run", detail: "Summary: Run tests" });
const elicitationBoundaryPayload = normalizeElicitationPayload({
  title: "Pick",
  questions: [{ question: "Which one?", options: [{ label: "A" }] }],
});

const MESSAGE_RESPONSE_BOUNDARIES = [
  {
    name: "sendCard",
    stage: "send-card",
    kind: "create",
    invoke: (client) => client.sendCard("fs_boundary", approvalBoundaryPayload),
  },
  {
    name: "sendElicitationCard",
    stage: "send-elicitation",
    kind: "create",
    invoke: (client) => client.sendElicitationCard("fsq_boundary", elicitationBoundaryPayload, { questionIndex: 0 }),
  },
  {
    name: "updateCard",
    stage: "update-card",
    kind: "patch",
    invoke: (client) => client.updateCard("om_boundary", approvalBoundaryPayload, { decision: "allow", source: "feishu" }),
  },
  {
    name: "patchCard",
    stage: "session-automation-card",
    kind: "patch",
    invoke: (client) => client.patchCard("om_boundary", { header: { title: { tag: "plain_text", content: "x" } } }),
  },
  {
    name: "updateElicitationCard",
    stage: "update-card",
    kind: "patch",
    invoke: (client) => client.updateElicitationCard("om_boundary", elicitationBoundaryPayload, { decision: "terminal", source: "feishu" }),
  },
  {
    name: "updateElicitationQuestionCard",
    stage: "update-card",
    kind: "patch",
    invoke: (client) => client.updateElicitationQuestionCard("om_boundary", elicitationBoundaryPayload, "fsq_boundary", 0, {}),
  },
];

function boundaryClient(response) {
  return new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: {
      im: { v1: { message: {
        create: async () => response,
        patch: async () => response,
      } } },
    },
  });
}

function sanitizedErrorSnapshot(error) {
  return {
    message: error.message,
    code: error.code,
    stage: error.stage,
    businessCode: error.businessCode,
  };
}

test("every message boundary rejects a resolved nonzero business code with a sanitized error", async () => {
  const response = { code: 230001, msg: `param invalid ${RESPONSE_LEAK}`, data: { message_id: "om_should_not_count" } };
  for (const boundary of MESSAGE_RESPONSE_BOUNDARIES) {
    const client = boundaryClient(response);
    await assert.rejects(boundary.invoke(client), (error) => {
      assert.deepEqual(sanitizedErrorSnapshot(error), {
        message: "Feishu/Lark SDK request failed.",
        code: "sdk-request-failed",
        stage: boundary.stage,
        businessCode: 230001,
      }, boundary.name);
      assert.equal(JSON.stringify({ ...error, message: error.message }).includes("leak-"), false, boundary.name);
      return true;
    }, boundary.name);
  }
});

test("every message boundary accepts code 0 and the codeless legacy shape", async () => {
  for (const response of [
    { code: 0, msg: "success", data: { message_id: "om_ok" } },
    { data: { message_id: "om_ok" } },
  ]) {
    for (const boundary of MESSAGE_RESPONSE_BOUNDARIES) {
      const result = await boundary.invoke(boundaryClient(response));
      if (boundary.kind === "create") assert.equal(result, "om_ok", boundary.name);
    }
  }
});

test("create boundaries reject a success code without a usable message_id", async () => {
  const responses = [
    { code: 0, msg: "success", data: {} },
    { code: 0, msg: "success", data: { message_id: "" } },
    { code: 0, msg: "success", data: { message_id: "   " } },
    { code: 0, msg: "success", data: { message_id: "\t" } },
  ];
  for (const response of responses) {
    for (const boundary of MESSAGE_RESPONSE_BOUNDARIES.filter((entry) => entry.kind === "create")) {
      await assert.rejects(boundary.invoke(boundaryClient(response)), (error) => {
        assert.deepEqual(sanitizedErrorSnapshot(error), {
          message: "Feishu/Lark SDK request failed.",
          code: "sdk-request-failed",
          stage: boundary.stage,
          businessCode: undefined,
        }, `${boundary.name} ${JSON.stringify(response.data)}`);
        return true;
      }, `${boundary.name} ${JSON.stringify(response.data)}`);
    }
  }
});

test("known business codes keep their dedicated sanitized codes at message boundaries", async () => {
  for (const [businessCode, expectedCode] of [
    [99991672, "missing-contact-scope"],
    [1000040351, "wrong-platform"],
  ]) {
    const client = boundaryClient({ code: businessCode, msg: "denied", data: {} });
    await assert.rejects(client.sendCard("fs_mapped", approvalBoundaryPayload), (error) => {
      assert.equal(error.code, expectedCode);
      assert.equal(error.businessCode, businessCode);
      return true;
    });
  }
});

test("a resolved nonzero create response surfaces through requestApproval without losing businessCode", async () => {
  const logs = [];
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: {
      im: { v1: { message: {
        create: async () => ({ code: 230001, msg: `param invalid ${RESPONSE_LEAK}` }),
        patch: async () => ({ code: 0, msg: "success", data: {} }),
      } } },
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  await assert.rejects(
    client.requestApproval({ title: "Run", detail: "Summary" }, { rejectOnSendError: true }),
    (error) => error.code === "sdk-request-failed"
      && error.businessCode === 230001
      && error.message === "Feishu/Lark SDK request failed."
  );
  assert.equal(client.pending.size, 0);
  const warn = logs.find((entry) => entry.level === "warn" && entry.message === "send failed");
  assert.deepEqual(warn.meta, { code: "sdk-request-failed", stage: "send-card", businessCode: 230001 });
  assert.equal(JSON.stringify(logs).includes("leak-"), false);
});
