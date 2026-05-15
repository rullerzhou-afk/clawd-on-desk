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
  const { stdin, env, timeoutMs = NODE_PROBE_TIMEOUT_MS, runtime } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: { ...process.env, LANG: "C", LC_ALL: "C", ...(env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: -1, signal: null, stdout: "", stderr: (err && err.message) || "spawn failed", spawnError: true });
      return;
    }

    if (runtime && typeof runtime.registerChild === "function") {
      runtime.registerChild(child);
    }

    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill(); } catch {}
    }, timeoutMs);

    function finish(payload) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (runtime && typeof runtime.unregisterChild === "function") {
        runtime.unregisterChild(child);
      }
      resolve(payload);
    }

    if (child.stdout) child.stdout.on("data", (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d.toString(); });

    if (stdin != null && child.stdin) {
      try { child.stdin.end(stdin); } catch {}
    } else if (child.stdin) {
      try { child.stdin.end(); } catch {}
    }

    child.on("error", (err) => {
      finish({ code: -1, signal: null, stdout, stderr: stderr || (err && err.message) || "process error", spawnError: true });
    });
    child.on("exit", (code, signal) => {
      finish({ code, signal, stdout, stderr });
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

function isValidRemoteNodeBin(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && !/[\x00-\x1f\x7f]/.test(value);
}

function remoteNodeCacheKey(profile) {
  if (!profile || typeof profile !== "object") return null;
  return JSON.stringify({
    host: profile.host || "",
    port: Number.isInteger(profile.port) ? profile.port : 22,
    identityFile: profile.identityFile || "",
  });
}

const remoteNodeCache = new Map();
const REMOTE_NODE_CACHE_INVALID = { invalid: true };

function getProfileRemoteNodeBin(profile) {
  if (!profile || typeof profile !== "object") return null;
  if (!isValidRemoteNodeBin(profile.detectedRemoteNodeBin)) return null;
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
  if (!key || !result || !isValidRemoteNodeBin(result.nodeBin)) return;
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

function remoteHookPath(scriptName) {
  if (typeof scriptName !== "string" || !/^[a-zA-Z0-9._-]+$/.test(scriptName)) {
    throw new Error("remoteHookPath: unsafe script name");
  }
  return `"$HOME/.claude/hooks/${scriptName}"`;
}

function buildRemoteHookNodeCommand(nodeBin, scriptName, args = []) {
  if (!isValidRemoteNodeBin(nodeBin)) {
    throw new Error("buildRemoteHookNodeCommand: nodeBin must be an absolute POSIX path");
  }
  const tail = Array.isArray(args) ? args : [];
  return [
    quoteForPosixShellArg(nodeBin),
    remoteHookPath(scriptName),
    ...tail.map((arg) => quoteForPosixShellArg(String(arg))),
  ].join(" ");
}

function buildRemoteNodeEvalCommand(nodeBin, js) {
  if (!isValidRemoteNodeBin(nodeBin)) {
    throw new Error("buildRemoteNodeEvalCommand: nodeBin must be an absolute POSIX path");
  }
  return `${quoteForPosixShellArg(nodeBin)} -e ${JSON.stringify(String(js))}`;
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
  buildRemoteHookNodeCommand,
  buildRemoteNodeEvalCommand,
};
