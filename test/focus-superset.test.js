// Unit tests for the Superset deep-link helpers in src/focus.js.
//
// These cover the deterministic parts of the Superset focus path
// (data-dir discovery, scheme derivation, workspace-id sqlite lookup)
// so regressions get caught at CI time. The AppleScript / `open` paths
// remain manual-test territory.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const focus = require("../src/focus");
const {
  findSupersetDataDirs,
  supersetSchemeForDir,
  querySupersetWorkspaceId,
} = focus.__test;

test.describe("focus Superset helpers", () => {
  test.describe("supersetSchemeForDir", () => {
    test("returns 'superset' for the default install dir", () => {
      assert.equal(supersetSchemeForDir("/Users/x/.superset"), "superset");
    });

    test("returns the namespaced scheme for custom instances", () => {
      assert.equal(supersetSchemeForDir("/Users/x/.superset-staging"), "superset-staging");
    });

    test("returns null for unrelated paths", () => {
      assert.equal(supersetSchemeForDir("/Users/x/Documents"), null);
      assert.equal(supersetSchemeForDir("/tmp/.supersettings"), null);
    });
  });

  test.describe("findSupersetDataDirs", () => {
    test("returns dirs whose name starts with .superset and contain local.db", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "focus-superset-"));
      try {
        const matchA = path.join(tmp, ".superset");
        const matchB = path.join(tmp, ".superset-foo");
        const noDb = path.join(tmp, ".superset-empty");
        const unrelated = path.join(tmp, "supersettings");
        for (const dir of [matchA, matchB, noDb, unrelated]) fs.mkdirSync(dir);
        fs.writeFileSync(path.join(matchA, "local.db"), "");
        fs.writeFileSync(path.join(matchB, "local.db"), "");

        const found = findSupersetDataDirs(tmp).sort();
        assert.deepEqual(found, [matchA, matchB].sort());
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test("returns [] when the home dir cannot be read", () => {
      const missing = path.join(os.tmpdir(), "focus-superset-missing-" + Date.now());
      assert.deepEqual(findSupersetDataDirs(missing), []);
    });
  });

  test.describe("querySupersetWorkspaceId", () => {
    let tmp;
    let dbPath;
    let sqlite3Available = true;

    test.before(() => {
      try {
        execFileSync("sqlite3", ["-version"], { timeout: 1000 });
      } catch {
        sqlite3Available = false;
        return;
      }
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "focus-superset-db-"));
      dbPath = path.join(tmp, "local.db");
      // Minimal schema mirroring the Superset tables we read.
      execFileSync("sqlite3", [dbPath, `
        CREATE TABLE worktrees (id TEXT PRIMARY KEY, path TEXT NOT NULL);
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, worktree_id TEXT, last_opened_at INTEGER);
        INSERT INTO worktrees VALUES ('w1', '/tmp/foo');
        INSERT INTO worktrees VALUES ('w2', '/tmp/bar');
        INSERT INTO workspaces VALUES ('ws-old', 'w1', 100);
        INSERT INTO workspaces VALUES ('ws-recent', 'w1', 999);
        INSERT INTO workspaces VALUES ('ws-bar', 'w2', 500);
      `]);
    });

    test.after(() => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    test("returns the most recently opened workspace for a path", (t, done) => {
      if (!sqlite3Available) { t.skip("sqlite3 CLI unavailable"); return done(); }
      querySupersetWorkspaceId(dbPath, "/tmp/foo", (id) => {
        assert.equal(id, "ws-recent");
        done();
      });
    });

    test("returns null for an unknown path", (t, done) => {
      if (!sqlite3Available) { t.skip("sqlite3 CLI unavailable"); return done(); }
      querySupersetWorkspaceId(dbPath, "/tmp/missing", (id) => {
        assert.equal(id, null);
        done();
      });
    });

    test("returns null when cwd is empty", (t, done) => {
      let received = 0;
      const expect = (id) => {
        assert.equal(id, null);
        received += 1;
        if (received === 2) done();
      };
      querySupersetWorkspaceId(dbPath || "/dev/null", "", expect);
      querySupersetWorkspaceId(dbPath || "/dev/null", null, expect);
    });
  });
});
