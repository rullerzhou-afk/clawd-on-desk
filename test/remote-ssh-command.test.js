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

test("PR #1366 follow-up: multiline commands use the POSIX decoder wrapper", () => {
  const command = "printf 'first\\n'\nprintf 'second\\n'\n";
  const encoded = encodeMultilineShellCommand(command);

  assert.doesNotMatch(encoded, /[\r\n]/);
  assert.match(encoded, /^sh -c 'd=[A-Za-z0-9+/=]+; for o in -d -D --decode;/);
  assert.equal(decodeMultilineShellCommand(encoded), command);
});

test("one-line commands and non-ssh tools are unchanged", () => {
  const oneLine = "printf 'ok\\n'";
  const args = ["remote.example.test", oneLine];
  assert.equal(encodeMultilineShellCommand(oneLine), oneLine);
  assert.equal(encodeSshCommandArguments("ssh", args), args);
  assert.equal(encodeSshCommandArguments("scp", ["remote.example.test:file", "file"]).at(-1), "file");
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

test("PR #1366 follow-up: wrapping is profile scoped and checks Windows length only when active", () => {
  const { prepareSshCommandArguments } = require("../src/remote-ssh-command");
  const args = ["-o", "ProxyCommand=first\nsecond", "user@host", "cat\nprintf done"];
  for (const profile of [{}, { tunnelMode: "reverse" }, { tunnelMode: "stdio", remotePlatform: "win32" }]) {
    assert.equal(prepareSshCommandArguments("ssh", args, { profile, platform: "win32" }), args);
  }
  const profile = { tunnelMode: "stdio", remotePlatform: "posix" };
  const wrapped = prepareSshCommandArguments("ssh", args, { profile, platform: "linux" });
  assert.deepEqual(wrapped.slice(0, -1), args.slice(0, -1));
  assert.equal(decodeMultilineShellCommand(wrapped.at(-1)), args.at(-1));
  assert.equal(prepareSshCommandArguments("scp", args, { profile, platform: "win32" }), args);
  const long = ["host", "printf '" + "x".repeat(25000) + "'\nprintf done"];
  assert.throws(() => prepareSshCommandArguments("ssh", long, { profile, platform: "win32" }), /Windows SSH command length/);
  assert.doesNotThrow(() => prepareSshCommandArguments("ssh", long, { profile, platform: "linux" }));
  assert.equal(prepareSshCommandArguments("ssh", ["host", "x".repeat(40000)], { profile, platform: "win32" }).at(-1).length, 40000);
});

test("PR #1366 follow-up: decoder failures never execute empty or partial scripts", {
  skip: process.platform === "win32",
}, (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-gateway-decoder-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = "printf executed\ncat\nexit 19";
  const command = encodeMultilineShellCommand(script);
  const decoder = path.join(dir, "base64");
  fs.symlinkSync("/bin/sh", path.join(dir, "sh"));
  fs.symlinkSync("/bin/cat", path.join(dir, "cat"));
  const cases = {
    missing: null,
    rejected: "exit 1",
    empty: "exit 0",
    partial: "printf 'printf unsafe'; exit 1",
    "-d": '[ "$1" = "-d" ] || exit 1; exec /usr/bin/base64 -d',
    "-D": '[ "$1" = "-D" ] || exit 1; exec /usr/bin/base64 -d',
    "--decode": '[ "$1" = "--decode" ] || exit 1; exec /usr/bin/base64 -d',
  };
  for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((file) => fs.existsSync(file))) {
    for (const [name, body] of Object.entries(cases)) {
      if (body === null) fs.rmSync(decoder, { force: true });
      else fs.writeFileSync(decoder, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
      const result = childProcess.spawnSync(shell, ["-c", command], {
        env: { ...process.env, PATH: dir }, input: "stdin-frame", encoding: "utf8",
      });
      const success = name.startsWith("-");
      assert.equal(result.status, success ? 19 : 125, `${shell}:${name}: ${result.stderr}`);
      assert.equal(result.stdout, success ? "executedstdin-frame" : "", `${shell}:${name}`);
      if (!success) assert.match(result.stderr, /cannot decode remote command/);
    }
  }
});
