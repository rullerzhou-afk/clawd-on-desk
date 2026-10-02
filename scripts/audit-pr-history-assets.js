#!/usr/bin/env node
"use strict";

// ── PR-history asset audit ──
//
// `audit:assets` only looks at the current tree/package inputs, so it cannot
// stop the "add a 180 MiB blob in commit 2, delete it in commit 27" shape: the
// final tree is clean, but every clone and fork still pays for the object.
//
// This audit walks every commit in `merge-base(base, head)..head` (`base` and
// `head` come from the PR event and are validated before use) and inspects the
// *changed tree paths* of each commit against all of its parents (add / modify /
// rename / copy shapes). Using the merge-base keeps the audited range scoped to
// the contributor branch even when the base branch advances without a rebase.
// For each changed path it resolves the blob at that commit/path.
//
// That shape matters for two classes the old `rev-list --objects base..HEAD`
// scan missed:
//   - a blob reintroduced at a forbidden path whose OID already existed in base
//     (reachability from HEAD can't distinguish a copy of a base blob), and
//   - an early-added blob that a later commit deletes (unreachable from HEAD,
//     but still present in the intermediate commit).
//
// Any occurrence of `themes/hash-sage/**` or `themes/whale-chan/**` fails
// unconditionally — official theme art (Hash Sage, Whale-chan) is distributed
// as a downloadable official theme, never in this repo. Other newly changed binary media above the shared
// `largeTrackedBinaryMediaBytes` threshold fails unless it matches an exact,
// reviewed allowlist entry (path + OID + bytes + owner + reason).

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { BINARY_MEDIA_EXTENSIONS } = require("./audit-repository-assets");

const BASE_SHA_ENV = "PR_BASE_SHA";
const HEAD_SHA_ENV = "PR_HEAD_SHA";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const HASH_SAGE_ASSET_PREFIX = "themes/hash-sage/";
const WHALE_CHAN_ASSET_PREFIX = "themes/whale-chan/";
const OFFICIAL_THEME_ASSET_RULES = [
  { prefix: HASH_SAGE_ASSET_PREFIX, rule: "hash-sage-asset-in-history" },
  { prefix: WHALE_CHAN_ASSET_PREFIX, rule: "whale-chan-asset-in-history" },
];
const DEFAULT_HEAD = "HEAD";

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function validateBaseSha(raw) {
  if (typeof raw !== "string" || !SHA_PATTERN.test(raw)) {
    throw new Error(
      `PR base SHA must be a 40-character lowercase hex string; got ${JSON.stringify(raw)}. `
      + `Pass it via ${BASE_SHA_ENV} (the workflow gives github.event.pull_request.base.sha).`,
    );
  }
  return raw;
}

function validateHeadRef(raw) {
  if (raw === DEFAULT_HEAD) return raw;
  if (typeof raw !== "string" || !SHA_PATTERN.test(raw)) {
    throw new Error(
      `PR head must be HEAD or a 40-character lowercase hex string; got ${JSON.stringify(raw)}. `
      + `Pass the pull request head SHA via ${HEAD_SHA_ENV}.`,
    );
  }
  return raw;
}

function revParse(repoRoot, ref) {
  return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function resolveMergeBase(repoRoot, baseSha, headSha) {
  const mergeBase = execFileSync("git", ["merge-base", baseSha, headSha], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (!SHA_PATTERN.test(mergeBase)) {
    throw new Error(`Could not resolve a valid merge-base for ${baseSha} and ${headSha}.`);
  }
  return mergeBase;
}

// `git rev-list --objects <base>..<head>`: lines are "<oid>" or "<oid> <path>".
function parseRevListObjects(raw) {
  const entries = [];
  for (const line of String(raw || "").split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const oid = line.slice(0, space).trim();
    const objectPath = line.slice(space + 1);
    if (!/^[0-9a-f]{40,64}$/.test(oid)) continue;
    entries.push({ oid, path: normalizePath(objectPath) });
  }
  return entries;
}

function readRangeObjects(repoRoot, baseSha, headRef = DEFAULT_HEAD) {
  const raw = execFileSync("git", ["rev-list", "--objects", `${baseSha}..${headRef}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseRevListObjects(raw);
}

// Parse `git diff-tree -r --raw -z --no-commit-id` output. Each record is
//   :<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0
// and a rename/copy record carries two paths: \0<src>\0<dst>\0. Deletions and
// gitlinks are skipped; the returned (oid, path) is the blob introduced at that
// path by that commit.
function parseDiffTreeRaw(raw) {
  const entries = [];
  const tokens = String(raw || "").split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  let index = 0;
  while (index < tokens.length) {
    const header = tokens[index];
    if (!header.startsWith(":")) {
      index += 1;
      continue;
    }
    const parts = header.slice(1).split(" ");
    const newMode = parts[1];
    const newSha = parts[3];
    const status = parts[4] || "";
    index += 1;
    if (index >= tokens.length) break;
    const firstPath = tokens[index];
    index += 1;
    let changedPath = firstPath;
    if (/^[RC]/.test(status)) {
      if (index >= tokens.length) break;
      changedPath = tokens[index];
      index += 1;
    }
    if (/^D/.test(status)) continue;
    if (newMode === "160000") continue;
    if (!newSha || /^0+$/.test(newSha)) continue;
    entries.push({ oid: newSha, path: normalizePath(changedPath) });
  }
  return entries;
}

// Exact (path, blob OID) membership of the validated PR base tree. A merge that
// brings a base file into the PR branch shows that file as "added" against the
// other parent; if the exact path+OID already belongs to the base, it is not a
// newly introduced object and must not be reported. Fail closed: any parse or
// git failure throws so the audit cannot silently pass.
function readBaseTreeEntries(repoRoot, baseSha) {
  const raw = execFileSync("git", ["ls-tree", "-r", "-z", baseSha], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const set = new Set();
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    const oid = meta[2];
    if (!oid || !/^[0-9a-f]{40,64}$/.test(oid)) continue;
    set.add(`${oid}\0${normalizePath(record.slice(tab + 1))}`);
  }
  return set;
}

function readCommitParents(repoRoot, commit) {
  const line = execFileSync("git", ["rev-list", "--parents", "-n", "1", commit], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  return line.split(/\s+/).slice(1);
}

// Every (blob, path) a commit in base..HEAD introduces at a changed path,
// diffed against each of its parents. Deduped by OID+path.
function collectIntroducedBlobs(repoRoot, baseSha, headRef = DEFAULT_HEAD) {
  const commitsOutput = execFileSync("git", ["rev-list", "--reverse", `${baseSha}..${headRef}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
  const commits = commitsOutput ? commitsOutput.split("\n") : [];
  const byKey = new Map();
  for (const commit of commits) {
    const parents = readCommitParents(repoRoot, commit);
    const comparisons = parents.length === 0
      ? [["--root", commit]]
      : parents.map((parent) => [parent, commit]);
    for (const pair of comparisons) {
      const raw = execFileSync("git", ["diff-tree", "-r", "-M", "--raw", "-z", "--no-commit-id", ...pair], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      for (const entry of parseDiffTreeRaw(raw)) {
        const key = `${entry.oid}\0${entry.path}`;
        if (!byKey.has(key)) byKey.set(key, entry);
      }
    }
  }
  return [...byKey.values()];
}

// Batch-resolve object type + size. A missing/non-numeric record fails closed.
function readObjectMetadata(repoRoot, oids) {
  const unique = [...new Set(oids)];
  const meta = new Map();
  const BATCH = 500;
  for (let offset = 0; offset < unique.length; offset += BATCH) {
    const chunk = unique.slice(offset, offset + BATCH);
    const output = execFileSync("git", ["cat-file", "--batch-check=%(objecttype) %(objectsize)"], {
      cwd: repoRoot,
      encoding: "utf8",
      input: `${chunk.join("\n")}\n`,
      maxBuffer: 64 * 1024 * 1024,
    });
    const lines = output.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length !== chunk.length) {
      throw new Error(`git cat-file returned ${lines.length} line(s) for ${chunk.length} object(s)`);
    }
    for (let i = 0; i < chunk.length; i += 1) {
      const match = lines[i].match(/^([a-z-]+) (\d+)$/);
      if (!match) {
        throw new Error(`git cat-file returned an unparsable record: ${JSON.stringify(lines[i])}`);
      }
      meta.set(chunk[i], { type: match[1], bytes: Number(match[2]) });
    }
  }
  return meta;
}

function collectBlobs(rangeEntries, objectMeta) {
  const blobs = [];
  const seen = new Set();
  for (const entry of rangeEntries) {
    const info = objectMeta.get(entry.oid);
    if (!info || info.type !== "blob") continue;
    const key = `${entry.oid}\0${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blobs.push({ oid: entry.oid, path: entry.path, bytes: info.bytes });
  }
  return blobs;
}

const OID_PATTERN = /^[0-9a-f]{40,64}$/;

function normalizeAllowlist(allowlist) {
  return (allowlist || []).map((entry) => (entry && typeof entry === "object"
    ? { ...entry, path: normalizePath(entry.path) }
    : { path: normalizePath(entry) }));
}

// An allowlist entry only ever authorizes the exact (path, oid, bytes) it names.
// Anything malformed or unknown-owner is rejected as an error *and* dropped, so
// a typo cannot silently widen the exemption.
function validateAllowlistEntries(allow, owners) {
  const findings = [];
  const valid = [];
  for (const entry of allow) {
    const problems = [];
    if (typeof entry.path !== "string" || !entry.path) problems.push("path");
    if (typeof entry.oid !== "string" || !OID_PATTERN.test(entry.oid)) problems.push("oid");
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) problems.push("bytes");
    if (typeof entry.owner !== "string" || !entry.owner || entry.owner === "unknown") problems.push("owner");
    else if (owners && !Object.prototype.hasOwnProperty.call(owners, entry.owner)) problems.push("owner-unregistered");
    if (typeof entry.reason !== "string" || !entry.reason.trim()) problems.push("reason");
    if (problems.length > 0) {
      findings.push({
        level: "error",
        rule: "allowlist-entry-invalid",
        path: entry.path,
        message: `allowlist entry is missing/invalid (${problems.join(", ")}); it is ignored`,
      });
      continue;
    }
    valid.push(entry);
  }
  return { valid, findings };
}

function findAllowlistMatch(blob, allowlist) {
  return allowlist.find((entry) => entry.path === blob.path && entry.oid === blob.oid && entry.bytes === blob.bytes) || null;
}

// Pure analysis so the test suite drives it with synthetic ranges.
function analyzePrHistoryAssets({ blobs, allowlist = [], policy, owners } = {}) {
  const findings = [];
  const threshold = Number(
    policy && policy.thresholds && policy.thresholds.largeTrackedBinaryMediaBytes,
  );
  if (!Number.isFinite(threshold) || threshold <= 0) {
    findings.push({ level: "error", rule: "asset-policy-invalid", message: "policy.thresholds.largeTrackedBinaryMediaBytes is missing or invalid" });
  }
  const registrationOwners = owners !== undefined ? owners : (policy && policy.owners);
  const allowResult = validateAllowlistEntries(normalizeAllowlist(allowlist), registrationOwners);
  const allow = allowResult.valid;
  findings.push(...allowResult.findings);

  for (const blob of blobs) {
    const official = OFFICIAL_THEME_ASSET_RULES.find((entry) => blob.path.startsWith(entry.prefix));
    if (official) {
      findings.push({
        level: "error",
        rule: official.rule,
        path: blob.path,
        oid: blob.oid,
        message: `${official.prefix}** must never appear in PR-reachable history`,
      });
      continue;
    }
    const extension = path.posix.extname(blob.path).toLowerCase();
    if (!BINARY_MEDIA_EXTENSIONS.has(extension)) continue;
    if (!(blob.bytes > threshold)) continue;
    const match = findAllowlistMatch(blob, allow);
    if (match) continue;
    const samePath = allow.find((entry) => entry.path === blob.path);
    findings.push({
      level: "error",
      rule: "large-binary-in-pr-history",
      path: blob.path,
      oid: blob.oid,
      message: samePath
        ? `large binary (${blob.bytes} bytes) does not match the allowlisted oid/bytes (${samePath.oid}/${samePath.bytes})`
        : `large binary media (${blob.bytes} bytes) entered PR history without an exact allowlist entry`,
    });
  }

  return {
    schemaVersion: 1,
    range: null,
    findingCount: findings.length,
    findings: findings.sort((a, b) => (
      String(a.rule).localeCompare(String(b.rule)) || String(a.path).localeCompare(String(b.path))
    )),
  };
}

function parseArgs(argv) {
  const args = {
    base: process.env[BASE_SHA_ENV] || null,
    head: process.env[HEAD_SHA_ENV] || DEFAULT_HEAD,
    output: null,
    policy: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--base") args.base = argv[++i];
    else if (value === "--head") args.head = argv[++i];
    else if (value === "--output") args.output = argv[++i];
    else if (value === "--policy") args.policy = argv[++i];
    else if (value === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function loadPolicy(repoRoot, policyPath) {
  return JSON.parse(fs.readFileSync(
    policyPath || path.join(repoRoot, "tools", "repository-asset-policy.json"),
    "utf8",
  ));
}

function runAudit(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, ".."));
  const baseSha = validateBaseSha(options.base);
  const headRef = validateHeadRef(options.head || DEFAULT_HEAD);
  const resolvedHead = revParse(repoRoot, headRef);
  const rangeBase = resolveMergeBase(repoRoot, baseSha, resolvedHead);
  const introduced = collectIntroducedBlobs(repoRoot, rangeBase, resolvedHead);
  const objectMeta = readObjectMetadata(repoRoot, introduced.map((entry) => entry.oid));
  const baseTree = readBaseTreeEntries(repoRoot, rangeBase);
  const blobs = [];
  const seen = new Set();
  for (const entry of introduced) {
    const info = objectMeta.get(entry.oid);
    if (!info || info.type !== "blob") continue;
    const key = `${entry.oid}\0${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // An exact path+OID already present in the base is not newly introduced
    // (e.g. a merge pulling a base asset into the branch).
    if (baseTree.has(key)) continue;
    blobs.push({ oid: entry.oid, path: entry.path, bytes: info.bytes });
  }
  const policy = options.policy || loadPolicy(repoRoot, options.policyPath);
  const allowlist = Array.isArray(options.allowlist)
    ? options.allowlist
    : (Array.isArray(policy.prHistoryAssetAllowlist) ? policy.prHistoryAssetAllowlist : []);
  const report = analyzePrHistoryAssets({ blobs, allowlist, policy });
  report.range = { base: rangeBase, head: resolvedHead, eventBase: baseSha };
  return report;
}

function printSummary(report) {
  process.stdout.write([
    `PR history asset audit ${report.range ? `${report.range.base}..${report.range.head}` : ""}`,
    `Findings: ${report.findings.length}`,
    ...report.findings.map((finding) => `ERROR ${finding.rule} ${finding.path || ""}: ${finding.message}`),
    "",
  ].join("\n"));
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(
        "Usage: node scripts/audit-pr-history-assets.js --base <40-hex-sha> [--head <40-hex-sha>] [--output FILE]\n"
        + "       (or set PR_BASE_SHA and PR_HEAD_SHA)\n",
      );
      process.exit(0);
    }
    const report = runAudit(args);
    printSummary(report);
    if (args.output) {
      fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
      fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    process.exit(report.findings.some((finding) => finding.level === "error") ? 1 : 0);
  } catch (error) {
    process.stderr.write(`PR history asset audit failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  BASE_SHA_ENV,
  HEAD_SHA_ENV,
  HASH_SAGE_ASSET_PREFIX,
  WHALE_CHAN_ASSET_PREFIX,
  analyzePrHistoryAssets,
  collectBlobs,
  collectIntroducedBlobs,
  loadPolicy,
  normalizePath,
  parseArgs,
  parseDiffTreeRaw,
  parseRevListObjects,
  readBaseTreeEntries,
  readObjectMetadata,
  readRangeObjects,
  resolveMergeBase,
  runAudit,
  validateAllowlistEntries,
  validateBaseSha,
  validateHeadRef,
};
