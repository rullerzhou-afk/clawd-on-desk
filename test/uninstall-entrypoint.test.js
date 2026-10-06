"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("requiring the Claude uninstall entrypoint has no filesystem side effects", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-uninstall-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeHome = path.join(root, ".claude");
  const settingsPath = path.join(claudeHome, "settings.json");
  fs.mkdirSync(claudeHome, { recursive: true });
  const settings = {
    hooks: {
      Stop: [{
        matcher: "",
        hooks: [{ type: "command", command: "node /tmp/clawd-hook.js" }],
      }],
    },
  };
  const before = `${JSON.stringify(settings, null, 2)}\n`;
  fs.writeFileSync(settingsPath, before, "utf8");

  const result = spawnSync(process.execPath, [
    "-e",
    "const entry=require('./hooks/uninstall.js'); if(typeof entry.main!=='function') process.exit(2);",
  ], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome },
    encoding: "utf8",
  });

  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
  assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), before);
});
