#!/usr/bin/env node
"use strict";

// Deterministically generate the KiroCrew fallback agent icon without a native
// graphics dependency. This is a code-native mark authored for this repository
// (a rounded-square "gateway" tile with a two-tone split), released as CC0-1.0.
// It is NOT the KiroCrew/Kiro brand logo and carries no upstream artwork.
//
//   node tools/generate-kirocrew-fallback-icon.js
//
// Writes the canonical source asset and its passthrough runtime copy with
// identical bytes. The left half is dark and the right half is light so the
// mark stays legible on both light and dark UI surfaces (>=3:1 either way).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const SOURCE_PATH = path.join(ROOT, "assets", "source", "agent-icons", "kirocrew-fallback.png");
const RUNTIME_PATH = path.join(ROOT, "assets", "icons", "agents", "kirocrew.png");
const SIZE = 64;
const CENTER = (SIZE - 1) / 2;
// Rounded-square tile (the "gateway") with a square hole punched out, so the
// mark reads as a bracket/portal rather than a solid blob.
const OUTER_HALF = 22;      // half-extent of the outer rounded square
const OUTER_RADIUS = 9;     // corner radius of the outer square
const INNER_HALF = 11;      // half-extent of the punched-out hole
const INNER_RADIUS = 5;     // corner radius of the hole
const DARK = [26, 26, 30, 255];
const LIGHT = [236, 236, 240, 255];

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
  const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  payload.copy(out, 4);
  out.writeUInt32BE(crc32(payload), 8 + data.length);
  return out;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// Signed-distance-ish test for a rounded square centered on CENTER: returns
// true when (dx,dy) is inside the rounded square of the given half-extent and
// corner radius.
function insideRoundedSquare(dx, dy, half, radius) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const inset = half - radius;
  if (ax <= inset || ay <= inset) {
    return ax <= half && ay <= half;
  }
  // In a corner region — test against the quarter-circle.
  const cx = ax - inset;
  const cy = ay - inset;
  return Math.hypot(cx, cy) <= radius;
}

// 4x4 supersampled coverage of the ring between the outer rounded square and
// the punched-out hole, split left-dark / right-light for dual-surface legibility.
function pixel(x, y) {
  const samples = 4;
  let covered = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const px = x + (sx + 0.5) / samples;
      const py = y + (sy + 0.5) / samples;
      const dx = px - CENTER;
      const dy = py - CENTER;
      const inOuter = insideRoundedSquare(dx, dy, OUTER_HALF, OUTER_RADIUS);
      const inHole = insideRoundedSquare(dx, dy, INNER_HALF, INNER_RADIUS);
      if (!inOuter || inHole) continue;
      covered += 1;
      const color = dx < 0 ? DARK : LIGHT;
      red += color[0];
      green += color[1];
      blue += color[2];
    }
  }
  if (covered === 0) return [0, 0, 0, 0];
  const alpha = Math.round(255 * clamp01(covered / (samples * samples)));
  return [
    Math.round(red / covered),
    Math.round(green / covered),
    Math.round(blue / covered),
    alpha,
  ];
}

function encodeRgbaPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  let offset = 0;
  for (let y = 0; y < SIZE; y += 1) {
    raw[offset++] = 0;
    for (let x = 0; x < SIZE; x += 1) {
      const [red, green, blue, alpha] = pixel(x, y);
      raw[offset++] = red;
      raw[offset++] = green;
      raw[offset++] = blue;
      raw[offset++] = alpha;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function main() {
  const buffer = encodeRgbaPng();
  fs.mkdirSync(path.dirname(SOURCE_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(RUNTIME_PATH), { recursive: true });
  fs.writeFileSync(SOURCE_PATH, buffer);
  fs.writeFileSync(RUNTIME_PATH, buffer);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  console.log(`${path.relative(ROOT, SOURCE_PATH)} (${SIZE}x${SIZE}, ${buffer.length} bytes)`);
  console.log(`${path.relative(ROOT, RUNTIME_PATH)} (${SIZE}x${SIZE}, ${buffer.length} bytes)`);
  console.log(`sha256 ${sha256}`);
}

main();
