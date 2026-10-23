"use strict";
// Ordinary MCP questions only. Never connects to /permission or returns a tool approval.
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http"),
  readline = require("node:readline");
function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const discoveryPath = option(
  "--endpoint",
  path.join(
    process.env.APPDATA || path.join(os.homedir(), ".config"),
    "clawd-on-desk",
    "desktop-integrations",
    "questions.json",
  ),
);
const source = option("--source", "MCP client"),
  pending = new Map();
const instructions =
  "Use ask_user for ordinary clarification questions, choices and confirmations. Preserve all questions/options, multiSelect and custom input. Wait for actual answers. Cancellation, timeout and unavailable transport are never consent: use the host's native question interface. Security approvals, sandbox escalation, credentials and account permissions must remain in their original trusted flow.";
const optionSchema = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      required: ["label"],
      properties: {
        label: { type: "string" },
        description: { type: "string" },
      },
    },
  ],
};
const questionSchema = {
  type: "object",
  required: ["question"],
  properties: {
    question: { type: "string" },
    header: { type: "string" },
    multiSelect: { type: "boolean" },
    options: { type: "array", maxItems: 20, items: optionSchema },
  },
};
const tool = {
  name: "ask_user",
  description: instructions,
  inputSchema: {
    type: "object",
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: questionSchema,
      },
    },
  },
};
function ask(
  questions,
  {
    signal,
    endpointFile = discoveryPath,
    sourceName = source,
    timeoutMs = 310000,
  } = {},
) {
  return new Promise((resolve) => {
    if (signal?.aborted)
      return resolve({ status: "cancelled", reason: "aborted" });
    let config, url;
    try {
      config = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
      url = new URL(config.url);
      if (
        config.version !== 1 ||
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.pathname !== "/ask" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        !/^\d+$/.test(url.port) ||
        !/^[a-f0-9]{64}$/.test(config.token)
      )
        throw Error();
    } catch {
      return resolve({ status: "cancelled", reason: "bridge-unavailable" });
    }
    const body = JSON.stringify({ questions, source: sourceName });
    if (Buffer.byteLength(body) > 65536)
      return resolve({ status: "cancelled", reason: "oversize" });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + config.token,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let bytes = 0,
          chunks = [];
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) {
            req.destroy();
            finish({ status: "cancelled", reason: "invalid-response" });
          } else chunks.push(chunk);
        });
        res.on("error", () =>
          finish({ status: "cancelled", reason: "bridge-unavailable" }),
        );
        res.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (
              res.statusCode !== 200 ||
              !["answered", "cancelled"].includes(result.status) ||
              (result.status === "answered" &&
                (!result.answers ||
                  questions.some(
                    (q) => typeof result.answers[q.question] !== "string",
                  )))
            )
              throw Error();
            finish(result);
          } catch {
            finish({ status: "cancelled", reason: "bridge-unavailable" });
          }
        });
      },
    );
    const abort = () => {
      req.destroy();
      finish({ status: "cancelled", reason: "aborted" });
    };
    signal?.addEventListener("abort", abort, { once: true });
    req.on("timeout", () => {
      req.destroy();
      finish({ status: "cancelled", reason: "timeout" });
    });
    req.on("error", () =>
      finish({ status: "cancelled", reason: "bridge-unavailable" }),
    );
    if (signal?.aborted) return abort();
    req.end(body);
  });
}
function serve() {
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("close", () => {
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  });
  lines.on("line", async (line) => {
    if (Buffer.byteLength(line) > 65536) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (request.id === undefined) {
      if (request.method === "notifications/cancelled")
        pending.get(request.params?.requestId)?.abort();
      return;
    }
    try {
      let result;
      if (request.method === "initialize")
        result = {
          protocolVersion: request.params?.protocolVersion || "2024-11-05",
          serverInfo: { name: "clawd_questions", version: "3.0.0" },
          capabilities: { tools: {} },
          instructions,
        };
      else if (request.method === "ping") result = {};
      else if (request.method === "tools/list") result = { tools: [tool] };
      else if (
        request.method === "tools/call" &&
        request.params?.name === "ask_user"
      ) {
        const questions = request.params.arguments?.questions;
        if (
          !Array.isArray(questions) ||
          !questions.length ||
          questions.length > 3
        )
          throw Error("Expected one to three questions");
        if (pending.has(request.id) || pending.size >= 4)
          throw Error("Too many pending questions");
        const controller = new AbortController();
        pending.set(request.id, controller);
        const answer = await ask(questions, { signal: controller.signal });
        pending.delete(request.id);
        result = {
          content: [{ type: "text", text: JSON.stringify(answer) }],
          isError: answer.status !== "answered",
        };
      } else
        return send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Unknown method or tool" },
        });
      send({ jsonrpc: "2.0", id: request.id, result });
    } catch {
      pending.delete(request.id);
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: "Invalid question request" },
      });
    }
  });
}
if (require.main === module) serve();
module.exports = { ask, serve };
