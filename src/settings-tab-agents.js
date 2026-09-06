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
  const CUSTOM_TOOL_SCAN_STATUS_MIN_MS = 1200;
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

    const metadata = runtime.agentMetadata || [];
    const agents = typeof sortAgentMetadataForSettings === "function"
      ? sortAgentMetadataForSettings(metadata)
      : metadata;
    const categorized = categorizeAgentsForSections(agents);
    const subtab = resolveAgentsSubtab(categorized);

    parent.appendChild(buildAgentSubtabRow(subtab, categorized));

    // Each banner lives in the subtab it acts on: "install what we detected"
    // is what the discover subtab is for, and "your integration outlived its
    // agent" is about the connected list.
    if (subtab === "discover") {
      const recommendedHints = getRecommendedInstallHints();
      if (recommendedHints.length > 0) {
        parent.appendChild(buildAgentInstallHintBanner(recommendedHints));
      }
      renderDiscoverSubtab(parent, categorized);
      return;
    }

    const cleanupHints = getRecommendedCleanupHints();
    if (cleanupHints.length > 0) {
      parent.appendChild(buildAgentCleanupHintBanner(cleanupHints));
    }
    renderConnectedSubtab(parent, categorized, metadata.length === 0);
  }

  // "connected" unless nothing is connected yet — a first run would otherwise
  // open on an empty list instead of the agents it could add. Once the user
  // picks a subtab their choice is pinned for the rest of the session.
  function resolveAgentsSubtab(categorized) {
    if (runtime.agentsSubtab === "connected" || runtime.agentsSubtab === "discover") {
      return runtime.agentsSubtab;
    }
    return categorized.connected.length > 0 ? "connected" : "discover";
  }

  function renderConnectedSubtab(parent, categorized, noAgentsAtAll) {
    if (categorized.connected.length > 0) {
      // No section title: the subtab pill already says "Connected".
      const section = helpers.buildSection("", buildAgentRows(categorized.connected));
      section.classList.add("agent-section", "agent-section-connected");
      parent.appendChild(section);
      return;
    }
    const empty = document.createElement("div");
    empty.className = "placeholder";
    const message = noAgentsAtAll ? t("agentsEmpty") : t("agentsConnectedEmpty");
    empty.innerHTML = `<div class="placeholder-desc">${helpers.escapeHtml(message)}</div>`;
    parent.appendChild(empty);
  }

  function renderDiscoverSubtab(parent, categorized) {
    if (categorized.recommended.length > 0) {
      const section = helpers.buildSection(
        t("agentSectionRecommended"),
        buildAgentRows(categorized.recommended)
      );
      section.classList.add("agent-section", "agent-section-recommended");
      parent.appendChild(section);
    }
    parent.appendChild(buildCustomToolsSection());
    if (categorized.unavailable.length > 0) {
      parent.appendChild(buildUnavailableSection(categorized.unavailable));
    }
  }

  // A catalog of what Clawd supports, not a to-do list — collapsed by default
  // so the two actionable blocks above it stay in view, and searchable because
  // it is long enough that scanning it by eye is the slow path.
  function buildUnavailableSection(agents) {
    const rows = agents.map((agent) => {
      const row = buildAgentGroup(agent);
      row.dataset.agentSearch = `${agent.name || ""} ${agent.id || ""}`.toLowerCase();
      return row;
    });

    const count = document.createElement("span");
    count.className = "agent-section-count";

    function applyFilter() {
      const query = (runtime.agentsUnavailableQuery || "").trim().toLowerCase();
      let shown = 0;
      for (const row of rows) {
        const matches = !query || String(row.dataset.agentSearch || "").includes(query);
        row.classList.toggle("agent-row-filtered-out", !matches);
        if (matches) shown += 1;
      }
      // Counts what is on screen, so the number always matches what you see.
      count.textContent = String(shown);
    }

    const search = helpers.buildTextInput({
      type: "search",
      size: "compact",
      className: "agent-section-search",
      placeholder: t("agentSearchPlaceholder"),
      ariaLabel: t("agentSearchPlaceholder"),
      value: runtime.agentsUnavailableQuery || "",
      stopPropagation: true,
    });
    // The input sits inside the collapsible header, so the shared primitive
    // stops click/keydown propagation before the header can toggle.
    function commitQuery(event) {
      runtime.agentsUnavailableQuery = (event && event.target && event.target.value) || "";
      applyFilter();
      // Typing into a collapsed catalog would filter rows nobody can see.
      if (runtime.agentsUnavailableQuery && group.classList.contains("collapsed")) {
        const header = group.querySelector(".collapsible-group-header");
        // HTMLElement.click() in the browser; the test DOM has no click(), but
        // its dispatchEvent takes a plain descriptor.
        if (header && typeof header.click === "function") header.click();
        else if (header) header.dispatchEvent({ type: "click", bubbles: false });
      }
    }

    // Mid-composition the field holds pinyin/kana keystrokes rather than a
    // query, and filtering on those empties the list under the candidate
    // window while the user is still picking a character.
    let composing = false;
    search.addEventListener("compositionstart", () => { composing = true; });
    search.addEventListener("compositionend", (event) => {
      composing = false;
      commitQuery(event);
    });
    search.addEventListener("input", (event) => {
      if (composing) return;
      commitQuery(event);
    });

    const summary = document.createElement("div");
    summary.className = "agent-section-summary";
    summary.appendChild(search);
    summary.appendChild(count);

    const group = helpers.buildCollapsibleGroup({
      id: "agents:unavailable",
      title: t("agentSectionUnavailable"),
      summary,
      children: rows,
      defaultCollapsed: true,
      className: "agent-unavailable-group",
    });
    applyFilter();

    const section = helpers.buildSection("", [group]);
    section.classList.add("agent-section", "agent-section-unavailable");
    return section;
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
      // #895: strict false only. A detector entry that never reported on this
      // agent is unknown, and proposing a deletion on unknown is how a working
      // integration gets torn out.
      if (entry.detectedInstalled !== false) return false;
      const meta = getAgentMetadata(entry.agentId);
      // Fail closed: metadata that predates cleanupSuggestionExempt, or that
      // failed to load at all, must not be read as "safe to remove".
      if (!meta || meta.cleanupSuggestionExempt !== false) return false;
      if (!readers.readAgentIntegrationInstalled(entry.agentId)) return false;
      if (dismissed && dismissed[entry.agentId] === true) return false;
      return true;
    });
  }

  function categorizeAgentsForSections(agents) {
    const sections = {
      connected: [],
      recommended: [],
      unavailable: [],
    };
    for (const agent of agents) {
      if (!agent || !agent.id) continue;
      // A custom agent only exists in metadata once it has been registered,
      // and registering is what connects it — there is nothing left to install,
      // so it belongs with the connected agents whether or not its path still
      // resolves. A vanished path surfaces through its own row, not by
      // demoting the agent into the discover subtab.
      if (agent.custom) {
        sections.connected.push(agent);
        continue;
      }
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

  function hasRecommendedLocalInstall(agentId) {
    const entry = getInstallationHint(agentId);
    return !!(
      entry
      && entry.detectedInstalled === true
      && INSTALL_HINT_CONFIDENCES.has(entry.confidence)
    );
  }

  function getInstallationHint(agentId, custom = false) {
    const hints = runtime.agentInstallationHints;
    const entries = custom
      ? (hints && Array.isArray(hints.customAgents) ? hints.customAgents : [])
      : (hints && Array.isArray(hints.agents) ? hints.agents : []);
    return entries.find((entry) => entry && entry.agentId === agentId) || null;
  }

  function buildAgentRows(agents) {
    return agents.map((agent) => buildAgentGroup(agent));
  }

  // Splits the tab into "agent list" and "discover and add". The list is the
  // default because it is what the tab is for; manual discovery is the fallback
  // for when the built-in scan came up empty.
  function buildAgentSubtabRow(current, categorized) {
    const row = document.createElement("div");
    row.className = "agents-subtabs";

    const group = document.createElement("div");
    group.className = "segmented";
    group.setAttribute("role", "tablist");
    const entries = [
      { key: "connected", label: t("agentsSubtabConnected"), count: 0 },
      // Counts what the user can act on right now, so the badge stays a
      // to-do marker: agents detected locally but not connected yet.
      { key: "discover", label: t("agentsSubtabDiscover"), count: categorized.recommended.length },
    ];
    for (const entry of entries) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = entry.label;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", entry.key === current ? "true" : "false");
      if (entry.key === current) btn.classList.add("active");
      if (entry.count > 0) {
        const badge = document.createElement("span");
        badge.className = "agents-subtab-count";
        badge.textContent = String(entry.count);
        btn.appendChild(badge);
      }
      btn.addEventListener("click", () => {
        if (runtime.agentsSubtab === entry.key) return;
        runtime.agentsSubtab = entry.key;
        ops.requestRender({ content: true });
      });
      group.appendChild(btn);
    }
    row.appendChild(group);

    // WSL rescan belongs to the connected subtab: it re-detects built-in
    // agents installed inside distros, and its results render as instance rows
    // inside the agent cards — not as custom-tool discovery hits.
    if (current === "connected") {
      const wslScanControl = buildWslScanControl();
      if (wslScanControl) row.appendChild(wslScanControl);
    }
    return row;
  }

  function buildCustomToolsSection() {
    const row = document.createElement("div");
    row.className = "row-sub custom-tool-discovery-row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("customToolDiscoveryTitle");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("rowCustomToolsDiscoveryPathsDesc");
    const scanStatus = document.createElement("span");
    scanStatus.className = "custom-tool-scan-status";
    scanStatus.textContent = getCustomToolScanStatusText();
    text.appendChild(label);
    text.appendChild(desc);
    text.appendChild(scanStatus);
    row.appendChild(text);

    const control = document.createElement("div");
    control.className = "custom-tool-discovery-control custom-tool-discovery-actions";
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "soft-btn accent custom-tool-path-picker";
    addButton.textContent = t("customToolManualAdd");
    addButton.addEventListener("click", () => addPickedCustomDiscoveryPath(addButton));
    control.appendChild(addButton);
    const scanButton = document.createElement("button");
    scanButton.type = "button";
    scanButton.className = "soft-btn custom-tool-scan";
    scanButton.textContent = t("customToolRescan");
    scanButton.addEventListener("click", async () => {
      const scanStartedAt = Date.now();
      scanButton.disabled = true;
      scanStatus.classList.remove("failed");
      scanStatus.classList.add("pending");
      scanStatus.textContent = t("customToolScanStatusScanning");
      try {
        if (ops && typeof ops.fetchAgentInstallationHints === "function") {
          await ops.fetchAgentInstallationHints({ force: true });
        }
        const remainingStatusMs = CUSTOM_TOOL_SCAN_STATUS_MIN_MS - (Date.now() - scanStartedAt);
        if (remainingStatusMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingStatusMs));
        }
        scanStatus.textContent = getCustomToolScanStatusText();
      } catch (err) {
        scanStatus.classList.add("failed");
        scanStatus.textContent = t("customToolScanStatusFailed");
      } finally {
        scanStatus.classList.remove("pending");
        scanButton.disabled = false;
      }
    });
    control.appendChild(scanButton);
    row.appendChild(control);
    const rows = [row, ...buildCustomToolResultRows()];
    // No section title: the subtab pill already names this half of the tab.
    const section = helpers.buildSection("", rows);
    section.classList.add("agent-custom-tools-section");
    return section;
  }

  function buildWslScanControl() {
    const hints = runtime.agentInstallationHints;
    const wslDistros = hints && Array.isArray(hints.wslDistros) ? hints.wslDistros : [];
    const wslPending = !!(hints && hints.wslPending);
    const wslSupported = !!(hints && hints.wslSupported);
    if (!(wslSupported || wslDistros.length > 0 || wslPending)) return null;

    const control = document.createElement("div");
    control.className = "custom-tool-wsl-scan";
    const scanButton = document.createElement("button");
    scanButton.type = "button";
    scanButton.className = "soft-btn agent-instance-scan-btn";
    scanButton.textContent = t("agentInstanceScanWsl");
    scanButton.title = t("agentInstanceScanWslDesc");
    scanButton.addEventListener("click", async () => {
      scanButton.disabled = true;
      scanButton.textContent = t("agentInstanceScanning");
      try {
        if (ops && typeof ops.fetchAgentInstallationHints === "function") {
          await ops.fetchAgentInstallationHints({ refreshWsl: true });
        }
        ops.requestRender({ content: true });
      } catch (err) {
        console.warn("WSL scan failed:", err && err.message);
      } finally {
        scanButton.disabled = false;
        scanButton.textContent = t("agentInstanceScanWsl");
      }
    });
    control.appendChild(scanButton);

    if (wslPending) {
      const status = document.createElement("span");
      status.className = "agent-scan-status";
      status.textContent = t("agentInstanceScanning") + "...";
      control.appendChild(status);
    }
    return control;
  }

  function getCustomToolScanStatusText() {
    if (runtime.agentInstallationHintsPending) return t("customToolScanStatusScanning");
    const checkedAt = runtime.agentInstallationHints && runtime.agentInstallationHints.checkedAt;
    if (!Number.isFinite(checkedAt)) return t("customToolScanStatusIdle");
    let time = new Date(checkedAt).toLocaleTimeString();
    try {
      time = new Intl.DateTimeFormat((state.snapshot && state.snapshot.lang) || "en", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(checkedAt));
    } catch {}
    return t("customToolScanStatusComplete").replace("{time}", time);
  }

  async function addPickedCustomDiscoveryPath(button) {
    if (!window.settingsAPI || typeof window.settingsAPI.pickAgentDiscoveryPath !== "function") {
      ops.showToast(t("toastSaveFailed") + "path picker unavailable", { error: true });
      return;
    }
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = t("customToolScanStatusScanning");
    try {
      const result = await window.settingsAPI.pickAgentDiscoveryPath("directory");
      if (!result || result.status === "cancel") return;
      if (result.status !== "ok" || typeof result.path !== "string" || !result.path) {
        ops.showToast(t("toastSaveFailed") + ((result && result.message) || "path picker failed"), { error: true });
        return;
      }
      const paths = readers.readAgentCustomDiscoveryPaths("custom").slice();
      if (!paths.includes(result.path)) paths.push(result.path);
      const response = await window.settingsAPI.command("setAgentCustomDiscoveryPaths", {
        agentId: "custom",
        value: paths,
      });
      if (!response || response.status !== "ok") {
        throw new Error((response && response.message) || "failed to save discovery path");
      }
      if (ops && typeof ops.fetchAgentInstallationHints === "function") {
        await ops.fetchAgentInstallationHints({ force: true });
      }
      ops.requestRender({ content: true });
    } catch (err) {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  function buildCustomToolResultRows() {
    const configuredPaths = readers.readAgentCustomDiscoveryPaths("custom");
    const results = typeof readers.readCustomToolDetectionResults === "function"
      ? readers.readCustomToolDetectionResults()
      : [];
    if (configuredPaths.length === 0 && results.length === 0) return [];
    if (results.length === 0) {
      return configuredPaths.map((path) => buildCustomToolResultRow({
        path,
        detectedInstalled: null,
      }));
    }
    return results.map(buildCustomToolResultRow);
  }

  function getCustomToolResultStatusText(result) {
    if (result.detectedInstalled === true) return t("customToolNotRecognized");
    if (result.detectedInstalled === false) return t("customToolDetectionMissing");
    return t("customToolDetectionPending");
  }

  function buildCustomToolResultRow(result) {
    const row = document.createElement("div");
    // `.row` so the path and its action share one line, like every other row.
    row.className = "row row-sub custom-tool-result-row";
    row.classList.toggle("custom-tool-result-found", result.detectedInstalled === true);
    row.classList.toggle("custom-tool-result-missing", result.detectedInstalled === false);

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    if (result.application) {
      label.textContent = result.application.name;
    } else {
      // Raw path, not a name — mono + truncated, with the full value on hover.
      label.classList.add("custom-tool-result-path");
      label.textContent = result.path || "";
      if (result.path) label.title = result.path;
    }
    text.appendChild(label);
    const desc = document.createElement("span");
    desc.className = "row-desc custom-tool-result-detail";
    // result.detail is an untranslated detector string that restates the
    // status, so unrecognized paths explain themselves here instead — one
    // sentence, one language, no trailing badge repeating it.
    desc.textContent = result.application
      ? `${result.application.executablePath} · ${result.application.id}`
      : getCustomToolResultStatusText(result);
    text.appendChild(desc);
    row.appendChild(text);

    if (result.application) {
      const status = document.createElement(result.application.added ? "span" : "button");
      status.className = result.application.added
        ? "custom-tool-result-status"
        : "soft-btn accent custom-tool-add";
      status.textContent = result.application.added ? t("customToolAdded") : t("customToolAdd");
      if (!result.application.added) {
        status.type = "button";
        status.addEventListener("click", () => addCustomApplication(result, status));
      }
      row.appendChild(status);
    }
    if (result.path) {
      const removePathButton = document.createElement("button");
      removePathButton.type = "button";
      removePathButton.className = "soft-btn danger custom-tool-remove-path";
      removePathButton.textContent = t("customToolRemovePath");
      removePathButton.addEventListener("click", () => removeCustomDiscoveryPath(result.path, removePathButton));
      row.appendChild(removePathButton);
    }
    return row;
  }

  async function removeCustomDiscoveryPath(pathToRemove, button) {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") return;
    button.disabled = true;
    try {
      const paths = readers.readAgentCustomDiscoveryPaths("custom")
        .filter((entry) => entry !== pathToRemove);
      const response = await window.settingsAPI.command("setAgentCustomDiscoveryPaths", {
        agentId: "custom",
        value: paths,
      });
      if (!response || response.status !== "ok") {
        throw new Error((response && response.message) || "failed to remove discovery path");
      }
      if (ops && typeof ops.fetchAgentInstallationHints === "function") {
        await ops.fetchAgentInstallationHints({ force: true });
      }
      ops.requestRender({ content: true });
    } catch (err) {
      button.disabled = false;
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    }
  }

  async function refreshCustomAgentUi() {
    if (window.settingsAPI && typeof window.settingsAPI.listAgents === "function") {
      const list = await window.settingsAPI.listAgents();
      if (ops && typeof ops.applyAgentMetadata === "function") ops.applyAgentMetadata(list);
      else runtime.agentMetadata = Array.isArray(list) ? list : [];
    }
    if (ops && typeof ops.fetchAgentInstallationHints === "function") {
      await ops.fetchAgentInstallationHints({ force: true });
    }
    ops.requestRender({ content: true });
  }

  async function addCustomApplication(result, button) {
    button.disabled = true;
    try {
      const response = await window.settingsAPI.command("addCustomApplication", { path: result.path });
      if (!response || response.status !== "ok") throw new Error((response && response.message) || "add failed");
      ops.showToast(t("customToolAdded"));
      // The AI is now a connected agent, so land the user where it appears
      // and where its toggles live.
      runtime.agentsSubtab = "connected";
      await refreshCustomAgentUi();
    } catch (err) {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      button.disabled = false;
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
        { id: "keep", label: t("claudeHooksDisableConfirmKeep"), tone: "neutral", defaultFocus: true },
        { id: "disable", label: t("claudeHooksDisableConfirmDisableOnly"), tone: "neutral" },
        { id: "disconnect", label: t("claudeHooksDisableConfirmDisconnect"), tone: "danger" },
      ],
    });
  }

  function showClaudeHooksDisconnectConfirmModal() {
    return helpers.showSettingsConfirmModal({
      title: t("claudeHooksDisconnectConfirmTitle"),
      detail: t("claudeHooksDisconnectConfirmDetail"),
      actions: [
        { id: "keep", label: t("claudeHooksDisconnectConfirmKeep"), tone: "neutral", defaultFocus: true },
        { id: "disconnect", label: t("claudeHooksDisconnectConfirmAction"), tone: "danger" },
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
        if (agent.custom) {
          const registrationBadge = document.createElement("span");
          registrationBadge.className = "agent-badge integration custom-registration";
          registrationBadge.textContent = t("customToolRegistered");
          badges.appendChild(registrationBadge);
          // A registered custom AI stays in Connected even when its executable
          // disappears, so the missing binary has to say so on the row itself —
          // it used to be reported by the agent dropping into another section.
          const customHint = getInstallationHint(agent.id, true);
          if (customHint && customHint.detectedInstalled === false) {
            const missingBadge = document.createElement("span");
            missingBadge.className = "agent-badge custom-missing";
            missingBadge.textContent = t("customToolDetectionMissing");
            badges.appendChild(missingBadge);
          }
        } else {
          integrationBadge = document.createElement("span");
          integrationBadge.className = "agent-badge integration";
          badges.appendChild(integrationBadge);
        }
        if (agent.capabilities && agent.capabilities.permissionApproval) {
          const permBadge = document.createElement("span");
          permBadge.className = "agent-badge accent";
          permBadge.textContent = t("badgePermissionBubble");
          badges.appendChild(permBadge);
        }
        if (!agent.custom) syncAgentIntegrationBadge(integrationBadge, agent.id);
        text.appendChild(badges);
        // TraeCode requires a manual enable step inside Trae that Clawd cannot
        // do for the user — surface it right on the card once the integration
        // is installed so nobody installs it and sees "nothing happens".
        if (!agent.custom && agent.id === "traecode" && readers.readAgentIntegrationInstalled(agent.id)) {
          const hint = document.createElement("div");
          hint.className = "row-desc agent-traecode-hint";
          hint.textContent = t("traecodeEnableHint");
          text.appendChild(hint);
        }
      },
      buildExtraControls: (ctrl) => {
        if (agent.custom) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "soft-btn danger custom-agent-remove";
          button.textContent = t("customToolRemove");
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              const result = await window.settingsAPI.command("removeCustomApplication", { id: agent.id });
              if (!result || result.status !== "ok") throw new Error((result && result.message) || "remove failed");
              await refreshCustomAgentUi();
            } catch (err) {
              ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
              button.disabled = false;
            }
          });
          ctrl.appendChild(button);
          return;
        }
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
    if (agent.custom) {
      const payloadExample = JSON.stringify({
        agent_id: agent.id,
        session_id: "your-session-id",
        state: "working",
        event: "PreToolUse",
      });
      const lastStateEvent = agent.lastStateEvent && Number.isFinite(agent.lastStateEvent.timestamp)
        ? agent.lastStateEvent
        : null;
      const activityText = formatCustomAgentActivity(lastStateEvent);
      for (const [labelKey, value] of [
        ["customAgentRegisteredDesc", t("customAgentRegisteredExternal")],
        ["customToolAgentId", agent.id],
        ["customAgentStateEndpoint", agent.stateEndpoint || "http://127.0.0.1:<runtime-port>/state"],
        ["customAgentPayloadExample", payloadExample],
        ["customAgentActivity", activityText],
        ["customToolExecutable", agent.executablePath],
        ["customToolSourcePath", agent.sourcePath],
      ]) {
        const row = document.createElement("div");
        row.className = "row row-sub custom-agent-detail";
        const text = document.createElement("div");
        text.className = "row-text";
        const label = document.createElement("span");
        label.className = "row-label";
        label.textContent = t(labelKey);
        const desc = document.createElement("span");
        desc.className = "row-desc";
        if (labelKey === "customAgentPayloadExample") desc.classList.add("custom-agent-payload");
        if (labelKey === "customAgentActivity") {
          desc.classList.add("custom-agent-activity");
          desc.dataset.agentId = agent.id;
        }
        desc.textContent = value || "";
        text.appendChild(label);
        text.appendChild(desc);
        row.appendChild(text);
        if (["customToolAgentId", "customAgentStateEndpoint", "customAgentPayloadExample"].includes(labelKey)) {
          const copyButton = document.createElement("button");
          copyButton.type = "button";
          copyButton.className = "soft-btn custom-agent-copy";
          copyButton.textContent = t("customAgentCopy");
          copyButton.addEventListener("click", async () => {
            try {
              if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
                throw new Error("clipboard unavailable");
              }
              await navigator.clipboard.writeText(value || "");
              ops.showToast(t("customAgentCopied"));
            } catch (err) {
              ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
            }
          });
          row.appendChild(copyButton);
        }
        rows.push(row);
      }
    }
    if (agent.id === "claude-code") {
      rows.push(...buildClaudeHookManagementRows());
      // Quota collection belongs to the provider, not to the ring that draws
      // it. This switch used to sit in General's quota-ring group while Kimi's
      // equivalent sat here, so turning collection off meant a different tab
      // depending on the provider, and no page could answer "who am I reading
      // from". Every provider's collection opt-in now lives on its own card.
      const claudeQuotaRow = helpers.buildSwitchRow({
        key: "claudeQuotaCollectionEnabled",
        labelKey: "rowClaudeQuotaCollection",
        descKey: "rowClaudeQuotaCollectionDesc",
      });
      claudeQuotaRow.classList.add("row-sub");
      rows.push(claudeQuotaRow);
    }
    if (agent.id === "codex") {
      const codexAutoStartRow = helpers.buildSwitchRow({
        key: "autoStartWithCodex",
        labelKey: "rowStartWithCodex",
        descKey: "rowStartWithCodexDesc",
      });
      codexAutoStartRow.classList.add("row-sub");
      rows.push(codexAutoStartRow);
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
    if (agent.id === "kimi-cli") {
      rows.push(buildKimiQuotaCard());
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
    if (caps.httpHook && caps.customPermissionUrl) {
      rows.push(buildAgentTextInputRow({
        agentId: agent.id,
        command: "setAgentCustomPermissionUrl",
        labelKey: "rowCodeBuddyCompatiblePermissionUrl",
        descKey: "rowCodeBuddyCompatiblePermissionUrlDesc",
        placeholderKey: "rowCodeBuddyCompatiblePermissionUrlPlaceholder",
        value: () => readers.readAgentCustomPermissionUrl(agent.id),
      }));
    }
    // WSL instances: show detected agent installations across distros
    rows.push(...buildAgentInstanceRows(agent));
    return rows;
  }

  function kimiQuotaStatusText(status) {
    const stateName = status && status.state;
    if (stateName === "unconfigured") return t("kimiQuotaStatusUnconfigured");
    if (stateName === "configured-disabled") return t("kimiQuotaStatusConfiguredDisabled");
    if (stateName === "agent-disabled") return t("kimiQuotaStatusAgentDisabled");
    if (stateName === "secure-storage-unavailable" || stateName === "credential-unreadable") {
      return t("kimiQuotaStatusSecureStorageUnavailable");
    }
    if (stateName === "refreshing") return t("kimiQuotaStatusRefreshing");
    if (stateName === "fresh" && Number.isFinite(status.lastQuotaCapturedAt)) {
      return t("kimiQuotaStatusFresh").replace(
        "{time}",
        new Date(status.lastQuotaCapturedAt).toLocaleString()
      );
    }
    if (stateName === "ready") return t("kimiQuotaStatusReady");
    if (status && status.reason) {
      return t("kimiQuotaStatusError").replace("{reason}", String(status.reason));
    }
    return t("kimiQuotaStatusLoading");
  }

  function buildKimiQuotaCard() {
    const card = document.createElement("div");
    card.className = "row row-sub kimi-quota-card";

    const heading = document.createElement("div");
    heading.className = "kimi-quota-heading";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("kimiQuotaTitle");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("kimiQuotaDesc");
    heading.appendChild(label);
    heading.appendChild(desc);
    card.appendChild(heading);

    const statusLine = document.createElement("span");
    statusLine.className = "row-desc kimi-quota-status";
    statusLine.textContent = t("kimiQuotaStatusLoading");
    card.appendChild(statusLine);

    function makePasswordInput(onEnter) {
      return helpers.buildTextInput({
        type: "password",
        className: "kimi-quota-key-input",
        placeholder: t("kimiQuotaApiKeyPlaceholder"),
        autocomplete: "new-password",
        spellcheck: false,
        ariaLabel: t("kimiQuotaApiKeyPlaceholder"),
        stopPropagation: true,
        onEnter,
        onInput: (event) => helpers.setTextInputState(event.currentTarget, { invalid: false }),
      });
    }

    function makeConsoleLink() {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "soft-btn quiet kimi-quota-console-link";
      link.textContent = t("kimiQuotaOpenConsole");
      link.addEventListener("click", (event) => {
        event.stopPropagation();
        if (window.settingsAPI && typeof window.settingsAPI.openExternal === "function") {
          window.settingsAPI.openExternal("https://www.kimi.com/code/console");
        }
      });
      return link;
    }

    // ── Unconnected: one input, one primary action, quiet notes. The full
    // safety disclosure stays, but as a footnote instead of a wall above the
    // buttons; the Console link is a quiet link, not a competing button. ──
    const connectSection = document.createElement("div");
    connectSection.className = "kimi-quota-connect";
    connectSection.hidden = true;
    const connectRow = document.createElement("div");
    connectRow.className = "kimi-quota-connect-row";
    const connectInput = makePasswordInput((_event, input) => {
      submitKey(input, (apiKey) => window.settingsAPI.connectKimiQuota(apiKey));
    });
    const connectButton = document.createElement("button");
    connectButton.type = "button";
    connectButton.className = "soft-btn accent settings-button kimi-quota-primary";
    connectButton.textContent = t("kimiQuotaConnect");
    connectRow.appendChild(connectInput);
    connectRow.appendChild(connectButton);
    connectSection.appendChild(connectRow);
    const securityNote = document.createElement("span");
    securityNote.className = "row-desc kimi-quota-note";
    securityNote.textContent = t("kimiQuotaSecurityWarning");
    connectSection.appendChild(securityNote);
    const connectFoot = document.createElement("div");
    connectFoot.className = "kimi-quota-foot";
    const manualNote = document.createElement("span");
    manualNote.className = "row-desc";
    manualNote.textContent = t("kimiQuotaManualOnly");
    connectFoot.appendChild(manualNote);
    connectFoot.appendChild(makeConsoleLink());
    connectSection.appendChild(connectFoot);
    card.appendChild(connectSection);

    // ── Connected: account/status first, one primary action (Refresh, or
    // Reconnect while disconnected). Replace folds away behind a toggle; the
    // destructive/low-frequency actions live below a hairline, each with its
    // consequence spelled out — never beside the primary button. ──
    const manageSection = document.createElement("div");
    manageSection.className = "kimi-quota-manage";
    manageSection.hidden = true;

    const badges = document.createElement("div");
    badges.className = "kimi-quota-badges";
    const connBadge = document.createElement("span");
    connBadge.className = "kimi-quota-badge";
    connBadge.textContent = t("kimiQuotaConnectedBadge");
    const modeBadge = document.createElement("span");
    modeBadge.className = "kimi-quota-badge muted";
    modeBadge.textContent = t("kimiQuotaManualOnlyBadge");
    badges.appendChild(connBadge);
    badges.appendChild(modeBadge);
    manageSection.appendChild(badges);

    const primaryRow = document.createElement("div");
    primaryRow.className = "kimi-quota-primary-row";
    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "soft-btn accent settings-button kimi-quota-primary";
    const replaceToggle = document.createElement("button");
    replaceToggle.type = "button";
    replaceToggle.className = "soft-btn quiet";
    replaceToggle.textContent = t("kimiQuotaReplace");
    primaryRow.appendChild(refreshButton);
    primaryRow.appendChild(replaceToggle);
    manageSection.appendChild(primaryRow);

    const replacePanel = document.createElement("div");
    replacePanel.className = "kimi-quota-replace";
    replacePanel.hidden = true;
    const replaceInput = makePasswordInput((_event, input) => {
      submitKey(input, (apiKey) => window.settingsAPI.connectKimiQuota(apiKey));
    });
    replacePanel.appendChild(replaceInput);
    const replaceActions = document.createElement("div");
    replaceActions.className = "kimi-quota-replace-actions";
    const replaceConfirm = document.createElement("button");
    replaceConfirm.type = "button";
    replaceConfirm.className = "soft-btn accent";
    replaceConfirm.textContent = t("kimiQuotaReplaceConfirm");
    const replaceCancel = document.createElement("button");
    replaceCancel.type = "button";
    replaceCancel.className = "soft-btn quiet";
    replaceCancel.textContent = t("kimiQuotaCancel");
    replaceActions.appendChild(replaceConfirm);
    replaceActions.appendChild(replaceCancel);
    replacePanel.appendChild(replaceActions);
    manageSection.appendChild(replacePanel);

    const dangerZone = document.createElement("div");
    dangerZone.className = "kimi-quota-danger";
    const disconnectRow = document.createElement("div");
    disconnectRow.className = "kimi-quota-danger-row";
    const disconnectButton = document.createElement("button");
    disconnectButton.type = "button";
    disconnectButton.className = "soft-btn";
    disconnectButton.textContent = t("kimiQuotaDisconnect");
    const disconnectDesc = document.createElement("span");
    disconnectDesc.className = "row-desc kimi-quota-danger-desc";
    disconnectDesc.textContent = t("kimiQuotaDisconnectDesc");
    disconnectRow.appendChild(disconnectButton);
    disconnectRow.appendChild(disconnectDesc);
    dangerZone.appendChild(disconnectRow);
    const forgetRow = document.createElement("div");
    forgetRow.className = "kimi-quota-danger-row";
    const forgetButton = document.createElement("button");
    forgetButton.type = "button";
    forgetButton.className = "soft-btn danger";
    forgetButton.textContent = t("kimiQuotaForgetLocal");
    const forgetDesc = document.createElement("span");
    forgetDesc.className = "row-desc kimi-quota-danger-desc";
    forgetDesc.textContent = t("kimiQuotaForgetDesc");
    forgetRow.appendChild(forgetButton);
    forgetRow.appendChild(forgetDesc);
    dangerZone.appendChild(forgetRow);
    const revokeLine = document.createElement("div");
    revokeLine.className = "kimi-quota-foot";
    const revokeNote = document.createElement("span");
    revokeNote.className = "row-desc kimi-quota-revoke-note";
    revokeNote.textContent = t("kimiQuotaRevokeNote");
    revokeLine.appendChild(revokeNote);
    revokeLine.appendChild(makeConsoleLink());
    dangerZone.appendChild(revokeLine);
    manageSection.appendChild(dangerZone);
    card.appendChild(manageSection);

    let currentStatus = null;
    let statusLoaded = false;
    let busy = false;
    let replaceOpen = false;

    function setReplaceOpen(open) {
      replaceOpen = open;
      replacePanel.hidden = !open;
      replaceToggle.disabled = busy || open;
      if (!open) replaceInput.value = "";
    }

    function syncControls() {
      const configured = !!(currentStatus && currentStatus.configured);
      const decryptable = !!(currentStatus && currentStatus.decryptable);
      const collectionEnabled = !!(currentStatus && currentStatus.collectionEnabled);
      const agentEnabled = !currentStatus || currentStatus.agentEnabled !== false;

      // No flash of the wrong view: both sections stay hidden until the first
      // status read, and the connect card never shows a status line.
      connectSection.hidden = !statusLoaded || configured;
      manageSection.hidden = !statusLoaded || !configured;
      statusLine.hidden = statusLoaded && !configured && !busy;

      // The single primary action: Refresh while connected, Reconnect with
      // the stored key while disconnected. Reconnect/Refresh both stay
      // manual-only user actions, exactly like Connect.
      refreshButton.textContent = t(collectionEnabled ? "kimiQuotaRefresh" : "kimiQuotaReconnect");
      refreshButton.disabled = busy || !decryptable || (collectionEnabled && !agentEnabled);
      connectButton.disabled = busy;
      helpers.setTextInputState(connectInput, { pending: busy });
      helpers.setTextInputState(replaceInput, { pending: busy });
      replaceConfirm.disabled = busy;
      replaceCancel.disabled = busy;
      replaceToggle.disabled = busy || replaceOpen;
      replacePanel.hidden = !replaceOpen;
      disconnectRow.hidden = !collectionEnabled;
      disconnectButton.disabled = busy;
      // Forget is only legal once collection is off (the runtime enforces
      // "disconnect-required"); the disabled state plus its desc says so.
      forgetButton.disabled = busy || collectionEnabled;
      statusLine.textContent = busy
        ? t("kimiQuotaStatusRefreshing")
        : kimiQuotaStatusText(currentStatus);
    }

    async function reloadStatus() {
      if (!window.settingsAPI || typeof window.settingsAPI.getKimiQuotaStatus !== "function") {
        currentStatus = { status: "error", reason: "runtime-unavailable" };
      } else {
        try { currentStatus = await window.settingsAPI.getKimiQuotaStatus(); }
        catch { currentStatus = { status: "error", reason: "runtime-unavailable" }; }
      }
      statusLoaded = true;
      if (card.isConnected === false) return;
      syncControls();
    }

    async function runAction(invoke) {
      if (busy) return;
      busy = true;
      setReplaceOpen(false);
      syncControls();
      let result;
      try { result = await invoke(); }
      catch { result = { status: "error", reason: "runtime-unavailable" }; }
      busy = false;
      await reloadStatus();
      if (!result || result.status !== "ok") {
        const reason = (result && (result.reason || result.message)) || "unknown-error";
        ops.showToast(t("kimiQuotaStatusError").replace("{reason}", reason), { error: true });
      }
      return result;
    }

    function submitKey(input, invoke) {
      const apiKey = input.value;
      input.value = "";
      if (!apiKey) {
        helpers.setTextInputState(input, { invalid: true });
        input.focus();
        ops.showToast(t("kimiQuotaKeyRequired"), { error: true });
        return;
      }
      runAction(() => invoke(apiKey));
    }

    connectButton.addEventListener("click", (event) => {
      event.stopPropagation();
      submitKey(connectInput, (apiKey) => window.settingsAPI.connectKimiQuota(apiKey));
    });
    refreshButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const collectionEnabled = !!(currentStatus && currentStatus.collectionEnabled);
      runAction(() => (collectionEnabled
        ? window.settingsAPI.refreshKimiQuota()
        : window.settingsAPI.reconnectKimiQuota()));
    });
    replaceToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setReplaceOpen(true);
    });
    replaceCancel.addEventListener("click", (event) => {
      event.stopPropagation();
      setReplaceOpen(false);
    });
    replaceConfirm.addEventListener("click", (event) => {
      event.stopPropagation();
      submitKey(replaceInput, (apiKey) => window.settingsAPI.connectKimiQuota(apiKey));
    });
    disconnectButton.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(() => window.settingsAPI.disconnectKimiQuota());
    });
    forgetButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (typeof window.confirm === "function" && !window.confirm(t("kimiQuotaForgetConfirm"))) return;
      runAction(() => window.settingsAPI.forgetKimiQuotaCredential());
    });
    syncControls();
    void reloadStatus();
    return card;
  }

  function formatCustomAgentActivity(lastStateEvent) {
    return lastStateEvent && Number.isFinite(lastStateEvent.timestamp)
      ? t("customAgentLastState")
        .replace("{event}", lastStateEvent.eventType || "state")
        .replace("{time}", new Date(lastStateEvent.timestamp).toLocaleTimeString())
      : t("customAgentWaiting");
  }

  function applyAgentActivity(payload) {
    if (
      !payload
      || typeof payload.agentId !== "string"
      || !Number.isFinite(payload.timestamp)
    ) return false;
    const index = (runtime.agentMetadata || []).findIndex((agent) => (
      agent && agent.custom === true && agent.id === payload.agentId
    ));
    if (index < 0) return false;
    const lastStateEvent = {
      timestamp: payload.timestamp,
      eventType: typeof payload.eventType === "string" ? payload.eventType : null,
    };
    runtime.agentMetadata[index] = {
      ...runtime.agentMetadata[index],
      lastStateEvent,
    };
    if (state.activeTab !== "agents") return true;
    const content = document.getElementById("content");
    if (!content || typeof content.querySelectorAll !== "function") return true;
    for (const element of content.querySelectorAll(".custom-agent-activity")) {
      if (element.dataset && element.dataset.agentId === payload.agentId) {
        element.textContent = formatCustomAgentActivity(lastStateEvent);
      }
    }
    return true;
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

    const hasIntegrationEvidence = Object.prototype.hasOwnProperty.call(
      wslEntry,
      "integrationFilesPresent"
    );

    function refreshWslHints() {
      if (typeof ops.fetchAgentInstallationHints !== "function") return;
      ops.fetchAgentInstallationHints({ refreshWsl: true }).then(() => {
        ops.requestRender({ content: true });
      }).catch(() => {
        // DOM may be torn down if the user navigated away before refresh.
      });
    }

    // Distro-level marker: hook files are present AND claude-code's
    // settings.json references them (hooksDeployed = DEPFILE && DEPREG).
    // Not per-agent pairing truth — that would require inspecting each
    // agent's config inside WSL — but enough to show Pair took effect and
    // to go dark after a claude-code Unpair.
    if (!hasIntegrationEvidence && wslEntry.hooksDeployed) {
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
            const warnings = [];
            if (typeof result.warning === "string" && result.warning) warnings.push(result.warning);
            if (result.wslConnectivity === false) {
              // Hooks installed, but the distro cannot reach Clawd (NAT
              // networking) — sessions would silently never appear.
              warnings.push(t("agentInstancePairedNoConnectivity"));
            }
            if (warnings.length) {
              ops.showToast(warnings.join("\n"), { error: true });
            } else {
              ops.showToast(result.message || t("agentInstancePaired"));
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
        // Refresh after both success and failure: an installer can leave
        // managed files that the user must be able to Unpair/repair.
        refreshWslHints();
        button.disabled = false;
        button.textContent = t("agentInstancePair");
      }
    });
    ctrl.appendChild(button);

    // Asset-backed integrations provide per-agent cleanup evidence. Only
    // legacy persistent-hook agents fall back to the distro-level shared
    // hooksFilesPresent marker; an explicit false/null must never inherit a
    // Claude pairing and expose a fake Unpair action.
    const canUnpair = hasIntegrationEvidence
      ? wslEntry.integrationFilesPresent === true
      : wslEntry.hooksFilesPresent === true;
    if (canUnpair) {
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
              ops.showToast(
                result.warning || result.message || t("agentInstanceUnpaired"),
                result.warning ? { error: true } : undefined
              );
            } else {
              ops.showToast((result && result.message) || "WSL unpair failed", { error: true });
            }
          }
        } catch (err) {
          ops.showToast(String(err && err.message ? err.message : err), { error: true });
        } finally {
          refreshWslHints();
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

  function buildAgentTextInputRow({
    agentId,
    command,
    labelKey,
    descKey,
    placeholderKey,
    value,
  }) {
    const rowParts = helpers.buildSettingRow({
      labelKey,
      descriptionKey: descKey,
      className: "row-sub agent-text-input-row",
      controlClassName: "agent-text-input-control",
    });
    const row = rowParts.element;
    const ctrl = rowParts.controlElement;
    const input = helpers.buildTextInput({
      type: "text",
      value: typeof value === "function" ? value() : "",
      placeholder: t(placeholderKey),
      spellcheck: false,
      labelledBy: rowParts.labelElement.id,
      describedBy: rowParts.descriptionElement ? rowParts.descriptionElement.id : null,
      stopPropagation: true,
      onEnter: () => input.blur(),
      onInput: (event) => helpers.setTextInputState(event.currentTarget, { invalid: false }),
    });
    input.addEventListener("change", () => {
      saveAgentTextInput(input, { agentId, command });
    });
    ctrl.appendChild(input);
    row._settingsInput = input;
    row._settingsControl = ctrl;
    return row;
  }

  async function saveAgentTextInput(input, { agentId, command }) {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return { status: "error", message: "settings API unavailable" };
    }
    const nextValue = input.value;
    helpers.setTextInputState(input, { pending: true });
    try {
      const result = await window.settingsAPI.command(command, {
        agentId,
        value: nextValue,
      });
      if (!result || result.status !== "ok") {
        const msg = (result && result.message) || "unknown error";
        helpers.setTextInputState(input, { invalid: true });
        input.focus();
        ops.showToast(t("toastSaveFailed") + msg, { error: true });
        return result || { status: "error", message: msg };
      }
      helpers.setTextInputState(input, { invalid: false });
      ops.showToast(t("toastAgentCustomSaved"));
      if (command === "setAgentCustomDiscoveryPaths" && typeof ops.fetchAgentInstallationHints === "function") {
        await ops.fetchAgentInstallationHints({ force: true });
      }
      return result;
    } catch (err) {
      helpers.setTextInputState(input, { invalid: true });
      input.focus();
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      return { status: "error", message: err && err.message };
    } finally {
      helpers.setTextInputState(input, { pending: false });
    }
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
      applyAgentActivity,
    };
  }

  root.ClawdSettingsTabAgents = { init };
})(globalThis);
