"use strict";

(function initSettingsTabDiscordPresence(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  const view = {
    appIdDraft: null,
    appIdDirty: false,
    configPending: false,
  };

  const APP_ID_RE = /^[0-9]{17,20}$/;

  function t(key) {
    return helpers.t(key);
  }

  function currentConfig() {
    const cfg = state.snapshot && state.snapshot.discordPresence;
    return {
      enabled: !!(cfg && cfg.enabled),
      applicationId: cfg && typeof cfg.applicationId === "string" ? cfg.applicationId : "",
      privacyShowProject: !!(cfg && cfg.privacyShowProject === true),
    };
  }

  function appIdDraft() {
    if (view.appIdDraft === null || !view.appIdDirty) {
      view.appIdDraft = currentConfig().applicationId;
    }
    return view.appIdDraft;
  }

  function saveConfig(next) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    view.configPending = true;
    ops.requestRender({ content: true });
    window.settingsAPI.update("discordPresence", next).then((result) => {
      view.configPending = false;
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("toastSaveFailed"), { error: true });
        ops.requestRender({ content: true });
        return;
      }
      ops.showToast(t("discordPresenceConfigSaved"));
      view.appIdDirty = false;
      view.appIdDraft = null;
      ops.requestRender({ content: true });
    }).catch((err) => {
      view.configPending = false;
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      ops.requestRender({ content: true });
    });
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("discordPresenceTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("discordPresenceSubtitle");
    parent.appendChild(subtitle);

    const note = document.createElement("p");
    note.className = "subtitle";
    note.textContent = t("discordPresenceDesktopRequiredNote");
    parent.appendChild(note);

    parent.appendChild(helpers.buildSection(t("discordPresenceSetupTitle"), [buildAppIdRow()]));
    parent.appendChild(helpers.buildSection(t("discordPresenceActivityTitle"), [
      buildEnabledRow(),
      buildProjectPrivacyRow(),
    ]));
  }

  function buildAppIdRow() {
    const draft = appIdDraft();
    const row = document.createElement("div");
    // tg-approval-token-edit-row stacks the row vertically (label above,
    // input+button below). Both classes are required together: input-row's
    // width:100% inside a default horizontal .row squeezes .row-text into a
    // single-glyph column (see the settings.css note above that rule).
    row.className = "row tg-approval-token-edit-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("discordPresenceAppIdLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.innerHTML = escapeWithLink(t("discordPresenceAppIdHintHtml"));
    bindExternalLinks(desc);
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control tg-approval-input-row";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.spellcheck = false;
    input.placeholder = t("discordPresenceAppIdPlaceholder");
    input.className = "tg-approval-input";
    input.value = draft || "";
    input.addEventListener("input", () => {
      view.appIdDraft = input.value;
      view.appIdDirty = true;
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = view.configPending ? t("discordPresenceSaving") : t("discordPresenceSaveAppId");
    saveBtn.disabled = view.configPending;
    saveBtn.addEventListener("click", () => {
      const raw = String(view.appIdDraft == null ? draft : view.appIdDraft).trim();
      if (raw && !APP_ID_RE.test(raw)) {
        ops.showToast(t("discordPresenceInvalidAppId"), { error: true });
        return;
      }
      const cfg = currentConfig();
      saveConfig({ ...cfg, applicationId: raw });
    });

    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);
    row.appendChild(ctrl);
    return row;
  }

  function buildEnabledRow() {
    const cfg = currentConfig();
    // A baked-in default App ID makes presence usable without a user-saved one,
    // matching readiness() in discord-presence-settings.js.
    const ready = !!(cfg.applicationId || (window.settingsAPI && window.settingsAPI.discordDefaultAppIdPresent));
    const row = document.createElement("div");
    row.className = "row";
    if (!ready) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("discordPresenceEnableLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = ready ? t("discordPresenceEnableDesc") : t("discordPresenceEnableNeedsAppId");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", "0");
    helpers.setSwitchVisual(sw, cfg.enabled, { pending: view.configPending });
    if (!ready || view.configPending) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.removeAttribute("tabindex");
    } else {
      const toggle = () => saveConfig({ ...cfg, enabled: !cfg.enabled });
      sw.addEventListener("click", toggle);
      sw.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); toggle(); }
      });
    }
    ctrl.appendChild(sw);
    row.appendChild(ctrl);
    return row;
  }

  function buildProjectPrivacyRow() {
    const cfg = currentConfig();
    const row = document.createElement("div");
    row.className = "row";
    // Sub-option of the enable switch: grey it out while presence is off
    // (the saved value still applies once presence is enabled).
    if (!cfg.enabled) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("discordPresencePrivacyProject");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("discordPresencePrivacyProjectDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", "0");
    helpers.setSwitchVisual(sw, cfg.privacyShowProject, { pending: view.configPending });
    if (!cfg.enabled || view.configPending) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.removeAttribute("tabindex");
    } else {
      const toggle = () => saveConfig({ ...cfg, privacyShowProject: !cfg.privacyShowProject });
      sw.addEventListener("click", toggle);
      sw.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); toggle(); }
      });
    }
    ctrl.appendChild(sw);
    row.appendChild(ctrl);
    return row;
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Whitelists only Discord Developer Portal links, so a malicious translation
  // can't inject arbitrary HTML.
  function escapeWithLink(text) {
    const raw = String(text == null ? "" : text);
    const parts = [];
    let lastIdx = 0;
    const re = /\[([^\]]+)\]\((https:\/\/discord\.com\/developers[A-Za-z0-9_./?#=&-]*)\)/g;
    let match;
    while ((match = re.exec(raw)) !== null) {
      parts.push(escapeHtml(raw.slice(lastIdx, match.index)));
      parts.push(`<a href="${escapeHtml(match[2])}">${escapeHtml(match[1])}</a>`);
      lastIdx = match.index + match[0].length;
    }
    parts.push(escapeHtml(raw.slice(lastIdx)));
    return parts.join("");
  }

  // Route clicks through the main-process shell.openExternal; a plain
  // target="_blank" would make Electron pop a bare BrowserWindow instead of
  // the user's browser.
  function bindExternalLinks(el) {
    for (const a of el.querySelectorAll("a[href]")) {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        helpers.openExternalSafe(a.href);
      });
    }
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs["discord-presence"] = { render };
  }

  root.ClawdSettingsTabDiscordPresence = { init };
})(globalThis);
