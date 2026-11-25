"use strict";

// test/linux-kwin-cursor.test.js — KDE Plasma Wayland eye follow (#1410): the
// KWin script source, body validation, the bridge's load/unload lifecycle and
// heartbeat fallback, and the /kwin-cursor route on the real local server.

const { describe, it, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  PLUGIN_NAME,
  ROUTE,
  TOKEN_HEADER,
  HEARTBEAT_TIMEOUT_MS,
  MAX_RESTARTS,
  STABLE_RESET_MS,
  MAX_BODY_BYTES,
  isLinuxKwinCursorEligible,
  buildKwinCursorScript,
  parseKwinCursorBody,
  createKwinCursorBridge,
} = require("../src/linux-kwin-cursor");
const { createPermissionIngressHarness, postPermission } = require("./helpers/permission-ingress-harness");

const TOKEN = "0123456789abcdef0123456789abcdef";

function fakeKwinScripting({ loadReason = null } = {}) {
  const calls = [];
  const scripts = [];
  return {
    calls,
    scripts,
    loadAndRunScript({ scriptPath, pluginName, declarative }, callback) {
      calls.push(["load", pluginName, declarative]);
      scripts.push(fs.readFileSync(scriptPath, "utf8"));
      setImmediate(() => callback(loadReason, loadReason === "kwin-script-load-failed" ? null : 7));
    },
    unloadScript(pluginName, callback) {
      calls.push(["unload", pluginName]);
      setImmediate(() => callback(null));
    },
  };
}

function tokenFromScript(script) {
  return /readonly property string token: "([0-9a-f]{32})"/.exec(script)[1];
}

describe("KWin cursor eligibility", () => {
  it("needs Linux, the X11 Ozone backend and a Plasma 6 Wayland session", () => {
    assert.equal(isLinuxKwinCursorEligible({ platform: "linux", ozonePlatform: "x11", isKdeWaylandSession: true }), true);
    assert.equal(isLinuxKwinCursorEligible({ platform: "linux", ozonePlatform: "wayland", isKdeWaylandSession: true }), false);
    assert.equal(isLinuxKwinCursorEligible({ platform: "linux", ozonePlatform: "", isKdeWaylandSession: true }), false);
    assert.equal(isLinuxKwinCursorEligible({ platform: "linux", ozonePlatform: "x11", isKdeWaylandSession: false }), false);
    assert.equal(isLinuxKwinCursorEligible({ platform: "darwin", ozonePlatform: "x11", isKdeWaylandSession: true }), false);
  });
});

describe("KWin cursor script", () => {
  it("targets the given port and token and keeps its bounds", () => {
    const script = buildKwinCursorScript({ port: 23335, token: TOKEN });
    assert.match(script, /^import QtQuick\nimport org\.kde\.kwin\n/);
    assert.ok(script.includes(`"http://127.0.0.1:23335${ROUTE}"`));
    assert.equal(tokenFromScript(script), TOKEN);
    assert.ok(script.includes('setRequestHeader("X-Clawd-Kwin-Token", token)'));
    // One request in flight, the point read at send time, a heartbeat and a
    // first send on load.
    assert.match(script, /if \(stopped \|\| active \|\| !pending\) return;/);
    assert.match(script, /const pos = Workspace\.cursorPos;/);
    assert.match(script, /id: heartbeat\n\s+interval: 2000\n\s+repeat: true\n\s+running: true/);
    assert.match(script, /Component\.onCompleted: schedule\(\)/);
    assert.match(script, /status >= 400 && status < 500\) return stop\(\)/);
    // Date.now() can step back (NTP, a dual-boot RTC); the wait stays capped.
    assert.match(script, /sendTimer\.interval = Math\.max\(1, Math\.min\(50, lastSentAt \+ 50 - Date\.now\(\)\)\);/);
  });

  it("refuses anything but a valid port and a hex token", () => {
    assert.throws(() => buildKwinCursorScript({ port: 0, token: TOKEN }));
    assert.throws(() => buildKwinCursorScript({ port: 65536, token: TOKEN }));
    assert.throws(() => buildKwinCursorScript({ port: 23333, token: '"; evil' }));
  });
});

describe("KWin cursor body", () => {
  it("accepts exactly two finite numbers, negatives included", () => {
    assert.deepEqual(parseKwinCursorBody('{"x":640,"y":400}'), { x: 640, y: 400 });
    assert.deepEqual(parseKwinCursorBody('{"y":-12.5,"x":-1920}'), { x: -1920, y: -12.5 });
  });

  it("rejects everything else", () => {
    for (const body of [
      "", "null", "[]", "[1,2]", '"x"', "{}", '{"x":1}', '{"x":1,"y":2,"z":3}',
      '{"x":"1","y":2}', '{"x":1,"y":null}', '{"x":1e400,"y":0}', '{"x":2000000,"y":0}',
      '{"x":1,"y":2', '{"x":1,"z":2}',
    ]) {
      assert.equal(parseKwinCursorBody(body), null, body);
    }
  });
});

describe("KWin cursor bridge", () => {
  function makeBridge(options = {}) {
    let clock = 1000;
    const timers = [];
    const warnings = [];
    const kwin = options.kwin || fakeKwinScripting();
    const bridge = createKwinCursorBridge({
      kwinScripting: kwin,
      now: () => clock,
      setTimeoutFn: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
      clearTimeoutFn: (timer) => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
      logWarn: (message) => warnings.push(message),
      spawn: options.spawn,
    });
    return {
      bridge, kwin, warnings, timers,
      advance(ms) { clock += ms; },
    };
  }

  function post(bridge, body, headers = {}) {
    const { EventEmitter } = require("node:events");
    const req = new EventEmitter();
    req.headers = headers;
    req.destroy = () => { req.destroyed = true; };
    const res = {
      status: null,
      headers: null,
      writeHead(status, h) { this.status = status; this.headers = h; },
      end() { this.ended = true; },
    };
    bridge.handleRequest(req, res);
    if (res.status === null) {
      if (body != null) req.emit("data", Buffer.from(body));
      req.emit("end");
    }
    return res;
  }

  it("unloads any stale copy, then loads a declarative script with a fresh token", async () => {
    const { bridge, kwin } = makeBridge();
    await bridge.setEnabled(true, 23335);
    assert.deepEqual(kwin.calls, [["unload", PLUGIN_NAME], ["load", PLUGIN_NAME, true]]);
    assert.ok(kwin.scripts[0].includes("127.0.0.1:23335/kwin-cursor"));
    assert.equal(bridge.getStatus(), "loading");
    assert.equal(bridge.getPoint(), null);

    await bridge.setEnabled(false);
    await bridge.setEnabled(true);
    const tokens = kwin.scripts.map(tokenFromScript);
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
  });

  it("stays off without a bound port", async () => {
    const { bridge, kwin } = makeBridge();
    await bridge.setEnabled(true);
    assert.deepEqual(kwin.calls, []);
    assert.equal(bridge.getStatus(), "off");
  });

  it("serves points from the current script only, floored to integers", async () => {
    const { bridge, kwin } = makeBridge();
    await bridge.setEnabled(true, 23335);
    const token = tokenFromScript(kwin.scripts[0]);

    assert.equal(post(bridge, '{"x":5,"y":6}', { [TOKEN_HEADER]: "f".repeat(32) }).status, 403);
    assert.equal(post(bridge, '{"x":5,"y":6}', {}).status, 403);
    assert.equal(bridge.getPoint(), null);

    assert.equal(post(bridge, '{"x":-100.7,"y":20.2}', { [TOKEN_HEADER]: token }).status, 204);
    assert.equal(bridge.getStatus(), "live");
    assert.deepEqual(bridge.getPoint(), { x: -101, y: 20 });

    assert.equal(post(bridge, '{"x":"5","y":6}', { [TOKEN_HEADER]: token }).status, 400);
    assert.deepEqual(bridge.getPoint(), { x: -101, y: 20 });

    await bridge.setEnabled(false);
    assert.deepEqual(kwin.calls.at(-1), ["unload", PLUGIN_NAME]);
    assert.equal(post(bridge, '{"x":1,"y":2}', { [TOKEN_HEADER]: token }).status, 403);
    assert.equal(bridge.getPoint(), null);
  });

  it("rejects oversized bodies by declared length and by streamed size", async () => {
    const { bridge, kwin } = makeBridge();
    await bridge.setEnabled(true, 23335);
    const token = tokenFromScript(kwin.scripts[0]);
    const big = JSON.stringify({ x: 1, y: 2, pad: "x".repeat(MAX_BODY_BYTES) });
    assert.equal(post(bridge, big, { [TOKEN_HEADER]: token, "content-length": String(big.length) }).status, 413);
    assert.equal(post(bridge, big, { [TOKEN_HEADER]: token }).status, 413);
    assert.equal(bridge.getPoint(), null);
  });

  it("falls back when the heartbeat lapses, recovers on the next point, and reloads a bounded number of times", async () => {
    const { bridge, kwin, timers, advance, warnings } = makeBridge();
    await bridge.setEnabled(true, 23335);
    let token = tokenFromScript(kwin.scripts.at(-1));
    post(bridge, '{"x":1,"y":2}', { [TOKEN_HEADER]: token });

    // A still cursor keeps reporting through heartbeats.
    advance(HEARTBEAT_TIMEOUT_MS);
    assert.deepEqual(bridge.getPoint(), { x: 1, y: 2 });

    advance(1);
    assert.equal(bridge.getPoint(), null);
    assert.equal(bridge.getStatus(), "lapsed");
    assert.equal(timers.length, 1);
    assert.equal(warnings.length, 1);

    // A late heartbeat revives it; the pending reload then does nothing.
    post(bridge, '{"x":3,"y":4}', { [TOKEN_HEADER]: token });
    assert.deepEqual(bridge.getPoint(), { x: 3, y: 4 });
    const loadsBefore = kwin.scripts.length;
    timers.shift().fn();
    assert.equal(kwin.scripts.length, loadsBefore);

    // Every further lapse reloads until MAX_RESTARTS (3 in total) is used up.
    for (let i = 0; i < 4; i++) {
      advance(HEARTBEAT_TIMEOUT_MS + 1);
      assert.equal(bridge.getPoint(), null);
      const timer = timers.shift();
      if (!timer) break;
      timer.fn();
      await bridge.setEnabled(true); // no change: waits for the queued reload
      token = tokenFromScript(kwin.scripts.at(-1));
      post(bridge, '{"x":5,"y":6}', { [TOKEN_HEADER]: token });
    }
    assert.equal(kwin.scripts.length, loadsBefore + 2);
    assert.equal(timers.length, 0);
  });

  it("earns its reloads back after running steadily, not right after a reload", async () => {
    const { bridge, kwin, timers, advance } = makeBridge();
    await bridge.setEnabled(true, 23335);
    const beat = () => {
      const token = tokenFromScript(kwin.scripts.at(-1));
      assert.equal(post(bridge, '{"x":1,"y":2}', { [TOKEN_HEADER]: token }).status, 204);
    };
    const lapse = async () => {
      advance(HEARTBEAT_TIMEOUT_MS + 1);
      assert.equal(bridge.getPoint(), null);
      const timer = timers.shift();
      if (!timer) return false;
      timer.fn();
      await bridge.setEnabled(true);
      beat();
      return true;
    };
    const runSteadily = (ms) => {
      for (let t = 0; t < ms; t += 2000) { advance(2000); beat(); bridge.getPoint(); }
    };

    beat();
    for (let i = 0; i < MAX_RESTARTS; i++) assert.equal(await lapse(), true);
    runSteadily(STABLE_RESET_MS - 2000);
    assert.equal(await lapse(), false, "still exhausted just before the stable period ends");

    // A late heartbeat revives it; a full stable period restores the budget.
    beat();
    runSteadily(STABLE_RESET_MS + 2000);
    for (let i = 0; i < MAX_RESTARTS; i++) assert.equal(await lapse(), true);
    assert.equal(await lapse(), false);
  });

  it("counts an unpolled silent gap as the end of a steady run", async () => {
    const { bridge, kwin, timers, advance } = makeBridge();
    await bridge.setEnabled(true, 23335);
    const beat = () => post(bridge, '{"x":1,"y":2}', { [TOKEN_HEADER]: tokenFromScript(kwin.scripts.at(-1)) });
    beat();
    for (let i = 0; i < MAX_RESTARTS; i++) {
      advance(HEARTBEAT_TIMEOUT_MS + 1);
      assert.equal(bridge.getPoint(), null);
      timers.shift().fn();
      await bridge.setEnabled(true);
      beat();
    }
    // Nobody calls getPoint (pet asleep) while the script goes silent, so the
    // state never leaves "live"; the elapsed time alone must not restore the budget.
    advance(STABLE_RESET_MS + 1);
    beat();
    advance(2000);
    beat();
    advance(HEARTBEAT_TIMEOUT_MS + 1);
    assert.equal(bridge.getPoint(), null);
    assert.equal(timers.length, 0);
  });

  it("measures the heartbeat on a monotonic clock, not the wall clock", async (t) => {
    const { performance } = require("node:perf_hooks");
    let wall = 1_000_000_000;
    let mono = 5000;
    t.mock.method(Date, "now", () => wall);
    t.mock.method(performance, "now", () => mono);
    const kwin = fakeKwinScripting();
    const bridge = createKwinCursorBridge({ kwinScripting: kwin, setTimeoutFn: () => ({}) });
    await bridge.setEnabled(true, 23335);
    const token = tokenFromScript(kwin.scripts[0]);
    post(bridge, '{"x":1,"y":2}', { [TOKEN_HEADER]: token });

    wall += 3_600_000; // forward step: the script is still alive
    assert.deepEqual(bridge.getPoint(), { x: 1, y: 2 });

    wall -= 7_200_000; // backward step: a dead script still lapses
    mono += HEARTBEAT_TIMEOUT_MS + 1;
    assert.equal(bridge.getPoint(), null);
    assert.equal(bridge.getStatus(), "lapsed");
  });

  it("reports a failed load once and keeps the X11 query", async () => {
    const { bridge, warnings } = makeBridge({ kwin: fakeKwinScripting({ loadReason: "kwin-script-load-failed" }) });
    await bridge.setEnabled(true, 23335);
    assert.equal(bridge.getStatus(), "failed");
    assert.equal(bridge.getPoint(), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /kwin-script-load-failed/);
  });

  it("unloads a script that started after it was disabled", async () => {
    const { bridge, kwin } = makeBridge();
    const loading = bridge.setEnabled(true, 23335);
    bridge.setEnabled(false);
    await loading;
    await bridge.setEnabled(false);
    assert.deepEqual(kwin.calls.at(-1), ["unload", PLUGIN_NAME]);
    assert.equal(bridge.getStatus(), "off");
  });

  it("only cleans up stale scripts while it is off", async () => {
    const { bridge, kwin } = makeBridge();
    await bridge.unloadStale();
    assert.deepEqual(kwin.calls, [["unload", PLUGIN_NAME]]);
  });

  it("hands the unload on quit to a detached gdbus", async () => {
    const spawned = [];
    const { bridge } = makeBridge({
      spawn: (cmd, args, options) => {
        spawned.push({ cmd, args, options });
        return { on() {}, unref() { spawned.at(-1).unref = true; } };
      },
    });
    bridge.disposeSync();
    assert.equal(spawned.length, 0, "nothing to unload while off");
    await bridge.setEnabled(true, 23335);
    bridge.disposeSync();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cmd, "gdbus");
    assert.ok(spawned[0].args.includes("org.kde.kwin.Scripting.unloadScript"));
    assert.equal(spawned[0].args.at(-1), PLUGIN_NAME);
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].unref, true);
    assert.equal(bridge.getStatus(), "off");
  });
});

test("the local server routes /kwin-cursor through the native hook guard", async (t) => {
  const kwin = fakeKwinScripting();
  const bridge = createKwinCursorBridge({ kwinScripting: kwin });
  const h = await createPermissionIngressHarness({
    ctxOverrides: { handleKwinCursorRequest: (req, res) => bridge.handleRequest(req, res) },
  });
  t.after(() => h.close());
  await bridge.setEnabled(true, h.port);
  const token = tokenFromScript(kwin.scripts[0]);
  const send = (body, headers = {}) => postPermission(h.port, body, headers, ROUTE).response;

  // The exact headers KWin 6.6's QML XMLHttpRequest sends (measured).
  const qmlHeaders = {
    "Content-Type": "application/json;charset=UTF-8",
    [TOKEN_HEADER]: token,
    Connection: "Keep-Alive",
    "Accept-Encoding": "zstd, br, gzip, deflate",
    "Accept-Language": "en-US,*",
    "User-Agent": "Mozilla/5.0",
  };
  assert.equal((await send('{"x":10,"y":-20}', qmlHeaders)).status, 204);
  assert.deepEqual(bridge.getPoint(), { x: 10, y: -20 });

  for (const [headers, status] of [
    [{ ...qmlHeaders, Origin: "https://untrusted.example" }, 403],
    [{ ...qmlHeaders, Host: "rebound.example" }, 403],
    [{ ...qmlHeaders, "Content-Type": "text/plain" }, 415],
    [{ ...qmlHeaders, [TOKEN_HEADER]: "0".repeat(32) }, 403],
  ]) {
    assert.equal((await send('{"x":99,"y":99}', headers)).status, status, JSON.stringify(headers));
  }
  assert.deepEqual(bridge.getPoint(), { x: 10, y: -20 });
  // Points never reach the hook logs or the session state.
  assert.deepEqual(h.logs, []);
  assert.deepEqual(h.updates, []);
  assert.equal(h.debugLogs.some((entry) => /99|untrusted/.test(entry)), false);
});

test("Remote SSH ingress does not expose /kwin-cursor", async (t) => {
  const kwin = fakeKwinScripting();
  const bridge = createKwinCursorBridge({ kwinScripting: kwin });
  let handled = 0;
  const h = await createPermissionIngressHarness({
    ctxOverrides: { handleKwinCursorRequest: (req, res) => { handled++; bridge.handleRequest(req, res); } },
  });
  t.after(() => h.close());
  const nonce = "b".repeat(32);
  const ingress = h.api.openRemoteSshIngress({
    remoteProfile: { profileId: "fixture-remote", displayHost: "fixture-host" },
    getAcceptedNonces: () => [nonce],
  });
  const port = await ingress.start();
  t.after(() => ingress.close());
  const result = await postPermission(port, '{"x":1,"y":2}', { "x-clawd-routing-nonce": nonce }, ROUTE).response;
  assert.notEqual(result.status, 204);
  assert.equal(handled, 0);
});
