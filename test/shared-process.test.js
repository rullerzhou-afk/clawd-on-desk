// test/shared-process.test.js — Unit tests for hooks/shared-process.js
const { describe, it, beforeEach, mock } = require("node:test");
const assert = require("node:assert");

const { PassThrough } = require("node:stream");

const {
  getPlatformConfig,
  createPidResolver,
  readStdinJsonDetailed,
  DEFAULT_STDIN_READ_TIMEOUT_MS,
  buildElectronLaunchConfig,
  tmuxSocketFromEnv,
  processAlive,
} = require("../hooks/shared-process");

// ═════════════════════════════════════════════════════════════════════════════
// getPlatformConfig()
// ═════════════════════════════════════════════════════════════════════════════

describe("getPlatformConfig()", () => {
  it("returns terminalNames, systemBoundary, editorMap, editorPathChecks", () => {
    const cfg = getPlatformConfig();
    assert.ok(cfg.terminalNames instanceof Set);
    assert.ok(cfg.systemBoundary instanceof Set);
    assert.ok(typeof cfg.editorMap === "object");
    assert.ok(Array.isArray(cfg.editorPathChecks));
  });

  it("base terminal names include common terminals", () => {
    const cfg = getPlatformConfig();
    // At least one terminal should be present regardless of platform
    const all = [...cfg.terminalNames];
    assert.ok(all.length > 5, "should have several terminals");
  });

  it("recognizes Windows console hosts as terminal anchors", { skip: process.platform !== "win32" }, () => {
    const cfg = getPlatformConfig();
    assert.ok(cfg.terminalNames.has("conhost.exe"));
    assert.ok(cfg.terminalNames.has("openconsole.exe"));
  });

  it("merges extraTerminals into base set", () => {
    const cfg = getPlatformConfig({
      extraTerminals: { win: ["custom.exe"], mac: ["custom"], linux: ["custom"] },
    });
    // The extra should be present (exact key depends on platform)
    const isWin = process.platform === "win32";
    const isLinux = process.platform === "linux";
    if (isWin) assert.ok(cfg.terminalNames.has("custom.exe"));
    else if (isLinux) assert.ok(cfg.terminalNames.has("custom"));
    else assert.ok(cfg.terminalNames.has("custom"));
  });

  it("merges extraEditors into base map", () => {
    const cfg = getPlatformConfig({
      extraEditors: { win: { "foo.exe": "foo" }, mac: { "foo": "foo" }, linux: { "foo": "foo" } },
    });
    // Base editors should still be present
    const isWin = process.platform === "win32";
    if (isWin) {
      assert.strictEqual(cfg.editorMap["code.exe"], "code");
      assert.strictEqual(cfg.editorMap["foo.exe"], "foo");
    } else {
      assert.strictEqual(cfg.editorMap["code"], "code");
      assert.strictEqual(cfg.editorMap["foo"], "foo");
    }
  });

  it("prepends extraEditorPathChecks before defaults", () => {
    const cfg = getPlatformConfig({
      extraEditorPathChecks: [["myeditor", "mine"]],
    });
    assert.deepStrictEqual(cfg.editorPathChecks[0], ["myeditor", "mine"]);
    // Default checks still present after
    assert.ok(cfg.editorPathChecks.some(([p]) => p === "visual studio code"));
  });

  it("returns defaults when no options given", () => {
    const cfg = getPlatformConfig();
    assert.ok(cfg.editorPathChecks.length === 2); // visual studio code + cursor.app
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// createPidResolver() — factory + caching behavior
// ═════════════════════════════════════════════════════════════════════════════

describe("createPidResolver()", () => {
  it("returns a function", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg });
    assert.strictEqual(typeof resolve, "function");
  });

  it("caches result after first call", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: process.pid });
    const r1 = resolve();
    const r2 = resolve();
    assert.strictEqual(r1, r2, "should return same object reference");
  });

  it("result has expected shape", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: process.pid });
    const result = resolve();
    assert.ok("stablePid" in result);
    assert.ok("agentPid" in result);
    assert.ok("detectedEditor" in result);
    assert.ok(Array.isArray(result.pidChain));
  });

  it("walks from startPid and populates pidChain", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: process.pid });
    const { pidChain } = resolve();
    // pidChain should contain at least the start PID (our own process)
    assert.ok(pidChain.length >= 1);
    assert.ok(pidChain.includes(process.pid));
  });

  it("respects maxDepth", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: process.pid, maxDepth: 1 });
    const { pidChain } = resolve();
    assert.ok(pidChain.length <= 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// createPidResolver() — tmux resolution
// ═════════════════════════════════════════════════════════════════════════════

// Mocked tmux bridge tests. The previous { skip: !process.env.TMUX } block
// required a running tmux server with a GUI terminal in the client's ancestry,
// so it never ran in CI and failed silently for tmux users in ssh / IDE
// terminals. These mocked variants always run.
describe("createPidResolver() — tmux bridge (mocked)", () => {
  const { loadSharedProcessWithMock } = require("./helpers/load-shared-process-with-mock");

  function makeMock(routes) {
    return function execFileSync(cmd, args /*, opts */) {
      const key = cmd + " " + args.join(" ");
      for (const [pattern, value] of routes) {
        const match = pattern instanceof RegExp ? pattern.test(key) : pattern === key;
        if (!match) continue;
        if (typeof value === "function") return value();
        return value;
      }
      const err = new Error("ENOENT: no route for " + key);
      err.code = "ENOENT";
      throw err;
    };
  }

  it("(a) walk reaches tmux server; list-clients yields client pid → stablePid is terminal", () => {
    const routes = [
      ["ps -o ppid= -p 100", "200\n"],
      ["ps -o comm= -p 100", "zsh\n"],
      ["ps -o ppid= -p 200", "1\n"],
      ["ps -o comm= -p 200", "tmux\n"],
      ["tmux list-clients -t %1 -F #{client_pid}\t#{client_tty}", "300\t/dev/pts/7\n"],
      ["ps -o comm= -p 300", "alacritty\n"],
      ["ps -o ppid= -p 300", "1\n"],
    ];
    const { mod, cleanup } = loadSharedProcessWithMock({
      execFileSyncMock: makeMock(routes),
      env: { TMUX: "/tmp/tmux-1000/default,200,5", TMUX_PANE: "%1" },
      platform: "linux",
    });
    try {
      const cfg = mod.getPlatformConfig();
      const resolve = mod.createPidResolver({ platformConfig: cfg, startPid: 100 });
      const { stablePid, pidChain, tmuxSocket, tmuxClient } = resolve();
      assert.strictEqual(stablePid, 300, "stablePid should be the terminal pid");
      assert.ok(pidChain.includes(200), "pidChain should include tmux server pid");
      assert.ok(pidChain.includes(300), "pidChain should include terminal pid");
      assert.strictEqual(tmuxSocket, "/tmp/tmux-1000/default");
      assert.strictEqual(tmuxClient, "/dev/pts/7");
    } finally {
      cleanup();
    }
  });

  it("(b) walk does not reach tmux server → bridge skipped", () => {
    const routes = [
      ["ps -o ppid= -p 100", "1\n"],
      ["ps -o comm= -p 100", "zsh\n"],
    ];
    const { mod, cleanup } = loadSharedProcessWithMock({
      execFileSyncMock: makeMock(routes),
      env: { TMUX: "/tmp/tmux-1000/default,200,5", TMUX_PANE: "%1" },
      platform: "linux",
    });
    try {
      const cfg = mod.getPlatformConfig();
      const { stablePid, pidChain } = mod.createPidResolver({
        platformConfig: cfg, startPid: 100, maxDepth: 1,
      })();
      assert.strictEqual(stablePid, 100);
      assert.strictEqual(pidChain.length, 1, "no extra hops appended");
    } finally {
      cleanup();
    }
  });

  it("(c) list-clients empty (detached) → bridge skipped, stablePid falls back", () => {
    const routes = [
      ["ps -o ppid= -p 100", "200\n"],
      ["ps -o comm= -p 100", "zsh\n"],
      ["ps -o ppid= -p 200", "1\n"],
      ["ps -o comm= -p 200", "tmux\n"],
      ["tmux list-clients -t %1 -F #{client_pid}\t#{client_tty}", "\n"],
    ];
    const { mod, cleanup } = loadSharedProcessWithMock({
      execFileSyncMock: makeMock(routes),
      env: { TMUX: "/tmp/tmux-1000/default,200,5", TMUX_PANE: "%1" },
      platform: "linux",
    });
    try {
      const cfg = mod.getPlatformConfig();
      const { stablePid, pidChain } = mod.createPidResolver({
        platformConfig: cfg, startPid: 100,
      })();
      assert.ok(!pidChain.some(p => p > 200), "no client pids appended past tmux server");
      assert.strictEqual(stablePid, 200, "falls back to lastGoodPid (tmux server)");
    } finally {
      cleanup();
    }
  });

  it("(d) tmuxSocket parsed from $TMUX exposed on resolver result", () => {
    const routes = [
      ["ps -o ppid= -p 100", "200\n"],
      ["ps -o comm= -p 100", "zsh\n"],
      ["ps -o ppid= -p 200", "1\n"],
      ["ps -o comm= -p 200", "tmux\n"],
      ["tmux list-clients -t %1 -F #{client_pid}\t#{client_tty}", "\n"],
    ];
    const { mod, cleanup } = loadSharedProcessWithMock({
      execFileSyncMock: makeMock(routes),
      env: { TMUX: "/tmp/tmux-1000/work,200,5", TMUX_PANE: "%1" },
      platform: "linux",
    });
    try {
      const cfg = mod.getPlatformConfig();
      const result = mod.createPidResolver({ platformConfig: cfg, startPid: 100 })();
      assert.strictEqual(result.tmuxSocket, "/tmp/tmux-1000/work");
    } finally {
      cleanup();
    }
  });

  it("(e) default socket path is preserved for -S focus", () => {
    const routes = [
      ["ps -o ppid= -p 100", "1\n"],
      ["ps -o comm= -p 100", "zsh\n"],
    ];
    const { mod, cleanup } = loadSharedProcessWithMock({
      execFileSyncMock: makeMock(routes),
      env: { TMUX: "/tmp/tmux-1000/default,200,5", TMUX_PANE: "%1" },
      platform: "linux",
    });
    try {
      const cfg = mod.getPlatformConfig();
      const result = mod.createPidResolver({
        platformConfig: cfg, startPid: 100, maxDepth: 1,
      })();
      assert.strictEqual(result.tmuxSocket, "/tmp/tmux-1000/default");
    } finally {
      cleanup();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildElectronLaunchConfig()
// ═════════════════════════════════════════════════════════════════════════════

describe("buildElectronLaunchConfig()", () => {
  it("strips ELECTRON_RUN_AS_NODE and preserves forwarded args", () => {
    const sourceEnv = {
      ELECTRON_RUN_AS_NODE: "1",
      CLAWD_DISABLE_SANDBOX: "0",
      KEEP_ME: "yes",
    };

    const cfg = buildElectronLaunchConfig("D:\\app", {
      platform: "win32",
      env: sourceEnv,
      forwardedArgs: ["--register-protocol"],
    });

    assert.deepStrictEqual(cfg.args, [".", "--register-protocol"]);
    assert.strictEqual(cfg.cwd, "D:\\app");
    assert.strictEqual(cfg.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.strictEqual(cfg.env.KEEP_ME, "yes");
    assert.strictEqual(sourceEnv.ELECTRON_RUN_AS_NODE, "1");
  });

  it("keeps the Linux sandbox fallback when requested", () => {
    const cfg = buildElectronLaunchConfig("/app", {
      platform: "linux",
      env: {
        CLAWD_DISABLE_SANDBOX: "1",
        ELECTRON_RUN_AS_NODE: "1",
      },
      forwardedArgs: ["--foo"],
    });

    assert.deepStrictEqual(cfg.args, [".", "--no-sandbox", "--disable-setuid-sandbox", "--foo"]);
    assert.strictEqual(cfg.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.strictEqual(cfg.env.ELECTRON_DISABLE_SANDBOX, "1");
    assert.strictEqual(cfg.env.CHROME_DEVEL_SANDBOX, "");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// createPidResolver() — Windows PowerShell / Get-CimInstance path (win32 only)
// ═════════════════════════════════════════════════════════════════════════════

describe("createPidResolver() — Windows PowerShell path", { skip: process.platform !== "win32" }, () => {
  const childProcess = require("child_process");

  function withMockedExec(mockFn, cb) {
    const orig = childProcess.execFileSync;
    childProcess.execFileSync = mockFn;
    try { cb(); } finally { childProcess.execFileSync = orig; }
  }

  // Builds the JSON the snapshot helper expects: one ConvertTo-Json array of
  // process records. Each record: { pid, name, ppid, cmd? }
  function snapshotJson(procs) {
    return JSON.stringify(procs.map((p) => ({
      ProcessId: p.pid,
      Name: p.name,
      ParentProcessId: p.ppid,
      CommandLine: typeof p.cmd === "string" ? p.cmd : null,
    })));
  }

  function snapshotEnvelopeJson(procs, foreground) {
    return JSON.stringify({
      processes: JSON.parse(snapshotJson(procs)),
      foreground,
    });
  }

  it("populates pidChain by walking the snapshot Map", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 1000 });
    withMockedExec(() => snapshotJson([
      { pid: 1000, name: "cmd.exe", ppid: 1001 },
      { pid: 1001, name: "explorer.exe", ppid: 0 },
    ]), () => {
      const { pidChain } = resolve();
      assert.ok(pidChain.includes(1000));
      assert.ok(pidChain.includes(1001));
    });
  });

  it("breaks the walk immediately when the snapshot is empty", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 9999 });
    withMockedExec(() => "", () => {
      const { pidChain } = resolve();
      assert.strictEqual(pidChain.length, 0);
    });
  });

  it("breaks the walk cleanly when ConvertTo-Json outputs 'null'", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 9000 });
    withMockedExec(() => "null", () => {
      const { pidChain } = resolve();
      assert.strictEqual(pidChain.length, 0, "'null' PS output must abort the walk");
    });
  });

  it("sets stablePid to the terminal PID when a terminal process is found", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 500 });
    withMockedExec(() => snapshotJson([
      { pid: 500, name: "windowsterminal.exe", ppid: 0 },
    ]), () => {
      const { stablePid } = resolve();
      assert.strictEqual(stablePid, 500);
    });
  });

  it("captures the foreground Windows Terminal HWND from the same snapshot", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 500 });
    withMockedExec(() => snapshotEnvelopeJson([
      { pid: 500, name: "powershell.exe", ppid: 501 },
      { pid: 501, name: "explorer.exe", ppid: 0 },
      { pid: 700, name: "WindowsTerminal.exe", ppid: 0 },
    ], {
      hwnd: "123456",
      pid: 700,
      className: "CASCADIA_HOSTING_WINDOW_CLASS",
    }), () => {
      const { foregroundWtHwnd } = resolve();
      assert.strictEqual(foregroundWtHwnd, "123456");
    });
  });

  it("rejects foreground HWNDs that are not Windows Terminal host windows", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 500 });
    withMockedExec(() => snapshotEnvelopeJson([
      { pid: 500, name: "powershell.exe", ppid: 501 },
      { pid: 501, name: "explorer.exe", ppid: 0 },
      { pid: 700, name: "WindowsTerminal.exe", ppid: 0 },
    ], {
      hwnd: "123456",
      pid: 700,
      className: "PseudoConsoleWindow",
    }), () => {
      const { foregroundWtHwnd } = resolve();
      assert.strictEqual(foregroundWtHwnd, null);
    });
  });

  it("detects editor from process name", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 200 });
    withMockedExec(() => snapshotJson([
      { pid: 200, name: "code.exe", ppid: 0 },
    ]), () => {
      const { detectedEditor } = resolve();
      assert.strictEqual(detectedEditor, "code");
    });
  });

  it("stops the walk at a system boundary process (explorer.exe)", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 300 });
    withMockedExec(() => snapshotJson([
      { pid: 300, name: "cmd.exe", ppid: 301 },
      { pid: 301, name: "explorer.exe", ppid: 302 },
      { pid: 302, name: "unreachable.exe", ppid: 0 },
    ]), () => {
      const { pidChain } = resolve();
      assert.ok(pidChain.includes(301), "explorer.exe must be in the chain");
      assert.ok(!pidChain.includes(302), "walk must stop after the system boundary");
    });
  });

  it("uses a single PowerShell spawn for the snapshot regardless of chain depth", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 100 });
    let spawnCount = 0;
    withMockedExec(() => {
      spawnCount++;
      return snapshotJson([
        { pid: 100, name: "cmd.exe", ppid: 101 },
        { pid: 101, name: "powershell.exe", ppid: 102 },
        { pid: 102, name: "windowsterminal.exe", ppid: 0 },
      ]);
    }, () => {
      resolve();
      assert.strictEqual(spawnCount, 1, "snapshot must be taken exactly once");
    });
  });

  it("detects agentPid when agentNameSet matches a process name", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({
      platformConfig: cfg,
      startPid: 400,
      agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
    });
    withMockedExec(() => snapshotJson([
      { pid: 400, name: "node.exe", ppid: 401 },
      { pid: 401, name: "claude.exe", ppid: 0, cmd: "C:\\Program Files\\claude\\claude.exe" },
    ]), () => {
      const { agentPid, agentCommandLine } = resolve();
      assert.strictEqual(agentPid, 401);
      assert.ok(agentCommandLine.includes("claude.exe"), "agentCommandLine must come from the snapshot");
    });
  });

  it("detects agentPid via agentCmdlineCheck on node.exe using snapshot CommandLine", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({
      platformConfig: cfg,
      startPid: 600,
      agentCmdlineCheck: (cmdline) => cmdline.includes("claude-code"),
    });
    withMockedExec(() => snapshotJson([
      { pid: 600, name: "node.exe", ppid: 0, cmd: "node C:\\Users\\x\\AppData\\Local\\claude-code\\index.js" },
    ]), () => {
      const { agentPid, agentCommandLine } = resolve();
      assert.strictEqual(agentPid, 600);
      assert.ok(agentCommandLine.includes("claude-code"));
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// readStdinJsonDetailed() — injectable stream + timeout (#583)
// ═════════════════════════════════════════════════════════════════════════════

describe("readStdinJsonDetailed()", () => {
  it("parses a complete JSON payload on EOF and reports bytes", async () => {
    const stream = new PassThrough();
    const pending = readStdinJsonDetailed({ stream });
    stream.end('{"session_id":"abc-123","cwd":"D:\\\\x"}');

    const result = await pending;
    assert.strictEqual(result.payload.session_id, "abc-123");
    assert.strictEqual(result.bytes, Buffer.byteLength('{"session_id":"abc-123","cwd":"D:\\\\x"}'));
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.parseError, null);
  });

  it("strips a leading UTF-8 BOM before parsing (#638)", async () => {
    const stream = new PassThrough();
    const pending = readStdinJsonDetailed({ stream });
    stream.end('\uFEFF{"session_id":"bom-sid"}');

    const result = await pending;
    assert.strictEqual(result.payload.session_id, "bom-sid");
    assert.strictEqual(result.parseError, null);
  });

  it("treats a lone UTF-8 BOM as an empty payload, not a parse error (#638)", async () => {
    const stream = new PassThrough();
    const pending = readStdinJsonDetailed({ stream });
    stream.end("\uFEFF");

    const result = await pending;
    assert.deepStrictEqual(result.payload, {});
    assert.strictEqual(result.parseError, null);
  });

  it("concatenates chunked writes before parsing", async () => {
    const stream = new PassThrough();
    const pending = readStdinJsonDetailed({ stream });
    stream.write('{"session_id":');
    stream.write('"chunked"');
    stream.end("}");

    const result = await pending;
    assert.strictEqual(result.payload.session_id, "chunked");
    assert.strictEqual(result.timedOut, false);
  });

  it("returns empty payload with bytes:0 when stdin closes with no data", async () => {
    const stream = new PassThrough();
    const pending = readStdinJsonDetailed({ stream });
    stream.end();

    const result = await pending;
    assert.deepStrictEqual(result.payload, {});
    assert.strictEqual(result.bytes, 0);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.parseError, null);
  });

  it("reports a parse error for malformed JSON but still resolves {}", async () => {
    const stream = new PassThrough();
    const pending = readStdinJsonDetailed({ stream });
    stream.end('{"session_id":"broken"');

    const result = await pending;
    assert.deepStrictEqual(result.payload, {});
    assert.strictEqual(result.bytes, 22);
    assert.ok(typeof result.parseError === "string" && result.parseError.length > 0);
  });

  it("times out when EOF never arrives, keeping any bytes received so far", async () => {
    const stream = new PassThrough();
    const pending = readStdinJsonDetailed({ stream, timeoutMs: 40 });
    stream.write('{"half":');
    // no end() — simulates an intermediary swallowing EOF

    const result = await pending;
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.bytes, 8);
    assert.deepStrictEqual(result.payload, {});
    assert.ok(typeof result.parseError === "string" && result.parseError.length > 0);
  });

  it("parses data that arrived in full even when EOF is swallowed", async () => {
    const stream = new PassThrough();
    const pending = readStdinJsonDetailed({ stream, timeoutMs: 40 });
    stream.write('{"session_id":"no-eof"}');

    const result = await pending;
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.payload.session_id, "no-eof");
    assert.strictEqual(result.parseError, null);
  });

  it("keeps the shared default timeout at 400ms — other agent hooks run ~800ms stdout safety timers that must win the race", () => {
    assert.strictEqual(DEFAULT_STDIN_READ_TIMEOUT_MS, 400);
  });

  it("resolves (instead of crashing) when the stream errors mid-read, reporting a stream error", async () => {
    const stream = new PassThrough();
    const pending = readStdinJsonDetailed({ stream });
    stream.write('{"half":');
    stream.emit("error", new Error("boom"));

    const result = await pending;
    assert.deepStrictEqual(result.payload, {});
    assert.strictEqual(result.bytes, 8);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.parseError, "stream error: boom");
  });

  it("handles multi-megabyte stdin without truncation", async () => {
    const stream = new PassThrough();
    const pending = readStdinJsonDetailed({ stream });
    const big = JSON.stringify({ session_id: "big-sid", blob: "z".repeat(3 * 1024 * 1024) });
    // write in 64KB slices like a real pipe would
    for (let i = 0; i < big.length; i += 65536) stream.write(big.slice(i, i + 65536));
    stream.end();

    const result = await pending;
    assert.strictEqual(result.payload.session_id, "big-sid");
    assert.strictEqual(result.bytes, Buffer.byteLength(big));
    assert.strictEqual(result.parseError, null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// #627 provenance: snapshotOk / terminalPid — the fields the pid cache uses to
// refuse caching a degraded Windows snapshot instead of reverse-inferring from
// stablePid. Uses the mock loader so it runs on any platform.
// ═════════════════════════════════════════════════════════════════════════════

describe("createPidResolver() — snapshot provenance (#627, mocked win32)", () => {
  const { loadSharedProcessWithMock } = require("./helpers/load-shared-process-with-mock");

  function snapshotJson(procs) {
    return JSON.stringify(procs.map((p) => ({
      ProcessId: p.pid,
      Name: p.name,
      ParentProcessId: p.ppid,
      CommandLine: typeof p.cmd === "string" ? p.cmd : null,
    })));
  }

  it("snapshotOk true + terminalPid set when the walk reaches a terminal", () => {
    const { mod, cleanup } = loadSharedProcessWithMock({
      execFileSyncMock: () => snapshotJson([
        { pid: 500, name: "node.exe", ppid: 600, cmd: "node C:/x/claude-code/cli.js" },
        { pid: 600, name: "windowsterminal.exe", ppid: 0 },
      ]),
      platform: "win32",
    });
    try {
      const cfg = mod.getPlatformConfig();
      const r = mod.createPidResolver({
        platformConfig: cfg,
        startPid: 500,
        agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
        agentCmdlineCheck: (c) => c.includes("claude-code"),
      })();
      assert.strictEqual(r.snapshotOk, true);
      assert.strictEqual(r.terminalPid, 600);
      assert.strictEqual(r.stablePid, 600);
      assert.strictEqual(r.agentPid, 500);
    } finally {
      cleanup();
    }
  });

  it("snapshotOk false + terminalPid null + stablePid decays to startPid on empty snapshot", () => {
    const { mod, cleanup } = loadSharedProcessWithMock({
      execFileSyncMock: () => "", // empty PS output → getWindowsProcessSnapshot yields an empty Map
      platform: "win32",
    });
    try {
      const cfg = mod.getPlatformConfig();
      const r = mod.createPidResolver({ platformConfig: cfg, startPid: 4242 })();
      assert.strictEqual(r.snapshotOk, false);
      assert.strictEqual(r.terminalPid, null);
      assert.strictEqual(r.stablePid, 4242, "decays to the ephemeral start pid — must not be cached");
      assert.strictEqual(r.agentPid, null);
    } finally {
      cleanup();
    }
  });
});

describe("tmuxSocketFromEnv()", () => {
  it("parses the socket path from $TMUX", () => {
    const saved = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-1000/work,200,5";
    try {
      assert.strictEqual(tmuxSocketFromEnv(), "/tmp/tmux-1000/work");
    } finally {
      if (saved === undefined) delete process.env.TMUX;
      else process.env.TMUX = saved;
    }
  });

  it("returns null when $TMUX is unset", () => {
    const saved = process.env.TMUX;
    delete process.env.TMUX;
    try {
      assert.strictEqual(tmuxSocketFromEnv(), null);
    } finally {
      if (saved !== undefined) process.env.TMUX = saved;
    }
  });
});

describe("processAlive()", () => {
  it("true for the current process", () => {
    assert.strictEqual(processAlive(process.pid), true);
  });

  it("false for a pid that does not exist", () => {
    assert.strictEqual(processAlive(2147483646), false);
  });

  it("false for non-positive / non-numeric input", () => {
    assert.strictEqual(processAlive(0), false);
    assert.strictEqual(processAlive(-1), false);
    assert.strictEqual(processAlive(null), false);
    assert.strictEqual(processAlive("nope"), false);
  });
});
