"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { isCodexClaimableMcpTool } = require("../src/permission-automation-policy");
const {
  isNonlocalCodexRequest,
  resolveCodexApprovalRoute,
} = require("../src/codex-approval-routing");
const {
  isCodexAutomationClaimTool,
  isCodexAutomationClaimShape,
  shouldClaimCodexPermissionForAutomation,
} = require("../src/server-route-permission").__test;

describe("Codex remote MCP: claimable tool scope", () => {
  it("accepts ordinary namespaced MCP tools, including case variants and extra segments", () => {
    for (const toolName of [
      "mcp__playwright__browser_navigate",
      "MCP__Playwright__Browser_Navigate",
      "mcp__github__delete_repository",
      "mcp__server__nested__tool",
      "MCP__SRV__AskUserQuestion",
    ]) {
      assert.equal(isCodexClaimableMcpTool(toolName), true, toolName);
    }
  });

  it("rejects the Codex app connector namespace in every casing and shape", () => {
    for (const toolName of [
      "mcp__codex_apps__vercel__list_projects",
      "MCP__CODEX_APPS__VERCEL__LIST_PROJECTS",
      "mcp__Codex_Apps__x__y",
      "mcp__codex_apps__x",
    ]) {
      assert.equal(isCodexClaimableMcpTool(toolName), false, toolName);
    }
  });

  it("rejects malformed MCP names and non-MCP tools", () => {
    for (const toolName of [
      "mcp__x",
      "mcp____x",
      "mcp",
      "mcp__codex_apps",
      "mcp__codex_apps_extra__x",
      "Bash",
      "apply_patch",
      "shell",
      "",
      null,
      undefined,
    ]) {
      const expected = toolName === "mcp__codex_apps_extra__x";
      assert.equal(isCodexClaimableMcpTool(toolName), expected, String(toolName));
    }
  });
});

describe("Codex remote MCP: nonlocal routing classification", () => {
  it("matches the existing wire-field classification", () => {
    assert.equal(isNonlocalCodexRequest({}), false);
    assert.equal(isNonlocalCodexRequest({ host: "" }), false);
    assert.equal(isNonlocalCodexRequest({ host: "ruller-win" }), true);
    assert.equal(isNonlocalCodexRequest({ wsl_distro: "Ubuntu" }), true);
    assert.equal(isNonlocalCodexRequest({ wsl_sourced: true }), true);
    assert.equal(isNonlocalCodexRequest({ wsl_sourced: "true" }), false);
    assert.equal(isNonlocalCodexRequest({ wsl_sourced: 1 }), false);
  });

  it("keeps the existing route order: tool first, nonlocal second", () => {
    const nonlocal = { host: "ruller-win" };
    assert.deepEqual(
      resolveCodexApprovalRoute({ tool_name: "mcp__playwright__browser_navigate", ...nonlocal }),
      { owner: "codex", reason: "request-reviewer-unavailable" }
    );
    assert.deepEqual(
      resolveCodexApprovalRoute({ tool_name: "Bash", ...nonlocal }),
      { owner: "codex", reason: "nonlocal" }
    );
    assert.deepEqual(
      resolveCodexApprovalRoute({ tool_name: "mcp__playwright__browser_navigate" }),
      { owner: "codex", reason: "request-reviewer-unavailable" }
    );
  });
});


describe("Codex remote MCP: claim checks do not read transcripts", () => {
  function localBashFixture(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claim-no-read-"));
    const priorCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    const sessions = path.join(home, "sessions");
    fs.mkdirSync(sessions);
    const session = "01a119d3-1893-7f42-aadc-fa33ca4166a8";
    const turn = "01a119d7-24b5-7010-9da2-d8791ff8a1d1";
    const file = path.join(sessions, `rollout-${session}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: "session_meta", payload: { id: session } }),
      JSON.stringify({
        type: "turn_context",
        payload: { turn_id: turn, approvals_reviewer: "user", approval_policy: "on-request" },
      }),
    ].join("\n") + "\n");
    t.after(() => {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      fs.rmSync(home, { recursive: true, force: true });
    });
    return {
      tool_name: "Bash",
      session_id: `codex:${session}`,
      turn_id: turn,
      permission_mode: "default",
      transcript_path: file,
    };
  }

  it("does not touch the resolver for local Bash in Intercept or Auto mode", (t) => {
    const data = localBashFixture(t);
    const openSync = t.mock.method(fs, "openSync");
    for (const mode of ["intercept", "auto"]) {
      const ctx = {
        getCodexPermissionMode: () => mode,
        wouldAutoAllowPermission: () => true,
      };
      assert.equal(isCodexAutomationClaimTool(data), false);
      assert.equal(isCodexAutomationClaimShape(ctx, data), false);
      assert.equal(shouldClaimCodexPermissionForAutomation(ctx, data, {}), false);
    }
    assert.equal(openSync.mock.calls.length, 0);
  });

  it("keeps the existing nonlocal result for Bash and apply_patch", () => {
    for (const tool of ["Bash", "apply_patch"]) {
      assert.equal(isCodexAutomationClaimTool({ tool_name: tool, host: "ruller-win" }), true);
      assert.equal(isCodexAutomationClaimTool({ tool_name: tool, wsl_distro: "Ubuntu" }), true);
      assert.equal(isCodexAutomationClaimTool({ tool_name: tool, wsl_sourced: true }), true);
      assert.equal(isCodexAutomationClaimTool({ tool_name: tool }), false);
      assert.equal(isCodexAutomationClaimTool({ tool_name: tool, wsl_sourced: "true" }), false);
    }
  });
});
