const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { rotatedAppend, DEFAULT_MAX_BYTES } = require("../src/log-rotate");

const tempDirs = [];

function makeTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-log-rotate-"));
  tempDirs.push(d);
  return path.join(d, "test.log");
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("rotatedAppend", () => {
  it("creates and appends to a new file", () => {
    const f = makeTmp();
    rotatedAppend(f, "line1\n", 1024);
    rotatedAppend(f, "line2\n", 1024);
    assert.strictEqual(fs.readFileSync(f, "utf8"), "line1\nline2\n");
  });

  it("does not truncate when under maxBytes", () => {
    const f = makeTmp();
    const line = "a".repeat(100) + "\n";
    for (let i = 0; i < 5; i++) rotatedAppend(f, line, 1024);
    assert.strictEqual(fs.statSync(f).size, 505);
  });

  it("truncates to roughly half when exceeding maxBytes", () => {
    const f = makeTmp();
    const maxBytes = 200;
    // Write 10 lines of 30 bytes each = 300 bytes total
    for (let i = 0; i < 10; i++) {
      rotatedAppend(f, `[${String(i).padStart(2, "0")}] ${"x".repeat(24)}\n`, maxBytes);
    }
    const content = fs.readFileSync(f, "utf8");
    // File should be truncated: smaller than 300, and should not contain earliest lines
    assert.ok(content.length < 300, `expected < 300, got ${content.length}`);
    assert.ok(content.length > 0);
    // Should start at a line boundary (no partial line at the beginning)
    assert.ok(content.startsWith("["), `should start with [, got: ${content.slice(0, 10)}`);
    // Earliest lines should be gone
    assert.ok(!content.includes("[00]"), "line 00 should have been truncated");
  });

  it("preserves line boundaries after truncation", () => {
    const f = makeTmp();
    const maxBytes = 100;
    for (let i = 0; i < 20; i++) {
      rotatedAppend(f, `line-${i}\n`, maxBytes);
    }
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    // Every line should be complete (start with "line-")
    for (const l of lines) {
      assert.ok(l.startsWith("line-"), `broken line: ${l}`);
    }
  });

  it("DEFAULT_MAX_BYTES is 1 MB", () => {
    assert.strictEqual(DEFAULT_MAX_BYTES, 1024 * 1024);
  });
});
