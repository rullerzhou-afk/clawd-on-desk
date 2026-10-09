"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const initPermission = require("../src/permission");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");
const { getSessionFocusTarget } = require("../src/session-focus");
const { buildApprovalCard } = require("../src/feishu-approval-client");

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

function cardActionButtons(card) {
  return card.elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions);
}

function createMockResponse() {
  const captured = { statusCode: null, headers: {}, body: null, ended: false, destroyed: false };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
    },
    write(chunk) { captured.body = (captured.body || "") + String(chunk); },
    end(chunk) {
      if (chunk !== undefined) captured.body = (captured.body || "") + String(chunk);
      captured.ended = true;
      this.writableEnded = true;
    },
    on() {},
    removeListener() {},
    destroy() { captured.destroyed = true; this.destroyed = true; },
  };
}

function makeCtx(overrides = {}) {
  return {
    focusTerminalForSession() {},
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop() {},
    reapplyMacVisibility() {},
    repositionUpdateBubble() {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map(),
    STATE_SVGS: {},
    setState() {},
    updateSession() {},
    ...overrides,
  };
}

function makeEntry(overrides = {}) {
  return {
    res: createMockResponse(),
    abortHandler() {},
    suggestions: [],
    sessionId: "deepseek-harness:session-1",
    bubble: null,
    hideTimer: null,
    toolName: "bash",
    toolInput: {},
    resolvedSuggestion: null,
    createdAt: Date.now(),
    isDsh: true,
    agentId: "deepseek-harness",
    interaction: classifyPermissionInteraction({
      agentId: "deepseek-harness",
      toolName: "bash",
    }),
    ...overrides,
  };
}

describe("DSH permission response contract", () => {
  it("returns only the DSH allow vocabulary", () => {
    const perm = initPermission(makeCtx());
    const entry = makeEntry();
    perm.pendingPermissions.push(entry);
    perm.resolvePermissionEntry(entry, "allow");
    assert.strictEqual(entry.res.captured.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(entry.res.captured.body), { decision: "allow" });
  });

  it("returns only the DSH deny vocabulary", () => {
    const perm = initPermission(makeCtx());
    const entry = makeEntry();
    perm.pendingPermissions.push(entry);
    perm.resolvePermissionEntry(entry, "deny", "user rejected");
    assert.strictEqual(entry.res.captured.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(entry.res.captured.body), { decision: "deny" });
  });

  it("uses an explicit 204 no-decision response so the plugin can call next()", () => {
    const perm = initPermission(makeCtx());
    const entry = makeEntry();
    perm.pendingPermissions.push(entry);
    perm.resolvePermissionEntry(entry, "no-decision", "native fallback");
    assert.strictEqual(entry.res.captured.statusCode, 204);
    assert.strictEqual(entry.res.captured.ended, true);
    assert.strictEqual(entry.res.captured.destroyed, false);
    assert.strictEqual(entry.res.captured.body, null);
  });

  it("never serializes Claude elicitation fields for a DSH entry", () => {
    const perm = initPermission(makeCtx());
    const entry = makeEntry({
      toolName: "ask_user_question",
      isElicitation: true,
      resolvedUpdatedInput: { answers: { Question: "Answer" } },
    });
    perm.pendingPermissions.push(entry);
    perm.resolvePermissionEntry(entry, "allow");
    assert.deepStrictEqual(JSON.parse(entry.res.captured.body), { decision: "allow" });
  });

  for (const decision of ["allow", "deny"]) {
    it(`maps a remote-only ${decision} through the DSH wire vocabulary`, async () => {
      const client = { requestApproval: async () => decision };
      const perm = initPermission(makeCtx({
        getRemoteApprovalClients: () => [{ name: "test-remote", client }],
      }));
      const entry = makeEntry({ remoteOnly: true });
      perm.pendingPermissions.push(entry);
      assert.strictEqual(perm.maybeStartRemoteApproval(entry), true);
      await flushAsync();
      assert.strictEqual(entry.res.captured.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(entry.res.captured.body), { decision });
    });
  }

  it("waits for every remote-only client before returning DSH no-decision", async () => {
    let settleSecond;
    const clients = [
      { name: "first", client: { requestApproval: async () => null } },
      { name: "second", client: { requestApproval: () => new Promise((resolve) => { settleSecond = resolve; }) } },
    ];
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => clients }));
    const entry = makeEntry({ remoteOnly: true });
    perm.pendingPermissions.push(entry);
    assert.strictEqual(perm.maybeStartRemoteApproval(entry), true);
    await flushAsync();
    assert.strictEqual(entry.res.captured.statusCode, null);
    settleSecond(null);
    await flushAsync();
    assert.strictEqual(entry.res.captured.statusCode, 204);
    assert.strictEqual(entry.res.captured.destroyed, false);
  });

  it("labels the DeepSeek Harness queue entry by its agent id", () => {
    assert.strictEqual(initPermission.__test.queueAgentLabel({ agentId: "deepseek-harness" }), "DeepSeek Harness");
    assert.strictEqual(initPermission.__test.queueAgentLabel({ agentId: "unknown-agent" }), "unknown-agent");
  });

  it("copies the desktop carrier into the fallback focus entry", () => {
    const { buildPermissionFocusEntry } = initPermission.__test;
    const entry = buildPermissionFocusEntry({
      sessionId: "deepseek-harness:s1",
      agentId: "deepseek-harness",
      dshCarrier: "desktop",
    });
    assert.strictEqual(entry.dshCarrier, "desktop");
    assert.deepStrictEqual(getSessionFocusTarget(entry, { osPlatform: "darwin" }), {
      canFocus: true,
      type: "dsh-desktop",
      url: "dsh://open",
    });

    const plain = buildPermissionFocusEntry({
      sessionId: "deepseek-harness:s1",
      agentId: "deepseek-harness",
    });
    assert.strictEqual(Object.hasOwn(plain, "dshCarrier"), false);
    assert.deepStrictEqual(getSessionFocusTarget(plain, { osPlatform: "darwin" }), {
      canFocus: false,
      type: null,
      url: null,
    });
  });

  async function captureRemotePayload(entry) {
    const captured = [];
    const client = {
      requestApproval: async (payload) => {
        captured.push(payload);
        return null;
      },
    };
    const perm = initPermission(makeCtx({
      getRemoteApprovalClients: () => [{ name: "feishu", client }],
    }));
    perm.pendingPermissions.push(entry);
    assert.strictEqual(perm.maybeStartRemoteApproval(entry), true);
    await flushAsync();
    assert.strictEqual(captured.length, 1);
    return captured[0];
  }

  for (const label of ["desktop", "web"]) {
    it(`the real DSH ${label} remote payload renders a Feishu card without a terminal action`, async () => {
      const payload = await captureRemotePayload(makeEntry({
        remoteOnly: true,
        ...(label === "desktop" ? { dshCarrier: "desktop" } : {}),
      }));

      assert.strictEqual(payload.canOfferTerminal, false);
      assert.strictEqual(Object.hasOwn(payload, "agentId"), false);
      const actions = cardActionButtons(buildApprovalCard(payload, { requestId: "r" }));
      assert.deepStrictEqual(actions.map((button) => button.value.decision), ["allow", "deny"]);
      assert.ok(!actions.some((button) => button.text.content === "Go to terminal"));
    });
  }

  it("a claude-code remote payload keeps its detail and the Feishu terminal action", async () => {
    const payload = await captureRemotePayload(makeEntry({
      remoteOnly: true,
      agentId: "claude-code",
      interaction: classifyPermissionInteraction({ agentId: "claude-code", toolName: "bash" }),
    }));

    assert.strictEqual(payload.canOfferTerminal, undefined);
    assert.strictEqual(Object.hasOwn(payload, "agentId"), false);

    const card = buildApprovalCard(payload, { requestId: "r" });
    assert.ok(cardActionButtons(card).some((button) => button.text.content === "Go to terminal"));
    // The card must stay byte-for-byte what the payload produced before the
    // DSH capability flag existed: no structured layout, title and body intact.
    const baseline = buildApprovalCard({
      title: payload.title,
      detail: payload.detail,
      fields: payload.fields,
    }, { requestId: "r" });
    assert.deepStrictEqual(card, baseline);
    assert.match(card.elements[0].text.content, /Summary: /);
  });
});
