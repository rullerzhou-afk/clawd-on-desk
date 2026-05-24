"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { formatDetail, formatAntigravityDetail, truncate, firstStringValue } = require("../src/bubble-format");

describe("bubble-format truncate", () => {
  it("returns input unchanged when within max", () => {
    assert.strictEqual(truncate("abc", 10), "abc");
  });

  it("trims and appends ellipsis when over max", () => {
    assert.strictEqual(truncate("abcdef", 4), "abc…");
  });
});

describe("bubble-format firstStringValue", () => {
  it("returns first non-empty trimmed string from candidate names", () => {
    assert.strictEqual(
      firstStringValue({ a: "", b: "  hello ", c: "world" }, ["a", "b", "c"]),
      "hello"
    );
  });

  it("returns empty string when no candidate is a non-empty string", () => {
    assert.strictEqual(firstStringValue({ a: 1, b: null, c: "  " }, ["a", "b", "c"]), "");
  });
});

describe("bubble-format formatDetail builtin tools", () => {
  it("uses input.description before anything else", () => {
    assert.strictEqual(formatDetail("Bash", { description: " run tests ", command: "npm test" }), "run tests");
  });

  it("formats Bash command", () => {
    assert.strictEqual(formatDetail("Bash", { command: "npm test" }), "npm test");
  });

  it("formats Edit/Write/Read file_path", () => {
    assert.strictEqual(formatDetail("Edit", { file_path: "/repo/app.js" }), "/repo/app.js");
    assert.strictEqual(formatDetail("Write", { file_path: "/repo/out.txt" }), "/repo/out.txt");
    assert.strictEqual(formatDetail("Read", { file_path: "/repo/in.txt" }), "/repo/in.txt");
  });

  it("formats Glob/Grep pattern", () => {
    assert.strictEqual(formatDetail("Glob", { pattern: "**/*.js" }), "**/*.js");
    assert.strictEqual(formatDetail("Grep", { pattern: "TODO" }), "TODO");
  });

  it("returns empty string for invalid input", () => {
    assert.strictEqual(formatDetail("Bash", null), "");
    assert.strictEqual(formatDetail("Bash", undefined), "");
  });
});

describe("bubble-format formatDetail antigravity gating", () => {
  it("does NOT call Antigravity formatter for snake_case tools when isAntigravity is false", () => {
    // Regression: previously the heuristic "toolName includes _ or input has CommandLine"
    // would route a Codex / opencode / Kimi snake_case tool name through the Antigravity
    // formatter and produce a composite like "/repo/src: TODO". With the explicit gate it
    // must fall back to the generic "first string value" path instead.
    const detail = formatDetail("grep_search", { Query: "TODO", SearchPath: "/repo/src" });
    // Generic path picks the first string value (Object.values insertion order).
    assert.strictEqual(detail, "TODO");
  });

  it("does NOT produce Antigravity composite for write_to_file when isAntigravity is false", () => {
    // The Antigravity formatter would return "/repo/a.txt: create". The generic fallback
    // returns the first string value, which is /repo/a.txt.
    const detail = formatDetail("write_to_file", { TargetFile: "/repo/a.txt", Description: "create" });
    assert.strictEqual(detail, "/repo/a.txt");
  });

  it("calls Antigravity formatter when isAntigravity is true", () => {
    const detail = formatDetail(
      "run_command",
      { CommandLine: "npm test", Cwd: "/repo" },
      { isAntigravity: true }
    );
    assert.strictEqual(detail, "npm test");
  });

  it("falls back to generic path when isAntigravity is true but tool is unknown", () => {
    const detail = formatDetail("totally_unknown_tool", { whatever: "x" }, { isAntigravity: true });
    assert.strictEqual(detail, "x");
  });
});

describe("bubble-format formatAntigravityDetail tool coverage", () => {
  it("formats run_command/bash/shell from CommandLine/command", () => {
    assert.strictEqual(formatAntigravityDetail("run_command", { CommandLine: "ls" }), "ls");
    assert.strictEqual(formatAntigravityDetail("bash", { command: "echo hi" }), "echo hi");
    assert.strictEqual(formatAntigravityDetail("shell", { Command: "pwd" }), "pwd");
  });

  it("formats write_to_file with TargetFile and Description", () => {
    assert.strictEqual(
      formatAntigravityDetail("write_to_file", { TargetFile: "/repo/a.txt", Description: "create" }),
      "/repo/a.txt: create"
    );
  });

  it("formats view_file/read with AbsolutePath", () => {
    assert.strictEqual(formatAntigravityDetail("view_file", { AbsolutePath: "/repo/a.txt" }), "/repo/a.txt");
    assert.strictEqual(formatAntigravityDetail("READ", { AbsolutePath: "/repo/a.txt" }), "/repo/a.txt");
  });

  it("formats grep_search with SearchPath and Query", () => {
    assert.strictEqual(
      formatAntigravityDetail("grep_search", { SearchPath: "/repo", Query: "TODO" }),
      "/repo: TODO"
    );
  });

  it("formats ask_permission with Target and Reason", () => {
    assert.strictEqual(
      formatAntigravityDetail("ask_permission", { Target: "command(rm)", Reason: "cleanup" }),
      "command(rm): cleanup"
    );
  });

  it("returns empty string for empty / unknown tool name", () => {
    assert.strictEqual(formatAntigravityDetail("", {}), "");
    assert.strictEqual(formatAntigravityDetail("unknown_tool_x", {}), "");
  });
});
