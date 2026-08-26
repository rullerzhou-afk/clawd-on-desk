"use strict";

const noop = () => {};

function isLiveWindow(win) {
  return !!(win && (typeof win.isDestroyed !== "function" || !win.isDestroyed()));
}

function getPendingList(getPendingPermissions) {
  const pending = getPendingPermissions();
  return Array.isArray(pending) ? pending : [];
}

function createFloatingWindowRuntime(options = {}) {
  const getPendingPermissions = options.getPendingPermissions || (() => []);
  const keepOutOfTaskbar = options.keepOutOfTaskbar || noop;
  const repositionPermissionBubbles = options.repositionPermissionBubbles || noop;
  const repositionUpdateBubble = options.repositionUpdateBubble || noop;
  const repositionSessionHud = options.repositionSessionHud || noop;
  const repositionQuotaRing = options.repositionQuotaRing || noop;
  const syncSessionHudVisibility = options.syncSessionHudVisibility || noop;
  const syncUpdateBubbleVisibility = options.syncUpdateBubbleVisibility || noop;
  const hideUpdateBubble = options.hideUpdateBubble || noop;
  const showPermissionSurfacesForPet = options.showPermissionSurfacesForPet || null;
  const hidePermissionSurfacesForPet = options.hidePermissionSurfacesForPet || null;

  function repositionFloatingBubbles() {
    if (getPendingList(getPendingPermissions).length) repositionPermissionBubbles();
    repositionUpdateBubble();
    // Orbit reads both permission and update-bubble bounds. Reposition it last
    // so it never avoids the previous update-bubble position.
    repositionQuotaRing();
  }

  function repositionAnchoredSurfaces() {
    repositionSessionHud();
    repositionFloatingBubbles();
  }

  function syncSessionHudVisibilityAndBubbles() {
    syncSessionHudVisibility();
    repositionFloatingBubbles();
  }

  function showFloatingSurfacesForPet() {
    if (typeof showPermissionSurfacesForPet === "function") {
      showPermissionSurfacesForPet();
    } else {
      for (const perm of getPendingList(getPendingPermissions)) {
        const bubble = perm && perm.bubble;
        if (isLiveWindow(bubble) && typeof bubble.showInactive === "function") {
          bubble.showInactive();
          keepOutOfTaskbar(bubble);
        }
      }
    }
    // pet-window-runtime invokes this before it commits petHidden=false. Pass
    // the target state explicitly so update-bubble does not read the stale
    // getter and remain hidden after the pet returns.
    syncUpdateBubbleVisibility(false);
  }

  function hideFloatingSurfacesForPet() {
    if (typeof hidePermissionSurfacesForPet === "function") {
      hidePermissionSurfacesForPet();
    } else {
      for (const perm of getPendingList(getPendingPermissions)) {
        const bubble = perm && perm.bubble;
        if (isLiveWindow(bubble) && typeof bubble.hide === "function") {
          bubble.hide();
        }
      }
    }
    hideUpdateBubble();
  }

  return {
    repositionFloatingBubbles,
    repositionAnchoredSurfaces,
    syncSessionHudVisibilityAndBubbles,
    showFloatingSurfacesForPet,
    hideFloatingSurfacesForPet,
  };
}

module.exports = createFloatingWindowRuntime;
