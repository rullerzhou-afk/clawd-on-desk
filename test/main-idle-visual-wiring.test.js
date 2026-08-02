const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const MAIN_JS = path.join(__dirname, "..", "src", "main.js");

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notStrictEqual(start, -1, `missing section start: ${startMarker}`);
  assert.notStrictEqual(end, -1, `missing section end: ${endMarker}`);
  return source.slice(start, end);
}

describe("main default idle visual wiring", () => {
  const mainSource = fs.readFileSync(MAIN_JS, "utf8");

  it("resolves the choice against the live theme and wires both named runtime ctxs", () => {
    assert.ok(mainSource.includes('require("./idle-visual")'));
    assert.match(
      mainSource,
      /function getIdleVisualChoice\(\) \{\s*return resolveIdleVisualChoice\(getActiveTheme\(\), _settingsController\.get\("idleVisual"\)\);/
    );
    const stateCtx = sectionBetween(mainSource, "const _stateCtx = {", 'const _state = require("./state")');
    const tickCtx = sectionBetween(mainSource, "const _tickCtx = {", 'const _tick = require("./tick")');
    assert.ok(stateCtx.includes("  getIdleVisualChoice,"), "state ctx should expose the live choice");
    assert.ok(tickCtx.includes("  getIdleVisualChoice,"), "tick ctx should expose the live choice");
  });

  it("stamps pre-IPC visual choices on both renderer theme-config delivery paths", () => {
    const rendererConfig = sectionBetween(
      mainSource,
      "function buildRendererThemeConfig()",
      "const _stateCtx = {"
    );
    assert.ok(rendererConfig.includes("cfg.idleDefaultVisual = getIdleVisualChoice();"));
    assert.match(
      mainSource,
      /cfg\.petTintPayload = resolvePetTintPayload\(tintId, activeTheme\);/
    );
    assert.match(
      mainSource,
      /cfg\.accessoryPayload = resolvePetAccessoryPayload\(accessoryId, activeTheme\);/
    );
    assert.ok(mainSource.includes(
      'sendToRenderer("pet-accessory-change", resolvePetAccessoryPayload(accessoryId, activeTheme));'
    ));
    assert.ok(
      mainSource.includes("themeConfig: buildRendererThemeConfig(),"),
      "createRenderWindow should carry the stamped config"
    );
    assert.ok(
      mainSource.includes('sendToRenderer("theme-config", buildRendererThemeConfig());'),
      "did-finish-load re-send should carry the stamped config"
    );
    assert.ok(
      !mainSource.includes("themeConfig: themeRuntime.getRendererConfig()"),
      "an un-stamped renderer config must not reach the render window"
    );
    assert.ok(mainSource.includes("getEffectivePetAccessoryIdForTheme({"));
    assert.ok(mainSource.includes('_settingsController.get("holidayAccessoryEnabled")'));
  });

  it("starts and disposes the holiday accessory runtime with the app lifecycle", () => {
    assert.ok(mainSource.includes("const holidayAccessoryRuntime = createHolidayAccessoryRuntime({"));
    assert.ok(mainSource.includes("holidayAccessoryRuntime.start();"));
    assert.ok(mainSource.includes("holidayAccessoryRuntime.dispose();"));
  });

  it("re-rests the pet through the effect-router hook only while idle", () => {
    const hookIndex = mainSource.indexOf("refreshIdleVisual: () => {");
    assert.ok(hookIndex !== -1, "main should wire the refreshIdleVisual router option");
    const hook = mainSource.slice(hookIndex, mainSource.indexOf("},", hookIndex));
    assert.ok(hook.includes('if (_state.getCurrentState() !== "idle") return;'));
    assert.ok(hook.includes('_state.applyState("idle", _state.getSvgOverride("idle"))'));
  });

  it("gives the settings controller the active-theme dep that setIdleVisual validates against", () => {
    assert.ok(mainSource.includes("getActiveTheme: () => themeRuntime.getActiveTheme(),"));
  });
});
