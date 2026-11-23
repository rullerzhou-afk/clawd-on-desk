"use strict";

const PET_GET_CHANNEL = "renderer-config:get-pet";
const HIT_GET_CHANNEL = "renderer-config:get-hit";

/**
 * Hand the theme config to a sandboxed preload over synchronous IPC.
 *
 * Windows caps a process command line at 32,767 characters, and the renderer
 * previously received the whole theme JSON as an additionalArguments entry;
 * a large theme pushed the launch past that limit. A sandboxed preload also
 * has no fs/zlib, so neither reading a file nor compressing the payload is an
 * option. The synchronous read happens once per window load and returns the
 * latest value, so reloads do not go stale.
 */
function createRendererConfigChannel({ ipcMain }) {
  if (!ipcMain || typeof ipcMain.on !== "function") {
    throw new Error("createRendererConfigChannel requires ipcMain");
  }
  let petConfig = null;
  let hitConfig = null;

  ipcMain.on(PET_GET_CHANNEL, (event) => {
    event.returnValue = petConfig;
  });
  ipcMain.on(HIT_GET_CHANNEL, (event) => {
    event.returnValue = hitConfig;
  });

  return {
    setPetConfig(config) {
      petConfig = config ?? null;
    },
    getPetConfig() {
      return petConfig;
    },
    setHitConfig(config) {
      hitConfig = config ?? null;
    },
    getHitConfig() {
      return hitConfig;
    },
  };
}

module.exports = { createRendererConfigChannel };
