// src/log-rotate.js — Append a line to a log file, truncating when it exceeds maxBytes.
// Keeps the newest ~half of the file (cut at a newline boundary) when the limit is hit.

const fs = require("fs");

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB

/**
 * Append `line` to `filePath`. If the file exceeds `maxBytes` after the write,
 * truncate it to keep roughly the newest half.
 */
function rotatedAppend(filePath, line, maxBytes = DEFAULT_MAX_BYTES) {
  fs.appendFileSync(filePath, line);

  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return; // file disappeared between append and stat — nothing to do
  }
  if (size <= maxBytes) return;

  // Over limit — keep the latter half, cut at a newline so we don't break a line
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return; // file disappeared between stat and read
  }
  const half = Math.floor(buf.length / 2);
  const nl = buf.indexOf(0x0a, half); // first \n after midpoint
  if (nl === -1 || nl >= buf.length - 1) return; // no good cut point, skip this round
  fs.writeFileSync(filePath, buf.slice(nl + 1));
}

module.exports = { rotatedAppend, DEFAULT_MAX_BYTES };
