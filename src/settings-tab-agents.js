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

  function t(key) {
    return helpers.t(key);
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("agentsTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("agentsSubtitle");
    parent.appendChild(subtitle);

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
    const groups = agents.map((agent) => buildAgentGroup(agent));
    parent.appendChild(helpers.buildSection("", groups));
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
        if (agent.capabilities && agent.capabilities.permissionApproval) {
          const permBadge = document.createElement("span");
          permBadge.className = "agent-badge accent";
          permBadge.textContent = t("badgePermissionBubble");
          badges.appendChild(permBadge);
        }
        text.appendChild(badges);
      },
    });
  }

  function buildAgentDetailRows(agent) {
    const rows = [];
    const caps = agent.capabilities || {};
    if (agent.id === "codex") {
      rows.push(buildCodexPermissionModeRow(agent, computeAgentSubSwitchDisabled(agent.id, "permissionMode")));
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
    return rows;
  }

  function computeAgentSubSwitchDisabled(agentId, flag) {
    if (flag === "enabled") return false;
    const masterOn = readers.readAgentFlagValue(agentId, "enabled");
    if (!masterOn) return true;
    if (agentId === "codex" && flag === "permissionsEnabled") {
      return readers.readAgentPermissionMode(agentId) !== "intercept";
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

  function buildAgentSwitchRow({ agent, flag, extraClass, disabled = false, buildText }) {
    const row = document.createElement("div");
    row.className = extraClass ? `row ${extraClass}` : "row";

    const text = document.createElement("div");
    text.className = "row-text";
    buildText(text);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
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
