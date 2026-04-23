"use strict";

(function initSettingsTabAnimOverrides(root) {
  let state = null;
  let runtime = null;
  let helpers = null;
  let ops = null;
  let i18n = null;
  let readers = null;

  function t(key) {
    return helpers.t(key);
  }

  function getCurrentOverrideThemeId() {
    return runtime.animationOverridesData
      && runtime.animationOverridesData.theme
      && runtime.animationOverridesData.theme.id;
  }

  function getAnimOverrideCardById(cardId) {
    const cards = runtime.animationOverridesData && runtime.animationOverridesData.cards;
    return Array.isArray(cards) ? cards.find((card) => card.id === cardId) || null : null;
  }

  function getAnimationAssetsSignature(data = runtime.animationOverridesData) {
    const assets = data && Array.isArray(data.assets) ? data.assets : [];
    return assets.map((asset) => [
      asset.name,
      asset.cycleMs == null ? "" : asset.cycleMs,
      asset.cycleStatus || "",
    ].join(":")).join("\n");
  }

  function captureAssetPickerScrollState() {
    if (!runtime.assetPicker.state) return;
    const list = document.querySelector(".asset-picker-list");
    if (!list) return;
    runtime.assetPicker.state.listScrollTop = list.scrollTop;
  }

  function restoreAssetPickerScrollState(list) {
    if (!list || !runtime.assetPicker.state || typeof runtime.assetPicker.state.listScrollTop !== "number") return;
    const target = runtime.assetPicker.state.listScrollTop;
    list.scrollTop = target;
    requestAnimationFrame(() => {
      if (document.body.contains(list)) list.scrollTop = target;
    });
  }

  function shouldRefreshAssetPickerModal({ previousSignature, previousSelectedFile }) {
    if (!runtime.assetPicker.state) return false;
    if (runtime.assetPicker.state.selectedFile !== previousSelectedFile) return true;
    return getAnimationAssetsSignature() !== previousSignature;
  }

  function startAssetPickerPolling() {
    ops.stopAssetPickerPolling();
    runtime.assetPicker.pollTimer = setInterval(() => {
      if (!runtime.assetPicker.state) return;
      const previousSignature = getAnimationAssetsSignature();
      const previousSelectedFile = runtime.assetPicker.state.selectedFile;
      ops.fetchAnimationOverridesData().then(() => {
        ops.normalizeAssetPickerSelection();
        if (shouldRefreshAssetPickerModal({ previousSignature, previousSelectedFile })) {
          renderAssetPickerModal();
        }
      });
    }, 1500);
  }

  function previewStateForCard(card) {
    if (!card) return null;
    if (card.slotType === "tier") {
      return card.tierGroup === "jugglingTiers" ? "juggling" : "working";
    }
    if (card.slotType === "idleAnimation") return "idle";
    return card.stateKey;
  }

  function buildAnimOverrideRequest(card, patch) {
    const base = {
      themeId: getCurrentOverrideThemeId(),
      slotType: card.slotType,
    };
    if (card.slotType === "tier") {
      base.tierGroup = card.tierGroup;
      base.originalFile = card.originalFile;
    } else if (card.slotType === "idleAnimation") {
      base.originalFile = card.originalFile;
    } else if (card.slotType === "reaction") {
      base.reactionKey = card.reactionKey;
    } else {
      base.stateKey = card.stateKey;
    }
    return { ...base, ...patch };
  }

  function runAnimationOverrideCommand(card, patch) {
    const payload = buildAnimOverrideRequest(card, patch);
    return window.settingsAPI.command("setAnimationOverride", payload).then((result) => {
      if (!result || result.status !== "ok" || result.noop) return result;
      return ops.fetchAnimationOverridesData().then(() => {
        ops.normalizeAssetPickerSelection();
        if (state.activeTab === "animOverrides") ops.requestRender({ content: true });
        ops.requestRender({ modal: true });
        return result;
      });
    });
  }

  function openAssetPicker(card) {
    runtime.assetPicker.state = {
      cardId: card.id,
      selectedFile: card.currentFile,
    };
    ops.requestRender({ modal: true });
    startAssetPickerPolling();
  }

  function formatSessionRange(minSessions, maxSessions) {
    const lang = readers.getLang();
    if (lang === "zh") {
      if (maxSessions == null) return `${minSessions}+ 会话`;
      if (minSessions === maxSessions) return `${minSessions} 会话`;
      return `${minSessions}-${maxSessions} 会话`;
    }
    if (lang === "ko") {
      if (maxSessions == null) return `${minSessions}+ 세션`;
      if (minSessions === maxSessions) return `${minSessions} 세션`;
      return `${minSessions}-${maxSessions} 세션`;
    }
    if (maxSessions == null) return `${minSessions}+ sessions`;
    if (minSessions === maxSessions) return `${minSessions} session${minSessions === 1 ? "" : "s"}`;
    return `${minSessions}-${maxSessions} sessions`;
  }

  function getAnimOverrideTriggerLabel(card) {
    switch (card.triggerKind) {
      case "idleTracked": return "Idle follow";
      case "idleStatic": return "Idle";
      case "idleAnimation": return `Idle random #${card.poolIndex || 1}`;
      case "thinking": return "UserPromptSubmit";
      case "working": return `PreToolUse (${formatSessionRange(card.minSessions, card.maxSessions)})`;
      case "juggling": return `SubagentStart (${formatSessionRange(card.minSessions, card.maxSessions)})`;
      case "error": return "PostToolUseFailure";
      case "attention": return "Stop / PostCompact";
      case "notification": return "PermissionRequest";
      case "sweeping": return "PreCompact";
      case "carrying": return "WorktreeCreate";
      case "yawning": return "Sleep: yawn";
      case "dozing": return "Sleep: doze";
      case "collapsing": return "Sleep: collapse";
      case "sleeping": return "60s no events";
      case "waking": return "Wake";
      case "mini-idle": return "Mini idle";
      case "mini-enter": return "Mini enter";
      case "mini-enter-sleep": return "Mini enter sleep";
      case "mini-crabwalk": return "Mini crabwalk";
      case "mini-peek": return "Mini peek";
      case "mini-alert": return "Mini alert";
      case "mini-happy": return "Mini happy";
      case "mini-sleep": return "Mini sleep";
      case "dragReaction": return t("animReactionDrag");
      case "clickLeftReaction": return t("animReactionClickLeft");
      case "clickRightReaction": return t("animReactionClickRight");
      case "annoyedReaction": return t("animReactionAnnoyed");
      case "doubleReaction": return t("animReactionDouble");
      default: return card.triggerKind || card.stateKey || card.id;
    }
  }

  function getAnimOverrideSectionTitle(section) {
    if (!section || !section.id) return "";
    switch (section.id) {
      case "idle": return t("animOverridesSectionIdle");
      case "work": return t("animOverridesSectionWork");
      case "interrupts": return t("animOverridesSectionInterrupts");
      case "sleep": return t("animOverridesSectionSleep");
      case "mini": return t("animOverridesSectionMini");
      case "reactions": return t("animOverridesSectionReactions");
      default: return section.id;
    }
  }

  function getAnimOverrideSectionSubtitle(section) {
    if (!section) return "";
    if (section.id === "idle") {
      if (section.mode === "tracked") return t("animOverridesSectionIdleTracked");
      if (section.mode === "animated") return t("animOverridesSectionIdleAnimated");
      if (section.mode === "static") return t("animOverridesSectionIdleStatic");
    }
    if (section.id === "sleep") {
      if (section.mode === "full") return t("animOverridesSectionSleepFull");
      if (section.mode === "direct") return t("animOverridesSectionSleepDirect");
    }
    return "";
  }

  function buildAnimOverrideSection(section) {
    const wrapper = document.createElement("section");
    wrapper.className = "anim-override-section";

    const head = document.createElement("div");
    head.className = "anim-override-section-head";

    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = getAnimOverrideSectionTitle(section);
    head.appendChild(title);

    const subtitleText = getAnimOverrideSectionSubtitle(section);
    if (subtitleText) {
      const subtitle = document.createElement("div");
      subtitle.className = "anim-override-section-subtitle";
      subtitle.textContent = subtitleText;
      head.appendChild(subtitle);
    }
    wrapper.appendChild(head);

    const list = document.createElement("div");
    list.className = "anim-override-list";
    for (const card of (section.cards || [])) {
      list.appendChild(buildAnimOverrideRow(card));
    }
    wrapper.appendChild(list);
    return wrapper;
  }

  function buildAnimPreviewNode(fileUrl) {
    const frame = document.createElement("div");
    frame.className = "anim-override-preview-frame";
    if (fileUrl) {
      const img = document.createElement("img");
      img.src = fileUrl;
      img.alt = "";
      img.draggable = false;
      frame.appendChild(img);
    } else {
      const glyph = document.createElement("span");
      glyph.className = "theme-thumb-empty";
      glyph.textContent = t("themeThumbMissing");
      frame.appendChild(glyph);
    }
    return frame;
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("animOverridesTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("animOverridesSubtitle");
    parent.appendChild(subtitle);

    if (runtime.animationOverridesData === null) {
      const loading = document.createElement("div");
      loading.className = "placeholder-desc";
      parent.appendChild(loading);
      ops.fetchAnimationOverridesData().then(() => {
        if (state.activeTab === "animOverrides") ops.requestRender({ content: true });
      });
      return;
    }

    const data = runtime.animationOverridesData;
    const themeMeta = document.createElement("div");
    themeMeta.className = "anim-override-meta";
    const themeLabel = document.createElement("div");
    themeLabel.className = "anim-override-meta-label";
    themeLabel.textContent = `${t("animOverridesCurrentTheme")}: ${(data.theme && data.theme.name) || "clawd"}`;
    themeMeta.appendChild(themeLabel);

    const themeBtn = document.createElement("button");
    themeBtn.type = "button";
    themeBtn.className = "soft-btn";
    themeBtn.textContent = t("animOverridesOpenThemeTab");
    themeBtn.addEventListener("click", () => {
      ops.selectTab("theme");
    });
    themeMeta.appendChild(themeBtn);

    const assetsBtn = document.createElement("button");
    assetsBtn.type = "button";
    assetsBtn.className = "soft-btn";
    assetsBtn.textContent = t("animOverridesOpenAssets");
    helpers.attachActivation(assetsBtn, () => window.settingsAPI.openThemeAssetsDir());
    themeMeta.appendChild(assetsBtn);

    const themeId = data.theme && data.theme.id;
    const resetAllBtn = document.createElement("button");
    resetAllBtn.type = "button";
    resetAllBtn.className = "soft-btn";
    resetAllBtn.textContent = t("animOverridesResetAll");
    resetAllBtn.disabled = !themeId || readers.readThemeOverrideMap(themeId) === null;
    helpers.attachActivation(resetAllBtn, () =>
      window.settingsAPI.command("resetThemeOverrides", { themeId }).then((result) => {
        if (result && result.status === "ok" && !result.noop) {
          ops.showToast(t("toastAnimMapResetOk"));
        }
        return result;
      })
    );
    themeMeta.appendChild(resetAllBtn);

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "soft-btn";
    exportBtn.textContent = t("animOverridesExport");
    helpers.attachActivation(exportBtn, () =>
      window.settingsAPI.exportAnimationOverrides().then((result) => {
        if (!result) return result;
        const dict = i18n.STRINGS[readers.getLang()] || i18n.STRINGS.en;
        if (result.status === "ok") {
          ops.showToast(dict.toastAnimOverridesExportOk(result.themeCount || 0, result.path || ""));
        } else if (result.status === "empty") {
          ops.showToast(dict.toastAnimOverridesExportEmpty);
        } else if (result.status === "error") {
          ops.showToast(dict.toastAnimOverridesExportFailed(result.message || ""), { error: true });
        }
        return result;
      })
    );
    themeMeta.appendChild(exportBtn);

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "soft-btn";
    importBtn.textContent = t("animOverridesImport");
    helpers.attachActivation(importBtn, () =>
      window.settingsAPI.importAnimationOverrides().then((result) => {
        if (!result) return result;
        const dict = i18n.STRINGS[readers.getLang()] || i18n.STRINGS.en;
        if (result.status === "ok") {
          ops.showToast(dict.toastAnimOverridesImportOk(result.themeCount || 0));
        } else if (result.status === "error") {
          ops.showToast(dict.toastAnimOverridesImportFailed(result.message || ""), { error: true });
        }
        return result;
      })
    );
    themeMeta.appendChild(importBtn);

    parent.appendChild(themeMeta);

    const sections = Array.isArray(data.sections) ? data.sections : [];
    for (const section of sections) {
      if (!section || !Array.isArray(section.cards) || !section.cards.length) continue;
      parent.appendChild(buildAnimOverrideSection(section));
    }
    if (runtime.assetPicker.state) ops.requestRender({ modal: true });
  }

  function triggerPreviewOnce(card) {
    if (card.slotType === "reaction") {
      window.settingsAPI.previewReaction({
        file: card.currentFile,
        durationMs: getAnimationPreviewDuration(null, card),
      });
      return;
    }
    window.settingsAPI.previewAnimationOverride({
      stateKey: previewStateForCard(card),
      file: card.currentFile,
      durationMs: getAnimationPreviewDuration(null, card),
    });
  }

  function isCardOverridden(card) {
    const themeId = getCurrentOverrideThemeId();
    if (!themeId) return false;
    const map = readers.readThemeOverrideMap(themeId);
    if (!map) return false;
    if (card.slotType === "tier") {
      const group = map.tiers && map.tiers[card.tierGroup];
      return !!(group && group[card.originalFile]);
    }
    if (card.slotType === "idleAnimation") {
      const group = map.idleAnimations;
      return !!(group && group[card.originalFile]);
    }
    const entry = map.states && map.states[card.stateKey];
    if (entry) return true;
    const autoReturn = map.timings && map.timings.autoReturn;
    return !!(autoReturn && Object.prototype.hasOwnProperty.call(autoReturn, card.stateKey));
  }

  function buildAnimOverrideRow(card) {
    const row = document.createElement("details");
    row.className = "anim-override-row";
    if (card.fallbackTargetState) row.classList.add("inherited");
    row.dataset.rowId = card.id;
    if (runtime.expandedOverrideRowIds.has(card.id)) row.open = true;
    row.addEventListener("toggle", () => {
      if (row.open) runtime.expandedOverrideRowIds.add(card.id);
      else runtime.expandedOverrideRowIds.delete(card.id);
    });

    row.appendChild(buildAnimOverrideSummary(card));
    row.appendChild(buildAnimOverrideDrawer(card));
    return row;
  }

  function buildAnimOverrideSummary(card) {
    const summary = document.createElement("summary");

    const chevron = document.createElement("span");
    chevron.className = "anim-override-chevron";
    chevron.textContent = "\u25B8";
    chevron.setAttribute("aria-hidden", "true");
    summary.appendChild(chevron);

    const thumb = document.createElement("div");
    thumb.className = "anim-override-thumb";
    thumb.title = t("animOverridesPreview");
    if (card.currentFileUrl) {
      const img = document.createElement("img");
      img.src = card.currentFileUrl;
      img.alt = "";
      img.draggable = false;
      thumb.appendChild(img);
    }
    thumb.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      triggerPreviewOnce(card);
    });
    summary.appendChild(thumb);

    const text = document.createElement("div");
    text.className = "anim-override-summary-text";
    const trigger = document.createElement("div");
    trigger.className = "anim-override-trigger";
    trigger.textContent = getAnimOverrideTriggerLabel(card);
    text.appendChild(trigger);
    const file = document.createElement("div");
    file.className = "anim-override-file";
    file.textContent = card.currentFile;
    file.title = card.bindingLabel || "";
    text.appendChild(file);
    if (card.fallbackTargetState) {
      const chip = document.createElement("div");
      chip.className = "anim-override-fallback-chip";
      chip.title = getAnimFallbackHint(card);
      const arrow = document.createElement("span");
      arrow.className = "anim-override-fallback-chip-arrow";
      arrow.textContent = "\u21B7";
      arrow.setAttribute("aria-hidden", "true");
      chip.appendChild(arrow);
      const target = document.createElement("span");
      target.textContent = card.fallbackTargetState;
      chip.appendChild(target);
      text.appendChild(chip);
    }
    summary.appendChild(text);

    const badges = document.createElement("div");
    badges.className = "anim-override-summary-badges";
    if (card.displayHintWarning) {
      const warn = document.createElement("span");
      warn.className = "anim-override-badge anim-override-badge-warn";
      warn.textContent = "\u26A0";
      warn.title = t("animOverridesDisplayHintWarning");
      badges.appendChild(warn);
    }
    if (isCardOverridden(card)) {
      const dotWrap = document.createElement("span");
      dotWrap.className = "anim-override-badge";
      dotWrap.title = t("animOverridesOverriddenTooltip");
      const dot = document.createElement("span");
      dot.className = "anim-override-badge-dot";
      dotWrap.appendChild(dot);
      badges.appendChild(dotWrap);
    }
    summary.appendChild(badges);

    const changeBtn = document.createElement("button");
    changeBtn.type = "button";
    changeBtn.className = "soft-btn accent anim-override-summary-change";
    changeBtn.textContent = card.fallbackTargetState ? t("animOverridesUseOwnFile") : t("animOverridesChangeFile");
    changeBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openAssetPicker(card);
    });
    summary.appendChild(changeBtn);

    return summary;
  }

  function runWideHitboxCommand(card, enabled) {
    const themeId = getCurrentOverrideThemeId();
    if (!themeId || !card.currentFile) return;
    window.settingsAPI.command("setWideHitboxOverride", {
      themeId,
      file: card.currentFile,
      enabled,
    }).then((result) => {
      if (!result || result.status !== "ok" || result.noop) return;
      return ops.fetchAnimationOverridesData().then(() => {
        if (state.activeTab === "animOverrides") ops.requestRender({ content: true });
      });
    });
  }

  function buildAnimWideHitboxToggle(card) {
    const row = document.createElement("label");
    row.className = "anim-override-toggle-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!card.wideHitboxEnabled;
    const label = document.createElement("div");
    label.className = "anim-override-toggle-label";
    const title = document.createElement("div");
    title.className = "anim-override-toggle-title";
    title.textContent = t("animOverridesWideHitboxToggle");
    label.appendChild(title);
    const desc = document.createElement("div");
    desc.className = "anim-override-toggle-desc";
    desc.textContent = t("animOverridesWideHitboxDesc");
    label.appendChild(desc);
    if (card.wideHitboxOverridden) {
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "anim-override-reset-chip";
      badge.textContent = t("animOverridesWideHitboxResetToTheme");
      badge.addEventListener("click", (e) => {
        e.preventDefault();
        runWideHitboxCommand(card, null);
      });
      label.appendChild(badge);
    }
    input.addEventListener("change", () => {
      runWideHitboxCommand(card, input.checked);
    });
    row.appendChild(input);
    row.appendChild(label);
    return row;
  }

  function buildAnimOverrideDrawer(card) {
    const drawer = document.createElement("div");
    drawer.className = "anim-override-drawer";

    if (card.fallbackTargetState) {
      const hint = document.createElement("div");
      hint.className = "anim-override-binding";
      hint.textContent = getAnimFallbackHint(card);
      drawer.appendChild(hint);
    }

    if (card.displayHintWarning) {
      const warning = document.createElement("div");
      warning.className = "anim-override-warning";
      warning.textContent = t("animOverridesDisplayHintWarning");
      drawer.appendChild(warning);
    }

    if (card.aspectRatioWarning) {
      const warning = document.createElement("div");
      warning.className = "anim-override-warning";
      const diffPct = Math.round(card.aspectRatioWarning.diffRatio * 100);
      warning.textContent = t("animOverridesAspectWarning").replace("{pct}", String(diffPct));
      drawer.appendChild(warning);
    }

    const head = document.createElement("div");
    head.className = "anim-override-drawer-head";
    const bigPreview = document.createElement("div");
    bigPreview.className = "anim-override-drawer-preview";
    bigPreview.title = t("animOverridesPreview");
    if (card.currentFileUrl) {
      const img = document.createElement("img");
      img.src = card.currentFileUrl;
      img.alt = "";
      img.draggable = false;
      bigPreview.appendChild(img);
    }
    bigPreview.addEventListener("click", () => triggerPreviewOnce(card));
    head.appendChild(bigPreview);

    const info = document.createElement("div");
    info.className = "anim-override-drawer-info";
    const binding = document.createElement("div");
    binding.className = "anim-override-binding";
    binding.textContent = card.bindingLabel;
    info.appendChild(binding);
    info.appendChild(buildAnimTimingHint(
      t("animOverridesAssetCycle"),
      card.assetCycleMs,
      card.assetCycleStatus
    ));
    if ((card.supportsAutoReturn || card.supportsDuration) && card.assetCycleMs == null && card.suggestedDurationMs != null) {
      info.appendChild(buildAnimTimingHint(
        card.supportsDuration ? t("animOverridesDurationIdle") : t("animOverridesSuggestedTiming"),
        card.suggestedDurationMs,
        card.suggestedDurationStatus
      ));
    }
    if (!card.supportsAutoReturn && !card.supportsDuration) {
      const hint = document.createElement("div");
      hint.className = "anim-override-binding";
      hint.textContent = t("animOverridesContinuousHint");
      info.appendChild(hint);
    }
    head.appendChild(info);
    drawer.appendChild(head);

    const sliders = document.createElement("div");
    sliders.className = "anim-override-sliders";
    sliders.appendChild(buildAnimOverrideSliderRow({
      label: t("animOverridesFadeIn"),
      min: 0, max: 1000, step: 10,
      value: card.transition.in,
      onCommit: (v) => runAnimationOverrideCommand(card, {
        transition: { in: v, out: card.transition.out },
      }),
    }));
    sliders.appendChild(buildAnimOverrideSliderRow({
      label: t("animOverridesFadeOut"),
      min: 0, max: 1000, step: 10,
      value: card.transition.out,
      onCommit: (v) => runAnimationOverrideCommand(card, {
        transition: { in: card.transition.in, out: v },
      }),
    }));
    if (card.supportsAutoReturn) {
      const current = Number.isFinite(card.autoReturnMs) ? card.autoReturnMs : (card.suggestedDurationMs || 3000);
      sliders.appendChild(buildAnimOverrideSliderRow({
        label: t("animOverridesDuration"),
        min: 500, max: 10000, step: 100,
        value: current,
        numberMin: 500,
        numberMax: 60000,
        onCommit: (v) => {
          if (!Number.isFinite(v) || v < 500 || v > 60000) return;
          return runAnimationOverrideCommand(card, { autoReturnMs: v });
        },
      }));
    }
    if (card.supportsDuration) {
      const current = Number.isFinite(card.durationMs) ? card.durationMs : (card.suggestedDurationMs || 3000);
      sliders.appendChild(buildAnimOverrideSliderRow({
        label: t("animOverridesDurationIdle"),
        min: 500, max: 20000, step: 100,
        value: current,
        numberMin: 500,
        numberMax: 60000,
        onCommit: (v) => {
          if (!Number.isFinite(v) || v < 500 || v > 60000) return;
          return runAnimationOverrideCommand(card, { durationMs: v });
        },
      }));
    }
    drawer.appendChild(sliders);

    if (card.slotType !== "reaction") {
      drawer.appendChild(buildAnimWideHitboxToggle(card));
    }

    const footer = document.createElement("div");
    footer.className = "anim-override-drawer-footer";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "soft-btn";
    resetBtn.textContent = t("animOverridesReset");
    resetBtn.disabled = !isCardOverridden(card);
    helpers.attachActivation(resetBtn, () => {
      const patch = {
        file: null,
        transition: null,
        ...(card.supportsAutoReturn ? { autoReturnMs: null } : {}),
        ...(card.supportsDuration ? { durationMs: null } : {}),
      };
      return runAnimationOverrideCommand(card, patch);
    });
    footer.appendChild(resetBtn);
    drawer.appendChild(footer);

    return drawer;
  }

  function buildAnimOverrideSliderRow({ label, min, max, step, value, numberMin, numberMax, onCommit }) {
    const row = document.createElement("div");
    row.className = "anim-override-slider-row";

    const lbl = document.createElement("span");
    lbl.className = "anim-override-slider-label";
    lbl.textContent = label;
    row.appendChild(lbl);

    const range = document.createElement("input");
    range.type = "range";
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(clampNumber(value, min, max));
    row.appendChild(range);

    const number = document.createElement("input");
    number.type = "number";
    number.min = String(Number.isFinite(numberMin) ? numberMin : min);
    number.max = String(Number.isFinite(numberMax) ? numberMax : max);
    number.step = String(step);
    number.value = String(value);
    row.appendChild(number);

    range.addEventListener("input", () => {
      number.value = range.value;
    });
    range.addEventListener("change", () => {
      const v = Number(range.value);
      if (Number.isFinite(v)) onCommit(v);
    });
    number.addEventListener("input", () => {
      const v = Number(number.value);
      if (Number.isFinite(v)) range.value = String(clampNumber(v, min, max));
    });
    const commitFromNumber = () => {
      const v = Number(number.value);
      if (Number.isFinite(v)) onCommit(v);
    };
    number.addEventListener("change", commitFromNumber);
    number.addEventListener("blur", commitFromNumber);

    return row;
  }

  function clampNumber(v, min, max) {
    if (!Number.isFinite(v)) return min;
    return Math.min(Math.max(v, min), max);
  }

  function formatAnimTimingValue(ms, status) {
    if (status === "static") return "—";
    let text = Number.isFinite(ms) && ms > 0
      ? `${ms} ms`
      : t("animOverridesTimingUnavailable");
    if (status === "estimated") text += ` (${t("animOverridesTimingEstimated")})`;
    else if (status === "fallback") text += ` (${t("animOverridesTimingFallback")})`;
    return text;
  }

  function getAnimFallbackHint(card) {
    if (!card || !card.fallbackTargetState) return "";
    return t("animOverridesFallbackHint").replace("{state}", card.fallbackTargetState);
  }

  function buildAnimTimingHint(label, ms, status) {
    const line = document.createElement("div");
    line.className = "anim-override-binding";
    line.textContent = `${label}: ${formatAnimTimingValue(ms, status)}`;
    return line;
  }

  function getAnimationPreviewDuration(asset, card) {
    if (asset && Number.isFinite(asset.cycleMs) && asset.cycleMs > 0) return asset.cycleMs;
    if (card && Number.isFinite(card.previewDurationMs) && card.previewDurationMs > 0) return card.previewDurationMs;
    if (card && card.supportsAutoReturn && Number.isFinite(card.autoReturnMs) && card.autoReturnMs > 0) {
      return card.autoReturnMs;
    }
    return null;
  }

  function getSelectedAnimationAsset() {
    if (!runtime.assetPicker.state || !runtime.animationOverridesData) return null;
    const assets = Array.isArray(runtime.animationOverridesData.assets) ? runtime.animationOverridesData.assets : [];
    return assets.find((asset) => asset.name === runtime.assetPicker.state.selectedFile) || null;
  }

  function populateAssetPickerDetail(detail, selected) {
    detail.innerHTML = "";
    detail.appendChild(buildAnimPreviewNode(selected && selected.fileUrl));
    const selectedLabel = document.createElement("div");
    selectedLabel.className = "anim-override-file";
    selectedLabel.textContent = `${t("animOverridesModalSelected")}: ${selected ? selected.name : "-"}`;
    detail.appendChild(selectedLabel);
    detail.appendChild(buildAnimTimingHint(
      t("animOverridesAssetCycle"),
      selected && selected.cycleMs,
      selected && selected.cycleStatus
    ));
  }

  function syncAssetPickerSelectionUi() {
    const rootNode = document.getElementById("modalRoot");
    if (!rootNode || !runtime.assetPicker.state) return;
    const selected = getSelectedAnimationAsset();
    for (const item of rootNode.querySelectorAll(".asset-picker-item")) {
      item.classList.toggle("active", item.dataset.assetName === (selected && selected.name));
    }
    const detail = rootNode.querySelector(".asset-picker-detail");
    if (detail) populateAssetPickerDetail(detail, selected);
    const previewBtn = rootNode.querySelector(".asset-picker-preview-btn");
    if (previewBtn) previewBtn.disabled = !selected;
    const useBtn = rootNode.querySelector(".asset-picker-use-btn");
    if (useBtn) useBtn.disabled = !selected;
  }

  function renderAssetPickerModal() {
    const rootNode = document.getElementById("modalRoot");
    if (!rootNode) return;
    captureAssetPickerScrollState();
    rootNode.innerHTML = "";
    if (!runtime.assetPicker.state || !runtime.animationOverridesData) return;
    const card = getAnimOverrideCardById(runtime.assetPicker.state.cardId);
    if (!card) {
      ops.closeAssetPicker();
      return;
    }
    ops.normalizeAssetPickerSelection();
    const assets = Array.isArray(runtime.animationOverridesData.assets) ? runtime.animationOverridesData.assets : [];
    const selected = getSelectedAnimationAsset();

    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) ops.closeAssetPicker();
    });

    const modal = document.createElement("div");
    modal.className = "asset-picker-modal";

    const title = document.createElement("h2");
    title.textContent = t("animOverridesModalTitle");
    modal.appendChild(title);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("animOverridesModalSubtitle");
    modal.appendChild(subtitle);

    const refreshRow = document.createElement("div");
    refreshRow.className = "asset-picker-toolbar";
    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "soft-btn";
    refreshBtn.textContent = t("animOverridesRefresh");
    helpers.attachActivation(refreshBtn, () => ops.fetchAnimationOverridesData().then(() => {
      ops.normalizeAssetPickerSelection();
      renderAssetPickerModal();
      return { status: "ok" };
    }));
    refreshRow.appendChild(refreshBtn);

    const openAssetsBtn = document.createElement("button");
    openAssetsBtn.type = "button";
    openAssetsBtn.className = "soft-btn";
    openAssetsBtn.textContent = t("animOverridesOpenAssets");
    helpers.attachActivation(openAssetsBtn, () => window.settingsAPI.openThemeAssetsDir());
    refreshRow.appendChild(openAssetsBtn);
    modal.appendChild(refreshRow);

    const body = document.createElement("div");
    body.className = "asset-picker-body";

    const list = document.createElement("div");
    list.className = "asset-picker-list";
    if (!assets.length) {
      const empty = document.createElement("div");
      empty.className = "placeholder-desc";
      empty.textContent = t("animOverridesModalEmpty");
      list.appendChild(empty);
    } else {
      for (const asset of assets) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "asset-picker-item" + (selected && selected.name === asset.name ? " active" : "");
        item.dataset.assetName = asset.name;
        item.textContent = asset.name;
        item.addEventListener("click", () => {
          runtime.assetPicker.state.selectedFile = asset.name;
          syncAssetPickerSelectionUi();
        });
        list.appendChild(item);
      }
    }
    body.appendChild(list);
    restoreAssetPickerScrollState(list);

    const detail = document.createElement("div");
    detail.className = "asset-picker-detail";
    populateAssetPickerDetail(detail, selected);
    body.appendChild(detail);
    modal.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "asset-picker-footer";

    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "soft-btn asset-picker-preview-btn";
    previewBtn.textContent = t("animOverridesPreview");
    previewBtn.disabled = !selected;
    helpers.attachActivation(previewBtn, () => {
      const currentSelected = getSelectedAnimationAsset();
      if (!currentSelected) return { status: "error", message: "no asset selected" };
      return window.settingsAPI.previewAnimationOverride({
        stateKey: previewStateForCard(card),
        file: currentSelected.name,
        durationMs: getAnimationPreviewDuration(currentSelected, card),
      });
    });
    footer.appendChild(previewBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "soft-btn";
    cancelBtn.textContent = t("animOverridesModalCancel");
    cancelBtn.addEventListener("click", () => ops.closeAssetPicker());
    footer.appendChild(cancelBtn);

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "soft-btn accent asset-picker-use-btn";
    useBtn.textContent = t("animOverridesModalUse");
    useBtn.disabled = !selected;
    helpers.attachActivation(useBtn, () => {
      const currentSelected = getSelectedAnimationAsset();
      if (!currentSelected) return { status: "error", message: "no asset selected" };
      return runAnimationOverrideCommand(card, { file: currentSelected.name }).then((result) => {
        if (result && result.status === "ok") {
          ops.closeAssetPicker();
          const changed = !result.noop;
          if (changed) {
            const previewPromise = card.slotType === "reaction"
              ? (window.settingsAPI && typeof window.settingsAPI.previewReaction === "function"
                  ? window.settingsAPI.previewReaction({
                      file: currentSelected.name,
                      durationMs: getAnimationPreviewDuration(currentSelected, card),
                    })
                  : null)
              : (window.settingsAPI && typeof window.settingsAPI.previewAnimationOverride === "function"
                  ? window.settingsAPI.previewAnimationOverride({
                      stateKey: previewStateForCard(card),
                      file: currentSelected.name,
                      durationMs: getAnimationPreviewDuration(currentSelected, card),
                    })
                  : null);
            if (previewPromise) {
              previewPromise.then((previewResult) => {
                if (!previewResult || previewResult.status === "ok") return;
                ops.showToast(t("toastSaveFailed") + previewResult.message, { error: true });
              }).catch((err) => {
                ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
              });
            }
          }
        }
        return result;
      });
    });
    footer.appendChild(useBtn);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    rootNode.appendChild(overlay);
  }

  function onExit() {
    ops.closeAssetPicker();
  }

  function init(core) {
    state = core.state;
    runtime = core.runtime;
    helpers = core.helpers;
    ops = core.ops;
    i18n = core.i18n;
    readers = core.readers;
    core.renderHooks.modal = renderAssetPickerModal;
    core.tabs.animOverrides = {
      render,
      onExit,
    };
  }

  root.ClawdSettingsTabAnimOverrides = { init };
})(globalThis);
