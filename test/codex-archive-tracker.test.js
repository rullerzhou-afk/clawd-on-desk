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

function idFromPath(filePath) {
  return createCodexArchiveTracker.deriveCanonicalSessionId(path.basename(filePath));
}

function sessionMetaLine(id, overrides = {}) {
  return JSON.stringify({
    timestamp: "2026-03-25T15:10:51.000Z",
    type: "session_meta",
    payload: { id, session_id: id, cwd: "/repo", ...overrides },
  });
}

function makeStat(overrides = {}) {
  const { file = true, symlink = false, ...rest } = overrides;
  return {
    size: 512,
    mtimeMs: 1000,
    dev: 1,
    ino: 1,
    isFile: () => file,
    isSymbolicLink: () => symlink,
    ...rest,
  };
}

function makeTempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-archive-"));
  const archiveDir = path.join(root, "archived_sessions");
  fs.mkdirSync(archiveDir);
  return { root, archiveDir };
}

// A fake archive filesystem: names map to { id, size, mtimeMs, ino, content }.
// `listDirectory` returns the current names; `statFile` rejects missing files.
function makeFakeArchive(initial = {}) {
  const files = new Map(Object.entries(initial));
  const readCounts = new Map();
  const fsImpl = {
    listDirectory: async () => [...files.keys()],
    statFile: async (filePath) => {
      if (path.basename(filePath) === "archived_sessions") return makeStat({ ino: 0, dev: 0 });
      const entry = files.get(path.basename(filePath));
      return entry
        ? makeStat({
          size: entry.size ?? 512,
          mtimeMs: entry.mtimeMs ?? 1000,
          ino: entry.ino ?? 1,
        })
        : null;
    },
    readFirstLine: async (filePath) => {
      const name = path.basename(filePath);
      const entry = files.get(name);
      readCounts.set(name, (readCounts.get(name) || 0) + 1);
      if (!entry) return null;
      if (entry.onRead) entry.onRead();
      if (entry.content !== undefined) return entry.content;
      const id = entry.id || idFromPath(filePath);
      return sessionMetaLine(id);
    },
  };
  return {
    files,
    readCounts,
    fsImpl,
    add: (name, entry) => files.set(name, entry),
    remove: (name) => files.delete(name),
  };
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
      createCodexArchiveTracker.deriveCanonicalSessionId(`../archived_sessions/${rolloutName(id)}`),
      null
    );
  });

  it("confirms real archive evidence and clears it on unarchive", async () => {
    const { root, archiveDir } = makeTempHome();
    const id = uuidFor(2);
    const file = path.join(archiveDir, rolloutName(id));
    fs.writeFileSync(file, `${sessionMetaLine(id)}\n`);
    const tracker = createCodexArchiveTracker({ codexHome: root, getLiveCandidateIds: () => [id] });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true);
      assert.ok(tracker.getEvidence(id));
      fs.unlinkSync(file);
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), false);
      assert.equal(tracker.getEvidence(id), null);
    } finally {
      tracker.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow a symlinked archive root or archive non-regular files", async () => {
    const { root, archiveDir } = makeTempHome();
    const id = uuidFor(8);
    fs.writeFileSync(path.join(archiveDir, rolloutName(id)), `${sessionMetaLine(id)}\n`);
    const linkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-archive-link-"));
    fs.symlinkSync(archiveDir, path.join(linkedRoot, "archived_sessions"), "dir");
    const linked = createCodexArchiveTracker({ codexHome: linkedRoot });
    try {
      await linked.scanNow();
      assert.equal(linked.isArchived(id), false);
    } finally {
      linked.stop();
      fs.rmSync(linkedRoot, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a missing archive directory as no evidence and keeps prior evidence on listing errors", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-archive-missing-"));
    const missingTracker = createCodexArchiveTracker({ codexHome: root });
    try {
      await missingTracker.scanNow();
      assert.equal(missingTracker.size, 0);
      assert.equal(missingTracker.isArchived(uuidFor(3)), false);
    } finally {
      missingTracker.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }

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
      statFile: async (filePath) =>
        path.basename(filePath) === "archived_sessions" ? makeStat({ ino: 0, dev: 0 }) : makeStat(),
      readFirstLine: async (filePath) => sessionMetaLine(idFromPath(filePath)),
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

  it("rejects malformed metadata and conflicting id/session_id", async () => {
    const id = uuidFor(5);
    const other = uuidFor(6);
    const cases = {
      "non-meta": JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      "bad-json": "{not-json",
      "id-mismatch": sessionMetaLine(other),
      "field-conflict": JSON.stringify({
        type: "session_meta",
        payload: { id, session_id: other },
      }),
      "session-only-mismatch": JSON.stringify({
        type: "session_meta",
        payload: { session_id: other },
      }),
    };
    for (const [label, content] of Object.entries(cases)) {
      const fake = makeFakeArchive({ [rolloutName(id)]: { id, content } });
      const tracker = createCodexArchiveTracker({ codexHome: "/fake", ...fake.fsImpl });
      try {
        await tracker.scanNow();
        assert.equal(tracker.isArchived(id), false, `expected UNKNOWN for ${label}`);
      } finally {
        tracker.stop();
      }
    }

    const symlink = makeFakeArchive({ [rolloutName(id)]: { id } });
    const symlinkTracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: symlink.fsImpl.listDirectory,
      readFirstLine: symlink.fsImpl.readFirstLine,
      statFile: async (filePath) =>
        path.basename(filePath) === "archived_sessions" ? makeStat({ ino: 0, dev: 0 }) : makeStat({ file: false }),
    });
    try {
      await symlinkTracker.scanNow();
      assert.equal(symlinkTracker.isArchived(id), false);
    } finally {
      symlinkTracker.stop();
    }
  });

  it("does not commit a single file that changed between stat and read", async () => {
    const id = uuidFor(7);
    let statCalls = 0;
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => [rolloutName(id)],
      statFile: async (filePath) => {
        if (path.basename(filePath) === "archived_sessions") return makeStat({ ino: 1, dev: 1 });
        statCalls += 1;
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

  it("does not retire A when A is unarchived while B is being validated (cross-candidate await)", async () => {
    const a = uuidFor(10);
    const b = uuidFor(11);
    let aPresent = true;
    const confirmed = [];
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => (aPresent ? [rolloutName(a), rolloutName(b)] : [rolloutName(b)]),
      statFile: async (filePath) => {
        if (path.basename(filePath) === "archived_sessions") return makeStat({ ino: 0, dev: 0 });
        const id = idFromPath(filePath);
        if (id === a && !aPresent) return null;
        return makeStat({ ino: id === a ? 1 : 2 });
      },
      readFirstLine: async (filePath) => {
        const id = idFromPath(filePath);
        if (id === b) aPresent = false; // A is unarchived mid-validation of B
        return sessionMetaLine(id);
      },
      getLiveCandidateIds: () => [a],
      onArchiveConfirmed: (raw) => confirmed.push(raw),
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(a), false, "stale evidence must not survive an unarchive");
      assert.deepStrictEqual(confirmed, []);
    } finally {
      tracker.stop();
    }
  });

  it("re-checks cached evidence removed while a later candidate is validated", async () => {
    const a = uuidFor(12);
    const c = uuidFor(13);
    let aPresent = true;
    let liveNow = false;
    const confirmed = [];
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      validateBatchSize: 1,
      listDirectory: async () => (aPresent ? [rolloutName(a), rolloutName(c)] : [rolloutName(c)]),
      statFile: async (filePath) => {
        if (path.basename(filePath) === "archived_sessions") return makeStat({ ino: 0, dev: 0 });
        const id = idFromPath(filePath);
        if (id === a && !aPresent) return null;
        return makeStat({ ino: id === a ? 1 : 3 });
      },
      readFirstLine: async (filePath) => {
        const id = idFromPath(filePath);
        if (id === c) aPresent = false;
        return sessionMetaLine(id);
      },
      getLiveCandidateIds: () => (liveNow ? [a] : []),
      onArchiveConfirmed: (raw) => confirmed.push(raw),
    });
    try {
      // Poll 1: A is cached but not yet live, so it is not retired.
      await tracker.scanNow();
      assert.equal(tracker.isArchived(a), true);
      // Poll 2: A becomes live; C's validation unlinks A; the cached A evidence
      // must be re-checked and dropped rather than emitting a retirement.
      liveNow = true;
      await tracker.scanNow();
      assert.equal(tracker.isArchived(a), false);
      assert.deepStrictEqual(confirmed, []);
    } finally {
      tracker.stop();
    }
  });

  it("re-validates a cached file replaced in place, including same-size corruption", async () => {
    const id = uuidFor(14);
    const validLine = sessionMetaLine(id);
    let content = validLine;
    let mtimeMs = 100;
    let size = validLine.length;
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => [rolloutName(id)],
      statFile: async (filePath) =>
        path.basename(filePath) === "archived_sessions"
          ? makeStat({ ino: 0, dev: 0 })
          : makeStat({ ino: 5, mtimeMs, size }),
      readFirstLine: async () => content,
      getLiveCandidateIds: () => [id],
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true);

      // Same inode and size, newer mtime, unparseable content: the cached entry
      // must be re-validated and dropped, not trusted.
      content = "x".repeat(validLine.length);
      mtimeMs = 200;
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), false, "same-size in-place corruption is UNKNOWN");

      // Restored valid content is re-confirmed.
      content = validLine;
      mtimeMs = 300;
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true);
    } finally {
      tracker.stop();
    }
  });

  it("prioritizes a live candidate within the bounded batch", async () => {
    const ids = Array.from({ length: 6 }, (_, i) => uuidFor(20 + i));
    const files = {};
    for (const id of ids) files[rolloutName(id)] = { id };
    const fake = makeFakeArchive(files);
    const live = ids[5];
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      validateBatchSize: 1,
      getLiveCandidateIds: () => [live],
      ...fake.fsImpl,
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(live), true, "the live candidate is validated first");
    } finally {
      tracker.stop();
    }
  });

  it("sweeps a directory larger than one batch fairly and re-reaches evicted entries", async () => {
    const ids = Array.from({ length: 6 }, (_, i) => uuidFor(40 + i));
    const files = {};
    for (const id of ids) files[rolloutName(id)] = { id };
    const fake = makeFakeArchive(files);
    const seen = new Set();
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      validateBatchSize: 1,
      maxEvidenceEntries: 2,
      ...fake.fsImpl,
    });
    try {
      for (let scan = 0; scan < 40; scan += 1) {
        await tracker.scanNow();
        assert.ok(tracker.size <= 2, "evidence cache is bounded");
        assert.ok(tracker.failedSize <= 2, "failure cache is bounded");
        for (const id of ids) {
          if (tracker.getEvidence(id)) seen.add(id);
        }
      }
      assert.equal(seen.size, ids.length, "every candidate is reachable across rotating sweeps");
    } finally {
      tracker.stop();
    }
  });

  it("does not re-read an unchanged failing candidate until its backoff or replacement", async () => {
    const id = uuidFor(60);
    let currentTime = 0;
    const fake = makeFakeArchive({ [rolloutName(id)]: { id, content: "{bad", size: 32, mtimeMs: 1 } });
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      now: () => currentTime,
      ...fake.fsImpl,
    });
    const name = rolloutName(id);
    try {
      await tracker.scanNow();
      assert.equal(fake.readCounts.get(name), 1);
      await tracker.scanNow();
      assert.equal(fake.readCounts.get(name), 1, "unchanged bad entry is not re-read");
      assert.equal(tracker.failedSize, 1);

      // Replacement changes the fingerprint -> immediate re-read.
      fake.files.get(name).mtimeMs = 2;
      fake.files.get(name).size = 33;
      await tracker.scanNow();
      assert.equal(fake.readCounts.get(name), 2);

      // Same fingerprint but past the backoff -> re-read.
      currentTime += 30 * 60 * 1000;
      await tracker.scanNow();
      assert.equal(fake.readCounts.get(name), 3);
    } finally {
      tracker.stop();
    }
  });

  it("does not re-retire a task after unarchive, so later activity is free", async () => {
    const id = uuidFor(80);
    let present = true;
    const confirmed = [];
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => (present ? [rolloutName(id)] : []),
      statFile: async (filePath) =>
        path.basename(filePath) === "archived_sessions"
          ? makeStat({ ino: 0, dev: 0 })
          : (present ? makeStat() : null),
      readFirstLine: async () => sessionMetaLine(id),
      getLiveCandidateIds: () => [id],
      onArchiveConfirmed: (raw) => confirmed.push(raw),
    });
    try {
      await tracker.scanNow();
      assert.deepStrictEqual(confirmed, [id]);
      present = false; // unarchive
      await tracker.scanNow();
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), false);
      assert.deepStrictEqual(confirmed, [id], "unarchive clears suppression; no stale re-retire");
    } finally {
      tracker.stop();
    }
  });

  it("drops in-flight work after stop and clears prior evidence", async () => {
    const id = uuidFor(70);
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
});
