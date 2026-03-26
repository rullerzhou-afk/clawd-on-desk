#!/usr/bin/env node
// Clawd Desktop Pet — OpenCode Plugin Installer
// Safely adds the Clawd plugin to opencode.json configuration
// Does NOT overwrite existing plugins — appends to array

const fs = require("fs");
const path = require("path");
const os = require("os");

const MARKER = "clawd-opencode-plugin.js";

// OpenCode config file locations (in order of precedence)
// https://opencode.ai/docs/config#precedence-order
function getConfigPaths() {
  const paths = [];

  // Project-level config (highest precedence)
  const cwd = process.cwd();
  paths.push(
    path.join(cwd, "opencode.json"),
    path.join(cwd, "opencode.jsonc"),
    path.join(cwd, ".opencode", "opencode.json"),
    path.join(cwd, ".opencode", "opencode.jsonc")
  );

  // Global config
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  paths.push(
    path.join(configDir, "opencode", "opencode.json"),
    path.join(configDir, "opencode", "opencode.jsonc")
  );

  return paths;
}

/**
 * Parse JSONC (JSON with comments) - simple strip comments approach
 */
function parseJsonc(text) {
  // Remove single-line comments
  let result = text.replace(/\/\/.*$/gm, "");
  // Remove trailing commas before ] or }
  result = result.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(result);
}

/**
 * Find the first existing OpenCode config file
 */
function findConfigFile() {
  for (const p of getConfigPaths()) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Detect installed OpenCode/Crush version by running `opencode --version` or `crush --version`.
 * Returns { version, command } or null if detection fails.
 */
function getOpenCodeVersion() {
  const commands = ["opencode", "crush"];
  const { execSync } = require("child_process");

  for (const cmd of commands) {
    try {
      const out = execSync(`${cmd} --version`, {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      const match = out.match(/(\d+\.\d+\.\d+)/);
      if (match) {
        return { version: match[1], command: cmd };
      }
    } catch {
      // Try next command
    }
  }
  return null;
}

/**
 * Register Clawd OpenCode plugin to opencode.json.
 * Safe to call multiple times — skips if already registered.
 * @param {object} [options]
 * @param {boolean} [options.silent] - suppress console output
 * @param {string} [options.configPath] - specific config file path
 * @param {boolean} [options.checkInstalled] - check if OpenCode is installed first (default: true)
 * @returns {{ added: boolean, configPath: string|null, skipped: boolean }}
 */
function registerPlugin(options = {}) {
  const { checkInstalled = true } = options;

  // Check if OpenCode/Crush is installed before touching anything
  if (checkInstalled) {
    const versionInfo = getOpenCodeVersion();
    const existingConfig = findConfigFile();
    if (!versionInfo && !existingConfig) {
      // OpenCode not installed and no config exists — skip silently
      return { added: false, configPath: null, skipped: true };
    }
  }

  // Find plugin script path
  let pluginPath = path.resolve(__dirname, "clawd-opencode-plugin.js").replace(/\\/g, "/");
  // In packaged builds, __dirname points to app.asar (virtual); the actual
  // unpacked file lives under app.asar.unpacked (see package.json asarUnpack).
  pluginPath = pluginPath.replace("app.asar/", "app.asar.unpacked/");

  // Build file URL - need to handle WSL path correctly
  // In WSL, path is /mnt/d/... but OpenCode running in WSL expects /home/... style
  // file:// URL should use the actual path without conversion
  let fileUrl;
  if (pluginPath.startsWith("/mnt/")) {
    // WSL path - use as-is, OpenCode in WSL can read it directly
    fileUrl = `file://${pluginPath}`;
  } else if (process.platform === "win32") {
    // Native Windows path - add leading slash
    fileUrl = `file:///${pluginPath}`;
  } else {
    // Unix path (macOS, Linux)
    fileUrl = `file://${pluginPath}`;
  }

  // Determine config file - only use existing config, don't create new one
  let configPath = options.configPath || findConfigFile();

  // If no config exists, don't create one (OpenCode not set up)
  if (!configPath) {
    return { added: false, configPath: null, skipped: true };
  }

  // Read existing config
  let config = {};
  let isJsonc = configPath.endsWith(".jsonc");

  if (fs.existsSync(configPath)) {
    try {
      const text = fs.readFileSync(configPath, "utf-8");
      if (isJsonc) {
        config = parseJsonc(text);
      } else {
        config = JSON.parse(text);
      }
    } catch (err) {
      throw new Error(`Failed to parse ${configPath}: ${err.message}`);
    }
  }

  // Ensure plugin array exists
  if (!config.plugin) {
    config.plugin = [];
  }
  if (!Array.isArray(config.plugin)) {
    config.plugin = [config.plugin];
  }

  // Check if already registered
  const alreadyExists = config.plugin.some(
    (p) => typeof p === "string" && p.includes(MARKER)
  );

  if (alreadyExists) {
    if (!options.silent) {
      console.log(`Clawd plugin already registered in ${configPath}`);
    }
    return { added: false, configPath, skipped: false };
  }

  // Add plugin
  config.plugin.push(fileUrl);

  // Add $schema if not present
  if (!config.$schema) {
    config.$schema = "https://opencode.ai/config.json";
  }

  // Write config
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  if (!options.silent) {
    const versionInfo = getOpenCodeVersion();
    console.log(`Clawd OpenCode plugin installed to ${configPath}`);
    if (versionInfo) {
      console.log(`  ${versionInfo.command} version: ${versionInfo.version}`);
    }
    console.log(`  Plugin path: ${fileUrl}`);
    console.log(`\nRestart OpenCode/Crush to activate the plugin.`);
  }

  return { added: true, configPath, skipped: false };
}

/**
 * Remove Clawd plugin from opencode.json.
 * @param {string} [configPath] - specific config file path
 * @returns {boolean} true if plugin was removed
 */
function unregisterPlugin(configPath) {
  configPath = configPath || findConfigFile();
  if (!configPath || !fs.existsSync(configPath)) {
    return false;
  }

  let config;
  const isJsonc = configPath.endsWith(".jsonc");

  try {
    const text = fs.readFileSync(configPath, "utf-8");
    if (isJsonc) {
      config = parseJsonc(text);
    } else {
      config = JSON.parse(text);
    }
  } catch {
    return false;
  }

  if (!Array.isArray(config.plugin)) {
    return false;
  }

  const before = config.plugin.length;
  config.plugin = config.plugin.filter(
    (p) => !(typeof p === "string" && p.includes(MARKER))
  );

  if (config.plugin.length < before) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    return true;
  }

  return false;
}

/**
 * Check if Clawd plugin is registered in opencode.json.
 * @returns {boolean}
 */
function isPluginRegistered() {
  const configPath = findConfigFile();
  if (!configPath || !fs.existsSync(configPath)) {
    return false;
  }

  try {
    const text = fs.readFileSync(configPath, "utf-8");
    const isJsonc = configPath.endsWith(".jsonc");
    const config = isJsonc ? parseJsonc(text) : JSON.parse(text);

    if (!Array.isArray(config.plugin)) return false;
    return config.plugin.some(
      (p) => typeof p === "string" && p.includes(MARKER)
    );
  } catch {
    return false;
  }
}

// Export for use by main.js
module.exports = { registerPlugin, unregisterPlugin, isPluginRegistered, getOpenCodeVersion };

// CLI: run directly with `node plugins/opencode/install.cjs`
if (require.main === module) {
  try {
    registerPlugin();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
