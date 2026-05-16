"use strict";

// ── Telegram message builders for rich approval interactions ──
//
// Pure functions that produce Telegram Bot API message payloads with
// inline keyboards. No side effects, no network, no state.

const MAX_CALLBACK_DATA = 64; // Telegram's limit for callback_data
const MAX_BUTTON_TEXT = 40;   // Practical limit for readable buttons
const MAX_MESSAGE_TEXT = 4096; // Telegram message text limit

// ── Markdown V2 escaping ──

const MD2_ESCAPE_RE = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

function escapeMarkdownV2(text) {
  return String(text || "").replace(MD2_ESCAPE_RE, "\\$1");
}

// ── Callback data helpers ──

function callbackData(requestId, action) {
  const data = `${requestId}:${action}`;
  if (data.length > MAX_CALLBACK_DATA) {
    return data.slice(0, MAX_CALLBACK_DATA);
  }
  return data;
}

function truncate(text, maxLen) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

// ── Permission messages ──

function buildPermissionMessage(payload, requestId) {
  const title = truncate(payload && payload.title, 200) || "Permission request";
  const detail = truncate(payload && payload.detail, 800);

  const lines = [`*${escapeMarkdownV2(title)}*`];
  if (detail) {
    lines.push("");
    lines.push(escapeMarkdownV2(detail));
  }

  return {
    text: lines.join("\n"),
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "\u2705 Allow", callback_data: callbackData(requestId, "allow") },
          { text: "\u274C Deny", callback_data: callbackData(requestId, "deny") },
        ],
      ],
    },
  };
}

function buildSuggestionsMessage(payload, suggestions, requestId) {
  const base = buildPermissionMessage(payload, requestId);
  if (!Array.isArray(suggestions) || suggestions.length === 0) return base;

  const keyboard = [...base.reply_markup.inline_keyboard];

  for (let i = 0; i < Math.min(suggestions.length, 5); i++) {
    const sug = suggestions[i];
    let label = "";
    if (sug.type === "addRules" && Array.isArray(sug.rules) && sug.rules[0]) {
      const rule = sug.rules[0];
      label = `Always: ${truncate(rule.toolName, 12)} ${truncate(rule.ruleContent, 18)}`;
    } else if (sug.type === "setMode") {
      label = `Mode: ${truncate(sug.mode, 20)}`;
    } else {
      label = truncate(JSON.stringify(sug), MAX_BUTTON_TEXT);
    }
    keyboard.push([
      { text: truncate(label, MAX_BUTTON_TEXT), callback_data: callbackData(requestId, `sug:${i}`) },
    ]);
  }

  return {
    ...base,
    reply_markup: { inline_keyboard: keyboard },
  };
}

// ── Elicitation messages ──

function buildElicitationMessage(question, questionIndex, totalQuestions, requestId, toggleState) {
  if (!question || typeof question !== "object") {
    return { text: "Invalid question", reply_markup: { inline_keyboard: [] } };
  }

  const header = question.header ? `[${escapeMarkdownV2(truncate(question.header, 30))}] ` : "";
  const qNum = totalQuestions > 1 ? ` \\(${questionIndex + 1}/${totalQuestions}\\)` : "";
  const qText = escapeMarkdownV2(truncate(question.question, 500));

  const lines = [`\u2753 ${header}${qText}${qNum}`];

  const options = Array.isArray(question.options) ? question.options : [];
  const isMulti = question.multiSelect === true;

  if (!isMulti && options.length > 0) {
    // Single-select: show option descriptions
    lines.push("");
    for (const opt of options.slice(0, 8)) {
      const label = truncate(opt.label || opt, 60);
      const desc = opt.description ? ` \\- ${escapeMarkdownV2(truncate(opt.description, 80))}` : "";
      lines.push(`\u2022 ${escapeMarkdownV2(label)}${desc}`);
    }
  }

  const keyboard = [];

  if (isMulti) {
    // Multi-select: toggle buttons with checkbox indicators
    const state = toggleState || {};
    for (let i = 0; i < Math.min(options.length, 8); i++) {
      const opt = options[i];
      const label = truncate(opt.label || String(opt), 35);
      const checked = !!state[i];
      const prefix = checked ? "\u2611" : "\u2610";
      keyboard.push([
        { text: `${prefix} ${label}`, callback_data: callbackData(requestId, `tog:${i}`) },
      ]);
    }
    keyboard.push([
      { text: "\u2705 Submit", callback_data: callbackData(requestId, "submit") },
    ]);
  } else {
    // Single-select: one button per option
    for (let i = 0; i < Math.min(options.length, 8); i++) {
      const opt = options[i];
      const label = truncate(opt.label || String(opt), MAX_BUTTON_TEXT);
      keyboard.push([
        { text: label, callback_data: callbackData(requestId, `opt:${i}`) },
      ]);
    }
    // "Other..." button for text input
    keyboard.push([
      { text: "\u270F\uFE0F Other...", callback_data: callbackData(requestId, "other") },
    ]);
  }

  return {
    text: lines.join("\n"),
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: keyboard },
  };
}

function buildTextInputPrompt(requestId) {
  return {
    text: "\uD83D\uDCAC Type your answer as a *reply* to this message:",
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [{ text: "\u274C Cancel", callback_data: callbackData(requestId, "cancel") }],
      ],
      force_reply: true,
      selective: true,
    },
  };
}

// ── Completion messages ──

function buildCompletedMessage(originalText, outcome) {
  const plain = String(originalText || "").replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1");
  const suffix = outcome === "allow" ? "\n\n\u2705 Allowed"
    : outcome === "deny" ? "\n\n\u274C Denied"
    : outcome === "timeout" ? "\n\n\u23F1 Timed out"
    : outcome === "cancelled" ? "\n\n\uD83D\uDDB1\uFE0F Resolved locally"
    : `\n\n\u2714 ${outcome}`;
  return escapeMarkdownV2(plain + suffix);
}

function emptyKeyboard() {
  return { inline_keyboard: [] };
}

// ── Exports ──

module.exports = {
  escapeMarkdownV2,
  callbackData,
  truncate,
  buildPermissionMessage,
  buildSuggestionsMessage,
  buildElicitationMessage,
  buildTextInputPrompt,
  buildCompletedMessage,
  emptyKeyboard,
  MAX_CALLBACK_DATA,
  MAX_MESSAGE_TEXT,
};
