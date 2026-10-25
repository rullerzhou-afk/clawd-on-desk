"use strict";

function checkLocalServer(serverApi) {
  const status = serverApi && typeof serverApi.getRuntimeStatus === "function"
    ? serverApi.getRuntimeStatus()
    : null;

  if (!status || !status.listening) {
    const failure = status && status.startupFailure;
    const attempts = status && Array.isArray(status.bindAttempts) ? status.bindAttempts : [];
    const denied = attempts.some((attempt) => attempt.code === "EACCES");
    const detail = failure && failure.stage === "runtime"
      ? `Local server closed: runtime publication failed (${status.runtimePath})`
      : "Local server is not listening" + (attempts.length
        ? `; bind attempts: ${attempts.map(({ port, code }) => `${port === 0 ? "system-assigned" : port}: ${code}`).join(", ")}` : "");
    return {
      id: "local-server",
      status: "fail",
      level: "critical",
      detail,
      textHint: denied
        ? "Restart Clawd. EACCES can mean reserved ports, permission policies or exclusive listeners. On Windows, inspect (read-only): netsh interface ipv4 show excludedportrange protocol=tcp."
        : failure && failure.stage === "bind"
          ? "Restart Clawd and check the reported bind errors and local port availability."
          : "Restart Clawd. If the issue persists, check ~/.clawd/ permissions.",
      runtime: status,
      fixAction: { type: "restart-clawd" },
    };
  }

  // #681: the same warning branch now also covers runtime IDENTITY, not just
  // the port. Hooks gate their process-tree snapshot on a readable app +
  // ownerPid whose owner is alive; a file that is missing ownerPid, or names a
  // dead/foreign owner, reads as "Clawd is offline" to every hook — so terminal
  // focus silently stops working for new sessions even though this server is
  // listening. Same level, same Fix, one extra sentence of detail.
  const identityBroken = !status.runtimeIdentityValid || !status.runtimeOwnerAlive;
  if (!status.runtimeFileExists || !status.runtimeMatches || identityBroken) {
    const identityDetail = identityBroken
      ? `; runtime owner is ${status.runtimeOwnerPid ? `${status.runtimeOwnerPid} (not running)` : "missing"}`
        + " — hooks will omit process metadata"
      : "";
    return {
      id: "local-server",
      status: "fail",
      level: "warning",
      detail: `Listening on 127.0.0.1:${status.port}; runtime port is ${status.runtimePort || "missing"}${identityDetail}`,
      textHint: "Restart Clawd to regenerate the runtime file.",
      runtime: status,
      fixAction: { type: "local-server" },
    };
  }

  return {
    id: "local-server",
    status: "pass",
    level: null,
    detail: `Listening on 127.0.0.1:${status.port}`,
    runtime: status,
  };
}

module.exports = { checkLocalServer };
