// ES module wrapper for process-tree.js
// Allows import from ES modules (like OpenCode plugin)

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const {
  walkProcessTree,
  TERMINAL_NAMES_WIN,
  TERMINAL_NAMES_MAC,
  SYSTEM_BOUNDARY_WIN,
  SYSTEM_BOUNDARY_MAC,
  EDITOR_MAP_WIN,
  EDITOR_MAP_MAC,
  CLAUDE_NAMES_WIN,
  CLAUDE_NAMES_MAC,
  OPENCODE_NAMES_WIN,
  OPENCODE_NAMES_MAC,
} = require("./process-tree.js");

export {
  walkProcessTree,
  TERMINAL_NAMES_WIN,
  TERMINAL_NAMES_MAC,
  SYSTEM_BOUNDARY_WIN,
  SYSTEM_BOUNDARY_MAC,
  EDITOR_MAP_WIN,
  EDITOR_MAP_MAC,
  CLAUDE_NAMES_WIN,
  CLAUDE_NAMES_MAC,
  OPENCODE_NAMES_WIN,
  OPENCODE_NAMES_MAC,
};
