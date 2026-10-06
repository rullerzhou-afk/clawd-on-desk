const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN = path.join(ROOT, "src", "main.js");
const TUTORIAL_HERO = path.join(ROOT, "assets", "icon.png");
const pkg = require("../package.json");

test("first-run tutorial hero image is packaged", () => {
  assert.ok(fs.existsSync(TUTORIAL_HERO), "assets/icon.png should exist");
  assert.ok(
    pkg.build.files.includes("assets/icon.png"),
    "build.files should include assets/icon.png"
  );
});

test("first-run tutorial hero source matches packaged asset", () => {
  const source = fs.readFileSync(MAIN, "utf8");
  assert.ok(
    source.includes('path.join(__dirname, "..", "assets", "icon.png")'),
    "main.js should point the tutorial hero at assets/icon.png"
  );
});
