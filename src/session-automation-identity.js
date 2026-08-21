"use strict";

const { isCodexCliOriginator } = require("../hooks/codex-originator");

// Session automation is a security-sensitive opt-in. This table is deliberately
// small and static: it records only adapter identity facts that have been
// audited for this feature. It is not a runtime capability registry.
const ADAPTER_POLICY = Object.freeze({
  "claude-code": Object.freeze({
    eligible: false,
    reason: "identity-verification-required",
    placeholders: Object.freeze(["default"]),
  }),
  codebuddy: Object.freeze({
    eligible: false,
    reason: "identity-verification-required",
    placeholders: Object.freeze(["default"]),
  }),
  "qwen-code": Object.freeze({
    eligible: false,
    reason: "identity-verification-required",
    placeholders: Object.freeze(["default", "qwen-code:", "qwen-code:default"]),
  }),
  // ZCode permissions are manual-only until both its tool surface and its
  // session-lifecycle identity facts have been audited for automation.
  zcode: Object.freeze({
    eligible: false,
    reason: "automation-not-audited",
    placeholders: Object.freeze(["default", "zcode:", "zcode:default"]),
  }),
  "copilot-cli": Object.freeze({
    eligible: false,
    reason: "session-lifecycle-not-authoritative",
    placeholders: Object.freeze(["default", "copilot-cli:", "copilot-cli:default"]),
  }),
  opencode: Object.freeze({
    eligible: false,
    reason: "permission-session-association-not-authoritative",
    placeholders: Object.freeze(["default", "opencode:", "opencode:default"]),
  }),
  mimocode: Object.freeze({
    eligible: false,
    reason: "permission-session-association-not-authoritative",
    placeholders: Object.freeze(["default", "mimocode:", "mimocode:default"]),
  }),
  codex: Object.freeze({
    // Conditional, not blanket eligibility. Only the local, process-bound TUI
    // identity audited below may pass. Codex Desktop/app-server, remote and
    // unknown identities remain fail-closed.
    eligible: true,
    reason: "codex-local-cli-identity-required",
    placeholders: Object.freeze(["default", "codex:", "codex:default"]),
  }),
  hermes: Object.freeze({
    eligible: false,
    reason: "session-lifecycle-not-authoritative",
    placeholders: Object.freeze(["default", "hermes:", "hermes:default"]),
  }),
  "deepseek-harness": Object.freeze({
    // ApprovalRequest intentionally exposes no arguments, so the DSH adapter's
    // tool-input fingerprint is the same empty-object hash for every request.
    // Do not make this eligible until an audited identity adds a public,
    // per-call discriminator; otherwise unrelated tools could share a grant.
    eligible: false,
    reason: "automation-not-audited",
    placeholders: Object.freeze([
      "default",
      "deepseek-harness:",
      "deepseek-harness:default",
    ]),
  }),
  "kimi-cli": Object.freeze({
    eligible: false,
    reason: "no-blocking-permission-decision",
    placeholders: Object.freeze(["default", "kimi-cli:", "kimi-cli:default"]),
  }),
});

const VALID_CHANNELS = new Set(["state", "permission"]);
const CODEX_SESSION_ID_PATTERN =
  /^codex:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function result(eligible, reason) {
  return Object.freeze({ eligible: eligible === true, reason });
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assessCodexIdentity({
  rawSessionId,
  profileId,
  hookSource,
  codexOriginator,
  codexSource,
  agentPid,
}) {
  // Remote Codex hooks do not currently provide a locally probeable process
  // lifecycle and Codex has no SessionEnd hook. Keep them ineligible until the
  // remote runtime supplies equally authoritative end evidence.
  if (profileId !== "local") {
    return result(false, "remote-session-lifecycle-not-authoritative");
  }
  if (normalizeString(hookSource) !== "codex-official") {
    return result(false, "untrusted-codex-hook-source");
  }
  if (!CODEX_SESSION_ID_PATTERN.test(normalizeString(rawSessionId))) {
    return result(false, "non-authoritative-codex-session-id");
  }
  if (normalizeString(codexSource).toLowerCase() !== "cli") {
    return result(false, "unsupported-codex-session-source");
  }
  const originator = normalizeString(codexOriginator).toLowerCase();
  if (!isCodexCliOriginator(originator)) {
    return result(false, "unsupported-codex-originator");
  }
  if (!Number.isFinite(agentPid) || agentPid <= 0) {
    return result(false, "missing-codex-process-lifecycle");
  }
  return result(true, "eligible");
}

function assessSessionAutomationIdentity({
  agentId,
  channel,
  event,
  rawSessionId,
  profileId = "local",
  hookSource,
  codexOriginator,
  codexSource,
  agentPid,
} = {}) {
  // `event` is intentionally accepted as part of the stable API. Adapter
  // policies may later need to distinguish state/end evidence, but callers
  // cannot use a sender-provided eligibility bit to bypass this function.
  void event;

  if (!VALID_CHANNELS.has(channel)) {
    return result(false, "unsupported-channel");
  }

  const trustedAgentId = typeof agentId === "string" ? agentId.trim() : "";
  const policy = ADAPTER_POLICY[trustedAgentId];
  if (!policy) {
    return result(false, "unsupported-adapter");
  }

  const raw = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
  if (!raw) {
    return result(false, "missing-session-id");
  }

  const normalized = raw.toLowerCase();
  if (policy.placeholders.some((placeholder) => normalized === placeholder)) {
    return result(false, "placeholder-session-id");
  }
  if (normalized === `${trustedAgentId.toLowerCase()}:default`) {
    return result(false, "placeholder-session-id");
  }
  if (normalized === `${trustedAgentId.toLowerCase()}:`) {
    return result(false, "prefix-only-session-id");
  }

  if (!policy.eligible) {
    return result(false, policy.reason);
  }

  if (trustedAgentId === "codex") {
    return assessCodexIdentity({
      rawSessionId: raw,
      profileId,
      hookSource,
      codexOriginator,
      codexSource,
      agentPid,
    });
  }

  return result(true, "eligible");
}

module.exports = {
  ADAPTER_POLICY,
  assessSessionAutomationIdentity,
};
