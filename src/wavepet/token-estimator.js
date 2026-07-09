"use strict";

const READ_COMMAND_HINTS = [
  "rg ",
  "grep ",
  "find ",
  "sed ",
  "cat ",
  "ls ",
  "wc ",
  "tail ",
  "head ",
  "open ",
  "read ",
  "search ",
];
const TEST_COMMAND_HINTS = [
  "test",
  "pytest",
  "unittest",
  "vitest",
  "jest",
  "cargo test",
  "go test",
];
const EDIT_COMMAND_HINTS = ["apply_patch", "patch", "write", "edit"];

function matchesHint(text, hint) {
  if (hint.includes(" ")) {
    const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
  }

  return text.split(/[^a-z0-9]+/).includes(hint);
}

function estimateTokens(text) {
  if (typeof text !== "string" || !text) return 0;

  let ascii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
  }

  const nonAscii = text.length - ascii;
  return Math.max(1, Math.round(ascii / 4 + nonAscii / 1.8));
}

function extractCommand(argumentsValue) {
  if (
    argumentsValue &&
    typeof argumentsValue === "object" &&
    !Array.isArray(argumentsValue)
  ) {
    return String(argumentsValue.command || argumentsValue.cmd || "");
  }

  const text = String(argumentsValue || "");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return String(parsed.command || parsed.cmd || "");
    }
  } catch {}

  return text;
}

function classifyCall(toolName, command) {
  const tool = String(toolName || "").toLowerCase();
  const text = `${tool} ${command || ""}`.toLowerCase();

  if (EDIT_COMMAND_HINTS.some((hint) => matchesHint(text, hint))) return "edit";
  if (TEST_COMMAND_HINTS.some((hint) => matchesHint(text, hint))) return "test";
  if (tool.includes("web_search") || text.includes("web_search")) return "read";
  if (READ_COMMAND_HINTS.some((hint) => matchesHint(text, hint))) return "read";
  if (tool.includes("shell") || tool.includes("command") || tool.includes("exec")) {
    return "command";
  }

  return "tool";
}

function inferSuccess(output) {
  const lowered = String(output || "").toLowerCase();
  if (lowered.includes("exit code: 0")) return true;
  if (lowered.includes("exit code:")) return false;
  if (
    lowered.includes("traceback") ||
    lowered.includes("failed") ||
    lowered.includes("error:") ||
    lowered.includes("command not found") ||
    lowered.includes("permission denied") ||
    lowered.includes("no such file or directory") ||
    lowered.includes("not found")
  ) {
    return false;
  }

  return true;
}

module.exports = {
  estimateTokens,
  extractCommand,
  classifyCall,
  inferSuccess,
};
