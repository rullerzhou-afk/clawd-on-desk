"use strict";

const path = require("path");

// Slack notifications are one-way in this build: session done/error pings and a
// read-only "permission needed" heads-up are pushed to Slack, but Slack cannot
// resolve an approval back (that needs Socket Mode and is a deliberate future
// step — see slack-notify-client.js `supportsApproval`). The webhook URL is the
// primary transport; a bot token + channel id is an optional alternate that
// posts via chat.postMessage. Both live outside prefs as secrets.
const DEFAULT_SLACK_NOTIFY = Object.freeze({
  enabled: false,
  channelId: "",
  notifyOnDone: true,
  notifyOnError: true,
  notifyOnPermission: true,
  // Whether to append the assistant's last output to completion pings.
  // "off" keeps messages to a title + metadata line; "full" adds the (redacted,
  // truncated) output. Mirrors the Telegram companion's completionOutputMode.
  outputMode: "off",
});

const OUTPUT_MODES = new Set(["off", "full"]);
const SECRET_KEYS = Object.freeze({
  webhookUrl: "SLACK_WEBHOOK_URL",
  botToken: "SLACK_BOT_TOKEN",
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function trimString(value, maxLen = 512) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

// Secrets are persisted in a line-oriented env file and channel ids are later
// embedded in JSON. Reject C0/DEL outright instead of trimming only the ends:
// URL parsers may otherwise ignore CR/LF/TAB while the writer preserves them,
// turning a value that passed validation into a different value on restart.
function hasControlChars(value) {
  return typeof value === "string" && /[\u0000-\u001f\u007f]/.test(value);
}

function cloneDefaultSlackNotify() {
  return { ...DEFAULT_SLACK_NOTIFY };
}

function normalizeOutputMode(value, fallback = DEFAULT_SLACK_NOTIFY.outputMode) {
  // "tail" was never a Slack option, but stay forgiving toward configs copied
  // from the Telegram companion, which historically accepted it.
  if (value === "tail") return "full";
  return typeof value === "string" && OUTPUT_MODES.has(value) ? value : fallback;
}

function normalizeSlackNotify(value, defaultsValue = DEFAULT_SLACK_NOTIFY) {
  const defaults = isPlainObject(defaultsValue) ? defaultsValue : DEFAULT_SLACK_NOTIFY;
  const out = {
    enabled: defaults.enabled === true,
    channelId: hasControlChars(defaults.channelId) ? "" : trimString(defaults.channelId, 128),
    notifyOnDone: defaults.notifyOnDone !== false,
    notifyOnError: defaults.notifyOnError !== false,
    notifyOnPermission: defaults.notifyOnPermission !== false,
    outputMode: normalizeOutputMode(defaults.outputMode),
  };
  if (!isPlainObject(value)) return out;
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  if (typeof value.channelId === "string") {
    out.channelId = hasControlChars(value.channelId) ? "" : trimString(value.channelId, 128);
  }
  if (typeof value.notifyOnDone === "boolean") out.notifyOnDone = value.notifyOnDone;
  if (typeof value.notifyOnError === "boolean") out.notifyOnError = value.notifyOnError;
  if (typeof value.notifyOnPermission === "boolean") out.notifyOnPermission = value.notifyOnPermission;
  if (value.outputMode !== undefined) out.outputMode = normalizeOutputMode(value.outputMode, out.outputMode);
  return out;
}

const ALLOWED_KEYS = new Set([
  "enabled",
  "channelId",
  "notifyOnDone",
  "notifyOnError",
  "notifyOnPermission",
  "outputMode",
]);

function validateSlackNotify(value) {
  if (!isPlainObject(value)) return { status: "error", message: "slackNotify must be a plain object" };
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) return { status: "error", message: `slackNotify.${key} is not supported` };
  }
  if (typeof value.enabled !== "boolean") {
    return { status: "error", message: "slackNotify.enabled must be a boolean" };
  }
  if (value.channelId !== undefined && typeof value.channelId !== "string") {
    return { status: "error", message: "slackNotify.channelId must be a string" };
  }
  if (typeof value.channelId === "string" && value.channelId.length > 128) {
    return { status: "error", message: "slackNotify.channelId is too long" };
  }
  if (typeof value.channelId === "string" && hasControlChars(value.channelId)) {
    return { status: "error", message: "slackNotify.channelId must not contain control characters" };
  }
  for (const key of ["notifyOnDone", "notifyOnError", "notifyOnPermission"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      return { status: "error", message: `slackNotify.${key} must be a boolean` };
    }
  }
  if (value.outputMode !== undefined && !OUTPUT_MODES.has(value.outputMode)) {
    return { status: "error", message: "slackNotify.outputMode must be off or full" };
  }
  return { status: "ok" };
}

// Incoming webhooks are always https://hooks.slack.com/... — pinning the host
// keeps a mistyped/hostile URL from turning a completion ping into an
// outbound request to an arbitrary server. The comparison is a full hostname
// equality check, never a suffix/substring match, so lookalikes that merely end
// in or contain the real host ("hooks.slack.com.evil.example", "evil-slack.com",
// "hooks.slack.com@evil.example") are rejected.
function isValidWebhookUrl(value) {
  if (typeof value !== "string" || hasControlChars(value)) return false;
  const raw = trimString(value, 2048);
  if (!raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname === "hooks.slack.com";
}

// The UI asks for a *bot* token, so only `xoxb-` is accepted. User tokens
// (`xoxp-`) and app-configuration tokens (`xoxe-`) carry a different, usually
// much broader, authority than the single `chat:write` scope this feature
// needs, and silently accepting them would mean the field does not do what it
// says. Required scope: `chat:write` (plus `chat:write.public` to post to a
// public channel the bot has not joined) — see docs/guides/slack-notifications.md.
const BOT_TOKEN_PREFIX = "xoxb-";

function isValidBotToken(value) {
  if (typeof value !== "string" || hasControlChars(value)) return false;
  const raw = trimString(value, 256);
  return /^xoxb-[A-Za-z0-9-]{8,}$/.test(raw);
}

// Which transport a config+secrets pair can actually use. Webhook wins when both
// are present because it needs no channel id and no extra scopes.
function resolveSlackTransport(config, secrets) {
  const rawConfig = isPlainObject(config) ? config : {};
  const normalized = normalizeSlackNotify(config);
  const source = isPlainObject(secrets) ? secrets : {};
  if (isValidWebhookUrl(source.webhookUrl)) return "webhook";
  if (hasControlChars(rawConfig.channelId)) return null;
  if (isValidBotToken(source.botToken) && normalized.channelId && !hasControlChars(normalized.channelId)) return "bot";
  return null;
}

function defaultSecretsEnvFilePath(userDataDir) {
  return userDataDir ? path.join(userDataDir, "slack-notify.env") : "";
}

function parseEnvText(text) {
  const out = {};
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function readSecretsEnvFile({ fs, filePath } = {}) {
  if (!fs || !filePath || typeof fs.readFileSync !== "function") {
    return { webhookUrl: "", botToken: "" };
  }
  let parsed = {};
  try {
    parsed = parseEnvText(fs.readFileSync(filePath, "utf8"));
  } catch {
    parsed = {};
  }
  return {
    webhookUrl: trimString(parsed[SECRET_KEYS.webhookUrl], 2048),
    botToken: trimString(parsed[SECRET_KEYS.botToken], 256),
  };
}

function buildSecretsEnvFile(secrets) {
  const source = isPlainObject(secrets) ? secrets : {};
  return [
    `${SECRET_KEYS.webhookUrl}=${trimString(source.webhookUrl, 2048)}`,
    `${SECRET_KEYS.botToken}=${trimString(source.botToken, 256)}`,
    "",
  ].join("\n");
}

// Mirrors the Feishu writer: atomic temp-file + rename, 0o600, and only the keys
// present in the incoming payload are updated so saving one field does not wipe
// the other. Errors carry a stable `code` for the UI plus an English diagnostic.
function writeSecretsEnvFile({ fs, path: pathModule = path, filePath, secrets, platform = process.platform } = {}) {
  if (!fs || typeof fs.writeFileSync !== "function") {
    return { status: "error", code: "write-failed", message: "writeSecretsEnvFile requires fs" };
  }
  if (!filePath || typeof filePath !== "string") {
    return { status: "error", code: "write-failed", message: "Secrets env file path is required" };
  }
  const incoming = isPlainObject(secrets) ? secrets : {};
  // Validate before touching the disk. Writing first and discovering the value
  // is unusable afterwards leaves a credential stored that nothing can use and
  // the UI cannot explain — and, because a stored webhook wins transport
  // resolution, a malformed one would also mask a perfectly good bot token.
  // An empty string is not a value; it is the explicit "clear this" signal.
  if (
    typeof incoming.webhookUrl === "string"
    && (hasControlChars(incoming.webhookUrl) || (incoming.webhookUrl.trim() && !isValidWebhookUrl(incoming.webhookUrl)))
  ) {
    return {
      status: "error",
      code: "invalid-webhook",
      message: "Webhook URL must be an https://hooks.slack.com/ address",
    };
  }
  if (
    typeof incoming.botToken === "string"
    && (hasControlChars(incoming.botToken) || (incoming.botToken.trim() && !isValidBotToken(incoming.botToken)))
  ) {
    return {
      status: "error",
      code: "invalid-bot-token",
      message: `Bot token must start with ${BOT_TOKEN_PREFIX}`,
    };
  }
  const current = readSecretsEnvFile({ fs, filePath });
  const next = { ...current };
  for (const key of Object.keys(SECRET_KEYS)) {
    // An explicit empty string clears the field; only `undefined`/non-string
    // leaves it untouched. This lets the UI remove a webhook or token.
    if (typeof incoming[key] === "string") {
      next[key] = trimString(incoming[key], key === "webhookUrl" ? 2048 : 256);
    }
  }
  // Validate the exact normalized bytes that will be written. This also keeps
  // a corrupt pre-existing value from being copied through while updating the
  // other credential; explicitly clearing the corrupt field remains possible.
  if (next.webhookUrl && !isValidWebhookUrl(next.webhookUrl)) {
    return {
      status: "error",
      code: "invalid-webhook",
      message: "Webhook URL must be an https://hooks.slack.com/ address",
    };
  }
  if (next.botToken && !isValidBotToken(next.botToken)) {
    return {
      status: "error",
      code: "invalid-bot-token",
      message: `Bot token must start with ${BOT_TOKEN_PREFIX}`,
    };
  }
  let tmpPath = "";
  try {
    fs.mkdirSync(pathModule.dirname(filePath), { recursive: true });
    const base = pathModule.basename(filePath);
    tmpPath = pathModule.join(
      pathModule.dirname(filePath),
      `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    fs.writeFileSync(tmpPath, buildSecretsEnvFile(next), { encoding: "utf8", mode: 0o600 });
    if (platform !== "win32" && typeof fs.chmodSync === "function") {
      try { fs.chmodSync(tmpPath, 0o600); } catch {}
    }
    fs.renameSync(tmpPath, filePath);
    if (platform !== "win32" && typeof fs.chmodSync === "function") {
      try { fs.chmodSync(filePath, 0o600); } catch {}
    }
    return { status: "ok", secretsStored: true, filePath };
  } catch (err) {
    // writeFileSync may leave a partial plaintext file and renameSync leaves the
    // complete temp file behind on failure. Never delete the destination here;
    // only clean the uniquely named temp file we own, best-effort.
    if (tmpPath && typeof fs.unlinkSync === "function") {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    return {
      status: "error",
      code: "write-failed",
      message: `Secrets write failed: ${err && err.message}`,
    };
  }
}

function maskSecret(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  if (text.length < 10) return "****";
  return `${text.slice(0, 4)}......${text.slice(-4)}`;
}

function readMaskedSecrets({ fs, filePath } = {}) {
  const secrets = readSecretsEnvFile({ fs, filePath });
  const configured = !!(secrets.webhookUrl || secrets.botToken);
  return {
    configured,
    webhookUrl: maskSecret(secrets.webhookUrl),
    botToken: maskSecret(secrets.botToken),
  };
}

function secretStatus({ fs, filePath } = {}) {
  const secrets = readSecretsEnvFile({ fs, filePath });
  let fileExists = false;
  let secretFileMtimeMs = 0;
  if (fs && filePath && typeof fs.existsSync === "function") {
    try { fileExists = fs.existsSync(filePath); } catch { fileExists = false; }
    if (fileExists && typeof fs.statSync === "function") {
      try {
        const stat = fs.statSync(filePath);
        secretFileMtimeMs = stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
      } catch {
        secretFileMtimeMs = 0;
      }
    }
  }
  return {
    secretStored: fileExists,
    secretConfigured: !!(secrets.webhookUrl || secrets.botToken),
    secretFileMtimeMs,
  };
}


// The four questions the UI needs answered separately, because collapsing them
// into one "ready" flag is what made a perfectly good webhook report itself as
// unusable while the enable switch was off — and blocked Send Test during
// setup, exactly when you most want it.
//
//   credentialsPresent — is anything stored at all?
//   transport          — is a stored credential actually usable right now?
//   enabled            — has the user switched sending on?
//   ready              — both of the last two.
//
// `stored` reports each credential separately so the UI can show a mask for one
// that is saved but not currently winning transport resolution.
function describeTransport(config, secrets) {
  const normalized = normalizeSlackNotify(config);
  const source = isPlainObject(secrets) ? secrets : {};
  const rawWebhook = typeof source.webhookUrl === "string" ? source.webhookUrl.trim() : "";
  const rawToken = typeof source.botToken === "string" ? source.botToken.trim() : "";
  const stored = { webhookUrl: !!rawWebhook, botToken: !!rawToken };
  const credentialsPresent = stored.webhookUrl || stored.botToken;
  const transport = resolveSlackTransport(config, source);
  const enabled = normalized.enabled === true;

  let reason = null;
  if (!transport) {
    if (!credentialsPresent) reason = "missing-secret";
    else if (stored.webhookUrl && !isValidWebhookUrl(rawWebhook)) reason = "invalid-secret";
    else if (stored.botToken && !isValidBotToken(rawToken)) reason = "invalid-secret";
    else reason = "invalid-config"; // well-formed token, but no channel id
  }

  return { credentialsPresent, stored, transport, enabled, ready: !!transport && enabled, reason };
}

// `reason` is a stable code the UI localizes; `message` stays English for logs.
function readiness(config, secrets) {
  if (isPlainObject(config) && hasControlChars(config.channelId)) {
    return {
      ready: false,
      reason: "invalid-config",
      message: "Channel id must not contain control characters",
      config: normalizeSlackNotify(config),
    };
  }
  const normalized = normalizeSlackNotify(config);
  if (!normalized.enabled) return { ready: false, reason: "disabled", config: normalized };
  // Transport validity is the same question describeTransport answers; keep the
  // richer error messages below for logs while the codes stay stable.
  const valid = validateSlackNotify(normalized);
  if (valid.status !== "ok") return { ready: false, reason: "invalid-config", message: valid.message, config: normalized };
  const source = isPlainObject(secrets) ? secrets : {};
  const hasWebhook = typeof source.webhookUrl === "string" && source.webhookUrl.trim();
  const hasBotToken = typeof source.botToken === "string" && source.botToken.trim();
  if (!hasWebhook && !hasBotToken) {
    return { ready: false, reason: "missing-secret", message: "Webhook URL or bot token is not configured", config: normalized };
  }
  const transport = resolveSlackTransport(normalized, source);
  if (!transport) {
    if (hasWebhook) {
      return { ready: false, reason: "invalid-secret", message: "Webhook URL must be an https://hooks.slack.com/ address", config: normalized };
    }
    // Only a bot token was supplied — it is either malformed or has no channel.
    if (!isValidBotToken(source.botToken)) {
      return { ready: false, reason: "invalid-secret", message: `Bot token must start with ${BOT_TOKEN_PREFIX}`, config: normalized };
    }
    return { ready: false, reason: "invalid-config", message: "Channel id is required when using a bot token", config: normalized };
  }
  return { ready: true, transport, config: normalized };
}

function redactionSecretsForSlackNotify(config, secrets) {
  const source = secrets && typeof secrets === "object" ? secrets : {};
  return [source.webhookUrl, source.botToken].filter(Boolean);
}

module.exports = {
  DEFAULT_SLACK_NOTIFY,
  OUTPUT_MODES,
  SECRET_KEYS,
  BOT_TOKEN_PREFIX,
  cloneDefaultSlackNotify,
  normalizeSlackNotify,
  normalizeOutputMode,
  validateSlackNotify,
  isValidWebhookUrl,
  isValidBotToken,
  describeTransport,
  resolveSlackTransport,
  defaultSecretsEnvFilePath,
  readSecretsEnvFile,
  writeSecretsEnvFile,
  readMaskedSecrets,
  secretStatus,
  readiness,
  redactionSecretsForSlackNotify,
  maskSecret,
};
