// Clawd on Desk — opencode v2 plugin entry (OpenCode 2.x, `plugins` config key)
//
// Thin per-agent entry over the shared family core, same split as the v1
// hooks/opencode-plugin/index.mjs. The v2 host loader requires a default-
// exported definition object `{ id, setup }` — a function export fails the
// loader schema — and the module must stay import-free of `@opencode/plugin`
// (bare `@opencode/...` specifiers fail to resolve without a plugin-local
// node_modules). Zero named exports; the literal identity params below are
// pinned by test/opencode-family-core.test.js drift locks.
//
// Registered by the installer under the v2 `plugins` key pointing at this
// directory inside the managed generation; the v1 entry keeps the legacy
// `plugin` key (docs/investigations/opencode-v2-e1-evidence.md).
import { createOpencodeFamilyPluginV2 } from "../opencode-family-plugin/core.mjs";

export default createOpencodeFamilyPluginV2({
  agentId: "opencode",
  hookSource: "opencode-plugin-v2",
  logFileName: "opencode-plugin-v2.log",
  sessionIdPrefix: "opencode:",
  pluginId: "clawd-on-desk-opencode",
  // Shared owner record marker (owner.json activeSourceMarker) still points at
  // the v1 entry directory — the inert gate must validate against it.
  markerPluginDirName: "opencode-plugin",
});
