#!/usr/bin/env node
// CloudBase CLI environment verification + shell hook auto-injection
// Checks if tcb/cloudbase CLI is installed, and injects shell hook into ~/.zshrc / ~/.bashrc

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SHELL_HOOK_FILE = path.resolve(__dirname, "cloudbase-shell-hook.sh");
const MARKER = "clawd-on-desk/hooks/cloudbase-shell-hook.sh";

/**
 * Verify CloudBase CLI installation
 */
function verifyCloudbaseCli(options = {}) {
  const commands = ["tcb", "cloudbase"];

  for (const cmd of commands) {
    try {
      const version = execSync(`${cmd} -v 2>/dev/null || ${cmd} --version 2>/dev/null`, {
        encoding: "utf8",
        timeout: 5000,
      }).trim();

      if (version) {
        if (!options.silent) {
          console.log(`Clawd: Found CloudBase CLI → ${cmd} (${version})`);
        }
        return { installed: true, command: cmd, version };
      }
    } catch {
      // Command not found, try next
    }
  }

  if (!options.silent) {
    console.log("Clawd: CloudBase CLI (tcb/cloudbase) not found — process monitoring will be passive");
    console.log("  Install: npm i -g @cloudbase/cli");
  }

  return { installed: false, command: null, version: null };
}

/**
 * Inject shell hook source line into ~/.zshrc and/or ~/.bashrc (idempotent)
 * @returns {{ injected: string[], skipped: string[] }}
 */
function injectShellHook(options = {}) {
  // Resolve the hook script path, handling packaged app paths
  let hookPath = SHELL_HOOK_FILE.replace(/\\/g, "/");
  hookPath = hookPath.replace("app.asar/", "app.asar.unpacked/");

  const sourceLine = `source "${hookPath}"  # Clawd CloudBase CLI shell integration`;

  const targets = [];
  const shell = process.env.SHELL || "";

  if (shell.includes("zsh") || fs.existsSync(path.join(os.homedir(), ".zshrc"))) {
    targets.push(path.join(os.homedir(), ".zshrc"));
  }
  if (shell.includes("bash") || fs.existsSync(path.join(os.homedir(), ".bashrc"))) {
    targets.push(path.join(os.homedir(), ".bashrc"));
  }
  // Fallback: at least try .zshrc on macOS
  if (targets.length === 0 && process.platform === "darwin") {
    targets.push(path.join(os.homedir(), ".zshrc"));
  }

  const injected = [];
  const skipped = [];

  for (const rcFile of targets) {
    try {
      let content = "";
      try {
        content = fs.readFileSync(rcFile, "utf-8");
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        // File doesn't exist, we'll create it
      }

      if (content.includes(MARKER)) {
        // Already injected — check if path is stale
        if (!content.includes(hookPath)) {
          // Update path
          const lines = content.split("\n");
          const updated = lines.map(line =>
            line.includes(MARKER) ? sourceLine : line
          ).join("\n");
          fs.writeFileSync(rcFile, updated, "utf-8");
          if (!options.silent) console.log(`Clawd: Updated shell hook path in ${rcFile}`);
          injected.push(rcFile);
        } else {
          skipped.push(rcFile);
        }
        continue;
      }

      // Append source line
      const newContent = content.endsWith("\n") || content === ""
        ? content + sourceLine + "\n"
        : content + "\n" + sourceLine + "\n";
      fs.writeFileSync(rcFile, newContent, "utf-8");
      if (!options.silent) console.log(`Clawd: Injected shell hook into ${rcFile}`);
      injected.push(rcFile);
    } catch (err) {
      if (!options.silent) console.warn(`Clawd: Failed to inject into ${rcFile}:`, err.message);
    }
  }

  return { injected, skipped };
}

/**
 * Remove shell hook from ~/.zshrc and ~/.bashrc
 */
function removeShellHook(options = {}) {
  const targets = [
    path.join(os.homedir(), ".zshrc"),
    path.join(os.homedir(), ".bashrc"),
  ];

  for (const rcFile of targets) {
    try {
      const content = fs.readFileSync(rcFile, "utf-8");
      if (!content.includes(MARKER)) continue;

      const lines = content.split("\n");
      const filtered = lines.filter(line => !line.includes(MARKER));
      fs.writeFileSync(rcFile, filtered.join("\n"), "utf-8");
      if (!options.silent) console.log(`Clawd: Removed shell hook from ${rcFile}`);
    } catch {
      // File doesn't exist or can't be read
    }
  }
}

module.exports = { verifyCloudbaseCli, injectShellHook, removeShellHook };

if (require.main === module) {
  verifyCloudbaseCli({});
  injectShellHook({});
}
