"use strict";

const VALID_CORNERS = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);

function readArg(argv, prefix) {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const value = argv[index];
    if (typeof value === "string" && value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return null;
}

function exposeNiriInspectBridge(_contextBridge, ipcRenderer, argv = process.argv, globals = {}) {
  const role = readArg(argv, "--niri-inspect-role=");
  if (role !== "render" && role !== "hit") return false;
  const requestedCorner = readArg(argv, "--niri-inspect-corner=");
  const corner = VALID_CORNERS.has(requestedCorner)
    ? requestedCorner
    : "top-left";
  const windowValue = globals.window || window;
  const documentValue = globals.document || document;

  const installMarker = () => {
    const marker = documentValue.createElement("div");
    marker.id = `niri-inspect-${role}-marker`;
    marker.className = [
      "niri-inspect-marker",
      `niri-inspect-marker--${role}`,
      `niri-inspect-marker--${role === "hit" ? "top-left" : corner}`,
    ].join(" ");
    marker.setAttribute("aria-hidden", "true");
    documentValue.body.appendChild(marker);

    if (role === "render") {
      const pointerRoot = documentValue.documentElement;
      if (!pointerRoot || typeof pointerRoot.addEventListener !== "function") return;
      pointerRoot.addEventListener("pointerenter", (event) => {
        if (event.relatedTarget !== null) return;
        ipcRenderer.send("niri-inspect-render-pointer", {
          role,
          inside: true,
          screenX: Number.isFinite(event.screenX) ? event.screenX : null,
          screenY: Number.isFinite(event.screenY) ? event.screenY : null,
        });
      }, true);
      pointerRoot.addEventListener("pointerleave", (event) => {
        if (event.relatedTarget !== null) return;
        ipcRenderer.send("niri-inspect-render-pointer", {
          role,
          inside: false,
          screenX: Number.isFinite(event.screenX) ? event.screenX : null,
          screenY: Number.isFinite(event.screenY) ? event.screenY : null,
        });
      }, true);
    }

    windowValue.requestAnimationFrame(() => {
      windowValue.requestAnimationFrame(() => {
        ipcRenderer.send("niri-inspect-renderer-ready", { role });
      });
    });
  };

  const install = () => {
    const stylesheet = documentValue.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "niri-inspect-marker.css";
    stylesheet.addEventListener("load", installMarker, { once: true });
    documentValue.head.appendChild(stylesheet);
  };
  if (documentValue.readyState === "loading") {
    documentValue.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
  return true;
}

module.exports = { exposeNiriInspectBridge };
