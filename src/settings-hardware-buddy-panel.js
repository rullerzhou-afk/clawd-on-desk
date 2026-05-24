"use strict";

(function initSettingsHardwareBuddyPanel(root) {
  const DEFAULT_NAME_PREFIX = "Clawstick";

  function build(core, options = {}) {
    const state = core.state;
    const helpers = core.helpers;
    const activeTabId = options.activeTabId || "";

    ensureHardwareBuddyStatusListener(core, activeTabId);

    const className = [options.className || "", "hardware-buddy-collapsible"]
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
    return helpers.buildCollapsibleGroup({
      id: options.id || "hardware-buddy",
      headerContent: buildHardwareBuddyChannelHeader(core),
      defaultCollapsed: options.defaultCollapsed !== false,
      className,
      children: [buildOptionList("hardware-buddy-option-list", [
        buildHardwareBuddyStatusRow(core),
        buildHardwareBuddySwitchRow(core, "enabled", "hardwareBuddyEnable", "hardwareBuddyEnableDesc"),
        buildHardwareBuddyTextRow(core, "address", "hardwareBuddyAddress", "hardwareBuddyAddressDesc", {
          placeholder: "00:4B:12:A1:9E:A6",
          maxLength: 120,
        }),
        buildHardwareBuddyTextRow(core, "namePrefix", "hardwareBuddyNamePrefix", "hardwareBuddyNamePrefixDesc", {
          placeholder: DEFAULT_NAME_PREFIX,
          maxLength: 40,
        }),
        buildHardwareBuddySwitchRow(
          core,
          "permissionsEnabled",
          "hardwareBuddyPermissions",
          "hardwareBuddyPermissionsDesc",
          { disabled: !getHardwareBuddyConfig(state).enabled }
        ),
        buildHardwareBuddySwitchRow(core, "quickCommandsEnabled", "hardwareBuddyQuickCommands", "hardwareBuddyQuickCommandsDesc"),
        buildQuickCommandPresetRow(core),
        buildHardwareBuddyTestRow(core),
      ])],
    });
  }

  function t(core, key) {
    return core.helpers.t(key);
  }

  function getHardwareBuddyConfig(state) {
    const snap = state.snapshot || {};
    const current = snap.hardwareBuddy && typeof snap.hardwareBuddy === "object" ? snap.hardwareBuddy : {};
    return {
      enabled: current.enabled === true,
      backend: current.backend === "fake" ? "fake" : "bleak",
      address: typeof current.address === "string" ? current.address : "",
      namePrefix: typeof current.namePrefix === "string" && current.namePrefix.trim() ? current.namePrefix : DEFAULT_NAME_PREFIX,
      permissionsEnabled: current.permissionsEnabled === true,
      quickCommandsEnabled: current.quickCommandsEnabled === true,
    };
  }

  function ensureHardwareBuddyStatusListener(core, activeTabId) {
    const runtime = core.runtime || (core.runtime = {});
    if (runtime.hardwareBuddySettingsListenerInstalled) return;
    runtime.hardwareBuddySettingsListenerInstalled = true;
    runtime.hardwareBuddyStatus = runtime.hardwareBuddyStatus || null;

    const requestActiveTabRender = () => {
      if (!activeTabId || core.state.activeTab === activeTabId) {
        core.ops.requestRender({ content: true });
      }
    };

    if (window.settingsAPI && typeof window.settingsAPI.getHardwareBuddyStatus === "function") {
      window.settingsAPI.getHardwareBuddyStatus().then((status) => {
        runtime.hardwareBuddyStatus = status || null;
        requestActiveTabRender();
      }).catch(() => {});
    }
    if (window.settingsAPI && typeof window.settingsAPI.getQuickCommandPresets === "function") {
      runtime.quickCommandPresetsLoading = true;
      window.settingsAPI.getQuickCommandPresets().then((payload) => {
        runtime.quickCommandPresetsLoading = false;
        runtime.quickCommandPresets = payload || { enabled: false, presets: [] };
        requestActiveTabRender();
      }).catch(() => {
        runtime.quickCommandPresetsLoading = false;
        runtime.quickCommandPresets = { enabled: false, presets: [] };
        requestActiveTabRender();
      });
    }
    if (window.settingsAPI && typeof window.settingsAPI.onHardwareBuddyStatusChanged === "function") {
      window.settingsAPI.onHardwareBuddyStatusChanged((status) => {
        runtime.hardwareBuddyStatus = status || null;
        if (status && status.quickCommands) {
          runtime.quickCommandPresets = {
            ...(runtime.quickCommandPresets || { presets: [] }),
            enabled: status.quickCommands.enabled === true,
          };
        }
        requestActiveTabRender();
      });
    }
  }

  function updateHardwareBuddyConfig(core, partial) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      core.ops.showToast(t(core, "toastSaveFailed") + "settings API unavailable", { error: true });
      return Promise.resolve({ status: "error", message: "settings API unavailable" });
    }
    const next = { ...getHardwareBuddyConfig(core.state), ...(partial || {}) };
    return window.settingsAPI.update("hardwareBuddy", next).then((result) => {
      if (!result || result.status !== "ok") {
        const msg = (result && result.message) || "unknown error";
        core.ops.showToast(t(core, "toastSaveFailed") + msg, { error: true });
      }
      return result;
    }).catch((err) => {
      core.ops.showToast(t(core, "toastSaveFailed") + (err && err.message), { error: true });
      return { status: "error", message: err && err.message };
    });
  }

  function hardwareBuddyStatusKind(core, status, config = getHardwareBuddyConfig(core.state)) {
    if (!config.enabled) return "off";
    if (status && status.lastError) return "error";
    if (status && status.connected && status.secure) return "secure";
    if (status && status.connected) return "connected";
    if (status && status.started) return "searching";
    return "idle";
  }

  function hardwareBuddyStatusText(core, status, config = getHardwareBuddyConfig(core.state)) {
    const kind = hardwareBuddyStatusKind(core, status, config);
    if (kind === "error") {
      const category = status && status.lastError && status.lastError.category;
      const key = `hardwareBuddyErr_${category || "sidecar_error"}`;
      const translated = t(core, key);
      return translated === key ? t(core, "hardwareBuddyStatusError") : translated;
    }
    return t(core, `hardwareBuddyStatus_${kind}`);
  }

  function hardwareBuddyReplyKind(status, config = {}) {
    if (!config.enabled || !config.permissionsEnabled) return "off";
    if (status && status.connected && status.secure) return "on";
    return "blocked";
  }

  function hardwareBuddyReplyText(core, status, config = getHardwareBuddyConfig(core.state)) {
    const kind = hardwareBuddyReplyKind(status, config);
    if (kind === "on") return t(core, "hardwareBuddyRepliesOn");
    if (kind === "blocked") return t(core, "hardwareBuddyRepliesBlocked");
    return t(core, "hardwareBuddyRepliesOff");
  }

  function hardwareBuddyStatusDetail(core, status, config = getHardwareBuddyConfig(core.state)) {
    if (!config.enabled) return t(core, "hardwareBuddyStatusOffDetail");
    const err = status && status.lastError;
    if (err) return err.hint || err.message || t(core, "hardwareBuddyStatusErrorDetail");
    if (status && status.connected) {
      const data = status.lastStatus && status.lastStatus.data;
      const device = status.lastStatus && status.lastStatus.device;
      const name = (data && data.name) || (device && device.name) || config.namePrefix;
      const secure = status.secure ? t(core, "hardwareBuddySecureOn") : t(core, "hardwareBuddySecureOff");
      return t(core, "hardwareBuddyStatusConnectedDetail")
        .replace("{device}", name)
        .replace("{secure}", secure);
    }
    if (config.address) {
      return t(core, "hardwareBuddyStatusAddressDetail").replace("{address}", config.address);
    }
    return t(core, "hardwareBuddyStatusPrefixDetail").replace("{prefix}", config.namePrefix);
  }

  function buildHardwareBuddyChannelHeader(core) {
    const wrap = document.createElement("div");
    wrap.className = "tg-approval-channel-header hardware-buddy-channel-header";

    const nameEl = document.createElement("span");
    nameEl.className = "tg-approval-channel-name";
    nameEl.textContent = t(core, "hardwareBuddyTitle");
    wrap.appendChild(nameEl);

    const status = core.runtime && core.runtime.hardwareBuddyStatus;
    const config = getHardwareBuddyConfig(core.state);
    const kind = hardwareBuddyStatusKind(core, status, config);
    const badge = document.createElement("span");
    badge.className = `tg-approval-channel-badge hardware-buddy-channel-badge ${hardwareBuddyChannelBadgeClass(kind)}`;
    const dot = document.createElement("span");
    dot.className = "tg-approval-channel-badge-dot";
    badge.appendChild(dot);
    const badgeText = document.createElement("span");
    badgeText.textContent = hardwareBuddyStatusText(core, status, config);
    badge.appendChild(badgeText);
    wrap.appendChild(badge);
    return wrap;
  }

  function hardwareBuddyChannelBadgeClass(kind) {
    switch (kind) {
      case "secure": return "tg-approval-badge-running";
      case "connected": return "tg-approval-badge-ready";
      case "searching": return "tg-approval-badge-starting";
      case "error": return "tg-approval-badge-failed";
      case "off":
      case "idle":
      default: return "tg-approval-badge-incomplete";
    }
  }

  function buildHardwareBuddyStatusRow(core) {
    const status = core.runtime && core.runtime.hardwareBuddyStatus;
    const config = getHardwareBuddyConfig(core.state);
    const row = document.createElement("div");
    row.className = "row hardware-buddy-status-row";
    const kind = hardwareBuddyStatusKind(core, status, config);
    const replyKind = hardwareBuddyReplyKind(status, config);
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control hardware-buddy-status-control">` +
        `<span class="hardware-buddy-status-badge"></span>` +
        `<span class="hardware-buddy-status-badge hardware-buddy-reply-badge"></span>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t(core, "hardwareBuddyStatus");
    row.querySelector(".row-desc").textContent = hardwareBuddyStatusDetail(core, status, config);
    const badge = row.querySelector(".hardware-buddy-status-badge");
    badge.className = `hardware-buddy-status-badge hardware-buddy-status-${kind}`;
    badge.textContent = hardwareBuddyStatusText(core, status, config);
    const replyBadge = row.querySelector(".hardware-buddy-reply-badge");
    replyBadge.className = `hardware-buddy-status-badge hardware-buddy-reply-badge hardware-buddy-reply-${replyKind}`;
    replyBadge.textContent = hardwareBuddyReplyText(core, status, config);
    return row;
  }

  function getHardwareBuddyRuntime(core) {
    const runtime = core.runtime || (core.runtime = {});
    runtime.hardwareBuddyTest = runtime.hardwareBuddyTest || {
      pending: false,
      result: null,
      contextKey: "",
    };
    return runtime.hardwareBuddyTest;
  }

  function hardwareBuddyTestContextKey(status, config) {
    return [
      config.enabled ? "enabled" : "disabled",
      config.permissionsEnabled ? "replies-on" : "replies-off",
      status && status.connected ? "connected" : "disconnected",
      status && status.secure ? "secure" : "insecure",
    ].join("|");
  }

  function syncHardwareBuddyTestContext(testState, status, config) {
    const contextKey = hardwareBuddyTestContextKey(status, config);
    if (testState.contextKey && testState.contextKey !== contextKey && !testState.pending) {
      testState.result = null;
    }
    testState.contextKey = contextKey;
  }

  function hardwareBuddyTestErrorText(core, result) {
    const code = result && typeof result.code === "string" ? result.code : "";
    if (code) {
      const key = `hardwareBuddyTestErr_${code}`;
      const translated = t(core, key);
      if (translated !== key) return translated;
    }
    return result && result.message ? result.message : t(core, "hardwareBuddyTestError");
  }

  function hardwareBuddyTestDetail(core, status, config, testState) {
    if (testState.pending) return t(core, "hardwareBuddyTestPending");
    if (testState.result && testState.result.status === "ok") {
      return t(core, "hardwareBuddyTestOk").replace("{decision}", testState.result.decision || "");
    }
    if (testState.result && testState.result.status === "error") {
      return hardwareBuddyTestErrorText(core, testState.result);
    }
    if (!config.enabled) return t(core, "hardwareBuddyTestDisabled");
    if (!config.permissionsEnabled) return t(core, "hardwareBuddyTestRepliesOff");
    if (!(status && status.connected && status.secure)) return t(core, "hardwareBuddyTestNeedsSecure");
    return t(core, "hardwareBuddyTestDesc");
  }

  function buildHardwareBuddyTestRow(core) {
    const status = core.runtime && core.runtime.hardwareBuddyStatus;
    const config = getHardwareBuddyConfig(core.state);
    const testState = getHardwareBuddyRuntime(core);
    syncHardwareBuddyTestContext(testState, status, config);
    const canTest = config.enabled && config.permissionsEnabled
      && status && status.connected && status.secure
      && !testState.pending
      && window.settingsAPI && typeof window.settingsAPI.testHardwareBuddyApproval === "function";
    const row = document.createElement("div");
    row.className = "row hardware-buddy-test-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control">` +
        `<button type="button" class="hardware-buddy-test-button"></button>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t(core, "hardwareBuddyTest");
    row.querySelector(".row-desc").textContent = hardwareBuddyTestDetail(core, status, config, testState);
    const button = row.querySelector("button");
    button.textContent = testState.pending ? t(core, "hardwareBuddyTestWaiting") : t(core, "hardwareBuddyTestButton");
    button.disabled = !canTest;
    button.addEventListener("click", () => {
      if (button.disabled || testState.pending) return;
      testState.pending = true;
      testState.result = null;
      core.ops.requestRender({ content: true });
      window.settingsAPI.testHardwareBuddyApproval().then((result) => {
        testState.pending = false;
        testState.result = result || { status: "error", message: t(core, "hardwareBuddyTestError") };
        if (testState.result.status === "ok") {
          core.ops.showToast(t(core, "hardwareBuddyTestToastOk"), { error: false });
        } else {
          core.ops.showToast(t(core, "hardwareBuddyTestToastError") + hardwareBuddyTestErrorText(core, testState.result), { error: true });
        }
        core.ops.requestRender({ content: true });
      }).catch((err) => {
        testState.pending = false;
        testState.result = { status: "error", message: err && err.message ? err.message : String(err) };
        core.ops.showToast(t(core, "hardwareBuddyTestToastError") + hardwareBuddyTestErrorText(core, testState.result), { error: true });
        core.ops.requestRender({ content: true });
      });
    });
    return row;
  }

  function getQuickCommandPresetState(core) {
    const runtime = core.runtime || {};
    const payload = runtime.quickCommandPresets && typeof runtime.quickCommandPresets === "object"
      ? runtime.quickCommandPresets
      : { enabled: false, presets: [] };
    return {
      enabled: payload.enabled === true,
      presets: Array.isArray(payload.presets) ? payload.presets : [],
      loading: runtime.quickCommandPresetsLoading === true,
    };
  }

  function getQuickCommandPendingIds(core) {
    const runtime = core.runtime || {};
    if (!(runtime.quickCommandPendingIds instanceof Set)) {
      runtime.quickCommandPendingIds = new Set();
    }
    return runtime.quickCommandPendingIds;
  }

  function buildQuickCommandPresetRow(core) {
    const config = getHardwareBuddyConfig(core.state);
    const presetState = getQuickCommandPresetState(core);
    const pendingIds = getQuickCommandPendingIds(core);
    const canSend = config.quickCommandsEnabled
      && presetState.enabled
      && window.settingsAPI
      && typeof window.settingsAPI.sendQuickCommand === "function";
    const row = document.createElement("div");
    row.className = "row hardware-buddy-quick-command-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control hardware-buddy-quick-command-control"></div>`;
    row.querySelector(".row-label").textContent = t(core, "hardwareBuddyQuickCommandPresets");
    row.querySelector(".row-desc").textContent = quickCommandPresetDetail(core, config, presetState);
    const control = row.querySelector(".hardware-buddy-quick-command-control");
    if (!presetState.presets.length) {
      const empty = document.createElement("span");
      empty.className = "hardware-buddy-quick-command-empty";
      empty.textContent = t(core, presetState.loading ? "hardwareBuddyQuickCommandsLoading" : "hardwareBuddyQuickCommandsUnavailable");
      control.appendChild(empty);
      return row;
    }
    for (const preset of presetState.presets) {
      if (!preset || typeof preset.id !== "string" || typeof preset.label !== "string") continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "soft-btn hardware-buddy-quick-command-button";
      button.textContent = preset.label;
      const pending = pendingIds.has(preset.id);
      button.disabled = !canSend || pending;
      if (pending) button.classList.add("pending");
      button.addEventListener("click", () => {
        if (button.disabled) return;
        sendQuickCommand(core, preset.id, button);
      });
      control.appendChild(button);
    }
    return row;
  }

  function quickCommandPresetDetail(core, config, presetState) {
    if (!config.quickCommandsEnabled) return t(core, "hardwareBuddyQuickCommandsDisabled");
    if (presetState.loading) return t(core, "hardwareBuddyQuickCommandsLoading");
    if (!presetState.enabled) return t(core, "hardwareBuddyQuickCommandsUnavailable");
    return t(core, "hardwareBuddyQuickCommandPresetsDesc");
  }

  function quickCommandClientRequestId(id) {
    const suffix = Math.random().toString(36).slice(2, 10);
    return `clawd-settings-${id}-${Date.now()}-${suffix}`;
  }

  function sendQuickCommand(core, id, button) {
    const pendingIds = getQuickCommandPendingIds(core);
    if (pendingIds.has(id)) return;
    pendingIds.add(id);
    button.disabled = true;
    button.classList.add("pending");
    window.settingsAPI.sendQuickCommand({
      id,
      clientRequestId: quickCommandClientRequestId(id),
    }).then((result) => {
      if (result && result.status === "ok") {
        core.ops.showToast(t(core, "hardwareBuddyQuickCommandSent"), { error: false });
      } else {
        const msg = (result && result.message) || "unknown error";
        core.ops.showToast(t(core, "hardwareBuddyQuickCommandFailed") + msg, { error: true });
      }
    }).catch((err) => {
      const msg = err && err.message ? err.message : "unknown error";
      core.ops.showToast(t(core, "hardwareBuddyQuickCommandFailed") + msg, { error: true });
    }).finally(() => {
      pendingIds.delete(id);
      button.classList.remove("pending");
      core.ops.requestRender({ content: true });
    });
  }

  function buildHardwareBuddySwitchRow(core, field, labelKey, descKey, options = {}) {
    const config = getHardwareBuddyConfig(core.state);
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
    row.querySelector(".row-label").textContent = t(core, labelKey);
    row.querySelector(".row-desc").textContent = t(core, descKey);
    const sw = row.querySelector(".switch");
    const disabled = options.disabled === true;
    core.helpers.setSwitchVisual(sw, config[field] === true, { pending: false });
    if (disabled) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.tabIndex = -1;
    }
    const run = () => {
      if (sw.classList.contains("disabled") || sw.classList.contains("pending")) return;
      const nextValue = !(getHardwareBuddyConfig(core.state)[field] === true);
      core.helpers.setSwitchVisual(sw, nextValue, { pending: true });
      updateHardwareBuddyConfig(core, { [field]: nextValue }).then((result) => {
        core.helpers.setSwitchVisual(
          sw,
          result && result.status === "ok" ? nextValue : getHardwareBuddyConfig(core.state)[field] === true,
          { pending: false }
        );
      });
    };
    sw.addEventListener("click", run);
    sw.addEventListener("keydown", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      ev.preventDefault();
      run();
    });
    return row;
  }

  function buildHardwareBuddyTextRow(core, field, labelKey, descKey, options = {}) {
    const config = getHardwareBuddyConfig(core.state);
    const row = document.createElement("div");
    row.className = "row hardware-buddy-field-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control hardware-buddy-text-control">` +
        `<input type="text" class="hardware-buddy-text-input" />` +
      `</div>`;
    row.querySelector(".row-label").textContent = t(core, labelKey);
    row.querySelector(".row-desc").textContent = t(core, descKey);
    const input = row.querySelector("input");
    input.value = config[field] || "";
    input.placeholder = options.placeholder || "";
    input.maxLength = options.maxLength || 120;
    let lastCommitted = input.value;

    function commit() {
      const nextValue = input.value.trim();
      if (nextValue === lastCommitted) return;
      input.classList.add("pending");
      updateHardwareBuddyConfig(core, { [field]: nextValue }).then((result) => {
        input.classList.remove("pending");
        if (!result || result.status !== "ok") {
          input.value = lastCommitted;
          return;
        }
        lastCommitted = nextValue;
      });
    }

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
        input.blur();
      }
      if (ev.key === "Escape") {
        input.value = lastCommitted;
        input.blur();
      }
    });
    return row;
  }

  function buildOptionList(className, rows) {
    const list = document.createElement("div");
    list.className = `settings-option-list ${className || ""}`.trim();
    for (const row of rows) {
      row.classList.add("settings-option-item");
      list.appendChild(row);
    }
    return list;
  }

  root.ClawdSettingsHardwareBuddyPanel = { build };
})(globalThis);
