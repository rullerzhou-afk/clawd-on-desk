"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  MAX_MANAGED_NODES,
  PRIVATE_DACL_SECURITY_INFORMATION,
  PRIVATE_ACL_ERROR,
  assertRecapPrivatePathSupported,
  createVerifiedPrivateDaclApplier,
  createWindowsAclApi,
  hasAllowedPrivateOwner,
  hardenRecapPrivateDirectory,
  hasExactPrivateDacl,
  isTransientRecapPrivateAclError,
  normalizeFinalWindowsPath,
} = require("../src/recap-private-permissions");

function windowsSystemTool(fileName) {
  return path.win32.join(process.env.SystemRoot || process.env.WINDIR, "System32", fileName);
}

function runWindowsTool(executable, args, env = process.env) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env,
    shell: false,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function windowsAclSddl(filePath) {
  const powershell = path.win32.join(
    process.env.SystemRoot || process.env.WINDIR,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const env = { ...process.env, CLAWD_RECAP_TEST_ACL_PATH: filePath };
  delete env.PSModulePath;
  return runWindowsTool(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "(Get-Acl -LiteralPath $env:CLAWD_RECAP_TEST_ACL_PATH).Sddl",
  ], env);
}

function currentWindowsUserSid() {
  const output = runWindowsTool(windowsSystemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const fields = output.match(/^"(?:[^"]|"")*","(S-\d+(?:-\d+)+)"\s*$/);
  assert.ok(fields, "whoami must return its SID in the second CSV field");
  return fields[1];
}

function canonicalWindowsOwnerPrincipal(userSid) {
  const powershell = path.win32.join(
    process.env.SystemRoot || process.env.WINDIR,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const env = { ...process.env, CLAWD_RECAP_TEST_USER_SID: userSid };
  delete env.PSModulePath;
  const ownerSddl = runWindowsTool(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "([System.Security.AccessControl.RawSecurityDescriptor]::new(\"O:$env:CLAWD_RECAP_TEST_USER_SID\")).GetSddlForm([System.Security.AccessControl.AccessControlSections]::Owner)",
  ], env);
  const match = /^O:(.*?)(?=G:|D:|S:|$)/.exec(ownerSddl);
  assert.ok(match, "Windows must render the current user as an SDDL owner principal");
  return match[1];
}

function assertWindowsPrivatePrincipals(principals) {
  const userSid = currentWindowsUserSid();
  const canonicalUser = canonicalWindowsOwnerPrincipal(userSid);
  assert.equal(principals.size, 3);
  assert.ok(principals.has("SY"));
  assert.ok(principals.has("BA"));
  assert.ok(
    principals.has(userSid) || principals.has(canonicalUser),
    "private DACL must grant its third ACE to the current Windows user"
  );
}

function windowsDaclPrincipals(sddl) {
  const dacl = sddl.slice(sddl.indexOf("D:"));
  return [...dacl.matchAll(/\([^)]*;;;([^)]+)\)/g)].map((match) => match[1]);
}

function waitForChildLine(child, expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes(expected)) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (output.includes(expected)) return;
      clearTimeout(timer);
      reject(new Error(`share holder exited before ready (${code})`));
    });
  });
}

function waitForChildExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", resolve));
}

test("private ACL helper is a no-op outside Windows", () => {
  let calls = 0;
  const changed = hardenRecapPrivateDirectory("/tmp/recap", {
    platform: "linux",
    api: { currentUserSid: () => { calls += 1; } },
  });
  assert.equal(changed, false);
  assert.equal(calls, 0);
});

test("private ACL path preflight fails closed for Windows remote storage", () => {
  assert.throws(() => assertRecapPrivatePathSupported("Z:\\recap", {
    api: { isRemotePath: () => true },
    platform: "win32",
  }), (error) => error.code === PRIVATE_ACL_ERROR && error.stage === "remote-root");
});

test("private ACL hardening rejects a canonical UNC target before opening it", () => {
  let opened = false;
  const api = {
    isRemotePath: (nodePath) => nodePath.startsWith("\\\\server\\share"),
    openNode: () => { opened = true; },
  };
  assert.throws(() => hardenRecapPrivateDirectory("C:\\recap", {
    api,
    expectedCanonicalRoot: "\\\\server\\share\\recap",
    platform: "win32",
  }), (error) => error.code === PRIVATE_ACL_ERROR && error.stage === "remote-root");
  assert.equal(opened, false);
});

test("final Windows paths normalize device and UNC forms", () => {
  assert.equal(normalizeFinalWindowsPath("\\\\?\\C:\\Users\\A\\"), "c:\\users\\a");
  assert.equal(normalizeFinalWindowsPath("\\\\?\\UNC\\server\\share\\A"), "\\\\server\\share\\a");
});

test("private DACL verification requires only the three exact full-control ACEs", () => {
  const sid = "S-1-5-21-1-2-3-4";
  assert.equal(hasExactPrivateDacl(
    `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${sid})`,
    sid,
    true
  ), true);
  assert.equal(hasExactPrivateDacl(
    `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${sid})`,
    sid,
    false
  ), true);
  assert.equal(hasExactPrivateDacl(
    `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${sid})(A;;FR;;;WD)`,
    sid,
    false
  ), false);
  assert.equal(hasExactPrivateDacl(
    `D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${sid})`,
    sid,
    true
  ), false);
  assert.equal(hasAllowedPrivateOwner(`O:${sid}G:S-1-5-21-9D:P`, sid), true);
  assert.equal(hasAllowedPrivateOwner("O:SYD:P", sid), true);
  assert.equal(hasAllowedPrivateOwner("O:S-1-5-21-9-9-9-9D:P", sid), false);
  const administratorSid = "S-1-5-21-1-2-3-500";
  const localAliases = { LA: administratorSid };
  assert.equal(hasExactPrivateDacl(
    "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)",
    administratorSid,
    false
  ), false);
  assert.equal(hasExactPrivateDacl(
    "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)",
    administratorSid,
    false,
    localAliases
  ), true);
  assert.equal(hasAllowedPrivateOwner("O:LAG:S-1-5-21-9D:P", administratorSid), false);
  assert.equal(hasAllowedPrivateOwner(
    "O:LAG:S-1-5-21-9D:P",
    administratorSid,
    localAliases
  ), true);
  assert.equal(hasExactPrivateDacl(
    "D:P(A;;FA;;;SY)(A;;FA;;;BA)",
    "S-1-5-18",
    false
  ), true);
  assert.equal(hasExactPrivateDacl(
    `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${sid})S:(AU;SA;FA;;;WD)`,
    sid,
    false
  ), true);
});

test("verified DACL writer rejects every readback mismatch", () => {
  const sid = "S-1-5-21-1-2-3-4";
  const valid = `O:${sid}G:S-1-5-21-1D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${sid})`;
  let written = null;
  const success = createVerifiedPrivateDaclApplier({
    setPrivateDacl: (_handle, descriptor) => { written = descriptor; },
    readSecuritySddl: () => valid,
  });
  assert.doesNotThrow(() => success({}, sid, true));
  assert.equal(
    written,
    `D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)`
  );
  for (const actual of [
    `O:${sid}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${sid})(A;;FR;;;WD)`,
    `O:${sid}D:AI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${sid})`,
    `O:S-1-5-21-9-9-9-9D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${sid})`,
  ]) {
    const writer = createVerifiedPrivateDaclApplier({
      setPrivateDacl: () => {},
      readSecuritySddl: () => actual,
    });
    assert.throws(() => writer({}, sid, false), (error) =>
      error.code === PRIVATE_ACL_ERROR && error.stage === "verify");
  }

  const administratorSid = "S-1-5-21-1-2-3-500";
  const aliased = createVerifiedPrivateDaclApplier({
    accountAliasesForUser: (userSid) => userSid === administratorSid
      ? { LA: administratorSid }
      : {},
    setPrivateDacl: () => {},
    readSecuritySddl: () => "O:LAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)",
  });
  assert.doesNotThrow(() => aliased({}, administratorSid, false));
});

test("protected DACL security information stays an unsigned Win32 mask", () => {
  assert.equal(PRIVATE_DACL_SECURITY_INFORMATION, 0x80000004);
  assert.ok(PRIVATE_DACL_SECURITY_INFORMATION > 0);
});

test("Windows ACL API construction is idempotent for one Koffi instance", {
  skip: process.platform !== "win32",
}, () => {
  const koffi = require("koffi");
  const first = createWindowsAclApi(koffi);
  assert.equal(createWindowsAclApi(koffi), first);
  assert.equal(createWindowsAclApi(), first);
});

test("Windows ACL API preserves the first native construction failure", () => {
  const nativeFailure = new Error("simulated native API load failure");
  const fakeKoffi = {
    opaque: () => ({}),
    pointer: () => ({}),
    struct: () => ({}),
    load: () => { throw nativeFailure; },
  };
  let first;
  let second;
  try { createWindowsAclApi(fakeKoffi); } catch (error) { first = error; }
  try { createWindowsAclApi(fakeKoffi); } catch (error) { second = error; }
  assert.ok(first);
  assert.equal(second, first);
  assert.equal(first.code, PRIVATE_ACL_ERROR);
  assert.equal(first.stage, "native-api");
  assert.equal(first.cause, nativeFailure);
});

test("only open-stage Windows sharing and lock violations are transient", () => {
  const aclError = (stage, win32Code, code = PRIVATE_ACL_ERROR) => ({
    code,
    stage,
    cause: { win32Code },
  });
  assert.equal(isTransientRecapPrivateAclError(aclError("open", 32)), true);
  assert.equal(isTransientRecapPrivateAclError(aclError("open", 33)), true);
  assert.equal(isTransientRecapPrivateAclError(aclError("open", 5)), false);
  assert.equal(isTransientRecapPrivateAclError(aclError("verify", 32)), false);
  assert.equal(isTransientRecapPrivateAclError(aclError("open", 32, "OTHER")), false);
  assert.equal(isTransientRecapPrivateAclError(null), false);
});

test("Windows ACL opening retries a transient sharing violation", {
  skip: process.platform !== "win32",
  timeout: 10000,
}, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-acl-retry-"));
  const root = path.join(parent, "recap-v1");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const fixture = path.join(__dirname, "fixtures", "recap-private-permissions-share-holder.js");
  const child = spawn(process.execPath, [fixture, root, "25"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  await waitForChildLine(child, "READY");
  const moved = path.join(parent, "moved-recap-v1");
  assert.throws(() => fs.renameSync(root, moved), (error) =>
    error && ["EBUSY", "EPERM"].includes(error.code));
  assert.equal(hardenRecapPrivateDirectory(root, {
    expectedCanonicalRoot: fs.realpathSync.native(root),
  }), true);
  assert.equal(await waitForChildExit(child), 0);
});

test("Windows ACL handles block rename until identity-bound mutation is done", {
  skip: process.platform !== "win32",
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-acl-share-"));
  const original = path.join(parent, "original.jsonl");
  const moved = path.join(parent, "moved.jsonl");
  fs.writeFileSync(original, "{}\n");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const api = createWindowsAclApi();
  const handle = api.openNode(original);
  try {
    assert.throws(() => fs.renameSync(original, moved), (error) =>
      error && ["EBUSY", "EPERM"].includes(error.code));
  } finally {
    api.close(handle);
  }
  fs.renameSync(original, moved);
});

test("private ACL helper binds every mutation to the opened node identity", () => {
  const calls = [];
  const entries = new Map([
    ["C:\\recap", ["meta.json", "keep-user-file.txt"]],
    ["C:\\recap\\meta.json", null],
    ["C:\\recap\\keep-user-file.txt", null],
  ]);
  const api = {
    currentUserSid: () => "S-1-5-21-1-2-3-4",
    isRemotePath: () => false,
    openNode: (nodePath) => ({ nodePath }),
    attributes: (handle) => entries.get(handle.nodePath) === null ? 0 : 0x10,
    finalPath: (handle) => `\\\\?\\${handle.nodePath}`,
    identity: () => "1:2",
    linkCount: () => 1,
    applyPrivateDacl: (handle, sid, isDirectory) => calls.push({ path: handle.nodePath, sid, isDirectory }),
    close: () => {},
  };
  const fsImpl = {
    realpathSync: Object.assign((value) => value, { native: (value) => value }),
    readdirSync: (nodePath) => (entries.get(nodePath) || []).map((name) => ({ name })),
  };
  assert.equal(hardenRecapPrivateDirectory("C:\\recap", {
    api,
    expectedCanonicalRoot: "C:\\recap",
    expectedIdentity: "1:2",
    fsImpl,
    platform: "win32",
  }), true);
  assert.deepEqual(calls, [
    { path: "C:\\recap", sid: "S-1-5-21-1-2-3-4", isDirectory: true },
    { path: "C:\\recap\\meta.json", sid: "S-1-5-21-1-2-3-4", isDirectory: false },
  ]);
});

test("private ACL helper rejects a swapped root before applying a DACL", () => {
  let applied = false;
  const api = {
    currentUserSid: () => "S-1-5-21-1-2-3-4",
    isRemotePath: () => false,
    openNode: () => ({}),
    attributes: () => 0x10,
    finalPath: () => "\\\\?\\C:\\outside",
    identity: () => "1:2",
    linkCount: () => 1,
    applyPrivateDacl: () => { applied = true; },
    close: () => {},
  };
  assert.throws(() => hardenRecapPrivateDirectory("C:\\recap", {
    api,
    expectedCanonicalRoot: "C:\\recap",
    platform: "win32",
  }), (error) => error.code === PRIVATE_ACL_ERROR && error.stage === "identity");
  assert.equal(applied, false);
});

test("private ACL helper rejects reparse points and bounded-tree overflow", () => {
  const reparseApi = {
    currentUserSid: () => "S-1-5-21-1-2-3-4",
    isRemotePath: () => false,
    openNode: () => ({}),
    attributes: () => 0x10 | 0x400,
    finalPath: () => "\\\\?\\C:\\recap",
    identity: () => "1:2",
    linkCount: () => 1,
    applyPrivateDacl: () => assert.fail("must not apply"),
    close: () => {},
  };
  assert.throws(() => hardenRecapPrivateDirectory("C:\\recap", {
    api: reparseApi,
    expectedCanonicalRoot: "C:\\recap",
    platform: "win32",
  }), (error) => error.code === PRIVATE_ACL_ERROR && error.stage === "reparse");

  const children = Array.from({ length: MAX_MANAGED_NODES }, (_, index) => ({ name: `f${index}` }));
  const boundedApi = {
    currentUserSid: () => "S-1-5-21-1-2-3-4",
    isRemotePath: () => false,
    openNode: (nodePath) => ({ nodePath }),
    attributes: (handle) => handle.nodePath === "C:\\recap" || handle.nodePath === "C:\\recap\\events" ? 0x10 : 0,
    finalPath: (handle) => `\\\\?\\${handle.nodePath}`,
    identity: () => "1:2",
    linkCount: () => 1,
    applyPrivateDacl: () => {},
    close: () => {},
  };
  assert.throws(() => hardenRecapPrivateDirectory("C:\\recap", {
    api: boundedApi,
    expectedCanonicalRoot: "C:\\recap",
    fsImpl: {
      readdirSync: (nodePath) => nodePath === "C:\\recap" ? [{ name: "events" }] : children,
    },
    platform: "win32",
  }), (error) => error.code === PRIVATE_ACL_ERROR && error.stage === "tree-limit");
});

test("Windows ACL helper removes explicit foreign ACEs from an existing tree", {
  skip: process.platform !== "win32",
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-private-acl-"));
  const userSid = currentWindowsUserSid();
  runWindowsTool(windowsSystemTool("icacls.exe"), [
    parent,
    "/inheritance:r",
    "/grant:r",
    `*${userSid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
    "*S-1-1-0:(OI)(CI)R",
    "/Q",
  ]);
  const root = path.join(parent, "recap-v1");
  const oldDir = path.join(root, "events");
  const oldFile = path.join(oldDir, "old.jsonl");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(oldFile, "{}\n");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  for (const target of [oldFile, oldDir, root]) {
    const before = windowsAclSddl(target);
    assert.doesNotMatch(before, /D:P/);
    assert.match(before, /;;;WD\)/);
    assert.match(before, /;[^;]*ID;[^;]*;;;WD\)/);
  }

  hardenRecapPrivateDirectory(root, { expectedCanonicalRoot: fs.realpathSync.native(root) });
  let expectedPrincipals = null;
  for (const target of [root, oldDir, oldFile]) {
    const sddl = windowsAclSddl(target);
    assert.match(sddl, /D:P/);
    assert.doesNotMatch(sddl, /;;;WD\)/);
    const principals = new Set(windowsDaclPrincipals(sddl));
    if (expectedPrincipals === null) expectedPrincipals = principals;
    assert.deepEqual(principals, expectedPrincipals);
  }
  assertWindowsPrivatePrincipals(expectedPrincipals);
});

test("new recap children inherit only the private directory ACEs", {
  skip: process.platform !== "win32",
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-acl-inherit-"));
  const root = path.join(parent, "recap-v1");
  const events = path.join(root, "events");
  fs.mkdirSync(events, { recursive: true });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  hardenRecapPrivateDirectory(root, { expectedCanonicalRoot: fs.realpathSync.native(root) });
  const newFile = path.join(events, "2026-08-30.jsonl");
  const newDir = path.join(root, "quarantine");
  fs.writeFileSync(newFile, "{}\n");
  fs.mkdirSync(newDir);
  const expectedPrincipals = new Set(windowsDaclPrincipals(windowsAclSddl(root)));
  assertWindowsPrivatePrincipals(expectedPrincipals);
  for (const [target, directory] of [[newFile, false], [newDir, true]]) {
    const sddl = windowsAclSddl(target);
    assert.deepEqual(new Set(windowsDaclPrincipals(sddl)), expectedPrincipals);
    const dacl = sddl.slice(sddl.indexOf("D:"));
    const aces = [...dacl.matchAll(/\(([^)]*)\)/g)].map((match) => match[1].split(";"));
    assert.equal(aces.length, 3);
    for (const fields of aces) {
      assert.equal(fields[0], "A");
      assert.equal(fields[2], "FA");
      assert.match(fields[1], /ID/);
      if (directory) {
        assert.match(fields[1], /OI/);
        assert.match(fields[1], /CI/);
      }
    }
  }
});

test("Windows ACL helper does not mutate a junction target swapped in after pinning", {
  skip: process.platform !== "win32",
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-acl-swap-"));
  const root = path.join(parent, "recap-v1");
  const savedRoot = path.join(parent, "saved-root");
  const target = path.join(parent, "outside-target");
  fs.mkdirSync(root);
  fs.mkdirSync(target);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const targetBefore = windowsAclSddl(target);
  const nativeApi = createWindowsAclApi();
  let swapped = false;
  const swappingApi = {
    ...nativeApi,
    openNode: (nodePath) => {
      if (!swapped) {
        fs.renameSync(root, savedRoot);
        fs.symlinkSync(target, root, "junction");
        swapped = true;
      }
      return nativeApi.openNode(nodePath);
    },
  };

  assert.throws(() => hardenRecapPrivateDirectory(root, {
    api: swappingApi,
    expectedCanonicalRoot: root,
  }), (error) => error.code === PRIVATE_ACL_ERROR && error.stage === "reparse");
  assert.equal(swapped, true);
  assert.equal(windowsAclSddl(target), targetBefore);
});

test("Windows ACL helper rejects an existing managed junction without mutating its target", {
  skip: process.platform !== "win32",
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-acl-child-link-"));
  const root = path.join(parent, "recap-v1");
  const target = path.join(parent, "outside-target");
  fs.mkdirSync(root);
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(root, "events"), "junction");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const targetBefore = windowsAclSddl(target);

  assert.throws(() => hardenRecapPrivateDirectory(root, {
    expectedCanonicalRoot: fs.realpathSync.native(root),
  }), (error) => error.code === PRIVATE_ACL_ERROR && error.stage === "reparse");
  assert.equal(windowsAclSddl(target), targetBefore);
});

test("Windows ACL helper rejects a managed hard link without mutating its outside target", {
  skip: process.platform !== "win32",
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-acl-hardlink-"));
  const root = path.join(parent, "recap-v1");
  const events = path.join(root, "events");
  const outside = path.join(parent, "outside.jsonl");
  fs.mkdirSync(events, { recursive: true });
  fs.writeFileSync(outside, "{}\n");
  fs.linkSync(outside, path.join(events, "2026-08-30.jsonl"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const outsideBefore = windowsAclSddl(outside);

  assert.throws(() => hardenRecapPrivateDirectory(root, {
    expectedCanonicalRoot: fs.realpathSync.native(root),
  }), (error) => error.code === PRIVATE_ACL_ERROR && error.stage === "hardlink");
  assert.equal(windowsAclSddl(outside), outsideBefore);
});

test("Windows ACL helper leaves an unmanaged root entry's ACL unchanged", {
  skip: process.platform !== "win32",
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-acl-unknown-"));
  const root = path.join(parent, "recap-v1");
  const unknown = path.join(root, "keep-user-file.txt");
  fs.mkdirSync(root);
  fs.writeFileSync(unknown, "keep\n");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const unknownBefore = windowsAclSddl(unknown);

  hardenRecapPrivateDirectory(root, { expectedCanonicalRoot: fs.realpathSync.native(root) });
  assert.equal(windowsAclSddl(unknown), unknownBefore);
});
