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
  assert.match(code, /sendCommand\("play-index", \{ index \}\)/);
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
  assert.match(code, /playlistOpen = details\.open;/);
});

test("settings-i18n.js: all language packs include music aura player keys", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
  const requiredKeys = [
    "musicAuraPlayerTitle",
    "musicAuraPlaylist",
    "musicAuraPlaylistEmpty",
    "musicAuraPlaylistToggle",
    "musicAuraTrackPosition",
  ];

  for (const key of requiredKeys) {
    const matches = code.match(new RegExp(`\\b${key}\\b`, "g")) || [];
    assert.ok(
      matches.length >= SUPPORTED_LANGS.length,
      `key ${key} should appear >= ${SUPPORTED_LANGS.length} times; found ${matches.length}`
    );
  }
});
