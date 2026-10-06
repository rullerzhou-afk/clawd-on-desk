#!/usr/bin/env node
"use strict";

// Normalizes and verifies the exact WinGet manifest tree that Komac generated.
//
// The architecture gate protects Komac's inputs. This gate protects its output:
// Komac preserves the previous manifest's installer-entry shape, and it also
// derives locale metadata that is not precise enough for this package. Nothing
// may be submitted until the generated YAML passes this complete contract.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const PACKAGE_IDENTIFIER = "rullerzhou-afk.clawd-on-desk";
const PUBLISHER_PATH = ["r", "rullerzhou-afk", "clawd-on-desk"];
const PRODUCT_CODE = "3e932233-a8b2-5530-b285-e0ceb08488f2";
const MANIFEST_VERSION = "1.12.0";
const LICENSE = "AGPL-3.0-only";
const REQUIRED_ARCHITECTURES = ["arm64", "x64"];
const REQUIRED_SCOPES = ["machine", "user"];
const MANIFEST_FILES = {
  installer: `${PACKAGE_IDENTIFIER}.installer.yaml`,
  defaultLocale: `${PACKAGE_IDENTIFIER}.locale.en-US.yaml`,
  locale: `${PACKAGE_IDENTIFIER}.locale.zh-CN.yaml`,
  version: `${PACKAGE_IDENTIFIER}.yaml`,
};
const ALLOWED_KEYS = {
  installer: [
    "PackageIdentifier",
    "PackageVersion",
    "InstallerLocale",
    "InstallerType",
    "InstallerSwitches",
    "UpgradeBehavior",
    "ProductCode",
    "ReleaseDate",
    "AppsAndFeaturesEntries",
    "Installers",
    "ManifestType",
    "ManifestVersion",
  ],
  installerSwitches: ["Upgrade"],
  appsAndFeatures: ["DisplayName", "ProductCode"],
  installerEntry: [
    "Architecture",
    "Scope",
    "InstallerUrl",
    "InstallerSha256",
    "InstallerSwitches",
  ],
  installerEntrySwitches: ["Custom"],
  defaultLocale: [
    "PackageIdentifier",
    "PackageVersion",
    "PackageLocale",
    "Publisher",
    "PublisherUrl",
    "PublisherSupportUrl",
    "PackageName",
    "PackageUrl",
    "License",
    "LicenseUrl",
    "Copyright",
    "ShortDescription",
    "Description",
    "Tags",
    "ReleaseNotes",
    "ReleaseNotesUrl",
    "ManifestType",
    "ManifestVersion",
  ],
  locale: [
    "PackageIdentifier",
    "PackageVersion",
    "PackageLocale",
    "License",
    "LicenseUrl",
    "ShortDescription",
    "Description",
    "Tags",
    "ReleaseNotesUrl",
    "ManifestType",
    "ManifestVersion",
  ],
  version: [
    "PackageIdentifier",
    "PackageVersion",
    "DefaultLocale",
    "ManifestType",
    "ManifestVersion",
  ],
};

function parseArgs(argv) {
  const options = {
    architectureContract: "",
    generatedRoot: "",
    output: "",
    releaseTag: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--architecture-contract") {
      options.architectureContract = argv[++index] || "";
    } else if (arg === "--generated-root") {
      options.generatedRoot = argv[++index] || "";
    } else if (arg === "--output") {
      options.output = argv[++index] || "";
    } else if (arg === "--release-tag") {
      options.releaseTag = argv[++index] || "";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function walkFiles(root, current = root, files = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      files.push({ absolute, type: "symlink" });
    } else if (entry.isDirectory()) {
      walkFiles(root, absolute, files);
    } else if (entry.isFile()) {
      files.push({ absolute, type: "file" });
    } else {
      files.push({ absolute, type: "other" });
    }
  }
  return files;
}

function manifestHeader(manifestType) {
  return (
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.` +
    `${manifestType}.${MANIFEST_VERSION}.schema.json`
  );
}

function readManifest(filePath, expectedType, errors) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    errors.push(`${path.basename(filePath)} could not be read: ${error.message}`);
    return null;
  }

  const expectedHeader = manifestHeader(expectedType);
  if (!source.split(/\r?\n/, 6).includes(expectedHeader)) {
    errors.push(`${path.basename(filePath)} is missing the exact ${expectedHeader} header.`);
  }

  let value;
  try {
    value = yaml.load(source, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    errors.push(`${path.basename(filePath)} is not valid YAML: ${error.message}`);
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push(`${path.basename(filePath)} must contain one YAML object.`);
    return null;
  }
  return { filePath, source, value };
}

function pushEqual(errors, actual, expected, label) {
  if (actual !== expected) {
    errors.push(`${label} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

function pushString(errors, value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string.`);
  }
}

function validateExactKeys(errors, value, allowedKeys, label) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unexpected.length) {
    errors.push(`${label} contains unsupported keys: ${unexpected.join(", ")}.`);
  }
}

function validateStringArray(errors, value, label) {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    errors.push(`${label} must be a non-empty array of non-empty strings.`);
  }
}

function validateCommon(errors, document, expectedType, version, label) {
  if (!document) return;
  const value = document.value;
  pushEqual(errors, value.PackageIdentifier, PACKAGE_IDENTIFIER, `${label}.PackageIdentifier`);
  pushEqual(errors, value.PackageVersion, version, `${label}.PackageVersion`);
  pushEqual(errors, value.ManifestType, expectedType, `${label}.ManifestType`);
  pushEqual(errors, value.ManifestVersion, MANIFEST_VERSION, `${label}.ManifestVersion`);
}

function normalizeLocale(document, releaseTag) {
  if (!document) return;
  document.value.License = LICENSE;
  document.value.LicenseUrl =
    `https://github.com/rullerzhou-afk/clawd-on-desk/blob/${releaseTag}/LICENSE`;
  document.value.ReleaseNotesUrl =
    `https://github.com/rullerzhou-afk/clawd-on-desk/releases/tag/${releaseTag}`;
}

function validateArchitectureContract(contract, releaseTag, version, errors) {
  if (!isPlainObject(contract)) {
    errors.push("architecture contract must be a JSON object.");
    return new Map();
  }
  pushEqual(errors, contract.schemaVersion, 2, "architecture contract schemaVersion");
  pushEqual(errors, contract.version, version, "architecture contract version");
  pushEqual(errors, contract.releaseTag, releaseTag, "architecture contract releaseTag");
  if (!Array.isArray(contract.errors) || contract.errors.length !== 0) {
    errors.push("architecture contract must contain an empty errors array.");
  }
  if (!Array.isArray(contract.installers)) {
    errors.push("architecture contract installers must be an array.");
    return new Map();
  }

  const installers = new Map();
  for (const [index, installer] of contract.installers.entries()) {
    if (!isPlainObject(installer)) {
      errors.push(`architecture contract installers[${index}] must be an object.`);
      continue;
    }
    const architecture = installer.expectedArchitecture;
    if (!REQUIRED_ARCHITECTURES.includes(architecture)) {
      errors.push(`architecture contract installers[${index}] has unexpected architecture.`);
      continue;
    }
    pushEqual(
      errors,
      installer.resolvedArchitecture,
      architecture,
      `architecture contract installers[${index}].resolvedArchitecture`,
    );
    if (installers.has(architecture)) {
      errors.push(`architecture contract repeats ${architecture}.`);
      continue;
    }
    if (typeof installer.filename !== "string" ||
        !installer.filename.endsWith(`-${architecture}.exe`)) {
      errors.push(`architecture contract ${architecture} filename does not identify its architecture.`);
    }
    const expectedUrl =
      `https://github.com/rullerzhou-afk/clawd-on-desk/releases/download/` +
      `${releaseTag}/${installer.filename}`;
    pushEqual(errors, installer.url, expectedUrl, `architecture contract ${architecture} URL`);
    if (typeof installer.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(installer.digest)) {
      errors.push(`architecture contract ${architecture} digest is not sha256:<64 lowercase hex>.`);
      continue;
    }
    installers.set(architecture, installer);
  }

  const actual = [...installers.keys()].sort();
  if (actual.join(",") !== REQUIRED_ARCHITECTURES.join(",")) {
    errors.push(
      `architecture contract must contain exactly ${REQUIRED_ARCHITECTURES.join(", ")}; ` +
      `got ${actual.join(", ") || "none"}.`,
    );
  }
  return installers;
}

function validateInstallerManifest(document, contractInstallers, version, errors) {
  if (!document) return;
  const value = document.value;
  validateExactKeys(errors, value, ALLOWED_KEYS.installer, "installer");
  pushEqual(errors, value.InstallerLocale, "en-US", "installer.InstallerLocale");
  pushEqual(errors, value.InstallerType, "nullsoft", "installer.InstallerType");
  pushEqual(errors, value.UpgradeBehavior, "install", "installer.UpgradeBehavior");
  validateExactKeys(
    errors,
    value.InstallerSwitches,
    ALLOWED_KEYS.installerSwitches,
    "installer.InstallerSwitches",
  );
  pushEqual(errors, value.InstallerSwitches?.Upgrade, "--updated", "installer upgrade switch");
  pushEqual(errors, value.ProductCode, PRODUCT_CODE, "installer.ProductCode");
  if (typeof value.ReleaseDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.ReleaseDate)) {
    errors.push("installer.ReleaseDate must be YYYY-MM-DD.");
  }

  if (!Array.isArray(value.AppsAndFeaturesEntries) || value.AppsAndFeaturesEntries.length !== 1) {
    errors.push("installer.AppsAndFeaturesEntries must contain exactly one entry.");
  } else {
    const entry = value.AppsAndFeaturesEntries[0];
    validateExactKeys(
      errors,
      entry,
      ALLOWED_KEYS.appsAndFeatures,
      "installer.AppsAndFeaturesEntries[0]",
    );
    pushEqual(errors, entry?.DisplayName, `Clawd on Desk ${version}`, "AppsAndFeatures DisplayName");
    pushEqual(errors, entry?.ProductCode, PRODUCT_CODE, "AppsAndFeatures ProductCode");
  }

  if (!Array.isArray(value.Installers) || value.Installers.length !== 4) {
    errors.push("installer.Installers must contain exactly four entries.");
    return;
  }

  const expected = new Map();
  for (const architecture of REQUIRED_ARCHITECTURES) {
    const contract = contractInstallers.get(architecture);
    if (!contract) continue;
    for (const scope of REQUIRED_SCOPES) {
      expected.set(`${architecture}|${scope}`, {
        url: contract.url,
        digest: contract.digest.slice("sha256:".length).toUpperCase(),
        custom: scope === "user" ? "/currentuser" : "/allusers",
      });
    }
  }

  const seen = new Set();
  for (const [index, installer] of value.Installers.entries()) {
    if (!isPlainObject(installer)) {
      errors.push(`installer.Installers[${index}] must be an object.`);
      continue;
    }
    validateExactKeys(
      errors,
      installer,
      ALLOWED_KEYS.installerEntry,
      `installer.Installers[${index}]`,
    );
    validateExactKeys(
      errors,
      installer.InstallerSwitches,
      ALLOWED_KEYS.installerEntrySwitches,
      `installer.Installers[${index}].InstallerSwitches`,
    );
    const key = `${installer.Architecture}|${installer.Scope}`;
    const expectedEntry = expected.get(key);
    if (!expectedEntry) {
      errors.push(`installer.Installers[${index}] has unexpected architecture/scope ${key}.`);
      continue;
    }
    if (seen.has(key)) errors.push(`installer.Installers repeats ${key}.`);
    seen.add(key);
    pushEqual(errors, installer.InstallerUrl, expectedEntry.url, `${key} InstallerUrl`);
    pushEqual(errors, installer.InstallerSha256, expectedEntry.digest, `${key} InstallerSha256`);
    pushEqual(errors, installer.InstallerSwitches?.Custom, expectedEntry.custom, `${key} Custom`);
  }
  for (const key of expected.keys()) {
    if (!seen.has(key)) errors.push(`installer.Installers is missing ${key}.`);
  }
}

function validateLocales(documents, releaseTag, errors) {
  const expectedLicenseUrl =
    `https://github.com/rullerzhou-afk/clawd-on-desk/blob/${releaseTag}/LICENSE`;
  const expectedReleaseNotesUrl =
    `https://github.com/rullerzhou-afk/clawd-on-desk/releases/tag/${releaseTag}`;

  const defaultLocale = documents.defaultLocale?.value;
  if (defaultLocale) {
    validateExactKeys(errors, defaultLocale, ALLOWED_KEYS.defaultLocale, "defaultLocale");
    pushEqual(errors, defaultLocale.PackageLocale, "en-US", "defaultLocale.PackageLocale");
    pushEqual(errors, defaultLocale.Publisher, "rullerzhou-afk", "defaultLocale.Publisher");
    pushEqual(errors, defaultLocale.PackageName, "Clawd on Desk", "defaultLocale.PackageName");
    pushEqual(errors, defaultLocale.License, LICENSE, "defaultLocale.License");
    pushEqual(errors, defaultLocale.LicenseUrl, expectedLicenseUrl, "defaultLocale.LicenseUrl");
    pushEqual(
      errors,
      defaultLocale.ReleaseNotesUrl,
      expectedReleaseNotesUrl,
      "defaultLocale.ReleaseNotesUrl",
    );
    pushString(errors, defaultLocale.ShortDescription, "defaultLocale.ShortDescription");
    pushString(errors, defaultLocale.Description, "defaultLocale.Description");
    pushString(errors, defaultLocale.ReleaseNotes, "defaultLocale.ReleaseNotes");
    pushString(errors, defaultLocale.PublisherUrl, "defaultLocale.PublisherUrl");
    pushString(errors, defaultLocale.PublisherSupportUrl, "defaultLocale.PublisherSupportUrl");
    pushString(errors, defaultLocale.PackageUrl, "defaultLocale.PackageUrl");
    pushString(errors, defaultLocale.Copyright, "defaultLocale.Copyright");
    validateStringArray(errors, defaultLocale.Tags, "defaultLocale.Tags");
  }

  const locale = documents.locale?.value;
  if (locale) {
    validateExactKeys(errors, locale, ALLOWED_KEYS.locale, "locale");
    pushEqual(errors, locale.PackageLocale, "zh-CN", "locale.PackageLocale");
    pushEqual(errors, locale.License, LICENSE, "locale.License");
    pushEqual(errors, locale.LicenseUrl, expectedLicenseUrl, "locale.LicenseUrl");
    pushEqual(errors, locale.ReleaseNotesUrl, expectedReleaseNotesUrl, "locale.ReleaseNotesUrl");
    pushString(errors, locale.ShortDescription, "locale.ShortDescription");
    pushString(errors, locale.Description, "locale.Description");
    validateStringArray(errors, locale.Tags, "locale.Tags");
  }

  const version = documents.version?.value;
  if (version) {
    validateExactKeys(errors, version, ALLOWED_KEYS.version, "version");
    pushEqual(errors, version.DefaultLocale, "en-US", "version.DefaultLocale");
  }
}

function serializeManifest(document, expectedType) {
  const createdWith = document.source.match(/^# Created with [^\r\n]+/m)?.[0] ||
    "# Created with Clawd on Desk release automation";
  const body = yaml.dump(document.value, {
    schema: yaml.JSON_SCHEMA,
    lineWidth: -1,
    noCompatMode: true,
    noRefs: true,
    sortKeys: false,
  });
  return `${createdWith}\n${manifestHeader(expectedType)}\n\n${body}`;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function atomicWrite(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const mode = fs.statSync(filePath).mode;
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", mode });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function normalizeAndVerifyGeneratedManifest({
  architectureContract,
  generatedRoot,
  releaseTag,
} = {}) {
  const errors = [];
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(releaseTag || "")) {
    errors.push(`release tag must be vMAJOR.MINOR.PATCH, got ${JSON.stringify(releaseTag)}.`);
  }
  const version = releaseTag ? releaseTag.slice(1) : "";
  const root = path.resolve(generatedRoot || ".");
  const manifestDirectory = path.join(root, "manifests", ...PUBLISHER_PATH, version);
  const expectedRelativeFiles = Object.values(MANIFEST_FILES)
    .map((name) => path.relative(root, path.join(manifestDirectory, name)))
    .sort();

  let inventory = [];
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      errors.push("generated root must be a real directory, not a symlink.");
    } else {
      inventory = walkFiles(root);
      for (const entry of inventory) {
        if (entry.type !== "file") {
          errors.push(`${path.relative(root, entry.absolute)} must be a regular file.`);
        }
      }
      const actualRelativeFiles = inventory
        .filter((entry) => entry.type === "file")
        .map((entry) => path.relative(root, entry.absolute))
        .sort();
      if (actualRelativeFiles.join("\n") !== expectedRelativeFiles.join("\n")) {
        errors.push(
          `generated tree must contain exactly the four expected manifest files; got ` +
          `${actualRelativeFiles.join(", ") || "none"}.`,
        );
      }
    }
  } catch (error) {
    errors.push(`generated root could not be inspected: ${error.message}`);
  }

  let contract = null;
  try {
    contract = readJson(architectureContract, "architecture contract");
  } catch (error) {
    errors.push(error.message);
  }
  const contractInstallers = validateArchitectureContract(
    contract,
    releaseTag,
    version,
    errors,
  );

  const documents = {};
  if (errors.every((error) => !error.startsWith("generated root")) &&
      inventory.filter((entry) => entry.type === "file").length === 4) {
    for (const [type, filename] of Object.entries(MANIFEST_FILES)) {
      documents[type] = readManifest(path.join(manifestDirectory, filename), type, errors);
      validateCommon(errors, documents[type], type, version, type);
    }
  }

  // These are the only normalizations automation is allowed to make. Everything
  // else must already be correct in Komac's output or the gate fails closed.
  normalizeLocale(documents.defaultLocale, releaseTag);
  normalizeLocale(documents.locale, releaseTag);

  validateInstallerManifest(documents.installer, contractInstallers, version, errors);
  validateLocales(documents, releaseTag, errors);

  const normalizedFiles = [];
  if (errors.length === 0) {
    for (const type of ["defaultLocale", "locale"]) {
      const document = documents[type];
      atomicWrite(document.filePath, serializeManifest(document, type));
      normalizedFiles.push(path.relative(root, document.filePath));
    }
  }

  const fileDigests = {};
  if (errors.length === 0) {
    for (const relative of expectedRelativeFiles) {
      fileDigests[relative] = `sha256:${sha256(path.join(root, relative))}`;
    }
  }

  return {
    schemaVersion: 1,
    packageIdentifier: PACKAGE_IDENTIFIER,
    version,
    releaseTag,
    manifestDirectory: path.relative(root, manifestDirectory),
    normalizedFiles,
    fileDigests,
    errors,
    summary: {
      files: expectedRelativeFiles.length,
      installers: documents.installer?.value?.Installers?.length || 0,
      errors: errors.length,
    },
  };
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.architectureContract) throw new Error("--architecture-contract is required");
  if (!options.generatedRoot) throw new Error("--generated-root is required");
  if (!options.releaseTag) throw new Error("--release-tag is required");

  const report = normalizeAndVerifyGeneratedManifest(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, "utf8");
  } else {
    process.stdout.write(json);
  }

  if (report.errors.length) {
    process.stderr.write(
      `Generated WinGet manifest failed: ${report.errors.length} error(s).\n`,
    );
    for (const error of report.errors) process.stderr.write(`  - ${error}\n`);
    return 1;
  }
  process.stderr.write(
    `Generated WinGet manifest passed for ${report.summary.files} files and ` +
    `${report.summary.installers} installer entries.\n`,
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_KEYS,
  LICENSE,
  MANIFEST_FILES,
  MANIFEST_VERSION,
  PACKAGE_IDENTIFIER,
  PRODUCT_CODE,
  PUBLISHER_PATH,
  REQUIRED_ARCHITECTURES,
  REQUIRED_SCOPES,
  manifestHeader,
  normalizeAndVerifyGeneratedManifest,
  parseArgs,
  runCli,
};
