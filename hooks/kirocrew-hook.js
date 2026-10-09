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

const { buildKiroCrewHookPayload } = require("./kirocrew-hook-payload");

if (require.main === module) {
  const { postStateToRunningServer, readHostPrefix } = require("./server-config");
  const { readStdinJson } = require("./shared-process");
  readStdinJson()
    .then((payload) => {
      const body = buildKiroCrewHookPayload(payload, {
        eventName: process.env.KIROCREW_HOOK_EVENT,
        // The gateway cwd is its own process cwd, not the chat's project root.
        // Do not forward it as session attribution.
        remoteHostPrefix: process.env.CLAWD_REMOTE ? readHostPrefix() : null,
      });
      if (!body) {
        process.exit(0);
        return;
      }
      // Short timeout: a hook must not slow the gateway's turn. If the pet is
      // not running, the post simply fails and we still exit 0.
      postStateToRunningServer(JSON.stringify(body), { timeoutMs: 150 }, () => {
        process.exit(0);
      });
    })
    .catch(() => process.exit(0));
}

module.exports = { buildKiroCrewHookPayload };
