"use strict";

(function exposeRoamFencePickerGeometry(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.roamFencePickerGeometry = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const DEFAULT_EDGE_THRESHOLD = 12;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isRect(value) {
    return !!value
      && Number.isFinite(value.x)
      && Number.isFinite(value.y)
      && Number.isFinite(value.width)
      && Number.isFinite(value.height)
      && value.width > 0
      && value.height > 0;
  }

  function hitTestSelection(selection, point, threshold = DEFAULT_EDGE_THRESHOLD) {
    if (!isRect(selection) || !point) return "draw";
    const left = selection.x;
    const top = selection.y;
    const right = left + selection.width;
    const bottom = top + selection.height;
    const t = Math.max(1, Number(threshold) || DEFAULT_EDGE_THRESHOLD);
    const withinX = point.x >= left - t && point.x <= right + t;
    const withinY = point.y >= top - t && point.y <= bottom + t;
    const leftDistance = Math.abs(point.x - left);
    const rightDistance = Math.abs(point.x - right);
    const topDistance = Math.abs(point.y - top);
    const bottomDistance = Math.abs(point.y - bottom);
    const nearLeft = withinY && leftDistance <= t;
    const nearRight = withinY && rightDistance <= t;
    const nearTop = withinX && topDistance <= t;
    const nearBottom = withinX && bottomDistance <= t;
    const horizontalEdge = nearLeft && nearRight
      ? (leftDistance <= rightDistance ? "w" : "e")
      : nearLeft ? "w" : nearRight ? "e" : "";
    const verticalEdge = nearTop && nearBottom
      ? (topDistance <= bottomDistance ? "n" : "s")
      : nearTop ? "n" : nearBottom ? "s" : "";

    if (verticalEdge && horizontalEdge) return `${verticalEdge}${horizontalEdge}`;
    if (verticalEdge) return verticalEdge;
    if (horizontalEdge) return horizontalEdge;
    if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) return "move";
    return "draw";
  }

  function cursorForMode(mode) {
    if (mode === "move") return "move";
    if (mode === "n" || mode === "s") return "ns-resize";
    if (mode === "e" || mode === "w") return "ew-resize";
    if (mode === "nw" || mode === "se") return "nwse-resize";
    if (mode === "ne" || mode === "sw") return "nesw-resize";
    return "crosshair";
  }

  function updateSelection(mode, startPoint, currentPoint, initialSelection, workArea) {
    if (!startPoint || !currentPoint || !workArea) return null;
    const areaWidth = Math.max(1, Math.round(Number(workArea.width) || 1));
    const areaHeight = Math.max(1, Math.round(Number(workArea.height) || 1));
    const start = {
      x: clamp(Math.round(startPoint.x), 0, areaWidth),
      y: clamp(Math.round(startPoint.y), 0, areaHeight),
    };
    const current = {
      x: clamp(Math.round(currentPoint.x), 0, areaWidth),
      y: clamp(Math.round(currentPoint.y), 0, areaHeight),
    };

    if (mode === "draw" || !isRect(initialSelection)) {
      let left = Math.min(start.x, current.x);
      let right = Math.max(start.x, current.x);
      let top = Math.min(start.y, current.y);
      let bottom = Math.max(start.y, current.y);
      if (left === right) {
        if (right < areaWidth) right += 1;
        else left = Math.max(0, left - 1);
      }
      if (top === bottom) {
        if (bottom < areaHeight) bottom += 1;
        else top = Math.max(0, top - 1);
      }
      return { x: left, y: top, width: right - left, height: bottom - top };
    }

    const initial = {
      x: Math.round(initialSelection.x),
      y: Math.round(initialSelection.y),
      width: Math.round(initialSelection.width),
      height: Math.round(initialSelection.height),
    };
    const dx = current.x - start.x;
    const dy = current.y - start.y;
    if (mode === "move") {
      return {
        x: clamp(initial.x + dx, 0, Math.max(0, areaWidth - initial.width)),
        y: clamp(initial.y + dy, 0, Math.max(0, areaHeight - initial.height)),
        width: initial.width,
        height: initial.height,
      };
    }

    let left = initial.x;
    let top = initial.y;
    let right = initial.x + initial.width;
    let bottom = initial.y + initial.height;
    if (mode.includes("w")) left = clamp(left + dx, 0, right - 1);
    if (mode.includes("e")) right = clamp(right + dx, left + 1, areaWidth);
    if (mode.includes("n")) top = clamp(top + dy, 0, bottom - 1);
    if (mode.includes("s")) bottom = clamp(bottom + dy, top + 1, areaHeight);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  return {
    DEFAULT_EDGE_THRESHOLD,
    cursorForMode,
    hitTestSelection,
    updateSelection,
  };
});
