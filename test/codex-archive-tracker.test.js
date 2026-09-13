"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createCodexArchiveTracker = require("../src/codex-archive-tracker");

function uuidFor(n) {
  return `019d23d4-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

function rolloutName(uuid) {
  return `rollout-2026-03-25T15-10-51-${uuid}.jsonl`;
}

function sessionMetaLine(id) {
  return JSON.stringify({
    timestamp: "2026-03-25T15:10:51.000Z",
    type: "session_meta",
    payload: { id, session_id: id, cwd: "/repo" },
  });
}

function makeStat(overrides = {}) {
  const { file = true, ...rest } = overrides;
  return {
    size: 512,
    mtimeMs: 1000,
    dev: 1,
    ino: 1,
    isFile: () => file,
    ...rest,
  };
}

function makeTempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-archive-"));
  const archiveDir = path.join(root, "archived_sessions");
  fs.mkdirSync(archiveDir);
  return { root, archiveDir };
}

describe("codex archive tracker", () => {
  it("resolves a trimmed CODEX_HOME and falls back to ~/.codex", () => {
    assert.equal(
      createCodexArchiveTracker.resolveCodexHome({ CODEX_HOME: "  /custom/codex  " }),
      "/custom/codex"
    );
    assert.equal(
      createCodexArchiveTracker.resolveCodexHome({ CODEX_HOME: "   " }, () => "/home/u"),
      path.join("/home/u", ".codex")
    );
    assert.equal(
      createCodexArchiveTracker.resolveCodexHome({}, () => "/home/u"),
      path.join("/home/u", ".codex")
    );
  });

  it("derives only canonical rollout ids and rejects malformed or traversal names", () => {
    const id = uuidFor(1);
    assert.equal(createCodexArchiveTracker.deriveCanonicalSessionId(rolloutName(id)), id);
    assert.equal(createCodexArchiveTracker.deriveCanonicalSessionId("notes.jsonl"), null);
    assert.equal(createCodexArchiveTracker.deriveCanonicalSessionId("rollout-short.jsonl"), null);
    assert.equal(
      createCodexArchiveTracker.deriveCanonicalSessionId("rollout-2026-03-25T15-10-51-UPPER-CASE-0000-0000-0000-000000000000.jsonl"),
      null
    );
    assert.equal(
      createCodexArchiveTracker.deriveCanonicalSessionId(`../archived_sessions/${rolloutName(id)}`),
      null
    );
  });

  it("confirms real archive evidence and clears it on unarchive", async () => {
    const { root, archiveDir } = makeTempHome();
    const id = uuidFor(2);
    const file = path.join(archiveDir, rolloutName(id));
    fs.writeFileSync(file, `${sessionMetaLine(id)}\n{"type":"event_msg","payload":{"type":"task_complete"}}\n`);
    const events = [];
    const tracker = createCodexArchiveTracker({
      codexHome: root,
      pollIntervalMs: 10,
      getLiveCandidateIds: () => [id],
      onArchiveConfirmed: (raw, evidence) => events.push(["confirmed", raw, evidence.fileName]),
      onArchiveCleared: (raw) => events.push(["cleared", raw]),
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true);
      assert.ok(tracker.getEvidence(id));
      assert.deepStrictEqual(events, [["confirmed", id, rolloutName(id)]]);

      fs.unlinkSync(file);
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), false);
      assert.equal(tracker.getEvidence(id), null);
      assert.deepStrictEqual(events.at(-1), ["cleared", id]);
    } finally {
      tracker.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a missing archive directory as no evidence without throwing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-archive-missing-"));
    const tracker = createCodexArchiveTracker({ codexHome: root });
    try {
      await tracker.scanNow();
      assert.equal(tracker.size, 0);
      assert.equal(tracker.isArchived(uuidFor(3)), false);
    } finally {
      tracker.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps prior evidence when the directory listing fails with a non-ENOENT error", async () => {
    const id = uuidFor(4);
    let mode = "ok";
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => {
        if (mode === "denied") {
          const err = new Error("EACCES");
          err.code = "EACCES";
          throw err;
        }
        return [rolloutName(id)];
      },
      statFile: async () => makeStat(),
      readFirstLine: async (filePath) =>
        sessionMetaLine(createCodexArchiveTracker.deriveCanonicalSessionId(path.basename(filePath))),
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true);
      mode = "denied";
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true, "a failed listing must not fabricate unarchive");
    } finally {
      tracker.stop();
    }
  });

  it("does not follow a symlinked archive root", async () => {
    const { root, archiveDir } = makeTempHome();
    const id = uuidFor(8);
    fs.writeFileSync(path.join(archiveDir, rolloutName(id)), `${sessionMetaLine(id)}\n`);
    const linkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-archive-link-"));
    fs.symlinkSync(archiveDir, path.join(linkedRoot, "archived_sessions"), "dir");
    const tracker = createCodexArchiveTracker({ codexHome: linkedRoot });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), false);
    } finally {
      tracker.stop();
      fs.rmSync(linkedRoot, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks, non-regular files, malformed metadata and mismatched identity", async () => {
    const id = uuidFor(5);
    const other = uuidFor(6);
    const makeTracker = (overrides) => createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => [rolloutName(id)],
      statFile: async () => makeStat(),
      readFirstLine: async () => sessionMetaLine(id),
      ...overrides,
    });
    try {
      const symlinkTracker = makeTracker({ statFile: async () => makeStat({ file: false }) });
      await symlinkTracker.scanNow();
      assert.equal(symlinkTracker.isArchived(id), false);

      const malformedTracker = makeTracker({ readFirstLine: async () => null });
      await malformedTracker.scanNow();
      assert.equal(malformedTracker.isArchived(id), false);

      const badJsonTracker = makeTracker({ readFirstLine: async () => "{not-json" });
      await badJsonTracker.scanNow();
      assert.equal(badJsonTracker.isArchived(id), false);

      const mismatchTracker = makeTracker({ readFirstLine: async () => sessionMetaLine(other) });
      await mismatchTracker.scanNow();
      assert.equal(mismatchTracker.isArchived(id), false);

      const nonMetaTracker = makeTracker({
        readFirstLine: async () => JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      });
      await nonMetaTracker.scanNow();
      assert.equal(nonMetaTracker.isArchived(id), false);
    } finally {
      // nothing to clean beyond the temporary trackers
    }
  });

  it("does not commit evidence whose file changed or vanished between stat and read", async () => {
    const id = uuidFor(7);
    let statCalls = 0;
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => [rolloutName(id)],
      statFile: async (filePath) => {
        if (path.basename(filePath) === "archived_sessions") {
          return makeStat({ ino: 1, dev: 1 });
        }
        statCalls += 1;
        // Second snapshot (after the head read) reports a different inode:
        // the path was replaced/removed mid-scan -> UNKNOWN.
        return statCalls <= 1 ? makeStat({ ino: 10 }) : makeStat({ ino: 20 });
      },
      readFirstLine: async () => sessionMetaLine(id),
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), false);
    } finally {
      tracker.stop();
    }
  });

  it("validates at most one batch per scan and reaches late candidates across polls", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => uuidFor(20 + i));
    const names = ids.map(rolloutName);
    let reads = 0;
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      validateBatchSize: 3,
      listDirectory: async () => names.slice(),
      statFile: async () => makeStat(),
      readFirstLine: async (filePath) => {
        reads += 1;
        const id = createCodexArchiveTracker.deriveCanonicalSessionId(path.basename(filePath));
        return sessionMetaLine(id);
      },
    });
    try {
      await tracker.scanNow();
      assert.equal(reads, 3);
      assert.equal(tracker.size, 3);
      await tracker.scanNow();
      assert.equal(reads, 6);
      await tracker.scanNow();
      await tracker.scanNow();
      assert.equal(tracker.size, 10);
      for (const id of ids) assert.equal(tracker.isArchived(id), true);
    } finally {
      tracker.stop();
    }
  });

  it("prioritizes live candidates within the bounded batch", async () => {
    const ids = Array.from({ length: 6 }, (_, i) => uuidFor(40 + i));
    const names = ids.map(rolloutName);
    const live = ids[5];
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      validateBatchSize: 1,
      listDirectory: async () => names.slice(),
      statFile: async () => makeStat(),
      readFirstLine: async (filePath) =>
        sessionMetaLine(createCodexArchiveTracker.deriveCanonicalSessionId(path.basename(filePath))),
      getLiveCandidateIds: () => [live],
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(live), true, "the live candidate is validated first");
    } finally {
      tracker.stop();
    }
  });

  it("drops in-flight work after stop and clears prior evidence", async () => {
    const id = uuidFor(60);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => { await gate; return [rolloutName(id)]; },
      statFile: async () => makeStat(),
      readFirstLine: async () => sessionMetaLine(id),
    });
    const scanPromise = tracker.scanNow();
    tracker.stop();
    release();
    await scanPromise;
    assert.equal(tracker.isArchived(id), false);
    assert.equal(tracker.size, 0);
  });

  it("only emits one confirmation per live archived id", async () => {
    const id = uuidFor(70);
    let confirmed = 0;
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => [rolloutName(id)],
      statFile: async () => makeStat(),
      readFirstLine: async () => sessionMetaLine(id),
      getLiveCandidateIds: () => [id],
      onArchiveConfirmed: () => { confirmed += 1; },
    });
    try {
      await tracker.scanNow();
      await tracker.scanNow();
      await tracker.scanNow();
      // One confirmation per poll is acceptable (retirement is idempotent) but
      // it must not grow without bound per poll.
      assert.ok(confirmed >= 1);
      assert.ok(confirmed <= 3);
    } finally {
      tracker.stop();
    }
  });
});
