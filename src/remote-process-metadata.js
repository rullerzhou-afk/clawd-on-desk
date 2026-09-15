"use strict";

// Server-side half of the Remote SSH "no remote process metadata" rule
// (issue #916). The secure plugins stop sending PID / process-tree fields once
// they latch secure mode, but the ingress must not depend on a client behaving:
// a PID that arrived over a profile-bound request names a process tree on the
// *other* machine, and letting it into session state would point liveness
// probes, session focus and the Windows process-chain paths at whatever local
// process happens to share the number.
//
// Deliberately NOT stripped: `orcaPaneKey`, `cwd` and `host`. Those are opaque
// labels, not handles onto a local process — `orcaPaneKey` in particular is the
// one identifier the secure transport is still allowed to send.
const REMOTE_STRIPPED_PROCESS_FIELDS = Object.freeze([
  "sourcePid",
  "agentPid",
  "pidChain",
  "editor",
  "tmuxSocket",
  "tmuxClient",
]);

// `remoteProfile` truthy means the request came through the Remote SSH ingress.
// Local requests get the very same object back, so the local path stays
// bit-for-bit what it was before this gate existed.
function stripRemoteProcessMetadata(fields, remoteProfile) {
  const source = fields && typeof fields === "object" ? fields : {};
  if (!remoteProfile) return source;
  const stripped = { ...source };
  for (const key of REMOTE_STRIPPED_PROCESS_FIELDS) stripped[key] = null;
  return stripped;
}

module.exports = {
  REMOTE_STRIPPED_PROCESS_FIELDS,
  stripRemoteProcessMetadata,
};
