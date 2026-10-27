"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { applyZoomToWindow } = require("../../src/text-scale");
const { i18n, SUPPORTED_LANGS, createTranslator } = require("../../src/i18n");
const { makeSessionKey } = require("../../src/session-key");
const { buildSessionSnapshot } = require("../../src/state-session-snapshot");
const { getHudWidth, getHudWidthScale, computeHudOuterWidth } = require("../../src/session-hud").__test;
const { hasTaggedFallbackRow } = require("../../src/session-hud-tagged-fallback");

const SRC = path.resolve(__dirname, "../../src");
const css = fs.readFileSync(path.join(SRC, "session-hud.html"), "utf8").match(/<style>([\s\S]*?)<\/style>/)[1];
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="hud" id="hud"></div></body></html>`;
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";

function snapshotFor(language, flags, titled = false) {
  const sessions = new Map();
  for (const n of [1, 2]) {
    const rawSessionId = `codex:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const id = makeSessionKey({ profileId: "local", rawSessionId });
    sessions.set(id, {
      agentId: "codex", profileId: "local", rawSessionId,
      codexOriginator: "Codex Desktop", cwd: `C:\\fixture\\${flags.fixtureFolder || "非常长的同一项目目录-long-project-name"}`,
      state: flags.fixtureState || "thinking", updatedAt: Date.now() - 66_000,
      recentEvents: flags.fixtureEvent ? [{ event: flags.fixtureEvent, at: Date.now() - 66_000 }] : [],
      sessionTitle: titled ? "A real native title" : null,
    });
  }
  const snapshot = buildSessionSnapshot(sessions, {
    readCodexThreadName: () => null, focusHostPlatform: "win32", t: createTranslator(() => language),
  });
  for (const entry of snapshot.sessions) {
    entry.iconUrl = pixel;
    entry.canFocus = true;
    const percent = flags.fixtureFullContext ? 100 : 6;
    entry.contextUsage = { used: percent * 1000, limit: 100000, percent };
    if (flags.fixtureDone) {
      entry.state = "idle";
      entry.badge = "done";
      entry.updatedAt = Date.now() - 1000;
    }
    if (flags.fixtureUnfocusable) {
      entry.canFocus = false;
      entry.sourceType = "local";
      const tag = entry === snapshot.sessions[0] ? "bbbbbbbbbb" : "dddddddddd";
      entry.displayTitle = entry.displayTitle.slice(0, -entry.displaySessionTag.length) + tag;
      entry.displaySessionTag = tag;
    }
  }
  return Object.assign(snapshot, flags, { hudPinned: true });
}

async function main() {
  app.setPath("userData", process.env.CLAWD_HUD_LAYOUT_PROFILE);
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 450, height: 160,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, sandbox: true },
  });
  const cases = [];
  const failures = [];
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await win.webContents.executeJavaScript(`window.sessionHudAPI = {
      onLangChange(fn) { this.lang = fn; }, onSessionSnapshot(fn) { this.snapshot = fn; },
      getI18n: async () => ({ lang: "en", translations: ${JSON.stringify(i18n.en)} }),
      focusSession() {}, setPinned() {}, openDashboard() {}, ackCompletion: async () => {},
    }; window.settleLayout = () => new Promise(resolve => setTimeout(resolve, 75)); void 0;`);
    for (const file of ["session-focus-unavailable.js", "session-hud-tagged-fallback.js", "session-hud-renderer.js"]) {
      await win.webContents.executeJavaScript(`${fs.readFileSync(path.join(SRC, file), "utf8")}\nvoid 0;`);
    }
    for (const language of SUPPORTED_LANGS) {
      for (const scale of [0.8, 1, 1.6]) {
        for (const flags of [
          { hudShowStateLabels: true, hudShowElapsed: true, hudShowContextUsage: true },
          { hudShowStateLabels: true, hudShowElapsed: true, hudShowContextUsage: false },
          { hudShowStateLabels: false, hudShowElapsed: false, hudShowContextUsage: false },
          // Every remaining show-toggle combination. hudShowElapsed=false is the
          // tightest case: the HUD window narrows while the fallback tag still
          // needs its intrinsic width, which previously pushed the status label
          // under the pin at 160% text.
          { hudShowStateLabels: true, hudShowElapsed: false, hudShowContextUsage: false },
          { hudShowStateLabels: true, hudShowElapsed: false, hudShowContextUsage: true },
          { hudShowStateLabels: false, hudShowElapsed: true, hudShowContextUsage: false },
          { hudShowStateLabels: false, hudShowElapsed: true, hudShowContextUsage: true },
          { hudShowStateLabels: false, hudShowElapsed: false, hudShowContextUsage: true },
          // Short labels must stay adjacent to the suffix instead of filling
          // the entire title column and pushing the tag towards the chips.
          { hudShowStateLabels: true, hudShowElapsed: true, hudShowContextUsage: true, fixtureFolder: "repo" },
          { hudShowStateLabels: false, hudShowElapsed: false, hudShowContextUsage: false, fixtureFolder: "clawd-on-desk" },
          { hudShowStateLabels: true, hudShowElapsed: true, hudShowContextUsage: true, fixtureFolder: "i" },
          ...[
            { fixtureState: "working" }, { fixtureState: "juggling" },
            { fixtureEvent: "PreCompact" }, { fixtureEvent: "PermissionRequest" },
            { fixtureEvent: "WorktreeCreate" },
          ].map((status) => ({ hudShowStateLabels: true, hudShowElapsed: false,
            hudShowContextUsage: true, fixtureUnfocusable: true, fixtureFullContext: true, ...status })),
          ...(scale === 1.6 ? [
            { hudShowStateLabels: true, hudShowElapsed: true, hudShowContextUsage: true, fixtureDone: true },
            { hudShowStateLabels: true, hudShowElapsed: true, hudShowContextUsage: true, fixtureUnfocusable: true },
            { hudShowStateLabels: true, hudShowElapsed: false, hudShowContextUsage: true, fixtureDone: true },
            { hudShowStateLabels: true, hudShowElapsed: false, hudShowContextUsage: true, fixtureUnfocusable: true },
            { hudShowStateLabels: true, hudShowElapsed: true, hudShowContextUsage: true, fixtureUnfocusable: true, fixtureFullContext: true },
            { hudShowStateLabels: true, hudShowElapsed: false, hudShowContextUsage: true, fixtureUnfocusable: true, fixtureFullContext: true },
          ] : []),
        ]) {
          const snapshot = snapshotFor(language, flags);
          const hasTaggedFallback = hasTaggedFallbackRow(snapshot.sessions);
          win.setContentSize(computeHudOuterWidth(getHudWidth(flags.hudShowElapsed, flags.hudShowStateLabels,
            flags.hudShowContextUsage, hasTaggedFallback), scale, getHudWidthScale(scale, hasTaggedFallback)), 160);
          applyZoomToWindow(win, scale);
          await win.webContents.__clawdTextZoomQueue;
          const rows = await win.webContents.executeJavaScript(`(async () => {
            sessionHudAPI.lang(${JSON.stringify({ lang: language, translations: i18n[language] })});
            sessionHudAPI.snapshot(${JSON.stringify(snapshot)});
            updateElapsedLabels();
            await settleLayout();
            return { cssZoom: Number.parseFloat(getComputedStyle(document.documentElement).zoom),
              rows: [...document.querySelectorAll(".row")].map(row => {
              const rect = selector => row.querySelector(selector)?.getBoundingClientRect().toJSON();
              const label = row.querySelector(".title-fallback-label");
              const tag = row.querySelector(".title-fallback-tag");
              const labelRange = document.createRange();
              labelRange.selectNodeContents(label);
              const separatorRange = document.createRange();
              separatorRange.setStart(tag.firstChild, 1);
              separatorRange.setEnd(tag.firstChild, 2);
              return { title: rect(".title"), tag: rect(".title-fallback-tag"), left: rect(".left"),
                labelGlyphs: labelRange.getBoundingClientRect().toJSON(),
                labelClipped: label.scrollWidth > label.clientWidth,
                label: rect(".title-fallback-label"),
                labelFontSize: Number.parseFloat(getComputedStyle(label).fontSize),
                separator: separatorRange.getBoundingClientRect().toJSON(),
                right: rect(".right"), row: row.getBoundingClientRect().toJSON(),
                contentRight: row.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(row).paddingRight)
                  * Number.parseFloat(getComputedStyle(document.documentElement).zoom),
                chips: [...row.querySelectorAll(".state-chip, .usage-chip, .completion-bell, .focus-unavailable, .open-folder-button")]
                  .map(chip => chip.getBoundingClientRect().toJSON()),
                stateChips: [...row.querySelectorAll(".state-chip")]
                  .map(chip => chip.getBoundingClientRect().toJSON()),
                pin: document.querySelector(".pin-btn").getBoundingClientRect().toJSON(),
                glyphs: (() => { const range = document.createRange(); range.selectNodeContents(row.querySelector(".title-fallback-tag"));
                  return range.getBoundingClientRect().toJSON(); })(),
                tagClientWidth: row.querySelector(".title-fallback-tag").clientWidth,
                tagScrollWidth: row.querySelector(".title-fallback-tag").scrollWidth,
                tagText: row.querySelector(".title-fallback-tag")?.textContent,
                elapsedText: row.querySelector(".elapsed")?.textContent };
            }) };
          })()`);
          const sample = { language, scale, flags, contentSize: win.getContentSize(), cssZoom: rows.cssZoom, rows: rows.rows };
          cases.push(sample);
          try {
            assert.equal(rows.cssZoom, scale, "audit the actual applied CSS zoom");
            assert.equal(rows.rows.length, 2);
            assert.equal(new Set(rows.rows.map(row => row.tagText)).size, 2, "same-CWD rows retain distinct tags");
            for (const row of rows.rows) {
              assert.ok(row.tag, "fallback must use a separately protected tag");
              assert.ok(row.tag.right <= row.title.right + 0.5, "tag overflows the clipped title box");
              assert.ok(row.tag.left >= row.title.left - 0.5, "tag starts outside the title box");
              assert.ok(row.glyphs.right <= row.tag.right + 0.5 && row.glyphs.left >= row.tag.left - 0.5,
                "tag glyphs overflow their own span");
              assert.ok(row.tagScrollWidth <= row.tagClientWidth + 1, "tag text is internally clipped");
              assert.ok(row.separator.left > row.tag.left + 0.5 * scale,
                "the leading separator space must remain visible");
              if (flags.fixtureFolder && !row.labelClipped) {
                assert.ok(Math.abs(row.tag.left - row.labelGlyphs.right) <= 0.5,
                  "a short folder label must remain adjacent to the suffix");
              }
              if (row.labelClipped) assert.ok(row.label.width >= row.labelFontSize * scale - 0.5,
                "a truncated folder label must have room for its ellipsis");
              assert.ok(row.title.right <= row.left.right + 0.5, "title overflows the left flex item");
              if (row.right) assert.ok(row.left.right <= row.right.left + 0.5, "title and secondary information overlap");
              assert.ok(row.tag.right <= row.contentRight + 0.5, "tag leaves the visible row content");
              if (row.right) assert.ok(row.right.right <= row.contentRight + 0.5, "secondary container leaves the visible row content");
              for (const chip of row.chips) {
                assert.ok(chip.left >= row.right.left - 0.5 && chip.right <= row.right.right + 0.5,
                  "a mandatory chip is clipped by the secondary container");
                assert.ok(!(chip.left < row.pin.right && chip.right > row.pin.left
                  && chip.top < row.pin.bottom && chip.bottom > row.pin.top), "a mandatory chip overlaps the pin");
              }
              // The state chip sits inside .right, which is pinned right of the
              // title. A too-narrow HUD window pushed .right under the pin.
              for (const chip of row.stateChips) {
                assert.ok(!(chip.left < row.pin.right && chip.right > row.pin.left
                  && chip.top < row.pin.bottom && chip.bottom > row.pin.top),
                  "the status label overlaps the pin");
              }
              assert.ok(snapshot.sessions.some(entry => row.tagText.endsWith(entry.displaySessionTag)));
              if (flags.hudShowElapsed && !flags.fixtureDone) assert.ok(row.elapsedText.includes("1"), "exercise a real >1 minute label");
            }
          } catch (error) { failures.push({ ...sample, reason: error.message }); }
        }
      }
    }
    // Formal titles do not inherit the reserved fallback width or hash display.
    const named = snapshotFor("en", { hudShowStateLabels: true }, true);
    const tagCount = await win.webContents.executeJavaScript(`sessionHudAPI.snapshot(${JSON.stringify(named)});
      document.querySelectorAll(".title-fallback-tag").length;`);
    assert.equal(tagCount, 0);
    if (process.env.CLAWD_HUD_LAYOUT_REPORT) {
      fs.writeFileSync(process.env.CLAWD_HUD_LAYOUT_REPORT, JSON.stringify({ cases, failures }, null, 2));
    }
    console.log(`HUD fallback layout: ${cases.length} cases, ${failures.length} failures`);
    assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 4)));
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch(error => { console.error(error.stack || error); app.exit(1); });
