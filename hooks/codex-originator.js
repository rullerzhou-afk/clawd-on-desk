"use strict";

// Observed on 2026-07-19: the last sampled legacy value was "codex desktop"
// in Codex 0.142.0, and the first sampled current value was
// "codex_work_desktop" in 0.144.2; the exact switch version is unconfirmed.
// Keep this allowlist narrow. Unknown Codex originators must retain the
// conservative same-process ghost dedupe instead of being guessed as Desktop.
const CODEX_DESKTOP_ORIGINATORS = new Set([
  "codex desktop",
  "codex_work_desktop",
]);
const CODEX_CLI_ORIGINATORS = new Set([
  "codex-tui",
  "codex_cli_rs",
]);
const CODEX_DEFAULT_SESSION_ID = "default";
const CODEX_PLACEHOLDER_SESSION_IDS = Object.freeze([
  CODEX_DEFAULT_SESSION_ID,
  "codex:",
  `codex:${CODEX_DEFAULT_SESSION_ID}`,
]);
const CODEX_PLACEHOLDER_SESSION_ID_SET = new Set(CODEX_PLACEHOLDER_SESSION_IDS);

function normalizeCodexOriginator(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isCodexDesktopOriginator(value) {
  return CODEX_DESKTOP_ORIGINATORS.has(normalizeCodexOriginator(value));
}

function isCodexCliOriginator(value) {
  return CODEX_CLI_ORIGINATORS.has(normalizeCodexOriginator(value));
}

function isCodexPlaceholderSessionId(value) {
  if (typeof value !== "string") return false;
  return CODEX_PLACEHOLDER_SESSION_ID_SET.has(value.trim().toLowerCase());
}

module.exports = {
  CODEX_DEFAULT_SESSION_ID,
  CODEX_PLACEHOLDER_SESSION_IDS,
  isCodexCliOriginator,
  isCodexDesktopOriginator,
  isCodexPlaceholderSessionId,
};
