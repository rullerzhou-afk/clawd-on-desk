"use strict";

// Unit tests for WSL2 focus support:
// - makeEditorFallbackBlock (src/focus.js): PowerShell block targeting editor
//   by process name when Linux PID walk finds nothing.
// - TERM_PROGRAM fallback (hooks/clawd-hook.js): editor detection via env var
//   injected by VS Code / Cursor into WSL terminals.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const { makeEditorFallbackBlock } = require("../src/focus.js").__test;
const { buildStateBody } = require("../hooks/clawd-hook.js");

// ── makeEditorFallbackBlock ──────────────────────────────────────────────────

describe("makeEditorFallbackBlock", () => {
  it("returns empty string for unknown editor", () => {
    assert.strictEqual(makeEditorFallbackBlock("terminal", ""), "");
    assert.strictEqual(makeEditorFallbackBlock(null, ""), "");
    assert.strictEqual(makeEditorFallbackBlock(undefined, ""), "");
  });

  it("targets Code process for editor=code", () => {
    const block = makeEditorFallbackBlock("code", "");
    assert.ok(block.includes("Get-Process -Name 'Code'"));
    assert.ok(!block.includes("Cursor"));
  });

  it("targets Cursor process for editor=cursor", () => {
    const block = makeEditorFallbackBlock("cursor", "");
    assert.ok(block.includes("Get-Process -Name 'Cursor'"));
    assert.ok(!block.includes("'Code'"));
  });

  it("includes title match block when psNames provided", () => {
    const psNames = `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('Y2xhd2Q=')))`;
    const block = makeEditorFallbackBlock("code", psNames);
    assert.ok(block.includes("FindByPidTitle"));
    assert.ok(block.includes(psNames));
  });

  it("omits title match when psNames empty", () => {
    const block = makeEditorFallbackBlock("code", "");
    assert.ok(!block.includes("FindByPidTitle"));
  });

  it("always includes fallback to first window", () => {
    const block = makeEditorFallbackBlock("code", "");
    assert.ok(block.includes("Select-Object -First 1"));
    assert.ok(block.includes("[WinFocus]::Focus"));
  });
});

// ── TERM_PROGRAM editor fallback in buildStateBody ───────────────────────────

const nullResolve = () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] });

describe("buildStateBody TERM_PROGRAM fallback", () => {
  let origTermProgram;

  beforeEach(() => {
    origTermProgram = process.env.TERM_PROGRAM;
  });

  afterEach(() => {
    if (origTermProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = origTermProgram;
  });

  it("sets editor=code when TERM_PROGRAM=vscode and no detectedEditor", () => {
    process.env.TERM_PROGRAM = "vscode";
    const body = buildStateBody("PreToolUse", { session_id: "s" }, nullResolve);
    assert.strictEqual(body.editor, "code");
  });

  it("sets editor=cursor when TERM_PROGRAM=cursor and no detectedEditor", () => {
    process.env.TERM_PROGRAM = "cursor";
    const body = buildStateBody("PreToolUse", { session_id: "s" }, nullResolve);
    assert.strictEqual(body.editor, "cursor");
  });

  it("omits editor when TERM_PROGRAM unset and no detectedEditor", () => {
    delete process.env.TERM_PROGRAM;
    const body = buildStateBody("PreToolUse", { session_id: "s" }, nullResolve);
    assert.ok(!("editor" in body));
  });

  it("detectedEditor takes precedence over TERM_PROGRAM", () => {
    process.env.TERM_PROGRAM = "vscode";
    const resolveWithEditor = () => ({ stablePid: 1, agentPid: null, detectedEditor: "cursor", pidChain: [] });
    const body = buildStateBody("PreToolUse", { session_id: "s" }, resolveWithEditor);
    assert.strictEqual(body.editor, "cursor");
  });

  it("omits editor for unknown TERM_PROGRAM value", () => {
    process.env.TERM_PROGRAM = "iterm2";
    const body = buildStateBody("PreToolUse", { session_id: "s" }, nullResolve);
    assert.ok(!("editor" in body));
  });
});
