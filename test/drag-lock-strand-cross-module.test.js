"use strict";

// Cross-module regression for #997 / PR #998: the dropped-mouse-up strand.
//
// This wires the REAL pieces together — the actual hit-renderer.js in a VM,
// the real registerPetInteractionIpc, and a real dragLocked cell with the
// same release semantics as pet-window-runtime — so the assertions cover both
// sides of the handshake instead of each module in isolation. The failure the
// review highlighted is exactly the gap between the two: the renderer believes
// it is still dragging while main believes the drag lock is live, and neither
// side alone can tell.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HIT_RENDERER = path.join(__dirname, "..", "src", "hit-renderer.js");
const SOURCE = fs.readFileSync(HIT_RENDERER, "utf8").replace(/\r\n/g, "\n");

const { registerPetInteractionIpc } = require("../src/pet-interaction-ipc");

class FakeArea {
  constructor() {
    this.style = {};
    this.classList = { add: () => {}, remove: () => {} };
    this.offsetWidth = 200;
    this.listeners = new Map();
  }
  addEventListener(event, cb) { this.listeners.set(event, cb); }
  setPointerCapture() {}
}

function createRenderer() {
  const apiCalls = [];
  const apiHandlers = {};
  const area = new FakeArea();
  const docListeners = new Map();
  const timers = [];
  let timerId = 0;
  const context = {
    document: {
      getElementById: (id) => (id === "hit-area" ? area : null),
      addEventListener: (event, cb) => { docListeners.set(event, cb); },
    },
    window: {
      hitPlatform: { isMac: false, platform: "win32" },
      hitThemeConfig: { reactions: {} },
      hitAPI: {
        onThemeConfig: () => {},
        dragLock: (v) => apiCalls.push(["dragLock", v]),
        dragMove: () => apiCalls.push(["dragMove"]),
        dragEnd: () => apiCalls.push(["dragEnd"]),
        showContextMenu: () => apiCalls.push(["showContextMenu"]),
        focusTerminal: () => {},
        exitMiniMode: () => {},
        showDashboard: () => {},
        revealSessionHud: () => {},
        startDragReaction: () => {},
        endDragReaction: () => apiCalls.push(["endDragReaction"]),
        playClickReaction: () => {},
        getPathForFile: () => "",
        dropPaths: () => {},
        onDropAccepted: () => {},
        onStateSync: (cb) => { apiHandlers.stateSync = cb; },
        onCancelReaction: (cb) => { apiHandlers.cancelReaction = cb; },
        onForceDragRelease: (cb) => { apiHandlers.forceDragRelease = cb; },
      },
      addEventListener: () => {},
    },
    setTimeout: (cb, ms) => {
      const t = { id: ++timerId, cb, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    setInterval: (cb, ms) => {
      const t = { id: ++timerId, cb, ms, interval: true, cleared: false };
      timers.push(t);
      return t;
    },
    clearInterval: (t) => { if (t) t.cleared = true; },
    requestAnimationFrame: (cb) => context.setTimeout(cb, 16),
    cancelAnimationFrame: (t) => context.clearTimeout(t),
    console: { warn() {} },
  };
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context);
  apiHandlers.stateSync({ currentState: "idle", miniMode: false, dndEnabled: false });

  return {
    apiCalls,
    apiHandlers,
    pointerdown: (clientX = 100, clientY = 100) => {
      area.listeners.get("pointerdown")({ button: 0, pointerId: 1, clientX, clientY });
    },
    pointermove: (clientX, clientY, buttons) => {
      docListeners.get("pointermove")({ clientX, clientY, buttons });
    },
    pointerup: (clientX = 100) => {
      docListeners.get("pointerup")({ button: 0, ctrlKey: false, metaKey: false, clientX });
    },
    contextmenu: () => {
      docListeners.get("contextmenu")({ preventDefault() {} });
    },
    locks: () => apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
  };
}

class FakeIpcMain {
  constructor() { this.listeners = new Map(); }
  on(channel, listener) { this.listeners.set(channel, listener); }
  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }
  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "hit-web-contents" }, ...args);
  }
}

// Mirrors pet-window-runtime's releaseStrandedDragLock + main.js's
// onStrandedDragLockReleased hook: release the main-side lock, then push
// force-drag-release so the renderer unwinds its own gesture state.
function createMainSide() {
  const renderer = createRenderer();
  const ipcMain = new FakeIpcMain();
  const state = {
    dragLocked: false,
    idlePaused: false,
    mouseOverPet: false,
    pushed: 0,
    menuRequests: 0,
    dragLockedAtMenu: null,
  };

  registerPetInteractionIpc({
    ipcMain,
    showContextMenu: () => {
      state.menuRequests += 1;
      state.dragLockedAtMenu = state.dragLocked;
    },
    moveWindowForDrag: () => {},
    setIdlePaused: (v) => { state.idlePaused = !!v; },
    setLowPowerIdlePaused: () => {},
    isMiniTransitioning: () => false,
    getCurrentState: () => "idle",
    getCurrentSvg: () => "idle.svg",
    sendToRenderer: () => {},
    settleVisual: () => true,
    recoverVisiblePetAfterRendererLoad: () => {},
    setDragLocked: (v) => { state.dragLocked = !!v; },
    setMouseOverPet: (v) => { state.mouseOverPet = !!v; },
    cancelRoam: () => {},
    beginDragSnapshot: () => {},
    clearDragSnapshot: () => {},
    syncHitWin: () => {},
    syncDisplayedVisualGeometry: () => {},
    setAccessoryMirror: () => {},
    syncImeEditingPetDodge: () => {},
    isMiniMode: () => false,
    checkMiniModeSnap: () => {},
    hasPetWindow: () => true,
    getPetWindowBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    getCurrentPixelSize: () => ({ width: 100, height: 100 }),
    computeDragEndBounds: (b) => b,
    applyPetWindowBounds: () => {},
    flushRuntimeStateToPrefs: () => {},
    reassertWinTopmost: () => {},
    scheduleHwndRecovery: () => {},
    repositionFloatingBubbles: () => {},
    exitMiniMode: () => {},
    getFocusableLocalHudSessionIds: () => [],
    focusLog: () => {},
    showDashboard: () => {},
    focusSession: () => {},
    revealSessionHud: () => {},
    statPath: async () => ({}),
    openTerminalAt: async () => ({ ok: true }),
    dropLog: () => {},
    isMacPlatform: false,
  });

  // Bridge the renderer's outbound calls into the real IPC layer, exactly like
  // preload-hit.js does over ipcRenderer.send.
  const originalPush = renderer.apiCalls.push.bind(renderer.apiCalls);
  renderer.apiCalls.push = (...entries) => {
    for (const [name, arg] of entries) {
      if (name === "dragLock") ipcMain.send("drag-lock", arg);
      else if (name === "dragMove") ipcMain.send("drag-move");
      else if (name === "dragEnd") ipcMain.send("drag-end");
      else if (name === "showContextMenu") ipcMain.send("show-context-menu");
    }
    return originalPush(...entries);
  };

  return {
    renderer,
    state,
    /** The release path shared by every recovery entry. */
    releaseStrandedDragLock: () => {
      if (!state.dragLocked) return false;
      state.dragLocked = false;
      state.idlePaused = false;
      state.mouseOverPet = false;
      state.pushed += 1;
      renderer.apiHandlers.forceDragRelease();
      return true;
    },
  };
}

describe("stranded drag release across renderer + main (#997 / #998)", () => {
  it("a normal drag ends cleanly on both sides", () => {
    const h = createMainSide();
    h.renderer.pointerdown(100, 100);
    assert.equal(h.state.dragLocked, true, "main locks on pointerdown");
    h.renderer.pointermove(120, 120, 1);
    h.renderer.pointerup(120);
    assert.equal(h.state.dragLocked, false, "main unlocks on pointerup");
    assert.deepStrictEqual(h.renderer.locks(), [true, false]);
  });

  it("lost pointerup + continued hover releases both sides on the first buttons=0 move", () => {
    const h = createMainSide();
    h.renderer.pointerdown(100, 100);
    h.renderer.pointermove(120, 120, 1);

    // The physical gesture ends here but every DOM end signal is swallowed.
    // Hover moves keep arriving with no button pressed.
    h.renderer.pointermove(140, 140, 0);

    assert.equal(h.state.dragLocked, false, "main must release the stranded lock");
    assert.deepStrictEqual(h.renderer.locks(), [true, false], "renderer must release too");
  });

  it("a genuine long press stays locked on both sides", () => {
    const h = createMainSide();
    h.renderer.pointerdown(100, 100);
    // Held still for a long time: no moves at all, so nothing looks like an end.
    h.renderer.pointermove(101, 100, 1);
    assert.equal(h.state.dragLocked, true, "a held drag must stay locked");
    assert.deepStrictEqual(h.renderer.locks(), [true]);
    h.renderer.pointerup(101);
    assert.equal(h.state.dragLocked, false);
  });

  it("a user-invoked recovery unwinds both sides, and the next drag starts clean", () => {
    const h = createMainSide();
    h.renderer.pointerdown(100, 100);
    h.renderer.pointermove(120, 120, 1);

    assert.equal(h.releaseStrandedDragLock(), true, "recovery releases the lock");
    assert.equal(h.state.dragLocked, false);
    assert.equal(h.state.pushed, 1, "the renderer is told to drop its capture");
    assert.deepStrictEqual(h.renderer.locks(), [true, false]);

    // A later real pointerup must not double-release, and the next gesture
    // locks normally again.
    h.renderer.pointerup(120);
    assert.deepStrictEqual(h.renderer.locks(), [true, false]);
    h.renderer.pointerdown(200, 200);
    assert.equal(h.state.dragLocked, true, "a fresh drag locks again");
    h.renderer.pointerup(200);
    assert.equal(h.state.dragLocked, false);
  });

  it("a recovery with no stranded lock is a no-op for the renderer", () => {
    const h = createMainSide();
    assert.equal(h.releaseStrandedDragLock(), false);
    assert.equal(h.state.pushed, 0, "no phantom force-drag-release push");
  });

  // #1260: the context menu's modal loop swallows the closing pointerup while
  // syncHitWin() defers on the held lock, and with the input window frozen at
  // its pre-drag rect no later pointer event may reach the renderer — the
  // buttons=0 self-heal never fires and the strand is permanent. The renderer
  // must unwind the drag BEFORE the menu request leaves, so main sees the
  // release first and the menu opens with no lock held.
  it("right-click during a drag ends the drag on both sides before the menu opens", () => {
    const h = createMainSide();
    h.renderer.pointerdown(100, 100);
    h.renderer.pointermove(120, 120, 1);
    assert.equal(h.state.dragLocked, true, "the drag holds the lock");

    h.renderer.contextmenu();

    assert.equal(h.state.menuRequests, 1, "the menu still opens");
    assert.equal(
      h.state.dragLockedAtMenu, false,
      "the menu request must arrive with the lock already released",
    );
    assert.equal(h.state.dragLocked, false);
    assert.deepStrictEqual(h.renderer.locks(), [true, false]);
    assert.equal(
      h.renderer.apiCalls.filter((c) => c[0] === "dragEnd").length, 1,
      "the moved drag closes exactly once",
    );

    // Whatever the menu loop swallows afterwards cannot re-strand the pair.
    h.renderer.pointermove(140, 140, 0);
    h.renderer.pointerup(140);
    assert.deepStrictEqual(h.renderer.locks(), [true, false]);
    assert.equal(h.state.menuRequests, 1);
  });
});
