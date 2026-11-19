"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createPermissionIngressHarness,
  postPermission,
  waitUntil,
} = require("./helpers/permission-ingress-harness");
const { makeSessionKey } = require("../src/session-key");
const { stopActivePermissionReviews } = require("../src/permission-review-command");

const NONCE = "a".repeat(32);
const UUID = "01a119d3-1893-7f42-aadc-fa33ca4166a8";
const TURN = "01a119d7-24b5-7010-9da2-d8791ff8a1d1";

function codexBody(overrides = {}) {
  return {
    agent_id: "codex",
    hook_source: "codex-official",
    session_id: `codex:${UUID}`,
    host: "ruller-win",
    turn_id: TURN,
    permission_mode: "default",
    tool_name: "mcp__playwright__browser_navigate",
    tool_input: { url: "https://example.com" },
    tool_use_id: "call-1",
    tool_input_fingerprint: "fp-1",
    ...overrides,
  };
}

async function createRemoteHarness({ mode, ctxOverrides = {} } = {}) {
  return createPermissionIngressHarness({
    render: true,
    remoteProfile: { profileId: "win-box", displayHost: "ruller-win" },
    routingNonces: [NONCE],
    ctxOverrides: {
      getCodexPermissionMode: () => "auto",
      getEffectivePermissionAutomationMode: () => mode,
      ...ctxOverrides,
    },
  });
}

function remoteHeaders() {
  return { "x-clawd-routing-nonce": NONCE };
}

test("Codex remote MCP: auto-tools claims an ordinary remote MCP request", async (t) => {
  const notices = [];
  const h = await createRemoteHarness({
    mode: "auto-tools",
    ctxOverrides: { notifyCodexRemoteFallback: (payload) => notices.push(payload) },
  });
  t.after(() => h.close());

  const response = await postPermission(h.remotePort, codexBody(), remoteHeaders()).response;
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).hookSpecificOutput.decision.behavior, "allow");
  assert.equal(h.permission.pendingPermissions.length, 0);
  assert.equal(notices.length, 0);
});

test("Codex remote MCP: global automation off returns no-decision and queues a remote notice", async (t) => {
  const notices = [];
  const h = await createRemoteHarness({
    mode: "off",
    ctxOverrides: { notifyCodexRemoteFallback: (payload) => notices.push(payload) },
  });
  t.after(() => h.close());

  const response = await postPermission(h.remotePort, codexBody(), remoteHeaders()).response;
  assert.equal(response.status, 204);
  assert.equal(response.body, "");
  assert.equal(h.shown.length, 0);
  assert.equal(h.permission.pendingPermissions.length, 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].sessionId, makeSessionKey({ profileId: "win-box", rawSessionId: `codex:${UUID}` }));
  assert.equal(notices[0].rawSessionId, `codex:${UUID}`);
  assert.equal(notices[0].profileId, "win-box");
  assert.equal(notices[0].host, "ruller-win");
  assert.equal(notices[0].toolName, "mcp__playwright__browser_navigate");
  assert.equal(notices[0].turnId, TURN);
  assert.equal(notices[0].toolUseId, "call-1");
  assert.equal(notices[0].toolInputFingerprint, "fp-1");
});

test("Codex remote MCP: local MCP still returns no-decision without a notice", async (t) => {
  const notices = [];
  const h = await createPermissionIngressHarness({
    render: true,
    ctxOverrides: {
      getCodexPermissionMode: () => "auto",
      getEffectivePermissionAutomationMode: () => "auto-tools",
      notifyCodexRemoteFallback: (payload) => notices.push(payload),
    },
  });
  t.after(() => h.close());

  const localBody = codexBody();
  delete localBody.host;
  const response = await postPermission(h.port, localBody, {}).response;
  assert.equal(response.status, 204);
  assert.equal(h.shown.length, 0);
  assert.equal(h.permission.pendingPermissions.length, 0);
  assert.equal(notices.length, 0);
});

test("Codex remote MCP: the Codex app namespace is never claimed", async (t) => {
  const notices = [];
  const h = await createRemoteHarness({
    mode: "auto-tools",
    ctxOverrides: { notifyCodexRemoteFallback: (payload) => notices.push(payload) },
  });
  t.after(() => h.close());

  for (const toolName of [
    "mcp__codex_apps__vercel__list_projects",
    "MCP__CODEX_APPS__VERCEL__LIST_PROJECTS",
  ]) {
    const response = await postPermission(
      h.remotePort,
      codexBody({ tool_name: toolName }),
      remoteHeaders()
    ).response;
    assert.equal(response.status, 204, toolName);
  }
  assert.equal(h.shown.length, 0);
  assert.equal(h.permission.pendingPermissions.length, 0);
  assert.equal(notices.length, 2);
});

test("Codex remote MCP: a claimed request whose automation stopped still returns no-decision", async (t) => {
  let modeCalls = 0;
  const notices = [];
  const remoteApprovalRequests = [];
  const h = await createRemoteHarness({
    mode: "auto-tools",
    ctxOverrides: {
      // The route asks once (claim succeeds), then the live bubble asks again
      // and finds automation off. The request must go native, not open a card.
      getEffectivePermissionAutomationMode: () => (modeCalls++ === 0 ? "auto-tools" : "off"),
      getRemoteApprovalClients: () => [{
        name: "fake",
        client: {
          isEnabled: () => true,
          requestApproval() {
            remoteApprovalRequests.push("requested");
            return new Promise(() => {});
          },
        },
      }],
      notifyCodexRemoteFallback: (payload) => notices.push(payload),
    },
  });
  h.ctx.maybeStartRemoteApproval = h.permission.maybeStartRemoteApproval;
  t.after(() => h.close());

  const response = await postPermission(h.remotePort, codexBody(), remoteHeaders()).response;
  assert.equal(response.status, 204);
  assert.equal(response.body, "");
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].bubble, null);
  assert.equal(h.shown[0].codexRemoteDisplayHost, "ruller-win");
  assert.equal(h.permission.pendingPermissions.length, 0);
  assert.equal(remoteApprovalRequests.length, 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].host, "ruller-win");
  assert.equal(notices[0].toolName, "mcp__playwright__browser_navigate");
});

test("Codex remote MCP: session overrides, holds and interactive subagents still defer", async (t) => {
  const cases = [
    {
      name: "session override",
      body: {},
      ctxOverrides: { hasSessionAutomationOverride: () => true },
    },
    {
      name: "reminder hold",
      body: {
        tool_name: "Bash",
        tool_input: { command: "rm -rf src" },
      },
      ctxOverrides: {
        isDestructiveReminderEnabled: () => true,
      },
    },
    {
      name: "interactive subagent",
      body: {
        codex_session_role: "subagent",
        codex_originator: "codex_cli_rs",
      },
      ctxOverrides: {},
    },
  ];

  for (const testCase of cases) {
    const notices = [];
    const h = await createRemoteHarness({
      mode: "auto-tools",
      ctxOverrides: {
        ...testCase.ctxOverrides,
        notifyCodexRemoteFallback: (payload) => notices.push(payload),
      },
    });
    try {
      const response = await postPermission(
        h.remotePort,
        codexBody(testCase.body),
        remoteHeaders()
      ).response;
      assert.equal(response.status, 204, testCase.name);
      assert.equal(h.permission.pendingPermissions.length, 0, testCase.name);
      assert.equal(notices.length, 1, testCase.name);
    } finally {
      await h.close();
    }
  }
});

test("Codex remote MCP: a bubble creation failure still queues the remote notice", async (t) => {
  const notices = [];
  const h = await createPermissionIngressHarness({
    render: true,
    remoteProfile: { profileId: "win-box", displayHost: "ruller-win" },
    routingNonces: [NONCE],
    showPermissionBubbleThrows: true,
    ctxOverrides: {
      getCodexPermissionMode: () => "intercept",
      notifyCodexRemoteFallback: (payload) => notices.push(payload),
    },
  });
  t.after(() => h.close());

  const response = await postPermission(h.remotePort, codexBody(), remoteHeaders()).response;
  assert.equal(response.status, 204);
  assert.equal(response.body, "");
  assert.equal(h.permission.pendingPermissions.length, 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].toolName, "mcp__playwright__browser_navigate");
});

test("Codex remote MCP: a request claimed by automation is not shown as pending", async (t) => {
  const h = await createRemoteHarness({ mode: "unattended" });
  t.after(() => h.close());

  const response = await postPermission(h.remotePort, codexBody(), remoteHeaders()).response;
  assert.equal(response.status, 200);
  await waitUntil(() => h.permission.pendingPermissions.length === 0, "claim left a pending entry");
});


test("Codex remote MCP: a WSL request without Remote SSH ingress queues no notice", async (t) => {
  const notices = [];
  const h = await createPermissionIngressHarness({
    render: true,
    ctxOverrides: {
      getCodexPermissionMode: () => "auto",
      getEffectivePermissionAutomationMode: () => "off",
      notifyCodexRemoteFallback: (payload) => notices.push(payload),
    },
  });
  t.after(() => h.close());

  const response = await postPermission(h.port, codexBody({
    host: undefined,
    wsl_distro: "Ubuntu",
  }), {}).response;
  assert.equal(response.status, 204);
  assert.equal(h.permission.pendingPermissions.length, 0);
  assert.equal(notices.length, 0);
});

test("Codex remote MCP: DND queues no notice", async (t) => {
  const notices = [];
  const h = await createPermissionIngressHarness({
    render: true,
    remoteProfile: { profileId: "win-box", displayHost: "ruller-win" },
    routingNonces: [NONCE],
    ctxOverrides: {
      doNotDisturb: true,
      getCodexPermissionMode: () => "auto",
      getEffectivePermissionAutomationMode: () => "off",
      notifyCodexRemoteFallback: (payload) => notices.push(payload),
    },
  });
  t.after(() => h.close());

  const response = await postPermission(h.remotePort, codexBody(), remoteHeaders()).response;
  assert.equal(response.status, 204);
  assert.equal(h.permission.pendingPermissions.length, 0);
  assert.equal(notices.length, 0);
});

test("Codex remote MCP: a normally cancelled external review queues a notice", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-cancel-"));
  const marker = path.join(home, "started");
  const queued = [];
  const h = await createRemoteHarness({
    mode: "auto-tools",
    ctxOverrides: {
      getPermissionReviewConfig: () => ({
        command: [process.execPath, "-e",
          `require("fs").writeFileSync(${JSON.stringify(marker)}, "1");setTimeout(() => {}, 60000);`],
        timeoutMs: 60000,
      }),
      notifyCodexRemoteFallback: (payload) => {
        queued.push(payload);
        return true;
      },
    },
  });
  t.after(async () => {
    await h.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const pending = postPermission(h.remotePort, codexBody(), remoteHeaders());
  await waitUntil(() => fs.existsSync(marker), "external review did not start");
  stopActivePermissionReviews();
  const response = await pending.response;

  assert.equal(response.status, 204);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].profileId, "win-box");
  assert.equal(queued[0].toolName, "mcp__playwright__browser_navigate");
});

test("Codex remote MCP: a client-disconnected review queues no notice", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-disconnect-"));
  const marker = path.join(home, "started");
  const queued = [];
  const h = await createRemoteHarness({
    mode: "auto-tools",
    ctxOverrides: {
      getPermissionReviewConfig: () => ({
        command: [process.execPath, "-e",
          `require("fs").writeFileSync(${JSON.stringify(marker)}, "1");setTimeout(() => {}, 60000);`],
        timeoutMs: 60000,
      }),
      notifyCodexRemoteFallback: (payload) => {
        queued.push(payload);
        return true;
      },
    },
  });
  t.after(async () => {
    await h.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const pending = postPermission(h.remotePort, codexBody(), remoteHeaders());
  await waitUntil(() => fs.existsSync(marker), "external review did not start");
  pending.request.destroy();
  await pending.response;
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(queued.length, 0);
});

