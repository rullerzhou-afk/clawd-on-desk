"use strict";

const os = require("os");

const SECRET_PATTERNS = [
  [/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED]"],
  [/Bearer\s+\S+/gi, "Bearer [REDACTED]"],
  [/xoxb-\S+/g, "[REDACTED]"],
  [/ghp_[a-zA-Z0-9]{36}/g, "[REDACTED]"],
  [/github_pat_\S+/g, "[REDACTED]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED]"],
  [/"password"\s*:\s*"[^"]+"/gi, '"password": "[REDACTED]"'],
  [/"api[_-]?key"\s*:\s*"[^"]+"/gi, '"api_key": "[REDACTED]"'],
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactHomePaths(text, homeDir = os.homedir()) {
  let out = String(text);
  if (homeDir) {
    const normalized = homeDir.replace(/\\/g, "/");
    out = out.replace(new RegExp(escapeRegExp(homeDir) + String.raw`[\\/]?`, "gi"), "~/");
    out = out.replace(new RegExp(escapeRegExp(normalized) + String.raw`/?`, "gi"), "~/");
  }
  out = out.replace(/\b[A-Za-z]:\\Users\\[^\\/\s]+[\\/]/g, "~/");
  out = out.replace(/\/Users\/[^\/\s]+\/?/g, "~/");
  out = out.replace(/\/home\/[^\/\s]+\/?/g, "~/");
  return out;
}

function getRedactionRoots(options = {}) {
  const roots = [];
  if (typeof options.appRoot === "string" && options.appRoot) roots.push(options.appRoot);
  if (Array.isArray(options.appRoots)) {
    for (const entry of options.appRoots) {
      if (typeof entry === "string" && entry) roots.push(entry);
    }
  }
  return [...new Set(roots)]
    .map((entry) => entry.replace(/[\\/]+$/, ""))
    .filter((entry) => entry.length >= 3)
    .sort((a, b) => b.length - a.length);
}

function redactAppRootPaths(text, options = {}) {
  let out = String(text);
  for (const root of getRedactionRoots(options)) {
    const variants = [...new Set([root, root.replace(/\\/g, "/")])];
    for (const variant of variants) {
      out = out.replace(new RegExp(`${escapeRegExp(variant)}(?=[\\\\/]|$)`, "gi"), "[APP]");
    }
  }
  return out;
}

function redactIps(text) {
  return String(text).replace(
    /\b(?!(?:127\.0\.0\.1)\b)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
    "[IP]"
  );
}

function normalizeDisplayPathSeparators(text) {
  return String(text).replace(/(?:~\/|\[APP\](?=[\\/]))[^\s|;,)]+/g, (match) => {
    return match.replace(/\\/g, "/");
  });
}

function redact(input, options = {}) {
  let out = redactAppRootPaths(String(input == null ? "" : input), options);
  out = redactHomePaths(out, options.homeDir);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  out = redactIps(out);
  out = normalizeDisplayPathSeparators(out);
  return out;
}

function redactDoctorResult(value, options = {}) {
  if (typeof value === "string") return redact(value, options);
  if (Array.isArray(value)) return value.map((entry) => redactDoctorResult(entry, options));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactDoctorResult(entry, options);
  }
  return out;
}

function row(cells) {
  return `| ${cells.map((cell) => String(cell == null ? "" : cell).replace(/\|/g, "\\|")).join(" | ")} |`;
}

function statusLabel(check) {
  if (!check) return "UNKNOWN";
  if (check.status === "pass" || check.status === "ok") return "OK";
  if (check.level === "critical" || check.status === "critical") return "CRITICAL";
  if (check.level === "warning" || check.status === "warning" || check.status === "fail") return "WARNING";
  return String(check.status || "INFO").toUpperCase();
}

function findCheck(result, id) {
  return result && Array.isArray(result.checks)
    ? result.checks.find((check) => check && check.id === id)
    : null;
}

function pushIfValue(lines, label, value) {
  if (value === null || value === undefined || value === "") return;
  lines.push(`${label}: ${value}`);
}

function formatKiroScan(scan) {
  if (!scan || typeof scan !== "object") return null;
  const parts = [];
  if (Array.isArray(scan.fullyValidFiles) && scan.fullyValidFiles.length) {
    parts.push(`valid=${scan.fullyValidFiles.join(", ")}`);
  }
  if (Array.isArray(scan.brokenFiles) && scan.brokenFiles.length) {
    parts.push(`broken=${scan.brokenFiles.join(", ")}`);
  }
  if (Array.isArray(scan.corruptFiles) && scan.corruptFiles.length) {
    parts.push(`corrupt=${scan.corruptFiles.join(", ")}`);
  }
  if (Array.isArray(scan.noMarkerFiles) && scan.noMarkerFiles.length) {
    parts.push(`no-marker=${scan.noMarkerFiles.length}`);
  }
  return parts.length ? parts.join("; ") : null;
}

function formatAgentDiagnosticNotes(detail) {
  if (!detail || typeof detail !== "object") return [];
  const notes = [];
  pushIfValue(notes, "permission", detail.permissionBubbleDetail);
  if (detail.supplementary && typeof detail.supplementary === "object") {
    const key = detail.supplementary.key || "supplementary";
    const value = detail.supplementary.value || "unknown";
    const suffix = detail.supplementary.detail ? ` (${detail.supplementary.detail})` : "";
    notes.push(`${key}=${value}${suffix}`);
  }
  if (detail.codexHookTrust && typeof detail.codexHookTrust === "object") {
    const key = detail.codexHookTrust.key || "codex_hook_trust";
    const value = detail.codexHookTrust.value || "unknown";
    const suffix = detail.codexHookTrust.detail ? ` (${detail.codexHookTrust.detail})` : "";
    notes.push(`${key}=${value}${suffix}`);
  }
  pushIfValue(notes, "kiro", formatKiroScan(detail.kiroScan));
  pushIfValue(notes, "hook issue", detail.hookCommandIssue);
  // Field names are historical (checkOpencodeSettings); the label must stay
  // agent-neutral — mimocode reports through the same fields (R9 F3).
  pushIfValue(notes, "plugin issue", detail.opencodeEntryIssue);
  pushIfValue(notes, "plugin entry", detail.opencodeEntry);
  return notes;
}

function formatAgentDetail(detail) {
  if (!detail || typeof detail !== "object") return "";
  return [
    detail.detail,
    ...formatAgentDiagnosticNotes(detail),
  ].filter(Boolean).join("; ");
}

function hasHttpOutcomeEvents(connectionTest) {
  const events = Array.isArray(connectionTest && connectionTest.events) ? connectionTest.events : [];
  return events.some((event) => {
    if (!event || typeof event.outcome !== "string") return false;
    return event.outcome === "accepted" || event.outcome.startsWith("dropped-");
  });
}

function formatFileActivitySummary(fileActivity) {
  if (!Array.isArray(fileActivity) || !fileActivity.length) return "";
  return fileActivity
    .map((entry) => {
      const agent = entry && entry.agentId ? entry.agentId : "unknown";
      const count = entry && Number.isFinite(entry.count) ? entry.count : 0;
      return `${agent} (${count})`;
    })
    .join(", ");
}

function formatDiagnosticReport(result, meta = {}) {
  const generatedAt = result && result.generatedAt ? result.generatedAt : new Date().toISOString();
  const platform = meta.platform || process.platform;
  const release = meta.release || os.release();
  const locale = meta.locale || "en";
  const version = meta.version || "unknown";
  const overall = result && result.overall ? result.overall : { status: "unknown", issueCount: 0 };
  const checks = Array.isArray(result && result.checks) ? result.checks : [];

  const lines = [
    "# Clawd Diagnostic Report",
    "",
    `- Generated: ${generatedAt}`,
    `- Clawd version: ${version}`,
    `- Platform: ${platform} (${release})`,
    `- Locale: ${locale}`,
    "",
    "## Health Summary",
    "",
    `Overall: ${String(overall.status || "unknown").toUpperCase()} (${overall.issueCount || 0} issues)`,
    "",
    row(["Check", "Status", "Detail"]),
    row(["---", "---", "---"]),
  ];

  for (const check of checks) {
    lines.push(row([check.id || "unknown", statusLabel(check), check.detail || ""]));
  }

  const connectionTest = result && result.connectionTest ? result.connectionTest : null;
  if (connectionTest) {
    lines.push(
      "",
      "## Connection Test",
      "",
      row(["Status", "Detail"]),
      row(["---", "---"]),
      row([String(connectionTest.status || "unknown").toUpperCase(), connectionTest.detail || ""])
    );
    if (Array.isArray(connectionTest.events) && connectionTest.events.length) {
      lines.push(
        "",
        row(["Agent", "Route", "Outcome", "Event"]),
        row(["---", "---", "---", "---"])
      );
      for (const event of connectionTest.events) {
        lines.push(row([event.agentId || "", event.route || "", event.outcome || "", event.eventType || ""]));
      }
    }
    if (Array.isArray(connectionTest.fileActivity) && connectionTest.fileActivity.length) {
      if (hasHttpOutcomeEvents(connectionTest)) {
        lines.push(
          "",
          `Fallback file activity also observed: ${formatFileActivitySummary(connectionTest.fileActivity)}.`
        );
      } else {
        lines.push(
          "",
          row(["Agent", "Source", "Count"]),
          row(["---", "---", "---"])
        );
        for (const entry of connectionTest.fileActivity) {
          lines.push(row([entry.agentId || "", entry.source || "", entry.count || 0]));
        }
      }
    }
  }

  const agentCheck = findCheck(result, "agent-integrations");
  if (agentCheck && Array.isArray(agentCheck.details)) {
    lines.push(
      "",
      "## Agent Integrations",
      "",
      row(["Agent", "Source", "Status", "Detail"]),
      row(["---", "---", "---", "---"])
    );
    for (const detail of agentCheck.details) {
      lines.push(row([
        detail.agentName || detail.agentId,
        detail.eventSource || "",
        detail.status || "",
        formatAgentDetail(detail),
      ]));
    }
  }

  lines.push(
    "",
    "**Privacy notice**: This report is generated locally. Clawd does not upload any data. User paths are replaced with `~`, and Clawd app paths are replaced with `[APP]`. The report contains no API keys, tokens, conversation content, or document filenames."
  );

  return redact(lines.join("\n"), meta);
}

module.exports = {
  redact,
  redactDoctorResult,
  formatAgentDetail,
  formatAgentDiagnosticNotes,
  normalizeDisplayPathSeparators,
  formatDiagnosticReport,
};
