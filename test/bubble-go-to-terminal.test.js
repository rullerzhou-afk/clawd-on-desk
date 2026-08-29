"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "bubble-renderer.js"), "utf8");

function interaction(intent, capabilities = {}) {
  return {
    intent,
    automationEligibility: { autoTools: true, unattended: true },
    capabilities: {
      allowDeny: false,
      answerQuestions: false,
      planFeedback: false,
      nativeFallback: false,
      ...capabilities,
    },
  };
}

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
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this, ...event });
  }
  focus() { this.focusCount = (this.focusCount || 0) + 1; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function createHarness(options = {}) {
  const elements = new Map();
  for (const id of [
    "card", "toolPill", "toolPillText", "commandBlock", "irreversibleBadge",
    "elicitationForm", "elicitationProgress", "planFeedbackForm", "planFeedbackTextarea",
    "planFeedbackBack", "planFeedbackSubmit", "btnAllow", "btnDeny", "suggestions", "sessionTag",
    "compactBlock", "detailScroll", "detailTruncation", "btnExpand", "btnCollapse", "actions",
    "footerSecondary",
  ]) elements.set(id, new FakeElement(id.includes("Textarea") ? "textarea" : "div"));
  elements.set("btnAllow", new FakeElement("button"));
  elements.set("btnDeny", new FakeElement("button"));
  elements.set("planFeedbackBack", new FakeElement("button"));
  elements.set("planFeedbackSubmit", new FakeElement("button"));
  const headerTitle = new FakeElement("span");
  const decisions = [];
  const expandedRequests = [];
  const animationFrames = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const heightReports = [];
  let showPermission;
  let showPresentation;
  let restoreActiveControl;

  const document = {
    activeElement: null,
    visibilityState: options.visibilityState || "visible",
    getElementById: (id) => elements.get(id),
    querySelector: (selector) => selector === ".header-title" ? headerTitle : null,
    createElement: (tagName) => new FakeElement(tagName),
    addEventListener(type, callback) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(callback);
      documentListeners.set(type, listeners);
    },
  };
  const bubbleAPI = {
    decide: (decision) => decisions.push(decision),
    reportHeight: (report) => heightReports.push(report),
    onPermissionShow: (callback) => { showPermission = callback; },
    onPermissionHide() {},
    onPresentation: (callback) => { showPresentation = callback; },
    onRestoreActiveControl: (callback) => { restoreActiveControl = callback; },
    setExpanded: (expanded) => expandedRequests.push(expanded),
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
      innerWidth: options.innerWidth || 480,
      addEventListener(type, callback) {
        const listeners = windowListeners.get(type) || [];
        listeners.push(callback);
        windowListeners.set(type, listeners);
      },
    },
    document,
    requestAnimationFrame(callback) {
      if (options.deferFrames) {
        animationFrames.push(callback);
      } else {
        callback();
      }
      return animationFrames.length || 1;
    },
    cancelAnimationFrame() {},
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context);

  return {
    show(data) { showPermission({ lang: "en", toolInput: {}, suggestions: [], ...data }); },
    decisions,
    expandedRequests,
    present(data) { showPresentation(data); },
    restoreActiveControl() { restoreActiveControl(); },
    setVisibility(state) {
      document.visibilityState = state;
      for (const callback of documentListeners.get("visibilitychange") || []) callback();
    },
    flushAnimationFrames() {
      for (const callback of animationFrames.splice(0)) callback();
    },
    heightReports,
    resizeViewport(width) {
      context.window.innerWidth = width;
      for (const callback of windowListeners.get("resize") || []) callback();
    },
    element(id) { return elements.get(id); },
    terminalButtons() {
      return [
        ...elements.get("suggestions").children,
        ...elements.get("footerSecondary").children,
      ].filter((button) => button.textContent === "Go to Terminal");
    },
    actionTexts() { return elements.get("suggestions").children.map((button) => button.textContent); },
  };
}

describe("permission bubble terminal fallback (issue #689)", () => {
  // Every actionable payload carries route-owned interaction semantics.
  // Provenance flags remain wire-format adapters, not renderer policy.
  for (const [name, data] of [
    ["default cards (Claude Code / CC-protocol forks)", {
      toolName: "Bash",
      interaction: interaction("tool-approval", { allowDeny: true, nativeFallback: true }),
    }],
    ["Codex interactive", {
      toolName: "Bash",
      isCodex: true,
      interaction: interaction("tool-approval", { allowDeny: true, nativeFallback: true }),
    }],
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

  it("does not offer a terminal fallback when Hermes has no native approval prompt", () => {
    const harness = createHarness();
    harness.show({
      toolName: "Bash",
      isHermes: true,
      interaction: interaction("tool-approval", { allowDeny: true }),
    });

    assert.strictEqual(harness.terminalButtons().length, 0);
    assert.deepStrictEqual(harness.decisions, []);
  });

  it("shows exactly one fallback for opencode-family cards and preserves the Always action", () => {
    const harness = createHarness();
    // Family cards are selected by familyAgentId (the post-#706 payload
    // vocabulary; buildPermissionBubblePayload no longer emits isOpencode /
    // opencodeAlways for the renderer).
    harness.show({
      toolName: "bash",
      familyAgentId: "opencode",
      familyDisplayName: "OpenCode",
      familyAlways: ["bash"],
      familyPatterns: [],
      toolInput: { command: "pwd" },
      interaction: interaction("tool-approval", { allowDeny: true, nativeFallback: true }),
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
    harness.show({
      isElicitation: true,
      toolName: "AskUserQuestion",
      toolInput: { questions: [] },
      interaction: interaction("human-question", { answerQuestions: true, nativeFallback: true }),
    });

    const buttons = harness.terminalButtons();
    assert.strictEqual(buttons.length, 1);
    buttons[0].click();
    assert.deepStrictEqual(harness.decisions, ["deny"]);
  });

  it("hands Hermes clarification back to its native UI and focuses the terminal", () => {
    const harness = createHarness();
    harness.show({
      isElicitation: true,
      isHermes: true,
      toolName: "clarify",
      toolInput: { questions: [] },
      interaction: interaction("human-question", { answerQuestions: true, nativeFallback: true }),
    });

    const buttons = harness.terminalButtons();
    assert.strictEqual(buttons.length, 1);
    buttons[0].click();
    assert.deepStrictEqual(harness.decisions, ["deny-and-focus"]);
  });

  it("keeps plan review's single terminal action and deny-and-focus semantics", () => {
    const harness = createHarness();
    harness.show({
      toolName: "ExitPlanMode",
      interaction: interaction("plan-review", {
        allowDeny: true,
        planFeedback: true,
        nativeFallback: true,
      }),
    });

    const buttons = harness.terminalButtons();
    assert.strictEqual(buttons.length, 1);
    buttons[0].click();
    assert.deepStrictEqual(harness.decisions, ["deny-and-focus"]);
  });
});

describe("permission bubble compact/detail presentation", () => {
  it("keeps Codex native questions compact and sends the whole card back to Codex", () => {
    const harness = createHarness();
    harness.show({
      toolName: "CodexUserInput",
      isCodexUserInputNotify: true,
      toolInput: {
        questions: [{
          id: "q1",
          header: "Progress",
          question: "How should daily progress be displayed?",
          options: [
            { label: "Count", description: "Show completed versus total." },
            { label: "Percentage", description: "Show a percentage." },
          ],
        }],
      },
      interaction: interaction("notification", { nativeFallback: true }),
      presentation: { expanded: true, measurementEpoch: 4 },
    });

    const card = harness.element("card");
    assert.strictEqual(card.classList.contains("expanded"), false,
      "a stale expanded presentation must still render as a compact focus cue");
    assert.strictEqual(card.classList.contains("codex-user-input-focus-card"), true);
    assert.strictEqual(card.getAttribute("role"), "button");
    assert.strictEqual(card.getAttribute("tabindex"), "0");
    assert.strictEqual(harness.element("btnExpand").classList.contains("visible"), false,
      "read-only Codex options must never advertise expansion");
    assert.strictEqual(harness.element("elicitationForm").classList.contains("visible"), false,
      "the unanswerable option list must not be rendered as an interaction form");

    card.click();
    card.click();
    assert.deepStrictEqual(harness.decisions, ["codex-user-input-focus"]);
  });

  for (const key of ["Enter", " "]) {
    it(`lets ${key === " " ? "Space" : key} activate the compact Codex question card`, () => {
      const harness = createHarness();
      harness.show({
        toolName: "CodexUserInput",
        isCodexUserInputNotify: true,
        toolInput: { questions: [{ id: "q1", question: "Choose one", options: [] }] },
        interaction: interaction("notification", { nativeFallback: true }),
        presentation: { expanded: false, measurementEpoch: 0 },
      });
      let prevented = false;

      harness.element("card").dispatch("keydown", {
        key,
        preventDefault() { prevented = true; },
      });

      assert.strictEqual(prevented, true);
      assert.deepStrictEqual(harness.decisions, ["codex-user-input-focus"]);
    });
  }

  it("keeps the explicit Codex focus button as the same single action", () => {
    const harness = createHarness();
    harness.show({
      toolName: "CodexUserInput",
      isCodexUserInputNotify: true,
      toolInput: { questions: [{ id: "q1", question: "Choose one", options: [] }] },
      interaction: interaction("notification", { nativeFallback: true }),
      presentation: { expanded: false, measurementEpoch: 0 },
    });

    harness.element("btnAllow").click();
    assert.deepStrictEqual(harness.decisions, ["codex-user-input-focus"]);
  });

  it("keeps Ask compact, unfocused, and shows the question count on its Answer entry", () => {
    const harness = createHarness();
    harness.show({
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [
          { id: "0", question: "First?", options: [] },
          { id: "1", question: "Second?", options: [] },
        ],
      },
      interaction: interaction("human-question", { answerQuestions: true }),
      presentation: { expanded: false, measurementEpoch: 0 },
    });
    assert.strictEqual(harness.element("actions").style.display, "none");
    assert.strictEqual(harness.element("btnExpand").textContent, "Answer · Questions: 2");
    assert.strictEqual(harness.element("card").classList.contains("expanded"), false);
  });

  it("renders an initially expanded Ask without the compact Answer entry", () => {
    const harness = createHarness();
    harness.show({
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [
          {
            id: "0",
            question: "Choose one",
            options: [{ label: "One", description: "First option" }],
          },
        ],
      },
      interaction: interaction("human-question", { answerQuestions: true }),
      presentation: { expanded: true, measurementEpoch: 0 },
    });

    assert.strictEqual(harness.element("card").classList.contains("expanded"), true);
    assert.strictEqual(harness.element("actions").style.display, "");
    assert.strictEqual(harness.element("btnExpand").classList.contains("visible"), false);
    assert.strictEqual(harness.element("btnCollapse").textContent, "Collapse");
    assert.deepStrictEqual(harness.expandedRequests, []);
  });

  it("re-measures the compact card after the window finally narrows", () => {
    const harness = createHarness();
    harness.show({
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [{
          id: "0",
          question: "Choose one",
          options: [{ label: "One", description: "First option" }],
        }],
      },
      interaction: interaction("human-question", { answerQuestions: true }),
      presentation: { expanded: true, measurementEpoch: 0 },
    });

    // Main collapses this card because another request took the expanded owner.
    // It sends the compact presentation before repositionBubbles() narrows the
    // window, so this frame can still measure against the expanded width.
    harness.present({ expanded: false, measurementEpoch: 1 });
    const wideCount = harness.heightReports.length;
    assert.ok(wideCount > 0, "collapsing reports a compact height");
    const wide = harness.heightReports[wideCount - 1];
    assert.strictEqual(wide.state, "compact");

    // The window narrows to the compact width and the same content wraps taller.
    harness.element("card").offsetHeight = 160;
    harness.element("card").scrollHeight = 160;
    harness.resizeViewport(326);

    const afterResize = harness.heightReports.slice(wideCount);
    assert.ok(afterResize.length > 0,
      "a real width change must schedule a fresh measurement, or the card stays clipped");
    const narrow = afterResize[afterResize.length - 1];
    assert.strictEqual(narrow.state, "compact");
    assert.strictEqual(narrow.measurementEpoch, 1,
      "the correction keeps the epoch main asked for so it is not fenced out");
    assert.ok(narrow.height > wide.height,
      "the narrower window reports the taller wrapped height");

    // Main answers a new height by resizing again. That must not loop.
    const settled = harness.heightReports.length;
    harness.resizeViewport(326);
    assert.strictEqual(harness.heightReports.length, settled,
      "an unchanged width must not schedule another report");
  });

  it("does not acknowledge a resize before permission content arrives", () => {
    const harness = createHarness({ innerWidth: 340 });

    harness.resizeViewport(500);
    assert.strictEqual(harness.heightReports.length, 0,
      "an empty renderer must not let a resize masquerade as the first rendered-content ACK");

    harness.show({
      toolName: "Bash",
      toolInput: { command: "echo ready" },
      interaction: interaction("tool-approval"),
      presentation: { expanded: false, measurementEpoch: 0 },
    });
    assert.ok(harness.heightReports.length > 0,
      "the real permission payload still produces its normal initial height report");
  });

  it("drops a deferred explicit focus request if the bubble is hidden before its frame", () => {
    const harness = createHarness({ deferFrames: true });
    const focusTarget = new FakeElement("input");
    harness.element("elicitationForm").querySelector = () => focusTarget;
    harness.show({
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [{
          id: "0",
          question: "Choose one",
          options: [{ label: "One", description: "First option" }],
        }],
      },
      interaction: interaction("human-question", { answerQuestions: true }),
      presentation: { expanded: true, measurementEpoch: 0 },
    });

    harness.restoreActiveControl();
    harness.setVisibility("hidden");
    harness.setVisibility("visible");
    harness.flushAnimationFrames();
    assert.strictEqual(focusTarget.focusCount || 0, 0,
      "a hidden document must not replay an old focus intent when it reappears");

    harness.restoreActiveControl();
    harness.flushAnimationFrames();
    assert.strictEqual(focusTarget.focusCount, 1,
      "a fresh visible explicit restore still focuses the active answer");

    harness.restoreActiveControl();
    harness.present({ expanded: true, measurementEpoch: 1 });
    harness.flushAnimationFrames();
    assert.strictEqual(focusTarget.focusCount, 1,
      "a restore request from an older presentation epoch must not focus controls");
  });

  it("restores focus when queue selection sends the IPC before the hidden document becomes visible", () => {
    const harness = createHarness({ deferFrames: true, visibilityState: "hidden" });
    const focusTarget = new FakeElement("input");
    harness.element("elicitationForm").querySelector = () => focusTarget;
    harness.show({
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [{
          id: "0",
          question: "Choose one",
          options: [{ label: "One", description: "First option" }],
        }],
      },
      interaction: interaction("human-question", { answerQuestions: true }),
      presentation: { expanded: true, measurementEpoch: 0 },
    });

    harness.restoreActiveControl();
    harness.setVisibility("visible");
    harness.flushAnimationFrames();

    assert.strictEqual(focusTarget.focusCount, 1,
      "the queued rAF must survive main/show vs renderer/visibility ordering");
  });

  it("keeps every ordinary quick action on the compact card and reveals only the full detail after expansion", () => {
    const harness = createHarness();
    const full = `${"echo long; ".repeat(40)}END_MARKER`;
    harness.show({
      toolName: "Bash",
      toolInput: { command: "echo long; …" },
      detailText: full,
      suggestions: [{ type: "addRules", ruleContent: "npm test" }],
      canOfferSessionTrust: true,
      interaction: interaction("tool-approval", { allowDeny: true, nativeFallback: true }),
      presentation: { expanded: false, measurementEpoch: 0 },
    });

    assert.strictEqual(harness.element("compactBlock").textContent, "detail");
    assert.strictEqual(harness.element("commandBlock").textContent, full);
    assert.strictEqual(harness.element("actions").style.display, "");
    assert.strictEqual(harness.element("suggestions").style.display, "");
    assert.deepStrictEqual(
      harness.element("suggestions").children.map((button) => button.textContent),
      ["Always allow `npm test`", "Go to Terminal"]
    );
    assert.strictEqual(harness.element("footerSecondary").classList.contains("visible"), true);
    assert.strictEqual(
      harness.element("footerSecondary").children[0].textContent,
      "Don’t ask again in this session"
    );
    assert.strictEqual(harness.element("btnExpand").classList.contains("visible"), true);

    harness.element("btnExpand").click();
    assert.deepStrictEqual(harness.expandedRequests, [true]);
    harness.present({ expanded: true, measurementEpoch: 1 });
    assert.strictEqual(harness.element("card").classList.contains("expanded"), true);
    assert.strictEqual(harness.element("actions").style.display, "");
  });

  it("keeps Plan approval compact while feedback waits for View plan and preserves its draft", () => {
    const harness = createHarness();
    harness.show({
      toolName: "ExitPlanMode",
      toolInput: { plan: "Compact plan preview" },
      detailText: "Full plan\n".repeat(80),
      interaction: interaction("plan-review", {
        allowDeny: true,
        planFeedback: true,
      }),
      presentation: { expanded: false, measurementEpoch: 0 },
    });

    assert.strictEqual(harness.element("actions").style.display, "");
    assert.strictEqual(harness.element("btnAllow").textContent, "Approve");
    assert.strictEqual(harness.element("btnDeny").style.display, "none");
    assert.strictEqual(harness.element("suggestions").style.display, "none");
    assert.strictEqual(harness.element("btnExpand").textContent, "View plan");
    harness.element("btnExpand").click();
    harness.present({ expanded: true, measurementEpoch: 1 });
    assert.strictEqual(harness.element("actions").style.display, "");

    const feedbackButton = harness.element("suggestions").children[0];
    assert.strictEqual(feedbackButton.textContent, "Suggest changes");
    feedbackButton.click();
    const textarea = harness.element("planFeedbackTextarea");
    textarea.value = "Keep this draft";
    textarea.dispatch("input");

    // A same-entry refresh (for example session-trust failure copy) must not
    // rebuild the Plan DOM or clear the draft.
    harness.show({
      toolName: "ExitPlanMode",
      sessionTrustError: "Retry",
      presentation: { expanded: true, measurementEpoch: 1 },
    });
    assert.strictEqual(textarea.value, "Keep this draft");

    harness.element("btnCollapse").click();
    harness.present({ expanded: false, measurementEpoch: 2 });
    harness.present({ expanded: true, measurementEpoch: 3 });
    assert.strictEqual(textarea.value, "Keep this draft");
    assert.strictEqual(harness.element("planFeedbackForm").classList.contains("visible"), true);
  });
});
