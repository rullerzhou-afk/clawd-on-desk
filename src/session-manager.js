const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const SESSIONS_FILE = path.join(app.getPath("userData"), "ask-sessions.json");
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Clean up sessions older than 30 days
function cleanupOldSessions(data) {
  if (!data || !data.sessions) return data;

  const now = Date.now();
  const sessions = data.sessions;
  let cleaned = false;

  for (const cwd in sessions) {
    const session = sessions[cwd];
    // Check if session has messages with timestamps
    if (session.messages && session.messages.length > 0) {
      // Find the last message timestamp
      let lastTimestamp = 0;
      for (const msg of session.messages) {
        if (msg.timestamp && msg.timestamp > lastTimestamp) {
          lastTimestamp = msg.timestamp;
        }
      }

      // If we found a timestamp and it's older than 30 days, delete the session
      if (lastTimestamp > 0 && (now - lastTimestamp) > THIRTY_DAYS_MS) {
        delete sessions[cwd];
        cleaned = true;
      }
    }
    // Also check lastActive as fallback
    else if (session.lastActive && (now - session.lastActive) > THIRTY_DAYS_MS) {
      delete sessions[cwd];
      cleaned = true;
    }
  }

  if (cleaned) {
    console.log("Cleaned up old sessions");
  }

  return data;
}

// Load all sessions from disk
function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) {
      return { sessions: {}, lastCwd: process.cwd() };
    }
    const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
    let data = JSON.parse(raw);
    // Validate structure
    if (!data || typeof data !== "object" || !data.sessions) {
      return { sessions: {}, lastCwd: process.cwd() };
    }
    // Clean up old sessions on load
    data = cleanupOldSessions(data);
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
  // Add timestamp to messages if not present
  const timestampedMessages = messages.map(msg => {
    if (!msg.timestamp) {
      return { ...msg, timestamp: Date.now() };
    }
    return msg;
  });
  data.sessions[cwd] = {
    cwd,
    messages: timestampedMessages,
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
  cleanupOldSessions,
};
