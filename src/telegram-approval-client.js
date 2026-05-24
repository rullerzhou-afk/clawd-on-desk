"use strict";

const http = require("http");

const APPROVAL_PATH = "/approval/request";
const MAX_RESPONSE_BYTES = 64 * 1024;

function normalizeEndpoint(endpoint) {
  if (!endpoint || typeof endpoint.listen !== "string" || !endpoint.listen.trim()) {
    throw new Error("telegram approval client requires listen address");
  }
  if (!endpoint.token || typeof endpoint.token !== "string") {
    throw new Error("telegram approval client requires bearer token");
  }
  const url = new URL(`http://${endpoint.listen}`);
  if (url.hostname !== "127.0.0.1") {
    throw new Error("telegram approval client only supports 127.0.0.1 endpoints");
  }
  return {
    origin: url.origin,
    token: endpoint.token,
  };
}

function normalizeApprovalPayload(payload) {
  const title = String((payload && payload.title) || "").trim();
  if (!title) throw new Error("telegram approval payload title is required");
  const detail = payload && payload.detail != null ? String(payload.detail) : "";
  return { title, detail };
}

function parseDecision(body) {
  let parsed;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return null;
  }
  return parsed && (parsed.decision === "allow" || parsed.decision === "deny")
    ? parsed.decision
    : null;
}

class TelegramApprovalClient {
  constructor(endpoint, options = {}) {
    const normalized = normalizeEndpoint(endpoint);
    this.origin = normalized.origin;
    this.token = normalized.token;
    this.httpRequest = options.httpRequest || http.request;
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? Math.max(0, Number(options.requestTimeoutMs))
      : 0;
  }

  isEnabled() {
    return !!(this.origin && this.token);
  }

  requestApproval(payload, options = {}) {
    let body;
    try {
      body = JSON.stringify(normalizeApprovalPayload(payload));
    } catch {
      return Promise.resolve(null);
    }
    const signal = options.signal;
    if (signal && signal.aborted) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      let settled = false;
      let req = null;

      function finish(decision) {
        if (settled) return;
        settled = true;
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        resolve(decision === "allow" || decision === "deny" ? decision : null);
      }

      function onAbort() {
        if (req && typeof req.destroy === "function") {
          req.destroy(new Error("telegram approval request aborted"));
        }
        finish(null);
      }

      const url = new URL(APPROVAL_PATH, this.origin);
      try {
        req = this.httpRequest({
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        }, (res) => {
          let chunks = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            chunks += String(chunk || "");
            if (Buffer.byteLength(chunks) > MAX_RESPONSE_BYTES && req && typeof req.destroy === "function") {
              req.destroy(new Error("telegram approval response too large"));
            }
          });
          res.on("end", () => {
            if (res.statusCode !== 200) return finish(null);
            finish(parseDecision(chunks));
          });
        });
      } catch {
        finish(null);
        return;
      }

      req.on("error", () => finish(null));
      if (this.requestTimeoutMs > 0 && typeof req.setTimeout === "function") {
        req.setTimeout(this.requestTimeoutMs, () => {
          if (typeof req.destroy === "function") req.destroy(new Error("telegram approval request timed out"));
        });
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        req.write(body);
        req.end();
      } catch {
        finish(null);
      }
    });
  }
}

module.exports = {
  TelegramApprovalClient,
  normalizeApprovalPayload,
  parseDecision,
  normalizeEndpoint,
  APPROVAL_PATH,
};
