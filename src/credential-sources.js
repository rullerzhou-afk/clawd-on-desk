"use strict";

// Read-only map of where each AI platform stores its plaintext API token and
// base URL. Mirrors cc-switch's per-provider credential extraction, adapted to
// Clawd's agents. Paths are home-relative `segments` (rebased onto an injected
// homeDir by the reader) except env-overridable homes, which use `resolve()`.
//
// The reader tries `candidates` in order and merges: first non-empty token
// wins, first non-empty base URL wins. That covers codex (token in auth.json,
// base URL in config.toml) and any fallback file without special-casing.

const os = require("os");
const path = require("path");

function hermesConfigPath(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.homeDir || os.homedir();
  if (typeof env.HERMES_HOME === "string" && env.HERMES_HOME.trim()) {
    return path.join(path.resolve(env.HERMES_HOME), "config.yaml");
  }
  if ((opts.platform || process.platform) === "win32"
      && typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim()) {
    return path.join(env.LOCALAPPDATA, "hermes", "config.yaml");
  }
  return path.join(home, ".hermes", "config.yaml");
}

const CREDENTIAL_SOURCES = Object.freeze([
  Object.freeze({
    agentId: "claude-code",
    agentName: "Claude Code",
    candidates: Object.freeze([
      Object.freeze({
        segments: Object.freeze([".claude", "settings.json"]),
        format: "json-env",
        tokenKeys: Object.freeze(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]),
        baseUrlKey: "ANTHROPIC_BASE_URL",
        modelKey: "ANTHROPIC_MODEL",
      }),
    ]),
  }),
  Object.freeze({
    agentId: "codex",
    agentName: "Codex CLI",
    candidates: Object.freeze([
      Object.freeze({
        segments: Object.freeze([".codex", "auth.json"]),
        format: "json-flat",
        tokenKeys: Object.freeze(["OPENAI_API_KEY"]),
      }),
      Object.freeze({
        segments: Object.freeze([".codex", "config.toml"]),
        format: "toml-scalar",
        baseUrlKey: "base_url",
        modelKey: "model",
      }),
    ]),
  }),
  Object.freeze({
    agentId: "gemini-cli",
    agentName: "Gemini CLI",
    candidates: Object.freeze([
      Object.freeze({
        segments: Object.freeze([".gemini", ".env"]),
        format: "dotenv",
        tokenKeys: Object.freeze(["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
        baseUrlKey: "GOOGLE_GEMINI_BASE_URL",
        modelKey: "GEMINI_MODEL",
      }),
    ]),
  }),
  Object.freeze({
    agentId: "qwen-code",
    agentName: "Qwen Code",
    candidates: Object.freeze([
      Object.freeze({
        segments: Object.freeze([".qwen", ".env"]),
        format: "dotenv",
        tokenKeys: Object.freeze(["OPENAI_API_KEY", "QWEN_API_KEY"]),
        baseUrlKey: "OPENAI_BASE_URL",
        modelKey: "OPENAI_MODEL",
      }),
    ]),
  }),
  Object.freeze({
    agentId: "openclaw",
    agentName: "OpenClaw",
    candidates: Object.freeze([
      Object.freeze({
        segments: Object.freeze([".openclaw", "openclaw.json"]),
        format: "json-flat",
        tokenKeys: Object.freeze(["apiKey"]),
        baseUrlKey: "baseUrl",
        modelKey: "model",
      }),
    ]),
  }),
  Object.freeze({
    agentId: "opencode",
    agentName: "opencode",
    candidates: Object.freeze([
      Object.freeze({
        segments: Object.freeze([".config", "opencode", "opencode.json"]),
        format: "json-provider",
      }),
    ]),
  }),
  Object.freeze({
    agentId: "hermes",
    agentName: "Hermes Agent",
    candidates: Object.freeze([
      Object.freeze({
        resolve: hermesConfigPath,
        format: "yaml-scalar",
        tokenKeys: Object.freeze(["api_key"]),
        baseUrlKey: "base_url",
        modelKey: "model",
      }),
    ]),
  }),
]);

function getCredentialSources() {
  return CREDENTIAL_SOURCES.map((s) => ({ ...s }));
}

module.exports = { CREDENTIAL_SOURCES, getCredentialSources, hermesConfigPath };
