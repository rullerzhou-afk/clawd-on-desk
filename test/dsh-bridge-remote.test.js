"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SOURCE_DIR = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");
const INSTALL_ID = "a".repeat(64);
const NONCE = "c".repeat(32);

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

// Every generation owns its own copy of the bridge. Importing a temp copy also
// gives each test an isolated transport-mode cache.
function loadGeneration(t, { home = null, manifest = undefined } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generation = path.join(root, "generation");
  fs.cpSync(SOURCE_DIR, generation, { recursive: true });
  if (manifest !== undefined) {
    writeJson(path.join(generation, "clawd-manifest.json"), manifest);
  }
  const identityPath = path.join(root, "clawd-remote.json");
  const hostPrefixPath = path.join(root, "clawd-host-prefix");
  const url = pathToFileURL(path.join(generation, "lib", "clawd-client.js")).href;
  // os.homedir() is read while the module initializes, so the isolated HOME
  // must be active during import (not just while building paths).
  const importClient = async () => {
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    if (home) {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
    }
    try {
      return await import(url);
    } finally {
      if (home) {
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
      }
    }
  };
  return { root, generation, identityPath, hostPrefixPath, importClient };
}

function remoteDeployment(identityPath, hostPrefixPath, overrides = {}) {
  return {
    kind: "ssh-remote",
    descriptorVersion: 1,
    installId: INSTALL_ID,
    profileId: "remote-a",
    runtimeKey: "runtime-a",
    layoutVersion: 1,
    identityPath,
    hostPrefixPath,
    ...overrides,
  };
}

function remoteIdentity(port, overrides = {}) {
  return {
    version: 2,
    installId: INSTALL_ID,
    profileId: "remote-a",
    runtimeKey: "runtime-a",
    layoutVersion: 1,
    routingNonce: NONCE,
    remotePort: port,
    deployedAt: 100,
    ...overrides,
  };
}

function createRecorder(t, respond) {
  const requests = [];
  return listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(entry);
      respond(entry, req, res);
    });
  }).then((server) => ({ server, requests }));
}

function respondClawd(entry, req, res) {
  if (req.method === "GET") {
    res.writeHead(200, { "x-clawd-server": "clawd-on-desk", "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, app: "clawd-on-desk" }));
    return;
  }
  if (entry.url === "/permission") {
    res.writeHead(200, { "x-clawd-server": "clawd-on-desk", "content-type": "application/json" });
    res.end(JSON.stringify({ decision: "allow" }));
    return;
  }
  res.writeHead(200, { "x-clawd-server": "clawd-on-desk", "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

test("DSH remote: bridge refuses to send when the generation manifest is unreadable or invalid", async (t) => {
  const cases = [
    { name: "missing", manifest: undefined },
    { name: "not an object", manifest: [] },
    { name: "invalid deployment", manifest: { deployment: { kind: "ssh-remote" } } },
  ];
  for (const item of cases) {
    const loaded = loadGeneration(t, { manifest: item.manifest });
    const client = await loaded.importClient();
    const recorder = await createRecorder(t, respondClawd);
    t.after(() => close(recorder.server));
    const { identityPath, hostPrefixPath } = loaded;
    if (item.name === "invalid deployment") {
      writeJson(identityPath, remoteIdentity(recorder.server.address().port));
      assert.strictEqual(hostPrefixPath, loaded.hostPrefixPath);
    }
    const state = await client.postState({ agent_id: "deepseek-harness" });
    assert.strictEqual(state.ok, false, item.name);
    assert.strictEqual(state.reason, "deployment-unknown", item.name);
    assert.deepStrictEqual(await client.requestPermission({}), { kind: "no-decision" }, item.name);
    assert.strictEqual(recorder.requests.length, 0, item.name);
  }
});

test("DSH remote: local generation keeps the existing runtime.json discovery and direct approval POST", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-bridge-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const recorder = await createRecorder(t, respondClawd);
  t.after(() => close(recorder.server));
  writeJson(path.join(home, ".clawd", "runtime.json"), {
    app: "clawd-on-desk",
    port: recorder.server.address().port,
    ownerPid: process.pid,
  });
  const loaded = loadGeneration(t, { home, manifest: { owner: "clawd-on-desk", schemaVersion: 1 } });
  const client = await loaded.importClient();
  const sent = await client.postState({ agent_id: "deepseek-harness", session_id: "deepseek-harness:s1" });
  assert.strictEqual(sent.ok, true);
  assert.deepStrictEqual(await client.requestPermission({ hook_event_name: "PermissionRequest" }), {
    kind: "decision",
    decision: "allow",
  });
  assert.deepStrictEqual(recorder.requests.map((entry) => `${entry.method} ${entry.url}`), [
    "GET /state",
    "POST /state",
    "POST /permission",
  ]);
  for (const entry of recorder.requests) assert.strictEqual(entry.headers["x-clawd-routing-nonce"], undefined);
});

test("DSH remote: bridge reads the deployment identity on every request and never discovers locally", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-bridge-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const decoy = await createRecorder(t, respondClawd);
  const real = await createRecorder(t, respondClawd);
  t.after(() => close(decoy.server));
  t.after(() => close(real.server));
  writeJson(path.join(home, ".clawd", "runtime.json"), {
    app: "clawd-on-desk",
    port: decoy.server.address().port,
    ownerPid: process.pid,
  });
  const loaded = loadGeneration(t, {
    home,
    manifest: { deployment: remoteDeployment("__IDENTITY__", "__HOST__") },
  });
  // Rewrite the placeholder paths now that the temp generation path is known.
  loaded.manifest = null;
  const identityPath = loaded.identityPath;
  const hostPrefixPath = loaded.hostPrefixPath;
  writeJson(path.join(loaded.generation, "clawd-manifest.json"), {
    deployment: remoteDeployment(identityPath, hostPrefixPath),
  });
  writeJson(identityPath, remoteIdentity(real.server.address().port));
  const client = await loaded.importClient();
  client.__test.setRemotePortValidatorForTest((port) => Number.isInteger(port) && port > 0 && port < 65536);

  assert.strictEqual((await client.postState({ agent_id: "deepseek-harness" })).ok, true);
  assert.strictEqual(real.requests.length, 1);
  assert.strictEqual(real.requests[0].url, "/state");
  assert.strictEqual(real.requests[0].headers["x-clawd-routing-nonce"], NONCE);
  assert.strictEqual(decoy.requests.length, 0, "remote mode must not read runtime.json or scan local ports");

  // A new deployment rotates the nonce; the identity is re-read per request.
  writeJson(identityPath, remoteIdentity(real.server.address().port, { routingNonce: "d".repeat(32) }));
  assert.strictEqual((await client.postState({ agent_id: "deepseek-harness" })).ok, true);
  assert.strictEqual(real.requests[1].headers["x-clawd-routing-nonce"], "d".repeat(32));

  // An identity for another installation is not an identity.
  writeJson(identityPath, remoteIdentity(real.server.address().port, { installId: "b".repeat(64) }));
  const rejected = await client.postState({ agent_id: "deepseek-harness" });
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, "identity-unavailable");
  assert.strictEqual(real.requests.length, 2);
});

test("DSH remote: bridge caches the transport mode for the process lifetime", async (t) => {
  const real = await createRecorder(t, respondClawd);
  t.after(() => close(real.server));
  const loaded = loadGeneration(t, { manifest: undefined });
  writeJson(path.join(loaded.generation, "clawd-manifest.json"), {
    deployment: remoteDeployment(loaded.identityPath, loaded.hostPrefixPath),
  });
  writeJson(loaded.identityPath, remoteIdentity(real.server.address().port));
  const client = await loaded.importClient();
  client.__test.setRemotePortValidatorForTest((port) => Number.isInteger(port) && port > 0 && port < 65536);
  assert.strictEqual((await client.postState({ agent_id: "deepseek-harness" })).ok, true);
  // A later unreadable manifest must not demote the process to local discovery.
  fs.rmSync(path.join(loaded.generation, "clawd-manifest.json"));
  const state = await client.postState({ agent_id: "deepseek-harness" });
  assert.strictEqual(state.ok, true);
  assert.strictEqual(real.requests.length, 2);
});

test("DSH remote: approval probes first and then uses a nonce-protected POST", async (t) => {
  const real = await createRecorder(t, respondClawd);
  t.after(() => close(real.server));
  const loaded = loadGeneration(t, {
    manifest: { deployment: remoteDeployment("__IDENTITY__", "__HOST__") },
  });
  writeJson(path.join(loaded.generation, "clawd-manifest.json"), {
    deployment: remoteDeployment(loaded.identityPath, loaded.hostPrefixPath),
  });
  writeJson(loaded.identityPath, remoteIdentity(real.server.address().port));
  const client = await loaded.importClient();
  client.__test.setRemotePortValidatorForTest((port) => Number.isInteger(port) && port > 0 && port < 65536);
  assert.deepStrictEqual(await client.requestPermission({ hook_event_name: "PermissionRequest" }), {
    kind: "decision",
    decision: "allow",
  });
  assert.deepStrictEqual(real.requests.map((entry) => `${entry.method} ${entry.url}`), [
    "GET /state",
    "POST /permission",
  ]);
  for (const entry of real.requests) assert.strictEqual(entry.headers["x-clawd-routing-nonce"], NONCE);
});

test("DSH remote: approval returns no decision when the pre-probe fails", async (t) => {
  const real = await createRecorder(t, (entry, req, res) => {
    if (req.method === "GET") {
      res.writeHead(500, { "x-clawd-server": "clawd-on-desk" });
      res.end();
      return;
    }
    res.writeHead(200, { "x-clawd-server": "clawd-on-desk" });
    res.end(JSON.stringify({ decision: "allow" }));
  });
  t.after(() => close(real.server));
  const loaded = loadGeneration(t, {
    manifest: { deployment: remoteDeployment("__IDENTITY__", "__HOST__") },
  });
  writeJson(path.join(loaded.generation, "clawd-manifest.json"), {
    deployment: remoteDeployment(loaded.identityPath, loaded.hostPrefixPath),
  });
  writeJson(loaded.identityPath, remoteIdentity(real.server.address().port));
  const client = await loaded.importClient();
  client.__test.setRemotePortValidatorForTest((port) => Number.isInteger(port) && port > 0 && port < 65536);
  assert.deepStrictEqual(await client.requestPermission({}), { kind: "no-decision" });
  assert.strictEqual(real.requests.filter((entry) => entry.method === "POST").length, 0);
});

test("DSH remote: approval aborts after two failed liveness probes and never replays", async (t) => {
  let getCount = 0;
  const real = await createRecorder(t, (entry, req, res) => {
    if (req.method === "GET") {
      getCount += 1;
      if (getCount === 1) {
        res.writeHead(200, { "x-clawd-server": "clawd-on-desk", "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, app: "clawd-on-desk" }));
        return;
      }
      res.writeHead(500, { "x-clawd-server": "clawd-on-desk" });
      res.end();
      return;
    }
    // Keep the approval pending until the bridge aborts it.
  });
  t.after(() => close(real.server));
  const loaded = loadGeneration(t, {
    manifest: { deployment: remoteDeployment("__IDENTITY__", "__HOST__") },
  });
  writeJson(path.join(loaded.generation, "clawd-manifest.json"), {
    deployment: remoteDeployment(loaded.identityPath, loaded.hostPrefixPath),
  });
  writeJson(loaded.identityPath, remoteIdentity(real.server.address().port));
  const client = await loaded.importClient();
  client.__test.setRemotePortValidatorForTest((port) => Number.isInteger(port) && port > 0 && port < 65536);
  const startedAt = Date.now();
  const answer = await client.requestPermission({}, {
    timeoutMs: 5000,
    livenessIntervalMs: 20,
    livenessProbeTimeoutMs: 50,
  });
  const elapsed = Date.now() - startedAt;
  assert.deepStrictEqual(answer, { kind: "no-decision" });
  assert.ok(elapsed < 2000, `liveness abort must return quickly, took ${elapsed}ms`);
  assert.strictEqual(real.requests.filter((entry) => entry.method === "POST").length, 1, "must not replay approval");
  assert.ok(getCount >= 3, `expected pre-probe plus two liveness probes, got ${getCount}`);
});

test("DSH remote: approval does not POST when the identity changes after the pre-probe", async (t) => {
  let loaded;
  const real = await createRecorder(t, (entry, req, res) => {
    if (req.method === "GET") {
      writeJson(loaded.identityPath, remoteIdentity(real.server.address().port, { routingNonce: "e".repeat(32) }));
      res.writeHead(200, { "x-clawd-server": "clawd-on-desk", "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "clawd-on-desk" }));
      return;
    }
    res.writeHead(200, { "x-clawd-server": "clawd-on-desk", "content-type": "application/json" });
    res.end(JSON.stringify({ decision: "allow" }));
  });
  t.after(() => close(real.server));
  loaded = loadGeneration(t, { manifest: { deployment: remoteDeployment("__IDENTITY__", "__HOST__") } });
  writeJson(path.join(loaded.generation, "clawd-manifest.json"), {
    deployment: remoteDeployment(loaded.identityPath, loaded.hostPrefixPath),
  });
  writeJson(loaded.identityPath, remoteIdentity(real.server.address().port));
  const client = await loaded.importClient();
  client.__test.setRemotePortValidatorForTest((port) => Number.isInteger(port) && port > 0 && port < 65536);
  assert.deepStrictEqual(await client.requestPermission({}), { kind: "no-decision" });
  assert.strictEqual(real.requests.filter((entry) => entry.method === "POST").length, 0);
});

test("DSH remote: approval aborts when the identity changes while waiting", async (t) => {
  let loaded;
  const real = await createRecorder(t, (entry, req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "x-clawd-server": "clawd-on-desk", "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "clawd-on-desk" }));
      return;
    }
    writeJson(loaded.identityPath, remoteIdentity(real.server.address().port, { routingNonce: "e".repeat(32) }));
    // Keep the approval pending until the bridge aborts it.
  });
  t.after(() => close(real.server));
  loaded = loadGeneration(t, { manifest: { deployment: remoteDeployment("__IDENTITY__", "__HOST__") } });
  writeJson(path.join(loaded.generation, "clawd-manifest.json"), {
    deployment: remoteDeployment(loaded.identityPath, loaded.hostPrefixPath),
  });
  writeJson(loaded.identityPath, remoteIdentity(real.server.address().port));
  const client = await loaded.importClient();
  client.__test.setRemotePortValidatorForTest((port) => Number.isInteger(port) && port > 0 && port < 65536);
  const startedAt = Date.now();
  const answer = await client.requestPermission({}, {
    timeoutMs: 5000,
    livenessIntervalMs: 20,
    livenessProbeTimeoutMs: 50,
  });
  const elapsed = Date.now() - startedAt;
  assert.deepStrictEqual(answer, { kind: "no-decision" });
  assert.ok(elapsed < 1000, `identity change must abort immediately, took ${elapsed}ms`);
  assert.strictEqual(real.requests.filter((entry) => entry.method === "POST").length, 1);
});

test("DSH remote: probe has a hard wall-clock deadline against a slow trickle", async (t) => {
  const timers = [];
  const real = await listen((req, res) => {
    res.writeHead(200, { "x-clawd-server": "clawd-on-desk" });
    const timer = setInterval(() => { try { res.write(" "); } catch {} }, 25);
    timers.push(timer);
    req.on("close", () => clearInterval(timer));
  });
  t.after(async () => {
    for (const timer of timers) clearInterval(timer);
    await close(real);
  });
  const loaded = loadGeneration(t, {});
  const client = await loaded.importClient();
  const startedAt = Date.now();
  const alive = await client.__test.remoteProbe({
    remotePort: real.address().port,
    routingNonce: NONCE,
  }, { timeoutMs: 200 });
  const elapsed = Date.now() - startedAt;
  assert.strictEqual(alive, false);
  assert.ok(elapsed < 1000, `absolute probe deadline must not wait for idle socket timeout, took ${elapsed}ms`);
});

test("DSH remote: state failures never trigger a local rediscovery", async (t) => {
  const real = await createRecorder(t, (entry, req, res) => {
    res.writeHead(500, { "x-clawd-server": "clawd-on-desk" });
    res.end();
  });
  t.after(() => close(real.server));
  const loaded = loadGeneration(t, {
    manifest: { deployment: remoteDeployment("__IDENTITY__", "__HOST__") },
  });
  writeJson(path.join(loaded.generation, "clawd-manifest.json"), {
    deployment: remoteDeployment(loaded.identityPath, loaded.hostPrefixPath),
  });
  writeJson(loaded.identityPath, remoteIdentity(real.server.address().port));
  const client = await loaded.importClient();
  client.__test.setRemotePortValidatorForTest((port) => Number.isInteger(port) && port > 0 && port < 65536);
  assert.strictEqual((await client.postState({})).ok, false);
  assert.strictEqual((await client.postState({})).ok, false);
  assert.strictEqual(real.requests.length, 2);
});

test("DSH remote: local probe keeps the pre-absolute idle timeout behavior", async (t) => {
  const timers = [];
  const server = await listen((req, res) => {
    res.writeHead(200, { "x-clawd-server": "clawd-on-desk", "content-type": "application/json" });
    res.write('{"ok":true,');
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks < 7) {
        res.write(" ");
        return;
      }
      clearInterval(timer);
      res.end('"app":"clawd-on-desk"}');
    }, 100);
    timers.push(timer);
    req.on("close", () => clearInterval(timer));
  });
  t.after(async () => {
    for (const timer of timers) clearInterval(timer);
    await close(server);
  });
  const loaded = loadGeneration(t, { manifest: { owner: "clawd-on-desk" } });
  const client = await loaded.importClient();
  const startedAt = Date.now();
  assert.strictEqual(await client.__test.probe(server.address().port), true);
  assert.ok(Date.now() - startedAt >= 600, "local probe must not impose a 500ms absolute cap");
});
