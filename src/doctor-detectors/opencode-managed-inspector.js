"use strict";
// Doctor inspector for managedMaterialization:true opencode-family members
// (#1026 §8).
//
// This is deliberately separate from validateOpencodeEntry() (which stays a
// plain static module-shape validator): ownership, manifest/hash and
// config-mutation policy live here. MiMo (managedMaterialization:false) keeps
// the baseline first-basename detection in agent-integrations.js.
//
// The inspector NEVER probes write permissions, never reads the plugin INIT
// log and never uses session liveness as an install-health signal. It accepts
// an injected `fs` so tests never touch the real home.

const fs = require("fs");
const path = require("path");
const { getFamilyConfig } = require("../../agents/opencode-family");
const managedGeneration = require("../../hooks/opencode-family-managed-generation");
const entryOwnership = require("../../hooks/opencode-family-entry-ownership");
const jsoncEditor = require("../../hooks/opencode-family-jsonc");
const v2Registry = require("../../hooks/opencode-family-v2-registration");
const { resolveSourcePluginDir } = require("../../hooks/opencode-install");

const SAFE_CATEGORIES = entryOwnership.OWNED_SAFE_CATEGORIES;
const FAIL_CLOSED = entryOwnership.FAIL_CLOSED_CATEGORIES;

function parseJsoncTree(text) {
  // eslint-disable-next-line global-require
  const { parse, parseTree } = require("jsonc-parser");
  const errors = [];
  const tree = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`invalid JSONC (${errors.length} parse error(s))`);
  // A duplicate top-level "plugin" key is ambiguous: parse() silently keeps
  // the LAST value while element edits can target the FIRST node. Refuse it.
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (root && root.type === "object" && Array.isArray(root.children)) {
    let count = 0;
    for (const prop of root.children) {
      const keyNode = Array.isArray(prop.children) ? prop.children[0] : null;
      if (keyNode && keyNode.value === "plugin") count++;
    }
    if (count > 1) throw new Error(`duplicate top-level "plugin" keys (${count})`);
  }
  return tree;
}

function readCandidate(fsImpl, filePath) {
  let text;
  try {
    text = fsImpl.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { path: filePath, exists: false };
    return { path: filePath, exists: true, error: err };
  }
  const stripped = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  try {
    return { path: filePath, exists: true, tree: parseJsoncTree(stripped) };
  } catch (err) {
    return { path: filePath, exists: true, error: err };
  }
}

function declaresPlugin(state) {
  return !!(
    state.exists
    && !state.error
    && state.tree
    && typeof state.tree === "object"
    && !Array.isArray(state.tree)
    && Object.prototype.hasOwnProperty.call(state.tree, "plugin")
  );
}

function hasPluginArray(state) {
  return declaresPlugin(state) && Array.isArray(state.tree.plugin);
}

function candidateList(descriptor) {
  if (Array.isArray(descriptor.configCandidates) && descriptor.configCandidates.length) {
    return descriptor.configCandidates;
  }
  return [descriptor.configPath];
}

function describeEntry(entry) {
  const parts = [`${entry.category} at index ${entry.index}: ${JSON.stringify(entry.rawEntry)}`];
  return parts.join(" ");
}

function remediationText(details) {
  if (!Array.isArray(details) || !details.length) return "";
  const first = details[0];
  if (!first || !first.remediation) return "";
  const { configPath: cfgPath, index, literal } = first.remediation;
  return `Manual fix required: edit ${cfgPath}, plugin[${index}] = ${literal}, and replace it with the Clawd managed plugin path.`;
}

function makeResult(descriptor, status, fields = {}) {
  return {
    agentId: descriptor.agentId,
    agentName: descriptor.agentName,
    eventSource: descriptor.eventSource,
    status,
    ...fields,
  };
}

function inspectManagedOpencode(descriptor, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  const agentId = descriptor.agentId;
  const cfg = getFamilyConfig(agentId);
  const candidates = candidateList(descriptor);

  const states = candidates.map((candidate) => readCandidate(fsImpl, candidate));
  const existing = states.filter((state) => state.exists);

  if (!existing.length) {
    return makeResult(descriptor, descriptor.autoInstall ? "not-connected" : "manual-only", {
      level: descriptor.autoInstall ? "warning" : "info",
      parentDirExists: true,
      configFileExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} missing`,
    });
  }

  const unreadable = existing.find((state) => state.error);
  if (unreadable) {
    return makeResult(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: unreadable.path,
      detail: `${unreadable.path}: ${unreadable.error && unreadable.error.message ? unreadable.error.message : "config parse failed"}`,
    });
  }

  const effective = existing.find(declaresPlugin) || existing[0];

  // Expected managed target + source identity.
  let sourcePluginDir = null;
  try {
    sourcePluginDir = resolveSourcePluginDir();
  } catch {
    sourcePluginDir = null;
  }
  const target = managedGeneration.resolveManagedTarget({
    cfg,
    agentId,
    homeDir: descriptor.managedHomeDir,
    configPath: descriptor.configPath,
    fs: fsImpl,
    platform,
  });

  let sourceFiles = null;
  let bundleHash = null;
  try {
    const bundle = managedGeneration.readSourceBundle(cfg, sourcePluginDir, fsImpl);
    sourceFiles = bundle.files;
    bundleHash = managedGeneration.computeBundleHash(agentId, bundle.files);
  } catch {
    sourceFiles = null;
    bundleHash = null;
  }

  const expectedCanonicalDir = bundleHash
    ? managedGeneration.canonicalizeTargetPath(
      path.join(managedGeneration.generationDir(target, bundleHash), cfg.pluginDirName),
      platform,
      fsImpl
    )
    : null;

  const ownerRead = managedGeneration.readOwnerRecord(target, agentId, fsImpl, {
    platform,
    pluginDirName: cfg.pluginDirName,
  });
  const ownerRecord = (ownerRead.state === "owned" || ownerRead.state === "released") ? ownerRead.record : null;
  const sourceRoot = sourcePluginDir ? path.dirname(sourcePluginDir) : null;

  const expectedGeneration = () => {
    if (!bundleHash) return { ok: false, reason: "generation-missing" };
    const genDir = managedGeneration.generationDir(target, bundleHash);
    if (!fsImpl.existsSync(genDir)) return { ok: false, reason: "generation-missing" };
    const inspected = managedGeneration.inspectGeneration(genDir, cfg, agentId, { fs: fsImpl, files: sourceFiles || undefined });
    return inspected.ok ? { ok: true } : { ok: false, reason: inspected.reason };
  };

  const makeContext = () => jsoncEditor.buildManagedContext({
    cfg,
    target,
    expectedCanonicalDir,
    expectedGeneration,
    sourceFiles,
    ownerRecord,
    fsImpl,
    platform,
    managedBoundary: true,
  });

  // opencode v2 `plugins`-key assessment (issue #1039). Computed up front so
  // the final verdicts below can factor it in: a healthy v1 `plugin` entry
  // with a missing v2 entry means an older Clawd installed this target, and
  // Repair (register) converges both keys.
  const assessV2 = () => {
    if (!cfg.v2PluginDirName) return null;
    const v2States = v2Registry.readV2Candidates(cfg, descriptor.configPath);
    const v2Effective = v2Registry.__test.selectEffectiveV2(v2States);
    if (!v2Effective) {
      return { state: "missing", detail: "no opencode config exists for the plugins-key entry" };
    }
    const expectedCanonicalV2Dir = bundleHash
      ? managedGeneration.canonicalizeTargetPath(
        path.join(managedGeneration.generationDir(target, bundleHash), cfg.v2PluginDirName),
        platform,
        fsImpl
      )
      : null;
    const v2Ctx = v2Registry.buildV2ManagedContext({
      cfg,
      target,
      expectedCanonicalDir: expectedCanonicalV2Dir,
      expectedGeneration,
      sourceFiles,
      ownerRecord,
      fsImpl,
      platform,
      managedBoundary: true,
    });
    if (!v2Registry.__test.hasV2Array(v2Effective)) {
      return { state: "missing", detail: `${v2Effective.path} has no "plugins" array (opencode v2 entry not registered)` };
    }
    const { entries } = v2Registry.classifyV2PluginEntries(v2Effective.tree[v2Registry.V2_PLUGIN_KEY], v2Ctx);
    const blocking = entries.filter((entry) => FAIL_CLOSED.has(entry.category));
    if (blocking.length) {
      return {
        state: "needs-review",
        detail: `${v2Effective.path} "plugins" entry needs manual review: ${blocking.map(describeEntry).join("; ")}`,
        entries: entries.map((entry) => entry.rawEntry),
      };
    }
    const owned = entries.filter((entry) => SAFE_CATEGORIES.has(entry.category));
    if (owned.length === 0) {
      return { state: "missing", detail: `${v2Effective.path} has no Clawd ${cfg.v2PluginDirName} plugins-key entry` };
    }
    if (owned.length > 1) {
      return {
        state: "duplicate",
        detail: `${v2Effective.path} declares ${owned.length} Clawd v2 plugins-key entries`,
        entries: entries.map((entry) => entry.rawEntry),
      };
    }
    if (owned[0].category !== "canonical-current" || owned[0].generationPending) {
      return {
        state: "stale",
        detail: `${v2Effective.path} v2 plugins-key entry can be safely migrated (${owned[0].category})`,
        entries: entries.map((entry) => entry.rawEntry),
      };
    }
    return { state: "ok", detail: `${v2Effective.path} v2 plugins-key entry verified`, entries: entries.map((entry) => entry.rawEntry) };
  };
  const v2Assessment = assessV2();

  // A corrupt/foreign/mismatched owner record means the managed core would go
  // inert; report it without any automatic Fix.
  if (ownerRead.state === "foreign" || ownerRead.state === "mismatch" || ownerRead.state === "corrupt") {
    return makeResult(descriptor, "needs-review", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: effective.path,
      detail: `the managed owner record is unreadable or not a valid Clawd target owner (${target.ownerPath}); inspect it manually before Repair`,
      ownerRecordState: ownerRead.state,
    });
  }

  // A managed target with no owner record makes the copied core inert, so a
  // config that points into it must never be reported ok. (A missing record
  // with no managed target at all is just an unmanaged/source-direct install.)
  if (ownerRead.state === "missing" && fsImpl.existsSync(target.targetRoot)) {
    return makeResult(descriptor, "needs-review", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: effective.path,
      detail: `managed files exist at ${target.targetRoot} but the target owner record is missing; the plugin is inert. Reinstall to re-register, or remove the residual managed files.`,
      ownerRecordState: "missing",
    });
  }

  // A released owner record means the managed core is inert (no active
  // source), so Doctor must never report ok.
  if (ownerRead.state === "released") {
    return makeResult(descriptor, "needs-review", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: effective.path,
      detail: `the managed owner record at ${target.ownerPath} was released (no active source); the plugin is inert. Reinstall to re-register, or remove the residual files.`,
      ownerRecordState: "released",
    });
  }

  // An owned record whose marker is missing, a directory or a dangling symlink
  // makes the plugin inert: never ok.
  if (ownerRead.state === "owned") {
    const marker = ownerRead.record.activeSourceMarker;
    if (!managedGeneration.isLiveSourceMarker(marker, fsImpl)) {
      return makeResult(descriptor, "needs-review", {
        level: "warning",
        parentDirExists: true,
        configFileExists: true,
        configPath: effective.path,
        detail: `the managed source marker ${marker} is missing or not a regular file; the plugin is inert. Restore the Clawd source or uninstall to clear the residual managed files.`,
        ownerRecordState: "source-marker-invalid",
        activeSourceMarker: marker,
      });
    }
  }

  // Owner conflict: another live Clawd source owns this target. Compare under
  // the shared canonical identity and require a live regular-file marker.
  const sameSource = (ownerRead.state === "owned" && sourceRoot)
    ? managedGeneration.canonicalizeTargetPath(ownerRead.record.activeSourceRoot, platform, fsImpl)
      === managedGeneration.canonicalizeTargetPath(sourceRoot, platform, fsImpl)
    : true;
  if (ownerRead.state === "owned" && sourceRoot && !sameSource) {
    const markerAlive = managedGeneration.isLiveSourceMarker(ownerRead.record.activeSourceMarker, fsImpl);
    if (markerAlive) {
      return makeResult(descriptor, "needs-review", {
        level: "warning",
        parentDirExists: true,
        configFileExists: true,
        configPath: effective.path,
        detail: `this target's managed owner record points at another live Clawd source (${ownerRead.record.activeSourceRoot}). Uninstall from that source to release it, or remove its stale source marker (${ownerRead.record.activeSourceMarker}) and run Repair.`,
        ownerConflict: {
          activeSourceRoot: ownerRead.record.activeSourceRoot,
          activeSourceMarker: ownerRead.record.activeSourceMarker,
        },
      });
    }
  }

  if (!hasPluginArray(effective)) {
    // No effective plugin array. If a valid canonical generation is lying
    // around unreferenced, warn without claiming correctness.
    const residual = generationResidual(target, cfg, agentId, fsImpl);
    const fields = {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: effective.path,
      detail: `${effective.path} has no plugin entry`,
    };
    if (residual) {
      fields.supplementary = {
        key: "opencode_managed",
        value: "residual-generation",
        residualPath: residual,
      };
      fields.detail = `${fields.detail}; a managed generation remains on disk at ${residual} but is not registered`;
      fields.level = "warning";
    }
    return makeResult(descriptor, "not-connected", fields);
  }

  const classification = entryOwnership.classifyPluginEntries(effective.tree.plugin, makeContext());
  const entries = classification.entries;
  const blocking = entries.filter((entry) => FAIL_CLOSED.has(entry.category));

  // Masked lower-priority candidates: ambiguous entries there are retained and
  // surfaced as a supplementary warning, but must not turn the effective
  // healthy result into a failure.
  const maskedWarnings = [];
  const maskedOwned = [];
  for (const state of existing) {
    if (state === effective || !hasPluginArray(state)) continue;
    const lower = entryOwnership.classifyPluginEntries(state.tree.plugin, makeContext());
    for (const entry of lower.entries) {
      if (FAIL_CLOSED.has(entry.category)) {
        maskedWarnings.push(`${state.path}[${entry.index}] ${entry.category}: ${JSON.stringify(entry.rawEntry)}`);
      } else if (SAFE_CATEGORIES.has(entry.category)) {
        // A masked lower candidate still holds a proven-owned Clawd entry:
        // cleanup is required, so the healthy effective view is not silently
        // "ok" — Repair must converge it.
        maskedOwned.push({ path: state.path, index: entry.index, category: entry.category, rawEntry: entry.rawEntry });
      }
    }
  }

  if (blocking.length) {
    const details = blocking.map((entry) => ({
      category: entry.category,
      reason: entry.reason || null,
      remediation: entryOwnership.describeRemediation(entry, effective.path),
    }));
    return makeResult(descriptor, "needs-review", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: effective.path,
      detail: `opencode plugin entry needs manual review: ${blocking.map(describeEntry).join("; ")}. ${remediationText(details)}`,
      opencodeEntries: entries.map((entry) => entry.rawEntry),
      opencodeRemediation: details,
      opencodeEntryIssue: blocking[0].category,
    });
  }

  const owned = entries.filter((entry) => SAFE_CATEGORIES.has(entry.category));

  if (!owned.length) {
    return makeResult(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: effective.path,
      detail: `${effective.path} has no Clawd ${cfg.pluginDirName} plugin entry`,
      opencodeEntries: entries.map((entry) => entry.rawEntry),
    });
  }

  if (owned.length > 1) {
    const optionSets = [];
    for (const entry of owned) {
      if (entry.shape !== "tuple") continue;
      if (!optionSets.some((set) => entryOwnership.sameOptions(set, entry.options))) optionSets.push(entry.options);
    }
    if (optionSets.length > 1) {
      return makeResult(descriptor, "needs-review", {
        level: "warning",
        parentDirExists: true,
        configFileExists: true,
        configPath: effective.path,
        detail: `multiple Clawd plugin tuples with conflicting options in ${effective.path}; resolve them manually before Repair`,
        opencodeEntries: entries.map((entry) => entry.rawEntry),
      });
    }
    return makeResult(descriptor, "duplicate-entry", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: effective.path,
      detail: `${effective.path} declares ${owned.length} Clawd plugin entries`,
      opencodeEntries: entries.map((entry) => entry.rawEntry),
    });
  }

  const single = owned[0];
  const fields = {
    parentDirExists: true,
    configFileExists: true,
    configPath: effective.path,
    opencodeEntry: single.rawEntry,
    opencodeEntries: entries.map((entry) => entry.rawEntry),
  };
  const v2Suffix = v2Assessment && v2Assessment.state !== "ok"
    ? `; v2: ${v2Assessment.detail}`
    : "";
  const v2Extras = v2Assessment && v2Assessment.state !== "ok"
    ? { v2EntryState: v2Assessment.state, v2Entries: v2Assessment.entries || [] }
    : {};

  if (single.category === "canonical-current" && !single.generationPending) {
    // Safe owned entries in masked lower candidates need a real cleanup, so
    // this is repairable rather than a silent ok.
    if (maskedOwned.length) {
      return makeResult(descriptor, "duplicate-entry", {
        level: "warning",
        ...fields,
        ...v2Extras,
        detail: `${effective.path} is current, but ${maskedOwned.length} masked lower-priority Clawd entr${maskedOwned.length === 1 ? "y" : "ies"} remain (${maskedOwned.map((entry) => `${entry.path}[${entry.index}]`).join(", ")}); Repair converges them${v2Suffix}`,
        maskedEntries: maskedOwned,
      });
    }
    // v1 entry verified — but the opencode v2 `plugins` key is part of the
    // same contract now. A missing/stale v2 entry means an older Clawd (or a
    // downgrade) wrote this config; Repair converges it.
    if (v2Assessment && v2Assessment.state === "missing") {
      return makeResult(descriptor, "legacy-path", {
        level: "warning",
        ...fields,
        ...v2Extras,
        detail: `${effective.path} v1 plugin entry verified, but the opencode v2 entry is not registered (${v2Assessment.detail}); Repair adds it`,
      });
    }
    if (v2Assessment && (v2Assessment.state === "stale" || v2Assessment.state === "duplicate")) {
      return makeResult(descriptor, v2Assessment.state === "duplicate" ? "duplicate-entry" : "broken-path", {
        level: "warning",
        ...fields,
        ...v2Extras,
        detail: `${effective.path} v1 plugin entry verified, but the v2 entry needs repair: ${v2Assessment.detail}`,
      });
    }
    if (v2Assessment && v2Assessment.state === "needs-review") {
      return makeResult(descriptor, "needs-review", {
        level: "warning",
        ...fields,
        ...v2Extras,
        detail: `${effective.path} v1 plugin entry verified, but the v2 entry needs manual review: ${v2Assessment.detail}`,
      });
    }
    const result = makeResult(descriptor, "ok", {
      level: null,
      ...fields,
      v2Entries: v2Assessment ? v2Assessment.entries || [] : [],
      detail: `${effective.path} plugin entry verified${v2Assessment ? `; ${v2Assessment.detail}` : ""}`,
    });
    if (maskedWarnings.length) {
      result.level = "warning";
      result.supplementary = {
        key: "opencode_managed",
        value: "masked-ambiguous",
        entries: maskedWarnings,
      };
      result.detail = `${result.detail}; masked lower-priority entries need review: ${maskedWarnings.join("; ")}`;
    }
    return result;
  }

  // Safe but not current: exact legacy source, verified copy, owned stale
  // generation, single missing legacy candidate or a pending generation.
  const status = (single.category === "legacy-source-exact"
    || single.category === "verified-current-copy"
    || single.category === "legacy-missing-candidate")
    ? "legacy-path"
    : "broken-path";
  return makeResult(descriptor, status, {
    level: "warning",
    ...fields,
    ...v2Extras,
    detail: `${effective.path} Clawd plugin entry can be safely migrated (${single.category})${v2Suffix}`,
  });
}

function generationResidual(target, cfg, agentId, fsImpl) {
  let names;
  try {
    names = fsImpl.readdirSync(target.generationsDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const genDir = path.join(target.generationsDir, name);
    const inspected = managedGeneration.inspectGeneration(genDir, cfg, agentId, { fs: fsImpl });
    if (inspected.ok) return genDir;
  }
  return null;
}

module.exports = { inspectManagedOpencode, __test: { readCandidate, declaresPlugin, hasPluginArray } };
