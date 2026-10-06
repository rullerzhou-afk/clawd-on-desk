"use strict";

// Static CommonJS dependency preflight shared by hook installers. This module
// reads source text only: it never executes an entry point and never mutates
// the payload or user configuration.

const fs = require("fs");
const path = require("path");
const { scanRelativeRequires } = require("./appimage-hook-materializer");

function findMissingHookDependencies(entryNames, options = {}) {
  const hooksDir = path.resolve(options.hooksDir || __dirname);
  const statSync = options.statSync || fs.statSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const missing = [];
  const seen = new Set();
  const queue = entryNames.map((name) => ({ name, from: null }));

  while (queue.length) {
    const entry = queue.shift();
    const absPath = path.resolve(hooksDir, entry.name);
    const name = path.relative(hooksDir, absPath).split(path.sep).join("/");
    const { from } = entry;
    if (seen.has(name)) continue;
    seen.add(name);

    if (!name || name === ".." || name.startsWith("../") || path.isAbsolute(name)) {
      missing.push({ name, from, code: "OUTSIDE_HOOKS" });
      continue;
    }

    let content;
    try {
      if (!statSync(absPath).isFile()) {
        missing.push({ name, from, code: "NOT_FILE" });
        continue;
      }
      content = readFileSync(absPath, "utf8");
    } catch (err) {
      missing.push({ name, from, code: err.code || "READ_FAILED" });
      continue;
    }

    for (const spec of scanRelativeRequires(content)) {
      const target = path.resolve(
        path.dirname(absPath),
        path.extname(spec) ? spec : `${spec}.js`
      );
      const relative = path.relative(hooksDir, target).split(path.sep).join("/");
      queue.push({ name: relative, from: name });
    }
  }

  return missing;
}

function formatMissingHookDependencies(missing) {
  const lines = [
    "Clawd: refusing to install — required hook files are unavailable.",
    "",
  ];
  for (const { name, from, code } of missing) {
    lines.push(`  ${name} [${code}]${from ? `  (required by ${from})` : ""}`);
  }
  lines.push(
    "",
    "Restore missing files from the same complete Clawd source directory.",
    "For unreadable files, check their permissions; copying alone may not fix them.",
    "For a manual WSL copy, include every top-level JavaScript file:",
    "",
    "  cp /path/to/clawd-on-desk/hooks/*.js ~/.claude/hooks/"
  );
  return lines.join("\n");
}

module.exports = {
  findMissingHookDependencies,
  formatMissingHookDependencies,
};
