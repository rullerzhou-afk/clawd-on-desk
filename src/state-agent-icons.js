"use strict";

const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

let nativeImage;
try { ({ nativeImage } = require("electron")); } catch { nativeImage = null; }

// Official logos from assets/icons/agents/.
const AGENT_ICON_DIR = path.join(__dirname, "..", "assets", "icons", "agents");
const AGENT_ICON_EXTENSIONS = [".png", ".svg"];
const _agentIconCache = new Map();
const _agentIconUrlCache = new Map();

function getAgentIconPath(agentId) {
  if (!agentId || typeof agentId !== "string") return null;
  if (!/^[a-z0-9._-]+$/i.test(agentId)) return null;
  for (const ext of AGENT_ICON_EXTENSIONS) {
    const iconPath = path.join(AGENT_ICON_DIR, `${agentId}${ext}`);
    if (fs.existsSync(iconPath)) return iconPath;
  }
  return null;
}

function getAgentIcon(agentId) {
  if (!nativeImage || !agentId) return undefined;
  if (_agentIconCache.has(agentId)) return _agentIconCache.get(agentId);
  const iconPath = getAgentIconPath(agentId);
  if (!iconPath) return undefined;
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  _agentIconCache.set(agentId, icon);
  return icon;
}

function getAgentIconUrl(agentId) {
  if (!agentId) return null;
  if (_agentIconUrlCache.has(agentId)) return _agentIconUrlCache.get(agentId);
  const iconPath = getAgentIconPath(agentId);
  const iconUrl = iconPath ? pathToFileURL(iconPath).href : null;
  _agentIconUrlCache.set(agentId, iconUrl);
  return iconUrl;
}

module.exports = {
  AGENT_ICON_DIR,
  AGENT_ICON_EXTENSIONS,
  getAgentIconPath,
  getAgentIcon,
  getAgentIconUrl,
};
