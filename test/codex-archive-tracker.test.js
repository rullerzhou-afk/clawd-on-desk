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
// `readCounts` counts head reads per file so tests can assert bounded work.
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
  return { files, readCounts, fsImpl };
}

function totalReads(readCounts) {
  let total = 0;
  for (const value of readCounts.values()) total += value;
  return total;
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
    const linked = createCodexArchiveTracker({ codexHome: linkedRoot, getLiveCandidateIds: () => [id] });
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
      getLiveCandidateIds: () => [id],
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
      "truncated": null,
    };
    for (const [label, content] of Object.entries(cases)) {
      const fake = makeFakeArchive({ [rolloutName(id)]: { id, content } });
      const tracker = createCodexArchiveTracker({
        codexHome: "/fake",
        getLiveCandidateIds: () => [id],
        ...fake.fsImpl,
      });
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
      getLiveCandidateIds: () => [id],
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
      getLiveCandidateIds: () => [id],
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
      getLiveCandidateIds: () => [a, b],
      onArchiveConfirmed: (raw) => confirmed.push(raw),
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(a), false, "stale evidence must not survive an unarchive");
      assert.ok(!confirmed.includes(a));
    } finally {
      tracker.stop();
    }
  });

  it("re-checks cached evidence removed while a later live candidate is validated", async () => {
    const a = uuidFor(12);
    const c = uuidFor(13);
    let aPresent = true;
    let cContent = "{bad";
    let cIno = 3;
    let unlinkOnCRead = false;
    const confirmed = [];
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => (aPresent ? [rolloutName(a), rolloutName(c)] : [rolloutName(c)]),
      statFile: async (filePath) => {
        if (path.basename(filePath) === "archived_sessions") return makeStat({ ino: 0, dev: 0 });
        const id = idFromPath(filePath);
        if (id === a && !aPresent) return null;
        return makeStat({ ino: id === a ? 1 : cIno });
      },
      readFirstLine: async (filePath) => {
        const id = idFromPath(filePath);
        if (id === c) {
          if (unlinkOnCRead) aPresent = false; // unlink A while C is validated
          return cContent;
        }
        return sessionMetaLine(id);
      },
      getLiveCandidateIds: () => [a, c],
      onArchiveConfirmed: (raw) => confirmed.push(raw),
    });
    try {
      // Poll 1: A is confirmed (and retired); C is not yet a valid candidate.
      await tracker.scanNow();
      assert.equal(tracker.isArchived(a), true);
      assert.strictEqual(confirmed.filter((raw) => raw === a).length, 1);

      // Poll 2: C becomes valid (new fingerprint bypasses its backoff) and its
      // validation unlinks A; the cached A evidence must be re-checked and
      // dropped, with no second retirement.
      cContent = sessionMetaLine(c);
      cIno = 33;
      unlinkOnCRead = true;
      await tracker.scanNow();
      assert.equal(tracker.isArchived(a), false);
      assert.strictEqual(confirmed.filter((raw) => raw === a).length, 1);
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
    const confirmed = [];
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => [rolloutName(id)],
      statFile: async (filePath) =>
        path.basename(filePath) === "archived_sessions"
          ? makeStat({ ino: 0, dev: 0 })
          : makeStat({ ino: 5, mtimeMs, size }),
      readFirstLine: async () => content,
      getLiveCandidateIds: () => [id],
      onArchiveConfirmed: (raw) => confirmed.push(raw),
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

      // Restored valid content is re-confirmed (fresh candidate read).
      content = validLine;
      mtimeMs = 300;
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true);
      assert.ok(confirmed.length >= 1);
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
      assert.ok(totalReads(fake.readCounts) <= 1);
    } finally {
      tracker.stop();
    }
  });

  it("reads no metadata for unrelated historical archives when nothing is live", async () => {
    const files = {};
    for (let i = 0; i < 30; i += 1) {
      const id = uuidFor(100 + i);
      files[rolloutName(id)] = { id };
    }
    const fake = makeFakeArchive(files);
    const reads = [];
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: fake.fsImpl.listDirectory,
      statFile: fake.fsImpl.statFile,
      readFirstLine: async (...args) => {
        reads.push(args[0]);
        return fake.fsImpl.readFirstLine(...args);
      },
      getLiveCandidateIds: () => [],
    });
    try {
      await tracker.scanNow();
      assert.equal(reads.length, 0, "no historical metadata reads with no live candidates");
      assert.equal(tracker.size, 0);
    } finally {
      tracker.stop();
    }
  });

  it("reaches the live tail when there are more live candidates than one batch", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => uuidFor(40 + i));
    const files = {};
    for (const id of ids) files[rolloutName(id)] = { id };
    const fake = makeFakeArchive(files);
    const retired = new Set();
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      validateBatchSize: 2,
      getLiveCandidateIds: () => ids,
      onArchiveConfirmed: (raw) => retired.add(raw),
      ...fake.fsImpl,
    });
    try {
      for (let scan = 0; scan < 8 && retired.size < ids.length; scan += 1) {
        await tracker.scanNow();
      }
      assert.deepStrictEqual([...retired].sort(), [...ids].sort(), "every live tail is reached");
    } finally {
      tracker.stop();
    }
  });

  it("does not re-read an unchanged failing live candidate until its backoff or replacement", async () => {
    const id = uuidFor(60);
    let currentTime = 0;
    const fake = makeFakeArchive({ [rolloutName(id)]: { id, content: "{bad", size: 32, mtimeMs: 1 } });
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      now: () => currentTime,
      getLiveCandidateIds: () => [id],
      ...fake.fsImpl,
    });
    const name = rolloutName(id);
    try {
      await tracker.scanNow();
      assert.equal(fake.readCounts.get(name), 1);
      await tracker.scanNow();
      assert.equal(fake.readCounts.get(name), 1, "unchanged bad live entry is not re-read");
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

      // Repairing the content recovers the task.
      fake.files.get(name).content = sessionMetaLine(id);
      fake.files.get(name).mtimeMs = 4;
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true);
    } finally {
      tracker.stop();
    }
  });

  it("keeps suppression and does not retire when the evidence stat fails (EACCES)", async () => {
    const { root, archiveDir } = makeTempHome();
    const id = uuidFor(90);
    const file = path.join(archiveDir, rolloutName(id));
    fs.writeFileSync(file, `${sessionMetaLine(id)}\n`);
    let deny = false;
    const confirmed = [];
    const tracker = createCodexArchiveTracker({
      codexHome: root,
      getLiveCandidateIds: () => [id],
      onArchiveConfirmed: (raw) => confirmed.push(raw),
      statFile: async (filePath) => {
        if (deny && path.basename(filePath) === rolloutName(id)) {
          const err = new Error("EACCES");
          err.code = "EACCES";
          throw err;
        }
        try {
          return await fs.promises.lstat(filePath);
        } catch (err) {
          if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
          throw err;
        }
      },
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true);
      assert.deepStrictEqual(confirmed, [id]);

      deny = true;
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true, "EACCES is UNKNOWN, not unarchive");
      assert.deepStrictEqual(confirmed, [id], "no new retirement on EACCES");

      deny = false;
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true, "revalidated after access restored");
      assert.strictEqual(confirmed.length, 2);

      fs.unlinkSync(file);
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), false, "a real unarchive still clears suppression");
      assert.strictEqual(confirmed.length, 2);
    } finally {
      tracker.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps cached suppression when a changed re-validation read fails (EIO)", async () => {
    const { root, archiveDir } = makeTempHome();
    const id = uuidFor(91);
    const file = path.join(archiveDir, rolloutName(id));
    fs.writeFileSync(file, `${sessionMetaLine(id)}\n`);
    let failRead = false;
    let content = sessionMetaLine(id);
    const confirmed = [];
    const tracker = createCodexArchiveTracker({
      codexHome: root,
      getLiveCandidateIds: () => [id],
      onArchiveConfirmed: (raw) => confirmed.push(raw),
      readFirstLine: async () => {
        if (failRead) {
          const err = new Error("EIO");
          err.code = "EIO";
          throw err;
        }
        return content;
      },
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true);
      assert.strictEqual(confirmed.length, 1);

      // stat now observes a change (bigger file), but the re-read fails.
      fs.writeFileSync(file, `${sessionMetaLine(id)}\n{"pad":"x"}\n`);
      failRead = true;
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true, "read EIO keeps suppression");
      assert.strictEqual(confirmed.length, 1, "no retirement on read error");

      // A later readable, corrupted replacement drops suppression.
      failRead = false;
      content = "{corrupted";
      fs.writeFileSync(file, "{corrupted\n");
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), false);
    } finally {
      tracker.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a confirmed non-live task suppressed until a real unarchive", async () => {
    const id = uuidFor(92);
    let present = true;
    let liveNow = true;
    const confirmed = [];
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      listDirectory: async () => (present ? [rolloutName(id)] : []),
      statFile: async (filePath) =>
        path.basename(filePath) === "archived_sessions"
          ? makeStat({ ino: 0, dev: 0 })
          : (present ? makeStat() : null),
      readFirstLine: async () => sessionMetaLine(id),
      getLiveCandidateIds: () => (liveNow ? [id] : []),
      onArchiveConfirmed: (raw) => confirmed.push(raw),
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true);
      liveNow = false;
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true, "cached evidence keeps suppressing without live activity");
      assert.strictEqual(confirmed.length, 1);

      present = false; // real unarchive
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), false);
    } finally {
      tracker.stop();
    }
  });

  it("bounds the evidence cache", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => uuidFor(120 + i));
    const files = {};
    for (const id of ids) files[rolloutName(id)] = { id };
    const fake = makeFakeArchive(files);
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      validateBatchSize: 1,
      maxEvidenceEntries: 2,
      getLiveCandidateIds: () => ids,
      ...fake.fsImpl,
    });
    try {
      for (let scan = 0; scan < 8; scan += 1) {
        await tracker.scanNow();
        assert.ok(tracker.size <= 2, "evidence cache stays bounded");
      }
    } finally {
      tracker.stop();
    }
  });

  it("recovers a same-id orphan when the indexed duplicate is removed (D1)", async () => {
    const { root, archiveDir } = makeTempHome();
    const id = uuidFor(93);
    const n1 = `rollout-2026-03-25T15-10-51-${id}.jsonl`;
    const n2 = `rollout-2026-03-26T10-20-30-${id}.jsonl`;
    fs.writeFileSync(path.join(archiveDir, n1), `${sessionMetaLine(id)}\n`);
    fs.writeFileSync(path.join(archiveDir, n2), `${sessionMetaLine(id)}\n`);
    const confirmed = [];
    const tracker = createCodexArchiveTracker({
      codexHome: root,
      getLiveCandidateIds: () => [id],
      onArchiveConfirmed: (raw) => confirmed.push(raw),
    });
    try {
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true);
      assert.ok(confirmed.includes(id));

      // Remove whichever duplicate the index currently points at; the other
      // becomes an evidence orphan that must be requeued, not skipped forever.
      const indexed = tracker.getEvidence(id).fileName;
      const survivor = indexed === n1 ? n2 : n1;
      fs.unlinkSync(path.join(archiveDir, indexed));
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), true, "the surviving duplicate still suppresses");
      assert.equal(tracker.getEvidence(id).fileName, survivor, "the orphan is re-indexed");

      // Only a real unarchive of the remaining file releases suppression.
      fs.unlinkSync(path.join(archiveDir, survivor));
      await tracker.scanNow();
      assert.equal(tracker.isArchived(id), false);
    } finally {
      tracker.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops in-flight work after stop and clears prior evidence", async () => {
    const id = uuidFor(70);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tracker = createCodexArchiveTracker({
      codexHome: "/fake",
      getLiveCandidateIds: () => [id],
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
