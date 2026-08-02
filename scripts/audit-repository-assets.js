#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const MIB = 1024 * 1024;
const KNOWN_TARGETS = new Set([
  "windows-x64",
  "windows-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
]);
const BINARY_MEDIA_EXTENSIONS = new Set([
  ".apng", ".avi", ".dll", ".dylib", ".exe", ".gif", ".ico", ".jpeg",
  ".jpg", ".m4v", ".mkv", ".mov", ".mp3", ".mp4", ".node", ".png",
  ".so", ".svg", ".webm", ".webp",
]);
const FAT_MACHO_MAGICS = new Map([
  [0xcafebabe, { endian: "be", recordBytes: 20 }],
  [0xbebafeca, { endian: "le", recordBytes: 20 }],
  [0xcafebabf, { endian: "be", recordBytes: 32 }],
  [0xbfbafeca, { endian: "le", recordBytes: 32 }],
]);
// CAFEBABE is also the Java class magic; its following version bytes decode as
// an implausibly large Mach-O slice count (Java class versions start at 45).
const MAX_FAT_MACHO_ARCHITECTURES = 8;

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function globToRegExp(glob) {
  if (typeof glob !== "string" || !glob.trim()) {
    throw new TypeError("glob must be a non-empty string");
  }
  const input = normalizePath(glob);
  if (input.startsWith("!")) {
    throw new Error(`unsupported glob negation: ${glob}`);
  }
  if (/[{}[\]]/.test(input)) {
    throw new Error(`unsupported glob brace or character-class syntax: ${glob}`);
  }
  if (/[?*+@!]\(/.test(input)) {
    throw new Error(`unsupported glob extglob syntax: ${glob}`);
  }
  let source = "^";
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === "*") {
      if (input[i + 1] === "*") {
        i += 1;
        if (input[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function matchesGlob(filePath, glob) {
  return globToRegExp(glob).test(normalizePath(filePath));
}

function matchesAnyGlob(filePath, globs) {
  return (globs || []).some((glob) => matchesGlob(filePath, glob));
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableSort(items, key = (value) => value) {
  return items.slice().sort((a, b) => compareText(key(a), key(b)));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatMiB(bytes) {
  return (Number(bytes || 0) / MIB).toFixed(2);
}

function parseTrackedTree(raw) {
  return String(raw || "")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(\d+)\s+blob\s+([0-9a-f]+)\s+(\d+)\t([\s\S]+)$/);
      if (!match) return null;
      const filePath = normalizePath(match[4]);
      return {
        path: filePath,
        mode: match[1],
        gitBlob: match[2],
        bytes: Number(match[3]),
        extension: path.posix.extname(filePath).toLowerCase() || "(none)",
        topLevel: filePath.includes("/") ? filePath.split("/")[0] : filePath,
      };
    })
    .filter(Boolean);
}

function readTrackedTree(repoRoot) {
  const raw = execFileSync("git", ["ls-tree", "-r", "-l", "-z", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * MIB,
  });
  return parseTrackedTree(raw);
}

function readRevision(repoRoot) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function walkFiles(root, options = {}) {
  const excluded = new Set(options.excludedDirectories || [
    ".git", ".worktrees", "dist", "node_modules",
  ]);
  const files = [];
  if (!fs.existsSync(root)) return files;

  function visit(current, relative) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const rel = normalizePath(relative ? `${relative}/${entry.name}` : entry.name);
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) visit(full, rel);
      } else if (entry.isFile()) {
        files.push({ path: rel, fullPath: full });
      }
    }
  }

  visit(root, "");
  return files;
}

function readPackageConfig(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).build || {};
}

function packageEntry(fullPath, sourcePath, packagePath, origin, asarUnpack) {
  const stat = fs.statSync(fullPath);
  return {
    sourcePath: normalizePath(sourcePath),
    packagePath: normalizePath(packagePath),
    origin,
    asarUnpack: !!asarUnpack,
    bytes: stat.size,
    sha256: sha256File(fullPath),
  };
}

function buildSourcePackageManifest(repoRoot, build, revision) {
  const buildFiles = stableSort(build.files || []);
  const unpackGlobs = stableSort(build.asarUnpack || []);
  for (const glob of [...buildFiles, ...unpackGlobs]) globToRegExp(glob);
  const allFiles = walkFiles(repoRoot);
  const appSources = new Map();

  for (const file of allFiles) {
    if (matchesAnyGlob(file.path, buildFiles)) appSources.set(file.path, file);
  }

  const implicitPackageJson = path.join(repoRoot, "package.json");
  if (fs.existsSync(implicitPackageJson) && !appSources.has("package.json")) {
    appSources.set("package.json", { path: "package.json", fullPath: implicitPackageJson });
  }

  const files = stableSort(Array.from(appSources.values()), (file) => file.path)
    .map((file) => packageEntry(
      file.fullPath,
      file.path,
      `app/${file.path}`,
      "build.files",
      matchesAnyGlob(file.path, unpackGlobs),
    ));

  const extraResources = (build.extraResources || []).map((entry) => ({
    from: normalizePath(entry && entry.from),
    to: normalizePath(entry && entry.to),
  }));

  for (const entry of extraResources) {
    if (!entry.from) continue;
    const from = path.join(repoRoot, ...entry.from.split("/"));
    if (!fs.existsSync(from)) continue;
    const stat = fs.statSync(from);
    if (stat.isFile()) {
      files.push(packageEntry(
        from,
        entry.from,
        `resources/${entry.to || path.posix.basename(entry.from)}`,
        "extraResources",
        false,
      ));
      continue;
    }
    for (const child of walkFiles(from, { excludedDirectories: [] })) {
      files.push(packageEntry(
        child.fullPath,
        `${entry.from}/${child.path}`,
        `resources/${entry.to}/${child.path}`,
        "extraResources",
        false,
      ));
    }
  }

  return {
    schemaVersion: 1,
    revision,
    scope: "repository-owned-package-inputs",
    target: null,
    buildFiles,
    asarUnpack: unpackGlobs,
    extraResources: stableSort(extraResources, (entry) => `${entry.from}\0${entry.to}`),
    files: stableSort(files, (file) => `${file.packagePath}\0${file.sourcePath}`),
  };
}

function buildExtractedPackageManifest(packageRoot, target, revision) {
  const files = walkFiles(packageRoot, { excludedDirectories: [] }).map((file) => (
    packageEntry(file.fullPath, file.path, file.path, "extracted-package", false)
  ));
  return {
    schemaVersion: 1,
    revision,
    scope: "extracted-package",
    target,
    buildFiles: [],
    asarUnpack: [],
    extraResources: [],
    files: stableSort(files, (file) => file.packagePath),
  };
}

function resolvePolicy(policy, filePath) {
  const normalized = normalizePath(filePath);
  const exact = (policy.entries || []).find((entry) => normalizePath(entry.path) === normalized);
  if (exact) return exact;
  // Prefer the narrowest matching rule so a broad rule cannot shadow a later
  // retention or ownership exception merely because the JSON was reordered.
  const matchingRules = (policy.pathRules || [])
    .filter((rule) => matchesGlob(normalized, rule.pattern))
    .map((rule) => {
      const pattern = normalizePath(rule.pattern);
      const wildcards = (pattern.match(/[*?]/g) || []).length;
      const firstWildcard = pattern.search(/[*?]/);
      return {
        rule,
        literalPrefixCharacters: firstWildcard === -1 ? pattern.length : firstWildcard,
        literalCharacters: pattern.replace(/[*?]/g, "").length,
        wildcards,
        pattern,
      };
    })
    .sort((a, b) => (
      b.literalPrefixCharacters - a.literalPrefixCharacters
      || b.literalCharacters - a.literalCharacters
      || a.wildcards - b.wildcards
      || b.pattern.length - a.pattern.length
      || compareText(a.pattern, b.pattern)
    ));
  return matchingRules.length ? matchingRules[0].rule : null;
}

function validatePolicy(policy) {
  const errors = [];
  if (!policy || policy.schemaVersion !== 1) {
    errors.push("policy schemaVersion must be 1");
    return errors;
  }
  const requiredPatterns = [
    "themes/**",
    "assets/gif/**",
    "assets/videos/**",
    "assets/source/**",
    "test/fixtures/**",
  ];
  for (const pattern of requiredPatterns) {
    if (!(policy.pathRules || []).some((rule) => rule.pattern === pattern)) {
      errors.push(`policy is missing required path rule ${pattern}`);
    }
  }
  const license = (policy.entries || []).find((entry) => entry.path === "assets/LICENSE");
  if (!license || license.owner !== "legal" || license.retention !== "permanent") {
    errors.push("assets/LICENSE must be owned by legal and retained permanently");
  }
  const owners = policy.owners || {};
  const classes = policy.classes || {};
  for (const item of [...(policy.pathRules || []), ...(policy.entries || [])]) {
    if (item.pattern) {
      try {
        globToRegExp(item.pattern);
      } catch (error) {
        errors.push(`${item.pattern} is invalid: ${error.message}`);
      }
    }
    if (!item.owner || item.owner === "unknown" || !owners[item.owner]) {
      errors.push(`${item.path || item.pattern || "(policy item)"} has an unknown owner`);
    }
    if (!item.class || !classes[item.class]) {
      errors.push(`${item.path || item.pattern || "(policy item)"} has an unknown class`);
    }
  }
  return errors;
}

function aggregateBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const name = key(item);
    const current = groups.get(name) || { name, files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += item.bytes;
    groups.set(name, current);
  }
  return Array.from(groups.values())
    .sort((a, b) => b.bytes - a.bytes || compareText(a.name, b.name));
}

function groupDuplicates(items, hashKey, pathKey) {
  const groups = new Map();
  for (const item of items) {
    const hash = hashKey(item);
    const group = groups.get(hash) || [];
    group.push(item);
    groups.set(hash, group);
  }
  return Array.from(groups.entries())
    .filter(([, group]) => group.length > 1)
    .map(([hash, group]) => ({
      hash,
      bytes: group[0].bytes,
      copies: group.length,
      paths: stableSort(group.map(pathKey)),
    }))
    .sort((a, b) => b.bytes - a.bytes || compareText(a.paths[0], b.paths[0]));
}

function readUInt32(buffer, offset, endian) {
  return endian === "be" ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset);
}

function darwinArchForCpuType(cpuType) {
  if (cpuType === 0x01000007) return "x64";
  if (cpuType === 0x0100000c) return "arm64";
  return `cpu-0x${cpuType.toString(16)}`;
}

function inspectNativeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) return null;

  if (buffer[0] === 0x4d && buffer[1] === 0x5a && buffer.length >= 0x40) {
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset + 6 <= buffer.length && buffer.toString("ascii", peOffset, peOffset + 4) === "PE\0\0") {
      const machine = buffer.readUInt16LE(peOffset + 4);
      if (machine === 0x8664) return { os: "windows", arch: "x64", format: "pe" };
      if (machine === 0xaa64) return { os: "windows", arch: "arm64", format: "pe" };
      return { os: "windows", arch: `machine-0x${machine.toString(16)}`, format: "pe" };
    }
  }

  if (buffer[0] === 0x7f && buffer.toString("ascii", 1, 4) === "ELF") {
    const endian = buffer[5] === 2 ? "be" : "le";
    const machine = endian === "be" ? buffer.readUInt16BE(18) : buffer.readUInt16LE(18);
    if (machine === 62) return { os: "linux", arch: "x64", format: "elf" };
    if (machine === 183) return { os: "linux", arch: "arm64", format: "elf" };
    return { os: "linux", arch: `machine-${machine}`, format: "elf" };
  }

  const magicBe = buffer.readUInt32BE(0);
  const fatMagic = FAT_MACHO_MAGICS.get(magicBe);
  if (fatMagic) {
    const count = readUInt32(buffer, 4, fatMagic.endian);
    const headerBytes = 8 + count * fatMagic.recordBytes;
    if (count === 0 || count > MAX_FAT_MACHO_ARCHITECTURES || headerBytes > buffer.length) {
      return null;
    }
    const architectures = stableSort(Array.from(new Set(
      Array.from({ length: count }, (_, index) => {
        const offset = 8 + index * fatMagic.recordBytes;
        return darwinArchForCpuType(readUInt32(buffer, offset, fatMagic.endian));
      }),
    )));
    return {
      os: "darwin",
      arch: architectures.length === 1 ? architectures[0] : "universal",
      architectures,
      format: "mach-o-fat",
    };
  }

  let endian = null;
  if (magicBe === 0xfeedfacf || magicBe === 0xfeedface) endian = "be";
  if (magicBe === 0xcffaedfe || magicBe === 0xcefaedfe) endian = "le";
  if (endian) {
    const cpuType = readUInt32(buffer, 4, endian);
    return { os: "darwin", arch: darwinArchForCpuType(cpuType), format: "mach-o" };
  }
  return null;
}

function inspectNativeFile(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return inspectNativeBuffer(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
}

function targetTaggedInPath(filePath) {
  const match = normalizePath(filePath).match(/(?:^|\/)(windows|darwin|linux)-(x64|arm64)(?:\/|$)/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function isNativeCandidate(file) {
  const basename = path.posix.basename(normalizePath(file.packagePath || file.sourcePath)).toLowerCase();
  return basename === "cc-connect-clawd"
    || basename === "cc-connect-clawd.exe"
    || [".dll", ".dylib", ".exe", ".node", ".so"].includes(path.posix.extname(basename));
}

function findForeignNativeFiles(manifest, repoRoot, packageRoot) {
  if (!manifest.target) return [];
  const foreign = [];
  for (const file of manifest.files) {
    const namedCandidate = isNativeCandidate(file);
    if (manifest.scope !== "extracted-package" && !namedCandidate) continue;
    let inspected = null;
    const relative = manifest.scope === "extracted-package" ? file.packagePath : file.sourcePath;
    const base = manifest.scope === "extracted-package" ? packageRoot : repoRoot;
    const fullPath = base && path.join(base, ...normalizePath(relative).split("/"));
    if (fullPath && fs.existsSync(fullPath)) inspected = inspectNativeFile(fullPath);
    if (!namedCandidate && !inspected) continue;
    const tagged = targetTaggedInPath(file.packagePath) || targetTaggedInPath(file.sourcePath);
    const inspectedArchitectures = inspected
      ? (inspected.architectures || [inspected.arch])
      : [];
    const inspectedTargets = inspectedArchitectures.map((arch) => `${inspected.os}-${arch}`);
    const detectedTargets = stableSort(Array.from(new Set([tagged, ...inspectedTargets].filter(Boolean))));
    if (detectedTargets.some((detected) => detected !== manifest.target)) {
      foreign.push({
        packagePath: file.packagePath,
        detectedTargets,
        expectedTarget: manifest.target,
      });
    }
  }
  return stableSort(foreign, (item) => item.packagePath);
}

function duplicateIsExempt(duplicate, manifest, policy) {
  const sourceByPackagePath = new Map(manifest.files.map((file) => [file.packagePath, file.sourcePath]));
  const sources = duplicate.paths.map((packagePath) => sourceByPackagePath.get(packagePath) || packagePath);
  return (policy.duplicatePayloadExemptions || []).some((entry) => {
    const expected = stableSort((entry.paths || []).map(normalizePath));
    return JSON.stringify(expected) === JSON.stringify(stableSort(sources));
  });
}

function analyzeAudit({
  trackedFiles,
  manifest,
  policy,
  repoRoot,
  packageRoot,
  baselinePackageBytes = null,
}) {
  const findings = [];
  const thresholds = policy.thresholds || {};
  const trackedBytes = trackedFiles.reduce((sum, file) => sum + file.bytes, 0);
  const packageBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);

  for (const message of validatePolicy(policy)) {
    findings.push({ level: "error", rule: "asset-policy-valid", message });
  }

  if (!trackedFiles.some((file) => file.path === "assets/LICENSE")) {
    findings.push({
      level: "error",
      rule: "assets-license-retained",
      path: "assets/LICENSE",
      message: "assets/LICENSE must remain tracked permanently.",
    });
  }

  if (trackedBytes > Number(thresholds.trackedTreeHardBytes || Infinity)) {
    findings.push({
      level: "error",
      rule: "tracked-tree-hard-budget",
      message: `Tracked tree ${trackedBytes} bytes exceeds hard budget ${thresholds.trackedTreeHardBytes} bytes.`,
    });
  } else if (trackedBytes > Number(thresholds.trackedTreeWarningBytes || Infinity)) {
    findings.push({
      level: "warning",
      rule: "tracked-tree-warning-budget",
      message: `Tracked tree ${trackedBytes} bytes exceeds warning budget ${thresholds.trackedTreeWarningBytes} bytes.`,
    });
  }

  for (const file of trackedFiles) {
    const largeMedia = file.bytes > Number(thresholds.largeTrackedBinaryMediaBytes || Infinity)
      && BINARY_MEDIA_EXTENSIONS.has(file.extension);
    if (largeMedia) {
      const resolved = resolvePolicy(policy, file.path);
      if (!resolved || !resolved.owner || resolved.owner === "unknown" || !policy.owners[resolved.owner]) {
        findings.push({
          level: "error",
          rule: "large-tracked-file-owned",
          path: file.path,
          message: `Large tracked binary/media file (${file.bytes} bytes) has no known policy owner.`,
        });
      }
    }
    if (file.path.startsWith("bin/cc-connect-clawd/")
      && /(?:^|\/)cc-connect-clawd(?:\.exe)?$/i.test(file.path)) {
      findings.push({
        level: "error",
        rule: "sidecar-executable-untracked",
        path: file.path,
        message: "Retired Telegram sidecar executables must never be tracked.",
      });
    }
  }

  const packagedSources = new Set(manifest.files.map((file) => normalizePath(file.sourcePath)));
  for (const file of manifest.files) {
    const source = normalizePath(file.sourcePath);
    const packaged = normalizePath(file.packagePath);
    if (source.startsWith("assets/source/") || packaged.includes("/assets/source/") || packaged.startsWith("assets/source/")) {
      findings.push({
        level: "error",
        rule: "source-assets-not-packaged",
        path: file.packagePath,
        message: "assets/source/** must never be matched by package inputs.",
      });
    }
    const resolved = resolvePolicy(policy, source);
    if (resolved && resolved.packaged === false) {
      findings.push({
        level: "error",
        rule: "policy-excluded-file-not-packaged",
        path: file.packagePath,
        message: `${source} is marked packaged=false by asset policy.`,
      });
    }
  }

  if (manifest.scope === "repository-owned-package-inputs") {
    for (const file of trackedFiles) {
      const resolved = resolvePolicy(policy, file.path);
      if (resolved && resolved.packaged === true && !packagedSources.has(file.path)) {
        findings.push({
          level: "error",
          rule: "policy-required-file-packaged",
          path: file.path,
          message: `${file.path} is marked packaged=true but is absent from the package manifest.`,
        });
      }
    }
  }

  const foreignNative = findForeignNativeFiles(manifest, repoRoot, packageRoot);
  for (const foreign of foreignNative) {
    findings.push({
      level: "error",
      rule: "foreign-target-native",
      path: foreign.packagePath,
      message: `Expected ${foreign.expectedTarget}; detected ${foreign.detectedTargets.join(", ")}.`,
    });
  }

  const packagedDuplicates = groupDuplicates(
    manifest.files,
    (file) => file.sha256,
    (file) => file.packagePath,
  ).map((duplicate) => ({
    ...duplicate,
    exempt: duplicateIsExempt(duplicate, manifest, policy),
  }));
  for (const duplicate of packagedDuplicates) {
    if (duplicate.bytes > Number(thresholds.duplicatePackagedPayloadWarningBytes || Infinity)
      && !duplicate.exempt) {
      findings.push({
        level: "warning",
        rule: "duplicate-packaged-payload",
        paths: duplicate.paths,
        message: `${duplicate.copies} packaged copies share ${duplicate.bytes} identical bytes.`,
      });
    }
  }

  let growth = null;
  if (Number.isFinite(baselinePackageBytes) && baselinePackageBytes >= 0) {
    const addedBytes = packageBytes - baselinePackageBytes;
    const addedRatio = baselinePackageBytes > 0 ? addedBytes / baselinePackageBytes : null;
    growth = {
      baselineBytes: baselinePackageBytes,
      currentBytes: packageBytes,
      addedBytes,
      addedRatio,
    };
    if (addedBytes > Number(thresholds.artifactGrowthWarningBytes || Infinity)
      || (addedRatio !== null && addedRatio > Number(thresholds.artifactGrowthWarningRatio || Infinity))) {
      findings.push({
        level: "warning",
        rule: "package-growth-budget",
        message: `Package manifest grew by ${addedBytes} bytes`
          + `${addedRatio === null ? "" : ` (${(addedRatio * 100).toFixed(2)}%)`}.`,
      });
    }
  }

  const sortedFindings = findings.sort((a, b) => (
    compareText(a.level, b.level)
    || compareText(a.rule, b.rule)
    || compareText(
      a.path || (a.paths || []).join("\0"),
      b.path || (b.paths || []).join("\0"),
    )
  ));

  return {
    schemaVersion: 1,
    revision: manifest.revision,
    tracked: {
      files: trackedFiles.length,
      bytes: trackedBytes,
      byTopLevel: aggregateBy(trackedFiles, (file) => file.topLevel),
      byExtension: aggregateBy(trackedFiles, (file) => file.extension),
      largestFiles: trackedFiles.slice()
        .sort((a, b) => b.bytes - a.bytes || compareText(a.path, b.path))
        .slice(0, 50)
        .map(({ path: filePath, bytes, gitBlob }) => ({ path: filePath, bytes, gitBlob })),
      duplicateBlobs: groupDuplicates(
        trackedFiles,
        (file) => file.gitBlob,
        (file) => file.path,
      ),
    },
    package: {
      scope: manifest.scope,
      target: manifest.target,
      files: manifest.files.length,
      bytes: packageBytes,
      duplicatePayloads: packagedDuplicates,
      foreignNativeFiles: foreignNative,
      growth,
    },
    findings: sortedFindings,
  };
}

function parseArgs(argv) {
  const args = {
    output: "dist/repository-asset-audit",
    packageRoot: null,
    target: null,
    baselineManifest: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--output") args.output = argv[++i];
    else if (value === "--package-root") args.packageRoot = argv[++i];
    else if (value === "--target") args.target = argv[++i];
    else if (value === "--baseline-manifest") args.baselineManifest = argv[++i];
    else if (value === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (args.packageRoot && !args.target) {
    throw new Error("--package-root requires --target");
  }
  if (args.target && !KNOWN_TARGETS.has(args.target)) {
    throw new Error(`Unsupported target ${args.target}; expected one of ${Array.from(KNOWN_TARGETS).join(", ")}`);
  }
  return args;
}

function runAudit(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, ".."));
  const policyPath = path.resolve(options.policyPath || path.join(repoRoot, "tools", "repository-asset-policy.json"));
  const outputDir = path.resolve(repoRoot, options.output || "dist/repository-asset-audit");
  const packageRoot = options.packageRoot ? path.resolve(repoRoot, options.packageRoot) : null;
  const revision = options.revision || readRevision(repoRoot);
  const trackedFiles = options.trackedFiles || readTrackedTree(repoRoot);
  const policy = options.policy || JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const build = options.build || readPackageConfig(repoRoot);
  const manifest = options.manifest || (packageRoot
    ? buildExtractedPackageManifest(packageRoot, options.target, revision)
    : buildSourcePackageManifest(repoRoot, build, revision));
  if (options.target && !manifest.target) manifest.target = options.target;
  let baselinePackageBytes = options.baselinePackageBytes;
  if (baselinePackageBytes === undefined && options.baselineManifest) {
    const baselinePath = path.resolve(repoRoot, options.baselineManifest);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    baselinePackageBytes = baseline.package && Number.isFinite(baseline.package.bytes)
      ? baseline.package.bytes
      : (baseline.files || []).reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  }
  const report = analyzeAudit({
    trackedFiles,
    manifest,
    policy,
    repoRoot,
    packageRoot,
    baselinePackageBytes,
  });

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "package-manifest.json"), stableJson(manifest), "utf8");
  fs.writeFileSync(path.join(outputDir, "tracked-large-files.json"), stableJson({
    schemaVersion: 1,
    revision,
    files: report.tracked.largestFiles,
  }), "utf8");
  fs.writeFileSync(path.join(outputDir, "audit-report.json"), stableJson(report), "utf8");

  return { report, manifest, outputDir };
}

function printSummary(report) {
  const warnings = report.findings.filter((finding) => finding.level === "warning");
  const errors = report.findings.filter((finding) => finding.level === "error");
  process.stdout.write([
    `Repository asset audit @ ${report.revision}`,
    `Tracked: ${report.tracked.files} files, ${report.tracked.bytes} bytes (${formatMiB(report.tracked.bytes)} MiB)`,
    `Package manifest (${report.package.scope}): ${report.package.files} files, ${report.package.bytes} bytes (${formatMiB(report.package.bytes)} MiB)`,
    `Findings: ${errors.length} error(s), ${warnings.length} warning(s)`,
    ...report.findings.map((finding) => {
      const location = finding.path || (finding.paths || []).join(", ");
      return `${finding.level.toUpperCase()} ${finding.rule}`
        + `${location ? ` ${location}` : ""}: ${finding.message}`;
    }),
    "",
  ].join("\n"));
}

function printHelp() {
  process.stdout.write(
    "Usage: node scripts/audit-repository-assets.js [--output DIR] "
    + "[--baseline-manifest PREVIOUS_JSON] "
    + "[--package-root EXTRACTED_DIR --target windows-x64|windows-arm64|darwin-x64|darwin-arm64|linux-x64]\n",
  );
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      process.exit(0);
    }
    const { report, outputDir } = runAudit(args);
    printSummary(report);
    process.stdout.write(`Reports: ${normalizePath(path.relative(path.join(__dirname, ".."), outputDir))}\n`);
    process.exit(report.findings.some((finding) => finding.level === "error") ? 1 : 0);
  } catch (error) {
    process.stderr.write(`Repository asset audit failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  analyzeAudit,
  buildExtractedPackageManifest,
  buildSourcePackageManifest,
  findForeignNativeFiles,
  globToRegExp,
  inspectNativeBuffer,
  matchesGlob,
  parseArgs,
  parseTrackedTree,
  resolvePolicy,
  runAudit,
  stableJson,
  validatePolicy,
};
