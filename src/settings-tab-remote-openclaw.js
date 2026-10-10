"use strict";

// Remote OpenClaw tab — connect the pet to a remote OpenClaw gateway by URL.
//
// Config lives in `prefs.remoteOpenclaw` and is written through the generic
// `settingsAPI.update` path (validated by settings-actions.js), the same way
// the Discord Presence tab persists its block.
//
// Scope note surfaced in the UI: a gateway connection is granted
// `role: operator` with an EMPTY scope list, so the client never subscribes —
// it consumes the gateway's own broadcast. See remote-openclaw-runtime.js.
// That is why there is no "subscribe" affordance here.

(function initSettingsTabRemoteOpenclaw(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  // Tab-scoped view state. Drafts are kept separately from the snapshot so a
  // rerender triggered by an unrelated settings change doesn't wipe typing.
  const view = {
    urlDraft: null,
    credDraft: null,
    filterDraft: null,
    pending: false,
    status: null,
    listenerInstalled: false,
    // null = not asked yet. The renderer never learns the credential itself,
    // only whether one is stored — see remote-openclaw-credential-store.js.
    credentialConfigured: null,
    credentialPending: false,
  };

  function t(key) {
    return helpers.t(key);
  }

  function currentConfig() {
    const cfg = state.snapshot && state.snapshot.remoteOpenclaw;
    return {
      enabled: !!(cfg && cfg.enabled),
      url: cfg && typeof cfg.url === "string" ? cfg.url : "",
      authMode: cfg && cfg.authMode === "token" ? "token" : "password",
      agentFilter: cfg && typeof cfg.agentFilter === "string" ? cfg.agentFilter : "",
    };
  }

  // One-shot fetch. Guarded by `credentialConfigured !== null` so a rerender
  // triggered by the answer does not ask again (and loop).
  function ensureCredentialStatus() {
    if (view.credentialConfigured !== null) return;
    const api = window.remoteOpenclaw;
    if (!api || typeof api.credentialStatus !== "function") return;
    view.credentialConfigured = false;
    api.credentialStatus().then((result) => {
      view.credentialConfigured = !!(result && result.configured);
      ops.requestRender({ content: true });
    }).catch(() => {
      view.credentialConfigured = false;
    });
  }

  function saveCredential(raw) {
    const api = window.remoteOpenclaw;
    if (!api || typeof api.setCredential !== "function") {
      ops.showToast(t("toastSaveFailed"), { error: true });
      return;
    }
    view.credentialPending = true;
    ops.requestRender({ content: true });
    api.setCredential(String(raw || "")).then((result) => {
      view.credentialPending = false;
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("remoteOpenclawCredentialFailed"), { error: true });
        ops.requestRender({ content: true });
        return;
      }
      view.credDraft = null;
      view.credentialConfigured = true;
      ops.showToast(t("remoteOpenclawCredentialStored"));
      ops.requestRender({ content: true });
    }).catch(() => {
      view.credentialPending = false;
      ops.showToast(t("remoteOpenclawCredentialFailed"), { error: true });
      ops.requestRender({ content: true });
    });
  }

  function saveConfig(next) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed"), { error: true });
      return;
    }
    view.pending = true;
    ops.requestRender({ content: true });
    window.settingsAPI.update("remoteOpenclaw", next).then((result) => {
      view.pending = false;
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("toastSaveFailed"), { error: true });
        ops.requestRender({ content: true });
        return;
      }
      ops.showToast(t("remoteOpenclawSaved"));
      view.urlDraft = null;
      view.credDraft = null;
      view.filterDraft = null;
      ops.requestRender({ content: true });
    }).catch(() => {
      view.pending = false;
      ops.showToast(t("toastSaveFailed"), { error: true });
      ops.requestRender({ content: true });
    });
  }

  // The runtime pushes connection status over IPC once main.js wires
  // window.remoteOpenclaw. Absent that (or before the first event) the tab
  // simply shows nothing rather than a fake "connected".
  function ensureStatusListener() {
    if (view.listenerInstalled) return;
    const api = window.remoteOpenclaw;
    if (!api || typeof api.onStatusChanged !== "function") return;
    view.listenerInstalled = true;
    api.onStatusChanged((s) => {
      view.status = s || null;
      ops.requestRender({ content: true });
    });
  }

  function buildSwitchRow(cfg, options) {
    const row = document.createElement("div");
    row.className = "row";
    if (options.dimmed) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.id = options.labelId;
    label.textContent = options.label;
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.id = options.descId;
    desc.textContent = options.desc;
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const control = helpers.buildSwitch({
      checked: !!options.checked,
      pending: view.pending,
      disabled: !!options.disabled,
      ariaLabelledBy: label.id,
      ariaDescribedBy: desc.id,
      onToggle: options.onToggle,
    });
    ctrl.appendChild(control.element);
    row.appendChild(ctrl);
    return row;
  }

  function buildInputRow(cfg, options) {
    const row = document.createElement("div");
    row.className = "row tg-approval-token-edit-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = options.label;
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = options.desc;
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    // Both classes are required together: inside a horizontal .row the
    // input-row's width:100% would squeeze .row-text into a single-glyph
    // column (see the settings.css note above that rule).
    const ctrl = document.createElement("div");
    ctrl.className = "row-control tg-approval-input-row";
    const input = document.createElement("input");
    input.type = options.type || "text";
    input.className = "tg-approval-input";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = options.value == null ? "" : String(options.value);
    if (options.placeholder) input.placeholder = options.placeholder;
    input.addEventListener("input", () => {
      options.onDraft(input.value);
    });
    // Credential saves go through their own IPC and their own pending flag;
    // everything else shares the settings-write flag.
    const pending = options.pending === undefined ? view.pending : options.pending;
    const saveBtn = helpers.buildButton({
      labelKey: pending ? "remoteOpenclawSaving" : "remoteOpenclawSave",
      tone: "accent",
      disabled: pending,
      pending,
    });
    saveBtn.addEventListener("click", () => {
      options.onSave(input.value);
    });
    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);
    row.appendChild(ctrl);
    return row;
  }

  function buildEnabledRow(cfg) {
    return buildSwitchRow(cfg, {
      labelId: "settings-remote-openclaw-enabled-label",
      descId: "settings-remote-openclaw-enabled-description",
      label: t("remoteOpenclawEnableLabel"),
      desc: t("remoteOpenclawEnableDesc"),
      checked: cfg.enabled,
      dimmed: false,
      onToggle: () => saveConfig({ ...cfg, enabled: !cfg.enabled }),
    });
  }

  function buildUrlRow(cfg) {
    if (view.urlDraft === null) view.urlDraft = cfg.url;
    return buildInputRow(cfg, {
      label: t("remoteOpenclawUrlLabel"),
      desc: t("remoteOpenclawUrlDesc"),
      placeholder: "openclaw.example.com",
      value: view.urlDraft,
      onDraft: (v) => {
        view.urlDraft = v;
      },
      onSave: (v) => {
        const raw = String(v || "").trim();
        if (raw && !raw.includes("://") && !/^[a-zA-Z0-9.-]+(:\d+)?(\/.*)?$/.test(raw)) {
          ops.showToast(t("remoteOpenclawUrlInvalid"), { error: true });
          return;
        }
        saveConfig({ ...cfg, url: raw });
      },
    });
  }

  function buildAuthModeRow(cfg) {
    const row = document.createElement("div");
    row.className = "row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("remoteOpenclawAuthModeLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("remoteOpenclawAuthModeDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    // The gateway accepts either credential shape; this is the project's
    // standard two-way control, so no new CSS is needed.
    const control = helpers.buildSegmentedRadio({
      value: cfg.authMode,
      ariaLabel: t("remoteOpenclawAuthModeLabel"),
      options: [
        { value: "password", label: t("remoteOpenclawAuthModePassword") },
        { value: "token", label: t("remoteOpenclawAuthModeToken") },
      ],
      onChange: (next) => {
        // Switching modes invalidates whatever credential was typed, and the
        // stored secret means something different in the other mode — so drop
        // it rather than try to reinterpret it.
        view.credDraft = null;
        view.credentialConfigured = false;
        const api = window.remoteOpenclaw;
        if (api && typeof api.clearCredential === "function") {
          Promise.resolve(api.clearCredential()).catch(() => {});
        }
        saveConfig({ ...cfg, authMode: next === "token" ? "token" : "password" });
      },
    });
    ctrl.appendChild(control.element);
    row.appendChild(ctrl);
    return row;
  }

  // The field is always empty when rendered: the secret is write-only from the
  // renderer's point of view, so there is nothing to prefill and nothing to
  // read back.
  function buildCredentialRow(cfg) {
    const isToken = cfg.authMode === "token";
    if (view.credDraft === null) view.credDraft = "";
    return buildInputRow(cfg, {
      type: "password",
      label: isToken ? t("remoteOpenclawTokenLabel") : t("remoteOpenclawPasswordLabel"),
      desc: view.credentialConfigured
        ? t("remoteOpenclawCredentialSaved")
        : t("remoteOpenclawCredentialDesc"),
      placeholder: view.credentialConfigured ? t("remoteOpenclawCredentialSaved") : "",
      value: view.credDraft,
      pending: view.credentialPending,
      onDraft: (v) => {
        view.credDraft = v;
      },
      onSave: (v) => saveCredential(v),
    });
  }

  function buildFilterRow(cfg) {
    if (view.filterDraft === null) view.filterDraft = cfg.agentFilter;
    return buildInputRow(cfg, {
      label: t("remoteOpenclawFilterLabel"),
      desc: t("remoteOpenclawFilterDesc"),
      placeholder: "",
      value: view.filterDraft,
      onDraft: (v) => {
        view.filterDraft = v;
      },
      onSave: (v) => saveConfig({ ...cfg, agentFilter: String(v || "").trim() }),
    });
  }

  function buildStatusNote() {
    const note = document.createElement("p");
    note.className = "subtitle";
    if (view.status && view.status.phase) {
      const detail = view.status.detail ? ` — ${view.status.detail}` : "";
      note.textContent = `${t("remoteOpenclawStatusLabel")}: ${view.status.phase}${detail}`;
    } else {
      note.textContent = t("remoteOpenclawStatusIdle");
    }
    return note;
  }

  // A password/token connection is granted `role: operator` with an empty
  // scope list, which means the gateway withholds every `session.*` broadcast.
  // The pet still tracks the gateway from its `health` snapshots, but that is
  // coarser than the event stream — worth saying out loud rather than leaving
  // the user to wonder why the pet only reacts every minute or so.
  function buildScopeNote() {
    const status = view.status;
    if (!status || status.phase !== "connected") return null;
    const scopes = Array.isArray(status.scopes) ? status.scopes : [];
    if (scopes.indexOf("operator.read") !== -1) return null;
    const note = document.createElement("p");
    note.className = "subtitle";
    note.textContent = t("remoteOpenclawReadOnlyNote");
    return note;
  }

  function render(parent) {
    ensureStatusListener();
    ensureCredentialStatus();
    const cfg = currentConfig();

    const h1 = document.createElement("h1");
    h1.textContent = t("remoteOpenclawTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("remoteOpenclawSubtitle");
    parent.appendChild(subtitle);

    parent.appendChild(helpers.buildSection(t("remoteOpenclawConnectionTitle"), [
      buildEnabledRow(cfg),
      buildUrlRow(cfg),
      buildAuthModeRow(cfg),
      buildCredentialRow(cfg),
    ]));

    parent.appendChild(helpers.buildSection(t("remoteOpenclawFilterTitle"), [
      buildFilterRow(cfg),
    ]));

    parent.appendChild(buildStatusNote());
    const scopeNote = buildScopeNote();
    if (scopeNote) parent.appendChild(scopeNote);
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs["remote-openclaw"] = { render };
  }

  root.ClawdSettingsTabRemoteOpenclaw = { init };
})(globalThis);
