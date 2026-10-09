// Test preloader: spies on applyOrcaPaneKey calls from the hook under test,
// recording each call's event name as JSON lines in CLAWD_TEST_ORCA_RECORD.
// Also stubs createPidResolver with a no-metadata resolver so Orca coverage
// needs no PowerShell snapshot and no runtime identity. Everything else in
// shared-process passes through untouched via prototype delegation.
const Module = require("module");
const fs = require("fs");

const recordPath = process.env.CLAWD_TEST_ORCA_RECORD;
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request === "./shared-process" || request.endsWith("shared-process")) {
    const wrapped = Object.create(loaded);
    wrapped.applyOrcaPaneKey = (body) => {
      if (recordPath) {
        try {
          fs.appendFileSync(recordPath, JSON.stringify({ event: body && body.event }) + "\n");
        } catch {}
      }
      return loaded.applyOrcaPaneKey(body);
    };
    wrapped.createPidResolver = () => () => ({});
    return wrapped;
  }
  return loaded;
};
