"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSessionFolderOpener } = require("../src/session-open-folder");

test("session folder opener re-resolves a local session and opens its existing cwd", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-session-folder-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const opened = [];
  const sessions = new Map([["s1", { cwd, host: null, platform: null, headless: false }]]);
  const openSessionFolder = createSessionFolderOpener({
    getSession: (id) => sessions.get(id),
    openPath: async (folder) => { opened.push(folder); return ""; },
  });

  assert.deepStrictEqual(await openSessionFolder("s1"), { status: "ok" });
  assert.deepStrictEqual(opened, [cwd]);
});

test("session folder opener rejects renderer-supplied paths and unsafe sessions", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-session-folder-"));
  const file = path.join(cwd, "file.txt");
  fs.writeFileSync(file, "x");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const opened = [];
  const sessions = new Map([
    ["remote", { cwd, host: "server.example", platform: null }],
    ["webui", { cwd, host: null, platform: "webui" }],
    ["relative", { cwd: "relative/path", host: null, platform: null }],
    ["missing", { cwd: path.join(cwd, "missing"), host: null, platform: null }],
    ["file", { cwd: file, host: null, platform: null }],
  ]);
  const openSessionFolder = createSessionFolderOpener({
    getSession: (id) => sessions.get(id),
    openPath: async (folder) => { opened.push(folder); return ""; },
  });

  for (const payload of [
    { sessionId: "safe", cwd: cwd },
    "unknown",
    "remote",
    "webui",
    "relative",
    "missing",
    "file",
  ]) {
    const result = await openSessionFolder(payload);
    assert.notStrictEqual(result.status, "ok", `must reject ${JSON.stringify(payload)}`);
  }
  assert.deepStrictEqual(opened, []);
});

test("session folder opener reports shell.openPath failures", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-session-folder-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const openSessionFolder = createSessionFolderOpener({
    getSession: () => ({ cwd, host: null, platform: null }),
    openPath: async () => "No application is associated with the specified file",
  });

  const result = await openSessionFolder("s1");
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /No application/);
});
