"use strict";
const { app, BrowserWindow, ipcMain, screen, net } = require("electron");
const path = require("node:path");
const { createService, cleanMessage } = require("./service.cjs");
let instance;
module.exports = function initWorkBuddyCheckin(options = {}) {
  if (instance) return instance;
  const cancellation = new AbortController();
  const service = createService({
      dataRoot: options.dataRoot,
      isEnabled: options.isEnabled,
      signal: cancellation.signal,
      fetch: (url, requestOptions) => net.fetch(url, requestOptions),
    }),
    results = new Map();
  const zh = () => String(options.getLang?.() || "en").startsWith("zh");
  const text = (en, cn) => (zh() ? cn : en);
  let panel = null,
    busy = false,
    progress = "",
    accounts = [];
  const snapshot = () => ({
    lang: options.getLang?.() || "en",
    accounts: accounts.map((a) => ({ ...a, ...results.get(a.id) })),
    busy,
    progress,
  });
  function publish() {
    if (panel && !panel.isDestroyed())
      panel.webContents.send("workbuddy-checkin-state", snapshot());
  }
  function reload() {
    accounts = service.list();
    return snapshot();
  }
  function show() {
    if (panel && !panel.isDestroyed()) {
      panel.show();
      panel.focus();
      publish();
      return;
    }
    const area = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).workArea;
    panel = new BrowserWindow({
      width: Math.min(570, area.width),
      height: Math.min(650, area.height - 20),
      minWidth: 360,
      minHeight: 380,
      show: false,
      resizable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: text("WorkBuddy check-in", "WorkBuddy 签到"),
      backgroundColor: "#f7f8f3",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    panel.setMenu(null);
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panel.webContents.on("will-navigate", (event) => event.preventDefault());
    panel.once("ready-to-show", () => panel?.show());
    panel.on("closed", () => {
      panel = null;
    });
    panel.loadFile(path.join(__dirname, "panel.html"));
  }
  async function run(action, scope) {
    if (busy) return { ok: false, error: "正在签到或查询，请等本轮完成" };
    if (options.isEnabled?.() === false)
      return { ok: false, error: "WorkBuddy 签到已关闭" };
    if (!["checkin", "status"].includes(action))
      return { ok: false, error: "不支持的操作" };
    let selected;
    try {
      reload();
      selected =
        scope === "all"
          ? accounts
          : scope === "current"
            ? accounts.filter((a) => a.current)
            : accounts.filter((a) => a.id === scope);
      if (!selected.length)
        throw Error(
          scope === "current"
            ? "未找到当前账号，请先在 Cockpit 中选定账号，或打开签到面板选择账号"
            : "没有可签到的账号，请先在 Cockpit 中添加 WorkBuddy 账号",
        );
    } catch (error) {
      progress = cleanMessage(error.message);
      publish();
      return { ok: false, error: progress };
    }
    busy = true;
    let completed = 0,
      failed = 0,
      checked = 0,
      already = 0,
      inactive = 0;
    try {
      for (const account of selected) {
        if (options.isEnabled?.() === false || cancellation.signal.aborted) {
          progress = "签到已停止";
          return { ok: false, error: progress };
        }
        progress =
          (action === "checkin"
            ? text("Checking in", "正在签到")
            : text("Checking status", "正在查询")) +
          " " +
          (completed + 1) +
          " / " +
          selected.length;
        results.set(account.id, {
          state: "loading",
          message: action === "checkin" ? "正在处理…" : "查询中…",
        });
        publish();
        try {
          const result =
            action === "checkin"
              ? await service.checkin(account.id)
              : await service.status(account.id);
          const state = result.checked
            ? "checked"
            : result.active
              ? "pending"
              : "inactive";
          results.set(account.id, {
            ...result,
            state,
            message: zh()
              ? result.message ||
                (result.checked
                  ? "今日已签到"
                  : result.active
                    ? "今日待签到"
                    : "活动暂未开放")
              : result.checked
                ? result.already
                  ? "Already checked in"
                  : "Checked in"
                : result.active
                  ? "Not checked in"
                  : "Activity is not open",
          });
          if (result.checked) {
            checked++;
            if (result.already) already++;
          } else if (!result.active) inactive++;
        } catch (error) {
          failed++;
          results.set(account.id, {
            state: error.auth ? "auth" : "error",
            message: zh()
              ? cleanMessage(error.message)
              : "Could not finish. Refresh the account login in Cockpit and check your connection.",
          });
        }
        completed++;
        publish();
      }
      progress =
        action === "checkin"
          ? text(
              `Completed: new ${checked - already}, already checked in ${already}, inactive ${inactive}, failed ${failed}`,
              `本轮完成：新签到 ${checked - already}，已签到 ${already}，活动未开放 ${inactive}，失败 ${failed}`,
            )
          : text(
              `Checked in ${checked} / ${completed}, failed ${failed}`,
              `查询完成：已签到 ${checked} / ${completed}，失败 ${failed}`,
            );
      return { ok: failed === 0, completed, failed, checked, already };
    } finally {
      busy = false;
      publish();
    }
  }
  ipcMain.handle("workbuddy-checkin-action", async (event, payload) => {
    if (
      !panel ||
      panel.isDestroyed() ||
      event.sender !== panel.webContents ||
      event.senderFrame !== panel.webContents.mainFrame
    )
      return { ok: false, error: "无效的签到窗口" };
    if (payload?.action === "list") {
      try {
        return { ok: true, ...reload() };
      } catch (error) {
        return { ok: false, error: cleanMessage(error.message) };
      }
    }
    if (payload?.action === "close") {
      panel.close();
      return { ok: true };
    }
    return run(payload?.action, payload?.scope);
  });
  function current() {
    show();
    void run("checkin", "current");
  }
  instance = {
    show,
    current,
    dispose() {
      cancellation.abort();
      panel?.close();
      ipcMain.removeHandler("workbuddy-checkin-action");
      instance = null;
    },
    menuItems: () => [
      { label: "WorkBuddy 当前账号签到", click: current },
      { label: "WorkBuddy 签到面板 / 全部账号", click: show },
    ],
  };
  return instance;
};
