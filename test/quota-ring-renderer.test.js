"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rendererSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "quota-ring-renderer.js"),
  "utf8"
);
const rendererHtmlSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "quota-ring.html"),
  "utf8"
);

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.attributes = {};
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.title = "";
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  setAttributeNS(_namespace, name, value) {
    this.setAttribute(name, value);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  addEventListener() {}
}

function loadRenderer() {
  const cluster = new FakeElement("div");
  const context = {
    document: {
      getElementById: () => cluster,
      createElement: (tag) => new FakeElement(tag),
      createElementNS: (_namespace, tag) => new FakeElement(tag),
    },
    window: {
      quotaRingAPI: {
        onLangChange() {},
        onSnapshot() {},
        getI18n: async () => null,
        openDashboard() {},
      },
    },
    setInterval() {},
    Date,
    Math,
    Promise,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(rendererSource, context);
  vm.runInContext(`
    payload = {
      accountQuota: [],
      quotaAgentIcons: {},
      displayMode: "used",
      side: "left",
      translations: {
        dashboardQuotaGroupGemini: "Gemini",
        dashboardQuotaGroupThirdParty: "Claude/GPT",
        dashboardQuotaSourceLocal: "Local",
        quotaRingReset: "reset",
        quotaRingRemainingWord: "remaining",
        dashboardQuotaResetIn: "resets in {time}",
        dashboardQuotaResetHoursMinutes: "{h}h {m}m",
        dashboardQuotaResetMinutes: "{m}m",
        dashboardQuotaAsOf: "as of {time} ago"
      }
    };
  `, context);
  return context;
}

// Drives the flashback state machine the way the real callbacks do: push a
// snapshot, fold it in, then ask what the readout would print.
function flashHarness(context) {
  const run = (expr, vars = {}) => {
    Object.assign(context, vars);
    return vm.runInContext(expr, context);
  };
  return {
    push(accountQuota, now) {
      run("payload = { ...payload, accountQuota: __q };"
        + " __coins = collectCoins(__now); noteRestingWindows(__coins, __now);",
      { __q: accountQuota, __now: now });
    },
    setVisible(visible) {
      run("ringVisible = __v", { __v: visible });
    },
    reveal(now) {
      return run("armPendingFlashes(collectCoins(__now), __now)", { __now: now });
    },
    // What the coin's digits say at this instant. Rebuilt in this realm: an
    // object returned straight out of the vm has a different Object prototype
    // and deepStrictEqual compares prototypes.
    readout(now) {
      const out = run(`(() => {
        const model = collectCoins(__now)[0];
        model.flashingResting = isFlashing(model, __now);
        const row = buildCoinRow(model);
        return {
          pct: row.children[0].children[0].textContent,
          win: row.children[0].children[1].textContent,
          flashing: model.flashingResting,
        };
      })()`, { __now: now });
      return { pct: out.pct, win: out.win, flashing: out.flashing };
    },
  };
}

const claudeSource = (five, week, now) => [{
  host: null,
  claudeQuota: {
    lastSeenAt: now,
    group: {
      claudeFiveHour: { usedPercent: five, resetAt: now + 3_600_000, windowMinutes: 300, lastSeenAt: now },
      claudeWeekly: { usedPercent: week, resetAt: now + 3_600_000, windowMinutes: 10080, lastSeenAt: now },
    },
  },
}];

function modelFor(context, source, providerIndex, now, multiSource = false) {
  context.__source = source;
  context.__now = now;
  context.__multiSource = multiSource;
  return vm.runInContext(
    "buildCoinModel(__source, RING_PROVIDERS[" + providerIndex + "], __now, __multiSource)",
    context
  );
}

describe("quota ring renderer model", () => {
  it("compresses all four Antigravity buckets to the most constrained rolling and weekly rings", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const future = now + 3_600_000;
    const model = modelFor(context, {
      antigravityQuota: {
        group: {
          geminiFiveHour: { usedPercent: 30, resetAt: future, windowMinutes: 300 },
          geminiWeekly: { usedPercent: 40, resetAt: future, windowMinutes: 10080 },
          thirdPartyFiveHour: { usedPercent: 72, resetAt: future, windowMinutes: 300 },
          thirdPartyWeekly: { usedPercent: 91, resetAt: future, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 0, now);

    assert.strictEqual(model.windows.length, 2);
    assert.strictEqual(model.windows[0].field, "thirdPartyFiveHour");
    assert.strictEqual(model.windows[0].label, "C/G·5h");
    assert.strictEqual(model.windows[1].field, "thirdPartyWeekly");
    assert.strictEqual(model.windows[1].detailLabel, "Claude/GPT · 7d");
    assert.strictEqual(model.binding.field, "thirdPartyWeekly");
  });

  it("renders third-party-only Antigravity quota instead of dropping the provider", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      antigravityQuota: {
        group: {
          thirdPartyWeekly: {
            usedPercent: 52,
            resetAt: now + 3_600_000,
            windowMinutes: 10080,
          },
        },
        lastSeenAt: now,
      },
    }, 0, now);

    assert.ok(model);
    assert.strictEqual(model.windows.length, 1);
    assert.strictEqual(model.windows[0].field, "thirdPartyWeekly");
  });

  it("pulses only the binding ring when the inner window is near exhaustion", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      claudeQuota: {
        group: {
          claudeFiveHour: { usedPercent: 20, resetAt: now + 3_600_000, windowMinutes: 300 },
          claudeWeekly: { usedPercent: 90, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 1, now);
    context.__model = model;
    const svg = vm.runInContext("buildCoinSvg(__model)", context);
    const fills = svg.children.filter((child) =>
      typeof child.attributes.class === "string" && child.attributes.class.includes("fill"));

    assert.strictEqual(fills.length, 2);
    assert.doesNotMatch(fills[0].attributes.class, /is-near/);
    assert.match(fills[1].attributes.class, /sev-hot is-near/);
    // The readout follows the alert instead of the rolling window here. Printing
    // "20% 5h" over a 90% weekly ring was the most reassuring reading available
    // while the only thing reporting trouble was the inner ring's color.
    assert.strictEqual(model.displayWindow.field, "claudeWeekly");
    context.__model = model;
    context.__now = now;
    const row = vm.runInContext("buildCoinRow(__model, __now)", context);
    const readout = row.children[0];
    assert.strictEqual(readout.children[0].textContent, "90%");
    assert.strictEqual(readout.children[1].textContent, "7d");
  });

  it("keeps the rolling readout while the weekly window is merely busy", () => {
    // The handover is scoped to alerts. Below the warning threshold the readout
    // still answers "what am I using right now?", which is the common question;
    // yielding on every higher number would bury the rolling window for good.
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      claudeQuota: {
        group: {
          claudeFiveHour: { usedPercent: 20, resetAt: now + 3_600_000, windowMinutes: 300 },
          claudeWeekly: { usedPercent: 59, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 1, now);
    assert.strictEqual(model.binding.field, "claudeWeekly");
    assert.strictEqual(model.displayWindow.field, "claudeFiveHour");
    context.__model = model;
    context.__now = now;
    const row = vm.runInContext("buildCoinRow(__model, __now)", context);
    assert.strictEqual(row.children[0].children[0].textContent, "20%");
    assert.strictEqual(row.children[0].children[1].textContent, "5h");
  });

  it("hands the readout to an inner window that is merely in warning, not just critical", () => {
    // The 60-85 band has no pulse at all, so without this the amber inner ring
    // is the only signal — and the digits actively contradict it.
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      claudeQuota: {
        group: {
          claudeFiveHour: { usedPercent: 1, resetAt: now + 3_600_000, windowMinutes: 300 },
          claudeWeekly: { usedPercent: 61, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 1, now);
    assert.strictEqual(model.displayWindow.field, "claudeWeekly");
    context.__model = model;
    context.__now = now;
    const row = vm.runInContext("buildCoinRow(__model, __now)", context);
    assert.strictEqual(row.children[0].children[0].textContent, "61%");
    assert.strictEqual(row.children[0].children[1].textContent, "7d");
  });

  it("falls back to the weekly readout when the short window is absent", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      codexQuota: {
        group: {
          codexWeekly: { usedPercent: 12, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 2, now);
    context.__model = model;
    context.__now = now;
    const row = vm.runInContext("buildCoinRow(__model, __now)", context);
    const readout = row.children[0];

    assert.strictEqual(model.displayWindow.field, "codexWeekly");
    assert.strictEqual(readout.children[0].textContent, "12%");
    assert.strictEqual(readout.children[1].textContent, "7d");
  });

  it("uses a fresh weekly readout instead of presenting a stale short window as live", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      codexQuota: {
        group: {
          codexFiveHour: {
            usedPercent: 3,
            resetAt: now + 3_600_000,
            windowMinutes: 300,
            lastSeenAt: now - 6 * 60_000,
          },
          codexWeekly: {
            usedPercent: 88,
            resetAt: now + 3_600_000,
            windowMinutes: 10080,
            lastSeenAt: now,
          },
        },
        lastSeenAt: now - 6 * 60_000,
      },
    }, 2, now);
    context.__model = model;
    context.__now = now;
    const row = vm.runInContext("buildCoinRow(__model, __now)", context);
    const readout = row.children[0];

    assert.strictEqual(model.state, "live");
    assert.strictEqual(model.binding.field, "codexWeekly");
    assert.strictEqual(model.displayWindow.field, "codexWeekly");
    assert.strictEqual(readout.children[0].textContent, "88%");
    assert.strictEqual(readout.children[1].textContent, "7d");
  });

  it("keeps an existing reset short window as the readout while weekly remains live", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      codexQuota: {
        group: {
          codexFiveHour: { usedPercent: 90, resetAt: now - 1, windowMinutes: 300 },
          codexWeekly: { usedPercent: 40, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 2, now);
    context.__model = model;
    context.__now = now;
    const row = vm.runInContext("buildCoinRow(__model, __now)", context);
    const readout = row.children[0];

    assert.strictEqual(model.state, "live");
    assert.strictEqual(model.displayWindow.field, "codexFiveHour");
    assert.strictEqual(model.displayWindow.reset, true);
    assert.strictEqual(readout.children[0].textContent, "0%");
    assert.strictEqual(readout.children[1].textContent, "reset");
  });

  it("renders remaining percentage and arc length without changing exhaustion severity", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      claudeQuota: {
        group: {
          claudeFiveHour: { usedPercent: 80, resetAt: now + 3_600_000, windowMinutes: 300 },
        },
        lastSeenAt: now,
      },
    }, 1, now);
    context.__model = model;
    vm.runInContext('payload.displayMode = "remaining"', context);

    const row = vm.runInContext("buildCoinRow(__model)", context);
    assert.strictEqual(row.children[0].children[0].textContent, "20%");

    const svg = vm.runInContext("buildCoinSvg(__model)", context);
    const fill = svg.children.find((child) =>
      typeof child.attributes.class === "string" && child.attributes.class.includes("fill"));
    assert.match(fill.attributes.class, /sev-warn/);
    assert.match(fill.attributes["stroke-dasharray"], /^13\.82 /);
  });

  it("shows a reset outer ring as a weak full remaining arc", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      codexQuota: {
        group: {
          codexFiveHour: { usedPercent: 90, resetAt: now - 1, windowMinutes: 300 },
        },
        lastSeenAt: now,
      },
    }, 2, now);
    context.__model = model;
    vm.runInContext('payload.displayMode = "remaining"', context);

    const row = vm.runInContext("buildCoinRow(__model)", context);
    assert.strictEqual(row.children[0].children[0].textContent, "100%");
    assert.strictEqual(row.children[0].children[1].textContent, "reset");

    const svg = vm.runInContext("buildCoinSvg(__model)", context);
    const fills = svg.children.filter((child) =>
      typeof child.attributes.class === "string" && child.attributes.class.includes("fill"));
    assert.strictEqual(fills.length, 1);
    assert.match(fills[0].attributes.class, /sev-reset/);
    assert.match(fills[0].attributes["stroke-dasharray"], /^69\.12 69\.12$/);
    assert.doesNotMatch(fills[0].attributes.class, /is-near/);
  });

  it("renders an inner reset window as a weak full arc in a dual-ring coin", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      claudeQuota: {
        group: {
          claudeFiveHour: { usedPercent: 80, resetAt: now + 3_600_000, windowMinutes: 300 },
          claudeWeekly: { usedPercent: 95, resetAt: now - 1, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 1, now);
    context.__model = model;
    vm.runInContext('payload.displayMode = "remaining"', context);

    const svg = vm.runInContext("buildCoinSvg(__model)", context);
    const fills = svg.children.filter((child) =>
      typeof child.attributes.class === "string" && child.attributes.class.includes("fill"));
    assert.strictEqual(fills.length, 2);
    assert.match(fills[0].attributes.class, /sev-warn/);
    assert.match(fills[0].attributes["stroke-dasharray"], /^13\.82 /);
    assert.match(fills[1].attributes.class, /sev-reset/);
    assert.match(fills[1].attributes["stroke-dasharray"], /^42\.73 42\.73$/);
    assert.doesNotMatch(fills[1].attributes.class, /is-near/);
  });

  it("keeps quota rows and overflow free of hover tooltips", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      codexQuota: {
        group: {
          codexWeekly: { usedPercent: 46, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 2, now);
    context.__model = model;

    const row = vm.runInContext("buildCoinRow(__model)", context);
    const overflow = vm.runInContext("buildOverflow(2)", context);
    assert.strictEqual(row.title, "");
    assert.strictEqual(overflow.title, "");
  });

  it("shows a compact source marker when more than one machine contributes quota", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      host: "remote-build-host",
      codexQuota: {
        group: {
          codexWeekly: { usedPercent: 12, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 2, now, true);
    context.__model = model;
    const row = vm.runInContext("buildCoinRow(__model, __now)", context);
    const readout = row.children[0];
    const source = readout.children.find((child) => child.className === "source");

    assert.ok(source);
    assert.strictEqual(source.textContent, "remote-build-host");
    assert.strictEqual(model.host, "remote-build-host");
  });

  it("changes its fingerprint when a non-binding window resets or stale age advances", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    context.__accountQuota = [{
      claudeQuota: {
        group: {
          claudeFiveHour: { usedPercent: 20, resetAt: now + 1_000, windowMinutes: 300 },
          claudeWeekly: { usedPercent: 80, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }];
    vm.runInContext("payload.accountQuota = __accountQuota", context);
    const beforeReset = vm.runInContext("fingerprint(1000000)", context);
    const afterReset = vm.runInContext("fingerprint(1002000)", context);
    assert.notStrictEqual(beforeReset, afterReset);

    context.__accountQuota = [{
      codexQuota: {
        group: {
          codexWeekly: { usedPercent: 10, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: 1,
      },
    }];
    vm.runInContext("payload.accountQuota = __accountQuota", context);
    const staleMinuteA = vm.runInContext("fingerprint(1000000)", context);
    const staleMinuteB = vm.runInContext("fingerprint(1060000)", context);
    assert.notStrictEqual(staleMinuteA, staleMinuteB);
  });

  it("never collects Dashboard-only Spark quota into an Orbit coin", () => {
    const context = loadRenderer();
    context.__accountQuota = [{
      codexSparkQuota: {
        group: {
          codexWeekly: { usedPercent: 7, resetAt: 2_000_000, windowMinutes: 10080 },
        },
        lastSeenAt: 1_000_000,
      },
    }];
    vm.runInContext("payload.accountQuota = __accountQuota", context);
    const coins = vm.runInContext("collectCoins(1000000)", context);
    assert.strictEqual(coins.length, 0);
  });

  it("paints a single-window provider's ring in its logical window hue", () => {
    // Codex reports only its weekly window. The ring is drawn at the outer
    // radius but must wear the inner/weekly hue — the same hue the Dashboard
    // gives its Weekly bar — so a color names one window on both surfaces.
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      codexQuota: {
        group: {
          codexWeekly: { usedPercent: 12, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 2, now);
    context.__model = model;
    const svg = vm.runInContext("buildCoinSvg(__model)", context);
    const tracks = svg.children.filter((child) =>
      typeof child.attributes.class === "string" && child.attributes.class.includes("track"));
    const fills = svg.children.filter((child) =>
      typeof child.attributes.class === "string" && child.attributes.class.includes("fill"));
    assert.strictEqual(tracks.length, 1);
    assert.match(tracks[0].attributes.class, /pv-codexQuota rg-inner/);
    assert.strictEqual(fills.length, 1);
    assert.match(fills[0].attributes.class, /pv-codexQuota rg-inner/);
  });

  it("neutralizes only the stale ring when a provider is partially refreshed", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      claudeQuota: {
        group: {
          claudeFiveHour: {
            usedPercent: 72,
            resetAt: now + 3_600_000,
            windowMinutes: 300,
            lastSeenAt: now - 6 * 60_000,
          },
          claudeWeekly: {
            usedPercent: 18,
            resetAt: now + 86_400_000,
            windowMinutes: 10080,
            lastSeenAt: now,
          },
        },
        lastSeenAt: now,
      },
    }, 1, now);
    assert.strictEqual(model.state, "live", "one fresh window keeps the provider live");
    context.__model = model;
    const svg = vm.runInContext("buildCoinSvg(__model)", context);
    const ring = (kind, slot) => svg.children.find((child) => {
      const cls = child.attributes.class || "";
      return cls.includes(kind) && cls.includes(`rg-${slot}`);
    });
    assert.match(ring("track", "outer").attributes.class, /\bis-stale\b/);
    assert.match(ring("fill", "outer").attributes.class, /\bis-stale\b/);
    assert.doesNotMatch(ring("track", "inner").attributes.class, /\bis-stale\b/);
    assert.doesNotMatch(ring("fill", "inner").attributes.class, /\bis-stale\b/);
    assert.match(rendererHtmlSource, /\.coin \.track\.is-stale\s*\{/);
    assert.match(rendererHtmlSource, /\.coin \.fill\.is-stale\s*\{/);
  });

  it("adds no footnote line for a stale coin, however old the reading is", () => {
    // A draft spelled the age out ("1h26m ago") so staleness would not ride on
    // row opacity alone. On a desktop that misfired: Codex goes stale 5 minutes
    // after its last reading, so the note stood on screen through every
    // ordinary gap between runs — permanent furniture, not a warning, costing a
    // third text line on a 26px row. Pin its absence so it cannot creep back
    // without someone re-deciding it. The affected ring is neutralized, and a
    // provider whose every window is stale also keeps the quiet row dim.
    const context = loadRenderer();
    const now = 1_000_000;
    for (const ageMinutes of [6, 86]) {
      const seenAt = now - ageMinutes * 60_000;
      const model = modelFor(context, {
        codexQuota: {
          group: {
            codexWeekly: {
              usedPercent: 12,
              resetAt: now + 3_600_000,
              windowMinutes: 10080,
              lastSeenAt: seenAt,
            },
          },
          lastSeenAt: seenAt,
        },
      }, 2, now);
      assert.strictEqual(model.state, "stale", `${ageMinutes}m should read as stale`);
      context.__model = model;
      context.__now = now;
      const row = vm.runInContext("buildCoinRow(__model, __now)", context);
      // Readout holds the percent and the window label, and nothing else: no
      // source marker is set on a local coin, so there is no third line at all.
      assert.strictEqual(
        row.children[0].children.length, 2,
        `a stale coin (${ageMinutes}m) grew a third readout line`
      );
      assert.match(row.className, /is-stale/, "the row dim is still the stale channel");
    }
  });

  it("labels the readout while remaining mode flips the percent's meaning", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      codexQuota: {
        group: {
          codexWeekly: {
            usedPercent: 12,
            resetAt: now + 3_600_000,
            windowMinutes: 10080,
            lastSeenAt: now,
          },
        },
        lastSeenAt: now,
      },
    }, 2, now);
    context.__model = model;
    context.__now = now;
    vm.runInContext('payload.displayMode = "remaining"', context);
    const row = vm.runInContext("buildCoinRow(__model, __now)", context);
    const foot = row.children[0].children[2];
    assert.ok(foot, "remaining mode shows the mode word on the footnote line");
    assert.strictEqual(foot.className, "source");
    assert.strictEqual(foot.textContent, "remaining");
  });
});

// The readout hands its headline to whichever window is in trouble, which
// leaves the rolling number invisible exactly when someone is most likely to
// ask "what did that last run cost me?". Rather than cycling the two forever,
// the rolling number is replayed at the moments it is actually being asked
// about: the cluster appearing after it moved, or moving while pinned.
describe("quota ring rolling-window flashback", () => {
  const NOW = 1_000_000;
  const FLASH_MS = 1600;

  it("does not flash on the very first snapshot", () => {
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(true);
    // 1% rolling under a 61% weekly: the alert already owns the headline, so a
    // naive "value differs from nothing" check would fire on arrival.
    flash.push(claudeSource(1, 61, NOW), NOW);
    assert.deepStrictEqual(flash.readout(NOW), { pct: "61%", win: "7d", flashing: false });
  });

  it("replays the rolling number when it moves while the cluster is visible", () => {
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(true);
    flash.push(claudeSource(1, 61, NOW), NOW);
    flash.push(claudeSource(4, 61, NOW), NOW + 10);

    assert.deepStrictEqual(flash.readout(NOW + 10), { pct: "4%", win: "5h", flashing: true });
    // ...and hands the headline back on its own.
    assert.deepStrictEqual(
      flash.readout(NOW + 10 + FLASH_MS + 1),
      { pct: "61%", win: "7d", flashing: false }
    );
  });

  it("banks the change while hidden and spends it when the cluster appears", () => {
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(false);
    flash.push(claudeSource(1, 61, NOW), NOW);
    flash.push(claudeSource(4, 61, NOW), NOW + 10);
    // Nothing plays to an empty screen.
    assert.strictEqual(flash.readout(NOW + 10).flashing, false);

    flash.setVisible(true);
    assert.strictEqual(flash.reveal(NOW + 5000), true);
    assert.deepStrictEqual(flash.readout(NOW + 5000), { pct: "4%", win: "5h", flashing: true });
  });

  it("spends a banked change only once", () => {
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(false);
    flash.push(claudeSource(1, 61, NOW), NOW);
    flash.push(claudeSource(4, 61, NOW), NOW + 10);
    flash.setVisible(true);
    flash.reveal(NOW + 5000);
    // A second appearance with nothing new since should be quiet.
    assert.strictEqual(flash.reveal(NOW + 5000 + FLASH_MS + 1), false);
  });

  it("stays quiet when the alert never took the headline", () => {
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(true);
    // Weekly below the warning threshold: the readout is already the rolling
    // window, so there is nothing to flash back to.
    flash.push(claudeSource(1, 30, NOW), NOW);
    flash.push(claudeSource(4, 30, NOW), NOW + 10);
    assert.deepStrictEqual(flash.readout(NOW + 10), { pct: "4%", win: "5h", flashing: false });
  });

  it("treats a window reset as a change worth replaying", () => {
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(true);
    flash.push(claudeSource(70, 61, NOW), NOW);
    // 70% -> 1% is the rollover, and "the 5h window just came back" is exactly
    // the kind of thing worth surfacing.
    flash.push(claudeSource(1, 61, NOW), NOW + 10);
    assert.deepStrictEqual(flash.readout(NOW + 10), { pct: "1%", win: "5h", flashing: true });
  });

  it("does not restart a flash already running", () => {
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(true);
    flash.push(claudeSource(1, 61, NOW), NOW);
    flash.push(claudeSource(4, 61, NOW), NOW + 10);
    // Back-to-back runs must not pin the readout on the rolling number forever.
    flash.push(claudeSource(7, 61, NOW), NOW + 900);
    assert.strictEqual(flash.readout(NOW + 10 + FLASH_MS + 1).flashing, false);
  });
});

// Regressions found by review, each of which the suite above sailed past.
describe("quota ring flashback — identity and bookkeeping", () => {
  const NOW = 1_000_000;
  const FLASH_MS = 1600;

  const twoProfiles = (fiveA, fiveB, now) => [
    {
      // Two trusted remote profiles are explicitly allowed to share one display
      // host (state-account-quota keeps them separate by sourceKey), so keying
      // per-coin state on `host` fuses them into a single entry.
      sourceKey: "remote:profile-a",
      host: "shared.example",
      claudeQuota: {
        lastSeenAt: now,
        group: {
          claudeFiveHour: { usedPercent: fiveA, resetAt: now + 3_600_000, windowMinutes: 300, lastSeenAt: now },
          claudeWeekly: { usedPercent: 61, resetAt: now + 3_600_000, windowMinutes: 10080, lastSeenAt: now },
        },
      },
    },
    {
      sourceKey: "remote:profile-b",
      host: "shared.example",
      claudeQuota: {
        lastSeenAt: now,
        group: {
          claudeFiveHour: { usedPercent: fiveB, resetAt: now + 3_600_000, windowMinutes: 300, lastSeenAt: now },
          claudeWeekly: { usedPercent: 61, resetAt: now + 3_600_000, windowMinutes: 10080, lastSeenAt: now },
        },
      },
    },
  ];

  it("keeps per-source state apart when two sources share a display host", () => {
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(true);
    flash.push(twoProfiles(1, 10, NOW), NOW);
    // Identical follow-up: nothing moved, so nothing may flash. Sharing one
    // entry would make the two coins overwrite each other's lastPct and
    // manufacture a change on every single snapshot.
    flash.push(twoProfiles(1, 10, NOW), NOW + 10);
    const flags = vm.runInContext(
      "collectCoins(__now).map((m) => isFlashing(m, __now))",
      Object.assign(context, { __now: NOW + 10 })
    );
    assert.deepStrictEqual([...flags], [false, false]);
  });

  it("replays a change that happened while hidden and healthy, before any alert existed", () => {
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(false);
    // Hidden, weekly still healthy: no alert holds the headline yet.
    flash.push(claudeSource(1, 30, NOW), NOW);
    flash.push(claudeSource(4, 30, NOW), NOW + 10);
    // Only now does the weekly window cross the threshold. The rolling number
    // moved unseen; recording it must not have depended on an alert being up
    // at that instant.
    flash.push(claudeSource(4, 61, NOW), NOW + 20);
    flash.setVisible(true);
    assert.strictEqual(flash.reveal(NOW + 5000), true);
    assert.deepStrictEqual(flash.readout(NOW + 5000), { pct: "4%", win: "5h", flashing: true });
  });

  it("drops the debt when the rolling number is already on screen at reveal", () => {
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(false);
    flash.push(claudeSource(1, 61, NOW), NOW);
    flash.push(claudeSource(4, 61, NOW), NOW + 10);
    // The alert clears before anyone looks, so the readout is the rolling
    // number again and the reader sees the new value directly.
    flash.push(claudeSource(4, 30, NOW), NOW + 20);
    flash.setVisible(true);
    assert.strictEqual(flash.reveal(NOW + 5000), false);
    // The debt has to be settled at that reveal, not merely left unplayed:
    // hide again, let a new alert take the headline without the rolling number
    // moving, and a stale debt would surface as a replay of something the
    // reader already spent time looking at.
    flash.setVisible(false);
    flash.push(claudeSource(4, 61, NOW), NOW + 6000);
    flash.setVisible(true);
    assert.strictEqual(flash.reveal(NOW + 7000), false);
    assert.deepStrictEqual(flash.readout(NOW + 7000), { pct: "61%", win: "7d", flashing: false });
  });

  it("hands over at exactly the warning threshold", () => {
    // 59 and 61 both pass whether the comparison is >= or >; 60 is the value
    // that pins it.
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(true);
    flash.push(claudeSource(1, 60, NOW), NOW);
    assert.deepStrictEqual(flash.readout(NOW), { pct: "60%", win: "7d", flashing: false });
  });

  it("ends each coin's flash on time when another starts later", () => {
    const context = loadRenderer();
    const flash = flashHarness(context);
    flash.setVisible(true);
    flash.push(twoProfiles(1, 1, NOW), NOW);
    flash.push(twoProfiles(4, 1, NOW), NOW + 10);      // coin A flashes
    flash.push(twoProfiles(4, 7, NOW), NOW + 900);     // coin B flashes later
    const at = NOW + 10 + FLASH_MS + 1;
    const flags = vm.runInContext(
      "collectCoins(__now).map((m) => isFlashing(m, __now))",
      Object.assign(context, { __now: at })
    );
    // A is done on its own schedule; B is still mid-flash.
    assert.deepStrictEqual([...flags], [false, true]);
  });
});
