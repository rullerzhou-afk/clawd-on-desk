"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const source = fs.readFileSync(path.join(__dirname, "../pwa/app.js"), "utf8");
const CRED = "clawd-cred-v2";
const CID = "clawd-cid-v2";
const MARK = "clawd-v2-migrated";
const DEVICE = "d_" + "1".repeat(16);
const OTHER = "d_" + "2".repeat(16);
const credential = (extra = {}) => ({ host: "desktop", port: 23334, deviceId: DEVICE, gen: 1, token: "A", prevToken: null, ...extra });
const rotation = (extra = {}) => ({ type: "token_rotate", deviceId: DEVICE, gen: 2, newToken: "B", ...extra });

function harness(options = {}) {
  const data = options.data || new Map();
  const writes = [], reads = [], timers = new Map(), elements = new Map(), listeners = {}, events = {}, urls = [];
  let timerId = 0, clock = 1000000;
  let writeHook = options.writeHook;
  function element() {
    const classes = new Set();
    return { textContent: "", style: {}, children: [], appendChild(child) { this.children.push(child); }, remove() {}, addEventListener() {},
      classList: { add: (key) => classes.add(key), remove: (key) => classes.delete(key), contains: (key) => classes.has(key) } };
  }
  const document = { readyState: "loading", visibilityState: "visible", querySelectorAll: () => [],
    createElement: element, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    addEventListener(type, fn) { events[type] = fn; } };
  const testApi = {};
  const window = { __CLAWD_MOBILE_TEST__: testApi, crypto: webcrypto, btoa,
    location: { hostname: "desktop", port: "23334", protocol: "http:", pathname: "/mobile/", search: options.search || "" },
    addEventListener(type, fn) { listeners[type] = fn; } };
  class Socket {
    constructor(url) { if (options.socketError) throw new Error(options.socketError); this.url = url; this.sent = []; this.readyState = 1; Socket.instances.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close(code) { this.closeCode = code; this.readyState = 3; }
    message(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
    end(code, reason = "") { this.readyState = 3; this.onclose({ code, reason }); }
  }
  Socket.OPEN = 1; Socket.instances = [];
  const localStorage = {
    getItem(key) { reads.push(key); return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { writes.push(key); if (writeHook && writeHook(key, value, data) === false) return; data.set(key, value); },
    removeItem(key) { data.delete(key); },
  };
  class FakeDate extends Date { static now() { return clock; } }
  vm.runInNewContext(source, { window, document, navigator: {}, URLSearchParams, Uint8Array,
    localStorage, WebSocket: Socket, Date: FakeDate,
    history: { replaceState(_a, _b, url) { urls.push(url); } },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    setInterval() {}, clearInterval() {}, console,
  });
  const connection = new testApi.exports.ConnectionManager();
  return { classes: testApi.exports, connection, data, document, writes, reads, urls, elements, events, listeners, Socket, timers,
    socket: () => Socket.instances.at(-1),
    saved: () => data.has(CRED) ? JSON.parse(data.get(CRED)) : null,
    save(value) { data.set(CRED, JSON.stringify(value)); },
    setWriteHook(fn) { writeHook = fn; },
    now(value) { clock = value; },
    reconnect() { const id = connection.reconnectTimer, task = timers.get(id); assert.ok(task); timers.delete(id); task.fn(); return task.delay; },
  };
}

function deviceHarness(extra = {}, options = {}) {
  const data = options.data || new Map(); data.set(CRED, JSON.stringify(credential(extra)));
  const h = harness({ ...options, data }); h.connection.start(); return h;
}

test("startup uses the page target, saved device before URL credentials; history is neither read nor written", () => {
  const h = deviceHarness({}, { search: "?host=evil&port=1&token=legacy&pair=CODE1234" });
  assert.ok(h.socket().url.startsWith("ws://desktop:23334/ws?token=A&proto=2&cid=c_"));
  assert.equal(h.connection.backupPair, "CODE1234");
  assert.equal(h.data.get(MARK), "1");
  assert.equal(h.reads.includes("clawd-history"), false); assert.equal(h.writes.includes("clawd-history"), false);
});

test("history is used once only for the page target; migrated marker blocks history but not an explicit legacy URL", () => {
  const data = new Map([["clawd-history", JSON.stringify([{ host: "evil", port: 1, token: "evil" }, { host: "desktop", port: 23334, token: "legacy" }])]]);
  const h = harness({ data }); h.connection.start(); assert.equal(h.connection.used.kind, "legacy"); assert.equal(h.connection.used.token, "legacy");
  h.data.set(MARK, "1");
  const again = harness({ data }); again.connection.start();
  assert.equal(again.Socket.instances.length, 0); assert.equal(again.reads.includes("clawd-history"), false);
  const explicit = harness({ data, search: "?token=explicit&host=evil&port=1" }); explicit.connection.start();
  assert.equal(explicit.connection.used.token, "explicit"); assert.equal(explicit.connection.config.host, "desktop");
});

for (const mode of ["throw", "mismatch"]) {
  test(`cid ${mode}: legacy has no proto2, pairing is not attempted`, () => {
    const options = { writeHook(key) { if (key === CID) { if (mode === "throw") throw new Error("blocked"); return false; } } };
    const h = harness({ ...options, search: "?token=legacy" }); h.connection.start();
    assert.equal(h.socket().url.includes("proto="), false); assert.equal(h.connection.storageOk, false);
    const pair = harness({ ...options, search: "?pair=CODE1234" }); pair.connection.start();
    assert.equal(pair.Socket.instances.length, 0);
    assert.match(pair.elements.get("pair-hint").textContent, /不能保存配对/);
  });
  test(`credential ${mode}: token_rotate does not change memory or ACK on failure`, () => {
    const h = deviceHarness(); const original = h.connection.config;
    h.setWriteHook((key) => { if (key === CRED) { if (mode === "throw") throw new Error("blocked"); return false; } });
    h.socket().message(rotation());
    assert.strictEqual(h.connection.config, original); assert.equal(h.connection.config.token, "A");
    assert.equal(h.socket().sent.length, 0); assert.equal(h.Socket.instances.length, 1);
    assert.deepEqual(h.saved(), credential());
  });
}

test("device rotate saves/read-verifies before ACK and reconnect; same/lower gen or wrong device are ignored", () => {
  const h = deviceHarness(); const socket = h.socket();
  socket.message(rotation({ gen: 1 })); socket.message(rotation({ gen: 0 })); socket.message(rotation({ deviceId: OTHER, gen: 99 }));
  assert.equal(h.Socket.instances.length, 1);
  socket.message(rotation());
  assert.deepEqual(h.saved(), credential({ gen: 2, token: "B", prevToken: "A" }));
  assert.deepEqual(socket.sent, [{ type: "token_rotate_ack" }]); assert.equal(socket.closeCode, 1000);
  assert.equal(h.connection.used.token, "B"); assert.equal(h.Socket.instances.length, 2);
  const current = h.socket(); current.message(rotation());
  assert.equal(h.Socket.instances.length, 2);
  h.save(credential({ deviceId: OTHER, gen: 1, token: "NEW" }));
  current.message(rotation({ gen: 100, newToken: "OLD" }));
  assert.equal(h.saved().token, "NEW");
});

test("legacy rotation writes only empty storage, with null prevToken; identical already saved credentials reconnect", () => {
  const h = harness({ search: "?token=legacy" }); h.connection.start(); const x = h.socket();
  h.save(credential({ deviceId: OTHER, token: "NEW" }));
  x.message(rotation()); assert.equal(h.saved().token, "NEW"); assert.equal(h.Socket.instances.length, 1);
  h.data.delete(CRED); x.message(rotation({ gen: 1 }));
  assert.equal(h.saved().prevToken, null); assert.equal(h.connection.used.token, "B");
  const second = harness({ search: "?token=legacy" }); second.connection.start();
  second.save(credential({ token: "B", gen: 1 })); second.socket().message(rotation({ gen: 1 }));
  assert.equal(second.connection.used.token, "B"); assert.equal(second.Socket.instances.length, 2);
});

test("pairing clears old credentials, accepts a new device gen1, and overrides a different device written during pairing", () => {
  const h = deviceHarness({ gen: 50 }); h.connection.rePair("K7Q2-9MXA");
  assert.equal(h.saved(), null); assert.equal(h.data.get(MARK), "1");
  assert.match(h.socket().url, /pair=K7Q29MXA&proto=2/);
  h.save(credential({ gen: 99, token: "late-old" }));
  const pair = h.socket(); pair.message(rotation({ deviceId: OTHER, gen: 1, newToken: "NEW" }));
  assert.deepEqual(h.saved(), credential({ deviceId: OTHER, gen: 1, token: "NEW", prevToken: null }));
  assert.equal(h.connection.used.token, "NEW");
});

test("pair same-device messages reuse matching token, write higher gen, drop lower gen", () => {
  for (const variant of ["same", "higher", "lower"]) {
    const h = harness({ search: "?pair=CODE1234" }); h.connection.start();
    h.save(credential({ gen: 5, token: "S" }));
    const message = rotation({ gen: variant === "higher" ? 6 : 1, newToken: variant === "same" ? "S" : "B" });
    h.socket().message(message);
    assert.equal(h.saved().token, variant === "higher" ? "B" : "S");
    assert.equal(h.Socket.instances.length, variant === "lower" ? 1 : 2);
    assert.equal(h.saved().prevToken, null);
  }
});

test("pair credential failure closes without snapshot/URL cleanup; legacy write failure leaves its socket", () => {
  for (const kind of ["pair", "token"]) {
    const h = harness({ search: `?${kind}=CODE1234` }); h.connection.start(); const socket = h.socket();
    h.setWriteHook((key) => { if (key === CRED) throw new Error("blocked"); });
    socket.message(rotation({ gen: 1 }));
    assert.equal(h.saved(), null); assert.equal(h.connection.config.token, kind === "token" ? "CODE1234" : undefined);
    assert.equal(h.urls.length, 0);
    if (kind === "pair") { assert.equal(socket.closeCode, 1000); assert.match(h.elements.get("pair-hint").textContent, /无法保存配对/); }
    else assert.equal(socket.closeCode, undefined);
  }
});

test("1008 rereads newer credentials immediately, caps consecutive switches at three", () => {
  const h = deviceHarness();
  for (let n = 1; n <= 3; n++) {
    h.save(credential({ gen: n + 1, token: "T" + n })); h.socket().end(1008);
    assert.equal(h.connection.used.token, "T" + n); assert.equal(h.connection.retryCount, 0);
  }
  h.save(credential({ gen: 5, token: "T4" })); h.socket().end(1008);
  assert.equal(h.connection.state, "auth_failed"); assert.equal(h.Socket.instances.length, 4);
});

test("prevToken is tried once without a fresh read overriding it; snapshot restores gen0 and permits subsequent rotation", () => {
  const h = deviceHarness({ token: "B", gen: 2, prevToken: "A" });
  h.socket().end(1008); assert.equal(h.connection.used.token, "A");
  assert.match(h.socket().url, /token=A&/);
  h.socket().message({ type: "snapshot" });
  assert.deepEqual(h.saved(), credential({ token: "A", gen: 0, prevToken: null }));
  h.socket().message(rotation({ gen: 1, newToken: "B" }));
  assert.equal(h.saved().gen, 1); assert.equal(h.connection.used.token, "B");
  const failed = deviceHarness({ token: "B", prevToken: "A" });
  failed.socket().end(1008); failed.socket().end(1008);
  assert.equal(failed.connection.state, "auth_failed"); assert.equal(failed.Socket.instances.length, 2);
});

test("prevToken restore requires unchanged storage and only that attempt's snapshot; failed restore does not change memory", () => {
  for (const mode of ["concurrent", "write-failure", "normal"]) {
    const h = deviceHarness({ token: "B", gen: 5, prevToken: "A" });
    if (mode === "normal") { h.socket().message({ type: "snapshot" }); assert.equal(h.saved().gen, 5); continue; }
    h.socket().end(1008); const memory = h.connection.config;
    if (mode === "concurrent") h.save(credential({ token: "C", gen: 6 }));
    else h.setWriteHook((key) => { if (key === CRED) throw new Error("blocked"); });
    h.socket().message({ type: "snapshot" });
    assert.strictEqual(h.connection.config, memory);
    assert.equal(h.saved().token, mode === "concurrent" ? "C" : "B");
    assert.equal(h.urls.length, 0);
  }
});

test("migrated marker failure keeps saved credentials usable, startup repairs marker, re-pair refuses to delete without it", () => {
  const h = harness({ search: "?token=legacy" }); h.connection.start();
  h.setWriteHook((key) => { if (key === MARK) throw new Error("blocked"); });
  h.socket().message(rotation({ gen: 1 }));
  assert.equal(h.connection.used.token, "B"); assert.equal(h.data.get(MARK), undefined);
  const saved = h.saved();
  h.connection.rePair("CODE1234");
  assert.deepEqual(h.saved(), saved); assert.equal(h.Socket.instances.length, 2);
  assert.match(h.elements.get("pair-hint").textContent, /不能保存配对/);
  const again = harness({ data: h.data }); again.connection.start();
  assert.equal(again.data.get(MARK), "1"); assert.equal(again.connection.used.token, "B");
});

test("reload in the re-pair window never revives legacy history; pair/token/empty URL select their explicit paths", () => {
  for (const query of ["?pair=CODE1234", "?token=explicit", ""]) {
    const h = deviceHarness(); h.data.set("clawd-history", JSON.stringify([{ host: "desktop", port: 23334, token: "history" }]));
    h.connection.rePair("CODE1234");
    const again = harness({ data: h.data, search: query }); again.connection.start();
    assert.equal(again.reads.includes("clawd-history"), false);
    assert.equal(again.Socket.instances.length, query ? 1 : 0);
    if (query) assert.equal(again.connection.used.kind, query.includes("pair=") ? "pair" : "legacy");
  }
});

test("revoked credentials use backup URL pair; storage event recovers auth_failed with a new device", () => {
  const h = deviceHarness({}, { search: "?pair=CODE1234" }); h.socket().end(1008);
  assert.equal(h.connection.used.kind, "pair"); assert.equal(h.saved(), null); assert.equal(h.connection.backupPair, null);
  const blocked = deviceHarness(); blocked.socket().end(1008);
  assert.equal(blocked.connection.authBlocked, true);
  blocked.save(credential({ deviceId: OTHER, token: "NEW" }));
  blocked.listeners.storage({ key: CRED });
  assert.equal(blocked.connection.authBlocked, false); assert.equal(blocked.connection.used.token, "NEW");
});

for (const code of [4001, 4002, 4003, 4004, 4005, 1013]) {
  test(`close ${code} keeps stored credentials and follows its retry/input branch`, () => {
    const h = deviceHarness(); h.socket().end(code);
    assert.deepEqual(h.saved(), credential());
    if (code === 4002) { assert.equal(h.Socket.instances.length, 2); assert.equal(h.connection.retryCount, 0); }
    else if (code === 4004 || code === 4005) {
      assert.equal(h.connection.authBlocked, true); assert.equal(h.timers.has(h.connection.reconnectTimer), false);
      assert.match(h.elements.get("pair-hint").textContent, code === 4004 ? /配对码无效/ : /设备满了/);
    } else { assert.equal(h.connection.state, "reconnecting"); assert.equal(h.connection.authBlocked, false); }
  });
}

test("open/reject backoff grows until snapshot, including an immediate visibility reconnect", () => {
  const h = deviceHarness();
  for (const delay of [1000, 2000, 4000]) {
    h.socket().onopen(); h.socket().end(delay === 2000 ? 4003 : 1013);
    assert.equal(h.reconnect(), delay);
  }
  h.document.visibilityState = "hidden"; h.events.visibilitychange(); h.now(1100000);
  h.document.visibilityState = "visible"; h.events.visibilitychange();
  assert.equal(h.connection.reconnectDelay, 8000);
  h.socket().onopen(); h.socket().end(4003); assert.equal(h.reconnect(), 8000);
  h.socket().message({ type: "snapshot" }); assert.equal(h.connection.reconnectDelay, 1000); assert.equal(h.connection.retryCount, 0);
});

test("connected and URL cleanup wait for the matching saved-device snapshot", () => {
  const h = deviceHarness({}, { search: "?pair=CODE1234" });
  h.socket().onopen(); assert.equal(h.connection.state, "connecting"); assert.equal(h.urls.length, 0);
  h.socket().message({ type: "snapshot" }); assert.equal(h.connection.state, "connected"); assert.deepEqual(h.urls, ["/mobile/"]);
  const legacy = harness({ search: "?token=legacy" }); legacy.connection.start();
  legacy.socket().message({ type: "snapshot" }); assert.equal(legacy.connection.state, "connected"); assert.equal(legacy.urls.length, 0);
  legacy.socket().message(rotation({ gen: 1 })); assert.equal(legacy.urls.length, 0);
  legacy.save(credential({ gen: 3, token: "C" })); legacy.socket().message({ type: "snapshot" }); assert.equal(legacy.urls.length, 0);
  const pair = harness({ search: "?pair=CODE1234" }); pair.connection.start(); pair.socket().message({ type: "snapshot" });
  assert.equal(pair.connection.state, "connecting"); assert.equal(pair.urls.length, 0);
});

test("every connection rereads cid and credentials, using the last stored installation id", () => {
  const h = deviceHarness();
  h.data.set(CID, "c_" + "Z".repeat(22)); h.save(credential({ token: "C", gen: 3 })); h.connection._doConnect();
  assert.ok(h.socket().url.includes("cid=c_" + "Z".repeat(22))); assert.equal(h.connection.used.token, "C");
});

test("controlled cross-tab read/write interleaving can temporarily lower gen but never changes device authorization", () => {
  const h = deviceHarness();
  h.setWriteHook((key) => { if (key === CRED) h.save(credential({ gen: 3, token: "C", prevToken: "B" })); });
  h.socket().message(rotation());
  assert.equal(h.saved().gen, 2); assert.equal(h.saved().deviceId, DEVICE);
  // The real server rejects the stale B after C is promoted; a fresh peer write recovers in one reconnect.
  h.save(credential({ gen: 3, token: "C", prevToken: "B" })); h.socket().end(1008);
  assert.equal(h.connection.used.token, "C"); assert.equal(h.connection.authBlocked, false);
  assert.equal(h.Socket.instances.length, 3);
});

test("lost higher generation without another peer write ends after one prevToken attempt and asks to re-pair", () => {
  const h = deviceHarness();
  const states = [];
  h.connection.onStateChange = (state) => states.push(state);
  h.socket().message({ type: "snapshot" });
  h.setWriteHook((key) => {
    if (key === CRED) h.save(credential({ gen: 3, token: "C", prevToken: "B" }));
  });
  h.socket().message(rotation());
  h.setWriteHook(null);
  // Y has promoted C, but X's stale write lost C locally and Y never writes again.
  assert.deepEqual(h.saved(), credential({ gen: 2, token: "B", prevToken: "A" }));
  assert.equal(h.connection.used.token, "B");
  h.socket().end(1008);
  assert.equal(h.connection.used.token, "A");
  assert.equal(h.connection.prevTried, true);
  h.socket().end(1008);
  assert.equal(h.connection.state, "auth_failed");
  assert.equal(h.connection.authBlocked, true);
  assert.equal(states.filter((state) => state === "connected").length, 1);
  assert.match(h.elements.get("pair-hint").textContent, /请重新配对/);
  assert.equal(h.timers.has(h.connection.reconnectTimer), false);
  assert.equal(h.Socket.instances.length, 3);
  const attempts = h.Socket.instances.map((socket) => new URLSearchParams(socket.url.split("?")[1]));
  assert.deepEqual(attempts.map((params) => params.get("token")), ["A", "B", "A"]);
  assert.ok(attempts.every((params) => !params.has("pair")));
  assert.equal(h.connection.config.deviceId, DEVICE);
  assert.deepEqual(h.saved(), credential({ gen: 2, token: "B", prevToken: "A" }));
  h.document.visibilityState = "hidden";
  h.events.visibilitychange();
  h.now(1100000);
  h.document.visibilityState = "visible";
  h.events.visibilitychange();
  assert.equal(h.Socket.instances.length, 3, "visibility cannot restart rejected credentials");
});

test("service worker uses network first for navigation/JS/CSS and never caches credential-bearing navigation keys", async () => {
  const handlers = {}, keys = [], matched = [];
  let online = true, response;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../pwa/sw.js"), "utf8"), {
    URL, self: { location: { origin: "http://desktop" }, addEventListener(type, fn) { handlers[type] = fn; } },
    fetch: async () => { if (!online) throw new Error("offline"); return { ok: true, type: "basic", clone: () => "fresh" }; },
    caches: { open: async () => ({ put(key) { keys.push(key); } }), match: async (key) => { matched.push(key); return "cached"; } },
  });
  for (const route of ["/mobile/?token=secret", "/mobile/?pair=secret", "/mobile/app.js?v=1.4.0", "/mobile/style.css?v=1.4.0"]) {
    const request = { url: "http://desktop" + route, method: "GET", mode: route.includes("?") && !route.includes(".js") && !route.includes(".css") ? "navigate" : "cors" };
    const waits = [];
    handlers.fetch({ request, respondWith(value) { response = value; }, waitUntil(value) { waits.push(value); } });
    await response; await Promise.all(waits);
  }
  assert.deepEqual(keys, ["/mobile/", "/mobile/", "/mobile/app.js", "/mobile/style.css"]);
  assert.deepEqual(matched, []);
  online = false;
  handlers.fetch({ request: { url: "http://desktop/mobile/?pair=secret", mode: "navigate", method: "GET" }, respondWith(value) { response = value; } });
  assert.equal(await response, "cached"); assert.deepEqual(matched, ["/mobile/"]);
});

test("unverifiable migrated marker prevents re-pair deletion with an existing cid", () => {
  const h = deviceHarness(); h.data.delete(MARK);
  h.setWriteHook((key) => { if (key === MARK) return false; });
  h.connection.rePair("CODE1234");
  assert.deepEqual(h.saved(), credential()); assert.equal(h.Socket.instances.length, 1);
  assert.match(h.elements.get("pair-hint").textContent, /不能保存配对/);
});

test("HTML versions app.js, icons.js and style.css with a server-filled placeholder", () => {
  const html = fs.readFileSync(path.join(__dirname, "../pwa/index.html"), "utf8");
  for (const asset of ["app.js", "icons.js", "style.css"]) assert.ok(html.includes(`/mobile/${asset}?v=__CLAWD_APP_VERSION__`));
});


test("each socket announces only its first snapshot while all snapshots still update sessions", () => {
  const h = deviceHarness();
  let permissionRequests = 0;
  let snapshots = 0;
  const app = Object.create(h.classes.App.prototype);
  Object.assign(app, {
    connection: h.connection,
    notifier: { requestPermission() { permissionRequests++; } },
    renderer: { updateFromSnapshot() { snapshots++; } },
    permissionBanner: { setDisconnected() {}, setFeature() {}, replace() {} },
    activeTab: "sessions",
    _updateConnectionStatus() {},
  });
  app._bindConnection();
  h.socket().message({ type: "snapshot" });
  h.socket().message({ type: "snapshot" });
  assert.equal(snapshots, 2);
  assert.equal(permissionRequests, 1);
  assert.equal(h.elements.get("toast-container").children.filter((el) => el.textContent === "已连接到桌面端").length, 1);
  h.socket().end(4001);
  h.reconnect();
  h.socket().message({ type: "snapshot" });
  assert.equal(permissionRequests, 2);
  assert.equal(snapshots, 3);
});


test("connection diagnostics retain rotation, disconnect, visibility, auth and creation failures without credentials", () => {
  const token = "sensitive-device-credential";
  const nextToken = "sensitive-next-credential";
  const h = deviceHarness({ token });
  h.socket().message(rotation({ newToken: nextToken }));
  h.socket().message({ type: "snapshot" });
  h.document.visibilityState = "hidden";
  h.events.visibilitychange();
  h.now(1100000);
  h.document.visibilityState = "visible";
  h.events.visibilitychange();
  h.data.delete(CRED);
  h.socket().end(1008);
  const logText = h.elements.get("settings-log-content").children.map((el) => el.textContent).join("\n");
  for (const message of ["Token rotated", "Disconnected (code: 1008)", "Page visible after 100s, reconnecting...", "Auth failed"]) assert.ok(logText.includes(message));
  for (const secret of [token, nextToken, h.data.get(CID)]) assert.equal(logText.includes(secret), false);
  const failed = harness({ search: "?token=" + token, socketError: "URL contained " + token });
  failed.connection.start();
  const failureLog = failed.elements.get("settings-log-content").children.map((el) => el.textContent).join("\n");
  assert.ok(failureLog.includes("WS create failed"));
  assert.equal(failureLog.includes(token), false);
});

test("pairing styles use the existing theme variables", () => {
  const css = fs.readFileSync(path.join(__dirname, "../pwa/style.css"), "utf8");
  const pairing = css.slice(css.indexOf("#pair-form {"));
  assert.doesNotMatch(pairing, /#[a-f0-9]{3,8}\b/i);
  for (const name of ["card-border", "card", "text", "accent", "muted"]) assert.ok(pairing.includes(`var(--${name})`));
});
