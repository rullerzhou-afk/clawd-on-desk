"use strict";

(function initSettingsTabAbout(root) {
  let state = null;
  let runtime = null;
  let helpers = null;
  let ops = null;
  let i18n = null;

  // Contributors who are credited but whose GitHub account no longer resolves, so
  // https://github.com/<name> would 404. tomaioo authored the Linux Electron sandbox
  // gate (commit 2cab204e, shipped via the now-deleted PR #168) and the account was
  // removed afterwards — lookup by login and by numeric id both 404, so it is gone
  // rather than renamed. The contribution still ships in hooks/shared-process.js.
  const NO_GITHUB_ACCOUNT = new Set(["tomaioo"]);

  function t(key) {
    return helpers.t(key);
  }

  function formatVersionForMessage(version) {
    return String(version || "").replace(/^v/i, "");
  }

  function normalizeUpdateCheckSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return { state: "idle" };
    const allowed = new Set(["idle", "checking", "up-to-date", "available", "downloading", "ready", "error"]);
    return {
      ...snapshot,
      state: allowed.has(snapshot.state) ? snapshot.state : "idle",
    };
  }

  function buildUpdateErrorCard(report, onClose) {
    const card = document.createElement("div");
    card.className = "about-update-error-card";
    card.setAttribute("role", "alert");

    const header = document.createElement("div");
    header.className = "about-update-error-header";
    const title = document.createElement("div");
    title.className = "about-update-error-title";
    title.textContent = report.title || t("aboutUpdateErrorTitle");
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "about-update-error-close";
    closeButton.textContent = "×";
    closeButton.title = t("aboutUpdateErrorClose");
    closeButton.setAttribute("aria-label", t("aboutUpdateErrorClose"));
    closeButton.addEventListener("click", onClose);
    header.appendChild(title);
    header.appendChild(closeButton);
    card.appendChild(header);

    const message = document.createElement("div");
    message.className = "about-update-error-message";
    message.textContent = report.message || t("aboutUpdateErrorFallback");
    card.appendChild(message);

    if (report.nextStep) {
      const nextStep = document.createElement("div");
      nextStep.className = "about-update-error-next";
      const nextLabel = document.createElement("strong");
      nextLabel.textContent = t("aboutUpdateErrorNextStep") + " ";
      nextStep.appendChild(nextLabel);
      const nextText = document.createElement("span");
      nextText.textContent = report.nextStep;
      nextStep.appendChild(nextText);
      card.appendChild(nextStep);
    }

    const details = document.createElement("div");
    details.className = "about-update-error-details";
    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "about-update-error-details-trigger";
    summary.appendChild(helpers.createDisclosureChevron("about-update-error-chevron"));
    const summaryLabel = document.createElement("span");
    summaryLabel.textContent = t("aboutUpdateErrorDetails");
    summary.appendChild(summaryLabel);
    const body = document.createElement("div");
    body.className = "about-update-error-details-body settings-disclosure-body";
    const bodyInner = document.createElement("div");
    bodyInner.className = "about-update-error-details-inner settings-disclosure-body-inner";
    const technical = document.createElement("pre");
    technical.textContent = [
      report.code ? `${t("aboutUpdateErrorCode")}: ${report.code}` : "",
      report.phase ? `${t("aboutUpdateErrorPhase")}: ${report.phase}` : "",
      report.detail || "",
    ].filter(Boolean).join("\n");
    bodyInner.appendChild(technical);
    body.appendChild(bodyInner);
    details.appendChild(summary);
    details.appendChild(body);
    state.mountedControls.aboutUpdateErrorDisclosure = helpers.registerMountedDisposable(
      helpers.attachSettingsDisclosure({
        root: details,
        trigger: summary,
        body,
        expanded: false,
      }),
    );
    card.appendChild(details);

    const actions = document.createElement("div");
    actions.className = "about-update-error-actions";
    const copyButton = helpers.buildButton({
      labelKey: "aboutUpdateErrorCopy",
      size: "compact",
      className: "about-update-error-copy",
    });
    copyButton.addEventListener("click", async () => {
      helpers.setButtonState(copyButton, { pending: true });
      try {
        const copy = window.settingsAPI && window.settingsAPI.copyUpdateError;
        if (typeof copy !== "function") throw new Error("clipboard unavailable");
        const result = await copy(String(report.copyText || report.detail || report.message || ""));
        if (!result || result.status !== "ok") throw new Error(result && result.message || "copy failed");
        helpers.setButtonState(copyButton, {
          pending: false,
          labelKey: "aboutUpdateErrorCopied",
        });
      } catch (_) {
        helpers.setButtonState(copyButton, {
          pending: false,
          labelKey: "aboutUpdateErrorCopyFailed",
        });
      }
    });
    actions.appendChild(copyButton);
    card.appendChild(actions);
    return card;
  }

  // #329: getAboutInfo() now returns dynamic fields (pendingUpdateVersion,
  // autoUpdateCheck) alongside the static identity fields. The static
  // parts (heroSvgContent, license, copyright, etc.) are still safe to
  // cache; the dynamic ones must be re-fetched on every render so the
  // pending hint and the auto-update toggle reflect current state after
  // the user flips the toggle or the scheduler discovers a new version.
  const STATIC_ABOUT_KEYS = ["repoUrl", "license", "copyright", "authorName", "authorUrl", "heroSvgContent"];
  function fetchAboutInfo() {
    if (!window.settingsAPI || typeof window.settingsAPI.getAboutInfo !== "function") {
      return Promise.resolve(runtime.about.infoCache || null);
    }
    return window.settingsAPI.getAboutInfo().then((info) => {
      if (!info) return runtime.about.infoCache || null;
      // Preserve any previously cached static field if a future getAboutInfo
      // call ever omits one (defensive). Dynamic fields always come from
      // the fresh response — they are not merged from the old cache.
      const merged = { ...(runtime.about.infoCache || {}) };
      for (const key of STATIC_ABOUT_KEYS) {
        if (info[key] != null) merged[key] = info[key];
      }
      merged.version = info.version;
      merged.pendingUpdateVersion = info.pendingUpdateVersion || "";
      merged.autoUpdateCheck = info.autoUpdateCheck !== false;
      merged.updateCheckSnapshot = normalizeUpdateCheckSnapshot(info.updateCheckSnapshot);
      runtime.about.updateCheckSnapshot = merged.updateCheckSnapshot;
      runtime.about.infoCache = merged;
      return merged;
    }).catch(() => runtime.about.infoCache || null);
  }

  function handleAboutCrabClick(crabWrap) {
    const slot = crabWrap.querySelector("#shake-slot");
    if (slot) {
      slot.classList.remove("shake");
      void slot.getBoundingClientRect();
      slot.classList.add("shake");
      const onEnd = () => {
        slot.classList.remove("shake");
        slot.removeEventListener("animationend", onEnd);
      };
      slot.addEventListener("animationend", onEnd);
    }
    runtime.about.clickCount++;
    if (runtime.about.clickCount >= 7) {
      runtime.about.clickCount = 0;
      ops.showToast(t("aboutEasterEggToast"), { ttl: 5000 });
    }
  }

  function buildAboutLinkRow(label, url, displayText) {
    const row = document.createElement("div");
    row.className = "about-info-row";
    const l = document.createElement("div");
    l.className = "about-info-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "about-info-value";
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = displayText;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      helpers.openExternalSafe(url);
    });
    v.appendChild(a);
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }

  function formatCleanupSummary(result) {
    const summary = result && result.cleanup && result.cleanup.summary;
    if (!summary) return t("aboutCleanupSuccess");
    const failed = Number(summary.failed || 0);
    let text = t("aboutCleanupSuccess")
      .replace("{removed}", String(Number(summary.entriesRemoved || 0)))
      .replace("{affected}", String(Number(summary.agentsAffected || 0)))
      .replace("{failed}", String(failed));
    const hasKiroNote = Array.isArray(result.cleanup.agents)
      && result.cleanup.agents.some((agent) =>
        agent
        && agent.agentId === "kiro-cli"
        && Array.isArray(agent.notes)
        && agent.notes.length > 0
      );
    if (hasKiroNote) text += " " + t("aboutCleanupKiroNote");
    return text;
  }

  function createCleanupFooterAction() {
    const wrap = document.createElement("div");
    wrap.className = "about-footer-action-wrap";
    const button = document.createElement("button");
    button.className = "about-footer-action-button about-cleanup-button";
    button.type = "button";
    button.textContent = t("aboutCleanupButton");
    const status = document.createElement("div");
    status.className = "about-cleanup-status";
    let confirmationPending = false;

    function resetCleanupButton() {
      button.disabled = false;
      button.textContent = t("aboutCleanupButton");
    }

    function runCleanup() {
      button.disabled = true;
      button.textContent = t("aboutCleanupRunning");
      status.textContent = "";
      return Promise.resolve()
        .then(() => window.settingsAPI.command("cleanupIntegrations"))
        .then((result) => {
          if (!result || result.status !== "ok") {
            throw new Error((result && result.message) || t("aboutCleanupFailed"));
          }
          const message = formatCleanupSummary(result);
          status.textContent = message;
          ops.showToast(message, { ttl: 7000 });
        })
        .catch((err) => {
          const message = t("aboutCleanupFailed") + (err && err.message ? ": " + err.message : "");
          status.textContent = message;
          ops.showToast(message, { ttl: 7000 });
        })
        .finally(resetCleanupButton);
    }

    button.addEventListener("click", () => {
      if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") return;
      if (confirmationPending || button.disabled) return;
      if (!helpers || typeof helpers.showSettingsConfirmModal !== "function") {
        status.textContent = t("aboutCleanupFailed");
        return;
      }
      confirmationPending = true;
      Promise.resolve()
        .then(() => helpers.showSettingsConfirmModal({
          title: t("aboutCleanupConfirmTitle"),
          detail: t("aboutCleanupConfirmDetail"),
          actions: [
            { id: "cancel", label: t("aboutCleanupConfirmCancel"), tone: "neutral", defaultFocus: true },
            { id: "confirm", label: t("aboutCleanupConfirmAction"), tone: "danger" },
          ],
        }))
        .then((actionId) => {
          if (actionId !== "confirm") return null;
          return runCleanup();
        })
        .catch((err) => {
          const message = t("aboutCleanupFailed") + (err && err.message ? ": " + err.message : "");
          status.textContent = message;
          ops.showToast(message, { ttl: 7000 });
        })
        .finally(() => {
          confirmationPending = false;
        });
    });

    wrap.appendChild(button);
    wrap.appendChild(status);
    return wrap;
  }

  function render(parent) {
    const hero = document.createElement("div");
    hero.className = "about-hero";

    const crabWrap = document.createElement("div");
    crabWrap.className = "about-crab-wrap";
    crabWrap.title = "Clawd";

    const title = document.createElement("h2");
    title.className = "about-title";
    title.textContent = "Clawd on Desk";

    const tagline = document.createElement("p");
    tagline.className = "about-tagline";
    tagline.textContent = t("aboutTagline");

    hero.appendChild(crabWrap);
    hero.appendChild(title);
    hero.appendChild(tagline);
    parent.appendChild(hero);

    const infoSection = document.createElement("section");
    infoSection.className = "section";
    parent.appendChild(infoSection);

    const maintainersRow = document.createElement("div");
    maintainersRow.className = "about-info-row";
    const maintainersLabel = document.createElement("div");
    maintainersLabel.className = "about-info-label";
    maintainersLabel.textContent = t("aboutMaintainersLabel");
    const maintainersValue = document.createElement("div");
    maintainersValue.className = "about-info-value";
    maintainersValue.style.display = "flex";
    maintainersValue.style.flexWrap = "wrap";
    maintainersValue.style.gap = "12px";
    maintainersValue.style.justifyContent = "flex-end";
    for (const name of i18n.MAINTAINERS) {
      const link = document.createElement("a");
      link.className = "about-contributor-link";
      link.textContent = "@" + name;
      link.href = "#";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        helpers.openExternalSafe("https://github.com/" + name);
      });
      maintainersValue.appendChild(link);
    }
    maintainersRow.appendChild(maintainersLabel);
    maintainersRow.appendChild(maintainersValue);

    const contribRow = document.createElement("div");
    contribRow.className = "about-info-row";
    const contribLabel = document.createElement("div");
    contribLabel.className = "about-info-label";
    contribLabel.textContent = t("aboutContributorsLabel") + " (" + i18n.CONTRIBUTORS.length + ")";
    contribRow.appendChild(contribLabel);

    const contribList = document.createElement("div");
    contribList.className = "about-contributors-list";
    for (const name of i18n.CONTRIBUTORS) {
      // Contributors whose GitHub account no longer resolves keep their credit but
      // get plain text: a link to a deleted account only leads to a 404.
      if (NO_GITHUB_ACCOUNT.has(name)) {
        const plain = document.createElement("span");
        plain.className = "about-contributor-link";
        plain.textContent = "@" + name;
        contribList.appendChild(plain);
        continue;
      }
      const link = document.createElement("a");
      link.className = "about-contributor-link";
      link.textContent = "@" + name;
      link.href = "#";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        helpers.openExternalSafe("https://github.com/" + name);
      });
      contribList.appendChild(link);
    }

    const footer = document.createElement("div");
    footer.className = "about-footer";
    footer.textContent = t("aboutFooter");
    parent.appendChild(footer);
    parent.appendChild(createCleanupFooterAction());

    fetchAboutInfo().then((info) => {
      const safe = info || {};

      if (safe.heroSvgContent) {
        crabWrap.innerHTML = safe.heroSvgContent;
      }
      crabWrap.addEventListener("click", () => handleAboutCrabClick(crabWrap));

      infoSection.innerHTML = "";

      const versionRow = document.createElement("div");
      versionRow.className = "about-info-row";
      const vl = document.createElement("div");
      vl.className = "about-info-label";
      vl.textContent = t("aboutVersionLabel");
      const vvWrap = document.createElement("div");
      vvWrap.style.display = "flex";
      vvWrap.style.alignItems = "center";
      vvWrap.style.gap = "10px";
      const vv = document.createElement("span");
      vv.className = "about-info-value";
      vv.textContent = "v" + (safe.version || "?");
      vvWrap.appendChild(vv);
      if (safe.pendingUpdateVersion) {
        const hint = document.createElement("span");
        hint.className = "about-update-hint";
        hint.textContent = "· " + t("aboutUpdateAvailableHint").replace(
          "{version}",
          formatVersionForMessage(safe.pendingUpdateVersion)
        );
        hint.style.cursor = "pointer";
        hint.addEventListener("click", () => {
          void runUpdateCheck();
        });
        vvWrap.appendChild(hint);
      }
      const updateBtn = document.createElement("button");
      updateBtn.className = "about-check-update-btn";
      const updateStatusHost = document.createElement("div");
      updateStatusHost.className = "about-update-status-host";

      function applyUpdateCheckStatus(snapshot) {
        const normalized = normalizeUpdateCheckSnapshot(snapshot);
        runtime.about.updateCheckSnapshot = normalized;
        const busy = normalized.state === "checking" || normalized.state === "downloading";
        updateBtn.disabled = busy;
        updateBtn.classList.toggle("checking", normalized.state === "checking");
        updateBtn.textContent = normalized.state === "checking"
          ? t("aboutCheckingForUpdates")
          : t("aboutCheckForUpdates");
        helpers.disposeMountedDisposable(state.mountedControls.aboutUpdateErrorDisclosure);
        state.mountedControls.aboutUpdateErrorDisclosure = null;
        updateStatusHost.innerHTML = "";
        if (normalized.state === "error" && normalized.error) {
          updateStatusHost.appendChild(buildUpdateErrorCard(normalized.error, () => {
            const clear = window.settingsAPI && window.settingsAPI.clearUpdateError;
            Promise.resolve(typeof clear === "function" ? clear() : { state: "idle" })
              .then((next) => applyUpdateCheckStatus(next || { state: "idle" }))
              .catch(() => applyUpdateCheckStatus({ state: "idle" }));
          }));
        }
      }

      async function runUpdateCheck() {
        if (!window.settingsAPI || typeof window.settingsAPI.checkForUpdates !== "function") return;
        applyUpdateCheckStatus({ state: "checking" });
        try {
          const result = await window.settingsAPI.checkForUpdates();
          applyUpdateCheckStatus(result);
        } catch (_) {
          applyUpdateCheckStatus(runtime.about.updateCheckSnapshot);
        }
      }
      updateBtn.addEventListener("click", () => { void runUpdateCheck(); });
      vvWrap.appendChild(updateBtn);
      versionRow.appendChild(vl);
      versionRow.appendChild(vvWrap);
      infoSection.appendChild(versionRow);
      infoSection.appendChild(updateStatusHost);
      state.mountedControls.aboutUpdateStatus = {
        element: updateStatusHost,
        apply: applyUpdateCheckStatus,
      };
      applyUpdateCheckStatus(safe.updateCheckSnapshot || runtime.about.updateCheckSnapshot);

      const autoUpdateRow = document.createElement("div");
      autoUpdateRow.className = "about-info-row";
      const autoUpdateLabelWrap = document.createElement("div");
      autoUpdateLabelWrap.className = "about-info-label";
      const autoUpdateLabel = document.createElement("div");
      autoUpdateLabel.id = "settings-about-auto-update-label";
      autoUpdateLabel.textContent = t("autoUpdateCheck");
      const autoUpdateDesc = document.createElement("div");
      autoUpdateDesc.id = "settings-about-auto-update-description";
      autoUpdateDesc.className = "about-info-description";
      autoUpdateDesc.textContent = t("autoUpdateCheckDescription");
      autoUpdateDesc.style.opacity = "0.7";
      autoUpdateDesc.style.fontSize = "12px";
      autoUpdateLabelWrap.appendChild(autoUpdateLabel);
      autoUpdateLabelWrap.appendChild(autoUpdateDesc);
      const autoUpdateValue = document.createElement("div");
      autoUpdateValue.className = "about-info-value";
      let committedAutoUpdate = safe.autoUpdateCheck !== false;
      let autoUpdatePending = false;
      const autoUpdateControl = helpers.buildSwitch({
        checked: committedAutoUpdate,
        ariaLabelledBy: autoUpdateLabel.id,
        ariaDescribedBy: autoUpdateDesc.id,
        className: "about-auto-update-switch",
      });
      const autoUpdateSwitch = autoUpdateControl.element;

      function paintAutoUpdate(value, pending = autoUpdatePending) {
        autoUpdateControl.setState({ checked: value, pending });
      }

      function syncAutoUpdateFromSnapshot() {
        const snapshotHasValue = state.snapshot
          && Object.prototype.hasOwnProperty.call(state.snapshot, "autoUpdateCheck");
        committedAutoUpdate = snapshotHasValue
          ? state.snapshot.autoUpdateCheck !== false
          : runtime.about.infoCache.autoUpdateCheck !== false;
        runtime.about.infoCache.autoUpdateCheck = committedAutoUpdate;
        autoUpdatePending = false;
        paintAutoUpdate(committedAutoUpdate, false);
      }

      function toggleAutoUpdate() {
        if (autoUpdatePending || !window.settingsAPI || typeof window.settingsAPI.update !== "function") return;
        const previous = committedAutoUpdate;
        const next = !committedAutoUpdate;
        committedAutoUpdate = next;
        autoUpdatePending = true;
        runtime.about.infoCache.autoUpdateCheck = next;
        paintAutoUpdate(next, true);
        Promise.resolve(window.settingsAPI.update("autoUpdateCheck", next))
          .then((result) => {
            if (!result || result.status !== "ok") {
              committedAutoUpdate = previous;
              runtime.about.infoCache.autoUpdateCheck = previous;
              ops.showToast((result && result.message) || t("toastSaveFailed"), { error: true });
            }
          })
          .catch((err) => {
            committedAutoUpdate = previous;
            runtime.about.infoCache.autoUpdateCheck = previous;
            const message = err && err.message ? err.message : "unknown error";
            ops.showToast(t("toastSaveFailed") + message, { error: true });
          })
          .finally(() => {
            autoUpdatePending = false;
            if (document.body.contains(autoUpdateSwitch)) paintAutoUpdate(committedAutoUpdate, false);
          });
      }

      autoUpdateControl.setOnToggle(toggleAutoUpdate);
      state.mountedControls.aboutAutoUpdate = {
        control: autoUpdateControl,
        element: autoUpdateSwitch,
        syncFromSnapshot: syncAutoUpdateFromSnapshot,
      };
      paintAutoUpdate(committedAutoUpdate, false);
      autoUpdateValue.appendChild(autoUpdateSwitch);
      autoUpdateRow.appendChild(autoUpdateLabelWrap);
      autoUpdateRow.appendChild(autoUpdateValue);
      infoSection.appendChild(autoUpdateRow);

      if (safe.repoUrl) {
        infoSection.appendChild(buildAboutLinkRow(
          t("aboutRepositoryLabel"),
          safe.repoUrl,
          safe.repoUrl.replace(/^https?:\/\//, "")
        ));
      }

      if (safe.license) {
        const lRow = document.createElement("div");
        lRow.className = "about-info-row";
        const ll = document.createElement("div");
        ll.className = "about-info-label";
        ll.textContent = t("aboutLicenseLabel");
        const lv = document.createElement("div");
        lv.className = "about-info-value";
        lv.textContent = safe.license + (safe.copyright ? " · " + safe.copyright : "");
        lRow.appendChild(ll);
        lRow.appendChild(lv);
        infoSection.appendChild(lRow);
      }

      if (safe.authorName) {
        infoSection.appendChild(buildAboutLinkRow(
          t("aboutAuthorLabel"),
          safe.authorUrl,
          safe.authorName
        ));
      }

      infoSection.appendChild(maintainersRow);
      infoSection.appendChild(contribRow);
      infoSection.appendChild(contribList);
    });
  }

  function init(core) {
    state = core.state;
    runtime = core.runtime;
    helpers = core.helpers;
    ops = core.ops;
    i18n = core.i18n;
    core.tabs.about = {
      render,
      patchInPlace(changes) {
        if (!changes || Object.keys(changes).some((key) => key !== "autoUpdateCheck")) return false;
        if (!Object.prototype.hasOwnProperty.call(changes, "autoUpdateCheck")) return false;
        const control = state.mountedControls.aboutAutoUpdate;
        if (!control || !document.body.contains(control.element)) return false;
        runtime.about.infoCache.autoUpdateCheck = changes.autoUpdateCheck !== false;
        control.syncFromSnapshot();
        return true;
      },
      applyUpdateCheckStatus(snapshot) {
        runtime.about.updateCheckSnapshot = normalizeUpdateCheckSnapshot(snapshot);
        const control = state.mountedControls.aboutUpdateStatus;
        if (!control || !document.body.contains(control.element)) return false;
        control.apply(runtime.about.updateCheckSnapshot);
        return true;
      },
    };
  }

  root.ClawdSettingsTabAbout = { init };
})(globalThis);
