"use strict";

(function initSettingsWatchPanel(root) {

  function build(core, options = {}) {
    const helpers = core.helpers;
    const activeTabId = options.activeTabId || "";
    ensureWatchStatusListener(core, activeTabId);
    return helpers.buildCollapsibleGroup({
      id: options.id || "watch",
      headerContent: buildHeader(core),
      defaultCollapsed: options.defaultCollapsed !== false,
      className: [options.className || "", "watch-collapsible"].join(" ").trim(),
      children: [buildOptionList([
        buildStatusRow(core),
        buildSwitchRow(core, "enabled", "Enable", "Connect to a Wear OS watch via BLE"),
        buildTextRow(core, "address", "BLE Address", "Leave empty to auto-scan", { placeholder: "DE:9C:4D:1B:D2:BE", maxLength: 120 }),
        buildTextRow(core, "namePrefix", "Name Prefix", "Filter devices by name prefix", { placeholder: "Clawd", maxLength: 40 }),
        buildSwitchRow(core, "permissionsEnabled", "Approval on Watch", "Allow approving tool requests from the watch",
          { disabled: !getConfig(core.state).enabled }),
      ])],
    });
  }

  function t(core, key) { return core.helpers.t(key) || key; }

  function getConfig(state) {
    const snap = state.snapshot || {};
    const current = snap.watch && typeof snap.watch === "object" ? snap.watch : {};
    return {
      enabled: current.enabled === true,
      address: typeof current.address === "string" ? current.address : "",
      namePrefix: typeof current.namePrefix === "string" && current.namePrefix.trim() ? current.namePrefix : "Clawd",
      permissionsEnabled: current.permissionsEnabled === true,
    };
  }

  function ensureWatchStatusListener(core, activeTabId) {
    const runtime = core.runtime || (core.runtime = {});
    if (runtime.watchSettingsListenerInstalled) return;
    runtime.watchSettingsListenerInstalled = true;
    runtime.watchStatus = runtime.watchStatus || null;
    const rerender = () => {
      if (!activeTabId || core.state.activeTab === activeTabId) core.ops.requestRender({ content: true });
    };
    if (window.settingsAPI && typeof window.settingsAPI.getWatchStatus === "function") {
      window.settingsAPI.getWatchStatus().then((s) => { runtime.watchStatus = s || null; rerender(); }).catch(() => {});
    }
    if (window.settingsAPI && typeof window.settingsAPI.onWatchStatusChanged === "function") {
      window.settingsAPI.onWatchStatusChanged((s) => { runtime.watchStatus = s || null; rerender(); });
    }
  }

  function updateConfig(core, partial) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") return Promise.resolve({ status: "error" });
    const next = { ...getConfig(core.state), ...partial };
    return window.settingsAPI.update("watch", next).then((result) => {
      if (!result || result.status !== "ok") {
        core.ops.showToast("Save failed: " + ((result && result.message) || "unknown"), { error: true });
      }
      return result;
    }).catch((err) => {
      core.ops.showToast("Save failed: " + (err && err.message), { error: true });
      return { status: "error" };
    });
  }

  function statusKind(core) {
    const status = core.runtime && core.runtime.watchStatus;
    const config = getConfig(core.state);
    if (!config.enabled) return "off";
    if (status && status.lastError) return "error";
    if (status && status.connected) return "connected";
    if (status && status.started) return "searching";
    return "idle";
  }

  function statusText(kind) {
    return { off: "Off", error: "Error", connected: "Connected", searching: "Searching...", idle: "Idle" }[kind] || kind;
  }

  function buildHeader(core) {
    const wrap = document.createElement("div");
    wrap.className = "tg-approval-channel-header";
    const name = document.createElement("span");
    name.className = "tg-approval-channel-name";
    name.textContent = "Watch";
    wrap.appendChild(name);
    const kind = statusKind(core);
    const badge = document.createElement("span");
    const badgeClass = { connected: "tg-approval-badge-running", searching: "tg-approval-badge-starting", error: "tg-approval-badge-failed" }[kind] || "tg-approval-badge-incomplete";
    badge.className = `tg-approval-channel-badge ${badgeClass}`;
    const dot = document.createElement("span");
    dot.className = "tg-approval-channel-badge-dot";
    badge.appendChild(dot);
    const badgeText = document.createElement("span");
    badgeText.textContent = statusText(kind);
    badge.appendChild(badgeText);
    wrap.appendChild(badge);
    return wrap;
  }

  function buildStatusRow(core) {
    const status = core.runtime && core.runtime.watchStatus;
    const config = getConfig(core.state);
    const row = document.createElement("div");
    row.className = "row";
    const kind = statusKind(core);
    let detail = "Watch companion for Clawd on Desk";
    if (!config.enabled) detail = "Enable to connect a Wear OS watch";
    else if (status && status.lastError) detail = status.lastError.hint || status.lastError.message || "Error";
    else if (status && status.connected) detail = "Connected to watch";
    row.innerHTML = `<div class="row-text"><span class="row-label">Status</span><span class="row-desc"></span></div>` +
      `<div class="row-control"><span class="hardware-buddy-status-badge hardware-buddy-status-${kind}"></span></div>`;
    row.querySelector(".row-desc").textContent = detail;
    row.querySelector(".hardware-buddy-status-badge").textContent = statusText(kind);

    const isMissingBleak = status && status.lastError && status.lastError.category === "missing_bleak";
    if (isMissingBleak) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Install bleak";
      btn.style.cssText = "margin-top:6px;padding:4px 12px;font-size:12px;border-radius:6px;border:1px solid #555;background:#333;color:#eee;cursor:pointer;";
      btn.addEventListener("click", () => {
        btn.disabled = true;
        btn.textContent = "Installing bleak...";
        window.settingsAPI.command("watch.installBleak").then((result) => {
          if (result && result.status === "ok") {
            btn.textContent = "Installed! Connecting...";
            btn.style.cssText += "border-color:#4ADE80;background:#1a3a1a;";
            core.ops.showToast("bleak installed — connecting to watch...", { error: false });
            window.settingsAPI.command("watch.restart");
            // Delay the rerender so user sees the success state
            setTimeout(function() {
              if (core.runtime) core.runtime.watchStatus = { started: true, connected: false, lastError: null };
              core.ops.requestRender({ content: true });
            }, 2000);
          } else {
            btn.textContent = "Install failed";
            btn.style.cssText += "border-color:#F87171;";
            btn.disabled = false;
            core.ops.showToast("bleak install failed: " + ((result && result.message) || ""), { error: true });
          }
        }).catch(function(err) {
          btn.textContent = "Install error";
          btn.disabled = false;
          core.ops.showToast("Install error: " + (err && err.message || ""), { error: true });
        });
      });
      row.querySelector(".row-text").appendChild(btn);
    }
    return row;
  }

  function buildSwitchRow(core, field, label, desc, opts = {}) {
    const config = getConfig(core.state);
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div class="row-text"><span class="row-label"></span><span class="row-desc"></span></div>` +
      `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
    row.querySelector(".row-label").textContent = label;
    row.querySelector(".row-desc").textContent = desc;
    const sw = row.querySelector(".switch");
    core.helpers.setSwitchVisual(sw, config[field] === true, { pending: false });
    if (opts.disabled) { sw.classList.add("disabled"); sw.setAttribute("aria-disabled", "true"); sw.tabIndex = -1; }
    const run = () => {
      if (sw.classList.contains("disabled") || sw.classList.contains("pending")) return;
      const next = !(getConfig(core.state)[field] === true);
      core.helpers.setSwitchVisual(sw, next, { pending: true });
      updateConfig(core, { [field]: next }).then((r) => {
        core.helpers.setSwitchVisual(sw, r && r.status === "ok" ? next : getConfig(core.state)[field] === true, { pending: false });
      });
    };
    sw.addEventListener("click", run);
    sw.addEventListener("keydown", (ev) => { if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); run(); } });
    return row;
  }

  function buildTextRow(core, field, label, desc, opts = {}) {
    const config = getConfig(core.state);
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div class="row-text"><span class="row-label"></span><span class="row-desc"></span></div>` +
      `<div class="row-control hardware-buddy-text-control"><input type="text" class="hardware-buddy-text-input" /></div>`;
    row.querySelector(".row-label").textContent = label;
    row.querySelector(".row-desc").textContent = desc;
    const input = row.querySelector("input");
    input.value = config[field] || "";
    input.placeholder = opts.placeholder || "";
    input.maxLength = opts.maxLength || 120;
    let last = input.value;
    function commit() {
      const v = input.value.trim();
      if (v === last) return;
      input.classList.add("pending");
      updateConfig(core, { [field]: v }).then((r) => { input.classList.remove("pending"); if (r && r.status === "ok") last = v; else input.value = last; });
    }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); commit(); input.blur(); } if (ev.key === "Escape") { input.value = last; input.blur(); } });
    return row;
  }

  function buildOptionList(rows) {
    const list = document.createElement("div");
    list.className = "settings-option-list";
    for (const row of rows) { row.classList.add("settings-option-item"); list.appendChild(row); }
    return list;
  }

  root.ClawdSettingsWatchPanel = { build };
})(globalThis);
