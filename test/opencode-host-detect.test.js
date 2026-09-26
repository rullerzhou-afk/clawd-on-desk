"use strict";

// opencode host major-version detection (upstream PR #1045 review): the v2
// `plugins` config key may only be written for a detected v2 host, because
// opencode <= 1.18.15 rejects unknown top-level keys.

const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  parseOpencodeVersion,
  detectOpencodeHost,
  __test,
} = require("../hooks/opencode-host-detect");

function failingExecFile(message = "spawn ENOENT") {
  return () => {
    throw new Error(message);
  };
}

describe("opencode host detection", () => {
  it("parses the first x.y.z token out of noisy version output", () => {
    assert.deepStrictEqual(parseOpencodeVersion("opencode v2.0.15\n"), {
      major: 2, minor: 0, patch: "15", raw: "2.0.15",
    });
    assert.strictEqual(parseOpencodeVersion("1.18.32").major, 1);
    assert.strictEqual(parseOpencodeVersion("opencode 2.1.0-beta.1 (channel: latest)").raw, "2.1.0-beta.1");
    assert.strictEqual(parseOpencodeVersion("no version here"), null);
    assert.strictEqual(parseOpencodeVersion(""), null);
    assert.strictEqual(parseOpencodeVersion(null), null);
  });

  it("maps parsed majors onto the v1/v2/unknown tri-state", () => {
    assert.strictEqual(detectOpencodeHost({ opencodeVersion: "opencode v2.0.15" }), "v2");
    assert.strictEqual(detectOpencodeHost({ opencodeVersion: "2.1.0-beta.1" }), "v2");
    assert.strictEqual(detectOpencodeHost({ opencodeVersion: "1.18.15" }), "v1");
    assert.strictEqual(detectOpencodeHost({ opencodeVersion: "1.99.0" }), "v1");
    assert.strictEqual(detectOpencodeHost({ opencodeVersion: "garbage" }), "unknown");
    assert.strictEqual(detectOpencodeHost({ opencodeVersion: "" }), "unknown");
  });

  it("an explicit opencodeHostDetection verdict wins over any probe", () => {
    assert.strictEqual(detectOpencodeHost({ opencodeHostDetection: "v1", opencodeVersion: "9.9.9" }), "v1");
    assert.strictEqual(detectOpencodeHost({ opencodeHostDetection: "v2", opencodeVersion: "0.1.0" }), "v2");
    assert.strictEqual(detectOpencodeHost({ opencodeHostDetection: "unknown" }), "unknown");
    // An unrecognized override is ignored, not trusted.
    assert.strictEqual(detectOpencodeHost({ opencodeHostDetection: "yes", opencodeVersion: "2.0.0" }), "v2");
  });

  it("probes the bare command first, then login shells, on posix", () => {
    const calls = [];
    const execFile = (command, args) => {
      calls.push([command, args.join(" ")]);
      if (command === "/bin/zsh") {
        const err = new Error("shell printed it");
        err.stdout = "opencode 2.3.4\n";
        throw err;
      }
      throw new Error("spawn ENOENT");
    };
    assert.strictEqual(detectOpencodeHost({ execFile, platform: "darwin" }), "v2");
    assert.strictEqual(calls[0][0], "opencode", "bare command probed first");
    assert.strictEqual(calls[1][0], "/bin/zsh", "login shell fallback");
    assert.ok(calls[1][1].includes("--version"));
  });

  it("reports unknown when every probe fails", () => {
    assert.strictEqual(detectOpencodeHost({ execFile: failingExecFile(), platform: "linux" }), "unknown");
  });

  it("a version printed on a failed probe's stderr still counts", () => {
    const execFile = (command) => {
      if (command === "opencode") {
        const err = new Error("exit 1");
        err.stderr = "opencode v2.0.15";
        throw err;
      }
      throw new Error("spawn ENOENT");
    };
    assert.strictEqual(detectOpencodeHost({ execFile, platform: "linux" }), "v2");
  });

  it("windows resolves via where, then probes the resolved binary", () => {
    const calls = [];
    const execFile = (command, args) => {
      calls.push([command, args.join(" ")]);
      if (command === "where") return "C:\\tools\\opencode.exe\r\n";
      if (command === "C:\\tools\\opencode.exe") return "1.18.3\n";
      throw new Error("unexpected probe");
    };
    assert.strictEqual(detectOpencodeHost({ execFile, platform: "win32" }), "v1");
    assert.deepStrictEqual(calls[0], ["where", "opencode"]);
    assert.deepStrictEqual(calls[1], ["C:\\tools\\opencode.exe", "--version"]);
  });

  it("probes npm Windows launchers through cmd, skipping the POSIX shim", () => {
    const bin = "C:\\Users\\Test User\\npm\\opencode.cmd";
    const execFile = (command, args, options) => {
      if (command === "where") return `C:\\Users\\Test User\\npm\\opencode\r\n${bin}\r\n`;
      assert.strictEqual(command, process.env.ComSpec || "cmd.exe");
      assert.deepStrictEqual(args, ["/d", "/v:off", "/s", "/c", `""${bin}" --version"`]);
      assert.strictEqual(options.windowsVerbatimArguments, true);
      return "opencode v2.0.15\n";
    };
    assert.strictEqual(detectOpencodeHost({ execFile, platform: "win32" }), "v2");
  });

  it("does not interpolate expandable Windows launcher paths", () => {
    let calls = 0;
    const execFile = () => { calls++; return "C:\\%UNTRUSTED%\\opencode.cmd\n"; };
    assert.strictEqual(detectOpencodeHost({ execFile, platform: "win32" }), "unknown");
    assert.strictEqual(calls, 1);
  });

  it("probeVersionText returns unparseable output as-is and empty when nothing answers", () => {
    assert.strictEqual(
      __test.probeVersionText(failingExecFile(), "linux"),
      ""
    );
    assert.strictEqual(
      __test.probeVersionText(() => "v2.0.15", "linux"),
      "v2.0.15"
    );
  });

  it("firstNonEmptyLine skips blank lines and trims", () => {
    assert.strictEqual(__test.firstNonEmptyLine("\r\n  a b \n\n"), "a b");
    assert.strictEqual(__test.firstNonEmptyLine(""), null);
    assert.strictEqual(__test.firstNonEmptyLine(null), null);
  });
});
