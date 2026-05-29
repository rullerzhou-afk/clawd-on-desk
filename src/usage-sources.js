"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { extractCodexRateLimitsFromJsonl, normalizeClaudeUsageResponse } = require("./usage-parsers");
const CodexLogMonitor = require("../agents/codex-log-monitor");

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// Token refresh endpoint. Confirmed against decompiled Claude Code source
// (TOKEN_URL in the OAuth config) and ~8 independent OAuth implementations.
// NOTE: api.anthropic.com/api/oauth/token is NOT a refresh endpoint (returns
// 404); that host only serves /claude_cli/create_api_key. Do not re-add it.
const CLAUDE_REFRESH_URLS = Object.freeze([
  "https://console.anthropic.com/v1/oauth/token",
]);
// Claude Code's public OAuth client_id (PKCE public client, not a secret).
// Not stored in ~/.claude/.credentials.json, so it must be hardcoded here —
// sending client_id: undefined gets the request rejected (and triggers 429s
// under polling). Value cross-checked across decompiled source + many repos.
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_USER_AGENT = "claude-code/2.1.0";
const CLAUDE_BETA = "oauth-2025-04-20";

function readCodexUsageLocal(options = {}) {
  const latest = CodexLogMonitor.findLatestRolloutFile({
    codexDir: options.codexDir,
    baseDir: options.baseDir,
  });
  if (!latest) return { provider: "codex", limits: [] };
  let text = "";
  try {
    text = fs.readFileSync(latest, "utf8");
  } catch {
    return { provider: "codex", limits: [] };
  }
  return {
    ...extractCodexRateLimitsFromJsonl(text),
    source: { kind: "local", path: latest },
  };
}

function readClaudeCredentials(credentialsPath = path.join(os.homedir(), ".claude", ".credentials.json")) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  } catch {
    return null;
  }
  const oauth = parsed && parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object"
    ? parsed.claudeAiOauth
    : null;
  if (!oauth) return null;
  return { root: parsed, oauth, credentialsPath };
}

function parseExpiresAt(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function requestJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 6000;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || "GET",
      headers: options.headers || {},
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.body = raw;
          reject(err);
          return;
        }
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function refreshClaudeAccessToken(creds, options = {}) {
  const oauth = creds && creds.oauth;
  if (!oauth || !oauth.refreshToken) return null;
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId || oauth.client_id || CLAUDE_OAUTH_CLIENT_ID,
  });
  const headers = {
    "content-type": "application/json",
    "user-agent": CLAUDE_USER_AGENT,
  };
  for (const url of (options.refreshUrls || CLAUDE_REFRESH_URLS)) {
    try {
      const json = await requestJson(url, { method: "POST", headers, body, timeoutMs: options.timeoutMs });
      const accessToken = json.access_token || json.accessToken;
      if (!accessToken) continue;
      return {
        accessToken,
        refreshToken: json.refresh_token || json.refreshToken || oauth.refreshToken,
        expiresAt: json.expires_at || json.expiresAt || (
          Number.isFinite(Number(json.expires_in || json.expiresIn))
            ? Date.now() + Number(json.expires_in || json.expiresIn) * 1000
            : oauth.expiresAt
        ),
      };
    } catch {
      // Try the next known Claude Code OAuth host. The caller hides Claude
      // gauges entirely if every refresh path fails.
    }
  }
  return null;
}

function writeRefreshedClaudeCredentials(creds, refreshed) {
  if (!creds || !creds.root || !creds.credentialsPath || !refreshed || !refreshed.accessToken) return;
  const tmpPath = `${creds.credentialsPath}.clawd-tmp`;
  try {
    const next = {
      ...creds.root,
      claudeAiOauth: {
        ...creds.oauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || creds.oauth.refreshToken,
        expiresAt: refreshed.expiresAt || creds.oauth.expiresAt,
      },
    };
    let mode = 0o600;
    try {
      mode = fs.statSync(creds.credentialsPath).mode & 0o777;
    } catch {}
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode });
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, creds.credentialsPath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    // Best-effort cache update only.
  }
}

async function getClaudeAccessToken(options = {}) {
  const creds = readClaudeCredentials(options.credentialsPath);
  if (!creds || !creds.oauth || !creds.oauth.accessToken) return null;
  const expiresAt = parseExpiresAt(creds.oauth.expiresAt);
  if (!expiresAt || expiresAt > Date.now() + 30 * 1000) return creds.oauth.accessToken;
  const refreshed = await refreshClaudeAccessToken(creds, options);
  if (!refreshed || !refreshed.accessToken) return null;
  writeRefreshedClaudeCredentials(creds, refreshed);
  return refreshed.accessToken;
}

async function fetchClaudeUsage(options = {}) {
  const accessToken = await getClaudeAccessToken(options);
  if (!accessToken) return { provider: "claude", limits: [] };
  try {
    const body = await requestJson(options.usageUrl || CLAUDE_USAGE_URL, {
      timeoutMs: options.timeoutMs || 6000,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": CLAUDE_BETA,
        "user-agent": CLAUDE_USER_AGENT,
      },
    });
    return normalizeClaudeUsageResponse(body, Date.now());
  } catch {
    return { provider: "claude", limits: [] };
  }
}

module.exports = {
  CLAUDE_USAGE_URL,
  CLAUDE_REFRESH_URLS,
  readCodexUsageLocal,
  readClaudeCredentials,
  parseExpiresAt,
  requestJson,
  refreshClaudeAccessToken,
  getClaudeAccessToken,
  fetchClaudeUsage,
};
