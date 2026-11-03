"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { resolveRemoteRuntimeLayout, remoteLayoutDirectories } = require("../src/remote-ssh-layout");
const { buildWindowsOperationFrame, runWindowsOperation, __test: { windowsOperation } } = require("../src/remote-ssh-win-ops");
const { REMOTE_NODE_LAUNCH_COMMAND } = require("../src/remote-ssh-node-launch");
const { EventEmitter } = require("node:events");

function error(code) { return Object.assign(new Error(code), { code }); }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-win-ops-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = resolveRemoteRuntimeLayout({ remoteHome: "C:\\Users\\鹿 鹿", runtimeMode: "account-default" });
  const owner = { leaseId: "a".repeat(32), installId: "b".repeat(64), profileId: "p1", runtimeKey: layout.runtimeKey, layoutVersion: 1, acquiredAt: 100 };
  const expected = { installId: owner.installId, profileId: owner.profileId, runtimeKey: owner.runtimeKey, layoutVersion: owner.layoutVersion };
  const identity = { version: 2, installId: owner.installId, profileId: owner.profileId, runtimeKey: owner.runtimeKey, layoutVersion: 1, routingNonce: "c".repeat(32), remotePort: 23333, deployedAt: 100 };
  const runtimePath = path.win32.join(layout.remoteHome, ".clawd", "runtime.json");
  function local(target) {
    const relative = path.win32.relative(layout.remoteHome, target);
    assert.equal(relative.startsWith("..") || path.win32.isAbsolute(relative), false, target);
    return path.join(root, ...relative.split("\\"));
  }
  function put(target, text) {
    fs.mkdirSync(path.dirname(local(target)), { recursive: true });
    fs.writeFileSync(local(target), typeof text === "string" ? text : JSON.stringify(text));
  }
  const faults = {};
  const calls = [];
  const mappedFs = new Proxy(fs, { get(target, name) {
    const original = target[name];
    if (typeof original !== "function") return original;
    return (file, ...rest) => {
      calls.push({ name, file, rest });
      if (faults[name]) faults[name](file, ...rest);
      return name === "renameSync"
        ? original(local(file), local(rest[0]))
        : original(local(file), ...rest);
    };
  } });
  const deps = { platform: "win32", fs: mappedFs, path: path.win32, kill: () => { throw error("ESRCH"); }, delay: async () => {} };
  const run = (operation, fields = {}) => windowsOperation({ layout, expected, operation, ...fields }, deps);
  return { root, layout, owner, expected, identity, runtimePath, local, put, faults, calls, deps, run };
}

test("issue #1316: absent runtime and identity mean no local desktop and first deployment", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.run("preflight"), { ok: true, identity: false, claudePresent: false, copilotPresent: false, codexPresent: false, legacyTraces: 0, legacyConfigTraces: 0 });
});

for (const value of ["{", "null", "[]", "42", '"text"']) {
  test(`issue #1316: runtime rejects invalid object ${value}`, async (t) => {
    const f = fixture(t);
    f.put(f.runtimePath, value);
    await assert.rejects(f.run("preflight"), { reason: "runtime_invalid" });
  });
}
for (const ownerPid of [undefined, null, 0, -1, "12", 1.5, 2147483648]) {
  test(`issue #1316: runtime without a legal ownerPid rejects ${String(ownerPid)}`, async (t) => {
    const f = fixture(t);
    f.put(f.runtimePath, { ownerPid });
    await assert.rejects(f.run("preflight"), { reason: "runtime_owner_unknown" });
  });
}
for (const code of ["EACCES", "EIO"]) {
  test(`issue #1316: runtime read ${code} cannot be mistaken for absence`, async (t) => {
    const f = fixture(t);
    f.faults.readFileSync = (target) => { if (target === f.runtimePath) throw error(code); };
    await assert.rejects(f.run("preflight"), { reason: "file_unreadable" });
  });
}
for (const code of [null, "ESRCH", "EPERM", "EIO"]) {
  test(`issue #1316: PID probe ${code || "success"} permits only ESRCH`, async (t) => {
    const f = fixture(t);
    f.put(f.runtimePath, { ownerPid: 4321 });
    f.deps.kill = (pid, signal) => { assert.equal(pid, 4321); assert.equal(signal, 0); if (code) throw error(code); };
    if (code === "ESRCH") assert.equal((await f.run("preflight")).ok, true);
    else await assert.rejects(f.run("preflight"), (err) => {
      assert.equal(err.reason, "local_clawd_conflict");
      assert.ok(err.message.includes("4321"));
      assert.ok(err.message.includes(f.runtimePath));
      return true;
    });
  });
}

for (const value of ["{", "null", "[]", "42", "{}", '{"version":2}']) {
  test(`issue #1316: identity rejects malformed or incomplete value ${value}`, async (t) => {
    const f = fixture(t);
    f.put(f.layout.identityFile, value);
    await assert.rejects(f.run("preflight"), { reason: "identity_invalid" });
  });
}
test("issue #1316: identity read errors cannot be mistaken for first deployment", async (t) => {
  const f = fixture(t);
  f.faults.readFileSync = (target) => { if (target === f.layout.identityFile) throw error("EACCES"); };
  await assert.rejects(f.run("preflight"), { reason: "file_unreadable" });
});
test("issue #1316: valid identity must belong to the same installation and runtime", async (t) => {
  const f = fixture(t);
  f.put(f.layout.identityFile, f.identity);
  assert.equal((await f.run("preflight")).identity, true);
  for (const [key, value] of [["installId", "d".repeat(64)], ["profileId", "foreign"], ["runtimeKey", "other"]]) {
    f.put(f.layout.identityFile, { ...f.identity, [key]: value });
    await assert.rejects(f.run("preflight"), { reason: "ownership_conflict" });
  }
});

test("issue #1316: existing identity preflight and reads need expected identity without a lease owner", async (t) => {
  const f = fixture(t);
  f.put(f.layout.identityFile, f.identity);
  assert.equal((await f.run("preflight")).identity, true);
  assert.deepEqual(await f.run("readIdentity"), { identity: f.identity });
  f.put(f.layout.secureMarkerFile, "marker");
  f.put(f.layout.hostPrefixFile, "host");
  assert.deepEqual(await f.run("readMarker"), { text: "marker" });
  assert.deepEqual(await f.run("readHostPrefix"), { text: "host" });
  assert.deepEqual(await f.run("hash", { target: f.layout.secureMarkerFile }), {
    ok: true, hash: crypto.createHash("sha256").update("marker").digest("hex"),
  });
});

test("issue #1316: identity comparison uses expected independently of the lease owner", async (t) => {
  const f = fixture(t);
  f.put(f.layout.identityFile, f.identity);
  const expected = { ...f.expected, profileId: "another-profile" };
  await assert.rejects(f.run("preflight", { expected }), { reason: "ownership_conflict" });
  await assert.rejects(f.run("readIdentity", { expected, owner: f.owner }), { reason: "ownership_conflict" });
  await f.run("acquireLock", { owner: f.owner });
  await assert.rejects(f.run("removeFiles", { owner: f.owner, expected, files: [f.layout.identityFile] }), { reason: "ownership_conflict" });
  assert.ok(fs.existsSync(f.local(f.layout.identityFile)));
});

test("issue #1316: identity operations reject missing or malformed expected locally", (t) => {
  const f = fixture(t);
  for (const operation of ["preflight", "readIdentity", "removeFiles", "writeIdentity"]) {
    const invalid = [undefined, null, [], {},
      { ...f.expected, installId: "bad" }, { ...f.expected, profileId: 123 },
      { ...f.expected, runtimeKey: "../escape" }, { ...f.expected, layoutVersion: 2 }];
    for (const expected of invalid) {
      assert.throws(() => buildWindowsOperationFrame({ execPath: "C:\\Node\\node.exe", layout: f.layout, operation, expected }), {
        name: "TypeError", message: "expected must contain a valid installId, profileId, runtimeKey and layoutVersion",
      });
    }
    assert.doesNotThrow(() => buildWindowsOperationFrame({ execPath: "C:\\Node\\node.exe", layout: f.layout, operation, expected: f.expected }));
  }
});

test("issue #1316: temporary Windows filesystem fixtures use and clean the system temp directory", async (t) => {
  let root;
  await t.test("issue #1316: isolated Windows filesystem fixture", (child) => {
    const f = fixture(child);
    root = f.root;
    assert.equal(path.dirname(root), os.tmpdir());
    assert.match(path.basename(root), /^clawd-win-ops-/);
  });
  assert.equal(fs.existsSync(root), false);
});

for (const name of ["claudeConfigDir", "copilotHome"]) {
  test(`issue #1316: ${name} existence uses lstat and only ENOENT means absent`, async (t) => {
    const f = fixture(t);
    assert.equal((await f.run("preflight"))[name === "copilotHome" ? "copilotPresent" : "claudePresent"], false);
    fs.mkdirSync(f.local(f.layout[name]), { recursive: true });
    assert.equal((await f.run("preflight"))[name === "copilotHome" ? "copilotPresent" : "claudePresent"], true);
    f.faults.lstatSync = (target) => { if (target === f.layout[name]) throw error("EACCES"); };
    await assert.rejects(f.run("preflight"), { reason: "path_unreadable" });
  });
}
for (const location of ["home", "ancestor", "leaf"]) {
  test(`issue #1316: a symbolic link or junction at ${location} is refused`, async (t) => {
    const f = fixture(t);
    const target = location === "home" ? f.layout.remoteHome : location === "ancestor" ? f.layout.claudeConfigDir : f.layout.identityFile;
    // Both Windows symlinks and junctions report isSymbolicLink(). Inject the
    // stat result, while all other paths use real temporary filesystem state.
    const base = f.deps.fs;
    f.deps.fs = new Proxy(base, { get(fsApi, name) {
      if (name !== "lstatSync") return fsApi[name];
      return (file) => file === target ? { isSymbolicLink: () => true, isDirectory: () => true } : fsApi.lstatSync(file);
    } });
    await assert.rejects(f.run("preflight"), { reason: "path_link" });
  });
}

test("issue #1316: lock acquisition is exclusive and release removes only the current lease", async (t) => {
  const f = fixture(t);
  assert.equal((await f.run("acquireLock", { owner: f.owner })).ok, true);
  assert.equal((await f.run("acquireLock", { owner: f.owner })).reason, "lock_busy");
  const ownerFile = path.win32.join(f.layout.deployLockDir, "owner");
  f.put(ownerFile, { ...f.owner, leaseId: "d".repeat(32) });
  await assert.rejects(f.run("releaseLock", { owner: f.owner }), { reason: "lease_lost" });
  assert.ok(fs.existsSync(f.local(ownerFile)));
  f.put(ownerFile, f.owner);
  await f.run("releaseLock", { owner: f.owner });
  assert.equal(fs.existsSync(f.local(f.layout.deployLockDir)), false);
});

test("issue #1316: an unknown lock entry prevents release and is preserved", async (t) => {
  const f = fixture(t);
  await f.run("acquireLock", { owner: f.owner });
  f.put(path.win32.join(f.layout.deployLockDir, "foreign"), "keep");
  await assert.rejects(f.run("releaseLock", { owner: f.owner }), { reason: "lock_contents_unknown" });
  assert.ok(fs.existsSync(f.local(path.win32.join(f.layout.deployLockDir, "owner"))));
});

test("issue #1316: protected writes require a lease in the same operation program", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run("writeMarker", { owner: f.owner }), { reason: "lock_owner_invalid" });
  assert.equal(fs.existsSync(f.local(f.layout.secureMarkerFile)), false);
  await f.run("acquireLock", { owner: f.owner });
  await f.run("mkdir", { owner: f.owner, directories: remoteLayoutDirectories(f.layout) });
  assert.equal(fs.existsSync(f.local(f.layout.codexHome)), false);
  await assert.rejects(f.run("mkdir", { owner: f.owner, directories: [f.layout.codexHome] }), { reason: "codex_unsupported" });
  await assert.rejects(f.run("mkdir", { owner: f.owner, directories: [f.layout.codexSessionsDir] }), { reason: "codex_unsupported" });
  await f.run("writeIdentity", { owner: f.owner, identity: f.identity });
  await f.run("writeMarker", { owner: f.owner });
  await f.run("writeHostPrefix", { owner: f.owner, text: "Windows 中文" });
  assert.deepEqual(await f.run("readIdentity"), { identity: f.identity });
  assert.deepEqual(await f.run("readMarker"), { text: "clawd-ssh-secure-v1" });
  assert.deepEqual(await f.run("readHostPrefix"), { text: "Windows 中文" });
});

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`issue #1316: atomic rename bounds ${code} retries without deleting the destination`, async (t) => {
    const f = fixture(t);
    await f.run("acquireLock", { owner: f.owner });
    f.put(f.layout.secureMarkerFile, "old");
    let attempts = 0;
    f.faults.renameSync = () => { attempts++; throw error(code); };
    await assert.rejects(f.run("writeMarker", { owner: f.owner }), { code });
    assert.equal(attempts, code === "EACCES" ? 1 : 4);
    assert.equal(fs.readFileSync(f.local(f.layout.secureMarkerFile), "utf8"), "old");
    assert.deepEqual(fs.readdirSync(f.local(f.layout.claudeHooksDir)), ["clawd-ssh-secure-v1"]);
  });
}
test("issue #1316: transient rename contention retries, rechecks lease, then reads back", async (t) => {
  const f = fixture(t);
  await f.run("acquireLock", { owner: f.owner });
  fs.mkdirSync(f.local(f.layout.claudeHooksDir), { recursive: true });
  let attempts = 0;
  f.faults.renameSync = () => { if (++attempts < 3) throw error("EPERM"); };
  await f.run("writeMarker", { owner: f.owner });
  assert.equal(attempts, 3);
  f.deps.delay = async () => f.put(path.win32.join(f.layout.deployLockDir, "owner"), { ...f.owner, leaseId: "d".repeat(32) });
  f.faults.renameSync = () => { throw error("EBUSY"); };
  await assert.rejects(f.run("writeMarker", { owner: f.owner }), { reason: "lease_lost" });
});

for (const operation of ["acquireLock", "writeMarker"]) {
  test(`issue #1316: atomic writes clean partial temporary files after ENOSPC (${operation})`, async (t) => {
    const f = fixture(t);
    if (operation === "writeMarker") {
      await f.run("acquireLock", { owner: f.owner });
      f.put(f.layout.secureMarkerFile, "old");
    }
    f.faults.writeFileSync = (target, _text, options) => {
      fs.writeFileSync(f.local(target), "partial", options);
      throw error("ENOSPC");
    };
    await assert.rejects(f.run(operation, { owner: f.owner }), { code: "ENOSPC" });
    const directory = operation === "acquireLock" ? f.layout.deployLockDir : f.layout.claudeHooksDir;
    assert.deepEqual(fs.readdirSync(f.local(directory)), operation === "acquireLock" ? [] : ["clawd-ssh-secure-v1"]);
    if (operation === "writeMarker") {
      assert.equal(fs.readFileSync(f.local(f.layout.secureMarkerFile), "utf8"), "old");
      await f.run("releaseLock", { owner: f.owner });
    }
  });
}

test("issue #1316: promotion verifies upload and destination hashes under the lease", async (t) => {
  const f = fixture(t);
  await f.run("acquireLock", { owner: f.owner });
  const source = path.win32.join(f.layout.deployStagingDir, "hook.js");
  const target = path.win32.join(f.layout.claudeHooksDir, "hook.js");
  f.put(source, "uploaded");
  fs.mkdirSync(f.local(f.layout.claudeHooksDir), { recursive: true });
  const hash = crypto.createHash("sha256").update("uploaded").digest("hex");
  assert.deepEqual(await f.run("hash", { target: source }), { ok: true, hash });
  await assert.rejects(f.run("promote", { owner: f.owner, source, target, hash: "0".repeat(64) }), { reason: "hash_mismatch" });
  assert.equal(fs.existsSync(f.local(target)), false);
  await f.run("promote", { owner: f.owner, source, target, hash });
  assert.equal(fs.existsSync(f.local(source)), false);
  assert.deepEqual(await f.run("hash", { target }), { ok: true, hash });
});

test("issue #1316: removal requires matching deployment identity and preserves files outside its list", async (t) => {
  const f = fixture(t);
  await f.run("acquireLock", { owner: f.owner });
  const target = path.win32.join(f.layout.claudeHooksDir, "hook.js");
  f.put(target, "managed");
  const foreign = path.win32.join(f.layout.claudeHooksDir, "foreign.js");
  f.put(foreign, "foreign");
  await assert.rejects(f.run("removeFiles", { owner: f.owner, files: [target] }), { reason: "ownership_unverified" });
  f.put(f.layout.identityFile, f.identity);
  await assert.rejects(f.run("removeFiles", { owner: f.owner, files: [f.layout.claudeHooksDir] }), { reason: "cleanup_not_file" });
  await f.run("removeFiles", { owner: f.owner, files: [target] });
  assert.equal(fs.existsSync(f.local(target)), false);
  assert.equal(fs.readFileSync(f.local(foreign), "utf8"), "foreign");
  await assert.rejects(f.run("removeFiles", { owner: f.owner, files: ["C:\\Users\\other\\file"] }), { reason: "path_outside_home" });
});

test("issue #1316: a serialized Windows program checks execPath before any filesystem access", async (t) => {
  const f = fixture(t);
  const frame = JSON.parse(buildWindowsOperationFrame({ execPath: "C:\\Node\\node.exe", operation: "preflight", layout: f.layout, expected: f.expected }));
  assert.equal(frame.args.layout.platform, "win32");
  assert.throws(() => vm.runInNewContext(`(function(args){${frame.code}})(args)`, {
    args: frame.args,
    console: { error() {} },
    process: { platform: "win32", execPath: "D:\\Node\\node.exe", exit(code) { assert.equal(code, 7); throw new Error("execPath changed"); } },
    require: () => assert.fail("guard must run first"),
  }), /execPath changed/);
});

test("issue #1316: historical Windows operations reject a changed native platform before filesystem access", async (t) => {
  const f = fixture(t);
  f.deps.platform = "linux";
  await assert.rejects(f.run("preflight"), /remote platform changed/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => buildWindowsOperationFrame({ execPath: "/usr/bin/node", layout: f.layout, operation: "preflight" }), /Windows Node execPath/);
});

test("issue #1316: a serialized Windows program executes using only Node built-ins", async (t) => {
  const f = fixture(t);
  const frame = JSON.parse(buildWindowsOperationFrame({ execPath: "C:\\Node\\node.exe", operation: "preflight", layout: f.layout, expected: f.expected }));
  let output;
  await vm.runInNewContext(`(function(args){${frame.code}})(args)`, {
    args: frame.args,
    process: { platform: "win32", execPath: "c:\\node\\NODE.EXE", kill: f.deps.kill },
    require: (name) => name === "fs" ? f.deps.fs : require(name),
    console: { log: (text) => { output = JSON.parse(text); } },
  });
  assert.equal(output.ok, true);
});

test("issue #1316: Windows operation transport sends only the fixed command and ends one frame", async (t) => {
  const f = fixture(t);
  let input;
  const result = await runWindowsOperation({ profile: { host: "remote", detectedRemoteNodeBin: "C:\\Old\\node.exe" }, buildSshArgs: () => ["remote"],
    execPath: "C:\\Node\\node.exe", operation: "preflight", layout: f.layout, expected: f.expected,
    spawn(command, args) {
      assert.equal(command, "ssh");
      assert.equal(args.at(-1), REMOTE_NODE_LAUNCH_COMMAND);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { end(frame) { input = frame; } };
      queueMicrotask(() => { child.stdout.emit("data", Buffer.from('{"ok":true}\n')); child.emit("close", 0, null); });
      return child;
    },
  });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(input).args.operation, "preflight");
  assert.equal(JSON.parse(input).code.includes("C:\\\\Old"), false);
});

function stagedHooks(f) {
  const stage = path.win32.join(f.layout.deployStagingDir, f.owner.leaseId);
  const hashes = {};
  for (const name of ["first.js", "second.js", "third.js"]) {
    f.put(path.win32.join(stage, name), name);
    hashes[name] = crypto.createHash("sha256").update(name).digest("hex");
  }
  fs.mkdirSync(f.local(f.layout.claudeHooksDir), { recursive: true });
  return { stage, hashes };
}
test("issue #1316: batch promotion verifies every file and removes only an empty stage", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner });
  const { stage, hashes } = stagedHooks(f);
  await f.run("promoteMany", { owner: f.owner, hashes });
  assert.equal(fs.existsSync(f.local(stage)), false);
  for (const name of Object.keys(hashes)) assert.equal(fs.readFileSync(f.local(path.win32.join(f.layout.claudeHooksDir, name)), "utf8"), name);
});
test("issue #1316: batch promotion stops before subsequent files after a hash mismatch", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner });
  const { stage, hashes } = stagedHooks(f); hashes["second.js"] = "0".repeat(64);
  await assert.rejects(f.run("promoteMany", { owner: f.owner, hashes }), { reason: "hash_mismatch" });
  assert.equal(fs.existsSync(f.local(path.win32.join(f.layout.claudeHooksDir, "first.js"))), true);
  for (const name of ["second.js", "third.js"]) {
    assert.equal(fs.existsSync(f.local(path.win32.join(stage, name))), true);
    assert.equal(fs.existsSync(f.local(path.win32.join(f.layout.claudeHooksDir, name))), false);
  }
});
test("issue #1316: batch promotion preserves unknown staging contents", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner });
  const { stage, hashes } = stagedHooks(f); const extra = path.win32.join(stage, "foreign.txt");
  f.put(extra, "keep");
  await assert.rejects(f.run("promoteMany", { owner: f.owner, hashes }), { reason: "staging_contents_unknown" });
  assert.equal(fs.readFileSync(f.local(extra), "utf8"), "keep");
});
test("issue #1316: batch promotion refuses a lost lease before touching staging", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner });
  const { stage, hashes } = stagedHooks(f);
  await assert.rejects(f.run("promoteMany", { owner: { ...f.owner, leaseId: "d".repeat(32) }, hashes }), { reason: "lease_lost" });
  assert.equal(fs.readdirSync(f.local(stage)).length, 3);
});

function fakeInstaller(f) {
  const source = `
if(require.main===module){
  const fs=require('fs'),p=require('path');
  if(process.env.TEST_OUTPUT){fs.mkdirSync(p.dirname(process.env.TEST_OUTPUT),{recursive:true});fs.writeFileSync(process.env.TEST_OUTPUT,process.env.TEST_CONFIG);}
  console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>/^clawd_remote$/i.test(k)))));
  console.error('installer stderr');
  process.exitCode=Number(process.env.TEST_EXIT||0);
}
module.exports={CLAUDE_CORE_HOOK_EVENTS:['Stop','SessionStart'],COPILOT_STATE_HOOK_EVENTS:['sessionStart']};`;
  for (const script of ["install.js", "copilot-install.js"]) f.put(path.win32.join(f.layout.claudeHooksDir, script), source);
  f.put(path.win32.join(f.layout.claudeHooksDir, "json-utils.js"), fs.readFileSync(path.join(__dirname, "..", "hooks", "json-utils.js"), "utf8"));
  f.deps.require = (target) => require(f.local(target));
  f.deps.execPath = "C:\\Node\\node.exe";
  f.deps.env = { ...process.env, clawd_remote: "stale", ClAwD_ReMoTe: "stale", TEST_EXIT: "0" };
  f.deps.spawnSync = (executable, argv, options) => {
    assert.equal(executable, f.deps.execPath); assert.equal(options.windowsHide, true);
    assert.equal(options.encoding, "utf8"); assert.equal(options.timeout, 45000);
    assert.deepEqual(argv.slice(1), ["--remote"]);
    return require("node:child_process").spawnSync(process.execPath, [f.local(argv[0]), ...argv.slice(1)], options);
  };
  return (verify, config, extraEnv = {}) => {
    const claude = verify === "installClaude";
    return f.run("runInstaller", { owner: f.owner, script: claude ? "install.js" : "copilot-install.js", argv: ["--remote"], verify,
      env: { CLAWD_REMOTE: "1", TEST_OUTPUT: f.local(claude ? f.layout.claudeSettingsFile : path.win32.join(f.layout.copilotHome, "hooks", "hooks.json")), TEST_CONFIG: JSON.stringify(config), ...extraEnv } });
  };
}
function claudeConfig(f, hook) {
  const own = hook || { type: "command", command: f.deps.execPath.toUpperCase(), args: [path.win32.join(f.layout.claudeHooksDir, "clawd-hook.js").toUpperCase(), "Stop", "--clawd-ssh-remote"] };
  const sessionStart = JSON.parse(JSON.stringify(own));
  if (Array.isArray(sessionStart.args)) sessionStart.args[1] = "SessionStart";
  else if (sessionStart.command) sessionStart.command = sessionStart.command.replace('"Stop"', '"SessionStart"');
  return { hooks: { Stop: [{ hooks: [{ type: "command", command: "foreign" }, own] }], SessionStart: [sessionStart] } };
}
function psCommand(f, script, event, flag = "") {
  return `$env:CLAWD_REMOTE='1'; $env:CLAWD_SSH_REMOTE='1'; $env:CLAWD_REMOTE_IDENTITY_PATH='${f.layout.identityFile}'; & "${f.deps.execPath}" "${path.win32.join(f.layout.claudeHooksDir, script)}" "${event}"${flag ? ` "${flag}"` : ""}`;
}
test("issue #1316: native installer merges environment without duplicate case keys and verifies exec hooks", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner });
  const run = fakeInstaller(f);
  const result = await run("installClaude", claudeConfig(f));
  assert.equal(result.ok, true); assert.equal(result.status, 0); assert.equal(result.verified, true);
  assert.deepEqual(JSON.parse(result.stdoutTail), { CLAWD_REMOTE: "1" });
  assert.match(result.stderrTail, /installer stderr/);
});
test("issue #1316: native installer verifies PowerShell Claude and Copilot through the uploaded parser", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const run = fakeInstaller(f);
  const config = claudeConfig(f, { type: "command", shell: "powershell", command: psCommand(f, "clawd-hook.js", "Stop", "--clawd-ssh-remote") });
  assert.equal((await run("installClaude", config)).verified, true);
  const copilot = { hooks: { sessionStart: [{ powershell: psCommand(f, "copilot-hook.js", "sessionStart") }] } };
  assert.equal((await run("installCopilot", copilot)).verified, true);
  copilot.hooks.sessionStart[0].powershell = psCommand(f, "copilot-hook.js", "sessionStart").replace("CLAWD_SSH_REMOTE='1'", "CLAWD_SSH_REMOTE='0'");
  assert.equal((await run("installCopilot", copilot)).verified, false);
});
test("issue #1316: native installer exit status and failed readback cannot record success", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const run = fakeInstaller(f);
  const failed = await run("installClaude", claudeConfig(f), { TEST_EXIT: "9" });
  assert.equal(failed.status, 9); assert.equal(failed.ok, false); assert.equal(failed.reason, "installer_failed");
  for (const config of [{}, { hooks: {} }, claudeConfig(f, { type: "command", command: f.deps.execPath, args: ["foreign.js", "--clawd-ssh-remote"] }),
    claudeConfig(f, { type: "command", command: "D:\\node.exe", args: [path.win32.join(f.layout.claudeHooksDir, "clawd-hook.js"), "--clawd-ssh-remote"] }),
    claudeConfig(f, { type: "command", command: f.deps.execPath, args: [path.win32.join(f.layout.claudeHooksDir, "clawd-hook.js"), "x--clawd-ssh-remote"] })]) {
    const result = await run("installClaude", config);
    assert.equal(result.verified, false); assert.equal(result.ok, false); assert.equal(result.reason, "installer_verification_failed");
  }
});
test("issue #1316: native installer refuses paths and lost leases before spawning", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner });
  f.deps.spawnSync = () => assert.fail("must not spawn");
  await assert.rejects(f.run("runInstaller", { owner: f.owner, script: "../other.js" }), { reason: "installer_script_invalid" });
  await assert.rejects(f.run("runInstaller", { owner: { ...f.owner, leaseId: "d".repeat(32) }, script: "install.js" }), { reason: "lease_lost" });
});
test("issue #1316: native installer timeout remains an unknown mutation result", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner });
  f.deps.spawnSync = () => ({ status: null, signal: "SIGTERM", error: error("ETIMEDOUT") });
  await assert.rejects(f.run("runInstaller", { owner: f.owner, script: "install.js", argv: [], env: {} }), { reason: "installer_result_unknown" });
});
test("issue #1316: Windows permission readback distinguishes native and the exact identity nonce", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); f.put(f.layout.identityFile, f.identity);
  await assert.rejects(f.run("readClaudePermission", { owner: f.owner }), { reason: "installer_config_invalid" });
  f.put(f.layout.claudeSettingsFile, { hooks: {} });
  assert.deepEqual(await f.run("readClaudePermission", { owner: f.owner }), { ok: true, mode: "native" });
  for (const url of [`http://127.0.0.1:23333/permission/${f.identity.routingNonce}`, `http://127.0.0.1:23333/permission?nonce=${f.identity.routingNonce}`]) {
    f.put(f.layout.claudeSettingsFile, { hooks: { PermissionRequest: [{ hooks: [{ url }] }] } });
    assert.deepEqual(await f.run("readClaudePermission", { owner: f.owner }), { ok: true, mode: "managed" });
  }
  f.put(f.layout.claudeSettingsFile, { hooks: { PermissionRequest: [{ url: "http://127.0.0.1:23333/permission?nonce=foreign" }] } });
  await assert.rejects(f.run("readClaudePermission", { owner: f.owner }), { reason: "permission_nonce_mismatch" });
});
test("issue #1316: Windows retirement is idempotent and rejects an orphan marker or foreign identity", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner });
  assert.deepEqual(await f.run("finalizeIdentity", { owner: f.owner }), { ok: true });
  f.put(f.layout.secureMarkerFile, "marker");
  await assert.rejects(f.run("finalizeIdentity", { owner: f.owner }), { reason: "retirement_marker_without_identity" });
  f.put(f.layout.identityFile, { ...f.identity, profileId: "other" });
  await assert.rejects(f.run("finalizeIdentity", { owner: f.owner }), { reason: "ownership_conflict" });
  f.put(f.layout.identityFile, f.identity);
  await f.run("finalizeIdentity", { owner: f.owner });
  assert.equal(fs.existsSync(f.local(f.layout.identityFile)), false);
  assert.equal(fs.existsSync(f.local(f.layout.secureMarkerFile)), false);
});

test("issue #1316: installer readback rejects a state hook registered under the wrong event", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const run = fakeInstaller(f);
  const config = claudeConfig(f);
  config.hooks.SessionStart[0].args[1] = "Stop";
  assert.equal((await run("installClaude", config)).verified, false);
});
test("issue #1316: agent config readback accepts a BOM while identity remains strict", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const run = fakeInstaller(f);
  const config = claudeConfig(f);
  assert.equal((await run("installClaude", config, { TEST_CONFIG: `\uFEFF${JSON.stringify(config)}` })).verified, true);
  f.put(f.layout.identityFile, f.identity);
  f.put(f.layout.claudeSettingsFile, '\uFEFF{"hooks":{}}');
  assert.equal((await f.run("readClaudePermission", { owner: f.owner })).mode, "native");
  f.put(f.layout.identityFile, `\uFEFF${JSON.stringify(f.identity)}`);
  await assert.rejects(f.run("readIdentity"), { reason: "identity_invalid" });
});

test("issue #1316: Copilot installer readback rejects BOM with an explicit reason", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const run = fakeInstaller(f);
  const config = { hooks: { sessionStart: [{ powershell: psCommand(f, "copilot-hook.js", "sessionStart") }] } };
  assert.equal((await run("installCopilot", config)).verified, true);
  await assert.rejects(run("installCopilot", config, { TEST_CONFIG: `\uFEFF${JSON.stringify(config)}` }), { reason: "copilot_config_bom" });
});
for (const field of ["node path", "script path", "remote flag"]) {
  test(`issue #1316: exec installer readback rejects an incorrect ${field}`, async (t) => {
    const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const run = fakeInstaller(f);
    const hook = { type: "command", command: f.deps.execPath, args: [path.win32.join(f.layout.claudeHooksDir, "clawd-hook.js"), "Stop", "--clawd-ssh-remote"] };
    if (field === "node path") hook.command = "D:\\Node\\node.exe";
    if (field === "script path") hook.args[0] = "C:\\Users\\other\\clawd-hook.js";
    if (field === "remote flag") hook.args.pop();
    const result = await run("installClaude", claudeConfig(f, hook));
    assert.equal(result.ok, false); assert.equal(result.verified, false); assert.equal(result.reason, "installer_verification_failed");
  });
}
test("issue #1316: exec installer readback accepts only case differences in the Node path", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const run = fakeInstaller(f);
  const config = claudeConfig(f);
  assert.equal(config.hooks.Stop[0].hooks[1].command, f.deps.execPath.toUpperCase());
  const result = await run("installClaude", config);
  assert.equal(result.ok, true); assert.equal(result.verified, true);
});
test("issue #1316: PowerShell installer readback rejects a missing remote flag", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const run = fakeInstaller(f);
  const config = claudeConfig(f, { type: "command", shell: "powershell", command: psCommand(f, "clawd-hook.js", "Stop") });
  const result = await run("installClaude", config);
  assert.equal(result.ok, false); assert.equal(result.verified, false);
});
test("issue #1316: Copilot installer readback requires its identity path", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const run = fakeInstaller(f);
  const command = psCommand(f, "copilot-hook.js", "sessionStart").replace(/\$env:CLAWD_REMOTE_IDENTITY_PATH='[^']*'; /, "");
  const result = await run("installCopilot", { hooks: { sessionStart: [{ powershell: command }] } });
  assert.equal(result.ok, false); assert.equal(result.verified, false);
});
for (const verify of ["installClaude", "installCopilot"]) {
  test(`issue #1316: ${verify} readback rejects an empty installer event contract`, async (t) => {
    const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const run = fakeInstaller(f);
    const load = f.deps.require;
    f.deps.require = (target) => target.endsWith("json-utils.js") ? load(target) : { CLAUDE_CORE_HOOK_EVENTS: [], COPILOT_STATE_HOOK_EVENTS: [] };
    const config = verify === "installClaude" ? claudeConfig(f) : { hooks: { sessionStart: [{ powershell: psCommand(f, "copilot-hook.js", "sessionStart") }] } };
    const result = await run(verify, config);
    assert.equal(result.ok, false); assert.equal(result.verified, false);
  });
}
test("issue #1316: batch promotion rechecks the destination hash before the next file", async (t) => {
  const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const { stage, hashes } = stagedHooks(f);
  const originalFs = f.deps.fs;
  const destination = path.win32.join(f.layout.claudeHooksDir, "first.js");
  f.deps.fs = new Proxy(originalFs, { get(target, name) {
    if (name === "readFileSync") return (file, ...args) => file === destination ? Buffer.from("changed after rename") : target.readFileSync(file, ...args);
    return target[name];
  } });
  await assert.rejects(f.run("promoteMany", { owner: f.owner, hashes }), { reason: "hash_mismatch", path: destination });
  assert.equal(fs.existsSync(f.local(destination)), true);
  assert.equal(fs.existsSync(f.local(path.win32.join(stage, "second.js"))), true);
  assert.equal(fs.existsSync(f.local(path.win32.join(f.layout.claudeHooksDir, "second.js"))), false);
});
for (const [name, digest] of [["../escape.js", "a".repeat(64)], ["sub\\escape.js", "a".repeat(64)], ["..", "a".repeat(64)], [".", "a".repeat(64)], ["file.js", "g".repeat(64)], ["file.js", "a".repeat(63)], ["file.js", null]]) {
  test(`issue #1316: batch promotion rejects malformed manifest ${name}/${String(digest)} before moving files`, async (t) => {
    const f = fixture(t); await f.run("acquireLock", { owner: f.owner }); const { stage, hashes } = stagedHooks(f);
    const invalid = { ...hashes, [name]: digest };
    const reason = name === "file.js" ? "hash_mismatch" : "path_invalid";
    await assert.rejects(f.run("promoteMany", { owner: f.owner, hashes: invalid }), { reason });
    assert.deepEqual(fs.readdirSync(f.local(stage)).sort(), Object.keys(hashes).sort());
    assert.deepEqual(fs.readdirSync(f.local(f.layout.claudeHooksDir)), []);
  });
}

for (const field of ["shell", "node path", "script path", "event name", "flag value", "argument count"]) {
  test(`issue #1316: PowerShell installer readback rejects an incorrect ${field}`, async (t) => {
    const f = fixture(t);
    await f.run("acquireLock", { owner: f.owner });
    const run = fakeInstaller(f);
    let command = psCommand(f, "clawd-hook.js", "Stop", "--clawd-ssh-remote");
    if (field === "node path") command = command.replace(f.deps.execPath, "D:\\Node\\node.exe");
    if (field === "script path") command = command.replace(path.win32.join(f.layout.claudeHooksDir, "clawd-hook.js"), path.win32.join(f.layout.claudeHooksDir, "other-hook.js"));
    if (field === "flag value") command = command.replace("--clawd-ssh-remote", "--wrong-flag");
    if (field === "argument count") command += ' "extra"';
    const config = claudeConfig(f, { type: "command", shell: field === "shell" ? "cmd" : "powershell", command });
    if (field === "event name") config.hooks.SessionStart[0].command = command;
    const result = await run("installClaude", config);
    assert.equal(result.ok, false);
    assert.equal(result.verified, false);
    assert.equal(result.reason, "installer_verification_failed");
  });
}
test("issue #1316: PowerShell installer readback accepts case differences in native executable and script paths", async (t) => {
  const f = fixture(t);
  await f.run("acquireLock", { owner: f.owner });
  const run = fakeInstaller(f);
  const script = path.win32.join(f.layout.claudeHooksDir, "clawd-hook.js");
  const command = psCommand(f, "clawd-hook.js", "Stop", "--clawd-ssh-remote")
    .replace(f.deps.execPath, f.deps.execPath.toUpperCase()).replace(script, script.toUpperCase());
  const result = await run("installClaude", claudeConfig(f, { type: "command", shell: "powershell", command }));
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
});
for (const field of ["remote environment", "SSH environment", "identity path", "argument count", "event name"]) {
  test(`issue #1316: Copilot installer readback rejects an incorrect ${field}`, async (t) => {
    const f = fixture(t);
    await f.run("acquireLock", { owner: f.owner });
    const run = fakeInstaller(f);
    let command = psCommand(f, "copilot-hook.js", "sessionStart");
    if (field === "remote environment") command = command.replace("CLAWD_REMOTE='1'", "CLAWD_REMOTE='0'");
    if (field === "SSH environment") command = command.replace("CLAWD_SSH_REMOTE='1'", "CLAWD_SSH_REMOTE='0'");
    if (field === "identity path") command = command.replace(f.layout.identityFile, "C:\\Users\\foreign\\identity.json");
    if (field === "argument count") command += ' "extra"';
    if (field === "event name") command = command.replace('"sessionStart"', '"sessionEnd"');
    const result = await run("installCopilot", { hooks: { sessionStart: [{ powershell: command }] } });
    assert.equal(result.ok, false);
    assert.equal(result.verified, false);
    assert.equal(result.reason, "installer_verification_failed");
  });
}
