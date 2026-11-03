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
    process: { platform: "win32", execPath: "D:\\Node\\node.exe" },
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
