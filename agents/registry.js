// Agent registry — loads all agent configs, provides lookup API
// Used by main.js for process detection and session tracking

const claudeCode = require("./claude-code");
const codex = require("./codex");
const copilotCli = require("./copilot-cli");
const geminiCli = require("./gemini-cli");
const cursorAgent = require("./cursor-agent");
const codebuddy = require("./codebuddy");
const kiroCli = require("./kiro-cli");

const AGENTS = [claudeCode, codex, copilotCli, geminiCli, cursorAgent, codebuddy, kiroCli];
const AGENT_MAP = new Map(AGENTS.map((a) => [a.id, a]));

module.exports = {
  getAllAgents: () => AGENTS,
  getAgent: (id) => AGENT_MAP.get(id),

  // Aggregate all agent process names for detectRunningAgentProcesses()
  getAllProcessNames: () => {
    const isWin = process.platform === "win32";
    const isLinux = process.platform === "linux";
    const result = [];
    for (const a of AGENTS) {
      const names = isWin
        ? a.processNames.win
        : isLinux
          ? (a.processNames.linux || a.processNames.mac)
          : a.processNames.mac;
      for (const n of names) result.push({ name: n, agentId: a.id });
    }
    return result;
  },
};
