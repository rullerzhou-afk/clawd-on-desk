const fs = require("fs");
const os = require("os");
const path = require("path");

// Codex memory consolidation runs in an internal, ephemeral thread
// (`SessionSource::Internal(MemoryConsolidation)`) whose cwd is pinned to
// <CODEX_HOME>/memories (v2: memories_v2). It writes no rollout, so its hook
// payload has no transcript_path, and openai/codex#40587 stopped forwarding
// its Stop to user-level hooks. The payload carries no thread_source /
// session source / thread_id either, which leaves "cwd under CODEX_HOME plus
// an empty transcript" as the only usable identity. Keep this helper
// dependency-free: codex-hook.js is deployed to dep-free remote hosts.
//
// This detector must never swallow a real session: a missed worker (a ghost
// row that lingers) is far cheaper than dropping live events, so the rules
// below stay deliberately narrow.
function resolveCodexHome(env, homedir, pathApi) {
  const configured = env && env.CODEX_HOME;
  // Codex treats only the empty string as unset and otherwise canonicalizes
  // the raw value. Do NOT trim here: a trailing space can be part of a
  // legitimate directory name, and trimming would fold two distinct homes
  // (e.g. ".../codex " and ".../codex") into a false match. Other helpers in
  // this repo trim CODEX_HOME; this one deliberately mirrors Codex instead.
  if (typeof configured === "string" && configured !== "") return configured;
  return pathApi.join(homedir, ".codex");
}

function stripTrailingSeparator(value, sep) {
  let out = value;
  while (out.length > 1 && out.endsWith(sep)) {
    const next = out.slice(0, -1);
    // Never reduce a root ("/") or a drive root ("C:\") to nothing.
    if (sep === "/" && next === "") break;
    if (sep === "\\" && /^[A-Za-z]:$/.test(next)) break;
    out = next;
  }
  return out;
}

function defaultRealpath(value) {
  const native = fs.realpathSync.native;
  if (typeof native === "function") return native(value);
  return fs.realpathSync(value);
}

// `fs.realpathSync.native` may return a Windows extended-length path
// (`\\?\C:\...`, `\\?\UNC\server\share\...`) on some Node/Windows versions.
// Strip that namespace prefix so the canonical path compares equal to the
// plain form. 8.3 short names are left alone: resolving those needs a system
// call this helper must not make.
function stripWindowsNamespacePrefix(value) {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function buildVariants(value, pathApi, sep, realpath, platform) {
  const variants = [];
  const push = (candidate) => {
    if (typeof candidate !== "string" || !candidate) return;
    // Codex may report a canonical verbatim path on Windows, so strip the
    // namespace prefix from the raw cwd too, not only from realpath output.
    const stripped = platform === "win32" ? stripWindowsNamespacePrefix(candidate) : candidate;
    const normalized = stripTrailingSeparator(pathApi.normalize(stripped), sep);
    if (normalized && !variants.includes(normalized)) variants.push(normalized);
  };
  push(value);
  if (typeof realpath === "function") {
    try {
      push(realpath(value));
    } catch {
      // A non-existent path (or an injected failure) falls back to the
      // resolved string form; the other side may still match it.
    }
  }
  return variants;
}

// Under POSIX a Windows-dialect path can never name the same file as the
// host's CODEX_HOME, so treat it as a miss instead of normalizing it into a
// bogus POSIX path. The reverse (POSIX path on win32) stays permissive
// because path.win32 treats a leading "/" as drive-relative.
function hasWindowsDialect(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.includes("\\");
}

// CODEX_HOME is canonicalized by the OS (symlinks first, then ".."), while the
// plain string join below collapses ".." first. Only a ".." segment makes the
// two diverge, and a divergence can point a real session's directory at the
// worker layout — so any ".." segment is an intentional miss. POSIX splits on
// "/"; win32 also accepts "\".
function hasParentSegment(value, platform) {
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  return value.split(separators).includes("..");
}

// A win32 root without a drive letter or UNC prefix ("/", "\foo", or the
// Git-Bash form "/c/Users/x/.codex") is resolved against the hook process's
// current drive, which need not be Codex's home drive. Never match those.
function hasWindowsDriveOrUnc(value) {
  return /^[A-Za-z]:/.test(value) || /^\\\\/.test(value) || /^\/\//.test(value);
}

function matchesAbsoluteHome(cwd, home, pathApi, sep, realpath, platform) {
  const fold = (value) => (platform === "win32" ? value.toLowerCase() : value);
  const cwdVariants = buildVariants(cwd, pathApi, sep, realpath, platform).map(fold);
  for (const dirName of ["memories", "memories_v2"]) {
    const candidate = pathApi.join(home, dirName);
    for (const variant of buildVariants(candidate, pathApi, sep, realpath, platform)) {
      if (cwdVariants.includes(fold(variant))) return true;
    }
  }
  return false;
}

function isCodexMemoryWorkerPayload(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  const cwd = payload.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) return false;

  // An internal worker never writes a rollout, so it never has a transcript.
  // A non-empty string, or any other non-null value, means this is not the
  // worker and must be left alone.
  const transcriptPath = payload.transcript_path;
  if (transcriptPath !== undefined && transcriptPath !== null) {
    if (typeof transcriptPath !== "string" || transcriptPath.trim()) return false;
  }

  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const realpath = options.realpath || defaultRealpath;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const sep = platform === "win32" ? "\\" : "/";

  // An internal worker's cwd is always canonical (or HOME/.codex/memories), so
  // it never contains ".."; dropping such events only ever spares a real
  // session.
  if (hasParentSegment(cwd, platform)) return false;
  if (platform !== "win32" && hasWindowsDialect(cwd)) return false;

  const home = resolveCodexHome(env, homedir, pathApi);
  // Deliberate miss: a ".." segment can make the string form and the
  // OS-canonicalized form point at different physical directories.
  if (hasParentSegment(home, platform)) return false;
  if (platform !== "win32" && hasWindowsDialect(home)) return false;
  if (!pathApi.isAbsolute(home)) return false;
  if (platform === "win32" && !hasWindowsDriveOrUnc(home)) return false;

  return matchesAbsoluteHome(cwd, home, pathApi, sep, realpath, platform);
}

// Codex Desktop's app-server runs ephemeral threads that write no rollout, so
// their hook payloads carry an empty transcript_path. It also sets
// CODEX_INTERNAL_ORIGINATOR_OVERRIDE for the app-server process, which Codex
// exports to hooks, while a terminal `codex` (or `codex exec --ephemeral`)
// does not. This is a precondition, not a drop rule: the user-visible side chat
// shares exactly these fields, so only the two fixed ambient-suggestion prompts
// below identify hidden work. An empty transcript plus that client-only
// variable is the usable signal for "client ephemeral thread".
function isCodexClientEphemeralPayload(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  // An ephemeral thread never writes a rollout. A non-empty string, or any
  // other non-null value, means this is not one and must be left alone.
  const transcriptPath = payload.transcript_path;
  if (transcriptPath !== undefined && transcriptPath !== null) {
    if (typeof transcriptPath !== "string" || transcriptPath.trim()) return false;
  }

  const env = options.env || process.env;
  const originator = env && env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  return typeof originator === "string" && originator.trim() !== "";
}

// Wire value the hook tags a recognized ambient-suggestion UserPromptSubmit
// with; the server keys its per-sid suppression set on it.
const CODEX_INTERNAL_THREAD_AMBIENT_SUGGESTIONS = "ambient_suggestions";

// The two fixed prompts Codex Desktop's ambient-suggestion workers submit (seen
// verbatim across many generation and safety-review threads). Only the prefixes
// are matched: if upstream rewrites the text, recognition simply stops and the
// thread regresses to "visible for about a minute, then retired by SessionEnd"
// rather than hiding the user's side chat.
const CODEX_AMBIENT_SUGGESTION_PROMPT_PREFIXES = Object.freeze([
  "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex",
  "You are an expert at upholding safety and compliance standards for Codex ambient suggestions",
]);

function isCodexAmbientSuggestionPrompt(prompt) {
  if (typeof prompt !== "string") return false;
  const trimmed = prompt.replace(/^\s+/, "");
  return CODEX_AMBIENT_SUGGESTION_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

module.exports = {
  CODEX_INTERNAL_THREAD_AMBIENT_SUGGESTIONS,
  isCodexAmbientSuggestionPrompt,
  isCodexClientEphemeralPayload,
  isCodexMemoryWorkerPayload,
};
