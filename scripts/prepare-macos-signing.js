"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// app-builder-lib 26.15.7 passes the certificate password to the keychain's
// set-key-partition-list. Keep this workaround in the macOS signing job only;
// remove it after a reviewed upstream fix. Neither shared dependencies nor
// packaged application files need to change.
const VERSION = "26.15.7";
const ORIGINAL_SHA256 = "9f7d789b326147b6da29e1218d6e3f76b0314c68cf5d0f1efa59338a3c86e71a";
const PATCHED_SHA256 = "5b6551607c61c75cd1eadb2165b05513ff6d6b2965d129b5db9192b7e99e6fd1";

function sha256(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function patchSigningSource(source) {
  if (sha256(source) === PATCHED_SHA256) return source;
  if (sha256(source) !== ORIGINAL_SHA256) {
    throw new Error("Unrecognized app-builder-lib macOS signing source; review the keychain workaround before building.");
  }
  const patched = source
    .replace("importCerts(keychainFile, certPaths, cscPasswords)",
      "importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)")
    .replace("async function importCerts(keychainFile, paths, keyPasswords)",
      "async function importCerts(keychainFile, paths, keyPasswords, keychainPassword)")
    .replace('["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]',
      '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]');
  if (sha256(patched) !== PATCHED_SHA256) {
    throw new Error("macOS signing workaround did not produce the reviewed source.");
  }
  return patched;
}

function prepareMacSigning({
  platform = process.platform,
  builderRoot = path.join(__dirname, "..", "node_modules", "app-builder-lib"),
} = {}) {
  if (platform !== "darwin") throw new Error("The signing workaround is macOS-only.");
  const pkg = JSON.parse(fs.readFileSync(path.join(builderRoot, "package.json"), "utf8"));
  if (pkg.version !== VERSION) {
    throw new Error("Unexpected app-builder-lib version; review the macOS signing workaround before building.");
  }
  const filename = path.join(builderRoot, "out", "codeSign", "macCodeSign.js");
  const source = fs.readFileSync(filename, "utf8");
  const patched = patchSigningSource(source);
  if (patched === source) return false;
  fs.writeFileSync(filename, patched);
  return true;
}

if (require.main === module) {
  try {
    console.log(prepareMacSigning()
      ? "Applied app-builder-lib 26.15.7 macOS keychain password workaround."
      : "app-builder-lib 26.15.7 macOS keychain password workaround already applied.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { patchSigningSource, prepareMacSigning };
