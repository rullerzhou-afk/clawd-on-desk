"use strict";

// ── Remote SSH profile schema + validation ──
//
// Pure schema helpers for `prefs.remoteSsh.profiles[]`. Used by:
//   - prefs.js normalizeRemoteSsh (drop bad data on load)
//   - settings-actions.js remoteSsh.add / .update commands (reject bad input)
//
// All security-sensitive validation lives here so writers and readers see
// the same rules. Per plan v7 §3.1:
//
//   host          — hostname OR user@hostname; ASCII alphanumeric + . _ -
//                   leading char must be alnum (block `-` to defeat ssh
//                   option injection); at most one `@`.
//   port          — integer in [1, 65535] when set; default 22 means absent.
//   identityFile  — absolute path; no control chars / newline; no leading `-`.
//                   Existence checked at Connect time, not at write time.
//   remoteForwardPort — integer in SERVER_PORTS (23333-23337). Secure remote
//                   hooks pin this exact port; keeping the historical range
//                   makes migration and mixed-version diagnostics predictable.
//   hostPrefix    — no control chars / newlines AND none of these shell-special
//                   chars: ' " ` $ \ !  (! is bash history expansion). Together
//                   with the ssh-stdin write at deploy time, this is the second
//                   layer of defense.

const path = require("path");
const {
  REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT,
  REMOTE_RUNTIME_MODE_PROFILE_ISOLATED,
  ACCOUNT_DEFAULT_RUNTIME_KEY,
  REMOTE_LAYOUT_VERSION,
  normalizeRemoteRuntimeIdentity,
  resolveRemoteRuntimeLayout,
} = require("./remote-ssh-layout");
const { LOCAL_SESSION_PROFILE_ID } = require("./session-key");

// Must stay equal to hooks/server-config.js SERVER_PORTS during the legacy
// coexistence window. New secure Remote SSH hooks use one pinned port and
// never scan this list, but the constrained range preserves predictable
// validation, diagnostics, and downgrade behavior.
const REMOTE_FORWARD_PORTS = [23333, 23334, 23335, 23336, 23337];

const HOST_BARE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const HOST_USER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Control chars (0x00-0x1F + DEL 0x7F) — covers \n, \r, \t, NUL, etc.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
// hostPrefix: control chars + shell metacharacters that can break out of
// quoting on the remote even with our ssh-stdin write. Single quote, double
// quote, backtick, dollar, backslash, exclamation.
const HOST_PREFIX_FORBIDDEN_RE = /[\x00-\x1f\x7f'"`$\\!]/;
const MAX_MANAGED_DEPLOY_TARGETS = 8;
const SSH_TRANSPORT_MODES = new Set(["auto", "serialized"]);
const SSH_TRANSPORT_HINT_KINDS = new Set(["codespaces-stdio", "explicit-serialized"]);
const CODESPACE_TRANSPORT_KEY_RE = /^codespace:[a-z0-9][a-z0-9-]{0,99}$/;
const DESTINATION_TRANSPORT_KEY_RE = /^destination-sha256:[a-f0-9]{64}$/;
const ROUTING_NONCE_RE = /^[a-f0-9]{32}$/;
const INSTALL_ID_RE = /^[a-f0-9]{64}$/;
const REMOTE_IDENTITY_TXN_PHASES = new Set(["idle", "rotating", "verifying", "committed"]);
const REMOTE_IDENTITY_STEP_NAMES = Object.freeze([
  "identity",
  "secureMarker",
  "hookFiles",
  "installClaude",
  "installCodex",
  "installCopilot",
  "claudePermission",
  "codexMonitor",
]);
const REMOTE_IDENTITY_STEP_STATUSES = new Set(["pending", "done", "not-applicable", "failed"]);
const REMOTE_RUNTIME_MODE_TXN_PHASES = new Set([
  "prepared",
  "cleanup-done",
  "bootstrap-done",
]);

function isValidRoutingNonce(value) {
  return typeof value === "string" && ROUTING_NONCE_RE.test(value);
}

function isValidInstallId(value) {
  return typeof value === "string" && INSTALL_ID_RE.test(value);
}

function isValidRuntimeMode(value) {
  return value === REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT
    || value === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED;
}

function isValidRuntimeKey(value, runtimeMode) {
  try {
    normalizeRemoteRuntimeIdentity({ runtimeMode, runtimeKey: value });
    return runtimeMode === REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT
      ? value === ACCOUNT_DEFAULT_RUNTIME_KEY
      : true;
  } catch (_) {
    return false;
  }
}

function isValidSshTransportMode(value) {
  return SSH_TRANSPORT_MODES.has(value);
}

function sanitizeSshTransportHint(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.version !== 1
    || raw.mode !== "serialized"
    || !SSH_TRANSPORT_HINT_KINDS.has(raw.kind)
    || typeof raw.keyId !== "string"
    || raw.keyId.length > 160) {
    return null;
  }
  if (raw.kind === "codespaces-stdio" && !CODESPACE_TRANSPORT_KEY_RE.test(raw.keyId)) {
    return null;
  }
  if (raw.kind === "explicit-serialized" && !DESTINATION_TRANSPORT_KEY_RE.test(raw.keyId)) {
    return null;
  }
  return {
    version: 1,
    mode: "serialized",
    kind: raw.kind,
    keyId: raw.keyId,
  };
}

function sanitizeRuntimeModeTxn(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!isValidRuntimeMode(raw.fromMode)
    || !isValidRuntimeKey(raw.fromKey, raw.fromMode)
    || !isValidRuntimeMode(raw.toMode)
    || !isValidRuntimeKey(raw.toKey, raw.toMode)
    || raw.fromMode === raw.toMode
    || raw.layoutVersion !== REMOTE_LAYOUT_VERSION
    || !REMOTE_RUNTIME_MODE_TXN_PHASES.has(raw.phase)
    || !Number.isFinite(raw.startedAt)
    || raw.startedAt <= 0) {
    return null;
  }
  return {
    fromMode: raw.fromMode,
    fromKey: raw.fromKey,
    toMode: raw.toMode,
    toKey: raw.toKey,
    layoutVersion: REMOTE_LAYOUT_VERSION,
    phase: raw.phase,
    startedAt: raw.startedAt,
  };
}

function sanitizeIdentityStep(raw) {
  const status = typeof raw === "string"
    ? raw
    : (raw && typeof raw === "object" ? raw.status : null);
  if (!REMOTE_IDENTITY_STEP_STATUSES.has(status)) return null;
  const out = { status };
  if (raw && typeof raw === "object" && typeof raw.evidence === "string") {
    const evidence = raw.evidence.trim();
    if (evidence && evidence.length <= 500 && !CONTROL_CHARS_RE.test(evidence)) {
      out.evidence = evidence;
    }
  }
  if (status === "not-applicable" && !out.evidence) return null;
  return out;
}

function sanitizeIdentityTxn(raw, expected = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const runtimeMode = expected.runtimeMode || REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT;
  const runtimeKey = typeof raw.runtimeKey === "string" ? raw.runtimeKey : expected.runtimeKey;
  const layoutVersion = Number.isInteger(raw.layoutVersion)
    ? raw.layoutVersion
    : expected.layoutVersion;
  if (!isValidRuntimeKey(runtimeKey, runtimeMode)
    || layoutVersion !== REMOTE_LAYOUT_VERSION
    || !REMOTE_IDENTITY_TXN_PHASES.has(raw.phase)
    || !Number.isFinite(raw.startedAt)
    || raw.startedAt <= 0
    || !Number.isFinite(raw.previousExpiresAt)
    || raw.previousExpiresAt <= raw.startedAt
    || (raw.fromNonce !== null && raw.fromNonce !== undefined && !isValidRoutingNonce(raw.fromNonce))
    || !isValidRoutingNonce(raw.toNonce)
    || (raw.fromNonce && raw.fromNonce === raw.toNonce)
    || !raw.steps
    || typeof raw.steps !== "object"
    || Array.isArray(raw.steps)) {
    return null;
  }
  const steps = {};
  for (const name of REMOTE_IDENTITY_STEP_NAMES) {
    const step = sanitizeIdentityStep(raw.steps[name]);
    if (!step) return null;
    steps[name] = step;
  }
  return {
    runtimeKey,
    layoutVersion,
    phase: raw.phase,
    fromNonce: raw.fromNonce || null,
    toNonce: raw.toNonce,
    startedAt: raw.startedAt,
    previousExpiresAt: raw.previousExpiresAt,
    steps,
  };
}

function isValidDetectedRemoteNodeBin(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && !CONTROL_CHARS_RE.test(value);
}

function isValidRemoteHome(value) {
  return typeof value === "string"
    && value !== "/"
    && value.startsWith("/")
    && path.posix.normalize(value) === value
    && !CONTROL_CHARS_RE.test(value);
}

function isValidDetectedRemoteNodeVersion(value) {
  return typeof value === "string"
    && value.length <= 50
    && /^v\d+/i.test(value)
    && !CONTROL_CHARS_RE.test(value);
}

function isValidDetectedRemoteNodeSource(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 120
    && !CONTROL_CHARS_RE.test(value);
}

function sanitizeIsolatedRuntime(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!isValidRemoteHome(raw.runtimeRoot)
    || !isValidRemoteHome(raw.binDir)
    || !raw.binDir.startsWith(`${raw.runtimeRoot}/`)
    || typeof raw.active !== "boolean"
    || !Number.isFinite(raw.verifiedAt)
    || raw.verifiedAt <= 0
    || !raw.capabilities
    || typeof raw.capabilities !== "object"
    || Array.isArray(raw.capabilities)) {
    return null;
  }
  const capabilities = {};
  for (const name of ["claude", "codex", "copilot"]) {
    const entry = raw.capabilities[name];
    if (!entry || typeof entry !== "object") return null;
    const clean = {
      present: entry.present === true,
      versionVerified: entry.versionVerified === true,
      artifactVerified: entry.artifactVerified === true,
      wrapperInvoked: entry.wrapperInvoked === true,
    };
    if (clean.present) {
      if (!isValidDetectedRemoteNodeBin(entry.executablePath)
        || !isValidDetectedRemoteNodeBin(entry.wrapperPath)
        || !entry.wrapperPath.startsWith(`${raw.binDir}/`)
        || typeof entry.version !== "string"
        || entry.version.length > 160
        || CONTROL_CHARS_RE.test(entry.version)) {
        return null;
      }
      clean.executablePath = entry.executablePath;
      clean.wrapperPath = entry.wrapperPath;
      clean.version = entry.version;
    }
    capabilities[name] = clean;
  }
  const applicable = Object.values(capabilities).filter((entry) => entry.present);
  const active = raw.active === true
    && applicable.length > 0
    && applicable.every((entry) => (
      entry.versionVerified
      && entry.artifactVerified
      && entry.wrapperInvoked
      && typeof entry.wrapperPath === "string"
    ));
  return {
    runtimeRoot: raw.runtimeRoot,
    binDir: raw.binDir,
    active,
    verifiedAt: raw.verifiedAt,
    capabilities,
  };
}

function isValidHost(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > 255) return false;
  if (HOST_BARE_RE.test(value)) return true;
  if (HOST_USER_RE.test(value)) return true;
  return false;
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isValidRemoteForwardPort(value) {
  return REMOTE_FORWARD_PORTS.includes(value);
}

function isValidIdentityFile(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (CONTROL_CHARS_RE.test(value)) return false;
  if (value.startsWith("-")) return false;
  if (!path.isAbsolute(value)) return false;
  return true;
}

function isValidHostPrefix(value) {
  if (typeof value !== "string") return false;
  if (HOST_PREFIX_FORBIDDEN_RE.test(value)) return false;
  return true;
}

function isValidLabel(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 100) return false;
  if (CONTROL_CHARS_RE.test(value)) return false;
  return true;
}

function isValidId(value) {
  return typeof value === "string"
    && value !== LOCAL_SESSION_PROFILE_ID
    && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

function sanitizeManagedDeployTarget(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const target = {
    host: typeof raw.host === "string" ? raw.host.trim() : "",
    port: Number.isInteger(raw.port) && raw.port !== 22 ? raw.port : undefined,
    identityFile: typeof raw.identityFile === "string" && raw.identityFile.length > 0
      ? raw.identityFile
      : undefined,
    remoteForwardPort: Number.isInteger(raw.remoteForwardPort) ? raw.remoteForwardPort : 23333,
    hostPrefix: typeof raw.hostPrefix === "string" && raw.hostPrefix.length > 0
      ? raw.hostPrefix
      : undefined,
    chainStatusline: raw.chainStatusline === true,
    deployedAt: Number(raw.deployedAt),
    profileId: typeof raw.profileId === "string" ? raw.profileId : undefined,
    installId: typeof raw.installId === "string" ? raw.installId : undefined,
    runtimeMode: raw.runtimeMode || REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT,
    runtimeKey: raw.runtimeKey || ACCOUNT_DEFAULT_RUNTIME_KEY,
    layoutVersion: Number.isInteger(raw.layoutVersion) ? raw.layoutVersion : REMOTE_LAYOUT_VERSION,
    remoteHome: typeof raw.remoteHome === "string" ? raw.remoteHome : undefined,
  };
  const sshTransportHint = sanitizeSshTransportHint(raw.sshTransportHint);
  if (sshTransportHint) target.sshTransportHint = sshTransportHint;
  const hasOwnershipFields = [
    target.profileId,
    target.installId,
    target.remoteHome,
  ].some((value) => value !== undefined);
  if (!isValidHost(target.host)
    || (target.port !== undefined && !isValidPort(target.port))
    || (target.identityFile !== undefined && !isValidIdentityFile(target.identityFile))
    || !isValidRemoteForwardPort(target.remoteForwardPort)
    || (target.hostPrefix !== undefined && !isValidHostPrefix(target.hostPrefix))
    || !Number.isFinite(target.deployedAt)
    || target.deployedAt <= 0
    || (hasOwnershipFields && (
      !isValidId(target.profileId)
      || !isValidInstallId(target.installId)
      || !isValidRuntimeMode(target.runtimeMode)
      || !isValidRuntimeKey(target.runtimeKey, target.runtimeMode)
      || target.layoutVersion !== REMOTE_LAYOUT_VERSION
      || !isValidRemoteHome(target.remoteHome)
    ))) {
    return null;
  }
  if (!hasOwnershipFields) {
    delete target.profileId;
    delete target.installId;
    delete target.runtimeMode;
    delete target.runtimeKey;
    delete target.layoutVersion;
    delete target.remoteHome;
  }
  if (isValidDetectedRemoteNodeBin(raw.detectedRemoteNodeBin)) {
    target.detectedRemoteNodeBin = raw.detectedRemoteNodeBin;
    if (isValidDetectedRemoteNodeVersion(raw.detectedRemoteNodeVersion)) {
      target.detectedRemoteNodeVersion = raw.detectedRemoteNodeVersion;
    }
    if (isValidDetectedRemoteNodeSource(raw.detectedRemoteNodeSource)) {
      target.detectedRemoteNodeSource = raw.detectedRemoteNodeSource;
    }
    if (Number.isFinite(raw.detectedRemoteNodeAt) && raw.detectedRemoteNodeAt > 0) {
      target.detectedRemoteNodeAt = raw.detectedRemoteNodeAt;
    }
  }
  for (const key of Object.keys(target)) {
    if (target[key] === undefined) delete target[key];
  }
  return target;
}

function remoteAccountKey(profile) {
  if (!profile || typeof profile !== "object") return "";
  const host = typeof profile.host === "string" ? profile.host.trim() : "";
  const port = Number.isInteger(profile.port) ? profile.port : 22;
  return `${host}\n${port}`;
}

function remoteOwnershipDomainKey(profile) {
  const runtimeMode = isValidRuntimeMode(profile && profile.runtimeMode)
    ? profile.runtimeMode
    : REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT;
  const candidateKey = profile && profile.runtimeKey;
  const runtimeKey = isValidRuntimeKey(candidateKey, runtimeMode)
    ? candidateKey
    : ACCOUNT_DEFAULT_RUNTIME_KEY;
  const layoutVersion = profile && profile.layoutVersion === REMOTE_LAYOUT_VERSION
    ? profile.layoutVersion
    : REMOTE_LAYOUT_VERSION;
  return `${remoteAccountKey(profile)}\n${runtimeMode}\n${runtimeKey}\n${layoutVersion}`;
}

function normalizeManagedDeployTargets(value) {
  if (!Array.isArray(value)) return [];
  const byAccount = new Map();
  for (const raw of value) {
    const target = sanitizeManagedDeployTarget(raw);
    if (!target) continue;
    const account = remoteAccountKey(target);
    const previous = byAccount.get(account);
    if (!previous || target.deployedAt >= previous.deployedAt) {
      byAccount.set(account, target);
    }
  }
  return Array.from(byAccount.values())
    .sort((a, b) => a.deployedAt - b.deployedAt)
    .slice(-MAX_MANAGED_DEPLOY_TARGETS);
}

// Validate a profile candidate. Returns { status: "ok" } or
// { status: "error", message }.
function validateProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return { status: "error", message: "profile must be an object" };
  }
  if (!isValidId(profile.id)) {
    return { status: "error", message: "profile.id must be 1-64 chars [a-zA-Z0-9_-]" };
  }
  if (!isValidLabel(profile.label)) {
    return { status: "error", message: "profile.label must be 1-100 chars and contain no control characters" };
  }
  if (!isValidHost(profile.host)) {
    return {
      status: "error",
      message: "profile.host must be a hostname or user@hostname (ASCII alnum, . _ -; no leading -; at most one @)",
    };
  }
  if (profile.port !== undefined && profile.port !== null) {
    if (!isValidPort(profile.port)) {
      return { status: "error", message: "profile.port must be an integer in [1, 65535]" };
    }
  }
  if (profile.identityFile !== undefined && profile.identityFile !== null && profile.identityFile !== "") {
    if (!isValidIdentityFile(profile.identityFile)) {
      return {
        status: "error",
        message: "profile.identityFile must be an absolute path with no control chars and not starting with '-'",
      };
    }
  }
  if (!isValidRemoteForwardPort(profile.remoteForwardPort)) {
    return {
      status: "error",
      message: `profile.remoteForwardPort must be one of ${REMOTE_FORWARD_PORTS.join(", ")}`,
    };
  }
  const runtimeMode = profile.runtimeMode || REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT;
  const runtimeKey = profile.runtimeKey || ACCOUNT_DEFAULT_RUNTIME_KEY;
  if (!isValidRuntimeMode(runtimeMode)) {
    return { status: "error", message: "profile.runtimeMode must be account-default or profile-isolated" };
  }
  if (!isValidRuntimeKey(runtimeKey, runtimeMode)) {
    return {
      status: "error",
      message: runtimeMode === REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT
        ? `profile.runtimeKey must be ${ACCOUNT_DEFAULT_RUNTIME_KEY} in account-default mode`
        : "profile.runtimeKey must be a non-reserved opaque id with 1-64 chars [a-zA-Z0-9_-]",
    };
  }
  if ((profile.layoutVersion ?? REMOTE_LAYOUT_VERSION) !== REMOTE_LAYOUT_VERSION) {
    return {
      status: "error",
      message: `profile.layoutVersion must be ${REMOTE_LAYOUT_VERSION}`,
    };
  }
  if (profile.routingNonce !== undefined && !isValidRoutingNonce(profile.routingNonce)) {
    return { status: "error", message: "profile.routingNonce must be a 128-bit lowercase hex value" };
  }
  if (profile.previousNonce !== undefined && !isValidRoutingNonce(profile.previousNonce)) {
    return { status: "error", message: "profile.previousNonce must be a 128-bit lowercase hex value" };
  }
  if (profile.previousNonce !== undefined) {
    if (profile.previousNonce === profile.routingNonce) {
      return { status: "error", message: "profile.previousNonce must differ from routingNonce" };
    }
    if (!Number.isFinite(profile.previousExpiresAt) || profile.previousExpiresAt <= 0) {
      return { status: "error", message: "profile.previousExpiresAt is required with previousNonce" };
    }
  } else if (profile.previousExpiresAt !== undefined) {
    return { status: "error", message: "profile.previousExpiresAt requires previousNonce" };
  }
  if (profile.identityTxn !== undefined) {
    const txn = sanitizeIdentityTxn(profile.identityTxn, {
      runtimeMode,
      runtimeKey,
      layoutVersion: profile.layoutVersion ?? REMOTE_LAYOUT_VERSION,
    });
    if (!txn
      || txn.runtimeKey !== runtimeKey
      || txn.layoutVersion !== (profile.layoutVersion ?? REMOTE_LAYOUT_VERSION)) {
      return { status: "error", message: "profile.identityTxn is invalid or bound to another runtime layout" };
    }
  }
  if (profile.runtimeModeTxn !== undefined) {
    const txn = sanitizeRuntimeModeTxn(profile.runtimeModeTxn);
    if (!txn
      || txn.fromMode !== runtimeMode
      || txn.fromKey !== runtimeKey) {
      return {
        status: "error",
        message: "profile.runtimeModeTxn is invalid or is not bound to the current runtime layout",
      };
    }
  }
  if (profile.isolatedActive !== undefined && typeof profile.isolatedActive !== "boolean") {
    return { status: "error", message: "profile.isolatedActive must be a boolean" };
  }
  if (profile.isolatedRuntime !== undefined && !sanitizeIsolatedRuntime(profile.isolatedRuntime)) {
    return { status: "error", message: "profile.isolatedRuntime is invalid" };
  }
  if (profile.runtimeKeyConflict !== undefined && typeof profile.runtimeKeyConflict !== "boolean") {
    return { status: "error", message: "profile.runtimeKeyConflict must be a boolean" };
  }
  if (profile.hostPrefix !== undefined && profile.hostPrefix !== null && profile.hostPrefix !== "") {
    if (!isValidHostPrefix(profile.hostPrefix)) {
      return {
        status: "error",
        message: "profile.hostPrefix must not contain control chars or any of: ' \" ` $ \\ !",
      };
    }
  }
  if (typeof profile.autoStartCodexMonitor !== "boolean") {
    return { status: "error", message: "profile.autoStartCodexMonitor must be a boolean" };
  }
  if (!isValidSshTransportMode(profile.sshTransportMode || "auto")) {
    return { status: "error", message: "profile.sshTransportMode must be auto or serialized" };
  }
  // Optional for backward compatibility: profiles stored before the field
  // existed simply lack it (sanitizeProfile normalizes absence to false).
  if (profile.chainStatusline !== undefined && typeof profile.chainStatusline !== "boolean") {
    return { status: "error", message: "profile.chainStatusline must be a boolean" };
  }
  if (typeof profile.connectOnLaunch !== "boolean") {
    return { status: "error", message: "profile.connectOnLaunch must be a boolean" };
  }
  // lastDeployedAt is set by the IPC layer after a successful Deploy. It's
  // optional (a fresh profile starts without one) and must be a finite
  // positive integer when present. The UI consumes it to surface "Hooks not
  // deployed" vs "Hooks deployed N minutes ago" so users don't connect a
  // tunnel that has no hooks on the other end.
  if (profile.lastDeployedAt !== undefined && profile.lastDeployedAt !== null) {
    if (!Number.isFinite(profile.lastDeployedAt) || profile.lastDeployedAt <= 0) {
      return { status: "error", message: "profile.lastDeployedAt must be a positive finite number" };
    }
  }
  if (profile.managedDeployTargets !== undefined) {
    if (!Array.isArray(profile.managedDeployTargets)
      || profile.managedDeployTargets.length > MAX_MANAGED_DEPLOY_TARGETS
      || profile.managedDeployTargets.some((target) => !sanitizeManagedDeployTarget(target))) {
      return {
        status: "error",
        message: `profile.managedDeployTargets must contain at most ${MAX_MANAGED_DEPLOY_TARGETS} valid owned targets`,
      };
    }
  }
  if (profile.detectedRemoteNodeBin !== undefined && profile.detectedRemoteNodeBin !== null) {
    if (!isValidDetectedRemoteNodeBin(profile.detectedRemoteNodeBin)) {
      return { status: "error", message: "profile.detectedRemoteNodeBin must be an absolute POSIX path with no control characters" };
    }
  }
  if (profile.detectedRemoteNodeVersion !== undefined && profile.detectedRemoteNodeVersion !== null) {
    if (!isValidDetectedRemoteNodeVersion(profile.detectedRemoteNodeVersion)) {
      return { status: "error", message: "profile.detectedRemoteNodeVersion must be a Node.js version string like v20.10.0" };
    }
  }
  if (profile.detectedRemoteNodeSource !== undefined && profile.detectedRemoteNodeSource !== null) {
    if (!isValidDetectedRemoteNodeSource(profile.detectedRemoteNodeSource)) {
      return { status: "error", message: "profile.detectedRemoteNodeSource must be a short string with no control characters" };
    }
  }
  if (profile.detectedRemoteNodeAt !== undefined && profile.detectedRemoteNodeAt !== null) {
    if (!Number.isFinite(profile.detectedRemoteNodeAt) || profile.detectedRemoteNodeAt <= 0) {
      return { status: "error", message: "profile.detectedRemoteNodeAt must be a positive finite number" };
    }
  }
  if (profile.remoteHome !== undefined && !isValidRemoteHome(profile.remoteHome)) {
    return { status: "error", message: "profile.remoteHome must be a normalized absolute POSIX home path" };
  }
  return { status: "ok" };
}

// Coerce arbitrary input into a sanitized profile, dropping unknown fields.
// Returns null if the result would be invalid.
function sanitizeProfile(raw) {
  if (!raw || typeof raw !== "object") return null;
  let runtimeIdentity;
  try {
    runtimeIdentity = normalizeRemoteRuntimeIdentity({
      runtimeMode: raw.runtimeMode,
      runtimeKey: raw.runtimeKey,
    });
  } catch (_) {
    return null;
  }
  const out = {
    id: typeof raw.id === "string" ? raw.id : "",
    label: typeof raw.label === "string" ? raw.label : "",
    host: typeof raw.host === "string" ? raw.host.trim() : "",
    port: Number.isInteger(raw.port) ? raw.port : undefined,
    identityFile: typeof raw.identityFile === "string" && raw.identityFile.length > 0
      ? raw.identityFile
      : undefined,
    remoteForwardPort: Number.isInteger(raw.remoteForwardPort) ? raw.remoteForwardPort : 23333,
    runtimeMode: runtimeIdentity.runtimeMode,
    runtimeKey: runtimeIdentity.runtimeKey,
    layoutVersion: REMOTE_LAYOUT_VERSION,
    hostPrefix: typeof raw.hostPrefix === "string" && raw.hostPrefix.length > 0
      ? raw.hostPrefix
      : undefined,
    autoStartCodexMonitor: raw.autoStartCodexMonitor === true,
    sshTransportMode: raw.sshTransportMode === "serialized" ? "serialized" : "auto",
    // Opt-in: on deploy, wrap a pre-existing third-party statusline on the
    // remote (chain mode) instead of leaving the quota source unregistered.
    chainStatusline: raw.chainStatusline === true,
    connectOnLaunch: raw.connectOnLaunch === true,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    lastDeployedAt: Number.isFinite(raw.lastDeployedAt) && raw.lastDeployedAt > 0
      ? raw.lastDeployedAt
      : undefined,
    routingNonce: isValidRoutingNonce(raw.routingNonce) ? raw.routingNonce : undefined,
    previousNonce: isValidRoutingNonce(raw.previousNonce) ? raw.previousNonce : undefined,
    previousExpiresAt: Number.isFinite(raw.previousExpiresAt) && raw.previousExpiresAt > 0
      ? raw.previousExpiresAt
      : undefined,
    isolatedActive: false,
    runtimeKeyConflict: raw.runtimeKeyConflict === true,
    remoteHome: isValidRemoteHome(raw.remoteHome) ? raw.remoteHome : undefined,
  };
  const isolatedRuntime = sanitizeIsolatedRuntime(raw.isolatedRuntime);
  if (isolatedRuntime) {
    out.isolatedRuntime = isolatedRuntime;
    if (out.runtimeMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED
      && out.remoteHome
      && isolatedRuntime.active === true) {
      try {
        const layout = resolveRemoteRuntimeLayout({
          runtimeMode: out.runtimeMode,
          runtimeKey: out.runtimeKey,
          remoteHome: out.remoteHome,
        });
        out.isolatedActive = isolatedRuntime.runtimeRoot === layout.runtimeRoot
          && isolatedRuntime.binDir === layout.binDir;
      } catch {
        out.isolatedActive = false;
      }
    }
  }
  if (!out.previousNonce) delete out.previousExpiresAt;
  if (out.previousNonce === out.routingNonce) {
    delete out.previousNonce;
    delete out.previousExpiresAt;
  }
  const identityTxn = sanitizeIdentityTxn(raw.identityTxn, {
    runtimeMode: out.runtimeMode,
    runtimeKey: out.runtimeKey,
    layoutVersion: out.layoutVersion,
  });
  if (identityTxn) out.identityTxn = identityTxn;
  const runtimeModeTxn = sanitizeRuntimeModeTxn(raw.runtimeModeTxn);
  if (runtimeModeTxn
    && runtimeModeTxn.fromMode === out.runtimeMode
    && runtimeModeTxn.fromKey === out.runtimeKey) {
    out.runtimeModeTxn = runtimeModeTxn;
  }
  const managedDeployTargets = normalizeManagedDeployTargets(raw.managedDeployTargets);
  if (managedDeployTargets.length) out.managedDeployTargets = managedDeployTargets;
  if (isValidDetectedRemoteNodeBin(raw.detectedRemoteNodeBin)) {
    out.detectedRemoteNodeBin = raw.detectedRemoteNodeBin;
    if (isValidDetectedRemoteNodeVersion(raw.detectedRemoteNodeVersion)) {
      out.detectedRemoteNodeVersion = raw.detectedRemoteNodeVersion;
    }
    if (isValidDetectedRemoteNodeSource(raw.detectedRemoteNodeSource)) {
      out.detectedRemoteNodeSource = raw.detectedRemoteNodeSource;
    }
    if (Number.isFinite(raw.detectedRemoteNodeAt) && raw.detectedRemoteNodeAt > 0) {
      out.detectedRemoteNodeAt = raw.detectedRemoteNodeAt;
    }
  }
  // Strip undefineds for cleaner JSON.
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  const v = validateProfile(out);
  if (v.status !== "ok") return null;
  return out;
}

// Coerce a `remoteSsh` snapshot.
function normalizeRemoteSsh(value, defaults) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults || { profiles: [] };
  }
  const profiles = Array.isArray(value.profiles) ? value.profiles : [];
  const seen = new Set();
  const isolatedRuntimeOwners = new Map();
  const cleanProfiles = [];
  for (const raw of profiles) {
    const clean = sanitizeProfile(raw);
    if (!clean) continue;
    if (seen.has(clean.id)) continue;
    seen.add(clean.id);
    if (clean.runtimeMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED) {
      const owner = isolatedRuntimeOwners.get(clean.runtimeKey);
      if (owner) {
        owner.isolatedActive = false;
        owner.runtimeKeyConflict = true;
        clean.isolatedActive = false;
        clean.runtimeKeyConflict = true;
      } else {
        isolatedRuntimeOwners.set(clean.runtimeKey, clean);
      }
    } else {
      clean.isolatedActive = false;
      clean.runtimeKeyConflict = false;
    }
    cleanProfiles.push(clean);
  }
  const out = { profiles: cleanProfiles };
  if (isValidInstallId(value.installId)) out.installId = value.installId;
  return out;
}

function getDefaults() {
  return { profiles: [] };
}

// Build a normalized fingerprint of the deploy target fields. Used by both
// remoteSsh.update (decide if cosmetic edit → preserve lastDeployedAt) and
// remoteSsh.markDeployed (decide if mid-deploy drift → no-op stamp). Without
// normalization, equality checks would falsely flag "drift" in cases like:
//
//   prev.port = 22  (default ssh port, kept by sanitize as a number)
//   next.port = undefined  (UI saveBtn omits port when value === 22)
//
// Both represent the same deploy target — port 22 is ssh's default, present
// or absent makes no functional difference. Same logic for empty optional
// strings (identityFile, hostPrefix): "" and undefined are equivalent.
function deployTargetFingerprint(profile) {
  if (!profile || typeof profile !== "object") return null;
  const port = Number.isInteger(profile.port) && profile.port !== 22
    ? profile.port
    : undefined;
  const identityFile = typeof profile.identityFile === "string" && profile.identityFile.length > 0
    ? profile.identityFile
    : undefined;
  const hostPrefix = typeof profile.hostPrefix === "string" && profile.hostPrefix.length > 0
    ? profile.hostPrefix
    : undefined;
  // false and absent are equivalent: profiles stored before the field
  // existed lack it, and both mean "deploy without statusline chaining".
  const chainStatusline = profile.chainStatusline === true ? true : undefined;
  return {
    host: typeof profile.host === "string" && profile.host.length > 0 ? profile.host : undefined,
    port,
    identityFile,
    remoteForwardPort: Number.isInteger(profile.remoteForwardPort) ? profile.remoteForwardPort : undefined,
    hostPrefix,
    chainStatusline,
    runtimeMode: profile.runtimeMode || REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT,
    runtimeKey: profile.runtimeMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED
      ? profile.runtimeKey
      : ACCOUNT_DEFAULT_RUNTIME_KEY,
    layoutVersion: Number.isInteger(profile.layoutVersion)
      ? profile.layoutVersion
      : REMOTE_LAYOUT_VERSION,
  };
}

// Compare two fingerprints. Returns null if equal, or the name of the first
// drifted field. Stable field order so the diff is deterministic for UX
// messages ("host changed during deploy").
// chainStatusline is a deploy-target field: flipping it changes what the
// install-claude step writes on the remote, so the profile must read as
// "not deployed" until the user redeploys.
const DEPLOY_TARGET_FIELDS = [
  "host",
  "port",
  "identityFile",
  "remoteForwardPort",
  "hostPrefix",
  "chainStatusline",
  "runtimeMode",
  "runtimeKey",
  "layoutVersion",
];

function deployTargetDrift(a, b) {
  if (!a || !b) return DEPLOY_TARGET_FIELDS[0];
  for (const f of DEPLOY_TARGET_FIELDS) {
    if (a[f] !== b[f]) return f;
  }
  return null;
}

module.exports = {
  REMOTE_FORWARD_PORTS,
  REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT,
  REMOTE_RUNTIME_MODE_PROFILE_ISOLATED,
  ACCOUNT_DEFAULT_RUNTIME_KEY,
  REMOTE_LAYOUT_VERSION,
  REMOTE_IDENTITY_STEP_NAMES,
  DEPLOY_TARGET_FIELDS,
  MAX_MANAGED_DEPLOY_TARGETS,
  isValidSshTransportMode,
  sanitizeSshTransportHint,
  isValidHost,
  isValidPort,
  isValidRemoteForwardPort,
  isValidIdentityFile,
  isValidHostPrefix,
  isValidLabel,
  isValidId,
  isValidDetectedRemoteNodeBin,
  isValidDetectedRemoteNodeVersion,
  isValidDetectedRemoteNodeSource,
  sanitizeIsolatedRuntime,
  isValidRemoteHome,
  isValidRoutingNonce,
  isValidInstallId,
  isValidRuntimeMode,
  isValidRuntimeKey,
  sanitizeIdentityStep,
  sanitizeIdentityTxn,
  sanitizeRuntimeModeTxn,
  validateProfile,
  sanitizeProfile,
  normalizeRemoteSsh,
  getDefaults,
  deployTargetFingerprint,
  deployTargetDrift,
  sanitizeManagedDeployTarget,
  normalizeManagedDeployTargets,
  remoteAccountKey,
  remoteOwnershipDomainKey,
};
