"use strict";

const api = window.quickSelectAPI;
const palette = document.getElementById("palette");
const optionsEl = document.getElementById("options");
const titleEl = document.getElementById("title");
const hintEl = document.getElementById("hint");
const emptyEl = document.getElementById("empty");
const feedbackEl = document.getElementById("feedback");
const closeEl = document.getElementById("close");
let entries = [];
let translations = {};
let revision = -1;
let generation = 0;
let active = false;
let pending = false;
let feedback = "";
let held = new Set();
let timer = null;
let consumeAgain = false;
let consuming = false;
const HANDOFF_QUIET_MS = 120;

const t = (key) => translations[key] || key;
function text(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

function render() {
  titleEl.textContent = t("dashboardQuickSelectTitle");
  document.title = titleEl.textContent;
  hintEl.textContent = t("dashboardQuickSelectHint");
  closeEl.setAttribute("aria-label", t("dashboardQuickSelectClose"));
  emptyEl.hidden = entries.length > 0;
  emptyEl.textContent = t("dashboardQuickSelectEmpty");
  feedbackEl.textContent = feedback ? t(feedback) : "";
  const fragment = document.createDocumentFragment();
  entries.forEach((entry, index) => {
    const row = text("div", entry.canFocus ? "option" : "option unavailable", "");
    row.setAttribute("role", "listitem");
    row.setAttribute("aria-disabled", entry.canFocus ? "false" : "true");
    row.appendChild(text("span", "digit", String(index + 1)));
    const details = text("div", "details", "");
    const title = text("div", "title", entry.title);
    title.title = entry.title;
    details.appendChild(title);
    const badgeKey = { running: "sessionBadgeRunning", done: "sessionBadgeDone", interrupted: "sessionBadgeInterrupted" }[entry.badge] || "sessionBadgeIdle";
    details.appendChild(text("div", "meta", entry.canFocus
      ? `${entry.agentName} · ${t(badgeKey)}`
      : t("dashboardQuickSelectUnavailable")));
    row.appendChild(details);
    fragment.appendChild(row);
  });
  optionsEl.replaceChildren(fragment);
}

function clearTimer() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function cancel() {
  generation += 1;
  clearTimer();
  held = new Set();
  pending = false;
  active = false;
}

function dismiss() {
  cancel();
  void api.dismiss().catch(() => {});
}

async function consumeIntent() {
  consumeAgain = true;
  if (consuming) return;
  consuming = true;
  try {
    while (consumeAgain) {
      consumeAgain = false;
      const result = await api.consumeIntent();
      if (!result || result.status !== "ok" || result.revision < revision) continue;
      translations = (result.i18n && result.i18n.translations) || translations;
      if (result.i18n && result.i18n.lang) document.documentElement.lang = result.i18n.lang;
      if (result.enterQuickSelect) {
        cancel();
        revision = result.revision;
        entries = result.entries || [];
        active = entries.length > 0;
        feedback = "";
        render();
        if (active) palette.focus({ preventScroll: true });
        else closeEl.focus({ preventScroll: true });
      }
    }
  } catch {
    feedback = "dashboardQuickSelectUnavailable";
    render();
  } finally {
    consuming = false;
  }
}

function physicalDigit(event) {
  if (/^(Digit|Numpad)[1-9]$/.test(event.code || "")) return event.code;
  return /^[1-9]$/.test(event.key) ? `key:${event.key}` : null;
}

let pendingId = null;
function armHandoff() {
  clearTimer();
  if (!pending || held.size > 0) return;
  const attemptGeneration = generation;
  const sessionId = pendingId;
  timer = setTimeout(async () => {
    timer = null;
    if (!active || generation !== attemptGeneration) return;
    const entry = entries.find((item) => item.id === sessionId);
    if (!entry || !entry.canFocus) {
      pending = false;
      feedback = "dashboardQuickSelectUnavailable";
      render();
      return;
    }
    let result;
    try { result = await api.activateSession({ sessionId }); }
    catch { result = { status: "rejected" }; }
    if (generation !== attemptGeneration) return;
    pending = false;
    if (result && result.status === "submitted") {
      active = false;
      feedback = "dashboardQuickSelectSubmitted";
      // The native owner hides on blur, after the target takes focus.
    } else {
      feedback = result && result.reason === "dropped-duplicate"
        ? "dashboardQuickSelectAlreadyRequested" : "dashboardQuickSelectUnavailable";
    }
    render();
  }, HANDOFF_QUIET_MS);
}

document.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    dismiss();
    return;
  }
  if (!active || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (!/^[1-9]$/.test(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const physicalKey = physicalDigit(event);
  if (physicalKey) held.add(physicalKey);
  clearTimer();
  if (pending || event.repeat) return;
  const entry = entries[Number(event.key) - 1];
  if (!entry) return;
  if (!entry.canFocus) {
    feedback = "dashboardQuickSelectUnavailable";
    render();
    return;
  }
  pending = true;
  pendingId = entry.id;
  feedback = "";
});

document.addEventListener("keyup", (event) => {
  if (!active) return;
  const physicalKey = physicalDigit(event);
  if (!physicalKey) return;
  event.preventDefault();
  event.stopPropagation();
  held.delete(physicalKey);
  armHandoff();
});

closeEl.addEventListener("click", dismiss);
window.addEventListener("blur", cancel);
window.addEventListener("beforeunload", cancel);
api.onDismissed((payload) => {
  if (payload && payload.revision < revision) return;
  revision = payload ? payload.revision : revision;
  cancel();
});
api.onSnapshot((payload) => {
  if (!payload || payload.revision !== revision) return;
  entries = payload.entries || [];
  render();
});
api.onLangChange((payload) => {
  translations = (payload && payload.translations) || translations;
  if (payload && payload.lang) document.documentElement.lang = payload.lang;
  render();
});
api.onIntent(() => { void consumeIntent(); });
void consumeIntent();
