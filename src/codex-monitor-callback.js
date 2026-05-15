"use strict";

function isCodexMonitorPermissionEvent(state) {
  return state === "codex-permission";
}

function buildCodexMonitorUpdateOptions(extra, options = {}) {
  const input = extra && typeof extra === "object" ? extra : {};
  const out = {
    cwd: input.cwd,
    agentId: "codex",
    sessionTitle: input.sessionTitle,
  };
  if (Object.prototype.hasOwnProperty.call(input, "sourcePid")) out.sourcePid = input.sourcePid;
  if (Object.prototype.hasOwnProperty.call(input, "agentPid")) out.agentPid = input.agentPid;
  if (Object.prototype.hasOwnProperty.call(input, "pidChain")) out.pidChain = input.pidChain;
  if (Object.prototype.hasOwnProperty.call(input, "codexOriginator")) out.codexOriginator = input.codexOriginator;
  if (Object.prototype.hasOwnProperty.call(input, "codexSource")) out.codexSource = input.codexSource;
  if (options.includeHeadless) out.headless = input.headless === true;
  return out;
}

module.exports = {
  buildCodexMonitorUpdateOptions,
  isCodexMonitorPermissionEvent,
};
