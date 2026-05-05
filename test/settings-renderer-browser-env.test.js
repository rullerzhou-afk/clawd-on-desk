"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const SETTINGS_HTML = path.join(SRC_DIR, "settings.html");
const SETTINGS_RENDERER = path.join(SRC_DIR, "settings-renderer.js");
const SETTINGS_UI_CORE = path.join(SRC_DIR, "settings-ui-core.js");
const SETTINGS_ANIM_OVERRIDES_MERGE = path.join(SRC_DIR, "settings-anim-overrides-merge.js");
const SETTINGS_I18N = path.join(SRC_DIR, "settings-i18n.js");
const SETTINGS_DOCTOR_MODAL = path.join(SRC_DIR, "settings-doctor-modal.js");
const SETTINGS_ANIMATION_PREVIEW = path.join(SRC_DIR, "settings-animation-preview.html");
const PRELOAD_SETTINGS = path.join(SRC_DIR, "preload-settings.js");
const MAIN_PROCESS = path.join(SRC_DIR, "main.js");
const DOCTOR_IPC = path.join(SRC_DIR, "doctor-ipc.js");
const TAB_MODULES = [
  path.join(SRC_DIR, "settings-tab-general.js"),
  path.join(SRC_DIR, "settings-tab-agents.js"),
  path.join(SRC_DIR, "settings-tab-theme.js"),
  path.join(SRC_DIR, "settings-tab-anim-map.js"),
  path.join(SRC_DIR, "settings-tab-anim-overrides.js"),
  path.join(SRC_DIR, "settings-tab-shortcuts.js"),
  path.join(SRC_DIR, "settings-tab-about.js"),
];

function createDeferred() {
  const deferred = {};
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  return deferred;
}

function loadSettingsCoreForTest(settingsAPI) {
  const context = {
    console,
    navigator: { platform: "Win32" },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    document: {
      body: { contains: () => false },
      getElementById: () => null,
    },
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    window: null,
    globalThis: null,
    settingsAPI,
    ClawdSettingsSizeSlider: {
      SIZE_UI_MIN: 1,
      SIZE_UI_MAX: 100,
      SIZE_TICK_VALUES: [25, 50, 75, 100],
      SIZE_SLIDER_THUMB_DIAMETER: 18,
      prefsSizeToUi: (value) => value,
      clampSizeUi: (value) => value,
      sizeUiToPct: (value) => value,
      getSizeSliderAnchorPx: () => 0,
      createSizeSliderController: () => ({}),
    },
    ClawdSettingsI18n: {
      STRINGS: { en: {} },
      CONTRIBUTORS: [],
      MAINTAINERS: [],
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SETTINGS_ANIM_OVERRIDES_MERGE, "utf8"), context);
  vm.runInContext(fs.readFileSync(SETTINGS_UI_CORE, "utf8"), context);
  return context.ClawdSettingsCore;
}

function createQueuedRaf() {
  const queue = [];
  return {
    requestAnimationFrame(cb) {
      queue.push(cb);
      return queue.length;
    },
    flush() {
      while (queue.length) {
        const cb = queue.shift();
        cb();
      }
    },
  };
}

class FakeClassList {
  constructor(el) {
    this.el = el;
  }

  _set(values) {
    this.el.className = [...values].join(" ");
  }

  _values() {
    return new Set(String(this.el.className || "").split(/\s+/).filter(Boolean));
  }

  add(...names) {
    const values = this._values();
    for (const name of names) values.add(name);
    this._set(values);
  }

  remove(...names) {
    const values = this._values();
    for (const name of names) values.delete(name);
    this._set(values);
  }

  contains(name) {
    return this._values().has(name);
  }

  toggle(name, force) {
    const values = this._values();
    const shouldAdd = force === undefined ? !values.has(name) : !!force;
    if (shouldAdd) values.add(name);
    else values.delete(name);
    this._set(values);
    return shouldAdd;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "").toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.eventListeners = {};
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.type = "";
    this.disabled = false;
    this.open = false;
    this.parentNode = null;
    this.scrollTop = 0;
    this.style = {
      _values: {},
      setProperty(name, value) {
        this._values[name] = String(value);
      },
      getPropertyValue(name) {
        return this._values[name] || "";
      },
    };
    this.classList = new FakeClassList(this);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
    if (name === "id") this.id = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === "class") this.className = "";
    if (name === "id") delete this.id;
  }

  addEventListener(type, cb) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(cb);
  }

  set innerHTML(_value) {
    this.children = [];
  }

  get innerHTML() {
    return "";
  }

  _matches(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child._matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  contains(target) {
    if (target === this) return true;
    return this.children.some((child) => child.contains(target));
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }

  get isConnected() {
    let current = this;
    while (current) {
      if (current.tagName === "BODY") return true;
      current = current.parentNode;
    }
    return false;
  }

  get scrollHeight() {
    if (!this.isConnected) return 0;
    return Math.max(40, this.children.length * 40);
  }
}

function loadAgentsTabForTest({
  snapshot,
  agentMetadata,
  collapsedGroups = {},
} = {}) {
  const raf = createQueuedRaf();
  const body = new FakeElement("body");
  const content = new FakeElement("main");
  content.id = "content";
  body.appendChild(content);

  const localStorageData = {
    "clawd.settings.collapsedGroups.v1": JSON.stringify(collapsedGroups),
  };

  const document = {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById(id) {
      if (id === "content") return content;
      return null;
    },
  };

  const context = {
    console,
    navigator: { platform: "Win32" },
    localStorage: {
      getItem: (key) => (Object.prototype.hasOwnProperty.call(localStorageData, key) ? localStorageData[key] : null),
      setItem: (key, value) => {
        localStorageData[key] = String(value);
      },
    },
    document,
    requestAnimationFrame: (cb) => raf.requestAnimationFrame(cb),
    window: null,
    globalThis: null,
    settingsAPI: {
      command: () => Promise.resolve({ status: "ok" }),
    },
    ClawdSettingsSizeSlider: {
      SIZE_UI_MIN: 1,
      SIZE_UI_MAX: 100,
      SIZE_TICK_VALUES: [25, 50, 75, 100],
      SIZE_SLIDER_THUMB_DIAMETER: 18,
      prefsSizeToUi: (value) => value,
      clampSizeUi: (value) => value,
      sizeUiToPct: (value) => value,
      getSizeSliderAnchorPx: () => 0,
      createSizeSliderController: () => ({}),
    },
    ClawdSettingsI18n: {
      STRINGS: {
        en: {
          agentsTitle: "Agents",
          agentsSubtitle: "subtitle",
          agentsEmpty: "empty",
          rowAgentIdleAlerts: "Idle alerts",
          rowAgentIdleAlertsDesc: "Idle alert desc",
          rowAgentPermissions: "Permissions",
          rowAgentPermissionsDesc: "Permissions desc",
          rowCodexPermissionMode: "Permission mode",
          rowCodexPermissionModeDesc: "Permission mode desc",
          codexPermissionModeNative: "Native",
          codexPermissionModeIntercept: "Intercept",
          badgePermissionBubble: "Permission bubble",
          eventSourceHook: "Hook",
          eventSourceLogPoll: "Log poll",
          eventSourcePlugin: "Plugin",
          collapsibleExpand: "Expand",
          collapsibleCollapse: "Collapse",
          toastSaveFailed: "Failed: ",
        },
      },
      CONTRIBUTORS: [],
      MAINTAINERS: [],
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SETTINGS_ANIM_OVERRIDES_MERGE, "utf8"), context);
  vm.runInContext(fs.readFileSync(SETTINGS_UI_CORE, "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, "settings-agent-order.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, "settings-tab-agents.js"), "utf8"), context);

  const core = context.ClawdSettingsCore;
  core.state.snapshot = snapshot || { agents: {} };
  core.state.activeTab = "agents";
  core.runtime.agentMetadata = Array.isArray(agentMetadata) ? agentMetadata : [];
  context.ClawdSettingsTabAgents.init(core);

  let contentRenderCount = 0;
  function renderContent() {
    contentRenderCount++;
    core.ops.clearMountedControls();
    content.innerHTML = "";
    core.tabs.agents.render(content, core);
  }
  core.ops.installRenderHooks({ content: renderContent });

  return {
    core,
    content,
    raf,
    getContentRenderCount: () => contentRenderCount,
  };
}

function loadAnimOverridesTabForTest({ runtime, modalRoot }) {
  const document = {
    body: new FakeElement("body"),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => (id === "modalRoot" ? modalRoot : null),
    querySelector: () => null,
  };
  const context = {
    console,
    document,
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    setInterval: () => 1,
    clearInterval: () => {},
    URL,
    window: {
      settingsAPI: {
        openThemeAssetsDir: () => Promise.resolve({ status: "ok" }),
        command: () => Promise.resolve({ status: "ok" }),
        exportAnimationOverrides: () => Promise.resolve({ status: "empty" }),
        importAnimationOverrides: () => Promise.resolve({ status: "cancel" }),
        previewAnimationOverride: () => Promise.resolve({ status: "ok" }),
        previewReaction: () => Promise.resolve({ status: "ok" }),
      },
    },
    globalThis: null,
    ClawdSettingsAnimOverridesMerge: require(SETTINGS_ANIM_OVERRIDES_MERGE),
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-overrides.js"), "utf8"), context);
  const core = {
    state: { activeTab: "animOverrides" },
    runtime,
    helpers: {
      t: (key) => key,
      attachActivation: (el) => el,
    },
    ops: {
      selectTab: () => {},
      requestRender: ({ modal = false } = {}) => {
        if (modal && typeof core.renderHooks.modal === "function") core.renderHooks.modal();
      },
      fetchAnimationOverridesData: () => Promise.resolve(runtime.animationOverridesData),
      stopAssetPickerPolling: () => {},
      closeAssetPicker: () => {},
      normalizeAssetPickerSelection: () => {},
      showToast: () => {},
    },
    i18n: {
      STRINGS: { en: {} },
    },
    readers: {
      hasAnyThemeOverride: () => false,
      readThemeOverrideMap: () => null,
      getLang: () => "en",
    },
    renderHooks: {},
    tabs: {},
  };
  context.ClawdSettingsTabAnimOverrides.init(core);
  return { core, document };
}

describe("settings renderer browser environment", () => {
  it("loads browser scripts in dependency order and keeps CommonJS helpers out of settings.html", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const scriptOrder = [
      "shortcut-actions.js",
      "settings-size-slider.js",
      "settings-i18n.js",
      "settings-anim-overrides-merge.js",
      "settings-ui-core.js",
      "settings-agent-order.js",
      "settings-tab-general.js",
      "settings-tab-agents.js",
      "settings-tab-theme.js",
      "settings-tab-anim-map.js",
      "settings-tab-anim-overrides.js",
      "settings-tab-shortcuts.js",
      "settings-tab-about.js",
      "settings-doctor-modal.js",
      "settings-renderer.js",
    ];

    let previousIndex = -1;
    for (const scriptName of scriptOrder) {
      const marker = `<script src="${scriptName}"></script>`;
      const nextIndex = html.indexOf(marker);
      assert.notStrictEqual(nextIndex, -1, `settings.html should load ${scriptName}`);
      assert.ok(nextIndex > previousIndex, `${scriptName} should load after the previous dependency`);
      previousIndex = nextIndex;
    }

    assert.ok(
      !html.includes('<script src="settings-size-preview-session.js"></script>'),
      "settings.html must not load the main-process size preview helper"
    );
  });

  it("uses browser globals instead of CommonJS in settings renderer modules", () => {
    const rendererSource = fs.readFileSync(SETTINGS_RENDERER, "utf8");
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    const doctorModalSource = fs.readFileSync(SETTINGS_DOCTOR_MODAL, "utf8");
    const agentOrderSource = fs.readFileSync(path.join(SRC_DIR, "settings-agent-order.js"), "utf8");

    assert.ok(rendererSource.includes("globalThis.ClawdSettingsCore"));
    assert.ok(coreSource.includes("ClawdSettingsSizeSlider"));
    assert.ok(i18nSource.includes("globalThis"));
    assert.ok(doctorModalSource.includes("globalThis"));
    assert.ok(doctorModalSource.includes("ClawdSettingsDoctorModal"));
    assert.ok(agentOrderSource.includes("globalThis"));
    assert.ok(agentOrderSource.includes("module.exports"));

    for (const source of [rendererSource, coreSource, i18nSource, doctorModalSource]) {
      assert.ok(!source.includes("require("));
      assert.ok(!source.includes("module.exports"));
    }
    assert.ok(!agentOrderSource.includes("require("));

    for (const file of TAB_MODULES) {
      const source = fs.readFileSync(file, "utf8");
      assert.ok(!source.includes("require("), `${path.basename(file)} must stay browser-script friendly`);
      assert.ok(!source.includes("module.exports"), `${path.basename(file)} must not use CommonJS exports`);
      assert.ok(!source.includes("settingsAPI.onChanged"), `${path.basename(file)} must not subscribe to settingsAPI.onChanged`);
      assert.ok(!source.includes("settingsAPI.onShortcutRecordKey"), `${path.basename(file)} must not subscribe to settingsAPI.onShortcutRecordKey`);
      assert.ok(!source.includes("settingsAPI.onShortcutFailuresChanged"), `${path.basename(file)} must not subscribe to settingsAPI.onShortcutFailuresChanged`);
    }
  });

  it("wires Clawd Doctor through Settings with Step 2 connection actions", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const rendererSource = fs.readFileSync(SETTINGS_RENDERER, "utf8");
    const doctorModalSource = fs.readFileSync(SETTINGS_DOCTOR_MODAL, "utf8");
    const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
    const mainSource = fs.readFileSync(MAIN_PROCESS, "utf8");
    const doctorIpcSource = fs.readFileSync(DOCTOR_IPC, "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");

    assert.ok(html.includes('<script src="settings-doctor-modal.js"></script>'));
    assert.ok(html.includes(".doctor-indicator"));
    assert.ok(html.includes(".doctor-modal"));
    assert.ok(rendererSource.includes("ClawdSettingsDoctorModal.renderSidebarIndicator"));
    assert.ok(doctorModalSource.includes("initialRunStarted"));
    assert.ok(doctorModalSource.includes("runningPromise"));
    assert.ok(doctorModalSource.includes("root.doctor.runChecks"));
    assert.ok(doctorModalSource.includes("root.doctor.getReport"));
    assert.ok(doctorModalSource.includes("root.doctor.testConnection"));
    assert.ok(doctorModalSource.includes("root.doctor.openClawdLog"));
    assert.ok(doctorModalSource.includes('root.settingsAPI.command("repairDoctorIssue"'));
    assert.ok(doctorModalSource.includes("requiresFixConfirmation"));
    assert.ok(doctorModalSource.includes("renderFixConfirm"));
    assert.ok(doctorModalSource.includes("doctorFixConfirmCodexDetail"));
    assert.ok(doctorModalSource.includes("doctorRestartConfirmDetail"));
    assert.ok(doctorModalSource.includes("doctorRestartButton"));
    assert.ok(doctorModalSource.includes('commandAction.type !== "restart-clawd"'));
    assert.ok(doctorModalSource.includes("repairFeedback"));
    assert.ok(doctorModalSource.includes("lastRepairFeedback"));
    assert.ok(doctorModalSource.includes("core.ops.showToast"));
    assert.ok(!doctorModalSource.includes("core.helpers.showToast"));
    assert.ok(doctorModalSource.includes("agentDetailText"));
    assert.ok(doctorModalSource.includes("startConnectionTest"));
    assert.ok(doctorModalSource.includes("stopConnectionCountdown();"));
    assert.ok(html.includes(".doctor-agent-detail"));
    assert.ok(html.includes(".doctor-connection-panel"));
    assert.ok(html.includes(".doctor-fix-button"));
    assert.ok(html.includes(".doctor-fix-confirm"));
    assert.ok(html.includes(".doctor-privacy-inline"));
    assert.ok(doctorModalSource.includes("doctorPrivacyShort"));
    assert.ok(html.includes(".doctor-repair-feedback"));
    assert.ok(html.includes(".doctor-repair-summary"));
    // Regression guard: agent list must not introduce its own scroll viewport.
    // The outer .doctor-check-list owns scrolling so users get a single scrollbar.
    // [^}]*? keeps the match scoped to this rule body so unrelated max-height
    // declarations elsewhere in settings.html don't trip the assertion.
    assert.ok(!/\.doctor-agent-list\s*\{[^}]*?max-height:/.test(html));
    assert.ok(!/\.doctor-agent-list\s*\{[^}]*?overflow-y:\s*auto/.test(html));
    assert.ok(/\.doctor-agent-item \+ \.doctor-agent-item\s*\{[\s\S]*border-top:\s*1px solid var\(--row-border\);/.test(html));
    assert.ok(preloadSource.includes('contextBridge.exposeInMainWorld("doctor"'));
    assert.ok(preloadSource.includes('ipcRenderer.invoke("doctor:run-checks")'));
    assert.ok(preloadSource.includes('ipcRenderer.invoke("doctor:get-report")'));
    assert.ok(preloadSource.includes('ipcRenderer.invoke("doctor:test-connection"'));
    assert.ok(preloadSource.includes('ipcRenderer.invoke("doctor:open-clawd-log"'));
    assert.ok(mainSource.includes("registerDoctorIpc"));
    assert.ok(doctorIpcSource.includes('ipcMain.handle("doctor:run-checks"'));
    assert.ok(doctorIpcSource.includes('ipcMain.handle("doctor:get-report"'));
    assert.ok(doctorIpcSource.includes('ipcMain.handle("doctor:test-connection"'));
    assert.ok(doctorIpcSource.includes('ipcMain.handle("doctor:open-clawd-log"'));
    assert.ok(doctorIpcSource.includes("createConnectionTestDeduper"));
    assert.ok(doctorIpcSource.includes("createDoctorRunChecksDeduper"));
    assert.ok(doctorIpcSource.includes("runDedupedDoctorChecks"));
    assert.ok(doctorIpcSource.includes("runDedupedDoctorConnectionTest"));
    assert.ok(doctorIpcSource.includes("normalizeDoctorConnectionTestPayload"));
    assert.ok(doctorIpcSource.includes("normalizeDoctorOpenLogPayload"));
    assert.ok(doctorIpcSource.includes("runConnectionTest"));
    assert.ok(doctorIpcSource.includes("openClawdLog"));
    assert.ok(doctorIpcSource.includes("formatDiagnosticReport"));
    assert.ok(doctorIpcSource.includes("getDoctorRedactionOptions"));
    assert.ok(doctorIpcSource.includes("redactDoctorResult(await runDedupedDoctorChecks(), getDoctorRedactionOptions(app))"));
    assert.ok(i18nSource.includes("doctorRunFailed"));
    assert.ok(i18nSource.includes("doctorFixApplied"));
    assert.ok(i18nSource.includes("doctorFixConfirmCodexDetail"));
    assert.ok(i18nSource.includes("doctorRestartConfirmDetail"));
    assert.ok(i18nSource.includes("doctorPrivacyShort"));
    assert.ok(i18nSource.includes("doctorConnectionHttpVerified"));
    assert.ok(i18nSource.includes("doctorOpenLog"));
  });

  it("does not animate the size bubble's horizontal position", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const match = html.match(/\.size-bubble\s*\{([\s\S]*?)\n\}/);
    assert.ok(match, "settings.html should define a .size-bubble rule");
    assert.ok(!/transition:\s*left\b/.test(match[1]));
    assert.ok(/transition:\s*transform 0\.14s ease,\s*box-shadow 0\.18s ease;/.test(match[1]));
  });

  it("renders the size bubble tail as a separated double-layer callout instead of overlapping the pill", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(/--size-bubble-tail-size:\s*4px;/.test(html));
    assert.ok(/--size-bubble-tail-inner-size:\s*3px;/.test(html));
    assert.ok(/--size-bubble-tail-gap:\s*1px;/.test(html));
    assert.ok(/padding-top:\s*29px;/.test(html));
    assert.ok(/\.size-bubble\s*\{[\s\S]*top:\s*6px;[\s\S]*border-radius:\s*9px;[\s\S]*padding:\s*0 7px;[\s\S]*line-height:\s*1\.2;[\s\S]*\}/.test(html));
    assert.ok(/\.size-bubble::before,\s*\.size-bubble::after\s*\{/.test(html));
    assert.ok(/\.size-bubble::before\s*\{[\s\S]*top:\s*calc\(100%\s*\+\s*var\(--size-bubble-tail-gap\)\);[\s\S]*border-top:\s*var\(--size-bubble-tail-size\)\s+solid\s+var\(--accent\);[\s\S]*\}/.test(html));
    assert.ok(/\.size-bubble::after\s*\{[\s\S]*top:\s*calc\(100%\s*\+\s*var\(--size-bubble-tail-gap\)\);[\s\S]*border-top:\s*var\(--size-bubble-tail-inner-size\)\s+solid\s+var\(--panel-bg\);[\s\S]*\}/.test(html));
    assert.ok(!/\.size-bubble::after\s*\{[\s\S]*margin-top:\s*-1px;/.test(html));
  });

  it("exposes aggregate and split bubble controls in the General tab", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(generalSource.includes('key: "hideBubbles"'));
    assert.ok(generalSource.includes("rowHideBubbles"));
    assert.ok(generalSource.includes("setAllBubblesHidden"));
    assert.ok(generalSource.includes('{ hidden: nextRaw }'));
    assert.ok(generalSource.includes('keys.includes("hideBubbles")'));
    assert.ok(generalSource.includes("buildBubblePolicyRow()"));
    assert.ok(generalSource.includes("setBubbleCategoryEnabled"));
    assert.ok(generalSource.includes("state.mountedControls.bubblePolicyControls"));
    assert.ok(generalSource.includes("state.mountedControls.bubblePolicySummary"));
    assert.ok(generalSource.includes("confirmDisableUpdateBubbles"));
    assert.ok(generalSource.includes("category === \"update\" && next === 0"));
    assert.ok(generalSource.includes("notificationBubbleAutoCloseSeconds"));
    assert.ok(generalSource.includes("updateBubbleAutoCloseSeconds"));
    assert.ok(generalSource.includes("bubble-policy-prefix"));
    assert.ok(generalSource.includes('input.type = "text"'));
    assert.ok(generalSource.includes("input.maxLength = 4"));
    assert.ok(generalSource.includes('input.pattern = "[0-9]*"'));
    assert.ok(generalSource.includes('input.value.replace(/\\D+/g, "").slice(0, 4)'));
    assert.ok(generalSource.includes("showSettingsConfirmModal"));
    assert.ok(generalSource.includes("updateBubbleDisableConfirmTitle"));
    assert.ok(/\.bubble-policy-seconds\s*\{[\s\S]*width:\s*42px;/.test(html));
    assert.ok(/\.bubble-policy-seconds\s*\{[\s\S]*box-sizing:\s*border-box;[\s\S]*text-align:\s*center;[\s\S]*padding:\s*0 3px;/.test(html));
    assert.ok(i18nSource.includes("rowHideBubbles"));
    assert.ok(i18nSource.includes("rowBubblePolicy"));
    assert.ok(i18nSource.includes("bubbleUpdateWarning"));
    assert.ok(i18nSource.includes("bubbleSecondsPrefix"));
  });

  it("describes notification bubble seconds as an auto-close upper bound instead of a guaranteed visible duration", () => {
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");

    assert.ok(i18nSource.includes("auto-close upper bound"));
    assert.ok(i18nSource.includes("later session states may dismiss it earlier"));
    assert.ok(i18nSource.includes("自动关闭上限"));
    assert.ok(i18nSource.includes("后续状态可能提前关闭"));
    assert.ok(i18nSource.includes("자동 종료 상한"));
    assert.ok(i18nSource.includes("후속 상태가 더 일찍 닫을 수 있습니다"));
  });

  it("auto-commits bubble seconds shortly after valid input instead of waiting only for change", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    assert.ok(generalSource.includes("BUBBLE_SECONDS_AUTO_COMMIT_DELAY_MS"));
    assert.ok(generalSource.includes('input.addEventListener("input", () => {'));
    assert.ok(generalSource.includes("scheduleSecondsCommit(next);"));
    assert.ok(generalSource.includes('input.addEventListener("blur", () => {'));
    assert.ok(generalSource.includes("flushSecondsCommit();"));
    assert.ok(generalSource.includes('input.addEventListener("change", () => {'));
    assert.ok(generalSource.includes("const next = parseBubbleSecondsInputValue(raw);"));
    assert.ok(generalSource.includes('if (category === "update" && next === 0) return;'));
    assert.ok(generalSource.includes("commitSecondsValue(secondsInput, secondsKey, next, category)"));
    assert.ok(!generalSource.includes("commitSecondsValue(input, secondsKey, next, category).then("));
  });

  it("keeps update bubble disable confirmation inside the Settings renderer", () => {
    const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
    const mainSource = fs.readFileSync(MAIN_PROCESS, "utf8");
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(generalSource.includes("settings-confirm-modal"));
    assert.ok(generalSource.includes("updateBubbleDisableConfirmAction"));
    assert.ok(html.includes(".settings-confirm-modal"));
    assert.ok(html.includes(".settings-confirm-backdrop"));
    assert.ok(!preloadSource.includes("confirmDisableUpdateBubbles"));
    assert.ok(!preloadSource.includes("settings:confirm-disable-update-bubbles"));
    assert.ok(!mainSource.includes("UPDATE_BUBBLE_DIALOG_STRINGS"));
    assert.ok(!mainSource.includes('ipcMain.handle("settings:confirm-disable-update-bubbles"'));
    assert.ok(i18nSource.includes("Hide update bubbles"));
    assert.ok(i18nSource.includes("隐藏更新气泡"));
    assert.ok(generalSource.includes('{ id: "confirm", label: t("updateBubbleDisableConfirmAction"), tone: "danger" }'));
    assert.ok(generalSource.includes('{ id: "cancel", label: t("updateBubbleDisableConfirmCancel"), tone: "accent", defaultFocus: true }'));
    assert.ok(generalSource.includes('if (actionId === "confirm") runToggleCommit(nextEnabled);'));
    assert.ok(generalSource.includes('tone === "accent"'));
    assert.ok(generalSource.includes('tone === "danger"'));
  });

  it("keeps Claude hooks confirmations inside the Settings renderer", () => {
    const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
    const mainSource = fs.readFileSync(MAIN_PROCESS, "utf8");
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(generalSource.includes("confirmDisableClaudeHookManagement"));
    assert.ok(generalSource.includes("runDisconnectClaudeHooks"));
    assert.ok(generalSource.includes("showSettingsConfirmModal({"));
    assert.ok(generalSource.includes("claudeHooksDisableConfirmTitle"));
    assert.ok(generalSource.includes("claudeHooksDisconnectConfirmTitle"));
    assert.ok(generalSource.includes("buttons.find((action) => action.action && action.action.defaultFocus)"));
    assert.ok(generalSource.includes('button.className = `soft-btn${toneClass ? ` ${toneClass}` : ""}`;'));
    assert.ok(generalSource.includes('tone === "accent"'));
    assert.ok(generalSource.includes('tone === "danger"'));
    assert.ok(html.includes(".settings-confirm-danger"));
    assert.ok(!preloadSource.includes("confirmDisableClaudeHooks"));
    assert.ok(!preloadSource.includes("confirmDisconnectClaudeHooks"));
    assert.ok(!mainSource.includes('ipcMain.handle("settings:confirm-disable-claude-hooks"'));
    assert.ok(!mainSource.includes('ipcMain.handle("settings:confirm-disconnect-claude-hooks"'));
    assert.ok(!mainSource.includes("CLAUDE_HOOKS_DIALOG_STRINGS"));
    assert.ok(i18nSource.includes("claudeHooksDisableConfirmTitle"));
    assert.ok(i18nSource.includes("claudeHooksDisableConfirmKeep"));
    assert.ok(i18nSource.includes("claudeHooksDisconnectConfirmKeep"));
  });

  it("clears successful switch transient state so rerenders do not keep wait cursors", () => {
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    assert.ok(
      /clearTransientState\(seq\);\s*setSwitchVisual\(sw,\s*nextVisual,\s*\{\s*pending:\s*false\s*\}\);/.test(coreSource),
      "successful switch actions must delete transient pending state before any later rerender"
    );
    assert.ok(
      !coreSource.includes("setTransientState({ visualOn: nextVisual, pending: false, seq });"),
      "leaving a non-pending transient row lets rerendered controls inherit stale pending state"
    );
  });

  it("clears settings-broadcast transient state before patching or rerendering", () => {
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    assert.ok(coreSource.includes("function clearTransientStateForChanges(changes)"));
    assert.ok(coreSource.includes("state.transientUiState.generalSwitches.delete(key);"));
    assert.ok(coreSource.includes('Object.prototype.hasOwnProperty.call(changes, "agents")'));
    assert.ok(coreSource.includes("state.transientUiState.agentSwitches.clear();"));
    const clearIndex = coreSource.indexOf("clearTransientStateForChanges(changes);");
    const patchIndex = coreSource.indexOf("activeTab.patchInPlace(changes)");
    const renderIndex = coreSource.indexOf("requestRender({ sidebar: true, content: true });", patchIndex);
    assert.notStrictEqual(clearIndex, -1);
    assert.notStrictEqual(patchIndex, -1);
    assert.notStrictEqual(renderIndex, -1);
    assert.ok(clearIndex < patchIndex, "broadcast cleanup must happen before in-place patching");
    assert.ok(clearIndex < renderIndex, "broadcast cleanup must happen before full rerender");
  });

  it("rerenders general tab when the Session HUD parent switch changes", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const match = generalSource.match(/const GENERAL_IN_PLACE_KEYS = new Set\(\[([\s\S]*?)\]\);/);
    assert.ok(match, "general in-place key list must be present");
    assert.ok(!match[1].includes('"sessionHudEnabled"'));
    assert.ok(match[1].includes('"sessionHudShowElapsed"'));
    assert.ok(match[1].includes('"sessionHudCleanupDetached"'));
  });

  it("uses a roomier grid layout for Settings confirmation buttons", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(/\.settings-confirm-modal\s*\{[\s\S]*width:\s*min\(480px,\s*100%\);/.test(html));
    assert.ok(/\.settings-confirm-actions\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(136px,\s*1fr\)\);[\s\S]*gap:\s*9px;/.test(html));
    assert.ok(/\.settings-confirm-actions\s+\.soft-btn\s*\{[\s\S]*min-height:\s*42px;[\s\S]*padding:\s*6px 10px;[\s\S]*white-space:\s*normal;[\s\S]*text-align:\s*center;/.test(html));
  });

  it("provides a persisted collapsible Settings group helper with smart default collapse", () => {
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    assert.ok(coreSource.includes("COLLAPSED_GROUPS_STORAGE_KEY"));
    assert.ok(coreSource.includes("function buildCollapsibleGroup("));
    assert.ok(coreSource.includes("localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)"));
    assert.ok(coreSource.includes("localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY"));
    assert.ok(coreSource.includes("defaultCollapsed = false"));
    assert.ok(coreSource.includes('header.setAttribute("aria-expanded"'));
    assert.ok(coreSource.includes("collapsibleSummary"));
    assert.ok(html.includes(".collapsible-group-header"));
    assert.ok(html.includes(".collapsible-group-chevron"));
    assert.ok(i18nSource.includes("collapsibleExpand"));
    assert.ok(i18nSource.includes("collapsibleCollapse"));
  });

  it("groups Theme cards and exposes Codex Pet import actions in Settings", () => {
    const tabSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-theme.js"), "utf8");
    const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
    const mainSource = fs.readFileSync(MAIN_PROCESS, "utf8");
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");

    assert.ok(tabSource.includes("function getThemeSections(themes)"));
    assert.ok(tabSource.includes("themeGroupBuiltIn"));
    assert.ok(tabSource.includes("themeGroupImportedCodexPets"));
    assert.ok(tabSource.includes("themeGroupUserThemes"));
    assert.ok(tabSource.includes("handleImportCodexPetZip"));
    assert.ok(tabSource.includes("handleOpenCodexPetsFolder"));
    assert.ok(tabSource.includes("handleRemoveCodexPet"));
    assert.ok(tabSource.includes("themeUninstallPetLabel"));
    assert.ok(coreSource.includes("codexPetZipImportPending"));
    assert.ok(coreSource.includes("codexPetRemovalPendingThemeId"));
    assert.ok(preloadSource.includes("openCodexPetsDir"));
    assert.ok(preloadSource.includes("importCodexPetZip"));
    assert.ok(preloadSource.includes("removeCodexPet"));
    assert.ok(mainSource.includes('ipcMain.handle("settings:open-codex-pets-dir"'));
    assert.ok(mainSource.includes('ipcMain.handle("settings:import-codex-pet-zip"'));
    assert.ok(mainSource.includes('ipcMain.handle("settings:remove-codex-pet"'));
    assert.ok(html.includes(".theme-section-title"));
    assert.ok(html.includes(".theme-uninstall-btn"));
    assert.ok(i18nSource.includes("themeImportPetZip"));
    assert.ok(i18nSource.includes("toastCodexPetZipImportOk"));
    assert.ok(i18nSource.includes("toastCodexPetRemoveOk"));
  });

  it("animates collapsible Settings groups with measured height instead of instant hidden jumps", () => {
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(coreSource.includes("function measureCollapsibleBodyHeight("));
    assert.ok(coreSource.includes("function preserveScrollAnchor("));
    assert.ok(coreSource.includes('body.style.setProperty("--collapsible-body-height"'));
    assert.ok(coreSource.includes("requestAnimationFrame(() => {"));
    assert.ok(coreSource.includes("collapsing"));
    assert.ok(coreSource.includes("expanding"));
    assert.ok(coreSource.includes("function setBodyInteractivity(isCollapsed)"));
    assert.ok(coreSource.includes('body.setAttribute("aria-hidden"'));
    assert.ok(coreSource.includes("body.inert = isCollapsed"));
    assert.ok(!coreSource.includes("body.hidden = collapsed;"));
    assert.ok(/\.collapsible-group-body\s*\{[\s\S]*max-height:\s*var\(--collapsible-body-height,\s*0px\);/.test(html));
    assert.ok(/\.collapsible-group-body\s*\{[\s\S]*transition:\s*max-height 0\.22s cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\),\s*opacity 0\.16s ease,\s*transform 0\.18s ease,\s*padding 0\.18s ease,\s*border-color 0\.18s ease;/.test(html));
    assert.ok(/\.collapsible-group\.collapsed\s+\.collapsible-group-body\s*\{[\s\S]*opacity:\s*0;[\s\S]*transform:\s*translateY\(-4px\);/.test(html));
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.collapsible-group-body/.test(html));
  });

  it("collapses only the detailed bubble policy controls while keeping primary bubble rows visible", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    assert.ok(generalSource.includes("buildBubblePolicySummary"));
    assert.ok(generalSource.includes("helpers.buildCollapsibleGroup({"));
    assert.ok(generalSource.includes('id: "general:bubble-policy"'));
    assert.ok(generalSource.includes("defaultCollapsed: true"));
    assert.ok(generalSource.includes('title: t("rowBubblePolicy")'));
    assert.ok(generalSource.includes("const summaryControl = buildBubblePolicySummary();"));
    assert.ok(generalSource.includes("summary: summaryControl.element"));
    assert.ok(generalSource.includes("children: [buildBubblePolicyList()]"));
    assert.ok(generalSource.includes('key: "bubbleFollowPet"'));
    assert.ok(!generalSource.includes('key: "showSessionId"'));
    assert.ok(generalSource.includes('key: "hideBubbles"'));
    assert.ok(i18nSource.includes("bubblePolicySummaryPermission"));
    assert.ok(i18nSource.includes("bubblePolicySummaryNotification"));
    assert.ok(i18nSource.includes("bubblePolicySummaryUpdate"));
  });

  it("renders Agent management as collapsed per-agent groups with master switches always visible", () => {
    const agentsSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-agents.js"), "utf8");
    assert.ok(agentsSource.includes("function buildAgentGroup(agent)"));
    assert.ok(agentsSource.includes("const masterRow = buildAgentMasterRow(agent);"));
    assert.ok(agentsSource.includes("const detailRows = buildAgentDetailRows(agent);"));
    assert.ok(agentsSource.includes('id: `agents:${agent.id}`'));
    assert.ok(agentsSource.includes("defaultCollapsed: true"));
    assert.ok(agentsSource.includes("headerContent: masterRow"));
    assert.ok(agentsSource.includes("children: detailRows"));
    assert.ok(agentsSource.includes("ev.stopPropagation();"));
    assert.ok(agentsSource.includes("agent-subgroup"));
    assert.ok(agentsSource.includes("function syncAgentSwitchDisabledState("));
    assert.ok(!agentsSource.includes("full re-render"));
  });

  it("uses a dedicated Settings agent ordering helper before rendering Agent management groups", () => {
    const agentsSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-agents.js"), "utf8");
    const agentOrderSource = fs.readFileSync(path.join(SRC_DIR, "settings-agent-order.js"), "utf8");
    assert.ok(agentOrderSource.includes("function isAgentCollapsible("));
    assert.ok(agentOrderSource.includes("function sortAgentMetadataForSettings("));
    assert.ok(agentOrderSource.includes("COLLAPSIBLE_AGENT_PRIORITY"));
    assert.ok(agentOrderSource.includes("NON_COLLAPSIBLE_AGENT_PRIORITY"));
    assert.ok(agentsSource.includes("ClawdSettingsAgentOrder"));
    assert.ok(agentsSource.includes("sortAgentMetadataForSettings(runtime.agentMetadata"));
  });

  it("keeps Agent management capability-driven for Gemini wait-for-input alerts", () => {
    const agentsSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-agents.js"), "utf8");
    assert.ok(agentsSource.includes("if (caps.notificationHook) {"));
    assert.ok(agentsSource.includes('flag: "notificationHookEnabled"'));
    assert.ok(!agentsSource.includes('agent.id === "gemini-cli"'));
    assert.ok(!agentsSource.includes('agent.id !== "gemini-cli"'));
    assert.ok(!agentsSource.includes("Gemini CLI"));
  });

  it("patches agent-only broadcasts in place without requiring Codex-specific rows", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "gemini-cli": {
            enabled: true,
            notificationHookEnabled: true,
          },
        },
      },
      agentMetadata: [{
        id: "gemini-cli",
        name: "Gemini CLI",
        eventSource: "hook",
        capabilities: {
          notificationHook: true,
        },
      }],
      collapsedGroups: {
        "agents:gemini-cli": false,
      },
    });

    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();
    const before = harness.getContentRenderCount();

    harness.core.ops.applyChanges({
      changes: {
        agents: {
          "gemini-cli": {
            enabled: true,
            notificationHookEnabled: false,
          },
        },
      },
      snapshot: {
        agents: {
          "gemini-cli": {
            enabled: true,
            notificationHookEnabled: false,
          },
        },
      },
    });

    assert.strictEqual(
      harness.getContentRenderCount(),
      before,
      "agent-only broadcasts should update mounted controls in place instead of rebuilding the expanded group"
    );
  });

  it("does not initialize an expanded agent group at 0px height during rerender", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "gemini-cli": {
            enabled: true,
            notificationHookEnabled: true,
          },
        },
      },
      agentMetadata: [{
        id: "gemini-cli",
        name: "Gemini CLI",
        eventSource: "hook",
        capabilities: {
          notificationHook: true,
        },
      }],
      collapsedGroups: {
        "agents:gemini-cli": false,
      },
    });

    harness.core.ops.requestRender({ content: true });
    const expandedBody = harness.content.querySelector(".collapsible-group-body");
    assert.ok(expandedBody, "agent group body should render");
    assert.notStrictEqual(
      expandedBody.style.getPropertyValue("--collapsible-body-height"),
      "0px",
      "expanded groups should not paint one frame at 0px height before the next animation frame runs"
    );
  });

  it("keeps stale sound override prefs resettable from the settings UI", () => {
    const overridesSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-overrides.js"), "utf8");
    assert.ok(
      overridesSource.includes("resetBtn.disabled = !slot.hasStoredOverride;"),
      "sound override row reset must stay enabled when prefs still contain a stale sound override entry"
    );
  });

  it("uses captured poster previews for trusted scripted animation override SVGs", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const previewHtml = fs.readFileSync(SETTINGS_ANIMATION_PREVIEW, "utf8");
    const overridesSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-overrides.js"), "utf8");
    const mainSource = fs.readFileSync(MAIN_PROCESS, "utf8");
    const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
    const rendererSource = fs.readFileSync(SETTINGS_RENDERER, "utf8");

    assert.ok(html.includes("img-src 'self' data: file:"));
    assert.ok(!html.includes("frame-src"));
    assert.ok(html.includes("settings-anim-overrides-merge.js"));
    const themeTabSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-theme.js"), "utf8");
    assert.ok(!html.includes("object-src"));
    assert.ok(html.includes(".theme-thumb-atlas-frame"));
    assert.ok(html.includes("width: 800%;"));
    assert.ok(themeTabSource.includes("getCodexPetPreviewAtlasUrl"));
    assert.ok(themeTabSource.includes("theme-thumb-atlas-frame"));
    assert.ok(themeTabSource.includes("theme.codexPet.previewAtlasUrl"));
    assert.ok(!themeTabSource.includes('document.createElement("object")'));
    assert.ok(previewHtml.includes("default-src 'self' file:"));
    assert.ok(previewHtml.includes("object-src 'self' file:"));
    assert.ok(previewHtml.includes("script-src 'unsafe-inline'"));
    assert.ok(previewHtml.includes("window.renderAnimationPreviewPoster"));
    assert.ok(previewHtml.includes("width: 285%;"));
    assert.ok(mainSource.includes("ANIMATION_OVERRIDE_PREVIEW_POSTER_VERSION"));
    assert.ok(!overridesSource.includes('document.createElement("iframe")'));
    assert.ok(overridesSource.includes('if (url.protocol === "data:" || url.protocol === "blob:") return fileUrl;'));
    assert.ok(overridesSource.includes("getCardPreviewUrl(card)"));
    assert.ok(overridesSource.includes("getAssetPreviewUrl(selected)"));
    assert.ok(mainSource.includes("function _needsScriptedAnimationPreviewPoster"));
    assert.ok(mainSource.includes("function _isObjectChannelSvgAnimationFile"));
    assert.ok(mainSource.includes('theme.rendering.svgChannel === "object"'));
    assert.ok(mainSource.includes("function _captureAnimationPreviewPosterDataUrl"));
    assert.ok(mainSource.includes("function _scheduleAnimationPreviewPosters"));
    assert.ok(mainSource.includes("capturePage"));
    assert.ok(mainSource.includes("settings:animation-preview-poster-ready"));
    assert.ok(preloadSource.includes("onAnimationPreviewPosterReady"));
    assert.ok(rendererSource.includes("onAnimationPreviewPosterReady"));
    assert.ok(mainSource.includes("theme._builtin"));
    assert.ok(mainSource.includes("trustedRuntime.scriptedSvgFiles"));
    assert.ok(mainSource.includes("currentFilePreviewUrl: preview.previewImageUrl"));
    assert.ok(mainSource.includes("previewPosterPending: preview.previewPosterPending"));
    assert.ok(!mainSource.includes("function _hydrateAnimationPreviewPosters"));
  });

  it("merges pushed animation preview posters without accepting stale cache keys", () => {
    const merge = require(SETTINGS_ANIM_OVERRIDES_MERGE);
    const cache = new Map();
    merge.rememberAnimationPreviewPoster(cache, {
      themeId: "cloudling",
      filename: "cloudling-thinking.svg",
      previewImageUrl: "data:image/png;base64,poster-k1",
      previewPosterCacheKey: "K1",
    });

    const data = {
      theme: { id: "cloudling" },
      assets: [{
        name: "cloudling-thinking.svg",
        previewImageUrl: null,
        previewPosterCacheKey: "K1",
        previewPosterPending: true,
      }],
      sections: [{
        cards: [{
          currentFile: "cloudling-thinking.svg",
          currentFilePreviewUrl: null,
          currentFilePreviewPosterCacheKey: "K1",
          previewPosterPending: true,
        }],
      }],
      cards: [{
        currentFile: "cloudling-thinking.svg",
        currentFilePreviewUrl: null,
        currentFilePreviewPosterCacheKey: "K1",
        previewPosterPending: true,
      }],
    };
    merge.mergePosterCacheIntoAnimationData(data, cache);
    assert.strictEqual(data.assets[0].previewImageUrl, "data:image/png;base64,poster-k1");
    assert.strictEqual(data.assets[0].previewPosterPending, false);
    assert.strictEqual(data.sections[0].cards[0].currentFilePreviewUrl, "data:image/png;base64,poster-k1");
    assert.strictEqual(data.cards[0].currentFilePreviewUrl, "data:image/png;base64,poster-k1");

    const mismatch = {
      theme: { id: "cloudling" },
      assets: [{
        name: "cloudling-thinking.svg",
        previewImageUrl: null,
        previewPosterCacheKey: "K2",
        previewPosterPending: true,
      }],
      sections: [{
        cards: [{
          currentFile: "cloudling-thinking.svg",
          currentFilePreviewUrl: null,
          currentFilePreviewPosterCacheKey: "K2",
          previewPosterPending: true,
        }],
      }],
      cards: [{
        currentFile: "cloudling-thinking.svg",
        currentFilePreviewUrl: null,
        currentFilePreviewPosterCacheKey: "K2",
        previewPosterPending: true,
      }],
    };
    merge.mergePosterCacheIntoAnimationData(mismatch, cache);
    assert.strictEqual(mismatch.assets[0].previewImageUrl, null);
    assert.strictEqual(mismatch.sections[0].cards[0].currentFilePreviewUrl, null);
    assert.strictEqual(mismatch.cards[0].currentFilePreviewUrl, null);
  });

  it("keeps poster-ready pushes across an overlapping animation overrides fetch", async () => {
    const deferred = createDeferred();
    const core = loadSettingsCoreForTest({
      getAnimationOverridesData: () => deferred.promise,
    });
    const fetchPromise = core.ops.fetchAnimationOverridesData();
    core.ops.applyAnimationPreviewPoster({
      themeId: "cloudling",
      filename: "cloudling-thinking.svg",
      previewImageUrl: "data:image/png;base64,pushed",
      previewPosterCacheKey: "K1",
    });
    deferred.resolve({
      theme: { id: "cloudling" },
      assets: [{
        name: "cloudling-thinking.svg",
        previewImageUrl: null,
        previewPosterCacheKey: "K1",
        previewPosterPending: true,
      }],
      sections: [{
        cards: [{
          currentFile: "cloudling-thinking.svg",
          currentFilePreviewUrl: null,
          currentFilePreviewPosterCacheKey: "K1",
          previewPosterPending: true,
        }],
      }],
      cards: [{
        currentFile: "cloudling-thinking.svg",
        currentFilePreviewUrl: null,
        currentFilePreviewPosterCacheKey: "K1",
        previewPosterPending: true,
      }],
    });
    await fetchPromise;

    assert.strictEqual(core.runtime.animationOverridesData.assets[0].previewImageUrl, "data:image/png;base64,pushed");
    assert.strictEqual(core.runtime.animationOverridesData.sections[0].cards[0].currentFilePreviewUrl, "data:image/png;base64,pushed");
    assert.strictEqual(core.runtime.animationOverridesData.cards[0].currentFilePreviewUrl, "data:image/png;base64,pushed");
  });

  it("patches pending animation override data when a poster push arrives after fetch", async () => {
    const core = loadSettingsCoreForTest({
      getAnimationOverridesData: () => Promise.resolve({
        theme: { id: "cloudling" },
        assets: [{
          name: "cloudling-thinking.svg",
          previewImageUrl: null,
          previewPosterCacheKey: "K1",
          previewPosterPending: true,
        }],
        sections: [{
          cards: [{
            currentFile: "cloudling-thinking.svg",
            currentFilePreviewUrl: null,
            currentFilePreviewPosterCacheKey: "K1",
            previewPosterPending: true,
          }],
        }],
        cards: [{
          currentFile: "cloudling-thinking.svg",
          currentFilePreviewUrl: null,
          currentFilePreviewPosterCacheKey: "K1",
          previewPosterPending: true,
        }],
      }),
    });

    await core.ops.fetchAnimationOverridesData();
    core.ops.applyAnimationPreviewPoster({
      themeId: "cloudling",
      filename: "cloudling-thinking.svg",
      previewImageUrl: "data:image/png;base64,late-push",
      previewPosterCacheKey: "K1",
    });

    assert.strictEqual(core.runtime.animationOverridesData.assets[0].previewImageUrl, "data:image/png;base64,late-push");
    assert.strictEqual(core.runtime.animationOverridesData.assets[0].previewPosterPending, false);
    assert.strictEqual(core.runtime.animationOverridesData.sections[0].cards[0].currentFilePreviewUrl, "data:image/png;base64,late-push");
    assert.strictEqual(core.runtime.animationOverridesData.cards[0].currentFilePreviewUrl, "data:image/png;base64,late-push");
  });

  it("does not let a stale rejected animation overrides fetch clear newer data", async () => {
    const oldFetch = createDeferred();
    const newFetch = createDeferred();
    const fetches = [oldFetch, newFetch];
    const core = loadSettingsCoreForTest({
      getAnimationOverridesData: () => fetches.shift().promise,
    });

    const oldPromise = core.ops.fetchAnimationOverridesData();
    const newPromise = core.ops.fetchAnimationOverridesData();
    newFetch.resolve({ theme: { id: "calico" }, assets: [{ name: "calico-idle.png" }], sections: [], cards: [] });
    await newPromise;
    oldFetch.reject(new Error("old failed"));
    await oldPromise;

    assert.strictEqual(core.runtime.animationOverridesData.theme.id, "calico");
    assert.strictEqual(core.runtime.animationOverridesData.assets[0].name, "calico-idle.png");
  });

  it("renders pending scripted animation previews as placeholders instead of SVG images", () => {
    const merge = require(SETTINGS_ANIM_OVERRIDES_MERGE);
    const asset = {
      name: "cloudling-thinking.svg",
      fileUrl: "file:///themes/cloudling/assets/cloudling-thinking.svg",
      previewImageUrl: null,
      needsScriptedPreviewPoster: true,
      previewPosterCacheKey: "K1",
      previewPosterPending: true,
      cycleMs: null,
      cycleStatus: "unavailable",
    };
    const card = {
      id: "state:thinking",
      slotType: "state",
      sectionId: "work",
      stateKey: "thinking",
      triggerKind: "thinking",
      currentFile: asset.name,
      currentFileUrl: asset.fileUrl,
      currentFilePreviewUrl: null,
      currentFilePreviewPosterCacheKey: "K1",
      needsScriptedPreviewPoster: true,
      previewPosterPending: true,
      bindingLabel: "states.thinking[0]",
      transition: { in: 150, out: 150 },
      supportsAutoReturn: false,
      supportsDuration: false,
      autoReturnMs: null,
      durationMs: null,
      assetCycleMs: null,
      assetCycleStatus: "unavailable",
      suggestedDurationMs: null,
      suggestedDurationStatus: "unavailable",
      previewDurationMs: null,
      displayHintWarning: false,
      displayHintTarget: null,
      fallbackTargetState: null,
      wideHitboxEnabled: false,
      wideHitboxOverridden: false,
      aspectRatioWarning: null,
    };
    assert.strictEqual(merge.getAssetPreviewUrl(asset), null);
    assert.strictEqual(merge.getCardPreviewUrl(card), null);

    const runtime = {
      animationOverridesData: {
        theme: { id: "cloudling", name: "Cloudling" },
        assets: [asset],
        sections: [{ id: "work", cards: [card] }],
        cards: [card],
        sounds: [],
      },
      animOverridesSubtab: "animations",
      expandedOverrideRowIds: new Set(["state:thinking"]),
      assetPicker: {
        state: null,
        pollTimer: null,
      },
    };
    const modalRoot = new FakeElement("div");
    const { core } = loadAnimOverridesTabForTest({ runtime, modalRoot });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    runtime.assetPicker.state = { cardId: card.id, selectedFile: asset.name };
    core.renderHooks.modal();

    const svgImages = [
      ...parent.querySelectorAll("img"),
      ...modalRoot.querySelectorAll("img"),
    ].filter((img) => String(img.src || "").includes(".svg"));
    assert.strictEqual(svgImages.length, 0);
    assert.ok(parent.querySelectorAll(".anim-override-preview-pending").length >= 2);
    assert.ok(modalRoot.querySelectorAll(".anim-override-preview-pending").length >= 1);
  });

  it("keeps localized shortcut labels from collapsing into vertical CJK text", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.match(html, /\.shortcut-row-control\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?min-width:\s*0;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?justify-content:\s*flex-start;[\s\S]*?\}/);
    assert.match(html, /\.shortcut-row \.row-text\s*\{[\s\S]*?flex:\s*0 0 190px;[\s\S]*?\}/);
    assert.match(html, /\.shortcut-row \.row-label\s*\{[\s\S]*?word-break:\s*keep-all;[\s\S]*?overflow-wrap:\s*normal;[\s\S]*?\}/);
    assert.match(html, /\.shortcut-value\s*\{[\s\S]*?flex:\s*1 1 190px;[\s\S]*?min-width:\s*160px;[\s\S]*?max-width:\s*286px;[\s\S]*?\}/);
  });

  it("counts sound overrides in the theme-overrides reset gate", () => {
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    assert.ok(
      coreSource.includes("function hasAnyThemeOverride(themeId)"),
      "settings-ui-core.js should expose a helper for any stored theme override"
    );
    assert.ok(
      coreSource.includes("...(map.sounds ? Object.keys(map.sounds) : []),"),
      "sound overrides must participate in the global reset-all gate"
    );
  });
});

describe("macOS platform detection (Settings shortcut labels)", () => {
  const isMac = (platform) => (platform || "").startsWith("Mac");

  it("keeps the unified (navigator.platform startsWith 'Mac') check in settings-ui-core.js", () => {
    const source = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    assert.ok(
      source.includes('(navigator.platform || "").startsWith("Mac")'),
      "settings-ui-core.js must use startsWith('Mac'); word-boundary regex caused #135"
    );
  });

  it("detects every known macOS navigator.platform value", () => {
    assert.strictEqual(isMac("MacIntel"), true);
    assert.strictEqual(isMac("MacPPC"), true);
    assert.strictEqual(isMac("Mac68K"), true);
    assert.strictEqual(isMac("MacARM64"), true);
  });

  it("returns false for non-macOS platforms and degenerate values", () => {
    assert.strictEqual(isMac("Win32"), false);
    assert.strictEqual(isMac("Linux x86_64"), false);
    assert.strictEqual(isMac("iPhone"), false);
    assert.strictEqual(isMac(""), false);
    assert.strictEqual(isMac(undefined), false);
    assert.strictEqual(isMac(null), false);
  });
});
