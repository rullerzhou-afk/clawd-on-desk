"use strict";

// Issue #445 — Codex MCP tool calls were rendered as generic "Permission
// Request" bubbles, which read like an OS permission prompt. bubble-renderer.js
// pulls in DOM globals at load time, so (per this repo's convention) we assert
// the relevant logic against the source string instead of instantiating it.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { SUPPORTED_LANGS } = require("../src/i18n");

const RENDERER_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "bubble-renderer.js"),
  "utf8"
);
const PERMISSION_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "permission.js"),
  "utf8"
);

describe("bubble-renderer MCP labeling (issue #445)", () => {
  it("imports the display-only MCP parser from bubble-format", () => {
    assert.match(
      RENDERER_SRC,
      /const \{[^}]*\bparseMcpToolName\b[^}]*\} = window\.ClawdBubbleFormat;/
    );
  });

  it("relabels the title only for Codex MCP approvals", () => {
    // Title is gated on BOTH an MCP-shaped name AND Codex provenance, so a
    // non-Codex MCP tool keeps the generic title and non-MCP Codex tools are
    // untouched.
    assert.match(
      RENDERER_SRC,
      /else if \(mcp && data\.isCodex\) titleKey = "codexToolApproval";/
    );
    // Default remains the generic permission title; plan review still wins.
    assert.match(RENDERER_SRC, /let titleKey = "permissionRequest";/);
    assert.match(RENDERER_SRC, /if \(isPlanReview\) titleKey = "planReview";/);
  });

  it("shows the friendly server · tool pill for MCP, raw name otherwise", () => {
    assert.match(
      RENDERER_SRC,
      /toolPillText\.textContent = mcp \? mcp\.display : \(data\.toolName \|\| "Unknown"\);/
    );
  });

  it("keeps Allow/Deny decision semantics (no auto-resolve added)", () => {
    // The generic approval branch must still label the two real buttons; the
    // MCP change is presentation-only.
    assert.match(RENDERER_SRC, /bubbleText\(data\.lang, "allow"\)/);
    assert.match(RENDERER_SRC, /bubbleText\(data\.lang, "deny"\)/);
  });

  it("does not reuse the OS-permission wording for the new Codex title", () => {
    assert.match(RENDERER_SRC, /codexToolApproval: "Codex Tool Approval",/);
    // The new English title must not fall back to the loaded word "Permission".
    assert.doesNotMatch(RENDERER_SRC, /codexToolApproval: "[^"]*Permission/);
  });

  it("defines the new title key in every supported language", () => {
    // Mirrors test/i18n.test.js parity, scoped to the key this change adds.
    const count = (RENDERER_SRC.match(/codexToolApproval:/g) || []).length;
    assert.strictEqual(count, SUPPORTED_LANGS.length,
      `expected codexToolApproval in all ${SUPPORTED_LANGS.length} supported locales`);
  });
});

describe("permission payload carries Codex provenance (issue #445)", () => {
  it("buildPermissionBubblePayload forwards isCodex to the renderer", () => {
    // Without this field the renderer cannot tell a Codex approval apart, so the
    // §4.4 label fix would silently no-op.
    assert.match(PERMISSION_SRC, /isCodex: permEntry\.isCodex \|\| false,/);
  });
});
