"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const { resolveReleaseTarget } = require("../src/native-package-target");
const { KOFFI_VERSION, KOFFI_TRIPLETS } = require("../src/koffi-package-contract");
const { parseNativeFile, toPosix } = require("./audit-packaged-native");

const KOFFI_2163_TRIPLETS = KOFFI_TRIPLETS;

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertDirectory(filename, label) {
  if (!fs.existsSync(filename)) throw new Error(`${label} does not exist: ${filename}`);
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink/reparse point: ${filename}`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${filename}`);
}

function locateAppRoot(appOutDir, target) {
  const resolved = path.resolve(appOutDir);
  assertDirectory(resolved, "afterPack appOutDir");
  if (target.runtimePlatform !== "darwin") return resolved;
  if (resolved.toLowerCase().endsWith(".app")) return resolved;
  const apps = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith(".app"))
    .map((entry) => path.join(resolved, entry.name));
  if (apps.length !== 1) {
    throw new Error(`Expected exactly one macOS .app under ${resolved}, found ${apps.length}`);
  }
  return apps[0];
}

function locateResourcesRoot(appRoot, target) {
  return target.runtimePlatform === "darwin"
    ? path.join(appRoot, "Contents", "Resources")
    : path.join(appRoot, "resources");
}

function walkTreeNoLinks(rootDir) {
  const files = [];
  function visit(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to prune symlink/reparse point: ${absolutePath}`);
      }
      if (stat.isDirectory()) visit(absolutePath);
      else if (stat.isFile()) files.push({ absolutePath, bytes: stat.size });
      else throw new Error(`Refusing to prune non-file entry: ${absolutePath}`);
    }
  }
  visit(rootDir);
  return files;
}

function sha256File(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function listLogicalKoffiNative(archivePath, asarModule = asar) {
  return asarModule.listPackage(archivePath)
    .map(toPosix)
    .filter((entry) => /(?:^|\/)node_modules\/koffi\/build\/koffi\/[^/]+\/koffi\.node$/i.test(entry))
    .sort((a, b) => a.localeCompare(b));
}

function assertSafeKoffiRoot({ appOutDir, resourcesRoot, nativeRoot }) {
  const resolvedAppOut = fs.realpathSync.native(path.resolve(appOutDir));
  const resolvedResources = fs.realpathSync.native(path.resolve(resourcesRoot));
  const resolvedNative = fs.realpathSync.native(path.resolve(nativeRoot));
  if (!isInside(resolvedAppOut, resolvedResources)) {
    throw new Error(`Resources root escaped appOutDir: ${resolvedResources}`);
  }
  if (!isInside(resolvedResources, resolvedNative)) {
    throw new Error(`Koffi native root escaped packaged resources: ${resolvedNative}`);
  }
  const requiredSegment = toPosix(path.relative(resolvedResources, resolvedNative));
  if (requiredSegment !== "app.asar.unpacked/node_modules/koffi/build/koffi") {
    throw new Error(`Unexpected Koffi prune root: ${requiredSegment}`);
  }
  return { resolvedAppOut, resolvedResources, resolvedNative };
}

function pruneKoffiNative({ appOutDir, targetId, outputPath = "", asarModule = asar } = {}) {
  if (!appOutDir) throw new TypeError("appOutDir is required");
  const target = require("../src/native-package-target").getReleaseTarget(targetId);
  const appRoot = locateAppRoot(appOutDir, target);
  const resourcesRoot = locateResourcesRoot(appRoot, target);
  const archivePath = path.join(resourcesRoot, "app.asar");
  const unpackedRoot = path.join(resourcesRoot, "app.asar.unpacked");
  const koffiRoot = path.join(unpackedRoot, "node_modules", "koffi");
  const nativeRoot = path.join(koffiRoot, "build", "koffi");
  const resolvedOutput = outputPath ? path.resolve(outputPath) : "";
  if (resolvedOutput && isInside(appOutDir, resolvedOutput)) {
    throw new Error(`Prune manifest must be outside appOutDir: ${resolvedOutput}`);
  }

  assertDirectory(resourcesRoot, "packaged resources root");
  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    throw new Error(`Required app.asar does not exist: ${archivePath}`);
  }
  assertDirectory(unpackedRoot, "app.asar.unpacked root");
  assertDirectory(koffiRoot, "packaged Koffi root");
  assertDirectory(nativeRoot, "packaged Koffi native root");
  const { resolvedNative } = assertSafeKoffiRoot({ appOutDir, resourcesRoot, nativeRoot });

  const packageJsonPath = path.join(koffiRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (packageJson.version !== KOFFI_VERSION) {
    throw new Error(`Refusing to prune unexpected Koffi version: ${packageJson.version || "<missing>"}`);
  }

  const rootEntries = fs.readdirSync(nativeRoot, { withFileTypes: true })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (rootEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error(`Koffi native root contains a non-directory or link: ${nativeRoot}`);
  }
  const actualTriplets = rootEntries.map((entry) => entry.name).sort();
  const expectedTriplets = Array.from(KOFFI_2163_TRIPLETS).sort();
  if (JSON.stringify(actualTriplets) !== JSON.stringify(expectedTriplets)) {
    throw new Error(
      `Unexpected Koffi 2.16.3 triplet layout. Expected ${KOFFI_2163_TRIPLETS.join(", ")}; ` +
      `found ${actualTriplets.join(", ")}`
    );
  }

  const targetDir = path.join(nativeRoot, target.koffiTriplet);
  assertDirectory(targetDir, "target Koffi triplet");
  const proposedDeletions = [];
  for (const triplet of actualTriplets) {
    const tripletDir = path.join(nativeRoot, triplet);
    const resolvedTriplet = fs.realpathSync.native(tripletDir);
    if (!isInside(resolvedNative, resolvedTriplet)) {
      throw new Error(`Koffi triplet escaped native root: ${resolvedTriplet}`);
    }
    for (const file of walkTreeNoLinks(tripletDir)) {
      proposedDeletions.push({
        path: toPosix(path.relative(nativeRoot, file.absolutePath)),
        bytes: file.bytes,
        delete: triplet !== target.koffiTriplet || /\.(?:lib|exp)$/i.test(file.absolutePath),
      });
    }
  }
  proposedDeletions.sort((a, b) => a.path.localeCompare(b.path));

  const targetEntries = fs.readdirSync(targetDir, { withFileTypes: true });
  for (const entry of targetEntries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Target Koffi triplet contains an unsupported entry: ${entry.name}`);
    }
    if (entry.name !== "koffi.node" && !/\.(?:lib|exp)$/i.test(entry.name)) {
      throw new Error(`Target Koffi triplet contains an unexpected file: ${entry.name}`);
    }
  }
  const retainedPath = path.join(targetDir, "koffi.node");
  const parsed = parseNativeFile(retainedPath);
  if (!parsed || parsed.format !== target.format ||
      parsed.architectures.length !== 1 || parsed.architectures[0] !== target.architecture) {
    throw new Error(
      `Retained Koffi binary has wrong architecture: expected ${target.format}/${target.architecture}, ` +
      `got ${parsed ? `${parsed.format}/${parsed.architectures.join(",")}` : "unknown"}`
    );
  }

  for (const triplet of actualTriplets) {
    if (triplet === target.koffiTriplet) continue;
    const tripletDir = path.join(nativeRoot, triplet);
    if (!isInside(nativeRoot, tripletDir)) throw new Error(`Unsafe triplet deletion path: ${tripletDir}`);
    fs.rmSync(tripletDir, { recursive: true, force: false });
  }
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (/\.(?:lib|exp)$/i.test(entry.name)) fs.rmSync(path.join(targetDir, entry.name), { force: false });
  }

  const retainedEntries = fs.readdirSync(targetDir, { withFileTypes: true });
  if (retainedEntries.length !== 1 || retainedEntries[0].name !== "koffi.node" || !retainedEntries[0].isFile()) {
    throw new Error(`Post-prune target triplet must contain exactly koffi.node: ${targetDir}`);
  }

  const report = {
    schemaVersion: 1,
    target: target.id,
    platform: target.runtimePlatform,
    arch: target.runtimeArch,
    koffiVersion: packageJson.version,
    appOutDir: path.resolve(appOutDir),
    appRoot: path.resolve(appRoot),
    nativeRoot: path.resolve(nativeRoot),
    proposedDeletions,
    logicalKoffiNativeEntries: listLogicalKoffiNative(archivePath, asarModule),
    retained: {
      path: toPosix(path.relative(appRoot, retainedPath)),
      bytes: fs.statSync(retainedPath).size,
      sha256: sha256File(retainedPath),
      format: parsed.format,
      architectures: parsed.architectures,
    },
    summary: {
      tripletsBefore: actualTriplets.length,
      tripletsAfter: 1,
      deletedFiles: proposedDeletions.filter((entry) => entry.delete).length,
      deletedBytes: proposedDeletions.filter((entry) => entry.delete).reduce((sum, entry) => sum + entry.bytes, 0),
    },
  };

  if (resolvedOutput) {
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    fs.writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

function getContextPlatform(context) {
  return context.electronPlatformName ||
    (context.packager && context.packager.platform && context.packager.platform.nodeName) || "";
}

async function afterPack(context) {
  const target = resolveReleaseTarget(getContextPlatform(context), context.arch);
  const outDir = path.resolve(context.outDir || path.dirname(context.appOutDir));
  const outputPath = path.join(outDir, "koffi-prune-manifests", `${target.id}.json`);
  const report = pruneKoffiNative({
    appOutDir: context.appOutDir,
    targetId: target.id,
    outputPath,
  });
  const log = context.packager && context.packager.info && context.packager.info.log;
  if (log && typeof log.info === "function") {
    log.info({ target: target.id, deletedBytes: report.summary.deletedBytes }, "pruned foreign Koffi native payloads");
  } else {
    process.stdout.write(
      `Clawd: pruned Koffi for ${target.id}; removed ${report.summary.deletedFiles} files ` +
      `(${report.summary.deletedBytes} bytes).\n`
    );
  }
}

module.exports = afterPack;
module.exports.KOFFI_2163_TRIPLETS = KOFFI_2163_TRIPLETS;
module.exports.isInside = isInside;
module.exports.locateAppRoot = locateAppRoot;
module.exports.locateResourcesRoot = locateResourcesRoot;
module.exports.walkTreeNoLinks = walkTreeNoLinks;
module.exports.listLogicalKoffiNative = listLogicalKoffiNative;
module.exports.assertSafeKoffiRoot = assertSafeKoffiRoot;
module.exports.pruneKoffiNative = pruneKoffiNative;
module.exports.getContextPlatform = getContextPlatform;
