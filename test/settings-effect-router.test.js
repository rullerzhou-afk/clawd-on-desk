"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const createSettingsEffectRouter = require("../src/settings-effect-router");

function createFakeSettingsController(initialSnapshot = {}) {
  let snapshot = { shortcuts: {}, ...initialSnapshot };
  const subscribers = new Set();
  const keySubscribers = new Set();
  const controller = {
    getSnapshot: () => ({ ...snapshot }),
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    subscribeKey(key, fn) {
      const entry = { key, fn };
      keySubscribers.add(entry);
      return () => keySubscribers.delete(entry);
    },
  };

  function emit(changes) {
    snapshot = { ...snapshot, ...changes };
    const event = { changes, snapshot: { ...snapshot } };
    for (const fn of [...subscribers]) fn(event);
    for (const entry of [...keySubscribers]) {
      if (entry.key in changes) entry.fn(changes[entry.key], { ...snapshot });
    }
  }

  return { controller, emit };
}

function createHarness(options = {}) {
  const calls = [];
  const logs = [];
  const { controller, emit } = createFakeSettingsController(options.initialSnapshot);
  const router = createSettingsEffectRouter({
    settingsController: controller,
    BrowserWindow: options.BrowserWindow || { getAllWindows: () => [] },
    updateMirrors: (changes) => calls.push(["updateMirrors", { ...changes }]),
    createTray: () => calls.push(["createTray"]),
    destroyTray: () => calls.push(["destroyTray"]),
    applyDockVisibility: () => calls.push(["applyDockVisibility"]),
    sendToRenderer: (...args) => calls.push(["sendToRenderer", ...args]),
    sendDashboardI18n: () => calls.push(["sendDashboardI18n"]),
    sendSessionHudI18n: () => calls.push(["sendSessionHudI18n"]),
    emitSessionSnapshot: (...args) => calls.push(["emitSessionSnapshot", ...args]),
    cleanStaleSessions: () => calls.push(["cleanStaleSessions"]),
    syncPermissionShortcuts: () => calls.push(["syncPermissionShortcuts"]),
    dismissInteractivePermissionBubbles: () => calls.push(["dismissInteractivePermissionBubbles"]),
    clearCodexNotifyBubbles: (...args) => calls.push(["clearCodexNotifyBubbles", ...args]),
    clearKimiNotifyBubbles: (...args) => calls.push(["clearKimiNotifyBubbles", ...args]),
    refreshPassiveNotifyAutoClose: () => calls.push(["refreshPassiveNotifyAutoClose"]),
    hideUpdateBubbleForPolicy: () => calls.push(["hideUpdateBubbleForPolicy"]),
    refreshUpdateBubbleAutoClose: () => calls.push(["refreshUpdateBubbleAutoClose"]),
    repositionFloatingBubbles: () => calls.push(["repositionFloatingBubbles"]),
    syncSessionHudVisibility: () => calls.push(["syncSessionHudVisibility"]),
    reclampPetAfterEdgePinningChange: () => calls.push(["reclampPetAfterEdgePinningChange"]),
    rebuildAllMenus: () => calls.push(["rebuildAllMenus"]),
    logWarn: (...args) => logs.push(args),
    ...(options.routerOptions || {}),
  });
  router.start();
  return { calls, logs, emit, router };
}

function makeWindow(name, calls, options = {}) {
  return {
    isDestroyed: () => !!options.destroyed,
    webContents: options.noWebContents ? null : {
      isDestroyed: () => !!options.webContentsDestroyed,
      send: (...args) => calls.push(["windowSend", name, ...args]),
    },
  };
}

describe("settings-effect-router", () => {
  it("updates mirrors before tray and dock side effects", () => {
    const calls = [];
    const mirror = {};
    const { controller, emit } = createFakeSettingsController();
    const router = createSettingsEffectRouter({
      settingsController: controller,
      BrowserWindow: { getAllWindows: () => [] },
      updateMirrors: (changes) => {
        calls.push(["updateMirrors"]);
        Object.assign(mirror, changes);
      },
      createTray: () => calls.push(["createTray", mirror.showTray]),
      destroyTray: () => calls.push(["destroyTray", mirror.showTray]),
      applyDockVisibility: () => calls.push(["applyDockVisibility", mirror.showDock]),
      rebuildAllMenus: () => calls.push(["rebuildAllMenus"]),
      logWarn: () => {},
    });

    router.start();
    emit({ showTray: true, showDock: false });

    assert.deepStrictEqual(calls, [
      ["updateMirrors"],
      ["createTray", true],
      ["applyDockVisibility", false],
      ["rebuildAllMenus"],
    ]);
  });

  it("routes bubble policy changes to permission and update bubble effects", () => {
    const { calls, emit } = createHarness();

    emit({ hideBubbles: true });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { hideBubbles: true }],
      ["syncPermissionShortcuts"],
      ["dismissInteractivePermissionBubbles"],
      ["clearCodexNotifyBubbles", undefined, "settings-policy-disabled"],
      ["clearKimiNotifyBubbles", undefined, "settings-policy-disabled"],
      ["hideUpdateBubbleForPolicy"],
      ["rebuildAllMenus"],
    ]);

    calls.length = 0;
    emit({ notificationBubbleAutoCloseSeconds: 5 });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { notificationBubbleAutoCloseSeconds: 5 }],
      ["refreshPassiveNotifyAutoClose"],
      ["rebuildAllMenus"],
    ]);

    calls.length = 0;
    emit({ updateBubbleAutoCloseSeconds: 8 });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { updateBubbleAutoCloseSeconds: 8 }],
      ["refreshUpdateBubbleAutoClose"],
      ["rebuildAllMenus"],
    ]);
  });

  it("routes language, session alias, and session HUD effects", () => {
    const { calls, emit } = createHarness();

    emit({ lang: "zh", sessionAliases: { "local|claude|1": "work" } });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { lang: "zh", sessionAliases: { "local|claude|1": "work" } }],
      ["sendDashboardI18n"],
      ["sendSessionHudI18n"],
      ["emitSessionSnapshot", { force: true }],
      ["rebuildAllMenus"],
    ]);

    calls.length = 0;
    emit({ sessionHudEnabled: false });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { sessionHudEnabled: false }],
      ["syncSessionHudVisibility"],
      ["repositionFloatingBubbles"],
    ]);

    calls.length = 0;
    emit({ sessionHudShowStateLabels: false });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { sessionHudShowStateLabels: false }],
      ["syncSessionHudVisibility"],
      ["repositionFloatingBubbles"],
    ]);

    calls.length = 0;
    emit({ sessionHudCleanupDetached: true });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { sessionHudCleanupDetached: true }],
      ["cleanStaleSessions"],
      ["emitSessionSnapshot", { force: true }],
    ]);

    calls.length = 0;
    emit({ sessionHudCleanupDetached: false });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { sessionHudCleanupDetached: false }],
      ["emitSessionSnapshot", { force: true }],
    ]);

    calls.length = 0;
    emit({ sessionHudAutoHide: true });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { sessionHudAutoHide: true }],
      ["syncSessionHudVisibility"],
      ["repositionFloatingBubbles"],
    ]);

    calls.length = 0;
    emit({ sessionHudPinned: true });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { sessionHudPinned: true }],
      ["syncSessionHudVisibility"],
      ["repositionFloatingBubbles"],
    ]);
  });

  it("delegates edge pinning changes to one injected reclamp helper", () => {
    const { calls, emit } = createHarness();

    emit({ allowEdgePinning: false });

    assert.deepStrictEqual(calls, [
      ["updateMirrors", { allowEdgePinning: false }],
      ["reclampPetAfterEdgePinningChange"],
    ]);
  });

  it("rebuilds menus only once for menu-affecting keys", () => {
    const { calls, emit } = createHarness();

    emit({ soundVolume: 0.5 });
    assert.strictEqual(calls.some((call) => call[0] === "rebuildAllMenus"), false);

    calls.length = 0;
    emit({ theme: "calico", size: "M" });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { theme: "calico", size: "M" }],
      ["rebuildAllMenus"],
    ]);
  });

  it("broadcasts settings changes only to live renderer windows", () => {
    const calls = [];
    const windows = [
      makeWindow("live", calls),
      makeWindow("destroyed", calls, { destroyed: true }),
      makeWindow("web-destroyed", calls, { webContentsDestroyed: true }),
      makeWindow("no-webcontents", calls, { noWebContents: true }),
    ];
    const { emit } = createHarness({
      BrowserWindow: { getAllWindows: () => windows },
      routerOptions: {
        updateMirrors: () => {},
      },
    });

    emit({ soundVolume: 0.25 });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], "windowSend");
    assert.strictEqual(calls[0][1], "live");
    assert.strictEqual(calls[0][2], "settings-changed");
    assert.deepStrictEqual(calls[0][3].changes, { soundVolume: 0.25 });
    assert.strictEqual(calls[0][3].snapshot.soundVolume, 0.25);
  });

  it("rebuilds shortcut menus only when the toggle-pet shortcut changes", () => {
    const { calls, emit } = createHarness({
      initialSnapshot: { shortcuts: { togglePet: "Ctrl+A" } },
    });

    emit({ shortcuts: { togglePet: "Ctrl+A", openDashboard: "Ctrl+D" } });
    assert.strictEqual(calls.some((call) => call[0] === "rebuildAllMenus"), false);

    calls.length = 0;
    emit({ shortcuts: { togglePet: "Ctrl+B" } });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { shortcuts: { togglePet: "Ctrl+B" } }],
      ["rebuildAllMenus"],
    ]);

    calls.length = 0;
    emit({ shortcuts: { togglePet: "Ctrl+B", openSettings: "Ctrl+S" } });
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { shortcuts: { togglePet: "Ctrl+B", openSettings: "Ctrl+S" } }],
    ]);
  });

  it("logs side-effect failures and keeps later routes running", () => {
    const { calls, logs, emit } = createHarness({
      routerOptions: {
        createTray: () => {
          throw new Error("tray broke");
        },
      },
    });

    emit({ showTray: true });

    assert.deepStrictEqual(logs, [["Clawd: tray toggle failed:", "tray broke"]]);
    assert.deepStrictEqual(calls, [
      ["updateMirrors", { showTray: true }],
      ["rebuildAllMenus"],
    ]);
  });

  it("triggers a cleanup sweep + forced snapshot when any stale-cleanup config key changes", () => {
    for (const key of ["sessionStaleMs", "workingStaleMs", "detachedIdleStaleMs"]) {
      const { calls, emit } = createHarness();
      emit({ [key]: key === "detachedIdleStaleMs" ? 60_000 : 900_000 });
      assert.deepStrictEqual(calls, [
        ["updateMirrors", { [key]: key === "detachedIdleStaleMs" ? 60_000 : 900_000 }],
        ["cleanStaleSessions"],
        ["emitSessionSnapshot", { force: true }],
      ], `expected stale-cleanup branch to fire for ${key}`);
    }
  });

  it("dispose unsubscribes both settings routes", () => {
    const { calls, emit, router } = createHarness();

    router.dispose();
    emit({ theme: "calico", shortcuts: { togglePet: "Ctrl+Shift+P" } });

    assert.deepStrictEqual(calls, []);
  });
});
