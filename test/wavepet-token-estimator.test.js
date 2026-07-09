const test = require("node:test");
const assert = require("node:assert");
const {
  estimateTokens,
  extractCommand,
  classifyCall,
  inferSuccess,
} = require("../src/wavepet/token-estimator");

test("estimateTokens handles ascii and CJK text", () => {
  assert.equal(estimateTokens("abcd efgh"), 2);
  assert.equal(estimateTokens("你好世界"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("extractCommand reads JSON string and object arguments", () => {
  assert.equal(extractCommand({ command: "npm test" }), "npm test");
  assert.equal(extractCommand('{"command":"pytest -q"}'), "pytest -q");
  assert.equal(extractCommand("plain text"), "plain text");
});

test("classifyCall separates read edit test and command work", () => {
  assert.equal(classifyCall("shell_command", "rg \"foo\" src"), "read");
  assert.equal(classifyCall("apply_patch", ""), "edit");
  assert.equal(classifyCall("shell_command", "npm test"), "test");
  assert.equal(classifyCall("shell_command", "git status"), "command");
  assert.equal(classifyCall("web_search_call", "query"), "read");
  assert.equal(
    classifyCall("shell_command", "npm install --save-dev eslint"),
    "command"
  );
});

test("inferSuccess detects common command result text", () => {
  assert.equal(inferSuccess("Exit code: 0\nok"), true);
  assert.equal(inferSuccess("Exit code: 1\nfailed"), false);
  assert.equal(inferSuccess("Traceback most recent call last"), false);
  assert.equal(inferSuccess("normal output"), true);
  assert.equal(inferSuccess("bash: git: command not found"), false);
  assert.equal(inferSuccess("Permission denied"), false);
  assert.equal(inferSuccess("No such file or directory"), false);
});
