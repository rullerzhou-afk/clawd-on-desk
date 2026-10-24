"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { createSessionResultCards } = require("../../src/session-result-cards");
const { createSessionResultWindow } = require("../../src/session-result-window");
app.setPath("userData", process.env.CLAWD_RESULT_TEST_PROFILE);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await wait(50); }
  throw new Error("Timed out waiting for result window");
}
app.whenReady().then(async () => {
  let runtime;
  let suppressed = false;
  let scale = 1;
  let lang = "zh";
  const display = screen.getPrimaryDisplay();
  let workArea = { ...display.workArea };
  let blockers = [];
  const store = createSessionResultCards({ enabled: true, onChange: () => runtime?.schedule() });
  runtime = createSessionResultWindow({
    BrowserWindow, ipcMain, store,
    focus: { canOpen: card => card.kind !== "failed", open: async () => "unconfirmed" },
    getLang: () => lang, isSuppressed: () => suppressed,
    getLayout: () => ({ workArea, scale, avoidRects: blockers, fixedCorner: "bottom-right" }),
  });
  let count = 0;
  function result(kind, title) {
    const id = "test-" + ++count;
    const event = kind === "failed" ? "StopFailure" : "Stop";
    const at = Date.now();
    store.observe({
      agentId: "kimi-cli", sessionId: id, event,
      state: kind === "failed" ? "error" : "attention", occurredAt: at, snapshotEventAt: at,
    }, {
      id, agentId: "kimi-cli", agentName: "Kimi Code", displayTitle: title,
      badge: kind === "failed" ? "interrupted" : "done", lastEvent: { rawEvent: event, at },
    });
  }
  result("completed", "整理桌面端集成指南");
  result("completed", "修复多显示器边缘的浮层定位，并验证缩放、会话标题和通知之间的关系");
  result("completed", "<img src=x onerror=alert(1)> 文字按原样显示");
  result("failed", "构建失败 · 查看原会话中的错误");
  await until(() => runtime.getWindow()?.isVisible());
  const win = runtime.getWindow();
  const js = code => win.webContents.executeJavaScript(code, true);
  await until(() => js("document.querySelectorAll('.card').length === 4"));
  await wait(250);
  const errors = [];
  win.webContents.on("console-message", (_event, details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const screenshots = [];
  const output = process.env.CLAWD_RESULT_TEST_OUTPUT;
  async function capture(name) {
    if (!output) return;
    fs.mkdirSync(output, { recursive: true });
    const filename = path.join(output, name + ".png");
    fs.writeFileSync(filename, (await win.webContents.capturePage()).toPNG());
    screenshots.push(filename);
  }
  async function layout() {
    return js(`({
      cards: document.querySelectorAll('.card').length,
      width: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      scroll: document.getElementById('cards').scrollHeight,
      client: document.getElementById('cards').clientHeight,
      firstDisabled: document.querySelector('.open').disabled,
      injectedImages: document.querySelectorAll('img').length,
      panel: document.querySelector('.panel').getBoundingClientRect().toJSON(),
      innerHeight,
      text: document.body.innerText
    })`);
  }
  const normal = await layout();
  assert.equal(normal.cards, 4);
  assert.equal(normal.firstDisabled, true);
  assert.equal(normal.injectedImages, 0);
  assert.ok(normal.scroll > normal.client);
  assert.ok(normal.width <= normal.viewport);
  assert.ok(normal.panel.bottom <= normal.innerHeight + 1);
  store.onSnapshot({ sessions: [{
    id: "test-3", agentId: "kimi-cli", agentName: "Kimi Code",
    displayTitle: "完成组件测试与无障碍检查",
  }] });
  await until(() => js("document.body.innerText.includes('完成组件测试与无障碍检查')"));
  await capture("results-zh-100");
  await js("document.querySelectorAll('.open')[1].click()");
  await until(() => js("document.body.innerText.includes('已尝试打开')"));
  assert.equal(store.list().length, 4);
  await js("document.querySelector('.close').click()");
  await until(() => store.list().length === 3);
  await until(() => js("document.querySelectorAll('.card').length === 3"));
  await js("document.getElementById('cards').scrollTop = 500");
  assert.ok(await js("document.getElementById('cards').scrollTop > 0"));
  await js("document.getElementById('cards').scrollTop = 0");
  scale = 1.6; runtime.sync();
  await wait(350);
  const enlarged = await layout();
  assert.ok(enlarged.width <= enlarged.viewport);
  assert.ok(enlarged.panel.bottom <= enlarged.innerHeight + 1);
  await capture("results-zh-160");
  suppressed = true; runtime.sync();
  assert.equal(win.isVisible(), false);
  assert.equal(store.list().length, 3);
  suppressed = false; runtime.sync();
  assert.equal(win.isVisible(), true);
  runtime.setFullscreenSuppressed(true);
  assert.equal(win.isVisible(), false);
  runtime.setFullscreenSuppressed(false);
  assert.equal(win.isVisible(), true);
  // A fully occupied screen must hide, not cover the permission surface.
  blockers = [workArea]; runtime.sync();
  assert.equal(win.isVisible(), false);
  assert.equal(store.list().length, 3);
  blockers = []; scale = 1; lang = "en"; runtime.sync();
  await wait(250);
  await capture("results-en-100");
  const foreign = new BrowserWindow({
    show: false, webPreferences: {
      preload: path.resolve(__dirname, "../../src/preload-session-result.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  await foreign.loadFile(path.resolve(__dirname, "../../src/session-result.html"));
  const card = store.list()[0];
  const rejected = await foreign.webContents.executeJavaScript(
    "window.sessionResults.dismiss(" + JSON.stringify(card.id) + ", " + card.generation + ")"
  );
  assert.equal(rejected, false);
  assert.equal(store.list().length, 3);
  foreign.destroy();
  runtime.dispose();
  assert.equal(win.isDestroyed(), true);
  assert.deepEqual(errors, []);
  const report = { platform: process.platform, electron: process.versions.electron,
    display: display.workArea, normal, enlarged, screenshots,
    checks: ["real renderer", "literal title/XSS", "scroll", "dismiss IPC", "unconfirmed open retained",
      "large text", "visibility restore", "no-space retained", "foreign sender rejected", "cleanup"] };
  if (output) fs.writeFileSync(path.join(output, "gui-results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checks: report.checks, screenshots }));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
