// test/helpers/load-shared-process-with-mock.js
//
// Patches child_process.execFileSync, process.env (TMUX/TMUX_PANE plus any
// keys passed via `env`), and process.platform before requiring
// shared-process.js. This is the
// equivalent of load-focus-with-mock.js but for the hook-side resolver.

function loadSharedProcessWithMock({ execFileSyncMock, env, platform }) {
  const cpKey = require.resolve("child_process");
  const spKey = require.resolve("../../hooks/shared-process");

  const origCp = require.cache[cpKey];
  const origSp = require.cache[spKey];
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  const envKeys = [...new Set(["TMUX", "TMUX_PANE", ...(env ? Object.keys(env) : [])])];
  const savedEnv = {};
  for (const k of envKeys) savedEnv[k] = process.env[k];

  const realCp = require("child_process");
  require.cache[cpKey] = {
    id: cpKey,
    filename: cpKey,
    loaded: true,
    exports: { ...realCp, execFileSync: execFileSyncMock },
  };
  if (platform) {
    Object.defineProperty(process, "platform", { ...origPlatform, value: platform });
  }
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined || v === null) delete process.env[k];
      else process.env[k] = v;
    }
  }

  delete require.cache[spKey];
  const mod = require("../../hooks/shared-process");

  // Keep cp cache and process.platform patched until cleanup() — shared-process's
  // resolve() function re-requires child_process at call time and the factory
  // captures isWin/isLinux at construction time, so both must stay patched
  // through the test body.
  const cleanup = () => {
    if (origSp) require.cache[spKey] = origSp;
    else delete require.cache[spKey];
    if (origCp) require.cache[cpKey] = origCp;
    else delete require.cache[cpKey];
    if (platform) Object.defineProperty(process, "platform", origPlatform);
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  };

  return { mod, cleanup };
}

module.exports = { loadSharedProcessWithMock };
