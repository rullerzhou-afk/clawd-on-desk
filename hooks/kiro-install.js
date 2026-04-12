#!/usr/bin/env node
// Merge Clawd hooks into Kiro agent configs under ~/.kiro/agents/
// Kiro hooks are per-agent (no global hooks yet), so we inject into every
// custom agent config file and maintain a dedicated "clawd" agent config.
// Built-in agents are not backed by editable JSON files, so we cannot
// "override" kiro_default by creating ~/.kiro/agents/kiro_default.json.
// Users who want hooks must explicitly use the generated "clawd" agent.
// Docs: https://kiro.dev/docs/cli/hooks/
// Config reference: https://kiro.dev/docs/cli/custom-agents/configuration-reference/

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { resolveNodeBin } = require("./server-config");
const { writeJsonAtomic, extractExistingNodeBin } = require("./json-utils");
const MARKER = "kiro-hook.js";
const CLAWD_AGENT_NAME = "clawd";
const BUILTIN_DEFAULT_AGENT = "kiro_default";

const KIRO_HOOK_EVENTS = [
  "agentSpawn",
  "userPromptSubmit",
  "preToolUse",
  "postToolUse",
  "stop",
];

/**
 * Inject Clawd hooks into a single agent config file.
 * @param {string} filePath
 * @param {object} [options]
 * @returns {{ added: number, skipped: number, updated: number, created: boolean }}
 */
function injectHooksIntoFile(filePath, options = {}) {
  let settings = {};
  let created = false;
  try {
    settings = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read ${path.basename(filePath)}: ${err.message}`);
    }
    created = true;
  }

  let changed = false;
  const baseName = path.basename(filePath, ".json");

  // Ensure name field (required by Kiro).
  if (!settings.name) {
    settings.name = baseName;
    changed = true;
  }
  if (created) {
    settings.description = baseName === CLAWD_AGENT_NAME
      ? "Clawd desktop pet hook integration"
      : `${baseName} agent with Clawd desktop pet hooks`;
  }

  // Resolve node path; if detection fails, preserve existing absolute path
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER)
    || "node";
  const desiredCommand = `"${nodeBin}" "${getHookScriptPath()}"`;

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let updated = 0;

  for (const event of KIRO_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let stalePath = false;
    for (const entry of arr) {
      if (!entry || typeof entry !== "object" || typeof entry.command !== "string") continue;
      if (!entry.command.includes(MARKER)) continue;
      found = true;
      if (entry.command !== desiredCommand) {
        entry.command = desiredCommand;
        stalePath = true;
      }
      break;
    }

    if (found) {
      if (stalePath) {
        updated++;
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    arr.push({ command: desiredCommand });
    added++;
    changed = true;
  }

  if (changed) {
    writeJsonAtomic(filePath, settings);
  }

  return { added, skipped, updated, created };
}

function getHookScriptPath() {
  let hookScript = path.resolve(__dirname, "kiro-hook.js").replace(/\\/g, "/");
  hookScript = hookScript.replace("app.asar/", "app.asar.unpacked/");
  return hookScript;
}

function getKiroCliCandidates(homeDir = os.homedir()) {
  return [
    path.join(homeDir, ".local", "bin", "kiro-cli"),
    "/opt/homebrew/bin/kiro-cli",
    "/usr/local/bin/kiro-cli",
    "kiro-cli",
  ];
}

// Properties excluded from kiro_default template.
const EXCLUDED_KEYS = new Set(["model", "includeMcpJson", "description", "hooks", "name"]);

function generateClawdTemplateFromBuiltin(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const kiroCliCandidates = options.kiroCliCandidates || getKiroCliCandidates(homeDir);
  let lastError = null;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kiro-seed-"));
  const tempName = `clawd-seed-${process.pid}-${Date.now()}`;

  try {
    for (const candidate of kiroCliCandidates) {
      try {
        execFileSync(
          candidate,
          [
            "agent",
            "create",
            tempName,
            "--directory",
            tempDir,
            "--from",
            BUILTIN_DEFAULT_AGENT,
          ],
          {
            stdio: "ignore",
            env: { ...process.env, EDITOR: "true" },
          }
        );
        const templatePath = path.join(tempDir, `${tempName}.json`);
        const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
        return { template, command: candidate };
      } catch (err) {
        lastError = err;
        if (err && err.code === "ENOENT") continue;
      }
    }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }

  return { template: null, error: lastError };
}

function syncClawdAgentFromBuiltin(filePath, options = {}) {
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const result = generateClawdTemplateFromBuiltin(options);
  let desired;
  if (!result.template) {
    if (!options.silent) {
      console.warn(`Clawd: kiro-cli template generation failed, falling back to minimal clawd agent (no prompt/tools/resources). Reason: ${result.error?.message || "unknown"}`);
    }
    desired = {
      name: CLAWD_AGENT_NAME,
      description: "Clawd desktop pet hook integration",
    };
  } else {
    desired = { name: CLAWD_AGENT_NAME };
    for (const key of Object.keys(result.template)) {
      if (!EXCLUDED_KEYS.has(key)) {
        desired[key] = result.template[key];
      }
    }
  }

  desired.hooks = current && current.hooks && typeof current.hooks === "object"
    ? current.hooks
    : {};

  if (!current || JSON.stringify(current) !== JSON.stringify(desired)) {
    writeJsonAtomic(filePath, desired);
    return { synced: true, changed: true };
  }

  return { synced: true, changed: false };
}

/**
 * Register Clawd hooks into Kiro agent configs under ~/.kiro/agents/
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @returns {{ added: number, skipped: number, updated: number, files: string[] }}
 */
function registerKiroHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const agentsDir = options.agentsDir || path.join(homeDir, ".kiro", "agents");

  // Skip if ~/.kiro/ doesn't exist (Kiro CLI not installed)
  if (!fs.existsSync(agentsDir)) {
    if (!options.silent) console.log("Clawd: ~/.kiro/ not found — skipping Kiro hook registration");
    return { added: 0, skipped: 0, updated: 0, files: [] };
  }

  let totalAdded = 0;
  let totalSkipped = 0;
  let totalUpdated = 0;
  const files = [];

  // Scan all .json files in ~/.kiro/agents/ (skip example files)
  let entries;
  try {
    entries = fs.readdirSync(agentsDir);
  } catch {
    entries = [];
  }

  const jsonFiles = entries.filter(f =>
    f.endsWith(".json") && !f.includes(".example")
  );

  // Inject hooks into every existing custom agent config.
  for (const file of jsonFiles) {
    if (file === `${BUILTIN_DEFAULT_AGENT}.json`) continue;
    const filePath = path.join(agentsDir, file);
    try {
      const result = injectHooksIntoFile(filePath, options);
      totalAdded += result.added;
      totalSkipped += result.skipped;
      totalUpdated += result.updated;
      if (result.added > 0 || result.updated > 0 || result.created) {
        files.push(file);
      }
    } catch (err) {
      if (!options.silent) console.warn(`Clawd: failed to process ${file}: ${err.message}`);
    }
  }

  const clawdPath = path.join(agentsDir, `${CLAWD_AGENT_NAME}.json`);
  let clawdTemplateChanged = false;
  try {
    const seedFn = typeof options.syncClawdAgent === "function"
      ? options.syncClawdAgent
      : syncClawdAgentFromBuiltin;
    const syncResult = seedFn(clawdPath, options);
    clawdTemplateChanged = !!(syncResult && syncResult.changed);
  } catch (err) {
    if (!options.silent) console.warn(`Clawd: failed to sync ${CLAWD_AGENT_NAME}.json from ${BUILTIN_DEFAULT_AGENT}: ${err.message}`);
  }
  try {
    const result = injectHooksIntoFile(clawdPath, options);
    totalAdded += result.added;
    totalSkipped += result.skipped;
    totalUpdated += result.updated + (clawdTemplateChanged ? 1 : 0);
    if (result.added > 0 || result.updated > 0 || clawdTemplateChanged) {
      files.push(result.created ? `${CLAWD_AGENT_NAME}.json (created)` : `${CLAWD_AGENT_NAME}.json`);
    }
  } catch (err) {
    if (!options.silent) console.warn(`Clawd: failed to sync ${CLAWD_AGENT_NAME}.json: ${err.message}`);
  }

  if (!options.silent) {
    if (files.length > 0) {
      console.log(`Clawd: Kiro hooks injected into ${files.length} agent config(s): ${files.join(", ")}`);
      console.log(`  Added: ${totalAdded}, updated: ${totalUpdated}, skipped: ${totalSkipped}`);
    } else {
      console.log("Clawd: all Kiro agent configs already up to date");
    }
    console.log(`Clawd: use "kiro-cli --agent ${CLAWD_AGENT_NAME}" or run "/agent swap ${CLAWD_AGENT_NAME}" inside Kiro to enable hooks`);
  }

  return { added: totalAdded, skipped: totalSkipped, updated: totalUpdated, files };
}

module.exports = {
  registerKiroHooks,
  KIRO_HOOK_EVENTS,
  __test: {
    generateClawdTemplateFromBuiltin,
    getKiroCliCandidates,
    injectHooksIntoFile,
    syncClawdAgentFromBuiltin,
  },
};

if (require.main === module) {
  try {
    registerKiroHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
