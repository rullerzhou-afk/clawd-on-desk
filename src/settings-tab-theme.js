"use strict";

(function initSettingsTabTheme(root) {
  const PREVIEW_TARGET_CONTENT_RATIO = 0.55;

  let state = null;
  let runtime = null;
  let helpers = null;
  let ops = null;
  let readers = null;

  function t(key) {
    return helpers.t(key);
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("themeTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("themeSubtitle");
    parent.appendChild(subtitle);

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

    const grid = document.createElement("div");
    grid.className = "theme-grid";
    for (const theme of runtime.themeList) {
      grid.appendChild(buildThemeCard(theme));
    }
    parent.appendChild(grid);
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

  function applyThemePreviewScale(img, contentRatio) {
    if (!Number.isFinite(contentRatio) || contentRatio <= 0) return;
    if (contentRatio <= PREVIEW_TARGET_CONTENT_RATIO) return;
    const scale = PREVIEW_TARGET_CONTENT_RATIO / contentRatio;
    const pct = `${(scale * 100).toFixed(2)}%`;
    img.style.maxWidth = pct;
    img.style.maxHeight = pct;
  }

  function applyThemePreviewOffset(img, offsetPct) {
    if (!offsetPct) return;
    const { x, y } = offsetPct;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;
    img.style.transform = `translate(${x.toFixed(2)}%, ${y.toFixed(2)}%)`;
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
    if (caps.reactions === false) badges.push(t("themeCapabilityNoReactions"));
    return badges;
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
    if (theme.previewFileUrl) {
      const img = document.createElement("img");
      img.src = theme.previewFileUrl;
      img.alt = "";
      img.draggable = false;
      applyThemePreviewScale(img, theme.previewContentRatio);
      applyThemePreviewOffset(img, theme.previewContentOffsetPct);
      thumb.appendChild(img);
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

    const canDelete = !theme.builtin && !theme.active;
    if (theme.active || canDelete) {
      const footer = document.createElement("div");
      footer.className = "theme-card-footer";
      const indicator = document.createElement("span");
      indicator.className = "theme-card-check";
      indicator.textContent = theme.active ? t("themeActiveIndicator") : "";
      footer.appendChild(indicator);
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
        footer.appendChild(btn);
      }
      card.appendChild(footer);
    }

    if (!theme.active) {
      helpers.attachActivation(card, () => window.settingsAPI.command("setThemeSelection", { themeId: theme.id }));
    }
    return card;
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
    };
  }

  root.ClawdSettingsTabTheme = { init };
})(globalThis);
