"use strict";

// Effective SSH transport inspection for Remote SSH.
//
// `ssh -G` expands the user's local OpenSSH configuration without opening a
// network connection.  The resulting ProxyCommand is parsed as data only; it
// is never evaluated or replayed by Clawd.

const childProcess = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { decodeShellBytes } = require("./remote-ssh-decode");
const {
  appendRemoteSshConfigArgs,
  getRemoteSshConfigFile,
} = require("./remote-ssh-local-config");

const INSPECT_TIMEOUT_MS = 5000;
const INSPECT_DRAIN_TIMEOUT_MS = 1000;
const MAX_INSPECT_OUTPUT_BYTES = 64 * 1024;
const CODESPACE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/;

function boundedAppend(current, chunk, limit = MAX_INSPECT_OUTPUT_BYTES) {
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (current.length >= limit) return current;
  const remaining = limit - current.length;
  return Buffer.concat([current, next.subarray(0, remaining)]);
}

function buildSshConfigArgs(profile) {
  if (!profile || typeof profile.host !== "string" || !profile.host) {
    throw new Error("inspectEffectiveTransport: profile.host required");
  }
  const args = ["-G"];
  appendRemoteSshConfigArgs(args);
  if (profile.identityFile) args.push("-i", profile.identityFile);
  if (Number.isInteger(profile.port) && profile.port !== 22) {
    args.push("-p", String(profile.port));
  }
  args.push(profile.host);
  return args;
}

function parseSshConfig(text) {
  const out = Object.create(null);
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (out[key] === undefined) out[key] = match[2].trim();
  }
  return out;
}

// A deliberately small command-line tokenizer. It understands the quoting
// emitted by OpenSSH for ProxyCommand, while preserving Windows backslashes.
function tokenizeProxyCommand(command) {
  const tokens = [];
  let token = "";
  let quote = null;
  let tokenStarted = false;
  const source = String(command || "");
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        tokenStarted = true;
      } else if (ch === "\\" && quote === '"' && source[i + 1] === '"') {
        token += '"';
        tokenStarted = true;
        i += 1;
      } else {
        token += ch;
        tokenStarted = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += ch;
    tokenStarted = true;
  }
  if (tokenStarted) tokens.push(token);
  return tokens;
}

function executableBasename(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return path.posix.basename(normalized).toLowerCase();
}

function parseCodespacesProxyCommand(proxyCommand) {
  // `gh codespace ssh --config` currently emits an unquoted Windows path:
  //   ProxyCommand C:\Program Files\GitHub CLI\gh.exe cs ssh ...
  // Preserve the entire executable prefix through the exact `gh(.exe)`
  // basename before tokenizing the remaining arguments. Quoted paths and
  // ordinary `gh`/`/usr/bin/gh` forms follow the same path.
  const source = String(proxyCommand || "").trim();
  const launch = /^(?:"([^"\r\n]*(?:[\\/])?gh(?:\.exe)?)"|((?:.*?[\\/])?gh(?:\.exe)?))\s+((?:cs|codespace)\s+ssh(?:\s|$)[\s\S]*)$/i.exec(source);
  if (!launch) return null;
  const executable = launch[1] || launch[2];
  if (!["gh", "gh.exe"].includes(executableBasename(executable))) {
    return null;
  }
  const tokens = [executable, ...tokenizeProxyCommand(launch[3])];
  if (tokens.length < 5) return null;
  let subcommandIndex = -1;
  for (let i = 1; i < tokens.length - 1; i += 1) {
    if ((tokens[i] === "cs" || tokens[i] === "codespace") && tokens[i + 1] === "ssh") {
      subcommandIndex = i;
      break;
    }
  }
  if (subcommandIndex < 0 || !tokens.includes("--stdio")) return null;

  let codespace = null;
  for (let i = subcommandIndex + 2; i < tokens.length; i += 1) {
    const value = tokens[i];
    if ((value === "-c" || value === "--codespace") && i + 1 < tokens.length) {
      codespace = tokens[i + 1];
      break;
    }
    if (value.startsWith("--codespace=")) {
      codespace = value.slice("--codespace=".length);
      break;
    }
  }
  if (!CODESPACE_NAME_RE.test(codespace || "")) return null;
  return { codespace: codespace.toLowerCase() };
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function redactTransportDiagnostic(value, profile) {
  let text = String(value || "");
  // `ssh -v` is required for Win32 Codespaces forward-failure diagnostics,
  // but DEBUG lines can echo the effective ProxyCommand, remote command,
  // config/include paths, and identity paths. Classification consumes the
  // bounded raw buffer before this boundary; no DEBUG line may leave it.
  text = text.replace(/^[ \t]*debug\d+:[^\r\n]*(?:\r?\n|$)/gim, "");
  const identityFile = profile && typeof profile.identityFile === "string"
    ? profile.identityFile.trim()
    : "";
  if (identityFile) text = text.split(identityFile).join("[identity-file]");
  let configFile = null;
  try { configFile = getRemoteSshConfigFile(); } catch {}
  if (configFile) text = text.split(configFile).join("[ssh-config-file]");
  text = text
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, "[token]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[token]")
    .replace(/\b(token|access_token|routingNonce)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bproxycommand\s+[^\r\n]+/gi, "ProxyCommand [redacted]");
  return text.trim().slice(0, 1024);
}

function localTargetFingerprint(profile) {
  return sha256(JSON.stringify({
    host: profile && profile.host || "",
    port: Number.isInteger(profile && profile.port) ? profile.port : 22,
    identityFile: profile && profile.identityFile || "",
    sshConfigFile: getRemoteSshConfigFile() || "",
    sshTransportMode: profile && profile.sshTransportMode === "serialized"
      ? "serialized"
      : "auto",
  }));
}

function destinationKey({ effectiveUser, effectiveHost, effectivePort }) {
  return `destination-sha256:${sha256(`${effectiveUser || ""}\n${effectiveHost || ""}\n${effectivePort || 22}`)}`;
}

function configResult(profile, config) {
  const effectiveHost = config.hostname || String(profile.host || "").split("@").pop();
  const effectiveUser = config.user || (String(profile.host || "").includes("@")
    ? String(profile.host).split("@")[0]
    : "");
  const parsedPort = Number.parseInt(config.port, 10);
  const effectivePort = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 22;
  const fingerprint = localTargetFingerprint(profile);
  const codespaces = parseCodespacesProxyCommand(config.proxycommand);
  if (codespaces) {
    return {
      mode: "serialized",
      kind: "codespaces-stdio",
      key: `codespace:${codespaces.codespace}`,
      effectiveHost,
      effectiveUser,
      effectivePort,
      fingerprint,
      reason: "effective_proxycommand_codespaces_stdio",
    };
  }
  if (profile.sshTransportMode === "serialized") {
    return {
      mode: "serialized",
      kind: "explicit-serialized",
      key: destinationKey({ effectiveUser, effectiveHost, effectivePort }),
      effectiveHost,
      effectiveUser,
      effectivePort,
      fingerprint,
      reason: "explicit_profile_override",
    };
  }
  return {
    mode: "parallel",
    kind: "standard",
    key: `parallel:${destinationKey({ effectiveUser, effectiveHost, effectivePort })}`,
    effectiveHost,
    effectiveUser,
    effectivePort,
    fingerprint,
    reason: "no_serialized_proxy_detected",
  };
}

function failedInspection(profile, reason, message) {
  const fingerprint = localTargetFingerprint(profile);
  if (profile && profile.sshTransportMode === "serialized") {
    const rawHost = String(profile.host || "");
    const at = rawHost.indexOf("@");
    const effectiveUser = at >= 0 ? rawHost.slice(0, at) : "";
    const effectiveHost = at >= 0 ? rawHost.slice(at + 1) : rawHost;
    const effectivePort = Number.isInteger(profile.port) ? profile.port : 22;
    return {
      mode: "serialized",
      kind: "explicit-serialized",
      key: destinationKey({ effectiveUser, effectiveHost, effectivePort }),
      effectiveHost,
      effectiveUser,
      effectivePort,
      fingerprint,
      reason: "explicit_override_inspection_failed",
      warning: redactTransportDiagnostic(message || reason || "ssh -G failed", profile),
    };
  }
  return {
    mode: "unknown",
    kind: "inspection-failed",
    key: null,
    effectiveHost: null,
    effectiveUser: null,
    effectivePort: null,
    fingerprint,
    reason,
    message: redactTransportDiagnostic(message || "Unable to inspect effective SSH transport", profile),
  };
}

function inspectEffectiveTransport(profile, deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : INSPECT_TIMEOUT_MS;
  const drainTimeoutMs = Number.isFinite(deps.drainTimeoutMs)
    ? deps.drainTimeoutMs
    : INSPECT_DRAIN_TIMEOUT_MS;
  let args;
  try {
    args = buildSshConfigArgs(profile);
  } catch (err) {
    return Promise.resolve(failedInspection(profile, "invalid_profile", err && err.message));
  }

  return new Promise((resolve) => {
    let child;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exitCode = null;
    let exitSignal = null;
    let spawnError = null;
    let timedOut = false;
    let settled = false;
    let timeoutTimer = null;
    let drainTimer = null;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeoutFn(timeoutTimer);
      if (drainTimer) clearTimeoutFn(drainTimer);
      resolve(result);
    };
    const fail = (reason, detail) => settle(failedInspection(profile, reason, detail));

    try {
      child = spawn("ssh", args, {
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      fail("spawn_failed", err && err.message);
      return;
    }

    if (child.stdout) child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    if (child.stderr) child.stderr.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.on("error", (err) => { spawnError = err; });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.on("close", (code, signal) => {
      if (exitCode === null) exitCode = code;
      if (exitSignal === null) exitSignal = signal;
      if (timedOut) {
        fail("inspection_timeout", "ssh -G timed out");
        return;
      }
      if (spawnError || exitCode !== 0) {
        const detail = decodeShellBytes(stderr).trim()
          || (spawnError && spawnError.message)
          || `ssh -G exited ${exitCode}${exitSignal ? ` (${exitSignal})` : ""}`;
        fail("inspection_failed", detail);
        return;
      }
      settle(configResult(profile, parseSshConfig(decodeShellBytes(stdout))));
    });

    timeoutTimer = setTimeoutFn(() => {
      if (settled) return;
      timedOut = true;
      try { child.kill(); } catch {}
      drainTimer = setTimeoutFn(() => {
        fail("inspection_drain_timeout", "ssh -G did not close after timeout");
      }, drainTimeoutMs);
    }, timeoutMs);
  });
}

module.exports = {
  INSPECT_TIMEOUT_MS,
  INSPECT_DRAIN_TIMEOUT_MS,
  MAX_INSPECT_OUTPUT_BYTES,
  buildSshConfigArgs,
  parseSshConfig,
  tokenizeProxyCommand,
  parseCodespacesProxyCommand,
  localTargetFingerprint,
  destinationKey,
  redactTransportDiagnostic,
  inspectEffectiveTransport,
};
