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
    console.log("PASS: native arrows/Enter/Space/Tab, rerender focus, AX tabs/panels, radio locking and snapshot race");
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => { console.error(error.stack || error); app.exit(1); });
