"use strict";

// Local-only consent/recovery record. Remote --chain keeps its existing contract.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readJsonFile } = require("./json-utils");

const LOCAL_CHAIN_FLAG = "--local-chain";
const LOCAL_CHAIN_FILE = "clawd-statusline-local-chain.json";
const LOCAL_CHAIN_OWNER = "clawd.claude-statusline.local.v1";

function statuslineFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readLocalChainRecord(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > 65536) throw new Error(`Invalid statusline recovery record: ${file}`);
  const record = readJsonFile(file);
  if (!record || record.owner !== LOCAL_CHAIN_OWNER || record.version !== 1
    || !/^[a-f0-9]{32}$/.test(record.id || "")
    || !["darwin", "linux", "win32"].includes(record.platform)
    || !record.statusLine || record.statusLine.type !== "command"
    || typeof record.statusLine.command !== "string" || !record.statusLine.command.trim()
    || record.statusLine.command.includes(LOCAL_CHAIN_FLAG)
    || typeof record.managedCommand !== "string"
    || !record.managedCommand.endsWith(` ${LOCAL_CHAIN_FLAG} ${record.id}`)
    || (record.previousManagedCommand !== undefined && (typeof record.previousManagedCommand !== "string"
      || !record.previousManagedCommand.endsWith(` ${LOCAL_CHAIN_FLAG} ${record.id}`)))) {
    throw new Error(`Invalid statusline recovery record: ${file}`);
  }
  return record;
}

function createLocalChainRecord(file, statusLine, portableCommand, platform) {
  if (statusLine.command.includes(LOCAL_CHAIN_FLAG)) {
    throw new Error("The existing statusline already contains a local chain marker; kept unchanged");
  }
  const prior = readLocalChainRecord(file);
  if (prior) {
    // Retry after a settings write failed: reuse, never replace, the original.
    if (statuslineFingerprint(prior.statusLine) !== statuslineFingerprint(statusLine)
      || prior.platform !== platform
      || prior.managedCommand !== `${portableCommand} ${LOCAL_CHAIN_FLAG} ${prior.id}`) {
      throw new Error(`Existing statusline recovery record needs inspection: ${file}`);
    }
    return prior;
  }
  const id = crypto.randomBytes(16).toString("hex");
  const record = {
    owner: LOCAL_CHAIN_OWNER, version: 1, id, platform, statusLine,
    managedCommand: `${portableCommand} ${LOCAL_CHAIN_FLAG} ${id}`,
  };
  const serialized = JSON.stringify(record, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > 65536) throw new Error("Statusline recovery record is too large; kept unchanged");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Exclusive creation also protects a record installed between read and write.
  fs.writeFileSync(file, serialized, { flag: "wx", mode: 0o600 });
  return record;
}

function requireOwnedLocalChain(file, statusLine) {
  const record = readLocalChainRecord(file);
  if (!record || (record.managedCommand !== statusLine.command && record.previousManagedCommand !== statusLine.command)) {
    throw new Error(`Statusline recovery record is missing or does not match; kept unchanged: ${file}`);
  }
  return record;
}

// Match Claude's documented Windows choice: Git Bash, then PowerShell.
// Never resolve bare bash.exe: Windows may supply the WSL launcher under that name.
function resolveLocalChainShell(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const exists = options.exists || ((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (platform !== "win32") return { file: "/bin/sh", kind: "posix" };
  const envValue = (key) => env[Object.keys(env).find((name) => name.toLowerCase() === key.toLowerCase())] || "";
  const explicit = envValue("CLAUDE_CODE_GIT_BASH_PATH");
  if (explicit) {
    if (!path.win32.isAbsolute(explicit) || !exists(explicit)) {
      throw new Error("Configured Claude Git Bash is unavailable");
    }
    return { file: explicit, kind: "bash" };
  }
  const candidates = [];
  for (const dir of envValue("PATH").split(";").filter(Boolean)) {
    // Git's cmd/git.exe or bin/git.exe, not arbitrary Windows bash on PATH.
    const clean = dir.replace(/^"|"$/g, "");
    if (exists(path.win32.join(clean, "git.exe"))) {
      candidates.push(path.win32.join(clean, "bash.exe"));
      candidates.push(path.win32.join(clean, "..", "bin", "bash.exe"));
    }
  }
  for (const root of [envValue("ProgramFiles"), envValue("ProgramFiles(x86)")].filter(Boolean)) {
    candidates.push(path.win32.join(root, "Git", "bin", "bash.exe"));
  }
  if (envValue("LOCALAPPDATA")) candidates.push(path.win32.join(envValue("LOCALAPPDATA"), "Programs", "Git", "bin", "bash.exe"));
  const bash = candidates.find((file) => path.win32.isAbsolute(file) && exists(file));
  if (bash) return { file: bash, kind: "bash" };
  const systemRoot = envValue("SystemRoot");
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!path.win32.isAbsolute(powershell) || !exists(powershell)) throw new Error("Claude statusline shell is unavailable");
  return { file: powershell, kind: "powershell" };
}

module.exports = {
  LOCAL_CHAIN_FLAG, LOCAL_CHAIN_FILE, statuslineFingerprint,
  readLocalChainRecord, createLocalChainRecord, requireOwnedLocalChain, resolveLocalChainShell,
};
