#!/usr/bin/env node
// Phase 0 Codex official-hooks sampler.
//
// This hook intentionally does not talk to Clawd's runtime server and writes
// nothing to stdout. For PermissionRequest, empty stdout means "no hook
// decision" in current Codex source, so Codex can continue its native flow.

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_LOG_PATH = path.join(os.homedir(), ".clawd", "codex-hook-debug.jsonl");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    const timer = setTimeout(finish, 400);
  });
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return null;
  // A PowerShell/.NET intermediary can prefix the payload with a UTF-8 BOM
  // (#638), which JSON.parse rejects.
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildDebugEntry(raw, now = new Date()) {
  const payload = parsePayload(raw);
  const source = payload && typeof payload === "object" ? payload : {};
  const toolInput = source.tool_input && typeof source.tool_input === "object" && !Array.isArray(source.tool_input)
    ? source.tool_input
    : null;
  return {
    captured_at: now.toISOString(),
    hook_event_name: typeof source.hook_event_name === "string" ? source.hook_event_name : null,
    session_id: typeof source.session_id === "string" ? source.session_id : null,
    turn_id: typeof source.turn_id === "string" ? source.turn_id : null,
    cwd: typeof source.cwd === "string" ? source.cwd : null,
    transcript_path: typeof source.transcript_path === "string" ? source.transcript_path : null,
    permission_mode: typeof source.permission_mode === "string" ? source.permission_mode : null,
    source: typeof source.source === "string" ? source.source : null,
    stop_hook_active: typeof source.stop_hook_active === "boolean" ? source.stop_hook_active : null,
    tool_name: typeof source.tool_name === "string" ? source.tool_name : null,
    tool_input_description: toolInput && typeof toolInput.description === "string"
      ? toolInput.description
      : null,
    tool_input_keys: toolInput ? Object.keys(toolInput).sort() : null,
    parse_ok: !!payload,
    payload: payload || raw,
  };
}

function appendDebugEntry(entry, logPath = process.env.CLAWD_CODEX_DEBUG_LOG || DEFAULT_LOG_PATH) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  return logPath;
}

async function main() {
  try {
    const raw = await readStdin();
    appendDebugEntry(buildDebugEntry(raw));
  } catch {
    // Phase 0 hook must never block or decide for Codex if sampling fails.
  }
}

if (require.main === module) {
  main().finally(() => process.exit(0));
}

module.exports = {
  DEFAULT_LOG_PATH,
  appendDebugEntry,
  buildDebugEntry,
  parsePayload,
};
