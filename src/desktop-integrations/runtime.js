"use strict";
const path = require("node:path"),
  os = require("node:os"),
  fs = require("node:fs"),
  { execFile } = require("node:child_process");
const { normalizeDesktopIntegrations } = require("./settings");
function createDesktopIntegrations(ctx, dependencies = {}) {
  if (typeof ctx.getDesktopIntegrationSettings !== "function")
    return { menuItems: () => [], showSettings() {}, dispose() {} };
  const electron = dependencies.electron || require("electron"),
    { app, BrowserWindow, ipcMain, dialog, shell, net, clipboard } = electron;
  let panel = null,
    qq = null,
    checkin = null,
    questionServer = null,
    questionStarting = null,
    disposed = false,
    qqStarting = null,
    questionGuard = null;
  const views = new Map(),
    children = new Set(),
    handlers = [],
    storageRoot = path.join(app.getPath("userData"), "desktop-integrations"),
    discoveryPath = path.join(storageRoot, "questions.json");
  const settings = () =>
    normalizeDesktopIntegrations(ctx.getDesktopIntegrationSettings());
  const available = () =>
    !disposed && ctx.desktopIntegrationSettingsAvailable?.() !== false;
  const enabled = (key) => available() && settings()[key] === true;
  const chinese = () => String(ctx.lang || "en").startsWith("zh"),
    text = (en, zh) => (chinese() ? zh : en);
  const translate = require("../i18n").createTranslator(() => ctx.lang || "en");
  function owns(event, win) {
    return (
      win &&
      !win.isDestroyed() &&
      event.sender === win.webContents &&
      event.senderFrame === win.webContents.mainFrame
    );
  }
  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    handlers.push(channel);
  }
  function secureWindow({ title, file, preload, width = 680, height = 680 }) {
    const win = new BrowserWindow({
      width,
      height,
      minWidth: 360,
      minHeight: 380,
      show: false,
      resizable: true,
      title,
      webPreferences: {
        preload: path.join(__dirname, preload),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.show();
    });
    win.loadFile(path.join(__dirname, file));
    return win;
  }
  function showSettings() {
    if (panel && !panel.isDestroyed()) {
      panel.show();
      panel.focus();
      return;
    }
    panel = secureWindow({
      title: text("Desktop integrations", "桌面接入"),
      file: "settings.html",
      preload: "settings-preload.cjs",
    });
    panel.on("closed", () => {
      panel = null;
    });
  }
  async function music() {
    if (!enabled("qqmusicEnabled"))
      throw Error(
        text(
          "Enable QQ Music in desktop integration settings first.",
          "请先在桌面接入设置中启用 QQ 音乐",
        ),
      );
    if (qq) return qq;
    if (qqStarting) return qqStarting;
    const selected = settings().qqmusicExecutable;
    qqStarting = (async () => {
      const nativeRoot = await (
        dependencies.prepareNativeHelpers ||
        require("./native-helpers").prepareNativeHelpers
      )({ storageRoot });
      if (
        !enabled("qqmusicEnabled") ||
        settings().qqmusicExecutable !== selected
      )
        throw Error("QQ Music settings changed");
      qq = require("./qqmusic/qqmusic-main")(ctx, {
        executable: selected,
        nativeRoot,
        isEnabled: () => enabled("qqmusicEnabled"),
        getPanelSize: () => settings().qqmusicPanelSize,
        savePanelSize: (size) =>
          ctx.saveDesktopIntegrationSettings({
            ...settings(),
            qqmusicPanelSize: size,
          }),
      });
      return qq;
    })();
    try {
      return await qqStarting;
    } finally {
      qqStarting = null;
    }
  }
  function cockpit() {
    if (!enabled("cockpitCheckinEnabled"))
      throw Error(
        text("Enable WorkBuddy check-in first.", "请先启用 WorkBuddy 签到"),
      );
    if (!checkin)
      checkin = require("./checkin/main.cjs")({
        dataRoot:
          settings().cockpitDataRoot ||
          path.join(os.homedir(), ".antigravity_cockpit"),
        isEnabled: () => enabled("cockpitCheckinEnabled"),
        getLang: () => ctx.lang,
      });
    return checkin;
  }
  function warning(error) {
    return dialog.showMessageBox({
      type: "warning",
      title: text("Desktop integrations", "桌面接入"),
      message: chinese()
        ? String(error?.message || error)
        : "The operation could not finish. Check the configured path, application login and network connection.",
      buttons: [text("OK", "知道了")],
    });
  }
  function safe(operation) {
    Promise.resolve().then(operation).catch(warning);
  }
  async function openApp(id) {
    if (!available()) throw Error("Settings unavailable");
    const target = settings().apps.find((item) => item.id === id);
    if (!target) throw Error("Application is no longer configured");
    if (
      !fs.statSync(target.executable).isFile() &&
      !(process.platform === "darwin" && target.executable.endsWith(".app"))
    )
      throw Error("Application path is unavailable");
    const error = await shell.openPath(target.executable);
    if (error) throw Error(error);
  }
  async function gateway(action) {
    if (process.platform !== "win32" || !enabled("gatewayEnabled"))
      throw Error("Gateway integration is disabled or unsupported");
    const config = settings();
    return new Promise((resolve, reject) => {
      const child = execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          workerFile("gateway-worker.ps1"),
          "-Action",
          action,
          "-GatewayExecutable",
          config.gatewayExecutable,
          "-HealthPort",
          String(config.gatewayPort),
        ],
        {
          windowsHide: true,
          timeout: 20000,
          maxBuffer: 65536,
          encoding: "utf8",
        },
        (error, stdout) => {
          children.delete(child);
          if (error) return reject(Error("Gateway operation failed"));
          try {
            const value = JSON.parse(stdout.trim());
            if (!value.ok) throw Error(value.error || "Gateway unavailable");
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
      );
      children.add(child);
    });
  }
  function workerFile(name) {
    const bytes = fs.readFileSync(path.join(__dirname, "tools", name)),
      hash = require("node:crypto")
        .createHash("sha256")
        .update(bytes)
        .digest("hex");
    const target = path.join(storageRoot, "workers", hash + ".ps1");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: "wx" });
    if (!fs.readFileSync(target).equals(bytes))
      throw Error("Desktop helper source changed");
    return target;
  }
  async function appStatus(id) {
    const target = settings().apps.find((item) => item.id === id);
    if (!target) throw Error("Application is no longer configured");
    if (process.platform !== "win32")
      return dialog.showMessageBox({
        message: fs.existsSync(target.executable)
          ? text("Application found", "已找到应用")
          : text("Application not found", "未找到应用"),
      });
    const value = await new Promise((resolve, reject) => {
      const child = execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          workerFile("application-status.ps1"),
        ],
        {
          windowsHide: true,
          timeout: 12000,
          maxBuffer: 16384,
          encoding: "utf8",
        },
        (error, stdout) => {
          children.delete(child);
          if (error) return reject(Error("Status unavailable"));
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(Error("Status unavailable"));
          }
        },
      );
      children.add(child);
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ executable: target.executable }));
    });
    return dialog.showMessageBox({
      message:
        target.name +
        ": " +
        (!value.installed
          ? text("not installed", "未找到程序")
          : value.running
            ? text("running", "运行中")
            : text("stopped", "未运行")),
    });
  }
  function canShowQuestions() {
    return (
      available() &&
      !ctx.doNotDisturb &&
      !ctx.hideBubbles &&
      ctx.permissionBubblesEnabled !== false
    );
  }
  function present(input, decisions) {
    const win = secureWindow({
      title: text("Clawd question", "桌宠提问"),
      file: "question.html",
      preload: "question-preload.cjs",
      width: 500,
      height: 590,
    });
    const contents = win.webContents;
    const record = { win, input: { ...input, lang: ctx.lang }, decisions };
    views.set(contents, record);
    win.on("closed", () => {
      views.delete(contents);
      decisions.cancel();
    });
    return {
      close() {
        views.delete(contents);
        if (!win.isDestroyed()) win.destroy();
      },
    };
  }
  async function reconcileQuestions() {
    if (questionStarting) {
      await questionStarting;
      return reconcileQuestions();
    }
    if (!enabled("questionsEnabled")) {
      clearInterval(questionGuard);
      questionGuard = null;
      if (questionServer) {
        const previous = questionServer;
        questionServer = null;
        await previous.dispose();
      }
      return;
    }
    if (questionServer) return;
    questionStarting = require("./questions").createQuestionServer({
      discoveryPath,
      isEnabled: () => enabled("questionsEnabled"),
      canShow: canShowQuestions,
      present,
    });
    try {
      questionServer = await questionStarting;
      questionGuard = setInterval(() => {
        if (!canShowQuestions()) questionServer?.cancelPending();
      }, 250);
      questionGuard.unref?.();
    } finally {
      questionStarting = null;
    }
    if (!enabled("questionsEnabled")) await reconcileQuestions();
  }
  handle("desktop-integrations:settings", async (event, payload) => {
    if (!owns(event, panel))
      return { status: "error", message: "Invalid settings window" };
    if (payload?.action === "get")
      return {
        status: "ok",
        settings: settings(),
        lang: ctx.lang,
        platform: process.platform,
        arch: process.arch,
        available: available(),
      };
    if (payload?.action === "save") {
      if (!available())
        return { status: "error", message: "Settings are read-only" };
      const result = await ctx.saveDesktopIntegrationSettings({
        ...payload.value,
        qqmusicPanelSize: settings().qqmusicPanelSize,
      });
      return { ...result, settings: settings() };
    }
    if (payload?.action === "choose") {
      const result = await dialog.showOpenDialog(panel, {
        properties: [
          payload.kind === "directory" ? "openDirectory" : "openFile",
        ],
        ...(process.platform === "win32" && payload.kind !== "directory"
          ? { filters: [{ name: "Applications", extensions: ["exe"] }] }
          : {}),
      });
      return {
        status: "ok",
        path: result.canceled ? null : result.filePaths[0] || null,
      };
    }
    if (payload?.action === "copy-mcp") {
      const sourcePath = path.join(
        app.isPackaged
          ? process.resourcesPath
          : path.resolve(__dirname, "../.."),
        app.isPackaged
          ? "app.asar.unpacked/hooks/desktop-question-mcp.cjs"
          : "hooks/desktop-question-mcp.cjs",
      );
      clipboard.writeText(
        JSON.stringify(
          {
            mcpServers: {
              clawd_questions: {
                command: "node",
                args: [sourcePath, "--endpoint", discoveryPath],
              },
            },
          },
          null,
          2,
        ),
      );
      return { status: "ok" };
    }
    return { status: "error", message: "Unknown action" };
  });
  handle("desktop-question:get", (event) => {
    const view = views.get(event.sender);
    return view && owns(event, view.win) ? view.input : null;
  });
  handle("desktop-question:answer", (event, answers) => {
    const view = views.get(event.sender);
    return {
      ok:
        !!view &&
        owns(event, view.win) &&
        view.decisions.answer(answers) === true,
    };
  });
  handle("desktop-question:cancel", (event) => {
    const view = views.get(event.sender);
    if (view && owns(event, view.win)) view.decisions.cancel();
    return { ok: true };
  });
  let previous = settings();
  const unsubscribe = ctx.subscribeDesktopIntegrationSettings?.(() => {
    const next = settings();
    if (
      next.qqmusicEnabled !== previous.qqmusicEnabled ||
      next.qqmusicExecutable !== previous.qqmusicExecutable
    ) {
      qq?.dispose?.();
      qq = null;
    }
    if (
      next.cockpitCheckinEnabled !== previous.cockpitCheckinEnabled ||
      next.cockpitDataRoot !== previous.cockpitDataRoot
    ) {
      checkin?.dispose?.();
      checkin = null;
    }
    if (
      next.gatewayEnabled !== previous.gatewayEnabled ||
      next.gatewayExecutable !== previous.gatewayExecutable ||
      next.gatewayPort !== previous.gatewayPort
    ) {
      for (const child of children) child.kill();
      children.clear();
    }
    previous = next;
    void reconcileQuestions().catch(() => {});
  });
  const ready = app
    .whenReady()
    .then(() => reconcileQuestions())
    .catch(() => {});
  async function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(questionGuard);
    unsubscribe?.();
    for (const channel of handlers) ipcMain.removeHandler(channel);
    for (const view of [...views.values()]) view.decisions.cancel();
    panel?.destroy();
    qq?.dispose?.();
    checkin?.dispose?.();
    for (const child of children) child.kill();
    children.clear();
    await ready;
    if (questionStarting)
      try {
        await questionStarting;
      } catch {}
    if (questionServer) await questionServer.dispose();
    clearInterval(questionGuard);
    questionServer = null;
  }
  app.once("will-quit", () => {
    void dispose();
  });
  return {
    showSettings,
    dispose,
    menuItems: () => {
      const config = settings(),
        submenu = [
          {
            label: text("Configure desktop integrations…", "设置桌面接入…"),
            click: showSettings,
          },
        ];
      if (
        config.qqmusicEnabled &&
        process.platform === "win32" &&
        process.arch === "x64"
      )
        submenu.push({
          label: "QQ Music",
          submenu: [
            [
              "Player",
              "音乐控制面板",
              () => music().then((player) => player.show()),
            ],
            [
              "Queue",
              "播放队列",
              () => music().then((player) => player.show("queue")),
            ],
            [
              "My playlists",
              "我的歌单",
              () => music().then((player) => player.show("playlists")),
            ],
            ...[
              ["Previous", "上一首", "previous"],
              ["Play / pause", "播放 / 暂停", "toggle"],
              ["Next", "下一首", "next"],
              ["Volume +5%", "音量 +5%", "volume-up"],
              ["Volume −5%", "音量 −5%", "volume-down"],
              ["Mute / unmute", "静音 / 取消静音", "mute"],
            ].map(([en, zh, action]) => [
              en,
              zh,
              () => music().then((player) => player.quick(action)),
            ]),
          ]
            .map(([en, zh, operation]) => ({
              label: text(en, zh),
              click: () => safe(operation),
            }))
            .concat([
              {
                label: text("Playback mode", "播放模式"),
                submenu: [
                  ["shuffle", "Shuffle", "随机播放"],
                  ["sequence", "In order", "顺序播放"],
                  ["single", "Repeat song", "单曲循环"],
                  ["repeat", "Repeat list", "列表循环"],
                ].map(([value, en, zh]) => ({
                  label: text(en, zh),
                  click: () =>
                    safe(() =>
                      music().then((player) => player.quick("set-mode", value)),
                    ),
                })),
              },
              {
                label: text("Desktop lyrics", "桌面歌词"),
                submenu: [
                  [true, "Show", "显示"],
                  [false, "Hide", "隐藏"],
                ].map(([value, en, zh]) => ({
                  label: text(en, zh),
                  click: () =>
                    safe(() =>
                      music().then((player) =>
                        player.quick("set-lyrics", value),
                      ),
                    ),
                })),
              },
            ]),
        });
      if (config.cockpitCheckinEnabled)
        submenu.push({
          label: "WorkBuddy",
          submenu: [
            {
              label: text("Check in current account", "当前账号签到"),
              click: () => safe(() => cockpit().current()),
            },
            {
              label: text(
                "Check-in panel / all accounts",
                "签到面板 / 全部账号",
              ),
              click: () => safe(() => cockpit().show()),
            },
          ],
        });
      for (const item of config.apps)
        submenu.push({
          label: item.name,
          submenu: [
            {
              label: text("Open", "打开"),
              click: () => safe(() => openApp(item.id)),
            },
            {
              label: text("Status", "查看运行状态"),
              click: () => safe(() => appStatus(item.id)),
            },
          ],
        });
      if (config.gatewayEnabled && process.platform === "win32")
        submenu.push({
          label: text("Gateway", "喵云网关"),
          submenu: [
            ...["start", "stop"].map((action) => ({
              label:
                action === "start"
                  ? text("Start", "启动")
                  : text("Stop", "停止"),
              click: () => safe(() => gateway(action)),
            })),
            {
              label: text("Status / open manager", "状态 / 打开管理页"),
              click: () =>
                safe(async () => {
                  const result = await gateway("status");
                  if (result.state.running)
                    await shell.openExternal(
                      "http://127.0.0.1:" + config.gatewayPort + "/panel/",
                    );
                  else
                    await dialog.showMessageBox({
                      message: text("Gateway is stopped", "网关已停止"),
                    });
                }),
            },
          ],
        });
      return [{ label: translate("desktopIntegrations"), submenu }];
    },
  };
}
module.exports = { createDesktopIntegrations };
