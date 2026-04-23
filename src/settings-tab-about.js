"use strict";

(function initSettingsTabAbout(root) {
  let runtime = null;
  let helpers = null;
  let ops = null;
  let i18n = null;

  function t(key) {
    return helpers.t(key);
  }

  function fetchAboutInfo() {
    if (runtime.about.infoCache) return Promise.resolve(runtime.about.infoCache);
    if (!window.settingsAPI || typeof window.settingsAPI.getAboutInfo !== "function") {
      return Promise.resolve(null);
    }
    return window.settingsAPI.getAboutInfo().then((info) => {
      runtime.about.infoCache = info;
      return info;
    }).catch(() => null);
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

    const contribRow = document.createElement("div");
    contribRow.className = "about-info-row";
    const contribLabel = document.createElement("div");
    contribLabel.className = "about-info-label";
    contribLabel.textContent = t("aboutContributorsLabel") + " (" + i18n.CONTRIBUTORS.length + ")";
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "about-contributors-toggle";
    toggleBtn.textContent = runtime.about.contributorsExpanded ? t("aboutContributorsHide") : t("aboutContributorsShowAll");
    contribRow.appendChild(contribLabel);
    contribRow.appendChild(toggleBtn);

    const contribList = document.createElement("div");
    contribList.className = "about-contributors-list" + (runtime.about.contributorsExpanded ? "" : " collapsed");
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

    toggleBtn.addEventListener("click", () => {
      runtime.about.contributorsExpanded = !runtime.about.contributorsExpanded;
      contribList.classList.toggle("collapsed", !runtime.about.contributorsExpanded);
      toggleBtn.textContent = runtime.about.contributorsExpanded
        ? t("aboutContributorsHide")
        : t("aboutContributorsShowAll");
    });

    const footer = document.createElement("div");
    footer.className = "about-footer";
    footer.textContent = t("aboutFooter");
    parent.appendChild(footer);

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
      vvWrap.appendChild(vv);
      vvWrap.appendChild(updateBtn);
      versionRow.appendChild(vl);
      versionRow.appendChild(vvWrap);
      infoSection.appendChild(versionRow);

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
