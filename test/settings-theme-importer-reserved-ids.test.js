"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { importUserThemeZip } = require("../src/settings-theme-importer");
const { buildZip } = require("./helpers/zip-builder");

function writeThemeZip(dir, folder) {
  const zipPath = path.join(dir, `${folder}.zip`);
  const themeJson = JSON.stringify({
    schemaVersion: 1,
    name: folder,
    version: "1.0.0",
    states: { idle: ["idle.svg"], working: ["idle.svg"], thinking: ["idle.svg"] },
  });
  fs.writeFileSync(zipPath, buildZip([
    { name: `${folder}/theme.json`, data: themeJson },
    { name: `${folder}/assets/idle.svg`, data: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>" },
  ]));
  return zipPath;
}

describe("user theme import keeps official theme ids reserved", () => {
  for (const id of ["hash-sage", "whale-chan"]) {
    it(`rejects a package whose folder is the official theme id "${id}"`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reserved-id-"));
      try {
        const userThemesDir = path.join(tmp, "themes");
        const zipPath = writeThemeZip(tmp, id);
        assert.throws(() => importUserThemeZip(zipPath, { userThemesDir }), new RegExp(`theme id "${id}" is reserved`));
        assert.strictEqual(fs.existsSync(path.join(userThemesDir, id)), false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
