"use strict";
// Shared entry parser / ownership classifier / edit planner for
// opencode-family configs (#1026 §5).
//
// The JSONC editor must never grow its own copy of the ownership rules, and
// the Doctor must reach the same verdicts the installer does. This module is
// deliberately filesystem-agnostic: every probe (exists / bundle bytes /
// managed boundary / clawd-like evidence) is injected by the caller, so the
// classification matrix is table-testable without touching a real home.
//
// Categories (v3 §5.2):
//   canonical-current | owned-managed-stale | legacy-source-exact |
//   legacy-missing-candidate | verified-current-copy | clawd-like-modified |
//   managed-corrupt | foreign | unknown

const path = require("path");

// OpenCode 1.18.31 tuple contract evidence (reproducible):
//   `opencode debug config` with an isolated XDG_CONFIG_HOME against
//   opencode 1.18.31 accepts `plugin: [["/abs/opencode-plugin", { … }]]`
//   (emits spec `["file:///abs/opencode-plugin", { … }]`) and rejects both
//   `[["/abs/opencode-plugin"]]` ("Missing key plugin.0.1") and
//   `[["/abs/opencode-plugin", "/b"]]` ("Expected object, got \"/b\"").
// So a supported tuple is exactly a length-2 array whose first item is a
// string and whose second item is a plain object. Anything else is malformed
// (and the host itself refuses the config), never a Clawd candidate.
function isPlainOptionsObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const OWNED_SAFE_CATEGORIES = new Set([
  "canonical-current",
  "owned-managed-stale",
  "legacy-source-exact",
  "legacy-missing-candidate",
  "verified-current-copy",
]);

const FAIL_CLOSED_CATEGORIES = new Set([
  "clawd-like-modified",
  "managed-corrupt",
  "unknown",
]);

function parseEntry(rawEntry) {
  if (typeof rawEntry === "string") {
    return {
      rawEntry,
      specifier: rawEntry,
      options: undefined,
      shape: "string",
      malformed: false,
      tuple: false,
    };
  }
  if (Array.isArray(rawEntry)) {
    // Only a length-2 tuple whose first item is a string and whose second item
    // is a plain object is a valid Clawd candidate (1.18.31 contract above).
    // Anything else is third-party / malformed and stays untouched.
    if (rawEntry.length === 2 && typeof rawEntry[0] === "string" && isPlainOptionsObject(rawEntry[1])) {
      return {
        rawEntry,
        specifier: rawEntry[0],
        options: rawEntry[1],
        shape: "tuple",
        malformed: false,
        tuple: true,
      };
    }
    return { rawEntry, specifier: null, options: undefined, shape: "array", malformed: true, tuple: false };
  }
  return { rawEntry, specifier: null, options: undefined, shape: typeof rawEntry, malformed: true, tuple: false };
}

function isAbsoluteAnyPlatform(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
}

function basenameAnyPlatform(value) {
  return path.posix.basename(String(value || "").replace(/\\/g, "/"));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sameOptions(a, b) {
  if (a === undefined && b === undefined) return true;
  return stableStringify(a) === stableStringify(b);
}

function describeRemediation(entry, candidatePath) {
  const literal = JSON.stringify(entry.rawEntry);
  return {
    configPath: candidatePath,
    index: entry.index,
    literal,
    steps: [
      `Open ${candidatePath}.`,
      `In the top-level "plugin" array, remove or replace element ${entry.index}: ${literal}.`,
      "Replace it with the managed Clawd plugin path shown by Doctor/Install, then re-run Repair.",
    ],
  };
}

// Classify every entry of a plugin array. `ctx` carries the injected probes:
//   fs, platform, pluginDirName, expectedCanonicalDir, targetRoot,
//   sourcePluginDir, knownRegisteredPaths (Set of canonical strings),
//   canonicalize(absPath) -> canonical | null
//   exists(absPath) -> boolean
//   inspectExpectedGeneration() -> { ok, reason }
//   inspectManagedBoundary(absPath) -> { state:"owned"|"corrupt", reason? }
//   bundleBytesMatch(absPath) -> boolean
//   isClawdLike(absPath) -> boolean
function classifyPluginEntries(pluginArray, ctx) {
  const entries = [];
  if (!Array.isArray(pluginArray)) return { entries, summary: { total: 0 } };

  const canonicalize = ctx.canonicalize;
  const parsedList = pluginArray.map((rawEntry, index) => ({ index, rawEntry, ...parseEntry(rawEntry) }));

  for (const item of parsedList) {
    if (item.malformed || item.specifier === null) {
      entries.push({ ...item, category: "foreign", canonical: null, reason: "malformed-or-non-string" });
      continue;
    }
    if (!isAbsoluteAnyPlatform(item.specifier)) {
      entries.push({ ...item, category: "foreign", canonical: null, reason: "npm-specifier" });
      continue;
    }
    let canonical = canonicalize ? canonicalize(item.specifier) : null;
    const known = canonical && ctx.knownRegisteredPaths instanceof Set
      ? ctx.knownRegisteredPaths.has(canonical)
      : false;
    const exists = ctx.exists(item.specifier);

    // An EXISTING entry whose path identity cannot be resolved (realpath
    // failure) must never be promoted to owned via a lexical comparison. Only
    // missing paths may fall back to their lexical spelling.
    if (exists) {
      if (typeof ctx.canonicalizeStrict === "function") {
        const strict = ctx.canonicalizeStrict(item.specifier);
        if (strict === null || strict === undefined) {
          entries.push({ ...item, category: "unknown", canonical, reason: "realpath-unresolved" });
          continue;
        }
        canonical = strict;
      }
    }

    if (ctx.expectedCanonicalDir && canonical === ctx.expectedCanonicalDir) {
      const check = typeof ctx.inspectExpectedGeneration === "function" ? ctx.inspectExpectedGeneration() : { ok: true };
      if (check && check.ok) {
        entries.push({ ...item, category: "canonical-current", canonical });
      } else if (check && check.reason === "generation-missing") {
        // The entry already points at the right content-addressed location but
        // the generation has not been materialized yet. That is a pending
        // write, not corruption.
        entries.push({ ...item, category: "canonical-current", canonical, generationPending: true });
      } else {
        entries.push({
          ...item,
          category: "managed-corrupt",
          canonical,
          reason: (check && check.reason) || "expected-generation-invalid",
        });
      }
      continue;
    }

    if (ctx.targetRoot && canonical && isPathWithin(canonical, ctx.targetRoot)) {
      const managed = typeof ctx.inspectManagedBoundary === "function"
        ? ctx.inspectManagedBoundary(item.specifier)
        : null;
      if (managed && managed.state === "owned") {
        entries.push({ ...item, category: "owned-managed-stale", canonical });
      } else {
        entries.push({
          ...item,
          category: "managed-corrupt",
          canonical,
          reason: (managed && managed.reason) || "managed-boundary-invalid",
        });
      }
      continue;
    }

    if (ctx.sourcePluginDir && canonical === ctx.sourcePluginDir) {
      entries.push({ ...item, category: "legacy-source-exact", canonical });
      continue;
    }

    const indeterminate = ctx.probeIndeterminate ? ctx.probeIndeterminate(item.specifier) : false;
    if (indeterminate) {
      entries.push({ ...item, category: "unknown", canonical, reason: "path-indeterminate" });
      continue;
    }
    if (!exists) {
      const basenameMatches = basenameAnyPlatform(item.specifier).toLowerCase() === String(ctx.pluginDirName).toLowerCase();
      if (known) {
        entries.push({ ...item, category: "legacy-missing-candidate", canonical });
      } else if (basenameMatches) {
        entries.push({ ...item, category: "unknown", canonical, reason: "ambiguous-missing-basename" });
      } else {
        // A missing absolute path with no Clawd identity evidence is not ours
        // to guess about — preserve it like any foreign entry.
        entries.push({ ...item, category: "foreign", canonical, reason: "missing-no-identity" });
      }
      continue;
    }

    if (typeof ctx.bundleBytesMatch === "function" && ctx.bundleBytesMatch(item.specifier)) {
      entries.push({ ...item, category: "verified-current-copy", canonical });
      continue;
    }
    if (typeof ctx.isClawdLike === "function" && ctx.isClawdLike(item.specifier)) {
      entries.push({ ...item, category: "clawd-like-modified", canonical });
      continue;
    }
    entries.push({ ...item, category: "foreign", canonical, reason: "no-clawd-identity" });
  }

  return {
    entries,
    summary: {
      total: entries.length,
    },
  };
}

function isPathWithin(candidate, root) {
  if (typeof candidate !== "string" || typeof root !== "string") return false;
  const c = candidate.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/");
  if (c === r) return true;
  const withSep = r.endsWith("/") ? r : `${r}/`;
  return c.startsWith(withSep);
}

function safeOwned(entries) {
  return entries.filter((entry) => OWNED_SAFE_CATEGORIES.has(entry.category));
}

function failClosedEntries(entries) {
  return entries.filter((entry) => FAIL_CLOSED_CATEGORIES.has(entry.category));
}

// Decide what the effective array should look like. Pure — returns an edit
// plan the caller turns into JSONC edits. Never mutates the array.
//
// Returns one of:
//   { action:"noop" }                          already exactly one canonical
//   { action:"append", canonical }             no safe owned entry; append
//   { action:"edit", replace:[...], remove:[...], canonical, canonicalTuple }
//   { action:"needs-review", reason, details } fail closed, zero mutation
//   { action:"ownership-conflict", reason, details }
function planEffectiveArray(pluginArray, ctx, options = {}) {
  const canonical = options.canonicalEntry;
  const classification = classifyPluginEntries(pluginArray, ctx);
  const entries = classification.entries;
  const blocking = failClosedEntries(entries);
  if (blocking.length) {
    return {
      action: "needs-review",
      reason: blocking[0].category,
      classification,
      details: blocking.map((entry) => ({
        category: entry.category,
        reason: entry.reason || null,
        remediation: describeRemediation(entry, options.configPath),
      })),
    };
  }

  const owned = safeOwned(entries);
  if (!owned.length) {
    return { action: "append", canonical, classification };
  }

  // Tuple options must agree before we can converge duplicates.
  const optionSets = [];
  for (const entry of owned) {
    if (entry.shape !== "tuple") continue;
    if (!optionSets.some((set) => sameOptions(set, entry.options))) optionSets.push(entry.options);
  }
  if (optionSets.length > 1) {
    return {
      action: "ownership-conflict",
      reason: "tuple-options-conflict",
      classification,
      details: owned.filter((entry) => entry.shape === "tuple").map((entry) => ({
        configPath: options.configPath,
        index: entry.index,
        options: entry.options,
      })),
    };
  }

  const keep = owned[0];
  const remove = owned.slice(1).map((entry) => entry.index).sort((a, b) => a - b);
  const keepIsTuple = keep.shape === "tuple";
  const replace = [];
  const currentSpecifier = keep.canonical === ctx.expectedCanonicalDir && keep.category === "canonical-current"
    ? keep.specifier
    : null;
  // Replacement carries the SPECIFIER only. For a tuple the caller rewrites
  // `plugin[index][0]` with this string, preserving `plugin[index][1]`
  // value-for-value. Returning `[canonical, options]` here corrupts the array
  // (nested tuple) — see #1026 r1 P0.
  if (!(keep.category === "canonical-current" && keep.specifier === canonical && !keepIsTuple)) {
    replace.push({
      index: keep.index,
      specifier: canonical,
      tuple: keepIsTuple,
    });
  }

  if (!replace.length && !remove.length) {
    return { action: "noop", classification };
  }
  return {
    action: "edit",
    canonical,
    canonicalTuple: keepIsTuple,
    replace,
    remove,
    classification,
    currentSpecifier,
  };
}

// Decide which entries a proven-owned unregister sweep removes. `ctx` is the
// same classifier context; the caller supplies the candidate file's array.
function planUnregisterArray(pluginArray, ctx, options = {}) {
  const classification = classifyPluginEntries(pluginArray, ctx);
  const removable = classification.entries
    .filter((entry) => OWNED_SAFE_CATEGORIES.has(entry.category))
    .map((entry) => entry.index)
    .sort((a, b) => a - b);
  const retained = classification.entries
    .filter((entry) => !OWNED_SAFE_CATEGORIES.has(entry.category))
    .map((entry) => entry);
  return {
    classification,
    remove: removable,
    retained,
    failClosed: retained.filter((entry) => FAIL_CLOSED_CATEGORIES.has(entry.category)),
  };
}

module.exports = {
  OWNED_SAFE_CATEGORIES,
  FAIL_CLOSED_CATEGORIES,
  parseEntry,
  isAbsoluteAnyPlatform,
  basenameAnyPlatform,
  stableStringify,
  sameOptions,
  describeRemediation,
  classifyPluginEntries,
  planEffectiveArray,
  planUnregisterArray,
  __test: { isPathWithin, safeOwned, failClosedEntries },
};
