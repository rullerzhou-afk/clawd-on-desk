"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");

const {
  decodeMultilineShellCommand,
  decodeSshCommandArguments,
  encodeMultilineShellCommand,
  encodeSshCommandArguments,
} = require("../src/remote-ssh-command");

test("multiline shell commands are decoded as a one-line command argument", () => {
  const command = "printf 'first\\n'\nprintf 'second\\n'\n";
  const encoded = encodeMultilineShellCommand(command);

  assert.doesNotMatch(encoded, /[\r\n]/);
  assert.match(encoded, /^sh -c "\$\(printf %s '[A-Za-z0-9+/=]+' \| base64 --decode\)"$/);
  assert.equal(decodeMultilineShellCommand(encoded), command);
});

test("one-line commands and non-ssh tools are unchanged", () => {
  const oneLine = "printf 'ok\\n'";
  const args = ["dev43", oneLine];
  assert.equal(encodeMultilineShellCommand(oneLine), oneLine);
  assert.equal(encodeSshCommandArguments("ssh", args), args);
  assert.equal(encodeSshCommandArguments("scp", ["dev43:file", "file"]).at(-1), "file");
  assert.equal(decodeSshCommandArguments("ssh", args), args);
});

test("SSH command wrapping preserves stdin for framed or JSON input", {
  skip: process.platform === "win32",
}, () => {
  const script = "cat\nprintf 'after\\n'\n";
  const command = encodeMultilineShellCommand(script);
  const result = childProcess.spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    input: "stdin-frame",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "stdin-frameafter\n");
});
