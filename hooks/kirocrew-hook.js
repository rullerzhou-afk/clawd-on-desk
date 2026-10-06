#!/usr/bin/env node
// Clawd — KiroCrew gateway hook bridge.
//
// KiroCrew runs agents through a background MCP gateway and fires chat
// lifecycle hooks (AgentSpawn, UserPromptSubmit, PreToolUse, PostToolUse, Stop).
// Each hook runs a shell command with the hook-event JSON on stdin and
// KIROCREW_HOOK_EVENT in the environment. This script is that command: it maps
// the event onto a Clawd pet state and posts it to the running pet's local
// state server.
//
// Registered in ~/.kiro/crew/hooks.json by hooks/kirocrew-install.js.
//
// Attribution: the gateway is a long-lived background service, so there is no
// per-session CLI process in the pet's PID tree to resolve. State is posted
// host-tagged (the same shape the remote/CLAWD_REMOTE path uses) rather than
// with a source_pid, and all sessions are merged under a single pet session.
//
// Environment: a KiroCrew hook does NOT inherit the gateway's environment — it
// gets an allowlisted slice (PATH, HOME, TMPDIR, locale, TLS, KIROCREW_HOME).
// This script relies only on absolute paths resolved at require time plus the
// pet's own ~/.clawd/runtime.json port discovery, so it needs nothing extra.

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { readStdinJson } = require("./shared-process");

// KiroCrew hook event → { state, event } for the Clawd state machine.
const HOOK_MAP = {
  AgentSpawn:       { state: "idle",      event: "AgentSpawn" },
  UserPromptSubmit: { state: "thinking",  event: "UserPromptSubmit" },
  PreToolUse:       { state: "working",   event: "PreToolUse" },
  PostToolUse:      { state: "working",   event: "PostToolUse" },
  Stop:             { state: "attention", event: "Stop" },
};

// Resolve the event from stdin first, then the env var the gateway always sets.
function resolveEventName(payload) {
  const fromStdin =
    (payload && (payload.hook_event_name || payload.event || payload.Event)) || "";
  if (fromStdin) return fromStdin;
  return process.env.KIROCREW_HOOK_EVENT || "";
}

readStdinJson()
  .then((payload) => {
    const eventName = resolveEventName(payload);
    const mapped = HOOK_MAP[eventName];
    if (!mapped) {
      // Not an event we model (e.g. one of the six Kiro-agent-only triggers).
      // Never block: PreToolUse is the only event whose exit code can deny, and
      // an unmapped event is informational.
      process.exit(0);
      return;
    }

    const { state, event } = mapped;

    // KiroCrew hook stdin may carry a session id; the gateway merges many
    // sessions, so when absent fall back to a single "default" pet session.
    const sessionId =
      (payload && (payload.session_id || payload.sessionId)) || "default";
    const cwd = (payload && (payload.cwd || payload.working_directory)) || "";

    const body = {
      state,
      session_id: sessionId,
      event,
      agent_id: "kirocrew",
      // Host-tagged attribution: the background gateway has no PID in the pet's
      // process tree, so identify it the way remote sources are identified.
      host: readHostPrefix(),
    };
    if (cwd) body.cwd = cwd;

    // Short timeout: a hook must not slow the gateway's turn. If the pet is not
    // running, the post simply fails and we still exit 0 (never deny a tool).
    postStateToRunningServer(JSON.stringify(body), { timeoutMs: 150 }, () => {
      process.exit(0);
    });
  })
  .catch(() => process.exit(0));
