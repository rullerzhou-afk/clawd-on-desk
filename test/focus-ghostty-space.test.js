// test/focus-ghostty-space.test.js — Ghostty focus must not yank windows
// across macOS Spaces.
//
// Mechanism (confirmed by on-device experiments): bringing an OFF-SCREEN
// NSWindow on-screen attaches it to the *current* Space. Both Ghostty's
// `focus` (makeKeyAndOrderFront) AND `select tab` (native tab swap) do this
// when the target terminal lives in a non-selected tab of a window on
// another Space — the window gets yanked to the user instead of the user
// switching Spaces. The ONLY verified-safe operation is focusing a terminal
// in the window's currently-SELECTED tab, which switches Spaces correctly.
//
// Fix ("stepping-stone"): a read-only probe locates the target. If its tab
// is selected, focus it directly. If not, focus the terminal in the window's
// selected tab first (verified-safe Space switch), then focus the target —
// the tab swap now happens within the active Space, so nothing is yanked.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { __test } = require("../src/focus")({});

function assertReadOnlyProbe(script, label) {
  assert.ok(!/\bfocus \w+/.test(script), `${label}: probe must not focus\n${script}`);
  assert.ok(!/select tab/.test(script), `${label}: probe must not select tabs\n${script}`);
  assert.ok(/return "direct:"/.test(script), `${label}: should report direct:<id> when tab is selected\n${script}`);
  assert.ok(/"via:" &/.test(script), `${label}: should report the stepping-stone terminal id\n${script}`);
  assert.ok(/selected tab of \w+/.test(script), `${label}: stepping stone comes from the window's selected tab\n${script}`);
}

describe("Ghostty probe scripts are read-only and report a stepping stone", () => {
  it("id probe reports direct/via/miss without touching the UI", () => {
    const script = __test.buildGhosttyIdProbeScript("term-42");
    assert.ok(script.includes("term-42"));
    assertReadOnlyProbe(script, "id probe");
  });

  it("cwd probe reports direct/via/miss without touching the UI", () => {
    const script = __test.buildGhosttyCwdProbeScript(["/some/cwd"]);
    assert.ok(script.includes("/some/cwd"));
    assertReadOnlyProbe(script, "cwd probe");
  });
});

describe("Ghostty focus scripts stay flat and atomic (legacy behaviour)", () => {
  it("id focus script uses the flat application-level terminals collection", () => {
    const script = __test.buildGhosttyIdFocusScript("term-42");
    assert.ok(script.includes("term-42"));
    assert.ok(/repeat with \w+ in terminals\s*$/m.test(script), `should iterate flat terminals\n${script}`);
    assert.ok(!/select tab/.test(script), `must not select tabs\n${script}`);
    assert.ok(/\bfocus \w+/.test(script), `should focus the matched terminal\n${script}`);
  });

  it("cwd focus script uses the flat whose query", () => {
    const script = __test.buildGhosttyCwdFocusScript(["/some/cwd"]);
    assert.ok(script.includes("/some/cwd"));
    assert.ok(/every terminal whose working directory/.test(script), `should use the flat whose query\n${script}`);
    assert.ok(!/select tab/.test(script), `must not select tabs\n${script}`);
  });
});
