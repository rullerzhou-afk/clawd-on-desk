"use strict";

// Windows 145e2613 native failure: Esc with a hidden ordinary host and a
// minimized source left the now-hidden quick HWND as foreground/focus root.
// Model native ownership separately from Electron's focused bit. Destruction
// below models only releasing our HWND, not which window Windows will choose.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createDashboardQuickMode } = require("../src/dashboard-quick-mode");
const createOriginFocus = require("../src/quick-select-origin-focus");

function harness(options = {}) {
  let foreground = "source";
  let sourceMinimized = false;
  let quitting = false;
  let returnFails = false;
  let pageAlive = true;
  const events = [];
  const windows = [];
  const contents = { isDestroyed: () => !pageAlive, send: (channel, payload) => events.push([channel, payload]) };
  const view = { webContents: contents, documentToken: {}, draft: "unchanged draft", scrollTop: 217 };
  let quick;
  class Window extends EventEmitter {
    constructor(opts = {}) {
      super();
      this.name = opts.title || "normal";
      this.visible = false;
      this.focused = false;
      this.minimized = false;
      this.destroyed = false;
      this.destroyCalls = 0;
      this.focusCalls = 0;
      this.showCalls = 0;
      this.opacity = 1;
      this.contentView = { children: [] };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    isMinimized() { return this.minimized; }
    show() { this.visible = true; this.showCalls += 1; }
    focus() {
      this.focusCalls += 1;
      events.push(["focus-window", this]);
      if (this === normal && options.ordinaryFocusDenied) return;
      this.focused = true;
      foreground = this;
    }
    hide() {
      events.push(["hide", this]);
      this.visible = false;
      this.focused = false; // native foreground may still be this HWND
      if (options.externalOnHide) foreground = "external";
      this.emit("blur");
    }
    destroy() {
      this.destroyCalls += 1;
      assert.equal(this.contentView.children.length, 0, "never destroy a shell still containing a view");
      events.push(["destroy", this]);
      if (options.destroyThrows) throw Error("native destroy failed");
      assert.equal(quick.isSelfFocusing(), true, "native teardown callbacks are self-induced");
      this.destroyed = true;
      if (foreground === this) foreground = options.normalAfterDestroy ? normal : null;
      this.emit("blur");
      this.emit("closed");
    }
    setMenuBarVisibility() {}
    setBounds() {}
    getOpacity() { return this.opacity; }
    setOpacity(value) { this.opacity = value; }
    setIgnoreMouseEvents() {}
  }
  const normal = new Window();
  normal.visible = options.normalVisible === true;
  normal.contentView.children.push(view);
  const bindings = {
    foreground: () => foreground,
    hwndOf: (win) => win,
    same: (a, b) => a === b,
    pid: () => 73,
    visible: () => true,
    minimized: (hwnd) => hwnd === "source" && sourceMinimized,
    setForeground: (hwnd) => { foreground = hwnd; events.push(["restore", hwnd]); return true; },
  };
  quick = createDashboardQuickMode({
    platform: options.platform || "win32",
    electron: { BaseWindow: Window },
    originFocus: createOriginFocus({ platform: "win32", bindings }),
    isAppQuitting: () => quitting,
    ensurePage: () => view,
    getNormalWindow: () => normal,
    getWebContents: () => pageAlive ? contents : null,
    isPageDestroyed: Object.hasOwn(options, "isPageDestroyed") ? options.isPageDestroyed : () => !pageAlive,
    getSessionSnapshot: () => ({ sessions: [{ id: "s1", canFocus: true }], orderedIds: ["s1"] }),
    attachViewTo: (win) => {
      if (!pageAlive) { events.push(["return-dead-page", win]); return false; }
      if (win === normal && returnFails) {
        if (options.emptyOnFailedReturn) {
          for (const w of windows) w.contentView.children = w.contentView.children.filter(v => v !== view);
        }
        return false;
      }
      for (const w of windows) w.contentView.children = w.contentView.children.filter(v => v !== view);
      win.contentView.children.push(view);
      events.push(["attach", win]);
      return true;
    },
    focusPage: () => events.push(["focus-page"]),
    focusReturnedPage: (win) => events.push(["focus-returned-page", win]),
    focusSession: () => ({ reason: "submitted" }),
  });
  return {
    quick, normal, view, windows, events,
    foreground: () => foreground,
    setForeground: (value) => { foreground = value; },
    minimizeSource: () => { sourceMinimized = true; },
    quit: () => { quitting = true; },
    failReturn: () => { returnFails = true; },
    killPage: () => {
      pageAlive = false;
      // Native page destruction removes its view; it cannot be re-parented.
      for (const w of windows) w.contentView.children = w.contentView.children.filter(v => v !== view);
    },
    borrow() {
      const offer = quick.show();
      assert.equal(quick.enter({ revision: offer.revision, busy: false }).status, "ok");
      assert.equal(quick.ready({ revision: offer.revision }).status, "ok");
      return offer.revision;
    },
  };
}

for (const reason of ["cancel", "close", "navigation", "load-failed", "page-gone"]) {
  test(`${reason}: retire only the hidden empty quick shell when both return targets are unavailable`, () => {
    const h = harness();
    const revision = h.borrow();
    const shell = h.quick.getQuickWindow();
    h.minimizeSource();
    if (reason === "cancel") h.quick.dismissFromRenderer({ revision });
    else if (reason === "close") shell.emit("close", { preventDefault() {} });
    else if (reason === "page-gone") { h.killPage(); h.quick.handlePageGone(); }
    else h.quick.invalidateRound(reason);
    assert.equal(shell.destroyCalls, 1);
    assert.equal(h.quick.getQuickWindow(), null);
    assert.notEqual(h.foreground(), shell);
    assert.deepEqual(h.normal.contentView.children, reason === "page-gone" ? [] : [h.view]);
    assert.equal(h.normal.visible, false);
    assert.equal(h.normal.showCalls, 0);
    assert.equal(h.normal.focusCalls, 0);
    assert.equal(h.quick.isActive(), false);
    assert.equal(h.quick.isShown(), false);
    assert.equal(h.quick.isSelfFocusing(), false);
    const returned = h.events.findIndex(e => e[0] === (reason === "page-gone" ? "return-dead-page" : "attach") && e[1] === h.normal);
    const destroyed = h.events.findIndex(e => e[0] === "destroy");
    assert.ok(returned >= 0 && returned < destroyed);
    assert.equal(h.events.filter(e => e[0] === "dashboard:quick-dismissed").length, reason === "page-gone" ? 0 : 1);
  });
}

test("a live page that failed return is not disposable even when the shell is empty", () => {
  const h = harness({ emptyOnFailedReturn: true });
  const revision = h.borrow();
  const shell = h.quick.getQuickWindow();
  h.minimizeSource();
  h.failReturn();
  h.quick.dismissFromRenderer({ revision });
  assert.deepEqual(shell.contentView.children, []);
  assert.equal(h.view.webContents.isDestroyed(), false);
  assert.equal(shell.destroyCalls, 0, "empty alone does not prove the live page was returned safely");
  assert.equal(h.quick.getQuickWindow(), shell);
});

for (const guard of ["missing-death-proof", "throwing-death-proof", "nonboolean-death-proof", "nonempty-shell", "hide-failed", "foreground-lost", "quit", "macOS"]) {
  test(`destroyed page, ${guard}: keep the existing retirement safety gate`, () => {
    const options = { platform: guard === "macOS" ? "darwin" : "win32" };
    if (guard === "missing-death-proof") options.isPageDestroyed = undefined;
    if (guard === "throwing-death-proof") options.isPageDestroyed = () => { throw Error("unavailable"); };
    if (guard === "nonboolean-death-proof") options.isPageDestroyed = () => "true";
    const h = harness(options);
    h.borrow();
    const shell = h.quick.getQuickWindow();
    h.minimizeSource();
    h.killPage();
    if (guard === "nonempty-shell") shell.contentView.children.push({ unrelatedOwnedView: true });
    if (guard === "hide-failed") shell.hide = () => { throw Error("hide failed"); };
    if (guard === "foreground-lost") h.setForeground("external");
    if (guard === "quit") h.quit();
    h.quick.handlePageGone();
    assert.equal(shell.destroyCalls, 0);
    assert.equal(h.quick.getQuickWindow(), shell);
    assert.equal(h.normal.focusCalls, 0);
    if (guard === "foreground-lost") assert.equal(h.foreground(), "external");
  });
}

test("the next shortcut recreates only the shell and old callbacks/replies cannot affect it", () => {
  const h = harness();
  const first = h.borrow();
  const old = h.quick.getQuickWindow();
  h.minimizeSource();
  h.quick.dismissFromRenderer({ revision: first });
  h.setForeground("new-source");
  const next = h.borrow();
  const current = h.quick.getQuickWindow();
  assert.notEqual(current, old);
  assert.deepEqual(current.contentView.children, [h.view]);
  assert.equal(h.view.draft, "unchanged draft");
  assert.equal(h.view.scrollTop, 217);
  for (const event of ["blur", "closed", "close", "move", "resize"]) old.emit(event, { preventDefault() {} });
  assert.equal(h.quick.getQuickWindow(), current);
  assert.equal(h.quick.getRevision(), next);
  assert.equal(h.quick.ready({ revision: first }).status, "stale");
  assert.equal(h.quick.dismissFromRenderer({ revision: first }).status, "stale");
  assert.equal(h.quick.isShown(), true);
  h.quick.dismissFromRenderer({ revision: next });
  assert.equal(h.foreground(), "new-source");
});

test("busy retained borrow is never retired until the matching explicit cancel", () => {
  const h = harness();
  const first = h.borrow();
  const shell = h.quick.getQuickWindow();
  h.minimizeSource();
  const replacement = h.quick.show().revision;
  assert.equal(h.quick.enter({ revision: replacement, busy: true }).retainedBorrow, true);
  assert.equal(shell.destroyCalls, 0);
  assert.deepEqual(shell.contentView.children, [h.view]);
  assert.equal(h.quick.dismissFromRenderer({ revision: first }).status, "stale");
  assert.equal(shell.destroyCalls, 0);
  h.quick.dismissFromRenderer({ revision: replacement });
  assert.equal(shell.destroyCalls, 1);
});

test("a minimized ordinary host remains minimized while the empty shell retires", () => {
  const h = harness({ normalVisible: true });
  h.normal.minimized = true;
  const revision = h.borrow();
  const shell = h.quick.getQuickWindow();
  h.minimizeSource();
  h.quick.dismissFromRenderer({ revision });
  assert.equal(shell.destroyCalls, 1);
  assert.equal(h.normal.minimized, true);
  assert.equal(h.normal.focusCalls, 0);
  assert.equal(h.normal.opacity, 1);
});

for (const selectedOrdinary of [true, false]) {
  test(`after retirement, page compensation requires the OS to select the ordinary host: ${selectedOrdinary}`, () => {
    const h = harness({ normalVisible: true, ordinaryFocusDenied: true, normalAfterDestroy: selectedOrdinary });
    const revision = h.borrow();
    const shell = h.quick.getQuickWindow();
    h.minimizeSource();
    h.quick.dismissFromRenderer({ revision });
    assert.equal(shell.destroyCalls, 1);
    assert.equal(h.normal.isFocused(), false, "Electron's bit is independent of native selection");
    const afterDestroy = h.events.slice(h.events.findIndex(e => e[0] === "destroy") + 1);
    assert.equal(afterDestroy.filter(e => e[0] === "focus-returned-page").length, selectedOrdinary ? 1 : 0);
    assert.equal(afterDestroy.filter(e => e[0] === "focus-window").length, 0, "compensation never raises a window");
    if (selectedOrdinary) assert.deepEqual(afterDestroy.find(e => e[0] === "focus-returned-page"), ["focus-returned-page", h.normal]);
    assert.deepEqual(h.normal.contentView.children, [h.view]);
  });
}

for (const guard of ["source-returned", "ordinary-returned", "external-on-hide", "external-before-exit", "blur", "submitted", "ordinary-open", "quit", "macOS", "failed-return", "nonempty-shell", "hide-failed"]) {
  test(`${guard}: do not retire or take a new foreground`, () => {
    const h = harness({ normalVisible: guard === "ordinary-returned", externalOnHide: guard === "external-on-hide", platform: guard === "macOS" ? "darwin" : "win32" });
    const revision = h.borrow();
    const shell = h.quick.getQuickWindow();
    if (guard !== "source-returned") h.minimizeSource();
    if (guard === "external-before-exit") h.setForeground("external");
    if (guard === "quit") h.quit();
    if (guard === "failed-return") h.failReturn();
    if (guard === "nonempty-shell") shell.contentView.children.push({ unrelatedOwnedView: true });
    if (guard === "hide-failed") shell.hide = () => { throw Error("hide failed"); };
    if (guard === "submitted") assert.equal(h.quick.activate({ revision, sessionId: "s1" }).status, "submitted");
    if (guard === "ordinary-open") h.quick.endForOrdinaryOpen();
    else if (guard === "blur") shell.emit("blur");
    else h.quick.dismissFromRenderer({ revision });
    assert.equal(shell.destroyCalls, 0);
    if (guard.startsWith("external")) assert.equal(h.foreground(), "external");
    if (guard === "ordinary-returned") assert.equal(h.foreground(), h.normal);
    if (guard === "source-returned") assert.equal(h.foreground(), "source");
  });
}

test("native destruction failure preserves the tracked shell and still ends the round", () => {
  const h = harness({ destroyThrows: true });
  const revision = h.borrow();
  const shell = h.quick.getQuickWindow();
  h.minimizeSource();
  assert.doesNotThrow(() => h.quick.dismissFromRenderer({ revision }));
  assert.equal(shell.destroyCalls, 1);
  assert.equal(h.quick.getQuickWindow(), shell);
  assert.equal(h.quick.isActive(), false);
  assert.equal(h.quick.isSelfFocusing(), false);
  assert.deepEqual(h.normal.contentView.children, [h.view]);
});
