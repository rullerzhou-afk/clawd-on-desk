const { describe, it } = require("node:test");
const assert = require("node:assert");

const ringGeom = require("../src/quota-ring-geometry");
const {
  countQuotaCoins,
  formatWindowLabel,
  quotaSeverity,
  ringClusterContentSize,
  resolveRingSide,
  computeQuotaRingBounds,
  constants,
} = ringGeom;

const future = Date.now() + 3600000;

function bucket(pct) {
  return { usedPercent: pct, resetAt: future };
}

describe("quota ring — coin counting", () => {
  it("counts one coin per (source, provider) with a drawable bucket", () => {
    const snapshot = {
      accountQuota: [
        {
          host: null,
          claudeQuota: { group: { claudeFiveHour: bucket(41), claudeWeekly: bucket(20) }, updatedAt: 1 },
          codexQuota: { group: { codexFiveHour: bucket(72) }, updatedAt: 1 },
          kimiQuota: { group: { kimiFiveHour: bucket(0), kimiWeekly: bucket(0) }, updatedAt: 1 },
        },
        { host: "pi", claudeQuota: { group: { claudeWeekly: bucket(9) }, updatedAt: 1 } },
      ],
    };
    // 3 providers on local + 1 on the remote = 4 coins (a provider with two
    // windows is still ONE coin — the two windows become concentric rings).
    assert.strictEqual(countQuotaCoins(snapshot, true), 4);
  });

  it("still counts a source whose only window has expired (dimmed reset coin)", () => {
    const snapshot = {
      accountQuota: [
        { host: "x", codexQuota: { group: { codexFiveHour: { usedPercent: 9, resetAt: Date.now() - 1000, expired: true } }, updatedAt: 1 } },
      ],
    };
    assert.strictEqual(countQuotaCoins(snapshot, true), 1);
  });

  it("returns 0 when quota is disabled or empty", () => {
    const drawable = { accountQuota: [{ claudeQuota: { group: { claudeWeekly: bucket(10) }, updatedAt: 1 } }] };
    assert.strictEqual(countQuotaCoins(drawable, false), 0);
    assert.strictEqual(countQuotaCoins({ accountQuota: [] }, true), 0);
    assert.strictEqual(countQuotaCoins({}, true), 0);
  });

  it("does not count Dashboard-only Spark quota as an Orbit coin", () => {
    const sparkOnly = {
      accountQuota: [{
        codexSparkQuota: {
          group: { codexWeekly: bucket(7) },
          updatedAt: 1,
        },
      }],
    };
    assert.strictEqual(countQuotaCoins(sparkOnly, true), 0);
  });

  it("counts Antigravity third-party-only quota without creating another agent coin", () => {
    const thirdPartyOnly = {
      accountQuota: [{ antigravityQuota: { group: { thirdPartyWeekly: bucket(52) }, updatedAt: 1 } }],
    };
    assert.strictEqual(countQuotaCoins(thirdPartyOnly, true), 1);
    const allAntigravity = {
      accountQuota: [{
        antigravityQuota: {
          group: {
            geminiFiveHour: bucket(10),
            geminiWeekly: bucket(20),
            thirdPartyFiveHour: bucket(30),
            thirdPartyWeekly: bucket(40),
          },
          updatedAt: 1,
        },
      }],
    };
    assert.strictEqual(countQuotaCoins(allAntigravity, true), 1);
  });
});

describe("quota ring — cluster sizing", () => {
  it("grows height with coin count and keeps a fixed content width", () => {
    const one = ringClusterContentSize(1);
    const two = ringClusterContentSize(2);
    assert.strictEqual(one.width, two.width, "width is fixed (coin + readout column)");
    assert.ok(two.height > one.height, "two coins are taller than one");
    assert.strictEqual(two.height - one.height, constants.COIN_SIZE + constants.COIN_GAP);
    assert.strictEqual(one.overflow, 0);
  });

  it("caps visible coins and reports the overflow, adding a row for the +N pill", () => {
    const capped = ringClusterContentSize(constants.RING_MAX_COINS + 2);
    assert.strictEqual(capped.visible, constants.RING_MAX_COINS);
    assert.strictEqual(capped.overflow, 2);
    const exactly = ringClusterContentSize(constants.RING_MAX_COINS);
    assert.ok(capped.height > exactly.height, "the overflow pill adds height");
    assert.strictEqual(exactly.overflow, 0);
  });
});

describe("quota ring — side resolution & edge flip", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };

  it("defaults to the pet's left (clear of the right-entering permission bubble)", () => {
    const side = resolveRingSide({ petLeft: 700, petRight: 850, workArea, clusterWidth: 80 });
    assert.strictEqual(side, "left");
  });

  it("flips to the right when the pet hugs the left edge", () => {
    const side = resolveRingSide({ petLeft: 20, petRight: 170, workArea, clusterWidth: 80 });
    assert.strictEqual(side, "right");
  });

  it("keeps the side with more room when neither side fully fits", () => {
    const narrow = { x: 0, y: 0, width: 200, height: 900 };
    // Pet near the right edge of a narrow work area → left has more room.
    const side = resolveRingSide({ petLeft: 150, petRight: 190, workArea: narrow, clusterWidth: 300 });
    assert.strictEqual(side, "left");
  });
});

describe("quota ring — bounds placement", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  const hitRect = { left: 700, top: 400, right: 850, bottom: 550 };

  it("returns null when there are no coins", () => {
    assert.strictEqual(computeQuotaRingBounds({ hitRect, workArea, coinCount: 0 }), null);
    assert.strictEqual(computeQuotaRingBounds({ hitRect: null, workArea, coinCount: 2 }), null);
  });

  it("places the cluster to the left of the pet, vertically centered on the body", () => {
    const r = computeQuotaRingBounds({ hitRect, workArea, coinCount: 2, scale: 1 });
    assert.strictEqual(r.side, "left");
    // Content sits gap px to the left of the pet body.
    assert.strictEqual(r.contentBounds.x + r.contentBounds.width, hitRect.left - constants.RING_PET_GAP);
    // Vertically centered on the pet body center (475).
    const petCy = (hitRect.top + hitRect.bottom) / 2;
    const ringCy = r.contentBounds.y + r.contentBounds.height / 2;
    assert.ok(Math.abs(ringCy - petCy) <= 1);
    // Outer window bounds wrap the content by the transparent shell.
    assert.strictEqual(r.bounds.x, r.contentBounds.x - constants.RING_SHELL.left);
    assert.ok(r.bounds.width > r.contentBounds.width);
  });

  it("flips to the right of the pet near the left edge and stays on-screen", () => {
    const leftPet = { left: 16, top: 400, right: 150, bottom: 520 };
    const r = computeQuotaRingBounds({ hitRect: leftPet, workArea, coinCount: 2, scale: 1 });
    assert.strictEqual(r.side, "right");
    assert.strictEqual(r.contentBounds.x, leftPet.right + constants.RING_PET_GAP);
    assert.ok(r.contentBounds.x >= workArea.x);
  });

  it("scales the footprint and gaps with textScale", () => {
    const base = computeQuotaRingBounds({ hitRect, workArea, coinCount: 2, scale: 1 });
    const big = computeQuotaRingBounds({ hitRect, workArea, coinCount: 2, scale: 1.5 });
    assert.ok(big.contentBounds.width > base.contentBounds.width);
    assert.ok(big.contentBounds.height > base.contentBounds.height);
  });

  it("clamps a tall cluster inside the work area vertically", () => {
    const shortWa = { x: 0, y: 0, width: 1440, height: 300 };
    const r = computeQuotaRingBounds({ hitRect, workArea: shortWa, coinCount: 4, scale: 1 });
    assert.ok(r.contentBounds.y >= shortWa.y);
    assert.ok(r.contentBounds.y + r.contentBounds.height <= shortWa.y + shortWa.height);
  });

  it("moves a four-coin Orbit clear of the visible Session HUD", () => {
    const pet = { left: 573, top: 306, right: 651, bottom: 424 };
    const hud = { x: 455, y: 378, width: 296, height: 30 };
    const r = computeQuotaRingBounds({
      hitRect: pet,
      workArea: { x: 0, y: 0, width: 1280, height: 800 },
      coinCount: 4,
      scale: 1,
      avoidRects: [hud],
    });
    const overlapW = Math.max(
      0,
      Math.min(r.contentBounds.x + r.contentBounds.width, hud.x + hud.width)
        - Math.max(r.contentBounds.x, hud.x)
    );
    const overlapH = Math.max(
      0,
      Math.min(r.contentBounds.y + r.contentBounds.height, hud.y + hud.height)
        - Math.max(r.contentBounds.y, hud.y)
    );
    assert.strictEqual(overlapW * overlapH, 0);
  });

  it("moves a four-coin Orbit clear of fixed permission and update bubbles", () => {
    // Real default-theme geometry from the review repro: right-bottom Clawd,
    // bubbleFollowPet=false, one permission bubble plus one update bubble.
    const pet = { left: 1182.955, top: 738.26, right: 1247.045, bottom: 783.5 };
    const avoids = [
      { x: 1065, y: 788, width: 296, height: 30 }, // Session HUD
      { x: 1092, y: 692, width: 340, height: 200 }, // permission
      { x: 1092, y: 742, width: 340, height: 150 }, // update
    ];
    const r = computeQuotaRingBounds({
      hitRect: pet,
      workArea,
      coinCount: 4,
      scale: 1,
      avoidRects: avoids,
    });

    assert.deepStrictEqual(r.contentBounds, { x: 1087, y: 540, width: 88, height: 146 });
    for (const rect of avoids) {
      assert.strictEqual(
        ringGeom.overlapArea(r.contentBounds, rect, 6),
        0,
        `Orbit overlaps ${JSON.stringify(rect)}`
      );
    }
  });
});

describe("quota ring — window labels & severity", () => {
  it("derives labels from windowMinutes, never assuming 5h/7d", () => {
    assert.strictEqual(formatWindowLabel(300, "5h"), "5h");
    assert.strictEqual(formatWindowLabel(60, "x"), "1h");
    assert.strictEqual(formatWindowLabel(10080, "x"), "7d");
    assert.strictEqual(formatWindowLabel(1440, "x"), "1d");
    assert.strictEqual(formatWindowLabel(90, "x"), "90m");
    assert.strictEqual(formatWindowLabel(undefined, "wk"), "wk", "falls back when no minutes");
    assert.strictEqual(formatWindowLabel(0, "wk"), "wk");
  });

  it("maps used percent to severity buckets (hot > 85, warn >= 60, else ok)", () => {
    assert.strictEqual(quotaSeverity(10), "ok");
    assert.strictEqual(quotaSeverity(59), "ok");
    assert.strictEqual(quotaSeverity(60), "warn");
    assert.strictEqual(quotaSeverity(85), "warn");
    assert.strictEqual(quotaSeverity(86), "hot");
    assert.strictEqual(quotaSeverity(100), "hot");
  });
});

// The pet-side cluster caps at RING_MAX_COINS and the renderer simply takes the
// first N in provider order, so without a per-provider opt-out the user has no
// say over WHICH coins survive. Hiding is display-only: collection and the
// Dashboard are untouched.
describe("quota ring — per-provider visibility", () => {
  const snapshot = {
    accountQuota: [
      {
        host: null,
        claudeQuota: { group: { claudeFiveHour: bucket(41) }, updatedAt: 1 },
        codexQuota: { group: { codexWeekly: bucket(31) }, updatedAt: 1 },
        kimiQuota: { group: { kimiFiveHour: bucket(0), kimiWeekly: bucket(11) }, updatedAt: 1 },
      },
    ],
  };

  it("drops hidden providers from the coin count that sizes the window", () => {
    assert.strictEqual(countQuotaCoins(snapshot, true), 3);
    assert.strictEqual(countQuotaCoins(snapshot, true, ["codexQuota"]), 2);
    assert.strictEqual(countQuotaCoins(snapshot, true, ["codexQuota", "kimiQuota"]), 1);
    assert.strictEqual(
      countQuotaCoins(snapshot, true, ["claudeQuota", "codexQuota", "kimiQuota"]), 0,
      "hiding every provider must collapse the cluster, not leave an empty window"
    );
  });

  it("treats a missing, empty or junk hidden list as hiding nothing", () => {
    for (const hidden of [undefined, null, [], ["  "], [""], [null, 7, {}], "codexQuota"]) {
      assert.strictEqual(
        countQuotaCoins(snapshot, true, hidden), 3,
        `hidden=${JSON.stringify(hidden)} must not drop a coin`
      );
    }
  });

  it("keeps the master switch ahead of the per-provider list", () => {
    assert.strictEqual(countQuotaCoins(snapshot, false, []), 0);
    assert.strictEqual(countQuotaCoins(snapshot, false, ["codexQuota"]), 0);
  });

  it("counts a hidden provider once per source, not once overall", () => {
    const twoSources = {
      accountQuota: [
        { host: null, codexQuota: { group: { codexWeekly: bucket(31) }, updatedAt: 1 } },
        { host: "pi", codexQuota: { group: { codexWeekly: bucket(9) }, updatedAt: 1 } },
      ],
    };
    assert.strictEqual(countQuotaCoins(twoSources, true), 2);
    assert.strictEqual(
      countQuotaCoins(twoSources, true, ["codexQuota"]), 0,
      "hiding a provider hides it on every reporting machine"
    );
  });

  it("lists only providers that actually report, flagging the hidden ones", () => {
    const listed = ringGeom.listQuotaRingProviders(snapshot, ["codexQuota"]);
    assert.deepStrictEqual(listed.map((p) => p.key), ["claudeQuota", "codexQuota", "kimiQuota"]);
    assert.deepStrictEqual(listed.map((p) => p.label), ["Claude", "Codex", "Kimi"]);
    // Antigravity reports nothing here, so it must not be offered — the same
    // rule that keeps "merge across machines" hidden on a single machine.
    assert.ok(!listed.some((p) => p.key === "antigravityQuota"));
    // An already-hidden provider still lists, or it could never be turned back on.
    assert.deepStrictEqual(listed.map((p) => p.hidden), [false, true, false]);
  });

  it("lists nothing for an empty snapshot instead of offering every provider", () => {
    assert.deepStrictEqual(ringGeom.listQuotaRingProviders({ accountQuota: [] }, []), []);
    assert.deepStrictEqual(ringGeom.listQuotaRingProviders(null, []), []);
  });
});

// The renderer runs in a page that cannot require this module, so it carries its
// own copy of RING_PROVIDERS and its own hidden-provider filter. If the two ever
// disagree the window is sized for coins the renderer never draws (or clips ones
// it does), which is invisible in unit tests of either side alone.
describe("quota ring — geometry/renderer mirror", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const rendererSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "quota-ring-renderer.js"), "utf8"
  );

  // RING_PROVIDERS is not exported, so read the geometry's order back through
  // listQuotaRingProviders with every provider reporting — that walks the real
  // table in the real order rather than trusting a second hand-kept copy.
  const everyProvider = {
    accountQuota: [{
      host: null,
      antigravityQuota: { group: { geminiFiveHour: bucket(1) }, updatedAt: 1 },
      claudeQuota: { group: { claudeFiveHour: bucket(1) }, updatedAt: 1 },
      codexQuota: { group: { codexFiveHour: bucket(1) }, updatedAt: 1 },
      kimiQuota: { group: { kimiFiveHour: bucket(1) }, updatedAt: 1 },
    }],
  };

  it("declares the same provider keys, in the same order, on both sides", () => {
    const rendererKeys = [...rendererSource.matchAll(/key:\s*"(\w+Quota)"/g)].map((m) => m[1]);
    const geometryKeys = ringGeom.listQuotaRingProviders(everyProvider, []).map((p) => p.key);
    assert.strictEqual(geometryKeys.length, 4, "the all-providers fixture must exercise the table");
    assert.deepStrictEqual(
      rendererKeys, geometryKeys,
      "provider order decides which coins survive the four-coin cap"
    );
  });

  it("gives every provider the same brand label on both sides", () => {
    const rendererLabels = [...rendererSource.matchAll(/key:\s*"(\w+Quota)",\s*label:\s*"([^"]+)"/g)]
      .map((m) => [m[1], m[2]]);
    assert.ok(rendererLabels.length >= 4, `expected renderer labels, got ${rendererLabels.length}`);
    const listed = ringGeom.listQuotaRingProviders(everyProvider, []);
    for (const [key, label] of rendererLabels) {
      const match = listed.find((p) => p.key === key);
      assert.ok(match, `${key} reports in the renderer but not in the geometry list`);
      assert.strictEqual(match.label, label, `${key} label diverged`);
    }
  });

  it("applies the hidden filter in the renderer, not only when sizing", () => {
    // Sizing without drawing (or the reverse) leaves the transparent window and
    // its auto-hide hot zone wrong, which no per-side test would catch.
    assert.match(rendererSource, /hiddenQuotaProviders/);
    assert.match(rendererSource, /function hiddenProviderSet\(\)/);
    assert.match(rendererSource, /if \(hidden && hidden\.has\(def\.key\)\) continue;/);
  });
});
