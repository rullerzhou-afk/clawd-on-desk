"use strict";
// Preload for the game-launcher window. Mirrors the dashboard preload —
// contextIsolation:true, only a tiny API surface is exposed.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clawdLauncher", {
  setHover: (hovered) => ipcRenderer.send("game-launcher:hover", !!hovered),
  launch: (gameId) => ipcRenderer.send("game-launcher:launch", String(gameId || "")),
  onLang: (cb) => {
    if (typeof cb !== "function") return;
    ipcRenderer.on("game-launcher:lang-change", (_event, payload) => cb(payload));
  },
});
