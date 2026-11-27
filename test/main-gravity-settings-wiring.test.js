"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

it("gravity: starts from the gravity pref", () => {
  assert.match(
    source,
    /require\("\.\/gravity"\)\(_roamCtx,\s*\{\s*enabled:\s*_settingsController\.get\("gravity"\) === true,/,
  );
});

it("gravity: follows later changes of the gravity pref, like Free roam", () => {
  assert.match(
    source,
    /subscribeKey\("gravity",\s*\(value\) => \{\s*_gravity\.setEnabled\(value === true\);\s*\}\)/,
  );
});
