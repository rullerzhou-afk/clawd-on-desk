"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { registerSessionIpc } = require("../src/session-ipc");

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

  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }
}

function createHarness(overrides = {}) {
  const calls = [];
  const ipcMain = new FakeIpcMain();
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
  });
  return { ipcMain, runtime, calls };
}

test("session IPC registers owned channels and disposes them", () => {
  const { ipcMain, runtime } = createHarness();

  assert.deepStrictEqual([...ipcMain.handlers.keys()].sort(), [
    "dashboard:get-i18n",
    "dashboard:get-snapshot",
    "dashboard:hide-session",
    "dashboard:set-session-alias",
    "session-hud:get-i18n",
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

  assert.deepStrictEqual(calls, [
    ["focusSession", "dash-session", { requestSource: "dashboard" }],
    ["focusSession", "hud-session", { requestSource: "hud" }],
    ["setSessionHudPinned", true],
    ["setSessionHudPinned", false],
    ["hideSession", "hidden-session"],
    ["setSessionAlias", { sessionId: "s1", alias: "Frontend" }],
  ]);
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
  // Both new keys must appear in all 5 language tables (en/zh/zh-TW/ko/ja).
  for (const key of ["dashboardMarkRead", "dashboardMarkReadTitle"]) {
    const matches = i18nSrc.match(new RegExp(`\\b${key}:`, "g"));
    assert.ok(matches && matches.length >= 5,
      `${key} should appear in all 5 language tables (saw ${matches ? matches.length : 0})`);
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
