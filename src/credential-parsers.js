"use strict";

// Pure, dependency-free parsers + masking for the credential reader.
// TOML/YAML use targeted regex (only scalar keys are needed), matching the
// repo's existing "toml-text" handling rather than pulling in a parser.

function parseDotenv(text) {
  const out = {};
  if (typeof text !== "string") return out;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7) : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
        || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    } else {
      // Strip an inline comment on an unquoted value ("sk # note" -> "sk"),
      // but only when a space precedes the # (so "sk#literal" is preserved).
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function firstNonEmpty(obj, keys) {
  if (!obj || typeof obj !== "object" || !Array.isArray(keys)) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function extractTomlScalar(text, key) {
  if (typeof text !== "string" || !key) return null;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))`, "m");
  const m = text.match(re);
  if (!m) return null;
  const value = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  return value && value.trim() !== "" ? value.trim() : null;
}

function extractYamlScalar(text, key) {
  if (typeof text !== "string" || !key) return null;
  // Top-level only: no leading whitespace before the key.
  const re = new RegExp(`^${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([^\\n#]+))`, "m");
  const m = text.match(re);
  if (!m) return null;
  const value = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  return value && value.trim() !== "" ? value.trim() : null;
}

function extractFromProviderJson(obj, { tokenKey = "apiKey", baseUrlKey = "baseURL" } = {}) {
  const empty = { token: null, baseUrl: null };
  if (!obj || typeof obj !== "object") return empty;
  const providers = obj.provider;
  if (!providers || typeof providers !== "object") return empty;
  for (const entry of Object.values(providers)) {
    const options = entry && entry.options;
    if (!options || typeof options !== "object") continue;
    const token = options[tokenKey];
    if (typeof token === "string" && token.trim() !== "") {
      const baseUrl = typeof options[baseUrlKey] === "string" ? options[baseUrlKey] : null;
      return { token: token.trim(), baseUrl };
    }
  }
  return empty;
}

function resolveEnvRef(value, env) {
  if (typeof value !== "string") return value;
  const m = value.match(/^\{env:([^}]+)\}$/);
  if (!m) return value;
  const resolved = (env || {})[m[1]];
  return typeof resolved === "string" ? resolved : "";
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function maskToken(token) {
  if (typeof token !== "string" || token === "") return null;
  if (token.length <= 8) return "••••••"; // fixed width: do not disclose short-token length
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

module.exports = {
  parseDotenv,
  firstNonEmpty,
  extractTomlScalar,
  extractYamlScalar,
  extractFromProviderJson,
  resolveEnvRef,
  normalizeBaseUrl,
  maskToken,
};
