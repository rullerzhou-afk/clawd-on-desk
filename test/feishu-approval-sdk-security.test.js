"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const util = require("node:util");
const axios = require("axios");
const lark = require("@larksuiteoapi/node-sdk");

const {
  FeishuApprovalClient,
  SILENT_LARK_LOGGER,
  classifyFeishuSdkError,
  createIsolatedLarkCache,
  createLarkClient,
  lookupOpenIdByEmail,
  normalizeApprovalPayload,
} = require("../src/feishu-approval-client");

const SENTINEL = Object.freeze({
  appId: "cli_sensitive_app_id",
  appSecret: "sensitive_app_secret_123",
  email: "secret-review@example.com",
  authorization: "Bearer synthetic_authorization_token_456",
  requestBody: "synthetic_request_body_789",
  tenantToken: "synthetic_tenant_token_abc",
  url: "https://synthetic.invalid/private/path",
  query: "private_query=synthetic_query_value",
});

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"];

async function captureLoggerChannels(run) {
  const consoleCalls = [];
  const applicationCalls = [];
  const originals = Object.fromEntries(CONSOLE_METHODS.map((name) => [name, console[name]]));
  for (const name of CONSOLE_METHODS) {
    console[name] = (...args) => consoleCalls.push({ name, args });
  }
  try {
    const result = await run((...args) => applicationCalls.push(args));
    return { result, consoleCalls, applicationCalls };
  } finally {
    for (const name of CONSOLE_METHODS) console[name] = originals[name];
  }
}

function transcriptOf(value) {
  return util.inspect(value, { depth: null, breakLength: Infinity });
}

function assertNoSentinels(value, sentinels = Object.values(SENTINEL)) {
  const transcript = transcriptOf(value);
  for (const sentinel of sentinels) {
    assert.equal(
      transcript.includes(sentinel),
      false,
      `captured output must not include synthetic sentinel ${sentinel}`
    );
  }
}

function assertSafeApplicationLogs(applicationCalls) {
  for (const call of applicationCalls) {
    assert.equal(call.length, 3);
    assert.equal(typeof call[0], "string");
    assert.equal(typeof call[1], "string");
    const meta = call[2];
    assert.ok(meta && typeof meta === "object" && !Array.isArray(meta));
    for (const key of Object.keys(meta)) {
      assert.ok(
        ["code", "stage", "httpStatus", "businessCode", "networkCode"].includes(key),
        `unexpected application diagnostic field ${key}`
      );
    }
  }
}

function axiosFailure(message, config, responseData, status = 503, code = "ECONNRESET") {
  const response = {
    status,
    statusText: "Synthetic failure",
    data: responseData,
    config,
  };
  return new axios.AxiosError(
    message,
    code,
    config,
    {
      protocol: "https:",
      host: "synthetic.invalid",
      path: "/private/path",
      method: config.method,
    },
    response
  );
}

function generatedApiCall(client, email = "cache-test@example.invalid") {
  return client.contact.v3.user.batchGetId({
    data: { emails: [email] },
    params: { user_id_type: "open_id" },
  });
}

function tokenTransport(token) {
  const state = { tokenPosts: 0, apiRequests: [] };
  return {
    state,
    http: {
      post: async () => {
        state.tokenPosts += 1;
        return { tenant_access_token: token, expire: 7200 };
      },
      request: async (config) => {
        state.apiRequests.push(config);
        return { code: 0, data: { user_list: [] } };
      },
    },
  };
}

test("real SDK REST token failure never emits sentinel credentials on any logger channel", async () => {
  const transport = {
    post: async (url, data) => {
      const config = {
        method: "post",
        url: `${url}?${SENTINEL.query}`,
        data: { ...data, private_body: SENTINEL.requestBody, email: SENTINEL.email },
        headers: { Authorization: SENTINEL.authorization },
        params: { private_query: SENTINEL.query },
      };
      throw axiosFailure(
        `synthetic token failure ${SENTINEL.appSecret} ${SENTINEL.tenantToken}`,
        config,
        { code: 500001, msg: SENTINEL.requestBody }
      );
    },
    request: async () => {
      throw new Error("generated API request must not run after token acquisition fails");
    },
  };

  const captured = await captureLoggerChannels((applicationLog) => lookupOpenIdByEmail({
    platform: "feishu",
    appId: SENTINEL.appId,
    appSecret: SENTINEL.appSecret,
    email: SENTINEL.email,
    lark,
    httpInstance: transport,
    log: applicationLog,
  }));

  assert.deepEqual(captured.result, { status: "error", code: "lookup-failed" });
  assertSafeApplicationLogs(captured.applicationCalls);
  assertNoSentinels(captured);
});

test("real SDK batch_get_id failure never emits sentinel request or token data", async () => {
  const transport = {
    post: async () => ({ tenant_access_token: SENTINEL.tenantToken, expire: 7200 }),
    request: async (requestConfig) => {
      const config = {
        ...requestConfig,
        url: `${SENTINEL.url}?${SENTINEL.query}`,
        data: {
          original: requestConfig.data,
          email: SENTINEL.email,
          body: SENTINEL.requestBody,
          secret: SENTINEL.appSecret,
        },
        headers: {
          ...requestConfig.headers,
          Authorization: SENTINEL.authorization,
          "X-Synthetic-Token": SENTINEL.tenantToken,
        },
        params: { ...requestConfig.params, private_query: SENTINEL.query },
      };
      throw axiosFailure(
        `synthetic batch failure ${SENTINEL.email} ${SENTINEL.tenantToken}`,
        config,
        { code: 500002, msg: SENTINEL.requestBody },
        500,
        "ETIMEDOUT"
      );
    },
  };

  const captured = await captureLoggerChannels((applicationLog) => lookupOpenIdByEmail({
    platform: "feishu",
    appId: SENTINEL.appId,
    appSecret: SENTINEL.appSecret,
    email: SENTINEL.email,
    lark,
    httpInstance: transport,
    log: applicationLog,
  }));

  assert.deepEqual(captured.result, { status: "error", code: "lookup-failed" });
  assertSafeApplicationLogs(captured.applicationCalls);
  assertNoSentinels(captured);
});

test("real SDK WSClient endpoint failure never emits App credentials", async () => {
  const requests = [];
  const httpInstance = {
    request: async (config) => {
      requests.push(config);
      const errorConfig = {
        ...config,
        url: `${SENTINEL.url}?${SENTINEL.query}`,
        headers: { ...config.headers, Authorization: SENTINEL.authorization },
        data: { ...config.data, body: SENTINEL.requestBody, token: SENTINEL.tenantToken },
      };
      throw axiosFailure(
        `endpoint failure ${SENTINEL.appId} ${SENTINEL.appSecret}`,
        errorConfig,
        { code: 500003, msg: SENTINEL.email }
      );
    },
  };

  const captured = await captureLoggerChannels(async () => {
    const wsClient = new lark.WSClient({
      appId: SENTINEL.appId,
      appSecret: SENTINEL.appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
      logger: SILENT_LARK_LOGGER,
      httpInstance,
      autoReconnect: false,
    });
    try {
      return await wsClient.pullConnectConfig();
    } finally {
      wsClient.close({ force: true });
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].data.AppID, SENTINEL.appId);
  assert.equal(requests[0].data.AppSecret, SENTINEL.appSecret);
  assert.deepEqual(captured.result, { ok: false, retryable: true });
  assertNoSentinels(captured);
});

test("real SDK EventDispatcher warning is fully suppressed", async () => {
  const captured = await captureLoggerChannels(async () => {
    const dispatcher = new lark.EventDispatcher({
      verificationToken: "synthetic_verification_token",
      encryptKey: "synthetic_encrypt_key",
      loggerLevel: lark.LoggerLevel.warn,
      logger: SILENT_LARK_LOGGER,
    });
    return dispatcher.invoke({ headers: {} }, { needCheck: true });
  });

  assert.equal(captured.consoleCalls.length, 0);
  assert.equal(captured.applicationCalls.length, 0);
});

test("silent SDK logger implements error warn info debug and trace", async () => {
  assert.ok(SILENT_LARK_LOGGER);
  assert.equal(Object.isFrozen(SILENT_LARK_LOGGER), true);
  const captured = await captureLoggerChannels(async () => {
    for (const method of ["error", "warn", "info", "debug", "trace"]) {
      assert.equal(typeof SILENT_LARK_LOGGER[method], "function");
      await SILENT_LARK_LOGGER[method]({ nested: [SENTINEL, { again: SENTINEL }] });
    }
  });
  assert.equal(captured.consoleCalls.length, 0);
  assert.equal(captured.applicationCalls.length, 0);
});

test("SDK error classification returns only allowlisted fields", () => {
  assert.equal(typeof classifyFeishuSdkError, "function");
  const error = axiosFailure(
    `cyclic failure ${SENTINEL.appSecret} ${SENTINEL.email}`,
    {
      method: "post",
      url: `${SENTINEL.url}?${SENTINEL.query}`,
      headers: { Authorization: SENTINEL.authorization },
      data: SENTINEL.requestBody,
    },
    { code: 99991672, msg: SENTINEL.tenantToken },
    403,
    "ECONNRESET"
  );
  error.self = error;

  const classified = classifyFeishuSdkError(error, "lookup");

  assert.deepEqual(classified, {
    code: "missing-contact-scope",
    stage: "lookup",
    httpStatus: 403,
    businessCode: 99991672,
    networkCode: "ECONNRESET",
  });
  assertNoSentinels(classified);
});

test("SDK error classification rereads numeric metadata and ignores forged public codes", () => {
  const error = new Error("Feishu/Lark SDK request failed.");
  error.code = SENTINEL.email;
  error.stage = SENTINEL.appSecret;
  error.httpStatus = 403;
  error.businessCode = 230001;
  error.networkCode = SENTINEL.tenantToken;
  error.sanitizedFeishuSdkError = true;

  const classified = classifyFeishuSdkError(error, "send-card");
  assert.deepEqual(classified, {
    code: "sdk-request-failed",
    stage: "send-card",
    httpStatus: 403,
    businessCode: 230001,
  });
  assertNoSentinels(classified);
});

test("real SDK message.create nonzero business code is sanitized through sendCard", async () => {
  assert.equal(require("@larksuiteoapi/node-sdk/package.json").version, "1.71.1");
  const payload = normalizeApprovalPayload({ title: "Run", detail: "Summary: Run tests" });
  const transport = {
    post: async () => ({ tenant_access_token: SENTINEL.tenantToken, expire: 7200 }),
    request: async (requestConfig) => ({
      code: 230001,
      msg: `param invalid ${SENTINEL.email} ${SENTINEL.tenantToken}`,
      data: {
        message_id: `om_${SENTINEL.appSecret}`,
        original: requestConfig.data,
        email: SENTINEL.email,
        body: SENTINEL.requestBody,
      },
    }),
  };
  const logs = [];
  const client = new FeishuApprovalClient({
    appId: SENTINEL.appId,
    appSecret: SENTINEL.appSecret,
    approverId: "ou_1",
    idType: "open_id",
    lark,
    cardHttpInstance: transport,
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  await assert.rejects(client.sendCard("fs_sdk_boundary", payload), (error) => {
    assert.equal(error.message, "Feishu/Lark SDK request failed.");
    assert.equal(error.code, "sdk-request-failed");
    assert.equal(error.stage, "send-card");
    assert.equal(error.businessCode, 230001);
    assertNoSentinels(error);
    assert.deepEqual(classifyFeishuSdkError(error, "send-card"), {
      code: "sdk-request-failed",
      stage: "send-card",
      businessCode: 230001,
    });
    return true;
  });
  assert.equal(logs.some((entry) => entry.message === "card sent"), false);
  assertNoSentinels(logs);
});

test("same App ID on Feishu and Lark obtains separate tenant tokens", async () => {
  const appId = "cli_cache_same_id_cross_platform";
  const appSecret = "synthetic_cache_cross_platform_secret";
  const feishuToken = "synthetic_feishu_platform_token";
  const larkToken = "synthetic_lark_platform_token";
  const feishu = tokenTransport(feishuToken);
  const larkGlobal = tokenTransport(larkToken);

  const feishuClient = createLarkClient({
    lark,
    platform: "feishu",
    appId,
    appSecret,
    httpInstance: feishu.http,
  });
  const larkClient = createLarkClient({
    lark,
    platform: "lark",
    appId,
    appSecret,
    httpInstance: larkGlobal.http,
  });

  await generatedApiCall(feishuClient, "feishu-cache@example.invalid");
  await generatedApiCall(larkClient, "lark-cache@example.invalid");

  assert.equal(feishu.state.tokenPosts, 1);
  assert.equal(larkGlobal.state.tokenPosts, 1);
  assert.equal(feishu.state.apiRequests[0].headers.Authorization, `Bearer ${feishuToken}`);
  assert.equal(larkGlobal.state.apiRequests[0].headers.Authorization, `Bearer ${larkToken}`);
  assert.notStrictEqual(feishuClient.cache, larkClient.cache);
});

test("cache namespace includes platform and App ID and excludes App Secret", async () => {
  assert.equal(typeof createIsolatedLarkCache, "function");
  const calls = [];
  class ObservedDefaultCache {
    constructor() {
      calls.push({ method: "construct", owner: this });
    }
    async get(key, options) {
      calls.push({ method: "get", owner: this, key, options });
      return "synthetic_cached_value";
    }
    async set(key, value, expire, options) {
      calls.push({ method: "set", owner: this, key, value, expire, options });
      return true;
    }
  }
  const key = Symbol("sdk-tenant-token-key");
  const expire = 987654321;
  const options = Object.freeze({ namespace: "sdk-app-namespace", customOption: "forward-me" });
  const cache = createIsolatedLarkCache({
    lark: { DefaultCache: ObservedDefaultCache },
    platform: "feishu",
    appId: SENTINEL.appId,
  });

  assert.equal(await cache.set(key, SENTINEL.tenantToken, expire, options), true);
  assert.equal(await cache.get(key, options), "synthetic_cached_value");

  const setCall = calls.find((entry) => entry.method === "set");
  const getCall = calls.find((entry) => entry.method === "get");
  assert.strictEqual(setCall.key, key);
  assert.strictEqual(getCall.key, key);
  assert.equal(setCall.value, SENTINEL.tenantToken);
  assert.equal(setCall.expire, expire);
  assert.equal(setCall.options.customOption, options.customOption);
  assert.equal(getCall.options.customOption, options.customOption);
  for (const call of [setCall, getCall]) {
    assert.match(
      call.options.namespace,
      /^clawd:feishu-approval:feishu:cli_sensitive_app_id/
    );
    assert.match(call.options.namespace, /sdk-app-namespace/);
  }

  const namespaceAndKey = calls
    .filter((entry) => entry.options)
    .map((entry) => `${entry.options.namespace}/${String(entry.key)}`)
    .join("\n");
  const secretDerivatives = [
    SENTINEL.appSecret,
    Buffer.from(SENTINEL.appSecret).toString("base64"),
    crypto.createHash("sha256").update(SENTINEL.appSecret).digest("hex"),
    SENTINEL.email,
    SENTINEL.tenantToken,
    "synthetic_approver_open_id",
  ];
  assertNoSentinels(namespaceAndKey, secretDerivatives);
});

test("separate SDK constructions cannot contaminate subsequent tests through internalCache", async () => {
  const appId = "cli_cache_separate_client_lifecycles";
  const first = tokenTransport("synthetic_first_lifecycle_token");
  const second = tokenTransport("synthetic_second_lifecycle_token");
  const firstClient = createLarkClient({
    lark,
    platform: "feishu",
    appId,
    appSecret: "synthetic_first_lifecycle_secret",
    httpInstance: first.http,
  });
  const secondClient = createLarkClient({
    lark,
    platform: "feishu",
    appId,
    appSecret: "synthetic_second_lifecycle_secret",
    httpInstance: second.http,
  });

  await generatedApiCall(firstClient, "first-lifecycle@example.invalid");
  await generatedApiCall(secondClient, "second-lifecycle@example.invalid");

  assert.equal(first.state.tokenPosts, 1);
  assert.equal(second.state.tokenPosts, 1);
  assert.notStrictEqual(firstClient.cache, secondClient.cache);
  assert.equal(
    second.state.apiRequests[0].headers.Authorization,
    "Bearer synthetic_second_lifecycle_token"
  );
});

test("same client reuses its tenant token within one platform and App lifecycle", async () => {
  const appId = "cli_cache_positive_reuse_lifecycle";
  const first = tokenTransport("synthetic_same_client_token");
  const second = tokenTransport("synthetic_second_client_token");
  const firstClient = createLarkClient({
    lark,
    platform: "feishu",
    appId,
    appSecret: "synthetic_positive_reuse_secret",
    httpInstance: first.http,
  });

  await generatedApiCall(firstClient, "reuse-one@example.invalid");
  await generatedApiCall(firstClient, "reuse-two@example.invalid");
  assert.equal(first.state.tokenPosts, 1);
  assert.deepEqual(
    first.state.apiRequests.map((request) => request.headers.Authorization),
    ["Bearer synthetic_same_client_token", "Bearer synthetic_same_client_token"]
  );

  const secondClient = createLarkClient({
    lark,
    platform: "feishu",
    appId,
    appSecret: "synthetic_positive_reuse_secret",
    httpInstance: second.http,
  });
  await generatedApiCall(secondClient, "reuse-separate@example.invalid");
  assert.equal(second.state.tokenPosts, 1);
  assert.notStrictEqual(firstClient.cache, secondClient.cache);
  assert.equal(
    second.state.apiRequests[0].headers.Authorization,
    "Bearer synthetic_second_client_token"
  );
});

test("different App IDs obtain separate tenant tokens", async () => {
  const first = tokenTransport("synthetic_app_a_token");
  const second = tokenTransport("synthetic_app_b_token");
  const firstClient = createLarkClient({
    lark,
    platform: "feishu",
    appId: "cli_cache_app_identity_a",
    appSecret: "synthetic_app_a_secret",
    httpInstance: first.http,
  });
  const secondClient = createLarkClient({
    lark,
    platform: "feishu",
    appId: "cli_cache_app_identity_b",
    appSecret: "synthetic_app_b_secret",
    httpInstance: second.http,
  });

  await generatedApiCall(firstClient, "app-a@example.invalid");
  await generatedApiCall(secondClient, "app-b@example.invalid");

  assert.equal(first.state.tokenPosts, 1);
  assert.equal(second.state.tokenPosts, 1);
  assert.equal(first.state.apiRequests[0].headers.Authorization, "Bearer synthetic_app_a_token");
  assert.equal(second.state.apiRequests[0].headers.Authorization, "Bearer synthetic_app_b_token");
  assert.notStrictEqual(firstClient.cache, secondClient.cache);
});
