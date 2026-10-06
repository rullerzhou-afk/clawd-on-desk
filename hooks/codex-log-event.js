"use strict";

// Keep both JSONL monitors on the same canonical key for compaction completion.
// Checkpoints and copied response items are not live completion signals.
function getCodexLogEventKey(type, payload) {
  const subtype = payload && typeof payload === "object" ? payload.type || "" : "";
  if (
    type === "event_msg"
    && subtype === "item_completed"
    && payload.item
    && typeof payload.item === "object"
    && payload.item.type === "ContextCompaction"
  ) {
    return "event_msg:context_compacted";
  }
  return subtype ? type + ":" + subtype : type;
}

module.exports = { getCodexLogEventKey };
