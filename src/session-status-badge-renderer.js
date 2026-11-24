"use strict";

const { summarizeSessions } = globalThis.ClawdSessionStatusSummary;
const STATUS_KEYS = Object.freeze({
  working: "sessionWorking",
  done: "sessionBadgeDone",
  attention: "sessionHudStatusAttention",
});

let payload = { sessions: [], orderedIds: [], collapsed: false };
let i18nPayload = { lang: "en", translations: {} };
const shell = document.getElementById("badgeShell");

function t(key) {
  const dict = i18nPayload && i18nPayload.translations ? i18nPayload.translations : {};
  return dict[key] || key;
}

function createMetric(status, count) {
  const metric = document.createElement("span");
  metric.className = `metric metric-${status}`;
  metric.dataset.status = status;
  const symbol = document.createElement("span");
  symbol.className = "metric-symbol";
  symbol.setAttribute("aria-hidden", "true");
  const value = document.createElement("span");
  value.className = "metric-count";
  value.textContent = String(Math.max(0, Math.floor(Number(count) || 0)));
  metric.appendChild(symbol);
  metric.appendChild(value);
  return metric;
}

function tooltip(summary, collapsed) {
  const lines = [
    `${t(STATUS_KEYS.working)}: ${summary.counts.working}`,
    `${t(STATUS_KEYS.done)}: ${summary.counts.done}`,
    `${t(STATUS_KEYS.attention)}: ${summary.counts.attention}`,
  ];
  if (collapsed) lines.push(t("sessionStatusBadgeExpandTooltip"));
  else lines.push(t("sessionStatusBadgeCollapseTooltip"));
  return lines.join("\n");
}

async function toggleCollapsed() {
  const result = await window.sessionStatusBadgeAPI.toggleCollapsed();
  if (result && typeof result.collapsed === "boolean") {
    payload = { ...payload, collapsed: result.collapsed };
    render();
  }
}

function render() {
  const summary = summarizeSessions(payload);
  shell.replaceChildren();
  if (summary.total === 0) return;

  const badge = document.createElement("div");
  badge.className = payload.collapsed
    ? "status-badge is-collapsed"
    : "status-badge";
  const title = tooltip(summary, payload.collapsed === true);
  badge.title = title;
  badge.setAttribute("aria-label", title.replace(/\n/g, ". "));
  badge.addEventListener("click", () => {
    toggleCollapsed().catch((err) => console.warn("toggle status badge failed:", err));
  });

  badge.appendChild(createMetric("working", summary.counts.working));
  badge.appendChild(createMetric("done", summary.counts.done));
  badge.appendChild(createMetric("attention", summary.counts.attention));
  shell.appendChild(badge);
}

async function init() {
  window.sessionStatusBadgeAPI.onSnapshot((next) => {
    payload = next || payload;
    render();
  });
  window.sessionStatusBadgeAPI.onLangChange((next) => {
    i18nPayload = next || i18nPayload;
    render();
  });
  i18nPayload = await window.sessionStatusBadgeAPI.getI18n() || i18nPayload;
  render();
}

init().catch((err) => {
  shell.textContent = err && err.message ? err.message : String(err);
});
