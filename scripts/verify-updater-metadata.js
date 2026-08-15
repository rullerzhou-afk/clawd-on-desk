#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function parseScalar(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseUpdaterYaml(text) {
  const metadata = { files: [] };
  let currentFile = null;
  let inFiles = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.match(/^\s*/)[0].length;
    const trimmed = rawLine.trim();
    if (indent === 0 && trimmed === "files:") {
      inFiles = true;
      currentFile = null;
      continue;
    }
    if (inFiles && indent === 2 && trimmed.startsWith("- ")) {
      const match = trimmed.slice(2).match(/^([^:]+):\s*(.*)$/);
      if (!match) throw new Error(`Malformed updater file entry: ${rawLine}`);
      currentFile = { [match[1]]: parseScalar(match[2]) };
      metadata.files.push(currentFile);
      continue;
    }
    if (inFiles && indent >= 4 && currentFile) {
      const match = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (!match) throw new Error(`Malformed updater file field: ${rawLine}`);
      currentFile[match[1]] = parseScalar(match[2]);
      continue;
    }
    if (indent === 0) {
      inFiles = false;
      currentFile = null;
      const match = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (!match) throw new Error(`Malformed updater metadata field: ${rawLine}`);
      metadata[match[1]] = parseScalar(match[2]);
      continue;
    }
    throw new Error(`Unsupported updater metadata structure: ${rawLine}`);
  }
  return metadata;
}

function sha512Base64(filename) {
  return crypto.createHash("sha512").update(fs.readFileSync(filename)).digest("base64");
}

function validateContractShape(metadata, contract, expectedVersion) {
  if (typeof expectedVersion !== "string" || !expectedVersion.trim()) {
    throw new TypeError("expectedVersion is required");
  }
  const urls = metadata.files.map((entry) => String(entry.url || ""));
  const errors = [];
  if (String(metadata.version || "") !== expectedVersion) {
    errors.push(`Updater metadata version must be ${expectedVersion}, got ${metadata.version || "<empty>"}`);
  }
  let expectedUrls;
  if (contract === "windows") {
    expectedUrls = new Set([
      `Clawd-on-Desk-Setup-${expectedVersion}-x64.exe`,
      `Clawd-on-Desk-Setup-${expectedVersion}-arm64.exe`,
    ]);
  } else if (contract === "mac") {
    expectedUrls = new Set([
      `Clawd-on-Desk-${expectedVersion}-x64.dmg`,
      `Clawd-on-Desk-${expectedVersion}-arm64.dmg`,
    ]);
  } else if (contract === "linux") {
    expectedUrls = new Set([
      `Clawd-on-Desk-${expectedVersion}-x86_64.AppImage`,
      `Clawd-on-Desk-${expectedVersion}-amd64.deb`,
    ]);
  }
  if (!expectedUrls) throw new Error(`Unknown updater contract: ${contract || "<empty>"}`);
  for (const url of urls) {
    if (url && !expectedUrls.has(url)) {
      errors.push(`Unexpected updater artifact URL for ${contract} ${expectedVersion}: ${url}`);
    }
  }
  if (contract === "windows") {
    if (urls.length !== 2 || !urls.some((url) => /-x64\.exe$/i.test(url)) ||
        !urls.some((url) => /-arm64\.exe$/i.test(url))) {
      errors.push("latest.yml must list exactly the x64 and arm64 Windows executables");
    }
    if (!/-x64\.exe$/i.test(String(metadata.path || ""))) {
      errors.push("latest.yml top-level path must point at the x64 installer");
    }
  } else if (contract === "mac") {
    if (urls.length !== 2 || !urls.some((url) => /-x64\.dmg$/i.test(url)) ||
        !urls.some((url) => /-arm64\.dmg$/i.test(url)) || urls.some((url) => /\.zip$/i.test(url))) {
      errors.push("latest-mac.yml must list exactly the x64 and arm64 DMGs without a zip entry");
    }
    if (!/-x64\.dmg$/i.test(String(metadata.path || ""))) {
      errors.push("latest-mac.yml top-level path must point at the x64 DMG");
    }
  } else if (contract === "linux") {
    const appImage = metadata.files.find((entry) => /-x86_64\.AppImage$/.test(String(entry.url || "")));
    const deb = metadata.files.find((entry) => /-amd64\.deb$/i.test(String(entry.url || "")));
    if (urls.length !== 2 || !appImage || !deb) {
      errors.push("latest-linux.yml must list exactly the x86_64 AppImage and amd64 deb");
    }
    if (!/-x86_64\.AppImage$/.test(String(metadata.path || ""))) {
      errors.push("latest-linux.yml top-level path must point at the AppImage");
    }
    if (appImage && (!Number.isInteger(appImage.blockMapSize) || appImage.blockMapSize <= 0)) {
      errors.push("latest-linux.yml AppImage entry must contain a positive blockMapSize");
    }
  }
  return errors;
}

function verifyUpdaterMetadata({ metadataPath, artifactRoot, contract, expectedVersion } = {}) {
  if (!metadataPath) throw new TypeError("metadataPath is required");
  if (!artifactRoot) throw new TypeError("artifactRoot is required");
  if (typeof expectedVersion !== "string" || !expectedVersion.trim()) {
    throw new TypeError("expectedVersion is required");
  }
  const resolvedMetadata = path.resolve(metadataPath);
  const resolvedArtifacts = path.resolve(artifactRoot);
  const metadata = parseUpdaterYaml(fs.readFileSync(resolvedMetadata, "utf8"));
  const errors = validateContractShape(metadata, contract, expectedVersion);
  const files = [];

  for (const entry of metadata.files) {
    const url = String(entry.url || "");
    if (!url || path.basename(url) !== url || url.includes("..")) {
      errors.push(`Unsafe or missing updater artifact URL: ${url || "<empty>"}`);
      continue;
    }
    const filename = path.join(resolvedArtifacts, url);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
      errors.push(`Updater artifact does not exist: ${url}`);
      continue;
    }
    const actualSize = fs.statSync(filename).size;
    const actualSha512 = sha512Base64(filename);
    if (entry.size !== actualSize) errors.push(`Updater size mismatch for ${url}: ${entry.size} != ${actualSize}`);
    if (entry.sha512 !== actualSha512) errors.push(`Updater sha512 mismatch for ${url}`);
    files.push({ url, path: filename, size: actualSize, sha512: actualSha512 });
  }

  const topLevel = metadata.files.find((entry) => entry.url === metadata.path);
  if (!topLevel) errors.push(`Top-level updater path is absent from files[]: ${metadata.path || "<empty>"}`);
  else {
    if (metadata.sha512 !== topLevel.sha512) errors.push("Top-level updater sha512 must match the path entry");
  }

  return {
    schemaVersion: 1,
    contract,
    expectedVersion,
    metadataPath: resolvedMetadata,
    artifactRoot: resolvedArtifacts,
    files,
    errors,
    summary: { files: files.length, errors: errors.length },
  };
}

function parseArgs(argv) {
  const options = { metadataPath: "", artifactRoot: "", contract: "", packageJson: "", output: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--metadata") options.metadataPath = argv[++index] || "";
    else if (arg === "--artifact-root") options.artifactRoot = argv[++index] || "";
    else if (arg === "--contract") options.contract = argv[++index] || "";
    else if (arg === "--package-json") options.packageJson = argv[++index] || "";
    else if (arg === "--output") options.output = argv[++index] || "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.metadataPath) throw new Error("--metadata is required");
  if (!options.artifactRoot) throw new Error("--artifact-root is required");
  if (!options.contract) throw new Error("--contract is required");
  if (!options.packageJson) throw new Error("--package-json is required");
  return options;
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const packagePath = path.resolve(options.packageJson);
  const packageData = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const expectedVersion = typeof packageData.version === "string" ? packageData.version.trim() : "";
  if (!expectedVersion) throw new Error(`Package version is missing: ${packagePath}`);
  const report = verifyUpdaterMetadata({ ...options, expectedVersion });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, "utf8");
  } else {
    process.stdout.write(json);
  }
  if (report.errors.length) {
    process.stderr.write(`Updater metadata verification failed: ${report.errors.length} error(s).\n`);
    return 1;
  }
  process.stderr.write(`Updater metadata verification passed for ${report.contract}.\n`);
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
  parseUpdaterYaml,
  sha512Base64,
  validateContractShape,
  verifyUpdaterMetadata,
  parseArgs,
  runCli,
};
