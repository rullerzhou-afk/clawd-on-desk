"use strict";

const fs = require("fs");
const path = require("path");

function isAbsoluteAnyPlatform(entry) {
  const normalized = String(entry || "").replace(/\\/g, "/");
  return path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
}

function validateOpencodeEntry(entry, options = {}) {
  const fsImpl = options.fs || fs;
  if (typeof entry !== "string" || !isAbsoluteAnyPlatform(entry)) {
    return { ok: false, reason: "not-absolute" };
  }

  let stat;
  try {
    stat = fsImpl.statSync(entry);
  } catch {
    return { ok: false, reason: "directory-missing" };
  }

  if (!stat || typeof stat.isDirectory !== "function" || !stat.isDirectory()) {
    return { ok: false, reason: "not-a-directory" };
  }
  const indexPath = path.join(entry, "index.mjs");
  if (!fsImpl.existsSync(indexPath)) {
    return { ok: false, reason: "index-mjs-missing" };
  }

  // #413: opencode's plugin loader (getLegacyPlugins) iterates Object.values(mod)
  // and throws "Plugin export is not a function" on any export beyond the default
  // function, then swallows the error -- silently dropping the whole plugin. The
  // path/file checks above can't see that, so they reported a false "ok". Guard
  // the single-default-export invariant by scanning the module source. Skipped
  // when the fs impl has no readFileSync (keeps older static-only callers working).
  if (typeof fsImpl.readFileSync === "function") {
    let source;
    try {
      source = fsImpl.readFileSync(indexPath, "utf8");
    } catch {
      return { ok: false, reason: "index-mjs-unreadable" };
    }
    if (hasNamedExport(source)) {
      return { ok: false, reason: "extra-module-exports" };
    }
  }

  return { ok: true };
}

// opencode requires the plugin module to expose exactly ONE export: the default
// function. Any named export breaks loading -- a non-function export throws
// outright, and even a named function would be invoked as a second plugin. Match
// a line-leading `export` that isn't `export default`, after stripping block
// comments so commented-out examples don't trip it. (Line comments start with
// `//`, so a leading `export` keyword can never sit inside one.)
//
// Known limitation: a backtick template literal whose own line begins with
// `export` would false-positive. That is safe by direction -- it produces an
// extra warning, never a missed failure -- and does not occur in the plugin
// entry. Fully fixing it would require a JS parser, which isn't worth it here.
function hasNamedExport(source) {
  if (typeof source !== "string" || !source) return false;
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return /^[ \t]*export\s+(?!default\b)(?:const|let|var|function|class|async|\{|\*)/m.test(stripped);
}

module.exports = { validateOpencodeEntry };
