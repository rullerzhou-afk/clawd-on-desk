"use strict";

(function initSettingsTabMobile(root) {
  const MOBILE_INFO_RETRY_MS = 200;
  const MOBILE_INFO_MAX_RETRIES = 10;

  let runtime = null;
  let helpers = null;
  let state = null;
  let infoContainer = null;
  let permissionPreviewRow = null;
  let changeListenerRegistered = false;

  function t(key) {
    return helpers.t(key);
  }

  function escapeHtml(str) {
    return helpers.escapeHtml(str);
  }

  function fetchMobileInfo() {
    if (!window.settingsAPI || typeof window.settingsAPI.getMobileConnectionInfo !== "function") {
      return Promise.resolve(null);
    }
    return window.settingsAPI.getMobileConnectionInfo().catch(() => null);
  }

  function isReadyMobileInfo(info) {
    return !!(
      info
      && info.status === "ok"
      && Number.isInteger(info.port)
      && info.port > 0
      && typeof info.token === "string"
      && info.token
      && typeof info.lanIp === "string"
      && info.lanIp
    );
  }

  function renderConnectionInfo(container, attempt = 0) {
    container.innerHTML = "";
    const snapshot = (state && state.snapshot) || {};
    const enabled = snapshot.mobilePreviewEnabled === true;
    if (!enabled) {
      container.innerHTML = `<p class="mobile-info-loading">${escapeHtml(t("mobileDisabled") || "Enable the toggle above to start the LAN bridge.")}</p>`;
      return;
    }

    container.innerHTML = `<div class="mobile-info-loading">${escapeHtml(t("mobileLoading") || "Loading...")}</div>`;

    fetchMobileInfo().then((info) => {
      if (!container.parentNode) return;
      if (!isReadyMobileInfo(info)) {
        if (
          attempt < MOBILE_INFO_MAX_RETRIES
          && info
          && (info.status === "starting" || info.status === "ok")
        ) {
          setTimeout(() => {
            if (container.parentNode) renderConnectionInfo(container, attempt + 1);
          }, MOBILE_INFO_RETRY_MS);
          return;
        }
        container.innerHTML = `<p class="mobile-info-error">${escapeHtml(t("mobileError") || "Unable to load connection info.")}</p>`;
        return;
      }

      let html = '';

      // Connection details
      html += '<div class="mobile-conn-details">';
      html += `<div class="mobile-conn-row"><span class="mobile-conn-label">LAN IP</span><span class="mobile-conn-value">${escapeHtml(info.lanIp)}</span>`;
      html += `<button class="mobile-copy-btn" data-copy="${escapeHtml(info.lanIp)}">Copy</button></div>`;
      html += `<div class="mobile-conn-row"><span class="mobile-conn-label">Port</span><span class="mobile-conn-value">${info.port}</span>`;
      html += `<button class="mobile-copy-btn" data-copy="${String(info.port)}">Copy</button></div>`;
      html += `<div class="mobile-conn-row"><span class="mobile-conn-label">Token</span><span class="mobile-conn-value mobile-token">${escapeHtml(info.token)}</span>`;
      html += `<button class="mobile-copy-btn" data-copy="${escapeHtml(info.token)}">Copy</button></div>`;

      // Pair URL
      if (info.pairUrl) {
        html += `<div class="mobile-conn-row"><span class="mobile-conn-label">URL</span><span class="mobile-conn-value mobile-pair-url">${escapeHtml(info.pairUrl)}</span>`;
        html += `<button class="mobile-copy-btn" data-copy="${escapeHtml(info.pairUrl)}">Copy</button></div>`;
      }

      html += '</div>';

      // Action buttons
      html += '<div class="mobile-conn-actions">';
      html += `<button class="mobile-action-btn" id="mobile-regenerate-btn">${escapeHtml(t("mobileRegenerate") || "Regenerate Token")}</button>`;
      html += `<button class="mobile-action-btn mobile-action-danger" id="mobile-reset-btn">${escapeHtml(t("mobileReset") || "Reset Mobile Access")}</button>`;
      html += '</div>';

      container.innerHTML = html;

      // Copy button handlers
      container.querySelectorAll(".mobile-copy-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const text = btn.getAttribute("data-copy");
          if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
              btn.textContent = "Copied!";
              setTimeout(() => { btn.textContent = "Copy"; }, 1500);
            });
          }
        });
      });

      // Regenerate button handler
      var regenBtn = container.querySelector("#mobile-regenerate-btn");
      if (regenBtn) {
        regenBtn.addEventListener("click", function() {
          var confirmMsg = t("mobileRegenerateConfirm") || "Regenerate token? All connected devices will be disconnected and will need to re-pair.";
          if (!window.confirm(confirmMsg)) return;
          if (!window.settingsAPI || typeof window.settingsAPI.regenerateMobileToken !== "function") return;
          window.settingsAPI.regenerateMobileToken().then(function(result) {
            if (result && result.status === "ok") {
              renderConnectionInfo(container);
            }
          });
        });
      }

      // Reset button handler
      var resetBtn = container.querySelector("#mobile-reset-btn");
      if (resetBtn) {
        resetBtn.addEventListener("click", function() {
          var confirmMsg = t("mobileResetConfirm") || "Reset mobile access? All connected devices will be disconnected and a new token will be generated.";
          if (!window.confirm(confirmMsg)) return;
          if (!window.settingsAPI || typeof window.settingsAPI.resetMobileAccess !== "function") return;
          window.settingsAPI.resetMobileAccess().then(function(result) {
            if (result && result.status === "ok") {
              renderConnectionInfo(container);
            }
          });
        });
      }
    });
  }

  // Body of the "Mobile Web" channel card inside the Remote Approval tab
  // (the card frame — header, status badge, collapse — is built by
  // settings-tab-telegram-approval.js next to the other channels).
  function renderChannelBody(container) {
    const section = document.createElement("div");
    section.className = "settings-tab-section";

    const desc = document.createElement("p");
    desc.className = "settings-tab-desc";
    desc.textContent = t("mobileDesc") || "Connect your phone to monitor sessions remotely.";
    section.appendChild(desc);

    // Enable toggle
    section.appendChild(helpers.buildSwitchRow({
      key: "mobilePreviewEnabled",
      labelKey: "mobileToggle",
      descKey: "mobileToggleDesc",
    }));

    const parentEnabled = !!(state.snapshot && state.snapshot.mobilePreviewEnabled === true);
    permissionPreviewRow = helpers.buildSwitchRow({
      key: "mobilePermissionPreviewEnabled",
      labelKey: "mobilePermissionToggle",
      descKey: "mobilePermissionToggleDesc",
      disabled: !parentEnabled,
      onToggle: function({ nextRaw }) {
        if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
          return Promise.resolve({ status: "error", message: "Settings command API unavailable" });
        }
        if (!nextRaw) {
          return window.settingsAPI.command("setMobilePermissionPreviewEnabled", {
            enabled: false,
            confirmed: false,
            resetAccess: false,
          });
        }
        return helpers.showSettingsDialog({
          title: t("mobilePermissionConsentTitle"),
          detail: t("mobilePermissionConsentDetail"),
          iconText: "!",
          dismissOnBackdrop: false,
          actions: [
            { id: "reset", label: t("mobilePermissionConsentReset"), tone: "accent", defaultFocus: true },
            { id: "keep", label: t("mobilePermissionConsentKeep"), tone: "neutral" },
            { id: "cancel", label: t("cancel"), tone: "neutral" },
          ],
        }).then(function(choice) {
          if (choice !== "reset" && choice !== "keep") {
            return { status: "ok", noop: true };
          }
          return window.settingsAPI.command("setMobilePermissionPreviewEnabled", {
            enabled: true,
            confirmed: true,
            resetAccess: choice === "reset",
          }).then(function(result) {
            // Token reset is an irreversible pre-commit phase. Even if the
            // later preference write fails (and no settings change event is
            // emitted), immediately replace the stale QR/URL/token display.
            if (result && result.tokenReset === true && infoContainer) {
              renderConnectionInfo(infoContainer);
            }
            if (result && result.status !== "ok" && result.tokenReset && result.rePairRequired) {
              return Object.assign({}, result, {
                message: (t("mobilePermissionTokenResetFailure") || "The token was reset, but enabling failed. Re-pair devices. ")
                  + ((result && result.message) ? ` ${result.message}` : ""),
              });
            }
            return result;
          });
        });
      },
    });
    section.appendChild(permissionPreviewRow);

    const disclosure = document.createElement("p");
    disclosure.className = "settings-tab-desc mobile-permission-disclosure";
    disclosure.textContent = t("mobilePermissionDisclosure");
    section.appendChild(disclosure);

    // Connection info (re-renders on toggle)
    infoContainer = document.createElement("div");
    infoContainer.id = "mobile-connection-info";
    section.appendChild(infoContainer);

    container.appendChild(section);

    renderConnectionInfo(infoContainer);

    // Re-render connection info when toggle changes
    if (!changeListenerRegistered && window.settingsAPI && typeof window.settingsAPI.onChanged === "function") {
      changeListenerRegistered = true;
      window.settingsAPI.onChanged((evt) => {
        if (evt && evt.changes && Object.prototype.hasOwnProperty.call(evt.changes, "mobilePreviewEnabled")) {
          if (infoContainer) renderConnectionInfo(infoContainer);
          const parentOn = !!(evt.snapshot && evt.snapshot.mobilePreviewEnabled === true);
          const sw = permissionPreviewRow && permissionPreviewRow.querySelector(".switch");
          if (sw) {
            sw.classList.toggle("disabled", !parentOn);
            sw.setAttribute("aria-disabled", parentOn ? "false" : "true");
            sw.tabIndex = parentOn ? 0 : -1;
          }
        }
      });
    }
  }

  function init(core) {
    runtime = core.runtime;
    helpers = core.helpers;
    state = core.state;
    // No standalone tab registration: mobile renders as a channel card body
    // inside the Remote Approval tab.
  }

  root.ClawdSettingsTabMobile = { init, renderChannelBody };
})(globalThis);
