"use strict";

const HUD_MAX_EXPANDED_ROWS = 3;

let snapshot = { sessions: [], orderedIds: [], hudTotalNonIdle: 0, hudLastTitle: null };
let i18nPayload = { lang: "en", translations: {} };

const hudEl = document.getElementById("hud");

function isHudSession(session) {
  return !!session && !session.headless && session.state !== "sleeping";
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

function splitHudLayout(sessions) {
  const expanded = sessions.slice(0, HUD_MAX_EXPANDED_ROWS);
  const folded = sessions.slice(HUD_MAX_EXPANDED_ROWS);
  return { expanded, folded };
}

function createRowForSession(session, now) {
  const row = document.createElement("div");
  row.className = "row";

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
  title.className = "title";
  title.textContent = titleFor(session);
  left.appendChild(title);

  const right = document.createElement("span");
  right.className = "right";
  right.textContent = formatElapsed(now - (Number(session.updatedAt) || now));

  row.appendChild(left);
  row.appendChild(right);

  row.addEventListener("click", () => {
    window.sessionHudAPI.focusSession(session.id);
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

function render() {
  const sessions = orderedHudSessions(snapshot);
  hudEl.replaceChildren();
  if (!sessions.length) return;

  const now = Date.now();
  const { expanded, folded } = splitHudLayout(sessions);

  for (const session of expanded) {
    hudEl.appendChild(createRowForSession(session, now));
  }
  if (folded.length > 0) {
    hudEl.appendChild(createFoldedRow(folded.length));
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
  setInterval(render, 1000);
}

init().catch((err) => {
  hudEl.textContent = err && err.message ? err.message : String(err);
});
