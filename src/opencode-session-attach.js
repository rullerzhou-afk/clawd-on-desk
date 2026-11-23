"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { tryLaunch, quoteForPowerShell } = require("./launch-claude");
const { getOpencodeAttachTarget } = require("./opencode-attach-target");
const execFileAsync = promisify(execFile);

async function isNativeExecutable(file) {
  if (!path.win32.isAbsolute(file) || !/\.exe$/i.test(file)) return false;
  let handle;
  try {
    handle = await fs.open(file, "r");
    if (!(await handle.stat()).isFile()) return false;
    const bytes = Buffer.alloc(2);
    await handle.read(bytes, 0, 2, 0);
    return bytes.toString("ascii") === "MZ";
  } catch { return false; }
  finally { if (handle) await handle.close(); }
}

async function findOpencodeExecutable(deps = {}) {
  const exec = deps.execFileAsync || execFileAsync;
  const native = deps.isNativeExecutable || isNativeExecutable;
  let paths;
  try {
    const result = await exec("where.exe", ["opencode"], {
      cwd: os.tmpdir(), windowsHide: true, timeout: 5000, encoding: "utf8", maxBuffer: 64 * 1024,
    });
    paths = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch { return null; }
  const candidates = [];
  for (const file of paths) {
    if (/\.exe$/i.test(file)) candidates.push(file);
    else if (/\.cmd$/i.test(file) && path.win32.isAbsolute(file)) {
      // v1's official npm postinstall puts the native PE in this exact slot.
      // Never execute a shim: it would re-parse cwd and URL through cmd.exe.
      candidates.push(path.win32.join(path.win32.dirname(file), "node_modules", "opencode-ai", "bin", "opencode.exe"));
    }
  }
  for (const file of [...new Set(candidates)]) {
    if (!await native(file)) continue;
    try {
      const result = await exec(file, ["--version"], { windowsHide: true, timeout: 5000, encoding: "utf8", maxBuffer: 64 * 1024 });
      if (/^1\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(result.stdout.trim())) return file;
    } catch {}
  }
  return null;
}

function buildAttachTerminalArgs(executable, target) {
  const command = "Set-Location -LiteralPath " + quoteForPowerShell(target.cwd)
    + "; & " + [executable, "attach", target.url, "--session", target.sessionId, "--dir", target.cwd]
      .map(quoteForPowerShell).join(" ");
  return ["--window", "new", "new-tab", "--title", "OpenCode", "--", "powershell.exe",
    "-NoLogo", "-NoProfile", "-NoExit", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
}

function createOpencodeSessionAttacher(options = {}) {
  const getSession = options.getSession;
  const isEnabled = options.isAgentEnabled || (() => true);
  const platform = options.platform || process.platform;
  const find = options.findExecutable || findOpencodeExecutable;
  const launch = options.tryLaunch || tryLaunch;
  const stat = options.stat || fs.stat;
  const pending = new Set();
  return async function openSessionInTerminal(id) {
    if (typeof id !== "string" || !id || id.length > 512) return { status: "invalid" };
    if (pending.has(id)) return { status: "busy" };
    const session = getSession(id);
    const target = getOpencodeAttachTarget(session, platform);
    if (!target || !isEnabled("opencode")) return { status: "unavailable" };
    pending.add(id);
    try {
      try { if (!(await stat(target.cwd)).isDirectory()) return { status: "error", reason: "directory" }; }
      catch { return { status: "error", reason: "directory" }; }
      const executable = await find();
      if (!executable) return { status: "error", reason: "opencode" };
      // `state.updateSession()` rebuilds the session object for every ordinary
      // event, so reference equality would cancel this action whenever a
      // PostToolUse lands during the asynchronous lookup. Re-derive the
      // validated target from the current session instead: an unchanged
      // identity/URL/directory still launches, while a removed session or a
      // changed/invalid target is still rejected.
      const current = getSession(id);
      if (!isEnabled("opencode")
        || JSON.stringify(getOpencodeAttachTarget(current, platform)) !== JSON.stringify(target)) {
        return { status: "unavailable" };
      }
      const result = await launch("wt.exe", buildAttachTerminalArgs(executable, target), {
        detached: true, stdio: "ignore", shell: false, windowsHide: false,
      });
      return result.ok ? { status: "ok" } : { status: "error", reason: "terminal" };
    } catch { return { status: "error", reason: "terminal" }; }
    finally { pending.delete(id); }
  };
}

module.exports = { createOpencodeSessionAttacher, findOpencodeExecutable, buildAttachTerminalArgs };
