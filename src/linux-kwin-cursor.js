"use strict";

// ── KDE Plasma Wayland: global cursor for eye follow (#1410, #441) ──
//
// Under the XWayland relaunch (src/linux-ozone.js) the X server only learns the
// pointer position while the pointer is over an X11 window, so the live X11
// query in linux-x11-cursor.js freezes over native Wayland windows and the
// panel. KWin knows the global position. A small QML script loaded into KWin
// over D-Bus pushes it to Clawd's own local server:
//
//   KWin: Workspace.cursorPosChanged → POST 127.0.0.1:<bound port>/kwin-cursor
//         {"x":…,"y":…} with a per-launch token header
//   Clawd: tick.js reads getPoint() for eye follow and theme pointer payloads
//          only; drag, menus and hover tests keep screen.getCursorScreenPoint()
//          because a ~20/s async push would lag a drag.
//
// Bounds on the KWin side (the script runs inside the compositor): one request
// in flight, the point read at send time (only the latest matters), at most one
// send per SEND_INTERVAL_MS, a request timeout, exponential backoff, and a full
// stop after MAX_FAILURES consecutive failures or any 4xx answer. KWin emits
// cursorPosChanged only on movement, so the script also sends once on start and
// then every HEARTBEAT_MS; Clawd falls back to the X11 query only when the
// heartbeat lapses, the load fails, or the script is unloaded — never just
// because the cursor sits still.
//
// Coordinates: KWin reports logical (scaled) coordinates. Under XWayland KWin
// configures X11 so Chromium's DIP space equals that logical space in both
// "Legacy applications (X11)" scaling modes, so the point is used as DIP as is
// (no physicalToDipPoint, which is for X11 physical pixels).

const { performance } = require("perf_hooks");

const PLUGIN_NAME = "clawd-kwin-cursor";
const ROUTE = "/kwin-cursor";
const TOKEN_HEADER = "x-clawd-kwin-token";

const SEND_INTERVAL_MS = 50;        // ≤20 req/s; the tick samples at most every 50 ms
const HEARTBEAT_MS = 2000;
const HEARTBEAT_TIMEOUT_MS = 5000;  // 2 missed heartbeats plus slack
const REQUEST_TIMEOUT_MS = 1000;
const BACKOFF_BASE_MS = 500;        // 0.5, 1, 2, 4, 8 s, then stop
const MAX_FAILURES = 6;
const MAX_BODY_BYTES = 128;
const MAX_COORDINATE = 1e6;
const MAX_RESTARTS = 3;             // reloads after a lapsed heartbeat
const STABLE_RESET_MS = 300000;     // live this long without a lapse: reloads start over
const RESTART_DELAY_MS = 10000;

function isLinuxKwinCursorEligible({ platform = process.platform, ozonePlatform, isKdeWaylandSession } = {}) {
  return platform === "linux" && ozonePlatform === "x11" && isKdeWaylandSession === true;
}

function buildKwinCursorScript({ port, token }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  if (!/^[0-9a-f]{32}$/.test(String(token))) throw new Error("invalid token");
  return `import QtQuick
import org.kde.kwin

// Clawd-on-Desk: pushes the global cursor to Clawd's local server for eye
// follow. Loaded and unloaded by Clawd as "${PLUGIN_NAME}".
Item {
    id: root
    readonly property string endpoint: "http://127.0.0.1:${port}${ROUTE}"
    readonly property string token: "${token}"
    property bool stopped: false
    property bool pending: true
    property var active: null
    property int failures: 0
    property double lastSentAt: 0

    function schedule() {
        if (stopped || active || !pending || sendTimer.running || backoffTimer.running) return;
        // Date.now() may step back; without the cap the wait grows by the step.
        sendTimer.interval = Math.max(1, Math.min(${SEND_INTERVAL_MS}, lastSentAt + ${SEND_INTERVAL_MS} - Date.now()));
        sendTimer.start();
    }

    function send() {
        if (stopped || active || !pending) return;
        pending = false;
        const pos = Workspace.cursorPos;
        const xhr = new XMLHttpRequest();
        active = xhr;
        lastSentAt = Date.now();
        xhr.onreadystatechange = function () {
            if (xhr.readyState === XMLHttpRequest.DONE && root.active === xhr) root.finish(xhr.status);
        };
        xhr.open("POST", endpoint);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("X-Clawd-Kwin-Token", token);
        xhr.send(JSON.stringify({ x: pos.x, y: pos.y }));
        timeoutTimer.restart();
    }

    function finish(status) {
        timeoutTimer.stop();
        active = null;
        if (status === 204) {
            failures = 0;
            schedule();
            return;
        }
        // 4xx: wrong token (a newer Clawd took over), no such route, or a
        // rejected request. Retrying cannot help.
        if (status >= 400 && status < 500) return stop();
        failures += 1;
        if (failures >= ${MAX_FAILURES}) return stop();
        pending = true;
        backoffTimer.interval = ${BACKOFF_BASE_MS} * Math.pow(2, failures - 1);
        backoffTimer.start();
    }

    function stop() {
        stopped = true;
        heartbeat.stop();
        sendTimer.stop();
        backoffTimer.stop();
        timeoutTimer.stop();
    }

    Connections {
        target: Workspace
        function onCursorPosChanged() {
            root.pending = true;
            root.schedule();
        }
    }
    Timer { id: sendTimer; repeat: false; onTriggered: root.send() }
    Timer { id: backoffTimer; repeat: false; onTriggered: root.schedule() }
    Timer {
        id: timeoutTimer
        interval: ${REQUEST_TIMEOUT_MS}
        repeat: false
        onTriggered: {
            const xhr = root.active;
            root.finish(0);
            if (xhr) xhr.abort();
        }
    }
    Timer {
        id: heartbeat
        interval: ${HEARTBEAT_MS}
        repeat: true
        running: true
        onTriggered: {
            root.pending = true;
            root.schedule();
        }
    }
    Component.onCompleted: schedule()
}
`;
}

// Body: exactly {"x": <finite number>, "y": <finite number>}; negative values
// are valid (a display left of or above the primary one).
function parseKwinCursorBody(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("x") || !keys.includes("y")) return null;
  const { x, y } = value;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE) return null;
  return { x, y };
}

function tokensEqual(crypto, a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createKwinCursorBridge(options = {}) {
  const {
    kwinScripting,
    fs = require("fs"),
    os = require("os"),
    path = require("path"),
    crypto = require("crypto"),
    spawn = require("child_process").spawn,
    // Monotonic: a wall-clock step must neither fake a lapse nor hide one.
    now = () => performance.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    logWarn = () => {},
  } = options;
  if (!kwinScripting) throw new TypeError("createKwinCursorBridge requires kwinScripting");

  let wanted = false;
  let port = null;
  let token = null;
  let generation = 0;
  // "off" | "loading" | "live" | "lapsed" | "failed"
  let state = "off";
  let point = null;
  let pointAt = 0;
  let liveSince = 0;
  let restarts = 0;
  let restartTimer = null;
  let queue = Promise.resolve();

  const enqueue = (task) => {
    queue = queue.then(task, task);
    return queue;
  };

  const unload = () => new Promise((resolve) => {
    kwinScripting.unloadScript(PLUGIN_NAME, () => resolve());
  });

  const writeScript = (script) => new Promise((resolve, reject) => {
    fs.mkdtemp(path.join(os.tmpdir(), "clawd-kwin-"), (dirErr, dir) => {
      if (dirErr) return reject(dirErr);
      const file = path.join(dir, "main.qml");
      fs.writeFile(file, script, { encoding: "utf8", mode: 0o600 }, (writeErr) => {
        if (writeErr) {
          fs.rm(dir, { recursive: true, force: true }, () => reject(writeErr));
          return;
        }
        resolve({ dir, file });
      });
    });
  });

  const loadAndRun = (file) => new Promise((resolve) => {
    kwinScripting.loadAndRunScript({ scriptPath: file, pluginName: PLUGIN_NAME, declarative: true },
      (reason) => resolve(reason));
  });

  function clearRestartTimer() {
    if (restartTimer) clearTimeoutFn(restartTimer);
    restartTimer = null;
  }

  // Always unload by plugin name first: a script left behind by a crashed or
  // killed Clawd would otherwise keep running beside the new one.
  function load() {
    const myGeneration = ++generation;
    token = crypto.randomBytes(16).toString("hex");
    point = null;
    pointAt = 0;
    state = "loading";
    const script = buildKwinCursorScript({ port, token });
    return enqueue(async () => {
      if (myGeneration !== generation) return;
      await unload();
      if (myGeneration !== generation) return;
      let written;
      try {
        written = await writeScript(script);
      } catch (err) {
        state = "failed";
        logWarn(`Clawd: KWin cursor script not written: ${err && err.message}`);
        return;
      }
      const reason = await loadAndRun(written.file);
      fs.rm(written.dir, { recursive: true, force: true }, () => {});
      if (myGeneration !== generation) {
        // Disabled or reloaded while KWin was loading it.
        if (!reason || reason === "kwin-script-run-failed") await unload();
        return;
      }
      if (reason) {
        state = "failed";
        if (reason === "kwin-script-run-failed") await unload();
        logWarn(`Clawd: KWin cursor script unavailable (${reason}); eye follow keeps the X11 query`);
      }
    });
  }

  function stop() {
    generation++;
    token = null;
    point = null;
    state = "off";
    clearRestartTimer();
    return enqueue(unload);
  }

  // Enable when the session qualifies and eye tracking is on; disable
  // otherwise. Safe to call repeatedly with the same value.
  function setEnabled(enabled, boundPort) {
    if (boundPort !== undefined) port = boundPort;
    const next = !!enabled && Number.isInteger(port);
    if (next === wanted) return queue;
    wanted = next;
    restarts = 0;
    return next ? load() : stop();
  }

  // Startup cleanup when the bridge stays off: a script left behind by a
  // crashed Clawd would keep posting (and be refused) until it stops itself.
  function unloadStale() {
    if (wanted) return queue;
    return enqueue(unload);
  }

  function scheduleRestart() {
    if (restartTimer || restarts >= MAX_RESTARTS) return;
    restarts++;
    restartTimer = setTimeoutFn(() => {
      restartTimer = null;
      if (wanted && state === "lapsed") load();
    }, RESTART_DELAY_MS);
    if (restartTimer && typeof restartTimer.unref === "function") restartTimer.unref();
  }

  // The latest KWin point in DIP, or null when the X11 query should be used.
  function getPoint() {
    if (state !== "live") return null;
    if (now() - pointAt > HEARTBEAT_TIMEOUT_MS) {
      state = "lapsed";
      logWarn("Clawd: KWin cursor heartbeat lapsed; eye follow keeps the X11 query");
      scheduleRestart();
      return null;
    }
    return { x: Math.floor(point.x), y: Math.floor(point.y) };
  }

  function reply(res, status) {
    res.writeHead(status, status === 204 ? {} : { Connection: "close" });
    res.end();
  }

  // POST /kwin-cursor on the local main server, after
  // rejectUnsafeLocalHookRequest. Points are neither logged nor passed to the
  // state machine.
  function handleRequest(req, res) {
    if (!token || !tokensEqual(crypto, req.headers && req.headers[TOKEN_HEADER], token)) {
      return reply(res, 403);
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return reply(res, 413);
    const requestToken = token;
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reply(res, 413);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      // Reloaded or disabled while the body was arriving.
      if (token !== requestToken) return reply(res, 403);
      const parsed = parseKwinCursorBody(Buffer.concat(chunks).toString("utf8"));
      if (!parsed) return reply(res, 400);
      const at = now();
      // A silent gap ends the steady run even when getPoint never saw it (the
      // tick does not read the cursor while the pet sleeps or works).
      const gap = at - pointAt > HEARTBEAT_TIMEOUT_MS;
      point = parsed;
      pointAt = at;
      if (state === "loading" || state === "lapsed") {
        state = "live";
        liveSince = at;
      } else if (gap) {
        liveSince = at;
      } else if (state === "live" && at - liveSince >= STABLE_RESET_MS) {
        restarts = 0;
      }
      reply(res, 204);
    });
    req.on("error", () => { rejected = true; });
  }

  // On quit there is no time to wait for gdbus: hand the unload to a detached
  // process. If it never runs, the script stops by itself once its requests
  // are refused (MAX_FAILURES with backoff, about 15 s).
  function disposeSync() {
    if (!wanted) return;
    wanted = false;
    generation++;
    token = null;
    state = "off";
    clearRestartTimer();
    try {
      const child = spawn("gdbus", [
        "call", "--session", "--dest", "org.kde.KWin", "--object-path", "/Scripting",
        "--method", "org.kde.kwin.Scripting.unloadScript", PLUGIN_NAME,
      ], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    } catch {}
  }

  return {
    setEnabled,
    unloadStale,
    getPoint,
    handleRequest,
    disposeSync,
    getStatus: () => state,
  };
}

module.exports = {
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
};
