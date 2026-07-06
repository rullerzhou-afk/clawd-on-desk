"use strict";

(function initSettingsTabMusicAura(root) {
  let state = null;
  let helpers = null;
  let ops = null;
  let runtime = null;
  let playlistOpen = false;
  let runtimeRenderDeferred = false;
  let runtimeRenderTimer = null;
  let runtimeRenderHoldUntil = 0;

  function t(key) {
    return helpers.t(key);
  }

  function currentConfig() {
    const cfg = state.snapshot && state.snapshot.musicAura;
    const merged = {
      enabled: false,
      libraryDirs: [],
      volume: 0.55,
      shuffle: true,
      autoStart: false,
      visualEnabled: true,
      visualStyle: "galaxy",
      particlesAlwaysOn: true,
      backgroundAdaptation: "auto",
      particleOpacity: 1.18,
      glowStrength: 1.25,
      pointScale: 0.82,
      particleDensity: 1,
      particlePalette: "default",
      autoViewMode: "standard",
      backplateStyle: "dark",
      auraOffsetX: 0,
      auraOffsetY: 0,
      auraScale: 1,
      auraPlacementByTheme: {},
      intensity: "vivid",
      performance: "auto",
      lowPerformanceProtection: true,
      stateReactive: true,
      miniModeEnabled: true,
      continueWhenHidden: true,
      ...(cfg && typeof cfg === "object" ? cfg : {}),
    };
    if (merged.visualStyle === "hologram") merged.visualStyle = "galaxy";
    return merged;
  }

  function updateConfig(patch) {
    const next = { ...currentConfig(), ...(patch || {}) };
    return window.settingsAPI.update("musicAura", next);
  }

  function getMusicRuntime() {
    return runtime.musicAura || null;
  }

  function shouldDeferRuntimeRender() {
    const active = document.activeElement;
    return !!(
      Date.now() < runtimeRenderHoldUntil
      || (active && typeof active.matches === "function" && active.matches(".music-aura-select"))
    );
  }

  function scheduleDeferredRuntimeRender() {
    if (runtimeRenderTimer) clearTimeout(runtimeRenderTimer);
    const delay = Math.max(80, runtimeRenderHoldUntil - Date.now() + 80);
    runtimeRenderTimer = setTimeout(() => {
      runtimeRenderTimer = null;
      flushDeferredRuntimeRender();
    }, delay);
  }

  function flushDeferredRuntimeRender() {
    if (!runtimeRenderDeferred) return;
    if (shouldDeferRuntimeRender()) {
      scheduleDeferredRuntimeRender();
      return;
    }
    runtimeRenderDeferred = false;
    if (state.activeTab === "music-aura") ops.requestRender({ content: true });
  }

  function requestRuntimeRender() {
    if (state.activeTab !== "music-aura") return;
    if (shouldDeferRuntimeRender()) {
      runtimeRenderDeferred = true;
      scheduleDeferredRuntimeRender();
      return;
    }
    runtimeRenderDeferred = false;
    ops.requestRender({ content: true });
  }

  function holdRuntimeRenderForDoubleClick() {
    runtimeRenderHoldUntil = Math.max(runtimeRenderHoldUntil, Date.now() + 650);
    if (runtimeRenderDeferred) scheduleDeferredRuntimeRender();
  }

  function holdRuntimeRenderForNativeSelect() {
    runtimeRenderHoldUntil = Math.max(runtimeRenderHoldUntil, Date.now() + 1200);
    if (runtimeRenderDeferred) scheduleDeferredRuntimeRender();
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("musicAuraTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("musicAuraSubtitle");
    parent.appendChild(subtitle);

    parent.appendChild(buildHero());
    parent.appendChild(buildPlayerCard());
    parent.appendChild(helpers.buildSection(t("musicAuraSectionMain"), [
      buildButtonSwitchRow({
        field: "enabled",
        labelKey: "musicAuraEnableRow",
        descKey: "musicAuraEnableDesc",
      }),
      buildButtonSwitchRow({
        field: "autoStart",
        labelKey: "musicAuraAutoStart",
        descKey: "musicAuraAutoStartDesc",
      }),
      buildButtonSwitchRow({
        field: "continueWhenHidden",
        labelKey: "musicAuraContinueHidden",
        descKey: "musicAuraContinueHiddenDesc",
      }),
    ]));

    parent.appendChild(helpers.buildSection(t("musicAuraSectionLibrary"), [
      buildLibraryRow(),
      buildDirectoryListRow(),
    ]));

    parent.appendChild(helpers.buildSection(t("musicAuraSectionPlayback"), [
      buildVolumeRow(),
      buildButtonSwitchRow({
        field: "shuffle",
        labelKey: "musicAuraShuffle",
        descKey: "musicAuraShuffleDesc",
      }),
    ]));

    parent.appendChild(helpers.buildSection(t("musicAuraSectionVisual"), [
      buildButtonSwitchRow({
        field: "visualEnabled",
        labelKey: "musicAuraVisualEnabled",
        descKey: "musicAuraVisualEnabledDesc",
      }),
      buildSegmentRow({
        field: "visualStyle",
        labelKey: "musicAuraVisualStyle",
        descKey: "musicAuraVisualStyleDesc",
        options: [
          ["galaxy", t("musicAuraVisualStyleGalaxy")],
          ["vinyl", t("musicAuraVisualStyleVinyl")],
          ["planet", t("musicAuraVisualStylePlanet")],
          ["tunnel", t("musicAuraVisualStyleTunnel")],
          ["aurora", t("musicAuraVisualStyleAurora")],
        ],
      }),
      buildButtonSwitchRow({
        field: "particlesAlwaysOn",
        labelKey: "musicAuraParticlesAlwaysOn",
        descKey: "musicAuraParticlesAlwaysOnDesc",
      }),
      buildSegmentRow({
        field: "backgroundAdaptation",
        labelKey: "musicAuraBackgroundAdaptation",
        descKey: "musicAuraBackgroundAdaptationDesc",
        options: [
          ["auto", t("musicAuraBackgroundAuto")],
          ["dark", t("musicAuraBackgroundDark")],
          ["light", t("musicAuraBackgroundLight")],
          ["contrast", t("musicAuraBackgroundContrast")],
        ],
      }),
      buildSegmentRow({
        field: "backplateStyle",
        labelKey: "musicAuraBackplateStyle",
        descKey: "musicAuraBackplateStyleDesc",
        options: [
          ["off", t("musicAuraBackplateOff")],
          ["dark", t("musicAuraBackplateDark")],
          ["stage", t("musicAuraBackplateStage")],
        ],
      }),
      buildSelectRow({
        field: "particlePalette",
        labelKey: "musicAuraParticlePalette",
        descKey: "musicAuraParticlePaletteDesc",
        options: [
          ["default", t("musicAuraPaletteDefault")],
          ["mineradio", t("musicAuraPaletteMineradio")],
          ["contrast", t("musicAuraPaletteContrast")],
          ["aurora", t("musicAuraPaletteAurora")],
          ["neon", t("musicAuraPaletteNeon")],
          ["warm", t("musicAuraPaletteWarm")],
        ],
      }),
      buildSegmentRow({
        field: "autoViewMode",
        labelKey: "musicAuraAutoViewMode",
        descKey: "musicAuraAutoViewModeDesc",
        options: [
          ["off", t("musicAuraAutoViewOff")],
          ["subtle", t("musicAuraAutoViewSubtle")],
          ["standard", t("musicAuraAutoViewStandard")],
          ["strong", t("musicAuraAutoViewStrong")],
        ],
      }),
      buildRangeRow({
        field: "particleOpacity",
        labelKey: "musicAuraParticleOpacity",
        descKey: "musicAuraParticleOpacityDesc",
        min: 20,
        max: 180,
        step: 5,
        multiplier: 100,
        fallback: 1.18,
        format: (value) => `${Math.round(value * 100)}%`,
      }),
      buildRangeRow({
        field: "glowStrength",
        labelKey: "musicAuraGlowStrength",
        descKey: "musicAuraGlowStrengthDesc",
        min: 0,
        max: 180,
        step: 5,
        multiplier: 100,
        fallback: 1.25,
        format: (value) => `${Math.round(value * 100)}%`,
      }),
      buildRangeRow({
        field: "pointScale",
        labelKey: "musicAuraPointScale",
        descKey: "musicAuraPointScaleDesc",
        min: 45,
        max: 140,
        step: 5,
        multiplier: 100,
        fallback: 0.82,
        format: (value) => `${Math.round(value * 100)}%`,
      }),
      buildRangeRow({
        field: "particleDensity",
        labelKey: "musicAuraParticleDensity",
        descKey: "musicAuraParticleDensityDesc",
        min: 45,
        max: 150,
        step: 5,
        multiplier: 100,
        fallback: 1,
        format: (value) => `${Math.round(value * 100)}%`,
      }),
      buildThemePlacementRangeRow({
        field: "offsetX",
        labelKey: "musicAuraAuraOffsetX",
        descKey: "musicAuraAuraOffsetXDesc",
        min: -35,
        max: 35,
        step: 1,
        multiplier: 100,
        fallback: 0,
        format: (value) => `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`,
      }),
      buildThemePlacementRangeRow({
        field: "offsetY",
        labelKey: "musicAuraAuraOffsetY",
        descKey: "musicAuraAuraOffsetYDesc",
        min: -35,
        max: 35,
        step: 1,
        multiplier: 100,
        fallback: 0,
        format: (value) => `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`,
      }),
      buildThemePlacementRangeRow({
        field: "scale",
        labelKey: "musicAuraAuraScale",
        descKey: "musicAuraAuraScaleDesc",
        min: 70,
        max: 135,
        step: 1,
        multiplier: 100,
        fallback: 1,
        format: (value) => `${Math.round(value * 100)}%`,
      }),
      buildThemePlacementResetRow(),
      buildSegmentRow({
        field: "intensity",
        labelKey: "musicAuraIntensity",
        descKey: "musicAuraIntensityDesc",
        options: [
          ["subtle", t("musicAuraIntensitySubtle")],
          ["vivid", t("musicAuraIntensityVivid")],
          ["stage", t("musicAuraIntensityStage")],
        ],
      }),
      buildSegmentRow({
        field: "performance",
        labelKey: "musicAuraPerformance",
        descKey: "musicAuraPerformanceDesc",
        options: [
          ["eco", t("musicAuraPerformanceEco")],
          ["auto", t("musicAuraPerformanceAuto")],
          ["high", t("musicAuraPerformanceHigh")],
        ],
      }),
      buildButtonSwitchRow({
        field: "stateReactive",
        labelKey: "musicAuraStateReactive",
        descKey: "musicAuraStateReactiveDesc",
      }),
      buildButtonSwitchRow({
        field: "lowPerformanceProtection",
        labelKey: "musicAuraLowPerformanceProtection",
        descKey: "musicAuraLowPerformanceProtectionDesc",
      }),
      buildButtonSwitchRow({
        field: "miniModeEnabled",
        labelKey: "musicAuraMiniMode",
        descKey: "musicAuraMiniModeDesc",
      }),
    ]));

    fetchRuntime({ forceRender: !runtime.musicAura });
  }

  function buildHero() {
    const cfg = currentConfig();
    const info = getMusicRuntime();
    const status = info && info.status ? info.status : {};
    const library = info && info.library ? info.library : {};
    const card = document.createElement("div");
    card.className = "music-aura-hero";
    card.innerHTML =
      `<div class="music-aura-orb" aria-hidden="true"><span></span><span></span><span></span></div>` +
      `<div class="music-aura-hero-copy">` +
        `<div class="music-aura-kicker">${helpers.escapeHtml(t("musicAuraKicker"))}</div>` +
        `<div class="music-aura-track">${helpers.escapeHtml(status.track && status.track.title ? status.track.title : t("musicAuraNoTrack"))}</div>` +
        `<div class="music-aura-meta">${helpers.escapeHtml(formatHeroMeta(cfg, library, status))}</div>` +
      `</div>`;
    return card;
  }

  function formatHeroMeta(cfg, library, status) {
    const count = Number(library.count) || 0;
    const playing = status.playing ? t("musicAuraStatusPlaying") : t("musicAuraStatusPaused");
    const mode = cfg.enabled ? t("musicAuraStatusOn") : t("musicAuraStatusOff");
    const visual = formatVisualMeta(status.visual);
    return `${mode} · ${playing} · ${t("musicAuraTrackCount").replace("{count}", count)}${visual ? " · " + visual : ""}`;
  }

  function formatVisualMeta(visual) {
    if (!visual || typeof visual !== "object") return "";
    if (visual.error) return `Visual error: ${visual.error}`;
    const mode = visual.visible ? "Visual active" : (visual.active ? "Visual waiting" : "Visual off");
    const webgl = visual.webglReady ? "WebGL ready" : "WebGL pending";
    const count = Number(visual.particleCount) || 0;
    return `${mode} / ${webgl} / ${count} particles`;
  }

  function buildButtonSwitchRow({ field, labelKey, descKey }) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
    row.querySelector(".row-label").textContent = t(labelKey);
    row.querySelector(".row-desc").textContent = t(descKey);
    const sw = row.querySelector(".switch");
    const renderSwitch = () => helpers.setSwitchVisual(sw, currentConfig()[field] !== false);
    renderSwitch();
    const toggle = () => {
      if (sw.classList.contains("pending")) return;
      const nextValue = !(currentConfig()[field] !== false);
      helpers.setSwitchVisual(sw, nextValue, { pending: true });
      updateConfig({ [field]: nextValue }).then((result) => {
        sw.classList.remove("pending");
        if (!result || result.status !== "ok") {
          ops.showToast(t("toastSaveFailed") + ((result && result.message) || "unknown error"), { error: true });
          renderSwitch();
        }
      }).catch((err) => {
        sw.classList.remove("pending");
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
        renderSwitch();
      });
    };
    sw.addEventListener("click", toggle);
    sw.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        toggle();
      }
    });
    return row;
  }

  function buildLibraryRow() {
    const row = document.createElement("div");
    row.className = "row music-aura-library-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control music-aura-actions">` +
        `<button type="button" class="soft-btn"></button>` +
        `<button type="button" class="soft-btn accent"></button>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("musicAuraLibrary");
    row.querySelector(".row-desc").textContent = libraryDesc();
    const buttons = row.querySelectorAll("button");
    buttons[0].textContent = t("musicAuraRescan");
    buttons[1].textContent = t("musicAuraAddDirectory");
    buttons[0].addEventListener("click", () => {
      buttons[0].disabled = true;
      window.settingsAPI.scanMusicAuraLibrary()
        .then((result) => {
          if (!result || result.status !== "ok") throw new Error((result && result.message) || "scan failed");
          fetchRuntime({ forceRender: true });
        })
        .catch((err) => ops.showToast(t("musicAuraScanFailed") + (err && err.message ? ": " + err.message : ""), { error: true }))
        .finally(() => { buttons[0].disabled = false; });
    });
    buttons[1].addEventListener("click", () => {
      buttons[1].disabled = true;
      window.settingsAPI.chooseMusicAuraDirectory()
        .then((result) => {
          if (!result || result.status !== "ok" || result.canceled || !result.dir) return;
          const cfg = currentConfig();
          const dirs = Array.isArray(cfg.libraryDirs) ? cfg.libraryDirs.slice() : [];
          if (!dirs.includes(result.dir)) dirs.push(result.dir);
          return updateConfig({ libraryDirs: dirs });
        })
        .catch((err) => ops.showToast(t("musicAuraAddDirFailed") + (err && err.message ? ": " + err.message : ""), { error: true }))
        .finally(() => { buttons[1].disabled = false; });
    });
    return row;
  }

  function libraryDesc() {
    const info = getMusicRuntime();
    const library = info && info.library ? info.library : {};
    const count = Number(library.count) || 0;
    const missing = Array.isArray(library.missingDirs) ? library.missingDirs.length : 0;
    let text = t("musicAuraLibraryDesc").replace("{count}", count);
    if (missing > 0) text += " " + t("musicAuraMissingDirs").replace("{count}", missing);
    if (library.truncated) text += " " + t("musicAuraLibraryTruncated");
    return text;
  }

  function buildDirectoryListRow() {
    const cfg = currentConfig();
    const row = document.createElement("div");
    row.className = "row music-aura-dir-row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("musicAuraDirectories");
    text.appendChild(label);
    const list = document.createElement("div");
    list.className = "music-aura-dir-list";
    if (!cfg.libraryDirs.length) {
      const empty = document.createElement("span");
      empty.className = "row-desc";
      empty.textContent = t("musicAuraNoDirectories");
      list.appendChild(empty);
    } else {
      for (const dir of cfg.libraryDirs) {
        const item = document.createElement("div");
        item.className = "music-aura-dir-item";
        const name = document.createElement("span");
        name.textContent = dir;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "soft-btn";
        remove.textContent = t("musicAuraRemove");
        remove.addEventListener("click", () => {
          updateConfig({ libraryDirs: cfg.libraryDirs.filter((item) => item !== dir) });
        });
        item.appendChild(name);
        item.appendChild(remove);
        list.appendChild(item);
      }
    }
    text.appendChild(list);
    row.appendChild(text);
    return row;
  }

  function buildPlayerCard() {
    const cfg = currentConfig();
    const info = getMusicRuntime();
    const status = info && info.status ? info.status : {};
    const library = info && info.library ? info.library : {};
    const tracks = Array.isArray(library.tracks) ? library.tracks : [];
    const count = Number(library.count) || tracks.length;
    const current = Number.isFinite(status.trackIndex) && status.trackIndex >= 0 ? status.trackIndex + 1 : 0;
    const card = document.createElement("div");
    card.className = "music-aura-player-card";

    const main = document.createElement("div");
    main.className = "music-aura-player-main";
    const title = document.createElement("div");
    title.className = "music-aura-player-title";
    title.textContent = t("musicAuraPlayerTitle");
    const track = document.createElement("div");
    track.className = "music-aura-player-track";
    track.textContent = status.track && status.track.title
      ? status.track.title
      : t("musicAuraNoTrack");
    const meta = document.createElement("div");
    meta.className = "music-aura-player-meta";
    meta.textContent = `${status.playing ? t("musicAuraStatusPlaying") : t("musicAuraStatusPaused")} · ${formatTrackPosition(current, count)}`;
    main.appendChild(title);
    main.appendChild(track);
    main.appendChild(meta);

    const controls = document.createElement("div");
    controls.className = "music-aura-player-controls";
    const disabled = !cfg.enabled || count <= 0;
    const previousButton = buildPlayerButton(t("musicAuraPreviousShort"), disabled);
    previousButton.setAttribute("data-command", "previous");
    previousButton.addEventListener("click", () => sendCommand("previous"));
    const toggleButton = buildPlayerButton(status.playing ? t("musicAuraPause") : t("musicAuraPlay"), disabled, true);
    toggleButton.setAttribute("data-command", "toggle");
    toggleButton.addEventListener("click", () => sendCommand("toggle"));
    const nextButton = buildPlayerButton(t("musicAuraNextShort"), disabled);
    nextButton.setAttribute("data-command", "next");
    nextButton.addEventListener("click", () => sendCommand("next"));
    controls.appendChild(previousButton);
    controls.appendChild(toggleButton);
    controls.appendChild(nextButton);

    card.appendChild(main);
    card.appendChild(controls);
    card.appendChild(buildPlaylistPanel());
    return card;
  }

  function buildPlayerButton(label, disabled, accent = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = accent ? "music-aura-player-btn accent" : "music-aura-player-btn";
    button.textContent = label;
    button.disabled = disabled;
    return button;
  }

  function buildPlaylistPanel() {
    const cfg = currentConfig();
    const info = getMusicRuntime();
    const status = info && info.status ? info.status : {};
    const library = info && info.library ? info.library : {};
    const tracks = Array.isArray(library.tracks) ? library.tracks : [];
    const details = document.createElement("details");
    details.className = "music-aura-playlist-panel";
    details.open = playlistOpen;
    details.addEventListener("toggle", () => {
      if (!details.isConnected) return;
      playlistOpen = details.open;
    });

    const summary = document.createElement("summary");
    summary.textContent = `${t("musicAuraPlaylistToggle")} · ${t("musicAuraTrackCount").replace("{count}", tracks.length)}`;
    details.appendChild(summary);

    if (!tracks.length) {
      const empty = document.createElement("div");
      empty.className = "music-aura-playlist-empty";
      empty.textContent = t("musicAuraPlaylistEmpty");
      details.appendChild(empty);
      return details;
    }

    const list = document.createElement("div");
    list.className = "music-aura-playlist";
    tracks.forEach((item, fallbackIndex) => {
      const index = Number.isFinite(item && item.index) ? item.index : fallbackIndex;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-aura-playlist-item";
      if (status.trackIndex === index) button.classList.add("active");
      button.disabled = !cfg.enabled;
      button.textContent = item && (item.title || item.fileName) ? (item.title || item.fileName) : `${t("musicAuraPlaylist")} ${index + 1}`;
      button.addEventListener("pointerdown", holdRuntimeRenderForDoubleClick);
      button.addEventListener("dblclick", () => sendCommand("play-index", { index }));
      list.appendChild(button);
    });
    details.appendChild(list);
    return details;
  }

  function formatTrackPosition(current, count) {
    return t("musicAuraTrackPosition")
      .replace("{current}", current > 0 ? String(current) : "-")
      .replace("{count}", String(count || 0));
  }

  function buildVolumeRow() {
    const cfg = currentConfig();
    const row = document.createElement("div");
    row.className = "row music-aura-volume-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control music-aura-volume-control">` +
        `<input type="range" min="0" max="100" step="1" />` +
        `<span></span>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("musicAuraVolume");
    row.querySelector(".row-desc").textContent = t("musicAuraVolumeDesc");
    const input = row.querySelector("input");
    const value = row.querySelector(".music-aura-volume-control span");
    input.value = String(Math.round((Number(cfg.volume) || 0) * 100));
    value.textContent = `${input.value}%`;
    let timer = null;
    input.addEventListener("input", () => {
      value.textContent = `${input.value}%`;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        updateConfig({ volume: Math.max(0, Math.min(1, Number(input.value) / 100)) });
      }, 250);
    });
    return row;
  }

  function buildRangeRow({ field, labelKey, descKey, min, max, step, multiplier, fallback, format }) {
    const cfg = currentConfig();
    const row = document.createElement("div");
    row.className = "row music-aura-volume-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control music-aura-volume-control">` +
        `<input type="range" />` +
        `<span></span>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t(labelKey);
    row.querySelector(".row-desc").textContent = t(descKey);
    const input = row.querySelector("input");
    const value = row.querySelector(".music-aura-volume-control span");
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const current = Number.isFinite(Number(cfg[field])) ? Number(cfg[field]) : fallback;
    input.value = String(Math.round(current * multiplier));
    value.textContent = format(current);
    let timer = null;
    input.addEventListener("input", () => {
      const nextValue = Math.max(min, Math.min(max, Number(input.value))) / multiplier;
      value.textContent = format(nextValue);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        updateConfig({ [field]: nextValue });
      }, 180);
    });
    return row;
  }

  function activeThemeId() {
    const themeId = state.snapshot && typeof state.snapshot.theme === "string" && state.snapshot.theme
      ? state.snapshot.theme
      : "clawd";
    return themeId;
  }

  function currentThemePlacement() {
    const cfg = currentConfig();
    const themeId = activeThemeId();
    const byTheme = cfg.auraPlacementByTheme && typeof cfg.auraPlacementByTheme === "object"
      ? cfg.auraPlacementByTheme
      : {};
    const placement = byTheme[themeId] && typeof byTheme[themeId] === "object"
      ? byTheme[themeId]
      : {};
    return {
      offsetX: Number.isFinite(Number(placement.offsetX)) ? Number(placement.offsetX) : 0,
      offsetY: Number.isFinite(Number(placement.offsetY)) ? Number(placement.offsetY) : 0,
      scale: Number.isFinite(Number(placement.scale)) ? Number(placement.scale) : 1,
    };
  }

  function updateThemePlacement(patch) {
    const cfg = currentConfig();
    const themeId = activeThemeId();
    const byTheme = cfg.auraPlacementByTheme && typeof cfg.auraPlacementByTheme === "object"
      ? { ...cfg.auraPlacementByTheme }
      : {};
    byTheme[themeId] = { ...currentThemePlacement(), ...(patch || {}) };
    return updateConfig({ auraPlacementByTheme: byTheme });
  }

  function buildThemePlacementRangeRow({ field, labelKey, descKey, min, max, step, multiplier, fallback, format }) {
    const placement = currentThemePlacement();
    const row = document.createElement("div");
    row.className = "row music-aura-volume-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control music-aura-volume-control">` +
        `<input type="range" />` +
        `<span></span>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t(labelKey);
    row.querySelector(".row-desc").textContent = t(descKey).replace("{theme}", activeThemeId());
    const input = row.querySelector("input");
    const value = row.querySelector(".music-aura-volume-control span");
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const current = Number.isFinite(Number(placement[field])) ? Number(placement[field]) : fallback;
    input.value = String(Math.round(current * multiplier));
    value.textContent = format(current);
    let timer = null;
    input.addEventListener("input", () => {
      const nextValue = Math.max(min, Math.min(max, Number(input.value))) / multiplier;
      value.textContent = format(nextValue);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        updateThemePlacement({ [field]: nextValue });
      }, 180);
    });
    return row;
  }

  function buildThemePlacementResetRow() {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"><button type="button" class="soft-btn"></button></div>`;
    row.querySelector(".row-label").textContent = t("musicAuraAuraReset");
    row.querySelector(".row-desc").textContent = t("musicAuraAuraResetDesc").replace("{theme}", activeThemeId());
    const button = row.querySelector("button");
    button.textContent = t("musicAuraResetCurrentTheme");
    button.addEventListener("click", () => {
      const cfg = currentConfig();
      const themeId = activeThemeId();
      const byTheme = cfg.auraPlacementByTheme && typeof cfg.auraPlacementByTheme === "object"
        ? { ...cfg.auraPlacementByTheme }
        : {};
      delete byTheme[themeId];
      updateConfig({ auraPlacementByTheme: byTheme });
    });
    return row;
  }

  function buildSegmentRow({ field, labelKey, descKey, options }) {
    const cfg = currentConfig();
    const row = document.createElement("div");
    row.className = "row music-aura-segment-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"><div class="music-aura-segment"></div></div>`;
    row.querySelector(".row-label").textContent = t(labelKey);
    row.querySelector(".row-desc").textContent = t(descKey);
    const group = row.querySelector(".music-aura-segment");
    for (const [value, label] of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-aura-segment-btn";
      if (cfg[field] === value) button.classList.add("active");
      button.textContent = label;
      button.addEventListener("click", () => updateConfig({ [field]: value }));
      group.appendChild(button);
    }
    return row;
  }

  function buildSelectRow({ field, labelKey, descKey, options }) {
    const cfg = currentConfig();
    const row = document.createElement("div");
    row.className = "row music-aura-select-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"></div>`;
    row.querySelector(".row-label").textContent = t(labelKey);
    row.querySelector(".row-desc").textContent = t(descKey);
    const select = document.createElement("select");
    select.className = "music-aura-select";
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = options.some(([value]) => value === cfg[field]) ? cfg[field] : options[0][0];
    select.addEventListener("pointerdown", holdRuntimeRenderForNativeSelect);
    select.addEventListener("focus", holdRuntimeRenderForNativeSelect);
    select.addEventListener("blur", flushDeferredRuntimeRender);
    select.addEventListener("change", () => updateConfig({ [field]: select.value }));
    row.querySelector(".row-control").appendChild(select);
    return row;
  }

  function sendCommand(command, payload = {}) {
    if (!window.settingsAPI || typeof window.settingsAPI.sendMusicAuraCommand !== "function") return;
    window.settingsAPI.sendMusicAuraCommand({ command, payload }).catch((err) => {
      ops.showToast(t("musicAuraCommandFailed") + (err && err.message ? ": " + err.message : ""), { error: true });
    });
  }

  function fetchRuntime({ forceRender = false } = {}) {
    if (!window.settingsAPI || typeof window.settingsAPI.getMusicAuraRuntime !== "function") return;
    window.settingsAPI.getMusicAuraRuntime().then((result) => {
      if (!result || result.status !== "ok") return;
      runtime.musicAura = result.runtime || null;
      if (forceRender) requestRuntimeRender();
    }).catch(() => {});
  }

  function patchInPlace(changes) {
    if (!changes) return false;
    if ("musicAura" in changes) {
      fetchRuntime({ forceRender: true });
      return true;
    }
    return false;
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    runtime = core.runtime;
    if (window.settingsAPI && typeof window.settingsAPI.onMusicAuraRuntimeChanged === "function") {
      window.settingsAPI.onMusicAuraRuntimeChanged((payload) => {
        runtime.musicAura = payload || null;
        requestRuntimeRender();
      });
    }
    core.tabs["music-aura"] = { render, patchInPlace };
  }

  root.ClawdSettingsTabMusicAura = { init };
})(globalThis);
