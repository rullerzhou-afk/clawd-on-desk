// Unit tests for the pure helpers exposed by src/focus.js.
//
// These cover the deterministic parts of the Mac specialized focus chain
// (Superset workspace lookup, scheme derivation, pid candidate construction)
// so regressions in the lookup path get caught at CI time. AppleScript
// execution paths still rely on manual testing.

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
  buildPidCandidates,
} = focus.__test;

test.describe("focus helpers", () => {
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

    test("returns the most recently opened workspace for a path", (t) => {
      if (!sqlite3Available) return t.skip("sqlite3 CLI unavailable");
      assert.equal(querySupersetWorkspaceId(dbPath, "/tmp/foo"), "ws-recent");
    });

    test("returns null for an unknown path", (t) => {
      if (!sqlite3Available) return t.skip("sqlite3 CLI unavailable");
      assert.equal(querySupersetWorkspaceId(dbPath, "/tmp/missing"), null);
    });

    test("returns null when cwd is empty", () => {
      assert.equal(querySupersetWorkspaceId(dbPath, ""), null);
      assert.equal(querySupersetWorkspaceId(dbPath, null), null);
    });
  });

  test.describe("buildPidCandidates", () => {
    test("starts with sourcePid and dedupes pidChain", () => {
      assert.deepEqual(buildPidCandidates(100, [200, 100, 300]), [100, 200, 300]);
    });

    test("drops invalid pids", () => {
      assert.deepEqual(buildPidCandidates(100, [0, -1, NaN, "x", 200]), [100, 200]);
    });

    test("handles missing sourcePid", () => {
      assert.deepEqual(buildPidCandidates(null, [200]), [200]);
      assert.deepEqual(buildPidCandidates(0, [200]), [200]);
    });

    test("handles missing pidChain", () => {
      assert.deepEqual(buildPidCandidates(100, null), [100]);
      assert.deepEqual(buildPidCandidates(100, undefined), [100]);
    });
  });
});
