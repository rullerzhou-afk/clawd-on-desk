"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { readAgentCredential, readAllCredentials, revealAgentToken } = require("../src/credential-reader");
const { getCredentialSources } = require("../src/credential-sources");

// In-memory fs stub: map of absolute path -> file contents.
function makeFs(files) {
  return {
    readFileSync(p) {
      const key = path.resolve(p);
      if (Object.prototype.hasOwnProperty.call(files, key)) return files[key];
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
  };
}

const HOME = path.resolve("/fake/home");
const src = (id) => getCredentialSources().find((s) => s.agentId === id);

test("reads claude-code token + base url from settings.json env", () => {
  const fs = makeFs({
    [path.join(HOME, ".claude", "settings.json")]: JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-abcdef123456", ANTHROPIC_BASE_URL: "https://api.anthropic/v1/" },
    }),
  });
  const r = readAgentCredential(src("claude-code"), { fs, homeDir: HOME });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.token, "sk-ant-abcdef123456");
  assert.strictEqual(r.tokenMasked, "sk-a…3456");
  assert.strictEqual(r.baseUrl, "https://api.anthropic/v1");
  assert.strictEqual(r.sourcePath, path.join(HOME, ".claude", "settings.json"));
});

test("codex merges token from auth.json and base url from config.toml", () => {
  const fs = makeFs({
    [path.join(HOME, ".codex", "auth.json")]: JSON.stringify({ OPENAI_API_KEY: "sk-codex-987654321" }),
    [path.join(HOME, ".codex", "config.toml")]: 'base_url = "https://codex.host/v1"\n',
  });
  const r = readAgentCredential(src("codex"), { fs, homeDir: HOME });
  assert.strictEqual(r.token, "sk-codex-987654321");
  assert.strictEqual(r.baseUrl, "https://codex.host/v1");
});

test("gemini reads dotenv and prefers GEMINI_API_KEY over GOOGLE_API_KEY", () => {
  const fs = makeFs({
    [path.join(HOME, ".gemini", ".env")]:
      "GOOGLE_API_KEY=google-fallback\nGEMINI_API_KEY=gem-primary-123456\nGOOGLE_GEMINI_BASE_URL=https://gem/v1",
  });
  const r = readAgentCredential(src("gemini-cli"), { fs, homeDir: HOME });
  assert.strictEqual(r.token, "gem-primary-123456");
  assert.strictEqual(r.baseUrl, "https://gem/v1");
});

test("opencode reads nested provider.options.apiKey with env ref", () => {
  const fs = makeFs({
    [path.join(HOME, ".config", "opencode", "opencode.json")]: JSON.stringify({
      provider: { myapi: { options: { apiKey: "{env:OC_KEY}", baseURL: "https://oc/v1" } } },
    }),
  });
  const r = readAgentCredential(src("opencode"), { fs, homeDir: HOME, env: { OC_KEY: "resolved-oc-key-1234" } });
  assert.strictEqual(r.token, "resolved-oc-key-1234");
  assert.strictEqual(r.baseUrl, "https://oc/v1");
});

test("reads claude-code token despite a UTF-8 BOM", () => {
  const fs = makeFs({
    [path.join(HOME, ".claude", "settings.json")]:
      "﻿" + JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-bomtest-1234" } }),
  });
  const r = readAgentCredential(src("claude-code"), { fs, homeDir: HOME });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.token, "sk-ant-bomtest-1234");
  assert.strictEqual(r.error, null);
});

test("missing file yields found:false, no error", () => {
  const r = readAgentCredential(src("hermes"), { fs: makeFs({}), homeDir: HOME });
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.token, null);
  assert.strictEqual(r.error, null);
});

test("malformed JSON yields found:false with an error string", () => {
  const fs = makeFs({ [path.join(HOME, ".openclaw", "openclaw.json")]: "{ not json" });
  const r = readAgentCredential(src("openclaw"), { fs, homeDir: HOME });
  assert.strictEqual(r.found, false);
  assert.ok(typeof r.error === "string" && r.error.length > 0);
});

test("reads model from claude settings.json env", () => {
  const fs = makeFs({
    [path.join(HOME, ".claude", "settings.json")]: JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-modeltest12", ANTHROPIC_MODEL: "claude-opus-4-8" },
    }),
  });
  const r = readAgentCredential(src("claude-code"), { fs, homeDir: HOME });
  assert.strictEqual(r.model, "claude-opus-4-8");
});

test("reads model from codex config.toml alongside auth.json token", () => {
  const fs = makeFs({
    [path.join(HOME, ".codex", "auth.json")]: JSON.stringify({ OPENAI_API_KEY: "sk-codex-123456789" }),
    [path.join(HOME, ".codex", "config.toml")]: 'model = "gpt-5-codex"\nbase_url = "https://x/v1"\n',
  });
  const r = readAgentCredential(src("codex"), { fs, homeDir: HOME });
  assert.strictEqual(r.model, "gpt-5-codex");
});

test("reads model from opencode provider entry", () => {
  const fs = makeFs({
    [path.join(HOME, ".config", "opencode", "opencode.json")]: JSON.stringify({
      provider: { myapi: { model: "gpt-4o", options: { apiKey: "sk-oc-1234567", baseURL: "https://oc/v1" } } },
    }),
  });
  const r = readAgentCredential(src("opencode"), { fs, homeDir: HOME });
  assert.strictEqual(r.model, "gpt-4o");
});

test("readAllCredentials never leaks raw token", () => {
  const fs = makeFs({
    [path.join(HOME, ".claude", "settings.json")]: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-secret-999999" } }),
  });
  const rows = readAllCredentials({ fs, homeDir: HOME });
  const claude = rows.find((x) => x.agentId === "claude-code");
  assert.strictEqual(claude.hasToken, true);
  assert.strictEqual(claude.tokenMasked, "sk-a…9999");
  assert.strictEqual("token" in claude, false);
});

test("revealAgentToken returns the raw token for one agent", () => {
  const fs = makeFs({
    [path.join(HOME, ".claude", "settings.json")]: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-secret-999999" } }),
  });
  const r = revealAgentToken("claude-code", { fs, homeDir: HOME });
  assert.strictEqual(r.token, "sk-ant-secret-999999");
  assert.strictEqual(r.found, true);
  assert.strictEqual(revealAgentToken("no-such-agent", { fs, homeDir: HOME }).found, false);
});
