"use strict";

const fs = require("fs");
const path = require("path");
const { parseDocument } = require("htmlparser2");

const CYCLE_STATUS = {
  EXACT: "exact",
  ESTIMATED: "estimated",
  STATIC: "static",
  UNAVAILABLE: "unavailable",
};

const SVG_ANIMATION_TAGS = new Set(["animate", "animatetransform", "animatemotion", "set"]);
const CSS_DIRECTION_TOKENS = new Set(["normal", "reverse", "alternate", "alternate-reverse"]);
const CSS_FILL_TOKENS = new Set(["none", "forwards", "backwards", "both"]);
const CSS_PLAY_STATE_TOKENS = new Set(["running", "paused"]);
const CSS_TIMING_FN_TOKENS = new Set([
  "ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end",
]);
const DEFAULT_ZERO_DELAY_MS = 10;
const MAX_LCM_MS = 10 * 60 * 1000;
const PROBE_CACHE_LIMIT = 256;
const probeCache = new Map();

function buildUnavailableResult(source = "file") {
  return { ms: null, status: CYCLE_STATUS.UNAVAILABLE, source };
}

function buildStaticResult(source = "file") {
  return { ms: null, status: CYCLE_STATUS.STATIC, source };
}

function cloneResult(result) {
  return result ? { ...result } : null;
}

function parseTimeMs(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value || value === "indefinite") return null;
  const match = value.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(ms|s)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * (match[2] === "s" ? 1000 : 1));
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function lcm(a, b) {
  if (!a || !b) return 0;
  return Math.abs(a * b) / gcd(a, b);
}

function computeCycleLcm(values) {
  let out = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) continue;
    out = out ? lcm(out, value) : value;
    if (!Number.isFinite(out) || out > MAX_LCM_MS) return null;
  }
  return out || null;
}

function splitCssList(value) {
  const out = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    if (ch === ")" && depth > 0) depth--;
    if (ch === "," && depth === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function splitCssTokens(value) {
  const out = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    if (ch === ")" && depth > 0) depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

function parseCssIterationCount(raw) {
  if (typeof raw !== "string") return 1;
  const value = raw.trim().toLowerCase();
  if (!value) return 1;
  if (value === "infinite") return Infinity;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getCssListValue(list, index, fallback) {
  if (!Array.isArray(list) || list.length === 0) return fallback;
  return list[index] != null ? list[index] : list[list.length - 1];
}

function normalizeTimingEntry({ durationMs, mode, delayMs = 0, complex = false, source = "file" }) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return {
    cycleMs: Math.round(durationMs),
    mode,
    complex: !!complex,
    source,
    delayMs: Number.isFinite(delayMs) ? delayMs : 0,
  };
}

function parseCssAnimationTrack(track) {
  const tokens = splitCssTokens(track);
  if (!tokens.length) return null;
  let durationMs = null;
  let delayMs = 0;
  let seenTimeTokens = 0;
  let iterationCount = 1;
  let direction = "normal";
  let complex = false;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    const timeMs = parseTimeMs(lower);
    if (timeMs != null) {
      if (seenTimeTokens === 0) durationMs = timeMs;
      else if (seenTimeTokens === 1) delayMs = timeMs;
      else complex = true;
      seenTimeTokens++;
      continue;
    }
    if (CSS_DIRECTION_TOKENS.has(lower)) {
      direction = lower;
      continue;
    }
    if (CSS_FILL_TOKENS.has(lower) || CSS_PLAY_STATE_TOKENS.has(lower) || CSS_TIMING_FN_TOKENS.has(lower) || /^steps\(/.test(lower) || /^cubic-bezier\(/.test(lower) || /^linear\(/.test(lower)) {
      continue;
    }
    if (lower === "infinite" || /^-?(?:\d+\.?\d*|\.\d+)$/.test(lower)) {
      iterationCount = parseCssIterationCount(lower);
    }
  }

  if (durationMs == null || durationMs <= 0) return null;
  const isLoop = iterationCount === Infinity;
  const loopMultiplier = isLoop && (direction === "alternate" || direction === "alternate-reverse") ? 2 : 1;
  const cycleMs = isLoop
    ? durationMs * loopMultiplier
    : durationMs * Math.max(1, iterationCount) + Math.max(0, delayMs);
  return normalizeTimingEntry({
    durationMs: cycleMs,
    delayMs,
    mode: isLoop ? "loop" : "finite",
    complex: complex || (delayMs !== 0 && isLoop) || delayMs < 0,
    source: "svg",
  });
}

function parseCssDeclarationBlock(blockText) {
  const declarations = new Map();
  for (const rawDecl of blockText.split(";")) {
    const idx = rawDecl.indexOf(":");
    if (idx <= 0) continue;
    const name = rawDecl.slice(0, idx).trim().toLowerCase();
    const value = rawDecl.slice(idx + 1).trim();
    if (!name || !value) continue;
    declarations.set(name, value);
  }

  const entries = [];
  if (declarations.has("animation")) {
    for (const track of splitCssList(declarations.get("animation"))) {
      const entry = parseCssAnimationTrack(track);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  const durations = declarations.has("animation-duration")
    ? splitCssList(declarations.get("animation-duration"))
    : [];
  if (!durations.length) return entries;

  const names = declarations.has("animation-name")
    ? splitCssList(declarations.get("animation-name"))
    : [];
  const delays = declarations.has("animation-delay")
    ? splitCssList(declarations.get("animation-delay"))
    : [];
  const iterations = declarations.has("animation-iteration-count")
    ? splitCssList(declarations.get("animation-iteration-count"))
    : [];
  const directions = declarations.has("animation-direction")
    ? splitCssList(declarations.get("animation-direction"))
    : [];

  for (let i = 0; i < durations.length; i++) {
    const name = getCssListValue(names, i, "");
    if (name && name.trim().toLowerCase() === "none") continue;
    const durationMs = parseTimeMs(getCssListValue(durations, i, ""));
    if (durationMs == null || durationMs <= 0) continue;
    const delayMs = parseTimeMs(getCssListValue(delays, i, "")) || 0;
    const iterationCount = parseCssIterationCount(getCssListValue(iterations, i, ""));
    const direction = (getCssListValue(directions, i, "normal") || "normal").trim().toLowerCase();
    const isLoop = iterationCount === Infinity;
    const loopMultiplier = isLoop && (direction === "alternate" || direction === "alternate-reverse") ? 2 : 1;
    entries.push(normalizeTimingEntry({
      durationMs: isLoop
        ? durationMs * loopMultiplier
        : durationMs * Math.max(1, iterationCount) + Math.max(0, delayMs),
      delayMs,
      mode: isLoop ? "loop" : "finite",
      complex: (delayMs !== 0 && isLoop) || delayMs < 0,
      source: "svg",
    }));
  }
  return entries.filter(Boolean);
}

function collectCssTimingEntries(cssText) {
  if (typeof cssText !== "string" || !cssText.trim()) return [];
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = stripped.includes("{")
    ? [...stripped.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1])
    : [stripped];
  const entries = [];
  for (const block of blocks) {
    entries.push(...parseCssDeclarationBlock(block));
  }
  return entries;
}

function collectNodeText(node) {
  if (!node) return "";
  if (node.type === "text") return node.data || "";
  if (!Array.isArray(node.children)) return "";
  return node.children.map(collectNodeText).join("");
}

function parseSmilBeginDelay(beginRaw, isLoop) {
  if (typeof beginRaw !== "string" || !beginRaw.trim()) return { delayMs: 0, complex: false };
  const normalized = beginRaw.trim().toLowerCase();
  if (normalized.includes(";") || normalized.includes(",")) return { delayMs: 0, complex: true };
  const delayMs = parseTimeMs(normalized);
  if (delayMs == null) return { delayMs: 0, complex: true };
  return {
    delayMs: isLoop ? 0 : Math.max(0, delayMs),
    complex: isLoop ? false : delayMs < 0,
  };
}

function parseSmilTimingEntry(attribs) {
  if (!attribs) return null;
  const durMs = parseTimeMs(attribs.dur || "");
  const repeatDurMs = parseTimeMs(attribs.repeatDur || "");
  const repeatCountRaw = typeof attribs.repeatCount === "string" ? attribs.repeatCount.trim().toLowerCase() : "";
  let iterationCount = 1;
  let complex = false;

  if (repeatCountRaw === "indefinite") iterationCount = Infinity;
  else if (repeatCountRaw) {
    const parsed = Number(repeatCountRaw);
    if (Number.isFinite(parsed) && parsed > 0) iterationCount = parsed;
    else complex = true;
  }

  if ((attribs.repeatDur || "").trim().toLowerCase() === "indefinite") {
    iterationCount = Infinity;
  }

  const isLoop = iterationCount === Infinity;
  const begin = parseSmilBeginDelay(attribs.begin || "", isLoop);
  complex = complex || begin.complex;

  if (repeatDurMs != null && repeatDurMs > 0) {
    return normalizeTimingEntry({
      durationMs: repeatDurMs,
      delayMs: begin.delayMs,
      mode: isLoop ? "loop" : "finite",
      complex,
      source: "svg",
    });
  }

  if (durMs == null || durMs <= 0) return null;
  const cycleMs = isLoop
    ? durMs
    : durMs * Math.max(1, iterationCount) + begin.delayMs;
  return normalizeTimingEntry({
    durationMs: cycleMs,
    delayMs: begin.delayMs,
    mode: isLoop ? "loop" : "finite",
    complex,
    source: "svg",
  });
}

function walkSvgNode(node, entries) {
  if (!node) return;
  if (node.type === "tag") {
    const tagName = (node.name || "").toLowerCase();
    if (SVG_ANIMATION_TAGS.has(tagName)) {
      const entry = parseSmilTimingEntry(node.attribs);
      if (entry) entries.push(entry);
    }
    if (tagName === "style" && Array.isArray(node.children)) {
      for (const child of node.children) {
        entries.push(...collectCssTimingEntries(collectNodeText(child)));
      }
    }
    if (node.attribs && typeof node.attribs.style === "string") {
      entries.push(...collectCssTimingEntries(node.attribs.style));
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkSvgNode(child, entries);
  }
}

function summarizeTimingEntries(entries, source) {
  const valid = Array.isArray(entries)
    ? entries.filter((entry) => entry && Number.isFinite(entry.cycleMs) && entry.cycleMs > 0)
    : [];
  if (!valid.length) return buildUnavailableResult(source);

  const finiteEntries = valid.filter((entry) => entry.mode === "finite");
  const loopEntries = valid.filter((entry) => entry.mode === "loop");
  const hasComplex = valid.some((entry) => entry.complex);
  const cycleValues = valid.map((entry) => entry.cycleMs);

  if (valid.length === 1) {
    return {
      ms: cycleValues[0],
      status: hasComplex ? CYCLE_STATUS.ESTIMATED : CYCLE_STATUS.EXACT,
      source,
    };
  }

  if (finiteEntries.length > 0) {
    return {
      ms: Math.max(...cycleValues),
      status: CYCLE_STATUS.ESTIMATED,
      source,
    };
  }

  const uniqueLoopCycles = [...new Set(loopEntries.map((entry) => entry.cycleMs))];
  const fullCycleMs = computeCycleLcm(uniqueLoopCycles);
  if (fullCycleMs != null) {
    return {
      ms: fullCycleMs,
      status: hasComplex ? CYCLE_STATUS.ESTIMATED : CYCLE_STATUS.EXACT,
      source,
    };
  }

  return {
    ms: Math.max(...uniqueLoopCycles),
    status: CYCLE_STATUS.ESTIMATED,
    source,
  };
}

function probeSvgCycle(svgContent) {
  if (typeof svgContent !== "string" || !svgContent.trim()) {
    return buildUnavailableResult("svg");
  }
  try {
    const doc = parseDocument(svgContent, { xmlMode: true });
    const entries = [];
    walkSvgNode(doc, entries);
    return summarizeTimingEntries(entries, "svg");
  } catch {
    return buildUnavailableResult("svg");
  }
}

function skipGifSubBlocks(buffer, offset) {
  let cursor = offset;
  while (cursor < buffer.length) {
    const size = buffer[cursor];
    cursor += 1;
    if (size === 0) break;
    cursor += size;
  }
  return cursor;
}

function probeGifCycle(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) return buildUnavailableResult("gif");
  const header = buffer.toString("ascii", 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return buildUnavailableResult("gif");

  let offset = 6;
  if (offset + 7 > buffer.length) return buildUnavailableResult("gif");
  const packed = buffer[offset + 4];
  offset += 7;
  if (packed & 0x80) {
    const gctSize = 3 * (2 ** ((packed & 0x07) + 1));
    offset += gctSize;
  }

  const frameDurations = [];
  let pendingDelayMs = null;
  let estimated = false;

  while (offset < buffer.length) {
    const marker = buffer[offset];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = buffer[offset + 1];
      if (label === 0xf9 && offset + 7 < buffer.length) {
        const delayCs = buffer.readUInt16LE(offset + 4);
        pendingDelayMs = delayCs > 0 ? delayCs * 10 : DEFAULT_ZERO_DELAY_MS;
        if (delayCs <= 0) estimated = true;
        offset += 8;
        continue;
      }
      offset = skipGifSubBlocks(buffer, offset + 2);
      continue;
    }
    if (marker === 0x2c) {
      if (offset + 10 > buffer.length) break;
      const localPacked = buffer[offset + 9];
      offset += 10;
      if (localPacked & 0x80) {
        const lctSize = 3 * (2 ** ((localPacked & 0x07) + 1));
        offset += lctSize;
      }
      if (offset >= buffer.length) break;
      offset += 1; // LZW min code size
      offset = skipGifSubBlocks(buffer, offset);
      frameDurations.push(pendingDelayMs != null ? pendingDelayMs : DEFAULT_ZERO_DELAY_MS);
      if (pendingDelayMs == null) estimated = true;
      pendingDelayMs = null;
      continue;
    }
    break;
  }

  const totalMs = frameDurations.reduce((sum, value) => sum + value, 0);
  if (!totalMs) return buildUnavailableResult("gif");
  return {
    ms: totalMs,
    status: estimated ? CYCLE_STATUS.ESTIMATED : CYCLE_STATUS.EXACT,
    source: "gif",
  };
}

function probeApngCycle(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) return buildUnavailableResult("apng");
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.slice(0, 8).toString("hex") !== pngSignature) return buildUnavailableResult("apng");

  let offset = 8;
  const frameDurations = [];
  let isApng = false;
  let estimated = false;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const nextOffset = dataEnd + 4;
    if (nextOffset > buffer.length) return buildUnavailableResult("apng");

    if (type === "acTL") isApng = true;
    if (type === "fcTL" && length >= 26) {
      const delayNum = buffer.readUInt16BE(dataStart + 20);
      let delayDen = buffer.readUInt16BE(dataStart + 22);
      if (delayDen === 0) {
        delayDen = 100;
        estimated = true;
      }
      // Keep fractional delays and round the sum once; rounding each 1/12 s
      // frame would drop 1/3 ms per frame and under-report long clips.
      const delayMs = delayNum > 0
        ? (delayNum * 1000) / delayDen
        : DEFAULT_ZERO_DELAY_MS;
      if (delayNum <= 0) estimated = true;
      frameDurations.push(delayMs);
    }

    offset = nextOffset;
    if (type === "IEND") break;
  }

  if (!isApng || !frameDurations.length) return buildUnavailableResult("apng");
  const totalMs = Math.round(frameDurations.reduce((sum, value) => sum + value, 0));
  if (!totalMs) return buildUnavailableResult("apng");
  return {
    ms: totalMs,
    status: estimated ? CYCLE_STATUS.ESTIMATED : CYCLE_STATUS.EXACT,
    source: "apng",
  };
}

function probeAssetCycle(absPath) {
  if (typeof absPath !== "string" || !absPath) return buildUnavailableResult("file");
  const ext = path.extname(absPath).toLowerCase();

  let stat = null;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return buildUnavailableResult(ext ? ext.slice(1) : "file");
  }

  const cacheKey = `${absPath}|${stat.size}|${stat.mtimeMs}`;
  const cached = probeCache.get(cacheKey);
  if (cached) return cloneResult(cached);

  let result = buildUnavailableResult(ext ? ext.slice(1) : "file");
  try {
    if (ext === ".svg") result = probeSvgCycle(fs.readFileSync(absPath, "utf8"));
    else if (ext === ".gif") result = probeGifCycle(fs.readFileSync(absPath));
    else if (ext === ".apng") result = probeApngCycle(fs.readFileSync(absPath));
    else if (ext === ".png" || ext === ".webp" || ext === ".jpg" || ext === ".jpeg") {
      result = buildStaticResult(ext.slice(1));
    }
  } catch {
    result = buildUnavailableResult(ext ? ext.slice(1) : "file");
  }

  if (probeCache.size >= PROBE_CACHE_LIMIT) probeCache.clear();
  probeCache.set(cacheKey, result);
  return cloneResult(result);
}

module.exports = {
  CYCLE_STATUS,
  probeAssetCycle,
  probeSvgCycle,
  probeGifCycle,
  probeApngCycle,
};
