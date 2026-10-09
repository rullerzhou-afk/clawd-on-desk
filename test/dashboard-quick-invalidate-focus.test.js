"use strict";

// WIN-R1: a page-level invalidation must not leave the hidden quick host in
// front of everything.
//
// Reload / failed load / crashed page end the round while this owner may still
// hold the foreground it borrowed. Windows leaves a hidden tool window as
// GetForegroundWindow() after such a hide, which was measured on the candidate:
// after Ctrl+R the hidden quick HWND stayed both foreground and GUI focus root,
// the visible Dashboard reported document.hasFocus()=false and the source
// window received no further keys.
//
// Invalidating the round is therefore not the same thing as giving the keyboard
// back, and the return is deliberately narrow: only while this owner still owns
// the foreground, only when nothing was handed to a jump target, and never for
// a dismissal the user themselves caused somewhere else.

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createDashboardQuickMode } = require("../src/dashboard-quick-mode");

class FakeWindow {
  constructor(name) {
    this.name = name;
    this.destroyed = false;
    this.visible = false;
    this.focused = false;
    this.minimized = false;
    this.opacity = 1;
    this.opacityCalls = [];
    this.ignoreMouseCalls = [];
    this.shownCount = 0;
    this.hiddenCount = 0;
    this.focusCount = 0;
    this.restoreCount = 0;
    this.destroyCount = 0;
    this.contentView = { children: [] };
    this.handlers = new Map();
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  isMinimized() { return this.minimized; }
  show() { this.visible = true; this.shownCount += 1; }
  hide() { this.visible = false; this.hiddenCount += 1; }
  restore() { this.minimized = false; this.restoreCount += 1; }
  focus() { this.focused = true; this.focusCount += 1; }
  destroy() { this.destroyed = true; this.destroyCount += 1; this.emit("closed"); }
  getOpacity() { return this.opacity; }
  setOpacity(value) { this.opacity = value; this.opacityCalls.push(value); }
  setIgnoreMouseEvents(value) { this.ignoreMouseCalls.push(value); }
  setBounds() {}
  setMenuBarVisibility() {}
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, ...args) {
    const handler = this.handlers.get(event);
    if (handler) handler(...args);
  }
}

// Mirrors quick-select-origin-focus.js: `restore` only acts while this owner is
// still the foreground window, and only for a source that is still usable.
function fakeOriginFocus(options = {}) {
  const calls = { capture: 0, restore: [], holdsForeground: 0 };
  return {
    calls,
    capture() { calls.capture += 1; return options.origin === undefined ? "origin-hwnd" : options.origin; },
    restore(origin) {
      calls.restore.push(origin);
      if (options.holdsForeground === false) return false;
      return options.sourceUsable !== false && origin != null;
    },
    holdsForeground() {
      calls.holdsForeground += 1;
      return options.holdsForeground !== false;
    },
  };
}

function harness(options = {}) {
  const normal = new FakeWindow("normal");
  normal.visible = options.normalVisible !== false;
  normal.focused = options.normalFocused === true;

  const created = [];
  const sent = [];
  const attachments = [];
  const focusPageCalls = [];
  const originFocus = options.originFocus || fakeOriginFocus(options);
  const focusNormal = normal.focus.bind(normal);
  normal.focus = () => {
    focusNormal();
    options.holdsForeground = false; // ordinary fallback really took the native foreground
  };
  let pageAlive = options.pageAlive !== false;

  const webContents = {
    isDestroyed: () => !pageAlive,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const view = { webContents };
  normal.contentView.children.push(view);

  const quick = createDashboardQuickMode({
    platform: options.platform || "win32",
    electron: {
      BaseWindow: class {
        constructor(opts) {
          const win = new FakeWindow("quick");
          win.opts = opts;
          created.push(win);
          return win;
        }
      },
    },
    t: (key) => key,
    originFocus,
    getBackgroundColor: () => "#000000",
    getSessionSnapshot: () => ({
      sessions: [{ id: "s1", canFocus: true, displayTitle: "S1", agentName: "Codex", badge: "idle" }],
      groups: [{ host: "local", ids: ["s1"] }],
    }),
    focusSession: () => ({ reason: "submitted" }),
    getNormalWindow: () => normal,
    getWebContents: () => (pageAlive ? webContents : null),
    isPageDestroyed: () => !pageAlive,
    ensurePage: () => ({}),
    getQuickHostBounds: () => ({ x: 10, y: 20, width: 480, height: 600 }),
    attachViewTo: (win) => {
      attachments.push(win === normal ? "normal" : "quick");
      if (!pageAlive) return false;
      for (const host of [normal, ...created]) {
        host.contentView.children = host.contentView.children.filter(child => child !== view);
      }
      win.contentView.children.push(view);
      return true;
    },
    syncViewBounds: () => {},
    applyPageScale: () => {},
    focusPage: () => focusPageCalls.push("page"),
  });

  return {
    quick,
    normal,
    sent,
    attachments,
    focusPageCalls,
    originFocus,
    killPage: () => {
      pageAlive = false;
      for (const host of [normal, ...created]) {
        host.contentView.children = host.contentView.children.filter(child => child !== view);
      }
    },
    quickWindow: () => created[0] || null,
    borrow() {
      const started = quick.show();
      quick.enter({ revision: started.revision, busy: false });
      quick.ready({ revision: started.revision, busy: false });
      return started;
    },
  };
}

for (const [label, invalidate] of [
  ["a reload", (quick) => quick.invalidateRound("navigation")],
  ["a failed load", (quick) => quick.invalidateRound("load-failed")],
  ["a lost page", (quick) => quick.handlePageGone()],
]) {
  test(`${label} hands the borrowed foreground back to the source`, () => {
    const h = harness();
    h.borrow();
    const quickWindow = h.quickWindow();
    assert.equal(quickWindow.isVisible(), true);

    invalidate(h.quick);

    assert.deepEqual(h.originFocus.calls.restore, ["origin-hwnd"], "the source is asked for");
    assert.deepEqual(h.attachments, ["quick", "normal"], "the page came home first");
    assert.deepEqual(h.normal.opacityCalls, [0, 1], "and the host was un-parked");
    assert.equal(quickWindow.isVisible(), false, "the quick host is hidden after the return");
    assert.equal(quickWindow.hiddenCount, 1);
    assert.equal(h.quick.isActive(), false);
    assert.equal(
      h.normal.focusCount,
      0,
      "the source got the foreground, so nothing else is raised"
    );
  });
}

test("a submitted jump keeps the foreground it was handed", () => {
  const h = harness();
  const started = h.borrow();
  h.quickWindow().focused = true;
  assert.equal(h.quick.activate({ sessionId: "s1", revision: started.revision }).status, "submitted");

  h.quick.invalidateRound("navigation");

  assert.deepEqual(h.originFocus.calls.restore, [], "a real handoff owns the foreground");
  assert.equal(h.normal.focusCount, 0);
});

test("an invalidation after the user already left reclaims nothing", () => {
  const h = harness();
  h.borrow();

  // Real blur: the user clicked another window, which ends the round there.
  h.quickWindow().emit("blur");
  assert.equal(h.quick.isActive(), false);
  const restoresAfterBlur = h.originFocus.calls.restore.length;

  assert.equal(h.quick.invalidateRound("navigation"), false, "there is no round left to end");
  assert.equal(h.originFocus.calls.restore.length, restoresAfterBlur);
  assert.deepEqual(h.originFocus.calls.restore, [], "a blur never returns the source");
  assert.equal(h.normal.focusCount, 0);
});

test("an external window that already owns the foreground is left alone", () => {
  const h = harness({ holdsForeground: false });
  h.borrow();
  const pageFocusBefore = h.focusPageCalls.length;

  h.quick.invalidateRound("navigation");

  // restore() is allowed to be attempted — it is the one that checks — but it
  // must not succeed, and nothing else may be raised in its place.
  assert.equal(h.normal.focusCount, 0, "the window the user clicked keeps the foreground");
  assert.equal(h.focusPageCalls.length, pageFocusBefore, "and the page is not pulled back either");
  assert.equal(h.normal.shownCount, 0);
});

test("a source that can no longer take focus falls back to the window holding the page", () => {
  const h = harness({ sourceUsable: false });
  h.borrow();
  const focusesBefore = h.normal.focusCount;
  const pageFocusBefore = h.focusPageCalls.length;

  h.quick.invalidateRound("navigation");

  assert.deepEqual(h.originFocus.calls.restore, ["origin-hwnd"], "the source was tried first");
  assert.equal(h.normal.focusCount, focusesBefore + 1, "the visible Dashboard takes the keyboard");
  assert.equal(h.focusPageCalls.length, pageFocusBefore + 1, "and the page itself is focused");
  assert.equal(h.normal.shownCount, 0, "nothing was shown that the user had not opened");
  assert.equal(h.normal.restoreCount, 0);
  assert.equal(h.quickWindow().destroyCount, 0, "a successful ordinary return keeps the reusable shell");
});

test("the fallback proves it still owns the foreground after hiding, not before", () => {
  const options = { sourceUsable: false };
  const h = harness(options);
  h.borrow();
  const quickWindow = h.quickWindow();
  // Hiding a window can hand the foreground straight to whatever the OS picks
  // next. That window is the user's; a probe taken before the hide would still
  // say "we own the foreground" and authorize taking it away from them.
  quickWindow.hide = () => {
    quickWindow.visible = false;
    quickWindow.hiddenCount += 1;
    options.holdsForeground = false;
  };
  const focusesBefore = h.normal.focusCount;
  const pageFocusBefore = h.focusPageCalls.length;

  h.quick.invalidateRound("navigation");

  assert.equal(quickWindow.hiddenCount, 1, "the quick host still hid");
  assert.equal(h.normal.focusCount, focusesBefore, "but nothing grabbed the new foreground");
  assert.equal(h.focusPageCalls.length, pageFocusBefore);
});

test("a hidden or minimized ordinary host is never revealed to take the foreground", () => {
  const hidden = harness({ sourceUsable: false, normalVisible: false });
  hidden.borrow();
  hidden.quick.invalidateRound("navigation");
  assert.equal(hidden.normal.shownCount, 0, "a cold Dashboard stays closed");
  assert.equal(hidden.normal.focusCount, 0);
  assert.equal(hidden.quickWindow().destroyCount, 1, "the stranded empty shell retires instead");

  const minimized = harness({ sourceUsable: false });
  minimized.normal.minimized = true;
  minimized.borrow();
  minimized.quick.invalidateRound("navigation");
  assert.equal(minimized.normal.restoreCount, 0, "a minimized Dashboard stays minimized");
  assert.equal(minimized.normal.focusCount, 0);
  assert.equal(minimized.quickWindow().destroyCount, 1);
});

test("a page that is gone is never focused as a blank window", () => {
  const h = harness({ sourceUsable: false });
  h.borrow();
  const pageFocusBefore = h.focusPageCalls.length;

  h.killPage();
  h.quick.handlePageGone();

  assert.equal(h.normal.focusCount, 0, "there is no page to hand the keyboard to");
  assert.equal(h.focusPageCalls.length, pageFocusBefore);
  assert.deepEqual(h.normal.contentView.children, [], "the dead view was not reattached");
  assert.equal(h.quickWindow().destroyCount, 1, "the empty stranded shell still retires after page loss");
});

test("the ordinary host being activated by the user is not a foreground return", () => {
  const h = harness();
  h.borrow();

  // The user clicked the (parked, empty) ordinary window: that IS the
  // destination they chose, so the source must not be pulled back over it.
  assert.equal(h.quick.handleNormalHostFocus(), true);

  assert.deepEqual(h.originFocus.calls.restore, []);
  assert.equal(h.quick.isActive(), false);
  assert.deepEqual(h.attachments, ["quick", "normal"]);
});

test("a second shortcut press supersedes the round without returning the source", () => {
  const h = harness();
  h.borrow();

  const second = h.quick.show();

  assert.deepEqual(h.originFocus.calls.restore, [], "the user is still in the mode");
  assert.equal(h.normal.focusCount, 0);
  assert.equal(second.status, "ok");
});

test("late replies from an invalidated round can neither arm nor cancel anything", () => {
  const h = harness();
  const started = h.borrow();

  h.quick.invalidateRound("navigation");
  const restoresAfterInvalidate = h.originFocus.calls.restore.length;
  const focusesAfterInvalidate = h.normal.focusCount;

  assert.equal(h.quick.enter({ revision: started.revision, busy: false }).status, "stale");
  assert.deepEqual(h.quick.ready({ revision: started.revision }), { status: "stale" });
  assert.equal(
    h.quick.activate({ sessionId: "s1", revision: started.revision }).reason,
    "stale-revision"
  );
  assert.equal(h.quick.dismissFromRenderer({ revision: started.revision }).status, "stale");

  assert.equal(h.originFocus.calls.restore.length, restoresAfterInvalidate, "no second return");
  assert.equal(h.normal.focusCount, focusesAfterInvalidate);
  assert.equal(h.quick.isActive(), false);
  assert.equal(h.quick.isShown(), false);
});

test("an in-place round invalidating touches no foreground at all", () => {
  const h = harness({ normalFocused: true });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  assert.equal(h.quick.ready({ revision: started.revision }).inPlace, true);
  const focusesBefore = h.normal.focusCount;

  h.quick.invalidateRound("navigation");

  assert.equal(h.quickWindow(), null, "no quick host was ever created");
  assert.deepEqual(h.originFocus.calls.restore, []);
  assert.equal(h.normal.focusCount, focusesBefore, "the page never left this window");
  assert.equal(h.quick.isActive(), false);
});

test("an explicit cancel still returns the source (unchanged behaviour)", () => {
  const h = harness();
  const started = h.borrow();

  h.quick.dismissFromRenderer({ revision: started.revision });

  assert.deepEqual(h.originFocus.calls.restore, ["origin-hwnd"]);
  assert.equal(h.normal.focusCount, 0);
});
