"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { discoverDshDesktopSync } = require("../hooks/dsh-install");

const DSH_DESKTOP_EXE_NAME = "DeepSeek Harness.exe";
// A GUI launch cannot be proven, but the promise must not hang: a child that
// neither errors nor reports a lifecycle event is settled as unconfirmed.
const DSH_LAUNCH_CONFIRM_TIMEOUT_MS = 15000;

function sanitizeFocusError(err) {
  return err && err.message ? err.message.replace(/[\r\n\t]+/g, " ") : "unknown";
}

// Discovery outcomes that are not a verified unique install each get their own
// reason so an unresolved candidate is not logged as "not installed".
function discoveryStatusReason(discovery) {
  if (discovery && discovery.status === "ambiguous") return "desktop-ambiguous";
  if (discovery && discovery.status === "unknown") return "desktop-unconfirmed";
  return "desktop-not-found";
}

// Keep the failure cause visible without changing the stable reason= token.
function launchResultDetail(result) {
  if (!result || typeof result !== "object") return "";
  if (result.errorCode) return ` code=${result.errorCode}`;
  if (Number.isFinite(result.exitCode)) return ` exit=${result.exitCode}`;
  if (result.error) return ` error=${result.error}`;
  return "";
}

// Electron exports ELECTRON_RUN_AS_NODE and friends that would make the app
// boot as a Node process instead of a GUI. A GUI launch needs a clean
// environment; for the Windows executable form the keys are case-insensitive.
function stripElectronLaunchEnv(sourceEnv) {
  const env = {};
  const source = sourceEnv && typeof sourceEnv === "object" ? sourceEnv : {};
  for (const key of Object.keys(source)) {
    if (key.toUpperCase().startsWith("ELECTRON_") || key.toUpperCase() === "NODE_OPTIONS") continue;
    env[key] = source[key];
  }
  return env;
}

// Launch the verified desktop app as a GUI. This is intentionally not the
// installer's desktopCommandInfo: that describes the bundled CLI (Node mode
// with a cli.js prefix), which would never restore the app window. The macOS
// `open` and the Windows executable both fall through the app's single-instance
// callback, so an already-running instance is brought to the front.
// Resolves once with a launch outcome; never rejects. `spawn` can return a
// child that fails later (ENOENT/EACCES), and macOS `open` can exit non-zero
// even after a successful fork, so a synchronous try/catch alone would both
// miss failures and report success too early.
function launchDshDesktopApp({
  discoverDesktop = discoverDshDesktopSync,
  osPlatform = process.platform,
  spawnImpl = spawn,
  env = process.env,
  pathImpl = path,
  launchTimeoutMs = DSH_LAUNCH_CONFIRM_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (osPlatform !== "darwin" && osPlatform !== "win32") {
    return Promise.resolve({ launched: false, reason: "desktop-not-found" });
  }
  let discovery;
  try {
    // The app-focus fallback must not pick one of several valid installs, so it
    // asks discovery for a uniqueness verdict instead of the installer default.
    discovery = discoverDesktop({ platform: osPlatform, requireUniqueApp: true });
  } catch {
    return Promise.resolve({ launched: false, reason: "desktop-not-found" });
  }
  if (!discovery || discovery.status !== "found" || !discovery.appRoot) {
    return Promise.resolve({
      launched: false,
      reason: discoveryStatusReason(discovery),
    });
  }
  let command;
  let args;
  if (osPlatform === "darwin") {
    command = "/usr/bin/open";
    args = [discovery.appRoot];
  } else {
    command = pathImpl.win32.join(discovery.appRoot, DSH_DESKTOP_EXE_NAME);
    args = [];
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeoutImpl(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawnImpl(command, args, {
        detached: true,
        stdio: "ignore",
        env: stripElectronLaunchEnv(env),
      });
    } catch {
      finish({ launched: false, reason: "launch-failed" });
      return;
    }
    timer = setTimeoutImpl(
      () => finish({ launched: false, reason: "launch-unconfirmed" }),
      launchTimeoutMs
    );
    if (timer && typeof timer.unref === "function") timer.unref();
    if (!child || typeof child.on !== "function") {
      if (child && typeof child.unref === "function") child.unref();
      finish({ launched: true, reason: "launched" });
      return;
    }
    child.once("error", (err) => {
      finish({
        launched: false,
        reason: "launch-failed",
        error: sanitizeFocusError(err),
        errorCode: err && typeof err.code === "string" ? err.code : null,
      });
    });
    if (osPlatform === "win32") {
      // A created GUI process is the best proof available on Windows; its
      // single-instance callback restores the window, so do not wait for exit.
      child.once("spawn", () => {
        if (typeof child.unref === "function") child.unref();
        finish({ launched: true, reason: "launched" });
      });
    } else {
      // `/usr/bin/open` exits quickly; its exit code is the real result.
      child.once("exit", (code) => {
        if (typeof child.unref === "function") child.unref();
        if (code === 0) finish({ launched: true, reason: "launched" });
        else finish({ launched: false, reason: "launch-failed", exitCode: code });
      });
    }
  });
}

function focusDshDesktopTarget({
  shell,
  focusEntry,
  sessionId,
  requestSource = "dashboard",
  url,
  focusLog = () => {},
  discoverDesktop,
  osPlatform,
  spawnImpl,
  env,
  pathImpl,
  launchTimeoutMs,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  if (!url || !shell || typeof shell.openExternal !== "function") return null;
  const id = String(sessionId || (focusEntry && focusEntry.id) || "");
  focusLog(`focus request source=${requestSource} sid=${id} agent=${(focusEntry && focusEntry.agentId) || "-"} target=dsh-desktop`);
  return Promise.resolve()
    .then(() => shell.openExternal(url))
    .then(() => {
      focusLog(`focus result branch=dsh-desktop reason=opened source=${requestSource} sid=${id}`);
    })
    .catch((err) => {
      focusLog(`focus result branch=dsh-desktop reason=open-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
      // The final branch is recorded only once the launch has a result; a
      // rejected open plus a background process failure must never escape.
      return Promise.resolve()
        .then(() => launchDshDesktopApp({
          discoverDesktop,
          osPlatform,
          spawnImpl,
          env,
          pathImpl,
          launchTimeoutMs,
          setTimeoutImpl,
          clearTimeoutImpl,
        }))
        .then((result) => {
          focusLog(`focus result branch=dsh-desktop reason=${result.reason} source=${requestSource} sid=${id}${launchResultDetail(result)}`);
        })
        .catch((launchErr) => {
          focusLog(`focus result branch=dsh-desktop reason=launch-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(launchErr)}`);
        });
    });
}

function focusCodexThreadTarget({
  shell,
  focusEntry,
  sessionId,
  requestSource = "dashboard",
  url,
  focusLog = () => {},
  focusTerminalSession = () => false,
}) {
  if (!url || !shell || typeof shell.openExternal !== "function") return null;
  const id = String(sessionId || (focusEntry && focusEntry.id) || "");
  focusLog(`focus request source=${requestSource} sid=${id} agent=${(focusEntry && focusEntry.agentId) || "-"} target=codex-thread`);
  return Promise.resolve()
    .then(() => shell.openExternal(url))
    .then(() => {
      focusLog(`focus result branch=codex-thread reason=opened source=${requestSource} sid=${id}`);
    })
    .catch((err) => {
      focusLog(`focus result branch=codex-thread reason=open-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
      return Promise.resolve()
        .then(() => focusTerminalSession(focusEntry, id, requestSource))
        .then((focused) => {
          if (!focused) {
            focusLog(`focus result branch=none reason=codex-thread-fallback-no-source-pid source=${requestSource} sid=${id}`);
          }
        })
        .catch((fallbackErr) => {
          focusLog(`focus result branch=none reason=codex-thread-fallback-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(fallbackErr)}`);
        });
    });
}

module.exports = {
  focusCodexThreadTarget,
  focusDshDesktopTarget,
  launchDshDesktopApp,
  sanitizeFocusError,
  stripElectronLaunchEnv,
};
