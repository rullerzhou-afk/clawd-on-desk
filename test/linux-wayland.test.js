// test/linux-wayland.test.js — Unit tests for src/linux-wayland.js
// (native Wayland / Hyprland backend). Original work by xingguangcuican6666.
//
// The backend talks to the Hyprland IPC socket with raw libc calls through
// koffi; every pure decision (session detection, marker encoding, sockaddr
// layout, cursorpos parsing, Lua payload construction, degradation) is tested
// here with injectable fake bindings — no compositor, no koffi, no Electron.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  isNativeWaylandSession,
  isWaylandBackendActive,
  isHyprlandSession,
  hyprlandSocketPath,
  encodeMarker,
  markerRegex,
  buildSockAddr,
  ipcCommand,
  parseCursorPos,
  luaQuote,
  luaDispatchMove,
  luaDispatchFocus,
  luaDispatchFocusLast,
  luaDispatchPin,
  luaDispatchRaise,
  luaDispatchMoveCursor,
  luaWindowRule,
  luaRuleSetEnabled,
  createHyprlandBackend,
  installHyprlandCursorProvider,
  MARKER_PREFIX,
  RULE_PREFIX,
} = require("../src/linux-wayland");

// ── Fake koffi bindings ──
//
// Records every command written to the socket and replays a canned reply.
// Mirrors the real hyprctl protocol: connect → write → shutdown → read(s).
function createFakeBindings({ reply = "ok\n", failConnect = false, shortReads = true, onWrite = null } = {}) {
  const calls = { socket: 0, connect: 0, write: [], shutdown: 0, read: 0, close: 0 };
  const replyBuf = Buffer.from(reply, "utf8");
  return {
    calls,
    bindings: {
      socket: () => { calls.socket += 1; return 7; },
      connect: () => { calls.connect += 1; return failConnect ? -1 : 0; },
      write: (_fd, buf, len) => {
        const text = Buffer.from(buf.subarray(0, len)).toString("utf8");
        calls.write.push(text);
        if (onWrite) onWrite(text);
        return len;
      },
      shutdown: () => { calls.shutdown += 1; return 0; },
      read: (_fd, out) => {
        calls.read += 1;
        // Deliver everything on the first read (a short read signals EOF
        // handling); a second call would mean the loop kept going.
        if (calls.read % 2 === 0) return 0;
        replyBuf.copy(out, 0);
        return shortReads ? replyBuf.length : 0;
      },
      close: () => { calls.close += 1; return 0; },
    },
  };
}

describe("session/backend detection", () => {
  it("isNativeWaylandSession: XDG_SESSION_TYPE or WAYLAND_DISPLAY", () => {
    assert.equal(isNativeWaylandSession({ XDG_SESSION_TYPE: "wayland" }), true);
    assert.equal(isNativeWaylandSession({ XDG_SESSION_TYPE: " Wayland " }), true);
    assert.equal(isNativeWaylandSession({ WAYLAND_DISPLAY: "wayland-1" }), true);
    assert.equal(isNativeWaylandSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), false);
    assert.equal(isNativeWaylandSession({}), false);
    assert.equal(isNativeWaylandSession({ WAYLAND_DISPLAY: "  " }), false);
  });

  it("isWaylandBackendActive: Chromium's resolved switch wins", () => {
    assert.equal(isWaylandBackendActive({ platform: "linux", ozonePlatform: "wayland" }), true);
    assert.equal(isWaylandBackendActive({ platform: "linux", ozonePlatform: "x11", env: { XDG_SESSION_TYPE: "wayland" } }), false);
    assert.equal(isWaylandBackendActive({ platform: "linux", ozonePlatform: "WAYLAND " }), true);
  });

  it("isWaylandBackendActive: empty switch falls back to session sniffing", () => {
    assert.equal(isWaylandBackendActive({ platform: "linux", ozonePlatform: "", env: { XDG_SESSION_TYPE: "wayland" } }), true);
    assert.equal(isWaylandBackendActive({ platform: "linux", ozonePlatform: "", env: { XDG_SESSION_TYPE: "x11" } }), false);
  });

  it("isWaylandBackendActive: never active off Linux", () => {
    assert.equal(isWaylandBackendActive({ platform: "darwin", ozonePlatform: "wayland" }), false);
    assert.equal(isWaylandBackendActive({ platform: "win32", ozonePlatform: "" }), false);
  });

  it("isHyprlandSession: needs both HYPRLAND_INSTANCE_SIGNATURE and XDG_RUNTIME_DIR", () => {
    assert.equal(isHyprlandSession({ HYPRLAND_INSTANCE_SIGNATURE: "abc", XDG_RUNTIME_DIR: "/run/user/1000" }), true);
    assert.equal(isHyprlandSession({ HYPRLAND_INSTANCE_SIGNATURE: "abc" }), false);
    assert.equal(isHyprlandSession({ XDG_RUNTIME_DIR: "/run/user/1000" }), false);
    assert.equal(isHyprlandSession({ HYPRLAND_INSTANCE_SIGNATURE: "  ", XDG_RUNTIME_DIR: "/run/user/1000" }), false);
  });

  it("hyprlandSocketPath: composes the canonical socket path", () => {
    assert.equal(
      hyprlandSocketPath({ HYPRLAND_INSTANCE_SIGNATURE: "sig123", XDG_RUNTIME_DIR: "/run/user/1000" }),
      "/run/user/1000/hypr/sig123/.socket.sock"
    );
    assert.equal(hyprlandSocketPath({ HYPRLAND_INSTANCE_SIGNATURE: "sig123" }), null);
    assert.equal(hyprlandSocketPath({}), null);
  });
});

describe("marker encoding", () => {
  it("starts with the visible prefix and uses only zero-width chars after it", () => {
    const marker = encodeMarker(1234, 3);
    assert.ok(marker.startsWith(MARKER_PREFIX));
    const tail = marker.slice(MARKER_PREFIX.length);
    assert.ok(tail.length > 0);
    for (const ch of tail) {
      assert.ok(ch === "​" || ch === "‌", `unexpected char U+${ch.codePointAt(0).toString(16)}`);
    }
  });

  it("is unique per (pid, id) — concurrent instances cannot collide", () => {
    const seen = new Set();
    for (const pid of [100, 101, 999999]) {
      for (let id = 1; id <= 40; id++) {
        const marker = encodeMarker(pid, id);
        assert.ok(!seen.has(marker), `collision for pid=${pid} id=${id}`);
        seen.add(marker);
      }
    }
  });

  it("round-trips distinct ids to distinct bit patterns", () => {
    assert.notEqual(encodeMarker(1, 1), encodeMarker(1, 2));
    assert.notEqual(encodeMarker(1, 1), encodeMarker(2, 1));
  });

  it("markerRegex anchors at start and tolerates a visible tail", () => {
    const marker = encodeMarker(4242, 7);
    assert.equal(markerRegex(marker), `^${marker}.*`);
  });

  it("RULE_PREFIX names every rule we create", () => {
    assert.equal(RULE_PREFIX, "clawd-wayland-");
  });
});

describe("sockaddr_un encoding", () => {
  it("is 110 bytes with AF_UNIX=1 and the path at offset 2", () => {
    const addr = buildSockAddr("/run/user/1000/hypr/sig/.socket.sock");
    assert.equal(addr.length, 110);
    assert.equal(addr.readUInt16LE(0), 1); // AF_UNIX
    assert.equal(addr.subarray(2, 2 + 36).toString("utf8"), "/run/user/1000/hypr/sig/.socket.sock");
  });

  it("truncates an over-long path without throwing", () => {
    const addr = buildSockAddr("x".repeat(300));
    assert.equal(addr.length, 110);
  });
});

describe("ipcCommand()", () => {
  it("writes the command, half-closes, reads to EOF and closes the fd", () => {
    const fake = createFakeBindings({ reply: "480, 620\n" });
    const out = ipcCommand("/tmp/sock", "cursorpos", fake.bindings);
    assert.equal(out, "480, 620\n");
    assert.deepEqual(fake.calls.write, ["cursorpos"]);
    assert.equal(fake.calls.connect, 1);
    assert.equal(fake.calls.shutdown, 1);
    assert.ok(fake.calls.close >= 1);
  });

  it("throws when connect fails", () => {
    const fake = createFakeBindings({ failConnect: true });
    assert.throws(() => ipcCommand("/tmp/sock", "cursorpos", fake.bindings), /connect/);
    assert.ok(fake.calls.close >= 1, "fd must be closed even on failure");
  });
});

describe("parseCursorPos()", () => {
  it("parses the canonical 'x, y' reply", () => {
    assert.deepEqual(parseCursorPos("480, 620"), { x: 480, y: 620 });
    assert.deepEqual(parseCursorPos("480,620\n"), { x: 480, y: 620 });
  });

  it("parses negative coordinates", () => {
    assert.deepEqual(parseCursorPos("-10, -20"), { x: -10, y: -20 });
  });

  it("rounds fractional coordinates", () => {
    assert.deepEqual(parseCursorPos("480.4, 619.6"), { x: 480, y: 620 });
  });

  it("returns null on garbage / empty / null", () => {
    assert.equal(parseCursorPos("err:oops"), null);
    assert.equal(parseCursorPos(""), null);
    assert.equal(parseCursorPos(null), null);
    assert.equal(parseCursorPos(undefined), null);
  });
});

describe("lua payload builders", () => {
  it("luaQuote escapes backslashes and quotes", () => {
    assert.equal(luaQuote('a"b\\c'), '"a\\"b\\\\c"');
  });

  it("dispatchers are wrapped in hl.dispatch (bare hl.dsp.* never runs)", () => {
    const move = luaDispatchMove("0xabc", 10.4, -20.6);
    assert.ok(move.startsWith("eval return tostring(hl.dispatch(hl.dsp.window.move("));
    assert.ok(move.includes("x=10, y=-21"), move);
    assert.ok(move.includes('window="address:0xabc"'));

    const focus = luaDispatchFocus("0xabc");
    assert.ok(focus.includes("hl.dispatch(hl.dsp.focus("));
    assert.ok(focus.includes('window="address:0xabc"'));

    assert.ok(luaDispatchFocusLast().includes("hl.dispatch(hl.dsp.focus({last=true}))"));

    assert.ok(luaDispatchPin("0xabc", true).includes('action="pin"'));
    assert.ok(luaDispatchPin("0xabc", false).includes('action="unpin"'));

    assert.ok(luaDispatchRaise("0xabc").includes('alter_zorder({mode="top"'));

    const cursor = luaDispatchMoveCursor(5, 6);
    assert.ok(cursor.includes("hl.dispatch(hl.dsp.cursor.move({x=5, y=6}))"));
  });

  it("window rules match initial_title with an anchored RE2 pattern", () => {
    const lua = luaWindowRule("clawd-wayland-place-1", "^Clawd​.*", {
      float: true,
      pin: true,
      no_initial_focus: true,
      move: [100.2, 200.8],
      size: [64, 64],
    });
    assert.ok(lua.startsWith("eval hl.window_rule({"));
    assert.ok(lua.includes('name="clawd-wayland-place-1"'));
    assert.ok(lua.includes("match={initial_title="));
    assert.ok(lua.includes("float=true"));
    assert.ok(lua.includes("pin=true"));
    assert.ok(lua.includes("no_initial_focus=true"));
    // vec2 effects round to integers
    assert.ok(lua.includes("move={100, 201}"), lua);
    assert.ok(lua.includes("size={64, 64}"), lua);
  });

  it("boolean effects are emitted explicitly as true AND false", () => {
    // Same-name rule calls APPEND effects and the last value wins, so a
    // false must be written explicitly to override a previously appended
    // true — omitting it would leave the stale true active.
    const lua = luaWindowRule("r", "^m.*", { pin: false, no_focus: false, float: true });
    assert.ok(lua.includes("pin=false"), lua);
    assert.ok(lua.includes("no_focus=false"), lua);
    assert.ok(lua.includes("float=true"), lua);
  });

  it("skips malformed vec2 values", () => {
    const lua = luaWindowRule("r", "^m.*", { move: [1], size: ["a", "b"] });
    assert.ok(!lua.includes("move="), lua);
    assert.ok(!lua.includes("size="), lua);
  });

  it("enabled toggle goes through the same-name update path", () => {
    assert.equal(
      luaRuleSetEnabled("clawd-wayland-click-2", true),
      'eval hl.window_rule({name="clawd-wayland-click-2", enabled=true}); return "ok"'
    );
    assert.ok(luaRuleSetEnabled("r", false).includes("enabled=false"));
  });
});

describe("createHyprlandBackend()", () => {
  it("is unavailable without a socket path and never calls bindings", () => {
    const fake = createFakeBindings();
    const backend = createHyprlandBackend({ env: {}, bindings: fake.bindings });
    assert.equal(backend.available, false);
    assert.equal(backend.query("cursorpos"), null);
    assert.equal(backend.cursorPoint(), null);
    assert.equal(fake.calls.socket, 0);
  });

  it("cursorPoint parses the cursorpos reply", () => {
    const fake = createFakeBindings({ reply: "480, 620\n" });
    const backend = createHyprlandBackend({
      socketPath: "/tmp/s", bindings: fake.bindings,
    });
    assert.equal(backend.available, true);
    assert.deepEqual(backend.cursorPoint(), { x: 480, y: 620 });
    assert.deepEqual(fake.calls.write, ["cursorpos"]);
  });

  it("clients() parses j/clients JSON and returns null on garbage", () => {
    const ok = createHyprlandBackend({
      socketPath: "/tmp/s",
      bindings: createFakeBindings({ reply: JSON.stringify([{ pid: 1, address: "0xaa" }]) }).bindings,
    });
    assert.deepEqual(ok.clients(), [{ pid: 1, address: "0xaa" }]);

    const bad = createHyprlandBackend({
      socketPath: "/tmp/s",
      bindings: createFakeBindings({ reply: "not json" }).bindings,
    });
    assert.equal(bad.clients(), null);
  });

  it("findClientByMarker matches own-pid clients by initialTitle or title prefix", () => {
    const marker = encodeMarker(4242, 1);
    const list = [
      { pid: 999, initialTitle: marker, address: "0xother" },
      { pid: 4242, initialTitle: "kitty", title: "kitty", address: "0xk" },
      { pid: 4242, initialTitle: marker + " — Clawd", title: marker + " — Clawd", address: "0xmine" },
    ];
    const backend = createHyprlandBackend({
      socketPath: "/tmp/s",
      bindings: createFakeBindings({ reply: JSON.stringify(list) }).bindings,
    });
    const found = backend.findClientByMarker(marker, 4242);
    assert.equal(found.address, "0xmine");
    assert.equal(backend.findClientByMarker(marker, 7), null);
    assert.equal(backend.findClientByMarker(null, 4242), null);
  });

  it("activeWindow requires an address field", () => {
    const withAddr = createHyprlandBackend({
      socketPath: "/tmp/s",
      bindings: createFakeBindings({ reply: JSON.stringify({ address: "0x1", class: "kitty" }) }).bindings,
    });
    assert.equal(withAddr.activeWindow().address, "0x1");
    const empty = createHyprlandBackend({
      socketPath: "/tmp/s",
      bindings: createFakeBindings({ reply: "{}" }).bindings,
    });
    assert.equal(empty.activeWindow(), null);
  });

  it("dispatch operations normalize the address and send wrapped dispatchers", () => {
    const fake = createFakeBindings({ reply: "ok\n" });
    const backend = createHyprlandBackend({ socketPath: "/tmp/s", bindings: fake.bindings });
    assert.equal(backend.moveWindow("0xabc", 1, 2), true);
    // bare "abc" gets the 0x prefix the selector grammar requires
    assert.equal(backend.focusWindow("abc"), true);
    assert.equal(fake.calls.write[1].includes('window="address:0xabc"'), true);
    assert.equal(backend.moveWindow(null, 1, 2), false);
    assert.equal(backend.focusWindow(""), false);
  });

  it("a transport error latches broken, reports once, and degrades to no-ops", () => {
    const errors = [];
    const backend = createHyprlandBackend({
      socketPath: "/tmp/s",
      bindings: createFakeBindings({ failConnect: true }).bindings,
      onError: (e) => errors.push(e),
    });
    assert.equal(backend.available, true); // not broken until first failure
    assert.equal(backend.cursorPoint(), null);
    assert.equal(backend.available, false);
    assert.equal(backend.cursorPoint(), null); // latched: no further attempts
    assert.equal(backend.moveWindow("0xabc", 1, 2), false);
    assert.equal(errors.length, 1, "onError must fire exactly once");
  });

  it("defineWindowRule / setWindowRuleEnabled send rule payloads", () => {
    const fake = createFakeBindings({ reply: "ok\n" });
    const backend = createHyprlandBackend({ socketPath: "/tmp/s", bindings: fake.bindings });
    assert.equal(backend.defineWindowRule("r1", "^M.*", { float: true }), true);
    assert.ok(fake.calls.write[0].includes("hl.window_rule({name=\"r1\""));
    assert.equal(backend.setWindowRuleEnabled("r1", false), true);
    assert.ok(fake.calls.write[1].includes("enabled=false"));
  });
});

describe("installHyprlandCursorProvider()", () => {
  function fakeScreen() {
    return { getCursorScreenPoint: () => ({ x: -1, y: -1 }) };
  }

  it("replaces screen.getCursorScreenPoint with the backend value", () => {
    const screen = fakeScreen();
    const backend = { available: true, cursorPoint: () => ({ x: 10, y: 20 }) };
    assert.equal(installHyprlandCursorProvider(screen, backend), true);
    assert.deepEqual(screen.getCursorScreenPoint(), { x: 10, y: 20 });
  });

  it("falls back to the original when the backend returns null", () => {
    const screen = fakeScreen();
    const backend = { available: true, cursorPoint: () => null };
    installHyprlandCursorProvider(screen, backend);
    assert.deepEqual(screen.getCursorScreenPoint(), { x: -1, y: -1 });
  });

  it("does not install when the backend is unavailable (degradation)", () => {
    const screen = fakeScreen();
    const backend = { available: false, cursorPoint: () => ({ x: 10, y: 20 }) };
    assert.equal(installHyprlandCursorProvider(screen, backend), false);
    assert.deepEqual(screen.getCursorScreenPoint(), { x: -1, y: -1 });
  });

  it("does not install without a screen API", () => {
    assert.equal(installHyprlandCursorProvider(null, { available: true }), false);
    assert.equal(installHyprlandCursorProvider({}, { available: true }), false);
  });
});
