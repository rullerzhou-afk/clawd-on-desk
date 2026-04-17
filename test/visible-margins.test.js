const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const themeLoader = require("../src/theme-loader");
const hitGeometry = require("../src/hit-geometry");
const {
  computeRectMargins,
  getThemeMarginBox,
  collectThemeEnvelopeFiles,
  computeStableVisibleContentMargins,
} = require("../src/visible-margins");

themeLoader.init(path.join(__dirname, "..", "src"));

describe("visible margin envelopes", () => {
  const bounds = { x: 0, y: 0, width: 280, height: 280 };

  it("prefers layout.marginBox over contentBox when present", () => {
    const clawd = themeLoader.loadTheme("clawd");
    assert.deepStrictEqual(getThemeMarginBox(clawd), clawd.layout.marginBox);

    const idleFile = clawd.states.idle[0];
    const contentRect = hitGeometry.getContentRectScreen(clawd, bounds, "idle", idleFile, {
      box: clawd.layout.contentBox,
    });
    const marginRect = hitGeometry.getContentRectScreen(clawd, bounds, "idle", idleFile, {
      box: clawd.layout.marginBox,
    });

    assert.ok(marginRect.top < contentRect.top);
    assert.strictEqual(
      Math.round(bounds.y + bounds.height - marginRect.bottom),
      Math.round(bounds.y + bounds.height - contentRect.bottom)
    );
  });

  it("collects a non-mini envelope file set", () => {
    const clawd = themeLoader.loadTheme("clawd");
    const files = collectThemeEnvelopeFiles(clawd);

    assert.ok(files.includes("clawd-working-typing.svg"));
    assert.ok(files.includes("clawd-react-drag.svg"));
    assert.ok(!files.includes("clawd-mini-idle.svg"));
    assert.ok(!files.some((file) => file.startsWith("mini-")));
  });

  it("uses the minimum top and bottom margins across a theme envelope", () => {
    const calico = themeLoader.loadTheme("calico");
    const files = collectThemeEnvelopeFiles(calico);
    const expected = files.reduce((acc, file) => {
      const rect = hitGeometry.getContentRectScreen(calico, bounds, null, file, {
        box: calico.layout.contentBox,
      });
      if (!rect) return acc;
      return {
        top: Math.min(acc.top, Math.max(0, Math.round(rect.top - bounds.y))),
        bottom: Math.min(acc.bottom, Math.max(0, Math.round(bounds.y + bounds.height - rect.bottom))),
      };
    }, { top: Infinity, bottom: Infinity });

    const stable = computeStableVisibleContentMargins(calico, bounds);
    assert.deepStrictEqual(stable, expected);

    const idleRect = hitGeometry.getContentRectScreen(calico, bounds, "idle", calico.states.idle[0], {
      box: calico.layout.contentBox,
    });
    assert.ok(stable.top < Math.round(idleRect.top - bounds.y));
    assert.ok(stable.bottom <= Math.round(bounds.y + bounds.height - idleRect.bottom));
  });

  it("can derive margins from the current displayed drag-state hit rect", () => {
    const clawd = themeLoader.loadTheme("clawd");
    const dragRect = hitGeometry.getHitRectScreen(clawd, bounds, null, "clawd-react-drag.svg", clawd.hitBoxes.default);

    assert.deepStrictEqual(computeRectMargins(bounds, dragRect), {
      top: 169,
      bottom: 14,
    });
  });
});
