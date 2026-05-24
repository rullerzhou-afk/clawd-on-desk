"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  FETCH_COMMAND,
  DEFAULT_RELEASE,
  PINNED_CHECKSUMS,
  archiveName,
  binaryChecksumName,
  releaseAssetUrl,
  targetBinaryPath,
  checksumFor,
  selectTargets,
  buildReleaseManifest,
  parseChecksums,
  sha256,
  extractZipEntry,
  extractTarGzEntry,
  fetchSidecarBinaries,
} = require("../scripts/fetch-sidecar-binaries");

test("release source is pinned to the public Clawd fork tag", () => {
  assert.deepEqual(DEFAULT_RELEASE, {
    owner: "rullerzhou-afk",
    repo: "cc-connect-clawd",
    tag: "clawd-sidecar-v0.1.1",
  });
  assert.equal(
    checksumFor("cc-connect-clawd-windows-x64.zip"),
    "afb79e68f1cc12f33c74500c2596ec3eeb6b92d9ccf86afbe741d0cf41b12c1e"
  );
  assert.equal(
    releaseAssetUrl("cc-connect-clawd-windows-x64.zip"),
    "https://github.com/rullerzhou-afk/cc-connect-clawd/releases/download/clawd-sidecar-v0.1.1/cc-connect-clawd-windows-x64.zip"
  );
});

test("package exposes the sidecar fetch command", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.scripts["fetch:sidecars"], FETCH_COMMAND);
});

test("manifest maps archives and install paths to Clawd sidecar layout", () => {
  const rootDir = "D:\\repo";
  const manifest = buildReleaseManifest({ rootDir, target: "windows-x64,linux-x64" });
  assert.deepEqual(manifest.targets.map((target) => target.dir), ["windows-x64", "linux-x64"]);
  assert.equal(manifest.targets[0].archive, "cc-connect-clawd-windows-x64.zip");
  assert.equal(manifest.targets[0].archiveSha256, PINNED_CHECKSUMS["cc-connect-clawd-windows-x64.zip"]);
  assert.equal(manifest.targets[0].binaryChecksumName, "windows-x64/cc-connect-clawd.exe");
  assert.equal(manifest.targets[0].binarySha256, PINNED_CHECKSUMS["windows-x64/cc-connect-clawd.exe"]);
  assert.equal(
    manifest.targets[0].binaryPath,
    path.join(rootDir, "bin", "cc-connect-clawd", "windows-x64", "cc-connect-clawd.exe")
  );
});

test("pinned checksums cover every release target", () => {
  const manifest = buildReleaseManifest();
  assert.equal(manifest.targets.length, 5);
  for (const target of manifest.targets) {
    assert.match(target.archiveSha256, /^[a-f0-9]{64}$/);
    assert.match(target.binarySha256, /^[a-f0-9]{64}$/);
  }
});

test("selectTargets dedupes and rejects Go arch directory names", () => {
  assert.deepEqual(selectTargets("windows-x64,windows-x64").map((target) => target.dir), ["windows-x64"]);
  assert.throws(() => selectTargets("windows-amd64"), /Unsupported sidecar target/);
});

test("parseChecksums accepts release checksum format and rejects unsafe names", () => {
  const checksums = parseChecksums(`${"a".repeat(64)}  windows-x64/cc-connect-clawd.exe\n`);
  assert.equal(checksums.get("windows-x64/cc-connect-clawd.exe"), "a".repeat(64));
  assert.throws(() => parseChecksums(`${"b".repeat(64)}  ../secret\n`), /Unsafe checksum path/);
});

test("extractZipEntry reads the single sidecar executable", () => {
  const data = Buffer.from("windows binary");
  const archive = makeZip("cc-connect-clawd.exe", data);
  assert.deepEqual(extractZipEntry(archive, "cc-connect-clawd.exe"), data);
  assert.throws(() => extractZipEntry(archive, "missing.exe"), /missing/);
});

test("extractTarGzEntry reads the single sidecar executable", () => {
  const data = Buffer.from("linux binary");
  const archive = makeTarGz("cc-connect-clawd", data);
  assert.deepEqual(extractTarGzEntry(archive, "cc-connect-clawd"), data);
  assert.throws(() => extractTarGzEntry(archive, "missing"), /missing/);
});

test("fetchSidecarBinaries downloads, verifies, extracts, and installs selected target", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-sidecars-"));
  const release = { owner: "owner", repo: "repo", tag: "tag" };
  const target = selectTargets("windows-x64")[0];
  const binary = Buffer.from("verified windows binary");
  const archive = makeZip(target.exe, binary);
  const checksums = [
    `${sha256(archive)}  ${archiveName(target)}`,
    `${sha256(binary)}  ${binaryChecksumName(target)}`,
    "",
  ].join("\n");
  const pinnedChecksums = Object.fromEntries(parseChecksums(checksums));
  const downloads = new Map([
    [releaseAssetUrl(archiveName(target), release), archive],
  ]);

  const result = await fetchSidecarBinaries({
    rootDir,
    release,
    target: "windows-x64",
    checksums: pinnedChecksums,
    download: async (url) => {
      if (!downloads.has(url)) throw new Error(`unexpected download: ${url}`);
      return downloads.get(url);
    },
  });

  const installed = targetBinaryPath(rootDir, target);
  assert.equal(result.installed.length, 1);
  assert.equal(fs.readFileSync(installed, "utf8"), "verified windows binary");
});

test("fetchSidecarBinaries fails closed on checksum mismatch", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-sidecars-"));
  const release = { owner: "owner", repo: "repo", tag: "tag" };
  const target = selectTargets("windows-x64")[0];
  const binary = Buffer.from("verified windows binary");
  const archive = makeZip(target.exe, binary);
  const checksums = [
    `${"0".repeat(64)}  ${archiveName(target)}`,
    `${sha256(binary)}  ${binaryChecksumName(target)}`,
    "",
  ].join("\n");
  const pinnedChecksums = Object.fromEntries(parseChecksums(checksums));

  await assert.rejects(
    fetchSidecarBinaries({
      rootDir,
      release,
      target: "windows-x64",
      checksums: pinnedChecksums,
      download: async (url) => {
        return archive;
      },
    }),
    /Checksum mismatch/
  );
  assert.equal(fs.existsSync(targetBinaryPath(rootDir, target)), false);
});

test("fetchSidecarBinaries dry-run does not download", async () => {
  const result = await fetchSidecarBinaries({
    dryRun: true,
    target: "darwin-arm64",
    download: async () => {
      throw new Error("download should not be called");
    },
  });
  assert.equal(result.installed.length, 0);
  assert.equal(result.manifest.targets[0].dir, "darwin-arm64");
});

function makeZip(name, data) {
  const nameBuffer = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  const localOffset = 0;
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(localOffset, 42);

  const centralOffset = local.length + nameBuffer.length + data.length;
  const centralSize = central.length + nameBuffer.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([local, nameBuffer, data, central, nameBuffer, eocd]);
}

function makeTarGz(name, data) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000755\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(octal(data.length, 11) + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("0", 156, 1, "ascii");
  const padding = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return zlib.gzipSync(Buffer.concat([header, data, padding, Buffer.alloc(1024)]));
}

function octal(value, width) {
  return value.toString(8).padStart(width, "0");
}
