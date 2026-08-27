#!/usr/bin/env node
"use strict";

// Deterministically rasterize the two tiny macOS Template marks without a
// native graphics dependency. The vector coordinates mirror the SVG sources in
// assets/source; 8x supersampling preserves readable, stable alpha at 18/36px.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const SOURCE_FILES = [
  path.join(ROOT, "assets", "source", "tray-icon-project-mark.svg"),
  path.join(ROOT, "assets", "source", "tray-icon-project-mark-complete.svg"),
];
const FRAME_SEGMENTS = [
  [2.67, 0.9, 13.33, 0.9],
  [13.33, 0.9, 15.1, 2.67],
  [15.1, 2.67, 15.1, 13.33],
  [15.1, 13.33, 13.33, 15.1],
  [13.33, 15.1, 2.67, 15.1],
  [2.67, 15.1, 0.9, 13.33],
  [0.9, 13.33, 0.9, 2.67],
  [0.9, 2.67, 2.67, 0.9],
];
const MARK_SEGMENTS = [
  [2.78, 6.1, 5.77, 8],
  [5.77, 8, 2.78, 9.9],
  [13.22, 6.1, 10.23, 8],
  [10.23, 8, 13.22, 9.9],
];
const FRAME_STROKE_RADIUS = 0.64;
const MARK_STROKE_RADIUS = 0.665;
const SUPERSAMPLE = 8;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBuffer, data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  payload.copy(out, 4);
  out.writeUInt32BE(crc32(payload), 8 + data.length);
  return out;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const rawT = lengthSquared > 0 ? ((px - x1) * dx + (py - y1) * dy) / lengthSquared : 0;
  const t = Math.max(0, Math.min(1, rawT));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function isInsideMark(x, y) {
  return FRAME_SEGMENTS.some((segment) => (
    distanceToSegment(x, y, ...segment) <= FRAME_STROKE_RADIUS
  )) || MARK_SEGMENTS.some((segment) => (
    distanceToSegment(x, y, ...segment) <= MARK_STROKE_RADIUS
  ));
}

function isInsideCompletionCue(x, y) {
  return x >= 12.11 && x <= 14.33 && y >= 1.67 && y <= 3.89;
}

function renderAlpha(size, complete) {
  const scale = size / 16;
  const alpha = Buffer.alloc(size * size);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / scale;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / scale;
          if (isInsideMark(x, y) || (complete && isInsideCompletionCue(x, y))) covered += 1;
        }
      }
      alpha[py * size + px] = Math.round(255 * covered / samples);
    }
  }
  return alpha;
}

function encodeRgbaPng(size, alpha) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (1 + size * 4));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x += 1) {
      raw[offset++] = 0;
      raw[offset++] = 0;
      raw[offset++] = 0;
      raw[offset++] = alpha[y * size + x];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeIcon(fileName, size, complete) {
  const output = path.join(ROOT, "assets", fileName);
  fs.writeFileSync(output, encodeRgbaPng(size, renderAlpha(size, complete)));
  console.log(`${path.relative(ROOT, output)} (${size}x${size})`);
}

for (const source of SOURCE_FILES) {
  if (!fs.existsSync(source)) throw new Error(`missing source asset: ${source}`);
  const svg = fs.readFileSync(source, "utf8");
  for (const token of [
    "M2.67 .9 H13.33 L15.1 2.67 V13.33 L13.33 15.1 H2.67 L.9 13.33 V2.67 Z",
    "M2.78 6.1 L5.77 8 L2.78 9.9",
    "M13.22 6.1 L10.23 8 L13.22 9.9",
    'stroke-width="1.28"',
    'stroke-width="1.33"',
  ]) {
    if (!svg.includes(token)) throw new Error(`source geometry drifted: ${path.relative(ROOT, source)}`);
  }
  if (source.endsWith("-complete.svg") && !svg.includes('x="12.11" y="1.67" width="2.22" height="2.22"')) {
    throw new Error(`completion cue drifted: ${path.relative(ROOT, source)}`);
  }
}

writeIcon("tray-iconTemplate.png", 18, false);
writeIcon("tray-iconTemplate@2x.png", 36, false);
writeIcon("tray-icon-flashTemplate.png", 18, true);
writeIcon("tray-icon-flashTemplate@2x.png", 36, true);
