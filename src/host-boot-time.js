"use strict";

const os = require("os");

// `os.uptime()` can fail in restricted sandboxes (uv_uptime EPERM). A missing
// boot estimate must never stop startup; the monitor treats null as "no boot
// boundary", which is how it behaved before the boundary existed.
function estimateHostBootTimeMs({ now = Date.now, uptime = os.uptime } = {}) {
  try {
    const bootTimeMs = Math.floor(now() - uptime() * 1000);
    return Number.isFinite(bootTimeMs) ? bootTimeMs : null;
  } catch {
    return null;
  }
}

module.exports = { estimateHostBootTimeMs };
