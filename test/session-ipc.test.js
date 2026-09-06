"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { registerSessionIpc } = require("../src/session-ipc");
const { SUPPORTED_LANGS } = require("../src/i18n");

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
    this.listeners = new Map();
  }

  handle(channel, listener) {
    this.handlers.set(channel, listener);
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }

  invoke(channel, ...args) {
    const listener = this.handlers.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }

  invokeFrom(event, channel, ...args) {
    const listener = this.handlers.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener(event, ...args);
  }

  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }
}

function createHarness(overrides = {}) {
  const calls = [];
  const ipcMain = new FakeIpcMain();
  const dashboardMainFrame = {
    url: pathToFileURL(path.join(__dirname, "..", "src", "dashboard.html")).toString(),
  };
  const dashboardWebContents = { mainFrame: dashboardMainFrame };
  const dashboardWindow = {
    webContents: dashboardWebContents,
    isDestroyed: () => false,
  };
  const runtime = registerSessionIpc({
    ipcMain,
    getSessionSnapshot: overrides.getSessionSnapshot || (() => ({ sessions: [{ id: "s1" }] })),
    getI18n: overrides.getI18n || (() => ({ lang: "en", translations: { title: "Sessions" } })),
    focusSession: overrides.focusSession || ((sessionId, options) => {
      calls.push(["focusSession", sessionId, options]);
    }),
    hideSession: overrides.hideSession || ((sessionId) => {
      calls.push(["hideSession", sessionId]);
      return { status: "ok", hidden: sessionId };
    }),
    setSessionAlias: overrides.setSessionAlias || (async (payload) => {
      calls.push(["setSessionAlias", payload]);
      return { status: "ok", alias: payload.alias };
    }),
    showDashboard: overrides.showDashboard || ((options) => {
      calls.push(["showDashboard", options]);
    }),
    setSessionHudPinned: overrides.setSessionHudPinned || ((value) => {
      calls.push(["setSessionHudPinned", value]);
    }),
    ackSessionCompletion: overrides.ackSessionCompletion || ((sessionId) => {
      calls.push(["ackSessionCompletion", sessionId]);
      return true;
    }),
    openSessionFolder: overrides.openSessionFolder || (async (sessionId) => {
      calls.push(["openSessionFolder", sessionId]);
      return { status: "ok" };
    }),
    setSessionAutomationOverride: overrides.setSessionAutomationOverride || (async (payload, context) => {
      calls.push(["setSessionAutomationOverride", payload, context]);
      return { status: "applied" };
    }),
    clearSessionAutomationGrant: overrides.clearSessionAutomationGrant || ((payload) => {
      calls.push(["clearSessionAutomationGrant", payload]);
      return { status: "applied" };
    }),
    getDashboardWindow: overrides.getDashboardWindow || (() => dashboardWindow),
    getKimiQuotaStatus: overrides.getKimiQuotaStatus || (() => ({
      status: "ok",
      configured: true,
      decryptable: true,
      collectionEnabled: true,
      agentEnabled: true,
    })),
    refreshKimiQuota: overrides.refreshKimiQuota || (() => {
      calls.push(["refreshKimiQuota"]);
      return { status: "ok" };
    }),
  });
  return {
    ipcMain,
    runtime,
    calls,
    trustedDashboardEvent: {
      sender: dashboardWebContents,
      senderFrame: dashboardMainFrame,
    },
  };
}

test("session IPC registers owned channels and disposes them", () => {
  const { ipcMain, runtime } = createHarness();

  assert.deepStrictEqual([...ipcMain.handlers.keys()].sort(), [
    "dashboard:clear-session-automation-grant",
    "dashboard:get-i18n",
    "dashboard:get-kimi-quota-status",
    "dashboard:get-snapshot",
    "dashboard:hide-session",
    "dashboard:open-session-folder",
    "dashboard:refresh-kimi-quota",
    "dashboard:set-session-alias",
    "dashboard:set-session-automation",
    "session-hud:get-i18n",
    "session-hud:open-session-folder",
    "session:ack-completion",
  ]);
  assert.deepStrictEqual([...ipcMain.listeners.keys()].sort(), [
    "dashboard:focus-session",
    "session-hud:focus-session",
    "session-hud:open-dashboard",
    "session-hud:set-pinned",
    "settings:open-dashboard",
    "show-dashboard",
  ]);

  runtime.dispose();

  assert.strictEqual(ipcMain.handlers.size, 0);
  assert.strictEqual(ipcMain.listeners.size, 0);
});

test("session IPC delegates dashboard and HUD behavior", async () => {
  const { ipcMain, calls } = createHarness();

  assert.deepStrictEqual(await ipcMain.invoke("dashboard:get-snapshot"), {
    sessions: [{ id: "s1" }],
  });
  assert.deepStrictEqual(await ipcMain.invoke("dashboard:get-i18n"), {
    lang: "en",
    translations: { title: "Sessions" },
  });
  assert.deepStrictEqual(await ipcMain.invoke("session-hud:get-i18n"), {
    lang: "en",
    translations: { title: "Sessions" },
  });
  ipcMain.send("dashboard:focus-session", "dash-session");
  ipcMain.send("session-hud:focus-session", "hud-session");
  ipcMain.send("session-hud:set-pinned", true);
  ipcMain.send("session-hud:set-pinned", 0);
  assert.deepStrictEqual(await ipcMain.invoke("dashboard:hide-session", "hidden-session"), {
    status: "ok",
    hidden: "hidden-session",
  });
  assert.deepStrictEqual(
    await ipcMain.invoke("dashboard:set-session-alias", { sessionId: "s1", alias: "Frontend" }),
    { status: "ok", alias: "Frontend" }
  );
  assert.deepStrictEqual(
    await ipcMain.invoke("dashboard:open-session-folder", "folder-session"),
    { status: "ok" }
  );
  assert.deepStrictEqual(
    await ipcMain.invoke("session-hud:open-session-folder", "hud-folder-session"),
    { status: "ok" }
  );

  assert.deepStrictEqual(calls, [
    ["focusSession", "dash-session", { requestSource: "dashboard" }],
    ["focusSession", "hud-session", { requestSource: "hud" }],
    ["setSessionHudPinned", true],
    ["setSessionHudPinned", false],
    ["hideSession", "hidden-session"],
    ["setSessionAlias", { sessionId: "s1", alias: "Frontend" }],
    ["openSessionFolder", "folder-session"],
    ["openSessionFolder", "hud-folder-session"],
  ]);
});

test("dashboard and HUD open-folder IPC accept only a sessionId string", async () => {
  const { ipcMain, calls } = createHarness();
  for (const channel of ["dashboard:open-session-folder", "session-hud:open-session-folder"]) {
    for (const bad of [null, undefined, "", 42, { sessionId: "s1", cwd: "/tmp" }]) {
      const result = await ipcMain.invoke(channel, bad);
      assert.strictEqual(result.status, "error");
    }
  }
  assert.deepStrictEqual(calls, []);
});

test("Kimi quota Dashboard IPC accepts only the real Dashboard main frame", async () => {
  const { ipcMain, calls, trustedDashboardEvent } = createHarness();

  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedDashboardEvent, "dashboard:get-kimi-quota-status"),
    {
      status: "ok",
      configured: true,
      decryptable: true,
      collectionEnabled: true,
      agentEnabled: true,
    }
  );
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedDashboardEvent, "dashboard:refresh-kimi-quota"),
    { status: "ok" }
  );
  assert.deepStrictEqual(calls, [["refreshKimiQuota"]]);

  for (const event of [
    { sender: trustedDashboardEvent.sender },
    { sender: {}, senderFrame: trustedDashboardEvent.senderFrame },
    { sender: trustedDashboardEvent.sender, senderFrame: { ...trustedDashboardEvent.senderFrame } },
  ]) {
    assert.deepStrictEqual(
      await ipcMain.invokeFrom(event, "dashboard:refresh-kimi-quota"),
      { status: "error", reason: "untrusted-dashboard-sender" }
    );
  }
  assert.deepStrictEqual(calls, [["refreshKimiQuota"]]);
});

test("session IPC owns dashboard open bridges", () => {
  const { ipcMain, calls } = createHarness();

  ipcMain.send("session-hud:open-dashboard");
  ipcMain.send("settings:open-dashboard");
  ipcMain.send("show-dashboard");

  assert.deepStrictEqual(calls, [
    ["showDashboard", { source: "hud" }],
    ["showDashboard", { source: "settings" }],
    ["showDashboard", undefined],
  ]);
});

test("session automation IPC accepts only the two narrow renderer payloads", async () => {
  const { ipcMain, calls } = createHarness();
  assert.deepStrictEqual(
    await ipcMain.invoke("dashboard:set-session-automation", {
      sessionId: "s1",
      mode: "auto-tools",
    }),
    { status: "applied" }
  );
  assert.deepStrictEqual(
    await ipcMain.invoke("dashboard:clear-session-automation-grant", { grantId: "g1" }),
    { status: "applied" }
  );
  for (const payload of [
    { sessionId: "s1", mode: "auto-tools", agentId: "claude-code" },
    { sessionId: "s1", mode: "unattended" },
    { mode: "off" },
  ]) {
    assert.deepStrictEqual(
      await ipcMain.invoke("dashboard:set-session-automation", payload),
      { status: "invalid" }
    );
  }
  assert.deepStrictEqual(
    await ipcMain.invoke("dashboard:clear-session-automation-grant", {
      grantId: "g1",
      target: "remote-revoke",
    }),
    { status: "invalid" }
  );
  assert.deepStrictEqual(calls, [
    [
      "setSessionAutomationOverride",
      { sessionId: "s1", mode: "auto-tools" },
      { sender: "sender-web-contents" },
    ],
    ["clearSessionAutomationGrant", { grantId: "g1" }],
  ]);
});

test("session:ack-completion returns {status:ok} when ack lands", async () => {
  const { ipcMain, calls } = createHarness({
    ackSessionCompletion: (sessionId) => {
      calls.push(["ackSessionCompletion", sessionId]);
      return true;
    },
  });
  const result = await ipcMain.invoke("session:ack-completion", "s1");
  assert.deepStrictEqual(result, { status: "ok" });
  assert.deepStrictEqual(calls, [["ackSessionCompletion", "s1"]]);
});

test("session:ack-completion returns noop when session missing or unflagged", async () => {
  const { ipcMain } = createHarness({
    ackSessionCompletion: () => false,
  });
  const result = await ipcMain.invoke("session:ack-completion", "s-missing");
  assert.deepStrictEqual(result, { status: "noop", reason: "not-pending-or-missing" });
});

test("session:ack-completion returns error when ackSessionCompletion throws", async () => {
  const { ipcMain } = createHarness({
    ackSessionCompletion: () => { throw new Error("boom"); },
  });
  const result = await ipcMain.invoke("session:ack-completion", "s1");
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.message, "boom");
});

test("session:ack-completion validates sessionId payload", async () => {
  const { ipcMain } = createHarness();
  for (const bad of [null, undefined, "", 42, { id: "s1" }]) {
    const result = await ipcMain.invoke("session:ack-completion", bad);
    assert.strictEqual(result.status, "error", `expected error for payload ${JSON.stringify(bad)}`);
  }
});

test("registerSessionIpc requires ackSessionCompletion dep", () => {
  assert.throws(
    () => registerSessionIpc({
      ipcMain: new FakeIpcMain(),
      getSessionSnapshot: () => ({}),
      getI18n: () => ({}),
      focusSession: () => {},
      hideSession: () => {},
      setSessionAlias: () => {},
      showDashboard: () => {},
      setSessionHudPinned: () => {},
      openSessionFolder: () => {},
      setSessionAutomationOverride: () => {},
      clearSessionAutomationGrant: () => {},
      // ackSessionCompletion intentionally absent
    }),
    /ackSessionCompletion/
  );
});

test("dashboard renderer wires the Mark-read button + ackCompletion fallback (source check)", () => {
  // The renderer module runs in a browser context; a full DOM harness
  // would be heavy. The contract this test enforces is structural:
  // (1) Mark-read button mounts gated on requiresCompletionAck,
  // (2) Jump-to-terminal click awaits ackCompletion,
  // (3) Mark-read click awaits invoke result and re-enables on failure.
  // Manual QA covers the actual click flow.
  const rendererSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "dashboard-renderer.js"),
    "utf8"
  );
  assert.ok(rendererSrc.includes("session.requiresCompletionAck === true"),
    "Mark-read button visibility must gate on requiresCompletionAck");
  assert.ok(rendererSrc.includes("createMarkReadButton"),
    "Mark-read button helper missing");
  assert.ok(rendererSrc.includes("dashboardAPI.ackCompletion"),
    "Renderer must call dashboardAPI.ackCompletion");
  // Failure path re-enables the button so the user can retry
  assert.ok(/result\.status !== "ok"[\s\S]+button\.disabled = false/.test(rendererSrc),
    "Mark-read click must re-enable button on ack failure");

  const i18nSrc = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");
  // Both new keys must appear once in every supported language table.
  for (const key of ["dashboardMarkRead", "dashboardMarkReadTitle"]) {
    const matches = i18nSrc.match(new RegExp(`\\b${key}:`, "g"));
    const matchCount = matches ? matches.length : 0;
    assert.strictEqual(matchCount, SUPPORTED_LANGS.length,
      `${key} should appear in all ${SUPPORTED_LANGS.length} supported language tables (saw ${matchCount})`);
  }
});

test("Dashboard exposes the trusted Kimi quota refresh bridge and localized action", () => {
  const rendererSrc = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
  const preloadSrc = fs.readFileSync(path.join(__dirname, "..", "src", "preload-dashboard.js"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");
  const i18nSrc = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");

  // The refresh button is built by the renderer inside the Kimi quota
  // section header, not static markup in dashboard.html.
  assert.match(rendererSrc, /quota-refresh-button/);
  assert.match(htmlSrc, /\.quota-refresh-button\s*\{/);
  assert.match(preloadSrc, /dashboard:get-kimi-quota-status/);
  assert.match(preloadSrc, /dashboard:refresh-kimi-quota/);
  assert.match(rendererSrc, /refreshKimiQuotaFromDashboard/);
  for (const key of [
    "dashboardKimiQuotaRefresh",
    "dashboardKimiQuotaRefreshing",
    "dashboardKimiQuotaUpdated",
    "dashboardKimiQuotaRefreshFailed",
    "dashboardKimiQuotaEmpty",
    "dashboardKimiQuotaRefreshShort",
  ]) {
    const matches = i18nSrc.match(new RegExp(`\\b${key}:`, "g"));
    assert.strictEqual(matches ? matches.length : 0, SUPPORTED_LANGS.length);
  }
});

test("main forwards dashboard open source options into session IPC", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const preservesOptions = [
    /registerSessionIpc\(\{[\s\S]*?showDashboard\s*,/,
    /registerSessionIpc\(\{[\s\S]*?showDashboard:\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*showDashboard\(\s*\1\s*\)/,
    /registerSessionIpc\(\{[\s\S]*?showDashboard:\s*\(\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*showDashboard\(\s*\.\.\.\s*\1\s*\)/,
  ].some((pattern) => pattern.test(mainSource));

  assert.strictEqual(
    preservesOptions,
    true,
    "main.js should preserve dashboard open options when wiring session IPC"
  );
});
