"use strict";

// The PLUGIN side of the reverse bridge, executed for real (plan §9 gates:
// bad token, invalid payload, SDK reply shape, bridge init, permission.asked
// carrying the live bridge coordinates).
//
// permission-family-roundtrip.test.js covers the Electron→bridge half; this
// file covers the Bun half by initializing the REAL factory plugin with a
// fake `globalThis.Bun.serve` that captures the fetch handler, a fake global
// fetch (so nothing touches a live Clawd on the real ports), and a mock SDK
// client — then drives handleBridgeRequest/verifyBridgeToken/startBridge/
// handlePermissionAsked through actual Request/Response objects.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, before, after } = require("node:test");
const { pathToFileURL } = require("node:url");

// Redirect HOME before the core module is imported: its CLAWD_DIR constant
// resolves os.homedir() at module-evaluation time, and plugin init resets the
// debug log under it — the suite must never touch the user's real ~/.clawd.
// (node:test runs each file in its own process, so this cannot leak.)
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-family-bridge-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

let createOpencodeFamilyPlugin;
const fetchCalls = [];
let bridgePortCounter = 40000;

before(async () => {
  // Fake fetch: record every POST the plugin fires and answer as a non-Clawd
  // server (missing identity header) so the port scan exhausts harmlessly.
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { status: 200, headers: { get: () => null }, text: async () => "" };
  };
  const modulePath = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
  ({ createOpencodeFamilyPlugin } = await import(pathToFileURL(modulePath).href));
});

after(() => {
  delete globalThis.Bun;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

async function initInstance(params, { sdk } = {}) {
  const captured = { fetch: null, hostname: null, port: null, requestedPort: null };
  globalThis.Bun = {
    serve(opts) {
      captured.fetch = opts.fetch;
      captured.hostname = opts.hostname;
      captured.requestedPort = opts.port;
      captured.port = ++bridgePortCounter; // stand-in for the OS-assigned port
      return { port: captured.port };
    },
  };
  const sdkCalls = [];
  const ctx = {
    serverUrl: "http://127.0.0.1:1/",
    directory: "/tmp/proj",
    client: {
      _client: {
        post: async (args) => {
          sdkCalls.push(args);
          if (sdk && sdk.throw) throw new Error(sdk.throw);
          if (sdk && sdk.error) return { error: sdk.error };
          return { data: {} };
        },
      },
    },
  };
  const plugin = createOpencodeFamilyPlugin(params);
  const hooks = await plugin(ctx);
  return { plugin, hooks, captured, sdkCalls };
}

const OC = Object.freeze({
  agentId: "opencode", hookSource: "opencode-plugin",
  logFileName: "opencode-plugin.log", sessionIdPrefix: "opencode:",
});
const MC = Object.freeze({
  agentId: "mimocode", hookSource: "mimocode-plugin",
  logFileName: "mimocode-plugin.log", sessionIdPrefix: "mimocode:",
});

function bridgeRequest(plugin, { token, method = "POST", pathName = "/reply", body } = {}) {
  const headers = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request(`${plugin.__test._bridgeUrl}${pathName}`, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

describe("opencode-family reverse bridge (plugin side, real handler)", () => {
  it("startBridge produces non-empty, per-instance distinct URL + token; handler captured", async () => {
    const oc = await initInstance(OC);
    const mc = await initInstance(MC);
    for (const inst of [oc, mc]) {
      assert.strictEqual(typeof inst.captured.fetch, "function", "Bun.serve fetch handler not captured");
      assert.strictEqual(inst.captured.hostname, "127.0.0.1");
      // A fixed port would EADDRINUSE against Clawd itself (23333-23337) and
      // silently degrade every bubble to the TUI fallback.
      assert.strictEqual(inst.captured.requestedPort, 0, "bridge must ask the OS for a port (port: 0)");
      assert.match(inst.plugin.__test._bridgeUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(inst.plugin.__test._bridgeTokenHex, /^[a-f0-9]{64}$/);
    }
    assert.notStrictEqual(oc.plugin.__test._bridgeUrl, mc.plugin.__test._bridgeUrl);
    assert.notStrictEqual(oc.plugin.__test._bridgeTokenHex, mc.plugin.__test._bridgeTokenHex);
  });

  it("permission.asked forwards the LIVE bridge url/token of this instance", async () => {
    const oc = await initInstance(OC);
    fetchCalls.length = 0;
    await oc.hooks.event({
      event: {
        type: "permission.asked",
        properties: { id: "per_live", permission: "bash", metadata: { command: "echo x" }, patterns: ["bash"], always: ["bash"] },
      },
    });
    // fire-and-forget IIFE — let the port loop run
    await new Promise((r) => setTimeout(r, 50));
    const permPost = fetchCalls.find((c) => c.url.endsWith("/permission"));
    assert.ok(permPost, "no /permission POST captured");
    assert.strictEqual(permPost.body.request_id, "per_live");
    assert.strictEqual(permPost.body.agent_id, "opencode");
    assert.strictEqual(permPost.body.bridge_url, oc.plugin.__test._bridgeUrl);
    assert.strictEqual(permPost.body.bridge_token, oc.plugin.__test._bridgeTokenHex);
    assert.notStrictEqual(permPost.body.bridge_url, "", "bridge_url must not be empty (dead bubble path)");
  });

  it("proves lastSeen can mis-associate an interleaved permission for opencode and MiMo", async () => {
    for (const params of [OC, MC]) {
      const instance = await initInstance(params);
      await instance.hooks.event({
        event: {
          type: "session.created",
          properties: { sessionID: "root-a", info: {} },
        },
      });
      await instance.hooks.event({
        event: {
          type: "session.created",
          properties: { sessionID: "root-b", info: {} },
        },
      });
      await instance.hooks.event({
        event: {
          type: "session.created",
          properties: { sessionID: "child-c", info: { parentID: "root-a" } },
        },
      });

      fetchCalls.length = 0;
      await instance.hooks.event({
        event: {
          type: "permission.asked",
          properties: {
            id: `permission-for-root-a-${params.agentId}`,
            permission: "bash",
            metadata: { command: "echo root-a" },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const permissionPost = fetchCalls.find((call) => (
        call.url.endsWith("/permission")
        && call.body.request_id === `permission-for-root-a-${params.agentId}`
      ));
      assert.ok(permissionPost, params.agentId);
      assert.strictEqual(
        permissionPost.body.session_id,
        `${params.sessionIdPrefix}child-c`,
        `${params.agentId} currently guesses from the most recent unrelated event`
      );
      assert.notStrictEqual(
        permissionPost.body.session_id,
        `${params.sessionIdPrefix}root-a`
      );
    }
  });

  it("rejects missing/wrong/malformed tokens with 401 and never touches the SDK", async () => {
    const oc = await initInstance(OC);
    const cases = [
      bridgeRequest(oc.plugin, { body: { request_id: "per_1", reply: "once" } }),                          // no auth
      bridgeRequest(oc.plugin, { token: "ff".repeat(32), body: { request_id: "per_1", reply: "once" } }),  // wrong token
      bridgeRequest(oc.plugin, { token: "not-hex!!", body: { request_id: "per_1", reply: "once" } }),      // malformed
      bridgeRequest(oc.plugin, { token: "abcd", body: { request_id: "per_1", reply: "once" } }),           // wrong length
    ];
    for (const req of cases) {
      const res = await oc.captured.fetch(req);
      assert.strictEqual(res.status, 401);
    }
    assert.strictEqual(oc.sdkCalls.length, 0, "SDK must not be called on auth failure");
  });

  it("accepts the real token and forwards the reply through _client.post", async () => {
    const oc = await initInstance(OC);
    const token = oc.plugin.__test._bridgeTokenHex;
    const res = await oc.captured.fetch(
      bridgeRequest(oc.plugin, { token, body: { request_id: "per ok/1", reply: "once" } })
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.strictEqual(oc.sdkCalls.length, 1);
    assert.deepStrictEqual(oc.sdkCalls[0], {
      url: `/permission/${encodeURIComponent("per ok/1")}/reply`,
      body: { reply: "once" },
      headers: { "Content-Type": "application/json" },
    });
  });

  it("404s wrong method/path, 400s bad json and bad payloads — SDK untouched", async () => {
    const oc = await initInstance(OC);
    const token = oc.plugin.__test._bridgeTokenHex;

    assert.strictEqual((await oc.captured.fetch(bridgeRequest(oc.plugin, { token, method: "GET", body: undefined }))).status, 404);
    assert.strictEqual((await oc.captured.fetch(bridgeRequest(oc.plugin, { token, pathName: "/nope", body: { request_id: "x", reply: "once" } }))).status, 404);
    assert.strictEqual((await oc.captured.fetch(bridgeRequest(oc.plugin, { token, body: "{not json" }))).status, 400);
    assert.strictEqual((await oc.captured.fetch(bridgeRequest(oc.plugin, { token, body: { reply: "once" } }))).status, 400);
    assert.strictEqual((await oc.captured.fetch(bridgeRequest(oc.plugin, { token, body: { request_id: "per_1", reply: "maybe" } }))).status, 400);
    assert.strictEqual(oc.sdkCalls.length, 0);
  });

  it("maps SDK error results and throws to 502", async () => {
    const withErr = await initInstance(OC, { sdk: { error: "route exploded" } });
    const res1 = await withErr.captured.fetch(
      bridgeRequest(withErr.plugin, { token: withErr.plugin.__test._bridgeTokenHex, body: { request_id: "per_e", reply: "reject" } })
    );
    assert.strictEqual(res1.status, 502);
    assert.deepStrictEqual(await res1.json(), { ok: false, error: "route exploded" });

    const withThrow = await initInstance(OC, { sdk: { throw: "socket gone" } });
    const res2 = await withThrow.captured.fetch(
      bridgeRequest(withThrow.plugin, { token: withThrow.plugin.__test._bridgeTokenHex, body: { request_id: "per_t", reply: "always" } })
    );
    assert.strictEqual(res2.status, 502);
    assert.deepStrictEqual(await res2.json(), { ok: false, error: "socket gone" });
  });
});
