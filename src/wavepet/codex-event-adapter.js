"use strict";

const {
  estimateTokens,
  extractCommand,
  classifyCall,
  inferSuccess,
} = require("./token-estimator");

function parseTimestampMs(value) {
  if (!value) return Date.now();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function extractTurnId(payload) {
  if (!payload || typeof payload !== "object") return null;
  const passthrough = payload.internal_chat_message_metadata_passthrough || {};
  return payload.turn_id || passthrough.turn_id || null;
}

function extractMessageText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (payload.message != null) return String(payload.message || "");
  if (typeof payload.text === "string") return payload.text;
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content.map((item) => {
    if (item && typeof item === "object") return String(item.text || "");
    return String(item || "");
  }).join("");
}

function extractReasoningChars(payload) {
  const summary = Array.isArray(payload && payload.summary) ? payload.summary : [];
  let total = 0;
  for (const item of summary) {
    if (item && typeof item === "object") total += String(item.text || "").length;
    else total += String(item || "").length;
  }
  if (total === 0 && payload && payload.encrypted_content) {
    total = Math.min(800, Math.max(40, String(payload.encrypted_content).length / 12));
  }
  return Math.round(total);
}

class CodexWavePetAdapter {
  constructor(options = {}) {
    this.sessionId = options.sessionId || "default";
    this.currentTurnId = "turn_0";
    this.seenAssistantTurns = new Set();
    this.openCalls = new Map();
    this.syntheticTurnCounter = 0;
  }

  base(event, timestampMs, extra = {}) {
    const turnId = extra.turn_id || this.currentTurnId;
    const out = {
      event,
      session_id: this.sessionId,
      turn_id: String(turnId),
      timestamp_ms: timestampMs,
    };
    for (const [key, value] of Object.entries(extra)) {
      if (key !== "turn_id" && value !== undefined) out[key] = value;
    }
    return out;
  }

  eventsFromRecord(record) {
    const payload = record && record.payload && typeof record.payload === "object" ? record.payload : {};
    const payloadType = String(payload.type || "");
    const recordType = String((record && record.type) || "");
    const timestampMs = parseTimestampMs(record && record.timestamp);
    const turnId = extractTurnId(payload) || this.currentTurnId;

    if (recordType === "event_msg" && payloadType === "user_message") {
      const text = String(payload.message || "");
      this.syntheticTurnCounter += 1;
      this.currentTurnId = `turn_${this.syntheticTurnCounter}`;
      this.seenAssistantTurns.delete(this.currentTurnId);
      return [this.base("user_message", timestampMs, {
        text_chars: text.length,
        token_estimate: estimateTokens(text),
      })];
    }

    if (recordType === "event_msg" && (payloadType === "task_complete" || payloadType === "turn_aborted")) {
      const finishReason = payloadType === "task_complete" ? "stop" : "aborted";
      return [
        this.base("task_end_signal", timestampMs, { source: payloadType, confidence: 1.0 }),
        this.base("assistant_end", timestampMs, { finish_reason: finishReason }),
      ];
    }

    if (payloadType === "message" || payloadType === "agent_message") {
      const role = String(payload.role || "assistant");
      const text = extractMessageText(payload);
      const events = [];
      if (role === "assistant" || payloadType === "agent_message") {
        if (!this.seenAssistantTurns.has(turnId)) {
          this.seenAssistantTurns.add(turnId);
          this.currentTurnId = String(turnId);
          events.push(this.base("assistant_start", timestampMs, { turn_id: turnId, mode: payload.phase || "" }));
        }
        if (text) {
          events.push(this.base("assistant_token_delta", timestampMs, {
            turn_id: turnId,
            delta_chars: text.length,
            delta_tokens_est: estimateTokens(text),
          }));
        }
      }
      return events;
    }

    if (payloadType === "reasoning") {
      const thinkingChars = extractReasoningChars(payload);
      if (thinkingChars <= 0) return [];
      this.currentTurnId = String(turnId);
      return [this.base("thinking_delta", timestampMs, {
        turn_id: turnId,
        delta_chars: thinkingChars,
        delta_tokens_est: Math.max(1, Math.round(thinkingChars / 4)),
      })];
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call" || payloadType === "web_search_call") {
      const callId = String(payload.call_id || payload.id || `${payloadType}:${timestampMs}`);
      const toolName = String(payload.name || payload.tool_name || payloadType);
      const command = extractCommand(payload.arguments || payload.input || "");
      const callKind = classifyCall(toolName, command);
      this.openCalls.set(callId, { timestampMs, toolName, callKind, command, turnId: String(turnId) });
      this.currentTurnId = String(turnId);
      return [this.base("tool_call_start", timestampMs, {
        turn_id: turnId,
        tool_name: toolName,
        call_kind: callKind,
        command,
      })];
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const callId = String(payload.call_id || "");
      const call = this.openCalls.get(callId) || {};
      if (callId) this.openCalls.delete(callId);
      const output = String(payload.output || "");
      const success = inferSuccess(output);
      const callKind = call.callKind || "tool";
      const toolName = call.toolName || payloadType;
      const outputTokens = estimateTokens(output);
      const durationMs = Math.max(0, timestampMs - (call.timestampMs || timestampMs));
      const effectiveTurnId = call.turnId || String(turnId);
      const events = [this.base("tool_call_end", timestampMs, {
        turn_id: effectiveTurnId,
        tool_name: toolName,
        call_kind: callKind,
        success,
        duration_ms: durationMs,
        output_tokens_est: outputTokens,
      })];
      if (callKind === "edit") events.push(this.base("file_edit", timestampMs, { turn_id: effectiveTurnId, edit_kind: "tool" }));
      else if (callKind === "test") events.push(this.base("test_run_end", timestampMs, {
        turn_id: effectiveTurnId,
        success,
        duration_ms: durationMs,
        output_tokens_est: outputTokens,
        failure_count_est: success ? 0 : 1,
      }));
      else if (!success) events.push(this.base("error_feedback", timestampMs, {
        turn_id: effectiveTurnId,
        error_kind: "tool_failure",
        severity: "high",
        token_estimate: Math.min(outputTokens, 600),
      }));
      return events;
    }

    return [];
  }
}

module.exports = {
  CodexWavePetAdapter,
  parseTimestampMs,
};
