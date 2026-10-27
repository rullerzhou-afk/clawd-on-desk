"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CLAWD_SERVER_ID, SERVER_PORTS, normalizeLocalPort } = require("../hooks/server-config");

// A restart preference only. Never used by clients or as liveness/ownership
// evidence. Production opts in through main.js; server tests default to no IO.
function hintPath(options) {
  return path.join(options.homeDir || os.homedir(), ".clawd", "local-server-port.json");
}
function normalizeHint(value) {
  const port = normalizeLocalPort(value);
  return port >= 1024 && !SERVER_PORTS.includes(port) ? port : null;
}
function readLocalServerPortHint(options = {}) {
  try {
    const file = hintPath(options);
    if (fs.statSync(file).size > 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && value.app === CLAWD_SERVER_ID ? normalizeHint(value.port) : null;
  } catch { return null; }
}
function writeLocalServerPortHint(port, options = {}) {
  const value = normalizeHint(port);
  if (!value) return false;
  const file = hintPath(options);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify({ app: CLAWD_SERVER_ID, port: value }), { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch {
    try { fs.unlinkSync(temp); } catch {}
    return false;
  }
}
module.exports = { readLocalServerPortHint, writeLocalServerPortHint };
