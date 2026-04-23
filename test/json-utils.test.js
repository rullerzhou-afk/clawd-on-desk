const { describe, it } = require("node:test");
const assert = require("node:assert");
const { extractExistingNodeBin } = require("../hooks/json-utils");

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
