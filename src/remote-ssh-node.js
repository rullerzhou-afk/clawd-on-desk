"use strict";

// Remote SSH Node.js resolution helpers.
//
// Clawd runs remote commands through `ssh host <command>`, which is a
// non-interactive remote shell. Node managers such as nvm/fnm/asdf/mise often
// only populate PATH from interactive shell startup files, so a bare `node`
// is not reliable on remotes. This module probes for an absolute Node binary
// and formats all subsequent remote Node invocations with that path.

const childProcess = require("child_process");
const { quoteForPosixShellArg } = require("./remote-ssh-quote");
const { decodeShellBytes } = require("./remote-ssh-decode");
const { isWindowsAbsolutePath } = require("./remote-ssh-layout");
const { REMOTE_NODE_LAUNCH_COMMAND, buildNodeDiscoveryFrame, writeNodeFrameSafely } = require("./remote-ssh-node-launch");

const NODE_PROBE_TIMEOUT_MS = 60000;
const NODE_PROBE_SENTINEL = "__CLAWD_REMOTE_NODE_PROBE__";
const MIN_REMOTE_NODE_MAJOR = 14;

const NODE_PROBE_SCRIPT = `
node_version_supported() {
  v="$1"
  major="\${v#v}"
  major="\${major%%.*}"
  case "$major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge ${MIN_REMOTE_NODE_MAJOR} ]
}

emit_node() {
  p="$1"
  src="$2"
  if [ -z "$p" ]; then return 1; fi
  case "$p" in
    /*) ;;
    *) return 1 ;;
  esac
  if [ ! -x "$p" ]; then return 1; fi
  v="$("$p" --version 2>/dev/null)" || return 1
  node_version_supported "$v" || return 1
  printf 'CLAWD_REMOTE_NODE_BIN=%s\\n' "$p"
  printf 'CLAWD_REMOTE_NODE_VERSION=%s\\n' "$v"
  printf 'CLAWD_REMOTE_NODE_SOURCE=%s\\n' "$src"
  exit 0
}

if [ "$#" -gt 0 ]; then
  emit_node "$1" "\${2:-cache}"
  exit 127
fi

probe_login_shells() {
  for shell in "$SHELL" /bin/zsh /bin/bash /bin/sh
  do
    if [ -z "$shell" ]; then continue; fi
    case "$shell" in
      /*) ;;
      *) continue ;;
    esac
    if [ ! -x "$shell" ]; then continue; fi
    out="$("$shell" -lic 'printf "${NODE_PROBE_SENTINEL}\\n"; command -v node 2>/dev/null; which node 2>/dev/null; true' 2>/dev/null)"
    p="$(printf '%s\\n' "$out" | awk 'found && $0 ~ /^\\// { last=$0 } $0 == "${NODE_PROBE_SENTINEL}" { found=1 } END { if (last) print last }')"
    emit_node "$p" "shell:$shell"
  done
}

p="$(command -v node 2>/dev/null || true)"
emit_node "$p" "path"

probe_login_shells

for p in \\
  /opt/homebrew/bin/node \\
  /usr/local/bin/node \\
  /usr/bin/node \\
  "$HOME"/.volta/bin/node \\
  "$HOME"/.local/bin/node \\
  "$HOME"/.nvm/current/bin/node \\
  "$HOME"/.nvm/versions/node/*/bin/node \\
  "$HOME"/.fnm/node-versions/*/installation/bin/node \\
  "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \\
  "$HOME"/.asdf/installs/nodejs/*/bin/node \\
  "$HOME"/.asdf/shims/node \\
  "$HOME"/.mise/shims/node \\
  "$HOME"/.local/share/mise/shims/node
do
  emit_node "$p" "candidate"
done

exit 127
`;

function spawnAndWait(spawn, command, args, opts = {}) {
  const { stdin, env, timeoutMs = NODE_PROBE_TIMEOUT_MS, runtime, role = "node-resolve" } = opts;
  return new Promise((resolve, reject) => {
    let child;
    const childOptions = {
      env: { ...process.env, LANG: "C", LC_ALL: "C", ...(env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };
    try {
      child = runtime && typeof runtime.spawnManagedTransportChild === "function"
        ? runtime.spawnManagedTransportChild({ role, tool: command, args, options: childOptions })
        : spawn(command, args, childOptions);
    } catch (err) {
      reject(err);
      return;
    }

    const managed = runtime && typeof runtime.spawnManagedTransportChild === "function";
    if (!managed && runtime && typeof runtime.registerChild === "function") {
      runtime.registerChild(child);
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let done = false;
    let exitCode = null;
    let exitSignal = null;
    let processError = null;
    let stdinError = null;
    let timedOut = false;
    let drainTimer = null;
    const timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      if (!managed) {
        try { child.kill(); } catch {}
      }
      drainTimer = setTimeout(() => {
        if (done) return;
        done = true;
        const err = Object.assign(new Error("Remote Node probe did not close after timeout"), {
          code: "transport_drain_timeout",
          timedOut: true,
          drainVerified: false,
          role,
        });
        if (managed && runtime && typeof runtime.invalidateManagedOperation === "function") {
          try { runtime.invalidateManagedOperation(err); } catch {}
          reject(err);
          return;
        }
        resolve({ code: exitCode, signal: exitSignal, stdout: "", stderr: err.message, timedOut: true, drainVerified: false });
      }, 5000);
    }, timeoutMs);

    function finish(payload) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      if (!managed && runtime && typeof runtime.unregisterChild === "function") {
        runtime.unregisterChild(child);
      }
      resolve(payload);
    }

    if (child.stdout) child.stdout.on("data", (d) => { stdoutChunks.push(d); });
    if (child.stderr) child.stderr.on("data", (d) => { stderrChunks.push(d); });

    child.on("error", (err) => { processError = err; });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.on("close", (code, signal) => {
      const stdout = decodeShellBytes(stdoutChunks);
      const stderr = decodeShellBytes(stderrChunks);
      if (managed && timedOut) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);
        const err = Object.assign(new Error("Remote Node probe exceeded its operation deadline"), {
          code: "transport_operation_timeout",
          timedOut: true,
          drainVerified: true,
          role,
        });
        if (runtime && typeof runtime.settleManagedTimeoutAfterClose === "function") {
          try { runtime.settleManagedTimeoutAfterClose(err); } catch {}
        }
        reject(err);
        return;
      }
      if (managed && runtime && typeof runtime.assertTransportActive === "function") {
        try {
          runtime.assertTransportActive();
        } catch (err) {
          done = true;
          clearTimeout(timer);
          if (drainTimer) clearTimeout(drainTimer);
          reject(err);
          return;
        }
      }
      finish({
        code: stdinError ? -1 : (exitCode === null ? code : exitCode),
        signal: exitSignal === null ? signal : exitSignal,
        stdout,
        stderr: stderr || (stdinError && `${stdinError.code || "stdin_write_failed"}: ${stdinError.message}`) || (processError && processError.message) || "",
        ...(stdinError ? { stdinError: true } : {}),
        ...(processError ? { spawnError: true } : {}),
      });
    });
    if (child.stdin) writeNodeFrameSafely(child, stdin, {
      onError: (err) => {
        if (done) return;
        stdinError = err;
        if (!managed) {
          try { child.kill(); } catch {}
        }
      },
    });
  });
}

function buildRemoteNodeProbeCommand(nodeBin = null, source = "cache") {
  const tail = isValidRemoteNodeBin(nodeBin)
    ? ` -- ${quoteForPosixShellArg(nodeBin)} ${quoteForPosixShellArg(String(source || "cache"))}`
    : "";
  return `sh -c ${quoteForPosixShellArg(NODE_PROBE_SCRIPT)}${tail}`;
}

function parseRemoteNodeProbeOutput(stdout) {
  const out = {
    nodeBin: null,
    version: null,
    source: null,
  };
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("CLAWD_REMOTE_NODE_BIN=")) {
      out.nodeBin = line.slice("CLAWD_REMOTE_NODE_BIN=".length);
    } else if (line.startsWith("CLAWD_REMOTE_NODE_VERSION=")) {
      out.version = line.slice("CLAWD_REMOTE_NODE_VERSION=".length);
    } else if (line.startsWith("CLAWD_REMOTE_NODE_SOURCE=")) {
      out.source = line.slice("CLAWD_REMOTE_NODE_SOURCE=".length);
    }
  }
  if (!isValidRemoteNodeBin(out.nodeBin) || !isSupportedRemoteNodeVersion(out.version)) {
    return null;
  }
  return out;
}

function isSupportedRemoteNodeVersion(value) {
  if (typeof value !== "string" || !/^v\d+/i.test(value)) return false;
  const major = Number.parseInt(value.slice(1).split(".")[0], 10);
  return Number.isInteger(major) && major >= MIN_REMOTE_NODE_MAJOR;
}

function isValidRemoteNodeBin(value, platform = "posix") {
  if (platform === "win32") return isWindowsAbsolutePath(value);
  return typeof value === "string"
    && platform === "posix"
    && value.startsWith("/")
    && !/[\x00-\x1f\x7f]/.test(value);
}

function remoteNodeCacheKey(profile) {
  if (!profile || typeof profile !== "object") return null;
  return JSON.stringify({
    host: profile.host || "",
    port: Number.isInteger(profile.port) ? profile.port : 22,
    identityFile: profile.identityFile || "",
    ...(profile.remotePlatform === "win32" ? { remotePlatform: "win32" } : {}),
  });
}

const remoteNodeCache = new Map();
const REMOTE_NODE_CACHE_INVALID = { invalid: true };

function getProfileRemoteNodeBin(profile) {
  if (!profile || typeof profile !== "object") return null;
  if (!isValidRemoteNodeBin(profile.detectedRemoteNodeBin, profile.remotePlatform || "posix")) return null;
  if (!isSupportedRemoteNodeVersion(profile.detectedRemoteNodeVersion)) return null;
  const out = {
    nodeBin: profile.detectedRemoteNodeBin,
    version: profile.detectedRemoteNodeVersion,
    source: typeof profile.detectedRemoteNodeSource === "string" && profile.detectedRemoteNodeSource
      ? profile.detectedRemoteNodeSource
      : "profile",
  };
  if (Number.isFinite(profile.detectedRemoteNodeAt) && profile.detectedRemoteNodeAt > 0) {
    out.detectedAt = profile.detectedRemoteNodeAt;
  }
  return out;
}

function clearRemoteNodeCache() {
  remoteNodeCache.clear();
}

function getCachedRemoteNodeBin(profile) {
  const key = remoteNodeCacheKey(profile);
  const cached = key ? remoteNodeCache.get(key) : null;
  if (cached === REMOTE_NODE_CACHE_INVALID) return null;
  if (cached) return cached;
  const persisted = getProfileRemoteNodeBin(profile);
  if (persisted && key) {
    remoteNodeCache.set(key, persisted);
  }
  return persisted;
}

function setCachedRemoteNodeBin(profile, result) {
  const key = remoteNodeCacheKey(profile);
  if (!key || !result || !isValidRemoteNodeBin(result.nodeBin, profile.remotePlatform || "posix")) return;
  if (!isSupportedRemoteNodeVersion(result.version)) return;
  remoteNodeCache.set(key, {
    nodeBin: result.nodeBin,
    version: result.version,
    source: result.source || "cache",
  });
}

function clearCachedRemoteNodeBin(profile) {
  const key = remoteNodeCacheKey(profile);
  if (!key) return;
  remoteNodeCache.set(key, REMOTE_NODE_CACHE_INVALID);
}

async function probeRemoteNodeBin({ profile, spawn, buildSshArgs, runtime, timeoutMs, nodeBin = null, source = "cache" }) {
  const command = buildRemoteNodeProbeCommand(nodeBin, source);
  const args = buildSshArgs(profile).concat([command]);
  const r = await spawnAndWait(spawn, "ssh", args, { runtime, timeoutMs });
  if (r.code !== 0) {
    const detail = summarizeStderr(r.stderr) || `ssh exited ${formatExit(r)}`;
    return {
      ok: false,
      code: r.code,
      signal: r.signal,
      stdout: r.stdout,
      stderr: r.stderr,
      message: detail ? `Remote Node.js not found (${detail})` : "Remote Node.js not found.",
    };
  }

  const parsed = parseRemoteNodeProbeOutput(r.stdout);
  if (!parsed) {
    return {
      ok: false,
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      message: "Remote Node.js probe returned an invalid result.",
    };
  }
  return { ok: true, ...parsed };
}

async function resolveRemoteNodeBin(options = {}) {
  const {
    profile,
    buildSshArgs,
    runtime,
    timeoutMs = NODE_PROBE_TIMEOUT_MS,
    useCache = true,
    verifyCache = false,
  } = options;
  const spawn = options.spawn || childProcess.spawn;

  if (!profile || typeof profile !== "object") {
    return { ok: false, step: "check-node", message: "Remote profile is missing." };
  }
  if (typeof buildSshArgs !== "function") {
    throw new Error("resolveRemoteNodeBin requires buildSshArgs");
  }

  if (profile.remotePlatform === "win32") {
    const cached = useCache ? getCachedRemoteNodeBin(profile) : null;
    if (cached && !verifyCache && typeof profile.detectedRemoteNodeBin === "string"
      && cached.nodeBin.toLowerCase() === profile.detectedRemoteNodeBin.toLowerCase()) {
      return { ok: true, ...cached, source: cached.source || "cache" };
    }
    const result = await discoverWindowsRemoteNode({ profile, spawn, buildSshArgs, runtime, timeoutMs });
    if (result.ok) setCachedRemoteNodeBin(profile, result);
    else clearCachedRemoteNodeBin(profile);
    return result.ok ? result : { ...result, step: "check-node" };
  }

  const cached = useCache ? getCachedRemoteNodeBin(profile) : null;
  if (cached) {
    if (!verifyCache) {
      return { ok: true, ...cached, source: cached.source || "cache" };
    }
    const verified = await probeRemoteNodeBin({
      profile,
      spawn,
      buildSshArgs,
      runtime,
      timeoutMs,
      nodeBin: cached.nodeBin,
      source: cached.source || "cache",
    });
    if (verified.ok) {
      setCachedRemoteNodeBin(profile, verified);
      return verified;
    }
    clearCachedRemoteNodeBin(profile);
  }

  const probed = await probeRemoteNodeBin({ profile, spawn, buildSshArgs, runtime, timeoutMs });
  if (probed.ok) setCachedRemoteNodeBin(profile, probed);
  return probed;
}

async function discoverWindowsRemoteNode(options) {
  const runFrame = options.runFrame || runRemoteNodeFrame;
  const result = await runFrame({ ...options, frame: buildNodeDiscoveryFrame(), mutation: false });
  let node;
  try { node = JSON.parse(String(result.stdout || "").trim().split(/\r?\n/).at(-1)); } catch {}
  if (result.code !== 0 || !node || node.platform !== "win32") {
    return { ok: false, step: "check-node", reason: "platform_changed", message: "Remote host is no longer a native Windows host." };
  }
  if (!isSupportedRemoteNodeVersion(node.version) || !isValidRemoteNodeBin(node.execPath, "win32")) {
    return { ok: false, step: "check-node", reason: "node_unavailable", hint: "remoteSshErrWindowsNodeMissing", message: "Windows remote hosts require Node.js 14 or newer and an absolute execPath." };
  }
  const expected = options.profile.detectedRemoteNodeBin;
  if (typeof expected !== "string" || node.execPath.toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, step: "check-node", reason: "windows_node_changed", hint: "remoteSshErrWindowsNodeChanged", message: "Remote Node execPath changed; probe the platform before deploying again." };
  }
  return { ok: true, nodeBin: node.execPath, version: node.version, source: "discovery", homedir: node.homedir, platform: node.platform };
}

function remoteHookPath(scriptName, hooksDir = null) {
  if (typeof scriptName !== "string" || !/^[a-zA-Z0-9._-]+$/.test(scriptName)) {
    throw new Error("remoteHookPath: unsafe script name");
  }
  if (hooksDir != null) {
    if (typeof hooksDir !== "string"
      || !hooksDir.startsWith("/")
      || /[\x00-\x1f\x7f]/.test(hooksDir)) {
      throw new Error("remoteHookPath: hooksDir must be an absolute POSIX path");
    }
    return quoteForPosixShellArg(`${hooksDir}/${scriptName}`);
  }
  return `"$HOME/.claude/hooks/${scriptName}"`;
}

function buildRemoteHookNodeCommand(nodeBin, scriptName, args = [], options = {}) {
  if (!isValidRemoteNodeBin(nodeBin)) {
    throw new Error("buildRemoteHookNodeCommand: nodeBin must be an absolute POSIX path");
  }
  const tail = Array.isArray(args) ? args : [];
  return [
    quoteForPosixShellArg(nodeBin),
    remoteHookPath(scriptName, options.hooksDir),
    ...tail.map((arg) => quoteForPosixShellArg(String(arg))),
  ].join(" ");
}

function buildRemoteNodeEvalCommand(nodeBin, js) {
  if (!isValidRemoteNodeBin(nodeBin)) {
    throw new Error("buildRemoteNodeEvalCommand: nodeBin must be an absolute POSIX path");
  }
  return `${quoteForPosixShellArg(nodeBin)} -e ${quoteForPosixShellArg(String(js))}`;
}

function summarizeStderr(text) {
  const t = (text || "").toString().trim();
  if (!t) return null;
  return t.length > 200 ? t.slice(0, 200) + "..." : t;
}

function formatExit(r) {
  if (r.signal) return `signal ${r.signal}`;
  return `code ${r.code == null ? "?" : r.code}`;
}

function runRemoteNodeFrame({ profile, spawn = childProcess.spawn, buildSshArgs, runtime, frame, timeoutMs }) {
  return spawnAndWait(spawn, "ssh", buildSshArgs(profile).concat([REMOTE_NODE_LAUNCH_COMMAND]), {
    runtime, stdin: frame, timeoutMs, role: "node-program",
  });
}

module.exports = {
  NODE_PROBE_TIMEOUT_MS,
  NODE_PROBE_SENTINEL,
  MIN_REMOTE_NODE_MAJOR,
  buildRemoteNodeProbeCommand,
  parseRemoteNodeProbeOutput,
  isValidRemoteNodeBin,
  isSupportedRemoteNodeVersion,
  clearRemoteNodeCache,
  clearCachedRemoteNodeBin,
  getProfileRemoteNodeBin,
  getCachedRemoteNodeBin,
  setCachedRemoteNodeBin,
  resolveRemoteNodeBin,
  discoverWindowsRemoteNode,
  buildRemoteHookNodeCommand,
  buildRemoteNodeEvalCommand,
  runRemoteNodeFrame,
  runRemoteNodeCommand: spawnAndWait,
};
