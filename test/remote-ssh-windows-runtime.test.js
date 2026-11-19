"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { buildProbeCommand, buildPersistentReadinessCommand, classifyProbeExit,
  CLAWD_SERVER_HEADER, CLAWD_SERVER_ID } = require("../src/remote-ssh-runtime");
const { resolveRemoteRuntimeLayout } = require("../src/remote-ssh-layout");
const { NODE_FRAME_LOADER, REMOTE_NODE_LAUNCH_COMMAND, writeNodeFrame } = require("../src/remote-ssh-node-launch");
const utils = require("../hooks/json-utils");
const { CLAUDE_CORE_HOOK_EVENTS } = require("../hooks/install");
const { COPILOT_STATE_HOOK_EVENTS } = require("../hooks/copilot-install");
const { CODEX_STATE_HOOK_EVENTS } = require("../hooks/codex-install");
const codexUtils = require("../hooks/codex-install-utils");

const profile = {
  id: "windows", host: "remote", remoteForwardPort: 23334, remotePlatform: "win32",
  remoteHome: "C:\\Users\\remote", runtimeKey: "account-default", runtimeMode: "account-default",
  installId: "a".repeat(64), layoutVersion: 1, detectedRemoteNodeBin: "C:\\Node\\node.exe",
  identityTxn: { steps: Object.fromEntries(["installClaude", "installCopilot", "claudePermission", "installCodex"].map((step) => [step, { status: "done" }])) },
};
const layout = resolveRemoteRuntimeLayout(profile);
const identity = { version: 2, installId: profile.installId, profileId: profile.id,
  runtimeKey: profile.runtimeKey, layoutVersion: 1, remotePort: profile.remoteForwardPort,
  routingNonce: "b".repeat(32), deployedAt: 100 };
const script = (name) => path.win32.join(layout.claudeHooksDir, name);
function configs() {
  return {
    claude: { hooks: { ...Object.fromEntries(CLAUDE_CORE_HOOK_EVENTS.map((event) => [event, [{ hooks: [{
      type: "command", command: profile.detectedRemoteNodeBin,
      args: [script("clawd-hook.js").toUpperCase().replace(/\\/g, "/"), event, "--clawd-ssh-remote"],
    }] }]])), PermissionRequest: [{ hooks: [{ type: "http", url: `http://127.0.0.1:23334/permission/${identity.routingNonce}` }] }] } },
    copilot: { hooks: Object.fromEntries(COPILOT_STATE_HOOK_EVENTS.map((event) => [event, [{
      powershell: `$env:CLAWD_REMOTE='1'; & "${profile.detectedRemoteNodeBin}" "${script("copilot-hook.js")}" "${event}"`,
    }]])) },
    codex: { hooks: Object.fromEntries(CODEX_STATE_HOOK_EVENTS.map((event) => [event, [{ hooks: [{
      type: "command",
      commandWindows: `$env:CLAWD_REMOTE='1'; $env:CLAWD_SSH_REMOTE='1'; & "${profile.detectedRemoteNodeBin}" "${script("codex-hook.js")}" "--clawd-ssh-remote"`,
      command: `"${profile.detectedRemoteNodeBin}" "${script("codex-hook.js")}" --clawd-wsl-interop --clawd-ssh-remote`,
      timeout: 30,
    }] }]])) },
  };
}
function runProbe({ current = profile, config = configs(), execPath = current.detectedRemoteNodeBin,
  readError = false, invalidJson = false, copilotBom = false, claudeBom = false, codexBom = false, codexInvalidJson = false,
  persistent = false, claudeEvents = CLAUDE_CORE_HOOK_EVENTS, copilotEvents = COPILOT_STATE_HOOK_EVENTS,
  codexEvents = CODEX_STATE_HOOK_EVENTS, dshFiles = null } = {}) {
  const built = persistent
    ? buildPersistentReadinessCommand(current.remoteForwardPort, execPath, { profile: current, challenge: "c".repeat(32) })
    : buildProbeCommand(current.remoteForwardPort, execPath, { profile: current });
  assert.equal(built.command, REMOTE_NODE_LAUNCH_COMMAND);
  const frame = JSON.parse(built.frame);
  const reads = [], requests = [], stderr = [];
  let exitCode;
  const exit = (code) => { exitCode = code; throw new Error(`exit:${code}`); };
  const fakeRequire = (name) => {
    if (name === "path") return path;
    if (name === "fs") return { readFileSync(file) {
      reads.push(file);
      if (file === layout.identityFile) return JSON.stringify(identity);
      if (dshFiles && Object.prototype.hasOwnProperty.call(dshFiles, file)) {
        const value = dshFiles[file];
        if (value && value.__error) { const err = new Error(value.__error); err.code = value.__error; throw err; }
        if (value && typeof value === "object" && Object.hasOwn(value, "__raw")) return value.__raw;
        return value;
      }
      if (/[\\/]remote-integrations[\\/]deepseek-harness[\\/]/.test(file)
        || /[\\/]\.dsh[\\/]profiles[\\/]/.test(file)) {
        const err = new Error("ENOENT"); err.code = "ENOENT"; throw err;
      }
      if (readError) throw new Error("EACCES");
      if (invalidJson) return "{broken";
      const codexHooksPath = path.win32.join(layout.codexHome, "hooks.json");
      const value = file === layout.claudeSettingsFile ? config.claude
        : file === codexHooksPath ? config.codex : config.copilot;
      if (value === undefined) { const err = new Error("ENOENT"); err.code = "ENOENT"; throw err; }
      if (codexInvalidJson && file === codexHooksPath) return "{broken";
      return (((copilotBom && file !== layout.claudeSettingsFile && file !== codexHooksPath)
        || (claudeBom && file === layout.claudeSettingsFile)
        || (codexBom && file === codexHooksPath)) ? "\uFEFF" : "") + JSON.stringify(value);
    } };
    if (name === script("json-utils.js")) return utils;
    if (name === script("server-config.js")) return require("../hooks/server-config");
    if (name === script("install.js")) return { CLAUDE_CORE_HOOK_EVENTS: claudeEvents };
    if (name === script("copilot-install.js")) return { COPILOT_STATE_HOOK_EVENTS: copilotEvents };
    if (name === script("codex-install.js")) return { CODEX_STATE_HOOK_EVENTS: codexEvents };
    if (name === script("codex-install-utils.js")) return codexUtils;
    if (name === "crypto") return require("crypto");
    if (name === "http") return { get(options, callback) {
      requests.push(options);
      callback({ headers: { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID }, statusCode: 200 });
    } };
    throw new Error(`Unexpected require: ${name}`);
  };
  try {
    vm.runInNewContext(`(function(args,require){${frame.code}})(args,require)`, {
      args: frame.args, require: fakeRequire, URL, console: { error: (message) => stderr.push(String(message)) },
      process: { platform: "win32", execPath, exit },
    });
  } catch (err) { assert.match(err.message, /^exit:/); }
  return { exitCode, reads, requests, frame, stderr };
}

test("issue #1316: Windows probe and readiness use fixed launcher and framed native paths", () => {
  const probe = buildProbeCommand(23334, profile.detectedRemoteNodeBin, { profile });
  const ready = buildPersistentReadinessCommand(23334, profile.detectedRemoteNodeBin, { profile, challenge: "c".repeat(32) });
  for (const built of [probe, ready]) {
    assert.equal(built.command, REMOTE_NODE_LAUNCH_COMMAND);
    assert.equal(JSON.parse(built.frame).args.layout.identityFile, layout.identityFile);
    assert.match(JSON.parse(built.frame).code, /sameExecPath/);
  }
  assert.match(JSON.parse(ready.frame).code, /process\.stdin\.resume\(\)/);
});

test("issue #1316: all owned Windows components continue to the authenticated HTTP probe", () => {
  const result = runProbe();
  assert.equal(result.exitCode, 0);
  assert.equal(result.requests.length, 1);
  assert.equal(Object.values(result.requests[0].headers)[0], identity.routingNonce);
});

for (const form of ["exec-form", "PowerShell"]) {
  test(`issue #1316: local Claude takeover in ${form} exits 6 before HTTP`, () => {
    const config = configs();
    const event = CLAUDE_CORE_HOOK_EVENTS[0];
    const hook = config.claude.hooks[event][0].hooks[0];
    if (form === "exec-form") hook.args = ["C:\\LocalApp\\clawd-hook.js", event];
    else config.claude.hooks[event][0].hooks = [{ type: "command", shell: "powershell",
      command: `& "C:\\Node\\node.exe" "C:\\LocalApp\\clawd-hook.js" "${event}"` }];
    const result = runProbe({ config });
    assert.equal(result.exitCode, 6);
    assert.equal(result.requests.length, 0);
    assert.equal(classifyProbeExit(result.exitCode).hint, "remoteSshErrRemoteHooksTakenOver");
  });
}

test("issue #1316: owned PowerShell Claude hooks use the shared parser and Windows path equivalence", () => {
  const config = configs();
  for (const event of CLAUDE_CORE_HOOK_EVENTS) config.claude.hooks[event] = [{ hooks: [{
    type: "command", shell: "powershell", command: `$env:CLAWD_REMOTE='1'; & "C:\\Node\\node.exe" "${script("clawd-hook.js").toUpperCase().replace(/\\/g, "/")}" "${event}" "--clawd-ssh-remote"`,
  }] }];
  assert.equal(runProbe({ config }).exitCode, 0);
});

test("issue #1316: Copilot local takeover and permission nonce takeover each exit 6", () => {
  for (const component of ["copilot", "permission"]) {
    const config = configs();
    if (component === "copilot") config.copilot.hooks[COPILOT_STATE_HOOK_EVENTS[0]][0].powershell = '& "node" "C:\\Local\\copilot-hook.js" "sessionStart"';
    else config.claude.hooks.PermissionRequest[0].hooks[0].url = "http://127.0.0.1:23334/permission/" + "d".repeat(32);
    const result = runProbe({ config });
    assert.equal(result.exitCode, 6, component);
    assert.equal(result.requests.length, 0);
  }
});

test("issue #1316: a changed Codex event or a local Codex entry before ours exits 6", () => {
  const changed = configs();
  changed.codex.hooks[CODEX_STATE_HOOK_EVENTS[0]] = [{ hooks: [{
    type: "command", command: "C:\\Orca\\codex-hook.cmd", timeout: 30,
  }] }];
  assert.equal(runProbe({ config: changed }).exitCode, 6);

  const localFirst = configs();
  localFirst.codex.hooks[CODEX_STATE_HOOK_EVENTS[1]].unshift({ hooks: [{
    type: "command",
    commandWindows: '& "C:\\Node\\node.exe" "C:\\App\\codex-hook.js" --clawd-windows-stable',
    command: '"/bin/sh" "/mnt/c/App/codex-hook.js.sh"',
    timeout: 30,
  }] });
  assert.equal(runProbe({ config: localFirst }).exitCode, 6);
});

test("issue #1316: Codex ownership still requires the interop command and rejects conflict or unknown beside ours", () => {
  for (const component of ["missing command", "conflict", "unknown"]) {
    const config = configs();
    const event = CODEX_STATE_HOOK_EVENTS[0];
    if (component === "missing command") delete config.codex.hooks[event][0].hooks[0].command;
    else if (component === "conflict") config.codex.hooks[event][0].hooks[0].command = '"C:\\Foreign\\tool.exe" --flag';
    else config.codex.hooks[event].push({ hooks: [{
      type: "command",
      commandWindows: `& "${profile.detectedRemoteNodeBin}" "C:\\tools\\codex-hook.js-helpers\\run.js"`,
      timeout: 30,
    }] });
    const result = runProbe({ config });
    assert.equal(result.exitCode, 6, component);
    assert.equal(result.requests.length, 0, component);
  }
});

test("issue #1316: a Codex-only deployment still runs the takeover check", () => {
  const current = { ...profile, identityTxn: { steps: { installCodex: { status: "done" } } } };
  assert.equal(runProbe({ current }).exitCode, 0);
  const config = configs();
  config.codex.hooks[CODEX_STATE_HOOK_EVENTS[0]] = [{ hooks: [{
    type: "command", command: "C:\\Orca\\codex-hook.cmd", timeout: 30,
  }] }];
  assert.equal(runProbe({ current, config }).exitCode, 6);
});

test("issue #1316: Codex third-party entries coexist without a takeover warning", () => {
  const config = configs();
  config.codex.hooks[CODEX_STATE_HOOK_EVENTS[0]].push({ hooks: [{
    type: "command", command: "C:\\Orca\\codex-hook.cmd", timeout: 30,
  }] });
  assert.equal(runProbe({ config }).exitCode, 0);
});

test("issue #1316: a missing or BOM-prefixed Codex hooks.json exits 6", () => {
  const missing = configs();
  delete missing.codex;
  const missingResult = runProbe({ config: missing });
  assert.equal(missingResult.exitCode, 6);
  assert.equal(missingResult.requests.length, 0);
  assert.equal(runProbe({ codexBom: true }).exitCode, 6);
});

test("issue #1316: an unparseable Codex hooks.json exits 8 with its path", () => {
  const result = runProbe({ codexInvalidJson: true });
  assert.equal(result.exitCode, 8);
  assert.equal(result.requests.length, 0);
  assert.deepEqual(result.stderr, [`unverified: ${path.win32.join(layout.codexHome, "hooks.json")}`]);
});

test("issue #1316: Claude-only deployment never reads absent not-applicable Copilot config", () => {
  const current = { ...profile, identityTxn: { steps: { installClaude: { status: "done" }, installCopilot: { status: "not-applicable" } } } };
  const config = configs(); delete config.copilot;
  const result = runProbe({ current, config });
  assert.equal(result.exitCode, 0);
  assert.equal(result.reads.some((file) => file.endsWith("hooks.json")), false);
});

for (const error of ["readError", "invalidJson"]) {
  test(`issue #1316: Windows config ${error} is unverified rather than taken over`, () => {
    const result = runProbe({ [error]: true });
    assert.equal(result.exitCode, 8);
    assert.equal(result.requests.length, 0);
    assert.deepEqual(classifyProbeExit(8), { kind: "permanent", reason: "probe_remote_hooks_unverified", hint: "remoteSshErrRemoteHooksUnverified" });
  });
}

test("issue #1316: a changed Windows probe execPath exits 7 without reading config or HTTP", () => {
  const result = runProbe({ execPath: "D:\\Other\\node.exe" });
  assert.equal(result.exitCode, 7);
  assert.deepEqual(result.reads, []);
  assert.equal(result.requests.length, 0);
  assert.deepEqual(classifyProbeExit(7), { kind: "permanent", reason: "probe_windows_node_changed", hint: "remoteSshErrWindowsNodeChanged" });
  assert.equal(classifyProbeExit(1).reason, "probe_local_unhealthy");
});

test("issue #1316: Windows readiness stays ready before EOF and exits after stdin EOF", { timeout: 4000 }, async (t) => {
  const current = { ...profile, detectedRemoteNodeBin: process.execPath, identityTxn: { steps: {} } };
  const ready = buildPersistentReadinessCommand(23334, process.execPath, { profile: current, challenge: "c".repeat(32) });
  // Real loader and stdin lifecycle, with all HTTP and file access in memory.
  const harness = `const realRequire=require;require=(name)=>{if(name==='fs')return {readFileSync:(file)=>{if((String(file).includes('remote-integrations')&&String(file).includes('deepseek-harness'))||(String(file).includes('.dsh')&&String(file).includes('profiles'))){const err=new Error('ENOENT');err.code='ENOENT';throw err}return ${JSON.stringify(JSON.stringify(identity))}}};if(name==='http')return {get:(options,callback)=>{const req=new (realRequire('events').EventEmitter)();req.setTimeout=()=>{};req.destroy=()=>{};setImmediate(()=>{if(process.stdin.isPaused())throw new Error('readiness stdin is paused');callback({headers:{${JSON.stringify(CLAWD_SERVER_HEADER)}:${JSON.stringify(CLAWD_SERVER_ID)}},statusCode:200,resume(){}})});return req}};return realRequire(name)};${NODE_FRAME_LOADER}`;
  const child = spawn(process.execPath, ["-e", harness], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const closed = once(child, "close");
  let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
  const output = Promise.race([once(child.stdout, "data"), closed.then(() => { throw new Error("closed before ready: " + stderr); })]);
  writeNodeFrame(child, ready.frame, { persistent: true });
  assert.match(String((await output)[0]), /__CLAWD_REMOTE_READY__:cccc/);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(child.exitCode, null);
  child.stdin.end();
  assert.deepEqual(await closed, [0, null]);
});


test("issue #1316: a Copilot config with BOM cannot silently pass connection verification", () => {
  const result = runProbe({ copilotBom: true });
  assert.equal(result.exitCode, 8);
  assert.equal(result.requests.length, 0);
});


test("issue #1316: permission ownership reuses the managed URL contract before matching nonce", () => {
  for (const url of [
    `http://127.0.0.1:23334/permission?nonce=${identity.routingNonce}`,
    `https://foreign.invalid/permission/${identity.routingNonce}`,
    `http://127.0.0.1:23334/other/${identity.routingNonce}`,
  ]) {
    const config = configs(); config.claude.hooks.PermissionRequest[0].hooks[0].url = url;
    assert.equal(runProbe({ config }).exitCode, url.includes("?nonce=") ? 0 : 6);
  }
});


for (const [code, reason, hint] of [
  [6, "probe_remote_hooks_taken_over", "remoteSshErrRemoteHooksTakenOver"],
  [7, "probe_windows_node_changed", "remoteSshErrWindowsNodeChanged"],
  [8, "probe_remote_hooks_unverified", "remoteSshErrRemoteHooksUnverified"],
]) {
  test(`issue #1316: Windows probe exit ${code} permanently stops with its exact reason and hint`, () => {
    assert.deepEqual(classifyProbeExit(code), { kind: "permanent", reason, hint });
  });
}

test("issue #1316: Claude exec-form requires a standalone remote flag before HTTP", () => {
  const config = configs();
  config.claude.hooks[CLAUDE_CORE_HOOK_EVENTS[0]][0].hooks[0].args[2] = "--clawd-ssh-remote extra";
  const result = runProbe({ config });
  assert.equal(result.exitCode, 6);
  assert.equal(result.requests.length, 0);
});

for (const [label, args] of [
  ["exactly four arguments", [profile.detectedRemoteNodeBin, script("clawd-hook.js"), "Stop", "--clawd-ssh-remote", "extra"]],
  ["the remote flag in argument four", [profile.detectedRemoteNodeBin, script("clawd-hook.js"), "Stop", "wrong-flag"]],
  ["this deployment script in argument two", [profile.detectedRemoteNodeBin, "C:\\Foreign\\clawd-hook.js", "Stop", "--clawd-ssh-remote"]],
]) {
  test(`issue #1316: Claude PowerShell ownership requires ${label}`, () => {
    const config = configs();
    config.claude.hooks[CLAUDE_CORE_HOOK_EVENTS[0]] = [{ hooks: [{ type: "command", shell: "powershell",
      command: '& ' + args.map((arg) => `"${arg}"`).join(" "),
    }] }];
    const result = runProbe({ config });
    assert.equal(result.exitCode, 6);
    assert.equal(result.requests.length, 0);
  });
}

test("issue #1316: Windows readiness detects takeover before any HTTP request", () => {
  const config = configs();
  config.claude.hooks[CLAUDE_CORE_HOOK_EVENTS[0]][0].hooks[0].args = ["C:\\Local\\clawd-hook.js", "Stop"];
  const result = runProbe({ config, persistent: true });
  assert.equal(result.exitCode, 6);
  assert.equal(result.requests.length, 0);
});

test("issue #1316: Claude settings with BOM remain verifiable", () => {
  assert.equal(runProbe({ claudeBom: true }).exitCode, 0);
});

for (const value of [[], null, false, 42, "invalid config"]) {
  test(`issue #1316: non-object hook config ${JSON.stringify(value)} exits 8 with only its path`, () => {
    const config = configs(); config.claude = value;
    const result = runProbe({ config });
    assert.equal(result.exitCode, 8);
    assert.equal(result.requests.length, 0);
    assert.deepEqual(result.stderr, [`unverified: ${layout.claudeSettingsFile}`]);
  });
}

for (const agent of ["claude", "copilot"]) {
  for (const contract of [null, []]) {
    test(`issue #1316: ${contract === null ? "missing" : "empty"} ${agent} installer event contract exits 8 with the installer path`, () => {
      const result = runProbe(agent === "claude" ? { claudeEvents: contract } : { copilotEvents: contract });
      assert.equal(result.exitCode, 8);
      assert.equal(result.requests.length, 0);
      assert.deepEqual(result.stderr, [`unverified: ${script(agent === "claude" ? "install.js" : "copilot-install.js")}`]);
    });
  }
}

for (const [label, suffix] of [["exactly three arguments", ' "extra"'], ["the event name in argument three", ""]]) {
  test(`issue #1316: Copilot ownership requires ${label}`, () => {
    const config = configs(); const event = COPILOT_STATE_HOOK_EVENTS[0];
    const hook = config.copilot.hooks[event][0];
    hook.powershell = '& ' + [profile.detectedRemoteNodeBin, script("copilot-hook.js"), suffix ? event : "wrong-event"]
      .map((arg) => `"${arg}"`).join(" ") + suffix;
    const result = runProbe({ config });
    assert.equal(result.exitCode, 6);
    assert.equal(result.requests.length, 0);
  });
}

test("issue #1316: unreadable and missing hook configs identify the file without exposing contents", () => {
  const unreadable = runProbe({ readError: true });
  assert.equal(unreadable.exitCode, 8);
  assert.deepEqual(unreadable.stderr, [`unverified: ${layout.claudeSettingsFile}`]);
  const config = configs(); delete config.copilot;
  const missing = runProbe({ config });
  assert.equal(missing.exitCode, 8);
  assert.deepEqual(missing.stderr, [`unverified: ${path.win32.join(layout.copilotHome, "hooks", "hooks.json")}`]);
});


// ── DSH takeover detection (D9) ──
const dshRoot = path.win32.join(layout.clawdStateDir, "remote-integrations", "deepseek-harness");
const dshRecordPath = path.win32.join(dshRoot, profile.installId, "deployment.json");
const dshProfilePath = path.win32.join(layout.remoteHome, ".dsh", "profiles", "desktop", "package.json");
const dshGenerationId = "e".repeat(64);
function dshGenerationPath() {
  const home = "C:\\Users\\remote\\.dsh".toLowerCase().replace(/\\/g, "/");
  const namespace = require("node:crypto").createHash("sha256").update(home).digest("hex");
  return path.win32.join(dshRoot, profile.installId, "homes", namespace, "generations", dshGenerationId);
}
function dshFilesFor({ record = "installed", dependency = dshGenerationPath(), recordError = null,
  profileMissing = false, profileError = null } = {}) {
  const files = {};
  if (recordError) files[dshRecordPath] = { __error: recordError };
  else if (record !== null) files[dshRecordPath] = JSON.stringify({
    installId: profile.installId, profileId: profile.id,
    dshHome: "C:\\Users\\remote\\.dsh", generationId: dshGenerationId, phase: record,
  });
  if (!profileMissing) {
    if (profileError) files[dshProfilePath] = { __error: profileError };
    else files[dshProfilePath] = JSON.stringify({
      name: "desktop", private: true,
      dependencies: { "@dsh-external/dsh-clawd-bridge": `file:${dependency}` },
      dsh: { profile: { bundles: ["@dsh-external/dsh-clawd-bridge"] } },
    });
  }
  return files;
}
function runDshProbe({ dshInstalled = true, files = dshFilesFor(), steps = {} } = {}) {
  const current = {
    ...profile,
    managedDeployTargets: dshInstalled
      ? [{ installId: profile.installId, dshInstalled: true, remotePlatform: "win32" }]
      : [],
    identityTxn: { steps },
  };
  return runProbe({ current, dshFiles: files });
}

test("DSH remote: D9 skips when neither a record nor the local marker exists", () => {
  const result = runDshProbe({ dshInstalled: false, files: dshFilesFor({ record: null, profileMissing: true }) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.requests.length, 1);
});

test("DSH remote: D9 reports takeover when the marker exists without a record", () => {
  const result = runDshProbe({ dshInstalled: true, files: dshFilesFor({ record: null, profileMissing: true }) });
  assert.equal(result.exitCode, 6);
  assert.equal(result.requests.length, 0);
});

for (const phase of ["installing", "removing"]) {
  test(`DSH remote: D9 reports unverified for an unfinished ${phase} record`, () => {
    assert.equal(runDshProbe({ files: dshFilesFor({ record: phase }) }).exitCode, 8);
  });
}

test("DSH remote: D9 passes an installed record whose declared dependency is this deployment", () => {
  assert.equal(runDshProbe().exitCode, 0);
});

test("DSH remote: D9 reports takeover when the declaration points elsewhere or is missing", () => {
  assert.equal(runDshProbe({ files: dshFilesFor({ dependency: "C:\\Users\\remote\\.dsh\\other" }) }).exitCode, 6);
  const missingDeclaration = dshFilesFor();
  missingDeclaration[dshProfilePath] = JSON.stringify({ name: "desktop", dependencies: {}, dsh: { profile: { bundles: [] } } });
  assert.equal(runDshProbe({ files: missingDeclaration }).exitCode, 6);
});

test("DSH remote: D9 distinguishes parse failures, bad specs and bad generation ids", () => {
  const badRecord = dshFilesFor();
  badRecord[dshRecordPath] = { __raw: "{broken" };
  assert.equal(runDshProbe({ files: badRecord }).exitCode, 8);

  const badProfile = dshFilesFor();
  badProfile[dshProfilePath] = { __raw: "{broken" };
  assert.equal(runDshProbe({ files: badProfile }).exitCode, 8);

  const nonFileSpec = dshFilesFor();
  nonFileSpec[dshProfilePath] = JSON.stringify({
    name: "desktop",
    dependencies: { "@dsh-external/dsh-clawd-bridge": "https://example.invalid/bridge.tgz" },
  });
  assert.equal(runDshProbe({ files: nonFileSpec }).exitCode, 6);

  const badGeneration = dshFilesFor();
  badGeneration[dshRecordPath] = JSON.stringify({
    dshHome: "C:\\Users\\remote\\.dsh", generationId: "not-hex", phase: "installed",
  });
  assert.equal(runDshProbe({ files: badGeneration }).exitCode, 8);
});

test("DSH remote: D9 early exit does not depend on other agent steps", () => {
  const noRecord = dshFilesFor({ record: null, profileMissing: true });
  assert.equal(runDshProbe({ dshInstalled: false, files: noRecord, steps: {} }).exitCode, 0);
  assert.equal(runDshProbe({ dshInstalled: false, files: noRecord, steps: { installClaude: { status: "done" } } }).exitCode, 0);
  assert.equal(runDshProbe({ dshInstalled: true, files: noRecord, steps: {} }).exitCode, 6);
  assert.equal(runDshProbe({
    dshInstalled: false,
    steps: {},
    files: dshFilesFor({ dependency: "C:\\Users\\remote\\.dsh\\other" }),
  }).exitCode, 6);
});

test("DSH remote: D9 still checks an existing record without the local marker when other hooks ran", () => {
  const steps = { installClaude: { status: "done" } };
  assert.equal(runDshProbe({ dshInstalled: false, steps }).exitCode, 0);
  assert.equal(runDshProbe({
    dshInstalled: false,
    steps,
    files: dshFilesFor({ dependency: "C:\\Users\\remote\\.dsh\\other" }),
  }).exitCode, 6);
});

test("DSH remote: D9 reports takeover when the desktop profile manifest is gone", () => {
  assert.equal(runDshProbe({ files: dshFilesFor({ profileMissing: true }) }).exitCode, 6);
});

test("DSH remote: D9 reports unverified when the record or profile cannot be read", () => {
  assert.equal(runDshProbe({ files: dshFilesFor({ recordError: "EACCES" }) }).exitCode, 8);
  assert.equal(runDshProbe({ files: dshFilesFor({ profileError: "EACCES" }) }).exitCode, 8);
});
