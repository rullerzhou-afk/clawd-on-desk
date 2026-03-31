const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const SESSIONS_FILE = path.join(app.getPath("userData"), "ask-sessions.json");

// Load all sessions from disk
function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) {
      return { sessions: {}, lastCwd: process.cwd() };
    }
    const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
    const data = JSON.parse(raw);
    // Validate structure
    if (!data || typeof data !== "object" || !data.sessions) {
      return { sessions: {}, lastCwd: process.cwd() };
    }
    return data;
  } catch (err) {
    console.error("Failed to load sessions:", err);
    return { sessions: {}, lastCwd: process.cwd() };
  }
}

// Save all sessions to disk
function saveSessions(data) {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("Failed to save sessions:", err);
    return false;
  }
}

// Get session for a specific workspace
function getSession(cwd) {
  const data = loadSessions();
  return data.sessions[cwd] || { cwd, messages: [], lastActive: Date.now() };
}

// Save session for a specific workspace
function saveSession(cwd, messages) {
  const data = loadSessions();
  data.sessions[cwd] = {
    cwd,
    messages,
    lastActive: Date.now(),
  };
  data.lastCwd = cwd;
  return saveSessions(data);
}

// Get last active workspace
function getLastCwd() {
  const data = loadSessions();
  // Default to clawd-on-desk directory (project root)
  const defaultCwd = path.join(__dirname, "..");
  return data.lastCwd || defaultCwd;
}

// Validate workspace path
function isValidWorkspace(cwd) {
  try {
    return fs.existsSync(cwd) && fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

module.exports = {
  loadSessions,
  saveSessions,
  getSession,
  saveSession,
  getLastCwd,
  isValidWorkspace,
};
