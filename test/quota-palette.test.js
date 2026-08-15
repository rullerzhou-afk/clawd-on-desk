"use strict";

// The Orbit coins (quota-ring.html) and the Dashboard bars (dashboard.html)
// are separate browser documents that cannot share a stylesheet, so the
// provider palette and the severity colors live in both. This suite pins the
// mirror: same tokens, same values, same thresholds — and guards the two
// palette invariants the comments in quota-ring.html promise:
//   1. no two identity hues collide (the original Kimi draft reused Claude's
//      inner blue verbatim and sat 15° off Codex's violet);
//   2. identity hues stay clear of the warm alert band that sev-warn/sev-hot
//      own, so a warm arc/bar still means exactly one thing.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const quotaRingHtml = fs.readFileSync(path.join(__dirname, "..", "src", "quota-ring.html"), "utf8");
const dashboardHtml = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");
const quotaRingRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "quota-ring-renderer.js"), "utf8");
const dashboardRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");

const PROVIDERS = ["claude", "codex", "antigravity", "kimi"];
const SLOTS = ["outer", "inner"];

function tokens(source, prefix) {
  const found = {};
  for (const match of source.matchAll(new RegExp(`${prefix}([a-z]+)-(outer|inner):\\s*(#[0-9a-fA-F]{6})`, "g"))) {
    found[`${match[1]}-${match[2]}`] = match[3].toLowerCase();
  }
  return found;
}

function scalarToken(source, name) {
  const match = source.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  return match ? match[1].toLowerCase() : null;
}

function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe("quota palette mirror across Orbit and Dashboard", () => {
  it("declares the same provider/slot identity tokens with the same values in both surfaces", () => {
    const ring = tokens(quotaRingHtml, "--id-");
    const dash = tokens(dashboardHtml, "--id-");
    for (const provider of PROVIDERS) {
      for (const slot of SLOTS) {
        const name = `${provider}-${slot}`;
        assert.ok(ring[name], `quota-ring.html is missing --id-${name}`);
        assert.ok(dash[name], `dashboard.html is missing --id-${name}`);
        assert.strictEqual(
          dash[name], ring[name],
          `--id-${name} diverged: ring ${ring[name]} vs dashboard ${dash[name]}`
        );
        assert.match(
          dashboardHtml,
          new RegExp(`\\.quota-bar-fill\\.pv-${provider}Quota\\.rg-${slot}\\s*\\{[^}]*var\\(--id-${name}\\)`),
          `dashboard.html has no bar rule painting ${provider}/${slot} in its identity hue`
        );
        assert.match(
          quotaRingHtml,
          new RegExp(`\\.pv-${provider}Quota\\.rg-${slot}\\s*\\{[^}]*--ring-id`),
          `quota-ring.html has no coin rule resolving ${provider}/${slot}`
        );
      }
    }
  });

  it("keeps every identity hue unique and each provider's two windows apart", () => {
    const ring = tokens(quotaRingHtml, "--id-");
    const names = PROVIDERS.flatMap((p) => SLOTS.map((s) => `${p}-${s}`));
    const values = names.map((name) => ring[name]);
    assert.strictEqual(new Set(values).size, values.length, "two rings share one exact color");
    for (const provider of PROVIDERS) {
      assert.notStrictEqual(
        ring[`${provider}-outer`], ring[`${provider}-inner`],
        `${provider} paints its outer and inner rings the same color`
      );
      // Same family, still tellable apart: the pair stays at least 25° apart.
      const gap = hueDistance(hexToHue(ring[`${provider}-outer`]), hexToHue(ring[`${provider}-inner`]));
      assert.ok(gap >= 25, `${provider}'s window hues are only ${gap.toFixed(1)}° apart`);
    }
    // Cross-provider floor. 10° legalizes the tightest pre-existing pair
    // (Codex cyan vs Antigravity sky, ~10.4°) while forbidding exact/near
    // duplicates like the original Kimi/Claude collision.
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const gap = hueDistance(hexToHue(ring[names[i]]), hexToHue(ring[names[j]]));
        assert.ok(gap >= 10, `${names[i]} and ${names[j]} are only ${gap.toFixed(1)}° apart`);
      }
    }
  });

  it("keeps identity hues out of the warm alert band owned by severity", () => {
    const ring = tokens(quotaRingHtml, "--id-");
    for (const source of [quotaRingHtml, dashboardHtml]) {
      assert.strictEqual(scalarToken(source, "--sev-warn"), "#fbbf24");
      assert.strictEqual(scalarToken(source, "--sev-hot"), "#f87171");
    }
    const alerts = ["#fbbf24", "#f87171"].map(hexToHue);
    for (const [name, value] of Object.entries(ring)) {
      for (const alertHue of alerts) {
        const gap = hueDistance(hexToHue(value), alertHue);
        assert.ok(gap >= 25, `--id-${name} sits ${gap.toFixed(1)}° from an alert hue`);
      }
    }
  });

  it("mirrors the 60/85 severity thresholds across both renderers", () => {
    assert.match(quotaRingRenderer, /WARN_AT = 60/);
    assert.match(quotaRingRenderer, /HOT_AT = 85/);
    assert.match(dashboardRenderer, /QUOTA_WARN_AT = 60/);
    assert.match(dashboardRenderer, /QUOTA_HOT_AT = 85/);
    assert.match(dashboardRenderer, /function quotaSeverityClass\(usedPercent\)/);
    // The bar carries the same classes the coin uses: provider, logical
    // window, severity.
    assert.match(dashboardRenderer, /`quota-bar-fill pv-\$\{providerKey\} rg-\$\{ringSlot\} \$\{quotaSeverityClass/);
    assert.match(dashboardHtml, /\.quota-bar-fill\.sev-warn\s*\{[^}]*var\(--sev-warn\)/);
    assert.match(dashboardHtml, /\.quota-bar-fill\.sev-hot\s*\{[^}]*var\(--sev-hot\)/);
  });

  it("paints Dashboard-only Spark bars in the Codex family hues", () => {
    assert.match(
      dashboardHtml,
      /\.quota-bar-fill\.pv-codexSparkQuota\.rg-outer\s*\{[^}]*var\(--id-codex-outer\)/
    );
    assert.match(
      dashboardHtml,
      /\.quota-bar-fill\.pv-codexSparkQuota\.rg-inner\s*\{[^}]*var\(--id-codex-inner\)/
    );
  });
});
