const listEl = document.getElementById("list");
const panelEl = document.querySelector(".panel");
const headerEl = document.querySelector(".header");
let lastRequestedHeight = 0;
const expandedSessions = new Set();

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getDisplayStatus(session) {
  const latest = Array.isArray(session.recentEvents) && session.recentEvents.length
    ? session.recentEvents[0]
    : null;
  const latestEvent = latest && typeof latest.event === "string" ? latest.event : "";

  if (session.active) return { key: "running", label: "Running" };
  if (latestEvent === "StopFailure" || latestEvent === "PostToolUseFailure") {
    return { key: "interrupted", label: "Interrupted" };
  }
  if (latestEvent === "SessionEnd" || session.state === "sleeping") {
    return { key: "exited", label: "Exited" };
  }
  if (latestEvent === "Stop" || latestEvent === "PostCompact") {
    return { key: "done", label: "Done" };
  }
  return { key: "idle", label: "Idle" };
}

function renderSession(session) {
  const displayStatus = getDisplayStatus(session);
  return `
    <section class="session ${session.active ? "running" : ""} ${expandedSessions.has(session.id) ? "expanded" : ""}" data-session-id="${escapeHtml(session.id)}">
      <div class="summary">
        <div class="summary-bar">
          <div class="summary-main">
            <div class="topline">
              <div class="name">${escapeHtml(session.title || session.folder)}</div>
              <div class="agent-chip">${escapeHtml(session.agentName || session.agentId || "Unknown Agent")}</div>
              <div class="badge ${escapeHtml(displayStatus.key)}">${escapeHtml(displayStatus.label)}</div>
            </div>
            <div class="meta">#${escapeHtml(session.shortId)} · ${escapeHtml(session.updatedLabel)}</div>
          </div>
          <div class="summary-actions">
            <button class="toggle-btn" data-role="toggle" aria-label="${expandedSessions.has(session.id) ? "Collapse" : "Expand"}">${expandedSessions.has(session.id) ? "<" : ">"}</button>
          </div>
        </div>
      </div>

      <div class="details">
        <div class="section">
          <div class="section-title">Session Context</div>
          <div class="kv">
            <div class="kv-line"><span class="key">Project</span><span class="value">${escapeHtml(session.context.project)}</span></div>
            <div class="kv-line"><span class="key">Path</span><span class="value">${escapeHtml(session.context.cwd)}</span></div>
            <div class="kv-line"><span class="key">Host</span><span class="value">${escapeHtml(session.context.host)}</span></div>
            <div class="kv-line"><span class="key">Editor</span><span class="value">${escapeHtml(session.context.editor)}</span></div>
            <div class="kv-line"><span class="key">Active For</span><span class="value">${escapeHtml(session.activeForLabel)}</span></div>
          </div>
        </div>
      </div>

      <div class="action-row">
        <button class="focus-btn" ${session.headless ? "disabled" : ""}>Jump To Terminal</button>
      </div>
    </section>
  `;
}

function render(payload) {
  const sessions = payload && Array.isArray(payload.sessions) ? payload.sessions : [];
  if (sessions.length === 0) {
    listEl.innerHTML = `<div class="empty">No agent sessions to display.<br>When a session starts, it will appear here as a card.</div>`;
  } else {
    listEl.innerHTML = sessions.map(renderSession).join("");
  }

  for (const card of listEl.querySelectorAll(".session")) {
    const sessionId = card.getAttribute("data-session-id");
    const btn = card.querySelector(".focus-btn");
    const toggleBtn = card.querySelector('[data-role="toggle"]');
    if (btn && sessionId && !btn.disabled) {
      btn.addEventListener("click", () => {
        window.sessionPanelAPI.focusSession(sessionId);
      });
    }
    if (toggleBtn && sessionId) {
      toggleBtn.addEventListener("click", () => {
        if (expandedSessions.has(sessionId)) expandedSessions.delete(sessionId);
        else expandedSessions.add(sessionId);
        render(payload);
      });
    }
  }

  requestAnimationFrame(() => {
    const height = measurePanelHeight();
    if (height !== lastRequestedHeight) {
      lastRequestedHeight = height;
      window.sessionPanelAPI.resize(height);
    }
  });
}

function readPx(styles, prop) {
  const value = parseFloat(styles.getPropertyValue(prop));
  return Number.isFinite(value) ? value : 0;
}

function measureListContentHeight() {
  const listStyles = getComputedStyle(listEl);
  const gap = readPx(listStyles, "row-gap") || readPx(listStyles, "gap");
  const paddingY = readPx(listStyles, "padding-top") + readPx(listStyles, "padding-bottom");
  const childHeights = Array.from(listEl.children)
    .reduce((sum, child) => sum + Math.ceil(child.getBoundingClientRect().height), 0);
  const totalGap = Math.max(0, listEl.children.length - 1) * gap;
  return paddingY + childHeights + totalGap;
}

function measurePanelHeight() {
  const bodyStyles = getComputedStyle(document.body);
  const bodyPaddingY = readPx(bodyStyles, "padding-top") + readPx(bodyStyles, "padding-bottom");
  const panelBorderY = panelEl.offsetHeight - panelEl.clientHeight;
  const headerHeight = Math.ceil(headerEl.getBoundingClientRect().height);
  const listContentHeight = Math.ceil(measureListContentHeight());
  return Math.min(520, Math.max(220, bodyPaddingY + panelBorderY + headerHeight + listContentHeight));
}

async function refresh() {
  const payload = await window.sessionPanelAPI.getData();
  render(payload);
}

refresh();
setInterval(refresh, 1500);
