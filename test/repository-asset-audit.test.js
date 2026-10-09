"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  analyzeAudit,
  buildExtractedPackageManifest,
  buildSourcePackageManifest,
  inspectNativeBuffer,
  matchesGlob,
  parseArgs,
  parseBatchObjectSizes,
  parseIndexRecords,
  readProspectiveTrackedTree,
  readTrackedTree,
  resolvePolicy,
  runAudit,
  stableJson,
  validatePolicy,
} = require("../scripts/audit-repository-assets");

// Isolate a temporary-repo fixture from ambient git state: global/system config,
// signing, hooks, excludes, and any inherited git path variables. The product
// prospective helper itself is unchanged; this only scrubs the environment it
// runs under, then restores it.
const GIT_ISOLATION_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CEILING_DIRECTORIES",
  "GIT_ATTR_NOSYSTEM",
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
];

function withIsolatedGitEnv(homeDir, fn) {
  const saved = new Map();
  for (const key of GIT_ISOLATION_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = nullDevice;
  process.env.GIT_CONFIG_SYSTEM = nullDevice;
  try {
    return fn();
  } finally {
    for (const key of GIT_ISOLATION_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function basePolicy() {
  return {
    schemaVersion: 1,
    owners: {
      build: "build",
      design: "design",
      docs: "docs",
      legal: "legal",
      tests: "tests",
      themes: "themes",
    },
    classes: {
      "runtime-required": "runtime",
      "source-of-truth": "source",
      "docs-marketing": "docs",
      "tests-fixtures": "tests",
      "legal": "legal",
    },
    thresholds: {
      trackedTreeWarningBytes: 100,
      trackedTreeHardBytes: 200,
      largeTrackedBinaryMediaBytes: 10,
      duplicatePackagedPayloadWarningBytes: 4,
    },
    pathRules: [
      { pattern: "themes/**", class: "runtime-required", owner: "themes", packaged: true },
      { pattern: "assets/gif/**", class: "docs-marketing", owner: "docs", packaged: false },
      { pattern: "assets/videos/**", class: "docs-marketing", owner: "docs", packaged: false },
      { pattern: "assets/source/**", class: "source-of-truth", owner: "design", packaged: false },
      { pattern: "test/fixtures/**", class: "tests-fixtures", owner: "tests", packaged: false },
    ],
    entries: [
      {
        path: "assets/LICENSE",
        class: "legal",
        owner: "legal",
        packaged: false,
        retention: "permanent",
      },
    ],
    duplicatePayloadExemptions: [],
  };
}

function tracked(filePath, bytes, gitBlob = filePath) {
  return {
    path: filePath,
    bytes,
    gitBlob,
    extension: path.posix.extname(filePath) || "(none)",
    topLevel: filePath.split("/")[0],
  };
}

function manifest(files, target = null) {
  return {
    schemaVersion: 1,
    revision: "deadbeef",
    scope: "repository-owned-package-inputs",
    target,
    buildFiles: [],
    asarUnpack: [],
    extraResources: [],
    files,
  };
}

function fatMachoBuffer({ magic, endian, recordBytes }) {
  const architectures = [0x01000007, 0x0100000c];
  const buffer = Buffer.alloc(8 + architectures.length * recordBytes);
  buffer.writeUInt32BE(magic, 0);
  const writeUInt32 = endian === "be"
    ? buffer.writeUInt32BE.bind(buffer)
    : buffer.writeUInt32LE.bind(buffer);
  writeUInt32(architectures.length, 4);
  architectures.forEach((cpuType, index) => {
    writeUInt32(cpuType, 8 + index * recordBytes);
  });
  return buffer;
}

describe("repository asset audit", () => {
  it("matches recursive package and policy globs consistently", () => {
    assert.strictEqual(matchesGlob("themes/calico/theme.json", "themes/**"), true);
    assert.strictEqual(matchesGlob("assets/icons/a.png", "assets/icons/**/*"), true);
    assert.strictEqual(matchesGlob("assets/source/a.png", "assets/icons/**/*"), false);
  });

  it("fails closed on glob syntax the audit engine does not implement", () => {
    assert.throws(
      () => matchesGlob("src/x.map", "!**/*.map"),
      /unsupported glob negation/,
    );
    assert.throws(
      () => matchesGlob("a.png", "*.{png,gif}"),
      /unsupported glob brace/,
    );
    assert.throws(
      () => matchesGlob("a.png", "*.[pj]ng"),
      /unsupported glob brace or character-class/,
    );
    assert.throws(
      () => matchesGlob("a.png", "+(a|b).png"),
      /unsupported glob extglob/,
    );
    assert.throws(
      () => matchesGlob("foo.png", "foo?(x).png"),
      /unsupported glob extglob/,
    );
  });

  it("requires all policy categories and permanent assets/LICENSE retention", () => {
    assert.deepStrictEqual(validatePolicy(basePolicy()), []);
    const broken = basePolicy();
    broken.entries = [];
    assert.ok(validatePolicy(broken).some((message) => message.includes("assets/LICENSE")));

    const unsupportedGlob = basePolicy();
    unsupportedGlob.pathRules.push({
      pattern: "assets/{raw,source}/**",
      class: "source-of-truth",
      owner: "design",
      packaged: false,
    });
    assert.ok(validatePolicy(unsupportedGlob).some((message) => (
      message.includes("unsupported glob brace")
    )));
  });

  it("resolves the most specific policy rule regardless of declaration order", () => {
    const policy = basePolicy();
    policy.pathRules.unshift({
      pattern: "assets/**",
      class: "docs-marketing",
      owner: "docs",
      packaged: false,
    });
    assert.strictEqual(resolvePolicy(policy, "assets/source/raw.png").owner, "design");
  });

  it("hard-fails when assets/LICENSE is absent from the tracked tree", () => {
    const report = analyzeAudit({
      trackedFiles: [],
      manifest: manifest([]),
      policy: basePolicy(),
    });
    const finding = report.findings.find((item) => item.rule === "assets-license-retained");
    assert.strictEqual(finding.level, "error");
  });

  it("hard-fails the tracked-tree hard budget instead of emitting only a warning", () => {
    const report = analyzeAudit({
      trackedFiles: [tracked("assets/LICENSE", 201)],
      manifest: manifest([]),
      policy: basePolicy(),
    });
    assert.ok(report.findings.some((finding) => (
      finding.level === "error" && finding.rule === "tracked-tree-hard-budget"
    )));
    assert.ok(!report.findings.some((finding) => finding.rule === "tracked-tree-warning-budget"));
  });

  it("hard-fails assets/source package matches and ownerless large media", () => {
    const policy = basePolicy();
    const trackedFiles = [
      tracked("assets/LICENSE", 5),
      tracked("assets/unowned.mp4", 20),
      tracked("assets/source/raw.png", 20),
    ];
    const report = analyzeAudit({
      trackedFiles,
      manifest: manifest([{
        sourcePath: "assets/source/raw.png",
        packagePath: "app/assets/source/raw.png",
        origin: "build.files",
        asarUnpack: false,
        bytes: 20,
        sha256: "one",
      }]),
      policy,
    });
    const rules = report.findings.filter((finding) => finding.level === "error").map((finding) => finding.rule);
    assert.ok(rules.includes("source-assets-not-packaged"));
    assert.ok(rules.includes("policy-excluded-file-not-packaged"));
    assert.ok(rules.includes("large-tracked-file-owned"));
  });

  it("hard-fails when a packaged=true policy category is missing from source inputs", () => {
    const report = analyzeAudit({
      trackedFiles: [
        tracked("assets/LICENSE", 5),
        tracked("themes/clawd/theme.json", 5),
      ],
      manifest: manifest([]),
      policy: basePolicy(),
    });
    const missing = report.findings.find((finding) => finding.rule === "policy-required-file-packaged");
    assert.strictEqual(missing.level, "error");
    assert.strictEqual(missing.path, "themes/clawd/theme.json");
  });

  it("hard-fails a tracked cc-connect-clawd executable", () => {
    const report = analyzeAudit({
      trackedFiles: [
        tracked("assets/LICENSE", 5),
        tracked("bin/cc-connect-clawd/windows-x64/cc-connect-clawd.exe", 5),
      ],
      manifest: manifest([]),
      policy: basePolicy(),
    });
    const executable = report.findings.find((finding) => finding.rule === "sidecar-executable-untracked");
    assert.strictEqual(executable.level, "error");
  });

  it("reports duplicate packaged payloads as warnings and budgets independently", () => {
    const policy = basePolicy();
    const report = analyzeAudit({
      trackedFiles: [tracked("assets/LICENSE", 5)],
      manifest: manifest([
        { sourcePath: "a.bin", packagePath: "app/a.bin", bytes: 8, sha256: "same" },
        { sourcePath: "b.bin", packagePath: "resources/b.bin", bytes: 8, sha256: "same" },
      ]),
      policy,
    });
    assert.ok(report.findings.some((finding) => (
      finding.level === "warning" && finding.rule === "duplicate-packaged-payload"
    )));
  });

  it("warns on package growth without turning the initial budget into a hard failure", () => {
    const policy = basePolicy();
    policy.thresholds.artifactGrowthWarningBytes = 5;
    policy.thresholds.artifactGrowthWarningRatio = 0.05;
    const report = analyzeAudit({
      trackedFiles: [tracked("assets/LICENSE", 5)],
      manifest: manifest([
        { sourcePath: "a.bin", packagePath: "app/a.bin", bytes: 20, sha256: "one" },
      ]),
      policy,
      baselinePackageBytes: 10,
    });
    const growth = report.findings.find((finding) => finding.rule === "package-growth-budget");
    assert.strictEqual(growth.level, "warning");
    assert.deepStrictEqual(report.package.growth, {
      baselineBytes: 10,
      currentBytes: 20,
      addedBytes: 10,
      addedRatio: 1,
    });
  });

  it("parses PE, ELF, thin Mach-O, and fat Mach-O architecture headers", () => {
    const pe = Buffer.alloc(128);
    pe.write("MZ", 0, "ascii");
    pe.writeUInt32LE(64, 0x3c);
    pe.write("PE\0\0", 64, "ascii");
    pe.writeUInt16LE(0xaa64, 68);
    assert.deepStrictEqual(inspectNativeBuffer(pe), { os: "windows", arch: "arm64", format: "pe" });

    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    elf.writeUInt16LE(62, 18);
    assert.deepStrictEqual(inspectNativeBuffer(elf), { os: "linux", arch: "x64", format: "elf" });

    const macho = Buffer.alloc(32);
    macho.writeUInt32BE(0xfeedfacf, 0);
    macho.writeUInt32BE(0x0100000c, 4);
    assert.deepStrictEqual(inspectNativeBuffer(macho), { os: "darwin", arch: "arm64", format: "mach-o" });

    for (const fat of [
      { magic: 0xcafebabe, endian: "be", recordBytes: 20 },
      { magic: 0xbebafeca, endian: "le", recordBytes: 20 },
      { magic: 0xcafebabf, endian: "be", recordBytes: 32 },
      { magic: 0xbfbafeca, endian: "le", recordBytes: 32 },
    ]) {
      assert.deepStrictEqual(inspectNativeBuffer(fatMachoBuffer(fat)), {
        os: "darwin",
        arch: "universal",
        architectures: ["arm64", "x64"],
        format: "mach-o-fat",
      });
    }
  });

  it("does not mistake a Java class header for a fat Mach-O", () => {
    const javaClass = Buffer.alloc(8 + 61 * 20);
    javaClass.writeUInt32BE(0xcafebabe, 0);
    javaClass.writeUInt16BE(0, 4);
    javaClass.writeUInt16BE(61, 6);
    assert.strictEqual(inspectNativeBuffer(javaClass), null);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-audit-java-class-"));
    try {
      fs.writeFileSync(path.join(root, "Example.class"), javaClass);
      const extracted = buildExtractedPackageManifest(root, "windows-x64", "abc");
      const report = analyzeAudit({
        trackedFiles: [tracked("assets/LICENSE", 5)],
        manifest: extracted,
        policy: basePolicy(),
        packageRoot: root,
      });
      assert.deepStrictEqual(report.package.foreignNativeFiles, []);
      assert.ok(!report.findings.some((finding) => finding.rule === "foreign-target-native"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("hard-fails a foreign-target native binary in an extracted package", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-audit-foreign-"));
    try {
      const relative = path.join(
        "resources",
        "sidecars",
        "cc-connect-clawd",
        "windows-arm64",
        "cc-connect-clawd.exe",
      );
      const executable = path.join(root, relative);
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      const pe = Buffer.alloc(128);
      pe.write("MZ", 0, "ascii");
      pe.writeUInt32LE(64, 0x3c);
      pe.write("PE\0\0", 64, "ascii");
      pe.writeUInt16LE(0xaa64, 68);
      fs.writeFileSync(executable, pe);

      const extracted = buildExtractedPackageManifest(root, "windows-x64", "abc");
      const report = analyzeAudit({
        trackedFiles: [tracked("assets/LICENSE", 5)],
        manifest: extracted,
        policy: basePolicy(),
        packageRoot: root,
      });
      const foreign = report.findings.find((finding) => finding.rule === "foreign-target-native");
      assert.strictEqual(foreign.level, "error");
      assert.match(foreign.path, /windows-arm64/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sniffs extensionless native binaries in extracted packages", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-audit-extensionless-"));
    try {
      const executable = path.join(root, "Electron Framework");
      const macho = Buffer.alloc(32);
      macho.writeUInt32BE(0xfeedfacf, 0);
      macho.writeUInt32BE(0x0100000c, 4);
      fs.writeFileSync(executable, macho);

      const extracted = buildExtractedPackageManifest(root, "windows-x64", "abc");
      const report = analyzeAudit({
        trackedFiles: [tracked("assets/LICENSE", 5)],
        manifest: extracted,
        policy: basePolicy(),
        packageRoot: root,
      });
      const foreign = report.findings.find((finding) => finding.rule === "foreign-target-native");
      assert.strictEqual(foreign.level, "error");
      assert.deepStrictEqual(report.package.foreignNativeFiles, [{
        packagePath: "Electron Framework",
        detectedTargets: ["darwin-arm64"],
        expectedTarget: "windows-x64",
      }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("hard-fails a foreign architecture inside an extensionless fat Mach-O", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-audit-fat-macho-"));
    try {
      const executable = path.join(root, "Clawd");
      const fatMacho = fatMachoBuffer({
        magic: 0xcafebabe,
        endian: "be",
        recordBytes: 20,
      });
      fs.writeFileSync(executable, fatMacho);

      const extracted = buildExtractedPackageManifest(root, "darwin-x64", "abc");
      const report = analyzeAudit({
        trackedFiles: [tracked("assets/LICENSE", 5)],
        manifest: extracted,
        policy: basePolicy(),
        packageRoot: root,
      });
      assert.deepStrictEqual(report.package.foreignNativeFiles, [{
        packagePath: "Clawd",
        detectedTargets: ["darwin-arm64", "darwin-x64"],
        expectedTarget: "darwin-x64",
      }]);
      assert.ok(report.findings.some((finding) => (
        finding.level === "error" && finding.rule === "foreign-target-native"
      )));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds a deterministic source package manifest including extraResources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-audit-manifest-"));
    try {
      fs.mkdirSync(path.join(root, "assets", "source"), { recursive: true });
      fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
      fs.writeFileSync(path.join(root, "package.json"), "{}");
      fs.writeFileSync(path.join(root, "runtime", "a.txt"), "same");
      fs.writeFileSync(path.join(root, "assets", "source", "raw.txt"), "raw");
      const build = {
        files: ["runtime/**/*"],
        asarUnpack: ["runtime/**/*"],
        extraResources: [{ from: "runtime", to: "runtime-copy" }],
      };
      const first = buildSourcePackageManifest(root, build, "abc");
      const second = buildSourcePackageManifest(root, build, "abc");
      assert.strictEqual(stableJson(first), stableJson(second));
      assert.deepStrictEqual(
        first.files.map((file) => file.packagePath),
        ["app/package.json", "app/runtime/a.txt", "resources/runtime-copy/a.txt"],
      );
      assert.strictEqual(first.files[1].asarUnpack, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates build globs eagerly even when the repository has no files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-audit-glob-"));
    try {
      assert.throws(
        () => buildSourcePackageManifest(root, { files: ["!**/*.map"] }, "abc"),
        /unsupported glob negation/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit target when auditing an extracted package", () => {
    assert.throws(
      () => parseArgs(["--package-root", "dist/unpacked"]),
      /--package-root requires --target/,
    );
  });

  it("fails closed when the policy file is malformed JSON", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-audit-policy-"));
    try {
      const policyPath = path.join(root, "policy.json");
      fs.writeFileSync(policyPath, "{ invalid", "utf8");
      assert.throws(
        () => runAudit({
          repoRoot: root,
          output: path.join(root, "output"),
          policyPath,
          revision: "abc",
          trackedFiles: [],
          build: {},
          manifest: manifest([]),
        }),
        /JSON/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps serialized audit output byte-for-byte stable", () => {
    const value = { revision: "abc", files: [{ path: "a", bytes: 1 }] };
    assert.strictEqual(stableJson(value), stableJson(value));
    assert.ok(stableJson(value).endsWith("\n"));
  });

  it("keeps the prospective repository tree under the hard budget", () => {
    const root = path.resolve(__dirname, "..");
    const policy = JSON.parse(
      fs.readFileSync(path.join(root, "tools", "repository-asset-policy.json"), "utf8")
    );
    const prospective = readProspectiveTrackedTree(root);

    const prospectiveBytes = prospective.reduce((sum, file) => sum + file.bytes, 0);
    const headroom = policy.thresholds.trackedTreeHardBytes - prospectiveBytes;
    // The hard-budget gate must judge the tree that would actually be committed.
    assert.ok(
      headroom >= 0,
      `prospective tracked tree ${prospectiveBytes} bytes exceeds hard budget `
      + `${policy.thresholds.trackedTreeHardBytes} bytes by ${-headroom}`
    );
  });

  it("audits the prospective tree without a hard-budget error", () => {
    const root = path.resolve(__dirname, "..");
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "asset-audit-prospective-"));
    try {
      const { report } = runAudit({ repoRoot: root, output, prospective: true });
      assert.strictEqual(report.prospective, true);
      assert.deepStrictEqual(
        report.findings.filter((finding) => finding.level === "error"),
        [],
      );
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  });

  it("rejects the successful-exit '<oid> missing' batch-check form", () => {
    assert.throws(
      () => parseBatchObjectSizes("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef missing\n", 1),
      /non-numeric/i
    );
  });

  it("rejects malformed, extra, or missing size lines instead of defaulting to zero", () => {
    assert.throws(() => parseBatchObjectSizes("12\n", 2));
    assert.throws(() => parseBatchObjectSizes("12\n34\n", 1));
    assert.throws(() => parseBatchObjectSizes("12\n\n", 2));
    assert.throws(() => parseBatchObjectSizes("", 1));
    assert.throws(() => parseBatchObjectSizes("12\n34", 1));
  });

  it("rejects unsafe, negative, and fractional sizes", () => {
    assert.throws(() => parseBatchObjectSizes(`${Number.MAX_SAFE_INTEGER + 1}\n`, 1));
    assert.throws(() => parseBatchObjectSizes("-1\n", 1));
    assert.throws(() => parseBatchObjectSizes("1.5\n", 1));
  });

  it("accepts exactly one non-negative safe integer per requested object", () => {
    assert.deepStrictEqual(parseBatchObjectSizes("0\n123\n", 2), [0, 123]);
    assert.deepStrictEqual(parseBatchObjectSizes("7", 1), [7]);
  });

  it("rejects a malformed ls-files record instead of dropping it", () => {
    assert.throws(() => parseIndexRecords("garbage\0"), /Unexpected git ls-files/);
    assert.throws(() => parseIndexRecords("100644 nothex 0\tpath\0"), /Unexpected git ls-files/);
    assert.throws(() => parseIndexRecords("100644 1111111111111111111111111111111111111111 0\t\0"), /Unexpected/);
  });

  it("parses well-formed NUL-delimited index records", () => {
    const raw = "100644 1111111111111111111111111111111111111111 0\ta.txt\0"
      + "100755 2222222222222222222222222222222222222222 0\tdir/b.txt\0";
    assert.deepStrictEqual(parseIndexRecords(raw).map((record) => record.path), ["a.txt", "dir/b.txt"]);
  });

  it("evaluates every working-tree change without dropping a tracked node_modules path", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-prospective-repo-"));
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-git-fixture-"));
    const hooksDir = path.join(fixture, "hooks");
    const excludesFile = path.join(fixture, "excludes");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(excludesFile, "");
    try {
      withIsolatedGitEnv(repo, () => {
        const git = (...args) => execFileSync("git", [
          "-c", "commit.gpgsign=false",
          "-c", "commit.gpgSign=false",
          "-c", `core.hooksPath=${hooksDir}`,
          "-c", `core.excludesfile=${excludesFile}`,
          "-c", "core.autocrlf=false",
          "-c", "core.safecrlf=false",
          ...args,
        ], { cwd: repo, stdio: "ignore" });
        git("init", "-q");
        git("config", "user.email", "test@example.com");
        git("config", "user.name", "test");
        fs.writeFileSync(path.join(repo, "node_modules"), "tracked dependency file\n");
        fs.writeFileSync(path.join(repo, "old.txt"), "rename me\n");
        fs.writeFileSync(path.join(repo, "delete.txt"), "delete me\n");
        fs.writeFileSync(path.join(repo, "edit.txt"), "before\n");
        git("add", ".");
        git("commit", "-q", "-m", "seed");

        fs.renameSync(path.join(repo, "old.txt"), path.join(repo, "new.txt"));
        fs.rmSync(path.join(repo, "delete.txt"));
        fs.writeFileSync(path.join(repo, "edit.txt"), "after edit\n");
        fs.writeFileSync(path.join(repo, "added.txt"), "new file\n");

        const committed = new Map(readTrackedTree(repo).map((file) => [file.path, file]));
        const prospective = new Map(readProspectiveTrackedTree(repo).map((file) => [file.path, file]));
        assert.deepStrictEqual(
          [...committed.keys()].sort(),
          ["delete.txt", "edit.txt", "node_modules", "old.txt"]
        );
        assert.deepStrictEqual(
          [...prospective.keys()].sort(),
          ["added.txt", "edit.txt", "new.txt", "node_modules"]
        );
        assert.strictEqual(committed.get("edit.txt").bytes, Buffer.byteLength("before\n"));
        assert.strictEqual(prospective.get("edit.txt").bytes, Buffer.byteLength("after edit\n"));
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("audits the repository twice with byte-identical manifests and reports", () => {
    const root = path.resolve(__dirname, "..");
    const firstOutput = fs.mkdtempSync(path.join(os.tmpdir(), "asset-audit-first-"));
    const secondOutput = fs.mkdtempSync(path.join(os.tmpdir(), "asset-audit-second-"));
    try {
      const first = runAudit({ repoRoot: root, output: firstOutput });
      const second = runAudit({ repoRoot: root, output: secondOutput });
      assert.deepStrictEqual(
        first.report.findings.filter((finding) => finding.level === "error"),
        [],
      );
      for (const fileName of [
        "audit-report.json",
        "package-manifest.json",
        "tracked-large-files.json",
      ]) {
        assert.strictEqual(
          fs.readFileSync(path.join(firstOutput, fileName), "utf8"),
          fs.readFileSync(path.join(secondOutput, fileName), "utf8"),
          `${fileName} changed between identical audit runs`,
        );
      }
    } finally {
      fs.rmSync(firstOutput, { recursive: true, force: true });
      fs.rmSync(secondOutput, { recursive: true, force: true });
    }
  });
});
