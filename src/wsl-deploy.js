"use strict";

// One-click WSL hook deployment — copies hook scripts from the Windows-side
// Clawd into a WSL distro and runs the agent-specific install script.
//
// The user never needs to clone the repo inside WSL. Hook files are piped
// through wsl.exe stdin to avoid /mnt/ path assumptions and command-line
// length limits.
//
// Conceptually mirrors src/remote-ssh-deploy.js: both deploy hook scripts
// to a remote environment and run agent-specific install scripts. Step
// lists differ (wsl.exe stdin pipe vs scp) but new deploy requirements
// should be addressed in both paths.

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { execInWsl, getWslHomeDir, isWindows } = require("./wsl-utils");

// All .js files in the hooks/ directory — the full set is needed because
// different agent install scripts have different dependencies
// (e.g. codex-install.js requires codex-hook.js, codex-install-utils.js, etc.).
function collectHookFiles(hooksDir) {
  const files = [];
  try {
    for (const name of fs.readdirSync(hooksDir)) {
      if (!name.endsWith(".js")) continue;
      const full = path.join(hooksDir, name);
      if (!fs.statSync(full).isFile()) continue;
      files.push({ name, path: full, content: fs.readFileSync(full, "utf8") });
    }
  } catch (err) {
    // Permission denied, I/O error, or other FS failure — throw so the
    // deploy fails with the real error rather than "No hook files found".
    console.warn("Clawd: collectHookFiles failed:", err && err.message ? err.message : err);
    throw err;
  }
  return files;
}

// Map agentId to the install script that runs in WSL.
// Register: node <script>.js
// Unregister: node <script>.js --uninstall — EXCEPT claude-code (see
// AGENT_UNINSTALL_COMMAND below).
const AGENT_INSTALL_SCRIPT = {
  "claude-code": "install.js",
  codex: "codex-install.js",
  "copilot-cli": "copilot-install.js",
  "cursor-agent": "cursor-install.js",
  "gemini-cli": "gemini-install.js",
  "antigravity-cli": "antigravity-install.js",
  codebuddy: "codebuddy-install.js",
  "kiro-cli": "kiro-install.js",
  "kimi-cli": "kimi-install.js",
  "qwen-code": "qwen-code-install.js",
  codewhale: "codewhale-install.js",
  // opencode / pi / openclaw / hermes are intentionally absent: their install
  // scripts need non-.js assets (pi-extension.ts, hermes-plugin/, opencode-plugin/,
  // openclaw-plugin/) that the flat stdin file pipe cannot transfer. Re-add them
  // once deploy supports directory transfer (e.g. tar over stdin).
  qoder: "qoder-install.js",
  reasonix: "reasonix-install.js",
  qoderwork: "qoderwork-install.js",
};

function getInstallScript(agentId) {
  return getAgentInstallScriptName(agentId);
}

// install.js does NOT understand --uninstall: it ignores unknown argv and
// RE-REGISTERS hooks, so "node install.js --uninstall" re-installs 12 hook
// entries and the subsequent rm -rf leaves them pointing at deleted files
// (verified on a real Windows+WSL Ubuntu machine). Claude's uninstall lives
// in the separate uninstall.js; every other agent installer handles the flag.
const AGENT_UNINSTALL_COMMAND = {
  "claude-code": "uninstall.js",
};

function getAgentUninstallCommand(agentId) {
  if (AGENT_UNINSTALL_COMMAND[agentId]) return AGENT_UNINSTALL_COMMAND[agentId];
  const installScript = getAgentInstallScriptName(agentId);
  return installScript ? `${installScript} --uninstall` : null;
}

// Resolve hooks directory for both dev (source tree) and packaged.
function resolveHooksDir({ isPackaged } = {}) {
  if (isPackaged) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "hooks");
  }
  return path.join(__dirname, "..", "hooks");
}

// Pipe a file's content into WSL via stdin → cat > file.
// More reliable than /mnt/ paths (user may have custom mount configs)
// and avoids command-line length limits.
function pipeFileToWsl(distro, wslDestDir, fileName, content, options = {}) {
  return new Promise((resolve) => {
    const safePath = `${wslDestDir.replace(/\/$/, "")}/${fileName}`;
    const cmd = `cat > '${safePath.replace(/'/g, "'\\''")}'`;

    const child = childProcess.spawn("wsl.exe", ["-d", distro, "--", "bash", "-c", cmd], {
      env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stderrChunks = [];
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      resolve({ ok: false, fileName, error: "timeout" });
    }, options.timeout || 30000);

    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, fileName, error: err && err.message ? err.message : "spawn failed" });
    });

    if (child.stderr) {
      child.stderr.on("data", (d) => { stderrChunks.push(d); });
    }

    // Use 'close' not 'exit' — only 'close' guarantees stdio streams are
    // fully drained. 'exit' can fire while OS buffers still hold data.
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      resolve(code === 0
        ? { ok: true, fileName, stderr: stderr || null }
        : { ok: false, fileName, error: stderr || `exit code ${code}` }
      );
    });

    if (child.stdin) {
      // EPIPE when wsl.exe dies before draining stdin (stopped/broken
      // distro). Without a listener the stream 'error' event is unhandled
      // and crashes the main process; 'close' already reports the failure.
      child.stdin.on("error", () => {});
      child.stdin.end(content, "utf8");
    } else {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, fileName, error: "no stdin" });
    }
  });
}

// ── Deploy ────────────────────────────────────────────────────────────

async function deployToWsl(distro, options = {}) {
  if (!isWindows()) {
    return { ok: false, step: "platform", message: "WSL deploy only runs on Windows" };
  }
  if (!distro) {
    return { ok: false, step: "args", message: "distro name is required" };
  }

  const hooksDir = options.hooksDir || resolveHooksDir({ isPackaged: options.isPackaged });
  const agentId = options.agentId || "claude-code";
  const installScript = getInstallScript(agentId);

  if (!installScript) {
    return { ok: false, step: "unsupported", message: `WSL deploy is not supported for ${agentId}` };
  }

  function emit(step, status, message, hint) {
    if (typeof options.onProgress === "function") {
      options.onProgress({ distro, step, status, message: message || null, hint: hint || null });
    }
  }

  // 1. Verify local hook files exist.
  emit("verify-files", "start");
  const fileEntries = collectHookFiles(hooksDir);
  if (fileEntries.length === 0) {
    const msg = `No hook files found in ${hooksDir}`;
    emit("verify-files", "fail", msg);
    return { ok: false, step: "verify-files", message: msg };
  }
  // Ensure the target install script is present.
  if (!fileEntries.some((f) => f.name === installScript)) {
    const msg = `Install script ${installScript} not found in ${hooksDir}`;
    emit("verify-files", "fail", msg);
    return { ok: false, step: "verify-files", message: msg };
  }
  emit("verify-files", "ok", null, { fileCount: fileEntries.length });

  // 2. Resolve WSL home and create hooks directory.
  emit("prepare-dir", "start");
  const wslHome = await getWslHomeDir(distro, options);
  if (!wslHome) {
    const msg = `Could not resolve $HOME in WSL ${distro}`;
    emit("prepare-dir", "fail", msg);
    return { ok: false, step: "prepare-dir", message: msg };
  }
  const hooksTargetDir = `${wslHome}/.claude/hooks`;
  const hooksTargetDirEscaped = hooksTargetDir.replace(/'/g, "'\\''");

  const mkdirResult = await execInWsl(distro, `mkdir -p '${hooksTargetDirEscaped}'`, options);
  if (mkdirResult.code !== 0) {
    const msg = mkdirResult.stderr || `mkdir failed with code ${mkdirResult.code}`;
    emit("prepare-dir", "fail", msg);
    return { ok: false, step: "prepare-dir", message: msg };
  }
  emit("prepare-dir", "ok", null, { hooksTargetDir });

  // 3. Copy hook files into WSL.
  emit("copy-files", "start");
  let copied = 0;
  const copyErrors = [];
  for (const entry of fileEntries) {
    const result = await pipeFileToWsl(distro, hooksTargetDir, entry.name, entry.content, options);
    if (result.ok) {
      copied++;
      if (result.stderr) {
        emit("copy-files", "stderr", null, { fileName: entry.name, stderr: result.stderr.slice(0, 200) });
      }
    } else {
      copyErrors.push(result);
    }
  }
  if (copyErrors.length > 0) {
    const names = copyErrors.map((e) => e.fileName).join(", ");
    const msg = `Failed to copy ${copyErrors.length} file(s): ${names}`;
    emit("copy-files", "fail", msg);
    return { ok: false, step: "copy-files", message: msg, errors: copyErrors };
  }
  emit("copy-files", "ok", null, { copied, total: fileEntries.length });

  // 4. Run agent-specific install script inside WSL.
  // Pass CLAWD_WSL_DISTRO so install.js's buildCommandHookSpec detects WSL
  // and emits plain (unquoted) command format. Without this, the hook runner
  // treats quotes as part of the executable name → silent hook failure.
  //
  // Use bash -l -i -c so version managers (nvm/volta/fnm) are initialised
  // and `node` resolves to the user's managed version, not a stale system one.
  emit("run-install", "start");
  const distroEscaped = distro.replace(/'/g, "'\\''");
  const runResult = await execInWsl(
    distro,
    `cd '${hooksTargetDirEscaped}' && CLAWD_WSL_DISTRO='${distroEscaped}' node ${installScript}`,
    { ...options, shell: "bash", shellFlags: ["-l", "-i", "-c"], timeout: 60000 }
  );
  if (runResult.code !== 0) {
    const msg = runResult.stderr || `${installScript} failed with code ${runResult.code}`;
    emit("run-install", "fail", msg);
    return { ok: false, step: "run-install", message: msg };
  }
  emit("run-install", "ok");

  // 5. Probe Windows-side Clawd reachability from inside the distro.
  // Under default NAT networking, localhost belongs to the WSL VM, so hooks
  // install fine but every report silently fails (verified on a real NAT
  // machine). Deploy still succeeds — the UI turns connectivity=false into
  // an actionable warning instead of a fake success.
  emit("verify-connectivity", "start");
  const probeResult = await execInWsl(
    distro,
    `cd '${hooksTargetDirEscaped}' && node wsl-connectivity-probe.js`,
    { ...options, shell: "bash", shellFlags: ["-l", "-i", "-c"], timeout: 20000 }
  );
  const connectivity = parseConnectivityProbe(probeResult && probeResult.stdout);
  if (connectivity.reachable === true) {
    emit("verify-connectivity", "ok", null, { port: connectivity.port });
  } else if (connectivity.reachable === false) {
    emit("verify-connectivity", "warn", "Clawd HTTP server unreachable from WSL (NAT networking?)");
  } else {
    // Probe itself failed to produce a verdict (crashed, killed) — do not
    // alarm the user on an unknown; hooks may still work.
    emit("verify-connectivity", "skip", (probeResult && probeResult.stderr) || null);
  }

  return {
    ok: true,
    distro,
    agentId,
    hooksTargetDir,
    filesCopied: copied,
    connectivity: connectivity.reachable,
    connectivityPort: connectivity.port,
  };
}

// Parse wsl-connectivity-probe.js output: "REACHABLE <port>" / "UNREACHABLE".
// Anything else (probe crashed, empty output) → reachable: null = unknown.
function parseConnectivityProbe(stdout) {
  const text = typeof stdout === "string" ? stdout : "";
  const m = text.match(/^REACHABLE (\d+)$/m);
  if (m) return { reachable: true, port: parseInt(m[1], 10) };
  if (/^UNREACHABLE$/m.test(text)) return { reachable: false, port: null };
  return { reachable: null, port: null };
}

// ── Remove ────────────────────────────────────────────────────────────

async function removeFromWsl(distro, options = {}) {
  if (!isWindows()) {
    return { ok: false, step: "platform", message: "WSL remove only runs on Windows" };
  }
  if (!distro) {
    return { ok: false, step: "args", message: "distro name is required" };
  }

  const wslHome = await getWslHomeDir(distro, options);
  if (!wslHome) {
    return { ok: false, step: "home", message: `Could not resolve $HOME in WSL ${distro}` };
  }

  const hooksDir = `${wslHome}/.claude/hooks`;
  const hooksDirEscaped = hooksDir.replace(/'/g, "'\\''");
  const agentId = options.agentId || "claude-code";

  function emit(step, status, message, hint) {
    if (typeof options.onProgress === "function") {
      options.onProgress({ distro, step, status, message: message || null, hint: hint || null });
    }
  }

  emit("remove", "start");

  // Run the agent's uninstall script — best-effort, may fail if Node or
  // hooks were already removed. Use bash -l -i -c so version managers
  // (nvm/volta/fnm) are initialised and `node` resolves correctly.
  const uninstallCommand = getAgentUninstallCommand(agentId);
  if (uninstallCommand) {
    const uninstallResult = await execInWsl(
      distro,
      `cd '${hooksDirEscaped}' && node ${uninstallCommand}`,
      { ...options, shell: "bash", shellFlags: ["-l", "-i", "-c"], timeout: 30000 }
    );
    if (uninstallResult.code !== 0) {
      emit("remove", "stderr", uninstallResult.stderr || `uninstall exited ${uninstallResult.code}`);
    }
  }

  // Remove the hook FILES only when explicitly asked: ~/.claude/hooks is
  // shared by every paired agent in the distro, so a per-agent unpair from
  // the UI must not delete files other agents' registered commands point at.
  if (options.removeFiles === true) {
    const rmResult = await execInWsl(
      distro,
      `rm -rf '${hooksDirEscaped}'`,
      { ...options, timeout: 30000 }
    );
    if (rmResult.code !== 0) {
      const msg = rmResult.stderr || `rm failed with code ${rmResult.code}`;
      emit("remove", "fail", msg);
      return { ok: false, step: "remove", message: msg };
    }
  }

  emit("remove", "ok");
  return { ok: true, distro, agentId, filesRemoved: options.removeFiles === true };
}

// ── Agent-specific install script name lookup ─────────────────────────

function getAgentInstallScriptName(agentId) {
  return AGENT_INSTALL_SCRIPT[agentId] || null;
}

module.exports = {
  deployToWsl,
  removeFromWsl,
  getAgentInstallScriptName,
  getAgentUninstallCommand,
  parseConnectivityProbe,
  resolveHooksDir,
  pipeFileToWsl,
  collectHookFiles,
};
