"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  PET_ACCESSORY_CATALOG,
  PET_MOUTH_ACCESSORY_CATALOG,
} = require("../src/pet-customization-catalog");

const ASSET_DIR = path.join(__dirname, "..", "assets", "accessories");
const MAX_SMIL_VALUES = 16;
const MAX_SMIL_DURATION_S = 10;
const MAX_TRANSLATE_ABS = 16;

function parseStrictXmlElements(source) {
  const markup = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?xml[\s\S]*?\?>/g, "");
  const roots = [];
  const stack = [];
  const tagPattern = /<[^>]+>/g;
  let cursor = 0;
  let match;
  while ((match = tagPattern.exec(markup))) {
    assert.match(markup.slice(cursor, match.index), /^\s*$/, "XML text nodes are not allowed");
    cursor = tagPattern.lastIndex;
    const token = match[0];
    assert.doesNotMatch(token, /^<!/, `unsupported XML declaration: ${token}`);
    const closing = token.match(/^<\/\s*([A-Za-z][A-Za-z0-9:-]*)\s*>$/);
    if (closing) {
      const open = stack.pop();
      assert.ok(open && open.tag === closing[1], `mismatched closing tag ${closing[1]}`);
      continue;
    }
    const opening = token.match(/^<\s*([A-Za-z][A-Za-z0-9:-]*)([\s\S]*?)(\/?)>$/);
    assert.ok(opening, `malformed XML tag: ${token}`);
    const [, tag, rawAttrs, selfClosing] = opening;
    const attrs = {};
    const attrPattern = /([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*"([^"]*)"/y;
    let offset = 0;
    while (offset < rawAttrs.length) {
      const whitespace = /^\s+/.exec(rawAttrs.slice(offset));
      if (whitespace) offset += whitespace[0].length;
      if (offset >= rawAttrs.length) break;
      attrPattern.lastIndex = offset;
      const attr = attrPattern.exec(rawAttrs);
      assert.ok(attr, `${tag}: malformed, unquoted, or unsupported attribute near ${rawAttrs.slice(offset)}`);
      assert.ok(!Object.prototype.hasOwnProperty.call(attrs, attr[1]), `${tag}: duplicate ${attr[1]}`);
      attrs[attr[1]] = attr[2];
      offset = attrPattern.lastIndex;
    }
    const node = { tag, attrs, parent: stack[stack.length - 1] || null };
    if (node.parent) node.parent.children.push(node);
    else roots.push(node);
    node.children = [];
    if (!selfClosing) stack.push(node);
  }
  assert.match(markup.slice(cursor), /^\s*$/, "trailing XML text is not allowed");
  assert.strictEqual(stack.length, 0, "unclosed XML tags");
  return roots;
}

function parseSeconds(value, label) {
  assert.match(String(value || ""), /^-?(?:\d+(?:\.\d+)?|\.\d+)s$/, label);
  return Number(value.slice(0, -1));
}

function auditCigaretteSmil(source) {
  const roots = parseStrictXmlElements(source);
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  const animations = nodes.filter((node) => node.tag === "animate" || node.tag === "animateTransform");
  assert.ok(animations.length > 0);
  for (const node of animations) {
    const { tag, attrs, parent } = node;
    assert.strictEqual(parent && parent.tag, "rect", `${tag} must be a direct child of rect`);
    assert.strictEqual(node.children.length, 0, `${tag} must be empty`);
    const allowed = new Set([
      "attributeName", "type", "values", "keyTimes", "dur", "begin",
      "repeatCount", "calcMode",
    ]);
    assert.ok(Object.keys(attrs).every((name) => allowed.has(name)), `${tag}: ${Object.keys(attrs)}`);
    if (tag === "animateTransform") {
      assert.strictEqual(attrs.attributeName, "transform");
      assert.strictEqual(attrs.type, "translate");
    } else {
      assert.ok(["fill", "opacity"].includes(attrs.attributeName));
      assert.strictEqual(attrs.type, undefined);
    }
    assert.strictEqual(attrs.repeatCount, "indefinite");
    if (attrs.calcMode !== undefined) assert.ok(["discrete", "linear"].includes(attrs.calcMode));
    const dur = parseSeconds(attrs.dur, `${tag}: invalid dur ${attrs.dur}`);
    assert.ok(dur > 0 && dur <= MAX_SMIL_DURATION_S, attrs.dur);
    if (attrs.begin !== undefined) {
      const begin = parseSeconds(attrs.begin, `${tag}: invalid begin ${attrs.begin}`);
      assert.ok(Math.abs(begin) <= dur, attrs.begin);
    }
    const values = String(attrs.values || "").split(";");
    assert.ok(values.length >= 2 && values.length <= MAX_SMIL_VALUES, attrs.values);
    if (attrs.attributeName === "fill") {
      assert.ok(values.every((value) => /^#[0-9a-f]{6}$/i.test(value)));
    } else if (attrs.attributeName === "opacity") {
      assert.ok(values.every((value) => {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 && number <= 1;
      }), attrs.values);
    } else {
      assert.ok(values.every((value) => {
        const parts = value.trim().split(/\s+/).map(Number);
        return parts.length === 2
          && parts.every((part) => Number.isFinite(part) && Math.abs(part) <= MAX_TRANSLATE_ABS);
      }), attrs.values);
    }
    if (attrs.keyTimes !== undefined) {
      const times = attrs.keyTimes.split(";").map(Number);
      assert.strictEqual(times.length, values.length);
      assert.ok(times.every((value, index) => (
        Number.isFinite(value)
        && value >= 0
        && value <= 1
        && (index === 0 || value >= times[index - 1])
      )));
    }
  }
}

describe("accessory asset audit", () => {
  it("ships exactly the head and mouth catalogs' local SVG assets with matching viewBoxes", () => {
    const catalogEntries = [...PET_ACCESSORY_CATALOG, ...PET_MOUTH_ACCESSORY_CATALOG]
      .filter((entry) => entry.id !== "none");
    const catalogAssets = catalogEntries
      .map((entry) => entry.file)
      .sort();
    const diskAssets = fs.readdirSync(ASSET_DIR)
      .filter((file) => file.endsWith(".svg"))
      .sort();

    assert.deepStrictEqual(diskAssets, catalogAssets);
    assert.strictEqual(new Set(catalogAssets).size, catalogAssets.length, "catalog asset names must not collide");
    assert.strictEqual(diskAssets.length, 9);

    for (const entry of catalogEntries) {
      const source = fs.readFileSync(path.join(ASSET_DIR, entry.file), "utf8");
      const match = source.match(/\bviewBox="([^"]+)"/);
      assert.ok(match, `${entry.file} should declare a viewBox`);
      assert.deepStrictEqual(
        match[1].trim().split(/\s+/).map(Number),
        [entry.viewBox.x, entry.viewBox.y, entry.viewBox.width, entry.viewBox.height],
        `${entry.file} viewBox should match the catalog`
      );
    }
  });

  it("contains only inert pixel-vector markup and literal colors", () => {
    for (const file of PET_ACCESSORY_CATALOG.filter((entry) => entry.file).map((entry) => entry.file)) {
      const source = fs.readFileSync(path.join(ASSET_DIR, file), "utf8");
      const markup = source
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<\?xml[\s\S]*?\?>/g, "");
      const tags = [...markup.matchAll(/<\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)/g)]
        .map((match) => match[1].toLowerCase());

      assert.ok(tags.every((tag) => ["svg", "g", "rect", "ellipse", "path"].includes(tag)), `${file}: ${tags.join(",")}`);
      assert.doesNotMatch(source, /<script|<foreignObject|<image|<use|<!DOCTYPE/i);
      assert.doesNotMatch(source, /\bon[a-z]+\s*=|\bhref\s*=|url\s*\(|data:/i);
      for (const paint of source.matchAll(/\b(fill|stroke)="([^"]+)"/g)) {
        assert.match(
          paint[2],
          /^(?:none|#[0-9a-f]{6})$/i,
          `${file}: unsafe ${paint[1]} ${paint[2]}`
        );
      }
    }
  });

  it("allows the cigarette's narrow, bounded SMIL grammar and no active references", () => {
    const file = "cigarette.svg";
    const source = fs.readFileSync(path.join(ASSET_DIR, file), "utf8");
    const markup = source
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\?xml[\s\S]*?\?>/g, "");
    const tags = [...markup.matchAll(/<\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)/g)]
      .map((match) => match[1]);
    assert.ok(tags.every((tag) => ["svg", "g", "rect", "animate", "animateTransform"].includes(tag)), tags.join(","));
    assert.doesNotMatch(source, /<script|<foreignObject|<image|<use|<!DOCTYPE/i);
    assert.doesNotMatch(source, /\bon[a-z]+\s*=|\bhref\s*=|url\s*\(|data:/i);
    assert.match(source, /shape-rendering="crispEdges"/);
    assert.match(source, /shape-rendering="auto"/);

    auditCigaretteSmil(source);
  });

  it("keeps the archived PR cigarette fragment reproducible as the runtime asset", () => {
    const runtime = fs.readFileSync(path.join(ASSET_DIR, "cigarette.svg"), "utf8");
    const archived = fs.readFileSync(
      path.join(__dirname, "..", "assets", "source", "outlaw-pr811", "cigarette-fragment.svg"),
      "utf8"
    );
    const withoutComments = (value) => value
      .replace(/<!--[^]*?-->/g, "")
      .replace(/>\s+</g, "><")
      .trim();
    assert.strictEqual(withoutComments(archived), withoutComments(runtime));
  });

  it("keeps the archived PR western hat reproducible without replacing the earlier cowboy hat", () => {
    const runtime = fs.readFileSync(path.join(ASSET_DIR, "western-cowboy-hat.svg"), "utf8");
    const archived = fs.readFileSync(
      path.join(__dirname, "..", "assets", "source", "outlaw-pr811", "western-cowboy-hat.svg"),
      "utf8"
    );
    const existing = fs.readFileSync(path.join(ASSET_DIR, "cowboy-hat.svg"), "utf8");
    const withoutComments = (value) => value
      .replace(/<!--[^]*?-->/g, "")
      .replace(/>\s+</g, "><")
      .trim();
    assert.strictEqual(withoutComments(archived), withoutComments(runtime));
    assert.notStrictEqual(withoutComments(existing), withoutComments(runtime));
  });

  it("rejects malformed, detached, or unbounded cigarette SMIL", () => {
    const wrap = (animation) => `<svg><rect>${animation}</rect></svg>`;
    const opacity = '<animate attributeName="opacity" values="0;1" dur="1s" repeatCount="indefinite"/>';
    const translate = '<animateTransform attributeName="transform" type="translate" values="0 0;1 -2" dur="1s" repeatCount="indefinite"/>';
    assert.doesNotThrow(() => auditCigaretteSmil(wrap(opacity + translate)));
    assert.throws(() => auditCigaretteSmil(`<svg><g>${opacity}</g></svg>`), /direct child/);
    assert.throws(() => auditCigaretteSmil(wrap(opacity.replace('dur="1s"', "dur=1s"))), /unquoted/);
    assert.throws(() => auditCigaretteSmil(wrap(opacity.replace('values="0;1"', 'values="0;1.1"'))));
    assert.throws(() => auditCigaretteSmil(wrap(translate.replace('1 -2', '17 -2'))));
  });

  it("centers the Santa hat by its seating brim rather than its pompom silhouette", () => {
    const source = fs.readFileSync(
      path.join(ASSET_DIR, "santa-hat.svg"),
      "utf8"
    );
    const brim = source.match(
      /<rect x="([^"]+)" y="8" width="([^"]+)" height="1" fill="#e3e3e3"\/>/
    );
    assert.ok(brim, "Santa hat should declare its bottom seating brim");
    const centerX = Number(brim[1]) + Number(brim[2]) / 2;
    assert.strictEqual(centerX, 8, "the seating brim should match the 16-unit canvas center");
  });

  it("renders the angel halo as a smooth, centered elliptical ring", () => {
    const source = fs.readFileSync(path.join(ASSET_DIR, "halo.svg"), "utf8");
    assert.doesNotMatch(source, /shape-rendering="crispEdges"|<rect\b/);
    assert.match(
      source,
      /<ellipse cx="7" cy="2\.5" rx="5\.5" ry="1\.55" fill="none" stroke="#ffd84d" stroke-width="0\.8"/
    );
    assert.match(source, /<path\b[^>]*stroke="#fff3b0"[^>]*stroke-width="0\.3"/);
    assert.doesNotMatch(source, /stroke="#e9a928"/);
  });
});
