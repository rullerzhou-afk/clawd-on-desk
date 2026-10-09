#!/usr/bin/env node
"use strict";

// Temporary, privacy-limited Claude Code hook sampler for issue #862.
//
// The sampler is deliberately separate from hooks/clawd-hook.js so a D0 capture
// can observe the raw hook event before Clawd normalizes PreToolUse(Task/Agent)
// into SubagentStart. `create-settings` writes an additive settings file for
// Claude's --settings flag; it never reads or mutates ~/.claude/settings.json.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FORMAT_VERSION = 1;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_FIELD_LENGTH = 512;
const BLOCK_STOP_REASON = "For this lifecycle test, use one harmless read-only tool once, then finish.";
const EVENTS = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
]);

function normalizeText(value, maxLength = MAX_FIELD_LENGTH) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return null;
  return trimmed.slice(0, maxLength);
}

function redactSessionId(value, salt) {
  const sessionId = normalizeText(value, 2048);
  if (!sessionId) return null;
  return crypto
    .createHash("sha256")
    .update(String(salt || ""))
    .update("\0")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
}

function buildRecord(rawEvent, payload, options = {}) {
  const safePayload = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  const monotonicNs = typeof options.monotonicNs === "bigint"
    ? options.monotonicNs
    : process.hrtime.bigint();
  return {
    format_version: FORMAT_VERSION,
    case_id: normalizeText(options.caseId, 128),
    sequence_ns: monotonicNs.toString(),
    timestamp: typeof options.timestamp === "string"
      ? options.timestamp
      : new Date().toISOString(),
    argv_event: normalizeText(rawEvent, 128),
    payload_event: normalizeText(safePayload.hook_event_name, 128),
    session: redactSessionId(safePayload.session_id, options.salt),
    agent_id: normalizeText(safePayload.agent_id),
    agent_type: normalizeText(safePayload.agent_type, 128),
    tool_name: normalizeText(safePayload.tool_name, 128),
    tool_use_id: normalizeText(
      safePayload.tool_use_id ?? safePayload.toolUseId ?? safePayload.toolUseID
    ),
    source: normalizeText(safePayload.source, 128),
    reason: normalizeText(safePayload.reason, 128),
    stop_hook_active: safePayload.stop_hook_active === true,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildSettings(options) {
  const scriptPath = path.resolve(options.scriptPath || __filename);
  const logPath = path.resolve(options.logPath);
  const caseId = normalizeText(options.caseId, 128) || "unspecified";
  const salt = normalizeText(options.salt, 256);
  if (!salt) throw new Error("A non-empty sampler salt is required");
  const nodeBin = path.resolve(options.nodeBin || process.execPath);
  const commandPrefix = [
    shellQuote(nodeBin),
    shellQuote(scriptPath),
    "record",
    "--log", shellQuote(logPath),
    "--case", shellQuote(caseId),
    "--salt", shellQuote(salt),
  ].join(" ");

  const hooks = {};
  for (const event of EVENTS) {
    // Pass the literal event as argv. A leading `NAME=value command "$NAME"`
    // would expand `$NAME` before the temporary assignment takes effect.
    const eventCommand = `${commandPrefix} --event ${shellQuote(event)}`;
    hooks[event] = [{
      matcher: "",
      hooks: [{ type: "command", command: eventCommand, timeout: 5 }],
    }];
  }
  if (options.blockStopMarker) {
    const markerPath = path.resolve(options.blockStopMarker);
    hooks.SubagentStop[0].hooks.push({
      type: "command",
      command: [
        shellQuote(nodeBin),
        shellQuote(scriptPath),
        "block-stop-once",
        "--marker", shellQuote(markerPath),
      ].join(" "),
      timeout: 5,
    });
  }
  return { hooks };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = argv[++i];
    }
  }
  return out;
}

function assertExplicitFilePath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return path.resolve(value);
}

function readStdinJson() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

function appendRecord(logPath, record, maxBytes = DEFAULT_MAX_BYTES) {
  const explicitPath = assertExplicitFilePath(logPath, "--log");
  const parent = path.dirname(explicitPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  let currentSize = 0;
  try { currentSize = fs.statSync(explicitPath).size; } catch {}
  const line = `${JSON.stringify(record)}\n`;
  if (currentSize + Buffer.byteLength(line) > maxBytes) return false;
  const fd = fs.openSync(explicitPath, "a", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, line, null, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function writeSettings(outputPath, settings) {
  const explicitPath = assertExplicitFilePath(outputPath, "--output");
  fs.mkdirSync(path.dirname(explicitPath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(explicitPath, "w", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, `${JSON.stringify(settings, null, 2)}\n`, null, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function claimBlockStopOnce(markerPath) {
  const explicitPath = assertExplicitFilePath(markerPath, "--marker");
  fs.mkdirSync(path.dirname(explicitPath), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(explicitPath, "wx", 0o600);
  } catch (error) {
    if (error && error.code === "EEXIST") return false;
    throw error;
  }
  try {
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (command === "create-settings") {
    const outputPath = assertExplicitFilePath(args.output, "--output");
    const logPath = assertExplicitFilePath(args.log, "--log");
    const salt = typeof args.salt === "string" && args.salt
      ? args.salt
      : crypto.randomBytes(16).toString("hex");
    writeSettings(outputPath, buildSettings({
      logPath,
      caseId: args.case,
      salt,
      blockStopMarker: args["block-stop-marker"],
    }));
    return;
  }

  if (command === "record") {
    const payload = await readStdinJson();
    const record = buildRecord(args.event, payload, {
      caseId: args.case,
      salt: args.salt,
    });
    appendRecord(args.log, record);
    return;
  }

  if (command === "block-stop-once") {
    await readStdinJson();
    const shouldBlock = claimBlockStopOnce(args.marker);
    process.stdout.write(shouldBlock
      ? `${JSON.stringify({ decision: "block", reason: BLOCK_STOP_REASON })}\n`
      : "{}\n");
    return;
  }

  throw new Error("Usage: create-settings --output <file> --log <file> --case <id> [--block-stop-marker <file>] | record --log <file> --case <id> --salt <salt> --event <event> | block-stop-once --marker <file>");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BLOCK_STOP_REASON,
  DEFAULT_MAX_BYTES,
  EVENTS,
  appendRecord,
  buildRecord,
  buildSettings,
  claimBlockStopOnce,
  normalizeText,
  parseArgs,
  redactSessionId,
};
