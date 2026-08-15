"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const vm = require("node:vm");
const { classifyFeishuSdkError } = require("../src/feishu-approval-client");
const feishuApprovalSettings = require("../src/feishu-approval-settings");
const { createSettingsController } = require("../src/settings-controller");
const { commandRegistry, saveFeishuApproverByEmail } = require("../src/settings-actions");

// main.js cannot be required here (it pulls in electron), so this follows the
// existing main-*.test.js convention of reading the source. Where behavior can
// actually be executed — the config signature — we lift the real function into
// a VM instead of grepping for strings.
const MAIN_SOURCE = fs.readFileSync(path.resolve(__dirname, "..", "src", "main.js"), "utf8");

function extractFnSource(name) {
  let start = MAIN_SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in main.js`);
  if (MAIN_SOURCE.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const end = MAIN_SOURCE.indexOf("\n}", start);
  assert.notEqual(end, -1, `${name} should be terminated`);
  return MAIN_SOURCE.slice(start, end + 2);
}

function loadFn(name, extraContext = {}) {
  if (
    (name === "buildFeishuApprovalSignature" || name === "buildFeishuSessionAutomationRouteSignature")
    && typeof extraContext.buildFeishuApprovalBindingSignatureFields !== "function"
  ) {
    extraContext.buildFeishuApprovalBindingSignatureFields = loadFn(
      "buildFeishuApprovalBindingSignatureFields",
      extraContext,
    );
  }
  const block = extractFnSource(name);
  const context = extraContext;
  context.globalThis = context;
  vm.runInNewContext(`${block}\nresult = ${name};`, context);
  return context.result;
}

function createDeferred() {
  const deferred = {};
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  return deferred;
}

function createFeishuApprovalTestHarness({ requestApproval, captureLogs = false }) {
  const clearedTimers = [];
  const logs = [];
  let timerCallback = null;
  let timerDelay = null;
  let timerHandle = 0;
  const client = { requestApproval };
  const sendFeishuApprovalTest = loadFn("sendFeishuApprovalTest", {
    getFeishuApprovalStatus: () => ({ configured: true }),
    queueFeishuApprovalSync: async () => true,
    getConfiguredFeishuApprovalClient: () => client,
    AbortController,
    setTimeout: (fn, ms) => {
      timerCallback = fn;
      timerDelay = ms;
      timerHandle += 1;
      return timerHandle;
    },
    clearTimeout: (id) => clearedTimers.push(id),
    translate: (key) => key,
    classifyFeishuSdkError,
    feishuApprovalLog: captureLogs
      ? (level, message, meta) => logs.push({ level, message, meta })
      : () => {},
  });
  return {
    sendFeishuApprovalTest,
    clearedTimers,
    logs,
    timer: {
      get callback() { return timerCallback; },
      get delay() { return timerDelay; },
    },
  };
}

const SENTINELS = Object.freeze([
  "cli_sensitive_app_id",
  "sensitive_app_secret_123",
  "secret-review@example.com",
  "synthetic_tenant_token_abc",
  "Bearer synthetic_authorization_token_456",
]);

function createSentinelSdkError() {
  const error = new Error(`SDK rejected ${SENTINELS.join(" ")}`);
  error.code = "ECONNRESET";
  error.response = {
    status: 403,
    data: {
      code: 1000040351,
      email: SENTINELS[2],
      token: SENTINELS[3],
      body: { appSecret: SENTINELS[1] },
    },
    headers: { authorization: SENTINELS[4] },
    config: {
      url: `https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?email=${SENTINELS[2]}`,
      params: { email: SENTINELS[2] },
      data: { appId: SENTINELS[0], appSecret: SENTINELS[1] },
      headers: { Authorization: SENTINELS[4], "X-Tenant-Token": SENTINELS[3] },
    },
  };
  error.config = error.response.config;
  error.nested = { original: error.response, secret: SENTINELS[1] };
  error.cyclic = error;
  return error;
}

function assertNoSentinels(value, label) {
  const rendered = util.inspect(value, { depth: 12, showHidden: true });
  for (const sentinel of SENTINELS) {
    assert.ok(!rendered.includes(sentinel), `${label} must not contain ${sentinel}`);
  }
}

function assertAllowlistedSdkMetadata(meta, expectedStage) {
  const allowed = new Set(["code", "stage", "httpStatus", "businessCode", "networkCode"]);
  for (const key of Object.keys(meta || {})) {
    assert.ok(allowed.has(key), `unexpected SDK metadata field: ${key}`);
  }
  assert.equal(meta.stage, expectedStage);
  assert.equal(meta.code, "wrong-platform");
  assert.equal(meta.httpStatus, 403);
  assert.equal(meta.businessCode, 1000040351);
  assert.equal(meta.networkCode, "ECONNRESET");
  assertNoSentinels(meta, `${expectedStage} classification`);
}

const PATHS = { secretsEnvFilePath: "/tmp/feishu-approval.env" };
const SECRETS = {
  credentialPlatform: "feishu",
  appId: "cli_1",
  appSecret: "s",
  verificationToken: "",
  encryptKey: "",
};
const CONFIG = {
  enabled: true,
  platform: "feishu",
  idType: "open_id",
  approverId: "ou_1",
  approverSource: "lookup",
  approverBoundPlatform: "feishu",
  approverBoundAppId: "cli_1",
  connectionTimeoutSeconds: 15,
};

describe("main Feishu/Lark approval platform wiring", () => {
  it("changes the config signature when the platform changes", () => {
    const buildFeishuApprovalSignature = loadFn("buildFeishuApprovalSignature", {
      feishuApprovalSecretsRevision: 0,
    });

    const feishu = buildFeishuApprovalSignature(CONFIG, PATHS, SECRETS);
    const lark = buildFeishuApprovalSignature({ ...CONFIG, platform: "lark" }, PATHS, SECRETS);

    // The signature is what startFeishuApprovalClient compares to decide
    // between "reuse the live client" and "tear it down and rebuild". If the
    // platform were missing from it, switching to Lark would keep the old WS
    // connected to Feishu and reuse the Feishu REST client + token cache.
    assert.notEqual(feishu, lark, "platform must be part of the signature");
    assert.match(feishu, /"platform":"feishu"/);
    assert.match(lark, /"platform":"lark"/);
  });

  it("keeps the signature stable when nothing changes", () => {
    const buildFeishuApprovalSignature = loadFn("buildFeishuApprovalSignature", {
      feishuApprovalSecretsRevision: 0,
    });
    assert.equal(
      buildFeishuApprovalSignature(CONFIG, PATHS, SECRETS),
      buildFeishuApprovalSignature({ ...CONFIG }, PATHS, SECRETS),
      "an unchanged config must not trigger a pointless reconnect"
    );
    // Sanity: fields that do matter still move it.
    for (const patch of [{ enabled: false }, { idType: "user_id" }, { approverId: "ou_2" }, { connectionTimeoutSeconds: 30 }]) {
      assert.notEqual(
        buildFeishuApprovalSignature(CONFIG, PATHS, SECRETS),
        buildFeishuApprovalSignature({ ...CONFIG, ...patch }, PATHS, SECRETS),
        `${JSON.stringify(patch)} should change the signature`
      );
    }
  });

  it("binds runtime and route signatures to credential and approver provenance without Secrets", () => {
    const context = { feishuApprovalSecretsRevision: 4 };
    const buildRuntime = loadFn("buildFeishuApprovalSignature", context);
    const buildRoute = loadFn("buildFeishuSessionAutomationRouteSignature", context);
    const secretSentinels = {
      ...SECRETS,
      appSecret: "runtime-signature-secret-sentinel",
      verificationToken: "runtime-signature-token-sentinel",
      encryptKey: "runtime-signature-encrypt-sentinel",
    };
    const runtime = buildRuntime(CONFIG, PATHS, secretSentinels);
    const route = buildRoute(CONFIG, secretSentinels, 4);

    for (const signature of [runtime, route]) {
      assert.match(signature, /"credentialPlatform":"feishu"/);
      assert.match(signature, /"approverSource":"lookup"/);
      assert.match(signature, /"approverBoundPlatform":"feishu"/);
      assert.match(signature, /"approverBoundAppId":"cli_1"/);
      assert.doesNotMatch(signature, /runtime-signature-(?:secret|token|encrypt)-sentinel/);
    }
    for (const patch of [
      { approverSource: "manual" },
      { approverBoundPlatform: "lark" },
      { approverBoundAppId: "cli_other" },
    ]) {
      assert.notEqual(buildRuntime(CONFIG, PATHS, SECRETS), buildRuntime({ ...CONFIG, ...patch }, PATHS, SECRETS));
      assert.notEqual(buildRoute(CONFIG, SECRETS, 4), buildRoute({ ...CONFIG, ...patch }, SECRETS, 4));
    }
    assert.notEqual(
      buildRuntime(CONFIG, PATHS, SECRETS),
      buildRuntime(CONFIG, PATHS, { ...SECRETS, credentialPlatform: "lark" }),
    );
  });

  it("Secret-only rotation rebuilds runtime without invalidating the bound approver", () => {
    const context = { feishuApprovalSecretsRevision: 8 };
    const buildRuntime = loadFn("buildFeishuApprovalSignature", context);
    const before = buildRuntime(CONFIG, PATHS, SECRETS);
    context.feishuApprovalSecretsRevision = 9;
    const rotatedSecrets = { ...SECRETS, appSecret: "rotated-secret" };
    const after = buildRuntime(CONFIG, PATHS, rotatedSecrets);

    assert.notEqual(before, after);
    assert.equal(feishuApprovalSettings.readiness(CONFIG, SECRETS).ready, true);
    assert.equal(feishuApprovalSettings.readiness(CONFIG, rotatedSecrets).ready, true);
  });

  it("failed credential persistence preserves the current route and session automation state", () => {
    const events = [];
    const failure = Object.freeze({ status: "error", code: "write-failed" });
    const prospectiveSecrets = { credentialPlatform: "feishu", appId: "cli_2" };
    const routeState = {
      current: true,
      pendingCandidates: ["candidate-current"],
      activeGrants: ["grant-current"],
      cardWork: ["card-current"],
    };
    const client = {
      markSessionAutomationRouteStale() {
        events.push("route-stale");
        routeState.current = false;
      },
      markSessionAutomationRouteCurrent() {
        events.push("route-current");
        routeState.current = true;
      },
    };
    const context = {
      getFeishuApprovalPaths: () => PATHS,
      getFeishuApprovalPrefs: () => CONFIG,
      buildFeishuSessionAutomationRouteSignature: (_config, secrets, revision) => {
        assert.strictEqual(secrets, prospectiveSecrets);
        assert.equal(revision, 12);
        return "prospective-route-r12";
      },
      feishuApprovalSecretsRevision: 11,
      feishuApprovalSettings: {
        writeSecretsEnvFile: ({ secrets }) => {
          events.push("write");
          assert.strictEqual(secrets, prospectiveSecrets);
          return failure;
        },
      },
      fs: {},
      path: {},
      process: { platform: "test" },
      feishuApprovalClient: client,
      feishuSessionAutomationRouteSignature: "current-route-r11",
      sessionAutomationCoordinator: {
        onRemoteClientRouteChange(receivedClient) {
          events.push("coordinator-route-change");
          assert.strictEqual(receivedClient, client);
          routeState.pendingCandidates.length = 0;
          routeState.activeGrants.length = 0;
          routeState.cardWork.length = 0;
        },
      },
      queueFeishuApprovalSync: () => events.push("sync"),
    };
    context.prepareFeishuSessionAutomationRouteChange = loadFn(
      "prepareFeishuSessionAutomationRouteChange",
      context,
    );
    const writeFeishuApprovalSecrets = loadFn("writeFeishuApprovalSecrets", context);

    const result = writeFeishuApprovalSecrets(prospectiveSecrets);

    assert.strictEqual(result, failure, "the writer result must be returned unchanged");
    assert.deepEqual(events, ["write"]);
    assert.equal(context.feishuApprovalSecretsRevision, 11);
    assert.equal(context.feishuSessionAutomationRouteSignature, "current-route-r11");
    assert.deepEqual(routeState, {
      current: true,
      pendingCandidates: ["candidate-current"],
      activeGrants: ["grant-current"],
      cardWork: ["card-current"],
    });
  });

  it("successful credential persistence writes before invalidating the prospective route and syncing once", () => {
    const events = [];
    const success = Object.freeze({ status: "ok" });
    const prospectiveSecrets = { credentialPlatform: "feishu", appId: "cli_2" };
    const client = {
      routeCurrent: true,
      cardWork: { pending: true },
      markSessionAutomationRouteStale() {
        events.push("route-stale");
        this.routeCurrent = false;
      },
    };
    const context = {
      getFeishuApprovalPaths: () => PATHS,
      getFeishuApprovalPrefs: () => CONFIG,
      buildFeishuSessionAutomationRouteSignature: (_config, secrets, revision) => {
        events.push(`signature:${revision}`);
        assert.strictEqual(secrets, prospectiveSecrets);
        return `prospective-route-r${revision}`;
      },
      feishuApprovalSecretsRevision: 20,
      feishuApprovalSettings: {
        writeSecretsEnvFile: ({ secrets }) => {
          events.push("write");
          assert.strictEqual(secrets, prospectiveSecrets);
          return success;
        },
      },
      fs: {},
      path: {},
      process: { platform: "test" },
      feishuApprovalClient: client,
      feishuSessionAutomationRouteSignature: "current-route-r20",
      sessionAutomationCoordinator: {
        onRemoteClientRouteChange(receivedClient) {
          events.push("coordinator-route-change");
          assert.strictEqual(receivedClient, client);
          assert.deepEqual(receivedClient.cardWork, { pending: true });
        },
      },
      queueFeishuApprovalSync: (reason) => {
        events.push(`sync:${reason}:r${context.feishuApprovalSecretsRevision}`);
      },
    };
    const prepareRouteChange = loadFn("prepareFeishuSessionAutomationRouteChange", context);
    context.prepareFeishuSessionAutomationRouteChange = (signature) => {
      events.push(`invalidate:${signature}`);
      return prepareRouteChange(signature);
    };
    const writeFeishuApprovalSecrets = loadFn("writeFeishuApprovalSecrets", context);

    const result = writeFeishuApprovalSecrets(prospectiveSecrets);

    assert.strictEqual(result, success);
    assert.deepEqual(events, [
      "signature:21",
      "write",
      "invalidate:prospective-route-r21",
      "route-stale",
      "coordinator-route-change",
      "sync:secrets:r21",
    ]);
    assert.equal(context.feishuApprovalSecretsRevision, 21);
    assert.equal(client.routeCurrent, false);
  });

  it("status, start, sync, and Test all fail closed on the same saved identity mismatch", async () => {
    const mismatchedSecrets = { ...SECRETS, credentialPlatform: "lark" };
    const status = loadFn("getFeishuApprovalStatus", {
      getFeishuApprovalPrefs: () => CONFIG,
      getFeishuApprovalSecrets: () => mismatchedSecrets,
      feishuApprovalSettings,
      feishuApprovalClient: null,
    })();
    assert.equal(status.configured, false);
    assert.equal(status.reason, "credential-platform-mismatch");

    let constructed = 0;
    class ForbiddenClient { constructor() { constructed += 1; } }
    const startContext = {
      getFeishuApprovalPrefs: () => CONFIG,
      getFeishuApprovalPaths: () => PATHS,
      getFeishuApprovalSecrets: () => mismatchedSecrets,
      feishuApprovalSettings,
      feishuApprovalClient: null,
      FeishuApprovalClient: ForbiddenClient,
      feishuApprovalLog: () => {},
    };
    assert.equal(await loadFn("startFeishuApprovalClient", startContext)(), false);
    assert.equal(constructed, 0);

    let syncStarts = 0;
    let syncStops = 0;
    const sync = loadFn("syncFeishuApproval", {
      isQuitting: false,
      getFeishuApprovalPrefs: () => CONFIG,
      getFeishuApprovalSecrets: () => mismatchedSecrets,
      feishuApprovalSettings,
      stopFeishuApprovalClient: () => { syncStops += 1; },
      startFeishuApprovalClient: async () => { syncStarts += 1; return true; },
      feishuApprovalLog: () => {},
    });
    assert.equal(await sync("test"), false);
    assert.equal(syncStarts, 0);
    assert.equal(syncStops, 1);

    let queued = 0;
    let cards = 0;
    const sendTest = loadFn("sendFeishuApprovalTest", {
      getFeishuApprovalStatus: () => status,
      feishuApprovalUnavailableResult: (snapshot) => ({
        status: "error",
        code: snapshot.reason,
      }),
      queueFeishuApprovalSync: async () => { queued += 1; return true; },
      getConfiguredFeishuApprovalClient: () => ({
        requestApproval: async () => { cards += 1; return "allow"; },
      }),
    });
    const result = await sendTest();
    assert.equal(result.status, "error");
    assert.equal(result.code, "credential-platform-mismatch");
    assert.equal(queued, 0);
    assert.equal(cards, 0);
  });

  it("exposes independent credential and setup readiness from the shared evaluator", () => {
    const disabled = loadFn("getFeishuApprovalStatus", {
      getFeishuApprovalPrefs: () => ({ ...CONFIG, enabled: false }),
      getFeishuApprovalSecrets: () => SECRETS,
      feishuApprovalSettings,
      feishuApprovalClient: null,
    })();
    assert.equal(disabled.credentialReady, true);
    assert.equal(disabled.credentialReason, "");
    assert.equal(disabled.configurationReady, true);
    assert.equal(disabled.setupReason, "");
    assert.equal(disabled.configured, false);
    assert.equal(disabled.reason, "disabled");

    const legacy = { ...CONFIG };
    delete legacy.approverSource;
    delete legacy.approverBoundPlatform;
    delete legacy.approverBoundAppId;
    const legacyStatus = loadFn("getFeishuApprovalStatus", {
      getFeishuApprovalPrefs: () => legacy,
      getFeishuApprovalSecrets: () => SECRETS,
      feishuApprovalSettings,
      feishuApprovalClient: null,
    })();
    assert.equal(legacyStatus.credentialReady, true);
    assert.equal(legacyStatus.configurationReady, false);
    assert.equal(legacyStatus.setupReason, "approver-provenance-unknown");

    const appMismatchStatus = loadFn("getFeishuApprovalStatus", {
      getFeishuApprovalPrefs: () => ({ ...CONFIG, approverBoundAppId: "cli_other" }),
      getFeishuApprovalSecrets: () => SECRETS,
      feishuApprovalSettings,
      feishuApprovalClient: null,
    })();
    assert.equal(appMismatchStatus.configurationReady, false);
    assert.equal(appMismatchStatus.setupReason, "approver-app-mismatch");
  });

  it("legacy approver provenance constructs no runtime client and sends no Test card", async () => {
    const legacy = { ...CONFIG };
    delete legacy.approverSource;
    delete legacy.approverBoundPlatform;
    delete legacy.approverBoundAppId;
    const ready = feishuApprovalSettings.readiness(legacy, SECRETS);
    assert.equal(ready.ready, false);
    assert.equal(ready.reason, "approver-provenance-unknown");

    let constructed = 0;
    class ForbiddenClient { constructor() { constructed += 1; } }
    const context = {
      getFeishuApprovalPrefs: () => legacy,
      getFeishuApprovalPaths: () => PATHS,
      getFeishuApprovalSecrets: () => SECRETS,
      feishuApprovalSettings,
      feishuApprovalClient: null,
      FeishuApprovalClient: ForbiddenClient,
      feishuApprovalLog: () => {},
    };
    assert.equal(await loadFn("startFeishuApprovalClient", context)(), false);
    assert.equal(constructed, 0);
  });

  it("route provenance changes still invalidate old work while exact routes hand card work off", async () => {
    const routeChanges = [];
    let constructedOptions;
    class FakeClient {
      constructor(options) { constructedOptions = options; }
      async start() { return true; }
    }
    const cardWork = { retained: true };
    const context = {
      getFeishuApprovalPrefs: () => CONFIG,
      getFeishuApprovalPaths: () => PATHS,
      getFeishuApprovalSecrets: () => SECRETS,
      feishuApprovalSettings,
      buildFeishuApprovalSignature: () => "new-runtime",
      buildFeishuSessionAutomationRouteSignature: () => "same-route",
      feishuApprovalClient: { sessionAutomationCardWork: cardWork },
      feishuApprovalConfigSignature: "old-runtime",
      feishuSessionAutomationRouteSignature: "same-route",
      prepareFeishuSessionAutomationRouteChange: (value) => routeChanges.push(value),
      stopFeishuApprovalClient: () => {},
      FeishuApprovalClient: FakeClient,
      _settingsController: { get: () => "en" },
      lang: "en",
      sessionAutomationCoordinator: null,
      broadcastFeishuApprovalStatus: () => {},
      feishuApprovalLog: () => {},
    };
    assert.equal(await loadFn("startFeishuApprovalClient", context)(), true);
    assert.deepEqual(routeChanges, ["same-route"]);
    assert.equal(constructedOptions.sessionAutomationCardWork, cardWork);
  });

  it("does not put the language in the signature", () => {
    // Cards read the language dynamically through getLang. Putting lang in the
    // signature would drop and rebuild the long connection on every language
    // switch.
    const start = MAIN_SOURCE.indexOf("function buildFeishuApprovalSignature(");
    const block = MAIN_SOURCE.slice(start, MAIN_SOURCE.indexOf("\n}", start));
    assert.ok(!/\blang\b/.test(block), "lang must not be part of the Feishu approval signature");
  });

  it("constructs the approval client with the configured platform and a dynamic language source", () => {
    const start = MAIN_SOURCE.indexOf("feishuApprovalClient = new FeishuApprovalClient({");
    assert.notEqual(start, -1, "main.js should construct FeishuApprovalClient");
    const block = MAIN_SOURCE.slice(start, MAIN_SOURCE.indexOf("});", start));
    assert.match(block, /platform:\s*config\.platform/, "the resolved platform must be passed to the client");
    assert.match(block, /getLang:\s*\(\)\s*=>/, "a dynamic getLang must be injected for card i18n");
  });

  it("reports the resolved platform in the status snapshot", () => {
    const start = MAIN_SOURCE.indexOf("function getFeishuApprovalStatus(");
    assert.notEqual(start, -1);
    const block = MAIN_SOURCE.slice(start, MAIN_SOURCE.indexOf("\n}", start));
    assert.match(block, /platform:\s*config\.platform/, "status should expose the platform for the settings page");
  });

  it("localizes the settings test card instead of hardcoding English", () => {
    const start = MAIN_SOURCE.indexOf("async function sendFeishuApprovalTest(");
    assert.notEqual(start, -1);
    const block = MAIN_SOURCE.slice(start, MAIN_SOURCE.indexOf("\n}", start));
    assert.match(block, /title:\s*translate\("feishuCardTestTitle"\)/);
    assert.match(block, /detail:\s*translate\("feishuCardTestDetail"\)/);
    // The old card paired an English title with Chinese buttons.
    assert.ok(!block.includes("Clawd Feishu approval test"), "the test card title must not be hardcoded");
  });

  it("keeps user-visible runtime fallbacks brand-neutral", () => {
    const start = MAIN_SOURCE.indexOf("function feishuApprovalUnavailableMessage(");
    assert.notEqual(start, -1);
    const block = MAIN_SOURCE.slice(start, MAIN_SOURCE.indexOf("\n}", start));
    const strings = block.match(/"[^"]*"/g) || [];
    for (const literal of strings) {
      assert.ok(
        !/feishu|lark/i.test(literal),
        `unavailable-message fallback must not name a brand: ${literal}`
      );
    }
  });

  it("main approval restart failure logs only allowlisted SDK metadata", async () => {
    const error = createSentinelSdkError();
    const logs = [];
    const context = {
      getFeishuApprovalPrefs: () => CONFIG,
      getFeishuApprovalPaths: () => PATHS,
      getFeishuApprovalSecrets: () => SECRETS,
      feishuApprovalSettings: { readiness: () => ({ ready: true }) },
      buildFeishuApprovalSignature: () => "same-signature",
      buildFeishuSessionAutomationRouteSignature: () => "same-route",
      feishuApprovalClient: { start: async () => { throw error; } },
      feishuApprovalConfigSignature: "same-signature",
      feishuSessionAutomationRouteSignature: "same-route",
      classifyFeishuSdkError,
      feishuApprovalLog: (level, message, meta) => logs.push({ level, message, meta }),
    };
    const startFeishuApprovalClient = loadFn("startFeishuApprovalClient", context);

    assert.equal(await startFeishuApprovalClient(), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, "warn");
    assert.equal(logs[0].message, "start failed");
    assertAllowlistedSdkMetadata(logs[0].meta, "runtime-start");
    assertNoSentinels(logs, "restart log");
  });

  it("new approval client startup failure logs only allowlisted SDK metadata", async () => {
    const error = createSentinelSdkError();
    const cardWork = { pending: new Map() };
    const logs = [];
    const stopped = [];
    const routeChanges = [];
    let constructedOptions;
    class FakeFeishuApprovalClient {
      constructor(options) {
        constructedOptions = options;
      }

      async start() {
        throw error;
      }
    }
    const context = {
      getFeishuApprovalPrefs: () => CONFIG,
      getFeishuApprovalPaths: () => PATHS,
      getFeishuApprovalSecrets: () => SECRETS,
      feishuApprovalSettings: { readiness: () => ({ ready: true }) },
      buildFeishuApprovalSignature: () => "new-signature",
      buildFeishuSessionAutomationRouteSignature: () => "same-route",
      feishuApprovalClient: { sessionAutomationCardWork: cardWork },
      feishuApprovalConfigSignature: "old-signature",
      feishuSessionAutomationRouteSignature: "same-route",
      prepareFeishuSessionAutomationRouteChange: (signature) => routeChanges.push(signature),
      stopFeishuApprovalClient: (options) => stopped.push(options),
      FeishuApprovalClient: FakeFeishuApprovalClient,
      _settingsController: { get: () => "en" },
      lang: "en",
      sessionAutomationCoordinator: null,
      broadcastFeishuApprovalStatus: () => {},
      classifyFeishuSdkError,
      feishuApprovalLog: (level, message, meta) => logs.push({ level, message, meta }),
    };
    const startFeishuApprovalClient = loadFn("startFeishuApprovalClient", context);

    assert.equal(await startFeishuApprovalClient(), false);
    assert.deepEqual(routeChanges, ["same-route"]);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].routeChanging, false);
    assert.equal(stopped[0].preserveRouteSignature, true);
    assert.equal(constructedOptions.sessionAutomationCardWork, cardWork);
    assert.equal(context.feishuApprovalConfigSignature, "new-signature");
    assert.equal(context.feishuSessionAutomationRouteSignature, "same-route");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].message, "start failed");
    assertAllowlistedSdkMetadata(logs[0].meta, "runtime-start");
    assertNoSentinels(logs, "new-client startup log");
  });

  it("main approval shutdown failure logs only allowlisted SDK metadata", () => {
    const error = createSentinelSdkError();
    const logs = [];
    const routeChanges = [];
    const context = {
      feishuApprovalClient: { close: () => { throw error; } },
      feishuApprovalConfigSignature: "configured",
      feishuSessionAutomationRouteSignature: "route",
      prepareFeishuSessionAutomationRouteChange: (signature) => routeChanges.push(signature),
      classifyFeishuSdkError,
      feishuApprovalLog: (level, message, meta) => logs.push({ level, message, meta }),
    };
    const stopFeishuApprovalClient = loadFn("stopFeishuApprovalClient", context);

    stopFeishuApprovalClient();

    assert.equal(context.feishuApprovalClient, null);
    assert.equal(context.feishuApprovalConfigSignature, "");
    assert.equal(context.feishuSessionAutomationRouteSignature, "");
    assert.deepEqual(routeChanges, [""]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].message, "stop failed");
    assertAllowlistedSdkMetadata(logs[0].meta, "runtime-stop");
    assertNoSentinels(logs, "shutdown log");
  });

  it("main approval shutdown returns the client close drain", async () => {
    const closeDrain = createDeferred();
    const context = {
      feishuApprovalClient: { close: () => closeDrain.promise },
      feishuApprovalConfigSignature: "configured",
      feishuSessionAutomationRouteSignature: "route",
      feishuApprovalCloseDrains: new Set(),
      prepareFeishuSessionAutomationRouteChange: () => {},
      classifyFeishuSdkError,
      feishuApprovalLog: () => {},
    };
    const stopFeishuApprovalClient = loadFn("stopFeishuApprovalClient", context);

    const result = stopFeishuApprovalClient();
    assert.equal(result, closeDrain.promise);
    closeDrain.resolve();
    await result;
  });

  it("app quit drain waits for both Remote SSH and Feishu card shutdown", async () => {
    const remoteDrain = createDeferred();
    const feishuDrain = createDeferred();
    const closeDrains = new Set();
    const calls = [];
    const drainRemoteSshAndFeishuBeforeQuit = loadFn("drainRemoteSshAndFeishuBeforeQuit", {
      settingsIpcRuntime: {
        dispose: () => calls.push(["settings-ipc"]),
      },
      _remoteSshRuntime: {
        shutdown: ({ timeoutMs }) => {
          calls.push(["remote", timeoutMs]);
          return remoteDrain.promise;
        },
      },
      stopFeishuApprovalClient: () => {
        calls.push(["feishu"]);
        closeDrains.add(feishuDrain.promise);
      },
      settleDrainWithin: (drain, timeoutMs) => {
        calls.push(["feishu-timeout", timeoutMs]);
        return drain;
      },
      feishuApprovalCloseDrains: closeDrains,
      console: { error: () => {} },
      Promise,
    });

    const result = drainRemoteSshAndFeishuBeforeQuit();
    let settled = false;
    result.then(() => { settled = true; });
    assert.deepEqual(calls, [
      ["settings-ipc"],
      ["remote", 5000],
      ["feishu"],
      ["feishu-timeout", 5000],
    ]);

    remoteDrain.resolve();
    await Promise.resolve();
    assert.equal(settled, false, "quit must still wait for the Feishu terminal patch");

    feishuDrain.resolve();
    await result;
    assert.equal(settled, true);
  });

  it("app quit drain retains a client stopped before quit", async () => {
    const priorClientDrain = createDeferred();
    const closeDrains = new Set();
    const context = {
      feishuApprovalClient: { close: () => priorClientDrain.promise },
      feishuApprovalConfigSignature: "configured",
      feishuSessionAutomationRouteSignature: "route",
      feishuApprovalCloseDrains: closeDrains,
      prepareFeishuSessionAutomationRouteChange: () => {},
      classifyFeishuSdkError,
      feishuApprovalLog: () => {},
      Promise,
    };
    const stopFeishuApprovalClient = loadFn("stopFeishuApprovalClient", context);
    const priorStopResult = stopFeishuApprovalClient();
    assert.equal(priorStopResult, priorClientDrain.promise);

    const drainRemoteSshAndFeishuBeforeQuit = loadFn("drainRemoteSshAndFeishuBeforeQuit", {
      settingsIpcRuntime: { dispose: () => {} },
      _remoteSshRuntime: null,
      stopFeishuApprovalClient: () => undefined,
      settleDrainWithin: (drain) => drain,
      feishuApprovalCloseDrains: closeDrains,
      console: { error: () => {} },
      Promise,
    });
    const quitDrain = drainRemoteSshAndFeishuBeforeQuit();
    let settled = false;
    quitDrain.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, "quit must retain a drain from a previously stopped client");

    priorClientDrain.resolve();
    await quitDrain;
    assert.equal(settled, true);
  });

  it("bounds a hung Feishu quit drain without leaking its timeout after early settlement", async () => {
    let timeoutCallback = null;
    let timeoutDelay = null;
    const cleared = [];
    const settleDrainWithin = loadFn("settleDrainWithin", {
      Promise,
      setTimeout: (callback, delay) => {
        timeoutCallback = callback;
        timeoutDelay = delay;
        return 17;
      },
      clearTimeout: (handle) => cleared.push(handle),
    });

    let settled = false;
    const hung = settleDrainWithin(new Promise(() => {}), 5000);
    hung.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(timeoutDelay, 5000);

    timeoutCallback();
    await hung;
    assert.equal(settled, true);
    assert.deepEqual(cleared, [17]);

    const completed = createDeferred();
    const early = settleDrainWithin(completed.promise, 5000);
    completed.resolve();
    await early;
    assert.deepEqual(cleared, [17, 17]);
  });

  it("main retains the Settings IPC runtime and refuses Feishu sync after quit starts", async () => {
    assert.match(MAIN_SOURCE, /const settingsIpcRuntime = registerSettingsIpc\(\{/);
    const calls = [];
    const syncFeishuApproval = loadFn("syncFeishuApproval", {
      isQuitting: true,
      stopFeishuApprovalClient: () => calls.push("stop"),
      startFeishuApprovalClient: () => {
        calls.push("start");
        return true;
      },
    });

    assert.equal(await syncFeishuApproval("settings"), false);
    assert.deepEqual(calls, ["stop"]);
  });

  it("settings approval test never returns a raw SDK error message", async () => {
    const error = createSentinelSdkError();
    const logs = [];
    const client = {
      requestApproval: async () => { throw error; },
    };
    const sendFeishuApprovalTest = loadFn("sendFeishuApprovalTest", {
      getFeishuApprovalStatus: () => ({ configured: true }),
      queueFeishuApprovalSync: async () => true,
      getConfiguredFeishuApprovalClient: () => client,
      AbortController,
      setTimeout,
      clearTimeout,
      translate: (key) => key,
      classifyFeishuSdkError,
      feishuApprovalLog: (level, message, meta) => logs.push({ level, message, meta }),
    });

    const result = await sendFeishuApprovalTest();

    assert.equal(result.status, "error");
    assert.equal(result.code, "card-send-failed");
    assert.deepEqual(Object.keys(result).sort(), ["code", "status"]);
    assertNoSentinels(result, "Settings test result");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].message, "test card send failed");
    assertAllowlistedSdkMetadata(logs[0].meta, "send-card");
    assertNoSentinels(logs, "test-card application log");
  });

  it("lookup pending and direct Test use one coherent persisted snapshot", async () => {
    const persistedConfig = {
      enabled: true,
      platform: "lark",
      idType: "open_id",
      approverId: "ou_persisted",
      approverSource: "lookup",
      approverBoundPlatform: "lark",
      approverBoundAppId: "cli_persisted",
      connectionTimeoutSeconds: 15,
    };
    const persistedSecrets = {
      credentialPlatform: "lark",
      appId: "cli_persisted",
      appSecret: "persisted-secret-sentinel",
    };
    const lookupStarted = createDeferred();
    const releaseLookup = createDeferred();
    const persistedWrites = [];
    const testInputs = [];
    let controller;
    controller = createSettingsController({
      prefsPath: "in-memory-settings",
      prefs: {
        load: () => ({ snapshot: { feishuApproval: persistedConfig }, locked: false }),
        save: (_path, snapshot) => persistedWrites.push(snapshot),
      },
      commands: commandRegistry,
      injectedDeps: {
        getFeishuApprovalSecrets: () => ({ ...persistedSecrets }),
        getFeishuApprovalSecretsRevision: () => 23,
        sendFeishuApprovalTest: async (persisted) => {
          testInputs.push(persisted);
          return { status: "ok" };
        },
      },
    });
    const signal = new AbortController().signal;
    const lookup = saveFeishuApproverByEmail({
      email: "persisted@example.com",
      signal,
    }, {
      getFeishuApprovalPrefs: () => controller.get("feishuApproval"),
      getFeishuApprovalSecrets: () => ({ ...persistedSecrets }),
      getFeishuApprovalSecretsRevision: () => 23,
      lookupFeishuApproverByEmail: async () => {
        lookupStarted.resolve();
        await releaseLookup.promise;
        return { status: "ok", approverId: "ou_pending_lookup" };
      },
      commitResolvedApprover: (payload) => controller.applyCommand(
        "feishuApproval.commitResolvedApprover",
        payload,
      ),
    });

    await lookupStarted.promise;
    const testResult = await controller.applyCommand("feishuApproval.test");
    assert.equal(testResult.status, "ok");
    assert.equal(persistedWrites.length, 0);
    assert.deepStrictEqual(testInputs, [{
      config: persistedConfig,
      secrets: persistedSecrets,
      secretsRevision: 23,
    }]);
    assert.equal(controller.get("feishuApproval").approverId, "ou_persisted");

    releaseLookup.resolve();
    assert.deepStrictEqual(await lookup, { status: "ok" });
    assert.equal(controller.get("feishuApproval").approverId, "ou_pending_lookup");
    assert.equal(persistedWrites.length, 1);
    assert.doesNotMatch(JSON.stringify(await lookup), /persisted-secret-sentinel|ou_pending_lookup/);
  });

  it("60-second Settings test timer aborts with no-decision outcome", async () => {
    let capturedOptions = null;
    const harness = createFeishuApprovalTestHarness({
      requestApproval: async (_card, options) => {
        capturedOptions = options;
        return new Promise((resolve) => {
          const settleAbort = () => resolve(null);
          if (options.signal.aborted) {
            settleAbort();
            return;
          }
          options.signal.addEventListener("abort", settleAbort, { once: true });
        });
      },
      captureLogs: true,
    });

    const pending = harness.sendFeishuApprovalTest();
    for (let i = 0; i < 10 && !harness.timer.callback; i += 1) {
      await Promise.resolve();
    }
    assert.equal(harness.timer.delay, 60 * 1000);
    assert.equal(typeof harness.timer.callback, "function");
    assert.ok(capturedOptions);
    assert.equal(capturedOptions.signal.aborted, false);
    assert.equal(capturedOptions.abortOutcome && capturedOptions.abortOutcome.decision, "no-decision");
    assert.deepStrictEqual(
      Object.assign({}, capturedOptions.abortOutcome),
      { decision: "no-decision" },
    );

    harness.timer.callback();
    assert.equal(capturedOptions.signal.aborted, true);
    const result = await pending;
    assert.equal(result.status, "error");
    assert.equal(result.code, "no-button-response");
    assert.equal(result.message, "Test card did not receive a button response");
    assert.ok(harness.clearedTimers.includes(1));
    assertNoSentinels(result, "60-second timeout result");
    assertNoSentinels(harness.logs, "60-second timeout logs");
  });

  for (const decision of ["allow", "deny"]) {
    it(`early ${decision} clears the 60-second Settings test timer`, async () => {
      const harness = createFeishuApprovalTestHarness({
        requestApproval: async () => decision,
      });

      const result = await harness.sendFeishuApprovalTest();
      assert.equal(harness.timer.delay, 60 * 1000);
      assert.equal(result.status, "ok");
      assert.equal(result.decision, decision);
      assert.deepEqual(harness.clearedTimers, [1]);
    });
  }

  it("send failure clears the 60-second Settings test timer without raw SDK text", async () => {
    const error = createSentinelSdkError();
    const harness = createFeishuApprovalTestHarness({
      requestApproval: async () => {
        throw error;
      },
      captureLogs: true,
    });

    const result = await harness.sendFeishuApprovalTest();
    assert.equal(harness.timer.delay, 60 * 1000);
    assert.equal(result.status, "error");
    assert.equal(result.code, "card-send-failed");
    assert.deepEqual(Object.keys(result).sort(), ["code", "status"]);
    assert.deepEqual(harness.clearedTimers, [1]);
    assertNoSentinels(result, "send-failure result");
    assert.equal(harness.logs.length, 1);
    assert.equal(harness.logs[0].message, "test card send failed");
    assertAllowlistedSdkMetadata(harness.logs[0].meta, "send-card");
    assertNoSentinels(harness.logs, "send-failure logs");
  });

  it("Feishu main-process runtime block contains no raw error forwarding", () => {
    const block = [
      extractFnSource("startFeishuApprovalClient"),
      extractFnSource("stopFeishuApprovalClient"),
      extractFnSource("sendFeishuApprovalTest"),
    ].join("\n");
    assert.doesNotMatch(block, /\berr\.message\b/);
    assert.doesNotMatch(block, /\bString\s*\(\s*err\s*\)/);
  });

  it("classifies main runtime stages with allowlisted diagnostics only", () => {
    const error = createSentinelSdkError();
    assertAllowlistedSdkMetadata(classifyFeishuSdkError(error, "runtime-start"), "runtime-start");
    assertAllowlistedSdkMetadata(classifyFeishuSdkError(error, "runtime-stop"), "runtime-stop");

    const unknown = classifyFeishuSdkError(error, `unknown-${SENTINELS[1]}`);
    assertAllowlistedSdkMetadata(unknown, "sdk");
    assertNoSentinels(unknown, "unknown-stage classification");
  });
});
