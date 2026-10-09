"use strict";

// opencode host major-version detection (PR #1045 follow-up): the v2
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
    assert.strictEqual(detectOpencodeHost({ platform: "linux", opencodeVersion: "opencode v2.0.15" }), "v2");
    assert.strictEqual(detectOpencodeHost({ platform: "linux", opencodeVersion: "2.1.0-beta.1" }), "v2");
    assert.strictEqual(detectOpencodeHost({ platform: "linux", opencodeVersion: "1.18.15" }), "v1");
    assert.strictEqual(detectOpencodeHost({ platform: "linux", opencodeVersion: "1.99.0" }), "v1");
    assert.strictEqual(detectOpencodeHost({ platform: "linux", opencodeVersion: "garbage" }), "unknown");
    assert.strictEqual(detectOpencodeHost({ platform: "linux", opencodeVersion: "" }), "unknown");
  });

  it("an explicit opencodeHostDetection verdict wins over any probe", () => {
    assert.strictEqual(detectOpencodeHost({ platform: "linux", opencodeHostDetection: "v1", opencodeVersion: "9.9.9" }), "v1");
    assert.strictEqual(detectOpencodeHost({ platform: "linux", opencodeHostDetection: "v2", opencodeVersion: "0.1.0" }), "v2");
    assert.strictEqual(detectOpencodeHost({ platform: "linux", opencodeHostDetection: "unknown" }), "unknown");
    // An unrecognized override is ignored, not trusted.
    assert.strictEqual(detectOpencodeHost({ platform: "linux", opencodeHostDetection: "yes", opencodeVersion: "2.0.0" }), "v2");
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

  it("PR #1045 follow-up: Windows resolves a Chinese PATH without decoding where output", () => {
    const calls = [];
    const bin = "C:\\Users\\张三\\npm\\opencode.cmd";
    const execFile = (command, args) => {
      calls.push([command, args.join(" ")]);
      if (command === "cmd.exe") return "opencode v2.0.15\n";
      throw new Error("unexpected probe");
    };
    const fs = { statSync(candidate) {
      if (candidate !== bin) throw new Error("ENOENT");
      return { isFile: () => true };
    } };
    assert.strictEqual(detectOpencodeHost({ execFile, platform: "win32", env: { Path: "C:\\Users\\张三\\npm" }, fs }), "v2");
    assert.deepStrictEqual(calls, [["cmd.exe", `/d /v:off /s /c ""${bin}" --version"`]]);
  });

  it("PR #1045 follow-up: Windows honors uppercase PATH and PATHEXT order", () => {
    const bin = "C:\\tools\\opencode.exe";
    const execFile = (command, args, options) => {
      assert.strictEqual(command, bin);
      assert.deepStrictEqual(args, ["--version"]);
      assert.strictEqual(options.windowsVerbatimArguments, undefined);
      return "1.18.32\n";
    };
    const fs = { statSync(candidate) {
      if ([bin, "C:\\tools\\opencode.cmd"].includes(candidate)) return { isFile: () => true };
      throw new Error("ENOENT");
    } };
    assert.strictEqual(detectOpencodeHost({ execFile, platform: "win32", env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" }, fs }), "v1");
  });

  it("PR #1045 follow-up: Windows skips non-executable PATHEXT entries", () => {
    const bin = "C:\\tools\\opencode.cmd";
    const calls = [];
    const fs = { statSync(candidate) {
      if (["C:\\tools\\opencode.js", bin].includes(candidate)) return { isFile: () => true };
      throw new Error("ENOENT");
    } };
    const execFile = (command, args) => {
      calls.push([command, args]);
      return command === "cmd.exe" ? "opencode v2.0.15\n" : "";
    };
    assert.strictEqual(detectOpencodeHost({ execFile, platform: "win32", env: { PATH: "C:\\tools", PATHEXT: ".JS;.CMD" }, fs }), "v2");
    assert.deepStrictEqual(calls, [["cmd.exe", ["/d", "/v:off", "/s", "/c", `""${bin}" --version"`]]]);
  });

  it("PR #1045 follow-up: Windows permits percent in an exe path but protects cmd launchers", () => {
    const dir = "C:\\Users\\100%real\\npm";
    const exe = `${dir}\\opencode.exe`;
    const cmd = `${dir}\\opencode.cmd`;
    const calls = [];
    const execFile = (command, args) => {
      calls.push([command, args]);
      return "opencode v2.0.15\n";
    };
    const fs = { statSync(candidate) {
      if ([exe, cmd].includes(candidate)) return { isFile: () => true };
      throw new Error("ENOENT");
    } };
    assert.strictEqual(detectOpencodeHost({ execFile, platform: "win32", env: { PATH: dir, PATHEXT: ".EXE;.CMD" }, fs }), "v2");
    assert.deepStrictEqual(calls, [[exe, ["--version"]]]);
    calls.length = 0;
    assert.strictEqual(detectOpencodeHost({ execFile, platform: "win32", env: { PATH: dir, PATHEXT: ".CMD" }, fs }), "unknown");
    assert.deepStrictEqual(calls, []);
  });

  it("does not interpolate expandable Windows launcher paths", () => {
    let calls = 0;
    const execFile = () => { calls++; return "2.0.15\n"; };
    const fs = { statSync: () => ({ isFile: () => true }) };
    assert.strictEqual(detectOpencodeHost({ execFile, platform: "win32", env: { PATH: "C:\\%UNTRUSTED%", PATHEXT: ".CMD" }, fs }), "unknown");
    assert.strictEqual(calls, 0);
  });

  it("PR #1045 follow-up: Windows reports unknown when PATH has no executable", () => {
    assert.strictEqual(detectOpencodeHost({ platform: "win32", env: { PATH: "C:\\empty" },
      fs: { statSync: () => { throw new Error("ENOENT"); } }, execFile: failingExecFile() }), "unknown");
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
