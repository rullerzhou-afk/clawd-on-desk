"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const audit = require("../scripts/audit-pr-history-assets");

const POLICY = { thresholds: { largeTrackedBinaryMediaBytes: 1024 } };

function findingRules(report) {
  return report.findings.map((finding) => `${finding.rule}:${finding.path}`);
}

describe("PR-history asset audit analysis", () => {
  it("passes a small binary and fails a large one without an allowlist", () => {
    const small = audit.analyzePrHistoryAssets({
      blobs: [{ path: "assets/thumb.png", oid: "a".repeat(40), bytes: 512 }],
      policy: POLICY,
    });
    assert.deepStrictEqual(small.findings, []);

    const large = audit.analyzePrHistoryAssets({
      blobs: [{ path: "docs/hero.png", oid: "b".repeat(40), bytes: 4096 }],
      policy: POLICY,
    });
    assert.strictEqual(large.findings.length, 1);
    assert.strictEqual(large.findings[0].rule, "large-binary-in-pr-history");
  });

  it("accepts an exact allowlist entry and rejects oid/size mismatches", () => {
    const blob = { path: "assets/needed.png", oid: "c".repeat(40), bytes: 8192 };
    const exact = audit.analyzePrHistoryAssets({
      blobs: [blob],
      policy: POLICY,
      allowlist: [{ path: "assets/needed.png", oid: "c".repeat(40), bytes: 8192, owner: "design-assets", reason: "runtime asset" }],
    });
    assert.deepStrictEqual(exact.findings, []);

    const oidMismatch = audit.analyzePrHistoryAssets({
      blobs: [blob],
      policy: POLICY,
      allowlist: [{ path: "assets/needed.png", oid: "d".repeat(40), bytes: 8192, owner: "design-assets", reason: "runtime asset" }],
    });
    assert.strictEqual(oidMismatch.findings.length, 1);
    assert.match(oidMismatch.findings[0].message, /allowlisted oid\/bytes/);

    const bytesMismatch = audit.analyzePrHistoryAssets({
      blobs: [blob],
      policy: POLICY,
      allowlist: [{ path: "assets/needed.png", oid: "c".repeat(40), bytes: 1, owner: "design-assets", reason: "runtime asset" }],
    });
    assert.strictEqual(bytesMismatch.findings.length, 1);
  });

  it("fails an incomplete allowlist entry and drops it (fail closed)", () => {
    const report = audit.analyzePrHistoryAssets({
      blobs: [{ path: "assets/needed.png", oid: "c".repeat(40), bytes: 8192 }],
      policy: POLICY,
      allowlist: [{ path: "assets/needed.png", oid: "c".repeat(40) }],
    });
    // One invalid-entry error plus the unexempted large binary.
    assert.strictEqual(report.findings.length, 2);
    assert.ok(report.findings.some((finding) => finding.rule === "allowlist-entry-invalid"));
    assert.ok(report.findings.some((finding) => finding.rule === "large-binary-in-pr-history"));
  });

  it("rejects allowlist entries with an unregistered or unknown owner", () => {
    const owners = { "design-assets": "x" };
    const unregistered = audit.validateAllowlistEntries(
      [{ path: "assets/needed.png", oid: "c".repeat(40), bytes: 8192, owner: "nobody", reason: "x" }],
      owners,
    );
    assert.strictEqual(unregistered.valid.length, 0);
    assert.strictEqual(unregistered.findings[0].rule, "allowlist-entry-invalid");
    assert.match(unregistered.findings[0].message, /owner-unregistered/);

    const unknownOwner = audit.validateAllowlistEntries(
      [{ path: "assets/needed.png", oid: "c".repeat(40), bytes: 8192, owner: "unknown", reason: "x" }],
      owners,
    );
    assert.strictEqual(unknownOwner.valid.length, 0);

    const ok = audit.validateAllowlistEntries(
      [{ path: "assets/needed.png", oid: "c".repeat(40), bytes: 8192, owner: "design-assets", reason: "x" }],
      owners,
    );
    assert.strictEqual(ok.valid.length, 1);
    assert.deepStrictEqual(ok.findings, []);
  });

  it("fails any themes/hash-sage blob unconditionally", () => {
    const report = audit.analyzePrHistoryAssets({
      blobs: [
        { path: "themes/hash-sage/assets/idle.apng", oid: "e".repeat(40), bytes: 10 },
        { path: "themes/hash-sage/assets/big.apng", oid: "f".repeat(40), bytes: 10 * 1024 * 1024 },
        { path: "themes/hash-sage/README.md", oid: "1".repeat(40), bytes: 10 },
      ],
      policy: POLICY,
      allowlist: [{ path: "themes/hash-sage/assets/idle.apng", oid: "e".repeat(40), bytes: 10, owner: "theme-runtime", reason: "nope" }],
    });
    assert.strictEqual(report.findings.length, 3);
    for (const finding of report.findings) assert.strictEqual(finding.rule, "hash-sage-asset-in-history");
  });

  it("fails any themes/whale-chan blob unconditionally", () => {
    const report = audit.analyzePrHistoryAssets({
      blobs: [
        { path: "themes/whale-chan/theme.json", oid: "2".repeat(40), bytes: 10 },
        { path: "themes/whale-chan/assets/whale-chan-idle.apng", oid: "3".repeat(40), bytes: 10 * 1024 * 1024 },
      ],
      policy: POLICY,
      allowlist: [{ path: "themes/whale-chan/theme.json", oid: "2".repeat(40), bytes: 10, owner: "theme-runtime", reason: "nope" }],
    });
    assert.strictEqual(report.findings.length, 2);
    for (const finding of report.findings) {
      assert.strictEqual(finding.rule, "whale-chan-asset-in-history");
      assert.strictEqual(finding.message, "themes/whale-chan/** must never appear in PR-reachable history");
    }
  });

  it("validates the base SHA strictly", () => {
    assert.strictEqual(audit.validateBaseSha("a".repeat(40)), "a".repeat(40));
    for (const bad of ["", "zz".repeat(20), "A".repeat(40), "a".repeat(39), null]) {
      assert.throws(() => audit.validateBaseSha(bad));
    }
  });

  it("allows only HEAD or an exact lowercase head SHA", () => {
    assert.strictEqual(audit.validateHeadRef("HEAD"), "HEAD");
    assert.strictEqual(audit.validateHeadRef("b".repeat(40)), "b".repeat(40));
    for (const bad of ["", "main", "--help", "B".repeat(40), "b".repeat(39), null]) {
      assert.throws(() => audit.validateHeadRef(bad));
    }
  });
});

describe("PR-history asset audit on a real git range", () => {
  let repo;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-pr-history-"));
    const git = (...args) => execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
    });
    git("init", "-q");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "README.md"), "base");
    git("add", ".");
    git("commit", "-qm", "base");
    git("branch", "-M", "main");
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function git(...args) {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  }

  it("catches a large blob that was added early and deleted later in the range", () => {
    const base = git("rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repo, "docs.png"), Buffer.alloc(4096, 7));
    git("add", ".");
    git("commit", "-qm", "add large");
    fs.rmSync(path.join(repo, "docs.png"));
    git("add", "-A");
    git("commit", "-qm", "delete large");

    const report = audit.runAudit({ repoRoot: repo, base, policy: POLICY });
    assert.strictEqual(report.findings.length, 1);
    assert.strictEqual(report.findings[0].rule, "large-binary-in-pr-history");
    assert.strictEqual(report.findings[0].path, "docs.png");
  });

  it("does not flag a large base asset that a merge brings into the branch", () => {
    // base0 -> feature branch adds a text file.
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "notes.txt"), "feature side");
    git("add", ".");
    git("commit", "-qm", "feature text");
    // main (the PR base) adds a large approved asset.
    git("checkout", "-q", "main");
    fs.mkdirSync(path.join(repo, "assets", "gif"), { recursive: true });
    fs.writeFileSync(path.join(repo, "assets", "gif", "base-approved.png"), Buffer.alloc(4096, 5));
    git("add", ".");
    git("commit", "-qm", "main large approved");
    const prBase = git("rev-parse", "HEAD").trim();
    // feature merges main; the merge reports main's asset as "added".
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "-m", "merge main", "main");

    const report = audit.runAudit({ repoRoot: repo, base: prBase, policy: POLICY });
    assert.deepStrictEqual(report.findings, [], "base path+OID must not be reported");

    // Sanity: the same file added as a genuinely new path on the feature side
    // (after the merge) still fails.
    const prBase2 = git("rev-parse", "HEAD").trim();
    fs.mkdirSync(path.join(repo, "assets", "new"), { recursive: true });
    fs.writeFileSync(path.join(repo, "assets", "new", "fresh.png"), Buffer.alloc(4096, 6));
    git("add", ".");
    git("commit", "-qm", "feature adds new large");
    const report2 = audit.runAudit({ repoRoot: repo, base: prBase2, policy: POLICY });
    assert.strictEqual(report2.findings.length, 1);
    assert.strictEqual(report2.findings[0].path, "assets/new/fresh.png");
  });

  it("uses the merge-base when the PR head is behind the current base tip", () => {
    const branchPoint = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "feature-large.png"), Buffer.alloc(4096, 8));
    git("add", ".");
    git("commit", "-qm", "feature large asset");
    const featureHead = git("rev-parse", "HEAD").trim();

    git("checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "base-update.txt"), "base advanced");
    git("add", ".");
    git("commit", "-qm", "advance base");
    const eventBase = git("rev-parse", "HEAD").trim();

    const report = audit.runAudit({
      repoRoot: repo,
      base: eventBase,
      head: featureHead,
      policy: POLICY,
    });
    assert.strictEqual(report.range.base, branchPoint);
    assert.strictEqual(report.range.eventBase, eventBase);
    assert.strictEqual(report.range.head, featureHead);
    assert.strictEqual(report.findings.length, 1);
    assert.strictEqual(report.findings[0].path, "feature-large.png");
  });

  it("catches a forbidden path that reuses a blob already reachable from base", () => {
    // Base owns the blob at a benign path.
    fs.mkdirSync(path.join(repo, "seed"), { recursive: true });
    fs.writeFileSync(path.join(repo, "seed", "existing.png"), Buffer.alloc(4096, 3));
    git("add", ".");
    git("commit", "-qm", "seed blob");
    const base = git("rev-parse", "HEAD").trim();

    // PR copies the SAME blob to a forbidden path...
    fs.mkdirSync(path.join(repo, "themes", "hash-sage", "assets"), { recursive: true });
    fs.copyFileSync(
      path.join(repo, "seed", "existing.png"),
      path.join(repo, "themes", "hash-sage", "assets", "copied.png"),
    );
    git("add", "-A");
    git("commit", "-qm", "copy base blob to forbidden path");
    // ...then deletes it again, so the final tree is clean and the blob was
    // never newly introduced in the range.
    git("rm", "-q", "themes/hash-sage/assets/copied.png");
    git("commit", "-qm", "delete copied");

    const report = audit.runAudit({ repoRoot: repo, base, policy: POLICY });
    assert.strictEqual(report.findings.length, 1);
    assert.strictEqual(report.findings[0].rule, "hash-sage-asset-in-history");
    assert.strictEqual(report.findings[0].path, "themes/hash-sage/assets/copied.png");
  });

  it("catches a base blob renamed into the forbidden tree", () => {
    fs.writeFileSync(path.join(repo, "big.png"), Buffer.alloc(4096, 4));
    git("add", ".");
    git("commit", "-qm", "big at benign path");
    const base = git("rev-parse", "HEAD").trim();

    fs.mkdirSync(path.join(repo, "themes", "hash-sage", "assets"), { recursive: true });
    git("mv", "big.png", "themes/hash-sage/assets/big.png");
    git("commit", "-qm", "rename into forbidden tree");

    const report = audit.runAudit({ repoRoot: repo, base, policy: POLICY });
    assert.strictEqual(report.findings.length, 1);
    assert.strictEqual(report.findings[0].rule, "hash-sage-asset-in-history");
    assert.strictEqual(report.findings[0].path, "themes/hash-sage/assets/big.png");
  });

  it("loads and honors the checked-in policy allowlist by default", () => {
    const base = git("rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repo, "docs.png"), Buffer.alloc(4096, 9));
    git("add", ".");
    git("commit", "-qm", "large media");
    const oid = git("rev-parse", "HEAD:docs.png").trim();

    const blocked = audit.runAudit({ repoRoot: repo, base, policy: POLICY });
    assert.strictEqual(blocked.findings.length, 1);

    const allowed = audit.runAudit({
      repoRoot: repo,
      base,
      policy: {
        ...POLICY,
        owners: { "docs-readme": "x" },
        prHistoryAssetAllowlist: [{
          path: "docs.png",
          oid,
          bytes: 4096,
          owner: "docs-readme",
          reason: "reviewed",
        }],
      },
    });
    assert.deepStrictEqual(allowed.findings, []);

    // A malformed entry is rejected and cannot exempt the blob.
    const invalid = audit.runAudit({
      repoRoot: repo,
      base,
      policy: {
        ...POLICY,
        owners: { "docs-readme": "x" },
        prHistoryAssetAllowlist: [{ path: "docs.png", oid, bytes: 4096, owner: "docs-readme" }],
      },
    });
    assert.ok(invalid.findings.some((finding) => finding.rule === "allowlist-entry-invalid"));
    assert.ok(invalid.findings.some((finding) => finding.rule === "large-binary-in-pr-history"));

    // An exact-shaped but mismatched (stale OID) entry still fails.
    const stale = audit.runAudit({
      repoRoot: repo,
      base,
      policy: {
        ...POLICY,
        owners: { "docs-readme": "x" },
        prHistoryAssetAllowlist: [{ path: "docs.png", oid: "0".repeat(40), bytes: 4096, owner: "docs-readme", reason: "stale" }],
      },
    });
    assert.ok(stale.findings.some((finding) => finding.rule === "large-binary-in-pr-history"));
  });

  it("passes a legitimate small media file and fails hash-sage assets", () => {
    const base = git("rev-parse", "HEAD").trim();
    fs.mkdirSync(path.join(repo, "assets"), { recursive: true });
    fs.writeFileSync(path.join(repo, "assets", "small.png"), Buffer.alloc(128, 1));
    git("add", ".");
    git("commit", "-qm", "small media");
    let report = audit.runAudit({ repoRoot: repo, base, policy: POLICY });
    assert.deepStrictEqual(report.findings, []);

    const base2 = git("rev-parse", "HEAD").trim();
    fs.mkdirSync(path.join(repo, "themes", "hash-sage", "assets"), { recursive: true });
    fs.writeFileSync(path.join(repo, "themes", "hash-sage", "assets", "idle.apng"), Buffer.alloc(16, 2));
    git("add", ".");
    git("commit", "-qm", "hash sage asset");
    report = audit.runAudit({ repoRoot: repo, base: base2, policy: POLICY });
    assert.strictEqual(report.findings.length, 1);
    assert.strictEqual(report.findings[0].rule, "hash-sage-asset-in-history");
  });
});
