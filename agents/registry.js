// Agent registry — loads all agent configs, provides lookup API
// Used by main.js for process detection and session tracking

const claudeCode = require("./claude-code");
const deepseekHarness = require("./deepseek-harness");
const codex = require("./codex");
const copilotCli = require("./copilot-cli");
const geminiCli = require("./gemini-cli");
const antigravityCli = require("./antigravity-cli");
const cursorAgent = require("./cursor-agent");
const codebuddy = require("./codebuddy");
const kiroCli = require("./kiro-cli");
const kimiCli = require("./kimi-cli");
const qwenCode = require("./qwen-code");
const zcode = require("./zcode");
const codewhale = require("./codewhale");
const opencode = require("./opencode");
const mimocode = require("./mimocode");
const pi = require("./pi");
const openclaw = require("./openclaw");
const hermes = require("./hermes");
const qoder = require("./qoder");
const reasonix = require("./reasonix");
const qoderwork = require("./qoderwork");
const qwenwork = require("./qwenwork");
const workbuddy = require("./workbuddy");

const AGENTS = [
  claudeCode,
  deepseekHarness,
  codex,
  copilotCli,
  geminiCli,
  antigravityCli,
  cursorAgent,
  codebuddy,
  kiroCli,
  kimiCli,
  qwenCode,
  zcode,
  codewhale,
  opencode,
  mimocode,
  pi,
  openclaw,
  hermes,
  qoder,
  reasonix,
  qoderwork,
  qwenwork,
  workbuddy,
];
const AGENT_MAP = new Map(AGENTS.map((a) => [a.id, a]));

function namesForPlatform(agent, field) {
  const namesByPlatform = agent[field] || {};
  const isWin = process.platform === "win32";
  const isLinux = process.platform === "linux";
  return isWin
    ? (namesByPlatform.win || [])
    : isLinux
      ? (namesByPlatform.linux || namesByPlatform.mac || [])
      : (namesByPlatform.mac || []);
}

function collectProcessNames(field) {
  const result = [];
  for (const agent of AGENTS) {
    const names = namesForPlatform(agent, field);
    for (const name of names) result.push({ name, agentId: agent.id });
  }
  return result;
}

module.exports = {
  getAllAgents: () => AGENTS,
  getAgent: (id) => AGENT_MAP.get(id),

  getAllProcessNames: () => collectProcessNames("processNames"),
  getStartupRecoveryProcessNames: () => collectProcessNames("startupRecoveryProcessNames"),
};
