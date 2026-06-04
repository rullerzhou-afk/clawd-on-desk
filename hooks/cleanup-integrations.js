#!/usr/bin/env node
"use strict";

const os = require("os");
const path = require("path");

const { unregisterHooks: unregisterClaudeHooks } = require("./install");
const { unregisterGeminiHooks } = require("./gemini-install");
const { unregisterAntigravityHooks } = require("./antigravity-install");
const { unregisterCursorHooks } = require("./cursor-install");
const { unregisterCopilotHooks } = require("./copilot-install");
const { unregisterCodeBuddyHooks } = require("./codebuddy-install");
const { unregisterKiroHooks } = require("./kiro-install");
const { unregisterKimiHooks } = require("./kimi-install");
const { unregisterQwenCodeHooks } = require("./qwen-code-install");
const { unregisterCodexCommandHooks } = require("./codex-install-utils");
const { unregisterOpencodePlugin } = require("./opencode-install");
const { unregisterPiExtension } = require("./pi-install");
const { unregisterOpenClawPlugin } = require("./openclaw-install");
const { resolveHermesHome, unregisterHermesPlugin } = require("./hermes-install");
const { unregisterQoderHooks } = require("./qoder-install");

const CODEX_MARKERS = ["codex-hook.js", "codex-debug-hook.js"];

const MANAGED_AGENT_IDS = Object.freeze([
  "claude-code",
  "gemini-cli",
  "antigravity-cli",
  "cursor-agent",
  "copilot-cli",
  "codebuddy",
  "kiro-cli",
  "kimi-cli",
  "qwen-code",
  "codex",
  "opencode",
  "pi",
  "openclaw",
  "hermes",
  "qoder",
]);

const AGENT_DISPLAY_NAMES = Object.freeze({
  "claude-code": "Claude Code",
  "gemini-cli": "Gemini CLI",
  "antigravity-cli": "Antigravity CLI",
  "cursor-agent": "Cursor Agent",
  "copilot-cli": "GitHub Copilot CLI",
  codebuddy: "CodeBuddy",
  "kiro-cli": "Kiro CLI",
  "kimi-cli": "Kimi Code CLI",
  "qwen-code": "Qwen Code",
  codex: "Codex CLI",
  opencode: "opencode",
  pi: "Pi",
  openclaw: "OpenClaw",
  hermes: "Hermes Agent",
  qoder: "Qoder",
});

function normalizeHomeDir(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : os.homedir();
  return path.resolve(raw);
}

function buildTargetEnv(homeDir, options = {}) {
  const env = { ...((options.env && typeof options.env === "object") ? options.env : process.env) };
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  if (typeof options.hermesHome === "string" && options.hermesHome.trim()) {
    env.HERMES_HOME = path.resolve(options.hermesHome);
  } else if (options.ignoreInheritedHermesHome) {
    delete env.HERMES_HOME;
  }
  if ((options.platform || process.platform) === "win32") {
    env.LOCALAPPDATA = options.localAppData || path.join(homeDir, "AppData", "Local");
    env.APPDATA = options.appData || path.join(homeDir, "AppData", "Roaming");
  }
  return env;
}

function resolveCopilotHomeForCleanup(homeDir, env, options = {}) {
  if (typeof options.copilotHome === "string" && options.copilotHome.trim()) {
    return options.copilotHome.trim();
  }
  if (env && typeof env.COPILOT_HOME === "string" && env.COPILOT_HOME.trim()) {
    return env.COPILOT_HOME.trim();
  }
  return path.join(homeDir, ".copilot");
}

function buildCleanupOptionsForHome(homeDirInput, options = {}) {
  const explicitHomeDir = Boolean(homeDirInput || options.homeDir || options.userHome);
  const homeDir = normalizeHomeDir(homeDirInput || options.homeDir || options.userHome);
  const env = buildTargetEnv(homeDir, {
    ...options,
    ignoreInheritedHermesHome: explicitHomeDir && !options.hermesHome,
  });
  const backup = options.backup !== false;
  const silent = options.silent !== false;
  const common = { backup, silent };
  const copilotHome = resolveCopilotHomeForCleanup(homeDir, env, options);
  const openClawStateDir = options.openClawStateDir
    || env.OPENCLAW_STATE_DIR
    || path.join(homeDir, ".openclaw");
  const openClawConfigPath = options.openClawConfigPath
    || env.OPENCLAW_CONFIG_PATH
    || path.join(openClawStateDir, "openclaw.json");
  const hermesHome = options.hermesHome
    || resolveHermesHome({ homeDir, env, platform: options.platform || process.platform });

  return {
    homeDir,
    env,
    common,
    byAgent: {
      "claude-code": {
        ...common,
        settingsPath: path.join(homeDir, ".claude", "settings.json"),
      },
      "gemini-cli": {
        ...common,
        settingsPath: path.join(homeDir, ".gemini", "settings.json"),
      },
      "antigravity-cli": {
        ...common,
        configPath: path.join(homeDir, ".gemini", "config", "hooks.json"),
      },
      "cursor-agent": {
        ...common,
        hooksPath: path.join(homeDir, ".cursor", "hooks.json"),
      },
      "copilot-cli": {
        ...common,
        copilotHome,
        env,
        hooksPath: path.join(copilotHome, "hooks", "hooks.json"),
      },
      codebuddy: {
        ...common,
        settingsPath: path.join(homeDir, ".codebuddy", "settings.json"),
      },
      "kiro-cli": {
        ...common,
        agentsDir: path.join(homeDir, ".kiro", "agents"),
      },
      "kimi-cli": {
        ...common,
        settingsPath: path.join(homeDir, ".kimi", "config.toml"),
      },
      "qwen-code": {
        ...common,
        settingsPath: path.join(homeDir, ".qwen", "settings.json"),
      },
      codex: {
        ...common,
        homeDir,
        hooksPath: path.join(homeDir, ".codex", "hooks.json"),
        markers: CODEX_MARKERS,
      },
      opencode: {
        ...common,
        configPath: path.join(homeDir, ".config", "opencode", "opencode.json"),
      },
      pi: {
        ...common,
        parentDir: path.join(homeDir, ".pi", "agent"),
      },
      openclaw: {
        ...common,
        env,
        stateDir: openClawStateDir,
        configPath: openClawConfigPath,
        useCliFallback: false,
      },
      hermes: {
        ...common,
        env,
        homeDir,
        hermesHome,
        hermesCommand: options.hermesCommand,
      },
      qoder: {
        ...common,
        settingsPath: path.join(homeDir, ".qoder", "settings.json"),
      },
    },
  };
}

const AGENT_CLEANERS = Object.freeze({
  "claude-code": unregisterClaudeHooks,
  "gemini-cli": unregisterGeminiHooks,
  "antigravity-cli": unregisterAntigravityHooks,
  "cursor-agent": unregisterCursorHooks,
  "copilot-cli": unregisterCopilotHooks,
  codebuddy: unregisterCodeBuddyHooks,
  "kiro-cli": unregisterKiroHooks,
  "kimi-cli": unregisterKimiHooks,
  "qwen-code": unregisterQwenCodeHooks,
  codex: unregisterCodexCommandHooks,
  opencode: unregisterOpencodePlugin,
  pi: unregisterPiExtension,
  openclaw: unregisterOpenClawPlugin,
  hermes: unregisterHermesPlugin,
  qoder: unregisterQoderHooks,
});

function removedCountFromResult(result) {
  if (!result || typeof result !== "object") return 0;
  if (typeof result.removed === "number") return result.removed;
  if (result.removed === true) return 1;
  return 0;
}

function changedFromResult(result) {
  if (!result || typeof result !== "object") return false;
  if (result.changed === true || result.updated === true || result.removed === true) return true;
  return removedCountFromResult(result) > 0;
}

function backupPathsFromResult(result) {
  if (!result || typeof result !== "object") return [];
  const paths = [];
  if (typeof result.backupPath === "string" && result.backupPath) paths.push(result.backupPath);
  if (Array.isArray(result.backupPaths)) {
    for (const backupPath of result.backupPaths) {
      if (typeof backupPath === "string" && backupPath) paths.push(backupPath);
    }
  }
  return paths;
}

function warningsFromResult(agentId, result) {
  const warnings = [];
  if (result && Array.isArray(result.warnings)) warnings.push(...result.warnings);
  return warnings;
}

function notesFromResult(agentId, result) {
  const notes = [];
  if (agentId === "kiro-cli" && result && result.retainedClawdAgent) {
    notes.push("Kiro clawd.json was retained; only Clawd hook entries were removed.");
  }
  return notes;
}

function cleanupIntegrations(options = {}) {
  const plan = buildCleanupOptionsForHome(options.homeDir || options.userHome, options);
  const agents = [];
  let entriesRemoved = 0;
  let agentsAffected = 0;
  let skipped = 0;
  let failed = 0;

  for (const agentId of MANAGED_AGENT_IDS) {
    const clean = AGENT_CLEANERS[agentId];
    const cleanOptions = plan.byAgent && plan.byAgent[agentId];
    const agent = {
      agentId,
      displayName: AGENT_DISPLAY_NAMES[agentId] || agentId,
      status: "pending",
      removed: 0,
      changed: false,
      backupPaths: [],
      warnings: [],
      notes: [],
      error: null,
      result: null,
    };

    try {
      if (!cleanOptions) {
        agent.status = "failed";
        agent.error = "Missing cleanup path overrides";
        failed++;
      } else if (typeof clean !== "function") {
        agent.status = "skipped";
        agent.error = "No cleaner registered";
        skipped++;
      } else {
        const result = clean(cleanOptions);
        const removed = removedCountFromResult(result);
        const changed = changedFromResult(result);
        agent.removed = removed;
        agent.changed = changed;
        agent.backupPaths = backupPathsFromResult(result);
        agent.warnings = warningsFromResult(agentId, result);
        agent.notes = notesFromResult(agentId, result);
        agent.result = result;
        if (changed || removed > 0) {
          agent.status = "applied";
          agentsAffected++;
        } else {
          agent.status = "skipped";
          skipped++;
        }
        entriesRemoved += removed;
      }
    } catch (err) {
      agent.status = "failed";
      agent.error = err && err.message ? err.message : String(err);
      failed++;
    }
    agents.push(agent);
  }

  return {
    mode: "apply",
    homeDir: plan.homeDir,
    agents,
    summary: {
      agentsChecked: agents.length,
      agentsAffected,
      entriesRemoved,
      skipped,
      failed,
    },
  };
}

function parseArgs(argv) {
  const options = { backup: true, silent: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") continue;
    if (arg === "--no-backup") {
      options.backup = false;
      continue;
    }
    if (arg === "--silent") {
      options.silent = true;
      continue;
    }
    if (arg === "--fail-open") {
      options.failOpen = true;
      continue;
    }
    if (arg === "--source") {
      options.source = argv[++i];
      continue;
    }
    if (arg === "--user-home" || arg === "--home" || arg === "--home-dir") {
      options.homeDir = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printResult(result) {
  console.log(`Clawd integration cleanup -> ${result.homeDir}`);
  for (const agent of result.agents) {
    const suffix = agent.error ? ` (${agent.error})` : "";
    console.log(`  ${agent.displayName}: ${agent.status}, removed=${agent.removed}${suffix}`);
    for (const warning of agent.warnings || []) {
      console.log(`    warning: ${warning}`);
    }
  }
  const summary = result.summary;
  console.log(
    `Summary: affected=${summary.agentsAffected}, removed=${summary.entriesRemoved}, skipped=${summary.skipped}, failed=${summary.failed}`
  );
}

if (require.main === module) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const result = cleanupIntegrations(options);
    if (!options.silent) printResult(result);
    if (result.summary.failed > 0 && !options.failOpen) process.exitCode = 1;
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    if (!options || !options.failOpen) process.exitCode = 1;
  }
}

module.exports = {
  AGENT_CLEANERS,
  AGENT_DISPLAY_NAMES,
  CODEX_MARKERS,
  MANAGED_AGENT_IDS,
  buildCleanupOptionsForHome,
  cleanupIntegrations,
  parseArgs,
};
