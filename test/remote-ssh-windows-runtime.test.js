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

const profile = {
  id: "windows", host: "remote", remoteForwardPort: 23334, remotePlatform: "win32",
  remoteHome: "C:\\Users\\remote", runtimeKey: "account-default", runtimeMode: "account-default",
  installId: "a".repeat(64), layoutVersion: 1, detectedRemoteNodeBin: "C:\\Node\\node.exe",
  identityTxn: { steps: Object.fromEntries(["installClaude", "installCopilot", "claudePermission"].map((step) => [step, { status: "done" }])) },
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
  };
}
function runProbe({ current = profile, config = configs(), execPath = current.detectedRemoteNodeBin,
  readError = false, invalidJson = false, copilotBom = false, claudeBom = false,
  persistent = false, claudeEvents = CLAUDE_CORE_HOOK_EVENTS, copilotEvents = COPILOT_STATE_HOOK_EVENTS } = {}) {
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
      if (readError) throw new Error("EACCES");
      if (invalidJson) return "{broken";
      const value = file === layout.claudeSettingsFile ? config.claude : config.copilot;
      if (value === undefined) throw new Error("ENOENT");
      return ((copilotBom && file !== layout.claudeSettingsFile) || (claudeBom && file === layout.claudeSettingsFile) ? "\uFEFF" : "") + JSON.stringify(value);
    } };
    if (name === script("json-utils.js")) return utils;
    if (name === script("server-config.js")) return require("../hooks/server-config");
    if (name === script("install.js")) return { CLAUDE_CORE_HOOK_EVENTS: claudeEvents };
    if (name === script("copilot-install.js")) return { COPILOT_STATE_HOOK_EVENTS: copilotEvents };
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
  const harness = `const realRequire=require;require=(name)=>{if(name==='fs')return {readFileSync:()=>${JSON.stringify(JSON.stringify(identity))}};if(name==='http')return {get:(options,callback)=>{const req=new (realRequire('events').EventEmitter)();req.setTimeout=()=>{};req.destroy=()=>{};setImmediate(()=>{if(process.stdin.isPaused())throw new Error('readiness stdin is paused');callback({headers:{${JSON.stringify(CLAWD_SERVER_HEADER)}:${JSON.stringify(CLAWD_SERVER_ID)}},statusCode:200,resume(){}})});return req}};return realRequire(name)};${NODE_FRAME_LOADER}`;
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
