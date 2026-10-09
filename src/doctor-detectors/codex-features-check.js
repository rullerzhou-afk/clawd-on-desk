"use strict";

const fs = require("fs");
const crypto = require("crypto");

const { CODEX_HOOK_EVENTS } = require("../../hooks/codex-install-utils");

const CODEX_TRUST_EVENT_KEYS = Object.fromEntries(
  CODEX_HOOK_EVENTS.map((eventName) => [
    eventName,
    eventName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
  ])
);

function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < line.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function checkCodexHooksFeatureText(text) {
  if (typeof text !== "string") {
    return { value: "uncertain", detail: "config is not text" };
  }

  let inFeatures = false;
  let legacyResult = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const tableMatch = line.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      inFeatures = tableMatch[1].trim() === "features";
      continue;
    }

    if (!inFeatures) continue;
    const featureMatch = line.match(/^hooks\s*=\s*(true|false)\b/i);
    if (featureMatch) {
      return {
        value: featureMatch[1].toLowerCase() === "true" ? "enabled" : "disabled",
        detail: `hooks=${featureMatch[1].toLowerCase()}`,
      };
    }
    if (/^hooks\s*=/i.test(line)) {
      return { value: "uncertain", detail: "hooks is not a boolean" };
    }

    const legacyMatch = line.match(/^codex_hooks\s*=\s*(true|false)\b/i);
    if (legacyMatch && !legacyResult) {
      legacyResult = {
        value: legacyMatch[1].toLowerCase() === "true" ? "enabled" : "disabled",
        detail: `codex_hooks=${legacyMatch[1].toLowerCase()} (deprecated)`,
      };
      continue;
    }
    if (/^codex_hooks\s*=/i.test(line) && !legacyResult) {
      legacyResult = { value: "uncertain", detail: "codex_hooks is not a boolean" };
    }
  }

  return legacyResult || { value: "uncertain", detail: "hooks not found" };
}

function checkCodexHooksFeature(configPath, options = {}) {
  const fsImpl = options.fs || fs;
  let text;
  try {
    text = fsImpl.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { value: "uncertain", detail: "config.toml missing" };
    }
    return { value: "uncertain", detail: err && err.message ? err.message : "config.toml unreadable" };
  }
  return checkCodexHooksFeatureText(text);
}

function unescapeTomlBasicString(value) {
  return String(value || "")
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"');
}

function parseHooksStateHeader(line) {
  const stripped = stripTomlComment(line).trim();
  let match = stripped.match(/^\[hooks\.state\.'([^']+)'\]$/);
  if (match) return match[1];
  match = stripped.match(/^\[hooks\.state\."((?:\\.|[^"])*)"\]$/);
  if (match) return unescapeTomlBasicString(match[1]);
  return null;
}

function collectTrustedCodexHookHashes(configText) {
  const trusted = new Map();
  if (typeof configText !== "string") return trusted;

  let currentTrustId = null;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      currentTrustId = parseHooksStateHeader(rawLine);
      continue;
    }

    const hashMatch = currentTrustId
      ? line.match(/^trusted_hash\s*=\s*"(sha256:[^"]+)"\s*$/i)
      : null;
    if (hashMatch) trusted.set(currentTrustId, hashMatch[1]);
  }
  return trusted;
}

function collectTrustedCodexHookIds(configText) {
  return new Set(collectTrustedCodexHookHashes(configText).keys());
}

function normalizeTrustId(value, platform = process.platform) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hookCommandMatchesMarker(hook, marker, platform = process.platform) {
  return !!(
    hook
    && typeof hook === "object"
    && typeof marker === "string"
    && marker
    && (
      (typeof hook.command === "string" && hook.command.includes(marker))
      || (
        platform === "win32"
        && typeof hook.commandWindows === "string"
        && hook.commandWindows.includes(marker)
      )
    )
  );
}

function sortCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(sortCanonicalJson);
  if (!value || typeof value !== "object") return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortCanonicalJson(value[key]);
  return sorted;
}

function matcherForCodexTrust(eventName, matcher) {
  if (eventName === "UserPromptSubmit" || eventName === "Stop") return null;
  return typeof matcher === "string" ? matcher : null;
}

function commandTimeoutForCodexTrust(eventName, value) {
  const parsed = Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (eventName === "SessionEnd") return Math.min(3, Math.max(1, parsed === null ? 1 : parsed));
  return Math.max(1, parsed === null ? 600 : parsed);
}

function supportsAdditionalContextLimit(eventName) {
  return [
    "PreToolUse",
    "PostToolUse",
    "SessionStart",
    "UserPromptSubmit",
    "SubagentStart",
  ].includes(eventName);
}

// Mirrors openai/codex hook discovery's NormalizedHookIdentity and
// config::fingerprint::version_for_toml. Codex selects commandWindows on
// Windows, normalizes defaults, converts the TOML value to canonical JSON
// (object keys recursively sorted), then hashes the UTF-8 JSON bytes.
function computeCodexHookTrustedHash(eventName, group, hook, platform = process.platform) {
  if (!hook || typeof hook !== "object") return null;
  const command = platform === "win32" && typeof hook.commandWindows === "string"
    ? hook.commandWindows
    : hook.command;
  if (typeof command !== "string" || !command.trim()) return null;

  const normalizedHook = {
    type: "command",
    command,
    timeout: commandTimeoutForCodexTrust(eventName, hook.timeout),
    async: hook.async === true,
  };
  if (typeof hook.statusMessage === "string") {
    normalizedHook.statusMessage = hook.statusMessage;
  }
  if (
    supportsAdditionalContextLimit(eventName)
    && Number.isSafeInteger(hook.additionalContextLimit)
    && hook.additionalContextLimit >= 0
    && hook.additionalContextLimit !== 2500
  ) {
    normalizedHook.additionalContextLimit = hook.additionalContextLimit;
  }

  const identity = {
    event_name: CODEX_TRUST_EVENT_KEYS[eventName]
      || eventName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
    hooks: [normalizedHook],
  };
  const matcher = matcherForCodexTrust(eventName, group && group.matcher);
  if (matcher !== null) identity.matcher = matcher;
  const canonical = JSON.stringify(sortCanonicalJson(identity));
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

function findCodexHookTrustPositions(
  settings,
  marker = "codex-hook.js",
  platform = process.platform
) {
  const hooks = settings && typeof settings === "object" && settings.hooks && typeof settings.hooks === "object"
    ? settings.hooks
    : null;
  if (!hooks) return [];

  const positions = [];
  for (const eventName of CODEX_HOOK_EVENTS) {
    const entries = hooks[eventName];
    if (!Array.isArray(entries)) continue;
    const eventKey = CODEX_TRUST_EVENT_KEYS[eventName];
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex];
      if (!entry || typeof entry !== "object") continue;

      if (Array.isArray(entry.hooks)) {
        for (let hookIndex = 0; hookIndex < entry.hooks.length; hookIndex++) {
          if (hookCommandMatchesMarker(entry.hooks[hookIndex], marker, platform)) {
            positions.push({
              eventName,
              eventKey,
              entryIndex,
              hookIndex,
              group: entry,
              hook: entry.hooks[hookIndex],
            });
          }
        }
      }

      if (hookCommandMatchesMarker(entry, marker, platform)) {
        positions.push({
          eventName,
          eventKey,
          entryIndex,
          hookIndex: 0,
          group: entry,
          hook: entry,
        });
      }
    }
  }
  return positions;
}

function makeTrustId(hooksPath, position) {
  return `${hooksPath}:${position.eventKey}:${position.entryIndex}:${position.hookIndex}`;
}

function checkCodexHookTrustText(configText, settings, hooksPath, options = {}) {
  const marker = options.marker || "codex-hook.js";
  const platform = options.platform || process.platform;
  const positions = findCodexHookTrustPositions(settings, marker, platform);
  if (!positions.length) {
    return {
      key: "codex_hook_trust",
      value: "uncertain",
      detail: `${marker} not found in hooks.json`,
    };
  }

  const trusted = new Map(
    [...collectTrustedCodexHookHashes(configText)].map(([trustId, hash]) => [
      normalizeTrustId(trustId, platform),
      hash,
    ])
  );
  const missing = positions.filter((position) => {
    const expected = normalizeTrustId(makeTrustId(hooksPath, position), platform);
    const currentHash = computeCodexHookTrustedHash(
      position.eventName,
      position.group,
      position.hook,
      platform
    );
    return !currentHash || trusted.get(expected) !== currentHash;
  });

  if (missing.length) {
    const missingEvents = [...new Set(missing.map((position) => position.eventName))].join(", ");
    return {
      key: "codex_hook_trust",
      value: "needs-review",
      detail: `${missing.length}/${positions.length} Clawd Codex hook(s) need Codex /hooks review: ${missingEvents}`,
      missingEvents: missing.map((position) => position.eventName),
      trustedCount: positions.length - missing.length,
      totalCount: positions.length,
    };
  }

  return {
    key: "codex_hook_trust",
    value: "trusted",
    detail: `${positions.length}/${positions.length} Clawd Codex hook(s) trusted by Codex`,
    trustedCount: positions.length,
    totalCount: positions.length,
  };
}

function checkCodexHookTrust(configPath, settings, hooksPath, options = {}) {
  const fsImpl = options.fs || fs;
  let text = "";
  try {
    text = fsImpl.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      return {
        key: "codex_hook_trust",
        value: "uncertain",
        detail: err && err.message ? err.message : "config.toml unreadable",
      };
    }
  }
  return checkCodexHookTrustText(text, settings, hooksPath, options);
}

module.exports = {
  checkCodexHookTrust,
  checkCodexHookTrustText,
  checkCodexHooksFeature,
  checkCodexHooksFeatureText,
  collectTrustedCodexHookHashes,
  collectTrustedCodexHookIds,
  computeCodexHookTrustedHash,
  findCodexHookTrustPositions,
};
