"use strict";

// Unit tests for src/wsl-utils.js (parseDistroList, excluded distros, etc.)
// Does NOT require Windows or WSL — tests only the pure functions.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  parseDistroList,
  EXCLUDED_DISTROS,
} = require("../src/wsl-utils");

describe("wsl-utils", () => {
  describe("parseDistroList", () => {
    it("parses single distro", () => {
      assert.deepStrictEqual(parseDistroList("Ubuntu"), ["Ubuntu"]);
    });

    it("parses multiple distros", () => {
      assert.deepStrictEqual(
        parseDistroList("Ubuntu\r\nDebian\r\nAlpine"),
        ["Ubuntu", "Debian", "Alpine"]
      );
    });

    it("trims whitespace and filters empty lines", () => {
      assert.deepStrictEqual(
        parseDistroList("  Ubuntu  \r\n\r\nDebian\r\n  "),
        ["Ubuntu", "Debian"]
      );
    });

    it("handles null-byte characters from wsl.exe output", () => {
      assert.deepStrictEqual(
        parseDistroList("Ubuntu\0Debian"),
        ["UbuntuDebian"]
      );
    });

    it("returns empty array for empty input", () => {
      assert.deepStrictEqual(parseDistroList(""), []);
      assert.deepStrictEqual(parseDistroList(null), []);
      assert.deepStrictEqual(parseDistroList(undefined), []);
    });

    it("filters only-whitespace lines", () => {
      assert.deepStrictEqual(parseDistroList("Ubuntu\r\n   \r\nDebian"), ["Ubuntu", "Debian"]);
    });
  });

  describe("EXCLUDED_DISTROS", () => {
    it("excludes docker-desktop", () => {
      assert.ok(EXCLUDED_DISTROS.has("docker-desktop"));
    });

    it("excludes docker-desktop-data", () => {
      assert.ok(EXCLUDED_DISTROS.has("docker-desktop-data"));
    });

    it("excludes DevHOME", () => {
      assert.ok(EXCLUDED_DISTROS.has("DevHOME"));
    });
  });
});
