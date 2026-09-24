"use strict";
// opencode v2 `plugins` config-key registration (issue #1039).
//
// OpenCode 2.x reads the renamed top-level `plugins` key and requires the
// `{ id, setup }` plugin form, so the installer registers a second, v2-only
// entry beside the v1 `plugin` key entry (both point into the SAME managed
// generation). Verified host tolerances that make dual-key coexistence safe —
// docs/investigations/opencode-v2-e1-evidence.md:
//   - opencode 2.0.15 loads `plugins` entries and merely logs a load warning
//     for the legacy `plugin` key's v1 function entry (host stays healthy).
//   - opencode 1.18.32 silently DROPS an unknown `plugins` key (true for
//     1.18.16+ only — see the version-bound note below); the v1 config keeps
//     parsing and the v1 entry keeps loading.
//
// The v1 managed planner (opencode-family-jsonc.js) is intentionally NOT
// parameterized for this: the v2 key contract is a strict subset (Clawd only
// ever writes bare string specifiers; v2 tuple/object entries are third-party
// shapes that must be preserved verbatim). Sharing the v1 planner would thread
// tuple/legacy-literal machinery through a path that can never use it, so this
// module reuses only the ownership classifier and the atomic write helpers.
//
// Same hard invariants as #1026: complete plan validated before any write,
// masked lower-priority files cleaned before the effective file, fail-closed
// categories refuse mutation, no plan ever touches a foreign entry, and
// every entry removal of a legacy-missing candidate re-proves absence first.
//
// Upstream PR #1045 review: the silent-drop tolerance is version-bound. It was
// probed on 1.18.32 only; opencode <= 1.18.15 REJECTS unknown top-level keys
// ("Unrecognized key: plugins") — unknown fields are ignored only since
// 1.18.16 (anomalyco/opencode#41312). Whether the `plugins` key is written at
// all is therefore decided by the caller from the detected host version
// (hooks/opencode-host-detect.js): "v2" registers, "v1" sweeps proven-owned
// leftovers, "unknown" never touches the key. This module itself stays
// version-agnostic: it only ever edits the key it is told to edit.

const fs = require("fs");
const path = require("path");
const { parseTree, findNodeAtLocation, modify, applyEdits } = require("jsonc-parser");
const entryOwnership = require("./opencode-family-entry-ownership");
const managedGeneration = require("./opencode-family-managed-generation");
const jsonc = require("./opencode-family-jsonc");
const { readTextFileStripBom, writeTextAtomic } = require("./json-utils");

const V2_PLUGIN_KEY = "plugins";
const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };

function formattingFor(text) {
  return /\n\t/.test(text)
    ? { formattingOptions: { insertSpaces: false, tabSize: 1 } }
    : { formattingOptions: { insertSpaces: true, tabSize: 2 } };
}

function fileMode(filePath) {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}

function isObjectRoot(tree) {
  return !!tree && typeof tree === "object" && !Array.isArray(tree);
}

function hasV2Array(state) {
  return !!state && state.exists && isObjectRoot(state.tree) && Array.isArray(state.tree[V2_PLUGIN_KEY]);
}

// #825 merge semantics apply to every global config array: the effective file
// is the highest-priority candidate that DECLARES the key; when none does, the
// highest-priority existing file (nothing shadows a key it doesn't declare).
function selectEffectiveV2(states) {
  return states.find(hasV2Array) || states.find((state) => state.exists) || null;
}

function assertSingleV2Property(text, configPath) {
  const root = parseTree(text, [], PARSE_OPTIONS);
  if (!root || root.type !== "object" || !Array.isArray(root.children)) return;
  let count = 0;
  for (const prop of root.children) {
    const keyNode = Array.isArray(prop.children) ? prop.children[0] : null;
    if (keyNode && keyNode.value === V2_PLUGIN_KEY) count++;
  }
  if (count > 1) {
    throw new Error(`Failed to read ${configPath}: duplicate top-level "${V2_PLUGIN_KEY}" keys (${count}) — refusing to edit an ambiguous config`);
  }
}

function readV2Candidates(cfg, configPath) {
  const paths = jsonc.__test.candidatePaths(cfg, configPath);
  return paths.map((candidate) => {
    let text = null;
    try {
      text = readTextFileStripBom(candidate, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return { path: candidate, exists: false, text: null, tree: null };
      throw new Error(`Failed to read ${candidate}: ${err.message}`);
    }
    const tree = jsonc.__test.parseJsoncStrict(text, candidate);
    assertSingleV2Property(text, candidate);
    return { path: candidate, exists: true, text, tree };
  });
}

// The shared classifier is shape-agnostic; for v2 the ONLY owned shape is a
// bare string specifier (the object `{ package, options }` form is legal v2
// config syntax but is third-party surface Clawd never writes — preserved
// verbatim like any other foreign entry).
function classifyV2PluginEntries(pluginArray, ctx) {
  const result = entryOwnership.classifyPluginEntries(pluginArray, ctx);
  for (const entry of result.entries) {
    if (typeof entry.rawEntry !== "string") {
      entry.category = "foreign";
      entry.reason = "v2-non-string-entry";
      entry.canonical = null;
      entry.tuple = false;
      entry.options = undefined;
    }
  }
  return result;
}

function planV2RegisterArray(pluginArray, ctx, { canonicalV2Entry }) {
  const { entries } = classifyV2PluginEntries(pluginArray, ctx);
  const failClosed = entries.filter((entry) => entryOwnership.FAIL_CLOSED_CATEGORIES.has(entry.category));
  if (failClosed.length) {
    return {
      action: "needs-review",
      reason: failClosed[0].category,
      message: `refusing to edit the "${V2_PLUGIN_KEY}" array: ${failClosed[0].category} entry at index ${failClosed[0].index}${failClosed[0].reason ? ` (${failClosed[0].reason})` : ""}`,
      entries: failClosed,
    };
  }
  const canonicalCurrent = entries.filter((entry) => entry.category === "canonical-current");
  const remove = entries.filter((entry) => entryOwnership.OWNED_SAFE_CATEGORIES.has(entry.category)
    && entry.category !== "canonical-current");
  if (canonicalCurrent.length > 1) remove.push(...canonicalCurrent.slice(1));
  if (canonicalCurrent.length >= 1 && remove.length === 0) return { action: "noop", remove: [], append: false };
  return {
    action: "edit",
    remove,
    // A canonical-current entry survives the removals → nothing to add;
    // otherwise the canonical entry is appended after the sweep.
    append: canonicalCurrent.length === 0,
  };
}

function planV2UnregisterArray(pluginArray, ctx) {
  const { entries } = classifyV2PluginEntries(pluginArray, ctx);
  const remove = entries.filter((entry) => entryOwnership.OWNED_SAFE_CATEGORIES.has(entry.category));
  const retained = entries.filter((entry) => !entryOwnership.OWNED_SAFE_CATEGORIES.has(entry.category));
  return {
    remove,
    retained,
    failClosed: retained.filter((entry) => entryOwnership.FAIL_CLOSED_CATEGORIES.has(entry.category)),
  };
}

// Ownership context for the v2 entry directory. Mirrors
// jsonc.buildManagedContext but binds cfg.v2PluginDirName; the owner-record
// marker shape check keeps validating the V1 marker (the shared owner.json
// points at the v1 entry — the v2 entry has no owner marker of its own).
function buildV2ManagedContext({ cfg, target, expectedCanonicalDir, expectedGeneration, sourceFiles, ownerRecord, fsImpl, platform, managedBoundary }) {
  const fsy = fsImpl || fs;
  const plat = platform || process.platform;
  const base = jsonc.buildManagedContext({
    cfg,
    target,
    expectedCanonicalDir,
    expectedGeneration,
    sourceFiles,
    ownerRecord,
    fsImpl,
    platform,
    managedBoundary,
  });
  const v2PluginDirName = cfg.v2PluginDirName;
  const v1PluginDirName = cfg.pluginDirName;
  // Capture BEFORE Object.assign mutates base — the override delegates to the
  // original v1-dir boundary check (same generation, owner marker on the v1
  // entry dir), so a late binding would recurse into itself.
  const baseInspectBoundary = base.inspectManagedBoundary;
  return Object.assign(base, {
    pluginDirName: v2PluginDirName,
    inspectManagedBoundary: (value) => {
      const abs = path.resolve(value);
      const dirName = path.posix.basename(abs.replace(/\\/g, "/"));
      if (dirName !== v2PluginDirName) return { state: "corrupt", reason: "boundary-plugin-name" };
      return baseInspectBoundary(path.join(path.dirname(abs), v1PluginDirName));
    },
    bundleBytesMatch: (value) => (
      Array.isArray(sourceFiles) && sourceFiles.length
        ? managedGeneration.bundleBytesMatch(value, cfg, sourceFiles, fsy)
        : false
    ),
  });
}

// v2-specific remediation text: the shared describeRemediation names the
// "plugin" array, which is the wrong key for v2 entries.
function describeV2Remediation(entry, candidatePath) {
  const literal = JSON.stringify(entry.rawEntry);
  return {
    configPath: candidatePath,
    index: entry.index,
    literal,
    steps: [
      `Open ${candidatePath}.`,
      `In the top-level "${V2_PLUGIN_KEY}" array, remove or replace element ${entry.index}: ${literal}.`,
      "Replace it with the managed Clawd v2 plugin path shown by Doctor/Install, then re-run Repair.",
    ],
  };
}

function skipTriviaForward(text, pos) {
  let cursor = pos;
  for (;;) {
    while (cursor < text.length && /[ \t\r\n]/.test(text[cursor])) cursor++;
    if (text[cursor] === "/" && text[cursor + 1] === "/") {
      while (cursor < text.length && text[cursor] !== "\n") cursor++;
      continue;
    }
    if (text[cursor] === "/" && text[cursor + 1] === "*") {
      const close = text.indexOf("*/", cursor + 2);
      if (close === -1) return cursor;
      cursor = close + 2;
      continue;
    }
    return cursor;
  }
}

// Same span-surgery contract as jsonc.removeEntriesFromText, bound to the
// `plugins` key: upstream jsonc-parser's modify() corrupts single-line-array
// removals and swallows adjacent user comments, so elements are removed by
// exact parse-tree span plus ONE adjacent comma. Takes plain indexes.
function removeV2EntriesFromText(text, indexes) {
  const root = parseTree(text, [], PARSE_OPTIONS);
  const arr = root ? findNodeAtLocation(root, [V2_PLUGIN_KEY]) : null;
  if (!arr || !Array.isArray(arr.children)) return text;

  const spans = indexes.map((index) => {
    const node = arr.children[index];
    if (!node) return null;
    let start = node.offset;
    let end = node.offset + node.length;

    const cursor = skipTriviaForward(text, end);
    if (text[cursor] === ",") {
      end = cursor + 1;
    } else {
      let back = start - 1;
      while (back >= 0 && /[ \t\r\n]/.test(text[back])) back--;
      if (text[back] === ",") start = back;
    }

    let lineStart = start;
    while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
    let lineEnd = end;
    while (lineEnd < text.length && text[lineEnd] !== "\n") lineEnd++;
    if (/^[ \t]*$/.test(text.slice(lineStart, start)) && /^[ \t\r]*$/.test(text.slice(end, lineEnd))) {
      start = lineStart;
      end = Math.min(lineEnd + 1, text.length);
    }
    return { start, end };
  }).filter(Boolean);

  spans.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  let out = text;
  for (let k = merged.length - 1; k >= 0; k--) {
    out = out.slice(0, merged[k].start) + out.slice(merged[k].end);
  }
  return out;
}

// Apply one plan's removals (by entry index) to config text.
function v2ArrayEdits(text, plan) {
  if (!plan.remove.length) return text;
  return removeV2EntriesFromText(text, plan.remove.map((entry) => entry.index));
}

// Append the whole `plugins` array to an object-root config that has none.
function appendV2Key(text, canonicalV2Entry) {
  return applyEdits(text, modify(text, [V2_PLUGIN_KEY], [canonicalV2Entry], formattingFor(text)));
}

function appendV2Entry(text, canonicalV2Entry) {
  return applyEdits(text, modify(text, [V2_PLUGIN_KEY, -1], canonicalV2Entry, { ...formattingFor(text), isArrayInsertion: true }));
}

// Read-only pre-scan (lock-free). Mirrors inspectManagedRegister's contract.
function inspectV2Register({ cfg, configPath, candidates, makeContext, canonicalV2Entry }) {
  const states = candidates;
  const effective = selectEffectiveV2(states);
  const warnings = [];
  let needsReview = null;
  let needsMutation = false;

  for (const state of states) {
    const isEffective = state === effective;
    if (!hasV2Array(state)) {
      if (isEffective && state.exists) needsMutation = true; // object root without the key → add it
      continue;
    }
    const ctx = makeContext(state.path);
    const classification = classifyV2PluginEntries(state.tree[V2_PLUGIN_KEY], ctx);
    if (isEffective) {
      const plan = planV2RegisterArray(state.tree[V2_PLUGIN_KEY], ctx, { canonicalV2Entry });
      if (plan.action === "needs-review") needsReview = plan;
      else if (plan.action !== "noop") needsMutation = true;
      const pending = classification.entries.some((entry) => entry.category === "canonical-current" && entry.generationPending);
      if (pending) needsMutation = true;
    } else {
      const plan = planV2UnregisterArray(state.tree[V2_PLUGIN_KEY], ctx);
      if (plan.remove.length) needsMutation = true;
      for (const entry of plan.failClosed) {
        warnings.push(`masked ${entry.category} entry at ${state.path}[${entry.index}] retained (${JSON.stringify(entry.rawEntry)})`);
      }
    }
  }

  if (!effective) {
    // No config file exists at all. The v1 `plugin`-key register creates the
    // default file; standalone callers get an explicit skip instead of this
    // module fabricating a config it does not own.
    warnings.push(`no opencode config file exists; the "${V2_PLUGIN_KEY}" key was not written`);
  }
  return { effective, warnings, needsReview, needsMutation };
}

// Write the `plugins` key changes. MUST run inside the target lock, after the
// generation (including the v2 entry file) has been materialized. `candidates`
// MUST be freshly read by the caller — the v1 `plugin`-key write may have
// mutated the same files moments earlier inside the same lock.
function applyV2Register({ cfg, configPath, candidates, makeContext, canonicalV2Entry, options = {} }) {
  const fsImpl = options.fs || fs;
  const states = candidates;
  const effective = selectEffectiveV2(states);
  const warnings = [];

  // ---- Plan phase (zero mutation) ----
  const lowerEdits = [];
  for (const state of states) {
    if (state === effective || !hasV2Array(state)) continue;
    const ctx = makeContext(state.path);
    const plan = planV2UnregisterArray(state.tree[V2_PLUGIN_KEY], ctx);
    if (plan.remove.length) lowerEdits.push({ state, remove: plan.remove });
    for (const entry of plan.failClosed) {
      warnings.push(`masked ${entry.category} entry at ${state.path}[${entry.index}] retained (${JSON.stringify(entry.rawEntry)})`);
    }
  }

  let effectiveEdit;
  if (!effective) {
    return {
      status: "ok",
      added: false,
      created: false,
      skipped: true,
      mutatedPaths: [],
      warnings: [`no opencode config file exists; the "${V2_PLUGIN_KEY}" key was not written`],
    };
  }
  if (!isObjectRoot(effective.tree)) {
    return {
      status: "error",
      reason: "config-root-not-object",
      message: `refusing to edit ${effective.path}: config root is not an object`,
      mutatedPaths: [],
      warnings,
    };
  }
  if (!hasV2Array(effective)) {
    effectiveEdit = { kind: "rewrite-plugins" };
  } else {
    const ctx = makeContext(effective.path);
    const plan = planV2RegisterArray(effective.tree[V2_PLUGIN_KEY], ctx, { canonicalV2Entry });
    if (plan.action === "needs-review") {
      return {
        status: "error",
        reason: plan.reason,
        message: plan.message,
        mutatedPaths: [],
        warnings,
        plan,
      };
    }
    effectiveEdit = { kind: plan.action === "noop" ? "noop" : "edit", plan };
  }

  // Re-prove absence for every legacy-missing candidate across ALL files
  // before any write (same bargain as the v1 sweep).
  for (const state of states) {
    if (!hasV2Array(state)) continue;
    const ctx = makeContext(state.path);
    const { entries } = classifyV2PluginEntries(state.tree[V2_PLUGIN_KEY], ctx);
    for (const entry of entries) {
      if (entry.category !== "legacy-missing-candidate") continue;
      const check = jsonc.missingPathStillAbsent(entry.specifier, { fs: fsImpl, platform: options.platform });
      if (!check.absent) {
        return {
          status: "error",
          reason: "legacy-missing-candidate-unconfirmable",
          message: `refusing to edit ${state.path}: ${entry.specifier} is no longer provably absent (${check.reason})`,
          mutatedPaths: [],
          warnings,
        };
      }
    }
  }

  const pendingPaths = [
    ...lowerEdits.map((edit) => edit.state.path),
    effective.path,
  ];

  // ---- Execute phase: masked lower files first, effective last ----
  const mutatedPaths = [];
  let added = false;
  try {
    for (const edit of lowerEdits) {
      const nextText = v2ArrayEdits(edit.state.text, { remove: edit.remove });
      writeTextAtomic(edit.state.path, nextText, { mode: fileMode(edit.state.path) });
      mutatedPaths.push(edit.state.path);
    }
    if (effectiveEdit.kind === "rewrite-plugins") {
      const text = appendV2Key(effective.text, canonicalV2Entry);
      writeTextAtomic(effective.path, text, { mode: fileMode(effective.path) });
      mutatedPaths.push(effective.path);
      added = true;
    } else if (effectiveEdit.kind === "edit") {
      let text = v2ArrayEdits(effective.text, effectiveEdit.plan);
      if (effectiveEdit.plan.append) {
        text = appendV2Entry(text, canonicalV2Entry);
      }
      writeTextAtomic(effective.path, text, { mode: fileMode(effective.path) });
      mutatedPaths.push(effective.path);
      added = true;
    }
  } catch (err) {
    return {
      status: "error",
      reason: "config-write-failed",
      message: err && err.message ? err.message : "failed to write opencode config",
      mutatedPaths,
      pendingPaths: pendingPaths.filter((p) => !mutatedPaths.includes(p)),
      warnings,
    };
  }

  return { status: "ok", added, created: false, mutatedPaths, pendingPaths: [], warnings };
}

// Read-only unregister scan. `registrationRemoved` MUST be derived from
// activeEntryRemaining here, never from "we attempted a sweep".
function inspectV2Unregister({ candidates, makeContext }) {
  const states = candidates;
  const effective = selectEffectiveV2(states);
  const warnings = [];
  const failClosedActive = [];
  let hasRemovable = false;
  let activeEntryRemaining = false;

  for (const state of states) {
    if (!hasV2Array(state)) continue;
    const ctx = makeContext(state.path);
    const plan = planV2UnregisterArray(state.tree[V2_PLUGIN_KEY], ctx);
    if (plan.remove.length) hasRemovable = true;
    if (state === effective) {
      // Everything proven-owned is swept, so the only thing that can keep an
      // active registration alive post-sweep is a fail-closed entry.
      if (plan.failClosed.length) activeEntryRemaining = true;
      for (const entry of plan.failClosed) failClosedActive.push({ path: state.path, entry });
    } else {
      for (const entry of plan.failClosed) {
        warnings.push(`masked ${entry.category} entry at ${state.path}[${entry.index}] retained (${JSON.stringify(entry.rawEntry)})`);
      }
    }
  }

  return { effective, hasRemovable, activeEntryRemaining, failClosedActive, warnings };
}

// Sweep proven-owned entries from every candidate's `plugins` array.
function applyV2Unregister({ cfg, configPath, candidates, makeContext, options = {} }) {
  const fsImpl = options.fs || fs;
  const states = candidates;
  const effective = selectEffectiveV2(states);
  const warnings = [];

  for (const state of states) {
    if (!hasV2Array(state)) continue;
    const ctx = makeContext(state.path);
    const { entries } = classifyV2PluginEntries(state.tree[V2_PLUGIN_KEY], ctx);
    for (const entry of entries) {
      if (entry.category !== "legacy-missing-candidate") continue;
      const check = jsonc.missingPathStillAbsent(entry.specifier, { fs: fsImpl, platform: options.platform });
      if (!check.absent) {
        return {
          removed: 0,
          changed: false,
          mutatedPaths: [],
          warnings: [...warnings, `refusing to sweep ${state.path}: ${entry.specifier} is no longer provably absent (${check.reason})`],
          activeEntryRemaining: true,
          effectivePath: configPath,
          error: { reason: "legacy-missing-candidate-unconfirmable", configPath: state.path, specifier: entry.specifier },
        };
      }
    }
  }

  let removed = 0;
  let changed = false;
  const mutatedPaths = [];
  let activeEntryRemaining = false;
  let effectivePath = configPath;
  const failClosedActive = [];

  for (const state of states) {
    if (!hasV2Array(state)) continue;
    const ctx = makeContext(state.path);
    const plan = planV2UnregisterArray(state.tree[V2_PLUGIN_KEY], ctx);
    if (state === effective) {
      effectivePath = state.path;
      if (plan.failClosed.length) activeEntryRemaining = true;
      for (const entry of plan.failClosed) failClosedActive.push({ path: state.path, entry });
    }
    if (!plan.remove.length) continue;
    const nextText = v2ArrayEdits(state.text, plan);
    writeTextAtomic(state.path, nextText, { mode: fileMode(state.path) });
    mutatedPaths.push(state.path);
    removed += plan.remove.length;
    changed = true;
  }

  return {
    removed,
    changed,
    mutatedPaths,
    warnings,
    activeEntryRemaining,
    effectivePath,
    failClosedActive,
    error: null,
  };
}

function verifyV2RegisterPostcondition({ cfg, configPath, makeContext }) {
  const states = readV2Candidates(cfg, configPath);
  const effective = selectEffectiveV2(states);
  if (!effective || !hasV2Array(effective)) {
    return { ok: false, reason: "no-effective-plugins-array" };
  }
  const { entries } = classifyV2PluginEntries(effective.tree[V2_PLUGIN_KEY], makeContext(effective.path));
  const canonicalCount = entries.filter((entry) => entry.category === "canonical-current").length;
  if (canonicalCount !== 1) return { ok: false, reason: `canonical-entry-count-${canonicalCount}` };
  if (entries.some((entry) => entryOwnership.FAIL_CLOSED_CATEGORIES.has(entry.category))) {
    return { ok: false, reason: "fail-closed-entry-remains" };
  }
  return { ok: true };
}

module.exports = {
  V2_PLUGIN_KEY,
  classifyV2PluginEntries,
  planV2RegisterArray,
  planV2UnregisterArray,
  buildV2ManagedContext,
  describeV2Remediation,
  inspectV2Register,
  applyV2Register,
  inspectV2Unregister,
  applyV2Unregister,
  verifyV2RegisterPostcondition,
  readV2Candidates,
  __test: {
    assertSingleV2Property,
    selectEffectiveV2,
    hasV2Array,
    appendV2Key,
    appendV2Entry,
    removeV2EntriesFromText,
  },
};
