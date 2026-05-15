"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const SETTINGS_HTML = path.join(SRC_DIR, "settings.html");
const SETTINGS_CSS = path.join(SRC_DIR, "settings.css");
const SETTINGS_RENDERER = path.join(SRC_DIR, "settings-renderer.js");
const SETTINGS_UI_CORE = path.join(SRC_DIR, "settings-ui-core.js");
const SETTINGS_ANIM_OVERRIDES_MERGE = path.join(SRC_DIR, "settings-anim-overrides-merge.js");
const SETTINGS_I18N = path.join(SRC_DIR, "settings-i18n.js");
const SETTINGS_DOCTOR_MODAL = path.join(SRC_DIR, "settings-doctor-modal.js");
const SETTINGS_ANIMATION_PREVIEW = path.join(SRC_DIR, "settings-animation-preview.html");
const PRELOAD_SETTINGS = path.join(SRC_DIR, "preload-settings.js");
const MAIN_PROCESS = path.join(SRC_DIR, "main.js");
const SETTINGS_IPC = path.join(SRC_DIR, "settings-ipc.js");
const DOCTOR_IPC = path.join(SRC_DIR, "doctor-ipc.js");
const { SUPPORTED_LANGS } = require("../src/i18n");
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

function loadSettingsI18nForTest() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SETTINGS_I18N, "utf8"), context);
  return context.ClawdSettingsI18n.STRINGS;
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

  set innerHTML(_value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    const html = String(_value || "");
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
        const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
        child.setAttribute(attrName, attrValue);
      }
      stack[stack.length - 1].appendChild(child);
      const voidTag = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tagName);
      if (!full.endsWith("/>") && !voidTag) stack.push(child);
    }
  }

  get innerHTML() {
    return "";
  }

  _matches(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
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

function loadGeneralLanguageRowForTest({
  snapshot,
  update = () => Promise.resolve({ status: "ok" }),
} = {}) {
  const raf = createQueuedRaf();
  const body = new FakeElement("body");
  const content = new FakeElement("main");
  content.id = "content";
  body.appendChild(content);
  const toastStack = new FakeElement("div");
  toastStack.id = "toastStack";
  body.appendChild(toastStack);

  const documentListeners = new Map();
  const document = {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById(id) {
      if (id === "content") return content;
      if (id === "toastStack") return toastStack;
      return null;
    },
    addEventListener(type, cb) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(cb);
    },
    removeEventListener(type, cb) {
      const listeners = documentListeners.get(type);
      if (!listeners) return;
      const index = listeners.indexOf(cb);
      if (index !== -1) listeners.splice(index, 1);
    },
  };

  const updateCalls = [];
  const settingsAPI = {
    update: (key, value) => {
      updateCalls.push({ key, value });
      return update(key, value);
    },
  };
  const context = {
    console,
    navigator: { platform: "Win32" },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    document,
    requestAnimationFrame: (cb) => raf.requestAnimationFrame(cb),
    setTimeout: () => 1,
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
      STRINGS: {
        en: {
          rowLanguage: "Language",
          rowLanguageDesc: "Language desc",
          langEnglish: "English",
          langChinese: "Chinese",
          langKorean: "Korean",
          langJapanese: "Japanese",
          toastSaveFailed: "Failed: ",
        },
        zh: {
          rowLanguage: "Language",
          rowLanguageDesc: "Language desc",
          langEnglish: "English",
          langChinese: "Chinese",
          langKorean: "Korean",
          langJapanese: "Japanese",
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
  const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8")
    .replace(
      "root.ClawdSettingsTabGeneral = { init };",
      "root.ClawdSettingsTabGeneral = { init, __test: { buildLanguageRow } };"
    );
  vm.runInContext(generalSource, context);

  const core = context.ClawdSettingsCore;
  core.state.snapshot = snapshot || { lang: "en" };
  core.state.activeTab = "general";
  context.ClawdSettingsTabGeneral.init(core);

  let contentRenderCount = 0;
  function renderLanguageOnly() {
    contentRenderCount++;
    core.ops.clearMountedControls();
    content.innerHTML = "";
    content.appendChild(context.ClawdSettingsTabGeneral.__test.buildLanguageRow());
  }
  core.ops.installRenderHooks({ content: renderLanguageOnly });

  return {
    core,
    content,
    raf,
    settingsAPI,
    updateCalls,
    getContentRenderCount: () => contentRenderCount,
    getLangPicker: () => content.querySelector(".language-picker"),
    getLangTrigger: () => content.querySelector(".language-picker-trigger"),
    getLangMenu: () => content.querySelector(".language-picker-menu"),
    getLangValue: () => content.querySelector(".language-picker-value"),
    getLangOptions: () => content.querySelectorAll(".language-picker-option"),
    getDocumentListenerCount: (type) => {
      const listeners = documentListeners.get(type);
      return listeners ? listeners.length : 0;
    },
    getToastText: () => {
      const toast = toastStack.querySelector(".toast");
      return toast ? toast.textContent : "";
    },
  };
}

function loadGeneralTabForTest({
  snapshot,
  settingsAPI = {},
} = {}) {
  const body = new FakeElement("body");
  const content = new FakeElement("main");
  content.id = "content";
  body.appendChild(content);

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
      getItem: () => null,
      setItem: () => {},
    },
    document,
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    getComputedStyle: () => ({
      getPropertyValue: () => "",
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    window: null,
    globalThis: null,
    settingsAPI: {
      update: () => Promise.resolve({ status: "ok" }),
      command: () => Promise.resolve({ status: "ok" }),
      getPreviewSoundUrl: () => Promise.resolve(null),
      openDashboard: () => {},
      ...settingsAPI,
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
      createSizeSliderController: () => ({
        syncFromSnapshot: () => {},
        dispose: () => {},
        pointerDown: () => {},
        pointerUp: () => {},
        pointerCancel: () => {},
        blur: () => {},
        input: () => {},
        change: () => {},
      }),
    },
    ClawdSettingsI18n: {
      STRINGS: loadSettingsI18nForTest(),
      CONTRIBUTORS: [],
      MAINTAINERS: [],
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SETTINGS_ANIM_OVERRIDES_MERGE, "utf8"), context);
  vm.runInContext(fs.readFileSync(SETTINGS_UI_CORE, "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8"), context);

  const core = context.ClawdSettingsCore;
  core.state.snapshot = snapshot || {};
  core.state.activeTab = "general";
  context.ClawdSettingsTabGeneral.init(core);

  let contentRenderCount = 0;
  function renderContent() {
    contentRenderCount++;
    core.ops.clearMountedControls();
    content.innerHTML = "";
    core.tabs.general.render(content, core);
  }
  core.ops.installRenderHooks({ content: renderContent });

  return {
    core,
    content,
    renderContent,
    getContentRenderCount: () => contentRenderCount,
    getSwitchMeta: (key) => core.state.mountedControls.generalSwitches.get(key) || null,
    getSwitch: (key) => {
      const meta = core.state.mountedControls.generalSwitches.get(key);
      return meta ? meta.element : null;
    },
  };
}

function makeGeneralSnapshot(overrides = {}) {
  return {
    lang: "en",
    size: 50,
    sessionHudEnabled: true,
    sessionHudShowElapsed: true,
    sessionHudCleanupDetached: true,
    soundMuted: false,
    soundVolume: 0.5,
    lowPowerIdleMode: false,
    allowEdgePinning: true,
    keepSizeAcrossDisplays: true,
    manageClaudeHooksAutomatically: true,
    openAtLogin: false,
    autoStartWithClaude: false,
    hideBubbles: false,
    bubbleFollowPet: true,
    permissionBubblesEnabled: true,
    notificationBubbleAutoCloseSeconds: 8,
    updateBubbleAutoCloseSeconds: 12,
    ...overrides,
  };
}

function createKeyboardEventForTest(key) {
  return {
    type: "keydown",
    key,
    bubbles: true,
    cancelBubble: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  };
}

function findAncestorByClass(el, className) {
  let current = el;
  while (current) {
    if (current.classList && current.classList.contains(className)) return current;
    current = current.parentNode;
  }
  return null;
}

function loadThemeTabForTest({
  themes,
  settingsAPI = {},
} = {}) {
  const body = new FakeElement("body");
  const content = new FakeElement("main");
  content.id = "content";
  body.appendChild(content);

  const commands = [];
  const document = {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById(id) {
      if (id === "content") return content;
      return null;
    },
  };

  const api = {
    command: (name, payload) => {
      commands.push({ name, payload });
      return Promise.resolve({ status: "ok" });
    },
    ...settingsAPI,
  };
  const context = {
    console,
    navigator: { platform: "Win32" },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    document,
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    window: null,
    globalThis: null,
    settingsAPI: api,
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
      STRINGS: loadSettingsI18nForTest(),
      CONTRIBUTORS: [],
      MAINTAINERS: [],
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SETTINGS_ANIM_OVERRIDES_MERGE, "utf8"), context);
  vm.runInContext(fs.readFileSync(SETTINGS_UI_CORE, "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, "settings-tab-theme.js"), "utf8"), context);

  const core = context.ClawdSettingsCore;
  core.state.snapshot = { lang: "en" };
  core.state.activeTab = "theme";
  core.runtime.themeList = Array.isArray(themes) ? themes : [];
  context.ClawdSettingsTabTheme.init(core);
  core.tabs.theme.render(content, core);

  return { content, commands };
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
          eventSourceExtension: "Extension",
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

function loadAnimMapTabForTest({
  snapshot,
} = {}) {
  const body = new FakeElement("body");
  const content = new FakeElement("main");
  body.appendChild(content);

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
      getItem: () => null,
      setItem: () => {},
    },
    document,
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
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
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-map.js"), "utf8"), context);

  const core = context.ClawdSettingsCore;
  core.state.snapshot = snapshot || { theme: "clawd", themeOverrides: {} };
  core.state.activeTab = "animMap";
  context.ClawdSettingsTabAnimMap.init(core);

  let contentRenderCount = 0;
  core.ops.installRenderHooks({
    content: () => {
      contentRenderCount++;
    },
  });

  return {
    core,
    content,
    getContentRenderCount: () => contentRenderCount,
  };
}

function loadAnimOverridesTabForTest({
  runtime,
  modalRoot,
  settingsAPI = {},
  opsOverrides = {},
  readersOverrides = {},
  helpersOverrides = {},
}) {
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
        ...settingsAPI,
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
      createDisclosureChevron: (className) => {
        const chevron = document.createElement("span");
        chevron.className = className;
        chevron.setAttribute("aria-hidden", "true");
        return chevron;
      },
      attachActivation: (el, invoke) => {
        if (typeof invoke === "function") el.addEventListener("click", () => invoke());
        return el;
      },
      ...helpersOverrides,
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
      ...opsOverrides,
    },
    i18n: {
      STRINGS: { en: {} },
    },
    readers: {
      hasAnyThemeOverride: () => false,
      readThemeOverrideMap: () => null,
      getLang: () => "en",
      ...readersOverrides,
    },
    renderHooks: {},
    tabs: {},
  };
  context.ClawdSettingsTabAnimOverrides.init(core);
  return { core, document };
}

function createAnimOverrideCard(overrides = {}) {
  return {
    id: "state:thinking",
    slotType: "state",
    stateKey: "thinking",
    triggerKind: "thinking",
    currentFile: "cloudling-thinking.svg",
    currentFileUrl: "file:///themes/cloudling/assets/cloudling-thinking.svg",
    currentFilePreviewUrl: "file:///themes/cloudling/assets/cloudling-thinking.svg",
    bindingLabel: "states.thinking[0]",
    transition: { in: 120, out: 180 },
    supportsAutoReturn: false,
    supportsDuration: false,
    assetCycleMs: 1000,
    assetCycleStatus: "ok",
    suggestedDurationMs: null,
    suggestedDurationStatus: "unavailable",
    previewDurationMs: 1000,
    displayHintWarning: false,
    displayHintTarget: null,
    fallbackTargetState: null,
    wideHitboxEnabled: false,
    wideHitboxOverridden: false,
    wideHitboxThemeDefault: false,
    aspectRatioWarning: null,
    ...overrides,
  };
}

function createAnimOverridesRuntime(card, overrides = {}) {
  return {
    animationOverridesData: {
      theme: { id: "cloudling", name: "Cloudling" },
      assets: [],
      sections: [{ id: "work", cards: [card] }],
      cards: [card],
      sounds: [],
    },
    animOverridesSubtab: "animations",
    expandedOverrideRowIds: new Set([card.id]),
    assetPicker: {
      state: null,
      pollTimer: null,
    },
    ...overrides,
  };
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
      "settings-tab-remote-ssh.js",
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
    assert.ok(html.includes('<link rel="stylesheet" href="settings.css">'));
    assert.ok(html.includes("style-src 'self' 'unsafe-inline'"));
    assert.ok(!html.includes("<style>"));
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
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const rendererSource = fs.readFileSync(SETTINGS_RENDERER, "utf8");
    const doctorModalSource = fs.readFileSync(SETTINGS_DOCTOR_MODAL, "utf8");
    const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
    const mainSource = fs.readFileSync(MAIN_PROCESS, "utf8");
    const doctorIpcSource = fs.readFileSync(DOCTOR_IPC, "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");

    assert.ok(html.includes('<script src="settings-doctor-modal.js"></script>'));
    assert.ok(css.includes(".doctor-indicator"));
    assert.ok(css.includes(".doctor-modal"));
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
    assert.ok(doctorModalSource.includes("actionNotice"));
    assert.ok(doctorModalSource.includes("actionNoticeTimer"));
    assert.ok(doctorModalSource.includes("checkExpansionOverrides"));
    assert.ok(doctorModalSource.includes("checksLoading"));
    assert.ok(doctorModalSource.includes("connectionRunId"));
    assert.ok(doctorModalSource.includes("repairRunId"));
    assert.ok(doctorModalSource.includes("modalEntering"));
    assert.ok(doctorModalSource.includes("clearModalEnteringTimer"));
    assert.ok(doctorModalSource.includes("startModalEntering"));
    assert.ok(doctorModalSource.includes("showActionNotice"));
    assert.ok(doctorModalSource.includes("if (state.modalOpen)"));
    assert.ok(doctorModalSource.includes("core.ops.showToast"));
    assert.ok(!doctorModalSource.includes("core.helpers.showToast"));
    assert.ok(doctorModalSource.includes("agentDetailText"));
    assert.ok(doctorModalSource.includes("startConnectionTest"));
    assert.ok(doctorModalSource.includes("stopConnectionCountdown();"));
    assert.ok(doctorModalSource.includes('class="doctor-title-row"'));
    assert.ok(doctorModalSource.includes("renderLocalServerCheck"));
    assert.ok(doctorModalSource.includes("doctor-local-server-main"));
    assert.ok(doctorModalSource.includes('class="doctor-check-summary" title='));
    assert.ok(doctorModalSource.includes('const fullDetail = detail && cls !== "pass"'));
    assert.ok(doctorModalSource.includes("renderAgentIntegrationCheck"));
    assert.ok(doctorModalSource.includes("doctor-agent-collapsible"));
    assert.ok(doctorModalSource.includes("doctor-agent-chevron"));
    assert.ok(/doctor-agent-chevron[\s\S]*doctor-check-label[\s\S]*doctor-check-summary[\s\S]*doctor-check-status/.test(doctorModalSource));
    assert.ok(doctorModalSource.includes("doctor-agent-body"));
    assert.ok(doctorModalSource.includes("doctor-agent-body-inner"));
    assert.ok(doctorModalSource.includes('data-action="toggle-check"'));
    assert.ok(doctorModalSource.includes('button.setAttribute("aria-expanded"'));
    assert.ok(doctorModalSource.includes('row.classList.toggle("expanded"'));
    assert.ok(doctorModalSource.includes('body.setAttribute("aria-hidden"'));
    assert.ok(doctorModalSource.includes('" inert"'));
    assert.ok(doctorModalSource.includes('body.setAttribute("inert", "")'));
    assert.ok(doctorModalSource.includes("body.removeAttribute(\"inert\")"));
    assert.ok(doctorModalSource.includes("checkNeedsAttention"));
    assert.ok(doctorModalSource.includes("formatAgentIntegrationSummary"));
    assert.ok(doctorModalSource.includes("formatAgentAttentionNames"));
    assert.ok(doctorModalSource.includes("AGENT_ATTENTION_NAME_LIMIT"));
    assert.ok(doctorModalSource.includes("doctorAgentSummaryNeedsAttention"));
    assert.ok(doctorModalSource.includes("+${hidden}"));
    assert.ok(doctorModalSource.includes("doctorAgentSummaryOk"));
    assert.ok(doctorModalSource.includes("doctorAgentSummaryAttention"));
    assert.ok(doctorModalSource.includes("doctorAgentSummarySkipped"));
    assert.ok(doctorModalSource.includes("AGENT_WARNING_STATUSES"));
    assert.ok(doctorModalSource.includes("AGENT_INFO_STATUSES"));
    assert.ok(doctorModalSource.includes("renderCheckSkeleton"));
    assert.ok(doctorModalSource.includes("doctor-check-skeleton"));
    assert.ok(doctorModalSource.includes("doctor-skeleton-line"));
    assert.ok(doctorModalSource.includes("doctor-connection-progress"));
    assert.ok(doctorModalSource.includes("const runId = ++state.connectionRunId"));
    assert.ok(doctorModalSource.includes("if (runId !== state.connectionRunId) return;"));
    assert.ok(doctorModalSource.includes("state.connectionTesting = false"));
    assert.ok(doctorModalSource.includes("state.connectionTest = null"));
    assert.ok(doctorModalSource.includes('state.checksLoading = true'));
    assert.ok(doctorModalSource.includes('state.checksLoading = false'));
    assert.ok(doctorModalSource.includes("formatCheckedDateTime"));
    assert.ok(doctorModalSource.includes('year: "numeric"'));
    assert.ok(doctorModalSource.includes('month: "2-digit"'));
    assert.ok(doctorModalSource.includes('day: "2-digit"'));
    assert.ok(doctorModalSource.includes("renderLastChecked"));
    assert.ok(doctorModalSource.includes("doctorLastCheckedAt"));
    assert.ok(doctorModalSource.includes("result.generatedAt"));
    assert.ok(doctorModalSource.includes("doctor-last-checked"));
    assert.ok(doctorModalSource.includes("const opening = !state.modalOpen"));
    assert.ok(doctorModalSource.includes("const entering = state.modalEntering"));
    assert.ok(doctorModalSource.includes("doctor-modal-entering"));
    assert.ok(doctorModalSource.includes("renderModalBody(core, result, { entering })"));
    assert.ok(doctorModalSource.includes("renderActionNotice"));
    assert.ok(doctorModalSource.includes("doctor-action-notice-icon"));
    assert.ok(doctorModalSource.includes("doctor-action-notice-text"));
    assert.ok(doctorModalSource.includes("doctor-action-bar"));
    assert.ok(doctorModalSource.includes("clearActionNoticeTimer();"));
    assert.ok(doctorModalSource.includes("state.repairFeedback = {};"));
    assert.ok(doctorModalSource.includes("state.repairingKey = null;"));
    assert.ok(doctorModalSource.includes("const runId = ++state.repairRunId"));
    assert.ok(doctorModalSource.includes("if (runId !== state.repairRunId) return;"));
    assert.ok(doctorModalSource.includes("doctor-privacy"));
    assert.ok(!doctorModalSource.includes("doctorPrivacyShort"));
    assert.ok(!i18nSource.includes("doctorPrivacyShort"));
    assert.ok(!doctorModalSource.includes("doctor-privacy-inline"));
    assert.ok(css.includes(".doctor-agent-detail"));
    assert.ok(css.includes(".doctor-connection-panel"));
    assert.ok(css.includes(".doctor-fix-button"));
    assert.ok(css.includes(".doctor-fix-confirm"));
    assert.ok(!css.includes(".doctor-privacy-inline"));
    assert.ok(css.includes(".doctor-repair-feedback"));
    assert.ok(css.includes(".doctor-repair-summary"));
    assert.ok(css.includes(".doctor-title-row"));
    assert.ok(css.includes(".doctor-check-row-compact"));
    assert.ok(css.includes(".doctor-local-server-main"));
    assert.ok(css.includes(".doctor-agent-toggle"));
    assert.ok(css.includes(".doctor-agent-chevron"));
    assert.ok(css.includes(".doctor-agent-collapsible.expanded"));
    assert.ok(css.includes(".doctor-agent-body"));
    assert.ok(css.includes(".doctor-agent-body-inner"));
    assert.ok(css.includes(".doctor-action-bar"));
    assert.ok(css.includes(".doctor-action-notice"));
    assert.ok(!css.includes(".doctor-action-notice::after"));
    assert.ok(css.includes(".doctor-action-notice-icon"));
    assert.ok(/@media \(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*\.doctor-action-notice\.ok[\s\S]*color:\s*#8ce99a;[\s\S]*\.doctor-action-notice\.error[\s\S]*color:\s*#fca5a5;/.test(css));
    assert.ok(css.includes("@keyframes doctor-notice-in"));
    assert.ok(/\.doctor-modal\s*\{[\s\S]*width:\s*min\(728px,\s*100%\);[\s\S]*max-height:\s*calc\(100vh - 32px\);/.test(css));
    assert.ok(/\.doctor-modal\s*\{[\s\S]*gap:\s*8px;[\s\S]*padding:\s*14px;/.test(css));
    assert.ok(css.includes(".doctor-modal-entering"));
    assert.ok(css.includes("@keyframes doctor-modal-in"));
    assert.ok(css.includes(".doctor-last-checked"));
    assert.ok(/\.doctor-overall\s*\{[\s\S]*flex-wrap:\s*wrap;/.test(css));
    assert.ok(/\.doctor-check-list\s*\{[\s\S]*gap:\s*6px;/.test(css));
    assert.ok(/\.doctor-check-row\s*\{[\s\S]*padding:\s*8px 10px;/.test(css));
    assert.ok(/\.doctor-check-detail\s*\{[\s\S]*margin:\s*5px 0 0 17px;/.test(css));
    assert.ok(css.includes("--doctor-pass"));
    assert.ok(css.includes("--doctor-warning"));
    assert.ok(css.includes("--doctor-critical"));
    assert.ok(css.includes("--doctor-critical-rgb: 220, 38, 38;"));
    assert.ok(css.includes(".doctor-check-skeleton"));
    assert.ok(css.includes("@keyframes doctor-skeleton-sheen"));
    assert.ok(css.includes(".doctor-connection-panel.testing"));
    assert.ok(css.includes(".doctor-connection-progress"));
    assert.ok(/\.doctor-action-bar\s*\{[\s\S]*align-items:\s*center;/.test(css));
    assert.ok(/\.doctor-action-notice-slot\s*\{[\s\S]*min-height:\s*24px;/.test(css));
    assert.ok(/\.doctor-check-row\.pass\s*\{[\s\S]*border-left-color:\s*rgba\(var\(--doctor-pass-rgb\),\s*0\.72\);/.test(css));
    assert.ok(/\.doctor-check-row\.warning\s*\{[\s\S]*border-left-color:\s*rgba\(var\(--doctor-warning-rgb\),\s*0\.78\);/.test(css));
    assert.ok(/\.doctor-check-row\.critical\s*\{[\s\S]*border-left-color:\s*rgba\(var\(--doctor-critical-rgb\),\s*0\.78\);/.test(css));
    assert.ok(/\.doctor-agent-toggle\s*\{[\s\S]*grid-template-columns:\s*auto auto auto minmax\(0,\s*1fr\) auto;/.test(css));
    assert.ok(/\.doctor-agent-body\s*\{[\s\S]*grid-template-rows:\s*0fr;[\s\S]*transition:[\s\S]*grid-template-rows 0\.24s cubic-bezier/.test(css));
    assert.ok(/\.doctor-agent-collapsible\.expanded \.doctor-agent-body\s*\{[\s\S]*grid-template-rows:\s*1fr;/.test(css));
    assert.ok(/\.doctor-check-row\s*\{[\s\S]*border-left-width:\s*3px;/.test(css));
    assert.ok(/\.doctor-check-status\s*\{[\s\S]*border-radius:\s*999px;/.test(css));
    assert.ok(/\.doctor-close:hover\s*\{[\s\S]*background:\s*rgba\(217,\s*119,\s*87,\s*0\.1\);[\s\S]*transform:\s*scale\(1\.04\);/.test(css));
    assert.ok(/\.doctor-close:focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--accent\);/.test(css));
    assert.ok(/\.doctor-agent-toggle:focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--accent\);/.test(css));
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.doctor-modal-entering[\s\S]*animation:\s*none;/.test(css));
    assert.ok(/@media \(max-width:\s*720px\)\s*\{[\s\S]*\.doctor-action-bar\s*\{[\s\S]*flex-direction:\s*column;/.test(css));
    // Regression guard: agent list must not introduce its own scroll viewport.
    // The outer .doctor-check-list owns scrolling so users get a single scrollbar.
    // [^}]*? keeps the match scoped to this rule body so unrelated max-height
    // declarations elsewhere in settings.css don't trip the assertion.
    assert.ok(!/\.doctor-agent-list\s*\{[^}]*?max-height:/.test(css));
    assert.ok(!/\.doctor-agent-list\s*\{[^}]*?overflow-y:\s*auto/.test(css));
    assert.ok(/\.doctor-agent-item \+ \.doctor-agent-item\s*\{[\s\S]*border-top:\s*1px solid var\(--row-border\);/.test(css));
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
    assert.ok(i18nSource.includes("doctorPrivacy"));
    assert.ok(i18nSource.includes("doctorLastCheckedAt"));
    assert.ok(i18nSource.includes("doctorAgentSummaryOk"));
    assert.ok(i18nSource.includes("doctorAgentSummaryAttention"));
    assert.ok(i18nSource.includes("doctorAgentSummaryNeedsAttention"));
    assert.ok(i18nSource.includes("doctorAgentSummarySkipped"));
    assert.ok(i18nSource.includes("doctorConnectionHttpVerified"));
    assert.ok(i18nSource.includes("doctorOpenLog"));
    assert.ok(i18nSource.includes('doctorOpenLogOpened: "Debug log opened"'));
    assert.ok(i18nSource.includes('doctorOpenLogOpened: "已打开调试日志"'));
    assert.ok(i18nSource.includes('doctorOpenLogOpened: "디버그 로그를 열었습니다"'));
    assert.ok(i18nSource.includes('doctorOpenLogOpened: "デバッグログを開きました"'));
    assert.ok(!i18nSource.includes('doctorOpenLogOpened: "Debug log opened."'));
    assert.ok(!i18nSource.includes('doctorOpenLogOpened: "已打开调试日志。"'));
    assert.ok(!i18nSource.includes('doctorOpenLogOpened: "디버그 로그를 열었습니다."'));
    assert.ok(!i18nSource.includes('doctorOpenLogOpened: "デバッグログを開きました。"'));
  });

  it("does not animate the size bubble's horizontal position", () => {
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const match = css.match(/\.size-bubble\s*\{([\s\S]*?)\n\}/);
    assert.ok(match, "settings.css should define a .size-bubble rule");
    assert.ok(!/transition:\s*left\b/.test(match[1]));
    assert.ok(/transition:\s*transform 0\.14s ease,\s*box-shadow 0\.18s ease;/.test(match[1]));
  });

  it("renders the size bubble tail as a separated double-layer callout instead of overlapping the pill", () => {
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    assert.ok(/--size-bubble-tail-size:\s*4px;/.test(css));
    assert.ok(/--size-bubble-tail-inner-size:\s*3px;/.test(css));
    assert.ok(/--size-bubble-tail-gap:\s*1px;/.test(css));
    assert.ok(/padding-top:\s*29px;/.test(css));
    assert.ok(/\.size-bubble\s*\{[\s\S]*top:\s*6px;[\s\S]*border-radius:\s*9px;[\s\S]*padding:\s*0 7px;[\s\S]*line-height:\s*1\.2;[\s\S]*\}/.test(css));
    assert.ok(/\.size-bubble::before,\s*\.size-bubble::after\s*\{/.test(css));
    assert.ok(/\.size-bubble::before\s*\{[\s\S]*top:\s*calc\(100%\s*\+\s*var\(--size-bubble-tail-gap\)\);[\s\S]*border-top:\s*var\(--size-bubble-tail-size\)\s+solid\s+var\(--accent\);[\s\S]*\}/.test(css));
    assert.ok(/\.size-bubble::after\s*\{[\s\S]*top:\s*calc\(100%\s*\+\s*var\(--size-bubble-tail-gap\)\);[\s\S]*border-top:\s*var\(--size-bubble-tail-inner-size\)\s+solid\s+var\(--panel-bg\);[\s\S]*\}/.test(css));
    assert.ok(!/\.size-bubble::after\s*\{[\s\S]*margin-top:\s*-1px;/.test(css));
  });

  it("uses transform-based Settings switch motion with a calmer shared timing", () => {
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const switchRule = css.match(/\.switch\s*\{([\s\S]*?)\n\}/);
    const knobRule = css.match(/\.switch::after\s*\{([\s\S]*?)\n\}/);
    const onKnobRule = css.match(/\.switch\.on::after\s*\{([\s\S]*?)\n\}/);
    assert.ok(switchRule, "settings.css should define the switch track");
    assert.ok(knobRule, "settings.css should define the switch knob");
    assert.ok(onKnobRule, "settings.css should define the on-state knob transform");
    assert.ok(/transition:\s*background 0\.26s ease,\s*box-shadow 0\.26s ease,\s*transform 0\.16s ease;/.test(switchRule[1]));
    assert.ok(/transform:\s*translateX\(0\)\s+scale\(1\);/.test(knobRule[1]));
    assert.ok(!/transition:\s*left\b/.test(knobRule[1]));
    assert.ok(/transition:\s*transform 0\.28s cubic-bezier\(0\.2,\s*0\.8,\s*0\.2,\s*1\),\s*box-shadow 0\.2s ease;/.test(knobRule[1]));
    assert.ok(/transform:\s*translateX\(16px\)\s+scale\(1\);/.test(onKnobRule[1]));
    assert.ok(!css.includes(".switch.on::after { left: 18px; }"));
    assert.ok(/\.switch:not\(\.disabled\):active::after\s*\{[\s\S]*transform:\s*translateX\(var\(--switch-knob-x,\s*0\)\)\s+scale\(0\.94\);/.test(css));
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.switch,[\s\S]*\.switch::after\s*\{[\s\S]*transition:\s*none;/.test(css));
  });

  it("renders the Settings language picker as a dropdown over all supported langs", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");

    assert.ok(new RegExp(
      String.raw`const LANGUAGE_OPTIONS = \[` +
      SUPPORTED_LANGS.map((lang) => String.raw`"${lang}"`).join(String.raw`,\s*`) +
      String.raw`\];`
    ).test(generalSource));
    assert.ok(generalSource.includes(`class="language-picker"`));
    assert.ok(generalSource.includes(`aria-haspopup="listbox"`));
    assert.ok(generalSource.includes(`role="listbox"`));
    assert.ok(generalSource.includes(`aria-hidden="true"`));
    assert.ok(generalSource.includes(`role", "option"`));
    assert.ok(!generalSource.includes(`<select class="language-select"`));
    assert.ok(!generalSource.includes("language-segmented"));
    assert.ok(!generalSource.includes("runtime.languageTransition"));
    assert.ok(!generalSource.includes("--language-active-index"));
    assert.ok(!coreSource.includes("languageTransition"));
    assert.ok(/\.language-picker-menu\s*\{[\s\S]*box-shadow:/.test(css));
    assert.ok(/\.language-picker-option:hover,[\s\S]*\.language-picker-option:focus-visible\s*\{[\s\S]*background:/.test(css));
    assert.ok(/\.language-picker-option\.selected\s*\{[\s\S]*color:\s*var\(--accent\);/.test(css));
    assert.ok(/@media \(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*\.language-picker-menu/.test(css));
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.language-picker-trigger,[\s\S]*\.language-picker-chevron,[\s\S]*\.language-picker-menu[\s\S]*transition:\s*none;/.test(css));
    assert.ok(!css.includes(".language-segmented"));
  });

  it("populates the language picker with current selection and propagates click changes", () => {
    const harness = loadGeneralLanguageRowForTest({
      snapshot: { lang: "en" },
    });

    harness.core.ops.requestRender({ content: true });
    assert.strictEqual(harness.getContentRenderCount(), 1);
    const picker = harness.getLangPicker();
    const trigger = harness.getLangTrigger();
    assert.ok(picker, "language picker should be rendered");
    assert.ok(trigger, "language picker trigger should be rendered");
    assert.strictEqual(harness.getLangValue().textContent, "English");
    assert.strictEqual(harness.getLangMenu().attributes["aria-hidden"], "true");
    const options = harness.getLangOptions();
    assert.strictEqual(options.length, SUPPORTED_LANGS.length);
    for (let i = 0; i < SUPPORTED_LANGS.length; i++) {
      assert.strictEqual(options[i].dataset.lang, SUPPORTED_LANGS[i]);
      assert.strictEqual(options[i].tabIndex, -1);
    }
    assert.strictEqual(options[0].attributes["aria-selected"], "true");

    trigger.dispatchEvent({ type: "click" });
    assert.strictEqual(picker.classList.contains("open"), true);
    assert.strictEqual(harness.getLangMenu().attributes["aria-hidden"], "false");
    assert.strictEqual(options[0].tabIndex, 0);
    options[1].dispatchEvent({ type: "click" });

    assert.deepStrictEqual(
      harness.updateCalls,
      [{ key: "lang", value: "zh" }],
      "clicking a language option should call settingsAPI.update with the new lang"
    );
    assert.strictEqual(picker.classList.contains("open"), false);
    assert.strictEqual(harness.getLangMenu().attributes["aria-hidden"], "true");
    for (const option of options) assert.strictEqual(option.tabIndex, -1);
    assert.strictEqual(harness.getLangValue().textContent, "Chinese");

    trigger.dispatchEvent({ type: "click" });
    options[1].dispatchEvent({ type: "click" });
    assert.deepStrictEqual(
      harness.updateCalls,
      [{ key: "lang", value: "zh" }],
      "clicking the already displayed pending language should not submit a duplicate update"
    );

    trigger.dispatchEvent({ type: "click" });
    options[0].dispatchEvent({ type: "click" });
    assert.deepStrictEqual(
      harness.updateCalls,
      [{ key: "lang", value: "zh" }],
      "clicking back to the committed language while pending should not submit a duplicate update"
    );
    assert.strictEqual(harness.getLangValue().textContent, "English");
    assert.strictEqual(options[0].attributes["aria-selected"], "true");

    harness.core.ops.applyChanges({
      changes: { lang: "zh" },
      snapshot: { lang: "zh" },
    });
    assert.strictEqual(harness.getContentRenderCount(), 2);
    assert.strictEqual(harness.getLangValue().textContent, "Chinese");
    assert.strictEqual(harness.getLangOptions()[1].attributes["aria-selected"], "true");
  });

  it("supports keyboard language selection and reverts when saving fails", async () => {
    const harness = loadGeneralLanguageRowForTest({
      snapshot: { lang: "en" },
      update: () => Promise.resolve({ status: "error", message: "synthetic failure" }),
    });

    harness.core.ops.requestRender({ content: true });
    const trigger = harness.getLangTrigger();
    trigger.dispatchEvent(createKeyboardEventForTest("ArrowDown"));
    assert.strictEqual(harness.getLangPicker().classList.contains("open"), true);
    const options = harness.getLangOptions();
    options[1].dispatchEvent(createKeyboardEventForTest("Enter"));
    await Promise.resolve();

    assert.deepStrictEqual(harness.updateCalls, [{ key: "lang", value: "zh" }]);
    assert.strictEqual(harness.getLangValue().textContent, "English");
    assert.strictEqual(harness.getToastText(), "Failed: synthetic failure");
  });

  it("cleans up language picker document listeners across re-renders", () => {
    const harness = loadGeneralLanguageRowForTest({
      snapshot: { lang: "en" },
    });

    harness.core.ops.requestRender({ content: true });
    assert.strictEqual(harness.getDocumentListenerCount("click"), 1);
    assert.strictEqual(harness.getDocumentListenerCount("keydown"), 1);

    harness.core.ops.requestRender({ content: true });
    assert.strictEqual(harness.getDocumentListenerCount("click"), 1);
    assert.strictEqual(harness.getDocumentListenerCount("keydown"), 1);
  });

  it("exposes aggregate and split bubble controls in the General tab", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
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
    assert.ok(generalSource.indexOf("buildBubblePolicyRow()") < generalSource.indexOf('key: "bubbleFollowPet"'));
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
    assert.ok(/\.bubble-policy-seconds\s*\{[\s\S]*width:\s*42px;/.test(css));
    assert.ok(/\.bubble-policy-seconds\s*\{[\s\S]*box-sizing:\s*border-box;[\s\S]*text-align:\s*center;[\s\S]*padding:\s*0 3px;/.test(css));
    assert.ok(i18nSource.includes("rowHideBubbles"));
    assert.ok(i18nSource.includes("rowBubblePolicy"));
    assert.ok(i18nSource.includes("bubbleUpdateWarning"));
    assert.ok(i18nSource.includes("bubbleSecondsPrefix"));
  });

  it("uses collapsible option lists for Session HUD and sound controls", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    assert.ok(generalSource.includes("function buildSessionHudOptionsList("));
    assert.ok(generalSource.includes("session-hud-option-list"));
    assert.ok(generalSource.includes("function buildSoundGroup("));
    assert.ok(generalSource.includes("function buildSoundEnabledRow("));
    assert.ok(generalSource.includes('id: "general:sound"'));
    assert.ok(generalSource.includes("sound-option-list"));
    assert.ok(generalSource.includes("state.mountedControls.soundSummary"));
    assert.ok(generalSource.includes('sw.setAttribute("aria-label", t("rowSoundEnabled"));'));
    assert.ok(generalSource.includes("toggleSound"));
    assert.ok(generalSource.includes("syncVolumePreview"));
    assert.ok(!/key:\s*"soundMuted",[\s\S]{0,120}descKey:\s*"rowSoundDesc"/.test(generalSource));
    assert.ok(generalSource.includes('state.transientUiState.generalSwitches.set("soundMuted"'));
    assert.ok(generalSource.includes("if (!result || result.status !== \"ok\" || result.noop)"));
    assert.ok(generalSource.includes("sessionHudSummaryAutoHide"));
    assert.ok(generalSource.includes("session-hud-summary-control"));
    assert.ok(/\.settings-option-list\s*\{[\s\S]*display:\s*grid;[\s\S]*gap:\s*8px;/.test(css));
    assert.ok(/\.settings-option-list \.settings-option-item\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--panel-bg\) 78%,\s*transparent\);/.test(css));
    assert.ok(/\.session-hud-collapsible \.collapsible-summary-chip,[\s\S]*\.sound-collapsible \.collapsible-summary-chip\s*\{[\s\S]*max-width:\s*min\(280px,\s*100%\);/.test(css));
    assert.ok(/\.session-hud-collapsible \.collapsible-group-summary\s*\{[\s\S]*flex:\s*0 0 auto;[\s\S]*max-width:\s*none;/.test(css));
    assert.ok(/\.sound-collapsible \.collapsible-group-summary\s*\{[\s\S]*flex:\s*0 0 auto;[\s\S]*max-width:\s*none;/.test(css));
    assert.ok(/\.bubble-policy-collapsible \.collapsible-group-summary\s*\{[^}]*flex:\s*0 0 auto;[^}]*flex-wrap:\s*nowrap;[^}]*max-width:\s*none;[^}]*\}/.test(css));
    assert.ok(!/\.session-hud-collapsible \.collapsible-group-summary\s*\{[^}]*flex-wrap:\s*nowrap;/.test(css));
    assert.ok(!/\.sound-collapsible \.collapsible-group-summary\s*\{[^}]*flex-wrap:\s*nowrap;/.test(css));
    assert.ok(/\.session-hud-summary-control\s*\{[\s\S]*grid-template-columns:\s*repeat\(4,\s*max-content\);/.test(css));
    assert.ok(/\.session-hud-summary-control\.compact\s*\{[\s\S]*display:\s*inline-flex;[\s\S]*width:\s*auto;/.test(css));
    assert.ok(/@media \(max-width:\s*720px\)\s*\{[\s\S]*\.session-hud-summary-control\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*width:\s*min\(238px,\s*42vw\);/.test(css));
    assert.ok(/\.collapsible-group-text \.row-label\s*\{[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/.test(css));
    assert.ok(/\.collapsible-group-text \.row-desc\s*\{[\s\S]*white-space:\s*normal;[\s\S]*-webkit-line-clamp:\s*2;/.test(css));
    assert.ok(/\.sound-summary-control\s*\{[\s\S]*display:\s*inline-flex;/.test(css));
    assert.ok(/\.sound-summary-control\s*\{[\s\S]*min-width:\s*max-content;/.test(css));
    assert.ok(/\.sound-summary-control \.collapsible-summary-chip\s*\{[\s\S]*max-width:\s*none;/.test(css));
    assert.ok(/\.sound-summary-control \.collapsible-summary-chip\s*\{[\s\S]*flex:\s*0 0 auto;/.test(css));
    assert.ok(/\.sound-collapsible \.collapsible-group-text \.row-desc\s*\{[\s\S]*white-space:\s*normal;[\s\S]*-webkit-line-clamp:\s*2;/.test(css));
    assert.ok(i18nSource.includes("rowSoundEnabled"));
  });

  it("adds hover affordance to General size and volume sliders", () => {
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    assert.ok(/\.size-slider:hover::-webkit-slider-thumb\s*\{[\s\S]*transform:\s*scale\(1\.08\);/.test(css));
    assert.ok(/\.volume-slider:hover::-webkit-slider-thumb\s*\{[\s\S]*transform:\s*scale\(1\.08\);/.test(css));
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.size-slider:hover::-webkit-slider-thumb,[\s\S]*\.volume-slider:hover::-webkit-slider-thumb\s*\{[\s\S]*transform:\s*none;/.test(css));
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
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    assert.ok(generalSource.includes("settings-confirm-modal"));
    assert.ok(generalSource.includes("updateBubbleDisableConfirmAction"));
    assert.ok(css.includes(".settings-confirm-modal"));
    assert.ok(css.includes(".settings-confirm-backdrop"));
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
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    assert.ok(generalSource.includes("confirmDisableClaudeHookManagement"));
    assert.ok(generalSource.includes("runDisconnectClaudeHooks"));
    assert.ok(generalSource.includes("showSettingsConfirmModal({"));
    assert.ok(generalSource.includes("claudeHooksDisableConfirmTitle"));
    assert.ok(generalSource.includes("claudeHooksDisconnectConfirmTitle"));
    assert.ok(generalSource.includes("buttons.find((action) => action.action && action.action.defaultFocus)"));
    assert.ok(generalSource.includes('button.className = `soft-btn${toneClass ? ` ${toneClass}` : ""}`;'));
    assert.ok(generalSource.includes('tone === "accent"'));
    assert.ok(generalSource.includes('tone === "danger"'));
    assert.ok(css.includes(".settings-confirm-danger"));
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
    const patchIndex = coreSource.indexOf("activeTab.patchInPlace(changes");
    const renderIndex = coreSource.indexOf("requestRender({ sidebar: true, content: true });", patchIndex);
    assert.notStrictEqual(clearIndex, -1);
    assert.notStrictEqual(patchIndex, -1);
    assert.notStrictEqual(renderIndex, -1);
    assert.ok(clearIndex < patchIndex, "broadcast cleanup must happen before in-place patching");
    assert.ok(clearIndex < renderIndex, "broadcast cleanup must happen before full rerender");
  });

  it("patches the Session HUD master switch without rebuilding General content", async () => {
    const updateCalls = [];
    const initialSnapshot = {
      lang: "en",
      size: 50,
      sessionHudEnabled: false,
      sessionHudShowElapsed: true,
      sessionHudCleanupDetached: true,
      soundMuted: false,
      soundVolume: 0.5,
      lowPowerIdleMode: false,
      allowEdgePinning: true,
      keepSizeAcrossDisplays: true,
      manageClaudeHooksAutomatically: false,
      openAtLogin: false,
      autoStartWithClaude: false,
      hideBubbles: false,
      bubbleFollowPet: true,
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 8,
      updateBubbleAutoCloseSeconds: 12,
    };
    const harness = loadGeneralTabForTest({
      snapshot: initialSnapshot,
      settingsAPI: {
        update: (key, value) => {
          updateCalls.push({ key, value });
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.renderContent();

    const master = harness.getSwitch("sessionHudEnabled");
    const elapsed = harness.getSwitch("sessionHudShowElapsed");
    const cleanup = harness.getSwitch("sessionHudCleanupDetached");
    const summary = harness.core.state.mountedControls.sessionHudSummary.element;
    const optionList = harness.content.querySelector(".session-hud-option-list");
    assert.ok(master);
    assert.ok(elapsed);
    assert.ok(cleanup);
    assert.ok(optionList);
    assert.ok(optionList.children.every((child) => child.classList.contains("settings-option-item")));
    assert.strictEqual(harness.getSwitchMeta("sessionHudEnabled").row.querySelector(".row-desc"), null);
    assert.strictEqual(summary.children.length, 1);
    assert.strictEqual(summary.children[0].textContent, "HUD: off");
    assert.strictEqual(summary.classList.contains("compact"), true);
    assert.strictEqual(elapsed.classList.contains("disabled"), true);
    assert.strictEqual(elapsed.attributes["aria-disabled"], "true");
    assert.strictEqual(elapsed.tabIndex, -1);

    const beforeRenderCount = harness.getContentRenderCount();
    harness.core.ops.applyChanges({
      changes: { sessionHudEnabled: true },
      snapshot: { ...initialSnapshot, sessionHudEnabled: true },
    });

    assert.strictEqual(
      harness.getContentRenderCount(),
      beforeRenderCount,
      "Session HUD master broadcasts should patch mounted controls instead of rebuilding General"
    );
    assert.strictEqual(harness.getSwitch("sessionHudEnabled"), master);
    assert.strictEqual(harness.getSwitch("sessionHudShowElapsed"), elapsed);
    assert.strictEqual(harness.getSwitch("sessionHudCleanupDetached"), cleanup);
    assert.strictEqual(master.classList.contains("on"), true);
    assert.strictEqual(master.classList.contains("pending"), false);
    assert.strictEqual(elapsed.classList.contains("disabled"), false);
    assert.strictEqual(elapsed.attributes["aria-disabled"], undefined);
    assert.strictEqual(elapsed.tabIndex, 0);
    assert.strictEqual(cleanup.classList.contains("disabled"), false);
    assert.strictEqual(cleanup.tabIndex, 0);
    assert.strictEqual(summary.children.length, 4);
    assert.strictEqual(summary.classList.contains("compact"), false);
    assert.strictEqual(summary.children[0].textContent, "HUD: on");
    assert.strictEqual(summary.children[1].textContent, "Time: on");
    assert.strictEqual(summary.children[2].textContent, "Auto-hide: off");
    assert.strictEqual(summary.children[3].textContent, "Auto-clear: on");

    assert.ok(
      elapsed.eventListeners.click && elapsed.eventListeners.click.length > 0,
      "Session HUD child switches must remain wired after being enabled in place"
    );
    elapsed.eventListeners.click[0]();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(updateCalls, [{ key: "sessionHudShowElapsed", value: false }]);
  });

  it("groups sound and volume into one collapsible control with in-place summary updates", () => {
    const initialSnapshot = makeGeneralSnapshot({
      soundMuted: false,
      soundVolume: 0.5,
    });
    const harness = loadGeneralTabForTest({ snapshot: initialSnapshot });
    harness.renderContent();

    const soundSwitch = harness.getSwitch("soundMuted");
    const summary = harness.core.state.mountedControls.soundSummary.element;
    const volumeControl = harness.core.state.mountedControls.soundVolume;
    const volumeSlider = volumeControl.row.querySelector(".volume-slider");
    const optionList = harness.content.querySelector(".sound-option-list");
    assert.ok(soundSwitch);
    assert.ok(summary);
    assert.ok(volumeControl);
    assert.ok(volumeSlider);
    assert.ok(optionList);
    assert.ok(optionList.children.every((child) => child.classList.contains("settings-option-item")));
    assert.strictEqual(harness.getSwitchMeta("soundMuted").row.querySelector(".row-desc"), null);
    assert.strictEqual(summary.children.length, 2);
    assert.strictEqual(summary.children[0].textContent, "on · 50%");
    assert.ok(summary.children[1].classList.contains("sound-header-switch"));
    assert.strictEqual(summary.children[1].attributes["aria-label"], "Enable sound effects");

    volumeSlider.value = "75";
    for (const listener of volumeSlider.eventListeners.input || []) listener();
    assert.strictEqual(summary.children[0].textContent, "on · 75%");

    const beforeRenderCount = harness.getContentRenderCount();
    harness.core.ops.applyChanges({
      changes: { soundVolume: 0.25 },
      snapshot: { ...initialSnapshot, soundVolume: 0.25 },
    });

    assert.strictEqual(harness.getContentRenderCount(), beforeRenderCount);
    assert.strictEqual(harness.core.state.mountedControls.soundSummary.element, summary);
    assert.strictEqual(volumeSlider.value, "25");
    assert.strictEqual(volumeSlider.style.getPropertyValue("--volume-fill"), "25%");
    assert.strictEqual(summary.children[0].textContent, "on · 25%");

    harness.core.ops.applyChanges({
      changes: { soundMuted: true },
      snapshot: { ...initialSnapshot, soundMuted: true, soundVolume: 0.25 },
    });

    assert.strictEqual(harness.getContentRenderCount(), beforeRenderCount);
    assert.strictEqual(harness.getSwitch("soundMuted"), soundSwitch);
    assert.strictEqual(soundSwitch.classList.contains("on"), false);
    assert.strictEqual(summary.children[1].classList.contains("on"), false);
    assert.strictEqual(volumeSlider.disabled, true);
    assert.strictEqual(summary.children[0].textContent, "off · 25%");
  });

  it("lets the sound summary switch toggle sound without opening the collapsible group", async () => {
    const updateCalls = [];
    const initialSnapshot = makeGeneralSnapshot({
      soundMuted: false,
      soundVolume: 1,
    });
    const harness = loadGeneralTabForTest({
      snapshot: initialSnapshot,
      settingsAPI: {
        update: (key, value) => {
          updateCalls.push({ key, value });
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.renderContent();

    const summary = harness.core.state.mountedControls.soundSummary;
    const headerSwitch = summary.headerSwitch;
    const soundGroup = harness.content.querySelector(".sound-collapsible");
    assert.ok(headerSwitch);
    assert.ok(soundGroup.classList.contains("collapsed"));

    let stopped = false;
    let prevented = false;
    headerSwitch.eventListeners.click[0]({
      stopPropagation: () => { stopped = true; },
      preventDefault: () => { prevented = true; },
    });
    assert.strictEqual(headerSwitch.classList.contains("pending"), true);
    assert.strictEqual(harness.getSwitch("soundMuted").classList.contains("pending"), true);
    assert.strictEqual(summary.element.children[0].textContent, "off · 100%");
    headerSwitch.eventListeners.click[0]({
      stopPropagation: () => {},
      preventDefault: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(updateCalls, [{ key: "soundMuted", value: true }]);
    assert.strictEqual(stopped, true);
    assert.strictEqual(prevented, true);
    assert.ok(soundGroup.classList.contains("collapsed"));
    assert.strictEqual(headerSwitch.classList.contains("on"), false);
    assert.strictEqual(headerSwitch.classList.contains("pending"), false);
    assert.strictEqual(summary.element.children[0].textContent, "off · 100%");
  });

  it("keeps the sound child switch and summary in sync while the update is pending", async () => {
    const updateCalls = [];
    let resolveUpdate = null;
    const initialSnapshot = makeGeneralSnapshot({
      soundMuted: false,
      soundVolume: 1,
    });
    const harness = loadGeneralTabForTest({
      snapshot: initialSnapshot,
      settingsAPI: {
        update: (key, value) => {
          updateCalls.push({ key, value });
          return new Promise((resolve) => {
            resolveUpdate = resolve;
          });
        },
      },
    });
    harness.renderContent();

    const summary = harness.core.state.mountedControls.soundSummary;
    const headerSwitch = summary.headerSwitch;
    const childSwitch = harness.getSwitch("soundMuted");
    let stopped = false;
    let prevented = false;
    childSwitch.eventListeners.click[0]({
      stopPropagation: () => { stopped = true; },
      preventDefault: () => { prevented = true; },
    });

    assert.deepStrictEqual(updateCalls, [{ key: "soundMuted", value: true }]);
    assert.strictEqual(stopped, true);
    assert.strictEqual(prevented, true);
    assert.strictEqual(childSwitch.classList.contains("on"), false);
    assert.strictEqual(childSwitch.classList.contains("pending"), true);
    assert.strictEqual(headerSwitch.classList.contains("on"), false);
    assert.strictEqual(headerSwitch.classList.contains("pending"), true);
    assert.strictEqual(summary.element.children[0].textContent, "off · 100%");

    resolveUpdate({ status: "ok" });
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(childSwitch.classList.contains("on"), false);
    assert.strictEqual(childSwitch.classList.contains("pending"), false);
    assert.strictEqual(headerSwitch.classList.contains("on"), false);
    assert.strictEqual(headerSwitch.classList.contains("pending"), false);
    assert.strictEqual(summary.element.children[0].textContent, "off · 100%");
    assert.strictEqual(harness.core.state.transientUiState.generalSwitches.has("soundMuted"), false);
  });

  it("restores the sound summary switch when a toggle is a noop", async () => {
    const updateCalls = [];
    const initialSnapshot = makeGeneralSnapshot({
      soundMuted: false,
      soundVolume: 1,
    });
    const harness = loadGeneralTabForTest({
      snapshot: initialSnapshot,
      settingsAPI: {
        update: (key, value) => {
          updateCalls.push({ key, value });
          return Promise.resolve({ status: "ok", noop: true });
        },
      },
    });
    harness.renderContent();

    const summary = harness.core.state.mountedControls.soundSummary;
    const headerSwitch = summary.headerSwitch;
    const childSwitch = harness.getSwitch("soundMuted");
    headerSwitch.eventListeners.click[0]({
      stopPropagation: () => {},
      preventDefault: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(updateCalls, [{ key: "soundMuted", value: true }]);
    assert.strictEqual(headerSwitch.classList.contains("on"), true);
    assert.strictEqual(headerSwitch.classList.contains("pending"), false);
    assert.strictEqual(childSwitch.classList.contains("on"), true);
    assert.strictEqual(childSwitch.classList.contains("pending"), false);
    assert.strictEqual(summary.element.children[0].textContent, "on · 100%");
    assert.strictEqual(harness.core.state.transientUiState.generalSwitches.has("soundMuted"), false);
  });

  it("patches Claude hook management child switch state without rebuilding General content", async () => {
    const updateCalls = [];
    const initialSnapshot = {
      lang: "en",
      size: 50,
      sessionHudEnabled: true,
      sessionHudShowElapsed: true,
      sessionHudCleanupDetached: true,
      soundMuted: false,
      soundVolume: 0.5,
      lowPowerIdleMode: false,
      allowEdgePinning: true,
      keepSizeAcrossDisplays: true,
      manageClaudeHooksAutomatically: false,
      openAtLogin: false,
      autoStartWithClaude: false,
      hideBubbles: false,
      bubbleFollowPet: true,
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 8,
      updateBubbleAutoCloseSeconds: 12,
    };
    const harness = loadGeneralTabForTest({
      snapshot: initialSnapshot,
      settingsAPI: {
        update: (key, value) => {
          updateCalls.push({ key, value });
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.renderContent();

    const master = harness.getSwitch("manageClaudeHooksAutomatically");
    const autoStart = harness.getSwitch("autoStartWithClaude");
    const autoStartMeta = harness.getSwitchMeta("autoStartWithClaude");
    assert.ok(master);
    assert.ok(autoStart);
    assert.ok(autoStartMeta.extraElement);
    assert.strictEqual(autoStart.classList.contains("disabled"), true);

    const beforeRenderCount = harness.getContentRenderCount();
    harness.core.ops.applyChanges({
      changes: { manageClaudeHooksAutomatically: true },
      snapshot: { ...initialSnapshot, manageClaudeHooksAutomatically: true },
    });

    assert.strictEqual(
      harness.getContentRenderCount(),
      beforeRenderCount,
      "Claude hook management broadcasts should patch the mounted startup switches"
    );
    assert.strictEqual(harness.getSwitch("manageClaudeHooksAutomatically"), master);
    assert.strictEqual(harness.getSwitch("autoStartWithClaude"), autoStart);
    assert.strictEqual(master.classList.contains("on"), true);
    assert.strictEqual(autoStart.classList.contains("disabled"), false);
    assert.strictEqual(autoStart.attributes["aria-disabled"], undefined);
    assert.strictEqual(autoStart.tabIndex, 0);
    assert.strictEqual(autoStartMeta.extraElement, null);

    autoStart.eventListeners.click[0]();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(updateCalls, [{ key: "autoStartWithClaude", value: true }]);
  });

  it("patches hide-bubbles aggregate changes without rebuilding General content", () => {
    const initialSnapshot = {
      lang: "en",
      size: 50,
      sessionHudEnabled: true,
      sessionHudShowElapsed: true,
      sessionHudCleanupDetached: true,
      soundMuted: false,
      soundVolume: 0.5,
      lowPowerIdleMode: false,
      allowEdgePinning: true,
      keepSizeAcrossDisplays: true,
      manageClaudeHooksAutomatically: true,
      openAtLogin: false,
      autoStartWithClaude: false,
      hideBubbles: false,
      bubbleFollowPet: true,
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 8,
      updateBubbleAutoCloseSeconds: 12,
    };
    const harness = loadGeneralTabForTest({ snapshot: initialSnapshot });
    harness.renderContent();

    const aggregate = harness.getSwitch("hideBubbles");
    const notificationPolicy = harness.core.state.mountedControls.bubblePolicyControls.get("notificationBubbleAutoCloseSeconds");
    const notificationSwitch = notificationPolicy.row.querySelector(".switch");
    const notificationSeconds = notificationPolicy.row.querySelector("input");
    assert.ok(aggregate);
    assert.ok(notificationSwitch);
    assert.ok(notificationSeconds);
    assert.strictEqual(notificationSwitch.classList.contains("on"), true);
    assert.strictEqual(notificationSeconds.disabled, false);

    const beforeRenderCount = harness.getContentRenderCount();
    harness.core.ops.applyChanges({
      changes: { hideBubbles: true },
      snapshot: { ...initialSnapshot, hideBubbles: true },
    });

    assert.strictEqual(
      harness.getContentRenderCount(),
      beforeRenderCount,
      "hide-bubbles broadcasts should patch summary and category controls in place"
    );
    assert.strictEqual(harness.getSwitch("hideBubbles"), aggregate);
    assert.strictEqual(aggregate.classList.contains("on"), true);
    assert.strictEqual(notificationSwitch.classList.contains("on"), false);
    assert.strictEqual(notificationSeconds.disabled, true);
  });

  it("patches the Session HUD master switch off without rebuilding General content", async () => {
    const updateCalls = [];
    const initialSnapshot = makeGeneralSnapshot({ sessionHudEnabled: true });
    const harness = loadGeneralTabForTest({
      snapshot: initialSnapshot,
      settingsAPI: {
        update: (key, value) => {
          updateCalls.push({ key, value });
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.renderContent();

    const master = harness.getSwitch("sessionHudEnabled");
    const elapsed = harness.getSwitch("sessionHudShowElapsed");
    const cleanup = harness.getSwitch("sessionHudCleanupDetached");
    assert.ok(master);
    assert.ok(elapsed);
    assert.ok(cleanup);
    assert.strictEqual(elapsed.classList.contains("disabled"), false);
    assert.strictEqual(cleanup.classList.contains("disabled"), false);

    const beforeRenderCount = harness.getContentRenderCount();
    harness.core.ops.applyChanges({
      changes: { sessionHudEnabled: false },
      snapshot: { ...initialSnapshot, sessionHudEnabled: false },
    });

    assert.strictEqual(harness.getContentRenderCount(), beforeRenderCount);
    assert.strictEqual(harness.getSwitch("sessionHudEnabled"), master);
    assert.strictEqual(harness.getSwitch("sessionHudShowElapsed"), elapsed);
    assert.strictEqual(harness.getSwitch("sessionHudCleanupDetached"), cleanup);
    assert.strictEqual(master.classList.contains("on"), false);
    assert.strictEqual(elapsed.classList.contains("disabled"), true);
    assert.strictEqual(elapsed.attributes["aria-disabled"], "true");
    assert.strictEqual(elapsed.tabIndex, -1);
    assert.strictEqual(cleanup.classList.contains("disabled"), true);
    assert.strictEqual(cleanup.attributes["aria-disabled"], "true");
    assert.strictEqual(cleanup.tabIndex, -1);

    elapsed.eventListeners.click[0]();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(updateCalls, []);
  });

  it("patches Claude hook management off and restores the child disabled note", async () => {
    const updateCalls = [];
    const initialSnapshot = makeGeneralSnapshot({
      manageClaudeHooksAutomatically: true,
      autoStartWithClaude: true,
    });
    const harness = loadGeneralTabForTest({
      snapshot: initialSnapshot,
      settingsAPI: {
        update: (key, value) => {
          updateCalls.push({ key, value });
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.renderContent();

    const master = harness.getSwitch("manageClaudeHooksAutomatically");
    const autoStart = harness.getSwitch("autoStartWithClaude");
    const autoStartMeta = harness.getSwitchMeta("autoStartWithClaude");
    assert.ok(master);
    assert.ok(autoStart);
    assert.ok(autoStartMeta);
    assert.strictEqual(autoStart.classList.contains("disabled"), false);
    assert.strictEqual(autoStartMeta.extraElement, null);

    const beforeRenderCount = harness.getContentRenderCount();
    harness.core.ops.applyChanges({
      changes: { manageClaudeHooksAutomatically: false },
      snapshot: { ...initialSnapshot, manageClaudeHooksAutomatically: false },
    });

    assert.strictEqual(harness.getContentRenderCount(), beforeRenderCount);
    assert.strictEqual(harness.getSwitch("manageClaudeHooksAutomatically"), master);
    assert.strictEqual(harness.getSwitch("autoStartWithClaude"), autoStart);
    assert.strictEqual(master.classList.contains("on"), false);
    assert.strictEqual(autoStart.classList.contains("disabled"), true);
    assert.strictEqual(autoStart.attributes["aria-disabled"], "true");
    assert.strictEqual(autoStart.tabIndex, -1);
    assert.ok(autoStartMeta.extraElement);
    assert.strictEqual(
      autoStartMeta.extraElement.textContent,
      harness.core.helpers.t("rowStartWithClaudeDisabledDesc")
    );

    autoStart.eventListeners.click[0]();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(updateCalls, []);
  });

  it("patches hide-bubbles aggregate off without rebuilding General content", () => {
    const initialSnapshot = makeGeneralSnapshot({ hideBubbles: true });
    const harness = loadGeneralTabForTest({ snapshot: initialSnapshot });
    harness.renderContent();

    const aggregate = harness.getSwitch("hideBubbles");
    const notificationPolicy = harness.core.state.mountedControls.bubblePolicyControls.get("notificationBubbleAutoCloseSeconds");
    const notificationSwitch = notificationPolicy.row.querySelector(".switch");
    const notificationSeconds = notificationPolicy.row.querySelector("input");
    const summary = harness.core.state.mountedControls.bubblePolicySummary.element;
    assert.ok(aggregate);
    assert.strictEqual(aggregate.classList.contains("on"), true);
    assert.strictEqual(notificationSwitch.classList.contains("on"), false);
    assert.strictEqual(notificationSeconds.disabled, true);
    assert.ok(summary.children.every((chip) => !chip.classList.contains("accent")));

    const beforeRenderCount = harness.getContentRenderCount();
    harness.core.ops.applyChanges({
      changes: { hideBubbles: false },
      snapshot: { ...initialSnapshot, hideBubbles: false },
    });

    assert.strictEqual(harness.getContentRenderCount(), beforeRenderCount);
    assert.strictEqual(harness.getSwitch("hideBubbles"), aggregate);
    assert.strictEqual(aggregate.classList.contains("on"), false);
    assert.strictEqual(notificationSwitch.classList.contains("on"), true);
    assert.strictEqual(notificationSeconds.disabled, false);
    assert.strictEqual(notificationSeconds.value, "8");
    assert.strictEqual(summary.children.length, 3);
    assert.ok(summary.children.every((chip) => chip.classList.contains("accent")));
  });

  it("rerenders General content for mixed non-patchable broadcasts", () => {
    const initialSnapshot = makeGeneralSnapshot({
      lang: "en",
      sessionHudEnabled: false,
    });
    const harness = loadGeneralTabForTest({ snapshot: initialSnapshot });
    harness.renderContent();

    const master = harness.getSwitch("sessionHudEnabled");
    const beforeRenderCount = harness.getContentRenderCount();
    harness.core.ops.applyChanges({
      changes: { sessionHudEnabled: true, lang: "zh" },
      snapshot: { ...initialSnapshot, sessionHudEnabled: true, lang: "zh" },
    });

    assert.strictEqual(harness.getContentRenderCount(), beforeRenderCount + 1);
    assert.notStrictEqual(harness.getSwitch("sessionHudEnabled"), master);
    assert.strictEqual(harness.getSwitch("sessionHudEnabled").classList.contains("on"), true);
  });

  it("patches combined bubble aggregate and seconds broadcasts in place", () => {
    const initialSnapshot = makeGeneralSnapshot({
      hideBubbles: false,
      notificationBubbleAutoCloseSeconds: 8,
    });
    const harness = loadGeneralTabForTest({ snapshot: initialSnapshot });
    harness.renderContent();

    const aggregate = harness.getSwitch("hideBubbles");
    const notificationPolicy = harness.core.state.mountedControls.bubblePolicyControls.get("notificationBubbleAutoCloseSeconds");
    const notificationSwitch = notificationPolicy.row.querySelector(".switch");
    const notificationSeconds = notificationPolicy.row.querySelector("input");

    const beforeRenderCount = harness.getContentRenderCount();
    harness.core.ops.applyChanges({
      changes: { hideBubbles: true, notificationBubbleAutoCloseSeconds: 0 },
      snapshot: {
        ...initialSnapshot,
        hideBubbles: true,
        notificationBubbleAutoCloseSeconds: 0,
      },
    });

    assert.strictEqual(harness.getContentRenderCount(), beforeRenderCount);
    assert.strictEqual(harness.getSwitch("hideBubbles"), aggregate);
    assert.strictEqual(aggregate.classList.contains("on"), true);
    assert.strictEqual(notificationSwitch.classList.contains("on"), false);
    assert.strictEqual(notificationSeconds.disabled, true);
    assert.strictEqual(notificationSeconds.value, "0");
  });

  it("patches pure bubble policy seconds broadcasts in place", () => {
    const initialSnapshot = makeGeneralSnapshot({
      hideBubbles: false,
      notificationBubbleAutoCloseSeconds: 0,
    });
    const harness = loadGeneralTabForTest({ snapshot: initialSnapshot });
    harness.renderContent();

    const notificationPolicy = harness.core.state.mountedControls.bubblePolicyControls.get("notificationBubbleAutoCloseSeconds");
    const notificationSwitch = notificationPolicy.row.querySelector(".switch");
    const notificationSeconds = notificationPolicy.row.querySelector("input");
    const summary = harness.core.state.mountedControls.bubblePolicySummary.element;
    assert.strictEqual(notificationSwitch.classList.contains("on"), false);
    assert.strictEqual(notificationSeconds.disabled, true);

    const beforeRenderCount = harness.getContentRenderCount();
    harness.core.ops.applyChanges({
      changes: { notificationBubbleAutoCloseSeconds: 5 },
      snapshot: { ...initialSnapshot, notificationBubbleAutoCloseSeconds: 5 },
    });

    assert.strictEqual(harness.getContentRenderCount(), beforeRenderCount);
    assert.strictEqual(notificationSwitch.classList.contains("on"), true);
    assert.strictEqual(notificationSeconds.disabled, false);
    assert.strictEqual(notificationSeconds.value, "5");
    assert.strictEqual(summary.children[1].classList.contains("accent"), true);
  });

  it("uses a roomier grid layout for Settings confirmation buttons", () => {
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    assert.ok(/\.settings-confirm-modal\s*\{[\s\S]*width:\s*min\(480px,\s*100%\);/.test(css));
    assert.ok(/\.settings-confirm-actions\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(136px,\s*1fr\)\);[\s\S]*gap:\s*9px;/.test(css));
    assert.ok(/\.settings-confirm-actions\s+\.soft-btn\s*\{[\s\S]*min-height:\s*42px;[\s\S]*padding:\s*6px 10px;[\s\S]*white-space:\s*normal;[\s\S]*text-align:\s*center;/.test(css));
  });

  it("provides a persisted collapsible Settings group helper with smart default collapse", () => {
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    assert.ok(coreSource.includes("COLLAPSED_GROUPS_STORAGE_KEY"));
    assert.ok(coreSource.includes("function buildCollapsibleGroup("));
    assert.ok(coreSource.includes("localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)"));
    assert.ok(coreSource.includes("localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY"));
    assert.ok(coreSource.includes("defaultCollapsed = false"));
    assert.ok(coreSource.includes('header.setAttribute("aria-expanded"'));
    assert.ok(coreSource.includes("collapsibleSummary"));
    assert.ok(coreSource.includes("function createDisclosureChevron("));
    assert.ok(coreSource.includes('createDisclosureChevron("collapsible-group-chevron")'));
    assert.ok(coreSource.includes('svg.setAttribute("viewBox", "0 0 20 20")'));
    assert.ok(coreSource.includes('path.setAttribute("d", "M8 5l5 5-5 5")'));
    assert.ok(!coreSource.includes('chevron.textContent = "\\u25B8";'));
    assert.ok(!coreSource.includes("chevron.innerHTML"));
    assert.ok(/\.collapsible-group-header\s*\{[\s\S]*gap:\s*4px;/.test(css));
    assert.ok(/\.collapsible-group-chevron,\s*\.anim-override-chevron\s*\{[\s\S]*display:\s*inline-flex;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;[\s\S]*width:\s*18px;[\s\S]*height:\s*18px;[\s\S]*opacity:\s*0\.72;/.test(css));
    assert.ok(/\.collapsible-group-chevron,\s*\.anim-override-chevron\s*\{[\s\S]*transform:\s*translateX\(-6px\) rotate\(0deg\);[\s\S]*transition:[\s\S]*transform 0\.22s cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\),[\s\S]*color 0\.16s ease,[\s\S]*opacity 0\.16s ease/.test(css));
    assert.ok(/\.collapsible-group-chevron svg,\s*\.anim-override-chevron svg\s*\{[\s\S]*width:\s*16px;[\s\S]*height:\s*16px;[\s\S]*overflow:\s*visible;/.test(css));
    assert.ok(/\.collapsible-group-chevron path,\s*\.anim-override-chevron path\s*\{[\s\S]*fill:\s*none;[\s\S]*stroke:\s*currentColor;[\s\S]*stroke-width:\s*2\.2;[\s\S]*stroke-linecap:\s*round;[\s\S]*stroke-linejoin:\s*round;/.test(css));
    assert.ok(/\.collapsible-group-header:hover\s+\.collapsible-group-chevron\s*\{[\s\S]*color:\s*var\(--text-secondary\);[\s\S]*opacity:\s*0\.95;/.test(css));
    assert.ok(/\.collapsible-group\.collapsed\s+\.collapsible-group-chevron\s*\{[\s\S]*transform:\s*translateX\(-6px\) rotate\(0deg\);/.test(css));
    assert.ok(/\.collapsible-group:not\(\.collapsed\)\s+\.collapsible-group-chevron\s*\{[\s\S]*transform:\s*translateX\(-6px\) rotate\(90deg\);[\s\S]*color:\s*var\(--accent\);[\s\S]*opacity:\s*1;/.test(css));
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.collapsible-group-chevron,[\s\S]*\.anim-override-chevron,[\s\S]*transition:\s*none;/.test(css));
    assert.ok(i18nSource.includes("collapsibleExpand"));
    assert.ok(i18nSource.includes("collapsibleCollapse"));
  });

  it("groups Theme cards and exposes theme import actions in Settings", () => {
    const tabSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-theme.js"), "utf8");
    const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
    const settingsIpcSource = fs.readFileSync(SETTINGS_IPC, "utf8");
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");

    assert.ok(tabSource.includes("function getThemeSections(themes)"));
    assert.ok(tabSource.includes("themeGroupBuiltIn"));
    assert.ok(tabSource.includes("themeGroupImportedCodexPets"));
    assert.ok(tabSource.includes("themeGroupUserThemes"));
    assert.ok(tabSource.includes("handleImportCodexPetZip"));
    assert.ok(tabSource.includes("handleImportUserThemeZip"));
    assert.ok(!tabSource.includes("themeOpenCodexPetsFolder"));
    assert.ok(!tabSource.includes("handleOpenCodexPetsFolder"));
    assert.ok(tabSource.includes("handleOpenUserThemesFolder"));
    assert.ok(tabSource.includes("handleRefreshThemes"));
    assert.ok(tabSource.includes("handleRemoveCodexPet"));
    assert.ok(tabSource.includes("themeUninstallPetLabel"));
    assert.ok(tabSource.includes('footer.className = "theme-card-footer";'));
    assert.ok(tabSource.includes('if (!theme.active) indicator.setAttribute("aria-hidden", "true");'));
    assert.ok(!tabSource.includes("if (theme.active || canDelete || canRemoveCodexPet)"));
    assert.ok(coreSource.includes("codexPetZipImportPending"));
    assert.ok(coreSource.includes("userThemeZipImportPending"));
    assert.ok(coreSource.includes("codexPetRemovalPendingThemeId"));
    assert.ok(preloadSource.includes("openUserThemesDir"));
    assert.ok(preloadSource.includes("importUserThemeZip"));
    assert.ok(preloadSource.includes("openCodexPetsDir"));
    assert.ok(preloadSource.includes("importCodexPetZip"));
    assert.ok(preloadSource.includes("removeCodexPet"));
    assert.ok(settingsIpcSource.includes('handle("settings:open-user-themes-dir"'));
    assert.ok(settingsIpcSource.includes('handle("settings:import-user-theme-zip"'));
    assert.ok(settingsIpcSource.includes('handle("settings:open-codex-pets-dir"'));
    assert.ok(settingsIpcSource.includes('handle("settings:import-codex-pet-zip"'));
    assert.ok(settingsIpcSource.includes('handle("settings:remove-codex-pet"'));
    assert.ok(css.includes(".theme-section-title"));
    assert.ok(css.includes(".theme-action-group"));
    assert.ok(css.includes(".theme-action-buttons"));
    assert.ok(css.includes(".theme-uninstall-btn"));
    assert.ok(/\.theme-card-footer\s*\{[^}]*min-height:\s*26px;[^}]*margin-top:\s*auto;[^}]*\}/.test(css));
    assert.ok(/\.theme-card-check\s*\{[^}]*white-space:\s*nowrap;[^}]*\}/.test(css));
    assert.ok(i18nSource.includes("themeImportPetZip"));
    assert.ok(i18nSource.includes("themeImportUserThemeZip"));
    assert.ok(i18nSource.includes("themeImportUserThemeZipHint"));
    assert.ok(i18nSource.includes("themeOpenUserThemesFolder"));
    assert.ok(i18nSource.includes("toastUserThemeZipImportOk"));
    assert.ok(i18nSource.includes("toastCodexPetZipImportOk"));
    assert.ok(i18nSource.includes("toastCodexPetRemoveOk"));

    const strings = loadSettingsI18nForTest();
    assert.strictEqual(strings.en.themeActionGroupCodexPets, "Codex Pets");
    assert.strictEqual(strings.en.themeActionGroupUserThemes, "User themes");
    assert.strictEqual(strings.en.themeImportPetZip, "Import Codex Pet package (.zip)");
    assert.strictEqual(strings.en.themeImportUserThemeZip, "Import Clawd theme package (.zip)");
    assert.ok(strings.en.themeImportUserThemeZipHint.includes("theme.json"));
    assert.strictEqual(strings.en.themeOpenUserThemesFolder, "Open themes folder");
    assert.strictEqual(strings.en.themeRefreshThemes, "Refresh themes");
    assert.strictEqual(strings.zh.themeImportPetZip, "导入 Codex Pet 包（.zip）");
    assert.strictEqual(strings.zh.themeActionGroupCodexPets, "Codex Pets");
    assert.strictEqual(strings.zh.themeImportUserThemeZip, "导入 Clawd 主题包（.zip）");
    assert.ok(strings.zh.themeImportUserThemeZipHint.includes("theme.json"));
    assert.strictEqual(strings.zh.themeOpenUserThemesFolder, "打开主题文件夹");
  });

  it("keeps Theme card footers reserved without leaking button keyboard events to card activation", async () => {
    const { content, commands } = loadThemeTabForTest({
      themes: [
        { id: "clawd", name: "Clawd", builtin: true, active: true },
        { id: "calico", name: "Calico", builtin: true, active: false },
        { id: "pet-active", name: "Pet Active", managedCodexPet: true, active: true },
        { id: "pet-inactive", name: "Pet Inactive", managedCodexPet: true, active: false },
        { id: "user-theme", name: "User Theme", active: false },
      ],
    });

    const cards = content.querySelectorAll(".theme-card");
    assert.strictEqual(cards.length, 5);
    for (const card of cards) {
      assert.ok(card.querySelector(".theme-card-footer"));
    }

    const activeChecks = cards
      .filter((card) => card.getAttribute("aria-checked") === "true")
      .map((card) => card.querySelector(".theme-card-check"));
    const inactiveChecks = cards
      .filter((card) => card.getAttribute("aria-checked") === "false")
      .map((card) => card.querySelector(".theme-card-check"));
    assert.ok(activeChecks.length > 0);
    assert.ok(inactiveChecks.length > 0);
    for (const indicator of activeChecks) {
      assert.strictEqual(indicator.getAttribute("aria-hidden"), undefined);
      assert.ok(indicator.textContent);
    }
    for (const indicator of inactiveChecks) {
      assert.strictEqual(indicator.getAttribute("aria-hidden"), "true");
      assert.strictEqual(indicator.textContent, "");
    }

    const deleteButton = content.querySelector(".theme-delete-btn");
    const inactiveUninstallButton = content.querySelectorAll(".theme-uninstall-btn")
      .find((button) => {
        const card = findAncestorByClass(button, "theme-card");
        return card && card.getAttribute("aria-checked") === "false";
      });
    assert.ok(deleteButton);
    assert.ok(inactiveUninstallButton);

    const deleteKeydown = createKeyboardEventForTest("Enter");
    deleteButton.dispatchEvent(deleteKeydown);
    const uninstallKeydown = createKeyboardEventForTest(" ");
    inactiveUninstallButton.dispatchEvent(uninstallKeydown);
    await Promise.resolve();

    assert.strictEqual(deleteKeydown.cancelBubble, true);
    assert.strictEqual(uninstallKeydown.cancelBubble, true);
    assert.strictEqual(deleteKeydown.defaultPrevented, false);
    assert.strictEqual(uninstallKeydown.defaultPrevented, false);
    assert.deepStrictEqual(commands, []);
  });

  it("animates collapsible Settings groups with measured height instead of instant hidden jumps", () => {
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
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
    assert.ok(/\.collapsible-group-body\s*\{[\s\S]*max-height:\s*var\(--collapsible-body-height,\s*0px\);/.test(css));
    assert.ok(/\.collapsible-group-body\s*\{[\s\S]*transition:\s*max-height 0\.22s cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\),\s*opacity 0\.16s ease,\s*transform 0\.18s ease,\s*padding 0\.18s ease,\s*border-color 0\.18s ease;/.test(css));
    assert.ok(/\.collapsible-group\.collapsed\s+\.collapsible-group-body\s*\{[\s\S]*opacity:\s*0;[\s\S]*transform:\s*translateY\(-4px\);/.test(css));
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.collapsible-group-body/.test(css));
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
    assert.ok(!agentsSource.includes("if (disabled || btn.classList.contains(\"active\")) return;"));
    assert.ok(agentsSource.includes("if (btn.disabled || btn.classList.contains(\"active\")) return;"));
    assert.ok(!agentsSource.includes("codex-permission-mode-transitioning"));
  });

  it("keeps Agent management switch broadcasts in place even when Codex permission rows are mounted", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          codex: {
            enabled: true,
            permissionsEnabled: true,
            permissionMode: "intercept",
          },
        },
      },
      agentMetadata: [{
        id: "codex",
        name: "Codex",
        eventSource: "hook",
        capabilities: {
          permissionApproval: true,
        },
      }],
      collapsedGroups: {
        "agents:codex": false,
      },
    });

    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();
    const before = harness.getContentRenderCount();

    harness.core.ops.applyChanges({
      changes: {
        agents: {
          codex: {
            enabled: false,
            permissionsEnabled: true,
            permissionMode: "intercept",
          },
        },
      },
      snapshot: {
        agents: {
          codex: {
            enabled: false,
            permissionsEnabled: true,
            permissionMode: "intercept",
          },
        },
      },
    });

    assert.strictEqual(
      harness.getContentRenderCount(),
      before,
      "Codex agent broadcasts should patch mounted switches instead of rebuilding and truncating switch motion"
    );
  });

  it("disables the Codex Permissions switch in place when Permission mode changes to Native", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          codex: {
            enabled: true,
            permissionsEnabled: true,
            permissionMode: "intercept",
          },
        },
      },
      agentMetadata: [{
        id: "codex",
        name: "Codex",
        eventSource: "hook",
        capabilities: {
          permissionApproval: true,
        },
      }],
      collapsedGroups: {
        "agents:codex": false,
      },
    });

    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();
    const before = harness.getContentRenderCount();

    harness.core.ops.applyChanges({
      changes: {
        agents: {
          codex: {
            enabled: true,
            permissionsEnabled: true,
            permissionMode: "native",
          },
        },
      },
      snapshot: {
        agents: {
          codex: {
            enabled: true,
            permissionsEnabled: true,
            permissionMode: "native",
          },
        },
      },
    });

    const permissionsSwitch = [...harness.core.state.mountedControls.agentSwitches.values()]
      .find((meta) => meta.agentId === "codex" && meta.flag === "permissionsEnabled");
    assert.ok(permissionsSwitch, "Codex Permissions switch should stay mounted");
    assert.strictEqual(harness.getContentRenderCount(), before);
    assert.strictEqual(permissionsSwitch.element.classList.contains("disabled"), true);
    assert.strictEqual(permissionsSwitch.element.attributes["aria-disabled"], "true");
    assert.strictEqual(permissionsSwitch.element.attributes.tabindex, "-1");
  });

  it("slides the Codex permission mode pill when mode broadcasts patch in place", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          codex: {
            enabled: true,
            permissionsEnabled: true,
            permissionMode: "intercept",
          },
        },
      },
      agentMetadata: [{
        id: "codex",
        name: "Codex",
        eventSource: "hook",
        capabilities: {
          permissionApproval: true,
        },
      }],
      collapsedGroups: {
        "agents:codex": false,
      },
    });

    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();
    const segmented = harness.content.querySelector(".codex-permission-mode-segmented");
    assert.ok(segmented, "Codex permission mode should use the sliding segmented control");
    assert.strictEqual(segmented.style.getPropertyValue("--codex-permission-mode-active-index"), "1");

    harness.core.ops.applyChanges({
      changes: {
        agents: {
          codex: {
            enabled: true,
            permissionsEnabled: true,
            permissionMode: "native",
          },
        },
      },
      snapshot: {
        agents: {
          codex: {
            enabled: true,
            permissionsEnabled: true,
            permissionMode: "native",
          },
        },
      },
    });

    assert.strictEqual(segmented.style.getPropertyValue("--codex-permission-mode-active-index"), "1");
    harness.raf.flush();
    assert.strictEqual(segmented.style.getPropertyValue("--codex-permission-mode-active-index"), "0");
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

  it("uses animated switches and local theme override patching in Animation Map", () => {
    const animMapSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-map.js"), "utf8");
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    assert.ok(animMapSource.includes("state.transientUiState.animMapSwitches"));
    assert.ok(animMapSource.includes("state.mountedControls.animMapSwitches"));
    assert.ok(animMapSource.includes("helpers.attachAnimatedSwitch(sw, {"));
    assert.ok(animMapSource.includes('command("setThemeOverrideDisabled"'));
    assert.ok(!animMapSource.includes("helpers.attachActivation(sw"));
    assert.ok(animMapSource.includes("function patchInPlace(changes)"));
    assert.ok(animMapSource.includes('Object.prototype.hasOwnProperty.call(changes, "themeOverrides")'));
    assert.ok(animMapSource.includes("helpers.setSwitchVisual(meta.element, readAnimMapVisualOn(meta.themeId, meta.stateKey), { pending: false });"));
    assert.ok(animMapSource.includes("patchInPlace,"));
    assert.ok(coreSource.includes('if (state.activeTab !== "animMap") {'));
    assert.ok(coreSource.includes("activeTab.patchInPlace(changes"));
  });

  it("keeps Animation Map theme override broadcasts in place and syncs the mounted switch", () => {
    const harness = loadAnimMapTabForTest({
      snapshot: {
        theme: "clawd",
        themeOverrides: {
          clawd: {
            states: {
              error: { disabled: false },
            },
          },
        },
      },
    });
    const sw = new FakeElement("div");
    sw.className = "switch on";
    harness.content.appendChild(sw);
    harness.core.state.mountedControls.animMapSwitches.set("clawd:error", {
      element: sw,
      themeId: "clawd",
      stateKey: "error",
    });
    const before = harness.getContentRenderCount();

    harness.core.ops.applyChanges({
      changes: {
        themeOverrides: {
          clawd: {
            states: {
              error: { disabled: true },
            },
          },
        },
      },
      snapshot: {
        theme: "clawd",
        themeOverrides: {
          clawd: {
            states: {
              error: { disabled: true },
            },
          },
        },
      },
    });

    assert.strictEqual(harness.getContentRenderCount(), before);
    assert.strictEqual(sw.classList.contains("on"), false);
    assert.strictEqual(sw.attributes["aria-checked"], "false");
  });

  it("rebuilds Animation Map instead of patching with stale theme ids when the theme changes", () => {
    const harness = loadAnimMapTabForTest({
      snapshot: {
        theme: "clawd",
        themeOverrides: {},
      },
    });
    const sw = new FakeElement("div");
    sw.className = "switch on";
    harness.content.appendChild(sw);
    harness.core.state.mountedControls.animMapSwitches.set("clawd:error", {
      element: sw,
      themeId: "clawd",
      stateKey: "error",
    });
    const before = harness.getContentRenderCount();

    harness.core.ops.applyChanges({
      changes: {
        theme: "calico",
        themeOverrides: {
          calico: {
            states: {
              error: { disabled: true },
            },
          },
        },
      },
      snapshot: {
        theme: "calico",
        themeOverrides: {
          calico: {
            states: {
              error: { disabled: true },
            },
          },
        },
      },
    });

    assert.strictEqual(
      harness.getContentRenderCount(),
      before + 1,
      "theme changes should force a rebuild so Animation Map switches use the new theme id"
    );
  });

  it("keeps stale sound override prefs resettable from the settings UI", () => {
    const overridesSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-overrides.js"), "utf8");
    assert.ok(
      overridesSource.includes("resetBtn.disabled = !slot.hasStoredOverride;"),
      "sound override row reset must stay enabled when prefs still contain a stale sound override entry"
    );
  });

  it("uses the shared SVG chevron treatment for Animation Overrides rows", () => {
    const overridesSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-overrides.js"), "utf8");
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");

    assert.ok(!overridesSource.includes('chevron.textContent = "\\u25B8";'));
    assert.ok(!overridesSource.includes("chevron.innerHTML"));
    assert.ok(overridesSource.includes('helpers.createDisclosureChevron("anim-override-chevron")'));
    assert.ok(/\.collapsible-group-chevron,\s*\.anim-override-chevron\s*\{[\s\S]*display:\s*inline-flex;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;[\s\S]*width:\s*18px;[\s\S]*height:\s*18px;[\s\S]*opacity:\s*0\.72;/.test(css));
    assert.ok(/\.collapsible-group-chevron,\s*\.anim-override-chevron\s*\{[\s\S]*transform:\s*translateX\(-6px\) rotate\(0deg\);[\s\S]*transition:[\s\S]*transform 0\.22s cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\),[\s\S]*color 0\.16s ease,[\s\S]*opacity 0\.16s ease/.test(css));
    assert.ok(/\.collapsible-group-chevron svg,\s*\.anim-override-chevron svg\s*\{[\s\S]*width:\s*16px;[\s\S]*height:\s*16px;[\s\S]*overflow:\s*visible;/.test(css));
    assert.ok(/\.collapsible-group-chevron path,\s*\.anim-override-chevron path\s*\{[\s\S]*fill:\s*none;[\s\S]*stroke:\s*currentColor;[\s\S]*stroke-width:\s*2\.2;[\s\S]*stroke-linecap:\s*round;[\s\S]*stroke-linejoin:\s*round;/.test(css));
    assert.ok(/\.anim-override-row > summary:hover \.anim-override-chevron\s*\{[\s\S]*color:\s*var\(--text-secondary\);[\s\S]*opacity:\s*0\.95;/.test(css));
    assert.ok(/\.anim-override-row\[open\]\s*>\s*summary\s+\.anim-override-chevron\s*\{[\s\S]*transform:\s*translateX\(-6px\) rotate\(90deg\);[\s\S]*color:\s*var\(--accent\);[\s\S]*opacity:\s*1;/.test(css));
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.anim-override-chevron,[\s\S]*transition:\s*none;/.test(css));
    assert.ok(/\.anim-override-thumb\s*\{[\s\S]*transform:\s*translateX\(-3px\);/.test(css));
    assert.ok(/\.anim-override-summary-text\s*\{[\s\S]*transform:\s*translateX\(-3px\);/.test(css));
    assert.ok(!/\.anim-override-summary-change\s*\{[\s\S]*translateX\(-3px\)/.test(css));
  });

  it("uses captured poster previews for trusted scripted animation override SVGs", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const previewHtml = fs.readFileSync(SETTINGS_ANIMATION_PREVIEW, "utf8");
    const overridesSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-overrides.js"), "utf8");
    const animationOverridesSource = fs.readFileSync(path.join(SRC_DIR, "settings-animation-overrides-main.js"), "utf8");
    const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
    const rendererSource = fs.readFileSync(SETTINGS_RENDERER, "utf8");

    assert.ok(html.includes("img-src 'self' data: file:"));
    assert.ok(!html.includes("frame-src"));
    assert.ok(html.includes("settings-anim-overrides-merge.js"));
    const themeTabSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-theme.js"), "utf8");
    assert.ok(!html.includes("object-src"));
    assert.ok(css.includes(".theme-thumb-atlas-frame"));
    assert.ok(css.includes("width: 800%;"));
    assert.ok(themeTabSource.includes("getCodexPetPreviewAtlasUrl"));
    assert.ok(themeTabSource.includes("theme-thumb-atlas-frame"));
    assert.ok(themeTabSource.includes("theme.codexPet.previewAtlasUrl"));
    assert.ok(!themeTabSource.includes('document.createElement("object")'));
    assert.ok(previewHtml.includes("default-src 'self' file:"));
    assert.ok(previewHtml.includes("object-src 'self' file:"));
    assert.ok(previewHtml.includes("script-src 'unsafe-inline'"));
    assert.ok(previewHtml.includes("window.renderAnimationPreviewPoster"));
    assert.ok(previewHtml.includes("width: 285%;"));
    assert.ok(animationOverridesSource.includes("ANIMATION_OVERRIDE_PREVIEW_POSTER_VERSION"));
    assert.ok(!overridesSource.includes('document.createElement("iframe")'));
    assert.ok(overridesSource.includes('if (url.protocol === "data:" || url.protocol === "blob:") return fileUrl;'));
    assert.ok(overridesSource.includes("getCardPreviewUrl(card)"));
    assert.ok(overridesSource.includes("getAssetPreviewUrl(selected)"));
    assert.ok(animationOverridesSource.includes("function needsScriptedAnimationPreviewPoster"));
    assert.ok(animationOverridesSource.includes("function isObjectChannelSvgAnimationFile"));
    assert.ok(animationOverridesSource.includes('theme.rendering.svgChannel === "object"'));
    assert.ok(animationOverridesSource.includes("function captureAnimationPreviewPosterDataUrl"));
    assert.ok(animationOverridesSource.includes("function scheduleAnimationPreviewPosters"));
    assert.ok(animationOverridesSource.includes("capturePage"));
    assert.ok(animationOverridesSource.includes("settings:animation-preview-poster-ready"));
    assert.ok(preloadSource.includes("onAnimationPreviewPosterReady"));
    assert.ok(rendererSource.includes("onAnimationPreviewPosterReady"));
    assert.ok(animationOverridesSource.includes("theme._builtin"));
    assert.ok(animationOverridesSource.includes("trustedRuntime.scriptedSvgFiles"));
    assert.ok(animationOverridesSource.includes("currentFilePreviewUrl: preview.previewImageUrl"));
    assert.ok(animationOverridesSource.includes("previewPosterPending: preview.previewPosterPending"));
    assert.ok(!animationOverridesSource.includes("function hydrateAnimationPreviewPosters"));
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
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    assert.match(css, /\.shortcut-row-control\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?min-width:\s*0;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?justify-content:\s*flex-start;[\s\S]*?\}/);
    assert.match(css, /\.shortcut-row \.row-text\s*\{[\s\S]*?flex:\s*0 0 190px;[\s\S]*?\}/);
    assert.match(css, /\.shortcut-row \.row-label\s*\{[\s\S]*?word-break:\s*keep-all;[\s\S]*?overflow-wrap:\s*normal;[\s\S]*?\}/);
    assert.match(css, /\.shortcut-value\s*\{[\s\S]*?flex:\s*1 1 190px;[\s\S]*?min-width:\s*160px;[\s\S]*?max-width:\s*286px;[\s\S]*?\}/);
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

  it("does not treat an empty hitbox override group as a reset-all override", () => {
    const core = loadSettingsCoreForTest({});
    core.state.snapshot = {
      themeOverrides: {
        cloudling: {
          hitbox: {
            wide: {},
          },
        },
      },
    };

    assert.strictEqual(core.readers.hasAnyThemeOverride("cloudling"), false);

    core.state.snapshot.themeOverrides.cloudling.hitbox.wide["cloudling-thinking.svg"] = true;
    assert.strictEqual(core.readers.hasAnyThemeOverride("cloudling"), true);
  });

  it("keeps current Animation Overrides data visible while theme override refresh is pending", () => {
    const deferred = createDeferred();
    const core = loadSettingsCoreForTest({
      getAnimationOverridesData: () => deferred.promise,
    });
    const previousData = {
      theme: { id: "cloudling", name: "Cloudling" },
      assets: [],
      sections: [{ id: "work", cards: [] }],
      cards: [],
      sounds: [],
    };
    core.state.activeTab = "animOverrides";
    core.state.snapshot = {
      theme: "cloudling",
      themeOverrides: {
        cloudling: {
          states: {
            thinking: {
              transition: { in: 120, out: 180 },
            },
          },
        },
      },
    };
    core.runtime.animationOverridesData = previousData;

    let renderCount = 0;
    core.ops.installRenderHooks({
      sidebar: () => {},
      content: () => {
        renderCount++;
      },
      modal: () => {},
    });
    core.ops.applyChanges({
      changes: {
        themeOverrides: {
          cloudling: {
            states: {
              thinking: {
                transition: { in: 220, out: 180 },
              },
            },
          },
        },
      },
      snapshot: core.state.snapshot,
    });

    assert.strictEqual(
      core.runtime.animationOverridesData,
      previousData,
      "Animation Overrides should keep the last rendered data while the async refresh is pending"
    );
    assert.strictEqual(renderCount, 0, "pending refresh should not immediately rerender into an empty loading page");
  });

  it("lets Animation Overrides patch theme override broadcasts before a full content render", () => {
    const core = loadSettingsCoreForTest({
      getAnimationOverridesData: () => Promise.resolve({ cards: [], sections: [], sounds: [] }),
    });
    core.state.activeTab = "animOverrides";
    core.state.snapshot = {
      theme: "cloudling",
      themeOverrides: {},
    };
    core.runtime.animationOverridesData = {
      theme: { id: "cloudling", name: "Cloudling" },
      assets: [],
      sections: [],
      cards: [],
      sounds: [],
    };

    let patchCount = 0;
    let contentRenderCount = 0;
    core.tabs.animOverrides = {
      patchInPlace(changes) {
        patchCount++;
        assert.ok(changes && Object.prototype.hasOwnProperty.call(changes, "themeOverrides"));
        return true;
      },
    };
    core.ops.installRenderHooks({
      sidebar: () => {},
      content: () => {
        contentRenderCount++;
      },
      modal: () => {},
    });

    core.ops.applyChanges({
      changes: { themeOverrides: { cloudling: { states: {} } } },
      snapshot: core.state.snapshot,
    });

    assert.strictEqual(patchCount, 1);
    assert.strictEqual(contentRenderCount, 0);
  });

  it("renders visible loading text for the initial Animation Overrides fetch", () => {
    const runtime = {
      animationOverridesData: null,
      animOverridesSubtab: "animations",
      expandedOverrideRowIds: new Set(),
      assetPicker: {
        state: null,
        pollTimer: null,
      },
    };
    const modalRoot = new FakeElement("div");
    const { core } = loadAnimOverridesTabForTest({ runtime, modalRoot });
    const parent = new FakeElement("main");

    core.tabs.animOverrides.render(parent, core);

    const placeholders = parent.querySelectorAll(".placeholder-desc");
    assert.ok(placeholders.length > 0);
    assert.strictEqual(placeholders[0].textContent, "animOverridesLoading");
  });

  it("renders Animation Overrides theme actions in two intentional rows", () => {
    const runtime = createAnimOverridesRuntime(createAnimOverrideCard());
    const modalRoot = new FakeElement("div");
    const { core } = loadAnimOverridesTabForTest({ runtime, modalRoot });
    const parent = new FakeElement("main");

    core.tabs.animOverrides.render(parent, core);

    const meta = parent.querySelector(".anim-override-meta");
    assert.ok(meta);
    assert.deepStrictEqual(
      meta.querySelectorAll(".anim-override-meta-label").map((label) => label.textContent),
      ["animOverridesCurrentTheme: Cloudling", "animOverridesReplacementConfig"]
    );

    const primary = meta.querySelector(".anim-override-meta-primary-actions");
    const secondary = meta.querySelector(".anim-override-meta-secondary-actions");
    assert.deepStrictEqual(
      primary.querySelectorAll("button").map((button) => button.textContent),
      ["animOverridesOpenThemeTab", "animOverridesOpenAssets"]
    );
    assert.deepStrictEqual(
      secondary.querySelectorAll("button").map((button) => button.textContent),
      ["animOverridesImport", "animOverridesExport", "animOverridesResetAll"]
    );
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    assert.match(
      css,
      /\.anim-override-meta\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/
    );
    assert.match(
      css,
      /\.anim-override-meta-actions\s*\{[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*flex-end;/
    );
    assert.match(
      css,
      /@media \(max-width:\s*640px\)\s*\{[\s\S]*\.anim-override-meta-actions\s*\{[\s\S]*justify-content:\s*flex-start;/
    );

    const strings = loadSettingsI18nForTest();
    assert.strictEqual(strings.en.animOverridesReplacementConfig, "Animation override settings");
    assert.strictEqual(strings.zh.animOverridesReplacementConfig, "动画覆盖设置");
    assert.strictEqual(strings.ko.animOverridesReplacementConfig, "애니메이션 덮어쓰기 설정");
    assert.strictEqual(strings.ja.animOverridesReplacementConfig, "アニメーション上書き設定");
    assert.strictEqual(strings.en.animOverridesImport, "Import config…");
    assert.strictEqual(strings.zh.animOverridesImport, "导入配置…");
    assert.strictEqual(strings.ko.animOverridesImport, "설정 가져오기…");
    assert.strictEqual(strings.ja.animOverridesImport, "設定をインポート…");
    assert.strictEqual(strings.en.animOverridesExport, "Export config…");
    assert.strictEqual(strings.zh.animOverridesExport, "导出配置…");
    assert.strictEqual(strings.ko.animOverridesExport, "설정 내보내기…");
    assert.strictEqual(strings.ja.animOverridesExport, "設定をエクスポート…");
    assert.strictEqual(strings.en.animOverridesResetAll, "Restore theme defaults");
    assert.strictEqual(strings.zh.animOverridesResetAll, "恢复主题默认");
    assert.strictEqual(strings.ko.animOverridesResetAll, "테마 기본값으로 복원");
    assert.strictEqual(strings.ja.animOverridesResetAll, "テーマのデフォルトに戻す");
    assert.match(
      css,
      /@media \(max-width:\s*640px\)\s*\{[\s\S]*\.anim-override-meta\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\);/
    );
  });

  it("does not build Animation Overrides theme actions on the Sounds subtab", () => {
    const runtime = createAnimOverridesRuntime(createAnimOverrideCard(), { animOverridesSubtab: "sounds" });
    const modalRoot = new FakeElement("div");
    let activationCount = 0;
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      helpersOverrides: {
        attachActivation: (el, invoke) => {
          activationCount += 1;
          if (typeof invoke === "function") el.addEventListener("click", () => invoke());
          return el;
        },
      },
    });
    const parent = new FakeElement("main");

    core.tabs.animOverrides.render(parent, core);

    assert.strictEqual(parent.querySelector(".anim-override-meta"), null);
    assert.strictEqual(activationCount, 1, "only the Sounds directory button should be wired");
  });

  it("uses specific fade timing labels and gives the slider label enough room", () => {
    const strings = loadSettingsI18nForTest();
    assert.strictEqual(strings.en.animOverridesFadeIn, "Fade in on enter");
    assert.strictEqual(strings.en.animOverridesFadeOut, "Fade out on exit");
    assert.strictEqual(strings.zh.animOverridesFadeIn, "进入时淡入");
    assert.strictEqual(strings.zh.animOverridesFadeOut, "退出时淡出");
    assert.strictEqual(strings.ko.animOverridesFadeIn, "진입 시 페이드 인");
    assert.strictEqual(strings.ko.animOverridesFadeOut, "종료 시 페이드 아웃");
    assert.strictEqual(strings.ja.animOverridesFadeIn, "開始時フェードイン");
    assert.strictEqual(strings.ja.animOverridesFadeOut, "終了時フェードアウト");

    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    assert.match(
      css,
      /\.anim-override-slider-row\s*\{[\s\S]*grid-template-columns:\s*96px minmax\(0,\s*1fr\) 100px;/
    );
    assert.match(
      css,
      /\.anim-override-number-field\s*\{[\s\S]*display:\s*inline-flex;[\s\S]*white-space:\s*nowrap;/
    );
    assert.match(
      css,
      /\.anim-override-slider-row input\[type="number"\]\s*\{[\s\S]*width:\s*76px;[\s\S]*text-align:\s*center;/
    );
    assert.match(
      css,
      /\.anim-override-slider-row input\[type="range"\]\s*\{[\s\S]*--anim-override-fill:\s*0%;/
    );
    assert.match(
      css,
      /\.anim-override-slider-row input\[type="range"\]::-webkit-slider-runnable-track\s*\{[\s\S]*var\(--accent\) var\(--anim-override-fill\)/
    );
    assert.match(
      css,
      /\.anim-override-slider-row input\[type="range"\]::-webkit-slider-runnable-track\s*\{[\s\S]*var\(--row-border\) var\(--anim-override-fill\)/
    );
    assert.match(
      css,
      /\.anim-override-slider-row input\[type="range"\]::-webkit-slider-thumb\s*\{[\s\S]*-webkit-appearance:\s*none;[\s\S]*box-shadow:/
    );
    assert.match(
      css,
      /\.anim-override-slider-row input\[type="range"\]::-webkit-slider-thumb\s*\{[\s\S]*color-mix\(in srgb,\s*var\(--accent\)/
    );
    assert.match(
      css,
      /\.anim-override-slider-row input\[type="range"\]:hover::-webkit-slider-thumb\s*\{[\s\S]*transform:\s*scale\(1\.08\);/
    );
    assert.match(
      css,
      /@media \(forced-colors:\s*active\)\s*\{[\s\S]*accent-color:\s*Highlight;/
    );
  });

  it("keeps committed slider timing visible across a stale animation override refresh", async () => {
    const card = {
      id: "state:thinking",
      slotType: "state",
      stateKey: "thinking",
      triggerKind: "thinking",
      currentFile: "cloudling-thinking.svg",
      currentFileUrl: "file:///themes/cloudling/assets/cloudling-thinking.svg",
      currentFilePreviewUrl: "file:///themes/cloudling/assets/cloudling-thinking.svg",
      bindingLabel: "states.thinking[0]",
      transition: { in: 120, out: 180 },
      supportsAutoReturn: false,
      supportsDuration: false,
      assetCycleMs: 1000,
      assetCycleStatus: "ok",
      suggestedDurationMs: null,
      suggestedDurationStatus: "unavailable",
      previewDurationMs: 1000,
      displayHintWarning: false,
      displayHintTarget: null,
      fallbackTargetState: null,
      wideHitboxEnabled: false,
      wideHitboxOverridden: false,
      aspectRatioWarning: null,
    };
    const runtime = {
      animationOverridesData: {
        theme: { id: "cloudling", name: "Cloudling" },
        assets: [],
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
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: () => Promise.resolve({ status: "ok" }),
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => Promise.resolve(runtime.animationOverridesData),
      },
    });
    const parent = new FakeElement("main");
    let contentRenderCount = 0;
    const renderContent = () => {
      contentRenderCount++;
      parent.innerHTML = "";
      core.tabs.animOverrides.render(parent, core);
    };
    core.ops.requestRender = ({ content = false, modal = false } = {}) => {
      if (content) renderContent();
      if (modal && typeof core.renderHooks.modal === "function") core.renderHooks.modal();
    };
    renderContent();

    const range = parent.querySelectorAll("input").find((input) => input.type === "range");
    assert.ok(range, "expanded animation override row should render a fade-in range input");
    assert.strictEqual(range.style.getPropertyValue("--anim-override-fill"), "12%");
    range.value = "260";
    for (const listener of range.eventListeners.input || []) listener();
    assert.strictEqual(range.style.getPropertyValue("--anim-override-fill"), "26%");
    for (const listener of range.eventListeners.change || []) listener();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const nextRange = parent.querySelectorAll("input").find((input) => input.type === "range");
    assert.strictEqual(contentRenderCount, 1, "timing slider commits should not rebuild the content pane");
    assert.strictEqual(nextRange, range, "timing slider commits should keep the mounted range control in place");
    assert.strictEqual(
      nextRange.value,
      "260",
      "stale refreshes should not flash the slider back to the old committed timing"
    );
  });

  it("updates Animation Overrides reset affordances after the first timing commit", async () => {
    const card = createAnimOverrideCard({
      transition: { in: 150, out: 150 },
      transitionThemeDefault: { in: 150, out: 150 },
      hasTransitionOverride: false,
    });
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const payloads = [];
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: (_name, payload) => {
          payloads.push(payload);
          return Promise.resolve({ status: "ok" });
        },
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => {
          Object.assign(runtime.animationOverridesData.cards[0], {
            transition: { in: 160, out: 150 },
            transitionThemeDefault: { in: 150, out: 150 },
            hasTransitionOverride: true,
          });
          return Promise.resolve(runtime.animationOverridesData);
        },
      },
    });
    const parent = new FakeElement("main");
    let contentRenderCount = 0;
    const renderContent = () => {
      contentRenderCount++;
      parent.innerHTML = "";
      core.tabs.animOverrides.render(parent, core);
    };
    core.ops.requestRender = ({ content = false, modal = false } = {}) => {
      if (content) renderContent();
      if (modal && typeof core.renderHooks.modal === "function") core.renderHooks.modal();
    };
    renderContent();

    const range = parent.querySelectorAll("input").find((input) => input.type === "range");
    const resetButton = parent.querySelectorAll("button").find((button) => button.textContent === "animOverridesReset");
    assert.ok(range);
    assert.ok(resetButton);
    assert.strictEqual(resetButton.disabled, true);
    assert.strictEqual(parent.querySelector(".anim-override-badge-dot"), null);

    range.value = "160";
    for (const listener of range.eventListeners.input || []) listener();
    for (const listener of range.eventListeners.change || []) listener();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].transitionThemeDefault.in, 150);
    assert.strictEqual(payloads[0].transitionThemeDefault.out, 150);
    assert.strictEqual(contentRenderCount, 1, "timing-only commits should keep the content DOM mounted");
    assert.strictEqual(resetButton.disabled, false, "first timing commit should enable the slot reset button");
    assert.ok(parent.querySelector(".anim-override-badge-dot"), "first timing commit should show the changed badge");
  });

  it("clears Animation Overrides reset affordances when timing returns to the theme default", async () => {
    const card = createAnimOverrideCard({
      transition: { in: 160, out: 150 },
      transitionThemeDefault: { in: 150, out: 150 },
      hasTransitionOverride: true,
    });
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const payloads = [];
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: (_name, payload) => {
          payloads.push(payload);
          return Promise.resolve({ status: "ok" });
        },
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => {
          Object.assign(runtime.animationOverridesData.cards[0], {
            transition: { in: 150, out: 150 },
            transitionThemeDefault: { in: 150, out: 150 },
            hasTransitionOverride: false,
          });
          return Promise.resolve(runtime.animationOverridesData);
        },
      },
      readersOverrides: {
        readThemeOverrideMap: () => ({
          states: {
            thinking: {
              transition: { in: 160, out: 150 },
            },
          },
        }),
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const range = parent.querySelectorAll("input").find((input) => input.type === "range");
    const resetButton = parent.querySelectorAll("button").find((button) => button.textContent === "animOverridesReset");
    assert.ok(range);
    assert.ok(resetButton);
    assert.strictEqual(resetButton.disabled, false);
    assert.ok(parent.querySelector(".anim-override-badge-dot"));

    range.value = "150";
    for (const listener of range.eventListeners.input || []) listener();
    for (const listener of range.eventListeners.change || []) listener();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].transition.in, 150);
    assert.strictEqual(payloads[0].transition.out, 150);
    assert.strictEqual(payloads[0].transitionThemeDefault.in, 150);
    assert.strictEqual(payloads[0].transitionThemeDefault.out, 150);
    assert.strictEqual(resetButton.disabled, true, "returning to default timing should disable slot reset");
    assert.strictEqual(parent.querySelector(".anim-override-badge-dot"), null);
  });

  it("keeps sequential fade timing commits from reverting the previous side", async () => {
    const card = createAnimOverrideCard();
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const payloads = [];
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: (_name, payload) => {
          payloads.push(payload);
          return Promise.resolve({ status: "ok" });
        },
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => Promise.resolve(runtime.animationOverridesData),
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const ranges = parent.querySelectorAll("input").filter((input) => input.type === "range");
    assert.ok(ranges.length >= 2, "expanded row should render fade in and fade out sliders");

    ranges[0].value = "260";
    for (const listener of ranges[0].eventListeners.input || []) listener();
    for (const listener of ranges[0].eventListeners.change || []) listener();
    await Promise.resolve();
    await Promise.resolve();

    ranges[1].value = "300";
    for (const listener of ranges[1].eventListeners.input || []) listener();
    for (const listener of ranges[1].eventListeners.change || []) listener();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(payloads.length, 2);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(payloads[0].transition)), { in: 260, out: 180 });
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(payloads[1].transition)),
      { in: 260, out: 300 },
      "second fade commit should use the pending/latest fade-in value, not the stale rendered card"
    );
  });

  it("does not submit duplicate animation timing commands on number change followed by blur", async () => {
    const card = {
      id: "state:thinking",
      slotType: "state",
      stateKey: "thinking",
      triggerKind: "thinking",
      currentFile: "cloudling-thinking.svg",
      currentFileUrl: "file:///themes/cloudling/assets/cloudling-thinking.svg",
      currentFilePreviewUrl: "file:///themes/cloudling/assets/cloudling-thinking.svg",
      bindingLabel: "states.thinking[0]",
      transition: { in: 120, out: 180 },
      supportsAutoReturn: false,
      supportsDuration: false,
      assetCycleMs: 1000,
      assetCycleStatus: "ok",
      suggestedDurationMs: null,
      suggestedDurationStatus: "unavailable",
      previewDurationMs: 1000,
      displayHintWarning: false,
      displayHintTarget: null,
      fallbackTargetState: null,
      wideHitboxEnabled: false,
      wideHitboxOverridden: false,
      aspectRatioWarning: null,
    };
    const runtime = {
      animationOverridesData: {
        theme: { id: "cloudling", name: "Cloudling" },
        assets: [],
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
    let commandCount = 0;
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: () => {
          commandCount++;
          return Promise.resolve({ status: "ok" });
        },
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => Promise.resolve(runtime.animationOverridesData),
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const inputs = parent.querySelectorAll("input");
    const range = inputs.find((input) => input.type === "range");
    const number = inputs.find((input) => input.type === "number");
    assert.ok(range, "expanded animation override row should render a fade-in range input");
    assert.ok(number, "expanded animation override row should render a fade-in number input");
    assert.ok(number.parentNode.classList.contains("anim-override-number-field"));
    const unit = number.parentNode.querySelector(".anim-override-slider-unit");
    assert.ok(unit, "timing number input should render an inline unit label");
    assert.strictEqual(unit.textContent, "ms");
    number.value = "260";
    for (const listener of number.eventListeners.input || []) listener();
    assert.strictEqual(range.style.getPropertyValue("--anim-override-fill"), "26%");
    for (const listener of number.eventListeners.change || []) listener();
    for (const listener of number.eventListeners.blur || []) listener();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(commandCount, 1);
  });

  it("renders the wide hitbox control as a scoped toggle instead of a full-row label", () => {
    const card = createAnimOverrideCard();
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const { core } = loadAnimOverridesTabForTest({ runtime, modalRoot });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const row = parent.querySelector(".anim-override-toggle-row");
    const input = parent.querySelectorAll("input").find((candidate) => candidate.type === "checkbox");
    const title = parent.querySelector(".anim-override-toggle-title");

    assert.ok(row, "expanded animation override row should render a wide-hitbox toggle row");
    assert.strictEqual(row.tagName, "DIV");
    assert.strictEqual(input.getAttribute("aria-label"), "animOverridesWideHitboxToggle");
    assert.ok(title);
    assert.strictEqual((title.eventListeners.click || []).length, 0);
  });

  it("uses null to clear wide hitbox overrides that match the theme default and avoids rebuilding content", async () => {
    const card = createAnimOverrideCard({
      wideHitboxEnabled: false,
      wideHitboxOverridden: false,
      wideHitboxThemeDefault: false,
    });
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const payloads = [];
    let fetchCount = 0;
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: (_name, payload) => {
          payloads.push(payload);
          return Promise.resolve({ status: "ok" });
        },
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => {
          fetchCount++;
          Object.assign(runtime.animationOverridesData.cards[0], fetchCount === 1
            ? {
                wideHitboxEnabled: true,
                wideHitboxOverridden: true,
                wideHitboxThemeDefault: false,
              }
            : {
                wideHitboxEnabled: false,
                wideHitboxOverridden: false,
                wideHitboxThemeDefault: false,
              });
          return Promise.resolve(runtime.animationOverridesData);
        },
      },
    });
    const parent = new FakeElement("main");
    let contentRenderCount = 0;
    const renderContent = () => {
      contentRenderCount++;
      parent.innerHTML = "";
      core.tabs.animOverrides.render(parent, core);
    };
    core.ops.requestRender = ({ content = false, modal = false } = {}) => {
      if (content) renderContent();
      if (modal && typeof core.renderHooks.modal === "function") core.renderHooks.modal();
    };
    renderContent();

    const toggle = parent.querySelectorAll("input").find((input) => input.type === "checkbox");
    assert.ok(toggle, "expanded animation override row should render a wide-hitbox checkbox");

    toggle.checked = true;
    for (const listener of toggle.eventListeners.change || []) listener();
    await Promise.resolve();
    await Promise.resolve();
    let resetButton = parent.querySelectorAll("button").find((button) => button.textContent === "animOverridesReset");
    assert.ok(parent.querySelector(".anim-override-badge-dot"), "wide-hitbox commit should update the summary changed badge in place");
    assert.strictEqual(resetButton.disabled, false, "wide-hitbox commit should enable reset affordance in place");

    toggle.checked = false;
    for (const listener of toggle.eventListeners.change || []) listener();
    await Promise.resolve();
    await Promise.resolve();
    resetButton = parent.querySelectorAll("button").find((button) => button.textContent === "animOverridesReset");
    assert.strictEqual(parent.querySelector(".anim-override-badge-dot"), null, "theme-default hitbox commit should clear the changed badge in place");
    assert.strictEqual(resetButton.disabled, true, "theme-default hitbox commit should disable reset affordance in place");

    assert.strictEqual(payloads.length, 2);
    assert.strictEqual(payloads[0].enabled, true);
    assert.strictEqual(payloads[1].enabled, null);
    assert.strictEqual(contentRenderCount, 1, "wide-hitbox toggle commits should not rebuild the content pane");
  });

  it("shows the wide hitbox reset chip for stale overrides that already match the theme default", () => {
    const card = createAnimOverrideCard({
      wideHitboxEnabled: false,
      wideHitboxOverridden: true,
      wideHitboxThemeDefault: false,
    });
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const { core } = loadAnimOverridesTabForTest({ runtime, modalRoot });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const resetChip = parent.querySelectorAll("button")
      .find((button) => button.textContent === "animOverridesWideHitboxResetToTheme");
    assert.ok(resetChip, "wide-hitbox reset chip should render for stale no-op overrides");
    assert.strictEqual(resetChip.hidden, false);
    assert.strictEqual(resetChip.disabled, false);
  });

  it("shows a fallback error detail when wide hitbox saves fail without a message", async () => {
    const card = createAnimOverrideCard();
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const toasts = [];
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: () => Promise.resolve({ status: "error" }),
      },
      opsOverrides: {
        showToast: (message) => toasts.push(message),
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const toggle = parent.querySelectorAll("input").find((input) => input.type === "checkbox");
    toggle.checked = true;
    for (const listener of toggle.eventListeners.change || []) listener();
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(toasts.some((message) => String(message).includes("unknown error")));
  });

  it("preserves pending wide hitbox state across full Animation Overrides rerenders", async () => {
    const card = createAnimOverrideCard({
      wideHitboxEnabled: false,
      wideHitboxOverridden: false,
      wideHitboxThemeDefault: false,
    });
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    let resolveCommand;
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: () => new Promise((resolve) => {
          resolveCommand = resolve;
        }),
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => {
          Object.assign(runtime.animationOverridesData.cards[0], {
            wideHitboxEnabled: true,
            wideHitboxOverridden: true,
            wideHitboxThemeDefault: false,
          });
          return Promise.resolve(runtime.animationOverridesData);
        },
      },
    });
    const parent = new FakeElement("main");
    const renderContent = () => {
      parent.innerHTML = "";
      core.tabs.animOverrides.render(parent, core);
    };
    core.ops.requestRender = ({ content = false, modal = false } = {}) => {
      if (content) renderContent();
      if (modal && typeof core.renderHooks.modal === "function") core.renderHooks.modal();
    };
    renderContent();

    let toggle = parent.querySelectorAll("input").find((input) => input.type === "checkbox");
    assert.ok(toggle, "expanded animation override row should render a wide-hitbox checkbox");

    toggle.checked = true;
    for (const listener of toggle.eventListeners.change || []) listener();

    renderContent();

    toggle = parent.querySelectorAll("input").find((input) => input.type === "checkbox");
    const resetChip = parent.querySelectorAll("button")
      .find((button) => button.textContent === "animOverridesWideHitboxResetToTheme");
    let resetButton = parent.querySelectorAll("button")
      .find((button) => button.textContent === "animOverridesReset");
    assert.ok(toggle, "wide-hitbox checkbox should still exist after rerender");
    assert.strictEqual(toggle.checked, true, "pending wide-hitbox toggles should stay on across rerenders");
    assert.strictEqual(toggle.disabled, true, "pending wide-hitbox toggles should stay disabled across rerenders");
    assert.ok(resetChip, "wide-hitbox reset chip should still exist after rerender");
    assert.strictEqual(resetChip.hidden, false, "pending wide-hitbox rerenders should keep the reset chip visible");
    assert.strictEqual(resetChip.disabled, true, "pending wide-hitbox rerenders should keep the reset chip disabled");
    assert.ok(resetButton, "pending wide-hitbox rerenders should keep the slot reset button mounted");
    assert.strictEqual(resetButton.disabled, true, "slot reset should stay disabled while a wide-hitbox edit is pending");

    resolveCommand({ status: "ok" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    toggle = parent.querySelectorAll("input").find((input) => input.type === "checkbox");
    resetButton = parent.querySelectorAll("button")
      .find((button) => button.textContent === "animOverridesReset");
    assert.strictEqual(toggle.checked, true);
    assert.strictEqual(toggle.disabled, false);
    assert.strictEqual(resetButton.disabled, false);
  });

  it("blocks wide hitbox edits while a same-card timing edit is pending", async () => {
    const card = createAnimOverrideCard();
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const calls = [];
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: (name, payload) => {
          calls.push({ name, payload });
          return new Promise(() => {});
        },
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const range = parent.querySelectorAll("input").find((input) => input.type === "range");
    const toggle = parent.querySelectorAll("input").find((input) => input.type === "checkbox");
    range.value = "260";
    for (const listener of range.eventListeners.change || []) listener();

    assert.strictEqual(toggle.disabled, true, "wide-hitbox toggle should be blocked while timing is pending");
    toggle.checked = true;
    for (const listener of toggle.eventListeners.change || []) listener();
    await Promise.resolve();

    assert.deepStrictEqual(
      calls.map((call) => call.name),
      ["setAnimationOverride"],
      "blocked wide-hitbox changes should not enqueue a second override command"
    );
  });

  it("blocks slot reset while a same-card timing edit is pending", async () => {
    const card = createAnimOverrideCard({
      hasTransitionOverride: true,
    });
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const calls = [];
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: (name, payload) => {
          calls.push({ name, payload });
          return new Promise(() => {});
        },
      },
      readersOverrides: {
        readThemeOverrideMap: () => ({
          states: {
            thinking: {
              transition: { in: 120, out: 180 },
            },
          },
        }),
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const range = parent.querySelectorAll("input").find((input) => input.type === "range");
    const resetButton = parent.querySelectorAll("button").find((button) => button.textContent === "animOverridesReset");
    range.value = "260";
    for (const listener of range.eventListeners.change || []) listener();

    assert.strictEqual(resetButton.disabled, true, "slot reset should be blocked while timing is pending");
    for (const listener of resetButton.eventListeners.click || []) listener();
    await Promise.resolve();

    assert.deepStrictEqual(
      calls.map((call) => call.name),
      ["setAnimationOverride"],
      "blocked slot reset should not enqueue a reset command"
    );
  });

  it("blocks timing edits while a same-card wide hitbox edit is pending", async () => {
    const card = createAnimOverrideCard();
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const calls = [];
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: (name, payload) => {
          calls.push({ name, payload });
          return new Promise(() => {});
        },
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const toggle = parent.querySelectorAll("input").find((input) => input.type === "checkbox");
    const range = parent.querySelectorAll("input").find((input) => input.type === "range");
    toggle.checked = true;
    for (const listener of toggle.eventListeners.change || []) listener();

    assert.strictEqual(range.disabled, true, "timing slider should be blocked while wide-hitbox is pending");
    range.value = "260";
    for (const listener of range.eventListeners.change || []) listener();
    await Promise.resolve();

    assert.deepStrictEqual(
      calls.map((call) => call.name),
      ["setWideHitboxOverride"],
      "blocked timing changes should not enqueue a second override command"
    );
  });

  it("reconciles acknowledged pending wide hitbox edits during Animation Overrides render", () => {
    const card = createAnimOverrideCard({
      wideHitboxEnabled: true,
      wideHitboxOverridden: true,
      wideHitboxThemeDefault: false,
    });
    const runtime = createAnimOverridesRuntime(card);
    runtime.pendingWideHitboxOverrideEdits = new Map([[
      card.id,
      {
        seq: 1,
        currentFile: card.currentFile,
        themeDefault: false,
        effectiveEnabled: true,
        commandEnabled: true,
      },
    ]]);
    const modalRoot = new FakeElement("div");
    const { core } = loadAnimOverridesTabForTest({ runtime, modalRoot });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const toggle = parent.querySelectorAll("input").find((input) => input.type === "checkbox");
    const resetButton = parent.querySelectorAll("button")
      .find((button) => button.textContent === "animOverridesReset");
    assert.strictEqual(runtime.pendingWideHitboxOverrideEdits.size, 0);
    assert.strictEqual(toggle.disabled, false);
    assert.strictEqual(resetButton.disabled, false);
  });

  it("treats hitbox-only overrides as overridden for summary badges and reset actions", () => {
    const card = createAnimOverrideCard({
      wideHitboxEnabled: true,
      wideHitboxOverridden: true,
      wideHitboxThemeDefault: false,
    });
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      readersOverrides: {
        hasAnyThemeOverride: () => true,
        readThemeOverrideMap: () => ({
          hitbox: {
            wide: {
              "cloudling-thinking.svg": true,
            },
          },
        }),
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const summaryDot = parent.querySelector(".anim-override-badge-dot");
    const resetButton = parent.querySelectorAll("button").find((button) => button.textContent === "animOverridesReset");

    assert.ok(summaryDot, "hitbox-only overrides should still show the overridden summary badge");
    assert.ok(resetButton, "expanded row should render a reset button");
    assert.strictEqual(resetButton.disabled, false, "hitbox-only overrides should enable the reset button");
  });

  it("clears hitbox-only overrides when resetting an animation override slot", async () => {
    const card = createAnimOverrideCard({
      wideHitboxEnabled: true,
      wideHitboxOverridden: true,
      wideHitboxThemeDefault: false,
    });
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const calls = [];
    let resolveAnimationReset;
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: (name, payload) => {
          calls.push({ name, payload });
          if (name === "setAnimationOverride") {
            return new Promise((resolve) => {
              resolveAnimationReset = resolve;
            });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => Promise.resolve(runtime.animationOverridesData),
      },
      readersOverrides: {
        readThemeOverrideMap: () => ({
          hitbox: {
            wide: {
              "cloudling-thinking.svg": true,
            },
          },
        }),
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const resetButton = parent.querySelectorAll("button").find((button) => button.textContent === "animOverridesReset");
    assert.ok(resetButton, "expanded row should render a reset button");
    const resetPromises = (resetButton.eventListeners.click || []).map((listener) => listener());
    await Promise.resolve();
    await Promise.resolve();

    const toggleWhileResetPending = parent.querySelectorAll("input").find((input) => input.type === "checkbox");
    const resetChipWhileResetPending = parent.querySelectorAll("button")
      .find((button) => button.textContent === "animOverridesWideHitboxResetToTheme");
    assert.strictEqual(toggleWhileResetPending.disabled, true, "slot reset should block wide-hitbox toggles while pending");
    assert.strictEqual(resetChipWhileResetPending.disabled, true, "slot reset should block wide-hitbox reset chips while pending");

    resolveAnimationReset({ status: "ok" });
    await Promise.all(resetPromises);

    assert.deepStrictEqual(
      calls.map((call) => call.name),
      ["setAnimationOverride", "setWideHitboxOverride"]
    );
    assert.strictEqual(calls[1].payload.enabled, null);
    assert.strictEqual(runtime.pendingWideHitboxOverrideEdits.size, 0);
    assert.strictEqual(runtime.pendingAnimationOverrideResets.size, 0);
  });

  it("clears hitbox overrides for the pre-reset replacement file when resetting a slot", async () => {
    const replacementFile = "replacement-thinking.svg";
    const baseFile = "cloudling-thinking.svg";
    const card = createAnimOverrideCard({
      currentFile: replacementFile,
      wideHitboxEnabled: true,
      wideHitboxOverridden: true,
      wideHitboxThemeDefault: false,
    });
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const calls = [];
    let resolveAnimationReset;
    let fetchCount = 0;
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: (name, payload) => {
          calls.push({ name, payload });
          if (name === "setAnimationOverride") {
            return new Promise((resolve) => {
              resolveAnimationReset = resolve;
            });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => {
          fetchCount++;
          if (fetchCount === 1) {
            Object.assign(runtime.animationOverridesData.cards[0], {
              currentFile: baseFile,
              wideHitboxEnabled: true,
              wideHitboxOverridden: false,
              wideHitboxThemeDefault: true,
            });
          }
          return Promise.resolve(runtime.animationOverridesData);
        },
      },
      readersOverrides: {
        readThemeOverrideMap: () => ({
          states: {
            thinking: {
              file: replacementFile,
            },
          },
          hitbox: {
            wide: {
              [replacementFile]: true,
            },
          },
        }),
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const resetButton = parent.querySelectorAll("button").find((button) => button.textContent === "animOverridesReset");
    assert.ok(resetButton, "expanded row should render a reset button");
    const resetPromises = (resetButton.eventListeners.click || []).map((listener) => listener());
    await Promise.resolve();
    await Promise.resolve();

    resolveAnimationReset({ status: "ok" });
    await Promise.all(resetPromises);

    assert.deepStrictEqual(
      calls.map((call) => call.name),
      ["setAnimationOverride", "setWideHitboxOverride"]
    );
    assert.strictEqual(calls[1].payload.file, replacementFile);
    assert.strictEqual(calls[1].payload.enabled, null);
    assert.strictEqual(runtime.pendingWideHitboxOverrideEdits.size, 0);
    assert.strictEqual(runtime.pendingAnimationOverrideResets.size, 0);
    const toggle = parent.querySelectorAll("input").find((input) => input.type === "checkbox");
    assert.strictEqual(toggle.checked, true, "base file wide-hitbox default should be restored after reset");
    assert.strictEqual(toggle.disabled, false);
  });

  it("clears pending timing edits when animation override commands reject", async () => {
    const card = createAnimOverrideCard();
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const toasts = [];
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: () => Promise.reject(new Error("ipc failed")),
      },
      opsOverrides: {
        showToast: (message) => toasts.push(message),
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const range = parent.querySelectorAll("input").find((input) => input.type === "range");
    const toggle = parent.querySelectorAll("input").find((input) => input.type === "checkbox");
    range.value = "260";
    for (const listener of range.eventListeners.change || []) listener();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(runtime.pendingAnimationOverrideEdits.size, 0);
    assert.strictEqual(toggle.disabled, false, "wide-hitbox toggle should unlock after a rejected timing command");
    assert.ok(toasts.some((message) => String(message).includes("ipc failed")));
  });

  it("treats reaction-only overrides as overridden for summary badges and reset actions", () => {
    const card = createAnimOverrideCard({
      id: "reaction:clickLeft",
      slotType: "reaction",
      reactionKey: "clickLeft",
      stateKey: undefined,
      supportsDuration: true,
      durationMs: 1600,
      hasDurationOverride: true,
    });
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      readersOverrides: {
        hasAnyThemeOverride: () => true,
        readThemeOverrideMap: () => ({
          reactions: {
            clickLeft: {
              durationMs: 1600,
            },
          },
        }),
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const summaryDot = parent.querySelector(".anim-override-badge-dot");
    const resetButton = parent.querySelectorAll("button").find((button) => button.textContent === "animOverridesReset");

    assert.ok(summaryDot, "reaction-only overrides should show the overridden summary badge");
    assert.ok(resetButton, "expanded row should render a reset button");
    assert.strictEqual(resetButton.disabled, false, "reaction-only overrides should enable the reset button");
  });

  it("does not keep reset-slot null timing values as pending slider edits", async () => {
    const card = createAnimOverrideCard({
      supportsAutoReturn: true,
      autoReturnMs: 2600,
    });
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    const payloads = [];
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: (_name, payload) => {
          payloads.push(payload);
          return Promise.resolve({ status: "ok" });
        },
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => Promise.resolve(runtime.animationOverridesData),
      },
      readersOverrides: {
        readThemeOverrideMap: () => ({
          states: {
            thinking: {
              transition: { in: 120, out: 180 },
            },
          },
          timings: {
            autoReturn: {
              thinking: 2600,
            },
          },
        }),
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const resetButton = parent.querySelectorAll("button").find((button) => button.textContent === "animOverridesReset");
    assert.ok(resetButton, "expanded row should render a reset button");
    for (const listener of resetButton.eventListeners.click || []) listener();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].autoReturnMs, null);
    assert.ok(
      !core.runtime.pendingAnimationOverrideEdits || core.runtime.pendingAnimationOverrideEdits.size === 0,
      "reset-slot null timing values should not leak into the pending timing edit map"
    );
  });

  it("only patches Animation Overrides broadcasts that exactly acknowledge pending timing edits", () => {
    const card = createAnimOverrideCard();
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    let fetchCount = 0;
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: () => new Promise(() => {}),
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => {
          fetchCount++;
          return Promise.resolve(runtime.animationOverridesData);
        },
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const fadeInRange = parent.querySelectorAll("input").find((input) => input.type === "range");
    fadeInRange.value = "260";
    for (const listener of fadeInRange.eventListeners.input || []) listener();
    for (const listener of fadeInRange.eventListeners.change || []) listener();

    const previousSnapshot = { themeOverrides: {} };
    const acknowledgedSnapshot = {
      themeOverrides: {
        cloudling: {
          states: {
            thinking: {
              transition: { in: 260, out: 180 },
            },
          },
        },
      },
    };
    assert.strictEqual(
      core.tabs.animOverrides.patchInPlace(
        { themeOverrides: acknowledgedSnapshot.themeOverrides },
        { previousSnapshot, snapshot: acknowledgedSnapshot }
      ),
      true,
      "the in-flight timing edit broadcast should be safe to reconcile in place"
    );

    const unrelatedSnapshot = {
      themeOverrides: {
        cloudling: {
          states: {
            working: {
              file: "other.svg",
            },
          },
        },
      },
    };
    assert.strictEqual(
      core.tabs.animOverrides.patchInPlace(
        { themeOverrides: unrelatedSnapshot.themeOverrides },
        { previousSnapshot, snapshot: unrelatedSnapshot }
      ),
      false,
      "unrelated themeOverrides broadcasts should fall through to a full content refresh"
    );
    assert.strictEqual(fetchCount, 1);
  });

  it("routes matching Animation Overrides timing broadcasts through applyChanges in place", () => {
    const core = loadSettingsCoreForTest({
      getAnimationOverridesData: () => Promise.resolve({
        theme: { id: "cloudling", name: "Cloudling" },
        assets: [],
        sections: [],
        cards: [{
          id: "state:thinking",
          slotType: "state",
          stateKey: "thinking",
          transition: { in: 260, out: 180 },
        }],
        sounds: [],
      }),
    });
    core.state.activeTab = "animOverrides";
    core.state.snapshot = {
      theme: "cloudling",
      themeOverrides: {},
    };
    core.runtime.animationOverridesData = {
      theme: { id: "cloudling", name: "Cloudling" },
      assets: [],
      sections: [],
      cards: [{
        id: "state:thinking",
        slotType: "state",
        stateKey: "thinking",
        transition: { in: 120, out: 180 },
      }],
      sounds: [],
    };
    core.runtime.animOverridesSubtab = "animations";
    core.runtime.assetPicker.state = null;
    core.runtime.pendingAnimationOverrideEdits.set("state:thinking", {
      seq: 1,
      slotType: "state",
      stateKey: "thinking",
      transition: { in: 260, out: 180 },
    });

    let contentRenderCount = 0;
    let modalRenderCount = 0;
    core.ops.installRenderHooks({
      sidebar: () => {},
      content: () => {
        contentRenderCount++;
      },
      modal: () => {
        modalRenderCount++;
      },
    });

    const nextSnapshot = {
      theme: "cloudling",
      themeOverrides: {
        cloudling: {
          states: {
            thinking: {
              transition: { in: 260, out: 180 },
            },
          },
        },
      },
    };
    core.ops.applyChanges({
      changes: { themeOverrides: nextSnapshot.themeOverrides },
      snapshot: nextSnapshot,
    });

    assert.strictEqual(contentRenderCount, 0, "matching timing ack should avoid rebuilding content");
    assert.strictEqual(modalRenderCount, 0, "modal render happens after the async fetch settles");
  });

  it("routes default-matching timing broadcasts through applyChanges in place", () => {
    const core = loadSettingsCoreForTest({
      getAnimationOverridesData: () => Promise.resolve({
        theme: { id: "cloudling", name: "Cloudling" },
        assets: [],
        sections: [],
        cards: [{
          id: "state:thinking",
          slotType: "state",
          stateKey: "thinking",
          transition: { in: 150, out: 150 },
          transitionThemeDefault: { in: 150, out: 150 },
          hasTransitionOverride: false,
        }],
        sounds: [],
      }),
    });
    core.state.activeTab = "animOverrides";
    core.state.snapshot = {
      theme: "cloudling",
      themeOverrides: {
        cloudling: {
          states: {
            thinking: {
              transition: { in: 160, out: 150 },
            },
          },
        },
      },
    };
    core.runtime.animationOverridesData = {
      theme: { id: "cloudling", name: "Cloudling" },
      assets: [],
      sections: [],
      cards: [{
        id: "state:thinking",
        slotType: "state",
        stateKey: "thinking",
        transition: { in: 160, out: 150 },
        transitionThemeDefault: { in: 150, out: 150 },
        hasTransitionOverride: true,
      }],
      sounds: [],
    };
    core.runtime.animOverridesSubtab = "animations";
    core.runtime.assetPicker.state = null;
    core.runtime.pendingAnimationOverrideEdits.set("state:thinking", {
      seq: 1,
      slotType: "state",
      stateKey: "thinking",
      transition: { in: 150, out: 150 },
      transitionThemeDefault: { in: 150, out: 150 },
    });

    let contentRenderCount = 0;
    core.ops.installRenderHooks({
      sidebar: () => {},
      content: () => {
        contentRenderCount++;
      },
      modal: () => {},
    });

    const nextSnapshot = {
      theme: "cloudling",
      themeOverrides: {},
    };
    core.ops.applyChanges({
      changes: { themeOverrides: nextSnapshot.themeOverrides },
      snapshot: nextSnapshot,
    });

    assert.strictEqual(contentRenderCount, 0, "default timing ack should avoid rebuilding content");
  });

  it("does not patch mixed-key Animation Overrides broadcasts in place", () => {
    const card = createAnimOverrideCard();
    const runtime = createAnimOverridesRuntime(card);
    const modalRoot = new FakeElement("div");
    let fetchCount = 0;
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: () => new Promise(() => {}),
      },
      opsOverrides: {
        fetchAnimationOverridesData: () => {
          fetchCount++;
          return Promise.resolve(runtime.animationOverridesData);
        },
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    const fadeInRange = parent.querySelectorAll("input").find((input) => input.type === "range");
    fadeInRange.value = "260";
    for (const listener of fadeInRange.eventListeners.input || []) listener();
    for (const listener of fadeInRange.eventListeners.change || []) listener();

    const previousSnapshot = { lang: "en", themeOverrides: {} };
    const snapshot = {
      lang: "ja",
      themeOverrides: {
        cloudling: {
          states: {
            thinking: {
              transition: { in: 260, out: 180 },
            },
          },
        },
      },
    };

    assert.strictEqual(
      core.tabs.animOverrides.patchInPlace(
        { lang: "ja", themeOverrides: snapshot.themeOverrides },
        { previousSnapshot, snapshot }
      ),
      false,
      "mixed-key broadcasts should fall through so non-timing UI side effects can render"
    );
    assert.strictEqual(fetchCount, 0);
  });

  it("clears pending Animation Overrides timing edits on theme changes", () => {
    const core = loadSettingsCoreForTest({});
    core.state.snapshot = {
      theme: "cloudling",
      themeVariant: "default",
      themeOverrides: {},
    };
    core.runtime.pendingAnimationOverrideEdits.set("state:thinking", {
      slotType: "state",
      stateKey: "thinking",
      transition: { in: 260, out: 180 },
      seq: 1,
    });
    core.state.mountedControls.animOverrideTimingSliders.set("state:thinking:transition.in", { row: {} });
    core.runtime.pendingAnimationOverrideResets = new Set(["state:thinking"]);

    core.ops.applyChanges({
      changes: { theme: "calico" },
      snapshot: {
        theme: "calico",
        themeVariant: "default",
        themeOverrides: {},
      },
    });

    assert.strictEqual(core.runtime.pendingAnimationOverrideEdits.size, 0);
    assert.strictEqual(core.runtime.pendingAnimationOverrideResets.size, 0);
    assert.strictEqual(core.state.mountedControls.animOverrideTimingSliders.size, 0);
  });

  it("does not patch Animation Overrides broadcasts without a pending timing edit", () => {
    const card = {
      id: "state:thinking",
      slotType: "state",
      stateKey: "thinking",
      triggerKind: "thinking",
      currentFile: "cloudling-thinking.svg",
      currentFileUrl: "file:///themes/cloudling/assets/cloudling-thinking.svg",
      currentFilePreviewUrl: "file:///themes/cloudling/assets/cloudling-thinking.svg",
      bindingLabel: "states.thinking[0]",
      transition: { in: 120, out: 180 },
      supportsAutoReturn: false,
      supportsDuration: false,
      assetCycleMs: 1000,
      assetCycleStatus: "ok",
      suggestedDurationMs: null,
      suggestedDurationStatus: "unavailable",
      previewDurationMs: 1000,
      displayHintWarning: false,
      displayHintTarget: null,
      fallbackTargetState: null,
      wideHitboxEnabled: false,
      wideHitboxOverridden: false,
      aspectRatioWarning: null,
    };
    const runtime = {
      animationOverridesData: {
        theme: { id: "cloudling", name: "Cloudling" },
        assets: [],
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
    let fetchCount = 0;
    const { core } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      opsOverrides: {
        fetchAnimationOverridesData: () => {
          fetchCount++;
          return Promise.resolve(runtime.animationOverridesData);
        },
      },
    });
    const parent = new FakeElement("main");
    core.tabs.animOverrides.render(parent, core);

    assert.strictEqual(core.tabs.animOverrides.patchInPlace({ themeOverrides: { cloudling: { states: {} } } }), false);
    assert.strictEqual(fetchCount, 0);
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
