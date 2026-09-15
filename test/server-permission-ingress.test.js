"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { postPermissionToPort } = require("../hooks/server-config");
const { runCodexHook } = require("../hooks/codex-hook");
const { requestQwenPermission } = require("../hooks/qwen-code-hook");
const { requestZcodePermission } = require("../hooks/zcode-hook");
const { parseClawdPermissionResponse } = require("../hooks/copilot-hook");
const { createPermissionIngressHarness, postPermission, waitUntil, dummyPermission } = require("./helpers/permission-ingress-harness");

async function setup(t) {
  const harness = await createPermissionIngressHarness();
  t.after(() => harness.close());
  return harness;
}

test("local permission rejects browser requests before parsing or recording", async (t) => {
  const h = await setup(t);
  for (const origin of ["https://untrusted.example", "null", "", `http://127.0.0.1:${h.port}`]) {
    const result = await postPermission(h.port, "not-json", { Origin: origin }).response;
    assert.equal(result.status, 403, JSON.stringify({ origin, result }));
    assert.equal(result.body, "");
  }
  assert.deepEqual(h.shown, []);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.logs, []);
  assert.deepEqual(h.api.getRecentHookEvents(), []);
});

test("local permission requires JSON even on compatibility allow branches", async (t) => {
  const h = await setup(t);
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=test", ""]) {
    for (const payload of [dummyPermission("passthrough", { tool_name: "TaskCreate" }), { agent_id: "pi" }]) {
      const result = await postPermission(h.port, payload, { "Content-Type": type }).response;
      assert.equal(result.status, 415, JSON.stringify({ type, result }));
      assert.equal(result.body, "");
    }
  }
  assert.deepEqual(h.shown, []);
  assert.deepEqual(h.logs, []);
});

test("local permission rejects non-loopback and malformed HTTP authorities", async (t) => {
  const h = await setup(t);
  for (const host of ["rebound.example", "127.0.0.1.evil.example", "localhost.evil.example",
    "user@127.0.0.1", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:abc", "127.1", "2130706433", "[::1]evil", ""]) {
    const result = await postPermission(h.port, "not-json", { Host: host }).response;
    assert.equal(result.status, 403, JSON.stringify({ host, result }));
    assert.equal(result.body, "");
  }
  assert.deepEqual(h.logs, []);
});

test("JSON native compatibility callers retain Pi and Task responses", async (t) => {
  const h = await setup(t);
  for (const host of [`127.0.0.1:${h.port}`, `localhost:${h.port}`, `[::1]:${h.port}`, "LOCALHOST"]) {
    const result = await postPermission(h.port, dummyPermission("metadata", { tool_name: "TaskCreate" }),
      { Host: host, "Content-Type": "Application/JSON; charset=utf-8" }).response;
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).hookSpecificOutput.decision.behavior, "allow");
  }
  const pi = await postPermission(h.port, { agent_id: "pi" }).response;
  assert.equal(pi.status, 200);
  assert.equal(JSON.parse(pi.body).hookSpecificOutput.decision.behavior, "allow");
  assert.deepEqual(h.shown, []);
});

test("rejected B cannot change, resolve, or dismiss pending A", async (t) => {
  const h = await setup(t);
  const a = postPermission(h.port, dummyPermission("A"));
  await waitUntil(() => h.shown.length === 1, "A not pending");
  const entryA = h.permission.pendingPermissions[0];
  const updatesBefore = h.updates.length;
  for (const headers of [{ Origin: "https://untrusted.example" }, { "Content-Type": "text/plain" }, { Host: "rebound.example" }]) {
    const b = await postPermission(h.port, dummyPermission("B", { tool_name: "TaskCreate" }), headers).response;
    assert.ok([403, 415].includes(b.status));
    assert.equal(b.body, "");
    assert.equal(a.settled, false);
    assert.deepEqual(h.permission.pendingPermissions, [entryA]);
    assert.equal(entryA.toolInput.file_path, "issue-976-A.txt");
    assert.equal(h.shown.length, 1);
    assert.equal(h.updates.length, updatesBefore);
  }
  h.permission.resolvePermissionEntry(entryA, "deny", "Test only");
  assert.equal(JSON.parse((await a.response).body).hookSpecificOutput.decision.behavior, "deny");
});

test("unrestricted native B receives only its own decision in A's session", async (t) => {
  const h = await setup(t);
  const a = postPermission(h.port, dummyPermission("A"));
  await waitUntil(() => h.shown.length === 1, "A not pending");
  const b = postPermission(h.port, dummyPermission("B"));
  await waitUntil(() => h.shown.length === 2, "B not pending");
  const [entryA, entryB] = h.permission.pendingPermissions;
  h.permission.resolvePermissionEntry(entryB, "allow");
  assert.equal(JSON.parse((await b.response).body).hookSpecificOutput.decision.behavior, "allow");
  assert.equal(a.settled, false);
  assert.deepEqual(h.permission.pendingPermissions, [entryA]);
  h.permission.resolvePermissionEntry(entryA, "no-decision");
  assert.equal((await a.response).error, "ECONNRESET");
});

test("permission preflight is not enabled and state health remains available", async (t) => {
  const h = await setup(t);
  const preflight = await postPermission(h.port, "", { Origin: "https://untrusted.example",
    "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }, "/permission", "OPTIONS").response;
  assert.equal(preflight.status, 404);
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  const state = await postPermission(h.port, "", {}, "/state", "GET").response;
  assert.equal(state.status, 200);
});

test("rejection does not wait for body bytes and missing media type is rejected", async (t) => {
  const h = await setup(t);
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: h.port, path: "/permission", method: "POST",
      headers: { "Content-Length": "100000" } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("guard waited for the body")));
    req.flushHeaders();
    t.after(() => req.destroy());
  });
  assert.equal(result, 415);
  assert.deepEqual(h.logs, []);
});

test("duplicate Host and Content-Type cannot hide a second authority or media type", async (t) => {
  const h = await setup(t);
  for (const extra of ["Host: rebound.example", "Content-Type: text/plain"]) {
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(h.port, "127.0.0.1", () => {
        socket.write(`POST /permission HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nContent-Type: application/json\r\n${extra}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      });
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { data += chunk; });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      socket.setTimeout(2000, () => socket.destroy(new Error("raw request timed out")));
      t.after(() => socket.destroy());
    });
    assert.match(response, /^HTTP\/1\.1 400 /);
  }
  assert.deepEqual(h.logs, []);
});

test("authenticated SSH header, path and query ingress retain their separate contract", async (t) => {
  const h = await setup(t);
  const nonce = "a".repeat(32);
  const ingress = h.api.openRemoteSshIngress({
    remoteProfile: { profileId: "fixture-remote", displayHost: "fixture-host" },
    getAcceptedNonces: () => [nonce],
  });
  const port = await ingress.start();
  t.after(() => ingress.close());
  const payload = dummyPermission("ssh", { tool_name: "TaskCreate" });
  for (const [route, headers] of [
    ["/permission", { "x-clawd-routing-nonce": nonce }],
    [`/permission/${nonce}`, {}],
    [`/permission?nonce=${nonce}`, {}],
  ]) {
    const result = await postPermission(port, payload, { Host: "forwarded.fixture", "Content-Type": "text/plain", ...headers }, route).response;
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).hookSpecificOutput.decision.behavior, "allow");
  }
  for (const bad of ["", "b".repeat(32)]) {
    assert.equal((await postPermission(port, payload, { "x-clawd-routing-nonce": bad }).response).status, 404);
  }
  assert.equal((await postPermission(h.port, payload, { "x-clawd-routing-nonce": nonce }).response).status, 404);

  const local = postPermission(h.port, dummyPermission("local"));
  const remote = postPermission(port, dummyPermission("remote"), { "x-clawd-routing-nonce": nonce });
  await waitUntil(() => h.permission.pendingPermissions.length === 2, "local/remote not pending");
  const localEntry = h.permission.pendingPermissions.find((e) => e.toolInput.file_path === "issue-976-local.txt");
  const remoteEntry = h.permission.pendingPermissions.find((e) => e.toolInput.file_path === "issue-976-remote.txt");
  assert.notEqual(localEntry.sessionId, remoteEntry.sessionId);
  h.permission.resolvePermissionEntry(remoteEntry, "allow");
  assert.equal(JSON.parse((await remote.response).body).hookSpecificOutput.decision.behavior, "allow");
  assert.equal(local.settled, false);
  h.permission.resolvePermissionEntry(localEntry, "no-decision");
  assert.equal((await local.response).error, "ECONNRESET");
});

test("real shared HTTP transport and hook adapters preserve no-decision on guard rejection", async (t) => {
  const h = await setup(t);
  for (const headers of [{ Origin: "https://untrusted.example" }, { "Content-Type": "text/plain" }]) {
    const seen = [];
    const post = (body, _options, callback) => postPermissionToPort(h.port, body, 2000,
      (ok, port, responseBody, statusCode) => {
        seen.push({ ok, responseBody, statusCode });
        callback(ok, port, responseBody, statusCode);
      }, {
        env: {},
        httpRequest(options, onResponse) {
          return http.request({ ...options, headers: { ...options.headers, ...headers } }, onResponse);
        },
      });
    const payload = { ...dummyPermission("adapter"), hook_event_name: "PermissionRequest" };
    const codex = await runCodexHook(payload, {
      env: {}, argv: [], resolveWslDistro: () => null,
      readRuntimeIdentity: () => ({ ok: false }),
      createPidResolver: () => () => ({}),
      postPermission: post,
    });
    assert.deepEqual(JSON.parse(codex.stdout), {});
    for (const request of [requestQwenPermission, requestZcodePermission]) {
      const stdout = await new Promise((resolve) => request(payload, resolve, { postPermission: post }));
      assert.deepEqual(JSON.parse(stdout), {});
    }
    assert.equal(seen.length, 3);
    for (const result of seen) {
      assert.equal(result.ok, false);
      assert.ok([403, 415].includes(result.statusCode));
      assert.equal(result.responseBody, "");
      assert.equal(parseClawdPermissionResponse(result.ok, result.responseBody, result.statusCode), null);
    }
  }
  assert.deepEqual(h.shown, []);
  assert.deepEqual(h.logs, []);
});
