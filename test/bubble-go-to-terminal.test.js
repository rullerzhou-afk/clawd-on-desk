"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "bubble-renderer.js"), "utf8");

class ClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : !!force;
    if (enabled) this.add(name); else this.remove(name);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.classList = new ClassList();
    this.style = { removeProperty(name) { delete this[name]; }, setProperty(name, value) { this[name] = value; } };
    this.attributes = new Map();
    this.textContent = "";
    this.disabled = false;
    this.value = "";
    this.offsetHeight = 100;
    this.scrollHeight = 100;
    this.scrollWidth = 0;
    this.clientWidth = 0;
  }
  set innerHTML(value) { this.children = []; this.textContent = String(value); }
  get innerHTML() { return this.textContent; }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  click() {
    if (this.disabled) return;
    for (const listener of this.listeners.get("click") || []) listener({ target: this, preventDefault() {} });
  }
  focus() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function createHarness() {
  const elements = new Map();
  for (const id of [
    "card", "toolPill", "toolPillText", "commandBlock", "irreversibleBadge",
    "elicitationForm", "elicitationProgress", "planFeedbackForm", "planFeedbackTextarea",
    "planFeedbackBack", "planFeedbackSubmit", "btnAllow", "btnDeny", "suggestions", "sessionTag",
  ]) elements.set(id, new FakeElement(id.includes("Textarea") ? "textarea" : "div"));
  elements.set("btnAllow", new FakeElement("button"));
  elements.set("btnDeny", new FakeElement("button"));
  elements.set("planFeedbackBack", new FakeElement("button"));
  elements.set("planFeedbackSubmit", new FakeElement("button"));
  const headerTitle = new FakeElement("span");
  const decisions = [];
  let showPermission;

  const document = {
    activeElement: null,
    getElementById: (id) => elements.get(id),
    querySelector: (selector) => selector === ".header-title" ? headerTitle : null,
    createElement: (tagName) => new FakeElement(tagName),
    addEventListener() {},
  };
  const bubbleAPI = {
    decide: (decision) => decisions.push(decision),
    reportHeight() {},
    onPermissionShow: (callback) => { showPermission = callback; },
    onPermissionHide() {},
  };
  const context = {
    window: {
      ClawdBubbleFormat: {
        formatDetail: () => "detail",
        truncate: (value) => String(value),
        parseMcpToolName: () => null,
        detectIrreversible: () => null,
      },
      bubbleAPI,
      addEventListener() {},
    },
    document,
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context);

  return {
    show(data) { showPermission({ lang: "en", toolInput: {}, suggestions: [], ...data }); },
    decisions,
    terminalButtons() {
      return elements.get("suggestions").children.filter((button) => button.textContent === "Go to Terminal");
    },
    actionTexts() { return elements.get("suggestions").children.map((button) => button.textContent); },
  };
}

describe("permission bubble terminal fallback (issue #689)", () => {
  // The bubble payload (buildPermissionBubblePayload) only forwards the
  // provenance flags isElicitation/isOpencode/isAntigravity/isCodex/isHermes.
  // Claude Code, CodeBuddy, Qwen, Copilot and other CC-protocol forks all
  // reach the renderer as a flagless default card — one case covers them.
  for (const [name, data] of [
    ["default cards (Claude Code / CC-protocol forks)", { toolName: "Bash" }],
    ["Codex interactive", { toolName: "Bash", isCodex: true }],
  ]) {
    it(`shows exactly one fallback for ${name} and emits only deny-and-focus`, () => {
      const harness = createHarness();
      harness.show(data);
      const buttons = harness.terminalButtons();

      assert.strictEqual(buttons.length, 1);
      buttons[0].click();
      buttons[0].click();
      assert.deepStrictEqual(harness.decisions, ["deny-and-focus"]);
    });
  }

  it("does not offer the fallback on Hermes cards (204 no-decision fails open = allow)", () => {
    const harness = createHarness();
    harness.show({ toolName: "Bash", isHermes: true });

    assert.strictEqual(harness.terminalButtons().length, 0);
    assert.deepStrictEqual(harness.decisions, []);
  });

  it("shows exactly one fallback for opencode and preserves its Always action", () => {
    const harness = createHarness();
    harness.show({
      toolName: "bash",
      isOpencode: true,
      opencodeAlways: ["bash"],
      toolInput: { command: "pwd" },
    });

    assert.ok(harness.actionTexts().includes("Always Allow (blanket)"));
    assert.strictEqual(harness.terminalButtons().length, 1);
    harness.terminalButtons()[0].click();
    assert.deepStrictEqual(harness.decisions, ["deny-and-focus"]);
  });

  for (const toolName of ["CodexExec", "KimiPermission"]) {
    it(`does not add a terminal fallback to passive ${toolName} notifications`, () => {
      const harness = createHarness();
      harness.show({ toolName });
      assert.strictEqual(harness.terminalButtons().length, 0);
    });
  }

  it("keeps elicitation's single terminal action and deny semantics", () => {
    const harness = createHarness();
    harness.show({ isElicitation: true, toolName: "AskUserQuestion", toolInput: { questions: [] } });

    const buttons = harness.terminalButtons();
    assert.strictEqual(buttons.length, 1);
    buttons[0].click();
    assert.deepStrictEqual(harness.decisions, ["deny"]);
  });

  it("keeps plan review's single terminal action and deny-and-focus semantics", () => {
    const harness = createHarness();
    harness.show({ toolName: "ExitPlanMode" });

    const buttons = harness.terminalButtons();
    assert.strictEqual(buttons.length, 1);
    buttons[0].click();
    assert.deepStrictEqual(harness.decisions, ["deny-and-focus"]);
  });
});
