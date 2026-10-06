"use strict";

const { loadResumableSessionHistory, resolveResumeTarget } = require("./session-history-loader");

const RESUME_CONFIRMATION_MS = 30_000;

// One owner in main, surviving Dashboard recreation. Terminal spawn is only
// submission; the normal hook/state path is the evidence that a session is live.
function createSessionHistoryRuntime({ getSessions, isAgentEnabled, launchClaudeSession,
  historyOptions = {}, now = Date.now } = {}) {
  const launches = new Map();

  function activeIds() {
    const ids = new Set();
    for (const session of getSessions().values()) {
      if (session.agentId === "claude-code" && (session.profileId || "local") === "local"
        && !session.host && !session.wslDistro && session.rawSessionId) {
        ids.add(session.rawSessionId);
      }
    }
    for (const [historyKey, entry] of launches) {
      if (!entry.launching && (ids.has(entry.sessionId) || now() >= entry.retryAt)) {
        launches.delete(historyKey);
      }
    }
    return ids;
  }

  function getHistory() {
    const activeRawSessionIds = activeIds();
    return loadResumableSessionHistory({ ...historyOptions, isAgentEnabled, activeRawSessionIds })
      .map((row) => {
        // Live state currently identifies local Claude sessions by raw id,
        // not by CLAUDE_CONFIG_DIR. Treat every profile row with that raw id
        // as one conservative launch unit so two Dashboard clicks cannot
        // create processes that immediately collapse into the same live key.
        const pending = launches.get(row.historyKey)
          || [...launches.values()].find((entry) => entry.sessionId === row.sessionId);
        return { ...row, resumePending: !!pending, resumeRetryAt: pending?.retryAt || null };
      });
  }

  async function resume({ agentId, historyKey }) {
    if (agentId !== "claude-code" || !isAgentEnabled(agentId)) {
      return { status: "error", reason: "agent-unavailable" };
    }
    const target = resolveResumeTarget(agentId, historyKey, { ...historyOptions, isAgentEnabled });
    if (!target) return { status: "error", reason: "unresolvable" };
    if (activeIds().has(target.sessionId)) return { status: "already-running" };
    const pending = launches.get(historyKey);
    if (pending) return pending.promise;
    const sameSessionPending = [...launches.values()]
      .find((entry) => entry.sessionId === target.sessionId);
    if (sameSessionPending) return sameSessionPending.promise;
    // Bound memory even if a compromised trusted renderer asks for many rows.
    if (launches.size >= 200) return { status: "error", reason: "busy" };
    const entry = {
      sessionId: target.sessionId,
      launching: true,
      retryAt: now() + RESUME_CONFIRMATION_MS,
      promise: null,
    };
    launches.set(historyKey, entry);
    entry.promise = Promise.resolve().then(async () => {
      let submitted = false;
      try {
        // Gate again at dispatch, in case settings changed before this microtask.
        if (!isAgentEnabled(agentId)) return { status: "error", reason: "agent-unavailable" };
        if (activeIds().has(target.sessionId)) return { status: "already-running" };
        const result = await launchClaudeSession("resume", target.cwd, target.sessionId, target.profile);
        if (!result || result.ok !== true) {
          return { status: "error", reason: "launch-failed", message: result?.message };
        }
        entry.retryAt = now() + RESUME_CONFIRMATION_MS;
        submitted = true;
        return { status: "submitted", retryAt: entry.retryAt };
      } catch (err) {
        return { status: "error", reason: "launch-failed", message: err && err.message };
      } finally {
        entry.launching = false;
        if (!submitted) launches.delete(historyKey);
      }
    });
    return entry.promise;
  }

  return { getHistory, resume };
}

module.exports = { createSessionHistoryRuntime, RESUME_CONFIRMATION_MS };
