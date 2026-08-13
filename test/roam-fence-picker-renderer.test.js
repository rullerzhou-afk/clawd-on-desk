"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const geometry = require("../src/roam-fence-picker-geometry");
const rendererSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "roam-fence-picker-renderer.js"),
  "utf8",
);

class FakeClassList {
  constructor(element) { this.element = element; }
  values() { return new Set(String(this.element.className || "").split(/\s+/).filter(Boolean)); }
  contains(name) { return this.values().has(name); }
  toggle(name, force) {
    const values = this.values();
    const add = force === undefined ? !values.has(name) : !!force;
    if (add) values.add(name); else values.delete(name);
    this.element.className = [...values].join(" ");
    return add;
  }
}

class FakeTarget {
  constructor(tagName, id = "") {
    this.tagName = String(tagName).toUpperCase();
    this.id = id;
    this.parentNode = null;
    this.listeners = new Map();
    this.style = {};
    this.className = "";
    this.classList = new FakeClassList(this);
    this.textContent = "";
    this.disabled = false;
    this.capturedPointers = new Set();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    if (typeof event.preventDefault !== "function") {
      event.preventDefault = function preventDefault() { this.defaultPrevented = true; };
    }
    for (const listener of this.listeners.get(event.type) || []) listener(event);
  }
  closest(selector) {
    let current = this;
    while (current) {
      if (selector === "button" && current.tagName === "BUTTON") return current;
      if (selector.startsWith("#") && current.id === selector.slice(1)) return current;
      current = current.parentNode;
    }
    return null;
  }
  setPointerCapture(pointerId) { this.capturedPointers.add(pointerId); }
  releasePointerCapture(pointerId) { this.capturedPointers.delete(pointerId); }
}

function pointer(type, x, y, pointerId = 1, target = null) {
  return {
    type,
    clientX: x,
    clientY: y,
    pointerId,
    button: 0,
    target,
  };
}

function createHarness(lang = "en") {
  const body = new FakeTarget("body", "body");
  const selection = new FakeTarget("div", "selection");
  const size = new FakeTarget("span", "selection-size");
  const title = new FakeTarget("div", "title");
  const hint = new FakeTarget("div", "hint");
  const actions = new FakeTarget("div", "actions");
  const confirm = new FakeTarget("button", "confirm");
  const cancel = new FakeTarget("button", "cancel");
  actions.parentNode = body;
  confirm.parentNode = actions;
  cancel.parentNode = actions;
  const elements = new Map([
    ["selection", selection],
    ["selection-size", size],
    ["title", title],
    ["hint", hint],
    ["actions", actions],
    ["confirm", confirm],
    ["cancel", cancel],
  ]);
  const documentListeners = new Map();
  const document = {
    body,
    documentElement: { lang: "en" },
    getElementById: (id) => elements.get(id) || null,
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      for (const listener of documentListeners.get(event.type) || []) listener(event);
    },
  };
  const calls = { confirm: [], cancel: 0, ready: 0, applied: 0 };
  let stateListener = null;
  const api = {
    ready: () => { calls.ready += 1; },
    applied: () => { calls.applied += 1; },
    onState: (listener) => { stateListener = listener; },
    confirm: (value) => { calls.confirm.push({ ...value }); },
    cancel: () => { calls.cancel += 1; },
  };
  const context = {
    console,
    document,
    window: null,
    globalThis: null,
    roamFencePickerAPI: api,
    roamFencePickerGeometry: geometry,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(rendererSource, context);
  stateListener({
    lang,
    workArea: { width: 1000, height: 800 },
    minimumSize: { width: 100, height: 80 },
  });
  return { body, selection, actions, confirm, cancel, title, hint, document, calls };
}

function drawValidSelection(harness) {
  harness.body.dispatchEvent(pointer("pointerdown", 100, 100, 1, harness.body));
  harness.body.dispatchEvent(pointer("pointermove", 400, 300, 1, harness.body));
  assert.strictEqual(harness.selection.classList.contains("editing"), false);
  harness.body.dispatchEvent(pointer("pointerup", 400, 300, 1, harness.body));
  assert.strictEqual(harness.selection.classList.contains("editing"), true);
  assert.strictEqual(harness.confirm.disabled, false);
}

test("renderer enters crop editing only after the initial draw, then moves and resizes", () => {
  const harness = createHarness();
  assert.strictEqual(harness.calls.ready, 1);
  assert.strictEqual(harness.calls.applied, 1);
  assert.strictEqual(harness.selection.style.display, "none");
  drawValidSelection(harness);
  assert.deepStrictEqual(
    { left: harness.selection.style.left, top: harness.selection.style.top, width: harness.selection.style.width, height: harness.selection.style.height },
    { left: "100px", top: "100px", width: "300px", height: "200px" },
  );

  harness.body.dispatchEvent(pointer("pointerdown", 200, 180, 2, harness.body));
  harness.body.dispatchEvent(pointer("pointermove", 300, 230, 2, harness.body));
  harness.body.dispatchEvent(pointer("pointerup", 300, 230, 2, harness.body));
  assert.deepStrictEqual(
    { left: harness.selection.style.left, top: harness.selection.style.top },
    { left: "200px", top: "150px" },
  );

  harness.body.dispatchEvent(pointer("pointerdown", 500, 220, 3, harness.body));
  harness.body.dispatchEvent(pointer("pointermove", 650, 220, 3, harness.body));
  harness.body.dispatchEvent(pointer("pointerup", 650, 220, 3, harness.body));
  assert.strictEqual(harness.selection.style.width, "450px");
});

test("keyboard can create, move, resize, and confirm a selection", () => {
  const harness = createHarness();
  const dispatchKey = (key, shiftKey = false) => {
    const event = {
      type: "keydown",
      key,
      shiftKey,
      target: harness.body,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    harness.document.dispatchEvent(event);
    assert.strictEqual(event.defaultPrevented, true);
  };

  dispatchKey("ArrowRight");
  assert.deepStrictEqual(
    { left: harness.selection.style.left, top: harness.selection.style.top, width: harness.selection.style.width, height: harness.selection.style.height },
    { left: "250px", top: "200px", width: "500px", height: "400px" },
  );
  dispatchKey("ArrowRight");
  assert.strictEqual(harness.selection.style.left, "260px");
  dispatchKey("ArrowDown", true);
  assert.strictEqual(harness.selection.style.height, "410px");

  const enter = {
    type: "keydown",
    key: "Enter",
    target: harness.body,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  harness.document.dispatchEvent(enter);
  assert.strictEqual(enter.defaultPrevented, true);
  assert.deepStrictEqual(harness.calls.confirm, [
    { x: 260, y: 200, width: 500, height: 410 },
  ]);
});

test("renderer provides Brazilian Portuguese picker copy", () => {
  const harness = createHarness("pt-BR");
  assert.strictEqual(harness.document.documentElement.lang, "pt-BR");
  assert.strictEqual(harness.title.textContent, "Escolher a área de atividade do Clawd");
  assert.match(harness.hint.textContent, /Shift\+setas/);
  assert.strictEqual(harness.confirm.textContent, "Usar esta área");
  assert.strictEqual(harness.cancel.textContent, "Cancelar");
});

test("Enter on Cancel uses the button action instead of the global confirm shortcut", () => {
  const harness = createHarness();
  drawValidSelection(harness);
  const keyEvent = {
    type: "keydown",
    key: "Enter",
    target: harness.cancel,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  harness.document.dispatchEvent(keyEvent);
  assert.strictEqual(keyEvent.defaultPrevented, false);
  assert.deepStrictEqual(harness.calls.confirm, []);
  harness.cancel.dispatchEvent({ type: "click", target: harness.cancel });
  assert.strictEqual(harness.calls.cancel, 1);

  const bodyEnter = {
    type: "keydown",
    key: "Enter",
    target: harness.body,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  harness.document.dispatchEvent(bodyEnter);
  assert.strictEqual(bodyEnter.defaultPrevented, true);
  assert.strictEqual(harness.calls.confirm.length, 1);
});

test("Escape cancels a valid selection without confirming it", () => {
  const harness = createHarness();
  drawValidSelection(harness);
  const escape = {
    type: "keydown",
    key: "Escape",
    target: harness.body,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };

  harness.document.dispatchEvent(escape);

  assert.strictEqual(escape.defaultPrevented, true);
  assert.strictEqual(harness.calls.cancel, 1);
  assert.deepStrictEqual(harness.calls.confirm, []);
});

test("action-bar padding cannot replace the selection", () => {
  const harness = createHarness();
  drawValidSelection(harness);
  const before = { ...harness.selection.style };
  harness.body.dispatchEvent(pointer("pointerdown", 20, 20, 4, harness.actions));
  harness.body.dispatchEvent(pointer("pointerup", 20, 20, 4, harness.actions));
  assert.deepStrictEqual(harness.selection.style, before);
});

test("pointer identity is isolated and a cancelled interaction keeps its visible position", () => {
  const harness = createHarness();
  drawValidSelection(harness);
  const before = { ...harness.selection.style };
  harness.body.dispatchEvent(pointer("pointerdown", 200, 180, 5, harness.body));
  harness.body.dispatchEvent(pointer("pointerdown", 700, 600, 6, harness.body));
  harness.body.dispatchEvent(pointer("pointermove", 700, 600, 6, harness.body));
  harness.body.dispatchEvent(pointer("pointerup", 700, 600, 6, harness.body));
  assert.deepStrictEqual(harness.selection.style, before, "a second pointer must not take over");
  harness.body.dispatchEvent(pointer("pointermove", 300, 230, 5, harness.body));
  const interruptedPosition = { ...harness.selection.style };
  assert.notDeepStrictEqual(interruptedPosition, before);
  harness.body.dispatchEvent(pointer("pointercancel", 300, 230, 5, harness.body));
  assert.deepStrictEqual(harness.selection.style, interruptedPosition, "cancel keeps the last visible rectangle");
  harness.body.dispatchEvent(pointer("pointermove", 500, 500, 5, harness.body));
  assert.deepStrictEqual(harness.selection.style, interruptedPosition, "hover after cancellation cannot keep dragging");
});

test("a delayed lostpointercapture cannot roll back a new mouse drag with the same pointer id", () => {
  const harness = createHarness();
  drawValidSelection(harness);
  harness.body.dispatchEvent(pointer("pointerdown", 200, 180, 1, harness.body));
  harness.body.dispatchEvent(pointer("pointermove", 250, 200, 1, harness.body));
  harness.body.dispatchEvent(pointer("pointerup", 250, 200, 1, harness.body));

  harness.body.dispatchEvent(pointer("pointerdown", 250, 200, 1, harness.body));
  harness.body.dispatchEvent(pointer("pointermove", 350, 250, 1, harness.body));
  const secondDragPosition = { ...harness.selection.style };
  harness.body.dispatchEvent(pointer("lostpointercapture", 350, 250, 1, harness.body));
  assert.deepStrictEqual(harness.selection.style, secondDragPosition, "stale capture loss must be ignored");

  harness.body.dispatchEvent(pointer("pointermove", 400, 300, 1, harness.body));
  assert.notDeepStrictEqual(harness.selection.style, secondDragPosition, "the current drag remains active");
  harness.body.dispatchEvent(pointer("pointerup", 400, 300, 1, harness.body));
});

test("a stream missing pointerup recovers on the next mouse down", () => {
  const harness = createHarness();
  drawValidSelection(harness);
  harness.body.dispatchEvent(pointer("pointerdown", 200, 180, 8, harness.body));
  harness.body.dispatchEvent(pointer("pointermove", 300, 230, 8, harness.body));
  const lastPressedPosition = { ...harness.selection.style };
  harness.body.dispatchEvent(pointer("pointerdown", 300, 230, 8, harness.body));
  assert.deepStrictEqual(harness.selection.style, lastPressedPosition, "restart keeps the visible rectangle");
  harness.body.dispatchEvent(pointer("pointermove", 350, 260, 8, harness.body));
  assert.notDeepStrictEqual(harness.selection.style, lastPressedPosition, "the next mouse down starts normally");
  harness.body.dispatchEvent(pointer("pointerup", 350, 260, 8, harness.body));
});
