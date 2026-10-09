"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  startMobilePreviewServerSafely,
} = require("../src/network/mobile-preview-lifecycle");

describe("mobile preview lifecycle", () => {
  it("converts a synchronous start failure into a logged null result", async () => {
    const errors = [];
    const result = await startMobilePreviewServerSafely({
      start() { throw new Error("sync bind failure"); },
    }, {
      source: "settings-enable",
      onError: (err, source) => errors.push([err.message, source]),
    });

    assert.equal(result, null);
    assert.deepStrictEqual(errors, [["sync bind failure", "settings-enable"]]);
  });

  it("converts an asynchronous start rejection into a logged null result", async () => {
    const errors = [];
    const result = await startMobilePreviewServerSafely({
      start: () => Promise.reject(new Error("all ports unavailable")),
    }, {
      source: "app-startup",
      onError: (err, source) => errors.push([err.message, source]),
    });

    assert.equal(result, null);
    assert.deepStrictEqual(errors, [["all ports unavailable", "app-startup"]]);
  });

  it("returns the bound port without reporting an error", async () => {
    const errors = [];
    const result = await startMobilePreviewServerSafely({
      start: () => Promise.resolve(23336),
    }, { onError: (err) => errors.push(err) });

    assert.equal(result, 23336);
    assert.deepStrictEqual(errors, []);
  });

  it("still contains the start failure when the error reporter throws", async () => {
    const result = await startMobilePreviewServerSafely({
      start: () => Promise.reject(new Error("bind failure")),
    }, {
      onError() { throw new Error("logger failure"); },
    });

    assert.equal(result, null);
  });

  it("wires both main-process start sites through the safe helper", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const helperCalls = mainSource.match(/startMobilePreviewServerSafely\(_lanWss,/g) || [];
    assert.equal(helperCalls.length, 2);
    assert.doesNotMatch(mainSource, /_lanWss\.start\(\)/);
  });
});
