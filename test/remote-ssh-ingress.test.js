"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const {
  ROUTING_NONCE_HEADER,
  createIngressRequestHandler,
  createRemoteSshIngress,
} = require("../src/remote-ssh-ingress");

function dispatch(handler, { method = "POST", path = "/state", nonce } = {}) {
  const req = {
    method,
    url: path,
    headers: nonce ? { [ROUTING_NONCE_HEADER]: nonce } : {},
  };
  const result = { statusCode: null, headers: {}, body: "" };
  const res = {
    writeHead(statusCode, headers = {}) {
      result.statusCode = statusCode;
      result.headers = headers;
    },
    end(body = "") {
      result.body = body;
    },
  };
  handler(req, res);
  return result;
}

test("ingress rejects missing/wrong nonce as generic 404 without the Clawd header", async () => {
  const routed = [];
  const handler = createIngressRequestHandler({
    remoteProfile: { profileId: "profile-a", displayHost: "server-a" },
    getAcceptedNonces: () => ["a".repeat(32)],
    routeRequest: (req, res) => {
      routed.push(req.url);
      res.writeHead(200);
      res.end("ok");
    },
  });
  for (const nonce of [null, "b".repeat(32)]) {
    const response = dispatch(handler, { nonce });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers["x-clawd-server"], undefined);
  }
  assert.deepEqual(routed, []);
});

test("ingress accepts current and unexpired previous nonce and stamps trusted profile", () => {
  const seen = [];
  const handler = createIngressRequestHandler({
    remoteProfile: { profileId: "profile-a", displayHost: "server-a" },
    getAcceptedNonces: () => ["a".repeat(32), "b".repeat(32)],
    routeRequest: (req, res, remoteProfile) => {
      seen.push({ url: req.url, remoteProfile });
      res.writeHead(200);
      res.end("ok");
    },
  });
  assert.equal(dispatch(handler, { nonce: "a".repeat(32) }).statusCode, 200);
  assert.equal(dispatch(handler, { nonce: "b".repeat(32) }).statusCode, 200);
  assert.deepEqual(seen.map((item) => item.remoteProfile.profileId), ["profile-a", "profile-a"]);
});

test("permission path nonce is accepted and stripped before route dispatch", () => {
  const seen = [];
  const nonce = "c".repeat(32);
  const handler = createIngressRequestHandler({
    remoteProfile: { profileId: "profile-a" },
    getAcceptedNonces: () => [nonce],
    routeRequest: (req, res) => {
      seen.push(req.url);
      res.writeHead(200);
      res.end("ok");
    },
  });
  const response = dispatch(handler, { path: `/permission/${nonce}` });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, ["/permission"]);
});

test("permission query nonce is accepted and stripped before route dispatch", () => {
  const seen = [];
  const nonce = "e".repeat(32);
  const handler = createIngressRequestHandler({
    remoteProfile: { profileId: "profile-a" },
    getAcceptedNonces: () => [nonce],
    routeRequest: (req, res) => {
      seen.push(req.url);
      res.writeHead(200);
      res.end("ok");
    },
  });
  const response = dispatch(handler, { path: `/permission?nonce=${nonce}` });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, ["/permission"]);
});

test("close force-disconnects in-flight permission requests", async () => {
  let requestHandler;
  const fakeServer = new EventEmitter();
  fakeServer.listening = false;
  fakeServer.listen = function listen() {
    this.listening = true;
    queueMicrotask(() => this.emit("listening"));
  };
  fakeServer.address = () => ({ port: 34567 });
  let closedAll = 0;
  fakeServer.closeAllConnections = () => { closedAll += 1; };
  fakeServer.close = () => { fakeServer.listening = false; };
  const ingress = createRemoteSshIngress({
    remoteProfile: { profileId: "profile-a" },
    getAcceptedNonces: () => ["d".repeat(32)],
    routeRequest: () => {},
    createServer(handler) {
      requestHandler = handler;
      return fakeServer;
    },
  });
  const port = await ingress.start();
  assert.equal(port, 34567);
  assert.equal(typeof requestHandler, "function");
  ingress.close();
  assert.equal(closedAll, 1);
  assert.equal(ingress.getStatus().closed, true);
});

test("ingress teardown closes an in-flight permission response and runs its abort cleanup", async () => {
  const nonce = "f".repeat(32);
  let pending = 0;
  let requestHandler;
  let activeResponse = null;
  const fakeServer = new EventEmitter();
  fakeServer.listening = false;
  fakeServer.listen = function listen() {
    this.listening = true;
    queueMicrotask(() => this.emit("listening"));
  };
  fakeServer.address = () => ({ port: 34568 });
  fakeServer.closeAllConnections = () => {
    if (activeResponse) activeResponse.emit("close");
  };
  fakeServer.close = () => { fakeServer.listening = false; };
  const ingress = createRemoteSshIngress({
    remoteProfile: { profileId: "profile-a" },
    getAcceptedNonces: () => [nonce],
    routeRequest: (_req, res) => {
      pending += 1;
      res.once("close", () => { pending -= 1; });
    },
    createServer(handler) {
      requestHandler = handler;
      return fakeServer;
    },
  });
  assert.equal(await ingress.start(), 34568);
  const req = {
    method: "POST",
    url: `/permission/${nonce}`,
    headers: {},
  };
  activeResponse = new EventEmitter();
  activeResponse.writeHead = () => {};
  activeResponse.end = () => {};
  requestHandler(req, activeResponse);
  assert.equal(pending, 1);
  ingress.close();
  assert.equal(pending, 0);
});

test("ingress coalesces concurrent starts and cannot finish listening after close", async () => {
  const fakeServer = new EventEmitter();
  let listenCalls = 0;
  let closeAllCalls = 0;
  fakeServer.listen = () => { listenCalls += 1; };
  fakeServer.closeAllConnections = () => { closeAllCalls += 1; };
  fakeServer.close = () => {};
  fakeServer.address = () => ({ address: "127.0.0.1", port: 34569 });
  const ingress = createRemoteSshIngress({
    remoteProfile: { profileId: "profile-a" },
    getAcceptedNonces: () => ["a".repeat(32)],
    routeRequest: () => {},
    createServer: () => fakeServer,
  });

  const first = ingress.start();
  const second = ingress.start();
  assert.strictEqual(second, first);
  assert.equal(listenCalls, 1);

  ingress.close();
  fakeServer.emit("listening");
  await assert.rejects(first, /closed before listening/);
  await assert.rejects(second, /closed before listening/);
  assert.ok(closeAllCalls >= 1);
  assert.equal(ingress.getStatus().closed, true);
  assert.equal(ingress.getStatus().port, null);
});
