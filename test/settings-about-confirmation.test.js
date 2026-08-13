"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ABOUT_SOURCE = path.join(__dirname, "..", "src", "settings-tab-about.js");

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "").toUpperCase();
    this.children = [];
    this.eventListeners = {};
    this.textContent = "";
    this.disabled = false;
    this.type = "";
    this.parentNode = null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(listener);
  }

  dispatchEvent(event) {
    const listeners = this.eventListeners[event.type] || [];
    for (const listener of [...listeners]) listener(event);
  }
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

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadCleanupActionForTest({ showModal, command }) {
  const document = {
    createElement: (tagName) => new FakeElement(tagName),
  };
  const modalCalls = [];
  const toastCalls = [];
  const commandCalls = [];
  const strings = {
    aboutCleanupButton: "Remove Clawd integrations",
    aboutCleanupRunning: "Removing integrations",
    aboutCleanupFailed: "Integration cleanup failed",
    aboutCleanupSuccess: "Removed {removed} item(s) from {affected} integration(s). Failed: {failed}.",
    aboutCleanupConfirmTitle: "Remove Clawd integrations?",
    aboutCleanupConfirmDetail: "This removes Clawd hooks/plugins from local agents.",
    aboutCleanupConfirmAction: "Remove integrations",
    aboutCleanupConfirmCancel: "Cancel",
  };
  const context = {
    console,
    document,
    window: null,
    globalThis: null,
    settingsAPI: {
      command: (...args) => {
        commandCalls.push(args);
        return command(...args);
      },
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(ABOUT_SOURCE, "utf8").replace(
    "root.ClawdSettingsTabAbout = { init };",
    "root.ClawdSettingsTabAbout = { init, __test: { createCleanupFooterAction } };"
  );
  vm.runInContext(source, context);

  const core = {
    runtime: { about: {} },
    helpers: {
      t: (key) => strings[key] || key,
      showSettingsConfirmModal: (options) => {
        modalCalls.push(options);
        return showModal(options);
      },
    },
    ops: {
      showToast: (message, options) => toastCalls.push({ message, options }),
    },
    i18n: { CONTRIBUTORS: [], MAINTAINERS: [] },
    tabs: {},
  };
  context.ClawdSettingsTabAbout.init(core);
  const wrap = context.ClawdSettingsTabAbout.__test.createCleanupFooterAction();

  return {
    button: wrap.children[0],
    status: wrap.children[1],
    modalCalls,
    toastCalls,
    commandCalls,
  };
}

describe("About integration cleanup confirmation", () => {
  it("uses the Settings modal and stays fail-closed for cancel and repeated clicks", async () => {
    const modal = createDeferred();
    const harness = loadCleanupActionForTest({
      showModal: () => modal.promise,
      command: () => Promise.resolve({ status: "ok" }),
    });

    harness.button.dispatchEvent({ type: "click" });
    harness.button.dispatchEvent({ type: "click" });
    await flushPromises();

    assert.strictEqual(harness.modalCalls.length, 1);
    assert.strictEqual(harness.commandCalls.length, 0);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.modalCalls[0])), {
      title: "Remove Clawd integrations?",
      detail: "This removes Clawd hooks/plugins from local agents.",
      actions: [
        { id: "cancel", label: "Cancel", tone: "neutral", defaultFocus: true },
        { id: "confirm", label: "Remove integrations", tone: "danger" },
      ],
    });

    modal.resolve("cancel");
    await flushPromises();
    assert.strictEqual(harness.commandCalls.length, 0);
    assert.strictEqual(harness.button.disabled, false);
  });

  it("runs cleanup only after confirmation and restores the button after success", async () => {
    const cleanup = createDeferred();
    const harness = loadCleanupActionForTest({
      showModal: () => Promise.resolve("confirm"),
      command: (name) => {
        assert.strictEqual(name, "cleanupIntegrations");
        return cleanup.promise;
      },
    });

    harness.button.dispatchEvent({ type: "click" });
    await flushPromises();
    assert.deepStrictEqual(harness.commandCalls, [["cleanupIntegrations"]]);
    assert.strictEqual(harness.button.disabled, true);
    assert.strictEqual(harness.button.textContent, "Removing integrations");

    cleanup.resolve({
      status: "ok",
      cleanup: { summary: { entriesRemoved: 3, agentsAffected: 2, failed: 0 } },
    });
    await flushPromises();
    assert.strictEqual(harness.button.disabled, false);
    assert.strictEqual(harness.button.textContent, "Remove Clawd integrations");
    assert.strictEqual(
      harness.status.textContent,
      "Removed 3 item(s) from 2 integration(s). Failed: 0."
    );
    assert.strictEqual(harness.toastCalls.length, 1);
  });

  it("restores the button and reports command failures", async () => {
    const harness = loadCleanupActionForTest({
      showModal: () => Promise.resolve("confirm"),
      command: () => Promise.reject(new Error("synthetic failure")),
    });

    harness.button.dispatchEvent({ type: "click" });
    await flushPromises();
    assert.strictEqual(harness.button.disabled, false);
    assert.strictEqual(harness.button.textContent, "Remove Clawd integrations");
    assert.strictEqual(harness.status.textContent, "Integration cleanup failed: synthetic failure");
    assert.strictEqual(harness.toastCalls.length, 1);
  });
});
