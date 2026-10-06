"use strict";

// DeepSeek Harness runs two carriers (web profile and desktop app) behind one
// agent id. The bridge reports which profile it was loaded into so Clawd can
// offer an application-window jump only for the desktop carrier.
const DSH_CARRIER_DESKTOP = "desktop";
const DSH_AGENT_ID = "deepseek-harness";
const DSH_HOOK_SOURCE = "dsh-plugin";

// The carrier is trusted only when the request is the DSH bridge's own local,
// non-WSL traffic. Remote SSH and WSL both name processes on another machine,
// so a "desktop" label there would point the app-focus target at a window that
// is not on this computer. Every other combination is treated as absent.
function resolveDshCarrier({ agentId, hookSource, value, remoteProfile, wslSourced } = {}) {
  if (value !== DSH_CARRIER_DESKTOP) return null;
  if (agentId !== DSH_AGENT_ID) return null;
  if (hookSource !== DSH_HOOK_SOURCE) return null;
  if (remoteProfile) return null;
  if (wslSourced) return null;
  return DSH_CARRIER_DESKTOP;
}

module.exports = {
  DSH_AGENT_ID,
  DSH_CARRIER_DESKTOP,
  DSH_HOOK_SOURCE,
  resolveDshCarrier,
};
