"use strict";

const { normalizeQuotaGroup } = require("../hooks/quota-bucket");
const { CODEX_QUOTA_FIELDS } = require("../hooks/codex-rate-limits");

function isCodexMonitorMetadataOnlyEvent(event, extra) {
  return event === "event_msg:token_count"
    && !!(extra && typeof extra === "object"
      && (extra.contextUsage || extra.codexQuota || extra.codexSparkQuota));
}

function normalizeContextUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const used = Number(value.used);
  if (!Number.isFinite(used) || used < 0) return null;
  const out = { used };
  const limit = Number(value.limit);
  if (Number.isFinite(limit) && limit > 0) out.limit = limit;
  const percent = Number(value.percent);
  if (Number.isFinite(percent)) {
    out.percent = Math.max(0, Math.min(100, Math.round(percent)));
  } else if (out.limit) {
    out.percent = Math.max(0, Math.min(100, Math.round((used / out.limit) * 100)));
  }
  if (value.source === "claude" || value.source === "codex") out.source = value.source;
  return out;
}

// Session metadata and account quota deliberately have separate builders.
// This makes it structurally impossible for any updateSession caller (including
// passive user-input paths) to spread account quota into session options.
function buildCodexMonitorSessionOptions(extra, options = {}) {
  const input = extra && typeof extra === "object" ? extra : {};
  const out = {
    cwd: input.cwd,
    agentId: "codex",
    sessionTitle: input.sessionTitle,
  };
  if (Object.prototype.hasOwnProperty.call(input, "sourcePid")) out.sourcePid = input.sourcePid;
  if (Object.prototype.hasOwnProperty.call(input, "agentPid")) out.agentPid = input.agentPid;
  if (Object.prototype.hasOwnProperty.call(input, "pidChain")) out.pidChain = input.pidChain;
  if (Object.prototype.hasOwnProperty.call(input, "codexOriginator")) out.codexOriginator = input.codexOriginator;
  if (Object.prototype.hasOwnProperty.call(input, "codexSource")) out.codexSource = input.codexSource;
  if (options.includeRecap === true) {
    const hasTrustedRecapTime = Number.isSafeInteger(input.recapOccurredAt) && input.recapOccurredAt >= 0;
    if (hasTrustedRecapTime) out.recapOccurredAt = input.recapOccurredAt;
    if (typeof input.recapDedupeId === "string" && input.recapDedupeId) {
      out.recapDedupeId = input.recapDedupeId;
    }
    if (typeof input.toolUseId === "string" && input.toolUseId) out.toolUseId = input.toolUseId;
    if (input.headless === true) out.recapIsSubagent = true;
    if (!hasTrustedRecapTime || input.syntheticBackfill === true) out.recapSuppressed = true;
  }
  const contextUsage = normalizeContextUsage(input.contextUsage);
  if (contextUsage) out.contextUsage = contextUsage;
  if (options.includeHeadless) out.headless = input.headless === true;
  return out;
}

function normalizeCodexMonitorAccountQuotas(extra) {
  const input = extra && typeof extra === "object" ? extra : {};
  const out = {};
  const codexQuota = normalizeQuotaGroup(input.codexQuota, CODEX_QUOTA_FIELDS);
  if (codexQuota) out.codexQuota = codexQuota;
  const codexSparkQuota = normalizeQuotaGroup(input.codexSparkQuota, CODEX_QUOTA_FIELDS);
  if (codexSparkQuota) out.codexSparkQuota = codexSparkQuota;
  return Object.keys(out).length ? out : null;
}

module.exports = {
  buildCodexMonitorSessionOptions,
  normalizeCodexMonitorAccountQuotas,
  isCodexMonitorMetadataOnlyEvent,
};
