"use strict";

// Windows filesystem operations used by the remote deployment controller.
// Each invocation uses the fixed stdin loader and verifies the probed execPath.
// Lease checks and protected mutations execute in the SAME Node program.
// Installers run as native Node children, never through a POSIX shell.
const { buildNodeProgramFrame } = require("./remote-ssh-node-launch");
const { runRemoteNodeFrame, isValidRemoteNodeBin } = require("./remote-ssh-node");

// Kept self-contained because its source is sent to the remote Node process.
// Dependency injection is only used by filesystem/error tests on other hosts.
async function windowsOperation(args, deps = {}) {
  const fs = deps.fs || require("fs");
  const p = deps.path || require("path").win32;
  const crypto = require("crypto");
  const kill = deps.kill || process.kill.bind(process);
  const delay = deps.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { layout, operation } = args;
  if ((deps.platform || process.platform) !== "win32") throw new Error("Native Windows Node required; remote platform changed");
  if (!layout || layout.platform !== "win32") throw new Error("Windows remote layout required");

  function refuse(reason, target, detail = "") {
    const err = new Error(`${reason}: ${target}${detail ? ` (${detail})` : ""}`);
    err.reason = reason;
    err.path = target;
    throw err;
  }
  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function stat(target) {
    try { return fs.lstatSync(target); } catch (err) {
      if (err.code === "ENOENT") return null;
      refuse("path_unreadable", target, err.code);
    }
  }
  function safePath(target) {
    if (typeof target !== "string" || !p.isAbsolute(target) || p.normalize(target) !== target) {
      refuse("path_invalid", String(target));
    }
    const relative = p.relative(layout.remoteHome, target);
    if (relative === ".." || relative.startsWith(`..${p.sep}`) || p.isAbsolute(relative)) {
      refuse("path_outside_home", target);
    }
    const parts = relative ? relative.split(p.sep) : [];
    let current = layout.remoteHome;
    for (let i = 0; i <= parts.length; i++) {
      const st = stat(current);
      if (st && st.isSymbolicLink()) refuse("path_link", current);
      if (st && i < parts.length && !st.isDirectory()) refuse("path_not_directory", current);
      if (i < parts.length) current = p.join(current, parts[i]);
    }
    return target;
  }
  function readText(target) {
    safePath(target);
    try { return fs.readFileSync(target, "utf8"); } catch (err) {
      if (err.code === "ENOENT") return null;
      refuse("file_unreadable", target, err.code);
    }
  }
  function readJson(target, reason, allowBom = false) {
    const text = readText(target);
    if (text === null) return null;
    try {
      const value = JSON.parse(allowBom ? text.replace(/^\uFEFF/, "") : text);
      if (object(value)) return value;
    } catch {}
    refuse(reason, target);
  }
  function validateIdentity(identity) {
    if (!object(identity) || identity.version !== 2
      || !/^[a-f0-9]{64}$/.test(identity.installId || "")
      || !/^[a-zA-Z0-9_-]{1,64}$/.test(identity.profileId || "")
      || !/^[a-zA-Z0-9_-]{1,64}$/.test(identity.runtimeKey || "")
      || identity.layoutVersion !== 1
      || !/^[a-f0-9]{32}$/.test(identity.routingNonce || "")
      || !Number.isInteger(identity.remotePort) || identity.remotePort < 23333 || identity.remotePort > 23337
      || !Number.isFinite(identity.deployedAt) || identity.deployedAt <= 0) {
      refuse("identity_invalid", layout.identityFile);
    }
    for (const key of ["installId", "profileId", "runtimeKey", "layoutVersion"]) {
      if (identity[key] !== args.expected[key]) refuse("ownership_conflict", layout.identityFile, key);
    }
    return identity;
  }
  function readIdentity() {
    const identity = readJson(layout.identityFile, "identity_invalid");
    return identity === null ? null : validateIdentity(identity);
  }
  function validateOwner(owner) {
    if (!object(owner) || !/^[a-f0-9]{32}$/.test(owner.leaseId || "")
      || !/^[a-f0-9]{64}$/.test(owner.installId || "")
      || !/^[a-zA-Z0-9_-]{1,64}$/.test(owner.profileId || "")
      || owner.runtimeKey !== layout.runtimeKey || owner.layoutVersion !== layout.layoutVersion
      || !Number.isFinite(owner.acquiredAt) || owner.acquiredAt <= 0) {
      refuse("lock_owner_invalid", layout.deployLockDir);
    }
  }
  const ownerFile = p.join(layout.deployLockDir, "owner");
  function assertLease() {
    const owner = readJson(ownerFile, "lock_owner_invalid");
    validateOwner(owner);
    for (const key of ["leaseId", "installId", "profileId", "runtimeKey", "layoutVersion"]) {
      if (owner[key] !== args.owner[key]) refuse("lease_lost", ownerFile, key);
    }
  }
  async function rename(source, target) {
    for (let attempt = 0; ; attempt++) {
      safePath(source);
      safePath(target);
      try { fs.renameSync(source, target); return; } catch (err) {
        if (!["EPERM", "EBUSY"].includes(err.code) || attempt >= 3) throw err;
        await delay(25 * (attempt + 1));
        // A retry yields to other processes: recheck the lease before writing.
        if (operation !== "acquireLock") assertLease();
      }
    }
  }
  async function atomicWrite(target, text) {
    safePath(target);
    const tmp = p.join(p.dirname(target), `.clawd-${crypto.randomBytes(12).toString("hex")}.tmp`);
    safePath(tmp);
    try {
      fs.writeFileSync(tmp, text, { flag: "wx" });
      await rename(tmp, target);
    } finally {
      try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  }
  function hash(target) {
    safePath(target);
    return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  }

  function flatten(entries) {
    return (Array.isArray(entries) ? entries : []).flatMap((entry) =>
      entry && Array.isArray(entry.hooks) ? entry.hooks : [entry]);
  }
  function verifyInstaller() {
    if (!args.verify) return true;
    const utilsPath = safePath(p.join(layout.claudeHooksDir, "json-utils.js"));
    const { parsePowerShellEnvCommand, normalizeHookScriptPath } = (deps.require || require)(utilsPath);
    const normalize = (value) => normalizeHookScriptPath(value, "win32");
    const sameNode = (value) => typeof value === "string" && value.toLowerCase() === (deps.execPath || process.execPath).toLowerCase();
    const claude = args.verify === "installClaude";
    const configPath = claude ? layout.claudeSettingsFile : p.join(layout.copilotHome, "hooks", "hooks.json");
    if (!claude && (readText(configPath) || "").startsWith("\uFEFF")) refuse("copilot_config_bom", configPath);
    const settings = readJson(configPath, "installer_config_invalid", claude);
    const hooks = settings && settings.hooks;
    if (!object(hooks)) return false;
    const script = normalize(p.join(layout.claudeHooksDir, claude ? "clawd-hook.js" : "copilot-hook.js"));
    // Reuse the uploaded installers' event contracts instead of maintaining
    // another list that can silently miss a newly registered event.
    const installer = (deps.require || require)(safePath(p.join(layout.claudeHooksDir, args.script)));
    const requiredEvents = claude ? installer.CLAUDE_CORE_HOOK_EVENTS : installer.COPILOT_STATE_HOOK_EVENTS;
    if (!Array.isArray(requiredEvents) || requiredEvents.length === 0) return false;
    const events = new Set(requiredEvents);
    if (claude) {
      for (const [event, entries] of Object.entries(hooks)) {
        if (flatten(entries).some((hook) => hook && (String(hook.command || "").includes("clawd-hook.js")
          || (Array.isArray(hook.args) && normalize(hook.args[0]) === script)))) events.add(event);
      }
    }
    return [...events].every((event) => flatten(hooks[event]).some((hook) => {
      if (!hook) return false;
      if (claude && hook.type === "command" && Array.isArray(hook.args)) {
        return sameNode(hook.command) && normalize(hook.args[0]) === script && hook.args[1] === event
          && hook.args.slice(1).includes("--clawd-ssh-remote");
      }
      if (claude && (hook.type !== "command" || hook.shell !== "powershell")) return false;
      const parsed = parsePowerShellEnvCommand(claude ? hook.command : hook.powershell);
      if (!parsed || !sameNode(parsed.args[0]) || normalize(parsed.args[1]) !== script || parsed.args[2] !== event) return false;
      if (claude) return parsed.args.length === 4 && parsed.args[3] === "--clawd-ssh-remote";
      return parsed.args.length === 3 && parsed.env.CLAWD_REMOTE === "1" && parsed.env.CLAWD_SSH_REMOTE === "1"
        && normalize(parsed.env.CLAWD_REMOTE_IDENTITY_PATH) === normalize(layout.identityFile);
    }));
  }

  if (operation === "preflight") {
    // ENOENT alone proves absence. Older runtimes without ownerPid cannot
    // prove that a local desktop has stopped, so deployment must wait.
    const runtimePath = p.join(layout.remoteHome, ".clawd", "runtime.json");
    const runtime = readJson(runtimePath, "runtime_invalid");
    if (runtime !== null) {
      if (!Number.isSafeInteger(runtime.ownerPid) || runtime.ownerPid <= 0 || runtime.ownerPid > 2147483647) {
        refuse("runtime_owner_unknown", runtimePath, "exit the local Clawd first");
      }
      let alive = true;
      try { kill(runtime.ownerPid, 0); } catch (err) { if (err.code === "ESRCH") alive = false; }
      if (alive) refuse("local_clawd_conflict", runtimePath, `PID ${runtime.ownerPid}`);
    }
    const identity = readIdentity();
    function agentPresent(target) {
      safePath(target);
      const st = stat(target);
      if (st && !st.isDirectory()) refuse("agent_root_invalid", target);
      return !!st;
    }
    // Check every managed path, including absent leaves with existing parents.
    for (const [key, value] of Object.entries(layout)) {
      if (typeof value === "string" && (key.endsWith("File") || key.endsWith("Dir"))) safePath(value);
    }
    const traces = [layout.secureMarkerFile, layout.hostPrefixFile, p.join(layout.claudeHooksDir, "server-config.js")];
    const configs = [layout.claudeSettingsFile, p.join(layout.copilotHome, "hooks", "hooks.json"), p.join(layout.copilotHome, "settings.json")];
    const configTraces = configs.filter((target) => {
      const text = readText(target);
      return text !== null && ["clawd-hook.js", "auto-start.js", "copilot-hook.js", "claude-statusline.js"].some((marker) => text.includes(marker));
    });
    return {
      ok: true, identity: !!identity,
      claudePresent: agentPresent(layout.claudeConfigDir),
      copilotPresent: agentPresent(layout.copilotHome), codexPresent: false,
      legacyTraces: traces.filter((target) => { safePath(target); return !!stat(target); }).length,
      legacyConfigTraces: configTraces.length,
    };
  }
  if (operation === "readIdentity") return { identity: readIdentity() };
  if (operation === "readMarker") return { text: readText(layout.secureMarkerFile) };
  if (operation === "readHostPrefix") return { text: readText(layout.hostPrefixFile) };
  if (operation === "hash") return { ok: true, hash: hash(args.target) };

  if (operation === "acquireLock") {
    validateOwner(args.owner);
    safePath(layout.deployLockDir);
    try { fs.mkdirSync(layout.deployLockDir); } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const owner = readJson(ownerFile, "lock_owner_invalid");
      validateOwner(owner);
      return { ok: false, reason: "lock_busy", owner };
    }
    // An uncertain owner write leaves the exact lock for manual inspection.
    await atomicWrite(ownerFile, JSON.stringify(args.owner));
    return { ok: true, owner: args.owner };
  }

  assertLease();
  if (operation === "readClaudePermission") {
    const settings = readJson(layout.claudeSettingsFile, "installer_config_invalid", true);
    if (!settings) refuse("installer_config_invalid", layout.claudeSettingsFile);
    const identity = readIdentity();
    if (!identity) refuse("ownership_unverified", layout.identityFile);
    const ours = flatten(settings && settings.hooks && settings.hooks.PermissionRequest)
      .find((hook) => hook && typeof hook.url === "string" && hook.url.includes("127.0.0.1:"));
    if (!ours) return { ok: true, mode: "native" };
    const url = new URL(ours.url);
    const nonce = url.pathname === "/permission" ? url.searchParams.get("nonce") : url.pathname.split("/").pop();
    if (nonce !== identity.routingNonce) refuse("permission_nonce_mismatch", layout.claudeSettingsFile);
    return { ok: true, mode: "managed" };
  } else if (operation === "runInstaller") {
    if (typeof args.script !== "string" || !/^[a-zA-Z0-9._-]+\.js$/.test(args.script)) refuse("installer_script_invalid", String(args.script));
    const script = safePath(p.join(layout.claudeHooksDir, args.script));
    const env = { ...(deps.env || process.env) };
    for (const [key, value] of Object.entries(args.env)) {
      for (const oldKey of Object.keys(env)) {
        if (oldKey.toUpperCase() === key.toUpperCase()) delete env[oldKey];
      }
      env[key] = value;
    }
    const result = (deps.spawnSync || require("child_process").spawnSync)(deps.execPath || process.execPath, [script, ...args.argv], {
      // Leave time within the controller's 60s SSH deadline to report and drain.
      env, windowsHide: true, encoding: "utf8", timeout: args.timeout || 45000,
    });
    // A timed out/signalled installer may still have mutated its config. The
    // controller must retain the lease for manual inspection in that case.
    if (result.signal || (result.error && result.error.code === "ETIMEDOUT")) refuse("installer_result_unknown", script);
    let verified = false;
    if (result.status === 0) verified = verifyInstaller();
    return {
      ok: result.status === 0 && verified, status: result.status,
      ...(result.status !== 0 ? { reason: "installer_failed" } : (!verified ? { reason: "installer_verification_failed" } : {})),
      stdoutTail: String(result.stdout || "").slice(-2000), stderrTail: String(result.stderr || (result.error && result.error.message) || "").slice(-2000),
      verified,
    };
  } else if (operation === "releaseLock") {
    const entries = fs.readdirSync(layout.deployLockDir);
    if (entries.length !== 1 || entries[0] !== "owner") refuse("lock_contents_unknown", layout.deployLockDir);
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(layout.deployLockDir);
  } else if (operation === "mkdir") {
    for (const target of args.directories) {
      safePath(target);
      const codexRelative = p.relative(layout.codexHome, target);
      if (codexRelative === "" || (!codexRelative.startsWith(`..${p.sep}`) && codexRelative !== ".." && !p.isAbsolute(codexRelative))) {
        refuse("codex_unsupported", target);
      }
      fs.mkdirSync(target, { recursive: true });
    }
  } else if (operation === "writeIdentity") {
    validateIdentity(args.identity);
    await atomicWrite(layout.identityFile, JSON.stringify(args.identity));
    if (JSON.stringify(readIdentity()) !== JSON.stringify(args.identity)) refuse("readback_mismatch", layout.identityFile);
  } else if (operation === "writeMarker") {
    const marker = "clawd-ssh-secure-v1";
    await atomicWrite(layout.secureMarkerFile, marker);
    if (readText(layout.secureMarkerFile) !== marker) refuse("readback_mismatch", layout.secureMarkerFile);
  } else if (operation === "writeHostPrefix") {
    if (typeof args.text !== "string" || /[\x00-\x1f\x7f'"`$\\!]/.test(args.text)) refuse("host_prefix_invalid", layout.hostPrefixFile);
    await atomicWrite(layout.hostPrefixFile, args.text);
    if (readText(layout.hostPrefixFile) !== args.text) refuse("readback_mismatch", layout.hostPrefixFile);
  } else if (operation === "promote") {
    if (!/^[a-f0-9]{64}$/.test(args.hash) || hash(args.source) !== args.hash) refuse("hash_mismatch", args.source);
    await rename(args.source, args.target);
    if (hash(args.target) !== args.hash) refuse("hash_mismatch", args.target);
  } else if (operation === "promoteMany") {
    const staging = safePath(p.join(layout.deployStagingDir, args.owner.leaseId));
    const files = Object.entries(args.hashes);
    // Reject malformed manifests before moving any staged file.
    for (const [name, expectedHash] of files) {
      if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes("..") || name === ".") refuse("path_invalid", name);
      if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) refuse("hash_mismatch", p.join(staging, name));
    }
    for (const [name, expectedHash] of files) {
      const source = p.join(staging, name);
      const target = p.join(layout.claudeHooksDir, name);
      if (hash(source) !== expectedHash) refuse("hash_mismatch", source);
      await rename(source, target);
      if (hash(target) !== expectedHash) refuse("hash_mismatch", target);
    }
    safePath(staging);
    if (fs.readdirSync(staging).length) refuse("staging_contents_unknown", staging);
    fs.rmdirSync(staging);
  } else if (operation === "finalizeIdentity") {
    const identity = readIdentity();
    if (!identity && readText(layout.secureMarkerFile) !== null) refuse("retirement_marker_without_identity", layout.secureMarkerFile);
    for (const target of [layout.identityFile, layout.secureMarkerFile]) {
      safePath(target);
      try { fs.unlinkSync(target); } catch (err) { if (err.code !== "ENOENT") throw err; }
      if (stat(target)) refuse("readback_mismatch", target);
    }
  } else if (operation === "removeFiles") {
    // Callers must verify ownership of each file before supplying this list.
    // This operation only verifies that the deployment identity exists and
    // matches expected; it does not establish ownership of individual files.
    const identity = readIdentity();
    if (!identity) refuse("ownership_unverified", layout.identityFile);
    for (const target of args.files) {
      safePath(target);
      const st = stat(target);
      if (st && !st.isFile()) refuse("cleanup_not_file", target);
    }
    for (const target of args.files) {
      try { fs.unlinkSync(target); } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  } else {
    refuse("operation_unknown", String(operation));
  }
  return { ok: true };
}

function buildWindowsOperationFrame({ execPath, layout, ...args }) {
  if (!layout || layout.platform !== "win32") throw new TypeError("Windows remote layout required");
  if (!isValidRemoteNodeBin(execPath, "win32")) throw new TypeError("A probed Windows Node execPath is required");
  if (["preflight", "readIdentity", "removeFiles", "writeIdentity", "readClaudePermission", "finalizeIdentity"].includes(args.operation)) {
    const expected = args.expected;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)
      || typeof expected.installId !== "string" || !/^[a-f0-9]{64}$/.test(expected.installId)
      || typeof expected.profileId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(expected.profileId)
      || typeof expected.runtimeKey !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(expected.runtimeKey)
      || expected.layoutVersion !== 1) {
      throw new TypeError("expected must contain a valid installId, profileId, runtimeKey and layoutVersion");
    }
  }
  const code = `return (${windowsOperation.toString()})(args).then(result=>console.log(JSON.stringify(result)));`;
  return buildNodeProgramFrame(code, { ...args, layout: { ...layout, platform: layout.platform } }, execPath);
}

async function runWindowsOperation({ profile, spawn, buildSshArgs, runtime, timeoutMs, ...operation }) {
  return runRemoteNodeFrame({ profile, spawn, buildSshArgs, runtime, timeoutMs, frame: buildWindowsOperationFrame(operation) });
}

module.exports = { buildWindowsOperationFrame, runWindowsOperation, __test: { windowsOperation } };
