"use strict";

// Bridges TelegramNativeClient (raw API primitives) and the owner-manager's
// expected handle shape:
//   { isPolling(), start(), stop(), sendTestCard(payload) }
//
// Responsibilities the client itself does NOT handle:
//   - long-poll loop with 409 retry on first iteration
//   - test-card lifecycle: build a nonce, sendMessage with inline keyboard,
//     watch incoming callback_queries for matching nonce + allowed user
//   - real approval lifecycle: requestApproval(payload, { signal }) Promise
//     that resolves a typed allow/deny/suggestion decision on a matching
//     Telegram callback, or null on abort/timeout/send failure
//   - dispatch TEST_SUCCESS / TEST_FAILED back to the migration controller

const {
  TelegramNativeClient,
  pollWithConflictRetry,
  classifyError,
  ERROR_CLASSES,
} = require("./telegram-native-client");

const { EVENTS } = require("./telegram-migration-state");
const { createTranslator } = require("./i18n");
const { redactSecrets } = require("./secret-redact");
const {
  MAX_ELICITATION_OPTION_LABEL,
  clampPreviewText,
} = require("./server-permission-utils");
const {
  buildSessionGrantRevokeAction,
  parseSessionGrantRevokeAction,
  createRemoteCardWorkRegistry,
} = require("./session-automation-remote");
const {
  appendTelegramStatus,
  buildTelegramApprovalMessage,
  isFormattedTelegramMessage,
  isTelegramHtmlParseError,
  plainTelegramText,
} = require("./telegram-message-format");

const APPROVAL_CALLBACK_RE = /^cp:([a-z0-9]+):(a|d|s(\d+))$/;
const LEGACY_APPROVAL_CALLBACK_RE = /^clawdperm:([a-z0-9]+):(allow|deny)$/;
const SESSION_TRUST_CALLBACK_RE = /^ct:([a-z0-9]+):(open|yes|no)$/;
// Elicitation (AskUserQuestion) callback actions:
//   o<question>_<option> - select option <option> of question <question>
//   x<question>          - pick "Other" on question <question> (free-text reply follows)
//   z<question>          - cancel "Other" on question <question>, back to its option list
//   c<question>          - confirm the in-progress multi-select answer for question <question>
//   b<question>          - go back to the question before <question>
//   t                     - bail out to the terminal (parity with Deny's "go to terminal")
const ELICITATION_CALLBACK_RE = /^cq:([a-z0-9]+):(o(\d+)_(\d+)|x(\d+)|z(\d+)|c(\d+)|b(\d+)|t)$/;
const MAX_MESSAGE_TEXT = 3800;
const MAX_BUTTON_TEXT = 32;
const DEFAULT_APPROVAL_TIMEOUT_MS = 90000;
// Elicitation waits on the user to read (possibly several) questions and think
// through an answer, not just tap Allow/Deny - give it more room than a plain
// approval before treating silence as a timeout.
const DEFAULT_ELICITATION_TIMEOUT_MS = 300000;
const MAX_ELICITATION_QUESTIONS = 5;
const MAX_ELICITATION_OPTIONS = 5;
// R1a notifications are fire-and-forget: a slow send must not pile up behind
// the snapshot fanout that triggers it. Bound each send and drop on timeout.
const DEFAULT_NOTIFY_TIMEOUT_MS = 10000;
// Telegram 429s carry retry_after (seconds). Retry once, but never park a
// notification longer than this — a stale "done" ping is worthless.
const MAX_NOTIFY_RETRY_DELAY_MS = 30000;
const DEFAULT_POLL_RETRY_INITIAL_MS = 1000;
const DEFAULT_POLL_RETRY_MAX_MS = 30000;
const DEFAULT_SESSION_AUTOMATION_EDIT_TIMEOUT_MS = 10000;
const ROUTE_INACTIVE_ERROR_CODE = "TELEGRAM_ROUTE_INACTIVE";

function createRouteInactiveError() {
  const err = new Error("Telegram route is no longer active");
  err.code = ROUTE_INACTIVE_ERROR_CODE;
  return err;
}

function isRouteInactiveError(err) {
  return !!err && err.code === ROUTE_INACTIVE_ERROR_CODE;
}

// Status line appended to an approval card whose decision landed somewhere
// other than this Telegram chat, so the chat history shows the outcome
// (issue #457). Keyed by the reason finishApproval received a null decision.
// `elsewhere` is deliberately neutral: a signal abort covers more than a
// desktop answer — the settings approval test arms a 60s abort, and DND /
// dismissed interactive bubbles also abort without anything being "resolved".
// Reads from `t` at call time (not a module-level constant) so the label
// follows the app's current language, not whatever it was when this module
// first loaded.
function approvalResolvedElsewhereStatusText(t, reason) {
  if (reason === "elsewhere") return t("telegramApprovalStatusResolvedElsewhere");
  if (reason === "timeout") return t("telegramApprovalStatusTimedOut");
  if (reason === "stopped") return t("telegramApprovalStatusSessionEnded");
  return undefined;
}

// Status line for a decision taken on Telegram itself (a button tap). The
// callback toast is instant but ephemeral; rewriting the card body leaves the
// outcome in the chat history, symmetric with the resolved-elsewhere path.
function approvalDecidedStatusText(t, action) {
  if (action === "allow") return t("telegramApprovalStatusAllowed");
  if (action === "deny") return t("telegramApprovalStatusDenied");
  if (action === "suggestion") return t("telegramApprovalStatusApplied");
  return undefined;
}

function randomId() {
  return Math.random().toString(36).slice(2, 12);
}

function compactMessageText(value, maxLen = MAX_MESSAGE_TEXT) {
  let text = typeof value === "string" ? value : String(value == null ? "" : value);
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (text.length > maxLen) text = `${text.slice(0, Math.max(0, maxLen - 3))}...`;
  return text;
}

function buildApprovalText(payload) {
  const title = compactMessageText(payload && payload.title, 240);
  if (!title) return null;
  const detail = compactMessageText(payload && payload.detail, MAX_MESSAGE_TEXT - title.length - 32);
  return detail ? `${title}\n\n${detail}` : title;
}

function normalizeApprovalSuggestions(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const suggestions = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const index = Number(item.index);
    if (!Number.isInteger(index) || index < 0 || seen.has(index)) continue;
    const label = compactMessageText(item.label, MAX_BUTTON_TEXT);
    if (!label) continue;
    seen.add(index);
    suggestions.push({ index, label });
  }
  return suggestions;
}

function parseApprovalCallbackData(data) {
  if (typeof data !== "string") return null;
  const match = data.match(APPROVAL_CALLBACK_RE);
  if (match) {
    const actionCode = match[2];
    if (actionCode === "a") return { id: match[1], decision: { action: "allow" } };
    if (actionCode === "d") return { id: match[1], decision: { action: "deny" } };
    const index = Number(match[3]);
    if (Number.isInteger(index) && index >= 0) {
      return { id: match[1], decision: { action: "suggestion", index } };
    }
    return null;
  }
  const legacyMatch = data.match(LEGACY_APPROVAL_CALLBACK_RE);
  if (!legacyMatch) return null;
  return { id: legacyMatch[1], decision: { action: legacyMatch[2] } };
}

function normalizeApprovalDecision(decision) {
  if (!decision || typeof decision !== "object") return null;
  if (
    decision.action === "session-trust"
    && decision.cardHandle
    && typeof decision.cardHandle === "object"
  ) {
    return { action: "session-trust", cardHandle: decision.cardHandle };
  }
  if (decision.action === "allow" || decision.action === "deny") {
    return { action: decision.action };
  }
  if (decision.action === "suggestion") {
    const index = Number(decision.index);
    return Number.isInteger(index) && index >= 0 ? { action: "suggestion", index } : null;
  }
  return null;
}

// Function-form replacement: dynamic values (question progress numbers) must
// never be interpolated with the string form of String.replace, which parses
// $$/$&/$`/$' as special sequences.
function interpolate(template, token, value) {
  return template.replace(token, () => value);
}

// Mirrors feishu-approval-client.js's normalizeElicitationPayload clamping
// rules so a malformed or oversized AskUserQuestion payload can't blow past
// Telegram's message/button length limits or produce an unbounded card.
function normalizeElicitationPayload(payload) {
  const title = compactMessageText(payload && payload.title, 120);
  if (!title) return null;
  const rawQuestions = Array.isArray(payload && payload.questions) ? payload.questions : [];
  const questions = rawQuestions
    .slice(0, MAX_ELICITATION_QUESTIONS)
    // `index` is the question's position in the ORIGINAL payload.questions
    // (i.e. toolInput.questions on the permission side) and is the key the
    // submitted answers map uses. Compacted question text can't serve as the
    // key: it no longer matches the original for long or whitespace-heavy
    // questions, and dropped invalid entries below would shift positions.
    .map((question, index) => {
      if (!question || typeof question !== "object") return null;
      const questionText = compactMessageText(question.question, 240);
      if (!questionText) return null;
      const options = Array.isArray(question.options)
        ? question.options
          .slice(0, MAX_ELICITATION_OPTIONS)
          .map((option) => {
            if (!option || typeof option !== "object") return null;
            // Keep the canonical answer value byte-for-byte aligned with the
            // server's normalization. Telegram-specific cleanup and the
            // 32-character cap are presentation concerns handled later by
            // buildElicitationKeyboard; applying compactMessageText here would
            // rewrite CRLF, control characters, and whitespace in the value
            // returned to the agent.
            const label = clampPreviewText(option.label, MAX_ELICITATION_OPTION_LABEL);
            if (!label) return null;
            return { label };
          })
          .filter(Boolean)
        : [];
      return {
        index,
        header: compactMessageText(question.header, 80),
        question: questionText,
        multiSelect: question.multiSelect === true,
        options,
      };
    })
    .filter(Boolean);
  if (!questions.length) return null;
  return {
    title,
    detail: payload && payload.detail != null ? compactMessageText(payload.detail, MAX_MESSAGE_TEXT) : "",
    agentId: compactMessageText(payload && payload.agentId, 80),
    folder: compactMessageText(payload && payload.folder, 80),
    questions,
  };
}

function buildElicitationHeaderText(payload) {
  const parts = [redactSecrets(payload.title)];
  if (payload.detail) parts.push(redactSecrets(payload.detail));
  return parts.join("\n\n");
}

// Renders the currently active question as the full message body: the
// (stable) header built once from the payload, plus a progress line and the
// question itself. The whole message is re-sent via editMessageText on every
// navigation step - there is no separate "card body" that stays fixed the way
// requestApproval's does, since which question is showing IS the body.
function buildElicitationQuestionText(payload, questionIndex, t) {
  const header = buildElicitationHeaderText(payload);
  const total = payload.questions.length;
  const question = payload.questions[questionIndex];
  const progress = interpolate(
    interpolate(t("telegramElicitationProgress"), "{current}", String(questionIndex + 1)),
    "{total}",
    String(total),
  );
  const questionLines = [progress];
  // Redact secrets from the DISPLAYED question text only. Answers are keyed by
  // the question's original payload index and remapped on the permission side,
  // so display redaction can't desync answer round-tripping.
  if (question.header) questionLines.push(redactSecrets(question.header));
  questionLines.push(redactSecrets(question.question));
  return `${header}\n\n${questionLines.join("\n")}`;
}

function buildElicitationOtherPromptText(payload, questionIndex, t) {
  const base = buildElicitationQuestionText(payload, questionIndex, t);
  return `${base}\n\n${t("telegramElicitationOtherPrompt")}`;
}

// selectedSet is the in-progress (unconfirmed) multi-select toggle state for
// the currently active question - always empty for a single-select question,
// since tapping an option there resolves immediately instead of toggling.
function buildElicitationKeyboard(payload, questionIndex, selectedSet, t) {
  const question = payload.questions[questionIndex];
  const callbackBase = `cq:${payload._id}`;
  const rows = question.options.map((option, optionIndex) => {
    const checked = selectedSet && selectedSet.has(optionIndex);
    // Redact the DISPLAYED label only; the answer value still uses the raw
    // option.label (keyed by option index in the callback), so this is safe.
    const safeLabel = redactSecrets(option.label);
    const label = question.multiSelect ? `${checked ? "☑" : "☐"} ${safeLabel}` : safeLabel;
    return [{ text: compactMessageText(label, MAX_BUTTON_TEXT), callback_data: `${callbackBase}:o${questionIndex}_${optionIndex}` }];
  });
  rows.push([{ text: t("telegramElicitationOtherButton"), callback_data: `${callbackBase}:x${questionIndex}` }]);
  if (question.multiSelect) {
    rows.push([{ text: t("telegramElicitationConfirmButton"), callback_data: `${callbackBase}:c${questionIndex}` }]);
  }
  const navRow = [];
  if (questionIndex > 0) navRow.push({ text: t("telegramElicitationBackButton"), callback_data: `${callbackBase}:b${questionIndex}` });
  navRow.push({ text: t("telegramElicitationTerminalButton"), callback_data: `${callbackBase}:t` });
  rows.push(navRow);
  return rows;
}

function parseElicitationCallbackData(data) {
  if (typeof data !== "string") return null;
  const match = data.match(ELICITATION_CALLBACK_RE);
  if (!match) return null;
  const id = match[1];
  if (match[3] !== undefined) {
    const questionIndex = Number(match[3]);
    const optionIndex = Number(match[4]);
    if (!Number.isInteger(questionIndex) || !Number.isInteger(optionIndex)) return null;
    return { id, action: { type: "option", questionIndex, optionIndex } };
  }
  if (match[5] !== undefined) {
    const questionIndex = Number(match[5]);
    if (!Number.isInteger(questionIndex)) return null;
    return { id, action: { type: "other", questionIndex } };
  }
  if (match[6] !== undefined) {
    const questionIndex = Number(match[6]);
    if (!Number.isInteger(questionIndex)) return null;
    return { id, action: { type: "cancelOther", questionIndex } };
  }
  if (match[7] !== undefined) {
    const questionIndex = Number(match[7]);
    if (!Number.isInteger(questionIndex)) return null;
    return { id, action: { type: "confirm", questionIndex } };
  }
  if (match[8] !== undefined) {
    const questionIndex = Number(match[8]);
    if (!Number.isInteger(questionIndex)) return null;
    return { id, action: { type: "back", questionIndex } };
  }
  return { id, action: { type: "terminal" } };
}

function findNextUnansweredQuestionIndex(payload, answers) {
  return payload.questions.findIndex((question) => !Object.prototype.hasOwnProperty.call(answers, String(question.index)));
}

// Shared fail-closed authorization for both remote approval and elicitation
// callbacks. A blank allowedUser/chatId is treated as "authorize nobody", not
// "skip the check": both an Allow/Deny decision and an elicitation answer feed
// straight back into the agent, so a misconfigured (blank) recipient must
// never let anyone who can reach the chat drive the decision. Approval
// previously used a fail-open variant that let any chat member decide once
// allowedTgUserId was blank; it now shares this check.
//
// Validates against BOTH the entry snapshot AND the current live config
// (currentAllowedUser/currentChatId): if the allowed user was revoked or changed
// after the card was sent, the stale card can no longer be acted on — the click
// must match the config in effect right now, not just the one at send time.
function isCallerAuthorized(entry, fromId, chatId, currentAllowedUser, currentChatId) {
  if (!currentAllowedUser || !currentChatId) return false;
  if (fromId !== String(currentAllowedUser) || chatId !== String(currentChatId)) return false;
  if (!entry.allowedUser || !entry.chatId) return false;
  return fromId === String(entry.allowedUser) && chatId === String(entry.chatId);
}

function extractTelegramMessageId(result) {
  const id = result && result.message_id;
  if (typeof id === "number" && Number.isInteger(id) && id > 0) return id;
  if (typeof id === "string" && /^\d+$/.test(id.trim())) return id.trim();
  return null;
}

function sameTelegramMessageId(left, right) {
  const leftId = extractTelegramMessageId({ message_id: left });
  const rightId = extractTelegramMessageId({ message_id: right });
  return leftId != null && rightId != null && String(leftId) === String(rightId);
}

function createTelegramNativeRunner({
  tokenStore,
  transport,
  getDispatch,        // () => migrationController.dispatch (lazy for cycle)
  getChatId,          // () => "<chat id>" (number-string)
  getAllowedUserId,   // () => "<user id>"
  getLang = () => "en", // () => current app language, for approval/elicitation card / button text
  onCommand = null,   // async ({ command, args, chatId, fromId }) => text | { text }
  isCommandEnabled = () => true,
  onTextMessage = null, // async ({ text, messageId, replyToMessageId, chatId, fromId }) => text | { text }
  isTextMessageEnabled = () => true,
  log = () => {},
  longPollTimeoutMs = 25, // Telegram seconds
  approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  elicitationTimeoutMs = DEFAULT_ELICITATION_TIMEOUT_MS,
  notifyTimeoutMs = DEFAULT_NOTIFY_TIMEOUT_MS,
  pollRetryInitialMs = DEFAULT_POLL_RETRY_INITIAL_MS,
  pollRetryMaxMs = DEFAULT_POLL_RETRY_MAX_MS,
  sessionAutomationEditTimeoutMs = DEFAULT_SESSION_AUTOMATION_EDIT_TIMEOUT_MS,
  onSessionGrantRevoke = null,
  onSessionAutomationRouteChange = null,
  sessionAutomationCardWorkRegistry = null,
  // Injectable so tests can drive 429 retry without real timers.
  sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); }),
}) {
  const client = new TelegramNativeClient({ tokenStore, transport });
  const t = createTranslator(getLang);

  let abortController = null;
  let polling = false;
  let pendingTest = null; // { nonce, chatId, allowedUser, messageId }
  const pendingApprovals = new Map(); // id -> { resolve, chatId, allowedUser, messageId, text, timer, signal, onAbort, suggestionIndexes }
  const issuedSessionTrustCardHandles = new WeakSet();
  const sessionTrustCardWork = sessionAutomationCardWorkRegistry
    || createRemoteCardWorkRegistry({
      log: (err) => safeLog("warn", "native session automation card update failed", {
        error: err && err.message,
      }),
    });
  // id -> { resolve, chatId, allowedUser, messageId, payload, activeQuestionIndex,
  //         answers, multiSelectSelections, awaitingOtherFor, timer, signal, onAbort }
  const pendingElicitations = new Map();
  let lastError = null;
  let pollRetryDelayMs = Math.max(1, pollRetryInitialMs);
  let sessionAutomationRouteSignature = null;
  let botUsername = null;
  let botUsernamePromise = null;
  let botIdentityGeneration = 0;
  let pollingRouteGeneration = null;
  let pollingRouteContext = null;
  let testLifecycleGeneration = 0;
  const routeRequestControllers = new Set();

  function isPolling() {
    return polling;
  }

  // Expose the active bot route to consumers that bind work (such as
  // completion-notification mappings) to a polling lifecycle. Returning null
  // while stopped makes an otherwise equal generation unusable after a stop;
  // the next start receives a fresh generation from invalidateRouteLifecycle.
  function getRouteGeneration() {
    if (!polling
      || pollingRouteGeneration !== botIdentityGeneration
      || !pollingRouteContext) {
      return null;
    }
    try {
      return isCurrentRouteContext(pollingRouteContext)
        ? botIdentityGeneration
        : null;
    } catch {
      return null;
    }
  }

  function resetOffset() {
    // A token reset changes both the Bot API update namespace and the route
    // identity. Tear down the active lifecycle synchronously; the migration
    // controller may start a fresh poller after it reconciles the new token.
    client.resetOffset();
    // Enumerate active remote grants before clearing the runner-owned card
    // state. The coordinator uses this callback to revoke those grants when a
    // bot identity is rotated; notifying after clear would lose the IDs.
    notifySessionAutomationRouteChange();
    invalidateRouteLifecycle();
    polling = false;
    if (abortController) {
      try { abortController.abort(); } catch {}
      abortController = null;
    }
    pollingRouteGeneration = null;
    pollingRouteContext = null;
    clearPendingTest();
    // Unlike a normal stop, resetOffset runs after the replacement token has
    // already been persisted. Resolve old-route callers without trying to edit
    // their cards through the new bot credential.
    clearAllApprovals();
    clearAllElicitations();
  }

  function ownsPollingSignal(signal) {
    return !!signal
      && polling
      && !signal.aborted
      && !!abortController
      && abortController.signal === signal
      && pollingRouteGeneration === botIdentityGeneration;
  }

  function invalidateRouteLifecycle() {
    botIdentityGeneration += 1;
    botUsername = null;
    botUsernamePromise = null;
    for (const controller of routeRequestControllers) {
      try { controller.abort(); } catch {}
    }
    routeRequestControllers.clear();
  }

  function clearPendingTest() {
    testLifecycleGeneration += 1;
    pendingTest = null;
  }

  function captureRouteContext() {
    const chatId = getChatId();
    const allowedUser = getAllowedUserId();
    return {
      generation: botIdentityGeneration,
      chatId: chatId == null ? "" : String(chatId),
      allowedUser: allowedUser == null ? "" : String(allowedUser),
    };
  }

  function isCurrentRouteContext(route, signal = null) {
    if (!route || !polling || route.generation !== botIdentityGeneration) return false;
    if (signal && !ownsPollingSignal(signal)) return false;
    const currentChat = getChatId();
    const currentUser = getAllowedUserId();
    return String(currentChat == null ? "" : currentChat) === route.chatId
      && String(currentUser == null ? "" : currentUser) === route.allowedUser;
  }

  // A callback/render operation may need both the poll lifecycle signal and a
  // card-work deadline signal. AbortSignal.any() is not available on every
  // Electron runtime we support, so link them explicitly and tear the
  // listeners down when the operation settles.
  function linkAbortSignals(signals) {
    const parents = [...new Set((Array.isArray(signals) ? signals : [])
      .filter((signal) => signal && typeof signal.addEventListener === "function"))];
    if (typeof AbortController !== "function") {
      return {
        signal: parents[0] || undefined,
        cleanup: () => {},
      };
    }
    const controller = new AbortController();
    const listeners = [];
    const abort = () => {
      try { controller.abort(); } catch {}
    };
    for (const parent of parents) {
      if (parent.aborted) {
        abort();
        break;
      }
      try {
        parent.addEventListener("abort", abort, { once: true });
        listeners.push(parent);
      } catch {}
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        for (const parent of listeners) {
          try { parent.removeEventListener("abort", abort); } catch {}
        }
      },
    };
  }

  function isOperationRouteCurrent(route, signal, allowInactive = false) {
    if (allowInactive) return true;
    if (!route && !signal) return true;
    return isCurrentRouteContext(route, signal);
  }

  function callbackContextIsCurrent(context) {
    return !!context
      && isCurrentRouteContext(context.route, context.signal);
  }

  function callbackRequestOptions(context) {
    return context && context.signal ? { signal: context.signal } : undefined;
  }

  async function answerCallbackQuery(cb, context, extra = {}) {
    if (!callbackContextIsCurrent(context)) return false;
    try {
      await client.answerCallbackQuery({
        callback_query_id: cb && cb.id,
        ...extra,
      }, callbackRequestOptions(context));
    } catch {}
    return callbackContextIsCurrent(context);
  }

  function answerCallbackQuerySoon(cb, context, extra = {}) {
    if (!callbackContextIsCurrent(context)) return;
    try {
      Promise.resolve(client.answerCallbackQuery({
        callback_query_id: cb && cb.id,
        ...extra,
      }, callbackRequestOptions(context))).catch(() => {});
    } catch {}
  }

  function isCurrentAuthorizedMessage(auth, signal) {
    if (!auth || !ownsPollingSignal(signal)) return false;
    const currentChat = getChatId();
    const currentUser = getAllowedUserId();
    return !!currentChat
      && !!currentUser
      && String(currentChat) === auth.chatId
      && String(currentUser) === auth.fromId;
  }

  function isEnabled() {
    return polling && !!getChatId();
  }

  function getStatus() {
    return {
      polling,
      pendingTest: !!pendingTest,
      pendingApprovalCount: pendingApprovals.size,
      pendingElicitationCount: pendingElicitations.size,
      lastError,
    };
  }

  function noteError(scope, errorClass) {
    lastError = {
      scope: compactMessageText(scope, 48),
      errorClass: compactMessageText(errorClass || "unknown", 48),
      at: Date.now(),
    };
  }

  async function deliverFormatted(method, basePayload, message, requestOptions = {}, deliveryOptions = {}) {
    if (!isFormattedTelegramMessage(message)) {
      throw new Error("Telegram formatted message contract is required");
    }
    const preferPlain = deliveryOptions.preferPlain === true;
    const signal = requestOptions && requestOptions.signal;
    const assertDeliveryActive = () => {
      if (signal && signal.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      if (typeof deliveryOptions.isRouteCurrent === "function"
        && deliveryOptions.isRouteCurrent() !== true) {
        throw createRouteInactiveError();
      }
    };
    const plainBasePayload = { ...basePayload };
    delete plainBasePayload.parse_mode;
    const sendPlain = async () => {
      assertDeliveryActive();
      if (typeof deliveryOptions.onPlainAttempt === "function") {
        try { deliveryOptions.onPlainAttempt(); } catch {}
      }
      const result = await client[method]({
        ...plainBasePayload,
        text: message.plainText,
      }, requestOptions);
      assertDeliveryActive();
      return result;
    };
    if (preferPlain) {
      return { result: await sendPlain(), usedPlain: true };
    }
    try {
      assertDeliveryActive();
      const result = await client[method]({
        ...basePayload,
        text: message.html,
        parse_mode: "HTML",
      }, requestOptions);
      assertDeliveryActive();
      return { result, usedPlain: false };
    } catch (err) {
      if (!isTelegramHtmlParseError(err)) throw err;
      assertDeliveryActive();
      safeLog("warn", "native Telegram HTML rejected, retrying rendered plain text", {
        operation: method === "editMessageText" ? "edit" : "send",
      });
      return { result: await sendPlain(), usedPlain: true };
    }
  }

  async function sendFormattedMessage(basePayload, message, requestOptions, deliveryOptions) {
    return deliverFormatted("sendMessage", basePayload, message, requestOptions, deliveryOptions);
  }

  async function editFormattedMessage(basePayload, message, requestOptions, deliveryOptions) {
    return deliverFormatted("editMessageText", basePayload, message, requestOptions, deliveryOptions);
  }

  function resetPollRetryDelay() {
    pollRetryDelayMs = Math.max(1, pollRetryInitialMs);
  }

  function isFatalPollError(errorClass) {
    return errorClass === ERROR_CLASSES.UNAUTHORIZED
      || errorClass === ERROR_CLASSES.FORBIDDEN
      || errorClass === ERROR_CLASSES.BAD_REQUEST
      || errorClass === ERROR_CLASSES.WEBHOOK_CONFLICT
      || errorClass === ERROR_CLASSES.TOKEN_MISSING;
  }

  function nextPollRetryDelay(err, errorClass) {
    if (errorClass === ERROR_CLASSES.RATE_LIMITED) {
      const retryAfter = Number(err && err.parameters && err.parameters.retry_after);
      const delay = Math.min(
        Math.max(1, pollRetryMaxMs),
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : pollRetryDelayMs,
      );
      pollRetryDelayMs = Math.min(Math.max(1, pollRetryMaxMs), Math.max(delay + 1, delay * 2));
      return delay;
    }
    const delay = Math.min(Math.max(1, pollRetryMaxMs), pollRetryDelayMs);
    pollRetryDelayMs = Math.min(Math.max(1, pollRetryMaxMs), Math.max(delay + 1, delay * 2));
    return delay;
  }

  async function start() {
    if (polling) return;
    invalidateRouteLifecycle();
    const route = captureRouteContext();
    polling = true;
    const controller = new AbortController();
    abortController = controller;
    pollingRouteGeneration = botIdentityGeneration;
    pollingRouteContext = route;
    // First poll uses retry to absorb 409 from a still-releasing bot consumer.
    loopFirst(controller.signal).catch((err) => {
      log("warn", "native polling stopped", { error: err && err.message });
    }).finally(() => {
      if (abortController === controller) {
        // stop() clears abortController before its intentional abort reaches
        // this finally block. Reaching here while still owning the controller
        // therefore means polling died unexpectedly (for example invalid bot
        // credentials or a webhook conflict). Tighten the route and settle all
        // cards before a later start can expose the old generation again.
        finalizeUnexpectedPolling(controller);
      }
    });
  }

  function finalizeUnexpectedPolling(controller) {
    if (!controller || abortController !== controller) return;
    // The coordinator must see active grant IDs while the old client still
    // owns them; after invalidation that inventory is intentionally empty.
    notifySessionAutomationRouteChange();
    // A route-change callback may synchronously stop (or even restart) the
    // runner. Never let cleanup for this controller touch that replacement
    // lifecycle.
    if (abortController !== controller) return;
    invalidateRouteLifecycle();
    polling = false;
    try { controller.abort(); } catch {}
    abortController = null;
    pollingRouteGeneration = null;
    pollingRouteContext = null;
    clearPendingTest();
    clearAllApprovals({ allowInactive: true });
    clearAllElicitations({ allowInactive: true });
  }

  async function stop() {
    notifySessionAutomationRouteChange();
    invalidateRouteLifecycle();
    polling = false;
    if (abortController) {
      try { abortController.abort(); } catch {}
      abortController = null;
    }
    pollingRouteGeneration = null;
    pollingRouteContext = null;
    clearPendingTest();
    // Explicit shutdown keeps the existing chat-history terminalization
    // contract even though the route itself is no longer current.
    clearAllApprovals({ allowInactive: true });
    clearAllElicitations({ allowInactive: true });
  }

  async function loopFirst(signal) {
    let updates;
    try {
      const firstPoll = await pollWithConflictRetry(
        () => client.getUpdates({ timeout: 0, signal }),
        { signal, sleep },
      );
      updates = firstPoll && firstPoll.result;
    } catch (err) {
      if (!ownsPollingSignal(signal)) return;
      const cls = classifyError(err);
      if (cls === ERROR_CLASSES.TIMEOUT) return; // aborted
      if (pendingTest && (cls === ERROR_CLASSES.CONFLICT || isFatalPollError(cls))) {
        await failTest(err, cls);
        return;
      }
      noteError("polling", cls);
      if (isFatalPollError(cls)) return;
      const delayMs = nextPollRetryDelay(err, cls);
      safeLog("warn", "native initial polling error, retrying", { errorClass: cls, delayMs });
      await sleep(delayMs);
      return loop(signal);
    }
    if (!ownsPollingSignal(signal)) return;
    resetPollRetryDelay();
    await handleUpdateBatch(updates, signal);
    return loop(signal);
  }

  async function loop(signal) {
    while (polling && !signal.aborted) {
      let updates;
      try {
        updates = await client.getUpdates({ timeout: longPollTimeoutMs, signal });
      } catch (err) {
        if (!ownsPollingSignal(signal)) return;
        const cls = classifyError(err);
        if (cls === ERROR_CLASSES.TIMEOUT) return; // aborted
        noteError("polling", cls);
        if (isFatalPollError(cls)) {
          if (pendingTest) await failTest(err, cls);
          return;
        }
        const delayMs = nextPollRetryDelay(err, cls);
        safeLog("warn", "native polling error, retrying", { errorClass: cls, delayMs });
        await sleep(delayMs);
        continue;
      }
      if (!ownsPollingSignal(signal)) return;
      resetPollRetryDelay();
      await handleUpdateBatch(updates, signal);
    }
  }

  async function handleUpdateBatch(updates, signal) {
    const batch = Array.isArray(updates) ? updates : [];
    for (const u of batch) {
      if (!ownsPollingSignal(signal)) return;
      try {
        await handleUpdate(u, signal);
      } catch (err) {
        noteError("update", "handler_error");
        safeLog("warn", "native update handler failed", { error: err && err.message });
      }
    }
  }

  async function handleUpdate(update, signal) {
    if (!update || !ownsPollingSignal(signal)) return;
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, signal);
      return;
    }
    if (update.message) {
      await handleMessage(update.message, signal);
    }
  }

  function parseMessageCommand(text) {
    if (typeof text !== "string") return null;
    const match = text.trim().match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    return {
      command: match[1].toLowerCase(),
      username: match[2] || null,
      args: (match[3] || "").trim(),
    };
  }

  async function getBotUsername() {
    if (botUsername) return botUsername;
    if (botUsernamePromise) return botUsernamePromise;

    const signal = abortController && abortController.signal;
    const generation = botIdentityGeneration;
    const lookup = client.getMe(signal ? { signal } : undefined).then((me) => {
      const username = me && typeof me.username === "string" ? me.username.trim() : "";
      if (username && generation === botIdentityGeneration) botUsername = username;
      return username || null;
    }).catch((err) => {
      const cls = classifyError(err);
      noteError("command_identity", cls);
      safeLog("warn", "native bot identity lookup failed", { errorClass: cls });
      return null;
    }).finally(() => {
      if (botUsernamePromise === lookup) botUsernamePromise = null;
    });
    botUsernamePromise = lookup;
    return lookup;
  }

  async function commandTargetsThisBot(username) {
    if (!username) return true;
    const currentUsername = await getBotUsername();
    return !!currentUsername && currentUsername.toLowerCase() === username.toLowerCase();
  }

  function getAuthorizedMessageContext(message) {
    const fromId = message.from && String(message.from.id);
    const chatId = message.chat && String(message.chat.id);
    const allowedUser = getAllowedUserId();
    const targetChat = getChatId();
    if (!allowedUser || fromId !== String(allowedUser)) return null;
    if (!targetChat || chatId !== String(targetChat)) return null;
    return { fromId, chatId };
  }

  function responseText(response) {
    return typeof response === "string"
      ? response
      : (response && typeof response.text === "string" ? response.text : "");
  }

  async function replyToMessage(chatId, response, scope, route, signal) {
    const text = responseText(response);
    if (!text || !isCurrentRouteContext(route, signal)) return;
    try {
      await sendBoundedMessage(chatId, text, route);
    } catch (err) {
      if (isRouteInactiveError(err) || !isCurrentRouteContext(route, signal)) return;
      const cls = classifyError(err);
      noteError(scope, cls);
      log("warn", `native ${scope} reply failed`, { errorClass: cls });
    }
  }

  async function dispatchTextMessage(message, text, auth, signal, route = captureRouteContext()) {
    if (!ownsPollingSignal(signal)) return true;
    let response;
    try {
      response = await onTextMessage({
        text,
        messageId: message.message_id,
        replyToMessageId: message.reply_to_message && message.reply_to_message.message_id,
        fromId: auth.fromId,
        chatId: auth.chatId,
        signal,
      });
    } catch (err) {
      log("warn", "native text message failed", { error: err && err.message });
      noteError("text_message", "handler_error");
      return true;
    }
    if (!isCurrentAuthorizedMessage(auth, signal)) return true;
    await replyToMessage(auth.chatId, response, "text_message", route, signal);
    return true;
  }

  async function handleMessage(message, signal) {
    if (!message || !ownsPollingSignal(signal)) return false;
    const route = captureRouteContext();
    const text = typeof message.text === "string" ? message.text : "";

    // Checked before command parsing: a free-text "Other" answer that
    // happens to start with "/" (e.g. "/help", "/tmp/foo") would otherwise
    // look like a slash command and get silently swallowed below instead of
    // answering the question it's a reply to.
    if (text.trim()) {
      const replyToMessageId = message.reply_to_message && message.reply_to_message.message_id;
      const handledOther = replyToMessageId
        ? await handleElicitationOtherReply({ text, replyToMessageId, message, route, signal })
        : false;
      if (handledOther) return true;
    }

    // A reply target is an explicit session-selection gesture. Route its text
    // before Telegram bot command parsing so agent-native inputs such as
    // `/compact` reach the mapped terminal instead of being swallowed as an
    // unknown bot command. Elicitation "Other" replies keep priority above.
    const replyToMessageId = message.reply_to_message && message.reply_to_message.message_id;
    const textMessageEnabled = typeof onTextMessage === "function"
      && (typeof isTextMessageEnabled !== "function" || isTextMessageEnabled());
    if (replyToMessageId && text.trim() && textMessageEnabled) {
      const auth = getAuthorizedMessageContext(message);
      if (!auth) return true;
      return dispatchTextMessage(message, text, auth, signal, route);
    }

    const parsed = parseMessageCommand(text);
    if (parsed) {
      if (parsed.command !== "status" || typeof onCommand !== "function") return false;
      if (typeof isCommandEnabled === "function" && !isCommandEnabled()) return true;
      const auth = getAuthorizedMessageContext(message);
      if (!auth) return true;
      if (!await commandTargetsThisBot(parsed.username)) return false;
      if (!isCurrentAuthorizedMessage(auth, signal)) return true;
      let response;
      try {
        response = await onCommand({
          ...parsed,
          fromId: auth.fromId,
          chatId: auth.chatId,
        });
      } catch (err) {
        log("warn", "native command failed", { error: err && err.message });
        noteError("command", "handler_error");
        return true;
      }
      if (!isCurrentAuthorizedMessage(auth, signal)) return true;
      await replyToMessage(auth.chatId, response, "command", route, signal);
      return true;
    }

    if (!text.trim()) return false;

    // Direct Send is intentionally reply-scoped: a free-standing message has
    // no stable session target and must not enter the text handler (or produce
    // an "unmapped" bot response). Explicit slash commands were handled above.
    if (!replyToMessageId) return false;
    if (typeof onTextMessage !== "function") return false;
    if (typeof isTextMessageEnabled === "function" && !isTextMessageEnabled()) return true;
    const auth = getAuthorizedMessageContext(message);
    if (!auth) return true;
    return dispatchTextMessage(message, text, auth, signal, route);
  }

  async function handleCallbackQuery(cb, signal) {
    if (!ownsPollingSignal(signal)) return;
    const route = captureRouteContext();
    const fromId = cb.from && String(cb.from.id);
    const chatId = cb.message && cb.message.chat && String(cb.message.chat.id);

    const context = { fromId, chatId, route, signal };
    const handledPersistentRevoke = await handleSessionGrantRevokeCallback(cb, context);
    if (handledPersistentRevoke) return;
    if (!callbackContextIsCurrent(context)) return;

    if (pendingTest) {
      const handledTest = await handleTestCallback(cb, { fromId, chatId }, signal);
      if (handledTest) return;
    }

    if (!callbackContextIsCurrent(context)) return;
    const handledApproval = await handleApprovalCallback(cb, context);
    if (handledApproval) return;

    if (!callbackContextIsCurrent(context)) return;
    await handleElicitationCallback(cb, context);
  }

  function callbackMatchesApprovalCard(entry, cb, chatId) {
    const messageId = cb && cb.message && cb.message.message_id;
    return !!(
      entry
      && entry.messageId
      && messageId
      && String(entry.messageId) === String(messageId)
      && String(entry.chatId) === String(chatId)
    );
  }

  function callbackMatchesElicitationCard(entry, cb, chatId) {
    const messageId = cb && cb.message && cb.message.message_id;
    return !!(
      entry
      && entry.messageId
      && messageId
      && String(entry.messageId) === String(messageId)
      && String(entry.chatId) === String(chatId)
    );
  }

  function sessionTrustKeyboard(id, t) {
    return {
      inline_keyboard: [[
        { text: t("telegramSessionTrustConfirmButton"), callback_data: `ct:${id}:yes` },
        { text: t("telegramSessionTrustCancelButton"), callback_data: `ct:${id}:no` },
      ]],
    };
  }

  async function editSessionTrustPrompt(
    basePayload,
    message,
    { route = null, signal = null, allowInactive = false } = {},
  ) {
    if (!isOperationRouteCurrent(route, signal, allowInactive)) {
      throw createRouteInactiveError();
    }
    const timeoutController = typeof AbortController === "function" ? new AbortController() : null;
    const linked = linkAbortSignals([
      timeoutController && timeoutController.signal,
      allowInactive ? null : signal,
    ]);
    const timeoutMs = Number.isFinite(sessionAutomationEditTimeoutMs)
      && sessionAutomationEditTimeoutMs > 0
      ? sessionAutomationEditTimeoutMs
      : DEFAULT_SESSION_AUTOMATION_EDIT_TIMEOUT_MS;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (timeoutController) {
          try { timeoutController.abort(); } catch {}
        }
        reject(new Error("Telegram session automation edit deadline exceeded"));
      }, timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
    try {
      const result = await Promise.race([
        editFormattedMessage(
          basePayload,
          message,
          linked.signal ? { signal: linked.signal } : undefined,
          allowInactive
            ? undefined
            : { isRouteCurrent: () => isOperationRouteCurrent(route, signal) },
        ).then((delivery) => delivery.result),
        timeout,
      ]);
      if (!isOperationRouteCurrent(route, signal, allowInactive)) {
        throw createRouteInactiveError();
      }
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      linked.cleanup();
    }
  }

  function buildApprovalKeyboard(id, entry) {
    const callbackBase = `cp:${id}`;
    const inlineKeyboard = [[
      { text: t("telegramApprovalButtonAllowOnce"), callback_data: `${callbackBase}:a` },
      { text: t("telegramApprovalButtonDeny"), callback_data: `${callbackBase}:d` },
    ]];
    for (const suggestion of entry.suggestions || []) {
      inlineKeyboard.push([
        { text: suggestion.label, callback_data: `${callbackBase}:s${suggestion.index}` },
      ]);
    }
    if (entry.canOfferSessionTrust === true) {
      inlineKeyboard.push([{
        text: t("telegramSessionTrustButton"),
        callback_data: `ct:${id}:open`,
      }]);
    }
    return { inline_keyboard: inlineKeyboard };
  }

  async function handleSessionTrustApprovalCallback(
    cb,
    { fromId, chatId, route = null, signal = null } = {},
  ) {
    const context = { fromId, chatId, route, signal };
    const data = typeof cb.data === "string" ? cb.data : "";
    const match = data.match(SESSION_TRUST_CALLBACK_RE);
    if (!match) return false;
    if (!callbackContextIsCurrent(context)) return true;
    const id = match[1];
    const action = match[2];
    const entry = pendingApprovals.get(id);
    if (
      !entry
      || entry.canOfferSessionTrust !== true
      || !isCallerAuthorized(entry, fromId, chatId, getAllowedUserId(), getChatId())
      || !callbackMatchesApprovalCard(entry, cb, chatId)
    ) {
      await answerCallbackQuery(cb, context, {
        text: entry ? t("telegramApprovalToastNotAllowed") : t("telegramApprovalToastExpired"),
      });
      return true;
    }
    if (action === "open") {
      if (!callbackContextIsCurrent(context)) return true;
      entry.trustConfirming = true;
      const confirmationMessage = appendTelegramStatus(
        entry.message,
        t("telegramSessionTrustConfirmText"),
        { maxLength: MAX_MESSAGE_TEXT },
      );
      try {
        await editSessionTrustPrompt({
          chat_id: entry.chatId,
          message_id: entry.messageId,
          reply_markup: sessionTrustKeyboard(id, t),
        }, confirmationMessage, { route, signal });
        if (!callbackContextIsCurrent(context)) return true;
        await answerCallbackQuery(cb, context, {
          text: t("telegramSessionTrustConfirmToast"),
        });
      } catch (err) {
        if (!callbackContextIsCurrent(context) || isRouteInactiveError(err)) return true;
        entry.trustConfirming = false;
        await answerCallbackQuery(cb, context, {
          text: t("telegramApprovalToastUnavailable"),
        });
      }
      return true;
    }
    if (action === "no") {
      if (!callbackContextIsCurrent(context)) return true;
      try {
        await editSessionTrustPrompt({
          chat_id: entry.chatId,
          message_id: entry.messageId,
          reply_markup: buildApprovalKeyboard(id, entry),
        }, entry.message, { route, signal });
        if (!callbackContextIsCurrent(context)) return true;
        entry.trustConfirming = false;
      } catch (err) {
        if (!callbackContextIsCurrent(context) || isRouteInactiveError(err)) return true;
        entry.trustConfirming = true;
        await answerCallbackQuery(cb, context, {
          text: t("telegramApprovalToastUnavailable"),
        });
        return true;
      }
      await answerCallbackQuery(cb, context);
      return true;
    }
    if (entry.trustConfirming !== true) {
      await answerCallbackQuery(cb, context, {
        text: t("telegramApprovalToastExpired"),
      });
      return true;
    }
    if (!callbackContextIsCurrent(context)) return true;
    const cardWork = sessionTrustCardWork.reserve(`pending:${id}`, {
      chatId: entry.chatId,
      messageId: entry.messageId,
      text: entry.text,
      message: entry.message,
      route,
      pollSignal: signal,
    });
    if (!cardWork) {
      try {
        await editSessionTrustPrompt({
          chat_id: entry.chatId,
          message_id: entry.messageId,
          reply_markup: buildApprovalKeyboard(id, entry),
        }, entry.message, { route, signal });
        if (!callbackContextIsCurrent(context)) return true;
        entry.trustConfirming = false;
      } catch (err) {
        if (!callbackContextIsCurrent(context) || isRouteInactiveError(err)) return true;
        entry.trustConfirming = true;
      }
      await answerCallbackQuery(cb, context, {
        text: t("telegramApprovalToastUnavailable"),
      });
      return true;
    }
    const cardHandle = Object.freeze({
      approvalId: id,
      chatId: entry.chatId,
      messageId: entry.messageId,
      text: entry.text,
      message: entry.message,
      routeSignature: sessionAutomationRouteSignature,
      route,
      pollSignal: signal,
      cardWork,
    });
    issuedSessionTrustCardHandles.add(cardHandle);
    answerCallbackQuerySoon(cb, context, {
      text: t("telegramSessionTrustPreparingToast"),
    });
    finishApproval(id, { action: "session-trust", cardHandle });
    return true;
  }

  async function handleSessionGrantRevokeCallback(
    cb,
    { fromId, chatId, route = null, signal = null } = {},
  ) {
    const grantId = parseSessionGrantRevokeAction(cb && cb.data);
    if (!grantId) return false;
    const context = { fromId, chatId, route, signal };
    if (!callbackContextIsCurrent(context)) return true;
    const messageId = cb && cb.message && cb.message.message_id;
    const currentUser = getAllowedUserId();
    const currentChat = getChatId();
    const authorized = !!currentUser
      && !!currentChat
      && String(fromId) === String(currentUser)
      && String(chatId) === String(currentChat);
    const active = authorized && sessionTrustCardWork.hasCard(grantId, (ref) => (
      ref
      && String(ref.chatId) === String(chatId)
      && String(ref.messageId) === String(messageId)
      // Card-work may outlive a polling lifecycle while the coordinator is
      // revoking or rebuilding grants. A callback replayed after restart must
      // not revoke that old grant through the new route. Legacy injected card
      // references without route metadata remain accepted for compatibility.
      && (!ref.route || isOperationRouteCurrent(ref.route, ref.pollSignal))
    ));
    if (!active || typeof onSessionGrantRevoke !== "function") {
      await answerCallbackQuery(cb, context, {
        text: authorized
          ? t("telegramSessionTrustStaleToast")
          : t("telegramApprovalToastNotAllowed"),
      });
      return true;
    }
    let result;
    try {
      result = onSessionGrantRevoke(grantId);
    } catch {
      result = { status: "invalid" };
    }
    if (result && typeof result.then === "function") result = { status: "invalid" };
    const revoked = result
      && (result.status === "applied" || result.status === "candidate-cancelled");
    if (!callbackContextIsCurrent(context)) return true;
    await answerCallbackQuery(cb, context, {
      text: revoked
        ? t("telegramSessionTrustRevokedToast")
        : t("telegramSessionTrustStaleToast"),
    });
    if (!callbackContextIsCurrent(context)) return true;
    if (!revoked) {
      sessionTrustCardWork.deactivateGrant(grantId, (ref, _id, taskContext = {}) => renderSessionTrustTerminal(
        ref,
        t("telegramSessionTrustStaleStatus"),
        { ...taskContext, route, pollSignal: signal, requireCurrentRoute: true },
      ));
    }
    return true;
  }

  async function handleTestCallback(cb, { fromId, chatId }, signal) {
    const test = pendingTest;
    if (!test) return false;
    // Fail closed against the CURRENT config: a blank allowed user must not let
    // any chat member mark a broken config as native-verified (codex finding 3).
    const currentUser = getAllowedUserId();
    const currentChat = getChatId();
    const isAllowedUser = !!currentUser && fromId === String(currentUser)
      && !!test.allowedUser && fromId === String(test.allowedUser);
    const isExpectedChat = !!currentChat && chatId === String(currentChat)
      && (!test.chatId || chatId === String(test.chatId));
    if (cb.data !== `clawd-test:${test.nonce}` || !isAllowedUser || !isExpectedChat) {
      if (typeof cb.data !== "string" || !cb.data.startsWith("clawd-test:")) return false;
      // Acknowledge stray callbacks so the Telegram client closes its spinner.
      try {
        await client.answerCallbackQuery(
          { callback_query_id: cb.id },
          signal ? { signal } : undefined
        );
      } catch {}
      return true;
    }
    // Claim the matching test before yielding. A new test, stop, or route reset
    // increments the lifecycle generation and prevents this callback from
    // settling the replacement test after either Telegram request returns.
    pendingTest = null;
    try {
      await client.answerCallbackQuery(
        { callback_query_id: cb.id, text: t("telegramApprovalToastAck") },
        signal ? { signal } : undefined
      );
    } catch {}
    if (test.generation !== testLifecycleGeneration
      || !ownsPollingSignal(signal)
      || String(getAllowedUserId() || "") !== String(test.allowedUser || "")
      || String(getChatId() || "") !== String(test.chatId || "")) {
      return true;
    }
    try {
      await client.editMessageReplyMarkup(
        {
          chat_id: chatId,
          message_id: test.messageId,
          reply_markup: { inline_keyboard: [] },
        },
        signal ? { signal } : undefined
      );
    } catch {}
    if (test.generation !== testLifecycleGeneration
      || !ownsPollingSignal(signal)
      || String(getAllowedUserId() || "") !== String(test.allowedUser || "")
      || String(getChatId() || "") !== String(test.chatId || "")) {
      return true;
    }
    const dispatch = getDispatch && getDispatch();
    if (dispatch) await dispatch({ type: EVENTS.TEST_SUCCESS, at: Date.now() });
    return true;
  }

  async function handleApprovalCallback(
    cb,
    { fromId, chatId, route = null, signal = null } = {},
  ) {
    const context = { fromId, chatId, route, signal };
    if (!callbackContextIsCurrent(context)) return true;
    if (await handleSessionTrustApprovalCallback(cb, context)) return true;
    if (!callbackContextIsCurrent(context)) return true;
    const data = typeof cb.data === "string" ? cb.data : "";
    const parsed = parseApprovalCallbackData(data);
    if (!parsed) return false;
    const entry = pendingApprovals.get(parsed.id);
    if (!entry) {
      await answerCallbackQuery(cb, context, { text: t("telegramApprovalToastExpired") });
      return true;
    }
    if (!isOperationRouteCurrent(entry.route, entry.pollSignal)) return true;
    if (!isCallerAuthorized(entry, fromId, chatId, getAllowedUserId(), getChatId())) {
      await answerCallbackQuery(cb, context, { text: t("telegramApprovalToastNotAllowed") });
      return true;
    }
    if (!callbackMatchesApprovalCard(entry, cb, chatId) || entry.trustConfirming === true) {
      await answerCallbackQuery(cb, context, { text: t("telegramApprovalToastExpired") });
      return true;
    }

    const decision = parsed.decision;
    if (decision.action === "suggestion" && !entry.suggestionIndexes.has(decision.index)) {
      await answerCallbackQuery(cb, context, { text: t("telegramApprovalToastUnavailable") });
      return true;
    }
    if (!callbackContextIsCurrent(context)) return true;
    // Acknowledge the tap (best-effort, NON-blocking) and then claim the
    // decision SYNCHRONOUSLY via finishApproval before any await. Awaiting the
    // toast or the card rewrite first would yield the event loop, and a
    // concurrent timeout / signal abort / stop could delete this pending entry
    // mid-flight and drop a real Allow/Deny. finishApproval resolves the
    // promise up front and fire-and-forgets the status-line rewrite.
    answerCallbackQuerySoon(cb, context, {
      text: decision.action === "allow"
        ? t("telegramApprovalToastAllowed")
        : (decision.action === "deny" ? t("telegramApprovalToastDenied") : t("telegramApprovalToastApplied")),
    });
    const messageId = entry.messageId || (cb.message && cb.message.message_id);
    finishApproval(parsed.id, decision, undefined, messageId);
    return true;
  }

  async function dispatchEvent(event) {
    const dispatch = getDispatch && getDispatch();
    if (dispatch) await dispatch(event);
  }

  function dispatchEventSoon(event, isCurrent = null) {
    const timer = setTimeout(() => {
      if (typeof isCurrent === "function" && isCurrent() !== true) return;
      dispatchEvent(event).catch((err) => {
        log("warn", "native dispatch failed", { error: err && err.message });
      });
    }, 0);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  async function failTest(
    err,
    errorClass,
    { defer = false, generation = null, route = null, pollSignal = null } = {},
  ) {
    const expectedGeneration = generation != null && Number.isSafeInteger(Number(generation))
      ? Number(generation)
      : (pendingTest && pendingTest.generation != null
        && Number.isSafeInteger(Number(pendingTest.generation))
        ? Number(pendingTest.generation)
        : null);
    const isCurrent = () => (
      (expectedGeneration == null || expectedGeneration === testLifecycleGeneration)
      && (!route || isOperationRouteCurrent(route, pollSignal))
    );
    if (!isCurrent()) return false;
    noteError("polling", errorClass);
    pendingTest = null;
    const event = {
      type: EVENTS.TEST_FAILED,
      errorClass,
      description: err && err.description,
    };
    if (defer) dispatchEventSoon(event, isCurrent);
    else await dispatchEvent(event);
    return true;
  }

  async function sendTestCard() {
    // Claim a fresh lifecycle before reading the route. This invalidates a
    // previous card and any deferred failure from it, even when this attempt
    // discovers that the chat target is currently missing.
    testLifecycleGeneration += 1;
    const generation = testLifecycleGeneration;
    pendingTest = null;
    const chatId = getChatId();
    const allowedUser = getAllowedUserId();
    if (!chatId) {
      dispatchEventSoon(
        { type: EVENTS.TEST_FAILED, errorClass: "no_chat" },
        () => generation === testLifecycleGeneration,
      );
      return;
    }
    const nonce = randomId();
    const route = polling ? captureRouteContext() : null;
    const pollSignal = route && abortController ? abortController.signal : null;
    // Register before the network send resolves. The migration path starts
    // native polling and then sends the test card; if the first getUpdates()
    // hits a fatal setup error (for example webhook conflict) before
    // sendMessage returns, loopFirst must still dispatch TEST_FAILED instead
    // of leaving a clickable card with no poller behind it.
    pendingTest = {
      nonce,
      chatId,
      allowedUser,
      messageId: null,
      generation,
    };

    const requestController = typeof AbortController === "function"
      ? new AbortController()
      : null;
    if (requestController) routeRequestControllers.add(requestController);
    let onPollAbort = null;
    if (requestController && pollSignal && typeof pollSignal.addEventListener === "function") {
      onPollAbort = () => {
        try { requestController.abort(); } catch {}
      };
      if (pollSignal.aborted) onPollAbort();
      else {
        try { pollSignal.addEventListener("abort", onPollAbort, { once: true }); } catch {}
      }
    }
    const requestOptions = requestController ? { signal: requestController.signal } : undefined;
    const isTestRouteCurrent = () => {
      if (generation !== testLifecycleGeneration) return false;
      if (requestController && requestController.signal.aborted) return false;
      if (route && !isOperationRouteCurrent(route, pollSignal)) return false;
      const currentChatId = getChatId();
      const currentAllowedUser = getAllowedUserId();
      return String(currentChatId == null ? "" : currentChatId) === String(chatId)
        && String(currentAllowedUser == null ? "" : currentAllowedUser) === String(allowedUser);
    };
    try {
      if (!isTestRouteCurrent()) {
        if (pendingTest && pendingTest.nonce === nonce) clearPendingTest();
        return;
      }
      const msg = await client.sendMessage({
        chat_id: chatId,
        text: t("telegramTestMessage"),
        reply_markup: {
          inline_keyboard: [[{ text: t("telegramTestConfirmButton"), callback_data: `clawd-test:${nonce}` }]],
        },
      }, requestOptions);
      if (isTestRouteCurrent() && pendingTest && pendingTest.nonce === nonce) {
        pendingTest.messageId = msg && msg.message_id;
      } else if (pendingTest && pendingTest.nonce === nonce) {
        clearPendingTest();
      }
    } catch (err) {
      if (!isTestRouteCurrent() || !pendingTest || pendingTest.nonce !== nonce) {
        if (pendingTest && pendingTest.nonce === nonce) clearPendingTest();
        return;
      }
      const cls = classifyError(err);
      noteError("test", cls);
      await failTest(err, cls, { defer: true, generation, route, pollSignal });
    } finally {
      if (pollSignal && onPollAbort && typeof pollSignal.removeEventListener === "function") {
        try { pollSignal.removeEventListener("abort", onPollAbort); } catch {}
      }
      if (requestController) routeRequestControllers.delete(requestController);
    }
  }

  // Best-effort: strip the inline keyboard off an approval card. A normal
  // operation is tied to its route; explicit shutdown passes allowInactive so
  // the terminal card can still be written after polling has been stopped.
  function stripApprovalKeyboard(
    chatId,
    messageId,
    { route = null, signal = null, allowInactive = false } = {},
  ) {
    if (!chatId || !messageId || !isOperationRouteCurrent(route, signal, allowInactive)) {
      return Promise.resolve();
    }
    const requestOptions = !allowInactive && signal ? { signal } : undefined;
    const deliveryIsCurrent = () => isOperationRouteCurrent(route, signal, allowInactive);
    return client.editMessageReplyMarkup({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }, requestOptions).then((result) => {
      if (!deliveryIsCurrent()) return undefined;
      return result;
    }).catch(() => {});
  }

  // Best-effort: rewrite an approval card's body with a status line appended so
  // the chat history shows the outcome. editMessageText without reply_markup
  // also drops the inline keyboard; if the rewrite fails (deleted message, edit
  // window expired, ...) — or there's no status/body to render — fall back to
  // stripping just the keyboard so a stale prompt can't be tapped. Never throws.
  function appendApprovalStatus(
    entry,
    status,
    messageId,
    { route = entry && entry.route, signal = entry && entry.pollSignal, allowInactive = false } = {},
  ) {
    const chatId = entry && entry.chatId;
    if (!chatId || !messageId || !isOperationRouteCurrent(route, signal, allowInactive)) {
      return Promise.resolve();
    }
    if (!status || !entry.message) {
      return stripApprovalKeyboard(chatId, messageId, { route, signal, allowInactive });
    }
    const message = appendTelegramStatus(entry.message, status, { maxLength: MAX_MESSAGE_TEXT });
    const requestOptions = !allowInactive && signal ? { signal } : undefined;
    const deliveryOptions = allowInactive
      ? undefined
      : { isRouteCurrent: () => isOperationRouteCurrent(route, signal) };
    return editFormattedMessage({
      chat_id: chatId,
      message_id: messageId,
    }, message, requestOptions, deliveryOptions).then((delivery) => {
      if (!isOperationRouteCurrent(route, signal, allowInactive)) return undefined;
      return delivery.result;
    }).catch(() => {
      if (!isOperationRouteCurrent(route, signal, allowInactive)) return undefined;
      return stripApprovalKeyboard(chatId, messageId, { route, signal, allowInactive });
    });
  }

  function renderSessionTrustCard(cardRef, status, grantId, options = {}) {
    if (!cardRef || !cardRef.chatId || !cardRef.messageId || !grantId) {
      return Promise.reject(new Error("session trust card reference is unavailable"));
    }
    const route = options.route !== undefined ? options.route : cardRef.route;
    const pollSignal = options.pollSignal !== undefined ? options.pollSignal : cardRef.pollSignal;
    const allowInactive = options.allowInactive === true;
    const requireCurrentRoute = options.requireCurrentRoute === true
      || !!(route || pollSignal);
    if (requireCurrentRoute && !isOperationRouteCurrent(route, pollSignal, allowInactive)) {
      return Promise.reject(createRouteInactiveError());
    }
    const baseMessage = cardRef.message || plainTelegramText(cardRef.text || "", {
      maxLength: MAX_MESSAGE_TEXT,
      neutralizeMentions: true,
    });
    const message = appendTelegramStatus(baseMessage, status, { maxLength: MAX_MESSAGE_TEXT });
    const linked = linkAbortSignals([
      options.signal,
      allowInactive || !requireCurrentRoute ? null : pollSignal,
    ]);
    const requestOptions = linked.signal ? { signal: linked.signal } : undefined;
    const deliveryOptions = requireCurrentRoute && !allowInactive
      ? { isRouteCurrent: () => isOperationRouteCurrent(route, pollSignal) }
      : undefined;
    return editFormattedMessage({
      chat_id: cardRef.chatId,
      message_id: cardRef.messageId,
      reply_markup: {
        inline_keyboard: [[{
          text: t("telegramSessionTrustRevokeButton"),
          callback_data: buildSessionGrantRevokeAction(grantId),
        }]],
      },
    }, message, requestOptions, deliveryOptions)
      .then((delivery) => {
        if (requireCurrentRoute && !isOperationRouteCurrent(route, pollSignal, allowInactive)) {
          throw createRouteInactiveError();
        }
        return delivery.result;
      }).finally(() => linked.cleanup());
  }

  function renderSessionTrustTerminal(cardRef, status, options = {}) {
    if (!cardRef || !cardRef.chatId || !cardRef.messageId) return Promise.resolve();
    const route = options.route !== undefined ? options.route : cardRef.route;
    const pollSignal = options.pollSignal !== undefined ? options.pollSignal : cardRef.pollSignal;
    const allowInactive = options.allowInactive === true;
    const requireCurrentRoute = options.requireCurrentRoute === true;
    if (requireCurrentRoute && !isOperationRouteCurrent(route, pollSignal, allowInactive)) {
      return Promise.resolve();
    }
    const baseMessage = cardRef.message || plainTelegramText(cardRef.text || "", {
      maxLength: MAX_MESSAGE_TEXT,
      neutralizeMentions: true,
    });
    const message = appendTelegramStatus(baseMessage, status, { maxLength: MAX_MESSAGE_TEXT });
    const linked = linkAbortSignals([
      options.signal,
      allowInactive || !requireCurrentRoute ? null : pollSignal,
    ]);
    const requestOptions = linked.signal ? { signal: linked.signal } : undefined;
    const deliveryOptions = requireCurrentRoute && !allowInactive
      ? { isRouteCurrent: () => isOperationRouteCurrent(route, pollSignal) }
      : undefined;
    return editFormattedMessage({
      chat_id: cardRef.chatId,
      message_id: cardRef.messageId,
    }, message, requestOptions, deliveryOptions)
      .then((delivery) => {
        if (requireCurrentRoute && !isOperationRouteCurrent(route, pollSignal, allowInactive)) return undefined;
        return delivery.result;
      }).finally(() => linked.cleanup());
  }

  function notifySessionAutomationRouteChange() {
    if (typeof onSessionAutomationRouteChange !== "function") return;
    try { onSessionAutomationRouteChange(api); } catch {}
  }

  function syncSessionAutomationRoute(route) {
    const next = JSON.stringify(route && typeof route === "object" ? route : {});
    if (sessionAutomationRouteSignature !== null && next !== sessionAutomationRouteSignature) {
      notifySessionAutomationRouteChange();
    }
    sessionAutomationRouteSignature = next;
  }

  function supportsSessionAutomation() {
    return polling
      && typeof onSessionGrantRevoke === "function"
      && typeof client.editMessageText === "function";
  }

  function beginSessionTrustCandidate({ grantId, cardHandle } = {}) {
    if (!issuedSessionTrustCardHandles.has(cardHandle)) return null;
    issuedSessionTrustCardHandles.delete(cardHandle);
    const cardWork = cardHandle.cardWork;
    if (
      !supportsSessionAutomation()
      || cardHandle.routeSignature !== sessionAutomationRouteSignature
      || (cardHandle.route
        && !isOperationRouteCurrent(cardHandle.route, cardHandle.pollSignal))
      || !sessionTrustCardWork.bindCandidateGrant(cardWork, grantId)
    ) {
      // The user already completed the two-step confirmation, so leaving the
      // old yes/no keyboard behind would invite a second click that can only be
      // reported as stale. Best-effort terminalize it through the same bounded
      // queue; even an obsolete credential cannot retain the slot past deadline.
      sessionTrustCardWork.enqueue(cardWork, (cardRef, { signal }) => (
        renderSessionTrustTerminal(
          cardRef,
          t("telegramSessionTrustFailedStatus"),
          { signal, allowInactive: true }
        )
      ), { terminal: true, outcome: "terminal" });
      return null;
    }
    return cardWork;
  }

  function discardSessionTrustCardHandle(cardHandle, { reason } = {}) {
    if (!issuedSessionTrustCardHandles.has(cardHandle)) return false;
    issuedSessionTrustCardHandles.delete(cardHandle);
    const cardWork = cardHandle && cardHandle.cardWork;
    const status = reason === "remote-revoke"
      ? t("telegramSessionTrustRevokedStatus")
      : t("telegramSessionTrustResolvedStatus");
    sessionTrustCardWork.enqueue(cardWork, (cardRef, { signal }) => (
      renderSessionTrustTerminal(cardRef, status, { signal, allowInactive: true })
    ), { terminal: true, outcome: "terminal" });
    return true;
  }

  function prepareSessionTrustCandidate(cardWork, { grantId } = {}) {
    return sessionTrustCardWork.enqueue(cardWork, (cardRef, { signal }) => (
      renderSessionTrustCard(
        cardRef,
        t("telegramSessionTrustPreparingStatus"),
        grantId,
        {
          signal,
          route: cardRef.route,
          pollSignal: cardRef.pollSignal,
          requireCurrentRoute: true,
        }
      )
    ), { outcome: "preparing" });
  }

  function activateSessionTrustCandidate(cardWork, { grantId } = {}) {
    return sessionTrustCardWork.activate(cardWork, grantId);
  }

  function renderActiveSessionTrust(cardWork, { grantId, outcome } = {}) {
    const status = outcome === "already-active"
      ? t("telegramSessionTrustAlreadyActiveStatus")
      : t("telegramSessionTrustActiveStatus");
    return sessionTrustCardWork.enqueue(cardWork, (cardRef, { signal }) => (
      renderSessionTrustCard(cardRef, status, grantId, {
        signal,
        route: cardRef.route,
        pollSignal: cardRef.pollSignal,
        requireCurrentRoute: true,
      })
    ), { outcome: "active" });
  }

  function cancelSessionTrustCandidate(cardWork, { reason, activeGrantId } = {}) {
    if (activeGrantId && sessionTrustCardWork.activate(cardWork, activeGrantId)) {
      renderActiveSessionTrust(cardWork, {
        grantId: activeGrantId,
        outcome: "already-active",
      });
      return true;
    }
    const status = reason === "remote-revoke"
      ? t("telegramSessionTrustRevokedStatus")
      : (reason === "resolved" || reason === "permission-resolved")
        ? t("telegramSessionTrustResolvedStatus")
        : t("telegramSessionTrustFailedStatus");
    sessionTrustCardWork.enqueue(cardWork, (cardRef, { signal }) => (
      renderSessionTrustTerminal(cardRef, status, { signal, allowInactive: true })
    ), { terminal: true, outcome: "terminal" });
    return true;
  }

  function handleSessionAutomationChanges(changes) {
    for (const change of Array.isArray(changes) ? changes : []) {
      const previous = change && change.previous;
      const next = change && change.next;
      if (!previous || !previous.grantId || (next && next.grantId === previous.grantId)) continue;
      const status = change.reason === "remote-revoke"
        ? t("telegramSessionTrustRevokedStatus")
        : t("telegramSessionTrustExpiredStatus");
      sessionTrustCardWork.deactivateGrant(previous.grantId, (cardRef, _grantId, { signal }) => (
        renderSessionTrustTerminal(cardRef, status, { signal, allowInactive: true })
      ));
    }
  }

  function listActiveSessionAutomationGrantIds() {
    return sessionTrustCardWork.activeGrantIds();
  }

  function retireSessionAutomationGrant(grantId, options = {}) {
    const status = options.reason === "stale"
      ? t("telegramSessionTrustStaleStatus")
      : t("telegramSessionTrustExpiredStatus");
    return sessionTrustCardWork.deactivateGrant(grantId, (cardRef, _id, { signal }) => (
      renderSessionTrustTerminal(cardRef, status, { signal, allowInactive: true })
    ));
  }

  // Single resolution point for an approval, used by every exit: a Telegram
  // tap, a desktop answer (abort), a timeout, polling stop, or a send failure.
  //
  // The entry is claimed SYNCHRONOUSLY (pulled from the map, timer + abort
  // listener cleared, promise resolved) before any network I/O, so two exits
  // racing on the same id can't both act — the second finds no entry and no-ops.
  // The card rewrite is then fire-and-forget so a slow edit never blocks or
  // re-opens that race.
  //
  // `reason` has no default on purpose: a null-decision caller that forgets to
  // pass one yields `status === undefined`, which degrades to stripping just
  // the keyboard (the #446 behavior) rather than mislabeling the outcome.
  function finishApproval(id, decision, reason, messageIdOverride, { allowInactive = false } = {}) {
    const entry = pendingApprovals.get(id);
    if (!entry) return;
    pendingApprovals.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      try { entry.signal.removeEventListener("abort", entry.onAbort); } catch {}
    }
    const normalized = normalizeApprovalDecision(decision);
    entry.resolve(normalized);
    if (normalized && normalized.action === "session-trust") return;
    // Rewrite the card so the chat history shows the outcome and the inline
    // keyboard is dropped. A Telegram-side decision shows the chosen action; a
    // null decision (resolved elsewhere / timeout / polling stopped) shows the
    // neutral reason. Best-effort — appendApprovalStatus never throws.
    const status = normalized
      ? approvalDecidedStatusText(t, normalized.action)
      : approvalResolvedElsewhereStatusText(t, reason);
    appendApprovalStatus(entry, status, messageIdOverride || entry.messageId, {
      route: entry.route,
      signal: entry.pollSignal,
      allowInactive,
    });
  }

  function clearAllApprovals({ allowInactive = false } = {}) {
    const ids = Array.from(pendingApprovals.keys());
    for (const id of ids) {
      finishApproval(id, null, "stopped", undefined, { allowInactive });
    }
  }

  function requestApproval(payload, options = {}) {
    const chatId = getChatId();
    const allowedUser = getAllowedUserId();
    const message = buildTelegramApprovalMessage(payload, { maxLength: MAX_MESSAGE_TEXT });
    const text = message && message.plainText;
    const suggestions = normalizeApprovalSuggestions(payload && payload.suggestions);
    const signal = options && options.signal;
    const route = captureRouteContext();
    const pollSignal = abortController && abortController.signal;
    const onDelivered = options && typeof options.onDelivered === "function"
      ? options.onDelivered
      : null;
    if (!isCurrentRouteContext(route, pollSignal) || !chatId || !allowedUser || !text || (signal && signal.aborted)) {
      const reason = !polling ? "not polling"
        : (!chatId ? "missing chat" : (!allowedUser ? "missing allowed user" : (!text ? "missing text" : "aborted")));
      log("debug", `native approval skipped: ${reason}`);
      return Promise.resolve(null);
    }
    const id = randomId();
    return new Promise((resolve) => {
      const entry = {
        resolve,
        chatId,
        allowedUser,
        route,
        pollSignal,
        messageId: null,
        // Card body as sent, kept so a resolved-elsewhere edit can rebuild the
        // text with a status line appended (issue #457).
        text,
        message,
        timer: null,
        signal,
        onAbort: null,
        suggestionIndexes: new Set(suggestions.map((suggestion) => suggestion.index)),
        suggestions,
        canOfferSessionTrust: payload && payload.canOfferSessionTrust === true,
        trustConfirming: false,
      };
      pendingApprovals.set(id, entry);

      entry.timer = setTimeout(() => finishApproval(id, null, "timeout"), Math.max(1, approvalTimeoutMs));
      if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();

      if (signal) {
        entry.onAbort = () => finishApproval(id, null, "elsewhere");
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      const cardSignalLink = linkAbortSignals([signal, pollSignal]);
      sendFormattedMessage({
        chat_id: chatId,
        reply_markup: {
          ...buildApprovalKeyboard(id, entry),
        },
      }, message, cardSignalLink.signal ? { signal: cardSignalLink.signal } : undefined, {
        isRouteCurrent: () => isOperationRouteCurrent(route, pollSignal),
      }).then((delivery) => {
        const msg = delivery.result;
        const current = pendingApprovals.get(id);
        if (!current || (signal && signal.aborted)
          || !isOperationRouteCurrent(current.route, current.pollSignal)) return;
        const messageId = msg && msg.message_id;
        current.messageId = messageId;
        if (messageId !== null && messageId !== undefined && messageId !== "" && onDelivered) {
          try { onDelivered({ messageId }); } catch (err) {
            safeLog("warn", "native approval delivery callback failed", { error: err && err.message });
          }
        }
        safeLog("debug", "native approval card sent");
      }).catch((err) => {
        if (cardSignalLink.signal && cardSignalLink.signal.aborted) {
          safeLog("debug", "native approval send aborted");
          finishApproval(id, null);
          return;
        }
        safeLog("warn", "native approval send failed", { error: err && err.message });
        noteError("approval", classifyError(err));
        finishApproval(id, null);
      }).finally(() => cardSignalLink.cleanup());
    });
  }

  // Best-effort: rewrite the elicitation card in place, either to show the
  // next/previous question (with a fresh keyboard) or - when called without a
  // keyboard - to show a final status line with no keyboard, mirroring
  // appendApprovalStatus's fallback-to-stripped-keyboard behavior on failure.
  function renderElicitationCard(
    entry,
    message,
    keyboard,
    { route = entry && entry.route, signal = entry && entry.pollSignal, allowInactive = false } = {},
  ) {
    if (!entry.chatId || !entry.messageId || !isOperationRouteCurrent(route, signal, allowInactive)) {
      return Promise.resolve();
    }
    const payload = { chat_id: entry.chatId, message_id: entry.messageId };
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    const requestOptions = !allowInactive && signal ? { signal } : undefined;
    const deliveryOptions = allowInactive
      ? undefined
      : { isRouteCurrent: () => isOperationRouteCurrent(route, signal) };
    return editFormattedMessage(payload, message, requestOptions, deliveryOptions)
      .then((delivery) => {
        if (!isOperationRouteCurrent(route, signal, allowInactive)) return undefined;
        return delivery.result;
      }).catch(() => {
      if (!isOperationRouteCurrent(route, signal, allowInactive)) return undefined;
      if (!keyboard) return undefined;
      return stripApprovalKeyboard(entry.chatId, entry.messageId, { route, signal, allowInactive });
    });
  }

  function renderElicitationQuestion(entry) {
    if (entry.awaitingOtherFor != null) {
      const text = buildElicitationOtherPromptText(entry.payload, entry.awaitingOtherFor, t);
      const message = plainTelegramText(text, {
        maxLength: MAX_MESSAGE_TEXT,
        neutralizeMentions: true,
      });
      const callbackBase = `cq:${entry.payload._id}`;
      // A dead end otherwise: without a way back to the option list, tapping
      // Other by mistake (or changing your mind) would force either typing
      // something or giving up and bailing to the terminal, discarding every
      // answer already collected for the other questions.
      const keyboard = [
        [{ text: t("telegramElicitationCancelOtherButton"), callback_data: `${callbackBase}:z${entry.awaitingOtherFor}` }],
        [{ text: t("telegramElicitationTerminalButton"), callback_data: `${callbackBase}:t` }],
      ];
      return renderElicitationCard(entry, message, keyboard);
    }
    const text = buildElicitationQuestionText(entry.payload, entry.activeQuestionIndex, t);
    const message = plainTelegramText(text, {
      maxLength: MAX_MESSAGE_TEXT,
      neutralizeMentions: true,
    });
    const keyboard = buildElicitationKeyboard(entry.payload, entry.activeQuestionIndex, entry.multiSelectSelections, t);
    return renderElicitationCard(entry, message, keyboard);
  }

  // Single resolution point for an elicitation, used by every exit: a
  // Telegram-side submit/terminal tap, a desktop answer (abort), a timeout, or
  // polling stop. Claims the entry synchronously before any network I/O, same
  // race-safety reasoning as finishApproval.
  function finishElicitation(id, decision, reason, { allowInactive = false } = {}) {
    const entry = pendingElicitations.get(id);
    if (!entry) return;
    pendingElicitations.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      try { entry.signal.removeEventListener("abort", entry.onAbort); } catch {}
    }
    entry.resolve(decision);
    const status = decision === "terminal"
      ? t("telegramElicitationTerminalStatus")
      : (decision && typeof decision === "object" && decision.type === "elicitation-submit")
        ? t("telegramElicitationSubmittedStatus")
        : approvalResolvedElsewhereStatusText(t, reason);
    const baseText = entry.awaitingOtherFor != null
      ? buildElicitationOtherPromptText(entry.payload, entry.awaitingOtherFor, t)
      : buildElicitationQuestionText(entry.payload, entry.activeQuestionIndex, t);
    if (!entry.chatId || !entry.messageId) return;
    const baseMessage = plainTelegramText(baseText, {
      maxLength: MAX_MESSAGE_TEXT,
      neutralizeMentions: true,
    });
    const message = status
      ? appendTelegramStatus(baseMessage, status, { maxLength: MAX_MESSAGE_TEXT })
      : baseMessage;
    renderElicitationCard(entry, message, null, {
      route: entry.route,
      signal: entry.pollSignal,
      allowInactive,
    });
  }

  function clearAllElicitations({ allowInactive = false } = {}) {
    const ids = Array.from(pendingElicitations.keys());
    for (const id of ids) {
      finishElicitation(id, null, "stopped", { allowInactive });
    }
  }

  // Records an answer for the active question and moves the entry forward:
  // to the next unanswered question, or - once every question has an answer -
  // resolves the whole request with the collected answers.
  function advanceElicitation(id, entry) {
    if (!entry || !isOperationRouteCurrent(entry.route, entry.pollSignal)) return;
    entry.multiSelectSelections = new Set();
    entry.awaitingOtherFor = null;
    const nextIndex = findNextUnansweredQuestionIndex(entry.payload, entry.answers);
    if (nextIndex === -1) {
      finishElicitation(id, { type: "elicitation-submit", answers: entry.answers });
      return;
    }
    entry.activeQuestionIndex = nextIndex;
    renderElicitationQuestion(entry).catch(() => {});
  }

  async function handleElicitationCallback(
    cb,
    { fromId, chatId, route = null, signal = null } = {},
  ) {
    const context = { fromId, chatId, route, signal };
    const data = typeof cb.data === "string" ? cb.data : "";
    const parsed = parseElicitationCallbackData(data);
    if (!parsed) return false;
    if (!callbackContextIsCurrent(context)) return true;
    const entry = pendingElicitations.get(parsed.id);
    if (!entry) {
      await answerCallbackQuery(cb, context, { text: t("telegramElicitationToastExpired") });
      return true;
    }
    if (!isOperationRouteCurrent(entry.route, entry.pollSignal)) return true;
    // Backfill from the callback's own message id if the in-flight sendMessage
    // for this card hasn't resolved yet (a fast enough tap can race it) -
    // every render below reads entry.messageId, and without this every card
    // edit for this exchange would silently no-op forever, not just once.
    if (!entry.messageId) {
      if (!callbackContextIsCurrent(context)) return true;
      entry.messageId = (cb.message && cb.message.message_id) || entry.messageId;
    }
    if (!callbackMatchesElicitationCard(entry, cb, chatId)) {
      await answerCallbackQuery(cb, context, { text: t("telegramElicitationToastExpired") });
      return true;
    }
    if (!isCallerAuthorized(entry, fromId, chatId, getAllowedUserId(), getChatId())) {
      await answerCallbackQuery(cb, context, { text: t("telegramElicitationToastNotAllowed") });
      return true;
    }
    if (!callbackContextIsCurrent(context)) return true;

    const { action } = parsed;

    if (action.type === "terminal") {
      answerCallbackQuerySoon(cb, context, { text: t("telegramElicitationToastTerminal") });
      finishElicitation(parsed.id, "terminal");
      return true;
    }

    // Every other action targets a specific question; a tap on a stale
    // rendering of a question that's no longer active (double-tap, or the
    // card already moved on) is a no-op rather than corrupting a later
    // question's state.
    if (action.questionIndex !== entry.activeQuestionIndex) {
      await answerCallbackQuery(cb, context, { text: t("telegramElicitationToastExpired") });
      return true;
    }
    const question = entry.payload.questions[entry.activeQuestionIndex];
    if (!question || !callbackContextIsCurrent(context)) return true;

    if (action.type === "back") {
      if (entry.activeQuestionIndex <= 0) {
        await answerCallbackQuery(cb, context);
        return true;
      }
      answerCallbackQuerySoon(cb, context);
      if (!callbackContextIsCurrent(context)) return true;
      entry.activeQuestionIndex -= 1;
      entry.multiSelectSelections = new Set();
      entry.awaitingOtherFor = null;
      renderElicitationQuestion(entry).catch(() => {});
      return true;
    }

    if (action.type === "other") {
      answerCallbackQuerySoon(cb, context);
      if (!callbackContextIsCurrent(context)) return true;
      entry.awaitingOtherFor = entry.activeQuestionIndex;
      renderElicitationQuestion(entry).catch(() => {});
      return true;
    }

    if (action.type === "cancelOther") {
      answerCallbackQuerySoon(cb, context);
      if (!callbackContextIsCurrent(context)) return true;
      entry.awaitingOtherFor = null;
      renderElicitationQuestion(entry).catch(() => {});
      return true;
    }

    if (action.type === "option") {
      const option = question.options[action.optionIndex];
      if (!option) {
        await answerCallbackQuery(cb, context, { text: t("telegramElicitationToastUnavailable") });
        return true;
      }
      if (question.multiSelect) {
        answerCallbackQuerySoon(cb, context);
        if (!callbackContextIsCurrent(context)) return true;
        if (entry.multiSelectSelections.has(action.optionIndex)) {
          entry.multiSelectSelections.delete(action.optionIndex);
        } else {
          entry.multiSelectSelections.add(action.optionIndex);
        }
        renderElicitationQuestion(entry).catch(() => {});
        return true;
      }
      answerCallbackQuerySoon(cb, context, { text: t("telegramElicitationToastAnswered") });
      if (!callbackContextIsCurrent(context)) return true;
      entry.answers[question.index] = option.label;
      advanceElicitation(parsed.id, entry);
      return true;
    }

    if (action.type === "confirm") {
      if (!question.multiSelect) {
        answerCallbackQuerySoon(cb, context);
        return true;
      }
      if (entry.multiSelectSelections.size === 0) {
        await answerCallbackQuery(cb, context, { text: t("telegramElicitationToastPickAtLeastOne") });
        return true;
      }
      answerCallbackQuerySoon(cb, context, { text: t("telegramElicitationToastAnswered") });
      if (!callbackContextIsCurrent(context)) return true;
      const labels = Array.from(entry.multiSelectSelections)
        .sort((a, b) => a - b)
        .map((optionIndex) => question.options[optionIndex].label);
      entry.answers[question.index] = labels.join(", ");
      advanceElicitation(parsed.id, entry);
      return true;
    }

    return true;
  }

  // Answers the active "Other" question with free-text typed as a reply to
  // the elicitation card, mirroring how a Telegram button tap answers a fixed
  // option. Must run BEFORE the generic onTextMessage (Direct Send) handler:
  // a pending elicitation blocks the agent on this decision, so its reply
  // belongs to the question, not to whatever session Direct Send would guess
  // from the completion-notification mapping.
  async function handleElicitationOtherReply({ text, replyToMessageId, message, route, signal }) {
    if (!isOperationRouteCurrent(route, signal)) return true;
    let match = null;
    for (const [id, entry] of pendingElicitations) {
      if (entry.awaitingOtherFor != null
        && sameTelegramMessageId(entry.messageId, replyToMessageId)
        && isOperationRouteCurrent(entry.route, entry.pollSignal)) {
        match = { id, entry };
        break;
      }
    }
    if (!match) return false;
    const { id, entry } = match;
    const fromId = message.from && String(message.from.id);
    const chatId = message.chat && String(message.chat.id);
    // A reply to a pending elicitation card is this feature's business either
    // way: returning `false` here (instead of the button-tap handler's
    // equivalent "not allowed" `true`) would let an unauthorized reply fall
    // through to the generic Direct Send text pipeline instead of being
    // dropped here.
    if (!isCallerAuthorized(entry, fromId, chatId, getAllowedUserId(), getChatId())) return true;
    if (!isOperationRouteCurrent(route, signal)
      || !isOperationRouteCurrent(entry.route, entry.pollSignal)) return true;
    const question = entry.payload.questions[entry.awaitingOtherFor];
    const answer = compactMessageText(text, 500);
    if (!question || !answer) return true;
    // Authorization and normalization can yield to callers in future (and
    // direct tests may invoke this handler with a stale captured route). Re-
    // validate both lifecycles immediately before mutating the pending entry.
    if (!isOperationRouteCurrent(route, signal)
      || !isOperationRouteCurrent(entry.route, entry.pollSignal)) return true;
    entry.answers[question.index] = answer;
    advanceElicitation(id, entry);
    return true;
  }

  function requestElicitation(payload, options = {}) {
    const chatId = getChatId();
    const allowedUser = getAllowedUserId();
    const normalized = normalizeElicitationPayload(payload);
    const signal = options && options.signal;
    const route = captureRouteContext();
    const pollSignal = abortController && abortController.signal;
    const onDelivered = options && typeof options.onDelivered === "function"
      ? options.onDelivered
      : null;
    if (!isCurrentRouteContext(route, pollSignal) || !chatId || !allowedUser || !normalized || (signal && signal.aborted)) {
      const reason = !polling ? "not polling"
        : (!chatId ? "missing chat" : (!allowedUser ? "missing allowed user" : (!normalized ? "invalid payload" : "aborted")));
      log("debug", `native elicitation skipped: ${reason}`);
      return Promise.resolve(null);
    }
    const id = randomId();
    normalized._id = id;
    const text = buildElicitationQuestionText(normalized, 0, t);
    const message = plainTelegramText(text, {
      maxLength: MAX_MESSAGE_TEXT,
      neutralizeMentions: true,
    });
    const keyboard = buildElicitationKeyboard(normalized, 0, null, t);

    return new Promise((resolve) => {
      const entry = {
        resolve,
        chatId,
        allowedUser,
        route,
        pollSignal,
        messageId: null,
        payload: normalized,
        activeQuestionIndex: 0,
        answers: {},
        multiSelectSelections: new Set(),
        awaitingOtherFor: null,
        timer: null,
        signal,
        onAbort: null,
      };
      pendingElicitations.set(id, entry);

      entry.timer = setTimeout(() => finishElicitation(id, null, "timeout"), Math.max(1, elicitationTimeoutMs));
      if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();

      if (signal) {
        entry.onAbort = () => finishElicitation(id, null, "elsewhere");
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      const cardSignalLink = linkAbortSignals([signal, pollSignal]);
      sendFormattedMessage({
        chat_id: chatId,
        reply_markup: { inline_keyboard: keyboard },
      }, message, cardSignalLink.signal ? { signal: cardSignalLink.signal } : undefined, {
        isRouteCurrent: () => isOperationRouteCurrent(route, pollSignal),
      }).then((delivery) => {
        const msg = delivery.result;
        const current = pendingElicitations.get(id);
        if (!current || (signal && signal.aborted)
          || !isOperationRouteCurrent(current.route, current.pollSignal)) return;
        const messageId = msg && msg.message_id;
        current.messageId = messageId;
        if (messageId !== null && messageId !== undefined && messageId !== "" && onDelivered) {
          try { onDelivered({ messageId }); } catch (err) {
            safeLog("warn", "native elicitation delivery callback failed", { error: err && err.message });
          }
        }
        safeLog("debug", "native elicitation card sent");
      }).catch((err) => {
        if (cardSignalLink.signal && cardSignalLink.signal.aborted) {
          safeLog("debug", "native elicitation send aborted");
          finishElicitation(id, null);
          return;
        }
        safeLog("warn", "native elicitation send failed", { error: err && err.message });
        noteError("elicitation", classifyError(err));
        finishElicitation(id, null);
      }).finally(() => cardSignalLink.cleanup());
    });
  }

  // Send one plain-text message with a bounded timeout. No inline keyboard,
  // no pending lifecycle — this is the building block for fire-and-forget
  // notifications (R1a). Returns the raw message or throws a classified error.
  // The injected logger ultimately does a synchronous file write
  // (telegramApprovalLog → permLog → rotatedAppend), which can throw on a
  // bad path / EACCES. Notifications are fire-and-forget on an async chain, so
  // a throwing log must not turn into an unhandled rejection.
  function safeLog(level, message, meta) {
    try { log(level, message, meta); } catch {}
  }

  function errorLogMeta(err, extra = {}) {
    const code = err && (err.code || err.causeCode || (err.cause && err.cause.code));
    return {
      ...extra,
      error: err && err.message ? err.message : "",
      errorCode: code || "",
    };
  }

  async function sendBoundedMessage(chatId, text, route = null) {
    const controller = new AbortController();
    routeRequestControllers.add(controller);
    const timer = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, Math.max(1, notifyTimeoutMs));
    if (timer && typeof timer.unref === "function") timer.unref();
    try {
      if (route && !isCurrentRouteContext(route)) throw createRouteInactiveError();
      const sent = await client.sendMessage(
        { chat_id: chatId, text },
        { signal: controller.signal },
      );
      if (route && !isCurrentRouteContext(route)) throw createRouteInactiveError();
      return sent;
    } finally {
      clearTimeout(timer);
      routeRequestControllers.delete(controller);
    }
  }

  async function sendBoundedNotification(chatId, message, deliveryState, route) {
    if (!isFormattedTelegramMessage(message)) {
      return sendBoundedMessage(chatId, message, route);
    }
    const controller = new AbortController();
    routeRequestControllers.add(controller);
    const timer = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, Math.max(1, notifyTimeoutMs));
    if (timer && typeof timer.unref === "function") timer.unref();
    try {
      if (!isCurrentRouteContext(route)) throw createRouteInactiveError();
      const delivery = await sendFormattedMessage(
        { chat_id: chatId },
        message,
        { signal: controller.signal },
        {
          preferPlain: deliveryState.preferPlain === true,
          onPlainAttempt: () => { deliveryState.preferPlain = true; },
          isRouteCurrent: () => isCurrentRouteContext(route),
        },
      );
      if (!isCurrentRouteContext(route)) throw createRouteInactiveError();
      return delivery.result;
    } finally {
      clearTimeout(timer);
      routeRequestControllers.delete(controller);
    }
  }

  // Public R1a entry point. Best-effort: never throws, always resolves to a
  // structured result so callers (the snapshot fanout) can log without
  // branching on exceptions. One 429 retry honouring retry_after; everything
  // else (403 blocked, timeout, network) is logged and dropped.
  async function sendNotification(value) {
    const chatId = getChatId();
    const route = captureRouteContext();
    const body = isFormattedTelegramMessage(value) ? value : compactMessageText(value);
    const hasBody = isFormattedTelegramMessage(body) ? !!body.plainText : !!body;
    if (!polling || !chatId || !hasBody || !isCurrentRouteContext(route)) {
      return { ok: false, errorClass: "not_active" };
    }
    const deliveryState = { preferPlain: false };
    try {
      const sent = await sendBoundedNotification(chatId, body, deliveryState, route);
      if (!isCurrentRouteContext(route)) return { ok: false, errorClass: "not_active" };
      return { ok: true, messageId: extractTelegramMessageId(sent), chatId: String(chatId) };
    } catch (err) {
      if (isRouteInactiveError(err) || !isCurrentRouteContext(route)) {
        return { ok: false, errorClass: "not_active" };
      }
      const cls = classifyError(err);
      if (cls === ERROR_CLASSES.RATE_LIMITED) {
        const retryAfter = Number(err && err.parameters && err.parameters.retry_after);
        const delayMs = Math.min(
          MAX_NOTIFY_RETRY_DELAY_MS,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000,
        );
        safeLog("warn", "native notification rate limited, retrying once", { delayMs });
        try {
          await sleep(delayMs);
          // Re-read chat id: the user may have re-targeted Telegram during the
          // retry_after window. Bail if polling stopped, the chat was cleared,
          // OR the target changed — re-firing a "done" ping at a different chat
          // than the one in flight is worse than dropping it.
          const retryChatId = getChatId();
          if (!isCurrentRouteContext(route)
            || !retryChatId
            || String(retryChatId) !== route.chatId) {
            return { ok: false, errorClass: "not_active" };
          }
          const sent = await sendBoundedNotification(retryChatId, body, deliveryState, route);
          if (!isCurrentRouteContext(route)) return { ok: false, errorClass: "not_active" };
          return { ok: true, messageId: extractTelegramMessageId(sent), chatId: String(retryChatId) };
        } catch (err2) {
          if (isRouteInactiveError(err2) || !isCurrentRouteContext(route)) {
            return { ok: false, errorClass: "not_active" };
          }
          const cls2 = classifyError(err2);
          noteError("notification", cls2);
          safeLog("warn", "native notification send failed", errorLogMeta(err2, { errorClass: cls2 }));
          return { ok: false, errorClass: cls2 };
        }
      }
      noteError("notification", cls);
      if (cls === ERROR_CLASSES.TOKEN_MISSING) {
        safeLog("debug", "native notification skipped: no token");
      } else {
        safeLog("warn", "native notification send failed", errorLogMeta(err, { errorClass: cls }));
      }
      return { ok: false, errorClass: cls };
    }
  }

  const api = {
    isEnabled,
    isPolling,
    getRouteGeneration,
    resetOffset,
    start,
    stop,
    sendTestCard,
    requestApproval,
    requestElicitation,
    sendNotification,
    supportsSessionAutomation,
    beginSessionTrustCandidate,
    discardSessionTrustCardHandle,
    prepareSessionTrustCandidate,
    activateSessionTrustCandidate,
    renderActiveSessionTrust,
    cancelSessionTrustCandidate,
    handleSessionAutomationChanges,
    listActiveSessionAutomationGrantIds,
    retireSessionAutomationGrant,
    syncSessionAutomationRoute,
    getStatus,
    _client: client,
    _pendingApprovals: pendingApprovals,
    _pendingElicitations: pendingElicitations,
  };
  return api;
}

module.exports = {
  createTelegramNativeRunner,
  buildApprovalText,
};
