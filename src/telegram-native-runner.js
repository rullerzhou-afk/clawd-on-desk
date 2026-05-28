"use strict";

// Bridges TelegramNativeClient (raw API primitives) and the owner-manager's
// expected handle shape:
//   { isPolling(), start(), stop(), sendTestCard(payload) }
//
// Responsibilities the client itself does NOT handle:
//   - long-poll loop with 409 retry on first iteration
//   - test-card lifecycle: build a nonce, sendMessage with inline keyboard,
//     watch incoming callback_queries for matching nonce + allowed user
//   - dispatch TEST_SUCCESS / TEST_FAILED back to the migration controller

const {
  TelegramNativeClient,
  pollWithConflictRetry,
  classifyError,
  ERROR_CLASSES,
} = require("./telegram-native-client");

const { EVENTS } = require("./telegram-migration-state");

function createTelegramNativeRunner({
  tokenStore,
  transport,
  getDispatch,        // () => migrationController.dispatch (lazy for cycle)
  getChatId,          // () => "<chat id>" (number-string)
  getAllowedUserId,   // () => "<user id>"
  log = () => {},
  longPollTimeoutMs = 25, // Telegram seconds
}) {
  const client = new TelegramNativeClient({ tokenStore, transport });

  let abortController = null;
  let polling = false;
  let pendingTest = null; // { nonce, chatId, allowedUser, messageId }

  function isPolling() {
    return polling;
  }

  async function start() {
    if (polling) return;
    polling = true;
    const controller = new AbortController();
    abortController = controller;
    // First poll uses retry to absorb 409 from a still-releasing sidecar.
    loopFirst(controller.signal).catch((err) => {
      log("warn", "native polling stopped", { error: err && err.message });
    }).finally(() => {
      if (abortController === controller) {
        polling = false;
        abortController = null;
      }
    });
  }

  async function stop() {
    polling = false;
    if (abortController) {
      try { abortController.abort(); } catch {}
      abortController = null;
    }
  }

  async function loopFirst(signal) {
    try {
      await pollWithConflictRetry(() => client.getUpdates({ timeout: 0, signal }), { signal });
    } catch (err) {
      const cls = classifyError(err);
      if (cls === ERROR_CLASSES.TIMEOUT) return; // aborted
      if (cls === ERROR_CLASSES.CONFLICT || cls === ERROR_CLASSES.WEBHOOK_CONFLICT) {
        await failTest(err, cls);
        return;
      }
      // Any other class: pass through to normal loop so consistent classification.
      await failTest(err, cls);
      return;
    }
    return loop(signal);
  }

  async function loop(signal) {
    while (polling && !signal.aborted) {
      let updates;
      try {
        updates = await client.getUpdates({ timeout: longPollTimeoutMs, signal });
      } catch (err) {
        const cls = classifyError(err);
        if (cls === ERROR_CLASSES.TIMEOUT) return; // aborted
        await failTest(err, cls);
        return;
      }
      for (const u of updates) {
        await handleUpdate(u);
      }
    }
  }

  async function handleUpdate(update) {
    if (!update || !update.callback_query || !pendingTest) return;
    const cb = update.callback_query;
    const fromId = cb.from && String(cb.from.id);
    const chatId = cb.message && cb.message.chat && String(cb.message.chat.id);
    const isAllowedUser = !pendingTest.allowedUser || fromId === String(pendingTest.allowedUser);
    const isExpectedChat = !pendingTest.chatId || chatId === String(pendingTest.chatId);
    if (cb.data !== `clawd-test:${pendingTest.nonce}` || !isAllowedUser || !isExpectedChat) {
      // Acknowledge stray callbacks so the Telegram client closes its spinner.
      try { await client.answerCallbackQuery({ callback_query_id: cb.id }); } catch {}
      return;
    }
    try { await client.answerCallbackQuery({ callback_query_id: cb.id, text: "OK" }); } catch {}
    try {
      await client.editMessageReplyMarkup({
        chat_id: chatId,
        message_id: pendingTest.messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch {}
    pendingTest = null;
    const dispatch = getDispatch && getDispatch();
    if (dispatch) await dispatch({ type: EVENTS.TEST_SUCCESS, at: Date.now() });
  }

  async function dispatchEvent(event) {
    const dispatch = getDispatch && getDispatch();
    if (dispatch) await dispatch(event);
  }

  function dispatchEventSoon(event) {
    const timer = setTimeout(() => {
      dispatchEvent(event).catch((err) => {
        log("warn", "native dispatch failed", { error: err && err.message });
      });
    }, 0);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  async function failTest(err, errorClass, { defer = false } = {}) {
    pendingTest = null;
    const event = {
      type: EVENTS.TEST_FAILED,
      errorClass,
      description: err && err.description,
    };
    if (defer) dispatchEventSoon(event);
    else await dispatchEvent(event);
  }

  async function sendTestCard() {
    const chatId = getChatId();
    const allowedUser = getAllowedUserId();
    if (!chatId) {
      dispatchEventSoon({ type: EVENTS.TEST_FAILED, errorClass: "no_chat" });
      return;
    }
    const nonce = Math.random().toString(36).slice(2, 12);
    try {
      const msg = await client.sendMessage({
        chat_id: chatId,
        text: "Clawd: test native Telegram bot. Tap to confirm.",
        reply_markup: {
          inline_keyboard: [[{ text: "Confirm", callback_data: `clawd-test:${nonce}` }]],
        },
      });
      pendingTest = {
        nonce,
        chatId,
        allowedUser,
        messageId: msg && msg.message_id,
      };
    } catch (err) {
      await failTest(err, classifyError(err), { defer: true });
    }
  }

  return { isPolling, start, stop, sendTestCard, _client: client };
}

module.exports = { createTelegramNativeRunner };
