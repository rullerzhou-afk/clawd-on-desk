"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createSettingsSizePreviewSession,
} = require("../src/settings-size-preview-session");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("settings size preview session", () => {
  it("keeps only the latest preview value when preview work backs up", async () => {
    const previewGate = deferred();
    const previews = [];
    const session = createSettingsSizePreviewSession({
      beginProtection: async () => {},
      endProtection: async () => {},
      applyPreview: async (sizeKey) => {
        previews.push(sizeKey);
        if (sizeKey === "P:10") await previewGate.promise;
      },
      commitFinal: async () => {},
    });

    await session.begin();
    const first = session.preview("P:10");
    const second = session.preview("P:12");
    const third = session.preview("P:14");
    previewGate.resolve();
    await Promise.all([first, second, third]);

    assert.deepStrictEqual(previews, ["P:10", "P:14"]);
  });

  it("commits the final size once and always restores protection", async () => {
    const calls = [];
    const session = createSettingsSizePreviewSession({
      beginProtection: async () => { calls.push("begin"); },
      endProtection: async () => { calls.push("end"); },
      applyPreview: async (sizeKey) => { calls.push(`preview:${sizeKey}`); },
      commitFinal: async (sizeKey) => { calls.push(`commit:${sizeKey}`); },
    });

    await session.begin();
    await session.preview("P:9");
    await session.end("P:12");
    await session.cleanup();

    assert.deepStrictEqual(calls, [
      "begin",
      "preview:P:9",
      "commit:P:12",
      "end",
    ]);
  });

  it("clears partial protection after begin fails and can begin again", async () => {
    const startError = new Error("partial start failed");
    let attempts = 0;
    let protectedExternally = false;
    let stopCalls = 0;
    const session = createSettingsSizePreviewSession({
      beginProtection: () => {
        protectedExternally = true;
        if (++attempts === 1) throw startError;
      },
      endProtection: () => {
        stopCalls += 1;
        protectedExternally = false;
      },
    });

    await assert.rejects(session.begin(), (error) => error === startError);
    assert.strictEqual(protectedExternally, false);
    assert.strictEqual(stopCalls, 1);
    assert.deepStrictEqual(await session.cleanup(), { status: "ok", noop: true });
    assert.strictEqual(stopCalls, 1);

    assert.deepStrictEqual(await session.begin(), { status: "ok" });
    assert.strictEqual(protectedExternally, true);
    await session.end();
    assert.strictEqual(protectedExternally, false);
    assert.strictEqual(stopCalls, 2);
  });

  it("preserves the begin error when partial-protection cleanup also fails", async () => {
    const startError = new Error("start failed");
    const stopError = new Error("stop failed");
    let stopCalls = 0;
    const session = createSettingsSizePreviewSession({
      beginProtection: () => { throw startError; },
      endProtection: () => { stopCalls += 1; throw stopError; },
    });

    await assert.rejects(session.begin(), (error) => error === startError);
    assert.strictEqual(stopCalls, 1);
  });

  it("cleanup releases a successful preview without a renderer end request", async () => {
    let protectedExternally = false;
    let stopCalls = 0;
    const session = createSettingsSizePreviewSession({
      beginProtection: () => { protectedExternally = true; },
      endProtection: () => { stopCalls += 1; protectedExternally = false; },
    });

    await session.begin();
    assert.strictEqual(protectedExternally, true);
    await session.cleanup();
    assert.strictEqual(protectedExternally, false);
    assert.strictEqual(stopCalls, 1);
  });
});
