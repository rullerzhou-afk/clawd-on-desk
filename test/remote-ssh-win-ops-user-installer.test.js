"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveRemoteRuntimeLayout } = require("../src/remote-ssh-layout");
const {
  windowsOperation,
} = require("../src/remote-ssh-win-ops").__test;
const { windowsUserInstallerBudgets, DSH_INSTALLER_TIMEOUT_MS } = require("../src/remote-ssh-win-ops");
const { __test: deployTest } = require("../src/remote-ssh-deploy");
const { runRemoteTask } = require("../hooks/dsh-remote-task");

const SENTINEL = "CLAWD_DSH_RESULT_V1=";

function sentinelLine(extra = {}) {
  return `${SENTINEL}${JSON.stringify({ schemaVersion: 1, status: "ok", operation: "remote-install", ...extra })}\n`;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-win-user-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = resolveRemoteRuntimeLayout({ remoteHome: "C:\\Users\\Tester", runtimeMode: "account-default" });
  const owner = {
    leaseId: "a".repeat(32),
    installId: "b".repeat(64),
    profileId: "p1",
    runtimeKey: layout.runtimeKey,
    layoutVersion: 1,
    acquiredAt: 100,
  };
  const expected = {
    installId: owner.installId,
    profileId: owner.profileId,
    runtimeKey: owner.runtimeKey,
    layoutVersion: 1,
  };
  function local(target) {
    const relative = path.win32.relative(layout.remoteHome, target);
    assert.equal(relative.startsWith("..") || path.win32.isAbsolute(relative), false, target);
    return path.join(root, ...relative.split("\\"));
  }
  function put(target, value) {
    const file = local(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  }
  put(path.win32.join(layout.deployLockDir, "owner"), owner);
  put(path.win32.join(layout.claudeHooksDir, "dsh-install.js"), "// installer\n");
  put(path.win32.join(layout.claudeHooksDir, "dsh-remote-task.js"), "// task entry\n");
  const calls = [];
  const mappedFs = new Proxy(fs, {
    get(target, name) {
      const original = target[name];
      if (typeof original !== "function") return original;
      return (file, ...rest) => {
        const normalized = typeof file === "string" && path.win32.isAbsolute(file) ? local(file) : file;
        if (name === "renameSync") {
          const next = typeof rest[0] === "string" && path.win32.isAbsolute(rest[0]) ? local(rest[0]) : rest[0];
          return original(normalized, next, ...rest.slice(1));
        }
        return original(normalized, ...rest);
      };
    },
  });
  const deps = {
    platform: "win32",
    fs: mappedFs,
    path: path.win32,
    env: { USERDOMAIN: "TESTER", USERNAME: "tester", ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
    execPath: "C:\\node\\node.exe",
    kill: () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); },
    delay: async () => {},
    currentIntegrity: () => "medium",
    currentUserSid: () => "S-1-5-21-1-2-3-1001",
    spawnSync: () => { throw new Error("unexpected spawn"); },
  };
  const baseArgs = {
    owner,
    expected,
    script: "dsh-install.js",
    argv: ["--remote"],
    env: {},
    dshHome: "C:\\Users\\Tester\\.dsh",
    installerTimeoutMs: 300000,
    transportTimeoutMs: 420000,
  };
  function run(fields = {}) {
    return windowsOperation({ layout, operation: "runInstallerAsUser", ...baseArgs, ...fields }, deps);
  }
  return { root, layout, owner, expected, local, put, calls, deps, run };
}

function installScheduledFake(f, options = {}) {
  const state = { leaseDir: null, taskName: null, deletes: 0, creates: 0 };
  f.deps.spawnSync = (command, argv) => {
    f.calls.push({ command, argv });
    if (command === "whoami") return { status: 0, stdout: "" };
    if (command !== "schtasks") return { status: 0, stdout: sentinelLine(), stderr: "" };
    if (argv[0] === "/create") {
      state.creates += 1;
      if (options.createFailure) return { status: 1, stdout: "", stderr: options.createFailure };
      const taskName = argv[argv.indexOf("/tn") + 1];
      const xmlPath = argv[argv.indexOf("/xml") + 1];
      const leaseDir = path.win32.dirname(xmlPath);
      const xml = fs.readFileSync(f.local(xmlPath), "utf16le");
      assert.match(xml, /<TimeTrigger>/);
      assert.match(xml, /<StartBoundary>2001-01-01T00:00:00<\/StartBoundary>/);
      assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
      assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
      assert.match(xml, /<UserId>S-1-5-21-1-2-3-1001<\/UserId>/);
      assert.doesNotMatch(xml, /<UserId>WORKGROUP|<UserId>ruller</);
      assert.match(xml, /<Command>C:\\node\\node\.exe<\/Command>/);
      const lease = JSON.parse(fs.readFileSync(f.local(path.win32.join(leaseDir, "lease.json")), "utf8"));
      assert.equal(lease.taskName, taskName);
      assert.ok(lease.installArgv.includes("--lease-file"));
      assert.ok(lease.installArgv.includes("--lease-owner"));
      state.leaseDir = leaseDir;
      state.taskName = taskName;
      state.lease = lease;
      return { status: 0, stdout: "SUCCESS", stderr: "" };
    }
    if (argv[0] === "/run") {
      if (options.runFailure) return { status: 1, stdout: "", stderr: options.runFailure };
      if (options.writeResult !== false) {
        const result = {
          schemaVersion: 1,
          operationId: state.lease.operationId,
          taskName: state.lease.taskName,
          leaseId: state.lease.leaseId,
          status: options.resultStatus || "completed",
          reason: options.resultReason || null,
          installerExitCode: options.installerExitCode === undefined ? 0 : options.installerExitCode,
          installerResult: options.installerResult === undefined
            ? { schemaVersion: 1, status: "ok", operation: "remote-install" }
            : options.installerResult,
        };
        if (options.corruptResult) result.operationId = "e".repeat(32);
        fs.writeFileSync(f.local(path.win32.join(state.leaseDir, "result.json")), JSON.stringify(result), "utf8");
      }
      return { status: 0, stdout: "SUCCESS", stderr: "" };
    }
    if (argv[0] === "/delete") {
      state.deletes += 1;
      return { status: 0, stdout: "SUCCESS", stderr: "" };
    }
    return { status: 1, stderr: "unexpected schtasks args" };
  };
  return state;
}

test("DSH remote: installer runs directly under a Medium token with its explicit inner budget", async (t) => {
  const f = fixture(t);
  f.deps.spawnSync = (command, argv, options) => {
    f.calls.push({ command, argv, options });
    assert.equal(command, "C:\\node\\node.exe");
    assert.deepEqual(argv, [
    path.win32.join(f.layout.claudeHooksDir, "dsh-install.js"),
    "--remote",
    "--lease-file", path.win32.join(f.layout.deployLockDir, "owner"),
    "--lease-owner", f.owner.leaseId,
  ]);
    assert.equal(options.timeout, 1234);
    return { status: 0, stdout: sentinelLine(), stderr: "" };
  };
  const result = await f.run({ installerTimeoutMs: 1234, transportTimeoutMs: 200000 });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "direct");
  assert.equal(result.installerResult.status, "ok");
  assert.equal(f.calls.filter((call) => call.command === "schtasks").length, 0);
});

test("DSH remote: both executor paths bind the same explicit DSH_HOME", async (t) => {
  const direct = fixture(t);
  direct.deps.env = { ...direct.deps.env, DSH_HOME: "C:\\Users\\Tester\\custom-dsh" };
  direct.deps.spawnSync = (command, argv, options) => {
    assert.equal(command, "C:\\node\\node.exe");
    assert.equal(options.env.DSH_HOME, "C:\\Users\\Tester\\custom-dsh");
    return { status: 0, stdout: sentinelLine(), stderr: "" };
  };
  const result = await direct.run({ dshHome: "C:\\Users\\Tester\\custom-dsh" });
  assert.equal(result.ok, true);
  await assert.rejects(
    direct.run({ dshHome: "C:\\Users\\Tester\\.dsh" }),
    { reason: "dsh_home_mismatch" },
  );

  const scheduled = fixture(t);
  scheduled.deps.currentIntegrity = () => "high";
  scheduled.deps.env = { ...scheduled.deps.env, DSH_HOME: "C:\\Users\\Tester\\custom-dsh" };
  const state = installScheduledFake(scheduled);
  const scheduledResult = await scheduled.run({ dshHome: "C:\\Users\\Tester\\custom-dsh" });
  assert.equal(scheduledResult.ok, true);
  assert.equal(state.lease.installEnv.DSH_HOME, "C:\\Users\\Tester\\custom-dsh");
});

test("DSH remote: installer rejects unsupported token integrity before spawning anything", async (t) => {
  const f = fixture(t);
  f.deps.currentIntegrity = () => "low";
  await assert.rejects(f.run(), { reason: "windows_user_integrity_unsupported" });
  assert.equal(f.calls.length, 0);
});

test("DSH remote: installer direct timeout is an unknown result", async (t) => {
  const f = fixture(t);
  f.deps.spawnSync = () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });
  await assert.rejects(f.run(), { reason: "installer_result_unknown" });
});

test("DSH remote: installer direct success without a sentinel is an unknown result", async (t) => {
  const f = fixture(t);
  f.deps.spawnSync = () => ({ status: 0, stdout: "no sentinel", stderr: "" });
  await assert.rejects(f.run(), { reason: "installer_result_unknown" });
});

test("DSH remote: installer uses a one-shot limited scheduled task under a High token and deletes it", async (t) => {
  const f = fixture(t);
  f.deps.currentIntegrity = () => "high";
  const state = installScheduledFake(f);
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.mode, "scheduled-task");
  assert.equal(result.taskName, state.taskName);
  assert.equal(result.installerResult.status, "ok");
  assert.equal(state.creates, 1);
  assert.equal(state.deletes, 1, "the task must be deleted even on success");
  assert.equal(fs.existsSync(f.local(state.leaseDir)), false, "a completed lease directory is cleaned up");
});

test("DSH remote: task XML uses the current user SID even in a workgroup session", async (t) => {
  const f = fixture(t);
  f.deps.currentIntegrity = () => "high";
  f.deps.env = { ...f.deps.env, USERDOMAIN: "WORKGROUP", USERNAME: "ruller" };
  installScheduledFake(f);
  const result = await f.run();
  assert.equal(result.ok, true);
});

test("DSH remote: installer refuses when the current user SID is unavailable or malformed", async (t) => {
  for (const sid of [null, "", "WORKGROUP\\ruller", "ruller"]) {
    const f = fixture(t);
    f.deps.currentIntegrity = () => "high";
    f.deps.currentUserSid = () => sid;
    await assert.rejects(f.run(), { reason: "user_sid_unverifiable" });
    assert.equal(f.calls.filter((call) => call.command === "schtasks").length, 0);
  }
});

test("DSH remote: installer reports a missing desktop session from task creation or start", async (t) => {
  for (const failure of [
    { createFailure: "ERROR: No logged on user exists for this task." },
    { runFailure: "ERROR: The user is not logged on." },
  ]) {
    const f = fixture(t);
    f.deps.currentIntegrity = () => "high";
    installScheduledFake(f, failure);
    await assert.rejects(f.run(), { reason: "windows_dsh_desktop_session_required" });
  }
});

test("DSH remote: installer refuses a task that provably never started", async (t) => {
  const f = fixture(t);
  f.deps.currentIntegrity = () => "high";
  installScheduledFake(f, { createFailure: "ERROR: Access is denied." });
  await assert.rejects(f.run(), { reason: "scheduled_task_create_failed" });
});

test("DSH remote: installer keeps the lease when the scheduled-task result goes missing", async (t) => {
  const f = fixture(t);
  f.deps.currentIntegrity = () => "high";
  let clock = 1000;
  const now = () => { clock += 100000; return clock; };
  const state = installScheduledFake(f, { writeResult: false });
  await assert.rejects(f.run({ now }), { reason: "installer_result_unknown" });
  assert.equal(state.deletes, 1, "the task definition is still deleted");
  assert.equal(fs.existsSync(f.local(state.leaseDir)), true, "the lease and evidence are retained");
});

test("DSH remote: installer keeps the lease on a mismatched or incomplete result", async (t) => {
  for (const options of [
    { corruptResult: true },
    { resultStatus: "unknown" },
    { resultStatus: "completed", installerResult: null },
  ]) {
    const f = fixture(t);
    f.deps.currentIntegrity = () => "high";
    const state = installScheduledFake(f, options);
    await assert.rejects(f.run(), { reason: "installer_result_unknown" });
    assert.equal(state.deletes, 1);
    assert.equal(fs.existsSync(f.local(state.leaseDir)), true);
  }
});

test("DSH remote: installer surfaces a refused executor without running the installer", async (t) => {
  const f = fixture(t);
  f.deps.currentIntegrity = () => "high";
  const state = installScheduledFake(f, { resultStatus: "refused", resultReason: "user_sid_mismatch" });
  await assert.rejects(f.run(), { reason: "user_sid_mismatch" });
  assert.equal(state.deletes, 1);
  assert.equal(fs.existsSync(f.local(state.leaseDir)), false);
});

test("DSH remote: installer rejects an outer transport budget that cannot outlive the inner one", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ installerTimeoutMs: 300000, transportTimeoutMs: 300000 }), {
    reason: "transport_timeout_invalid",
  });
});

test("DSH remote: entry refusal identity reaches the executor as a specific reason", async (t) => {
  const f = fixture(t);
  f.deps.currentIntegrity = () => "high";
  const entryScript = path.join(f.root, "dsh-install.js");
  fs.writeFileSync(entryScript, "// entry installer\n");
  const state = installScheduledFake(f, { writeResult: false });
  const original = f.deps.spawnSync;
  f.deps.spawnSync = (command, argv) => {
    if (command === "schtasks" && argv[0] === "/run") {
      // The task entry refuses (expired lease) and writes its own result.
      const lease = state.lease;
      const entryDir = path.join(f.root, "entry-" + lease.operationId);
      fs.mkdirSync(entryDir, { recursive: true });
      const entryLease = {
        schemaVersion: 1,
        operationId: lease.operationId,
        taskName: lease.taskName,
        leaseId: lease.leaseId,
        createdAt: lease.createdAt,
        startDeadline: lease.startDeadline,
        expectedUserSid: lease.expectedUserSid,
        dshHome: lease.dshHome,
        installScript: entryScript,
        installArgv: [],
        installEnv: lease.installEnv,
        installerTimeoutMs: 1000,
      };
      fs.writeFileSync(path.join(entryDir, "lease.json"), JSON.stringify(entryLease));
      fs.writeFileSync(path.join(entryDir, `${lease.operationId}.pending`), lease.operationId);
      const refused = runRemoteTask([entryDir, lease.operationId], {
        now: () => lease.startDeadline + 1,
        env: { DSH_HOME: lease.dshHome },
        currentUserSid: () => lease.expectedUserSid,
        currentIntegrity: () => "medium",
      });
      assert.equal(refused.status, "refused");
      assert.equal(refused.taskName, lease.taskName);
      assert.equal(refused.leaseId, lease.leaseId);
      fs.writeFileSync(
        f.local(path.win32.join(state.leaseDir, "result.json")),
        JSON.stringify(refused),
      );
      return { status: 0, stdout: "SUCCESS", stderr: "" };
    }
    return original(command, argv);
  };
  await assert.rejects(f.run(), { reason: "operation-expired" });
  assert.equal(state.deletes, 1);
});

test("DSH remote: an unproven task creation still attempts deletion and refuses", async (t) => {
  const f = fixture(t);
  f.deps.currentIntegrity = () => "high";
  const state = installScheduledFake(f);
  const base = f.deps.spawnSync;
  f.deps.spawnSync = (command, argv) => {
    if (command === "schtasks" && argv[0] === "/create") {
      return { status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
    }
    return base(command, argv);
  };
  await assert.rejects(f.run(), { reason: "scheduled_task_create_failed" });
  assert.equal(state.deletes, 1, "a possibly-created task is deleted");
});

test("DSH remote: executor treats an unreadable result file as unknown and keeps the lease", async (t) => {
  const f = fixture(t);
  f.deps.currentIntegrity = () => "high";
  const state = installScheduledFake(f, { writeResult: false });
  const original = f.deps.spawnSync;
  f.deps.spawnSync = (command, argv) => {
    if (command === "schtasks" && argv[0] === "/run") {
      fs.mkdirSync(f.local(path.win32.join(state.leaseDir, "result.json")), { recursive: true });
      return { status: 0, stdout: "SUCCESS", stderr: "" };
    }
    return original(command, argv);
  };
  await assert.rejects(f.run(), { reason: "installer_result_unknown" });
  assert.equal(state.deletes, 1);
  assert.equal(fs.existsSync(f.local(state.leaseDir)), true);
});

test("DSH remote: executor treats corrupt result JSON as unknown and keeps the lease", async (t) => {
  const f = fixture(t);
  f.deps.currentIntegrity = () => "high";
  const state = installScheduledFake(f, { writeResult: false });
  const base = f.deps.spawnSync;
  f.deps.spawnSync = (command, argv) => {
    if (command === "schtasks" && argv[0] === "/run") {
      fs.writeFileSync(f.local(path.win32.join(state.leaseDir, "result.json")), "{not json", "utf8");
      return { status: 0, stdout: "SUCCESS", stderr: "" };
    }
    return base(command, argv);
  };
  await assert.rejects(f.run(), { reason: "installer_result_unknown" });
  assert.equal(state.deletes, 1);
  assert.equal(fs.existsSync(f.local(state.leaseDir)), true);
});

test("DSH remote: executor treats an unproven schtasks run result as unknown", async (t) => {
  const f = fixture(t);
  f.deps.currentIntegrity = () => "high";
  const state = installScheduledFake(f);
  const base = f.deps.spawnSync;
  f.deps.spawnSync = (command, argv) => {
    if (command === "schtasks" && argv[0] === "/run") {
      return { status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
    }
    return base(command, argv);
  };
  await assert.rejects(f.run(), { reason: "installer_result_unknown" });
  assert.equal(state.deletes, 1);
  assert.equal(fs.existsSync(f.local(state.leaseDir)), true);
});

test("DSH remote: incomplete completed results are all unknown", async (t) => {
  const cases = [
    { installerExitCode: null },
    { installerExitCode: 0, installerResult: {} },
    { installerExitCode: 0, installerResult: { schemaVersion: 1, status: "weird" } },
  ];
  for (const options of cases) {
    const f = fixture(t);
    f.deps.currentIntegrity = () => "high";
    const state = installScheduledFake(f, { resultStatus: "completed", ...options });
    await assert.rejects(f.run(), { reason: "installer_result_unknown" });
    assert.equal(state.deletes, 1);
    assert.equal(fs.existsSync(f.local(state.leaseDir)), true);
  }
});

test("DSH remote: deploy transport uses the new operation budget and leaves old installers alone", async (t) => {
  const layout = resolveRemoteRuntimeLayout({ remoteHome: "C:\\Users\\Tester", runtimeMode: "account-default" });
  const owner = { leaseId: "a".repeat(32), installId: "b".repeat(64), profileId: "p1", runtimeKey: layout.runtimeKey, layoutVersion: 1, acquiredAt: 100 };
  const execPath = "C:\\Node\\node.exe";
  async function call(operation, installerTimeoutMs, timeoutMs) {
    let captured = null;
    await deployTest.runWindowsDeployOperation({
      profile: { host: "example" },
      spawn: () => {},
      runtime: null,
      layout,
      execPath,
      operation,
      installerTimeoutMs,
      timeoutMs,
      owner,
      script: "dsh-install.js",
      argv: [],
      env: {},
      dshHome: "C:\\Users\\Tester\\.dsh",
      transportWait: async (_spawn, _command, _args, options) => {
        captured = options.timeoutMs;
        return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      },
    });
    return captured;
  }
  assert.equal(await call("runInstallerAsUser", 300000, 60000), 480000);
  assert.equal(await call("runInstaller", 300000, 60000), 60000);
});

test("DSH remote: installer budgets keep the DSH inner wait and outer transport ordered", () => {
  const budgets = windowsUserInstallerBudgets(DSH_INSTALLER_TIMEOUT_MS);
  assert.equal(budgets.installerTimeoutMs, 300000);
  assert.ok(budgets.resultWaitMs > budgets.installerTimeoutMs);
  assert.ok(budgets.transportTimeoutMs > budgets.resultWaitMs);
  assert.deepEqual(windowsUserInstallerBudgets(1000), {
    installerTimeoutMs: 1000,
    resultWaitMs: 91000,
    transportTimeoutMs: 181000,
  });
});
