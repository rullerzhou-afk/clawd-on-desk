"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const vm = require("node:vm");
const { classifyFeishuSdkError } = require("../src/feishu-approval-client");

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
  const block = extractFnSource(name);
  const context = extraContext;
  context.globalThis = context;
  vm.runInNewContext(`${block}\nresult = ${name};`, context);
  return context.result;
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
const SECRETS = { appId: "cli_1", appSecret: "s", verificationToken: "", encryptKey: "" };
const CONFIG = {
  enabled: true,
  platform: "feishu",
  idType: "open_id",
  approverId: "ou_1",
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
