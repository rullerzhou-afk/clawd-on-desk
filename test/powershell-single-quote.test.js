"use strict";

// Every writer of a PowerShell single-quoted string and the readers that undo
// it. PowerShell treats U+2018, U+2019, U+201A and U+201B as single quotes too,
// so a path containing one must not be able to end the string early.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  buildWindowsEncodedNodeHookCommand,
  decodeWindowsEncodedCommand,
  extractFirstQuotedToken,
  quotePowerShellSingleArg,
  unescapePowerShellSingleQuoted,
} = require("../hooks/json-utils");
const { quoteForPowerShell } = require("../src/launch-claude");
const { __test: dshTest } = require("../hooks/dsh-install");
const { buildCopilotHookCommands } = require("../hooks/copilot-install");
const {
  buildStableCodexHookCommand,
  inspectStableCodexHookCommand,
  withCommandEnv,
} = require("../hooks/codex-install-utils");
const { __test: antigravityTest } = require("../hooks/antigravity-install");
const { parseHookCommand } = require("../src/doctor-detectors/agent-node-bin-parser");
const { __test: focusTest } = loadFocus();

const CURLY_SINGLE_QUOTES = [0x2018, 0x2019, 0x201A, 0x201B].map((code) => String.fromCodePoint(code));
const SINGLE_QUOTES = ["'", ...CURLY_SINGLE_QUOTES];
const [LEFT, RIGHT] = CURLY_SINGLE_QUOTES;
// U+201C/U+201D are double quotes and U+2032 is a prime: not single quotes.
const NOT_SINGLE_QUOTES = [0x201C, 0x201D, 0x2032].map((code) => String.fromCodePoint(code));

// Values that end a naive literal early or smuggle in a second statement.
const AWKWARD_VALUES = [
  `C:\\Users\\O${RIGHT}Brien\\node.exe`,
  `C:\\x\\a${RIGHT}; Write-Output marker; ${RIGHT}b`,
  `${LEFT}${RIGHT}${CURLY_SINGLE_QUOTES[2]}${CURLY_SINGLE_QUOTES[3]}'`,
  `'${RIGHT}`,
  `${RIGHT}'${RIGHT}'`,
  "it's",
];

function loadFocus() {
  // initFocus() needs an Electron-ish context only for its effects; the quoting
  // helpers are reached through makeFocusCmd.
  return require("../src/focus")({});
}

// Mirrors how PowerShell scans a single-quoted string: one of the five quote
// characters ends it unless the next character is one too, in which case the
// pair stands for the second character.
function scanSingleQuoted(text, start) {
  let value = "";
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (!SINGLE_QUOTES.includes(ch)) {
      value += ch;
    } else if (SINGLE_QUOTES.includes(text[i + 1])) {
      value += text[i + 1];
      i++;
    } else {
      return { value, end: i + 1 };
    }
  }
  throw new Error(`unterminated single-quoted string in ${text}`);
}

// Every single-quoted literal in a command, in order.
function singleQuotedLiterals(command) {
  const literals = [];
  for (let i = 0; i < command.length;) {
    if (!SINGLE_QUOTES.includes(command[i])) { i++; continue; }
    const { value, end } = scanSingleQuoted(command, i);
    literals.push(value);
    i = end;
  }
  return literals;
}

function assertSingleLiteral(quoted, expected) {
  assert.deepStrictEqual(singleQuotedLiterals(quoted), [expected], quoted);
}

describe("quotePowerShellSingleArg", () => {
  it("doubles ASCII and all four curly single quotes", () => {
    for (const quote of SINGLE_QUOTES) {
      assert.strictEqual(quotePowerShellSingleArg(`a${quote}b`), `'a${quote}${quote}b'`);
    }
  });

  it("keeps awkward values as one literal that evaluates to the original", () => {
    for (const value of AWKWARD_VALUES) assertSingleLiteral(quotePowerShellSingleArg(value), value);
  });

  it("leaves ordinary paths and look-alike characters byte for byte", () => {
    assert.strictEqual(quotePowerShellSingleArg("C:\\Program Files\\nodejs\\node.exe"), "'C:\\Program Files\\nodejs\\node.exe'");
    assert.strictEqual(quotePowerShellSingleArg("/usr/bin/node"), "'/usr/bin/node'");
    assert.strictEqual(quotePowerShellSingleArg(""), "''");
    assert.strictEqual(quotePowerShellSingleArg(42), "'42'");
    const lookAlikes = `a${NOT_SINGLE_QUOTES.join("")}"b`;
    assert.strictEqual(quotePowerShellSingleArg(lookAlikes), `'${lookAlikes}'`);
  });

  it("keeps the ASCII quote doubled the way it always was", () => {
    assert.strictEqual(quotePowerShellSingleArg("a'b"), "'a''b'");
    assert.strictEqual(quotePowerShellSingleArg("''"), "''''''");
  });
});

describe("unescapePowerShellSingleQuoted", () => {
  it("undoes the doubling of every single-quote character", () => {
    for (const quote of SINGLE_QUOTES) {
      assert.strictEqual(unescapePowerShellSingleQuoted(`a${quote}${quote}b`), `a${quote}b`);
    }
  });

  it("restores whatever quotePowerShellSingleArg wrote", () => {
    for (const value of [...AWKWARD_VALUES, "plain", ""]) {
      const quoted = quotePowerShellSingleArg(value);
      assert.strictEqual(unescapePowerShellSingleQuoted(quoted.slice(1, -1)), value);
    }
  });

  it("does not touch text without doubled quotes", () => {
    const text = `C:\\Users\\x${RIGHT}y ${NOT_SINGLE_QUOTES.join("")}`;
    assert.strictEqual(unescapePowerShellSingleQuoted(text), text);
  });
});

describe("extractFirstQuotedToken", () => {
  it("reads a single-quoted token holding curly quotes, with or without the call operator", () => {
    const value = `C:\\Users\\O${RIGHT}Brien\\node.exe`;
    assert.strictEqual(extractFirstQuotedToken(`& ${quotePowerShellSingleArg(value)} 'x'`), value);
    assert.strictEqual(extractFirstQuotedToken(quotePowerShellSingleArg(value)), value);
  });

  it("still reads ASCII-doubled tokens", () => {
    assert.strictEqual(extractFirstQuotedToken("'C:\\O''Brien\\node.exe' 'x'"), "C:\\O'Brien\\node.exe");
  });
});

describe("PowerShell command writers", () => {
  const nodeBin = `C:\\Users\\O${RIGHT}Brien\\node.exe`;
  const scriptPath = `C:\\Users\\O${RIGHT}Brien\\hooks\\copilot-hook.js`;

  it("quoteForPowerShell (launch-claude)", () => {
    assert.strictEqual(quoteForPowerShell("abc"), "'abc'");
    assert.strictEqual(quoteForPowerShell("a'b"), "'a''b'");
    for (const value of AWKWARD_VALUES) assertSingleLiteral(quoteForPowerShell(value), value);
  });

  it("the focus script's token literal", () => {
    for (const token of ["tok-1", ...AWKWARD_VALUES]) {
      const script = focusTest.makeFocusCmd(1234, ["repo"], null, null, token);
      const line = script.match(/\$focusToken = (.*)/)[1];
      assertSingleLiteral(line.trim(), token);
    }
  });

  it("Codex env prefix and legacy stable launcher", () => {
    for (const value of AWKWARD_VALUES) {
      const command = withCommandEnv("node hook.js", { CLAWD_X: value }, "win32");
      assert.deepStrictEqual(singleQuotedLiterals(command), [value]);
    }
    assert.strictEqual(withCommandEnv("node hook.js", { A: "b" }, "win32"), "$env:A='b'; node hook.js");

    const launcherPath = `C:/Users/O${RIGHT}Brien/.codex/hooks/codex-hook.js.windows.run`;
    const command = buildStableCodexHookCommand(launcherPath, "win32");
    assert.ok(singleQuotedLiterals(command).includes(launcherPath));
    const inspected = inspectStableCodexHookCommand(command, {
      platform: "win32",
      fs: { readFileSync() { throw new Error("ENOENT"); } },
    });
    assert.strictEqual(inspected.launcherPath, launcherPath);
  });

  it("Codex stable launcher for an ordinary path is unchanged", () => {
    const launcherPath = "C:/Users/me/.codex/hooks/codex-hook.js.windows.run";
    assert.ok(buildStableCodexHookCommand(launcherPath, "win32").includes(`ReadAllLines('${launcherPath}',$u)`));
  });

  it("DSH manual command", () => {
    const command = dshTest.buildManualDshCommand(["npx", "--yes", `pkg${RIGHT}x`], {
      platform: "win32",
      dshHome: `C:\\Users\\O${RIGHT}Brien\\.dsh`,
    });
    assert.deepStrictEqual(singleQuotedLiterals(command), [`C:\\Users\\O${RIGHT}Brien\\.dsh`, "npx", "--yes", `pkg${RIGHT}x`]);
  });

  it("Copilot remote environment values", () => {
    const identityPath = `/home/o${RIGHT}brien/.clawd/identity.json`;
    const { powershell } = buildCopilotHookCommands("node", "/x/copilot-hook.js", "sessionStart", {
      remote: true,
      sshRemote: true,
      env: { CLAWD_REMOTE_IDENTITY_PATH: identityPath },
    });
    assert.deepStrictEqual(singleQuotedLiterals(powershell), ["1", "1", identityPath]);
    assert.ok(powershell.startsWith("$env:CLAWD_REMOTE='1'; $env:CLAWD_SSH_REMOTE='1'; "));
  });

  it("encoded node hook command keeps the node and script paths as separate literals", () => {
    const command = buildWindowsEncodedNodeHookCommand(nodeBin, scriptPath, ["event"]);
    const decoded = decodeWindowsEncodedCommand(command);
    assert.strictEqual(decoded, `& ${quotePowerShellSingleArg(nodeBin)} ${quotePowerShellSingleArg(scriptPath)} 'event'`);
    assert.deepStrictEqual(singleQuotedLiterals(decoded), [nodeBin, scriptPath, "event"]);
  });

  it("Antigravity fail-open wrapper", () => {
    const antigravityScript = `C:\\Users\\O${RIGHT}Brien\\hooks\\antigravity-hook.js`;
    const command = antigravityTest.buildAntigravityHookCommand(nodeBin, antigravityScript, "PostInvocation", { platform: "win32" });
    const decoded = decodeWindowsEncodedCommand(command);
    assert.ok(singleQuotedLiterals(decoded).includes(nodeBin));
    assert.strictEqual(antigravityTest.extractNodeBinFromCommand(command), nodeBin);
  });
});

describe("Doctor hook command parser with curly quotes", () => {
  const nodeBin = `C:\\Users\\O${RIGHT}Brien\\node.exe`;
  const scriptPath = `C:\\Users\\O${RIGHT}Brien\\hooks\\copilot-hook.js`;

  it("recovers both paths from the encoded node hook form", () => {
    const parsed = parseHookCommand(buildWindowsEncodedNodeHookCommand(nodeBin, scriptPath, ["event"]));
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.nodeBin, nodeBin);
    assert.strictEqual(parsed.scriptPath, scriptPath);
  });

  it("recovers both paths from a plain call-operator command", () => {
    const parsed = parseHookCommand(`& ${quotePowerShellSingleArg(nodeBin)} ${quotePowerShellSingleArg(scriptPath)} 'event'`);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.nodeBin, nodeBin);
    assert.strictEqual(parsed.scriptPath, scriptPath);
  });

  it("recovers both paths from the Antigravity ProcessStartInfo form", () => {
    const antigravityScript = `C:\\Users\\O${RIGHT}Brien\\hooks\\antigravity-hook.js`;
    const command = antigravityTest.buildAntigravityHookCommand(nodeBin, antigravityScript, "PostInvocation", { platform: "win32" });
    const parsed = parseHookCommand(command);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.nodeBin, nodeBin);
    assert.strictEqual(parsed.scriptPath, antigravityScript);
  });

  it("keeps reading ASCII-doubled paths", () => {
    const parsed = parseHookCommand("& 'C:\\O''Brien\\node.exe' 'C:\\O''Brien\\hooks\\copilot-hook.js' 'event'");
    assert.strictEqual(parsed.nodeBin, "C:\\O'Brien\\node.exe");
    assert.strictEqual(parsed.scriptPath, "C:\\O'Brien\\hooks\\copilot-hook.js");
  });
});
