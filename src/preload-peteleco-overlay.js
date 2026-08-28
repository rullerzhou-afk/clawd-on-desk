"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const projectionListeners = new Set();
const clearListeners = new Set();
const fadeListeners = new Set();

ipcRenderer.on("peteleco:projection", (_event, payload) => {
  for (const cb of projectionListeners) {
    try { cb(payload); } catch (err) { console.warn("peteleco projection listener threw:", err); }
  }
});

ipcRenderer.on("peteleco:clear", () => {
  for (const cb of clearListeners) {
    try { cb(); } catch (err) { console.warn("peteleco clear listener threw:", err); }
  }
});

// Release: dissolve the line instead of clearing it outright. Separate from
// "clear" because a cancelled gesture must take the projection away at once.
ipcRenderer.on("peteleco:fade", () => {
  for (const cb of fadeListeners) {
    try { cb(); } catch (err) { console.warn("peteleco fade listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("petelecoOverlayAPI", {
  onProjection: (cb) => {
    if (typeof cb !== "function") return () => {};
    projectionListeners.add(cb);
    return () => projectionListeners.delete(cb);
  },
  onClear: (cb) => {
    if (typeof cb !== "function") return () => {};
    clearListeners.add(cb);
    return () => clearListeners.delete(cb);
  },
  onFade: (cb) => {
    if (typeof cb !== "function") return () => {};
    fadeListeners.add(cb);
    return () => fadeListeners.delete(cb);
  },
});
