"use strict";

// Read-only credential reader. Resolves each platform's config path against an
// injectable homeDir, parses by format, extracts the first non-empty token and
// base URL, and masks the token. NEVER writes platform config; NEVER logs
// tokens. `readAllCredentials` returns masked-only rows; `revealAgentToken` is
// the single explicit path that returns a raw token.

const fsDefault = require("fs");
const os = require("os");
const path = require("path");
const { parse: parseJsoncRaw } = require("jsonc-parser");

const { getCredentialSources } = require("./credential-sources");
const {
  parseDotenv,
  firstNonEmpty,
  extractTomlScalar,
  extractYamlScalar,
  extractFromProviderJson,
  resolveEnvRef,
  normalizeBaseUrl,
  maskToken,
} = require("./credential-parsers");

// jsonc-parser is tolerant: it never throws on malformed input, reporting
// problems via an out-param errors array instead. Surface that as a thrown
// error so the extract try/catch treats a corrupt config as a parse failure.
function parseJsonc(text) {
  const errors = [];
  const value = parseJsoncRaw(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error("invalid JSON");
  return value;
}

function normalizeOpts(opts = {}) {
  return {
    fs: opts.fs || fsDefault,
    homeDir: opts.homeDir || os.homedir(),
    env: opts.env || process.env,
    platform: opts.platform || process.platform,
  };
}

function candidatePath(candidate, o) {
  if (typeof candidate.resolve === "function") {
    return candidate.resolve({ homeDir: o.homeDir, env: o.env, platform: o.platform });
  }
  return path.join(o.homeDir, ...candidate.segments);
}

function readText(o, filePath) {
  try {
    // Strip a leading UTF-8 BOM: fs does not remove it and jsonc-parser flags
    // it as a parse error, which would make a valid BOM-saved config (common
    // from PowerShell Out-File on Windows) read as unreadable.
    let raw = o.fs.readFileSync(filePath, "utf8");
    if (typeof raw === "string" && raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return { text: raw, missing: false };
  } catch (err) {
    if (err && err.code === "ENOENT") return { text: null, missing: true };
    return { text: null, missing: false, error: err && err.message ? err.message : String(err) };
  }
}

// Returns { token, baseUrl, error } for one candidate file. token/baseUrl are
// null when absent; error is null unless parsing failed on a present file.
function extractCandidate(candidate, text, o) {
  try {
    switch (candidate.format) {
      case "json-env": {
        const obj = parseJsonc(text) || {};
        const env = obj.env && typeof obj.env === "object" ? obj.env : {};
        return {
          token: firstNonEmpty(env, candidate.tokenKeys || []),
          baseUrl: candidate.baseUrlKey ? normalizeBaseUrl(env[candidate.baseUrlKey]) : null,
          model: candidate.modelKey ? firstNonEmpty(env, [candidate.modelKey]) : null,
          error: null,
        };
      }
      case "json-flat": {
        const obj = parseJsonc(text) || {};
        return {
          token: firstNonEmpty(obj, candidate.tokenKeys || []),
          baseUrl: candidate.baseUrlKey ? normalizeBaseUrl(obj[candidate.baseUrlKey]) : null,
          model: candidate.modelKey ? firstNonEmpty(obj, [candidate.modelKey]) : null,
          error: null,
        };
      }
      case "json-provider": {
        const obj = parseJsonc(text) || {};
        const { token, baseUrl } = extractFromProviderJson(obj, {});
        const providers = obj && obj.provider && typeof obj.provider === "object" ? obj.provider : {};
        const firstName = Object.keys(providers)[0];
        const model = firstName && providers[firstName] && typeof providers[firstName].model === "string" && providers[firstName].model.trim()
          ? providers[firstName].model.trim() : null;
        return { token: token ? resolveEnvRef(token, o.env).trim() || null : null, baseUrl: normalizeBaseUrl(baseUrl), model, error: null };
      }
      case "dotenv": {
        const env = parseDotenv(text);
        return {
          token: firstNonEmpty(env, candidate.tokenKeys || []),
          baseUrl: candidate.baseUrlKey ? normalizeBaseUrl(env[candidate.baseUrlKey]) : null,
          model: candidate.modelKey ? firstNonEmpty(env, [candidate.modelKey]) : null,
          error: null,
        };
      }
      case "toml-scalar": {
        const tokenKey = (candidate.tokenKeys || [])[0];
        return {
          token: tokenKey ? extractTomlScalar(text, tokenKey) : null,
          baseUrl: candidate.baseUrlKey ? normalizeBaseUrl(extractTomlScalar(text, candidate.baseUrlKey)) : null,
          model: candidate.modelKey ? extractTomlScalar(text, candidate.modelKey) : null,
          error: null,
        };
      }
      case "yaml-scalar": {
        const tokenKey = (candidate.tokenKeys || [])[0];
        return {
          token: tokenKey ? extractYamlScalar(text, tokenKey) : null,
          baseUrl: candidate.baseUrlKey ? normalizeBaseUrl(extractYamlScalar(text, candidate.baseUrlKey)) : null,
          model: candidate.modelKey ? extractYamlScalar(text, candidate.modelKey) : null,
          error: null,
        };
      }
      default:
        return { token: null, baseUrl: null, model: null, error: `unknown format: ${candidate.format}` };
    }
  } catch (err) {
    return { token: null, baseUrl: null, error: err && err.message ? err.message : "parse failed" };
  }
}

function readAgentCredential(source, opts = {}) {
  const o = normalizeOpts(opts);
  const result = {
    agentId: source.agentId,
    agentName: source.agentName,
    found: false,
    token: null,
    tokenMasked: null,
    baseUrl: null,
    model: null,
    sourcePath: null,
    error: null,
  };
  for (const candidate of source.candidates) {
    const filePath = candidatePath(candidate, o);
    const { text, missing, error: readErr } = readText(o, filePath);
    if (missing) continue;
    if (readErr) { if (!result.error) result.error = readErr; continue; }
    const extracted = extractCandidate(candidate, text, o);
    if (extracted.error && !result.error) result.error = extracted.error;
    if (extracted.token && !result.token) { result.token = extracted.token; result.sourcePath = filePath; }
    if (extracted.baseUrl && !result.baseUrl) result.baseUrl = extracted.baseUrl;
    if (extracted.model && !result.model) result.model = extracted.model;
  }
  if (result.token) {
    result.found = true;
    result.tokenMasked = maskToken(result.token);
    result.error = null; // a usable token supersedes an earlier parse warning
  }
  return result;
}

function readAllCredentials(opts = {}) {
  return getCredentialSources().map((source) => {
    const r = readAgentCredential(source, opts);
    return {
      agentId: r.agentId,
      agentName: r.agentName,
      found: r.found,
      hasToken: Boolean(r.token),
      tokenMasked: r.tokenMasked,
      baseUrl: r.baseUrl,
      model: r.model,
      sourcePath: r.sourcePath,
      error: r.error,
    };
  });
}

function revealAgentToken(agentId, opts = {}) {
  const source = getCredentialSources().find((s) => s.agentId === agentId);
  if (!source) return { agentId, token: null, found: false };
  const r = readAgentCredential(source, opts);
  return { agentId, token: r.token, found: r.found };
}

module.exports = { readAgentCredential, readAllCredentials, revealAgentToken };
