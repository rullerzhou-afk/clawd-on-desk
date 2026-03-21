#!/usr/bin/env node
/**
 * OpenClaw Bridge for Clawd on Desk
 * 
 * Monitors OpenClaw agent session files and pushes state changes
 * to the desktop pet via HTTP.
 * 
 * Usage:
 *   node bridge.js
 *   PET_HOST=192.168.1.x PET_TOKEN=secret node bridge.js
 * 
 * Environment variables:
 *   PET_HOST    - Pet server host (default: 127.0.0.1)
 *   PET_TOKEN   - Bearer token for auth (optional)
 *   SESSIONS_DIR - Override sessions directory path
 * 
 * State mapping:
 *   user message      → thinking
 *   assistant+toolCall → working
 *   toolResult        → working
 *   assistant+text    → attention
 *   compaction        → sweeping
 *   no activity 2min  → idle
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

// ── Config ──
const SESSIONS_DIR =
  process.env.SESSIONS_DIR ||
  path.join(os.homedir(), ".openclaw/agents/main/sessions");
const PET_HOST = process.env.PET_HOST || "127.0.0.1";
const PET_TOKEN = process.env.PET_TOKEN || "";
const PET_URL = `http://${PET_HOST}:23333/state`;
const POLL_INTERVAL = 500;
const IDLE_TIMEOUT = 120000;
const SESSION_ID = "openclaw-main";

// ── State ──
let currentFile = null;
let lastSize = 0;
let idleTimer = null;
let lastState = null;
let lastPostTime = 0;
const MIN_STATE_GAP = 300;

function log(msg) {
  const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function postState(state) {
  const now = Date.now();
  if (state === lastState && now - lastPostTime < 2000) return;
  if (now - lastPostTime < MIN_STATE_GAP && state !== "attention") return;

  lastState = state;
  lastPostTime = now;

  const data = JSON.stringify({ state, session_id: SESSION_ID });
  const url = new URL(PET_URL);

  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  };
  if (PET_TOKEN) headers["Authorization"] = `Bearer ${PET_TOKEN}`;

  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers,
    },
    (res) => res.resume()
  );
  req.on("error", () => {});
  req.write(data);
  req.end();

  if (idleTimer) clearTimeout(idleTimer);
  if (state !== "idle") {
    idleTimer = setTimeout(() => postState("idle"), IDLE_TIMEOUT);
  }

  log(`→ ${state}`);
}

function findActiveSession() {
  try {
    const files = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        path: path.join(SESSIONS_DIR, f),
        mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

function processNewLines() {
  if (!currentFile || !fs.existsSync(currentFile)) return;

  let stat;
  try {
    stat = fs.statSync(currentFile);
  } catch {
    return;
  }
  if (stat.size <= lastSize) return;

  const fd = fs.openSync(currentFile, "r");
  const buf = Buffer.alloc(stat.size - lastSize);
  fs.readSync(fd, buf, 0, buf.length, lastSize);
  fs.closeSync(fd);
  lastSize = stat.size;

  for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
    try {
      mapToState(JSON.parse(line));
    } catch {}
  }
}

function mapToState(entry) {
  if (entry.type === "message") {
    const role = entry.message?.role;
    const content = entry.message?.content;

    if (role === "user") {
      postState("thinking");
    } else if (role === "assistant") {
      if (Array.isArray(content)) {
        if (content.some((c) => c.type === "toolCall" || c.type === "tool_use")) {
          postState("working");
        } else if (content.some((c) => c.type === "text" && c.text?.trim())) {
          postState("attention");
        }
      } else if (typeof content === "string" && content.trim()) {
        postState("attention");
      }
    } else if (role === "toolResult") {
      postState("working");
    }
  } else if (entry.type === "compaction") {
    postState("sweeping");
  }
}

function start() {
  console.log("🦀 Clawd OpenClaw Bridge");
  console.log(`   Sessions: ${SESSIONS_DIR}`);
  console.log(`   Pet:      ${PET_URL}`);
  console.log("");

  currentFile = findActiveSession();
  if (currentFile) {
    lastSize = fs.statSync(currentFile).size;
    console.log(`   Active:   ${path.basename(currentFile)}`);
  } else {
    console.log("   No active session found, waiting...");
  }

  console.log("");

  fs.watch(SESSIONS_DIR, { persistent: true }, (_, filename) => {
    if (!filename?.endsWith(".jsonl")) return;
    const fp = path.join(SESSIONS_DIR, filename);
    if (!fs.existsSync(fp)) return;
    if (fp !== currentFile) {
      if (currentFile && fs.statSync(fp).mtimeMs <= fs.statSync(currentFile).mtimeMs) return;
      log(`session: ${filename}`);
      currentFile = fp;
      lastSize = fs.statSync(fp).size;
    }
  });

  setInterval(() => {
    const active = findActiveSession();
    if (active && active !== currentFile) {
      log(`session: ${path.basename(active)}`);
      currentFile = active;
      lastSize = fs.statSync(active).size;
    }
    processNewLines();
  }, POLL_INTERVAL);

  postState("idle");
}

start();
