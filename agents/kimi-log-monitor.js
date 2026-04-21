// Kimi log monitor is intentionally disabled in hook-only mode.
// Keep this stub file so older requires do not crash and rollback is easy.

class KimiLogMonitor {
  constructor() {}
  start() {}
  stop() {}
}

module.exports = KimiLogMonitor;
