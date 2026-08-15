"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");
const {
  KOFFI_2163_TRIPLETS,
  isInside,
  pruneKoffiNative,
} = require("../scripts/after-pack-koffi");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-koffi-prune-"));
}

function fakePe(machine) {
  const buffer = Buffer.alloc(256);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write("PE\0\0", 0x80, "binary");
  buffer.writeUInt16LE(machine, 0x84);
  return buffer;
}

function fakeElf(machine) {
  const buffer = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(buffer, 0);
  buffer[4] = 2;
  buffer[5] = 1;
  buffer.writeUInt16LE(machine, 18);
  return buffer;
}

function fakeMach(cpu) {
  const buffer = Buffer.alloc(64);
  Buffer.from("cffaedfe", "hex").copy(buffer, 0);
  buffer.writeUInt32LE(cpu, 4);
  return buffer;
}

function nativeForTarget(targetId) {
  if (targetId === "windows-x64") return fakePe(0x8664);
  if (targetId === "windows-arm64") return fakePe(0xaa64);
  if (targetId === "linux-x64") return fakeElf(0x003e);
  if (targetId === "darwin-x64") return fakeMach(0x01000007);
  if (targetId === "darwin-arm64") return fakeMach(0x0100000c);
  throw new Error(`Unsupported fixture target: ${targetId}`);
}

async function makePackagedKoffi(root, targetId) {
  const target = require("../src/native-package-target").getReleaseTarget(targetId);
  const appOutDir = target.runtimePlatform === "darwin" ? path.join(root, "out") : path.join(root, "app");
  const appRoot = target.runtimePlatform === "darwin"
    ? path.join(appOutDir, "Clawd on Desk.app")
    : appOutDir;
  const resources = target.runtimePlatform === "darwin"
    ? path.join(appRoot, "Contents", "Resources")
    : path.join(appRoot, "resources");
  const unpackedKoffi = path.join(resources, "app.asar.unpacked", "node_modules", "koffi");
  const nativeRoot = path.join(unpackedKoffi, "build", "koffi");
  fs.mkdirSync(nativeRoot, { recursive: true });
  fs.writeFileSync(path.join(unpackedKoffi, "package.json"), JSON.stringify({ version: "2.16.3" }));

  const targetTriplet = target.koffiTriplet;
  for (const triplet of KOFFI_2163_TRIPLETS) {
    const tripletDir = path.join(nativeRoot, triplet);
    fs.mkdirSync(tripletDir, { recursive: true });
    fs.writeFileSync(
      path.join(tripletDir, "koffi.node"),
      triplet === targetTriplet ? nativeForTarget(targetId) : Buffer.from("foreign"),
    );
    if (triplet.startsWith("win32_")) {
      fs.writeFileSync(path.join(tripletDir, "koffi.lib"), "lib");
      fs.writeFileSync(path.join(tripletDir, "koffi.exp"), "exp");
    }
  }

  const asarSource = path.join(root, "asar-source");
  for (const triplet of KOFFI_2163_TRIPLETS) {
    const filename = path.join(asarSource, "node_modules", "koffi", "build", "koffi", triplet, "koffi.node");
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "logical");
  }
  await asar.createPackage(asarSource, path.join(resources, "app.asar"));
  return { appOutDir, appRoot, resources, nativeRoot, targetTriplet };
}

test("afterPack prune keeps one target addon and removes every lib/exp", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makePackagedKoffi(root, "windows-x64");
  const output = path.join(root, "manifests", "windows-x64.json");
  const report = pruneKoffiNative({
    appOutDir: fixture.appRoot,
    targetId: "windows-x64",
    outputPath: output,
  });

  assert.equal(report.summary.tripletsBefore, 18);
  assert.equal(report.summary.tripletsAfter, 1);
  assert.equal(report.logicalKoffiNativeEntries.length, 18, "afterPack must not rewrite app.asar");
  assert.deepEqual(fs.readdirSync(fixture.nativeRoot), [fixture.targetTriplet]);
  assert.deepEqual(fs.readdirSync(path.join(fixture.nativeRoot, fixture.targetTriplet)), ["koffi.node"]);
  assert.equal(report.retained.format, "PE");
  assert.deepEqual(report.retained.architectures, ["x64"]);
  assert.equal(fs.existsSync(output), true);
});

test("afterPack containment checks canonicalize parent path aliases", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actualRoot = path.join(root, "actual");
  const aliasRoot = path.join(root, "alias");
  fs.mkdirSync(actualRoot);
  fs.symlinkSync(actualRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");

  const fixture = await makePackagedKoffi(aliasRoot, "windows-x64");
  const report = pruneKoffiNative({
    appOutDir: fixture.appRoot,
    targetId: "windows-x64",
  });

  assert.equal(report.retained.format, "PE");
  assert.deepEqual(fs.readdirSync(fixture.nativeRoot), [fixture.targetTriplet]);
});

test("afterPack prune supports the Linux target without a platform exception", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makePackagedKoffi(root, "linux-x64");
  const report = pruneKoffiNative({ appOutDir: fixture.appRoot, targetId: "linux-x64" });
  assert.equal(report.retained.format, "ELF");
  assert.deepEqual(report.retained.architectures, ["x86_64"]);
  assert.deepEqual(fs.readdirSync(fixture.nativeRoot), ["linux_x64"]);
});

test("afterPack prune resolves a macOS app bundle and retains a thin Mach-O target", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makePackagedKoffi(root, "darwin-x64");
  const report = pruneKoffiNative({ appOutDir: fixture.appOutDir, targetId: "darwin-x64" });
  assert.equal(report.appRoot, path.resolve(fixture.appRoot));
  assert.equal(report.retained.format, "Mach-O");
  assert.deepEqual(report.retained.architectures, ["x86_64"]);
  assert.deepEqual(fs.readdirSync(fixture.nativeRoot), ["darwin_x64"]);
});

test("prune fails closed on unknown layout and wrong version", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makePackagedKoffi(root, "windows-x64");
  fs.mkdirSync(path.join(fixture.nativeRoot, "unexpected_triplet"));
  assert.throws(
    () => pruneKoffiNative({ appOutDir: fixture.appRoot, targetId: "windows-x64" }),
    /Unexpected Koffi 2\.16\.3 triplet layout/,
  );
  fs.rmSync(path.join(fixture.nativeRoot, "unexpected_triplet"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.resources, "app.asar.unpacked", "node_modules", "koffi", "package.json"),
    JSON.stringify({ version: "2.15.2" }),
  );
  assert.throws(
    () => pruneKoffiNative({ appOutDir: fixture.appRoot, targetId: "windows-x64" }),
    /unexpected Koffi version/i,
  );
});

test("prune validates the retained architecture before deleting foreign triplets", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makePackagedKoffi(root, "windows-x64");
  fs.writeFileSync(path.join(fixture.nativeRoot, fixture.targetTriplet, "koffi.node"), fakePe(0xaa64));
  assert.throws(
    () => pruneKoffiNative({ appOutDir: fixture.appRoot, targetId: "windows-x64" }),
    /wrong architecture/i,
  );
  assert.equal(fs.readdirSync(fixture.nativeRoot).length, KOFFI_2163_TRIPLETS.length);
});

test("prune manifest is never written back inside the staged app", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makePackagedKoffi(root, "windows-x64");
  assert.throws(
    () => pruneKoffiNative({
      appOutDir: fixture.appRoot,
      targetId: "windows-x64",
      outputPath: path.join(fixture.appRoot, "manifest.json"),
    }),
    /manifest must be outside appOutDir/i,
  );
});

test("prune rejects junctions/reparse points before deleting anything", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makePackagedKoffi(root, "windows-x64");
  const foreign = path.join(fixture.nativeRoot, "darwin_arm64");
  fs.rmSync(foreign, { recursive: true });
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  fs.symlinkSync(outside, foreign, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => pruneKoffiNative({ appOutDir: fixture.appRoot, targetId: "windows-x64" }),
    /non-directory or link|symlink\/reparse/i,
  );
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
});

test("inside checks reject sibling-prefix and parent escapes", () => {
  const base = path.resolve("C:/tmp/app");
  assert.equal(isInside(base, path.join(base, "resources")), true);
  assert.equal(isInside(base, path.resolve("C:/tmp/app-other")), false);
  assert.equal(isInside(base, path.resolve("C:/tmp")), false);
});
