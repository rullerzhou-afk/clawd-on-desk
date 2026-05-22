"use strict";

const HUD_MAX_EXPANDED_ROWS = 3;
const HUD_MAX_EXPANDED_ROWS_LABELS = 5;
const HUD_TITLE_MAX_UNITS = 15;
const RECENT_DONE_UNREAD_MS = 60 * 1000;

let snapshot = { sessions: [], orderedIds: [], hudTotalNonIdle: 0, hudLastTitle: null, hudShowStateLabels: true, hudShowElapsed: true, hudAutoHide: false, hudPinned: false };
let i18nPayload = { lang: "en", translations: {} };

const unreadSessions = new Set();
const prevBadges = new Map();

const hudEl = document.getElementById("hud");

function isHudSession(session) {
  return !!session && !session.headless && session.state !== "sleeping" && !session.hiddenFromHud;
}

function t(key) {
  const dict = i18nPayload && i18nPayload.translations ? i18nPayload.translations : {};
  return dict[key] || key;
}

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 5) return t("sessionJustNow");
  if (sec < 60) return t("sessionHudElapsedSec").replace("{n}", sec);
  const min = Math.floor(sec / 60);
  if (min < 5) {
    const secRem = sec % 60;
    return t("sessionHudElapsedMinSec")
      .replace("{m}", min)
      .replace("{s}", secRem);
  }
  if (min < 60) return t("sessionMinAgo").replace("{n}", min);
  const hr = Math.floor(min / 60);
  return t("sessionHrAgo").replace("{n}", hr);
}

function titleFor(session) {
  return session.displayTitle || session.sessionTitle || session.id || "";
}

function titleUnits(value) {
  let units = 0;
  for (const ch of String(value || "")) {
    if (/\s/.test(ch)) units += 0.5;
    else units += ch.charCodeAt(0) > 0x7F ? 2 : 1;
  }
  return units;
}

function shortenHudTitle(value) {
  const full = String(value || "").replace(/\s+/g, " ").trim();
  if (!full || titleUnits(full) <= HUD_TITLE_MAX_UNITS) return full;

  let units = 0;
  let out = "";
  for (const ch of full) {
    const nextUnits = /\s/.test(ch) ? 0.5 : (ch.charCodeAt(0) > 0x7F ? 2 : 1);
    if (units + nextUnits > HUD_TITLE_MAX_UNITS) break;
    out += ch;
    units += nextUnits;
  }

  let trimmed = out.trimEnd();
  const next = full[trimmed.length] || "";
  if (/[A-Za-z0-9]/.test(trimmed.slice(-1)) && /[A-Za-z0-9]/.test(next)) {
    const wordTrimmed = trimmed.replace(/\s+\S*$/, "").trimEnd();
    if (wordTrimmed && titleUnits(wordTrimmed) >= HUD_TITLE_MAX_UNITS * 0.55) {
      trimmed = wordTrimmed;
    }
  }
  return `${trimmed}\u2026`;
}

function orderedHudSessions(currentSnapshot) {
  const sessions = Array.isArray(currentSnapshot.sessions) ? currentSnapshot.sessions : [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const ids = Array.isArray(currentSnapshot.orderedIds)
    ? currentSnapshot.orderedIds
    : sessions.map((session) => session.id);
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const orderedIds = new Set(ordered.map((session) => session.id));
  const missing = sessions.filter((session) => !orderedIds.has(session.id));
  return ordered.concat(missing).filter(isHudSession);
}

const STATE_CHIP_MAP = {
  thinking: { key: "sessionThinking", cls: "chip-thinking" },
  working: { key: "sessionWorking", cls: "chip-working" },
  juggling: { key: "sessionJuggling", cls: "chip-juggling" },
};

const EVENT_CHIP_MAP = {
  PreCompact: { key: "sessionSweeping", cls: "chip-sweeping" },
  PreCompress: { key: "sessionSweeping", cls: "chip-sweeping" },
  PermissionRequest: { key: "sessionNotification", cls: "chip-notification" },
  Elicitation: { key: "sessionNotification", cls: "chip-notification" },
  Notification: { key: "sessionNotification", cls: "chip-notification" },
  WorktreeCreate: { key: "sessionWorktree", cls: "chip-worktree" },
};

function makeChipInfo(entry) {
  return entry ? { label: t(entry.key), cls: entry.cls } : null;
}

function stateChipInfo(session) {
  if (snapshot.hudShowStateLabels === false) return null;
  const rawEvent = session && session.lastEvent && session.lastEvent.rawEvent;
  const eventChip = makeChipInfo(EVENT_CHIP_MAP[rawEvent]);
  if (eventChip && session.badge !== "done" && session.badge !== "interrupted") return eventChip;

  if (session.badge === "running") {
    const stateChip = makeChipInfo(STATE_CHIP_MAP[session.state]);
    if (stateChip) return stateChip;
    return { label: t("sessionBadgeRunning"), cls: "chip-working" };
  }
  if (session.badge === "interrupted") {
    return { label: t("sessionBadgeInterrupted"), cls: "chip-interrupted" };
  }
  return null;
}

const BELL_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>`;
const FOCUS_UNAVAILABLE_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l16 16"/><path d="M9.5 5h5"/><path d="M7 9h10"/><path d="M5 14h9"/><path d="M12 19h5"/></svg>`;
const PIN_SVG_FILLED = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 4l6 6-4 1-3 3 1 5-2 1-4-4-5 5-1-1 5-5-4-4 1-2 5 1 3-3 1-4z"/></svg>`;
const PIN_SVG_OUTLINE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M14 4l6 6-4 1-3 3 1 5-2 1-4-4-5 5-1-1 5-5-4-4 1-2 5 1 3-3 1-4z"/></svg>`;

function updateUnread(sessions) {
  const now = Date.now();
  const currentIds = new Set(sessions.map((s) => s.id));
  for (const id of unreadSessions) {
    if (!currentIds.has(id)) unreadSessions.delete(id);
  }
  for (const session of sessions) {
    const prev = prevBadges.get(session.id);
    const curr = session.badge;
    if (curr !== "done") {
      unreadSessions.delete(session.id);
    } else if (prev !== undefined && prev !== "done") {
      unreadSessions.add(session.id);
    } else if (prev === undefined) {
      const updatedAt = Number(session.updatedAt);
      if (Number.isFinite(updatedAt) && now - updatedAt <= RECENT_DONE_UNREAD_MS) {
        unreadSessions.add(session.id);
      }
    }
    prevBadges.set(session.id, curr);
  }
  for (const id of prevBadges.keys()) {
    if (!currentIds.has(id)) prevBadges.delete(id);
  }
}

function splitHudLayout(sessions) {
  const maxRows = snapshot.hudShowStateLabels === false
    ? HUD_MAX_EXPANDED_ROWS
    : HUD_MAX_EXPANDED_ROWS_LABELS;
  const expanded = sessions.slice(0, maxRows);
  const folded = sessions.slice(maxRows);
  return { expanded, folded };
}

function focusUnavailableTooltip(session) {
  return session && session.host
    ? t("sessionHudRemoteFocusUnavailableTooltip")
    : t("sessionHudFocusUnavailableTooltip");
}

function createRowForSession(session, now) {
  const row = document.createElement("div");
  row.className = "row";
  const canFocus = session.canFocus === true;
  if (!canFocus) {
    row.classList.add("row-unfocusable");
    row.title = focusUnavailableTooltip(session);
  }

  const left = document.createElement("div");
  left.className = "left";

  const dot = document.createElement("span");
  dot.className = `dot dot-${session.badge || "idle"}`;
  left.appendChild(dot);

  if (session.iconUrl) {
    const img = document.createElement("img");
    img.className = "agent-icon";
    img.alt = "";
    img.src = session.iconUrl;
    left.appendChild(img);
  }

  const title = document.createElement("span");
  const fullTitle = titleFor(session);
  const shortTitle = shortenHudTitle(fullTitle);
  title.className = "title";
  title.textContent = shortTitle;
  if (shortTitle && shortTitle !== fullTitle) title.title = fullTitle;
  left.appendChild(title);

  const showElapsed = snapshot.hudShowElapsed !== false;
  const right = document.createElement("span");
  right.className = "right";
  let hasRightContent = false;

  if (session.badge === "done" && unreadSessions.has(session.id)) {
    const bell = document.createElement("span");
    bell.className = "completion-bell unread-bell";
    bell.innerHTML = BELL_SVG;
    right.appendChild(bell);
    hasRightContent = true;
  }

  if (!canFocus) {
    const marker = document.createElement("span");
    marker.className = "focus-unavailable";
    marker.innerHTML = FOCUS_UNAVAILABLE_SVG;
    marker.title = focusUnavailableTooltip(session);
    marker.setAttribute("aria-label", focusUnavailableTooltip(session));
    right.appendChild(marker);
    hasRightContent = true;
  }

  const chipInfo = stateChipInfo(session);
  if (chipInfo) {
    const chip = document.createElement("span");
    chip.className = `state-chip ${chipInfo.cls}`;
    chip.textContent = chipInfo.label;
    right.appendChild(chip);
    hasRightContent = true;
  }

  if (showElapsed) {
    const updatedAt = Number(session.updatedAt) || now;
    const elapsed = document.createElement("span");
    elapsed.className = "elapsed";
    elapsed.dataset.updatedAt = String(updatedAt);
    elapsed.textContent = formatElapsed(now - updatedAt);
    right.appendChild(elapsed);
    hasRightContent = true;
  }

  row.appendChild(left);
  if (hasRightContent) row.appendChild(right);

  row.addEventListener("click", () => {
    unreadSessions.delete(session.id);
    render();
    if (canFocus) window.sessionHudAPI.focusSession(session.id);
    // Fire-and-forget: the row click's primary intent is focus / unread
    // dismissal. ack failure shouldn't block the UI — the next snapshot
    // will reconcile the lifecycle flag.
    if (window.sessionHudAPI && typeof window.sessionHudAPI.ackCompletion === "function") {
      Promise.resolve(window.sessionHudAPI.ackCompletion(session.id)).catch((err) => {
        console.warn("ack completion threw:", err);
      });
    }
  });

  return row;
}

function createFoldedRow(count) {
  const row = document.createElement("div");
  row.className = "row row-folded";

  const left = document.createElement("div");
  left.className = "left";

  const dot = document.createElement("span");
  dot.className = "dot dot-idle";
  left.appendChild(dot);

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = t("sessionHudOtherActive").replace("{n}", count);
  left.appendChild(title);

  row.appendChild(left);

  row.addEventListener("click", () => {
    window.sessionHudAPI.openDashboard();
  });

  return row;
}

function createPinButton(pinned) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = pinned ? "pin-btn pinned" : "pin-btn";
  btn.innerHTML = pinned ? PIN_SVG_FILLED : PIN_SVG_OUTLINE;
  const tipKey = pinned ? "sessionHudUnpinTooltip" : "sessionHudPinTooltip";
  btn.title = t(tipKey);
  btn.setAttribute("aria-label", t(tipKey));
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    window.sessionHudAPI.setPinned(!pinned);
  });
  return btn;
}

function render() {
  const sessions = orderedHudSessions(snapshot);
  updateUnread(sessions);
  hudEl.replaceChildren();
  hudEl.classList.toggle("has-pin", snapshot.hudAutoHide === true);
  if (!sessions.length) return;

  const now = Date.now();
  const { expanded, folded } = splitHudLayout(sessions);

  for (const session of expanded) {
    hudEl.appendChild(createRowForSession(session, now));
  }
  if (folded.length > 0) {
    hudEl.appendChild(createFoldedRow(folded.length));
  }

  if (snapshot.hudAutoHide === true) {
    hudEl.appendChild(createPinButton(snapshot.hudPinned === true));
  }
}

function updateElapsedLabels() {
  const now = Date.now();
  for (const elapsed of document.querySelectorAll(".elapsed[data-updated-at]")) {
    const updatedAt = Number(elapsed.dataset.updatedAt);
    if (!Number.isFinite(updatedAt)) continue;
    elapsed.textContent = formatElapsed(now - updatedAt);
  }
}

async function init() {
  window.sessionHudAPI.onLangChange((payload) => {
    i18nPayload = payload || i18nPayload;
    render();
  });
  window.sessionHudAPI.onSessionSnapshot((nextSnapshot) => {
    snapshot = nextSnapshot || snapshot;
    render();
  });

  i18nPayload = await window.sessionHudAPI.getI18n() || i18nPayload;
  render();
  setInterval(updateElapsedLabels, 1000);
}

init().catch((err) => {
  hudEl.textContent = err && err.message ? err.message : String(err);
});
