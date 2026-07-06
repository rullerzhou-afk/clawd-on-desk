"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const { SUPPORTED_LANGS } = require("../src/i18n");

function readMusicAuraTab() {
  return fs.readFileSync(path.join(SRC_DIR, "settings-tab-music-aura.js"), "utf8");
}

test("settings-tab-music-aura renders playback as a player card with collapsible playlist", () => {
  const code = readMusicAuraTab();

  assert.match(code, /parent\.appendChild\(buildPlayerCard\(\)\);/);
  assert.match(code, /function buildPlayerCard\(\)/);
  assert.match(code, /className = "music-aura-player-card"/);
  assert.match(code, /className = "music-aura-player-controls"/);
  assert.match(code, /data-command", "previous"/);
  assert.match(code, /data-command", "toggle"/);
  assert.match(code, /data-command", "next"/);
  assert.match(code, /function buildPlaylistPanel\(\)/);
  assert.match(code, /className = "music-aura-playlist-panel"/);
  assert.match(code, /details\.open = playlistOpen;/);
  assert.match(code, /button\.addEventListener\("dblclick", \(\) => sendCommand\("play-index", \{ index \}\)\);/);
  assert.doesNotMatch(code, /button\.addEventListener\("click", \(\) => sendCommand\("play-index"/);
});

test("settings-tab-music-aura keeps playback commands out of the settings-only rows", () => {
  const code = readMusicAuraTab();

  assert.doesNotMatch(code, /function buildPlaybackControlRow\(\)/);
  assert.doesNotMatch(code, /buildPlaybackControlRow\(\)/);
  assert.match(code, /buildVolumeRow\(\)/);
  assert.match(code, /field: "shuffle"/);
});

test("settings-tab-music-aura preserves playlist expanded state across runtime rerenders", () => {
  const code = readMusicAuraTab();

  assert.match(code, /let playlistOpen = false;/);
  assert.match(code, /details\.open = playlistOpen;/);
  assert.match(code, /details\.addEventListener\("toggle", \(\) => \{/);
  assert.match(code, /if \(!details\.isConnected\) return;/);
  assert.match(code, /playlistOpen = details\.open;/);
});

test("settings-tab-music-aura defers runtime rerenders while the particle palette select is active", () => {
  const code = readMusicAuraTab();

  assert.match(code, /function requestRuntimeRender\(\)/);
  assert.match(code, /function shouldDeferRuntimeRender\(\)/);
  assert.match(code, /document\.activeElement/);
  assert.match(code, /\.matches\("\.music-aura-select"\)/);
  assert.match(code, /runtimeRenderDeferred = true;/);
  assert.match(code, /function flushDeferredRuntimeRender\(\)/);
  assert.match(code, /select\.addEventListener\("blur", flushDeferredRuntimeRender\);/);
  assert.match(code, /if \(forceRender\) requestRuntimeRender\(\);/);
  assert.match(code, /onMusicAuraRuntimeChanged[\s\S]*requestRuntimeRender\(\);/);
});

test("settings-tab-music-aura keeps playlist DOM stable during a double-click choice", () => {
  const code = readMusicAuraTab();

  assert.match(code, /function holdRuntimeRenderForDoubleClick\(\)/);
  assert.match(code, /button\.addEventListener\("pointerdown", holdRuntimeRenderForDoubleClick\);/);
  assert.match(code, /runtimeRenderHoldUntil = Math\.max\(runtimeRenderHoldUntil, Date\.now\(\) \+ 650\);/);
});

test("settings-tab-music-aura exposes the aura backplate style selector", () => {
  const code = readMusicAuraTab();

  assert.match(code, /field: "backplateStyle"/);
  assert.match(code, /labelKey: "musicAuraBackplateStyle"/);
  assert.match(code, /descKey: "musicAuraBackplateStyleDesc"/);
  assert.match(code, /\["off", t\("musicAuraBackplateOff"\)\]/);
  assert.match(code, /\["dark", t\("musicAuraBackplateDark"\)\]/);
  assert.match(code, /\["stage", t\("musicAuraBackplateStage"\)\]/);
});

test("settings-tab-music-aura exposes the Mineradio cold-white particle palette", () => {
  const code = readMusicAuraTab();

  assert.match(code, /buildSelectRow\(\{[\s\S]*?field: "particlePalette"/);
  assert.doesNotMatch(code, /buildSegmentRow\(\{[\s\S]{0,120}field: "particlePalette"/);
  assert.match(code, /function buildSelectRow\(\{ field, labelKey, descKey, options \}\)/);
  assert.match(code, /document\.createElement\("select"\)/);
  assert.match(code, /\["mineradio", t\("musicAuraPaletteMineradio"\)\]/);
});

test("settings-i18n.js: all language packs include music aura player keys", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
  const requiredKeys = [
    "musicAuraPlayerTitle",
    "musicAuraPlaylist",
    "musicAuraPlaylistEmpty",
    "musicAuraPlaylistToggle",
    "musicAuraTrackPosition",
    "musicAuraBackplateStyle",
    "musicAuraBackplateStyleDesc",
    "musicAuraBackplateOff",
    "musicAuraBackplateDark",
    "musicAuraBackplateStage",
    "musicAuraPaletteMineradio",
  ];

  for (const key of requiredKeys) {
    const matches = code.match(new RegExp(`\\b${key}\\b`, "g")) || [];
    assert.ok(
      matches.length >= SUPPORTED_LANGS.length,
      `key ${key} should appear >= ${SUPPORTED_LANGS.length} times; found ${matches.length}`
    );
  }
});
