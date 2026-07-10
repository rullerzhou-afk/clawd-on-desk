"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Hook /state payload byte-fitting.
//
// The Clawd server caps inbound /state bodies at MAX_STATE_BODY_BYTES and, when
// a body exceeds it, replies a *headerless* 413. The hook post helper only
// treats a response as delivered when it carries the Clawd header, so an
// oversized body reads back as posted=false and the turn-completion (the "happy"
// celebration) is silently dropped.
//
// The trap is a character-vs-byte mismatch: hooks clamp assistant_last_output by
// CHARACTER count (e.g. 2200 chars), but the server caps by BYTE count. One CJK
// character is 3 UTF-8 bytes, so a long Chinese/Japanese/Korean reply blows past
// a byte cap that the same text would clear in English. This helper closes the
// gap on the SEND side: it guarantees the serialized body fits a byte budget,
// sacrificing only assistant_last_output (first truncating it, then dropping it)
// so the completion + #406 gate fields always reach Clawd.
// ─────────────────────────────────────────────────────────────────────────────

// Server cap is 16 KiB (src/server-route-state.js MAX_STATE_BODY_BYTES); keep a
// 2 KiB cushion for transport overhead and future fields.
const DEFAULT_TARGET_BYTES = 14 * 1024;

// Below this much room, a truncated reply isn't worth keeping — drop it instead.
const MIN_ASSISTANT_BYTES = 64;

function utf8ByteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : String(value ?? ""), "utf8");
}

// Truncate to at most maxBytes UTF-8 bytes without splitting a multi-byte
// character. UTF-8 continuation bytes match 0b10xxxxxx (0x80–0xBF), so back the
// cut point off until it lands on a lead-byte boundary.
function truncateToUtf8Bytes(str, maxBytes) {
  if (typeof str !== "string" || !str || maxBytes <= 0) return "";
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString("utf8", 0, end);
}

// Guarantee JSON.stringify(body) fits within targetBytes. Only
// assistant_last_output is sacrificeable; every other field (state, session_id,
// event, the #406 gate counts) is preserved so the completion still registers.
//
// Returns { body, bytes, fitted, assistantTruncated, assistantDropped }:
//  - body: a new object when modified, otherwise the original (never mutated)
//  - bytes: serialized UTF-8 byte length of the returned body
//  - fitted: whether bytes <= targetBytes
//  - assistantTruncated / assistantDropped: what happened to assistant_last_output
function fitStateBodyToByteBudget(body, options = {}) {
  const targetBytes = Number.isInteger(options.targetBytes) && options.targetBytes > 0
    ? options.targetBytes
    : DEFAULT_TARGET_BYTES;

  const bytes = utf8ByteLength(JSON.stringify(body));
  if (bytes <= targetBytes) {
    return { body, bytes, fitted: true, assistantTruncated: false, assistantDropped: false };
  }

  const hasAssistant =
    body && typeof body.assistant_last_output === "string" && body.assistant_last_output.length > 0;
  if (!hasAssistant) {
    // Non-assistant fields alone exceed the budget (extremely rare). Send as-is
    // rather than corrupt structural fields; the server cushion usually absorbs it.
    return { body, bytes, fitted: false, assistantTruncated: false, assistantDropped: false };
  }

  // Measure the body WITHOUT assistant_last_output to learn the remaining room.
  const base = { ...body };
  delete base.assistant_last_output;
  delete base.assistant_last_output_truncated;
  const baseBytes = utf8ByteLength(JSON.stringify(base));

  // Reserve overhead for the JSON key, quotes, and the truncated flag. Escaping
  // (\n, \", \\) can still inflate the value, so re-measure after trimming and
  // fall back to dropping if it bounced back over budget.
  const overhead = utf8ByteLength(',"assistant_last_output":""')
    + utf8ByteLength(',"assistant_last_output_truncated":true');
  const room = targetBytes - baseBytes - overhead;

  if (room >= MIN_ASSISTANT_BYTES) {
    const trimmed = truncateToUtf8Bytes(body.assistant_last_output, room);
    if (trimmed) {
      const next = { ...body, assistant_last_output: trimmed, assistant_last_output_truncated: true };
      const nextBytes = utf8ByteLength(JSON.stringify(next));
      if (nextBytes <= targetBytes) {
        return {
          body: next,
          bytes: nextBytes,
          fitted: true,
          assistantTruncated: true,
          assistantDropped: false,
        };
      }
    }
  }

  // Even a trimmed copy won't fit (or there's no usable room): drop it entirely.
  return {
    body: base,
    bytes: baseBytes,
    fitted: baseBytes <= targetBytes,
    assistantTruncated: false,
    assistantDropped: true,
  };
}

module.exports = {
  DEFAULT_TARGET_BYTES,
  MIN_ASSISTANT_BYTES,
  utf8ByteLength,
  truncateToUtf8Bytes,
  fitStateBodyToByteBudget,
};
