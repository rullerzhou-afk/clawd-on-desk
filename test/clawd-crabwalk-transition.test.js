"use strict";

// Static contract for the idle -> crabwalk handoff. The renderer cuts between
// clawd-idle-follow.svg and clawd-mini-crabwalk.svg, so the walk must start at
// the idle rest pose and stay centred on it, otherwise the pet "teleports".

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DEFAULT_SVG = path.join(__dirname, "..", "assets", "svg", "clawd-mini-crabwalk.svg");
const MAX_TRANSLATE = 1; // viewBox units (px) per axis
const MAX_ROTATE = 1.5; // degrees

function parseTime(token) {
  const m = /^(-?[\d.]+)(ms|s)$/.exec(token);
  return m ? parseFloat(m[1]) * (m[2] === "ms" ? 0.001 : 1) : null;
}

function parseAnimation(value) {
  const tokens = value.trim().split(/\s+/);
  const times = tokens.map(parseTime).filter((t) => t !== null);
  const name = tokens.find((t) => parseTime(t) === null && !/^[\d.]+$/.test(t)
    && !/^(infinite|forwards|backwards|both|none|linear|ease|ease-in|ease-out|ease-in-out|alternate|reverse|normal|cubic-bezier\(.*)$/.test(t));
  const countTok = tokens.find((t) => t === "infinite" || /^\d+$/.test(t));
  return {
    name,
    duration: times[0] ?? 0,
    delay: times[1] ?? 0,
    infinite: tokens.includes("infinite"),
    iterations: countTok === "infinite" ? Infinity : countTok ? Number(countTok) : 1,
    forwards: tokens.includes("forwards") || tokens.includes("both"),
  };
}

function parseTransform(value) {
  let rotate = 0;
  let x = 0;
  let y = 0;
  let m;
  const num = (s) => parseFloat(s) || 0;
  const re = /(translateX|translateY|translate|rotate)\(([^)]*)\)/g;
  while ((m = re.exec(value))) {
    const args = m[2].split(",").map(num);
    if (m[1] === "translate") { x += args[0]; y += args[1] || 0; }
    else if (m[1] === "translateX") x += args[0];
    else if (m[1] === "translateY") y += args[0];
    else rotate += args[0];
  }
  return { x, y, rotate };
}

function loadCrabwalk(file = process.env.CRABWALK_SVG || DEFAULT_SVG) {
  const markup = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const css = (/<style[^>]*>([\s\S]*?)<\/style>/.exec(markup) || [, ""])[1]
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const keyframes = {};
  const kfRe = /@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g;
  let m;
  while ((m = kfRe.exec(css))) {
    const frames = [];
    const fRe = /([^{}]+)\{([^{}]*)\}/g;
    let f;
    while ((f = fRe.exec(m[2]))) {
      const t = /transform\s*:\s*([^;]+)/.exec(f[2]);
      for (const sel of f[1].split(",")) {
        const s = sel.trim();
        const pct = s === "from" ? 0 : s === "to" ? 100 : parseFloat(s);
        frames.push({ pct, transform: t ? parseTransform(t[1]) : null });
      }
    }
    keyframes[m[1]] = frames.sort((a, b) => a.pct - b.pct);
  }
  const rules = [];
  const ruleRe = /([^{}@]+)\{([^{}]*)\}/g;
  const stripped = css.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, "");
  while ((m = ruleRe.exec(stripped))) {
    const a = /animation\s*:\s*([^;]+)/.exec(m[2]);
    if (a) rules.push({ selector: m[1].trim(), anim: parseAnimation(a[1]) });
  }
  return { keyframes, rules };
}

const BODY_SHADOW = /body|shadow/;
const isLeg = (r) => /leg/.test(r.selector);

test("one-shot intro starts exactly at the rest pose (no teleport between idle and the walk)", () => {
  const { keyframes, rules } = loadCrabwalk();
  const intros = rules.filter((r) => !r.anim.infinite && r.anim.forwards && /intro/.test(r.selector));
  assert.ok(intros.length > 0,
    "crabwalk needs a finite `forwards` intro on the wrapper groups so the walk eases out of the idle pose instead of teleporting");
  for (const { selector, anim } of intros) {
    assert.ok(Math.abs(anim.duration - 0.3) <= 0.05,
      `${selector}: intro should last ~300ms, got ${anim.duration}s`);
    const first = keyframes[anim.name][0];
    assert.equal(first.pct, 0, `${selector}: intro keyframes must start at 0%`);
    const t = first.transform;
    if (t) {
      assert.deepEqual(t, { x: 0, y: 0, rotate: 0 },
        `${selector}: first intro keyframe must be the rest pose (no translate/rotate), otherwise the pet jumps when switching from idle to the walk`);
    }
  }
});

test("looping body/shadow motion stays centred on rest with small amplitude", () => {
  const { keyframes, rules } = loadCrabwalk();
  const loops = rules.filter((r) => r.anim.infinite && BODY_SHADOW.test(r.selector));
  assert.ok(loops.length > 0, "expected looping body/shadow animations");
  for (const { selector, anim } of loops) {
    for (const { pct, transform: t } of keyframes[anim.name]) {
      if (!t) continue;
      const where = `${selector} (${anim.name} @${pct}%)`;
      const why = "a loop offset from rest makes the pet teleport between idle and the walk";
      assert.ok(Math.abs(t.x) <= MAX_TRANSLATE && Math.abs(t.y) <= MAX_TRANSLATE,
        `${where}: translate (${t.x}, ${t.y}) exceeds ${MAX_TRANSLATE}px; ${why}`);
      assert.ok(Math.abs(t.rotate) <= MAX_ROTATE,
        `${where}: rotate ${t.rotate}deg exceeds ${MAX_ROTATE}deg; ${why}`);
    }
  }
});

test("loops start after the intro so they do not fight it", () => {
  const { rules } = loadCrabwalk();
  const intro = Math.max(...rules.filter((r) => !r.anim.infinite && /intro/.test(r.selector))
    .map((r) => r.anim.duration), 0);
  assert.ok(intro > 0, "no intro found; the walk would start with a teleport from idle");
  for (const { selector, anim } of rules.filter((r) => r.anim.infinite)) {
    assert.ok(anim.delay >= intro - 1e-9,
      `${selector}: loop delay ${anim.delay}s < intro ${intro}s; the loop and intro would fight and the pet would jump between idle and the walk`);
  }
});

test("legs keep the original 0.5s alternating step cadence", () => {
  const { rules } = loadCrabwalk();
  const legs = rules.filter(isLeg);
  assert.equal(legs.length, 2, "expected leg-1 and leg-2 animations");
  for (const { selector, anim } of legs) {
    assert.equal(anim.duration, 0.5, `${selector}: step cadence must stay 0.5s (unchanged character)`);
  }
  const phase = (l) => ((l.anim.delay % 0.5) + 0.5) % 0.5;
  const differ = legs[0].anim.name !== legs[1].anim.name
    || Math.abs(phase(legs[0]) - phase(legs[1])) > 1e-9;
  assert.ok(differ, "the two legs must alternate (different keyframes or half-step delay)");
});
