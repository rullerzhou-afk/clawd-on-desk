"use strict";

// ── Settings actions (transport-agnostic) ──
//
// Two registries:
//
//   updateRegistry  — single-field updates. Each entry is EITHER:
//
//     (a) a plain function `(value, deps) => { status, message? }` —
//         a PURE VALIDATOR with no side effect. Used for fields whose
//         truth lives entirely inside prefs (lang, soundMuted, ...).
//         Reactive UI projection lives in main.js subscribers.
//
//     (b) an object `{ validate, effect }` — a PRE-COMMIT GATE for
//         fields whose truth depends on the OUTSIDE WORLD (the OS login
//         items database, ~/.claude/settings.json, etc.). The effect
//         actually performs the system call; if it fails, the controller
//         does NOT commit, so prefs cannot drift away from system reality.
//         Effects can be sync or async; effects throw → controller wraps
//         as { status: 'error' }.
//
//     Why both forms coexist: the gate-vs-projection split is real (see
//     plan-settings-panel.md §4.2). Forcing every entry to be a gate
//     would create empty effect functions for pure-data fields and blur
//     the contract. Forcing every effect into a subscriber would make
//     "save the system call's failure" impossible because subscribers
//     run AFTER commit and can't unwind it.
//
//   commandRegistry — non-field actions like `removeTheme`, `installHooks`,
//                     `registerShortcut`. These return
//                     `{ status, message?, commit? }`. If `commit` is present,
//                     the controller calls `_commit(commit)` after success so
//                     commands can update store fields atomically with their
//                     side effects.
//
// This module imports nothing from electron, the store, or the controller.
// All deps that an action needs are passed via the second argument:
//
//   actionFn(value, { snapshot, ...injectedDeps })
//
// `injectedDeps` is whatever main.js passed to `createSettingsController`. For
// effect-bearing entries this MUST include the system helpers the effect
// needs (e.g. `setLoginItem`, `registerHooks`) — actions never `require()`
// electron or fs directly so the test suite can inject mocks.
//
// HYDRATE PATH: `controller.hydrate(partial)` runs only the validator and
// SKIPS the effect. This is how startup imports system-backed values into
// prefs without writing them right back. Object-form entries must therefore
// keep validate side-effect-free.

const {
  CURRENT_VERSION,
  MAX_CUSTOM_DISCOVERY_PATHS,
  MAX_HIDDEN_QUOTA_PROVIDERS,
  isValidSettingsWindowBounds,
  normalizePathList,
} = require("./prefs");
const {
  MAX_CUSTOM_APPLICATIONS,
  normalizeCustomApplications,
} = require("./custom-applications");
const {
  TEXT_SCALE_MIN,
  TEXT_SCALE_MAX,
  isValidTextScale,
  normalizeTextScaleByDisplay,
} = require("./text-scale");
const {
  isPetTintId,
  isPetAccessoryId,
} = require("./pet-customization-catalog");
const { isValidDisplaySnapshot } = require("./work-area");
const {
  MAX_AUTO_CLOSE_SECONDS,
  buildAggregateHideCommit,
  buildCategoryEnabledCommit,
} = require("./bubble-policy");
const {
  normalizeSessionAliases,
  pruneExpiredSessionAliases,
  sanitizeSessionAlias,
  sessionAliasKey,
} = require("./session-alias");
const { validateShortcutMapShape } = require("./shortcut-actions");
const {
  requireBoolean,
  requireFiniteNumber,
  requireNonNegativeFiniteNumber,
  requireNumberInRange,
  requireIntegerInRange,
  requireEnum,
  requireString,
  requirePlainObject,
} = require("./settings-validators");
const { listIdleVisualOptions } = require("./idle-visual");
const {
  registerShortcut,
  resetShortcut,
  resetAllShortcuts,
} = require("./settings-actions-shortcuts");
const {
  addCustomApplication,
  clearAgentCleanupHints,
  clearAgentInstallHints,
  deployToWsl,
  dismissAgentCleanupHints,
  installAgentIntegration,
  dismissAgentInstallHints,
  removeFromWsl,
  removeCustomApplication,
  setAgentCustomDiscoveryPaths,
  setAgentCustomPermissionUrl,
  setAgentFlag,
  setAgentPermissionMode,
  uninstallAgentIntegration,
  repairAgentIntegration,
} = require("./settings-actions-agents");
const {
  ANIMATION_OVERRIDES_EXPORT_VERSION,
  ONESHOT_OVERRIDE_STATES,
  importAnimationOverrides,
  resetThemeOverrides,
  setAnimationOverride,
  setSoundOverride,
  setThemeOverrideDisabled,
  setWideHitboxOverride,
} = require("./settings-actions-theme-overrides");
const {
  autoStartWithClaude,
  createRepairDoctorIssue,
  installHooks,
  manageClaudeHooksAutomatically,
  openAtLogin,
  repairLocalServer,
  uninstallHooks,
} = require("./settings-actions-system");
const {
  validateProfile: validateRemoteSshProfile,
  sanitizeProfile: sanitizeRemoteSshProfile,
  isValidDetectedRemoteNodeBin,
  isValidDetectedRemoteNodeVersion,
  isValidDetectedRemoteNodeSource,
  deployTargetFingerprint,
  deployTargetDrift,
  normalizeManagedDeployTargets,
  sanitizeManagedDeployTarget,
  remoteAccountKey,
  isValidInstallId,
  isValidRoutingNonce,
  sanitizeIsolatedRuntime,
  sanitizeRuntimeModeTxn,
  REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT,
  REMOTE_RUNTIME_MODE_PROFILE_ISOLATED,
  ACCOUNT_DEFAULT_RUNTIME_KEY,
  REMOTE_LAYOUT_VERSION,
} = require("./remote-ssh-profile");
const {
  createIdentityTxn,
  updateIdentityTxnStep,
  commitIdentityTxn,
  cloneRecoverRemoteSsh,
  forceRevokeOldIdentity,
  abortIdentityTxnToEmergencyNonce,
} = require("./remote-ssh-identity");
const {
  validateTelegramApproval,
  validateTelegramBotToken,
} = require("./telegram-approval-settings");
const { validateDiscordPresence } = require("./discord-presence-settings");
const {
  normalizeFeishuApproval,
  validateFeishuApproval,
  evaluateFeishuApprovalConfiguration,
  planFeishuCredentialWrite,
} = require("./feishu-approval-settings");
const { classifyFeishuApprovalRecipient } = require("./feishu-approval-recipient");
const { EVENTS: TELEGRAM_MIGRATION_EVENTS } = require("./telegram-migration-state");

// Only the Step-3 enable switch dispatches from the renderer since the
// migration card retired: turn-on tests native, turn-off disables. The
// legacy-enable / rollback transitions stay in the reducer for main-side
// integrity but are no longer renderer-callable.
const TELEGRAM_MIGRATION_RENDERER_EVENTS = new Set([
  TELEGRAM_MIGRATION_EVENTS.USER_TEST_NATIVE,
  TELEGRAM_MIGRATION_EVENTS.USER_DISABLE,
]);

const MANAGED_CLEANUP_AGENT_IDS = Object.freeze([
  "claude-code",
  "deepseek-harness",
  "codex",
  "copilot-cli",
  "cursor-agent",
  "gemini-cli",
  "antigravity-cli",
  "codebuddy",
  "workbuddy",
  "kiro-cli",
  "kimi-cli",
  "qwen-code",
  "zcode",
  "codewhale",
  "opencode",
  "mimocode",
  "pi",
  "openclaw",
  "hermes",
  "qoder",
  "reasonix",
  "qoderwork",
  "qwenwork",
]);

// ── updateRegistry ──
// Maps prefs field name → validator. Controller looks up by key and runs.

function validateFeishuApprovalUpdate(value, deps = {}) {
  const current = normalizeFeishuApproval(
    deps.snapshot && deps.snapshot.feishuApproval
  );
  for (const key of [
    "idType",
    "approverId",
    "approverSource",
    "approverBoundPlatform",
    "approverBoundAppId",
  ]) {
    if (!value || value[key] !== current[key]) {
      return { status: "error", code: "approver-command-required" };
    }
  }
  return validateFeishuApproval(value);
}

const updateRegistry = {
  // ── Window state ──
  x: requireFiniteNumber("x"),
  y: requireFiniteNumber("y"),
  size(value) {
    if (typeof value !== "string") {
      return { status: "error", message: "size must be a string" };
    }
    if (value === "S" || value === "M" || value === "L") return { status: "ok" };
    if (/^P:\d+(?:\.\d+)?$/.test(value)) return { status: "ok" };
    return {
      status: "error",
      message: `size must be S/M/L or P:<num>, got: ${value}`,
    };
  },

  // ── Mini mode persisted state ──
  miniMode: requireBoolean("miniMode"),
  miniEdge: requireEnum("miniEdge", ["left", "right"]),
  preMiniX: requireFiniteNumber("preMiniX"),
  preMiniY: requireFiniteNumber("preMiniY"),
  positionSaved: requireBoolean("positionSaved"),
  positionThemeId: requireString("positionThemeId", { allowEmpty: true }),
  positionVariantId: requireString("positionVariantId", { allowEmpty: true }),
  // Written only by flushRuntimeStateToPrefs() with a snapshot Electron just
  // handed us; null marks "no snapshot yet" (legacy prefs, headless CI, the
  // rare startup race where screen.* is still coming up).
  positionDisplay: (value) => {
    if (value === null || isValidDisplaySnapshot(value)) return { status: "ok" };
    return { status: "error", message: "positionDisplay must be null or a valid display snapshot" };
  },
  savedPixelWidth: requireNonNegativeFiniteNumber("savedPixelWidth"),
  savedPixelHeight: requireNonNegativeFiniteNumber("savedPixelHeight"),
  settingsWindowBounds: (value) => {
    if (value === null || isValidSettingsWindowBounds(value)) return { status: "ok" };
    return {
      status: "error",
      message: "settingsWindowBounds must be null or integer { x, y, width, height } with positive dimensions",
    };
  },
  dashboardWindowBounds: (value) => {
    if (value === null || isValidSettingsWindowBounds(value)) return { status: "ok" };
    return {
      status: "error",
      message: "dashboardWindowBounds must be null or integer { x, y, width, height } with positive dimensions",
    };
  },
  // #408: frozen-origin work area for keepSizeAcrossDisplays. null = unknown
  // (legacy prefs / never seeded); otherwise positive width+height.
  savedPixelWorkArea: (value) => {
    if (value === null) return { status: "ok" };
    if (!value || typeof value !== "object") {
      return { status: "error", message: "savedPixelWorkArea must be null or { width, height }" };
    }
    const w = Number(value.width);
    const h = Number(value.height);
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
      return { status: "error", message: "savedPixelWorkArea.width/height must be positive finite numbers" };
    }
    return { status: "ok" };
  },

  // ── Pure data prefs (function-form: validator only) ──
  lang: requireEnum("lang", ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"]),
  tutorialSeen: requireBoolean("tutorialSeen"),
  soundMuted: requireBoolean("soundMuted"),
  soundVolume: requireNumberInRange("soundVolume", 0, 1),
  textScale: requireNumberInRange("textScale", TEXT_SCALE_MIN, TEXT_SCALE_MAX),
  // Committed by the setTextScaleForDisplay command (the controller requires
  // every commit key to have a registry entry). Strict per-entry validation
  // so a direct settings:update can't park junk in the in-memory store.
  textScaleByDisplay: (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: "textScaleByDisplay must be an object map" };
    }
    for (const [key, raw] of Object.entries(value)) {
      if (typeof key !== "string" || !key.trim() || !isValidTextScale(raw)) {
        return {
          status: "error",
          message: `textScaleByDisplay entry "${key}" must map a display id to ${TEXT_SCALE_MIN}–${TEXT_SCALE_MAX}`,
        };
      }
    }
    return { status: "ok" };
  },
  flashTaskbarOnComplete: requireBoolean("flashTaskbarOnComplete"),
  flashIntervalMs: requireNumberInRange("flashIntervalMs", 200, 2000),
  flashDurationMs: requireNumberInRange("flashDurationMs", 0, 60000),
  testReactionsEnabled: requireBoolean("testReactionsEnabled"),
  codexHookHealthNotifyEnabled: requireBoolean("codexHookHealthNotifyEnabled"),
  codexHookHealthLastNotified: requireString("codexHookHealthLastNotified", { allowEmpty: true }),
  telegramMigrationLastNotified: requireString("telegramMigrationLastNotified", { allowEmpty: true }),
  lowPowerIdleMode: requireBoolean("lowPowerIdleMode"),
  keepAwakeWhileWorking: requireBoolean("keepAwakeWhileWorking"),
  petTint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: "petTint must be a theme-to-tint object" };
    }
    for (const [themeId, tintId] of Object.entries(value)) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(themeId)
        || !isPetTintId(tintId)
        || tintId === "none"
      ) {
        return {
          status: "error",
          message: `petTint entry "${themeId}" must map a safe theme id to a non-default catalog tint id`,
        };
      }
    }
    return { status: "ok" };
  },
  petAccessory(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: "petAccessory must be a theme-to-accessory object" };
    }
    for (const [themeId, accessoryId] of Object.entries(value)) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(themeId)
        || !isPetAccessoryId(accessoryId)
        || accessoryId === "none"
      ) {
        return {
          status: "error",
          message: `petAccessory entry "${themeId}" must map a safe theme id to a non-default catalog accessory id`,
        };
      }
    }
    return { status: "ok" };
  },
  holidayAccessoryEnabled(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: "holidayAccessoryEnabled must be a theme-to-boolean object" };
    }
    for (const [themeId, enabled] of Object.entries(value)) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(themeId)
        || enabled !== true
      ) {
        return {
          status: "error",
          message: `holidayAccessoryEnabled entry "${themeId}" must map a safe theme id to true`,
        };
      }
    }
    return { status: "ok" };
  },
  bubbleFollowPet: requireBoolean("bubbleFollowPet"),
  sessionHudEnabled: requireBoolean("sessionHudEnabled"),
  sessionHudShowStateLabels: requireBoolean("sessionHudShowStateLabels"),
  sessionHudShowElapsed: requireBoolean("sessionHudShowElapsed"),
  sessionHudShowContextUsage: requireBoolean("sessionHudShowContextUsage"),
  sessionHudShowQuota: requireBoolean("sessionHudShowQuota"),
  quotaRingDisplayMode: requireEnum("quotaRingDisplayMode", ["used", "remaining"]),
  // Shape only — the entries are provider keys, and deliberately not checked
  // against the ring's provider list here (see prefs.js: rejecting an
  // unfamiliar key would un-hide a provider behind the user's back).
  quotaRingHiddenProviders(value) {
    if (!Array.isArray(value)) {
      return { status: "error", message: "quotaRingHiddenProviders must be an array" };
    }
    if (value.length > MAX_HIDDEN_QUOTA_PROVIDERS) {
      return {
        status: "error",
        message: `quotaRingHiddenProviders must contain at most ${MAX_HIDDEN_QUOTA_PROVIDERS} entries`,
      };
    }
    if (value.some((entry) => typeof entry !== "string" || !entry.trim())) {
      return { status: "error", message: "quotaRingHiddenProviders must contain non-empty strings" };
    }
    return { status: "ok" };
  },
  claudeQuotaCollectionEnabled: {
    validate: requireBoolean("claudeQuotaCollectionEnabled"),
    effect(value, deps = {}) {
      if (typeof deps.setClaudeQuotaCollectionEnabled !== "function") {
        return { status: "error", message: "Claude usage collection is unavailable" };
      }
      return deps.setClaudeQuotaCollectionEnabled(value);
    },
  },
  // Only the dedicated, trusted Kimi quota IPC path may change this opt-in.
  // Generic settings:update/applyBulk/hydrate are intentionally rejected by
  // the controller's commandOnly boundary.
  kimiQuotaCollectionEnabled: {
    validate: requireBoolean("kimiQuotaCollectionEnabled"),
    commandOnly: true,
  },
  quotaMergeSources: requireBoolean("quotaMergeSources"),
  sessionHudCleanupDetached: requireBoolean("sessionHudCleanupDetached"),
  sessionHudPinned: requireBoolean("sessionHudPinned"),
  hideBubbles: requireBoolean("hideBubbles"),
  permissionBubblesEnabled: requireBoolean("permissionBubblesEnabled"),
  // Permission automation is safety-sensitive: the command path owns its
  // warning/confirmation gate and the coupled mode + dismissal commit. Keep
  // the validators available for defensive command validation, but reject
  // generic applyUpdate/applyBulk/hydrate callers at the controller boundary.
  permissionAutomationMode: {
    validate: requireEnum("permissionAutomationMode", [
      "off",
      "auto-tools",
      "unattended",
    ]),
    commandOnly: true,
  },
  permissionAutomationAutoToolsWarningDismissed: {
    validate: requireBoolean("permissionAutomationAutoToolsWarningDismissed"),
    commandOnly: true,
  },
  permissionAutomationUnattendedWarningDismissed: {
    validate: requireBoolean("permissionAutomationUnattendedWarningDismissed"),
    commandOnly: true,
  },
  // Legacy tombstone: readable/validatable for old snapshots, never writable
  // through a generic controller API.
  autoApproveAllPermissions: {
    validate: requireBoolean("autoApproveAllPermissions"),
    commandOnly: true,
  },
  notificationBubbleAutoCloseSeconds: requireIntegerInRange(
    "notificationBubbleAutoCloseSeconds",
    0,
    MAX_AUTO_CLOSE_SECONDS
  ),
  permissionBubbleAutoCloseSeconds: requireIntegerInRange(
    "permissionBubbleAutoCloseSeconds",
    0,
    MAX_AUTO_CLOSE_SECONDS
  ),
  updateBubbleAutoCloseSeconds: requireIntegerInRange(
    "updateBubbleAutoCloseSeconds",
    0,
    MAX_AUTO_CLOSE_SECONDS
  ),
  // Session stale-cleanup intervals. Cross-field invariant
  // (sessionStaleMs > 0 -> workingStaleMs <= sessionStaleMs) is enforced
  // here against the live snapshot AND atomically through the
  // `sessionCleanup.setTriple` command below. Hand-edit fallback lives in
  // prefs.normalizeStaleTriple.
  sessionStaleMs(value, deps = {}) {
    if (value === 0) return { status: "ok" };
    const base = requireIntegerInRange("sessionStaleMs", 60_000, 86_400_000)(value);
    if (base.status !== "ok") return base;
    const snapshot = (deps && deps.snapshot) || {};
    const currentWorking = Number(snapshot.workingStaleMs);
    if (Number.isFinite(currentWorking) && currentWorking > value) {
      return {
        status: "error",
        message:
          `sessionStaleMs (${value}) must be >= workingStaleMs (${currentWorking}). ` +
          "To lower both, use the Reset / paired control.",
      };
    }
    return { status: "ok" };
  },
  workingStaleMs(value, deps = {}) {
    const base = requireIntegerInRange("workingStaleMs", 30_000, 86_400_000)(value);
    if (base.status !== "ok") return base;
    const snapshot = (deps && deps.snapshot) || {};
    const currentSession = Number(snapshot.sessionStaleMs);
    if (Number.isFinite(currentSession) && currentSession > 0 && value > currentSession) {
      return {
        status: "error",
        message: `workingStaleMs (${value}) must be <= sessionStaleMs (${currentSession}).`,
      };
    }
    return { status: "ok" };
  },
  detachedIdleStaleMs: requireIntegerInRange("detachedIdleStaleMs", 5_000, 300_000),
  allowEdgePinning: requireBoolean("allowEdgePinning"),
  disableMiniMode: requireBoolean("disableMiniMode"),
  freeRoam: requireBoolean("freeRoam"),
  roamConstrainAxis: requireBoolean("roamConstrainAxis"),
  keepSizeAcrossDisplays: requireBoolean("keepSizeAcrossDisplays"),
  fullscreenOverlay: requireBoolean("fullscreenOverlay"),
  mobilePreviewEnabled: {
    validate: requireBoolean("mobilePreviewEnabled"),
    lockKey: "mobilePreview",
  },
  // Enabling this field is consent-sensitive and must go through the dedicated
  // command below. Keeping the validator here lets the controller defensively
  // validate command commits without opening a generic write path.
  mobilePermissionPreviewEnabled: {
    validate: requireBoolean("mobilePermissionPreviewEnabled"),
    commandOnly: true,
    lockKey: "mobilePreview",
  },

  // ── System-backed prefs (object-form: validate + effect pre-commit gate) ──
  autoStartWithClaude,
  manageClaudeHooksAutomatically,
  openAtLogin,

  // openAtLoginHydrated is set exactly once by hydrateSystemBackedSettings()
  //   on first run after the openAtLogin field is added. Pure validator —
  //   no effect. After hydration prefs becomes the source of truth and the
  //   user-visible toggle goes through the openAtLogin gate above.
  openAtLoginHydrated: requireBoolean("openAtLoginHydrated"),

  // ── macOS visibility (cross-field validation) ──
  showTray(value, { snapshot }) {
    if (typeof value !== "boolean") {
      return { status: "error", message: "showTray must be a boolean" };
    }
    if (!value && snapshot && snapshot.showDock === false) {
      return {
        status: "error",
        message: "Cannot hide Menu Bar while Dock is also hidden — Clawd would become unquittable.",
      };
    }
    return { status: "ok" };
  },
  showDock(value, { snapshot }) {
    if (typeof value !== "boolean") {
      return { status: "error", message: "showDock must be a boolean" };
    }
    if (!value && snapshot && snapshot.showTray === false) {
      return {
        status: "error",
        message: "Cannot hide Dock while Menu Bar is also hidden — Clawd would become unquittable.",
      };
    }
    return { status: "ok" };
  },

  // Strict activation gate. Startup uses the lenient path + hydrate() so
  // a deleted theme can't brick boot without polluting this effect.
  theme: {
    validate: requireString("theme"),
    effect(value, deps) {
      if (!deps || typeof deps.activateTheme !== "function") {
        return {
          status: "error",
          message: "theme effect requires activateTheme dep",
        };
      }
      try {
        const snapshot = (deps && deps.snapshot) || {};
        const currentOverrides = snapshot.themeOverrides || {};
        deps.activateTheme(value, null, currentOverrides[value] || null);
        return { status: "ok" };
      } catch (err) {
        return {
          status: "error",
          message: `theme: ${err && err.message}`,
        };
      }
    },
  },

  // ── #329 background update check (Phase 4) ──
  autoUpdateCheck: requireBoolean("autoUpdateCheck"),
  pendingUpdateVersion: requireString("pendingUpdateVersion", { allowEmpty: true }),
  dismissedUpdateVersions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: "dismissedUpdateVersions must be a plain object" };
    }
    for (const key of Object.keys(value)) {
      if (typeof key !== "string" || !key) {
        return { status: "error", message: "dismissedUpdateVersions keys must be non-empty strings" };
      }
      if (value[key] !== true) {
        return { status: "error", message: `dismissedUpdateVersions["${key}"] must be the literal true` };
      }
    }
    return { status: "ok" };
  },
  dismissedAgentInstallHints(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: "dismissedAgentInstallHints must be a plain object" };
    }
    for (const key of Object.keys(value)) {
      if (typeof key !== "string" || !key) {
        return { status: "error", message: "dismissedAgentInstallHints keys must be non-empty strings" };
      }
      if (value[key] !== true) {
        return { status: "error", message: `dismissedAgentInstallHints["${key}"] must be the literal true` };
      }
    }
    return { status: "ok" };
  },
  dismissedAgentCleanupHints(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: "dismissedAgentCleanupHints must be a plain object" };
    }
    for (const key of Object.keys(value)) {
      if (typeof key !== "string" || !key) {
        return { status: "error", message: "dismissedAgentCleanupHints keys must be non-empty strings" };
      }
      if (value[key] !== true) {
        return { status: "error", message: `dismissedAgentCleanupHints["${key}"] must be the literal true` };
      }
    }
    return { status: "ok" };
  },

  // Custom application commands commit these top-level prefs fields. Keep
  // strict registry entries here because the controller rejects every command
  // commit key that is not registered, even when prefs.js already knows it.
  customToolDiscoveryPaths(value) {
    if (!Array.isArray(value)) {
      return { status: "error", message: "customToolDiscoveryPaths must be an array" };
    }
    const normalized = normalizePathList(value, { maxEntries: MAX_CUSTOM_DISCOVERY_PATHS + 1 });
    if (
      normalized.length !== value.length
      || normalized.length > MAX_CUSTOM_DISCOVERY_PATHS
      || normalized.some((entry, index) => entry !== value[index])
    ) {
      return {
        status: "error",
        message: `customToolDiscoveryPaths must contain at most ${MAX_CUSTOM_DISCOVERY_PATHS} normalized unique paths`,
      };
    }
    return { status: "ok" };
  },
  customApplications(value) {
    if (!Array.isArray(value) || value.length > MAX_CUSTOM_APPLICATIONS) {
      return {
        status: "error",
        message: `customApplications must be an array with at most ${MAX_CUSTOM_APPLICATIONS} entries`,
      };
    }
    const normalized = normalizeCustomApplications(value);
    const allowedKeys = new Set(["id", "name", "sourcePath", "executablePath", "processName", "category"]);
    const isNormalized = normalized.length === value.length && normalized.every((entry, index) => {
      const original = value[index];
      return original
        && typeof original === "object"
        && !Array.isArray(original)
        && Object.keys(original).every((key) => allowedKeys.has(key))
        && Object.keys(entry).every((key) => entry[key] === original[key]);
    });
    return isNormalized
      ? { status: "ok" }
      : { status: "error", message: "customApplications must contain normalized unique custom application entries" };
  },

  // ── Phase 2/3 placeholders — schema reserves these so applyUpdate accepts them ──
  agents: requirePlainObject("agents"),
  themeOverrides: requirePlainObject("themeOverrides"),
  sessionAliases(value, deps = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: "sessionAliases must be a plain object" };
    }
    const normalized = normalizeSessionAliases(value, { now: deps.now });
    if (Object.keys(normalized).length !== Object.keys(value).length) {
      return { status: "error", message: "sessionAliases must contain valid alias entries" };
    }
    return { status: "ok" };
  },

  // Phase 3b-swap: per-theme variant selection. NO effect — the runtime switch
  // runs through the `setThemeSelection` command which atomically commits
  // `theme` + `themeVariant` after calling activateTheme(themeId, variantId).
  // Letting this field have an effect would double-activate when the UI
  // updates `theme` and `themeVariant` separately.
  themeVariant: requirePlainObject("themeVariant"),
  // #509: per-theme default idle visual. Writes go through the `setIdleVisual`
  // command (which validates the file against the active theme); this entry
  // exists so applyCommand's commit re-validation accepts the key.
  idleVisual: requirePlainObject("idleVisual"),

  // Remote SSH profile store. Plain validator — actual CRUD goes through
  // commandRegistry below to keep id-uniqueness, default-fill, and
  // monotonic createdAt logic in one place. The validator only ensures the
  // top-level shape is sane so direct hydrate paths can't write garbage.
  remoteSsh(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: "remoteSsh must be a plain object" };
    }
    if (!Array.isArray(value.profiles)) {
      return { status: "error", message: "remoteSsh.profiles must be an array" };
    }
    if (value.installId !== undefined && !isValidInstallId(value.installId)) {
      return { status: "error", message: "remoteSsh.installId must be a SHA-256 hex id" };
    }
    for (let i = 0; i < value.profiles.length; i++) {
      const r = validateRemoteSshProfile(value.profiles[i]);
      if (r.status !== "ok") {
        return { status: "error", message: `remoteSsh.profiles[${i}]: ${r.message}` };
      }
    }
    return { status: "ok" };
  },
  tgApproval(value) {
    return validateTelegramApproval(value);
  },
  discordPresence(value) {
    return validateDiscordPresence(value);
  },
  feishuApproval: {
    validate: validateFeishuApprovalUpdate,
    commandOnly: true,
  },

  // v0.9.0 spike: persisted migration state across restarts. Shape:
  //   { transport?: "legacy"|"native"|"off", nativeVerifiedAt?: number|null,
  //     legacyEnabled?: boolean|null,
  //     migration?: { importedAt: number|null, importError: string|null } }
  tgMigration(value) {
    if (value == null || typeof value !== "object") {
      return { status: "error", message: "tgMigration must be a plain object" };
    }
    const allowed = new Set(["transport", "nativeVerifiedAt", "legacyEnabled", "migration"]);
    for (const k of Object.keys(value)) {
      if (!allowed.has(k)) return { status: "error", message: `tgMigration.${k} not supported` };
    }
    if (value.transport != null && !["legacy", "native", "off"].includes(value.transport)) {
      return { status: "error", message: "tgMigration.transport must be legacy|native|off" };
    }
    if (value.nativeVerifiedAt != null && (typeof value.nativeVerifiedAt !== "number" || !Number.isFinite(value.nativeVerifiedAt))) {
      return { status: "error", message: "tgMigration.nativeVerifiedAt must be a finite number" };
    }
    if (value.legacyEnabled != null && typeof value.legacyEnabled !== "boolean") {
      return { status: "error", message: "tgMigration.legacyEnabled must be boolean" };
    }
    if (value.migration != null && typeof value.migration !== "object") {
      return { status: "error", message: "tgMigration.migration must be an object" };
    }
    return { status: "ok" };
  },

  shortcuts: {
    validate(value) {
      return validateShortcutMapShape(value);
    },
  },

  // ── Internal — version is owned by prefs.js / migrate(), shouldn't normally
  //    be set via applyUpdate, but we accept it so programmatic upgrades work. ──
  version(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      return { status: "error", message: "version must be a positive number" };
    }
    if (value > CURRENT_VERSION) {
      return {
        status: "error",
        message: `version ${value} is newer than supported (${CURRENT_VERSION})`,
      };
    }
    return { status: "ok" };
  },
};

// ── commandRegistry ──
// Non-field actions. Phase 0 has only stubs — they'll be filled in by later phases.

function notImplemented(name) {
  return function () {
    return {
      status: "error",
      message: `${name}: not implemented yet (Phase 0 stub)`,
    };
  };
}

function setAllBubblesHidden(payload, deps) {
  const hidden = typeof payload === "boolean" ? payload : payload && payload.hidden;
  if (typeof hidden !== "boolean") {
    return { status: "error", message: "setAllBubblesHidden.hidden must be a boolean" };
  }
  return { status: "ok", commit: buildAggregateHideCommit(hidden, deps && deps.snapshot) };
}

function setKimiQuotaCollectionEnabled(payload) {
  const enabled = typeof payload === "boolean" ? payload : payload && payload.enabled;
  if (typeof enabled !== "boolean") {
    return {
      status: "error",
      message: "setKimiQuotaCollectionEnabled.enabled must be a boolean",
    };
  }
  return { status: "ok", commit: { kimiQuotaCollectionEnabled: enabled } };
}
setKimiQuotaCollectionEnabled.lockKey = "kimiQuota";

// Permission automation writer. A plain settings:update cannot reach this
// field; both automatic modes require confirmation at the data layer, including
// an auto-tools -> unattended escalation. Turning automation off is always
// allowed immediately.
function setPermissionAutomationMode(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setPermissionAutomationMode: payload must be an object" };
  }
  const mode = payload.mode;
  if (!["off", "auto-tools", "unattended"].includes(mode)) {
    return {
      status: "error",
      message: "setPermissionAutomationMode.mode must be off, auto-tools, or unattended",
    };
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "suppressFutureConfirmation")
    && typeof payload.suppressFutureConfirmation !== "boolean"
  ) {
    return {
      status: "error",
      message: "setPermissionAutomationMode.suppressFutureConfirmation must be a boolean",
    };
  }
  const warningKey = mode === "auto-tools"
    ? "permissionAutomationAutoToolsWarningDismissed"
    : (mode === "unattended"
      ? "permissionAutomationUnattendedWarningDismissed"
      : null);
  const snapshot = (deps && deps.snapshot) || {};
  const confirmedNow = payload.confirmed === true;
  const confirmedPreviously = warningKey && snapshot[warningKey] === true;
  if (mode !== "off" && !confirmedNow && !confirmedPreviously) {
    return {
      status: "error",
      message: "setPermissionAutomationMode: automatic modes require current or remembered confirmation",
    };
  }
  if (mode === "off" && payload.suppressFutureConfirmation === true) {
    return {
      status: "error",
      message: "setPermissionAutomationMode: off mode cannot suppress a warning",
    };
  }
  if (payload.suppressFutureConfirmation === true && !confirmedNow) {
    return {
      status: "error",
      message: "setPermissionAutomationMode: suppressing future warnings requires confirmed:true",
    };
  }
  const commit = { permissionAutomationMode: mode };
  if (warningKey && payload.suppressFutureConfirmation === true) {
    commit[warningKey] = true;
  }
  return { status: "ok", commit };
}

function setMobilePermissionPreviewEnabled(payload, deps = {}) {
  if (!payload || typeof payload !== "object") {
    return {
      status: "error",
      message: "setMobilePermissionPreviewEnabled: payload must be an object",
    };
  }
  const { enabled, confirmed, resetAccess } = payload;
  const enabledCheck = requireBoolean("setMobilePermissionPreviewEnabled.enabled")(enabled);
  if (enabledCheck.status !== "ok") return enabledCheck;
  const confirmedCheck = requireBoolean("setMobilePermissionPreviewEnabled.confirmed")(confirmed);
  if (confirmedCheck.status !== "ok") return confirmedCheck;
  const resetCheck = requireBoolean("setMobilePermissionPreviewEnabled.resetAccess")(resetAccess);
  if (resetCheck.status !== "ok") return resetCheck;

  const snapshot = deps.snapshot || {};
  if (snapshot.mobilePermissionPreviewEnabled === enabled) {
    // Check before rotating so a double click cannot invalidate the token twice.
    return { status: "ok", noop: true };
  }
  if (!enabled) {
    return { status: "ok", commit: { mobilePermissionPreviewEnabled: false } };
  }
  if (snapshot.mobilePreviewEnabled !== true) {
    return {
      status: "error",
      message: "setMobilePermissionPreviewEnabled: mobile preview must be enabled first",
    };
  }
  if (confirmed !== true) {
    return {
      status: "error",
      message: "setMobilePermissionPreviewEnabled: current disclosure confirmation is required",
    };
  }

  if (resetAccess) {
    if (typeof deps.resetMobileAccess !== "function") {
      return { status: "error", message: "mobile access reset is unavailable" };
    }
    // Reset is deliberately before the Settings commit: a reset failure must
    // leave disclosure disabled. The controller preserves these phase fields
    // if the later preference persistence fails.
    deps.resetMobileAccess();
    return {
      status: "ok",
      tokenReset: true,
      rePairRequired: true,
      commit: { mobilePermissionPreviewEnabled: true },
    };
  }
  if (typeof deps.disconnectMobilePreviewClients !== "function") {
    return { status: "error", message: "mobile client reconnect is unavailable" };
  }
  // Keeping the token authorizes all existing holders, but currently-open
  // sockets must still cross an explicit reconnect boundary before the broader
  // projection can begin flowing.
  deps.disconnectMobilePreviewClients();
  return {
    status: "ok",
    tokenReset: false,
    rePairRequired: false,
    commit: { mobilePermissionPreviewEnabled: true },
  };
}

function regenerateMobileToken(_payload, deps = {}) {
  if (typeof deps.regenerateMobileToken !== "function") {
    return { status: "error", message: "mobile token regeneration is unavailable" };
  }
  return { status: "ok", token: deps.regenerateMobileToken() };
}

function resetMobileAccess(_payload, deps = {}) {
  if (typeof deps.resetMobileAccess !== "function") {
    return { status: "error", message: "mobile access reset is unavailable" };
  }
  return { status: "ok", token: deps.resetMobileAccess() };
}

setMobilePermissionPreviewEnabled.lockKey = "mobilePreview";
regenerateMobileToken.lockKey = "mobilePreview";
resetMobileAccess.lockKey = "mobilePreview";

function setBubbleCategoryEnabled(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setBubbleCategoryEnabled: payload must be an object" };
  }
  const { category, enabled } = payload;
  const result = buildCategoryEnabledCommit((deps && deps.snapshot) || {}, category, enabled);
  if (result.error) return { status: "error", message: result.error };
  return { status: "ok", commit: result.commit };
}

// Atomic three-key writer for the session-cleanup intervals. Lives as a
// command (not as `applyBulk`) because applyBulk runs each single-key
// validator against the PRE-bulk snapshot, which would reject a Reset that
// lowers both knobs simultaneously. The controller's command path re-runs
// validators against the merged snapshot, so the cross-field invariant is
// checked against the values being written together rather than mixed
// with the current state.
function setSessionCleanupTriple(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "sessionCleanup.setTriple: payload must be an object" };
  }
  const snapshot = (deps && deps.snapshot) || {};

  // Strict presence check: a present-but-wrong-type value is a programmer
  // error and must surface, not silently fall back to the snapshot.
  function pick(key) {
    if (key in payload) {
      const v = payload[key];
      if (!Number.isInteger(v)) {
        return { error: `${key} must be an integer (received ${typeof v})` };
      }
      return { value: v };
    }
    const fallback = Number(snapshot[key]);
    if (!Number.isFinite(fallback)) {
      return { error: `${key} missing from payload and not present in snapshot` };
    }
    return { value: fallback };
  }

  const s = pick("sessionStaleMs");
  if (s.error) return { status: "error", message: s.error };
  const w = pick("workingStaleMs");
  if (w.error) return { status: "error", message: w.error };
  const d = pick("detachedIdleStaleMs");
  if (d.error) return { status: "error", message: d.error };

  const sessionStaleMs = s.value;
  const workingStaleMs = w.value;
  const detachedIdleStaleMs = d.value;

  if (!(sessionStaleMs === 0 || (sessionStaleMs >= 60_000 && sessionStaleMs <= 86_400_000))) {
    return { status: "error", message: `sessionStaleMs out of range: ${sessionStaleMs}` };
  }
  if (!(workingStaleMs >= 30_000 && workingStaleMs <= 86_400_000)) {
    return { status: "error", message: `workingStaleMs out of range: ${workingStaleMs}` };
  }
  if (!(detachedIdleStaleMs >= 5_000 && detachedIdleStaleMs <= 300_000)) {
    return { status: "error", message: `detachedIdleStaleMs out of range: ${detachedIdleStaleMs}` };
  }

  if (sessionStaleMs > 0 && workingStaleMs > sessionStaleMs) {
    return {
      status: "error",
      message: `workingStaleMs (${workingStaleMs}) must be <= sessionStaleMs (${sessionStaleMs}).`,
    };
  }

  return {
    status: "ok",
    commit: { sessionStaleMs, workingStaleMs, detachedIdleStaleMs },
  };
}

function sessionAliasMapEqual(a, b) {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const av = a[key];
    const bv = b[key];
    if (!bv || av.title !== bv.title || av.updatedAt !== bv.updatedAt) return false;
  }
  return true;
}

function getCommandNow(deps) {
  const now = deps && typeof deps.now === "function" ? deps.now() : deps && deps.now;
  return Number.isFinite(Number(now)) && Number(now) > 0 ? Number(now) : Date.now();
}

function getActiveSessionAliasKeys(deps) {
  if (!deps || typeof deps.getActiveSessionAliasKeys !== "function") return new Set();
  try {
    const keys = deps.getActiveSessionAliasKeys();
    if (keys instanceof Set) return keys;
    if (Array.isArray(keys)) return new Set(keys);
    if (keys && typeof keys[Symbol.iterator] === "function") return new Set(keys);
  } catch {}
  return new Set();
}

function setSessionAlias(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setSessionAlias: payload must be an object" };
  }
  const { host, agentId, sessionId, rawSessionId, profileId, cwd, alias } = payload;
  // sessionId is the canonical action id for remote sessions. Alias storage
  // is keyed by the trusted profile scope plus the separately transported raw
  // id so the opaque action id never leaks into visible/legacy alias keys.
  const aliasSessionId = typeof rawSessionId === "string" && rawSessionId.trim()
    ? rawSessionId
    : sessionId;
  const key = sessionAliasKey(host, agentId, aliasSessionId, { cwd, profileId });
  if (!key) {
    return { status: "error", message: "setSessionAlias.sessionId must be a non-empty string" };
  }
  const cleanAlias = sanitizeSessionAlias(alias);
  if (cleanAlias === null) {
    return { status: "error", message: "setSessionAlias.alias must be a string" };
  }

  const now = getCommandNow(deps);
  const snapshot = (deps && deps.snapshot) || {};
  const currentAliases = normalizeSessionAliases(snapshot.sessionAliases || {}, { now });
  const nextAliases = { ...currentAliases };
  if (cleanAlias) {
    const existing = currentAliases[key];
    if (!existing || existing.title !== cleanAlias) {
      nextAliases[key] = { title: cleanAlias, updatedAt: now };
    }
  }
  else delete nextAliases[key];

  const prunedAliases = pruneExpiredSessionAliases(nextAliases, {
    now,
    activeKeys: getActiveSessionAliasKeys(deps),
  });

  if (sessionAliasMapEqual(prunedAliases, currentAliases)) {
    return { status: "ok", noop: true };
  }
  return { status: "ok", commit: { sessionAliases: prunedAliases } };
}

const _validateRemoveThemeId = requireString("removeTheme.themeId");
async function removeTheme(payload, deps) {
  const themeId = typeof payload === "string" ? payload : (payload && payload.themeId);
  const idCheck = _validateRemoveThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;

  if (!deps || typeof deps.getThemeInfo !== "function" || typeof deps.removeThemeDir !== "function") {
    return {
      status: "error",
      message: "removeTheme effect requires getThemeInfo and removeThemeDir deps",
    };
  }

  let info;
  try {
    info = deps.getThemeInfo(themeId);
  } catch (err) {
    return { status: "error", message: `removeTheme: ${err && err.message}` };
  }
  if (!info) {
    return { status: "error", message: `removeTheme: theme "${themeId}" not found` };
  }
  if (info.builtin) {
    return { status: "error", message: `removeTheme: cannot delete built-in theme "${themeId}"` };
  }
  if (info.active) {
    return {
      status: "error",
      message: `removeTheme: cannot delete active theme "${themeId}" — switch to another theme first`,
    };
  }
  if (info.managedCodexPet) {
    return {
      status: "error",
      message: `removeTheme: cannot delete managed Codex Pet theme "${themeId}" — remove it from Petdex instead`,
    };
  }

  try {
    await deps.removeThemeDir(themeId);
  } catch (err) {
    return { status: "error", message: `removeTheme: ${err && err.message}` };
  }

  const snapshot = deps.snapshot || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const currentVariantMap = snapshot.themeVariant || {};
  const currentIdleVisual = snapshot.idleVisual || {};
  const currentPetTint = snapshot.petTint || {};
  const currentPetAccessory = snapshot.petAccessory || {};
  const currentHolidayAccessoryEnabled = snapshot.holidayAccessoryEnabled || {};
  const nextCommit = {};
  if (currentOverrides[themeId]) {
    const nextOverrides = { ...currentOverrides };
    delete nextOverrides[themeId];
    nextCommit.themeOverrides = nextOverrides;
  }
  if (currentVariantMap[themeId] !== undefined) {
    const nextVariantMap = { ...currentVariantMap };
    delete nextVariantMap[themeId];
    nextCommit.themeVariant = nextVariantMap;
  }
  if (currentIdleVisual[themeId] !== undefined) {
    const nextIdleVisual = { ...currentIdleVisual };
    delete nextIdleVisual[themeId];
    nextCommit.idleVisual = nextIdleVisual;
  }
  if (currentPetTint[themeId] !== undefined) {
    const nextPetTint = { ...currentPetTint };
    delete nextPetTint[themeId];
    nextCommit.petTint = nextPetTint;
  }
  if (currentPetAccessory[themeId] !== undefined) {
    const nextPetAccessory = { ...currentPetAccessory };
    delete nextPetAccessory[themeId];
    nextCommit.petAccessory = nextPetAccessory;
  }
  if (currentHolidayAccessoryEnabled[themeId] !== undefined) {
    const nextHolidayAccessoryEnabled = { ...currentHolidayAccessoryEnabled };
    delete nextHolidayAccessoryEnabled[themeId];
    nextCommit.holidayAccessoryEnabled = nextHolidayAccessoryEnabled;
  }
  if (Object.keys(nextCommit).length > 0) {
    return { status: "ok", commit: nextCommit };
  }
  return { status: "ok" };
}

// Phase 3b-swap: atomic theme + variant switch.
//   payload: { themeId: string, variantId?: string }
// Why a dedicated command vs. letting the `theme` field effect handle it:
// the theme effect only commits `{theme}`, so the dirty "author deleted the
// variant user had selected" scenario leaves `themeVariant[themeId]` pointing
// at a dead variantId. Fix: call activateTheme which lenient-fallbacks unknown
// variants, read back the actually-resolved variantId, and commit both fields.
// See docs/plans/plan-settings-panel-3b-swap.md §6.2 "Runtime 切换路径".
const _validateSetThemeSelectionThemeId = requireString("setThemeSelection.themeId");
function setThemeSelection(payload, deps) {
  const themeId = typeof payload === "string" ? payload : (payload && payload.themeId);
  const variantIdInput = (payload && typeof payload === "object") ? payload.variantId : null;
  const idCheck = _validateSetThemeSelectionThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;
  if (variantIdInput != null && (typeof variantIdInput !== "string" || !variantIdInput)) {
    return { status: "error", message: "setThemeSelection.variantId must be a non-empty string when provided" };
  }

  if (!deps || typeof deps.activateTheme !== "function") {
    return { status: "error", message: "setThemeSelection effect requires activateTheme dep" };
  }

  const snapshot = deps.snapshot || {};
  const currentVariantMap = snapshot.themeVariant || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const targetVariant = variantIdInput || currentVariantMap[themeId] || "default";
  const targetOverrideMap = currentOverrides[themeId] || null;

  let resolved;
  try {
    resolved = deps.activateTheme(themeId, targetVariant, targetOverrideMap);
  } catch (err) {
    return { status: "error", message: `setThemeSelection: ${err && err.message}` };
  }
  // activateTheme returns { themeId, variantId } — the variantId here reflects
  // lenient fallback (dead variant → "default"). We commit the resolved value
  // so prefs self-heal away from stale ids.
  const resolvedVariant = (resolved && typeof resolved === "object" && typeof resolved.variantId === "string")
    ? resolved.variantId
    : targetVariant;
  const activeTheme = typeof deps.getActiveTheme === "function" ? deps.getActiveTheme() : null;
  const customizationCapabilities = (
    activeTheme
    && activeTheme._id === themeId
    && activeTheme._capabilities
    && typeof activeTheme._capabilities === "object"
    && !Array.isArray(activeTheme._capabilities)
  )
    ? {
        petTint: activeTheme._capabilities.petTint === true,
        accessories: activeTheme._capabilities.accessories === true,
      }
    : null;

  const nextVariantMap = { ...currentVariantMap, [themeId]: resolvedVariant };
  return {
    status: "ok",
    commit: { theme: themeId, themeVariant: nextVariantMap },
    customizationCapabilities,
  };
}

// #509: default idle visual picker.
//   payload: { themeId: string, file: string|null }  (null = back to theme default)
// Validates against the LOADED active theme (only it knows the real file list
// after variants/overrides), so only the active theme's entry can be written.
const _validateSetIdleVisualThemeId = requireString("setIdleVisual.themeId");
function setIdleVisual(payload, deps) {
  const themeId = payload && payload.themeId;
  const file = payload && typeof payload === "object" ? payload.file : undefined;
  const idCheck = _validateSetIdleVisualThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;
  if (file !== null && (typeof file !== "string" || !file)) {
    return { status: "error", message: "setIdleVisual.file must be a non-empty string or null" };
  }

  if (!deps || typeof deps.getActiveTheme !== "function") {
    return { status: "error", message: "setIdleVisual effect requires getActiveTheme dep" };
  }
  const activeTheme = deps.getActiveTheme();
  if (!activeTheme || activeTheme._id !== themeId) {
    return { status: "error", message: `setIdleVisual: theme "${themeId}" is not the active theme` };
  }

  let nextFile = file;
  if (nextFile !== null) {
    const match = listIdleVisualOptions(activeTheme).find((option) => option.file === nextFile);
    if (!match) {
      return { status: "error", message: `setIdleVisual: "${nextFile}" is not an idle visual of theme "${themeId}"` };
    }
    // Theme default is represented by the absence of an entry.
    if (match.isThemeDefault) nextFile = null;
  }

  const snapshot = (deps && deps.snapshot) || {};
  const currentMap = snapshot.idleVisual || {};
  const nextMap = { ...currentMap };
  if (nextFile === null) {
    if (nextMap[themeId] === undefined) return { status: "ok", noop: true };
    delete nextMap[themeId];
    return { status: "ok", commit: { idleVisual: nextMap } };
  }
  if (nextMap[themeId] === nextFile) return { status: "ok", noop: true };
  nextMap[themeId] = nextFile;
  return { status: "ok", commit: { idleVisual: nextMap } };
}

function resizePet(payload, deps) {
  // Settings panel slider entry point. Routes to menu.resizeWindow via
  // deps.resizePet so it picks up the full side-effect chain (actual window
  // resize, hitWin sync, bubble reposition, runtime flush) that a raw
  // applyUpdate("size", ...) would miss. menu.resizeWindow itself writes
  // prefs.size through the controller, so this command returns no commit.
  if (typeof payload !== "string" || !/^P:\d+(?:\.\d+)?$/.test(payload)) {
    return { status: "error", message: `resizePet: invalid size "${payload}"` };
  }
  if (!deps || typeof deps.resizePet !== "function") {
    return { status: "error", message: "resizePet requires deps.resizePet" };
  }
  try {
    deps.resizePet(payload);
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: `resizePet: ${err && err.message}` };
  }
}

// ── Remote SSH profile commands ──
//
// Three commands route through the controller so the IPC layer never writes
// prefs directly. Each returns `{ status, commit }` so the controller can
// atomically validate + write the new `remoteSsh` field.
//
// id semantics: `add` requires the caller to supply an id (the renderer
// generates a uuid). This keeps the renderer in charge of the id it'll later
// reference for connect/disconnect, avoiding a roundtrip race.

function _remoteSshSnapshot(deps) {
  const snap = (deps && deps.snapshot) || {};
  const cur = snap.remoteSsh && typeof snap.remoteSsh === "object" ? snap.remoteSsh : {};
  const profiles = Array.isArray(cur.profiles) ? cur.profiles.slice() : [];
  const out = { profiles };
  if (isValidInstallId(cur.installId)) out.installId = cur.installId;
  return out;
}

const REMOTE_SSH_TRUSTED_PROFILE_FIELDS = Object.freeze([
  "routingNonce",
  "previousNonce",
  "previousExpiresAt",
  "identityTxn",
  "runtimeModeTxn",
  "isolatedActive",
  "runtimeKeyConflict",
  "isolatedRuntime",
]);
const REMOTE_SSH_DEPLOYMENT_METADATA_FIELDS = Object.freeze([
  "lastDeployedAt",
  "managedDeployTargets",
  "detectedRemoteNodeBin",
  "detectedRemoteNodeVersion",
  "detectedRemoteNodeSource",
  "detectedRemoteNodeAt",
  "remoteHome",
]);

function stripTrustedRemoteProfileFields(profile) {
  for (const field of [...REMOTE_SSH_TRUSTED_PROFILE_FIELDS, ...REMOTE_SSH_DEPLOYMENT_METADATA_FIELDS]) {
    delete profile[field];
  }
}

function preserveTrustedRemoteProfileFields(target, source) {
  for (const field of REMOTE_SSH_TRUSTED_PROFILE_FIELDS) {
    if (source && source[field] !== undefined) target[field] = source[field];
  }
}

function normalizeRemoteNodeDetection(input, detectedAtFallback = Date.now()) {
  if (!input || typeof input !== "object") return null;
  const nodeBin = input.nodeBin || input.detectedRemoteNodeBin;
  if (!isValidDetectedRemoteNodeBin(nodeBin)) return null;

  const out = {
    detectedRemoteNodeBin: nodeBin,
  };
  const version = input.version || input.detectedRemoteNodeVersion;
  if (isValidDetectedRemoteNodeVersion(version)) {
    out.detectedRemoteNodeVersion = version;
  }
  const source = input.source || input.detectedRemoteNodeSource;
  if (isValidDetectedRemoteNodeSource(source)) {
    out.detectedRemoteNodeSource = source;
  }
  const detectedAt = Number.isFinite(input.detectedAt)
    ? input.detectedAt
    : (Number.isFinite(input.detectedRemoteNodeAt) ? input.detectedRemoteNodeAt : detectedAtFallback);
  if (Number.isFinite(detectedAt) && detectedAt > 0) {
    out.detectedRemoteNodeAt = detectedAt;
  }
  return out;
}

function copyRemoteNodeDetection(target, source) {
  if (!target || !source || !isValidDetectedRemoteNodeBin(source.detectedRemoteNodeBin)) return;
  target.detectedRemoteNodeBin = source.detectedRemoteNodeBin;
  if (isValidDetectedRemoteNodeVersion(source.detectedRemoteNodeVersion)) {
    target.detectedRemoteNodeVersion = source.detectedRemoteNodeVersion;
  }
  if (isValidDetectedRemoteNodeSource(source.detectedRemoteNodeSource)) {
    target.detectedRemoteNodeSource = source.detectedRemoteNodeSource;
  }
  if (Number.isFinite(source.detectedRemoteNodeAt) && source.detectedRemoteNodeAt > 0) {
    target.detectedRemoteNodeAt = source.detectedRemoteNodeAt;
  }
}

function remoteSshAddProfile(payload, deps) {
  const profile = sanitizeRemoteSshProfile(payload);
  if (!profile) {
    const detail = validateRemoteSshProfile(payload || {});
    return {
      status: "error",
      message: detail.status === "error" ? detail.message : "remoteSsh.add: invalid profile",
    };
  }
  const next = _remoteSshSnapshot(deps);
  if (next.profiles.some((p) => p.id === profile.id)) {
    return { status: "error", message: `remoteSsh.add: profile id "${profile.id}" already exists` };
  }
  // Ownership metadata is server-issued only after a successful deploy.
  // Renderer input must never be able to manufacture cleanup authority.
  stripTrustedRemoteProfileFields(profile);
  next.profiles.push(profile);
  return { status: "ok", commit: { remoteSsh: next } };
}

function remoteSshUpdateProfile(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "remoteSsh.update: payload must be an object" };
  }
  const profile = sanitizeRemoteSshProfile(payload);
  if (!profile) {
    const detail = validateRemoteSshProfile(payload || {});
    return {
      status: "error",
      message: detail.status === "error" ? detail.message : "remoteSsh.update: invalid profile",
    };
  }
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((p) => p.id === profile.id);
  if (idx === -1) {
    return { status: "error", message: `remoteSsh.update: profile id "${profile.id}" not found` };
  }
  // Preserve original createdAt if caller didn't supply one new.
  const prev = next.profiles[idx];
  if (prev.runtimeModeTxn) {
    return {
      status: "error",
      message: "remoteSsh.update: finish the runtime mode transaction before editing this profile",
    };
  }
  if (Number.isFinite(prev.createdAt) && !Number.isFinite(payload.createdAt)) {
    profile.createdAt = prev.createdAt;
  }
  // Runtime identity is server-owned. A normal profile edit must not switch
  // layouts merely because the renderer omits these hidden fields, and a
  // forged settings command must not bypass the dedicated, confirmation-gated
  // runtime-mode transaction.
  profile.runtimeMode = prev.runtimeMode || REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT;
  profile.runtimeKey = profile.runtimeMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED
    ? prev.runtimeKey
    : ACCOUNT_DEFAULT_RUNTIME_KEY;
  profile.layoutVersion = Number.isInteger(prev.layoutVersion)
    ? prev.layoutVersion
    : REMOTE_LAYOUT_VERSION;
  // Preserve lastDeployedAt across cosmetic edits (label, autoStartCodexMonitor,
  // connectOnLaunch). Only clear it when deploy target fields drifted — those
  // changes mean the previous deploy is no longer valid for the new target,
  // so the UI should re-warn "never deployed" until user runs Deploy again.
  // Use deployTargetFingerprint to normalize port-22-vs-undefined and empty
  // optional strings before comparing — naive prev[f] === profile[f] would
  // false-flag "port drift" when prev had port:22 and the UI saveBtn omitted
  // the default 22 from the payload.
  const drift = deployTargetDrift(deployTargetFingerprint(prev), deployTargetFingerprint(profile));
  const transportModeChanged = (prev.sshTransportMode || "auto")
    !== (profile.sshTransportMode || "auto");
  if ((drift || transportModeChanged)
    && typeof deps.isRemoteSshTransportBusy === "function"
    && deps.isRemoteSshTransportBusy(profile.id)) {
    return {
      status: "error",
      reason: "serialized_transport_busy",
      message: "Disconnect this Remote SSH profile before editing its transport target or mode",
    };
  }
  // Deployment stamps and cleanup ownership are server-issued metadata.
  // Ignore anything supplied by the renderer, then restore only the trusted
  // values already present in the current settings snapshot.
  stripTrustedRemoteProfileFields(profile);
  preserveTrustedRemoteProfileFields(profile, prev);
  // Ownership history is independent of whether the current form still
  // points at the deployed target. Preserve it across A → B edits so delete
  // later cleans the actual managed account(s), never the current guess.
  const managedDeployTargets = normalizeManagedDeployTargets(prev.managedDeployTargets);
  if (managedDeployTargets.length) profile.managedDeployTargets = managedDeployTargets;
  if (drift === null) {
    if (Number.isFinite(prev.lastDeployedAt)) {
      profile.lastDeployedAt = prev.lastDeployedAt;
    }
    if (profile.detectedRemoteNodeBin === undefined) {
      copyRemoteNodeDetection(profile, prev);
    }
    if (typeof prev.remoteHome === "string") profile.remoteHome = prev.remoteHome;
  }
  next.profiles[idx] = profile;
  return { status: "ok", commit: { remoteSsh: next } };
}

function remoteSshApplyInstallationIdentity(payload, deps) {
  const installId = payload && payload.installId;
  if (!isValidInstallId(installId)) {
    return { status: "error", message: "remoteSsh.applyInstallationIdentity.installId is invalid" };
  }
  const current = _remoteSshSnapshot(deps);
  if (payload.cloneRecoveryRequired === true) {
    return {
      status: "ok",
      commit: { remoteSsh: cloneRecoverRemoteSsh(current, installId) },
      cloneRecovered: true,
    };
  }
  return {
    status: "ok",
    commit: { remoteSsh: { ...current, installId } },
  };
}

function remoteSshBeginIdentityRotation(payload, deps) {
  const id = payload && payload.id;
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((profile) => profile.id === id);
  if (idx === -1) return { status: "error", message: "remoteSsh.beginIdentityRotation: profile not found" };
  const current = next.profiles[idx];
  if (current.identityTxn && current.identityTxn.phase !== "committed") {
    return { status: "ok", noop: true, identityTxn: current.identityTxn };
  }
  // Randomness and time sources are main-process authority. Never accept
  // renderer-supplied options here, even though the IPC boundary also blocks
  // this internal command.
  const txn = createIdentityTxn(current);
  next.profiles[idx] = { ...current, identityTxn: txn };
  return { status: "ok", commit: { remoteSsh: next }, identityTxn: txn };
}

function remoteSshUpdateIdentityStep(payload, deps) {
  const { id, step, value } = payload || {};
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((profile) => profile.id === id);
  if (idx === -1) return { status: "error", message: "remoteSsh.updateIdentityStep: profile not found" };
  const current = next.profiles[idx];
  if (!current.identityTxn) return { status: "error", message: "remoteSsh.updateIdentityStep: no active transaction" };
  const txn = updateIdentityTxnStep(current.identityTxn, step, value, current);
  next.profiles[idx] = { ...current, identityTxn: txn };
  return { status: "ok", commit: { remoteSsh: next }, identityTxn: txn };
}

function remoteSshCommitIdentityRotation(payload, deps) {
  const id = payload && payload.id;
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((profile) => profile.id === id);
  if (idx === -1) return { status: "error", message: "remoteSsh.commitIdentityRotation: profile not found" };
  const current = next.profiles[idx];
  if (!current.identityTxn) return { status: "error", message: "remoteSsh.commitIdentityRotation: no active transaction" };
  const committed = commitIdentityTxn(current, current.identityTxn);
  next.profiles[idx] = committed;
  return { status: "ok", commit: { remoteSsh: next }, routingNonce: committed.routingNonce };
}

function remoteSshForceRevoke(payload, deps) {
  const id = payload && payload.id;
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((profile) => profile.id === id);
  if (idx === -1) return { status: "error", message: "remoteSsh.forceRevoke: profile not found" };
  const current = next.profiles[idx];
  if (!payload || payload.confirmed !== true) {
    return { status: "error", message: "remoteSsh.forceRevoke requires confirmed:true" };
  }
  const mode = payload.mode || "old";
  if (mode !== "old" && mode !== "all") {
    return { status: "error", message: "remoteSsh.forceRevoke.mode must be old or all" };
  }
  const updated = mode === "old"
    ? forceRevokeOldIdentity(current)
    : abortIdentityTxnToEmergencyNonce(current);
  next.profiles[idx] = updated;
  return {
    status: "ok",
    commit: { remoteSsh: next },
    identityTxn: updated.identityTxn || null,
  };
}

function remoteSshBeginRuntimeModeSwitch(payload, deps) {
  const { id, runtimeMode } = payload || {};
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((profile) => profile.id === id);
  if (idx === -1) return { status: "error", message: "remoteSsh.beginRuntimeModeSwitch: profile not found" };
  if (runtimeMode !== REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT
    && runtimeMode !== REMOTE_RUNTIME_MODE_PROFILE_ISOLATED) {
    return { status: "error", message: "remoteSsh.beginRuntimeModeSwitch.runtimeMode is invalid" };
  }
  const current = next.profiles[idx];
  if (current.identityTxn && current.identityTxn.phase !== "committed") {
    return {
      status: "error",
      message: "remoteSsh.beginRuntimeModeSwitch: identity transaction is active",
    };
  }
  if (current.runtimeModeTxn) {
    if (current.runtimeModeTxn.toMode === runtimeMode) {
      return { status: "ok", noop: true, runtimeModeTxn: current.runtimeModeTxn };
    }
    return {
      status: "error",
      message: "remoteSsh.beginRuntimeModeSwitch: another target mode is already pending",
    };
  }
  const currentMode = current.runtimeMode || REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT;
  const currentKey = current.runtimeKey || ACCOUNT_DEFAULT_RUNTIME_KEY;
  if (currentMode === runtimeMode) {
    return { status: "ok", noop: true };
  }
  const runtimeKey = runtimeMode === REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT
    ? ACCOUNT_DEFAULT_RUNTIME_KEY
    : payload.runtimeKey;
  const txn = sanitizeRuntimeModeTxn({
    fromMode: currentMode,
    fromKey: currentKey,
    toMode: runtimeMode,
    toKey: runtimeKey,
    layoutVersion: REMOTE_LAYOUT_VERSION,
    phase: "prepared",
    startedAt: Date.now(),
  });
  if (!txn) {
    return { status: "error", message: "remoteSsh.beginRuntimeModeSwitch target is invalid" };
  }
  if (txn.toMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED
    && next.profiles.some((profile, profileIndex) =>
      profileIndex !== idx
      && profile.runtimeMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED
      && profile.runtimeKey === txn.toKey)) {
    return {
      status: "error",
      message: "remoteSsh.beginRuntimeModeSwitch runtime key is already owned by another profile",
    };
  }
  next.profiles[idx] = { ...current, runtimeModeTxn: txn };
  return { status: "ok", commit: { remoteSsh: next }, runtimeModeTxn: txn };
}

function remoteSshAdvanceRuntimeModeSwitch(payload, deps) {
  const { id, phase } = payload || {};
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((profile) => profile.id === id);
  if (idx === -1) return { status: "error", message: "remoteSsh.advanceRuntimeModeSwitch: profile not found" };
  const current = next.profiles[idx];
  const txn = sanitizeRuntimeModeTxn(current.runtimeModeTxn);
  if (!txn) {
    return { status: "error", message: "remoteSsh.advanceRuntimeModeSwitch: no valid transaction" };
  }
  const allowed = (txn.phase === "prepared" && phase === "cleanup-done")
    || (txn.phase === "cleanup-done"
      && txn.toMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED
      && phase === "bootstrap-done");
  if (!allowed) {
    if (txn.phase === phase) return { status: "ok", noop: true, runtimeModeTxn: txn };
    return {
      status: "error",
      message: `remoteSsh.advanceRuntimeModeSwitch cannot advance ${txn.phase} to ${String(phase)}`,
    };
  }
  const advanced = { ...txn, phase };
  next.profiles[idx] = { ...current, runtimeModeTxn: advanced };
  return { status: "ok", commit: { remoteSsh: next }, runtimeModeTxn: advanced };
}

function remoteSshSwitchRuntimeMode(payload, deps) {
  const { id } = payload || {};
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((profile) => profile.id === id);
  if (idx === -1) return { status: "error", message: "remoteSsh.switchRuntimeMode: profile not found" };
  const current = next.profiles[idx];
  const txn = sanitizeRuntimeModeTxn(current.runtimeModeTxn);
  if (!txn) return { status: "error", message: "remoteSsh.switchRuntimeMode: no valid transaction" };
  const ready = txn.toMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED
    ? txn.phase === "bootstrap-done"
    : txn.phase === "cleanup-done";
  if (!ready) {
    return {
      status: "error",
      message: `remoteSsh.switchRuntimeMode: transaction phase ${txn.phase} is not ready`,
    };
  }
  const rawCandidate = {
    ...current,
    runtimeMode: txn.toMode,
    runtimeKey: txn.toKey,
    layoutVersion: REMOTE_LAYOUT_VERSION,
    isolatedActive: false,
    runtimeKeyConflict: false,
    managedDeployTargets: [],
  };
  for (const field of [
    "routingNonce",
    "previousNonce",
    "previousExpiresAt",
    "identityTxn",
    "runtimeModeTxn",
    "lastDeployedAt",
    "remoteHome",
    "isolatedRuntime",
  ]) {
    delete rawCandidate[field];
  }
  const candidate = sanitizeRemoteSshProfile(rawCandidate);
  if (!candidate) return { status: "error", message: "remoteSsh.switchRuntimeMode target is invalid" };
  if (candidate.runtimeMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED
    && next.profiles.some((profile, profileIndex) =>
      profileIndex !== idx
      && profile.runtimeMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED
      && profile.runtimeKey === candidate.runtimeKey)) {
    return {
      status: "error",
      message: "remoteSsh.switchRuntimeMode runtime key is already owned by another profile",
    };
  }
  next.profiles[idx] = candidate;
  return { status: "ok", commit: { remoteSsh: next }, profile: candidate };
}

// Stamp deploy completion onto a profile WITHOUT touching any other field.
// Use this from the deploy IPC handler instead of remoteSsh.update with a
// pre-deploy profile snapshot — deploy can take 30+ seconds, during which
// the user may have edited the profile. Re-writing the whole profile from
// the snapshot would clobber those edits (lost-update race).
//
// expectedTarget is an optional fingerprint of {host, port, identityFile,
// remoteForwardPort, hostPrefix} captured by the caller at deploy start.
// If the current profile's target fields drifted away from that fingerprint,
// the deploy ran against an old target — we no-op rather than falsely claim
// the new (drifted) configuration is "deployed". Caller learns from the
// noop+targetDrift response and can prompt the user to redeploy.
function remoteSshMarkDeployed(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "remoteSsh.markDeployed: payload must be an object" };
  }
  const { id, deployedAt, expectedTarget } = payload;
  if (typeof id !== "string" || !id) {
    return { status: "error", message: "remoteSsh.markDeployed.id must be a non-empty string" };
  }
  if (!Number.isFinite(deployedAt) || deployedAt <= 0) {
    return { status: "error", message: "remoteSsh.markDeployed.deployedAt must be a positive finite number" };
  }
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((p) => p.id === id);
  if (idx === -1) {
    // Profile was deleted mid-deploy — silently skip rather than error.
    return { status: "ok", noop: true, reason: "profile_deleted" };
  }
  const current = next.profiles[idx];
  const remoteNode = normalizeRemoteNodeDetection(payload.remoteNode || payload, deployedAt);
  const targetAtDeployStart = expectedTarget && typeof expectedTarget === "object"
    ? expectedTarget
    : current;
  const ownedTarget = sanitizeManagedDeployTarget({
    ...deployTargetFingerprint(targetAtDeployStart),
    ...(payload.sshTransportHint ? { sshTransportHint: payload.sshTransportHint } : {}),
    ...(remoteNode || {}),
    ...(isValidInstallId(payload.installId) && typeof payload.remoteHome === "string"
      ? {
          profileId: id,
          installId: payload.installId,
          remoteHome: payload.remoteHome,
        }
      : {}),
    deployedAt,
  });
  if (!ownedTarget) {
    return { status: "error", message: "remoteSsh.markDeployed: invalid deployment ownership target" };
  }
  const ownedTargets = normalizeManagedDeployTargets([
    ...(current.managedDeployTargets || []).filter(
      (target) => remoteAccountKey(target) !== remoteAccountKey(ownedTarget)
    ),
    ownedTarget,
  ]);
  if (expectedTarget && typeof expectedTarget === "object") {
    // Normalize both sides through deployTargetFingerprint so port-22 vs
    // undefined / empty-string vs missing don't false-flag drift. This also
    // means the IPC caller's expectedTarget can be a raw profile-shaped
    // object — fingerprint normalizes it the same way.
    const drift = deployTargetDrift(
      deployTargetFingerprint(current),
      deployTargetFingerprint(expectedTarget)
    );
    if (drift) {
      const updatedProfile = { ...current, managedDeployTargets: ownedTargets };
      const newProfiles = next.profiles.slice();
      newProfiles[idx] = updatedProfile;
      return {
        status: "ok",
        commit: { remoteSsh: { ...next, profiles: newProfiles } },
        noop: true,
        reason: "target_drift",
        targetDrift: drift,
        message: `remoteSsh.markDeployed: profile ${id}.${drift} changed during deploy; ownership recorded without stamping current target`,
      };
    }
  }
  // Only mutate deployment metadata — every other field stays as-is so
  // concurrent user edits (label / autoStartCodexMonitor / connectOnLaunch)
  // survive.
  const updatedProfile = {
    ...current,
    lastDeployedAt: deployedAt,
    managedDeployTargets: ownedTargets,
  };
  if (remoteNode) copyRemoteNodeDetection(updatedProfile, remoteNode);
  if (typeof payload.remoteHome === "string") updatedProfile.remoteHome = payload.remoteHome;
  if (payload.isolation && current.runtimeMode === "profile-isolated") {
    const isolatedRuntime = sanitizeIsolatedRuntime({
      ...payload.isolation,
      verifiedAt: deployedAt,
    });
    if (!isolatedRuntime) {
      return { status: "error", message: "remoteSsh.markDeployed: invalid isolated runtime evidence" };
    }
    updatedProfile.isolatedRuntime = isolatedRuntime;
    const normalizedProfile = sanitizeRemoteSshProfile(updatedProfile);
    if (!normalizedProfile) {
      return { status: "error", message: "remoteSsh.markDeployed: isolation evidence does not match the profile layout" };
    }
    updatedProfile.isolatedActive = normalizedProfile.isolatedActive === true;
  } else if (current.runtimeMode !== "profile-isolated") {
    delete updatedProfile.isolatedRuntime;
    updatedProfile.isolatedActive = false;
  }
  const newProfiles = next.profiles.slice();
  newProfiles[idx] = updatedProfile;
  return {
    status: "ok",
    commit: { remoteSsh: { ...next, profiles: newProfiles } },
  };
}

function remoteSshMarkRemoteNode(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "remoteSsh.markRemoteNode: payload must be an object" };
  }
  const { id, expectedTarget } = payload;
  if (typeof id !== "string" || !id) {
    return { status: "error", message: "remoteSsh.markRemoteNode.id must be a non-empty string" };
  }
  const remoteNode = normalizeRemoteNodeDetection(payload);
  if (!remoteNode) {
    return { status: "error", message: "remoteSsh.markRemoteNode.nodeBin must be an absolute POSIX path" };
  }
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((p) => p.id === id);
  if (idx === -1) {
    return { status: "ok", noop: true, reason: "profile_deleted" };
  }
  const current = next.profiles[idx];
  if (expectedTarget && typeof expectedTarget === "object") {
    const drift = deployTargetDrift(
      deployTargetFingerprint(current),
      deployTargetFingerprint(expectedTarget)
    );
    if (drift) {
      return {
        status: "ok",
        noop: true,
        reason: "target_drift",
        targetDrift: drift,
        message: `remoteSsh.markRemoteNode: profile ${id}.${drift} changed during detection; not stamping`,
      };
    }
  }
  const updatedProfile = { ...current };
  copyRemoteNodeDetection(updatedProfile, remoteNode);
  const newProfiles = next.profiles.slice();
  newProfiles[idx] = updatedProfile;
  return {
    status: "ok",
    commit: { remoteSsh: { ...next, profiles: newProfiles } },
  };
}

function remoteSshDeleteProfile(payload, deps) {
  const id = typeof payload === "string"
    ? payload
    : (payload && typeof payload === "object" ? payload.id : null);
  if (typeof id !== "string" || !id) {
    return { status: "error", message: "remoteSsh.delete: id must be a non-empty string" };
  }
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((p) => p.id === id);
  if (idx === -1) {
    // No-op rather than error — UI may have raced with a re-render.
    return { status: "ok", noop: true };
  }
  if (next.profiles[idx].runtimeModeTxn) {
    return {
      status: "error",
      message: "remoteSsh.delete: finish the runtime mode transaction before deleting this profile",
    };
  }
  if (next.profiles[idx].identityTxn
    && next.profiles[idx].identityTxn.phase !== "committed") {
    return {
      status: "error",
      message: "remoteSsh.delete: finish or force-revoke the identity transaction before deleting this profile",
    };
  }
  next.profiles.splice(idx, 1);
  return { status: "ok", commit: { remoteSsh: next } };
}

async function telegramApprovalSetToken(payload, deps = {}) {
  const token = typeof payload === "string"
    ? payload
    : (payload && typeof payload === "object" ? payload.token : "");
  const valid = validateTelegramBotToken(token);
  if (valid.status !== "ok") return valid;
  if (!deps || typeof deps.writeTelegramApprovalToken !== "function") {
    return { status: "error", message: "telegramApproval.setToken requires writeTelegramApprovalToken dep" };
  }
  const result = await deps.writeTelegramApprovalToken(valid.token);
  if (!result || result.status !== "ok") {
    return result || { status: "error", message: "Telegram bot token write failed" };
  }
  return { status: "ok", tokenStored: true };
}

function telegramApprovalStatus(_payload, deps = {}) {
  if (!deps || typeof deps.getTelegramApprovalStatus !== "function") {
    return { status: "error", message: "telegramApproval.status requires getTelegramApprovalStatus dep" };
  }
  const status = deps.getTelegramApprovalStatus();
  return { status: "ok", state: status || { status: "stopped" } };
}

function telegramApprovalTokenInfo(_payload, deps = {}) {
  if (!deps || typeof deps.getTelegramApprovalTokenInfo !== "function") {
    return { status: "error", message: "telegramApproval.tokenInfo requires getTelegramApprovalTokenInfo dep" };
  }
  const info = deps.getTelegramApprovalTokenInfo() || { configured: false, masked: "" };
  return {
    status: "ok",
    configured: info.configured === true,
    masked: typeof info.masked === "string" ? info.masked : "",
  };
}

// Telegram approval transport migration controller.
// All telegramMigration.* commands lock on the same `tgApproval` domain as the
// approval commands so they can't race against token writes.
function telegramMigrationSnapshot(_payload, deps = {}) {
  if (!deps || !deps.telegramMigration) {
    return { status: "error", message: "telegramMigration.snapshot requires controller dep" };
  }
  return { status: "ok", snapshot: deps.telegramMigration.getSnapshot() };
}

async function telegramMigrationDispatch(payload, deps = {}) {
  if (!deps || !deps.telegramMigration) {
    return { status: "error", message: "telegramMigration.dispatch requires controller dep" };
  }
  if (!payload || typeof payload.type !== "string") {
    return { status: "error", message: "telegramMigration.dispatch requires event.type" };
  }
  if (!TELEGRAM_MIGRATION_RENDERER_EVENTS.has(payload.type)) {
    return {
      status: "error",
      errorCode: "EVENT_NOT_ALLOWED",
      message: `telegramMigration.dispatch event ${payload.type} is not renderer-callable`,
      snapshot: deps.telegramMigration.getSnapshot(),
    };
  }
  const res = await deps.telegramMigration.dispatch({ type: payload.type });
  return res && res.ok
    ? { status: "ok", state: res.state, snapshot: deps.telegramMigration.getSnapshot() }
    : {
        status: "error",
        errorCode: res ? res.errorCode : "UNKNOWN",
        message: res && res.message,
        snapshot: deps.telegramMigration.getSnapshot(),
      };
}

telegramMigrationDispatch.lockKey = "tgApproval";

async function telegramApprovalSendTest(_payload, deps = {}) {
  if (!deps || typeof deps.sendTelegramApprovalTest !== "function") {
    return { status: "error", message: "telegramApproval.test requires sendTelegramApprovalTest dep" };
  }
  const result = await deps.sendTelegramApprovalTest();
  return result || { status: "error", message: "Telegram approval test returned no result" };
}

async function feishuApprovalSetSecrets(payload, deps = {}) {
  if (!deps || typeof deps.writeFeishuApprovalSecrets !== "function") {
    return { status: "error", message: "feishuApproval.setSecrets requires writeFeishuApprovalSecrets dep" };
  }
  if (typeof deps.getFeishuApprovalSecrets !== "function") {
    return { status: "error", message: "feishuApproval.setSecrets requires getFeishuApprovalSecrets dep" };
  }
  const config = normalizeFeishuApproval(deps.snapshot && deps.snapshot.feishuApproval);
  let current;
  try {
    current = deps.getFeishuApprovalSecrets();
  } catch {
    return { status: "error", code: "credentials-read-failed" };
  }
  if (current && typeof current.then === "function") {
    return { status: "error", code: "credentials-read-failed" };
  }
  const planned = planFeishuCredentialWrite(current, config.platform, payload);
  if (!planned.ok) return { status: "error", code: planned.code };
  // Pass the writer's result through untouched: it carries the `code` the
  // settings page localizes and the English detail naming the real cause.
  const result = await deps.writeFeishuApprovalSecrets(planned.nextBundle);
  if (!result || result.status !== "ok") {
    return result || { status: "error", code: "write-failed", message: "Secrets write returned no result" };
  }
  return { status: "ok", secretsStored: true };
}

function feishuApprovalSaveManualApprover(payload, deps = {}) {
  const input = payload && typeof payload === "object" ? payload : {};
  const idType = typeof input.idType === "string" ? input.idType.trim() : "";
  const approverId = typeof input.approverId === "string" ? input.approverId.trim() : "";
  const recipient = classifyFeishuApprovalRecipient(approverId, idType);
  if (recipient.kind === "email") {
    return { status: "error", code: "email-requires-lookup" };
  }
  if (recipient.kind === "invalid") {
    return { status: "error", code: recipient.code };
  }
  if (!new Set(["open_id", "user_id", "union_id"]).has(idType)) {
    return { status: "error", code: "invalid-id-type" };
  }
  if (recipient.kind !== "manual" || !recipient.approverId || recipient.approverId.length > 128) {
    return { status: "error", code: "missing-approver" };
  }
  if (typeof deps.getFeishuApprovalSecrets !== "function") {
    return { status: "error", code: "missing-credentials" };
  }
  const config = normalizeFeishuApproval(deps.snapshot && deps.snapshot.feishuApproval);
  let secrets;
  try {
    secrets = deps.getFeishuApprovalSecrets();
  } catch {
    return { status: "error", code: "credentials-read-failed" };
  }
  const saved = evaluateFeishuApprovalConfiguration(config, secrets, {
    requireEnabled: false,
    requireApprover: false,
  });
  if (!saved.ok) return { status: "error", code: saved.code };
  return {
    status: "ok",
    commit: {
      feishuApproval: {
        ...saved.config,
        idType: recipient.idType,
        approverId: recipient.approverId,
        approverSource: "manual",
        approverBoundPlatform: saved.identity.platform,
        approverBoundAppId: saved.identity.appId,
      },
    },
  };
}

function feishuApprovalUpdateConfig(payload, deps = {}) {
  const patch = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : null;
  const allowed = new Set(["enabled", "platform", "connectionTimeoutSeconds"]);
  if (!patch || Object.keys(patch).length === 0) {
    return { status: "error", code: "invalid-config-patch" };
  }
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) return { status: "error", code: "invalid-config-patch" };
  }

  const current = normalizeFeishuApproval(deps.snapshot && deps.snapshot.feishuApproval);
  const next = { ...current, ...patch };
  const validated = validateFeishuApproval(next);
  if (!validated || validated.status !== "ok") {
    return { status: "error", code: "invalid-config-patch" };
  }
  return {
    status: "ok",
    commit: { feishuApproval: next },
  };
}

function isFeishuLookupSignal(signal) {
  return !!signal
    && typeof signal === "object"
    && typeof signal.aborted === "boolean"
    && typeof signal.addEventListener === "function";
}

function feishuLookupResult(result) {
  if (result && result.status === "ok") return { status: "ok" };
  return result && typeof result.code === "string"
    ? { status: "error", code: result.code }
    : { status: "error" };
}

async function saveFeishuApproverByEmail(payload, deps = {}) {
  const input = payload && typeof payload === "object" ? payload : {};
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (classifyFeishuApprovalRecipient(email, "open_id").kind !== "email") {
    return { status: "error", code: "invalid-email" };
  }
  if (!isFeishuLookupSignal(input.signal)) {
    return { status: "error", code: "lookup-failed" };
  }

  let rawConfig;
  let secrets;
  let secretsRevision;
  try {
    rawConfig = typeof deps.getFeishuApprovalPrefs === "function"
      ? deps.getFeishuApprovalPrefs()
      : deps.snapshot && deps.snapshot.feishuApproval;
    secrets = typeof deps.getFeishuApprovalSecrets === "function"
      ? deps.getFeishuApprovalSecrets()
      : null;
    secretsRevision = typeof deps.getFeishuApprovalSecretsRevision === "function"
      ? deps.getFeishuApprovalSecretsRevision()
      : 0;
  } catch {
    return { status: "error", code: "lookup-failed" };
  }
  if (
    rawConfig && typeof rawConfig.then === "function"
    || secrets && typeof secrets.then === "function"
    || secretsRevision && typeof secretsRevision.then === "function"
  ) {
    return { status: "error", code: "lookup-failed" };
  }
  const config = normalizeFeishuApproval(rawConfig);
  const saved = evaluateFeishuApprovalConfiguration(config, secrets, {
    requireEnabled: false,
    requireApprover: false,
  });
  if (!saved.ok) return { status: "error", code: saved.code };
  if (input.signal.aborted) return { status: "error", code: "lookup-cancelled" };
  if (
    typeof deps.lookupFeishuApproverByEmail !== "function"
    || typeof deps.commitResolvedApprover !== "function"
  ) {
    return { status: "error", code: "lookup-failed" };
  }
  let result;
  try {
    result = await deps.lookupFeishuApproverByEmail({
      platform: saved.identity.platform,
      appId: saved.identity.appId,
      appSecret: secrets.appSecret,
      email,
      signal: input.signal,
    });
  } catch {
    return { status: "error", code: "lookup-failed" };
  }
  if (input.signal.aborted) return { status: "error", code: "lookup-cancelled" };
  if (!result || result.status !== "ok") {
    const allowedCodes = new Set(["missing-contact-scope", "approver-not-found", "lookup-failed"]);
    return {
      status: "error",
      code: allowedCodes.has(result && result.code) ? result.code : "lookup-failed",
    };
  }
  const approverId = typeof result.approverId === "string" ? result.approverId.trim() : "";
  if (!approverId) return { status: "error", code: "lookup-failed" };
  let committed;
  try {
    committed = await deps.commitResolvedApprover({
      signal: input.signal,
      approverId,
      platform: saved.identity.platform,
      appId: saved.identity.appId,
      secretsRevision,
    });
  } catch {
    return { status: "error", code: "lookup-failed" };
  }
  return feishuLookupResult(committed);
}

function feishuApprovalCommitResolvedApprover(payload, deps = {}) {
  const input = payload && typeof payload === "object" ? payload : {};
  const signal = input.signal;
  const approverId = typeof input.approverId === "string" ? input.approverId.trim() : "";
  const platform = typeof input.platform === "string" ? input.platform : "";
  const appId = typeof input.appId === "string" ? input.appId : "";
  if (!isFeishuLookupSignal(signal) || !approverId || approverId.length > 128) {
    return { status: "error", code: "lookup-failed" };
  }
  if (signal.aborted) return { status: "error", code: "lookup-cancelled" };
  const config = normalizeFeishuApproval(deps.snapshot && deps.snapshot.feishuApproval);
  let secrets;
  let secretsRevision;
  try {
    secrets = typeof deps.getFeishuApprovalSecrets === "function"
      ? deps.getFeishuApprovalSecrets()
      : null;
    secretsRevision = typeof deps.getFeishuApprovalSecretsRevision === "function"
      ? deps.getFeishuApprovalSecretsRevision()
      : 0;
  } catch {
    return { status: "error", code: "credentials-read-failed" };
  }
  if (
    secrets && typeof secrets.then === "function"
    || secretsRevision && typeof secretsRevision.then === "function"
  ) {
    return { status: "error", code: "credentials-read-failed" };
  }
  const saved = evaluateFeishuApprovalConfiguration(config, secrets, {
    requireEnabled: false,
    requireApprover: false,
  });
  if (!saved.ok) return { status: "error", code: saved.code };
  if (
    saved.identity.platform !== platform
    || saved.identity.appId !== appId
    || secretsRevision !== input.secretsRevision
  ) {
    return { status: "error", code: "lookup-credentials-changed" };
  }
  if (signal.aborted) return { status: "error", code: "lookup-cancelled" };
  return {
    status: "ok",
    commit: {
      feishuApproval: {
        ...saved.config,
        idType: "open_id",
        approverId,
        approverSource: "lookup",
        approverBoundPlatform: saved.identity.platform,
        approverBoundAppId: saved.identity.appId,
      },
    },
  };
}

function feishuApprovalStatus(_payload, deps = {}) {
  if (!deps || typeof deps.getFeishuApprovalStatus !== "function") {
    return { status: "error", message: "feishuApproval.status requires getFeishuApprovalStatus dep" };
  }
  const status = deps.getFeishuApprovalStatus();
  return { status: "ok", state: status || { status: "stopped" } };
}

function feishuApprovalSecretInfo(_payload, deps = {}) {
  if (!deps || typeof deps.getFeishuApprovalSecretInfo !== "function") {
    return { status: "error", message: "feishuApproval.secretInfo requires getFeishuApprovalSecretInfo dep" };
  }
  const info = deps.getFeishuApprovalSecretInfo() || { configured: false };
  return { status: "ok", ...info };
}

async function feishuApprovalSendTest(_payload, deps = {}) {
  if (!deps || typeof deps.sendFeishuApprovalTest !== "function") {
    return { status: "error", message: "feishuApproval.test requires sendFeishuApprovalTest dep" };
  }
  let secrets;
  let secretsRevision;
  try {
    secrets = typeof deps.getFeishuApprovalSecrets === "function"
      ? deps.getFeishuApprovalSecrets()
      : null;
    secretsRevision = typeof deps.getFeishuApprovalSecretsRevision === "function"
      ? deps.getFeishuApprovalSecretsRevision()
      : 0;
  } catch {
    return { status: "error", code: "credentials-read-failed" };
  }
  const evaluated = evaluateFeishuApprovalConfiguration(
    deps.snapshot && deps.snapshot.feishuApproval,
    secrets,
  );
  if (!evaluated.ok) return { status: "error", code: evaluated.code };
  const result = await deps.sendFeishuApprovalTest({
    config: evaluated.config,
    secrets,
    secretsRevision,
  });
  // Defensive only, but the renderer shows a code-less `message` verbatim — so
  // it stays brand-neutral like every other user-visible string on this path.
  return result || { status: "error", message: "Remote approval test returned no result" };
}

function cleanupMessage(result) {
  const summary = result && result.summary;
  if (!summary) return "Integration cleanup finished";
  const failed = Number(summary.failed || 0);
  const affected = Number(summary.agentsAffected || 0);
  const removed = Number(summary.entriesRemoved || 0);
  return failed > 0
    ? `Integration cleanup finished with ${failed} failure(s); removed ${removed} item(s) from ${affected} integration(s).`
    : `Integration cleanup finished; removed ${removed} item(s) from ${affected} integration(s).`;
}

function normalizeAgentDismissMapForCommit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const key of Object.keys(value)) {
    if (typeof key === "string" && key && value[key] === true) out[key] = true;
  }
  return out;
}

function markDismissedAgentInstallHints(snapshot, agentIds) {
  const next = normalizeAgentDismissMapForCommit(snapshot && snapshot.dismissedAgentInstallHints);
  for (const agentId of agentIds) next[agentId] = true;
  return next;
}

function clearDismissedAgentCleanupHints(snapshot, agentIds) {
  const next = normalizeAgentDismissMapForCommit(snapshot && snapshot.dismissedAgentCleanupHints);
  for (const agentId of agentIds) delete next[agentId];
  return next;
}

async function cleanupIntegrationsCommand(_payload, deps = {}) {
  if (!deps || typeof deps.cleanupIntegrations !== "function") {
    return { status: "error", message: "cleanupIntegrations requires cleanupIntegrations dep" };
  }

  const snapshot = deps.snapshot || {};
  let agents = { ...((snapshot && snapshot.agents) || {}) };
  let agentsChanged = false;

  for (const agentId of MANAGED_CLEANUP_AGENT_IDS) {
    const flagDeps = {
      ...deps,
      snapshot: { ...snapshot, agents },
    };
    const result = setAgentFlag({ agentId, flag: "enabled", value: false }, flagDeps);
    if (!result || result.status !== "ok") {
      return result || { status: "error", message: `Failed to disable ${agentId}` };
    }
    if (result.commit && result.commit.agents) {
      agents = result.commit.agents;
      agentsChanged = true;
    }
    const currentEntry = agents[agentId] && typeof agents[agentId] === "object"
      ? agents[agentId]
      : {};
    if (currentEntry.integrationInstalled !== false) {
      agents = {
        ...agents,
        [agentId]: {
          ...currentEntry,
          integrationInstalled: false,
        },
      };
      agentsChanged = true;
    }
  }

  let cleanup;
  try {
    cleanup = await deps.cleanupIntegrations({ source: "about", backup: true });
  } catch (err) {
    cleanup = {
      status: "error",
      message: err && err.message ? err.message : String(err),
      summary: { agentsChecked: 0, agentsAffected: 0, entriesRemoved: 0, skipped: 0, failed: 1 },
    };
  }

  const response = {
    status: "ok",
    cleanup,
    message: cleanup.status === "error" ? cleanup.message : cleanupMessage(cleanup),
    commit: {
      dismissedAgentInstallHints: markDismissedAgentInstallHints(snapshot, MANAGED_CLEANUP_AGENT_IDS),
      dismissedAgentCleanupHints: clearDismissedAgentCleanupHints(snapshot, MANAGED_CLEANUP_AGENT_IDS),
    },
  };
  if (agentsChanged) response.commit.agents = agents;
  return response;
}

// Share a domain lock across all four remoteSsh.* commands so concurrent
// invocations against the same prefs field serialize. Without this, the
// controller assigns each command its own lock by name, and two commands
// (e.g. remoteSsh.update and remoteSsh.markDeployed) can both read the same
// snapshot, compute their own commit, and stomp each other's writes.
//
// Concrete races this guards:
//   - update + markDeployed: stamp can clobber a label edit committed
//     between the read and write of update.
//   - delete + markDeployed: markDeployed can resurrect a profile after
//     delete committed.
//   - add + markDeployed: less likely (different ids) but kept for
//     defense-in-depth.
remoteSshAddProfile.lockKey = "remoteSsh";
remoteSshUpdateProfile.lockKey = "remoteSsh";
remoteSshDeleteProfile.lockKey = "remoteSsh";
remoteSshMarkDeployed.lockKey = "remoteSsh";
remoteSshMarkRemoteNode.lockKey = "remoteSsh";
remoteSshApplyInstallationIdentity.lockKey = "remoteSsh";
remoteSshBeginIdentityRotation.lockKey = "remoteSsh";
remoteSshUpdateIdentityStep.lockKey = "remoteSsh";
remoteSshCommitIdentityRotation.lockKey = "remoteSsh";
remoteSshForceRevoke.lockKey = "remoteSsh";
remoteSshBeginRuntimeModeSwitch.lockKey = "remoteSsh";
remoteSshAdvanceRuntimeModeSwitch.lockKey = "remoteSsh";
remoteSshSwitchRuntimeMode.lockKey = "remoteSsh";
telegramApprovalSetToken.lockKey = "tgApproval";
telegramApprovalSendTest.lockKey = "tgApproval";
updateRegistry.feishuApproval.lockKey = "feishuApproval";
feishuApprovalSetSecrets.lockKey = "feishuApproval";
feishuApprovalSaveManualApprover.lockKey = "feishuApproval";
feishuApprovalCommitResolvedApprover.lockKey = "feishuApproval";
feishuApprovalUpdateConfig.lockKey = "feishuApproval";
feishuApprovalSendTest.lockKey = "feishuApproval";
cleanupIntegrationsCommand.lockKey = "agentIntegration";

const repairDoctorIssue = createRepairDoctorIssue({
  repairAgentIntegration,
  setBubbleCategoryEnabled,
});

// textScale is per-display: the slider edits the entry for the display the
// settings window currently sits on (what you see is what you tune). The
// renderer can't know which display that is, so the key is resolved
// main-side via the injected resolveTextScaleDisplayKey dep. Without display
// context (tests, headless) fall back to committing the legacy global so the
// slider still works.
function setTextScaleForDisplay(payload, deps) {
  const value = Number(payload && payload.value);
  if (!isValidTextScale(value)) {
    return {
      status: "error",
      message: `textScale must be a number between ${TEXT_SCALE_MIN} and ${TEXT_SCALE_MAX}`,
    };
  }
  const key = deps && typeof deps.resolveTextScaleDisplayKey === "function"
    ? deps.resolveTextScaleDisplayKey()
    : null;
  if (typeof key !== "string" || !key) {
    return { status: "ok", commit: { textScale: value } };
  }
  const snapshot = (deps && deps.snapshot) || {};
  // New key goes first so the normalize cap can only trim stale displays,
  // never the entry being written.
  const prev = { ...(snapshot.textScaleByDisplay || {}) };
  delete prev[key];
  const next = normalizeTextScaleByDisplay({ [key]: value, ...prev });
  return { status: "ok", commit: { textScaleByDisplay: next } };
}

const commandRegistry = {
  addCustomApplication,
  removeTheme,
  installHooks,
  uninstallHooks,
  cleanupIntegrations: cleanupIntegrationsCommand,
  clearAgentCleanupHints,
  clearAgentInstallHints,
  deployToWsl,
  dismissAgentCleanupHints,
  dismissAgentInstallHints,
  installAgentIntegration,
  removeFromWsl,
  removeCustomApplication,
  repairAgentIntegration,
  setAgentCustomDiscoveryPaths,
  setAgentCustomPermissionUrl,
  uninstallAgentIntegration,
  repairLocalServer,
  repairDoctorIssue,
  resizePet,
  registerShortcut,
  resetShortcut,
  resetAllShortcuts,
  setAgentFlag,
  setAgentPermissionMode,
  setAllBubblesHidden,
  setKimiQuotaCollectionEnabled,
  setPermissionAutomationMode,
  setMobilePermissionPreviewEnabled,
  "mobilePreview.regenerateToken": regenerateMobileToken,
  "mobilePreview.resetAccess": resetMobileAccess,
  setBubbleCategoryEnabled,
  "sessionCleanup.setTriple": setSessionCleanupTriple,
  setSessionAlias,
  setTextScaleForDisplay,
  setAnimationOverride,
  setSoundOverride,
  setThemeOverrideDisabled,
  resetThemeOverrides,
  importAnimationOverrides,
  setWideHitboxOverride,
  setThemeSelection,
  setIdleVisual,
  "remoteSsh.add": remoteSshAddProfile,
  "remoteSsh.update": remoteSshUpdateProfile,
  "remoteSsh.delete": remoteSshDeleteProfile,
  "remoteSsh.markDeployed": remoteSshMarkDeployed,
  "remoteSsh.markRemoteNode": remoteSshMarkRemoteNode,
  "remoteSsh.applyInstallationIdentity": remoteSshApplyInstallationIdentity,
  "remoteSsh.beginIdentityRotation": remoteSshBeginIdentityRotation,
  "remoteSsh.updateIdentityStep": remoteSshUpdateIdentityStep,
  "remoteSsh.commitIdentityRotation": remoteSshCommitIdentityRotation,
  "remoteSsh.forceRevoke": remoteSshForceRevoke,
  "remoteSsh.beginRuntimeModeSwitch": remoteSshBeginRuntimeModeSwitch,
  "remoteSsh.advanceRuntimeModeSwitch": remoteSshAdvanceRuntimeModeSwitch,
  "remoteSsh.switchRuntimeMode": remoteSshSwitchRuntimeMode,
  "telegramApproval.setToken": telegramApprovalSetToken,
  "telegramApproval.status": telegramApprovalStatus,
  "telegramApproval.tokenInfo": telegramApprovalTokenInfo,
  "telegramApproval.test": telegramApprovalSendTest,
  "feishuApproval.setSecrets": feishuApprovalSetSecrets,
  "feishuApproval.saveManualApprover": feishuApprovalSaveManualApprover,
  "feishuApproval.updateConfig": feishuApprovalUpdateConfig,
  "feishuApproval.commitResolvedApprover": feishuApprovalCommitResolvedApprover,
  "feishuApproval.status": feishuApprovalStatus,
  "feishuApproval.secretInfo": feishuApprovalSecretInfo,
  "feishuApproval.test": feishuApprovalSendTest,
  "telegramMigration.snapshot": telegramMigrationSnapshot,
  "telegramMigration.dispatch": telegramMigrationDispatch,
};

module.exports = {
  updateRegistry,
  commandRegistry,
  saveFeishuApproverByEmail,
  ONESHOT_OVERRIDE_STATES,
  ANIMATION_OVERRIDES_EXPORT_VERSION,
  MANAGED_CLEANUP_AGENT_IDS,
  // Exposed for tests
  requireBoolean,
  requireFiniteNumber,
  requireEnum,
  requireString,
  requirePlainObject,
  requireIntegerInRange,
};
