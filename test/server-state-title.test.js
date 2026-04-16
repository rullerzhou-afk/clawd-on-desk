"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { extractSessionTitleFromStatePayload } = require("../src/server").__test;

describe("extractSessionTitleFromStatePayload", () => {
  it("reads session_title when hooks send it", () => {
    assert.strictEqual(
      extractSessionTitleFromStatePayload({ session_title: "Renamed Session" }),
      "Renamed Session"
    );
  });

  it("falls back across common title keys", () => {
    assert.strictEqual(
      extractSessionTitleFromStatePayload({ conversationTitle: "Conversation Name" }),
      "Conversation Name"
    );
  });

  it("ignores blank strings", () => {
    assert.strictEqual(
      extractSessionTitleFromStatePayload({ session_title: "   ", title: "" }),
      null
    );
  });
});
