const assert = require("assert");
const { describe, it } = require("node:test");

const { keepOutOfTaskbar, __test } = require("../src/taskbar");

describe("taskbar helpers", () => {
  it("reasserts skipTaskbar on Windows and Linux", () => {
    assert.strictEqual(__test.shouldKeepOutOfTaskbar("win32"), true);
    assert.strictEqual(__test.shouldKeepOutOfTaskbar("linux"), true);
    assert.strictEqual(__test.shouldKeepOutOfTaskbar("darwin"), false);
  });

  it("safely ignores missing or destroyed windows", () => {
    assert.doesNotThrow(() => keepOutOfTaskbar(null));
    assert.doesNotThrow(() => keepOutOfTaskbar({ isDestroyed: () => true }));
    assert.doesNotThrow(() => keepOutOfTaskbar({ isDestroyed: () => false }));
  });

  it("calls setSkipTaskbar on supported runtime platforms", () => {
    let called = false;
    keepOutOfTaskbar({
      isDestroyed: () => false,
      setSkipTaskbar(value) {
        called = value;
      },
    });

    assert.strictEqual(called, __test.shouldKeepOutOfTaskbar(process.platform));
  });
});
