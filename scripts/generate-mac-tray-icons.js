#!/usr/bin/env node
"use strict";

// Deterministically rasterize the two tiny macOS Template marks without a
// native graphics dependency. SVG width/path/stroke/rect values are the only
// geometry source; 8x supersampling preserves stable alpha at 1x and Retina.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const NORMAL_SOURCE = path.join(ROOT, "assets", "source", "tray-icon-project-mark.svg");
const COMPLETE_SOURCE = path.join(ROOT, "assets", "source", "tray-icon-project-mark-complete.svg");
const SUPERSAMPLE = 8;
const NUMBER_TOKEN_SOURCE = "[-+]?(?:(?:\\d+\\.\\d*)|(?:\\.\\d+)|(?:\\d+))(?:[eE][-+]?\\d+)?";

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

function parseNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
  return parsed;
}

function getTags(svg, name) {
  return [...svg.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((match) => match[0]);
}

function getAttribute(tag, name, label) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]+)"`));
  if (!match) throw new Error(`${label} is missing ${name}`);
  return match[1];
}

function parseSimplePathSegments(pathData, label = "path") {
  const tokenRegex = new RegExp(`${NUMBER_TOKEN_SOURCE}|[A-Za-z]`, "g");
  const tokens = pathData.match(tokenRegex) || [];
  const residue = pathData.replace(tokenRegex, "").replace(/[\s,]+/g, "");
  if (residue) throw new Error(`${label} contains unsupported path syntax: ${residue}`);

  let index = 0;
  let current = null;
  let start = null;
  const segments = [];

  const readNumber = () => {
    if (index >= tokens.length || /^[A-Za-z]$/.test(tokens[index])) {
      throw new Error(`${label} has an incomplete path command`);
    }
    return parseNumber(tokens[index++], label);
  };
  const addPoint = (next) => {
    if (!current) throw new Error(`${label} must begin with M`);
    segments.push([current[0], current[1], next[0], next[1]]);
    current = next;
  };

  while (index < tokens.length) {
    const command = tokens[index++];
    if (!/^[A-Za-z]$/.test(command)) throw new Error(`${label} expected a path command`);
    if (command === "M") {
      if (current) throw new Error(`${label} may only contain one subpath`);
      current = [readNumber(), readNumber()];
      start = [...current];
    } else if (command === "L") {
      addPoint([readNumber(), readNumber()]);
    } else if (command === "H") {
      if (!current) throw new Error(`${label} must begin with M`);
      addPoint([readNumber(), current[1]]);
    } else if (command === "V") {
      if (!current) throw new Error(`${label} must begin with M`);
      addPoint([current[0], readNumber()]);
    } else if (command === "Z") {
      if (!current || !start) throw new Error(`${label} must begin with M`);
      addPoint([...start]);
    } else {
      throw new Error(`${label} uses unsupported command ${command}`);
    }
  }

  if (!segments.length) throw new Error(`${label} contains no drawable segments`);
  return segments;
}

function parseSvgGeometry(svg, { requireCompletionCue = false } = {}) {
  if (typeof svg !== "string" || !svg.trim()) throw new Error("SVG source must be non-empty text");

  const svgTags = getTags(svg, "svg");
  assert.equal(svgTags.length, 1, "source should contain exactly one svg root");
  const logicalWidth = parseNumber(getAttribute(svgTags[0], "width", "svg root"), "svg width");
  const logicalHeight = parseNumber(getAttribute(svgTags[0], "height", "svg root"), "svg height");
  assert.equal(logicalWidth, logicalHeight, "menu-bar source must be square");
  assert.ok(Number.isInteger(logicalWidth) && logicalWidth > 0, "logical size must be a positive integer");

  const viewBox = getAttribute(svgTags[0], "viewBox", "svg root")
    .trim()
    .split(/[\s,]+/)
    .map((value) => parseNumber(value, "viewBox"));
  assert.equal(viewBox.length, 4, "viewBox must contain four numbers");
  assert.ok(viewBox[2] > 0 && viewBox[3] > 0, "viewBox dimensions must be positive");

  const pathTags = getTags(svg, "path");
  assert.equal(pathTags.length, 3, "source should contain one frame path and two mark paths");
  const groupTags = getTags(svg, "g").filter((tag) => tag.includes("stroke-width="));
  assert.equal(groupTags.length, 1, "source should contain one stroked mark group");

  const frameStrokeWidth = parseNumber(
    getAttribute(pathTags[0], "stroke-width", "frame path"),
    "frame stroke width",
  );
  const markStrokeWidth = parseNumber(
    getAttribute(groupTags[0], "stroke-width", "mark group"),
    "mark stroke width",
  );
  assert.ok(frameStrokeWidth > 0 && markStrokeWidth > 0, "stroke widths must be positive");

  const rectTags = getTags(svg, "rect");
  assert.equal(
    rectTags.length,
    requireCompletionCue ? 1 : 0,
    requireCompletionCue
      ? "completion source should contain exactly one cue rect"
      : "normal source should not contain a cue rect",
  );
  const cue = requireCompletionCue ? {
    x: parseNumber(getAttribute(rectTags[0], "x", "completion cue"), "completion cue x"),
    y: parseNumber(getAttribute(rectTags[0], "y", "completion cue"), "completion cue y"),
    width: parseNumber(getAttribute(rectTags[0], "width", "completion cue"), "completion cue width"),
    height: parseNumber(getAttribute(rectTags[0], "height", "completion cue"), "completion cue height"),
  } : null;
  if (cue) assert.ok(cue.width > 0 && cue.height > 0, "completion cue dimensions must be positive");

  return {
    logicalSize: logicalWidth,
    viewBoxX: viewBox[0],
    viewBoxY: viewBox[1],
    viewBoxWidth: viewBox[2],
    viewBoxHeight: viewBox[3],
    frameSegments: parseSimplePathSegments(
      getAttribute(pathTags[0], "d", "frame path"),
      "frame path",
    ),
    markSegments: pathTags.slice(1).flatMap((tag, index) => parseSimplePathSegments(
      getAttribute(tag, "d", `mark path ${index + 1}`),
      `mark path ${index + 1}`,
    )),
    frameStrokeRadius: frameStrokeWidth / 2,
    markStrokeRadius: markStrokeWidth / 2,
    cue,
  };
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const rawT = lengthSquared > 0 ? ((px - x1) * dx + (py - y1) * dy) / lengthSquared : 0;
  const t = Math.max(0, Math.min(1, rawT));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function isInsideMark(x, y, geometry) {
  return geometry.frameSegments.some((segment) => (
    distanceToSegment(x, y, ...segment) <= geometry.frameStrokeRadius
  )) || geometry.markSegments.some((segment) => (
    distanceToSegment(x, y, ...segment) <= geometry.markStrokeRadius
  ));
}

function isInsideCompletionCue(x, y, cue) {
  return cue !== null
    && x >= cue.x
    && x <= cue.x + cue.width
    && y >= cue.y
    && y <= cue.y + cue.height;
}

function renderAlpha(size, geometry) {
  assert.ok(Number.isInteger(size) && size > 0, "output size must be a positive integer");
  const scaleX = size / geometry.viewBoxWidth;
  const scaleY = size / geometry.viewBoxHeight;
  const alpha = Buffer.alloc(size * size);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = geometry.viewBoxX + (px + (sx + 0.5) / SUPERSAMPLE) / scaleX;
          const y = geometry.viewBoxY + (py + (sy + 0.5) / SUPERSAMPLE) / scaleY;
          if (isInsideMark(x, y, geometry) || isInsideCompletionCue(x, y, geometry.cue)) covered += 1;
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

function writeIcon(fileName, size, geometry) {
  const output = path.join(ROOT, "assets", fileName);
  fs.writeFileSync(output, encodeRgbaPng(size, renderAlpha(size, geometry)));
  console.log(`${path.relative(ROOT, output)} (${size}x${size})`);
}

function comparableGeometry(geometry) {
  const { cue: _cue, ...base } = geometry;
  return base;
}

function main() {
  const normalGeometry = parseSvgGeometry(fs.readFileSync(NORMAL_SOURCE, "utf8"));
  const completeGeometry = parseSvgGeometry(
    fs.readFileSync(COMPLETE_SOURCE, "utf8"),
    { requireCompletionCue: true },
  );
  assert.deepStrictEqual(
    comparableGeometry(completeGeometry),
    comparableGeometry(normalGeometry),
    "normal and completion sources must share identical base geometry",
  );

  writeIcon("tray-iconTemplate.png", normalGeometry.logicalSize, normalGeometry);
  writeIcon("tray-iconTemplate@2x.png", normalGeometry.logicalSize * 2, normalGeometry);
  writeIcon("tray-icon-flashTemplate.png", completeGeometry.logicalSize, completeGeometry);
  writeIcon("tray-icon-flashTemplate@2x.png", completeGeometry.logicalSize * 2, completeGeometry);
}

if (require.main === module) main();

module.exports = { parseSimplePathSegments, parseSvgGeometry, renderAlpha };
