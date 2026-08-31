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
  // the slice belonging to its profile. The per-profile in-flight Sets keep
  // destructive/action buttons disabled across status/progress rerenders.
  const view = {
    selectedProfileId: null,
    editing: null,        // profile snapshot for edit form, or null
    runtimeStatuses: new Map(), // profileId → status snapshot
    statusEventGeneration: 0,
    statusEventGenerationByProfile: new Map(),
    progressLog: new Map(),     // profileId → Array<event>
    listenerInstalled: false,
    deployingProfileIds: new Set(),
    deletingProfileIds: new Set(),
    bindingSecurity: null,
    profileIsolationAvailable: false,
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
          view.statusEventGeneration += 1;
          view.statusEventGenerationByProfile.set(s.profileId, view.statusEventGeneration);
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
      const requestGeneration = view.statusEventGeneration;
      window.remoteSsh.listStatuses().then((res) => {
        if (res && res.status === "ok" && Array.isArray(res.statuses)) {
          for (const s of res.statuses) {
            // A push that arrived after this request began is newer than the
            // response snapshot. Never let the initial list re-enable a card
            // that a newer coordinator event has already marked busy.
            const pushedAt = view.statusEventGenerationByProfile.get(s.profileId) || 0;
            if (pushedAt <= requestGeneration) view.runtimeStatuses.set(s.profileId, s);
          }
          view.bindingSecurity = res.bindingSecurity || null;
          view.profileIsolationAvailable = res.profileIsolationAvailable === true;
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

  function hasDeploymentStamp(profile) {
    return Number.isFinite(profile && profile.lastDeployedAt) && profile.lastDeployedAt > 0;
  }

  function requestProfileConnect(profile) {
    if (!hasDeploymentStamp(profile)) {
      view.selectedProfileId = profile.id;
      ops.showToast(t("remoteSshErrDeploymentRequired"), { error: true });
      ops.requestRender({ content: true });
      return;
    }
    if (!window.remoteSsh || typeof window.remoteSsh.connect !== "function") return;
    Promise.resolve(window.remoteSsh.connect(profile.id)).then((result) => {
      if (!result || result.status === "ok") return;
      if (result.reason === "deployment_required") {
        view.runtimeStatuses.set(profile.id, {
          profileId: profile.id,
          status: "failed",
          message: result.message || null,
          hint: result.hint || "remoteSshErrDeploymentRequired",
          lastErrorReason: result.reason,
        });
        view.selectedProfileId = profile.id;
        const hintText = t(result.hint || "remoteSshErrDeploymentRequired");
        ops.showToast(hintText, { error: true });
        ops.requestRender({ content: true });
        return;
      }
      ops.showToast(result.message || t("remoteSshStatus_failed"), { error: true });
    }).catch((err) => {
      ops.showToast((err && err.message) || t("remoteSshStatus_failed"), { error: true });
    });
  }

  function requestProfileDisconnect(profileId) {
    if (!window.remoteSsh || typeof window.remoteSsh.disconnect !== "function") return;
    Promise.resolve(window.remoteSsh.disconnect(profileId)).then((result) => {
      if (result && result.state && typeof result.state.profileId === "string") {
        view.runtimeStatuses.set(result.state.profileId, result.state);
      }
      if (result && result.status !== "ok") {
        ops.showToast(result.message || t("remoteSshStatus_failed"), { error: true });
      }
      ops.requestRender({ content: true });
    }).catch((err) => {
      ops.showToast((err && err.message) || t("remoteSshStatus_failed"), { error: true });
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

    if (view.bindingSecurity && view.bindingSecurity.strongStorage !== true) {
      const bindingWarning = document.createElement("p");
      bindingWarning.className = "subtitle remote-ssh-warning";
      bindingWarning.textContent = t("remoteSshWeakBindingWarning")
        .replace("{backend}", view.bindingSecurity.storageBackend || "unknown");
      parent.appendChild(bindingWarning);
    }

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

    const addBtn = helpers.buildButton({
      labelKey: "remoteSshAddProfile",
      tone: "accent",
      size: "compact",
    });
    addBtn.addEventListener("click", () => {
      view.editing = {
        id: uuid(),
        label: "",
        host: "",
        port: 22,
        identityFile: "",
        sshTransportMode: "auto",
        remoteForwardPort: 23333,
        hostPrefix: "",
        autoStartCodexMonitor: false,
        chainStatusline: false,
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

    // Surface "hooks never deployed" and keep Connect disabled. Connect never
    // performs deployment, so an edited target must go through the explicit
    // Deploy / Repair Hooks flow before it can create a tunnel.
    if (!hasDeploymentStamp(profile)) {
      const warn = document.createElement("span");
      warn.className = "remote-ssh-deploy-warn";
      warn.textContent = "⚠";
      warn.title = t("remoteSshConnectWarnNoDeploy");
      actions.appendChild(warn);
    }

    const transportOperationActive = !!(
      status.transportPhase && status.transportPhase !== "idle"
    );
    const disconnectAvailable = status.status === "connected"
      || status.status === "connecting"
      || status.status === "reconnecting"
      || (transportOperationActive && status.transportDesiredConnected === true);
    const deploymentReady = hasDeploymentStamp(profile);
    const connectBtn = helpers.buildButton({
      labelKey: disconnectAvailable ? "remoteSshDisconnect" : "remoteSshConnect",
      size: "compact",
      disabled: !disconnectAvailable && (!deploymentReady || transportOperationActive),
    });
    if (disconnectAvailable) {
      connectBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        requestProfileDisconnect(profile.id);
      });
    } else {
      if (!deploymentReady) {
        connectBtn.title = t("remoteSshErrDeploymentRequired");
      } else if (transportOperationActive) {
        connectBtn.title = statusMessageText(status);
      }
      connectBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        requestProfileConnect(profile);
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
    const status = statusForProfile(profile.id);
    const transportOwnedByAnother = !!(
      status.transportPhase
      && status.transportPhase !== "idle"
      && status.transportOwnerProfileId
      && status.transportOwnerProfileId !== profile.id
    );
    const transportConflictTitle = transportOwnedByAnother ? statusMessageText(status) : "";

    const header = document.createElement("div");
    header.className = "remote-ssh-section-header";
    const headTitle = document.createElement("h2");
    headTitle.textContent = profile.label;
    header.appendChild(headTitle);

    const editBtn = helpers.buildButton({
      labelKey: "remoteSshEdit",
      size: "compact",
      disabled: transportOwnedByAnother,
      title: transportConflictTitle,
    });
    editBtn.addEventListener("click", () => {
      if (transportOwnedByAnother) return;
      view.editing = { ...profile };
      ops.requestRender({ content: true });
    });
    header.appendChild(editBtn);

    const deleteBtn = helpers.buildButton({
      labelKey: "remoteSshDelete",
      tone: "danger",
      size: "compact",
      className: "remote-ssh-btn-danger",
      disabled: transportOwnedByAnother,
      pending: view.deletingProfileIds.has(profile.id),
      title: transportConflictTitle,
    });
    deleteBtn.addEventListener("click", async () => {
      if (view.deletingProfileIds.has(profile.id) || transportOwnedByAnother) return;
      if (!confirm(t("remoteSshDeleteConfirm").replace("{label}", profile.label))) return;
      view.deletingProfileIds.add(profile.id);
      try {
        ops.requestRender({ content: true });
        let cleanupSucceeded = true;
        if (window.remoteSsh) {
          if (typeof window.remoteSsh.cleanup === "function") {
            try {
              const cleanup = await window.remoteSsh.cleanup(profile.id);
              cleanupSucceeded = !!(cleanup && cleanup.status === "ok" && cleanup.uninstalled !== false);
            } catch {
              cleanupSucceeded = false;
            }
          } else {
            window.remoteSsh.disconnect(profile.id);
          }
        }
        if (!cleanupSucceeded && !confirm(t("remoteSshDeleteCleanupFailedConfirm"))) return;
        const r = await callCommand("remoteSsh.delete", profile.id);
        if (!r || r.status !== "ok") return;
        if (view.selectedProfileId === profile.id) view.selectedProfileId = null;
        // Drop deleted profile's view-state buckets so a future profile
        // reusing the id doesn't inherit stale logs / in-flight flags.
        view.progressLog.delete(profile.id);
        view.deployingProfileIds.delete(profile.id);
      } finally {
        // The original button may have been detached by a runtime status
        // update while cleanup awaited SSH. Keep the source of truth in view
        // state and rebuild so the currently-mounted button reflects it.
        view.deletingProfileIds.delete(profile.id);
        ops.requestRender({ content: true });
      }
    });
    header.appendChild(deleteBtn);

    section.appendChild(header);

    // Status row
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

    const runtimeRow = document.createElement("div");
    runtimeRow.className = "remote-ssh-hooks-row";
    const runtimeLabel = document.createElement("span");
    runtimeLabel.className = "remote-ssh-hooks-label";
    runtimeLabel.textContent = t("remoteSshRuntimeModeLabel");
    runtimeRow.appendChild(runtimeLabel);
    const isolated = profile.runtimeMode === "profile-isolated";
    const runtimeValue = document.createElement("span");
    runtimeValue.className = "remote-ssh-hooks-value";
    runtimeValue.textContent = isolated
      ? t(profile.isolatedActive ? "remoteSshIsolatedActive" : "remoteSshIsolatedPrepared")
      : t("remoteSshAccountDefault");
    runtimeRow.appendChild(runtimeValue);
    if (isolated || view.profileIsolationAvailable) {
      const modeButton = helpers.buildButton({
        labelKey: isolated ? "remoteSshDisableIsolation" : "remoteSshEnableIsolation",
        size: "compact",
        disabled: transportOwnedByAnother,
        title: transportConflictTitle,
      });
      modeButton.addEventListener("click", async () => {
        if (transportOwnedByAnother) return;
        if (!window.remoteSsh || typeof window.remoteSsh.setRuntimeMode !== "function") return;
        const prompt = t(isolated ? "remoteSshDisableIsolationConfirm" : "remoteSshEnableIsolationConfirm");
        if (!confirm(prompt)) return;
        helpers.setButtonState(modeButton, { pending: true });
        const target = isolated ? "account-default" : "profile-isolated";
        try {
          const result = await window.remoteSsh.setRuntimeMode(profile.id, target, true);
          if (!result || result.status !== "ok") {
            ops.showToast((result && result.message) || "runtime mode switch failed", { error: true, ttl: 10000 });
          } else {
            ops.showToast(t("remoteSshRuntimeModeChanged"));
          }
        } catch (err) {
          ops.showToast((err && err.message) || "runtime mode switch failed", { error: true });
        } finally {
          ops.requestRender({ content: true });
        }
      });
      runtimeRow.appendChild(modeButton);
    }
    section.appendChild(runtimeRow);

    if (isolated) {
      const boundary = document.createElement("div");
      boundary.className = "remote-ssh-field-hint";
      boundary.textContent = t("remoteSshIsolationBoundary");
      section.appendChild(boundary);
      const isolatedRuntime = profile.isolatedRuntime;
      if (isolatedRuntime && isolatedRuntime.runtimeRoot) {
        const root = document.createElement("div");
        root.className = "remote-ssh-field-hint";
        root.textContent = `${t("remoteSshRuntimeRoot")}: ${isolatedRuntime.runtimeRoot}`;
        section.appendChild(root);
        const wrappers = document.createElement("div");
        wrappers.className = "remote-ssh-actions";
        for (const name of ["claude", "codex", "copilot"]) {
          const capability = isolatedRuntime.capabilities && isolatedRuntime.capabilities[name];
          if (!capability || !capability.present || !capability.wrapperPath) continue;
          const copy = helpers.buildButton({
            label: t("remoteSshCopyWrapper").replace("{name}", name),
            size: "compact",
          });
          copy.addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(capability.wrapperPath);
              ops.showToast(t("remoteSshWrapperCopied"));
            } catch (err) {
              ops.showToast((err && err.message) || "copy failed", { error: true });
            }
          });
          wrappers.appendChild(copy);
        }
        section.appendChild(wrappers);
      }
    }

    if ((profile.identityTxn && profile.identityTxn.phase !== "committed")
      || typeof profile.previousNonce === "string") {
      const revokeActions = document.createElement("div");
      revokeActions.className = "remote-ssh-actions";
      const addRevokeButton = (mode, labelKey, firstConfirmKey) => {
        const button = helpers.buildButton({
          labelKey,
          tone: "danger",
          size: "compact",
          className: "remote-ssh-btn-danger",
          disabled: transportOwnedByAnother,
          title: transportConflictTitle,
        });
        button.addEventListener("click", async () => {
          if (transportOwnedByAnother) return;
          if (!window.remoteSsh || typeof window.remoteSsh.forceRevoke !== "function") return;
          if (!confirm(t(firstConfirmKey))) return;
          if (!confirm(t("remoteSshForceRevokeSecondConfirm"))) return;
          helpers.setButtonState(button, { pending: true });
          try {
            const result = await window.remoteSsh.forceRevoke(profile.id, mode, true);
            if (!result || result.status !== "ok") {
              ops.showToast((result && result.message) || "identity revocation failed", { error: true, ttl: 10000 });
            } else {
              ops.showToast(t("remoteSshForceRevokeSuccess"));
            }
          } catch (err) {
            ops.showToast((err && err.message) || "identity revocation failed", { error: true });
          } finally {
            ops.requestRender({ content: true });
          }
        });
        revokeActions.appendChild(button);
      };
      addRevokeButton("old", "remoteSshForceRevokeOld", "remoteSshForceRevokeOldConfirm");
      addRevokeButton("all", "remoteSshForceRevokeAll", "remoteSshForceRevokeAllConfirm");
      section.appendChild(revokeActions);
    }

    // Action buttons
    const actions = document.createElement("div");
    actions.className = "remote-ssh-actions";
    const authBtn = helpers.buildButton({
      labelKey: "remoteSshAuthenticate",
      disabled: transportOwnedByAnother,
      title: transportConflictTitle || t("remoteSshAuthenticateHint"),
    });
    authBtn.addEventListener("click", () => {
      if (transportOwnedByAnother) return;
      if (!window.remoteSsh) return;
      window.remoteSsh.authenticate(profile.id).then((r) => {
        if (r && r.status !== "ok") ops.showToast((r && r.message) || "authenticate failed", { error: true });
      });
    });
    actions.appendChild(authBtn);

    const termBtn = helpers.buildButton({
      labelKey: "remoteSshOpenTerminal",
      disabled: transportOwnedByAnother,
      title: transportConflictTitle,
    });
    termBtn.addEventListener("click", () => {
      if (transportOwnedByAnother) return;
      if (!window.remoteSsh) return;
      window.remoteSsh.openTerminal(profile.id).then((r) => {
        if (r && r.status !== "ok") ops.showToast((r && r.message) || "open terminal failed", { error: true });
      });
    });
    actions.appendChild(termBtn);

    const isDeploying = view.deployingProfileIds.has(profile.id);
    const deployBtn = helpers.buildButton({
      labelKey: isDeploying ? "remoteSshDeploying" : "remoteSshDeploy",
      tone: "accent",
      disabled: transportOwnedByAnother,
      pending: isDeploying,
      title: transportConflictTitle,
    });
    deployBtn.addEventListener("click", () => {
      if (!window.remoteSsh || transportOwnedByAnother) return;
      view.deployingProfileIds.add(profile.id);
      // Clear ONLY this profile's log; other profiles mid-deploy keep theirs.
      view.progressLog.set(profile.id, []);
      ops.requestRender({ content: true });
      const runDeploy = (options) => window.remoteSsh.deploy(profile.id, options);
      runDeploy()
        .then((r) => {
          if (r
            && r.status !== "ok"
            && r.reason === "legacy_deployment_confirmation_required"
            && window.confirm(t("remoteSshLegacyMigrationConfirm"))) {
            return runDeploy({ legacyMigrationConfirmed: true });
          }
          return r;
        })
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
            } else {
              // Append codex /hooks reminder — Deploy installs the hooks but the
              // user still has to review them once in codex TUI before they go
              // live (sha256 trusted_hash gate in ~/.codex/config.toml).
              ops.showToast(`${t("remoteSshDeploySuccess")} ${t("codexHookReviewReminder")}`,
                { ttl: 8000 });
            }
          } else {
            // Same hint preference as the progress log line — `remote-shell`
            // failure surfaces the Windows-cmd guidance in zh.
            let toastMsg = null;
            if (r && r.hint) {
              const hintText = t(r.hint);
              if (hintText && hintText !== r.hint) toastMsg = hintText;
            }
            if (!toastMsg) toastMsg = (r && r.message) || "deploy failed";
            ops.showToast(toastMsg, { error: true, ttl: 10000 });
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
        // Prefer a localized hint over the raw English message — `remote-shell`
        // failures carry hint:"remoteSshErrWindowsCmdShell" so zh users see
        // actionable Chinese guidance instead of an English one-liner.
        let detail = "";
        if (ev.hint) {
          const hintText = t(ev.hint);
          if (hintText && hintText !== ev.hint) detail = hintText;
        }
        if (!detail && ev.message) detail = ev.message;
        line.textContent = `[${ev.status}] ${stepLabel}` + (detail ? ` — ${detail}` : "");
        if (ev.message && detail !== ev.message) line.title = ev.message;
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

    function selectField(labelKey, key, options, attrs = {}) {
      const wrap = document.createElement("div");
      wrap.className = "remote-ssh-field";
      const label = document.createElement("label");
      label.className = "remote-ssh-field-label";
      label.textContent = t(labelKey);
      const picker = helpers.buildSettingsSelect({
        value: String(formData[key]),
        options: options.map((option) => (option && typeof option === "object"
          ? { value: String(option.value), label: String(option.label) }
          : { value: String(option), label: String(option) })),
        ariaLabel: t(labelKey),
        className: attrs.className !== undefined ? attrs.className : "remote-ssh-port-select",
        disabled: attrs.disabled === true,
        onChange(value) {
          const parsed = parseInt(value, 10);
          formData[key] = Number.isFinite(parsed) ? parsed : value;
          return true;
        },
      });
      wrap.appendChild(label);
      wrap.appendChild(picker.element);
      if (attrs.hint) {
        const hint = document.createElement("div");
        hint.className = "remote-ssh-field-hint";
        hint.textContent = attrs.hint;
        wrap.appendChild(hint);
      }
      return wrap;
    }

    function optionCard(labelKey, descKey, key) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "remote-ssh-option-card";

      const text = document.createElement("span");
      text.className = "remote-ssh-option-card-text";
      const label = document.createElement("span");
      label.className = "remote-ssh-option-card-label";
      label.id = `settings-remote-ssh-${key}-label`;
      label.textContent = t(labelKey);
      const desc = document.createElement("span");
      desc.className = "remote-ssh-option-card-desc";
      desc.id = `settings-remote-ssh-${key}-description`;
      desc.textContent = t(descKey);
      text.appendChild(label);
      text.appendChild(desc);

      const sw = document.createElement("span");
      sw.setAttribute("aria-hidden", "true");
      const switchControl = helpers.buildSwitch({
        element: button,
        visualElement: sw,
        checked: !!formData[key],
        ariaLabelledBy: label.id,
        ariaDescribedBy: desc.id,
        className: "remote-ssh-option-card-switch",
        onToggle: ({ nextChecked }) => {
          formData[key] = nextChecked;
          switchControl.setState({ checked: nextChecked });
        },
      });
      button.appendChild(text);
      button.appendChild(sw);
      return button;
    }

    section.appendChild(input("remoteSshFieldLabel", "label", { placeholder: "My Raspberry Pi" }));
    section.appendChild(input("remoteSshFieldHost", "host", { placeholder: "user@host.example.com" }));
    section.appendChild(input("remoteSshFieldPort", "port", { type: "number", placeholder: "22" }));
    section.appendChild(input("remoteSshFieldIdentityFile", "identityFile", {
      placeholder: "/home/me/.ssh/id_rsa",
      hint: t("remoteSshFieldIdentityFileHint"),
    }));
    const editedStatus = statusForProfile(formData.id);
    const transportModeBusy = editedStatus.status === "connecting"
      || editedStatus.status === "connected"
      || editedStatus.status === "reconnecting"
      || (editedStatus.transportPhase && editedStatus.transportPhase !== "idle");
    if (!formData.sshTransportMode) formData.sshTransportMode = "auto";
    section.appendChild(selectField(
      "remoteSshFieldTransportMode",
      "sshTransportMode",
      [
        { value: "auto", label: t("remoteSshTransportModeAuto") },
        { value: "serialized", label: t("remoteSshTransportModeSerialized") },
      ],
      {
        hint: t(transportModeBusy
          ? "remoteSshTransportModeDisconnectHint"
          : "remoteSshTransportModeHint"),
        disabled: transportModeBusy,
        className: "",
      }
    ));
    section.appendChild(selectField(
      "remoteSshFieldRemoteForwardPort",
      "remoteForwardPort",
      REMOTE_FORWARD_PORTS,
      { hint: t("remoteSshFieldRemoteForwardPortHint") }
    ));
    section.appendChild(input("remoteSshFieldHostPrefix", "hostPrefix", {
      placeholder: "raspberrypi",
      hint: t("remoteSshFieldHostPrefixHint"),
    }));
    const optionCards = document.createElement("div");
    optionCards.className = "remote-ssh-option-cards";
    optionCards.appendChild(optionCard(
      "remoteSshFieldAutoStartCodex",
      "remoteSshFieldAutoStartCodexDesc",
      "autoStartCodexMonitor"
    ));
    optionCards.appendChild(optionCard(
      "remoteSshFieldChainStatusline",
      "remoteSshFieldChainStatuslineDesc",
      "chainStatusline"
    ));
    optionCards.appendChild(optionCard(
      "remoteSshFieldConnectOnLaunch",
      "remoteSshFieldConnectOnLaunchDesc",
      "connectOnLaunch"
    ));
    section.appendChild(optionCards);

    // Submit / cancel
    const formActions = document.createElement("div");
    formActions.className = "remote-ssh-form-actions";

    const cancelBtn = helpers.buildButton({
      labelKey: "remoteSshCancel",
    });
    cancelBtn.addEventListener("click", () => {
      view.editing = null;
      ops.requestRender({ content: true });
    });
    formActions.appendChild(cancelBtn);

    const saveBtn = helpers.buildButton({
      labelKey: "remoteSshSave",
      tone: "accent",
    });
    saveBtn.addEventListener("click", () => {
      // Strip empty optional strings before submitting.
      const payload = {
        id: formData.id,
        label: (formData.label || "").trim(),
        host: (formData.host || "").trim(),
        remoteForwardPort: formData.remoteForwardPort,
        sshTransportMode: formData.sshTransportMode === "serialized" ? "serialized" : "auto",
        autoStartCodexMonitor: !!formData.autoStartCodexMonitor,
        chainStatusline: !!formData.chainStatusline,
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
