"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { formatDetail, formatAntigravityDetail, truncate, firstStringValue, parseMcpToolName } = require("../src/bubble-format");

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

  it("coerces non-string tool-input fields instead of crashing (M9)", () => {
    // Truthy non-string command/file_path/pattern used to reach String.slice
    // and throw, taking down the whole bubble render (and the irreversible
    // badge with it). They must now fall through safely.
    assert.doesNotThrow(() => formatDetail("Bash", { command: 12345 }));
    assert.doesNotThrow(() => formatDetail("Edit", { file_path: { nested: true } }));
    assert.doesNotThrow(() => formatDetail("Write", { file_path: true }));
    assert.doesNotThrow(() => formatDetail("Glob", { pattern: 999 }));
    assert.doesNotThrow(() => formatDetail("Grep", { pattern: ["a", "b"] }));
    // A non-string primary field falls through to the generic string search.
    assert.strictEqual(formatDetail("Bash", { command: 5, note: "hi there" }), "hi there");
    // truncate itself coerces, so no caller can crash it.
    assert.strictEqual(truncate(12345, 120), "12345");
    assert.strictEqual(truncate(null, 120), "");
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

describe("bubble-format parseMcpToolName (issue #445)", () => {
  it("parses the reported Codex Vercel MCP names to server · tool", () => {
    assert.deepStrictEqual(
      parseMcpToolName("MCP__CODEX_APPS__VERCEL__LIST_PROJECTS"),
      { server: "vercel", tool: "list_projects", display: "vercel · list_projects" }
    );
    assert.strictEqual(
      parseMcpToolName("MCP__CODEX_APPS__VERCEL__LIST_TOOLBAR_THREADS").display,
      "vercel · list_toolbar_threads"
    );
  });

  it("handles Claude Code lower-case 3-segment names too", () => {
    assert.strictEqual(parseMcpToolName("mcp__github__list_issues").display, "github · list_issues");
    assert.strictEqual(parseMcpToolName("mcp__server__tool").display, "server · tool");
  });

  it("uses the last two segments regardless of namespace depth", () => {
    // server is always second-to-last, tool is last — robust to extra prefixes.
    assert.deepStrictEqual(
      parseMcpToolName("MCP__NS__SUB__SERVER__DO_THING"),
      { server: "server", tool: "do_thing", display: "server · do_thing" }
    );
  });

  it("returns tool-only display when there is no server segment", () => {
    assert.deepStrictEqual(
      parseMcpToolName("mcp__solo"),
      { server: null, tool: "solo", display: "solo" }
    );
  });

  it("returns null for non-MCP tool names (raw fallback path)", () => {
    for (const name of ["Bash", "Edit", "CodexExec", "KimiPermission", "ExitPlanMode", "AskUserQuestion"]) {
      assert.strictEqual(parseMcpToolName(name), null, `${name} must not be treated as MCP`);
    }
  });

  it("never throws and falls back to null for malformed / empty input", () => {
    for (const bad of ["", "MCP__", "mcp__", "MCP", "mcp", "__", "MCP____", null, undefined, 42, {}]) {
      assert.strictEqual(parseMcpToolName(bad), null, `${JSON.stringify(bad)} must return null`);
    }
  });

  it("returns null for trailing / middle empty segments (raw fallback, not partial label)", () => {
    // Regression for the lenient-parse concern: a stray "__" must not drop the
    // real tool segment and show a misleading "server · server" style label.
    for (const bad of [
      "MCP__CODEX_APPS__VERCEL__", // trailing "__" — would have shown "codex_apps · vercel"
      "mcp__github__",            // trailing "__" — would have shown "github"
      "MCP__CODEX_APPS____VERCEL", // empty middle segment
      "mcp____tool",              // empty middle segment
    ]) {
      assert.strictEqual(parseMcpToolName(bad), null, `${JSON.stringify(bad)} must be raw fallback (null)`);
    }
  });
});
