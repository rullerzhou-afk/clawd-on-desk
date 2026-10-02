"use strict";

// Server-side half of the "no foreign process metadata" rule. A PID / HWND /
// process-tree field only names a process on the machine that reported it, so
// Clawd must never let another machine's numbers into local session state:
// liveness probes, session focus and the Windows process-chain paths would all
// point at whatever local process happens to share the number.
//
// Two request shapes are covered:
//   - Remote SSH (issue #916): a profile-bound request whose PID names a
//     process tree on the remote host. The secure plugins stop sending these
//     once they latch secure mode, but the ingress must not depend on a client
//     behaving.
//   - WSL: the hook runs inside the Linux VM and resolves PID / process-tree
//     fields with Linux `ps`, yet the request lands on the Windows Clawd over
//     loopback. Windows ignores the low two bits when opening a process, so a
//     Linux PID can alias an unrelated live Windows process — a false-positive
//     liveness result that deletes or retains sessions for the wrong reason.
//     WSL hooks mark the request with `wsl_distro` and/or `host: "wsl:<distro>"`.
//     See Raymond Chen, The Old New Thing, "Why does OpenProcess succeed even
//     when I add three to the process ID?" (2008-06-06),
//     https://devblogs.microsoft.com/oldnewthing/20080606-00/?p=22043 — an
//     NT handle-manager implementation detail, not a documented promise.
//
// Deliberately NOT stripped: `orcaPaneKey`, `cwd` and `host`. Those are opaque
// labels, not handles onto a local process — `orcaPaneKey` in particular is the
// one identifier the secure transport is still allowed to send. A Windows
// Terminal HWND is local-machine process metadata, so a remote value is never
// allowed to participate in focus or terminal-identity merging.
const REMOTE_STRIPPED_PROCESS_FIELDS = Object.freeze([
  "sourcePid",
  "wtHwnd",
  "agentPid",
  "pidChain",
  "editor",
  "tmuxSocket",
  "tmuxClient",
]);

const WSL_HOST_PREFIX = "wsl:";

// True when the request says it came from a WSL distro. Either marker alone is
// enough: `wsl_distro` is set by hooks/server-config.js applyWslSourceFields,
// and `host: "wsl:<distro>"` is set by the same helper and by clawd-hook.js.
function isWslSourced({ wslDistro, host } = {}) {
  if (typeof wslDistro === "string" && wslDistro.trim()) return true;
  return typeof host === "string" && host.startsWith(WSL_HOST_PREFIX);
}

// `remoteProfile` truthy means the request came through the Remote SSH ingress;
// `wslSourced` truthy means it carried a WSL marker. When neither applies the
// local path gets the very same object back, bit-for-bit what it was before
// this gate existed.
function stripRemoteProcessMetadata(fields, remoteProfile, wslSourced = false) {
  const source = fields && typeof fields === "object" ? fields : {};
  if (!remoteProfile && !wslSourced) return source;
  const stripped = { ...source };
  for (const key of REMOTE_STRIPPED_PROCESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) stripped[key] = null;
  }
  return stripped;
}

module.exports = {
  REMOTE_STRIPPED_PROCESS_FIELDS,
  isWslSourced,
  stripRemoteProcessMetadata,
};
