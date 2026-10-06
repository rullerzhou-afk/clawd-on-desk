#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const { getReleaseTarget } = require("../src/native-package-target");
const { KOFFI_TRIPLET_SET } = require("../src/koffi-package-contract");
const defaultPolicy = require("./native-package-policy.json");

const PE_MACHINES = new Map([
  [0x014c, "ia32"],
  [0x8664, "x64"],
  [0xaa64, "arm64"],
]);

const ELF_MACHINES = new Map([
  [0x0003, "ia32"],
  [0x003e, "x86_64"],
  [0x00b7, "arm64"],
]);

const MACH_CPU_TYPES = new Map([
  [0x00000007, "ia32"],
  [0x01000007, "x86_64"],
  [0x0000000c, "arm"],
  [0x0100000c, "arm64"],
]);

const KOFFI_NATIVE_PATH_RE = /(?:^|\/)node_modules\/koffi\/build\/koffi\/([^/]+)\/koffi\.node$/i;
const LOGICAL_NATIVE_CANDIDATE_RE = /(?:\.node|\.dll|\.exe|\.dylib|\.so(?:\.\d+)*)$/i;

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filename));
  return hash.digest("hex");
}

function readPrefix(filename, length = 4096) {
  const fd = fs.openSync(filename, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function machineName(mapping, value) {
  return mapping.get(value) || `unknown-0x${value.toString(16)}`;
}

function parsePe(buffer) {
  if (buffer.length < 2 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null;
  if (buffer.length < 0x40) throw new Error("Truncated PE DOS header");
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset > 16 * 1024 * 1024) throw new Error(`Implausible PE header offset: ${peOffset}`);
  if (buffer.length < peOffset + 6) throw new Error("Truncated PE signature/header");
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) throw new Error("Invalid PE signature");
  const machine = buffer.readUInt16LE(peOffset + 4);
  return {
    format: "PE",
    architectures: [machineName(PE_MACHINES, machine)],
    machineValues: [machine],
  };
}

function parseElf(buffer) {
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return null;
  if (buffer.length < 20) throw new Error("Truncated ELF header");
  const elfClass = buffer[4];
  const dataEncoding = buffer[5];
  if (elfClass !== 1 && elfClass !== 2) throw new Error(`Unsupported ELF class: ${elfClass}`);
  if (dataEncoding !== 1 && dataEncoding !== 2) throw new Error(`Unsupported ELF endianness: ${dataEncoding}`);
  const machine = dataEncoding === 1 ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18);
  return {
    format: "ELF",
    architectures: [machineName(ELF_MACHINES, machine)],
    machineValues: [machine],
    class: elfClass === 2 ? "64" : "32",
    endianness: dataEncoding === 1 ? "little" : "big",
  };
}

function readMachCpu(buffer, offset, littleEndian) {
  if (buffer.length < offset + 4) throw new Error("Truncated Mach-O CPU field");
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function parseMachO(buffer) {
  if (buffer.length < 4) return null;
  const bytes = buffer.subarray(0, 4).toString("hex");
  const thinMagics = new Map([
    ["cefaedfe", { littleEndian: true, bits: 32 }],
    ["cffaedfe", { littleEndian: true, bits: 64 }],
    ["feedface", { littleEndian: false, bits: 32 }],
    ["feedfacf", { littleEndian: false, bits: 64 }],
  ]);
  const fatMagics = new Map([
    ["cafebabe", { littleEndian: false, entrySize: 20, bits: 32 }],
    ["bebafeca", { littleEndian: true, entrySize: 20, bits: 32 }],
    ["cafebabf", { littleEndian: false, entrySize: 32, bits: 64 }],
    ["bfbafeca", { littleEndian: true, entrySize: 32, bits: 64 }],
  ]);

  const thin = thinMagics.get(bytes);
  if (thin) {
    const cpu = readMachCpu(buffer, 4, thin.littleEndian);
    return {
      format: "Mach-O",
      architectures: [machineName(MACH_CPU_TYPES, cpu)],
      machineValues: [cpu],
      kind: "thin",
      bits: thin.bits,
    };
  }

  const fat = fatMagics.get(bytes);
  if (!fat) return null;
  if (buffer.length < 8) throw new Error("Truncated fat Mach-O header");
  const count = fat.littleEndian ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
  if (count < 1 || count > 64) throw new Error(`Implausible fat Mach-O slice count: ${count}`);
  const required = 8 + count * fat.entrySize;
  if (buffer.length < required) throw new Error("Truncated fat Mach-O architecture table");
  const machineValues = [];
  for (let index = 0; index < count; index += 1) {
    machineValues.push(readMachCpu(buffer, 8 + index * fat.entrySize, fat.littleEndian));
  }
  return {
    format: "Mach-O",
    architectures: machineValues.map((cpu) => machineName(MACH_CPU_TYPES, cpu)),
    machineValues,
    kind: "fat",
    bits: fat.bits,
  };
}

function parseNativeBuffer(buffer) {
  return parsePe(buffer) || parseElf(buffer) || parseMachO(buffer);
}

function parseNativeFile(filename) {
  let buffer = readPrefix(filename);
  if (buffer.length >= 0x40 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset <= 16 * 1024 * 1024 && peOffset + 6 > buffer.length) {
      buffer = readPrefix(filename, peOffset + 6);
    }
  }
  return parseNativeBuffer(buffer);
}

function walkPhysicalFiles(rootDir) {
  const root = path.resolve(rootDir);
  const files = [];

  function visit(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(root, absolutePath));
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(absolutePath);
      } else if (stat.isFile()) {
        files.push({ absolutePath, relativePath, bytes: stat.size });
      }
    }
  }

  visit(root);
  return files;
}

function getException(policy, targetId, relativePath, parsed) {
  const exceptions = policy && Array.isArray(policy.exceptions) ? policy.exceptions : [];
  return exceptions.find((entry) => (
    Array.isArray(entry.targets) && entry.targets.includes(targetId) &&
    toPosix(entry.path) === relativePath &&
    entry.format === parsed.format &&
    Array.isArray(entry.architectures) &&
    entry.architectures.length === parsed.architectures.length &&
    entry.architectures.every((arch) => parsed.architectures.includes(arch))
  )) || null;
}

function resourcesRootForTarget(appRoot, target) {
  return target.runtimePlatform === "darwin"
    ? path.join(appRoot, "Contents", "Resources")
    : path.join(appRoot, "resources");
}

function listLogicalNativeEntries(appRoot, target, asarModule = asar) {
  const archivePath = path.join(resourcesRootForTarget(appRoot, target), "app.asar");
  if (!fs.existsSync(archivePath)) throw new Error(`Required app.asar does not exist: ${archivePath}`);
  const resourcesRoot = resourcesRootForTarget(appRoot, target);
  const unpackedRoot = path.join(resourcesRoot, "app.asar.unpacked");
  return asarModule.listPackage(archivePath)
    .map(toPosix)
    .filter((entry) => LOGICAL_NATIVE_CANDIDATE_RE.test(entry))
    .map((logicalPath) => {
      const archiveRelativePath = logicalPath.replace(/^\/+/, "");
      const physicalPath = path.join(unpackedRoot, ...archiveRelativePath.split("/"));
      let physicalPresent = false;
      if (fs.existsSync(physicalPath)) {
        const stat = fs.lstatSync(physicalPath);
        physicalPresent = stat.isFile() && !stat.isSymbolicLink();
      }
      const koffiMatch = logicalPath.match(KOFFI_NATIVE_PATH_RE);
      let disposition = physicalPresent ? "physical-unpacked" : "error";
      if (!physicalPresent && koffiMatch &&
          KOFFI_TRIPLET_SET.has(koffiMatch[1]) && koffiMatch[1] !== target.koffiTriplet) {
        disposition = "stale-koffi-logical";
      }
      return {
        path: logicalPath,
        physicalPath: toPosix(path.relative(appRoot, physicalPath)),
        physicalPresent,
        disposition,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function listLogicalKoffiEntries(appRoot, target, asarModule = asar) {
  return listLogicalNativeEntries(appRoot, target, asarModule)
    .filter((entry) => KOFFI_NATIVE_PATH_RE.test(entry.path))
    .map((entry) => entry.path);
}

function auditPackagedNative({ appRoot, targetId, policy = defaultPolicy, asarModule = asar } = {}) {
  if (!appRoot) throw new TypeError("appRoot is required");
  const target = getReleaseTarget(targetId);
  const resolvedRoot = path.resolve(appRoot);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`App root is not a directory: ${resolvedRoot}`);
  }

  const binaries = [];
  const errors = [];
  for (const file of walkPhysicalFiles(resolvedRoot)) {
    let parsed;
    try {
      parsed = parseNativeFile(file.absolutePath);
    } catch (err) {
      errors.push({
        code: "malformed-native-binary",
        path: file.relativePath,
        message: err && err.message ? err.message : String(err),
      });
      continue;
    }
    if (!parsed) continue;

    const exception = getException(policy, target.id, file.relativePath, parsed);
    const matchesTarget = parsed.format === target.format &&
      parsed.architectures.every((arch) => arch === target.architecture);
    let disposition = "target";
    let policyId = null;
    let reason = null;
    if (exception) {
      disposition = "exception";
      policyId = exception.id;
      reason = exception.reason;
    } else if (!matchesTarget) {
      disposition = "error";
      errors.push({
        code: "foreign-native-binary",
        path: file.relativePath,
        expected: `${target.format}/${target.architecture}`,
        actual: `${parsed.format}/${parsed.architectures.join(",")}`,
      });
    }
    binaries.push({
      path: file.relativePath,
      bytes: file.bytes,
      sha256: sha256File(file.absolutePath),
      format: parsed.format,
      architectures: parsed.architectures,
      disposition,
      policyId,
      reason,
    });
  }

  binaries.sort((a, b) => a.path.localeCompare(b.path));
  errors.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));

  const physicalKoffi = binaries.filter((entry) => KOFFI_NATIVE_PATH_RE.test(entry.path));
  const logicalNative = listLogicalNativeEntries(resolvedRoot, target, asarModule);
  const logicalKoffi = logicalNative
    .filter((entry) => KOFFI_NATIVE_PATH_RE.test(entry.path))
    .map((entry) => entry.path);
  for (const entry of logicalNative) {
    if (entry.disposition === "error") {
      errors.push({
        code: "logical-native-without-physical-payload",
        path: entry.path,
        expectedPhysicalPath: entry.physicalPath,
      });
    }
  }
  if (physicalKoffi.length !== 1) {
    errors.push({
      code: "unexpected-koffi-native-count",
      path: "resources/app.asar.unpacked/node_modules/koffi/build/koffi",
      expected: 1,
      actual: physicalKoffi.length,
    });
  } else {
    const match = physicalKoffi[0].path.match(KOFFI_NATIVE_PATH_RE);
    if (!match || match[1] !== target.koffiTriplet || physicalKoffi[0].disposition !== "target") {
      errors.push({
        code: "wrong-koffi-native-target",
        path: physicalKoffi[0].path,
        expectedTriplet: target.koffiTriplet,
      });
    }
  }

  const exceptionBinaries = binaries.filter((entry) => entry.disposition === "exception");
  const expectedExceptionCount = target.runtimePlatform === "win32" ? 1 : 0;
  if (exceptionBinaries.length !== expectedExceptionCount) {
    errors.push({
      code: "unexpected-native-exception-count",
      path: "resources/elevate.exe",
      expected: expectedExceptionCount,
      actual: exceptionBinaries.length,
    });
  }

  errors.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
  const bytesByDisposition = { target: 0, exception: 0, error: 0 };
  const countByDisposition = { target: 0, exception: 0, error: 0 };
  for (const entry of binaries) {
    bytesByDisposition[entry.disposition] += entry.bytes;
    countByDisposition[entry.disposition] += 1;
  }

  return {
    schemaVersion: 1,
    target: target.id,
    appRoot: resolvedRoot,
    binaries,
    logicalNative,
    koffi: {
      expectedTriplet: target.koffiTriplet,
      physical: physicalKoffi.map((entry) => entry.path),
      logical: logicalKoffi,
    },
    errors,
    summary: {
      binaries: binaries.length,
      logicalNativeCandidates: logicalNative.length,
      staleKoffiLogicalEntries: logicalNative.filter((entry) => entry.disposition === "stale-koffi-logical").length,
      errors: errors.length,
      countByDisposition,
      bytesByDisposition,
    },
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArgs(argv) {
  const options = { appRoot: "", targetId: "", output: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app-root") options.appRoot = argv[++index] || "";
    else if (arg === "--target") options.targetId = argv[++index] || "";
    else if (arg === "--output") options.output = argv[++index] || "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.appRoot) throw new Error("--app-root is required");
  if (!options.targetId) throw new Error("--target is required");
  return options;
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = auditPackagedNative(options);
  const json = stableJson(report);
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, "utf8");
  } else {
    process.stdout.write(json);
  }
  if (report.errors.length) {
    process.stderr.write(`Native package audit failed: ${report.errors.length} error(s).\n`);
    return 1;
  }
  process.stderr.write(`Native package audit passed for ${report.target}.\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runCli();
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  PE_MACHINES,
  ELF_MACHINES,
  MACH_CPU_TYPES,
  KOFFI_NATIVE_PATH_RE,
  LOGICAL_NATIVE_CANDIDATE_RE,
  toPosix,
  parsePe,
  parseElf,
  parseMachO,
  parseNativeBuffer,
  parseNativeFile,
  walkPhysicalFiles,
  getException,
  resourcesRootForTarget,
  listLogicalNativeEntries,
  listLogicalKoffiEntries,
  auditPackagedNative,
  stableJson,
  parseArgs,
  runCli,
};
