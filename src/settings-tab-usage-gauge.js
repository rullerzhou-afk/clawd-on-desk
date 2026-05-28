"use strict";

(function initSettingsTabUsageGauge(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  const settingsApi = root.ClawdUsageGaugeSettings || {};
  const PROVIDERS = settingsApi.PROVIDERS || ["codex", "claude"];
  const POSITIONS = settingsApi.POSITIONS || ["below", "above", "floating"];
  const LIMIT_IDS = settingsApi.LIMIT_IDS || [
    "codex.primary",
    "claude.five_hour",
    "codex.secondary",
    "claude.seven_day",
    "claude.seven_day_opus",
    "claude.seven_day_sonnet",
  ];
  const MIN_POLL_INTERVAL_MS = settingsApi.MIN_POLL_INTERVAL_MS || 15000;
  const MAX_POLL_INTERVAL_MS = settingsApi.MAX_POLL_INTERVAL_MS || 3600000;

  function t(key) {
    return helpers.t(key);
  }

  function getUsageGauge() {
    if (state.snapshot && state.snapshot.usageGauge && typeof state.snapshot.usageGauge === "object") {
      return state.snapshot.usageGauge;
    }
    return settingsApi.getDefaults ? settingsApi.getDefaults() : {
      enabled: true,
      providers: { codex: true, claude: true },
      position: "below",
      pollIntervalMs: 60000,
      alwaysOnLimitIds: LIMIT_IDS.slice(0, 4),
      expandedLimitIds: LIMIT_IDS.slice(),
    };
  }

  function updateUsageGauge(patch) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return Promise.resolve({ status: "error", message: "settings API unavailable" });
    }
    const current = getUsageGauge();
    const next = {
      ...current,
      ...patch,
      providers: patch.providers ? { ...current.providers, ...patch.providers } : { ...current.providers },
      alwaysOnLimitIds: Array.isArray(patch.alwaysOnLimitIds)
        ? patch.alwaysOnLimitIds.slice()
        : (Array.isArray(current.alwaysOnLimitIds) ? current.alwaysOnLimitIds.slice() : []),
      expandedLimitIds: Array.isArray(patch.expandedLimitIds)
        ? patch.expandedLimitIds.slice()
        : (Array.isArray(current.expandedLimitIds) ? current.expandedLimitIds.slice() : []),
    };
    return window.settingsAPI.update("usageGauge", next).then((result) => {
      if (!result || result.status !== "ok") {
        ops.showToast(t("toastSaveFailed") + ((result && result.message) || "unknown error"), { error: true });
      }
      return result;
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      return { status: "error", message: err && err.message };
    });
  }

  function buildSwitchRow(labelKey, descKey, enabled, onToggle) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
    row.querySelector(".row-label").textContent = t(labelKey);
    row.querySelector(".row-desc").textContent = t(descKey);
    const sw = row.querySelector(".switch");
    helpers.setSwitchVisual(sw, enabled);

    function run(ev) {
      if (ev) ev.preventDefault();
      if (sw.classList.contains("pending")) return;
      const next = sw.getAttribute("aria-checked") !== "true";
      helpers.setSwitchVisual(sw, next, { pending: true });
      Promise.resolve(onToggle(next)).then((result) => {
        if (!result || result.status !== "ok") helpers.setSwitchVisual(sw, enabled);
      }).finally(() => {
        sw.classList.remove("pending");
      });
    }

    sw.addEventListener("click", run);
    sw.addEventListener("keydown", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      run(ev);
    });
    return row;
  }

  function buildPositionRow(settings) {
    const row = document.createElement("div");
    row.className = "row usage-gauge-select-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"></div>`;
    row.querySelector(".row-label").textContent = t("usageGaugePosition");
    row.querySelector(".row-desc").textContent = t("usageGaugePositionDesc");
    const select = document.createElement("select");
    select.className = "usage-gauge-select";
    for (const position of POSITIONS) {
      const option = document.createElement("option");
      option.value = position;
      option.textContent = t(`usageGaugePosition_${position}`);
      select.appendChild(option);
    }
    select.value = settings.position || "below";
    select.addEventListener("change", () => {
      void updateUsageGauge({ position: select.value });
    });
    row.querySelector(".row-control").appendChild(select);
    return row;
  }

  function buildPollIntervalRow(settings) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control usage-gauge-number-control">` +
        `<input type="text" class="bubble-policy-seconds usage-gauge-poll-input" inputmode="numeric" />` +
        `<span class="bubble-policy-unit"></span>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("usageGaugePollInterval");
    row.querySelector(".row-desc").textContent = t("usageGaugePollIntervalDesc");
    row.querySelector(".bubble-policy-unit").textContent = t("usageGaugeSeconds");
    const input = row.querySelector(".usage-gauge-poll-input");
    const minSeconds = Math.round(MIN_POLL_INTERVAL_MS / 1000);
    const maxSeconds = Math.round(MAX_POLL_INTERVAL_MS / 1000);

    function renderValue() {
      input.value = String(Math.round((getUsageGauge().pollIntervalMs || settings.pollIntervalMs || 60000) / 1000));
    }

    function commit() {
      const value = Number(input.value.trim());
      if (!Number.isInteger(value) || value < minSeconds || value > maxSeconds) {
        ops.showToast(t("toastSaveFailed") + `${minSeconds}-${maxSeconds}`, { error: true });
        renderValue();
        return;
      }
      void updateUsageGauge({ pollIntervalMs: value * 1000 }).then((result) => {
        if (!result || result.status !== "ok") renderValue();
      });
    }

    renderValue();
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") input.blur();
      if (ev.key === "Escape") {
        renderValue();
        input.blur();
      }
    });
    return row;
  }

  function buildLimitMultiSelectRow(labelKey, descKey, selectedIds, onChange) {
    const row = document.createElement("div");
    row.className = "row usage-gauge-limits-row";

    const text = document.createElement("div");
    text.className = "row-text usage-gauge-limits-heading";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t(labelKey);
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t(descKey);
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const list = document.createElement("div");
    list.className = "usage-gauge-limit-list";
    const selected = new Set(selectedIds || []);
    for (const id of LIMIT_IDS) {
      const item = document.createElement("label");
      item.className = "usage-gauge-limit-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(id);
      checkbox.dataset.limitId = id;
      checkbox.addEventListener("change", () => {
        const next = LIMIT_IDS.filter((limitId) => {
          const input = list.querySelector(`input[data-limit-id="${limitId}"]`);
          return input && input.checked;
        });
        void onChange(next, checkbox);
      });
      const span = document.createElement("span");
      span.textContent = t(`usageGaugeLimit_${id.replace(".", "_")}`);
      item.appendChild(checkbox);
      item.appendChild(span);
      list.appendChild(item);
    }
    row.appendChild(list);
    return row;
  }

  function render(parent) {
    const settings = getUsageGauge();

    const h1 = document.createElement("h1");
    h1.textContent = t("usageGaugeTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("usageGaugeSubtitle");
    parent.appendChild(subtitle);

    parent.appendChild(helpers.buildSection(t("usageGaugeSectionGeneral"), [
      buildSwitchRow(
        "usageGaugeEnabled",
        "usageGaugeEnabledDesc",
        settings.enabled !== false,
        (enabled) => updateUsageGauge({ enabled })
      ),
      ...PROVIDERS.map((provider) => buildSwitchRow(
        `usageGaugeProvider_${provider}`,
        `usageGaugeProvider_${provider}_desc`,
        !settings.providers || settings.providers[provider] !== false,
        (enabled) => updateUsageGauge({ providers: { [provider]: enabled } })
      )),
      buildPositionRow(settings),
      buildPollIntervalRow(settings),
    ]));

    parent.appendChild(helpers.buildSection(t("usageGaugeSectionLimits"), [
      buildLimitMultiSelectRow(
        "usageGaugePinnedLimits",
        "usageGaugePinnedLimitsDesc",
        settings.alwaysOnLimitIds,
        (alwaysOnLimitIds, checkbox) => updateUsageGauge({ alwaysOnLimitIds }).then((result) => {
          if (!result || result.status !== "ok") checkbox.checked = !checkbox.checked;
          return result;
        })
      ),
      buildLimitMultiSelectRow(
        "usageGaugeExpandedLimits",
        "usageGaugeExpandedLimitsDesc",
        settings.expandedLimitIds,
        (expandedLimitIds, checkbox) => updateUsageGauge({ expandedLimitIds }).then((result) => {
          if (!result || result.status !== "ok") checkbox.checked = !checkbox.checked;
          return result;
        })
      ),
    ]));
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.usageGauge = {
      render,
    };
  }

  root.ClawdSettingsTabUsageGauge = { init };
})(globalThis);
