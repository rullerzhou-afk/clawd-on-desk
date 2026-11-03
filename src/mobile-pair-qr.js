"use strict";

// Renders the LAN pair URL as a self-contained QR SVG for the Settings mobile
// card. The encoded payload is exactly the pairUrl already shown as text next
// to it (LAN IP + port + one-shot pairing code, never a device token). The SVG
// carries its own light background so scanners always get a contrasting quiet
// zone regardless of the settings theme. Fail-open: any error yields null and
// the card keeps its text-only fallback.

const qrcode = require("qrcode-generator");

const DEFAULT_QUIET_ZONE = 4;
const ECC_LEVEL = "M";
const MAX_URL_LENGTH = 512;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

let memo = null; // { key, svg } — getConnectionInfo() is polled every 5s

function memoKey(url, opts) {
  return JSON.stringify([url, opts || null]);
}

function safeColor(value, fallback) {
  return typeof value === "string" && COLOR_RE.test(value) ? value : fallback;
}

function renderQrSvg(url, opts) {
  const quietZone = Number.isInteger(opts && opts.quietZone) && opts.quietZone >= 0
    ? opts.quietZone
    : DEFAULT_QUIET_ZONE;
  const dark = safeColor(opts && opts.dark, "#000000");
  const light = safeColor(opts && opts.light, "#ffffff");

  const qr = qrcode(0, ECC_LEVEL);
  qr.addData(url);
  qr.make();

  const count = qr.getModuleCount();
  const size = count + quietZone * 2;
  const modules = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        modules.push(`M${col + quietZone} ${row + quietZone}h1v1h-1z`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"`
    + ` shape-rendering="crispEdges" aria-hidden="true">`
    + `<rect width="${size}" height="${size}" fill="${light}"/>`
    + `<path d="${modules.join("")}" fill="${dark}"/>`
    + `</svg>`;
}

function buildPairQrSvg(url, opts) {
  if (typeof url !== "string" || !url || url.length > MAX_URL_LENGTH) return null;
  const key = memoKey(url, opts);
  if (memo && memo.key === key) return memo.svg;
  let svg = null;
  try {
    svg = renderQrSvg(url, opts);
  } catch {
    svg = null;
  }
  memo = { key, svg };
  return svg;
}

module.exports = { buildPairQrSvg };
