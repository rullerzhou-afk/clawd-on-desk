"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  FeishuApprovalClient,
  buildApprovalCard,
  buildElicitationCard,
  buildStatusCard,
  normalizeApprovalPayload,
  normalizeElicitationPayload,
  normalizeActionEvent,
  normalizeElicitationActionEvent,
} = require("../src/feishu-approval-client");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
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
  assert.equal(card.header.title.content, "权限确认：claude-code");
  assert.match(card.elements[0].text.content, /智能体/);
  assert.match(card.elements[0].text.content, /摘要/);
  const action = card.elements.find((element) => element.tag === "action");
  assert.equal(action.actions.length, 3);
  assert.equal(action.actions[0].text.content, "批准一次");
  assert.equal(action.actions[1].text.content, "拒绝");
  assert.equal(action.actions[2].text.content, "前往终端");
  assert.deepEqual(action.actions[0].value, { requestId: "req_1", decision: "allow" });
  assert.deepEqual(action.actions[1].value, { requestId: "req_1", decision: "deny" });
  const secondAction = card.elements.filter((element) => element.tag === "action")[1];
  assert.equal(secondAction.actions[0].text.content, "自动接受编辑");
  assert.deepEqual(secondAction.actions[0].value, { requestId: "req_1", decision: "suggestion:0" });
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
  assert.match(detail, /\*\*摘要\*\*/, "our own fixed label keeps its formatting");
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
  assert.match(JSON.parse(updated[0].data.content).header.title.content, /已批准/);
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
  assert.match(JSON.parse(patches[0].data.content).header.title.content, /已批准/);
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
  assert.match(client.getStatus().message, /long connection disabled/);
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
  assert.match(JSON.parse(updated[0].data.content).header.title.content, /已转到终端处理/);

  const ac2 = new AbortController();
  const secondPromise = client.requestApproval(
    { title: "Run", detail: "Summary: Run tests" },
    { signal: ac2.signal }
  );
  await Promise.resolve();
  assert.equal(client.resolveApprovalExternally(ac2.signal, {
    decision: "deny",
    actionLabel: "拒绝",
    source: "desktop",
  }), true);
  assert.equal(await secondPromise, null);
  assert.match(JSON.parse(updated[1].data.content).header.title.content, /已拒绝/);
  assert.match(JSON.parse(updated[1].data.content).elements[0].text.content, /桌面弹窗/);
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
    actionLabel: "批准一次",
    source: "desktop",
  }), true);
  resolveCreate({ data: { message_id: "om_late" } });

  assert.equal(await decisionPromise, null);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].path.message_id, "om_late");
  assert.match(JSON.parse(updated[0].data.content).elements[0].text.content, /桌面弹窗/);
});

test("FeishuApprovalClient ignores non-approver actions and aborts pending request", async () => {
  const fakeClient = {
    im: { v1: { message: {
      create: async () => ({ data: { message_id: "om_1" } }),
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
  assert.equal(card.header.title.content, "需要输入：claude-code");
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
      question: "您当前正在进行什么类型的工作？",
      multiSelect: true,
      options: [{ label: "开发新功能" }, { label: "修复Bug" }],
    }],
  }, {
    requestId: "req_q",
    answers: { "您当前正在进行什么类型的工作？": "开发新功能, 自定义工作" },
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
      "Current work?": "Feature, Bugfix, API cleanup",
      "Constraints?": "Keep API stable",
    },
  });
  assert.match(JSON.parse(updated[1].data.content).header.title.content, /已提交输入/);
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
      "Current work?": "Custom feature",
      "Constraints?": "Keep API stable",
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
      header: "H",
      question: "Q?",
      multiSelect: false,
      options: [{ label: "A", description: "D" }],
    }],
  });
  assert.throws(() => normalizeElicitationPayload({ title: "x", questions: [] }), /questions/);
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
  }, [{ question: "Q?", multiSelect: true, options: [{ label: "A" }] }], "open_id"), {
    operatorId: "ou_1",
      requestId: "req_q",
      decision: { type: "elicitation-step", questionIndex: 0, final: true, answers: { "Q?": "A, typed answer" } },
  });
  assert.equal(normalizeElicitationActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: { requestId: "req_q", kind: "elicitation-step", questionIndex: 0 }, form_value: {} },
  }, [{ question: "Q?", options: [] }], "open_id"), null);
});

test("FeishuApprovalClient resolves null on send failure by default but rejects with rejectOnSendError", async () => {
  const sendError = new Error("invalid receive_id");
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
  assert.equal(await client.requestApproval({ title: "Run", detail: "Summary" }), null);

  // The settings test path opts into rejection so a send failure is not
  // misreported as "card sent but nobody pressed a button" (#493 review).
  await assert.rejects(
    client.requestApproval({ title: "Run", detail: "Summary" }, { rejectOnSendError: true }),
    /invalid receive_id/
  );
  assert.equal(client.pending.size, 0);
  assert.equal(logs.filter((entry) => entry.level === "warn" && entry.message === "send failed").length, 2);
});
