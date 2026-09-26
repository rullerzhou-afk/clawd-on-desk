"use strict";

// The PLUGIN side of the reverse bridge, executed for real (plan §9 gates:
// bad token, invalid payload, SDK reply shape, bridge init, permission.asked
// carrying the live bridge coordinates).
//
// permission-family-roundtrip.test.js covers the Electron→bridge half; this
// file covers the Bun runtime half by initializing the REAL factory plugin with a
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
const RUNTIME_CONFIG_PATH = path.join(TMP_HOME, ".clawd", "runtime.json");

function writeLiveRuntimeIdentity() {
  fs.mkdirSync(path.dirname(RUNTIME_CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify({
    app: "clawd-on-desk",
    port: 23333,
    ownerPid: process.pid,
  }), { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(RUNTIME_CONFIG_PATH, 0o600);
}

writeLiveRuntimeIdentity();

let createOpencodeFamilyPlugin;
const fetchCalls = [];
let bridgePortCounter = 40000;
let clawdResponseRecognized = false;
let fetchBehavior = null;

function fakeClawdResponse(recognized = clawdResponseRecognized) {
  return {
    status: 200,
    headers: {
      get(name) {
        return recognized && String(name).toLowerCase() === "x-clawd-server"
          ? "clawd-on-desk"
          : null;
      },
    },
    text: async () => "",
  };
}

before(async () => {
  // Fake fetch: record every POST the plugin fires and answer as a non-Clawd
  // server (missing identity header) so the port scan exhausts harmlessly.
  globalThis.fetch = async (url, opts) => {
    const call = { url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null };
    fetchCalls.push(call);
    if (typeof fetchBehavior === "function") return fetchBehavior(call);
    return fakeClawdResponse();
  };
  const modulePath = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
  ({ createOpencodeFamilyPlugin } = await import(pathToFileURL(modulePath).href));
});

after(() => {
  delete globalThis.Bun;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

async function initInstance(params, { sdk, plugin: existingPlugin, directory = "/tmp/proj" } = {}) {
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
    directory,
    client: {
      _client: {
        post: async (args) => {
          sdkCalls.push(args);
          if (sdk && typeof sdk.onPost === "function") await sdk.onPost(args);
          if (sdk && sdk.throw) throw new Error(sdk.throw);
          if (sdk && sdk.error) return { error: sdk.error };
          return { data: {} };
        },
      },
    },
  };
  const plugin = existingPlugin || createOpencodeFamilyPlugin(params);
  const hooks = await plugin(ctx);
  return { plugin, hooks, captured, sdkCalls };
}

async function emitPermission(instance, requestId, sessionID = "ses_permission") {
  await instance.hooks.event({
    event: {
      type: "permission.asked",
      properties: {
        id: requestId,
        sessionID,
        permission: "bash",
        metadata: { command: "echo permission" },
      },
    },
  });
}

async function emitPermissionReplied(instance, properties) {
  await instance.hooks.event({
    event: { type: "permission.replied", properties },
  });
}

async function settlePermissionTail(plugin, requestId) {
  const tail = plugin.__test._permissionPostTailByRequestId.get(requestId);
  if (tail) await tail;
  await Promise.resolve();
}

async function waitUntil(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

  it("does not disclose bridge credentials when the live runtime identity is missing", async () => {
    const oc = await initInstance(OC);
    fetchCalls.length = 0;
    fs.unlinkSync(RUNTIME_CONFIG_PATH);
    try {
      await emitPermission(oc, "per_no_runtime");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.strictEqual(
        fetchCalls.some((call) => call.url.endsWith("/permission")),
        false,
        "permission delivery must not fall back to the scanned port range"
      );
    } finally {
      writeLiveRuntimeIdentity();
    }
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
    await emitPermission(oc, "per ok/1");
    const res = await oc.captured.fetch(
      bridgeRequest(oc.plugin, { token, body: { request_id: "per ok/1", reply: "once" } })
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.strictEqual(oc.sdkCalls.length, 1);
    assert.deepStrictEqual(oc.sdkCalls[0], {
      url: `/permission/${encodeURIComponent("per ok/1")}/reply`,
      query: { directory: "/tmp/proj" },
      body: { reply: "once" },
      headers: { "Content-Type": "application/json" },
    });
  });

  it("binds an interleaved reply to the directory instance that emitted it", async () => {
    const plugin = createOpencodeFamilyPlugin(OC);
    const a = await initInstance(OC, {
      plugin,
      directory: "C:\\project-a",
    });
    const bridgeUrl = plugin.__test._bridgeUrl;
    const bridgeToken = plugin.__test._bridgeTokenHex;
    const b = await initInstance(OC, {
      plugin,
      directory: "C:\\history-b",
    });

    assert.strictEqual(plugin.__test._bridgeUrl, bridgeUrl, "later init must reuse the factory bridge");
    assert.strictEqual(plugin.__test._bridgeTokenHex, bridgeToken, "later init must not rotate the live token");
    assert.strictEqual(b.captured.fetch, null, "later directory must not leak another Bun server");

    await a.hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_a",
          info: { id: "ses_a", directory: "C:\\project-a" },
        },
      },
    });
    await emitPermission(a, "per_a", "ses_a");
    const res = await a.captured.fetch(
      bridgeRequest(plugin, { token: bridgeToken, body: { request_id: "per_a", reply: "once" } })
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(a.sdkCalls.length, 1, "originating client must receive the reply");
    assert.strictEqual(b.sdkCalls.length, 0, "latest initialized client must stay untouched");
    assert.deepStrictEqual(a.sdkCalls[0].query, { directory: "C:\\project-a" });
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
    await emitPermission(withErr, "per_e");
    const res1 = await withErr.captured.fetch(
      bridgeRequest(withErr.plugin, { token: withErr.plugin.__test._bridgeTokenHex, body: { request_id: "per_e", reply: "reject" } })
    );
    assert.strictEqual(res1.status, 502);
    assert.deepStrictEqual(await res1.json(), { ok: false, error: "route exploded" });

    const withThrow = await initInstance(OC, { sdk: { throw: "socket gone" } });
    await emitPermission(withThrow, "per_t");
    const res2 = await withThrow.captured.fetch(
      bridgeRequest(withThrow.plugin, { token: withThrow.plugin.__test._bridgeTokenHex, body: { request_id: "per_t", reply: "always" } })
    );
    assert.strictEqual(res2.status, 502);
    assert.deepStrictEqual(await res2.json(), { ok: false, error: "socket gone" });
  });
});

describe("opencode-family permission completion lifecycle", () => {
  it("forwards only the current requestID/reply generation and invalidates the reverse target first", async () => {
    clawdResponseRecognized = true;
    fetchBehavior = null;
    try {
      for (const params of [OC, MC]) {
        const instance = await initInstance(params);
        const requestId = `per_current_${params.agentId}`;
        fetchCalls.length = 0;
        await emitPermission(instance, requestId, "ses_current");
        await settlePermissionTail(instance.plugin, requestId);
        fetchCalls.length = 0;

        await emitPermissionReplied(instance, {
          sessionID: "ses_current",
          requestID: requestId,
          reply: "once",
        });
        assert.strictEqual(
          instance.plugin.__test._permissionTargetByRequestId.has(requestId),
          false,
          "native resolution must synchronously invalidate the reverse target"
        );
        await settlePermissionTail(instance.plugin, requestId);

        assert.strictEqual(fetchCalls.length, 1);
        const body = fetchCalls[0].body;
        assert.deepStrictEqual({
          agent_id: body.agent_id,
          hook_source: body.hook_source,
          permission_event: body.permission_event,
          session_id: body.session_id,
          request_id: body.request_id,
          lifecycle_bridge_url: body.lifecycle_bridge_url,
          lifecycle_bridge_token: body.lifecycle_bridge_token,
        }, {
          agent_id: params.agentId,
          hook_source: params.hookSource,
          permission_event: "replied",
          session_id: `${params.sessionIdPrefix}ses_current`,
          request_id: requestId,
          lifecycle_bridge_url: instance.plugin.__test._bridgeUrl,
          lifecycle_bridge_token: instance.plugin.__test._bridgeTokenHex,
        });
        for (const forbidden of ["tool_name", "tool_input", "always", "patterns", "reply", "response", "bridge_url", "bridge_token"]) {
          assert.strictEqual(Object.hasOwn(body, forbidden), false, forbidden);
        }

        const staleClick = await instance.captured.fetch(
          bridgeRequest(instance.plugin, {
            token: instance.plugin.__test._bridgeTokenHex,
            body: { request_id: requestId, reply: "once" },
          })
        );
        assert.strictEqual(staleClick.status, 404);
        assert.strictEqual(instance.sdkCalls.length, 0, "external cleanup must never call the host SDK");
      }
    } finally {
      clawdResponseRecognized = false;
      fetchBehavior = null;
    }
  });

  it("fails stale completion shapes closed and logs bounded key names without values", async () => {
    const instance = await initInstance(OC);
    fetchCalls.length = 0;
    await emitPermissionReplied(instance, {
      sessionID: "ses_stale",
      permissionID: "secret-stale-permission-value",
      response: "secret-stale-response-value",
    });
    await emitPermissionReplied(instance, { id: "secret-guessed-id-value" });
    await instance.plugin.__test.flushDebugLog();

    assert.strictEqual(fetchCalls.length, 0);
    const log = fs.readFileSync(instance.plugin.__test._debugLogPath, "utf8");
    assert.match(log, /unsupported-shape keys=\[sessionID,permissionID,response\]/);
    assert.match(log, /unsupported-shape keys=\[id\]/);
    assert.doesNotMatch(log, /secret-stale-permission-value|secret-stale-response-value|secret-guessed-id-value/);
  });

  it("uses the asked target session on mismatch, but still reports an evicted target from the event session", async () => {
    clawdResponseRecognized = true;
    try {
      const instance = await initInstance(OC);
      await emitPermission(instance, "per_target_session", "ses_target");
      await settlePermissionTail(instance.plugin, "per_target_session");
      fetchCalls.length = 0;

      await emitPermissionReplied(instance, {
        sessionID: "ses_other",
        requestID: "per_target_session",
        reply: "reject",
      });
      await settlePermissionTail(instance.plugin, "per_target_session");
      assert.strictEqual(fetchCalls[0].body.session_id, "opencode:ses_target");

      fetchCalls.length = 0;
      await emitPermissionReplied(instance, {
        sessionID: "ses_evicted",
        requestID: "per_evicted",
        reply: "always",
      });
      await settlePermissionTail(instance.plugin, "per_evicted");
      assert.strictEqual(fetchCalls[0].body.session_id, "opencode:ses_evicted");

      await instance.plugin.__test.flushDebugLog();
      const log = fs.readFileSync(instance.plugin.__test._debugLogPath, "utf8");
      assert.match(log, /session mismatch req=per_target_session/);
    } finally {
      clawdResponseRecognized = false;
    }
  });

  it("does not let a standalone replied event pollute root/last-seen fallback state", async () => {
    clawdResponseRecognized = true;
    try {
      const instance = await initInstance(OC);
      await emitPermissionReplied(instance, {
        sessionID: "ses_completion_only",
        requestID: "per_completion_only",
        reply: "once",
      });
      await settlePermissionTail(instance.plugin, "per_completion_only");
      assert.strictEqual(instance.plugin.__test._rootSessionId, null);
      assert.strictEqual(instance.plugin.__test._lastSeenSessionId, null);

      fetchCalls.length = 0;
      await emitPermission(instance, "per_missing_session", null);
      await settlePermissionTail(instance.plugin, "per_missing_session");
      assert.strictEqual(fetchCalls[0].body.session_id, "opencode:default");
    } finally {
      clawdResponseRecognized = false;
    }
  });

  it("serializes asked→replied for one request while a different request remains parallel", async () => {
    clawdResponseRecognized = true;
    let releaseAsked;
    const askedGate = new Promise((resolve) => { releaseAsked = resolve; });
    fetchBehavior = async (call) => {
      if (call.body && call.body.request_id === "per_fifo_a" && !call.body.permission_event) {
        await askedGate;
      }
      return fakeClawdResponse(true);
    };
    try {
      const instance = await initInstance(OC);
      fetchCalls.length = 0;
      await emitPermission(instance, "per_fifo_a", "ses_fifo");
      await waitUntil(() => fetchCalls.length === 1, "asked POST did not start");
      await emitPermissionReplied(instance, {
        sessionID: "ses_fifo",
        requestID: "per_fifo_a",
        reply: "once",
      });
      await emitPermission(instance, "per_fifo_b", "ses_fifo");
      await waitUntil(
        () => fetchCalls.some((call) => call.body && call.body.request_id === "per_fifo_b"),
        "different request was blocked behind stalled request"
      );
      assert.strictEqual(
        fetchCalls.some((call) => call.body && call.body.request_id === "per_fifo_a" && call.body.permission_event === "replied"),
        false,
        "same-request lifecycle overtook its asked POST"
      );

      releaseAsked();
      await settlePermissionTail(instance.plugin, "per_fifo_a");
      await settlePermissionTail(instance.plugin, "per_fifo_b");
      const aCalls = fetchCalls.filter((call) => call.body && call.body.request_id === "per_fifo_a");
      assert.deepStrictEqual(aCalls.map((call) => call.body.permission_event || "asked"), ["asked", "replied"]);
      assert.strictEqual(instance.plugin.__test._permissionPostTailByRequestId.size, 0);
    } finally {
      releaseAsked();
      fetchBehavior = null;
      clawdResponseRecognized = false;
    }
  });

  it("stops lifecycle delivery after one recognized response and bounds persistent failure at three attempts", async () => {
    const instance = await initInstance(OC);
    try {
      clawdResponseRecognized = true;
      fetchCalls.length = 0;
      await emitPermissionReplied(instance, {
        sessionID: "ses_retry",
        requestID: "per_retry_ok",
        reply: "once",
      });
      await settlePermissionTail(instance.plugin, "per_retry_ok");
      assert.strictEqual(fetchCalls.length, 1);

      clawdResponseRecognized = false;
      fetchCalls.length = 0;
      const startedAt = Date.now();
      await emitPermissionReplied(instance, {
        sessionID: "ses_retry",
        requestID: "per_retry_fail",
        reply: "reject",
      });
      await settlePermissionTail(instance.plugin, "per_retry_fail");
      const elapsed = Date.now() - startedAt;
      assert.strictEqual(fetchCalls.length, 3);
      assert.ok(elapsed >= 450 && elapsed < 1800, `retry duration out of bounds: ${elapsed}ms`);
      assert.strictEqual(instance.plugin.__test._permissionPostTailByRequestId.size, 0);
    } finally {
      clawdResponseRecognized = false;
      fetchBehavior = null;
    }
  });

  it("keeps Clawd-first echo and multi-request cascades idempotent without a second host decision", async () => {
    clawdResponseRecognized = true;
    const sdk = {};
    try {
      const instance = await initInstance(OC, { sdk });
      sdk.onPost = async () => {
        await emitPermissionReplied(instance, {
          sessionID: "ses_echo",
          requestID: "per_echo",
          reply: "always",
        });
      };
      await emitPermission(instance, "per_echo", "ses_echo");
      await settlePermissionTail(instance.plugin, "per_echo");
      fetchCalls.length = 0;

      const bridgeResponse = await instance.captured.fetch(
        bridgeRequest(instance.plugin, {
          token: instance.plugin.__test._bridgeTokenHex,
          body: { request_id: "per_echo", reply: "always" },
        })
      );
      assert.strictEqual(bridgeResponse.status, 200);
      await settlePermissionTail(instance.plugin, "per_echo");
      assert.strictEqual(instance.sdkCalls.length, 1, "Clawd decision reaches the host once");
      assert.strictEqual(
        fetchCalls.filter((call) => call.body && call.body.request_id === "per_echo" && call.body.permission_event === "replied").length,
        1,
        "host echo is one cleanup lifecycle"
      );

      sdk.onPost = null;
      for (const requestId of ["per_cascade_a", "per_cascade_b"]) {
        await emitPermission(instance, requestId, "ses_echo");
        await settlePermissionTail(instance.plugin, requestId);
      }
      fetchCalls.length = 0;
      await Promise.all([
        emitPermissionReplied(instance, { sessionID: "ses_echo", requestID: "per_cascade_a", reply: "reject" }),
        emitPermissionReplied(instance, { sessionID: "ses_echo", requestID: "per_cascade_b", reply: "always" }),
      ]);
      await Promise.all([
        settlePermissionTail(instance.plugin, "per_cascade_a"),
        settlePermissionTail(instance.plugin, "per_cascade_b"),
      ]);
      assert.deepStrictEqual(
        fetchCalls.map((call) => call.body.request_id).sort(),
        ["per_cascade_a", "per_cascade_b"]
      );

      fetchCalls.length = 0;
      await emitPermissionReplied(instance, { sessionID: "ses_echo", requestID: "per_cascade_a", reply: "reject" });
      await settlePermissionTail(instance.plugin, "per_cascade_a");
      assert.strictEqual(fetchCalls.length, 1, "duplicate completion is an idempotent cleanup delivery");
      assert.strictEqual(instance.plugin.__test._permissionPostTailByRequestId.size, 0);
      assert.strictEqual(instance.sdkCalls.length, 1, "completion traffic never calls the SDK");
    } finally {
      clawdResponseRecognized = false;
      fetchBehavior = null;
    }
  });

  it("bounds target history and releases lifecycle tails after a large permission sequence", async () => {
    clawdResponseRecognized = true;
    try {
      const instance = await initInstance(OC);
      const requestIds = Array.from({ length: 270 }, (_, index) => `per_pressure_${index}`);
      for (const requestId of requestIds) {
        await emitPermission(instance, requestId, "ses_pressure");
      }
      await Promise.all(requestIds.map((requestId) => settlePermissionTail(instance.plugin, requestId)));
      assert.strictEqual(instance.plugin.__test._permissionTargetByRequestId.size, 256);

      for (const requestId of requestIds) {
        await emitPermissionReplied(instance, {
          sessionID: "ses_pressure",
          requestID: requestId,
          reply: "once",
        });
      }
      await Promise.all(requestIds.map((requestId) => settlePermissionTail(instance.plugin, requestId)));
      assert.strictEqual(instance.plugin.__test._permissionTargetByRequestId.size, 0);
      assert.strictEqual(instance.plugin.__test._permissionPostTailByRequestId.size, 0);
    } finally {
      clawdResponseRecognized = false;
    }
  });
});

describe("opencode-family permission fan-out (one bubble per request)", () => {
  // OpenCode V2 loads one plugin instance per location and delivers every
  // event to all of them. Before the per-request dedup, each instance posted
  // its own /permission forward and the user saw N identical bubbles.
  it("posts exactly one bubble when every instance receives the same permission.asked", async () => {
    clawdResponseRecognized = true;
    fetchBehavior = null;
    try {
      const plugin = createOpencodeFamilyPlugin(OC);
      const a = await initInstance(OC, { plugin, directory: "C:\\project-a" });
      const b = await initInstance(OC, { plugin, directory: "C:\\project-b" });
      fetchCalls.length = 0;

      await emitPermission(a, "per_fanout", "ses_fanout");
      await emitPermission(b, "per_fanout", "ses_fanout");
      await settlePermissionTail(plugin, "per_fanout");

      const bubbles = fetchCalls.filter((call) => (
        call.url.endsWith("/permission") && call.body && call.body.request_id === "per_fanout"
      ));
      assert.strictEqual(bubbles.length, 1, "duplicate permission.asked deliveries must not spawn a second bubble");
    } finally {
      clawdResponseRecognized = false;
    }
  });

  it("still forwards duplicate completions as idempotent cleanup deliveries", async () => {
    clawdResponseRecognized = true;
    fetchBehavior = null;
    try {
      const plugin = createOpencodeFamilyPlugin(OC);
      const a = await initInstance(OC, { plugin, directory: "C:\\project-a" });
      const b = await initInstance(OC, { plugin, directory: "C:\\project-b" });
      await emitPermission(a, "per_fanout_reply", "ses_fanout_reply");
      await settlePermissionTail(plugin, "per_fanout_reply");
      fetchCalls.length = 0;

      await emitPermissionReplied(a, {
        sessionID: "ses_fanout_reply",
        requestID: "per_fanout_reply",
        reply: "once",
      });
      await emitPermissionReplied(b, {
        sessionID: "ses_fanout_reply",
        requestID: "per_fanout_reply",
        reply: "once",
      });
      await settlePermissionTail(plugin, "per_fanout_reply");

      const dismissals = fetchCalls.filter((call) => (
        call.body && call.body.permission_event === "replied" && call.body.request_id === "per_fanout_reply"
      ));
      assert.strictEqual(dismissals.length, 2, "completion delivery is idempotent by contract, not deduped");
    } finally {
      clawdResponseRecognized = false;
    }
  });
});
