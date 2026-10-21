"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  loadXcbPointerBindings,
  createX11PointerQuery,
  physicalToDipPoint,
  installLinuxX11CursorFallback,
} = require("../src/linux-x11-cursor");

// Two 1920x1080 panels side by side: left at 200% (960x540 DIP), right at 100%.
// X11 lays them out in physical pixels; Electron places the DIP bounds edge to
// edge, so the right panel starts at DIP x=960 but physical x=1920.
const MIXED_DISPLAYS = [
  { bounds: { x: 0, y: 0, width: 960, height: 540 }, scaleFactor: 2, nativeOrigin: { x: 0, y: 0 } },
  { bounds: { x: 960, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, nativeOrigin: { x: 1920, y: 0 } },
];

// Electron 41's X11 screenToDipPoint: GetDisplayNearestPoint(physical point),
// a DIP-space lookup, then convert through that display.
function electronScreenToDipPoint(displays, p) {
  const distance = (d) => {
    const b = d.bounds;
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width - 1));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height - 1));
    return dx * dx + dy * dy;
  };
  const d = displays.reduce((best, cur) => (distance(cur) < distance(best) ? cur : best));
  return {
    x: d.bounds.x + (p.x - d.nativeOrigin.x) / d.scaleFactor,
    y: d.bounds.y + (p.y - d.nativeOrigin.y) / d.scaleFactor,
  };
}

describe("physicalToDipPoint()", () => {
  it("converts through the display whose physical rect contains the point", () => {
    assert.deepEqual(physicalToDipPoint(MIXED_DISPLAYS, { x: 1500, y: 100 }), { x: 750, y: 50 });
    assert.deepEqual(physicalToDipPoint(MIXED_DISPLAYS, { x: 2000, y: 100 }), { x: 1040, y: 100 });
  });

  it("disagrees with Electron's DIP-nearest lookup where that picks the wrong display", () => {
    // Physical x=1500 is on the left (200%) panel, but as a DIP x it falls
    // inside the right panel's DIP bounds, so Electron converts through it.
    assert.deepEqual(electronScreenToDipPoint(MIXED_DISPLAYS, { x: 1500, y: 100 }), { x: 540, y: 100 });
    assert.deepEqual(physicalToDipPoint(MIXED_DISPLAYS, { x: 1500, y: 100 }), { x: 750, y: 50 });
  });

  it("maps the edge pixels on both sides of a scale boundary into their own display", () => {
    assert.deepEqual(physicalToDipPoint(MIXED_DISPLAYS, { x: 1919, y: 1079 }), { x: 959, y: 539 });
    assert.deepEqual(physicalToDipPoint(MIXED_DISPLAYS, { x: 1920, y: 0 }), { x: 960, y: 0 });
    assert.deepEqual(physicalToDipPoint(MIXED_DISPLAYS, { x: 3839, y: 1079 }), { x: 2879, y: 1079 });
  });

  it("matches Electron's conversion when every display has the same scale", () => {
    const uniform = [
      { bounds: { x: 0, y: 0, width: 960, height: 540 }, scaleFactor: 2, nativeOrigin: { x: 0, y: 0 } },
      { bounds: { x: 960, y: 0, width: 960, height: 540 }, scaleFactor: 2, nativeOrigin: { x: 1920, y: 0 } },
    ];
    for (let x = 0; x < 3840; x += 37) {
      for (let y = 0; y < 1080; y += 29) {
        const expected = electronScreenToDipPoint(uniform, { x, y });
        assert.deepEqual(
          physicalToDipPoint(uniform, { x, y }),
          { x: Math.floor(expected.x), y: Math.floor(expected.y) },
          `physical ${x},${y}`,
        );
      }
    }
  });

  it("returns null outside every display and for displays without nativeOrigin", () => {
    const shortRight = [
      MIXED_DISPLAYS[0],
      { bounds: { x: 960, y: 0, width: 1280, height: 720 }, scaleFactor: 1, nativeOrigin: { x: 1920, y: 0 } },
    ];
    assert.equal(physicalToDipPoint(shortRight, { x: 2000, y: 900 }), null);
    assert.equal(physicalToDipPoint(MIXED_DISPLAYS, { x: 4000, y: 0 }), null);
    assert.equal(physicalToDipPoint(MIXED_DISPLAYS, { x: -1, y: 0 }), null);
    const noOrigin = MIXED_DISPLAYS.map(({ nativeOrigin, ...rest }) => rest);
    assert.equal(physicalToDipPoint(noOrigin, { x: 100, y: 100 }), null);
    assert.equal(physicalToDipPoint(null, { x: 100, y: 100 }), null);
  });
});

function makeScreen(extra = {}) {
  return {
    getCursorScreenPoint: () => ({ x: 1, y: 2 }),
    getAllDisplays: () => MIXED_DISPLAYS,
    ...extra,
  };
}

describe("installLinuxX11CursorFallback()", () => {
  it("leaves screen untouched off the X11 backend", () => {
    const screen = makeScreen();
    const original = screen.getCursorScreenPoint;
    assert.equal(installLinuxX11CursorFallback(screen, { isLinuxX11: false, queryPointer: () => ({ x: 9, y: 9 }) }), false);
    assert.equal(screen.getCursorScreenPoint, original);
  });

  it("leaves screen untouched without getAllDisplays", () => {
    const screen = makeScreen({ getAllDisplays: undefined });
    const original = screen.getCursorScreenPoint;
    assert.equal(installLinuxX11CursorFallback(screen, { isLinuxX11: true, queryPointer: () => ({ x: 9, y: 9 }) }), false);
    assert.equal(screen.getCursorScreenPoint, original);
  });

  it("returns the live X11 point converted through its own display, not screenToDipPoint", () => {
    const screen = makeScreen({ screenToDipPoint: () => { throw new Error("must not be used"); } });
    assert.equal(
      installLinuxX11CursorFallback(screen, { isLinuxX11: true, queryPointer: () => ({ x: 1500, y: 100 }) }),
      true,
    );
    assert.deepEqual(screen.getCursorScreenPoint(), { x: 750, y: 50 });
  });

  it("falls back to Electron's value when the X11 query fails", () => {
    const screen = makeScreen();
    installLinuxX11CursorFallback(screen, { isLinuxX11: true, queryPointer: () => null });
    assert.deepEqual(screen.getCursorScreenPoint(), { x: 1, y: 2 });
  });

  it("falls back to Electron's value when no display contains the point", () => {
    const screen = makeScreen();
    installLinuxX11CursorFallback(screen, { isLinuxX11: true, queryPointer: () => ({ x: 5000, y: 100 }) });
    assert.deepEqual(screen.getCursorScreenPoint(), { x: 1, y: 2 });
  });

  it("falls back to Electron's value when getAllDisplays throws", () => {
    const screen = makeScreen({ getAllDisplays: () => { throw new Error("no displays"); } });
    installLinuxX11CursorFallback(screen, { isLinuxX11: true, queryPointer: () => ({ x: 1500, y: 100 }) });
    assert.deepEqual(screen.getCursorScreenPoint(), { x: 1, y: 2 });
  });
});

function makeBindings({ connectionError = 0, root = 0x3c3, pointers = [] } = {}) {
  const calls = [];
  const connection = { id: "conn" };
  let errorAfterQuery = 0;
  const bindings = {
    calls,
    connection,
    loseConnection(code = 1) { errorAfterQuery = code; },
    connect: (displayName) => {
      calls.push(["connect", displayName]);
      return { connection, screen: 0 };
    },
    hasError: () => {
      calls.push(["hasError"]);
      return connectionError || errorAfterQuery;
    },
    rootWindow: (conn, screen) => {
      calls.push(["rootWindow", conn === connection, screen]);
      return root;
    },
    queryPointer: (conn, window) => {
      calls.push(["queryPointer", conn === connection, window]);
      if (errorAfterQuery) return null;
      return pointers.length ? pointers.shift() : { sameScreen: true, x: 10, y: 20 };
    },
    disconnect: (conn) => calls.push(["disconnect", conn === connection]),
  };
  return bindings;
}

const callNames = (bindings) => bindings.calls.map((call) => call[0]);

describe("createX11PointerQuery()", () => {
  it("connects lazily once to the given display and returns root coordinates", () => {
    const bindings = makeBindings();
    const query = createX11PointerQuery({ bindings, displayName: ":1" });
    assert.deepEqual(bindings.calls, []);
    assert.deepEqual(query(), { x: 10, y: 20 });
    assert.deepEqual(query(), { x: 10, y: 20 });
    assert.deepEqual(callNames(bindings), ["connect", "hasError", "rootWindow", "queryPointer", "queryPointer"]);
    assert.deepEqual(bindings.calls[0], ["connect", ":1"]);
    assert.deepEqual(bindings.calls[3], ["queryPointer", true, 0x3c3]);
  });

  it("uses the default display when none is given", () => {
    const bindings = makeBindings();
    createX11PointerQuery({ bindings, displayName: "" })();
    assert.deepEqual(bindings.calls[0], ["connect", null]);
  });

  it("returns null while the pointer is on another X screen, and keeps the connection", () => {
    const bindings = makeBindings({ pointers: [{ sameScreen: false, x: 0, y: 0 }] });
    const query = createX11PointerQuery({ bindings });
    assert.equal(query(), null);
    assert.deepEqual(query(), { x: 10, y: 20 });
    assert.ok(!callNames(bindings).includes("disconnect"));
  });

  it("reports a failed connection once, disconnects it and does not retry", () => {
    const errors = [];
    const bindings = makeBindings({ connectionError: 1 });
    const query = createX11PointerQuery({ bindings, onError: (err) => errors.push(err.message) });
    assert.equal(query(), null);
    assert.equal(query(), null);
    assert.deepEqual(callNames(bindings), ["connect", "hasError", "disconnect"]);
    assert.deepEqual(errors, ["X11 connection failed (xcb_connection_has_error 1)"]);
  });

  it("disconnects when the root window cannot be found", () => {
    const errors = [];
    const bindings = makeBindings({ root: null });
    const query = createX11PointerQuery({ bindings, onError: (err) => errors.push(err.message) });
    assert.equal(query(), null);
    assert.deepEqual(callNames(bindings), ["connect", "hasError", "rootWindow", "disconnect"]);
    assert.equal(errors.length, 1);
  });

  it("shuts down after the connection is lost", () => {
    const errors = [];
    const bindings = makeBindings();
    const query = createX11PointerQuery({ bindings, onError: (err) => errors.push(err.message) });
    assert.deepEqual(query(), { x: 10, y: 20 });
    bindings.loseConnection(2);
    assert.equal(query(), null);
    assert.equal(query(), null);
    assert.equal(callNames(bindings).filter((name) => name === "queryPointer").length, 2);
    assert.equal(callNames(bindings).at(-1), "disconnect");
    assert.deepEqual(errors, ["X11 connection lost (xcb_connection_has_error 2)"]);
  });

  it("shuts down when a binding throws", () => {
    const errors = [];
    const bindings = makeBindings();
    bindings.queryPointer = () => { throw new Error("boom"); };
    const query = createX11PointerQuery({ bindings, onError: (err) => errors.push(err.message) });
    assert.equal(query(), null);
    assert.equal(query(), null);
    assert.deepEqual(errors, ["boom"]);
    assert.equal(callNames(bindings).at(-1), "disconnect");
  });

  it("swallows errors thrown by onError", () => {
    const bindings = makeBindings({ connectionError: 1 });
    const query = createX11PointerQuery({ bindings, onError: () => { throw new Error("log failed"); } });
    assert.equal(query(), null);
  });
});

describe("loadXcbPointerBindings()", () => {
  let koffi = null;
  let koffiLoadError = null;
  let libxcbLoadable = false;
  if (process.platform === "linux") {
    try {
      koffi = require("koffi");
    } catch (error) {
      koffiLoadError = error;
    }
    if (koffi) {
      try {
        koffi.load("libxcb.so.1");
        libxcbLoadable = true;
      } catch {}
    }
  }
  const realBindingSkip = process.platform !== "linux"
    ? "Linux only"
    : (!koffiLoadError && !libxcbLoadable && "needs libxcb.so.1");

  it("reports an unreachable display through the real libxcb bindings", { skip: realBindingSkip }, () => {
    if (koffiLoadError) throw koffiLoadError;
    const errors = [];
    const query = createX11PointerQuery({
      bindings: loadXcbPointerBindings(koffi),
      displayName: ":65535",
      onError: (err) => errors.push(err.message),
    });
    assert.equal(query(), null);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /xcb_connection_has_error/);
  });

  const liveSkip = realBindingSkip || (!process.env.DISPLAY && "needs an X display");
  it("queries the live pointer through the real libxcb bindings", { skip: liveSkip }, () => {
    if (koffiLoadError) throw koffiLoadError;
    const errors = [];
    const query = createX11PointerQuery({
      bindings: loadXcbPointerBindings(koffi),
      onError: (err) => errors.push(err.message),
    });
    const point = query();
    assert.deepEqual(errors, []);
    assert.ok(point, "pointer should be on the default screen");
    assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
  });
});

describe("main.js wiring", () => {
  it("installs after ready with the same X11 backend check as linux-x11-input-hint", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const ready = mainSource.indexOf("app.whenReady().then(async () => {");
    const install = mainSource.indexOf("installLinuxX11CursorFallback(screen, {");
    assert.ok(ready >= 0 && install > ready, "install must run inside app.whenReady()");
    assert.match(
      mainSource.slice(install),
      /^installLinuxX11CursorFallback\(screen, \{\s*isLinuxX11:\s*isLinux && app\.commandLine\.getSwitchValue\("ozone-platform"\) === "x11",\s*displayName:\s*app\.commandLine\.getSwitchValue\("display"\),\s*onError:/,
    );
  });
});
