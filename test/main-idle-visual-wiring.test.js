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
    assert.ok(
      tickCtx.includes("getEffectiveAccessoryIds: getEffectivePetAccessoryIds"),
      "tick ctx should read canonical effective slots for conditional easter eggs"
    );
    assert.ok(
      mainSource.includes("getPetAccessorySlotsSnapshot(activeTheme)"),
      "conditional easter eggs should prefer the committed slot snapshot"
    );
  });

  it("stamps pre-IPC visual choices on both renderer theme-config delivery paths", () => {
    const rendererConfig = sectionBetween(
      mainSource,
      "function buildRendererThemeConfig(",
      "const _stateCtx = {"
    );
    assert.ok(rendererConfig.includes("cfg.idleDefaultVisual = getIdleVisualChoice();"));
    assert.match(
      mainSource,
      /cfg\.petTintPayload = resolvePetTintPayload\(tintId, activeTheme\);/
    );
    assert.ok(!rendererConfig.includes("buildPetAccessorySlotsCandidate("));
    assert.ok(rendererConfig.includes("const canonical = accessorySnapshot || getPetAccessorySlotsSnapshot(activeTheme);"));
    assert.ok(rendererConfig.includes("cfg.accessorySlots = {"));
    assert.ok(rendererConfig.includes("payload: canonical.payloads.head,"));
    assert.ok(rendererConfig.includes("payload: canonical.payloads.mouth,"));
    assert.ok(mainSource.includes(
      'sendToRenderer("pet-accessory-slots-change", candidate)'
    ));
    assert.ok(
      mainSource.includes("themeConfig: buildRendererThemeConfig(initialAccessoryDelivery.snapshot),"),
      "createRenderWindow should carry the stamped config"
    );
    assert.ok(
      mainSource.includes("deliverRendererThemeConfig();"),
      "did-finish-load re-send should carry the stamped config"
    );
    assert.ok(mainSource.includes("finalizePetAccessorySlotsDelivery(initialAccessoryDelivery, true);"));
    assert.ok(mainSource.includes("finalizePetAccessorySlotsDelivery(delivery, delivered)"));
    assert.ok(
      !mainSource.includes("themeConfig: themeRuntime.getRendererConfig()"),
      "an un-stamped renderer config must not reach the render window"
    );
    assert.ok(mainSource.includes("getEffectivePetAccessoryIdForTheme({"));
    assert.ok(mainSource.includes("holidayAccessoryEnabled: snapshot.holidayAccessoryEnabled"));
  });

  it("starts and disposes the holiday accessory runtime with the app lifecycle", () => {
    assert.ok(mainSource.includes("const holidayAccessoryRuntime = createHolidayAccessoryRuntime({"));
    assert.ok(mainSource.includes("holidayAccessoryRuntime.start();"));
    assert.ok(mainSource.includes("holidayAccessoryRuntime.dispose();"));
  });

  it("wires hit-renderer mirror changes back into accessory geometry", () => {
    const registration = sectionBetween(
      mainSource,
      "registerPetInteractionIpc({",
      "registerPermissionIpc({"
    );
    assert.ok(registration.includes("setAccessoryMirror: setAccessoryMirrored,"));
    assert.ok(registration.includes("refreshIdleVisualAfterDrag,"));
  });

  it("accepts visual settlement only from the live renderer main frame", () => {
    const registration = sectionBetween(
      mainSource,
      "settleVisual: (event, payload) => {",
      "recoverVisiblePetAfterRendererLoad:"
    );
    assert.ok(registration.includes("isTrustedMainFrameEvent(event, win.webContents)"));
    assert.ok(registration.includes("displayedVisualProjection.settle(payload)"));
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

  it("updates the sync-IPC pet config before pushing it to the renderer", () => {
    const delivery = sectionBetween(
      mainSource,
      "function deliverRendererThemeConfig()",
      "const recapRuntime"
    );
    const setIndex = delivery.indexOf("rendererConfigChannel.setPetConfig(cfg);");
    const sendIndex = delivery.indexOf('sendToRenderer("theme-config", cfg);');

    assert.ok(setIndex >= 0, "the pet config must be cached for the next preload read");
    assert.ok(sendIndex >= 0, "the live renderer still needs the pushed config");
    assert.ok(setIndex < sendIndex, "cache the config before sending it");
  });

  it("updates the sync-IPC hit config before the hit window load push", () => {
    const onLoad = sectionBetween(
      mainSource,
      "onDidFinishLoad: () => {",
      "onRenderProcessGone: (details, ownedHitWin)"
    );
    const setIndex = onLoad.indexOf("rendererConfigChannel.setHitConfig(hitConfig);");
    const sendIndex = onLoad.indexOf('sendToHitWin("theme-config", hitConfig);');

    assert.ok(setIndex >= 0, "the hit config must be cached for reloads");
    assert.ok(sendIndex >= 0, "the live hit window still needs the pushed config");
    assert.ok(setIndex < sendIndex, "cache the hit config before sending it");
  });
});
