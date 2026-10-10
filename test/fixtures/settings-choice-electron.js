"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const src = path.resolve(__dirname, "../../src");

async function main() {
  const profile = process.env.CLAWD_CHOICE_TEST_PROFILE;
  assert.ok(profile && path.isAbsolute(profile));
  app.setPath("userData", profile);
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1000, height: 700,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  const run = (code) => win.webContents.executeJavaScript(code);
  async function key(keyCode) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await run("new Promise(resolve => requestAnimationFrame(resolve))");
  }
  try {
    const css = fs.readFileSync(path.join(src, "settings.css"), "utf8");
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><style>${css}</style>
      <div class="app"><aside id="sidebar" class="sidebar"></aside><main id="content" class="content"></main></div>`)}`);
    for (const file of ["settings-size-slider.js", "settings-i18n.js", "settings-ui-core.js"]) {
      await run(`${fs.readFileSync(path.join(src, file), "utf8")}\nvoid 0;`);
    }
    await run(`
      window.exits = 0;
      for (const id of ["general", "agents", "theme", "animOverrides", "shortcuts", "telegram-approval", "discord-presence", "remote-ssh", "recap", "about"]) {
        ClawdSettingsCore.tabs[id] = { render(panel) { panel.textContent = id; }, onExit() { exits++; } };
      }
      window.readChoice = () => ({ value: ClawdSettingsCore.state.activeTab, focus: document.activeElement.dataset.value, exits });
      void 0;
    `);
    // Exercise the production shell; omit application bootstrap and IPC calls.
    const renderer = fs.readFileSync(path.join(src, "settings-renderer.js"), "utf8");
    await run(renderer.slice(0, renderer.indexOf("globalThis.ClawdSettingsTabGeneral.init(core);")));
    await run('ClawdSettingsCore.ops.requestRender({ sidebar: true, content: true }); document.querySelector("[role=tab]").focus();');
    await key("Down");
    assert.deepEqual(await run("readChoice()"), { value: "general", focus: "agents", exits: 0 });
    await run("ClawdSettingsCore.ops.requestRender({ sidebar: true, content: true })");
    assert.deepEqual(await run("readChoice()"), { value: "general", focus: "agents", exits: 0 });
    await key("Return");
    assert.deepEqual(await run("readChoice()"), { value: "agents", focus: "agents", exits: 1 });
    await key("Down");
    await key("Space");
    assert.deepEqual(await run("readChoice()"), { value: "theme", focus: "theme", exits: 2 });
    await key("Tab");
    assert.equal(await run('document.activeElement.getAttribute("role")'), "tabpanel");

    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Accessibility.enable");
    const tree = await win.webContents.debugger.sendCommand("Accessibility.getFullAXTree");
    const tabs = tree.nodes.filter((node) => !node.ignored && node.role?.value === "tab");
    assert.equal(tabs.length, 10);
    assert.equal(tabs.filter((node) => node.properties.some((prop) => prop.name === "selected" && prop.value.value)).length, 1);
    assert.equal(tree.nodes.filter((node) => !node.ignored && node.role?.value === "tabpanel").length, 1);
    win.webContents.debugger.detach();

    await run(`
      window.radioCalls = 0;
      window.radio = ClawdSettingsCore.helpers.buildSegmentedRadio({ id: "native-radio", ariaLabel: "Mode", value: "a",
        options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta", disabled: true }, { value: "c", label: "Gamma" }],
        onChange() { radioCalls++; return new Promise(resolve => { window.finishRadio = resolve; }); } });
      document.getElementById("content").appendChild(radio.element);
      radio.element.querySelector("button").focus();
    `);
    await key("Right");
    assert.deepEqual(await run('({ value: radio.getValue(), focus: document.activeElement.dataset.value, calls: radioCalls })'),
      { value: "c", focus: "c", calls: 1 });
    await key("Left");
    assert.equal(await run("radioCalls"), 1);
    await run('radio.element.querySelector("button").focus()');
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    await run("new Promise(resolve => requestAnimationFrame(resolve))");
    await run('radio.setValue("b"); finishRadio(false);');
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await run("new Promise(resolve => requestAnimationFrame(resolve))");
    assert.equal(await run("radioCalls"), 1, "Space pressed during pending cannot submit after completion");
    assert.equal(await run("radio.getValue()"), "b");
    assert.equal(await run('radio.element.getAttribute("aria-busy")'), "false");
    await run(`${fs.readFileSync(path.join(src, "settings-tab-recap.js"), "utf8")}\nvoid 0;`);
    await run(`
      window.recapSample = { schemaVersion: 1, status: "ready", period: "today",
        anchorDate: "2026-09-21", startDate: "2026-09-21", endDate: "2026-09-21",
        currentLocalHour: 10, recordingStartedDate: "2026-09-21", recordingEnabled: true, days: [] };
      window.recapRequests = {};
      window.settingsAPI = { queryRecap(period) {
        return period === "today" ? Promise.resolve(recapSample)
          : new Promise(resolve => { recapRequests[period] = resolve; });
      } };
      ClawdSettingsCore.state.snapshot = { lang: "en", recapEnabled: true };
      ClawdSettingsTabRecap.init(ClawdSettingsCore);
      ClawdSettingsCore.ops.selectTab("recap");
      void 0;
    `);
    await run("new Promise(resolve => requestAnimationFrame(resolve))");
    await run(`
      window.recapHeader = document.querySelector(".recap-page-header");
      window.recapChart = document.querySelector(".recap-card");
      window.recapHeight = recapChart.getBoundingClientRect().height;
      window.periodButtons = [...document.querySelectorAll(".recap-period-button")];
      periodButtons[0].focus();
    `);
    await key("Right");
    assert.deepEqual(await run(`({ header: document.querySelector(".recap-page-header") === recapHeader,
      chart: document.querySelector(".recap-card") === recapChart,
      height: recapChart.getBoundingClientRect().height === recapHeight,
      inert: document.querySelector(".recap-data-body").inert,
      focus: document.activeElement === periodButtons[1] })`),
    { header: true, chart: true, height: true, inert: true, focus: true });
    await key("Right");
    await run('recapRequests.month({ ...recapSample, period: "month" })');
    await run("new Promise(resolve => requestAnimationFrame(resolve))");
    await run('recapRequests.week({ ...recapSample, period: "week" })');
    await run("new Promise(resolve => requestAnimationFrame(resolve))");
    assert.deepEqual(await run(`({ header: document.querySelector(".recap-page-header") === recapHeader,
      key: document.querySelector(".recap-grid").dataset.settingsFocusKey,
      focus: document.activeElement === periodButtons[2],
      inert: document.querySelector(".recap-data-body").inert })`),
    { header: true, key: "recap-grid-month", focus: true, inert: false });
    await run('periodButtons[3].click()');
    await run('recapRequests.year({ ...recapSample, period: "year" })');
    await run("new Promise(resolve => requestAnimationFrame(resolve))");
    assert.match(await run(`document.getElementById(document.querySelector(".recap-grid").getAttribute("aria-activedescendant")).dataset.cellKey`), /2026-09-21/);
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await run('periodButtons[3].focus()');
    await key("Tab");
    assert.equal(await run('document.activeElement.classList.contains("recap-grid")'), true);
    await key("Left");
    await run("new Promise(resolve => setTimeout(resolve, 120))");
    assert.deepEqual(await run(`({ gridOutline: getComputedStyle(document.activeElement).outlineStyle,
      cellOutline: getComputedStyle(document.querySelector(".recap-cell-keyboard")).outlineStyle,
      rounded: parseFloat(getComputedStyle(document.querySelector(".recap-cell-popover")).borderRadius) > 0,
      nativeTitles: document.querySelectorAll(".recap-cell[title]").length })`),
    { gridOutline: "none", cellOutline: "solid", rounded: true, nativeTitles: 0 });
    const target = await run(`(() => { document.querySelector(".recap-cell-keyboard").scrollIntoView({ block: "center" });
      const r = document.querySelector(".recap-cell-keyboard").getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...target });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...target });
    await run("new Promise(resolve => requestAnimationFrame(resolve))");
    assert.equal(await run('getComputedStyle(document.querySelector(".recap-cell-keyboard")).outlineStyle'), "none");
    win.webContents.debugger.detach();

    // Browser layout really clamps scroll when a tall panel is hidden. Capture
    // it before Tabs hide the outgoing panel; a fake DOM cannot prove this.
    await run('ClawdSettingsCore.ops.selectTab("general")');
    await run("new Promise(resolve => requestAnimationFrame(resolve))");
    await run(`
      const root = document.getElementById("content");
      root.innerHTML = "";
      window.subpageScroll = {};
      window.subpageHost = ClawdSettingsCore.helpers.createSubpageHost();
      const fill = (panel, value) => { panel.style.height = value === "tall" ? "2400px" : "20px"; };
      window.subpageTabs = ClawdSettingsCore.helpers.buildTabs({ id: "native-subpage", ariaLabel: "Subpages",
        value: "tall", options: [{ value: "tall", label: "Tall" }, { value: "short", label: "Short" }],
        onBeforeChange(next, previous) { subpageScroll[previous] = root.scrollTop; },
        onChange(value) { subpageHost.render(subpageTabs.panels.get(value), panel => fill(panel, value),
          { scrollTop: subpageScroll[value] || 0 }); } });
      root.appendChild(subpageTabs.element);
      for (const panel of subpageTabs.panels.values()) root.appendChild(panel);
      subpageHost.render(subpageTabs.panels.get("tall"), panel => fill(panel, "tall"));
      root.scrollTop = 500;
      subpageTabs.element.querySelectorAll("button")[1].click();
      subpageTabs.element.querySelectorAll("button")[0].click();
    `);
    await run("new Promise(resolve => requestAnimationFrame(resolve))");
    assert.equal(await run('document.getElementById("content").scrollTop'), 500);
    console.log("PASS: native arrows/Enter/Space/Tab, rerender focus, AX tabs/panels, radio locking and snapshot race");
    console.log("PASS: Recap pending geometry, local commit, rapid-period race, keyboard focus and subpage scroll");
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => { console.error(error.stack || error); app.exit(1); });
