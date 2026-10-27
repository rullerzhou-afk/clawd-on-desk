"use strict";

// Drives the refused-write path of the WM_HINTS hint inside real Electron:
// a well-formed XID that names no window makes the X server answer BadWindow,
// so xcb_request_check() hands back an error that freeError() must release.
// Freeing it with the wrong allocator's free() kills the process here.

const { app } = require("electron");
const { createLinuxX11InputHint } = require("../../src/linux-x11-input-hint");

const ROUNDS = 200;

app.whenReady().then(() => {
  const errors = [];
  const hint = createLinuxX11InputHint({
    isLinuxX11: true,
    onError: (error) => errors.push(error.message),
  });
  if (!hint.available) {
    console.log(`LINUX_X11_INPUT_HINT_UNAVAILABLE ${errors[0] || ""}`);
    app.exit(0);
    return;
  }
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x1ffffffen); // 29-bit max minus one: valid shape, no such window
  const missingWindow = { getNativeWindowHandle: () => handle, isDestroyed: () => false };
  let refused = 0;
  for (let i = 0; i < ROUNDS; i++) {
    if (hint.applyNoInputHint(missingWindow) === false) refused++;
  }
  const badWindow = errors.filter((message) => message === "X11 WM_HINTS write failed (error code 3)").length;
  if (refused !== ROUNDS || badWindow !== ROUNDS) {
    console.error(`refused=${refused} badWindow=${badWindow} first=${errors[0]}`);
    app.exit(1);
    return;
  }
  console.log("LINUX_X11_INPUT_HINT_ELECTRON_OK");
  app.exit(0);
});
