#!/usr/bin/env node
// Shared installer factory for opencode-family members.
//
// Registers the family plugin dir (hooks/<agent>-plugin/) in the host's
// global config "plugin" array. Parameterized by the family registry
// (agents/opencode-family.js) so register/unregister/idempotency/stale-path
// behavior stays identical across members — a fix here fixes every member.
// Per-agent wrappers (opencode-install.js, mimocode-install.js) preserve the
// legacy named exports, return shapes (incl. reason strings), and CLI entry.
//
// Why the global config and not plugins/ directory scanning:
//   - Phase 0 spike verified that 1.3.13 does NOT auto-scan ~/.config/opencode/plugins/
//     for bare .mjs files. It only loads plugins listed in "plugin" arrays.
//   - Global scope applies to every project the user opens, matching
//     Gemini/Cursor install behavior.
//   - opencode.ai/docs/plugins confirms Load Order starts with "global config".

const fs = require("fs");
const path = require("path");
const os = require("os");
const { readJsonFile, writeJsonAtomic, writeJsonAtomicWithBackup, asarUnpackedPath } = require("./json-utils");
const { getFamilyConfig } = require("../agents/opencode-family");
const managedGeneration = require("./opencode-family-managed-generation");
const entryOwnership = require("./opencode-family-entry-ownership");
const hostDetect = require("./opencode-host-detect");

// opencode v2 `plugins`-key registrar (issue #1039). Lazily required like the
// jsonc editor: hooks/json-utils.js + this module stay dep-free for remote
// deployment, and non-v2 members (MiMo) never load it.
function getV2Registrar() {
  // eslint-disable-next-line global-require
  return require("./opencode-family-v2-registration");
}

function familyHasV2Entry(cfg) {
  return typeof cfg.v2PluginDirName === "string" && !!cfg.v2PluginDirName;
}

// Upstream PR #1045 review: opencode <= 1.18.15 rejects unknown top-level
// config keys, so the v2 `plugins` write must follow the detected host, not a
// static registry flag. Explicit options.v2Host ("v1" | "v2" | "unknown")
// wins — tests and remote callers pin it — otherwise the real binary is
// probed once per register call.
function resolveV2Host(options) {
  const explicit = hostDetect.__test.normalizeHostDetection(options.v2Host);
  if (explicit) return explicit;
  return hostDetect.detectOpencodeHost(options);
}

function normalizePluginEntry(value) {
  return String(value || "").replace(/\\/g, "/");
}

function entryIsExactManagedPlugin(entry, pluginDir) {
  return typeof entry === "string" && normalizePluginEntry(entry) === normalizePluginEntry(pluginDir);
}

// JSONC members lazily load the family JSONC editor so the JSON-only path
// never touches (or ships) the jsonc-parser dependency — hooks/json-utils.js
// is deployed to remote SSH hosts without node_modules and must stay dep-free
// (plan §4.1). The editor module lands with the mimocode PR.
function getJsoncEditor() {
  // eslint-disable-next-line global-require
  return require("./opencode-family-jsonc");
}

/**
 * Build the installer for one family member.
 *
 * @param {string} agentId  a key of OPENCODE_FAMILY (agents/opencode-family.js)
 * @returns {{
 *   register: Function, unregister: Function, resolvePluginDir: Function,
 *   DEFAULT_PARENT_DIR: string, DEFAULT_CONFIG_PATH: string, __test: object
 * }}
 */
function makeFamilyInstaller(agentId) {
  const cfg = getFamilyConfig(agentId);
  if (!cfg) throw new Error(`makeFamilyInstaller: unknown family agent "${agentId}"`);

  const PLUGIN_DIR_NAME = cfg.pluginDirName;
  const DEFAULT_PARENT_DIR = path.join(os.homedir(), ...cfg.configDirSegments);
  const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, cfg.configFileName);
  // "~/.config/opencode/" — for user-facing skip messages
  const PARENT_DIR_DISPLAY = `~/${cfg.configDirSegments.join("/")}/`;

  /**
   * Resolve the absolute path to hooks/<agent>-plugin/ as seen from a running
   * host (Bun) process. When Clawd is packaged into app.asar, hooks/** is
   * unpacked to app.asar.unpacked/ (see package.json "asarUnpack"). The host
   * cannot require files inside asar, so we must point it at the unpacked copy.
   *
   * NOTE: this file lives directly under hooks/ (same directory as the old
   * per-agent installers), so the default __dirname base yields byte-identical
   * registered paths to the pre-refactor ones — no config migration.
   *
   * @param {string} [baseDir]  defaults to __dirname (hooks/); exposed for tests
   */
  function resolvePluginDir(baseDir) {
    // Normalize to forward slashes for JSON storage + cross-platform host compat
    const dir = path.resolve(baseDir || __dirname, PLUGIN_DIR_NAME).replace(/\\/g, "/");
    return asarUnpackedPath(dir);
  }

  // Explicit source name (#1026 §4.2). Same value as resolvePluginDir — kept
  // distinct so the managed path reads clearly and the old name keeps meaning
  // "source plugin dir".
  function resolveSourcePluginDir(baseDir) {
    return resolvePluginDir(baseDir);
  }

  function resolveManagedTarget(options = {}) {
    return managedGeneration.resolveManagedTarget({
      cfg,
      agentId,
      homeDir: options.homeDir,
      managedRoot: options.managedRoot,
      configPath: options.configPath,
      fs: options.fs || fs,
      platform: options.platform || process.platform,
    });
  }

  function resolveManagedPluginDir(target, bundleHash) {
    return path.join(managedGeneration.generationDir(target, bundleHash), PLUGIN_DIR_NAME);
  }

  function toEntryPath(p) {
    return String(p).replace(/\\/g, "/");
  }

  // Owner/source comparisons use the shared canonical identity so a Windows
  // case/alias difference never looks like a different live source.
  function canonicalEqual(a, b, fsImpl, platform) {
    const ca = managedGeneration.canonicalizeTargetPath(a, platform, fsImpl);
    const cb = managedGeneration.canonicalizeTargetPath(b, platform, fsImpl);
    return ca !== null && ca === cb;
  }

  // Resolve config/target for one managed operation. `rootUnknown` means the
  // caller passed only configPath with no home/managedRoot/pluginDir: register
  // must fail closed, unregister may still sweep the config but must not touch
  // any managed root.
  function resolveManagedOperation(options) {
    const fsImpl = options.fs || fs;
    const platform = options.platform || process.platform;
    const rootUnknown = Boolean(options.configPath)
      && !options.homeDir && !options.managedRoot && !options.pluginDir;
    const target = resolveManagedTarget(options);
    const configPath = options.configPath || path.join(target.configDir, cfg.configFileName);
    return { fsImpl, platform, rootUnknown, target, configPath };
  }

  function logRegister(options, editedPath, pluginDir, created, added, skipped) {
    if (options.silent) return;
    console.log(`Clawd ${agentId} plugin → ${editedPath}`);
    if (created) console.log(`  Created ${cfg.configFileName}`);
    if (added) console.log(`  Registered: ${pluginDir}`);
    if (skipped) console.log(`  Already registered: ${pluginDir}`);
    // opencode v2 (issue #1039): plugins run in the shared background service,
    // so a newly materialized generation needs a service restart (or a fresh
    // `opencode` run, which starts one) to be picked up.
    if (familyHasV2Entry(cfg) && added && !options.pluginDir) {
      console.log(`  opencode v2: restart the opencode service (or start a new opencode session) to load the updated plugin`);
    }
  }

  // Does this owner record already claim THIS live source?
  function ownerClaimsSource(ownerState, sourceRoot, fsImpl, platform) {
    return ownerState.state === "owned"
      && canonicalEqual(ownerState.record.activeSourceRoot, sourceRoot, fsImpl, platform);
  }

  // Surface a failed lock release without rolling back an already-applied
  // operation: success keeps its status and gains a warning + residual path;
  // failures keep their primary error.
  function attachLockReleaseFailure(result, target) {
    const warning = `managed target lock at ${target.lockPath} could not be released cleanly; inspect it before the next operation`;
    if (!result || typeof result !== "object") {
      return { status: "ok", warnings: [warning], lockReleaseFailed: true, residualPaths: [target.lockPath] };
    }
    return {
      ...result,
      lockReleaseFailed: true,
      warnings: [...(result.warnings || []), warning],
      residualPaths: [...(result.residualPaths || []), target.lockPath],
    };
  }

  // Run locked work and always attempt a token-verified release. A failed
  // release never rolls back the work and never hides the primary error.
  function withTargetLock(target, lock, fsImpl, work) {
    let result;
    try {
      result = work();
    } catch (err) {
      if (!managedGeneration.releaseTargetLock(target, lock, fsImpl)) {
        if (err && typeof err === "object") {
          err.lockResidual = { lockPath: target.lockPath };
        }
      }
      throw err;
    }
    if (!managedGeneration.releaseTargetLock(target, lock, fsImpl)) {
      return attachLockReleaseFailure(result, target);
    }
    return result;
  }

  // Test-only `options.pluginDir` override: expected canonical target for THIS
  // call, no generation, no owner record, no lock. Still enforces the managed
  // ownership rules (no broad-basename ownership, ambiguous fail closed,
  // exactly one canonical entry, post-write read-back).
  function registerManagedOverride(options, configPath, sourcePluginDir) {
    const jsonc = getJsoncEditor();
    const fsImpl = options.fs || fs;
    const platform = options.platform || process.platform;
    const expectedCanonicalDir = managedGeneration.canonicalizeTargetPath(options.pluginDir, platform, fsImpl);
    const canonicalEntry = toEntryPath(options.pluginDir);
    let sourceFiles = null;
    try {
      sourceFiles = managedGeneration.readSourceBundle(cfg, sourcePluginDir, fsImpl).files;
    } catch {
      sourceFiles = null;
    }
    const makeContext = () => jsonc.buildManagedContext({
      cfg,
      target: { agentId, targetRoot: "", generationsDir: "" },
      expectedCanonicalDir,
      expectedGeneration: () => ({ ok: true }),
      sourceFiles,
      ownerRecord: null,
      fsImpl,
      platform,
      managedBoundary: false,
    });

    const candidates = jsonc.readCandidates(cfg, configPath);
    const pre = jsonc.inspectManagedRegister({ cfg, configPath, candidates, makeContext, canonicalEntry });
    if (pre.needsReview) {
      return {
        status: "error",
        reason: pre.needsReview.reason,
        message: `opencode plugin entry needs manual review (${pre.needsReview.reason})`,
        configPath,
        pluginDir: canonicalEntry,
        details: pre.needsReview.details || [],
        warnings: pre.warnings,
      };
    }
    if (!pre.needsMutation) {
      logRegister(options, pre.effective ? pre.effective.path : configPath, canonicalEntry, false, false, true);
      return {
        status: "ok", added: false, skipped: true, created: false,
        configPath: pre.effective ? pre.effective.path : configPath,
        pluginDir: canonicalEntry, warnings: pre.warnings, mutatedPaths: [],
      };
    }
    const apply = jsonc.applyManagedRegister({ cfg, configPath, candidates, makeContext, canonicalEntry, options });
    if (apply.status !== "ok") {
      return { status: "error", reason: apply.reason, message: apply.message, configPath, pluginDir: canonicalEntry, warnings: apply.warnings };
    }
    const verify = jsonc.verifyManagedRegisterPostcondition({ cfg, configPath, makeContext, legacyLiterals: apply.legacyLiterals });
    if (!verify.ok) {
      return { status: "error", reason: "postcondition-failed", message: `config postcondition not met after write: ${verify.reason}`, configPath, pluginDir: canonicalEntry, mutatedPaths: apply.mutatedPaths };
    }
    const effectivePath = apply.mutatedPaths[apply.mutatedPaths.length - 1] || configPath;
    logRegister(options, effectivePath, canonicalEntry, apply.created, apply.added, false);
    return {
      status: "ok", added: apply.added, skipped: false, created: apply.created,
      configPath: effectivePath, pluginDir: canonicalEntry,
      warnings: pre.warnings, mutatedPaths: apply.mutatedPaths,
    };
  }

  function unregisterManagedOverride(options, configPath, sourcePluginDir) {
    const jsonc = getJsoncEditor();
    const fsImpl = options.fs || fs;
    const platform = options.platform || process.platform;
    const expectedCanonicalDir = managedGeneration.canonicalizeTargetPath(options.pluginDir, platform, fsImpl);
    let sourceFiles = null;
    try {
      sourceFiles = managedGeneration.readSourceBundle(cfg, sourcePluginDir, fsImpl).files;
    } catch {
      sourceFiles = null;
    }
    const makeContext = () => jsonc.buildManagedContext({
      cfg,
      target: { agentId, targetRoot: "", generationsDir: "" },
      expectedCanonicalDir,
      expectedGeneration: () => ({ ok: true }),
      sourceFiles,
      ownerRecord: null,
      fsImpl,
      platform,
      managedBoundary: false,
    });
    const candidates = jsonc.readCandidates(cfg, configPath);
    const apply = jsonc.applyManagedUnregister({ cfg, configPath, candidates, makeContext, options });
    const base = {
      removed: apply.removed,
      changed: apply.changed,
      skipped: !apply.changed,
      configPath: apply.effectivePath || configPath,
      pluginDir: toEntryPath(options.pluginDir),
      activeEntryRemaining: apply.activeEntryRemaining,
      managedFilesRemoved: false,
      warnings: apply.warnings || [],
      mutatedPaths: apply.mutatedPaths,
    };
    if (apply.error || apply.activeEntryRemaining !== false) {
      return {
        ...base,
        status: "error",
        reason: (apply.error && apply.error.reason) || "active-entry-remaining",
        message: `refusing to report uninstalled: an active Clawd entry remains in ${base.configPath}`,
        registrationRemoved: false,
      };
    }
    if (!options.silent) console.log(`Clawd ${agentId} plugin entries removed: ${apply.removed}`);
    return { ...base, status: "ok", registrationRemoved: true };
  }

  function registerManaged(options) {
    const jsonc = getJsoncEditor();
    const fsImpl = options.fs || fs;
    const platform = options.platform || process.platform;
    const { rootUnknown, target, configPath } = resolveManagedOperation(options);
    const sourcePluginDir = resolveSourcePluginDir();

    if (options.pluginDir) return registerManagedOverride(options, configPath, sourcePluginDir);

    if (rootUnknown) {
      return {
        status: "error",
        reason: "managed-root-required-for-config-override",
        message: "configPath override requires homeDir, managedRoot or pluginDir so managed writes never land in the real profile",
        configPath,
        pluginDir: toEntryPath(sourcePluginDir),
      };
    }

    if (!target.canonicalConfigDirResolved) {
      return {
        status: "error",
        reason: "config-dir-identity-unresolved",
        message: `could not resolve a filesystem identity for ${target.configDir}; refusing managed registration`,
        configPath,
        pluginDir: toEntryPath(sourcePluginDir),
      };
    }

    if (!options.configPath) {
      let exists = false;
      try { exists = fsImpl.statSync(target.configDir).isDirectory(); } catch {}
      if (!exists) {
        if (!options.silent) {
          console.log(`Clawd: ${PARENT_DIR_DISPLAY} not found — skipping ${agentId} plugin registration`);
        }
        return {
          added: false,
          skipped: true,
          created: false,
          reason: `${agentId}-not-found`,
          configPath,
          pluginDir: toEntryPath(sourcePluginDir),
        };
      }
    }

    const isOverride = Boolean(options.pluginDir);
    let sourceFiles = null;
    let bundleHash = null;
    if (!isOverride) {
      try {
        const bundle = managedGeneration.readSourceBundle(cfg, sourcePluginDir, fsImpl);
        sourceFiles = bundle.files;
        bundleHash = managedGeneration.computeBundleHash(agentId, bundle.files);
      } catch (err) {
        return {
          status: "error",
          reason: err.reason || "packaging-error",
          message: err.message,
          configPath,
          pluginDir: toEntryPath(sourcePluginDir),
        };
      }
    } else {
      try {
        sourceFiles = managedGeneration.readSourceBundle(cfg, sourcePluginDir, fsImpl).files;
      } catch {
        sourceFiles = null;
      }
    }

    let expectedCanonicalDir = isOverride
      ? managedGeneration.canonicalizeTargetPath(options.pluginDir, platform, fsImpl)
      : managedGeneration.canonicalizeTargetPath(resolveManagedPluginDir(target, bundleHash), platform, fsImpl);
    let canonicalEntry = isOverride
      ? toEntryPath(options.pluginDir)
      : toEntryPath(resolveManagedPluginDir(target, bundleHash));

    // v2 `plugins`-key entry (issue #1039): same generation, sibling entry dir.
    // Managed-register only — the pluginDir override path (test-only) keeps the
    // single-entry v1 contract. The write follows the detected host (upstream
    // PR #1045 review — opencode <= 1.18.15 rejects unknown top-level keys):
    //   "register" — v2 host detected: write/verify the entry (previous behavior)
    //   "sweep"    — v1 host detected: never write; sweep proven-owned
    //                leftovers so a v2→v1 downgrade self-heals on the next sync
    //   "skip"     — host unknown (probe failed): never touch the key
    const v2Mode = (() => {
      if (isOverride || !familyHasV2Entry(cfg)) return "skip";
      // This is the dep-free low-level primitive: it NEVER probes the host.
      // An absent options.v2Host conservatively maps to "skip" (key left
      // untouched); the register() wrapper is the only production caller that
      // runs the real detection and passes the verdict in.
      const v2Host = hostDetect.__test.normalizeHostDetection(options.v2Host);
      return v2Host === "v2" ? "register" : v2Host === "v1" ? "sweep" : "skip";
    })();
    let expectedCanonicalV2Dir = null;
    let canonicalV2Entry = null;
    if (v2Mode !== "skip") {
      const genDir = managedGeneration.generationDir(target, bundleHash);
      expectedCanonicalV2Dir = managedGeneration.canonicalizeTargetPath(
        path.join(genDir, cfg.v2PluginDirName), platform, fsImpl,
      );
      canonicalV2Entry = toEntryPath(path.join(genDir, cfg.v2PluginDirName));
    }

    let ownerRecord = null;
    const ownerOptions = { platform, pluginDirName: cfg.pluginDirName };
    const readOwner = () => {
      if (isOverride) return { state: "override", record: null };
      return managedGeneration.readOwnerRecord(target, agentId, fsImpl, ownerOptions);
    };
    const ownerState = readOwner();
    if (ownerState.state === "foreign" || ownerState.state === "mismatch" || ownerState.state === "corrupt") {
      return {
        status: "error",
        reason: "owner-inspection-required",
        message: `managed owner record at ${target.ownerPath} is not a valid Clawd target owner; inspect manually`,
        configPath,
        pluginDir: canonicalEntry,
      };
    }
    const sourceRoot = path.dirname(sourcePluginDir);
    const sourceMarker = path.join(sourcePluginDir, "index.mjs");
    let ownerConflict = null;
    if (ownerState.state === "owned") {
      ownerRecord = ownerState.record;
      if (!canonicalEqual(ownerState.record.activeSourceRoot, sourceRoot, fsImpl, platform)) {
        // A directory / dangling symlink / unreadable marker is not live.
        const markerAlive = managedGeneration.isLiveSourceMarker(ownerState.record.activeSourceMarker, fsImpl);
        if (markerAlive) {
          ownerConflict = {
            status: "error",
            reason: "owner-conflict",
            message: `target is owned by another live Clawd source: ${ownerState.record.activeSourceRoot}. Uninstall from that source or remove its marker first.`,
            configPath,
            pluginDir: canonicalEntry,
            activeSourceRoot: ownerState.record.activeSourceRoot,
            activeSourceMarker: ownerState.record.activeSourceMarker,
          };
        }
      }
    }
    if (ownerConflict) return ownerConflict;

    const expectedGeneration = () => {
      if (isOverride) return { ok: true };
      if (!bundleHash) return { ok: false, reason: "generation-missing" };
      const genDir = managedGeneration.generationDir(target, bundleHash);
      if (!fsImpl.existsSync(genDir)) return { ok: false, reason: "generation-missing" };
      const inspected = managedGeneration.inspectGeneration(genDir, cfg, agentId, { fs: fsImpl, files: sourceFiles || undefined });
      return inspected.ok ? { ok: true } : { ok: false, reason: inspected.reason };
    };
    const makeContext = () => {
      return getJsoncEditor().buildManagedContext({
        cfg,
        target,
        expectedCanonicalDir,
        expectedGeneration,
        sourceFiles,
        ownerRecord,
        fsImpl,
        platform,
        managedBoundary: !isOverride,
      });
    };
    const makeV2Context = v2Mode !== "skip"
      ? () => getV2Registrar().buildV2ManagedContext({
        cfg,
        target,
        expectedCanonicalDir: expectedCanonicalV2Dir,
        // Sweep classification never re-verifies the generation (same
        // contract as unregisterManaged): a leftover entry from an older
        // bundle must stay removable even if the current generation moved.
        expectedGeneration: v2Mode === "register" ? expectedGeneration : () => ({ ok: true }),
        sourceFiles,
        ownerRecord,
        fsImpl,
        platform,
        managedBoundary: !isOverride,
      })
      : null;
    const v2Warnings = (v2Pre) => (v2Pre && Array.isArray(v2Pre.warnings) ? v2Pre.warnings : []);

    // Read-only pre-scan.
    let candidates = jsonc.readCandidates(cfg, configPath);
    const pre = jsonc.inspectManagedRegister({ cfg, configPath, candidates, makeContext, canonicalEntry });
    const v2Pre = v2Mode === "register"
      ? getV2Registrar().inspectV2Register({ cfg, configPath, candidates, makeContext: makeV2Context, canonicalV2Entry })
      : null;
    const v2SweepPre = v2Mode === "sweep"
      ? getV2Registrar().inspectV2Unregister({ candidates, makeContext: makeV2Context })
      : null;
    const v2NeedsMutation = v2Pre
      ? v2Pre.needsMutation
      : (v2SweepPre ? v2SweepPre.hasRemovable : false);
    const preNeedsMutation = pre.needsMutation || v2NeedsMutation;
    const preWarnings = [...pre.warnings, ...v2Warnings(v2Pre), ...v2Warnings(v2SweepPre)];
    if (pre.needsReview || (v2Pre && v2Pre.needsReview)) {
      const review = pre.needsReview || v2Pre.needsReview;
      return {
        status: "error",
        reason: review.reason,
        message: `opencode plugin entry needs manual review (${review.reason})`,
        configPath,
        pluginDir: canonicalEntry,
        details: review.details || [],
        warnings: preWarnings,
      };
    }

    // A missing/released record OR an owned record that claims a DIFFERENT
    // source whose marker is no longer live still needs a (takeover) write.
    const ownerNeedsMutation = !isOverride
      && !ownerClaimsSource(ownerState, sourceRoot, fsImpl, platform);
    if (!preNeedsMutation && !ownerNeedsMutation) {
      logRegister(options, pre.effective ? pre.effective.path : configPath, canonicalEntry, false, false, true);
      return {
        status: "ok",
        added: false,
        skipped: true,
        created: false,
        configPath: pre.effective ? pre.effective.path : configPath,
        pluginDir: canonicalEntry,
        registrationRemoved: false,
        activeEntryRemaining: true,
        managedFilesRemoved: false,
        residualPaths: [],
        warnings: preWarnings,
        mutatedPaths: [],
      };
    }

    // Deterministic test seam: lets a test converge state between the
    // lock-outside preflight and the actual lock acquisition.
    if (options.testHooks && typeof options.testHooks.beforeAcquireLock === "function") {
      options.testHooks.beforeAcquireLock({ target, configPath });
    }

    const lockResult = managedGeneration.acquireTargetLock(target, {
      operation: "register",
      fs: fsImpl,
      retry: options.automatic !== true,
    });
    if (!lockResult.ok) {
      const startup = options.automatic === true;
      return {
        status: startup ? "skipped" : "error",
        reason: "locked",
        message: `another Clawd operation holds ${target.lockPath}`,
        lockPath: target.lockPath,
        configPath,
        pluginDir: canonicalEntry,
        warnings: lockResult.inspection ? [lockResult.inspection] : [],
      };
    }

    return withTargetLock(target, lockResult.lock, fsImpl, () => {
      // Re-read inside the lock; never reuse the pre-lock conclusion.
      candidates = jsonc.readCandidates(cfg, configPath);
      const lockedOwner = readOwner();
      ownerRecord = (lockedOwner.state === "owned" || lockedOwner.state === "released") ? lockedOwner.record : null;
      if (lockedOwner.state === "foreign" || lockedOwner.state === "mismatch" || lockedOwner.state === "corrupt") {
        return {
          status: "error",
          reason: "owner-inspection-required",
          message: `managed owner record at ${target.ownerPath} is not a valid Clawd target owner; inspect manually`,
          configPath,
          pluginDir: canonicalEntry,
        };
      }
      if (lockedOwner.state === "owned" && !canonicalEqual(lockedOwner.record.activeSourceRoot, sourceRoot, fsImpl, platform)) {
        const markerAlive = managedGeneration.isLiveSourceMarker(lockedOwner.record.activeSourceMarker, fsImpl);
        if (markerAlive) {
          return {
            status: "error",
            reason: "owner-conflict",
            message: `target is owned by another live Clawd source: ${lockedOwner.record.activeSourceRoot}`,
            configPath,
            pluginDir: canonicalEntry,
            activeSourceRoot: lockedOwner.record.activeSourceRoot,
            activeSourceMarker: lockedOwner.record.activeSourceMarker,
          };
        }
      }
      const lockedPre = jsonc.inspectManagedRegister({ cfg, configPath, candidates, makeContext, canonicalEntry });
      const lockedV2Pre = v2Mode === "register"
        ? getV2Registrar().inspectV2Register({ cfg, configPath, candidates, makeContext: makeV2Context, canonicalV2Entry })
        : null;
      const lockedV2SweepPre = v2Mode === "sweep"
        ? getV2Registrar().inspectV2Unregister({ candidates, makeContext: makeV2Context })
        : null;
      const lockedV2NeedsMutation = lockedV2Pre
        ? lockedV2Pre.needsMutation
        : (lockedV2SweepPre ? lockedV2SweepPre.hasRemovable : false);
      const lockedNeedsMutation = lockedPre.needsMutation || lockedV2NeedsMutation;
      const lockedWarnings = [...lockedPre.warnings, ...v2Warnings(lockedV2Pre), ...v2Warnings(lockedV2SweepPre)];
      if (lockedPre.needsReview || (lockedV2Pre && lockedV2Pre.needsReview)) {
        const review = lockedPre.needsReview || lockedV2Pre.needsReview;
        return {
          status: "error",
          reason: review.reason,
          message: `opencode plugin entry needs manual review (${review.reason})`,
          configPath,
          pluginDir: canonicalEntry,
          details: review.details || [],
          warnings: lockedWarnings,
        };
      }

      // Race-to-no-op: if another process already converged BOTH config and
      // this source's owner while we waited for the lock, do nothing at all
      // (no materialize, no owner.updatedAt rewrite, no config write).
      const lockedOwnerNeedsMutation = !isOverride
        && !ownerClaimsSource(lockedOwner, sourceRoot, fsImpl, platform);
      if (!lockedNeedsMutation && !lockedOwnerNeedsMutation) {
        logRegister(options, lockedPre.effective ? lockedPre.effective.path : configPath, canonicalEntry, false, false, true);
        return {
          status: "ok",
          added: false,
          skipped: true,
          created: false,
          configPath: lockedPre.effective ? lockedPre.effective.path : configPath,
          pluginDir: canonicalEntry,
          ownerUpdated: false,
          warnings: lockedWarnings,
          mutatedPaths: [],
        };
      }

      const recoveryWarnings = [];
      const recoveryResidualPaths = [];
      if (!isOverride && lockedNeedsMutation && fsImpl.existsSync(managedGeneration.generationDir(target, bundleHash))) {
        const genDir = managedGeneration.generationDir(target, bundleHash);
        const inspected = managedGeneration.inspectGeneration(genDir, cfg, agentId, {
          fs: fsImpl,
          files: sourceFiles || undefined,
        });
        const knownCurrentPath = lockedOwner.state === "released"
          && Array.isArray(lockedOwner.record.knownRegisteredPaths)
          && lockedOwner.record.knownRegisteredPaths.some((knownPath) => (
            canonicalEqual(knownPath, canonicalEntry, fsImpl, platform)
          ));
        const unregisterScan = jsonc.inspectManagedUnregister({ candidates, makeContext });
        // A previous uninstall can remove the config entry successfully but
        // be interrupted halfway through deleting the generation (notably by
        // a Windows file handle).  Only a released, structurally valid owner
        // record whose bounded history proves this exact canonical path may
        // recover that unregistered residual.  Move it aside atomically;
        // never overwrite or patch the suspicious bytes in place.
        if (!inspected.ok && knownCurrentPath && unregisterScan.activeEntryRemaining === false) {
          const quarantine = managedGeneration.quarantineGeneration(target, genDir, {
            fs: fsImpl,
            platform,
            label: "recovery",
          });
          if (!quarantine.ok) {
            return {
              status: "error",
              reason: quarantine.reason,
              message: quarantine.message || `failed to quarantine released residual generation ${genDir}`,
              configPath,
              pluginDir: canonicalEntry,
            };
          }
          recoveryResidualPaths.push(quarantine.path);
          recoveryWarnings.push(`released managed residual was quarantined at ${quarantine.path}`);
        }
      }

      // Materialize/claim only for a real v1-key or owner mutation. A v2-only
      // mutation (register-mode key rewrite, or sweep of leftover entries)
      // targets the already-verified current generation — re-materializing or
      // re-claiming ownership for it would be a spurious write.
      if (!isOverride && lockedPre.needsMutation) {
        const materialized = managedGeneration.materializeGeneration(target, cfg, sourcePluginDir, {
          fs: fsImpl,
          platform,
          clawdVersion: options.clawdVersion,
        });
        if (!materialized.ok) {
          return {
            status: "error",
            reason: materialized.reason,
            message: materialized.message || "failed to materialize managed generation",
            configPath,
            pluginDir: canonicalEntry,
            residualPaths: recoveryResidualPaths,
            warnings: recoveryWarnings,
          };
        }
        bundleHash = materialized.bundleHash;
        expectedCanonicalDir = managedGeneration.canonicalizeTargetPath(materialized.pluginDir, platform, fsImpl);
        canonicalEntry = toEntryPath(materialized.pluginDir);
      }

      // Claim/refresh the owner exactly once and only when needed. This is
      // what lets a new source take over a dead previous one; a live other
      // source already returned owner-conflict above.
      const ownerUpdated = !isOverride && (lockedPre.needsMutation || lockedOwnerNeedsMutation);
      if (ownerUpdated) {
        managedGeneration.writeOwnerRecord(target, {
          agentId,
          activeSourceRoot: sourceRoot,
          activeSourceMarker: sourceMarker,
          knownRegisteredPaths: [canonicalEntry],
        }, fsImpl, ownerOptions);
      }

      let apply = { status: "ok", added: false, created: false, mutatedPaths: [], warnings: [], legacyLiterals: [] };
      if (lockedPre.needsMutation) {
        apply = jsonc.applyManagedRegister({ cfg, configPath, candidates, makeContext, canonicalEntry, options });
        if (apply.status !== "ok") {
          return {
            status: "error",
            reason: apply.reason,
            message: apply.message,
            configPath,
            pluginDir: canonicalEntry,
            mutatedPaths: apply.mutatedPaths || [],
            residualPaths: recoveryResidualPaths,
            warnings: [...recoveryWarnings, ...lockedWarnings, ...(apply.warnings || [])],
          };
        }
        const verify = jsonc.verifyManagedRegisterPostcondition({
          cfg,
          configPath,
          makeContext,
          legacyLiterals: apply.legacyLiterals,
        });
        if (!verify.ok) {
          return {
            status: "error",
            reason: "postcondition-failed",
            message: `config postcondition not met after write: ${verify.reason}`,
            configPath,
            pluginDir: canonicalEntry,
            mutatedPaths: apply.mutatedPaths,
            residualPaths: recoveryResidualPaths,
            warnings: [...recoveryWarnings, ...lockedWarnings, ...(apply.warnings || [])],
          };
        }
      }

      // v2 `plugins` key runs after the v1 key write (which may have created
      // the default config file) and re-reads the candidates itself — the v1
      // apply may have mutated the same files moments ago inside this lock.
      // lockedV2Pre is therefore only a heuristic here: when the v1 apply
      // created the config, the pre-apply v2 scan saw no file at all, so the
      // apply must also run whenever the v1 key mutated (applyV2Register
      // no-ops on an already-converged config).
      let v2Apply = { status: "ok", added: false, created: false, mutatedPaths: [], warnings: [] };
      if (v2Mode === "register" && (lockedPre.needsMutation || lockedV2Pre.needsMutation)) {
        v2Apply = getV2Registrar().applyV2Register({
          cfg,
          configPath,
          candidates: getV2Registrar().readV2Candidates(cfg, configPath),
          makeContext: makeV2Context,
          canonicalV2Entry,
          options,
        });
        if (v2Apply.status !== "ok") {
          return {
            status: "error",
            reason: v2Apply.reason,
            message: v2Apply.message,
            configPath,
            pluginDir: canonicalEntry,
            mutatedPaths: [...apply.mutatedPaths, ...v2Apply.mutatedPaths],
            residualPaths: recoveryResidualPaths,
            warnings: [...recoveryWarnings, ...lockedWarnings, ...(apply.warnings || []), ...(v2Apply.warnings || [])],
          };
        }
        const v2Verify = getV2Registrar().verifyV2RegisterPostcondition({
          cfg,
          configPath,
          makeContext: makeV2Context,
        });
        if (!v2Verify.ok) {
          return {
            status: "error",
            reason: "postcondition-failed",
            message: `v2 plugins-key postcondition not met after write: ${v2Verify.reason}`,
            configPath,
            pluginDir: canonicalEntry,
            mutatedPaths: [...apply.mutatedPaths, ...v2Apply.mutatedPaths],
            residualPaths: recoveryResidualPaths,
            warnings: [...recoveryWarnings, ...lockedWarnings, ...(apply.warnings || []), ...(v2Apply.warnings || [])],
          };
        }
      }

      // Sweep mode (v1 host detected): remove any proven-owned v2 leftovers so
      // a v2→v1 downgrade stops poisoning the config. Best-effort by contract —
      // a sweep failure (fail-closed entry, unconfirmable legacy-missing
      // candidate) must never fail the v1 registration, only warn.
      let v2SweepApply = null;
      if (v2Mode === "sweep") {
        v2SweepApply = getV2Registrar().applyV2Unregister({
          cfg,
          configPath,
          candidates: getV2Registrar().readV2Candidates(cfg, configPath),
          makeContext: makeV2Context,
          options,
        });
      }
      const v2SweepWarnings = (v2SweepResult) => {
        if (!v2SweepResult) return [];
        const out = [];
        if (v2SweepResult.removed > 0) {
          out.push(`swept ${v2SweepResult.removed} leftover v2 plugins-key entr${v2SweepResult.removed === 1 ? "y" : "ies"} (no opencode v2 host detected)`);
        }
        if (v2SweepResult.error) {
          out.push(`v2 plugins-key leftover sweep failed: ${v2SweepResult.error.reason}`);
        } else if (v2SweepResult.activeEntryRemaining) {
          out.push("v2 plugins-key leftover sweep retained a fail-closed entry; manual review required");
        }
        return out;
      };
      const warnings = [
        ...recoveryWarnings,
        ...lockedWarnings,
        ...(apply.warnings || []),
        ...(v2Apply.warnings || []),
        ...v2SweepWarnings(v2SweepApply),
      ];
      const allMutatedPaths = [
        ...apply.mutatedPaths,
        ...v2Apply.mutatedPaths,
        ...((v2SweepApply && v2SweepApply.mutatedPaths) || []),
      ];
      const effectivePath = allMutatedPaths.length
        ? allMutatedPaths[allMutatedPaths.length - 1]
        : (lockedPre.effective ? lockedPre.effective.path : configPath);
      logRegister(options, effectivePath, canonicalEntry, apply.created, apply.added, false);
      return {
        status: "ok",
        added: apply.added || v2Apply.added,
        skipped: !lockedNeedsMutation && !ownerUpdated,
        created: apply.created,
        configPath: effectivePath,
        pluginDir: canonicalEntry,
        ownerUpdated,
        registrationRemoved: false,
        activeEntryRemaining: true,
        managedFilesRemoved: false,
        residualPaths: recoveryResidualPaths,
        warnings,
        mutatedPaths: allMutatedPaths,
      };
    });
  }

  function unregisterManaged(options) {
    const jsonc = getJsoncEditor();
    const fsImpl = options.fs || fs;
    const platform = options.platform || process.platform;
    const { rootUnknown, target, configPath } = resolveManagedOperation(options);
    const sourcePluginDir = resolveSourcePluginDir();
    if (options.pluginDir) return unregisterManagedOverride(options, configPath, sourcePluginDir);
    if (!rootUnknown && !target.canonicalConfigDirResolved) {
      return {
        status: "error",
        reason: "config-dir-identity-unresolved",
        message: `could not resolve a filesystem identity for ${target.configDir}; refusing managed unregistration`,
        configPath,
        pluginDir: toEntryPath(sourcePluginDir),
        registrationRemoved: false,
        activeEntryRemaining: null,
        managedFilesRemoved: false,
        residualPaths: [],
        warnings: [],
        mutatedPaths: [],
      };
    }
    const isOverride = false;
    const cleanupAllowed = !rootUnknown && Boolean(options.homeDir || options.managedRoot);
    const ownerOptions = { platform, pluginDirName: cfg.pluginDirName };

    let sourceFiles = null;
    try {
      sourceFiles = managedGeneration.readSourceBundle(cfg, sourcePluginDir, fsImpl).files;
    } catch {
      sourceFiles = null;
    }
    const ownerRead = (isOverride || rootUnknown || !cleanupAllowed)
      ? { state: "unmanaged", record: null }
      : managedGeneration.readOwnerRecord(target, agentId, fsImpl, ownerOptions);
    let ownerRecord = (ownerRead.state === "owned" || ownerRead.state === "released") ? ownerRead.record : null;
    const sourceRoot = path.dirname(sourcePluginDir);
    const liveOtherSourceConflict = (ownerState) => {
      if (!ownerState || ownerState.state !== "owned" || !ownerState.record) return null;
      if (canonicalEqual(ownerState.record.activeSourceRoot, sourceRoot, fsImpl, platform)) return null;
      if (!managedGeneration.isLiveSourceMarker(ownerState.record.activeSourceMarker, fsImpl)) return null;
      return {
        status: "error",
        reason: "owner-conflict",
        message: `target is owned by another live Clawd source: ${ownerState.record.activeSourceRoot}. Uninstall from that source or remove its marker first.`,
        configPath,
        pluginDir: toEntryPath(sourcePluginDir),
        activeSourceRoot: ownerState.record.activeSourceRoot,
        activeSourceMarker: ownerState.record.activeSourceMarker,
        registrationRemoved: false,
        activeEntryRemaining: true,
        managedFilesRemoved: false,
        residualPaths: [],
        warnings: [],
        mutatedPaths: [],
      };
    };

    const ownerConflict = liveOtherSourceConflict(ownerRead);
    if (ownerConflict) return ownerConflict;

    let expectedCanonicalDir = null;
    if (isOverride) {
      expectedCanonicalDir = managedGeneration.canonicalizeTargetPath(options.pluginDir, platform, fsImpl);
    } else if (options.managedRoot || options.homeDir) {
      try {
        const bundle = managedGeneration.readSourceBundle(cfg, sourcePluginDir, fsImpl);
        const bundleHash = managedGeneration.computeBundleHash(agentId, bundle.files);
        expectedCanonicalDir = managedGeneration.canonicalizeTargetPath(resolveManagedPluginDir(target, bundleHash), platform, fsImpl);
      } catch {
        expectedCanonicalDir = null;
      }
    }

    const makeContext = () => getJsoncEditor().buildManagedContext({
      cfg,
      target,
      expectedCanonicalDir,
      expectedGeneration: () => ({ ok: true }),
      sourceFiles,
      ownerRecord,
      fsImpl,
      platform,
      managedBoundary: !isOverride && !rootUnknown,
    });

    const v2Enabled = familyHasV2Entry(cfg);
    let expectedCanonicalV2Dir = null;
    if (v2Enabled && expectedCanonicalDir) {
      expectedCanonicalV2Dir = managedGeneration.canonicalizeTargetPath(
        path.join(path.dirname(expectedCanonicalDir), cfg.v2PluginDirName), platform, fsImpl,
      );
    }
    const makeV2Context = v2Enabled
      ? () => getV2Registrar().buildV2ManagedContext({
        cfg,
        target,
        expectedCanonicalDir: expectedCanonicalV2Dir,
        expectedGeneration: () => ({ ok: true }),
        sourceFiles,
        ownerRecord,
        fsImpl,
        platform,
        managedBoundary: !isOverride && !rootUnknown,
      })
      : null;

    let candidates = jsonc.readCandidates(cfg, configPath);
    // Read-only scan derives `registrationRemoved` from the effective config.
    const scan = jsonc.inspectManagedUnregister({ candidates, makeContext });
    const v2Scan = v2Enabled
      ? getV2Registrar().inspectV2Unregister({ candidates, makeContext: makeV2Context })
      : null;
    const scanHasRemovable = scan.hasRemovable || (v2Scan ? v2Scan.hasRemovable : false);
    const scanActiveRemaining = scan.activeEntryRemaining || (v2Scan ? v2Scan.activeEntryRemaining : false);
    const scanWarnings = [...scan.warnings, ...(v2Scan ? v2Scan.warnings : [])];
    const scanFailClosedActive = [...scan.failClosedActive, ...(v2Scan ? v2Scan.failClosedActive.map((item) => ({ ...item, v2Key: true })) : [])];

    if (rootUnknown) {
      // configPath-only (e.g. Windows NSIS cleanup): sweep the config without
      // ever resolving or touching a managed root / lock.
      return unregisterConfigSweepOnly({
        jsonc, cfg, agentId, configPath, makeContext, makeV2Context, options, fsImpl,
        warning: "managed-root-unknown: configPath-only unregister skipped managed-file cleanup",
      });
    }
    const targetRootExists = cleanupAllowed && fsImpl.existsSync(target.targetRoot);
    if (!scanHasRemovable && !targetRootExists) {
      if (scanActiveRemaining) {
        return failClosedUnregisterResult({
          agentId,
          configPath: scan.effective ? scan.effective.path : configPath,
          pluginDir: expectedCanonicalDir ? toEntryPath(expectedCanonicalDir) : toEntryPath(sourcePluginDir),
          reason: "active-entry-remaining",
          failClosedActive: scanFailClosedActive,
          warnings: scanWarnings,
        });
      }
      return {
        status: "skipped",
        removed: 0,
        changed: false,
        skipped: true,
        created: false,
        configPath,
        pluginDir: expectedCanonicalDir ? toEntryPath(expectedCanonicalDir) : toEntryPath(sourcePluginDir),
        registrationRemoved: true,
        activeEntryRemaining: false,
        managedFilesRemoved: false,
        residualPaths: [],
        warnings: scanWarnings,
        mutatedPaths: [],
      };
    }

    const lockResult = managedGeneration.acquireTargetLock(target, {
      operation: "unregister",
      fs: fsImpl,
      retry: options.automatic !== true,
    });
    if (!lockResult.ok) {
      if (!cleanupAllowed) {
        // configPath-only callers (Windows NSIS cleanup) must not fail just
        // because we cannot locate a managed root.
        return unregisterConfigSweepOnly({
          jsonc, cfg, agentId, configPath, makeContext, makeV2Context, options, fsImpl,
          warning: "managed-root-unknown: configPath-only unregister skipped managed-file cleanup",
        });
      }
      const startup = options.automatic === true;
      return {
        status: startup ? "skipped" : "error",
        reason: "locked",
        message: `another Clawd operation holds ${target.lockPath}`,
        lockPath: target.lockPath,
        configPath,
        pluginDir: expectedCanonicalDir ? toEntryPath(expectedCanonicalDir) : toEntryPath(sourcePluginDir),
        registrationRemoved: null,
        activeEntryRemaining: null,
        managedFilesRemoved: false,
        warnings: lockResult.inspection ? [lockResult.inspection] : [],
      };
    }

    return withTargetLock(target, lockResult.lock, fsImpl, () => {
      candidates = jsonc.readCandidates(cfg, configPath);
      const lockedOwner = (cleanupAllowed)
        ? managedGeneration.readOwnerRecord(target, agentId, fsImpl, ownerOptions)
        : { state: "unmanaged", record: null };
      const lockedConflict = liveOtherSourceConflict(lockedOwner);
      if (lockedConflict) return lockedConflict;
      ownerRecord = (lockedOwner.state === "owned" || lockedOwner.state === "released") ? lockedOwner.record : null;

      const apply = jsonc.applyManagedUnregister({ cfg, configPath, candidates, makeContext, options });
      let v2Apply = { removed: 0, changed: false, mutatedPaths: [], warnings: [], activeEntryRemaining: false, effectivePath: configPath, failClosedActive: [], error: null };
      if (v2Enabled) {
        v2Apply = getV2Registrar().applyV2Unregister({
          cfg,
          configPath,
          candidates: getV2Registrar().readV2Candidates(cfg, configPath),
          makeContext: makeV2Context,
          options,
        });
      }
      const warnings = [...scanWarnings, ...(apply.warnings || []), ...(v2Apply.warnings || [])];
      let managedFilesRemoved = false;
      const residualPaths = [];
      let ownerReleased = false;
      const combinedActiveRemaining = apply.activeEntryRemaining !== false
        ? apply.activeEntryRemaining
        : v2Apply.activeEntryRemaining;

      // An active fail-closed entry (modified/corrupt/unknown) or an
      // unconfirmable legacy-missing candidate must never be reported as a
      // removed registration.
      if (apply.error || v2Apply.error || combinedActiveRemaining !== false) {
        return failClosedUnregisterResult({
          agentId,
          configPath: apply.effectivePath || v2Apply.effectivePath || configPath,
          pluginDir: expectedCanonicalDir ? toEntryPath(expectedCanonicalDir) : toEntryPath(sourcePluginDir),
          reason: (apply.error && apply.error.reason) || (v2Apply.error && v2Apply.error.reason) || "active-entry-remaining",
          failClosedActive: [...apply.failClosedActive, ...v2Apply.failClosedActive.map((item) => ({ ...item, v2Key: true }))],
          warnings,
          removed: apply.removed,
          changed: apply.changed,
          mutatedPaths: [...apply.mutatedPaths, ...v2Apply.mutatedPaths],
        });
      }

      if (cleanupAllowed && combinedActiveRemaining === false) {
        const cleanup = cleanupManagedGenerations({ cfg, target, fsImpl, platform });
        managedFilesRemoved = cleanup.removed > 0;
        residualPaths.push(...cleanup.residual);
        if (cleanup.residual.length > 0) {
          warnings.push(`managed generation cleanup incomplete; residual retained at ${cleanup.residual.join(", ")}`);
        }
        ownerRecord = null;
        try {
          const release = managedGeneration.releaseOwnerRecord(target, agentId, path.dirname(sourcePluginDir), sourcePluginDir ? path.join(sourcePluginDir, "index.mjs") : "", fsImpl, ownerOptions);
          ownerReleased = release.released;
          if (release.state === "other-source") {
            warnings.push(`managed owner record belongs to another live source; left byte-identical (${target.ownerPath})`);
          }
        } catch (err) {
          warnings.push(`owner release failed: ${err && err.message}`);
        }
        if (cleanup.removed > 0 || residualPaths.length === 0) {
          removeEmptyManagedDirs({ target, fsImpl });
        }
      } else if (rootUnknown) {
        warnings.push("managed-root-unknown: configPath-only unregister skipped managed-file cleanup");
      } else if (!cleanupAllowed) {
        warnings.push("managed-root-unknown: pluginDir override skipped managed-file cleanup");
      } else if (combinedActiveRemaining) {
        warnings.push("managed generations retained because an active Clawd entry remains");
      }

      const allRemoved = apply.removed + v2Apply.removed;
      const allChanged = apply.changed || v2Apply.changed;
      const allMutatedPaths = [...apply.mutatedPaths, ...v2Apply.mutatedPaths];
      const result = {
        status: "ok",
        removed: allRemoved,
        changed: allChanged,
        skipped: !allChanged,
        created: false,
        configPath: apply.effectivePath || v2Apply.effectivePath || configPath,
        pluginDir: expectedCanonicalDir ? toEntryPath(expectedCanonicalDir) : toEntryPath(sourcePluginDir),
        registrationRemoved: combinedActiveRemaining === false,
        activeEntryRemaining: combinedActiveRemaining,
        managedFilesRemoved,
        residualPaths,
        warnings,
        mutatedPaths: allMutatedPaths,
        ownerReleased,
      };
      if (!options.silent) console.log(`Clawd ${agentId} plugin entries removed: ${allRemoved}`);
      return result;
    });
  }

  // configPath-only unregister: sweep the config, never touch a managed root.
  function unregisterConfigSweepOnly({ jsonc, cfg, agentId, configPath, makeContext, makeV2Context, options, fsImpl, warning }) {
    const v2Enabled = familyHasV2Entry(cfg) && typeof makeV2Context === "function";
    const candidates = jsonc.readCandidates(cfg, configPath);
    const scan = jsonc.inspectManagedUnregister({ candidates, makeContext });
    const apply = jsonc.applyManagedUnregister({ cfg, configPath, candidates, makeContext, options });
    let v2Apply = { removed: 0, changed: false, mutatedPaths: [], warnings: [], activeEntryRemaining: false, effectivePath: configPath, failClosedActive: [], error: null };
    if (v2Enabled) {
      v2Apply = getV2Registrar().applyV2Unregister({
        cfg,
        configPath,
        candidates: getV2Registrar().readV2Candidates(cfg, configPath),
        makeContext: makeV2Context,
        options,
      });
    }
    const warnings = [...(scan.warnings || []), ...(apply.warnings || []), ...(v2Apply.warnings || [])];
    if (warning) warnings.push(warning);
    const combinedActiveRemaining = apply.activeEntryRemaining !== false
      ? apply.activeEntryRemaining
      : v2Apply.activeEntryRemaining;
    if (apply.error || v2Apply.error || combinedActiveRemaining !== false) {
      return failClosedUnregisterResult({
        agentId,
        configPath: apply.effectivePath || configPath,
        pluginDir: "",
        reason: (apply.error && apply.error.reason) || (v2Apply.error && v2Apply.error.reason) || "active-entry-remaining",
        failClosedActive: [...apply.failClosedActive, ...v2Apply.failClosedActive.map((item) => ({ ...item, v2Key: true }))],
        warnings,
        removed: apply.removed,
        changed: apply.changed,
        mutatedPaths: [...apply.mutatedPaths, ...v2Apply.mutatedPaths],
      });
    }
    const allRemoved = apply.removed + v2Apply.removed;
    const allChanged = apply.changed || v2Apply.changed;
    const result = {
      status: "ok",
      removed: allRemoved,
      changed: allChanged,
      skipped: !allChanged,
      created: false,
      configPath: apply.effectivePath || configPath,
      pluginDir: "",
      registrationRemoved: true,
      activeEntryRemaining: false,
      managedFilesRemoved: false,
      residualPaths: [],
      warnings,
      mutatedPaths: [...apply.mutatedPaths, ...v2Apply.mutatedPaths],
    };
    if (!options.silent) console.log(`Clawd ${agentId} plugin entries removed: ${allRemoved}`);
    return result;
  }

  // Exact, machine-usable remediation for a fail-closed active entry. v2
  // `plugins`-key entries get their own remediation text (the key differs).
  function failClosedUnregisterResult({ agentId, configPath, pluginDir, reason, failClosedActive = [], warnings = [], removed = 0, changed = false, mutatedPaths = [] }) {
    const v2Registrar = familyHasV2Entry(cfg) ? getV2Registrar() : null;
    const details = (failClosedActive || []).map(({ path: entryPath, entry, v2Key }) => ({
      category: entry.category,
      reason: entry.reason || null,
      remediation: v2Key && v2Registrar
        ? v2Registrar.describeV2Remediation(entry, entryPath)
        : entryOwnership.describeRemediation(entry, entryPath),
    }));
    const first = details[0];
    const manual = first ? ` Manual fix: ${first.remediation.configPath} plugin[${first.remediation.index}] = ${first.remediation.literal}.` : "";
    return {
      status: "error",
      reason,
      message: `refusing to report ${agentId} uninstalled: an active Clawd entry remains.${manual}`,
      removed,
      changed,
      skipped: !changed,
      created: false,
      configPath,
      pluginDir,
      registrationRemoved: false,
      activeEntryRemaining: true,
      managedFilesRemoved: false,
      residualPaths: [],
      warnings,
      mutatedPaths,
      details,
    };
  }

  function cleanupManagedGenerations({ cfg, target, fsImpl, platform }) {
    let entries;
    try {
      entries = fsImpl.readdirSync(target.generationsDir);
    } catch {
      return { removed: 0, residual: [] };
    }
    const generationsCanonical = managedGeneration.canonicalizeTargetPath(target.generationsDir, platform, fsImpl);
    let removed = 0;
    const residual = [];
    for (const name of entries) {
      const genDir = path.join(target.generationsDir, name);
      const canonical = managedGeneration.canonicalizeTargetPath(genDir, platform, fsImpl);
      if (!managedGeneration.isPathWithin(canonical, generationsCanonical)) {
        residual.push(genDir);
        continue;
      }
      const inspected = managedGeneration.inspectGeneration(genDir, cfg, agentId, { fs: fsImpl });
      if (!inspected.ok) {
        residual.push(genDir);
        continue;
      }
      const quarantine = managedGeneration.quarantineGeneration(target, genDir, {
        fs: fsImpl,
        platform,
        label: "cleanup",
      });
      if (!quarantine.ok) {
        residual.push(genDir);
        continue;
      }
      try {
        fsImpl.rmSync(quarantine.path, { recursive: true, force: true });
        removed++;
      } catch (err) {
        residual.push(quarantine.path);
      }
    }
    return { removed, residual };
  }

  function removeEmptyManagedDirs({ target, fsImpl }) {
    const candidates = [
      target.generationsDir,
      target.lockPath,
      target.targetRoot,
      path.join(target.agentRoot, "homes"),
      target.agentRoot,
    ];
    for (const dir of candidates) {
      try { fsImpl.rmdirSync(dir); } catch {}
    }
  }

  /**
   * Register the Clawd family plugin in the host's global config.
   *
   * @param {object} [options]
   * @param {boolean} [options.silent]   suppress console output
   * @param {string}  [options.homeDir]  target home (sandbox-safe)
   * @param {string}  [options.configPath]  override config path (for tests)
   * @param {string}  [options.pluginDir]   override plugin dir absolute path (test-only)
   * @returns {object}
   */
  function register(options = {}) {
    if (cfg.managedMaterialization === true) {
      const prepared = { ...options };
      // Upstream PR #1045 review: the v2 `plugins` write follows the detected
      // host (opencode <= 1.18.15 rejects unknown top-level keys). Tests pin
      // options.v2Host directly; production probes the real binary here.
      if (familyHasV2Entry(cfg) && !prepared.pluginDir) {
        prepared.v2Host = resolveV2Host(prepared);
      }
      return registerManaged(prepared);
    }

    // options.homeDir mirrors unregister() (see below). Without it a caller
    // that passes a sandbox home — tests, cleanup planning — silently writes
    // to the REAL ~/.config, which is how #825's verification harness first
    // clobbered a live config.
    const configDir = path.join(options.homeDir || os.homedir(), ...cfg.configDirSegments);
    const configPath = options.configPath || path.join(configDir, cfg.configFileName);
    const pluginDir = options.pluginDir || resolvePluginDir();

    // Skip if the host's config dir doesn't exist (host not installed) — unless caller overrides
    if (!options.configPath) {
      let exists = false;
      try { exists = fs.statSync(configDir).isDirectory(); } catch {}
      if (!exists) {
        if (!options.silent) {
          console.log(`Clawd: ${PARENT_DIR_DISPLAY} not found — skipping ${agentId} plugin registration`);
        }
        return {
          added: false,
          skipped: true,
          created: false,
          reason: `${agentId}-not-found`,
          configPath,
          pluginDir,
        };
      }
    }

    if (cfg.jsonc) {
      return getJsoncEditor().registerJsonc({ cfg, agentId, configPath, pluginDir, options });
    }

    let settings = {};
    let created = false;
    try {
      settings = readJsonFile(configPath);
      if (!settings || typeof settings !== "object") settings = {};
    } catch (err) {
      if (err.code === "ENOENT") {
        settings = cfg.schema ? { $schema: cfg.schema } : {};
        created = true;
      } else {
        // Parse error or other I/O — do not clobber the user's config
        throw new Error(`Failed to read ${configPath}: ${err.message}`);
      }
    }

    if (!Array.isArray(settings.plugin)) settings.plugin = [];

    // Idempotency: match by exact path OR by directory basename on an
    // absolute-path entry. Basename catches stale paths from earlier installs
    // at different locations (dev vs packaged) and updates them in place.
    // The isAbsolute guard is critical: the host also accepts npm package
    // specifiers in the plugin array (e.g. "opencode-wakatime" or a scoped
    // "@vendor/opencode-plugin"), and path.basename of a scoped package name
    // happens to return the segment after the slash — so a naive basename
    // equality would stomp any third-party scoped package ending in
    // "/<agent>-plugin". Clawd itself only ever writes absolute paths, so
    // restricting the match to absolute entries is safe.
    let matchIndex = -1;
    for (let i = 0; i < settings.plugin.length; i++) {
      const entry = settings.plugin[i];
      if (typeof entry !== "string") continue;
      if (entry === pluginDir) {
        matchIndex = i;
        break;
      }
      const normalized = entry.replace(/\\/g, "/");
      // Platform-agnostic absolute-path check: POSIX (/foo) or Windows (C:/foo).
      // Config files can sync across machines, so we accept either shape.
      const isAbsolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
      if (isAbsolute && path.posix.basename(normalized) === PLUGIN_DIR_NAME) {
        matchIndex = i;
        break;
      }
    }

    let added = false;
    let skipped = false;
    if (matchIndex === -1) {
      settings.plugin.push(pluginDir);
      added = true;
    } else if (settings.plugin[matchIndex] !== pluginDir) {
      // Stale path (e.g. old install location) — update in place
      settings.plugin[matchIndex] = pluginDir;
      added = true; // counts as a change for atomic write
    } else {
      skipped = true;
    }

    if (!skipped) {
      writeJsonAtomic(configPath, settings);
    }

    if (!options.silent) {
      console.log(`Clawd ${agentId} plugin → ${configPath}`);
      if (created) console.log(`  Created ${cfg.configFileName}`);
      if (added) console.log(`  Registered: ${pluginDir}`);
      if (skipped) console.log(`  Already registered: ${pluginDir}`);
    }

    return { added, skipped, created, configPath, pluginDir };
  }

  function unregister(options = {}) {
    if (cfg.managedMaterialization === true) return unregisterManaged(options);

    const configDir = path.join(options.homeDir || os.homedir(), ...cfg.configDirSegments);
    const configPath = options.configPath || path.join(configDir, cfg.configFileName);
    const pluginDir = options.pluginDir || resolvePluginDir();

    if (cfg.jsonc) {
      return getJsoncEditor().unregisterJsonc({ cfg, agentId, configPath, pluginDir, options });
    }

    let settings = {};
    try {
      settings = readJsonFile(configPath);
      if (!settings || typeof settings !== "object") settings = {};
    } catch (err) {
      if (err.code === "ENOENT") return { removed: 0, changed: false, skipped: true, configPath, pluginDir };
      throw new Error(`Failed to read ${configPath}: ${err.message}`);
    }

    if (!Array.isArray(settings.plugin)) {
      return { removed: 0, changed: false, skipped: true, configPath, pluginDir };
    }

    const before = settings.plugin.length;
    settings.plugin = settings.plugin.filter((entry) => !entryIsExactManagedPlugin(entry, pluginDir));
    const removed = before - settings.plugin.length;
    const changed = removed > 0;

    let backupPath = null;
    if (changed) backupPath = writeJsonAtomicWithBackup(configPath, settings, options);
    if (!options.silent) console.log(`Clawd ${agentId} plugin entries removed: ${removed}`);
    const result = { removed, changed, skipped: !changed, configPath, pluginDir };
    if (options.backup === true) result.backupPath = backupPath;
    return result;
  }

  return {
    register,
    unregister,
    resolvePluginDir,
    resolveSourcePluginDir,
    resolveManagedTarget,
    resolveManagedPluginDir,
    DEFAULT_PARENT_DIR,
    DEFAULT_CONFIG_PATH,
    __test: { entryIsExactManagedPlugin, normalizePluginEntry },
  };
}

module.exports = {
  makeFamilyInstaller,
  __test: { entryIsExactManagedPlugin, normalizePluginEntry },
};
