"use strict";

// #1275: observe the active native Space without creating the private Space
// used by mac-window.js; loading that path would change the pet's visibility.
function loadSkyLight() {
  const koffi = require("koffi");
  const lib = koffi.load("/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/SkyLight");
  return {
    SLSMainConnectionID: lib.func("SLSMainConnectionID", "int", []),
    SLSGetActiveSpace: lib.func("SLSGetActiveSpace", "uint64", ["int"]),
    SLSSpaceGetType: lib.func("SLSSpaceGetType", "int", ["int", "uint64"]),
  };
}

function createMacFullscreenProbe(options = {}) {
  const isMac = options.isMac != null ? !!options.isMac : process.platform === "darwin";
  let loadAttempted = false;
  let api = null;
  let lastObservation = { reliable: false, foregroundId: null, fullscreenId: null };

  function isForegroundFullscreen() {
    lastObservation = { reliable: false, foregroundId: null, fullscreenId: null };
    if (!isMac) return false;
    if (!loadAttempted) {
      // #1275: a missing framework must not trigger a load and warning each
      // second. Default settings never call the probe, so keep loading lazy.
      loadAttempted = true;
      try {
        api = (options.loadSkyLight || loadSkyLight)();
      } catch (err) {
        if (typeof options.onError === "function") options.onError(err);
      }
    }
    if (!api) return false;
    try {
      const cid = api.SLSMainConnectionID();
      const active = api.SLSGetActiveSpace(cid);
      if (!active) return false;
      const foregroundId = `mac-space:${active}`;
      const fullscreenId = api.SLSSpaceGetType(cid, active) === 4 ? foregroundId : null;
      lastObservation = { reliable: true, foregroundId, fullscreenId };
      return fullscreenId || false;
    } catch (err) {
      if (typeof options.onCallError === "function") options.onCallError(err);
      return false;
    }
  }

  isForegroundFullscreen.getLastObservation = () => ({ ...lastObservation });
  isForegroundFullscreen.isWindowIdAlive = () => null;
  return isForegroundFullscreen;
}

module.exports = { createMacFullscreenProbe };
