const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const pkg = require("../package.json");
const {
  BUILDER_ARCH_TO_WINGET,
  isDelimitedAt,
  resolveArchitecture,
  readWindowsBuildConfig,
  materializeName,
  downloadUrl,
  normalizeAssets,
  verifyWingetArchContract,
  parseArgs,
  runCli,
} = require("../scripts/verify-winget-arch-contract.js");

const RELEASE_BASE =
  "https://github.com/rullerzhou-afk/clawd-on-desk/releases/download/v0.14.0";

const WORKFLOW_PATH = path.join(__dirname, "..", ".github", "workflows", "winget.yml");
const WORKFLOW_RAW = fs.readFileSync(WORKFLOW_PATH, "utf8");

// Assertions below run against the workflow with comments removed. Grepping the
// raw text lets any assertion be satisfied by a comment that merely mentions the
// right token while the executable YAML says something else.
function stripComments(yaml) {
  return yaml
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, ""))
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const WORKFLOW = stripComments(WORKFLOW_RAW);

// Returns the body of a named step, up to the next step at the same indent.
function stepBody(yaml, name) {
  const start = yaml.indexOf(`- name: ${name}`);
  if (start === -1) return null;
  const rest = yaml.slice(start + 1);
  const next = rest.indexOf("\n      - ");
  return next === -1 ? rest : rest.slice(0, next);
}

// Asserts a CLI flag carries an exact value. Checking only that a flag appears
// lets `--require-architectures ""` or `--version "9.9.9"` pass unnoticed, which
// is how six semantic breaks survived an earlier revision of these tests.
function assertFlag(body, flag, expected, message) {
  const match = body.match(new RegExp(`${flag}\\s+(\\S+)`));
  assert.ok(match, `${flag} must be passed${message ? ` (${message})` : ""}`);
  assert.equal(match[1], expected, `${flag} must be ${expected}, got ${match[1]}`);
}

function configWith() {
  return {
    version: "0.14.0",
    build: {
      publish: [{ provider: "github", owner: "rullerzhou-afk", repo: "clawd-on-desk" }],
      win: {
        artifactName: "Clawd-on-Desk-Setup-${version}-${arch}.${ext}",
        target: [{ target: "nsis", arch: ["x64", "arm64"] }],
      },
    },
  };
}

const X64_ASSET = {
  name: "Clawd-on-Desk-Setup-0.14.0-x64.exe",
  digest: "sha256:3733d49f918d5dccbdeaf00daf926938c8bc657f1bea81caf6bfb43de3cb4efb",
  size: 128223329,
};
const ARM64_ASSET = {
  name: "Clawd-on-Desk-Setup-0.14.0-arm64.exe",
  digest: "sha256:0e4d6527603a924394697ccb0648b09c146a5c39f8bd725c481d4bbca0177a42",
  size: 129682958,
};

describe("winget architecture resolver (ported from winget-types from_url)", () => {
  it("resolves our shipped installer names to distinct architectures", () => {
    assert.equal(
      resolveArchitecture(`${RELEASE_BASE}/Clawd-on-Desk-Setup-0.14.0-x64.exe`).architecture,
      "x64",
    );
    assert.equal(
      resolveArchitecture(`${RELEASE_BASE}/Clawd-on-Desk-Setup-0.14.0-arm64.exe`).architecture,
      "arm64",
    );
  });

  it("prefers arm64 over the shorter arm token", () => {
    const resolved = resolveArchitecture(
      `${RELEASE_BASE}/Clawd-on-Desk-Setup-0.14.0-arm64.exe`,
    );
    assert.equal(resolved.matched, "arm64");
  });

  it("prefers the longer name when two tokens start at the same offset", () => {
    const resolved = resolveArchitecture(`${RELEASE_BASE}/app-x86_64.exe`);
    assert.equal(resolved.matched, "x86_64");
    assert.equal(resolved.architecture, "x64");
  });

  it("prefers the rightmost delimited token", () => {
    assert.equal(
      resolveArchitecture(`${RELEASE_BASE}/x64-tools/app-arm64.exe`).architecture,
      "arm64",
    );
  });

  it("narrows upstream: a token upstream would rescue resolves to null", () => {
    // Real upstream resolves this to x64 through its `{arch}.{ext}` fallback,
    // which is deliberately not ported.
    assert.equal(resolveArchitecture("https://example.com/installerx64.exe").architecture, null);
  });

  it("treats a token at index 0 as undelimited", () => {
    assert.equal(isDelimitedAt("x64.exe", 0, 3), false);
    assert.equal(resolveArchitecture("x64.exe").architecture, null);
  });

  it("requires a delimiter on both sides", () => {
    assert.equal(isDelimitedAt("app-x64.exe", 4, 3), true);
    assert.equal(isDelimitedAt("app-x64", 4, 3), false, "token running to end of string");
  });

  it("is case insensitive", () => {
    assert.equal(resolveArchitecture(`${RELEASE_BASE}/App-ARM64.EXE`).architecture, "arm64");
  });
});

describe("winget architecture contract", () => {
  it("passes for the current package.json", () => {
    const report = verifyWingetArchContract();
    assert.deepEqual(report.errors, [], report.errors.join("\n"));
    assert.equal(report.installers.length, 2);
  });

  it("maps every shipped Windows target to the architecture it claims", () => {
    for (const installer of verifyWingetArchContract().installers) {
      assert.equal(
        installer.resolvedArchitecture,
        installer.expectedArchitecture,
        `${installer.filename} must resolve to ${installer.expectedArchitecture}`,
      );
    }
  });

  it("detects two targets collapsing onto one architecture, in isolation", () => {
    const config = configWith();
    config.build.win.target = [{ target: "nsis", arch: ["x64", "x64"] }];
    const report = verifyWingetArchContract({ config });
    assert.equal(report.errors.length, 1, report.errors.join("\n"));
    assert.match(report.errors[0], /do not resolve to distinct architectures/);
  });

  it("detects a filename resolving to the wrong architecture, in isolation", () => {
    const config = configWith();
    config.build.win.artifactName = "Clawd-on-Desk-Setup-${version}-${arch}-x64.${ext}";
    config.build.win.target = [{ target: "nsis", arch: ["arm64"] }];
    const report = verifyWingetArchContract({ config });
    assert.equal(report.errors.length, 1, report.errors.join("\n"));
    assert.match(report.errors[0], /resolves to WinGet architecture "x64"/);
  });

  it("fails when the ${arch} token is dropped from artifactName", () => {
    const config = configWith();
    config.build.win.artifactName = "Clawd-on-Desk-Setup-${version}.${ext}";
    const report = verifyWingetArchContract({ config });
    assert.ok(
      report.errors.some((error) => error.includes("${arch} token")),
      report.errors.join("\n"),
    );
  });

  it("fails when ${arch} is present but produces an undelimited name", () => {
    const config = configWith();
    config.build.win.artifactName = "Clawd-on-Desk-Setup-${version}${arch}.${ext}";
    const report = verifyWingetArchContract({ config });
    assert.ok(
      report.errors.some((error) => error.includes("No delimited architecture token")),
      report.errors.join("\n"),
    );
  });

  it("fails when artifactName is missing entirely", () => {
    const config = configWith();
    delete config.build.win.artifactName;
    const report = verifyWingetArchContract({ config });
    assert.ok(
      report.errors.some((error) => error.includes("artifactName is missing")),
      report.errors.join("\n"),
    );
  });

  it("fails when a target leaves its architecture implicit", () => {
    const config = configWith();
    config.build.win.target = ["nsis"];
    const report = verifyWingetArchContract({ config });
    assert.ok(
      report.errors.some((error) => error.includes("leaves arch implicit")),
      report.errors.join("\n"),
    );
  });

  it("fails when no architectures are declared at all", () => {
    const config = configWith();
    config.build.win.target = [];
    const report = verifyWingetArchContract({ config });
    assert.ok(
      report.errors.some((error) => error.includes("declares no architectures")),
      report.errors.join("\n"),
    );
  });

  it("fails on an electron-builder arch with no WinGet mapping", () => {
    const config = configWith();
    config.build.win.target = [{ target: "nsis", arch: ["x64", "riscv64"] }];
    const report = verifyWingetArchContract({ config });
    assert.ok(
      report.errors.some((error) => error.includes("BUILDER_ARCH_TO_WINGET")),
      report.errors.join("\n"),
    );
  });

  it("fails on a Windows target with no extension mapping", () => {
    const config = configWith();
    config.build.win.target = [{ target: "msi", arch: ["x64"] }];
    const report = verifyWingetArchContract({ config });
    assert.ok(
      report.errors.some((error) => error.includes("TARGET_EXTENSION")),
      report.errors.join("\n"),
    );
  });

  it("fails when build.publish is missing", () => {
    const config = configWith();
    delete config.build.publish;
    const report = verifyWingetArchContract({ config });
    assert.ok(
      report.errors.some((error) => error.includes("build.publish")),
      report.errors.join("\n"),
    );
  });

  it("pins the electron-builder to WinGet architecture mapping", () => {
    assert.deepEqual(BUILDER_ARCH_TO_WINGET, {
      x64: "x64",
      arm64: "arm64",
      ia32: "x86",
      armv7l: "arm",
    });
  });
});

describe("winget contract required-architecture set", () => {
  // Distinctness alone permits shipping a single architecture: with one entry
  // the collision check is skipped and everything else passes.
  it("rejects a build that would publish only x64", () => {
    const config = configWith();
    config.build.win.target = [{ target: "nsis", arch: ["x64"] }];
    const report = verifyWingetArchContract({
      config,
      requiredArchitectures: ["x64", "arm64"],
      assets: [X64_ASSET],
    });
    assert.ok(
      report.errors.some((error) => error.includes("Published architectures must be exactly")),
      report.errors.join("\n"),
    );
    assert.deepEqual(report.komacUrls, []);
  });

  it("rejects a build that would publish an extra architecture", () => {
    const config = configWith();
    config.build.win.target = [{ target: "nsis", arch: ["x64", "arm64", "ia32"] }];
    const report = verifyWingetArchContract({
      config,
      requiredArchitectures: ["x64", "arm64"],
    });
    assert.ok(
      report.errors.some((error) => error.includes("Published architectures must be exactly")),
      report.errors.join("\n"),
    );
  });

  it("accepts the required set regardless of declaration order", () => {
    const report = verifyWingetArchContract({
      config: configWith(),
      requiredArchitectures: ["arm64", "x64"],
    });
    assert.deepEqual(report.errors, [], report.errors.join("\n"));
    assert.deepEqual(report.requiredArchitectures, ["arm64", "x64"]);
  });
});

describe("winget contract release-tag binding", () => {
  // Installer URLs come from package.json; the manifest version comes from the
  // tag. A tag cut without bumping package.json would cross the two.
  it("rejects a tag that does not match package.json", () => {
    const report = verifyWingetArchContract({ config: configWith(), releaseTag: "v0.15.0" });
    assert.ok(
      report.errors.some((error) => error.includes("does not match package.json version")),
      report.errors.join("\n"),
    );
    assert.deepEqual(report.komacUrls, []);
  });

  it("accepts the matching tag", () => {
    const report = verifyWingetArchContract({ config: configWith(), releaseTag: "v0.14.0" });
    assert.deepEqual(report.errors, [], report.errors.join("\n"));
  });

  it("rejects a bare version with no v prefix", () => {
    const report = verifyWingetArchContract({ config: configWith(), releaseTag: "0.14.0" });
    assert.ok(report.errors.length > 0, "expected a tag mismatch");
  });
});

describe("winget contract komac arguments", () => {
  it("emits one explicit |architecture override per installer", () => {
    const report = verifyWingetArchContract({ config: configWith() });
    assert.deepEqual(report.komacUrls, [
      `${RELEASE_BASE}/Clawd-on-Desk-Setup-0.14.0-x64.exe|x64`,
      `${RELEASE_BASE}/Clawd-on-Desk-Setup-0.14.0-arm64.exe|arm64`,
    ]);
  });

  it("emits nothing when the contract fails", () => {
    const config = configWith();
    config.build.win.target = [{ target: "nsis", arch: ["x64", "x64"] }];
    const report = verifyWingetArchContract({ config });
    assert.ok(report.errors.length > 0);
    assert.deepEqual(report.komacUrls, []);
  });

  it("builds each URL from the release tag and filename", () => {
    assert.equal(
      downloadUrl({
        owner: "rullerzhou-afk",
        repo: "clawd-on-desk",
        version: "1.2.3",
        filename: "x.exe",
      }),
      "https://github.com/rullerzhou-afk/clawd-on-desk/releases/download/v1.2.3/x.exe",
    );
  });
});

describe("winget contract release-asset cross-check", () => {
  it("passes when the release carries exactly the expected installers", () => {
    const report = verifyWingetArchContract({
      config: configWith(),
      assets: [X64_ASSET, ARM64_ASSET, { name: "latest.yml", digest: "sha256:aa", size: 1 }],
    });
    assert.deepEqual(report.errors, [], report.errors.join("\n"));
    assert.equal(report.assetsChecked, 3);
  });

  it("records each installer's digest and size in the report", () => {
    const report = verifyWingetArchContract({
      config: configWith(),
      assets: [X64_ASSET, ARM64_ASSET],
    });
    const byName = Object.fromEntries(report.installers.map((i) => [i.filename, i]));
    assert.equal(byName[X64_ASSET.name].digest, X64_ASSET.digest);
    assert.equal(byName[ARM64_ASSET.name].size, ARM64_ASSET.size);
  });

  it("fails when an expected installer is absent from the release", () => {
    const report = verifyWingetArchContract({ config: configWith(), assets: [X64_ASSET] });
    assert.ok(
      report.errors.some((error) => error.includes("missing the expected installer")),
      report.errors.join("\n"),
    );
  });

  it("fails on a stray asset that would also match the installer regex", () => {
    const report = verifyWingetArchContract({
      config: configWith(),
      assets: [
        X64_ASSET,
        ARM64_ASSET,
        { name: "Clawd-on-Desk-Portable-0.14.0.exe", digest: "sha256:bb", size: 1 },
      ],
    });
    assert.ok(
      report.errors.some((error) => error.includes("Unexpected asset")),
      report.errors.join("\n"),
    );
  });

  it("fails when both installers are the same binary", () => {
    // Exactly what shipped: two names, one file, identical SHA256. The explicit
    // |arch override would then label real arm64 content as x64.
    const report = verifyWingetArchContract({
      config: configWith(),
      assets: [X64_ASSET, { ...ARM64_ASSET, digest: X64_ASSET.digest }],
    });
    assert.ok(
      report.errors.some((error) => error.includes("share a digest")),
      report.errors.join("\n"),
    );
    assert.deepEqual(report.komacUrls, []);
  });

  it("fails when an installer asset carries no digest to pin", () => {
    const report = verifyWingetArchContract({
      config: configWith(),
      assets: [X64_ASSET, { ...ARM64_ASSET, digest: "" }],
    });
    assert.ok(
      report.errors.some((error) => error.includes("no digest to pin")),
      report.errors.join("\n"),
    );
  });

  it("fails on a digest that is not sha256:<64 hex>", () => {
    // Two arbitrary non-empty strings would otherwise satisfy distinctness and
    // pin nothing at all.
    const report = verifyWingetArchContract({
      config: configWith(),
      assets: [
        { ...X64_ASSET, digest: "a" },
        { ...ARM64_ASSET, digest: "b" },
      ],
    });
    assert.equal(
      report.errors.filter((error) => error.includes("unrecognized digest")).length,
      2,
      report.errors.join("\n"),
    );
    assert.deepEqual(report.komacUrls, []);
  });

  it("fails when the release lists the same asset name twice", () => {
    const report = verifyWingetArchContract({
      config: configWith(),
      assets: [X64_ASSET, ARM64_ASSET, { ...X64_ASSET, digest: "sha256:" + "d".repeat(64) }],
    });
    assert.ok(
      report.errors.some((error) => error.includes("duplicate asset names")),
      report.errors.join("\n"),
    );
  });

  it("does not claim a distinct digest proves the architecture", () => {
    // Swapping the two binaries passes every check here. This test exists to
    // record that limitation, not to assert a guarantee we do not have.
    const report = verifyWingetArchContract({
      config: configWith(),
      assets: [
        { ...X64_ASSET, digest: ARM64_ASSET.digest },
        { ...ARM64_ASSET, digest: X64_ASSET.digest },
      ],
    });
    assert.deepEqual(report.errors, [], "content-swap is out of scope for this gate");
  });
});

describe("winget contract installers-regex cross-check", () => {
  const workflowRegex = (() => {
    const match = WORKFLOW.match(/^\s*INSTALLERS_REGEX:\s*'(.+)'\s*$/m);
    assert.ok(match, "workflow must define INSTALLERS_REGEX");
    return match[1];
  })();

  it("matches every installer the contract expects", () => {
    const report = verifyWingetArchContract({ installersRegex: workflowRegex });
    assert.deepEqual(report.errors, [], report.errors.join("\n"));
  });

  it("selects both architectures, never a single one", () => {
    const matcher = new RegExp(workflowRegex);
    const matched = verifyWingetArchContract().installers.filter((installer) =>
      matcher.test(installer.filename),
    );
    assert.equal(matched.length, 2, "a regex matching one installer republishes the bug");
    assert.deepEqual(
      matched.map((installer) => installer.resolvedArchitecture).sort(),
      ["arm64", "x64"],
    );
  });

  it("fails when the regex misses an expected installer", () => {
    const report = verifyWingetArchContract({
      installersRegex: "^Clawd-on-Desk-Setup-.*-x64\\.exe$",
    });
    assert.ok(
      report.errors.some((error) => error.includes("does not match the WinGet installers-regex")),
      report.errors.join("\n"),
    );
  });

  it("uses the regex, not the .exe suffix, to spot stray assets", () => {
    const report = verifyWingetArchContract({
      config: configWith(),
      installersRegex: "^Clawd-on-Desk-Setup-.*-(x64|arm64)\\.(exe|msi)$",
      assets: [
        X64_ASSET,
        ARM64_ASSET,
        { name: "Clawd-on-Desk-Setup-0.14.0-x64.msi", digest: "sha256:cc", size: 1 },
      ],
    });
    assert.ok(
      report.errors.some((error) => error.includes("Unexpected asset")),
      report.errors.join("\n"),
    );
  });

  it("reports an unusable regex rather than ignoring it", () => {
    const report = verifyWingetArchContract({ installersRegex: "([" });
    assert.ok(
      report.errors.some((error) => error.includes("not a valid regular expression")),
      report.errors.join("\n"),
    );
  });

  it("declares the same required architectures the workflow does", () => {
    const match = WORKFLOW.match(/^\s*REQUIRED_ARCHITECTURES:\s*"(.+)"\s*$/m);
    assert.ok(match, "workflow must define REQUIRED_ARCHITECTURES");
    assert.deepEqual(match[1].split(",").map((v) => v.trim()).sort(), ["arm64", "x64"]);
  });
});

describe("winget contract helpers", () => {
  it("reads the Windows build config from package.json", () => {
    const build = readWindowsBuildConfig(pkg);
    assert.equal(build.owner, "rullerzhou-afk");
    assert.equal(build.repo, "clawd-on-desk");
    assert.ok(build.entries.length >= 1);
  });

  it("materializes every artifactName token", () => {
    assert.equal(
      materializeName("Clawd-on-Desk-Setup-${version}-${arch}.${ext}", {
        version: "1.2.3",
        arch: "arm64",
        ext: "exe",
      }),
      "Clawd-on-Desk-Setup-1.2.3-arm64.exe",
    );
  });

  it("normalizes both bare and wrapped asset payloads", () => {
    assert.deepEqual(normalizeAssets([X64_ASSET]), [X64_ASSET]);
    assert.deepEqual(normalizeAssets({ assets: [X64_ASSET] }), [X64_ASSET]);
  });

  it("rejects an asset payload that is neither shape", () => {
    assert.throws(() => normalizeAssets({ nope: 1 }), /JSON array/);
  });

  it("rejects a non-object asset entry by index", () => {
    assert.throws(() => normalizeAssets([X64_ASSET, null]), /assets\[1\] is not an object/);
  });

  it("rejects unknown CLI arguments", () => {
    assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
  });

  it("parses every supported CLI argument", () => {
    assert.deepEqual(
      parseArgs([
        "--assets-file", "a.json",
        "--output", "b.json",
        "--installers-regex", "^x$",
        "--require-architectures", "x64,arm64",
        "--release-tag", "v1.0.0",
        "--package-json", "tagged.json",
      ]),
      {
        assetsFile: "a.json",
        output: "b.json",
        installersRegex: "^x$",
        requireArchitectures: "x64,arm64",
        releaseTag: "v1.0.0",
        packageJson: "tagged.json",
      },
    );
  });
});

describe("winget contract tagged build configuration", () => {
  // The tooling checkout and the release's build config come from different
  // trees; --package-json is what keeps the installer URLs tied to the tag.
  it("reads the build config from the given file, not the repo's own", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "winget-cfg-"));
    const configPath = path.join(dir, "tagged-package.json");
    const output = path.join(dir, "report.json");
    const tagged = configWith();
    tagged.version = "0.9.9";
    fs.writeFileSync(configPath, JSON.stringify(tagged), "utf8");

    const code = runCli([
      "--package-json", configPath,
      "--release-tag", "v0.9.9",
      "--output", output,
    ]);
    assert.equal(code, 0, "the tagged config must be the one that is checked");

    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(report.version, "0.9.9");
    assert.ok(
      report.installers.every((installer) => installer.url.includes("/v0.9.9/")),
      "installer URLs must come from the tagged version",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still catches a tag that disagrees with the tagged config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "winget-cfg-"));
    const configPath = path.join(dir, "tagged-package.json");
    const output = path.join(dir, "report.json");
    fs.writeFileSync(configPath, JSON.stringify(configWith()), "utf8");

    const code = runCli([
      "--package-json", configPath,
      "--release-tag", "v0.9.9",
      "--output", output,
    ]);
    assert.equal(code, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("winget contract CLI", () => {
  function scratch() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "winget-arch-"));
  }

  it("writes a JSON evidence manifest and exits zero", () => {
    const dir = scratch();
    const output = path.join(dir, "winget-arch.json");
    assert.equal(runCli(["--output", output]), 0);
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.errors.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exits non-zero and records the failure when the release is incomplete", () => {
    // Covers the whole CI path: --assets-file is read and fed into the contract,
    // and the exit code the workflow gate relies on is actually non-zero.
    const dir = scratch();
    const assetsFile = path.join(dir, "assets.json");
    const output = path.join(dir, "winget-arch.json");
    const version = pkg.version;
    fs.writeFileSync(
      assetsFile,
      JSON.stringify([
        { name: `Clawd-on-Desk-Setup-${version}-x64.exe`, digest: "sha256:aa", size: 1 },
        { name: "latest.yml", digest: "sha256:bb", size: 2 },
      ]),
      "utf8",
    );

    assert.equal(runCli(["--assets-file", assetsFile, "--output", output]), 1);

    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(report.assetsChecked, 2);
    assert.ok(
      report.errors.some((error) => error.includes(`Setup-${version}-arm64.exe`)),
      report.errors.join("\n"),
    );
    assert.deepEqual(report.komacUrls, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes every option through to the contract", () => {
    const dir = scratch();
    const output = path.join(dir, "winget-arch.json");
    const code = runCli([
      "--installers-regex", "^nope$",
      "--require-architectures", "x64",
      "--release-tag", "v9.9.9",
      "--output", output,
    ]);
    assert.equal(code, 1);
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(report.installersRegex, "^nope$");
    assert.deepEqual(report.requiredArchitectures, ["x64"]);
    assert.equal(report.releaseTag, "v9.9.9");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("winget prepare workflow", () => {
  it("keeps the ambient GitHub token strictly read-only", () => {
    // Mutable actions are acceptable during prepare-only only because the job
    // token cannot write. Lock both the top-level value and the absence of a
    // job-level override so that premise cannot silently drift.
    // Matches the inline form too (`permissions: write-all`): a job-level
    // override written that way is valid YAML, replaces the workflow-level grant
    // outright, and would slip past a bare-`permissions:` pattern.
    const declarations = WORKFLOW.match(/^[ \t]*permissions:/gm) || [];
    assert.equal(declarations.length, 1, "workflow must declare permissions exactly once");

    const topLevel = WORKFLOW.match(/^permissions:\s*\n((?:[ \t]+.*(?:\n|$))*)/m);
    assert.ok(topLevel, "workflow must declare top-level permissions");
    assert.equal(topLevel[1].trim(), "contents: read");
  });

  it("references no repository secret and submits nothing", () => {
    // Phase 0 is prepare-only. The ambient github.token is still technically a
    // secret, so this asserts the narrower true thing: no long-lived PAT or
    // configured repository secret. Adding one would also reintroduce the
    // requirement to pin every action to a commit SHA.
    assert.doesNotMatch(WORKFLOW, /secrets\./, "workflow must reference no repository secret");
    assert.doesNotMatch(WORKFLOW, /komac submit/, "workflow must not submit");
    assert.doesNotMatch(WORKFLOW, /--submit\b/, "workflow must not submit");
  });

  it("runs komac in dry-run as a standalone flag", () => {
    // `--dry-run=false` still matches a bare /--dry-run/ search but is rejected
    // by clap, so the run would fail rather than being safely prepared.
    const body = stepBody(WORKFLOW, "Generate manifest (no submission)");
    assert.ok(body, "generate step must exist");
    assert.match(body, /^\s*--dry-run\s*\\?\s*$/m, "--dry-run must take no value");
  });

  it("bounds the job so a stalled download cannot hold the concurrency group", () => {
    // komac downloads both installers in full; there is no header-only mode.
    assert.match(WORKFLOW, /timeout-minutes:\s*\d+/);
  });

  it("runs the architecture contract before invoking komac", () => {
    const gate = WORKFLOW.indexOf("verify:winget-arch");
    const generate = WORKFLOW.indexOf("komac update");
    assert.ok(gate > -1, "workflow must run the architecture gate");
    assert.ok(generate > -1, "workflow must generate via komac");
    assert.ok(gate < generate, "the gate must run before generation");
  });

  it("gives the gate no way to be skipped or ignored", () => {
    const body = stepBody(WORKFLOW, "Verify WinGet architecture contract");
    assert.ok(body, "gate step must exist");
    assert.doesNotMatch(body, /\bif:/, "gate must not be conditional");
    assert.doesNotMatch(body, /continue-on-error/, "gate failure must fail the job");
  });

  it("passes the gate live values, not just the right flag names", () => {
    const body = stepBody(WORKFLOW, "Verify WinGet architecture contract");
    assertFlag(body, "--release-tag", '"$TAG"', "must track the resolved tag");
    assertFlag(body, "--require-architectures", '"$REQUIRED_ARCHITECTURES"');
    assertFlag(body, "--installers-regex", '"$INSTALLERS_REGEX"');
    assertFlag(body, "--package-json", "tagged-package.json");
    assertFlag(body, "--output", "winget-arch-contract.json");
  });

  it("reads the build config from the tag, not the tooling checkout", () => {
    // Installer filenames come from the package.json that built the assets.
    const body = stepBody(WORKFLOW, "Fetch the tagged build configuration");
    assert.ok(body, "config fetch step must exist");
    assert.match(body, /contents\/package\.json\?ref=\$TAG/);
    assert.match(body, />\s*tagged-package\.json/);
  });

  it("checks the tooling out at the default branch explicitly", () => {
    // Without an explicit ref, actions/checkout takes the triggering ref, which
    // for a release event is the tag — and older tags lack this tooling.
    const body = stepBody(WORKFLOW, "Check out release tooling");
    assert.ok(body, "tooling checkout step must exist");
    assert.match(body, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
  });

  it("collects whole asset objects, not just names", () => {
    const body = stepBody(WORKFLOW, "Collect release assets");
    assert.ok(body, "collect step must exist");
    assert.match(body, /--json assets/);
    // A `.assets[].name` filter would drop the digests the contract pins
    // content with, and every other assertion here would still pass.
    assert.doesNotMatch(body, /\.assets\[\]\.name/);
  });

  it("feeds the gate exactly the file the collect step writes", () => {
    // Binding the two steps by value: asserting each mentions some filename
    // passes even when they disagree, because a leftover reference elsewhere in
    // the step satisfies the match.
    const collect = stepBody(WORKFLOW, "Collect release assets");
    const gate = stepBody(WORKFLOW, "Verify WinGet architecture contract");
    const written = collect.match(/>\s*(\S+\.json)/);
    const consumed = gate.match(/--assets-file\s+(\S+)/);
    assert.ok(written, "collect step must redirect to a .json file");
    assert.ok(consumed, "gate must be given an assets file");
    assert.equal(consumed[1], written[1]);
  });

  it("feeds komac exactly the URLs the contract emitted", () => {
    const body = stepBody(WORKFLOW, "Generate manifest (no submission)");
    assert.ok(body, "generate step must exist");
    assert.match(body, /\.komacUrls\[\]/, "URLs must come from the verified report");
    assert.doesNotMatch(body, /releases\/download/, "URLs must not be rebuilt by hand");
    assert.match(body, /--urls "\$\{urls\[@\]\}"/, "the resolved array must be passed");
    assertFlag(body, "--version", '"${TAG#v}"', "must derive from the resolved tag");
  });

  it("writes komac output to the directory it uploads", () => {
    const generate = stepBody(WORKFLOW, "Generate manifest (no submission)");
    const output = generate.match(/--output\s+(\S+)/);
    assert.ok(output, "generate step must pass --output");
    assert.match(
      WORKFLOW,
      new RegExp(`name: winget-generated-manifest\\s*\\n\\s*path: ${output[1]}/?`),
      `upload path must match komac --output (${output[1]})`,
    );
  });

  it("summarizes the manifest from komac's nested layout", () => {
    // komac writes the winget-pkgs directory tree, so a flat generated/*.yaml
    // glob silently matches nothing and the summary renders empty.
    const body = stepBody(WORKFLOW, "Summarize generated installers");
    assert.ok(body, "summary step must exist");
    assert.doesNotMatch(body, /cat generated\/\*/, "flat glob cannot match the nested layout");
    assert.match(body, /find generated .*installer\.yaml/);
  });

  it("installs komac somewhere a non-root runner can write", () => {
    // GitHub-hosted runners execute as a non-root user; /usr/local/bin needs sudo.
    const body = stepBody(WORKFLOW, "Install komac");
    assert.ok(body, "install step must exist");
    assert.doesNotMatch(body, /\/usr\/local\/bin/);
    assert.match(body, /\$RUNNER_TEMP\/bin/);
    assert.match(body, />> "\$GITHUB_PATH"/, "the install dir must be added to PATH");
  });

  it("pins komac to a version and verifies its checksum", () => {
    assert.match(WORKFLOW, /KOMAC_VERSION:\s*"2\.16\.0"/);
    assert.match(
      WORKFLOW,
      /KOMAC_SHA256:\s*"7d2707fa6210f2789a3702de49fbd150b736dbf426ee0b9bc8e098736f9fd82d"/,
    );
    const body = stepBody(WORKFLOW, "Install komac");
    assert.ok(body, "install step must exist");
    assert.match(body, /sha256sum --check --strict/);
  });

  it("only prepares non-prerelease version tags", () => {
    assert.match(WORKFLOW, /types:\s*\[released\]/);
    assert.match(WORKFLOW, /github\.event\.release\.prerelease == false/);
    const body = stepBody(WORKFLOW, "Resolve release tag");
    assert.ok(body, "resolve step must exist");
    // Polarity matters: a guard that publishes only prereleases would satisfy a
    // naive "mentions isPrerelease" assertion.
    assert.match(body, /\[ "\$prerelease" != "false" \]/);
    assert.match(body, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/, "tag shape must be pinned");
  });

  it("serializes concurrent runs", () => {
    assert.match(WORKFLOW, /concurrency:/);
    assert.match(WORKFLOW, /cancel-in-progress:\s*false/);
  });

  it("declares the exact package identifier live in winget-pkgs", () => {
    assert.match(WORKFLOW, /komac update rullerzhou-afk\.clawd-on-desk\s*\\?\s*$/m);
  });

  it("invokes an npm script that package.json actually defines", () => {
    const invoked = WORKFLOW.match(/npm run ([\w:-]+)/g) || [];
    assert.ok(invoked.length > 0, "workflow must invoke an npm script");
    for (const entry of invoked) {
      const name = entry.replace("npm run ", "");
      assert.ok(pkg.scripts[name], `package.json is missing the "${name}" script`);
    }
    assert.equal(pkg.scripts["verify:winget-arch"], "node scripts/verify-winget-arch-contract.js");
  });
});
