"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  CODEX_DEFAULT_SESSION_ID,
  CODEX_PLACEHOLDER_SESSION_IDS,
  isCodexCliOriginator,
  isCodexDesktopOriginator,
  isCodexPlaceholderSessionId,
} = require("../hooks/codex-originator");

describe("Codex originator classification", () => {
  it("recognizes current and legacy Codex Desktop values", () => {
    for (const value of [
      "codex_work_desktop",
      " CODEX_WORK_DESKTOP ",
      "Codex Desktop",
      " codex desktop ",
    ]) {
      assert.strictEqual(isCodexDesktopOriginator(value), true, value);
    }
  });

  it("fails closed for CLI, unknown, and malformed values", () => {
    for (const value of [
      "codex_exec",
      "codex-tui",
      "codex_work_cli",
      "desktop",
      "codex",
      "",
      null,
      undefined,
      42,
      {},
    ]) {
      assert.strictEqual(isCodexDesktopOriginator(value), false, String(value));
    }
  });

  it("recognizes only audited interactive CLI originators", () => {
    for (const value of ["codex-tui", " CODEX-TUI ", "codex_cli_rs"]) {
      assert.strictEqual(isCodexCliOriginator(value), true, value);
    }
    for (const value of ["codex_exec", "codex_work_desktop", "cli", "", null, {}]) {
      assert.strictEqual(isCodexCliOriginator(value), false, String(value));
    }
  });

  it("exports the exact frozen Codex placeholder identity contract", () => {
    assert.strictEqual(CODEX_DEFAULT_SESSION_ID, "default");
    assert.deepStrictEqual(
      CODEX_PLACEHOLDER_SESSION_IDS,
      ["default", "codex:", "codex:default"],
    );
    assert.strictEqual(Object.isFrozen(CODEX_PLACEHOLDER_SESSION_IDS), true);
    for (const value of ["default", " DEFAULT ", "codex:", " CODEX:DEFAULT "]) {
      assert.strictEqual(isCodexPlaceholderSessionId(value), true, value);
    }
    for (const value of ["codex:real", "real", "", null, {}]) {
      assert.strictEqual(isCodexPlaceholderSessionId(value), false, String(value));
    }
  });
});
