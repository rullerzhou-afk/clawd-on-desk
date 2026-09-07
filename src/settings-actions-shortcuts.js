"use strict";

const {
  SHORTCUT_ACTIONS,
  SHORTCUT_ACTION_IDS,
  getDefaultShortcuts,
  parseAccelerator,
  isDangerousAccelerator,
  acceleratorsConflict,
} = require("./shortcut-actions");

function getShortcutPlatformOptions(deps) {
  const platform = deps && typeof deps.platform === "string" ? deps.platform : process.platform;
  return { isMac: platform === "darwin" };
}

function getShortcutSnapshot(snapshot) {
  const defaults = getDefaultShortcuts();
  if (!snapshot || !snapshot.shortcuts || typeof snapshot.shortcuts !== "object") {
    return defaults;
  }
  return { ...defaults, ...snapshot.shortcuts };
}

function getPersistentShortcutHandler(actionId, deps) {
  const handlers = deps && deps.shortcutHandlers;
  const handler = handlers && handlers[actionId];
  if (typeof handler !== "function") return null;
  return handler;
}

function tryRegisterGlobalShortcut(globalShortcutModule, accelerator, handler) {
  if (!globalShortcutModule || typeof globalShortcutModule.register !== "function") return false;
  try {
    return !!globalShortcutModule.register(accelerator, handler);
  } catch {
    return false;
  }
}

function tryUnregisterGlobalShortcut(globalShortcutModule, accelerator) {
  if (!globalShortcutModule || typeof globalShortcutModule.unregister !== "function") {
    return { ok: false };
  }
  try {
    globalShortcutModule.unregister(accelerator);
  } catch {
    return { ok: false };
  }
  if (typeof globalShortcutModule.isRegistered === "function") {
    try {
      if (globalShortcutModule.isRegistered(accelerator)) {
        return { ok: false };
      }
    } catch {
      return { ok: false };
    }
  }
  return { ok: true };
}

function getShortcutFailure(actionId, deps) {
  if (!deps || typeof deps.getShortcutFailure !== "function") return null;
  return deps.getShortcutFailure(actionId) || null;
}

function clearShortcutFailure(actionId, deps) {
  if (deps && typeof deps.clearShortcutFailure === "function") {
    try { deps.clearShortcutFailure(actionId); } catch {}
  }
}

function validateShortcutBinding(actionId, accelerator, deps) {
  const meta = SHORTCUT_ACTIONS[actionId];
  if (!meta) {
    return { status: "error", message: "unknown shortcut action" };
  }

  if (accelerator === null) {
    return { status: "ok", accelerator: null };
  }
  if (typeof accelerator !== "string") {
    return { status: "error", message: "invalid accelerator format" };
  }

  const parsed = parseAccelerator(accelerator);
  if (!parsed) {
    return { status: "error", message: "invalid accelerator format" };
  }
  const platformOptions = getShortcutPlatformOptions(deps);
  if (isDangerousAccelerator(parsed.accelerator, platformOptions)) {
    return { status: "error", message: "reserved accelerator" };
  }

  const shortcuts = getShortcutSnapshot(deps && deps.snapshot);
  for (const otherActionId of SHORTCUT_ACTION_IDS) {
    if (otherActionId === actionId) continue;
    if (acceleratorsConflict(shortcuts[otherActionId], parsed.accelerator, platformOptions)) {
      return {
        status: "error",
        message: `conflict: already bound to ${otherActionId}`,
      };
    }
  }

  return { status: "ok", accelerator: parsed.accelerator };
}

function applyPersistentShortcutChange(actionId, oldAccelerator, newAccelerator, deps, { allowRetrySame = false } = {}) {
  const globalShortcutModule = deps && deps.globalShortcut;
  const handler = getPersistentShortcutHandler(actionId, deps);
  if (!globalShortcutModule || typeof globalShortcutModule.register !== "function") {
    return {
      status: "error",
      message: "registerShortcut requires globalShortcut dep",
    };
  }
  if (!handler) {
    return {
      status: "error",
      message: `registerShortcut missing handler for ${actionId}`,
    };
  }

  if (oldAccelerator === newAccelerator) {
    if (!allowRetrySame || !newAccelerator) {
      clearShortcutFailure(actionId, deps);
      return { status: "ok", noop: true };
    }
    let alreadyRegistered = false;
    if (typeof globalShortcutModule.isRegistered === "function") {
      try {
        alreadyRegistered = !!globalShortcutModule.isRegistered(newAccelerator);
      } catch {
        alreadyRegistered = false;
      }
    }
    if (alreadyRegistered) {
      clearShortcutFailure(actionId, deps);
      return { status: "ok", noop: true };
    }
    const retryOk = tryRegisterGlobalShortcut(globalShortcutModule, newAccelerator, handler);
    if (!retryOk) {
      return { status: "error", message: "system conflict: accelerator is in use" };
    }
    clearShortcutFailure(actionId, deps);
    return { status: "ok", noop: true };
  }

  if (newAccelerator !== null) {
    const ok = tryRegisterGlobalShortcut(globalShortcutModule, newAccelerator, handler);
    if (!ok) {
      return { status: "error", message: "system conflict: accelerator is in use" };
    }
  }

  if (oldAccelerator !== null) {
    const unregistered = tryUnregisterGlobalShortcut(globalShortcutModule, oldAccelerator);
    if (!unregistered.ok) {
      if (newAccelerator !== null) {
        try { globalShortcutModule.unregister(newAccelerator); } catch {}
      }
      return {
        status: "error",
        message: "unregister of old accelerator failed, rolled back",
      };
    }
  }

  clearShortcutFailure(actionId, deps);
  return { status: "ok" };
}

function registerShortcut(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "registerShortcut payload must be an object" };
  }
  const { actionId } = payload;
  if (typeof actionId !== "string" || !SHORTCUT_ACTIONS[actionId]) {
    return { status: "error", message: "unknown shortcut action" };
  }

  const accelerator = Object.prototype.hasOwnProperty.call(payload, "accelerator")
    ? payload.accelerator
    : undefined;
  const validated = validateShortcutBinding(actionId, accelerator, deps);
  if (validated.status !== "ok") return validated;

  const shortcuts = getShortcutSnapshot(deps && deps.snapshot);
  const currentAccelerator = shortcuts[actionId] ?? null;
  const nextAccelerator = validated.accelerator;
  const currentFailure = getShortcutFailure(actionId, deps);

  if (currentAccelerator === nextAccelerator) {
    if (SHORTCUT_ACTIONS[actionId].persistent && currentFailure) {
      return applyPersistentShortcutChange(
        actionId,
        currentAccelerator,
        nextAccelerator,
        deps,
        { allowRetrySame: true }
      );
    }
    return { status: "ok", noop: true };
  }

  // On Windows/Linux, Control and CommandOrControl address the same physical
  // key. Treat an alias-only re-recording as a no-op so Electron does not reject
  // the new spelling while the equivalent old accelerator is still registered.
  if (acceleratorsConflict(
    currentAccelerator,
    nextAccelerator,
    getShortcutPlatformOptions(deps)
  )) {
    if (SHORTCUT_ACTIONS[actionId].persistent && currentFailure) {
      return applyPersistentShortcutChange(
        actionId,
        currentAccelerator,
        currentAccelerator,
        deps,
        { allowRetrySame: true }
      );
    }
    return { status: "ok", noop: true };
  }

  if (SHORTCUT_ACTIONS[actionId].persistent) {
    const result = applyPersistentShortcutChange(
      actionId,
      currentAccelerator,
      nextAccelerator,
      deps
    );
    if (result.status !== "ok") return result;
  }

  return {
    status: "ok",
    commit: {
      shortcuts: { ...shortcuts, [actionId]: nextAccelerator },
    },
  };
}

function resetShortcut(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "resetShortcut payload must be an object" };
  }
  const { actionId } = payload;
  if (typeof actionId !== "string" || !SHORTCUT_ACTIONS[actionId]) {
    return { status: "error", message: "unknown shortcut action" };
  }
  return registerShortcut({
    actionId,
    accelerator: SHORTCUT_ACTIONS[actionId].defaultAccelerator,
  }, deps);
}

function rollbackAppliedShortcutChanges(appliedChanges, deps) {
  const globalShortcutModule = deps && deps.globalShortcut;
  if (!globalShortcutModule) return;
  // Unwind in reverse order for symmetry: new-first applied (register new ->
  // unregister old), so rollback is (unregister new -> re-register old).
  for (let i = appliedChanges.length - 1; i >= 0; i--) {
    const change = appliedChanges[i];
    const handler = getPersistentShortcutHandler(change.actionId, deps);
    if (change.newAccelerator !== null) {
      try { globalShortcutModule.unregister(change.newAccelerator); } catch {}
    }
    if (change.oldAccelerator !== null && handler) {
      try { globalShortcutModule.register(change.oldAccelerator, handler); } catch {}
    }
  }
}

function resetAllShortcuts(_payload, deps) {
  const currentShortcuts = getShortcutSnapshot(deps && deps.snapshot);
  const targetShortcuts = getDefaultShortcuts();

  const seen = new Set();
  for (const actionId of SHORTCUT_ACTION_IDS) {
    const validated = validateShortcutBinding(actionId, targetShortcuts[actionId], {
      ...deps,
      snapshot: { ...(deps && deps.snapshot), shortcuts: {} },
    });
    if (validated.status !== "ok") return validated;
    if (validated.accelerator !== null) {
      if (seen.has(validated.accelerator)) {
        return { status: "error", message: `conflict: already bound to ${actionId}` };
      }
      seen.add(validated.accelerator);
    }
  }

  // Track successfully applied persistent changes so a later action failure
  // restores every earlier registration before prefs are allowed to commit.
  const appliedChanges = [];
  for (const actionId of SHORTCUT_ACTION_IDS) {
    const meta = SHORTCUT_ACTIONS[actionId];
    if (!meta.persistent) continue;
    const oldAccelerator = currentShortcuts[actionId] ?? null;
    const newAccelerator = targetShortcuts[actionId] ?? null;
    const currentFailure = getShortcutFailure(actionId, deps);
    const result = applyPersistentShortcutChange(
      actionId,
      oldAccelerator,
      newAccelerator,
      deps,
      { allowRetrySame: !!currentFailure }
    );
    if (result.status !== "ok") {
      rollbackAppliedShortcutChanges(appliedChanges, deps);
      return {
        status: "error",
        message: `system conflict on ${actionId}: accelerator in use`,
      };
    }
    if (!result.noop) {
      appliedChanges.push({ actionId, oldAccelerator, newAccelerator });
    }
  }

  if (JSON.stringify(currentShortcuts) === JSON.stringify(targetShortcuts)) {
    return { status: "ok", noop: true };
  }
  return { status: "ok", commit: { shortcuts: targetShortcuts } };
}

module.exports = {
  registerShortcut,
  resetShortcut,
  resetAllShortcuts,
};
