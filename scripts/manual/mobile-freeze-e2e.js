#!/usr/bin/env node
"use strict";

// Run outside the sandbox: CHROME_PATH="/path/to/chrome" node scripts/manual/mobile-freeze-e2e.js
// Optional: CLAWD_MOBILE_ROTATION_MS=2000, MOBILE_FREEZE_MS=310000,
// MOBILE_COEXIST_MS=600000, MOBILE_FREEZE_CASES=long,restart,two-tabs,two-rotations,coexist,reset,storage.
// Shorter durations are smoke checks, not five-minute-grace / ten-minute-coexistence evidence.
// Uses raw Chrome/CDP. If bringToFront leaves the page hidden, a reported test-only
// visibility hook supplies both visibilityState=visible and >30s hidden duration.
// This script lives outside test/*.test.js and is intentionally excluded from CI.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");
const { initMobilePreviewServer } = require("../../src/network/mobile-preview-server");
const { atomicWrite } = require("../../src/network/mobile-device-store");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rotationMs = positiveEnv("CLAWD_MOBILE_ROTATION_MS", 2000);
const freezeMs = positiveEnv("MOBILE_FREEZE_MS", 310000);
const coexistMs = positiveEnv("MOBILE_COEXIST_MS", 600000);
const selected = new Set((process.env.MOBILE_FREEZE_CASES || "long,restart,two-tabs,two-rotations,coexist,reset,storage").split(","));

function positiveEnv(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function describeLongFreeze(preserve, closeEvents, thawedAt) {
  const disconnected = closeEvents.some((event) => event.code === 1006 && event.at >= thawedAt);
  if (!preserve) assert.ok(disconnected, "Default Chrome must expose a thaw disconnect to the page");
  return disconnected ? "disconnect recovery; not #663 preserved-socket coverage" : "preserved socket";
}

async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out: ${description}`);
}

async function waitForPromotionAndClose(desktop, deviceId, gen, frozenRecord) {
  await until(
    () => desktop.state().devices.some((device) => device.id === deviceId && device.currentGen >= gen),
    "desktop device promotion",
    rotationMs * 4 + 15000
  );
  await until(() => frozenRecord.sentCode === 4002, "X token-rotated close");
}

async function waitDuration(ms, label) {
  const start = Date.now();
  let lastReport = start;
  while (Date.now() - start < ms) {
    await pause(Math.min(500, ms - (Date.now() - start)));
    if (Date.now() - lastReport >= 30000) {
      console.log(`${label}: ${Math.round((Date.now() - start) / 1000)}s`);
      lastReport = Date.now();
    }
  }
}

async function launchChrome(preserveSocket) {
  if (!process.env.CHROME_PATH) throw new Error("Set CHROME_PATH to the system Chrome executable");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-freeze-chrome-"));
  const args = ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check"];
  if (preserveSocket) args.push("--disable-blink-features=DisconnectWebSocketOnBFCache");
  args.push("about:blank");
  const child = spawn(process.env.CHROME_PATH, args, { stdio: "ignore" });
  let exited = false, launchError;
  child.on("error", (err) => { launchError = err; });
  const exit = new Promise((resolve) => child.once("exit", () => { exited = true; resolve(); }));
  let socket;
  async function cleanup() {
    if (socket) socket.close();
    if (!exited && !launchError) {
      child.kill("SIGTERM");
      await Promise.race([exit, pause(3000)]);
      if (!exited) { child.kill("SIGKILL"); await exit; }
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  try {
    const endpoint = await until(() => {
      if (launchError) throw launchError;
      if (exited) throw new Error("Chrome exited before CDP was ready");
      try {
        const [port, endpointPath] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").trim().split("\n");
        return `ws://127.0.0.1:${port}${endpointPath}`;
      } catch { return null; }
    }, "Chrome CDP startup");
    const port = new URL(endpoint).port;
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    console.log(`Chrome ${version.Browser}; preserve frozen sockets=${preserveSocket}`);
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    let nextId = 0;
    const pending = new Map();
    socket.on("message", (data) => {
      const msg = JSON.parse(data);
      if (!msg.id || !pending.has(msg.id)) return;
      const task = pending.get(msg.id); pending.delete(msg.id); clearTimeout(task.timer);
      if (msg.error) task.reject(new Error(msg.error.message)); else task.resolve(msg.result || {});
    });
    function send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
    return { send, cleanup };
  } catch (err) { await cleanup(); throw err; }
}

function instrumentation(label, failStorage) {
  return `(() => {
    const probe = window.__freezeProbe = {ticks:0,messages:0,acks:0,freezes:[],resumes:[],closes:[],writes:[],rotations:[]};
    const counts = () => ({ticks:probe.ticks,messages:probe.messages,acks:probe.acks,at:Date.now()});
    setInterval(() => probe.ticks++, 100);
    document.addEventListener('freeze', () => probe.freezes.push(counts()));
    document.addEventListener('resume', () => probe.resumes.push(counts()));
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (${JSON.stringify(failStorage)} && key.startsWith('clawd-')) throw new Error('test storage unavailable');
      originalSet.call(this, key, value);
      if(key === 'clawd-cred-v2') { const v=JSON.parse(value); probe.writes.push({deviceId:v.deviceId,gen:v.gen,at:Date.now()}); }
    };
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url) {
        const u = new URL(url); u.searchParams.set('probe', ${JSON.stringify(label)});
        super(u.href);
        this.addEventListener('message', () => probe.messages++);
        this.addEventListener('close', e => probe.closes.push({code:e.code,at:Date.now()}));
      }
      send(value) {
        try { if(JSON.parse(value).type === 'token_rotate_ack') probe.acks++; } catch {}
        return super.send(value);
      }
    };
  })()`;
}

async function page(chrome, contextId, label, url, failStorage = false) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank", browserContextId: contextId });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => chrome.send(method, params, sessionId);
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: instrumentation(label, failStorage) });
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error("Page evaluation failed");
    return result.result.value;
  }
  await send("Page.navigate", { url });
  await until(() => evaluate("!!window._clawdApp"), `${label} app initialization`);
  const result = { label, send, evaluate,
    connected: () => until(() => evaluate("window._clawdApp.connection.state === 'connected'"), `${label} snapshot`),
    credential: () => evaluate("JSON.parse(localStorage.getItem('clawd-cred-v2') || 'null')"),
  };
  return result;
}

async function desktop(rotation = rotationMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-freeze-server-"));
  const tokenPath = path.join(dir, "mobile-token.json");
  const legacy = crypto.randomBytes(16).toString("hex");
  atomicWrite(tokenPath, { token: legacy });
  const records = [];
  let server;
  async function start() {
    server = initMobilePreviewServer({ tokenPath, sessions: new Map(), rotationMs: rotation, heartbeatMs: 500, log() {},
      createWebSocketServer(options) {
        const wss = new WebSocket.Server(options);
        wss.on("connection", (ws, req) => {
          const url = new URL(req.url, "http://localhost");
          const record = { ws, label: url.searchParams.get("probe"), pair: url.searchParams.has("pair"),
            openedAt: Date.now(), pongs: [], closeSentAt: null, closedAt: null };
          records.push(record);
          ws.on("pong", () => record.pongs.push(Date.now()));
          ws.on("close", (code) => { record.closedAt = Date.now(); record.closeCode = code; });
          const close = ws.close.bind(ws);
          ws.close = (code, reason) => { record.closeSentAt = Date.now(); record.sentCode = code; close(code, reason); };
        });
        return wss;
      },
    });
    await server.start();
  }
  await start();
  const beacon = setInterval(() => {
    for (const r of records) if (!r.pair && r.ws.readyState === WebSocket.OPEN) r.ws.send(JSON.stringify({ type: "freeze_probe" }));
  }, 500);
  return {
    records,
    get server() { return server; },
    get base() { return `http://127.0.0.1:${server.getPort()}/mobile/`; },
    get legacyUrl() { return this.base + "?token=" + legacy; },
    state: () => JSON.parse(fs.readFileSync(path.join(dir, "mobile-devices.json"), "utf8")),
    async restart() { const port = server.getPort(); await server.cleanup(); await start(); assert.equal(server.getPort(), port, "restart must preserve origin"); },
    async cleanup() { clearInterval(beacon); await server.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function instrumentRotation(p) {
  await p.evaluate(`(() => {
    const c=window._clawdApp.connection, rotate=c._rotate.bind(c);
    c._rotate=function(msg,used) {
      const s=this._readCredential();
      window.__freezeProbe.rotations.push({gen:msg.gen,storedGen:s&&s.gen,storedDevice:s&&s.deviceId,deviceId:msg.deviceId});
      return rotate(msg,used);
    };
  })()`);
}

async function freeze(p, d) {
  const record = d.records.findLast((r) => r.label === p.label && !r.pair && r.ws.readyState === WebSocket.OPEN);
  assert.ok(record, "requires an open data socket before freezing");
  const writeCount = await p.evaluate("window.__freezeProbe.writes.length");
  const started = Date.now();
  await p.send("Page.setWebLifecycleState", { state: "frozen" });
  return { record, started, writeCount, pongs: record.pongs.length };
}

function checkFrozenTransport(frozen) {
  const { record } = frozen;
  assert.equal(record.closeSentAt, null, "socket closed before the expected disconnect event; classify as disconnect recovery, not #663");
  assert.equal(record.closedAt, null, "network socket must survive the frozen interval");
  assert.ok(record.pongs.length - frozen.pongs >= 2, "network must keep replying to ping while JS is frozen");
  const during = record.pongs.filter((at) => at >= frozen.started);
  assert.ok(during.every((at, i) => !i || at - during[i - 1] < 15000), "pong coverage has an unexplained gap");
}

async function thaw(p, frozen, queueFirst = false) {
  const thawedAt = Date.now();
  await p.send("Page.setWebLifecycleState", { state: "active" });
  await until(() => p.evaluate("window.__freezeProbe.resumes.length > 0"), "page resume event");
  // This delay deliberately lets queued rotation/close handlers run while hidden.
  if (queueFirst) await pause(500);
  const probe = await p.evaluate("window.__freezeProbe");
  assert.ok(probe.freezes.length && probe.resumes.length, "Chrome did not emit freeze/resume; this is not a frozen-JS test");
  const before = probe.freezes.at(-1), after = probe.resumes.at(-1);
  for (const key of ["ticks", "messages", "acks"]) assert.equal(after[key], before[key], `frozen JS changed ${key}`);
  await p.send("Page.bringToFront");
  const visible = await p.evaluate("document.visibilityState === 'visible'");
  if (!visible) {
    await p.evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
      window._clawdApp.connection._hiddenAt=Date.now()-31000; document.dispatchEvent(new Event('visibilitychange'));`);
    console.log(`${p.label}: used reported test-only visibility hook (visible + >30s hidden)`);
  }
  const closeEvents = await p.evaluate("window.__freezeProbe.closes");
  console.log(JSON.stringify({ page: p.label, frozenAt: frozen.started, serverCloseSentAt: frozen.record.closeSentAt,
    serverClosedAt: frozen.record.closedAt, pageCloseHandled: closeEvents, frozenPongs: frozen.record.pongs.length - frozen.pongs }));
  return { ...probe, thawedAt };
}

async function runCase(chrome, name, preserve) {
  const d = await desktop(name === "coexist" ? Math.max(coexistMs * 2, rotationMs) : rotationMs);
  let browserContextId;
  try {
    ({ browserContextId } = await chrome.send("Target.createBrowserContext"));
    if (name === "storage") {
      const legacyPage = await page(chrome, browserContextId, "storage-legacy", d.legacyUrl, true);
      await legacyPage.connected();
      assert.equal(d.state().devices.length, 0, "failed cid storage must not create pending migration");
      const pairPage = await page(chrome, browserContextId, "storage-pair", d.base + "?pair=" + d.server.getConnectionInfo().pairCode, true);
      await until(() => pairPage.evaluate("document.getElementById('pair-hint').textContent.includes('不能保存配对')"), "storage warning");
      assert.equal(d.state().devices.length, 0, "failed pairing storage must not claim a code");
      assert.equal(d.records.filter((r) => r.label === "storage-pair").length, 0);
      return;
    }
    const x = await page(chrome, browserContextId, "X", d.legacyUrl);
    await x.connected();
    await until(async () => !!(await x.credential()), "migration credential saved");
    await until(() => x.evaluate("window._clawdApp.connection.used.kind === 'device' && window._clawdApp.connection.state === 'connected'"), "device snapshot");
    const initial = await x.credential();
    await instrumentRotation(x);
    if (name === "coexist") {
      const y = await page(chrome, browserContextId, "Y", d.base); await y.connected();
      await waitDuration(coexistMs, "same device coexistence");
      assert.ok(await x.evaluate("window._clawdApp.connection.state === 'connected'"));
      assert.ok(await y.evaluate("window._clawdApp.connection.state === 'connected'"));
      assert.ok(d.records.length <= 6, "same-device tabs repeatedly replaced each other");
      console.log(`coexist duration=${coexistMs}ms connections=${d.records.length} ${coexistMs >= 600000 ? 'full duration' : 'SMOKE ONLY'}`);
      return;
    }
    const frozen = await freeze(x, d);
    await waitDuration(name === "long" ? Math.max(freezeMs, rotationMs + 1500) : Math.max(rotationMs + 1500, 2500), "frozen transport");
    checkFrozenTransport(frozen);
    let expectedCredential;
    if (name === "restart") await d.restart();
    else if (name === "reset") d.server.resetMobileAccess();
    else if (name === "two-tabs" || name === "two-rotations") {
      const y = await page(chrome, browserContextId, "Y", d.base); await y.connected();
      const wantedGen = initial.gen + (name === "two-rotations" ? 2 : 1);
      expectedCredential = await until(async () => { const value = await y.credential(); return value && value.gen >= wantedGen && value; }, "Y staged promotions", rotationMs * 4 + 15000);
      await waitForPromotionAndClose(d, expectedCredential.deviceId, expectedCredential.gen, frozen.record);
      assert.equal(frozen.record.sentCode, 4002);
    }
    const probe = await thaw(x, frozen, name === "two-tabs" || name === "two-rotations");
    if (name === "reset") {
      await until(() => x.evaluate("window._clawdApp.connection.state === 'auth_failed'"), "reset requires pairing");
      const code = d.server.getConnectionInfo().pairCode;
      await x.evaluate(`window._clawdApp.connection.rePair(${JSON.stringify(code)})`);
      await x.connected(); const repaired = await x.credential();
      assert.ok(repaired.deviceId !== initial.deviceId && repaired.gen === 1 && repaired.prevToken === null, "same-browser new device gen1 must save");
    } else {
      await x.connected();
      const current = await x.credential();
      assert.ok(current.deviceId === initial.deviceId, "freeze recovery must not require pairing another device");
      assert.ok(current.gen >= initial.gen + 1, "staged token must survive freezing/restart");
      if (expectedCredential) {
        assert.ok(current.gen >= expectedCredential.gen, "late queued messages rewound the shared credential");
        const late = probe.rotations.filter((r) => r.gen <= expectedCredential.gen);
        assert.ok(late.some((r) => r.gen === initial.gen + 1 && r.storedGen >= expectedCredential.gen), "queued old rotation branch was bypassed");
        if (name === "two-rotations") assert.equal(probe.rotations.some((r) => r.gen === initial.gen + 2), false, "closed frozen X must not receive the next generation");
        assert.ok(probe.writes.slice(frozen.writeCount).every((w) => w.gen >= expectedCredential.gen), "X wrote an old queued credential");
      }
    }
    if (name === "long") {
      const readCloses = () => x.evaluate("window.__freezeProbe.closes");
      const closeEvents = preserve ? await readCloses() : await until(async () => {
        const events = await readCloses();
        return events.some((event) => event.code === 1006 && event.at >= probe.thawedAt) ? events : null;
      }, "default Chrome thaw disconnect handled by the page", 5000);
      const mode = describeLongFreeze(preserve, closeEvents, probe.thawedAt);
      console.log(`long freeze=${freezeMs}ms ${freezeMs > 300000 ? 'beyond old grace' : 'SMOKE ONLY'} mode=${mode}`);
      return mode;
    }
  } finally {
    try { if (browserContextId) await chrome.send("Target.disposeBrowserContext", { browserContextId }); }
    finally { await d.cleanup(); }
  }
}

async function main() {
  for (const name of selected) assert.ok(["long", "restart", "two-tabs", "two-rotations", "coexist", "reset", "storage"].includes(name), `Unknown case ${name}`);
  const chrome = await launchChrome(true);
  try {
    for (const name of selected) { console.log(`START preserved/${name}`); const mode = await runCase(chrome, name, true); console.log(`PASS preserved/${name}${mode ? ` (${mode})` : ""}`); }
  } finally { await chrome.cleanup(); }
  if (selected.has("long")) {
    const defaults = await launchChrome(false);
    try { console.log("START default/long disconnect-recovery group"); await runCase(defaults, "long", false); console.log("PASS default/long"); }
    finally { await defaults.cleanup(); }
  }
}

module.exports = { describeLongFreeze, waitForPromotionAndClose };

if (require.main === module) {
  main().catch((err) => { console.error(err.stack); process.exitCode = 1; });
}
