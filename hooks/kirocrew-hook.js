#!/usr/bin/env node
// Clawd — KiroCrew gateway hook bridge.
//
// KiroCrew runs agents through a background MCP gateway and fires chat
// lifecycle hooks. Each hook runs a shell command with the hook-event JSON on
// stdin and KIROCREW_HOOK_EVENT in the environment. This script is that
// command: it maps the event onto a Clawd pet state and posts it to the
// running pet's local state server.
//
// Registered in ~/.kiro/crew/hooks.json by hooks/kirocrew-install.js on four
// events: AgentSpawn, UserPromptSubmit, PostToolUse, Stop. PreToolUse is
// deliberately NOT used — see HOOK_MAP below.
//
// Session attribution: KiroCrew's hook stdin carries no `session_id`. It
// exposes `session_key` and, for a subagent, `parent_session_key`. The bridge
// reads these so each chat drives its own pet session instead of collapsing
// into one shared session. The gateway is a background service with no PID in
// the pet's process tree, so no source_pid is resolved; a `host` tag is sent
// only for a genuine remote (CLAWD_REMOTE), matching kiro-hook.js.
//
// Environment: a KiroCrew hook does NOT inherit the gateway's environment — it
// gets an allowlisted slice (PATH, HOME, TMPDIR, locale, TLS, KIROCREW_HOME).
// This script relies only on absolute paths resolved at require time plus the
// pet's own ~/.clawd/runtime.json port discovery, so it needs nothing extra.

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { readStdinJson } = require("./shared-process");
const resolveSessionId = require("./kirocrew-hook-session");

// KiroCrew hook event → { state, event } for the Clawd state machine.
// PreToolUse is intentionally absent: in KiroCrew a PreToolUse exit other than
// 0 or 2 denies the tool on the approval path, and the bridge's exit-0
// guarantee only holds after Node has started (a missing script, a stale node
// path, or a governance policy disabling script_hooks would all deny). The
// four events below only warn on failure and are enough to drive the pet.
const HOOK_MAP = {
  AgentSpawn:       { state: "idle",      event: "AgentSpawn" },
  UserPromptSubmit: { state: "thinking",  event: "UserPromptSubmit" },
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
      // Not an event we model (including PreToolUse and the Kiro-agent-only
      // triggers). Never block — exit 0 for every unmapped event.
      process.exit(0);
      return;
    }

    const { state, event } = mapped;

    const sessionId = resolveSessionId(payload);
    const cwd = (payload && (payload.cwd || payload.working_directory)) || "";

    const body = {
      state,
      session_id: sessionId,
      event,
      agent_id: "kirocrew",
    };
    if (cwd) body.cwd = cwd;
    // Tag a host only when this really is a remote source. kiro-hook.js adds
    // `host` only under CLAWD_REMOTE; sending it unconditionally files a local
    // gateway session as an SSH remote (sourceType: "ssh").
    if (process.env.CLAWD_REMOTE) body.host = readHostPrefix();

    // Short timeout: a hook must not slow the gateway's turn. If the pet is not
    // running, the post simply fails and we still exit 0 (never deny a tool).
    postStateToRunningServer(JSON.stringify(body), { timeoutMs: 150 }, () => {
      process.exit(0);
    });
  })
  .catch(() => process.exit(0));
