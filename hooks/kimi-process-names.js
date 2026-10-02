"use strict";

// Hook-local source of truth: WSL/manual payloads contain hooks/ but no
// agents/ tree. Keep runtime process matching inside the deployable closure
// and let the registry consume the same immutable value.

// Kimi Code sets process.title = "kimi-code" at startup (since 0.10.0). On
// macOS and Linux that renames the process, but libuv writes the title over
// the original argv and cuts it to fit, so the name `ps` reports depends on how
// long the launch command was: `kimi` stays "kimi", `kimi -c` becomes
// "kimi-co", and `kimi --yolo` or a full-path launch "kimi-code" (0.42.0,
// macOS; Linux gets the same cut name through prctl). Every cut is listed, so
// one flag more or less does not decide whether Clawd sees the agent. Only a
// launch command shorter than `kimi` (a bare symlink `k`) cuts the title below
// `kimi` and goes unrecognized; `k -c` already shows "kimi".
// "kimi" is also the legacy Python CLI. The TUI runs the agent engine
// in-process, so the retitled process is the one that spawns the hooks and it
// lives for the whole session. On Windows the title only changes the console
// title: the image stays kimi.exe (native build) or node.exe (npm build).
const KIMI_CODE_POSIX_NAMES = Object.freeze([
  "kimi", "kimi-", "kimi-c", "kimi-co", "kimi-cod", "kimi-code",
]);

// The pid resolver compares lowercased basenames, so every entry must be
// lowercase. "kimi code" is the macOS desktop app (Kimi Code.app), whose main
// process runs the agent server and spawns the hooks itself.
const KIMI_PROCESS_NAMES = Object.freeze({
  mac: Object.freeze([...KIMI_CODE_POSIX_NAMES, "kimi code"]),
  linux: KIMI_CODE_POSIX_NAMES,
  win: Object.freeze(["kimi.exe"]),
});

// Only the CLI counts for startup recovery. The desktop app keeps running in
// the tray after its windows close, so its process says nothing about active
// work (same rule as the other desktop apps in the registry).
const KIMI_STARTUP_RECOVERY_PROCESS_NAMES = Object.freeze({
  mac: KIMI_CODE_POSIX_NAMES,
  linux: KIMI_CODE_POSIX_NAMES,
  win: Object.freeze(["kimi.exe"]),
});

// Kimi Code under a node image name (the npm build on Windows) is recognized
// by its package directory, @moonshot-ai/kimi-code, where its `kimi` bin has
// pointed since the first release. A bare "kimi" elsewhere in a command line (a
// project folder, an argument) does not identify it: matching that made any
// node ancestor that mentions kimi the agent whenever Kimi itself went
// unrecognized. The check reads the whole command line, so a node process that
// only passes a file inside the package directory as an argument (say
// `node relay.js --config ...\@moonshot-ai\kimi-code\config.json`) matches too;
// the resolver reaches it only when no nearer Kimi process was recognized, and
// no known real launch looks like that. Windows 8.3 short names: the npm, pnpm
// and yarn cmd shims write the package directory out in full, so a short name
// can only appear before it (C:\PROGRA~1\...) and does not affect the match. A
// command line that shortens the package directory itself (@MOONS~1\KIMI-C~1)
// is not recognized.
function isKimiAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  return cmd.toLowerCase().replace(/\\/g, "/").includes("/@moonshot-ai/kimi-code/");
}

module.exports = {
  KIMI_PROCESS_NAMES,
  KIMI_STARTUP_RECOVERY_PROCESS_NAMES,
  isKimiAgentCommandLine,
};
