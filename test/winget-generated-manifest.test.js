const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");
const yaml = require("js-yaml");

const {
  LICENSE,
  MANIFEST_FILES,
  MANIFEST_VERSION,
  PACKAGE_IDENTIFIER,
  PRODUCT_CODE,
  manifestHeader,
  normalizeAndVerifyGeneratedManifest,
  parseArgs,
  runCli,
} = require("../scripts/verify-winget-generated-manifest.js");

const VERSION = "1.2.3";
const TAG = `v${VERSION}`;
const BASE_URL =
  `https://github.com/rullerzhou-afk/clawd-on-desk/releases/download/${TAG}`;
const DIGESTS = {
  x64: `sha256:${"a".repeat(64)}`,
  arm64: `sha256:${"b".repeat(64)}`,
};

function manifestSource(type, value) {
  return (
    `# Created with komac v2.16.0\n${manifestHeader(type)}\n\n` +
    yaml.dump(value, {
      schema: yaml.JSON_SCHEMA,
      lineWidth: -1,
      noCompatMode: true,
      noRefs: true,
      sortKeys: false,
    })
  );
}

function common(type) {
  return {
    PackageIdentifier: PACKAGE_IDENTIFIER,
    PackageVersion: VERSION,
    ManifestType: type,
    ManifestVersion: MANIFEST_VERSION,
  };
}

function fixture({ mutateContract, mutateDocuments, extraFile = "" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "winget-generated-"));
  const manifestDirectory = path.join(
    root,
    "generated",
    "manifests",
    "r",
    "rullerzhou-afk",
    "clawd-on-desk",
    VERSION,
  );
  fs.mkdirSync(manifestDirectory, { recursive: true });

  const architectureContract = {
    schemaVersion: 2,
    version: VERSION,
    releaseTag: TAG,
    errors: [],
    installers: ["x64", "arm64"].map((architecture) => ({
      expectedArchitecture: architecture,
      resolvedArchitecture: architecture,
      filename: `Clawd-on-Desk-Setup-${VERSION}-${architecture}.exe`,
      url: `${BASE_URL}/Clawd-on-Desk-Setup-${VERSION}-${architecture}.exe`,
      digest: DIGESTS[architecture],
    })),
  };

  const documents = {
    installer: {
      PackageIdentifier: PACKAGE_IDENTIFIER,
      PackageVersion: VERSION,
      InstallerLocale: "en-US",
      InstallerType: "nullsoft",
      InstallerSwitches: { Upgrade: "--updated" },
      UpgradeBehavior: "install",
      ProductCode: PRODUCT_CODE,
      ReleaseDate: "2026-09-20",
      AppsAndFeaturesEntries: [
        { DisplayName: `Clawd on Desk ${VERSION}`, ProductCode: PRODUCT_CODE },
      ],
      Installers: [
        ["x64", "user", "/currentuser"],
        ["x64", "machine", "/allusers"],
        ["arm64", "user", "/currentuser"],
        ["arm64", "machine", "/allusers"],
      ].map(([architecture, scope, custom]) => ({
        Architecture: architecture,
        Scope: scope,
        InstallerUrl: `${BASE_URL}/Clawd-on-Desk-Setup-${VERSION}-${architecture}.exe`,
        InstallerSha256: DIGESTS[architecture].slice("sha256:".length).toUpperCase(),
        InstallerSwitches: { Custom: custom },
      })),
      ManifestType: "installer",
      ManifestVersion: MANIFEST_VERSION,
    },
    defaultLocale: {
      PackageIdentifier: PACKAGE_IDENTIFIER,
      PackageVersion: VERSION,
      PackageLocale: "en-US",
      Publisher: "rullerzhou-afk",
      PublisherUrl: "https://github.com/rullerzhou-afk",
      PublisherSupportUrl: "https://github.com/rullerzhou-afk/clawd-on-desk/issues",
      PackageName: "Clawd on Desk",
      PackageUrl: "https://github.com/rullerzhou-afk/clawd-on-desk",
      License: "AGPL-3.0",
      LicenseUrl: "https://github.com/rullerzhou-afk/clawd-on-desk/blob/HEAD/LICENSE",
      Copyright: "Copyright (c) 2026 rullerzhou-afk",
      ShortDescription: "A desktop pet.",
      Description: "Shows AI coding agent activity.",
      Tags: ["desktop-pet"],
      ReleaseNotes: "A test release.",
      ReleaseNotesUrl: `https://github.com/rullerzhou-afk/clawd-on-desk/releases/tag/${TAG}`,
      ManifestType: "defaultLocale",
      ManifestVersion: MANIFEST_VERSION,
    },
    locale: {
      PackageIdentifier: PACKAGE_IDENTIFIER,
      PackageVersion: VERSION,
      PackageLocale: "zh-CN",
      License: LICENSE,
      LicenseUrl: "https://github.com/rullerzhou-afk/clawd-on-desk/blob/v1.0.0/LICENSE",
      ShortDescription: "一款桌宠。",
      Description: "显示 AI 编程助手的工作状态。",
      Tags: ["桌宠"],
      ManifestType: "locale",
      ManifestVersion: MANIFEST_VERSION,
    },
    version: {
      ...common("version"),
      DefaultLocale: "en-US",
    },
  };

  if (mutateContract) mutateContract(architectureContract);
  if (mutateDocuments) mutateDocuments(documents);

  for (const [type, filename] of Object.entries(MANIFEST_FILES)) {
    fs.writeFileSync(
      path.join(manifestDirectory, filename),
      manifestSource(type, documents[type]),
      "utf8",
    );
  }
  if (extraFile) {
    const extraPath = path.join(root, "generated", extraFile);
    fs.mkdirSync(path.dirname(extraPath), { recursive: true });
    fs.writeFileSync(extraPath, "unexpected\n", "utf8");
  }

  const contractPath = path.join(root, "winget-arch-contract.json");
  fs.writeFileSync(contractPath, JSON.stringify(architectureContract), "utf8");
  return {
    root,
    generatedRoot: path.join(root, "generated"),
    manifestDirectory,
    contractPath,
  };
}

function readManifest(testFixture, type) {
  return yaml.load(
    fs.readFileSync(path.join(testFixture.manifestDirectory, MANIFEST_FILES[type]), "utf8"),
    { schema: yaml.JSON_SCHEMA },
  );
}

function cleanup(testFixture) {
  fs.rmSync(testFixture.root, { recursive: true, force: true });
}

describe("generated WinGet manifest gate", () => {
  it("normalizes locale metadata and verifies the exact four-entry matrix", () => {
    const testFixture = fixture();
    try {
      const report = normalizeAndVerifyGeneratedManifest({
        architectureContract: testFixture.contractPath,
        generatedRoot: testFixture.generatedRoot,
        releaseTag: TAG,
      });
      assert.deepEqual(report.errors, [], report.errors.join("\n"));
      assert.equal(report.summary.files, 4);
      assert.equal(report.summary.installers, 4);
      assert.equal(report.normalizedFiles.length, 2);
      assert.equal(Object.keys(report.fileDigests).length, 4);

      for (const type of ["defaultLocale", "locale"]) {
        const value = readManifest(testFixture, type);
        assert.equal(value.License, LICENSE);
        assert.equal(
          value.LicenseUrl,
          `https://github.com/rullerzhou-afk/clawd-on-desk/blob/${TAG}/LICENSE`,
        );
        assert.equal(
          value.ReleaseNotesUrl,
          `https://github.com/rullerzhou-afk/clawd-on-desk/releases/tag/${TAG}`,
        );
      }
    } finally {
      cleanup(testFixture);
    }
  });

  it("is byte-for-byte idempotent after normalization", () => {
    const testFixture = fixture();
    try {
      const input = {
        architectureContract: testFixture.contractPath,
        generatedRoot: testFixture.generatedRoot,
        releaseTag: TAG,
      };
      assert.deepEqual(normalizeAndVerifyGeneratedManifest(input).errors, []);
      const first = Object.fromEntries(
        Object.entries(MANIFEST_FILES).map(([type, filename]) => [
          type,
          fs.readFileSync(path.join(testFixture.manifestDirectory, filename)),
        ]),
      );
      assert.deepEqual(normalizeAndVerifyGeneratedManifest(input).errors, []);
      for (const [type, filename] of Object.entries(MANIFEST_FILES)) {
        assert.deepEqual(
          fs.readFileSync(path.join(testFixture.manifestDirectory, filename)),
          first[type],
        );
      }
    } finally {
      cleanup(testFixture);
    }
  });

  it("rejects a missing architecture/scope entry without partially normalizing files", () => {
    const testFixture = fixture({
      mutateDocuments(documents) {
        documents.installer.Installers.pop();
      },
    });
    try {
      const before = fs.readFileSync(
        path.join(testFixture.manifestDirectory, MANIFEST_FILES.defaultLocale),
        "utf8",
      );
      const report = normalizeAndVerifyGeneratedManifest({
        architectureContract: testFixture.contractPath,
        generatedRoot: testFixture.generatedRoot,
        releaseTag: TAG,
      });
      assert.ok(report.errors.some((error) => error.includes("exactly four entries")));
      assert.equal(
        fs.readFileSync(
          path.join(testFixture.manifestDirectory, MANIFEST_FILES.defaultLocale),
          "utf8",
        ),
        before,
      );
    } finally {
      cleanup(testFixture);
    }
  });

  it("rejects a manifest hash that disagrees with the release architecture contract", () => {
    const testFixture = fixture({
      mutateDocuments(documents) {
        documents.installer.Installers[0].InstallerSha256 = "C".repeat(64);
      },
    });
    try {
      const report = normalizeAndVerifyGeneratedManifest({
        architectureContract: testFixture.contractPath,
        generatedRoot: testFixture.generatedRoot,
        releaseTag: TAG,
      });
      assert.ok(report.errors.some((error) => error.includes("InstallerSha256")));
    } finally {
      cleanup(testFixture);
    }
  });

  it("rejects an architecture contract that did not pass its own gate", () => {
    const testFixture = fixture({
      mutateContract(contract) {
        contract.errors.push("upstream gate failed");
      },
    });
    try {
      const report = normalizeAndVerifyGeneratedManifest({
        architectureContract: testFixture.contractPath,
        generatedRoot: testFixture.generatedRoot,
        releaseTag: TAG,
      });
      assert.ok(report.errors.some((error) => error.includes("empty errors array")));
    } finally {
      cleanup(testFixture);
    }
  });

  it("rejects any extra file in the generated artifact", () => {
    const testFixture = fixture({ extraFile: "unexpected.txt" });
    try {
      const report = normalizeAndVerifyGeneratedManifest({
        architectureContract: testFixture.contractPath,
        generatedRoot: testFixture.generatedRoot,
        releaseTag: TAG,
      });
      assert.ok(report.errors.some((error) => error.includes("exactly the four expected")));
    } finally {
      cleanup(testFixture);
    }
  });

  it("rejects installer-level overrides and unknown root keys", () => {
    const testFixture = fixture({
      mutateDocuments(documents) {
        documents.installer.Installers[0].InstallerType = "msi";
        documents.installer.Commands = ["clawd"];
      },
    });
    try {
      const report = normalizeAndVerifyGeneratedManifest({
        architectureContract: testFixture.contractPath,
        generatedRoot: testFixture.generatedRoot,
        releaseTag: TAG,
      });
      assert.ok(report.errors.some((error) => error.includes("installer contains unsupported keys: Commands")));
      assert.ok(
        report.errors.some((error) =>
          error.includes("installer.Installers[0] contains unsupported keys: InstallerType"),
        ),
      );
    } finally {
      cleanup(testFixture);
    }
  });

  it("rejects unknown locale and nested switch keys", () => {
    const testFixture = fixture({
      mutateDocuments(documents) {
        documents.locale.Agreements = [{ AgreementLabel: "unexpected" }];
        documents.installer.Installers[1].InstallerSwitches.Silent = "/S";
      },
    });
    try {
      const report = normalizeAndVerifyGeneratedManifest({
        architectureContract: testFixture.contractPath,
        generatedRoot: testFixture.generatedRoot,
        releaseTag: TAG,
      });
      assert.ok(report.errors.some((error) => error.includes("locale contains unsupported keys")));
      assert.ok(
        report.errors.some((error) =>
          error.includes("installer.Installers[1].InstallerSwitches contains unsupported keys"),
        ),
      );
    } finally {
      cleanup(testFixture);
    }
  });

  it("reports a malformed architecture digest without throwing", () => {
    const testFixture = fixture({
      mutateContract(contract) {
        contract.installers[0].digest = null;
      },
    });
    try {
      const report = normalizeAndVerifyGeneratedManifest({
        architectureContract: testFixture.contractPath,
        generatedRoot: testFixture.generatedRoot,
        releaseTag: TAG,
      });
      assert.ok(report.errors.some((error) => error.includes("digest is not sha256")));
      assert.ok(report.errors.some((error) => error.includes("must contain exactly arm64, x64")));
    } finally {
      cleanup(testFixture);
    }
  });
});

describe("generated WinGet manifest CLI", () => {
  it("parses every supported option and rejects unknown arguments", () => {
    assert.deepEqual(
      parseArgs([
        "--architecture-contract", "contract.json",
        "--generated-root", "generated",
        "--output", "report.json",
        "--release-tag", TAG,
      ]),
      {
        architectureContract: "contract.json",
        generatedRoot: "generated",
        output: "report.json",
        releaseTag: TAG,
      },
    );
    assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
  });

  it("writes a successful JSON evidence report", () => {
    const testFixture = fixture();
    try {
      const output = path.join(testFixture.root, "report.json");
      const code = runCli([
        "--architecture-contract", testFixture.contractPath,
        "--generated-root", testFixture.generatedRoot,
        "--release-tag", TAG,
        "--output", output,
      ]);
      assert.equal(code, 0);
      const report = JSON.parse(fs.readFileSync(output, "utf8"));
      assert.equal(report.schemaVersion, 1);
      assert.deepEqual(report.errors, []);
      assert.equal(Object.keys(report.fileDigests).length, 4);
    } finally {
      cleanup(testFixture);
    }
  });
});
