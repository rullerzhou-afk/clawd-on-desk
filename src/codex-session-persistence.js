"use strict";

const { normalizeCodexThreadId, decodeSessionKeyRawId } = require("./codex-thread-id");
const { isCodexCliOriginator } = require("../hooks/codex-originator");
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const ROLLOUT_TAIL = new RegExp(`^${UUID}(?:_${UUID})?\\.jsonl$`, "i");
function isPersistedCodexTranscript(value, sessionId) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f\ufffd]/.test(value)) return false;
  const text = value.trim().replace(/\\/g, "/");
  const filename = text.split("/").at(-1);
  if (!/^(?:[a-z]:\/|\/)/i.test(text) || !filename.startsWith("rollout-")) return false;
  const match = filename.match(new RegExp(UUID, "i"));
  const expected = normalizeCodexThreadId(decodeSessionKeyRawId(sessionId) || sessionId);
  return !!match && !!expected && ROLLOUT_TAIL.test(filename.slice(match.index))
    && match[1].toLowerCase() === expected.toLowerCase();
}

// Focus metadata is not hidden-thread authorization. Missing/false without
// positive persistence evidence cannot erase a prior ephemeral observation.
function readCodexClientEphemeral(data, localOfficial) {
  if (!localOfficial || !data || typeof data.codex_client_ephemeral !== "boolean") return undefined;
  const source = typeof data.codex_source === "string" ? data.codex_source.trim().toLowerCase() : "";
  if (data.codex_client_ephemeral === true && (isCodexCliOriginator(data.codex_originator || data.originator)
    || ["cli", "exec", "mcp"].includes(source))) return undefined;
  if (isPersistedCodexTranscript(data.transcript_path, data.session_id)) return data.codex_client_ephemeral === false ? false : undefined;
  if (typeof data.transcript_path === "string" && data.transcript_path.trim()) return undefined;
  return data.codex_client_ephemeral === true ? true : undefined;
}

function mergeCodexClientEphemeral(existing, opts = {}) {
  if (opts.agentId !== "codex" || (opts.profileId || "local") !== "local" || opts.host || opts.wslDistro) {
    return existing && existing.codexClientEphemeral;
  }
  const rawId = opts.rawSessionId || (existing && existing.rawSessionId);
  if (existing && existing.codexClientEphemeral === false) return false;
  if (opts.hookSource === "codex-official" && isPersistedCodexTranscript(opts.transcriptPath, rawId)) return false;
  if (opts.hookSource === "codex-official" && opts.codexClientEphemeral === true) return true;
  return existing && existing.codexClientEphemeral;
}

module.exports = { readCodexClientEphemeral, mergeCodexClientEphemeral, isPersistedCodexTranscript };
