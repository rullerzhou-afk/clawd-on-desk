"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("events");

const {
  buildSshArgs,
  buildScpArgs,
  parseOpenSshVersion,
  isUnsupportedWindowsOpenSsh,
  classifyStderr,
  looksLikeWindowsCmdStderr,
  classifyProbeExit,
  buildProbeCommand,
  buildPersistentReadinessCommand,
  backoffMsForAttempt,
  tunnelTargetKey,
  checkSecureConnectReadiness,
  createRemoteSshRuntime: createRemoteSshRuntimeBase,
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  PROBE_MIN_GAP_MS,
  PROBE_CHILD_TIMEOUT_MS,
  BACKOFF_SCHEDULE_MS,
  FORWARD_RECOVERY_FAILURE_LIMIT,
} = require("../src/remote-ssh-runtime");
const { clearRemoteNodeCache } = require("../src/remote-ssh-node");
const { createRemoteSshTransportCoordinator } = require("../src/remote-ssh-transport-coordinator");

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

function extractBareProbeJs(command) {
  assert.ok(command.startsWith("node -e "));
  const loader = JSON.parse(command.slice("node -e ".length));
  const match = /^eval\(Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)\.toString\('utf8'\)\)$/.exec(loader);
  assert.ok(match, "bare node probe must use the cross-shell base64 loader");
  return Buffer.from(match[1], "base64").toString("utf8");
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

// NOTE: ssh -o is FIRST-WINS, not last-wins (ssh_config(5): "the first
// obtained value will be used"). Asserting `args[lastIndex] === "Foo=bar"`
// does NOT prove ssh ends up with Foo=bar — it only proves where the token
// sits in the array. These tests assert effective config by counting tokens
// and checking the FIRST one, which is what ssh actually honors.

test("buildSshArgs extraOpts cannot override base BatchMode (ssh first-wins)", () => {
  // Even though BatchMode=no is appended after BatchMode=yes, ssh resolves
  // the first occurrence — so non-interactive callers can NOT flip BatchMode
  // by appending. This test pins that contract so a future "just add it to
  // extraOpts" attempt fails loudly here instead of silently in production.
  const args = buildSshArgs(
    { host: "pi" },
    { extraOpts: ["-o", "BatchMode=no"] }
  );
  const bmTokens = args.filter((v) => typeof v === "string" && v.startsWith("BatchMode="));
  assert.equal(bmTokens.length, 2, "both tokens present in argv");
  assert.equal(bmTokens[0], "BatchMode=yes", "first BatchMode wins; base must come first");
});

test("buildSshArgs validates extraOpts is an array", () => {
  assert.throws(() => buildSshArgs({ host: "pi" }, { extraOpts: "no" }), /must be an array/);
});

test("buildSshArgs default keeps -T (correct for backgrounded tunnels)", () => {
  const args = buildSshArgs({ host: "pi" });
  assert.ok(args.includes("-T"), "non-interactive must include -T");
});

test("buildSshArgs interactive: true uses empty base (no -T, BatchMode, ConnectTimeout)", () => {
  const args = buildSshArgs({ host: "pi" }, { interactive: true });
  assert.equal(args.includes("-T"), false, "interactive must drop -T to let pty negotiate");
  assert.equal(
    args.some((v) => typeof v === "string" && v.startsWith("BatchMode=")),
    false,
    "interactive base must not carry BatchMode (would block password / passphrase / host-key prompts)"
  );
  assert.equal(
    args.some((v) => typeof v === "string" && v.startsWith("ConnectTimeout=")),
    false,
    "interactive base must not carry ConnectTimeout (user-initiated, they can wait)"
  );
  // Order check: host still last.
  assert.equal(args[args.length - 1], "pi");
});

test("buildSshArgs interactive + BatchMode=no extraOpt: BatchMode=no is the only and first token", () => {
  // With SSH_INTERACTIVE_BASE_OPTS empty, BatchMode=no from extraOpts is the
  // FIRST and ONLY BatchMode ssh sees → effective config is BatchMode=no, so
  // password / passphrase / host-key prompts can fire. This is the fix for
  // issue #348 (Authenticate / Open Terminal path).
  const args = buildSshArgs(
    { host: "pi" },
    { interactive: true, extraOpts: ["-o", "BatchMode=no"] }
  );
  const bmTokens = args.filter((v) => typeof v === "string" && v.startsWith("BatchMode="));
  assert.equal(bmTokens.length, 1, "interactive base is empty; only the extraOpt BatchMode survives");
  assert.equal(bmTokens[0], "BatchMode=no");
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

test("classifyProbeExit 5 → permanent (secure identity missing or invalid)", () => {
  const c = classifyProbeExit(5);
  assert.equal(c.kind, "permanent");
  assert.equal(c.reason, "probe_secure_identity_invalid");
  assert.equal(c.hint, "remoteSshErrSecureIdentityMissing");
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
  const raw = extractBareProbeJs(cmd);
  assert.ok(raw.includes("23335"));
  assert.ok(raw.includes(CLAWD_SERVER_HEADER));
  assert.ok(raw.includes(CLAWD_SERVER_ID));
  // Must contain the v7-required exit codes.
  assert.ok(raw.includes("process.exit(3)"), "header mismatch exit");
  assert.ok(raw.includes("process.exit(2)"), "http error event exit");
  assert.ok(raw.includes("process.exit(4)"), "req.setTimeout exit");
  // setTimeout for HTTP layer (not just ssh ConnectTimeout).
  assert.ok(raw.includes("setTimeout(2000"));
});

test("buildProbeCommand can use a resolved absolute remote Node path", () => {
  const cmd = buildProbeCommand(23335, "/home/me/.nvm/versions/node/v22/bin/node");
  assert.ok(cmd.startsWith("'/home/me/.nvm/versions/node/v22/bin/node' -e "));
  assert.ok(cmd.includes("23335"));
});

test("buildProbeCommand returns valid JS that exits with each code under expected condition", () => {
  const cmd = buildProbeCommand(23333);
  const raw = extractBareProbeJs(cmd);
  // Verify the raw JS starts with the expected request creation.
  assert.match(raw, /^const r=require\('http'\)\.get/);
  // Header check appears before status check (v7 order fix).
  const headerIdx = raw.indexOf("headers[");
  const statusIdx = raw.indexOf("statusCode===200");
  assert.ok(headerIdx >= 0 && statusIdx >= 0);
  assert.ok(headerIdx < statusIdx, "header check must precede status check");
});

test("secure probe reads the exact resolved identity path and never carries the nonce in argv", () => {
  const nonce = "a".repeat(32);
  const account = buildProbeCommand(23334, "node", {
    profile: {
      id: "profile-a",
      installId: "b".repeat(64),
      runtimeMode: "account-default",
      runtimeKey: "account-default",
      layoutVersion: 1,
      remoteHome: "/home/alice",
      routingNonce: nonce,
    },
  });
  const accountJs = extractBareProbeJs(account);
  assert.match(accountJs, /\/home\/alice\/\.claude\/hooks\/clawd-remote\.json/);
  assert.doesNotMatch(accountJs, /process\.env\.HOME/);
  assert.doesNotMatch(account, new RegExp(nonce));
  assert.match(accountJs, /i\.version!==2/);
  assert.match(accountJs, /i\.remotePort!==23334/);
  assert.match(accountJs, /Number\.isFinite\(i\.deployedAt\)/);

  const isolated = buildProbeCommand(23335, "node", {
    profile: {
      id: "profile-b",
      installId: "c".repeat(64),
      runtimeMode: "profile-isolated",
      runtimeKey: "runtime_b",
      layoutVersion: 1,
      remoteHome: "/srv/shared",
      routingNonce: nonce,
    },
  });
  const isolatedJs = extractBareProbeJs(isolated);
  assert.match(
    isolatedJs,
    /\/srv\/shared\/\.clawd\/profiles\/runtime_b\/claude\/hooks\/clawd-remote\.json/,
  );
  assert.doesNotMatch(isolatedJs, /\/srv\/shared\/\.claude/);
  assert.doesNotMatch(isolated, new RegExp(nonce));

  const missingLayout = buildProbeCommand(23335, "node", {
    profile: {
      id: "profile-b",
      installId: "c".repeat(64),
      runtimeMode: "profile-isolated",
      runtimeKey: "runtime_b",
      layoutVersion: 1,
    },
  });
  const missingLayoutJs = extractBareProbeJs(missingLayout);
  assert.match(missingLayoutJs, /process\.exit\(5\)/);
  assert.doesNotMatch(missingLayoutJs, /process\.env\.HOME/);
});

test("persistent readiness command carries a random marker, secure identity checks, retries, and stdin EOF stop", () => {
  const profile = makeSecureProfile();
  const command = buildPersistentReadinessCommand(23333, "/usr/bin/node", {
    profile,
    challenge: "c".repeat(32),
  });
  assert.match(command, /__CLAWD_REMOTE_READY__/);
  assert.match(command, /process\.stdin\.once/);
  assert.match(command, /setTimeout\(attempt,250\)/);
  assert.match(command, /x-clawd-server/);
  assert.doesNotMatch(command, new RegExp(profile.routingNonce));
});

test("bare node secure probe keeps remoteHome shell metacharacters opaque", {
  skip: process.platform === "win32",
}, () => {
  const command = buildProbeCommand(23335, "node", {
    profile: {
      id: "profile-a",
      installId: "b".repeat(64),
      runtimeMode: "account-default",
      runtimeKey: "account-default",
      layoutVersion: 1,
      remoteHome: "/tmp/$HOME/$(printf SHELL_EXPANDED)/`printf BACKTICK_EXPANDED`",
    },
  });
  const raw = extractBareProbeJs(command);
  assert.match(raw, /\$HOME/);
  assert.match(raw, /\$\(printf SHELL_EXPANDED\)/);
  assert.match(raw, /`printf BACKTICK_EXPANDED`/);
  assert.doesNotMatch(command, /\$HOME|SHELL_EXPANDED|BACKTICK_EXPANDED/);

  const result = childProcess.spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  assert.strictEqual(result.status, 5, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /SHELL_EXPANDED|BACKTICK_EXPANDED/);
});

// ── looksLikeWindowsCmdStderr ──
//
// One-shot suppression of the "remote Node resolver failed after probe
// success" log on Windows-cmd remotes: every reconnect would otherwise
// reprobe and re-fail with the same "sh is not recognized" stderr.
test("looksLikeWindowsCmdStderr matches the English cmd.exe error", () => {
  assert.ok(looksLikeWindowsCmdStderr("'sh' is not recognized as an internal or external command, operable program or batch file."));
  assert.ok(looksLikeWindowsCmdStderr("ssh: 'node' is NOT RECOGNIZED AS AN INTERNAL OR EXTERNAL COMMAND"));
});

test("looksLikeWindowsCmdStderr matches localized cmd.exe error (zh/zh-TW/ja/ko/de)", () => {
  assert.ok(looksLikeWindowsCmdStderr("'sh' 不是内部或外部命令，也不是可运行的程序或批处理文件。"));
  assert.ok(looksLikeWindowsCmdStderr("'sh' 不是內部或外部命令，也不是可執行的程式或批次檔。"));
  assert.ok(looksLikeWindowsCmdStderr("'sh' は、内部コマンドまたは外部コマンド、操作可能なプログラムまたはバッチ ファイルとして認識されていません。"));
  assert.ok(looksLikeWindowsCmdStderr("'sh'은(는) 내부 명령 또는 외부 명령, 실행할 수 있는 프로그램, 또는 배치 파일이 아닙니다."));
  assert.ok(looksLikeWindowsCmdStderr("Der Befehl 'sh' ist entweder falsch geschrieben oder konnte nicht als interner oder externer Befehl gefunden werden."));
});

test("looksLikeWindowsCmdStderr ignores unrelated POSIX errors", () => {
  assert.equal(looksLikeWindowsCmdStderr(""), false);
  assert.equal(looksLikeWindowsCmdStderr("bash: sh: command not found"), false);
  assert.equal(looksLikeWindowsCmdStderr("Permission denied (publickey)."), false);
  assert.equal(looksLikeWindowsCmdStderr("sh: line 1: syntax error"), false);
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

test("forward recovery has a fixed four-conflict budget", () => {
  assert.equal(FORWARD_RECOVERY_FAILURE_LIMIT, 4);
});

test("tunnelTargetKey tracks bind identity but not deploy metadata", () => {
  const profile = makeSecureProfile();
  const key = tunnelTargetKey(profile);
  for (const changed of [
    { host: "user@other" },
    { port: 2222 },
    { identityFile: "/keys/other" },
    { remoteForwardPort: 23334 },
    { installId: "c".repeat(64) },
    { runtimeMode: "profile-isolated" },
    { runtimeKey: "runtime_p1" },
    { layoutVersion: 2 },
  ]) {
    assert.notEqual(tunnelTargetKey({ ...profile, ...changed }), key);
  }
  assert.equal(tunnelTargetKey({
    ...profile,
    routingNonce: "d".repeat(32),
    previousNonce: "e".repeat(32),
    hostPrefix: "lab",
    chainStatusline: true,
    remoteHome: "/srv/user",
    lastDeployedAt: profile.lastDeployedAt + 1,
  }), key);
});

test("secure connect readiness requires a stamp, resolved layout, and accepted nonce", () => {
  const ready = makeSecureProfile();
  assert.deepEqual(checkSecureConnectReadiness(ready), { ok: true });

  const missingStamp = checkSecureConnectReadiness({ ...ready, lastDeployedAt: undefined });
  assert.equal(missingStamp.reason, "deployment_required");
  assert.equal(missingStamp.detail, "deployment_stamp_missing");

  const missingLayout = checkSecureConnectReadiness({ ...ready, remoteHome: undefined });
  assert.equal(missingLayout.reason, "deployment_required");
  assert.equal(missingLayout.detail, "secure_layout_missing");

  const missingNonce = checkSecureConnectReadiness({ ...ready, routingNonce: undefined });
  assert.equal(missingNonce.reason, "deployment_required");
  assert.equal(missingNonce.detail, "secure_identity_missing");
});

// ── Factory: state machine with mocked spawn ──

function makeMockChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    endCalls: 0,
    end() { this.endCalls += 1; },
  };
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
  child._fakeStdout = (text) => {
    queueMicrotask(() => child.stdout.emit("data", Buffer.from(text)));
  };
  child._fakeClose = (code, signal) => {
    queueMicrotask(() => child.emit("close", code != null ? code : null, signal || null));
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

function makeSecureProfile(overrides = {}) {
  return {
    id: "p1",
    host: "user@pi",
    remoteForwardPort: 23333,
    installId: "a".repeat(64),
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
    routingNonce: "b".repeat(32),
    remoteHome: "/home/user",
    lastDeployedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeSecureIngress() {
  return {
    start: async () => 31234,
    close: async () => {},
    getStatus: () => ({ port: 31234, rejectedCount: 0 }),
  };
}

async function flushAsyncEvents() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function connectSecureProfile(rt, timers, children, profile) {
  rt.connect(profile);
  await flushAsyncEvents();
  const mainChild = children[children.length - 1];
  timers.flushWhere((timer) => timer.ms === 0);
  const probeChild = children[children.length - 1];
  assert.notEqual(probeChild, mainChild, "health probe should spawn after the tunnel");
  probeChild._fakeExit(0);
  await flushAsyncEvents();
  assert.equal(rt.getProfileStatus(profile.id).status, "connected");
  return mainChild;
}

async function exitSsh(child, stderr, code = 255) {
  child._fakeStderr(stderr);
  await flushAsyncEvents();
  child._fakeExit(code);
  await flushAsyncEvents();
}

test("createRemoteSshRuntime requires getHookServerPort dep", () => {
  assert.throws(() => createRemoteSshRuntime({}), /getHookServerPort/);
});

test("serialized Connect uses one persistent SSH for readiness and drains on close", async () => {
  const children = [];
  const spawn = (_command, args, opts) => {
    const child = makeMockChild();
    child._args = args;
    child._opts = opts;
    children.push(child);
    return child;
  };
  const coordinator = createRemoteSshTransportCoordinator({
    spawn,
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:fuzzy-space",
      fingerprint: "fp",
    }),
    drainTimeoutMs: 1000,
  });
  const profile = makeSecureProfile({ sshTransportMode: "auto" });
  const admitted = await coordinator.acquireConnection(profile);
  const rt = createRemoteSshRuntime({
    spawn,
    transportCoordinator: coordinator,
    createProfileIngress: () => makeSecureIngress(),
    getHookServerPort: () => 23333,
  });
  rt.connect(profile, {
    serialized: true,
    transportInspection: admitted.inspection,
    transportContext: admitted.context,
  });
  await flushAsyncEvents();
  assert.equal(children.length, 1, "serialized runtime must not spawn a second health SSH");
  const tunnel = children[0];
  assert.equal(tunnel._args.includes("-N"), false);
  assert.equal(tunnel._args.includes("-v"), true,
    "serialized tunnels need DEBUG1 so Win32 Codespaces forward failures are classifiable");
  assert.ok(tunnel._args.includes("-R"));
  const command = String(tunnel._args.at(-1));
  const marker = /__CLAWD_REMOTE_READY__:[a-f0-9]{32}/.exec(command);
  assert.ok(marker, "persistent command carries the per-connect ready marker");
  tunnel._fakeStdout(`startup banner\r\n${marker[0]}\r\n`);
  await flushAsyncEvents();
  assert.equal(rt.getProfileStatus(profile.id).status, "connected");

  const operation = await coordinator.acquireOperation(profile, "deploy");
  const drain = rt.suspendForOperation(profile.id, operation.context);
  let drained = false;
  drain.then(() => { drained = true; });
  assert.equal(tunnel.stdin.endCalls, 1, "suspend must send stdin EOF");
  tunnel._fakeExit(0);
  await flushAsyncEvents();
  assert.equal(drained, false, "exit alone must not satisfy the drain barrier");
  tunnel._fakeClose(0);
  await drain;
  assert.equal(drained, true);
  assert.equal(children.length, 1);
  const finalized = rt.finalizeSerializedDisconnect(profile.id, operation.context);
  assert.equal(finalized.transportPhase, "idle");
  assert.equal(finalized.transportOwnerProfileId, null);

  const resumed = await coordinator.acquireConnection(profile);
  rt.connect(profile, {
    serialized: true,
    transportContext: resumed.context,
  });
  await flushAsyncEvents();
  assert.equal(children.length, 2);
  assert.equal(children[1]._args.includes("-v"), true,
    "operation resume retains the immutable Codespaces inspection");
  children[1]._fakeExit(3);
  children[1]._fakeClose(3);
  await flushAsyncEvents();
  rt.cleanup();
});

test("an explicit serialized non-Codespaces tunnel does not enable verbose SSH logging", async () => {
  const children = [];
  const spawn = (_command, args) => {
    const child = makeMockChild();
    child._args = args;
    children.push(child);
    return child;
  };
  const coordinator = createRemoteSshTransportCoordinator({
    spawn,
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "explicit-serialized",
      key: "destination-sha256:explicit-test",
      fingerprint: "fp-explicit-test",
    }),
  });
  const profile = makeSecureProfile({
    host: "explicit-proxy@unique-host",
    sshTransportMode: "serialized",
  });
  const admitted = await coordinator.acquireConnection(profile);
  const rt = createRemoteSshRuntime({
    spawn,
    transportCoordinator: coordinator,
    createProfileIngress: () => makeSecureIngress(),
    getHookServerPort: () => 23333,
  });
  rt.connect(profile, {
    serialized: true,
    transportInspection: admitted.inspection,
    transportContext: admitted.context,
  });
  await flushAsyncEvents();
  assert.equal(children.length, 1);
  assert.equal(children[0]._args.includes("-v"), false);
  assert.equal(children[0]._args.includes("-N"), false);
  children[0]._fakeExit(3);
  children[0]._fakeClose(3);
  await flushAsyncEvents();
  rt.cleanup();
});

test("serialized direct Disconnect publishes the released transport phase after child close", async () => {
  const children = [];
  const spawn = () => {
    const child = makeMockChild();
    children.push(child);
    return child;
  };
  const coordinator = createRemoteSshTransportCoordinator({
    spawn,
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:direct-disconnect",
      fingerprint: "fp-direct-disconnect",
    }),
  });
  const profile = makeSecureProfile({ host: "direct-disconnect@unique-host" });
  const admitted = await coordinator.acquireConnection(profile);
  const rt = createRemoteSshRuntime({
    spawn,
    transportCoordinator: coordinator,
    createProfileIngress: () => makeSecureIngress(),
    getHookServerPort: () => 23333,
  });
  const events = [];
  rt.on("status-changed", (status) => events.push(status));
  rt.connect(profile, {
    serialized: true,
    transportContext: admitted.context,
  });
  await flushAsyncEvents();
  assert.equal(children.length, 1);

  rt.disconnect(profile.id);
  assert.equal(children[0].stdin.endCalls, 1);
  children[0]._fakeExit(0);
  children[0]._fakeClose(0);
  await flushAsyncEvents();

  const current = rt.getProfileStatus(profile.id);
  assert.equal(current.status, "idle");
  assert.equal(current.transportPhase, "idle");
  assert.equal(current.transportOwnerProfileId, null);
  assert.equal(events.at(-1).transportPhase, "idle");
});

test("an old serialized Connect continuation cannot fail a newer Disconnect-Connect generation", async () => {
  let inspectionCalls = 0;
  let resolveOldInspection;
  const oldInspection = new Promise((resolve) => { resolveOldInspection = resolve; });
  const inspection = {
    mode: "serialized",
    kind: "codespaces-stdio",
    key: "codespace:generation-race",
    fingerprint: "fp-generation-race",
  };
  const children = [];
  const spawn = (_tool, args) => {
    const child = makeMockChild();
    child._args = args;
    children.push(child);
    return child;
  };
  const coordinator = createRemoteSshTransportCoordinator({
    spawn,
    inspectEffectiveTransport: async () => {
      inspectionCalls += 1;
      return inspectionCalls === 2 ? oldInspection : inspection;
    },
  });
  const profile = makeSecureProfile({ host: "generation-race@unique-host" });
  const first = await coordinator.acquireConnection(profile);
  const rt = createRemoteSshRuntime({
    spawn,
    transportCoordinator: coordinator,
    createProfileIngress: () => makeSecureIngress(),
    getHookServerPort: () => 23333,
  });
  rt.connect(profile, { serialized: true, transportContext: first.context });
  await flushAsyncEvents();
  assert.equal(inspectionCalls, 2);
  assert.equal(children.length, 0);

  const disconnect = await coordinator.acquireOwnedOperation(profile, "disconnect");
  assert.equal(disconnect.ok, true);
  await rt.suspendForOperation(profile.id, disconnect.context, { closeIngress: true });
  rt.finalizeSerializedDisconnect(profile.id, disconnect.context);

  const second = await coordinator.acquireConnection(profile);
  assert.equal(second.ok, true);
  rt.connect(profile, { serialized: true, transportContext: second.context });
  for (let i = 0; i < 8 && children.length === 0; i += 1) await flushAsyncEvents();
  assert.equal(children.length, 1, "the new generation must not wait behind the stale task");

  resolveOldInspection(inspection);
  await flushAsyncEvents();
  assert.notEqual(rt.getProfileStatus(profile.id).status, "failed");
  second.context.assertActive();

  const marker = /__CLAWD_REMOTE_READY__:[a-f0-9]{32}/.exec(String(children[0]._args.at(-1)));
  assert.ok(marker);
  children[0]._fakeStdout(`${marker[0]}\n`);
  await flushAsyncEvents();
  assert.equal(rt.getProfileStatus(profile.id).status, "connected");
});

test("a signaled serialized tunnel close cannot schedule a replacement transport", async () => {
  const timers = makeFakeTimers();
  const children = [];
  const spawn = (_tool, args) => {
    const child = makeMockChild();
    child._args = args;
    children.push(child);
    return child;
  };
  const coordinator = createRemoteSshTransportCoordinator({
    spawn,
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:signaled-tunnel",
      fingerprint: "fp-signaled-tunnel",
    }),
  });
  const profile = makeSecureProfile({ host: "signaled-tunnel@unique-host" });
  const admitted = await coordinator.acquireConnection(profile);
  const rt = createRemoteSshRuntime({
    spawn,
    transportCoordinator: coordinator,
    createProfileIngress: () => makeSecureIngress(),
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  rt.connect(profile, { serialized: true, transportContext: admitted.context });
  await flushAsyncEvents();
  assert.equal(children.length, 1);

  children[0]._fakeExit(null, "SIGTERM");
  children[0]._fakeClose(null, "SIGTERM");
  await flushAsyncEvents();
  timers.flush();
  await flushAsyncEvents();

  assert.equal(children.length, 1);
  assert.equal(rt.getProfileStatus(profile.id).status, "failed");
  assert.equal(
    coordinator.snapshotForProfile(profile.id).transportErrorReason,
    "transport_drain_unverified",
  );
});

test("serialized Connect closes Node and monitor one-shots before starting the persistent tunnel", async () => {
  const children = [];
  const spawn = (_command, args, opts) => {
    const child = makeMockChild();
    child._args = args;
    child._opts = opts;
    children.push(child);
    return child;
  };
  const coordinator = createRemoteSshTransportCoordinator({
    spawn,
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:ordered-space",
      fingerprint: "fp-ordered",
    }),
  });
  const profile = makeSecureProfile({ host: "ordered@unique-host" });
  const admitted = await coordinator.acquireConnection(profile);
  let preparationCalls = 0;
  const rt = createRemoteSshRuntime({
    spawn,
    transportCoordinator: coordinator,
    createProfileIngress: () => makeSecureIngress(),
    getHookServerPort: () => 23333,
    resolveRemoteNodeBin: async ({ runtime }) => {
      const child = runtime.spawnManagedTransportChild({
        role: "node-resolve",
        tool: "ssh",
        args: [profile.host, "resolve-node"],
        options: { stdio: ["ignore", "pipe", "pipe"] },
      });
      const closed = new Promise((resolve) => child.once("close", resolve));
      child._fakeExit(0);
      child._fakeClose(0);
      await closed;
      return { ok: true, nodeBin: "/usr/bin/node", version: "v20.1.0", source: "path" };
    },
  });
  rt.connect(profile, {
    serialized: true,
    transportContext: admitted.context,
    prepareSerializedAttempt: async ({ runtime }) => {
      preparationCalls += 1;
      const child = runtime.spawnManagedTransportChild({
        role: "monitor-start",
        tool: "ssh",
        args: [profile.host, "monitor"],
        options: { stdio: ["ignore", "pipe", "pipe"] },
      });
      const closed = new Promise((resolve) => child.once("close", resolve));
      child._fakeExit(0);
      child._fakeClose(0);
      await closed;
      return { ok: true };
    },
  });
  for (let i = 0; i < 8 && children.length < 3; i += 1) {
    await flushAsyncEvents();
  }

  assert.equal(preparationCalls, 1);
  assert.equal(children.length, 3, JSON.stringify({
    args: children.map((child) => child._args),
    status: rt.getProfileStatus(profile.id),
  }));
  assert.equal(children[0]._args.at(-1), "resolve-node");
  assert.equal(children[1]._args.at(-1), "monitor");
  assert.ok(children[2]._args.includes("-R"));
  assert.equal(coordinator._slots.get("codespace:ordered-space").trackedChildren.size, 1);
  const operation = await coordinator.acquireOperation(profile, "disconnect");
  const drain = rt.suspendForOperation(profile.id, operation.context);
  children[2]._fakeExit(0);
  children[2]._fakeClose(0);
  await drain;
  rt.finalizeSerializedDisconnect(profile.id, operation.context);
});

test("serialized Connect aborts before the tunnel when effective transport changes during preparation", async () => {
  const children = [];
  let inspectionCount = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    spawn: (_tool, args) => {
      const child = makeMockChild();
      child._args = args;
      children.push(child);
      return child;
    },
    inspectEffectiveTransport: async () => {
      inspectionCount += 1;
      const changed = inspectionCount >= 3;
      return {
        mode: "serialized",
        kind: "codespaces-stdio",
        key: changed ? "codespace:changed-space" : "codespace:original-space",
        fingerprint: changed ? "fp-changed" : "fp-original",
      };
    },
  });
  const profile = makeSecureProfile({ host: "drifting-alias" });
  const admitted = await coordinator.acquireConnection(profile);
  const rt = createRemoteSshRuntime({
    transportCoordinator: coordinator,
    createProfileIngress: () => makeSecureIngress(),
    getHookServerPort: () => 23333,
  });

  rt.connect(profile, {
    serialized: true,
    transportContext: admitted.context,
    prepareSerializedAttempt: async () => ({ ok: true }),
  });
  await flushAsyncEvents();

  assert.equal(inspectionCount, 3, "admission and both connection boundaries must inspect freshly");
  assert.equal(children.length, 0, "a reservation for the old transport must never spawn against the new target");
  const status = rt.getProfileStatus(profile.id);
  assert.equal(status.status, "failed");
  assert.equal(status.lastErrorReason, "profile_changed");
  assert.equal(coordinator._slots.get("codespace:original-space").phase, "idle");
});

test("Disconnect intent during protected monitor preparation is applied after the same lease releases", async () => {
  const children = [];
  const coordinator = createRemoteSshTransportCoordinator({
    spawn: (_tool, args) => {
      const child = makeMockChild();
      child._args = args;
      children.push(child);
      return child;
    },
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:protected-prepare",
      fingerprint: "fp-protected-prepare",
    }),
  });
  const profile = makeSecureProfile({ host: "protected-prepare" });
  const admitted = await coordinator.acquireConnection(profile);
  let cancelCalls = 0;
  const rt = createRemoteSshRuntime({
    transportCoordinator: coordinator,
    createProfileIngress: () => makeSecureIngress(),
    getHookServerPort: () => 23333,
  });
  rt.connect(profile, {
    serialized: true,
    transportContext: admitted.context,
    prepareSerializedAttempt: async ({ runtime }) => {
      runtime.setManagedLockStage("acquire-attempted");
      const child = runtime.spawnManagedTransportChild({
        role: "monitor-start",
        tool: "ssh",
        args: [profile.host, "monitor-start"],
        options: { stdio: ["ignore", "pipe", "pipe"] },
      });
      await new Promise((resolve) => child.once("close", resolve));
      runtime.setManagedLockStage("before-acquire");
      return { ok: true };
    },
    cancelSerializedAttempt: async ({ runtime }) => {
      cancelCalls += 1;
      runtime.setManagedLockStage("acquire-attempted");
      const child = runtime.spawnManagedTransportChild({
        role: "monitor-stop",
        tool: "ssh",
        args: [profile.host, "monitor-stop"],
        options: { stdio: ["ignore", "pipe", "pipe"] },
      });
      const closed = new Promise((resolve) => child.once("close", resolve));
      child._fakeExit(0);
      child._fakeClose(0);
      await closed;
      runtime.setManagedLockStage("before-acquire");
      return { ok: true };
    },
  });
  await flushAsyncEvents();
  assert.equal(children.length, 1);

  coordinator.recordDisconnectIntent(profile.id);
  const takeover = await coordinator.acquireOwnedOperation(profile, "disconnect");
  assert.equal(takeover.ok, false);
  assert.equal(takeover.code, "transport_operation_busy");
  children[0]._fakeExit(0);
  children[0]._fakeClose(0);
  for (let i = 0; i < 8 && rt.getProfileStatus(profile.id).status !== "idle"; i += 1) {
    await flushAsyncEvents();
  }

  assert.equal(cancelCalls, 1);
  assert.equal(children.length, 2);
  assert.equal(children.some((child) => child._args && child._args.includes("-R")), false);
  assert.equal(rt.getProfileStatus(profile.id).status, "idle");
  assert.equal(coordinator.snapshotForProfile(profile.id).transportPhase, "idle");
});

test("serialized operation takeover never force-kills an in-flight one-shot", async () => {
  const children = [];
  let finishResolve;
  const coordinator = createRemoteSshTransportCoordinator({
    spawn: () => {
      const child = makeMockChild();
      children.push(child);
      return child;
    },
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:takeover-one-shot",
      fingerprint: "fp-takeover",
    }),
    drainTimeoutMs: 5,
  });
  const profile = makeSecureProfile({ host: "takeover@unique-host" });
  const admitted = await coordinator.acquireConnection(profile);
  const rt = createRemoteSshRuntime({
    transportCoordinator: coordinator,
    createProfileIngress: () => makeSecureIngress(),
    getHookServerPort: () => 23333,
    resolveRemoteNodeBin: async ({ runtime }) => {
      const child = runtime.spawnManagedTransportChild({
        role: "node-resolve",
        tool: "ssh",
        args: [profile.host, "resolve-node"],
        options: { stdio: ["ignore", "pipe", "pipe"] },
      });
      return new Promise((resolve) => {
        finishResolve = () => resolve({
          ok: true,
          nodeBin: "/usr/bin/node",
          version: "v20.1.0",
          source: "path",
        });
        child.once("close", finishResolve);
      });
    },
  });
  rt.connect(profile, { serialized: true, transportContext: admitted.context });
  await flushAsyncEvents();
  assert.equal(children.length, 1);

  const operation = await coordinator.acquireOperation(profile, "deploy");
  await assert.rejects(
    rt.suspendForOperation(profile.id, operation.context),
    (err) => err && err.code === "transport_drain_timeout",
  );
  assert.equal(children[0]._killed, undefined, "one-shot outer ssh must not be killed");
  assert.equal(coordinator._slots.get("codespace:takeover-one-shot").phase, "quarantined");

  children[0]._fakeExit(0);
  children[0]._fakeClose(0);
  await flushAsyncEvents();
  if (finishResolve) finishResolve();
  await flushAsyncEvents();
  assert.equal(coordinator._slots.get("codespace:takeover-one-shot").phase, "idle");
});

test("serialized readiness has a local watchdog and quarantines a child that never closes", async () => {
  const children = [];
  let ingressCloses = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    spawn: () => {
      const child = makeMockChild();
      children.push(child);
      return child;
    },
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:hung-readiness",
      fingerprint: "fp-hung-readiness",
    }),
    drainTimeoutMs: 5,
  });
  const profile = makeSecureProfile({ host: "hung-readiness@unique-host" });
  const admitted = await coordinator.acquireConnection(profile);
  const rt = createRemoteSshRuntime({
    transportCoordinator: coordinator,
    createProfileIngress: () => ({
      start: async () => 31234,
      close: async () => { ingressCloses += 1; },
      getStatus: () => ({ port: 31234, rejectedCount: 0 }),
    }),
    getHookServerPort: () => 23333,
    serializedReadinessTimeoutMs: 5,
    serializedReadinessDrainTimeoutMs: 5,
  });
  rt.connect(profile, { serialized: true, transportContext: admitted.context });
  await flushAsyncEvents();
  assert.equal(children.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await flushAsyncEvents();
  const status = rt.getProfileStatus(profile.id);
  assert.equal(status.status, "failed");
  assert.equal(status.transportPhase, "quarantined");
  assert.equal(children[0].stdin.endCalls, 1);
  assert.equal(ingressCloses, 1, "failed readiness must release the profile ingress");
  assert.equal(children.length, 1, "watchdog must not start a replacement transport");

  children[0]._fakeStdout("__CLAWD_REMOTE_READY__:too-late\n");
  await flushAsyncEvents();
  assert.notEqual(rt.getProfileStatus(profile.id).status, "connected");
  children[0]._fakeExit(0);
  children[0]._fakeClose(0);
  await flushAsyncEvents();
});

test("a fired readiness watchdog cannot overwrite a newer explicit Disconnect", async () => {
  const children = [];
  const coordinator = createRemoteSshTransportCoordinator({
    spawn: () => {
      const child = makeMockChild();
      children.push(child);
      return child;
    },
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:watchdog-disconnect-race",
      fingerprint: "fp-watchdog-disconnect-race",
    }),
    drainTimeoutMs: 100,
  });
  const profile = makeSecureProfile({ host: "watchdog-disconnect@unique-host" });
  const admitted = await coordinator.acquireConnection(profile);
  const rt = createRemoteSshRuntime({
    transportCoordinator: coordinator,
    createProfileIngress: () => makeSecureIngress(),
    getHookServerPort: () => 23333,
    serializedReadinessTimeoutMs: 5,
    serializedReadinessDrainTimeoutMs: 100,
  });
  rt.connect(profile, { serialized: true, transportContext: admitted.context });
  await flushAsyncEvents();
  assert.equal(children.length, 1);
  for (let i = 0; i < 10 && children[0].stdin.endCalls === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(children[0].stdin.endCalls, 1, "the watchdog must have entered its drain await");

  rt.disconnect(profile.id);
  assert.equal(rt.getProfileStatus(profile.id).status, "idle");
  children[0]._fakeExit(0);
  children[0]._fakeClose(0);
  await flushAsyncEvents();

  const status = rt.getProfileStatus(profile.id);
  assert.equal(status.status, "idle");
  assert.equal(status.transportPhase, "idle");
  assert.notEqual(status.lastErrorReason, "readiness_timeout");
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

test("secure runtime refuses inactive isolated profiles and deployment-incomplete layouts before ingress or tunnel", () => {
  let ingressCalls = 0;
  let spawnCalls = 0;
  const rt = createRemoteSshRuntime({
    spawn: () => {
      spawnCalls += 1;
      return makeMockChild();
    },
    getHookServerPort: () => 23333,
    createProfileIngress: () => {
      ingressCalls += 1;
      return { start: async () => 31234, close: async () => {} };
    },
  });
  const base = {
    id: "p1",
    host: "user@host",
    remoteForwardPort: 23334,
    installId: "a".repeat(64),
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_p1",
    layoutVersion: 1,
    routingNonce: "b".repeat(32),
    lastDeployedAt: 1_700_000_000_000,
  };

  rt.connect({ ...base, remoteHome: "/home/shared", isolatedActive: false });
  assert.equal(rt.getProfileStatus("p1").status, "failed");
  assert.equal(rt.getProfileStatus("p1").lastErrorReason, "isolated_runtime_inactive");
  assert.equal(ingressCalls, 0);
  assert.equal(spawnCalls, 0);

  rt.disconnect("p1");
  rt.connect({ ...base, isolatedActive: true });
  assert.equal(rt.getProfileStatus("p1").status, "failed");
  assert.equal(rt.getProfileStatus("p1").lastErrorReason, "deployment_required");
  assert.equal(rt.getProfileStatus("p1").hint, "remoteSshErrDeploymentRequired");
  assert.equal(ingressCalls, 0);
  assert.equal(spawnCalls, 0);
  rt.cleanup();
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
  assert.equal(args.includes("-v"), false);
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

test("windows-cmd shell cache suppresses automatic resolver retries but clears after manual reconnect", async () => {
  clearRemoteNodeCache();
  const children = [];
  let resolverCalls = 0;
  const spawn = () => {
    const child = makeMockChild();
    children.push(child);
    return child;
  };
  const timers = makeFakeTimers();
  const profile = { id: "p1", host: "user@win", remoteForwardPort: 23333 };
  const rt = createRemoteSshRuntime({
    spawn,
    getHookServerPort: () => 23335,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    resolveRemoteNodeBin: () => {
      resolverCalls += 1;
      return {
        ok: false,
        stderr: "'sh' is not recognized as an internal or external command",
        message: "Remote Node.js not found",
      };
    },
  });

  rt.connect(profile);
  timers.flushWhere((t) => t.ms === 0);
  children[1]._fakeExit(0);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(rt.getProfileStatus("p1").status, "connected");
  assert.equal(resolverCalls, 1, "first bare-node success starts the resolver");

  children[0]._fakeStderr("ssh: connect to host win port 22: Connection timed out");
  await new Promise((r) => setImmediate(r));
  children[0]._fakeExit(255);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(rt.getProfileStatus("p1").status, "reconnecting");

  timers.flushWhere((t) => t.ms === BACKOFF_SCHEDULE_MS[0]);
  timers.flushWhere((t) => t.ms === 0);
  children[3]._fakeExit(0);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(rt.getProfileStatus("p1").status, "connected");
  assert.equal(resolverCalls, 1,
    "automatic reconnect keeps the one-shot windows-cmd cache");

  rt.disconnect("p1");
  rt.connect(profile);
  timers.flushWhere((t) => t.ms === 0);
  children[children.length - 1]._fakeExit(0);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolverCalls, 2,
    "manual reconnect clears the cache so a fixed remote shell can recover");
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

test("ordinary automatic reconnect fails closed when effective transport becomes serialized", async () => {
  const children = [];
  const timers = makeFakeTimers();
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:drifted-reconnect",
      effectiveHost: "codespace.internal",
      effectiveUser: "codespace",
      effectivePort: 22,
      fingerprint: "fp-drifted-reconnect",
    }),
  });
  const profile = { id: "p1", host: "alias", remoteForwardPort: 23333 };
  const rt = createRemoteSshRuntime({
    spawn: () => {
      const child = makeMockChild();
      children.push(child);
      return child;
    },
    transportCoordinator: coordinator,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  rt.connect(profile, {
    transportInspection: {
      mode: "parallel",
      kind: "standard",
      key: "parallel:original",
      effectiveHost: "ordinary.internal",
      effectiveUser: "user",
      effectivePort: 22,
      fingerprint: "fp-original",
    },
  });
  assert.equal(children.length, 1);
  await exitSsh(children[0], "ssh: connect to host alias port 22: Connection timed out");
  assert.equal(rt.getProfileStatus(profile.id).status, "reconnecting");

  timers.flushWhere((timer) => timer.ms === BACKOFF_SCHEDULE_MS[0]);
  await flushAsyncEvents();
  assert.equal(children.length, 1, "transport drift must not spawn an unmanaged reconnect");
  assert.equal(rt.getProfileStatus(profile.id).status, "failed");
  assert.equal(rt.getProfileStatus(profile.id).lastErrorReason, "profile_changed");
});

test("a stale reconnect inspection cannot overwrite an explicit Disconnect", async () => {
  const children = [];
  const timers = makeFakeTimers();
  let resolveInspection;
  const inspectionPromise = new Promise((resolve) => { resolveInspection = resolve; });
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: () => inspectionPromise,
  });
  const profile = { id: "p1", host: "alias", remoteForwardPort: 23333 };
  const rt = createRemoteSshRuntime({
    spawn: () => {
      const child = makeMockChild();
      children.push(child);
      return child;
    },
    transportCoordinator: coordinator,
    getHookServerPort: () => 23333,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  rt.connect(profile, {
    transportInspection: {
      mode: "parallel",
      kind: "standard",
      key: "parallel:original",
      effectiveHost: "ordinary.internal",
      effectiveUser: "user",
      effectivePort: 22,
    },
  });
  await exitSsh(children[0], "ssh: connect to host alias port 22: Connection timed out");
  timers.flushWhere((timer) => timer.ms === BACKOFF_SCHEDULE_MS[0]);
  rt.disconnect(profile.id);
  resolveInspection({
    mode: "serialized",
    kind: "codespaces-stdio",
    key: "codespace:late-result",
    effectiveHost: "codespace.internal",
    effectiveUser: "codespace",
    effectivePort: 22,
  });
  await flushAsyncEvents();
  assert.equal(rt.getProfileStatus(profile.id).status, "idle");
  assert.equal(rt.getProfileStatus(profile.id).lastErrorReason, null);
  assert.equal(children.length, 1, "the stale reconnect continuation must not spawn");
  rt.cleanup();
});

test("a fresh secure connection still treats a forward conflict as permanent", async () => {
  const children = [];
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn: () => {
      const child = makeMockChild();
      children.push(child);
      return child;
    },
    getHookServerPort: () => 23333,
    createProfileIngress: () => makeSecureIngress(),
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });

  rt.connect(makeSecureProfile());
  await flushAsyncEvents();
  await exitSsh(
    children[children.length - 1],
    "Warning: remote port forwarding failed for listen port 23333"
  );
  const failed = rt.getProfileStatus("p1");
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastErrorReason, "forward_failed");
  assert.equal(failed.forwardRecoveryFailures, 0);
  rt.cleanup();
});

test("a previously healthy secure tunnel retries forward conflicts four times, then fails", async () => {
  const children = [];
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn: () => {
      const child = makeMockChild();
      children.push(child);
      return child;
    },
    getHookServerPort: () => 23333,
    createProfileIngress: () => makeSecureIngress(),
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  const profile = makeSecureProfile();
  const mainChild = await connectSecureProfile(rt, timers, children, profile);

  await exitSsh(mainChild, "Timeout, server user@pi not responding.");
  assert.equal(rt.getProfileStatus("p1").status, "reconnecting");

  const retryDelays = BACKOFF_SCHEDULE_MS.slice(0, 4);
  for (let conflict = 1; conflict <= 4; conflict += 1) {
    timers.flushWhere((timer) => timer.ms === retryDelays[conflict - 1]);
    await flushAsyncEvents();
    const retryChild = children[children.length - 1];
    await exitSsh(retryChild, "Warning: remote port forwarding failed for listen port 23333");
    const snapshot = rt.getProfileStatus("p1");
    if (conflict < 4) {
      assert.equal(snapshot.status, "reconnecting");
      assert.equal(snapshot.lastErrorReason, "forward_recovery_conflict");
      assert.equal(snapshot.hint, "remoteSshErrForwardRetrying");
      assert.equal(snapshot.forwardRecoveryFailures, conflict);
    } else {
      assert.equal(snapshot.status, "failed");
      assert.equal(snapshot.lastErrorReason, "forward_failed");
      assert.equal(snapshot.hint, "remoteSshErrForwardFailed");
      assert.equal(snapshot.forwardRecoveryFailures, 0);
    }
  }
  rt.cleanup();
});

test("a failed recovery cannot leak forward-conflict retry eligibility into manual Connect", async () => {
  const children = [];
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn: () => {
      const child = makeMockChild();
      children.push(child);
      return child;
    },
    getHookServerPort: () => 23333,
    createProfileIngress: () => makeSecureIngress(),
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  const profile = makeSecureProfile();
  const mainChild = await connectSecureProfile(rt, timers, children, profile);

  await exitSsh(mainChild, "ssh: connect to host pi port 22: Connection timed out");
  timers.flushWhere((timer) => timer.ms === BACKOFF_SCHEDULE_MS[0]);
  await flushAsyncEvents();
  await exitSsh(
    children[children.length - 1],
    "Warning: remote port forwarding failed for listen port 23333"
  );
  assert.equal(rt.getProfileStatus("p1").status, "reconnecting");

  timers.flushWhere((timer) => timer.ms === BACKOFF_SCHEDULE_MS[1]);
  await flushAsyncEvents();
  await exitSsh(children[children.length - 1], "ssh: Permission denied (publickey).");
  assert.equal(rt.getProfileStatus("p1").status, "failed");

  rt.connect(profile);
  await flushAsyncEvents();
  await exitSsh(
    children[children.length - 1],
    "Warning: remote port forwarding failed for listen port 23333"
  );
  const manualFailure = rt.getProfileStatus("p1");
  assert.equal(manualFailure.status, "failed");
  assert.equal(manualFailure.lastErrorReason, "forward_failed");
  assert.equal(manualFailure.forwardRecoveryFailures, 0);
  rt.cleanup();
});

test("a queued reconnect rechecks deployment readiness after the profile target changes", async () => {
  const children = [];
  const timers = makeFakeTimers();
  const rt = createRemoteSshRuntime({
    spawn: () => {
      const child = makeMockChild();
      children.push(child);
      return child;
    },
    getHookServerPort: () => 23333,
    createProfileIngress: () => makeSecureIngress(),
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  const profile = makeSecureProfile();
  const mainChild = await connectSecureProfile(rt, timers, children, profile);

  await exitSsh(mainChild, "ssh: connect to host pi port 22: Connection timed out");
  assert.equal(rt.getProfileStatus("p1").status, "reconnecting");
  const spawnCountBeforeRefresh = children.length;
  rt.refreshProfile({
    ...profile,
    remoteForwardPort: 23334,
    remoteHome: undefined,
    routingNonce: undefined,
    lastDeployedAt: undefined,
  });

  timers.flushWhere((timer) => timer.ms === BACKOFF_SCHEDULE_MS[0]);
  await flushAsyncEvents();
  const blocked = rt.getProfileStatus("p1");
  assert.equal(children.length, spawnCountBeforeRefresh, "stale timer must not spawn a new tunnel");
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.lastErrorReason, "deployment_required");
  assert.equal(blocked.hint, "remoteSshErrDeploymentRequired");
  assert.equal(blocked.forwardRecoveryFailures, 0);
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

test("a real Codespaces verbose forward failure is classified without exposing DEBUG commands", async () => {
  const children = [];
  const timers = makeFakeTimers();
  const spawn = () => {
    const child = makeMockChild();
    children.push(child);
    return child;
  };
  const coordinator = createRemoteSshTransportCoordinator({
    spawn,
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:v9-fixture",
      fingerprint: "fp-v9-fixture",
    }),
  });
  const profile = makeSecureProfile({ sshTransportMode: "serialized" });
  const admitted = await coordinator.acquireConnection(profile);
  const rt = createRemoteSshRuntime({
    spawn,
    transportCoordinator: coordinator,
    getHookServerPort: () => 23333,
    createProfileIngress: () => makeSecureIngress(),
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });

  rt.connect(profile, {
    serialized: true,
    transportContext: admitted.context,
  });
  await flushAsyncEvents();
  const oversizedDebugCommand = `debug1: Sending command: ${"x".repeat(9000)}sentinel-truncated-command`;
  await exitSsh(children[0], [
    "debug1: Reading configuration data C:\\\\private\\\\included.conf",
    "debug1: Executing proxy command: exec gh cs ssh --stdio --password sentinel-proxy-secret",
    "debug1: Sending command: node -e sentinel-remote-command",
    oversizedDebugCommand,
    "debug1: remote forward failure for: listen 127.0.0.1:23333, connect 127.0.0.1:9",
    "Error: remote port forwarding failed for listen port 23333",
  ].join("\n"));
  children[0]._fakeClose(255);
  await flushAsyncEvents();

  const failed = rt.getProfileStatus("p1");
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastErrorReason, "forward_failed");
  assert.doesNotMatch(String(failed.lastError), /private|sentinel|Executing proxy|Sending command|x{20}/i);
  assert.match(String(failed.lastError), /remote port forwarding failed/i);
  rt.cleanup();
});

test("status APIs expose a quarantined coordinator slot even before runtime state exists", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:no-runtime-state",
      fingerprint: "fp-no-runtime-state",
    }),
  });
  const profile = makeSecureProfile({ id: "no-runtime-state" });
  const operation = await coordinator.acquireOperation(profile, "cleanup");
  operation.context.setLockStage("lock-owned");
  coordinator.invalidate(operation.context, "transport_unknown_result");
  const rt = createRemoteSshRuntime({
    transportCoordinator: coordinator,
    getHookServerPort: () => 23333,
  });

  const status = rt.getProfileStatus(profile.id);
  assert.equal(status.status, "failed");
  assert.equal(status.lastErrorReason, "manual_lock_inspection_required");
  assert.equal(status.transportPhase, "quarantined");
  assert.equal(status.transportOwnerProfileId, profile.id);
  const listed = rt.listStatuses().find((entry) => entry.profileId === profile.id);
  assert.equal(listed.status, "failed");
  assert.equal(listed.transportPhase, "quarantined");
});

test("coordinator-only operation and quarantine phases publish runtime status events", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:status-events",
      fingerprint: "fp-status-events",
    }),
  });
  const rt = createRemoteSshRuntime({
    transportCoordinator: coordinator,
    getHookServerPort: () => 23333,
  });
  const events = [];
  rt.on("status-changed", (status) => events.push(status));
  const profile = makeSecureProfile({ id: "status-events" });

  const operation = await coordinator.acquireOperation(profile, "cleanup");
  operation.context.setLockStage("lock-owned");
  coordinator.invalidate(operation.context, "transport_unknown_result");

  assert.ok(events.some((status) => status.profileId === profile.id
    && status.transportPhase === "operation"));
  const failed = events.at(-1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.transportPhase, "quarantined");
  assert.equal(failed.lastErrorReason, "manual_lock_inspection_required");
  rt.cleanup();
});

test("an existing idle runtime state presents coordinator quarantine as failed", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:existing-state",
      fingerprint: "fp-existing-state",
    }),
  });
  const profile = makeSecureProfile({ id: "existing-state" });
  const rt = createRemoteSshRuntime({
    spawn: () => makeMockChild(),
    transportCoordinator: coordinator,
    getHookServerPort: () => 23333,
  });
  rt.connect(profile);
  rt.disconnect(profile.id);
  const events = [];
  rt.on("status-changed", (status) => events.push(status));

  const operation = await coordinator.acquireOperation(profile, "cleanup");
  operation.context.setLockStage("lock-owned");
  coordinator.invalidate(operation.context, "transport_unknown_result");

  const status = rt.getProfileStatus(profile.id);
  assert.equal(status.status, "failed");
  assert.equal(status.transportPhase, "quarantined");
  assert.equal(status.lastErrorReason, "manual_lock_inspection_required");
  assert.equal(events.at(-1).status, "failed");
  rt.cleanup();
});
