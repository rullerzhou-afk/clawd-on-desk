"use strict";

(function initSettingsTabAgents(root) {
  let state = null;
  let runtime = null;
  let readers = null;
  let helpers = null;

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

    const rows = runtime.agentMetadata.flatMap((agent) => buildAgentRows(agent));
    parent.appendChild(helpers.buildSection("", rows));
  }

  function buildAgentRows(agent) {
    // Sub-switches depend on the master: when the agent is turned off, the
    // sub-flags have no effect (server-side gate drops the events upstream),
    // so we render them as visually disabled to match reality. Committed
    // values are preserved — flipping the master back on restores sub-switch
    // state verbatim without re-asking the user to opt back in.
    const masterOn = readers.readAgentFlagValue(agent.id, "enabled");
    const rows = [
      buildAgentSwitchRow({
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
          const esKey = agent.eventSource === "log-poll" ? "eventSourceLogPoll"
            : agent.eventSource === "plugin-event" ? "eventSourcePlugin"
            : "eventSourceHook";
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
      }),
    ];
    const caps = agent.capabilities || {};
    if (caps.permissionApproval || caps.interactiveBubble) {
      rows.push(buildAgentSwitchRow({
        agent,
        flag: "permissionsEnabled",
        extraClass: "row-sub",
        disabled: !masterOn,
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
        disabled: !masterOn,
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
    if (disabled) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
    }
    const stateId = readers.agentSwitchStateId(agent.id, flag);
    const override = state.transientUiState.agentSwitches.get(stateId);
    const committedVisual = readers.readAgentFlagValue(agent.id, flag);
    helpers.setSwitchVisual(sw, override ? override.visualOn : committedVisual, {
      pending: override ? override.pending : false,
    });
    state.mountedControls.agentSwitches.set(stateId, {
      element: sw,
      agentId: agent.id,
      flag,
      disabled,
    });
    // Disabled sub-switches intentionally skip the click handler so the flip
    // animation never fires while the master is off. Committed value stays
    // untouched — buildAgentRows reads it at the next re-render and the flip
    // restores naturally when the master turns back on.
    if (disabled) {
      ctrl.appendChild(sw);
      row.appendChild(ctrl);
      return row;
    }
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
    // A master flip changes which sub-switches should render disabled; that's
    // a structural change (attach/detach click handler + tabindex + aria),
    // so fall back to a full re-render instead of trying to patch it in place.
    // Also clear lingering transient state before doing so — otherwise the
    // in-flight `pending:true` from the master click itself leaks into the
    // re-render, locks `.pending` onto the new master switch, and
    // attachAnimatedSwitch silently bails on every subsequent click.
    for (const [, meta] of state.mountedControls.agentSwitches) {
      if (!meta || !document.body.contains(meta.element)) return false;
      if (meta.flag === "enabled") continue;
      const masterOn = readers.readAgentFlagValue(meta.agentId, "enabled");
      if (meta.disabled === masterOn) {
        for (const id of state.mountedControls.agentSwitches.keys()) {
          state.transientUiState.agentSwitches.delete(id);
        }
        return false;
      }
    }
    for (const [id, meta] of state.mountedControls.agentSwitches) {
      state.transientUiState.agentSwitches.delete(id);
      helpers.setSwitchVisual(meta.element, readers.readAgentFlagValue(meta.agentId, meta.flag), { pending: false });
    }
    return true;
  }

  function init(core) {
    state = core.state;
    runtime = core.runtime;
    readers = core.readers;
    helpers = core.helpers;
    core.tabs.agents = {
      render,
      patchInPlace,
    };
  }

  root.ClawdSettingsTabAgents = { init };
})(globalThis);
