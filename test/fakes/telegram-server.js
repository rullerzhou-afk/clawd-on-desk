"use strict";

// In-memory fake of the Telegram Bot API surface that the native client
// touches. Drives the client through a queue of scripted responses; tests push
// scenarios onto the queue and the fake replays them in order.
//
// Response shape mirrors the Bot API contract: every reply is either
//   { ok: true, result: <any> }           — success
// or
//   { ok: false, status: <int>, error_code?: int, description?: string, parameters?: { retry_after?: int } }
//
// Tests can supply a function instead of a static response when they need to
// branch on the request payload (e.g. polling offset progression).

function createFakeTelegramServer() {
  const scripts = [];
  const calls = [];

  function enqueue(method, response) {
    scripts.push({ method, response });
  }

  function enqueueOk(method, result) {
    enqueue(method, { ok: true, result });
  }

  function enqueueError(method, { status, code, description, parameters } = {}) {
    enqueue(method, {
      ok: false,
      status: status ?? 500,
      error_code: code ?? status ?? 500,
      description: description || "",
      parameters: parameters || {},
    });
  }

  async function transport({ method, payload, signal }) {
    if (signal && signal.aborted) {
      throw makeAbortError();
    }
    // Note: the production transport closes over the bot token; the fake
    // intentionally records only {method, payload} to mirror that contract.
    calls.push({ method, payload });

    const next = scripts.shift();
    if (!next) {
      throw new Error(`fake-telegram: no scripted response queued for ${method}`);
    }
    if (next.method && next.method !== method) {
      throw new Error(`fake-telegram: expected next call to be ${next.method}, got ${method}`);
    }

    // Race the scripted response against the abort signal so mid-flight
    // cancellation surfaces as AbortError (matching real fetch semantics).
    const responsePromise = Promise.resolve(
      typeof next.response === "function" ? next.response(payload) : next.response,
    );
    if (!signal) return responsePromise;

    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(makeAbortError());
      };
      signal.addEventListener("abort", onAbort);
      responsePromise.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  function makeAbortError() {
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
  }

  return {
    transport,
    enqueue,
    enqueueOk,
    enqueueError,
    calls,
    get pending() {
      return scripts.length;
    },
    reset() {
      scripts.length = 0;
      calls.length = 0;
    },
  };
}

module.exports = { createFakeTelegramServer };
