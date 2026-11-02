"use strict";

const fs = require("node:fs");
const assert = require("node:assert/strict");

// Exercise the actual lstat rejection boundary without requiring Developer Mode.
// Windows junctions and file symlinks both report isSymbolicLink(); a junction
// aimed at a file is intentionally unresolvable and must still be rejected.
// POSIX keeps the live file symlink, covering rejection rather than following a
// readable external file. Both platform variants keep the external data intact.
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
