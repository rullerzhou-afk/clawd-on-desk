"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const i18nContext = {};
i18nContext.globalThis = i18nContext;
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "..", "src", "settings-i18n.js"), "utf8"),
  i18nContext,
  { filename: "settings-i18n.js" },
);
test("all language packs define permissionAutomationCancel", () => {
  for (const [locale, dictionary] of Object.entries(i18nContext.ClawdSettingsI18n.STRINGS)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(dictionary, "permissionAutomationCancel"),
      `${locale} should define permissionAutomationCancel`,
    );
  }
});

class FakeElement {
  constructor() {
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this._innerHTML = "";
    this.textContent = "";
  }
  get innerHTML() { return this._innerHTML || ""; }
  set innerHTML(value) { this._innerHTML = value; this.children = []; }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  set innerHTML(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._innerHTML = value;
  }
  get innerHTML() { return this._innerHTML; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      const matches = selector.startsWith(".")
        ? child.className.split(" ").includes(selector.slice(1))
        : selector === "#" + child.id;
      if (matches) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  addEventListener(name, listener) {
    if (name === "click") this.click = listener;
  }
  setAttribute() {}
  removeAttribute() {}
  get isConnected() { return true; }
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
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
        pairCode: "ABCD1234",
        pairExpiresAt: 123456,
        lanIp: "192.0.2.10",
        pairUrl: `http://192.0.2.10:23334/mobile/?pair=ABCD1234`,
      };
    },
  };
  const context = vm.createContext({
    console,
    Promise,
    setTimeout: () => 1,
    clearTimeout() {},
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
    ...i18nContext.ClawdSettingsI18n.STRINGS.en,
    mobilePermissionTokenResetFailure: "TOKEN RESET — RE-PAIR. ",
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
      attachDescriptionDisclosure: (row) => row,
      buildDetailGroup: (_label, rows) => {
        const group = new FakeElement();
        for (const row of rows) group.appendChild(row);
        return group;
      },
      buildButton: () => new FakeElement(),
      setButtonState: () => {},
      buildStatusLine: () => ({ element: new FakeElement(), setStatus() {} }),
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

for (const enabling of [false, true]) {
  test(`partial reset UI distinguishes ${enabling ? "enable preview" : "standalone reset"} and leaves preference unchanged`, async () => {
    const buttons = new Map(), configs = new Map(), dialogs = [], timers = [];
    const strings = i18nContext.ClawdSettingsI18n.STRINGS.zh;
    const result = { status: "error", message: "disk full", partialReset: true };
    let reads = 0, refreshes = 0;
    const snapshot = { mobilePreviewEnabled: true, mobilePermissionPreviewEnabled: !enabling };
    const context = vm.createContext({
      Promise, Date, console, navigator: {}, document: { createElement: () => new FakeElement(), visibilityState: "visible" },
      setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
      window: { confirm: () => true, settingsAPI: {
        resetMobileAccess: async () => result, refreshMobilePairCode: async () => { refreshes++; return { status: "error", message: "refresh failed" }; },
        command: async () => result,
        getMobileConnectionInfo: async () => { reads++; return { status: "ok", port: 23334, lanIp: "192.0.2.1", pairCode: "ABCD1234", pairExpiresAt: 123456, pairUrl: "http://192.0.2.1:23334/mobile/?pair=ABCD1234" }; },
      } },
    });
    context.globalThis = context;
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/settings-tab-mobile.js"), "utf8"), context);
    context.ClawdSettingsTabMobile.init({ state: { snapshot }, helpers: {
      t: (key) => strings[key],
      buildSwitchRow(config) { configs.set(config.key, config); return new FakeElement(); },
      attachDescriptionDisclosure() {}, buildDetailGroup(_label, rows) { const el = new FakeElement(); rows.forEach((r) => el.appendChild(r)); return el; },
      buildButton(config) { const el = new FakeElement(); el.addEventListener = (_name, fn) => { el.click = fn; }; buttons.set(config.labelKey, el); return el; },
      showSettingsDialog: async (config) => { dialogs.push(config); return "reset"; },
    } });
    context.ClawdSettingsTabMobile.renderChannelBody(new FakeElement());
    await Promise.resolve(); await Promise.resolve();
    assert.equal(reads, 1, "info without token must be ready");
    assert.ok(buttons.has("mobileRefreshPairCode")); assert.equal(buttons.has("mobileRegenerate"), false);
    if (enabling) {
      const feedback = await configs.get("mobilePermissionPreviewEnabled").onToggle({ nextRaw: true });
      assert.equal(feedback.partialReset, true); assert.match(feedback.message, /权限预览没有开启/);
    } else {
      buttons.get("mobileReset").click(); await Promise.resolve(); await Promise.resolve();
      assert.equal(dialogs.at(-1).title, strings.mobileReset);
      assert.equal(dialogs.at(-1).detail, strings.mobilePartialResetFailure);
      assert.doesNotMatch(dialogs.at(-1).detail, /权限预览没有开启/);
    }
    assert.equal(snapshot.mobilePermissionPreviewEnabled, !enabling);
    buttons.get("mobileRefreshPairCode").click(); await Promise.resolve(); await Promise.resolve();
    assert.equal(refreshes, 1);
    assert.equal(dialogs.at(-1).title, strings.mobileRefreshPairCode);
    assert.equal(dialogs.at(-1).detail, "refresh failed");
    const beforePoll = reads;
    timers.find((timer) => timer.delay === 5000).fn(); await Promise.resolve(); await Promise.resolve();
    assert.equal(reads, beforePoll + 1);
  });
}

test("all language packs define pairing and partial-reset messages", () => {
  for (const [locale, strings] of Object.entries(i18nContext.ClawdSettingsI18n.STRINGS)) {
    for (const key of ["mobileRefreshPairCode", "mobileConnPairCode", "mobileConnPairExpires", "mobileConnQrHint", "mobilePartialResetFailure", "mobilePermissionPartialResetFailure", "mobileDismiss"]) {
      assert.equal(typeof strings[key], "string", `${locale}.${key}`); assert.ok(strings[key]);
    }
  }
});

test("connection info renders the pair QR block and degrades to text-only without it", async () => {
  const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 41 41\"></svg>";
  const baseInfo = { status: "ok", port: 23334, lanIp: "192.0.2.1", pairCode: "ABCD1234",
    pairExpiresAt: 123456, pairUrl: "http://192.0.2.1:23334/mobile/?pair=ABCD1234" };
  const strings = i18nContext.ClawdSettingsI18n.STRINGS.en;

  for (const [expected, info] of [
    [true, { ...baseInfo, pairQrSvg: svg }],
    [false, baseInfo],
    [false, { ...baseInfo, pairQrSvg: "javascript:alert(1)" }],
  ]) {
    const context = vm.createContext({
      Promise, console, navigator: {},
      document: { createElement: () => new FakeElement(), visibilityState: "visible" },
      setTimeout() { return 1; }, clearTimeout() {},
      window: { settingsAPI: {
        getMobileConnectionInfo: async () => info,
        getMobileDevices: async () => ({ status: "ok", devices: [], legacyActive: false }),
      } },
    });
    context.globalThis = context;
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/settings-tab-mobile.js"), "utf8"), context);
    context.ClawdSettingsTabMobile.init({ state: { snapshot: { mobilePreviewEnabled: true } }, helpers: {
      t: (key) => strings[key] || key,
      buildSwitchRow: () => new FakeElement(),
      attachDescriptionDisclosure() {},
      buildDetailGroup(_label, rows) { const el = new FakeElement(); rows.forEach((r) => el.appendChild(r)); return el; },
      buildButton: () => new FakeElement(),
      showSettingsDialog: async () => "cancel",
    } });
    const body = new FakeElement();
    context.ClawdSettingsTabMobile.renderChannelBody(body);
    await flushMobileUi();

    const qrBlock = body.querySelectorAll(".mobile-pair-qr")[0] || null;
    assert.equal(!!qrBlock, expected, `expected qr block: ${expected}`);
    if (qrBlock) {
      const holder = qrBlock.querySelectorAll(".mobile-pair-qr-holder")[0];
      assert.ok(holder && holder.innerHTML.startsWith("<svg"), "qr holder must embed the main-process SVG");
      const hint = qrBlock.querySelectorAll(".mobile-pair-qr-hint")[0];
      assert.equal(hint && hint.textContent, strings.mobileConnQrHint);
    }
  }
});

test("the revoke-old-token confirmation names the reset button of its own language", () => {
  for (const [locale, strings] of Object.entries(i18nContext.ClawdSettingsI18n.STRINGS)) {
    assert.ok(strings.mobileRevokeLegacyConfirm.includes(strings.mobileReset), locale);
  }
});

const DEVICE = {
  id: "d_0123456789abcdef",
  name: "iPhone · Safari",
  origin: "pair",
  state: "pending",
  createdAt: 1000000,
  lastSeenAt: 1000000,
  currentIssuedAt: null,
};

function textOf(element) {
  return [element.textContent, ...element.children.map(textOf)].join(" ");
}

async function flushMobileUi() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function mobileDevicesHarness({ devices = [DEVICE], legacyActive = false, enabled = true, lang = "zh" } = {}) {
  const strings = i18nContext.ClawdSettingsI18n.STRINGS[lang];
  const timers = new Map();
  const dialogs = [];
  const choices = [];
  const revoked = [];
  let timerId = 0;
  let now = 1060000;
  let reads = 0;
  let legacyRevokes = 0;
  let deviceResult = { status: "ok", mayHoldLegacy: false };
  let legacyResult = { status: "ok" };
  let data = { status: "ok", devices, legacyActive };
  const document = { createElement: () => new FakeElement(), visibilityState: "visible" };
  const api = {
    getMobileConnectionInfo: async () => ({ status: "ok", port: 23334, lanIp: "192.0.2.1", pairCode: "ABCD1234" }),
    getMobileDevices: async () => {
      reads++;
      return data;
    },
    revokeMobileDevice: async (id) => {
      revoked.push(id);
      if (deviceResult.status === "ok") data = { ...data, devices: data.devices.filter((device) => device.id !== id) };
      return deviceResult;
    },
    revokeMobileLegacy: async () => {
      legacyRevokes++;
      if (legacyResult.status === "ok" || legacyResult.partialRevoke) data = { ...data, legacyActive: false };
      return legacyResult;
    },
    resetMobileAccess: async () => {
      data = { status: "ok", devices: [], legacyActive: false };
      return { status: "ok" };
    },
  };
  class UiDate extends Date {
    static now() { return now; }
  }
  const context = vm.createContext({
    console, Promise, Intl, Date: UiDate, navigator: {}, document,
    setTimeout(fn, delay) {
      timers.set(++timerId, { fn, delay });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    window: { settingsAPI: api, confirm: () => true },
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/settings-tab-mobile.js"), "utf8"), context);
  const state = { snapshot: { mobilePreviewEnabled: enabled, lang } };
  context.ClawdSettingsTabMobile.init({ state, helpers: {
    t: (key) => strings[key] || key,
    buildSwitchRow: () => new FakeElement(),
    attachDescriptionDisclosure() {},
    buildDetailGroup(label, rows) {
      const group = new FakeElement();
      group.textContent = label;
      for (const row of rows) group.appendChild(row);
      return group;
    },
    buildButton(config) {
      const button = new FakeElement();
      button.textContent = strings[config.labelKey];
      button.className = config.className || "";
      button.labelKey = config.labelKey;
      return button;
    },
    showSettingsDialog: async (config) => {
      dialogs.push(config);
      return choices.shift() || "cancel";
    },
  } });
  const body = new FakeElement();
  context.ClawdSettingsTabMobile.renderChannelBody(body);
  return {
    body, dialogs, choices, revoked, document, state, strings, api,
    reads: () => reads,
    legacyRevokes: () => legacyRevokes,
    setData(value) { data = value; },
    deviceResult(value) { deviceResult = value; },
    legacyResult(value) { legacyResult = value; },
    time(value) { now = value; },
    async poll() {
      const [id, timer] = [...timers].find(([, item]) => item.delay === 5000);
      timers.delete(id);
      timer.fn();
      await flushMobileUi();
    },
  };
}

test("device rows show pending, relative last-seen time, pairing time and migration in every language", async () => {
  for (const lang of Object.keys(i18nContext.ClawdSettingsI18n.STRINGS)) {
    const h = mobileDevicesHarness({ lang, devices: [DEVICE, { ...DEVICE, id: "d_fedcba9876543210", origin: "legacy", state: "active" }] });
    await flushMobileUi();
    const rows = h.body.querySelectorAll(".mobile-device-row");
    assert.equal(rows.length, 2);
    assert.match(textOf(rows[0]), /iPhone · Safari/);
    assert.ok(textOf(rows[0]).includes(h.strings.mobileDevicePending));
    const relative = new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(-1, "minute");
    assert.ok(textOf(rows[1]).includes(h.strings.mobileDeviceLastSeen.replace("{time}", relative)));
    assert.ok(textOf(rows[1]).includes(h.strings.mobileDeviceMigrated));
    assert.ok(textOf(rows[0]).includes(h.strings.mobileDevicePairedAt.replace("{time}", new Date(DEVICE.createdAt).toLocaleString(lang))));
  }
});

test("device revoke confirms first, cancellation does nothing, success refreshes immediately", async () => {
  const h = mobileDevicesHarness();
  await flushMobileUi();
  const button = h.body.querySelector(".mobile-device-revoke");
  h.choices.push("cancel");
  await button.click();
  assert.equal(h.revoked.length, 0);
  assert.ok(h.dialogs[0].detail.includes(DEVICE.name));
  h.choices.push("revoke");
  const pending = button.click();
  assert.equal(h.revoked.length, 0);
  await pending;
  assert.deepEqual(h.revoked, [DEVICE.id]);
  assert.ok(textOf(h.body).includes(h.strings.mobileDevicesEmpty));
  assert.equal(h.reads(), 2);
});

for (const mayHoldLegacy of [false, true]) {
  for (const legacyActive of [false, true]) {
    test(`legacy reminder requires both mayHoldLegacy=${mayHoldLegacy} and current legacyActive=${legacyActive}`, async () => {
      const h = mobileDevicesHarness({ legacyActive: true });
      await flushMobileUi();
      h.setData({ status: "ok", devices: [DEVICE], legacyActive });
      h.deviceResult({ status: "ok", mayHoldLegacy });
      h.choices.push("revoke", "later");
      await h.body.querySelector(".mobile-device-revoke").click();
      assert.equal(h.dialogs.length, mayHoldLegacy && legacyActive ? 2 : 1);
      if (mayHoldLegacy && legacyActive) {
        assert.equal(h.dialogs[1].detail, h.strings.mobileDeviceMayHoldLegacy);
        assert.deepEqual(h.dialogs[1].actions.map((action) => action.label), [h.strings.mobileRevokeLater, h.strings.mobileRevokeLegacy]);
      }
      assert.equal(h.legacyRevokes(), 0);
    });
  }
}

test("legacy reminder can lead to confirmed legacy revocation", async () => {
  const h = mobileDevicesHarness({ legacyActive: true });
  await flushMobileUi();
  h.deviceResult({ status: "ok", mayHoldLegacy: true });
  h.choices.push("revoke", "revoke", "revoke");
  await h.body.querySelector(".mobile-device-revoke").click();
  assert.equal(h.dialogs[2].detail, h.strings.mobileRevokeLegacyConfirm);
  assert.equal(h.legacyRevokes(), 1);
  assert.ok(textOf(h.body).includes(h.strings.mobileDevicesEmpty));
});

test("legacy row appears only while active and requires confirmation", async () => {
  const h = mobileDevicesHarness({ devices: [], legacyActive: true });
  await flushMobileUi();
  assert.ok(textOf(h.body).includes(h.strings.mobileLegacyDevices));
  const button = h.body.querySelector(".mobile-device-revoke");
  h.choices.push("cancel");
  await button.click();
  assert.equal(h.legacyRevokes(), 0);
  assert.equal(h.dialogs[0].detail, h.strings.mobileRevokeLegacyConfirm);
  h.choices.push("revoke");
  await button.click();
  assert.equal(h.legacyRevokes(), 1);
  assert.equal(h.body.querySelector(".mobile-device-revoke"), null);
  assert.ok(textOf(h.body).includes(h.strings.mobileDevicesEmpty));
});

test("legacy row explains that the old link stays valid until revoked, in every language", async () => {
  for (const lang of Object.keys(i18nContext.ClawdSettingsI18n.STRINGS)) {
    const h = mobileDevicesHarness({ lang, legacyActive: true });
    await flushMobileUi();
    const [paired, legacy] = h.body.querySelectorAll(".mobile-device-row");
    assert.ok(h.strings.mobileLegacyDevicesDesc, `${lang}.mobileLegacyDevicesDesc`);
    assert.deepEqual(
      legacy.querySelectorAll(".row-desc").map((node) => node.textContent),
      [h.strings.mobileLegacyDevicesDesc],
    );
    assert.ok(!textOf(paired).includes(h.strings.mobileLegacyDevicesDesc));
  }
});

for (const failure of ["device", "legacy", "partial"]) {
  test(`revocation reports ${failure} failure and refreshes the list`, async () => {
    const h = mobileDevicesHarness({ legacyActive: failure !== "device", devices: failure === "device" ? [DEVICE] : [] });
    await flushMobileUi();
    const result = { status: "error", message: "disk full", partialRevoke: failure === "partial" };
    h.deviceResult(result);
    h.legacyResult(result);
    h.choices.push("revoke", "ok");
    await h.body.querySelector(".mobile-device-revoke").click();
    assert.equal(h.dialogs[1].detail, failure === "partial" ? h.strings.mobilePartialRevokeFailure : "disk full");
    assert.equal(h.reads(), 2);
    assert.equal(h.body.querySelectorAll(".mobile-device-row").length, failure === "partial" ? 0 : 1);
  });
}

test("device list shows read errors and recovers on the next poll", async () => {
  const h = mobileDevicesHarness();
  await flushMobileUi();
  h.api.getMobileDevices = async () => { throw new Error("read failed"); };
  await h.poll();
  assert.equal(h.body.querySelector(".mobile-info-error").textContent, "read failed");
  h.api.getMobileDevices = async () => ({ status: "ok", devices: [], legacyActive: false });
  await h.poll();
  assert.ok(textOf(h.body).includes(h.strings.mobileDevicesEmpty));
});

test("unchanged polls preserve row and button nodes while updating relative time", async () => {
  const h = mobileDevicesHarness({ devices: [{ ...DEVICE, state: "active" }] });
  await flushMobileUi();
  const row = h.body.querySelector(".mobile-device-row");
  const button = h.body.querySelector(".mobile-device-revoke");
  const status = h.body.querySelector(".mobile-device-status");
  const previous = status.textContent;
  h.time(1120000);
  await h.poll();
  assert.equal(h.body.querySelector(".mobile-device-row"), row);
  assert.equal(h.body.querySelector(".mobile-device-revoke"), button);
  assert.notEqual(status.textContent, previous);
  assert.equal(h.reads(), 2);
  h.document.visibilityState = "hidden";
  await h.poll();
  assert.equal(h.reads(), 2);
});

test("device list is absent when mobile preview is disabled", async () => {
  const h = mobileDevicesHarness({ enabled: false });
  await flushMobileUi();
  assert.equal(h.reads(), 0);
  assert.equal(h.body.querySelector("#mobile-devices"), null);
});

test("reset access immediately refreshes paired devices too", async () => {
  const h = mobileDevicesHarness({ legacyActive: true });
  await flushMobileUi();
  const reset = h.body.children.flatMap((child) => child.children).find((child) => child.labelKey === "mobileReset");
  reset.click();
  await flushMobileUi();
  assert.ok(textOf(h.body).includes(h.strings.mobileDevicesEmpty));
  assert.equal(h.reads(), 2);
});

test("every language defines device list, confirmation and failure text", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/settings-tab-mobile.js"), "utf8");
  const keys = [...source.matchAll(/(?:t\(|labelKey:\s*)["'](mobile[A-Za-z]+)["']/g)].map((match) => match[1]);
  for (const [lang, strings] of Object.entries(i18nContext.ClawdSettingsI18n.STRINGS)) {
    for (const key of keys) assert.ok(strings[key], `${lang}.${key}`);
  }
});

for (const failure of ["reject", "error"]) {
  test(`pairing info recovers after success, ${failure}, and the same success`, async () => {
    const timers = new Map();
    let timerId = 0;
    let reads = 0;
    const info = {
      status: "ok", port: 23334, lanIp: "192.0.2.1", pairCode: "ABCD1234",
      pairExpiresAt: 2000000000000, pairUrl: "http://192.0.2.1:23334/mobile/?pair=ABCD1234",
    };
    const context = vm.createContext({
      Promise, Date, navigator: {},
      document: { visibilityState: "visible", createElement: () => new FakeElement() },
      setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
      clearTimeout(id) { timers.delete(id); },
      window: { settingsAPI: { getMobileConnectionInfo: async () => {
        if (++reads === 2) {
          if (failure === "reject") throw new Error("transient IPC failure");
          return { status: "error" };
        }
        return info;
      } } },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/settings-tab-mobile.js"), "utf8"), context);
    context.ClawdSettingsTabMobile.init({
      state: { snapshot: { mobilePreviewEnabled: true } },
      helpers: {
        t: (key) => key,
        buildSwitchRow: () => new FakeElement(),
        attachDescriptionDisclosure() {},
        buildButton: () => new FakeElement(),
        buildDetailGroup(_label, rows) {
          const group = new FakeElement();
          rows.forEach((row) => group.appendChild(row));
          return group;
        },
      },
    });
    const body = new FakeElement();
    context.ClawdSettingsTabMobile.renderChannelBody(body);
    await new Promise((resolve) => setImmediate(resolve));
    const container = body.children.flatMap((group) => group.children)
      .find((element) => element.id === "mobile-connection-info");
    assert.equal(container.children.length, 5);
    async function poll() {
      const [id, timer] = [...timers].find(([, task]) => task.delay === 5000);
      timers.delete(id);
      timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await poll();
    assert.equal(container.children.length, 1);
    assert.equal(container.children[0].textContent, "mobileError");
    await poll();
    assert.equal(reads, 3);
    assert.equal(container.children.length, 5);
    const values = container.children.map((row) => row.children[0].children[1].textContent);
    assert.ok(values.includes("ABCD-1234"));
    assert.ok(values.includes(info.pairUrl));
    const restoredRow = container.children[0];
    await poll();
    assert.strictEqual(container.children[0], restoredRow, "unchanged visible info still avoids a redraw");
  });
}
