"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

class FakeElement {
  constructor() {
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.innerHTML = "";
    this.textContent = "";
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

test("mobile consent surfaces token-reset phase failure in the command error", async () => {
  const switchConfigs = new Map();
  let connectionInfoReads = 0;
  const settingsAPI = {
    command: async (_name, payload) => ({
      status: "error",
      message: "disk full",
      tokenReset: payload.resetAccess === true,
      rePairRequired: payload.resetAccess === true,
    }),
    getMobileConnectionInfo: async () => {
      connectionInfoReads++;
      return {
        status: "ok",
        port: 23334,
        token: `token-${connectionInfoReads}`,
        lanIp: "192.0.2.10",
        pairUrl: `http://192.0.2.10:23334/mobile/?token=token-${connectionInfoReads}`,
      };
    },
  };
  const context = vm.createContext({
    console,
    Promise,
    setTimeout,
    navigator: {},
    document: { createElement: () => new FakeElement() },
    window: { settingsAPI },
  });
  context.globalThis = context;
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "settings-tab-mobile.js"),
    "utf8"
  );
  vm.runInContext(source, context, { filename: "settings-tab-mobile.js" });

  const strings = {
    mobilePermissionTokenResetFailure: "TOKEN RESET — RE-PAIR. ",
    cancel: "Cancel",
  };
  const core = {
    runtime: {},
    state: { snapshot: { mobilePreviewEnabled: true, mobilePermissionPreviewEnabled: false } },
    helpers: {
      t: (key) => strings[key] || key,
      escapeHtml: (value) => String(value),
      buildSwitchRow(config) {
        switchConfigs.set(config.key, config);
        return new FakeElement();
      },
      showSettingsDialog: async () => "reset",
    },
  };
  context.ClawdSettingsTabMobile.init(core);
  context.ClawdSettingsTabMobile.renderChannelBody(new FakeElement());
  await Promise.resolve();
  assert.strictEqual(connectionInfoReads, 1);

  const config = switchConfigs.get("mobilePermissionPreviewEnabled");
  assert.ok(config, "permission child switch should be rendered");
  const result = await config.onToggle({ nextRaw: true });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.tokenReset, true);
  assert.match(result.message, /TOKEN RESET — RE-PAIR/);
  assert.match(result.message, /disk full/);
  await Promise.resolve();
  assert.strictEqual(connectionInfoReads, 2, "reset failure must refresh stale pairing data");
});
