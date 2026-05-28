"use strict";

const tokensEl = document.getElementById("tokens-value");
const sessionEl = document.getElementById("session-value");
const deltaEl = document.getElementById("token-delta");

let lastTotalTokens = null;

function trimFixed(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

function formatCompactNumber(value) {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  if (n >= 1000000000) return `${trimFixed(n / 1000000000)}B`;
  if (n >= 1000000) return `${trimFixed(n / 1000000)}M`;
  if (n >= 1000) return `${trimFixed(n / 1000)}K`;
  return String(Math.round(n));
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 60000));
  if (minutes <= 0) return "0m";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

function showDelta(delta) {
  if (!deltaEl || delta <= 0) return;
  deltaEl.textContent = `+${formatCompactNumber(delta)}`;
  deltaEl.classList.remove("show");
  void deltaEl.offsetWidth;
  deltaEl.classList.add("show");
}

function render(snapshot) {
  const today = snapshot && snapshot.today ? snapshot.today : {};
  const totals = today.totals || {};
  const tokens = Number.isFinite(totals.tokens) ? totals.tokens : 0;
  const sessionMs = Number.isFinite(totals.sessionMs) ? totals.sessionMs : 0;

  if (tokensEl) tokensEl.textContent = formatCompactNumber(tokens);
  if (sessionEl) sessionEl.textContent = formatDuration(sessionMs);

  if (lastTotalTokens !== null && tokens > lastTotalTokens) {
    showDelta(tokens - lastTotalTokens);
  }
  lastTotalTokens = tokens;
}

if (window.usageHoverAPI) {
  window.usageHoverAPI.onSnapshot(render);
  window.usageHoverAPI.getSnapshot()
    .then(render)
    .catch(() => render(null));
  setInterval(() => {
    window.usageHoverAPI.getSnapshot()
      .then(render)
      .catch(() => {});
  }, 15000);
}
