"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const MARKER_COLORS = Object.freeze({
  renderPrimary: Object.freeze([0, 255, 76]),
  renderCorner: Object.freeze([255, 255, 255]),
  hitPrimary: Object.freeze([255, 0, 212]),
  hitCorner: Object.freeze([0, 234, 255]),
});

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function isFiniteRect(rect) {
  return !!rect
    && Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function findRenderMarkerRect(renderBounds, hitBounds, options = {}) {
  if (!isFiniteRect(renderBounds) || !isFiniteRect(hitBounds)) return null;
  const markerSize = Number.isFinite(options.markerSize) ? Math.max(8, Math.round(options.markerSize)) : 14;
  const margin = Number.isFinite(options.margin) ? Math.max(0, Math.round(options.margin)) : 3;
  if (renderBounds.width < markerSize + margin * 2 || renderBounds.height < markerSize + margin * 2) return null;

  const hitLocal = {
    x: hitBounds.x - renderBounds.x,
    y: hitBounds.y - renderBounds.y,
    width: hitBounds.width,
    height: hitBounds.height,
  };
  const maxX = Math.floor(renderBounds.width - margin - markerSize);
  const maxY = Math.floor(renderBounds.height - margin - markerSize);
  const candidates = [
    { corner: "top-left", x: margin, y: margin, width: markerSize, height: markerSize },
    { corner: "top-right", x: maxX, y: margin, width: markerSize, height: markerSize },
    { corner: "bottom-left", x: margin, y: maxY, width: markerSize, height: markerSize },
    { corner: "bottom-right", x: maxX, y: maxY, width: markerSize, height: markerSize },
  ];
  return candidates.find((candidate) => !rectsOverlap(candidate, hitLocal)) || null;
}

function isCompletePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length + 12) return false;
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataEnd = typeStart + 4 + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buffer.length) return false;
    const type = buffer.subarray(typeStart, typeStart + 4).toString("ascii");
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) return false;
    const storedCrc = buffer.readUInt32BE(dataEnd);
    if (crc32(buffer.subarray(typeStart, dataEnd)) !== storedCrc) return false;
    if (type === "IEND") return length === 0 && chunkEnd === buffer.length;
    offset = chunkEnd;
    chunkIndex += 1;
  }
  return false;
}

function createCaptureTarget(options = {}) {
  const fsImpl = options.fs || fs;
  const tempRoot = options.tempRoot || os.tmpdir();
  const dir = fsImpl.mkdtempSync(path.join(tempRoot, "clawd-niri-inspect-"));
  try { fsImpl.chmodSync(dir, 0o700); } catch {}
  const token = typeof options.token === "string" && options.token
    ? options.token
    : crypto.randomUUID();
  const filePath = path.join(dir, `capture-${token}.png`);
  assertPathAbsent(filePath, fsImpl);
  return { dir, filePath };
}

function assertPathAbsent(filePath, fsImpl = fs) {
  try {
    fsImpl.accessSync(filePath, fs.constants.F_OK);
  } catch (err) {
    if (err && err.code === "ENOENT") return true;
    throw err;
  }
  const error = new Error("niri screenshot target already exists");
  error.code = "capture-path-exists";
  throw error;
}

async function waitForCompletePng(filePath, options = {}) {
  const fsImpl = options.fs || fs;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 4000;
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(1, options.pollMs) : 25;
  const stableNeeded = Number.isFinite(options.stableCount) ? Math.max(1, options.stableCount) : 2;
  const delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stable = 0;

  while (Date.now() <= deadline) {
    let data = null;
    try {
      data = fsImpl.readFileSync(filePath);
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    if (data && data.length > 0 && isCompletePng(data)) {
      if (data.length === lastSize) stable += 1;
      else stable = 1;
      lastSize = data.length;
      if (stable >= stableNeeded) return data;
    } else {
      stable = 0;
      lastSize = data ? data.length : -1;
    }
    await delay(pollMs);
  }
  const error = new Error("niri screenshot file did not become a complete stable PNG");
  error.code = "capture-timeout";
  throw error;
}

function cleanupCaptureTarget(target, fsImpl = fs) {
  if (!target || typeof target !== "object") return;
  if (typeof target.filePath === "string") {
    try { fsImpl.unlinkSync(target.filePath); } catch (err) { if (!err || err.code !== "ENOENT") throw err; }
  }
  if (typeof target.dir === "string") {
    try { fsImpl.rmdirSync(target.dir); } catch (err) { if (!err || err.code !== "ENOENT") throw err; }
  }
}

function colorMatches(actual, expected, tolerance) {
  return Math.abs(actual[0] - expected[0]) <= tolerance
    && Math.abs(actual[1] - expected[1]) <= tolerance
    && Math.abs(actual[2] - expected[2]) <= tolerance;
}

function findColorComponents(labels, width, height, targetLabel) {
  const visited = new Uint8Array(labels.length);
  const components = [];
  const queue = new Int32Array(labels.length);
  for (let start = 0; start < labels.length; start += 1) {
    if (labels[start] !== targetLabel || visited[start]) continue;
    let read = 0;
    let write = 0;
    queue[write++] = start;
    visited[start] = 1;
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    while (read < write) {
      const index = queue[read++];
      const x = index % width;
      const y = Math.floor(index / width);
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const neighbours = [index - 1, index + 1, index - width, index + width];
      for (const neighbour of neighbours) {
        if (neighbour < 0 || neighbour >= labels.length || visited[neighbour]) continue;
        const nx = neighbour % width;
        if (Math.abs(nx - x) > 1) continue;
        if (labels[neighbour] !== targetLabel) continue;
        visited[neighbour] = 1;
        queue[write++] = neighbour;
      }
    }
    components.push({ count, minX, minY, maxX, maxY });
  }
  return components;
}

function hasCornerPair(primaryComponents, cornerComponents, direction, thresholds) {
  return primaryComponents.some((primary) => {
    if (primary.count < thresholds.primary) return false;
    const primaryWidth = primary.maxX - primary.minX + 1;
    const primaryHeight = primary.maxY - primary.minY + 1;
    if (primaryWidth < 6 || primaryHeight < 6) return false;
    const tolerance = Math.max(2, Math.ceil(Math.max(primaryWidth, primaryHeight) * 0.2));
    return cornerComponents.some((corner) => {
      if (corner.count < thresholds.corner) return false;
      const alignedX = direction === "bottom-right"
        ? Math.abs(corner.maxX - primary.maxX) <= tolerance
        : Math.abs(corner.minX - primary.minX) <= tolerance;
      const alignedY = direction === "bottom-right"
        ? Math.abs(corner.maxY - primary.maxY) <= tolerance
        : Math.abs(corner.minY - primary.minY) <= tolerance;
      const onExpectedHalf = direction === "bottom-right"
        ? corner.minX >= primary.minX + primaryWidth / 2 - tolerance
          && corner.minY >= primary.minY + primaryHeight / 2 - tolerance
        : corner.maxX <= primary.minX + primaryWidth / 2 + tolerance
          && corner.maxY <= primary.minY + primaryHeight / 2 + tolerance;
      return alignedX && alignedY && onExpectedHalf;
    });
  });
}

function scanNativeImage(nativeImageValue, options = {}) {
  if (!nativeImageValue || typeof nativeImageValue.isEmpty !== "function" || nativeImageValue.isEmpty()) {
    return { valid: false, render: false, hit: false, counts: {} };
  }
  const size = nativeImageValue.getSize();
  const bitmap = nativeImageValue.toBitmap();
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || bitmap.length !== size.width * size.height * 4) {
    return { valid: false, render: false, hit: false, counts: {} };
  }
  const tolerance = Number.isFinite(options.tolerance) ? Math.max(0, options.tolerance) : 28;
  const alphaFloor = Number.isFinite(options.alphaFloor) ? Math.max(0, Math.min(255, options.alphaFloor)) : 128;
  const counts = {
    renderPrimary: 0,
    renderCorner: 0,
    hitPrimary: 0,
    hitCorner: 0,
  };
  const labels = new Uint8Array(size.width * size.height);
  const colorEntries = Object.entries(MARKER_COLORS);
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    const alpha = bitmap[offset + 3];
    if (alpha < alphaFloor) continue;
    const scale = 255 / alpha;
    const rgb = [
      Math.min(255, Math.round(bitmap[offset + 2] * scale)),
      Math.min(255, Math.round(bitmap[offset + 1] * scale)),
      Math.min(255, Math.round(bitmap[offset] * scale)),
    ];
    for (let colorIndex = 0; colorIndex < colorEntries.length; colorIndex += 1) {
      const [name, expected] = colorEntries[colorIndex];
      if (colorMatches(rgb, expected, tolerance)) {
        counts[name] += 1;
        labels[offset / 4] = colorIndex + 1;
        break;
      }
    }
  }
  const components = Object.fromEntries(colorEntries.map(([name], colorIndex) => [
    name,
    findColorComponents(labels, size.width, size.height, colorIndex + 1),
  ]));
  const render = hasCornerPair(
    components.renderPrimary,
    components.renderCorner,
    "bottom-right",
    { primary: 24, corner: 4 },
  );
  const hit = hasCornerPair(
    components.hitPrimary,
    components.hitCorner,
    "top-left",
    { primary: 20, corner: 4 },
  );
  return { valid: true, render, hit, counts, size };
}

module.exports = {
  MARKER_COLORS,
  assertPathAbsent,
  cleanupCaptureTarget,
  createCaptureTarget,
  findRenderMarkerRect,
  isCompletePng,
  rectsOverlap,
  scanNativeImage,
  waitForCompletePng,
};
