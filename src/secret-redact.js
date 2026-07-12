"use strict";

// Redact common secret shapes from text that is about to leave the desktop for
// a remote approval channel (Telegram, Feishu). Shared by the desktop approval
// summary builder (permission.js) and the channel renderers so that an agent
// which quotes a key in a permission summary OR an elicitation question/option
// can't leak it into a remote chat log.
//
// Rendering-layer only: callers apply this to the *displayed* string, never to
// the value used as an answer-map key, so redaction can't desync answer
// round-tripping.
//
// Best-effort, HIGH-CONFIDENCE display safety net — deliberately NOT a complete
// secret scanner. It redacts shapes that are almost always secrets (provider
// token prefixes, Authorization headers, secret-named key=value pairs). It does
// not chase completeness: a blacklist that tries to catch every secret both
// misses exotic shapes AND mis-redacts ordinary prose (e.g. "basic
// authentication"), which is worse for a permission summary. It is a safety
// net, not a license to route real secrets through a chat channel.
function redactSecrets(value) {
  let text = typeof value === "string" ? value : String(value == null ? "" : value);
  // Telegram bot token (digits:base64-ish).
  text = text.replace(/\b\d+:[A-Za-z0-9_-]{20,}\b/g, "<redacted:telegram-token>");
  // Authorization / Proxy-Authorization header: whole scheme + credential. This
  // is the ONLY place Bearer/Basic is redacted, so a bare "the bearer" / "basic
  // auth" in ordinary prose is never touched.
  text = text.replace(/\b(?:proxy-)?authorization\b\s*[:=]\s*[^\r\n]*/gi, "authorization=<redacted>");
  // High-confidence provider token shapes (explicit prefixes only).
  text = text.replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}\b/g, "<redacted:token>");
  text = text.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "<redacted:token>");
  text = text.replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "<redacted:token>");
  text = text.replace(/\bglpat-[A-Za-z0-9_-]{16,}\b/g, "<redacted:token>");
  text = text.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "<redacted:token>");
  text = text.replace(/\bAKIA[A-Z0-9]{12,}\b/g, "<redacted:token>");
  // Secret-named key with a value: KEY=val, key: val, "key":"val", KEY='val'.
  // The value may be single- or double-quoted (escapes handled) or bare. Two
  // shapes, both fail-safe against ordinary text:
  //  (a) an exact secret key ON A WORD BOUNDARY — no arbitrary prefix, so
  //      "favorite_cookie" / "my_token" ordinary config is left intact;
  //  (b) an ALL-UPPERCASE env var with any prefix (ANTHROPIC_API_KEY, GITHUB_TOKEN).
  text = text.replace(
    /\b(api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?token|private[_-]?key|client[_-]?secret|password|passwd|secret|token|cookie)"?\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"',;}{]+)/gi,
    "$1=<redacted>",
  );
  text = text.replace(
    /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|ACCESS_KEY|SECRET_ACCESS_KEY|SECRET_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|API_TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET|COOKIE|CREDENTIALS?))"?\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"',;}{]+)/g,
    "$1=<redacted>",
  );
  // General long numeric IDs.
  text = text.replace(/\b(?:telegram:)?-?\d{7,}(?::\d+){0,2}\b/g, "<redacted:id>");
  return text;
}

module.exports = { redactSecrets };
