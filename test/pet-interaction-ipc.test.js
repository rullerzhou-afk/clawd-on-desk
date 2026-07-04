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
    disableMiniMode: false,
    hasPetWindow: true,
    keepSizeAcrossDisplays: false,
    currentState: "idle",
    currentSvg: "idle.svg",
    petWindowBounds: { x: 10, y: 20, width: 120, height: 80 },
    currentPixelSize: { width: 90, height: 60 },
    effectivePixelSize: { width: 200, height: 200 },
    clampedBounds: { x: 12, y: 24, width: 90, height: 60 },
    focusableIds: [],
    statDirs: new Set(),
    statFiles: new Set(),
    openTerminalResult: { ok: true, terminal: "fake-term" },
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
    getEffectiveCurrentPixelSize: () =>
      state.keepSizeAcrossDisplays ? state.effectivePixelSize : state.currentPixelSize,
    computeDragEndBounds: (bounds, size) => {
      calls.push(["computeDragEndBounds", bounds, size]);
      return state.clampedBounds;
    },
    applyPetWindowBounds: (bounds) => calls.push(["applyPetWindowBounds", bounds]),
    flushRuntimeStateToPrefs: () => calls.push(["flushRuntimeStateToPrefs"]),
    reassertWinTopmost: () => calls.push(["reassertWinTopmost"]),
    scheduleHwndRecovery: () => calls.push(["scheduleHwndRecovery"]),
    repositionFloatingBubbles: () => calls.push(["repositionFloatingBubbles"]),
    exitMiniMode: () => calls.push(["exitMiniMode"]),
    getDisableMiniMode: () => state.disableMiniMode,
    getFocusableLocalHudSessionIds: () => state.focusableIds,
    focusLog: (message) => calls.push(["focusLog", message]),
    showDashboard: () => calls.push(["showDashboard"]),
    focusSession: (sessionId, options) => calls.push(["focusSession", sessionId, options]),
    setLowPowerIdlePaused: (value) => calls.push(["setLowPowerIdlePaused", value]),
    revealSessionHud: () => calls.push(["revealSessionHud"]),
    statPath: async (p) => {
      calls.push(["statPath", p]);
      if (state.statDirs.has(p)) return { isDirectory: () => true };
      if (state.statFiles.has(p)) return { isDirectory: () => false };
      throw new Error(`ENOENT: ${p}`);
    },
    openTerminalAt: async (dir) => {
      calls.push(["openTerminalAt", dir]);
      return state.openTerminalResult;
    },
    dropLog: (message) => calls.push(["dropLog", message]),
    // Default to the enabled platforms so the suite behaves the same on a
    // macOS dev machine; the macOS-disabled path has its own explicit test.
    isMacPlatform: overrides.isMacPlatform != null ? overrides.isMacPlatform : false,
  });
  return { ipcMain, runtime, calls, state };
}

function makeDropSender() {
  return { sent: [], send(channel) { this.sent.push(channel); } };
}

function sendDrop(ipcMain, paths, sender) {
  const listener = ipcMain.listeners.get("pet-drop-paths");
  assert.strictEqual(typeof listener, "function", "missing IPC listener pet-drop-paths");
  return listener({ sender }, paths);
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
    "pet-drop-paths",
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
    ["sendToRenderer", "start-drag-reaction", null],
    ["sendToRenderer", "end-drag-reaction"],
    ["sendToRenderer", "play-click-reaction", "click.svg", 900],
  ]);
});

test("pet interaction IPC relays only supported drag directions", () => {
  const { ipcMain, calls } = createHarness();

  ipcMain.send("start-drag-reaction", "left");
  ipcMain.send("start-drag-reaction", "right");
  ipcMain.send("start-drag-reaction", "up");

  assert.deepStrictEqual(calls, [
    ["sendToRenderer", "start-drag-reaction", "left"],
    ["sendToRenderer", "start-drag-reaction", "right"],
    ["sendToRenderer", "start-drag-reaction", null],
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
    ["flushRuntimeStateToPrefs"],
    ["reassertWinTopmost"],
    ["scheduleHwndRecovery"],
    ["syncHitWin"],
    ["repositionFloatingBubbles"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
    ["checkMiniModeSnap"],
    ["computeDragEndBounds", state.petWindowBounds, state.effectivePixelSize],
    ["applyPetWindowBounds", state.clampedBounds],
    ["flushRuntimeStateToPrefs"],
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

test("pet interaction IPC does not persist when drag-end has no clamped bounds", () => {
  const { ipcMain, calls } = createHarness({
    state: { clampedBounds: null },
  });

  ipcMain.send("drag-end");

  assert.deepStrictEqual(calls, [
    ["checkMiniModeSnap"],
    ["computeDragEndBounds", { x: 10, y: 20, width: 120, height: 80 }, { width: 90, height: 60 }],
    ["reassertWinTopmost"],
    ["scheduleHwndRecovery"],
    ["syncHitWin"],
    ["repositionFloatingBubbles"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
  ]);
});

test("pet interaction IPC disables mini snap without skipping drag-end cleanup", () => {
  const { ipcMain, calls, state } = createHarness({
    state: { disableMiniMode: true },
  });

  ipcMain.send("drag-end");

  assert.deepStrictEqual(calls, [
    ["computeDragEndBounds", state.petWindowBounds, state.currentPixelSize],
    ["applyPetWindowBounds", state.clampedBounds],
    ["flushRuntimeStateToPrefs"],
    ["reassertWinTopmost"],
    ["scheduleHwndRecovery"],
    ["syncHitWin"],
    ["repositionFloatingBubbles"],
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

test("pet drop opens a terminal at a dropped directory and pings the hit window (#459)", async () => {
  const { ipcMain, calls, state } = createHarness();
  state.statDirs.add("/proj/dir");
  const sender = makeDropSender();

  await sendDrop(ipcMain, ["/proj/dir"], sender);

  assert.deepStrictEqual(
    calls.filter((c) => c[0] === "openTerminalAt"),
    [["openTerminalAt", "/proj/dir"]],
  );
  assert.deepStrictEqual(sender.sent, ["pet-drop-accepted"]);
});

test("pet drop resolves a dropped file to its parent directory", async () => {
  const { ipcMain, calls, state } = createHarness();
  state.statFiles.add("/proj/dir/file.txt");
  const sender = makeDropSender();

  await sendDrop(ipcMain, ["/proj/dir/file.txt"], sender);

  assert.deepStrictEqual(
    calls.filter((c) => c[0] === "openTerminalAt"),
    [["openTerminalAt", "/proj/dir"]],
  );
  assert.deepStrictEqual(sender.sent, ["pet-drop-accepted"]);
});

test("pet drop takes the first usable path only", async () => {
  const { ipcMain, calls, state } = createHarness();
  state.statDirs.add("/first");
  state.statDirs.add("/second");
  const sender = makeDropSender();

  await sendDrop(ipcMain, [null, "", "/first", "/second"], sender);

  assert.deepStrictEqual(
    calls.filter((c) => c[0] === "openTerminalAt"),
    [["openTerminalAt", "/first"]],
  );
});

test("pet drop is disabled on macOS: no stat, no terminal, no accept ping", async () => {
  const { ipcMain, calls, state } = createHarness({ isMacPlatform: true });
  state.statDirs.add("/proj/dir");
  const sender = makeDropSender();

  await sendDrop(ipcMain, ["/proj/dir"], sender);

  assert.deepStrictEqual(calls.filter((c) => c[0] === "statPath"), []);
  assert.deepStrictEqual(calls.filter((c) => c[0] === "openTerminalAt"), []);
  assert.deepStrictEqual(sender.sent, []);
  const logs = calls.filter((c) => c[0] === "dropLog").map((c) => c[1]);
  assert.ok(logs.some((m) => m.includes("disabled on macOS")), logs.join("; "));
});

test("pet drop is ignored in mini mode and during mini transitions", async () => {
  for (const stateOverride of [{ miniMode: true }, { miniTransitioning: true }]) {
    const { ipcMain, calls, state } = createHarness({ state: stateOverride });
    state.statDirs.add("/proj");
    const sender = makeDropSender();

    await sendDrop(ipcMain, ["/proj"], sender);

    assert.deepStrictEqual(calls.filter((c) => c[0] === "statPath"), []);
    assert.deepStrictEqual(calls.filter((c) => c[0] === "openTerminalAt"), []);
    assert.deepStrictEqual(sender.sent, []);
  }
});

test("pet drop ignores invalid payloads and failed stats without launching", async () => {
  const { ipcMain, calls } = createHarness();
  const sender = makeDropSender();

  await sendDrop(ipcMain, "not-an-array", sender);
  await sendDrop(ipcMain, [], sender);
  await sendDrop(ipcMain, [123, "", null], sender);
  await sendDrop(ipcMain, ["/missing"], sender);

  assert.deepStrictEqual(calls.filter((c) => c[0] === "openTerminalAt"), []);
  assert.deepStrictEqual(sender.sent, []);
  const logs = calls.filter((c) => c[0] === "dropLog").map((c) => c[1]);
  assert.ok(logs.some((m) => m.includes("stat failed") && m.includes("/missing")), logs.join("; "));
});

test("pet drop does not ping the hit window when the terminal launch fails", async () => {
  const { ipcMain, calls, state } = createHarness({
    state: { openTerminalResult: { ok: false, message: "no terminal" } },
  });
  state.statDirs.add("/proj");
  const sender = makeDropSender();

  await sendDrop(ipcMain, ["/proj"], sender);

  assert.deepStrictEqual(
    calls.filter((c) => c[0] === "openTerminalAt"),
    [["openTerminalAt", "/proj"]],
  );
  assert.deepStrictEqual(sender.sent, []);
  const logs = calls.filter((c) => c[0] === "dropLog").map((c) => c[1]);
  assert.ok(logs.some((m) => m.includes("launch failed") && m.includes("no terminal")), logs.join("; "));
});
