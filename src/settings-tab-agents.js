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
    const rows = [
      buildAgentSwitchRow({
        agent,
        flag: "enabled",
        extraClass: null,
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
    return rows;
  }

  function buildAgentSwitchRow({ agent, flag, extraClass, buildText }) {
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
    sw.setAttribute("tabindex", "0");
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
    });
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
    for (const [id, meta] of state.mountedControls.agentSwitches) {
      if (!meta || !document.body.contains(meta.element)) return false;
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
