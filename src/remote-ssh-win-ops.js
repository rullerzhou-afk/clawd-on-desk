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
  function normalizeCodexCommandPath(value) {
    return p.normalize(String(value).replace(/\//g, "\\")).replace(/\\/g, "/").toLowerCase();
  }
  function quotedCodexArguments(command) {
    const args = [];
    const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'/g;
    let match;
    while ((match = pattern.exec(command)) !== null) args.push(match[1] !== undefined ? match[1] : match[2]);
    return args;
  }
  function hasResidualCodexReference(settings) {
    const script = normalizeCodexCommandPath(p.join(layout.claudeHooksDir, "codex-hook.js"));
    return Object.values((settings && object(settings.hooks) ? settings.hooks : {})).some((entries) =>
      (Array.isArray(entries) ? entries : []).some((entry) => flatten([entry]).some((hook) => {
        if (!hook || typeof hook !== "object") return false;
        return [hook.command, hook.commandWindows].some((value) => {
          if (typeof value !== "string") return false;
          if (quotedCodexArguments(value).some((arg) => normalizeCodexCommandPath(arg) === script)) return true;
          return normalizeCodexCommandPath(value).includes(script);
        });
      })));
  }
  function readCodexHooksForCleanup() {
    const hooksPath = p.join(layout.codexHome, "hooks.json");
    let text;
    try { text = readText(hooksPath); } catch (err) {
      return { ok: false, message: `hooks.json unreadable: ${err && err.message ? err.message : "read failed"}` };
    }
    if (text === null) return { ok: true, missing: true, settings: { hooks: {} } };
    let settings;
    try { settings = JSON.parse(text.replace(/^\uFEFF/, "")); } catch {
      return { ok: false, message: "hooks.json unreadable: invalid JSON" };
    }
    if (!object(settings) || !object(settings.hooks)) settings = { hooks: {} };
    return { ok: true, missing: false, settings };
  }
  function verifyInstaller() {
    if (!args.verify) return true;
    if (args.verify === "installCodex") {
      const hooksPath = p.join(layout.codexHome, "hooks.json");
      const text = readText(hooksPath);
      // A BOM or an unparseable file makes Windows Codex reject the whole file.
      if (text === null || text.startsWith("\uFEFF")) return false;
      let settings;
      try { settings = JSON.parse(text); } catch { return false; }
      if (!object(settings) || !object(settings.hooks)) return false;
      const tools = (deps.require || require)(safePath(p.join(layout.claudeHooksDir, "codex-install-utils.js")));
      const installer = (deps.require || require)(safePath(p.join(layout.claudeHooksDir, args.script)));
      const classify = tools.classifyWindowsRemoteCodexHook;
      const events = installer.CODEX_STATE_HOOK_EVENTS;
      if (typeof classify !== "function" || typeof tools.isOwnedWindowsRemoteCodexCommand !== "function"
        || !Array.isArray(events) || events.length === 0) return false;
      const disallowed = new Set(["local-clawd", "conflict", "unknown-clawd"]);
      const owned = events.every((event) => {
        const hooks = flatten(settings.hooks[event]);
        const classes = hooks.map((hook) => classify(hook, { hooksDir: layout.claudeHooksDir }));
        const oursIndex = classes.indexOf("ours");
        return classes.filter((value) => value === "ours").length === 1
          && !classes.some((value) => disallowed.has(value))
          && !!tools.isOwnedWindowsRemoteCodexCommand(hooks[oursIndex] && hooks[oursIndex].command, {
            hooksDir: layout.claudeHooksDir,
          });
      });
      if (!owned) return false;
      const feature = tools.readCodexHooksFeatureState(readText(p.join(layout.codexHome, "config.toml")));
      if (feature === "off") refuse("windows_codex_hooks_disabled", p.join(layout.codexHome, "config.toml"));
      return feature === "on";
    }
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

  function normalizeDshPath(value) {
    return p.normalize(String(value)).toLowerCase();
  }
  function dshPathWithin(candidate, root) {
    const child = normalizeDshPath(candidate);
    const parent = normalizeDshPath(root);
    return child === parent || child.startsWith(`${parent}${p.sep}`);
  }
  // Mirror hooks/dsh-install.js dependencySourcePath so preflight, cleanup and
  // the installer agree on `file:` / `link:` / slash / URL-encoding forms.
  function resolveDshDependencySpec(spec, profileDir) {
    if (typeof spec !== "string" || !spec.trim()) return null;
    const match = spec.trim().match(/^(?:file|link):(.*)$/i);
    if (!match || !match[1]) return null;
    let value = match[1];
    try { value = decodeURIComponent(value); } catch {}
    if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
    return p.resolve(profileDir, value);
  }
  function pathContainsLink(target, stopAt) {
    let cursor = p.normalize(target);
    const stop = stopAt ? p.normalize(stopAt) : p.parse(cursor).root;
    while (true) {
      try {
        const st = fs.lstatSync(cursor);
        if (st && st.isSymbolicLink()) return cursor;
      } catch (err) {
        if (!err || err.code !== "ENOENT") refuse("path_unreadable", cursor, err && err.code);
      }
      if (cursor === stop) break;
      const parent = p.dirname(cursor);
      if (parent === cursor || !cursor.startsWith(`${stop}${p.sep}`)) break;
      cursor = parent;
    }
    return null;
  }
  function canonicalDshHome(raw) {
    const resolved = p.resolve(raw);
    const realpath = deps.realpathSync || fs.realpathSync.native || fs.realpathSync;
    let cursor = resolved;
    const suffix = [];
    while (true) {
      try {
        const real = realpath(cursor);
        return p.join(real, ...suffix);
      } catch {}
      const parent = p.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.unshift(p.basename(cursor));
      cursor = parent;
    }
  }
  function dshEnvHome() {
    const env = deps.env || process.env || {};
    const raw = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
    return raw ? canonicalDshHome(raw) : canonicalDshHome(p.join(layout.remoteHome, ".dsh"));
  }
  function discoverDshPreflight() {
    const pathApi = p;
    const remoteRoot = pathApi.join(layout.clawdStateDir, "remote-integrations", "deepseek-harness");
    const defaultDshHome = canonicalDshHome(pathApi.join(layout.remoteHome, ".dsh"));
    const envHome = dshEnvHome();
    let dshHome = envHome;
    let homeAmbiguous = false;
    if (normalizeDshPath(envHome) !== normalizeDshPath(defaultDshHome)) {
      const envProfile = pathApi.join(envHome, "profiles", "desktop", "package.json");
      const defaultProfile = pathApi.join(defaultDshHome, "profiles", "desktop", "package.json");
      const envHasProfile = (() => { try { fs.statSync(envProfile); return true; } catch { return false; } })();
      const defaultHasProfile = (() => { try { fs.statSync(defaultProfile); return true; } catch { return false; } })();
      if (envHasProfile && defaultHasProfile) homeAmbiguous = true;
      if (!envHasProfile && defaultHasProfile) homeAmbiguous = true;
      dshHome = envHome;
    }
    const profilePath = pathApi.join(dshHome, "profiles", "desktop", "package.json");
    let profileInitialized = false;
    let profileReadable = true;
    let localClawdLinked = null;
    try {
      const text = fs.readFileSync(profilePath, "utf8");
      profileInitialized = true;
      const manifest = JSON.parse(text.replace(/^\uFEFF/, ""));
      const spec = manifest && manifest.dependencies && manifest.dependencies["@dsh-external/dsh-clawd-bridge"];
      const resolved = resolveDshDependencySpec(spec, pathApi.dirname(profilePath));
      const localRoot = pathApi.join(layout.remoteHome, ".clawd", "integrations", "deepseek-harness");
      localClawdLinked = !!resolved && dshPathWithin(resolved, localRoot);
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        profileInitialized = true;
        profileReadable = false;
      }
    }
    const discovery = deps.dshDesktopDiscovery !== undefined
      ? deps.dshDesktopDiscovery
      : runDshDiscoveryScript();
    let status = discovery && discovery.status ? discovery.status : "unknown";
    let appRoot = discovery && discovery.appRoot ? discovery.appRoot : null;
    let checkedPaths = discovery && Array.isArray(discovery.checkedPaths) ? discovery.checkedPaths : [];
    let reason = discovery && discovery.reason ? discovery.reason : null;
    if (status === "absent" && reason === "registry-unreadable"
      && (profileInitialized || (discovery && discovery.defaultLocationExists))) {
      status = "unknown";
    }
    if (homeAmbiguous) return {
      status: "unknown", appRoot: null, checkedPaths: [], reason: "dsh-home-ambiguous",
      profileInitialized, profileReadable, localClawdLinked, dshHome,
      remoteRoot, remoteRootExists: !!stat(remoteRoot),
    };
    if (status === "present") {
      const linkedRoot = pathContainsLink(remoteRoot, layout.clawdStateDir)
        || pathContainsLink(profilePath, dshHome);
      if (linkedRoot) refuse("path_link", linkedRoot);
    }
    return {
      status,
      appRoot,
      checkedPaths,
      reason,
      profileInitialized,
      profileReadable,
      localClawdLinked,
      dshHome,
      remoteRoot,
      remoteRootExists: !!stat(remoteRoot),
    };
  }
  function runDshDiscoveryScript() {
    const pathApi = p;
    const localAppData = (deps.env || process.env || {}).LOCALAPPDATA || (deps.env || process.env || {}).LocalAppData || "";
    const knownRoot = localAppData ? pathApi.join(localAppData, "Programs", "DeepSeek Harness") : null;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "try {",
      "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "  $root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
      "  $entries = @()",
      "  if (Test-Path -LiteralPath $root) {",
      "    foreach ($key in Get-ChildItem -LiteralPath $root) {",
      "      $p = Get-ItemProperty -LiteralPath $key.PSPath",
      "      if ($p.DisplayName -is [string] -and $p.DisplayName.StartsWith('DeepSeek Harness ')) {",
      "        $g = 'HKCU:\\Software\\' + $key.PSChildName",
      "        $gi = $null",
      "        if (Test-Path -LiteralPath $g) { $gi = (Get-ItemProperty -LiteralPath $g).InstallLocation }",
      "        $entries += [pscustomobject]@{ installLocation = $p.InstallLocation; guidInstallLocation = $gi }",
      "      }",
      "    }",
      "  }",
      "  $commandDirectory = $null",
      "  $commandPath = 'HKCU:\\Software\\DeepSeekHarness\\Command'",
      "  if (Test-Path -LiteralPath $commandPath) { $commandDirectory = (Get-ItemProperty -LiteralPath $commandPath).Directory }",
      "  [pscustomobject]@{ uninstall = @($entries); commandDirectory = $commandDirectory } | ConvertTo-Json -Depth 5 -Compress",
      "  exit 0",
      "} catch { exit 1 }",
    ].join("\n");
    const systemRoot = (deps.env || process.env || {}).SystemRoot || (deps.env || process.env || {}).SYSTEMROOT || "C:\\Windows";
    const powershell = pathApi.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const spawnProcess = deps.spawnSync || require("child_process").spawnSync;
    const result = spawnProcess(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", (deps.Buffer || require("buffer").Buffer).from(script, "utf16le").toString("base64"),
    ], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    let parsed = null;
    if (result && result.status === 0) {
      try { parsed = JSON.parse(String(result.stdout || "")); } catch {}
    }
    const roots = new Map();
    function addRoot(candidate) {
      if (typeof candidate !== "string" || !candidate) return;
      const normalized = pathApi.normalize(candidate);
      const key = normalized.toLowerCase();
      if (!roots.has(key)) roots.set(key, normalized);
    }
    if (parsed && Array.isArray(parsed.uninstall)) {
      for (const entry of parsed.uninstall) {
        addRoot(entry.installLocation);
        addRoot(entry.guidInstallLocation);
      }
    }
    if (parsed) addRoot(parsed.commandDirectory);
    const registryRootCount = roots.size;
    let unreadable = false;
    let defaultLocationExists = false;
    if (knownRoot) {
      try {
        const st = fs.lstatSync(knownRoot);
        defaultLocationExists = !!st;
      } catch (err) {
        if (err && err.code !== "ENOENT") unreadable = true;
      }
    }
    addRoot(knownRoot);
    const valid = [];
    for (const root of roots.values()) {
      try {
        const files = [
          pathApi.join(root, "DeepSeek Harness.exe"),
          pathApi.join(root, "resources", "app.asar"),
          pathApi.join(root, "resources", "runtime", "cli", "bin", "dsh.cmd"),
        ];
        let all = true;
        for (const file of files) {
          try {
            if (!fs.statSync(file).isFile()) { all = false; break; }
          } catch (err) {
            if (!err || err.code === "ENOENT" || err.code === "ENOTDIR") { all = false; break; }
            throw err;
          }
        }
        if (all) valid.push(root);
      } catch {
        unreadable = true;
      }
    }
    const checked = [...roots.values()];
    if (valid.length > 1) return { status: "ambiguous", appRoot: null, checkedPaths: valid, reason: "multiple-desktop-installs" };
    if (valid.length === 1) return { status: "present", appRoot: valid[0], checkedPaths: checked, reason: null };
    if (unreadable) return { status: "unknown", appRoot: null, checkedPaths: checked, reason: "install-directory-unreadable", defaultLocationExists };
    if (parsed) return { status: "absent", appRoot: null, checkedPaths: checked, reason: null, defaultLocationExists };
    if (registryRootCount === 0 && !defaultLocationExists) {
      return { status: "absent", appRoot: null, checkedPaths: checked, reason: "registry-unreadable", defaultLocationExists };
    }
    return { status: "unknown", appRoot: null, checkedPaths: checked, reason: "registry-unreadable", defaultLocationExists };
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
    // The Codex installer writes these leaves itself; reject a link here so no
    // installer ever runs against a redirected hooks.json or config.toml.
    safePath(p.join(layout.codexHome, "hooks.json"));
    safePath(p.join(layout.codexHome, "config.toml"));
    const traces = [layout.secureMarkerFile, layout.hostPrefixFile, p.join(layout.claudeHooksDir, "server-config.js")];
    const configs = [layout.claudeSettingsFile, p.join(layout.copilotHome, "hooks", "hooks.json"), p.join(layout.copilotHome, "settings.json"),
      p.join(layout.codexHome, "hooks.json")];
    const configTraces = configs.filter((target) => {
      const text = readText(target);
      return text !== null && ["clawd-hook.js", "auto-start.js", "copilot-hook.js", "claude-statusline.js", "codex-hook.js"].some((marker) => text.includes(marker));
    });
    const dsh = discoverDshPreflight();
    return {
      ok: true, identity: !!identity,
      claudePresent: agentPresent(layout.claudeConfigDir),
      copilotPresent: agentPresent(layout.copilotHome), codexPresent: agentPresent(layout.codexHome),
      legacyTraces: traces.filter((target) => { safePath(target); return !!stat(target); }).length,
      legacyConfigTraces: configTraces.length,
      dsh,
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
  if (operation === "uninstallCodexOwned") {
    const initial = readCodexHooksForCleanup();
    if (!initial.ok) return { ok: false, reason: "windows_codex_cleanup_incomplete", message: initial.message };
    if (initial.missing) return { ok: true, skipped: true, removed: 0, conflicts: 0, changed: false };
    let installer;
    try {
      installer = (deps.require || require)(safePath(p.join(layout.claudeHooksDir, "codex-install.js")));
    } catch (err) {
      return {
        ok: false, reason: "windows_codex_cleanup_incomplete",
        message: `codex installer unreadable: ${err && err.message ? err.message : "require failed"}`,
      };
    }

    let removed = 0;
    let conflicts = 0;
    let changed = false;
    const hasUninstaller = typeof installer.unregisterRemoteOwnedCodexHooks === "function";
    if (hasUninstaller) {
      let result;
      try {
        result = installer.unregisterRemoteOwnedCodexHooks({ hooksDir: layout.claudeHooksDir, codexDir: layout.codexHome });
      } catch (err) {
        return {
          ok: false, reason: "windows_codex_cleanup_incomplete",
          message: `codex uninstall failed: ${err && err.message ? err.message : "unknown error"}`,
        };
      }
      if (!object(result)) {
        return { ok: false, reason: "windows_codex_cleanup_incomplete", message: "codex uninstall returned an invalid result" };
      }
      removed = result.removed || 0;
      conflicts = result.conflicts || 0;
      changed = !!result.changed;
      if (conflicts > 0) {
        return {
          ok: false, reason: "windows_codex_cleanup_incomplete",
          message: `${conflicts} conflicting Codex hook ${conflicts === 1 ? "entry remains" : "entries remain"} in hooks.json`,
          removed, conflicts, changed,
        };
      }
    }

    // Re-read after the uninstaller ran. Deleting the payload is safe only when
    // no remaining entry still points at this deployment's codex-hook.js.
    const after = readCodexHooksForCleanup();
    if (!after.ok) {
      return {
        ok: false, reason: "windows_codex_cleanup_incomplete", message: after.message,
        removed, conflicts, changed,
      };
    }
    if (hasResidualCodexReference(after.settings)) {
      return {
        ok: false, reason: "windows_codex_cleanup_incomplete",
        message: `hooks.json still references ${p.join(layout.claudeHooksDir, "codex-hook.js")}`,
        removed, conflicts, changed,
      };
    }
    return { ok: true, removed, conflicts: 0, changed, ...(hasUninstaller ? {} : { skipped: true }) };
  } else if (operation === "readClaudePermission") {
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
  } else if (operation === "runInstallerAsUser") {
    // The elevated SSH token cannot traverse junctions created by the logged-on
    // desktop session. Medium runs the installer directly; High needs a
    // one-shot limited scheduled task inside that session. Anything else is
    // refused rather than guessed.
    if (typeof args.script !== "string" || !/^[a-zA-Z0-9._-]+\.js$/.test(args.script)) refuse("installer_script_invalid", String(args.script));
    if (!Array.isArray(args.argv) || args.argv.some((value) => typeof value !== "string")) refuse("installer_arguments_invalid", args.script);
    if (!object(args.env)) refuse("installer_env_invalid", args.script);
    const script = safePath(p.join(layout.claudeHooksDir, args.script));
    const installerTimeoutMs = args.installerTimeoutMs;
    if (!Number.isInteger(installerTimeoutMs) || installerTimeoutMs <= 0) refuse("installer_timeout_invalid", script);
    // The outer SSH budget must cover the inner installer plus the scheduled
    // task's result wait. Comparing against the installer alone is not enough.
    if (args.transportTimeoutMs !== undefined
      && (!Number.isInteger(args.transportTimeoutMs) || args.transportTimeoutMs < installerTimeoutMs + 90000)) {
      refuse("transport_timeout_invalid", script);
    }
    // The installer re-validates the deployment lease under its own mutation
    // lock. Pass the same identity the SSH caller is holding.
    const installerArgv = [...args.argv, "--lease-file", p.join(layout.deployLockDir, "owner"), "--lease-owner", args.owner.leaseId];
    const installEnv = { ...(deps.env || process.env) };
    for (const [key, value] of Object.entries(args.env)) {
      if (typeof value !== "string") refuse("installer_env_invalid", key);
      for (const oldKey of Object.keys(installEnv)) {
        if (oldKey.toUpperCase() === key.toUpperCase()) delete installEnv[oldKey];
      }
      installEnv[key] = value;
    }
    // The scheduled task inherits the desktop session's environment, so the
    // lease only needs the explicit overrides. Avoid persisting the whole SSH
    // session environment (and its credentials) to disk.
    const leaseEnv = {};
    for (const [key, value] of Object.entries(args.env)) {
      if (key.toUpperCase() !== "DSH_HOME") leaseEnv[key] = value;
    }
    const spawnInstaller = deps.spawnSync || require("child_process").spawnSync;
    const nodePath = deps.execPath || process.execPath;

    function parseIntensityFromWhoami(text) {
      const match = String(text || "").match(/S-1-16-(4096|8192|12288|16384)/i);
      return match ? ({ "4096": "low", "8192": "medium", "12288": "high", "16384": "system" })[match[1]] : null;
    }
    function runWhoami(argsList) {
      const result = spawnInstaller("whoami", argsList, { encoding: "utf8", windowsHide: true, timeout: 10000 });
      return result && !result.error && !result.signal && result.status === 0 ? String(result.stdout || "") : null;
    }
    function currentIntegrity() {
      if (typeof deps.currentIntegrity === "function") return deps.currentIntegrity();
      if (typeof deps.currentIntegrity === "string") return deps.currentIntegrity;
      const output = runWhoami(["/groups", "/fo", "csv", "/nh"]);
      return output === null ? null : parseIntensityFromWhoami(output);
    }
    function currentSid() {
      if (typeof deps.currentUserSid === "function") return deps.currentUserSid();
      if (typeof deps.currentUserSid === "string") return deps.currentUserSid;
      const output = runWhoami(["/user", "/fo", "csv", "/nh"]);
      if (output === null) return null;
      const match = output.match(/\b(S-1-\d+(?:-\d+)+)\b/);
      return match ? match[1] : null;
    }
    function parseResultSentinel(stdout) {
      const lines = String(stdout || "").split(/\r?\n/).filter((line) => line.startsWith("CLAWD_DSH_RESULT_V1="));
      if (lines.length !== 1) return null;
      try {
        const parsed = JSON.parse(lines[0].slice("CLAWD_DSH_RESULT_V1=".length));
        if (!object(parsed) || parsed.schemaVersion !== 1) return null;
        if (!["ok", "skipped", "error"].includes(parsed.status)) return null;
        return parsed;
      } catch {
        return null;
      }
    }
    function runWindowsCommand(command, argv) {
      const result = spawnInstaller(command, argv, {
        encoding: "utf8", windowsHide: true, timeout: args.commandTimeoutMs || 30000,
      });
      return result && object(result) ? result : { status: null, stderr: "command failed" };
    }
    function xmlEscape(value) {
      return String(value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    }
    function quoteTaskArgument(value) {
      return `"${String(value).replace(/"/g, '\\"')}"`;
    }
    function readTaskResult(filePath) {
      let raw;
      try { raw = fs.readFileSync(filePath, "utf8"); } catch (err) {
        if (err.code === "ENOENT") return null;
        return { __unreadable: true, reason: err.code || "read-error" };
      }
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      try {
        const parsed = JSON.parse(raw);
        return object(parsed) ? parsed : { __invalid: true };
      } catch {
        return { __invalid: true };
      }
    }

    const dshHome = args.dshHome;
    if (typeof dshHome !== "string" || !p.isAbsolute(dshHome)) refuse("dsh_home_invalid", String(dshHome));
    for (const key of Object.keys(installEnv)) {
      if (key.toUpperCase() !== "DSH_HOME") continue;
      if (installEnv[key] !== dshHome) refuse("dsh_home_mismatch", dshHome);
      delete installEnv[key];
    }
    installEnv.DSH_HOME = dshHome;
    leaseEnv.DSH_HOME = dshHome;
    const integrity = currentIntegrity();
    if (integrity === "medium") {
      const result = spawnInstaller(nodePath, [script, ...installerArgv], {
        env: installEnv, cwd: layout.claudeHooksDir, windowsHide: true, encoding: "utf8", timeout: installerTimeoutMs,
      });
      if (!result || !Number.isInteger(result.status)
        || result.signal || (result.error && result.error.code === "ETIMEDOUT")) {
        refuse("installer_result_unknown", script);
      }
      const parsed = parseResultSentinel(result.stdout);
      if (result.status === 0 && !parsed) refuse("installer_result_unknown", script);
      return {
        ok: result.status === 0 && !!parsed && parsed.status !== "error",
        mode: "direct", status: result.status,
        ...(result.status !== 0 || !parsed || parsed.status === "error" ? { reason: "installer_failed" } : {}),
        installerResult: parsed,
        stdoutTail: String(result.stdout || "").slice(-2000),
        stderrTail: String(result.stderr || (result.error && result.error.message) || "").slice(-2000),
      };
    }
    if (integrity !== "high") {
      refuse("windows_user_integrity_unsupported", layout.remoteHome, integrity || "unknown");
    }

    const expectedUserSid = args.expectedUserSid || currentSid();
    // Task Scheduler accepts a SID and it is the only identity that survives a
    // workgroup SSH session, where USERDOMAIN is WORKGROUP and does not map to
    // the real local account. Never fall back to a DOMAIN\user guess.
    if (typeof expectedUserSid !== "string" || !/^S-1-\d+(?:-\d+)+$/.test(expectedUserSid)) {
      refuse("user_sid_unverifiable", layout.remoteHome);
    }
    const operationId = crypto.randomBytes(16).toString("hex");
    const taskName = `ClawdDsh-${String(args.owner.leaseId).slice(0, 8)}-${crypto.randomBytes(4).toString("hex")}`;
    const leaseDir = args.leaseDir || p.join(layout.deployStagingDir, `${args.owner.leaseId}-dsh-${operationId.slice(0, 8)}`);
    safePath(leaseDir);
    if (stat(leaseDir)) refuse("lease_directory_busy", leaseDir);
    fs.mkdirSync(leaseDir, { recursive: true });
    const now = typeof args.now === "function" ? args.now : Date.now;
    const createdAt = now();
    const lease = {
      schemaVersion: 1,
      operationId,
      taskName,
      leaseId: args.owner.leaseId,
      createdAt,
      startDeadline: createdAt + 60000,
      expectedUserSid,
      dshHome,
      installScript: script,
      installArgv: installerArgv,
      installEnv: leaseEnv,
      installerTimeoutMs,
    };
    await atomicWrite(p.join(leaseDir, "lease.json"), `${JSON.stringify(lease, null, 2)}\n`);
    fs.writeFileSync(p.join(leaseDir, `${operationId}.pending`), operationId, { flag: "wx" });
    const entryScript = safePath(p.join(layout.claudeHooksDir, "dsh-remote-task.js"));
    const taskXml = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      "  <RegistrationInfo>",
      `    <Author>${xmlEscape("Clawd on Desk")}</Author>`,
      `    <Description>${xmlEscape(`Clawd DeepSeek Harness installer ${operationId}`)}</Description>`,
      "  </RegistrationInfo>",
      "  <Triggers>",
      // A past one-shot boundary can never fire on its own; only /run starts it.
      "    <TimeTrigger>",
      "      <StartBoundary>2001-01-01T00:00:00</StartBoundary>",
      "      <Enabled>true</Enabled>",
      "    </TimeTrigger>",
      "  </Triggers>",
      "  <Principals>",
      '    <Principal id="Author">',
      `      <UserId>${xmlEscape(expectedUserSid)}</UserId>`,
      "      <LogonType>InteractiveToken</LogonType>",
      "      <RunLevel>LeastPrivilege</RunLevel>",
      "    </Principal>",
      "  </Principals>",
      "  <Settings>",
      "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "    <AllowHardTerminate>true</AllowHardTerminate>",
      "    <StartWhenAvailable>false</StartWhenAvailable>",
      "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
      "    <AllowStartOnDemand>true</AllowStartOnDemand>",
      "    <Enabled>true</Enabled>",
      "    <Hidden>false</Hidden>",
      "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
      "    <WakeToRun>false</WakeToRun>",
      "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "    <Priority>7</Priority>",
      "  </Settings>",
      '  <Actions Context="Author">',
      "    <Exec>",
      `      <Command>${xmlEscape(nodePath)}</Command>`,
      `      <Arguments>${xmlEscape([entryScript, leaseDir, operationId].map(quoteTaskArgument).join(" "))}</Arguments>`,
      "    </Exec>",
      "  </Actions>",
      "</Task>",
      "",
    ].join("\r\n");
    const taskXmlPath = p.join(leaseDir, "task.xml");
    fs.writeFileSync(taskXmlPath, `\uFEFF${taskXml}`, "utf16le");

    let taskMayExist = false;
    let keepLease = false;
    let deleteWarning = null;
    let outcome = null;
    function deleteTask() {
      if (!taskMayExist) return null;
      const deleted = runWindowsCommand("schtasks", ["/delete", "/tn", taskName, "/f"]);
      return deleted.status === 0 ? null : "scheduled_task_delete_failed";
    }
    function validInstallerResult(value) {
      return object(value)
        && value.schemaVersion === 1
        && ["ok", "skipped", "error"].includes(value.status)
        && Object.keys(value).length > 0;
    }
    try {
      taskMayExist = true;
      const created = runWindowsCommand("schtasks", ["/create", "/tn", taskName, "/xml", taskXmlPath, "/f"]);
      if (!Number.isInteger(created.status) || created.status !== 0) {
        const detail = `${created.stdout || ""}\n${created.stderr || ""}`;
        if (/logon|logged[- ]on|interactive|session|用户|登录/i.test(detail)) {
          refuse("windows_dsh_desktop_session_required", layout.remoteHome);
        }
        refuse("scheduled_task_create_failed", taskName, (created.stderr || created.stdout || "").trim());
      }
      const started = runWindowsCommand("schtasks", ["/run", "/tn", taskName]);
      if (!Number.isInteger(started.status)) {
        // A timed-out / killed / unreadable schtasks result cannot prove the
        // task did not start, so keep the lease and report unknown.
        keepLease = true;
        refuse("installer_result_unknown", p.join(leaseDir, "result.json"), "task-run-unknown");
      }
      if (started.status !== 0) {
        const detail = `${started.stdout || ""}\n${started.stderr || ""}`;
        if (/logon|logged[- ]on|interactive|session|用户|登录/i.test(detail)) {
          refuse("windows_dsh_desktop_session_required", layout.remoteHome);
        }
        refuse("scheduled_task_run_failed", taskName, (started.stderr || started.stdout || "").trim());
      }
      const resultPath = p.join(leaseDir, "result.json");
      const delay = deps.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      const waitDeadline = now() + installerTimeoutMs + 90000;
      let taskResult = null;
      while (now() <= waitDeadline) {
        const candidate = readTaskResult(resultPath);
        if (candidate && candidate.__unreadable) {
          keepLease = true;
          refuse("installer_result_unknown", resultPath, `result-${candidate.reason}`);
        }
        if (candidate && candidate.__invalid) {
          keepLease = true;
          refuse("installer_result_unknown", resultPath, "result-invalid-json");
        }
        if (candidate && !candidate.__invalid) {
          if (candidate.schemaVersion !== 1
            || candidate.operationId !== operationId
            || candidate.taskName !== taskName
            || candidate.leaseId !== args.owner.leaseId
            || !["completed", "refused", "unknown"].includes(candidate.status)) {
            keepLease = true;
            refuse("installer_result_unknown", resultPath, "result-incomplete-or-mismatched");
          }
          taskResult = candidate;
          break;
        }
        await delay(250);
      }
      if (!taskResult) {
        keepLease = true;
        refuse("installer_result_unknown", resultPath, "result-missing");
      }
      if (taskResult.status === "unknown") {
        keepLease = true;
        refuse("installer_result_unknown", resultPath, "task-reported-unknown");
      }
      if (taskResult.status === "refused") {
        if (typeof taskResult.reason !== "string" || !taskResult.reason) {
          keepLease = true;
          refuse("installer_result_unknown", resultPath, "refusal-without-reason");
        }
        refuse(taskResult.reason, resultPath);
      }
      const exitCode = taskResult.installerExitCode;
      if (!Number.isInteger(exitCode) || !validInstallerResult(taskResult.installerResult)) {
        keepLease = true;
        refuse("installer_result_unknown", resultPath, "installer-result-incomplete");
      }
      const installerResult = taskResult.installerResult;
      const ok = exitCode === 0 && installerResult.status !== "error";
      outcome = {
        ok,
        mode: "scheduled-task",
        status: exitCode,
        ...(ok ? {} : { reason: "installer_failed" }),
        installerResult,
        operationId,
        taskName,
        detail: taskResult,
      };
    } finally {
      deleteWarning = deleteTask();
      if (!keepLease) {
        try { fs.rmSync(leaseDir, { recursive: true, force: true }); } catch {}
      }
    }
    if (deleteWarning) outcome.warnings = [...(outcome.warnings || []), deleteWarning];
    return outcome;
  } else if (operation === "releaseLock") {
    const entries = fs.readdirSync(layout.deployLockDir);
    if (entries.length !== 1 || entries[0] !== "owner") refuse("lock_contents_unknown", layout.deployLockDir);
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(layout.deployLockDir);
  } else if (operation === "mkdir") {
    for (const target of args.directories) {
      safePath(target);
      // Deployment never creates ~\.codex: the Codex installer owns that root
      // and only runs when the directory already exists.
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
    const staging = args.staging
      ? safePath(args.staging)
      : safePath(p.join(layout.deployStagingDir, args.owner.leaseId));
    const files = Object.entries(args.hashes);
    const relativeRe = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/;
    // Reject malformed manifests before moving any staged file.
    for (const [name, expectedHash] of files) {
      if (!relativeRe.test(name) || name.split("/").includes("..") || name === ".") refuse("path_invalid", name);
      if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) refuse("hash_mismatch", p.join(staging, name));
    }
    const createdDirs = new Set();
    for (const [name, expectedHash] of files) {
      const source = p.join(staging, name);
      const target = p.join(layout.claudeHooksDir, name);
      if (hash(source) !== expectedHash) refuse("hash_mismatch", source);
      safePath(target);
      fs.mkdirSync(p.dirname(target), { recursive: true });
      let cursor = p.dirname(source);
      while (cursor !== staging && cursor.startsWith(`${staging}${p.sep}`)) {
        createdDirs.add(cursor);
        cursor = p.dirname(cursor);
      }
      await rename(source, target);
      if (hash(target) !== expectedHash) refuse("hash_mismatch", target);
    }
    for (const directory of [...createdDirs].sort((a, b) => b.length - a.length)) {
      try { fs.rmdirSync(directory); } catch (err) { if (err.code !== "ENOENT" && err.code !== "ENOTEMPTY") throw err; }
    }
    safePath(staging);
    if (fs.readdirSync(staging).length) refuse("staging_contents_unknown", staging);
    fs.rmdirSync(staging);
  } else if (operation === "rmdirEmpty") {
    for (const target of args.directories) {
      safePath(target);
      try { fs.rmdirSync(target); } catch (err) { if (err.code !== "ENOENT" && err.code !== "ENOTEMPTY") throw err; }
    }
  } else if (operation === "dshCleanupPreflight") {
    const remoteRoot = safePath(args.remoteRoot);
    const installId = args.installId;
    if (!/^[a-f0-9]{64}$/.test(installId || "")) refuse("install_id_invalid", String(installId));
    const installRoot = p.join(remoteRoot, installId);
    const recordPath = p.join(installRoot, "deployment.json");
    let recordExists = false;
    let recordReadable = true;
    let recordInvalid = false;
    let recordPhase = null;
    let recordDshHome = null;
    let recordRaw = null;
    try {
      recordRaw = fs.readFileSync(recordPath, "utf8");
      recordExists = true;
    } catch (err) {
      if (!err || err.code !== "ENOENT") recordReadable = false;
    }
    if (recordRaw !== null) {
      try {
        const record = JSON.parse(recordRaw.replace(/^\uFEFF/, ""));
        if (!record || typeof record !== "object" || typeof record.phase !== "string") recordInvalid = true;
        else {
          recordPhase = record.phase;
          if (typeof record.dshHome === "string" && record.dshHome) recordDshHome = record.dshHome;
        }
      } catch {
        recordInvalid = true;
      }
    }
    const assets = Array.isArray(args.assets) ? args.assets : [];
    let assetPresent = false;
    let assetUnreadable = false;
    for (const relative of assets) {
      if (typeof relative !== "string" || !relative || p.isAbsolute(relative)
        || relative.split(/[\\/]/).includes("..")) refuse("path_invalid", String(relative));
      const target = p.join(layout.claudeHooksDir, ...relative.split("/"));
      try {
        const st = fs.lstatSync(target);
        if (st && st.isSymbolicLink()) assetUnreadable = true;
        else if (st) assetPresent = true;
      } catch (err) {
        if (!err || err.code !== "ENOENT") assetUnreadable = true;
      }
    }
    const installerPath = p.join(layout.claudeHooksDir, "dsh-install.js");
    let installerCapable = false;
    let installerLoadFailed = false;
    try {
      const st = fs.lstatSync(installerPath);
      if (st && st.isSymbolicLink()) installerLoadFailed = true;
      else if (st) {
        try {
          const installer = (deps.require || require)(installerPath);
          installerCapable = typeof installer.uninstallOwnedRemoteDeepSeekHarnessDeployment === "function";
        } catch {
          installerLoadFailed = true;
        }
      }
    } catch (err) {
      if (!err || err.code !== "ENOENT") installerLoadFailed = true;
    }
    const dshHome = recordDshHome
      ? canonicalDshHome(recordDshHome)
      : (typeof args.dshHome === "string" && args.dshHome
        ? canonicalDshHome(args.dshHome)
        : dshEnvHome());
    function profileReference(profile) {
      const profileDir = p.join(dshHome, "profiles", profile);
      const manifestPath = p.join(profileDir, "package.json");
      let state = "missing";
      let manifestError = null;
      let dependencyPath = null;
      let dependencyReferenced = false;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
        state = "present";
        const spec = manifest && manifest.dependencies && manifest.dependencies["@dsh-external/dsh-clawd-bridge"];
        if (typeof spec === "string") {
          dependencyPath = resolveDshDependencySpec(spec, profileDir);
          dependencyReferenced = !!dependencyPath && dshPathWithin(dependencyPath, installRoot);
        }
      } catch (err) {
        if (err && err.code === "ENOENT") state = "missing";
        else state = "unreadable";
        if (state === "unreadable") manifestError = "manifest-unreadable";
      }
      let linkState = "missing";
      let linkReferenced = false;
      const link = p.join(profileDir, "node_modules", "@dsh-external", "dsh-clawd-bridge");
      try {
        const st = fs.lstatSync(link);
        if (st && st.isSymbolicLink()) {
          linkState = "link";
          try {
            const rawTarget = fs.readlinkSync(link);
            const resolved = p.resolve(p.dirname(link), rawTarget);
            linkReferenced = dshPathWithin(resolved, installRoot);
          } catch {
            linkState = "unreadable";
          }
        } else {
          linkState = "not-link";
        }
      } catch (err) {
        if (!err || err.code !== "ENOENT") linkState = "unreadable";
      }
      return {
        state,
        manifestError,
        dependencyPath,
        dependencyReferenced,
        linkState,
        linkReferenced,
        referenced: dependencyReferenced || linkReferenced,
        unreadable: state === "unreadable" || linkState === "unreadable",
      };
    }
    const desktop = profileReference("desktop");
    const web = profileReference("web");
    return {
      ok: true,
      assetPresent,
      assetUnreadable,
      recordExists,
      recordReadable,
      recordInvalid,
      recordPhase,
      installerCapable,
      installerLoadFailed,
      dshHome,
      desktop,
      web,
      remoteRoot,
      installRoot,
    };
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

// The DeepSeek Harness installer may wait on DSH's upstream profile write lock
// for up to 300s. The inner installer budget therefore has its own default,
// separate from the 45s used by the Claude / Copilot / Codex installers. The
// outer SSH command must always outlive the inner process plus the scheduled
// task's startup and result-file poll.
const DSH_INSTALLER_TIMEOUT_MS = 300000;
const USER_INSTALLER_RESULT_OVERHEAD_MS = 90000;

function windowsUserInstallerBudgets(installerTimeoutMs = DSH_INSTALLER_TIMEOUT_MS) {
  const inner = Number.isInteger(installerTimeoutMs) && installerTimeoutMs > 0
    ? installerTimeoutMs
    : DSH_INSTALLER_TIMEOUT_MS;
  return {
    installerTimeoutMs: inner,
    resultWaitMs: inner + USER_INSTALLER_RESULT_OVERHEAD_MS,
    // installer + result wait + up to three 30s schtasks calls + drain margin.
    transportTimeoutMs: inner + USER_INSTALLER_RESULT_OVERHEAD_MS + 90000,
  };
}

module.exports = {
  buildWindowsOperationFrame,
  runWindowsOperation,
  windowsUserInstallerBudgets,
  DSH_INSTALLER_TIMEOUT_MS,
  __test: { windowsOperation },
};
