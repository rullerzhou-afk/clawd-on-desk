"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  FeishuApprovalClient,
  buildApprovalCard,
  buildElicitationCard,
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

test("FeishuApprovalClient sends a card and resolves from card action", async () => {
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
  assert.equal(updated.length, 1);
  assert.equal(updated[0].path.message_id, "om_1");
  assert.match(JSON.parse(updated[0].data.content).header.title.content, /已批准/);
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
  assert.deepEqual(restoredSelect.selected_values, ["开发新功能"]);
  assert.equal(restoredOther.default_value, "自定义工作");
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
        q_0: ["Feature", "Bugfix"],
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
      form_value: { q_0: "Feature" },
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
      form_value: { q_0: [{ value: "A", text: { content: "A" } }], q_0_other: "typed answer" },
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
