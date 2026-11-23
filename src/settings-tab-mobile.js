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
  let headerStatusIdSeq = 0;
  let pairInfoTimer = null;
  // Ignore late responses after a newer read starts or the info container is replaced.
  let infoRevision = 0;
  // Skip redraws only while this signature is displayed; explicit reloads and errors invalidate it.
  let lastInfo = null;
  let devicesContainer = null;
  let devicesRevision = 0;
  let lastDevices = null;

  function t(key) {
    return helpers.t(key);
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
      && typeof info.lanIp === "string"
      && info.lanIp
    );
  }

  function buildStatusLine(enabled) {
    return helpers.buildStatusLine(enabled
      ? { tone: "ok", text: t("mobileStatusRunning") }
      : { tone: "off", text: t("mobileStatusOff") });
  }

  // Card header for the LAN card: name + Beta tag + status sentence on the
  // left, the mobilePreviewEnabled switch on the right. The switch lives inside
  // the collapsible disclosure area, so clicks must not also fold the card.
  function buildChannelHeaderRow() {
    const enabled = !!(state && state.snapshot && state.snapshot.mobilePreviewEnabled === true);
    const row = helpers.buildSwitchRow({
      key: "mobilePreviewEnabled",
      labelKey: "mobileChannelName",
    });
    row.classList.add("channel-header-row");
    const text = row.querySelector(".row-text");
    const label = text ? text.querySelector(".row-label") : null;
    if (label) {
      const beta = document.createElement("span");
      beta.className = "channel-beta-tag";
      beta.textContent = "Beta";
      label.appendChild(beta);
    }
    if (text) {
      const status = buildStatusLine(enabled);
      const statusText = status.element.querySelector(".settings-status-text");
      if (statusText && !statusText.id) {
        statusText.id = `settings-mobile-status-${++headerStatusIdSeq}`;
      }
      text.appendChild(status.element);
      const sw = row.querySelector(".switch");
      if (sw && statusText) sw.setAttribute("aria-describedby", statusText.id);
    }
    const sw = row.querySelector(".switch");
    if (sw) sw.addEventListener("click", (ev) => ev.stopPropagation());
    return row;
  }

  // One pairing value: label + monospace value + an optional compact Copy button.
  function buildConnectionRow(labelKey, value, valueClass = "", options = {}) {
    const row = document.createElement("div");
    row.className = "row mobile-conn-row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t(labelKey);
    const valueEl = document.createElement("span");
    valueEl.className = ["mobile-conn-value", valueClass].filter(Boolean).join(" ");
    valueEl.textContent = value == null ? "" : String(value);
    text.appendChild(label);
    text.appendChild(valueEl);
    row.appendChild(text);

    if (options.copyable === false) return row;

    const control = document.createElement("div");
    control.className = "row-control";
    const copy = helpers.buildButton({
      labelKey: "mobileCopy",
      size: "compact",
      className: "mobile-copy",
    });
    copy.addEventListener("click", () => {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;
      navigator.clipboard.writeText(String(value == null ? "" : value)).then(() => {
        helpers.setButtonState(copy, { labelKey: "mobileCopied" });
        setTimeout(() => {
          if (copy.isConnected === false) return;
          helpers.setButtonState(copy, { labelKey: "mobileCopy" });
        }, 1500);
      });
    });
    control.appendChild(copy);
    row.appendChild(control);
    return row;
  }

  function showPairingError(result, titleKey) {
    const message = result && result.partialReset
      ? t("mobilePartialResetFailure")
      : (result && result.message) || t("mobileError");
    return helpers.showSettingsDialog({
      title: t(titleKey), detail: message,
      actions: [{ id: "ok", label: t("mobileDismiss"), defaultFocus: true }],
    });
  }

  function deviceStatus(device) {
    if (device.state === "pending") return t("mobileDevicePending");
    const elapsed = Math.max(0, Date.now() - device.lastSeenAt) / 1000;
    const units = [
      [31536000, "year"],
      [2592000, "month"],
      [86400, "day"],
      [3600, "hour"],
      [60, "minute"],
      [1, "second"],
    ];
    const [seconds, unit] = units.find(([size]) => elapsed >= size) || units[units.length - 1];
    const time = new Intl.RelativeTimeFormat(state.snapshot.lang || "en", { numeric: "auto" })
      .format(-Math.floor(elapsed / seconds), unit);
    return t("mobileDeviceLastSeen").replace("{time}", time);
  }

  function showDeviceError(result, titleKey) {
    const detail = result && result.partialRevoke
      ? t("mobilePartialRevokeFailure")
      : (result && result.message) || t("mobileDevicesError");
    return helpers.showSettingsDialog({
      title: t(titleKey),
      detail,
      actions: [{ id: "ok", label: t("mobileDismiss"), defaultFocus: true }],
    });
  }

  async function revokeLegacy(button) {
    const choice = await helpers.showSettingsDialog({
      title: t("mobileRevokeLegacy"),
      detail: t("mobileRevokeLegacyConfirm"),
      actions: [
        { id: "cancel", label: t("permissionAutomationCancel"), defaultFocus: true },
        { id: "revoke", label: t("mobileRevokeLegacy"), tone: "danger" },
      ],
    });
    if (choice !== "revoke") return;
    button.disabled = true;
    try {
      const result = await window.settingsAPI.revokeMobileLegacy();
      await refreshMobileData();
      if (!result || result.status !== "ok") await showDeviceError(result, "mobileRevokeLegacy");
    } catch (err) {
      await showDeviceError(err, "mobileRevokeLegacy");
    } finally {
      button.disabled = false;
    }
  }

  async function revokeDevice(device, button) {
    const choice = await helpers.showSettingsDialog({
      title: t("mobileRevokeDevice"),
      detail: t("mobileRevokeDeviceConfirm").replace("{name}", device.name),
      actions: [
        { id: "cancel", label: t("permissionAutomationCancel"), defaultFocus: true },
        { id: "revoke", label: t("mobileRevokeDevice"), tone: "danger" },
      ],
    });
    if (choice !== "revoke") return;
    button.disabled = true;
    try {
      const result = await window.settingsAPI.revokeMobileDevice(device.id);
      const devices = await refreshMobileData();
      if (!result || result.status !== "ok") {
        await showDeviceError(result, "mobileRevokeDevice");
        return;
      }
      if (result.mayHoldLegacy && devices && devices.status === "ok" && devices.legacyActive) {
        const next = await helpers.showSettingsDialog({
          title: t("mobileRevokeLegacy"),
          detail: t("mobileDeviceMayHoldLegacy"),
          actions: [
            { id: "later", label: t("mobileRevokeLater"), defaultFocus: true },
            { id: "revoke", label: t("mobileRevokeLegacy"), tone: "danger" },
          ],
        });
        if (next === "revoke") await revokeLegacy(button);
      }
    } catch (err) {
      await showDeviceError(err, "mobileRevokeDevice");
    } finally {
      button.disabled = false;
    }
  }

  function buildDeviceRow(device) {
    const row = document.createElement("div");
    row.className = "row mobile-device-row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = device ? device.name : t("mobileLegacyDevices");
    text.appendChild(label);
    if (device) {
      const status = document.createElement("div");
      status.className = "row-desc mobile-device-status";
      status.textContent = deviceStatus(device);
      const paired = document.createElement("div");
      paired.className = "row-desc";
      paired.textContent = t("mobileDevicePairedAt")
        .replace("{time}", new Date(device.createdAt).toLocaleString(state.snapshot.lang || "en"));
      text.appendChild(status);
      text.appendChild(paired);
      if (device.origin === "legacy") {
        const migrated = document.createElement("div");
        migrated.className = "row-desc";
        migrated.textContent = t("mobileDeviceMigrated");
        text.appendChild(migrated);
      }
    } else {
      const legacy = document.createElement("div");
      legacy.className = "row-desc";
      legacy.textContent = t("mobileLegacyDevicesDesc");
      text.appendChild(legacy);
    }
    const control = document.createElement("div");
    control.className = "row-control";
    const revoke = helpers.buildButton({
      labelKey: device ? "mobileRevokeDevice" : "mobileRevokeLegacy",
      tone: "quiet",
      size: "compact",
      className: "danger mobile-device-revoke",
    });
    revoke.addEventListener("click", () => device ? revokeDevice(device, revoke) : revokeLegacy(revoke));
    control.appendChild(revoke);
    row.appendChild(text);
    row.appendChild(control);
    return row;
  }

  async function renderDevices(container) {
    if (!container || state.snapshot.mobilePreviewEnabled !== true) return null;
    const revision = ++devicesRevision;
    let result;
    try {
      result = await window.settingsAPI.getMobileDevices();
    } catch (err) {
      result = { status: "error", message: err.message };
    }
    if (container !== devicesContainer || !container.isConnected || revision !== devicesRevision) return null;
    const signature = JSON.stringify(result);
    if (signature === lastDevices) {
      if (result && result.status === "ok") {
        const statuses = container.querySelectorAll(".mobile-device-status");
        result.devices.forEach((device, index) => { statuses[index].textContent = deviceStatus(device); });
      }
      return result;
    }
    lastDevices = signature;
    container.innerHTML = "";
    if (!result || result.status !== "ok") {
      const error = document.createElement("p");
      error.className = "mobile-info-error";
      error.textContent = (result && result.message) || t("mobileDevicesError");
      container.appendChild(error);
      return result;
    }
    for (const device of result.devices) container.appendChild(buildDeviceRow(device));
    if (result.legacyActive) container.appendChild(buildDeviceRow(null));
    if (!result.devices.length && !result.legacyActive) {
      const empty = document.createElement("p");
      empty.className = "row-desc";
      empty.textContent = t("mobileDevicesEmpty");
      container.appendChild(empty);
    }
    return result;
  }

  function refreshMobileData() {
    if (infoContainer) renderConnectionInfo(infoContainer, 0, true);
    return renderDevices(devicesContainer);
  }

  function buildPairingFooter() {
    const foot = document.createElement("div");
    foot.className = "channel-foot";
    const refresh = helpers.buildButton({
      labelKey: "mobileRefreshPairCode", tone: "quiet", size: "compact",
      className: "channel-foot-link mobile-refresh-pair-code",
    });
    refresh.addEventListener("click", () => {
      if (!window.settingsAPI || typeof window.settingsAPI.refreshMobilePairCode !== "function") return;
      window.settingsAPI.refreshMobilePairCode().then((result) => {
        if (result && result.status === "ok") refreshMobileData();
        else showPairingError(result, "mobileRefreshPairCode");
      });
    });
    const reset = helpers.buildButton({
      labelKey: "mobileReset", tone: "quiet", size: "compact",
      className: "channel-foot-link danger mobile-reset",
    });
    reset.addEventListener("click", () => {
      if (!window.confirm(t("mobileResetConfirm"))) return;
      if (!window.settingsAPI || typeof window.settingsAPI.resetMobileAccess !== "function") return;
      window.settingsAPI.resetMobileAccess().then((result) => {
        if (result && result.status === "ok") refreshMobileData();
        else showPairingError(result, "mobileReset");
      });
    });
    foot.appendChild(refresh);
    foot.appendChild(reset);
    return foot;
  }

  function schedulePairInfoRefresh(container) {
    clearTimeout(pairInfoTimer);
    pairInfoTimer = setTimeout(() => {
      if (container !== infoContainer || !container.isConnected || state.snapshot.mobilePreviewEnabled !== true) return;
      const visible = document.visibilityState !== "hidden"
        && (typeof container.getClientRects !== "function" || container.getClientRects().length > 0);
      if (visible) refreshMobileData();
      schedulePairInfoRefresh(container);
    }, 5000);
  }

  // Scannable QR of the pair URL, shown above the text rows. The SVG arrives
  // fully generated from the main process (same payload as the pairUrl row);
  // when absent or malformed the card simply falls back to the text rows.
  function buildPairQrBlock(svg) {
    if (typeof svg !== "string" || !svg.startsWith("<svg")) return null;
    const block = document.createElement("div");
    block.className = "mobile-pair-qr";
    const holder = document.createElement("div");
    holder.className = "mobile-pair-qr-holder";
    holder.innerHTML = svg;
    const hint = document.createElement("span");
    hint.className = "mobile-pair-qr-hint";
    hint.textContent = t("mobileConnQrHint");
    block.appendChild(holder);
    block.appendChild(hint);
    return block;
  }

  function renderConnectionInfo(container, attempt = 0, refresh = false) {
    const revision = ++infoRevision;
    if (!refresh) { container.innerHTML = ""; lastInfo = null; }
    const snapshot = (state && state.snapshot) || {};
    const enabled = snapshot.mobilePreviewEnabled === true;
    if (!enabled) return;

    const loading = document.createElement("p");
    loading.className = "mobile-info-loading";
    loading.textContent = t("mobileLoading") || "Loading...";
    if (!refresh) container.appendChild(loading);

    fetchMobileInfo().then((info) => {
      if (!container.parentNode || container !== infoContainer || revision !== infoRevision) return;
      if (!isReadyMobileInfo(info)) {
        if (
          attempt < MOBILE_INFO_MAX_RETRIES
          && info
          && (info.status === "starting" || info.status === "ok")
        ) {
          setTimeout(() => {
            if (container === infoContainer && container.isConnected) renderConnectionInfo(container, attempt + 1);
          }, MOBILE_INFO_RETRY_MS);
          return;
        }
        lastInfo = null;
        container.innerHTML = "";
        const error = document.createElement("p");
        error.className = "mobile-info-error";
        error.textContent = t("mobileError") || "Unable to load connection info.";
        container.appendChild(error);
        return;
      }

      const signature = JSON.stringify(info);
      if (refresh && signature === lastInfo) return;
      lastInfo = signature;
      container.innerHTML = "";
      const qrBlock = buildPairQrBlock(info.pairQrSvg);
      if (qrBlock) container.appendChild(qrBlock);
      container.appendChild(buildConnectionRow("mobileConnLanIp", info.lanIp));
      container.appendChild(buildConnectionRow("mobileConnPort", info.port));
      if (info.pairCode) {
        const code = info.pairCode.slice(0, 4) + "-" + info.pairCode.slice(4);
        container.appendChild(buildConnectionRow("mobileConnPairCode", code, "mobile-pair-code"));
      }
      if (Number.isFinite(info.pairExpiresAt)) {
        container.appendChild(buildConnectionRow(
          "mobileConnPairExpires", new Date(info.pairExpiresAt).toLocaleTimeString(), "", { copyable: false }
        ));
      }
      if (info.pairUrl) {
        container.appendChild(buildConnectionRow("mobileConnUrl", info.pairUrl, "mobile-pair-url"));
      }
    });
  }

  // Body of the LAN approval card inside the Permissions tab's LAN approval
  // sub-page (the card frame — header, status sentence, collapse — is built by
  // settings-tab-telegram-approval.js next to the other channels).
  function renderChannelBody(container) {
    clearTimeout(pairInfoTimer);
    devicesContainer = null;
    lastDevices = null;
    devicesRevision++;
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
            { id: "cancel", label: t("permissionAutomationCancel"), tone: "neutral" },
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
            // later preference write fails, replace the stale pairing display.
            if (result && result.tokenReset === true && infoContainer) {
              refreshMobileData();
            }
            if (result && result.status !== "ok" && result.partialReset) {
              return Object.assign({}, result, { message: t("mobilePermissionPartialResetFailure") });
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
    helpers.attachDescriptionDisclosure(permissionPreviewRow);
    container.appendChild(helpers.buildDetailGroup(t("mobileGroupPhoneShows"), [permissionPreviewRow]));

    if (parentEnabled) {
      infoContainer = document.createElement("div");
      infoContainer.id = "mobile-connection-info";
      container.appendChild(helpers.buildDetailGroup(t("mobileGroupPairing"), [infoContainer]));
      container.appendChild(buildPairingFooter());
      devicesContainer = document.createElement("div");
      devicesContainer.id = "mobile-devices";
      container.appendChild(helpers.buildDetailGroup(t("mobileGroupDevices"), [devicesContainer]));
      renderConnectionInfo(infoContainer);
      renderDevices(devicesContainer);
      schedulePairInfoRefresh(infoContainer);
    } else {
      infoContainer = null;
      const foot = document.createElement("div");
      foot.className = "channel-foot";
      const hint = document.createElement("span");
      hint.className = "channel-foot-hint";
      hint.textContent = t("mobilePairingHint");
      foot.appendChild(hint);
      container.appendChild(foot);
    }

    // Re-render connection info when toggle changes
    if (!changeListenerRegistered && window.settingsAPI && typeof window.settingsAPI.onChanged === "function") {
      changeListenerRegistered = true;
      window.settingsAPI.onChanged((evt) => {
        if (evt && evt.changes && Object.prototype.hasOwnProperty.call(evt.changes, "mobilePreviewEnabled")) {
          refreshMobileData();
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
    // inside the Permissions tab's LAN approval sub-page.
  }

  root.ClawdSettingsTabMobile = { init, renderChannelBody, buildChannelHeaderRow };
})(globalThis);
