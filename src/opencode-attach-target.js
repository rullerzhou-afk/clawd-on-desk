"use strict";

const path = require("node:path");

function normalizeOpencodeAttachUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== "/") return null;
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    if (url.hostname === "[::]") url.hostname = "[::1]";
    // Only a locally reachable listener is supported in this Windows-first path.
    if (url.hostname !== "localhost" && url.hostname !== "[::1]"
      && !/^127(?:\.\d{1,3}){3}$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

function getOpencodeAttachTarget(session, platform = process.platform) {
  if (!session || platform !== "win32" || session.agentId !== "opencode"
    || session.opencodeAttachSource !== "opencode-plugin"
    || (session.profileId || "local") !== "local" || session.host || session.wslDistro
    || session.headless || session.state === "sleeping") return null;
  const url = normalizeOpencodeAttachUrl(session.opencodeAttachUrl);
  const id = typeof session.rawSessionId === "string"
    ? session.rawSessionId.replace(/^opencode:/, "") : "";
  const cwd = session.cwd;
  if (!url || !/^ses_[A-Za-z0-9]{1,128}$/.test(id) || typeof cwd !== "string"
    || cwd.length > 4096 || /[\u0000-\u001f\u007f]/u.test(cwd)
    || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(cwd)
    || !path.win32.isAbsolute(cwd)) return null;
  return { url, sessionId: id, cwd };
}

module.exports = { normalizeOpencodeAttachUrl, getOpencodeAttachTarget };
