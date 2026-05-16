"use strict";

// ── Native Telegram Bot API client for rich approval interactions ──
//
// Replaces the Go sidecar for Telegram communication. Uses Node.js built-in
// https module to call Telegram Bot API directly. Supports inline keyboards,
// callback queries, and text reply capture for elicitation.

const https = require("https");
const fs = require("fs");
const crypto = require("crypto");
const messages = require("./telegram-native-bot-messages");

const TELEGRAM_API_HOST = "api.telegram.org";
const POLL_TIMEOUT_S = 30;
const GRACE_STOP_MS = 5000;
const DEFAULT_TTL_MS = 90000;

function generateRequestId() {
  return crypto.randomBytes(4).toString("hex");
}

function noop() {}

class TelegramNativeBotClient {
  constructor(options = {}) {
    this.tokenFilePath = options.tokenFilePath || "";
    this.allowedUserId = String(options.allowedUserId || "").trim();
    this.chatId = String(options.chatId || "").trim();
    this.ttlMs = Number.isFinite(options.ttlMs) ? Math.max(5000, options.ttlMs) : DEFAULT_TTL_MS;
    this.log = typeof options.log === "function" ? options.log : noop;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;

    this._tokenCache = null;
    this._tokenMtimeMs = 0;
    this._pollingActive = false;
    this._pollAbort = null;
    this._updateOffset = 0;
    this._pendingRequests = new Map();
    this._graceTimer = null;
    this._botVerified = false;
  }

  isEnabled() {
    return !!(this.tokenFilePath && this.allowedUserId && this.chatId);
  }

  // ── Public: basic allow/deny (drop-in for sidecar client) ──

  requestApproval(payload, options = {}) {
    return this._doRequest("permission", payload, null, options);
  }

  // ── Public: permission with suggestions ──

  requestWithSuggestions(payload, suggestions, options = {}) {
    return this._doRequest("suggestions", payload, { suggestions }, options);
  }

  // ── Public: elicitation (questions with options/checkboxes/text) ──

  requestElicitation(payload, questions, options = {}) {
    return this._doRequest("elicitation", payload, { questions }, options);
  }

  // ── Public: cleanup ──

  cleanup() {
    this._stopPolling();
    for (const [, req] of this._pendingRequests) {
      this._expireRequest(req, "cancelled");
    }
    this._pendingRequests.clear();
  }

  // ── Core request flow ──

  async _doRequest(type, payload, extra, options = {}) {
    const signal = options.signal;
    if (signal && signal.aborted) return null;

    const token = this._readToken();
    if (!token) {
      this.log("warn", "telegram native bot: token not available");
      return null;
    }

    const requestId = generateRequestId();

    try {
      let messageId;

      if (type === "permission") {
        const msg = messages.buildPermissionMessage(payload, requestId);
        messageId = await this._sendMessage(token, msg);
      } else if (type === "suggestions") {
        const msg = messages.buildSuggestionsMessage(payload, extra.suggestions, requestId);
        messageId = await this._sendMessage(token, msg);
      } else if (type === "elicitation") {
        // Send first question
        const questions = extra.questions || [];
        if (questions.length === 0) return null;
        const msg = messages.buildElicitationMessage(questions[0], 0, questions.length, requestId, {});
        messageId = await this._sendMessage(token, msg);
      }

      if (!messageId) {
        this.log("warn", "telegram native bot: failed to send message");
        return null;
      }

      // Create pending request and wait for resolution
      return await this._waitForResponse(requestId, type, messageId, extra, signal, token);
    } catch (err) {
      this.log("warn", "telegram native bot: request failed", { error: err && err.message });
      return null;
    }
  }

  _waitForResponse(requestId, type, messageId, extra, signal, token) {
    return new Promise((resolve) => {
      const pending = {
        requestId,
        type,
        messageIds: new Set([messageId]),
        token,
        extra: extra || {},
        toggleState: {},
        answers: {},
        currentQuestion: 0,
        resolve,
        ttlTimer: null,
        textInputMessageId: null,
      };

      // TTL timeout
      pending.ttlTimer = this.setTimer(() => {
        this._expireRequest(pending, "timeout");
      }, this.ttlMs);

      // Abort signal
      if (signal) {
        const onAbort = () => {
          this._expireRequest(pending, "cancelled");
        };
        if (signal.aborted) { resolve(null); return; }
        signal.addEventListener("abort", onAbort, { once: true });
        pending._onAbort = onAbort;
        pending._signal = signal;
      }

      this._pendingRequests.set(requestId, pending);
      this._startPolling();
    });
  }

  _expireRequest(pending, reason) {
    if (!this._pendingRequests.has(pending.requestId)) return;
    this._pendingRequests.delete(pending.requestId);

    if (pending.ttlTimer) this.clearTimer(pending.ttlTimer);
    if (pending._signal && pending._onAbort) {
      pending._signal.removeEventListener("abort", pending._onAbort);
    }

    // Edit message to show outcome
    const token = pending.token || this._readToken();
    if (token) {
      for (const msgId of pending.messageIds) {
        this._editMessageReplyMarkup(token, msgId, messages.emptyKeyboard()).catch(noop);
      }
    }

    pending.resolve(null);
    this._scheduleGraceStop();
  }

  // ── Polling ──

  _startPolling() {
    if (this._pollingActive) return;
    this._pollingActive = true;
    if (this._graceTimer) {
      this.clearTimer(this._graceTimer);
      this._graceTimer = null;
    }
    this._pollLoop();
  }

  _stopPolling() {
    this._pollingActive = false;
    if (this._pollAbort) {
      this._pollAbort.abort();
      this._pollAbort = null;
    }
    if (this._graceTimer) {
      this.clearTimer(this._graceTimer);
      this._graceTimer = null;
    }
  }

  _scheduleGraceStop() {
    if (this._pendingRequests.size > 0) return;
    if (this._graceTimer) return;
    this._graceTimer = this.setTimer(() => {
      this._graceTimer = null;
      if (this._pendingRequests.size === 0) {
        this._stopPolling();
      }
    }, GRACE_STOP_MS);
  }

  async _pollLoop() {
    while (this._pollingActive) {
      const token = this._readToken();
      if (!token) { this._stopPolling(); break; }

      try {
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        this._pollAbort = controller;

        const result = await this._apiCall(token, "getUpdates", {
          offset: this._updateOffset,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ["callback_query", "message"],
        }, controller ? controller.signal : null, (POLL_TIMEOUT_S + 5) * 1000);

        if (!this._pollingActive) break;
        if (result && Array.isArray(result.result)) {
          for (const update of result.result) {
            this._updateOffset = update.update_id + 1;
            this._handleUpdate(update, token);
          }
        }
      } catch (err) {
        if (!this._pollingActive) break;
        this.log("debug", "telegram native bot: poll error", { error: err && err.message });
        // Brief pause before retry on error
        await new Promise((r) => this.setTimer(r, 2000));
      }
    }
  }

  // ── Update handling ──

  _handleUpdate(update, token) {
    if (update.callback_query) {
      this._handleCallbackQuery(update.callback_query, token);
    } else if (update.message) {
      this._handleMessage(update.message, token);
    }
  }

  _handleCallbackQuery(cq, token) {
    // Security: validate user
    if (!cq.from || String(cq.from.id) !== this.allowedUserId) return;

    const data = cq.data || "";
    const colonIdx = data.indexOf(":");
    if (colonIdx === -1) return;

    const requestId = data.slice(0, colonIdx);
    const action = data.slice(colonIdx + 1);
    const pending = this._pendingRequests.get(requestId);
    if (!pending) {
      // Acknowledge stale callback
      this._answerCallbackQuery(token, cq.id, "Expired").catch(noop);
      return;
    }

    // Acknowledge the callback
    this._answerCallbackQuery(token, cq.id, "").catch(noop);

    if (action === "allow" || action === "deny") {
      this._resolvePermission(pending, action, token);
    } else if (action.startsWith("sug:")) {
      const idx = parseInt(action.slice(4), 10);
      this._resolveSuggestion(pending, idx, token);
    } else if (action.startsWith("opt:")) {
      const idx = parseInt(action.slice(4), 10);
      this._resolveOption(pending, idx, token);
    } else if (action.startsWith("tog:")) {
      const idx = parseInt(action.slice(4), 10);
      this._toggleCheckbox(pending, idx, token);
    } else if (action === "submit") {
      this._submitMultiSelect(pending, token);
    } else if (action === "other") {
      this._promptTextInput(pending, token);
    } else if (action === "cancel") {
      this._expireRequest(pending, "cancelled");
    }
  }

  _handleMessage(msg, token) {
    // Security: validate user
    if (!msg.from || String(msg.from.id) !== this.allowedUserId) return;
    if (!msg.reply_to_message) return;

    const replyToId = msg.reply_to_message.message_id;
    // Find pending request that has this message as a text input prompt
    for (const [, pending] of this._pendingRequests) {
      if (pending.textInputMessageId === replyToId) {
        this._handleTextReply(pending, msg.text || "", token);
        return;
      }
    }
  }

  // ── Resolution handlers ──

  _resolvePermission(pending, decision, token) {
    this._finishRequest(pending, decision, token);
  }

  _resolveSuggestion(pending, idx, token) {
    const suggestions = pending.extra && pending.extra.suggestions;
    const suggestion = Array.isArray(suggestions) ? suggestions[idx] : null;
    this._finishRequest(pending, { decision: "allow", selectedSuggestion: suggestion || null, suggestionIndex: idx }, token);
  }

  _resolveOption(pending, idx, token) {
    const questions = pending.extra && pending.extra.questions;
    if (!Array.isArray(questions)) {
      this._finishRequest(pending, null, token);
      return;
    }
    const q = questions[pending.currentQuestion];
    const options = q && Array.isArray(q.options) ? q.options : [];
    const selected = options[idx];
    const answerText = selected && selected.label ? selected.label : String(selected || "");

    pending.answers[q.question] = answerText;
    pending.currentQuestion++;

    // More questions?
    if (pending.currentQuestion < questions.length) {
      this._sendNextQuestion(pending, token);
    } else {
      this._finishElicitation(pending, token);
    }
  }

  _toggleCheckbox(pending, idx, token) {
    pending.toggleState[idx] = !pending.toggleState[idx];
    // Re-render the message with updated toggle state
    const questions = pending.extra && pending.extra.questions;
    if (!Array.isArray(questions)) return;
    const q = questions[pending.currentQuestion];
    const msg = messages.buildElicitationMessage(
      q, pending.currentQuestion, questions.length, pending.requestId, pending.toggleState
    );
    const msgId = [...pending.messageIds].pop();
    if (msgId) {
      this._editMessageReplyMarkup(token, msgId, msg.reply_markup).catch(noop);
    }
  }

  _submitMultiSelect(pending, token) {
    const questions = pending.extra && pending.extra.questions;
    if (!Array.isArray(questions)) {
      this._finishRequest(pending, null, token);
      return;
    }
    const q = questions[pending.currentQuestion];
    const options = q && Array.isArray(q.options) ? q.options : [];

    // Collect toggled options
    const selected = [];
    for (let i = 0; i < options.length; i++) {
      if (pending.toggleState[i]) {
        selected.push(options[i].label || String(options[i]));
      }
    }
    pending.answers[q.question] = selected.join(", ");
    pending.toggleState = {};
    pending.currentQuestion++;

    if (pending.currentQuestion < questions.length) {
      this._sendNextQuestion(pending, token);
    } else {
      this._finishElicitation(pending, token);
    }
  }

  async _promptTextInput(pending, token) {
    const msg = messages.buildTextInputPrompt(pending.requestId);
    try {
      const msgId = await this._sendMessage(token, msg);
      if (msgId) {
        pending.textInputMessageId = msgId;
        pending.messageIds.add(msgId);
      }
    } catch (err) {
      this.log("debug", "telegram native bot: text input prompt failed", { error: err && err.message });
    }
  }

  _handleTextReply(pending, text, token) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return;

    const questions = pending.extra && pending.extra.questions;
    if (!Array.isArray(questions)) {
      // Basic permission — treat as deny message?
      this._finishRequest(pending, null, token);
      return;
    }
    const q = questions[pending.currentQuestion];
    if (q) {
      pending.answers[q.question] = trimmed;
    }
    pending.textInputMessageId = null;
    pending.currentQuestion++;

    if (pending.currentQuestion < questions.length) {
      this._sendNextQuestion(pending, token);
    } else {
      this._finishElicitation(pending, token);
    }
  }

  async _sendNextQuestion(pending, token) {
    const questions = pending.extra.questions;
    const q = questions[pending.currentQuestion];
    pending.toggleState = {};
    const msg = messages.buildElicitationMessage(
      q, pending.currentQuestion, questions.length, pending.requestId, {}
    );
    try {
      const msgId = await this._sendMessage(token, msg);
      if (msgId) pending.messageIds.add(msgId);
    } catch (err) {
      this.log("debug", "telegram native bot: next question failed", { error: err && err.message });
      this._finishElicitation(pending, token);
    }
  }

  _finishElicitation(pending, token) {
    this._finishRequest(pending, { decision: "allow", answers: pending.answers }, token);
  }

  _finishRequest(pending, result, token) {
    if (!this._pendingRequests.has(pending.requestId)) return;
    this._pendingRequests.delete(pending.requestId);

    if (pending.ttlTimer) this.clearTimer(pending.ttlTimer);
    if (pending._signal && pending._onAbort) {
      pending._signal.removeEventListener("abort", pending._onAbort);
    }

    // Clean up messages
    if (token) {
      for (const msgId of pending.messageIds) {
        this._editMessageReplyMarkup(token, msgId, messages.emptyKeyboard()).catch(noop);
      }
    }

    // Normalize result for basic permission compatibility
    if (result === "allow" || result === "deny") {
      pending.resolve(result);
    } else {
      pending.resolve(result);
    }

    this._scheduleGraceStop();
  }

  // ── Token management ──

  _readToken() {
    if (!this.tokenFilePath) return null;
    try {
      const stat = fs.statSync(this.tokenFilePath);
      if (this._tokenCache && stat.mtimeMs === this._tokenMtimeMs) {
        return this._tokenCache;
      }
      const content = fs.readFileSync(this.tokenFilePath, "utf8");
      const match = content.match(/CLAWD_TG_BOT_TOKEN=(.+)/);
      if (!match) return null;
      this._tokenCache = match[1].trim();
      this._tokenMtimeMs = stat.mtimeMs;
      return this._tokenCache;
    } catch {
      return null;
    }
  }

  // ── Telegram API calls ──

  _sendMessage(token, msg) {
    const body = {
      chat_id: this.chatId,
      text: msg.text,
      parse_mode: msg.parse_mode,
      reply_markup: msg.reply_markup,
    };
    return this._apiCall(token, "sendMessage", body, null, 15000).then((res) => {
      if (res && res.ok && res.result) return res.result.message_id;
      this.log("debug", "telegram native bot: sendMessage failed", { response: res });
      return null;
    });
  }

  _editMessageReplyMarkup(token, messageId, replyMarkup) {
    return this._apiCall(token, "editMessageReplyMarkup", {
      chat_id: this.chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    }, null, 10000).catch(noop);
  }

  _answerCallbackQuery(token, callbackQueryId, text) {
    return this._apiCall(token, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text || undefined,
    }, null, 10000).catch(noop);
  }

  _apiCall(token, method, body, signal, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(new Error("aborted")); return; }

      const data = JSON.stringify(body);
      const options = {
        hostname: TELEGRAM_API_HOST,
        port: 443,
        path: `/bot${token}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      };

      let settled = false;
      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        if (err) reject(err); else resolve(result);
      };

      const onAbort = () => {
        if (req && typeof req.destroy === "function") req.destroy(new Error("aborted"));
        finish(new Error("aborted"));
      };

      const req = https.request(options, (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { chunks += chunk; });
        res.on("end", () => {
          try {
            finish(null, JSON.parse(chunks));
          } catch {
            finish(new Error(`invalid JSON from Telegram API: ${method}`));
          }
        });
      });

      req.on("error", (err) => finish(err));

      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`telegram API timeout: ${method}`));
        });
      }

      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      req.write(data);
      req.end();
    });
  }
}

module.exports = { TelegramNativeBotClient };
