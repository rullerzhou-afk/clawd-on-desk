"use strict";

// Follow-up to #563 — the passive Kimi Code permission card renders
// tool-aware cues (real tool pill, command / file-path detail, irreversible
// hint) when the native PermissionRequest forwarded structured tool_input.
// bubble-renderer.js pulls in DOM globals at load time, so (per this repo's
// convention) we assert the relevant logic against the source string instead
// of instantiating it.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RENDERER_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "bubble-renderer.js"),
  "utf8"
);

function kimiBranch() {
  const start = RENDERER_SRC.indexOf('if (data.toolName === "KimiPermission")');
  assert.notStrictEqual(start, -1, "Kimi notify branch not found");
  const end = RENDERER_SRC.indexOf("return;", start);
  return RENDERER_SRC.slice(start, end);
}

describe("bubble-renderer Kimi tool-aware cue", () => {
  it("keeps KimiPermission as the branch discriminator", () => {
    // The literal keeps the passive card unreachable from the actionable
    // Allow/Deny path; the real tool name travels in separate display fields.
    assert.match(RENDERER_SRC, /if \(data\.toolName === "KimiPermission"\) \{/);
  });

  it("renders the rich cue only when BOTH the real tool name and structured input arrived", () => {
    const branch = kimiBranch();
    assert.match(
      branch,
      /const kimiTool = typeof data\.kimiToolName === "string" && data\.kimiToolName \? data\.kimiToolName : null;/
    );
    assert.match(
      branch,
      /const kimiInput = data\.kimiToolInput && typeof data\.kimiToolInput === "object" \? data\.kimiToolInput : null;/
    );
    assert.match(branch, /if \(kimiTool && kimiInput\) \{/);
  });

  it("reuses the standard cue path: formatDetail, MCP relabel, irreversible hint", () => {
    const branch = kimiBranch();
    assert.match(branch, /formatDetail\(kimiTool, kimiInput\)/);
    assert.match(branch, /parseMcpToolName\(kimiTool\)/);
    assert.match(branch, /detectIrreversible\(kimiTool, kimiInput\)/);
    // The pill shows the real tool so per-tool CSS (data-tool="Bash" etc.)
    // applies, exactly like Claude bubbles.
    assert.match(branch, /toolPill\.setAttribute\("data-tool", kimiTool\);/);
  });

  it("shows the irreversible badge when the cue's detection fires", () => {
    // Not just the detectIrreversible call — the badge render itself, so the
    // safety payoff can't be deleted without failing a test.
    const branch = kimiBranch();
    assert.match(branch, /if \(kimiIrreversible\) \{/);
    assert.match(branch, /irreversibleBadge\.setAttribute\("data-reason", kimiIrreversible\.tag\);/);
    assert.match(branch, /irreversibleBadge\.style\.display = "";/);
  });

  it("degrades to the old generic card when structured input is absent", () => {
    const branch = kimiBranch();
    // Legacy Python-CLI pulses and shape drift keep the exact pre-existing
    // rendering: KIMI pill + forwarded command or the generic terminal line.
    assert.match(branch, /toolPillText\.textContent = "KIMI";/);
    assert.match(branch, /toolPill\.setAttribute\("data-tool", "KimiPermission"\);/);
    const fallback = /\(data\.toolInput && data\.toolInput\.command\) \|\| bubbleText\(data\.lang, "checkKimiTerminal"\)/;
    assert.match(branch, fallback);
    // The rich path falls back through the same chain if formatDetail
    // returns nothing.
    assert.match(
      branch,
      /formatDetail\(kimiTool, kimiInput\)\s*\|\| \(data\.toolInput && data\.toolInput\.command\)\s*\|\| bubbleText\(data\.lang, "checkKimiTerminal"\)/
    );
  });

  it("stays passive while labeling its focus action truthfully", () => {
    const branch = kimiBranch();
    assert.match(branch, /btnAllow\.textContent = bubbleText\(data\.lang, "goToTerminal"\);/);
    assert.match(branch, /btnDeny\.style\.display = "none";/);
    assert.match(branch, /suggestionsContainer\.innerHTML = "";/);
    // No decision wiring inside the branch — display only.
    assert.doesNotMatch(branch, /bubbleAPI\.decide/);
  });

  it("writes cue text via textContent only", () => {
    const branch = kimiBranch();
    // The suggestions clear is the only innerHTML touch allowed.
    assert.doesNotMatch(
      branch.replace('suggestionsContainer.innerHTML = "";', ""),
      /innerHTML/
    );
    assert.match(branch, /commandBlock\.textContent = formatDetail/);
  });
});

// permission.js entry + payload plumbing is covered behaviorally in
// test/permission-notify-autoclose.test.js (entry fields, and the
// permission-show payload recorded off the fake window on refresh).
