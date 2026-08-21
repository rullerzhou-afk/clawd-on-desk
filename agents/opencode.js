// opencode agent configuration
// Perception via opencode Plugin SDK: event hook → HTTP POST to Clawd
// Plugin registered in ~/.config/opencode/opencode.json "plugin" array (global scope)
//
// eventMap/capabilities are the shared opencode-family contract — identical
// for every family member, sourced from ./opencode-family so they can't drift
// (see docs/project/agent-runtime-architecture.md).

const { FAMILY_EVENT_MAP, FAMILY_CAPABILITIES } = require("./opencode-family");

module.exports = {
  id: "opencode",
  name: "OpenCode",
  processNames: { win: ["opencode.exe"], mac: ["opencode"], linux: ["opencode"] },
  startupRecoveryProcessNames: { win: ["opencode.exe"], mac: ["opencode"], linux: ["opencode"] },
  eventSource: "plugin-event",
  eventMap: FAMILY_EVENT_MAP,
  capabilities: FAMILY_CAPABILITIES,
  pidField: "opencode_pid",
};
