"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MAIN_JS = path.join(__dirname, "..", "src", "main.js");

function readMain() {
  return fs.readFileSync(MAIN_JS, "utf8");
}

test("second-instance relaunch exits hidden state through the pet visibility state machine", () => {
  const source = readMain();
  const start = source.indexOf('app.on("second-instance"');
  const end = source.indexOf("codexPetMain.enqueueImportUrlsFromArgv(commandLine);", start);
  assert.ok(start >= 0 && end > start, "second-instance handler should be present");

  const handler = source.slice(start, end);
  assert.match(
    handler,
    /if \(petWindowRuntime\.isPetHidden\(\)\) \{\s*prepManualPetVisibility\(\);\s*petWindowRuntime\.setPetHidden\(false\);\s*\} else \{/,
    "hidden relaunch must use setPetHidden(false), not bare showInactive()"
  );
  assert.ok(
    handler.indexOf("prepManualPetVisibility()") < handler.indexOf("petWindowRuntime.setPetHidden(false)"),
    "hidden relaunch should use the shared manual visibility prep before showing the pet"
  );
  assert.ok(
    handler.indexOf("petWindowRuntime.setPetHidden(false)") < handler.indexOf("win.showInactive()"),
    "hidden-state recovery should run before the visible-window fast path"
  );
});

test("hitWin renderer crash clears transient interaction state before reloading", () => {
  const source = readMain();
  const start = source.indexOf("onRenderProcessGone: (details, ownedHitWin) => {");
  assert.ok(start >= 0, "hitWin render-process-gone handler should be present");

  const reload = 'petWindowRuntime.reloadWindowWebContents(ownedHitWin, { crashKey: "hitWin", details });';
  const end = source.indexOf(reload, start) + reload.length;
  const handler = source.slice(start, end);

  assert.ok(handler.includes("petWindowRuntime.setDragLocked(false);"));
  assert.ok(handler.includes("petWindowRuntime.clearDragSnapshot();"));
  assert.ok(handler.includes("idlePaused = false;"));
  assert.ok(handler.includes("mouseOverPet = false;"));
  assert.ok(handler.indexOf("petWindowRuntime.setDragLocked(false);") < handler.indexOf(reload));
  assert.ok(handler.indexOf("petWindowRuntime.clearDragSnapshot();") < handler.indexOf(reload));
  assert.ok(handler.indexOf("idlePaused = false;") < handler.indexOf(reload));
  assert.ok(handler.indexOf("mouseOverPet = false;") < handler.indexOf(reload));
});
