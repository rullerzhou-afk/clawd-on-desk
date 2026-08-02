"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  isCodexCliOriginator,
  isCodexDesktopOriginator,
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
});
