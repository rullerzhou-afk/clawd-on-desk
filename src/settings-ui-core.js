"use strict";

(function initSettingsUiCore(root) {
  const sizeApi = root.ClawdSettingsSizeSlider || {};
  const {
    SIZE_UI_MIN,
    SIZE_UI_MAX,
    SIZE_TICK_VALUES,
    SIZE_SLIDER_THUMB_DIAMETER,
    prefsSizeToUi,
    clampSizeUi,
    sizeUiToPct,
    getSizeSliderAnchorPx,
    createSizeSliderController,
  } = sizeApi;
  if (!createSizeSliderController) {
    throw new Error("settings-size-slider.js failed to load before settings-ui-core.js");
  }

  const i18nApi = root.ClawdSettingsI18n || {};
  const STRINGS = i18nApi.STRINGS;
  const CONTRIBUTORS = i18nApi.CONTRIBUTORS;
  const MAINTAINERS = i18nApi.MAINTAINERS;
  if (!STRINGS || !CONTRIBUTORS || !MAINTAINERS) {
    throw new Error("settings-i18n.js failed to load before settings-ui-core.js");
  }

  const animMergeApi = root.ClawdSettingsAnimOverridesMerge || {};
  const mergePosterCacheIntoAnimationData = animMergeApi.mergePosterCacheIntoAnimationData
    || ((data) => data);
  const applyAnimationPosterPayloadToRuntime = animMergeApi.applyAnimationPosterPayload
    || (() => ({ valid: false, stored: false, applied: false }));

  const shortcutApi = root.ClawdShortcutActions || {};
  const SHORTCUT_ACTIONS = shortcutApi.SHORTCUT_ACTIONS || {};
  const SHORTCUT_ACTION_IDS = shortcutApi.SHORTCUT_ACTION_IDS || Object.keys(SHORTCUT_ACTIONS);
  const buildAcceleratorFromEvent = shortcutApi.buildAcceleratorFromEvent
    || (() => ({ action: "reject", reason: "That key combination is not supported." }));
  const formatAcceleratorLabel = shortcutApi.formatAcceleratorLabel
    || ((value) => value || "— unassigned —");
  const formatAcceleratorPartial = shortcutApi.formatAcceleratorPartial
    || (() => "");

  // startsWith("Mac") not /\bMac\b/ — "MacIntel" has \w after "c", fails \b (regression #135).
  const IS_MAC = (navigator.platform || "").startsWith("Mac");
  const COLLAPSED_GROUPS_STORAGE_KEY = "clawd.settings.collapsedGroups.v1";

  const state = {
    snapshot: null,
    activeTab: "general",
    transientUiState: {
      generalSwitches: new Map(),
      agentSwitches: new Map(),
      animMapSwitches: new Map(),
      size: {
        draftUi: null,
        dragging: false,
        pending: false,
        seq: 0,
      },
    },
    mountedControls: {
      generalSwitches: new Map(),
      bubblePolicyControls: new Map(),
      agentSwitches: new Map(),
      agentPermissionModes: new Map(),
      animMapSwitches: new Map(),
      animMapReset: null,
      animOverrideTimingSliders: new Map(),
      bubblePolicySummary: null,
      size: null,
      soundVolume: null,
    },
    shortcutRecordingActionId: null,
    shortcutRecordingError: "",
    shortcutRecordingPartial: [],
    nextTransientUiSeq: 1,
  };

  const runtime = {
    agentMetadata: null,
    themeList: null,
    codexPetsRefreshPending: false,
    codexPetZipImportPending: false,
    codexPetRemovalPendingThemeId: null,
    animationOverridesData: null,
    animationOverridesFetchSeq: 0,
    animationPosterRenderPending: false,
    animationPosterRenderFlags: null,
    animationPreviewPosterCache: new Map(),
    pendingAnimationOverrideEdits: new Map(),
    nextAnimationOverrideEditSeq: 1,
    animOverridesSubtab: "animations",
    expandedOverrideRowIds: new Set(),
    assetPicker: {
      state: null,
      pollTimer: null,
    },
    shortcutFailures: {},
    shortcutFailureToastShown: false,
    about: {
      infoCache: null,
      clickCount: 0,
      contributorsExpanded: false,
    },
    languageTransition: null,
  };

  const renderHooks = {
    sidebar: null,
    content: null,
    modal: null,
  };

  const tabs = {};
  const toastStack = document.getElementById("toastStack");
  const core = {
    state,
    runtime,
    renderHooks,
    tabs,
  };

  function readSizeUiFromSnapshot() {
    const value = state.snapshot && state.snapshot.size;
    if (typeof value === "string" && value.startsWith("P:")) {
      const parsed = parseFloat(value.slice(2));
      if (Number.isFinite(parsed) && parsed > 0) return clampSizeUi(prefsSizeToUi(parsed));
    }
    return clampSizeUi(prefsSizeToUi(10));
  }

  function readGeneralSwitchRaw(key) {
    return !!(state.snapshot && state.snapshot[key]);
  }

  function readGeneralSwitchVisual(key, invert = false) {
    const rawValue = readGeneralSwitchRaw(key);
    return invert ? !rawValue : rawValue;
  }

  function agentSwitchStateId(agentId, flag) {
    return `${agentId}:${flag}`;
  }

  function readAgentFlagValue(agentId, flag) {
    const entry = state.snapshot && state.snapshot.agents && state.snapshot.agents[agentId];
    return entry ? entry[flag] !== false : true;
  }

  function readAgentPermissionMode(agentId) {
    const entry = state.snapshot && state.snapshot.agents && state.snapshot.agents[agentId];
    if (agentId === "codex" && entry && entry.permissionMode === "intercept") return "intercept";
    return "native";
  }

  function getShortcutValue(actionId) {
    const shortcuts = state.snapshot && state.snapshot.shortcuts;
    if (!shortcuts || typeof shortcuts !== "object") return null;
    return shortcuts[actionId] ?? null;
  }

  function getLang() {
    return (state.snapshot && state.snapshot.lang) || "en";
  }

  function readThemeOverrideMap(themeId) {
    const all = state.snapshot && state.snapshot.themeOverrides;
    const map = all && all[themeId];
    if (!map || typeof map !== "object") return null;
    const keys = [
      ...(map.states ? Object.keys(map.states) : []),
      ...(map.tiers && map.tiers.workingTiers ? Object.keys(map.tiers.workingTiers) : []),
      ...(map.tiers && map.tiers.jugglingTiers ? Object.keys(map.tiers.jugglingTiers) : []),
      ...(map.timings && map.timings.autoReturn ? Object.keys(map.timings.autoReturn) : []),
    ];
    return keys.length > 0 ? map : null;
  }

  function hasAnyThemeOverride(themeId) {
    const all = state.snapshot && state.snapshot.themeOverrides;
    const map = all && all[themeId];
    if (!map || typeof map !== "object") return false;
    const keys = [
      ...(map.states ? Object.keys(map.states) : []),
      ...(map.tiers && map.tiers.workingTiers ? Object.keys(map.tiers.workingTiers) : []),
      ...(map.tiers && map.tiers.jugglingTiers ? Object.keys(map.tiers.jugglingTiers) : []),
      ...(map.timings && map.timings.autoReturn ? Object.keys(map.timings.autoReturn) : []),
      ...(map.idleAnimations ? Object.keys(map.idleAnimations) : []),
      ...(map.reactions ? Object.keys(map.reactions) : []),
      ...(map.hitbox ? Object.keys(map.hitbox) : []),
      ...(map.sounds ? Object.keys(map.sounds) : []),
    ];
    return keys.length > 0;
  }

  function t(key) {
    const dict = STRINGS[getLang()] || STRINGS.en || {};
    return dict[key] || key;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function showToast(message, { error = false, ttl = 3500 } = {}) {
    if (!toastStack) return;
    const node = document.createElement("div");
    node.className = "toast" + (error ? " error" : "");
    node.textContent = message;
    toastStack.appendChild(node);
    node.offsetHeight;
    node.classList.add("visible");
    setTimeout(() => {
      node.classList.remove("visible");
      setTimeout(() => node.remove(), 240);
    }, ttl);
  }

  function setSwitchVisual(sw, visualOn, { pending = false } = {}) {
    sw.classList.toggle("on", !!visualOn);
    sw.classList.toggle("pending", !!pending);
    sw.setAttribute("aria-checked", visualOn ? "true" : "false");
  }

  function attachAnimatedSwitch(sw, {
    getCommittedVisual,
    getTransientState,
    setTransientState,
    clearTransientState,
    invoke,
  }) {
    const run = () => {
      if (sw.classList.contains("disabled") || sw.getAttribute("aria-disabled") === "true") return;
      if (sw.classList.contains("pending")) return;
      const currentVisual = getCommittedVisual();
      const nextVisual = !currentVisual;
      const seq = state.nextTransientUiSeq++;
      setTransientState({ visualOn: nextVisual, pending: true, seq });
      setSwitchVisual(sw, nextVisual, { pending: true });
      Promise.resolve()
        .then(invoke)
        .then((result) => {
          const current = getTransientState();
          if (!current || current.seq !== seq) return;
          if (!result || result.status !== "ok" || result.noop) {
            clearTransientState(seq);
            setSwitchVisual(sw, getCommittedVisual(), { pending: false });
            if (result && result.noop) return;
            const msg = (result && result.message) || "unknown error";
            showToast(t("toastSaveFailed") + msg, { error: true });
            return;
          }
          clearTransientState(seq);
          setSwitchVisual(sw, nextVisual, { pending: false });
        })
        .catch((err) => {
          const current = getTransientState();
          if (!current || current.seq !== seq) return;
          clearTransientState(seq);
          setSwitchVisual(sw, getCommittedVisual(), { pending: false });
          showToast(t("toastSaveFailed") + (err && err.message), { error: true });
        });
    };
    sw.addEventListener("click", run);
    sw.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        run();
      }
    });
  }

  function buildSection(title, rows) {
    const section = document.createElement("section");
    section.className = "section";
    if (title) {
      const heading = document.createElement("h2");
      heading.className = "section-title";
      heading.textContent = title;
      section.appendChild(heading);
    }
    const wrap = document.createElement("div");
    wrap.className = "section-rows";
    for (const row of rows) wrap.appendChild(row);
    section.appendChild(wrap);
    return section;
  }

  function readCollapsedGroupState() {
    try {
      const raw = localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY);
      const parsed = JSON.parse(raw || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeCollapsedGroupState(value) {
    try {
      localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(value || {}));
    } catch (_) {}
  }

  function buildCollapsibleGroup({
    id,
    title = "",
    desc = "",
    summary = null,
    headerContent = null,
    children = [],
    defaultCollapsed = false,
    className = "",
  }) {
    const storedState = readCollapsedGroupState();
    let collapsed = Object.prototype.hasOwnProperty.call(storedState, id)
      ? storedState[id] === true
      : !!defaultCollapsed;

    const group = document.createElement("div");
    group.className = `row collapsible-group${className ? ` ${className}` : ""}`;
    group.dataset.groupId = id;

    const header = document.createElement("div");
    header.className = "collapsible-group-header";
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");

    const chevron = document.createElement("span");
    chevron.className = "collapsible-group-chevron";
    chevron.textContent = "\u25B8";
    chevron.setAttribute("aria-hidden", "true");
    header.appendChild(chevron);

    if (headerContent) {
      const headerWrap = document.createElement("div");
      headerWrap.className = "collapsible-group-header-content";
      headerWrap.appendChild(headerContent);
      header.appendChild(headerWrap);
    } else {
      const text = document.createElement("div");
      text.className = "collapsible-group-text";
      const label = document.createElement("span");
      label.className = "row-label";
      label.textContent = title;
      text.appendChild(label);
      if (desc) {
        const description = document.createElement("span");
        description.className = "row-desc";
        description.textContent = desc;
        text.appendChild(description);
      }
      header.appendChild(text);
    }

    if (summary) {
      const summaryWrap = document.createElement("div");
      summaryWrap.className = "collapsibleSummary collapsible-group-summary";
      if (typeof summary === "string") summaryWrap.textContent = summary;
      else summaryWrap.appendChild(summary);
      header.appendChild(summaryWrap);
    }

    const body = document.createElement("div");
    body.className = "collapsible-group-body";
    for (const child of children) body.appendChild(child);

    function measureCollapsibleBodyHeight() {
      return `${body.scrollHeight}px`;
    }

    function isGroupConnected() {
      return !!(document.body && document.body.contains(group));
    }

    function setExpandedBodyHeight() {
      body.style.setProperty("--collapsible-body-height", measureCollapsibleBodyHeight());
    }

    function setBodyInteractivity(isCollapsed) {
      body.setAttribute("aria-hidden", isCollapsed ? "true" : "false");
      if ("inert" in body) {
        body.inert = isCollapsed;
      } else if (isCollapsed) {
        body.setAttribute("inert", "");
      } else {
        body.removeAttribute("inert");
      }
    }

    function preserveScrollAnchor(invoke) {
      const scroller = document.getElementById("content");
      if (!scroller || !document.body.contains(header)) {
        invoke();
        return;
      }
      const beforeTop = header.getBoundingClientRect().top;
      const beforeScrollTop = scroller.scrollTop;
      invoke();
      requestAnimationFrame(() => {
        if (!document.body.contains(header)) return;
        const afterTop = header.getBoundingClientRect().top;
        const delta = afterTop - beforeTop;
        if (delta !== 0) scroller.scrollTop = beforeScrollTop + delta;
      });
    }

    function applyCollapsedState({ animate = false } = {}) {
      header.setAttribute("aria-expanded", collapsed ? "false" : "true");
      header.setAttribute("aria-label", collapsed ? t("collapsibleExpand") : t("collapsibleCollapse"));
      group.classList.remove("expanding", "collapsing");
      if (!animate) {
        group.classList.toggle("collapsed", collapsed);
        setBodyInteractivity(collapsed);
        if (collapsed) {
          body.style.setProperty("--collapsible-body-height", "0px");
        } else {
          // Detached groups report scrollHeight=0 in some engines. Keep the
          // body fully expanded until the post-mount RAF can measure a real height.
          body.style.setProperty(
            "--collapsible-body-height",
            isGroupConnected() ? measureCollapsibleBodyHeight() : "none"
          );
        }
        return;
      }

      if (collapsed) {
        group.classList.add("collapsing");
        setBodyInteractivity(true);
        setExpandedBodyHeight();
        requestAnimationFrame(() => {
          group.classList.add("collapsed");
          body.style.setProperty("--collapsible-body-height", "0px");
        });
        return;
      }

      group.classList.add("expanding", "collapsed");
      setBodyInteractivity(false);
      body.style.setProperty("--collapsible-body-height", "0px");
      requestAnimationFrame(() => {
        group.classList.remove("collapsed");
        setExpandedBodyHeight();
      });
    }

    function toggleCollapsed() {
      collapsed = !collapsed;
      const nextState = readCollapsedGroupState();
      nextState[id] = collapsed;
      writeCollapsedGroupState(nextState);
      preserveScrollAnchor(() => applyCollapsedState({ animate: true }));
    }

    header.addEventListener("click", toggleCollapsed);
    header.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        toggleCollapsed();
      }
    });

    group.appendChild(header);
    group.appendChild(body);
    body.addEventListener("transitionend", (ev) => {
      if (ev.target !== body || ev.propertyName !== "max-height") return;
      group.classList.remove("expanding", "collapsing");
      if (!collapsed) setExpandedBodyHeight();
    });
    applyCollapsedState();
    requestAnimationFrame(() => {
      if (!collapsed) setExpandedBodyHeight();
    });
    return group;
  }

  function attachActivation(el, invoke) {
    const run = () => {
      if (el.classList.contains("pending")) return;
      el.classList.add("pending");
      Promise.resolve()
        .then(invoke)
        .then((result) => {
          el.classList.remove("pending");
          if (!result || result.status !== "ok") {
            const msg = (result && result.message) || "unknown error";
            showToast(t("toastSaveFailed") + msg, { error: true });
          }
        })
        .catch((err) => {
          el.classList.remove("pending");
          showToast(t("toastSaveFailed") + (err && err.message), { error: true });
        });
    };
    el.addEventListener("click", run);
    el.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        run();
      }
    });
  }

  function buildSwitchRow({
    key,
    labelKey,
    descKey,
    invert = false,
    disabled = false,
    descExtraKey = null,
    onToggle = null,
    actionButton = null,
  }) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
    row.querySelector(".row-label").textContent = t(labelKey);
    const text = row.querySelector(".row-text");
    row.querySelector(".row-desc").textContent = t(descKey);
    let extraElement = null;
    if (descExtraKey) {
      const extra = document.createElement("span");
      extra.className = "row-desc row-desc-extra";
      extra.textContent = t(descExtraKey);
      text.appendChild(extra);
      extraElement = extra;
    }
    const sw = row.querySelector(".switch");
    const control = row.querySelector(".row-control");
    const override = state.transientUiState.generalSwitches.get(key);
    const visualOn = override ? override.visualOn : readGeneralSwitchVisual(key, invert);
    setSwitchVisual(sw, visualOn, { pending: override ? override.pending : false });
    state.mountedControls.generalSwitches.set(key, { element: sw, invert, row, text, extraElement });
    if (actionButton) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "soft-btn accent";
      btn.textContent = t(actionButton.labelKey);
      control.insertBefore(btn, sw);
      attachActivation(btn, actionButton.invoke);
    }
    if (disabled) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.tabIndex = -1;
    }
    attachAnimatedSwitch(sw, {
      getCommittedVisual: () => readGeneralSwitchVisual(key, invert),
      getTransientState: () => state.transientUiState.generalSwitches.get(key) || null,
      setTransientState: (value) => state.transientUiState.generalSwitches.set(key, value),
      clearTransientState: (seq) => {
        const current = state.transientUiState.generalSwitches.get(key);
        if (!current || (seq !== undefined && current.seq !== seq)) return;
        state.transientUiState.generalSwitches.delete(key);
      },
      invoke: () => {
        const currentRaw = readGeneralSwitchRaw(key);
        const currentVisual = invert ? !currentRaw : currentRaw;
        const nextVisual = !currentVisual;
        const nextRaw = invert ? !nextVisual : nextVisual;
        if (typeof onToggle === "function") {
          return onToggle({ currentRaw, currentVisual, nextRaw });
        }
        return window.settingsAPI.update(key, nextRaw);
      },
    });
    return row;
  }

  function buildShortcutButton(label, onClick, { disabled = false, accent = false } = {}) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn" + (accent ? " accent" : "");
    btn.textContent = label;
    if (disabled) {
      btn.disabled = true;
      return btn;
    }
    btn.addEventListener("click", onClick);
    return btn;
  }

  function openExternalSafe(url) {
    if (!url) return;
    if (!window.settingsAPI || typeof window.settingsAPI.openExternal !== "function") return;
    window.settingsAPI.openExternal(url).then((result) => {
      if (result && result.status === "error") {
        showToast(t("aboutOpenExternalFailed"), { error: true });
      }
    }).catch(() => {
      showToast(t("aboutOpenExternalFailed"), { error: true });
    });
  }

  function clearMountedControls() {
    if (state.mountedControls.size && typeof state.mountedControls.size.dispose === "function") {
      Promise.resolve(state.mountedControls.size.dispose()).catch(() => {});
    }
    if (state.mountedControls.soundVolume && typeof state.mountedControls.soundVolume.dispose === "function") {
      state.mountedControls.soundVolume.dispose();
    }
    state.mountedControls.generalSwitches.clear();
    state.mountedControls.bubblePolicyControls.clear();
    state.mountedControls.agentSwitches.clear();
    state.mountedControls.agentPermissionModes.clear();
    state.mountedControls.animMapSwitches.clear();
    state.mountedControls.animMapReset = null;
    state.mountedControls.animOverrideTimingSliders.clear();
    state.mountedControls.bubblePolicySummary = null;
    state.mountedControls.size = null;
    state.mountedControls.soundVolume = null;
  }

  function syncMountedSizeControl({ fromBroadcast = false } = {}) {
    const control = state.mountedControls.size;
    if (!control || !document.body.contains(control.row)) return false;
    control.syncFromSnapshot({ fromBroadcast });
    return true;
  }

  function installRenderHooks(hooks) {
    if (!hooks || typeof hooks !== "object") return;
    if (Object.prototype.hasOwnProperty.call(hooks, "sidebar")) {
      renderHooks.sidebar = hooks.sidebar;
    }
    if (Object.prototype.hasOwnProperty.call(hooks, "content")) {
      renderHooks.content = hooks.content;
    }
    if (Object.prototype.hasOwnProperty.call(hooks, "modal")) {
      renderHooks.modal = hooks.modal;
    }
  }

  function requestRender({ sidebar = false, content = false, modal = false } = {}) {
    if (sidebar && typeof renderHooks.sidebar === "function") renderHooks.sidebar();
    if (content && typeof renderHooks.content === "function") renderHooks.content();
    if (modal && typeof renderHooks.modal === "function") renderHooks.modal();
  }

  function selectTab(nextTab) {
    const prevTabId = state.activeTab;
    if (prevTabId === nextTab) return;
    const prevTab = tabs[prevTabId];
    if (prevTab && typeof prevTab.onExit === "function") {
      prevTab.onExit(core);
    }
    state.activeTab = nextTab;
    requestRender({ sidebar: true, content: true, modal: true });
  }

  function applyBootstrap(snapshotValue) {
    state.snapshot = snapshotValue || {};
    requestRender({ sidebar: true, content: true, modal: true });
  }

  function applyAgentMetadata(list) {
    runtime.agentMetadata = Array.isArray(list) ? list : [];
    if (state.activeTab === "agents") requestRender({ content: true });
  }

  function fetchThemes() {
    if (!window.settingsAPI || typeof window.settingsAPI.listThemes !== "function") {
      runtime.themeList = [];
      return Promise.resolve([]);
    }
    return window.settingsAPI.listThemes().then((list) => {
      runtime.themeList = Array.isArray(list) ? list : [];
      return runtime.themeList;
    }).catch((err) => {
      console.warn("settings: listThemes failed", err);
      runtime.themeList = [];
      return [];
    });
  }

  function emptyAnimationOverridesData() {
    return { theme: null, assets: [], sections: [], cards: [], sounds: [] };
  }

  function fetchAnimationOverridesData() {
    const seq = runtime.animationOverridesFetchSeq + 1;
    runtime.animationOverridesFetchSeq = seq;
    if (!window.settingsAPI || typeof window.settingsAPI.getAnimationOverridesData !== "function") {
      runtime.animationOverridesData = emptyAnimationOverridesData();
      return Promise.resolve(runtime.animationOverridesData);
    }
    return window.settingsAPI.getAnimationOverridesData().then((data) => {
      if (seq !== runtime.animationOverridesFetchSeq) return runtime.animationOverridesData;
      runtime.animationOverridesData = mergePosterCacheIntoAnimationData(
        data || emptyAnimationOverridesData(),
        runtime.animationPreviewPosterCache
      );
      return runtime.animationOverridesData;
    }).catch((err) => {
      if (seq !== runtime.animationOverridesFetchSeq) return runtime.animationOverridesData;
      console.warn("settings: getAnimationOverridesData failed", err);
      if (!runtime.animationOverridesData) runtime.animationOverridesData = emptyAnimationOverridesData();
      return runtime.animationOverridesData;
    });
  }

  function requestAnimationPosterRender({ content = false, modal = false } = {}) {
    if (!content && !modal) return;
    runtime.animationPosterRenderFlags = {
      content: !!(content || (runtime.animationPosterRenderFlags && runtime.animationPosterRenderFlags.content)),
      modal: !!(modal || (runtime.animationPosterRenderFlags && runtime.animationPosterRenderFlags.modal)),
    };
    if (runtime.animationPosterRenderPending) return;
    runtime.animationPosterRenderPending = true;
    requestAnimationFrame(() => {
      const flags = runtime.animationPosterRenderFlags || {};
      runtime.animationPosterRenderPending = false;
      runtime.animationPosterRenderFlags = null;
      requestRender({ content: !!flags.content, modal: !!flags.modal });
    });
  }

  function applyAnimationPreviewPoster(payload) {
    const result = applyAnimationPosterPayloadToRuntime(runtime, payload, {
      warn: (message, value) => console.warn(message, value),
    });
    if (!result || !result.valid || !result.applied) return;
    requestAnimationPosterRender({
      content: state.activeTab === "animOverrides" && runtime.animOverridesSubtab === "animations",
      modal: !!runtime.assetPicker.state,
    });
  }

  function stopAssetPickerPolling() {
    if (runtime.assetPicker.pollTimer) {
      clearInterval(runtime.assetPicker.pollTimer);
      runtime.assetPicker.pollTimer = null;
    }
  }

  function closeAssetPicker() {
    runtime.assetPicker.state = null;
    stopAssetPickerPolling();
    requestRender({ modal: true });
  }

  function normalizeAssetPickerSelection() {
    if (!runtime.assetPicker.state || !runtime.animationOverridesData) return;
    const assets = Array.isArray(runtime.animationOverridesData.assets) ? runtime.animationOverridesData.assets : [];
    if (!assets.length) {
      runtime.assetPicker.state.selectedFile = null;
      return;
    }
    const stillExists = assets.some((asset) => asset.name === runtime.assetPicker.state.selectedFile);
    if (!stillExists) runtime.assetPicker.state.selectedFile = assets[0].name;
  }

  function translateShortcutError(message) {
    if (!message) return "";
    const conflictMatch = /^conflict: already bound to (.+)$/.exec(message);
    if (conflictMatch) {
      const meta = SHORTCUT_ACTIONS[conflictMatch[1]];
      const other = meta ? t(meta.labelKey) : conflictMatch[1];
      return t("shortcutErrorConflict").replace("{other}", other);
    }
    if (message === "reserved accelerator") return t("shortcutErrorReserved");
    if (message === "invalid accelerator format") return t("shortcutErrorInvalid");
    if (message === "must include modifier") return t("shortcutErrorNeedsModifier");
    if (message.includes("unregister of old accelerator failed")) return t("shortcutErrorSystemConflict");
    if (message.includes("system conflict")) return t("shortcutErrorSystemConflict");
    return message;
  }

  function finishShortcutRecording() {
    if (!state.shortcutRecordingActionId) return Promise.resolve();
    state.shortcutRecordingActionId = null;
    state.shortcutRecordingError = "";
    state.shortcutRecordingPartial = [];
    if (state.activeTab === "shortcuts") requestRender({ content: true });
    if (!window.settingsAPI || typeof window.settingsAPI.exitShortcutRecording !== "function") {
      return Promise.resolve();
    }
    return window.settingsAPI.exitShortcutRecording().catch(() => {});
  }

  function enterShortcutRecording(actionId) {
    if (!window.settingsAPI || typeof window.settingsAPI.enterShortcutRecording !== "function") {
      showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    state.shortcutRecordingError = "";
    state.shortcutRecordingPartial = [];
    window.settingsAPI.enterShortcutRecording(actionId).then((result) => {
      if (!result || result.status !== "ok") {
        showToast(t("toastSaveFailed") + ((result && result.message) || "unknown error"), { error: true });
        return;
      }
      state.shortcutRecordingActionId = actionId;
      state.shortcutRecordingError = "";
      state.shortcutRecordingPartial = [];
      if (state.activeTab === "shortcuts") requestRender({ content: true });
    }).catch((err) => {
      showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    });
  }

  function handleShortcutRecordKey(payload) {
    if (!state.shortcutRecordingActionId) return;
    const built = buildAcceleratorFromEvent(payload, { isMac: IS_MAC });
    if (!built) return;
    if (built.action === "pending") {
      const nextPartial = Array.isArray(built.modifiers) ? built.modifiers : [];
      const changed = nextPartial.length !== state.shortcutRecordingPartial.length
        || nextPartial.some((m, i) => m !== state.shortcutRecordingPartial[i]);
      if (changed) {
        state.shortcutRecordingPartial = nextPartial;
        if (state.activeTab === "shortcuts") requestRender({ content: true });
      }
      return;
    }
    if (built.action === "cancel") {
      finishShortcutRecording();
      return;
    }
    if (built.action === "reject") {
      state.shortcutRecordingError = translateShortcutError(built.reason);
      state.shortcutRecordingPartial = [];
      if (state.activeTab === "shortcuts") requestRender({ content: true });
      return;
    }
    const targetActionId = state.shortcutRecordingActionId;
    const prevValue = getShortcutValue(targetActionId);
    window.settingsAPI.command("registerShortcut", {
      actionId: targetActionId,
      accelerator: built.accelerator,
    }).then((result) => {
      if (result && result.status === "ok") {
        finishShortcutRecording();
        if (prevValue !== built.accelerator) {
          showToast(t("shortcutToastSaved"));
        }
        return;
      }
      state.shortcutRecordingError = translateShortcutError(result && result.message);
      if (state.activeTab === "shortcuts") requestRender({ content: true });
    }).catch((err) => {
      state.shortcutRecordingError = (err && err.message) || "";
      if (state.activeTab === "shortcuts") requestRender({ content: true });
    });
  }

  function applyShortcutFailures(failures) {
    runtime.shortcutFailures = failures || {};
    if (!runtime.shortcutFailureToastShown && Object.keys(runtime.shortcutFailures).length > 0) {
      runtime.shortcutFailureToastShown = true;
      showToast(t("shortcutErrorRegistrationFailed"), { error: true });
    }
    if (state.activeTab === "shortcuts") requestRender({ content: true });
  }

  function clearTransientStateForChanges(changes) {
    if (!changes || typeof changes !== "object") return;
    for (const key of Object.keys(changes)) {
      state.transientUiState.generalSwitches.delete(key);
    }
    if (Object.prototype.hasOwnProperty.call(changes, "agents")) {
      state.transientUiState.agentSwitches.clear();
    }
    if (Object.prototype.hasOwnProperty.call(changes, "themeOverrides")) {
      state.transientUiState.animMapSwitches.clear();
    }
  }

  function applyChanges(payload) {
    const previousLang = getLang();
    const previousSnapshot = state.snapshot;
    if (payload && payload.snapshot) {
      state.snapshot = payload.snapshot;
    } else if (payload && payload.changes && state.snapshot) {
      state.snapshot = { ...state.snapshot, ...payload.changes };
    }
    if (!state.snapshot) return;

    const changes = payload && payload.changes;
    if (changes && Object.prototype.hasOwnProperty.call(changes, "lang")) {
      const nextLang = getLang();
      runtime.languageTransition = state.activeTab === "general" && previousLang !== nextLang
        ? { from: previousLang, to: nextLang }
        : null;
    }
    clearTransientStateForChanges(changes);
    const needsAnimOverridesRefresh = !!(changes && (
      "theme" in changes || "themeVariant" in changes || "themeOverrides" in changes
    ));
    if (changes && (
      Object.prototype.hasOwnProperty.call(changes, "theme")
      || Object.prototype.hasOwnProperty.call(changes, "themeVariant")
    )) {
      if (runtime.pendingAnimationOverrideEdits && typeof runtime.pendingAnimationOverrideEdits.clear === "function") {
        runtime.pendingAnimationOverrideEdits.clear();
      }
      if (state.mountedControls.animOverrideTimingSliders
        && typeof state.mountedControls.animOverrideTimingSliders.clear === "function") {
        state.mountedControls.animOverrideTimingSliders.clear();
      }
    }
    const shouldPreserveAnimOverridesData = !!(
      needsAnimOverridesRefresh
      && (state.activeTab === "animOverrides" || runtime.assetPicker.state)
    );
    if (needsAnimOverridesRefresh && !shouldPreserveAnimOverridesData) {
      runtime.animationOverridesData = null;
    }

    const activeTab = tabs[state.activeTab];
    if (activeTab && typeof activeTab.patchInPlace === "function"
      && activeTab.patchInPlace(changes, { previousSnapshot, snapshot: state.snapshot })) {
      return;
    }

    if (changes && "themeOverrides" in changes) {
      if (state.activeTab === "theme") {
        fetchThemes().then(() => {
          requestRender({ sidebar: true, content: true });
        });
        return;
      }
      if (state.activeTab === "animOverrides" || runtime.assetPicker.state) {
        fetchAnimationOverridesData().then(() => {
          normalizeAssetPickerSelection();
          requestRender({ sidebar: true, content: true, modal: true });
        });
        return;
      }
      if (state.activeTab !== "animMap") {
        requestRender({ sidebar: true, content: true });
        return;
      }
    }

    if (needsAnimOverridesRefresh && (state.activeTab === "animOverrides" || runtime.assetPicker.state)) {
      fetchAnimationOverridesData().then(() => {
        normalizeAssetPickerSelection();
        requestRender({ sidebar: true, content: true, modal: true });
      });
      return;
    }

    if (changes && "theme" in changes && runtime.themeList) {
      runtime.themeList = runtime.themeList.map((theme) => ({
        ...theme,
        active: theme.id === changes.theme,
      }));
    }

    requestRender({ sidebar: true, content: true });
  }

  core.readers = {
    readSizeUiFromSnapshot,
    readGeneralSwitchRaw,
    readGeneralSwitchVisual,
    agentSwitchStateId,
    readAgentFlagValue,
    readAgentPermissionMode,
    getShortcutValue,
    getLang,
    readThemeOverrideMap,
    hasAnyThemeOverride,
  };

  core.helpers = {
    t,
    escapeHtml,
    setSwitchVisual,
    attachAnimatedSwitch,
    buildSwitchRow,
    buildSection,
    buildCollapsibleGroup,
    attachActivation,
    buildShortcutButton,
    openExternalSafe,
    SIZE_UI_MIN,
    SIZE_UI_MAX,
    SIZE_TICK_VALUES,
    SIZE_SLIDER_THUMB_DIAMETER,
    sizeUiToPct,
    getSizeSliderAnchorPx,
    createSizeSliderController,
  };

  core.i18n = {
    STRINGS,
    MAINTAINERS,
    CONTRIBUTORS,
    IS_MAC,
    SHORTCUT_ACTIONS,
    SHORTCUT_ACTION_IDS,
    buildAcceleratorFromEvent,
    formatAcceleratorLabel,
    formatAcceleratorPartial,
  };

  core.ops = {
    installRenderHooks,
    requestRender,
    selectTab,
    applyBootstrap,
    applyAgentMetadata,
    applyChanges,
    clearMountedControls,
    syncMountedSizeControl,
    showToast,
    enterShortcutRecording,
    finishShortcutRecording,
    handleShortcutRecordKey,
    applyShortcutFailures,
    fetchThemes,
    fetchAnimationOverridesData,
    applyAnimationPreviewPoster,
    stopAssetPickerPolling,
    closeAssetPicker,
    normalizeAssetPickerSelection,
    translateShortcutError,
  };

  root.ClawdSettingsCore = core;
})(globalThis);
