"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { makeSessionKey } = require("../src/session-key");
const {
  buildWindowsPowerShellShimInvocation,
  classifyQueueError,
  createCodexQueueDeliveryAdapter,
  getCodexThreadId,
  isCodexQueueTarget,
  normalizeCodexThreadId,
  resolveNpmCodexShimInvocation,
  resolveCodexQueueExecutableCandidates,
} = require("../src/codex-queue-delivery");

const THREAD_ID = "019e115a-4df2-7ed0-b90e-8e6345aca777";

function desktopEntry(overrides = {}) {
  return {
    id: `codex:${THREAD_ID}`,
    rawSessionId: `codex:${THREAD_ID}`,
    agentId: "codex",
    codexOriginator: "codex_work_desktop",
    state: "idle",
    badge: "done",
    sourcePid: null,
    agentPid: 14220,
    host: null,
    headless: false,
    hiddenFromHud: false,
    platform: null,
    ...overrides,
  };
}

test("Codex queue target extraction accepts raw and profile-scoped session keys", () => {
  assert.equal(normalizeCodexThreadId(THREAD_ID), THREAD_ID);
  assert.equal(normalizeCodexThreadId(`codex:${THREAD_ID}`), THREAD_ID);
  assert.equal(normalizeCodexThreadId("命名 Desktop thread / v2"), "命名 Desktop thread / v2");
  assert.equal(normalizeCodexThreadId("bad\nthread"), null);
  assert.equal(normalizeCodexThreadId("x".repeat(513)), null);

  const rawEntry = desktopEntry();
  assert.equal(getCodexThreadId(rawEntry), THREAD_ID);
  assert.equal(isCodexQueueTarget(rawEntry), true);

  const rawSessionId = `codex:${THREAD_ID}`;
  const scopedEntry = desktopEntry({
    id: makeSessionKey({ profileId: "local", rawSessionId }),
    rawSessionId,
  });
  assert.equal(getCodexThreadId(scopedEntry), THREAD_ID);
  assert.equal(isCodexQueueTarget(scopedEntry), true);

  const scopedWithoutRaw = desktopEntry({
    id: makeSessionKey({ profileId: "local", rawSessionId }),
    rawSessionId: null,
  });
  assert.equal(getCodexThreadId(scopedWithoutRaw), THREAD_ID);
  assert.equal(isCodexQueueTarget(scopedWithoutRaw), true);
  assert.equal(getCodexThreadId(desktopEntry({ id: "s1.local.not-valid", rawSessionId: null })), null);
});

test("Codex queue target rejects remote, hidden, and non-Desktop sessions", () => {
  for (const overrides of [
    { host: "remote-box" },
    { hiddenFromHud: true },
    { headless: true },
    { state: "sleeping" },
    { codexOriginator: "codex-tui" },
    { rawSessionId: "codex:\nnot-a-thread" },
    { wslDistro: "Ubuntu" },
    { platform: "WSL" },
  ]) {
    assert.equal(isCodexQueueTarget(desktopEntry(overrides)), false, JSON.stringify(overrides));
  }
});

test("Codex queue adapter passes the exact thread and message arguments without a shell", async () => {
  const calls = [];
  const adapter = createCodexQueueDeliveryAdapter({
    executable: "codex-desktop.exe",
    osPlatform: "win32",
    execFile: (command, args, options, callback) => {
      calls.push({ command, args, options });
      callback(null, `Queued message ${THREAD_ID} for thread ${THREAD_ID}.\n`, "");
    },
  });

  const result = await adapter.deliver({
    entry: desktopEntry(),
    promptText: "reply from Telegram\nwith two lines",
  });

  assert.deepEqual(result, {
    status: "queued",
    delivered: true,
    autoEnter: true,
    errorClass: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "codex-desktop.exe");
  assert.deepEqual(calls[0].args, [
    "queue",
    "--thread",
    THREAD_ID,
    "--message",
    "reply from Telegram\nwith two lines",
  ]);
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 8000);
});

test("Codex queue adapter retries an old CLI after an unsupported queue command", async () => {
  const calls = [];
  const adapter = createCodexQueueDeliveryAdapter({
    osPlatform: "win32",
    executableCandidates: ["old-codex.exe", "desktop-codex.exe"],
    execFile: (command, args, options, callback) => {
      calls.push(command);
      if (command === "old-codex.exe") {
        const error = new Error("error: unrecognized subcommand 'queue'");
        error.code = 2;
        callback(error, "", error.message);
        return;
      }
      callback(null, "Queued message q for thread t.\n", "");
    },
  });

  const result = await adapter.deliver({ entry: desktopEntry(), promptText: "continue" });
  assert.equal(result.status, "queued");
  assert.deepEqual(calls, ["old-codex.exe", "desktop-codex.exe"]);
});

test("Codex queue adapter classifies unavailable and uncertain execution results", async () => {
  const unavailable = createCodexQueueDeliveryAdapter({
    osPlatform: "win32",
    executableCandidates: ["missing.exe"],
    execFile: (command, args, options, callback) => {
      const error = new Error("spawn missing.exe ENOENT");
      error.code = "ENOENT";
      callback(error, "", "");
    },
  });
  const unavailableResult = await unavailable.deliver({ entry: desktopEntry(), promptText: "x" });
  assert.equal(unavailableResult.errorClass, "codex_queue_unavailable");

  const timeout = createCodexQueueDeliveryAdapter({
    osPlatform: "win32",
    executableCandidates: ["codex.exe"],
    execFile: (command, args, options, callback) => {
      const error = new Error("Command timed out");
      error.killed = true;
      error.signal = "SIGTERM";
      callback(error, "", "");
    },
  });
  const timeoutResult = await timeout.deliver({ entry: desktopEntry(), promptText: "x" });
  assert.equal(timeoutResult.errorClass, "codex_queue_result_unknown");
  assert.equal(classifyQueueError(Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" })), "codex_queue_unavailable");
  assert.equal(classifyQueueError(Object.assign(new Error("spawn EFTYPE"), { code: "EFTYPE" })), "codex_queue_unavailable");
  assert.equal(classifyQueueError(Object.assign(new Error("spawn ETIMEDOUT"), { code: "ETIMEDOUT" })), "codex_queue_result_unknown");
  assert.equal(classifyQueueError(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })), "direct_send_cancelled");
  assert.equal(classifyQueueError(new Error("No active session found matching 'missing'")), "codex_thread_not_found");
});

test("Codex queue executable discovery prefers native Desktop binaries", () => {
  const candidates = resolveCodexQueueExecutableCandidates({
    platform: "win32",
    homeDir: "C:\\Users\\tester",
    env: {
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      PATH: "C:\\old\\bin;C:\\new\\bin",
      CODEX_CLI_PATH: "C:\\explicit\\codex.exe",
    },
    fsModule: {
      existsSync: (value) => value.endsWith("codex.exe"),
      readdirSync: () => [
        { name: "old-install", isDirectory: () => true },
        { name: "new-install", isDirectory: () => true },
      ],
      statSync: (value) => ({ mtimeMs: value.includes("new-install") ? 20 : 10 }),
    },
  });

  assert.equal(candidates[0], "C:\\explicit\\codex.exe");
  assert.ok(candidates.some((value) => value.endsWith("new-install\\codex.exe")));
  assert.ok(candidates.some((value) => value.endsWith("old-install\\codex.exe")));
  assert.ok(candidates.some((value) => value.endsWith("new\\bin\\codex.exe")));
  assert.ok(candidates.some((value) => value.endsWith("Programs\\OpenAI\\Codex\\bin\\codex.exe")));
  assert.ok(
    candidates.findIndex((value) => value.includes("\\OpenAI\\Codex\\bin\\new-install\\codex.exe"))
      < candidates.findIndex((value) => value.includes("\\Programs\\OpenAI\\Codex\\bin\\new-install\\codex.exe")),
    "Codex Desktop runtime should precede standalone installations",
  );
});

test("Codex queue executable discovery honors a custom CODEX_HOME and Path casing", () => {
  const customHome = "D:\\Codex State";
  const customCurrent = `${customHome}\\packages\\standalone\\current\\bin\\codex.exe`;
  const pathCodex = "D:\\Tools\\codex.exe";
  const candidates = resolveCodexQueueExecutableCandidates({
    platform: "win32",
    homeDir: "C:\\Users\\tester",
    env: {
      CODEX_HOME: customHome,
      Path: "D:\\Tools",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    },
    fsModule: {
      existsSync: (value) => value === customCurrent || value === pathCodex,
      readdirSync: () => [],
      statSync: () => ({ mtimeMs: 0 }),
    },
  });

  assert.equal(candidates[0], customCurrent);
  assert.ok(candidates.includes(pathCodex));
});

test("Codex queue discovery lets a later Windows environment spelling override an inherited key", () => {
  const candidates = resolveCodexQueueExecutableCandidates({
    platform: "win32",
    homeDir: "C:\\Users\\tester",
    env: {
      PATH: "C:\\inherited\\bin",
      Path: "D:\\override\\bin",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    },
    fsModule: {
      existsSync: (value) => value === "D:\\override\\bin\\codex.exe",
      readdirSync: () => [],
      statSync: () => ({ mtimeMs: 0 }),
    },
  });

  assert.equal(candidates[0], "D:\\override\\bin\\codex.exe");
  assert.equal(candidates.includes("C:\\inherited\\bin\\codex.exe"), false);
});

test("Codex queue adapter invokes Windows script shims through an encoded PowerShell command", async () => {
  const calls = [];
  const message = "reply %PATH% & `quoted` 中文";
  const adapter = createCodexQueueDeliveryAdapter({
    osPlatform: "win32",
    executableCandidates: ["C:\\Program Files\\Codex\\codex.ps1"],
    env: {
      CODEX_HOME: "D:\\Codex State",
      CODEX_SQLITE_HOME: "D:\\Codex SQLite",
      PATH: "C:\\inherited\\bin",
      Path: "D:\\override\\bin",
    },
    fsModule: { readFileSync: () => { throw new Error("unknown shim"); } },
    execFile: (command, args, options, callback) => {
      calls.push({ command, args, options });
      callback(null, "queued", "");
    },
  });

  const result = await adapter.deliver({ entry: desktopEntry(), promptText: message });
  assert.equal(result.status, "queued");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(calls[0].options.env.CODEX_HOME, "D:\\Codex State");
  assert.equal(calls[0].options.env.CODEX_SQLITE_HOME, "D:\\Codex SQLite");
  const pathKeys = Object.keys(calls[0].options.env)
    .filter((key) => key.toLowerCase() === "path");
  assert.deepEqual(pathKeys, ["Path"]);
  assert.equal(calls[0].options.env.Path, "D:\\override\\bin");
  const encoded = calls[0].args[calls[0].args.length - 1];
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(decoded, /& 'C:\\Program Files\\Codex\\codex\.ps1'/);
  assert.match(decoded, /'reply %PATH% & `quoted` 中文'/);
  assert.deepEqual(calls[0].args.slice(0, -1), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
  ]);
});

test("Codex queue adapter resolves the generated npm shim to Node directly", async () => {
  const shim = "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd";
  const nodeBin = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node.exe";
  const script = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
  const source = [
    "@echo off",
    "SETLOCAL",
    "SET \"_prog=%dp0%\\node.exe\"",
    "\"%_prog%\" \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*",
  ].join("\\r\\n");
  const calls = [];
  const adapter = createCodexQueueDeliveryAdapter({
    osPlatform: "win32",
    executableCandidates: [shim],
    fsModule: {
      readFileSync: () => source,
      existsSync: (value) => value === script || value === nodeBin,
    },
    execFile: (command, args, options, callback) => {
      calls.push({ command, args, options });
      callback(null, "queued", "");
    },
  });
  const message = "100%PATH% & keep literal";
  const result = await adapter.deliver({ entry: desktopEntry(), promptText: message });
  assert.equal(result.status, "queued");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, nodeBin);
  assert.deepEqual(calls[0].args, [
    script,
    "queue",
    "--thread",
    THREAD_ID,
    "--message",
    message,
  ]);
  assert.equal(calls[0].options.windowsVerbatimArguments, undefined);
});

test("Codex queue adapter skips unknown batch wrappers instead of reinterpreting reply text", async () => {
  const calls = [];
  const adapter = createCodexQueueDeliveryAdapter({
    osPlatform: "win32",
    executableCandidates: ["C:\\custom\\codex.cmd", "C:\\native\\codex.exe"],
    fsModule: { readFileSync: () => "@echo off\r\ncustom-codex %*" },
    execFile: (command, args, options, callback) => {
      calls.push({ command, args, options });
      callback(null, "queued", "");
    },
  });

  const message = "keep %PATH% literal";
  const result = await adapter.deliver({ entry: desktopEntry(), promptText: message });
  assert.equal(result.status, "queued");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "C:\\native\\codex.exe");
  assert.equal(calls[0].args.at(-1), message);
});

test("generated npm Codex shims are recognized for both cmd and PowerShell forms", () => {
  const cases = [
    {
      candidate: "C:\\Tools\\codex.cmd",
      source: '"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    },
    {
      candidate: "C:\\Tools\\codex.ps1",
      source: '& "$basedir/node.exe" "$basedir/node_modules/@openai/codex/bin/codex.js" $args',
    },
  ];
  for (const item of cases) {
    const result = resolveNpmCodexShimInvocation(item.candidate, ["queue"], {
      fsModule: {
        readFileSync: () => item.source,
        existsSync: () => true,
      },
    });
    assert.ok(result, item.candidate);
    assert.match(result.args[0], /node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i);
  }
});

test("encoded PowerShell shim invocation quotes embedded single quotes literally", () => {
  const invocation = buildWindowsPowerShellShimInvocation(
    "C:\\Tools\\codex.ps1",
    ["queue", "--message", "it's 100% & safe"],
  );
  const command = Buffer.from(invocation.args.at(-1), "base64").toString("utf16le");
  assert.match(command, /\$ErrorActionPreference = 'Stop'/);
  assert.match(command, /try \{ & 'C:\\Tools\\codex\.ps1' 'queue' '--message' 'it''s 100% & safe'/);
  assert.match(command, /catch \{ \[Console\]::Error\.WriteLine\(\$_\.Exception\.Message\); exit 1 \}/);
  assert.match(command, /if \(\$null -ne \$clawdExitCode\) \{ exit \[int\]\$clawdExitCode \}/);
  assert.match(command, /if \(-not \$clawdInvocationOk\) \{ exit 1 \}/);
});
