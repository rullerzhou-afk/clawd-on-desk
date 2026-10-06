"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const {
  parseUpdaterYaml,
  sha512Base64,
  validateContractShape,
  verifyUpdaterMetadata,
  parseArgs,
} = require("../scripts/verify-updater-metadata");
const CURRENT_VERSION = require("../package.json").version;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-updater-metadata-"));
}

function writeArtifact(root, name, content) {
  const filename = path.join(root, name);
  fs.writeFileSync(filename, content);
  return {
    name,
    size: fs.statSync(filename).size,
    sha512: sha512Base64(filename),
  };
}

function writeBlockmap(root, zipName, value = { version: "2", files: [{ name: "file", offset: 0, checksums: ["abc"], sizes: [3] }] }) {
  const name = `${zipName}.blockmap`;
  fs.writeFileSync(path.join(root, name), zlib.gzipSync(Buffer.from(JSON.stringify(value))));
  return name;
}

function writeMacFixture(root) {
  const x64Zip = writeArtifact(root, `Clawd-on-Desk-${CURRENT_VERSION}-x64.zip`, "x64-zip");
  const arm64Zip = writeArtifact(root, `Clawd-on-Desk-${CURRENT_VERSION}-arm64.zip`, "arm64-zip");
  const x64Dmg = writeArtifact(root, `Clawd-on-Desk-${CURRENT_VERSION}-x64.dmg`, "x64-dmg");
  const arm64Dmg = writeArtifact(root, `Clawd-on-Desk-${CURRENT_VERSION}-arm64.dmg`, "arm64-dmg");
  writeBlockmap(root, x64Zip.name);
  writeBlockmap(root, arm64Zip.name);
  return {
    x64Zip,
    arm64Zip,
    x64Dmg,
    arm64Dmg,
    // Deliberately not Builder order: verifier must not depend on files[0].
    files: [arm64Dmg, x64Dmg, arm64Zip, x64Zip],
  };
}

function yamlFor(files, topPath, { appImageBlockMap = false, version = CURRENT_VERSION } = {}) {
  const top = files.find((entry) => entry.name === topPath);
  const lines = [`version: ${version}`, "files:"];
  for (const entry of files) {
    lines.push(`  - url: ${entry.name}`);
    lines.push(`    sha512: ${entry.sha512}`);
    lines.push(`    size: ${entry.size}`);
    if (appImageBlockMap && entry.name.endsWith(".AppImage")) lines.push("    blockMapSize: 123");
  }
  lines.push(`path: ${topPath}`);
  lines.push(`sha512: ${top.sha512}`);
  lines.push("releaseDate: '2026-08-02T00:00:00.000Z'");
  return `${lines.join("\n")}\n`;
}

test("minimal updater YAML parser keeps files and top-level path separate", () => {
  const parsed = parseUpdaterYaml([
    "version: 1.2.3",
    "files:",
    "  - url: one.exe",
    "    sha512: abc",
    "    size: 10",
    "path: one.exe",
    "sha512: abc",
  ].join("\n"));
  assert.equal(parsed.version, "1.2.3");
  assert.deepEqual(parsed.files, [{ url: "one.exe", sha512: "abc", size: 10 }]);
  assert.equal(parsed.path, "one.exe");
});

test("Windows dual-architecture updater metadata verifies bytes and hashes", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const x64 = writeArtifact(root, `Clawd-on-Desk-Setup-${CURRENT_VERSION}-x64.exe`, "x64");
  const arm64 = writeArtifact(root, `Clawd-on-Desk-Setup-${CURRENT_VERSION}-arm64.exe`, "arm64");
  const metadata = path.join(root, "latest.yml");
  fs.writeFileSync(metadata, yamlFor([x64, arm64], x64.name));
  const report = verifyUpdaterMetadata({
    metadataPath: metadata,
    artifactRoot: root,
    contract: "windows",
    expectedVersion: CURRENT_VERSION,
  });
  assert.deepEqual(report.errors, []);
  assert.equal(report.files.length, 2);
});

test("macOS contract requires two ZIPs, two DMGs, exact x64 path, and blockmaps", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = writeMacFixture(root);
  const metadata = path.join(root, "latest-mac.yml");
  fs.writeFileSync(metadata, yamlFor(fixture.files, fixture.x64Zip.name));
  const report = verifyUpdaterMetadata({
    metadataPath: metadata,
    artifactRoot: root,
    contract: "mac",
    expectedVersion: CURRENT_VERSION,
  });
  assert.deepEqual(report.errors, []);
  assert.equal(report.files.length, 4);
  assert.equal(report.auxiliaryFiles.length, 2);
});

test("macOS contract rejects DMG-only, missing ZIP, and a DMG top-level path", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = writeMacFixture(root);
  const metadata = path.join(root, "latest-mac.yml");

  fs.writeFileSync(metadata, yamlFor([fixture.x64Dmg, fixture.arm64Dmg], fixture.x64Dmg.name));
  let report = verifyUpdaterMetadata({
    metadataPath: metadata,
    artifactRoot: root,
    contract: "mac",
    expectedVersion: CURRENT_VERSION,
  });
  assert.equal(report.errors.some((error) => /exactly the x64 and arm64 ZIPs and DMGs/.test(error)), true);
  assert.equal(report.errors.some((error) => /exact-version x64 ZIP/.test(error)), true);

  fs.writeFileSync(
    metadata,
    yamlFor([fixture.x64Zip, fixture.x64Dmg, fixture.arm64Dmg], fixture.x64Zip.name),
  );
  report = verifyUpdaterMetadata({
    metadataPath: metadata,
    artifactRoot: root,
    contract: "mac",
    expectedVersion: CURRENT_VERSION,
  });
  assert.equal(report.errors.some((error) => /exactly the x64 and arm64 ZIPs and DMGs/.test(error)), true);

  fs.writeFileSync(metadata, yamlFor(fixture.files, fixture.x64Dmg.name));
  report = verifyUpdaterMetadata({
    metadataPath: metadata,
    artifactRoot: root,
    contract: "mac",
    expectedVersion: CURRENT_VERSION,
  });
  assert.equal(report.errors.some((error) => /exact-version x64 ZIP/.test(error)), true);
});

test("macOS contract independently rejects extra entries and a duplicated architecture", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = writeMacFixture(root);
  const metadata = path.join(root, "latest-mac.yml");

  fs.writeFileSync(
    metadata,
    yamlFor([...fixture.files, fixture.x64Dmg], fixture.x64Zip.name),
  );
  let report = verifyUpdaterMetadata({
    metadataPath: metadata,
    artifactRoot: root,
    contract: "mac",
    expectedVersion: CURRENT_VERSION,
  });
  assert.equal(report.errors.some((error) => /exactly the x64 and arm64 ZIPs and DMGs/.test(error)), true);

  fs.writeFileSync(
    metadata,
    yamlFor(
      [fixture.x64Zip, fixture.x64Zip, fixture.x64Dmg, fixture.arm64Dmg],
      fixture.x64Zip.name,
    ),
  );
  report = verifyUpdaterMetadata({
    metadataPath: metadata,
    artifactRoot: root,
    contract: "mac",
    expectedVersion: CURRENT_VERSION,
  });
  assert.equal(report.errors.some((error) => /exactly the x64 and arm64 ZIPs and DMGs/.test(error)), true);
});

test("macOS contract verifies ZIP bytes, size, and sha512", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = writeMacFixture(root);
  const metadata = path.join(root, "latest-mac.yml");
  fs.writeFileSync(metadata, yamlFor(fixture.files, fixture.x64Zip.name));
  fs.appendFileSync(path.join(root, fixture.arm64Zip.name), "tampered");
  const report = verifyUpdaterMetadata({
    metadataPath: metadata,
    artifactRoot: root,
    contract: "mac",
    expectedVersion: CURRENT_VERSION,
  });
  assert.equal(report.errors.some((error) => /size mismatch/.test(error)), true);
  assert.equal(report.errors.some((error) => /sha512 mismatch/.test(error)), true);
});

test("macOS contract rejects missing, empty, non-gzip, and malformed blockmaps", async (t) => {
  const cases = [
    ["missing", (filename) => fs.rmSync(filename), /does not exist/],
    ["empty", (filename) => fs.writeFileSync(filename, ""), /is empty/],
    ["non-gzip", (filename) => fs.writeFileSync(filename, "{}"), /not valid gzip JSON/],
    ["malformed", (filename) => fs.writeFileSync(filename, zlib.gzipSync(Buffer.from("{}"))), /invalid structure/],
  ];
  for (const [label, mutate, expected] of cases) {
    await t.test(label, (subtest) => {
      const root = tempDir();
      subtest.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const fixture = writeMacFixture(root);
      const metadata = path.join(root, "latest-mac.yml");
      fs.writeFileSync(metadata, yamlFor(fixture.files, fixture.x64Zip.name));
      mutate(path.join(root, `${fixture.arm64Zip.name}.blockmap`));
      const report = verifyUpdaterMetadata({
        metadataPath: metadata,
        artifactRoot: root,
        contract: "mac",
        expectedVersion: CURRENT_VERSION,
      });
      assert.equal(report.errors.some((error) => expected.test(error)), true);
    });
  }
});

test("Linux contract requires AppImage, deb, path, and blockMapSize", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appImage = writeArtifact(root, `Clawd-on-Desk-${CURRENT_VERSION}-x86_64.AppImage`, "appimage");
  const deb = writeArtifact(root, `Clawd-on-Desk-${CURRENT_VERSION}-amd64.deb`, "deb");
  const metadata = path.join(root, "latest-linux.yml");
  fs.writeFileSync(metadata, yamlFor([appImage, deb], appImage.name, { appImageBlockMap: true }));
  assert.deepEqual(
    verifyUpdaterMetadata({
      metadataPath: metadata,
      artifactRoot: root,
      contract: "linux",
      expectedVersion: CURRENT_VERSION,
    }).errors,
    [],
  );
});

test("metadata verification reports missing artifacts and tampered hashes", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const x64 = writeArtifact(root, `Clawd-on-Desk-Setup-${CURRENT_VERSION}-x64.exe`, "x64");
  const arm64 = { name: `Clawd-on-Desk-Setup-${CURRENT_VERSION}-arm64.exe`, size: 10, sha512: "wrong" };
  const metadata = path.join(root, "latest.yml");
  fs.writeFileSync(metadata, yamlFor([x64, arm64], x64.name));
  const report = verifyUpdaterMetadata({
    metadataPath: metadata,
    artifactRoot: root,
    contract: "windows",
    expectedVersion: CURRENT_VERSION,
  });
  assert.equal(report.errors.some((error) => /does not exist/.test(error)), true);
});

test("metadata and every artifact URL must match the expected release version", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const x64 = writeArtifact(root, `Clawd-on-Desk-Setup-${CURRENT_VERSION}-x64.exe`, "x64");
  const arm64 = writeArtifact(root, `Clawd-on-Desk-Setup-${CURRENT_VERSION}-arm64.exe`, "arm64");
  const metadata = path.join(root, "latest.yml");
  fs.writeFileSync(metadata, yamlFor([x64, arm64], x64.name, { version: "0.14.0" }));
  const staleMetadata = verifyUpdaterMetadata({
    metadataPath: metadata,
    artifactRoot: root,
    contract: "windows",
    expectedVersion: CURRENT_VERSION,
  });
  assert.equal(staleMetadata.errors.some((error) => /metadata version/.test(error)), true);

  const staleX64 = writeArtifact(root, "Clawd-on-Desk-Setup-0.14.0-x64.exe", "old-x64");
  const mixedMetadata = path.join(root, "latest-mixed.yml");
  fs.writeFileSync(mixedMetadata, yamlFor([staleX64, arm64], staleX64.name));
  const mixedAssets = verifyUpdaterMetadata({
    metadataPath: mixedMetadata,
    artifactRoot: root,
    contract: "windows",
    expectedVersion: CURRENT_VERSION,
  });
  assert.equal(mixedAssets.errors.some((error) => /Unexpected updater artifact URL/.test(error)), true);
});

test("stable updater contracts reject prerelease or extra version segments exactly", () => {
  const cases = [
    {
      contract: "windows",
      files: [
        { url: `Clawd-on-Desk-Setup-${CURRENT_VERSION}-rc.1-x64.exe` },
        { url: `Clawd-on-Desk-Setup-${CURRENT_VERSION}-arm64.exe` },
      ],
      path: `Clawd-on-Desk-Setup-${CURRENT_VERSION}-rc.1-x64.exe`,
    },
    {
      contract: "mac",
      files: [
        { url: `Clawd-on-Desk-${CURRENT_VERSION}-rc.1-x64.zip` },
        { url: `Clawd-on-Desk-${CURRENT_VERSION}-arm64.zip` },
        { url: `Clawd-on-Desk-${CURRENT_VERSION}-x64.dmg` },
        { url: `Clawd-on-Desk-${CURRENT_VERSION}-arm64.dmg` },
      ],
      path: `Clawd-on-Desk-${CURRENT_VERSION}-rc.1-x64.zip`,
    },
    {
      contract: "linux",
      files: [
        { url: `Clawd-on-Desk-${CURRENT_VERSION}-rc.1-x86_64.AppImage`, blockMapSize: 1 },
        { url: `Clawd-on-Desk-${CURRENT_VERSION}-amd64.deb` },
      ],
      path: `Clawd-on-Desk-${CURRENT_VERSION}-rc.1-x86_64.AppImage`,
    },
  ];

  for (const fixture of cases) {
    const errors = validateContractShape(
      { version: CURRENT_VERSION, files: fixture.files, path: fixture.path },
      fixture.contract,
      CURRENT_VERSION,
    );
    assert.equal(errors.some((error) => /Unexpected updater artifact URL/.test(error)), true);
  }
});

test("updater CLI parser requires metadata, artifact root, contract, and package version authority", () => {
  assert.throws(() => parseArgs([]), /--metadata is required/);
  assert.throws(() => parseArgs(["--metadata", "latest.yml"]), /--artifact-root is required/);
  assert.throws(
    () => parseArgs(["--metadata", "latest.yml", "--artifact-root", "dist"]),
    /--contract is required/,
  );
  assert.throws(
    () => parseArgs(["--metadata", "latest.yml", "--artifact-root", "dist", "--contract", "windows"]),
    /--package-json is required/,
  );
});
