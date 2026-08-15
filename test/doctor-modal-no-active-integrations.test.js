"use strict";

// Behaviour-level verification for the #490 Doctor UI copy (recommendation B).
//
// formatAgentIntegrationSummary() and connectionDetailText() live inside the
// settings-doctor-modal IIFE closure, so there is no module export to import.
// We load the real source into a vm context and inject a single test-only seam
// that re-exports those closure-private render helpers, then drive them with the
// REAL settings-i18n strings. This exercises the actual rendering path (and the
// actual translations) without a screenshot or a full fake-DOM mount.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { SUPPORTED_LANGS } = require("../src/i18n");

const ROOT = path.join(__dirname, "..");
const SETTINGS_I18N = path.join(ROOT, "src", "settings-i18n.js");
const SETTINGS_DOCTOR_MODAL = path.join(ROOT, "src", "settings-doctor-modal.js");

function loadSettingsStrings() {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(SETTINGS_I18N, "utf8"), context);
  return context.ClawdSettingsI18n.STRINGS;
}

function loadModalTestHooks() {
  let source = fs.readFileSync(SETTINGS_DOCTOR_MODAL, "utf8");
  // Inject the seam right after the public API assignment, still inside the IIFE
  // scope so the closure-private helpers are in scope.
  const anchor = "  root.ClawdSettingsDoctorModal = {";
  assert.ok(source.includes(anchor), "modal public API anchor not found");
  source = source.replace(
    anchor,
    "  root.__doctorModalTestHooks = {\n"
    + "    formatAgentIntegrationSummary,\n"
    + "    connectionStatusClass,\n"
    + "    connectionStatusLabel,\n"
    + "    connectionDetailText,\n"
    + "    renderModalBody,\n"
    + "    overallClass,\n"
    + "    setState: (patch) => Object.assign(state, patch),\n"
    + "  };\n"
    + anchor
  );
  const context = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(source, context);
  assert.ok(context.__doctorModalTestHooks, "test hooks not exposed");
  return context.__doctorModalTestHooks;
}

function makeCore(strings, lang) {
  const dict = strings[lang];
  return {
    helpers: {
      // Return the raw value (count keys are functions; formatCount handles that).
      t: (key) => dict[key],
      escapeHtml: (value) => String(value == null ? "" : value),
    },
  };
}

const STRINGS = loadSettingsStrings();
const HOOKS = loadModalTestHooks();

function allInfoCheck() {
  return {
    id: "agent-integrations",
    status: "pass",
    level: null,
    details: [
      { agentId: "claude-code", agentName: "Claude Code", status: "manual-managed", level: "info" },
      { agentId: "codex", agentName: "Codex", status: "disabled", level: "info" },
      { agentId: "cursor", agentName: "Cursor", status: "not-installed", level: "info" },
    ],
  };
}

describe("doctor modal: no active integrations (#490 UI copy)", () => {
  it("leads the agent summary with the no-active-integrations nudge in every language", () => {
    for (const lang of SUPPORTED_LANGS) {
      const core = makeCore(STRINGS, lang);
      const summary = HOOKS.formatAgentIntegrationSummary(core, allInfoCheck());
      const nudge = STRINGS[lang].doctorAgentSummaryNoneActive;
      assert.ok(
        summary.startsWith(nudge),
        `${lang}: summary should lead with the nudge — got "${summary}"`
      );
      // The skipped count is still shown after the nudge.
      assert.ok(summary.includes("3"), `${lang}: skipped count missing — got "${summary}"`);
    }
  });

  it("does NOT show the nudge when a real problem coexists with info-only integrations", () => {
    const core = makeCore(STRINGS, "en");
    const mixed = {
      id: "agent-integrations",
      status: "warning",
      level: "warning",
      details: [
        {
          agentId: "claude-code",
          agentName: "Claude Code",
          status: "not-connected",
          level: "warning",
          fixAction: { type: "agent-integration", agentId: "claude-code" },
        },
        { agentId: "codex", agentName: "Codex", status: "disabled", level: "info" },
      ],
    };
    const summary = HOOKS.formatAgentIntegrationSummary(core, mixed);
    assert.ok(
      !summary.includes(STRINGS.en.doctorAgentSummaryNoneActive),
      `nudge must not appear alongside a warning — got "${summary}"`
    );
  });

  it("connectionDetailText swaps the raw no-activity detail for actionable guidance", () => {
    for (const lang of SUPPORTED_LANGS) {
      const core = makeCore(STRINGS, lang);
      const hint = HOOKS.connectionDetailText(core, { status: "no-activity", detail: "raw technical text" });
      assert.strictEqual(hint, STRINGS[lang].doctorConnectionNoActivityHint, `${lang}: no-activity hint`);
    }
    // Other statuses keep their original detail; no test falls back to instruction.
    const core = makeCore(STRINGS, "en");
    assert.strictEqual(
      HOOKS.connectionDetailText(core, { status: "http-verified", detail: "HTTP path verified (1 accepted event)." }),
      "HTTP path verified (1 accepted event)."
    );
    assert.strictEqual(HOOKS.connectionDetailText(core, null), STRINGS.en.doctorConnectionInstruction);
  });

  it("localizes the Codex hooks-need-review connection result in every language", () => {
    HOOKS.setState({ connectionTesting: false });
    const test = {
      status: "hooks-need-review",
      level: "warning",
      detail: "raw backend detail",
    };
    for (const lang of SUPPORTED_LANGS) {
      const core = makeCore(STRINGS, lang);
      assert.strictEqual(
        HOOKS.connectionStatusLabel(core, test),
        STRINGS[lang].doctorConnectionHooksNeedReview,
        `${lang}: hooks-need-review label`
      );
      assert.strictEqual(
        HOOKS.connectionDetailText(core, test),
        STRINGS[lang].doctorConnectionHooksNeedReviewHint,
        `${lang}: hooks-need-review hint`
      );
    }
    assert.strictEqual(HOOKS.connectionStatusClass(test), "warning");
    assert.notStrictEqual(
      HOOKS.connectionDetailText(makeCore(STRINGS, "zh"), test),
      test.detail,
      "localized UI must not expose the raw English backend detail"
    );
  });

  it("renders an all-disabled report as green (pass) with the nudge and hint, never critical", () => {
    const core = makeCore(STRINGS, "zh");
    HOOKS.setState({
      checksLoading: false,
      connectionTesting: false,
      connectionTest: { id: "hook-event-waterline", status: "no-activity", level: "warning", detail: "raw" },
      modalOpen: true,
    });
    const result = {
      generatedAt: "2026-06-14T00:00:00.000Z",
      overall: { status: "pass", level: null, issueCount: 0 },
      checks: [allInfoCheck()],
    };

    assert.strictEqual(HOOKS.overallClass(result), "pass");

    const html = HOOKS.renderModalBody(core, result, {});
    assert.ok(html.includes("doctor-overall pass"), "overall pill should be pass");
    assert.ok(!html.includes("doctor-overall critical"), "must not render critical");
    assert.ok(!html.includes(STRINGS.zh.doctorStatusCritical), "must not show the 严重 label");
    assert.ok(html.includes(STRINGS.zh.doctorAgentSummaryNoneActive), "agent nudge missing from body");
    assert.ok(html.includes(STRINGS.zh.doctorConnectionNoActivityHint), "no-activity hint missing from body");
  });
});
