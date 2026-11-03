"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOKEN_RE = /^[a-f0-9]{32,64}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const CID_RE = /^c_[A-Za-z0-9_-]{22}$/;
const PAIR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_DEVICES = 20;

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function atomicWrite(filePath, value, io = fs) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    io.mkdirSync(path.dirname(filePath), { recursive: true });
    fd = io.openSync(tmp, "wx", 0o600);
    io.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    io.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
    try { io.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function newPairing(now) {
  const bytes = crypto.randomBytes(8);
  return { code: Array.from(bytes, (byte) => PAIR_ALPHABET[byte & 31]).join(""), expiresAt: now + PAIR_TTL_MS };
}

function validLegacy(legacy) {
  return !!legacy && Array.isArray(legacy.graceHashes)
    && legacy.graceHashes.every((h) => HASH_RE.test(h))
    && (legacy.deadTokenHash === null || HASH_RE.test(legacy.deadTokenHash));
}

function validPairing(pairing) {
  return !!pairing && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(pairing.code)
    && Number.isFinite(pairing.expiresAt);
}

function validDevice(device) {
  if (!device || !/^d_[a-f0-9]{16}$/.test(device.id) || !CID_RE.test(device.cid)
      || typeof device.name !== "string" || !["pair", "legacy"].includes(device.origin)
      || !["pending", "active"].includes(device.state)
      || !Number.isInteger(device.currentGen) || device.currentGen < 0
      || !Number.isFinite(device.createdAt) || !Number.isFinite(device.lastSeenAt)
      || !(device.pairCodeHash === null || HASH_RE.test(device.pairCodeHash))) return false;
  if (device.pairCodeHash !== null && (device.origin !== "pair" || device.state !== "pending")) return false;
  if (device.state === "pending") {
    if (device.currentHash !== null || device.currentGen !== 0 || device.currentIssuedAt !== null || !device.staged) return false;
  } else if (!HASH_RE.test(device.currentHash) || device.currentGen < 1 || !Number.isFinite(device.currentIssuedAt)) return false;
  return device.staged === null
    ? device.stagedGen === null
    : TOKEN_RE.test(device.staged) && device.stagedGen === device.currentGen + 1;
}

function validState(state) {
  if (!state || state.version !== 2 || !Array.isArray(state.devices) || state.devices.length > MAX_DEVICES
      || !validLegacy(state.legacy) || !validPairing(state.pairing)) return false;
  const ids = new Set();
  return state.devices.every((device) => {
    if (!validDevice(device) || ids.has(device.id)) return false;
    ids.add(device.id);
    return true;
  });
}

function createMobileDeviceStore(options) {
  const { tokenPath, now, log } = options;
  const devicesPath = options.devicesPath || path.join(path.dirname(tokenPath), "mobile-devices.json");
  const io = options.fs || fs;
  const writeToken = options.writeTokenState || ((file, value) => atomicWrite(file, value, io));
  const writeDevices = options.writeDeviceState || ((file, value) => atomicWrite(file, value, io));
  let paused = false;
  let dirty = false;
  let state;
  let tokenState;
  const legacyHashes = new Set();
  const lastSeen = new Map();
  let lastSeenFlush = now();

  function write(writer, file, value) {
    if (writer(file, value) === false) throw new Error("Failed to persist mobile access");
  }

  let deviceReadError = null;
  let tokenReadError = null;
  try {
    state = JSON.parse(io.readFileSync(devicesPath, "utf8"));
    if (!validState(state)) throw new Error("Invalid mobile device store");
  } catch (err) { deviceReadError = err; }
  try {
    const raw = JSON.parse(io.readFileSync(tokenPath, "utf8"));
    if (!raw || typeof raw.token !== "string" || !TOKEN_RE.test(raw.token)) throw new Error("Invalid legacy token file");
    tokenState = raw;
  } catch (err) { tokenReadError = err; }

  if (deviceReadError) {
    if (deviceReadError.code !== "ENOENT") {
      try {
        io.renameSync(devicesPath, `${devicesPath}.corrupt-${now()}`);
        log("[mobile-preview] corrupt device store preserved; devices need pairing again");
      } catch {
        paused = true;
        log("[mobile-preview] cannot preserve corrupt device store; device access paused");
      }
    }
    state = { version: 2, devices: [], legacy: { graceHashes: [], deadTokenHash: null }, pairing: newPairing(now()) };
    dirty = true;
  }
  if (tokenReadError) {
    tokenState = { token: crypto.randomBytes(16).toString("hex"), previous: null, graceUntil: null, rotatedAt: now(), rotationPending: false };
    write(writeToken, tokenPath, tokenState);
    state.legacy.deadTokenHash = hash(tokenState.token);
    dirty = true;
  }
  if (process.platform !== "win32") {
    // Credentials must stay owner-only: clear setuid/setgid/sticky, owner execute,
    // and all group/other access bits.
    try { if (io.statSync(tokenPath).mode & 0o7177) io.chmodSync(tokenPath, 0o600); }
    catch { log("[mobile-preview] cannot restrict legacy token file permissions"); }
  }
  // Stale device-file bookkeeping must not resurrect tokens removed by a reset.
  if (hash(tokenState.token) !== state.legacy.deadTokenHash) legacyHashes.add(hash(tokenState.token));
  if (TOKEN_RE.test(tokenState.previous || "")) {
    const previousHash = hash(tokenState.previous);
    if (tokenState.graceUntil > now() || state.legacy.graceHashes.includes(previousHash)) {
      legacyHashes.add(previousHash);
      if (!state.legacy.graceHashes.includes(previousHash)) {
        state.legacy.graceHashes.push(previousHash);
        dirty = true;
      }
    }
  }
  if (state.pairing.expiresAt <= now()) { state.pairing = newPairing(now()); dirty = true; }

  function retryPersistence() {
    if (!dirty || paused) return;
    try { write(writeDevices, devicesPath, state); dirty = false; }
    catch { log("[mobile-preview] device store persistence deferred"); }
  }
  retryPersistence();

  function commit(update) {
    if (paused) throw new Error("Mobile device access paused");
    // A failed write must leave the accepted credentials unchanged.
    const next = JSON.parse(JSON.stringify(state));
    const flushSeen = now() - lastSeenFlush >= 10 * 60 * 1000;
    if (flushSeen) {
      for (const device of next.devices) device.lastSeenAt = lastSeen.get(device.id) || device.lastSeenAt;
    }
    const result = update(next);
    write(writeDevices, devicesPath, next);
    state = next;
    for (const id of lastSeen.keys()) {
      if (!state.devices.some((device) => device.id === id)) lastSeen.delete(id);
    }
    if (flushSeen) lastSeenFlush = now();
    dirty = false;
    return result;
  }

  function refreshPairCode() {
    return commit((next) => { next.pairing = newPairing(now()); return { ...next.pairing }; });
  }

  function getPairing() {
    if (state.pairing.expiresAt <= now()) refreshPairCode();
    return { ...state.pairing };
  }

  function createDevice(next, cid, origin, userAgent, pairCodeHash = null) {
    const browser = /Edg\//.test(userAgent) ? "Edge" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
    const platform = /iPhone/.test(userAgent) ? "iPhone" : /iPad/.test(userAgent) ? "iPad" : /Android/.test(userAgent) ? "Android" : "Mobile";
    const device = {
      id: "d_" + crypto.randomBytes(8).toString("hex"),
      name: `${platform} · ${browser}`,
      cid,
      origin,
      state: "pending",
      currentHash: null,
      currentGen: 0,
      currentIssuedAt: null,
      staged: crypto.randomBytes(16).toString("hex"),
      stagedGen: 1,
      pairCodeHash,
      createdAt: now(),
      lastSeenAt: now(),
    };
    next.devices.push(device);
    return device;
  }

  function invalidateLegacy() {
    const next = { token: crypto.randomBytes(16).toString("hex"), previous: null, graceUntil: null, rotatedAt: now(), rotationPending: false };
    try { write(writeToken, tokenPath, next); }
    catch { throw Object.assign(new Error("Failed to persist legacy revocation"), { legacyRevoked: false }); }
    legacyHashes.clear();
    return hash(next.token);
  }

  return {
    getState: () => state,
    listDevices: () => state.devices.map((device) => ({
      id: device.id,
      name: device.name,
      origin: device.origin,
      state: device.state,
      createdAt: device.createdAt,
      lastSeenAt: lastSeen.get(device.id) ?? device.lastSeenAt,
      currentIssuedAt: device.currentIssuedAt,
    })),
    isLegacyActive: () => legacyHashes.size > 0,
    acceptsLegacy: (token) => typeof token === "string" && legacyHashes.has(hash(token)),
    isPaused: () => paused,
    recordSeen: (id) => lastSeen.set(id, now()),
    commit, createDevice, getPairing, refreshPairCode, invalidateLegacy, retryPersistence,
  };
}

module.exports = { createMobileDeviceStore, atomicWrite, hash, CID_RE, MAX_DEVICES, newPairing };
