"use strict";

const crypto = require("crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { redactSecrets } = require("./secret-redact");
const { createTranslator } = require("./i18n");
const {
  buildSessionGrantRevokeAction,
  parseSessionGrantRevokeAction,
  createRemoteCardWorkRegistry,
} = require("./session-automation-remote");

const ACTION_ROW_SIZE = 3;
const MAX_ELICITATION_QUESTIONS = 5;
const MAX_ELICITATION_OPTIONS = 5;
const MAX_CARD_TEXT = 600;

const silentLarkLog = () => {};
const SILENT_LARK_LOGGER = Object.freeze({
  error: silentLarkLog,
  warn: silentLarkLog,
  info: silentLarkLog,
  debug: silentLarkLog,
  trace: silentLarkLog,
});

const SAFE_LARK_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_CANCELED",
]);
const SAFE_LARK_ERROR_STAGES = new Set([
  "lookup",
  "runtime-start",
  "runtime-stop",
  "send-card",
  "send-elicitation",
  "session-automation-card",
  "update-card",
  "ws-connect",
]);

// Agent-controlled strings (agentId, tool, folder, summary, question text,
// option/button labels, answers) are rendered into approval/elicitation cards.
// Guard them before they enter a card element:
//   safeLarkMd    — for lark_md elements: redact secrets, strip invisibles, then
//                   strip Markdown / structural chars so a value can't forge a
//                   status line, inject bold/links/mentions, or break layout.
//   safePlainText — for plain_text elements (headers, option/button labels):
//                   redact secrets + strip invisibles. plain_text does not parse
//                   Markdown, but newlines/bidi still render and secrets leak.
function stripInvisible(value) {
  // Line/paragraph separators (LF/CR/VT/FF/NEL/LS/PS) -> space, and bidi /
  // zero-width controls -> drop: an agent could use these to forge a standalone
  // status line or visually reorder the card text. Compared by code point so
  // the source stays ASCII (a literal U+2028/2029 would break JS parsing).
  let out = "";
  for (const ch of String(value == null ? "" : value)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a || cp === 0x0d || cp === 0x0b || cp === 0x0c || cp === 0x85 || cp === 0x2028 || cp === 0x2029) { out += " "; continue; }
    if (cp === 0x180e || cp === 0x061c || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff) { continue; }
    out += ch;
  }
  return out;
}

function sanitizeLarkMdStructure(value) {
  return stripInvisible(value).replace(/[*_~`[\]()<>#|]/g, "");
}
function safeLarkMd(value) {
  return sanitizeLarkMdStructure(redactSecrets(value));
}
function safePlainText(value) {
  return stripInvisible(redactSecrets(value == null ? "" : String(value)));
}

// ── Card render context ──
// Cards take an explicit { t, platform } context instead of reading global
// prefs, so every builder stays a pure function that tests can drive language
// by language. `t` is a live translator (a language switch needs no client
// rebuild); `platform` only selects which brand the source label shows.
const translateEn = createTranslator(() => "en");

function renderContext(ctx) {
  const source = ctx && typeof ctx === "object" ? ctx : {};
  return {
    t: typeof source.t === "function" ? source.t : translateEn,
    platform: normalizePlatform(source.platform),
  };
}

// The function form of the replacement argument is mandatory here:
// agent-controlled text (agent id, titles, answers) lands in these slots, and a
// string replacement would treat $&/$`/$'/$$ inside it as replacement patterns.
function fill(template, token, value) {
  return String(template == null ? "" : template).replace(token, () => value);
}

function labeledLine(ctx, label, value) {
  return fill(fill(ctx.t("feishuCardLine"), "{label}", label), "{value}", value);
}

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
    canOfferSessionTrust: payload && payload.canOfferSessionTrust === true,
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
    // `index` is the question's position in the ORIGINAL payload.questions
    // (i.e. toolInput.questions on the permission side) and is the key the
    // submitted answers map uses. Clamped question text can't serve as the
    // key: it no longer matches the original for long or whitespace-heavy
    // questions, and dropped invalid entries below would shift positions.
    .map((question, index) => {
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
        index,
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

function normalizeApprovalDecision(value) {
  if (isValidDecisionValue(value)) return value;
  if (
    value
    && typeof value === "object"
    && value.action === "session-trust"
    && value.cardHandle
    && typeof value.cardHandle === "object"
  ) {
    return { action: "session-trust", cardHandle: value.cardHandle };
  }
  return null;
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

function buildApprovalDetail(normalized, ctx) {
  if (normalized.agentId || normalized.toolName || normalized.folder || normalized.summary) {
    return [
      normalized.agentId ? labeledLine(ctx, ctx.t("feishuCardFieldAgent"), safeLarkMd(normalized.agentId)) : null,
      normalized.toolName ? labeledLine(ctx, ctx.t("feishuCardFieldTool"), safeLarkMd(normalized.toolName)) : null,
      normalized.folder ? labeledLine(ctx, ctx.t("feishuCardFieldFolder"), safeLarkMd(normalized.folder)) : null,
      normalized.summary ? labeledLine(ctx, ctx.t("feishuCardFieldSummary"), safeLarkMd(normalized.summary)) : null,
    ].filter(Boolean).join("\n");
  }
  return safeLarkMd(normalized.detail || normalized.title);
}

function buildElicitationDetail(normalized, ctx) {
  const lines = [];
  if (normalized.agentId) lines.push(labeledLine(ctx, ctx.t("feishuCardFieldAgent"), safeLarkMd(normalized.agentId)));
  if (normalized.folder) lines.push(labeledLine(ctx, ctx.t("feishuCardFieldFolder"), safeLarkMd(normalized.folder)));
  if (normalized.detail) lines.push(labeledLine(ctx, ctx.t("feishuCardFieldDetail"), safeLarkMd(normalized.detail)));
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

// The option value sent to Feishu is the option INDEX, not the raw label: the
// label can carry a secret the agent quoted, and the value rides the wire in the
// card JSON (and comes back on submit). buildQuestionAnswer maps the index back
// to the raw label locally, so the raw secret never leaves the desktop.
function selectOption(option, optionIndex) {
  return {
    text: { tag: "plain_text", content: safePlainText(option.label) },
    value: String(optionIndex),
  };
}

function questionTitle(question, index, ctx) {
  return question.header || fill(ctx.t("feishuCardQuestionTitle"), "{n}", String(index + 1));
}

function buildQuestionText(question, index, total = 1, ctx) {
  const title = questionTitle(question, index, ctx);
  const progress = total > 1 ? `**${index + 1} / ${total}**\n` : "";
  const optionText = question.options.length
    ? question.multiSelect
      ? `\n\n${ctx.t("feishuCardQuestionHintMulti")}`
      : `\n\n${ctx.t("feishuCardQuestionHintSingle")}`
    : `\n\n${ctx.t("feishuCardQuestionHintInput")}`;
  return `${progress}**${safeLarkMd(title)}**\n${safeLarkMd(question.question)}${optionText}`;
}

function buildAnsweredSummaries(questions, answers, activeQuestionIndex, ctx) {
  const lines = [];
  for (let i = 0; i < questions.length; i += 1) {
    if (i === activeQuestionIndex) continue;
    const question = questions[i];
    const questionText = question && question.question;
    const answerText = question && answers ? answers[question.index] : undefined;
    if (!questionText || !answerText) continue;
    lines.push(labeledLine(ctx, safeLarkMd(questionTitle(question, i, ctx)), safeLarkMd(answerText)));
  }
  return lines.join("\n");
}

function buildQuestionInput(question, questionIndex, answers = {}, ctx) {
  if (!question.options.length) return null;
  const selectedLabels = parseAnswerParts(answers[question.index]);
  const labelToIndex = new Map(question.options.map((option, oi) => [optionValue(option.label), String(oi)]));
  const component = {
    tag: question.multiSelect ? "multi_select_static" : "select_static",
    name: questionFormName(questionIndex),
    placeholder: {
      tag: "plain_text",
      content: ctx.t(question.multiSelect ? "feishuCardSelectPlaceholderMulti" : "feishuCardSelectPlaceholderSingle"),
    },
    options: question.options.map((option, oi) => selectOption(option, oi)),
  };
  // Re-select prior answers by mapping their raw labels back to option indices.
  const selectedIndices = selectedLabels
    .map((label) => labelToIndex.get(optionValue(label)))
    .filter((v) => v !== undefined);
  if (question.multiSelect && selectedIndices.length) {
    component.selected_values = selectedIndices;
  } else if (!question.multiSelect && selectedIndices.length) {
    component.initial_option = selectedIndices[0];
  }
  return component;
}

function buildOtherInput(question, questionIndex, answers = {}, ctx) {
  const selected = parseAnswerParts(answers[question.index]);
  const optionValues = new Set(question.options.map((option) => optionValue(option.label)));
  const otherText = selected.filter((value) => !optionValues.has(value)).join(", ");
  return {
    tag: "input",
    name: questionOtherFormName(questionIndex),
    placeholder: {
      tag: "plain_text",
      content: ctx.t(question.options.length ? "feishuCardOtherPlaceholder" : "feishuCardAnswerPlaceholder"),
    },
    default_value: safePlainText(otherText),
  };
}

function normalizeStatusOutcome(outcome, ctx) {
  const raw = outcome && typeof outcome === "object" ? outcome : { decision: outcome };
  const decision = String(raw.decision || raw.behavior || "").trim();
  const actionLabel = String(raw.actionLabel || raw.message || "").trim();
  const source = String(raw.source || "").trim();
  const isSuggestion = /^suggestion:\d+$/.test(decision);

  if (decision === "deny") {
    return {
      decision,
      template: "red",
      title: ctx.t("feishuCardStatusDeniedTitle"),
      result: actionLabel || ctx.t("feishuCardStatusDeniedResult"),
      source,
    };
  }
  if (decision === "terminal") {
    return {
      decision,
      template: "blue",
      title: ctx.t("feishuCardStatusTerminalTitle"),
      result: actionLabel || ctx.t("feishuCardStatusTerminalResult"),
      source,
    };
  }
  if (decision === "no-decision") {
    return {
      decision,
      template: "blue",
      title: ctx.t("feishuCardStatusCancelledTitle"),
      result: actionLabel || ctx.t("feishuCardStatusCancelledResult"),
      source,
    };
  }
  if (isSuggestion) {
    return {
      decision,
      template: "green",
      title: ctx.t("feishuCardStatusSuggestionTitle"),
      result: actionLabel || ctx.t("feishuCardStatusSuggestionResult"),
      source,
    };
  }
  return {
    decision: "allow",
    template: "green",
    title: ctx.t("feishuCardStatusApprovedTitle"),
    result: actionLabel || ctx.t("feishuCardStatusApprovedResult"),
    source,
  };
}

// `source === "feishu"` stays the internal routing value for both platforms —
// renaming it would churn the whole approval path. What the approver reads must
// still match the platform they are actually on, so the brand is resolved here
// and never by mapping the routing value straight to a fixed label.
function sourceLabel(source, ctx) {
  if (source === "desktop") return ctx.t("feishuCardSourceDesktop");
  if (source === "feishu") return ctx.t(ctx.platform === "lark" ? "feishuCardSourceLark" : "feishuCardSourceFeishu");
  if (source === "remote") return ctx.t("feishuCardSourceRemote");
  return "";
}

function buildApprovalCard(payload, options = {}, context = {}) {
  const ctx = renderContext(context);
  const normalized = normalizeApprovalPayload(payload);
  const requestId = String(options.requestId || "");
  const actions = [
    button(ctx.t("feishuCardButtonAllow"), { requestId, decision: "allow" }, "primary"),
    button(ctx.t("feishuCardButtonDeny"), { requestId, decision: "deny" }, "danger"),
  ];
  // DSH web has no originating terminal surface. Its no-decision path returns
  // to the browser answerer, so a remote "Go to terminal" action is misleading.
  if (normalized.agentId !== "deepseek-harness") {
    actions.push(button(ctx.t("feishuCardButtonTerminal"), { requestId, decision: "terminal" }, "default"));
  }
  actions.push(...normalized.suggestions.map((entry) => (
    button(safePlainText(entry.label), { requestId, decision: `suggestion:${entry.index}` }, "default")
  )));
  if (normalized.canOfferSessionTrust) {
    actions.push(button(
      ctx.t("feishuSessionTrustButton"),
      { requestId, kind: "session-trust-open" },
      "default"
    ));
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "orange",
      title: {
        tag: "plain_text",
        content: fill(ctx.t("feishuCardApprovalHeader"), "{name}", safePlainText(normalized.agentId || normalized.title)),
      },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: buildApprovalDetail(normalized, ctx) },
      },
      ...buildActionRows(actions),
    ],
  };
}

function buildSessionTrustConfirmCard(payload, options = {}, context = {}) {
  const ctx = renderContext(context);
  const normalized = normalizeApprovalPayload(payload);
  const requestId = String(options.requestId || "");
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "orange",
      title: {
        tag: "plain_text",
        content: ctx.t("feishuSessionTrustConfirmTitle"),
      },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: buildApprovalDetail(normalized, ctx) },
      },
      {
        tag: "div",
        text: { tag: "lark_md", content: ctx.t("feishuSessionTrustConfirmDetail") },
      },
      {
        tag: "action",
        actions: [
          button(
            ctx.t("feishuSessionTrustConfirmButton"),
            { requestId, kind: "session-trust-confirm" },
            "primary"
          ),
          button(
            ctx.t("feishuSessionTrustCancelButton"),
            { requestId, kind: "session-trust-cancel" },
            "default"
          ),
        ],
      },
    ],
  };
}

function buildSessionTrustStatusCard(payload, options = {}, context = {}) {
  const ctx = renderContext(context);
  const normalized = normalizeApprovalPayload(payload);
  const grantId = String(options.grantId || "");
  const statusKey = options.statusKey || "feishuSessionTrustPreparingStatus";
  const elements = [
    {
      tag: "div",
      text: { tag: "lark_md", content: buildApprovalDetail(normalized, ctx) },
    },
    {
      tag: "div",
      text: { tag: "lark_md", content: ctx.t(statusKey) },
    },
  ];
  if (grantId) {
    elements.push({
      tag: "action",
      actions: [button(
        ctx.t("feishuSessionTrustRevokeButton"),
        { action: buildSessionGrantRevokeAction(grantId) },
        "danger"
      )],
    });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: options.terminal ? "grey" : "green",
      title: {
        tag: "plain_text",
        content: ctx.t(options.terminal
          ? "feishuSessionTrustTerminalTitle"
          : "feishuSessionTrustActiveTitle"),
      },
    },
    elements,
  };
}

function buildElicitationCard(payload, options = {}, context = {}) {
  const ctx = renderContext(context);
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
  const detail = buildElicitationDetail(normalized, ctx);
  if (detail) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: detail },
    });
  }

  elements.push({
    tag: "div",
    text: { tag: "lark_md", content: buildQuestionText(question, questionIndex, normalized.questions.length, ctx) },
  });

  const answeredSummary = buildAnsweredSummaries(normalized.questions, answers, questionIndex, ctx);
  if (answeredSummary) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: answeredSummary },
    });
  }

  const formElements = [];
  const selectionInput = buildQuestionInput(question, questionIndex, answers, ctx);
  if (selectionInput) formElements.push(selectionInput);
  formElements.push(buildOtherInput(question, questionIndex, answers, ctx));
  const isLastQuestion = questionIndex >= normalized.questions.length - 1;
  formElements.push({
    ...button(ctx.t(isLastQuestion ? "feishuCardButtonSubmit" : "feishuCardButtonNext"), {
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
    navigation.push(button(ctx.t("feishuCardButtonBack"), { requestId, kind: "elicitation-back", questionIndex }, "default"));
  }
  navigation.push(button(ctx.t("feishuCardButtonTerminal"), { requestId, decision: "terminal" }, "default"));
  elements.push({ tag: "action", actions: navigation });

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "orange",
      title: {
        tag: "plain_text",
        content: fill(ctx.t("feishuCardElicitationHeader"), "{name}", safePlainText(normalized.agentId || normalized.title)),
      },
    },
    elements,
  };
}

function buildStatusCard(payload, outcome, context = {}) {
  const ctx = renderContext(context);
  const normalized = normalizeApprovalPayload(payload);
  const status = normalizeStatusOutcome(outcome, ctx);
  const source = sourceLabel(status.source, ctx);
  const detail = [
    buildApprovalDetail(normalized, ctx),
    "",
    labeledLine(ctx, ctx.t("feishuCardResultLabel"), safeLarkMd(status.result)),
    source ? labeledLine(ctx, ctx.t("feishuCardSourceLabel"), source) : null,
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

function buildElicitationStatusCard(payload, outcome, context = {}) {
  const ctx = renderContext(context);
  const normalized = normalizeElicitationPayload(payload);
  const raw = outcome && typeof outcome === "object" ? outcome : { decision: outcome };
  const source = sourceLabel(String(raw.source || "").trim(), ctx);
  const terminal = raw.decision === "terminal";
  const submitted = raw.decision === "elicitation-submit";
  const template = submitted ? "green" : "blue";
  const title = ctx.t(submitted
    ? "feishuCardStatusSubmittedTitle"
    : terminal ? "feishuCardStatusTerminalTitle" : "feishuCardStatusCancelledTitle");
  const result = ctx.t(submitted
    ? "feishuCardStatusSubmittedResult"
    : terminal ? "feishuCardStatusTerminalResult" : "feishuCardStatusInputCancelledResult");
  const detail = [
    buildElicitationDetail(normalized, ctx),
    "",
    labeledLine(ctx, ctx.t("feishuCardResultLabel"), result),
    source ? labeledLine(ctx, ctx.t("feishuCardSourceLabel"), source) : null,
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
  const options = Array.isArray(question.options) ? question.options : [];
  // Feishu returns the option INDICES we set in selectOption; map them back to
  // raw labels so the answer delivered to the agent is the real option text.
  const selected = normalizeFormArrayValue(formValue[questionFormName(questionIndex)])
    .map((idx) => {
      const i = Number(idx);
      return Number.isInteger(i) && i >= 0 && i < options.length ? optionValue(options[i].label) : "";
    })
    .filter(Boolean);
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
    const key = question && Number.isInteger(question.index) ? String(question.index) : "";
    return key && normalizedAnswers[key] ? count + 1 : count;
  }, 0);
}

function actionOperatorId(source, idType) {
  const operator = source.operator && typeof source.operator === "object" ? source.operator : {};
  const aliases = idType === "user_id"
    ? ["user_id", "userId"]
    : idType === "union_id"
      ? ["union_id", "unionId"]
      : ["open_id", "openId"];
  for (const key of aliases) {
    if (typeof operator[key] === "string" && operator[key]) return operator[key];
    if (typeof source[key] === "string" && source[key]) return source[key];
  }
  return "";
}

function normalizeSessionAutomationActionEvent(event, idType = "open_id") {
  const source = event && typeof event === "object" ? event : {};
  const action = source.action && typeof source.action === "object" ? source.action : {};
  const value = parseMaybeJsonObject(action.value);
  if (!value) return null;
  const operatorId = actionOperatorId(source, idType);
  const persistentGrantId = parseSessionGrantRevokeAction(value.action);
  if (persistentGrantId) {
    return { operatorId, kind: "persistent-revoke", grantId: persistentGrantId };
  }
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  const kind = typeof value.kind === "string" ? value.kind : "";
  if (
    requestId
    && (
      kind === "session-trust-open"
      || kind === "session-trust-confirm"
      || kind === "session-trust-cancel"
    )
  ) {
    return { operatorId, requestId, kind };
  }
  return null;
}

function normalizeActionEvent(event, idType = "open_id") {
  const source = event && typeof event === "object" ? event : {};
  const action = source.action && typeof source.action === "object" ? source.action : {};
  const value = parseMaybeJsonObject(action.value);
  if (!value) return null;
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  const decision = isValidDecisionValue(value.decision) ? String(value.decision) : "";
  if (!requestId || !decision) return null;
  const operatorId = actionOperatorId(source, idType);
  return { operatorId, requestId, decision };
}

function normalizeElicitationActionEvent(event, questions, idType = "open_id") {
  const source = event && typeof event === "object" ? event : {};
  const action = source.action && typeof source.action === "object" ? source.action : {};
  const value = parseMaybeJsonObject(action.value);
  if (!value) return null;
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  if (!requestId) return null;
  const operatorId = actionOperatorId(source, idType);

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
    answers[question.index] = answerText;
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

// Approval decisions are strings, but elicitation decisions are objects — and
// the logger stringifies whatever it is given, so an elicitation step used to
// log as a useless `decision=[object Object]`. That is the one line you have
// when debugging a stepper that misbehaves on a real tenant (#493 was diagnosed
// entirely from this log), so describe the shape instead.
//
// Deliberately omits `answers`: those are user/agent content and have no place
// in a diagnostic line.
function describeDecision(decision) {
  if (!decision) return "";
  if (typeof decision === "string") return decision;
  if (typeof decision !== "object") return String(decision);
  const type = typeof decision.type === "string" ? decision.type : "unknown";
  const parts = [type];
  if (Number.isInteger(decision.questionIndex)) parts.push(`q${decision.questionIndex}`);
  if (decision.final === true) parts.push("final");
  if (decision.answers && typeof decision.answers === "object") {
    parts.push(`answers=${Object.keys(decision.answers).length}`);
  }
  return parts.join(":");
}

function normalizeApiMessageId(response) {
  return response && response.data && typeof response.data.message_id === "string"
    ? response.data.message_id.trim()
    : "";
}

// The SDK resolves im.v1.message create/patch calls even when the business
// `code` is nonzero (only transport errors reject). Without this check a
// failed create was logged as "card sent" with an empty message id — the Test
// flow then sat out its full no-response window — and a failed status patch
// looked like a successful terminalization. Every message create/patch
// boundary funnels its response through here; the thrown error carries only
// the sanitized field set (never the raw response, msg text, or card body).
function assertMessageApiResponse(response, { stage, requireMessageId = false } = {}) {
  const safeStage = SAFE_LARK_ERROR_STAGES.has(stage) ? stage : "sdk";
  const businessCode = finiteErrorNumber(response ? response.code : undefined);
  if (businessCode !== undefined && businessCode !== 0) {
    throw createSanitizedSdkError({
      code: safeBusinessErrorCode(businessCode, safeStage),
      stage: safeStage,
      businessCode,
    });
  }
  if (requireMessageId && !normalizeApiMessageId(response)) {
    throw createSanitizedSdkError({ code: "sdk-request-failed", stage: safeStage });
  }
  return response;
}

// Single place that turns our platform enum into an SDK domain. Never build a
// URL by hand and never accept a user-supplied host: the App Secret rides these
// requests, so the destination must come from the official SDK enum only.
//
// CAUTION: `Domain.Feishu === 0`. It is a valid domain that is *falsy*, so this
// value must never be run through `||`, `!value`, or a truthiness assert —
// Feishu would silently look "missing". Compare with === undefined instead.
function resolveSdkDomain(lark, platform) {
  if (!lark || !lark.Domain) {
    // Tolerated for the fake SDKs used in tests, but only for Feishu: that is
    // the SDK's own default, so omitting the field lands on the same host.
    // Lark cannot be expressed without the enum, so it must fail loudly rather
    // than quietly connect to Feishu with Lark credentials.
    if (platform === "lark") throw new Error("Installed Lark SDK does not expose Domain.Lark");
    return undefined;
  }
  const domain = platform === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  if (platform === "lark" && domain === undefined) {
    throw new Error("Installed Lark SDK does not expose Domain.Lark");
  }
  return domain;
}

function finiteErrorNumber(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function safeBusinessErrorCode(businessCode, safeStage) {
  if (businessCode === 99991672) return "missing-contact-scope";
  if (businessCode === 1000040351) return "wrong-platform";
  return safeStage === "lookup" ? "lookup-failed" : "sdk-request-failed";
}

function classifyFeishuSdkError(error, stage) {
  const safeStage = SAFE_LARK_ERROR_STAGES.has(stage) ? stage : "sdk";
  const httpStatus = finiteErrorNumber(error && (
    (error.response && error.response.status)
    ?? error.httpStatus
    ?? error.status
  ));
  let businessCode = finiteErrorNumber(
    error && error.response && error.response.data
      ? error.response.data.code
      : undefined
  );
  if (businessCode === undefined) {
    businessCode = finiteErrorNumber(error && error.businessCode);
  }
  if (businessCode === undefined) {
    businessCode = finiteErrorNumber(error && error.statusCode);
  }
  if (businessCode === undefined && error && typeof error.message === "string") {
    const match = error.message.match(/(?:^|\b)code\s*[:=]\s*(-?\d+)\b/i);
    if (match) businessCode = finiteErrorNumber(match[1]);
  }
  const rawNetworkCode = error && typeof error.networkCode === "string" && error.networkCode
    ? error.networkCode
    : error && typeof error.code === "string" ? error.code : "";
  const networkCode = SAFE_LARK_NETWORK_CODES.has(rawNetworkCode)
    ? rawNetworkCode
    : undefined;
  return {
    code: safeBusinessErrorCode(businessCode, safeStage),
    stage: safeStage,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(businessCode === undefined ? {} : { businessCode }),
    ...(networkCode === undefined ? {} : { networkCode }),
  };
}

function createSanitizedSdkError(classification) {
  const error = new Error("Feishu/Lark SDK request failed.");
  error.code = classification.code;
  error.stage = classification.stage;
  if (classification.httpStatus !== undefined) error.httpStatus = classification.httpStatus;
  if (classification.businessCode !== undefined) error.businessCode = classification.businessCode;
  if (classification.networkCode !== undefined) error.networkCode = classification.networkCode;
  return error;
}

function createIsolatedLarkCache({ lark, platform, appId } = {}) {
  if (!lark || typeof lark.DefaultCache !== "function") {
    throw new Error("Installed Lark SDK does not expose DefaultCache");
  }
  const ownedCache = new lark.DefaultCache();
  const namespacePrefix = [
    "clawd",
    "feishu-approval",
    normalizePlatform(platform),
    String(appId || "").trim(),
  ].join(":");
  const namespaceOptions = (options) => {
    const source = options && typeof options === "object" ? options : {};
    const sdkNamespace = typeof source.namespace === "string" && source.namespace
      ? source.namespace
      : "";
    return {
      ...source,
      namespace: sdkNamespace ? `${namespacePrefix}:${sdkNamespace}` : namespacePrefix,
    };
  };
  return Object.freeze({
    get(key, options) {
      return ownedCache.get(key, namespaceOptions(options));
    },
    set(key, value, expire, options) {
      return ownedCache.set(key, value, expire, namespaceOptions(options));
    },
  });
}

function createDeadlineHttpInstance(base, timeoutMs) {
  if (!base || (typeof base !== "object" && typeof base !== "function")) return undefined;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : 10_000;
  const signalContext = new AsyncLocalStorage();
  const withTimeout = (options) => ({
    ...(options && typeof options === "object" ? options : {}),
    timeout: Math.min(
      Number.isFinite(options && options.timeout) && options.timeout > 0 ? options.timeout : timeout,
      timeout
    ),
    ...(signalContext.getStore() ? { signal: signalContext.getStore() } : {}),
  });
  const wrapper = {
    runWithSignal(signal, task) {
      return signalContext.run(signal, task);
    },
  };
  for (const method of ["get", "delete", "head", "options"]) {
    if (typeof base[method] !== "function") continue;
    wrapper[method] = (url, options) => base[method](url, withTimeout(options));
  }
  for (const method of ["post", "put", "patch"]) {
    if (typeof base[method] !== "function") continue;
    wrapper[method] = (url, data, options) => base[method](url, data, withTimeout(options));
  }
  if (typeof base.request === "function") {
    wrapper.request = (options) => base.request(withTimeout(options));
  }
  return wrapper;
}

function createLarkClient(config = {}) {
  const lark = config.lark || loadLarkSdk();
  const httpInstance = config.httpInstance || createDeadlineHttpInstance(
    lark.defaultHttpInstance,
    config.requestTimeoutMs
  );
  const cache = createIsolatedLarkCache({
    lark,
    platform: config.platform,
    appId: config.appId,
  });
  return new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType ? lark.AppType.SelfBuild : undefined,
    domain: resolveSdkDomain(lark, config.platform),
    loggerLevel: lark.LoggerLevel ? lark.LoggerLevel.warn : undefined,
    logger: SILENT_LARK_LOGGER,
    cache,
    httpInstance,
  });
}

async function lookupOpenIdByEmail(config = {}) {
  const log = typeof config.log === "function" ? config.log : () => {};
  try {
    const lark = config.lark || loadLarkSdk();
    const httpInstance = config.httpInstance || createDeadlineHttpInstance(
      lark.defaultHttpInstance,
      config.requestTimeoutMs
    );
    const client = createLarkClient({ ...config, lark, httpInstance });
    const request = () => client.contact.v3.user.batchGetId({
      data: { emails: [config.email] },
      params: { user_id_type: "open_id" },
    });
    const response = config.signal && httpInstance && typeof httpInstance.runWithSignal === "function"
      ? await httpInstance.runWithSignal(config.signal, request)
      : await request();
    const businessCode = Number(response && response.code);
    if (businessCode !== 0) {
      const classification = {
        code: businessCode === 99991672 ? "missing-contact-scope" : "lookup-failed",
        stage: "lookup",
        businessCode: Number.isFinite(businessCode) ? businessCode : 0,
      };
      log("warn", "email lookup failed", classification);
      return {
        status: "error",
        code: classification.code,
      };
    }
    const users = response && response.data && Array.isArray(response.data.user_list)
      ? response.data.user_list
      : [];
    const user = users.find((item) => item && typeof item.user_id === "string" && item.user_id.trim());
    if (!user) return { status: "error", code: "approver-not-found" };
    return { status: "ok", approverId: user.user_id.trim() };
  } catch (err) {
    const classification = classifyFeishuSdkError(err, "lookup");
    log("warn", "email lookup failed", classification);
    return {
      status: "error",
      code: classification.code,
    };
  }
}

function createWsClient(config = {}) {
  const lark = config.lark || loadLarkSdk();
  const dispatcher = new lark.EventDispatcher({
    verificationToken: config.verificationToken || "",
    encryptKey: config.encryptKey || "",
    loggerLevel: lark.LoggerLevel ? lark.LoggerLevel.warn : undefined,
    logger: SILENT_LARK_LOGGER,
    cache: createIsolatedLarkCache({
      lark,
      platform: config.platform,
      appId: config.appId,
    }),
  }).register({
    "card.action.trigger": async (event) => {
      if (typeof config.onCardAction === "function") await config.onCardAction(event);
      return undefined;
    },
  });
  // The WS long connection must land on the SAME platform as the REST client:
  // cards would send fine while button callbacks never arrive (#493).
  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: resolveSdkDomain(lark, config.platform),
    loggerLevel: lark.LoggerLevel ? lark.LoggerLevel.warn : undefined,
    logger: SILENT_LARK_LOGGER,
    httpInstance: config.httpInstance || lark.defaultHttpInstance,
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

// Defence in depth: prefs already normalize this, but the client is also
// constructed directly in tests and must never end up with a platform it does
// not understand. Anything unrecognised means Feishu — the pre-platform
// behaviour, so a corrupt value degrades to what existing users already had.
function normalizePlatform(value) {
  return value === "lark" ? "lark" : "feishu";
}

function normalizeConnectionTimeoutMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.max(1, Math.round(numeric * 1000));
  }
  return 15000;
}

const RECENT_TERMINAL_CARD_TTL_MS = 60_000;
const RECENT_TERMINAL_CARD_LIMIT = 64;
// Keep terminal replays below Lark's per-message update rate and, more
// importantly, let the stale action callback finish before restoring the
// terminal card. Otherwise the action transaction can win after our PATCH.
const TERMINAL_CARD_REPLAY_DELAY_MS = 250;

function isTerminalCardRequestId(value) {
  return /^(?:fs|fsq)_[a-f0-9]{24}$/.test(String(value || ""));
}

class FeishuApprovalClient {
  constructor(options = {}) {
    this.appId = options.appId || "";
    this.appSecret = options.appSecret || "";
    this.verificationToken = options.verificationToken || "";
    this.encryptKey = options.encryptKey || "";
    this.approverId = options.approverId || "";
    this.idType = options.idType || "open_id";
    this.platform = normalizePlatform(options.platform);
    // Dynamic language source (same contract as the Telegram runner): the
    // translator reads it per call, so switching Clawd's language re-renders
    // later cards without rebuilding the client or dropping the WS connection.
    this.t = createTranslator(typeof options.getLang === "function" ? options.getLang : () => "en");
    this.lark = options.lark || null;
    this.larkClient = options.larkClient || null;
    this.cardHttpInstance = options.cardHttpInstance || null;
    this.wsFactory = options.wsFactory || createWsClient;
    this.wsClient = options.wsClient || null;
    this.dispatcher = options.dispatcher || null;
    this.pending = new Map();
    this.terminalCardUpdates = new Set();
    this.recentTerminalCards = new Map();
    this.recentTerminalExpiryTimer = null;
    this.acceptingCardActions = true;
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.onStatusChange = typeof options.onStatusChange === "function" ? options.onStatusChange : () => {};
    this.connectionState = "idle";
    // Only stable, allowlisted application codes/messages are retained here.
    // Raw SDK diagnostics are never stored, logged, or returned.
    this.lastErrorMessage = "";
    this.lastErrorCode = "";
    this.connectionTimeoutMs = normalizeConnectionTimeoutMs(options.connectionTimeoutSeconds);
    this.cardRequestTimeoutMs = Number.isFinite(options.cardRequestTimeoutMs)
      && options.cardRequestTimeoutMs > 0
      ? Math.round(options.cardRequestTimeoutMs)
      : 10_000;
    this.terminalCardReplayDelayMs = Number.isFinite(options.terminalCardReplayDelayMs)
      && options.terminalCardReplayDelayMs >= 0
      ? Math.round(options.terminalCardReplayDelayMs)
      : TERMINAL_CARD_REPLAY_DELAY_MS;
    this.recentTerminalCardTtlMs = Number.isFinite(options.recentTerminalCardTtlMs)
      && options.recentTerminalCardTtlMs >= 0
      ? Math.round(options.recentTerminalCardTtlMs)
      : RECENT_TERMINAL_CARD_TTL_MS;
    this.onSessionGrantRevoke = typeof options.onSessionGrantRevoke === "function"
      ? options.onSessionGrantRevoke
      : null;
    this.issuedSessionTrustCardHandles = new WeakSet();
    this.sessionAutomationCardWork = options.sessionAutomationCardWork
      || createRemoteCardWorkRegistry({
        deadlineMs: this.cardRequestTimeoutMs,
        log: (err) => this.log(
          "warn",
          "session automation card update failed",
          classifyFeishuSdkError(err, "session-automation-card")
        ),
      });
    this.sessionAutomationRouteCurrent = true;
    this.connectionTimer = null;
    this.connectionTimerMode = "";
    this.lastStatusNotifyKey = "";
    // Bumped on every start()/close(); WS lifecycle callbacks from an older
    // wsClient generation must not mutate the state of the current one. The
    // SDK's initial-start path can fire onReady/onError after close() (no
    // generation re-check after its await), so we guard on our side.
    this.wsGeneration = 0;
  }

  trackTerminalCardUpdate(updatePromise) {
    const tracked = Promise.resolve(updatePromise);
    this.terminalCardUpdates.add(tracked);
    void tracked.then(
      () => this.terminalCardUpdates.delete(tracked),
      () => this.terminalCardUpdates.delete(tracked)
    );
    return tracked;
  }

  enqueueEntryCardUpdate(entry, update) {
    const previous = entry && entry.cardUpdateTail
      ? entry.cardUpdateTail
      : Promise.resolve();
    const work = Promise.resolve(previous)
      .then(() => Promise.resolve(entry && entry.sendReady))
      .then((sentEntry) => update(sentEntry));
    // A failed visual update must not block a later terminal update. Callers
    // still receive `work` and keep their existing stage-specific logging.
    if (entry) entry.cardUpdateTail = work.catch(() => {});
    return work;
  }

  pruneRecentTerminalCards(now = Date.now()) {
    for (const [requestId, record] of this.recentTerminalCards.entries()) {
      if (!record || record.expiresAt <= now) this.recentTerminalCards.delete(requestId);
    }
    while (this.recentTerminalCards.size > RECENT_TERMINAL_CARD_LIMIT) {
      const oldest = this.recentTerminalCards.keys().next();
      if (oldest.done) break;
      this.recentTerminalCards.delete(oldest.value);
    }
    this.scheduleRecentTerminalCardExpiry(now);
  }

  scheduleRecentTerminalCardExpiry(now = Date.now()) {
    if (this.recentTerminalExpiryTimer) clearTimeout(this.recentTerminalExpiryTimer);
    this.recentTerminalExpiryTimer = null;
    let nextExpiry = Infinity;
    for (const record of this.recentTerminalCards.values()) {
      if (record && record.expiresAt < nextExpiry) nextExpiry = record.expiresAt;
    }
    if (!Number.isFinite(nextExpiry)) return;
    this.recentTerminalExpiryTimer = setTimeout(() => {
      this.recentTerminalExpiryTimer = null;
      this.pruneRecentTerminalCards();
    }, Math.max(0, nextExpiry - now));
    if (typeof this.recentTerminalExpiryTimer.unref === "function") {
      this.recentTerminalExpiryTimer.unref();
    }
  }

  clearRecentTerminalCards() {
    if (this.recentTerminalExpiryTimer) clearTimeout(this.recentTerminalExpiryTimer);
    this.recentTerminalExpiryTimer = null;
    this.recentTerminalCards.clear();
  }

  rememberTerminalCard(requestId, entry, outcome) {
    if (!isTerminalCardRequestId(requestId) || !entry) return null;
    const card = entry.kind === "elicitation"
      ? buildElicitationStatusCard(entry.payload, outcome, this.cardContext())
      : buildStatusCard(entry.payload, outcome, this.cardContext());
    const record = {
      requestId,
      card,
      messageId: entry.messageId || "",
      messageReady: Promise.resolve(entry.sendReady).then((sentEntry) => {
        const messageId = (sentEntry && sentEntry.messageId) || entry.messageId || "";
        record.messageId = messageId;
        return messageId;
      }),
      expiresAt: Date.now() + this.recentTerminalCardTtlMs,
      priorUpdate: entry.cardUpdateTail || Promise.resolve(),
      initialUpdate: null,
      replayRequested: false,
      replayWork: null,
    };
    this.recentTerminalCards.delete(requestId);
    this.recentTerminalCards.set(requestId, record);
    this.pruneRecentTerminalCards();
    return record;
  }

  async patchTerminalCard(record) {
    const messageId = record.messageId || await record.messageReady;
    if (!messageId) throw new Error("card message id is unavailable");
    const message = this.messageApi();
    if (!message || typeof message.patch !== "function") {
      throw new Error("message.patch is unavailable");
    }
    assertMessageApiResponse(await message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(record.card) },
    }), { stage: "update-card" });
  }

  startTerminalCardUpdate(record, failureMessage, options = {}) {
    const update = Promise.resolve(record.priorUpdate)
      .then(() => this.patchTerminalCard(record))
      .catch((err) => {
        this.log(
          "warn",
          failureMessage,
          options.minimalFailure === true
            ? { stage: "update-card" }
            : classifyFeishuSdkError(err, "update-card")
        );
      });
    record.initialUpdate = update;
    this.trackTerminalCardUpdate(update);
    return update;
  }

  scheduleStaleTerminalCardReplay(requestId, event) {
    if (!this.acceptingCardActions || !isTerminalCardRequestId(requestId)) return false;
    this.pruneRecentTerminalCards();
    const record = this.recentTerminalCards.get(requestId);
    if (!record || actionOperatorId(event, this.idType) !== this.approverId) return false;
    record.replayRequested = true;
    record.expiresAt = Date.now() + this.recentTerminalCardTtlMs;
    this.recentTerminalCards.delete(requestId);
    this.recentTerminalCards.set(requestId, record);
    this.pruneRecentTerminalCards();
    if (record.replayWork) return true;

    const replayWork = (async () => {
      if (record.initialUpdate) await record.initialUpdate;
      while (record.replayRequested) {
        await new Promise((resolve) => setTimeout(resolve, this.terminalCardReplayDelayMs));
        // Stale callbacks received during the debounce are covered by this
        // replay. A callback received while PATCH is in flight requests one
        // additional serialized replay on the next loop iteration.
        record.replayRequested = false;
        try {
          await this.patchTerminalCard(record);
        } catch (err) {
          this.log("warn", "stale card refresh failed", classifyFeishuSdkError(err, "update-card"));
        }
      }
    })().finally(() => {
      record.replayWork = null;
    });
    record.replayWork = replayWork;
    this.trackTerminalCardUpdate(replayWork);
    this.log("debug", "stale card refresh scheduled", { requestId });
    return true;
  }

  isEnabled() {
    return !!(this.appId && this.appSecret && this.approverId);
  }

  cardContext() {
    return { t: this.t, platform: this.platform };
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
      // Named errorCode, not code: main's status already carries `reason` from
      // readiness(), and settings commands return their own `code`.
      errorCode: state === "failed" ? this.lastErrorCode : "",
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
      // This is our own failure, so it carries a code the settings page maps to
      // translated copy. The message stays English as the log/fallback
      // diagnostic, and must not name a single brand — one client, two
      // platforms.
      this.lastErrorCode = activeMode === "reconnecting" ? "reconnect-timeout" : "connection-timeout";
      this.lastErrorMessage = `Long ${label} timed out after ${this.connectionTimeoutMs}ms. Check app credentials, long connection event subscription, and network.`;
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
    if (this.wsClient) this.close({ preserveRecentTerminalCards: true });
    this.acceptingCardActions = true;
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
      platform: this.platform,
      handshakeTimeoutMs: this.connectionTimeoutMs,
      onCardAction: (event) => this.handleCardAction(event),
      onReady: ifCurrent(() => {
        this.clearConnectionTimer();
        this.connectionState = "connected";
        this.lastErrorMessage = "";
        this.lastErrorCode = "";
        this.log("info", "connected");
        this.notifyStatusChange();
      }),
      onError: ifCurrent((err) => {
        this.clearConnectionTimer();
        this.connectionState = "failed";
        const classification = classifyFeishuSdkError(err, "ws-connect");
        // Gateway code 1000040351 ("Incorrect domain name") is the platform
        // rejecting an app that lives on the other deployment — i.e. the
        // platform picker is set wrong. It is the single most likely
        // misconfiguration here, and the SDK only surfaces it as English
        // internals ("pullConnectConfig failed: code=…"), so give it a code the
        // settings page can turn into an actionable sentence. Verified against
        // a real Lark app pointed at open.feishu.cn (2026-07-15).
        //
        // Only the numeric code is retained. The arbitrary SDK message is
        // never returned or logged because it may contain request credentials.
        this.lastErrorCode = classification.code;
        this.lastErrorMessage = classification.code === "wrong-platform"
          ? "Incorrect domain name."
          : "Feishu/Lark long connection failed.";
        this.log("warn", "connection failed", classification);
        this.notifyStatusChange();
      }),
      onReconnecting: ifCurrent(() => {
        this.connectionState = "reconnecting";
        this.lastErrorMessage = "";
        this.lastErrorCode = "";
        this.startConnectionTimer("reconnecting");
        this.log("info", "reconnecting");
        this.notifyStatusChange();
      }),
      onReconnected: ifCurrent(() => {
        this.clearConnectionTimer();
        this.connectionState = "connected";
        this.lastErrorMessage = "";
        this.lastErrorCode = "";
        this.log("info", "reconnected");
        this.notifyStatusChange();
      }),
    });
    this.wsClient = created.wsClient;
    this.dispatcher = created.dispatcher;
    this.connectionState = "connecting";
    this.lastErrorMessage = "";
    this.lastErrorCode = "";
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

  close(options = {}) {
    this.acceptingCardActions = false;
    this.wsGeneration += 1;
    this.clearConnectionTimer();
    if (this.wsClient && typeof this.wsClient.close === "function") {
      try { this.wsClient.close(); } catch {}
    }
    this.wsClient = null;
    this.dispatcher = null;
    this.connectionState = "idle";
    this.lastErrorMessage = "";
    this.lastErrorCode = "";
    for (const entry of this.pending.values()) {
      // Resolve first so callers never wait on detached card work. Every
      // pending entry exposes the same terminalizer: Settings test entries
      // carry abortOutcome and patch, while ordinary approvals safely no-op.
      entry.resolve(null);
      if (typeof entry.terminalizeAbortOutcome === "function") {
        entry.terminalizeAbortOutcome();
      }
    }
    this.pending.clear();
    if (options.preserveRecentTerminalCards !== true) this.clearRecentTerminalCards();
    this.notifyStatusChange();
    return Promise.allSettled(Array.from(this.terminalCardUpdates));
  }

  messageApi() {
    if (!this.larkClient) {
      const lark = this.lark || loadLarkSdk();
      this.cardHttpInstance = this.cardHttpInstance || createDeadlineHttpInstance(
        lark.defaultHttpInstance,
        this.cardRequestTimeoutMs
      );
      this.larkClient = createLarkClient({
        appId: this.appId,
        appSecret: this.appSecret,
        lark,
        platform: this.platform,
        requestTimeoutMs: this.cardRequestTimeoutMs,
        httpInstance: this.cardHttpInstance,
      });
    }
    const client = this.larkClient;
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
    const onDelivered = typeof options.onDelivered === "function" ? options.onDelivered : null;
    if (signal && signal.aborted) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
      let settled = false;
      // Send failures resolve to null by default so approval callers fall
      // back to the local bubble; opting into rejectOnSendError lets the
      // settings test path tell "card never sent" apart from "nobody
      // pressed a button" (#493 misdiagnosis).
      const finish = (decision, sendError) => {
        if (settled) return;
        settled = true;
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        this.pending.delete(requestId);
        if (sendError && options.rejectOnSendError) reject(sendError);
        else resolve(normalizeApprovalDecision(decision));
      };
      const entry = {
        payload: normalized,
        messageId: "",
        signal: signal || null,
        resolve: finish,
        sendReady: null,
        cardUpdateTail: Promise.resolve(),
        trustConfirming: false,
        abortOutcomePromise: null,
      };
      // Entry-owned so close() can share the same one-shot path without seeing
      // requestApproval()'s local options closure. Abort and close may overlap.
      const terminalizeAbortOutcome = () => {
        if (!options.abortOutcome) return null;
        if (entry.abortOutcomePromise) return entry.abortOutcomePromise;
        const record = this.rememberTerminalCard(requestId, entry, options.abortOutcome);
        entry.abortOutcomePromise = record
          ? this.startTerminalCardUpdate(record, "abort card update failed", { minimalFailure: true })
          : Promise.resolve(null);
        return entry.abortOutcomePromise;
      };
      entry.terminalizeAbortOutcome = terminalizeAbortOutcome;
      const onAbort = () => {
        // Preserve the approval contract: abort clears pending state and
        // resolves immediately. The settings test may additionally expire its
        // already-sent card, but that work is deliberately detached.
        finish(null);
        terminalizeAbortOutcome();
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, entry);
      entry.sendReady = this.sendCard(requestId, normalized)
        .then((messageId) => {
          entry.messageId = messageId || "";
          const current = this.pending.get(requestId);
          if (current) {
            current.messageId = messageId || "";
            if (messageId && !(signal && signal.aborted) && onDelivered) {
              try { onDelivered({ messageId }); } catch (err) {
                try {
                  this.log("warn", "delivery callback failed", {
                    error: err && err.message ? err.message : String(err),
                  });
                } catch {}
              }
            }
          }
          return current || entry;
        })
        .catch((err) => {
          const classification = classifyFeishuSdkError(err, "send-card");
          this.log("warn", "send failed", classification);
          finish(null, createSanitizedSdkError(classification));
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
    const onDelivered = typeof options.onDelivered === "function" ? options.onDelivered : null;
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
        cardUpdateTail: Promise.resolve(),
        kind: "elicitation",
        answers: {},
        activeQuestionIndex: 0,
      };
      this.pending.set(requestId, entry);
      entry.sendReady = this.sendElicitationCard(requestId, normalized, { questionIndex: 0 })
        .then((messageId) => {
          entry.messageId = messageId || "";
          const current = this.pending.get(requestId);
          if (current) {
            current.messageId = messageId || "";
            if (messageId && !(signal && signal.aborted) && onDelivered) {
              try { onDelivered({ messageId }); } catch (err) {
                try {
                  this.log("warn", "elicitation delivery callback failed", {
                    error: err && err.message ? err.message : String(err),
                  });
                } catch {}
              }
            }
          }
          return current || entry;
        })
        .catch((err) => {
          this.log(
            "warn",
            "send elicitation failed",
            classifyFeishuSdkError(err, "send-elicitation")
          );
          finish(null);
          return entry;
        });
    });
  }

  async sendCard(requestId, payload) {
    const message = this.messageApi();
    if (!message || typeof message.create !== "function") throw new Error("message.create is unavailable");
    const response = await message.create({
      params: { receive_id_type: this.idType || "open_id" },
      data: {
        receive_id: this.approverId,
        msg_type: "interactive",
        content: JSON.stringify(buildApprovalCard(payload, { requestId }, this.cardContext())),
      },
    });
    assertMessageApiResponse(response, { stage: "send-card", requireMessageId: true });
    const messageId = normalizeApiMessageId(response);
    this.log("debug", "card sent", { requestId, messageId });
    return messageId;
  }

  async sendElicitationCard(requestId, payload, options = {}) {
    const message = this.messageApi();
    if (!message || typeof message.create !== "function") throw new Error("message.create is unavailable");
    const response = await message.create({
      params: { receive_id_type: this.idType || "open_id" },
      data: {
        receive_id: this.approverId,
        msg_type: "interactive",
        content: JSON.stringify(buildElicitationCard(
          payload,
          { requestId, questionIndex: options.questionIndex || 0 },
          this.cardContext()
        )),
      },
    });
    assertMessageApiResponse(response, { stage: "send-elicitation", requireMessageId: true });
    const messageId = normalizeApiMessageId(response);
    this.log("debug", "elicitation card sent", { requestId, messageId });
    return messageId;
  }

  async updateCard(messageId, payload, outcome) {
    if (!messageId) return;
    const message = this.messageApi();
    if (!message || typeof message.patch !== "function") return;
    assertMessageApiResponse(await message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(buildStatusCard(payload, outcome, this.cardContext())) },
    }), { stage: "update-card" });
  }

  async patchCard(messageId, card, options = {}) {
    if (!messageId) throw new Error("card message id is unavailable");
    const message = this.messageApi();
    if (!message || typeof message.patch !== "function") {
      throw new Error("message.patch is unavailable");
    }
    const patch = () => message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }).then((response) => assertMessageApiResponse(response, { stage: "session-automation-card" }));
    if (
      options.signal
      && this.cardHttpInstance
      && typeof this.cardHttpInstance.runWithSignal === "function"
    ) {
      await this.cardHttpInstance.runWithSignal(options.signal, patch);
      return;
    }
    await patch();
  }

  supportsSessionAutomation() {
    const message = this.messageApi();
    return this.sessionAutomationRouteCurrent
      && this.isEnabled()
      && typeof this.onSessionGrantRevoke === "function"
      && !!(message && typeof message.patch === "function");
  }

  beginSessionTrustCandidate({ grantId, cardHandle } = {}) {
    if (!this.issuedSessionTrustCardHandles.has(cardHandle)) return null;
    this.issuedSessionTrustCardHandles.delete(cardHandle);
    const cardWork = cardHandle.cardWork;
    if (
      !this.supportsSessionAutomation()
      || !this.sessionAutomationCardWork.bindCandidateGrant(cardWork, grantId)
    ) {
      // Confirmation already consumed the one-shot handle. Remove the stale
      // controls best-effort, while the registry deadline guarantees that a
      // dead route cannot retain this card-work slot indefinitely.
      this.sessionAutomationCardWork.enqueue(cardWork, (cardRef, { signal }) => (
        this.renderSessionTrustTerminal(
          cardRef,
          "feishuSessionTrustFailedStatus",
          { signal }
        )
      ), { terminal: true, outcome: "terminal" });
      return null;
    }
    return cardWork;
  }

  discardSessionTrustCardHandle(cardHandle, { reason } = {}) {
    if (!this.issuedSessionTrustCardHandles.has(cardHandle)) return false;
    this.issuedSessionTrustCardHandles.delete(cardHandle);
    const cardWork = cardHandle && cardHandle.cardWork;
    const statusKey = reason === "remote-revoke"
      ? "feishuSessionTrustRevokedStatus"
      : "feishuSessionTrustResolvedStatus";
    this.sessionAutomationCardWork.enqueue(cardWork, (cardRef, { signal }) => (
      this.renderSessionTrustTerminal(cardRef, statusKey, { signal })
    ), { terminal: true, outcome: "terminal" });
    return true;
  }

  prepareSessionTrustCandidate(cardWork, { grantId } = {}) {
    return this.sessionAutomationCardWork.enqueue(cardWork, (cardRef, { signal }) => (
      this.patchCard(cardRef.messageId, buildSessionTrustStatusCard(
        cardRef.payload,
        { grantId, statusKey: "feishuSessionTrustPreparingStatus" },
        this.cardContext()
      ), { signal })
    ), { outcome: "preparing" });
  }

  activateSessionTrustCandidate(cardWork, { grantId } = {}) {
    return this.sessionAutomationCardWork.activate(cardWork, grantId);
  }

  renderActiveSessionTrust(cardWork, { grantId, outcome } = {}) {
    return this.sessionAutomationCardWork.enqueue(cardWork, (cardRef, { signal }) => (
      this.patchCard(cardRef.messageId, buildSessionTrustStatusCard(
        cardRef.payload,
        {
          grantId,
          statusKey: outcome === "already-active"
            ? "feishuSessionTrustAlreadyActiveStatus"
            : "feishuSessionTrustActiveStatus",
        },
        this.cardContext()
      ), { signal })
    ), { outcome: "active" });
  }

  renderSessionTrustTerminal(cardRef, statusKey, options = {}) {
    return this.patchCard(cardRef.messageId, buildSessionTrustStatusCard(
      cardRef.payload,
      { statusKey, terminal: true },
      this.cardContext()
    ), options);
  }

  cancelSessionTrustCandidate(cardWork, { reason, activeGrantId } = {}) {
    if (activeGrantId && this.sessionAutomationCardWork.activate(cardWork, activeGrantId)) {
      this.renderActiveSessionTrust(cardWork, {
        grantId: activeGrantId,
        outcome: "already-active",
      });
      return true;
    }
    const statusKey = reason === "remote-revoke"
      ? "feishuSessionTrustRevokedStatus"
      : reason === "permission-resolved"
        ? "feishuSessionTrustResolvedStatus"
        : "feishuSessionTrustFailedStatus";
    this.sessionAutomationCardWork.enqueue(cardWork, (cardRef, { signal }) => (
      this.renderSessionTrustTerminal(cardRef, statusKey, { signal })
    ), { terminal: true, outcome: "terminal" });
    return true;
  }

  handleSessionAutomationChanges(changes) {
    for (const change of Array.isArray(changes) ? changes : []) {
      const previous = change && change.previous;
      const next = change && change.next;
      if (!previous || !previous.grantId || (next && next.grantId === previous.grantId)) continue;
      const statusKey = change.reason === "remote-revoke"
        ? "feishuSessionTrustRevokedStatus"
        : "feishuSessionTrustExpiredStatus";
      this.sessionAutomationCardWork.deactivateGrant(previous.grantId, (cardRef, _id, { signal }) => (
        this.renderSessionTrustTerminal(cardRef, statusKey, { signal })
      ));
    }
  }

  listActiveSessionAutomationGrantIds() {
    return this.sessionAutomationCardWork.activeGrantIds();
  }

  retireSessionAutomationGrant(grantId, options = {}) {
    const statusKey = options.reason === "stale"
      ? "feishuSessionTrustStaleStatus"
      : "feishuSessionTrustExpiredStatus";
    return this.sessionAutomationCardWork.deactivateGrant(grantId, (cardRef, _id, { signal }) => (
      this.renderSessionTrustTerminal(cardRef, statusKey, { signal })
    ));
  }

  markSessionAutomationRouteStale() {
    this.sessionAutomationRouteCurrent = false;
  }

  markSessionAutomationRouteCurrent() {
    this.sessionAutomationRouteCurrent = true;
  }

  handleSessionAutomationAction(action) {
    if (!action) return false;
    if (
      !this.sessionAutomationRouteCurrent
      || !action.operatorId
      || action.operatorId !== this.approverId
    ) {
      return false;
    }
    if (action.kind === "persistent-revoke") {
      if (
        !this.sessionAutomationCardWork.hasCard(action.grantId)
        || typeof this.onSessionGrantRevoke !== "function"
      ) {
        return false;
      }
      let result;
      try {
        result = this.onSessionGrantRevoke(action.grantId);
      } catch {
        result = { status: "invalid" };
      }
      if (result && typeof result.then === "function") result = { status: "invalid" };
      if (!result || (result.status !== "applied" && result.status !== "candidate-cancelled")) {
        this.retireSessionAutomationGrant(action.grantId, { reason: "stale" });
      }
      return true;
    }

    const entry = action.requestId ? this.pending.get(action.requestId) : null;
    if (!entry || entry.kind === "elicitation" || entry.payload.canOfferSessionTrust !== true) {
      return false;
    }
    if (action.kind === "session-trust-open") {
      entry.trustConfirming = true;
      this.enqueueEntryCardUpdate(entry, () => this.patchCard(
        entry.messageId,
        buildSessionTrustConfirmCard(
          entry.payload,
          { requestId: action.requestId },
          this.cardContext()
        )
      ))
        .catch((err) => {
          entry.trustConfirming = false;
          this.log(
            "warn",
            "session trust confirmation patch failed",
            classifyFeishuSdkError(err, "session-automation-card")
          );
        });
      return true;
    }
    if (action.kind === "session-trust-cancel") {
      entry.trustConfirming = false;
      this.enqueueEntryCardUpdate(entry, () => this.patchCard(
        entry.messageId,
        buildApprovalCard(
          entry.payload,
          { requestId: action.requestId },
          this.cardContext()
        )
      ))
        .catch((err) => {
          this.log(
            "warn",
            "session trust cancellation patch failed",
            classifyFeishuSdkError(err, "session-automation-card")
          );
        });
      return true;
    }
    if (
      action.kind !== "session-trust-confirm"
      || entry.trustConfirming !== true
      || !entry.messageId
    ) {
      return false;
    }
    const cardWork = this.sessionAutomationCardWork.reserve(`pending:${action.requestId}`, {
      messageId: entry.messageId,
      payload: entry.payload,
    });
    if (!cardWork) {
      entry.trustConfirming = false;
      this.enqueueEntryCardUpdate(entry, () => this.patchCard(
        entry.messageId,
        buildApprovalCard(
          entry.payload,
          { requestId: action.requestId },
          this.cardContext()
        )
      ))
        .catch((err) => {
          this.log(
            "warn",
            "session trust capacity fallback patch failed",
            classifyFeishuSdkError(err, "session-automation-card")
          );
        });
      return true;
    }
    const cardHandle = Object.freeze({
      messageId: entry.messageId,
      payload: entry.payload,
      cardWork,
    });
    this.issuedSessionTrustCardHandles.add(cardHandle);
    entry.resolve({ action: "session-trust", cardHandle });
    return true;
  }

  async updateElicitationCard(messageId, payload, outcome) {
    if (!messageId) return;
    const message = this.messageApi();
    if (!message || typeof message.patch !== "function") return;
    assertMessageApiResponse(await message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(buildElicitationStatusCard(payload, outcome, this.cardContext())) },
    }), { stage: "update-card" });
  }

  async updateElicitationQuestionCard(messageId, payload, requestId, questionIndex, answers = {}) {
    if (!messageId) return;
    const message = this.messageApi();
    if (!message || typeof message.patch !== "function") return;
    assertMessageApiResponse(await message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(buildElicitationCard(payload, {
          requestId,
          questionIndex,
          answers,
        }, this.cardContext())),
      },
    }), { stage: "update-card" });
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
    const { requestId, entry } = found;
    const nextOutcome = {
      ...outcome,
      source: outcome.source || "desktop",
    };
    const record = this.rememberTerminalCard(requestId, entry, nextOutcome);
    // Resolve before the best-effort patch so a slow Feishu response cannot
    // reopen the decision race after the desktop has already answered.
    entry.resolve(null);
    if (record) this.startTerminalCardUpdate(record, "external update failed");
    return true;
  }

  handleCardAction(event) {
    const sessionAutomationAction = normalizeSessionAutomationActionEvent(event, this.idType);
    if (sessionAutomationAction) {
      const handled = this.handleSessionAutomationAction(sessionAutomationAction);
      if (!handled) this.scheduleStaleTerminalCardReplay(sessionAutomationAction.requestId, event);
      return handled;
    }
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
      decision: describeDecision(normalizedAction && normalizedAction.decision),
      matched: !!(normalizedAction && normalizedAction.operatorId === this.approverId && entry),
    });
    if (!entry) {
      this.scheduleStaleTerminalCardReplay(requestId, event);
      return false;
    }
    if (!normalizedAction || normalizedAction.operatorId !== this.approverId) return false;
    if (entry.trustConfirming === true) return false;

    if (entry.kind === "elicitation" && normalizedAction.decision !== "terminal") {
      const decision = normalizedAction.decision;
      if (decision.type === "elicitation-back") {
        const nextIndex = Math.max(0, Math.min(
          decision.questionIndex - 1,
          entry.payload.questions.length - 1
        ));
        entry.activeQuestionIndex = nextIndex;
        this.enqueueEntryCardUpdate(entry, () => (
          this.updateElicitationQuestionCard(entry.messageId, entry.payload, requestId, nextIndex, entry.answers)
        ))
          .catch((err) => {
            this.log("warn", "update failed", classifyFeishuSdkError(err, "update-card"));
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
        this.enqueueEntryCardUpdate(entry, () => (
          this.updateElicitationQuestionCard(entry.messageId, entry.payload, requestId, nextIndex, entry.answers)
        ))
          .catch((err) => {
            this.log("warn", "update failed", classifyFeishuSdkError(err, "update-card"));
          });
        return true;
      }

      const answeredCount = countAnsweredQuestions(entry.payload.questions, entry.answers);
      if (answeredCount < entry.payload.questions.length) {
        const firstMissingIndex = entry.payload.questions.findIndex((question) => {
          const key = question && Number.isInteger(question.index) ? String(question.index) : "";
          return !key || !entry.answers[key];
        });
        const nextIndex = firstMissingIndex >= 0 ? firstMissingIndex : entry.activeQuestionIndex;
        entry.activeQuestionIndex = nextIndex;
        this.enqueueEntryCardUpdate(entry, () => (
          this.updateElicitationQuestionCard(entry.messageId, entry.payload, requestId, nextIndex, entry.answers)
        ))
          .catch((err) => {
            this.log("warn", "update failed", classifyFeishuSdkError(err, "update-card"));
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
    const terminalOutcome = entry.kind === "elicitation"
      ? {
          decision: normalizedAction.decision === "terminal" ? "terminal" : "elicitation-submit",
          source: "feishu",
        }
      : {
          decision: normalizedAction.decision,
          source: "feishu",
        };
    const record = this.rememberTerminalCard(requestId, entry, terminalOutcome);
    entry.resolve(normalizedAction.decision);
    if (record) this.startTerminalCardUpdate(record, "update failed");
    return true;
  }
}

module.exports = {
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
  classifyFeishuSdkError,
  createIsolatedLarkCache,
  createLarkClient,
  createDeadlineHttpInstance,
  createWsClient,
  lookupOpenIdByEmail,
};
