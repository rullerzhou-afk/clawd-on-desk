"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const I18N = path.join(SRC_DIR, "settings-i18n.js");
const LANGUAGE_PICKER_JS = path.join(SRC_DIR, "language-picker.js");
const ANIM_MERGE = path.join(SRC_DIR, "settings-anim-overrides-merge.js");
const UI_CORE = path.join(SRC_DIR, "settings-ui-core.js");
const FEISHU_APPROVAL_RECIPIENT = path.join(SRC_DIR, "feishu-approval-recipient.js");
const TELEGRAM_APPROVAL_TAB = path.join(SRC_DIR, "settings-tab-telegram-approval.js");
const MOBILE_TAB = path.join(SRC_DIR, "settings-tab-mobile.js");
const ICONS = path.join(SRC_DIR, "settings-icons.js");
const RENDERER = path.join(SRC_DIR, "settings-renderer.js");
const WINDOW_SOURCE = path.join(SRC_DIR, "settings-window.js");
const TAB_FILES = {
  general: "settings-tab-general.js",
  pet: "settings-tab-pet.js",
  notifications: "settings-tab-notifications.js",
  sessions: "settings-tab-sessions.js",
  permissions: "settings-tab-permissions.js",
};

const FROZEN_KEYS = [
  "destructiveActionReminder",
  "size",
  "textScale",
  "textScaleByDisplay",
  "soundMuted",
  "flashTaskbarOnComplete",
  "flashIntervalMs",
  "flashDurationMs",
  "testReactionsEnabled",
  "soundVolume",
  "lowPowerIdleMode",
  "keepAwakeWhileWorking",
  "showTray",
  "showDock",
  "sessionHudEnabled",
  "sessionHudShowStateLabels",
  "sessionHudShowElapsed",
  "sessionHudShowContextUsage",
  "sessionHudShowQuota",
  "quotaRingDisplayMode",
  "quotaAlertsEnabled",
  "quotaAlertThresholds",
  "quotaRecoveryAlertsEnabled",
  "permissionAutomationMode",
  "permissionAutomationAutoToolsWarningDismissed",
  "permissionAutomationUnattendedWarningDismissed",
  "quotaMergeSources",
  "sessionHudCleanupDetached",
  "allowEdgePinning",
  "disableMiniMode",
  "freeRoam",
  "roamConstrainAxis",
  "keepSizeAcrossDisplays",
  "fullscreenAutoHide",
  "openAtLogin",
  "disableHardwareAcceleration",
  "hideBubbles",
  "bubbleFollowPet",
  "bubbleFollowPreference",
  "bubbleFixedCorner",
  "permissionBubblesEnabled",
  "notificationBubbleAutoCloseSeconds",
  "updateBubbleAutoCloseSeconds",
  "sessionStaleMs",
  "workingStaleMs",
  "codexWorkingStaleMs",
  "detachedIdleStaleMs",
];

const EXPECTED_KEYS = {
  general: [
    "textScale",
    "textScaleByDisplay",
    "lowPowerIdleMode",
    "keepAwakeWhileWorking",
    "showTray",
    "showDock",
    "openAtLogin",
    "disableHardwareAcceleration",
  ],
  pet: [
    "size",
    "keepSizeAcrossDisplays",
    "testReactionsEnabled",
    "allowEdgePinning",
    "disableMiniMode",
    "freeRoam",
    "roamConstrainAxis",
    "fullscreenAutoHide",
  ],
  notifications: [
    "soundMuted",
    "soundVolume",
    "flashTaskbarOnComplete",
    "flashIntervalMs",
    "flashDurationMs",
    "hideBubbles",
    "permissionBubblesEnabled",
    "notificationBubbleAutoCloseSeconds",
    "updateBubbleAutoCloseSeconds",
    "bubbleFollowPet",
    "bubbleFollowPreference",
    "bubbleFixedCorner",
  ],
  sessions: [
    "sessionHudEnabled",
    "sessionHudShowStateLabels",
    "sessionHudShowElapsed",
    "sessionHudShowContextUsage",
    "sessionHudCleanupDetached",
    "sessionHudShowQuota",
    "quotaRingDisplayMode",
    "quotaMergeSources",
    "quotaAlertsEnabled",
    "quotaAlertThresholds",
    "quotaRecoveryAlertsEnabled",
    "sessionStaleMs",
    "workingStaleMs",
    "codexWorkingStaleMs",
    "detachedIdleStaleMs",
  ],
  permissions: [
    "permissionAutomationMode",
    "permissionAutomationAutoToolsWarningDismissed",
    "permissionAutomationUnattendedWarningDismissed",
    "destructiveActionReminder",
  ],
};

class FakeClassList {
  constructor(el) {
    this.el = el;
  }

  _values() {
    return new Set(String(this.el.className || "").split(/\s+/).filter(Boolean));
  }

  _set(values) {
    this.el.className = [...values].join(" ");
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
    this._textContent = "";
    this.title = "";
    this.type = "";
    this.disabled = false;
    this.focused = false;
    this.inert = false;
    this._innerHTML = "";
    this.parentNode = null;
    this.scrollTop = 0;
    this.style = {
      _values: {},
      setProperty(name, value) {
        this._values[name] = String(value);
      },
      removeProperty(name) {
        delete this._values[name];
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

  set textContent(value) {
    this._textContent = value == null ? "" : String(value);
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._innerHTML = "";
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  insertBefore(child, reference) {
    child.parentNode = this;
    const index = this.children.indexOf(reference);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index !== -1) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
    if (name === "id") this.id = String(value);
    if (name === "type") this.type = String(value);
    if (name === "tabindex") this.tabIndex = Number(value);
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes[name];
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

  removeEventListener(type, cb) {
    const listeners = this.eventListeners[type];
    if (!listeners) return;
    const index = listeners.indexOf(cb);
    if (index !== -1) listeners.splice(index, 1);
  }

  focus() {
    this.focused = true;
    if (typeof document !== "undefined") document.activeElement = this;
  }

  dispatchEvent(event) {
    const ev = event || {};
    if (!ev.type) throw new Error("FakeElement.dispatchEvent requires an event type");
    if (!ev.target) ev.target = this;
    ev.currentTarget = this;
    if (typeof ev.preventDefault !== "function") {
      ev.preventDefault = function preventDefault() {
        this.defaultPrevented = true;
      };
    }
    if (typeof ev.stopPropagation !== "function") {
      ev.stopPropagation = function stopPropagation() {
        this.cancelBubble = true;
      };
    }
    const listeners = this.eventListeners[ev.type] || [];
    for (const listener of [...listeners]) listener(ev);
    if (ev.bubbles !== false && !ev.cancelBubble && this.parentNode) {
      return this.parentNode.dispatchEvent(ev);
    }
    return !ev.defaultPrevented;
  }

  click() {
    return this.dispatchEvent({ type: "click", bubbles: false });
  }

  set innerHTML(_value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._textContent = "";
    const html = String(_value || "");
    this._innerHTML = html;
    const stack = [this];
    const tagRe = /<\/?([a-zA-Z][\w-]*)([^>]*)>/g;
    let match;
    while ((match = tagRe.exec(html)) !== null) {
      const full = match[0];
      const tagName = match[1];
      const attrSource = match[2] || "";
      if (full.startsWith("</")) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const child = new FakeElement(tagName);
      const attrRe = /([:\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
      let attrMatch;
      while ((attrMatch = attrRe.exec(attrSource)) !== null) {
        const attrName = attrMatch[1];
        if (attrName === "/") continue;
        const attrValue = (attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">");
        child.setAttribute(attrName, attrValue);
      }
      stack[stack.length - 1].appendChild(child);
      const voidTag = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tagName);
      if (!full.endsWith("/>") && !voidTag) stack.push(child);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  _matches(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const tagAttribute = /^([a-zA-Z][\w-]*)\[([:\w-]+)\]$/.exec(selector);
    if (tagAttribute) {
      return this.tagName.toLowerCase() === tagAttribute[1].toLowerCase()
        && Object.prototype.hasOwnProperty.call(this.attributes, tagAttribute[2]);
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  querySelectorAll(selector) {
    const parts = String(selector || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return [];
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child._matchesSelectorParts(parts)) matches.push(child);
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

  _matchesSelectorParts(parts) {
    if (!this._matches(parts[parts.length - 1])) return false;
    let current = this.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (current && !current._matches(parts[i])) current = current.parentNode;
      if (!current) return false;
      current = current.parentNode;
    }
    return true;
  }
}

function loadI18n() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(I18N, "utf8"), context);
  return context.ClawdSettingsI18n;
}

function loadIcons() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(ICONS, "utf8"), context);
  return context.ClawdSettingsIcons;
}

function makeSnapshot(overrides = {}) {
  return {
    lang: "en",
    size: 50,
    textScale: 1,
    textScaleByDisplay: {},
    showTray: true,
    showDock: true,
    openAtLogin: false,
    lowPowerIdleMode: false,
    keepAwakeWhileWorking: false,
    keepSizeAcrossDisplays: true,
    allowEdgePinning: true,
    disableMiniMode: false,
    freeRoam: false,
    roamConstrainAxis: false,
    testReactionsEnabled: false,
    fullscreenAutoHide: false,
    soundMuted: false,
    soundVolume: 0.5,
    flashTaskbarOnComplete: true,
    flashIntervalMs: 500,
    flashDurationMs: 2000,
    hideBubbles: false,
    permissionBubblesEnabled: true,
    notificationBubbleAutoCloseSeconds: 8,
    updateBubbleAutoCloseSeconds: 12,
    bubbleFollowPet: true,
    bubbleFollowPreference: "auto",
    bubbleFixedCorner: "bottom-right",
    sessionHudEnabled: true,
    sessionHudShowStateLabels: true,
    sessionHudShowElapsed: true,
    sessionHudShowContextUsage: true,
    sessionHudCleanupDetached: true,
    sessionHudShowQuota: true,
    quotaRingDisplayMode: "used",
    quotaMergeSources: false,
    quotaAlertsEnabled: true,
    quotaAlertThresholds: [20, 10],
    quotaRecoveryAlertsEnabled: true,
    sessionStaleMs: 600_000,
    workingStaleMs: 300_000,
    codexWorkingStaleMs: 1_200_000,
    detachedIdleStaleMs: 30_000,
    permissionAutomationMode: "off",
    permissionAutomationAutoToolsWarningDismissed: false,
    permissionAutomationUnattendedWarningDismissed: false,
    destructiveActionReminder: false,
    ...overrides,
  };
}

function createHarness({
  tab,
  snapshot,
  settingsAPI = {},
  platform = "Win32",
  localStorage = null,
} = {}) {
  const body = new FakeElement("body");
  const content = new FakeElement("main");
  content.id = "content";
  body.appendChild(content);
  const windowListeners = new Map();
  const document = {
    body,
    activeElement: body,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById(id) {
      if (id === "content") return content;
      return null;
    },
    addEventListener(type, cb) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(cb);
    },
    removeEventListener(type, cb) {
      const listeners = windowListeners.get(type);
      if (!listeners) return;
      const index = listeners.indexOf(cb);
      if (index !== -1) listeners.splice(index, 1);
    },
  };
  const updateCalls = [];
  const commandCalls = [];
  const api = {
    update: (key, value) => {
      updateCalls.push({ key, value });
      return Promise.resolve({ status: "ok" });
    },
    command: (action, payload) => {
      commandCalls.push({ action, payload });
      if (action === "telegramApproval.status") {
        return Promise.resolve({ status: "ok", state: { status: "stopped" } });
      }
      if (action === "telegramApproval.tokenInfo") {
        return Promise.resolve({ status: "ok", configured: false, masked: "" });
      }
      if (action === "feishuApproval.status") {
        return Promise.resolve({ status: "ok", state: { status: "stopped", secretsStored: false } });
      }
      if (action === "feishuApproval.secretInfo") {
        return Promise.resolve({ status: "ok", configured: false });
      }
      if (action === "slackNotify.status") {
        return Promise.resolve({ status: "ok", state: { status: "stopped" } });
      }
      if (action === "slackNotify.secretInfo") {
        return Promise.resolve({ status: "ok", configured: false });
      }
      if (action === "telegramMigration.snapshot") {
        return Promise.resolve({
          status: "ok",
          snapshot: { state: "", transport: "", revision: 0, testOrigin: "" },
        });
      }
      return Promise.resolve({ status: "ok" });
    },
    getPreviewSoundUrl: () => Promise.resolve(null),
    getMobileConnectionInfo: () => Promise.resolve({
      status: "ok", port: 23334, token: "test-token", lanIp: "127.0.0.1",
    }),
    getTextScaleContext: () => Promise.resolve({ percent: 100 }),
    getSizeContext: () => Promise.resolve({ ui: 50, synced: true, overMax: false }),
    getQuotaSourceCount: () => Promise.resolve(1),
    getQuotaRingProviders: () => Promise.resolve([]),
    getRoamFence: () => Promise.resolve({ status: "ok", active: false, fence: null }),
    openDashboard: () => {},
    ...settingsAPI,
  };
  const context = {
    console,
    navigator: { platform },
    localStorage: localStorage || { getItem: () => null, setItem: () => {} },
    document,
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    addEventListener(type, cb) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(cb);
    },
    removeEventListener(type, cb) {
      windowListeners.get(type)?.delete(cb);
    },
    window: null,
    globalThis: null,
    settingsAPI: api,
    ClawdSettingsSizeSlider: require("../src/settings-size-slider"),
    ClawdSettingsI18n: {
      STRINGS: loadI18n().STRINGS,
      CONTRIBUTORS: [],
      MAINTAINERS: [],
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(LANGUAGE_PICKER_JS, "utf8"), context);
  vm.runInContext(fs.readFileSync(ANIM_MERGE, "utf8"), context);
  vm.runInContext(fs.readFileSync(UI_CORE, "utf8"), context);
  for (const file of Object.values(TAB_FILES)) {
    vm.runInContext(fs.readFileSync(path.join(SRC_DIR, file), "utf8"), context);
  }
  // Remote-approval bodies are loaded separately: they are not part of
  // TAB_FILES (whose key ownership scan covers only the five split pages).
  vm.runInContext(fs.readFileSync(FEISHU_APPROVAL_RECIPIENT, "utf8"), context);
  vm.runInContext(fs.readFileSync(TELEGRAM_APPROVAL_TAB, "utf8"), context);
  vm.runInContext(fs.readFileSync(MOBILE_TAB, "utf8"), context);
  const core = context.ClawdSettingsCore;
  core.state.snapshot = snapshot || makeSnapshot();
  core.state.activeTab = tab;
  context.ClawdSettingsTabGeneral.init(core);
  context.ClawdSettingsTabPet.init(core);
  context.ClawdSettingsTabNotifications.init(core);
  context.ClawdSettingsTabSessions.init(core);
  context.ClawdSettingsTabPermissions.init(core);
  context.ClawdSettingsTabTelegramApproval.init(core);
  context.ClawdSettingsTabMobile.init(core);

  let contentRenderCount = 0;
  function render() {
    contentRenderCount++;
    core.ops.clearMountedControls();
    content.innerHTML = "";
    core.tabs[tab].render(content, core);
  }
  core.ops.installRenderHooks({ content: render });
  render();

  function apply(key, value) {
    core.ops.applyChanges({
      changes: { [key]: value },
      snapshot: { ...core.state.snapshot, [key]: value },
    });
  }

  return {
    core,
    content,
    tab,
    settingsAPI: api,
    updateCalls,
    commandCalls,
    render,
    apply,
    renderCount: () => contentRenderCount,
    getSwitch: (key) => core.state.mountedControls.generalSwitches.get(key)?.element || null,
    async settle() {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    },
  };
}

function sectionTitles(harness) {
  return harness.content.querySelectorAll(".section-title").map((node) => node.textContent);
}

function sectionRowLabels(harness) {
  return harness.content.querySelectorAll(".section").map((section) => (
    section.querySelectorAll(".row-label").map((node) => {
      const toggle = node.querySelector(".row-desc-toggle");
      const suffix = toggle ? toggle.textContent : "";
      return suffix && node.textContent.endsWith(suffix)
        ? node.textContent.slice(0, -suffix.length)
        : node.textContent;
    })
  ));
}

function activeValue(element) {
  const active = element.querySelectorAll("button")
    .find((button) => button.classList.contains("active"));
  return active ? active.dataset.value : null;
}

function getSelectedPickerValue(picker) {
  const selected = picker.querySelectorAll(".language-picker-option")
    .find((option) => option.classList.contains("selected"));
  return selected ? selected.dataset.lang : null;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function findRow(harness, labelKey) {
  const label = harness.core.helpers.t(labelKey);
  return harness.content.querySelectorAll(".row")
    .find((row) => {
      const node = row.querySelector(".row-label");
      return !!node && node.textContent === label;
    }) || null;
}

function findRowInput(harness, labelKey) {
  const row = findRow(harness, labelKey);
  return row ? row.querySelector("input") : null;
}

function readInPlaceKeys(moduleName) {
  const source = fs.readFileSync(path.join(SRC_DIR, TAB_FILES[moduleName]), "utf8");
  const match = source.match(/const\s+\w+_IN_PLACE_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, `${moduleName} should declare its in-place key set`);
  const keys = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  return { source, keys };
}

describe("settings tab split", () => {
  it("locks the key allocation of the five tabs", () => {
    const seen = new Map();
    for (const moduleName of Object.keys(TAB_FILES)) {
      const { source, keys } = readInPlaceKeys(moduleName);
      assert.deepStrictEqual([...keys].sort(), [...EXPECTED_KEYS[moduleName]].sort(), moduleName);
      for (const key of keys) {
        assert.ok(!seen.has(key), `${key} appears in both ${seen.get(key)} and ${moduleName}`);
        seen.set(key, moduleName);
      }
      for (const match of source.matchAll(/\bkey:\s*"([^"]+)"/g)) {
        assert.ok(keys.includes(match[1]), `${moduleName} renders ${match[1]} but does not patch it`);
      }
    }
    assert.deepStrictEqual([...seen.keys()].sort(), [...FROZEN_KEYS].sort());
  });

  it("renders the five pages in the planned section and row order", () => {
    const pet = createHarness({ tab: "pet", snapshot: makeSnapshot({ lang: "zh" }) });
    assert.deepStrictEqual(sectionTitles(pet), ["大小", "走动与位置", "反应"]);
    assert.deepStrictEqual(sectionRowLabels(pet), [
      ["大小", "跨显示器保持大小"],
      ["自由漫步", "移动方式", "活动范围", "允许贴靠屏幕边缘", "关闭极简模式", "全屏时自动隐藏"],
      ["测试结果动画"],
    ]);

    const notifications = createHarness({
      tab: "notifications",
      snapshot: makeSnapshot({ lang: "zh" }),
    });
    assert.deepStrictEqual(sectionTitles(notifications), ["声音", "托盘闪烁", "气泡"]);
    assert.deepStrictEqual(sectionRowLabels(notifications), [
      ["启用音效", "音量"],
      ["任务完成时闪烁系统托盘图标", "闪烁间隔", "闪烁时长"],
      ["隐藏气泡", "权限 / 交互气泡", "通知气泡", "更新气泡", "气泡位置", "优先方向", "固定角落"],
    ]);

    const sessions = createHarness({ tab: "sessions", snapshot: makeSnapshot({ lang: "zh" }) });
    assert.strictEqual(sessions.content.querySelectorAll(".section")[0].querySelector(".section-title"), null);
    assert.deepStrictEqual(sectionTitles(sessions), ["会话 HUD", "额度环与提醒", "高级"]);
    assert.deepStrictEqual(sectionRowLabels(sessions), [
      ["会话面板"],
      ["启用", "显示状态标签", "显示 HUD 时间", "显示上下文用量", "自动清理已分离会话"],
      ["显示额度环", "额度显示方式", "在桌宠旁显示", "合并多机额度", "额度快用完时提醒", "提醒时机", "额度恢复时也提醒", "测试通知"],
      ["超时清理", "会话超时（空闲）", "工作超时", "Codex 活跃任务超时", "终端关闭后清理延迟"],
    ]);

    const permissions = createHarness({
      tab: "permissions",
      snapshot: makeSnapshot({ lang: "zh" }),
    });
    assert.deepStrictEqual(sectionTitles(permissions), ["本机怎么处理", "按工具"]);
    assert.deepStrictEqual(sectionRowLabels(permissions), [
      ["权限请求处理", "自动放行前，危险命令先问我"],
      ["Codex 的审批归谁"],
    ]);
    const permissionPills = permissions.content.querySelector(".settings-tabs").querySelectorAll("button");
    assert.deepStrictEqual(permissionPills.map((button) => button.textContent), [
      "本机处理", "IM 渠道", "局域网审批",
    ]);

    const general = createHarness({
      tab: "general",
      platform: "MacIntel",
      snapshot: makeSnapshot({ lang: "zh" }),
    });
    assert.deepStrictEqual(sectionTitles(general), ["界面", "启动与系统"]);
    assert.deepStrictEqual(sectionRowLabels(general), [
      ["语言", "文字大小"],
      ["开机自启", "在菜单栏显示", "在 Dock 显示", "低功耗 idle", "工作时阻止休眠"],
    ]);
  });

  it("offers a restart only while the GPU switch differs from launch (#1183)", async () => {
    const general = createHarness({
      tab: "general",
      platform: "Win32",
      snapshot: makeSnapshot({ disableHardwareAcceleration: false }),
      settingsAPI: {
        getStartupRenderState: () => Promise.resolve({ hardwareAccelerationDisabled: false }),
      },
    });
    await general.settle();
    const row = () => general.core.state.mountedControls.generalSwitches
      .get("disableHardwareAcceleration").row;
    const restartButton = () => row().querySelectorAll("button")
      .find((button) => button.textContent === "Restart Clawd") || null;
    assert.ok(general.getSwitch("disableHardwareAcceleration"));
    assert.strictEqual(restartButton(), null);

    general.apply("disableHardwareAcceleration", true);
    await general.settle();
    assert.ok(restartButton(), "a pending GPU change shows the restart button");
    assert.ok(row().querySelectorAll(".row-desc-extra")
      .some((node) => node.textContent === "Not applied yet. Restart Clawd to switch."));

    restartButton().click();
    await general.settle();
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(general.commandCalls.filter((call) => call.action === "restartClawd"))),
      [{ action: "restartClawd", payload: { confirmed: true } }],
    );

    general.apply("disableHardwareAcceleration", false);
    await general.settle();
    assert.strictEqual(restartButton(), null, "switching back to the launch value hides it");
  });

  it("patches every independent sync branch in place for its own key", async () => {
    const textScaleContext = { percent: 100 };
    const general = createHarness({
      tab: "general",
      platform: "MacIntel",
      settingsAPI: { getTextScaleContext: () => Promise.resolve({ ...textScaleContext }) },
    });
    const textSlider = general.content.querySelector(".text-scale-slider");
    const openAtLogin = general.getSwitch("openAtLogin");
    textScaleContext.percent = 120;
    let before = general.renderCount();
    general.apply("textScale", 1.2);
    await general.settle();
    assert.strictEqual(general.renderCount(), before);
    assert.strictEqual(general.content.querySelector(".text-scale-slider"), textSlider);
    assert.strictEqual(textSlider.value, "120");
    textScaleContext.percent = 110;
    general.apply("textScaleByDisplay", { 1: 1.1 });
    await general.settle();
    assert.strictEqual(general.content.querySelector(".text-scale-slider"), textSlider);
    assert.strictEqual(textSlider.value, "110");
    assert.strictEqual(general.renderCount(), before);
    general.apply("openAtLogin", true);
    assert.strictEqual(general.getSwitch("openAtLogin"), openAtLogin);
    assert.strictEqual(openAtLogin.classList.contains("on"), true);
    assert.strictEqual(general.renderCount(), before);

    let sizeContextUi = 50;
    const pet = createHarness({
      tab: "pet",
      snapshot: makeSnapshot({ size: "P:9" }),
      settingsAPI: {
        getSizeContext: () => Promise.resolve({ ui: sizeContextUi, synced: false, overMax: false }),
      },
    });
    await pet.settle();
    const sizeSlider = pet.content.querySelector(".size-slider");
    const roam = pet.core.state.mountedControls.roamMovementStyle;
    const freeRoam = pet.getSwitch("freeRoam");
    before = pet.renderCount();
    sizeContextUi = 70;
    pet.apply("size", 70);
    await pet.settle();
    assert.strictEqual(pet.content.querySelector(".size-slider"), sizeSlider);
    assert.strictEqual(sizeSlider.value, "70");
    pet.apply("roamConstrainAxis", true);
    assert.strictEqual(activeValue(roam.element), "axis");
    pet.apply("freeRoam", true);
    assert.strictEqual(freeRoam.classList.contains("on"), true);
    pet.apply("allowEdgePinning", false);
    assert.strictEqual(pet.getSwitch("allowEdgePinning").classList.contains("on"), false);
    assert.strictEqual(pet.renderCount(), before);

    const notifications = createHarness({ tab: "notifications", snapshot: makeSnapshot() });
    const volume = notifications.core.state.mountedControls.soundVolume;
    const volumeSlider = volume.row.querySelector(".volume-slider");
    const soundSwitch = notifications.getSwitch("soundMuted");
    const flashInterval = notifications.core.state.mountedControls.sessionCleanupControls.get("flashIntervalMs");
    const flashDuration = notifications.core.state.mountedControls.sessionCleanupControls.get("flashDurationMs");
    const flashIntervalInput = flashInterval.row.querySelector("input");
    const flashDurationInput = flashDuration.row.querySelector("input");
    const notificationSeconds = notifications.core.state.mountedControls.bubblePolicyControls
      .get("notificationBubbleAutoCloseSeconds");
    const notificationSecondsInput = notificationSeconds.row.querySelector("input");
    const permissionPolicy = notifications.core.state.mountedControls.bubblePolicyControls
      .get("permissionBubblesEnabled");
    const permissionSwitch = permissionPolicy.row.querySelector(".switch");
    const placement = notifications.core.state.mountedControls.bubblePlacement;
    const placementModeElement = placement.modeControl.element;
    const hideBubbles = notifications.getSwitch("hideBubbles");
    before = notifications.renderCount();
    notifications.apply("soundVolume", 0.25);
    const currentVolumeSlider = notifications.content.querySelector(".volume-slider");
    assert.strictEqual(currentVolumeSlider, volumeSlider);
    assert.ok(notifications.content.contains(volumeSlider));
    assert.strictEqual(volumeSlider.value, "25");
    notifications.apply("soundMuted", true);
    assert.strictEqual(notifications.getSwitch("soundMuted"), soundSwitch);
    assert.ok(notifications.content.contains(soundSwitch));
    assert.strictEqual(soundSwitch.classList.contains("on"), false);
    notifications.apply("flashIntervalMs", 750);
    const currentFlashIntervalInput = findRowInput(notifications, "rowFlashInterval");
    assert.strictEqual(currentFlashIntervalInput, flashIntervalInput);
    assert.ok(notifications.content.contains(flashIntervalInput));
    assert.strictEqual(flashIntervalInput.value, "750");
    notifications.apply("flashDurationMs", 4000);
    const currentFlashDurationInput = findRowInput(notifications, "rowFlashDuration");
    assert.strictEqual(currentFlashDurationInput, flashDurationInput);
    assert.ok(notifications.content.contains(flashDurationInput));
    assert.strictEqual(flashDurationInput.value, "4000");
    notifications.apply("notificationBubbleAutoCloseSeconds", 5);
    const currentNotificationSecondsInput = findRowInput(notifications, "bubbleNotificationLabel");
    assert.strictEqual(currentNotificationSecondsInput, notificationSecondsInput);
    assert.ok(notifications.content.contains(notificationSecondsInput));
    assert.strictEqual(notificationSecondsInput.value, "5");
    notifications.apply("permissionBubblesEnabled", false);
    const currentPermissionSwitch = findRow(notifications, "bubblePermissionLabel").querySelector(".switch");
    assert.strictEqual(currentPermissionSwitch, permissionSwitch);
    assert.ok(notifications.content.contains(permissionSwitch));
    assert.strictEqual(permissionSwitch.classList.contains("on"), false);
    notifications.apply("bubbleFollowPet", false);
    const currentPlacementModeElement = notifications.content.querySelector(".bubble-placement-mode-segmented");
    assert.strictEqual(currentPlacementModeElement, placementModeElement);
    assert.ok(notifications.content.contains(placementModeElement));
    assert.strictEqual(activeValue(currentPlacementModeElement), "fixed");
    assert.strictEqual(placement.cornerRow.hidden, false);
    notifications.apply("hideBubbles", true);
    assert.strictEqual(notifications.getSwitch("hideBubbles"), hideBubbles);
    assert.ok(notifications.content.contains(hideBubbles));
    assert.strictEqual(hideBubbles.classList.contains("on"), true);
    assert.strictEqual(notifications.renderCount(), before);

    const sessions = createHarness({ tab: "sessions", snapshot: makeSnapshot() });
    const hudSwitch = sessions.getSwitch("sessionHudEnabled");
    const displayMode = sessions.core.state.mountedControls.quotaRingDisplayMode;
    const displayModeElement = displayMode.element;
    const thresholds = sessions.core.state.mountedControls.quotaAlertThresholds;
    const thresholdsRow = thresholds.row;
    const alertsSwitch = sessions.getSwitch("quotaAlertsEnabled");
    const staleInput = sessions.core.state.mountedControls.sessionCleanupControls.get("sessionStaleMs");
    const staleInputElement = staleInput.row.querySelector("input");
    const labelsSwitch = sessions.getSwitch("sessionHudShowStateLabels");
    before = sessions.renderCount();
    sessions.apply("sessionHudEnabled", false);
    assert.strictEqual(sessions.getSwitch("sessionHudEnabled"), hudSwitch);
    assert.ok(sessions.content.contains(hudSwitch));
    assert.strictEqual(hudSwitch.classList.contains("on"), false);
    sessions.apply("quotaRingDisplayMode", "remaining");
    const currentDisplayModeElement = sessions.content.querySelector(".quota-ring-display-mode-choice");
    assert.strictEqual(currentDisplayModeElement, displayModeElement);
    assert.ok(sessions.content.contains(displayModeElement));
    assert.strictEqual(activeValue(currentDisplayModeElement), "remaining");
    sessions.apply("quotaAlertThresholds", [50, 20, 10]);
    const currentThresholdsRow = findRow(sessions, "quotaThresholds");
    assert.strictEqual(currentThresholdsRow, thresholdsRow);
    assert.ok(sessions.content.contains(thresholdsRow));
    assert.match(currentThresholdsRow.querySelector(".language-picker-trigger").textContent, /50%/);
    sessions.apply("quotaAlertsEnabled", false);
    assert.strictEqual(sessions.getSwitch("quotaAlertsEnabled"), alertsSwitch);
    assert.ok(sessions.content.contains(alertsSwitch));
    assert.strictEqual(alertsSwitch.classList.contains("on"), false);
    assert.strictEqual(thresholdsRow.hidden, true);
    sessions.apply("sessionStaleMs", 900_000);
    const currentStaleInput = findRowInput(sessions, "rowStaleSession");
    assert.strictEqual(currentStaleInput, staleInputElement);
    assert.ok(sessions.content.contains(staleInputElement));
    assert.strictEqual(staleInputElement.value, "15");
    sessions.apply("sessionHudShowStateLabels", false);
    assert.strictEqual(sessions.getSwitch("sessionHudShowStateLabels"), labelsSwitch);
    assert.ok(sessions.content.contains(labelsSwitch));
    assert.strictEqual(labelsSwitch.classList.contains("on"), false);
    assert.strictEqual(sessions.renderCount(), before);

    const permissions = createHarness({ tab: "permissions", snapshot: makeSnapshot() });
    const automation = permissions.core.state.mountedControls.permissionAutomationMode;
    const automationElement = automation.element;
    const destructive = permissions.getSwitch("destructiveActionReminder");
    before = permissions.renderCount();
    permissions.apply("permissionAutomationMode", "auto-tools");
    const currentAutomationElement = permissions.content.querySelector(".permission-automation-segmented");
    assert.strictEqual(currentAutomationElement, automationElement);
    assert.ok(permissions.content.contains(automationElement));
    assert.strictEqual(activeValue(currentAutomationElement), "auto-tools");
    permissions.apply("destructiveActionReminder", true);
    assert.strictEqual(permissions.getSwitch("destructiveActionReminder"), destructive);
    assert.ok(permissions.content.contains(destructive));
    assert.strictEqual(destructive.classList.contains("on"), true);
    assert.strictEqual(permissions.renderCount(), before);

    for (const [tab, harness] of Object.entries({
      general: general,
      pet: pet,
      notifications: notifications,
      sessions: sessions,
      permissions: permissions,
    })) {
      const foreign = tab === "general" ? { size: 70 } : { textScale: 1.1 };
      assert.strictEqual(harness.core.tabs[tab].patchInPlace(foreign), false, tab);
    }
  });

  it("keeps the flattened linkage rules alive", async () => {
    const sessions = createHarness({
      tab: "sessions",
      snapshot: makeSnapshot({ sessionHudEnabled: false, quotaAlertsEnabled: false }),
      settingsAPI: { getQuotaSourceCount: () => Promise.resolve(2) },
    });
    await sessions.settle();
    for (const key of [
      "sessionHudShowStateLabels",
      "sessionHudShowElapsed",
      "sessionHudShowContextUsage",
      "sessionHudCleanupDetached",
    ]) {
      assert.strictEqual(sessions.getSwitch(key).classList.contains("disabled"), true, key);
    }
    const thresholdsRow = sessions.core.state.mountedControls.quotaAlertThresholds.row;
    const recoveryRow = sessions.getSwitch("quotaRecoveryAlertsEnabled").parentNode.parentNode;
    const testRow = sessions.content.querySelector(".quota-notification-test-row");
    for (const row of [thresholdsRow, recoveryRow, testRow]) assert.strictEqual(row.hidden, true);
    const mergeRow = sessions.getSwitch("quotaMergeSources").parentNode.parentNode;
    assert.strictEqual(mergeRow.style.display, "");

    sessions.apply("sessionHudEnabled", true);
    for (const key of [
      "sessionHudShowStateLabels",
      "sessionHudShowElapsed",
      "sessionHudShowContextUsage",
      "sessionHudCleanupDetached",
    ]) {
      assert.strictEqual(sessions.getSwitch(key).classList.contains("disabled"), false, key);
    }
    sessions.apply("quotaAlertsEnabled", true);
    for (const row of [thresholdsRow, recoveryRow, testRow]) assert.strictEqual(row.hidden, false);

    const singleSource = createHarness({
      tab: "sessions",
      snapshot: makeSnapshot({ quotaMergeSources: false }),
      settingsAPI: { getQuotaSourceCount: () => Promise.resolve(1) },
    });
    await singleSource.settle();
    assert.strictEqual(
      singleSource.getSwitch("quotaMergeSources").parentNode.parentNode.style.display,
      "none",
    );

    const enabledMerge = createHarness({
      tab: "sessions",
      snapshot: makeSnapshot({ quotaMergeSources: true }),
      settingsAPI: { getQuotaSourceCount: () => Promise.resolve(1) },
    });
    await enabledMerge.settle();
    assert.strictEqual(
      enabledMerge.getSwitch("quotaMergeSources").parentNode.parentNode.style.display,
      "",
    );

    const notifications = createHarness({
      tab: "notifications",
      snapshot: makeSnapshot({ soundMuted: true }),
    });
    const volumeSlider = notifications.core.state.mountedControls.soundVolume.row.querySelector(".volume-slider");
    assert.strictEqual(volumeSlider.disabled, true);
    notifications.apply("soundMuted", false);
    assert.strictEqual(volumeSlider.disabled, false);
    const placement = notifications.core.state.mountedControls.bubblePlacement;
    assert.strictEqual(placement.followRow.hidden, false);
    assert.strictEqual(placement.cornerRow.hidden, true);
    notifications.apply("bubbleFollowPet", false);
    assert.strictEqual(placement.followRow.hidden, true);
    assert.strictEqual(placement.cornerRow.hidden, false);
    notifications.apply("hideBubbles", true);
    for (const control of [placement.modeControl, placement.followControl, placement.cornerControl]) {
      assert.ok(control.element.querySelectorAll("button").every((button) => button.disabled));
    }

    const general = createHarness({
      tab: "general",
      platform: "MacIntel",
      snapshot: makeSnapshot({ showTray: true, showDock: false }),
    });
    assert.strictEqual(general.getSwitch("showTray").classList.contains("disabled"), true);
    assert.strictEqual(general.getSwitch("showDock").classList.contains("disabled"), false);
    general.apply("showDock", true);
    assert.strictEqual(general.getSwitch("showTray").classList.contains("disabled"), false);
    assert.strictEqual(general.getSwitch("showDock").classList.contains("disabled"), false);
    general.apply("showTray", false);
    assert.strictEqual(general.getSwitch("showDock").classList.contains("disabled"), true);
  });

  it("renders the three Permissions sub-pages from the shell and remote module", async () => {
    const harness = createHarness({
      tab: "permissions",
      snapshot: makeSnapshot({ lang: "zh" }),
    });
    const visiblePanel = () => harness.content.children.find((child) => (
      child.getAttribute("role") === "tabpanel" && !child.hidden
    ));
    const pills = () => harness.content.querySelector(".settings-tabs").querySelectorAll("button");

    assert.deepStrictEqual(pills().map((button) => button.textContent), [
      "本机处理", "IM 渠道", "局域网审批",
    ]);
    assert.deepStrictEqual(pills().map((button) => button.getAttribute("aria-selected")), [
      "true", "false", "false",
    ]);
    assert.deepStrictEqual(sectionTitles(harness), ["本机怎么处理", "按工具"]);

    pills()[1].click();
    await harness.settle();
    const heading = harness.content.children[0];
    const tabs = harness.content.querySelector(".settings-tabs");
    const channelsPanel = visiblePanel();
    assert.strictEqual(channelsPanel.children[0].className, "subtitle");
    assert.strictEqual(channelsPanel.children[0].textContent,
      "本机的权限气泡照常弹；接好渠道后，同一条请求也会发过去，哪边先点算哪边。密钥存在本机，不进 prefs。");
    assert.deepStrictEqual(channelsPanel.children.slice(1).map((child) => [
      child.classList.contains("tg-approval-channel-card"),
      child.classList.contains("feishu-approval-channel-card"),
      child.classList.contains("slack-notify-channel-card"),
    ]), [
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]);
    assert.strictEqual(harness.core.runtime.permissionsSubtab, "channels");

    pills()[2].click();
    await harness.settle();
    const lanPanel = visiblePanel();
    assert.strictEqual(lanPanel.children.length, 1);
    const mobileCard = lanPanel.querySelector(".mobile-channel-card");
    assert.ok(mobileCard, "the LAN sub-page renders the mobile card");
    assert.ok(mobileCard.querySelectorAll(".row-label")
      .some((row) => row.textContent.startsWith(harness.core.helpers.t("mobileChannelName"))),
    "the LAN card contains the header drawn by settings-tab-mobile.js");
    assert.strictEqual(harness.core.runtime.permissionsSubtab, "lan");

    pills()[0].click();
    await harness.settle();
    assert.deepStrictEqual(sectionTitles(harness), ["本机怎么处理", "按工具"]);
    assert.strictEqual(harness.core.runtime.permissionsSubtab, "local");
    assert.strictEqual(harness.content.children[0], heading);
    assert.strictEqual(harness.content.querySelector(".settings-tabs"), tabs);
  });

  it("cleans Feishu lookup UI only when leaving IM channels or the tab", async () => {
    let lookup;
    const calls = [];
    const command = (action, payload) => {
      calls.push({ action, payload });
      if (action === "telegramApproval.status") {
        return Promise.resolve({ status: "ok", state: { status: "stopped" } });
      }
      if (action === "telegramApproval.tokenInfo") {
        return Promise.resolve({ status: "ok", configured: false, masked: "" });
      }
      if (action === "feishuApproval.status") {
        return Promise.resolve({ status: "ok", state: {
          status: "stopped", secretsStored: true, secretsConfigured: true,
          credentialReady: true, credentialReason: "",
          configurationReady: false, setupReason: "missing-approver",
        } });
      }
      if (action === "feishuApproval.secretInfo") {
        return Promise.resolve({
          status: "ok", configured: true, credentialPlatform: "feishu", appId: "cli_......saved",
        });
      }
      if (action === "feishuApproval.saveApproverByEmail") {
        lookup = createDeferred();
        return lookup.promise;
      }
      if (action === "feishuApproval.cancelApproverLookup") return Promise.resolve({ status: "ok" });
      if (action === "slackNotify.status") {
        return Promise.resolve({ status: "ok", state: { status: "stopped" } });
      }
      if (action === "slackNotify.secretInfo") {
        return Promise.resolve({ status: "ok", configured: false });
      }
      if (action === "telegramMigration.snapshot") {
        return Promise.resolve({
          status: "ok",
          snapshot: { state: "", transport: "", revision: 0, testOrigin: "" },
        });
      }
      return Promise.resolve({ status: "ok" });
    };
    const harness = createHarness({
      tab: "permissions",
      snapshot: makeSnapshot({
        lang: "en",
        tgApproval: { enabled: false, allowedTgUserId: "", targetSessionKey: "" },
        feishuApproval: {
          enabled: false,
          platform: "feishu",
          idType: "open_id",
          approverId: "",
          connectionTimeoutSeconds: 15,
        },
      }),
      settingsAPI: { command },
    });
    const cancelCount = () => calls.filter((call) => call.action === "feishuApproval.cancelApproverLookup").length;
    const pill = (labelKey) => harness.content.querySelectorAll("button")
      .find((button) => button.textContent === harness.core.helpers.t(labelKey));
    const startLookup = () => {
      const card = harness.content.querySelector(".feishu-approval-channel-card");
      const input = card.querySelectorAll("input").at(-1);
      input.value = "leave@example.com";
      input.dispatchEvent({ type: "input" });
      card.querySelectorAll("button")
        .find((button) => button.textContent === harness.core.helpers.t("feishuApprovalSaveApprover"))
        .click();
    };

    pill("permissionsSubtabChannels").click();
    await harness.settle();
    startLookup();
    await harness.settle();
    assert.ok(lookup, "the lookup is in flight");

    pill("permissionsSubtabLocal").click();
    await harness.settle();
    assert.strictEqual(cancelCount(), 1);

    pill("permissionsSubtabLan").click();
    await harness.settle();
    assert.strictEqual(cancelCount(), 1, "local to LAN does not clean up again");

    pill("permissionsSubtabChannels").click();
    await harness.settle();
    startLookup();
    await harness.settle();
    pill("permissionsSubtabLocal").click();
    await harness.settle();
    assert.strictEqual(cancelCount(), 2);

    pill("permissionsSubtabChannels").click();
    await harness.settle();
    startLookup();
    await harness.settle();
    harness.core.tabs.permissions.onExit();
    assert.strictEqual(cancelCount(), 3, "leaving the tab also cancels the lookup");
  });

  it("only repaints remote channel status while the IM or LAN body is visible", async () => {
    const harness = createHarness({ tab: "permissions", snapshot: makeSnapshot() });
    const pills = () => harness.content.querySelector(".settings-tabs").querySelectorAll("button");

    pills()[1].click();
    await harness.settle();
    pills()[0].click();
    await harness.settle();
    let baseline = harness.renderCount();

    harness.core.tabs.permissions.refreshRuntimeStatus({ channel: "telegram" });
    await harness.settle();
    assert.strictEqual(harness.renderCount(), baseline, "local sub-page does not repaint");

    pills()[1].click();
    await harness.settle();
    baseline = harness.renderCount();
    harness.core.state.activeTab = "general";
    harness.core.tabs.permissions.refreshRuntimeStatus({ channel: "telegram" });
    await harness.settle();
    assert.strictEqual(harness.renderCount(), baseline, "another tab does not repaint");

    harness.core.state.activeTab = "permissions";
    harness.core.tabs.permissions.refreshRuntimeStatus({ channel: "telegram" });
    await harness.settle();
    assert.strictEqual(harness.renderCount(), baseline + 1, "visible IM channels repaint once");
  });

  it("routes local and remote in-place patches to their owning module", async () => {
    const harness = createHarness({
      tab: "permissions",
      snapshot: makeSnapshot({
        feishuApproval: {
          enabled: false,
          platform: "feishu",
          idType: "open_id",
          approverId: "ou_1",
          approverSource: "manual",
          connectionTimeoutSeconds: 15,
        },
      }),
      settingsAPI: {
        command: (action) => {
          if (action === "telegramApproval.status") {
            return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
          }
          if (action === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: false, masked: "" });
          }
          if (action === "feishuApproval.status") {
            return Promise.resolve({ status: "ok", state: {
              status: "stopped", configured: true, secretsStored: true,
              secretsConfigured: true, credentialReady: true, credentialReason: "",
              configurationReady: true, setupReason: "",
            } });
          }
          if (action === "feishuApproval.secretInfo") {
            return Promise.resolve({ status: "ok", configured: true, credentialPlatform: "feishu", appId: "cli_saved" });
          }
          if (action === "slackNotify.status") {
            return Promise.resolve({ status: "ok", state: { status: "stopped" } });
          }
          if (action === "slackNotify.secretInfo") {
            return Promise.resolve({ status: "ok", configured: false });
          }
          if (action === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: { state: "", transport: "", revision: 0, testOrigin: "" },
            });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    const local = harness.core.state.mountedControls.permissionAutomationMode;
    harness.apply("permissionAutomationMode", "auto-tools");
    assert.strictEqual(local.element, harness.core.state.mountedControls.permissionAutomationMode.element);
    assert.strictEqual(activeValue(local.element), "auto-tools");

    const pills = () => harness.content.querySelector(".settings-tabs").querySelectorAll("button");
    pills()[1].click();
    await harness.settle();
    const select = harness.content.querySelector(".feishu-approval-timeout-select");
    assert.strictEqual(getSelectedPickerValue(select), "15");

    const previousSnapshot = harness.core.state.snapshot;
    const nextSnapshot = {
      ...previousSnapshot,
      feishuApproval: { ...previousSnapshot.feishuApproval, connectionTimeoutSeconds: 30 },
    };
    harness.core.state.snapshot = nextSnapshot;
    assert.strictEqual(harness.core.tabs.permissions.patchInPlace(
      { feishuApproval: nextSnapshot.feishuApproval },
      { previousSnapshot, snapshot: nextSnapshot },
    ), true);
    assert.strictEqual(harness.content.querySelector(".feishu-approval-timeout-select"), select);
    assert.strictEqual(getSelectedPickerValue(select), "30");

    const otherFieldSnapshot = {
      ...nextSnapshot,
      feishuApproval: { ...nextSnapshot.feishuApproval, enabled: true },
    };
    assert.strictEqual(harness.core.tabs.permissions.patchInPlace(
      { feishuApproval: otherFieldSnapshot.feishuApproval },
      { previousSnapshot: nextSnapshot, snapshot: otherFieldSnapshot },
    ), false, "the context is forwarded unchanged to the remote module");

    assert.strictEqual(harness.core.tabs.permissions.patchInPlace(
      { textScale: 1.1 },
      { previousSnapshot, snapshot: { ...nextSnapshot, textScale: 1.1 } },
    ), false);
  });

  it("keeps the sidebar, deep-link whitelist, and icons in sync", () => {
    const rendererSource = fs.readFileSync(RENDERER, "utf8");
    const sidebarMatch = rendererSource.match(/const SIDEBAR_TABS = \[([\s\S]*?)\n\];/);
    assert.ok(sidebarMatch);
    const sidebarEntries = sidebarMatch[1].split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{ id:"))
      .map((line) => ({
        id: /id: "([^"]+)"/.exec(line)[1],
        groupStart: /groupStart: true/.test(line),
      }));
    assert.deepStrictEqual(sidebarEntries.map((entry) => entry.id), [
      "general",
      "pet",
      "notifications",
      "sessions",
      "permissions",
      "agents",
      "remote-ssh",
      "discord-presence",
      "theme",
      "animOverrides",
      "shortcuts",
      "recap",
      "about",
    ]);
    assert.deepStrictEqual(
      sidebarEntries.filter((entry) => entry.groupStart).map((entry) => entry.id),
      ["agents", "theme", "recap"],
    );

    const windowSource = fs.readFileSync(WINDOW_SOURCE, "utf8");
    const allowedMatch = windowSource.match(/const ALLOWED_TABS = new Set\(\[([\s\S]*?)\]\);/);
    assert.ok(allowedMatch);
    const allowed = [...allowedMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    assert.deepStrictEqual([...allowed].sort(), sidebarEntries.map((entry) => entry.id).sort());

    const icons = loadIcons();
    const placeholder = icons.getIcon("placeholder");
    for (const entry of sidebarEntries) {
      assert.notStrictEqual(icons.getIcon(entry.id), placeholder, `${entry.id} needs its own icon`);
    }
    assert.deepStrictEqual(
      Object.keys(icons.ICONS).filter((id) => id !== "placeholder").sort(),
      sidebarEntries.map((entry) => entry.id).sort(),
    );
  });

  it("restores old navigation state and falls back for unknown ids", () => {
    function loadCore(savedState) {
      const context = {
        console,
        navigator: { platform: "Win32" },
        localStorage: {
          getItem: () => savedState,
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
        settingsAPI: {},
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
        ClawdSettingsI18n: { STRINGS: { en: {} }, CONTRIBUTORS: [], MAINTAINERS: [] },
      };
      context.window = context;
      context.globalThis = context;
      vm.createContext(context);
      vm.runInContext(fs.readFileSync(ANIM_MERGE, "utf8"), context);
      vm.runInContext(fs.readFileSync(UI_CORE, "utf8"), context);
      return context.ClawdSettingsCore;
    }

    const old = loadCore(JSON.stringify({ activeTab: "general", scrollPositions: {} }));
    old.tabs.general = {};
    old.tabs.pet = {};
    assert.strictEqual(old.ops.restoreNavigationState(), true);
    assert.strictEqual(old.state.activeTab, "general");

    const unknown = loadCore(JSON.stringify({ activeTab: "no-such-tab", scrollPositions: {} }));
    unknown.tabs.general = {};
    unknown.state.activeTab = "general";
    assert.strictEqual(unknown.ops.restoreNavigationState(), true);
    assert.strictEqual(unknown.state.activeTab, "general");

    const legacy = loadCore(JSON.stringify({ activeTab: "telegram-approval", scrollPositions: {} }));
    legacy.tabs.general = {};
    legacy.tabs.permissions = {};
    assert.strictEqual(legacy.ops.restoreNavigationState(), true);
    assert.strictEqual(legacy.state.activeTab, "permissions");
    assert.strictEqual(legacy.runtime.persistedSettingsTab, "permissions");
    assert.strictEqual(legacy.runtime.permissionsSubtab, "channels");

    const permissions = loadCore(JSON.stringify({ activeTab: "permissions", scrollPositions: {} }));
    permissions.tabs.permissions = {};
    permissions.state.activeTab = "general";
    assert.strictEqual(permissions.ops.restoreNavigationState(), true);
    assert.strictEqual(permissions.state.activeTab, "permissions");
    assert.strictEqual(permissions.runtime.permissionsSubtab, "local");
  });

  it("wires the deep-link receiver for sessions and recap only", () => {
    const source = fs.readFileSync(RENDERER, "utf8");
    const initStart = source.indexOf("globalThis.ClawdSettingsTabGeneral.init(core);");
    const wiringStart = source.indexOf("core.ops.restoreNavigationState();");
    const slice = source.slice(0, initStart) + source.slice(wiringStart);

    function run(consumeTab) {
      const selected = [];
      let requestedCallback = null;
      const core = {
        state: { activeTab: "general" },
        helpers: {
          t: (key) => key,
          escapeHtml: (value) => value,
          buildTabs: () => ({
            element: new FakeElement("div"),
            panels: new Map(),
            dispose() {},
            setValue() {},
          }),
        },
        ops: {
          installRenderHooks() {},
          restoreNavigationState() {},
          persistNavigationState() {},
          selectTab(tab, options) {
            selected.push([tab, options]);
          },
        },
        tabs: {},
      };
      const windowObject = {
        addEventListener() {},
        settingsAPI: {
          onRequestedTab(cb) {
            requestedCallback = cb;
          },
          consumeRequestedTab() {
            return consumeTab;
          },
          onChanged() {},
          onAgentActivity() {},
          onRecapChanged() {},
          onAnimationPreviewPosterReady() {},
          onShortcutRecordKey() {},
          onShortcutFailuresChanged() {},
          onRemoteApprovalStatusChanged() {},
          onUpdateCheckStatus() {},
          onOfficialThemeProgress() {},
        },
      };
      const document = {
        title: "",
        getElementById: () => null,
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (value) => {
      const node = new FakeElement("#text");
      node.textContent = String(value || "");
      return node;
    },
      };
      vm.runInNewContext(slice, {
        ClawdSettingsCore: core,
        ClawdSettingsIcons: loadIcons(),
        window: windowObject,
        document,
        globalThis: { ClawdSettingsCore: core, ClawdSettingsIcons: loadIcons() },
      });
      return { selected, requestedCallback };
    }

    const sessions = run("sessions");
    assert.deepEqual(sessions.selected, [["sessions", { persist: false }]]);
    sessions.requestedCallback("sessions");
    sessions.requestedCallback("recap");
    sessions.requestedCallback("agents");
    assert.deepEqual(sessions.selected, [
      ["sessions", { persist: false }],
      ["sessions", { persist: false }],
      ["recap", { persist: false }],
    ]);

    const recap = run("recap");
    assert.deepEqual(recap.selected, [["recap", { persist: false }]]);

    const agents = run("agents");
    assert.deepEqual(agents.selected, []);
  });

  it("saves the sound toggle optimistically and rolls back noop / failure / rejection", async () => {
    const updateCalls = [];
    const harness = createHarness({
      tab: "notifications",
      snapshot: makeSnapshot({ soundMuted: false, soundVolume: 1 }),
      settingsAPI: {
        update: (key, value) => {
          updateCalls.push({ key, value });
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    const toasts = [];
    harness.core.ops.showToast = (message, options) => toasts.push({ message, options });
    const sound = harness.getSwitch("soundMuted");
    sound.eventListeners.click[0]({ stopPropagation() {}, preventDefault() {} });
    assert.strictEqual(sound.classList.contains("on"), false);
    assert.strictEqual(sound.classList.contains("pending"), true);
    assert.deepStrictEqual(updateCalls, [{ key: "soundMuted", value: true }]);
    sound.eventListeners.click[0]({ stopPropagation() {}, preventDefault() {} });
    assert.deepStrictEqual(updateCalls, [{ key: "soundMuted", value: true }]);
    await harness.settle();
    assert.strictEqual(sound.classList.contains("pending"), false);
    assert.deepStrictEqual(toasts, []);

    for (const scenario of [
      { run: () => Promise.resolve({ status: "ok", noop: true }), noop: true },
      { run: () => Promise.resolve({ status: "error", message: "boom" }), noop: false },
      { run: () => Promise.reject(new Error("boom")), noop: false },
    ]) {
      const localToasts = [];
      const localHarness = createHarness({
        tab: "notifications",
        snapshot: makeSnapshot({ soundMuted: false, soundVolume: 1 }),
        settingsAPI: { update: scenario.run },
      });
      localHarness.core.ops.showToast = (message, options) => localToasts.push({ message, options });
      const localSwitch = localHarness.getSwitch("soundMuted");
      localSwitch.eventListeners.click[0]({ stopPropagation() {}, preventDefault() {} });
      await localHarness.settle();
      assert.strictEqual(localSwitch.classList.contains("on"), true);
      assert.strictEqual(localSwitch.classList.contains("pending"), false);
      if (scenario.noop) {
        assert.deepStrictEqual(localToasts, []);
      } else {
        assert.strictEqual(localToasts.length, 1);
        assert.strictEqual(localToasts[0].options.error, true);
      }
      assert.strictEqual(localHarness.core.state.transientUiState.generalSwitches.has("soundMuted"), false);
    }
  });
});
