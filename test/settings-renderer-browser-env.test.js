"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const SETTINGS_HTML = path.join(SRC_DIR, "settings.html");
const SETTINGS_CSS = path.join(SRC_DIR, "settings.css");
const LANGUAGE_PICKER_JS = path.join(SRC_DIR, "language-picker.js");
const LANGUAGE_PICKER_CSS = path.join(SRC_DIR, "language-picker.css");
const SETTINGS_TAB_GENERAL = path.join(SRC_DIR, "settings-tab-general.js");
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
  path.join(SRC_DIR, "settings-tab-telegram-approval.js"),
  path.join(SRC_DIR, "settings-tab-about.js"),
];
const VERIFIED_GITHUB_CONTRIBUTORS = [
  "Bynlk",
  "zxypro1",
  "NeroAyase",
  "divergentD",
  "Ne9roni",
  "jiaxuan1101",
  "kkirito16",
  "200780381",
  "Dxy2326",
  "lurui1997",
  "JesmonX",
  "chen86860",
];

function createDeferred() {
  const deferred = {};
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  return deferred;
}

function loadSettingsI18nBundleForTest() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SETTINGS_I18N, "utf8"), context);
  return context.ClawdSettingsI18n;
}

function loadSettingsI18nForTest() {
  return loadSettingsI18nBundleForTest().STRINGS;
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

// FakeElement.textContent is a plain field, not an aggregating DOM getter, so
// reading it on a container yields "" and any "does this text appear?" check
// against it passes vacuously. Walk the tree instead, and include innerHTML —
// the guide rows render through it.
function collectText(el) {
  if (!el) return "";
  const parts = [];
  if (el.textContent) parts.push(String(el.textContent));
  if (el.innerHTML) parts.push(String(el.innerHTML));
  for (const child of el.children || []) parts.push(collectText(child));
  return parts.join(" ");
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
    this.focused = false;
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

  focus() {
    this.focused = true;
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

function loadSharedLanguagePickerForTest({
  value = "en",
  options = ["en", "zh", "ja"],
  onChange = () => Promise.resolve(true),
  innerHeight = 600,
} = {}) {
  const body = new FakeElement("body");
  const boundary = new FakeElement("div");
  boundary.setAttribute("data-language-picker-boundary", "");
  body.appendChild(boundary);
  const documentListeners = new Map();
  const windowListeners = new Map();
  const animationFrames = new Map();
  let nextAnimationFrameId = 1;
  const document = {
    body,
    documentElement: { clientHeight: innerHeight },
    createElement: (tagName) => new FakeElement(tagName),
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
  const context = {
    console,
    document,
    innerHeight,
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
    requestAnimationFrame(cb) {
      const id = nextAnimationFrameId++;
      animationFrames.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      animationFrames.delete(id);
    },
    window: null,
    globalThis: null,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(LANGUAGE_PICKER_JS, "utf8"), context);

  const control = context.ClawdLanguagePicker.createLanguagePicker({
    value,
    options: options.map((option) => ({ value: option, label: option.toUpperCase() })),
    ariaLabel: "Language",
    onChange,
  });
  boundary.appendChild(control.element);

  return {
    boundary,
    control,
    picker: control.element,
    trigger: control.element.querySelector(".language-picker-trigger"),
    menu: control.element.querySelector(".language-picker-menu"),
    optionElements: control.element.querySelectorAll(".language-picker-option"),
    valueElement: control.element.querySelector(".language-picker-value"),
    dispatchWindowEvent(type, event = {}) {
      for (const listener of [...(windowListeners.get(type) || [])]) {
        listener({ ...event, type });
      }
    },
    flushAnimationFrames() {
      while (animationFrames.size > 0) {
        const pending = [...animationFrames.values()];
        animationFrames.clear();
        for (const callback of pending) callback();
      }
    },
    getPendingAnimationFrameCount: () => animationFrames.size,
    getWindowListenerCount: (type) => (windowListeners.get(type) || []).length,
  };
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
  vm.runInContext(fs.readFileSync(LANGUAGE_PICKER_JS, "utf8"), context);
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
    dispatchDocumentEvent: (type, event = {}) => {
      const listeners = documentListeners.get(type) || [];
      const payload = { ...event, type };
      for (const listener of [...listeners]) listener(payload);
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
  vm.runInContext(fs.readFileSync(LANGUAGE_PICKER_JS, "utf8"), context);
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
    theme: "clawd",
    petTint: {},
    petAccessory: {},
    size: 50,
    sessionHudEnabled: true,
    sessionHudShowStateLabels: true,
    sessionHudShowElapsed: true,
    sessionHudCleanupDetached: true,
    soundMuted: false,
    soundVolume: 0.5,
    lowPowerIdleMode: false,
    allowEdgePinning: true,
    disableMiniMode: false,
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

function loadRemoteSshTabForTest({
  snapshot,
  cleanup = () => Promise.resolve({ status: "ok", uninstalled: true }),
  command = () => Promise.resolve({ status: "ok" }),
  confirm = () => true,
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
  const statusListeners = [];
  const progressListeners = [];
  const cleanupCalls = [];
  const commandCalls = [];
  const remoteSsh = {
    onStatusChanged(cb) {
      statusListeners.push(cb);
      return () => {};
    },
    onProgress(cb) {
      progressListeners.push(cb);
      return () => {};
    },
    cleanup(profileId) {
      cleanupCalls.push(profileId);
      return cleanup(profileId);
    },
    connect: () => Promise.resolve({ status: "ok" }),
    disconnect: () => Promise.resolve({ status: "ok" }),
    authenticate: () => Promise.resolve({ status: "ok" }),
    openTerminal: () => Promise.resolve({ status: "ok" }),
    deploy: () => Promise.resolve({ status: "ok" }),
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
    setTimeout,
    confirm,
    window: null,
    globalThis: null,
    remoteSsh,
    settingsAPI: {
      command(action, payload) {
        commandCalls.push({ action, payload });
        return command(action, payload);
      },
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
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-ssh.js"), "utf8"), context);

  const core = context.ClawdSettingsCore;
  core.state.snapshot = snapshot || { lang: "en", remoteSsh: { profiles: [] } };
  core.state.activeTab = "remote-ssh";
  context.ClawdSettingsTabRemoteSsh.init(core);

  function renderContent() {
    core.ops.clearMountedControls();
    content.innerHTML = "";
    core.tabs["remote-ssh"].render(content, core);
  }
  core.ops.installRenderHooks({ content: renderContent });
  renderContent();

  return {
    content,
    cleanupCalls,
    commandCalls,
    renderContent,
    emitStatus(payload) {
      for (const listener of statusListeners) listener(payload);
    },
    emitProgress(payload) {
      for (const listener of progressListeners) listener(payload);
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
  snapshot,
  petTintOptions,
  petAccessoryOptions,
  settingsAPI = {},
} = {}) {
  const body = new FakeElement("body");
  const content = new FakeElement("main");
  content.id = "content";
  body.appendChild(content);

  const commands = [];
  const updates = [];
  let themeListState = Array.isArray(themes) ? themes : [];
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
      if (name === "setThemeSelection" && payload && typeof payload.themeId === "string") {
        const target = themeListState.find((theme) => theme && theme.id === payload.themeId);
        themeListState = themeListState.map((theme) => ({
          ...theme,
          active: theme.id === payload.themeId,
        }));
        return Promise.resolve({
          status: "ok",
          customizationCapabilities: target
            ? {
                petTint: target.capabilities && target.capabilities.petTint === true,
                accessories: target.capabilities && target.capabilities.accessories === true,
              }
            : null,
        });
      }
      return Promise.resolve({ status: "ok" });
    },
    listThemes: () => Promise.resolve(themeListState),
    update: (key, value) => {
      updates.push({ key, value });
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
  core.state.snapshot = {
    lang: "en",
    petTint: {},
    petAccessory: {},
    ...(snapshot || {}),
  };
  core.state.activeTab = "theme";
  core.runtime.themeList = themeListState;
  core.runtime.petTintOptions = Array.isArray(petTintOptions) ? petTintOptions : [];
  core.runtime.petAccessoryOptions = Array.isArray(petAccessoryOptions)
    ? petAccessoryOptions
    : [];
  context.ClawdSettingsTabTheme.init(core);
  const renderContent = () => {
    content.innerHTML = "";
    core.tabs.theme.render(content, core);
  };
  core.ops.installRenderHooks({ content: renderContent });
  renderContent();

  return { content, commands, updates, core, renderContent };
}

function loadAgentsTabForTest({
  snapshot,
  agentMetadata,
  collapsedGroups = {},
  settingsAPI = {},
  doctor = null,
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
    setTimeout,
    window: null,
    globalThis: null,
    settingsAPI: {
      command: () => Promise.resolve({ status: "ok" }),
      ...settingsAPI,
    },
    doctor,
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
          agentSectionConnected: "Connected",
          agentSectionRecommended: "Detected locally",
          agentSectionUnavailable: "Not detected locally",
          agentSearchPlaceholder: "Search",
          agentsSubtabConnected: "Connected",
          agentsSubtabDiscover: "Discover and add",
          rowCustomToolsDiscoveryPathsDesc: "Choose an AI installation folder.",
          customToolManualAdd: "Choose AI installation folder",
          customToolNotRecognized: "No launchable application found",
          customToolDetectionMissing: "Path missing",
          agentInstanceScanWsl: "Scan WSL",
          agentInstanceScanWslDesc: "Rescan WSL distros",
          customToolRescan: "Rescan",
          customToolScanStatusIdle: "Not scanned",
          customToolScanStatusScanning: "Scanning...",
          customToolScanStatusComplete: "Last scanned at {time}",
          customToolScanStatusFailed: "Scan failed",
          customAgentWaiting: "Waiting for first state event this run",
          customAgentLastState: "Last state: {event} at {time}",
          rowAgentIdleAlerts: "Idle alerts",
          rowAgentIdleAlertsDesc: "Idle alert desc",
          rowAgentPermissions: "Permissions",
          rowAgentPermissionsDesc: "Permissions desc",
          rowCodexPermissionMode: "Permission mode",
          rowCodexPermissionModeDesc: "Permission mode desc",
          codexPermissionModeNative: "Native",
          codexPermissionModeIntercept: "Intercept",
          rowCodexNativeNotificationSound: "Native sound",
          rowCodexNativeNotificationSoundDesc: "Native sound desc",
          badgePermissionBubble: "Permission bubble",
          eventSourceHook: "Hook",
          eventSourceLogPoll: "Log poll",
          eventSourcePlugin: "Plugin",
          eventSourceExtension: "Extension",
          agentIntegrationInstalled: "Installed",
          agentIntegrationNotInstalled: "Not installed",
          agentIntegrationInstall: "Install",
          agentCodexHookNeedsAttention: "Needs attention",
          codexHookHealthReasonInactive: "Hook inactive",
          codexHookHealthReasonDisabled: "Hooks disabled",
          codexHookHealthReasonNeedsReview: "Needs review",
          agentIntegrationUninstall: "Uninstall",
          agentIntegrationWorking: "Working",
          agentIntegrationUninstallConfirm: "Confirm uninstall",
          agentIntegrationInstallSkipped: "No local installation was found for {agents}.",
          agentListSeparator: ", ",
          agentInstallHintTitle: "Connect detected agents",
          agentInstallHintDesc: "Detected local signals for {agents}.",
          agentInstallHintInstallRecommended: "Install recommended",
          agentInstallHintDismiss: "Not now",
          agentCleanupHintTitle: "Review missing local agents",
          agentCleanupHintDesc: "Missing local installs for {agents}.",
          agentCleanupHintRemove: "Remove integrations",
          agentCleanupHintDismiss: "Keep for now",
          collapsibleExpand: "Expand",
          collapsibleCollapse: "Collapse",
          toastAgentIntegrationInstalled: "Integration installed.",
          toastAgentIntegrationUninstalled: "Integration uninstalled.",
          toastAgentInstallHintInstalled: "Recommended integrations installed.",
          toastAgentInstallHintSkipped: "No local installation was found for {agents}.",
          toastAgentInstallHintPartialSkipped: "{success} installed. Skipped {agents}.",
          toastAgentInstallHintPartial: "{success} installed, {failed} failed: {message}",
          toastAgentCleanupHintRemoved: "Missing integrations removed.",
          toastAgentCleanupHintPartial: "{success} removed, {failed} failed: {message}",
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
  settingsAPI = {},
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
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-overrides.js"), "utf8"), context);

  const core = context.ClawdSettingsCore;
  core.state.snapshot = snapshot || { theme: "clawd", themeOverrides: {} };
  // The Animation Map now lives as the default "on / off" subtab of the
  // Animation & Sound Overrides tab, so patching flows through that tab.
  core.state.activeTab = "animOverrides";
  context.ClawdSettingsTabAnimMap.init(core);
  context.ClawdSettingsTabAnimOverrides.init(core);

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

function loadTelegramApprovalTabForTest({
  snapshot,
  settingsAPI = {},
  confirm = () => true,
} = {}) {
  const body = new FakeElement("body");
  const content = new FakeElement("main");
  content.id = "content";
  body.appendChild(content);
  const updates = [];
  const commands = [];
  const renderRequests = [];
  const timers = [];

  const document = {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById(id) {
      if (id === "content") return content;
      return null;
    },
  };
  const api = {
    update: (key, value) => {
      updates.push({ key, value });
      return Promise.resolve({ status: "ok" });
    },
    command: (name, payload) => {
      commands.push({ name, payload });
      if (name === "telegramApproval.status") {
        return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
      }
      if (name === "telegramApproval.tokenInfo") {
        return Promise.resolve({ status: "ok", configured: false, masked: "" });
      }
      if (name === "feishuApproval.status") {
        return Promise.resolve({ status: "ok", state: { status: "stopped", secretsStored: false } });
      }
      if (name === "feishuApproval.secretInfo") {
        return Promise.resolve({ status: "ok", configured: false });
      }
      return Promise.resolve({ status: "ok" });
    },
    ...settingsAPI,
  };
  const context = {
    console,
    document,
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    setTimeout: (cb, ms) => {
      timers.push({ cb, ms, cleared: false });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
    window: null,
    globalThis: null,
    settingsAPI: api,
    confirm,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, "settings-tab-telegram-approval.js"), "utf8"), context);

  const core = {
    state: {
      snapshot: snapshot || {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
        feishuApproval: {
          enabled: false,
          idType: "open_id",
          approverId: "",
          connectionTimeoutSeconds: 15,
        },
      },
      activeTab: "telegram-approval",
    },
    runtime: {},
    helpers: {
      t: (key) => key,
      buildSection: (_title, rows) => {
        const section = document.createElement("section");
        for (const row of rows) section.appendChild(row);
        return section;
      },
      setSwitchVisual: (el, checked, options = {}) => {
        el.classList.toggle("on", !!checked);
        el.classList.toggle("pending", !!options.pending);
        el.setAttribute("aria-checked", checked ? "true" : "false");
      },
      // Mirror the real buildCollapsibleGroup just enough that header content,
      // title/summary, and children all end up in the DOM tree; collapsed
      // behaviour is exercised by the real component's own tests.
      buildCollapsibleGroup: ({ id, title = "", desc = "", summary = null, headerContent, children = [], className = "" } = {}) => {
        const group = document.createElement("div");
        group.className = `collapsible-group${className ? ` ${className}` : ""}`;
        if (id) group.dataset.groupId = id;
        const header = document.createElement("div");
        header.className = "collapsible-group-header";
        if (headerContent) {
          header.appendChild(headerContent);
        } else {
          const text = document.createElement("div");
          text.className = "collapsible-group-text";
          const label = document.createElement("span");
          label.className = "row-label";
          label.textContent = title;
          text.appendChild(label);
          if (desc) {
            const description = document.createElement("span");
            description.className = "row-desc";
            description.textContent = desc;
            text.appendChild(description);
          }
          header.appendChild(text);
        }
        if (summary) {
          const summaryWrap = document.createElement("div");
          summaryWrap.className = "collapsibleSummary collapsible-group-summary";
          if (typeof summary === "string") summaryWrap.textContent = summary;
          else summaryWrap.appendChild(summary);
          header.appendChild(summaryWrap);
        }
        group.appendChild(header);
        const body = document.createElement("div");
        body.className = "collapsible-group-body";
        for (const child of children) body.appendChild(child);
        group.appendChild(body);
        return group;
      },
    },
    ops: {
      requestRender: (payload) => {
        renderRequests.push(payload || {});
      },
      showToast: () => {},
    },
    tabs: {},
  };
  context.ClawdSettingsTabTelegramApproval.init(core);
  function render() {
    content.innerHTML = "";
    core.tabs["telegram-approval"].render(content, core);
  }
  render();

  return { core, content, updates, commands, render, renderRequests, timers };
}

function loadAnimOverridesTabForTest({
  runtime,
  modalRoot,
  settingsAPI = {},
  opsOverrides = {},
  readersOverrides = {},
  helpersOverrides = {},
}) {
  const documentListeners = new Map();
  const document = {
    body: new FakeElement("body"),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => (id === "modalRoot" ? modalRoot : null),
    querySelector: () => null,
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      const listeners = documentListeners.get(type);
      if (listeners) listeners.delete(handler);
    },
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
    state: { activeTab: "animOverrides", mountedControls: {} },
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
  return {
    core,
    document,
    documentListenerCount: (type) => (documentListeners.get(type) || new Set()).size,
  };
}

function createIdleVisualRuntime(selectedFile = null) {
  const card = createAnimOverrideCard({ id: "state:idle", stateKey: "idle", triggerKind: "idle" });
  return createAnimOverridesRuntime(card, {
    animationOverridesData: {
      theme: { id: "clawd", name: "Clawd" },
      assets: [],
      sections: [{ id: "idle", cards: [card] }],
      cards: [card],
      sounds: [],
      idleDefaultVisual: {
        themeId: "clawd",
        selectedFile,
        options: [
          { file: "clawd-idle-follow.svg", isThemeDefault: true, label: "Idle Follow" },
          { file: "clawd-idle-reading.svg", isThemeDefault: false, label: "Idle Reading" },
        ],
      },
    },
  });
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
      "settings-tab-telegram-approval.js",
      "settings-tab-about.js",
      "settings-tab-remote-ssh.js",
      "settings-doctor-modal.js",
      "settings-icons.js",
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
    assert.ok(rendererSource.includes("settingsAPI.onRemoteApprovalStatusChanged"));
    assert.ok(rendererSource.includes("settingsAPI.getPetTintOptions"));
    assert.ok(rendererSource.includes("settingsAPI.getPetAccessoryOptions"));
    assert.ok(fs.readFileSync(PRELOAD_SETTINGS, "utf8").includes(
      'getPetTintOptions: () => ipcRenderer.invoke("settings:get-pet-tint-options")'
    ));
    assert.ok(fs.readFileSync(PRELOAD_SETTINGS, "utf8").includes(
      'getQuotaSourceCount: () => ipcRenderer.invoke("settings:get-quota-source-count")'
    ));
    assert.ok(fs.readFileSync(PRELOAD_SETTINGS, "utf8").includes(
      'getPetAccessoryOptions: () => ipcRenderer.invoke("settings:get-pet-accessory-options")'
    ));
    assert.ok(rendererSource.includes("tab.refreshRuntimeStatus(payload)"));
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
      assert.ok(!source.includes("settingsAPI.onRemoteApprovalStatusChanged"), `${path.basename(file)} must not subscribe to remote approval status directly`);
    }
  });

  it("waits for remote cleanup before deleting a profile and warns on incomplete uninstall", () => {
    const source = fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-ssh.js"), "utf8");
    const cleanupIndex = source.indexOf("await window.remoteSsh.cleanup(profile.id)");
    const deleteIndex = source.indexOf('await callCommand("remoteSsh.delete", profile.id)');
    assert.ok(cleanupIndex >= 0, "delete flow must await remote cleanup");
    assert.ok(deleteIndex > cleanupIndex, "profile removal must happen after cleanup resolves");
    assert.ok(source.includes('cleanup.uninstalled !== false'));
    assert.ok(source.includes('remoteSshDeleteCleanupFailedConfirm'));
  });

  it("keeps remote profile deletion single-flight across runtime rerenders", async () => {
    const cleanupDeferred = createDeferred();
    let confirmCalls = 0;
    const profile = {
      id: "remote-1",
      label: "Build host",
      host: "builder.example.com",
      remoteForwardPort: 23333,
      lastDeployedAt: Date.now(),
    };
    const harness = loadRemoteSshTabForTest({
      snapshot: { lang: "en", remoteSsh: { profiles: [profile] } },
      cleanup: () => cleanupDeferred.promise,
      confirm: () => {
        confirmCalls++;
        return true;
      },
    });

    harness.content.querySelector(".remote-ssh-card").dispatchEvent({ type: "click" });
    const originalDelete = harness.content.querySelector(".remote-ssh-btn-danger");
    assert.ok(originalDelete);
    assert.strictEqual(originalDelete.disabled, false);

    originalDelete.dispatchEvent({ type: "click" });
    assert.deepStrictEqual(harness.cleanupCalls, [profile.id]);
    assert.strictEqual(confirmCalls, 1);

    const pendingDelete = harness.content.querySelector(".remote-ssh-btn-danger");
    assert.notStrictEqual(pendingDelete, originalDelete, "starting cleanup rebuilds the detail view");
    assert.strictEqual(pendingDelete.disabled, true);

    harness.emitStatus({ profileId: profile.id, status: "idle" });
    const afterStatusRerender = harness.content.querySelector(".remote-ssh-btn-danger");
    assert.notStrictEqual(afterStatusRerender, pendingDelete);
    assert.strictEqual(afterStatusRerender.disabled, true, "runtime status repaint preserves pending state");

    // FakeElement permits dispatching a disabled button, unlike the browser.
    // The handler guard must still prevent duplicate destructive IPC work.
    afterStatusRerender.dispatchEvent({ type: "click" });
    assert.deepStrictEqual(harness.cleanupCalls, [profile.id]);
    assert.strictEqual(confirmCalls, 1);

    cleanupDeferred.resolve({ status: "ok", uninstalled: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(harness.commandCalls, [{ action: "remoteSsh.delete", payload: profile.id }]);
    assert.strictEqual(harness.content.querySelector(".remote-ssh-detail"), null);
  });

  it("re-enables remote profile deletion when incomplete cleanup is kept for retry", async () => {
    const confirmations = [true, false];
    const profile = {
      id: "remote-retry",
      label: "Retry host",
      host: "retry.example.com",
      remoteForwardPort: 23334,
      lastDeployedAt: Date.now(),
    };
    const harness = loadRemoteSshTabForTest({
      snapshot: { lang: "en", remoteSsh: { profiles: [profile] } },
      cleanup: () => Promise.resolve({ status: "ok", uninstalled: false }),
      confirm: () => confirmations.shift(),
    });

    harness.content.querySelector(".remote-ssh-card").dispatchEvent({ type: "click" });
    harness.content.querySelector(".remote-ssh-btn-danger").dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(harness.cleanupCalls, [profile.id]);
    assert.deepStrictEqual(harness.commandCalls, [], "cancelled force-delete keeps the profile");
    assert.ok(harness.content.querySelector(".remote-ssh-detail"));
    assert.strictEqual(harness.content.querySelector(".remote-ssh-btn-danger").disabled, false);
  });

  it("keeps About contributors visible and includes verified GitHub contributors", () => {
    const aboutSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-about.js"), "utf8");
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const i18nBundle = loadSettingsI18nBundleForTest();

    assert.ok(!aboutSource.includes("about-contributors-toggle"));
    assert.ok(!aboutSource.includes("contributorsExpanded"));
    assert.ok(!coreSource.includes("contributorsExpanded"));
    assert.ok(!css.includes(".about-contributors-list.collapsed"));

    for (const login of VERIFIED_GITHUB_CONTRIBUTORS) {
      assert.ok(i18nBundle.CONTRIBUTORS.includes(login), `About contributors should include ${login}`);
    }
  });

  it("keeps every Telegram retirement gate string in all supported languages", () => {
    const strings = loadSettingsI18nForTest();
    const keys = [
      "telegramNativeMigrationEyebrow",
      "telegramLegacyRetiredTitle",
      "telegramLegacyRetiredBody",
      "telegramNativeReverifyTitle",
      "telegramNativeReverifyBody",
      "telegramNativeMigrationVerify",
      "telegramNativeMigrationWaiting",
      "telegramNativeMigrationDisable",
      "telegramNativeMigrationGuide",
      "telegramNativeMigrationFailed",
      "telegramNativeMigrationTimeout",
      "telegramNativeMigrationStartFailed",
    ];
    assert.deepStrictEqual(SUPPORTED_LANGS, ["en", "zh", "zh-TW", "ko", "ja"]);
    for (const lang of SUPPORTED_LANGS) {
      for (const key of keys) {
        assert.equal(
          typeof strings[lang][key],
          "string",
          `${lang}.${key} must exist`,
        );
        assert.notEqual(strings[lang][key].trim(), "", `${lang}.${key} must not be empty`);
      }
    }
  });

  it("renders a blocking retired-legacy gate and dispatches only the verified native action", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: true,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: {
                state: "NATIVE_MIGRATION_REQUIRED",
                transport: "legacy",
                testOrigin: "legacy",
                ownerSnapshot: { nativePolling: false },
                revision: 1,
              },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: {
                status: "stopped",
                transport: "off",
                configured: true,
                tokenStored: true,
                reason: "native-migration-required",
              },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          if (name === "telegramMigration.dispatch") {
            return Promise.resolve({
              status: "ok",
              snapshot: {
                state: "TESTING_NATIVE",
                testOrigin: "legacy",
                revision: 2,
              },
            });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const gate = harness.content.querySelector(".tg-native-migration-gate");
    assert.ok(gate, "legacy users must see the blocking retirement gate");
    assert.equal(
      gate.querySelector(".tg-native-migration-gate-title").textContent,
      "telegramLegacyRetiredTitle",
    );
    assert.equal(
      harness.content.querySelector(".switch").getAttribute("aria-disabled"),
      "true",
      "the ordinary enable switch must not bypass migration verification",
    );
    const ordinaryTest = harness.content.querySelectorAll("button")
      .find((button) => button.textContent === "telegramApprovalSendTest");
    assert.equal(ordinaryTest.disabled, true, "ordinary Send test must not become a second migration entry");
    const buttons = gate.querySelectorAll("button");
    const verify = buttons.find((button) => button.textContent === "telegramNativeMigrationVerify");
    assert.ok(verify);
    assert.equal(
      buttons.some((button) => /Later|legacy|rollback/i.test(button.textContent)),
      false,
      "the retired runtime must not expose Later, rollback, or enable-legacy actions",
    );

    verify.dispatchEvent({ type: "click" });
    await Promise.resolve();
    const dispatch = commandCalls.find((call) =>
      call.name === "telegramMigration.dispatch"
      && call.payload
      && call.payload.type === "USER_TEST_NATIVE");
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(dispatch && dispatch.payload)),
      { type: "USER_TEST_NATIVE" },
      "renderer must not attach timestamps, tokens, or arbitrary fields",
    );
  });

  it("renders distinct native migration failure outcomes and hides the gate elsewhere", async () => {
    for (const [outcome, expectedKey] of [
      ["failed", "telegramNativeMigrationFailed"],
      ["timeout", "telegramNativeMigrationTimeout"],
      ["native-start-failed", "telegramNativeMigrationStartFailed"],
    ]) {
      const harness = loadTelegramApprovalTabForTest({
        snapshot: {
          tgApproval: {
            enabled: true,
            allowedTgUserId: "123456789",
            targetSessionKey: "telegram:123456789",
          },
        },
        settingsAPI: {
          command: (name) => {
            if (name === "telegramMigration.snapshot") {
              return Promise.resolve({
                status: "ok",
                snapshot: {
                  state: "NATIVE_MIGRATION_REQUIRED",
                  transport: "legacy",
                  testOrigin: "legacy",
                  lastTestResult: { outcome, at: 1 },
                  revision: 2,
                  ownerSnapshot: { nativePolling: false },
                },
              });
            }
            if (name === "telegramApproval.status") {
              return Promise.resolve({
                status: "ok",
                state: { status: "failed", transport: "off", configured: true, tokenStored: true },
              });
            }
            if (name === "telegramApproval.tokenInfo") {
              return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
            }
            return Promise.resolve({ status: "ok" });
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      harness.render();
      assert.equal(
        harness.content.querySelector(".tg-native-migration-gate-result").textContent,
        expectedKey,
      );
    }

    for (const migrationSnapshot of [
      { state: "IDLE", transport: "off", revision: 1, ownerSnapshot: {} },
      { state: "NATIVE_ACTIVE", transport: "native", revision: 1, ownerSnapshot: { nativePolling: true } },
    ]) {
      const harness = loadTelegramApprovalTabForTest({
        settingsAPI: {
          command: (name) => {
            if (name === "telegramMigration.snapshot") {
              return Promise.resolve({ status: "ok", snapshot: migrationSnapshot });
            }
            return Promise.resolve({ status: "ok" });
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      harness.render();
      assert.equal(harness.content.querySelector(".tg-native-migration-gate"), null);
    }
  });

  it("uses native re-verification copy when a previously verified setup is repaired", async () => {
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
      },
      settingsAPI: {
        command: (name) => {
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: {
                state: "NATIVE_MIGRATION_REQUIRED",
                transport: "native",
                testOrigin: "native-verified-repair",
                revision: 2,
                ownerSnapshot: { nativePolling: false },
              },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "stopped", transport: "native", configured: true, tokenStored: true },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    assert.equal(
      harness.content.querySelector(".tg-native-migration-gate-title").textContent,
      "telegramNativeReverifyTitle",
    );
    assert.equal(
      harness.content.querySelector(".tg-native-migration-gate-body").textContent,
      "telegramNativeReverifyBody",
    );
  });

  it("refreshes Telegram migration state from the scoped async revision signal", async () => {
    const commandCalls = [];
    let revision = 1;
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: true,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: {
                state: "NATIVE_MIGRATION_REQUIRED",
                transport: "legacy",
                testOrigin: "legacy",
                lastTestResult: revision > 1 ? { outcome: "timeout", at: 1 } : null,
                revision,
                ownerSnapshot: { nativePolling: false },
              },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "stopped", transport: "off", configured: true, tokenStored: true },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();
    const beforeSnapshots = commandCalls.filter((call) => call.name === "telegramMigration.snapshot").length;
    revision = 2;

    assert.equal(
      harness.core.tabs["telegram-approval"].refreshRuntimeStatus({
        channel: "telegram",
        revision: 2,
      }),
      true,
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(
      commandCalls.filter((call) => call.name === "telegramMigration.snapshot").length > beforeSnapshots,
      "the scoped signal must pull a fresh secret-free snapshot",
    );
    assert.ok(harness.renderRequests.some((request) => request.content === true));
    harness.render();
    assert.equal(
      harness.content.querySelector(".tg-native-migration-gate-result").textContent,
      "telegramNativeMigrationTimeout",
    );
  });

  it("keeps Telegram approval drafts local across toggles and rerenders", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: { state: "IDLE", transport: "off", ownerSnapshot: {} },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "stopped", configured: true, tokenStored: true },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    // Wait for tokenInfo + status to land so the switch is enabled.
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    // Token is configured → token row is collapsed (no input). Only the
    // recipient input is rendered, at index 0.
    const inputs = harness.content.querySelectorAll("input");
    const allowedInput = inputs[0];
    allowedInput.value = "987654321";
    allowedInput.dispatchEvent({ type: "input" });

    harness.content.querySelector(".switch").dispatchEvent({ type: "click" });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.updates)), []);
    assert.ok(
      commandCalls.some((c) => c.name === "telegramMigration.dispatch"
        && c.payload && c.payload.type === "USER_TEST_NATIVE"),
      "turning on should use the native migration test flow",
    );

    await Promise.resolve();
    await Promise.resolve();

    harness.core.state.snapshot = {
      ...harness.core.state.snapshot,
      tgApproval: {
        enabled: true,
        allowedTgUserId: "555555555",
        targetSessionKey: "telegram:555555555",
      },
    };
    harness.render();

    assert.equal(harness.content.querySelectorAll("input")[0].value, "987654321");
  });

  it("preserves notifyOnComplete=false through a Telegram approval disable save", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: true,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
          notifyOnComplete: false,
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: { state: "NATIVE_ACTIVE", transport: "native", ownerSnapshot: { nativePolling: true } },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "running", configured: true, tokenStored: true },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    harness.content.querySelector(".switch").dispatchEvent({ type: "click" });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.updates)), [{
      key: "tgApproval",
      value: {
        enabled: false,
        allowedTgUserId: "123456789",
        targetSessionKey: "telegram:123456789",
        notifyOnComplete: false,
        completionOutputMode: "off",
        r3DirectSendEnabled: false,
      },
    }]);
    assert.ok(
      commandCalls.some((c) => c.name === "telegramMigration.dispatch"
        && c.payload && c.payload.type === "USER_DISABLE"),
      "turning off should dispatch USER_DISABLE",
    );
  });

  it("preserves notifyOnComplete=true through a Telegram recipient save", async () => {
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: true,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
          notifyOnComplete: true,
          completionOutputMode: "off",
          r3DirectSendEnabled: true,
        },
      },
      settingsAPI: {
        command: (name) => {
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: { state: "NATIVE_ACTIVE", transport: "native", ownerSnapshot: { nativePolling: true } },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "running", configured: true, tokenStored: true },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const input = harness.content.querySelectorAll("input")[0];
    input.value = "987654321";
    input.dispatchEvent({ type: "input" });
    const saveButton = harness.content.querySelectorAll("button")
      .find((button) => button.textContent === "telegramApprovalSaveRecipient");
    saveButton.dispatchEvent({ type: "click" });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.updates)), [{
      key: "tgApproval",
      value: {
        enabled: true,
        allowedTgUserId: "987654321",
        targetSessionKey: "987654321",
        notifyOnComplete: true,
        completionOutputMode: "off",
        r3DirectSendEnabled: true,
      },
    }]);
  });

  it("dispatches USER_DISABLE when the enabled switch is turned off (zombie-switch fix)", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: true,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: { state: "NATIVE_ACTIVE", transport: "native", ownerSnapshot: { nativePolling: true } },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "running", configured: true, tokenStored: true },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    harness.content.querySelector(".switch").dispatchEvent({ type: "click" });

    // The native switch writes tgApproval.enabled = false…
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.updates)), [{
      key: "tgApproval",
      value: {
        enabled: false,
        allowedTgUserId: "123456789",
        targetSessionKey: "telegram:123456789",
        notifyOnComplete: false,
        completionOutputMode: "off",
        r3DirectSendEnabled: false,
      },
    }]);
    // …and turning OFF must ALSO stop the native transport, otherwise the poller
    // + completion notifications keep running (the zombie-switch bug).
    assert.ok(
      commandCalls.some((c) => c.name === "telegramMigration.dispatch"
        && c.payload && c.payload.type === "USER_DISABLE"),
      "turning the switch off should dispatch USER_DISABLE",
    );
  });

  it("requires confirmation before enabling full Telegram completion output", async () => {
    const confirmCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: true,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
          notifyOnComplete: true,
          completionOutputMode: "off",
        },
      },
      confirm: (message) => {
        confirmCalls.push(message);
        return false;
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const select = harness.content.querySelector(".tg-approval-output-select");
    assert.deepStrictEqual(select.children.map((option) => option.value), ["off", "full"]);
    select.value = "full";
    select.dispatchEvent({ type: "change" });

    assert.deepStrictEqual(confirmCalls, ["telegramApprovalCompletionOutputFullConfirm"]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.updates)), []);
    assert.equal(select.value, "off");

    const confirmed = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: true,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
          notifyOnComplete: true,
          completionOutputMode: "off",
        },
      },
      confirm: () => true,
    });
    await Promise.resolve();
    await Promise.resolve();
    confirmed.render();

    const confirmedSelect = confirmed.content.querySelector(".tg-approval-output-select");
    confirmedSelect.value = "full";
    confirmedSelect.dispatchEvent({ type: "change" });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(confirmed.updates)), [{
      key: "tgApproval",
      value: {
        enabled: true,
        allowedTgUserId: "123456789",
        targetSessionKey: "telegram:123456789",
        notifyOnComplete: true,
        completionOutputMode: "full",
        r3DirectSendEnabled: false,
      },
    }]);
  });

  it("toggles Telegram Direct Send paste-only mode without changing the approval transport", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
          notifyOnComplete: false,
          completionOutputMode: "full",
          r3DirectSendEnabled: false,
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: {
                state: "NATIVE_ACTIVE",
                transport: "native",
                ownerSnapshot: { nativePolling: true },
              },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: {
                status: "running",
                transport: "native",
                configured: true,
                tokenStored: true,
              },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const sw = harness.content.querySelector(".tg-approval-direct-send-row .switch");
    assert.equal(sw.getAttribute("aria-checked"), "false");
    sw.dispatchEvent({ type: "click" });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.updates)), [{
      key: "tgApproval",
      value: {
        enabled: false,
        allowedTgUserId: "123456789",
        targetSessionKey: "telegram:123456789",
        notifyOnComplete: false,
        completionOutputMode: "full",
        r3DirectSendEnabled: true,
      },
    }]);
    assert.equal(
      commandCalls.some((c) => c.name === "telegramMigration.dispatch"),
      false,
      "direct-send toggle should not start or stop the Telegram transport",
    );
  });

  it("shows native-active Telegram approval as enabled even when the legacy flag is false", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: {
                state: "NATIVE_ACTIVE",
                transport: "native",
                ownerSnapshot: { nativePolling: true },
              },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: {
                status: "running",
                transport: "native",
                configured: true,
                tokenStored: true,
              },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok", snapshot: { state: "IDLE", transport: "off" } });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const sw = harness.content.querySelector(".switch");
    assert.equal(sw.getAttribute("aria-checked"), "true");

    sw.dispatchEvent({ type: "click" });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.updates)), []);
    assert.ok(
      commandCalls.some((c) => c.name === "telegramMigration.dispatch"
        && c.payload && c.payload.type === "USER_DISABLE"),
      "turning off native-active approval should dispatch USER_DISABLE",
    );
  });

  it("uses native running status while migration snapshot is still loading", async () => {
    const commandCalls = [];
    const never = new Promise(() => {});
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramMigration.snapshot") {
            return never;
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: {
                status: "running",
                transport: "native",
                enabled: true,
                configured: true,
                tokenStored: true,
              },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const sw = harness.content.querySelector(".switch");
    assert.equal(sw.getAttribute("aria-checked"), "true");
    assert.equal(sw.classList.contains("disabled"), false);

    sw.dispatchEvent({ type: "click" });

    assert.ok(
      commandCalls.some((c) => c.name === "telegramMigration.dispatch"
        && c.payload && c.payload.type === "USER_DISABLE"),
      "turning off native-running approval should not wait for the migration snapshot",
    );
  });

  it("turning the Telegram approval switch on starts the native migration test", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: { state: "IDLE", transport: "off", ownerSnapshot: {} },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "stopped", configured: true, tokenStored: true },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    harness.content.querySelector(".switch").dispatchEvent({ type: "click" });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.updates)), []);
    assert.equal(
      commandCalls.some((c) => c.name === "telegramMigration.dispatch"
        && c.payload && c.payload.type === "USER_TEST_NATIVE"),
      true,
      "turning the switch on should dispatch the native test flow",
    );
    assert.equal(
      commandCalls.some((c) => c.name === "telegramMigration.dispatch"
        && c.payload && c.payload.type === "USER_DISABLE"),
      false,
      "turning the switch on should not dispatch USER_DISABLE",
    );
  });

  it("does not show Telegram approval enabled for broken native setup debt", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: { state: "NEEDS_SETUP", transport: "native", ownerSnapshot: {} },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: {
                status: "stopped",
                transport: "native",
                configured: true,
                reason: "native-inactive",
                message: "Native Telegram approval is not active",
                tokenStored: true,
              },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const sw = harness.content.querySelector(".switch");
    assert.equal(sw.getAttribute("aria-checked"), "false");

    sw.dispatchEvent({ type: "click" });
    assert.ok(
      commandCalls.some((c) => c.name === "telegramMigration.dispatch"
        && c.payload && c.payload.type === "USER_TEST_NATIVE"),
      "turning on from broken native setup should retry the native test flow",
    );
  });

  it("disables the independent Telegram approval test while native migration is testing", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramMigration.snapshot") {
            return Promise.resolve({
              status: "ok",
              snapshot: { state: "TESTING_NATIVE", ownerSnapshot: { nativePolling: true } },
            });
          }
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: {
                status: "starting",
                transport: "native",
                configured: true,
                reason: "native-testing",
                message: "Native Telegram approval test is already in progress",
                tokenStored: true,
              },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const testButton = harness.content.querySelectorAll("button")
      .find((button) => button.textContent === "telegramApprovalSendTest");
    assert.equal(testButton.disabled, true);
    assert.match(testButton.title, /Native Telegram approval test/);

    testButton.dispatchEvent({ type: "click" });
    assert.equal(commandCalls.some((call) => call.name === "telegramApproval.test"), false);
  });

  it("disables Telegram approval test until runtime status is ready", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: true,
          allowedTgUserId: "123456789",
          targetSessionKey: "",
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: {
                status: "stopped",
                configured: false,
                reason: "invalid-config",
                message: "Telegram target session key is not configured",
                tokenStored: true,
              },
            });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    harness.render();
    const buttons = harness.content.querySelectorAll("button");
    const testButton = buttons.find((button) => button.textContent === "telegramApprovalSendTest");
    assert.equal(testButton.disabled, true);
    assert.match(testButton.title, /target session key/);

    testButton.dispatchEvent({ type: "click" });
    assert.equal(commandCalls.some((call) => call.name === "telegramApproval.test"), false);
  });

  it("renders Feishu approval setup and saves secrets outside prefs", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
        feishuApproval: {
          enabled: false,
          idType: "open_id",
          approverId: "ou_1",
          connectionTimeoutSeconds: 15,
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramApproval.status") {
            return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: false, masked: "" });
          }
          if (name === "feishuApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "stopped", configured: false, secretsStored: false },
            });
          }
          if (name === "feishuApproval.secretInfo") {
            return Promise.resolve({ status: "ok", configured: false });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });

    const feishuCard = harness.content.querySelector(".feishu-approval-channel-card");
    assert.ok(feishuCard, "Feishu approval card should render");
    const inputs = feishuCard.querySelectorAll("input");
    inputs[0].value = "cli_123";
    inputs[1].value = "app_secret";
    inputs[2].value = "verify";
    inputs[3].value = "encrypt";
    feishuCard.querySelectorAll("button")
      .find((button) => button.textContent === "feishuApprovalSaveSecrets")
      .dispatchEvent({ type: "click" });

    await Promise.resolve();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(commandCalls.find((call) => call.name === "feishuApproval.setSecrets"))), {
      name: "feishuApproval.setSecrets",
      payload: {
        appId: "cli_123",
        appSecret: "app_secret",
        verificationToken: "verify",
        encryptKey: "encrypt",
      },
    });
    assert.equal(harness.updates.some((call) => call.key === "feishuApproval"), false);
  });

  it("saves Feishu approver config and enables testing only when runtime is configured", async () => {
    const commandCalls = [];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
        feishuApproval: {
          enabled: false,
          idType: "open_id",
          approverId: "",
          connectionTimeoutSeconds: 15,
        },
      },
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          if (name === "telegramApproval.status") {
            return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: false, masked: "" });
          }
          if (name === "feishuApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "running", configured: true, secretsStored: true },
            });
          }
          if (name === "feishuApproval.secretInfo") {
            return Promise.resolve({ status: "ok", configured: true, appId: "cli_......abcd" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const feishuCard = harness.content.querySelector(".feishu-approval-channel-card");
    const inputs = feishuCard.querySelectorAll("input");
    const approverInput = inputs[inputs.length - 1];
    approverInput.value = "ou_f1a6f7f520883298be9b9fb9488c1aef";
    approverInput.dispatchEvent({ type: "input" });
    feishuCard.querySelectorAll("button")
      .find((button) => button.textContent === "feishuApprovalSaveApprover")
      .dispatchEvent({ type: "click" });

    await Promise.resolve();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.updates.find((call) => call.key === "feishuApproval"))), {
      key: "feishuApproval",
      value: {
        enabled: false,
        // The snapshot in this test predates the platform field; the save must
        // still carry the migrated value rather than dropping it.
        platform: "feishu",
        idType: "open_id",
        approverId: "ou_f1a6f7f520883298be9b9fb9488c1aef",
        connectionTimeoutSeconds: 15,
      },
    });

    harness.core.state.snapshot.feishuApproval = {
      enabled: true,
      idType: "open_id",
      approverId: "ou_f1a6f7f520883298be9b9fb9488c1aef",
      connectionTimeoutSeconds: 15,
    };
    await Promise.resolve();
    await Promise.resolve();
    harness.render();
    const testButton = harness.content.querySelector(".feishu-approval-channel-card")
      .querySelectorAll("button")
      .find((button) => button.textContent === "feishuApprovalSendTest");
    assert.equal(testButton.disabled, false);
    testButton.dispatchEvent({ type: "click" });
    assert.equal(commandCalls.some((call) => call.name === "feishuApproval.test"), true);
  });

  it("saves Feishu long connection timeout from settings", async () => {
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
        feishuApproval: {
          enabled: true,
          idType: "open_id",
          approverId: "ou_1",
          connectionTimeoutSeconds: 15,
        },
      },
      settingsAPI: {
        command: (name) => {
          if (name === "telegramApproval.status") {
            return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: false, masked: "" });
          }
          if (name === "feishuApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "running", configured: true, secretsStored: true },
            });
          }
          if (name === "feishuApproval.secretInfo") {
            return Promise.resolve({ status: "ok", configured: true, appId: "cli_......abcd" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const select = harness.content.querySelector(".feishu-approval-timeout-select");
    assert.ok(select, "Feishu timeout select should render");
    assert.equal(select.value, "15");
    select.value = "30";
    select.dispatchEvent({ type: "change" });

    await Promise.resolve();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.updates.find((call) => call.key === "feishuApproval"))), {
      key: "feishuApproval",
      value: {
        enabled: true,
        platform: "feishu",
        idType: "open_id",
        approverId: "ou_1",
        connectionTimeoutSeconds: 30,
      },
    });
  });

  it("renders the Feishu event subscription guide and maps test failure codes to localized toasts", async () => {
    const testResults = [
      { status: "error", code: "no-button-response", message: "Feishu test did not receive a button response" },
      { status: "error", code: "not-connected", message: "Feishu approval client is not running" },
      { status: "error", code: "card-send-failed", message: "invalid receive_id" },
    ];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
        feishuApproval: {
          enabled: true,
          idType: "open_id",
          approverId: "ou_1",
          connectionTimeoutSeconds: 15,
        },
      },
      settingsAPI: {
        command: (name) => {
          if (name === "telegramApproval.status") {
            return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: false, masked: "" });
          }
          if (name === "feishuApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "running", configured: true, secretsStored: true },
            });
          }
          if (name === "feishuApproval.secretInfo") {
            return Promise.resolve({ status: "ok", configured: true, appId: "cli_......abcd" });
          }
          if (name === "feishuApproval.test") {
            return Promise.resolve(testResults.shift());
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const feishuCard = harness.content.querySelector(".feishu-approval-channel-card");
    const guideRow = feishuCard.querySelector(".feishu-approval-event-sub-row");
    assert.ok(guideRow, "Feishu event subscription guide group should render");
    assert.equal(guideRow.querySelector(".row-label").textContent, "feishuApprovalEventSubLabel");
    assert.equal(guideRow.querySelector(".row-desc").textContent, "feishuApprovalEventSubDesc");
    assert.equal(guideRow.querySelectorAll(".feishu-approval-event-sub-step").length, 4);

    // The subscription can only be saved after the long connection is up, so
    // the guide must live in the same step section as the test button, after
    // the enable switch — not before it (#493 review).
    const testButton = feishuCard.querySelectorAll("button")
      .find((button) => button.textContent === "feishuApprovalSendTest");
    assert.ok(guideRow.parentNode.contains(testButton), "guide and test button share the step-4 section");

    const toasts = [];
    harness.core.ops.showToast = (message, options) => toasts.push({ message, options });
    assert.equal(testButton.disabled, false);
    for (let i = 0; i < 3; i += 1) {
      testButton.dispatchEvent({ type: "click" });
      await Promise.resolve();
      await Promise.resolve();
    }
    assert.deepStrictEqual(JSON.parse(JSON.stringify(toasts)), [
      { message: "feishuApprovalTestNoResponse", options: { error: true } },
      { message: "feishuApprovalTestNotConnected", options: { error: true } },
      { message: "feishuApprovalTestSendFailed (invalid receive_id)", options: { error: true } },
    ]);
  });

  it("defaults the platform selector to Feishu and saves Lark through the settings controller", async () => {
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: { enabled: false, allowedTgUserId: "", targetSessionKey: "" },
        // A pre-platform config, exactly as an upgrading Feishu user has it.
        feishuApproval: { enabled: true, idType: "open_id", approverId: "ou_1", connectionTimeoutSeconds: 15 },
      },
    });
    harness.render();

    const buttons = harness.content.querySelector(".feishu-approval-platform").querySelectorAll("button");
    assert.deepStrictEqual(buttons.map((b) => b.dataset.platform), ["feishu", "lark"]);
    assert.equal(buttons[0].classList.contains("active"), true, "an old config must render as Feishu");
    assert.equal(buttons[1].classList.contains("active"), false);

    buttons[1].dispatchEvent({ type: "click" });
    await Promise.resolve();

    // Saved via settings-controller (window.settingsAPI.update), not written
    // directly, and carrying the whole normalized config.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.updates.find((call) => call.key === "feishuApproval"))), {
      key: "feishuApproval",
      value: {
        enabled: true,
        platform: "lark",
        idType: "open_id",
        approverId: "ou_1",
        connectionTimeoutSeconds: 15,
      },
    });

    // Clicking the already-active platform must not churn a save.
    const before = harness.updates.length;
    harness.content.querySelector(".feishu-approval-platform").querySelectorAll("button")[0]
      .dispatchEvent({ type: "click" });
    await Promise.resolve();
    assert.equal(harness.updates.length, before, "re-selecting the current platform should be a no-op");
  });

  it("keeps the Lark platform selected across re-render and shows Lark brand copy", async () => {
    const strings = loadSettingsI18nForTest().en;
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: { enabled: false, allowedTgUserId: "", targetSessionKey: "" },
        feishuApproval: { enabled: true, platform: "lark", idType: "open_id", approverId: "ou_1", connectionTimeoutSeconds: 15 },
      },
    });
    harness.core.helpers.t = (key) => (key in strings ? strings[key] : key);
    harness.render();
    harness.render();

    const buttons = harness.content.querySelector(".feishu-approval-platform").querySelectorAll("button");
    assert.equal(buttons[1].classList.contains("active"), true, "Lark must survive a re-render");

    const text = collectText(harness.content.querySelector(".feishu-approval-channel-card"));
    assert.ok(text.length > 0, "sanity: the card must render some text");
    assert.ok(!text.includes("{brand}"), "no raw {brand} token may reach the user");
    assert.ok(text.includes("Lark"), "Lark brand copy should render");
    assert.ok(
      !/Enable Feishu approval|Feishu app credentials|Feishu approver user id/.test(text),
      "Feishu-branded copy must not render while Lark is selected"
    );
    // The channel name names both platforms so a Lark user can find it at all.
    assert.equal(strings.feishuApprovalChannelName, "Feishu / Lark");
    // Brand-bearing copy must not say Feishu while Lark is selected.
    assert.equal(
      strings.feishuApprovalToggle.split("{brand}").join("Lark"),
      "Enable Lark approval"
    );
  });

  it("shows the extra-permission note for user_id only", async () => {
    const strings = loadSettingsI18nForTest().en;
    for (const [idType, shouldShow] of [["open_id", false], ["union_id", false], ["user_id", true]]) {
      const harness = loadTelegramApprovalTabForTest({
        snapshot: {
          tgApproval: { enabled: false, allowedTgUserId: "", targetSessionKey: "" },
          feishuApproval: { enabled: true, platform: "lark", idType, approverId: "ou_1", connectionTimeoutSeconds: 15 },
        },
      });
      harness.core.helpers.t = (key) => (key in strings ? strings[key] : key);
      harness.render();
      const note = harness.content.querySelector(".feishu-approval-id-type-note");
      assert.equal(!!note, shouldShow, `${idType}: user-ID permission note presence`);
      if (shouldShow) assert.match(note.textContent, /Get user user ID/);
    }
  });

  it("reports an invalid App ID instead of claiming the setup is ready to enable", async () => {
    // The real shape main.js produces for a saved-but-malformed App ID: every
    // field is filled in, so the old code fell through to "ready to enable"
    // while configured=false silently disabled the test button.
    const strings = loadSettingsI18nForTest().en;
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: { enabled: false, allowedTgUserId: "", targetSessionKey: "" },
        feishuApproval: { enabled: true, platform: "lark", idType: "open_id", approverId: "ou_1", connectionTimeoutSeconds: 15 },
      },
      settingsAPI: {
        command: (name) => {
          if (name === "telegramApproval.status") return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
          if (name === "telegramApproval.tokenInfo") return Promise.resolve({ status: "ok", configured: false, masked: "" });
          if (name === "feishuApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: {
                status: "stopped",
                enabled: true,
                platform: "lark",
                configured: false,
                reason: "invalid-secret",
                message: "App ID format is invalid",
                secretsStored: true,
                connectionTimeoutSeconds: 15,
              },
            });
          }
          if (name === "feishuApproval.secretInfo") return Promise.resolve({ status: "ok", configured: true, appId: "not-......d-id" });
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.core.helpers.t = (key) => (key in strings ? strings[key] : key);
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const card = harness.content.querySelector(".feishu-approval-channel-card");
    const statusText = card.querySelector(".tg-approval-channel-status-text").textContent;
    assert.equal(
      statusText,
      "That App ID does not look like a self-built app id — Lark self-built app ids start with cli_.",
      "the card must report the blocking reason"
    );
    assert.ok(!statusText.includes("Flip the switch"), "must not claim the setup is ready to enable");
    assert.ok(!statusText.includes("Feishu"), "a Lark user must not be shown Feishu copy");

    // The tooltip explaining the dead test button must be translated too.
    const testButton = card.querySelectorAll("button").find((b) => b.textContent === strings.feishuApprovalSendTest);
    assert.equal(testButton.disabled, true, "an unusable config must not offer a test");
    assert.equal(testButton.title, statusText, "the tooltip must give the same translated reason");
    assert.ok(!testButton.title.includes("App ID format is invalid"), "the raw English diagnostic must not surface");
  });

  it("shows a localized secrets-save failure with the underlying cause as detail", async () => {
    // A disk failure has nothing to do with the platform, and the writer's
    // English diagnostic used to be shown verbatim — Feishu-branded, to a Lark
    // user. Localized sentence first, real cause appended.
    const strings = loadSettingsI18nForTest().en;
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: { enabled: false, allowedTgUserId: "", targetSessionKey: "" },
        feishuApproval: { enabled: false, platform: "lark", idType: "open_id", approverId: "", connectionTimeoutSeconds: 15 },
      },
      settingsAPI: {
        command: (name) => {
          if (name === "telegramApproval.status") return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
          if (name === "telegramApproval.tokenInfo") return Promise.resolve({ status: "ok", configured: false, masked: "" });
          if (name === "feishuApproval.status") {
            return Promise.resolve({ status: "ok", state: { status: "stopped", enabled: false, platform: "lark", configured: false, reason: "disabled", secretsStored: false, secretsConfigured: false } });
          }
          if (name === "feishuApproval.secretInfo") return Promise.resolve({ status: "ok", configured: false });
          if (name === "feishuApproval.setSecrets") {
            return Promise.resolve({ status: "error", code: "write-failed", message: "Secrets write failed: EACCES: permission denied, mkdir" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.core.helpers.t = (key) => (key in strings ? strings[key] : key);
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const toasts = [];
    harness.core.ops.showToast = (message, options) => toasts.push({ message, options });
    const card = harness.content.querySelector(".feishu-approval-channel-card");
    // The secrets row reads all four inputs (App ID, App Secret, Verification
    // Token, Encrypt Key) before saving.
    const inputs = card.querySelectorAll("input");
    inputs[0].value = "cli_app";
    inputs[1].value = "app-secret";
    inputs[2].value = "";
    inputs[3].value = "";
    card.querySelectorAll("button").find((b) => b.textContent === strings.feishuApprovalSaveSecrets)
      .dispatchEvent({ type: "click" });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(toasts.length, 1);
    assert.equal(
      toasts[0].message,
      "Could not save Lark secrets. (Secrets write failed: EACCES: permission denied, mkdir)"
    );
    assert.ok(!toasts[0].message.includes("Feishu"), "a Lark user must not be shown Feishu branding");
  });

  it("treats a half-written secrets file as incomplete, not ready", async () => {
    // status.secretsStored is true for ANY stored secret. Only App ID (no App
    // Secret), or only a Verification Token, must never read as a finished
    // setup: readiness says missing-secret, so the switch and the copy have to
    // agree with it.
    const strings = loadSettingsI18nForTest().en;
    for (const [label, secretInfo, state] of [
      [
        "app id only",
        { configured: false, appId: "cli_......abcd", appSecret: "" },
        { status: "stopped", enabled: true, platform: "lark", configured: false, reason: "missing-secret", message: "App ID and App Secret are not configured", secretsStored: true, secretsConfigured: false },
      ],
      [
        "verification token only",
        { configured: false, appId: "", appSecret: "" },
        { status: "stopped", enabled: true, platform: "lark", configured: false, reason: "missing-secret", message: "App ID and App Secret are not configured", secretsStored: true, secretsConfigured: false },
      ],
    ]) {
      const harness = loadTelegramApprovalTabForTest({
        snapshot: {
          tgApproval: { enabled: false, allowedTgUserId: "", targetSessionKey: "" },
          feishuApproval: { enabled: true, platform: "lark", idType: "open_id", approverId: "ou_1", connectionTimeoutSeconds: 15 },
        },
        settingsAPI: {
          command: (name) => {
            if (name === "telegramApproval.status") return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
            if (name === "telegramApproval.tokenInfo") return Promise.resolve({ status: "ok", configured: false, masked: "" });
            if (name === "feishuApproval.status") return Promise.resolve({ status: "ok", state });
            if (name === "feishuApproval.secretInfo") return Promise.resolve({ status: "ok", ...secretInfo });
            return Promise.resolve({ status: "ok" });
          },
        },
      });
      harness.core.helpers.t = (key) => (key in strings ? strings[key] : key);
      await Promise.resolve();
      await Promise.resolve();
      harness.render();

      const card = harness.content.querySelector(".feishu-approval-channel-card");
      const statusText = card.querySelector(".tg-approval-channel-status-text").textContent;
      assert.equal(statusText, "Save Lark app credentials below to continue.", `${label}: card must ask for credentials`);
      assert.ok(!statusText.includes("Flip the switch"), `${label}: must not claim ready to enable`);

      // The enable switch must not be operable on an incomplete credential set.
      const sw = card.querySelectorAll(".switch")[0];
      assert.equal(sw.classList.contains("disabled"), true, `${label}: enable switch must be disabled`);
      assert.equal(sw.getAttribute("aria-disabled"), "true", `${label}: switch must be marked disabled`);

      // And step 3 must list app credentials as still missing.
      const prereq = card.querySelector(".tg-approval-prereq-row");
      assert.ok(prereq, `${label}: prerequisites row should render`);
      assert.match(prereq.querySelectorAll(".row-desc")[0].textContent, /app credentials/, `${label}: prereq lists credentials`);
    }
  });

  it("keeps 'ready to enable' for a valid config whose switch is simply off", async () => {
    // readiness() short-circuits on `disabled` before it ever inspects the App
    // ID, so a switched-off config must keep its normal copy — the blocking
    // reason path must not swallow it.
    const strings = loadSettingsI18nForTest().en;
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: { enabled: false, allowedTgUserId: "", targetSessionKey: "" },
        feishuApproval: { enabled: false, platform: "feishu", idType: "open_id", approverId: "ou_1", connectionTimeoutSeconds: 15 },
      },
      settingsAPI: {
        command: (name) => {
          if (name === "telegramApproval.status") return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
          if (name === "telegramApproval.tokenInfo") return Promise.resolve({ status: "ok", configured: false, masked: "" });
          if (name === "feishuApproval.status") {
            return Promise.resolve({
              status: "ok",
              state: { status: "stopped", enabled: false, platform: "feishu", configured: false, reason: "disabled", message: "", secretsStored: true },
            });
          }
          if (name === "feishuApproval.secretInfo") return Promise.resolve({ status: "ok", configured: true, appId: "cli_......abcd" });
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.core.helpers.t = (key) => (key in strings ? strings[key] : key);
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const statusText = harness.content.querySelector(".feishu-approval-channel-card")
      .querySelector(".tg-approval-channel-status-text").textContent;
    assert.equal(statusText, strings.feishuApprovalCardReadyToEnable);
  });

  it("translates a connection timeout and falls back to the raw SDK error otherwise", async () => {
    const strings = loadSettingsI18nForTest().en;
    // The brand comes from the saved config (what the user picked), so the
    // snapshot platform must track the case under test.
    async function statusText(state) {
      const harness = loadTelegramApprovalTabForTest({
        snapshot: {
          tgApproval: { enabled: false, allowedTgUserId: "", targetSessionKey: "" },
          feishuApproval: {
            enabled: true,
            platform: state.platform,
            idType: "open_id",
            approverId: "ou_1",
            connectionTimeoutSeconds: state.connectionTimeoutSeconds,
          },
        },
        settingsAPI: {
          command: (name) => {
            if (name === "telegramApproval.status") return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
            if (name === "telegramApproval.tokenInfo") return Promise.resolve({ status: "ok", configured: false, masked: "" });
            if (name === "feishuApproval.status") return Promise.resolve({ status: "ok", state });
            if (name === "feishuApproval.secretInfo") return Promise.resolve({ status: "ok", configured: true, appId: "cli_......abcd" });
            return Promise.resolve({ status: "ok" });
          },
        },
      });
      harness.core.helpers.t = (key) => (key in strings ? strings[key] : key);
      await Promise.resolve();
      await Promise.resolve();
      harness.render();
      return harness.content.querySelector(".feishu-approval-channel-card")
        .querySelector(".tg-approval-channel-status-text").textContent;
    }

    // Our own timeout carries a code -> real copy, with the brand and the
    // configured timeout filled in. Wrong-platform lands here first.
    const timeout = await statusText({
      status: "failed",
      enabled: true,
      platform: "lark",
      configured: true,
      errorCode: "connection-timeout",
      message: "Long connection timed out after 15000ms. Check app credentials, long connection event subscription, and network.",
      connectionTimeoutSeconds: 15,
      secretsStored: true,
    });
    assert.equal(timeout, "Could not reach Lark within 15s. Check that the platform above matches your app, then the App ID / App Secret and your network.");
    assert.ok(!timeout.includes("15000ms"), "the raw English diagnostic must not surface");

    const reconnect = await statusText({
      status: "failed", enabled: true, platform: "feishu", configured: true,
      errorCode: "reconnect-timeout", message: "Long reconnect timed out after 30000ms.", connectionTimeoutSeconds: 30, secretsStored: true,
    });
    assert.match(reconnect, /Lost the Feishu long connection and could not reconnect within 30s/);

    // An SDK failure has no code; showing the upstream string beats hiding the
    // only clue the user has.
    const sdk = await statusText({
      status: "failed", enabled: true, platform: "lark", configured: true,
      errorCode: "", message: "app ticket is invalid", connectionTimeoutSeconds: 15, secretsStored: true,
    });
    assert.equal(sdk, "app ticket is invalid");
  });

  it("maps readiness reason codes to localized, brand-aware toasts", async () => {
    // Previously these fell through to main's raw English Feishu-branded
    // message, which is wrong copy for a Lark user.
    const strings = loadSettingsI18nForTest().en;
    const testResults = [
      { status: "error", code: "invalid-secret", message: "App ID format is invalid" },
      { status: "error", code: "missing-secret", message: "App ID and App Secret are not configured" },
      { status: "error", code: "invalid-config", message: "Approver id is not configured" },
      { status: "error", code: "disabled", message: "Remote approval is disabled" },
    ];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: { enabled: false, allowedTgUserId: "", targetSessionKey: "" },
        feishuApproval: { enabled: true, platform: "lark", idType: "open_id", approverId: "ou_1", connectionTimeoutSeconds: 15 },
      },
      settingsAPI: {
        command: (name) => {
          if (name === "telegramApproval.status") return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
          if (name === "telegramApproval.tokenInfo") return Promise.resolve({ status: "ok", configured: false, masked: "" });
          if (name === "feishuApproval.status") {
            return Promise.resolve({ status: "ok", state: { status: "running", configured: true, secretsStored: true, platform: "lark" } });
          }
          if (name === "feishuApproval.secretInfo") return Promise.resolve({ status: "ok", configured: true, appId: "cli_......abcd" });
          if (name === "feishuApproval.test") return Promise.resolve(testResults.shift());
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.core.helpers.t = (key) => (key in strings ? strings[key] : key);
    await Promise.resolve();
    await Promise.resolve();
    harness.render();

    const toasts = [];
    harness.core.ops.showToast = (message, options) => toasts.push({ message, options });
    const testButton = harness.content.querySelector(".feishu-approval-channel-card")
      .querySelectorAll("button")
      .find((button) => button.textContent === strings.feishuApprovalSendTest);
    for (let i = 0; i < 4; i += 1) {
      testButton.dispatchEvent({ type: "click" });
      await Promise.resolve();
      await Promise.resolve();
    }

    assert.deepStrictEqual(toasts.map((toast) => toast.message), [
      "That App ID does not look like a self-built app id — Lark self-built app ids start with cli_.",
      "App ID and App Secret are not saved yet.",
      "The Lark approval config is incomplete — check the approver user id.",
      "Lark approval is turned off.",
    ]);
    for (const toast of toasts) {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(toast.options)), { error: true });
      assert.ok(!toast.message.includes("Feishu"), `Lark user must not be shown Feishu copy: ${toast.message}`);
      assert.ok(!toast.message.includes("{brand}"), "no raw token may reach the user");
    }
  });

  it("expands only whitelisted hosts in Feishu/Lark guide links", async () => {
    const harness = loadTelegramApprovalTabForTest({});
    const probe = [
      // Feishu near-misses
      "[evil](https://open.feishu.cn.evil.com/x)",
      "[good](https://open.feishu.cn/app)",
      "[userinfo](https://evil.com@open.feishu.cn/app)",
      "[hyphen](https://open-feishu.cn/app)",
      // Lark near-misses: the same attacks must be blocked on the new host.
      "[larkEvil](https://open.larksuite.com.evil.com/x)",
      "[larkGood](https://open.larksuite.com/app)",
      "[larkUserinfo](https://evil.com@open.larksuite.com/app)",
      // An unescaped "." in the whitelist would let this hyphen host through.
      "[larkHyphen](https://open-larksuite.com/app)",
      "[larkSub](https://evil.open.larksuite.com/app)",
      // Non-https and arbitrary custom domains stay out.
      "[http](http://open.larksuite.com/app)",
      "[custom](https://feishu.example.com/app)",
      "[tg](https://t.me/x)",
      "[html <b>label</b>](https://open.feishu.cn/lbl)",
    ].join(" ");
    const originalT = harness.core.helpers.t;
    harness.core.helpers.t = (key) => (key === "feishuApprovalEventSubStep1Html" ? probe : originalT(key));
    harness.render();

    const guideRow = harness.content.querySelector(".feishu-approval-event-sub-row");
    const hrefs = guideRow.querySelectorAll("a").map((a) => a.getAttribute("href"));
    assert.deepStrictEqual(hrefs, [
      "https://open.feishu.cn/app",
      "https://open.larksuite.com/app",
      "https://t.me/x",
      "https://open.feishu.cn/lbl",
    ]);

    // The source whitelist must keep both official hosts, each with its dots
    // escaped — an unescaped "." is what would admit open-larksuite.com.
    const approvalTabSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-telegram-approval.js"), "utf8");
    assert.ok(approvalTabSource.includes("open\\.feishu\\.cn"), "escapeWithLink whitelist should allow open.feishu.cn");
    assert.ok(approvalTabSource.includes("open\\.larksuite\\.com"), "escapeWithLink whitelist should allow open.larksuite.com");
  });

  it("points the guide at the official console of the selected platform only", async () => {
    // Replaces the old hardcoded startsWith("https://open.feishu.cn/") check:
    // render each platform and assert it links to that platform's console and
    // never the other one.
    for (const [platform, expected, forbidden] of [
      ["feishu", "https://open.feishu.cn/", "larksuite.com"],
      ["lark", "https://open.larksuite.com/", "feishu.cn"],
    ]) {
      const harness = loadTelegramApprovalTabForTest({
        snapshot: {
          tgApproval: { enabled: false, allowedTgUserId: "", targetSessionKey: "" },
          feishuApproval: { enabled: false, platform, idType: "open_id", approverId: "", connectionTimeoutSeconds: 15 },
        },
      });
      // Use the real strings so the {consoleUrl}/{brand} tokens are exercised.
      const strings = loadSettingsI18nForTest().en;
      harness.core.helpers.t = (key) => (key in strings ? strings[key] : key);
      harness.render();

      const guideRow = harness.content.querySelector(".feishu-approval-event-sub-row");
      const hrefs = guideRow.querySelectorAll("a").map((a) => a.getAttribute("href"));
      assert.equal(hrefs.length, 1, `${platform}: guide should render exactly one console link`);
      assert.ok(hrefs[0].startsWith(expected), `${platform}: guide link must be on ${expected}, got ${hrefs[0]}`);
      assert.ok(!hrefs[0].includes(forbidden), `${platform}: guide link must not point at ${forbidden}`);

      // No unresolved token may reach the user.
      const guideText = collectText(guideRow);
      assert.ok(guideText.length > 0, `${platform}: sanity: the guide must render some text`);
      assert.ok(!guideText.includes("{consoleUrl}"), `${platform}: {consoleUrl} must be interpolated`);
      assert.ok(!guideText.includes("{brand}"), `${platform}: {brand} must be interpolated`);
    }
  });

  it("refreshes Feishu status while long connection is starting", async () => {
    let feishuStatusCalls = 0;
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: false,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
        feishuApproval: {
          enabled: true,
          idType: "open_id",
          approverId: "ou_1",
          connectionTimeoutSeconds: 15,
        },
      },
      settingsAPI: {
        command: (name) => {
          if (name === "telegramApproval.status") {
            return Promise.resolve({ status: "ok", state: { status: "stopped", tokenStored: false } });
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: false, masked: "" });
          }
          if (name === "feishuApproval.status") {
            feishuStatusCalls += 1;
            return Promise.resolve({
              status: "ok",
              state: feishuStatusCalls === 1
                ? { status: "starting", configured: true, secretsStored: true }
                : { status: "failed", configured: true, secretsStored: true, message: "connection timeout" },
            });
          }
          if (name === "feishuApproval.secretInfo") {
            return Promise.resolve({ status: "ok", configured: true, appId: "cli_......abcd" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(feishuStatusCalls, 1);
    assert.equal(harness.timers.length, 1);
    assert.equal(harness.timers[0].ms, 1000);

    harness.timers[0].cb();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(feishuStatusCalls, 2);
    assert.equal(harness.renderRequests.some((payload) => payload && payload.content === true), true);
  });

  it("repaints Telegram approval after forced status refresh overlaps pending status", async () => {
    const staleStatus = createDeferred();
    const updatedStatus = createDeferred();
    const statusResponses = [staleStatus, updatedStatus];
    const harness = loadTelegramApprovalTabForTest({
      snapshot: {
        tgApproval: {
          enabled: true,
          allowedTgUserId: "123456789",
          targetSessionKey: "telegram:123456789",
        },
      },
      settingsAPI: {
        command: (name) => {
          if (name === "telegramApproval.status") {
            const next = statusResponses.shift();
            assert.ok(next, "unexpected Telegram status request");
            return next.promise;
          }
          if (name === "telegramApproval.tokenInfo") {
            return Promise.resolve({ status: "ok", configured: true, masked: "1234……wXyZ" });
          }
          return Promise.resolve({ status: "ok" });
        },
      },
    });

    // The send-test button is the last button on the tab; click it to force
    // a status refresh that overlaps the in-flight initial status request.
    const buttons = harness.content.querySelectorAll("button");
    buttons[buttons.length - 1].dispatchEvent({ type: "click" });
    await Promise.resolve();
    await Promise.resolve();
    const beforeStatusResolve = harness.renderRequests.length;

    staleStatus.resolve({
      status: "ok",
      state: {
        status: "stopped",
        configured: false,
        reason: "missing-token",
        message: "Telegram bot token is not configured",
        tokenStored: false,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(harness.renderRequests.length, beforeStatusResolve + 1);

    harness.render();
    updatedStatus.resolve({
      status: "ok",
      state: {
        status: "running",
        configured: true,
        reason: "",
        message: "",
        tokenStored: true,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(harness.renderRequests.length, beforeStatusResolve + 2);
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
    assert.ok(/\.doctor-modal\s*\{[\s\S]*width:\s*min\(728px,\s*100%\);[\s\S]*max-height:\s*calc\(100vh \/ var\(--clawd-text-zoom, 1\) - 32px\);/.test(css));
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

  it("unifies the size slider on the simple volume-style control (no floating bubble, no ticks)", () => {
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const tabSource = fs.readFileSync(SETTINGS_TAB_GENERAL, "utf8");
    // Old floating-bubble/tick design must be fully gone.
    assert.ok(!/\.size-bubble/.test(css));
    assert.ok(!/\.size-ticks/.test(css));
    assert.ok(!/\.size-slider-wrap/.test(css));
    assert.ok(!/size-bubble/.test(tabSource));
    assert.ok(!/size-ticks/.test(tabSource));
    // The size row reuses the volume-style classes plus its preview-session
    // drag affordances.
    assert.ok(/volume-control size-control/.test(tabSource));
    assert.ok(/volume-slider size-slider/.test(tabSource));
    assert.ok(/\.size-control\.dragging \.volume-slider::-webkit-slider-thumb/.test(css));
    assert.ok(/\.size-control\.pending \.volume-slider\s*\{[\s\S]*cursor:\s*ew-resize;/.test(css));
  });

  it("compensates every viewport unit for the injected text zoom", () => {
    // vh/vw resolve against the UNZOOMED window (verified by probe: a 100vh
    // box renders S× the window height under the injected root zoom), so any
    // bare viewport unit overflows the window at scale > 1 — symptom:
    // settings pages that cannot scroll to the bottom. Every occurrence must
    // divide by --clawd-text-zoom or use the zoom-aware 100% chain instead.
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const dashboardHtml = fs.readFileSync(path.join(SRC_DIR, "dashboard.html"), "utf8");
    const mainSource = fs.readFileSync(MAIN_PROCESS, "utf8");
    const bare = css.match(/\d+(?:\.\d+)?v[hw]\b(?!\s*\/\s*var\(--clawd-text-zoom)/g) || [];
    assert.deepStrictEqual(bare, [], "settings.css has uncompensated viewport units");
    assert.doesNotMatch(dashboardHtml, /\d+(?:\.\d+)?v[hw]\b/, "dashboard.html must not use viewport units");
    assert.match(mainSource, /height:calc\(100vh \/ \$\{resumeScale\}\)/);
  });

  it("keeps the text-scale slider in sync across display moves without fighting a live drag", () => {
    const tabSource = fs.readFileSync(SETTINGS_TAB_GENERAL, "utf8");
    const uiCoreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    // The committed percent is per-display and lives main-side; a window move
    // never produces a settings-changed broadcast, so the row must subscribe
    // to the context-changed poke from the settings-window runtime…
    assert.ok(/onTextScaleContextChanged\(\(\) => \{\s*if \(!previewLive\) syncFromContext\(\);/.test(tabSource),
      "text-scale row must re-pull context on display change, gated on previewLive");
    // …and must not repaint to the committed value mid-drag (the preview
    // itself triggers pokes via applyTextScaleNow).
    assert.ok(/previewLive = true;/.test(tabSource));
    // Preview exits clear the flag: manual pointer release, commit (change),
    // and rollback (blur).
    // (Lookbehind excludes the `let previewLive = false;` declaration.)
    assert.strictEqual((tabSource.match(/(?<!let )previewLive = false;/g) || []).length, 3);
    // Full re-renders must dispose the row (unsubscribe + roll back a
    // stranded transient preview) — see clearMountedControls.
    assert.ok(/unsubscribeContextChanged\(\);/.test(tabSource));
    assert.ok(/mountedControls\.textScale && typeof state\.mountedControls\.textScale\.dispose === "function"/.test(uiCoreSource),
      "clearMountedControls must dispose the text-scale control");
    assert.ok(/state\.mountedControls\.textScale = null;/.test(uiCoreSource));
    // Renderer-side rollback rides IPC and can't be trusted during window
    // teardown — main must clear the transient preview when settings closes,
    // or a mid-drag ⌘W pins the preview scale to the display until restart.
    const mainSource = fs.readFileSync(MAIN_PROCESS, "utf8");
    assert.ok(/onBeforeClosed: \(\) => \{[^}]*endTextScalePreview\(\);/.test(mainSource),
      "settings onBeforeClosed must end a live text-scale preview");
  });

  it("keeps text-scale pointer drags stable while the Settings page live-zooms", async () => {
    const previewCalls = [];
    const commandCalls = [];
    const harness = loadGeneralTabForTest({
      snapshot: makeGeneralSnapshot(),
      settingsAPI: {
        getTextScaleContext: () => Promise.resolve({ percent: 100 }),
        previewTextScale: (value) => {
          previewCalls.push(value);
          return Promise.resolve({ status: "ok" });
        },
        endTextScalePreview: () => Promise.resolve({ status: "ok" }),
        command: (action, payload) => {
          commandCalls.push({ action, payload });
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.renderContent();
    await Promise.resolve();

    const slider = harness.content.querySelector(".text-scale-slider");
    assert.ok(slider);
    let rect = { left: 100, width: 240, top: 0, height: 28, right: 340, bottom: 28 };
    slider.getBoundingClientRect = () => rect;

    slider.dispatchEvent({
      type: "pointerdown",
      pointerId: 1,
      button: 0,
      isPrimary: true,
      screenX: 160,
      clientX: 160,
      bubbles: false,
    });

    // Simulate the Settings page live-zooming wider after the first preview.
    // The manual pointer math must keep using the pointerdown geometry above:
    // screenX 145 is 95% on the original 240px track, but would be ~90% if the
    // now-wider track were used mid-drag.
    rect = { left: 100, width: 384, top: 0, height: 45, right: 484, bottom: 45 };
    slider.dispatchEvent({
      type: "pointermove",
      pointerId: 1,
      screenX: 145,
      clientX: 145,
      bubbles: false,
    });
    assert.strictEqual(slider.value, "95");
    assert.strictEqual(previewCalls.at(-1), 0.95);

    slider.dispatchEvent({
      type: "pointerup",
      pointerId: 1,
      screenX: 145,
      clientX: 145,
      bubbles: false,
    });
    await Promise.resolve();

    assert.strictEqual(commandCalls.at(-1).action, "setTextScaleForDisplay");
    assert.strictEqual(commandCalls.at(-1).payload.value, 0.95);
  });

  it("makes both percent readouts clickable reset buttons", () => {
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const tabSource = fs.readFileSync(SETTINGS_TAB_GENERAL, "utf8");
    assert.ok(/\.text-scale-readout\s*\{[\s\S]*cursor:\s*pointer;/.test(css));
    // Size readout resets the pet to the prefs default (P:9 → 30 on the UI scale).
    assert.ok(/SIZE_UI_DEFAULT = 30/.test(tabSource));
    assert.ok(/controller\.change\(SIZE_UI_DEFAULT\)/.test(tabSource));
    assert.ok(/rowSizeResetTitle/.test(tabSource));
    // Text-size readout resets to 100% via the per-display command.
    assert.ok(/setTextScaleForDisplay/.test(tabSource));
    assert.ok(/textScaleResetTitle/.test(tabSource));
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
    const pickerSource = fs.readFileSync(LANGUAGE_PICKER_JS, "utf8");
    const pickerCss = fs.readFileSync(LANGUAGE_PICKER_CSS, "utf8");
    const settingsHtml = fs.readFileSync(SETTINGS_HTML, "utf8");

    assert.ok(new RegExp(
      String.raw`const LANGUAGE_OPTIONS = \[` +
      SUPPORTED_LANGS.map((lang) => String.raw`"${lang}"`).join(String.raw`,\s*`) +
      String.raw`\];`
    ).test(generalSource));
    assert.ok(generalSource.includes("createLanguagePicker"));
    assert.ok(pickerSource.includes(`className = "language-picker"`));
    assert.ok(pickerSource.includes(`aria-haspopup", "listbox"`));
    assert.ok(pickerSource.includes(`role", "listbox"`));
    assert.ok(pickerSource.includes(`aria-hidden", "true"`));
    assert.ok(pickerSource.includes(`role", "option"`));
    assert.ok(settingsHtml.includes(`href="language-picker.css"`));
    assert.ok(settingsHtml.includes(`src="language-picker.js"`));
    assert.ok(!generalSource.includes("language-segmented"));
    assert.ok(!generalSource.includes("runtime.languageTransition"));
    assert.ok(!generalSource.includes("--language-active-index"));
    assert.ok(!coreSource.includes("languageTransition"));
    assert.ok(/\.language-picker-menu\s*\{[\s\S]*box-shadow:/.test(pickerCss));
    assert.ok(/\.language-picker-option:hover\s*\{[\s\S]*background:/.test(pickerCss));
    assert.ok(/\.language-picker-option:focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--text-primary,\s*var\(--text\)\);[\s\S]*outline-offset:\s*-2px;[\s\S]*background:/.test(pickerCss));
    assert.ok(/\.language-picker-option\.selected\s*\{[\s\S]*color:\s*var\(--accent\);/.test(pickerCss));
    assert.ok(/@media \(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*\.language-picker-menu/.test(pickerCss));
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.language-picker-trigger,[\s\S]*\.language-picker-chevron,[\s\S]*\.language-picker-menu[\s\S]*transition:\s*none;/.test(pickerCss));
    assert.ok(/@media \(forced-colors:\s*active\)\s*\{[\s\S]*\.language-picker-trigger:focus-visible,[\s\S]*\.language-picker-option:focus-visible\s*\{[\s\S]*outline-color:\s*Highlight;/.test(pickerCss));
    assert.ok(!pickerCss.includes(".language-segmented"));
  });

  it("lets the open language picker escape its section without changing closed-card clipping", () => {
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const sectionRowsRule = css.match(/\.section-rows\s*\{([^}]*)\}/);
    const openSectionRule = css.match(/\.section:has\(\.language-picker\.open\)\s*\{([^}]*)\}/);
    const openRowsRule = css.match(/\.section-rows:has\(\.language-picker\.open\)\s*\{([^}]*)\}/);

    assert.ok(sectionRowsRule, "settings cards should retain their base clipping rule");
    assert.match(sectionRowsRule[1], /overflow:\s*hidden;/);
    assert.ok(openSectionRule, "the section containing an open language picker should be raised");
    assert.match(openSectionRule[1], /position:\s*relative;/);
    assert.match(openSectionRule[1], /z-index:\s*1;/);
    assert.ok(openRowsRule, "the open language picker should escape the settings card");
    assert.match(openRowsRule[1], /overflow:\s*visible;/);
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
    assert.strictEqual(trigger.attributes["aria-label"], "Language: English");
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
    assert.strictEqual(trigger.focused, true);
    assert.strictEqual(harness.getLangMenu().attributes["aria-hidden"], "true");
    for (const option of options) assert.strictEqual(option.tabIndex, -1);
    assert.strictEqual(harness.getLangValue().textContent, "Chinese");
    assert.strictEqual(trigger.attributes["aria-label"], "Language: Chinese");

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
    assert.strictEqual(trigger.attributes["aria-label"], "Language: English");
    assert.strictEqual(options[0].attributes["aria-selected"], "true");

    harness.core.ops.applyChanges({
      changes: { lang: "zh" },
      snapshot: { lang: "zh" },
    });
    assert.strictEqual(harness.getContentRenderCount(), 2);
    assert.strictEqual(harness.getLangValue().textContent, "Chinese");
    assert.strictEqual(harness.getLangTrigger().attributes["aria-label"], "Language: Chinese");
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
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(harness.updateCalls, [{ key: "lang", value: "zh" }]);
    assert.strictEqual(harness.getLangValue().textContent, "English");
    assert.strictEqual(trigger.focused, true);
    assert.strictEqual(harness.getToastText(), "Failed: synthetic failure");
  });

  it("rolls concurrent failed language saves back to the last committed value", async () => {
    const saves = [];
    const changes = [];
    const harness = loadSharedLanguagePickerForTest({
      onChange: (next, previous) => {
        const deferred = createDeferred();
        saves.push(deferred);
        changes.push({ next, previous });
        return deferred.promise;
      },
    });

    harness.trigger.dispatchEvent({ type: "click" });
    harness.optionElements[1].dispatchEvent({ type: "click" });
    harness.trigger.dispatchEvent({ type: "click" });
    harness.optionElements[2].dispatchEvent({ type: "click" });
    assert.strictEqual(harness.valueElement.textContent, "JA");
    assert.deepStrictEqual(changes, [
      { next: "zh", previous: "en" },
      { next: "ja", previous: "en" },
    ]);

    saves[0].resolve(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(harness.valueElement.textContent, "JA", "stale failure keeps the latest optimistic value");

    saves[1].resolve(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(harness.valueElement.textContent, "EN", "latest failure restores the committed value");
  });

  it("advances the rollback baseline after a concurrent language save succeeds", async () => {
    const saves = [];
    const harness = loadSharedLanguagePickerForTest({
      onChange: () => {
        const deferred = createDeferred();
        saves.push(deferred);
        return deferred.promise;
      },
    });

    harness.trigger.dispatchEvent({ type: "click" });
    harness.optionElements[1].dispatchEvent({ type: "click" });
    harness.trigger.dispatchEvent({ type: "click" });
    harness.optionElements[2].dispatchEvent({ type: "click" });

    saves[0].resolve(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(harness.valueElement.textContent, "JA", "newer optimistic choice remains visible");

    saves[1].resolve(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(harness.valueElement.textContent, "ZH", "failed latest choice restores the successful save");
  });

  it("flips and bounds the tutorial picker at minimum-size enlarged-text geometry", () => {
    const harness = loadSharedLanguagePickerForTest({
      options: ["en", "zh", "zh-TW", "ko", "ja"],
      innerHeight: 450,
    });
    harness.boundary.getBoundingClientRect = () => ({ top: 52, bottom: 400 });
    harness.trigger.getBoundingClientRect = () => ({ top: 220, bottom: 274 });
    Object.defineProperty(harness.menu, "scrollHeight", { value: 240 });
    Object.defineProperty(harness.menu, "offsetHeight", { value: 242 });
    Object.defineProperty(harness.menu, "clientHeight", { value: 240 });

    harness.trigger.dispatchEvent({ type: "click" });

    assert.strictEqual(harness.picker.classList.contains("open-up"), true);
    assert.strictEqual(harness.picker.classList.contains("menu-scrollable"), true);
    assert.strictEqual(harness.menu.style.maxHeight, "162px");
    assert.ok(parseInt(harness.menu.style.maxHeight, 10) < harness.menu.scrollHeight);
    const css = fs.readFileSync(LANGUAGE_PICKER_CSS, "utf8");
    assert.match(css, /\.language-picker\.menu-scrollable \.language-picker-menu\s*\{[\s\S]*overflow-y:\s*auto;/);
    assert.match(css, /\.language-picker\.open-up \.language-picker-menu\s*\{[\s\S]*bottom:\s*calc\(100% \+ 6px\);/);
  });

  it("initially reveals and bounds the tutorial picker at 150% and 160% text scale", () => {
    const layouts = [
      { scale: "150%", boundaryBottom: 313.7, triggerTop: 317.1, triggerBottom: 353.1 },
      { scale: "160%", boundaryBottom: 290.3, triggerTop: 316.6, triggerBottom: 352.6 },
    ];

    for (const layout of layouts) {
      const harness = loadSharedLanguagePickerForTest({
        options: ["en", "zh", "zh-TW", "ko", "ja"],
        innerHeight: 400,
      });
      harness.boundary.getBoundingClientRect = () => ({ top: 52, bottom: layout.boundaryBottom });
      harness.trigger.getBoundingClientRect = () => ({
        top: layout.triggerTop - harness.boundary.scrollTop,
        bottom: layout.triggerBottom - harness.boundary.scrollTop,
      });
      Object.defineProperty(harness.menu, "scrollHeight", { value: 160 });
      Object.defineProperty(harness.menu, "offsetHeight", { value: 162 });
      Object.defineProperty(harness.menu, "clientHeight", { value: 160 });

      assert.ok(
        harness.trigger.getBoundingClientRect().top > layout.boundaryBottom,
        `${layout.scale}: regression setup must start with the trigger behind the footer`,
      );

      harness.control.ensureVisible();
      const visibleTrigger = harness.trigger.getBoundingClientRect();
      assert.ok(visibleTrigger.top >= 52, `${layout.scale}: trigger top stays inside the body`);
      assert.ok(
        visibleTrigger.bottom <= layout.boundaryBottom,
        `${layout.scale}: trigger bottom stays inside the body`,
      );

      harness.trigger.dispatchEvent({ type: "click" });
      assert.strictEqual(
        harness.picker.classList.contains("open-up"),
        true,
        `${layout.scale}: menu flips upward`,
      );
      const menuBottom = visibleTrigger.top - 6;
      const menuTop = menuBottom - parseInt(harness.menu.style.maxHeight, 10);
      const firstOption = { top: menuTop + 6, bottom: menuTop + 36 };
      const lastOption = { top: menuBottom - 36, bottom: menuBottom - 6 };
      assert.ok(firstOption.top >= 52, `${layout.scale}: first option stays inside the body`);
      assert.ok(
        lastOption.bottom <= layout.boundaryBottom,
        `${layout.scale}: last option stays inside the body`,
      );
    }
  });

  it("reflows an open tutorial picker after the window is resized", () => {
    const harness = loadSharedLanguagePickerForTest({
      options: ["en", "zh", "zh-TW", "ko", "ja"],
      innerHeight: 450,
    });
    const layout = {
      boundaryTop: 52,
      boundaryBottom: 352.8,
      triggerTop: 295.7,
      triggerBottom: 331.7,
    };
    harness.boundary.getBoundingClientRect = () => ({
      top: layout.boundaryTop,
      bottom: layout.boundaryBottom,
    });
    harness.trigger.getBoundingClientRect = () => ({
      top: layout.triggerTop - harness.boundary.scrollTop,
      bottom: layout.triggerBottom - harness.boundary.scrollTop,
    });
    Object.defineProperty(harness.menu, "scrollHeight", { value: 160 });
    Object.defineProperty(harness.menu, "offsetHeight", { value: 162 });
    Object.defineProperty(harness.menu, "clientHeight", { value: 160 });

    harness.trigger.dispatchEvent({ type: "click" });
    assert.strictEqual(harness.picker.classList.contains("open"), true);
    assert.strictEqual(harness.getWindowListenerCount("resize"), 1);

    layout.boundaryBottom = 290.3;
    layout.triggerTop = 316.6;
    layout.triggerBottom = 352.6;
    assert.ok(
      harness.trigger.getBoundingClientRect().top > layout.boundaryBottom,
      "regression setup must put the trigger behind the fixed footer",
    );

    harness.dispatchWindowEvent("resize");
    harness.dispatchWindowEvent("resize");
    assert.strictEqual(
      harness.getPendingAnimationFrameCount(),
      1,
      "resize work is coalesced into one animation frame",
    );
    harness.flushAnimationFrames();

    const visibleTrigger = harness.trigger.getBoundingClientRect();
    assert.ok(visibleTrigger.top >= layout.boundaryTop);
    assert.ok(visibleTrigger.bottom <= layout.boundaryBottom);
    assert.strictEqual(harness.picker.classList.contains("open-up"), true);
    assert.strictEqual(harness.menu.style.maxHeight, "162px");

    harness.control.dispose();
    assert.strictEqual(harness.getWindowListenerCount("resize"), 0);
  });

  it("does not show a scrollbar when an upward menu fits all language options", () => {
    const harness = loadSharedLanguagePickerForTest({
      options: ["en", "zh", "zh-TW", "ko", "ja"],
      innerHeight: 600,
    });
    harness.boundary.getBoundingClientRect = () => ({ top: 72, bottom: 502 });
    harness.trigger.getBoundingClientRect = () => ({ top: 445, bottom: 499 });
    Object.defineProperty(harness.menu, "scrollHeight", { value: 160 });
    Object.defineProperty(harness.menu, "offsetHeight", { value: 162 });
    Object.defineProperty(harness.menu, "clientHeight", { value: 160 });

    harness.trigger.dispatchEvent({ type: "click" });

    assert.strictEqual(harness.picker.classList.contains("open-up"), true);
    assert.strictEqual(harness.picker.classList.contains("menu-scrollable"), false);
    assert.strictEqual(harness.menu.style.maxHeight, "162px");
  });

  it("cleans up language picker document listeners across re-renders", () => {
    const harness = loadGeneralLanguageRowForTest({
      snapshot: { lang: "en" },
    });

    harness.core.ops.requestRender({ content: true });
    const staleOption = harness.getLangOptions()[1];
    assert.strictEqual(harness.getDocumentListenerCount("click"), 1);
    assert.strictEqual(harness.getDocumentListenerCount("keydown"), 1);

    harness.core.ops.requestRender({ content: true });
    assert.strictEqual(harness.getDocumentListenerCount("click"), 1);
    assert.strictEqual(harness.getDocumentListenerCount("keydown"), 1);

    staleOption.dispatchEvent({ type: "click" });
    assert.deepStrictEqual(harness.updateCalls, []);
  });

  it("closes the language picker from outside clicks and Escape", () => {
    const harness = loadGeneralLanguageRowForTest({
      snapshot: { lang: "en" },
    });

    harness.core.ops.requestRender({ content: true });
    harness.getLangTrigger().dispatchEvent({ type: "click" });
    assert.strictEqual(harness.getLangPicker().classList.contains("open"), true);

    harness.dispatchDocumentEvent("click", { target: new FakeElement("body") });
    assert.strictEqual(harness.getLangPicker().classList.contains("open"), false);

    harness.getLangTrigger().dispatchEvent({ type: "click" });
    harness.dispatchDocumentEvent("keydown", {
      key: "Escape",
      preventDefault() { this.defaultPrevented = true; },
    });
    assert.strictEqual(harness.getLangPicker().classList.contains("open"), false);
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

  it("registers the Session cleanup group with three number rows, atomic reset, and i18n keys", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    const uiCoreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const actionsSource = fs.readFileSync(path.join(SRC_DIR, "settings-actions.js"), "utf8");

    // Group is mounted top-level in the General tab (not nested under HUD).
    assert.ok(generalSource.includes("buildSessionCleanupGroup()"));
    assert.ok(generalSource.includes('id: "general:session-cleanup"'));

    // All three numeric prefs map to their own number input row.
    assert.ok(generalSource.includes('key: "sessionStaleMs"'));
    assert.ok(generalSource.includes('key: "workingStaleMs"'));
    assert.ok(generalSource.includes('key: "detachedIdleStaleMs"'));
    assert.ok(generalSource.includes("buildNumberInputRow"));
    assert.ok(generalSource.includes("SESSION_CLEANUP_NUMBER_KEYS"));

    // Reset button goes through the atomic command path.
    assert.ok(generalSource.includes('"sessionCleanup.setTriple"'));
    assert.ok(generalSource.includes("SESSION_CLEANUP_DEFAULTS"));
    assert.ok(generalSource.includes('"actionResetSessionCleanup"'));

    // patchInPlace covers the new keys in BOTH the existence guard and the sync loop.
    assert.ok(generalSource.match(/SESSION_CLEANUP_NUMBER_KEYS\.has\(key\)[\s\S]+sessionCleanupControls\.get\(key\)\.syncFromSnapshot\(\)/));

    // ui-core registers the helper and the mountedControls bag.
    assert.ok(uiCoreSource.includes("buildNumberInputRow"));
    assert.ok(uiCoreSource.includes("sessionCleanupControls: new Map()"));
    assert.ok(uiCoreSource.includes("state.mountedControls.sessionCleanupControls.clear()"));

    // The command is registered in settings-actions.
    assert.ok(actionsSource.includes('"sessionCleanup.setTriple": setSessionCleanupTriple'));

    // i18n keys present in all five languages.
    for (const key of [
      "rowSessionCleanupGroup",
      "rowSessionCleanupGroupDesc",
      "rowStaleSession",
      "rowStaleSessionDesc",
      "rowStaleWorking",
      "rowStaleWorkingDesc",
      "rowStaleDetached",
      "rowStaleDetachedDesc",
      "unitMinutes",
      "unitSeconds",
      "valueDisabled",
      "actionResetSessionCleanup",
    ]) {
      const matches = i18nSource.match(new RegExp(`\\b${key}:`, "g"));
      assert.ok(matches && matches.length >= 5, `${key} should appear in all 5 language tables (saw ${matches ? matches.length : 0})`);
    }
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
    assert.ok(generalSource.includes("sessionHudSummaryLabels"));
    assert.ok(generalSource.includes('key: "sessionHudShowStateLabels"'));
    assert.ok(generalSource.includes("session-hud-summary-control"));
    assert.ok(/\.settings-option-list\s*\{[\s\S]*display:\s*grid;[\s\S]*gap:\s*8px;/.test(css));
    assert.ok(/\.settings-option-list \.settings-option-item\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--panel-bg\) 78%,\s*transparent\);/.test(css));
    assert.ok(/\.session-hud-collapsible \.collapsible-summary-chip,[\s\S]*\.sound-collapsible \.collapsible-summary-chip\s*\{[\s\S]*max-width:\s*min\(280px,\s*100%\);/.test(css));
    assert.ok(/\.session-hud-collapsible \.collapsible-group-summary\s*\{[\s\S]*flex:\s*0 0 auto;[\s\S]*max-width:\s*none;/.test(css));
    assert.ok(/\.sound-collapsible \.collapsible-group-summary\s*\{[\s\S]*flex:\s*0 0 auto;[\s\S]*max-width:\s*none;/.test(css));
    assert.ok(/\.bubble-policy-collapsible \.collapsible-group-summary\s*\{[^}]*flex:\s*0 0 auto;[^}]*flex-wrap:\s*nowrap;[^}]*max-width:\s*none;[^}]*\}/.test(css));
    assert.ok(!/\.session-hud-collapsible \.collapsible-group-summary\s*\{[^}]*flex-wrap:\s*nowrap;/.test(css));
    assert.ok(!/\.sound-collapsible \.collapsible-group-summary\s*\{[^}]*flex-wrap:\s*nowrap;/.test(css));
    assert.ok(/\.session-hud-summary-control\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*max-content\);/.test(css));
    assert.ok(/\.session-hud-summary-control\.compact\s*\{[\s\S]*display:\s*inline-flex;[\s\S]*width:\s*auto;/.test(css));
    assert.ok(/@media \(max-width:\s*720px\)\s*\{[\s\S]*\.session-hud-collapsible \.collapsible-group-header\s*\{[\s\S]*flex-wrap:\s*wrap;/.test(css));
    assert.ok(/@media \(max-width:\s*720px\)\s*\{[\s\S]*\.session-hud-collapsible \.collapsible-group-summary\s*\{[\s\S]*flex:\s*0 0 calc\(100% - 22px\);[\s\S]*margin-left:\s*22px;/.test(css));
    assert.ok(/@media \(max-width:\s*720px\)\s*\{[\s\S]*\.session-hud-summary-control\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*width:\s*min\(238px,\s*100%\);/.test(css));
    assert.ok(/\.collapsible-group-text \.row-label\s*\{[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/.test(css));
    assert.ok(/\.collapsible-group-text \.row-desc\s*\{[\s\S]*white-space:\s*normal;[\s\S]*-webkit-line-clamp:\s*2;/.test(css));
    assert.ok(/\.sound-summary-control\s*\{[\s\S]*display:\s*inline-flex;/.test(css));
    assert.ok(/\.sound-summary-control\s*\{[\s\S]*min-width:\s*max-content;/.test(css));
    assert.ok(/\.sound-summary-control \.collapsible-summary-chip\s*\{[\s\S]*max-width:\s*none;/.test(css));
    assert.ok(/\.sound-summary-control \.collapsible-summary-chip\s*\{[\s\S]*flex:\s*0 0 auto;/.test(css));
    assert.ok(/\.sound-collapsible \.collapsible-group-text \.row-desc\s*\{[\s\S]*white-space:\s*normal;[\s\S]*-webkit-line-clamp:\s*2;/.test(css));
    assert.ok(i18nSource.includes("rowSoundEnabled"));
  });

  it("adds hover affordance to General sliders via the shared volume-style classes", () => {
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    assert.ok(/\.volume-slider:hover::-webkit-slider-thumb\s*\{[\s\S]*transform:\s*scale\(1\.08\);/.test(css));
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.volume-slider:hover::-webkit-slider-thumb,[\s\S]*\.size-control\.dragging \.volume-slider::-webkit-slider-thumb\s*\{[\s\S]*transform:\s*none;/.test(css));
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
    const uiCoreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    assert.ok(uiCoreSource.includes("settings-confirm-modal"));
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
    assert.ok(uiCoreSource.includes('tone === "accent"'));
    assert.ok(uiCoreSource.includes('tone === "danger"'));
  });

  it("keeps Claude hooks confirmations inside the Settings renderer", () => {
    const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
    const mainSource = fs.readFileSync(MAIN_PROCESS, "utf8");
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    const agentsSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-agents.js"), "utf8");
    const uiCoreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    assert.ok(agentsSource.includes("confirmDisableClaudeHookManagement"));
    assert.ok(agentsSource.includes("runDisconnectClaudeHooks"));
    assert.ok(agentsSource.includes("showSettingsConfirmModal({"));
    assert.ok(agentsSource.includes("claudeHooksDisableConfirmTitle"));
    assert.ok(agentsSource.includes("claudeHooksDisconnectConfirmTitle"));
    assert.ok(uiCoreSource.includes("buttons.find((action) => action.action && action.action.defaultFocus)"));
    assert.ok(uiCoreSource.includes('button.className = `soft-btn${toneClass ? ` ${toneClass}` : ""}`;'));
    assert.ok(uiCoreSource.includes('tone === "accent"'));
    assert.ok(uiCoreSource.includes('tone === "danger"'));
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

  it("renders three permission automation modes with two confirmation-gated automatic choices", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    const css = fs.readFileSync(SETTINGS_CSS, "utf8");
    assert.ok(generalSource.includes("PERMISSION_AUTOMATION_OPTIONS"));
    assert.ok(generalSource.includes('{ id: "off", labelKey: "permissionAutomationOff" }'));
    assert.ok(generalSource.includes('{ id: "auto-tools", labelKey: "permissionAutomationAutoTools" }'));
    assert.ok(generalSource.includes('{ id: "unattended", labelKey: "permissionAutomationUnattended" }'));
    assert.ok(generalSource.includes('window.settingsAPI.command("setPermissionAutomationMode"'));
    assert.ok(generalSource.includes("confirmed: true"));
    assert.ok(generalSource.includes("showPermissionAutomationConfirmModal"));
    assert.ok(generalSource.includes("permissionAutomationUnattendedConfirmTitle"));
    assert.ok(generalSource.includes("permissionAutomationAutoToolsWarningDismissed"));
    assert.ok(generalSource.includes("permissionAutomationUnattendedWarningDismissed"));
    assert.ok(generalSource.includes("permissionAutomationAutoToolsDontShowAgain"));
    assert.ok(generalSource.includes("permissionAutomationUnattendedDontShowAgain"));
    assert.ok(generalSource.includes("suppressFutureConfirmation: result.checkboxChecked === true"));
    assert.ok(generalSource.includes("isPermissionAutomationWarningDismissed(mode)"));
    assert.ok(i18nSource.includes("permissionAutomationAutoToolsDontShowAgain"));
    assert.ok(i18nSource.includes("permissionAutomationUnattendedDontShowAgain"));
    assert.ok(css.includes(".settings-confirm-checkbox"));
    assert.ok(coreSource.includes("checkboxLabel = \"\""));
    assert.ok(coreSource.includes('checkboxInput.type = "checkbox"'));
    assert.ok(coreSource.includes("checkboxChecked: !!(checkboxInput && checkboxInput.checked)"));
    assert.ok(css.includes("grid-template-columns: repeat(3, minmax(0, 1fr))"));
    assert.ok(generalSource.includes('segmented.setAttribute("role", "group")'));
    assert.ok(generalSource.includes('segmented.setAttribute("aria-label", t("rowPermissionAutomation"))'));
    assert.ok(generalSource.includes('btn.setAttribute("aria-pressed", selected ? "true" : "false")'));
    assert.ok(i18nSource.includes('rowPermissionAutomation: "Permission request handling"'));
    assert.ok(i18nSource.includes('rowPermissionAutomation: "权限请求处理"'));
    assert.ok(i18nSource.includes("permissionAutomationAutoToolsConfirmTitle"));
    assert.ok(i18nSource.includes("CodeBuddy"));
    assert.ok(!generalSource.includes("autoApproveAllPermissions"));
    // Lives in its own Permissions section, not under Bubbles.
    assert.ok(generalSource.includes('t("sectionPermissions")'));
    assert.ok(i18nSource.includes('sectionPermissions: "Permissions"'));
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
      sessionHudShowStateLabels: true,
      sessionHudShowElapsed: true,
      sessionHudShowContextUsage: true,
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
    const labels = harness.getSwitch("sessionHudShowStateLabels");
    const elapsed = harness.getSwitch("sessionHudShowElapsed");
    const contextUsage = harness.getSwitch("sessionHudShowContextUsage");
    const cleanup = harness.getSwitch("sessionHudCleanupDetached");
    const summary = harness.core.state.mountedControls.sessionHudSummary.element;
    const optionList = harness.content.querySelector(".session-hud-option-list");
    assert.ok(master);
    assert.ok(labels);
    assert.ok(elapsed);
    assert.ok(contextUsage);
    assert.ok(cleanup);
    assert.ok(optionList);
    assert.ok(optionList.children.every((child) => child.classList.contains("settings-option-item")));
    assert.strictEqual(harness.getSwitchMeta("sessionHudEnabled").row.querySelector(".row-desc"), null);
    assert.strictEqual(summary.children.length, 1);
    assert.strictEqual(summary.children[0].textContent, "HUD: off");
    assert.strictEqual(summary.classList.contains("compact"), true);
    assert.strictEqual(labels.classList.contains("disabled"), true);
    assert.strictEqual(labels.attributes["aria-disabled"], "true");
    assert.strictEqual(labels.tabIndex, -1);
    assert.strictEqual(elapsed.classList.contains("disabled"), true);
    assert.strictEqual(elapsed.attributes["aria-disabled"], "true");
    assert.strictEqual(elapsed.tabIndex, -1);
    assert.strictEqual(contextUsage.classList.contains("disabled"), true);
    assert.strictEqual(contextUsage.attributes["aria-disabled"], "true");
    assert.strictEqual(contextUsage.tabIndex, -1);

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
    assert.strictEqual(harness.getSwitch("sessionHudShowStateLabels"), labels);
    assert.strictEqual(harness.getSwitch("sessionHudShowElapsed"), elapsed);
    assert.strictEqual(harness.getSwitch("sessionHudShowContextUsage"), contextUsage);
    assert.strictEqual(harness.getSwitch("sessionHudCleanupDetached"), cleanup);
    assert.strictEqual(master.classList.contains("on"), true);
    assert.strictEqual(master.classList.contains("pending"), false);
    assert.strictEqual(labels.classList.contains("disabled"), false);
    assert.strictEqual(labels.attributes["aria-disabled"], undefined);
    assert.strictEqual(labels.tabIndex, 0);
    assert.strictEqual(elapsed.classList.contains("disabled"), false);
    assert.strictEqual(elapsed.attributes["aria-disabled"], undefined);
    assert.strictEqual(elapsed.tabIndex, 0);
    assert.strictEqual(contextUsage.classList.contains("disabled"), false);
    assert.strictEqual(contextUsage.attributes["aria-disabled"], undefined);
    assert.strictEqual(contextUsage.tabIndex, 0);
    assert.strictEqual(cleanup.classList.contains("disabled"), false);
    assert.strictEqual(cleanup.tabIndex, 0);
    assert.strictEqual(summary.children.length, 4);
    assert.strictEqual(summary.classList.contains("compact"), false);
    assert.strictEqual(summary.children[0].textContent, "Labels: on");
    assert.strictEqual(summary.children[1].textContent, "Time: on");
    assert.strictEqual(summary.children[2].textContent, "Context: on");
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

  it("keeps the quota ring as an independent sibling of the Session HUD", async () => {
    const harness = loadGeneralTabForTest({
      snapshot: makeGeneralSnapshot({
        sessionHudEnabled: false,
        sessionHudShowQuota: true,
        claudeQuotaCollectionEnabled: false,
        quotaMergeSources: false,
      }),
      settingsAPI: {
        getQuotaSourceCount: async () => 2,
      },
    });
    harness.renderContent();
    await new Promise((resolve) => setImmediate(resolve));

    const ringEnabled = harness.getSwitch("sessionHudShowQuota");
    const claudeCollection = harness.getSwitch("claudeQuotaCollectionEnabled");
    const mergeSources = harness.getSwitch("quotaMergeSources");
    const ringOptions = harness.content.querySelector(".quota-ring-option-list");
    const hudOptions = harness.content.querySelector(".session-hud-option-list");
    const summary = harness.core.state.mountedControls.sessionHudSummary.element;

    assert.ok(ringEnabled);
    assert.ok(claudeCollection);
    assert.ok(mergeSources);
    assert.ok(ringOptions);
    assert.ok(hudOptions);
    assert.notStrictEqual(ringOptions, hudOptions);
    assert.strictEqual(ringEnabled.classList.contains("disabled"), false);
    assert.strictEqual(mergeSources.classList.contains("disabled"), false);
    assert.strictEqual(harness.getSwitchMeta("quotaMergeSources").row.style.display, "");
    assert.strictEqual(summary.children.length, 1);
    assert.strictEqual(summary.children[0].textContent, "HUD: off");
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

  it("renders Claude hook management in the Agents claude-code group with autoStart gated", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        manageClaudeHooksAutomatically: false,
        autoStartWithClaude: true,
        agents: { "claude-code": { integrationInstalled: true, enabled: true } },
      },
      agentMetadata: [
        { id: "claude-code", name: "Claude Code", eventSource: "hook", capabilities: {} },
      ],
    });

    harness.core.ops.requestRender({ content: true });

    const manage = harness.core.state.mountedControls.generalSwitches.get("manageClaudeHooksAutomatically");
    const autoStart = harness.core.state.mountedControls.generalSwitches.get("autoStartWithClaude");
    assert.ok(manage, "manage-hooks switch should mount inside the Agents claude-code group");
    assert.ok(autoStart, "autoStart switch should mount inside the Agents claude-code group");
    // Master is off, so the child autoStart is disabled at render time (D2: Agents
    // does a full rebuild on these keys instead of an in-place patch).
    assert.strictEqual(autoStart.element.classList.contains("disabled"), true);
    assert.ok(autoStart.extraElement, "autoStart shows the disabled note when management is off");
  });

  it("re-gates autoStart when Claude hook management toggles via applyChanges (D2 full rebuild)", () => {
    const baseSnapshot = {
      manageClaudeHooksAutomatically: true,
      autoStartWithClaude: true,
      agents: { "claude-code": { integrationInstalled: true, enabled: true } },
    };
    const harness = loadAgentsTabForTest({
      snapshot: { ...baseSnapshot },
      agentMetadata: [
        { id: "claude-code", name: "Claude Code", eventSource: "hook", capabilities: {} },
      ],
    });

    harness.core.ops.requestRender({ content: true });

    // Master is on, so the child autoStart starts enabled with no disabled note.
    let autoStart = harness.core.state.mountedControls.generalSwitches.get("autoStartWithClaude");
    assert.ok(autoStart, "autoStart switch should mount inside the Agents claude-code group");
    assert.strictEqual(autoStart.element.classList.contains("disabled"), false);
    assert.strictEqual(autoStart.extraElement, null);

    // Turning management off is not an `agents` patch, so Agents falls through to a
    // full rebuild (D2) — the rebuilt child must come back disabled with the note.
    harness.core.ops.applyChanges({
      changes: { manageClaudeHooksAutomatically: false },
      snapshot: { ...baseSnapshot, manageClaudeHooksAutomatically: false },
    });

    autoStart = harness.core.state.mountedControls.generalSwitches.get("autoStartWithClaude");
    assert.ok(autoStart, "autoStart switch should remount after the rebuild");
    assert.strictEqual(autoStart.element.classList.contains("disabled"), true);
    assert.ok(autoStart.extraElement, "autoStart shows the disabled note after management is turned off");

    // Turning management back on re-enables the child and drops the note.
    harness.core.ops.applyChanges({
      changes: { manageClaudeHooksAutomatically: true },
      snapshot: { ...baseSnapshot, manageClaudeHooksAutomatically: true },
    });

    autoStart = harness.core.state.mountedControls.generalSwitches.get("autoStartWithClaude");
    assert.strictEqual(autoStart.element.classList.contains("disabled"), false);
    assert.strictEqual(autoStart.extraElement, null);
  });

  it("patches hide-bubbles aggregate changes without rebuilding General content", () => {
    const initialSnapshot = {
      lang: "en",
      size: 50,
      sessionHudEnabled: true,
      sessionHudShowStateLabels: true,
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
    const labels = harness.getSwitch("sessionHudShowStateLabels");
    const elapsed = harness.getSwitch("sessionHudShowElapsed");
    const cleanup = harness.getSwitch("sessionHudCleanupDetached");
    assert.ok(master);
    assert.ok(labels);
    assert.ok(elapsed);
    assert.ok(cleanup);
    assert.strictEqual(labels.classList.contains("disabled"), false);
    assert.strictEqual(elapsed.classList.contains("disabled"), false);
    assert.strictEqual(cleanup.classList.contains("disabled"), false);

    const beforeRenderCount = harness.getContentRenderCount();
    harness.core.ops.applyChanges({
      changes: { sessionHudEnabled: false },
      snapshot: { ...initialSnapshot, sessionHudEnabled: false },
    });

    assert.strictEqual(harness.getContentRenderCount(), beforeRenderCount);
    assert.strictEqual(harness.getSwitch("sessionHudEnabled"), master);
    assert.strictEqual(harness.getSwitch("sessionHudShowStateLabels"), labels);
    assert.strictEqual(harness.getSwitch("sessionHudShowElapsed"), elapsed);
    assert.strictEqual(harness.getSwitch("sessionHudCleanupDetached"), cleanup);
    assert.strictEqual(master.classList.contains("on"), false);
    assert.strictEqual(labels.classList.contains("disabled"), true);
    assert.strictEqual(labels.attributes["aria-disabled"], "true");
    assert.strictEqual(labels.tabIndex, -1);
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

  it("moves Claude hook management out of General into the Agents claude-code group", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const agentsSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-agents.js"), "utf8");
    // No longer rendered or patched by the General tab.
    assert.ok(!generalSource.includes('key: "manageClaudeHooksAutomatically"'));
    assert.ok(!generalSource.includes('key: "autoStartWithClaude"'));
    assert.ok(!generalSource.includes("CLAUDE_HOOK_MANAGEMENT_CHILD_SWITCH_KEYS"));
    assert.ok(!generalSource.includes("manageClaudeHooksAutomatically"));
    // Built in the Agents claude-code group as top-level pref rows.
    assert.ok(agentsSource.includes("buildClaudeHookManagementRows"));
    assert.ok(agentsSource.includes('agent.id === "claude-code"'));
    assert.ok(agentsSource.includes('key: "manageClaudeHooksAutomatically"'));
    assert.ok(agentsSource.includes('key: "autoStartWithClaude"'));
    assert.ok(agentsSource.includes("rowManageClaudeHooks"));
    assert.ok(agentsSource.includes("rowStartWithClaude"));
    // autoStart stays gated on the master (disabled + extra note computed at render).
    assert.ok(agentsSource.includes("disabled: !manageHooksEnabled"));
    assert.ok(agentsSource.includes('descExtraKey: manageHooksEnabled ? null : "rowStartWithClaudeDisabledDesc"'));
    // Confirm/disconnect flows moved with the switches.
    assert.ok(agentsSource.includes("confirmDisableClaudeHookManagement"));
    assert.ok(agentsSource.includes("runDisconnectClaudeHooks"));
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
    // Child selectors, not descendant: nested groups (Feishu event-sub guide
    // inside the channel card) must not inherit the outer group's chevron state.
    assert.ok(/\.collapsible-group\.collapsed\s*>\s*\.collapsible-group-header\s*>\s*\.collapsible-group-chevron\s*\{[\s\S]*transform:\s*translateX\(-6px\) rotate\(0deg\);/.test(css));
    assert.ok(/\.collapsible-group:not\(\.collapsed\)\s*>\s*\.collapsible-group-header\s*>\s*\.collapsible-group-chevron\s*\{[\s\S]*transform:\s*translateX\(-6px\) rotate\(90deg\);[\s\S]*color:\s*var\(--accent\);[\s\S]*opacity:\s*1;/.test(css));
    assert.ok(!/\.collapsible-group\.collapsed\s+\.collapsible-group-chevron/.test(css), "descendant chevron selector would leak outer state into nested groups");
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.collapsible-group-chevron,[\s\S]*\.anim-override-chevron,[\s\S]*transition:\s*none;/.test(css));
    assert.ok(i18nSource.includes("collapsibleExpand"));
    assert.ok(i18nSource.includes("collapsibleCollapse"));
  });

  it("groups Theme cards and exposes theme import actions in Settings", () => {
    const tabSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-theme.js"), "utf8");
    const generalSource = fs.readFileSync(SETTINGS_TAB_GENERAL, "utf8");
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
    assert.ok(tabSource.includes('btn.className = "theme-customize-btn";'));
    assert.ok(tabSource.includes("function renderThemeDetail(parent, theme)"));
    assert.ok(tabSource.includes("function supportsThemeCustomization(theme)"));
    assert.ok(!generalSource.includes("rowPetColor"));
    assert.ok(!generalSource.includes("petTint"));
    assert.ok(tabSource.includes('caps.powerProfile === "scripted"'));
    assert.ok(tabSource.includes("themeCapabilityFineMotion"));
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
    assert.ok(css.includes(".theme-customize-btn"));
    assert.ok(css.includes(".theme-detail-hero"));
    assert.ok(css.includes(".theme-customization-row"));
    assert.ok(/\.theme-card-footer\s*\{[^}]*min-height:\s*26px;[^}]*margin-top:\s*auto;[^}]*\}/.test(css));
    assert.ok(/\.theme-card-check\s*\{[^}]*white-space:\s*nowrap;[^}]*\}/.test(css));
    assert.ok(i18nSource.includes("themeImportPetZip"));
    assert.ok(i18nSource.includes("themeImportUserThemeZip"));
    assert.ok(i18nSource.includes("themeImportUserThemeZipHint"));
    assert.ok(i18nSource.includes("themeOpenUserThemesFolder"));
    assert.ok(i18nSource.includes("toastUserThemeZipImportOk"));
    assert.ok(i18nSource.includes("toastCodexPetZipImportOk"));
    assert.ok(i18nSource.includes("toastCodexPetRemoveOk"));
    assert.ok(i18nSource.includes("themeCustomize"));
    assert.ok(i18nSource.includes("themeBackToPets"));
    assert.ok(i18nSource.includes("themeAppearanceTitle"));
    assert.ok(i18nSource.includes("rowPetAccessory"));
    assert.ok(i18nSource.includes("accessoryCowboyHat"));

    const strings = loadSettingsI18nForTest();
    assert.strictEqual(strings.en.themeActionGroupCodexPets, "Codex Pets");
    assert.strictEqual(strings.en.themeActionGroupUserThemes, "User themes");
    assert.strictEqual(strings.en.themeImportPetZip, "Import Codex Pet package (.zip)");
    assert.strictEqual(strings.en.themeImportUserThemeZip, "Import Clawd theme package (.zip)");
    assert.ok(strings.en.themeImportUserThemeZipHint.includes("theme.json"));
    assert.strictEqual(strings.en.themeOpenUserThemesFolder, "Open themes folder");
    assert.strictEqual(strings.en.themeRefreshThemes, "Refresh themes");
    assert.strictEqual(strings.en.themeCapabilityFineMotion, "Fine motion");
    assert.strictEqual(strings.en.themeCustomize, "Customize");
    assert.strictEqual(strings.en.rowPetAccessory, "Accessory");
    assert.strictEqual(strings.en.accessoryWizardHat, "Wizard hat");
    assert.strictEqual(strings.zh.themeCustomize, "装扮");
    assert.strictEqual(strings.zh.rowPetAccessory, "配饰");
    assert.strictEqual(strings.zh.accessoryWizardHat, "巫师帽");
    assert.strictEqual(strings.zh.themeImportPetZip, "导入 Codex Pet 包（.zip）");
    assert.strictEqual(strings.zh.themeCapabilityFineMotion, "精细动效");
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

  it("keeps customization visible on every capable pet while omitting Calico", () => {
    const supported = loadThemeTabForTest({
      themes: [
        {
          id: "clawd",
          name: "Clawd",
          builtin: true,
          active: true,
          capabilities: { petTint: true },
        },
        {
          id: "calico",
          name: "Calico",
          builtin: true,
          active: false,
          capabilities: { petTint: false, accessories: false },
        },
        {
          id: "cloudling",
          name: "Cloudling",
          builtin: true,
          active: false,
          capabilities: { petTint: false, accessories: true },
        },
      ],
    });
    const buttons = supported.content.querySelectorAll(".theme-customize-btn");
    assert.strictEqual(buttons.length, 2);
    assert.deepStrictEqual(
      buttons.map((button) => collectText(findAncestorByClass(button, "theme-card")))
        .map((text) => (text.includes("Cloudling") ? "Cloudling" : "Clawd"))
        .sort(),
      ["Clawd", "Cloudling"]
    );

    const calicoActive = loadThemeTabForTest({
      themes: [
        {
          id: "calico",
          name: "Calico",
          builtin: true,
          active: true,
          capabilities: { petTint: false, accessories: false },
        },
      ],
    });
    assert.strictEqual(calicoActive.content.querySelectorAll(".theme-customize-btn").length, 0);
    assert.strictEqual(calicoActive.content.querySelector(".theme-detail-hero"), null);
  });

  it("selects an inactive capable pet and opens its customization in one click", async () => {
    let listThemesCalls = 0;
    const harness = loadThemeTabForTest({
      themes: [
        {
          id: "clawd",
          name: "Clawd",
          builtin: true,
          active: true,
          capabilities: { petTint: true },
        },
        {
          id: "cloudling",
          name: "Cloudling",
          builtin: true,
          active: false,
          capabilities: { petTint: false, accessories: true },
        },
      ],
      settingsAPI: {
        listThemes: () => {
          listThemesCalls += 1;
          return Promise.reject(new Error("theme enumeration unavailable"));
        },
      },
    });
    const cloudlingButton = harness.content.querySelectorAll(".theme-customize-btn")
      .find((button) => collectText(findAncestorByClass(button, "theme-card")).includes("Cloudling"));
    assert.ok(cloudlingButton);

    cloudlingButton.dispatchEvent({ type: "click" });
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(harness.commands)),
      [{
        name: "setThemeSelection",
        payload: { themeId: "cloudling" },
      }]
    );
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(harness.content.querySelector(".theme-detail-hero"));
    assert.ok(collectText(harness.content.querySelector(".theme-detail-heading")).includes("Cloudling"));
    assert.ok(harness.content.querySelector(".pet-accessory-select"));
    assert.strictEqual(harness.content.querySelector(".pet-tint-select"), null);
    assert.strictEqual(harness.content.querySelector(".theme-grid"), null);
    assert.strictEqual(listThemesCalls, 0, "opening details should not depend on a second theme fetch");
  });

  it("does not open stale customization when the activated runtime disables it", async () => {
    const harness = loadThemeTabForTest({
      themes: [
        {
          id: "clawd",
          name: "Clawd",
          builtin: true,
          active: true,
          capabilities: { petTint: true, accessories: true },
        },
        {
          id: "custom",
          name: "Custom",
          builtin: false,
          active: false,
          capabilities: { petTint: false, accessories: true },
        },
      ],
      settingsAPI: {
        command: () => Promise.resolve({
          status: "ok",
          customizationCapabilities: { petTint: false, accessories: false },
        }),
      },
    });
    const customButton = harness.content.querySelectorAll(".theme-customize-btn")[1];
    assert.ok(customButton);

    customButton.dispatchEvent({ type: "click" });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(harness.content.querySelector(".theme-detail-hero"), null);
    assert.strictEqual(harness.content.querySelector(".pet-accessory-select"), null);
    const runtimeCustom = harness.core.runtime.themeList
      .find((theme) => theme && theme.id === "custom");
    assert.strictEqual(runtimeCustom.active, true);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(runtimeCustom.capabilities)),
      { petTint: false, accessories: false }
    );
    const activeCustomCard = harness.content.querySelectorAll(".theme-card")
      .find((card) => {
        const name = card.querySelector(".theme-card-name");
        return name && collectText(name).includes("Custom");
      });
    assert.strictEqual(activeCustomCard.getAttribute("aria-checked"), "true");
  });

  it("updates customization capability after normal theme-card activation", async () => {
    const harness = loadThemeTabForTest({
      themes: [
        {
          id: "clawd",
          name: "Clawd",
          builtin: true,
          active: true,
          capabilities: { petTint: true, accessories: true },
        },
        {
          id: "custom",
          name: "Custom",
          builtin: false,
          active: false,
          capabilities: { petTint: false, accessories: false },
        },
      ],
      settingsAPI: {
        command: () => Promise.resolve({
          status: "ok",
          customizationCapabilities: { petTint: false, accessories: true },
        }),
      },
    });
    const customCard = harness.content.querySelectorAll(".theme-card")
      .find((card) => {
        const name = card.querySelector(".theme-card-name");
        return name && collectText(name).includes("Custom");
      });
    assert.ok(customCard);
    assert.strictEqual(customCard.querySelector(".theme-customize-btn"), null);

    customCard.dispatchEvent({ type: "click" });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    const activeCustom = harness.core.runtime.themeList
      .find((theme) => theme && theme.id === "custom");
    assert.strictEqual(activeCustom.active, true);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(activeCustom.capabilities)),
      { petTint: false, accessories: true }
    );
    const rerenderedCard = harness.content.querySelectorAll(".theme-card")
      .find((card) => {
        const name = card.querySelector(".theme-card-name");
        return name && collectText(name).includes("Custom");
      });
    assert.ok(rerenderedCard.querySelector(".theme-customize-btn"));
  });

  it("keeps existing theme cards when a refresh returns an impossible empty list", async () => {
    const harness = loadThemeTabForTest({
      themes: [
        {
          id: "clawd",
          name: "Clawd",
          builtin: true,
          active: true,
          capabilities: { petTint: true },
        },
      ],
      settingsAPI: {
        // settings:list-themes reports [] when main catches an enumeration
        // failure, even though a healthy install always has built-in themes.
        listThemes: () => Promise.resolve([]),
      },
    });
    const previousThemeList = harness.core.runtime.themeList;

    const result = await harness.core.ops.fetchThemes();
    harness.renderContent();

    assert.strictEqual(result, previousThemeList);
    assert.strictEqual(harness.core.runtime.themeList, previousThemeList);
    assert.strictEqual(harness.content.querySelectorAll(".theme-card").length, 1);
  });

  it("opens the active pet detail and saves color independently for that theme", async () => {
    const harness = loadThemeTabForTest({
      themes: [
        {
          id: "clawd",
          name: "Clawd",
          builtin: true,
          active: true,
          previewFileUrl: "file:///clawd.svg",
          capabilities: { petTint: true, accessories: true },
        },
      ],
      snapshot: {
        petTint: { clawd: "matcha", cloudling: "vaporwave" },
        petAccessory: { clawd: "wizard-hat", cloudling: "halo" },
      },
      petTintOptions: [
        { id: "none", labelKey: "tintNone" },
        { id: "midnight", labelKey: "tintMidnight" },
        { id: "gold", labelKey: "tintGold" },
        { id: "vaporwave", labelKey: "tintVaporwave" },
        { id: "matcha", labelKey: "tintMatcha" },
        { id: "mono", labelKey: "tintMono" },
      ],
      petAccessoryOptions: [
        { id: "none", labelKey: "accessoryNone" },
        { id: "cowboy-hat", labelKey: "accessoryCowboyHat" },
        { id: "wizard-hat", labelKey: "accessoryWizardHat" },
        { id: "halo", labelKey: "accessoryHalo" },
      ],
    });

    harness.content.querySelector(".theme-customize-btn").dispatchEvent({ type: "click" });
    assert.ok(harness.content.querySelector(".theme-detail-back"));
    assert.ok(harness.content.querySelector(".theme-detail-hero"));
    assert.strictEqual(harness.content.querySelectorAll(".theme-customization-row").length, 2);
    assert.strictEqual(harness.content.querySelector(".theme-grid"), null);

    const select = harness.content.querySelector(".pet-tint-select");
    assert.strictEqual(select.value, "matcha");
    assert.deepStrictEqual(
      select.children.map((option) => option.textContent),
      ["Default", "🌙 Midnight", "🥇 Gold", "🌸 Vaporwave", "🍵 Matcha", "⬜ Monochrome"]
    );

    select.value = "gold";
    select.dispatchEvent({ type: "change" });
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(harness.updates)),
      [{
        key: "petTint",
        value: { clawd: "gold", cloudling: "vaporwave" },
      }]
    );
    assert.strictEqual(select.disabled, true);
    assert.strictEqual(select.classList.contains("pending"), true);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(select.disabled, false);
    assert.strictEqual(select.classList.contains("pending"), false);

    const accessorySelect = harness.content.querySelector(".pet-accessory-select");
    assert.strictEqual(accessorySelect.value, "wizard-hat");
    assert.deepStrictEqual(
      accessorySelect.children.map((option) => option.textContent),
      ["None", "Cowboy hat", "Wizard hat", "Halo"]
    );
    accessorySelect.value = "halo";
    accessorySelect.dispatchEvent({ type: "change" });
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(harness.updates[1])),
      {
        key: "petAccessory",
        value: { clawd: "halo", cloudling: "halo" },
      }
    );
    assert.strictEqual(accessorySelect.disabled, true);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(accessorySelect.disabled, false);

    harness.content.querySelector(".theme-detail-back").dispatchEvent({ type: "click" });
    assert.ok(harness.content.querySelector(".theme-grid"));
    assert.strictEqual(harness.content.querySelector(".theme-detail-hero"), null);
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
    assert.ok(/\.collapsible-group\.collapsed\s*>\s*\.collapsible-group-body\s*\{[\s\S]*opacity:\s*0;[\s\S]*transform:\s*translateY\(-4px\);/.test(css));
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
    assert.ok(agentsSource.includes("sortAgentMetadataForSettings(metadata)"));
    assert.ok(agentsSource.includes("function categorizeAgentsForSections("));
    assert.ok(agentsSource.includes("function renderConnectedSubtab("));
    assert.ok(agentsSource.includes("function renderDiscoverSubtab("));
  });

  it("lists agents flat, with no Coding AI / Office AI grouping layer", () => {
    const agentsSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-agents.js"), "utf8");
    const orderSource = fs.readFileSync(path.join(SRC_DIR, "settings-agent-order.js"), "utf8");
    const i18nSource = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
    const css = fs.readFileSync(path.join(SRC_DIR, "settings.css"), "utf8");
    assert.ok(agentsSource.includes("function buildAgentRows("));
    assert.ok(!agentsSource.includes("buildAgentCategoryGroup("));
    assert.ok(!agentsSource.includes("categorizeAgentsByType("));
    assert.ok(!agentsSource.includes("getAgentCategory"));
    assert.ok(!orderSource.includes("getAgentCategory"));
    assert.ok(!i18nSource.includes("agentCategoryCoding"));
    assert.ok(!i18nSource.includes("agentCategoryWork"));
    assert.ok(!css.includes(".agent-category-group"));
    assert.ok(!css.includes(".agent-category-count"));
  });

  it("counts a registered custom AI as connected, listed beside built-ins", () => {
    const id = "custom-nova-ai-0123456789ab";
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          [id]: { integrationInstalled: false, enabled: true },
          qoderwork: { integrationInstalled: true, enabled: true },
        },
        customApplications: [],
        customToolDiscoveryPaths: [],
      },
      agentMetadata: [
        {
          id,
          name: "Nova AI",
          category: "code",
          eventSource: "custom-http",
          custom: true,
          capabilities: {},
        },
        {
          id: "qoderwork",
          name: "QoderWork",
          category: "work",
          eventSource: "hook",
          capabilities: {},
        },
      ],
    });
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1,
      agents: [],
      customAgents: [{ agentId: id, detectedInstalled: true, confidence: "high" }],
      customTools: [],
      skippedAgentIds: [],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;
    harness.core.ops.requestRender({ content: true });

    // Registering is what connects a custom AI, so it belongs in Connected
    // rather than being demoted into the discover subtab. Both agents list
    // flat: a custom "code" agent and a built-in "work" one, no category boxes.
    const connected = harness.content.querySelector(".agent-section-connected");
    assert.ok(connected);
    assert.strictEqual(connected.querySelector(".agent-category-group"), null);
    assert.deepStrictEqual(
      connected.querySelectorAll(".agent-summary-row .row-label").map((node) => node.textContent),
      ["Nova AI", "QoderWork"]
    );
    assert.strictEqual(harness.content.querySelector(".agent-section-recommended"), null);
    // Its executable resolves, so no missing-binary badge yet.
    assert.strictEqual(connected.querySelector(".custom-missing"), null);

    // Losing the executable no longer moves the agent out of Connected, so the
    // row itself has to report it.
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 2,
      agents: [],
      customAgents: [{ agentId: id, detectedInstalled: false, confidence: "high" }],
      customTools: [],
      skippedAgentIds: [],
    };
    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();

    const stillConnected = harness.content.querySelector(".agent-section-connected");
    assert.deepStrictEqual(
      stillConnected.querySelectorAll(".agent-summary-row .row-label").map((node) => node.textContent),
      ["Nova AI", "QoderWork"],
      "a vanished executable must not evict the agent from Connected"
    );
    const missing = stillConnected.querySelector(".custom-missing");
    assert.ok(missing, "the row reports the missing executable");
    assert.strictEqual(missing.textContent, "Path missing");
  });

  it("renders Custom AI detection under one manual folder picker", () => {
    const agentsSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-agents.js"), "utf8");
    const coreSource = fs.readFileSync(path.join(SRC_DIR, "settings-ui-core.js"), "utf8");
    const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
    const css = fs.readFileSync(path.join(SRC_DIR, "settings.css"), "utf8");

    assert.ok(coreSource.includes("function readCustomToolDetectionResults("));
    assert.ok(coreSource.includes("function readCustomAgentDetectionResults("));
    assert.ok(coreSource.includes("hints.customTools"));
    assert.ok(agentsSource.includes("function buildCustomToolResultRows("));
    assert.ok(agentsSource.includes("readCustomToolDetectionResults"));
    assert.ok(agentsSource.includes('className = "row row-sub custom-tool-result-row"'));
    assert.ok(agentsSource.includes("pickAgentDiscoveryPath"));
    assert.ok(preloadSource.includes('ipcRenderer.invoke("settings:pick-agent-discovery-path"'));
    assert.ok(agentsSource.includes('pickAgentDiscoveryPath("directory")'));
    assert.ok(!agentsSource.includes('labelKey: "rowAgentDiscoveryPaths"'));
    assert.ok(agentsSource.includes('await ops.fetchAgentInstallationHints({ force: true })'));
    assert.ok(agentsSource.includes("function buildWslScanControl("));
    assert.ok(agentsSource.includes('control.className = "custom-tool-wsl-scan"'));
    assert.ok(!agentsSource.includes('toolbar.className = "agent-scan-toolbar"'));
    assert.ok(css.includes(".custom-tool-result-status"));
    assert.match(css, /\.agent-custom-tools-section \.custom-tool-discovery-row\s*\{[^}]*flex-direction:\s*column;/s);
    // The primary picker must keep a higher-specificity selector than the
    // generic `.soft-btn.accent` tinted rule that follows it, or the cascade
    // falls back to source order and drops the solid accent fill.
    assert.match(css, /\.agent-custom-tools-section \.soft-btn\.custom-tool-path-picker\s*\{[^}]*background:\s*var\(--accent\);/s);
    assert.ok(!/\.custom-tool-path-picker\s*\{[^}]*width:\s*100%;/s.test(css));
    assert.ok(!/\.custom-tool-scan\s*\{[^}]*width:\s*100%;/s.test(css));
  });

  it("filters the undetected catalog from its header search box", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        lang: "en",
        agents: {
          "gemini-cli": { integrationInstalled: false, enabled: false },
          "kimi-code": { integrationInstalled: false, enabled: false },
          "qwen-code": { integrationInstalled: false, enabled: false },
        },
        customToolDiscoveryPaths: [],
      },
      agentMetadata: [
        { id: "gemini-cli", name: "Gemini CLI", eventSource: "hook", capabilities: {} },
        { id: "kimi-code", name: "Kimi Code", eventSource: "hook", capabilities: {} },
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
      ],
    });
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1,
      agents: [],
      customTools: [],
      skippedAgentIds: [],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;
    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();

    const group = harness.content.querySelector(".agent-unavailable-group");
    assert.ok(group, "undetected agents render as a collapsible catalog");
    assert.ok(group.classList.contains("collapsed"), "catalog starts collapsed");
    const search = group.querySelector(".agent-section-search");
    assert.ok(search, "the catalog header carries a search box");
    assert.strictEqual(search.placeholder, "Search");
    assert.strictEqual(group.querySelector(".agent-section-count").textContent, "3");

    const visibleNames = () => group
      .querySelectorAll(".agent-summary-row .row-label")
      .filter((label) => {
        let node = label;
        while (node) {
          if (node.classList && node.classList.contains("agent-row-filtered-out")) return false;
          node = node.parentNode;
        }
        return true;
      })
      .map((label) => label.textContent);
    assert.deepStrictEqual(visibleNames(), ["Gemini CLI", "Kimi Code", "Qwen Code"]);

    search.value = "kim";
    search.dispatchEvent({ type: "input", target: search, bubbles: false });
    harness.raf.flush();

    assert.deepStrictEqual(visibleNames(), ["Kimi Code"]);
    assert.strictEqual(group.querySelector(".agent-section-count").textContent, "1");
    // Typing has to open the catalog, or it would filter rows nobody can see.
    assert.strictEqual(group.classList.contains("collapsed"), false);

    // Clicks and keystrokes inside the box must not toggle the group.
    const wasCollapsed = group.classList.contains("collapsed");
    search.dispatchEvent({ type: "click", target: search, bubbles: true });
    search.dispatchEvent({ type: "keydown", key: "Enter", target: search, bubbles: true });
    assert.strictEqual(group.classList.contains("collapsed"), wasCollapsed);

    // An IME composition is pinyin keystrokes, not a query: filtering on it
    // would empty the list under the candidate window mid-word.
    search.value = "kimi";
    search.dispatchEvent({ type: "input", target: search, bubbles: false });
    search.dispatchEvent({ type: "compositionstart", target: search, bubbles: false });
    search.value = "ki mi";
    search.dispatchEvent({ type: "input", target: search, bubbles: false });
    assert.deepStrictEqual(visibleNames(), ["Kimi Code"], "composition keystrokes must not filter");
    assert.strictEqual(group.querySelector(".agent-section-count").textContent, "1");
    search.value = "秘密";
    search.dispatchEvent({ type: "compositionend", target: search, bubbles: false });
    assert.deepStrictEqual(visibleNames(), [], "the committed characters do filter");
    assert.strictEqual(group.querySelector(".agent-section-count").textContent, "0");

    // The query survives a re-render, and matching is case-insensitive.
    search.value = "QWEN";
    search.dispatchEvent({ type: "input", target: search, bubbles: false });
    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();
    const rebuilt = harness.content.querySelector(".agent-unavailable-group");
    assert.strictEqual(rebuilt.querySelector(".agent-section-search").value, "QWEN");
    assert.strictEqual(rebuilt.querySelector(".agent-section-count").textContent, "1");
  });

  it("splits the Agents tab into connected and discover subtabs", () => {
    const customPath = "C:\\Tools\\Unknown";
    const harness = loadAgentsTabForTest({
      snapshot: {
        lang: "en",
        agents: {
          "qwen-code": { integrationInstalled: true, enabled: true },
          "gemini-cli": { integrationInstalled: false, enabled: false },
        },
        customToolDiscoveryPaths: [customPath],
        dismissedAgentCleanupHints: {},
        dismissedAgentInstallHints: {},
      },
      agentMetadata: [
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
        { id: "gemini-cli", name: "Gemini CLI", eventSource: "hook", capabilities: {} },
      ],
    });
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1700000000000,
      agents: [
        // Connected but gone from disk -> cleanup hint on the connected subtab.
        { agentId: "qwen-code", detectedInstalled: false, confidence: "high" },
        // On disk but not connected -> install hint + badge on the discover pill.
        { agentId: "gemini-cli", detectedInstalled: true, confidence: "high" },
      ],
      customTools: [{
        path: customPath,
        detectedInstalled: true,
        confidence: "medium",
        reason: "custom-path",
        detail: "No launchable application was recognized",
        kind: "directory",
      }],
      skippedAgentIds: [],
      wslSupported: true,
      wslDistros: [],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;
    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();

    const subtabs = harness.content.querySelector(".agents-subtabs");
    assert.ok(subtabs, "the Agents tab should render a subtab switcher");
    const pills = subtabs.querySelectorAll(".segmented button");
    assert.deepStrictEqual(pills.map((pill) => pill.textContent), ["Connected", "Discover and add"]);
    assert.strictEqual(pills[0].classList.contains("active"), true);
    assert.strictEqual(pills[0].getAttribute("aria-selected"), "true");
    // The badge counts what can be acted on now, not the whole catalog.
    assert.strictEqual(pills[0].querySelector(".agents-subtab-count"), null);
    assert.strictEqual(pills[1].querySelector(".agents-subtab-count").textContent, "1");

    // Connected is the default half, and the WSL rescan rides with it: its
    // results land as instance rows inside agent cards, not as discovery hits.
    const connectedSection = harness.content.querySelector(".agent-section-connected");
    assert.ok(connectedSection);
    // Only one category here, so the grouping layer is dropped entirely
    // instead of wrapping the rows in a lone "Coding AI" header.
    assert.strictEqual(connectedSection.querySelector(".agent-category-group"), null);
    assert.deepStrictEqual(
      connectedSection.querySelectorAll(".agent-summary-row .row-label").map((node) => node.textContent),
      ["Qwen Code"]
    );
    assert.ok(subtabs.querySelector(".custom-tool-wsl-scan"));
    assert.strictEqual(harness.content.querySelector(".custom-tool-path-picker"), null);
    assert.strictEqual(harness.content.querySelector(".agent-custom-tools-section"), null);

    // Each banner belongs to the subtab it acts on.
    const cleanupIndex = harness.content.children
      .findIndex((node) => node.classList.contains("agent-cleanup-hint-banner"));
    assert.ok(cleanupIndex >= 0, "a cleanup hint should render for the missing local agent");
    assert.ok(cleanupIndex > harness.content.children.indexOf(subtabs));
    assert.strictEqual(harness.content.querySelector(".agent-install-hint-banner"), null);

    pills[1].dispatchEvent({ type: "click", bubbles: false });
    harness.raf.flush();

    const discoverSubtabs = harness.content.querySelector(".agents-subtabs");
    const discoverPills = discoverSubtabs.querySelectorAll(".segmented button");
    assert.strictEqual(discoverPills[1].classList.contains("active"), true);
    assert.ok(harness.content.querySelector(".custom-tool-path-picker"));
    assert.strictEqual(harness.content.querySelector(".agent-section-connected"), null);
    assert.strictEqual(discoverSubtabs.querySelector(".custom-tool-wsl-scan"), null);
    assert.strictEqual(harness.content.querySelector(".agent-cleanup-hint-banner"), null);
    assert.ok(harness.content.querySelector(".agent-install-hint-banner"));

    // The pill is the only heading for this half, and an unrecognized path
    // states its status once, localized, with no badge repeating it.
    assert.strictEqual(harness.content.querySelector(".agent-custom-tools-section .section-title"), null);
    const resultRow = harness.content.querySelector(".custom-tool-result-row");
    assert.strictEqual(resultRow.querySelector(".custom-tool-result-path").textContent, customPath);
    assert.strictEqual(resultRow.querySelector(".custom-tool-result-path").title, customPath);
    assert.strictEqual(resultRow.querySelector(".row-desc").textContent, "No launchable application found");
    assert.strictEqual(resultRow.querySelector(".custom-tool-result-status"), null);
  });

  it("shows custom AI scan state and forces a rescan", async () => {
    let resolveScan;
    let scanCalls = 0;
    const harness = loadAgentsTabForTest({
      snapshot: { lang: "en", agents: {}, customToolDiscoveryPaths: [] },
      agentMetadata: [],
      settingsAPI: {
        detectAgentInstallations: () => {
          scanCalls += 1;
          return new Promise((resolve) => { resolveScan = resolve; });
        },
      },
    });
    harness.core.runtime.agentsSubtab = "discover";
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1700000000000,
      agents: [],
      customTools: [],
      skippedAgentIds: [],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;
    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();

    const button = harness.content.querySelector(".custom-tool-scan");
    const status = harness.content.querySelector(".custom-tool-scan-status");
    assert.strictEqual(button.textContent, "Rescan");
    assert.match(status.textContent, /^Last scanned at /);

    button.dispatchEvent({ type: "click", bubbles: false });
    assert.strictEqual(status.textContent, "Scanning...");
    assert.strictEqual(button.disabled, true);
    assert.strictEqual(scanCalls, 1);

    resolveScan({
      checkedAt: 1700000005000,
      agents: [],
      customTools: [],
      skippedAgentIds: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 1250));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.match(status.textContent, /^Last scanned at /);
    assert.strictEqual(button.disabled, false);
  });

  it("adds a picked installation folder, persists it, and waits for a fresh path scan", async () => {
    const calls = [];
    const pickedPath = "C:\\Tools\\CustomAI";
    const harness = loadAgentsTabForTest({
      snapshot: { agents: {}, customToolDiscoveryPaths: [] },
      agentMetadata: [],
      settingsAPI: {
        pickAgentDiscoveryPath: async (kind) => {
          calls.push(["pick", kind]);
          return { status: "ok", path: pickedPath };
        },
        command: async (command, payload) => {
          calls.push(["command", command, payload]);
          return { status: "ok" };
        },
        detectAgentInstallations: async () => {
          calls.push(["scan"]);
          return {
            checkedAt: 123,
            agents: [],
            customTools: [{
              path: pickedPath,
              detectedInstalled: true,
              confidence: "medium",
              reason: "custom-path",
              detail: "Path exists (directory)",
              kind: "directory",
            }],
          };
        },
      },
    });
    harness.core.runtime.agentsSubtab = "discover";
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1,
      agents: [],
      customTools: [],
      skippedAgentIds: [],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;
    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();

    const picker = harness.content.querySelector(".custom-tool-path-picker");
    assert.strictEqual(picker.textContent, "Choose AI installation folder");
    assert.strictEqual(harness.content.querySelector(".agent-custom-tools-section input"), null);
    picker.dispatchEvent({ type: "click", bubbles: false });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    harness.raf.flush();

    assert.deepStrictEqual(calls[0], ["pick", "directory"]);
    assert.strictEqual(calls[1][0], "command");
    assert.strictEqual(calls[1][1], "setAgentCustomDiscoveryPaths");
    assert.strictEqual(calls[1][2].agentId, "custom");
    assert.deepStrictEqual(calls[1][2].value, [pickedPath]);
    assert.deepStrictEqual(calls[2], ["scan"]);
    assert.strictEqual(harness.core.runtime.agentInstallationHints.customTools[0].path, pickedPath);
    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();
    assert.ok(harness.content.querySelector(".custom-tool-result-found"));
    const removePath = harness.content.querySelector(".custom-tool-remove-path");
    assert.ok(removePath);
    removePath.dispatchEvent({ type: "click", bubbles: false });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.strictEqual(calls[3][0], "command");
    assert.strictEqual(calls[3][1], "setAgentCustomDiscoveryPaths");
    assert.deepStrictEqual(calls[3][2].value, []);
  });

  it("registers a recognized custom AI with state-only connection details", async () => {
    const id = "custom-nova-ai-0123456789ab";
    const pickedPath = "C:\\Tools\\NovaAI.exe";
    const calls = [];
    let added = false;
    const customMetadata = {
      id,
      name: "Nova AI",
      category: "code",
      eventSource: "custom-http",
      custom: true,
      sourcePath: pickedPath,
      executablePath: pickedPath,
      processName: "NovaAI.exe",
      stateEndpoint: "http://127.0.0.1:23333/state",
      lastStateEvent: null,
      capabilities: { httpHook: true, permissionApproval: false, interactiveBubble: false, notificationHook: true },
    };
    const detection = () => ({
      checkedAt: 1,
      agents: [],
      customTools: [{
        path: pickedPath,
        detectedInstalled: true,
        confidence: "high",
        reason: "application-recognized",
        detail: "Recognized Nova AI",
        kind: "file",
        application: { ...customMetadata, added },
      }],
      skippedAgentIds: [],
    });
    const harness = loadAgentsTabForTest({
      snapshot: { agents: {}, customToolDiscoveryPaths: [pickedPath], customApplications: [] },
      agentMetadata: [],
      settingsAPI: {
        command: async (command, payload) => {
          calls.push([command, payload]);
          if (command === "addCustomApplication") added = true;
          return { status: "ok" };
        },
        listAgents: async () => added ? [customMetadata] : [],
        detectAgentInstallations: async () => detection(),
      },
    });
    harness.core.runtime.agentsSubtab = "discover";
    harness.core.runtime.agentInstallationHints = detection();
    harness.core.runtime.agentInstallationHintsFetched = true;
    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();

    const addButton = harness.content.querySelector(".custom-tool-add");
    assert.ok(addButton);
    addButton.dispatchEvent({ type: "click", bubbles: false });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    harness.raf.flush();

    assert.strictEqual(calls[0][0], "addCustomApplication");
    assert.strictEqual(calls[0][1].path, pickedPath);
    assert.ok(harness.core.runtime.agentMetadata.some((agent) => agent.id === id));
    assert.ok(harness.content.querySelector(".custom-agent-remove"));
    assert.ok(harness.content.querySelector(".custom-registration"));
    assert.ok(harness.content.querySelector(".custom-agent-copy"));
    assert.strictEqual(
      harness.content
        .querySelectorAll(".agent-badge")
        .some((badge) => badge.classList.contains("accent")),
      false
    );

    const activity = harness.content.querySelector(".custom-agent-activity");
    assert.ok(!activity.textContent.includes("PreToolUse"));
    const renderCountBeforeActivity = harness.getContentRenderCount();
    assert.strictEqual(harness.core.tabs.agents.applyAgentActivity({
      agentId: id,
      timestamp: Date.UTC(2026, 6, 21, 8, 30, 0),
      eventType: "PreToolUse",
    }), true);
    assert.ok(activity.textContent.includes("PreToolUse"));
    assert.strictEqual(harness.core.runtime.agentMetadata[0].lastStateEvent.eventType, "PreToolUse");
    assert.strictEqual(harness.getContentRenderCount(), renderCountBeforeActivity);
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

  it("confirms before uninstalling an agent integration", () => {
    const agentsSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-agents.js"), "utf8");
    const i18nSource = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
    assert.ok(agentsSource.includes('window.confirm(t("agentIntegrationUninstallConfirm"))'));
    assert.ok(i18nSource.includes("agentIntegrationUninstallConfirm"));
  });

  it("fetches agent installation hints lazily when Agents renders and then uses the cache", async () => {
    let calls = 0;
    const detectionResult = {
      checkedAt: 123,
      agents: [{ agentId: "qwen-code", detectedInstalled: true }],
      skippedAgentIds: ["claude-code", "codex"],
    };
    const harness = loadAgentsTabForTest({
      agentMetadata: [{
        id: "qwen-code",
        name: "Qwen Code",
        eventSource: "hook",
        capabilities: {},
      }],
      settingsAPI: {
        detectAgentInstallations: () => {
          calls++;
          return Promise.resolve(detectionResult);
        },
      },
    });

    assert.strictEqual(calls, 0);
    harness.core.ops.requestRender({ content: true });
    assert.strictEqual(calls, 1);
    assert.strictEqual(harness.core.runtime.agentInstallationHintsPending, true);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(harness.core.runtime.agentInstallationHints.checkedAt, detectionResult.checkedAt);
    assert.deepStrictEqual(
      harness.core.runtime.agentInstallationHints.agents.map((agent) => agent.agentId),
      ["qwen-code"]
    );
    assert.deepStrictEqual(
      harness.core.runtime.agentInstallationHints.skippedAgentIds,
      detectionResult.skippedAgentIds
    );
    assert.strictEqual(harness.core.runtime.agentInstallationHintsFetched, true);
    assert.strictEqual(harness.core.runtime.agentInstallationHintsPending, false);

    harness.core.ops.requestRender({ content: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(calls, 1);
  });

  it("splits connected agents from detected and undetected ones across the subtabs", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          hermes: { integrationInstalled: true, enabled: true },
          "qwen-code": { integrationInstalled: false, enabled: false },
          pi: { integrationInstalled: false, enabled: false },
        },
        dismissedAgentInstallHints: { "qwen-code": true },
      },
      agentMetadata: [
        { id: "pi", name: "Pi", eventSource: "extension", capabilities: {} },
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
        { id: "hermes", name: "Hermes Agent", eventSource: "plugin-event", capabilities: {} },
      ],
    });
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1,
      agents: [
        { agentId: "qwen-code", detectedInstalled: true, confidence: "high" },
        { agentId: "hermes", detectedInstalled: false, confidence: "low" },
        { agentId: "pi", detectedInstalled: false, confidence: "low" },
      ],
      skippedAgentIds: [],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;

    harness.core.ops.requestRender({ content: true });

    const labelsFor = (section) => section.querySelectorAll(".agent-summary-row .row-label").map((el) => el.textContent);

    // Connected subtab: only the connected agents, and no section title —
    // the pill already says "Connected".
    const connected = harness.content.querySelector(".agent-section-connected");
    assert.ok(connected);
    assert.strictEqual(connected.querySelector(".section-title"), null);
    assert.deepStrictEqual(labelsFor(connected), ["Hermes Agent"]);
    assert.strictEqual(harness.content.querySelector(".agent-section-recommended"), null);
    assert.strictEqual(harness.content.querySelector(".agent-section-unavailable"), null);

    harness.core.runtime.agentsSubtab = "discover";
    harness.core.ops.requestRender({ content: true });

    const recommended = harness.content.querySelector(".agent-section-recommended");
    const unavailable = harness.content.querySelector(".agent-section-unavailable");
    assert.ok(recommended);
    assert.ok(unavailable);
    assert.strictEqual(recommended.querySelector(".section-title").textContent, "Detected locally");
    assert.deepStrictEqual(labelsFor(recommended), ["Qwen Code"]);
    assert.strictEqual(harness.content.querySelector(".agent-section-connected"), null);

    // The undetected catalog is a collapsed group with a neutral count, and
    // the manual-add block sits above it.
    const group = unavailable.querySelector(".agent-unavailable-group");
    assert.ok(group);
    assert.strictEqual(group.querySelector(".collapsible-group-text .row-label").textContent, "Not detected locally");
    assert.strictEqual(group.querySelector(".agent-section-count").textContent, "1");
    assert.ok(group.classList.contains("collapsed"));
    assert.deepStrictEqual(labelsFor(unavailable), ["Pi"]);
    assert.ok(
      harness.content.children.indexOf(harness.content.querySelector(".agent-custom-tools-section"))
      < harness.content.children.indexOf(unavailable)
    );
  });

  it("renders an install hint banner for detected local agents that are not integrated", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "qwen-code": { integrationInstalled: false, enabled: false },
          hermes: { integrationInstalled: true, enabled: true },
        },
        dismissedAgentInstallHints: {},
      },
      agentMetadata: [
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
        { id: "hermes", name: "Hermes Agent", eventSource: "plugin-event", capabilities: {} },
      ],
    });
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1,
      agents: [
        { agentId: "qwen-code", detectedInstalled: true, confidence: "high" },
        { agentId: "hermes", detectedInstalled: true, confidence: "high" },
        { agentId: "pi", detectedInstalled: true, confidence: "low" },
      ],
      skippedAgentIds: ["claude-code", "codex"],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;
    harness.core.runtime.agentsSubtab = "discover";

    harness.core.ops.requestRender({ content: true });

    const banner = harness.content.querySelector(".agent-install-hint-banner");
    assert.ok(banner, "detected unintegrated agents should render a banner");
    assert.ok(harness.content.querySelector(".agent-install-hint-install"));
    assert.ok(harness.content.querySelector(".agent-install-hint-dismiss"));
    const desc = harness.content.querySelector(".agent-install-hint-desc").textContent;
    assert.match(desc, /Qwen Code/);
    assert.doesNotMatch(desc, /Hermes/);
  });

  it("hides install hint banners after the agent is dismissed", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "qwen-code": { integrationInstalled: false, enabled: false },
        },
        dismissedAgentInstallHints: { "qwen-code": true },
      },
      agentMetadata: [
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
      ],
    });
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1,
      agents: [{ agentId: "qwen-code", detectedInstalled: true, confidence: "high" }],
      skippedAgentIds: [],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;

    harness.core.ops.requestRender({ content: true });

    assert.strictEqual(harness.content.querySelector(".agent-install-hint-banner"), null);
  });

  it("clears install dismissals when the detector no longer sees the agent", async () => {
    const calls = [];
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          codex: { integrationInstalled: false, enabled: false },
          "qwen-code": { integrationInstalled: false, enabled: false },
        },
        dismissedAgentInstallHints: {
          codex: true,
          "qwen-code": true,
        },
      },
      agentMetadata: [
        { id: "codex", name: "Codex", eventSource: "hook", capabilities: {} },
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
      ],
      settingsAPI: {
        command: (action, payload) => {
          calls.push([action, payload]);
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1,
      agents: [{ agentId: "qwen-code", detectedInstalled: false, confidence: "low" }],
      skippedAgentIds: ["codex"],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;

    harness.core.ops.requestRender({ content: true });
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(harness.content.querySelector(".agent-install-hint-banner"), null);
    assert.strictEqual(calls[0][0], "clearAgentInstallHints");
    assert.deepStrictEqual([...calls[0][1].agentIds], ["qwen-code"]);
  });

  it("wires install hint banner buttons to bulk install and dismiss commands", async () => {
    const calls = [];
    const detectionResult = {
      checkedAt: 2,
      agents: [{ agentId: "qwen-code", detectedInstalled: true, confidence: "high" }],
      skippedAgentIds: [],
    };
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "qwen-code": { integrationInstalled: false, enabled: false },
        },
        dismissedAgentInstallHints: {},
      },
      agentMetadata: [
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
      ],
      settingsAPI: {
        command: (action, payload) => {
          calls.push([action, payload]);
          return Promise.resolve({ status: "ok" });
        },
        detectAgentInstallations: () => Promise.resolve(detectionResult),
      },
    });
    harness.core.runtime.agentInstallationHints = detectionResult;
    harness.core.runtime.agentInstallationHintsFetched = true;

    harness.core.ops.requestRender({ content: true });
    harness.content.querySelector(".agent-install-hint-install").dispatchEvent({ type: "click", bubbles: false });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(calls[0][0], "installAgentIntegration");
    assert.strictEqual(calls[0][1].agentId, "qwen-code");

    calls.length = 0;
    harness.core.runtime.agentInstallationHintsFetched = true;
    harness.core.ops.requestRender({ content: true });
    harness.content.querySelector(".agent-install-hint-dismiss").dispatchEvent({ type: "click", bubbles: false });
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(calls[0][0], "dismissAgentInstallHints");
    assert.deepStrictEqual([...calls[0][1].agentIds], ["qwen-code"]);
  });

  it("shows a non-error toast when a recommended install is skipped", async () => {
    const toasts = [];
    const detectionResult = {
      checkedAt: 2,
      agents: [{ agentId: "qwen-code", detectedInstalled: true, confidence: "high" }],
      skippedAgentIds: [],
    };
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "qwen-code": { integrationInstalled: false, enabled: false },
        },
        dismissedAgentInstallHints: {},
      },
      agentMetadata: [
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
      ],
      settingsAPI: {
        command: () => Promise.resolve({ status: "skipped", message: "Qwen missing" }),
        detectAgentInstallations: () => Promise.resolve(detectionResult),
      },
    });
    harness.core.ops.showToast = (message, options = {}) => {
      toasts.push({ message, options });
    };
    harness.core.runtime.agentInstallationHints = detectionResult;
    harness.core.runtime.agentInstallationHintsFetched = true;

    harness.core.ops.requestRender({ content: true });
    harness.content.querySelector(".agent-install-hint-install").dispatchEvent({ type: "click", bubbles: false });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(toasts.length, 1);
    assert.match(toasts[0].message, /Qwen Code/);
    assert.notStrictEqual(toasts[0].options.error, true);
  });

  it("shows a non-error toast when a manual agent install is skipped", async () => {
    const toasts = [];
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          pi: { integrationInstalled: false, enabled: false },
        },
      },
      agentMetadata: [
        { id: "pi", name: "Pi", eventSource: "extension", capabilities: {} },
      ],
      settingsAPI: {
        command: () => Promise.resolve({ status: "skipped", message: "Pi missing" }),
      },
    });
    harness.core.ops.showToast = (message, options = {}) => {
      toasts.push({ message, options });
    };

    harness.core.ops.requestRender({ content: true });
    harness.content.querySelector(".agent-integration-action").dispatchEvent({ type: "click", bubbles: false });
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(toasts.length, 1);
    assert.match(toasts[0].message, /Pi/);
    assert.notStrictEqual(toasts[0].options.error, true);
  });

  it("renders cleanup hint banners only from detector entries, not skipped default agents", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "claude-code": { integrationInstalled: true, enabled: true },
          codex: { integrationInstalled: true, enabled: true },
          "qwen-code": { integrationInstalled: true, enabled: true },
        },
        dismissedAgentCleanupHints: {},
      },
      agentMetadata: [
        { id: "claude-code", name: "Claude Code", eventSource: "hook", capabilities: {} },
        { id: "codex", name: "Codex", eventSource: "hook", capabilities: {} },
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
      ],
    });
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1,
      agents: [{ agentId: "qwen-code", detectedInstalled: false, confidence: "low" }],
      skippedAgentIds: ["claude-code", "codex"],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;

    harness.core.ops.requestRender({ content: true });

    const banner = harness.content.querySelector(".agent-cleanup-hint-banner");
    assert.ok(banner, "installed agents missing from detector entries should render cleanup banner");
    assert.ok(harness.content.querySelector(".agent-cleanup-hint-remove"));
    assert.ok(harness.content.querySelector(".agent-cleanup-hint-dismiss"));
    const desc = harness.content.querySelector(".agent-cleanup-hint-desc").textContent;
    assert.match(desc, /Qwen Code/);
    assert.doesNotMatch(desc, /Claude Code/);
    assert.doesNotMatch(desc, /Codex/);
  });

  it("hides cleanup hint banners after the agent is dismissed", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "qwen-code": { integrationInstalled: true, enabled: true },
        },
        dismissedAgentCleanupHints: { "qwen-code": true },
      },
      agentMetadata: [
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
      ],
    });
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1,
      agents: [{ agentId: "qwen-code", detectedInstalled: false, confidence: "low" }],
      skippedAgentIds: [],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;

    harness.core.ops.requestRender({ content: true });

    assert.strictEqual(harness.content.querySelector(".agent-cleanup-hint-banner"), null);
  });

  it("clears cleanup dismissals when the detector sees the agent restored", async () => {
    const calls = [];
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "qwen-code": { integrationInstalled: true, enabled: true },
        },
        dismissedAgentCleanupHints: { "qwen-code": true },
      },
      agentMetadata: [
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
      ],
      settingsAPI: {
        command: (action, payload) => {
          calls.push([action, payload]);
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    harness.core.runtime.agentInstallationHints = {
      checkedAt: 1,
      agents: [{ agentId: "qwen-code", detectedInstalled: true, confidence: "high" }],
      skippedAgentIds: [],
    };
    harness.core.runtime.agentInstallationHintsFetched = true;

    harness.core.ops.requestRender({ content: true });
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(harness.content.querySelector(".agent-cleanup-hint-banner"), null);
    assert.strictEqual(calls[0][0], "clearAgentCleanupHints");
    assert.deepStrictEqual([...calls[0][1].agentIds], ["qwen-code"]);
  });

  it("wires cleanup hint banner buttons to bulk uninstall and dismiss commands", async () => {
    const calls = [];
    const detectionResult = {
      checkedAt: 2,
      agents: [{ agentId: "qwen-code", detectedInstalled: false, confidence: "low" }],
      skippedAgentIds: [],
    };
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "qwen-code": { integrationInstalled: true, enabled: true },
        },
        dismissedAgentCleanupHints: {},
      },
      agentMetadata: [
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
      ],
      settingsAPI: {
        command: (action, payload) => {
          calls.push([action, payload]);
          return Promise.resolve({ status: "ok" });
        },
        detectAgentInstallations: () => Promise.resolve(detectionResult),
      },
    });
    harness.core.runtime.agentInstallationHints = detectionResult;
    harness.core.runtime.agentInstallationHintsFetched = true;

    harness.core.ops.requestRender({ content: true });
    harness.content.querySelector(".agent-cleanup-hint-remove").dispatchEvent({ type: "click", bubbles: false });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(calls[0][0], "uninstallAgentIntegration");
    assert.strictEqual(calls[0][1].agentId, "qwen-code");
    assert.strictEqual(calls[0][1].dismissInstallHint, false);

    calls.length = 0;
    harness.core.runtime.agentInstallationHintsFetched = true;
    harness.core.ops.requestRender({ content: true });
    harness.content.querySelector(".agent-cleanup-hint-dismiss").dispatchEvent({ type: "click", bubbles: false });
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(calls[0][0], "dismissAgentCleanupHints");
    assert.deepStrictEqual([...calls[0][1].agentIds], ["qwen-code"]);
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

  it("enables the Codex native sound switch only in Native permission mode", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          codex: {
            enabled: true,
            permissionsEnabled: true,
            permissionMode: "intercept",
            nativeNotificationSoundEnabled: true,
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

    const soundSwitch = [...harness.core.state.mountedControls.agentSwitches.values()]
      .find((meta) => meta.agentId === "codex" && meta.flag === "nativeNotificationSoundEnabled");
    assert.ok(soundSwitch, "Codex native sound switch should be mounted");
    assert.strictEqual(soundSwitch.element.classList.contains("disabled"), true);

    harness.core.ops.applyChanges({
      changes: {
        agents: {
          codex: {
            enabled: true,
            permissionsEnabled: true,
            permissionMode: "native",
            nativeNotificationSoundEnabled: true,
          },
        },
      },
      snapshot: {
        agents: {
          codex: {
            enabled: true,
            permissionsEnabled: true,
            permissionMode: "native",
            nativeNotificationSoundEnabled: true,
          },
        },
      },
    });

    assert.strictEqual(soundSwitch.element.classList.contains("disabled"), false);
    assert.strictEqual(soundSwitch.element.attributes["aria-disabled"], "false");
    assert.strictEqual(soundSwitch.element.attributes.tabindex, "0");
  });

  it("mounts the Claude subagent permission switch and greys it with the permission gate (#451)", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "claude-code": {
            enabled: true,
            permissionsEnabled: true,
            subagentPermissionsEnabled: true,
          },
        },
      },
      agentMetadata: [{
        id: "claude-code",
        name: "Claude Code",
        eventSource: "hook",
        capabilities: {
          permissionApproval: true,
        },
      }],
      collapsedGroups: {
        "agents:claude-code": false,
      },
    });

    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();

    const subagentSwitch = [...harness.core.state.mountedControls.agentSwitches.values()]
      .find((meta) => meta.agentId === "claude-code" && meta.flag === "subagentPermissionsEnabled");
    assert.ok(subagentSwitch, "Claude subagent permission switch should be mounted");
    assert.strictEqual(subagentSwitch.element.classList.contains("disabled"), false);

    harness.core.ops.applyChanges({
      changes: {
        agents: {
          "claude-code": {
            enabled: true,
            permissionsEnabled: false,
            subagentPermissionsEnabled: true,
          },
        },
      },
      snapshot: {
        agents: {
          "claude-code": {
            enabled: true,
            permissionsEnabled: false,
            subagentPermissionsEnabled: true,
          },
        },
      },
    });

    assert.strictEqual(subagentSwitch.element.classList.contains("disabled"), true);
    assert.strictEqual(subagentSwitch.element.attributes["aria-disabled"], "true");
    assert.strictEqual(subagentSwitch.element.attributes.tabindex, "-1");
  });

  it("does not render the subagent permission switch for non-Claude agents (#451)", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          codebuddy: {
            enabled: true,
            permissionsEnabled: true,
          },
        },
      },
      agentMetadata: [{
        id: "codebuddy",
        name: "CodeBuddy",
        eventSource: "hook",
        capabilities: {
          permissionApproval: true,
        },
      }],
      collapsedGroups: {
        "agents:codebuddy": false,
      },
    });

    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();

    const subagentSwitch = [...harness.core.state.mountedControls.agentSwitches.values()]
      .find((meta) => meta.flag === "subagentPermissionsEnabled");
    assert.strictEqual(subagentSwitch, undefined);
    const permissionsSwitch = [...harness.core.state.mountedControls.agentSwitches.values()]
      .find((meta) => meta.agentId === "codebuddy" && meta.flag === "permissionsEnabled");
    assert.ok(permissionsSwitch, "CodeBuddy permission switch should still be mounted");
  });

  it("does not render a permission toggle on the WorkBuddy row (state-only, #618)", () => {
    // The desktop app owns the permission loop in its native sandbox + GUI, so
    // capabilities.permissionApproval is false and the row must offer no
    // permission switch — only the notification (waiting) toggle.
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          workbuddy: {
            enabled: true,
            notificationHookEnabled: true,
          },
        },
      },
      agentMetadata: [{
        id: "workbuddy",
        name: "WorkBuddy",
        eventSource: "hook",
        capabilities: {
          notificationHook: true,
        },
      }],
      collapsedGroups: {
        "agents:workbuddy": false,
      },
    });

    harness.core.ops.requestRender({ content: true });
    harness.raf.flush();

    const permissionsSwitch = [...harness.core.state.mountedControls.agentSwitches.values()]
      .find((meta) => meta.agentId === "workbuddy" && meta.flag === "permissionsEnabled");
    assert.strictEqual(
      permissionsSwitch,
      undefined,
      "WorkBuddy is state-only, so no permission toggle should be mounted"
    );
    const notificationSwitch = [...harness.core.state.mountedControls.agentSwitches.values()]
      .find((meta) => meta.agentId === "workbuddy" && meta.flag === "notificationHookEnabled");
    assert.ok(notificationSwitch, "WorkBuddy waiting-notification switch should still be mounted");
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

  it("ignores stale Codex hook health results after the badge becomes not installed", async () => {
    let resolveHealth;
    const healthPromise = new Promise((resolve) => { resolveHealth = resolve; });
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          codex: { integrationInstalled: true, enabled: true },
        },
      },
      agentMetadata: [{
        id: "codex",
        name: "Codex",
        eventSource: "hook",
        capabilities: { permissionApproval: true },
      }],
      doctor: { codexHookHealth: () => healthPromise },
    });

    harness.core.ops.requestRender({ content: true });
    const findIntegrationBadge = () => harness.content.querySelectorAll(".agent-badge")
      .find((candidate) => candidate.classList.contains("integration"));
    let badge = findIntegrationBadge();
    assert.ok(badge);
    assert.strictEqual(badge.textContent, "Installed");

    harness.core.ops.applyChanges({
      changes: {
        agents: {
          codex: { integrationInstalled: false, enabled: false },
        },
      },
      snapshot: {
        agents: {
          codex: { integrationInstalled: false, enabled: false },
        },
      },
    });
    badge = findIntegrationBadge();
    assert.ok(badge);
    assert.strictEqual(badge.textContent, "Not installed");

    resolveHealth({ healthy: false, signature: "not-registered", reasonKey: "codexHookHealthReasonInactive" });
    await Promise.resolve();
    await Promise.resolve();

    badge = findIntegrationBadge();
    assert.strictEqual(badge.textContent, "Not installed");
    assert.strictEqual(badge.classList.contains("hook-warning"), false);
    assert.strictEqual(badge.title, "");
  });
  it("does not initialize an expanded agent group at 0px height during rerender", () => {
    const harness = loadAgentsTabForTest({
      snapshot: {
        agents: {
          "gemini-cli": {
            integrationInstalled: true,
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

  it("uses animated switches and local theme override patching in the Animation Map subtab", () => {
    const animMapSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-map.js"), "utf8");
    const overridesSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-overrides.js"), "utf8");
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    assert.ok(animMapSource.includes("state.transientUiState.animMapSwitches"));
    assert.ok(animMapSource.includes("state.mountedControls.animMapSwitches"));
    assert.ok(animMapSource.includes("helpers.attachAnimatedSwitch(sw, {"));
    assert.ok(animMapSource.includes('command("setThemeOverrideDisabled"'));
    assert.ok(!animMapSource.includes("helpers.attachActivation(sw"));
    assert.ok(animMapSource.includes("function renderMapSubtab(parent)"));
    assert.ok(animMapSource.includes("function patchMapInPlace(changes)"));
    assert.ok(animMapSource.includes('Object.prototype.hasOwnProperty.call(changes, "themeOverrides")'));
    assert.ok(animMapSource.includes("helpers.setSwitchVisual(meta.element, readAnimMapVisualOn(meta.themeId, meta.stateKey), { pending: false });"));
    // Folded in: the Animation & Sound Overrides tab renders + patches the map subtab.
    assert.ok(overridesSource.includes("ClawdSettingsTabAnimMap.renderMapSubtab"));
    assert.ok(overridesSource.includes("ClawdSettingsTabAnimMap.patchMapInPlace"));
    assert.ok(coreSource.includes("activeTab.patchInPlace(changes"));
  });

  it("renders the Animation Map switches inside the Animation Overrides 'on / off' subtab", () => {
    const harness = loadAnimMapTabForTest({
      snapshot: { theme: "clawd", themeOverrides: {} },
    });
    // Map is the default subtab; rendering the overrides tab should mount the
    // five interrupt on/off switches under it (folded in, not a standalone tab).
    harness.core.tabs.animOverrides.render(harness.content);
    assert.strictEqual(harness.core.state.mountedControls.animMapSwitches.size, 5);
    assert.ok(
      harness.core.state.mountedControls.animMapReset,
      "the reset-all control should mount under the subtab"
    );
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

  it("invalidates animation cards and refreshes theme capabilities after a map override patch", async () => {
    let listThemesCalls = 0;
    const harness = loadAnimMapTabForTest({
      snapshot: {
        theme: "clawd",
        themeOverrides: { clawd: { states: { error: { disabled: false } } } },
      },
      settingsAPI: {
        listThemes: () => {
          listThemesCalls++;
          return Promise.resolve([{
            id: "clawd",
            active: true,
            capabilities: { petTint: true, accessories: false },
          }]);
        },
      },
    });
    // Simulate having opened the Animations subtab earlier: its card data is cached.
    harness.core.runtime.animationOverridesData = { theme: { id: "clawd" }, cards: [], sounds: [] };
    harness.core.runtime.themeList = [{
      id: "clawd",
      active: true,
      capabilities: { petTint: true, accessories: true },
    }];
    // A mounted map switch so patchMapInPlace takes the in-place themeOverrides branch.
    const sw = new FakeElement("div");
    sw.className = "switch on";
    harness.content.appendChild(sw);
    harness.core.state.mountedControls.animMapSwitches.set("clawd:error", {
      element: sw,
      themeId: "clawd",
      stateKey: "error",
    });

    harness.core.ops.applyChanges({
      changes: { themeOverrides: { clawd: { states: { error: { disabled: true } } } } },
      snapshot: { theme: "clawd", themeOverrides: { clawd: { states: { error: { disabled: true } } } } },
    });

    assert.strictEqual(
      harness.core.runtime.animationOverridesData,
      null,
      "a map-subtab theme-override patch must invalidate the cached cards so Animations/Sounds refetch"
    );
    assert.strictEqual(listThemesCalls, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(
      harness.core.runtime.themeList[0].capabilities.accessories,
      false,
      "the registered map-tab fast path must not leave Theme capability metadata stale"
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

  it("renders the idle visual picker and submits setIdleVisual for the chosen option", async () => {
    const commandCalls = [];
    const runtime = createIdleVisualRuntime();
    const modalRoot = new FakeElement("div");
    const { core, document } = loadAnimOverridesTabForTest({
      runtime,
      modalRoot,
      settingsAPI: {
        command: (name, payload) => {
          commandCalls.push({ name, payload });
          return Promise.resolve({ status: "ok" });
        },
      },
    });
    const parent = new FakeElement("main");
    document.body.appendChild(parent);
    core.tabs.animOverrides.render(parent, core);

    assert.strictEqual(parent.querySelectorAll(".anim-idle-visual-row").length, 1);
    const valueEl = parent.querySelector(".anim-idle-visual-row .language-picker-value");
    assert.strictEqual(valueEl.textContent, "animIdleVisualThemeDefault");
    const options = parent.querySelectorAll(".anim-idle-visual-row .language-picker-option");
    assert.strictEqual(options.length, 2);

    options[1].dispatchEvent({ type: "click" });
    await Promise.resolve();
    assert.strictEqual(commandCalls.length, 1);
    assert.strictEqual(commandCalls[0].name, "setIdleVisual");
    // spread: the payload object comes from the VM realm, whose Object
    // prototype fails deepStrictEqual against test-realm literals.
    assert.deepStrictEqual(
      { ...commandCalls[0].payload },
      { themeId: "clawd", file: "clawd-idle-reading.svg" }
    );
    assert.strictEqual(valueEl.textContent, "Idle Reading", "optimistic display should show the pick immediately");
  });

  it("patches idleVisual-only broadcasts in place and re-syncs the mounted picker", () => {
    const runtime = createIdleVisualRuntime();
    const modalRoot = new FakeElement("div");
    const { core, document } = loadAnimOverridesTabForTest({ runtime, modalRoot });
    const parent = new FakeElement("main");
    document.body.appendChild(parent);
    core.tabs.animOverrides.render(parent, core);
    const valueEl = parent.querySelector(".anim-idle-visual-row .language-picker-value");
    assert.strictEqual(valueEl.textContent, "animIdleVisualThemeDefault");

    const handled = core.tabs.animOverrides.patchInPlace({ idleVisual: { clawd: "clawd-idle-reading.svg" } });
    assert.strictEqual(handled, true, "idleVisual-only broadcast must not trigger a full re-render");
    assert.strictEqual(runtime.animationOverridesData.idleDefaultVisual.selectedFile, "clawd-idle-reading.svg");
    assert.strictEqual(valueEl.textContent, "Idle Reading");

    const handledReset = core.tabs.animOverrides.patchInPlace({ idleVisual: {} });
    assert.strictEqual(handledReset, true);
    assert.strictEqual(runtime.animationOverridesData.idleDefaultVisual.selectedFile, null);
    assert.strictEqual(valueEl.textContent, "animIdleVisualThemeDefault");
  });

  it("cleans up idle visual picker document listeners through the mounted-control dispose contract", () => {
    const runtime = createIdleVisualRuntime();
    const modalRoot = new FakeElement("div");
    const { core, document, documentListenerCount } = loadAnimOverridesTabForTest({ runtime, modalRoot });
    const parent = new FakeElement("main");
    document.body.appendChild(parent);
    core.tabs.animOverrides.render(parent, core);

    assert.strictEqual(documentListenerCount("click"), 1);
    assert.strictEqual(documentListenerCount("keydown"), 1);
    const picker = core.state.mountedControls.idleVisualPicker;
    assert.strictEqual(typeof picker.dispose, "function");
    picker.dispose();
    assert.strictEqual(documentListenerCount("click"), 0);
    assert.strictEqual(documentListenerCount("keydown"), 0);

    // settings-ui-core owns calling dispose between renders — pin that wiring.
    const uiCoreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    assert.ok(uiCoreSource.includes("state.mountedControls.idleVisualPicker.dispose()"));
    assert.ok(uiCoreSource.includes("state.mountedControls.idleVisualPicker = null;"));
    assert.ok(uiCoreSource.includes("idleVisualPicker: null,"));
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

  it("refreshes cached theme capabilities after Animation Overrides changes", async () => {
    let themeFetches = 0;
    const core = loadSettingsCoreForTest({
      listThemes: () => {
        themeFetches++;
        return Promise.resolve([{
          id: "custom",
          name: "Custom",
          active: true,
          capabilities: { petTint: false, accessories: false },
        }]);
      },
      getAnimationOverridesData: () => Promise.resolve({
        theme: { id: "custom", name: "Custom" },
        assets: [],
        sections: [],
        cards: [],
        sounds: [],
      }),
    });
    core.state.activeTab = "animOverrides";
    core.state.snapshot = { theme: "custom", themeOverrides: {} };
    core.runtime.themeList = [{
      id: "custom",
      name: "Custom",
      active: true,
      capabilities: { petTint: false, accessories: true },
    }];
    core.ops.installRenderHooks({
      sidebar: () => {},
      content: () => {},
      modal: () => {},
    });

    const nextSnapshot = {
      theme: "custom",
      themeOverrides: {
        custom: {
          states: {
            idle: { sourceThemeId: "custom", file: "replacement.svg" },
          },
        },
      },
    };
    core.ops.applyChanges({
      changes: { themeOverrides: nextSnapshot.themeOverrides },
      snapshot: nextSnapshot,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(themeFetches, 1);
    assert.strictEqual(
      core.runtime.themeList[0].capabilities.accessories,
      false,
      "returning to Theme must not reuse capability metadata from before the override"
    );
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

  it("re-arms the WSL auto scan when the user leaves the Agents tab before the fetch resolves", async () => {
    const detectCalls = [];
    let resolveFirstFetch;
    const firstFetch = new Promise((resolve) => { resolveFirstFetch = resolve; });
    const pendingHints = {
      checkedAt: 1,
      agents: [],
      skippedAgentIds: [],
      wslAgents: [],
      wslDistros: [],
      wslPending: true,
      wslSupported: true,
    };
    const scannedHints = { ...pendingHints, wslPending: false, wslDistros: [{ name: "Ubuntu", default: true }] };
    const harness = loadAgentsTabForTest({
      snapshot: { agents: {} },
      settingsAPI: {
        detectAgentInstallations: (opts) => {
          detectCalls.push(opts || null);
          if (detectCalls.length === 1) return firstFetch;
          if (opts && opts.refreshWsl) return Promise.resolve(scannedHints);
          return Promise.resolve(pendingHints);
        },
      },
    });

    // Mount fetch fires while the Agents tab is active…
    const mountFetch = harness.core.ops.fetchAgentInstallationHints();
    // …but the user switches away before it resolves.
    harness.core.state.activeTab = "general";
    resolveFirstFetch(pendingHints);
    await mountFetch;
    await Promise.resolve();

    // The auto scan was (correctly) not fired for an absent user, but the
    // fetched flag must be re-armed or the auto scan is lost for the session.
    assert.strictEqual(detectCalls.length, 1, "no scan while the tab is not visible");
    assert.strictEqual(harness.core.runtime.agentInstallationHintsFetched, false,
      "fetched flag re-armed after the trigger was skipped");

    // Returning to the tab re-fetches and kicks the real WSL scan.
    harness.core.state.activeTab = "agents";
    await harness.core.ops.fetchAgentInstallationHints();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const refreshCalls = detectCalls.filter((c) => c && c.refreshWsl === true);
    assert.strictEqual(refreshCalls.length, 1, "returning to the tab fires the real WSL scan");
    assert.strictEqual(harness.core.runtime.agentInstallationHints.wslPending, false);
  });

  it("first Agents-tab fetch that reports wslPending triggers exactly one WSL scan", async () => {
    const detectCalls = [];
    const pendingHints = {
      checkedAt: 1,
      agents: [],
      skippedAgentIds: [],
      wslAgents: [],
      wslDistros: [],
      wslPending: true,
      wslSupported: true,
    };
    const scannedHints = { ...pendingHints, wslPending: false };
    const harness = loadAgentsTabForTest({
      snapshot: { agents: {} },
      settingsAPI: {
        detectAgentInstallations: (opts) => {
          detectCalls.push(opts || null);
          if (opts && opts.refreshWsl) return Promise.resolve(scannedHints);
          return Promise.resolve(pendingHints);
        },
      },
    });

    await harness.core.ops.fetchAgentInstallationHints();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const refreshCalls = detectCalls.filter((c) => c && c.refreshWsl === true);
    assert.strictEqual(refreshCalls.length, 1, "wslPending fetch on the active tab auto-triggers the scan once");
    assert.strictEqual(harness.core.runtime.agentInstallationHints.wslPending, false);
    assert.strictEqual(detectCalls.length, 2, "no further fetch after the scan settles");
  });

  it("WSL row offers Unpair on hooksFilesPresent even when the deployed badge is dark", () => {
    function buildHarness(wslEntryOverrides) {
      const detectionResult = {
        checkedAt: 2,
        agents: [{ agentId: "qwen-code", detectedInstalled: true, confidence: "high" }],
        skippedAgentIds: [],
        wslAgents: [{
          agentId: "qwen-code",
          agentName: "Qwen Code",
          distro: "Ubuntu",
          detectedInstalled: true,
          confidence: "high",
          reason: "parent-dir",
          detail: "",
          wslHome: "/home/u",
          wslParentDir: "/home/u/.qwen",
          hooksDeployed: false,
          hooksFilesPresent: false,
          ...wslEntryOverrides,
        }],
        wslDistros: [{ name: "Ubuntu", default: true }],
        wslPending: false,
        wslSupported: true,
      };
      const harness = loadAgentsTabForTest({
        snapshot: {
          agents: { "qwen-code": { integrationInstalled: false, enabled: false } },
          dismissedAgentInstallHints: {},
        },
        agentMetadata: [
          { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
        ],
        settingsAPI: {
          detectAgentInstallations: () => Promise.resolve(detectionResult),
        },
      });
      harness.core.runtime.agentInstallationHints = detectionResult;
      harness.core.runtime.agentInstallationHintsFetched = true;
      harness.core.ops.requestRender({ content: true });
      return harness;
    }

    // Paired + registered: badge on, Pair + Unpair buttons.
    let harness = buildHarness({ hooksDeployed: true, hooksFilesPresent: true });
    assert.strictEqual(harness.content.querySelectorAll(".agent-instance-deployed").length, 1);
    assert.strictEqual(harness.content.querySelectorAll(".agent-instance-action").length, 2);

    // Files on disk but registration gone (post-Unpair, or the distro was
    // paired with a non-claude agent that registers in its own config):
    // the badge goes dark but the Unpair entry point must survive.
    harness = buildHarness({ hooksDeployed: false, hooksFilesPresent: true });
    assert.strictEqual(harness.content.querySelectorAll(".agent-instance-deployed").length, 0,
      "badge dark without claude-settings registration");
    assert.strictEqual(harness.content.querySelectorAll(".agent-instance-action").length, 2,
      "Unpair stays available while hook files exist");

    // Clean distro: no badge, Pair only.
    harness = buildHarness({ hooksDeployed: false, hooksFilesPresent: false });
    assert.strictEqual(harness.content.querySelectorAll(".agent-instance-deployed").length, 0);
    assert.strictEqual(harness.content.querySelectorAll(".agent-instance-action").length, 1,
      "only Pair when nothing is deployed");
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
