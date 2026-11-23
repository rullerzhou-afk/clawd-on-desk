"use strict";

// Drives both free() paths of the live X11 cursor query inside real Electron:
// every successful xcb_query_pointer reply, and the error a query against a
// well-formed XID that names no window gets back (BadWindow). Freeing either
// with the wrong allocator's free() kills the process here.

const { app } = require("electron");
const { loadXcbPointerBindings, createX11PointerQuery } = require("../../src/linux-x11-cursor");

const ROUNDS = 200;
const MISSING_WINDOW = 0x1ffffffe; // 29-bit max minus one: valid shape, no such window

app.whenReady().then(() => {
  let bindings;
  try {
    bindings = loadXcbPointerBindings(require("koffi"));
  } catch (error) {
    console.log(`LINUX_X11_CURSOR_UNAVAILABLE ${error && error.message}`);
    app.exit(0);
    return;
  }

  // Success path: one reply freed per query.
  const errors = [];
  const query = createX11PointerQuery({ bindings, onError: (error) => errors.push(error.message) });
  let points = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const point = query();
    if (point && Number.isInteger(point.x) && Number.isInteger(point.y)) points++;
  }
  if (points !== ROUNDS || errors.length) {
    console.error(`points=${points} errors=${JSON.stringify(errors)}`);
    app.exit(1);
    return;
  }

  // Error path: BadWindow comes back as an error that must be freed.
  const { connection } = bindings.connect(null);
  let refused = 0;
  try {
    for (let i = 0; i < ROUNDS; i++) {
      if (bindings.queryPointer(connection, MISSING_WINDOW) === null) refused++;
    }
    const connectionError = bindings.hasError(connection);
    if (refused !== ROUNDS || connectionError) {
      console.error(`refused=${refused} connectionError=${connectionError}`);
      app.exit(1);
      return;
    }
  } finally {
    bindings.disconnect(connection);
  }

  console.log("LINUX_X11_CURSOR_ELECTRON_OK");
  app.exit(0);
});
