"use strict";

(function initSettingsTabAnimOverrides(root) {
  const animMergeApi = root.ClawdSettingsAnimOverridesMerge || {};
  const getAssetPreviewUrl = animMergeApi.getAssetPreviewUrl || ((asset) => {
    if (!asset) return null;
    if (asset.previewImageUrl) return asset.previewImageUrl;
    return asset.needsScriptedPreviewPoster ? null : asset.fileUrl || null;
  });
  const getCardPreviewUrl = animMergeApi.getCardPreviewUrl || ((card) => {
    if (!card) return null;
    if (card.currentFilePreviewUrl) return card.currentFilePreviewUrl;
    return (card.previewPosterPending || card.needsScriptedPreviewPoster) ? null : card.currentFileUrl || null;
  });

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

  function getPendingAnimationOverrideEdits() {
    if (!runtime.pendingAnimationOverrideEdits || typeof runtime.pendingAnimationOverrideEdits.get !== "function") {
      runtime.pendingAnimationOverrideEdits = new Map();
    }
    return runtime.pendingAnimationOverrideEdits;
  }

  function getMountedTimingSliders() {
    if (!state.mountedControls || typeof state.mountedControls !== "object") {
      state.mountedControls = {};
    }
    if (!state.mountedControls.animOverrideTimingSliders
      || typeof state.mountedControls.animOverrideTimingSliders.get !== "function") {
      state.mountedControls.animOverrideTimingSliders = new Map();
    }
    return state.mountedControls.animOverrideTimingSliders;
  }

  function getMountedOverrideStatusControls() {
    if (!state.mountedControls || typeof state.mountedControls !== "object") {
      state.mountedControls = {};
    }
    if (!state.mountedControls.animOverrideStatusControls
      || typeof state.mountedControls.animOverrideStatusControls.get !== "function") {
      state.mountedControls.animOverrideStatusControls = new Map();
    }
    return state.mountedControls.animOverrideStatusControls;
  }

  function getPendingWideHitboxOverrideEdits() {
    if (!runtime.pendingWideHitboxOverrideEdits || typeof runtime.pendingWideHitboxOverrideEdits.get !== "function") {
      runtime.pendingWideHitboxOverrideEdits = new Map();
    }
    return runtime.pendingWideHitboxOverrideEdits;
  }

  function getPendingAnimationOverrideResets() {
    if (!runtime.pendingAnimationOverrideResets || typeof runtime.pendingAnimationOverrideResets.has !== "function") {
      runtime.pendingAnimationOverrideResets = new Set();
    }
    return runtime.pendingAnimationOverrideResets;
  }

  function getMountedWideHitboxToggles() {
    if (!state.mountedControls || typeof state.mountedControls !== "object") {
      state.mountedControls = {};
    }
    if (!state.mountedControls.animOverrideWideHitboxToggles
      || typeof state.mountedControls.animOverrideWideHitboxToggles.get !== "function") {
      state.mountedControls.animOverrideWideHitboxToggles = new Map();
    }
    return state.mountedControls.animOverrideWideHitboxToggles;
  }

  function isTimingControlBlocked(cardId) {
    return !!(cardId && (
      getPendingWideHitboxOverrideEdits().has(cardId)
      || getPendingAnimationOverrideResets().has(cardId)
    ));
  }

  function isWideHitboxControlBlocked(cardId) {
    return !!(cardId && (
      getPendingWideHitboxOverrideEdits().has(cardId)
      || getPendingAnimationOverrideResets().has(cardId)
      || getPendingAnimationOverrideEdits().has(cardId)
    ));
  }

  function timingControlKey(cardId, field) {
    return `${cardId}:${field}`;
  }

  function getCardTimingValue(card, field) {
    if (!card) return null;
    if (field === "transition.in") return card.transition && card.transition.in;
    if (field === "transition.out") return card.transition && card.transition.out;
    if (field === "autoReturnMs") return card.autoReturnMs;
    if (field === "durationMs") return card.durationMs;
    return null;
  }

  function isTimingOnlyPatch(patch) {
    if (!patch || typeof patch !== "object") return false;
    const keys = Object.keys(patch);
    if (!keys.length) return false;
    return keys.every((key) => {
      if (key === "transition") {
        return patch.transition
          && typeof patch.transition === "object"
          && Number.isFinite(patch.transition.in)
          && Number.isFinite(patch.transition.out);
      }
      return (key === "autoReturnMs" || key === "durationMs") && Number.isFinite(patch[key]);
    });
  }

  function recordPendingAnimationOverrideEdit(card, patch) {
    if (!card || !card.id || !patch || typeof patch !== "object") return null;
    const touchesTiming = !!(
      patch.transition
      || Object.prototype.hasOwnProperty.call(patch, "autoReturnMs")
      || Object.prototype.hasOwnProperty.call(patch, "durationMs")
    );
    if (!touchesTiming) return null;
    const edits = getPendingAnimationOverrideEdits();
    const seq = Number.isFinite(runtime.nextAnimationOverrideEditSeq)
      ? runtime.nextAnimationOverrideEditSeq
      : 1;
    runtime.nextAnimationOverrideEditSeq = seq + 1;
    const current = edits.get(card.id) || {};
    const next = {
      ...current,
      seq,
      slotType: card.slotType,
      stateKey: card.stateKey,
      tierGroup: card.tierGroup,
      originalFile: card.originalFile,
      reactionKey: card.reactionKey,
    };
    let storedTimingValue = false;
    if (patch.transition && typeof patch.transition === "object") {
      next.transition = { ...patch.transition };
      if (card.transitionThemeDefault && typeof card.transitionThemeDefault === "object") {
        next.transitionThemeDefault = { ...card.transitionThemeDefault };
      } else {
        delete next.transitionThemeDefault;
      }
      storedTimingValue = true;
    }
    if (Number.isFinite(patch.autoReturnMs)) {
      next.autoReturnMs = patch.autoReturnMs;
      storedTimingValue = true;
    }
    if (Number.isFinite(patch.durationMs)) {
      next.durationMs = patch.durationMs;
      storedTimingValue = true;
    }
    if (!storedTimingValue) return null;
    edits.set(card.id, next);
    return { id: card.id, seq };
  }

  function clearPendingAnimationOverrideEdit(token) {
    if (!token || !token.id) return;
    const edits = getPendingAnimationOverrideEdits();
    const current = edits.get(token.id);
    if (!current || current.seq !== token.seq) return;
    edits.delete(token.id);
  }

  function transitionMatchesThemeDefault(transition, defaultTransition) {
    if (!transition || !defaultTransition) return false;
    return transition.in === defaultTransition.in && transition.out === defaultTransition.out;
  }

  function pendingTransitionMatchesThemeDefault(pending) {
    return !!(pending
      && pending.transition
      && pending.transitionThemeDefault
      && transitionMatchesThemeDefault(pending.transition, pending.transitionThemeDefault));
  }

  function hasTransitionOverride(entry) {
    return !!(entry && Object.prototype.hasOwnProperty.call(entry, "transition"));
  }

  function wideHitboxResetVisible(card) {
    if (!card) return false;
    return !!card.wideHitboxOverridden || !!card.wideHitboxEnabled !== !!card.wideHitboxThemeDefault;
  }

  function recordPendingWideHitboxOverrideEdit(card, targetEnabled) {
    if (!card || !card.id || !card.currentFile) return null;
    const edits = getPendingWideHitboxOverrideEdits();
    const seq = Number.isFinite(runtime.nextWideHitboxOverrideEditSeq)
      ? runtime.nextWideHitboxOverrideEditSeq
      : 1;
    runtime.nextWideHitboxOverrideEditSeq = seq + 1;
    const themeDefault = !!card.wideHitboxThemeDefault;
    const effectiveEnabled = !!targetEnabled;
    const commandEnabled = effectiveEnabled === themeDefault ? null : effectiveEnabled;
    edits.set(card.id, {
      seq,
      currentFile: card.currentFile,
      themeDefault,
      effectiveEnabled,
      commandEnabled,
    });
    return { id: card.id, seq };
  }

  function clearPendingWideHitboxOverrideEdit(token) {
    if (!token || !token.id) return;
    const edits = getPendingWideHitboxOverrideEdits();
    const current = edits.get(token.id);
    if (!current || current.seq !== token.seq) return;
    edits.delete(token.id);
  }

  function applyPendingAnimationOverrideEdit(card) {
    if (!card || !card.id) return card;
    const pending = getPendingAnimationOverrideEdits().get(card.id);
    if (!pending) return card;
    return {
      ...card,
      transition: pending.transition ? { ...pending.transition } : card.transition,
      ...(pending.transition ? {
        hasTransitionOverride: !transitionMatchesThemeDefault(pending.transition, card.transitionThemeDefault),
      } : {}),
      ...(Object.prototype.hasOwnProperty.call(pending, "autoReturnMs") ? { autoReturnMs: pending.autoReturnMs } : {}),
      ...(Object.prototype.hasOwnProperty.call(pending, "durationMs") ? { durationMs: pending.durationMs } : {}),
    };
  }

  function applyPendingWideHitboxOverrideEdit(card) {
    if (!card || !card.id) return card;
    const pending = getPendingWideHitboxOverrideEdits().get(card.id);
    if (!pending) return card;
    return {
      ...card,
      wideHitboxEnabled: pending.effectiveEnabled,
      wideHitboxOverridden: pending.commandEnabled !== null,
      wideHitboxThemeDefault: pending.themeDefault,
    };
  }

  function applyPendingAnimOverrideCard(card) {
    return applyPendingWideHitboxOverrideEdit(applyPendingAnimationOverrideEdit(card));
  }

  function cardReflectsPendingEdit(card, pending) {
    if (!card || !pending) return false;
    if (pending.transition) {
      if (!card.transition) return false;
      if (card.transition.in !== pending.transition.in) return false;
      if (card.transition.out !== pending.transition.out) return false;
    }
    if (Object.prototype.hasOwnProperty.call(pending, "autoReturnMs") && card.autoReturnMs !== pending.autoReturnMs) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(pending, "durationMs") && card.durationMs !== pending.durationMs) {
      return false;
    }
    return true;
  }

  function reconcilePendingAnimationOverrideEdits() {
    const edits = getPendingAnimationOverrideEdits();
    if (!edits.size) return;
    for (const [id, pending] of edits) {
      const card = getAnimOverrideCardById(id);
      if (cardReflectsPendingEdit(card, pending)) edits.delete(id);
    }
  }

  function cardReflectsPendingWideHitboxOverride(card, pending) {
    if (!card || !pending) return false;
    return (
      !!card.wideHitboxEnabled === pending.effectiveEnabled
      && !!card.wideHitboxThemeDefault === pending.themeDefault
      && !!card.wideHitboxOverridden === (pending.commandEnabled !== null)
    );
  }

  function reconcilePendingWideHitboxOverrideEdits() {
    const edits = getPendingWideHitboxOverrideEdits();
    if (!edits.size) return;
    for (const [id, pending] of edits) {
      const card = getAnimOverrideCardById(id);
      if (cardReflectsPendingWideHitboxOverride(card, pending)) edits.delete(id);
    }
  }

  function syncMountedTimingSliders() {
    const controls = getMountedTimingSliders();
    for (const [key, control] of controls) {
      if (!control || !control.row || !control.row.parentNode) {
        controls.delete(key);
        continue;
      }
      const card = applyPendingAnimationOverrideEdit(getAnimOverrideCardById(control.cardId));
      const value = getCardTimingValue(card, control.field);
      if (Number.isFinite(value)) control.setValue(value);
      const blocked = isTimingControlBlocked(control.cardId);
      if (control.range) control.range.disabled = blocked;
      if (control.number) control.number.disabled = blocked;
    }
  }

  function setSummaryOverrideBadge(container, visible) {
    if (!container) return;
    const existingDot = container.querySelector(".anim-override-badge-dot");
    const existingWrap = existingDot && existingDot.parentNode;
    if (!visible) {
      if (existingWrap && typeof existingWrap.remove === "function") existingWrap.remove();
      return;
    }
    if (existingDot) return;
    const dotWrap = document.createElement("span");
    dotWrap.className = "anim-override-badge";
    dotWrap.title = t("animOverridesOverriddenTooltip");
    const dot = document.createElement("span");
    dot.className = "anim-override-badge-dot";
    dotWrap.appendChild(dot);
    container.appendChild(dotWrap);
  }

  function syncMountedOverrideStatusControls() {
    const controls = getMountedOverrideStatusControls();
    for (const [cardId, control] of controls) {
      if (!control || !control.row || !control.row.parentNode) {
        controls.delete(cardId);
        continue;
      }
      const card = applyPendingAnimOverrideCard(getAnimOverrideCardById(cardId) || control.card);
      const overridden = isCardOverridden(card);
      const hitboxPending = getPendingWideHitboxOverrideEdits().has(cardId);
      const resetPending = getPendingAnimationOverrideResets().has(cardId);
      const timingPending = getPendingAnimationOverrideEdits().has(cardId);
      control.card = card || control.card;
      if (control.resetBtn) control.resetBtn.disabled = !overridden || hitboxPending || resetPending || timingPending;
      setSummaryOverrideBadge(control.summaryBadges, overridden);
    }
  }

  function syncMountedWideHitboxToggles() {
    const controls = getMountedWideHitboxToggles();
    for (const [cardId, control] of controls) {
      if (!control || !control.row || !control.row.parentNode) {
        controls.delete(cardId);
        continue;
      }
      const card = applyPendingWideHitboxOverrideEdit(getAnimOverrideCardById(cardId) || control.card);
      const blocked = isWideHitboxControlBlocked(cardId);
      control.card = card || control.card;
      control.input.checked = !!(card && card.wideHitboxEnabled);
      control.input.disabled = blocked;
      control.badge.hidden = !wideHitboxResetVisible(card);
      control.badge.disabled = blocked || !wideHitboxResetVisible(card);
      control.row.classList.toggle("pending", blocked);
    }
  }

  function clonePlainObject(value) {
    if (!value || typeof value !== "object") return {};
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return {};
    }
  }

  function plainObjectsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!plainObjectsEqual(a[key], b[key])) return false;
    }
    return true;
  }

  function pruneEmptyObject(parent, key) {
    if (parent && parent[key] && typeof parent[key] === "object" && !Object.keys(parent[key]).length) {
      delete parent[key];
    }
  }

  function pruneThemeOverrideMap(themeMap) {
    if (!themeMap || typeof themeMap !== "object") return;
    pruneEmptyObject(themeMap, "states");
    if (themeMap.tiers && typeof themeMap.tiers === "object") {
      pruneEmptyObject(themeMap.tiers, "workingTiers");
      pruneEmptyObject(themeMap.tiers, "jugglingTiers");
      pruneEmptyObject(themeMap, "tiers");
    }
    if (themeMap.timings && typeof themeMap.timings === "object") {
      pruneEmptyObject(themeMap.timings, "autoReturn");
      pruneEmptyObject(themeMap, "timings");
    }
    pruneEmptyObject(themeMap, "idleAnimations");
    pruneEmptyObject(themeMap, "reactions");
    if (themeMap.hitbox && typeof themeMap.hitbox === "object") {
      pruneEmptyObject(themeMap.hitbox, "wide");
      pruneEmptyObject(themeMap, "hitbox");
    }
  }

  function ensureThemeOverrideEntry(themeMap, pending) {
    if (!themeMap || !pending || !pending.slotType) return null;
    if (pending.slotType === "state") {
      if (!pending.stateKey) return null;
      themeMap.states = themeMap.states || {};
      themeMap.states[pending.stateKey] = themeMap.states[pending.stateKey] || {};
      return themeMap.states[pending.stateKey];
    }
    if (pending.slotType === "tier") {
      if (!pending.tierGroup || !pending.originalFile) return null;
      themeMap.tiers = themeMap.tiers || {};
      themeMap.tiers[pending.tierGroup] = themeMap.tiers[pending.tierGroup] || {};
      themeMap.tiers[pending.tierGroup][pending.originalFile] = themeMap.tiers[pending.tierGroup][pending.originalFile] || {};
      return themeMap.tiers[pending.tierGroup][pending.originalFile];
    }
    if (pending.slotType === "idleAnimation") {
      if (!pending.originalFile) return null;
      themeMap.idleAnimations = themeMap.idleAnimations || {};
      themeMap.idleAnimations[pending.originalFile] = themeMap.idleAnimations[pending.originalFile] || {};
      return themeMap.idleAnimations[pending.originalFile];
    }
    if (pending.slotType === "reaction") {
      if (!pending.reactionKey) return null;
      themeMap.reactions = themeMap.reactions || {};
      themeMap.reactions[pending.reactionKey] = themeMap.reactions[pending.reactionKey] || {};
      return themeMap.reactions[pending.reactionKey];
    }
    return null;
  }

  function readThemeOverrideEntry(themeMap, pending) {
    if (!themeMap || !pending || !pending.slotType) return null;
    if (pending.slotType === "state") {
      return pending.stateKey && themeMap.states ? themeMap.states[pending.stateKey] || null : null;
    }
    if (pending.slotType === "tier") {
      const group = pending.tierGroup && themeMap.tiers && themeMap.tiers[pending.tierGroup];
      return group && pending.originalFile ? group[pending.originalFile] || null : null;
    }
    if (pending.slotType === "idleAnimation") {
      return pending.originalFile && themeMap.idleAnimations ? themeMap.idleAnimations[pending.originalFile] || null : null;
    }
    if (pending.slotType === "reaction") {
      return pending.reactionKey && themeMap.reactions ? themeMap.reactions[pending.reactionKey] || null : null;
    }
    return null;
  }

  function prunePendingThemeOverrideEntry(themeMap, pending) {
    if (!themeMap || !pending || !pending.slotType) return;
    if (pending.slotType === "state") {
      if (themeMap.states && pending.stateKey && themeMap.states[pending.stateKey]
        && !Object.keys(themeMap.states[pending.stateKey]).length) {
        delete themeMap.states[pending.stateKey];
      }
      pruneEmptyObject(themeMap, "states");
      return;
    }
    if (pending.slotType === "tier") {
      const group = pending.tierGroup && themeMap.tiers && themeMap.tiers[pending.tierGroup];
      if (group && pending.originalFile && group[pending.originalFile] && !Object.keys(group[pending.originalFile]).length) {
        delete group[pending.originalFile];
      }
      if (themeMap.tiers) {
        pruneEmptyObject(themeMap.tiers, "workingTiers");
        pruneEmptyObject(themeMap.tiers, "jugglingTiers");
        pruneEmptyObject(themeMap, "tiers");
      }
      return;
    }
    if (pending.slotType === "idleAnimation") {
      if (themeMap.idleAnimations && pending.originalFile && themeMap.idleAnimations[pending.originalFile]
        && !Object.keys(themeMap.idleAnimations[pending.originalFile]).length) {
        delete themeMap.idleAnimations[pending.originalFile];
      }
      pruneEmptyObject(themeMap, "idleAnimations");
      return;
    }
    if (pending.slotType === "reaction") {
      if (themeMap.reactions && pending.reactionKey && themeMap.reactions[pending.reactionKey]
        && !Object.keys(themeMap.reactions[pending.reactionKey]).length) {
        delete themeMap.reactions[pending.reactionKey];
      }
      pruneEmptyObject(themeMap, "reactions");
    }
  }

  function applyPendingEditToThemeOverrides(themeMap, pending) {
    let entry = null;
    const transitionClearsDefault = pendingTransitionMatchesThemeDefault(pending);
    if ((pending.transition && !transitionClearsDefault)
      || Object.prototype.hasOwnProperty.call(pending, "durationMs")) {
      entry = ensureThemeOverrideEntry(themeMap, pending);
      if (!entry) return false;
    }
    if (pending.transition) {
      if (transitionClearsDefault) {
        const existingEntry = entry || readThemeOverrideEntry(themeMap, pending);
        if (existingEntry) delete existingEntry.transition;
      } else {
        entry.transition = { ...pending.transition };
      }
    }
    if (Object.prototype.hasOwnProperty.call(pending, "autoReturnMs")) {
      if (pending.slotType !== "state" || !pending.stateKey) return false;
      themeMap.timings = themeMap.timings || {};
      themeMap.timings.autoReturn = themeMap.timings.autoReturn || {};
      themeMap.timings.autoReturn[pending.stateKey] = pending.autoReturnMs;
    }
    if (Object.prototype.hasOwnProperty.call(pending, "durationMs")) {
      if (pending.slotType !== "idleAnimation" && pending.slotType !== "reaction") return false;
      entry.durationMs = pending.durationMs;
    }
    prunePendingThemeOverrideEntry(themeMap, pending);
    pruneThemeOverrideMap(themeMap);
    return true;
  }

  function applyPendingWideHitboxEditToThemeOverrides(themeMap, pending) {
    if (!themeMap || !pending || !pending.currentFile) return false;
    themeMap.hitbox = themeMap.hitbox || {};
    themeMap.hitbox.wide = themeMap.hitbox.wide || {};
    if (pending.commandEnabled === null) {
      delete themeMap.hitbox.wide[pending.currentFile];
    } else {
      themeMap.hitbox.wide[pending.currentFile] = pending.commandEnabled;
    }
    pruneThemeOverrideMap(themeMap);
    return true;
  }

  function pendingEditsMatchThemeOverrideBroadcast(previousSnapshot, nextSnapshot) {
    const themeId = getCurrentOverrideThemeId();
    if (!themeId || !previousSnapshot || !nextSnapshot) return false;
    const edits = getPendingAnimationOverrideEdits();
    const wideHitboxEdits = getPendingWideHitboxOverrideEdits();
    if (!edits.size && !wideHitboxEdits.size) return false;
    const expectedOverrides = clonePlainObject(previousSnapshot.themeOverrides || {});
    const expectedThemeMap = expectedOverrides[themeId] || {};
    expectedOverrides[themeId] = expectedThemeMap;
    for (const pending of edits.values()) {
      if (!applyPendingEditToThemeOverrides(expectedThemeMap, pending)) return false;
    }
    for (const pending of wideHitboxEdits.values()) {
      if (!applyPendingWideHitboxEditToThemeOverrides(expectedThemeMap, pending)) return false;
    }
    pruneThemeOverrideMap(expectedThemeMap);
    pruneEmptyObject(expectedOverrides, themeId);
    return plainObjectsEqual(expectedOverrides, nextSnapshot.themeOverrides || {});
  }

  function getAnimationAssetsSignature(data = runtime.animationOverridesData) {
    const assets = data && Array.isArray(data.assets) ? data.assets : [];
    return assets.map((asset) => [
      asset.name,
      asset.cycleMs == null ? "" : asset.cycleMs,
      asset.cycleStatus || "",
      asset.previewImageUrl || "",
    ].join(":")).join("\n");
  }

  let previewUrlCounter = 0;

  function buildAnimationPreviewUrl(fileUrl) {
    if (!fileUrl) return null;
    try {
      const url = new URL(fileUrl);
      if (url.protocol === "data:" || url.protocol === "blob:") return fileUrl;
      previewUrlCounter += 1;
      url.searchParams.set("_settingsPreview", String(previewUrlCounter));
      return url.href;
    } catch {
      return fileUrl;
    }
  }

  function appendAnimationPreviewMedia(parent, fileUrl) {
    if (!parent || !fileUrl) return false;
    const previewUrl = buildAnimationPreviewUrl(fileUrl);
    const img = document.createElement("img");
    img.src = previewUrl;
    img.alt = "";
    img.draggable = false;
    parent.appendChild(img);
    return true;
  }

  function appendAnimationPreviewPending(parent) {
    if (!parent) return false;
    const pending = document.createElement("span");
    pending.className = "anim-override-preview-pending";
    pending.setAttribute("aria-hidden", "true");
    parent.appendChild(pending);
    return true;
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
    const request = { ...base, ...patch };
    if (patch && patch.transition && card.transitionThemeDefault) {
      request.transitionThemeDefault = { ...card.transitionThemeDefault };
    }
    return request;
  }

  function getCurrentAnimationOverrideCard(card) {
    if (!card || !card.id) return card;
    return applyPendingAnimOverrideCard(getAnimOverrideCardById(card.id) || card);
  }

  function runAnimationOverrideCommand(card, patch) {
    const payload = buildAnimOverrideRequest(card, patch);
    const timingOnly = isTimingOnlyPatch(patch);
    const pendingToken = timingOnly ? recordPendingAnimationOverrideEdit(card, patch) : null;
    if (timingOnly && pendingToken) {
      syncMountedWideHitboxToggles();
      syncMountedOverrideStatusControls();
    }
    return window.settingsAPI.command("setAnimationOverride", payload).then((result) => {
      if (!result || result.status !== "ok" || result.noop) {
        clearPendingAnimationOverrideEdit(pendingToken);
        if (timingOnly) {
          syncMountedTimingSliders();
          syncMountedWideHitboxToggles();
          syncMountedOverrideStatusControls();
        }
        return result;
      }
      return ops.fetchAnimationOverridesData().then(() => {
        reconcilePendingAnimationOverrideEdits();
        reconcilePendingWideHitboxOverrideEdits();
        ops.normalizeAssetPickerSelection();
        if (timingOnly && state.activeTab === "animOverrides") {
          syncMountedTimingSliders();
          syncMountedWideHitboxToggles();
          syncMountedOverrideStatusControls();
        } else if (state.activeTab === "animOverrides") {
          ops.requestRender({ content: true });
        }
        ops.requestRender({ modal: true });
        return result;
      });
    }).catch((err) => {
      clearPendingAnimationOverrideEdit(pendingToken);
      if (timingOnly) {
        syncMountedTimingSliders();
        syncMountedWideHitboxToggles();
        syncMountedOverrideStatusControls();
      }
      ops.showToast(t("toastSaveFailed") + ((err && err.message) || "unknown error"), { error: true });
      return { status: "error", message: err && err.message };
    });
  }

  function patchInPlace(changes, context = {}) {
    if (!changes || typeof changes !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(changes, "themeOverrides")) return false;
    if (Object.keys(changes).length !== 1) return false;
    if (Object.prototype.hasOwnProperty.call(changes, "theme")
      || Object.prototype.hasOwnProperty.call(changes, "themeVariant")) {
      return false;
    }
    if (runtime.assetPicker.state) return false;
    if (runtime.animOverridesSubtab !== "animations") return false;
    if (!runtime.animationOverridesData) return false;
    if (!getPendingAnimationOverrideEdits().size && !getPendingWideHitboxOverrideEdits().size) return false;
    if (!pendingEditsMatchThemeOverrideBroadcast(context.previousSnapshot, context.snapshot)) return false;

    ops.fetchAnimationOverridesData().then(() => {
      reconcilePendingAnimationOverrideEdits();
      reconcilePendingWideHitboxOverrideEdits();
      ops.normalizeAssetPickerSelection();
      syncMountedTimingSliders();
      syncMountedWideHitboxToggles();
      syncMountedOverrideStatusControls();
      ops.requestRender({ modal: true });
    });
    return true;
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
    if (lang === "zh-TW") {
      if (maxSessions == null) return `${minSessions}+ 工作階段`;
      if (minSessions === maxSessions) return `${minSessions} 工作階段`;
      return `${minSessions}-${maxSessions} 工作階段`;
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
      case "sleeping": return "60s mouse idle";
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

  function buildAnimPreviewNode(fileUrl, { pending = false } = {}) {
    const frame = document.createElement("div");
    frame.className = "anim-override-preview-frame";
    if (!appendAnimationPreviewMedia(frame, fileUrl)) {
      if (pending) {
        appendAnimationPreviewPending(frame);
      } else {
        const glyph = document.createElement("span");
        glyph.className = "theme-thumb-empty";
        glyph.textContent = t("themeThumbMissing");
        frame.appendChild(glyph);
      }
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
      loading.textContent = t("animOverridesLoading");
      parent.appendChild(loading);
      ops.fetchAnimationOverridesData().then(() => {
        if (state.activeTab === "animOverrides") ops.requestRender({ content: true });
      });
      return;
    }

    reconcilePendingAnimationOverrideEdits();
    reconcilePendingWideHitboxOverrideEdits();
    const data = runtime.animationOverridesData;

    parent.appendChild(buildSubtabSwitcher());

    if (runtime.animOverridesSubtab === "sounds") {
      parent.appendChild(buildSoundOverridesSection(data));
    } else {
      parent.appendChild(buildAnimOverrideThemeMeta(data));
      const sections = Array.isArray(data.sections) ? data.sections : [];
      for (const section of sections) {
        if (!section || !Array.isArray(section.cards) || !section.cards.length) continue;
        parent.appendChild(buildAnimOverrideSection(section));
      }
    }
    if (runtime.assetPicker.state) ops.requestRender({ modal: true });
  }

  function buildSubtabSwitcher() {
    const wrap = document.createElement("div");
    wrap.className = "anim-override-subtabs";
    const group = document.createElement("div");
    group.className = "segmented";
    group.setAttribute("role", "tablist");

    const current = runtime.animOverridesSubtab === "sounds" ? "sounds" : "animations";
    const entries = [
      { key: "animations", label: t("animOverridesSubtabAnimations") },
      { key: "sounds", label: t("animOverridesSubtabSounds") },
    ];
    for (const entry of entries) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = entry.label;
      if (entry.key === current) btn.classList.add("active");
      btn.addEventListener("click", () => {
        if (runtime.animOverridesSubtab === entry.key) return;
        runtime.animOverridesSubtab = entry.key;
        ops.requestRender({ content: true });
      });
      group.appendChild(btn);
    }
    wrap.appendChild(group);
    return wrap;
  }

  function getSoundOverrideLabel(slot) {
    if (!slot || !slot.name) return "";
    if (slot.name === "complete") return t("soundOverridesLabelComplete");
    if (slot.name === "confirm") return t("soundOverridesLabelConfirm");
    return slot.name;
  }

  function refreshSoundOverridesUi() {
    return ops.fetchAnimationOverridesData().then(() => {
      if (state.activeTab === "animOverrides") ops.requestRender({ content: true });
    });
  }

  function runSoundPickCommand(slot) {
    return window.settingsAPI.pickSoundFile({ soundName: slot.name }).then((result) => {
      if (!result || result.status === "cancel") return result;
      const dict = i18n.STRINGS[readers.getLang()] || i18n.STRINGS.en;
      if (result.status !== "ok") {
        ops.showToast(dict.toastSoundOverrideFailed(result.message || ""), { error: true });
        return result;
      }
      ops.showToast(dict.toastSoundOverrideSetOk(slot.name, result.file || ""));
      return refreshSoundOverridesUi().then(() => result);
    });
  }

  function runSoundResetCommand(slot) {
    const themeId = getCurrentOverrideThemeId();
    if (!themeId) return Promise.resolve({ status: "error", message: "no theme" });
    return window.settingsAPI.command("setSoundOverride", {
      themeId,
      soundName: slot.name,
      file: null,
    }).then((result) => {
      if (!result || result.status !== "ok" || result.noop) return result;
      const dict = i18n.STRINGS[readers.getLang()] || i18n.STRINGS.en;
      ops.showToast(dict.toastSoundOverrideResetOk(slot.name));
      return refreshSoundOverridesUi().then(() => result);
    });
  }

  function runSoundPreview(slot) {
    return window.settingsAPI.previewSound({ soundName: slot.name }).then((result) => {
      // "skipped" means DND or mute suppressed playback — the user opted into
      // that; silently drop rather than popping an error toast.
      if (result && result.status && result.status !== "ok" && result.status !== "skipped") {
        const dict = i18n.STRINGS[readers.getLang()] || i18n.STRINGS.en;
        ops.showToast(dict.toastSoundOverrideFailed(result.message || ""), { error: true });
      }
      return result;
    });
  }

  function buildSoundOverrideRow(slot) {
    const row = document.createElement("div");
    row.className = "sound-override-row";

    const text = document.createElement("div");
    text.className = "anim-override-summary-text";

    const name = document.createElement("div");
    name.className = "anim-override-trigger";
    name.textContent = getSoundOverrideLabel(slot);
    text.appendChild(name);

    const file = document.createElement("div");
    file.className = "anim-override-file";
    // Show the user-picked filename when available (overrides rename to
    // `${soundName}${ext}` on disk, so without originalName a same-ext
    // replacement would render identically to the theme default).
    const fileText = slot.originalName || slot.currentFile || "";
    file.textContent = fileText || "—";
    if (fileText) file.title = fileText;
    text.appendChild(file);
    row.appendChild(text);

    const badges = document.createElement("div");
    badges.className = "anim-override-summary-badges";
    if (slot.overridden) {
      const badge = document.createElement("span");
      badge.className = "anim-override-badge";
      badge.title = t("soundOverridesOverriddenTooltip");
      const dot = document.createElement("span");
      dot.className = "anim-override-badge-dot";
      badge.appendChild(dot);
      badges.appendChild(badge);
    }
    row.appendChild(badges);

    const actions = document.createElement("div");
    actions.className = "sound-override-actions";

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "soft-btn";
    playBtn.textContent = t("soundOverridesPreview");
    helpers.attachActivation(playBtn, () => runSoundPreview(slot));
    actions.appendChild(playBtn);

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "soft-btn accent";
    pickBtn.textContent = t("soundOverridesChangeFile");
    helpers.attachActivation(pickBtn, () => runSoundPickCommand(slot));
    actions.appendChild(pickBtn);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "soft-btn";
    resetBtn.textContent = t("soundOverridesReset");
    resetBtn.disabled = !slot.hasStoredOverride;
    helpers.attachActivation(resetBtn, () => runSoundResetCommand(slot));
    actions.appendChild(resetBtn);

    row.appendChild(actions);
    return row;
  }

  function buildSoundOverridesSection(data) {
    const wrapper = document.createElement("section");
    wrapper.className = "anim-override-section";

    const head = document.createElement("div");
    head.className = "anim-override-section-head";
    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = t("soundOverridesSectionTitle");
    head.appendChild(title);
    const subtitle = document.createElement("div");
    subtitle.className = "anim-override-section-subtitle";
    subtitle.textContent = t("soundOverridesSectionSubtitle");
    head.appendChild(subtitle);
    wrapper.appendChild(head);

    const list = document.createElement("div");
    list.className = "anim-override-list";
    const slots = Array.isArray(data && data.sounds) ? data.sounds : [];
    if (!slots.length) {
      const empty = document.createElement("div");
      empty.className = "placeholder-desc";
      empty.textContent = t("soundOverridesEmpty");
      list.appendChild(empty);
    } else {
      for (const slot of slots) list.appendChild(buildSoundOverrideRow(slot));
    }
    wrapper.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "sound-override-footer";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "soft-btn";
    openBtn.textContent = t("soundOverridesOpenDir");
    helpers.attachActivation(openBtn, () => window.settingsAPI.openSoundOverridesDir());
    footer.appendChild(openBtn);
    wrapper.appendChild(footer);

    return wrapper;
  }

  function buildAnimOverrideThemeMeta(data) {
    const themeMeta = document.createElement("div");
    themeMeta.className = "anim-override-meta";
    const themeLabel = document.createElement("div");
    themeLabel.className = "anim-override-meta-label";
    themeLabel.textContent = `${t("animOverridesCurrentTheme")}: ${(data.theme && data.theme.name) || "clawd"}`;
    themeMeta.appendChild(themeLabel);

    const primaryActions = document.createElement("div");
    primaryActions.className = "anim-override-meta-actions anim-override-meta-primary-actions";
    const replacementLabel = document.createElement("div");
    replacementLabel.className = "anim-override-meta-label";
    replacementLabel.textContent = t("animOverridesReplacementConfig");
    const secondaryActions = document.createElement("div");
    secondaryActions.className = "anim-override-meta-actions anim-override-meta-secondary-actions";

    const themeBtn = document.createElement("button");
    themeBtn.type = "button";
    themeBtn.className = "soft-btn";
    themeBtn.textContent = t("animOverridesOpenThemeTab");
    themeBtn.addEventListener("click", () => {
      ops.selectTab("theme");
    });
    primaryActions.appendChild(themeBtn);

    const assetsBtn = document.createElement("button");
    assetsBtn.type = "button";
    assetsBtn.className = "soft-btn";
    assetsBtn.textContent = t("animOverridesOpenAssets");
    helpers.attachActivation(assetsBtn, () => window.settingsAPI.openThemeAssetsDir());
    primaryActions.appendChild(assetsBtn);

    themeMeta.appendChild(primaryActions);
    themeMeta.appendChild(replacementLabel);

    const themeId = data.theme && data.theme.id;
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
    secondaryActions.appendChild(importBtn);

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
    secondaryActions.appendChild(exportBtn);

    const resetAllBtn = document.createElement("button");
    resetAllBtn.type = "button";
    resetAllBtn.className = "soft-btn";
    resetAllBtn.textContent = t("animOverridesResetAll");
    resetAllBtn.disabled = !themeId || !readers.hasAnyThemeOverride(themeId);
    helpers.attachActivation(resetAllBtn, () =>
      window.settingsAPI.command("resetThemeOverrides", { themeId }).then((result) => {
        if (result && result.status === "ok" && !result.noop) {
          ops.showToast(t("toastAnimMapResetOk"));
        }
        return result;
      })
    );
    secondaryActions.appendChild(resetAllBtn);
    themeMeta.appendChild(secondaryActions);

    return themeMeta;
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
    const hasTransitionFlag = Object.prototype.hasOwnProperty.call(card, "hasTransitionOverride");
    const hasAutoReturnFlag = Object.prototype.hasOwnProperty.call(card, "hasAutoReturnOverride");
    const hasDurationFlag = Object.prototype.hasOwnProperty.call(card, "hasDurationOverride");
    const hasWideHitboxFlag = Object.prototype.hasOwnProperty.call(card, "wideHitboxOverridden");
    const cardFlagOverride = !!(
      (hasTransitionFlag && card.hasTransitionOverride)
      || (hasAutoReturnFlag && card.hasAutoReturnOverride)
      || (hasDurationFlag && card.hasDurationOverride)
      || (hasWideHitboxFlag && card.wideHitboxOverridden)
    );
    const map = readers.readThemeOverrideMap(themeId);
    if (!map) return cardFlagOverride;
    const hasMaterialEntryOverride = (entry) => {
      if (!entry || typeof entry !== "object") return false;
      return Object.keys(entry).some((key) => key !== "transition" && key !== "durationMs");
    };
    if (card.slotType === "tier") {
      const group = map.tiers && map.tiers[card.tierGroup];
      const entry = group && group[card.originalFile];
      return !!(hasMaterialEntryOverride(entry)
        || (hasTransitionFlag ? card.hasTransitionOverride : hasTransitionOverride(entry)));
    }
    if (card.slotType === "idleAnimation") {
      const group = map.idleAnimations;
      const entry = group && group[card.originalFile];
      return !!(hasMaterialEntryOverride(entry)
        || (hasTransitionFlag ? card.hasTransitionOverride : hasTransitionOverride(entry))
        || (hasDurationFlag ? card.hasDurationOverride : (entry && Object.prototype.hasOwnProperty.call(entry, "durationMs"))));
    }
    if (card.slotType === "reaction") {
      const entry = map.reactions && map.reactions[card.reactionKey];
      return !!(hasMaterialEntryOverride(entry)
        || (hasTransitionFlag ? card.hasTransitionOverride : hasTransitionOverride(entry))
        || (hasDurationFlag ? card.hasDurationOverride : (entry && Object.prototype.hasOwnProperty.call(entry, "durationMs"))));
    }
    const entry = map.states && map.states[card.stateKey];
    if (entry && hasMaterialEntryOverride(entry)) return true;
    if (hasTransitionFlag ? card.hasTransitionOverride : hasTransitionOverride(entry)) return true;
    const autoReturn = map.timings && map.timings.autoReturn;
    if (hasAutoReturnFlag ? card.hasAutoReturnOverride : (autoReturn && Object.prototype.hasOwnProperty.call(autoReturn, card.stateKey))) {
      return true;
    }
    const wideHitbox = map.hitbox && map.hitbox.wide;
    if (hasWideHitboxFlag) return !!card.wideHitboxOverridden;
    return !!(card.currentFile
      && wideHitbox
      && Object.prototype.hasOwnProperty.call(wideHitbox, card.currentFile));
  }

  function buildAnimOverrideRow(card) {
    card = applyPendingAnimOverrideCard(card);
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
    if (card && card.id) {
      const controls = getMountedOverrideStatusControls();
      const current = controls.get(card.id) || { cardId: card.id };
      controls.set(card.id, { ...current, row, card });
    }
    return row;
  }

  function buildAnimOverrideSummary(card) {
    const summary = document.createElement("summary");

    const chevron = helpers.createDisclosureChevron("anim-override-chevron");
    summary.appendChild(chevron);

    const thumb = document.createElement("div");
    thumb.className = "anim-override-thumb";
    thumb.title = t("animOverridesPreview");
    if (!appendAnimationPreviewMedia(thumb, getCardPreviewUrl(card)) && (card.previewPosterPending || card.needsScriptedPreviewPoster)) {
      appendAnimationPreviewPending(thumb);
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
    if (card && card.id) {
      const controls = getMountedOverrideStatusControls();
      const current = controls.get(card.id) || { cardId: card.id };
      controls.set(card.id, { ...current, summaryBadges: badges, card });
    }

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

  function runWideHitboxCommand(card, enabled, options = {}) {
    const themeId = getCurrentOverrideThemeId();
    if (!themeId || !card || !card.id || !card.currentFile) return Promise.resolve({ status: "noop" });
    if (getPendingAnimationOverrideResets().has(card.id) && !options.allowDuringReset) {
      return Promise.resolve({ status: "ok", noop: true });
    }
    if (getPendingAnimationOverrideEdits().has(card.id) && !options.allowDuringReset) {
      return Promise.resolve({ status: "ok", noop: true });
    }
    if (getPendingWideHitboxOverrideEdits().has(card.id)) return Promise.resolve({ status: "noop" });
    const pendingToken = recordPendingWideHitboxOverrideEdit(card, enabled);
    const pending = pendingToken && getPendingWideHitboxOverrideEdits().get(card.id);
    if (!pending) return Promise.resolve({ status: "noop" });
    syncMountedTimingSliders();
    syncMountedWideHitboxToggles();
    syncMountedOverrideStatusControls();
    return window.settingsAPI.command("setWideHitboxOverride", {
      themeId,
      file: card.currentFile,
      enabled: pending.commandEnabled,
    }).then((result) => {
      if (!result || result.status !== "ok" || result.noop) {
        clearPendingWideHitboxOverrideEdit(pendingToken);
        syncMountedTimingSliders();
        syncMountedWideHitboxToggles();
        syncMountedOverrideStatusControls();
        if (result && result.status === "error") {
          ops.showToast(t("toastSaveFailed") + (result.message || "unknown error"), { error: true });
        }
        return result;
      }
      return ops.fetchAnimationOverridesData().then(() => {
        if (options.clearPendingOnSuccess) clearPendingWideHitboxOverrideEdit(pendingToken);
        reconcilePendingWideHitboxOverrideEdits();
        ops.normalizeAssetPickerSelection();
        if (state.activeTab === "animOverrides") {
          syncMountedTimingSliders();
          syncMountedWideHitboxToggles();
          syncMountedOverrideStatusControls();
        }
        ops.requestRender({ modal: true });
        return result;
      });
    }).catch((err) => {
      clearPendingWideHitboxOverrideEdit(pendingToken);
      syncMountedTimingSliders();
      syncMountedWideHitboxToggles();
      syncMountedOverrideStatusControls();
      ops.showToast(t("toastSaveFailed") + ((err && err.message) || "unknown error"), { error: true });
      return { status: "error", message: err && err.message };
    });
  }

  function resetAnimationOverrideCard(card) {
    if (!card || !card.id) return Promise.resolve({ status: "noop" });
    const pendingResets = getPendingAnimationOverrideResets();
    if (pendingResets.has(card.id)
      || getPendingWideHitboxOverrideEdits().has(card.id)
      || getPendingAnimationOverrideEdits().has(card.id)) {
      return Promise.resolve({ status: "ok", noop: true });
    }
    pendingResets.add(card.id);
    syncMountedWideHitboxToggles();
    syncMountedOverrideStatusControls();
    const patch = {
      file: null,
      transition: null,
      ...(card.supportsAutoReturn ? { autoReturnMs: null } : {}),
      ...(card.supportsDuration ? { durationMs: null } : {}),
    };
    const resetHitboxFile = card.slotType !== "reaction" && card.currentFile && card.wideHitboxOverridden
      ? card.currentFile
      : null;
    const resetHitboxThemeDefault = !!card.wideHitboxThemeDefault;
    return runAnimationOverrideCommand(card, patch).then((result) => {
      if (result && result.status === "error") return result;
      const currentCard = applyPendingWideHitboxOverrideEdit(getAnimOverrideCardById(card.id) || card);
      if (currentCard.slotType === "reaction" || !resetHitboxFile) return result;
      return runWideHitboxCommand(
        {
          ...currentCard,
          currentFile: resetHitboxFile,
          wideHitboxOverridden: true,
          wideHitboxThemeDefault: resetHitboxThemeDefault,
        },
        resetHitboxThemeDefault,
        { allowDuringReset: true, clearPendingOnSuccess: true }
      );
    }).finally(() => {
      pendingResets.delete(card.id);
      syncMountedWideHitboxToggles();
      syncMountedOverrideStatusControls();
    });
  }

  function buildAnimWideHitboxToggle(card) {
    const row = document.createElement("div");
    row.className = "anim-override-toggle-row";
    const pending = isWideHitboxControlBlocked(card && card.id);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!card.wideHitboxEnabled;
    input.disabled = pending;
    input.setAttribute("aria-label", t("animOverridesWideHitboxToggle"));
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

    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "anim-override-reset-chip";
    badge.textContent = t("animOverridesWideHitboxResetToTheme");
    badge.hidden = !wideHitboxResetVisible(card);
    badge.disabled = pending || !wideHitboxResetVisible(card);
    badge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentCard = applyPendingWideHitboxOverrideEdit(getAnimOverrideCardById(card.id) || card);
      runWideHitboxCommand(currentCard, !!currentCard.wideHitboxThemeDefault);
    });
    label.appendChild(badge);

    input.addEventListener("change", () => {
      const currentCard = applyPendingWideHitboxOverrideEdit(getAnimOverrideCardById(card.id) || card);
      runWideHitboxCommand(currentCard, input.checked);
    });
    row.appendChild(input);
    row.appendChild(label);
    row.classList.toggle("pending", pending);
    if (card && card.id) {
      getMountedWideHitboxToggles().set(card.id, {
        row,
        input,
        badge,
        cardId: card.id,
        card,
      });
    }
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
    if (!appendAnimationPreviewMedia(bigPreview, getCardPreviewUrl(card)) && (card.previewPosterPending || card.needsScriptedPreviewPoster)) {
      appendAnimationPreviewPending(bigPreview);
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
      cardId: card.id,
      field: "transition.in",
      label: t("animOverridesFadeIn"),
      min: 0, max: 1000, step: 10,
      value: card.transition.in,
      onCommit: (v) => {
        const current = getCurrentAnimationOverrideCard(card);
        const transition = (current && current.transition) || card.transition || {};
        return runAnimationOverrideCommand(card, {
          transition: { in: v, out: transition.out },
        });
      },
    }));
    sliders.appendChild(buildAnimOverrideSliderRow({
      cardId: card.id,
      field: "transition.out",
      label: t("animOverridesFadeOut"),
      min: 0, max: 1000, step: 10,
      value: card.transition.out,
      onCommit: (v) => {
        const current = getCurrentAnimationOverrideCard(card);
        const transition = (current && current.transition) || card.transition || {};
        return runAnimationOverrideCommand(card, {
          transition: { in: transition.in, out: v },
        });
      },
    }));
    if (card.supportsAutoReturn) {
      const current = Number.isFinite(card.autoReturnMs) ? card.autoReturnMs : (card.suggestedDurationMs || 3000);
      sliders.appendChild(buildAnimOverrideSliderRow({
        cardId: card.id,
        field: "autoReturnMs",
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
        cardId: card.id,
        field: "durationMs",
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
    resetBtn.disabled = !isCardOverridden(card)
      || getPendingWideHitboxOverrideEdits().has(card.id)
      || getPendingAnimationOverrideResets().has(card.id)
      || getPendingAnimationOverrideEdits().has(card.id);
    helpers.attachActivation(resetBtn, () => resetAnimationOverrideCard(card));
    footer.appendChild(resetBtn);
    drawer.appendChild(footer);
    if (card && card.id) {
      const controls = getMountedOverrideStatusControls();
      const current = controls.get(card.id) || { cardId: card.id };
      controls.set(card.id, { ...current, resetBtn, card });
    }

    return drawer;
  }

  function buildAnimOverrideSliderRow({ cardId, field, label, min, max, step, value, numberMin, numberMax, onCommit }) {
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

    const numberField = document.createElement("span");
    numberField.className = "anim-override-number-field";
    numberField.appendChild(number);
    const unit = document.createElement("span");
    unit.className = "anim-override-slider-unit";
    unit.textContent = "ms";
    numberField.appendChild(unit);
    row.appendChild(numberField);

    const syncRangeFill = () => {
      const current = Number(range.value);
      const normalized = Number.isFinite(current) && max > min
        ? Math.max(0, Math.min(1, (current - min) / (max - min)))
        : 0;
      range.style.setProperty("--anim-override-fill", `${Math.round(normalized * 10000) / 100}%`);
    };
    const setValue = (nextValue) => {
      range.value = String(clampNumber(nextValue, min, max));
      number.value = String(nextValue);
      syncRangeFill();
    };
    syncRangeFill();

    let pendingValue = null;
    let committedValue = Number.isFinite(Number(value)) ? Number(value) : null;
    const commitValue = (v) => {
      if (!Number.isFinite(v)) return;
      if (isTimingControlBlocked(cardId)) return;
      if (pendingValue === v || committedValue === v) return;
      pendingValue = v;
      const result = onCommit(v);
      Promise.resolve(result).then((commandResult) => {
        if (commandResult && commandResult.status === "ok" && !commandResult.noop) {
          committedValue = v;
        }
      }).finally(() => {
        if (pendingValue === v) pendingValue = null;
      });
    };

    if (cardId && field) {
      getMountedTimingSliders().set(timingControlKey(cardId, field), {
        row,
        range,
        number,
        cardId,
        field,
        setValue: (nextValue) => {
          committedValue = Number.isFinite(Number(nextValue)) ? Number(nextValue) : committedValue;
          setValue(nextValue);
        },
      });
    }

    range.addEventListener("input", () => {
      number.value = range.value;
      syncRangeFill();
    });
    const initialBlocked = isTimingControlBlocked(cardId);
    range.disabled = initialBlocked;
    number.disabled = initialBlocked;

    range.addEventListener("change", () => {
      const v = Number(range.value);
      commitValue(v);
    });
    number.addEventListener("input", () => {
      const v = Number(number.value);
      if (Number.isFinite(v)) {
        range.value = String(clampNumber(v, min, max));
        syncRangeFill();
      }
    });
    const commitFromNumber = () => {
      const v = Number(number.value);
      commitValue(v);
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
    const previewUrl = getAssetPreviewUrl(selected);
    detail.appendChild(buildAnimPreviewNode(previewUrl, {
      pending: !!(selected && !previewUrl && selected.needsScriptedPreviewPoster),
    }));
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
                ops.showToast(t("toastSaveFailed") + (previewResult.message || "unknown error"), { error: true });
              }).catch((err) => {
                ops.showToast(t("toastSaveFailed") + ((err && err.message) || "unknown error"), { error: true });
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
      patchInPlace,
      onExit,
    };
  }

  root.ClawdSettingsTabAnimOverrides = { init };
})(globalThis);
