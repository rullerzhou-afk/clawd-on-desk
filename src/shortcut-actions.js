"use strict";

(function initShortcutActions(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ClawdShortcutActions = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  const SHORTCUT_ACTIONS = Object.freeze({
    togglePet: Object.freeze({
      persistent: true,
      defaultAccelerator: "CommandOrControl+Shift+Alt+C",
      labelKey: "shortcutLabelTogglePet",
    }),
    quickSelectSession: Object.freeze({
      persistent: true,
      defaultAccelerator: null,
      labelKey: "shortcutLabelQuickSelectSession",
      showInTutorial: false,
    }),
    permissionAllow: Object.freeze({
      persistent: false,
      defaultAccelerator: "CommandOrControl+Shift+Y",
      labelKey: "shortcutLabelPermissionAllow",
    }),
    permissionDeny: Object.freeze({
      persistent: false,
      defaultAccelerator: "CommandOrControl+Shift+N",
      labelKey: "shortcutLabelPermissionDeny",
    }),
  });

  const SHORTCUT_ACTION_IDS = Object.freeze(Object.keys(SHORTCUT_ACTIONS));
  const MODIFIER_ORDER = Object.freeze(["CommandOrControl", "Control", "Shift", "Alt"]);
  const MODIFIER_ALIASES = Object.freeze({
    cmdorctrl: "CommandOrControl",
    cmdorcontrol: "CommandOrControl",
    commandorcontrol: "CommandOrControl",
    commandorctrl: "CommandOrControl",
    command: "CommandOrControl",
    cmd: "CommandOrControl",
    // Keep the established shorthand portable while allowing Electron's
    // explicit Control modifier to represent the native ⌃ key on macOS.
    ctrl: "CommandOrControl",
    control: "Control",
    shift: "Shift",
    alt: "Alt",
    option: "Alt",
    opt: "Alt",
  });

  const NAMED_KEY_ALIASES = Object.freeze({
    space: "Space",
    spacebar: "Space",
    tab: "Tab",
    enter: "Enter",
    return: "Enter",
    escape: "Escape",
    esc: "Escape",
    up: "Up",
    arrowup: "Up",
    down: "Down",
    arrowdown: "Down",
    left: "Left",
    arrowleft: "Left",
    right: "Right",
    arrowright: "Right",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    insert: "Insert",
    ins: "Insert",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
  });

  const DANGEROUS_ACCELERATORS = new Set([
    "CommandOrControl+C",
    "CommandOrControl+V",
    "CommandOrControl+X",
    "CommandOrControl+Z",
    "CommandOrControl+A",
    "CommandOrControl+S",
    "CommandOrControl+Q",
    "CommandOrControl+W",
    "CommandOrControl+R",
    "Control+C",
    "Control+V",
    "Control+X",
    "Control+Z",
    "Control+A",
    "Control+S",
    "Control+Q",
    "Control+W",
    "Control+R",
    "Alt+F4",
    "F5",
  ]);

  const DEFAULT_SHORTCUTS = Object.freeze(buildDefaultShortcuts());

  function buildDefaultShortcuts() {
    const out = {};
    for (const actionId of SHORTCUT_ACTION_IDS) {
      out[actionId] = SHORTCUT_ACTIONS[actionId].defaultAccelerator;
    }
    return out;
  }

  function getDefaultShortcuts() {
    return { ...DEFAULT_SHORTCUTS };
  }

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeModifierToken(token) {
    if (typeof token !== "string") return null;
    const key = token.replace(/\s+/g, "").toLowerCase();
    return MODIFIER_ALIASES[key] || null;
  }

  function normalizeAcceleratorKeyToken(token) {
    if (typeof token !== "string") return null;
    const trimmed = token.trim();
    if (!trimmed) return null;
    if (/^[a-z0-9]$/i.test(trimmed)) return trimmed.toUpperCase();
    if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(trimmed)) return trimmed.toUpperCase();
    const named = NAMED_KEY_ALIASES[trimmed.replace(/\s+/g, "").toLowerCase()];
    return named || null;
  }

  function parseAccelerator(value) {
    if (typeof value !== "string") return null;
    const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return null;

    const modifiers = [];
    const modifierSet = new Set();
    let key = null;

    for (const part of parts) {
      const modifier = normalizeModifierToken(part);
      if (modifier) {
        if (modifierSet.has(modifier)) return null;
        modifierSet.add(modifier);
        modifiers.push(modifier);
        continue;
      }
      const normalizedKey = normalizeAcceleratorKeyToken(part);
      if (!normalizedKey || key) return null;
      key = normalizedKey;
    }

    if (!key || modifierSet.size === 0) return null;

    const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifierSet.has(modifier));
    return {
      modifiers: orderedModifiers,
      key,
      accelerator: [...orderedModifiers, key].join("+"),
    };
  }

  function resolveIsMac(options) {
    if (options && typeof options.isMac === "boolean") return options.isMac;
    return typeof process !== "undefined" && process.platform === "darwin";
  }

  function normalizeModifiersForPlatform(modifiers, { isMac = false } = {}) {
    const normalized = [];
    const seen = new Set();
    for (const modifier of modifiers) {
      const platformModifier = !isMac && modifier === "Control"
        ? "CommandOrControl"
        : modifier;
      if (seen.has(platformModifier)) continue;
      seen.add(platformModifier);
      normalized.push(platformModifier);
    }
    return normalized;
  }

  function acceleratorConflictKey(accelerator, options) {
    const parsed = parseAccelerator(accelerator);
    if (!parsed) return null;
    const isMac = resolveIsMac(options);
    const modifiers = new Set(normalizeModifiersForPlatform(parsed.modifiers, { isMac }));
    const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
    return [...orderedModifiers, parsed.key].join("+");
  }

  function acceleratorsConflict(left, right, options) {
    const leftKey = acceleratorConflictKey(left, options);
    const rightKey = acceleratorConflictKey(right, options);
    return leftKey !== null && rightKey !== null && leftKey === rightKey;
  }

  function isDangerousAccelerator(accelerator, options) {
    const platformKey = acceleratorConflictKey(accelerator, options);
    return platformKey !== null && DANGEROUS_ACCELERATORS.has(platformKey);
  }

  function buildShortcutDefaults(defaultsValue) {
    const out = {};
    const base = isPlainObject(defaultsValue) ? defaultsValue : null;
    for (const actionId of SHORTCUT_ACTION_IDS) {
      const fallback = SHORTCUT_ACTIONS[actionId].defaultAccelerator;
      const candidate = base && typeof base[actionId] === "string"
        ? parseAccelerator(base[actionId])
        : null;
      out[actionId] = candidate ? candidate.accelerator : fallback;
    }
    return out;
  }

  function normalizeShortcutValue(value, defaultAccelerator, options) {
    if (value === "" || value === null || value === undefined) return null;
    if (typeof value !== "string") return defaultAccelerator;
    const parsed = parseAccelerator(value);
    if (!parsed) return defaultAccelerator;
    if (isDangerousAccelerator(parsed.accelerator, options)) return defaultAccelerator;
    return parsed.accelerator;
  }

  function normalizeShortcuts(value, defaultsValue, options) {
    const isMac = resolveIsMac(options);
    const platformOptions = { isMac };
    const defaults = buildShortcutDefaults(defaultsValue);
    const raw = isPlainObject(value) ? value : {};
    const normalized = {};

    for (const actionId of SHORTCUT_ACTION_IDS) {
      if (!Object.prototype.hasOwnProperty.call(raw, actionId)) {
        normalized[actionId] = defaults[actionId];
        continue;
      }
      normalized[actionId] = normalizeShortcutValue(
        raw[actionId],
        defaults[actionId],
        platformOptions
      );
    }

    const out = {};
    const taken = new Set();
    const conflictKey = (accelerator) => acceleratorConflictKey(accelerator, platformOptions);
    const isTaken = (accelerator) => {
      const key = conflictKey(accelerator);
      return key !== null && taken.has(key);
    };
    const markTaken = (accelerator) => {
      const key = conflictKey(accelerator);
      if (key !== null) taken.add(key);
    };

    for (const actionId of SHORTCUT_ACTION_IDS) {
      if (acceleratorsConflict(normalized[actionId], defaults[actionId], platformOptions)) {
        out[actionId] = normalized[actionId];
        markTaken(out[actionId]);
      }
    }

    for (const actionId of SHORTCUT_ACTION_IDS) {
      if (Object.prototype.hasOwnProperty.call(out, actionId)) continue;
      const candidate = normalized[actionId];
      if (candidate === null) {
        out[actionId] = null;
        continue;
      }
      if (isTaken(candidate)) {
        const fallback = defaults[actionId];
        if (fallback !== null && !isTaken(fallback)) {
          out[actionId] = fallback;
          markTaken(fallback);
        } else {
          out[actionId] = null;
        }
        continue;
      }
      out[actionId] = candidate;
      markTaken(candidate);
    }

    return out;
  }

  function normalizeKey(key, code) {
    const rawKey = typeof key === "string" ? key : "";
    const rawCode = typeof code === "string" ? code : "";
    const loweredKey = rawKey.trim().toLowerCase();
    const loweredCode = rawCode.trim().toLowerCase();

    if (
      loweredKey === "control"
      || loweredKey === "shift"
      || loweredKey === "alt"
      || loweredKey === "meta"
      || loweredKey === "os"
      || loweredKey === "super"
      || loweredCode === "controlleft"
      || loweredCode === "controlright"
      || loweredCode === "shiftleft"
      || loweredCode === "shiftright"
      || loweredCode === "altleft"
      || loweredCode === "altright"
      || loweredCode === "metaleft"
      || loweredCode === "metaright"
    ) {
      return null;
    }

    if (/^key[a-z]$/i.test(rawCode)) return rawCode.slice(-1).toUpperCase();
    if (/^digit[0-9]$/i.test(rawCode)) return rawCode.slice(-1);
    if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(rawKey)) return rawKey.toUpperCase();
    if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(rawCode)) return rawCode.toUpperCase();
    if (rawKey.length === 1 && /^[a-z0-9]$/i.test(rawKey)) return rawKey.toUpperCase();
    if (rawKey === " " || loweredCode === "space") return "Space";

    const named = NAMED_KEY_ALIASES[loweredKey] || NAMED_KEY_ALIASES[loweredCode];
    return named || null;
  }

  function buildAcceleratorFromEvent(input, { isMac = false } = {}) {
    const key = input && input.key;
    const code = input && input.code;
    const ctrlKey = !!(input && (input.ctrlKey || input.control));
    const metaKey = !!(input && input.metaKey);
    const altKey = !!(input && input.altKey);
    const shiftKey = !!(input && input.shiftKey);

    if (
      key === "Escape"
      && !ctrlKey
      && !metaKey
      && !altKey
      && !shiftKey
    ) {
      return { action: "cancel" };
    }

    const mods = [];
    if (isMac) {
      if (metaKey) mods.push("CommandOrControl");
      if (ctrlKey) mods.push("Control");
    } else if (ctrlKey) {
      mods.push("CommandOrControl");
    }
    if (shiftKey) mods.push("Shift");
    if (altKey) mods.push("Alt");

    const nonMod = normalizeKey(key, code);
    if (!nonMod) return { action: "pending", modifiers: mods };

    if (mods.length === 0) {
      return { action: "reject", reason: "must include modifier" };
    }

    return {
      action: "commit",
      accelerator: [...mods, nonMod].join("+"),
    };
  }

  function formatAcceleratorPartial(modifiers, { isMac = false } = {}) {
    if (!Array.isArray(modifiers) || modifiers.length === 0) return "";
    const displayModifiers = normalizeModifiersForPlatform(modifiers, { isMac });
    const labels = displayModifiers.map((modifier) => {
      if (modifier === "CommandOrControl") return isMac ? "⌘" : "Ctrl";
      if (modifier === "Control") return isMac ? "⌃" : "Ctrl";
      if (modifier === "Shift") return isMac ? "⇧" : "Shift";
      if (modifier === "Alt") return isMac ? "⌥" : "Alt";
      return modifier;
    });
    return isMac ? labels.join("") + "…" : labels.join("+") + "+…";
  }

  function formatAcceleratorLabel(
    accelerator,
    { isMac = false, unassignedLabel = "— unassigned —" } = {}
  ) {
    if (!accelerator) return unassignedLabel;
    const parsed = parseAccelerator(accelerator);
    if (!parsed) return accelerator;

    const displayModifiers = normalizeModifiersForPlatform(parsed.modifiers, { isMac });
    const displayParts = displayModifiers.map((modifier) => {
      if (modifier === "CommandOrControl") return isMac ? "⌘" : "Ctrl";
      if (modifier === "Control") return isMac ? "⌃" : "Ctrl";
      if (modifier === "Shift") return isMac ? "⇧" : "Shift";
      if (modifier === "Alt") return isMac ? "⌥" : "Alt";
      return modifier;
    });

    const keyLabelMap = {
      Escape: isMac ? "Esc" : "Esc",
      Up: isMac ? "↑" : "Up",
      Down: isMac ? "↓" : "Down",
      Left: isMac ? "←" : "Left",
      Right: isMac ? "→" : "Right",
    };
    displayParts.push(keyLabelMap[parsed.key] || parsed.key);
    return isMac ? displayParts.join("") : displayParts.join("+");
  }

  function validateShortcutMapShape(value) {
    if (!isPlainObject(value)) {
      return { status: "error", message: "shortcuts must be a plain object" };
    }
    for (const key of Object.keys(value)) {
      if (!SHORTCUT_ACTIONS[key]) {
        return { status: "error", message: `shortcuts contains unknown action: ${key}` };
      }
      const entry = value[key];
      if (entry !== null && typeof entry !== "string") {
        return {
          status: "error",
          message: `shortcuts.${key} must be a string or null`,
        };
      }
    }
    return { status: "ok" };
  }

  return {
    SHORTCUT_ACTIONS,
    SHORTCUT_ACTION_IDS,
    DANGEROUS_ACCELERATORS,
    getDefaultShortcuts,
    parseAccelerator,
    normalizeKey,
    buildAcceleratorFromEvent,
    formatAcceleratorLabel,
    formatAcceleratorPartial,
    normalizeShortcuts,
    isDangerousAccelerator,
    acceleratorConflictKey,
    acceleratorsConflict,
    validateShortcutMapShape,
  };
});
