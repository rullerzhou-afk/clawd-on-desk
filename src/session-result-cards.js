"use strict";

const { randomUUID } = require("node:crypto");

// Result semantics are deliberately narrower than registry capabilities.
const COMPLETION_AGENTS = new Set(["claude-code", "codex", "kimi-cli", "grok-build"]);
const FAILURE_AGENTS = new Set(["claude-code", "kimi-cli", "grok-build"]);
const ACTIVITY_EVENTS = new Set([
  "UserPromptSubmit", "UserPromptExpansion", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "PostToolBatch",
  "event_msg:task_started", "event_msg:user_message", "event_msg:guardian_assessment",
  "event_msg:exec_command_end", "event_msg:patch_apply_end", "event_msg:custom_tool_call_output",
  "response_item:function_call", "response_item:custom_tool_call", "response_item:web_search_call",
]);
const ACTIVE_STATES = new Set(["thinking", "working", "juggling"]);
function localMain(entry) {
  return !!entry && (!entry.profileId || entry.profileId === "local")
    && !entry.host && !entry.wslDistro && !entry.headless
    && !entry.subagentId && !entry.subagentType && !entry.recapIsSubagent;
}
function createSessionResultCards(options = {}) {
  let enabled = options.enabled === true;
  const isAgentEnabled = options.isAgentEnabled || (() => true);
  const onChange = options.onChange || (() => {});
  const cards = new Map();
  const phases = new Map();
  let live = new Set();
  const maxCards = options.maxCards || 100;
  const maxPhases = options.maxPhases || 1000;
  let generation = 0;
  const keyOf = (input) => JSON.stringify([input.agentId, input.sessionId || input.id]);
  const changed = () => { try { onChange(); } catch {} };
  function prune() {
    while (cards.size > maxCards) cards.delete(cards.keys().next().value);
    for (const key of phases.keys()) {
      if (phases.size <= maxPhases) break;
      const phase = phases.get(key);
      if (!cards.has(key) && !live.has(phase.sessionId)) phases.delete(key);
    }
  }
  function observe(input, entry) {
    if (!input || !COMPLETION_AGENTS.has(input.agentId) || !localMain(input)) return;
    const key = keyOf(input);
    const previous = phases.get(key);
    let phase = previous && previous.phase;
    const event = input.event;
    const active = entry && localMain(entry) && ACTIVITY_EVENTS.has(event) && ACTIVE_STATES.has(entry.state);
    const cancelled = ((input.agentId === "kimi-cli" || input.agentId === "codex") && event === "Interrupt")
      || (input.agentId === "codex" && event === "event_msg:turn_aborted")
      || (input.agentId === "grok-build" && event === "StopCancelled");
    let kind = null;
    const matches = entry && localMain(entry) && entry.lastEvent
      && entry.lastEvent.rawEvent === event && entry.lastEvent.at === input.snapshotEventAt;
    if (matches && input.state === "attention" && entry.badge === "done"
      && (event === "Stop" || (input.agentId === "codex" && event === "event_msg:task_complete"))) {
      kind = "completed";
    }
    if (matches && entry.badge === "interrupted" && FAILURE_AGENTS.has(input.agentId)
      && (event === "StopFailure" || (input.agentId === "claude-code" && event === "ApiError"))) {
      kind = "failed";
    }
    if (!active && !cancelled && !kind) return;
    if (active) {
      phase = "active";
      cards.delete(key);
    } else if (cancelled) {
      if (input.agentId === "grok-build" && phase === "failed") return;
      phase = "cancelled";
      cards.delete(key);
    } else {
      if (phase === "cancelled" || phase === "failed" || phase === kind) return;
      phase = kind;
      if (enabled && isAgentEnabled(input.agentId)) {
        cards.delete(key);
        cards.set(key, {
          id: randomUUID(), generation: ++generation, sessionId: input.sessionId,
          agentId: input.agentId, kind, at: input.occurredAt,
          title: entry.displayTitle || entry.displayFolder || entry.agentName || input.agentId,
          agentName: entry.agentName || input.agentId,
          // Retain only validated navigation identity, never an old terminal PID.
          desktopIdentity: entry.agentId === "codex" ? {
            id: entry.id, rawSessionId: entry.rawSessionId, agentId: entry.agentId,
            codexOriginator: entry.codexOriginator, codexSource: entry.codexSource,
          } : null,
          opening: false, notice: null,
        });
      }
    }
    phases.delete(key);
    phases.set(key, { phase, sessionId: input.sessionId, agentId: input.agentId });
    prune();
    changed();
  }
  function onSnapshot(snapshot) {
    const entries = new Map((snapshot && snapshot.sessions || []).map(entry => [entry.id, entry]));
    live = new Set(entries.keys());
    for (const card of cards.values()) {
      const entry = entries.get(card.sessionId);
      if (entry && entry.agentId === card.agentId) {
        card.title = entry.displayTitle || entry.displayFolder || entry.agentName || card.title;
        card.agentName = entry.agentName || card.agentName;
      }
    }
    prune();
    changed();
  }
  function find(id, version) {
    return [...cards.values()].find(card => card.id === id && card.generation === version) || null;
  }
  function dismiss(id, version) {
    const card = find(id, version);
    if (!card) return false;
    cards.delete(keyOf(card));
    changed();
    return true;
  }
  function update(id, version, patch) {
    const card = find(id, version);
    if (!card) return false;
    Object.assign(card, patch);
    changed();
    return true;
  }
  function syncSettings(nextEnabled) {
    enabled = nextEnabled === true;
    for (const [key, card] of cards) {
      if (!enabled || !isAgentEnabled(card.agentId)) cards.delete(key);
    }
    changed();
  }
  return {
    observe, onSnapshot, find, dismiss, update, syncSettings,
    list: () => [...cards.values()].reverse().map(card => ({ ...card })),
    clear: () => { cards.clear(); phases.clear(); live.clear(); changed(); },
  };
}
module.exports = { createSessionResultCards };
