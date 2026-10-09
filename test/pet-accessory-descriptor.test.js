"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { resolveAccessoryDescriptor } = require("../src/pet-accessory-descriptor");

describe("pet accessory descriptor resolver", () => {
  const attachments = {
    files: {
      "idle.svg": { staticFrame: { cx: 8, baseY: 6, width: 9 } },
      "sleep.svg": { visibility: "hidden" },
    },
    itemOverrides: {
      "cowboy-hat": {
        files: {
          "idle.svg": { staticFrame: { cx: 9, baseY: 7, width: 10 } },
          "sleep.svg": { staticFrame: { cx: 4, baseY: 3, width: 7 } },
        },
      },
    },
  };

  it("uses an exact item/file override before the materialized base file", () => {
    assert.strictEqual(
      resolveAccessoryDescriptor({ attachments, itemId: "cowboy-hat", file: "idle.svg" }),
      attachments.itemOverrides["cowboy-hat"].files["idle.svg"]
    );
    assert.strictEqual(
      resolveAccessoryDescriptor({ attachments, itemId: "wizard-hat", file: "idle.svg" }),
      attachments.files["idle.svg"]
    );
  });

  it("does not revive authored default/mini branches at runtime", () => {
    const withDeadFallbacks = {
      ...attachments,
      default: { staticFrame: { cx: 1, baseY: 1, width: 1 } },
      mini: { staticFrame: { cx: 2, baseY: 2, width: 2 } },
    };
    assert.strictEqual(
      resolveAccessoryDescriptor({ attachments: withDeadFallbacks, itemId: "cowboy-hat", file: "unknown.svg" }),
      null
    );
  });

  it("fails closed for unsafe ids, paths, and malformed attachment maps", () => {
    assert.strictEqual(resolveAccessoryDescriptor({ attachments, itemId: "../hat", file: "idle.svg" }), null);
    assert.strictEqual(resolveAccessoryDescriptor({ attachments, itemId: "cowboy-hat", file: "../idle.svg" }), null);
    assert.strictEqual(resolveAccessoryDescriptor({ attachments: null, itemId: "cowboy-hat", file: "idle.svg" }), null);
  });
});
