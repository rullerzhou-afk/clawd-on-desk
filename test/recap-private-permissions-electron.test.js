"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("Electron main can load Koffi and harden a Windows recap root", {
  skip: process.platform !== "win32",
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-electron-acl-"));
  const root = path.join(parent, "recap-v1");
  const userData = path.join(parent, "electron-user-data");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const electron = require("electron");
  const fixture = path.join(__dirname, "fixtures", "recap-private-permissions-electron.js");
  const result = spawnSync(electron, [fixture, `--user-data-dir=${userData}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAWD_RECAP_ELECTRON_ACL_ROOT: root,
    },
    shell: false,
    timeout: 30000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /RECAP_ELECTRON_ACL_OK/);
});
