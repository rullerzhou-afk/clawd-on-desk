"use strict";

// Remote SSH tab — Phase 2 plan-remote-ssh-one-click
//
// UI surfaces:
//   - profile list (each card shows label / host / status + Connect/Disconnect)
//   - "+ Add profile" button → edit form
//   - selected profile detail panel: Connect / Disconnect / Authenticate /
//     Open Terminal / Deploy buttons + status / progress log
//
// All profile CRUD goes through window.settingsAPI.command using the
// remoteSsh.add / .update / .delete actions registered on settings-actions.js.
// Runtime ops (Connect / Disconnect / Deploy / Authenticate / Open Terminal)
// go through window.remoteSsh.* invokes wired in remote-ssh-ipc.js.

(function initSettingsTabRemoteSsh(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  // Local view state (tab-scoped — not persisted in core.state).
  //
  // progressLog is a Map<profileId, Array<event>> so concurrent deploys on
  // multiple profiles each get their own log; the detail panel renders only
  // the slice belonging to its profile. deployingProfileIds is a Set so the
  // Deploy button on each card knows independently whether THAT profile is
  // mid-deploy (one profile finishing must not unblock another's button).
  const view = {
    selectedProfileId: null,
    editing: null,        // profile snapshot for edit form, or null
    runtimeStatuses: new Map(), // profileId → status snapshot
    progressLog: new Map(),     // profileId → Array<event>
    listenerInstalled: false,
    deployingProfileIds: new Set(),
  };

  const PROGRESS_LOG_MAX = 50;
  const REMOTE_FORWARD_PORTS = [23333, 23334, 23335, 23336, 23337];

  function t(key) {
    return helpers.t(key);
  }

  function listProfiles() {
    const snap = state.snapshot || {};
    const remoteSsh = snap.remoteSsh || {};
    return Array.isArray(remoteSsh.profiles) ? remoteSsh.profiles : [];
  }

  function findProfile(id) {
    return listProfiles().find((p) => p.id === id) || null;
  }

  function uuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    }
    return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function ensureRuntimeListeners() {
    if (view.listenerInstalled) return;
    if (!window.remoteSsh) return;
    view.listenerInstalled = true;
    if (typeof window.remoteSsh.onStatusChanged === "function") {
      window.remoteSsh.onStatusChanged((s) => {
        if (s && typeof s.profileId === "string") {
          view.runtimeStatuses.set(s.profileId, s);
        }
        if (state.activeTab === "remote-ssh") ops.requestRender({ content: true });
      });
    }
    if (typeof window.remoteSsh.onProgress === "function") {
      window.remoteSsh.onProgress((p) => {
        if (!p || typeof p.profileId !== "string") return;
        let log = view.progressLog.get(p.profileId);
        if (!log) {
          log = [];
          view.progressLog.set(p.profileId, log);
        }
        log.push({ ...p, ts: Date.now() });
        if (log.length > PROGRESS_LOG_MAX) {
          log.splice(0, log.length - PROGRESS_LOG_MAX);
        }
        if (state.activeTab === "remote-ssh") ops.requestRender({ content: true });
      });
    }
    // Initial fetch of statuses so first render isn't blank.
    if (typeof window.remoteSsh.listStatuses === "function") {
      window.remoteSsh.listStatuses().then((res) => {
        if (res && res.status === "ok" && Array.isArray(res.statuses)) {
          for (const s of res.statuses) view.runtimeStatuses.set(s.profileId, s);
          if (state.activeTab === "remote-ssh") ops.requestRender({ content: true });
        }
      }).catch(() => {});
    }
  }

  function statusForProfile(id) {
    const s = view.runtimeStatuses.get(id);
    return s || { profileId: id, status: "idle" };
  }

  function statusBadgeClass(status) {
    switch (status) {
      case "connected": return "remote-ssh-status-connected";
      case "connecting":
      case "reconnecting": return "remote-ssh-status-connecting";
      case "failed": return "remote-ssh-status-failed";
      default: return "remote-ssh-status-idle";
    }
  }

  function statusLabel(status) {
    return t("remoteSshStatus_" + status) || status;
  }

  function statusMessageText(status) {
    if (!status) return "";
    if (status.hint) {
      const translated = t(status.hint);
      if (translated && translated !== status.hint) return translated;
    }
    return status.message || "";
  }

  function formatTimeAgo(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return null;
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return t("remoteSshHooksDeployedJustNow");
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return t("remoteSshHooksDeployedJustNow");
    const min = Math.floor(sec / 60);
    if (min < 60) return t("remoteSshHooksDeployedAgoMin").replace("{n}", String(min));
    const hr = Math.floor(min / 60);
    if (hr < 24) return t("remoteSshHooksDeployedAgoHr").replace("{n}", String(hr));
    const day = Math.floor(hr / 24);
    return t("remoteSshHooksDeployedAgoDay").replace("{n}", String(day));
  }

  function callCommand(action, payload) {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return Promise.resolve({ status: "error" });
    }
    return window.settingsAPI.command(action, payload).then((result) => {
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || (t("toastSaveFailed") + "unknown error"), { error: true });
      }
      return result;
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      return { status: "error", message: err && err.message };
    });
  }

  // ── Render ──

  function render(parent) {
    ensureRuntimeListeners();

    const h1 = document.createElement("h1");
    h1.textContent = t("remoteSshTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("remoteSshSubtitle");
    parent.appendChild(subtitle);

    if (view.editing) {
      renderEditForm(parent);
      return;
    }

    parent.appendChild(renderProfilesList());

    if (view.selectedProfileId) {
      const p = findProfile(view.selectedProfileId);
      if (p) parent.appendChild(renderProfileDetail(p));
    }
  }

  function renderProfilesList() {
    const section = document.createElement("section");
    section.className = "section remote-ssh-list";

    const header = document.createElement("div");
    header.className = "remote-ssh-section-header";
    const headTitle = document.createElement("h2");
    headTitle.textContent = t("remoteSshSectionProfiles");
    header.appendChild(headTitle);

    const addBtn = document.createElement("button");
    addBtn.className = "soft-btn accent";
    addBtn.textContent = t("remoteSshAddProfile");
    addBtn.addEventListener("click", () => {
      view.editing = {
        id: uuid(),
        label: "",
        host: "",
        port: 22,
        identityFile: "",
        remoteForwardPort: 23333,
        hostPrefix: "",
        autoStartCodexMonitor: false,
        connectOnLaunch: false,
        _isNew: true,
      };
      ops.requestRender({ content: true });
    });
    header.appendChild(addBtn);
    section.appendChild(header);

    const profiles = listProfiles();
    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "remote-ssh-empty";
      empty.textContent = t("remoteSshEmpty");
      section.appendChild(empty);
      return section;
    }

    for (const p of profiles) {
      section.appendChild(renderProfileCard(p));
    }
    return section;
  }

  function renderProfileCard(profile) {
    const card = document.createElement("div");
    card.className = "remote-ssh-card";
    if (view.selectedProfileId === profile.id) card.classList.add("selected");

    const meta = document.createElement("div");
    meta.className = "remote-ssh-card-meta";
    const label = document.createElement("div");
    label.className = "remote-ssh-card-label";
    label.textContent = profile.label;
    const hostRow = document.createElement("div");
    hostRow.className = "remote-ssh-card-host";
    hostRow.textContent = profile.host + (profile.port && profile.port !== 22 ? `:${profile.port}` : "");
    meta.appendChild(label);
    meta.appendChild(hostRow);

    const status = statusForProfile(profile.id);
    const badge = document.createElement("span");
    badge.className = "remote-ssh-status-badge " + statusBadgeClass(status.status);
    badge.textContent = statusLabel(status.status);

    const actions = document.createElement("div");
    actions.className = "remote-ssh-card-actions";
    actions.appendChild(badge);

    // Surface "hooks never deployed" before the user clicks Connect — Connect
    // alone only builds the reverse tunnel, it does not push hook files. A
    // tunnel with no hooks shows green "connected" but the desktop pet
    // never reacts because remote codex/claude has no hook config.
    if (!Number.isFinite(profile.lastDeployedAt)) {
      const warn = document.createElement("span");
      warn.className = "remote-ssh-deploy-warn";
      warn.textContent = "⚠";
      warn.title = t("remoteSshConnectWarnNoDeploy");
      actions.appendChild(warn);
    }

    const connectBtn = document.createElement("button");
    connectBtn.className = "soft-btn";
    if (status.status === "connected" || status.status === "connecting" || status.status === "reconnecting") {
      connectBtn.textContent = t("remoteSshDisconnect");
      connectBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (window.remoteSsh) window.remoteSsh.disconnect(profile.id);
      });
    } else {
      connectBtn.textContent = t("remoteSshConnect");
      connectBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (window.remoteSsh) window.remoteSsh.connect(profile.id);
      });
    }
    actions.appendChild(connectBtn);

    card.appendChild(meta);
    card.appendChild(actions);
    card.addEventListener("click", () => {
      view.selectedProfileId = view.selectedProfileId === profile.id ? null : profile.id;
      ops.requestRender({ content: true });
    });
    return card;
  }

  function renderProfileDetail(profile) {
    const section = document.createElement("section");
    section.className = "section remote-ssh-detail";

    const header = document.createElement("div");
    header.className = "remote-ssh-section-header";
    const headTitle = document.createElement("h2");
    headTitle.textContent = profile.label;
    header.appendChild(headTitle);

    const editBtn = document.createElement("button");
    editBtn.className = "soft-btn";
    editBtn.textContent = t("remoteSshEdit");
    editBtn.addEventListener("click", () => {
      view.editing = { ...profile };
      ops.requestRender({ content: true });
    });
    header.appendChild(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "soft-btn remote-ssh-btn-danger";
    deleteBtn.textContent = t("remoteSshDelete");
    deleteBtn.addEventListener("click", () => {
      if (!confirm(t("remoteSshDeleteConfirm").replace("{label}", profile.label))) return;
      if (window.remoteSsh) {
        window.remoteSsh.disconnect(profile.id);
      }
      callCommand("remoteSsh.delete", profile.id).then((r) => {
        if (r && r.status === "ok") {
          if (view.selectedProfileId === profile.id) view.selectedProfileId = null;
          // Drop deleted profile's view-state buckets so a future profile
          // reusing the id doesn't inherit stale logs / deploying flag.
          view.progressLog.delete(profile.id);
          view.deployingProfileIds.delete(profile.id);
          ops.requestRender({ content: true });
        }
      });
    });
    header.appendChild(deleteBtn);

    section.appendChild(header);

    // Status row
    const status = statusForProfile(profile.id);
    const statusRow = document.createElement("div");
    statusRow.className = "remote-ssh-status-row";
    const statusBadge = document.createElement("span");
    statusBadge.className = "remote-ssh-status-badge " + statusBadgeClass(status.status);
    statusBadge.textContent = statusLabel(status.status);
    statusRow.appendChild(statusBadge);
    const messageText = statusMessageText(status);
    if (messageText) {
      const msg = document.createElement("span");
      msg.className = "remote-ssh-status-message";
      msg.textContent = messageText;
      if (status.message && status.message !== messageText) {
        msg.title = status.message;
      }
      statusRow.appendChild(msg);
    }
    section.appendChild(statusRow);

    // Hooks deployment row — independent of tunnel status. Connect alone does
    // not push hooks; users need to see clearly whether hooks ever made it
    // to the remote, otherwise a green "connected" looks like everything's
    // fine while the desktop pet stays silent.
    const hooksRow = document.createElement("div");
    hooksRow.className = "remote-ssh-hooks-row";
    const hooksLabel = document.createElement("span");
    hooksLabel.className = "remote-ssh-hooks-label";
    hooksLabel.textContent = t("remoteSshHooksLabel");
    hooksRow.appendChild(hooksLabel);
    const hooksValue = document.createElement("span");
    if (Number.isFinite(profile.lastDeployedAt) && profile.lastDeployedAt > 0) {
      hooksValue.className = "remote-ssh-hooks-value remote-ssh-hooks-deployed";
      hooksValue.textContent = formatTimeAgo(profile.lastDeployedAt) || "";
      hooksValue.title = new Date(profile.lastDeployedAt).toLocaleString();
    } else {
      hooksValue.className = "remote-ssh-hooks-value remote-ssh-hooks-never";
      hooksValue.textContent = "⚠ " + t("remoteSshHooksNever");
      hooksValue.title = t("remoteSshConnectWarnNoDeploy");
    }
    hooksRow.appendChild(hooksValue);
    section.appendChild(hooksRow);

    // Action buttons
    const actions = document.createElement("div");
    actions.className = "remote-ssh-actions";
    const authBtn = document.createElement("button");
    authBtn.className = "soft-btn";
    authBtn.textContent = t("remoteSshAuthenticate");
    authBtn.title = t("remoteSshAuthenticateHint");
    authBtn.addEventListener("click", () => {
      if (!window.remoteSsh) return;
      window.remoteSsh.authenticate(profile.id).then((r) => {
        if (r && r.status !== "ok") ops.showToast((r && r.message) || "authenticate failed", { error: true });
      });
    });
    actions.appendChild(authBtn);

    const termBtn = document.createElement("button");
    termBtn.className = "soft-btn";
    termBtn.textContent = t("remoteSshOpenTerminal");
    termBtn.addEventListener("click", () => {
      if (!window.remoteSsh) return;
      window.remoteSsh.openTerminal(profile.id).then((r) => {
        if (r && r.status !== "ok") ops.showToast((r && r.message) || "open terminal failed", { error: true });
      });
    });
    actions.appendChild(termBtn);

    const deployBtn = document.createElement("button");
    deployBtn.className = "soft-btn accent";
    const isDeploying = view.deployingProfileIds.has(profile.id);
    deployBtn.textContent = isDeploying ? t("remoteSshDeploying") : t("remoteSshDeploy");
    deployBtn.disabled = isDeploying;
    deployBtn.addEventListener("click", () => {
      if (!window.remoteSsh) return;
      view.deployingProfileIds.add(profile.id);
      // Clear ONLY this profile's log; other profiles mid-deploy keep theirs.
      view.progressLog.set(profile.id, []);
      ops.requestRender({ content: true });
      window.remoteSsh.deploy(profile.id)
        .then((r) => {
          if (r && r.status === "ok") {
            if (r.warning === "target_drift") {
              // The user edited host/port/identityFile/remoteForwardPort/
              // hostPrefix while the 30s deploy was running. The deploy ran
              // against the OLD target — markDeployed refused to stamp the
              // new (drifted) profile as deployed. Tell the user to redeploy.
              const driftedField = r.driftedField || "target";
              ops.showToast(
                `${t("remoteSshDeployDriftWarning")} (${driftedField})`,
                { ttl: 10000, error: true }
              );
            } else if (r.warning === "stamp_failed") {
              // Deploy itself ran but lastDeployedAt couldn't be persisted
              // (validator/persist error). Show as error so the user knows
              // the "deployed" timestamp on the card is stale.
              ops.showToast(
                `${t("remoteSshDeploySuccess")} (${r.message || "stamp failed"})`,
                { ttl: 10000, error: true }
              );
            } else {
              // Append codex /hooks reminder — Deploy installs the hooks but the
              // user still has to review them once in codex TUI before they go
              // live (sha256 trusted_hash gate in ~/.codex/config.toml).
              ops.showToast(`${t("remoteSshDeploySuccess")} ${t("codexHookReviewReminder")}`,
                { ttl: 8000 });
            }
          } else {
            ops.showToast((r && r.message) || "deploy failed", { error: true });
          }
        })
        .catch((err) => {
          // IPC invoke can reject (channel not registered, main crashed, etc).
          // Without this catch the .finally cleanup still runs but the user
          // sees no feedback for the failure.
          ops.showToast((err && err.message) || "deploy IPC failed", { error: true });
        })
        .finally(() => {
          // Always clear the deploying flag — otherwise an unexpected reject
          // leaves the button stuck on "Deploying…" until a tab re-render.
          view.deployingProfileIds.delete(profile.id);
          ops.requestRender({ content: true });
        });
    });
    actions.appendChild(deployBtn);
    section.appendChild(actions);

    // Progress log slice for this profile (multi-profile concurrent deploys
    // each keep their own bucket; render only the current profile's events).
    const profileLog = view.progressLog.get(profile.id) || [];
    if (profileLog.length > 0) {
      const log = document.createElement("div");
      log.className = "remote-ssh-progress-log";
      for (const ev of profileLog) {
        const line = document.createElement("div");
        line.className = "remote-ssh-progress-line remote-ssh-progress-" + ev.status;
        const stepLabel = t("remoteSshStep_" + ev.step) || ev.step;
        line.textContent = `[${ev.status}] ${stepLabel}` + (ev.message ? ` — ${ev.message}` : "");
        log.appendChild(line);
      }
      section.appendChild(log);
    }

    return section;
  }

  function renderEditForm(parent) {
    const section = document.createElement("section");
    section.className = "section remote-ssh-edit";

    const isNew = view.editing._isNew === true;

    const headTitle = document.createElement("h2");
    headTitle.textContent = isNew ? t("remoteSshAddTitle") : t("remoteSshEditTitle");
    section.appendChild(headTitle);

    const formData = view.editing;

    function input(labelKey, key, attrs = {}) {
      const wrap = document.createElement("div");
      wrap.className = "remote-ssh-field";
      const label = document.createElement("label");
      label.className = "remote-ssh-field-label";
      label.textContent = t(labelKey);
      const inputEl = document.createElement("input");
      inputEl.type = attrs.type || "text";
      if (attrs.placeholder) inputEl.placeholder = attrs.placeholder;
      inputEl.value = formData[key] != null ? String(formData[key]) : "";
      inputEl.addEventListener("input", () => {
        if (attrs.type === "number") {
          const n = parseInt(inputEl.value, 10);
          formData[key] = Number.isFinite(n) ? n : null;
        } else {
          formData[key] = inputEl.value;
        }
      });
      wrap.appendChild(label);
      wrap.appendChild(inputEl);
      if (attrs.hint) {
        const hint = document.createElement("div");
        hint.className = "remote-ssh-field-hint";
        hint.textContent = attrs.hint;
        wrap.appendChild(hint);
      }
      return wrap;
    }

    function selectField(labelKey, key, options) {
      const wrap = document.createElement("div");
      wrap.className = "remote-ssh-field";
      const label = document.createElement("label");
      label.className = "remote-ssh-field-label";
      label.textContent = t(labelKey);
      const select = document.createElement("select");
      for (const opt of options) {
        const optEl = document.createElement("option");
        optEl.value = String(opt);
        optEl.textContent = String(opt);
        if (formData[key] === opt) optEl.selected = true;
        select.appendChild(optEl);
      }
      select.addEventListener("change", () => {
        const n = parseInt(select.value, 10);
        formData[key] = Number.isFinite(n) ? n : select.value;
      });
      wrap.appendChild(label);
      wrap.appendChild(select);
      return wrap;
    }

    function checkbox(labelKey, key) {
      const wrap = document.createElement("div");
      wrap.className = "remote-ssh-field remote-ssh-field-check";
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!formData[key];
      cb.addEventListener("change", () => { formData[key] = cb.checked; });
      label.appendChild(cb);
      const span = document.createElement("span");
      span.textContent = t(labelKey);
      label.appendChild(span);
      wrap.appendChild(label);
      return wrap;
    }

    section.appendChild(input("remoteSshFieldLabel", "label", { placeholder: "My Raspberry Pi" }));
    section.appendChild(input("remoteSshFieldHost", "host", { placeholder: "user@host.example.com" }));
    section.appendChild(input("remoteSshFieldPort", "port", { type: "number", placeholder: "22" }));
    section.appendChild(input("remoteSshFieldIdentityFile", "identityFile", {
      placeholder: "/home/me/.ssh/id_rsa",
      hint: t("remoteSshFieldIdentityFileHint"),
    }));
    section.appendChild(selectField("remoteSshFieldRemoteForwardPort", "remoteForwardPort", REMOTE_FORWARD_PORTS));
    section.appendChild(input("remoteSshFieldHostPrefix", "hostPrefix", {
      placeholder: "raspberrypi",
      hint: t("remoteSshFieldHostPrefixHint"),
    }));
    section.appendChild(checkbox("remoteSshFieldAutoStartCodex", "autoStartCodexMonitor"));

    // Submit / cancel
    const formActions = document.createElement("div");
    formActions.className = "remote-ssh-form-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "soft-btn";
    cancelBtn.textContent = t("remoteSshCancel");
    cancelBtn.addEventListener("click", () => {
      view.editing = null;
      ops.requestRender({ content: true });
    });
    formActions.appendChild(cancelBtn);

    const saveBtn = document.createElement("button");
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = t("remoteSshSave");
    saveBtn.addEventListener("click", () => {
      // Strip empty optional strings before submitting.
      const payload = {
        id: formData.id,
        label: (formData.label || "").trim(),
        host: (formData.host || "").trim(),
        remoteForwardPort: formData.remoteForwardPort,
        autoStartCodexMonitor: !!formData.autoStartCodexMonitor,
        connectOnLaunch: !!formData.connectOnLaunch,
        createdAt: formData.createdAt,
      };
      if (formData.port && formData.port !== 22) payload.port = formData.port;
      if (formData.identityFile && formData.identityFile.trim()) payload.identityFile = formData.identityFile.trim();
      if (formData.hostPrefix && formData.hostPrefix.trim()) payload.hostPrefix = formData.hostPrefix.trim();
      const action = isNew ? "remoteSsh.add" : "remoteSsh.update";
      callCommand(action, payload).then((r) => {
        if (r && r.status === "ok") {
          ops.showToast(t(isNew ? "remoteSshAddSuccess" : "remoteSshUpdateSuccess"));
          view.editing = null;
          if (isNew) view.selectedProfileId = payload.id;
          ops.requestRender({ content: true });
        }
      });
    });
    formActions.appendChild(saveBtn);

    section.appendChild(formActions);
    parent.appendChild(section);
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs["remote-ssh"] = { render };
  }

  root.ClawdSettingsTabRemoteSsh = { init };
})(globalThis);
