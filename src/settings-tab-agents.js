"use strict";

(function initSettingsTabAgents(root) {
  const {
    getAgentEventSourceBadgeKey,
    sortAgentMetadataForSettings,
  } = root.ClawdSettingsAgentOrder || {};
  let state = null;
  let runtime = null;
  let readers = null;
  let helpers = null;
  let ops = null;
  const CODEX_PERMISSION_MODE_OPTIONS = [
    { id: "native", labelKey: "codexPermissionModeNative" },
    { id: "intercept", labelKey: "codexPermissionModeIntercept" },
  ];
  const INSTALL_HINT_CONFIDENCES = new Set(["high", "medium"]);
  let agentHintActionPending = false;
  let agentInstallHintResetPending = false;
  let agentCleanupHintResetPending = false;
  let codexHookHealthRequestSeq = 0;

  function t(key) {
    return helpers.t(key);
  }

  function render(parent) {
    if (ops && typeof ops.fetchAgentInstallationHints === "function") {
      ops.fetchAgentInstallationHints();
    }
    resetMissingInstallDismissals();
    resetRestoredCleanupDismissals();

    const h1 = document.createElement("h1");
    h1.textContent = t("agentsTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("agentsSubtitle");
    parent.appendChild(subtitle);

    // Scan toolbar — always available on Windows (wslSupported) so a failed
    // auto scan still leaves the user a manual retry path.
    const hints = runtime.agentInstallationHints;
    const wslDistros = hints && Array.isArray(hints.wslDistros) ? hints.wslDistros : [];
    const wslPending = !!(hints && hints.wslPending);
    const wslSupported = !!(hints && hints.wslSupported);
    if (wslSupported || wslDistros.length > 0 || wslPending) {
      const toolbar = document.createElement("div");
      toolbar.className = "agent-scan-toolbar";

      const scanBtn = document.createElement("button");
      scanBtn.type = "button";
      scanBtn.className = "soft-btn agent-instance-scan-btn";
      scanBtn.textContent = t("agentInstanceScanWsl");
      scanBtn.title = t("agentInstanceScanWslDesc");
      scanBtn.addEventListener("click", async () => {
        scanBtn.disabled = true;
        scanBtn.textContent = t("agentInstanceScanning");
        try {
          if (ops && typeof ops.fetchAgentInstallationHints === "function") {
            await ops.fetchAgentInstallationHints({ refreshWsl: true });
          }
          ops.requestRender({ content: true });
        } catch (err) {
          console.warn("WSL scan failed:", err && err.message);
        } finally {
          scanBtn.disabled = false;
          scanBtn.textContent = t("agentInstanceScanWsl");
        }
      });
      toolbar.appendChild(scanBtn);

      if (wslPending) {
        const status = document.createElement("span");
        status.className = "agent-scan-status";
        status.textContent = t("agentInstanceScanning") + "...";
        toolbar.appendChild(status);
      }

      parent.appendChild(toolbar);
    }

    const recommendedHints = getRecommendedInstallHints();
    if (recommendedHints.length > 0) {
      parent.appendChild(buildAgentInstallHintBanner(recommendedHints));
    }
    const cleanupHints = getRecommendedCleanupHints();
    if (cleanupHints.length > 0) {
      parent.appendChild(buildAgentCleanupHintBanner(cleanupHints));
    }

    if (!runtime.agentMetadata || runtime.agentMetadata.length === 0) {
      const empty = document.createElement("div");
      empty.className = "placeholder";
      empty.innerHTML = `<div class="placeholder-desc">${helpers.escapeHtml(t("agentsEmpty"))}</div>`;
      parent.appendChild(empty);
      return;
    }

    const agents = typeof sortAgentMetadataForSettings === "function"
      ? sortAgentMetadataForSettings(runtime.agentMetadata)
      : runtime.agentMetadata;
    renderAgentSections(parent, agents);
  }

  function getAgentMetadata(agentId) {
    return (runtime.agentMetadata || []).find((agent) => agent && agent.id === agentId) || null;
  }

  function getAgentDisplayName(agentId) {
    const agent = getAgentMetadata(agentId);
    return (agent && (agent.name || agent.id)) || agentId;
  }

  function formatAgentNames(agentIds) {
    const names = agentIds.map(getAgentDisplayName);
    if (typeof Intl !== "undefined" && typeof Intl.ListFormat === "function") {
      try {
        return new Intl.ListFormat((state.snapshot && state.snapshot.lang) || "en", {
          style: "short",
          type: "conjunction",
        }).format(names);
      } catch {
        // Fall back to the explicit locale separator below.
      }
    }
    return names.join(t("agentListSeparator"));
  }

  function getRecommendedInstallHints() {
    const hints = runtime.agentInstallationHints;
    const entries = hints && Array.isArray(hints.agents) ? hints.agents : [];
    const dismissed = state.snapshot && state.snapshot.dismissedAgentInstallHints;
    return entries.filter((entry) => {
      if (!entry || typeof entry.agentId !== "string") return false;
      if (!entry.detectedInstalled) return false;
      if (!INSTALL_HINT_CONFIDENCES.has(entry.confidence)) return false;
      if (!getAgentMetadata(entry.agentId)) return false;
      if (readers.readAgentIntegrationInstalled(entry.agentId)) return false;
      if (dismissed && dismissed[entry.agentId] === true) return false;
      return true;
    });
  }

  function getRecommendedCleanupHints() {
    const hints = runtime.agentInstallationHints;
    const entries = hints && Array.isArray(hints.agents) ? hints.agents : [];
    const dismissed = state.snapshot && state.snapshot.dismissedAgentCleanupHints;
    return entries.filter((entry) => {
      if (!entry || typeof entry.agentId !== "string") return false;
      if (entry.detectedInstalled) return false;
      if (!getAgentMetadata(entry.agentId)) return false;
      if (!readers.readAgentIntegrationInstalled(entry.agentId)) return false;
      if (dismissed && dismissed[entry.agentId] === true) return false;
      return true;
    });
  }

  function getInstallationHint(agentId) {
    const hints = runtime.agentInstallationHints;
    const entries = hints && Array.isArray(hints.agents) ? hints.agents : [];
    return entries.find((entry) => entry && entry.agentId === agentId) || null;
  }

  function hasRecommendedLocalInstall(agentId) {
    const entry = getInstallationHint(agentId);
    return !!(
      entry
      && entry.detectedInstalled === true
      && INSTALL_HINT_CONFIDENCES.has(entry.confidence)
    );
  }

  function categorizeAgentsForSections(agents) {
    const sections = {
      connected: [],
      recommended: [],
      unavailable: [],
    };
    for (const agent of agents) {
      if (!agent || !agent.id) continue;
      if (readers.readAgentIntegrationInstalled(agent.id)) {
        sections.connected.push(agent);
      } else if (hasRecommendedLocalInstall(agent.id)) {
        sections.recommended.push(agent);
      } else {
        sections.unavailable.push(agent);
      }
    }
    return sections;
  }

  function renderAgentSections(parent, agents) {
    const categorized = categorizeAgentsForSections(agents);
    const specs = [
      ["connected", "agentSectionConnected", "agent-section-connected"],
      ["recommended", "agentSectionRecommended", "agent-section-recommended"],
      ["unavailable", "agentSectionUnavailable", "agent-section-unavailable"],
    ];
    for (const [key, titleKey, className] of specs) {
      const sectionAgents = categorized[key];
      if (!Array.isArray(sectionAgents) || sectionAgents.length === 0) continue;
      const groups = sectionAgents.map((agent) => buildAgentGroup(agent));
      const section = helpers.buildSection(t(titleKey), groups);
      section.classList.add("agent-section", className);
      parent.appendChild(section);
    }
  }

  function getRestoredCleanupDismissalAgentIds() {
    const hints = runtime.agentInstallationHints;
    const entries = hints && Array.isArray(hints.agents) ? hints.agents : [];
    const dismissed = state.snapshot && state.snapshot.dismissedAgentCleanupHints;
    if (!dismissed || typeof dismissed !== "object") return [];
    return entries
      .filter((entry) =>
        entry
        && typeof entry.agentId === "string"
        && entry.detectedInstalled === true
        && dismissed[entry.agentId] === true
      )
      .map((entry) => entry.agentId);
  }

  function getMissingInstallDismissalAgentIds() {
    const hints = runtime.agentInstallationHints;
    const entries = hints && Array.isArray(hints.agents) ? hints.agents : [];
    const dismissed = state.snapshot && state.snapshot.dismissedAgentInstallHints;
    if (!dismissed || typeof dismissed !== "object") return [];
    return entries
      .filter((entry) =>
        entry
        && typeof entry.agentId === "string"
        && entry.detectedInstalled === false
        && dismissed[entry.agentId] === true
      )
      .map((entry) => entry.agentId);
  }

  function resetMissingInstallDismissals() {
    if (agentInstallHintResetPending) return;
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") return;
    const agentIds = getMissingInstallDismissalAgentIds();
    if (agentIds.length === 0) return;
    agentInstallHintResetPending = true;
    window.settingsAPI.command("clearAgentInstallHints", { agentIds }).catch((err) => {
      console.warn("settings: clearAgentInstallHints failed", err);
    }).finally(() => {
      agentInstallHintResetPending = false;
    });
  }

  function resetRestoredCleanupDismissals() {
    if (agentCleanupHintResetPending) return;
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") return;
    const agentIds = getRestoredCleanupDismissalAgentIds();
    if (agentIds.length === 0) return;
    agentCleanupHintResetPending = true;
    window.settingsAPI.command("clearAgentCleanupHints", { agentIds }).catch((err) => {
      console.warn("settings: clearAgentCleanupHints failed", err);
    }).finally(() => {
      agentCleanupHintResetPending = false;
    });
  }

  function buildAgentInstallHintBanner(hints) {
    const agentIds = hints.map((entry) => entry.agentId);
    const banner = document.createElement("section");
    banner.className = "agent-hint-banner agent-install-hint-banner";

    const text = document.createElement("div");
    text.className = "agent-hint-text agent-install-hint-text";
    const title = document.createElement("div");
    title.className = "agent-hint-title agent-install-hint-title";
    title.textContent = t("agentInstallHintTitle");
    const desc = document.createElement("div");
    desc.className = "agent-hint-desc agent-install-hint-desc";
    desc.textContent = t("agentInstallHintDesc").replace("{agents}", formatAgentNames(agentIds));
    text.appendChild(title);
    text.appendChild(desc);
    banner.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "agent-hint-actions agent-install-hint-actions";
    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "soft-btn accent agent-install-hint-install";
    installBtn.textContent = agentHintActionPending
      ? t("agentIntegrationWorking")
      : t("agentInstallHintInstallRecommended");
    installBtn.disabled = !!agentHintActionPending;
    installBtn.addEventListener("click", () => installRecommendedHints(agentIds));

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "soft-btn agent-install-hint-dismiss";
    dismissBtn.textContent = t("agentInstallHintDismiss");
    dismissBtn.disabled = !!agentHintActionPending;
    dismissBtn.addEventListener("click", () => dismissInstallHints(agentIds));

    actions.appendChild(installBtn);
    actions.appendChild(dismissBtn);
    banner.appendChild(actions);
    return banner;
  }

  function buildAgentCleanupHintBanner(hints) {
    const agentIds = hints.map((entry) => entry.agentId);
    const banner = document.createElement("section");
    banner.className = "agent-hint-banner agent-cleanup-hint-banner";

    const text = document.createElement("div");
    text.className = "agent-hint-text agent-cleanup-hint-text";
    const title = document.createElement("div");
    title.className = "agent-hint-title agent-cleanup-hint-title";
    title.textContent = t("agentCleanupHintTitle");
    const desc = document.createElement("div");
    desc.className = "agent-hint-desc agent-cleanup-hint-desc";
    desc.textContent = t("agentCleanupHintDesc").replace("{agents}", formatAgentNames(agentIds));
    text.appendChild(title);
    text.appendChild(desc);
    banner.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "agent-hint-actions agent-cleanup-hint-actions";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "soft-btn accent agent-cleanup-hint-remove";
    removeBtn.textContent = agentHintActionPending
      ? t("agentIntegrationWorking")
      : t("agentCleanupHintRemove");
    removeBtn.disabled = !!agentHintActionPending;
    removeBtn.addEventListener("click", () => removeCleanupHints(agentIds));

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "soft-btn agent-cleanup-hint-dismiss";
    dismissBtn.textContent = t("agentCleanupHintDismiss");
    dismissBtn.disabled = !!agentHintActionPending;
    dismissBtn.addEventListener("click", () => dismissCleanupHints(agentIds));

    actions.appendChild(removeBtn);
    actions.appendChild(dismissBtn);
    banner.appendChild(actions);
    return banner;
  }

  function refreshInstallationHints() {
    if (ops && typeof ops.fetchAgentInstallationHints === "function") {
      return ops.fetchAgentInstallationHints({ force: true });
    }
    return Promise.resolve();
  }

  async function installRecommendedHints(agentIds) {
    if (agentHintActionPending) return;
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    agentHintActionPending = true;
    ops.requestRender({ content: true });
    let installed = 0;
    let skipped = 0;
    const skippedAgentIds = [];
    let failed = 0;
    let firstError = "";
    try {
      for (const agentId of agentIds) {
        const result = await window.settingsAPI.command("installAgentIntegration", { agentId });
        if (result && result.status === "ok") {
          installed++;
        } else if (result && result.status === "skipped") {
          skipped++;
          skippedAgentIds.push(agentId);
        } else if (!firstError) {
          failed++;
          firstError = (result && result.message) || "unknown error";
        } else {
          failed++;
        }
      }
      if (failed > 0) {
        ops.showToast(formatHintResult(t("toastAgentInstallHintPartial"), {
          success: installed,
          failed,
          message: firstError,
        }), { error: true });
      } else if (installed > 0) {
        if (skipped > 0) {
          ops.showToast(formatHintResult(t("toastAgentInstallHintPartialSkipped"), {
            success: installed,
            agents: formatAgentNames(skippedAgentIds),
          }), { ttl: 5000 });
        } else {
          ops.showToast(t("toastAgentInstallHintInstalled"));
        }
      } else if (skipped > 0) {
        ops.showToast(formatHintResult(t("toastAgentInstallHintSkipped"), {
          agents: formatAgentNames(skippedAgentIds),
        }), { ttl: 5000 });
      }
    } catch (err) {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    } finally {
      agentHintActionPending = false;
      refreshInstallationHints().finally(() => ops.requestRender({ content: true })).catch(() => {});
    }
  }

  function dismissInstallHints(agentIds) {
    if (agentHintActionPending) return;
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    agentHintActionPending = true;
    ops.requestRender({ content: true });
    window.settingsAPI.command("dismissAgentInstallHints", { agentIds }).then((result) => {
      if (!result || result.status !== "ok") {
        const msg = (result && result.message) || "unknown error";
        ops.showToast(t("toastSaveFailed") + msg, { error: true });
      }
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    }).finally(() => {
      agentHintActionPending = false;
      ops.requestRender({ content: true });
    });
  }

  async function removeCleanupHints(agentIds) {
    if (agentHintActionPending) return;
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    agentHintActionPending = true;
    ops.requestRender({ content: true });
    let removed = 0;
    let failed = 0;
    let firstError = "";
    try {
      for (const agentId of agentIds) {
        const result = await window.settingsAPI.command("uninstallAgentIntegration", {
          agentId,
          dismissInstallHint: false,
        });
        if (result && result.status === "ok") {
          removed++;
        } else {
          failed++;
          if (!firstError) firstError = (result && result.message) || "unknown error";
        }
      }
      if (failed > 0) {
        ops.showToast(formatHintResult(t("toastAgentCleanupHintPartial"), {
          success: removed,
          failed,
          message: firstError,
        }), { error: true });
      } else if (removed > 0) {
        ops.showToast(t("toastAgentCleanupHintRemoved"));
      }
    } catch (err) {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    } finally {
      agentHintActionPending = false;
      refreshInstallationHints().finally(() => ops.requestRender({ content: true })).catch(() => {});
    }
  }

  function dismissCleanupHints(agentIds) {
    if (agentHintActionPending) return;
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    agentHintActionPending = true;
    ops.requestRender({ content: true });
    window.settingsAPI.command("dismissAgentCleanupHints", { agentIds }).then((result) => {
      if (!result || result.status !== "ok") {
        const msg = (result && result.message) || "unknown error";
        ops.showToast(t("toastSaveFailed") + msg, { error: true });
      }
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    }).finally(() => {
      agentHintActionPending = false;
      ops.requestRender({ content: true });
    });
  }

  function formatHintResult(template, values) {
    return String(template)
      .replace("{success}", String(values.success))
      .replace("{failed}", String(values.failed))
      .replace("{agents}", values.agents || "")
      .replace("{message}", values.message || "unknown error");
  }

  function showClaudeHooksDisableConfirmModal() {
    return helpers.showSettingsConfirmModal({
      title: t("claudeHooksDisableConfirmTitle"),
      detail: t("claudeHooksDisableConfirmDetail"),
      actions: [
        { id: "disconnect", label: t("claudeHooksDisableConfirmDisconnect"), tone: "danger" },
        { id: "disable", label: t("claudeHooksDisableConfirmDisableOnly"), tone: "neutral" },
        { id: "keep", label: t("claudeHooksDisableConfirmKeep"), tone: "accent", defaultFocus: true },
      ],
    });
  }

  function showClaudeHooksDisconnectConfirmModal() {
    return helpers.showSettingsConfirmModal({
      title: t("claudeHooksDisconnectConfirmTitle"),
      detail: t("claudeHooksDisconnectConfirmDetail"),
      actions: [
        { id: "disconnect", label: t("claudeHooksDisconnectConfirmAction"), tone: "danger" },
        { id: "keep", label: t("claudeHooksDisconnectConfirmKeep"), tone: "accent", defaultFocus: true },
      ],
    });
  }

  function confirmDisableClaudeHookManagement(nextRaw) {
    if (nextRaw) return window.settingsAPI.update("manageClaudeHooksAutomatically", true);
    return showClaudeHooksDisableConfirmModal().then((actionId) => {
      if (!actionId || actionId === "keep") return { status: "ok", noop: true };
      if (actionId === "disconnect") return window.settingsAPI.command("uninstallHooks");
      return window.settingsAPI.update("manageClaudeHooksAutomatically", false);
    });
  }

  function runDisconnectClaudeHooks() {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      return Promise.resolve({ status: "error", message: "settings API unavailable" });
    }
    return showClaudeHooksDisconnectConfirmModal().then((actionId) => {
      if (actionId !== "disconnect") return { status: "ok", noop: true };
      return window.settingsAPI.command("uninstallHooks");
    });
  }

  function buildClaudeHookManagementRows() {
    const manageHooksEnabled = !!(state.snapshot && state.snapshot.manageClaudeHooksAutomatically);
    const manageRow = helpers.buildSwitchRow({
      key: "manageClaudeHooksAutomatically",
      labelKey: "rowManageClaudeHooks",
      descKey: "rowManageClaudeHooksDesc",
      descExtraKey: "rowManageClaudeHooksOffNote",
      onToggle: ({ nextRaw }) => confirmDisableClaudeHookManagement(nextRaw),
      actionButton: {
        labelKey: "actionDisconnectClaudeHooks",
        invoke: () => runDisconnectClaudeHooks(),
      },
    });
    manageRow.classList.add("row-sub");
    const autoStartRow = helpers.buildSwitchRow({
      key: "autoStartWithClaude",
      labelKey: "rowStartWithClaude",
      descKey: "rowStartWithClaudeDesc",
      descExtraKey: manageHooksEnabled ? null : "rowStartWithClaudeDisabledDesc",
      disabled: !manageHooksEnabled,
    });
    autoStartRow.classList.add("row-sub");
    return [manageRow, autoStartRow];
  }

  function buildAgentGroup(agent) {
    const masterRow = buildAgentMasterRow(agent);
    const detailRows = buildAgentDetailRows(agent);
    masterRow.classList.add("agent-summary-row");
    if (detailRows.length === 0) return masterRow;
    return helpers.buildCollapsibleGroup({
      id: `agents:${agent.id}`,
      headerContent: masterRow,
      children: detailRows,
      defaultCollapsed: true,
      className: "agent-subgroup",
    });
  }

  function buildAgentMasterRow(agent) {
    let integrationBadge = null;
    return buildAgentSwitchRow({
      agent,
      flag: "enabled",
      extraClass: null,
      disabled: false,
      buildText: (text) => {
        const label = document.createElement("span");
        label.className = "row-label";
        label.textContent = agent.name || agent.id;
        text.appendChild(label);
        const badges = document.createElement("span");
        badges.className = "row-desc agent-badges";
        const esKey = typeof getAgentEventSourceBadgeKey === "function"
          ? getAgentEventSourceBadgeKey(agent)
          : (agent.eventSource === "log-poll" ? "eventSourceLogPoll"
            : agent.eventSource === "plugin-event" ? "eventSourcePlugin"
            : agent.eventSource === "extension" ? "eventSourceExtension"
            : "eventSourceHook");
        const esBadge = document.createElement("span");
        esBadge.className = "agent-badge";
        esBadge.textContent = t(esKey);
        badges.appendChild(esBadge);
        integrationBadge = document.createElement("span");
        integrationBadge.className = "agent-badge integration";
        badges.appendChild(integrationBadge);
        if (agent.capabilities && agent.capabilities.permissionApproval) {
          const permBadge = document.createElement("span");
          permBadge.className = "agent-badge accent";
          permBadge.textContent = t("badgePermissionBubble");
          badges.appendChild(permBadge);
        }
        syncAgentIntegrationBadge(integrationBadge, agent.id);
        text.appendChild(badges);
      },
      buildExtraControls: (ctrl) => {
        const button = buildAgentIntegrationActionButton(agent);
        const meta = state.mountedControls.agentIntegrationActions.get(agent.id);
        if (meta) {
          meta.badge = integrationBadge;
          meta.syncFromSnapshot();
        }
        ctrl.appendChild(button);
      },
    });
  }

  function buildAgentDetailRows(agent) {
    const rows = [];
    const caps = agent.capabilities || {};
    if (agent.id === "claude-code") {
      rows.push(...buildClaudeHookManagementRows());
    }
    if (agent.id === "codex") {
      rows.push(buildCodexPermissionModeRow(agent, computeAgentSubSwitchDisabled(agent.id, "permissionMode")));
      rows.push(buildAgentSwitchRow({
        agent,
        flag: "nativeNotificationSoundEnabled",
        extraClass: "row-sub",
        disabled: computeAgentSubSwitchDisabled(agent.id, "nativeNotificationSoundEnabled"),
        buildText: (text) => {
          const label = document.createElement("span");
          label.className = "row-label";
          label.textContent = t("rowCodexNativeNotificationSound");
          text.appendChild(label);
          const desc = document.createElement("span");
          desc.className = "row-desc";
          desc.textContent = t("rowCodexNativeNotificationSoundDesc");
          text.appendChild(desc);
        },
      }));
      // Startup nudge gate: warn (once per breakage) when the official hook —
      // now the ONLY Codex approval path — is disabled / needs review / inactive.
      const codexHookNotifyRow = helpers.buildSwitchRow({
        key: "codexHookHealthNotifyEnabled",
        labelKey: "rowCodexHookHealthNotify",
        descKey: "rowCodexHookHealthNotifyDesc",
      });
      codexHookNotifyRow.classList.add("row-sub");
      rows.push(codexHookNotifyRow);
    }
    if (caps.permissionApproval || caps.interactiveBubble) {
      rows.push(buildAgentSwitchRow({
        agent,
        flag: "permissionsEnabled",
        extraClass: "row-sub",
        disabled: computeAgentSubSwitchDisabled(agent.id, "permissionsEnabled"),
        buildText: (text) => {
          const label = document.createElement("span");
          label.className = "row-label";
          label.textContent = t("rowAgentPermissions");
          text.appendChild(label);
          const desc = document.createElement("span");
          desc.className = "row-desc";
          desc.textContent = t("rowAgentPermissionsDesc");
          text.appendChild(desc);
        },
      }));
      // #451: only Claude Code marks subagent-origin permission requests
      // (agent_id in the common hook fields), so only it gets the sub-gate.
      if (agent.id === "claude-code") {
        rows.push(buildAgentSwitchRow({
          agent,
          flag: "subagentPermissionsEnabled",
          extraClass: "row-sub",
          disabled: computeAgentSubSwitchDisabled(agent.id, "subagentPermissionsEnabled"),
          buildText: (text) => {
            const label = document.createElement("span");
            label.className = "row-label";
            label.textContent = t("rowAgentSubagentPermissions");
            text.appendChild(label);
            const desc = document.createElement("span");
            desc.className = "row-desc";
            desc.textContent = t("rowAgentSubagentPermissionsDesc");
            text.appendChild(desc);
          },
        }));
      }
    }
    if (caps.notificationHook) {
      rows.push(buildAgentSwitchRow({
        agent,
        flag: "notificationHookEnabled",
        extraClass: "row-sub",
        disabled: computeAgentSubSwitchDisabled(agent.id, "notificationHookEnabled"),
        buildText: (text) => {
          const label = document.createElement("span");
          label.className = "row-label";
          label.textContent = t("rowAgentIdleAlerts");
          text.appendChild(label);
          const desc = document.createElement("span");
          desc.className = "row-desc";
          desc.textContent = t("rowAgentIdleAlertsDesc");
          text.appendChild(desc);
        },
      }));
    }
    // WSL instances: show detected agent installations across distros
    rows.push(...buildAgentInstanceRows(agent));
    return rows;
  }

  // ── WSL instance rows ─────────────────────────────────────────────

  function getWslAgentInstances(agentId) {
    const hints = runtime.agentInstallationHints;
    if (!hints || !Array.isArray(hints.wslAgents)) return [];
    return hints.wslAgents.filter(
      (entry) => entry && entry.agentId === agentId && entry.detectedInstalled === true
    );
  }

  function buildAgentInstanceRows(agent) {
    const rows = [];
    const wslInstances = getWslAgentInstances(agent.id);
    if (wslInstances.length === 0) return rows;

    const headerRow = document.createElement("div");
    headerRow.className = "row-sub agent-instance-section-header";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("agentInstanceSection");
    headerRow.appendChild(label);
    rows.push(headerRow);

    for (const inst of wslInstances) {
      rows.push(buildWslInstanceRow(agent, inst));
    }
    return rows;
  }

  function buildWslInstanceRow(agent, wslEntry) {
    const row = document.createElement("div");
    row.className = "row row-sub agent-instance-row";

    const text = document.createElement("div");
    text.className = "row-text";

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = `WSL: ${wslEntry.distro}`;
    text.appendChild(label);

    // Distro-level marker: hook files are present AND claude-code's
    // settings.json references them (hooksDeployed = DEPFILE && DEPREG).
    // Not per-agent pairing truth — that would require inspecting each
    // agent's config inside WSL — but enough to show Pair took effect and
    // to go dark after a claude-code Unpair.
    if (wslEntry.hooksDeployed) {
      const deployed = document.createElement("span");
      deployed.className = "agent-instance-deployed";
      deployed.textContent = t("agentInstanceDeployedBadge");
      label.appendChild(deployed);
    }

    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = wslEntry.wslParentDir || "";
    text.appendChild(desc);

    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";

    const button = document.createElement("button");
    button.className = "soft-btn agent-instance-action";
    button.textContent = t("agentInstancePair");
    button.title = `WSL: ${wslEntry.distro}`;
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = t("agentInstancePairing");
      try {
        if (window.settingsAPI && typeof window.settingsAPI.command === "function") {
          const result = await window.settingsAPI.command("deployToWsl", {
            agentId: agent.id,
            distro: wslEntry.distro,
          });
          if (result && result.status === "ok") {
            if (result.wslConnectivity === false) {
              // Hooks installed, but the distro cannot reach Clawd (NAT
              // networking) — sessions would silently never appear.
              ops.showToast(t("agentInstancePairedNoConnectivity"), { error: true });
            } else {
              ops.showToast(result.message || t("agentInstancePaired"));
            }
            // Refresh hints so the UI updates (and Pair button may disappear)
            if (typeof ops.fetchAgentInstallationHints === "function") {
              ops.fetchAgentInstallationHints({ refreshWsl: true }).then(() => {
                ops.requestRender({ content: true });
              }).catch(() => {
                // DOM may be torn down if user navigated away before refresh completes
              });
            }
          } else {
            const msg = (result && result.message) || "WSL deploy failed";
            ops.showToast(msg, { error: true });
          }
        }
      } catch (err) {
        ops.showToast(
          String(err && err.message ? err.message : err),
          { error: true }
        );
      } finally {
        button.disabled = false;
        button.textContent = t("agentInstancePair");
      }
    });
    ctrl.appendChild(button);

    // Unpair — offered whenever hook FILES are present (hooksFilesPresent),
    // not gated on the registration-based badge (hooksDeployed): a distro
    // paired with only a non-claude agent registers in that agent's own
    // config, so the claude-settings badge is off, yet the user still needs
    // an unpair entry point. Runs the agent's uninstall inside the distro;
    // hook files stay (shared by other agents).
    if (wslEntry.hooksFilesPresent) {
      const unpairBtn = document.createElement("button");
      unpairBtn.className = "soft-btn agent-instance-action";
      unpairBtn.textContent = t("agentInstanceUnpair");
      unpairBtn.title = `WSL: ${wslEntry.distro}`;
      unpairBtn.addEventListener("click", async () => {
        unpairBtn.disabled = true;
        unpairBtn.textContent = t("agentInstanceUnpairing");
        try {
          if (window.settingsAPI && typeof window.settingsAPI.command === "function") {
            const result = await window.settingsAPI.command("removeFromWsl", {
              agentId: agent.id,
              distro: wslEntry.distro,
            });
            if (result && result.status === "ok") {
              ops.showToast(result.message || t("agentInstanceUnpaired"));
              if (typeof ops.fetchAgentInstallationHints === "function") {
                ops.fetchAgentInstallationHints({ refreshWsl: true }).then(() => {
                  ops.requestRender({ content: true });
                }).catch(() => {
                  // DOM may be torn down if user navigated away before refresh completes
                });
              }
            } else {
              ops.showToast((result && result.message) || "WSL unpair failed", { error: true });
            }
          }
        } catch (err) {
          ops.showToast(String(err && err.message ? err.message : err), { error: true });
        } finally {
          unpairBtn.disabled = false;
          unpairBtn.textContent = t("agentInstanceUnpair");
        }
      });
      ctrl.appendChild(unpairBtn);
    }

    row.appendChild(ctrl);

    return row;
  }

  function computeAgentSubSwitchDisabled(agentId, flag) {
    if (flag === "enabled") return false;
    const masterOn = readers.readAgentFlagValue(agentId, "enabled");
    if (!masterOn) return true;
    if (agentId === "codex" && flag === "permissionsEnabled") {
      return readers.readAgentPermissionMode(agentId) !== "intercept";
    }
    if (agentId === "codex" && flag === "nativeNotificationSoundEnabled") {
      return readers.readAgentPermissionMode(agentId) !== "native";
    }
    // Subagent sub-gate sits under the permission switch: pointless to toggle
    // while the parent permission gate already suppresses every CC bubble.
    if (flag === "subagentPermissionsEnabled") {
      return !readers.readAgentFlagValue(agentId, "permissionsEnabled");
    }
    return false;
  }

  function buildCodexPermissionModeRow(agent, disabled) {
    const row = document.createElement("div");
    row.className = "row row-sub";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowCodexPermissionMode");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("rowCodexPermissionModeDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const segmented = document.createElement("div");
    segmented.className = "segmented codex-permission-mode-segmented";
    segmented.setAttribute("role", "tablist");
    const current = readers.readAgentPermissionMode(agent.id);
    segmented.style.setProperty("--codex-permission-mode-active-index", String(getCodexPermissionModeIndex(current)));
    for (const mode of CODEX_PERMISSION_MODE_OPTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.mode = mode.id;
      btn.textContent = t(mode.labelKey);
      btn.classList.toggle("active", current === mode.id);
      btn.disabled = !!disabled;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (btn.disabled || btn.classList.contains("active")) return;
        window.settingsAPI.command("setAgentPermissionMode", {
          agentId: agent.id,
          mode: mode.id,
        }).then((result) => {
          if (!result || result.status !== "ok") {
            const msg = (result && result.message) || "unknown error";
            ops.showToast(t("toastSaveFailed") + msg, { error: true });
          }
        }).catch((err) => {
          ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
        });
      });
      segmented.appendChild(btn);
    }
    ctrl.appendChild(segmented);
    row.appendChild(ctrl);
    state.mountedControls.agentPermissionModes.set(agent.id, {
      row,
      agentId: agent.id,
      syncFromSnapshot: () => syncCodexPermissionModeRow(row, agent.id),
    });
    return row;
  }

  function syncCodexPermissionModeRow(row, agentId) {
    const disabled = !readers.readAgentFlagValue(agentId, "enabled");
    const current = readers.readAgentPermissionMode(agentId);
    const segmented = row.querySelector(".codex-permission-mode-segmented");
    const currentIndex = getCodexPermissionModeIndex(current);
    const previousActive = segmented && [...segmented.querySelectorAll("button")]
      .find((btn) => btn.classList.contains("active"));
    const previousIndex = previousActive
      ? getCodexPermissionModeIndex(previousActive.dataset.mode)
      : currentIndex;
    if (segmented) {
      segmented.style.setProperty("--codex-permission-mode-active-index", String(previousIndex));
    }
    for (const btn of row.querySelectorAll("button")) {
      btn.classList.toggle("active", btn.dataset.mode === current);
      btn.disabled = !!disabled;
    }
    if (segmented && previousIndex !== currentIndex) {
      requestAnimationFrame(() => {
        segmented.getBoundingClientRect();
        segmented.style.setProperty("--codex-permission-mode-active-index", String(currentIndex));
      });
    } else if (segmented) {
      segmented.style.setProperty("--codex-permission-mode-active-index", String(currentIndex));
    }
  }

  function getCodexPermissionModeIndex(mode) {
    return Math.max(0, CODEX_PERMISSION_MODE_OPTIONS.findIndex((option) => option.id === mode));
  }

  function syncAgentSwitchDisabledState(meta, disabled) {
    meta.disabled = !!disabled;
    const sw = meta.element;
    sw.classList.toggle("disabled", !!disabled);
    sw.setAttribute("aria-disabled", disabled ? "true" : "false");
    sw.setAttribute("tabindex", disabled ? "-1" : "0");
  }

  function syncAgentIntegrationBadge(badge, agentId) {
    if (!badge) return;
    const installed = readers.readAgentIntegrationInstalled(agentId);
    badge.classList.toggle("not-installed", !installed);
    badge.textContent = t(installed ? "agentIntegrationInstalled" : "agentIntegrationNotInstalled");
    if (agentId === "codex") annotateCodexHookHealth(badge, installed);
  }

  // Codex approval awareness now depends ENTIRELY on the official PermissionRequest
  // hook (JSONL no longer infers approvals). A hook that is registered but
  // disabled / needs-review / mis-registered still reads as "Installed" from
  // prefs, yet Codex never runs it — so the pet shows no approval prompts. Overlay
  // an amber warning, sourced from the same check the Doctor uses (so they agree),
  // with the specific reason in the tooltip. Async + best-effort: if the probe is
  // unavailable or healthy, the badge keeps its base "Installed" state.
  function annotateCodexHookHealth(badge, installed) {
    if (!badge) return;
    const seq = String(++codexHookHealthRequestSeq);
    if (badge.dataset) badge.dataset.codexHookHealthSeq = seq;
    badge.classList.remove("hook-warning");
    badge.removeAttribute("title");
    if (!installed || !window.doctor || typeof window.doctor.codexHookHealth !== "function") return;
    window.doctor.codexHookHealth().then((health) => {
      if (badge.isConnected === false) return;
      if (badge.dataset && badge.dataset.codexHookHealthSeq !== seq) return;
      if (!health || health.healthy || !health.signature) return;
      if (!readers.readAgentIntegrationInstalled("codex")) return;
      badge.classList.add("hook-warning");
      badge.textContent = t("agentCodexHookNeedsAttention");
      if (health.reasonKey) badge.title = t(health.reasonKey);
    }).catch(() => {});
  }

  function syncAgentIntegrationAction(meta) {
    if (!meta || !meta.button) return;
    const installed = readers.readAgentIntegrationInstalled(meta.agentId);
    meta.button.disabled = false;
    meta.button.classList.remove("pending");
    meta.button.textContent = t(installed ? "agentIntegrationUninstall" : "agentIntegrationInstall");
    meta.button.setAttribute(
      "aria-label",
      t(installed ? "agentIntegrationUninstall" : "agentIntegrationInstall")
    );
    if (meta.badge) syncAgentIntegrationBadge(meta.badge, meta.agentId);
  }

  function buildAgentIntegrationActionButton(agent) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "soft-btn agent-integration-action";
    const meta = {
      button,
      agentId: agent.id,
      badge: null,
    };
    meta.syncFromSnapshot = () => syncAgentIntegrationAction(meta);
    syncAgentIntegrationAction(meta);
    button.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (button.disabled) return;
      const installed = readers.readAgentIntegrationInstalled(agent.id);
      const command = installed ? "uninstallAgentIntegration" : "installAgentIntegration";
      if (installed && typeof window.confirm === "function" && !window.confirm(t("agentIntegrationUninstallConfirm"))) {
        return;
      }
      button.disabled = true;
      button.classList.add("pending");
      button.textContent = t("agentIntegrationWorking");
      window.settingsAPI.command(command, { agentId: agent.id }).then((result) => {
        if (result && result.status === "skipped") {
          ops.showToast(formatHintResult(t("agentIntegrationInstallSkipped"), {
            agents: agent.name || agent.id,
          }), { ttl: 5000 });
          refreshInstallationHints();
          syncAgentIntegrationAction(meta);
          return;
        }
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + msg, { error: true });
          syncAgentIntegrationAction(meta);
          return;
        }
        const key = installed ? "toastAgentIntegrationUninstalled" : "toastAgentIntegrationInstalled";
        ops.showToast(t(key));
        refreshInstallationHints();
      }).catch((err) => {
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      }).finally(() => {
        syncAgentIntegrationAction(meta);
      });
    });
    state.mountedControls.agentIntegrationActions.set(agent.id, meta);
    return button;
  }

  function buildAgentSwitchRow({ agent, flag, extraClass, disabled = false, buildText, buildExtraControls }) {
    const row = document.createElement("div");
    row.className = extraClass ? `row ${extraClass}` : "row";

    const text = document.createElement("div");
    text.className = "row-text";
    buildText(text);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    if (typeof buildExtraControls === "function") {
      buildExtraControls(ctrl);
    }
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", disabled ? "-1" : "0");
    sw.addEventListener("click", (ev) => {
      ev.stopPropagation();
    });
    sw.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
    });
    const stateId = readers.agentSwitchStateId(agent.id, flag);
    const override = state.transientUiState.agentSwitches.get(stateId);
    const committedVisual = readers.readAgentFlagValue(agent.id, flag);
    helpers.setSwitchVisual(sw, override ? override.visualOn : committedVisual, {
      pending: override ? override.pending : false,
    });
    const meta = {
      element: sw,
      agentId: agent.id,
      flag,
      disabled,
      syncDisabledState: (nextDisabled) => syncAgentSwitchDisabledState(meta, nextDisabled),
    };
    state.mountedControls.agentSwitches.set(stateId, meta);
    syncAgentSwitchDisabledState(meta, disabled);
    helpers.attachAnimatedSwitch(sw, {
      getCommittedVisual: () => readers.readAgentFlagValue(agent.id, flag),
      getTransientState: () => state.transientUiState.agentSwitches.get(stateId) || null,
      setTransientState: (value) => state.transientUiState.agentSwitches.set(stateId, value),
      clearTransientState: (seq) => {
        const current = state.transientUiState.agentSwitches.get(stateId);
        if (!current || (seq !== undefined && current.seq !== seq)) return;
        state.transientUiState.agentSwitches.delete(stateId);
      },
      invoke: () =>
        window.settingsAPI.command("setAgentFlag", {
          agentId: agent.id,
          flag,
          value: !readers.readAgentFlagValue(agent.id, flag),
        }),
    });
    ctrl.appendChild(sw);
    row.appendChild(ctrl);
    return row;
  }

  function patchInPlace(changes) {
    const keys = changes ? Object.keys(changes) : [];
    if (!(keys.length === 1 && keys[0] === "agents")) return false;
    if (state.mountedControls.agentSwitches.size === 0) return false;
    for (const [, meta] of state.mountedControls.agentSwitches) {
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const [, meta] of state.mountedControls.agentPermissionModes) {
      if (!meta || !meta.row || !document.body.contains(meta.row)) return false;
    }
    for (const [, meta] of state.mountedControls.agentIntegrationActions) {
      if (!meta || !meta.button || !document.body.contains(meta.button)) return false;
    }
    for (const [id, meta] of state.mountedControls.agentSwitches) {
      state.transientUiState.agentSwitches.delete(id);
      if (meta.flag !== "enabled") {
        meta.syncDisabledState(computeAgentSubSwitchDisabled(meta.agentId, meta.flag));
      }
      helpers.setSwitchVisual(meta.element, readers.readAgentFlagValue(meta.agentId, meta.flag), { pending: false });
    }
    for (const [, meta] of state.mountedControls.agentPermissionModes) {
      meta.syncFromSnapshot();
    }
    for (const [, meta] of state.mountedControls.agentIntegrationActions) {
      meta.syncFromSnapshot();
    }
    return true;
  }

  function init(core) {
    state = core.state;
    runtime = core.runtime;
    readers = core.readers;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.agents = {
      render,
      patchInPlace,
    };
  }

  root.ClawdSettingsTabAgents = { init };
})(globalThis);
