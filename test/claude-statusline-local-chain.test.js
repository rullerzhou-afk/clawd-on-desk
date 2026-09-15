"use strict";

const { it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { registerClaudeStatusline, unregisterClaudeStatusline } = require("../hooks/install");
const {
  LOCAL_CHAIN_FLAG, LOCAL_CHAIN_FILE, statuslineFingerprint, readLocalChainRecord, resolveLocalChainShell,
} = require("../hooks/claude-statusline-local-chain");
const { __test: adapter } = require("../hooks/claude-statusline");
const dirs = [];
const original = { type: "command", command: "printf 'original %s\\n' 'a & b'", padding: 3, refreshInterval: 7, hideVimModeIndicator: true };

function fixture(platform = "darwin", statusLine = original) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-local-chain-"));
  dirs.push(dir);
  const settingsPath = path.join(dir, "settings.json");
  const localChainSidecarPath = path.join(dir, "hooks", LOCAL_CHAIN_FILE);
  const settings = { statusLine, env: { TEST_KEEP: "untouched" }, hooks: { Stop: [] } };
  fs.writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  return {
    dir, settings, settingsPath, localChainSidecarPath,
    opts: { settingsPath, localChainSidecarPath, platform, nodeBin: process.execPath, silent: true, backup: false,
      env: { SystemRoot: "C:\\Windows" }, shellExists: () => true },
    read: () => JSON.parse(fs.readFileSync(settingsPath, "utf8")),
    enable() { return registerClaudeStatusline({ ...this.opts, chainExisting: true, expectedStatuslineFingerprint: statuslineFingerprint(statusLine) }); },
  };
}

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("default registration supplies a consent digest but neither takes the slot nor creates a record", () => {
  const f = fixture();
  const result = registerClaudeStatusline(f.opts);
  assert.equal(result.skippedExisting, true);
  assert.equal(result.statuslineFingerprint, statuslineFingerprint(original));
  assert.deepEqual(f.read(), f.settings);
  assert.equal(fs.existsSync(f.localChainSidecarPath), false);
});

for (const platform of ["darwin", "linux", "win32"]) {
  it(`${platform}: explicit coexistence retains all original fields and restores exactly`, () => {
    const f = fixture(platform);
    assert.equal(f.enable().localChained, true);
    const record = readLocalChainRecord(f.localChainSidecarPath);
    assert.deepEqual(record.statusLine, original);
    assert.deepEqual(f.read(), { ...f.settings, statusLine: { ...original, command: record.managedCommand } });
    assert.equal(registerClaudeStatusline(f.opts).changed, false);
    assert.equal(unregisterClaudeStatusline(f.opts).restoredChained, true);
    assert.deepEqual(f.read(), f.settings);
    assert.equal(fs.existsSync(f.localChainSidecarPath), false);
  });
}

for (const sshRemote of [false, true]) {
  it(`${sshRemote ? "secure" : "ordinary"} remote registration refuses a local chain until explicit local opt-out`, () => {
    const f = fixture();
    f.enable();
    const remoteIdentityPath = path.join(f.dir, "identity.json");
    fs.writeFileSync(remoteIdentityPath, JSON.stringify({
      version: 2, layoutVersion: 1, runtimeKey: "profile-a", profileId: "profile-a",
      installId: "a".repeat(64), remotePort: 23334, routingNonce: "b".repeat(32), deployedAt: 1,
    }));
    const remoteOpts = {
      ...f.opts, homeDir: f.dir, remote: true, sshRemote, remoteIdentityPath,
      chainSidecarPath: path.join(f.dir, "remote-chain.json"),
    };
    const settingsBefore = fs.readFileSync(f.settingsPath, "utf8");
    const recordBefore = fs.readFileSync(f.localChainSidecarPath, "utf8");
    for (const chainExisting of [undefined, false, true]) {
      for (const nodeBin of [process.execPath, "/changed/node"]) {
        assert.throws(() => registerClaudeStatusline({ ...remoteOpts, chainExisting, nodeBin }), (error) => {
          assert.match(error.message, /local coexistence.*before remote deployment/);
          assert.ok(error.message.includes(f.localChainSidecarPath));
          return true;
        });
        assert.equal(fs.readFileSync(f.settingsPath, "utf8"), settingsBefore);
        assert.equal(fs.readFileSync(f.localChainSidecarPath, "utf8"), recordBefore);
        assert.equal(fs.existsSync(remoteOpts.chainSidecarPath), false);
      }
    }
    // Resolving the local mode explicitly allows a fresh remote registration,
    // with its separate recovery record and the appropriate routing prefix.
    unregisterClaudeStatusline(f.opts);
    assert.deepEqual(f.read(), f.settings);
    assert.equal(registerClaudeStatusline({ ...remoteOpts, chainExisting: true }).chained, true);
    assert.match(f.read().statusLine.command, /CLAWD_REMOTE=1/);
    if (sshRemote) assert.match(f.read().statusLine.command, /CLAWD_SSH_REMOTE=1/);
    assert.equal(fs.existsSync(f.localChainSidecarPath), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(remoteOpts.chainSidecarPath, "utf8")).statusLine, original);
    unregisterClaudeStatusline(remoteOpts);
    assert.deepEqual(f.read(), f.settings);
  });
}

it("an explicit settingsPath also isolates the default local recovery path", () => {
  const f = fixture();
  const { localChainSidecarPath: _ignored, ...opts } = f.opts;
  registerClaudeStatusline({ ...opts, chainExisting: true });
  assert.ok(fs.existsSync(f.localChainSidecarPath));
  unregisterClaudeStatusline(opts);
  assert.deepEqual(f.read(), f.settings);
});

it("a changed slot after consent is refused before creating recovery evidence", () => {
  const f = fixture();
  const next = { ...f.settings, statusLine: { type: "command", command: "new-owner" } };
  fs.writeFileSync(f.settingsPath, JSON.stringify(next));
  assert.throws(() => f.enable(), /changed while confirmation/);
  assert.deepEqual(f.read(), next);
  assert.equal(fs.existsSync(f.localChainSidecarPath), false);
});

it("foreign recovery records are never overwritten", () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.localChainSidecarPath));
  const raw = JSON.stringify({ owner: "someone-else", statusLine: original });
  fs.writeFileSync(f.localChainSidecarPath, raw);
  assert.throws(() => f.enable(), /Invalid statusline recovery/);
  assert.equal(fs.readFileSync(f.localChainSidecarPath, "utf8"), raw);
  assert.deepEqual(f.read(), f.settings);
});

it("oversized or recursively marked originals are refused before creating a recovery record", () => {
  for (const command of ["x".repeat(65536), "echo --local-chain"]) {
    const f = fixture("darwin", { type: "command", command });
    assert.throws(() => f.enable(), /kept unchanged/);
    assert.deepEqual(f.read(), f.settings);
    assert.equal(fs.existsSync(f.localChainSidecarPath), false);
  }
});

it("a symlink recovery record is never followed or overwritten", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  const foreign = path.join(f.dir, "foreign.json");
  fs.writeFileSync(foreign, "leave me alone");
  fs.mkdirSync(path.dirname(f.localChainSidecarPath));
  fs.symlinkSync(foreign, f.localChainSidecarPath);
  assert.throws(() => f.enable(), /Invalid statusline recovery/);
  assert.equal(fs.readFileSync(foreign, "utf8"), "leave me alone");
  assert.deepEqual(f.read(), f.settings);
});

for (const failure of ["missing", "corrupt"]) {
  it(`${failure} recovery evidence cannot silently turn a chain into plain mode or delete it`, () => {
    const f = fixture();
    f.enable();
    const before = fs.readFileSync(f.settingsPath, "utf8");
    if (failure === "missing") fs.unlinkSync(f.localChainSidecarPath);
    else fs.writeFileSync(f.localChainSidecarPath, "{");
    assert.throws(() => registerClaudeStatusline(f.opts));
    assert.throws(() => unregisterClaudeStatusline(f.opts));
    assert.equal(fs.readFileSync(f.settingsPath, "utf8"), before);
  });
}

it("a third-party takeover is not reversed and does not delete the old recovery record", () => {
  const f = fixture();
  f.enable();
  const recordBefore = fs.readFileSync(f.localChainSidecarPath, "utf8");
  const takeover = { ...f.settings, statusLine: { type: "command", command: "new-owner", padding: 9 } };
  fs.writeFileSync(f.settingsPath, JSON.stringify(takeover));
  assert.equal(registerClaudeStatusline(f.opts).skippedExisting, true);
  assert.equal(unregisterClaudeStatusline(f.opts).removed, 0);
  assert.throws(() => registerClaudeStatusline({ ...f.opts, chainExisting: true }), /needs inspection/);
  assert.deepEqual(f.read(), takeover);
  assert.equal(fs.readFileSync(f.localChainSidecarPath, "utf8"), recordBefore);
});

it("a failed settings write leaves recoverable evidence and a same-slot retry reuses it", () => {
  const f = fixture();
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === fs.realpathSync(f.settingsPath)) throw new Error("injected-write-failure"); return rename(from, to); };
    assert.throws(() => f.enable(), /injected-write-failure/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(f.read(), f.settings);
  const record = fs.readFileSync(f.localChainSidecarPath, "utf8");
  assert.equal(f.enable().localChained, true);
  assert.equal(fs.readFileSync(f.localChainSidecarPath, "utf8"), record);
});

it("a failed wrapper path refresh can still restore the original", () => {
  const f = fixture();
  f.enable();
  const before = f.read();
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === fs.realpathSync(f.settingsPath)) throw new Error("injected-refresh-failure"); return rename(from, to); };
    assert.throws(() => registerClaudeStatusline({ ...f.opts, nodeBin: "/different/node" }), /injected-refresh-failure/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(f.read(), before);
  assert.equal(unregisterClaudeStatusline(f.opts).restoredChained, true);
  assert.deepEqual(f.read(), f.settings);
});

it("successful path refresh preserves the original and private file modes", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  f.enable();
  assert.equal(registerClaudeStatusline({ ...f.opts, nodeBin: "/different/node" }).changed, true);
  assert.deepEqual(readLocalChainRecord(f.localChainSidecarPath).statusLine, original);
  assert.equal(fs.statSync(f.localChainSidecarPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.settingsPath).mode & 0o777, 0o600);
  unregisterClaudeStatusline(f.opts);
  assert.equal(fs.statSync(f.settingsPath).mode & 0o777, 0o600);
});

it("failure to remove an already-restored recovery record does not prevent opt-out", () => {
  const f = fixture();
  f.enable();
  const unlink = fs.unlinkSync;
  try {
    fs.unlinkSync = (file) => { if (file === f.localChainSidecarPath) throw new Error("busy"); return unlink(file); };
    const result = unregisterClaudeStatusline(f.opts);
    assert.equal(result.restoredChained, true);
    assert.equal(result.recoveryRecordRetained, true);
  } finally { fs.unlinkSync = unlink; }
  assert.deepEqual(f.read(), f.settings);
});

it("Windows shell selection honors an explicit Git Bash path, not WSL bash.exe", () => {
  const file = "D:\\Git Custom\\bin\\bash.exe";
  assert.deepEqual(resolveLocalChainShell({ platform: "win32", env: { CLAUDE_CODE_GIT_BASH_PATH: file }, exists: (p) => p === file }), { file, kind: "bash" });
  assert.throws(() => resolveLocalChainShell({ platform: "win32", env: { CLAUDE_CODE_GIT_BASH_PATH: file }, exists: () => false }), /unavailable/);
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  assert.deepEqual(resolveLocalChainShell({ platform: "win32", env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" }, exists: (p) => p.endsWith("powershell.exe") || p.endsWith("bash.exe") }), { file: ps, kind: "powershell" });
});

it("Windows resolves Git Bash beside git.exe with a case-insensitive Path key", () => {
  const files = new Set(["D:\\Tools\\Git\\cmd\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe"]);
  assert.deepEqual(resolveLocalChainShell({ platform: "win32", env: { Path: "D:\\Tools\\Git\\cmd" }, exists: (p) => files.has(p) }), { file: "D:\\Tools\\Git\\bin\\bash.exe", kind: "bash" });
});

it("an unusable Windows shell refuses installation before changing the original", () => {
  const f = fixture("win32");
  assert.throws(() => registerClaudeStatusline({ ...f.opts, chainExisting: true, shellExists: () => false }), /unavailable/);
  assert.deepEqual(f.read(), f.settings);
  assert.equal(fs.existsSync(f.localChainSidecarPath), false);
});

it("invalid runtime consent identity produces neither command execution nor telemetry", async () => {
  const f = fixture(process.platform);
  f.enable();
  let calls = 0;
  await adapter.main({ payload: {}, argv: [LOCAL_CHAIN_FLAG, "wrong"], localChainSidecarPath: f.localChainSidecarPath,
    spawn: () => { calls++; }, postState: () => { calls++; }, writeStdout: () => { calls++; } });
  assert.equal(calls, 0);
});

it("Windows uses PowerShell only for its fallback and kills only the spawned PID tree on timeout", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 7654321;
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  const result = await adapter.runChainedStatusLine('Write-Output "unchanged & command"', "{}", {
    platform: "win32", localChain: true, env: { SystemRoot: "C:\\Windows" }, shellExists: (p) => p.endsWith("powershell.exe"),
    chainCapMs: 10, spawn: (...args) => {
      calls.push(args);
      if (calls.length === 1) return child;
      const killer = new EventEmitter();
      setImmediate(() => killer.emit("close", 0));
      return killer;
    },
  });
  assert.equal(result, "timeout");
  assert.deepEqual(calls[0][1], ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", 'Write-Output "unchanged & command"']);
  assert.equal(calls[0][2].detached, false);
  assert.deepEqual(calls[1][1], ["/PID", "7654321", "/T", "/F"]);
  assert.equal(process.listenerCount("SIGTERM"), 0);
});

for (const shellMode of ["default", "powershell"]) {
it(`real local ${shellMode} child retains JSON, cwd, environment and stdout while telemetry failure stays isolated`, { skip: shellMode === "powershell" && process.platform !== "win32" }, () => {
  const f = fixture(process.platform, { type: "command", command: "placeholder", padding: 4 });
  const script = path.join(f.dir, "original script.cjs");
  fs.writeFileSync(script, 'let text="";process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({payload:JSON.parse(text),cwd:process.cwd(),marker:process.env.CHAIN_TEST_MARKER})));');
  const custom = { type: "command", command: `node ${JSON.stringify(script.replace(/\\/g, "/"))}`, padding: 4 };
  fs.writeFileSync(f.settingsPath, JSON.stringify({ ...f.settings, statusLine: custom }));
  registerClaudeStatusline({ ...f.opts, chainExisting: true });
  const record = readLocalChainRecord(f.localChainSidecarPath);
  const payload = { session_id: "fixture-only", custom: "中文 ' & $ `", rate_limits: { seven_day: { used_percentage: 12 } } };
  const harness = `require(${JSON.stringify(require.resolve("../hooks/claude-statusline"))}).__test.main({argv:${JSON.stringify([LOCAL_CHAIN_FLAG, record.id])},localChainSidecarPath:${JSON.stringify(f.localChainSidecarPath)},${shellMode === "powershell" ? 'shellExists:(p)=>p.endsWith("powershell.exe"),' : ""}postState:(_b,_o,done)=>done(false)});`;
  const env = { ...process.env, CHAIN_TEST_MARKER: "kept" };
  if (shellMode === "powershell") {
    for (const key of Object.keys(env)) if (key.toUpperCase() === "CLAUDE_CODE_GIT_BASH_PATH") delete env[key];
  }
  const result = spawnSync(process.execPath, ["-e", harness], { cwd: f.dir, env, input: JSON.stringify(payload), encoding: "utf8", timeout: 8000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { payload, cwd: fs.realpathSync(f.dir), marker: "kept" });
});
}

for (const shellMode of ["default", "powershell"]) {
it(`real local ${shellMode} timeout removes only its own child tree`, { skip: shellMode === "powershell" && process.platform !== "win32" }, async () => {
  const f = fixture(process.platform);
  const script = path.join(f.dir, "hung.cjs");
  fs.writeFileSync(script, 'const child=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"ignore"});console.log(JSON.stringify({parent:process.pid,child:child.pid}));setTimeout(()=>{},30000);');
  const command = `node ${JSON.stringify(script.replace(/\\/g, "/"))}`;
  const harness = `require(${JSON.stringify(require.resolve("../hooks/claude-statusline"))}).__test.runChainedStatusLine(${JSON.stringify(command)},"{}",{localChain:true,chainCapMs:1500,${shellMode === "powershell" ? 'shellExists:(p)=>p.endsWith("powershell.exe"),' : ""}}).then(r=>console.log(r));`;
  const env = { ...process.env };
  if (shellMode === "powershell") {
    for (const key of Object.keys(env)) if (key.toUpperCase() === "CLAUDE_CODE_GIT_BASH_PATH") delete env[key];
  }
  const result = spawnSync(process.execPath, ["-e", harness], { cwd: f.dir, env, encoding: "utf8", timeout: 8000 });
  const pidLine = (result.stdout || "").split(/\r?\n/).find((line) => line.startsWith("{"));
  assert.ok(pidLine, result.stderr || "isolated command did not start");
  const pids = Object.values(JSON.parse(pidLine));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /timeout/);
    for (let i = 0; i < 100 && pids.some(alive); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(pids.some(alive), false, "owned child survived timeout");
  } finally {
    // Even a failed regression must not leave the test's own sleepers running.
    for (const pid of pids) if (Number.isInteger(pid) && pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
  }
});
}
