"use strict";

(function initSettingsTabTheme(root) {
  const PREVIEW_TARGET_CONTENT_RATIO = 0.55;

  let state = null;
  let runtime = null;
  let helpers = null;
  let ops = null;
  let readers = null;
  let customizingThemeId = null;
  let customizationSelectionPendingThemeId = null;
  let customizationSelectionSeq = 0;
  let mountedCustomizationControls = null;
  let themeListScrollTop = 0;
  let customizationReturnFocusKey = "";

  function getContentElement() {
    return document.getElementById("content");
  }

  function stabilizeCustomizationView({ themeId = null, scrollTop, focusKey }) {
    const apply = () => {
      if (state.activeTab !== "theme") return;
      if (themeId ? customizingThemeId !== themeId : customizingThemeId !== null) return;
      const content = getContentElement();
      if (content) content.scrollTop = scrollTop;
      ops.focusSettingsTarget(content, focusKey);
    };
    apply();
    if (root && typeof root.requestAnimationFrame === "function") root.requestAnimationFrame(apply);
  }

  function enterThemeCustomization(themeId) {
    customizingThemeId = themeId;
    ops.requestRender({ content: true });
    stabilizeCustomizationView({
      themeId,
      scrollTop: 0,
      focusKey: "theme-customization-back",
    });
  }

  function t(key) {
    return helpers.t(key);
  }

  function render(parent) {
    mountedCustomizationControls = null;
    const detailTheme = Array.isArray(runtime.themeList)
      ? runtime.themeList.find((theme) => (
        theme
        && theme.id === customizingThemeId
        && theme.active
        && supportsThemeCustomization(theme)
      ))
      : null;
    if (detailTheme) {
      renderThemeDetail(parent, detailTheme);
      return;
    }
    customizingThemeId = null;

    const h1 = document.createElement("h1");
    h1.textContent = t("themeTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("themeSubtitle");
    parent.appendChild(subtitle);
    parent.appendChild(buildThemeActions());

    if (runtime.themeList === null) {
      const loading = document.createElement("div");
      loading.className = "placeholder-desc";
      parent.appendChild(loading);
      ops.fetchThemes().then(() => {
        if (state.activeTab === "theme") ops.requestRender({ content: true });
      });
      return;
    }

    if (runtime.themeList.length === 0) {
      const empty = document.createElement("div");
      empty.className = "placeholder";
      empty.innerHTML = `<div class="placeholder-desc">${helpers.escapeHtml(t("themeEmpty"))}</div>`;
      parent.appendChild(empty);
      return;
    }

    for (const section of getThemeSections(runtime.themeList)) {
      const sectionEl = document.createElement("section");
      sectionEl.className = "theme-section";
      sectionEl.setAttribute("aria-labelledby", `theme-section-${section.id}`);

      const title = document.createElement("h2");
      title.id = `theme-section-${section.id}`;
      title.className = "theme-section-title";
      title.textContent = section.title;
      sectionEl.appendChild(title);

      const grid = document.createElement("div");
      grid.className = "theme-grid";
      for (const theme of section.themes) {
        grid.appendChild(buildThemeCard(theme));
      }
      sectionEl.appendChild(grid);
      parent.appendChild(sectionEl);
    }
  }

  function getThemeSections(themes) {
    const groups = {
      builtin: [],
      importedCodexPets: [],
      user: [],
    };
    for (const theme of themes || []) {
      if (theme && theme.builtin) groups.builtin.push(theme);
      else if (theme && theme.managedCodexPet) groups.importedCodexPets.push(theme);
      else groups.user.push(theme);
    }
    return [
      { id: "builtin", title: t("themeGroupBuiltIn"), themes: groups.builtin },
      { id: "imported-codex-pets", title: t("themeGroupImportedCodexPets"), themes: groups.importedCodexPets },
      { id: "user", title: t("themeGroupUserThemes"), themes: groups.user },
    ].filter((section) => section.themes.length > 0);
  }

  function localizeField(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "object") {
      const lang = readers.getLang();
      if (value[lang]) return value[lang];
      if (value.en) return value.en;
      if (value.zh) return value.zh;
      const firstKey = Object.keys(value)[0];
      if (firstKey) return value[firstKey];
    }
    return "";
  }

  function applyThemePreviewScale(el, contentRatio) {
    if (!Number.isFinite(contentRatio) || contentRatio <= 0) return;
    if (contentRatio <= PREVIEW_TARGET_CONTENT_RATIO) return;
    const scale = PREVIEW_TARGET_CONTENT_RATIO / contentRatio;
    const pct = `${(scale * 100).toFixed(2)}%`;
    el.style.maxWidth = pct;
    el.style.maxHeight = pct;
  }

  function applyThemePreviewOffset(el, offsetPct) {
    if (!offsetPct) return;
    const { x, y } = offsetPct;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;
    el.style.transform = `translate(${x.toFixed(2)}%, ${y.toFixed(2)}%)`;
  }

  function getCodexPetPreviewAtlasUrl(theme) {
    return theme
      && theme.codexPet
      && typeof theme.codexPet.previewAtlasUrl === "string"
      && theme.codexPet.previewAtlasUrl;
  }

  function buildCodexPetAtlasPreview(theme) {
    const frame = document.createElement("span");
    frame.className = "theme-thumb-atlas-frame";
    applyThemePreviewScale(frame, theme.previewContentRatio);
    applyThemePreviewOffset(frame, theme.previewContentOffsetPct);

    const img = document.createElement("img");
    img.src = getCodexPetPreviewAtlasUrl(theme);
    img.alt = "";
    img.draggable = false;
    const columns = Number.isInteger(theme.codexPet.atlasColumns)
      && theme.codexPet.atlasColumns >= 1
      && theme.codexPet.atlasColumns <= 64
      ? theme.codexPet.atlasColumns
      : 8;
    const rows = Number.isInteger(theme.codexPet.atlasRows)
      && theme.codexPet.atlasRows >= 1
      && theme.codexPet.atlasRows <= 64
      ? theme.codexPet.atlasRows
      : 9;
    img.style.width = `${columns * 100}%`;
    img.style.height = `${rows * 100}%`;
    frame.appendChild(img);
    return frame;
  }

  function buildThemePreviewMedia(theme) {
    if (theme.managedCodexPet && getCodexPetPreviewAtlasUrl(theme)) {
      return buildCodexPetAtlasPreview(theme);
    }
    const img = document.createElement("img");
    img.src = theme.previewFileUrl;
    img.alt = "";
    img.draggable = false;
    applyThemePreviewScale(img, theme.previewContentRatio);
    applyThemePreviewOffset(img, theme.previewContentOffsetPct);
    return img;
  }

  function getThemeCapabilityBadgeLabels(theme) {
    const caps = theme && theme.capabilities;
    if (!caps || typeof caps !== "object") return [];
    const badges = [];
    if (caps.idleMode === "tracked") badges.push(t("themeCapabilityTracked"));
    else if (caps.idleMode === "animated") badges.push(t("themeCapabilityAnimated"));
    else if (caps.idleMode === "static") badges.push(t("themeCapabilityStatic"));
    if (caps.miniMode) badges.push(t("themeCapabilityMini"));
    if (caps.sleepMode === "direct") badges.push(t("themeCapabilityDirectSleep"));
    if (caps.powerProfile === "scripted") badges.push(t("themeCapabilityFineMotion"));
    if (caps.reactions === false) badges.push(t("themeCapabilityNoReactions"));
    return badges;
  }

  function supportsThemeCustomization(theme) {
    const caps = theme && theme.capabilities;
    return !!(caps && (
      caps.petTint === true
      || caps.accessories === true
      || caps.mouthAccessories === true
    ));
  }

  function mirrorThemeSelectionResult(themeId, result) {
    if (!Array.isArray(runtime.themeList)) return null;
    const runtimeCapabilities = (
      result
      && result.customizationCapabilities
      && typeof result.customizationCapabilities === "object"
      && !Array.isArray(result.customizationCapabilities)
    )
      ? result.customizationCapabilities
      : null;
    runtime.themeList = runtime.themeList.map((entry) => (
      entry
        ? {
            ...entry,
            active: entry.id === themeId,
            capabilities: entry.id === themeId && runtimeCapabilities
              ? { ...(entry.capabilities || {}), ...runtimeCapabilities }
              : entry.capabilities,
          }
        : entry
    ));
    return runtime.themeList.find((entry) => entry && entry.id === themeId) || null;
  }

  function openThemeCustomization(theme) {
    if (!theme || !supportsThemeCustomization(theme)) return;
    const content = getContentElement();
    themeListScrollTop = content && Number.isFinite(content.scrollTop) ? content.scrollTop : 0;
    customizationReturnFocusKey = `theme-customize:${theme.id}`;
    if (theme.active) {
      enterThemeCustomization(theme.id);
      return;
    }
    if (customizationSelectionPendingThemeId) return;

    const requestSeq = ++customizationSelectionSeq;
    customizationSelectionPendingThemeId = theme.id;
    ops.requestRender({ content: true });
    Promise.resolve(window.settingsAPI.command("setThemeSelection", { themeId: theme.id }))
      .then((result) => {
        if (requestSeq !== customizationSelectionSeq) return;
        if (!result || result.status !== "ok") {
          const message = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + message, { error: true });
          return;
        }
        // The controller has already activated and committed this theme before
        // returning ok. Mirror that acknowledged result into the renderer's
        // metadata cache so opening the detail does not depend on a second IPC
        // fetch that can fail independently.
        const activeEntry = mirrorThemeSelectionResult(theme.id, result);
        customizingThemeId = supportsThemeCustomization(activeEntry) ? theme.id : null;
      })
      .catch((err) => {
        if (requestSeq !== customizationSelectionSeq) return;
        const message = (err && err.message) || "unknown error";
        ops.showToast(t("toastSaveFailed") + message, { error: true });
      })
      .finally(() => {
        if (requestSeq !== customizationSelectionSeq) return;
        customizationSelectionPendingThemeId = null;
        if (state.activeTab === "theme") {
          if (customizingThemeId === theme.id) enterThemeCustomization(theme.id);
          else ops.requestRender({ content: true });
        }
      });
  }

  function closeThemeCustomization() {
    customizingThemeId = null;
    mountedCustomizationControls = null;
    ops.requestRender({ content: true });
    stabilizeCustomizationView({
      scrollTop: themeListScrollTop,
      focusKey: customizationReturnFocusKey,
    });
  }

  function renderThemeDetail(parent, theme) {
    mountedCustomizationControls = {
      themeId: theme.id,
      petTint: null,
      petAccessory: null,
      petMouthAccessory: null,
      holidayAccessoryEnabled: null,
    };
    const back = document.createElement("button");
    back.type = "button";
    back.className = "theme-detail-back";
    back.setAttribute("data-settings-focus-key", "theme-customization-back");
    back.textContent = `\u2039 ${t("themeBackToPets")}`;
    back.addEventListener("click", closeThemeCustomization);
    parent.appendChild(back);

    const hero = document.createElement("div");
    hero.className = "theme-detail-hero";
    const preview = document.createElement("div");
    preview.className = "theme-thumb theme-detail-preview";
    if (theme.previewFileUrl || getCodexPetPreviewAtlasUrl(theme)) {
      preview.appendChild(buildThemePreviewMedia(theme));
    } else {
      const glyph = document.createElement("span");
      glyph.className = "theme-thumb-empty";
      glyph.textContent = t("themeThumbMissing");
      preview.appendChild(glyph);
    }
    hero.appendChild(preview);

    const heading = document.createElement("div");
    heading.className = "theme-detail-heading";
    const h1 = document.createElement("h1");
    h1.textContent = localizeField(theme.name) || theme.id;
    heading.appendChild(h1);
    const current = document.createElement("div");
    current.className = "theme-detail-current";
    current.textContent = t("themeActiveIndicator");
    heading.appendChild(current);
    hero.appendChild(heading);
    parent.appendChild(hero);

    const section = document.createElement("section");
    section.className = "section theme-detail-section";
    const title = document.createElement("h2");
    title.textContent = t("themeAppearanceTitle");
    section.appendChild(title);
    const caps = theme.capabilities || {};
    if (caps.petTint === true) section.appendChild(buildThemeTintRow(theme));
    if (caps.accessories === true) section.appendChild(buildThemeAccessoryRow(theme));
    if (caps.mouthAccessories === true) section.appendChild(buildThemeMouthAccessoryRow(theme));
    if (caps.accessories === true) section.appendChild(buildHolidayAccessoryRow(theme));
    parent.appendChild(section);
  }

  function getTintOptions() {
    return Array.isArray(runtime.petTintOptions)
      ? runtime.petTintOptions.filter((entry) => (
        entry
        && typeof entry.id === "string"
        && /^[a-z][a-z0-9-]{0,31}$/.test(entry.id)
        && typeof entry.labelKey === "string"
        && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(entry.labelKey)
      ))
      : [];
  }

  function getThemeTintId(themeId, options) {
    const selections = state.snapshot && state.snapshot.petTint;
    const value = typeof selections === "string"
      ? selections
      : (selections && typeof selections === "object" ? selections[themeId] : null);
    return options.some((entry) => entry.id === value) ? value : "none";
  }

  function getAccessoryOptions() {
    return Array.isArray(runtime.petAccessoryOptions)
      ? runtime.petAccessoryOptions.filter((entry) => (
        entry
        && typeof entry.id === "string"
        && /^[a-z][a-z0-9-]{0,31}$/.test(entry.id)
        && typeof entry.labelKey === "string"
        && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(entry.labelKey)
      ))
      : [];
  }

  function getThemeAccessoryId(themeId, options) {
    const selections = state.snapshot && state.snapshot.petAccessory;
    const value = selections && typeof selections === "object" && !Array.isArray(selections)
      ? selections[themeId]
      : null;
    return options.some((entry) => entry.id === value) ? value : "none";
  }

  function getMouthAccessoryOptions() {
    return Array.isArray(runtime.petMouthAccessoryOptions)
      ? runtime.petMouthAccessoryOptions.filter((entry) => (
        entry
        && typeof entry.id === "string"
        && /^[a-z][a-z0-9-]{0,31}$/.test(entry.id)
        && typeof entry.labelKey === "string"
        && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(entry.labelKey)
      ))
      : [];
  }

  function getThemeMouthAccessoryId(themeId, options) {
    const selections = state.snapshot && state.snapshot.petMouthAccessory;
    const value = selections && typeof selections === "object" && !Array.isArray(selections)
      ? selections[themeId]
      : null;
    return options.some((entry) => entry.id === value) ? value : "none";
  }

  function buildThemeTintRow(theme) {
    const row = document.createElement("div");
    row.className = "row theme-customization-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowPetColor");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("themePetColorDesc");
    text.appendChild(label);
    text.appendChild(desc);

    const control = document.createElement("div");
    control.className = "row-control";
    const options = getTintOptions();
    const pickerOptions = options.length > 0
      ? options.map((entry) => ({ value: entry.id, label: t(entry.labelKey) }))
      : [{ value: "none", label: t("tintNone") }];
    const picker = helpers.buildSettingsSelect({
      value: getThemeTintId(theme.id, options),
      options: pickerOptions,
      ariaLabel: t("rowPetColor"),
      className: "pet-tint-select",
      viewportPlacement: "down",
      disabled: options.length === 0,
      onChange(next) {
        const committed = getThemeTintId(theme.id, options);
        if (next === committed) return true;
        const current = state.snapshot && state.snapshot.petTint;
        const nextMap = current && typeof current === "object" && !Array.isArray(current)
          ? { ...current }
          : {};
        if (next === "none") delete nextMap[theme.id];
        else nextMap[theme.id] = next;
        return Promise.resolve(window.settingsAPI.update("petTint", nextMap))
          .then((result) => {
            if (result && result.status === "ok") return true;
            const message = (result && result.message) || "unknown error";
            ops.showToast(t("toastSaveFailed") + message, { error: true });
            return false;
          })
          .catch((err) => {
            const message = (err && err.message) || "unknown error";
            ops.showToast(t("toastSaveFailed") + message, { error: true });
            return false;
          });
      },
    });

    function syncFromSnapshot() {
      picker.setValue(getThemeTintId(theme.id, options));
      picker.setPending(false);
      picker.setDisabled(options.length === 0);
    }

    if (mountedCustomizationControls && mountedCustomizationControls.themeId === theme.id) {
      mountedCustomizationControls.petTint = syncFromSnapshot;
    }

    control.appendChild(picker.element);
    row.appendChild(text);
    row.appendChild(control);
    syncFromSnapshot();
    return row;
  }

  function buildThemeAccessoryRow(theme) {
    const row = document.createElement("div");
    row.className = "row theme-customization-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowPetAccessory");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("themePetAccessoryDesc");
    text.appendChild(label);
    text.appendChild(desc);

    const control = document.createElement("div");
    control.className = "row-control";
    const options = getAccessoryOptions();
    const pickerOptions = options.length > 0
      ? options.map((entry) => ({ value: entry.id, label: t(entry.labelKey) }))
      : [{ value: "none", label: t("accessoryNone") }];
    const picker = helpers.buildSettingsSelect({
      value: getThemeAccessoryId(theme.id, options),
      options: pickerOptions,
      ariaLabel: t("rowPetAccessory"),
      className: "pet-accessory-select",
      viewportPlacement: "up",
      disabled: options.length === 0,
      onChange(next) {
        const committed = getThemeAccessoryId(theme.id, options);
        if (next === committed) return true;
        const current = state.snapshot && state.snapshot.petAccessory;
        const nextMap = current && typeof current === "object" && !Array.isArray(current)
          ? { ...current }
          : {};
        if (next === "none") delete nextMap[theme.id];
        else nextMap[theme.id] = next;
        return Promise.resolve(window.settingsAPI.update("petAccessory", nextMap))
          .then((result) => {
            if (result && result.status === "ok") return true;
            const message = (result && result.message) || "unknown error";
            ops.showToast(t("toastSaveFailed") + message, { error: true });
            return false;
          })
          .catch((err) => {
            const message = (err && err.message) || "unknown error";
            ops.showToast(t("toastSaveFailed") + message, { error: true });
            return false;
          });
      },
    });

    function syncFromSnapshot() {
      picker.setValue(getThemeAccessoryId(theme.id, options));
      picker.setPending(false);
      picker.setDisabled(options.length === 0);
    }

    if (mountedCustomizationControls && mountedCustomizationControls.themeId === theme.id) {
      mountedCustomizationControls.petAccessory = syncFromSnapshot;
    }

    control.appendChild(picker.element);
    row.appendChild(text);
    row.appendChild(control);
    syncFromSnapshot();
    return row;
  }

  function buildThemeMouthAccessoryRow(theme) {
    const row = document.createElement("div");
    row.className = "row theme-customization-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowPetMouthAccessory");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("themePetMouthAccessoryDesc");
    text.appendChild(label);
    text.appendChild(desc);

    const control = document.createElement("div");
    control.className = "row-control";
    const options = getMouthAccessoryOptions();
    const pickerOptions = options.length > 0
      ? options.map((entry) => ({ value: entry.id, label: t(entry.labelKey) }))
      : [{ value: "none", label: t("accessoryNone") }];
    const picker = helpers.buildSettingsSelect({
      value: getThemeMouthAccessoryId(theme.id, options),
      options: pickerOptions,
      ariaLabel: t("rowPetMouthAccessory"),
      className: "pet-mouth-accessory-select",
      disabled: options.length === 0,
      onChange(next) {
        const committed = getThemeMouthAccessoryId(theme.id, options);
        if (next === committed) return true;
        const current = state.snapshot && state.snapshot.petMouthAccessory;
        const nextMap = current && typeof current === "object" && !Array.isArray(current)
          ? { ...current }
          : {};
        if (next === "none") delete nextMap[theme.id];
        else nextMap[theme.id] = next;
        return Promise.resolve(window.settingsAPI.update("petMouthAccessory", nextMap))
          .then((result) => {
            if (result && result.status === "ok") return true;
            const message = (result && result.message) || "unknown error";
            ops.showToast(t("toastSaveFailed") + message, { error: true });
            return false;
          })
          .catch((err) => {
            const message = (err && err.message) || "unknown error";
            ops.showToast(t("toastSaveFailed") + message, { error: true });
            return false;
          });
      },
    });

    function syncFromSnapshot() {
      picker.setValue(getThemeMouthAccessoryId(theme.id, options));
      picker.setPending(false);
      picker.setDisabled(options.length === 0);
    }

    if (mountedCustomizationControls && mountedCustomizationControls.themeId === theme.id) {
      mountedCustomizationControls.petMouthAccessory = syncFromSnapshot;
    }

    control.appendChild(picker.element);
    row.appendChild(text);
    row.appendChild(control);
    syncFromSnapshot();
    return row;
  }

  function getHolidayAccessoryEnabled(themeId) {
    const selections = state.snapshot && state.snapshot.holidayAccessoryEnabled;
    return !!(
      selections
      && typeof selections === "object"
      && !Array.isArray(selections)
      && selections[themeId] === true
    );
  }

  function buildHolidayAccessoryRow(theme) {
    const row = document.createElement("div");
    row.className = "row theme-customization-row holiday-accessory-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowHolidayAccessory");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("themeHolidayAccessoryDesc");
    text.appendChild(label);
    text.appendChild(desc);

    const control = document.createElement("div");
    control.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch holiday-accessory-switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-label", t("rowHolidayAccessory"));
    sw.setAttribute("tabindex", "0");
    let visualEnabled = getHolidayAccessoryEnabled(theme.id);

    function setVisual(enabled, { pending = false } = {}) {
      visualEnabled = !!enabled;
      helpers.setSwitchVisual(sw, visualEnabled, { pending });
    }

    function syncFromSnapshot() {
      setVisual(getHolidayAccessoryEnabled(theme.id));
    }

    if (mountedCustomizationControls && mountedCustomizationControls.themeId === theme.id) {
      mountedCustomizationControls.holidayAccessoryEnabled = syncFromSnapshot;
    }

    function run(ev) {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      if (sw.classList.contains("pending")) return;
      const nextEnabled = !visualEnabled;
      const current = state.snapshot && state.snapshot.holidayAccessoryEnabled;
      const nextMap = current && typeof current === "object" && !Array.isArray(current)
        ? { ...current }
        : {};
      if (nextEnabled) nextMap[theme.id] = true;
      else delete nextMap[theme.id];
      setVisual(nextEnabled, { pending: true });
      Promise.resolve(window.settingsAPI.update("holidayAccessoryEnabled", nextMap))
        .then((result) => {
          if (result && result.status === "ok") return;
          const message = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + message, { error: true });
          setVisual(getHolidayAccessoryEnabled(theme.id));
        })
        .catch((err) => {
          const message = (err && err.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + message, { error: true });
          setVisual(getHolidayAccessoryEnabled(theme.id));
        })
        .finally(() => {
          if (document.body.contains(sw)) sw.classList.remove("pending");
        });
    }

    sw.addEventListener("click", run);
    sw.addEventListener("keydown", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      run(ev);
    });

    control.appendChild(sw);
    row.appendChild(text);
    row.appendChild(control);
    setVisual(visualEnabled);
    return row;
  }

  function patchInPlace(changes) {
    if (!changes || typeof changes !== "object" || !mountedCustomizationControls) return false;
    if (mountedCustomizationControls.themeId !== customizingThemeId) return false;

    const keys = Object.keys(changes);
    const customizationKeys = new Set([
      "petTint",
      "petAccessory",
      "petMouthAccessory",
      "holidayAccessoryEnabled",
    ]);
    if (keys.length === 0 || !keys.every((key) => customizationKeys.has(key))) return false;

    for (const key of keys) {
      const syncControl = mountedCustomizationControls[key];
      if (typeof syncControl === "function") syncControl();
    }
    return true;
  }

  function buildThemeActions() {
    const row = document.createElement("div");
    row.className = "theme-actions";

    const codexGroup = buildThemeActionGroup(t("themeActionGroupCodexPets"));
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "soft-btn";
    importBtn.textContent = t("themeImportPetZip");
    importBtn.disabled = !!runtime.codexPetZipImportPending
      || !window.settingsAPI
      || typeof window.settingsAPI.importCodexPetZip !== "function";
    if (runtime.codexPetZipImportPending) importBtn.classList.add("pending");
    importBtn.addEventListener("click", handleImportCodexPetZip);
    codexGroup.buttons.appendChild(importBtn);

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "soft-btn";
    refreshBtn.textContent = t("themeRefreshImportedPets");
    refreshBtn.disabled = !!runtime.codexPetsRefreshPending
      || !window.settingsAPI
      || typeof window.settingsAPI.refreshCodexPets !== "function";
    if (runtime.codexPetsRefreshPending) refreshBtn.classList.add("pending");
    refreshBtn.addEventListener("click", handleRefreshCodexPets);
    codexGroup.buttons.appendChild(refreshBtn);
    row.appendChild(codexGroup.group);

    const userThemeGroup = buildThemeActionGroup(t("themeActionGroupUserThemes"));
    const importThemeBtn = document.createElement("button");
    importThemeBtn.type = "button";
    importThemeBtn.className = "soft-btn";
    importThemeBtn.textContent = t("themeImportUserThemeZip");
    importThemeBtn.title = t("themeImportUserThemeZipHint");
    importThemeBtn.disabled = !!runtime.userThemeZipImportPending
      || !window.settingsAPI
      || typeof window.settingsAPI.importUserThemeZip !== "function";
    if (runtime.userThemeZipImportPending) importThemeBtn.classList.add("pending");
    importThemeBtn.addEventListener("click", handleImportUserThemeZip);
    userThemeGroup.buttons.appendChild(importThemeBtn);

    const userThemeFolderBtn = document.createElement("button");
    userThemeFolderBtn.type = "button";
    userThemeFolderBtn.className = "soft-btn";
    userThemeFolderBtn.textContent = t("themeOpenUserThemesFolder");
    userThemeFolderBtn.disabled = !window.settingsAPI
      || typeof window.settingsAPI.openUserThemesDir !== "function";
    userThemeFolderBtn.addEventListener("click", handleOpenUserThemesFolder);
    userThemeGroup.buttons.appendChild(userThemeFolderBtn);

    const refreshThemesBtn = document.createElement("button");
    refreshThemesBtn.type = "button";
    refreshThemesBtn.className = "soft-btn";
    refreshThemesBtn.textContent = t("themeRefreshThemes");
    refreshThemesBtn.disabled = !window.settingsAPI
      || typeof window.settingsAPI.listThemes !== "function";
    refreshThemesBtn.addEventListener("click", handleRefreshThemes);
    userThemeGroup.buttons.appendChild(refreshThemesBtn);
    row.appendChild(userThemeGroup.group);

    return row;
  }

  function buildThemeActionGroup(title) {
    const group = document.createElement("div");
    group.className = "theme-action-group";
    const label = document.createElement("div");
    label.className = "theme-action-label";
    label.textContent = title;
    group.appendChild(label);
    const buttons = document.createElement("div");
    buttons.className = "theme-action-buttons";
    group.appendChild(buttons);
    return { group, buttons };
  }

  function stopThemeCardButtonKeydown(ev) {
    ev.stopPropagation();
  }

  function buildThemeCard(theme) {
    const card = document.createElement("div");
    card.className = "theme-card";
    card.setAttribute("role", "radio");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-checked", theme.active ? "true" : "false");
    if (theme.active) card.classList.add("active");

    const thumb = document.createElement("div");
    thumb.className = "theme-thumb";
    if (theme.previewFileUrl || getCodexPetPreviewAtlasUrl(theme)) {
      thumb.appendChild(buildThemePreviewMedia(theme));
    } else {
      const glyph = document.createElement("span");
      glyph.className = "theme-thumb-empty";
      glyph.textContent = t("themeThumbMissing");
      thumb.appendChild(glyph);
    }
    card.appendChild(thumb);

    const name = document.createElement("div");
    name.className = "theme-card-name";
    const nameText = document.createElement("span");
    nameText.className = "theme-card-name-text";
    nameText.textContent = localizeField(theme.name) || theme.id;
    name.appendChild(nameText);
    if (theme.builtin) {
      const badge = document.createElement("span");
      badge.className = "theme-card-badge";
      badge.textContent = t("themeBadgeBuiltin");
      name.appendChild(badge);
    }
    if (theme.managedCodexPet) {
      const badge = document.createElement("span");
      badge.className = "theme-card-badge accent";
      badge.textContent = t("themeBadgeCodexPet");
      name.appendChild(badge);
    }
    card.appendChild(name);

    const capLabels = getThemeCapabilityBadgeLabels(theme);
    if (capLabels.length) {
      const caps = document.createElement("div");
      caps.className = "theme-card-capabilities";
      for (const label of capLabels) {
        const badge = document.createElement("span");
        badge.className = "theme-card-badge";
        badge.textContent = label;
        caps.appendChild(badge);
      }
      card.appendChild(caps);
    }

    const canDelete = !theme.builtin && !theme.active && !theme.managedCodexPet;
    const canRemoveCodexPet = !!theme.managedCodexPet;
    const footer = document.createElement("div");
    footer.className = "theme-card-footer";
    const indicator = document.createElement("span");
    indicator.className = "theme-card-check";
    indicator.textContent = theme.active ? t("themeActiveIndicator") : "";
    if (!theme.active) indicator.setAttribute("aria-hidden", "true");
    footer.appendChild(indicator);
    if (supportsThemeCustomization(theme)) {
      const btn = document.createElement("button");
      btn.className = "theme-customize-btn";
      btn.type = "button";
      btn.textContent = `${t("themeCustomize")} \u203a`;
      btn.setAttribute("data-settings-focus-key", `theme-customize:${theme.id}`);
      btn.setAttribute("aria-label", `${t("themeCustomize")}: ${localizeField(theme.name) || theme.id}`);
      btn.disabled = !!customizationSelectionPendingThemeId;
      if (customizationSelectionPendingThemeId === theme.id) btn.classList.add("pending");
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openThemeCustomization(theme);
      });
      btn.addEventListener("keydown", stopThemeCardButtonKeydown);
      footer.appendChild(btn);
    }
    if (canDelete) {
      const btn = document.createElement("button");
      btn.className = "theme-delete-btn";
      btn.type = "button";
      btn.textContent = "\u{1F5D1}";
      btn.title = t("themeDeleteLabel");
      btn.setAttribute("aria-label", t("themeDeleteLabel"));
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        handleDeleteTheme(theme);
      });
      btn.addEventListener("keydown", stopThemeCardButtonKeydown);
      footer.appendChild(btn);
    }
    if (canRemoveCodexPet) {
      const btn = document.createElement("button");
      btn.className = "theme-uninstall-btn";
      btn.type = "button";
      btn.textContent = t("themeUninstallPetLabel");
      btn.title = t("themeUninstallPetLabel");
      btn.setAttribute("aria-label", t("themeUninstallPetLabel"));
      btn.disabled = runtime.codexPetRemovalPendingThemeId === theme.id;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        handleRemoveCodexPet(theme);
      });
      btn.addEventListener("keydown", stopThemeCardButtonKeydown);
      footer.appendChild(btn);
    }
    card.appendChild(footer);

    if (!theme.active) {
      helpers.attachActivation(card, () => (
        Promise.resolve(window.settingsAPI.command("setThemeSelection", { themeId: theme.id }))
          .then((result) => {
            if (result && result.status === "ok") {
              mirrorThemeSelectionResult(theme.id, result);
              if (state.activeTab === "theme") ops.requestRender({ content: true });
            }
            return result;
          })
      ));
    }
    return card;
  }

  function formatCodexPetsRefreshOk(result) {
    const summary = (result && result.summary) || {};
    const formatter = t("toastCodexPetsRefreshOk");
    if (typeof formatter === "function") {
      return formatter(
        summary.imported || 0,
        summary.updated || 0,
        summary.unchanged || 0,
        summary.removed || 0,
        summary.invalid || 0,
        !!(result && result.switchedToFallback)
      );
    }
    return String(formatter);
  }

  function formatCodexPetsRefreshFailed(message) {
    const formatter = t("toastCodexPetsRefreshFailed");
    if (typeof formatter === "function") return formatter(message || "unknown error");
    return String(formatter) + (message || "unknown error");
  }

  function handleRefreshCodexPets() {
    if (!window.settingsAPI || typeof window.settingsAPI.refreshCodexPets !== "function") return;
    runtime.codexPetsRefreshPending = true;
    if (state.activeTab === "theme") ops.requestRender({ content: true });
    window.settingsAPI.refreshCodexPets()
      .then((result) => {
        if (!result || result.status !== "ok") {
          ops.showToast(formatCodexPetsRefreshFailed(result && result.message), { error: true });
          return null;
        }
        ops.showToast(formatCodexPetsRefreshOk(result));
        return ops.fetchThemes().then(() => {
          if (state.activeTab === "theme") ops.requestRender({ content: true });
        });
      })
      .catch((err) => {
        ops.showToast(formatCodexPetsRefreshFailed(err && err.message), { error: true });
      })
      .finally(() => {
        runtime.codexPetsRefreshPending = false;
        if (state.activeTab === "theme") ops.requestRender({ content: true });
      });
  }

  function handleOpenUserThemesFolder() {
    if (!window.settingsAPI || typeof window.settingsAPI.openUserThemesDir !== "function") return;
    window.settingsAPI.openUserThemesDir()
      .then((result) => {
        if (!result || result.status !== "ok") {
          ops.showToast(t("toastUserThemesFolderFailed") + ((result && result.message) || "unknown error"), { error: true });
        }
      })
      .catch((err) => {
        ops.showToast(t("toastUserThemesFolderFailed") + (err && err.message), { error: true });
      });
  }

  function handleRefreshThemes() {
    ops.fetchThemes().then(() => {
      if (state.activeTab === "theme") ops.requestRender({ content: true });
    });
  }

  function formatUserThemeZipImportOk(result) {
    const formatter = t("toastUserThemeZipImportOk");
    const name = localizeField(result && result.name) || (result && result.themeId) || "theme";
    if (typeof formatter === "function") return formatter(name);
    return String(formatter);
  }

  function formatUserThemeZipImportFailed(message) {
    const formatter = t("toastUserThemeZipImportFailed");
    if (typeof formatter === "function") return formatter(message || "unknown error");
    return String(formatter) + (message || "unknown error");
  }

  function handleImportUserThemeZip() {
    if (!window.settingsAPI || typeof window.settingsAPI.importUserThemeZip !== "function") return;
    runtime.userThemeZipImportPending = true;
    if (state.activeTab === "theme") ops.requestRender({ content: true });
    window.settingsAPI.importUserThemeZip()
      .then((result) => {
        if (!result || result.status === "cancel") return null;
        if (result.status !== "ok") {
          ops.showToast(formatUserThemeZipImportFailed(result && result.message), { error: true });
          return null;
        }
        ops.showToast(formatUserThemeZipImportOk(result));
        return ops.fetchThemes().then(() => {
          if (state.activeTab === "theme") ops.requestRender({ content: true });
        });
      })
      .catch((err) => {
        ops.showToast(formatUserThemeZipImportFailed(err && err.message), { error: true });
      })
      .finally(() => {
        runtime.userThemeZipImportPending = false;
        if (state.activeTab === "theme") ops.requestRender({ content: true });
      });
  }

  function formatCodexPetZipImportOk(result) {
    const imported = result && result.imported;
    const name = imported && (imported.displayName || imported.id);
    const formatter = t("toastCodexPetZipImportOk");
    if (typeof formatter === "function") return formatter(name || "Codex Pet");
    return String(formatter);
  }

  function formatCodexPetZipImportFailed(message) {
    const formatter = t("toastCodexPetZipImportFailed");
    if (typeof formatter === "function") return formatter(message || "unknown error");
    return String(formatter) + (message || "unknown error");
  }

  function handleImportCodexPetZip() {
    if (!window.settingsAPI || typeof window.settingsAPI.importCodexPetZip !== "function") return;
    runtime.codexPetZipImportPending = true;
    if (state.activeTab === "theme") ops.requestRender({ content: true });
    window.settingsAPI.importCodexPetZip()
      .then((result) => {
        if (!result || result.status === "cancel") return null;
        if (result.status !== "ok") {
          ops.showToast(formatCodexPetZipImportFailed(result && result.message), { error: true });
          return null;
        }
        ops.showToast(formatCodexPetZipImportOk(result));
        return ops.fetchThemes().then(() => {
          if (state.activeTab === "theme") ops.requestRender({ content: true });
        });
      })
      .catch((err) => {
        ops.showToast(formatCodexPetZipImportFailed(err && err.message), { error: true });
      })
      .finally(() => {
        runtime.codexPetZipImportPending = false;
        if (state.activeTab === "theme") ops.requestRender({ content: true });
      });
  }

  function formatCodexPetRemoveOk(result) {
    const removed = result && result.removed;
    const name = removed && (removed.displayName || removed.id);
    const formatter = t("toastCodexPetRemoveOk");
    if (typeof formatter === "function") return formatter(name || "Codex Pet", !!(result && result.switchedToFallback));
    return String(formatter);
  }

  function formatCodexPetRemoveFailed(message) {
    const formatter = t("toastCodexPetRemoveFailed");
    if (typeof formatter === "function") return formatter(message || "unknown error");
    return String(formatter) + (message || "unknown error");
  }

  function handleRemoveCodexPet(theme) {
    if (!window.settingsAPI || typeof window.settingsAPI.removeCodexPet !== "function") return;
    runtime.codexPetRemovalPendingThemeId = theme.id;
    if (state.activeTab === "theme") ops.requestRender({ content: true });
    window.settingsAPI.removeCodexPet(theme.id)
      .then((result) => {
        if (!result || result.status === "cancel") return null;
        if (result.status !== "ok") {
          ops.showToast(formatCodexPetRemoveFailed(result && result.message), { error: true });
          return null;
        }
        ops.showToast(formatCodexPetRemoveOk(result));
        return ops.fetchThemes().then(() => {
          if (state.activeTab === "theme") ops.requestRender({ content: true });
        });
      })
      .catch((err) => {
        ops.showToast(formatCodexPetRemoveFailed(err && err.message), { error: true });
      })
      .finally(() => {
        runtime.codexPetRemovalPendingThemeId = null;
        if (state.activeTab === "theme") ops.requestRender({ content: true });
      });
  }

  function handleDeleteTheme(theme) {
    if (!window.settingsAPI) return;
    window.settingsAPI
      .confirmRemoveTheme(theme.id)
      .then((res) => {
        if (!res || !res.confirmed) return null;
        return window.settingsAPI.command("removeTheme", theme.id);
      })
      .then((result) => {
        if (result == null) return;
        if (result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          ops.showToast(t("toastThemeDeleteFailed") + msg, { error: true });
          return;
        }
        ops.showToast(t("toastThemeDeleted"));
        ops.fetchThemes().then(() => {
          if (state.activeTab === "theme") ops.requestRender({ content: true });
        });
      })
      .catch((err) => {
        ops.showToast(t("toastThemeDeleteFailed") + (err && err.message), { error: true });
      });
  }

  function init(core) {
    state = core.state;
    runtime = core.runtime;
    helpers = core.helpers;
    ops = core.ops;
    readers = core.readers;
    core.tabs.theme = {
      render,
      patchInPlace,
      onExit() {
        customizationSelectionSeq += 1;
        customizingThemeId = null;
        customizationSelectionPendingThemeId = null;
        mountedCustomizationControls = null;
        themeListScrollTop = 0;
        customizationReturnFocusKey = "";
      },
    };
  }

  root.ClawdSettingsTabTheme = { init };
})(globalThis);
