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
  const selectPickerApi = root.ClawdLanguagePicker || {};

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
  const IS_WIN = (navigator.platform || "").startsWith("Win");
  const COLLAPSED_GROUPS_STORAGE_KEY = "clawd.settings.collapsedGroups.v1";
  const NAVIGATION_STORAGE_KEY = "clawd.settings.navigation.v1";
  const MAX_PERSISTED_SCROLL_TOP = 10_000_000;
  // Runtime-only geometry belongs in the snapshot for consistency, but has no
  // mounted Settings control. Re-rendering for it would destroy focused inputs
  // and reset the active tab's scroll position after every window move/resize.
  const RENDERER_INERT_SETTINGS_KEYS = new Set(["settingsWindowBounds", "dashboardWindowBounds"]);

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
      sessionCleanupControls: new Map(),
      agentSwitches: new Map(),
      agentPermissionModes: new Map(),
      agentIntegrationActions: new Map(),
      animMapSwitches: new Map(),
      animMapReset: null,
      animOverrideTimingSliders: new Map(),
      idleVisualPicker: null,
      bubblePolicySummary: null,
      sessionHudSummary: null,
      size: null,
      soundSummary: null,
      soundVolume: null,
      textScale: null,
      roamMovementStyle: null,
      bubblePlacement: null,
      roamArea: null,
      settingsSelects: new Set(),
      segmentedRadios: new Set(),
      disposableScopes: new Map(),
      quotaRingDisplayMode: null,
      permissionAutomationMode: null,
      aboutAutoUpdate: null,
      aboutUpdateStatus: null,
    },
    shortcutRecordingActionId: null,
    shortcutRecordingError: "",
    shortcutRecordingPartial: [],
    nextTransientUiSeq: 1,
  };

  const runtime = {
    agentMetadata: null,
    agentInstallationHints: null,
    agentInstallationHintsPending: false,
    agentInstallationHintsFetched: false,
    agentInstallationHintsPromise: null,
    themeList: null,
    codexPetsRefreshPending: false,
    codexPetZipImportPending: false,
    userThemeZipImportPending: false,
    codexPetRemovalPendingThemeId: null,
    animationOverridesData: null,
    petTintOptions: [],
    petAccessoryOptions: [],
    petMouthAccessoryOptions: [],
    animationOverridesFetchSeq: 0,
    animationPosterRenderPending: false,
    animationPosterRenderFlags: null,
    animationPreviewPosterCache: new Map(),
    pendingAnimationOverrideEdits: new Map(),
    nextAnimationOverrideEditSeq: 1,
    animOverridesSubtab: "map",
    settingsTabScrollPositions: new Map(),
    persistedSettingsTab: "general",
    // null = not chosen yet; the Agents tab resolves it from what is connected.
    agentsSubtab: null,
    agentsUnavailableQuery: "",
    remoteApprovalSubtab: "channels",
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
      updateCheckSnapshot: { state: "idle" },
    },
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

  function readAgentIntegrationInstalled(agentId) {
    const entry = state.snapshot && state.snapshot.agents && state.snapshot.agents[agentId];
    // Normalized v11 snapshots carry the explicit flag. The true fallback is
    // only for old/mocked snapshots that predate on-demand installation.
    return entry ? entry.integrationInstalled === true : true;
  }

  function readAgentPermissionMode(agentId) {
    const entry = state.snapshot && state.snapshot.agents && state.snapshot.agents[agentId];
    if (agentId === "codex" && entry && entry.permissionMode === "intercept") return "intercept";
    return "native";
  }

  function readAgentCustomPermissionUrl(agentId) {
    const entry = state.snapshot && state.snapshot.agents && state.snapshot.agents[agentId];
    return entry && typeof entry.customPermissionUrl === "string" ? entry.customPermissionUrl : "";
  }

  function readAgentCustomDiscoveryPaths(agentId) {
    if (agentId === "custom") {
      const value = state.snapshot && state.snapshot.customToolDiscoveryPaths;
      return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
    }
    const entry = state.snapshot && state.snapshot.agents && state.snapshot.agents[agentId];
    const value = entry && entry.customDiscoveryPaths;
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  }

  function readCustomToolDetectionResults() {
    const hints = runtime.agentInstallationHints;
    const value = hints && hints.customTools;
    return Array.isArray(value) ? value.filter((item) => item && typeof item.path === "string") : [];
  }

  function readCustomAgentDetectionResults() {
    const hints = runtime.agentInstallationHints;
    const value = hints && hints.customAgents;
    return Array.isArray(value) ? value.filter((item) => item && typeof item.agentId === "string") : [];
  }

  function readCustomApplications() {
    const value = state.snapshot && state.snapshot.customApplications;
    return Array.isArray(value) ? value.filter((item) => item && typeof item.id === "string") : [];
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
    const hitboxKeys = [];
    if (map.hitbox && typeof map.hitbox === "object") {
      for (const group of Object.values(map.hitbox)) {
        if (group && typeof group === "object") hitboxKeys.push(...Object.keys(group));
      }
    }
    const keys = [
      ...(map.states ? Object.keys(map.states) : []),
      ...(map.tiers && map.tiers.workingTiers ? Object.keys(map.tiers.workingTiers) : []),
      ...(map.tiers && map.tiers.jugglingTiers ? Object.keys(map.tiers.jugglingTiers) : []),
      ...(map.timings && map.timings.autoReturn ? Object.keys(map.timings.autoReturn) : []),
      ...(map.idleAnimations ? Object.keys(map.idleAnimations) : []),
      ...(map.reactions ? Object.keys(map.reactions) : []),
      ...hitboxKeys,
      ...(map.sounds ? Object.keys(map.sounds) : []),
    ];
    return keys.length > 0;
  }

  function t(key) {
    const dict = STRINGS[getLang()] || STRINGS.en || {};
    return dict[key] || (STRINGS.en && STRINGS.en[key]) || key;
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

  // Shared Settings button primitive. Feature tabs keep ownership of business
  // behavior while tone, sizing and pending/accessibility semantics stay
  // consistent across the Settings window.
  function buildButton(config = {}) {
    const button = document.createElement("button");
    const tone = ["neutral", "accent", "danger", "quiet"].includes(config.tone)
      ? config.tone
      : "neutral";
    const size = ["compact", "regular", "large"].includes(config.size)
      ? config.size
      : "regular";
    button.type = config.type || "button";
    button.className = [
      "soft-btn",
      "settings-button",
      `settings-button-${size}`,
      tone === "neutral" ? "" : tone,
      config.className || "",
    ].filter(Boolean).join(" ");
    button.textContent = config.label != null
      ? String(config.label)
      : (config.labelKey ? t(config.labelKey) : "");
    if (config.ariaLabel) button.setAttribute("aria-label", String(config.ariaLabel));
    if (config.title) button.title = String(config.title);
    if (config.disabled === true || config.pending === true) button.disabled = true;
    button.classList.toggle("pending", config.pending === true);
    button.setAttribute("aria-busy", config.pending === true ? "true" : "false");
    if (typeof config.onClick === "function") button.addEventListener("click", config.onClick);
    return button;
  }

  function buildSettingsSelect(config = {}) {
    const factory = selectPickerApi.createSettingsSelect || selectPickerApi.createLanguagePicker;
    if (typeof factory !== "function") {
      throw new Error("language-picker.js failed to load before settings-ui-core.js");
    }
    const className = ["settings-select", config.className || ""].filter(Boolean).join(" ");
    const control = factory({
      ...config,
      className,
      lockWhilePending: config.lockWhilePending !== false,
    });
    state.mountedControls.settingsSelects.add(control);
    return control;
  }

  function buildSegmentedRadio(config = {}) {
    const options = Array.isArray(config.options)
      ? config.options.filter((option) => option && option.value != null)
      : [];
    const values = options.map((option) => String(option.value));
    let currentValue = values.includes(String(config.value))
      ? String(config.value)
      : (values[0] || "");
    let disabled = config.disabled === true;
    let pending = false;
    let disposed = false;

    const element = document.createElement("div");
    element.className = ["segmented", "settings-segmented-radio", config.className || ""]
      .filter(Boolean)
      .join(" ");
    element.setAttribute("role", "radiogroup");
    if (config.ariaLabel) element.setAttribute("aria-label", config.ariaLabel);

    const buttons = options.map((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "radio");
      button.dataset.value = String(option.value);

      const label = document.createElement("span");
      label.className = "settings-segmented-radio-label";
      label.textContent = option.label == null ? String(option.value) : String(option.label);
      button.appendChild(label);

      if (option.description) {
        const description = document.createElement("span");
        description.className = "settings-segmented-radio-description";
        description.textContent = String(option.description);
        button.appendChild(description);
      }
      element.appendChild(button);
      return button;
    });

    function syncVisualState() {
      element.classList.toggle("pending", pending);
      element.classList.toggle("disabled", disabled);
      element.setAttribute("aria-busy", pending ? "true" : "false");
      for (const button of buttons) {
        const selected = button.dataset.value === currentValue;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-checked", selected ? "true" : "false");
        button.tabIndex = selected ? 0 : -1;
        button.disabled = disabled || pending;
      }
    }

    async function selectValue(nextValue) {
      const next = String(nextValue);
      if (disposed || disabled || pending || !values.includes(next)) return false;
      if (next === currentValue) return true;
      const previous = currentValue;
      const focusTarget = buttons.includes(document.activeElement) ? document.activeElement : null;
      currentValue = next;
      let accepted = true;
      try {
        if (typeof config.onChange === "function") {
          const result = config.onChange(next);
          pending = true;
          syncVisualState();
          accepted = (await Promise.resolve(result)) !== false;
        } else {
          pending = true;
          syncVisualState();
        }
      } catch (_) {
        accepted = false;
      }
      if (!accepted) currentValue = previous;
      pending = false;
      syncVisualState();
      if (focusTarget && focusTarget.isConnected !== false && typeof focusTarget.focus === "function") {
        const active = document.activeElement;
        if (!active || active === document.body || active === focusTarget || active.isConnected === false) {
          try { focusTarget.focus({ preventScroll: true }); } catch (_) { focusTarget.focus(); }
        }
      }
      return accepted;
    }

    function onClick(event) {
      const button = event && event.currentTarget;
      if (button) void selectValue(button.dataset.value);
    }

    function onKeyDown(event) {
      if (disabled || pending || buttons.length === 0) return;
      const currentIndex = Math.max(0, buttons.indexOf(event.currentTarget));
      let nextIndex = currentIndex;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (currentIndex + 1) % buttons.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = buttons.length - 1;
      } else if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      const target = buttons[nextIndex];
      if (target && typeof target.focus === "function") target.focus();
      void selectValue(target.dataset.value);
    }

    for (const button of buttons) {
      button.addEventListener("click", onClick);
      button.addEventListener("keydown", onKeyDown);
    }
    syncVisualState();

    const control = {
      element,
      getValue: () => currentValue,
      setValue(value) {
        const next = String(value);
        if (!values.includes(next)) return false;
        currentValue = next;
        syncVisualState();
        return true;
      },
      setDisabled(value) {
        disabled = value === true;
        syncVisualState();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const button of buttons) {
          button.removeEventListener("click", onClick);
          button.removeEventListener("keydown", onKeyDown);
        }
      },
    };
    state.mountedControls.segmentedRadios.add(control);
    return control;
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

  function createDisclosureChevron(className) {
    const chevron = document.createElement("span");
    chevron.className = className;
    chevron.setAttribute("aria-hidden", "true");

    const createSvgElement = typeof document.createElementNS === "function"
      ? (tagName) => document.createElementNS("http://www.w3.org/2000/svg", tagName)
      : (tagName) => document.createElement(tagName);
    const svg = createSvgElement("svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("focusable", "false");
    const path = createSvgElement("path");
    path.setAttribute("d", "M8 5l5 5-5 5");
    svg.appendChild(path);
    chevron.appendChild(svg);
    return chevron;
  }

  let settingsDisclosureId = 0;

  function prefersReducedMotion() {
    return typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function scheduleSettingsTimeout(callback, delay) {
    if (typeof setTimeout === "function") return setTimeout(callback, delay);
    requestAnimationFrame(callback);
    return null;
  }

  function cancelSettingsTimeout(timer) {
    if (timer !== null && typeof clearTimeout === "function") clearTimeout(timer);
  }

  function getMountedDisposableScope(scope = "content") {
    const scopes = state.mountedControls.disposableScopes;
    if (!scopes.has(scope)) scopes.set(scope, new Set());
    return scopes.get(scope);
  }

  function registerMountedDisposable(disposable, { scope = "content" } = {}) {
    if (!disposable || typeof disposable.dispose !== "function") return disposable;
    getMountedDisposableScope(scope).add(disposable);
    return disposable;
  }

  function disposeMountedDisposable(disposable, { scope = null } = {}) {
    if (!disposable || typeof disposable.dispose !== "function") return;
    const scopes = state.mountedControls.disposableScopes;
    if (scope !== null) {
      const controls = scopes.get(scope);
      if (controls) {
        controls.delete(disposable);
        if (controls.size === 0) scopes.delete(scope);
      }
    } else {
      for (const [scopeName, controls] of scopes) {
        controls.delete(disposable);
        if (controls.size === 0) scopes.delete(scopeName);
      }
    }
    disposable.dispose();
  }

  function disposeMountedDisposables(scope = null) {
    const scopes = state.mountedControls.disposableScopes;
    const scopeNames = scope === null ? Array.from(scopes.keys()) : [scope];
    for (const scopeName of scopeNames) {
      const controls = scopes.get(scopeName);
      if (!controls) continue;
      scopes.delete(scopeName);
      for (const disposable of Array.from(controls)) disposable.dispose();
    }
  }

  function attachSettingsDisclosure({
    root: disclosureRoot,
    trigger,
    body,
    expanded = false,
    animate = true,
    onExpandedChange = null,
    preserveStateChange = null,
    syncTrigger = null,
  } = {}) {
    if (!disclosureRoot || !trigger || !body) {
      throw new TypeError("attachSettingsDisclosure requires root, trigger, and body");
    }
    const bodyInner = body.querySelector(".settings-disclosure-body-inner");
    if (!bodyInner) throw new TypeError("Settings disclosure body requires an inner wrapper");

    let isExpanded = !!expanded;
    let transitionTimer = null;
    let transitionState = null;
    let disposed = false;
    disclosureRoot.classList.add("settings-disclosure");
    trigger.classList.add("settings-disclosure-trigger");
    body.classList.add("settings-disclosure-body");

    const triggerTag = String(trigger.tagName || "").toUpperCase();
    if (triggerTag !== "BUTTON") {
      if (!trigger.getAttribute("role")) trigger.setAttribute("role", "button");
      if (!trigger.getAttribute("tabindex")) trigger.setAttribute("tabindex", "0");
    }
    if (!body.getAttribute("id")) {
      settingsDisclosureId += 1;
      body.setAttribute("id", `settings-disclosure-body-${settingsDisclosureId}`);
    }
    trigger.setAttribute("aria-controls", body.getAttribute("id"));

    function finishTransition() {
      cancelSettingsTimeout(transitionTimer);
      transitionTimer = null;
      transitionState = null;
      disclosureRoot.classList.remove("expanding", "collapsing");
      setBodyInteractivity(isExpanded);
    }

    function setBodyInteractivity(nextExpanded, isTransitioning = false) {
      body.setAttribute("aria-hidden", nextExpanded ? "false" : "true");
      const bodyInert = !nextExpanded || isTransitioning;
      if ("inert" in body) {
        body.inert = bodyInert;
      } else if (bodyInert) {
        body.setAttribute("inert", "");
      } else {
        body.removeAttribute("inert");
      }
    }

    function syncState({ isTransitioning = false } = {}) {
      trigger.setAttribute("aria-expanded", isExpanded ? "true" : "false");
      disclosureRoot.classList.toggle("expanded", isExpanded);
      disclosureRoot.classList.toggle("collapsed", !isExpanded);
      setBodyInteractivity(isExpanded, isTransitioning);
      if (typeof syncTrigger === "function") syncTrigger(isExpanded);
    }

    function suppressTransitionOnce() {
      disclosureRoot.classList.add("settings-disclosure-no-motion");
      requestAnimationFrame(() => {
        if (!disposed) disclosureRoot.classList.remove("settings-disclosure-no-motion");
      });
    }

    function setExpanded(nextExpanded, options = {}) {
      if (disposed) return false;
      const normalized = !!nextExpanded;
      if (normalized === isExpanded) return false;
      const animateRequested = options.animate === undefined ? animate : options.animate !== false;
      const apply = () => {
        finishTransition();
        isExpanded = normalized;
        const reducedMotion = prefersReducedMotion();
        const shouldAnimate = animateRequested && !reducedMotion;
        syncState({ isTransitioning: shouldAnimate });
        if (!shouldAnimate) {
          if (!reducedMotion) suppressTransitionOnce();
          return;
        }
        transitionState = isExpanded ? "expanding" : "collapsing";
        disclosureRoot.classList.add(transitionState);
        transitionTimer = scheduleSettingsTimeout(finishTransition, 300);
      };
      if (typeof preserveStateChange === "function") preserveStateChange(apply);
      else apply();
      if (typeof onExpandedChange === "function") {
        onExpandedChange(isExpanded, { persist: options.persist !== false });
      }
      return true;
    }

    function toggle(options = {}) {
      return setExpanded(!isExpanded, options);
    }

    function onClick() {
      toggle();
    }

    function onKeyDown(ev) {
      if (ev.target !== trigger || (ev.key !== " " && ev.key !== "Enter")) return;
      ev.preventDefault();
      toggle();
    }

    function onBodyTransitionFinished(ev) {
      if (ev.target !== body || ev.propertyName !== "grid-template-rows") return;
      finishTransition();
    }

    trigger.addEventListener("click", onClick);
    if (triggerTag !== "BUTTON") trigger.addEventListener("keydown", onKeyDown);
    // A reversed transition emits a stale transitioncancel after the new
    // generation starts. Only its transitionend or watchdog may release inert.
    body.addEventListener("transitionend", onBodyTransitionFinished);
    syncState();

    return {
      get expanded() { return isExpanded; },
      get transitioning() { return transitionState; },
      setExpanded,
      expand: (options = {}) => setExpanded(true, options),
      collapse: (options = {}) => setExpanded(false, options),
      toggle,
      dispose() {
        if (disposed) return;
        disposed = true;
        finishTransition();
        disclosureRoot.classList.remove("settings-disclosure-no-motion");
        trigger.removeEventListener("click", onClick);
        if (triggerTag !== "BUTTON") trigger.removeEventListener("keydown", onKeyDown);
        body.removeEventListener("transitionend", onBodyTransitionFinished);
      },
    };
  }

  function buildCollapsibleGroup({
    id,
    title = "",
    desc = "",
    summary = null,
    headerContent = null,
    headerAction = null,
    disclosureLabel = "",
    children = [],
    defaultCollapsed = false,
    className = "",
    animateExpansion = true,
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
    const disclosure = headerAction ? document.createElement("div") : header;
    if (headerAction) {
      header.classList.add("collapsible-group-header-with-action");
      disclosure.className = "collapsible-group-disclosure";
      header.appendChild(disclosure);
    }
    disclosure.setAttribute("role", "button");
    disclosure.setAttribute("tabindex", "0");

    const chevron = createDisclosureChevron("collapsible-group-chevron");
    disclosure.appendChild(chevron);

    if (headerContent) {
      const headerWrap = document.createElement("div");
      headerWrap.className = "collapsible-group-header-content";
      headerWrap.appendChild(headerContent);
      disclosure.appendChild(headerWrap);
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
      disclosure.appendChild(text);
    }

    if (summary) {
      const summaryWrap = document.createElement("div");
      summaryWrap.className = "collapsibleSummary collapsible-group-summary";
      if (typeof summary === "string") summaryWrap.textContent = summary;
      else summaryWrap.appendChild(summary);
      disclosure.appendChild(summaryWrap);
    }

    if (headerAction) {
      const actionWrap = document.createElement("div");
      actionWrap.className = "collapsible-group-header-action";
      actionWrap.appendChild(headerAction);
      header.appendChild(actionWrap);
    }

    const body = document.createElement("div");
    body.className = "collapsible-group-body";
    const bodyInner = document.createElement("div");
    bodyInner.className = "collapsible-group-body-inner";
    for (const child of children) bodyInner.appendChild(child);
    body.appendChild(bodyInner);

    const contentAnimationTimers = new Map();
    function refreshCollapsibleHeight() {
      // Compatibility shim: the grid-based body follows its natural height.
    }

    function mutateCollapsibleBody(mutate) {
      if (typeof mutate !== "function") return;
      // Callers return the newly inserted or revealed elements so existing
      // controls do not replay their entrance animation on every async update.
      const result = mutate();
      if (!controller.expanded || controller.transitioning === "collapsing" || prefersReducedMotion()) return;
      const targets = Array.isArray(result) ? result : [result];
      for (const target of targets) {
        if (!target || !target.classList) continue;
        if (contentAnimationTimers.has(target)) {
          cancelSettingsTimeout(contentAnimationTimers.get(target));
          contentAnimationTimers.delete(target);
        }
        target.classList.remove("collapsible-content-entering");
        void target.offsetWidth;
        target.classList.add("collapsible-content-entering");
        const timer = scheduleSettingsTimeout(() => {
          contentAnimationTimers.delete(target);
          target.classList.remove("collapsible-content-entering");
        }, 240);
        if (timer !== null) contentAnimationTimers.set(target, timer);
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

    group.appendChild(header);
    group.appendChild(body);
    body.classList.add("settings-disclosure-body");
    bodyInner.classList.add("settings-disclosure-body-inner");
    const controller = attachSettingsDisclosure({
      root: group,
      trigger: disclosure,
      body,
      expanded: !collapsed,
      animate: animateExpansion,
      preserveStateChange: preserveScrollAnchor,
      syncTrigger(isExpanded) {
        const actionLabel = isExpanded ? t("collapsibleCollapse") : t("collapsibleExpand");
        disclosure.setAttribute("aria-label", disclosureLabel ? `${actionLabel}: ${disclosureLabel}` : actionLabel);
      },
      onExpandedChange(isExpanded, { persist }) {
        collapsed = !isExpanded;
        if (!persist) return;
        const nextState = readCollapsedGroupState();
        nextState[id] = collapsed;
        writeCollapsedGroupState(nextState);
      },
    });
    const trackedDisclosure = {
      dispose() {
        controller.dispose();
        for (const [target, timer] of contentAnimationTimers) {
          cancelSettingsTimeout(timer);
          target.classList.remove("collapsible-content-entering");
        }
        contentAnimationTimers.clear();
      },
    };
    registerMountedDisposable(trackedDisclosure);
    group.expand = ({
      persist = true,
      animate = animateExpansion,
    } = {}) => {
      controller.expand({ persist, animate });
    };
    group.refreshCollapsibleHeight = refreshCollapsibleHeight;
    group.mutateCollapsibleBody = mutateCollapsibleBody;
    group.disposeCollapsible = () => {
      disposeMountedDisposable(trackedDisclosure);
    };
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
    danger = false,
  }) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
    const labelEl = row.querySelector(".row-label");
    labelEl.textContent = t(labelKey);
    if (danger) labelEl.classList.add("row-label-danger");
    const text = row.querySelector(".row-text");
    const desc = row.querySelector(".row-desc");
    if (descKey) desc.textContent = t(descKey);
    else desc.remove();
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
      const btn = buildButton({ labelKey: actionButton.labelKey, tone: "accent" });
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
    return buildButton({
      label,
      disabled,
      tone: accent ? "accent" : "neutral",
      onClick: disabled ? null : onClick,
    });
  }

  // Generic number-input row used by the Session cleanup group. Mirrors the
  // bubble-policy seconds-input shape but without a toggle axis: label + desc
  // + numeric input + localized unit suffix. Debounces commits so typing
  // doesn't fire a write on every keystroke; reverts on rejection.
  //
  // `toDisplay(ms)` maps the stored ms value -> the integer shown in the
  // input. `fromDisplay(display)` maps the user's input back to ms. The
  // helper does not enforce the cross-field invariant; that's the
  // controller's job (`settings-actions.js`).
  const NUMBER_INPUT_COMMIT_DELAY_MS = 600;
  function buildNumberInputRow({
    key,
    labelKey,
    descKey,
    unitKey,
    toDisplay,
    fromDisplay,
    min,
    max,
    zeroLabelKey = null,
    debounceMs = NUMBER_INPUT_COMMIT_DELAY_MS,
  }) {
    const row = document.createElement("div");
    row.className = "row session-cleanup-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control session-cleanup-control">` +
        `<input type="text" class="bubble-policy-seconds session-cleanup-input" inputmode="numeric" />` +
        `<span class="bubble-policy-unit session-cleanup-unit"></span>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t(labelKey);
    const descNode = row.querySelector(".row-desc");
    if (descKey) descNode.textContent = t(descKey);
    else descNode.remove();
    const input = row.querySelector(".session-cleanup-input");
    const unit = row.querySelector(".session-cleanup-unit");
    if (unitKey) unit.textContent = t(unitKey);
    else unit.remove();
    input.maxLength = String(max).length + 1;

    function currentStored() {
      const stored = state.snapshot && state.snapshot[key];
      return Number.isFinite(stored) ? stored : 0;
    }
    function renderValue() {
      const stored = currentStored();
      const display = toDisplay(stored);
      if (stored === 0 && zeroLabelKey) {
        input.value = t(zeroLabelKey);
      } else {
        input.value = String(display);
      }
    }
    renderValue();

    let commitTimer = null;
    let inFlightDisplay = null;
    let commitSeq = 0;
    function clearCommitTimer() {
      if (commitTimer) {
        clearTimeout(commitTimer);
        commitTimer = null;
      }
    }
    function syncFromSnapshot() {
      if (document.activeElement === input) return;
      renderValue();
    }
    function revert() {
      renderValue();
    }
    function commit(nextStored) {
      const seq = ++commitSeq;
      inFlightDisplay = nextStored;
      return window.settingsAPI.update(key, nextStored).then((result) => {
        if (seq !== commitSeq) return false;
        inFlightDisplay = null;
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          showToast(t("toastSaveFailed") + msg, { error: true });
          revert();
          return false;
        }
        return true;
      }).catch((err) => {
        if (seq !== commitSeq) return false;
        inFlightDisplay = null;
        showToast(t("toastSaveFailed") + (err && err.message), { error: true });
        revert();
        return false;
      });
    }
    function parseInput() {
      const raw = input.value.trim();
      if (raw === "" || (zeroLabelKey && raw === t(zeroLabelKey))) {
        // Treat the localized "Disabled" label as the literal zero.
        return zeroLabelKey ? 0 : null;
      }
      if (!/^[0-9]+(?:\.[0-9]+)?$/.test(raw)) return null;
      const display = Number(raw);
      if (!Number.isFinite(display) || display < min || display > max) return null;
      return display;
    }
    function commitFromInput() {
      const display = parseInput();
      if (display == null) {
        showToast(t("toastSaveFailed") + `${min}-${max}`, { error: true });
        revert();
        return;
      }
      const nextStored = display === 0 ? 0 : fromDisplay(display);
      if (nextStored === currentStored() || nextStored === inFlightDisplay) {
        // No change — just re-render so the input matches the stored value.
        renderValue();
        return;
      }
      void commit(nextStored);
    }
    function scheduleCommit() {
      clearCommitTimer();
      commitTimer = setTimeout(() => {
        commitTimer = null;
        commitFromInput();
      }, debounceMs);
    }

    input.addEventListener("focus", () => {
      // Strip the zero-label so the user types numerics, not localized text.
      const stored = currentStored();
      if (stored === 0 && zeroLabelKey) input.value = "0";
    });
    input.addEventListener("input", () => {
      scheduleCommit();
    });
    input.addEventListener("blur", () => {
      clearCommitTimer();
      commitFromInput();
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        clearCommitTimer();
        commitFromInput();
        input.blur();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        clearCommitTimer();
        revert();
        input.blur();
      }
    });

    const handle = { row, input, syncFromSnapshot };
    state.mountedControls.sessionCleanupControls.set(key, handle);
    return handle;
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
    if (state.mountedControls.idleVisualPicker && typeof state.mountedControls.idleVisualPicker.dispose === "function") {
      state.mountedControls.idleVisualPicker.dispose();
    }
    if (state.mountedControls.size && typeof state.mountedControls.size.dispose === "function") {
      Promise.resolve(state.mountedControls.size.dispose()).catch(() => {});
    }
    if (state.mountedControls.soundVolume && typeof state.mountedControls.soundVolume.dispose === "function") {
      state.mountedControls.soundVolume.dispose();
    }
    // Rolls back a transient text-scale preview that a full re-render would
    // otherwise strand in the main process (the row's blur never fires when
    // its subtree is dropped wholesale).
    if (state.mountedControls.textScale && typeof state.mountedControls.textScale.dispose === "function") {
      state.mountedControls.textScale.dispose();
    }
    for (const control of state.mountedControls.settingsSelects) {
      if (control && typeof control.dispose === "function") control.dispose();
    }
    state.mountedControls.settingsSelects.clear();
    for (const control of state.mountedControls.segmentedRadios) {
      if (control && typeof control.dispose === "function") control.dispose();
    }
    state.mountedControls.segmentedRadios.clear();
    disposeMountedDisposables();
    state.mountedControls.generalSwitches.clear();
    state.mountedControls.bubblePolicyControls.clear();
    state.mountedControls.sessionCleanupControls.clear();
    state.mountedControls.agentSwitches.clear();
    state.mountedControls.agentPermissionModes.clear();
    state.mountedControls.agentIntegrationActions.clear();
    state.mountedControls.animMapSwitches.clear();
    state.mountedControls.animMapReset = null;
    state.mountedControls.animOverrideTimingSliders.clear();
    state.mountedControls.bubblePolicySummary = null;
    state.mountedControls.sessionHudSummary = null;
    state.mountedControls.idleVisualPicker = null;
    state.mountedControls.size = null;
    state.mountedControls.soundSummary = null;
    state.mountedControls.soundVolume = null;
    state.mountedControls.textScale = null;
    state.mountedControls.roamMovementStyle = null;
    state.mountedControls.bubblePlacement = null;
    state.mountedControls.quotaRingDisplayMode = null;
    state.mountedControls.permissionAutomationMode = null;
    state.mountedControls.roamArea = null;
    state.mountedControls.aboutAutoUpdate = null;
    state.mountedControls.aboutUpdateStatus = null;
    state.mountedControls.aboutUpdateErrorDisclosure = null;
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

  function getActiveSettingsFocusState() {
    const active = document.activeElement;
    if (!active || active === document.body || typeof active.getAttribute !== "function") {
      return { focusKey: "", fallbackKey: "" };
    }
    const focusKey = String(active.getAttribute("data-settings-focus-key") || "").trim();
    return {
      focusKey,
      fallbackKey: focusKey
        ? String(active.getAttribute("data-settings-focus-fallback-key") || "").trim()
        : "",
    };
  }

  function findSettingsFocusTarget(rootNode, focusKey) {
    if (!rootNode || !focusKey) return null;
    const stack = Array.isArray(rootNode.children) ? [...rootNode.children] : Array.from(rootNode.children || []);
    while (stack.length > 0) {
      const element = stack.shift();
      if (element && typeof element.getAttribute === "function"
        && element.getAttribute("data-settings-focus-key") === focusKey) return element;
      if (element && element.children) stack.push(...Array.from(element.children));
    }
    return null;
  }

  function focusSettingsTarget(rootNode, focusKey, { onlyIfFocusLost = false } = {}) {
    const target = findSettingsFocusTarget(rootNode, focusKey);
    if (!target || target.disabled === true || typeof target.focus !== "function") return;
    if (onlyIfFocusLost) {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected !== false) return;
    }
    try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
  }

  function requestRender({
    sidebar = false,
    content = false,
    modal = false,
    preserveScroll = false,
  } = {}) {
    if (sidebar && typeof renderHooks.sidebar === "function") renderHooks.sidebar();
    if (content && typeof renderHooks.content === "function") {
      const { focusKey, fallbackKey } = getActiveSettingsFocusState();
      const contentRoot = document.getElementById("content");
      const scrollTop = preserveScroll && contentRoot
        ? normalizePersistedScrollTop(Number(contentRoot.scrollTop))
        : null;
      const scrollTabId = state.activeTab;
      renderHooks.content();
      if (focusKey) {
        const currentContentRoot = document.getElementById("content");
        const exactTarget = findSettingsFocusTarget(currentContentRoot, focusKey);
        const restoreKey = exactTarget
          && exactTarget.disabled !== true
          && typeof exactTarget.focus === "function"
          ? focusKey
          : fallbackKey;
        if (restoreKey) {
          focusSettingsTarget(currentContentRoot, restoreKey, { onlyIfFocusLost: true });
        }
      }
      if (scrollTop !== null
        && document.getElementById("content") === contentRoot
        && state.activeTab === scrollTabId) {
        contentRoot.scrollTop = scrollTop;
        requestAnimationFrame(() => {
          if (document.getElementById("content") !== contentRoot) return;
          if (state.activeTab !== scrollTabId) return;
          contentRoot.scrollTop = scrollTop;
        });
      }
    }
    if (modal && typeof renderHooks.modal === "function") renderHooks.modal();
  }

  function normalizePersistedScrollTop(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    return Math.min(value, MAX_PERSISTED_SCROLL_TOP);
  }

  function captureActiveTabScrollPosition() {
    const content = document.getElementById("content");
    if (!content || !tabs[state.activeTab]) return;
    const scrollTop = normalizePersistedScrollTop(Number(content.scrollTop));
    if (scrollTop !== null) runtime.settingsTabScrollPositions.set(state.activeTab, scrollTop);
  }

  function writeNavigationState() {
    const scrollPositions = {};
    for (const [tabId, value] of runtime.settingsTabScrollPositions) {
      const scrollTop = normalizePersistedScrollTop(value);
      if (tabs[tabId] && scrollTop !== null) scrollPositions[tabId] = scrollTop;
    }
    try {
      localStorage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify({
        activeTab: tabs[runtime.persistedSettingsTab]
          ? runtime.persistedSettingsTab
          : (tabs[state.activeTab] ? state.activeTab : "general"),
        scrollPositions,
      }));
    } catch (_) {}
  }

  function persistNavigationState() {
    captureActiveTabScrollPosition();
    writeNavigationState();
  }

  function restoreNavigationState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(NAVIGATION_STORAGE_KEY) || "null");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      if (typeof parsed.activeTab === "string" && tabs[parsed.activeTab]) {
        state.activeTab = parsed.activeTab;
        runtime.persistedSettingsTab = parsed.activeTab;
      }
      const scrollPositions = parsed.scrollPositions;
      if (scrollPositions && typeof scrollPositions === "object" && !Array.isArray(scrollPositions)) {
        for (const [tabId, value] of Object.entries(scrollPositions)) {
          const scrollTop = normalizePersistedScrollTop(value);
          if (tabs[tabId] && scrollTop !== null) {
            runtime.settingsTabScrollPositions.set(tabId, scrollTop);
          }
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function restoreActiveTabScrollPosition() {
    const content = document.getElementById("content");
    if (!content) return;
    const tabId = state.activeTab;
    const targetScrollTop = runtime.settingsTabScrollPositions.get(tabId) || 0;
    content.scrollTop = targetScrollTop;
    requestAnimationFrame(() => {
      if (state.activeTab !== tabId) return;
      if (document.getElementById("content") !== content) return;
      content.scrollTop = targetScrollTop;
    });
  }

  function selectTab(nextTab, options = {}) {
    if (!tabs[nextTab]) return false;
    const prevTabId = state.activeTab;
    const shouldPersist = options.persist !== false;
    if (prevTabId === nextTab) {
      if (shouldPersist) {
        runtime.persistedSettingsTab = nextTab;
        writeNavigationState();
      }
      return false;
    }
    captureActiveTabScrollPosition();
    const content = document.getElementById("content");
    const prevTab = tabs[prevTabId];
    if (prevTab && typeof prevTab.onExit === "function") {
      prevTab.onExit(core);
    }
    state.activeTab = nextTab;
    if (shouldPersist) runtime.persistedSettingsTab = nextTab;
    writeNavigationState();
    requestRender({ sidebar: true, content: true, modal: true });
    if (!content) return true;

    const targetScrollTop = runtime.settingsTabScrollPositions.get(nextTab) || 0;
    content.scrollTop = targetScrollTop;
    requestAnimationFrame(() => {
      if (state.activeTab !== nextTab) return;
      if (document.getElementById("content") !== content) return;
      content.scrollTop = targetScrollTop;
    });
    return true;
  }

  function applyBootstrap(snapshotValue) {
    state.snapshot = snapshotValue || {};
    requestRender({ sidebar: true, content: true, modal: true });
    restoreActiveTabScrollPosition();
  }

  function applyAgentMetadata(list) {
    runtime.agentMetadata = Array.isArray(list) ? list : [];
    if (state.activeTab === "agents" || state.activeTab === "recap") {
      requestRender({
        content: true,
        preserveScroll: state.activeTab === "recap",
      });
    }
  }

  function normalizeAgentInstallationHints(result) {
    const source = result && typeof result === "object" ? result : {};
    const normalized = {
      checkedAt: Number.isFinite(source.checkedAt) ? source.checkedAt : null,
      agents: Array.isArray(source.agents) ? source.agents : [],
      customAgents: Array.isArray(source.customAgents) ? source.customAgents : [],
      customTools: Array.isArray(source.customTools) ? source.customTools : [],
      skippedAgentIds: Array.isArray(source.skippedAgentIds) ? source.skippedAgentIds : [],
      wslAgents: Array.isArray(source.wslAgents) ? source.wslAgents : [],
      wslDistros: Array.isArray(source.wslDistros) ? source.wslDistros : [],
      wslPending: source.wslPending === true,
      wslSupported: source.wslSupported === true,
    };
    if (typeof source.error === "string" && source.error) normalized.error = source.error;
    return normalized;
  }

  function emptyAgentInstallationHints(error) {
    const result = {
      checkedAt: null,
      agents: [],
      customAgents: [],
      customTools: [],
      skippedAgentIds: [],
      wslAgents: [],
      wslDistros: [],
      wslPending: false,
      wslSupported: false,
    };
    if (error) result.error = error;
    return result;
  }

  function fetchAgentInstallationHints({ force = false, refreshWsl = false } = {}) {
    if (runtime.agentInstallationHintsPending) {
      const inFlight = runtime.agentInstallationHintsPromise || Promise.resolve(runtime.agentInstallationHints);
      // A manual WSL rescan must not be swallowed by a passive fetch that
      // happens to be in flight (e.g. the tab's mount-time poll while
      // wslPending) — chain one real rescan after it settles.
      if (refreshWsl && !runtime.agentInstallationHintsWslRefreshQueued) {
        runtime.agentInstallationHintsWslRefreshQueued = true;
        return inFlight.then(() => {
          runtime.agentInstallationHintsWslRefreshQueued = false;
          return fetchAgentInstallationHints({ refreshWsl: true });
        });
      }
      return inFlight;
    }
    // refreshWsl always re-fetches; plain force only if not already done
    if (!force && !refreshWsl && runtime.agentInstallationHintsFetched) {
      return Promise.resolve(runtime.agentInstallationHints);
    }
    if (!window.settingsAPI || typeof window.settingsAPI.detectAgentInstallations !== "function") {
      runtime.agentInstallationHints = emptyAgentInstallationHints();
      runtime.agentInstallationHintsFetched = true;
      return Promise.resolve(runtime.agentInstallationHints);
    }

    // refreshWsl triggers a backend WSL re-scan; force just bypasses the
    // frontend cache. The backend only inspects refreshWsl — passing force
    // in the IPC payload would be dead weight.
    const opts = refreshWsl ? { refreshWsl: true } : undefined;
    runtime.agentInstallationHintsPending = true;
    runtime.agentInstallationHintsPromise = window.settingsAPI.detectAgentInstallations(opts)
      .then((result) => {
        runtime.agentInstallationHints = normalizeAgentInstallationHints(result);
        return runtime.agentInstallationHints;
      })
      .catch((err) => {
        console.warn("settings: detectAgentInstallations failed", err);
        runtime.agentInstallationHints = emptyAgentInstallationHints(
          err && err.message ? err.message : String(err)
        );
        return runtime.agentInstallationHints;
      })
      .finally(() => {
        runtime.agentInstallationHintsPending = false;
        runtime.agentInstallationHintsFetched = true;
        runtime.agentInstallationHintsPromise = null;
        if (state.activeTab === "agents") requestRender({ content: true });
        // wslPending means no WSL scan has ever completed. Startup does not
        // pre-scan (running a command in each distro boots every stopped VM),
        // so the first Agents-tab visit kicks off the real scan here. No loop:
        // the scan marks the cache detected on success AND failure, so
        // wslPending is false on the next fetch either way.
        if (
          !refreshWsl &&
          runtime.agentInstallationHints &&
          runtime.agentInstallationHints.wslPending &&
          runtime.agentInstallationHints.wslSupported
        ) {
          if (state.activeTab === "agents") {
            fetchAgentInstallationHints({ refreshWsl: true });
          } else {
            // User left the tab before this fetch resolved. Re-arm the
            // fetched flag so the next Agents-tab visit takes the full
            // fetch path again and reaches this trigger — otherwise the
            // flag short-circuits every later plain fetch and the auto
            // scan is permanently lost for this settings session.
            runtime.agentInstallationHintsFetched = false;
          }
        }
      });
    return runtime.agentInstallationHintsPromise;
  }

  function fetchThemes() {
    if (!window.settingsAPI || typeof window.settingsAPI.listThemes !== "function") {
      runtime.themeList = [];
      return Promise.resolve([]);
    }
    const previousThemeList = Array.isArray(runtime.themeList) ? runtime.themeList : [];
    return window.settingsAPI.listThemes().then((list) => {
      const nextThemeList = Array.isArray(list) ? list : [];
      // Built-in themes make an empty successful list impossible in a healthy
      // install. Main also returns [] when enumeration throws, so preserve an
      // already-rendered list instead of blanking the entire Theme tab.
      if (nextThemeList.length === 0 && previousThemeList.length > 0) {
        return previousThemeList;
      }
      runtime.themeList = nextThemeList;
      return runtime.themeList;
    }).catch((err) => {
      console.warn("settings: listThemes failed", err);
      runtime.themeList = previousThemeList;
      return previousThemeList;
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
    const previousSnapshot = state.snapshot;
    if (payload && payload.snapshot) {
      state.snapshot = payload.snapshot;
    } else if (payload && payload.changes && state.snapshot) {
      state.snapshot = { ...state.snapshot, ...payload.changes };
    }
    if (!state.snapshot) return;

    const changes = payload && payload.changes;
    const changeKeys = changes && typeof changes === "object" ? Object.keys(changes) : [];
    if (
      changeKeys.length > 0
      && changeKeys.every((key) => RENDERER_INERT_SETTINGS_KEYS.has(key))
    ) {
      return;
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
      if (runtime.pendingWideHitboxOverrideEdits && typeof runtime.pendingWideHitboxOverrideEdits.clear === "function") {
        runtime.pendingWideHitboxOverrideEdits.clear();
      }
      if (runtime.pendingAnimationOverrideResets && typeof runtime.pendingAnimationOverrideResets.clear === "function") {
        runtime.pendingAnimationOverrideResets.clear();
      }
      if (state.mountedControls.animOverrideTimingSliders
        && typeof state.mountedControls.animOverrideTimingSliders.clear === "function") {
        state.mountedControls.animOverrideTimingSliders.clear();
      }
      if (state.mountedControls.animOverrideWideHitboxToggles
        && typeof state.mountedControls.animOverrideWideHitboxToggles.clear === "function") {
        state.mountedControls.animOverrideWideHitboxToggles.clear();
      }
      if (state.mountedControls.animOverrideStatusControls
        && typeof state.mountedControls.animOverrideStatusControls.clear === "function") {
        disposeMountedDisposables("animation-overrides");
        state.mountedControls.animOverrideStatusControls.clear();
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
          requestRender({
            sidebar: true,
            content: true,
            preserveScroll: state.activeTab === "recap",
          });
        });
        return;
      }
      if (state.activeTab === "animOverrides" || runtime.assetPicker.state) {
        Promise.all([fetchAnimationOverridesData(), fetchThemes()]).then(() => {
          normalizeAssetPickerSelection();
          requestRender({
            sidebar: true,
            content: true,
            modal: true,
            preserveScroll: state.activeTab === "recap",
          });
        });
        return;
      }
      // Any other tab that surfaces theme-derived content: full re-render.
      requestRender({
        sidebar: true,
        content: true,
        preserveScroll: state.activeTab === "recap",
      });
      return;
    }

    if (needsAnimOverridesRefresh && (state.activeTab === "animOverrides" || runtime.assetPicker.state)) {
      fetchAnimationOverridesData().then(() => {
        normalizeAssetPickerSelection();
        requestRender({
          sidebar: true,
          content: true,
          modal: true,
          preserveScroll: state.activeTab === "recap",
        });
      });
      return;
    }

    if (changes && "theme" in changes && runtime.themeList) {
      runtime.themeList = runtime.themeList.map((theme) => ({
        ...theme,
        active: theme.id === changes.theme,
      }));
    }

    requestRender({
      sidebar: true,
      content: true,
      preserveScroll: state.activeTab === "recap",
    });
  }

  core.readers = {
    readSizeUiFromSnapshot,
    readGeneralSwitchRaw,
    readGeneralSwitchVisual,
    agentSwitchStateId,
    readAgentFlagValue,
    readAgentIntegrationInstalled,
    readAgentPermissionMode,
    readAgentCustomPermissionUrl,
    readAgentCustomDiscoveryPaths,
    readCustomToolDetectionResults,
    readCustomAgentDetectionResults,
    readCustomApplications,
    getShortcutValue,
    getLang,
    readThemeOverrideMap,
    hasAnyThemeOverride,
  };

  let settingsDialogSequence = 0;
  let dismissActiveSettingsDialog = null;

  function showSettingsDialog({
    title,
    detail,
    actions,
    iconText = "",
    className = "",
    checkboxLabel = "",
    checkboxChecked = false,
    returnDetails = false,
    dismissOnBackdrop = true,
    dismissOnEscape = true,
  }) {
    const rootNode = document.getElementById("modalRoot");
    if (!rootNode) return Promise.resolve(null);
    if (typeof dismissActiveSettingsDialog === "function") dismissActiveSettingsDialog();
    return new Promise((resolve) => {
      let settled = false;
      const previousFocus = document.activeElement;
      const dialogId = `settings-dialog-${++settingsDialogSequence}`;
      const overlay = document.createElement("div");
      overlay.className = "modal-backdrop settings-dialog-backdrop settings-confirm-backdrop";

      const modal = document.createElement("div");
      modal.className = ["settings-dialog", "settings-confirm-modal", className].filter(Boolean).join(" ");
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");

      let icon = null;
      if (iconText) {
        icon = document.createElement("div");
        icon.className = "settings-confirm-icon";
        icon.setAttribute("aria-hidden", "true");
        if (String(iconText) === "!") {
          const createSvgElement = (tagName) => (
            typeof document.createElementNS === "function"
              ? document.createElementNS("http://www.w3.org/2000/svg", tagName)
              : document.createElement(tagName)
          );
          const svg = createSvgElement("svg");
          svg.setAttribute("viewBox", "0 0 20 20");
          svg.setAttribute("focusable", "false");
          const path = createSvgElement("path");
          path.setAttribute("d", "M10 4.2v7.4m0 3.1v.1");
          svg.appendChild(path);
          icon.appendChild(svg);
        } else {
          icon.textContent = String(iconText);
        }
      }

      const titleNode = document.createElement("h2");
      titleNode.id = `${dialogId}-title`;
      titleNode.textContent = title || "";
      modal.setAttribute("aria-labelledby", titleNode.id);

      const detailNode = document.createElement("p");
      detailNode.id = `${dialogId}-detail`;
      detailNode.textContent = detail || "";
      modal.setAttribute("aria-describedby", detailNode.id);

      let checkboxInput = null;
      let checkboxRow = null;
      if (checkboxLabel) {
        checkboxRow = document.createElement("label");
        checkboxRow.className = "settings-confirm-checkbox";
        checkboxInput = document.createElement("input");
        checkboxInput.type = "checkbox";
        checkboxInput.checked = checkboxChecked === true;
        const checkboxText = document.createElement("span");
        checkboxText.textContent = checkboxLabel;
        checkboxRow.appendChild(checkboxInput);
        checkboxRow.appendChild(checkboxText);
      }

      const actionsNode = document.createElement("div");
      actionsNode.className = "settings-confirm-actions";

      function close(actionId) {
        if (settled) return;
        settled = true;
        if (dismissActiveSettingsDialog === close) dismissActiveSettingsDialog = null;
        document.removeEventListener("keydown", onKeyDown, true);
        rootNode.innerHTML = "";
        if (previousFocus
            && previousFocus.isConnected !== false
            && typeof previousFocus.focus === "function") previousFocus.focus();
        resolve(returnDetails
          ? {
            actionId,
            checkboxChecked: !!(checkboxInput && checkboxInput.checked),
          }
          : actionId);
      }

      function onKeyDown(ev) {
        if (ev.key === "Escape" && dismissOnEscape) {
          ev.preventDefault();
          close(null);
          return;
        }
        if (ev.key !== "Tab") return;
        const focusable = [checkboxInput, ...buttons.map((entry) => entry.button)]
          .filter((element) => element && element.disabled !== true);
        if (focusable.length === 0) return;
        const currentIndex = focusable.indexOf(document.activeElement);
        const nextIndex = ev.shiftKey
          ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
          : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
        ev.preventDefault();
        focusable[nextIndex].focus();
      }

      overlay.addEventListener("click", (ev) => {
        if (dismissOnBackdrop && ev.target === overlay) close(null);
      });
      const buttons = (Array.isArray(actions) ? actions : []).map((action) => {
        const tone = action && typeof action.tone === "string" ? action.tone : "neutral";
        const button = buildButton({
          label: action && action.label ? action.label : "",
          tone,
          size: "large",
          className: tone === "danger" ? "settings-confirm-danger" : "",
          onClick: () => close(action && action.id ? action.id : null),
        });
        actionsNode.appendChild(button);
        return { action, button };
      });
      dismissActiveSettingsDialog = close;
      document.addEventListener("keydown", onKeyDown, true);
      if (icon) modal.appendChild(icon);
      modal.appendChild(titleNode);
      modal.appendChild(detailNode);
      if (checkboxRow) modal.appendChild(checkboxRow);
      modal.appendChild(actionsNode);
      overlay.appendChild(modal);
      rootNode.innerHTML = "";
      rootNode.appendChild(overlay);
      const focusTarget =
        buttons.find((action) => action.action && action.action.defaultFocus)
        || buttons[buttons.length - 1]
        || null;
      if (focusTarget) focusTarget.button.focus();
    });
  }

  function showSettingsConfirmModal(options = {}) {
    return showSettingsDialog({ ...options, iconText: "!" });
  }

  core.helpers = {
    t,
    buildButton,
    showSettingsDialog,
    showSettingsConfirmModal,
    escapeHtml,
    setSwitchVisual,
    attachAnimatedSwitch,
    buildSwitchRow,
    buildSection,
    buildSettingsSelect,
    buildSegmentedRadio,
    buildCollapsibleGroup,
    attachSettingsDisclosure,
    registerMountedDisposable,
    disposeMountedDisposable,
    createDisclosureChevron,
    attachActivation,
    buildShortcutButton,
    buildNumberInputRow,
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
    IS_WIN,
    SHORTCUT_ACTIONS,
    SHORTCUT_ACTION_IDS,
    buildAcceleratorFromEvent,
    formatAcceleratorLabel,
    formatAcceleratorPartial,
  };

  core.ops = {
    installRenderHooks,
    focusSettingsTarget,
    requestRender,
    selectTab,
    persistNavigationState,
    restoreNavigationState,
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
    fetchAgentInstallationHints,
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
