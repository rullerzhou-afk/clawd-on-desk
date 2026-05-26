"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { registerPetInteractionIpc } = require("../src/pet-interaction-ipc");

class FakeIpcMain {
  constructor() {
    this.listeners = new Map();
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }

  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }
}

function createHarness(overrides = {}) {
  const calls = [];
  const state = {
    miniMode: false,
    miniTransitioning: false,
    hasPetWindow: true,
    keepSizeAcrossDisplays: false,
    currentState: "idle",
    currentSvg: "idle.svg",
    petWindowBounds: { x: 10, y: 20, width: 120, height: 80 },
    currentPixelSize: { width: 90, height: 60 },
    clampedBounds: { x: 12, y: 24, width: 90, height: 60 },
    focusableIds: [],
    ...overrides.state,
  };
  const ipcMain = new FakeIpcMain();
  const runtime = registerPetInteractionIpc({
    ipcMain,
    showContextMenu: (event) => calls.push(["showContextMenu", event.sender]),
    moveWindowForDrag: () => calls.push(["moveWindowForDrag"]),
    setIdlePaused: (value) => calls.push(["setIdlePaused", value]),
    isMiniTransitioning: () => state.miniTransitioning,
    getCurrentState: () => state.currentState,
    getCurrentSvg: () => state.currentSvg,
    sendToRenderer: (...args) => calls.push(["sendToRenderer", ...args]),
    setDragLocked: (value) => calls.push(["setDragLocked", value]),
    setMouseOverPet: (value) => calls.push(["setMouseOverPet", value]),
    beginDragSnapshot: () => calls.push(["beginDragSnapshot"]),
    clearDragSnapshot: () => calls.push(["clearDragSnapshot"]),
    syncHitWin: () => calls.push(["syncHitWin"]),
    isMiniMode: () => state.miniMode,
    checkMiniModeSnap: overrides.checkMiniModeSnap
      ? () => overrides.checkMiniModeSnap({ calls, state })
      : (() => calls.push(["checkMiniModeSnap"])),
    hasPetWindow: () => state.hasPetWindow,
    getPetWindowBounds: () => state.petWindowBounds,
    getKeepSizeAcrossDisplays: () => state.keepSizeAcrossDisplays,
    getCurrentPixelSize: () => state.currentPixelSize,
    computeDragEndBounds: (bounds, size) => {
      calls.push(["computeDragEndBounds", bounds, size]);
      return state.clampedBounds;
    },
    applyPetWindowBounds: (bounds) => calls.push(["applyPetWindowBounds", bounds]),
    reassertWinTopmost: () => calls.push(["reassertWinTopmost"]),
    scheduleHwndRecovery: () => calls.push(["scheduleHwndRecovery"]),
    repositionFloatingBubbles: () => calls.push(["repositionFloatingBubbles"]),
    exitMiniMode: () => calls.push(["exitMiniMode"]),
    getFocusableLocalHudSessionIds: () => state.focusableIds,
    focusLog: (message) => calls.push(["focusLog", message]),
    showDashboard: () => calls.push(["showDashboard"]),
    focusSession: (sessionId, options) => calls.push(["focusSession", sessionId, options]),
    setLowPowerIdlePaused: (value) => calls.push(["setLowPowerIdlePaused", value]),
    revealSessionHud: () => calls.push(["revealSessionHud"]),
  });
  return { ipcMain, runtime, calls, state };
}

test("pet interaction IPC registers owned channels and disposes them", () => {
  const { ipcMain, runtime } = createHarness();

  assert.deepStrictEqual([...ipcMain.listeners.keys()].sort(), [
    "drag-end",
    "drag-lock",
    "drag-move",
    "end-drag-reaction",
    "exit-mini-mode",
    "focus-terminal",
    "low-power-idle-paused",
    "pause-cursor-polling",
    "pet-interaction:reveal-session-hud",
    "play-click-reaction",
    "resume-from-reaction",
    "show-context-menu",
    "start-drag-reaction",
  ]);

  runtime.dispose();

  assert.strictEqual(ipcMain.listeners.size, 0);
});

test("pet interaction IPC delegates pet-interaction:reveal-session-hud to revealSessionHud", () => {
  const { ipcMain, calls } = createHarness();
  ipcMain.send("pet-interaction:reveal-session-hud");
  assert.deepStrictEqual(calls.filter((c) => c[0] === "revealSessionHud"), [
    ["revealSessionHud"],
  ]);
});

test("pet interaction IPC delegates menu, drag move, reaction pause, and renderer relays", () => {
  const { ipcMain, calls, state } = createHarness();

  ipcMain.send("show-context-menu");
  ipcMain.send("drag-move");
  ipcMain.send("pause-cursor-polling");
  ipcMain.send("resume-from-reaction");
  ipcMain.send("low-power-idle-paused", true);
  ipcMain.send("low-power-idle-paused", false);
  state.miniTransitioning = true;
  ipcMain.send("resume-from-reaction");
  ipcMain.send("start-drag-reaction");
  ipcMain.send("end-drag-reaction");
  ipcMain.send("play-click-reaction", "click.svg", 900);

  assert.deepStrictEqual(calls, [
    ["showContextMenu", "sender-web-contents"],
    ["moveWindowForDrag"],
    ["setIdlePaused", true],
    ["setIdlePaused", false],
    ["sendToRenderer", "state-change", "idle", "idle.svg"],
    ["setLowPowerIdlePaused", true],
    ["setLowPowerIdlePaused", false],
    ["setIdlePaused", false],
    ["sendToRenderer", "start-drag-reaction"],
    ["sendToRenderer", "end-drag-reaction"],
    ["sendToRenderer", "play-click-reaction", "click.svg", 900],
  ]);
});

test("pet interaction IPC preserves drag lock lifecycle", () => {
  const { ipcMain, calls } = createHarness();

  ipcMain.send("drag-lock", true);
  ipcMain.send("drag-lock", false);

  assert.deepStrictEqual(calls, [
    ["setDragLocked", true],
    ["setMouseOverPet", true],
    ["beginDragSnapshot"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
    ["syncHitWin"],
  ]);
});

test("pet interaction IPC finalizes drag end and always clears drag state", () => {
  const { ipcMain, calls, state } = createHarness();

  ipcMain.send("drag-end");
  state.keepSizeAcrossDisplays = true;
  ipcMain.send("drag-end");

  assert.deepStrictEqual(calls, [
    ["checkMiniModeSnap"],
    ["computeDragEndBounds", state.petWindowBounds, state.currentPixelSize],
    ["applyPetWindowBounds", state.clampedBounds],
    ["reassertWinTopmost"],
    ["scheduleHwndRecovery"],
    ["syncHitWin"],
    ["repositionFloatingBubbles"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
    ["checkMiniModeSnap"],
    ["computeDragEndBounds", state.petWindowBounds, { width: 120, height: 80 }],
    ["applyPetWindowBounds", state.clampedBounds],
    ["reassertWinTopmost"],
    ["scheduleHwndRecovery"],
    ["syncHitWin"],
    ["repositionFloatingBubbles"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
  ]);
});

test("pet interaction IPC skips drag-end clamp when mini snap starts", () => {
  const { ipcMain, calls } = createHarness({
    checkMiniModeSnap: ({ calls, state }) => {
      calls.push(["checkMiniModeSnap"]);
      state.miniMode = true;
    },
  });

  ipcMain.send("drag-end");

  assert.deepStrictEqual(calls, [
    ["checkMiniModeSnap"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
  ]);
});

test("pet interaction IPC still clears drag state when drag end has no live pet window", () => {
  const { ipcMain, calls } = createHarness({
    state: { hasPetWindow: false },
  });

  ipcMain.send("drag-end");

  assert.deepStrictEqual(calls, [
    ["checkMiniModeSnap"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
  ]);
});

test("pet interaction IPC gates exit-mini-mode on current mini state", () => {
  const { ipcMain, calls, state } = createHarness();

  ipcMain.send("exit-mini-mode");
  state.miniMode = true;
  ipcMain.send("exit-mini-mode");

  assert.deepStrictEqual(calls, [
    ["exitMiniMode"],
  ]);
});

test("pet interaction IPC preserves pet-body focus behavior", () => {
  const { ipcMain, calls, state } = createHarness();

  ipcMain.send("focus-terminal");
  state.focusableIds = ["single"];
  ipcMain.send("focus-terminal");
  state.focusableIds = ["one", "two"];
  ipcMain.send("focus-terminal");

  assert.deepStrictEqual(calls, [
    ["focusLog", "focus request source=pet-body sid=- focusableCount=0"],
    ["focusLog", "focus result branch=none reason=no-focusable-session source=pet-body"],
    ["focusLog", "focus request source=pet-body sid=- focusableCount=1"],
    ["focusSession", "single", { requestSource: "pet-body" }],
    ["focusLog", "focus request source=pet-body sid=- focusableCount=2"],
    ["focusLog", "focus result branch=none reason=multi-session-open-dashboard count=2"],
    ["showDashboard"],
  ]);
});
