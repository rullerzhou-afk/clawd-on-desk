"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  READY_PREFIX,
  RESULT_PREFIX,
  buildWindowsConsoleInputScript,
  createWindowsConsoleInputDeliveryAdapter,
  normalizePid,
  normalizePidList,
  parseConsoleInputResult,
} = require("../src/windows-console-input");

function createHelperSpawn({
  result,
  calls,
  payloads,
  kills,
  children,
  closeOnKill = true,
  emitReady = true,
  emitResult = true,
} = {}) {
  return (command, args, options) => {
    if (calls) calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.resume = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = (value) => {
      if (payloads) payloads.push(String(value || ""));
      if (emitResult) {
        queueMicrotask(() => {
          child.stdout.emit("data", `${RESULT_PREFIX}${JSON.stringify(result)}\n`);
          child.stdout.emit("end");
          child.emit("close", 0);
        });
      }
    };
    child.kill = (signal) => {
      if (kills) kills.push(signal || true);
      if (closeOnKill) child.emit("close", 1);
      return true;
    };
    if (children) children.push(child);
    if (emitReady) queueMicrotask(() => child.stdout.emit("data", `${READY_PREFIX}\n`));
    return child;
  };
}

test("console input script targets a ConPTY by agent PID and guards peer sessions", () => {
  const script = buildWindowsConsoleInputScript();

  assert.match(script, new RegExp(READY_PREFIX));
  assert.match(script, /\[Console\]::In\.ReadLine\(\)/);
  assert.match(script, /AttachConsole\(targetPid\)/);
  assert.match(script, /CreateFileW/);
  assert.match(script, /CONIN\$/);
  assert.match(script, /WriteConsoleInputW/);
  assert.match(script, /GetConsoleProcessList/);
  assert.match(script, /MAX_CONSOLE_PROCESS_LIST_ATTEMPTS/);
  assert.match(script, /console_process_list_unstable/);
  assert.match(script, /console_ambiguous/);
  assert.match(script, /inputPayload\.blockedPids/);
  assert.match(script, /Size = 20/);
  assert.match(script, /VirtualKeyCode = virtualKeyCode/);
  assert.match(script, /Key\('\\r', true, 0x0D\)/);
  assert.match(script, /Key\('\\r', false, 0x0D\)/);
  assert.equal(
    (script.match(/EnsureSafeConsoleMembership\(targetPid, blockedPids\);/g) || []).length,
    2,
    "the Console membership must be checked after attach and again immediately before input",
  );
  assert.match(script, /!writeSucceeded && written != 0/);
  assert.doesNotMatch(script, /continue secret/);
  assert.doesNotMatch(script, /\u4e2d\u6587/);
  assert.doesNotMatch(script, /\[uint32\]1234/);
});

test("console input result parser accepts only the tagged JSON result", () => {
  assert.deepEqual(parseConsoleInputResult(
    `noise\n${RESULT_PREFIX}{"ok":true,"errorClass":null,"written":18}\n`
  ), {
    ok: true,
    errorClass: null,
    written: 18,
  });
  assert.deepEqual(parseConsoleInputResult(
    `${RESULT_PREFIX}{"ok":false,"errorClass":"console_ambiguous","written":0}`
  ), {
    ok: false,
    errorClass: "console_ambiguous",
    written: 0,
  });
  assert.equal(parseConsoleInputResult("noise only"), null);
  assert.equal(parseConsoleInputResult(`${RESULT_PREFIX}{bad-json}`), null);
});

test("Windows console adapter submits Unicode and Enter without requiring focus", async () => {
  const calls = [];
  const payloads = [];
  const adapter = createWindowsConsoleInputDeliveryAdapter({
    osPlatform: "win32",
    spawn: createHelperSpawn({
      result: { ok: true, errorClass: null, written: 24 },
      calls,
      payloads,
    }),
  });

  const result = await adapter.deliver({
    promptText: "\u7ee7\u7eed /compact",
    entry: { id: "session-a", agentPid: 1234 },
    otherSessionAgentPids: [2222],
    validateBeforeInput: () => ({ ok: true, otherSessionAgentPids: [3333] }),
  });

  assert.equal(adapter.requiresFocus, false);
  assert.equal(adapter.requiresMappedAgentPid, true);
  assert.deepEqual(result, {
    status: "sent_with_enter",
    delivered: true,
    autoEnter: true,
    errorClass: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(calls[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(calls[0].args[3], new RegExp(READY_PREFIX));
  assert.doesNotMatch(calls[0].args[3], /\u7ee7\u7eed|compact|\[uint32\]1234/);
  assert.equal(payloads.length, 1);
  const helperPayload = JSON.parse(payloads[0]);
  assert.equal(helperPayload.targetPid, 1234);
  assert.deepEqual(helperPayload.blockedPids, [3333]);
  assert.equal(Buffer.from(helperPayload.promptBase64, "base64").toString("utf8"), "\u7ee7\u7eed /compact");
});

test("Windows console adapter reports an ambiguous shared Console without claiming delivery", async () => {
  const adapter = createWindowsConsoleInputDeliveryAdapter({
    osPlatform: "win32",
    spawn: createHelperSpawn({
      result: { ok: false, errorClass: "console_ambiguous", written: 0 },
    }),
  });

  const result = await adapter.deliver({
    promptText: "continue",
    entry: { agentPid: 1234 },
    otherSessionAgentPids: [2222],
  });

  assert.equal(result.status, "failed");
  assert.equal(result.delivered, false);
  assert.equal(result.errorClass, "console_ambiguous");
});

test("Windows console adapter preserves uncertain write errors for duplicate prevention", async () => {
  for (const errorClass of ["partial_console_write", "console_input_result_unknown"]) {
    const adapter = createWindowsConsoleInputDeliveryAdapter({
      osPlatform: "win32",
      spawn: createHelperSpawn({
        result: { ok: false, errorClass, written: 0 },
      }),
    });

    const result = await adapter.deliver({
      promptText: "continue",
      entry: { agentPid: 1234 },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.delivered, false);
    assert.equal(result.errorClass, errorClass);
  }
});

test("Windows console adapter revalidates the target after helper readiness and before payload", async () => {
  const calls = [];
  const payloads = [];
  const kills = [];
  const adapter = createWindowsConsoleInputDeliveryAdapter({
    osPlatform: "win32",
    spawn: createHelperSpawn({
      result: { ok: true, errorClass: null, written: 1 },
      calls,
      payloads,
      kills,
    }),
  });

  const result = await adapter.deliver({
    promptText: "continue",
    entry: { agentPid: 1234 },
    validateBeforeInput: () => ({ ok: false, errorClass: "permission_pending" }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorClass, "permission_pending");
  assert.equal(calls.length, 1);
  assert.deepEqual(payloads, []);
  assert.deepEqual(kills, [true]);
});

test("Windows console adapter rejects a malformed success result as an uncertain write", async () => {
  const adapter = createWindowsConsoleInputDeliveryAdapter({
    osPlatform: "win32",
    spawn: createHelperSpawn({
      result: { ok: true, errorClass: null, written: 1 },
    }),
  });

  const result = await adapter.deliver({
    promptText: "continue",
    entry: { agentPid: 1234 },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.delivered, false);
  assert.equal(result.errorClass, "console_input_result_unknown");
});

test("Windows console adapter aborts the helper before it can submit input", async () => {
  const children = [];
  const kills = [];
  const controller = new AbortController();
  const adapter = createWindowsConsoleInputDeliveryAdapter({
    osPlatform: "win32",
    spawn: createHelperSpawn({
      children,
      kills,
      emitReady: false,
    }),
  });

  const delivery = adapter.deliver({
    promptText: "continue",
    entry: { agentPid: 1234 },
    signal: controller.signal,
  });
  controller.abort();

  const result = await delivery;
  assert.equal(result.status, "failed");
  assert.equal(result.errorClass, "direct_send_cancelled");
  assert.deepEqual(kills, [true]);
  assert.equal(children.length, 1);
});

test("Windows console adapter rechecks an aborted signal after async validation", async () => {
  const children = [];
  const payloads = [];
  const kills = [];
  const controller = new AbortController();
  let releaseValidation;
  let validationStarted;
  const validationReady = new Promise((resolve) => { validationStarted = resolve; });
  const adapter = createWindowsConsoleInputDeliveryAdapter({
    osPlatform: "win32",
    spawn: createHelperSpawn({ children, payloads, kills }),
  });

  const delivery = adapter.deliver({
    promptText: "continue",
    entry: { agentPid: 1234 },
    signal: controller.signal,
    validateBeforeInput: () => {
      validationStarted();
      return new Promise((resolve) => { releaseValidation = resolve; });
    },
  });
  await validationReady;
  releaseValidation({ ok: true });
  controller.abort();

  const result = await delivery;
  assert.equal(result.status, "failed");
  assert.equal(result.errorClass, "direct_send_cancelled");
  assert.deepEqual(payloads, []);
  assert.deepEqual(kills, [true]);
  assert.equal(children.length, 1);
});

test("Windows console adapter releases the queue on process exit without waiting for pipe close", async () => {
  const children = [];
  const kills = [];
  const adapter = createWindowsConsoleInputDeliveryAdapter({
    osPlatform: "win32",
    timeoutMs: 250,
    spawn: createHelperSpawn({
      children,
      kills,
      closeOnKill: false,
      emitResult: false,
    }),
  });

  let settled = false;
  const delivery = adapter.deliver({
    promptText: "continue",
    entry: { agentPid: 1234 },
  }).then((result) => {
    settled = true;
    return result;
  });

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(kills, [true]);
  assert.equal(settled, false, "the queue must wait until the helper process exits");

  children[0].emit("exit", 1);
  const result = await delivery;
  assert.equal(result.status, "failed");
  assert.equal(result.errorClass, "console_input_result_unknown");
});

test("Windows console adapter quarantines after kill confirmation times out and recovers on exit", async () => {
  const children = [];
  const kills = [];
  const hungSpawn = createHelperSpawn({
    children,
    kills,
    closeOnKill: false,
    emitResult: false,
  });
  const healthySpawn = createHelperSpawn({
    result: { ok: true, errorClass: null, written: 10 },
  });
  let spawnCount = 0;
  const adapter = createWindowsConsoleInputDeliveryAdapter({
    osPlatform: "win32",
    timeoutMs: 250,
    terminationGraceMs: 25,
    forceKillGraceMs: 25,
    spawn: (...args) => {
      spawnCount += 1;
      return spawnCount === 1 ? hungSpawn(...args) : healthySpawn(...args);
    },
  });

  const uncertain = await adapter.deliver({
    promptText: "continue",
    entry: { agentPid: 1234 },
  });
  assert.equal(uncertain.errorClass, "console_input_result_unknown");
  assert.deepEqual(kills, [true, "SIGKILL"]);

  const quarantined = await adapter.deliver({
    promptText: "next",
    entry: { agentPid: 5678 },
  });
  assert.equal(quarantined.errorClass, "console_input_helper_quarantined");
  assert.equal(spawnCount, 1, "quarantine must not launch an overlapping helper");

  children[0].emit("exit", 1);
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = await adapter.deliver({
    promptText: "next",
    entry: { agentPid: 5678 },
  });
  assert.equal(recovered.status, "sent_with_enter");
  assert.equal(spawnCount, 2);
});

test("Windows console adapter handles stdout pipe errors through normal helper cleanup", async () => {
  const children = [];
  const kills = [];
  const adapter = createWindowsConsoleInputDeliveryAdapter({
    osPlatform: "win32",
    spawn: createHelperSpawn({
      children,
      kills,
      emitReady: false,
    }),
  });

  const delivery = adapter.deliver({
    promptText: "continue",
    entry: { agentPid: 1234 },
  });
  children[0].stdout.emit("error", new Error("pipe closed"));

  const result = await delivery;
  assert.equal(result.status, "failed");
  assert.equal(result.errorClass, "console_input_helper_failed");
  assert.deepEqual(kills, [true]);
});

test("Windows console adapter fails closed when the peer PID guard exceeds its bound", async () => {
  const calls = [];
  const adapter = createWindowsConsoleInputDeliveryAdapter({
    osPlatform: "win32",
    spawn: createHelperSpawn({ calls }),
  });

  const result = await adapter.deliver({
    promptText: "continue",
    entry: { agentPid: 9999 },
    otherSessionAgentPids: Array.from({ length: 129 }, (_, index) => index + 1),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorClass, "peer_pid_overflow");
  assert.deepEqual(calls, []);
});

test("Windows console adapter fails closed for unsupported or incomplete targets", async () => {
  const calls = [];
  const spawn = (...args) => calls.push(args);
  const nonWindows = createWindowsConsoleInputDeliveryAdapter({ osPlatform: "linux", spawn });
  const windows = createWindowsConsoleInputDeliveryAdapter({ osPlatform: "win32", spawn });

  assert.equal((await nonWindows.deliver({ promptText: "x", entry: { agentPid: 1 } })).errorClass, "platform_unsupported");
  assert.equal((await windows.deliver({ promptText: "x", entry: {} })).errorClass, "agent_pid_unavailable");
  assert.equal((await windows.deliver({ promptText: "a\nb", entry: { agentPid: 1 } })).errorClass, "multiline_unsupported");
  assert.deepEqual(calls, []);
});

test("PID normalization keeps only unique positive Win32 process ids", () => {
  assert.equal(normalizePid("42"), 42);
  assert.equal(normalizePid(0), null);
  assert.equal(normalizePid(0xffffffff), null);
  assert.equal(normalizePid(0x100000000), null);
  assert.deepEqual(normalizePidList([1, "2", 2, -3, 4], 1), [2, 4]);
});
