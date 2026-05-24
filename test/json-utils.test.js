const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractExistingNodeBin, extractExistingNodeBinFromCommands, formatNodeHookCommand, writeJsonAtomicAsync } = require("../hooks/json-utils");

describe("extractExistingNodeBin", () => {
  it("extracts node path from flat command format", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"/usr/local/bin/node" "/path/to/cursor-hook.js"' }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "cursor-hook.js"),
      "/usr/local/bin/node"
    );
  });

  it("extracts node path from nested format with { nested: true }", () => {
    const settings = {
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/opt/homebrew/bin/node" "/path/to/codebuddy-hook.js"' }],
        }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "codebuddy-hook.js", { nested: true }),
      "/opt/homebrew/bin/node"
    );
  });

  it("returns null for nested format without { nested: true }", () => {
    const settings = {
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/opt/homebrew/bin/node" "/path/to/codebuddy-hook.js"' }],
        }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "codebuddy-hook.js"),
      null
    );
  });

  it("returns null for empty or missing settings", () => {
    assert.strictEqual(extractExistingNodeBin({}, "cursor-hook.js"), null);
    assert.strictEqual(extractExistingNodeBin(null, "cursor-hook.js"), null);
    assert.strictEqual(extractExistingNodeBin({ hooks: {} }, "cursor-hook.js"), null);
  });

  it("returns null when first quoted token is not an absolute path", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"node" "/path/to/cursor-hook.js"' }],
      },
    };
    assert.strictEqual(extractExistingNodeBin(settings, "cursor-hook.js"), null);
  });

  it("skips when first quoted token is the marker itself", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"/path/to/cursor-hook.js"' }],
      },
    };
    assert.strictEqual(extractExistingNodeBin(settings, "cursor-hook.js"), null);
  });

  it("extracts node path from Windows cmd wrapper format", () => {
    const settings = {
      hooks: {
        stop: [{
          command: 'cmd /d /s /c ""C:\\Program Files\\nodejs\\node.exe" "D:/animation/hooks/cursor-hook.js""',
        }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "cursor-hook.js"),
      "C:\\Program Files\\nodejs\\node.exe"
    );
  });

  it("extracts node path with forward-slash Windows mixed style", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"C:/Program Files/nodejs/node.exe" "D:/animation/hooks/cursor-hook.js"' }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "cursor-hook.js"),
      "C:/Program Files/nodejs/node.exe"
    );
  });

  it("extracts node path from a UNC share", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"\\\\fileserver\\tools\\nodejs\\node.exe" "C:\\Clawd\\cursor-hook.js"' }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "cursor-hook.js"),
      "\\\\fileserver\\tools\\nodejs\\node.exe"
    );
  });
});

describe("extractExistingNodeBinFromCommands", () => {
  it("extracts the first absolute path that is not the hook script", () => {
    const commands = ['"/usr/local/bin/node" "/path/to/kimi-hook.js"'];
    assert.strictEqual(extractExistingNodeBinFromCommands(commands, "kimi-hook.js"), "/usr/local/bin/node");
  });

  it("returns Windows drive paths verbatim", () => {
    const commands = ['"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\.kimi\\hooks\\kimi-hook.js"'];
    assert.strictEqual(
      extractExistingNodeBinFromCommands(commands, "kimi-hook.js"),
      "C:\\Program Files\\nodejs\\node.exe"
    );
  });

  it("returns UNC paths", () => {
    const commands = ['"\\\\fileserver\\tools\\node.exe" "C:\\hooks\\kimi-hook.js"'];
    assert.strictEqual(
      extractExistingNodeBinFromCommands(commands, "kimi-hook.js"),
      "\\\\fileserver\\tools\\node.exe"
    );
  });

  it("skips bare 'node' and returns null when nothing absolute is found", () => {
    const commands = ['"node" "/path/to/kimi-hook.js"'];
    assert.strictEqual(extractExistingNodeBinFromCommands(commands, "kimi-hook.js"), null);
  });

  it("walks past commands that begin with the marker itself", () => {
    const commands = [
      '"/path/to/kimi-hook.js"',
      '"/usr/bin/node" "/path/to/kimi-hook.js"',
    ];
    assert.strictEqual(extractExistingNodeBinFromCommands(commands, "kimi-hook.js"), "/usr/bin/node");
  });

  it("returns null for non-array or missing inputs", () => {
    assert.strictEqual(extractExistingNodeBinFromCommands([], "kimi-hook.js"), null);
    assert.strictEqual(extractExistingNodeBinFromCommands(null, "kimi-hook.js"), null);
    assert.strictEqual(extractExistingNodeBinFromCommands(["something"], ""), null);
  });

  it("ignores non-string entries in the commands array", () => {
    const commands = [null, 42, '"/usr/bin/node" "/hooks/kimi-hook.js"'];
    assert.strictEqual(extractExistingNodeBinFromCommands(commands, "kimi-hook.js"), "/usr/bin/node");
  });
});

describe("formatNodeHookCommand", () => {
  it("formats POSIX commands as quoted node + script", () => {
    assert.strictEqual(
      formatNodeHookCommand("/usr/local/bin/node", "/app/hooks/codex-debug-hook.js", {
        platform: "linux",
      }),
      '"/usr/local/bin/node" "/app/hooks/codex-debug-hook.js"'
    );
  });

  it("formats Windows PowerShell commands with call operator", () => {
    assert.strictEqual(
      formatNodeHookCommand("C:\\Program Files\\nodejs\\node.exe", "D:/app/hooks/kiro-hook.js", {
        platform: "win32",
        windowsWrapper: "powershell",
      }),
      '& "C:\\Program Files\\nodejs\\node.exe" "D:/app/hooks/kiro-hook.js"'
    );
  });

  it("formats Windows cmd-wrapped commands", () => {
    assert.strictEqual(
      formatNodeHookCommand("C:\\Program Files\\nodejs\\node.exe", "D:/app/hooks/codex-debug-hook.js", {
        platform: "win32",
        windowsWrapper: "cmd",
      }),
      'cmd /d /s /c ""C:\\Program Files\\nodejs\\node.exe" "D:/app/hooks/codex-debug-hook.js""'
    );
  });
});

describe("writeJsonAtomicAsync", () => {
  it("writes pretty JSON atomically and cleans up tmp files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-json-utils-"));
    const filePath = path.join(tmpDir, "settings.json");
    try {
      await writeJsonAtomicAsync(filePath, { hooks: { Stop: [] } });
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.deepStrictEqual(parsed, { hooks: { Stop: [] } });
      const leftovers = fs.readdirSync(tmpDir).filter((name) => name.includes(".tmp"));
      assert.deepStrictEqual(leftovers, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
