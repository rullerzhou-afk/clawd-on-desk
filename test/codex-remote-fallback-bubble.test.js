"use strict";

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

function codexExecBranch() {
  const start = RENDERER_SRC.indexOf('if (data.toolName === "CodexExec")');
  assert.notStrictEqual(start, -1, "CodexExec branch not found");
  const end = RENDERER_SRC.indexOf("return;", start);
  return RENDERER_SRC.slice(start, end);
}

describe("Codex remote MCP: fallback notice rendering", () => {
  it("keeps CodexExec as the dismiss-only branch discriminator", () => {
    assert.match(RENDERER_SRC, /if \(data\.toolName === "CodexExec"\) \{/);
    const branch = codexExecBranch();
    assert.doesNotMatch(branch, /bubbleAPI\.decide/);
    assert.match(branch, /btnDeny\.style\.display = "none";/);
    assert.match(branch, /bubbleText\(data\.lang, "gotIt"\)/);
  });

  it("renders the real tool pill and detail when display fields are present", () => {
    const branch = codexExecBranch();
    assert.match(
      branch,
      /typeof data\.displayToolName === "string" && data\.displayToolName/
    );
    assert.match(
      branch,
      /data\.displayToolInput && typeof data\.displayToolInput === "object"/
    );
    assert.match(branch, /parseMcpToolName\(data\.displayToolName\)/);
    assert.match(branch, /formatDetail\(data\.displayToolName, data\.displayToolInput\)/);
    assert.match(branch, /toolPill\.setAttribute\("data-tool", data\.displayToolName\);/);
  });

  it("keeps the legacy generic CodexExec card when display fields are absent", () => {
    const branch = codexExecBranch();
    const fallback = /\(data\.toolInput && data\.toolInput\.command\) \|\| "\(unknown\)"/;
    assert.match(branch, fallback);
    assert.match(branch, /toolPillText\.textContent = "CODEX";/);
    assert.match(branch, /toolPill\.setAttribute\("data-tool", "CodexExec"\);/);
  });

  it("defines the remote waiting title in every supported language", () => {
    const count = (RENDERER_SRC.match(/codexRemoteWaiting:/g) || []).length;
    assert.strictEqual(count, SUPPORTED_LANGS.length,
      `expected codexRemoteWaiting in all ${SUPPORTED_LANGS.length} supported locales`);
  });

  it("forwards display-only fields through the bubble payload", () => {
    assert.match(PERMISSION_SRC, /displayToolName: permEntry\.displayToolName \|\| null,/);
    assert.match(PERMISSION_SRC, /displayToolInput: permEntry\.displayToolInput \|\| null,/);
    assert.match(PERMISSION_SRC, /displayHost: permEntry\.host \|\| null,/);
  });
});
