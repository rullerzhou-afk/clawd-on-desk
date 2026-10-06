"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describe, it } = require("node:test");

const RENDERER_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "tutorial-renderer.js"),
  "utf8",
);
const TUTORIAL_HTML = fs.readFileSync(
  path.join(__dirname, "..", "src", "tutorial.html"),
  "utf8",
);

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }

  values() {
    return new Set(String(this.owner.className || "").split(/\s+/).filter(Boolean));
  }

  write(values) {
    this.owner.className = Array.from(values).join(" ");
  }

  add(...names) {
    const values = this.values();
    for (const name of names) values.add(name);
    this.write(values);
  }

  remove(...names) {
    const values = this.values();
    for (const name of names) values.delete(name);
    this.write(values);
  }

  toggle(name, force) {
    const values = this.values();
    const next = force == null ? !values.has(name) : !!force;
    if (next) values.add(name);
    else values.delete(name);
    this.write(values);
    return next;
  }

  contains(name) {
    return this.values().has(name);
  }
}

class FakeTextNode {
  constructor(value) {
    this.textContent = String(value == null ? "" : value);
    this.parentNode = null;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.eventListeners = new Map();
    this.style = {};
    this._className = "";
    this._textContent = "";
    this._innerHTML = "";
    this.classList = new FakeClassList(this);
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value == null ? "" : value);
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent || "").join("");
  }

  set textContent(value) {
    this._textContent = String(value == null ? "" : value);
    this.children = [];
  }

  set innerHTML(value) {
    this._innerHTML = String(value == null ? "" : value);
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    const stringValue = String(value == null ? "" : value);
    this.attributes[name] = stringValue;
    if (name === "class") this.className = stringValue;
    if (name === "src") this.src = stringValue;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  addEventListener(type, callback) {
    const listeners = this.eventListeners.get(type) || [];
    listeners.push(callback);
    this.eventListeners.set(type, listeners);
  }

  dispatchEvent(event = {}) {
    const payload = { ...event, target: event.target || this };
    for (const callback of this.eventListeners.get(payload.type) || []) callback(payload);
  }
}

function findAll(node, predicate, output = []) {
  if (predicate(node)) output.push(node);
  for (const child of node.children || []) findAll(child, predicate, output);
  return output;
}

function createHarness(state) {
  const roots = new Map([
    ["steps", new FakeElement("div")],
    ["body", new FakeElement("main")],
    ["footer", new FakeElement("footer")],
  ]);
  const documentListeners = new Map();
  const stateListeners = new Set();
  const document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (value) => new FakeTextNode(value),
    getElementById: (id) => roots.get(id) || null,
    addEventListener: (type, callback) => {
      const listeners = documentListeners.get(type) || [];
      listeners.push(callback);
      documentListeners.set(type, listeners);
    },
  };
  const api = {
    getState: () => Promise.resolve(state),
    onState: (callback) => {
      stateListeners.add(callback);
      return () => stateListeners.delete(callback);
    },
  };
  const context = {
    console,
    document,
    Promise,
    setTimeout,
    clearTimeout,
    ClawdLanguagePicker: {
      createLanguagePicker: () => ({
        element: new FakeElement("div"),
        dispose() {},
      }),
    },
    tutorialAPI: api,
    addEventListener: () => {},
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(RENDERER_SOURCE, context);

  return {
    body: roots.get("body"),
    footer: roots.get("footer"),
    renderAgents: () => {
      const primary = findAll(roots.get("footer"), (node) =>
        node.classList && node.classList.contains("btn-primary"))[0];
      assert.ok(primary, "tutorial primary button should be rendered");
      primary.dispatchEvent({ type: "click" });
    },
    getStateListeners: () => stateListeners,
  };
}

async function loadAgentsState(agents) {
  const harness = createHarness({
    i18n: {},
    lang: "en",
    langs: ["en"],
    heroSrc: "file:///clawd.png",
    doneHeroSvg: "",
    platform: "win32",
    shortcuts: [],
    agents,
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.renderAgents();
  return harness;
}

describe("tutorial agent icon renderer", () => {
  it("uses a stable rounded frame for every agent icon", () => {
    assert.match(
      TUTORIAL_HTML,
      /\.ag-avatar\s*\{[\s\S]*?flex:\s*0 0 30px;[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;[\s\S]*?padding:\s*2px;[\s\S]*?border-radius:\s*8px;/,
    );
    assert.match(
      TUTORIAL_HTML,
      /\.ag-avatar-icon\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?border-radius:\s*6px;[\s\S]*?background:\s*var\(--surface\);/,
    );
  });

  it("renders official icons for active, install, and cleanup rows without initials", async () => {
    const harness = await loadAgentsState({
      active: [{ agentId: "claude-code", label: "Claude Code", iconUrl: "file:///claude.png" }],
      install: [{ agentId: "codex", label: "Codex", iconUrl: "file:///codex.png" }],
      cleanup: [{ agentId: "gemini-cli", label: "Gemini CLI", iconUrl: "file:///gemini.png" }],
    });
    const avatars = findAll(harness.body, (node) =>
      node.classList && node.classList.contains("ag-avatar"));
    assert.strictEqual(avatars.length, 3);
    assert.deepStrictEqual(
      avatars.map((avatar) => findAll(avatar, (node) => node.tagName === "IMG")[0].src),
      ["file:///codex.png", "file:///gemini.png", "file:///claude.png"],
    );
    assert.deepStrictEqual(avatars.map((avatar) => avatar.textContent), ["", "", ""]);
  });

  it("uses the Clawd icon for missing assets and handles a failed fallback without letters", async () => {
    const harness = await loadAgentsState({
      active: [{ agentId: "missing", label: "Missing", iconUrl: null }],
      install: [],
      cleanup: [{ agentId: "broken", label: "Broken", iconUrl: "file:///broken.png" }],
    });
    const avatars = findAll(harness.body, (node) =>
      node.classList && node.classList.contains("ag-avatar"));
    const missingAvatar = avatars.find((avatar) =>
      findAll(avatar, (node) => node.tagName === "IMG")[0].src === "file:///clawd.png");
    const brokenAvatar = avatars.find((avatar) =>
      findAll(avatar, (node) => node.tagName === "IMG")[0].src === "file:///broken.png");
    const missingImage = findAll(missingAvatar, (node) => node.tagName === "IMG")[0];
    const brokenImage = findAll(brokenAvatar, (node) => node.tagName === "IMG")[0];

    assert.strictEqual(missingImage.src, "file:///clawd.png");
    brokenImage.dispatchEvent({ type: "error" });
    assert.strictEqual(brokenImage.src, "file:///clawd.png");
    brokenImage.dispatchEvent({ type: "error" });
    assert.strictEqual(brokenImage.getAttribute("hidden"), "");
    assert.ok(brokenAvatar.classList.contains("fallback"));
    assert.strictEqual(brokenAvatar.textContent, "");
  });
});
