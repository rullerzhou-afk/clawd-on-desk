"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  SHORTCUT_ACTIONS,
  SHORTCUT_ACTION_IDS,
  DANGEROUS_ACCELERATORS,
  getDefaultShortcuts,
  parseAccelerator,
  normalizeKey,
  buildAcceleratorFromEvent,
  formatAcceleratorLabel,
  normalizeShortcuts,
  isDangerousAccelerator,
  acceleratorsConflict,
  validateShortcutMapShape,
} = require("../src/shortcut-actions");

describe("shortcut-actions metadata", () => {
  it("exposes all known shortcut action ids", () => {
    assert.deepStrictEqual(SHORTCUT_ACTION_IDS, [
      "togglePet",
      "quickSelectSession",
      "permissionAllow",
      "permissionDeny",
    ]);
    assert.strictEqual(SHORTCUT_ACTIONS.togglePet.persistent, true);
    assert.strictEqual(SHORTCUT_ACTIONS.quickSelectSession.persistent, true);
    assert.strictEqual(SHORTCUT_ACTIONS.quickSelectSession.defaultAccelerator, null);
    assert.strictEqual(SHORTCUT_ACTIONS.quickSelectSession.showInTutorial, false);
    assert.strictEqual(SHORTCUT_ACTIONS.permissionAllow.persistent, false);
    assert.strictEqual(SHORTCUT_ACTIONS.permissionDeny.persistent, false);
  });

  it("builds fresh default shortcut maps", () => {
    const a = getDefaultShortcuts();
    const b = getDefaultShortcuts();
    assert.notStrictEqual(a, b);
    assert.deepStrictEqual(a, {
      togglePet: "CommandOrControl+Shift+Alt+C",
      quickSelectSession: null,
      permissionAllow: "CommandOrControl+Shift+Y",
      permissionDeny: "CommandOrControl+Shift+N",
    });
  });
});

describe("parseAccelerator", () => {
  it("normalizes accepted accelerators into canonical order", () => {
    assert.deepStrictEqual(parseAccelerator("Alt+Ctrl+y"), {
      modifiers: ["CommandOrControl", "Alt"],
      key: "Y",
      accelerator: "CommandOrControl+Alt+Y",
    });
    assert.deepStrictEqual(parseAccelerator("Shift+Alt+CommandOrControl+C"), {
      modifiers: ["CommandOrControl", "Shift", "Alt"],
      key: "C",
      accelerator: "CommandOrControl+Shift+Alt+C",
    });
    assert.deepStrictEqual(parseAccelerator("Shift+Control+K"), {
      modifiers: ["Control", "Shift"],
      key: "K",
      accelerator: "Control+Shift+K",
    });
    assert.deepStrictEqual(parseAccelerator("Control+CommandOrControl+K"), {
      modifiers: ["CommandOrControl", "Control"],
      key: "K",
      accelerator: "CommandOrControl+Control+K",
    });
  });

  it("accepts named keys and function keys", () => {
    assert.strictEqual(parseAccelerator("Ctrl+Space").accelerator, "CommandOrControl+Space");
    assert.strictEqual(parseAccelerator("Alt+F4").accelerator, "Alt+F4");
    assert.strictEqual(parseAccelerator("Shift+ArrowUp").accelerator, "Shift+Up");
  });

  it("rejects invalid accelerator strings", () => {
    for (const sample of [
      "",
      "A",
      "Ctrl+Shift",
      "Ctrl+A+B",
      "Super+K",
      "Ctrl+Meta+K",
      "Ctrl++",
      "Ctrl+Shift+Space+Tab",
    ]) {
      assert.strictEqual(parseAccelerator(sample), null, sample);
    }
  });
});

describe("dangerous accelerator blacklist", () => {
  it("flags reserved global shortcuts", () => {
    assert.ok(DANGEROUS_ACCELERATORS.has("CommandOrControl+C"));
    assert.ok(isDangerousAccelerator("CommandOrControl+S"));
    assert.ok(isDangerousAccelerator("Control+C"));
    assert.ok(isDangerousAccelerator("Control+S"));
    assert.ok(isDangerousAccelerator("Alt+F4"));
    assert.strictEqual(isDangerousAccelerator("CommandOrControl+Shift+Y"), false);
  });

  it("folds equivalent Control tokens before checking non-macOS shortcuts", () => {
    assert.strictEqual(
      isDangerousAccelerator("CommandOrControl+Control+C", { isMac: false }),
      true
    );
    assert.strictEqual(
      isDangerousAccelerator("CommandOrControl+Control+C", { isMac: true }),
      false
    );
  });
});

describe("accelerator conflict equivalence", () => {
  it("keeps native Control distinct from Command on macOS", () => {
    assert.strictEqual(
      acceleratorsConflict("Control+Shift+K", "CommandOrControl+Shift+K", { isMac: true }),
      false
    );
  });

  it("treats Control and CommandOrControl as the same key off macOS", () => {
    assert.strictEqual(
      acceleratorsConflict("Control+Shift+K", "CommandOrControl+Shift+K", { isMac: false }),
      true
    );
  });
});

describe("normalizeKey", () => {
  it("maps letters, digits, function keys, and named keys", () => {
    assert.strictEqual(normalizeKey("a", "KeyA"), "A");
    assert.strictEqual(normalizeKey("7", "Digit7"), "7");
    assert.strictEqual(normalizeKey("F12", "F12"), "F12");
    assert.strictEqual(normalizeKey(" ", "Space"), "Space");
    assert.strictEqual(normalizeKey("ArrowLeft", "ArrowLeft"), "Left");
    assert.strictEqual(normalizeKey("Escape", "Escape"), "Escape");
  });

  it("returns null for pure modifier keys", () => {
    assert.strictEqual(normalizeKey("Control", "ControlLeft"), null);
    assert.strictEqual(normalizeKey("Shift", "ShiftRight"), null);
    assert.strictEqual(normalizeKey("Meta", "MetaLeft"), null);
  });
});

describe("buildAcceleratorFromEvent", () => {
  it("cancels on bare escape", () => {
    assert.deepStrictEqual(
      buildAcceleratorFromEvent({ key: "Escape", code: "Escape" }),
      { action: "cancel" }
    );
  });

  it("waits for a non-modifier key and reports held modifiers for live preview", () => {
    assert.deepStrictEqual(
      buildAcceleratorFromEvent({ key: "Shift", code: "ShiftLeft", shiftKey: true }),
      { action: "pending", modifiers: ["Shift"] }
    );
    assert.deepStrictEqual(
      buildAcceleratorFromEvent({
        key: "Control",
        code: "ControlLeft",
        ctrlKey: true,
        shiftKey: true,
      }),
      { action: "pending", modifiers: ["CommandOrControl", "Shift"] }
    );
    assert.deepStrictEqual(
      buildAcceleratorFromEvent({
        key: "Control",
        code: "ControlLeft",
        ctrlKey: true,
        shiftKey: true,
      }, { isMac: true }),
      { action: "pending", modifiers: ["Control", "Shift"] }
    );
    assert.deepStrictEqual(
      buildAcceleratorFromEvent({ key: "Alt", code: "AltLeft" }),
      { action: "pending", modifiers: [] }
    );
  });

  it("rejects accelerators without modifiers", () => {
    assert.deepStrictEqual(
      buildAcceleratorFromEvent({ key: "a", code: "KeyA" }),
      { action: "reject", reason: "must include modifier" }
    );
  });

  it("formats live partial previews for modifier-only state", () => {
    const { formatAcceleratorPartial } = require("../src/shortcut-actions");
    assert.strictEqual(formatAcceleratorPartial([]), "");
    assert.strictEqual(
      formatAcceleratorPartial(["CommandOrControl", "Shift"]),
      "Ctrl+Shift+…"
    );
    assert.strictEqual(
      formatAcceleratorPartial(["CommandOrControl", "Shift"], { isMac: true }),
      "⌘⇧…"
    );
    assert.strictEqual(
      formatAcceleratorPartial(["CommandOrControl", "Alt"]),
      "Ctrl+Alt+…"
    );
    assert.strictEqual(
      formatAcceleratorPartial(["Control", "Shift"], { isMac: true }),
      "⌃⇧…"
    );
    assert.strictEqual(
      formatAcceleratorPartial(["CommandOrControl", "Control", "Shift"], { isMac: false }),
      "Ctrl+Shift+…"
    );
  });

  it("builds canonical accelerators from keyboard state", () => {
    assert.deepStrictEqual(
      buildAcceleratorFromEvent({
        key: "y",
        code: "KeyY",
        ctrlKey: true,
        shiftKey: true,
      }),
      { action: "commit", accelerator: "CommandOrControl+Shift+Y" }
    );
    assert.deepStrictEqual(
      buildAcceleratorFromEvent({
        key: "c",
        code: "KeyC",
        metaKey: true,
        shiftKey: true,
        altKey: true,
      }, { isMac: true }),
      { action: "commit", accelerator: "CommandOrControl+Shift+Alt+C" }
    );
    assert.deepStrictEqual(
      buildAcceleratorFromEvent({
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        shiftKey: true,
      }, { isMac: true }),
      { action: "commit", accelerator: "Control+Shift+K" }
    );
    assert.deepStrictEqual(
      buildAcceleratorFromEvent({
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        metaKey: true,
      }, { isMac: true }),
      { action: "commit", accelerator: "CommandOrControl+Control+K" }
    );
  });
});

describe("formatAcceleratorLabel", () => {
  it("formats labels for Windows/Linux", () => {
    assert.strictEqual(
      formatAcceleratorLabel("CommandOrControl+Shift+Alt+C"),
      "Ctrl+Shift+Alt+C"
    );
    assert.strictEqual(
      formatAcceleratorLabel("CommandOrControl+Control+K", { isMac: false }),
      "Ctrl+K"
    );
    assert.strictEqual(formatAcceleratorLabel(null), "— unassigned —");
  });

  it("formats labels for macOS", () => {
    assert.strictEqual(
      formatAcceleratorLabel("CommandOrControl+Shift+Alt+C", { isMac: true }),
      "⌘⇧⌥C"
    );
    assert.strictEqual(
      formatAcceleratorLabel("Shift+ArrowUp", { isMac: true }),
      "⇧↑"
    );
    assert.strictEqual(
      formatAcceleratorLabel("Control+Shift+K", { isMac: true }),
      "⌃⇧K"
    );
  });
});

describe("normalizeShortcuts", () => {
  it("preserves an explicit native Control binding on macOS", () => {
    assert.strictEqual(
      normalizeShortcuts(
        { togglePet: "Control+Shift+K" },
        getDefaultShortcuts(),
        { isMac: true }
      ).togglePet,
      "Control+Shift+K"
    );
  });

  it("preserves the explicit token while comparing it by platform semantics", () => {
    assert.strictEqual(
      normalizeShortcuts(
        { togglePet: "Control+Shift+K" },
        getDefaultShortcuts(),
        { isMac: false }
      ).togglePet,
      "Control+Shift+K"
    );
  });

  it("preserves an explicit Control token when it is equivalent to the default off macOS", () => {
    assert.strictEqual(
      normalizeShortcuts(
        { togglePet: "Control+Shift+Alt+C" },
        getDefaultShortcuts(),
        { isMac: false }
      ).togglePet,
      "Control+Shift+Alt+C"
    );
  });

  it("fills missing keys from defaults and drops unknown keys", () => {
    assert.deepStrictEqual(
      normalizeShortcuts({ togglePet: "Ctrl+K", bogus: "Ctrl+J" }, getDefaultShortcuts()),
      {
        togglePet: "CommandOrControl+K",
        quickSelectSession: null,
        permissionAllow: "CommandOrControl+Shift+Y",
        permissionDeny: "CommandOrControl+Shift+N",
      }
    );
  });

  it("treats empty or null values as unassigned", () => {
    assert.deepStrictEqual(
      normalizeShortcuts({
        togglePet: "",
        permissionAllow: null,
        permissionDeny: undefined,
      }, getDefaultShortcuts()),
      {
        togglePet: null,
        quickSelectSession: null,
        permissionAllow: null,
        permissionDeny: null,
      }
    );
  });

  it("falls back to defaults on invalid or dangerous values", () => {
    assert.deepStrictEqual(
      normalizeShortcuts({
        togglePet: "Ctrl+C",
        permissionAllow: "totally invalid",
        permissionDeny: [],
      }, getDefaultShortcuts()),
      getDefaultShortcuts()
    );
  });

  it("rejects dangerous shortcuts after non-macOS modifier folding", () => {
    assert.deepStrictEqual(
      normalizeShortcuts({
        togglePet: "CommandOrControl+Control+C",
      }, getDefaultShortcuts(), { isMac: false }),
      getDefaultShortcuts()
    );
  });

  it("uses default-priority de-duplication on load", () => {
    assert.deepStrictEqual(
      normalizeShortcuts({
        togglePet: "Ctrl+K",
        permissionAllow: "Ctrl+K",
        permissionDeny: "Ctrl+Shift+Y",
      }, getDefaultShortcuts()),
      {
        togglePet: "CommandOrControl+K",
        quickSelectSession: null,
        permissionAllow: "CommandOrControl+Shift+Y",
        permissionDeny: "CommandOrControl+Shift+N",
      }
    );
  });

  it("de-duplicates physically equivalent Control bindings off macOS", () => {
    assert.deepStrictEqual(
      normalizeShortcuts({
        togglePet: "Control+Shift+K",
        permissionAllow: "CommandOrControl+Shift+K",
      }, getDefaultShortcuts(), { isMac: false }),
      {
        togglePet: "Control+Shift+K",
        quickSelectSession: null,
        permissionAllow: "CommandOrControl+Shift+Y",
        permissionDeny: "CommandOrControl+Shift+N",
      }
    );
  });

  it("keeps the same Control bindings distinct on macOS", () => {
    assert.deepStrictEqual(
      normalizeShortcuts({
        togglePet: "Control+Shift+K",
        quickSelectSession: null,
        permissionAllow: "CommandOrControl+Shift+K",
      }, getDefaultShortcuts(), { isMac: true }),
      {
        togglePet: "Control+Shift+K",
        quickSelectSession: null,
        permissionAllow: "CommandOrControl+Shift+K",
        permissionDeny: "CommandOrControl+Shift+N",
      }
    );
  });
});

describe("validateShortcutMapShape", () => {
  it("accepts plain objects with known keys and string/null values", () => {
    assert.deepStrictEqual(
      validateShortcutMapShape({
        togglePet: "CommandOrControl+Shift+Alt+C",
        permissionAllow: null,
      }),
      { status: "ok" }
    );
  });

  it("rejects unknown keys and non-string values", () => {
    assert.strictEqual(validateShortcutMapShape(null).status, "error");
    assert.strictEqual(
      validateShortcutMapShape({ nope: "Ctrl+K" }).status,
      "error"
    );
    assert.strictEqual(
      validateShortcutMapShape({ togglePet: 42 }).status,
      "error"
    );
  });
});
