"use strict";

const ACTIVE_STATES = new Set([
  "thinking",
  "working",
  "juggling",
  "sweeping",
  "attention",
  "notification",
  "error",
  "carrying",
  "codex-permission",
]);

function finiteToken(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const INVALID_TOKEN = Symbol("invalid-token");

function firstToken(source, keys) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = finiteToken(source[key]);
    if (value !== null) return value;
    return INVALID_TOKEN;
  }
  return null;
}

function candidateTokenSources(input) {
  const sources = [];
  if (!input || typeof input !== "object") return sources;
  sources.push(input);
  for (const key of ["token_usage", "tokenUsage", "usage", "tokens"]) {
    if (input[key] && typeof input[key] === "object") sources.push(input[key]);
  }
  return sources;
}

function normalizeTokenUsage(input) {
  for (const source of candidateTokenSources(input)) {
    const inputTokens = firstToken(source, [
      "input",
      "input_tokens",
      "prompt_tokens",
      "promptTokenCount",
      "prompt_token_count",
    ]);
    const outputTokens = firstToken(source, [
      "output",
      "output_tokens",
      "completion_tokens",
      "candidatesTokenCount",
      "candidates_token_count",
    ]);
    const totalTokens = firstToken(source, [
      "total",
      "total_tokens",
      "totalTokenCount",
      "total_token_count",
    ]);

    if (
      inputTokens === INVALID_TOKEN ||
      outputTokens === INVALID_TOKEN ||
      totalTokens === INVALID_TOKEN
    ) {
      return null;
    }

    if (inputTokens !== null || outputTokens !== null) {
      const inputValue = inputTokens ?? 0;
      const outputValue = outputTokens ?? 0;
      return {
        input: inputValue,
        output: outputValue,
        total: totalTokens ?? inputValue + outputValue,
        hasInputOutput: true,
      };
    }

    if (totalTokens !== null) {
      return {
        input: null,
        output: null,
        total: totalTokens,
        hasInputOutput: false,
      };
    }
  }
  return null;
}

function localDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function makeTotals() {
  return {
    tokens: 0,
    input: 0,
    output: 0,
    sessionMs: 0,
    activeMs: 0,
  };
}

function makeAgent(agentId) {
  return {
    agentId,
    input: 0,
    output: 0,
    tokens: 0,
    sessionMs: 0,
    activeMs: 0,
  };
}

function ensureDay(days, day) {
  if (!days.has(day)) {
    days.set(day, {
      day,
      totals: makeTotals(),
      agents: new Map(),
    });
  }
  return days.get(day);
}

function ensureAgent(dayEntry, agentId) {
  const id = agentId || "unknown";
  if (!dayEntry.agents.has(id)) dayEntry.agents.set(id, makeAgent(id));
  return dayEntry.agents.get(id);
}

function addToken(days, day, agentId, usage) {
  const dayEntry = ensureDay(days, day);
  const agent = ensureAgent(dayEntry, agentId);
  dayEntry.totals.tokens += usage.total;
  agent.tokens += usage.total;
  if (usage.hasInputOutput) {
    dayEntry.totals.input += usage.input;
    dayEntry.totals.output += usage.output;
    agent.input += usage.input;
    agent.output += usage.output;
  }
}

function nextLocalMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function addDuration(days, start, end, agentId, field) {
  let cursor = start;
  while (cursor < end) {
    const next = Math.min(end, nextLocalMidnight(cursor));
    const delta = Math.max(0, next - cursor);
    const dayEntry = ensureDay(days, localDayKey(cursor));
    const agent = ensureAgent(dayEntry, agentId);
    dayEntry.totals[field] += delta;
    agent[field] += delta;
    cursor = next;
  }
}

function cloneDays(days) {
  const cloned = new Map();
  for (const [day, entry] of days.entries()) {
    const out = ensureDay(cloned, day);
    Object.assign(out.totals, entry.totals);
    for (const [agentId, agent] of entry.agents.entries()) {
      Object.assign(ensureAgent(out, agentId), agent);
    }
  }
  return cloned;
}

function serializeDay(dayEntry) {
  return {
    day: dayEntry.day,
    totals: { ...dayEntry.totals },
    agents: Array.from(dayEntry.agents.values())
      .map((agent) => ({ ...agent }))
      .sort((a, b) =>
        b.tokens - a.tokens ||
        b.sessionMs - a.sessionMs ||
        b.activeMs - a.activeMs ||
        String(a.agentId).localeCompare(String(b.agentId))
      ),
  };
}

function dayKeyForOffset(now, offset) {
  const d = new Date(now);
  d.setDate(d.getDate() - offset);
  return localDayKey(d.getTime());
}

function safeAt(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function sessionKey(event) {
  return [
    event.host || "",
    event.agentId || "unknown",
    event.sessionId || "default",
  ].join("|");
}

function isEndState(event) {
  return event.event === "SessionEnd" ||
    event.event === "stale-cleanup" ||
    event.state === "sleeping";
}

function safeLedgerPayload(entry) {
  const at = safeAt(entry.at, Date.now());
  const payload = {
    type: entry.type === "token" ? "token" : "state",
    at,
    agentId: typeof entry.agentId === "string" && entry.agentId ? entry.agentId : "unknown",
    sessionId: typeof entry.sessionId === "string" && entry.sessionId ? entry.sessionId : "default",
  };
  if (typeof entry.host === "string" && entry.host) payload.host = entry.host;
  if (typeof entry.state === "string" && entry.state) payload.state = entry.state;
  if (typeof entry.event === "string" && entry.event) payload.event = entry.event;
  if (typeof entry.usageEventId === "string" && entry.usageEventId) {
    payload.usageEventId = entry.usageEventId;
  }
  const tokenUsage = normalizeTokenUsage(entry.tokenUsage || entry);
  if (tokenUsage) payload.tokenUsage = tokenUsage;
  return payload;
}

function encodeLedgerEntry(entry) {
  return `${JSON.stringify(safeLedgerPayload(entry))}\n`;
}

function createUsageAnalytics(options = {}) {
  const days = new Map();
  const sessions = new Map();
  const seenTokenEvents = new Set();

  function now() {
    return typeof options.now === "function" ? options.now() : Date.now();
  }

  function tokenEventKey(event, usage, at) {
    if (typeof event.usageEventId === "string" && event.usageEventId) {
      return event.usageEventId;
    }
    return [
      event.host || "",
      event.agentId || "unknown",
      event.sessionId || "default",
      at,
      usage.total,
      usage.input ?? "",
      usage.output ?? "",
    ].join("|");
  }

  function recordToken(event = {}) {
    const tokenUsage = normalizeTokenUsage(event.tokenUsage || event);
    if (!tokenUsage) return false;
    const at = safeAt(event.at, now());
    const key = tokenEventKey(event, tokenUsage, at);
    if (seenTokenEvents.has(key)) return false;
    seenTokenEvents.add(key);
    addToken(days, localDayKey(at), event.agentId, tokenUsage);
    return true;
  }

  function recordState(event = {}) {
    const at = safeAt(event.at, now());
    const key = sessionKey(event);
    const existing = sessions.get(key);
    if (existing && at >= existing.at) {
      addDuration(days, existing.at, at, existing.agentId, "sessionMs");
      if (ACTIVE_STATES.has(existing.state)) {
        addDuration(days, existing.at, at, existing.agentId, "activeMs");
      }
    }
    if (isEndState(event)) {
      sessions.delete(key);
    } else {
      sessions.set(key, {
        at,
        state: event.state || "idle",
        agentId: event.agentId || "unknown",
      });
    }
    if (event.tokenUsage) recordToken(event);
    return true;
  }

  function loadLedgerLines(lines, options = {}) {
    for (const line of lines || []) {
      if (!line || !String(line).trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry && entry.type === "token") recordToken(entry);
      else if (entry && entry.type === "state") recordState(entry);
    }
    if (options.keepOpenSessions === false) {
      sessions.clear();
    }
  }

  function projectedDays(at) {
    const projected = cloneDays(days);
    for (const session of sessions.values()) {
      if (at <= session.at) continue;
      addDuration(projected, session.at, at, session.agentId, "sessionMs");
      if (ACTIVE_STATES.has(session.state)) {
        addDuration(projected, session.at, at, session.agentId, "activeMs");
      }
    }
    return projected;
  }

  function getSnapshot(input = {}) {
    const at = safeAt(input.now, now());
    const count = Math.max(1, Math.floor(input.days || 7));
    const projected = projectedDays(at);
    const todayKey = localDayKey(at);
    const outDays = [];
    for (let i = count - 1; i >= 0; i--) {
      const key = dayKeyForOffset(at, i);
      outDays.push(serializeDay(projected.get(key) || ensureDay(new Map(), key)));
    }
    return {
      generatedAt: at,
      today: serializeDay(projected.get(todayKey) || ensureDay(new Map(), todayKey)),
      days: outDays,
    };
  }

  return {
    recordState,
    recordToken,
    loadLedgerLines,
    getSnapshot,
  };
}

module.exports = {
  ACTIVE_STATES,
  createUsageAnalytics,
  encodeLedgerEntry,
  localDayKey,
  normalizeTokenUsage,
};
