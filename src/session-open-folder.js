"use strict";

const fs = require("node:fs");
const path = require("node:path");

function createSessionFolderOpener(options = {}) {
  const getSession = options.getSession;
  const openPath = options.openPath;
  if (typeof getSession !== "function") throw new Error("createSessionFolderOpener requires getSession");
  if (typeof openPath !== "function") throw new Error("createSessionFolderOpener requires openPath");

  return async function openSessionFolder(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "sessionId must be a non-empty string" };
    }
    const session = getSession(sessionId);
    if (!session) return { status: "not-found" };
    if ((session.host && session.host !== "local") || session.platform === "webui") {
      return { status: "not-available", reason: "non-local-session" };
    }
    const cwd = session.cwd;
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
      return { status: "not-available", reason: "invalid-cwd" };
    }
    try {
      if (!(await fs.promises.stat(cwd)).isDirectory()) {
        return { status: "not-available", reason: "invalid-cwd" };
      }
    } catch (_err) {
      return { status: "not-available", reason: "invalid-cwd" };
    }
    try {
      const errorMessage = await openPath(cwd);
      if (errorMessage) return { status: "error", message: String(errorMessage) };
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: err && err.message ? err.message : String(err) };
    }
  };
}

module.exports = { createSessionFolderOpener };
