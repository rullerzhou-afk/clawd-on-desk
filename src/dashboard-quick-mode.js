"use strict";

// Temporary keyboard mode for the real Dashboard page (macOS/Windows only).
//
// There is exactly one Dashboard page. Pressing the shortcut moves that same
// `WebContentsView` into a non-activating quick host so the user can press 1–9
// without Clawd entering the Cmd+Tab / Alt+Tab return chain, then moves it back.
// Nothing about the page, its DOM state, drafts or scroll is rebuilt.
//
// Ordering that the native probe proved and this owner must keep:
//   * never hide()/showInactive() an already-visible ordinary host — that
//     raises it above the source window on return (measured, not theoretical).
//     A visible ordinary host is instead parked at opacity 0 with mouse input
//     disabled, and restored to its captured value on every exit path.
//   * a parked host must never hold the keyboard: setIgnoreMouseEvents(true)
//     explicitly still delivers key events to a focused window.
//   * `submitted` only means the jump was handed to the production focus path.
//     The quick host stays up until the native blur completes the handoff.
//
// Round identity: main owns a monotonic revision. Only main may advance it (a
// fresh shortcut press); every renderer->main call must carry the exact current
// revision, and `dismissed` carries the revision of the round it ended.

const createOriginFocus = require("./quick-select-origin-focus");

const QUICK_PLATFORMS = new Set(["darwin", "win32"]);

// Page-level invalidations: the document the round was negotiated with is gone
// (reload, failed load, crashed/destroyed page). They end the round while this
// owner may still hold the foreground it borrowed, and unlike a blur, an
// external click or a real jump, nothing else has been given the keyboard — so
// the borrowed foreground goes back exactly like an explicit cancel.
const FOREGROUND_RETURNING_REASONS = new Set(["navigation", "load-failed", "page-gone"]);

function isSupportedQuickPlatform(platform) {
  return QUICK_PLATFORMS.has(platform);
}

function isLiveWindow(win) {
  if (!win) return false;
  try {
    return typeof win.isDestroyed !== "function" || !win.isDestroyed();
  } catch {
    return false;
  }
}

function callSafe(target, method, ...args) {
  if (!target || typeof target[method] !== "function") return undefined;
  try {
    return target[method](...args);
  } catch {
    return undefined;
  }
}

// Frozen membership: the first nine focusable candidates in the shared
// snapshot's own order. Digits own IDs for the whole round, never list indices.
function orderedCandidates(snapshot) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  const byId = new Map(sessions.map((entry) => [entry.id, entry]));
  const ids = [
    ...(Array.isArray(snapshot && snapshot.groups) ? snapshot.groups : [])
      .flatMap((group) => (group && group.ids) || []),
    ...((snapshot && snapshot.orderedIds) || []),
    ...sessions.map((entry) => entry.id),
  ];
  return [...new Set(ids)]
    .map((id) => byId.get(id))
    .filter((entry) => entry && entry.canFocus === true)
    .slice(0, 9);
}

function publicEntry(entry) {
  return {
    id: entry.id,
    title: entry.displayTitle || entry.sessionTitle || entry.id,
    agentName: entry.agentName || entry.agentId || "",
    badge: entry.badge || "idle",
    canFocus: entry.canFocus === true,
  };
}

function createDashboardQuickMode(ctx = {}) {
  const platform = ctx.platform || process.platform;
  const supported = isSupportedQuickPlatform(platform);
  const electron = ctx.electron || {};
  // Windows only: remember the foreground window this round borrowed from and
  // hand it back on an explicit cancel. Never on blur or on a real handoff.
  const originFocus = ctx.originFocus || createOriginFocus({ platform });

  let origin = null;
  let quickWindow = null;
  let revision = 0;
  // The round main has offered but the renderer has not accepted yet.
  let pendingRevision = 0;
  // The accepted, currently active round (0 = no active round).
  let activeRevision = 0;
  // The round whose host is actually armed. A round is accepted by `enter()`
  // but only becomes activatable once `ready()` has placed the page on a host
  // that holds focus — otherwise a reply racing an ordinary open could submit
  // a jump from a window the user is no longer looking at.
  let readyRevision = 0;
  // False for a round opened with no candidates: the full Dashboard is shown
  // (so the shortcut is never a silent no-op) but digits capture nothing.
  let numericCapture = false;
  let mappedEntries = [];
  let submitted = false;
  // Physical borrow, independent of an accepted numeric round. A busy
  // replacement keeps the editor here until an explicit exit or fresh offer.
  let shown = false;
  let transferring = false;
  // Set while this owner is the cause of a native focus change, so a blur or
  // focus it triggered itself is never mistaken for the user leaving/entering.
  let selfFocusDepth = 0;
  // Park bookkeeping for the ordinary host. Captured exactly once per round;
  // `restore` is idempotent and safe on an already destroyed handle.
  let parked = null;

  const snapshot = () => (ctx.getSessionSnapshot && ctx.getSessionSnapshot()) || { sessions: [] };
  const normalWindow = () => (ctx.getNormalWindow ? ctx.getNormalWindow() : null);
  const webContents = () => (ctx.getWebContents ? ctx.getWebContents() : null);
  // True once the application itself is shutting down. A close arriving then is
  // Electron asking for the window back, not a user cancelling a round.
  const appQuitting = () => {
    if (typeof ctx.isAppQuitting !== "function") return false;
    try { return ctx.isAppQuitting() === true; } catch { return false; }
  };

  function send(channel, payload) {
    const contents = webContents();
    if (!contents) return;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return;
    try { contents.send(channel, payload); } catch {}
  }

  function currentEntries(nextSnapshot = snapshot()) {
    const byId = new Map(((nextSnapshot && nextSnapshot.sessions) || [])
      .map((entry) => [entry.id, entry]));
    // Tombstones: a numbered session that vanished keeps its digit as an
    // inactive placeholder. Digits are never handed to a different session.
    return mappedEntries.map((previous) => {
      const live = byId.get(previous.id);
      return live ? publicEntry(live) : { ...previous, canFocus: false };
    });
  }

  function ensureQuickWindow() {
    if (isLiveWindow(quickWindow)) return quickWindow;
    const { BaseWindow } = electron;
    if (!BaseWindow) return null;
    const created = new BaseWindow({
      show: false,
      frame: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: false,
      // Windows tool windows take keyboard focus without entering Alt+Tab;
      // macOS panels take key focus without activating the app, which keeps
      // Clawd out of the Cmd+Tab return chain even with a visible Dock tile.
      skipTaskbar: platform !== "darwin",
      ...(platform === "win32" ? { type: "toolbar" } : {}),
      ...(platform === "darwin" ? { type: "panel" } : {}),
      title: ctx.t ? ctx.t("dashboardWindowTitle") : "Sessions",
      ...(ctx.getBackgroundColor ? { backgroundColor: ctx.getBackgroundColor() } : {}),
      ...(ctx.iconPath ? { icon: ctx.iconPath } : {}),
    });
    quickWindow = created;
    callSafe(created, "setMenuBarVisibility", false);
    created.on("blur", () => {
      // Detach/attach and native dialogs produce blur that is not an exit.
      if (created !== quickWindow || transferring || !shown) return;
      dismiss({ reason: "blur" });
    });
    created.on("close", (event) => {
      if (created !== quickWindow) return;
      // A quit closes every window before `will-quit`, so refusing the close
      // here would cancel the quit itself and leave this hidden window (and the
      // process) alive. Return the page, then let the window go.
      if (appQuitting()) {
        dismiss({ reason: "app-quit" });
        return;
      }
      // The quick host is a transient surface for the shared page; closing it
      // must return the page, not destroy the Dashboard.
      if (typeof event.preventDefault === "function") event.preventDefault();
      dismiss({ reason: "close", restoreOrigin: true });
    });
    created.on("closed", () => {
      // An exhausted Windows return may retire this empty shell. A delayed
      // event from it must not clear a replacement created by a new shortcut.
      if (quickWindow === created) quickWindow = null;
    });
    created.on("resize", () => {
      if (created !== quickWindow || !shown) return;
      ctx.syncViewBounds && ctx.syncViewBounds();
      ctx.applyPageScale && ctx.applyPageScale();
    });
    // The quick host can be dragged onto a display with a different text
    // scale. The borrowed page must follow the host it is actually in, not
    // the parked ordinary window's display.
    created.on("move", () => {
      if (created !== quickWindow || !shown) return;
      ctx.applyPageScale && ctx.applyPageScale();
    });
    return created;
  }

  function quickBounds() {
    if (!ctx.getQuickHostBounds) return null;
    try { return ctx.getQuickHostBounds(); } catch { return null; }
  }

  function parkNormalHost() {
    if (parked) return;
    const win = normalWindow();
    if (!isLiveWindow(win)) return;
    const visible = callSafe(win, "isVisible") === true;
    if (!visible) return;
    // Capture the real opacity once; restore writes this value back rather
    // than assuming 1. There is no native getter for the mouse-input policy,
    // so the owner records the value it set.
    const opacity = typeof win.getOpacity === "function" ? callSafe(win, "getOpacity") : 1;
    parked = {
      window: win,
      opacity: Number.isFinite(opacity) ? opacity : 1,
      ignoreMouseEvents: false,
    };
    callSafe(win, "setIgnoreMouseEvents", true);
    callSafe(win, "setOpacity", 0);
  }

  function unparkNormalHost() {
    if (!parked) return;
    const { window: win, opacity, ignoreMouseEvents } = parked;
    parked = null;
    if (!isLiveWindow(win)) return;
    callSafe(win, "setIgnoreMouseEvents", ignoreMouseEvents);
    callSafe(win, "setOpacity", opacity);
  }

  function attachViewTo(win) {
    if (!ctx.attachViewTo) return false;
    transferring = true;
    selfFocusDepth += 1;
    try {
      return ctx.attachViewTo(win) !== false;
    } catch {
      return false;
    } finally {
      selfFocusDepth -= 1;
      transferring = false;
    }
  }

  // Run a native call that we expect to move focus, so our own blur/focus
  // events are not read as the user leaving or returning.
  function selfFocus(fn) {
    selfFocusDepth += 1;
    transferring = true;
    try {
      return fn();
    } finally {
      transferring = false;
      selfFocusDepth -= 1;
    }
  }

  // Whether the given host is, right now, the native foreground window. False
  // whenever the platform cannot answer (macOS, or Windows without the native
  // bindings), which keeps every caller on the "do nothing" branch.
  function stillHoldsForeground(win) {
    if (typeof originFocus.holdsForeground !== "function") return false;
    try {
      return originFocus.holdsForeground(win) === true;
    } catch {
      return false;
    }
  }

  // Last resort after the quick host hid while it still owned the foreground
  // and the source could not take it back (destroyed, minimized, reused by
  // another process, or never captured). Windows can leave the hidden tool
  // window as GetForegroundWindow(), which leaves no visible window holding the
  // keyboard at all. Hand it to the window that now holds the page — never to
  // an unrelated window, never by showing or restoring a host the user had not
  // opened, and never to a host whose page is gone.
  function returnForegroundToOrdinaryHost() {
    const win = normalWindow();
    if (!isLiveWindow(win)) return false;
    if (callSafe(win, "isVisible") !== true) return false;
    if (callSafe(win, "isMinimized") === true) return false;
    if (!webContents()) return false;
    selfFocus(() => {
      callSafe(win, "focus");
      if (ctx.focusPage) {
        try { ctx.focusPage(); } catch {}
      }
    });
    return true;
  }

  // If neither return target can take the keyboard, hiding a Windows toolbar
  // can leave its empty HWND as native foreground. Retire only that shell and
  // let Windows choose the next window; never pick an unrelated app ourselves.
  // A live page must already be safe at home. A destroyed page cannot be
  // re-parented; only the owner's explicit death proof can waive that return.
  // The native ownership check stays last (the ordinary fallback may change it).
  function retireStrandedQuickHost(pageReturned) {
    const win = quickWindow;
    if (platform !== "win32" || appQuitting() || !isLiveWindow(win)) return false;
    if (!pageReturned && callSafe(ctx, "isPageDestroyed") !== true) return false;
    if (callSafe(win, "isVisible") !== false) return false;
    try {
      if (win.contentView.children.length !== 0) return false;
    } catch { return false; }
    if (!stillHoldsForeground(win)) return false;
    return selfFocus(() => {
      try {
        win.destroy();
        if (quickWindow === win) quickWindow = null;
        return true;
      } catch { return false; } // keep the handle tracked if destruction failed
    });
  }

  // Windows may select the ordinary HWND on a source-window minimize without
  // updating Electron's isFocused() bit or delivering another focus event.
  // After the view has come home, give ONLY its page the keyboard. This is not
  // a foreground return: the OS already chose the destination. Never raise a
  // window, and prove that choice after our hide/scale work, not before it.
  function focusReturnedPageIfNativeHostOwnsKeyboard() {
    if (platform !== "win32" || appQuitting() || shown || parked) return;
    const win = normalWindow();
    if (!isLiveWindow(win) || callSafe(win, "isVisible") !== true) return;
    if (callSafe(win, "isMinimized") === true) return;
    if (callSafe(win, "isFocused") === true) return; // the ordinary focus handler covers this
    if (!stillHoldsForeground(win) || typeof ctx.focusReturnedPage !== "function") return;
    selfFocus(() => {
      try { ctx.focusReturnedPage(win); } catch {}
    });
  }

  // Ends the round: invalidate first, then restore the page, then hide.
  function dismiss(options = {}) {
    // A busy replacement can leave the editor borrowed without an accepted
    // numeric round. It still needs its current dismissal notification.
    const endedRevision = activeRevision || pendingRevision || (shown ? revision : 0);
    const wasActive = activeRevision !== 0;
    const wasShown = shown;
    const wasSubmitted = submitted;
    const previousOrigin = origin;
    origin = null;
    pendingRevision = 0;
    activeRevision = 0;
    readyRevision = 0;
    numericCapture = false;
    mappedEntries = [];
    submitted = false;
    shown = false;

    if (wasActive || wasShown) {
      const pageReturned = !wasShown || attachViewTo(normalWindow());
      let retiredQuickHost = false;
      unparkNormalHost();
      if (isLiveWindow(quickWindow) && callSafe(quickWindow, "isVisible") === true) {
        // Only an explicit cancel or a page-level invalidation returns the
        // borrowed foreground. A blur or a real jump already handed focus
        // somewhere the user chose.
        const returning = options.restoreOrigin === true && !wasSubmitted;
        const restored = returning && originFocus.restore(previousOrigin, quickWindow) === true;
        selfFocus(() => callSafe(quickWindow, "hide"));
        // The fallback below is only allowed while this owner still owns the
        // foreground, and that has to be proven AFTER the hide: hiding can hand
        // the foreground to whatever the OS picks next, and that window is the
        // user's, not ours to take. A probe from before the hide would authorize
        // stealing it.
        if (returning && !restored && stillHoldsForeground(quickWindow)) {
          if (pageReturned) returnForegroundToOrdinaryHost();
          retiredQuickHost = retireStrandedQuickHost(pageReturned);
        }
      }
      // Back on the ordinary host: restore that display's page scale.
      if (wasShown) ctx.applyPageScale && ctx.applyPageScale();
      if (wasShown && pageReturned && (retiredQuickHost || options.reason === "blur" || options.reason === "normal-host-focus")) {
        focusReturnedPageIfNativeHostOwnsKeyboard();
      }
    } else {
      // A pending-but-unaccepted round never touched the hosts.
      unparkNormalHost();
    }

    if (endedRevision) send("dashboard:quick-dismissed", { revision: endedRevision });
    return { status: "ok" };
  }

  // Called by the owner before it performs an ordinary show/focus so the page
  // is back in the ordinary host and opaque before it takes the keyboard.
  function endForOrdinaryOpen() {
    if (!activeRevision && !pendingRevision && !shown && !parked) return false;
    dismiss({ reason: "ordinary-open" });
    return true;
  }

  // The page navigated, reloaded, failed to load or died. Whatever round was
  // in flight is meaningless now: no late enter/ready reply may revive it, and
  // the borrowed foreground goes back to the source rather than staying with a
  // window that is about to be hidden.
  function invalidateRound(reason) {
    if (!activeRevision && !pendingRevision && !shown && !parked) return false;
    const key = reason || "page-invalidated";
    dismiss({ reason: key, restoreOrigin: FOREGROUND_RETURNING_REASONS.has(key) });
    return true;
  }

  // The ordinary host became the real foreground while it was parked and
  // empty. Return the page before it can take the keyboard as a blank window.
  function handleNormalHostFocus() {
    if (selfFocusDepth > 0) return false;
    if (!shown && !parked) return false;
    return invalidateRound("normal-host-focus");
  }

  // In-place rounds live on the ordinary host, so its blur ends them. A blur
  // caused by our own transfer is not an exit.
  function handleNormalHostBlur() {
    if (selfFocusDepth > 0 || shown) return false;
    if (!activeRevision) return false;
    dismiss({ reason: "normal-host-blur" });
    return true;
  }

  function show() {
    if (!supported) return { status: "unsupported" };
    if (!ctx.ensurePage) return { status: "error" };
    let page = null;
    try { page = ctx.ensurePage(); } catch { page = null; }
    if (!page) return { status: "error" };

    // Supersede the *numeric round*, not the physical borrow. Moving the view
    // here blurs/commits an alias before the renderer can answer busy. Keep its
    // editor on the current host through both enter and ready negotiations.
    // The main fence closes synchronously, before the intent reaches renderer.
    origin = !submitted && shown && stillHoldsForeground(quickWindow) ? origin : null;
    activeRevision = 0;
    readyRevision = 0;
    numericCapture = false;
    revision += 1;
    pendingRevision = revision;
    mappedEntries = [];
    submitted = false;
    send("dashboard:quick-intent", { revision: pendingRevision });
    return { status: "ok", revision: pendingRevision };
  }

  function refuseBusyRound(targetRevision) {
    pendingRevision = 0;
    activeRevision = 0;
    readyRevision = 0;
    numericCapture = false;
    mappedEntries = [];
    // No host actions and no dismissal message: either could blur/rebuild the
    // input. A previously borrowed editor stays open, with only a fenced cancel
    // after editing; this reply cannot later be used as an enter/ready ticket.
    if (!shown) origin = null;
    return { status: "busy", revision: targetRevision, retainedBorrow: shown };
  }

  // renderer -> main. The renderer reports whether it is busy editing before
  // anything native moves, because the detach itself would blur an alias input
  // and commit a half-typed draft.
  function enter(payload) {
    if (!supported) return { status: "unsupported" };
    if (!payload || typeof payload !== "object") return { status: "rejected", reason: "invalid-payload" };
    if (payload.revision !== pendingRevision || pendingRevision === 0) {
      return { status: "stale" };
    }
    if (payload.busy === true) {
      // Refuse this press entirely: no mapping, no transfer, no latent armed
      // state. The draft/IME/select keeps its keyboard untouched.
      return refuseBusyRound(payload.revision);
    }
    const candidates = orderedCandidates(snapshot()).map(publicEntry);
    // No candidates still opens the real Dashboard on its own empty state —
    // the shortcut must never look broken — but the round captures no digits
    // and is bounded by the same cancel/blur/ordinary-open lifecycle.
    activeRevision = pendingRevision;
    pendingRevision = 0;
    readyRevision = 0;
    mappedEntries = candidates;
    numericCapture = candidates.length > 0;
    submitted = false;
    return {
      status: candidates.length ? "ok" : "empty",
      revision: activeRevision,
      numericCapture,
      entries: currentEntries(),
    };
  }

  // renderer -> main, after the digits are painted into the existing page.
  // Only now may the quick host appear.
  function ready(payload) {
    if (!payload || payload.revision !== activeRevision || activeRevision === 0) {
      return { status: "stale" };
    }
    // The user started editing between accepting the round and painting it.
    // Nothing has moved yet, so abandon the whole round rather than transfer
    // a page whose detach would blur an alias input and commit its draft.
    if (payload.busy === true) {
      return refuseBusyRound(payload.revision);
    }
    if (readyRevision === activeRevision) return { status: "ok" };

    const normal = normalWindow();
    const alreadyFocused = isLiveWindow(normal) && callSafe(normal, "isFocused") === true;
    if (alreadyFocused) {
      // Normally a real ordinary focus event already ended the old borrow.
      // If that event is delayed, finish the return only NOW, after both busy
      // checks, without ending the new revision negotiated with this page.
      if (shown) {
        const returned = attachViewTo(normal);
        unparkNormalHost();
        selfFocus(() => callSafe(quickWindow, "hide"));
        shown = false;
        ctx.applyPageScale && ctx.applyPageScale();
        if (!returned) {
          dismiss({ reason: "transfer-failed" });
          return { status: "error" };
        }
        selfFocus(() => { ctx.focusPage && ctx.focusPage(); });
      }
      // The user is already looking at the Dashboard: arm the digits in place.
      // No borrow, no host flags, no geometry change.
      shown = false;
      origin = null;
      readyRevision = activeRevision;
      return { status: "ok", inPlace: true };
    }

    // Do not treat a newly recreated empty host as the one still holding the
    // borrowed page. Clean up the lost borrow; a fresh press may create again.
    if (shown && (!isLiveWindow(quickWindow) || callSafe(quickWindow, "isVisible") !== true)) {
      dismiss({ reason: "quick-host-unavailable" });
      return { status: "error" };
    }
    const win = ensureQuickWindow();
    if (!win) {
      dismiss({ reason: "quick-host-unavailable" });
      return { status: "error" };
    }

    // Capture the borrowed foreground before anything of ours takes focus.
    origin = originFocus.capture(win, origin);
    if (shown) {
      // Reuse the very same view/host; do not detach, unpark/repark, resize or
      // reset native input just to replace a set of digits. An explicit new
      // shortcut from another foreground may still need to raise this host.
      const ownsKeyboard = callSafe(win, "isFocused") === true
        && (platform !== "win32" || stillHoldsForeground(win));
      if (!ownsKeyboard) {
        const raised = selfFocus(() => {
          try { win.show(); win.focus(); ctx.focusPage && ctx.focusPage(); return true; }
          catch { return false; }
        });
        if (!raised || !isLiveWindow(win)) {
          rollbackBorrow();
          return { status: "error" };
        }
      }
      readyRevision = activeRevision;
      return { status: "ok", inPlace: false, numericCapture };
    }
    const bounds = quickBounds();
    if (bounds) callSafe(win, "setBounds", bounds);
    parkNormalHost();
    if (!attachViewTo(win)) {
      // Roll the attachment back too: ctx.attachViewTo detaches before it
      // adds, so a failure can leave the page parented to nothing.
      rollbackBorrow();
      return { status: "error" };
    }
    shown = true;
    // show()/focus() can throw on a window the OS tore down underneath us;
    // that must roll the borrow back, not leave a parked invisible host.
    const raised = selfFocus(() => {
      try {
        win.show();
        win.focus();
        return true;
      } catch {
        return false;
      }
    });
    if (!raised || !isLiveWindow(win)) {
      shown = false;
      rollbackBorrow();
      return { status: "error" };
    }
    readyRevision = activeRevision;
    ctx.syncViewBounds && ctx.syncViewBounds();
    // The quick host may sit on a display with a different text scale.
    ctx.applyPageScale && ctx.applyPageScale();
    ctx.focusPage && ctx.focusPage();
    return { status: "ok", inPlace: false, numericCapture };
  }

  // Undo a half-applied borrow: attachment first (so the page is never
  // orphaned), then the host flags, then the round itself.
  function rollbackBorrow() {
    attachViewTo(normalWindow());
    unparkNormalHost();
    if (isLiveWindow(quickWindow) && callSafe(quickWindow, "isVisible") === true) {
      selfFocus(() => callSafe(quickWindow, "hide"));
    }
    shown = false;
    dismiss({ reason: "transfer-failed" });
  }

  function activate(payload) {
    if (!supported) return { status: "rejected", reason: "unsupported" };
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== "revision"
      || keys[1] !== "sessionId"
      || typeof payload.sessionId !== "string"
      || !payload.sessionId
      || !Number.isInteger(payload.revision)
    ) {
      return { status: "rejected", reason: "invalid-payload" };
    }
    if (activeRevision === 0 || payload.revision !== activeRevision) {
      return { status: "rejected", reason: "stale-revision" };
    }
    // Accepted is not enough: the round must have reached `ready()`, so the
    // page is demonstrably on an armed host. This also covers the in-place
    // round, which never shows a quick window.
    if (readyRevision !== activeRevision) {
      return { status: "rejected", reason: "round-not-ready" };
    }
    if (!numericCapture) return { status: "rejected", reason: "no-candidates" };
    if (submitted) return { status: "rejected", reason: "dropped-duplicate" };
    // The host that currently owns the page must hold native focus, so a
    // background window can never submit a jump.
    const host = shown ? quickWindow : normalWindow();
    if (!isLiveWindow(host) || callSafe(host, "isFocused") !== true) {
      return { status: "rejected", reason: "host-not-focused" };
    }
    const entry = currentEntries().find((item) => item.id === payload.sessionId);
    if (!entry || !entry.canFocus) return { status: "rejected", reason: "focus-unavailable" };

    let result;
    try {
      result = ctx.focusSession(payload.sessionId, { requestSource: "dashboard-quick" });
    } catch {
      return { status: "rejected", reason: "focus-threw" };
    }
    const reason = result && result.reason;
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch((err) =>
        console.warn("Dashboard quick select focus request failed:", err));
    } else if (result !== true && !["submitted", "queued", "linux-command-submitted"].includes(reason)) {
      return { status: "rejected", reason: reason || "focus-unavailable" };
    }
    // Submitted only means handed off. The quick host stays until native blur.
    submitted = true;
    return { status: "submitted" };
  }

  function dismissFromRenderer(payload) {
    const target = payload && payload.revision;
    if (!Number.isInteger(target) || target <= 0) return { status: "rejected", reason: "invalid-payload" };
    const retainedBorrow = shown && activeRevision === 0 && pendingRevision === 0 && target === revision;
    if (target !== activeRevision && target !== pendingRevision && !retainedBorrow) return { status: "stale" };
    // Esc / Tab is the explicit cancel path.
    return dismiss({ reason: "renderer", restoreOrigin: true });
  }

  return {
    isSupported: () => supported,
    show,
    enter,
    ready,
    activate,
    dismissFromRenderer,
    endForOrdinaryOpen,
    invalidateRound,
    handleNormalHostFocus,
    handleNormalHostBlur,
    getRevision: () => activeRevision,
    isReady: () => readyRevision !== 0 && readyRevision === activeRevision,
    capturesDigits: () => numericCapture,
    // True while this owner is itself moving native focus (detach/attach,
    // show, hide). Callers must not read a focus/blur raised during that
    // window as a user-driven activation.
    isSelfFocusing: () => selfFocusDepth > 0,
    // True while the ordinary host is parked: transparent, input-disabled and
    // holding no page. It must never be handed the keyboard.
    isParked: () => parked !== null,
    // A page that finished loading after the shortcut press asks for the
    // intent it missed; late/cancelled rounds report 0.
    getPendingRevision: () => pendingRevision,
    isActive: () => activeRevision !== 0,
    isShown: () => shown,
    getQuickWindow: () => (isLiveWindow(quickWindow) ? quickWindow : null),
    getActiveHost: () => (shown ? quickWindow : normalWindow()),
    broadcastSessionSnapshot(nextSnapshot) {
      if (!activeRevision) return;
      send("dashboard:quick-entries", {
        revision: activeRevision,
        entries: currentEntries(nextSnapshot),
      });
    },
    // Page/renderer went away: drop the round and un-park so no invisible,
    // click-through ordinary host can survive. Same foreground rule as the
    // other page-level invalidations.
    handlePageGone() {
      dismiss({ reason: "page-gone", restoreOrigin: true });
    },
    dispose() {
      dismiss({ reason: "dispose" });
      if (isLiveWindow(quickWindow)) callSafe(quickWindow, "destroy");
      quickWindow = null;
    },
  };
}

module.exports = {
  createDashboardQuickMode,
  isSupportedQuickPlatform,
  orderedCandidates,
};
