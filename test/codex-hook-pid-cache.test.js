const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runCodexHook, buildStateBody, buildPermissionBody, isCodexDesktopSession } = require("../hooks/codex-hook");
const { createPidResolver, getPlatformConfig } = require("../hooks/shared-process");
const pc = require("../hooks/pid-cache");
const { CODEX_WSL_INTEROP_ARG } = require("../hooks/server-config");
const { buildSessionSnapshot } = require("../src/state-session-snapshot");
const { STATE_PRIORITY } = require("../src/state-priority");

// Exercise the real Windows resolver and real sanitized cache. Do not emulate
// process.platform: these integration cases must be skipped on other hosts.
describe("Codex Desktop Windows PID cache", { skip: process.platform !== "win32" }, () => {
  let cacheDir;
  const savedEnv = {};
  before(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-client-pid-cache-"));
    pc.__setCacheDirForTests(cacheDir);
    for (const key of ["CODEX_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CLAWD_REMOTE", "CLAWD_WSL_DISTRO", "WSL_DISTRO_NAME", "ORCA_PANE_KEY"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CODEX_HOME = cacheDir;
  });
  after(() => {
    pc.__setCacheDirForTests(null);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  let sequence = 0;
  function harness(t, { env = { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, snapshot, payload = {}, options = {}, parentName = "codexdesktop.exe" } = {}) {
    const alive = new Set([1001, 1002, 1003, 1004, 1005, 9000]);
    t.mock.method(process, "kill", (pid, signal) => {
      assert.equal(signal, 0, "only liveness probes are allowed");
      if (!alive.has(Number(pid))) throw Object.assign(new Error("mock dead process"), { code: "ESRCH" });
      return true;
    });
    let wrapper = 1001;
    let snapshots = 0;
    const metadata = [];
    const deliveries = [];
    const basePayload = { session_id: `client-cache-${sequence++}`, cwd: "C:/test/project", ...payload };
    const identity = { ok: true, ownerPid: 9000, port: 23333 };
    const hookOptions = {
      env, argv: [], resolveWslDistro: () => null,
      readWindowsProcessChainHookContext: () => ({ identity, observation: null }),
      createPidResolver(base) {
        const resolve = createPidResolver({
          ...base, startPid: wrapper, env, readRuntimeIdentity: () => identity,
          getWindowsProcessSnapshot() {
            snapshots++;
            return snapshot ? snapshot(wrapper) : {
              processes: new Map([
                [wrapper, { name: "powershell.exe", ppid: 1002, commandLine: "hook wrapper", startIdentity: "wrapper-start" }],
                [1002, { name: "codex.exe", ppid: 1003, commandLine: "codex app-server", startIdentity: "agent-start" }],
                [1003, { name: parentName, ppid: 1004, commandLine: "desktop", startIdentity: "desktop-start" }],
                [1004, { name: "explorer.exe", ppid: 0, commandLine: "" }],
              ]), foregroundWtHwnd: null,
            };
          },
        });
        return (context) => {
          const result = resolve(context);
          assert.equal(context.sessionId, `codex:${basePayload.session_id}`);
          assert.equal(context.cacheCwd, basePayload.cwd);
          metadata.push(result);
          return result;
        };
      },
      postState(body, _options, done) { deliveries.push(JSON.parse(body)); done(true, 23333); },
      readCodexAutoStartGate() { throw new Error("unexpected auto-start gate"); },
      runAutoStart() { throw new Error("unexpected auto-start"); },
      ...options,
    };
    return {
      alive, metadata, deliveries,
      run: (event, extra = {}) => runCodexHook({ ...basePayload, hook_event_name: event, ...extra }, hookOptions),
      readCache: () => pc.readPidCacheV2("codex", `codex:${basePayload.session_id}`, basePayload.cwd),
      nextWrapper() { alive.delete(wrapper); wrapper = 1005; },
      snapshots: () => snapshots,
    };
  }

  it("keeps a prewarmed side-chat app-server anchor after the SessionStart wrapper exits", async (t) => {
    const h = harness(t);
    const start = await h.run("SessionStart", { source: "startup" });
    assert.equal(start.body, null);
    assert.equal(h.deliveries.length, 0);
    assert.ok(h.readCache(), JSON.stringify(h.metadata));
    assert.equal(h.readCache().stablePid, 1002);
    assert.equal(h.readCache().agentPid, 1002);
    assert.equal(h.metadata[0].sourceProcessStartIdentity, "agent-start");
    assert.equal(h.metadata[0].terminalPid, 1001, "the raw terminal observation is preserved");
    const livePrompt = await h.run("UserPromptSubmit", { prompt: "ordinary side chat" });
    assert.equal(livePrompt.body.source_pid, 1002, "outgoing source also uses the app-server before wrapper death");
    assert.equal(livePrompt.body.codex_originator, "Codex Desktop");
    h.nextWrapper();
    const prompt = await h.run("UserPromptSubmit", { prompt: "ordinary side chat" });
    assert.equal(prompt.body.source_pid, 1002);
    assert.equal(prompt.body.agent_pid, 1002);
    assert.equal(h.metadata.at(-1).cacheSource, "v2");
    assert.equal(h.snapshots(), 1, "prompt never takes a new snapshot");
    assert.equal(prompt.body.codex_internal_thread, undefined);
    const stop = await h.run("Stop");
    assert.equal(stop.body.source_pid, 1002);
    assert.equal(h.snapshots(), 1);
    assert.ok(h.readCache(), "Stop is turn completion, not cache teardown");
    const end = await h.run("SessionEnd");
    assert.equal(end.body.source_pid, 1002);
    assert.equal(end.body.agent_pid, 1002);
    assert.equal(h.snapshots(), 1, "end never takes a new snapshot");
    assert.equal(h.readCache(), null);
  });

  for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
    it(`keeps the first prompt PID after a ${source} SessionStart wrapper exits`, async (t) => {
      const h = harness(t);
      await h.run("SessionStart", { source });
      h.nextWrapper();
      const prompt = await h.run("UserPromptSubmit");
      assert.equal(prompt.body.source_pid, 1002);
      assert.equal(prompt.body.agent_pid, 1002);
      assert.equal(prompt.body.codex_originator, "Codex Desktop");
      assert.equal(prompt.body.codex_source, undefined, "a start cause is not session provenance");
      assert.equal(h.readCache().stablePid, 1002);
      assert.equal(h.metadata.at(-1).cacheSource, "v2");
      assert.equal(h.snapshots(), 1, "the first prompt remains cache-only");
      h.alive.delete(1002);
      assert.equal((await h.run("UserPromptSubmit")).body.source_pid, null);
      assert.equal(h.snapshots(), 1, "agent death cannot cause a prompt fallback");
    });
  }

  it("passes Codex's five-second deadline through the real shared snapshot helper only on fresh queries", async (t) => {
    const alive = new Set([1001, 1002, 1003, 1004, 9000]);
    t.mock.method(process, "kill", (pid, signal) => {
      assert.equal(signal, 0);
      if (!alive.has(Number(pid))) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true;
    });
    const deadlines = [];
    let failSnapshot = false;
    t.mock.method(require("node:child_process"), "execFileSync", (file, args, options) => {
      assert.equal(file, "powershell.exe");
      assert.equal(options.windowsHide, true);
      assert.equal(args.includes("Hidden"), true);
      deadlines.push(options.timeout);
      if (failSnapshot) throw Object.assign(new Error("snapshot timed out"), { code: "ETIMEDOUT" });
      return JSON.stringify([
        { ProcessId: 1001, Name: "powershell.exe", ParentProcessId: 1002, CommandLine: "hook", StartIdentity: "wrapper-start" },
        { ProcessId: 1002, Name: "codex.exe", ParentProcessId: 1003, CommandLine: "codex app-server", StartIdentity: "agent-start" },
        { ProcessId: 1003, Name: "codexdesktop.exe", ParentProcessId: 1004, CommandLine: "desktop", StartIdentity: "desktop-start" },
        { ProcessId: 1004, Name: "explorer.exe", ParentProcessId: 0, CommandLine: "" },
      ]);
    });
    const identity = { ok: true, ownerPid: 9000, port: 23333 };
    const factoryDeadlines = [];
    const run = (event, extra = {}) => runCodexHook({ session_id: "snapshot-deadline", cwd: "C:/test/deadline", hook_event_name: event, ...extra }, {
      env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, argv: [],
      resolveWslDistro: () => null,
      readWindowsProcessChainHookContext: () => ({ identity, observation: null }),
      createPidResolver(base) {
        factoryDeadlines.push(base.windowsSnapshotTimeoutMs);
        return createPidResolver({ ...base, startPid: 1001, readRuntimeIdentity: () => identity });
      },
      postState(_body, _options, done) { done(true, 23333); },
      readCodexAutoStartGate() { throw new Error("unexpected auto-start gate"); },
    });
    await run("SessionStart", { source: "fork" });
    assert.deepEqual(deadlines, [5000]);
    alive.delete(1001);
    const prompt = await run("UserPromptSubmit");
    assert.equal(prompt.body.source_pid, 1002);
    assert.equal((await run("SessionEnd")).body.agent_pid, 1002);
    assert.deepEqual(deadlines, [5000], "prompt/end never query");
    assert.deepEqual(factoryDeadlines, [5000, 5000, 5000]);
    createPidResolver({ platformConfig: getPlatformConfig(), startPid: 1001, env: {}, readRuntimeIdentity: () => identity })();
    assert.deepEqual(deadlines, [5000, 3000], "generic callers keep the three-second default");
    failSnapshot = true;
    await run("SessionStart", { source: "fork" });
    assert.equal(pc.readPidCacheV2("codex", "codex:snapshot-deadline", "C:/test/deadline"), null);
    for (const event of ["UserPromptSubmit", "SessionEnd"]) {
      const result = await run(event);
      assert.equal(result.body.source_pid, null);
      assert.equal(result.body.agent_pid, undefined);
    }
    assert.deepEqual(deadlines, [5000, 3000, 5000], "a timeout never retries or falls back on prompt/end");
    const interrupt = await run("Interrupt");
    assert.equal(interrupt.body.source_pid, null);
    assert.equal(interrupt.body.agent_pid, undefined);
    assert.deepEqual(deadlines, [5000, 3000, 5000, 3000], "Interrupt respects the three-second outer cap on a cache miss");
    assert.equal(factoryDeadlines.at(-1), 3000);
  });

  it("uses the current Desktop env alias and preserves ambient versus ordinary chat tagging", async (t) => {
    const h = harness(t, {
      env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_work_desktop" },
      payload: { cwd: "C:/test/memories" },
    });
    await h.run("SessionStart");
    h.nextWrapper();
    const ambient = await h.run("UserPromptSubmit", {
      prompt: "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex",
    });
    assert.equal(ambient.body.codex_internal_thread, "ambient_suggestions");
    assert.equal(ambient.body.source_pid, 1002);
    const ordinary = await h.run("UserPromptSubmit", { prompt: "help with my side chat" });
    assert.equal(ordinary.body.codex_internal_thread, undefined);
    assert.equal(ordinary.body.source_pid, 1002);
    assert.equal(h.snapshots(), 1);
  });

  it("keeps two side chats sharing an app-server visible through snapshot dedupe", async (t) => {
    const first = harness(t);
    const second = harness(t);
    await first.run("SessionStart");
    await second.run("SessionStart");
    first.nextWrapper();
    second.nextWrapper();
    const bodies = [(await first.run("UserPromptSubmit")).body, (await second.run("UserPromptSubmit")).body];
    const sessions = new Map(bodies.map((body, index) => [body.session_id, {
      state: body.state, event: body.event, cwd: body.cwd,
      agentId: body.agent_id, agentPid: body.agent_pid, sourcePid: body.source_pid,
      codexOriginator: body.codex_originator, updatedAt: 1000 + index,
      headless: false, recentEvents: [],
    }]));
    const snapshot = buildSessionSnapshot(sessions, { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    assert.equal(snapshot.sessions.length, 2);
    assert.equal(snapshot.hudTotalNonIdle, 2);
    assert.equal(snapshot.sessions.every((session) => session.hiddenFromHud === false), true);
    assert.equal(first.snapshots(), 1);
    assert.equal(second.snapshots(), 1);
  });

  it("rejects a dead app-server on prompt and end without a new snapshot", async (t) => {
    const h = harness(t);
    await h.run("SessionStart");
    h.nextWrapper();
    h.alive.delete(1002);
    for (const event of ["UserPromptSubmit", "SessionEnd"]) {
      const result = await h.run(event);
      assert.equal(result.body.source_pid, null);
      assert.equal(result.body.agent_pid, undefined);
      assert.equal(h.snapshots(), 1);
    }
    assert.equal(h.readCache(), null);
  });

  it("uses an explicit audited Desktop originator with an unknown env override", async (t) => {
    const h = harness(t, { env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex" }, payload: { originator: "codex_work_desktop" } });
    await h.run("SessionStart");
    h.nextWrapper();
    assert.equal((await h.run("UserPromptSubmit")).body.source_pid, 1002);
    assert.equal(h.readCache().stablePid, 1002);
    assert.equal(h.snapshots(), 1);
  });

  for (const [label, snapshot] of [
    ["failed snapshot", () => null],
    ["malformed snapshot", () => ({ processes: null, foregroundWtHwnd: "123" })],
    ["empty snapshot", () => ({ processes: new Map(), foregroundWtHwnd: "123" })],
    ["missing start row", () => ({ processes: new Map([[1002, { name: "codex.exe", ppid: 1003, commandLine: "codex app-server" }]]), foregroundWtHwnd: "123" })],
    ["unverified agent row", (wrapper) => ({ processes: new Map([[wrapper, { name: "powershell.exe", ppid: 1002, commandLine: "hook" }]]), foregroundWtHwnd: null })],
  ]) {
    it(`does not populate a Desktop anchor from a ${label}`, async (t) => {
      const h = harness(t, { snapshot });
      await h.run("SessionStart");
      assert.equal(h.readCache(), null);
      h.nextWrapper();
      for (const event of ["UserPromptSubmit", "SessionEnd"]) {
        const result = await h.run(event);
        assert.equal(result.body.source_pid, null);
        assert.equal(result.body.agent_pid, undefined);
        assert.equal(result.body.wt_hwnd, undefined);
        assert.equal(h.snapshots(), 1, "failed prewarm cannot trigger a prompt/end fallback");
      }
    });
  }

  it("keeps a missing-start prompt cache-only and lets an ordinary event seed the verified anchor", async (t) => {
    const h = harness(t);
    const prompt = await h.run("UserPromptSubmit");
    assert.equal(prompt.body.source_pid, null);
    assert.equal(h.snapshots(), 0);
    const stop = await h.run("Stop");
    assert.equal(stop.body.source_pid, 1002);
    assert.equal(h.readCache().stablePid, 1002);
    h.nextWrapper();
    assert.equal((await h.run("UserPromptSubmit")).body.source_pid, 1002);
    assert.equal(h.snapshots(), 1);
  });

  for (const originator of ["codex-tui", "codex_cli_rs", "unknown-client"]) {
    it(`preserves terminal/editor focus for explicit ${originator} despite inherited Desktop env`, async (t) => {
      const h = harness(t, { payload: { originator }, parentName: "code.exe" });
      await h.run("SessionStart", { source: "startup" });
      assert.equal(h.readCache().stablePid, 1003);
      assert.equal(h.metadata[0].sourceProcessStartIdentity, "desktop-start");
      h.nextWrapper();
      const prompt = await h.run("UserPromptSubmit");
      assert.equal(prompt.body.source_pid, 1003);
      assert.equal(prompt.body.agent_pid, 1002);
      assert.equal(prompt.body.editor, "code");
      assert.equal(prompt.body.codex_originator, originator);
      h.alive.delete(1003);
      assert.equal((await h.run("UserPromptSubmit")).body.source_pid, null, "stable PID death still rejects both fields");
      assert.equal(h.snapshots(), 1);
    });
  }

  for (const env of [{}, { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex" }]) {
    it(`keeps the ordinary resolver anchor with ${env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || "no"} env originator`, async (t) => {
      const h = harness(t, { env });
      await h.run("SessionStart");
      assert.equal(h.readCache().stablePid, 1001);
      h.nextWrapper();
      const prompt = await h.run("UserPromptSubmit");
      assert.equal(prompt.body.source_pid, null);
      assert.equal(prompt.body.agent_pid, undefined);
      assert.equal(h.snapshots(), 1);
    });
  }

  it("does not replace the headless anchor with an inherited Desktop app-server", async (t) => {
    const h = harness(t, { payload: { headless: true } });
    await h.run("SessionStart", { source: "startup" });
    assert.equal(h.readCache().stablePid, 1001);
    h.nextWrapper();
    assert.equal((await h.run("UserPromptSubmit")).body.source_pid, null);
    assert.equal(h.snapshots(), 1);
  });

  for (const source of ["unknown", "Startup", " startup ", { type: "startup" }, null]) {
    it(`does not exempt an unknown or malformed SessionStart source ${JSON.stringify(source)}`, async (t) => {
      const h = harness(t);
      await h.run("SessionStart", { source });
      assert.equal(h.readCache().stablePid, 1001);
      h.nextWrapper();
      const prompt = await h.run("UserPromptSubmit");
      assert.equal(prompt.body.source_pid, null);
      assert.equal(prompt.body.agent_pid, undefined);
      assert.equal(h.snapshots(), 1);
    });
  }

  for (const [label, env, options] of [
    ["WSL env", { CLAWD_WSL_DISTRO: "Ubuntu" }, {}],
    ["WSL interop", {}, { argv: [CODEX_WSL_INTEROP_ARG] }],
    ["detected WSL", {}, { resolveWslDistro: () => "Ubuntu" }],
  ]) {
    it(`does not use the native Desktop anchor under ${label}`, async (t) => {
      const h = harness(t, { env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop", ...env }, options });
      await h.run("SessionStart", { source: "startup" });
      assert.equal(h.readCache().stablePid, 1001);
      assert.equal((await h.run("UserPromptSubmit")).body.source_pid, 1001);
      h.nextWrapper();
      assert.equal((await h.run("UserPromptSubmit")).body.source_pid, null);
      assert.equal(h.snapshots(), 1);
    });
  }

  it("never resolves or anchors the local tree in remote mode", async (t) => {
    const h = harness(t, { env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop", CLAWD_REMOTE: "1" } });
    await h.run("SessionStart", { source: "startup" });
    assert.equal(h.readCache(), null);
    assert.equal((await h.run("UserPromptSubmit")).body.source_pid, null);
    assert.equal(h.snapshots(), 0);
  });

  it("keeps authoritative Desktop routing metadata while skipping the legacy resolver", async (t) => {
    const h = harness(t, { options: {
      readWindowsProcessChainHookContext: () => ({
        identity: { ok: true, ownerPid: 9000, port: 23333 },
        observation: { ownerPid: 9000, port: 23333, agentMode: "b1a-authoritative" },
      }),
    } });
    await h.run("SessionStart");
    const prompt = await h.run("UserPromptSubmit");
    assert.equal(prompt.body.codex_originator, "Codex Desktop");
    assert.equal(prompt.body.source_pid, undefined);
    assert.equal(prompt.body.agent_pid, undefined);
    assert.equal(h.readCache(), null);
    assert.equal(h.snapshots(), 0);
  });

  it("leaves other adapters' no-arg shape and double liveness unchanged even with a Desktop opt-in", (t) => {
    const alive = new Set([2001, 2002, 2003, 9000]);
    t.mock.method(process, "kill", (pid, signal) => {
      assert.equal(signal, 0);
      if (!alive.has(pid)) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true;
    });
    let snapshots = 0;
    const resolve = createPidResolver({
      startPid: 2001, platformConfig: getPlatformConfig(), env: {},
      agentNames: { win: new Set(["claude.exe"]) },
      readRuntimeIdentity: () => ({ ok: true, ownerPid: 9000, port: 23333 }),
      getWindowsProcessSnapshot() {
        snapshots++;
        return { processes: new Map([
          [2001, { name: "powershell.exe", ppid: 2002, commandLine: "hook" }],
          [2002, { name: "claude.exe", ppid: 2003, commandLine: "claude" }],
          [2003, { name: "code.exe", ppid: 0, commandLine: "code" }],
        ]), foregroundWtHwnd: null };
      },
    });
    const raw = resolve();
    assert.deepEqual(Object.keys(raw).sort(), ["agentCommandLine", "agentPid", "detectedEditor", "foregroundWtHwnd", "pidChain", "snapshotOk", "stablePid", "terminalPid", "tmuxClient", "tmuxSocket"].sort());
    const context = { namespace: "claude-code", sessionId: "other-adapter", cacheCwd: "C:/test/other", cacheable: true, preferAgentPid: true };
    assert.equal(resolve({ ...context, lifecycle: "start" }).stablePid, 2003);
    assert.equal(resolve(), raw);
    for (const dead of [2003, 2002]) {
      alive.delete(dead);
      const prompt = resolve({ ...context, lifecycle: "prompt" });
      assert.equal(prompt.stablePid, null);
      assert.equal(prompt.agentPid, null);
      alive.add(dead);
    }
    assert.equal(snapshots, 1);
    resolve({ ...context, lifecycle: "end" });
  });
});

describe("Codex Desktop PID preference provenance", () => {
  const mockResolve = () => ({ stablePid: 11, agentPid: 22, detectedEditor: "code", pidChain: [11, 22] });
  for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
    it(`separates the ${source} SessionStart cause from session and permission provenance`, () => {
      const options = { platform: "win32", env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" } };
      const payload = { hook_event_name: "SessionStart", session_id: "client", source };
      const state = buildStateBody(payload, mockResolve, options);
      assert.equal(state.source_pid, 22);
      assert.equal(state.codex_originator, "Codex Desktop");
      assert.equal(state.codex_source, undefined);
      assert.equal(payload.source, source, "the lifecycle cause stays on the original payload");
      assert.equal(isCodexDesktopSession(payload, { source }, options), false, "session_meta.source remains declared provenance");
      for (const provenance of [{ source: "cli" }, { source: { type: "exec" } }, { originator: null }]) {
        assert.equal(isCodexDesktopSession(payload, provenance, options), false);
      }
      for (const originator of ["codex-tui", "unknown-client"]) {
        const explicit = buildStateBody({ ...payload, originator }, mockResolve, options);
        assert.equal(explicit.source_pid, 11);
        assert.equal(explicit.codex_originator, originator);
        assert.equal(explicit.codex_source, undefined);
      }
      const child = buildStateBody({ ...payload, codex_session_role: "subagent" }, mockResolve, options);
      assert.equal(child.source_pid, 11);
      assert.equal(child.codex_originator, undefined);
      for (const event of ["Stop", "PermissionRequest", "sessionstart"]) {
        assert.equal(isCodexDesktopSession({ ...payload, hook_event_name: event }, null, options), false);
      }
      const permission = buildPermissionBody({ ...payload, hook_event_name: "PermissionRequest", tool_name: "Bash" }, mockResolve, options);
      assert.equal(permission.source_pid, 11);
      assert.equal(permission.codex_originator, undefined);
      assert.equal(permission.codex_source, source, "permission provenance is never exempted");
    });
  }
  for (const originator of ["Codex Desktop", "codex_work_desktop"]) {
    it(`uses the audited ${originator} env alias for state and permission source fields`, () => {
      const options = { platform: "win32", env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: originator } };
      const body = buildStateBody({ hook_event_name: "Stop", session_id: "client", cwd: "C:/test/project" }, mockResolve, options);
      assert.equal(body.source_pid, 22);
      assert.equal(body.codex_originator, originator);
      const permission = buildPermissionBody({ hook_event_name: "PermissionRequest", session_id: "client", tool_name: "Bash" }, mockResolve, options);
      assert.equal(permission.source_pid, 22);
      assert.equal(permission.codex_originator, originator);
      const headless = buildPermissionBody({ hook_event_name: "PermissionRequest", session_id: "client", tool_name: "Bash", headless: true }, mockResolve, options);
      assert.equal(headless.source_pid, 11);
      assert.equal(headless.headless, true);
      assert.equal(headless.codex_originator, undefined);
    });
  }
  for (const payload of [
    { originator: "codex-tui" }, { originator: "unknown-client" },
    { source: "exec" }, { source: "internal" }, { source: "cli" },
    { source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } },
    { transcript_path: "nonexistent-rollout.jsonl" },
  ]) {
    it(`does not override explicit or transcript-backed provenance ${JSON.stringify(payload)}`, () => {
      const body = buildStateBody({ hook_event_name: "Stop", session_id: "client", ...payload }, mockResolve, { platform: "win32", env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" } });
      assert.equal(body.source_pid, 11);
      assert.equal(body.codex_originator, payload.originator);
    });
  }

  for (const provenance of [
    { originator: 123 }, { originator: {} }, { originator: null },
    { source: { type: "exec" } }, { source: { role: "unknown" } },
    { source: {} }, { source: 123 }, { source: null },
  ]) {
    it(`does not infer Desktop from present malformed/structured provenance ${JSON.stringify(provenance)}`, () => {
      const options = { platform: "win32", env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" } };
      assert.equal(isCodexDesktopSession({}, provenance, options), false, "malformed session_meta also blocks env inference");
      const state = buildStateBody({ hook_event_name: "Stop", session_id: "client", ...provenance }, mockResolve, options);
      assert.equal(state.source_pid, 11);
      assert.equal(state.codex_originator, undefined);
      const permission = buildPermissionBody({ hook_event_name: "PermissionRequest", session_id: "client", tool_name: "Bash", ...provenance }, mockResolve, options);
      assert.equal(permission.source_pid, 11);
      assert.equal(permission.codex_originator, undefined);
    });
  }

  it("accepts blank string provenance and preserves a valid explicit originator's priority", () => {
    const options = { platform: "win32", env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" } };
    const blank = buildStateBody({ hook_event_name: "Stop", session_id: "client", originator: " ", source: "" }, mockResolve, options);
    assert.equal(blank.source_pid, 22);
    assert.equal(blank.codex_originator, "Codex Desktop");
    assert.equal(isCodexDesktopSession({}, { originator: "", source: " " }, options), true);
    assert.equal(isCodexDesktopSession({ originator: 123 }, { originator: "codex_work_desktop" }, options), true);
    const explicit = buildStateBody({ hook_event_name: "Stop", session_id: "client", originator: "codex_work_desktop", source: { role: "unknown" } }, mockResolve, options);
    assert.equal(explicit.source_pid, 22);
    assert.equal(explicit.codex_originator, "codex_work_desktop");
  });

  it("honors transcript originators ahead of an inherited Desktop env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pid-originator-"));
    const transcript = path.join(dir, "session.jsonl");
    try {
      for (const [originator, expectedSource] of [["codex-tui", 11], ["unknown-client", 11], ["codex_work_desktop", 22]]) {
        fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { originator } }) + "\n");
        const body = buildStateBody({ hook_event_name: "Stop", session_id: "client", transcript_path: transcript }, mockResolve, { env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" } });
        assert.equal(body.source_pid, expectedSource);
        assert.equal(body.codex_originator, originator);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not infer Desktop from malformed or structured transcript provenance", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pid-malformed-originator-"));
    const transcript = path.join(dir, "session.jsonl");
    try {
      for (const provenance of [{ originator: 123 }, { source: { type: "exec" } }, { source: { role: "unknown" } }]) {
        fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: provenance }) + "\n");
        const body = buildStateBody({ hook_event_name: "Stop", session_id: "client", transcript_path: transcript }, mockResolve, { platform: "win32", env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" } });
        assert.equal(body.source_pid, 11);
        assert.equal(body.codex_originator, undefined);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const platform of ["darwin", "linux"]) {
    it(`keeps ${platform} env inference disabled and existing explicit Desktop preference intact`, () => {
      const options = { platform, env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" } };
      const payload = { hook_event_name: "Stop", session_id: "client" };
      const envOnly = buildStateBody(payload, mockResolve, options);
      assert.equal(envOnly.source_pid, 11);
      assert.equal(envOnly.codex_originator, undefined);
      const explicit = buildStateBody({ ...payload, originator: "codex_work_desktop" }, mockResolve, options);
      assert.equal(explicit.source_pid, 22);
      assert.equal(explicit.codex_originator, "codex_work_desktop");
    });
  }
});
