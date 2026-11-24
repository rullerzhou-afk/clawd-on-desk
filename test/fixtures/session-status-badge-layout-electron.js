"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { applyZoomToWindow } = require("../../src/text-scale");
const { i18n, SUPPORTED_LANGS } = require("../../src/i18n");
const geometry = require("../../src/session-status-badge-geometry");

const SRC = path.resolve(__dirname, "../../src");
const css = fs.readFileSync(path.join(SRC, "session-status-badge.html"), "utf8").match(/<style>([\s\S]*?)<\/style>/)[1];
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="badgeShell" class="badge-shell" aria-live="polite"></div></body></html>`;

function snapshot(language) {
  const working = Array.from({ length: 18 }, (_, index) => ({
    id: `working-${index}`,
    state: index % 2 ? "thinking" : "working",
    badge: "running",
    headless: false,
  }));
  const done = Array.from({ length: 120 }, (_, index) => ({
    id: `done-${index}`,
    state: "idle",
    badge: "done",
    headless: false,
  }));
  const attention = {
    id: "input-1",
    state: "working",
    badge: "running",
    pendingAttention: true,
    headless: false,
  };
  const attentionSessions = Array.from({ length: 100 }, (_, index) => ({
    ...attention,
    id: `input-${index}`,
  }));
  return {
    sessions: [...working, ...done, ...attentionSessions],
    orderedIds: [
      ...working.map((session) => session.id),
      ...attentionSessions.map((session) => session.id),
      ...done.map((session) => session.id),
    ],
    collapsed: false,
    language,
  };
}

function outerSize(width, scale) {
  const shell = geometry.constants.STATUS_BADGE_SHELL;
  return {
    width: Math.round(width * scale)
      + Math.round(shell.left * scale)
      + Math.round(shell.right * scale),
    height: Math.round(geometry.constants.STATUS_BADGE_HEIGHT * scale)
      + Math.round(shell.top * scale)
      + Math.round(shell.bottom * scale),
  };
}

async function main() {
  app.setPath("userData", process.env.CLAWD_STATUS_BADGE_LAYOUT_PROFILE);
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 180,
    height: 70,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      sandbox: true,
    },
  });
  const failures = [];
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await win.webContents.executeJavaScript(`window.sessionStatusBadgeAPI = {
      onSnapshot(fn) { this.snapshot = fn; },
      onLangChange(fn) { this.lang = fn; },
      getI18n: async () => ({ lang: "en", translations: ${JSON.stringify(i18n.en)} }),
      toggleCollapsed: async () => ({ collapsed: !window.__collapsed }),
    }; void 0;`);
    for (const file of ["session-status-summary.js", "session-status-badge-renderer.js"]) {
      await win.webContents.executeJavaScript(`${fs.readFileSync(path.join(SRC, file), "utf8")}\nvoid 0;`);
    }
    for (const language of SUPPORTED_LANGS) {
      for (const collapsed of [false, true]) {
        for (const scale of [0.8, 1, 1.3, 1.6]) {
          const width = collapsed
            ? geometry.constants.STATUS_BADGE_COLLAPSED_WIDTH
            : geometry.constants.STATUS_BADGE_WIDTH;
          const size = outerSize(width, scale);
          win.setContentSize(size.width, size.height);
          applyZoomToWindow(win, scale);
          await win.webContents.__clawdTextZoomQueue;
          const translationPayload = { lang: language, translations: i18n[language] };
          const result = await win.webContents.executeJavaScript(`(async () => {
            const payload = ${JSON.stringify(snapshot(language))};
            sessionStatusBadgeAPI.lang(${JSON.stringify(translationPayload)});
            sessionStatusBadgeAPI.snapshot({ ...payload, collapsed: ${collapsed} });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const bodyRect = document.body.getBoundingClientRect();
            const shell = document.getElementById("badgeShell").getBoundingClientRect();
            const badge = document.querySelector(".status-badge");
            const badgeRect = badge.getBoundingClientRect();
            return {
              cssZoom: Number.parseFloat(getComputedStyle(document.documentElement).zoom),
              bodyRect: bodyRect.toJSON(),
              shellRect: shell.toJSON(),
              badgeRect: badgeRect.toJSON(),
              scrollWidth: badge.scrollWidth,
              clientWidth: badge.clientWidth,
              metrics: [...document.querySelectorAll(".metric")].map(metric => ({
                status: metric.dataset.status,
                text: metric.textContent,
                display: getComputedStyle(metric).display,
              })),
              title: badge.title,
            };
          })()`);
          try {
            assert.equal(result.cssZoom, scale);
            assert.equal(result.scrollWidth, result.clientWidth);
            assert.ok(result.badgeRect.left >= result.shellRect.left - 0.5);
            assert.ok(result.badgeRect.right <= result.shellRect.right + 0.5);
            assert.ok(result.badgeRect.bottom <= result.bodyRect.bottom + 0.5);
            assert.deepStrictEqual(
              result.metrics.map((metric) => metric.status),
              ["working", "done", "attention"]
            );
            assert.deepStrictEqual(
              result.metrics.map((metric) => metric.display !== "none"),
              collapsed ? [true, false, false] : [true, true, true]
            );
            assert.ok(result.title.includes(i18n[language][collapsed
              ? "sessionStatusBadgeExpandTooltip"
              : "sessionStatusBadgeCollapseTooltip"]));
          } catch (error) {
            failures.push({ language, collapsed, scale, result, reason: error.message });
          }
        }
      }
    }
    assert.deepStrictEqual(failures, []);
    if (process.env.CLAWD_STATUS_BADGE_SCREENSHOT) {
      const size = outerSize(geometry.constants.STATUS_BADGE_WIDTH, 1);
      win.setContentSize(size.width, size.height);
      applyZoomToWindow(win, 1);
      await win.webContents.__clawdTextZoomQueue;
      await win.webContents.executeJavaScript(`(async () => {
        sessionStatusBadgeAPI.lang(${JSON.stringify({ lang: "en", translations: i18n.en })});
        sessionStatusBadgeAPI.snapshot(${JSON.stringify({ ...snapshot("en"), collapsed: false })});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(process.env.CLAWD_STATUS_BADGE_SCREENSHOT, image.toPNG());
    }
    console.log(`Status badge layout: ${SUPPORTED_LANGS.length * 8} cases passed`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error(error.stack || error);
  app.exit(1);
});
