"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

test("terminal-focus extension activates on startup and focuses terminal input", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "extensions", "vscode", "package.json"),
    "utf8"
  ));
  const source = fs.readFileSync(
    path.join(repoRoot, "extensions", "vscode", "extension.js"),
    "utf8"
  );
  const main = fs.readFileSync(path.join(repoRoot, "src", "main.js"), "utf8");

  assert.equal(manifest.version, "0.1.1");
  assert.match(main, /const EXT_VERSION = "0\.1\.1"/);
  assert.ok(manifest.activationEvents.includes("onStartupFinished"));
  assert.ok(manifest.activationEvents.includes("onUri"));
  assert.match(source, /terminal\.show\(false\)/);
  assert.doesNotMatch(source, /terminal\.show\(true\)/);
});
