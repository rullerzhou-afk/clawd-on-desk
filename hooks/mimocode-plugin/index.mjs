// Clawd on Desk — mimocode plugin (thin family entry)
//
// All runtime logic lives in the shared family core; this entry only binds
// the mimocode identity. The four params MUST match the "mimocode" entry in
// agents/opencode-family.js (locked by a registry cross-check test).
//
// #413: this module must have exactly ONE export — the default function.
// The opencode-derived plugin loader iterates Object.values() of THIS
// module's namespace and throws "Plugin export is not a function" on any
// non-function export, silently killing the plugin. Never add named exports
// here; test internals ride on the default function (mod.default.__test).
import { createOpencodeFamilyPlugin } from "../opencode-family-plugin/core.mjs";

export default createOpencodeFamilyPlugin({
  agentId: "mimocode",
  hookSource: "mimocode-plugin",
  logFileName: "mimocode-plugin.log",
  sessionIdPrefix: "mimocode:",
});
