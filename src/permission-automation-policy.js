"use strict";

const { isOpencodeFamily } = require("../agents/opencode-family");

const PERMISSION_AUTOMATION_MODE = Object.freeze({
  OFF: "off",
  AUTO_TOOLS: "auto-tools",
  UNATTENDED: "unattended",
});

const INTERACTION_INTENT = Object.freeze({
  TOOL_APPROVAL: "tool-approval",
  HUMAN_QUESTION: "human-question",
  PLAN_REVIEW: "plan-review",
  NOTIFICATION: "notification",
  UNKNOWN: "unknown",
});

const AUTOMATION_ACTION = Object.freeze({
  DEFER: "defer",
  AUTO_ALLOW: "auto-allow",
  AUTO_ANSWER: "auto-answer",
});

const DECISION_TOOL_KIND = Object.freeze({
  ASK_USER_QUESTION: "askuserquestion",
  EXIT_PLAN_MODE: "exitplanmode",
  CLARIFY: "clarify",
});

// DSH's model-facing tool is snake_case (`ask_user_question`); the other
// adapters use the camelCase/Tool-suffixed names. Normalize both spellings
// before the basename suffix logic runs.
const DECISION_TOOL_ALIASES = new Map([
  ["ask_user_question", DECISION_TOOL_KIND.ASK_USER_QUESTION],
]);

const DECISION_TOOL_BASENAMES = new Set(Object.values(DECISION_TOOL_KIND));

const KNOWN_PERMISSION_AGENTS = new Set([
  "claude-code",
  "codebuddy",
  "codex",
  "qwen-code",
  "copilot-cli",
  "hermes",
]);

// Claude-compatible PermissionRequest is not a trustworthy "ordinary tool"
// discriminator by itself: AskUserQuestion and ExitPlanMode travel over the
// same event. Keep auto-tools fail-closed for new built-ins until their
// interaction semantics are reviewed. Namespaced MCP calls are still real
// tool invocations, so they remain eligible without enumerating every server.
const CLAUDE_COMPATIBLE_TOOL_APPROVAL_NAMES = new Set([
  "agent",
  "activate_skill",
  "artifact",
  "bash",
  "bashoutput",
  "bashoutputtool",
  "croncreate",
  "crondelete",
  "cronlist",
  "edit",
  "edit_file",
  "enterplanmode",
  "enterworktree",
  "execute_bash",
  "exitworktree",
  "glob",
  "google_web_search",
  "grep",
  "grep_search",
  "kill_shell",
  "killshell",
  // Current Claude Code names carry the Tool suffix. Keep the two historical
  // aliases below as compatibility entries for older Claude-compatible hooks.
  "listmcpresources",
  "listmcpresourcestool",
  "lsp",
  "monitor",
  "notebookedit",
  "powershell",
  "pushnotification",
  "read",
  "read_file",
  "readmcpresource",
  "readmcpresourcetool",
  "remotetrigger",
  "replace",
  "reportfindings",
  "run_command",
  "run_shell_command",
  "save_memory",
  "schedulewakeup",
  "search_file_content",
  "sendmessage",
  "senduserfile",
  "shareonboardingguide",
  "shell",
  "skill",
  "slashcommand",
  "slashcommandtool",
  "task",
  "taskcreate",
  "taskget",
  "tasklist",
  "taskoutput",
  "taskstop",
  "taskupdate",
  "todowrite",
  "toolsearch",
  "waitformcpservers",
  "web_fetch",
  "webfetch",
  "websearch",
  "workflow",
  "write",
  "write_file",
  "write_to_file",
  "write_todos",
]);

function makeCapabilities(overrides = {}) {
  return Object.freeze({
    allowDeny: overrides.allowDeny === true,
    answerQuestions: overrides.answerQuestions === true,
    planFeedback: overrides.planFeedback === true,
    nativeFallback: overrides.nativeFallback === true,
  });
}

function makeEligibility(autoTools = false, unattended = false) {
  return Object.freeze({
    autoTools: autoTools === true,
    unattended: unattended === true,
  });
}

function makeInteraction(intent, {
  autoTools = false,
  unattended = false,
  allowDeny = false,
  answerQuestions = false,
  planFeedback = false,
  nativeFallback = false,
} = {}) {
  return Object.freeze({
    intent,
    automationEligibility: makeEligibility(autoTools, unattended),
    capabilities: makeCapabilities({
      allowDeny,
      answerQuestions,
      planFeedback,
      nativeFallback,
    }),
  });
}

function isPassiveEventKind(eventKind) {
  return eventKind === "notification"
    || eventKind === "passive-notification"
    || eventKind === "native-question";
}

function isKnownPermissionAgent(agentId) {
  return KNOWN_PERMISSION_AGENTS.has(agentId) || isOpencodeFamily(agentId);
}

function isMissingToolName(toolName) {
  return !toolName || /^unknown$/i.test(toolName);
}

function getDecisionToolKind(toolName) {
  if (!toolName) return null;
  const normalized = toolName.toLowerCase();
  if (DECISION_TOOL_ALIASES.has(normalized)) return DECISION_TOOL_ALIASES.get(normalized);
  if (DECISION_TOOL_BASENAMES.has(normalized)) return normalized;
  if (normalized.endsWith("tool")) {
    const withoutToolSuffix = normalized.slice(0, -4);
    if (DECISION_TOOL_BASENAMES.has(withoutToolSuffix)) return withoutToolSuffix;
  }
  return null;
}

function isNamespacedMcpTool(toolName) {
  const parts = toolName.split("__");
  return parts.length >= 3
    && parts[0].toLowerCase() === "mcp"
    && parts.slice(1).every((part) => part.length > 0);
}

function isTrustedClaudeCompatibleToolApproval(agentId, toolName) {
  if (agentId !== "claude-code" && agentId !== "qwen-code") return true;
  return CLAUDE_COMPATIBLE_TOOL_APPROVAL_NAMES.has(toolName.toLowerCase())
    || isNamespacedMcpTool(toolName);
}

/**
 * Derive trusted interaction semantics from route-owned fields.
 *
 * Never pass through payload.interaction/capabilities/automationEligibility:
 * those fields are not part of the hook protocol and must not be user-controlled.
 */
function classifyPermissionInteraction({
  agentId,
  eventKind = "permission",
  toolName,
} = {}) {
  const trustedAgentId = typeof agentId === "string" ? agentId : "";
  const trustedToolName = typeof toolName === "string" ? toolName.trim() : "";

  if (isPassiveEventKind(eventKind)) {
    return makeInteraction(INTERACTION_INTENT.NOTIFICATION, {
      nativeFallback: eventKind === "native-question",
    });
  }

  // Display adapters may render "Unknown", but an absent/placeholder protocol
  // identity is never evidence that the request is an ordinary tool approval.
  if (isMissingToolName(trustedToolName)) {
    return makeInteraction(INTERACTION_INTENT.UNKNOWN, {
      // A known permission adapter can still present a generic request and
      // return the user's explicit Allow/Deny choice. Missing identity is never
      // enough to automate it, though.
      allowDeny: isKnownPermissionAgent(trustedAgentId),
      nativeFallback: true,
    });
  }

  // Decision protocols share the PermissionRequest transport with ordinary
  // tools. Upstream built-ins have historically gained a "Tool" suffix (and
  // adapters may vary casing), so recognize only these reviewed aliases before
  // any generic tool/UNKNOWN compatibility path can automate them.
  const decisionToolKind = getDecisionToolKind(trustedToolName);
  const isQuestion = decisionToolKind === DECISION_TOOL_KIND.ASK_USER_QUESTION
    || (
      decisionToolKind === DECISION_TOOL_KIND.CLARIFY
      && trustedAgentId === "hermes"
    );
  if (isQuestion) {
    const canAnswerQuestions = (
      decisionToolKind === DECISION_TOOL_KIND.ASK_USER_QUESTION
      && (trustedAgentId === "claude-code" || trustedAgentId === "hermes")
    ) || (
      decisionToolKind === DECISION_TOOL_KIND.CLARIFY
      && trustedAgentId === "hermes"
    );
    if (canAnswerQuestions) {
      return makeInteraction(INTERACTION_INTENT.HUMAN_QUESTION, {
        autoTools: true,
        unattended: true,
        answerQuestions: true,
        nativeFallback: true,
      });
    }
    return makeInteraction(INTERACTION_INTENT.HUMAN_QUESTION, {
      allowDeny: isOpencodeFamily(trustedAgentId),
      nativeFallback: true,
    });
  }

  if (decisionToolKind === DECISION_TOOL_KIND.EXIT_PLAN_MODE) {
    if (trustedAgentId === "claude-code") {
      return makeInteraction(INTERACTION_INTENT.PLAN_REVIEW, {
        autoTools: true,
        unattended: true,
        allowDeny: true,
        planFeedback: true,
        nativeFallback: true,
      });
    }
    if (trustedAgentId === "codebuddy") {
      return makeInteraction(INTERACTION_INTENT.PLAN_REVIEW, {
        nativeFallback: true,
      });
    }
    // No other adapter has a verified plan-review response contract. A name
    // collision must defer instead of inheriting Claude's UI/capabilities.
    return makeInteraction(INTERACTION_INTENT.UNKNOWN, {
      allowDeny: isOpencodeFamily(trustedAgentId),
      nativeFallback: true,
    });
  }

  // DeepSeek Harness and ZCode expose real blocking approval waterfalls, so
  // an explicit human Allow/Deny is actionable. Their tool taxonomies and
  // native-fallback semantics are not automation-audited: keep both global
  // modes false. Session grants reuse this eligibility and therefore defer too.
  if (trustedAgentId === "deepseek-harness" || trustedAgentId === "zcode") {
    return makeInteraction(INTERACTION_INTENT.TOOL_APPROVAL, {
      allowDeny: true,
      nativeFallback: true,
    });
  }

  if (trustedAgentId === "codebuddy") {
    return makeInteraction(INTERACTION_INTENT.TOOL_APPROVAL, {
      autoTools: true,
      unattended: true,
      allowDeny: true,
      nativeFallback: true,
    });
  }

  if (
    isKnownPermissionAgent(trustedAgentId)
    && isTrustedClaudeCompatibleToolApproval(trustedAgentId, trustedToolName)
  ) {
    return makeInteraction(INTERACTION_INTENT.TOOL_APPROVAL, {
      autoTools: true,
      unattended: true,
      allowDeny: true,
      nativeFallback: true,
    });
  }

  // A non-empty PermissionRequest from a Claude-compatible adapter is still
  // manually actionable even when its name is newer than this reviewed list.
  // auto-tools remains fail-closed so a newly introduced decision protocol
  // cannot be mistaken for an ordinary tool. Unattended intentionally keeps
  // the legacy "handle every request" behavior after all known decision tools
  // above have been classified.
  if (trustedAgentId === "claude-code" || trustedAgentId === "qwen-code") {
    return makeInteraction(INTERACTION_INTENT.UNKNOWN, {
      unattended: true,
      allowDeny: true,
      nativeFallback: true,
    });
  }

  return makeInteraction(INTERACTION_INTENT.UNKNOWN, {
    nativeFallback: true,
  });
}

function isValidInteraction(interaction) {
  if (!interaction || typeof interaction !== "object") return false;
  if (!Object.values(INTERACTION_INTENT).includes(interaction.intent)) return false;
  const eligibility = interaction.automationEligibility;
  if (!eligibility || typeof eligibility !== "object") return false;
  if (typeof eligibility.autoTools !== "boolean" || typeof eligibility.unattended !== "boolean") return false;
  const capabilities = interaction.capabilities;
  if (!capabilities || typeof capabilities !== "object") return false;
  return ["allowDeny", "answerQuestions", "planFeedback", "nativeFallback"]
    .every((key) => typeof capabilities[key] === "boolean");
}

function evaluatePermissionAutomation({ mode, interaction } = {}) {
  if (!Object.values(PERMISSION_AUTOMATION_MODE).includes(mode)) {
    return AUTOMATION_ACTION.DEFER;
  }
  if (!isValidInteraction(interaction) || mode === PERMISSION_AUTOMATION_MODE.OFF) {
    return AUTOMATION_ACTION.DEFER;
  }

  const eligibility = mode === PERMISSION_AUTOMATION_MODE.AUTO_TOOLS
    ? interaction.automationEligibility.autoTools
    : interaction.automationEligibility.unattended;
  if (!eligibility) return AUTOMATION_ACTION.DEFER;

  if (
    (
      interaction.intent === INTERACTION_INTENT.TOOL_APPROVAL
      || (
        mode === PERMISSION_AUTOMATION_MODE.UNATTENDED
        && interaction.intent === INTERACTION_INTENT.UNKNOWN
      )
    )
    && interaction.capabilities.allowDeny
  ) {
    return AUTOMATION_ACTION.AUTO_ALLOW;
  }

  if (
    mode === PERMISSION_AUTOMATION_MODE.UNATTENDED
    && interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION
    && interaction.capabilities.answerQuestions
  ) {
    return AUTOMATION_ACTION.AUTO_ANSWER;
  }

  if (
    mode === PERMISSION_AUTOMATION_MODE.UNATTENDED
    && interaction.intent === INTERACTION_INTENT.PLAN_REVIEW
    && interaction.capabilities.allowDeny
  ) {
    return AUTOMATION_ACTION.AUTO_ALLOW;
  }

  return AUTOMATION_ACTION.DEFER;
}

function isDecisionInteraction(interaction) {
  return isValidInteraction(interaction)
    && (
      interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION
      || interaction.intent === INTERACTION_INTENT.PLAN_REVIEW
    );
}

module.exports = {
  PERMISSION_AUTOMATION_MODE,
  INTERACTION_INTENT,
  AUTOMATION_ACTION,
  classifyPermissionInteraction,
  evaluatePermissionAutomation,
  isValidInteraction,
  isDecisionInteraction,
};
