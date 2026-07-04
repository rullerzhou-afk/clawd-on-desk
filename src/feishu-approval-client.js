"use strict";

const crypto = require("crypto");

const ACTION_ROW_SIZE = 3;
const MAX_ELICITATION_QUESTIONS = 5;
const MAX_ELICITATION_OPTIONS = 5;
const MAX_CARD_TEXT = 600;

function loadLarkSdk() {
  try {
    return require("@larksuiteoapi/node-sdk");
  } catch (err) {
    const next = new Error("Missing @larksuiteoapi/node-sdk. Run npm install first.");
    next.cause = err;
    throw next;
  }
}

function normalizeApprovalPayload(payload) {
  const title = String((payload && payload.title) || "").trim();
  if (!title) throw new Error("Feishu approval payload title is required");
  const detail = payload && payload.detail != null ? String(payload.detail) : "";
  const suggestions = Array.isArray(payload && payload.suggestions)
    ? payload.suggestions
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const index = Number(entry.index);
        const label = String(entry.label || "").trim();
        if (!Number.isInteger(index) || index < 0 || !label) return null;
        return { index, label };
      })
      .filter(Boolean)
    : [];
  return {
    title,
    detail,
    agentId: String((payload && payload.agentId) || "").trim(),
    toolName: String((payload && payload.toolName) || "").trim(),
    folder: String((payload && payload.folder) || "").trim(),
    summary: String((payload && payload.summary) || "").trim(),
    suggestions,
  };
}

function clampText(value, max = MAX_CARD_TEXT) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function normalizeElicitationPayload(payload) {
  const title = clampText(payload && payload.title, 120);
  if (!title) throw new Error("Feishu elicitation payload title is required");
  const rawQuestions = Array.isArray(payload && payload.questions) ? payload.questions : [];
  const questions = rawQuestions
    .slice(0, MAX_ELICITATION_QUESTIONS)
    .map((question) => {
      if (!question || typeof question !== "object") return null;
      const questionText = clampText(question.question, 240);
      if (!questionText) return null;
      const options = Array.isArray(question.options)
        ? question.options
          .slice(0, MAX_ELICITATION_OPTIONS)
          .map((option) => {
            if (!option || typeof option !== "object") return null;
            const label = clampText(option.label, 80);
            if (!label) return null;
            return {
              label,
              description: clampText(option.description, 160),
            };
          })
          .filter(Boolean)
        : [];
      return {
        header: clampText(question.header, 80),
        question: questionText,
        multiSelect: question.multiSelect === true,
        options,
      };
    })
    .filter(Boolean);
  if (!questions.length) throw new Error("Feishu elicitation payload questions are required");
  return {
    title,
    detail: payload && payload.detail != null ? clampText(payload.detail, MAX_CARD_TEXT) : "",
    agentId: clampText(payload && payload.agentId, 80),
    folder: clampText(payload && payload.folder, 80),
    questions,
  };
}

function button(text, value, type) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    value,
  };
}

function isValidDecisionValue(value) {
  return value === "allow"
    || value === "deny"
    || value === "terminal"
    || /^suggestion:\d+$/.test(String(value || ""));
}

function isValidElicitationDecision(value) {
  if (value === "terminal") return true;
  return !!(value && typeof value === "object" && value.type === "elicitation-submit");
}

function buildActionRows(actions) {
  const rows = [];
  for (let i = 0; i < actions.length; i += ACTION_ROW_SIZE) {
    rows.push({ tag: "action", actions: actions.slice(i, i + ACTION_ROW_SIZE) });
  }
  return rows;
}

function buildApprovalDetail(normalized) {
  if (normalized.agentId || normalized.toolName || normalized.folder || normalized.summary) {
    return [
      normalized.agentId ? `**智能体**：${normalized.agentId}` : null,
      normalized.toolName ? `**工具**：${normalized.toolName}` : null,
      normalized.folder ? `**目录**：${normalized.folder}` : null,
      normalized.summary ? `**摘要**：${normalized.summary}` : null,
    ].filter(Boolean).join("\n");
  }
  return normalized.detail || normalized.title;
}

function buildElicitationDetail(normalized) {
  const lines = [];
  if (normalized.agentId) lines.push(`**智能体**：${normalized.agentId}`);
  if (normalized.folder) lines.push(`**目录**：${normalized.folder}`);
  if (normalized.detail) lines.push(`**说明**：${normalized.detail}`);
  return lines.join("\n");
}

function questionFormName(index) {
  return `q_${index}`;
}

function questionOtherFormName(index) {
  return `q_${index}_other`;
}

function optionValue(label) {
  return String(label || "");
}

function selectOption(option) {
  return {
    text: { tag: "plain_text", content: option.label },
    value: optionValue(option.label),
  };
}

function buildQuestionText(question, index, total = 1) {
  const title = question.header || `问题 ${index + 1}`;
  const progress = total > 1 ? `**${index + 1} / ${total}**\n` : "";
  const optionText = question.options.length
    ? question.multiSelect
      ? `\n\n请选择一个或多个选项，也可以填写其他答案。`
      : `\n\n请选择一个选项，也可以填写其他答案。`
    : `\n\n请在输入框填写答案。`;
  return `${progress}**${title}**\n${question.question}${optionText}`;
}

function buildAnsweredSummaries(questions, answers, activeQuestionIndex) {
  const lines = [];
  for (let i = 0; i < questions.length; i += 1) {
    if (i === activeQuestionIndex) continue;
    const question = questions[i];
    const questionText = question && question.question;
    if (!questionText || !answers || !answers[questionText]) continue;
    const title = question.header || `问题 ${i + 1}`;
    lines.push(`**${title}**：${answers[questionText]}`);
  }
  return lines.join("\n");
}

function buildQuestionInput(question, questionIndex, answers = {}) {
  if (!question.options.length) return null;
  const selected = parseAnswerParts(answers[question.question]);
  const component = {
    tag: question.multiSelect ? "multi_select_static" : "select_static",
    name: questionFormName(questionIndex),
    placeholder: { tag: "plain_text", content: question.multiSelect ? "选择一个或多个选项" : "选择一个选项" },
    options: question.options.map(selectOption),
  };
  const optionValues = new Set(question.options.map((option) => optionValue(option.label)));
  const selectedValues = selected.filter((value) => optionValues.has(value));
  if (question.multiSelect && selectedValues.length) {
    component.selected_values = selectedValues;
  } else if (!question.multiSelect && selectedValues.length) {
    component.initial_option = selectedValues[0];
  }
  return component;
}

function buildOtherInput(question, questionIndex, answers = {}) {
  const selected = parseAnswerParts(answers[question.question]);
  const optionValues = new Set(question.options.map((option) => optionValue(option.label)));
  const otherText = selected.filter((value) => !optionValues.has(value)).join(", ");
  return {
    tag: "input",
    name: questionOtherFormName(questionIndex),
    placeholder: { tag: "plain_text", content: question.options.length ? "输入其他答案" : "输入答案" },
    default_value: otherText,
  };
}

function normalizeStatusOutcome(outcome) {
  const raw = outcome && typeof outcome === "object" ? outcome : { decision: outcome };
  const decision = String(raw.decision || raw.behavior || "").trim();
  const actionLabel = String(raw.actionLabel || raw.message || "").trim();
  const source = String(raw.source || "").trim();
  const isSuggestion = /^suggestion:\d+$/.test(decision);

  if (decision === "deny") {
    return {
      decision,
      template: "red",
      title: "已拒绝",
      result: actionLabel || "拒绝",
      source,
    };
  }
  if (decision === "terminal") {
    return {
      decision,
      template: "blue",
      title: "已转到终端处理",
      result: actionLabel || "前往终端处理",
      source,
    };
  }
  if (decision === "no-decision") {
    return {
      decision,
      template: "blue",
      title: "已取消",
      result: actionLabel || "未返回审批结果",
      source,
    };
  }
  if (isSuggestion) {
    return {
      decision,
      template: "green",
      title: "已批准并更新权限",
      result: actionLabel || "已应用权限建议",
      source,
    };
  }
  return {
    decision: "allow",
    template: "green",
    title: "已批准",
    result: actionLabel || "批准一次",
    source,
  };
}

function sourceLabel(source) {
  if (source === "desktop") return "桌面弹窗";
  if (source === "feishu") return "飞书卡片";
  if (source === "remote") return "远程审批";
  return "";
}

function buildApprovalCard(payload, options = {}) {
  const normalized = normalizeApprovalPayload(payload);
  const requestId = String(options.requestId || "");
  const actions = [
    button("批准一次", { requestId, decision: "allow" }, "primary"),
    button("拒绝", { requestId, decision: "deny" }, "danger"),
    button("前往终端", { requestId, decision: "terminal" }, "default"),
    ...normalized.suggestions.map((entry) => (
      button(entry.label, { requestId, decision: `suggestion:${entry.index}` }, "default")
    )),
  ];
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: `权限确认：${normalized.agentId || normalized.title}` },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: buildApprovalDetail(normalized) },
      },
      ...buildActionRows(actions),
    ],
  };
}

function buildElicitationCard(payload, options = {}) {
  const normalized = normalizeElicitationPayload(payload);
  const requestId = String(options.requestId || "");
  const answers = options.answers && typeof options.answers === "object" && !Array.isArray(options.answers)
    ? options.answers
    : {};
  const questionIndex = Math.max(0, Math.min(
    Number.isInteger(options.questionIndex) ? options.questionIndex : 0,
    normalized.questions.length - 1
  ));
  const question = normalized.questions[questionIndex];
  const elements = [];
  const detail = buildElicitationDetail(normalized);
  if (detail) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: detail },
    });
  }

  elements.push({
    tag: "div",
    text: { tag: "lark_md", content: buildQuestionText(question, questionIndex, normalized.questions.length) },
  });

  const answeredSummary = buildAnsweredSummaries(normalized.questions, answers, questionIndex);
  if (answeredSummary) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: answeredSummary },
    });
  }

  const formElements = [];
  const selectionInput = buildQuestionInput(question, questionIndex, answers);
  if (selectionInput) formElements.push(selectionInput);
  formElements.push(buildOtherInput(question, questionIndex, answers));
  const isLastQuestion = questionIndex >= normalized.questions.length - 1;
  formElements.push({
    ...button(isLastQuestion ? "提交回答" : "下一步", {
      requestId,
      kind: "elicitation-step",
      questionIndex,
      final: isLastQuestion,
    }, "primary"),
    name: isLastQuestion ? `elicitation_submit_${questionIndex}` : `elicitation_next_${questionIndex}`,
    action_type: "form_submit",
  });

  elements.push({
    tag: "form",
    name: `elicitation_form_${questionIndex}`,
    elements: formElements,
  });
  const navigation = [];
  if (questionIndex > 0) {
    navigation.push(button("上一步", { requestId, kind: "elicitation-back", questionIndex }, "default"));
  }
  navigation.push(button("前往终端", { requestId, decision: "terminal" }, "default"));
  elements.push({ tag: "action", actions: navigation });

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: `需要输入：${normalized.agentId || normalized.title}` },
    },
    elements,
  };
}

function buildStatusCard(payload, outcome) {
  const normalized = normalizeApprovalPayload(payload);
  const status = normalizeStatusOutcome(outcome);
  const source = sourceLabel(status.source);
  const detail = [
    buildApprovalDetail(normalized),
    "",
    `**处理结果**：${status.result}`,
    source ? `**处理来源**：${source}` : null,
  ].filter((line) => line !== null).join("\n");
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: status.template,
      title: { tag: "plain_text", content: status.title },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: detail },
      },
    ],
  };
}

function buildElicitationStatusCard(payload, outcome) {
  const normalized = normalizeElicitationPayload(payload);
  const raw = outcome && typeof outcome === "object" ? outcome : { decision: outcome };
  const source = sourceLabel(String(raw.source || "").trim());
  const terminal = raw.decision === "terminal";
  const submitted = raw.decision === "elicitation-submit";
  const template = submitted ? "green" : "blue";
  const title = submitted ? "已提交输入" : terminal ? "已转到终端处理" : "已取消";
  const result = submitted ? "已提交问答结果" : terminal ? "前往终端处理" : "未返回输入结果";
  const detail = [
    buildElicitationDetail(normalized),
    "",
    `**处理结果**：${result}`,
    source ? `**处理来源**：${source}` : null,
  ].filter((line) => line !== null).join("\n");
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template,
      title: { tag: "plain_text", content: title },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: detail },
      },
    ],
  };
}

function parseMaybeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeFormValue(source) {
  const action = source && source.action && typeof source.action === "object" ? source.action : {};
  const candidates = [
    action.form_value,
    action.formValue,
    source.form_value,
    source.formValue,
  ];
  const out = {};
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    for (const [key, value] of Object.entries(candidate)) {
      if (Array.isArray(value)) {
        const values = value
          .map((item) => normalizeFormScalar(item))
          .filter(Boolean);
        if (values.length) out[key] = values;
        continue;
      }
      const text = normalizeFormScalar(value);
      if (text) out[key] = text;
    }
  }
  const inputValue = clampText(action.input_value ?? action.inputValue, MAX_CARD_TEXT);
  if (inputValue) out.input_value = inputValue;
  return out;
}

function normalizeFormScalar(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidates = [
      value.value,
      value.text && value.text.content,
      value.content,
      value.label,
    ];
    for (const candidate of candidates) {
      const text = clampText(candidate, MAX_CARD_TEXT);
      if (text) return text;
    }
    return "";
  }
  return clampText(value, MAX_CARD_TEXT);
}

function normalizeFormArrayValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeFormScalar(item))
      .filter(Boolean);
  }
  const text = normalizeFormScalar(value);
  return text ? [text] : [];
}

function parseAnswerParts(value) {
  if (Array.isArray(value)) return value.map((item) => clampText(item, MAX_CARD_TEXT)).filter(Boolean);
  const text = clampText(value, MAX_CARD_TEXT);
  if (!text) return [];
  return text.split(",").map((part) => clampText(part, MAX_CARD_TEXT)).filter(Boolean);
}

function buildQuestionAnswer(question, questionIndex, formValue) {
  if (!question || typeof question.question !== "string" || !question.question) return "";
  const selected = normalizeFormArrayValue(formValue[questionFormName(questionIndex)]);
  const other = normalizeFormScalar(formValue[questionOtherFormName(questionIndex)] || formValue.input_value);
  const parts = [...selected];
  if (other) parts.push(other);
  const seen = new Set();
  const deduped = [];
  for (const part of parts) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    deduped.push(part);
  }
  return deduped.join(", ");
}

function mergeElicitationAnswers(base, addition) {
  return {
    ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}),
    ...(addition && typeof addition === "object" && !Array.isArray(addition) ? addition : {}),
  };
}

function countAnsweredQuestions(questions, answers) {
  const normalizedQuestions = Array.isArray(questions) ? questions : [];
  const normalizedAnswers = answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};
  return normalizedQuestions.reduce((count, question) => {
    const questionText = question && typeof question.question === "string" ? question.question : "";
    return questionText && normalizedAnswers[questionText] ? count + 1 : count;
  }, 0);
}

function normalizeActionEvent(event, idType = "open_id") {
  const source = event && typeof event === "object" ? event : {};
  const operator = source.operator && typeof source.operator === "object" ? source.operator : {};
  const action = source.action && typeof source.action === "object" ? source.action : {};
  const value = parseMaybeJsonObject(action.value);
  if (!value) return null;
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  const decision = isValidDecisionValue(value.decision) ? String(value.decision) : "";
  if (!requestId || !decision) return null;
  const aliases = idType === "user_id"
    ? ["user_id", "userId"]
    : idType === "union_id"
      ? ["union_id", "unionId"]
      : ["open_id", "openId"];
  let operatorId = "";
  for (const key of aliases) {
    if (typeof operator[key] === "string" && operator[key]) {
      operatorId = operator[key];
      break;
    }
    if (typeof source[key] === "string" && source[key]) {
      operatorId = source[key];
      break;
    }
  }
  return { operatorId, requestId, decision };
}

function normalizeElicitationActionEvent(event, questions, idType = "open_id") {
  const source = event && typeof event === "object" ? event : {};
  const operator = source.operator && typeof source.operator === "object" ? source.operator : {};
  const action = source.action && typeof source.action === "object" ? source.action : {};
  const value = parseMaybeJsonObject(action.value);
  if (!value) return null;
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  if (!requestId) return null;
  const aliases = idType === "user_id"
    ? ["user_id", "userId"]
    : idType === "union_id"
      ? ["union_id", "unionId"]
      : ["open_id", "openId"];
  let operatorId = "";
  for (const key of aliases) {
    if (typeof operator[key] === "string" && operator[key]) {
      operatorId = operator[key];
      break;
    }
    if (typeof source[key] === "string" && source[key]) {
      operatorId = source[key];
      break;
    }
  }

  if (value.decision === "terminal") return { operatorId, requestId, decision: "terminal" };

  const kind = typeof value.kind === "string" ? value.kind : "";
  if (kind === "elicitation-back") {
    return {
      operatorId,
      requestId,
      decision: {
        type: "elicitation-back",
        questionIndex: Number.isInteger(value.questionIndex) ? value.questionIndex : -1,
      },
    };
  }

  if (kind === "elicitation-step") {
    const formValue = normalizeFormValue(source);
    const normalizedQuestions = Array.isArray(questions) ? questions : [];
    const questionIndex = Number.isInteger(value.questionIndex) ? value.questionIndex : -1;
    const question = questionIndex >= 0 && questionIndex < normalizedQuestions.length
      ? normalizedQuestions[questionIndex]
      : null;
    const answerText = buildQuestionAnswer(question, questionIndex, formValue);
    if (!answerText) return null;
    const answers = {};
    answers[question.question] = answerText;
    return {
      operatorId,
      requestId,
      decision: {
        type: "elicitation-step",
        questionIndex,
        final: value.final === true,
        answers,
      },
    };
  }

  return null;
}

function normalizeApiMessageId(response) {
  return response && response.data && typeof response.data.message_id === "string"
    ? response.data.message_id
    : "";
}

function createLarkClient(config = {}) {
  const lark = config.lark || loadLarkSdk();
  return new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType ? lark.AppType.SelfBuild : undefined,
    domain: lark.Domain ? lark.Domain.Feishu : undefined,
    loggerLevel: lark.LoggerLevel ? lark.LoggerLevel.warn : undefined,
  });
}

function createWsClient(config = {}) {
  const lark = config.lark || loadLarkSdk();
  const dispatcher = new lark.EventDispatcher({
    verificationToken: config.verificationToken || "",
    encryptKey: config.encryptKey || "",
    loggerLevel: lark.LoggerLevel ? lark.LoggerLevel.warn : undefined,
  }).register({
    "card.action.trigger": async (event) => {
      if (typeof config.onCardAction === "function") await config.onCardAction(event);
      return undefined;
    },
  });
  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: lark.LoggerLevel ? lark.LoggerLevel.warn : undefined,
    autoReconnect: true,
    handshakeTimeoutMs: config.handshakeTimeoutMs || 15000,
    onReady: config.onReady,
    onError: config.onError,
    onReconnecting: config.onReconnecting,
    onReconnected: config.onReconnected,
  });
  return { wsClient, dispatcher };
}

function normalizeConnectionState(connection) {
  const state = connection && typeof connection.state === "string" ? connection.state : "";
  if (state === "connected" || state === "connecting" || state === "reconnecting" || state === "failed" || state === "idle") {
    return state;
  }
  return "idle";
}

function statusForConnectionState(state, enabled) {
  if (!enabled) return "stopped";
  if (state === "connected") return "running";
  if (state === "connecting" || state === "reconnecting") return "starting";
  if (state === "failed") return "failed";
  return "ready";
}

function normalizeConnectionTimeoutMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.max(1, Math.round(numeric * 1000));
  }
  return 15000;
}

class FeishuApprovalClient {
  constructor(options = {}) {
    this.appId = options.appId || "";
    this.appSecret = options.appSecret || "";
    this.verificationToken = options.verificationToken || "";
    this.encryptKey = options.encryptKey || "";
    this.approverId = options.approverId || "";
    this.idType = options.idType || "open_id";
    this.lark = options.lark || null;
    this.larkClient = options.larkClient || null;
    this.wsFactory = options.wsFactory || createWsClient;
    this.wsClient = options.wsClient || null;
    this.dispatcher = options.dispatcher || null;
    this.pending = new Map();
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.onStatusChange = typeof options.onStatusChange === "function" ? options.onStatusChange : () => {};
    this.connectionState = "idle";
    this.lastErrorMessage = "";
    this.connectionTimeoutMs = normalizeConnectionTimeoutMs(options.connectionTimeoutSeconds);
    this.connectionTimer = null;
    this.connectionTimerMode = "";
    this.lastStatusNotifyKey = "";
    // Bumped on every start()/close(); WS lifecycle callbacks from an older
    // wsClient generation must not mutate the state of the current one. The
    // SDK's initial-start path can fire onReady/onError after close() (no
    // generation re-check after its await), so we guard on our side.
    this.wsGeneration = 0;
  }

  isEnabled() {
    return !!(this.appId && this.appSecret && this.approverId);
  }

  getStatus() {
    const connection = this.wsClient && typeof this.wsClient.getConnectionStatus === "function"
      ? this.wsClient.getConnectionStatus()
      : { state: this.wsClient ? this.connectionState : "idle", reconnectAttempts: 0 };
    const sdkState = normalizeConnectionState(connection);
    let state = sdkState;
    if (this.connectionState === "failed" && sdkState !== "connected") {
      state = "failed";
    } else if (this.connectionState === "connected" && (sdkState === "idle" || sdkState === "connecting")) {
      state = "connected";
    } else if ((this.connectionState === "connecting" || this.connectionState === "reconnecting") && sdkState === "idle") {
      state = this.connectionState;
    }
    this.connectionState = state;
    return {
      status: statusForConnectionState(state, this.isEnabled()),
      message: state === "failed" ? this.lastErrorMessage : "",
      connection: { ...connection, state },
    };
  }

  notifyStatusChange() {
    const status = this.getStatus();
    const key = [
      status.status || "",
      status.message || "",
      status.connection && status.connection.state ? status.connection.state : "",
    ].join("\u001f");
    if (key === this.lastStatusNotifyKey) return;
    this.lastStatusNotifyKey = key;
    try {
      this.onStatusChange(status);
    } catch {}
  }

  isConnected() {
    return this.getStatus().status === "running";
  }

  clearConnectionTimer() {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    this.connectionTimerMode = "";
  }

  startConnectionTimer(mode) {
    this.clearConnectionTimer();
    this.connectionTimerMode = mode === "reconnecting" ? "reconnecting" : "connecting";
    this.connectionTimer = setTimeout(() => {
      const activeMode = this.connectionTimerMode;
      if (this.connectionState !== activeMode) return;
      this.connectionState = "failed";
      const seconds = Math.max(1, Math.round(this.connectionTimeoutMs / 1000));
      const label = activeMode === "reconnecting" ? "reconnect" : "connection";
      this.lastErrorMessage = `Feishu long ${label} timed out after ${this.connectionTimeoutMs}ms. Check app credentials, long connection event subscription, and network.`;
      this.log("warn", "connection timeout", { error: this.lastErrorMessage, timeoutSeconds: seconds });
      this.clearConnectionTimer();
      this.notifyStatusChange();
    }, this.connectionTimeoutMs);
    if (typeof this.connectionTimer.unref === "function") this.connectionTimer.unref();
  }

  async start() {
    if (!this.isEnabled()) return false;
    const current = this.getStatus().status;
    if (this.wsClient && (current === "running" || current === "starting")) return false;
    if (this.wsClient) this.close();
    const generation = ++this.wsGeneration;
    const ifCurrent = (fn) => (...args) => {
      if (generation !== this.wsGeneration) return;
      fn(...args);
    };
    const created = this.wsFactory({
      appId: this.appId,
      appSecret: this.appSecret,
      verificationToken: this.verificationToken || "",
      encryptKey: this.encryptKey || "",
      lark: this.lark,
      handshakeTimeoutMs: this.connectionTimeoutMs,
      onCardAction: (event) => this.handleCardAction(event),
      onReady: ifCurrent(() => {
        this.clearConnectionTimer();
        this.connectionState = "connected";
        this.lastErrorMessage = "";
        this.log("info", "connected");
        this.notifyStatusChange();
      }),
      onError: ifCurrent((err) => {
        this.clearConnectionTimer();
        this.connectionState = "failed";
        this.lastErrorMessage = err && err.message ? err.message : String(err || "Feishu long connection failed");
        this.log("warn", "connection failed", { error: this.lastErrorMessage });
        this.notifyStatusChange();
      }),
      onReconnecting: ifCurrent(() => {
        this.connectionState = "reconnecting";
        this.lastErrorMessage = "";
        this.startConnectionTimer("reconnecting");
        this.log("info", "reconnecting");
        this.notifyStatusChange();
      }),
      onReconnected: ifCurrent(() => {
        this.clearConnectionTimer();
        this.connectionState = "connected";
        this.lastErrorMessage = "";
        this.log("info", "reconnected");
        this.notifyStatusChange();
      }),
    });
    this.wsClient = created.wsClient;
    this.dispatcher = created.dispatcher;
    this.connectionState = "connecting";
    this.lastErrorMessage = "";
    this.startConnectionTimer("connecting");
    this.notifyStatusChange();
    if (this.wsClient && typeof this.wsClient.start === "function") {
      await this.wsClient.start({ eventDispatcher: this.dispatcher });
    }
    return true;
  }

  waitUntilConnected(timeoutMs = 15000) {
    if (this.isConnected()) return Promise.resolve(true);
    if (this.getStatus().status === "failed") return Promise.resolve(false);
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const status = this.getStatus();
        if (status.status === "running") {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (status.status === "failed" || Date.now() - start >= timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 100);
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  close() {
    this.wsGeneration += 1;
    this.clearConnectionTimer();
    if (this.wsClient && typeof this.wsClient.close === "function") {
      try { this.wsClient.close(); } catch {}
    }
    this.wsClient = null;
    this.dispatcher = null;
    this.connectionState = "idle";
    this.lastErrorMessage = "";
    for (const entry of this.pending.values()) {
      entry.resolve(null);
    }
    this.pending.clear();
    this.notifyStatusChange();
  }

  messageApi() {
    const client = this.larkClient || (this.larkClient = createLarkClient({
      appId: this.appId,
      appSecret: this.appSecret,
      lark: this.lark,
    }));
    return client && client.im && client.im.v1 && client.im.v1.message
      ? client.im.v1.message
      : client && client.im && client.im.message;
  }

  requestApproval(payload, options = {}) {
    let normalized;
    try {
      normalized = normalizeApprovalPayload(payload);
    } catch {
      return Promise.resolve(null);
    }
    if (!this.isEnabled()) return Promise.resolve(null);
    const requestId = `fs_${crypto.randomBytes(12).toString("hex")}`;
    const signal = options.signal;
    if (signal && signal.aborted) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision) => {
        if (settled) return;
        settled = true;
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        this.pending.delete(requestId);
        resolve(isValidDecisionValue(decision) ? decision : null);
      };
      const onAbort = () => finish(null);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      const entry = {
        payload: normalized,
        messageId: "",
        signal: signal || null,
        resolve: finish,
        sendReady: null,
      };
      this.pending.set(requestId, entry);
      entry.sendReady = this.sendCard(requestId, normalized)
        .then((messageId) => {
          entry.messageId = messageId || "";
          const current = this.pending.get(requestId);
          if (current) current.messageId = messageId || "";
          return current || entry;
        })
        .catch((err) => {
          this.log("warn", "send failed", { error: err && err.message ? err.message : String(err) });
          finish(null);
          return entry;
        });
    });
  }

  requestElicitation(payload, options = {}) {
    let normalized;
    try {
      normalized = normalizeElicitationPayload(payload);
    } catch {
      return Promise.resolve(null);
    }
    if (!this.isEnabled()) return Promise.resolve(null);
    const requestId = `fsq_${crypto.randomBytes(12).toString("hex")}`;
    const signal = options.signal;
    if (signal && signal.aborted) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision) => {
        if (settled) return;
        settled = true;
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        this.pending.delete(requestId);
        resolve(isValidElicitationDecision(decision) ? decision : null);
      };
      const onAbort = () => finish(null);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      const entry = {
        payload: normalized,
        messageId: "",
        signal: signal || null,
        resolve: finish,
        sendReady: null,
        kind: "elicitation",
        answers: {},
        activeQuestionIndex: 0,
      };
      this.pending.set(requestId, entry);
      entry.sendReady = this.sendElicitationCard(requestId, normalized, { questionIndex: 0 })
        .then((messageId) => {
          entry.messageId = messageId || "";
          const current = this.pending.get(requestId);
          if (current) current.messageId = messageId || "";
          return current || entry;
        })
        .catch((err) => {
          this.log("warn", "send elicitation failed", { error: err && err.message ? err.message : String(err) });
          finish(null);
          return entry;
        });
    });
  }

  async sendCard(requestId, payload) {
    const message = this.messageApi();
    if (!message || typeof message.create !== "function") throw new Error("Feishu message.create is unavailable");
    const response = await message.create({
      params: { receive_id_type: this.idType || "open_id" },
      data: {
        receive_id: this.approverId,
        msg_type: "interactive",
        content: JSON.stringify(buildApprovalCard(payload, { requestId })),
      },
    });
    const messageId = normalizeApiMessageId(response);
    this.log("debug", "card sent", { requestId, messageId });
    return messageId;
  }

  async sendElicitationCard(requestId, payload, options = {}) {
    const message = this.messageApi();
    if (!message || typeof message.create !== "function") throw new Error("Feishu message.create is unavailable");
    const response = await message.create({
      params: { receive_id_type: this.idType || "open_id" },
      data: {
        receive_id: this.approverId,
        msg_type: "interactive",
        content: JSON.stringify(buildElicitationCard(payload, { requestId, questionIndex: options.questionIndex || 0 })),
      },
    });
    const messageId = normalizeApiMessageId(response);
    this.log("debug", "elicitation card sent", { requestId, messageId });
    return messageId;
  }

  async updateCard(messageId, payload, outcome) {
    if (!messageId) return;
    const message = this.messageApi();
    if (!message || typeof message.patch !== "function") return;
    await message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(buildStatusCard(payload, outcome)) },
    });
  }

  async updateElicitationCard(messageId, payload, outcome) {
    if (!messageId) return;
    const message = this.messageApi();
    if (!message || typeof message.patch !== "function") return;
    await message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(buildElicitationStatusCard(payload, outcome)) },
    });
  }

  async updateElicitationQuestionCard(messageId, payload, requestId, questionIndex, answers = {}) {
    if (!messageId) return;
    const message = this.messageApi();
    if (!message || typeof message.patch !== "function") return;
    await message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(buildElicitationCard(payload, {
          requestId,
          questionIndex,
          answers,
        })),
      },
    });
  }

  findPendingBySignal(signal) {
    if (!signal) return null;
    for (const [requestId, entry] of this.pending.entries()) {
      if (entry && entry.signal === signal) return { requestId, entry };
    }
    return null;
  }

  resolveApprovalExternally(signal, outcome = {}) {
    const found = this.findPendingBySignal(signal);
    if (!found) return false;
    const { entry } = found;
    Promise.resolve(entry.sendReady)
      .then(() => {
        const nextOutcome = {
          ...outcome,
          source: outcome.source || "desktop",
        };
        if (entry.kind === "elicitation") {
          return this.updateElicitationCard(entry.messageId, entry.payload, nextOutcome);
        }
        return this.updateCard(entry.messageId, entry.payload, nextOutcome);
      })
      .catch((err) => {
        this.log("warn", "external update failed", { error: err && err.message ? err.message : String(err) });
      })
      .finally(() => entry.resolve(null));
    return true;
  }

  handleCardAction(event) {
    const action = normalizeActionEvent(event, this.idType);
    const requestId = action && action.requestId
      ? action.requestId
      : (() => {
          const source = event && typeof event === "object" ? event : {};
          const value = parseMaybeJsonObject(source.action && source.action.value);
          return value && typeof value.requestId === "string" ? value.requestId : "";
        })();
    const entry = requestId ? this.pending.get(requestId) : null;
    const normalizedAction = entry && entry.kind === "elicitation"
      ? normalizeElicitationActionEvent(event, entry.payload.questions, this.idType)
      : action;
    this.log("debug", "card action received", {
      requestId,
      decision: normalizedAction && normalizedAction.decision ? normalizedAction.decision : "",
      matched: !!(normalizedAction && normalizedAction.operatorId === this.approverId && entry),
    });
    if (!normalizedAction || normalizedAction.operatorId !== this.approverId) return false;
    if (!entry) return false;

    if (entry.kind === "elicitation" && normalizedAction.decision !== "terminal") {
      const decision = normalizedAction.decision;
      if (decision.type === "elicitation-back") {
        const nextIndex = Math.max(0, Math.min(
          decision.questionIndex - 1,
          entry.payload.questions.length - 1
        ));
        entry.activeQuestionIndex = nextIndex;
        Promise.resolve(entry.sendReady)
          .then(() => this.updateElicitationQuestionCard(entry.messageId, entry.payload, requestId, nextIndex, entry.answers))
          .catch((err) => {
            this.log("warn", "update failed", { error: err && err.message ? err.message : String(err) });
          });
        return true;
      }

      if (decision.type !== "elicitation-step") return false;

      entry.answers = mergeElicitationAnswers(entry.answers, decision.answers);
      const final = decision.final === true;
      if (!final) {
        const nextIndex = Math.max(0, Math.min(
          decision.questionIndex >= 0 ? decision.questionIndex + 1 : entry.activeQuestionIndex + 1,
          entry.payload.questions.length - 1
        ));
        entry.activeQuestionIndex = nextIndex;
        Promise.resolve(entry.sendReady)
          .then(() => this.updateElicitationQuestionCard(entry.messageId, entry.payload, requestId, nextIndex, entry.answers))
          .catch((err) => {
            this.log("warn", "update failed", { error: err && err.message ? err.message : String(err) });
          });
        return true;
      }

      const answeredCount = countAnsweredQuestions(entry.payload.questions, entry.answers);
      if (answeredCount < entry.payload.questions.length) {
        const firstMissingIndex = entry.payload.questions.findIndex((question) => {
          const questionText = question && typeof question.question === "string" ? question.question : "";
          return !questionText || !entry.answers[questionText];
        });
        const nextIndex = firstMissingIndex >= 0 ? firstMissingIndex : entry.activeQuestionIndex;
        entry.activeQuestionIndex = nextIndex;
        Promise.resolve(entry.sendReady)
          .then(() => this.updateElicitationQuestionCard(entry.messageId, entry.payload, requestId, nextIndex, entry.answers))
          .catch((err) => {
            this.log("warn", "update failed", { error: err && err.message ? err.message : String(err) });
          });
        return true;
      }

      normalizedAction.decision = {
        type: "elicitation-submit",
        answers: entry.answers,
      };
    }

    // Final action: resolve first so the click order decides the outcome and a
    // slow/failed card patch can't delay or reorder the local decision. resolve()
    // also removes the entry from pending, making duplicate actions no-ops.
    entry.resolve(normalizedAction.decision);
    Promise.resolve(entry.sendReady)
      .then(() => {
        if (entry.kind === "elicitation") {
          const decision = normalizedAction.decision === "terminal" ? "terminal" : "elicitation-submit";
          return this.updateElicitationCard(entry.messageId, entry.payload, {
            decision,
            source: "feishu",
          });
        }
        return this.updateCard(entry.messageId, entry.payload, {
          decision: normalizedAction.decision,
          source: "feishu",
        });
      })
      .catch((err) => {
        this.log("warn", "update failed", { error: err && err.message ? err.message : String(err) });
      });
    return true;
  }
}

module.exports = {
  FeishuApprovalClient,
  buildApprovalCard,
  buildElicitationCard,
  buildStatusCard,
  buildElicitationStatusCard,
  normalizeApprovalPayload,
  normalizeElicitationPayload,
  normalizeActionEvent,
  normalizeElicitationActionEvent,
  createLarkClient,
  createWsClient,
};
