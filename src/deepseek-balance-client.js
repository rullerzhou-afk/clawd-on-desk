"use strict";

const https = require("node:https");

const DEEPSEEK_BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

function classifyHttpResponse(statusCode, body) {
  if (statusCode === 200) {
    try {
      const value = JSON.parse(body.toString("utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return { kind: "success", value };
      }
    } catch {}
    return { kind: "malformed-response", statusCode };
  }
  const kind = statusCode === 401 ? "credential-rejected"
    : statusCode === 402 ? "payment-required"
      : statusCode === 429 ? "rate-limited"
        : statusCode >= 500 ? "server-error" : "http-error";
  return { kind, statusCode };
}

function createDeepseekBalanceClient(options = {}) {
  const request = options.request || https.request;

  function fetchBalance(apiKey, { signal } = {}) {
    if (typeof apiKey !== "string" || !apiKey || apiKey.length > 2048
        || apiKey.trim() !== apiKey || /[\r\n\0]/.test(apiKey)) {
      return Promise.resolve({ kind: "invalid-credential-input" });
    }
    if (signal && signal.aborted) return Promise.resolve({ kind: "aborted" });
    return new Promise((resolve) => {
      let req;
      let settled = false;
      let deadline;
      function settle(result) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        resolve(result);
      }
      function terminate(kind) {
        settle({ kind });
        req?.destroy();
      }
      function abort() { terminate("aborted"); }
      try {
        req = request(DEEPSEEK_BALANCE_ENDPOINT, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          agent: false,
        }, (res) => {
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > DEFAULT_MAX_BODY_BYTES) return terminate("response-too-large");
            chunks.push(buffer);
          });
          res.on("end", () => {
            if (!settled) settle(classifyHttpResponse(Number(res.statusCode) || 0, Buffer.concat(chunks)));
          });
          res.on("error", () => settle({ kind: "network-error" }));
          res.on("aborted", () => settle({ kind: "network-error" }));
        });
        // Socket inactivity alone does not bound DNS/TLS or a trickling body.
        deadline = setTimeout(() => terminate("timeout"), DEFAULT_TIMEOUT_MS);
        req.setTimeout(DEFAULT_TIMEOUT_MS, () => terminate("timeout"));
        req.on("error", () => settle({ kind: "network-error" }));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else req.end();
      } catch {
        terminate("network-error");
      }
    });
  }
  return { fetchBalance };
}

module.exports = { DEEPSEEK_BALANCE_ENDPOINT, DEFAULT_MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS,
  classifyHttpResponse, createDeepseekBalanceClient };
