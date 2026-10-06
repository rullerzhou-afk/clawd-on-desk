"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");
const {
  parseNativeBuffer,
  auditPackagedNative,
  getException,
  parseArgs,
  stableJson,
} = require("../scripts/audit-packaged-native");
const policy = require("../scripts/native-package-policy.json");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-native-audit-"));
}

function fakePe(machine) {
  const buffer = Buffer.alloc(256);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write("PE\0\0", 0x80, "binary");
  buffer.writeUInt16LE(machine, 0x84);
  return buffer;
}

function fakeElf(machine, { endian = "little", elfClass = 2 } = {}) {
  const buffer = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(buffer, 0);
  buffer[4] = elfClass;
  buffer[5] = endian === "little" ? 1 : 2;
  if (endian === "little") buffer.writeUInt16LE(machine, 18);
  else buffer.writeUInt16BE(machine, 18);
  return buffer;
}

function fakeMachThin(cpu, littleEndian = true) {
  const buffer = Buffer.alloc(64);
  Buffer.from(littleEndian ? "cffaedfe" : "feedfacf", "hex").copy(buffer, 0);
  if (littleEndian) buffer.writeUInt32LE(cpu, 4);
  else buffer.writeUInt32BE(cpu, 4);
  return buffer;
}

function fakeMachFat(cpus) {
  const buffer = Buffer.alloc(8 + cpus.length * 20);
  Buffer.from("cafebabe", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, index) => buffer.writeUInt32BE(cpu, 8 + index * 20));
  return buffer;
}

async function makeAppRoot(root, targetId, {
  logicalOnlyNative = false,
  unknownKoffiLogical = false,
} = {}) {
  const target = require("../src/native-package-target").getReleaseTarget(targetId);
  const appRoot = target.runtimePlatform === "darwin"
    ? path.join(root, "Clawd on Desk.app")
    : path.join(root, "app");
  const resources = target.runtimePlatform === "darwin"
    ? path.join(appRoot, "Contents", "Resources")
    : path.join(appRoot, "resources");
  const koffiNode = path.join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "koffi",
    "build",
    "koffi",
    target.koffiTriplet,
    "koffi.node",
  );
  fs.mkdirSync(path.dirname(koffiNode), { recursive: true });

  let targetBinary;
  if (target.format === "PE") targetBinary = fakePe(target.architecture === "x64" ? 0x8664 : 0xaa64);
  else if (target.format === "ELF") targetBinary = fakeElf(0x003e);
  else targetBinary = fakeMachThin(target.architecture === "x86_64" ? 0x01000007 : 0x0100000c);
  fs.writeFileSync(koffiNode, targetBinary);
  const executable = target.runtimePlatform === "darwin"
    ? path.join(appRoot, "Contents", "MacOS", "Clawd on Desk")
    : path.join(appRoot, target.runtimePlatform === "win32" ? "Clawd.exe" : "clawd");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, targetBinary);
  if (target.runtimePlatform === "win32") fs.writeFileSync(path.join(resources, "elevate.exe"), fakePe(0x014c));

  const source = path.join(root, "asar-source");
  const logicalNode = path.join(source, "node_modules", "koffi", "build", "koffi", target.koffiTriplet, "koffi.node");
  fs.mkdirSync(path.dirname(logicalNode), { recursive: true });
  fs.writeFileSync(logicalNode, "logical");
  if (logicalOnlyNative) {
    const orphan = path.join(source, "node_modules", "orphan-native", "orphan.node");
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, targetBinary);
  }
  if (unknownKoffiLogical) {
    const unknown = path.join(
      source,
      "node_modules",
      "koffi",
      "build",
      "koffi",
      "evil_triplet",
      "koffi.node",
    );
    fs.mkdirSync(path.dirname(unknown), { recursive: true });
    fs.writeFileSync(unknown, targetBinary);
  }
  await asar.createPackage(source, path.join(resources, "app.asar"));
  return { appRoot, resources, koffiNode, targetBinary };
}

test("native parsers identify PE, ELF, thin Mach-O, and fat Mach-O architectures", () => {
  assert.deepEqual(parseNativeBuffer(fakePe(0x8664)).architectures, ["x64"]);
  assert.deepEqual(parseNativeBuffer(fakePe(0xaa64)).architectures, ["arm64"]);
  assert.deepEqual(parseNativeBuffer(fakeElf(0x003e)).architectures, ["x86_64"]);
  assert.deepEqual(parseNativeBuffer(fakeElf(0x00b7, { endian: "big" })).architectures, ["arm64"]);
  assert.deepEqual(parseNativeBuffer(fakeMachThin(0x01000007)).architectures, ["x86_64"]);
  assert.deepEqual(
    parseNativeBuffer(fakeMachFat([0x01000007, 0x0100000c])).architectures,
    ["x86_64", "arm64"],
  );
  assert.equal(parseNativeBuffer(Buffer.from("plain text")), null);
});

test("malformed native-looking headers fail closed", () => {
  assert.throws(() => parseNativeBuffer(Buffer.from("MZ")), /Truncated PE/);
  assert.throws(() => parseNativeBuffer(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), /Truncated ELF/);
  assert.throws(() => parseNativeBuffer(Buffer.from("cafebabe00000002", "hex")), /Truncated fat Mach-O/);
});

test("Windows audit records the exact elevate exception and one Koffi addon", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makeAppRoot(root, "windows-x64");
  const report = auditPackagedNative({ appRoot: fixture.appRoot, targetId: "windows-x64" });
  assert.deepEqual(report.errors, []);
  assert.equal(report.koffi.physical.length, 1);
  assert.equal(report.koffi.logical.length, 1);
  assert.equal(report.logicalNative.length, 1);
  assert.equal(report.logicalNative[0].disposition, "physical-unpacked");
  assert.equal(report.summary.countByDisposition.exception, 1);
  const elevate = report.binaries.find((entry) => entry.path === "resources/elevate.exe");
  assert.equal(elevate.policyId, "electron-builder-nsis-elevate-helper");
  assert.equal(
    report.binaries.some((entry) => entry.path.includes("\\")),
    false,
    "manifest-relative paths must be POSIX-normalized",
  );
  assert.equal(stableJson(report).endsWith("\n"), true);
});

test("logical native candidates inside app.asar require a physical unpacked payload", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makeAppRoot(root, "windows-x64", { logicalOnlyNative: true });
  const report = auditPackagedNative({ appRoot: fixture.appRoot, targetId: "windows-x64" });
  const orphan = report.logicalNative.find((entry) => /orphan\.node$/.test(entry.path));
  assert.equal(orphan.physicalPresent, false);
  assert.equal(orphan.disposition, "error");
  assert.equal(
    report.errors.some((entry) => entry.code === "logical-native-without-physical-payload"),
    true,
  );
});

test("unknown Koffi logical triplets never receive the known-stale exemption", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makeAppRoot(root, "windows-x64", { unknownKoffiLogical: true });
  const report = auditPackagedNative({ appRoot: fixture.appRoot, targetId: "windows-x64" });
  const unknown = report.logicalNative.find((entry) => /evil_triplet/.test(entry.path));
  assert.equal(unknown.disposition, "error");
  assert.equal(
    report.errors.some((entry) => (
      entry.code === "logical-native-without-physical-payload" && /evil_triplet/.test(entry.path)
    )),
    true,
  );
});

test("zero, duplicate, and wrong-triplet physical Koffi payloads hard-fail", async (t) => {
  const zeroRoot = tempDir();
  const duplicateRoot = tempDir();
  const wrongRoot = tempDir();
  t.after(() => {
    for (const root of [zeroRoot, duplicateRoot, wrongRoot]) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const zero = await makeAppRoot(zeroRoot, "windows-x64");
  fs.rmSync(zero.koffiNode);
  const zeroReport = auditPackagedNative({ appRoot: zero.appRoot, targetId: "windows-x64" });
  assert.equal(zeroReport.errors.some((entry) => entry.code === "unexpected-koffi-native-count"), true);

  const duplicate = await makeAppRoot(duplicateRoot, "windows-x64");
  const duplicateNode = path.join(
    duplicate.resources,
    "app.asar.unpacked",
    "node_modules",
    "koffi",
    "build",
    "koffi",
    "win32_arm64",
    "koffi.node",
  );
  fs.mkdirSync(path.dirname(duplicateNode), { recursive: true });
  fs.copyFileSync(duplicate.koffiNode, duplicateNode);
  const duplicateReport = auditPackagedNative({ appRoot: duplicate.appRoot, targetId: "windows-x64" });
  assert.equal(duplicateReport.errors.some((entry) => entry.code === "unexpected-koffi-native-count"), true);

  const wrong = await makeAppRoot(wrongRoot, "windows-x64");
  const wrongNode = path.join(
    wrong.resources,
    "app.asar.unpacked",
    "node_modules",
    "koffi",
    "build",
    "koffi",
    "win32_arm64",
    "koffi.node",
  );
  fs.mkdirSync(path.dirname(wrongNode), { recursive: true });
  fs.renameSync(wrong.koffiNode, wrongNode);
  const wrongReport = auditPackagedNative({ appRoot: wrong.appRoot, targetId: "windows-x64" });
  assert.equal(wrongReport.errors.some((entry) => entry.code === "wrong-koffi-native-target"), true);
});

test("macOS audit reads app.asar from Contents/Resources", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makeAppRoot(root, "darwin-x64");
  const report = auditPackagedNative({ appRoot: fixture.appRoot, targetId: "darwin-x64" });
  assert.deepEqual(report.errors, []);
  assert.equal(report.koffi.logical.length, 1);
  assert.match(report.koffi.physical[0], /^Contents\/Resources\/app\.asar\.unpacked\//);
});

test("foreign binaries and wrong Koffi triplets hard-fail", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makeAppRoot(root, "windows-x64");
  fs.writeFileSync(path.join(fixture.resources, "foreign.exe"), fakePe(0xaa64));
  const report = auditPackagedNative({ appRoot: fixture.appRoot, targetId: "windows-x64" });
  assert.equal(report.errors.some((entry) => entry.code === "foreign-native-binary"), true);
  assert.equal(report.binaries.find((entry) => entry.path === "resources/foreign.exe").disposition, "error");
});

test("near-miss elevate helpers never receive the exception", () => {
  const parsed = parseNativeBuffer(fakePe(0x014c));
  assert.equal(getException(policy, "windows-x64", "resources/elevate.exe", parsed).id, "electron-builder-nsis-elevate-helper");
  assert.equal(getException(policy, "windows-x64", "other/elevate.exe", parsed), null);
  assert.equal(getException(policy, "darwin-x64", "resources/elevate.exe", parsed), null);
  assert.equal(getException(policy, "windows-x64", "resources/Elevate.exe", parsed), null);
  assert.equal(getException(policy, "windows-x64", "resources/elevate.exe", parseNativeBuffer(fakePe(0x8664))), null);
});

test("audit CLI parser requires explicit app root and target", () => {
  assert.throws(() => parseArgs([]), /--app-root is required/);
  assert.throws(() => parseArgs(["--app-root", "dist/app"]), /--target is required/);
  assert.throws(() => parseArgs(["--wat"]), /Unknown argument/);
  assert.deepEqual(
    parseArgs(["--app-root", "dist/app", "--target", "linux-x64", "--output", "out.json"]),
    { appRoot: "dist/app", targetId: "linux-x64", output: "out.json" },
  );
});
