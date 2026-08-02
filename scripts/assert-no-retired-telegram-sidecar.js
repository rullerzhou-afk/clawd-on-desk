#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");

const RETIRED_SOURCE_PATHS = new Set([
  "src/telegram-approval-client.js",
  "src/telegram-approval-sidecar.js",
  "src/telegram-owner-manager.js",
  "src/telegram-sidecar-status-bridge.js",
]);

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.?\//, "");
}

function isRetiredPath(relativePath) {
  const normalized = toPosix(relativePath).toLowerCase();
  const basename = path.posix.basename(normalized);
  return normalized === "sidecars/cc-connect-clawd"
    || normalized.startsWith("sidecars/cc-connect-clawd/")
    || basename === "cc-connect-clawd"
    || basename === "cc-connect-clawd.exe"
    || RETIRED_SOURCE_PATHS.has(normalized);
}

function walkFiles(rootDir, currentDir = rootDir, out = []) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = toPosix(path.relative(rootDir, absolutePath));
    if (entry.isDirectory()) {
      out.push({
        path: relativePath,
        bytes: 0,
        kind: "directory",
        source: "resources",
      });
      walkFiles(rootDir, absolutePath, out);
    } else {
      const stat = fs.lstatSync(absolutePath);
      out.push({
        path: relativePath,
        bytes: stat.size,
        kind: entry.isSymbolicLink() ? "symlink" : "file",
        source: "resources",
      });
    }
  }
  return out;
}

function listAsarFiles(archivePath, asarModule = asar) {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Required app.asar does not exist: ${archivePath}`);
  }
  if (!fs.statSync(archivePath).isFile()) {
    throw new Error(`Required app.asar is not a file: ${archivePath}`);
  }
  return asarModule.listPackage(archivePath)
    .map((entry) => toPosix(entry))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => ({
      path: entry,
      source: "app.asar",
    }));
}

function inspectRetiredTelegramSidecar({
  resourcesRoot,
  asarModule = asar,
} = {}) {
  if (!resourcesRoot || typeof resourcesRoot !== "string") {
    throw new TypeError("resourcesRoot is required");
  }
  const resolvedRoot = path.resolve(resourcesRoot);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Resources root does not exist: ${resolvedRoot}`);
  }
  const resourcesFiles = walkFiles(resolvedRoot);
  const asarFiles = listAsarFiles(path.join(resolvedRoot, "app.asar"), asarModule);
  const files = [...resourcesFiles, ...asarFiles]
    .sort((a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path));
  const errors = files
    .filter((entry) => isRetiredPath(entry.path))
    .map((entry) => ({
      code: "retired-telegram-sidecar-present",
      path: entry.path,
      source: entry.source,
    }));
  return {
    schemaVersion: 1,
    files,
    errors,
    summary: {
      resourcesFiles: resourcesFiles.length,
      asarFiles: asarFiles.length,
      errors: errors.length,
    },
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArgs(argv) {
  const options = { resourcesRoot: "", output: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--resources-root") {
      options.resourcesRoot = argv[++index] || "";
    } else if (arg === "--output") {
      options.output = argv[++index] || "";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.resourcesRoot) throw new Error("--resources-root is required");
  return options;
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = inspectRetiredTelegramSidecar({
    resourcesRoot: options.resourcesRoot,
  });
  const json = stableJson(report);
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, "utf8");
  } else {
    process.stdout.write(json);
  }
  if (report.errors.length) {
    process.stderr.write(
      `Retired Telegram sidecar assertion failed: ${report.errors.length} forbidden path(s).\n`
    );
    return 1;
  }
  process.stderr.write("Retired Telegram sidecar assertion passed.\n");
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
  RETIRED_SOURCE_PATHS,
  toPosix,
  isRetiredPath,
  walkFiles,
  listAsarFiles,
  inspectRetiredTelegramSidecar,
  stableJson,
  parseArgs,
  runCli,
};
