"use strict";

// Focused harness for the Dashboard's session-history section. It rebuilds a
// minimal fake DOM rather than importing the one in
// test/session-renderer-behavior.test.js, so a drift in that file's expected
// node tree cannot mask a regression here.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describe, it } = require("node:test");
const { i18n } = require("../src/i18n");

class FakeClassList {
  constructor(element) { this.element = element; }
  add(...names) {
    const set = new Set(this.element.className.split(/\s+/).filter(Boolean));
    for (const name of names) set.add(name);
    this.element.className = [...set].join(" ");
  }
  remove(...names) {
    const drop = new Set(names);
    this.element.className = this.element.className
      .split(/\s+/).filter((n) => n && !drop.has(n)).join(" ");
  }
  toggle(name, force) {
    if (force) this.add(name);
    else this.remove(name);
  }
  contains(name) { return this.element.className.split(/\s+/).includes(name); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.style = {};
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  async dispatch(name) {
    const event = { stopPropagation() {}, preventDefault() {}, key: "" };
    for (const listener of this.listeners.get(name) || []) await listener(event);
  }
  querySelector() { return null; }
  replaceWith() {}
  focus() {}
  select() {}
}

function descendants(root) {
  const out = [];
  for (const child of root.children || []) out.push(child, ...descendants(child));
  return out;
}

function byClass(root, className) {
  return descendants(root).filter(
    (el) => el.classList && el.classList.contains(className),
  );
}

// Flattened text of a node tree, so assertions do not depend on how the
// renderer splits labels across elements and text nodes.
function textOf(node) {
  const own = typeof node.textContent === "string" ? node.textContent : "";
  return [own, ...(node.children || []).map(textOf)].join(" ").replace(/\s+/g, " ").trim();
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function loadDashboard({ sessions = [], history = [],
  resumeResult = { status: "submitted", retryAt: Date.now() + 30_000 } } = {}) {
  const elements = new Map(
    ["content", "title", "count", "quickBanner", "quotaSummary"]
      .map((id) => [id, new FakeElement("div")]),
  );
  const document = {
    title: "",
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new FakeElement("fragment"),
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    contains: () => true,
  };

  const resumeCalls = [];
  let historyCalls = 0;
  let snapshotListener = null;
  let renderInterval = null;

  const api = {
    getI18n: async () => ({ lang: "en", translations: { ...i18n.en } }),
    getSnapshot: async () => ({ sessions, groups: [] }),
    getKimiQuotaStatus: async () => null,
    getSessionHistory: async () => { historyCalls += 1; return typeof history === "function" ? history() : history; },
    resumeSession: async (payload) => { resumeCalls.push(payload); return typeof resumeResult === "function" ? resumeResult() : resumeResult; },
    onLangChange: () => {},
    onSessionSnapshot: (cb) => { snapshotListener = cb; },
    focusSession: () => {},
    hideSession: async () => ({ status: "ok" }),
    openSessionFolder: async () => ({ status: "ok" }),
    setSessionAlias: async () => ({ status: "ok" }),
    setSessionAutomationOverride: async () => ({ status: "ok" }),
    clearSessionAutomationGrant: async () => ({ status: "ok" }),
    ackCompletion: async () => ({ status: "ok" }),
  };

  const context = vm.createContext({
    window: { dashboardAPI: api }, document, console, Intl, Date,
    setInterval: (cb) => { renderInterval = cb; return 1; },
    requestAnimationFrame: (cb) => cb(),
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"),
    context,
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8"),
    context,
  );

  return {
    root: elements.get("content"),
    resumeCalls,
    getHistoryCalls: () => historyCalls,
    pushSnapshot: (next) => snapshotListener && snapshotListener(next),
    tickRender: () => { if (renderInterval) renderInterval(); },
  };
}

function historyRow(overrides = {}) {
  return {
    agentId: "claude-code",
    sessionId: "abc-123",
    cwd: "/Users/me/Workspace/thunderstone",
    title: "Rework the banner scheduler",
    lastState: "working",
    firstSeenAt: Date.now() - 600_000,
    lastEventAt: Date.now() - 120_000,
    endedAt: null,
    interrupted: true,
    transcriptPresent: true,
    ...overrides,
  };
}

describe("dashboard session history section", () => {
  it("keeps a submitted launch disabled until the real local session appears", async () => {
    const app = loadDashboard({ history: [historyRow()] });
    await flush();
    const oldButton = byClass(app.root, "session-history-resume")[0];
    await oldButton.dispatch("click");
    await oldButton.dispatch("click");
    await flush();
    assert.equal(app.resumeCalls.length, 1, "even a stale DOM click must be deduplicated");
    assert.equal(byClass(app.root, "session-history-resume")[0].disabled, true);
    app.tickRender();
    assert.equal(byClass(app.root, "session-history-resume")[0].disabled, true);
    app.pushSnapshot({ sessions: [{ id: "canonical", rawSessionId: "abc-123",
      agentId: "claude-code", profileId: "local" }], groups: [] });
    await flush();
    app.tickRender();
    assert.equal(byClass(app.root, "session-history-card").length, 0,
      "even a stale history reply cannot restore a live session's Resume card");
  });

  it("restores pending feedback after reopening and permits an explicit retry after timeout", async () => {
    const app = loadDashboard({ history: [historyRow({ resumePending: true,
      resumeRetryAt: Date.now() + 30_000 })] });
    await flush();
    assert.equal(byClass(app.root, "session-history-resume")[0].disabled, true);
    const expired = loadDashboard({ history: [historyRow({ resumePending: true,
      resumeRetryAt: Date.now() - 1 })] });
    await flush();
    assert.equal(byClass(expired.root, "session-history-resume")[0].disabled, false);
    assert.ok(textOf(expired.root).includes(i18n.en.dashboardHistoryNotConfirmed));
    assert.equal(expired.resumeCalls.length, 0, "timeout must never auto-retry");
  });

  it("queues a fresh read when the live set changes during an outstanding history read", async () => {
    let finish;
    let calls = 0;
    const app = loadDashboard({ history: () => ++calls === 1
      ? new Promise((resolve) => { finish = resolve; }) : [] });
    await flush();
    app.pushSnapshot({ sessions: [{ id: "new" }], groups: [] });
    finish([historyRow()]);
    await flush();
    assert.equal(calls, 2);
    assert.equal(byClass(app.root, "session-history-card").length, 0);
  });

  it("renders an interrupted row with its folder and a resume action", async () => {
    const app = loadDashboard({ history: [historyRow()] });
    await flush();

    const cards = byClass(app.root, "session-history-card");
    assert.equal(cards.length, 1);

    const title = byClass(app.root, "session-history-title")[0];
    assert.equal(title.textContent, "Rework the banner scheduler");

    const meta = textOf(byClass(app.root, "session-history-meta")[0]);
    assert.ok(meta.includes(i18n.en.dashboardHistoryInterrupted), meta);
    assert.ok(meta.includes("thunderstone"), "the folder basename orients the user");
    assert.ok(!meta.includes("/Users/me"), "the full path is not pasted into the row");

    const button = byClass(app.root, "session-history-resume")[0];
    assert.equal(button.textContent, i18n.en.dashboardHistoryResume);
    assert.equal(button.disabled, false);
  });

  it("sends only the agent and session id when resuming", async () => {
    const app = loadDashboard({ history: [historyRow()] });
    await flush();

    await byClass(app.root, "session-history-resume")[0].dispatch("click");
    await flush();

    assert.equal(app.resumeCalls.length, 1);
    // The working directory must be resolved in main from the store, never
    // chosen by the renderer.
    assert.deepEqual(app.resumeCalls[0], { agentId: "claude-code", sessionId: "abc-123" });
  });

  it("surfaces a failed resume without losing the row", async () => {
    const app = loadDashboard({
      history: [historyRow()],
      resumeResult: { status: "error", reason: "unresolvable" },
    });
    await flush();

    await byClass(app.root, "session-history-resume")[0].dispatch("click");
    await flush();

    const feedback = byClass(app.root, "session-history-feedback")[0];
    assert.ok(feedback, "a failure must be visible");
    assert.equal(feedback.textContent, i18n.en.dashboardHistoryResumeFailed);
    assert.equal(byClass(app.root, "session-history-card").length, 1);
  });

  it("flags a confidently missing transcript but still offers resume", async () => {
    const app = loadDashboard({ history: [historyRow({ transcriptPresent: false })] });
    await flush();

    const meta = textOf(byClass(app.root, "session-history-meta")[0]);
    assert.ok(meta.includes(i18n.en.dashboardHistoryTranscriptMissing), meta);
    assert.equal(byClass(app.root, "session-history-resume")[0].disabled, false);
  });

  it("says nothing when the probe could not tell", async () => {
    const app = loadDashboard({ history: [historyRow({ transcriptPresent: null })] });
    await flush();

    const meta = textOf(byClass(app.root, "session-history-meta")[0]);
    assert.ok(
      !meta.includes(i18n.en.dashboardHistoryTranscriptMissing),
      "unknown must not be reported as missing",
    );
  });

  it("shows the list on the empty dashboard, where it matters most", async () => {
    const app = loadDashboard({ sessions: [], history: [historyRow()] });
    await flush();

    assert.equal(byClass(app.root, "empty").length, 1, "the empty state still renders");
    assert.equal(byClass(app.root, "empty-with-history").length, 1,
      "history needs a compact empty state so Resume remains above the fold");
    assert.equal(byClass(app.root, "session-history-card").length, 1);
  });

  it("renders no section at all when there is nothing to resume", async () => {
    const app = loadDashboard({ sessions: [], history: [] });
    await flush();

    assert.equal(byClass(app.root, "session-history-card").length, 0);
    // With no history the empty state keeps its pre-existing node shape.
    assert.equal(app.root.children.length, 1);
    assert.ok(app.root.children[0].classList.contains("empty"));
    assert.ok(!app.root.children[0].classList.contains("empty-with-history"));
  });

  it("re-reads only when the live session set changes, not every tick", async () => {
    const app = loadDashboard({ history: [historyRow()] });
    await flush();
    const afterInit = app.getHistoryCalls();
    assert.equal(afterInit, 1);

    // The one-second render tick must never reach the disk.
    app.tickRender();
    app.tickRender();
    await flush();
    assert.equal(app.getHistoryCalls(), afterInit, "render ticks must not refetch");

    // An unchanged snapshot is not a reason to refetch either.
    app.pushSnapshot({ sessions: [], groups: [] });
    await flush();
    assert.equal(app.getHistoryCalls(), afterInit, "an identical session set must not refetch");

    // A session appearing or ending can change what is resumable.
    app.pushSnapshot({ sessions: [{ id: "local|claude-code|new" }], groups: [] });
    await flush();
    assert.equal(app.getHistoryCalls(), afterInit + 1, "a changed session set must refetch");
  });
});
