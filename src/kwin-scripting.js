"use strict";

// ── KDE Plasma 6: load scripts into KWin over D-Bus ──
//
// KWin runs scripts inside the compositor, which is how Clawd reaches things a
// Wayland client cannot: raising another app's window (#1001, src/focus.js) and
// the global cursor position (#1410, src/linux-kwin-cursor.js). Both go
// through `gdbus call` so no D-Bus binding is needed.
//
// execFile is injected rather than required here: focus.js tests swap
// child_process.execFile out before requiring focus.js, and a module cached
// with the real one would slip past that mock.

const DEFAULT_TIMEOUT_MS = 1500;

// gdbus prints a reply as a GVariant tuple, e.g. `(uint32 4633,)` or `(0,)`.
function parseGdbusInteger(stdout) {
  const match = String(stdout || "").trim().match(/^\((?:[a-z]+\d*\s+)?(-?\d+),\)$/);
  return match ? Number(match[1]) : null;
}

// e.g. `('~ : claude',)`; GVariant switches to double quotes when the string
// itself holds a single quote.
function parseGdbusString(stdout) {
  const match = String(stdout || "").trim().match(/^\((['"])(.*)\1,\)$/s);
  return match ? match[2].replace(/\\(.)/g, "$1") : null;
}

function createKwinScripting({ execFile, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof execFile !== "function") throw new TypeError("createKwinScripting requires execFile");

  function gdbusCall(dest, objectPath, method, args, callback) {
    execFile("gdbus", [
      "call", "--session", "--dest", dest, "--object-path", objectPath, "--method", method, ...args,
    ], { timeout: timeoutMs, encoding: "utf8" }, callback);
  }

  // Loads the script file under pluginName and starts it. KWin reads the file
  // during these calls, so the caller may delete it once callback runs.
  // callback(reason, scriptId): reason is null on success, otherwise
  // "kwin-script-load-failed" or "kwin-script-run-failed" (the script stays
  // loaded in that case; unload it by plugin name).
  function loadAndRunScript({ scriptPath, pluginName, declarative = false }, callback) {
    const loadMethod = declarative
      ? "org.kde.kwin.Scripting.loadDeclarativeScript"
      : "org.kde.kwin.Scripting.loadScript";
    gdbusCall("org.kde.KWin", "/Scripting", loadMethod, [scriptPath, pluginName], (loadErr, loadOut) => {
      const scriptId = loadErr ? null : parseGdbusInteger(loadOut);
      if (scriptId === null || scriptId < 0) return callback("kwin-script-load-failed", null);
      gdbusCall("org.kde.KWin", `/Scripting/Script${scriptId}`, "org.kde.kwin.Script.run", [], (runErr) => {
        callback(runErr ? "kwin-script-run-failed" : null, scriptId);
      });
    });
  }

  // Unloading a plugin name that is not loaded is a no-op on KWin's side.
  function unloadScript(pluginName, callback = () => {}) {
    gdbusCall("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", [pluginName],
      (err) => callback(err || null));
  }

  return { gdbusCall, loadAndRunScript, unloadScript };
}

module.exports = {
  createKwinScripting,
  parseGdbusInteger,
  parseGdbusString,
};
