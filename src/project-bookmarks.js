"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const MAX_PROJECT_BOOKMARKS = 32;
const PROJECT_BOOKMARK_LAUNCH_MODES = Object.freeze(["folder", "terminal", "claude", "codex"]);
const BOOKMARK_FIELDS = new Set(["id", "name", "cwd", "launchMode"]);
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

function localAbsolutePath(value, platform) {
  if (typeof value !== "string" || !value || value.length > 2048 || CONTROL_CHARACTERS.test(value)) return null;
  // Never reinterpret a URL, a drive-relative path, UNC, or a device namespace.
  // Paths are not trimmed: leading/trailing spaces can belong to POSIX names.
  if (platform === "win32") {
    if (!/^[a-z]:[\\/]/i.test(value) || /[<>"|?*]/.test(value) || value.slice(2).includes(":")) return null;
    const normalized = path.win32.normalize(value);
    return normalized.length > path.win32.parse(normalized).root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
  }
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  const normalized = path.posix.normalize(value);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function normalizeProjectBookmark(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !BOOKMARK_FIELDS.has(key))) return null;
  if (typeof value.id !== "string" || value.id.length > 160 || CONTROL_CHARACTERS.test(value.id)
    || typeof value.name !== "string" || value.name.length > 160 || CONTROL_CHARACTERS.test(value.name)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const cwd = localAbsolutePath(value.cwd, options.platform || process.platform);
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id) || !name || name.length > 80
    || CONTROL_CHARACTERS.test(name) || !cwd
    || !PROJECT_BOOKMARK_LAUNCH_MODES.includes(value.launchMode)) return null;
  return { id, name, cwd, launchMode: value.launchMode };
}

function bookmarkKeys(bookmark, platform) {
  return [bookmark.id.toLowerCase(), bookmark.name.toLowerCase(),
    platform === "win32" ? bookmark.cwd.toLowerCase() : bookmark.cwd];
}

function normalizeProjectBookmarks(records, options = {}) {
  if (!Array.isArray(records)) return [];
  const platform = options.platform || process.platform;
  const seen = [new Set(), new Set(), new Set()];
  const bookmarks = [];
  // Both work and output are bounded, including corrupt persisted arrays.
  for (const value of records.slice(0, MAX_PROJECT_BOOKMARKS)) {
    const bookmark = normalizeProjectBookmark(value, { platform });
    if (!bookmark) continue;
    const keys = bookmarkKeys(bookmark, platform);
    if (keys.some((key, index) => seen[index].has(key))) continue;
    keys.forEach((key, index) => seen[index].add(key));
    bookmarks.push(bookmark);
  }
  return bookmarks;
}

function validateProjectBookmarks(records, options = {}) {
  if (!Array.isArray(records) || records.length > MAX_PROJECT_BOOKMARKS) {
    return { ok: false, code: "BOOKMARKS_INVALID", message: "Use an array of at most 32 project bookmarks." };
  }
  const normalized = normalizeProjectBookmarks(records, options);
  if (normalized.length !== records.length) {
    return { ok: false, code: "BOOKMARKS_INVALID", message: "Each bookmark needs a unique ID, name and local absolute folder, and a supported launch mode." };
  }
  return { ok: true, value: normalized };
}

function execFileAsync(file, args, options) {
  const { execFile } = require("node:child_process");
  return new Promise((resolve, reject) => execFile(file, args, options,
    (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
}

function createProjectBookmarkLauncher(deps = {}) {
  // prefs imports the pure normalizers. Loading a saved preference must not
  // load the launcher, process helpers or recovery/history runtime graph.
  const {
    buildTerminalCandidates, findClaudeCmd, launchClaudeSession,
    openTerminalAt, quoteForPowerShell, tryLaunch,
  } = require("./launch-claude");
  const fsApi = deps.fs || fs;
  const platform = typeof deps.platform === "function" ? deps.platform() : deps.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const runLookup = deps.execFileAsync || (deps.execFile
    ? (file, args, options) => new Promise((resolve, reject) => deps.execFile(file, args, options,
      (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })))
    : execFileAsync);
  const attemptLaunch = deps.tryLaunch || tryLaunch;
  const launchClaude = deps.launchClaudeSession || launchClaudeSession;
  const openTerminal = deps.openTerminalAt || openTerminalAt;

  async function stat(target) {
    return fsApi.promises && typeof fsApi.promises.stat === "function"
      ? fsApi.promises.stat(target) : fsApi.statSync(target);
  }

  async function executable(target) {
    const normalized = localAbsolutePath(target, platform);
    if (!normalized) return null;
    try {
      const info = await stat(normalized);
      if (!info.isFile()) return null;
      if (platform === "win32") {
        if (!/\.(exe|com|cmd|bat)$/i.test(normalized)) return null;
        // PowerShell delegates batch files to cmd.exe, which expands these
        // characters even inside quotes. Fail closed instead of changing the
        // installed CLI or relying on shell settings/delayed expansion.
        if (/\.(cmd|bat)$/i.test(normalized) && /[%!]/.test(normalized)) return null;
      } else if (fsApi.promises && typeof fsApi.promises.access === "function") {
        await fsApi.promises.access(normalized, fs.constants.X_OK);
      } else {
        fsApi.accessSync(normalized, fs.constants.X_OK);
      }
      return normalized;
    } catch { return null; }
  }

  async function findCodex() {
    if (deps.findCodexCmd) return executable(await deps.findCodexCmd(platform));
    let candidates = [];
    try {
      const result = await runLookup(platform === "win32" ? "where.exe" : "which", ["codex"], {
        encoding: "utf8", timeout: 5000, maxBuffer: 16384, windowsHide: true,
      });
      candidates = String(result.stdout || "").split(/\r?\n/).filter(Boolean);
    } catch {}
    if (platform === "win32") {
      // npm also exposes an extensionless POSIX shim on Windows.
      candidates = candidates.flatMap((candidate) => /\.(exe|com|cmd|bat)$/i.test(candidate)
        ? [candidate] : [candidate + ".exe", candidate + ".cmd", candidate + ".bat"]);
      candidates.sort((a, b) => Number(!/\.exe$/i.test(a)) - Number(!/\.exe$/i.test(b)));
      for (const key of ["APPDATA", "LOCALAPPDATA"]) {
        const base = (deps.env || process.env)[key];
        if (localAbsolutePath(base, platform)) candidates.push(pathApi.join(base, "npm", "codex.cmd"));
      }
    } else {
      const home = deps.homedir ? deps.homedir() : os.homedir();
      candidates.push(pathApi.join(home, ".local", "bin", "codex"),
        pathApi.join(home, ".npm-global", "bin", "codex"), "/usr/local/bin/codex");
    }
    for (const candidate of candidates.slice(0, 64)) {
      const resolved = await executable(candidate);
      if (resolved) return resolved;
    }
    return null;
  }

  async function findClaude() {
    const resolver = deps.findClaudeCmd || findClaudeCmd;
    const resolved = await resolver(platform, {
      execFileAsync: runLookup,
      existsSync: (candidate) => fsApi.existsSync(candidate),
    });
    // findClaudeCmd's legacy bare-name fallback is not availability evidence.
    return executable(resolved);
  }

  async function startCliTerminal(cli, cwd, guardedLaunch) {
    const candidates = platform === "win32" ? [
      // Direct spawn opens an independent console. The project directory is
      // passed through cwd, never interpolated into PowerShell source. No cmd,
      // EncodedCommand, dispatcher, install, prompt, or approval flags.
      { bin: "powershell.exe", args: ["-NoProfile", "-NoExit", "-Command", `& ${quoteForPowerShell(cli)}`] },
      { bin: "pwsh.exe", args: ["-NoProfile", "-NoExit", "-Command", `& ${quoteForPowerShell(cli)}`] },
    ] : buildTerminalCandidates(cli, [], platform, cwd);
    let lastError;
    for (const candidate of candidates) {
      const result = await guardedLaunch(candidate.bin, candidate.args, {
        detached: true, stdio: "ignore", windowsHide: false, cwd, shell: false,
        ...(candidate.extraOpts || {}),
      });
      if (result && result.code === "CANCELLED") return result;
      if (result && result.ok) return { ok: true, terminal: candidate.bin };
      lastError = result && result.error;
    }
    return { ok: false, error: lastError || new Error("No supported terminal could be opened.") };
  }

  function failure(code, message) { return { ok: false, code, message }; }

  async function launch(value, options = {}) {
    const cancelledResult = () => ({ ok: false, code: "CANCELLED" });
    let cancelled = false;
    function canLaunch() {
      try {
        // This guard is synchronous so there is no await between the fresh
        // owner/preference check and the native open/spawn operation.
        return options.canLaunch === undefined || (typeof options.canLaunch === "function" && options.canLaunch() === true);
      } catch { return false; }
    }
    function guardedLaunch(bin, args, launchOptions) {
      if (!canLaunch()) { cancelled = true; return Promise.resolve(cancelledResult()); }
      return attemptLaunch(bin, args, launchOptions);
    }
    const bookmark = normalizeProjectBookmark(value, { platform });
    if (!bookmark) return failure("BOOKMARK_INVALID", "This project bookmark is invalid.");
    if (!canLaunch()) return cancelledResult();
    try {
      const info = await stat(bookmark.cwd);
      if (!info.isDirectory()) return failure("FOLDER_UNAVAILABLE", "The saved project is not a folder.");
    } catch {
      return !canLaunch() ? cancelledResult() : failure("FOLDER_UNAVAILABLE", "The saved project folder is missing or inaccessible.");
    }
    if (!canLaunch()) return cancelledResult();
    try {
      if (bookmark.launchMode === "folder") {
        if (!deps.shell || typeof deps.shell.openPath !== "function") return failure("FOLDER_OPEN_FAILED", "The system file browser is unavailable.");
        if (!canLaunch()) return cancelledResult();
        const message = await deps.shell.openPath(bookmark.cwd);
        return message ? failure("FOLDER_OPEN_FAILED", String(message)) : { ok: true };
      }
      if (bookmark.launchMode === "terminal") {
        if (!canLaunch()) return cancelledResult();
        const result = await openTerminal(bookmark.cwd, { platform: () => platform, tryLaunch: guardedLaunch });
        if (cancelled) return cancelledResult();
        return result && result.ok ? result : failure("TERMINAL_UNAVAILABLE", result && result.message || "No supported terminal could be opened.");
      }
      const cli = bookmark.launchMode === "claude" ? await findClaude() : await findCodex();
      if (!canLaunch()) return cancelledResult();
      if (!cli) return failure("CLI_NOT_FOUND", `An available local ${bookmark.launchMode === "claude" ? "Claude Code" : "Codex"} CLI could not be found. Install it separately, then try again.`);
      let result;
      if (bookmark.launchMode === "claude") {
        let windowsAttempt;
        if (!canLaunch()) return cancelledResult();
        result = await launchClaude("normal", bookmark.cwd, undefined, {
          platform: () => platform,
          findClaudeCmd: async () => cli,
          // The existing Claude launcher consumes this dependency for every
          // candidate; one safe Windows attempt replaces its legacy cmd paths.
          tryLaunch: platform === "win32"
            ? () => windowsAttempt || (windowsAttempt = startCliTerminal(cli, bookmark.cwd, guardedLaunch))
            : guardedLaunch,
        });
        if (platform === "win32" && windowsAttempt && result && result.ok) {
          result = { ...result, terminal: (await windowsAttempt).terminal };
        }
      } else {
        result = await startCliTerminal(cli, bookmark.cwd, guardedLaunch);
      }
      if (cancelled || result && result.code === "CANCELLED") return cancelledResult();
      if (!result || !result.ok) return failure("TERMINAL_UNAVAILABLE", result && result.message || "No supported terminal could be opened.");
      // A detached terminal's spawn is observable; CLI authentication and
      // startup inside it are not. Do not call this a created Agent session.
      return { ok: true, terminal: result.terminal, launched: "terminal" };
    } catch (error) {
      if (!canLaunch()) return cancelledResult();
      return failure("LAUNCH_FAILED", error && error.message || "The project could not be opened.");
    }
  }

  // Construction/normalization never probes dependencies or launches anything.
  return { launch };
}

module.exports = {
  MAX_PROJECT_BOOKMARKS,
  PROJECT_BOOKMARK_LAUNCH_MODES,
  normalizeProjectBookmark,
  normalizeProjectBookmarks,
  validateProjectBookmarks,
  createProjectBookmarkLauncher,
};
