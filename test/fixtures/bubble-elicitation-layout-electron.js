"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, protocol } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..");
const BUBBLE_CSS = fs.readFileSync(path.join(ROOT, "src", "bubble.css"), "utf8");
const TEXT_SCALE = 1.25;

protocol.registerSchemesAsPrivileged([
  { scheme: "clawd-bubble-layout", privileges: { standard: true, secure: true } },
]);

function option(label, description, inputType) {
  return `<label class="option-item"><input type="${inputType}"><span class="option-item-copy">`
    + `<span class="option-item-label">${label}</span>`
    + `<span class="option-item-description">${description}</span></span></label>`;
}

function pageHtml(kind) {
  const multi = kind === "multi";
  const inputType = multi ? "checkbox" : "radio";
  const title = multi
    ? "Which validation targets should be required before release?"
    : "Choose the preferred implementation approach for the expanded permission card.";
  const options = [
    ["Keep the existing layout", "Retain the current structure and verify its behavior on every supported desktop platform."],
    ["Use one outer scroller", "Keep every part of the interactive form in normal document flow inside one scroll area."],
    ["Test fractional scaling", "Cover Windows device scaling and the independent per-display Clawd text scale."],
    ["Preserve keyboard input", "Keep radio, checkbox, textarea, and IME behavior intact while the detail content scrolls."],
    ["Verify long content", "Exercise enough option content to exceed the expanded card's fixed viewport from first paint."],
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BUBBLE_CSS}</style></head><body>`
    + `<div class="card expanded visible" id="card">`
    + `<div class="header"><div class="header-copy"><span class="header-title">Needs Input</span>`
    + `<span class="tool-pill"><span class="tool-pill-text">AskUserQuestion</span></span></div>`
    + `<button class="collapse-button">Collapse</button></div>`
    + `<div class="session-tag visible">animation · #948</div>`
    + `<div class="compact-block"></div><div class="detail-truncation"></div>`
    + `<div class="detail-scroll" id="detailScroll"><div class="command-block" style="display:none"></div>`
    + `<div class="elicitation-form visible" id="elicitationForm"><div class="question-card">`
    + `<div class="question-header">Question ${multi ? "2" : "1"}</div>`
    + `<div class="question-text">${title}</div>`
    + `<div class="question-hint">${multi ? "Choose at least one option" : "Choose one option"}</div>`
    + `<div class="option-list">${options.map(([label, description]) => (
      option(label, description, inputType)
    )).join("")}</div></div></div>`
    + `<div class="elicitation-progress visible" id="elicitationProgress">${multi ? "2" : "1"} / 2</div></div>`
    + `<button class="btn-expand"></button><div class="plan-feedback-form"></div>`
    + `<div class="actions"><button class="btn btn-allow">${multi ? "Submit Answer" : "Next"}</button>`
    + `<button class="btn btn-deny">Previous</button></div><div class="suggestions"></div>`
    + `<div class="footer-secondary visible"><button class="btn-suggestion">Go to Terminal</button></div>`
    + `</div></body></html>`;
}

async function readLayout(win) {
  return win.webContents.executeJavaScript(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const detail = document.getElementById("detailScroll");
      const form = document.getElementById("elicitationForm");
      const progress = document.getElementById("elicitationProgress");
      const question = form.querySelector(".question-card");
      const descendantBottom = (root) => Math.max(
        root.getBoundingClientRect().bottom,
        ...Array.from(root.querySelectorAll("*")).map((node) => node.getBoundingClientRect().bottom)
      );
      const formContentBottom = descendantBottom(form);
      const questionContentBottom = descendantBottom(question);
      resolve({
        detailClientHeight: detail.clientHeight,
        detailScrollHeight: detail.scrollHeight,
        formContentBottom,
        progressTop: progress.getBoundingClientRect().top,
        questionBottom: question.getBoundingClientRect().bottom,
        questionContentBottom,
      });
    }));
  })`);
}

async function verifyKind(win, kind) {
  await win.loadURL(`clawd-bubble-layout://fixture/${kind}`);
  await win.webContents.insertCSS(
    `:root { zoom: ${TEXT_SCALE} !important; --clawd-text-zoom: ${TEXT_SCALE}; }`
  );
  const layout = await readLayout(win);
  assert.ok(
    layout.detailScrollHeight > layout.detailClientHeight + 1,
    `${kind}: fixture must exercise the outer overflow path (${JSON.stringify(layout)})`
  );
  assert.ok(
    layout.progressTop + 0.5 >= layout.formContentBottom,
    `${kind}: progress overlaps form descendants (${JSON.stringify(layout)})`
  );
  assert.ok(
    layout.questionBottom + 0.5 >= layout.questionContentBottom,
    `${kind}: options paint outside the question card (${JSON.stringify(layout)})`
  );
}

async function main() {
  await app.whenReady();
  protocol.handle("clawd-bubble-layout", (request) => {
    const kind = new URL(request.url).pathname.slice(1) === "multi" ? "multi" : "single";
    return new Response(pageHtml(kind), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
  const win = new BrowserWindow({
    show: false,
    width: 625,
    height: 662,
    webPreferences: { backgroundThrottling: false },
  });
  try {
    await verifyKind(win, "single");
    await verifyKind(win, "multi");
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main()
  .then(() => app.quit())
  .catch((err) => {
    console.error(err && err.stack || err);
    app.exit(1);
  });
