const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const MAIN_JS = path.join(__dirname, "..", "src", "main.js");

describe("main theme transition wiring", () => {
  it("fades the render window out before theme reload and back in after load", () => {
    const source = fs.readFileSync(MAIN_JS, "utf8");

    assert.ok(
      source.includes('require("./window-opacity-transition")'),
      "main should use the shared BrowserWindow opacity transition helper"
    );
    assert.match(source, /THEME_SWITCH_FADE_OUT_MS\s*=\s*140/);
    assert.match(source, /THEME_SWITCH_FADE_IN_MS\s*=\s*180/);

    const activateIndex = source.indexOf("function activateTheme(");
    const fadeOutIndex = source.indexOf("animateThemeWindowOpacity(transitionSeq, 0", activateIndex);
    const reloadHelperIndex = source.indexOf("function reloadThemeWindowsAfterFade(");
    const reloadCallIndex = source.indexOf("reloadThemeWindowsAfterFade(", fadeOutIndex);
    const syncIndex = source.indexOf("syncRendererStateAfterLoad({ includeStartupRecovery: false })", activateIndex);
    const fadeInHelperIndex = source.indexOf("function fadeInThemeWindow(");
    const fadeInCallIndex = source.indexOf("fadeInThemeWindow(transitionSeq)", syncIndex);
    const finishIndex = source.indexOf("const finishThemeReload = ", activateIndex);

    assert.ok(fadeOutIndex > activateIndex, "activateTheme should start by fading out the current render window");
    assert.ok(reloadHelperIndex > 0, "theme reload should be wrapped so it can run after fade-out");
    assert.ok(source.indexOf("renderContents.reload()", reloadHelperIndex) > reloadHelperIndex);
    assert.ok(reloadCallIndex > fadeOutIndex, "theme reload should happen after the fade-out path");
    assert.ok(source.indexOf("animateThemeWindowOpacity(seq, 1", fadeInHelperIndex) > fadeInHelperIndex);
    assert.ok(fadeInCallIndex > syncIndex, "new theme should fade in only after renderer state has been synced");
    assert.ok(finishIndex > activateIndex, "theme reload should have one guarded finish path");
    assert.ok(
      source.includes("THEME_SWITCH_FADE_FALLBACK_MS"),
      "theme transition should have an opacity fallback so the window cannot stay transparent"
    );
    assert.match(source, /scheduleThemeSwitchFadeFallback\(seq,\s*onFallback\)/);
    assert.match(source, /const finishThemeReload = \(\) =>/);
    assert.ok(
      source.includes("cancelThemeSwitchOpacityAnimation()"),
      "starting a newer theme switch should cancel stale opacity timers"
    );
  });
});
