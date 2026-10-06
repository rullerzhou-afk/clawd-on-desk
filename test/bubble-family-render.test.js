"use strict";

// EXECUTES the family branch of bubble-renderer.js against a minimal DOM stub
// and asserts the FINAL element state (plan §9 payload↔renderer contract).
// Static source matching cannot catch "statement present but effect undone"
// (e.g. a later line blanking commandBlock) — running the real show() can.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describe, it } = require("node:test");

const RENDERER_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "bubble-renderer.js"), "utf8");
const bubbleFormat = require("../src/bubble-format");

function fakeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    textContent: "",
    innerHTML: "",
    title: "",
    value: "",
    disabled: false,
    className: "",
    children: [],
    listeners: {},
    attributes: {},
    scrollWidth: 0,
    clientWidth: 0,
    scrollHeight: 0,
    offsetHeight: 0,
    style: {
      display: "",
      setProperty() {},
      removeProperty() {},
      getPropertyValue() { return ""; },
    },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, force) { (force ?? !this._set.has(c)) ? this._set.add(c) : this._set.delete(c); },
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener(type) { delete this.listeners[type]; },
    appendChild(child) { this.children.push(child); return child; },
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
    focus() {},
    // Real DOM: a disabled button dispatches no click events.
    click() { if (!this.disabled && this.listeners.click) this.listeners.click({ preventDefault() {} }); },
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
  };
  return el;
}

function makeRenderer() {
  const byId = new Map();
  const decideCalls = [];
  const captured = { show: null, hide: null };

  const documentStub = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, fakeEl());
      return byId.get(id);
    },
    querySelector() { return fakeEl(); },
    createElement(tag) { return fakeEl(tag); },
    body: fakeEl("body"),
    documentElement: fakeEl("html"),
    addEventListener() {},
  };

  const windowStub = {
    ClawdBubbleFormat: bubbleFormat,
    bubbleAPI: {
      onPermissionShow(fn) { captured.show = fn; },
      onPermissionHide(fn) { captured.hide = fn; },
      decide(behavior) { decideCalls.push(behavior); },
      reportHeight() {},
      setImeEditing() {},
    },
    addEventListener() {},
    getComputedStyle() { return { lineHeight: "16px", getPropertyValue: () => "" }; },
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    requestAnimationFrame(fn) { fn(); return 0; },
    cancelAnimationFrame() {},
    getComputedStyle: windowStub.getComputedStyle,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(RENDERER_SRC, sandbox, { filename: "bubble-renderer.js" });
  assert.strictEqual(typeof captured.show, "function", "renderer did not register onPermissionShow");

  return {
    show: captured.show,
    decideCalls,
    el: (id) => byId.get(id) || fakeEl(),
  };
}

function familyPayload(overrides = {}) {
  return {
    lang: "en",
    familyAgentId: "opencode",
    familyDisplayName: "OpenCode",
    toolName: "bash",
    toolInput: { command: "rm -rf /tmp/x" },
    familyAlways: ["bash"],
    familyPatterns: [],
    suggestions: [],
    interaction: {
      intent: "tool-approval",
      automationEligibility: { autoTools: true, unattended: true },
      capabilities: {
        allowDeny: true,
        answerQuestions: false,
        planFeedback: false,
        nativeFallback: true,
      },
    },
    ...overrides,
  };
}

describe("bubble-renderer family branch (executed)", () => {
  it("explains a held v2 resource request without badging benign cards", () => {
    const r = makeRenderer();
    const input = { resource: "rm -rf ./test-fixture" };
    r.show(familyPayload({ toolName: "shell", toolInput: input, reminderTag: "file-delete" }));
    assert.strictEqual(r.el("irreversibleBadge").style.display, "");
    assert.strictEqual(r.el("irreversibleBadge").getAttribute("data-reason"), "file-delete");
    assert.ok(r.el("irreversibleBadge").textContent.includes(bubbleFormat.formatReminderReason("file-delete", "en")));
    assert.strictEqual(input.command, undefined, "display must not mutate the stored resource payload");
    const benign = makeRenderer();
    benign.show(familyPayload({ toolName: "shell", toolInput: { resource: "npm test" }, reminderTag: null }));
    assert.strictEqual(benign.el("irreversibleBadge").style.display, "none");
    assert.strictEqual(benign.el("irreversibleBadge").getAttribute("data-reason"), null);
  });

  it("shows the display-only destructive hint for v1 and v2 when automation is off", () => {
    for (const toolInput of [{ command: "rm -rf ./test-fixture" }, { resource: "rm -rf ./test-fixture" }]) {
      const r = makeRenderer();
      r.show(familyPayload({ toolName: "shell", toolInput, reminderTag: null }));
      assert.strictEqual(r.el("irreversibleBadge").style.display, "");
      assert.strictEqual(r.el("irreversibleBadge").getAttribute("data-reason"), "file-delete");
    }
    const r = makeRenderer();
    r.show(familyPayload({ toolName: "read", toolInput: { resource: "rm -rf ./test-fixture" } }));
    assert.strictEqual(r.el("irreversibleBadge").style.display, "none");
  });

  it("renders the PascalCased pill and the command as the FINAL detail text", () => {
    const r = makeRenderer();
    r.show(familyPayload());
    assert.strictEqual(r.el("toolPillText").textContent, "Bash");
    assert.strictEqual(r.el("toolPill").getAttribute("data-tool"), "Bash");
    // Final state — a later mutation blanking the block fails HERE.
    assert.strictEqual(r.el("commandBlock").textContent, "rm -rf /tmp/x");
  });

  it("keeps the family UI and Always action when a missing tool name is classified unknown", () => {
    const r = makeRenderer();
    r.show(familyPayload({
      toolName: "unknown",
      toolInput: { command: "custom action" },
      interaction: {
        intent: "unknown",
        automationEligibility: { autoTools: false, unattended: false },
        capabilities: {
          allowDeny: true,
          answerQuestions: false,
          planFeedback: false,
          nativeFallback: true,
        },
      },
    }));

    assert.strictEqual(r.el("toolPillText").textContent, "Unknown");
    assert.strictEqual(r.el("commandBlock").textContent, "custom action");
    assert.strictEqual(r.el("suggestions").children[0].textContent, "Always Allow (blanket)");
  });

  it("dedupes repeated filepath segments", () => {
    const r = makeRenderer();
    r.show(familyPayload({ toolName: "edit", toolInput: { filepath: "a.md, a.md" } }));
    assert.strictEqual(r.el("commandBlock").textContent, "a.md");
  });

  it("renders the url as the FINAL detail for url-shaped input (e.g. webfetch)", () => {
    const r = makeRenderer();
    r.show(familyPayload({ toolName: "webfetch", toolInput: { url: "https://example.com/private" } }));
    assert.strictEqual(r.el("toolPillText").textContent, "Webfetch");
    assert.strictEqual(r.el("commandBlock").textContent, "https://example.com/private");
  });

  it("falls back to deduped familyPatterns, then raw JSON", () => {
    const r = makeRenderer();
    r.show(familyPayload({ toolInput: {}, familyPatterns: ["npm *", "npm *"] }));
    assert.strictEqual(r.el("commandBlock").textContent, "npm *");

    const r2 = makeRenderer();
    r2.show(familyPayload({ toolInput: { weird: 1 }, familyPatterns: [] }));
    assert.strictEqual(r2.el("commandBlock").textContent, JSON.stringify({ weird: 1 }));
  });

  it("shows Always only with candidates (plus the #704 terminal fallback); tooltip carries the display name (twice, no {agent})", () => {
    const withAlways = makeRenderer();
    withAlways.show(familyPayload());
    // #704 appends a Go-to-Terminal fallback after the Always action.
    const btns = withAlways.el("suggestions").children;
    assert.strictEqual(btns.length, 2, "Always + Go-to-Terminal fallback");
    assert.strictEqual(btns[0].textContent, "Always Allow (blanket)");
    assert.strictEqual(btns[1].textContent, "Go to Terminal");
    const occurrences = btns[0].title.split("OpenCode").length - 1;
    assert.strictEqual(occurrences, 2, `tooltip must name the product twice: ${btns[0].title}`);
    assert.strictEqual(btns[0].title.includes("{agent}"), false);
    assert.strictEqual(/opencode/.test(btns[0].title), false, "no lowercase internal id in user-facing text");

    const withoutAlways = makeRenderer();
    withoutAlways.show(familyPayload({ familyAlways: [] }));
    const fallbackOnly = withoutAlways.el("suggestions").children;
    assert.strictEqual(fallbackOnly.length, 1, "no Always without candidates — fallback only");
    assert.strictEqual(fallbackOnly[0].textContent, "Go to Terminal");
  });

  it("clicking Always emits the single family-always behavior and disables ALL buttons", () => {
    const r = makeRenderer();
    r.show(familyPayload());
    const alwaysBtn = r.el("suggestions").children[0];
    alwaysBtn.click();
    assert.deepStrictEqual(r.decideCalls, ["family-always"]);
    assert.strictEqual(r.el("btnAllow").disabled, true);
    assert.strictEqual(r.el("btnDeny").disabled, true);
    assert.strictEqual(alwaysBtn.disabled, true, "the clicked Always button itself must be disabled");
    assert.strictEqual(r.el("suggestions").children[1].disabled, true, "the terminal fallback must be disabled too");
    // Double-click through the now-disabled button must not fire a second decide.
    alwaysBtn.click();
    assert.deepStrictEqual(r.decideCalls, ["family-always"]);
  });

  it("falls back to familyAgentId when no display name is provided", () => {
    const r = makeRenderer();
    r.show(familyPayload({ familyDisplayName: null }));
    assert.ok(r.el("suggestions").children[0].title.includes("opencode"));
  });
});
