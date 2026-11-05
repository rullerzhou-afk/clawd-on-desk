"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const loader = require("../src/theme-loader");
const initState = require("../src/state");
const { createSettingsController } = require("../src/settings-controller");
const createEffects = require("../src/settings-effect-router");
const id = "codex:aaaaaaaa-1111-4111-8111-111111111111";
const key = "sessionHudHideCanceledCodexEphemeral";

it("real cancellation, settings controller and state projection preserve the default and make hiding reversible", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-canceled-hud-"));
  const controller = createSettingsController({ prefsPath: path.join(dir, "prefs.json") });
  loader.init(path.join(__dirname, "../src"));
  const theme = structuredClone(loader.loadTheme("clawd"));
  theme.timings.minDisplay = {}; theme.timings.autoReturn = {};
  const noop = () => {};
  const ctx = { theme, lang: "en", t: x => x, pendingPermissions: [],
    sessionHudHideCompletedCodexEphemeral: true, sessionHudHideActiveCodexEphemeral: true,
    [key]: controller.get(key), processKill: noop, playSound: noop, sendToRenderer: noop,
    sendToHitWin: noop, syncHitWin: noop, buildContextMenu: noop, buildTrayMenu: noop };
  const state = initState(ctx);
  let emissions = 0, petRefresh = 0;
  const effects = createEffects({ settingsController: controller,
    updateMirrors: changes => Object.assign(ctx, changes),
    emitSessionSnapshot() { emissions++; state.buildSessionSnapshot(); },
    refreshPetPresentation() { petRefresh++; } });
  effects.start();
  t.after(() => { effects.dispose(); state.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });
  const row = () => state.buildSessionSnapshot().sessions.find(x => x.id === id);
  const opts = { agentId: "codex", profileId: "local", codexOriginator: "Codex Desktop",
    codexClientEphemeral: true, hookSource: "codex-official" };
  state.updateSession(id, "thinking", "UserPromptSubmit", opts);
  assert.equal(row().hudHiddenByPreference, true);
  state.updateSession(id, "idle", "Interrupt", opts);
  assert.equal(controller.get(key), false);
  assert.equal(row().hudHiddenByPreference, false, "the existing two preferences do not hide cancellations");
  assert.equal(row().lastEvent.rawEvent, "Interrupt");
  const canonical = structuredClone(state.sessions.get(id));
  const phase = state.resolveDisplayState();

  assert.equal((await controller.applyUpdate(key, true)).status, "ok");
  assert.equal(row().hudHiddenByPreference, true);
  assert.equal(state.buildSessionSnapshot().sessions.length, 1, "Dashboard retains the session");
  assert.deepEqual(state.sessions.get(id), canonical);
  assert.equal(state.resolveDisplayState(), phase);
  assert.equal(petRefresh, 0);
  assert.ok(emissions > 0);
  ctx.pendingPermissions.push({ sessionId: id, agentId: "codex", isCodexUserInputNotify: true, res: null });
  assert.equal(row().hudHiddenByPreference, false);
  ctx.pendingPermissions.length = 0;
  assert.equal(row().hudHiddenByPreference, true);
  assert.equal((await controller.applyUpdate(key, false)).status, "ok");
  assert.equal(row().hudHiddenByPreference, false);
  assert.deepEqual(state.sessions.get(id), canonical);
  assert.equal(createSettingsController({ prefsPath: path.join(dir, "prefs.json") }).get(key), false);
});
