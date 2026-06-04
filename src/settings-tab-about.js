"use strict";

(function initSettingsTabAbout(root) {
  let runtime = null;
  let helpers = null;
  let ops = null;
  let i18n = null;

  function t(key) {
    return helpers.t(key);
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
    wrap.className = "about-cleanup-wrap";
    const button = document.createElement("button");
    button.className = "about-cleanup-button";
    button.type = "button";
    button.textContent = t("aboutCleanupButton");
    const status = document.createElement("div");
    status.className = "about-cleanup-status";

    button.addEventListener("click", () => {
      if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") return;
      if (typeof window.confirm !== "function") {
        status.textContent = t("aboutCleanupFailed");
        return;
      }
      if (!window.confirm(t("aboutCleanupConfirm"))) return;
      button.disabled = true;
      button.textContent = t("aboutCleanupRunning");
      status.textContent = "";
      window.settingsAPI.command("cleanupIntegrations")
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
        .finally(() => {
          button.disabled = false;
          button.textContent = t("aboutCleanupButton");
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
        hint.textContent = "· " + t("aboutUpdateAvailableHint").replace("{version}", safe.pendingUpdateVersion);
        hint.style.cursor = "pointer";
        hint.addEventListener("click", () => {
          if (!window.settingsAPI || typeof window.settingsAPI.checkForUpdates !== "function") return;
          window.settingsAPI.checkForUpdates().catch(() => {});
        });
        vvWrap.appendChild(hint);
      }
      const updateBtn = document.createElement("button");
      updateBtn.className = "about-check-update-btn";
      updateBtn.textContent = t("aboutCheckForUpdates");
      updateBtn.addEventListener("click", () => {
        if (!window.settingsAPI || typeof window.settingsAPI.checkForUpdates !== "function") return;
        updateBtn.disabled = true;
        window.settingsAPI.checkForUpdates()
          .catch(() => {})
          .finally(() => { updateBtn.disabled = false; });
      });
      vvWrap.appendChild(updateBtn);
      versionRow.appendChild(vl);
      versionRow.appendChild(vvWrap);
      infoSection.appendChild(versionRow);

      const autoUpdateRow = document.createElement("div");
      autoUpdateRow.className = "about-info-row";
      const autoUpdateLabelWrap = document.createElement("div");
      autoUpdateLabelWrap.className = "about-info-label";
      const autoUpdateLabel = document.createElement("div");
      autoUpdateLabel.textContent = t("autoUpdateCheck");
      const autoUpdateDesc = document.createElement("div");
      autoUpdateDesc.className = "about-info-description";
      autoUpdateDesc.textContent = t("autoUpdateCheckDescription");
      autoUpdateDesc.style.opacity = "0.7";
      autoUpdateDesc.style.fontSize = "12px";
      autoUpdateLabelWrap.appendChild(autoUpdateLabel);
      autoUpdateLabelWrap.appendChild(autoUpdateDesc);
      const autoUpdateValue = document.createElement("div");
      autoUpdateValue.className = "about-info-value";
      const autoUpdateBox = document.createElement("input");
      autoUpdateBox.type = "checkbox";
      autoUpdateBox.checked = safe.autoUpdateCheck !== false;
      autoUpdateBox.addEventListener("change", () => {
        if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") return;
        window.settingsAPI.update("autoUpdateCheck", autoUpdateBox.checked).catch(() => {});
      });
      autoUpdateValue.appendChild(autoUpdateBox);
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
    runtime = core.runtime;
    helpers = core.helpers;
    ops = core.ops;
    i18n = core.i18n;
    core.tabs.about = {
      render,
    };
  }

  root.ClawdSettingsTabAbout = { init };
})(globalThis);
