"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const localizedReadmes = [
  "README.zh-CN.md",
  "README.zh-TW.md",
  "README.ja-JP.md",
  "README.ko-KR.md",
  "README.es.md",
];

function supportAgents(file) {
  const lines = fs.readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
  const supportLine = lines.find((line) => line.startsWith(">") && line.includes("**Codex CLI**"));
  assert.ok(supportLine, `${file}: missing agent support list`);
  const names = [...supportLine.matchAll(/\*\*([^*]+)\*\*/g)]
    .map((match) => match[1].replace(/[（(][^（）()]*[）)]$/u, "").trim());
  assert.strictEqual(new Set(names).size, names.length, `${file}: duplicate agent`);
  return new Set(names);
}

test("README agent support lists track the English product names", () => {
  const english = supportAgents("README.md");
  for (const file of localizedReadmes) {
    const translated = supportAgents(file);
    assert.deepStrictEqual([...translated].sort(), [...english].sort(), `${file}: agent support list differs from English`);
  }
});
