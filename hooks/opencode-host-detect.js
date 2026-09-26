"use strict";
// opencode host major-version detection (upstream PR #1045 review).
//
// opencode <= 1.18.15 REJECTS unknown top-level config keys
// ("Unrecognized key: plugins"), so the v2 `plugins`-key entry may only be
// written when a v2 host is actually present. Unknown top-level fields are
// ignored only since 1.18.16 (anomalyco/opencode#41312, 2026-08-08) — the
// real-machine evidence in docs/investigations/opencode-v2-e1-evidence.md
// probed 1.18.32, which sits just past that change, which is why the
// unconditional dual-key write looked safe.
//
// detectOpencodeHost() resolves the tri-state register mode:
//   "v2"      — `opencode --version` resolves to major >= 2: register the key.
//   "v1"      — a parsed 1.x host: never write the key (register sweeps
//               proven-owned leftovers instead).
//   "unknown" — binary missing / probe failed / unparseable output: fail safe,
//               never touch the key. A v2 machine with a transiently failed
//               probe keeps its existing registration untouched; only a first
//               registration is deferred until a later probe succeeds.
//
// Probing order mirrors hooks/pi-install.js: try the bare command first (a
// terminal-launched Clawd has the user's PATH), then a login shell so a
// GUI-launched Clawd still sees the user's real PATH; Windows resolves via
// `where`. Only Node builtins — this module must stay dep-free.

const childProcess = require("child_process");

const LOCATE_TIMEOUT_MS = 1500;
const VERSION_PROBE_TIMEOUT_MS = 5000;

// dsh-install parseDshVersion style: the first x.y.z token in the output,
// prerelease/build suffixes allowed. An optional lowercase "v" prefix is
// consumed ("opencode v2.0.15" is the real 2.x output — a bare \b before the
// digit would never match there, since v→2 is no word boundary), while a
// leading word character blocks the match so identifiers like "abc12.0.3"
// stay unparsed.
function parseOpencodeVersion(text) {
  const raw = String(text || "");
  if (!raw) return null;
  const match = raw.match(/(^|[^\w.])v?(\d+)\.(\d+)\.(\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/);
  if (!match) return null;
  const major = Number.parseInt(match[2], 10);
  if (!Number.isFinite(major)) return null;
  return {
    major,
    minor: Number.parseInt(match[3], 10),
    patch: match[4],
    raw: `${match[2]}.${match[3]}.${match[4]}`,
  };
}

// Some CLIs print the version on stderr or exit non-zero; a failed spawn must
// not lose whatever it printed.
function probeOutput(execFileImpl, command, args, timeoutMs, extraOptions = {}) {
  try {
    return String(execFileImpl(command, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, ...extraOptions }) || "");
  } catch (err) {
    const stdout = err && err.stdout ? String(err.stdout) : "";
    const stderr = err && err.stderr ? String(err.stderr) : "";
    if (!stdout && !stderr) return null;
    return `${stdout}\n${stderr}`;
  }
}

function firstNonEmptyLine(text) {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return line || null;
}

// Returns the raw --version output ("" when no probe produced a parseable
// version), so tests can inject `options.opencodeVersion` instead of a fake
// binary.
function probeVersionText(execFileImpl, platform) {
  const versionArgs = ["--version"];
  if (platform === "win32") {
    const whereOut = probeOutput(execFileImpl, "where", ["opencode"], LOCATE_TIMEOUT_MS);
    // npm also puts an extensionless POSIX shim on PATH. Windows cannot
    // execFile it, and .cmd/.bat launchers require cmd.exe (EINVAL otherwise).
    const bin = String(whereOut || "").split(/\r?\n/).map((line) => line.trim())
      .find((line) => /\.(?:exe|com|cmd|bat)$/i.test(line));
    if (!bin) return "";
    if (/\.(?:cmd|bat)$/i.test(bin)) {
      // Do not interpolate paths that cmd would expand or reinterpret.
      if (/["%\r\n]/.test(bin)) return "";
      return probeOutput(execFileImpl, process.env.ComSpec || "cmd.exe",
        ["/d", "/v:off", "/s", "/c", `""${bin}" --version"`], VERSION_PROBE_TIMEOUT_MS,
        { windowsVerbatimArguments: true }) || "";
    }
    return probeOutput(execFileImpl, bin, versionArgs, VERSION_PROBE_TIMEOUT_MS) || "";
  }
  const direct = probeOutput(execFileImpl, "opencode", versionArgs, VERSION_PROBE_TIMEOUT_MS);
  if (direct && parseOpencodeVersion(direct)) return direct;
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    const out = probeOutput(execFileImpl, shell, ["-lic", "opencode --version"], VERSION_PROBE_TIMEOUT_MS);
    if (out && parseOpencodeVersion(out)) return out;
  }
  return "";
}

function normalizeHostDetection(value) {
  return value === "v1" || value === "v2" || value === "unknown" ? value : null;
}

// Tri-state host verdict. Explicit overrides for tests and callers that
// already know the answer, in priority order:
//   - options.opencodeHostDetection: the verdict itself ("v1" | "v2" | "unknown")
//   - CLAWD_OPENCODE_HOST:           the same verdict via env — lets CLI-child
//                                    tests and remote/pinned deployments skip
//                                    the probe deterministically
//   - options.opencodeVersion:       raw `--version` output to parse
function detectOpencodeHost(options = {}) {
  const explicit = normalizeHostDetection(options.opencodeHostDetection)
    || normalizeHostDetection(process.env.CLAWD_OPENCODE_HOST);
  if (explicit) return explicit;

  const execFileImpl = options.execFile || childProcess.execFileSync;
  const platform = options.platform || process.platform;
  const versionText = typeof options.opencodeVersion === "string"
    ? options.opencodeVersion
    : probeVersionText(execFileImpl, platform);
  const version = parseOpencodeVersion(versionText);
  if (!version) return "unknown";
  return version.major >= 2 ? "v2" : "v1";
}

module.exports = {
  LOCATE_TIMEOUT_MS,
  VERSION_PROBE_TIMEOUT_MS,
  parseOpencodeVersion,
  detectOpencodeHost,
  __test: { probeOutput, firstNonEmptyLine, probeVersionText, normalizeHostDetection },
};
