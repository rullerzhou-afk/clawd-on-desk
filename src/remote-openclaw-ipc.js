"use strict";

// ── Remote OpenClaw IPC ──
//
// Owns the single remote-gateway connection lifecycle and bridges it to
// `window.remoteOpenclaw.*`:
//
//   invokes  : status / connect / disconnect
//              credential-status / set-credential / clear-credential
//   push     : "remoteOpenclaw:status-changed" → every renderer window
//
// Unlike Remote SSH there is exactly one gateway (no profiles), so config
// comes straight from `prefs.remoteOpenclaw` and every change is reconciled by
// `sync()` — start when enabled and complete, stop when disabled or
// incomplete. main.js calls `sync()` once at boot and again from
// `subscribeKey("remoteOpenclaw", ...)`, which keeps the connection in step
// with the settings UI without the runtime ever reading prefs itself.
//
// The credential never travels through prefs (or therefore through renderer
// snapshots): it is read from the safeStorage-backed store on the main side
// only, and only when a connection is actually being opened.

const { createRemoteOpenclawRuntime } = require("./remote-openclaw-runtime");
const { normalizeGatewayUrl } = require("./remote-openclaw-protocol");

function requireDep(value, name) {
  if (!value) throw new Error(`registerRemoteOpenclawIpc requires ${name}`);
  return value;
}

function broadcast(BrowserWindow, channel, payload) {
  try {
    for (const bw of BrowserWindow.getAllWindows()) {
      if (!bw.isDestroyed() && bw.webContents && !bw.webContents.isDestroyed()) {
        bw.webContents.send(channel, payload);
      }
    }
  } catch {
    // Best-effort — a dead window must not take the runtime down with it.
  }
}

// Identifies "the same connection". A change to any of these means we must
// tear the socket down and re-handshake; unrelated prefs changes must not.
// The credential is deliberately absent: it lives outside prefs, so changing
// it goes through set-credential / clear-credential, which reset the
// signature explicitly.
function signatureOf(config) {
  return [
    config.enabled === true ? "1" : "0",
    typeof config.url === "string" ? config.url : "",
    config.authMode === "token" ? "token" : "password",
    typeof config.agentFilter === "string" ? config.agentFilter : "",
  ].join(" ");
}

function registerRemoteOpenclawIpc(options = {}) {
  const ipcMain = requireDep(options.ipcMain, "ipcMain");
  const settingsController = requireDep(options.settingsController, "settingsController");
  const BrowserWindow = requireDep(options.BrowserWindow, "BrowserWindow");
  // Test-only injection points. Production main.js never overrides these.
  const createRuntime = options.createRuntime || createRemoteOpenclawRuntime;
  const credentialStore = options.credentialStore || null;
  const getHookServerPort = typeof options.getHookServerPort === "function"
    ? options.getHookServerPort
    : null;
  const version = typeof options.version === "string" ? options.version : "0.0.0";
  const log = options.log || (() => {});

  const disposers = [];

  let runtime = null;
  let activeSignature = "";
  let status = { phase: "stopped", detail: "", at: 0 };

  function setStatus(phase, detail) {
    status = { phase, detail: detail || "", at: Date.now() };
    broadcast(BrowserWindow, "remoteOpenclaw:status-changed", status);
  }

  function readConfig() {
    const value = settingsController.get("remoteOpenclaw");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  // Returns "" when nothing usable is stored. Never logs the secret itself.
  function readCredential() {
    if (!credentialStore || typeof credentialStore.load !== "function") return "";
    try {
      const loaded = credentialStore.load();
      return loaded && typeof loaded.secret === "string" ? loaded.secret : "";
    } catch (error) {
      log("credential load failed:", error && error.code ? error.code : (error && error.message));
      return "";
    }
  }

  function buildRuntimeOptions(config, credential) {
    const isToken = config.authMode === "token";
    const filter = typeof config.agentFilter === "string" ? config.agentFilter.trim() : "";
    const hookPort = getHookServerPort ? Number(getHookServerPort()) : 0;
    return {
      url: normalizeGatewayUrl(config.url),
      password: isToken ? "" : credential,
      token: isToken ? credential : "",
      // The filter field is free text: it may name an agent or a session, so
      // match either. An empty filter means "follow everything".
      sessionFilter: filter ? { agentId: filter, sessionId: filter } : null,
      version,
      http: Number.isInteger(hookPort) && hookPort > 0 ? { ports: [hookPort] } : undefined,
      onStatus: (next) => {
        status = next && typeof next === "object" ? next : status;
        broadcast(BrowserWindow, "remoteOpenclaw:status-changed", status);
      },
    };
  }

  function stopRuntime(phase, detail) {
    if (runtime) {
      try { runtime.stop(); } catch (err) { log("stop failed:", err && err.message); }
      runtime = null;
    }
    if (phase) setStatus(phase, detail);
  }

  // Reconcile the connection with the current prefs. Idempotent: a sync that
  // changes nothing must not drop the socket (settings-changed fires for
  // every field of every tab).
  function sync() {
    const config = readConfig();
    const signature = signatureOf(config);

    if (config.enabled !== true) {
      activeSignature = signature;
      stopRuntime("stopped", "");
      return;
    }

    const url = normalizeGatewayUrl(config.url);
    if (!url) {
      activeSignature = signature;
      stopRuntime("error", "missing gateway url");
      return;
    }

    const isToken = config.authMode === "token";
    const credential = readCredential();
    if (!credential) {
      activeSignature = signature;
      stopRuntime("error", isToken ? "missing token" : "missing password");
      return;
    }

    if (runtime && signature === activeSignature) return;

    stopRuntime(null);
    activeSignature = signature;
    try {
      runtime = createRuntime(buildRuntimeOptions(config, credential));
      runtime.start();
    } catch (err) {
      runtime = null;
      setStatus("error", String((err && err.message) || "failed to start"));
    }
  }

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => {
      try { ipcMain.removeHandler(channel); } catch {}
    });
  }

  handle("remoteOpenclaw:status", () => ({ status: "ok", state: status }));

  // Manual controls. `connect` re-reads prefs rather than trusting whatever
  // the UI last rendered, and `disconnect` only parks the socket — it does not
  // clear `enabled`, so a later sync (or restart) can bring it back.
  handle("remoteOpenclaw:connect", () => {
    activeSignature = "";
    sync();
    return { status: "ok", state: status };
  });

  handle("remoteOpenclaw:disconnect", () => {
    stopRuntime("stopped", "");
    return { status: "ok", state: status };
  });

  // ── Credential ──
  //
  // Deliberately NOT routed through settingsAPI.update: that path would put
  // the gateway credential into prefs and therefore into every renderer's
  // settings snapshot. Answers carry only an opaque id and a flag.
  handle("remoteOpenclaw:credential-status", () => {
    if (!credentialStore) return { status: "ok", configured: false, available: false };
    const info = credentialStore.inspect ? credentialStore.inspect() : { configured: false };
    return {
      status: "ok",
      configured: info.configured === true && info.decryptable === true,
      available: true,
      reason: info.reason || "",
      updatedAt: info.updatedAt || 0,
    };
  });

  handle("remoteOpenclaw:set-credential", (_event, secret) => {
    if (!credentialStore || typeof credentialStore.save !== "function") {
      return { status: "error", message: "credential storage is unavailable" };
    }
    try {
      const saved = credentialStore.save(String(secret == null ? "" : secret));
      // The stored secret changed under the running socket — force a reconnect
      // so the next handshake presents it.
      activeSignature = "";
      sync();
      return { status: "ok", credentialId: saved.credentialId, state: status };
    } catch (error) {
      return {
        status: "error",
        message: (error && error.message) || "could not save the credential",
        code: (error && error.code) || "",
      };
    }
  });

  handle("remoteOpenclaw:clear-credential", () => {
    if (credentialStore && typeof credentialStore.forget === "function") {
      try { credentialStore.forget(); } catch (err) { log("forget failed:", err && err.message); }
    }
    activeSignature = "";
    sync();
    return { status: "ok", state: status };
  });

  function dispose() {
    stopRuntime(null);
    while (disposers.length) {
      const d = disposers.pop();
      try { d(); } catch {}
    }
  }

  return { dispose, sync, getStatus: () => status };
}

module.exports = { registerRemoteOpenclawIpc, signatureOf };
