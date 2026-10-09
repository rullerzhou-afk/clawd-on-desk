"use strict";

// Main-process reader for the durable session history store.
//
// hooks/session-history.js owns the on-disk format and stays dependency-free
// so it can run inside a hook. This module adds the two things only the main
// process can know: which sessions are already on screen, and whether Claude
// Code still holds a transcript for a row we are about to offer to resume.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadSessionHistory, normalizeClaudeProfile } = require("../hooks/session-history");
const { normalizeClaudeSessionId } = require("../hooks/claude-session-id");
const { extractPromptTitle } = require("../hooks/cursor-session-title");

const DEFAULT_HISTORY_LIMIT = 25;

// Claude Code stores transcripts at
//   ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl
// where the encoding replaces every character outside [A-Za-z0-9-] with "-".
// The mapping is lossy and therefore one-way, which is all a lookup needs.
function encodeClaudeProjectDir(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

function getClaudeProjectsDir(profile, options = {}) {
  const normalizedProfile = normalizeClaudeProfile(profile);
  if (!normalizedProfile) return null;
  if (normalizedProfile.kind === "default") {
    if (typeof options.claudeProjectsDir === "string" && options.claudeProjectsDir) {
      return path.resolve(options.claudeProjectsDir);
    }
    return path.join(os.homedir(), ".claude", "projects");
  }
  return path.join(normalizedProfile.configDir, "projects");
}

/**
 * Does Claude Code still hold a transcript for this row?
 *
 * Deliberately fails open. The directory layout above is Claude Code's private
 * detail, so an unrecognized shape must read as "unknown", never as "gone" —
 * hiding a session the user could actually resume is the worse error.
 *
 * When the transcript is not in the recorded cwd's project directory — or the
 * cwd maps to no project directory at all — the session is still looked up by
 * id across the other project directories, because that is what
 * `claude --resume <id>` itself does; a worktree or moved checkout keeps a
 * resumable transcript under a different directory. "Confidently missing"
 * therefore means, per path: (a) the cwd's project directory exists, the
 * transcript is absent from it, and the cross-directory scan completed
 * without finding the id; (b) the cwd has no project directory and the scan
 * completed without finding the id — in that branch a miss still reads as
 * "unknown", because a moved checkout makes where the transcript should live
 * itself uncertain. An unreadable projects root or subdirectory keeps every
 * verdict at "unknown".
 *
 * Returns true (present), false (confidently missing), or null (unknown).
 */
function probeTranscript(agentId, sessionId, cwd, profile, options = {}, projectEntriesCache = null) {
  return locateTranscript(agentId, sessionId, cwd, profile, options, projectEntriesCache).present;
}

// Same verdict as probeTranscript, plus the path of the transcript that earned
// a "present" it: the file that passed the regular-file / not-a-symlink /
// non-empty check, in whichever project directory the lookup found it. The
// path is null unless present === true, so callers never read a file the probe
// did not vouch for.
function locateTranscript(agentId, sessionId, cwd, profile, options = {}, projectEntriesCache = null) {
  const unknown = { present: null, path: null };
  if (agentId !== "claude-code") return unknown;
  try {
    if (!sessionId || normalizeClaudeSessionId(sessionId) !== sessionId) return unknown;
  } catch { return unknown; }
  const dirName = encodeClaudeProjectDir(cwd);
  if (!dirName) return unknown;
  const projectsDir = getClaudeProjectsDir(profile, options);
  if (!projectsDir) return unknown;
  const projectDir = path.join(projectsDir, dirName);
  try {
    const stat = fs.lstatSync(projectDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return unknown;
  } catch {
    const located = findTranscriptAcrossProjects(projectsDir, sessionId, projectEntriesCache);
    return located.present === true ? located : unknown;
  }
  try {
    const transcript = path.join(projectDir, `${sessionId}.jsonl`);
    const stat = fs.lstatSync(transcript);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0) {
      return { present: true, path: transcript };
    }
    return { present: false, path: null };
  } catch (err) {
    if (!err || err.code !== "ENOENT") return unknown;
    return findTranscriptAcrossProjects(projectsDir, sessionId, projectEntriesCache);
  }
}

// `projectEntriesCache` lets one loadResumableSessionHistory pass share its
// directory listings instead of re-reading the filesystem per row: the
// projects root's subdirectories once, each subdirectory's file names once,
// and one shared file-name index, so a full 200-record miss scan costs
// ~1 readdir per directory regardless of how many records miss.
const TRANSCRIPT_INDEX_KEY = "\0transcript-index";

// Returns { present: true, path } when a verified copy is found,
// { present: false, path: null } when every project directory was scanned and
// the id is nowhere, or { present: null, path: null } when the scan cannot
// claim absence (the projects root, or one of its subdirectories, is
// unreadable — absence cannot be claimed from a scan that could not run or
// could not finish).
function findTranscriptAcrossProjects(projectsDir, sessionId, projectEntriesCache) {
  const cache = projectEntriesCache || new Map();
  const indexKey = projectsDir + TRANSCRIPT_INDEX_KEY;
  let index = cache.get(indexKey);
  if (index === undefined) {
    index = buildTranscriptIndex(projectsDir, cache);
    cache.set(indexKey, index);
  }
  if (!index) return { present: null, path: null };
  const dirs = index.files.get(`${sessionId}.jsonl`);
  if (!dirs) return { present: index.complete ? false : null, path: null };
  for (const dir of dirs) {
    // The name matches; verify it is a real transcript before claiming it.
    const candidate = path.join(dir, `${sessionId}.jsonl`);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0) {
        return { present: true, path: candidate };
      }
    } catch { /* keep scanning the other project directories */ }
  }
  return { present: null, path: null }; // named in the index, but no copy could be verified
}

// One pass over the projects root: every subdirectory's file names folded
// into Map<fileName, dirPath[]>. `complete` records whether every directory
// could be listed — an unreadable one means the scan cannot claim absence.
function buildTranscriptIndex(projectsDir, cache) {
  let subdirs = cache.get(projectsDir);
  if (subdirs === undefined) {
    try {
      subdirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name);
    } catch {
      subdirs = null;
    }
    cache.set(projectsDir, subdirs);
  }
  if (!subdirs) return null;
  let complete = true;
  const files = new Map();
  for (const name of subdirs) {
    const dir = path.join(projectsDir, name);
    let fileNames = cache.get(dir);
    if (fileNames === undefined) {
      try {
        fileNames = fs.readdirSync(dir);
      } catch {
        fileNames = null;
      }
      cache.set(dir, fileNames);
    }
    if (!fileNames) {
      complete = false;
      continue;
    }
    for (const fileName of fileNames) {
      const known = files.get(fileName);
      if (known) known.push(dir);
      else files.set(fileName, [dir]);
    }
  }
  return { files, complete };
}

/**
 * History rows ready for the Dashboard's resume list.
 *
 * Sessions already present in the live snapshot are filtered out: the
 * Dashboard shows those in its own list, and offering "resume" for a
 * conversation that is running would invite a duplicate process.
 *
 * Every stored record is probed, not just the first `limit`: the store keeps
 * up to 200 files and ranks them by recency, so records whose cwd never held
 * a transcript (daemon-born rows, vanished worktrees) must not be able to
 * crowd resumable sessions out of the visible list before the probe runs.
 * Rows split into two groups instead:
 *   - "confirmed": the transcript probe says present. These keep the recency
 *     ranking and fill the visible list up to `limit`.
 *   - "other": probe false, unknown, or a v1 profile that cannot be probed.
 *     Every one of them is still returned, behind the confirmed rows, for the
 *     Dashboard's collapsed group — the probe is a hint, never a gate.
 */
function loadResumableSessionHistory(options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_HISTORY_LIMIT;
  const activeRawSessionIds = options.activeRawSessionIds instanceof Set
    ? options.activeRawSessionIds
    : new Set();

  const records = loadSessionHistory({ ...options, limit: undefined });
  const projectEntriesCache = new Map();

  const confirmed = [];
  const other = [];
  // The transcript a row's probe verified, kept out of the returned object:
  // those rows travel over IPC to the Dashboard, and the path must not.
  const locatedPaths = new Map();
  for (const record of records) {
    if (activeRawSessionIds.has(record.sessionId)) continue;
    const profileVerified = record.version >= 2 && !!normalizeClaudeProfile(record.profile);
    const located = profileVerified
      ? locateTranscript(
        record.agentId, record.sessionId, record.cwd, record.profile, options, projectEntriesCache,
      )
      : { present: null, path: null };
    const transcript = located.present;
    const row = {
      agentId: record.agentId,
      sessionId: record.sessionId,
      historyKey: record.historyKey,
      cwd: record.cwd,
      title: record.title || null,
      lastState: record.lastState,
      firstSeenAt: record.firstSeenAt,
      lastEventAt: record.lastEventAt,
      endedAt: record.endedAt,
      interrupted: record.interrupted,
      // null means "could not determine" — the row is still offered.
      transcriptPresent: transcript,
      resumeDisabledReason: profileVerified ? null : "profile-unverified",
      // A row leads the visible list only when a resume from it can work:
      // the transcript must be present AND the recorded cwd must still exist
      // (resolveResumeTarget refuses vanished folders, so leading with them
      // would offer a resume that always fails). Rows that fail either check
      // still render, folded, with their button untouched.
      group: profileVerified && transcript === true && isExistingDirectory(record.cwd)
        ? "confirmed"
        : "other",
    };
    if (transcript === true) locatedPaths.set(row, located.path);
    (row.group === "confirmed" ? confirmed : other).push(row);
  }
  // Titles are read only for the rows that actually reach the Dashboard: the
  // confirmed head is capped at `limit` first, so a transcript outside the
  // visible list is never opened. "other" rows with a present transcript (the
  // cwd is gone but the file survives) are shown folded and still named; the
  // rest have no verified file to read.
  const visible = [...confirmed.slice(0, limit), ...other];
  for (const row of visible) {
    if (row.title) continue;
    if (row.transcriptPresent !== true) continue;
    const transcriptPath = locatedPaths.get(row);
    if (transcriptPath) row.title = extractTitleFromTranscript(transcriptPath);
  }
  return visible;
}

// resolveResumeTarget's folder check, shared with the confirmed grouping: a
// resume target must be an absolute path to a directory that still exists.
function isExistingDirectory(candidate) {
  if (typeof candidate !== "string" || !candidate || !path.isAbsolute(candidate)) return false;
  try {
    return fs.lstatSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Most sessions never carry a title in their hook payloads, so the resume
 * list shows opaque session ids. The first thing the user actually typed
 * names the session better than anything else clawd has: read it from the
 * transcript's head — a growing window with a hard cap, never the whole
 * file — and only for rows whose transcript the probe already confirmed,
 * because a vanished file has nothing to name. The prompt-to-title rule
 * is exactly the live one (extractPromptTitle): first non-empty line, no
 * title when that line is secret-shaped, capped at 40 chars.
 */
// Dashboard refreshes re-run extraction for the same unchanged files; the
// cache makes the second pass cost one stat per transcript. A null result is
// cached too: "could not name it" will not change until the file does.
const titleCache = new Map();

function clearTitleExtractionCache() {
  titleCache.clear();
}

function extractTitleFromTranscript(transcriptPath) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return null;
  }
  const cacheKey = `${stat.mtimeMs}:${stat.size}`;
  const cached = titleCache.get(transcriptPath);
  if (cached && cached.key === cacheKey) return cached.title;
  let title = null;
  try {
    title = readTitleFromTranscript(transcriptPath, stat.size);
  } catch {
    // Transcript lines are Claude Code's private shape; one malformed row
    // must never take the whole resume list down with it.
    title = null;
  }
  titleCache.set(transcriptPath, { key: cacheKey, title });
  return title;
}

function readTitleFromTranscript(transcriptPath, size) {
  let command = null; // first slash command, the fallback if no prompt is real
  for (const window of [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024]) {
    const read = Math.min(window, size);
    let text;
    let fd = null;
    try {
      fd = fs.openSync(transcriptPath, "r");
      const buf = Buffer.alloc(read);
      fs.readSync(fd, buf, 0, read, 0);
      text = buf.toString("utf8");
    } catch {
      return null;
    } finally {
      // A read error must not leak the descriptor it was opened with.
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* the read result decides */ }
      }
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a line cut off by the window, or a huge single record
      }
      if (!entry || entry.type !== "user" || entry.isMeta || entry.isSidechain) continue;
      const content = entry.message && entry.message.content;
      // A real tool result is a typed block in the content array; a user who
      // merely types the word "tool_result" is not one.
      if (Array.isArray(content)
        && content.some((part) => part && part.type === "tool_result")) continue;
      const raw = typeof content === "string" ? content
        : Array.isArray(content)
          ? (content.find((part) => part && part.type === "text") || {}).text || ""
          : "";
      const clean = String(raw).trim();
      const slash = clean.match(/^<command-message>([\w:-]+)/);
      if (slash) {
        if (!command) command = `/${slash[1]}`;
        continue;
      }
      if (clean.startsWith("<")) continue; // other machine-generated wrappers
      // The live prompt-title rule (extractPromptTitle): first non-empty line,
      // no title when that line is secret-shaped, capped at 40 chars. The
      // verdict is final — a secret opening line means "no safe name", not
      // "keep looking at later prompts".
      return extractPromptTitle(clean);
    }
    if (read >= size) return command; // whole file scanned, no plain prompt
  }
  return command; // head capped short of the file end; keep the command found
}

/**
 * Resolve a resume request coming from the Dashboard back to a trusted row.
 *
 * The renderer sends only an agent id and opaque history key. Everything the launcher
 * acts on — above all the working directory — is read back from the store here
 * rather than taken from the message, so a renderer cannot choose the folder a
 * session is relaunched in.
 */
function resolveResumeTarget(agentId, historyKey, options = {}) {
  if (agentId !== "claude-code" || typeof historyKey !== "string"
    || !/^[a-f0-9]{32}$/.test(historyKey)) return null;
  const records = loadSessionHistory({ ...options, limit: undefined });
  const match = records.find(
    (record) => record.agentId === agentId && record.historyKey === historyKey,
  );
  if (!match) return null;
  const profile = match.version >= 2 ? normalizeClaudeProfile(match.profile) : null;
  if (!profile) return null;
  if (!isExistingDirectory(match.cwd)) {
    return null; // the project folder is gone; resuming there would fail anyway.
  }
  return {
    agentId: match.agentId,
    sessionId: match.sessionId,
    historyKey: match.historyKey,
    cwd: match.cwd,
    profile,
  };
}

module.exports = {
  DEFAULT_HISTORY_LIMIT,
  encodeClaudeProjectDir,
  getClaudeProjectsDir,
  probeTranscript,
  loadResumableSessionHistory,
  clearTitleExtractionCache,
  resolveResumeTarget,
};
