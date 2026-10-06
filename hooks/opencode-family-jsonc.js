// JSONC editor for opencode-family members whose host config is JSONC
// (registry entries with jsonc: true — today only mimocode).
//
// The JSON path in opencode-family-install.js round-trips through
// JSON.parse/JSON.stringify, which would DESTROY user comments and trailing
// commas in a JSONC file. This module performs element-level edits with
// jsonc-parser (modify/applyEdits) so everything the user wrote survives;
// only the "plugin" array entry we manage is touched (plan §4.1).
//
// MERGED-CONFIG SEMANTICS (verified against MiMo Code v0.1.6 —
// config.ts:588-590, paths.ts:63-65, plugin/install.ts:349-355): the host
// merges EVERY file in cfg.configCandidates (lowest priority first at load,
// so the list here is highest-priority first), and array fields like
// "plugin" are REPLACED by the later file, not concatenated. Consequences
// (#607 review):
//   - register must edit the file whose "plugin" actually wins — writing a
//     fresh plugin array into a higher-priority file would silently mask
//     every plugin the user declared in a lower one;
//   - unregister must sweep ALL candidates, or a managed entry masked today
//     could resurrect when the user deletes the higher-priority file.
//
// Deliberately a SEPARATE module, lazy-required by the shared installer only
// when cfg.jsonc is set: hooks/json-utils.js is deployed to remote SSH hosts
// without node_modules and must stay dependency-free, so jsonc-parser must
// never be required from it (locked by a remote-closure guard test).
//
// Contract parity: registerJsonc/unregisterJsonc return the same shapes and
// print the same console lines as the JSON branch in makeFamilyInstaller —
// callers cannot tell the two apart. `configPath` in the return names the
// file actually edited.

const fs = require("fs");
const path = require("path");
const { parse, parseTree, findNodeAtLocation, modify, applyEdits } = require("jsonc-parser");
const {
  readTextFileStripBom,
  writeTextAtomic,
  writeTextAtomicWithBackup,
} = require("./json-utils");

// Default 2-space style for inserted elements (fresh files, space-indented
// configs).
const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

// Match the TARGET file's own indentation: hardcoding spaces would leave a
// tab-indented user config with mixed indentation (dual-review S-F4).
function formattingFor(text) {
  return /\n\t/.test(text)
    ? { formattingOptions: { insertSpaces: false, tabSize: 1 } }
    : FORMATTING;
}

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };

function normalizePluginEntry(value) {
  return String(value || "").replace(/\\/g, "/");
}

function entryIsExactManagedPlugin(entry, pluginDir) {
  return typeof entry === "string" && normalizePluginEntry(entry) === normalizePluginEntry(pluginDir);
}

// Ownership rule shared by register AND unregister: Clawd owns the exact
// managed path plus any ABSOLUTE entry whose directory basename matches the
// plugin dir (a stale install at another location). Register updates such
// entries in place; unregister must remove them too — an asymmetric sweep
// would leave a masked stale path in a lower-priority file to resurrect
// once the higher-priority file goes away (#607 review R8). npm package
// specifiers (never absolute) stay untouched.
function isManagedEntry(entry, pluginDir, pluginDirName) {
  if (typeof entry !== "string") return false;
  if (entryIsExactManagedPlugin(entry, pluginDir)) return true;
  const normalized = entry.replace(/\\/g, "/");
  const isAbsolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
  return isAbsolute && path.posix.basename(normalized) === pluginDirName;
}

// Preserve the target's permission bits across the rename-into-place write:
// a 0600 config holding provider tokens must not come back 0644 (R8 P1).
function fileMode(filePath) {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}

function parseJsoncStrict(text, configPath) {
  const errors = [];
  const tree = parse(text, errors, PARSE_OPTIONS);
  if (errors.length) {
    // Do not clobber a config we cannot fully understand — same stance as the
    // JSON branch on a JSON.parse failure.
    throw new Error(`Failed to read ${configPath}: invalid JSONC (${errors.length} parse error${errors.length === 1 ? "" : "s"})`);
  }
  return tree;
}

function freshConfigText(cfg, pluginDir) {
  const settings = cfg.schema ? { $schema: cfg.schema, plugin: [pluginDir] } : { plugin: [pluginDir] };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// Candidate files in HIGHEST-priority-first order. configPath is the
// create-default (join(configDir, cfg.configFileName)); its directory hosts
// the sibling candidates. A test override with a custom basename is
// prepended so single-file fixtures keep working.
function candidatePaths(cfg, configPath) {
  const dir = path.dirname(configPath);
  const names = Array.isArray(cfg.configCandidates) && cfg.configCandidates.length
    ? cfg.configCandidates
    : [cfg.configFileName];
  const paths = names.map((name) => path.join(dir, name));
  if (!paths.includes(configPath)) paths.unshift(configPath);
  return paths;
}

// A duplicate top-level "plugin" key makes the file AMBIGUOUS to edit:
// parse() resolves to the LAST value (what the host runs), but
// modify()/findNodeAtLocation() target the FIRST property node — an edit
// would change a dead array while reporting success, and a sweep would
// count matches in one array and delete from another (R10/GPT-5.5 P2,
// reproduced). Same do-not-clobber stance as a parse failure: refuse.
function assertSinglePluginProperty(text, configPath) {
  const root = parseTree(text, [], PARSE_OPTIONS);
  if (!root || root.type !== "object" || !Array.isArray(root.children)) return;
  let count = 0;
  for (const prop of root.children) {
    const keyNode = Array.isArray(prop.children) ? prop.children[0] : null;
    if (keyNode && keyNode.value === "plugin") count++;
  }
  if (count > 1) {
    throw new Error(`Failed to read ${configPath}: duplicate top-level "plugin" keys (${count}) — refusing to edit an ambiguous config`);
  }
}

// Read every candidate: { path, exists, text, tree }. Throws on a candidate
// that exists but cannot be parsed or carries duplicate "plugin" keys —
// editing around a file we cannot fully understand risks masking or
// clobbering user content.
function readCandidates(cfg, configPath) {
  return candidatePaths(cfg, configPath).map((candidate) => {
    let text = null;
    try {
      text = readTextFileStripBom(candidate, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return { path: candidate, exists: false, text: null, tree: null };
      throw new Error(`Failed to read ${candidate}: ${err.message}`);
    }
    const tree = parseJsoncStrict(text, candidate);
    assertSinglePluginProperty(text, candidate);
    return { path: candidate, exists: true, text, tree };
  });
}

function isObjectRoot(tree) {
  return !!tree && typeof tree === "object" && !Array.isArray(tree);
}

function declaresPlugin(state) {
  return state.exists && isObjectRoot(state.tree) && Object.prototype.hasOwnProperty.call(state.tree, "plugin");
}

// Same idempotency rule as the JSON branch: match by exact path OR by
// directory basename on an ABSOLUTE-path entry (stale installs at another
// location get updated in place; npm package specifiers — which can also
// live in the plugin array — are never touched because they aren't absolute).
function findManagedIndex(pluginArray, pluginDir, pluginDirName) {
  for (let i = 0; i < pluginArray.length; i++) {
    if (isManagedEntry(pluginArray[i], pluginDir, pluginDirName)) return i;
  }
  return -1;
}

// Position of the next non-trivia character at/after `pos`: skips whitespace
// (incl. newlines) and both comment forms. Used to find an element's
// separating comma even when a comment sits between them — scanning only
// horizontal whitespace would stop at the comment and leave a dangling comma
// behind (dual-review F1).
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

// Element removal is done with CUSTOM span surgery instead of jsonc-parser's
// modify(): upstream 3.3.1 emits a corrupt edit (dangling quote) when
// removing from a single-line array, and on multi-line arrays its removal
// span swallows trivia — i.e. USER COMMENTS — adjacent to the removed
// element (both probed). We compute each element's exact span from the
// parse tree and remove only the element token plus ONE adjacent comma, so
// comments before, after, and on neighboring lines always survive. A line
// left fully blank by the removal is consumed for tidiness.
function removeEntriesFromText(text, matches) {
  const root = parseTree(text, [], PARSE_OPTIONS);
  const arr = root ? findNodeAtLocation(root, ["plugin"]) : null;
  if (!arr || !Array.isArray(arr.children)) return text;

  const spans = matches.map((index) => {
    const node = arr.children[index];
    let start = node.offset;
    let end = node.offset + node.length;

    // Prefer eating the FOLLOWING comma — the next non-trivia token after
    // the element. Trivia between the element and its comma (e.g. an inline
    // /* note */) annotates the REMOVED element and goes with it; leaving it
    // would strand a dangling comma and corrupt the file. For a last
    // element, eat the PRECEDING comma instead.
    const cursor = skipTriviaForward(text, end);
    if (text[cursor] === ",") {
      end = cursor + 1;
    } else {
      let back = start - 1;
      while (back >= 0 && /[ \t\r\n]/.test(text[back])) back--;
      if (text[back] === ",") start = back;
    }

    // Consume the whole line when nothing but whitespace remains on it.
    let lineStart = start;
    while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
    let lineEnd = end;
    while (lineEnd < text.length && text[lineEnd] !== "\n") lineEnd++;
    // \r counts as blank so CRLF files don't keep a whitespace-only line
    // after a mid-array removal (dual-review F2).
    if (/^[ \t]*$/.test(text.slice(lineStart, start)) && /^[ \t\r]*$/.test(text.slice(end, lineEnd))) {
      start = lineStart;
      end = Math.min(lineEnd + 1, text.length);
    }
    return { start, end };
  });

  // Adjacent removed elements can claim the SAME comma (one eats forward,
  // the next eats backward) — merge overlapping spans into their union
  // before applying, or the later slice would use stale offsets.
  spans.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  // Apply back-to-front so earlier spans stay valid.
  let out = text;
  for (let k = merged.length - 1; k >= 0; k--) {
    out = out.slice(0, merged[k].start) + out.slice(merged[k].end);
  }
  return out;
}

function registerJsonc({ cfg, agentId, configPath, pluginDir, options = {} }) {
  const states = readCandidates(cfg, configPath);

  // Write target: the file whose "plugin" is effectively live (highest
  // priority declaring it) → else the highest-priority existing file →
  // else create the default file fresh.
  const target = states.find(declaresPlugin) || states.find((s) => s.exists) || null;

  let added = false;
  let skipped = false;
  let created = false;
  let editedPath = configPath;

  if (!target) {
    writeTextAtomic(configPath, freshConfigText(cfg, pluginDir));
    created = true;
    added = true;
  } else {
    editedPath = target.path;
    const mode = fileMode(target.path);
    let text = target.text;
    if (!isObjectRoot(target.tree)) {
      // Non-object root ("null", a bare number…). The JSON branch tolerates
      // this by starting over from {}; there are no meaningful comments to
      // preserve in a config with no object root, so we do the same.
      writeTextAtomic(target.path, freshConfigText(cfg, pluginDir), { mode });
      added = true;
    } else if (!Array.isArray(target.tree.plugin)) {
      // Missing or non-array "plugin" — (re)write just that property.
      text = applyEdits(text, modify(text, ["plugin"], [pluginDir], formattingFor(text)));
      writeTextAtomic(target.path, text, { mode });
      added = true;
    } else {
      const matchIndex = findManagedIndex(target.tree.plugin, pluginDir, cfg.pluginDirName);
      if (matchIndex === -1) {
        text = applyEdits(text, modify(text, ["plugin", -1], pluginDir, { ...formattingFor(text), isArrayInsertion: true }));
        writeTextAtomic(target.path, text, { mode });
        added = true;
      } else if (target.tree.plugin[matchIndex] !== pluginDir) {
        // Stale path (e.g. old install location) — update the element in place
        text = applyEdits(text, modify(text, ["plugin", matchIndex], pluginDir, formattingFor(text)));
        writeTextAtomic(target.path, text, { mode });
        added = true;
      } else {
        skipped = true;
      }
    }
  }

  if (!options.silent) {
    console.log(`Clawd ${agentId} plugin → ${editedPath}`);
    if (created) console.log(`  Created ${cfg.configFileName}`);
    if (added) console.log(`  Registered: ${pluginDir}`);
    if (skipped) console.log(`  Already registered: ${pluginDir}`);
  }

  return { added, skipped, created, configPath: editedPath, pluginDir };
}

function unregisterJsonc({ cfg, agentId, configPath, pluginDir, options = {} }) {
  const states = readCandidates(cfg, configPath);

  // Sweep EVERY candidate: an exact managed entry left in a lower-priority
  // file is masked today but becomes live the moment the higher-priority
  // file goes away.
  let removed = 0;
  const backupPaths = [];
  for (const state of states) {
    if (!state.exists || !isObjectRoot(state.tree) || !Array.isArray(state.tree.plugin)) continue;

    const matches = [];
    for (let i = 0; i < state.tree.plugin.length; i++) {
      if (isManagedEntry(state.tree.plugin[i], pluginDir, cfg.pluginDirName)) matches.push(i);
    }
    if (!matches.length) continue;

    const text = removeEntriesFromText(state.text, matches);
    const backupPath = writeTextAtomicWithBackup(state.path, text, { ...options, mode: fileMode(state.path) });
    if (backupPath) backupPaths.push(backupPath);
    removed += matches.length;
  }

  const changed = removed > 0;
  if (!options.silent) console.log(`Clawd ${agentId} plugin entries removed: ${removed}`);
  const result = { removed, changed, skipped: !changed, configPath, pluginDir };
  if (options.backup === true) {
    result.backupPath = backupPaths[0] || null;
    result.backupPaths = backupPaths;
  }
  return result;
}

// ===========================================================================
// #1026 managed-generation path (managedMaterialization:true members only).
//
// The legacy registerJsonc/unregisterJsonc above keep their broad-basename
// ownership for MiMo. The functions below are the hardened planner used by
// OpenCode: shared entry classifier, verified tuple support, duplicate
// convergence, fail-closed ambiguous handling, masked-lower cleanup and a
// pre-write recheck for the single missing legacy candidate.
// ===========================================================================

const managedGeneration = require("./opencode-family-managed-generation");
const entryOwnership = require("./opencode-family-entry-ownership");

function canonicalOf(value, platform, fsImpl) {
  return managedGeneration.canonicalizeTargetPath(value, platform || process.platform, fsImpl || fs);
}

function isClawdLikeDir(dir, fsImpl) {
  const fsy = fsImpl || fs;
  try {
    const source = fsy.readFileSync(path.join(dir, "index.mjs"), "utf8");
    if (/createOpencodeFamilyPlugin|opencode-family-plugin\/core\.mjs/.test(source)) return true;
  } catch {
    // fall through to the sibling-probe below
  }
  try {
    const sibling = path.join(path.dirname(dir), "opencode-family-plugin", "core.mjs");
    fsy.statSync(sibling);
    return true;
  } catch {
    return false;
  }
}

// The nearest existing ancestor of a path must be enumerable, and on Windows
// the volume root too. A path we cannot even enumerate is not provably absent
// (#1026 §6.1 step 9), so callers must fail closed rather than assume. Only
// ENOENT may be skipped while climbing; EACCES/EPERM/any other error is
// indeterminate (climbing past it could silently reach a readable higher
// ancestor and produce a false "absent").
function nearestExistingAncestor(target, fsImpl) {
  let cursor = path.resolve(target);
  for (;;) {
    try {
      fsImpl.statSync(cursor);
      return { ancestor: cursor, indeterminate: false, reason: null };
    } catch (err) {
      const code = err && err.code;
      if (code && code !== "ENOENT") {
        return { ancestor: null, indeterminate: true, reason: `ancestor-stat-${code}` };
      }
      if (!code) return { ancestor: null, indeterminate: true, reason: "ancestor-stat-unknown" };
      const parent = path.dirname(cursor);
      if (parent === cursor) return { ancestor: null, indeterminate: true, reason: "no-existing-ancestor" };
      cursor = parent;
    }
  }
}

function missingPathStillAbsent(specifier, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  try {
    fsImpl.statSync(specifier);
    return { absent: false, reason: "path-reappeared" };
  } catch (err) {
    if (err && err.code !== "ENOENT") return { absent: false, reason: `indeterminate:${err.code || err.message}` };
  }
  const lookup = nearestExistingAncestor(specifier, fsImpl);
  if (lookup.indeterminate) return { absent: false, reason: lookup.reason || "ancestor-indeterminate" };
  const ancestor = lookup.ancestor;
  try {
    fsImpl.readdirSync(ancestor);
  } catch (err) {
    return { absent: false, reason: `ancestor-unreadable:${err && err.code}` };
  }
  if (platform === "win32") {
    const parsed = path.win32.parse(specifier);
    const root = parsed.root;
    if (root) {
      try {
        fsImpl.readdirSync(root);
      } catch (err) {
        return { absent: false, reason: `volume-root-unreadable:${err && err.code}` };
      }
    }
  }
  return { absent: true };
}

function buildManagedContext({ cfg, target, expectedCanonicalDir, expectedGeneration, sourceFiles, ownerRecord, fsImpl, platform, managedBoundary }) {
  const fsy = fsImpl || fs;
  const plat = platform || process.platform;
  const known = new Set();
  if (ownerRecord && Array.isArray(ownerRecord.knownRegisteredPaths)) {
    for (const value of ownerRecord.knownRegisteredPaths) {
      const canonical = canonicalOf(value, plat, fsy);
      if (canonical) known.add(canonical);
    }
  }
  return {
    fs: fsy,
    platform: plat,
    pluginDirName: cfg.pluginDirName,
    expectedCanonicalDir: expectedCanonicalDir || null,
    targetRoot: managedBoundary ? canonicalOf(target.targetRoot, plat, fsy) : null,
    sourcePluginDir: null,
    knownRegisteredPaths: known,
    canonicalize: (value) => canonicalOf(value, plat, fsy),
    canonicalizeStrict: (value) => managedGeneration.canonicalizeTargetPathStrict(value, plat, fsy),
    exists: (value) => {
      try { fsy.statSync(value); return true; } catch { return false; }
    },
    probeIndeterminate: (value) => {
      try {
        fsy.statSync(value);
        return false;
      } catch (err) {
        if (err && err.code === "ENOENT") return false;
        return true;
      }
    },
    inspectExpectedGeneration: () => (typeof expectedGeneration === "function" ? expectedGeneration() : { ok: true }),
    inspectManagedBoundary: (value) => {
      const abs = path.resolve(value);
      const base = path.posix.basename(abs.replace(/\\/g, "/"));
      if (base !== cfg.pluginDirName) return { state: "corrupt", reason: "boundary-plugin-name" };
      const genDir = path.dirname(abs);
      const gensDir = path.dirname(genDir);
      if (managedBoundary && canonicalOf(gensDir, plat, fsy) !== canonicalOf(target.generationsDir, plat, fsy)) {
        return { state: "corrupt", reason: "boundary-outside-generations" };
      }
      const inspected = managedGeneration.inspectGeneration(genDir, cfg, target.agentId, { fs: fsy });
      if (!inspected.ok) return { state: "corrupt", reason: inspected.reason };
      if (!managedBoundary) {
        // configPath-only / override: still require the layout's own target
        // owner record (same identity rule the plugin inert gate uses) rather
        // than trusting a bare manifest.
        const agentHome = path.dirname(gensDir);
        const ownerPath = path.join(agentHome, "owner.json");
        let owner = null;
        try {
          const text = fsy.readFileSync(ownerPath, "utf8");
          owner = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
        } catch {
          return { state: "corrupt", reason: "boundary-owner-record-missing" };
        }
        // Shared owner-shape contract (literal/agent/history/source pairing
        // includes the expected <root>/<pluginDirName>/index.mjs marker).
        const shape = managedGeneration.validateOwnerShape(owner, {
          agentId: target.agentId,
          pluginDirName: cfg.pluginDirName,
          fs: fsy,
          platform: plat,
        });
        if (!shape.ok) return { state: "corrupt", reason: `boundary-owner-${shape.reason}` };
        const expectedHash = path.basename(agentHome).toLowerCase();
        if (typeof owner.configDirHash !== "string" || owner.configDirHash.toLowerCase() !== expectedHash) {
          return { state: "corrupt", reason: "boundary-owner-hash-mismatch" };
        }
      }
      return { state: "owned" };
    },
    bundleBytesMatch: (value) => (
      Array.isArray(sourceFiles) && sourceFiles.length
        ? managedGeneration.bundleBytesMatch(value, cfg, sourceFiles, fsy)
        : false
    ),
    isClawdLike: (value) => isClawdLikeDir(value, fsy),
  };
}

function candidateHasPluginArray(state) {
  return !!state && state.exists && isObjectRoot(state.tree) && Array.isArray(state.tree.plugin);
}

function selectEffective(states) {
  return states.find(declaresPlugin) || states.find((state) => state.exists) || null;
}

// Replace ONLY the specifier. For a tuple (`[specifier, options]`) this edits
// element 0 and leaves element 1 value-for-value intact. Passing the whole
// `[canonical, options]` array here would nest the tuple (#1026 r1 P0).
function applyReplace(text, index, specifier, isTuple) {
  const editPath = isTuple ? ["plugin", index, 0] : ["plugin", index];
  return applyEdits(text, modify(text, editPath, specifier, formattingFor(text)));
}

function applyAppend(text, value) {
  return applyEdits(text, modify(text, ["plugin", -1], value, { ...formattingFor(text), isArrayInsertion: true }));
}

// Read-only pre-scan used by the installer before it takes the target lock.
function inspectManagedRegister({ cfg, configPath, candidates, makeContext, canonicalEntry, legacyMissingRecheck }) {
  const states = candidates;
  const effective = selectEffective(states);
  const perFile = [];
  const warnings = [];
  let needsReview = null;
  let needsMutation = false;

  for (const state of states) {
    const isEffective = state === effective;
    if (!candidateHasPluginArray(state)) {
      if (isEffective) needsMutation = true; // effective is absent / non-array → (re)write
      continue;
    }
    const ctx = makeContext(state.path);
    const classification = entryOwnership.classifyPluginEntries(state.tree.plugin, ctx);
    perFile.push({ path: state.path, isEffective, classification });

    if (isEffective) {
      const plan = entryOwnership.planEffectiveArray(state.tree.plugin, ctx, { canonicalEntry, configPath: state.path });
      if (plan.action === "needs-review" || plan.action === "ownership-conflict") {
        needsReview = plan;
      } else if (plan.action !== "noop") {
        needsMutation = true;
      }
      const pending = classification.entries.some((entry) => entry.category === "canonical-current" && entry.generationPending);
      if (pending) needsMutation = true;
    } else {
      const plan = entryOwnership.planUnregisterArray(state.tree.plugin, ctx, {});
      if (plan.remove.length) needsMutation = true;
      for (const entry of plan.failClosed) {
        warnings.push(`masked ${entry.category} entry at ${state.path}[${entry.index}] retained (${JSON.stringify(entry.rawEntry)})`);
      }
    }
  }

  if (!effective) needsMutation = true; // create the default file fresh
  return { effective, perFile, warnings, needsReview, needsMutation };
}

// Write the config changes. MUST run inside the target lock, after the
// generation has been materialized (unless options.pluginDir override).
//
// The COMPLETE plan (masked-lower cleanups + effective edit) is validated
// BEFORE any file is written, so an ownership/conflict failure can never be
// reported after a destructive partial write.
function applyManagedRegister({ cfg, configPath, candidates, makeContext, canonicalEntry, options = {}, tupleContractVerified = false }) {
  const fsImpl = options.fs || fs;
  const states = candidates;
  const effective = selectEffective(states);
  const warnings = [];

  // ---- Plan phase (zero mutation) ----
  const lowerEdits = [];
  for (const state of states) {
    if (state === effective || !candidateHasPluginArray(state)) continue;
    const ctx = makeContext(state.path);
    const plan = entryOwnership.planUnregisterArray(state.tree.plugin, ctx, {});
    if (plan.remove.length) lowerEdits.push({ state, remove: plan.remove });
    for (const entry of plan.failClosed) {
      warnings.push(`masked ${entry.category} entry at ${state.path}[${entry.index}] retained (${JSON.stringify(entry.rawEntry)})`);
    }
  }

  let effectiveEdit;
  let legacyLiterals = [];
  if (!effective) {
    effectiveEdit = { kind: "create" };
  } else if (!isObjectRoot(effective.tree)) {
    effectiveEdit = { kind: "rewrite-object" };
  } else if (!Array.isArray(effective.tree.plugin)) {
    effectiveEdit = { kind: "rewrite-plugin" };
  } else {
    const ctx = makeContext(effective.path);
    const classification = entryOwnership.classifyPluginEntries(effective.tree.plugin, ctx);
    legacyLiterals = classification.entries
      .filter((entry) => entry.category === "legacy-missing-candidate")
      .map((entry) => entry.rawEntry);
    const plan = entryOwnership.planEffectiveArray(effective.tree.plugin, ctx, {
      canonicalEntry,
      configPath: effective.path,
      tupleContractVerified,
    });
    if (plan.action === "needs-review" || plan.action === "ownership-conflict") {
      return {
        status: "error",
        reason: plan.reason,
        message: `refusing to edit ${effective.path}: ${plan.reason}`,
        mutatedPaths: [],
        pendingPaths: [],
        warnings,
        plan,
      };
    }
    effectiveEdit = { kind: plan.action, plan };
  }

  const pendingPaths = [
    ...lowerEdits.map((edit) => edit.state.path),
    ...(effective ? [effective.path] : [configPath]),
  ];

  // Recheck every legacy-missing candidate across ALL files immediately before
  // ANY write. A path that reappeared or cannot be proven absent aborts with
  // zero config mutation.
  for (const state of states) {
    if (!candidateHasPluginArray(state)) continue;
    const ctx = makeContext(state.path);
    const classification = entryOwnership.classifyPluginEntries(state.tree.plugin, ctx);
    for (const entry of classification.entries) {
      if (entry.category !== "legacy-missing-candidate") continue;
      const check = missingPathStillAbsent(entry.specifier, { fs: fsImpl, platform: options.platform });
      if (!check.absent) {
        return {
          status: "error",
          reason: "legacy-missing-candidate-unconfirmable",
          message: `refusing to edit ${state.path}: ${entry.specifier} is no longer provably absent (${check.reason})`,
          mutatedPaths: [],
          pendingPaths,
          warnings,
        };
      }
    }
  }

  // ---- Execute phase: masked lower files first, effective last ----
  const mutatedPaths = [];
  let added = false;
  let created = false;
  try {
    for (const edit of lowerEdits) {
      const nextText = removeEntriesFromText(edit.state.text, edit.remove);
      writeTextAtomic(edit.state.path, nextText, { mode: fileMode(edit.state.path) });
      mutatedPaths.push(edit.state.path);
    }
    if (effectiveEdit.kind === "create") {
      writeTextAtomic(configPath, freshConfigText(cfg, canonicalEntry));
      mutatedPaths.push(configPath);
      added = true;
      created = true;
    } else if (effectiveEdit.kind === "rewrite-object") {
      writeTextAtomic(effective.path, freshConfigText(cfg, canonicalEntry), { mode: fileMode(effective.path) });
      mutatedPaths.push(effective.path);
      added = true;
    } else if (effectiveEdit.kind === "rewrite-plugin") {
      const text = applyEdits(effective.text, modify(effective.text, ["plugin"], [canonicalEntry], formattingFor(effective.text)));
      writeTextAtomic(effective.path, text, { mode: fileMode(effective.path) });
      mutatedPaths.push(effective.path);
      added = true;
    } else if (effectiveEdit.kind === "append") {
      const text = applyAppend(effective.text, canonicalEntry);
      writeTextAtomic(effective.path, text, { mode: fileMode(effective.path) });
      mutatedPaths.push(effective.path);
      added = true;
    } else if (effectiveEdit.kind === "edit") {
      let text = effective.text;
      for (const replace of effectiveEdit.plan.replace) {
        text = applyReplace(text, replace.index, replace.specifier, replace.tuple);
      }
      if (effectiveEdit.plan.remove.length) text = removeEntriesFromText(text, effectiveEdit.plan.remove);
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

  return { status: "ok", added, created, mutatedPaths, pendingPaths: [], warnings, legacyLiterals };
}

// Read-only unregister scan. Returns the effective view plus whether any
// proven-owned entry remains removable and whether an active fail-closed entry
// is present. Callers MUST derive `registrationRemoved` from this, never from
// "we attempted a sweep".
function inspectManagedUnregister({ candidates, makeContext }) {
  const states = candidates;
  const effective = selectEffective(states);
  const warnings = [];
  const failClosedActive = [];
  let hasRemovable = false;
  let activeEntryRemaining = false;

  for (const state of states) {
    if (!candidateHasPluginArray(state)) continue;
    const ctx = makeContext(state.path);
    const plan = entryOwnership.planUnregisterArray(state.tree.plugin, ctx, {});
    if (plan.remove.length) hasRemovable = true;
    if (state === effective) {
      activeEntryRemaining = plan.retained.some((entry) => entry.category !== "foreign");
      for (const entry of plan.failClosed) failClosedActive.push({ path: state.path, entry });
    } else {
      for (const entry of plan.failClosed) {
        warnings.push(`masked ${entry.category} entry at ${state.path}[${entry.index}] retained (${JSON.stringify(entry.rawEntry)})`);
      }
    }
  }

  return { effective, hasRemovable, activeEntryRemaining, failClosedActive, warnings };
}

function verifyManagedRegisterPostcondition({ cfg, configPath, makeContext, legacyLiterals = [] }) {
  const states = readCandidates(cfg, configPath);
  const effective = selectEffective(states);
  if (!effective || !candidateHasPluginArray(effective)) {
    return { ok: false, reason: "no-effective-plugin-array" };
  }
  const classification = entryOwnership.classifyPluginEntries(effective.tree.plugin, makeContext(effective.path));
  const canonicalCount = classification.entries.filter((entry) => entry.category === "canonical-current").length;
  if (canonicalCount !== 1) return { ok: false, reason: `canonical-entry-count-${canonicalCount}` };
  if (classification.entries.some((entry) => entryOwnership.FAIL_CLOSED_CATEGORIES.has(entry.category))) {
    return { ok: false, reason: "fail-closed-entry-remains" };
  }
  for (const literal of legacyLiterals) {
    if (classification.entries.some((entry) => entry.rawEntry === literal)) {
      return { ok: false, reason: "legacy-missing-literal-remains" };
    }
  }
  return { ok: true };
}

// Sweep proven-owned entries from every candidate. Returns the post-sweep
// effective view so the installer can decide about generation cleanup and
// whether an active registration remains. Unregister also destroys entries, so
// the legacy-missing absence recheck happens before any write here too.
function applyManagedUnregister({ cfg, configPath, candidates, makeContext, options = {} }) {
  const fsImpl = options.fs || fs;
  const states = candidates;
  const warnings = [];

  for (const state of states) {
    if (!candidateHasPluginArray(state)) continue;
    const ctx = makeContext(state.path);
    const classification = entryOwnership.classifyPluginEntries(state.tree.plugin, ctx);
    for (const entry of classification.entries) {
      if (entry.category !== "legacy-missing-candidate") continue;
      const check = missingPathStillAbsent(entry.specifier, { fs: fsImpl, platform: options.platform });
      if (!check.absent) {
        return {
          removed: 0,
          changed: false,
          mutatedPaths: [],
          backupPaths: [],
          warnings: [...warnings, `refusing to sweep ${state.path}: ${entry.specifier} is no longer provably absent (${check.reason})`],
          activeEntryRemaining: true,
          effectivePath: configPath,
          error: { reason: "legacy-missing-candidate-unconfirmable", configPath: state.path, specifier: entry.specifier },
        };
      }
    }
  }

  let removed = 0;
  const mutatedPaths = [];
  const backupPaths = [];
  for (const state of states) {
    if (!candidateHasPluginArray(state)) continue;
    const ctx = makeContext(state.path);
    const plan = entryOwnership.planUnregisterArray(state.tree.plugin, ctx, {});
    if (!plan.remove.length) continue;
    const text = removeEntriesFromText(state.text, plan.remove);
    const backupPath = writeTextAtomicWithBackup(state.path, text, { ...options, mode: fileMode(state.path) });
    if (backupPath) backupPaths.push(backupPath);
    mutatedPaths.push(state.path);
    removed += plan.remove.length;
  }

  const reread = readCandidates(cfg, configPath);
  const effective = selectEffective(reread);
  let activeEntryRemaining = null;
  const failClosedActive = [];
  if (effective && candidateHasPluginArray(effective)) {
    const classification = entryOwnership.classifyPluginEntries(effective.tree.plugin, makeContext(effective.path));
    activeEntryRemaining = classification.entries.some((entry) => entry.category !== "foreign");
    for (const entry of classification.entries) {
      if (entryOwnership.FAIL_CLOSED_CATEGORIES.has(entry.category)) {
        failClosedActive.push({ path: effective.path, entry });
        warnings.push(`active ${entry.category} entry retained at ${effective.path}[${entry.index}] (${JSON.stringify(entry.rawEntry)})`);
      }
    }
  } else {
    activeEntryRemaining = false;
  }

  return {
    removed,
    changed: removed > 0,
    mutatedPaths,
    backupPaths,
    warnings,
    activeEntryRemaining,
    failClosedActive,
    effectivePath: effective ? effective.path : configPath,
  };
}

module.exports = {
  registerJsonc,
  unregisterJsonc,
  readCandidates,
  inspectManagedRegister,
  inspectManagedUnregister,
  applyManagedRegister,
  verifyManagedRegisterPostcondition,
  applyManagedUnregister,
  buildManagedContext,
  missingPathStillAbsent,
  isClawdLikeDir,
  __test: {
    parseJsoncStrict, findManagedIndex, entryIsExactManagedPlugin, isManagedEntry,
    freshConfigText, candidatePaths, removeEntriesFromText, nearestExistingAncestor,
  },
};
