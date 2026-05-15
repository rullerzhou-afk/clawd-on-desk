// test/helpers/load-focus-with-mock.js — Shared helper for focus.js test mocking
// focus.js destructures { execFile, spawn } at require-time, so we must
// patch child_process and process.platform BEFORE requiring focus.js.

function loadFocusWithMock(execFileMock, options = {}) {
  const cpKey = require.resolve("child_process");
  const focusKey = require.resolve("../../src/focus");
  const platform = options.platform || "darwin";

  const origCp = require.cache[cpKey];
  const origFocus = require.cache[focusKey];
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  const realCp = require("child_process");
  const patchedCp = { ...realCp, execFile: execFileMock, spawn: realCp.spawn };
  require.cache[cpKey] = { id: cpKey, filename: cpKey, loaded: true, exports: patchedCp };
  Object.defineProperty(process, "platform", {
    ...origPlatform,
    value: platform,
  });

  delete require.cache[focusKey];
  let initFocus;
  try {
    initFocus = require("../../src/focus");
  } finally {
    Object.defineProperty(process, "platform", origPlatform);
  }

  if (origCp) require.cache[cpKey] = origCp;
  else delete require.cache[cpKey];

  const cleanup = () => {
    if (origFocus) require.cache[focusKey] = origFocus;
    else delete require.cache[focusKey];
  };

  return { initFocus, cleanup };
}

module.exports = { loadFocusWithMock };
