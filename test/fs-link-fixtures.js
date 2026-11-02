"use strict";

const fs = require("node:fs");
const assert = require("node:assert/strict");

// The Windows EPERM fallback only tests rejection of an unresolvable file junction.
// Rejection without reading a valid external file is covered by real symlinks
// on macOS/Linux and administrator-run Windows CI.
function linkForRejection(target, link) {
  try {
    fs.symlinkSync(target, link);
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    fs.symlinkSync(target, link, "junction");
  }
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
}

module.exports = { linkForRejection };
