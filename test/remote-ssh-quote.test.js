"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");

const {
  quoteForCmd,
  quoteForPosixShellArg,
  escapeAppleScriptString,
} = require("../src/remote-ssh-quote");

// ── quoteForCmd ──

test("quoteForCmd wraps simple values in double quotes", () => {
  assert.equal(quoteForCmd("foo"), '^"foo^"');
});

test("quoteForCmd handles empty string", () => {
  assert.equal(quoteForCmd(""), '^"^"');
});

test("quoteForCmd preserves spaces", () => {
  assert.equal(quoteForCmd("foo bar"), '^"foo bar^"');
});

test("quoteForCmd caret-escapes cmd metacharacters and percent expansion", () => {
  assert.equal(quoteForCmd("a&b|c<d>e^f%g!h"), '^"a^&b^|c^<d^>e^^f^%g^!h^"');
});

test("quoteForCmd escapes embedded double quotes", () => {
  assert.equal(quoteForCmd('he said "hi"'), '^"he said \\^"hi\\^"^"');
});

test("quoteForCmd doubles backslashes preceding embedded quote", () => {
  assert.equal(quoteForCmd('a\\"b'), '^"a\\\\\\^"b^"');
});

test("quoteForCmd doubles trailing backslashes before closing quote", () => {
  assert.equal(quoteForCmd("path\\"), '^"path\\\\^"');
});

test("quoteForCmd preserves Chinese characters", () => {
  assert.equal(quoteForCmd("树莓派"), '^"树莓派^"');
});

test("quoteForCmd preserves parentheses", () => {
  assert.equal(quoteForCmd("a(b)c"), '^"a(b)c^"');
});

test("quoteForCmd throws on non-string", () => {
  assert.throws(() => quoteForCmd(123), /must be a string/);
  assert.throws(() => quoteForCmd(null), /must be a string/);
  assert.throws(() => quoteForCmd(undefined), /must be a string/);
});

for (const deferred of [false, true]) {
test(`quoteForCmd round-trips through real cmd.exe without env expansion (deferred=${deferred})`, { skip: process.platform !== "win32" }, () => {
  const values = [
    "foo bar",
    'he said "hi"',
    "a&b|c<d>e^f",
    "%CLAWD_QUOTE_TEST%",
    "!CLAWD_QUOTE_TEST!",
    "path\\",
    "树莓派",
    "C:\\keys (work)\\id",
    "",
    'a\\"b',
  ];
  const js = "console.log(JSON.stringify(process.argv.slice(1)))";
  const command = [
    "node",
    "-e",
    quoteForCmd(js),
    ...values.map(quoteForCmd),
  ].join(" ");
  // Windows terminal launch passes an environment-variable reference through
  // the starter to a fresh cmd. Its expansion must preserve the same argv as
  // a direct command, without recursively expanding values inside SSH args.
  const outerCommand = deferred
    ? 'cmd.exe /d /v:off /s /c ^%CLAWD_REMOTE_SSH_COMMAND^%'
    : command;
  const r = spawnSync("cmd.exe", ["/d", "/v:off", "/s", "/c", outerCommand], {
    encoding: "utf8",
    env: { ...process.env, CLAWD_QUOTE_TEST: 'bad"&echo injected', CLAWD_REMOTE_SSH_COMMAND: command },
    windowsVerbatimArguments: true,
  });
  const detail = JSON.stringify({
    status: r.status,
    signal: r.signal,
    error: r.error && r.error.message,
    stdout: r.stdout,
    stderr: r.stderr,
  });
  assert.equal(r.status, 0, detail);
  assert.ok(r.stdout && r.stdout.trim(), detail);
  assert.deepEqual(JSON.parse(r.stdout.trim()), values);
});
}

// ── quoteForPosixShellArg ──

test("quoteForPosixShellArg wraps simple value", () => {
  assert.equal(quoteForPosixShellArg("foo"), "'foo'");
});

test("quoteForPosixShellArg handles empty string", () => {
  assert.equal(quoteForPosixShellArg(""), "''");
});

test("quoteForPosixShellArg preserves spaces", () => {
  assert.equal(quoteForPosixShellArg("foo bar"), "'foo bar'");
});

test("quoteForPosixShellArg preserves shell metacharacters inside quotes", () => {
  assert.equal(quoteForPosixShellArg("a&b|c;d>e<f$g`h"), "'a&b|c;d>e<f$g`h'");
});

test("quoteForPosixShellArg escapes single quote with close-quote-escape-reopen", () => {
  assert.equal(quoteForPosixShellArg("don't"), "'don'\\''t'");
});

test("quoteForPosixShellArg handles multiple single quotes", () => {
  assert.equal(quoteForPosixShellArg("a'b'c"), "'a'\\''b'\\''c'");
});

test("quoteForPosixShellArg preserves backslashes literally", () => {
  assert.equal(quoteForPosixShellArg("C:\\path\\to\\key"), "'C:\\path\\to\\key'");
});

test("quoteForPosixShellArg preserves Chinese characters", () => {
  assert.equal(quoteForPosixShellArg("树莓派"), "'树莓派'");
});

test("quoteForPosixShellArg preserves parentheses", () => {
  assert.equal(quoteForPosixShellArg("(a)"), "'(a)'");
});

test("quoteForPosixShellArg throws on non-string", () => {
  assert.throws(() => quoteForPosixShellArg(42), /must be a string/);
});

// ── escapeAppleScriptString ──

test("escapeAppleScriptString passes through plain text", () => {
  assert.equal(escapeAppleScriptString("hello world"), "hello world");
});

test("escapeAppleScriptString escapes backslashes", () => {
  assert.equal(escapeAppleScriptString("a\\b"), "a\\\\b");
});

test("escapeAppleScriptString escapes double quotes", () => {
  assert.equal(escapeAppleScriptString('say "hi"'), 'say \\"hi\\"');
});

test("escapeAppleScriptString does not touch single quotes", () => {
  assert.equal(escapeAppleScriptString("don't"), "don't");
});

test("escapeAppleScriptString preserves shell metacharacters", () => {
  assert.equal(escapeAppleScriptString("a&b|c;d`e$f"), "a&b|c;d`e$f");
});

test("escapeAppleScriptString preserves Chinese characters", () => {
  assert.equal(escapeAppleScriptString("树莓派"), "树莓派");
});

test("escapeAppleScriptString throws on non-string", () => {
  assert.throws(() => escapeAppleScriptString(null), /must be a string/);
});

// ── Layered usage (macOS) ──

test("macOS two-layer: POSIX shell quote + AppleScript escape preserves Path with space", () => {
  const args = ["ssh", "-i", "/Users/me/.ssh/my key", "user@host"];
  const cmd = args.map(quoteForPosixShellArg).join(" ");
  const applied = escapeAppleScriptString(cmd);
  // Outer wrap: do script "<applied>"
  // After AppleScript parses, the inner POSIX shell sees the original cmd.
  assert.equal(cmd, "'ssh' '-i' '/Users/me/.ssh/my key' 'user@host'");
  // No `"` or `\` characters in cmd, so escape is identity here.
  assert.equal(applied, cmd);
});

test("macOS two-layer: identityFile path with double quote escapes both layers", () => {
  const args = ["ssh", "-i", 'foo"bar', "user@host"];
  const cmd = args.map(quoteForPosixShellArg).join(" ");
  const applied = escapeAppleScriptString(cmd);
  // POSIX shell layer wraps in single quotes — `"` is preserved literally.
  assert.equal(cmd, "'ssh' '-i' 'foo\"bar' 'user@host'");
  // AppleScript layer escapes `"` to `\"`.
  assert.equal(applied, "'ssh' '-i' 'foo\\\"bar' 'user@host'");
});

test("macOS two-layer: identityFile path with backslash escapes both layers", () => {
  const args = ["-i", "C:\\keys\\id"];
  const cmd = args.map(quoteForPosixShellArg).join(" ");
  const applied = escapeAppleScriptString(cmd);
  assert.equal(cmd, "'-i' 'C:\\keys\\id'");
  // Each backslash doubled by AppleScript layer.
  assert.equal(applied, "'-i' 'C:\\\\keys\\\\id'");
});
