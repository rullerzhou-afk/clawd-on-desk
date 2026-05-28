"use strict";

let snapshot = { alwaysOn: [], expanded: [], expandedOpen: false };

const panel = document.getElementById("panel");
const donutsEl = document.getElementById("donuts");
const barsEl = document.getElementById("bars");

function colorFor(limit) {
  if (!limit) return "var(--track)";
  if (limit.severity === "red") return "var(--red)";
  if (limit.severity === "yellow") return "var(--yellow)";
  return "var(--green)";
}

function pct(limit) {
  const n = Number(limit && limit.usedPercent);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function shortName(limit) {
  if (!limit) return "";
  if (limit.id === "codex.primary") return "Codex 5h";
  if (limit.id === "codex.secondary") return "Codex 7d";
  if (limit.id === "claude.five_hour") return "Claude 5h";
  if (limit.id === "claude.seven_day") return "Claude 7d";
  return limit.windowLabel || limit.label || "";
}

function createDonut(limit) {
  const wrap = document.createElement("div");
  wrap.className = "donut-wrap";

  const donut = document.createElement("div");
  const value = Math.round(pct(limit));
  donut.className = "donut";
  donut.style.setProperty("--pct", String(value));
  donut.style.setProperty("--color", colorFor(limit));
  donut.dataset.value = `${value}`;
  donut.title = `${limit.label}: ${value}%`;
  wrap.appendChild(donut);

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = shortName(limit);
  name.title = limit.label || "";
  wrap.appendChild(name);
  return wrap;
}

function createBar(limit) {
  const row = document.createElement("div");
  row.className = "bar-row";

  const name = document.createElement("div");
  name.className = "bar-name";
  name.textContent = limit.label || limit.id;
  name.title = limit.label || limit.id;
  row.appendChild(name);

  const track = document.createElement("div");
  track.className = "bar-track";
  const fill = document.createElement("div");
  fill.className = "bar-fill";
  fill.style.setProperty("--pct", String(pct(limit)));
  fill.style.setProperty("--color", colorFor(limit));
  track.appendChild(fill);
  row.appendChild(track);

  const value = document.createElement("div");
  value.className = "bar-pct";
  value.textContent = `${Math.round(pct(limit))}%`;
  row.appendChild(value);
  return row;
}

function render() {
  panel.classList.toggle("expanded", snapshot.expandedOpen === true);
  donutsEl.replaceChildren();
  barsEl.replaceChildren();
  const alwaysOn = Array.isArray(snapshot.alwaysOn) ? snapshot.alwaysOn : [];
  for (const limit of alwaysOn.slice(0, 4)) donutsEl.appendChild(createDonut(limit));
  const expanded = Array.isArray(snapshot.expanded) ? snapshot.expanded : [];
  for (const limit of expanded) barsEl.appendChild(createBar(limit));
}

panel.addEventListener("click", () => {
  window.usageGaugeAPI.toggleExpanded();
});

window.usageGaugeAPI.onSnapshot((next) => {
  snapshot = next || snapshot;
  render();
});

render();
