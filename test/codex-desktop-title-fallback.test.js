"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createTranslator, i18n, SUPPORTED_LANGS } = require("../src/i18n");
const { makeSessionKey } = require("../src/session-key");
const { sessionAliasKey } = require("../src/session-alias");
const {
  buildSessionSnapshot, buildDisplaySessionTag, sessionDisplayTitle, sessionSnapshotSignature,
} = require("../src/state-session-snapshot");
const { resolveCodexOfficialHookState } = require("../src/server-codex-official-turns");
const CodexSubagentClassifier = require("../agents/codex-subagent-classifier");
const { createSettingsController } = require("../src/settings-controller");
const createSettingsEffectRouter = require("../src/settings-effect-router");
const prefs = require("../src/prefs");
const themeLoader = require("../src/theme-loader");

const rawA = "codex:00000000-0000-4000-8000-000000000001";
const rawB = "codex:00000000-0000-4000-8000-000000000002";
const idA = makeSessionKey({ profileId: "local", rawSessionId: rawA });
const idB = makeSessionKey({ profileId: "local", rawSessionId: rawB });
const options = { readCodexThreadName: () => null, focusHostPlatform: "win32" };

function desktop(overrides = {}) {
  return {
    agentId: "codex", profileId: "local", rawSessionId: rawA,
    codexOriginator: "Codex Desktop", cwd: "C:\\workspace\\project",
    state: "working", updatedAt: 1234, agentPid: 9876, sourcePid: 9876,
    recentEvents: [{ event: "PreToolUse", at: 1234 }], ...overrides,
  };
}

describe("Codex Desktop untitled display fallback", () => {
  it("keeps same-folder threads distinct with stable tags and unchanged folder/focus metadata", () => {
    const sessions = new Map([[idA, desktop()], [idB, desktop({ rawSessionId: rawB })]]);
    const before = JSON.stringify([...sessions]);
    const snapshot = buildSessionSnapshot(sessions, options);
    assert.equal(snapshot.sessions.length, 2);
    assert.notEqual(snapshot.sessions[0].displayTitle, snapshot.sessions[1].displayTitle);
    for (const entry of snapshot.sessions) {
      assert.equal(entry.displayTitle, `Codex chat · ${buildDisplaySessionTag(entry.id)}`);
      assert.equal(entry.sessionTitle, null, "a display label is not a native chat title");
      assert.equal(entry.displayFolder, "project");
      assert.equal(entry.cwd, "C:\\workspace\\project");
      assert.equal(entry.hiddenFromHud, false);
      assert.equal(entry.canFocus, true);
      assert.equal(entry.focusTarget.type, "codex-thread");
      assert.equal(entry.displaySessionTag, buildDisplaySessionTag(entry.id));
    }
    assert.equal(JSON.stringify([...sessions]), before);
    assert.deepEqual(buildSessionSnapshot(sessions, options), snapshot);
  });

  it("keeps alias, index and stored titles ahead of the fallback, including a real title equal to the folder", () => {
    const entry = desktop({ sessionTitle: "Stored title" });
    assert.equal(sessionDisplayTitle(idA, entry, {}, options), "Stored title");
    const indexed = { ...options, readCodexThreadName: () => "Native title" };
    assert.equal(sessionDisplayTitle(idA, entry, {}, indexed), "Native title");
    const aliases = { [sessionAliasKey(null, "codex", rawA)]: { title: "My alias" } };
    assert.equal(sessionDisplayTitle(idA, entry, aliases, indexed), "My alias");
    assert.equal(sessionDisplayTitle(idA, desktop({ sessionTitle: "project" }), {}, options), "project");
  });

  it("adopts a late native title on the same row without changing activity, state or session data", () => {
    const original = desktop();
    const sessions = new Map([[idA, original]]);
    const before = JSON.stringify(original);
    const pending = buildSessionSnapshot(sessions, options);
    const named = buildSessionSnapshot(sessions, { ...options, readCodexThreadName: () => "Native title" });
    assert.deepEqual(named.orderedIds, pending.orderedIds);
    assert.equal(named.sessions[0].displayTitle, "Native title");
    for (const field of ["id", "rawSessionId", "updatedAt", "state", "badge", "lastEvent", "focusTarget", "cwd"]) {
      assert.deepEqual(named.sessions[0][field], pending.sessions[0][field], field);
    }
    assert.notEqual(sessionSnapshotSignature(named), sessionSnapshotSignature(pending));
    assert.equal(JSON.stringify(original), before);
  });

  it("does not infer a sidechat from transcript absence or read prompt content", () => {
    const tag = buildDisplaySessionTag(idA);
    for (const transcriptPath of [null, "C:\\synthetic\\rollout.jsonl"]) {
      const entry = desktop({ transcriptPath });
      Object.defineProperty(entry, "prompt", { get() { throw new Error("prompt must not be read"); } });
      assert.equal(sessionDisplayTitle(idA, entry, {}, options), `Codex chat · ${tag}`);
    }
    assert.equal(sessionDisplayTitle(idA, desktop({ codexOriginator: null }), {}, options), "project");
  });

  it("localizes the shared label in every language without changing the stable tag", () => {
    const tag = buildDisplaySessionTag(idA);
    let lang = "zh";
    const t = createTranslator(() => lang);
    for (lang of SUPPORTED_LANGS) {
      const label = sessionDisplayTitle(idA, desktop(), {}, { ...options, t });
      assert.equal(label, i18n[lang].sessionCodexUntitled.replace("{tag}", tag));
      assert.ok(label.endsWith(tag));
    }
    lang = "zh";
    assert.equal(sessionDisplayTitle(idA, desktop(), {}, { ...options, t }), `Codex 对话 · ${tag}`);
  });

  for (const [label, overrides] of [
    ["CLI originator", { codexOriginator: "codex-tui" }],
    ["unknown originator", { codexOriginator: "unknown-client" }],
    ["malformed originator", { codexOriginator: {} }],
    ["another agent", { agentId: "claude-code" }],
    ["headless", { headless: true }],
    ["remote host", { host: "devbox" }],
    ["remote profile", { profileId: "remote-profile" }],
    ["WSL distro", { wslDistro: "Ubuntu" }],
    ["WSL host", { host: "wsl:Ubuntu" }],
    ...["cli", "codex-cli", "codex-tui", " CLI ", "exec", "internal", "subagent", "agent-subagent"].map((codexSource) => [codexSource, { codexSource }]),
    ["structured child source", { codexSource: { subagent: {} } }],
  ]) {
    it(`preserves the existing folder fallback for ${label}`, () => {
      assert.equal(sessionDisplayTitle(idA, desktop(overrides), {}, options), "project");
    });
  }

  it("keeps officially classified child state on the existing headless/folder path", () => {
    const state = resolveCodexOfficialHookState({
      agent_id: "codex", hook_source: "codex-official", event: "UserPromptSubmit",
      session_id: rawA, codex_session_role: "subagent",
    }, "thinking", new Map(), new CodexSubagentClassifier());
    assert.equal(state.headless, true);
    const snapshot = buildSessionSnapshot(new Map([[idA, desktop(state)]]), options);
    assert.equal(snapshot.sessions[0].displayTitle, "project");
    assert.equal(snapshot.hudTotalNonIdle, 0);
  });
});

// Run the real row builder with synthetic DOM elements; no Electron/GUI/input.
function renderRow(entry, feedback = "", language = "zh") {
  const source = fs.readFileSync(path.join(__dirname, "../src/session-hud-renderer.js"), "utf8");
  const names = ["titleFor", "untitledCodexTag", "titleUnits", "shortenHudTitle", "createRowForSession"];
  const functions = names.map((name) => {
    const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, name);
    return match[0];
  }).join("\n");
  const element = () => ({
    children: [], className: "", classList: { add() {} }, dataset: {},
    appendChild(child) { this.children.push(child); }, setAttribute() {}, addEventListener() {},
  });
  const context = {
    document: { createElement: element }, t: createTranslator(() => language),
    HUD_TITLE_MAX_UNITS: 15, snapshot: { hudShowElapsed: false }, unreadSessions: new Set(),
    sessionFeedbackText: () => feedback, stateChipInfo: () => null, usageChipInfo: () => null,
  };
  vm.runInNewContext(`${functions}\nrow = createRowForSession(entry, 1234);`, Object.assign(context, { entry }));
  return context.row.children[0].children.find((child) => child.className.startsWith("title"));
}

describe("compact HUD fallback suffix", () => {
  it("renders the complete shared tag independently of ordinary title shortening", () => {
    const snapshot = buildSessionSnapshot(new Map([[idA, desktop()], [idB, desktop({ rawSessionId: rawB })]]), {
      ...options, t: createTranslator(() => "zh"),
    });
    for (const entry of snapshot.sessions) {
      const title = renderRow(entry);
      assert.equal(title.children[1].className, "title-fallback-tag");
      assert.equal(title.children[1].textContent, entry.displaySessionTag);
      assert.equal(title.children.map((child) => child.textContent).join(""), entry.displayTitle);
      assert.equal(title.title, entry.displayTitle);
    }
    const html = fs.readFileSync(path.join(__dirname, "../src/session-hud.html"), "utf8");
    assert.match(html, /\.title-fallback-tag\s*\{[^}]*flex:\s*0 0 auto/);
  });

  it("preserves normal titles, aliases and inline action feedback", () => {
    const tag = buildDisplaySessionTag(idA);
    const label = `Codex 对话 · ${tag}`;
    for (const entry of [
      { displayTitle: label, displaySessionTag: tag, sessionTitle: label },
      { displayTitle: label, displaySessionTag: tag, hasAlias: true },
      { displayTitle: "Ordinary chat title" },
    ]) {
      const title = renderRow({ ...entry, id: idA, canFocus: true });
      assert.equal(title.children.length, 0);
      assert.ok(title.textContent);
    }
    const title = renderRow({ displayTitle: label, displaySessionTag: tag, id: idA, canFocus: true }, "Action failed");
    assert.equal(title.textContent, "Action failed");
    assert.equal(title.children.length, 0);
  });
});

describe("settings language change for an idle untitled Desktop row", () => {
  it("broadcasts fresh localized labels after dictionaries, preserving the tag, identity and inactivity", () => {
    // Real controller/store/validators and real state snapshot owner; settings
    // stay memory-only and rendering uses synthetic DOM, with no Electron UI.
    const controller = createSettingsController({
      loadResult: { snapshot: prefs.getDefaults(), locked: false },
    });
    const calls = [];
    const delivered = [];
    let rendererLang = "en";
    themeLoader.init(path.join(__dirname, "../src"));
    const ctx = {
      lang: "en", theme: themeLoader.loadTheme("clawd"), focusHostPlatform: "win32",
      broadcastSessionSnapshot(snapshot) {
        calls.push("snapshot");
        delivered.push(snapshot);
      },
    };
    ctx.t = createTranslator(() => ctx.lang);
    const state = require("../src/state")(ctx);
    const idle = desktop({ state: "idle", lastStopAt: 1234, recentEvents: [{ event: "Stop", at: 1234 }] });
    Object.defineProperty(idle, "prompt", { get() { throw new Error("language refresh must not read prompt"); } });
    state.sessions.set(idA, idle);
    const before = JSON.stringify(idle);
    const router = createSettingsEffectRouter({
      settingsController: controller,
      BrowserWindow: { getAllWindows: () => [] },
      updateMirrors(changes) {
        calls.push("mirrors");
        if ("lang" in changes) ctx.lang = changes.lang;
      },
      sendDashboardI18n: () => calls.push("dashboard-dictionary"),
      sendSessionHudI18n() {
        calls.push("hud-dictionary");
        rendererLang = controller.get("lang");
      },
      syncWindowTitles: () => calls.push("window-titles"),
      emitSessionSnapshot(options) {
        assert.equal(options.force, true);
        state.emitSessionSnapshot(options);
      },
    });
    router.start();
    try {
      state.emitSessionSnapshot({ force: true });
      const initial = delivered.at(-1).sessions[0];
      const tag = initial.displaySessionTag;
      assert.equal(renderRow(initial, "", rendererLang).children[1].textContent, tag);
      for (const lang of ["zh", "ja"]) {
        calls.length = 0;
        const count = delivered.length;
        assert.deepEqual(controller.applyUpdate("lang", lang), { status: "ok" });
        assert.deepEqual(calls, ["mirrors", "dashboard-dictionary", "hud-dictionary", "window-titles", "snapshot"]);
        assert.equal(delivered.length, count + 1);
        const entry = delivered.at(-1).sessions[0];
        assert.equal(entry.displayTitle, i18n[lang].sessionCodexUntitled.replace("{tag}", tag));
        assert.equal(renderRow(entry, "", rendererLang).children[1].textContent, tag);
        for (const field of ["id", "rawSessionId", "displaySessionTag", "updatedAt", "state", "badge", "lastEvent", "cwd", "focusTarget"]) {
          assert.deepEqual(entry[field], initial[field], field);
        }
        assert.equal(JSON.stringify(idle), before);
        assert.equal(state.sessions.size, 1);
      }

      assert.equal(state.updateSessionMetadata(idA, { sessionTitle: "Native title", expectedAgentId: "codex" }), true);
      assert.deepEqual(controller.applyUpdate("lang", "ko"), { status: "ok" });
      const named = delivered.at(-1).sessions[0];
      assert.equal(named.displayTitle, "Native title");
      assert.equal(renderRow(named, "", rendererLang).children.length, 0);
      assert.equal(named.id, initial.id);
      assert.equal(named.state, "idle");
      assert.equal(named.updatedAt, initial.updatedAt);
      assert.deepEqual(named.lastEvent, initial.lastEvent);
      assert.equal(state.sessions.size, 1);
    } finally {
      router.dispose();
      state.cleanup();
    }
  });
});
