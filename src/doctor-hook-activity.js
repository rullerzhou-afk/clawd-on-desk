"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_CONNECTION_TEST_DURATION_MS = 10000;
const MAX_CONNECTION_TEST_DURATION_MS = 30000;

function clampDurationMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONNECTION_TEST_DURATION_MS;
  return Math.max(1000, Math.min(MAX_CONNECTION_TEST_DURATION_MS, Math.floor(n)));
}

function wait(ms, setTimeoutFn = setTimeout) {
  return new Promise((resolve) => setTimeoutFn(resolve, ms));
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort();
}

function readDirSafe(fsApi, dir) {
  try {
    return fsApi.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statMtimeMs(fsApi, filePath) {
  try {
    const stat = fsApi.statSync(filePath);
    return stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function isDirectoryEntry(entry, fsApi, fullPath) {
  if (entry && typeof entry.isDirectory === "function") return entry.isDirectory();
  try {
    const stat = fsApi.statSync(fullPath);
    return !!(stat && stat.isDirectory && stat.isDirectory());
  } catch {
    return false;
  }
}

function isFileEntry(entry, fsApi, fullPath) {
  if (entry && typeof entry.isFile === "function") return entry.isFile();
  try {
    const stat = fsApi.statSync(fullPath);
    return !!(stat && stat.isFile && stat.isFile());
  } catch {
    return false;
  }
}

function findRecentMatchingFiles(options = {}) {
  const fsApi = options.fs || fs;
  const pathApi = options.path || path;
  const rootDir = options.rootDir;
  const since = Number.isFinite(options.since) ? options.since : 0;
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 4;
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 1000;
  const predicate = typeof options.predicate === "function" ? options.predicate : () => false;
  if (!rootDir) return [];

  const out = [];
  const stack = [{ dir: rootDir, depth: 0 }];
  let visited = 0;
  while (stack.length && visited < maxEntries) {
    const current = stack.pop();
    const entries = readDirSafe(fsApi, current.dir)
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const entry of entries) {
      if (visited >= maxEntries) break;
      visited++;
      const name = String(entry.name || "");
      if (!name) continue;
      const fullPath = pathApi.join(current.dir, name);
      if (isDirectoryEntry(entry, fsApi, fullPath)) {
        if (current.depth < maxDepth) stack.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }
      if (!isFileEntry(entry, fsApi, fullPath)) continue;
      if (!predicate(name, fullPath, current.depth)) continue;
      const mtimeMs = statMtimeMs(fsApi, fullPath);
      if (Number.isFinite(mtimeMs) && mtimeMs >= since) out.push({ path: fullPath, mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function summarizeActivity(agentId, files) {
  if (!Array.isArray(files) || !files.length) return null;
  return {
    agentId,
    source: "file-mtime",
    count: files.length,
    latestMtime: Math.max(...files.map((file) => file.mtimeMs).filter(Number.isFinite)),
  };
}

function scanCodexMtimeActivity(options = {}) {
  const pathApi = options.path || path;
  const homeDir = options.homeDir || os.homedir();
  const rootDir = pathApi.join(homeDir, ".codex", "sessions");
  const files = findRecentMatchingFiles({
    ...options,
    rootDir,
    maxDepth: 4,
    maxEntries: 1500,
    predicate: (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
  });
  return summarizeActivity("codex", files);
}

function scanFileMtimeActivity(options = {}) {
  return [
    scanCodexMtimeActivity(options),
  ].filter(Boolean);
}

function eventSummary(events, resolveAgentDisplayName) {
  const resolve = typeof resolveAgentDisplayName === "function" ? resolveAgentDisplayName : (agentId) => agentId;
  const agents = uniqueSorted(events.map((event) => resolve(event.agentId)));
  const outcomes = uniqueSorted(events.map((event) => event.outcome));
  return { agents, outcomes };
}

function evaluateConnectionTest(input = {}) {
  const events = Array.isArray(input.events) ? input.events : [];
  const fileActivity = Array.isArray(input.fileActivity) ? input.fileActivity : [];
  const accepted = events.filter((event) => event && event.outcome === "accepted");
  const dropped = events.filter((event) => event && typeof event.outcome === "string" && event.outcome.startsWith("dropped-"));

  if (accepted.length) {
    const summary = eventSummary(accepted, input.resolveAgentDisplayName);
    return {
      status: "http-verified",
      level: null,
      detail: `HTTP path verified (${accepted.length} accepted event${accepted.length === 1 ? "" : "s"}${summary.agents.length ? `: ${summary.agents.join(", ")}` : ""}).`,
    };
  }

  if (dropped.length) {
    const summary = eventSummary(dropped, input.resolveAgentDisplayName);
    return {
      status: "http-dropped",
      level: "warning",
      detail: `HTTP works but events were dropped (${summary.outcomes.join(", ")}${summary.agents.length ? `: ${summary.agents.join(", ")}` : ""}).`,
    };
  }

  const codexActivity = fileActivity.some((entry) => entry && entry.agentId === "codex");
  const codexHookHealth = input.codexHookHealth && typeof input.codexHookHealth === "object"
    ? input.codexHookHealth
    : null;
  if (codexActivity && codexHookHealth && codexHookHealth.signature === "needs-review") {
    return {
      status: "hooks-need-review",
      level: "warning",
      detail: "Codex activity was detected, but Clawd cannot evaluate the HTTP path because its Codex hooks still need review. Run /hooks in Codex CLI, review the Clawd hooks, then run this test again. This result does not rule out a separate firewall or proxy issue.",
    };
  }

  if (fileActivity.length) {
    const agents = uniqueSorted(fileActivity.map((entry) => entry.agentId));
    return {
      status: "http-blocked",
      level: "warning",
      detail: `File activity changed for ${agents.join(", ")}, but no HTTP hook event reached Clawd. Firewall, EDR, or proxy interception is likely.`,
    };
  }

  return {
    status: "no-activity",
    level: "warning",
    detail: "No hook HTTP event or fallback log file activity was detected during the test window.",
  };
}

async function runConnectionTest(options = {}) {
  const nowFn = typeof options.now === "function" ? options.now : Date.now;
  const durationMs = clampDurationMs(options.durationMs);
  const startedAt = Number.isFinite(options.startedAt) ? options.startedAt : nowFn();
  await wait(durationMs, options.setTimeout || setTimeout);
  const endedAt = nowFn();
  const serverEvents = options.server && typeof options.server.getRecentHookEvents === "function"
    ? options.server.getRecentHookEvents({ since: startedAt })
    : [];
  const events = Array.isArray(options.events) ? options.events : serverEvents;
  const fileActivity = Array.isArray(options.fileActivity)
    ? options.fileActivity
    : scanFileMtimeActivity({ ...options, since: startedAt });
  let codexHookHealth = options.codexHookHealth;
  if (typeof options.getCodexHookHealth === "function") {
    try {
      codexHookHealth = options.getCodexHookHealth();
    } catch {
      codexHookHealth = null;
    }
  }
  const evaluated = evaluateConnectionTest({
    events,
    fileActivity,
    codexHookHealth,
    resolveAgentDisplayName: options.resolveAgentDisplayName,
  });
  return {
    id: "hook-event-waterline",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs,
    ...evaluated,
    events: events.slice(-20).map((event) => ({ ...event })),
    fileActivity: fileActivity.map((entry) => ({ ...entry })),
  };
}

function createConnectionTestDeduper(runTest = runConnectionTest, options = {}) {
  const onResult = typeof options.onResult === "function" ? options.onResult : null;
  let pending = null;
  return function runDedupedConnectionTest(input = {}) {
    // Single-flight: concurrent calls share the first invocation's result.
    if (pending) return pending;
    try {
      pending = Promise.resolve(runTest(input))
        .then((result) => {
          if (onResult) onResult(result);
          return result;
        })
        .finally(() => {
          pending = null;
        });
    } catch (err) {
      pending = Promise.reject(err)
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
}

module.exports = {
  DEFAULT_CONNECTION_TEST_DURATION_MS,
  MAX_CONNECTION_TEST_DURATION_MS,
  clampDurationMs,
  createConnectionTestDeduper,
  evaluateConnectionTest,
  findRecentMatchingFiles,
  runConnectionTest,
  scanFileMtimeActivity,
};
