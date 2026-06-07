"use strict";

// Telegram Bot API client used by the native owner. Spike scope: just the
// primitives the migration test card and approval surface need:
//
//   getMe / sendMessage / getUpdates / answerCallbackQuery / editMessageReplyMarkup
//
// + offset progression on getUpdates and AbortController-driven cancellation.
//
// All HTTP I/O is delegated to an injected `transport({method, payload, token, signal})`
// function so tests can replay scripted responses without spinning up a real
// HTTP server. Token reads go through a TelegramTokenStore (see
// telegram-token-store.js); the client never touches the env file directly.

class TelegramApiError extends Error {
  constructor({ status, code, description, parameters } = {}) {
    super(description || `Telegram API HTTP ${status ?? "?"}`);
    this.name = "TelegramApiError";
    this.status = status ?? null;
    this.code = code ?? null;
    this.description = description || "";
    this.parameters = parameters || {};
  }
}

const ERROR_CLASSES = Object.freeze({
  UNAUTHORIZED: "401",
  FORBIDDEN: "403",
  BAD_REQUEST: "400",
  CONFLICT: "409_conflict",
  WEBHOOK_CONFLICT: "409_webhook",
  RATE_LIMITED: "429",
  NETWORK: "network",
  TIMEOUT: "timeout",
  TOKEN_MISSING: "token_missing",
  UNKNOWN: "unknown",
});

function classifyError(err) {
  if (!err) return ERROR_CLASSES.UNKNOWN;
  if (err.name === "AbortError") return ERROR_CLASSES.TIMEOUT;
  if (err instanceof TelegramApiError) {
    if (err.code === "TOKEN_MISSING") return ERROR_CLASSES.TOKEN_MISSING;
    // Some fetch wrappers only populate `error_code` (mirroring the Bot API
    // body) and leave `status` null. Fall back to `code` so classification
    // still works.
    const code = err.status ?? err.code ?? null;
    if (code === 401) return ERROR_CLASSES.UNAUTHORIZED;
    if (code === 403) return ERROR_CLASSES.FORBIDDEN;
    if (code === 400) return ERROR_CLASSES.BAD_REQUEST;
    if (code === 429) return ERROR_CLASSES.RATE_LIMITED;
    if (code === 409) {
      // Plan §168 TODO: regex on description is a UX hint only. The Telegram
      // Bot API does not formally distinguish "another consumer" vs "webhook
      // active" by error_code, so for production reliability we should call
      // `getWebhookInfo` after a 409 and inspect `.url` to be sure. Spike
      // keeps the regex as a fast hint.
      return /webhook/i.test(err.description || "")
        ? ERROR_CLASSES.WEBHOOK_CONFLICT
        : ERROR_CLASSES.CONFLICT;
    }
    return ERROR_CLASSES.UNKNOWN;
  }
  const code = String(err.code || err.causeCode || (err.cause && err.cause.code) || "");
  if (code === "ENOTFOUND"
    || code === "EAI_AGAIN"
    || code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || code === "ECONNABORTED"
    || code === "ETIMEDOUT"
    || code === "UND_ERR_CONNECT_TIMEOUT"
    || code === "UND_ERR_HEADERS_TIMEOUT"
    || code === "UND_ERR_SOCKET") {
    return ERROR_CLASSES.NETWORK;
  }
  const message = String(err.message || "");
  // Electron/Chromium net stack surfaces failures as "net::ERR_*" in the message
  // with no Node-style err.code (issue #359). Allowlist the connection/proxy/DNS/
  // transport failures as retryable NETWORK — NOT a catch-all, so ERR_CERT_* /
  // ERR_BLOCKED_BY_* still fall through to UNKNOWN. ERR_ABORTED maps to NETWORK,
  // not TIMEOUT: the poll loop treats TIMEOUT as user-stop and exits, while a
  // genuine user abort is already handled above (err.name === "AbortError").
  // PROXY_CONNECTION_FAILED is narrowed so proxy cert/auth errors aren't mislabeled.
  if (/net::ERR_(PROXY_CONNECTION_FAILED|TUNNEL_|SOCKS_|CONNECTION_|NAME_NOT_RESOLVED|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|EMPTY_RESPONSE|ABORTED)/i.test(message)) {
    return ERROR_CLASSES.NETWORK;
  }
  if (/fetch failed|network|socket|timeout/i.test(message)) return ERROR_CLASSES.NETWORK;
  return ERROR_CLASSES.UNKNOWN;
}

class TelegramNativeClient {
  constructor({ tokenStore, transport, logger = null } = {}) {
    if (!tokenStore || typeof tokenStore.getToken !== "function") {
      throw new TypeError("TelegramNativeClient: tokenStore.getToken is required");
    }
    if (typeof transport !== "function") {
      throw new TypeError("TelegramNativeClient: transport function is required");
    }
    this.tokenStore = tokenStore;
    this.transport = transport;
    this.logger = logger;
    this._offset = 0;
  }

  get offset() {
    return this._offset;
  }

  resetOffset() {
    this._offset = 0;
  }

  async _call(method, payload = {}, { signal } = {}) {
    // Token availability is checked here, but the value is intentionally not
    // forwarded to the transport call. Production transport implementations
    // hold the token in a closure (or look it up via the tokenStore each
    // call); the per-call API surface stays free of raw secrets so that any
    // future logging / debug serialization of {method, payload, signal}
    // cannot accidentally leak the token.
    const hasToken = await this.tokenStore.hasToken();
    if (!hasToken) {
      throw new TelegramApiError({
        status: null,
        code: "TOKEN_MISSING",
        description: "no Telegram bot token configured",
      });
    }
    const response = await this.transport({ method, payload, signal });
    if (response && response.ok === true) {
      return response.result;
    }
    throw new TelegramApiError({
      status: response && response.status,
      code: response && response.error_code,
      description: response && response.description,
      parameters: response && response.parameters,
    });
  }

  getMe(opts) {
    return this._call("getMe", {}, opts);
  }

  sendMessage(payload, opts) {
    return this._call("sendMessage", payload, opts);
  }

  answerCallbackQuery(payload, opts) {
    return this._call("answerCallbackQuery", payload, opts);
  }

  editMessageReplyMarkup(payload, opts) {
    return this._call("editMessageReplyMarkup", payload, opts);
  }

  // long-poll one batch. Caller is responsible for looping; this method only
  // ever issues one HTTP call so tests stay deterministic.
  async getUpdates({ timeout = 25, signal } = {}) {
    const updates = await this._call(
      "getUpdates",
      { offset: this._offset, timeout },
      { signal },
    );
    if (Array.isArray(updates) && updates.length > 0) {
      const lastId = updates[updates.length - 1].update_id;
      if (Number.isInteger(lastId)) {
        this._offset = Math.max(this._offset, lastId + 1);
      }
    }
    return updates || [];
  }
}

// Plan §116: when starting the native poller right after stopping the sidecar
// (or starting fresh while another consumer is still releasing its long-poll
// session), Telegram returns 409 Conflict. Retry with exponential backoff:
// 1s start, ×2, capped at 5s, total deadline 35s. While in conflict we MUST
// NOT persist transport=native — that is the caller's responsibility; this
// helper only governs the retry loop itself.
const DEFAULT_RETRY_OPTS = Object.freeze({
  initialDelayMs: 1000,
  maxDelayMs: 5000,
  totalDeadlineMs: 35000,
  factor: 2,
});

async function pollWithConflictRetry(
  doCall,
  {
    initialDelayMs = DEFAULT_RETRY_OPTS.initialDelayMs,
    maxDelayMs = DEFAULT_RETRY_OPTS.maxDelayMs,
    totalDeadlineMs = DEFAULT_RETRY_OPTS.totalDeadlineMs,
    factor = DEFAULT_RETRY_OPTS.factor,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    signal,
  } = {},
) {
  const startedAt = now();
  let delay = initialDelayMs;
  let attempts = 0;
  let lastConflictErr = null;

  while (true) {
    if (signal && signal.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    attempts += 1;
    try {
      const result = await doCall();
      return { result, attempts };
    } catch (err) {
      const cls = classifyError(err);
      // Only loop on plain 409 conflict — webhook conflict is fatal because it
      // requires user action (deleteWebhook), not waiting.
      if (cls !== ERROR_CLASSES.CONFLICT) throw err;
      lastConflictErr = err;
      const elapsed = now() - startedAt;
      const remaining = totalDeadlineMs - elapsed;
      if (remaining <= 0) {
        // Deadline hit — propagate the original conflict so caller can decide
        // (UI prompts user to close other Clawd instances).
        const wrapped = new TelegramApiError({
          status: 409,
          code: 409,
          description: err.description || "Conflict (retry deadline exceeded)",
          parameters: { attempts, elapsedMs: elapsed },
        });
        throw wrapped;
      }
      const waitMs = Math.min(delay, remaining);
      await sleep(waitMs);
      delay = Math.min(maxDelayMs, Math.floor(delay * factor));
    }
  }
}

module.exports = {
  TelegramNativeClient,
  TelegramApiError,
  ERROR_CLASSES,
  classifyError,
  pollWithConflictRetry,
  DEFAULT_RETRY_OPTS,
};
