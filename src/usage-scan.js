"use strict";

// Incremental scanner for Claude Code session logs. Reads
// ~/.claude/projects/*/*.jsonl (plus subagent and workflow-subagent
// transcripts), extracts per-message token usage, dedups by message id, and
// merges into a keyed record map. Mirrors cc-switch's session_usage.rs:
// mtime-guarded incremental reads + line-offset resume + keep-best dedup.
// Pure over injected fs / records / syncState so it is fully unit-testable.

const fsDefault = require("fs");
const os = require("os");
const path = require("path");
const { parseClaudeLine } = require("./usage-log-parser");

function claudeProjectsDir(homeDir) {
  return path.join(homeDir || os.homedir(), ".claude", "projects");
}

function safeReaddir(fs, dir) { try { return fs.readdirSync(dir); } catch { return []; } }
function safeStat(fs, p) { try { return fs.statSync(p); } catch { return null; } }

function pushJsonlChildren(fs, dir, out) {
  for (const name of safeReaddir(fs, dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const p = path.join(dir, name);
    const st = safeStat(fs, p);
    if (st && st.isFile()) out.push(p);
  }
}

// projects/<proj>/*.jsonl, projects/<proj>/<session>/subagents/*.jsonl,
// projects/<proj>/<session>/subagents/workflows/wf_*/*.jsonl
function collectClaudeFiles(fs, projectsDir) {
  const out = [];
  for (const projName of safeReaddir(fs, projectsDir)) {
    const projPath = path.join(projectsDir, projName);
    const st = safeStat(fs, projPath);
    if (!st || !st.isDirectory()) continue;
    for (const child of safeReaddir(fs, projPath)) {
      const childPath = path.join(projPath, child);
      const cst = safeStat(fs, childPath);
      if (!cst) continue;
      if (cst.isFile()) { if (child.endsWith(".jsonl")) out.push(childPath); continue; }
      if (!cst.isDirectory()) continue;
      const subagents = path.join(childPath, "subagents");
      const sst = safeStat(fs, subagents);
      if (!sst || !sst.isDirectory()) continue;
      pushJsonlChildren(fs, subagents, out);
      const workflows = path.join(subagents, "workflows");
      const wst = safeStat(fs, workflows);
      if (wst && wst.isDirectory()) {
        for (const wf of safeReaddir(fs, workflows)) {
          const wfPath = path.join(workflows, wf);
          const wfst = safeStat(fs, wfPath);
          if (wfst && wfst.isDirectory()) pushJsonlChildren(fs, wfPath, out);
        }
      }
    }
  }
  return out;
}

function isoToEpoch(ts, fallback) {
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return fallback;
}

// Within a file, one message id can appear multiple times (a message_start
// snapshot then the final block). Prefer the entry with a stop_reason; else
// the larger output.
function betterParsed(a, b) {
  const aStop = a.stopReason != null, bStop = b.stopReason != null;
  if (aStop !== bStop) return aStop ? a : b;
  return a.output >= b.output ? a : b;
}

function scanClaudeFile(fs, filePath, prev) {
  const st = safeStat(fs, filePath);
  if (!st) return null;
  const mtime = st.mtimeMs || 0;
  if (prev && mtime <= prev.mtime) return { unchanged: true, mtime, offset: prev.offset, parsed: {} };
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); } catch { return null; }
  const startOffset = prev ? prev.offset : 0;
  const parsed = {};
  let lineNo = 0;
  const parts = text.split(/\r?\n/);
  // A trailing newline yields a final "" element; dropping it keeps `offset`
  // equal to the real line count, so a line appended later isn't skipped.
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  for (const rawLine of parts) {
    lineNo += 1;
    if (lineNo <= startOffset) continue;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const rec = parseClaudeLine(obj);
    if (!rec) continue;
    const existing = parsed[rec.messageId];
    parsed[rec.messageId] = existing ? betterParsed(existing, rec) : rec;
  }
  return { unchanged: false, mtime, offset: lineNo, parsed };
}

function totalTokens(r) { return r.input + r.output + r.cacheRead + r.cacheCreation; }

function scanClaudeUsage({ fs = fsDefault, homeDir = os.homedir(), records = {}, syncState = { files: {} }, now } = {}) {
  if (!syncState.files) syncState.files = {};
  const files = collectClaudeFiles(fs, claudeProjectsDir(homeDir));
  const nowEpoch = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  let imported = 0;
  for (const filePath of files) {
    const prev = syncState.files[filePath];
    const res = scanClaudeFile(fs, filePath, prev);
    if (!res) continue;
    if (!res.unchanged) {
      for (const rec of Object.values(res.parsed)) {
        const billable = rec.input > 0 || rec.output > 0 || rec.cacheRead > 0 || rec.cacheCreation > 0;
        if (!billable) continue;
        const requestId = `claude:${rec.messageId}`;
        const record = {
          ts: isoToEpoch(rec.ts, nowEpoch),
          agentId: "claude-code",
          model: rec.model,
          input: rec.input,
          output: rec.output,
          cacheRead: rec.cacheRead,
          cacheCreation: rec.cacheCreation,
          status: 200,
        };
        const existing = records[requestId];
        if (!existing || totalTokens(record) > totalTokens(existing)) {
          records[requestId] = record;
          imported += 1;
        }
      }
    }
    syncState.files[filePath] = { mtime: res.mtime, offset: res.offset };
  }
  return { records, syncState, imported };
}

module.exports = { scanClaudeUsage, collectClaudeFiles, scanClaudeFile, claudeProjectsDir };

// ── Codex ──────────────────────────────────────────────────────────────
// Codex writes ~/.codex/sessions/YYYY/MM/DD/*.jsonl (+ archived_sessions/).
// Each turn emits an event_msg `token_count` carrying CUMULATIVE totals; usage
// per turn is the saturating delta between consecutive events. Mirrors
// cc-switch's session_usage_codex.rs, minus the fork history-replay handling
// (a documented edge that can slightly over-count subagent/fork sessions).
// Codex input_tokens INCLUDES cached input, so fresh input = input - cached.

function codexSessionsDir(homeDir) {
  return path.join(homeDir || os.homedir(), ".codex", "sessions");
}
function codexArchivedDir(homeDir) {
  return path.join(homeDir || os.homedir(), ".codex", "archived_sessions");
}

function collectJsonlRecursive(fs, dir, out, depth, maxDepth) {
  for (const name of safeReaddir(fs, dir)) {
    const p = path.join(dir, name);
    const st = safeStat(fs, p);
    if (!st) continue;
    if (st.isDirectory()) {
      if (depth < maxDepth) collectJsonlRecursive(fs, p, out, depth + 1, maxDepth);
    } else if (st.isFile() && name.endsWith(".jsonl")) {
      out.push(p);
    }
  }
}

function collectCodexFiles(fs, homeDir) {
  const out = [];
  collectJsonlRecursive(fs, codexSessionsDir(homeDir), out, 0, 3);
  pushJsonlChildren(fs, codexArchivedDir(homeDir), out);
  return out;
}

// lowercase -> strip "provider/" prefix -> strip ISO / compact date suffix
function normalizeCodexModel(raw) {
  if (typeof raw !== "string" || !raw) return "unknown";
  let name = raw.toLowerCase();
  const slash = name.lastIndexOf("/");
  if (slash !== -1) name = name.slice(slash + 1);
  name = name.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  name = name.replace(/-\d{8}$/, "");
  return name || "unknown";
}

function codexCumulative(usage) {
  if (!usage || typeof usage !== "object") return null;
  const n = (v) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
  return {
    input: n(usage.input_tokens),
    cachedInput: usage.cached_input_tokens != null ? n(usage.cached_input_tokens) : n(usage.cache_read_input_tokens),
    output: n(usage.output_tokens),
  };
}

function scanCodexFile(fs, filePath, prev) {
  const st = safeStat(fs, filePath);
  if (!st) return null;
  const mtime = st.mtimeMs || 0;
  if (prev && mtime <= prev.mtime) return { unchanged: true, mtime, records: [] };
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); } catch { return null; }
  const threadId = path.basename(filePath).replace(/\.jsonl$/, "");
  let currentModel = "unknown";
  let prevTotal = null;
  let eventIndex = 0;
  const emitted = [];
  const parts = text.split(/\r?\n/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  for (const rawLine of parts) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.includes('"event_msg"') && !line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
    if (line.includes('"event_msg"') && !line.includes('"token_count"')) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    const type = value && typeof value.type === "string" ? value.type : null;
    if (type === "turn_context") {
      const payload = value.payload || {};
      const model = payload.model || (payload.info && payload.info.model);
      if (typeof model === "string") currentModel = normalizeCodexModel(model);
      continue;
    }
    if (type !== "event_msg") continue;
    const payload = value.payload;
    if (!payload || payload.type !== "token_count") continue;
    const info = payload.info;
    if (!info || typeof info !== "object") continue;
    const model = info.model || info.model_name || payload.model;
    if (typeof model === "string") currentModel = normalizeCodexModel(model);
    let cumulative; let isTotal;
    if (info.total_token_usage != null) { cumulative = codexCumulative(info.total_token_usage); isTotal = true; }
    else if (info.last_token_usage != null) { cumulative = codexCumulative(info.last_token_usage); isTotal = false; }
    else continue;
    if (!cumulative) continue;
    let delta;
    if (isTotal) {
      const p = prevTotal;
      delta = p
        ? { input: Math.max(0, cumulative.input - p.input), cachedInput: Math.max(0, cumulative.cachedInput - p.cachedInput), output: Math.max(0, cumulative.output - p.output) }
        : { input: cumulative.input, cachedInput: cumulative.cachedInput, output: cumulative.output };
      prevTotal = cumulative;
    } else {
      delta = { input: cumulative.input, cachedInput: cumulative.cachedInput, output: cumulative.output };
    }
    const cachedInput = Math.min(delta.cachedInput, delta.input);
    if (delta.input === 0 && delta.output === 0 && cachedInput === 0) continue;
    eventIndex += 1;
    emitted.push({
      requestId: `codex:${threadId}:${eventIndex}`,
      model: currentModel,
      input: Math.max(0, delta.input - cachedInput), // fresh input
      output: delta.output,
      cacheRead: cachedInput,
      ts: typeof value.timestamp === "string" ? value.timestamp : null,
    });
  }
  return { unchanged: false, mtime, records: emitted };
}

function scanCodexUsage({ fs = fsDefault, homeDir = os.homedir(), records = {}, syncState = { files: {} }, now } = {}) {
  if (!syncState.files) syncState.files = {};
  const nowEpoch = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  let imported = 0;
  for (const filePath of collectCodexFiles(fs, homeDir)) {
    const prev = syncState.files[filePath];
    const res = scanCodexFile(fs, filePath, prev);
    if (!res) continue;
    if (!res.unchanged) {
      for (const e of res.records) {
        const record = {
          ts: isoToEpoch(e.ts, nowEpoch),
          agentId: "codex",
          model: e.model,
          input: e.input,
          output: e.output,
          cacheRead: e.cacheRead,
          cacheCreation: 0,
          status: 200,
        };
        const existing = records[e.requestId];
        if (!existing || totalTokens(record) > totalTokens(existing)) {
          records[e.requestId] = record;
          imported += 1;
        }
      }
    }
    syncState.files[filePath] = { mtime: res.mtime, offset: 0 };
  }
  return { records, syncState, imported };
}

module.exports = {
  scanClaudeUsage, collectClaudeFiles, scanClaudeFile, claudeProjectsDir,
  scanCodexUsage, collectCodexFiles, scanCodexFile, normalizeCodexModel, codexSessionsDir,
};
