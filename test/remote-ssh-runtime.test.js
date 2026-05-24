"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const {
  buildSshArgs,
  buildScpArgs,
  parseOpenSshVersion,
  isUnsupportedWindowsOpenSsh,
  classifyStderr,
  classifyProbeExit,
  buildProbeCommand,
  backoffMsForAttempt,
  createRemoteSshRuntime: createRemoteSshRuntimeBase,
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  PROBE_MIN_GAP_MS,
  PROBE_CHILD_TIMEOUT_MS,
  BACKOFF_SCHEDULE_MS,
} = require("../src/remote-ssh-runtime");
const { clearRemoteNodeCache } = require("../src/remote-ssh-node");

const DETECT_SSH_OK = () => ({
  available: true,
  version: "OpenSSH_9.5p2",
  parsedVersion: { major: 9, minor: 5, patch: 2 },
});

function createRemoteSshRuntime(deps = {}) {
  return createRemoteSshRuntimeBase({
    detectSsh: DETECT_SSH_OK,
    resolveRemoteNodeBin: () => ({ ok: true, nodeBin: "/usr/bin/node", version: "v20.0.0", source: "test" }),
    ...deps,
  });
}

// ── ssh detection ──

test("parseOpenSshVersion extracts Windows and portable OpenSSH banners", () => {
  assert.deepEqual(
    parseOpenSshVersion("OpenSSH_for_Windows_7.7p1, LibreSSL 2.6.5"),
    { major: 7, minor: 7, patch: 1 }
  );
  assert.deepEqual(
    parseOpenSshVersion("OpenSSH_9.5p2 Ubuntu-1, OpenSSL 3.0.13"),
    { major: 9, minor: 5, patch: 2 }
  );
  assert.deepEqual(
    parseOpenSshVersion("OpenSSH_8.8p1, OpenSSL 3.0.5"),
    { major: 8, minor: 8, patch: 1 }
  );
  assert.equal(parseOpenSshVersion("not ssh"), null);
});

test("Windows OpenSSH before 8 is rejected for Remote SSH health probes", () => {
  const legacy = { available: true, version: "OpenSSH_for_Windows_7.7p1, LibreSSL 2.6.5" };
  const modern = { available: true, version: "OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2" };
  const gitForWindows = { available: true, version: "OpenSSH_8.8p1, OpenSSL 3.0.5" };
  const unknown = { available: true, version: "plink masquerading as ssh" };
  const missing = { available: false, error: "ssh executable not found in PATH" };
  assert.equal(isUnsupportedWindowsOpenSsh(legacy, "win32"), true);
  assert.equal(isUnsupportedWindowsOpenSsh(legacy, "linux"), false);
  assert.equal(isUnsupportedWindowsOpenSsh(modern, "win32"), false);
  assert.equal(isUnsupportedWindowsOpenSsh(gitForWindows, "win32"), false);
  assert.equal(isUnsupportedWindowsOpenSsh(unknown, "win32"), false);
  assert.equal(isUnsupportedWindowsOpenSsh(missing, "win32"), false);
});

// ── buildSshArgs ──

test("buildSshArgs requires profile.host", () => {
  assert.throws(() => buildSshArgs(null), /profile\.host required/);
  assert.throws(() => buildSshArgs({}), /profile\.host required/);
});

test("buildSshArgs base options + host on minimal profile", () => {
  const args = buildSshArgs({ host: "user@pi" });
  assert.deepEqual(args, [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
    "user@pi",
  ]);
});

test("buildSshArgs injects -i identityFile", () => {
  const args = buildSshArgs({ host: "pi", identityFile: "/home/me/.ssh/id_rsa" });
  assert.ok(args.includes("-i"));
  const i = args.indexOf("-i");
  assert.equal(args[i + 1], "/home/me/.ssh/id_rsa");
  // host is last
  assert.equal(args[args.length - 1], "pi");
});

test("buildSshArgs injects -p port when non-22", () => {
  const args = buildSshArgs({ host: "pi", port: 2222 });
  assert.ok(args.includes("-p"));
  const i = args.indexOf("-p");
  assert.equal(args[i + 1], "2222");
});

test("buildSshArgs omits -p when port is 22 or absent", () => {
  assert.equal(buildSshArgs({ host: "pi", port: 22 }).includes("-p"), false);
  assert.equal(buildSshArgs({ host: "pi" }).includes("-p"), false);
});

test("buildSshArgs places extraOpts after profile defaults, before host", () => {
  const args = buildSshArgs(
    { host: "pi", identityFile: "/k", port: 2222 },
    { extraOpts: ["-N", "-R", "127.0.0.1:23333:127.0.0.1:23333"] }
  );
  // Layout: SSH_BASE_OPTS, -i /k, -p 2222, ...extraOpts, host
  const hostIdx = args.indexOf("pi");
  assert.equal(hostIdx, args.length - 1);
  const nIdx = args.indexOf("-N");
  const iIdx = args.indexOf("-i");
  assert.ok(iIdx < nIdx, "identityFile must appear before extraOpts");
  assert.ok(nIdx < hostIdx, "extraOpts must appear before host");
});

test("buildSshArgs extraOpts can override default via ssh last-wins (e.g. ConnectTimeout=2)", () => {
  const args = buildSshArgs(
    { host: "pi" },
    { extraOpts: ["-o", "ConnectTimeout=2", "-o", "BatchMode=no"] }
  );
  // The defaults come first, the overrides come second; ssh resolves last-wins.
  const ctIndices = [];
  args.forEach((v, i) => { if (v.startsWith("ConnectTimeout=")) ctIndices.push(i); });
  assert.equal(ctIndices.length, 2);
  assert.equal(args[ctIndices[ctIndices.length - 1]], "ConnectTimeout=2");
  const bmIndices = [];
  args.forEach((v, i) => { if (v.startsWith("BatchMode=")) bmIndices.push(i); });
  assert.equal(bmIndices.length, 2);
  assert.equal(args[bmIndices[bmIndices.length - 1]], "BatchMode=no");
});

test("buildSshArgs validates extraOpts is an array", () => {
  assert.throws(() => buildSshArgs({ host: "pi" }, { extraOpts: "no" }), /must be an array/);
});

test("buildSshArgs default keeps -T (correct for backgrounded tunnels)", () => {
  const args = buildSshArgs({ host: "pi" });
  assert.ok(args.includes("-T"), "non-interactive must include -T");
});

test("buildSshArgs interactive: true drops -T (Authenticate / Open Terminal path)", () => {
  const args = buildSshArgs({ host: "pi" }, { interactive: true });
  assert.equal(args.includes("-T"), false, "interactive must drop -T to let pty negotiate");
  // BatchMode + ConnectTimeout still present — only -T is dropped.
  assert.ok(args.some((v) => v && v.startsWith && v.startsWith("BatchMode=")));
  // Order check: identityFile / extraOpts / host still in correct slots.
  assert.equal(args[args.length - 1], "pi");
});

test("buildSshArgs interactive + BatchMode=no override applies last-wins", () => {
  const args = buildSshArgs(
    { host: "pi" },
    { interactive: true, extraOpts: ["-o", "BatchMode=no"] }
  );
  const bmIdxs = [];
  args.forEach((v, i) => { if (v && v.startsWith && v.startsWith("BatchMode=")) bmIdxs.push(i); });
  assert.equal(bmIdxs.length, 2, "should have 2 BatchMode entries (default + override)");
  assert.equal(args[bmIdxs[bmIdxs.length - 1]], "BatchMode=no");
});

// ── buildScpArgs ──

test("buildScpArgs base options on minimal profile", () => {
  const args = buildScpArgs({});
  assert.deepEqual(args, ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]);
});

test("buildScpArgs uses CAPITAL -P for port (not -p like ssh)", () => {
  const args = buildScpArgs({ port: 2222 });
  assert.ok(args.includes("-P"), "scp must use -P");
  assert.equal(args.includes("-p"), false, "scp must NOT use lowercase -p");
  const pIdx = args.indexOf("-P");
  assert.equal(args[pIdx + 1], "2222");
});

test("buildScpArgs injects identityFile", () => {
  const args = buildScpArgs({ identityFile: "/path/key" });
  const i = args.indexOf("-i");
  assert.equal(args[i + 1], "/path/key");
});

test("buildScpArgs extraOpts append after defaults", () => {
  const args = buildScpArgs({ port: 2222 }, { extraOpts: ["-r"] });
  assert.equal(args[args.length - 1], "-r");
});

// ── classifyStderr ──

test("classifyStderr Permission denied → permanent auth_denied", () => {
  const c = classifyStderr("ssh: Permission denied (publickey,password).");
  assert.equal(c.kind, "permanent");
  assert.equal(c.reason, "auth_denied");
});

test("classifyStderr Host key verification failed → permanent host_key", () => {
  const c = classifyStderr("Host key verification failed.");
  assert.equal(c.kind, "permanent");
  assert.equal(c.reason, "host_key");
});

test("classifyStderr remote port forwarding failed → permanent forward_failed", () => {
  const c = classifyStderr("Warning: remote port forwarding failed for listen port 23333");
  assert.equal(c.kind, "permanent");
  assert.equal(c.reason, "forward_failed");
});

test("classifyStderr Connection timed out → transient", () => {
  const c = classifyStderr("ssh: connect to host pi port 22: Connection timed out");
  assert.equal(c.kind, "transient");
});

test("classifyStderr Connection refused → transient", () => {
  const c = classifyStderr("ssh: connect to host pi port 22: Connection refused");
  assert.equal(c.kind, "transient");
});

test("classifyStderr Network is unreachable → transient", () => {
  const c = classifyStderr("ssh: connect to host: Network is unreachable");
  assert.equal(c.kind, "transient");
  assert.equal(c.reason, "net_unreachable");
});

test("classifyStderr Could not resolve hostname → permanent dns", () => {
  const c = classifyStderr("ssh: Could not resolve hostname pi.local: nodename nor servname provided");
  assert.equal(c.kind, "permanent");
  assert.equal(c.reason, "dns");
});

test("classifyStderr empty / whitespace → unknown", () => {
  assert.equal(classifyStderr("").kind, "unknown");
  assert.equal(classifyStderr("   \n").kind, "unknown");
});

test("classifyStderr unrecognized text → unknown", () => {
  assert.equal(classifyStderr("Some unfamiliar error blob").kind, "unknown");
});

// ── classifyProbeExit ──

test("classifyProbeExit 0 → ok", () => {
  assert.equal(classifyProbeExit(0).kind, "ok");
});

test("classifyProbeExit 1 → permanent (local unhealthy)", () => {
  const c = classifyProbeExit(1);
  assert.equal(c.kind, "permanent");
  assert.equal(c.reason, "probe_local_unhealthy");
});

test("classifyProbeExit 2 → permanent (unresponsive)", () => {
  assert.equal(classifyProbeExit(2).reason, "probe_unresponsive");
});

test("classifyProbeExit 3 → permanent (port hijack, regardless of status code per v7)", () => {
  assert.equal(classifyProbeExit(3).reason, "probe_port_hijack");
});

test("classifyProbeExit 4 → transient (HTTP timeout — req.setTimeout)", () => {
  const c = classifyProbeExit(4);
  assert.equal(c.kind, "transient");
  assert.equal(c.reason, "probe_http_timeout");
});

test("classifyProbeExit 126 → permanent (node not executable)", () => {
  assert.equal(classifyProbeExit(126).kind, "permanent");
});

test("classifyProbeExit 127 → permanent (node missing)", () => {
  assert.equal(classifyProbeExit(127).kind, "permanent");
  assert.equal(classifyProbeExit(127).reason, "probe_node_missing");
});

test("classifyProbeExit signals (130/137/143/255) → transient", () => {
  for (const code of [130, 137, 143, 255]) {
    assert.equal(classifyProbeExit(code).kind, "transient", `exit ${code}`);
  }
});

test("classifyProbeExit unknown nonzero → transient", () => {
  assert.equal(classifyProbeExit(42).kind, "transient");
});

// ── buildProbeCommand ──

test("buildProbeCommand requires integer port", () => {
  assert.throws(() => buildProbeCommand("23333"), /must be an integer/);
});

test("buildProbeCommand embeds remoteForwardPort + clawd header check", () => {
  const cmd = buildProbeCommand(23335);
  assert.ok(cmd.startsWith("node -e "));
  // The JSON-quoted JS body should reference the port.
  assert.ok(cmd.includes("23335"));
  assert.ok(cmd.includes(CLAWD_SERVER_HEADER));
  assert.ok(cmd.includes(CLAWD_SERVER_ID));
  // Must contain the v7-required exit codes.
  assert.ok(cmd.includes("process.exit(3)"), "header mismatch exit");
  assert.ok(cmd.includes("process.exit(2)"), "http error event exit");
  assert.ok(cmd.includes("process.exit(4)"), "req.setTimeout exit");
  // setTimeout for HTTP layer (not just ssh ConnectTimeout).
  assert.ok(cmd.includes("setTimeout(2000"));
});

test("buildProbeCommand can use a resolved absolute remote Node path", () => {
  const cmd = buildProbeCommand(23335, "/home/me/.nvm/versions/node/v22/bin/node");
  assert.ok(cmd.startsWith("'/home/me/.nvm/versions/node/v22/bin/node' -e "));
  assert.ok(cmd.includes("23335"));
});

test("buildProbeCommand returns valid JS that exits with each code under expected condition", () => {
  // Smoke: parse the embedded JS — it should not be syntactically broken.
  const cmd = buildProbeCommand(23333);
  const jsBody = cmd.slice("node -e ".length);
  // jsBody is a JSON-encoded string; parse to get raw JS.
  const raw = JSON.parse(jsBody);
  // Verify the raw JS starts with the expected request creation.
  assert.match(raw, /^const r=require\('http'\)\.get/);
  // Header check appears before status check (v7 order fix).
  const headerIdx = raw.indexOf("headers[");
  const statusIdx = raw.indexOf("statusCode===200");
  assert.ok(headerIdx >= 0 && statusIdx >= 0);
  assert.ok(headerIdx < statusIdx, "header check must precede status check");
});

// ── backoffMsForAttempt ──

test("backoffMsForAttempt follows the schedule then caps", () => {
  for (let i = 0; i < BACKOFF_SCHEDULE_MS.length; i++) {
    assert.equal(backoffMsForAttempt(i), BACKOFF_SCHEDULE_MS[i]);
  }
  assert.equal(
    backoffMsForAttempt(BACKOFF_SCHEDULE_MS.length + 5),
    BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]
  );
});

test("backoffMsForAttempt clamps negative / non-integer to first slot", () => {
  assert.equal(backoffMsForAttempt(-1), BACKOFF_SCHEDULE_MS[0]);
  assert.equal(backoffMsForAttempt(1.5), BACKOFF_SCHEDULE_MS[0]);
});

// ── Factory: state machine with mocked spawn ──

function makeMockChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (sig) => {
    if (child._killed) return;
    child._killed = true;
    queueMicrotask(() => child.emit("exit", null, sig || "SIGTERM"));
  };
  child._fakeExit = (code, signal) => {
    queueMicrotask(() => child.emit("exit", code != null ? code : null, signal || null));
  };
  child._fakeStderr = (text) => {
    queueMicrotask(() => child.stderr.emit("data", Buffer.from(text)));
  };
  return child;
}

function makeFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const setTimeoutFn = (cb, ms) => {
    const id = nextId++;
    pending.set(id, { cb, ms });
    return id;
  };
  const clearTimeoutFn = (id) => {
    pending.delete(id);
  };
  function flush() {
    // Fire whatever is currently pending; new timers added during cb stay queued.
    const snapshot = [...pending.entries()];
    pending.clear();
    for (const [, t] of snapshot) {
      try { t.cb(); } catch {}
    }
  }
  function flushWhere(predicate) {
    const snapshot = [...pending.entries()].filter(([, t]) => predicate(t));
    for (const [id] of snapshot) pending.delete(id);
    for (const [, t] of snapshot) {
      try { t.cb(); } catch {}
    }
  }
  function size() { return pending.size; }
  return { setTimeoutFn, clearTimeoutFn, flush, flushWhere, size };
}

test("createRemoteSshRuntime requires getHookServerPort dep", () => {
  assert.throws(() => createRemoteSshRuntime({}), /getHookServerPort/);
});

test("connect fails fast on legacy Windows OpenSSH before spawning tunnel", () => {
  let spawned = false;
  const rt = createRemoteSshRuntime({
    platform: "win32",
    detectSsh: () => ({
      available: true,
      version: "OpenSSH_for_Windows_7.7p1, LibreSSL 2.6.5",
    }),
    spawn: () => {
      spawned = true;
      return makeMockChild();
    },
    getHookServerPort: () => 23333,
  });
  const events = [];
  rt.on("status-changed", (s) => events.push(s));

  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });

  const failed = events.find((e) => e.status === "failed");
  assert.ok(failed);
  assert.equal(failed.lastErrorReason, "windows_openssh_legacy");
  assert.equal(failed.hint, "remoteSshErrWindowsOpenSshLegacy");
  assert.match(failed.message, /Upgrade Windows OpenSSH to 8\.x or newer/);
  assert.equal(spawned, false);
});

test("manual reconnect reruns ssh detection after legacy Windows OpenSSH failure", () => {
  let detectCalls = 0;
  let spawnCalls = 0;
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    platform: "win32",
    detectSsh: () => {
      detectCalls += 1;
      return detectCalls === 1
        ? { available: true, version: "OpenSSH_for_Windows_7.7p1, LibreSSL 2.6.5" }
        : { available: true, version: "OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2" };
    },
    spawn: () => {
      spawnCalls += 1;
      return makeMockChild();
    },
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };

  rt.connect(profile);
  assert.equal(rt.getProfileStatus("p1").status, "failed");
  assert.equal(spawnCalls, 0);

  const second = rt.connect(profile);
  assert.equal(detectCalls, 2);
  assert.equal(spawnCalls, 1);
  assert.equal(second.status, "connecting");
  rt.cleanup();
});

test("connect spawns ssh with main forward args + LANG=C env", async () => {
  const spawnCalls = [];
  const mockChild = makeMockChild();
  const probeChild = makeMockChild();
  let call = 0;
  const spawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    call += 1;
    return call === 1 ? mockChild : probeChild;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23335,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });

  const profile = {
    id: "p1",
    host: "user@pi",
    remoteForwardPort: 23333,
  };
  const events = [];
  rt.on("status-changed", (s) => events.push(s));
  rt.connect(profile);

  // First spawn is the main ssh tunnel.
  assert.equal(spawnCalls[0].cmd, "ssh");
  const args = spawnCalls[0].args;
  assert.ok(args.includes("-N"));
  assert.ok(args.includes("-R"));
  const rIdx = args.indexOf("-R");
  assert.equal(args[rIdx + 1], "127.0.0.1:23333:127.0.0.1:23335");
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
  assert.equal(args[args.length - 1], "user@pi");
  // Env forces English locale.
  assert.equal(spawnCalls[0].opts.env.LANG, "C");
  assert.equal(spawnCalls[0].opts.env.LC_ALL, "C");
  // Initial state-changed event = connecting.
  assert.equal(events[0].status, "connecting");
  rt.cleanup();
});

test("hung probe child is hard-timed out so the probe loop can retry", async () => {
  const children = [];
  const spawn = () => {
    const c = makeMockChild();
    children.push(c);
    return c;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });

  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  timers.flushWhere((t) => t.ms === 0);
  assert.equal(children.length, 2, "main tunnel + first probe");

  timers.flushWhere((t) => t.ms === PROBE_CHILD_TIMEOUT_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(children[1]._killed, true);

  timers.flushWhere((t) => t.ms === PROBE_MIN_GAP_MS);
  assert.equal(children.length, 3, "probe retry should be allowed after hard timeout");
  rt.cleanup();
});

test("connect starts health probe immediately on remote Node cache miss", async () => {
  clearRemoteNodeCache();
  const spawnCalls = [];
  let resolverCalled = false;
  let resolveNode;
  const pendingResolver = new Promise((resolve) => { resolveNode = resolve; });
  const spawn = (cmd, args, opts) => {
    const child = makeMockChild();
    spawnCalls.push({ cmd, args, opts, child });
    return child;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntimeBase({
    detectSsh: DETECT_SSH_OK,
    spawn,
    getHookServerPort: () => 23335,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    resolveRemoteNodeBin: () => {
      resolverCalled = true;
      return pendingResolver;
    },
  });

  rt.connect({ id: "p1", host: "user@pi", remoteForwardPort: 23333 });
  assert.equal(spawnCalls.length, 1, "main tunnel should spawn first");

  timers.flush();
  assert.ok(spawnCalls.length >= 2, "probe should start before node resolver settles");
  const probeCmd = spawnCalls[1].args[spawnCalls[1].args.length - 1];
  assert.ok(probeCmd.startsWith("node -e "), "cache miss intentionally starts with bare node probe");
  assert.equal(resolverCalled, false, "resolver waits until the bare node probe fails or succeeds");

  resolveNode({ ok: true, nodeBin: "/usr/bin/node", version: "v20.0.0", source: "test" });
  await new Promise((r) => setImmediate(r));
  rt.cleanup();
});

test("bare node probe failure waits for in-flight resolver before failing", async () => {
  clearRemoteNodeCache();
  const spawnCalls = [];
  let resolveNode;
  const pendingResolver = new Promise((resolve) => { resolveNode = resolve; });
  const spawn = (cmd, args, opts) => {
    const child = makeMockChild();
    spawnCalls.push({ cmd, args, opts, child });
    return child;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntimeBase({
    detectSsh: DETECT_SSH_OK,
    spawn,
    getHookServerPort: () => 23335,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    resolveRemoteNodeBin: () => pendingResolver,
  });

  rt.connect({ id: "p1", host: "user@pi", remoteForwardPort: 23333 });
  timers.flushWhere((t) => t.ms === 0);
  assert.ok(spawnCalls.length >= 2);
  spawnCalls[1].child._fakeExit(127);
  await new Promise((r) => setImmediate(r));

  timers.flushWhere((t) => t.ms > 0);
  assert.notEqual(rt.getProfileStatus("p1").status, "failed",
    "bare node 127 should not fail while absolute-node resolver is still running");

  resolveNode({ ok: true, nodeBin: "/usr/bin/node", version: "v20.0.0", source: "test" });
  await new Promise((r) => setImmediate(r));
  rt.cleanup();
});

test("bare node probe does not keep spawning while absolute-node resolver is in flight", async () => {
  clearRemoteNodeCache();
  const spawnCalls = [];
  let resolveNode;
  const pendingResolver = new Promise((resolve) => { resolveNode = resolve; });
  const spawn = (cmd, args, opts) => {
    const child = makeMockChild();
    spawnCalls.push({ cmd, args, opts, child });
    return child;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntimeBase({
    detectSsh: DETECT_SSH_OK,
    spawn,
    getHookServerPort: () => 23335,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    resolveRemoteNodeBin: () => pendingResolver,
  });

  rt.connect({ id: "p1", host: "user@pi", remoteForwardPort: 23333 });
  timers.flushWhere((t) => t.ms === 0);
  assert.equal(spawnCalls.length, 2, "main tunnel + first bare-node probe");
  spawnCalls[1].child._fakeExit(127);
  await new Promise((r) => setImmediate(r));

  timers.flushWhere((t) => t.ms === PROBE_MIN_GAP_MS);
  assert.equal(spawnCalls.length, 2,
    "no additional bare-node probe should spawn while resolver is pending");

  resolveNode({ ok: true, nodeBin: "/usr/bin/node", version: "v20.0.0", source: "test" });
  await new Promise((r) => setImmediate(r));
  rt.cleanup();
});

test("disconnect followed by reconnect clears a stale in-flight node resolver gate", async () => {
  clearRemoteNodeCache();
  const spawnCalls = [];
  let resolveNode;
  const pendingResolver = new Promise((resolve) => { resolveNode = resolve; });
  const spawn = (cmd, args, opts) => {
    const child = makeMockChild();
    spawnCalls.push({ cmd, args, opts, child });
    return child;
  };
  const timers = makeFakeTimers();
  const profile = { id: "p1", host: "user@pi", remoteForwardPort: 23333 };
  const rt = createRemoteSshRuntimeBase({
    detectSsh: DETECT_SSH_OK,
    spawn,
    getHookServerPort: () => 23335,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    resolveRemoteNodeBin: () => pendingResolver,
  });

  rt.connect(profile);
  timers.flushWhere((t) => t.ms === 0);
  assert.equal(spawnCalls.length, 2, "main tunnel + first bare-node probe");
  spawnCalls[1].child._fakeExit(127);
  await new Promise((r) => setImmediate(r));

  rt.disconnect("p1");
  rt.connect(profile);
  assert.equal(spawnCalls.length, 3, "reconnect should spawn a fresh main tunnel");
  timers.flushWhere((t) => t.ms === 0);
  assert.equal(spawnCalls.length, 4,
    "fresh reconnect should not be blocked by the stale resolver from the prior tunnel");

  resolveNode({ ok: true, nodeBin: "/usr/bin/node", version: "v20.0.0", source: "test" });
  await new Promise((r) => setImmediate(r));
  rt.cleanup();
});

test("connect uses persisted remote Node path and skips background resolver", async () => {
  clearRemoteNodeCache();
  const spawnCalls = [];
  let resolverCalled = false;
  const spawn = (cmd, args, opts) => {
    const child = makeMockChild();
    spawnCalls.push({ cmd, args, opts, child });
    return child;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntimeBase({
    detectSsh: DETECT_SSH_OK,
    spawn,
    getHookServerPort: () => 23335,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    resolveRemoteNodeBin: () => {
      resolverCalled = true;
      return { ok: true, nodeBin: "/bad/node", version: "v20.0.0", source: "test" };
    },
  });

  rt.connect({
    id: "p1",
    host: "user@pi",
    remoteForwardPort: 23333,
    detectedRemoteNodeBin: "/home/me/.nvm/versions/node/v22/bin/node",
    detectedRemoteNodeVersion: "v22.1.0",
    detectedRemoteNodeSource: "profile",
  });
  timers.flush();

  assert.equal(resolverCalled, false);
  const probeCmd = spawnCalls[1].args[spawnCalls[1].args.length - 1];
  assert.ok(probeCmd.startsWith("'/home/me/.nvm/versions/node/v22/bin/node' -e "));
  rt.cleanup();
});

test("cached absolute node probe failure clears cache and re-resolves", async () => {
  clearRemoteNodeCache();
  const spawnCalls = [];
  const resolverCalls = [];
  const spawn = (cmd, args, opts) => {
    const child = makeMockChild();
    spawnCalls.push({ cmd, args, opts, child });
    return child;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntimeBase({
    detectSsh: DETECT_SSH_OK,
    spawn,
    getHookServerPort: () => 23335,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    resolveRemoteNodeBin: (options) => {
      resolverCalls.push(options);
      return { ok: true, nodeBin: "/usr/bin/node", version: "v20.0.0", source: "path" };
    },
  });

  rt.connect({
    id: "p1",
    host: "user@pi",
    remoteForwardPort: 23333,
    detectedRemoteNodeBin: "/stale/node",
    detectedRemoteNodeVersion: "v20.0.0",
    detectedRemoteNodeSource: "profile",
  });
  timers.flushWhere((t) => t.ms === 0);
  assert.equal(spawnCalls.length, 2, "main tunnel + cached-path probe");
  assert.ok(spawnCalls[1].args[spawnCalls[1].args.length - 1].startsWith("'/stale/node' -e "));

  spawnCalls[1].child._fakeExit(127);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].useCache, false);

  timers.flushWhere((t) => t.ms === PROBE_MIN_GAP_MS);
  assert.equal(spawnCalls.length, 3, "resolved path should schedule a replacement probe");
  assert.ok(spawnCalls[2].args[spawnCalls[2].args.length - 1].startsWith("'/usr/bin/node' -e "));
  rt.cleanup();
});

test("connect emits remote-node-detected when background resolver succeeds", async () => {
  clearRemoteNodeCache();
  const spawnCalls = [];
  const spawn = (cmd, args, opts) => {
    const child = makeMockChild();
    spawnCalls.push({ cmd, args, opts, child });
    return child;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntimeBase({
    detectSsh: DETECT_SSH_OK,
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    resolveRemoteNodeBin: async () => ({
      ok: true,
      nodeBin: "/usr/local/bin/node",
      version: "v20.10.0",
      source: "path",
    }),
  });
  const events = [];
  rt.on("remote-node-detected", (payload) => events.push(payload));
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  timers.flushWhere((t) => t.ms === 0);
  spawnCalls[1].child._fakeExit(0);

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(events.length, 1);
  assert.equal(events[0].id, "p1");
  assert.equal(events[0].nodeBin, "/usr/local/bin/node");
  assert.equal(events[0].expectedTarget.host, "pi");
  rt.cleanup();
});

test("connect classifies Permission denied as permanent failed (no retry)", async () => {
  const mainChild = makeMockChild();
  const spawn = () => mainChild;
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  const events = [];
  rt.on("status-changed", (s) => events.push(s));
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });

  mainChild._fakeStderr("ssh: Permission denied (publickey).");
  await new Promise((r) => setImmediate(r));
  mainChild._fakeExit(255);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const last = events[events.length - 1];
  assert.equal(last.status, "failed");
  assert.equal(last.lastErrorReason, "auth_denied");
  assert.equal(last.hint, "remoteSshErrAuthDenied");
  rt.cleanup();
});

test("connect preserves auth failures reported by remote Node resolver", async () => {
  const spawnCalls = [];
  const spawn = () => {
    const child = makeMockChild();
    spawnCalls.push(child);
    return child;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    resolveRemoteNodeBin: async () => ({
      ok: false,
      stderr: "ssh: Permission denied (publickey).",
      message: "Remote Node.js not found (ssh: Permission denied)",
    }),
  });
  const events = [];
  rt.on("status-changed", (s) => events.push(s));
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  timers.flushWhere((t) => t.ms === 0);
  spawnCalls[1]._fakeExit(127);

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const last = events[events.length - 1];
  assert.equal(last.status, "failed");
  assert.equal(last.lastErrorReason, "auth_denied");
  assert.equal(last.hint, "remoteSshErrAuthDenied");
  rt.cleanup();
});

test("connect classifies Connection timed out as transient + schedules reconnect", async () => {
  const children = [];
  const spawn = () => {
    const c = makeMockChild();
    children.push(c);
    return c;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  const events = [];
  rt.on("status-changed", (s) => events.push(s));
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  const mainChild = children[0];
  mainChild._fakeStderr("ssh: connect to host pi port 22: Connection timed out");
  await new Promise((r) => setImmediate(r));
  mainChild._fakeExit(255);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const reconnectEv = events.find((e) => e.status === "reconnecting");
  assert.ok(reconnectEv, "should enter reconnecting");
  assert.equal(reconnectEv.lastErrorReason, "net_timeout");
  assert.equal(reconnectEv.hint, "remoteSshErrNetTimeout");
  // Status is reconnecting, not failed.
  assert.equal(rt.getProfileStatus("p1").status, "reconnecting");
  rt.cleanup();
});

test("3 unknown exits in a row escalate to permanent failed", async () => {
  let nextChild = null;
  const spawn = () => {
    nextChild = makeMockChild();
    return nextChild;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });

  // Helper to simulate one unknown-stderr exit then flush backoff timer.
  async function unknownExit() {
    nextChild._fakeStderr("Some weird unfamiliar message");
    await new Promise((r) => setImmediate(r));
    nextChild._fakeExit(99);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
  await unknownExit(); // strike 1
  assert.equal(rt.getProfileStatus("p1").status, "reconnecting");
  timers.flush(); // fire backoff → reconnect spawns next child
  await unknownExit(); // strike 2
  assert.equal(rt.getProfileStatus("p1").status, "reconnecting");
  timers.flush();
  await unknownExit(); // strike 3 → escalate
  assert.equal(rt.getProfileStatus("p1").status, "failed");
  assert.equal(rt.getProfileStatus("p1").lastErrorReason, "unknown_strikes");
  rt.cleanup();
});

test("disconnect tears down child, sets idle, and stops reconnect", async () => {
  const mainChild = makeMockChild();
  const spawn = () => mainChild;
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  rt.disconnect("p1");
  assert.equal(rt.getProfileStatus("p1").status, "idle");
  assert.equal(rt.getProfileStatus("p1").hint, null);
  assert.equal(mainChild._killed, true);
  rt.cleanup();
});

test("disconnect on unknown profile is a no-op", () => {
  const rt = createRemoteSshRuntime({ getHookServerPort: () => 23333 });
  const result = rt.disconnect("nope");
  assert.equal(result.profileId, "nope");
  assert.equal(result.status, "idle");
  rt.cleanup();
});

test("getHookServerPort failure → finishFailure with no_local_port", () => {
  const rt = createRemoteSshRuntime({
    spawn: () => { throw new Error("should not spawn"); },
    getHookServerPort: () => null,
  });
  const events = [];
  rt.on("status-changed", (s) => events.push(s));
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  const failed = events.find((e) => e.status === "failed");
  assert.ok(failed);
  assert.equal(failed.lastErrorReason, "no_local_port");
});

test("connect on already-connected is idempotent", () => {
  const child = makeMockChild();
  const rt = createRemoteSshRuntime({
    spawn: () => child,
    getHookServerPort: () => 23333,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  // Hand-flip status — simulating a probe success.
  const before = rt.getProfileStatus("p1");
  // Calling connect again should not throw.
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  const after = rt.getProfileStatus("p1");
  assert.equal(before.status, after.status);
  rt.cleanup();
});

test("probe child error event clears probeInFlight (defensive against missing exit)", async () => {
  // Simulate the edge case where a probe child only emits 'error' (e.g. stdio
  // pipe failure) and never emits 'exit'. Without the defensive cleanup the
  // probeInFlight lock would stay true and starve future probes.
  const children = [];
  const spawn = () => {
    const c = makeMockChild();
    children.push(c);
    return c;
  };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  // children[0] is main ssh; flush probe schedule timer to actually spawn probe.
  timers.flush();
  await new Promise((r) => setImmediate(r));
  // children[1] is probe.
  assert.ok(children[1], "probe child should be spawned after flush");
  const probe = children[1];
  // Emit error WITHOUT exit — verify probe lock clears anyway and another
  // probe can spawn after window-gap timer flushes.
  probe.emit("error", new Error("synthetic stdio pipe failure"));
  await new Promise((r) => setImmediate(r));
  // Trigger the next-probe scheduler.
  timers.flush();
  await new Promise((r) => setImmediate(r));
  // A new probe child should have spawned (children[2]).
  assert.ok(children[2], "next probe must be allowed after error-only cleanup");
  rt.cleanup();
});

// ── Stale-child identity gates ──
//
// Repro for codex review #7: a Disconnect → Connect cycle leaves the prior
// child's exit/error event pending. Without identity gating, when that
// stale event finally fires its closure mutates the runtime state that now
// references the *new* child — orphaning the new tunnel, falsely flipping
// status, or polluting probe lock/exit-code.

test("stale main ssh exit (post Disconnect+Connect) is identity-gated", async () => {
  const children = [];
  const spawn = () => { const c = makeMockChild(); children.push(c); return c; };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  const childA = children[0];
  // Disconnect kills A (queues A.exit microtask via the mock kill()).
  // Then synchronously reconnect — spawns B before A.exit fires.
  rt.disconnect("p1");
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  const childB = children[1];
  assert.notEqual(childA, childB);
  // Drain microtasks — A.exit fires NOW; identity gate must drop it.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // State must still reference B; status must be connecting (not reconnecting / idle).
  assert.equal(rt.getProfileStatus("p1").status, "connecting",
    "stale A.exit must not flip B's status");
  // Sanity: B's own exit handler must still work.
  childB._fakeStderr("ssh: connect to host pi port 22: Connection timed out");
  await new Promise((r) => setImmediate(r));
  childB._fakeExit(255);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(rt.getProfileStatus("p1").status, "reconnecting",
    "B's own exit must still be handled normally");
  rt.cleanup();
});

test("stale main ssh error (post Disconnect+Connect) is identity-gated", async () => {
  const children = [];
  const spawn = () => { const c = makeMockChild(); children.push(c); return c; };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  const childA = children[0];
  rt.disconnect("p1");
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  // A's error fires after we've already swapped to B.
  childA.emit("error", Object.assign(new Error("late ENOENT"), { code: "ENOENT" }));
  await new Promise((r) => setImmediate(r));
  // Without identity gate, A's error would have called finishFailure → status=failed,
  // which would also mark state.stopped=true and orphan B. Verify B stays alive.
  assert.equal(rt.getProfileStatus("p1").status, "connecting",
    "stale A.error must not flip B's status to failed");
  rt.cleanup();
});

test("stale probe exitCode=0 (after probe rotation) does NOT falsely flip new connection to connected", async () => {
  const children = [];
  const spawn = () => { const c = makeMockChild(); children.push(c); return c; };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  // children[0] = main A; flush schedNextProbe timer to actually spawn probe1.
  timers.flush();
  await new Promise((r) => setImmediate(r));
  const probe1 = children[1];
  assert.ok(probe1, "probe1 should be spawned");
  // Disconnect kills probe1 (queues exit) and main A. Reconnect spawns
  // main B + (after timer flush) probe2.
  rt.disconnect("p1");
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  timers.flush();
  await new Promise((r) => setImmediate(r));
  const probe2 = children[3];
  assert.ok(probe2, "probe2 should be spawned");
  assert.notEqual(probe1, probe2);

  // Now stale probe1 emits exitCode 0 (would normally trigger onProbeSuccess).
  // Identity gate must drop it — status stays connecting, NOT connected.
  probe1.emit("exit", 0, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(rt.getProfileStatus("p1").status, "connecting",
    "stale probe1 exit=0 must NOT mark new connection connected");

  // probe2's own exitCode 0 should still flip to connected.
  probe2.emit("exit", 0, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(rt.getProfileStatus("p1").status, "connected");
  rt.cleanup();
});

test("stale probe error (after probe rotation) does NOT clear new probe's lock", async () => {
  const children = [];
  const spawn = () => { const c = makeMockChild(); children.push(c); return c; };
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  timers.flush();
  await new Promise((r) => setImmediate(r));
  const probe1 = children[1];
  rt.disconnect("p1");
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  timers.flush();
  await new Promise((r) => setImmediate(r));
  const probe2 = children[3];
  assert.notEqual(probe1, probe2);

  // Stale probe1.error must not touch probe2's state. We verify by then
  // emitting probe2.exit(0) — if probe1's error had cleared probeChild
  // and overwritten probeLastExitCode, the gate inside the runtime would
  // still treat probe2.exit(0) as the live success. Either way the
  // "stale event must not affect current state" property is what we
  // assert: probe1.error first, then probe2.exit(0) should still flip
  // status to connected (proving probe2 is still being tracked).
  probe1.emit("error", new Error("synthetic late stdio error"));
  await new Promise((r) => setImmediate(r));
  // Status should still be connecting (probe1 error was dropped).
  assert.equal(rt.getProfileStatus("p1").status, "connecting");
  // Now probe2 succeeds for real.
  probe2.emit("exit", 0, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(rt.getProfileStatus("p1").status, "connected",
    "probe2 must still be tracked and able to flip status");
  rt.cleanup();
});

test("cleanup() kills aux children registered via registerChild()", () => {
  // Deploy / Codex monitor spawn one-shot ssh / scp children that aren't
  // tracked in per-profile state. cleanup() must still reach them so
  // before-quit doesn't orphan a Deploy in progress.
  const rt = createRemoteSshRuntime({
    spawn: () => makeMockChild(),
    getHookServerPort: () => 23333,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  const child1 = makeMockChild();
  const child2 = makeMockChild();
  rt.registerChild(child1);
  rt.registerChild(child2);
  rt.cleanup();
  assert.equal(child1._killed, true);
  assert.equal(child2._killed, true);
});

test("unregisterChild() drops child from cleanup set", () => {
  const rt = createRemoteSshRuntime({
    spawn: () => makeMockChild(),
    getHookServerPort: () => 23333,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  const child = makeMockChild();
  rt.registerChild(child);
  rt.unregisterChild(child);
  rt.cleanup();
  // child was unregistered before cleanup → not killed by cleanup.
  assert.equal(child._killed, undefined);
});

test("listStatuses returns array of all known profile snapshots", () => {
  const rt = createRemoteSshRuntime({
    spawn: () => makeMockChild(),
    getHookServerPort: () => 23333,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  rt.connect({ id: "p1", host: "pi", remoteForwardPort: 23333 });
  rt.connect({ id: "p2", host: "mac", remoteForwardPort: 23334 });
  const list = rt.listStatuses();
  assert.equal(list.length, 2);
  const ids = list.map((x) => x.profileId).sort();
  assert.deepEqual(ids, ["p1", "p2"]);
  rt.cleanup();
});
