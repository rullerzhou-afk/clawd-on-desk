"use strict";
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
function validateQuestions(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > 3
  )
    throw Error("Expected one to three questions");
  const seen = new Set();
  const questions = value.questions.map((q) => {
    if (
      !q ||
      typeof q.question !== "string" ||
      !q.question.trim() ||
      q.question.length > 3000 ||
      seen.has(q.question)
    )
      throw Error("Questions must have unique, nonempty text");
    seen.add(q.question);
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean")
      throw Error("Invalid multiSelect");
    if (
      q.options !== undefined &&
      (!Array.isArray(q.options) || q.options.length > 20)
    )
      throw Error("Too many options");
    const labels = new Set();
    const options = (q.options || []).map((option) => {
      const o = typeof option === "string" ? { label: option } : option;
      if (
        !o ||
        typeof o.label !== "string" ||
        !o.label.trim() ||
        o.label.length > 300 ||
        labels.has(o.label) ||
        (o.description !== undefined &&
          (typeof o.description !== "string" || o.description.length > 2000))
      )
        throw Error("Invalid question option");
      labels.add(o.label);
      return { label: o.label, description: o.description || "" };
    });
    return {
      question: q.question,
      header: typeof q.header === "string" ? q.header.slice(0, 100) : "",
      multiSelect: q.multiSelect === true,
      options,
    };
  });
  return {
    questions,
    source:
      typeof value.source === "string"
        ? value.source.replace(/[\x00-\x1f]/g, " ").slice(0, 100)
        : "MCP client",
  };
}
function collectAnswers(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length)
    throw Error("Missing answers");
  const result = {};
  questions.forEach((q, i) => {
    const answer = answers[i];
    if (
      !answer ||
      !Array.isArray(answer.selected) ||
      answer.selected.some(
        (v) => !Number.isInteger(v) || v < 0 || v >= q.options.length,
      ) ||
      new Set(answer.selected).size !== answer.selected.length ||
      (!q.multiSelect && answer.selected.length > 1) ||
      typeof answer.other !== "string" ||
      answer.other.length > 8000
    )
      throw Error("Invalid answer");
    const other = answer.other;
    if (
      (!answer.selected.length && !other.trim()) ||
      (!q.multiSelect && answer.selected.length && other.trim())
    )
      throw Error("Choose an answer or enter your own");
    Object.defineProperty(result, q.question, {
      value: [
        ...answer.selected.map((index) => q.options[index].label),
        ...(other.trim() ? [other] : []),
      ].join(", "),
      enumerable: true,
    });
  });
  return result;
}
async function createQuestionServer({
  discoveryPath,
  isEnabled,
  canShow = () => true,
  present,
  timeoutMs = 300000,
  maxPending = 4,
} = {}) {
  const token = crypto.randomBytes(32).toString("hex"),
    pending = new Set(),
    sockets = new Set();
  let closed = false;
  const server = http.createServer((req, res) => {
    const finish = (status, result) => {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      }
    };
    const supplied = req.headers.authorization || "",
      expected = "Bearer " + token;
    if (
      req.url !== "/ask" ||
      req.method !== "POST" ||
      req.headers.origin ||
      req.headers["sec-fetch-site"] ||
      typeof supplied !== "string" ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      finish(403, { status: "cancelled", reason: "unavailable" });
      return;
    }
    if (closed || !isEnabled() || !canShow() || pending.size >= maxPending) {
      finish(503, { status: "cancelled", reason: "unavailable" });
      return;
    }
    let bytes = 0,
      chunks = [];
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        finish(413, { status: "cancelled", reason: "oversize" });
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("error", () => {});
    req.on("end", () => {
      let input;
      try {
        input = validateQuestions(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
      } catch {
        finish(400, { status: "cancelled", reason: "invalid-question" });
        return;
      } finally {
        chunks = [];
      }
      if (closed || !isEnabled() || !canShow() || pending.size >= maxPending) {
        finish(503, { status: "cancelled", reason: "unavailable" });
        return;
      }
      let settled = false,
        view = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        // Window teardown must never orphan an already-settled HTTP request.
        try {
          view?.close?.();
        } catch {}
        finish(200, result);
      };
      const cancel = () =>
        settle({ status: "cancelled", reason: "unavailable" });
      pending.add(cancel);
      const timer = setTimeout(
        () => settle({ status: "cancelled", reason: "timeout" }),
        timeoutMs,
      );
      timer.unref?.();
      res.on("close", () => {
        if (!res.writableFinished) cancel();
      });
      try {
        view = present(input, {
          answer: (answers) => {
            if (!isEnabled() || !canShow()) return cancel();
            try {
              settle({
                status: "answered",
                answers: collectAnswers(input.questions, answers),
              });
            } catch {
              return false;
            }
            return true;
          },
          cancel: () =>
            settle({ status: "cancelled", reason: "user-cancelled" }),
        });
        if (settled) view?.close?.();
      } catch {
        cancel();
      }
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.maxConnections = 16;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = {
    version: 1,
    url: "http://127.0.0.1:" + server.address().port + "/ask",
    token,
    pid: process.pid,
  };
  fs.mkdirSync(path.dirname(discoveryPath), { recursive: true, mode: 0o700 });
  const temporary = discoveryPath + "." + crypto.randomUUID() + ".tmp";
  let staged = false;
  try {
    fs.writeFileSync(temporary, JSON.stringify(endpoint), {
      mode: 0o600,
      flag: "wx",
    });
    staged = true;
    fs.renameSync(temporary, discoveryPath);
  } catch (error) {
    server.close();
    for (const socket of sockets) socket.destroy();
    if (staged)
      try {
        fs.unlinkSync(temporary);
      } catch {}
    throw error;
  }
  return {
    endpoint,
    cancelPending() {
      for (const cancel of [...pending]) cancel();
    },
    async dispose() {
      closed = true;
      for (const cancel of [...pending]) cancel();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      try {
        if (JSON.parse(fs.readFileSync(discoveryPath, "utf8")).token === token)
          fs.unlinkSync(discoveryPath);
      } catch {}
    },
  };
}
module.exports = { validateQuestions, collectAnswers, createQuestionServer };
