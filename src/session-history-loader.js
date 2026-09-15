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
const { loadSessionHistory } = require("../hooks/session-history");
const { normalizeClaudeSessionId } = require("../hooks/claude-session-id");

const DEFAULT_HISTORY_LIMIT = 25;

// Claude Code stores transcripts at
//   ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl
// where the encoding replaces every character outside [A-Za-z0-9-] with "-".
// The mapping is lossy and therefore one-way, which is all a lookup needs.
function encodeClaudeProjectDir(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

function getClaudeProjectsDir(options = {}) {
  if (typeof options.claudeProjectsDir === "string" && options.claudeProjectsDir) {
    return path.resolve(options.claudeProjectsDir);
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return path.join(configDir || path.join(os.homedir(), ".claude"), "projects");
}

/**
 * Does Claude Code still hold a transcript for this row?
 *
 * Deliberately fails open. The directory layout above is Claude Code's private
 * detail, so an unrecognized shape must read as "unknown", never as "gone" —
 * hiding a session the user could actually resume is the worse error. Only a
 * present project directory with the transcript absent is a confident no.
 *
 * Returns true (present), false (confidently missing), or null (unknown).
 */
function probeTranscript(agentId, sessionId, cwd, options = {}) {
  if (agentId !== "claude-code") return null;
  try {
    if (!sessionId || normalizeClaudeSessionId(sessionId) !== sessionId) return null;
  } catch { return null; }
  const dirName = encodeClaudeProjectDir(cwd);
  if (!dirName) return null;
  const projectDir = path.join(getClaudeProjectsDir(options), dirName);
  try {
    const stat = fs.lstatSync(projectDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch {
    return null; // no such project dir — cannot tell, so do not claim.
  }
  try {
    const transcript = path.join(projectDir, `${sessionId}.jsonl`);
    const stat = fs.lstatSync(transcript);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
  } catch (err) {
    return err && err.code === "ENOENT" ? false : null;
  }
}

/**
 * History rows ready for the Dashboard's resume list.
 *
 * Sessions already present in the live snapshot are filtered out: the
 * Dashboard shows those in its own list, and offering "resume" for a
 * conversation that is running would invite a duplicate process.
 */
function loadResumableSessionHistory(options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_HISTORY_LIMIT;
  const activeRawSessionIds = options.activeRawSessionIds instanceof Set
    ? options.activeRawSessionIds
    : new Set();

  // Over-read, because the active filter below removes rows after ranking.
  const records = loadSessionHistory({ ...options, limit: limit + activeRawSessionIds.size });

  const rows = [];
  for (const record of records) {
    if (activeRawSessionIds.has(record.sessionId)) continue;
    const transcript = probeTranscript(record.agentId, record.sessionId, record.cwd, options);
    rows.push({
      agentId: record.agentId,
      sessionId: record.sessionId,
      cwd: record.cwd,
      title: record.title,
      lastState: record.lastState,
      firstSeenAt: record.firstSeenAt,
      lastEventAt: record.lastEventAt,
      endedAt: record.endedAt,
      interrupted: record.interrupted,
      // null means "could not determine" — the row is still offered.
      transcriptPresent: transcript,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

/**
 * Resolve a resume request coming from the Dashboard back to a trusted row.
 *
 * The renderer sends only an agent id and session id. Everything the launcher
 * acts on — above all the working directory — is read back from the store here
 * rather than taken from the message, so a renderer cannot choose the folder a
 * session is relaunched in.
 */
function resolveResumeTarget(agentId, sessionId, options = {}) {
  if (agentId !== "claude-code" || typeof sessionId !== "string") return null;
  try {
    if (!sessionId || normalizeClaudeSessionId(sessionId) !== sessionId) return null;
  } catch { return null; }
  const records = loadSessionHistory({ ...options, limit: undefined });
  const match = records.find(
    (record) => record.agentId === agentId && record.sessionId === sessionId,
  );
  if (!match) return null;
  if (!match.cwd || !path.isAbsolute(match.cwd)) return null;
  try {
    const stat = fs.lstatSync(match.cwd);
    if (!stat.isDirectory()) return null;
  } catch {
    return null; // the project folder is gone; resuming there would fail anyway.
  }
  return { agentId: match.agentId, sessionId: match.sessionId, cwd: match.cwd };
}

module.exports = {
  DEFAULT_HISTORY_LIMIT,
  encodeClaudeProjectDir,
  getClaudeProjectsDir,
  probeTranscript,
  loadResumableSessionHistory,
  resolveResumeTarget,
};
