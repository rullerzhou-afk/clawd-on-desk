#!/usr/bin/env node
"use strict";

// Bridge an ntfy topic to Clawd's custom HTTP agent /state endpoint.
//
// Agents on a server or remote desktop cannot reach Clawd's loopback port, but
// they can publish to ntfy. This script runs next to Clawd, subscribes to the
// topic, and forwards lifecycle messages as state events. It is state-only:
// permission decisions stay in the agent's own UI (see custom-agent-http.md).
//
//   node scripts/ntfy-bridge.js --topic my-agents --agent-id custom-nova-ai-0123456789ab
//
// Sender side (any agent hook), tags carry the state:
//   curl -H "Tags: clawd-working" -d "PreToolUse" https://ntfy.sh/my-agents
// Optional tags: clawd-session-<id>, clawd-event-<Event>. Messages without a
// clawd-<state> tag are ignored so the topic can carry other traffic.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const STATES = new Set([
  "idle", "thinking", "working", "juggling", "error", "attention", "notification",
]);
const DEFAULT_EVENTS = {
  idle: "SessionStart",
  thinking: "UserPromptSubmit",
  working: "PreToolUse",
  juggling: "SubagentStart",
  error: "PostToolUseFailure",
  attention: "Stop",
  notification: "Notification",
};
const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_SERVER = "https://ntfy.sh";
const MAX_LINE_BYTES = 64 * 1024;

// Map one ntfy message to a Clawd /state body, or null when it is not ours.
function messageToState(msg, agentId) {
  if (!msg || msg.event !== "message" || !Array.isArray(msg.tags)) return null;
  let state = null;
  let session = null;
  let event = null;
  for (const raw of msg.tags) {
    const tag = String(raw);
    if (!tag.startsWith("clawd-")) continue;
    const rest = tag.slice("clawd-".length);
    if (rest.startsWith("session-")) {
      const v = rest.slice("session-".length);
      if (SAFE_TOKEN.test(v)) session = v;
    } else if (rest.startsWith("event-")) {
      const v = rest.slice("event-".length);
      if (SAFE_TOKEN.test(v)) event = v;
    } else if (STATES.has(rest) && !state) {
      state = rest;
    }
  }
  if (!state) return null;
  return {
    agent_id: agentId,
    session_id: session || String(msg.topic || "ntfy"),
    state,
    event: event || DEFAULT_EVENTS[state],
  };
}

function readRuntimePort(homeDir = os.homedir()) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(homeDir, ".clawd", "runtime.json"), "utf8"));
    if (r && r.app === "clawd-on-desk" && Number.isInteger(r.port) && r.port > 0) return r.port;
  } catch {}
  return null;
}

function postState(port, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1", port, path: "/state", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
      timeout: 3000,
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", () => resolve(0));
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.end(data);
  });
}

// Split a streamed body into complete lines; the tail stays buffered.
function createLineSplitter(onLine) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
    if (buf.length > MAX_LINE_BYTES) buf = "";
  };
}

function parseArgs(argv, env = process.env) {
  const opts = {
    server: env.NTFY_SERVER || DEFAULT_SERVER,
    topic: env.NTFY_TOPIC || "",
    agentId: env.CLAWD_AGENT_ID || "",
    token: env.NTFY_TOKEN || "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") opts.server = argv[++i];
    else if (a === "--topic") opts.topic = argv[++i];
    else if (a === "--agent-id") opts.agentId = argv[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function validateOptions(opts) {
  if (!opts.topic || !/^[A-Za-z0-9_-]{1,64}$/.test(opts.topic)) return "a valid --topic is required";
  if (!opts.agentId) return "--agent-id is required (register a custom agent in Settings first)";
  let url;
  try { url = new URL(opts.server); } catch { return "--server must be an http(s) URL"; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "--server must be an http(s) URL";
  return null;
}

async function run(opts, { fetchImpl = fetch, log = console.log, signal } = {}) {
  let since = "0s";
  let delay = 1000;
  const base = opts.server.replace(/\/+$/, "");
  while (!signal || !signal.aborted) {
    try {
      const headers = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
      const res = await fetchImpl(`${base}/${opts.topic}/json?since=${encodeURIComponent(since)}`, { headers, signal });
      if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
      delay = 1000;
      const decoder = new TextDecoder();
      const split = createLineSplitter(async (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg && msg.id) since = msg.id;
        const body = messageToState(msg, opts.agentId);
        if (!body) return;
        const port = readRuntimePort();
        if (!port) return log("clawd is offline, dropping event");
        const status = await postState(port, body);
        if (status !== 200) log(`clawd /state returned ${status || "no response"} for ${body.state}`);
      });
      for await (const chunk of res.body) split(decoder.decode(chunk, { stream: true }));
    } catch (err) {
      if (signal && signal.aborted) return;
      log(`ntfy stream error: ${err.message}; retrying in ${delay}ms`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30000);
  }
}

module.exports = { messageToState, createLineSplitter, parseArgs, validateOptions, readRuntimePort, run };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const err = opts.help ? "usage: ntfy-bridge --topic <t> --agent-id <id> [--server <url>] (NTFY_TOKEN for auth)" : validateOptions(opts);
  if (err) { console.error(err); process.exit(opts.help ? 0 : 2); }
  run(opts);
}
