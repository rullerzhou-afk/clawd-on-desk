"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { __test } = require("../src/mac-window");

function makeTransaction(overrides = {}) {
  const calls = [];
  const transaction = {
    activeSpace: 42,
    level: 0,
    addToActiveSpace: () => calls.push("add-active"),
    removeFromPrivateSpace: () => calls.push("remove-private"),
    setNativeLevel: (level) => calls.push(`level:${level}`),
    restoreStationary: () => calls.push("restore-stationary"),
    onFailure: () => calls.push("failure"),
    ...overrides,
  };
  return { calls, transaction };
}

describe("macOS stationary Space de-delegation transaction", () => {
  it("keeps optional de-delegation symbols separate from the base stationary API", () => {
    const calls = [];
    const lib = {
      func(name) {
        calls.push(name);
        if (name === "SLSGetActiveSpace") throw new Error("symbol unavailable");
        return () => {};
      },
    };

    assert.strictEqual(__test.resolveSkyLightDeDelegateApi(lib), null);
    assert.deepStrictEqual(calls, ["SLSRemoveWindowsFromSpaces", "SLSGetActiveSpace"]);
  });

  it("does not mutate Space membership or level without a valid active Space", () => {
    const { calls, transaction } = makeTransaction({ activeSpace: 0 });

    assert.strictEqual(__test.runDeDelegateTransaction(transaction), false);
    assert.deepStrictEqual(calls, []);
  });

  it("adds to the active Space before removing the private Space and lowering the level", () => {
    const { calls, transaction } = makeTransaction();

    assert.strictEqual(__test.runDeDelegateTransaction(transaction), true);
    assert.deepStrictEqual(calls, ["add-active", "remove-private", "level:0"]);
  });

  for (const failedStep of ["add-active", "remove-private", "level:0"]) {
    it(`rolls back the stationary Space and level when ${failedStep} fails`, () => {
      const { calls, transaction } = makeTransaction();
      if (failedStep === "add-active") {
        transaction.addToActiveSpace = () => {
          calls.push("add-active");
          throw new Error("add failed");
        };
      } else if (failedStep === "remove-private") {
        transaction.removeFromPrivateSpace = () => {
          calls.push("remove-private");
          throw new Error("remove failed");
        };
      } else {
        transaction.setNativeLevel = (level) => {
          calls.push(`level:${level}`);
          if (level === 0) throw new Error("level failed");
        };
      }

      assert.strictEqual(__test.runDeDelegateTransaction(transaction), false);
      const rollbackAt = calls.indexOf("restore-stationary");
      assert.notStrictEqual(rollbackAt, -1);
      assert.deepStrictEqual(calls.slice(rollbackAt), ["restore-stationary", "level:1500", "failure"]);
    });
  }

  it("still restores the native level when the stationary rollback itself fails", () => {
    const { calls, transaction } = makeTransaction({
      addToActiveSpace: () => {
        throw new Error("add failed");
      },
      restoreStationary: () => {
        calls.push("restore-stationary");
        throw new Error("restore failed");
      },
    });

    assert.strictEqual(__test.runDeDelegateTransaction(transaction), false);
    assert.deepStrictEqual(calls, ["restore-stationary", "level:1500", "failure"]);
  });
});
