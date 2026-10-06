#!/usr/bin/env node
// Probes whether the Windows-side Clawd HTTP server is reachable from this
// environment. Prints "REACHABLE <port>" and exits 0, or "UNREACHABLE" and
// exits 1.
//
// Why this exists: under WSL2's default NAT networking, localhost belongs to
// the WSL VM, so the Windows-side server (bound to 127.0.0.1) refuses every
// connection and hooks silently fail to report. Only mirrored networking
// (.wslconfig: networkingMode=mirrored) shares loopback. wsl-deploy runs this
// right after install so the Settings UI can turn that silent failure into an
// actionable warning. Verified on a real NAT-mode Windows 11 + WSL2 machine.

const http = require("http");
const { CLAWD_SERVER_HEADER, CLAWD_SERVER_ID, SERVER_PORTS } = require("./server-config");

const TIMEOUT_MS = 1500;
let remaining = SERVER_PORTS.length;
let done = false;

function finish(reachable, port) {
  if (done) return;
  done = true;
  console.log(reachable ? `REACHABLE ${port}` : "UNREACHABLE");
  process.exit(reachable ? 0 : 1);
}

for (const port of SERVER_PORTS) {
  const req = http.get(
    { host: "127.0.0.1", port, path: "/state", timeout: TIMEOUT_MS },
    (res) => {
      res.resume();
      if (res.headers[CLAWD_SERVER_HEADER] === CLAWD_SERVER_ID) {
        finish(true, port);
        return;
      }
      // A response without our header is some other service on that port.
      if (--remaining === 0) finish(false);
    }
  );
  // destroy() surfaces as an 'error' event, which does the accounting —
  // decrementing here too would double-count the port.
  req.on("timeout", () => req.destroy());
  req.on("error", () => {
    if (--remaining === 0) finish(false);
  });
}
