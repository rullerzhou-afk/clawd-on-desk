"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { buildStateBody, runCodexHook } = require("../hooks/codex-hook");
const createAgentRuntimeMain = require("../src/agent-runtime-main");
const { focusProcessAppWindow } = require("../src/process-app-focus");
const { handleStatePost } = require("../src/server-route-state");
const { getSessionFocusTarget, getCodexThreadUrl, getDirectSendFocusTarget, mergeSessionFocusEntry } = require("../src/session-focus");
const { isCodexQueueTarget } = require("../src/codex-thread-id");
const { readCodexClientEphemeral, mergeCodexClientEphemeral, isPersistedCodexTranscript } = require("../src/codex-session-persistence");
const { codexClientEphemeralClaim } = require("../hooks/codex-internal-worker");
const { makeSessionKey } = require("../src/session-key");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");
const raw = "codex:aaaaaaaa-1111-4111-8111-111111111111";
const id = makeSessionKey({ profileId: "local", rawSessionId: raw });
const desktop = { id, agentId: "codex", codexOriginator: "Codex Desktop", state: "thinking" };

function harness(t, { platform = "win32", throughRuntime = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-ephemeral-focus-"));
  const prior = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  t.after(() => { if (prior === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior; fs.rmSync(home, { recursive: true, force: true }); });
  themeLoader.init(path.join(__dirname, "../src"));
  const theme = JSON.parse(JSON.stringify(themeLoader.loadTheme("clawd"))); theme.timings.minDisplay = {};
  const noop = () => {};
  const ctx = { theme, lang: "en", pendingPermissions: [], doNotDisturb: false,
    processKill: () => true, focusHostPlatform: platform, getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    playSound: noop, sendToRenderer: noop, broadcastSessionSnapshot: noop, syncHitWin: noop,
    sendToHitWin: noop, buildContextMenu: noop, buildTrayMenu: noop, getSessionAliases: () => ({}),
  };
  const state = initState(ctx);
  t.after(() => state.cleanup());
  const runtime = throughRuntime ? createAgentRuntimeMain({ getStateRuntime: () => state,
    updateSession: (...args) => state.updateSession(...args) }) : null;
  if (runtime) t.after(() => runtime.cleanup());
  const officialTurns = new Map();
  async function send(body, routeOptions = {}) {
    const req = new EventEmitter(); req.headers = {};
    const response = await new Promise(resolve => {
      const res = { writeHead(code) { this.statusCode = code; }, end() { resolve(this); } };
      handleStatePost(req, res, { ctx: { STATE_SVGS: { idle: "idle.svg", thinking: "thinking.svg", working: "working.svg" },
        pendingPermissions: [], sessions: state.sessions, isAgentEnabled: () => true,
        codexSubagentClassifier: runtime?.getCodexSubagentClassifier(),
        updateSession: runtime ? runtime.updateSessionFromServer : state.updateSession, setState: noop, permLog: noop },
        shouldDropForDnd: () => false, codexOfficialTurns: officialTurns,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: noop, droppedByDisabled: noop, droppedByDnd: noop }), ...routeOptions });
      req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end");
    });
    return response;
  }
  return { state, send, home, ctx };
}

for (const layout of [
  {name:"legacy",bundle:"/Applications/Codex.app",server:"/Applications/Codex.app/Contents/Resources/codex",gui:"/Applications/Codex.app/Contents/MacOS/Codex"},
  {name:"nested ChatGPT",bundle:"/Applications/ChatGPT.app",server:"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",gui:"/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"},
]) it(`actual Darwin ${layout.name} env-only hooks preserve metadata through runtime and dispatch verified app focus and completed HUD filtering`, async t => {
  const h = harness(t, { platform: "darwin", throughRuntime: true });
  const deliveries = [];
  // createPidResolver reads process.platform and requires child_process itself;
  // getPlatformConfig's platform option alone cannot select its Darwin walk on
  // Windows. Load the unchanged module in an isolated Darwin VM, replacing only
  // process observations. Never mutate the host platform or execute a real ps.
  const sharedPath = require.resolve("../hooks/shared-process");
  const sharedRequire = createRequire(sharedPath);
  const observations = new Map([
    [730, { ppid: 731, comm: "/bin/zsh", command: "/bin/zsh -c hook" }],
    [731, { ppid: 732, comm: layout.server, command: `${layout.server} app-server --stdio` }],
    [732, { ppid: 1, comm: layout.gui, command: layout.gui }],
    [1, { ppid: 0, comm: "/sbin/launchd", command: "/sbin/launchd" }],
  ]);
  const queries = [], metadata = [], sharedModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sharedPath, "utf8"), {
    module: sharedModule, exports: sharedModule.exports,
    process: { platform: "darwin", ppid: 730, env: {} },
    require(name) {
      if (name !== "child_process") return sharedRequire(name);
      return { execFileSync(bin, args) {
        assert.equal(bin, "ps"); assert.equal(args[0], "-o"); assert.equal(args[2], "-p");
        const observed = observations.get(Number(args[3]));
        assert.ok(observed, `unexpected process query: ${args.join(" ")}`);
        queries.push(args.join(" "));
        const field = { "ppid=": "ppid", "comm=": "comm", "command=": "command" }[args[1]];
        assert.ok(field, `unexpected ps field: ${args[1]}`);
        return `${observed[field]}\n`;
      } };
    },
  }, { filename: sharedPath });
  const shared = sharedModule.exports;
  const hookOptions = { platform: "darwin", argv: [],
    env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_work_desktop" }, resolveWslDistro: () => null,
    createPidResolver(base) {
      const resolve = shared.createPidResolver({ ...base, startPid: 730,
        platformConfig: shared.getPlatformConfig({ platform: "darwin" }) });
      return context => { const result = resolve(context); metadata.push(result); return result; };
    },
    postState(body, _options, done) {
      const wire = JSON.parse(body); deliveries.push(wire);
      h.send(wire).then(response => done(response.statusCode === 200, 23333));
    },
    readCodexAutoStartGate() { throw new Error("no cold start"); },
    runAutoStart() { throw new Error("no cold start"); },
  };
  const run = (event, extra = {}) => runCodexHook({ hook_event_name: event, session_id: raw,
    cwd: "/Users/fixture/project", turn_id: "darwin-turn", ...extra }, hookOptions);
  assert.equal((await run("SessionStart", { source: "startup" })).body, null);
  assert.equal(deliveries.length, 0);
  assert.equal(metadata[0].stablePid, 732);
  assert.equal(metadata[0].agentPid, 731);
  assert.equal(metadata[0].terminalPid, null, "the GUI is the last verified non-terminal ancestor");
  assert.deepEqual(Array.from(metadata[0].pidChain), [730, 731, 732]);
  assert.deepEqual(queries, ["-o ppid= -p 730", "-o comm= -p 730", "-o ppid= -p 731",
    "-o comm= -p 731", "-o command= -p 731", "-o ppid= -p 732", "-o comm= -p 732"]);
  assert.equal((await run("UserPromptSubmit", { prompt: "ordinary side chat" })).posted, true);
  assert.equal(deliveries[0].source_pid, 732, "Darwin preserves its ordinary GUI resolver anchor");
  assert.equal(deliveries[0].agent_pid, 731);
  assert.equal(deliveries[0].codex_originator, undefined, "do not change Desktop dedupe or automation identity");
  assert.equal(deliveries[0].codex_source, undefined);
  assert.equal(deliveries[0].transcript_path, undefined);
  const row = () => h.state.buildSessionSnapshot().sessions.find(row => row.id === id);
  assert.equal(row().codexClientEphemeral, true);
  assert.equal(row().focusTarget.type, "codex-app");
  assert.equal(row().focusTarget.url, null);
  assert.equal(row().hudHiddenByPreference, false);
  assert.equal(getDirectSendFocusTarget(row()).canFocus, false);
  assert.equal(isCodexQueueTarget({ ...row(), codexHome: "/Users/fixture/.codex" }), false);

  // Exercise main's actual dispatch body, replacing every OS effect with a fixture.
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const begin = main.indexOf("function focusDashboardSession(");
  const end = main.indexOf("function hideDashboardSession(", begin);
  assert.ok(begin >= 0 && end > begin);
  const requests = [], calls = [], pending = [];
  const context = { sessions: h.state.sessions, process: { platform: "darwin" },
    mergeSessionFocusEntry, getSessionFocusTarget, focusLog: () => {},
    focusTerminalSession: () => { throw new Error("not a terminal"); },
    focusCodexThreadTarget: () => { throw new Error("no URI restoration"); },
    focusProcessAppWindow(request) {
      requests.push(request);
      const result = focusProcessAppWindow(request, { platform: "darwin", execFile(bin, args, _options, done) {
        calls.push([bin, args]);
        done(null, bin === "ps"
          ? `731 732 Sat Oct 24 12:01:00 2026 ${layout.server}\n732 1 Sat Oct 24 12:00:00 2026 ${layout.gui}\n`
          : "");
      } });
      pending.push(result); return result;
    },
  };
  vm.createContext(context);
  vm.runInContext(main.slice(begin, end), context);
  assert.equal(context.focusDashboardSession(id), true);
  assert.equal((await Promise.all(pending))[0].submitted, true);
  assert.equal(requests[0].sourcePid, 732); assert.equal(requests[0].agentPid, 731);
  assert.deepEqual(calls.map(call => call[0]), ["ps", "ps", "/usr/bin/open"]);
  assert.deepEqual(calls[2][1], [layout.bundle], "activate the verified outer bundle, never the helper");

  await run("PostToolUse", { tool_name: "update_plan", tool_input: { plan: [
    { step: "first", status: "completed" }, { step: "second", status: "in_progress" },
  ] } });
  assert.equal(row().codexClientEphemeral, true);
  assert.deepEqual(row().planProgress, { completed: 1, total: 2, percent: 50 });
  h.ctx.sessionHudHideCompletedCodexEphemeral = true;
  assert.equal(row().hudHiddenByPreference, false, "active plan remains visible");
  await run("Stop");
  assert.equal(row().hudHiddenByPreference, true, "typed completion needs no manufactured originator");
  assert.equal(h.state.buildSessionSnapshot().hudTotalNonIdle, 0);
  assert.equal(row().focusTarget.type, "codex-app", "Dashboard keeps the live entry");
  h.ctx.pendingPermissions.push({ agentId: "codex", sessionId: id, res: null, isCodexUserInputNotify: true });
  assert.equal(row().hudHiddenByPreference, false);
  h.ctx.pendingPermissions.length = 0;
  h.ctx.sessionHudHideCompletedCodexEphemeral = false;
  assert.equal(row().hudHiddenByPreference, false);
  h.ctx.sessionHudHideCompletedCodexEphemeral = true;
  await runCodexHook({ hook_event_name: "UserPromptSubmit", session_id: raw, cwd: "/Users/fixture/project",
    turn_id: "darwin-next", prompt: "next question" }, hookOptions);
  assert.equal(row().hudHiddenByPreference, false);
});

it("Darwin inherited Desktop env does not let explicit CLI, unknown clients or child completions match the HUD preference", async t => {
  const h = harness(t, { platform: "darwin", throughRuntime: true });
  h.ctx.sessionHudHideCompletedCodexEphemeral = true;
  const cases = [{ originator: "codex-tui" }, { originator: "unknown-client" },
    { source: "cli" }, { source: "exec" }, { source: "mcp" },
    { headless: true }, { codex_session_role: "subagent" }];
  for (const [index, provenance] of cases.entries()) {
    const sid = `codex:${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const result = await runCodexHook({ hook_event_name: "Stop", session_id: sid,
      cwd: "/Users/fixture/project", ...provenance }, {
      platform: "darwin", argv: [], env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_work_desktop" },
      resolveWslDistro: () => null,
      resolvePid: () => ({ stablePid: 732, agentPid: 731, headless: provenance.headless === true }),
      postState(body, _options, done) { h.send(JSON.parse(body)).then(response => done(response.statusCode === 200, 23333)); },
    });
    assert.equal(result.posted, true);
    const row = h.state.buildSessionSnapshot().sessions.find(row => row.rawSessionId === sid);
    assert.ok(row, JSON.stringify(provenance));
    assert.equal(row.hudHiddenByPreference, false, JSON.stringify(provenance));
    if (provenance.codex_session_role === "subagent") assert.equal(row.headless, true);
  }
});

it("HUD preference follows real state completion, pending response-less questions and subsequent activity", async t => {
  const h = harness(t); h.ctx.sessionHudHideCompletedCodexEphemeral = true;
  const opts = { agentId: "codex", hookSource: "codex-official", rawSessionId: raw,
    sourcePid: 731, agentPid: 732, codexOriginator: "Codex Desktop", codexClientEphemeral: true };
  h.state.updateSession(id, "thinking", "UserPromptSubmit", opts);
  assert.equal(h.state.buildSessionSnapshot().hudTotalNonIdle, 1);
  h.state.updateSession(id, "attention", "Stop", opts);
  const completed = h.state.sessions.get(id), activity = completed.updatedAt;
  assert.equal(h.state.buildSessionSnapshot().hudTotalNonIdle, 0);
  h.ctx.pendingPermissions.push({ agentId: "codex", sessionId: id, res: null, isCodexUserInputNotify: true });
  assert.equal(h.state.buildSessionSnapshot().hudTotalNonIdle, 1);
  h.ctx.pendingPermissions.push({ agentId: "codex", sessionId: id, res: {} });
  h.ctx.pendingPermissions.shift();
  assert.equal(h.state.buildSessionSnapshot().hudTotalNonIdle, 1, "another request still protects the row");
  h.ctx.pendingPermissions.length = 0;
  assert.equal(h.state.buildSessionSnapshot().hudTotalNonIdle, 0);
  h.ctx.sessionHudHideCompletedCodexEphemeral = false;
  assert.equal(h.state.buildSessionSnapshot().hudTotalNonIdle, 1);
  assert.equal(h.state.sessions.get(id), completed); assert.equal(completed.updatedAt, activity);
  h.ctx.sessionHudHideCompletedCodexEphemeral = true;
  h.state.updateSession(id, "working", "PreToolUse", opts);
  assert.equal(h.state.buildSessionSnapshot().hudTotalNonIdle, 1);
});

it("official client-ephemeral metadata reaches a visible HUD row and selects process-only app focus", async t => {
  const h = harness(t);
  const body = buildStateBody({ hook_event_name: "UserPromptSubmit", session_id: raw, cwd: h.home },
    () => ({ stablePid: 731, agentPid: 732 }), {
      env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, platform: "win32", allowDesktopEnvOriginator: true,
    });
  assert.equal(body.codex_client_ephemeral, true);
  assert.equal((await h.send(body)).statusCode, 200);
  const row = h.state.buildSessionSnapshot().sessions.find(row => row.id === id);
  assert.equal(row.codexClientEphemeral, true);
  assert.equal(row.hiddenFromHud, false);
  assert.equal(row.focusTarget.type, "codex-app");
  assert.equal(row.focusTarget.url, null);
  assert.equal(getCodexThreadUrl(row), null);
  assert.equal(getDirectSendFocusTarget(row).canFocus, false);
  assert.equal(isCodexQueueTarget({ ...row, codexHome: "C:/synthetic-store" }, { platform: "win32" }), false);

  await h.send({ ...body, event: "Stop", state: "idle", codex_client_ephemeral: undefined });
  assert.equal(h.state.sessions.get(id).codexClientEphemeral, true, "missing late metadata cannot restore a URI");
  assert.equal(h.state.buildSessionSnapshot().sessions.find(row => row.id === id).hiddenFromHud, false);
});

it("unknown persisted first focus remains URI-based and a later persisted transcript can supersede ephemeral metadata", async t => {
  const h = harness(t);
  assert.equal(getSessionFocusTarget(desktop).type, "codex-thread");
  assert.equal(getSessionFocusTarget({ ...desktop, sourcePid: 731, codexClientEphemeral: true }, { osPlatform: "win32" }).type, "codex-app");
  assert.equal(getSessionFocusTarget({ ...desktop, codexClientEphemeral: true }).canFocus, false);
  assert.equal(getSessionFocusTarget({ ...desktop, sourcePid: 731, codexClientEphemeral: true }, { osPlatform: "linux" }).canFocus, false);
  const opts = { agentId: "codex", profileId: "local", rawSessionId: raw, hookSource: "codex-official", codexOriginator: "Codex Desktop", sourcePid: 731, codexClientEphemeral: true };
  h.state.updateSession(id, "thinking", "UserPromptSubmit", opts);
  const activity = h.state.sessions.get(id).updatedAt;
  h.state.updateCodexInitializationMetadata(id, { ...opts, codexClientEphemeral: false });
  assert.equal(h.state.sessions.get(id).codexClientEphemeral, true, "false without persistence proof cannot clear true");
  h.state.updateCodexInitializationMetadata(id, { ...opts, codexClientEphemeral: false, transcriptPath: path.join(h.home, "sessions/rollout-aaaaaaaa-1111-4111-8111-111111111111.jsonl") });
  const session = h.state.sessions.get(id);
  assert.equal(session.codexClientEphemeral, false);
  assert.equal(session.updatedAt, activity);
  assert.equal(getSessionFocusTarget({ ...session, id }).type, "codex-thread");
});

it("three saved threads and an ordinary ephemeral side chat remain visible with the same folder and process", async t => {
  const h = harness(t);
  const peers = ["bbbbbbbb", "cccccccc", "dddddddd"].map(prefix => `codex:${prefix}-1111-4111-8111-111111111111`);
  for (const peer of peers) {
    await h.send({ state: "working", event: "PreToolUse", agent_id: "codex", hook_source: "codex-official",
      session_id: peer, cwd: h.home, source_pid: 731, agent_pid: 732, codex_originator: "Codex Desktop",
      transcript_path: path.join(h.home, `sessions/rollout-${peer.slice(6)}.jsonl`), codex_client_ephemeral: false });
  }
  await h.send({ state: "thinking", event: "UserPromptSubmit", agent_id: "codex", hook_source: "codex-official",
    session_id: raw, cwd: h.home, source_pid: 731, agent_pid: 732, codex_originator: "Codex Desktop", codex_client_ephemeral: true });
  const snapshot = h.state.buildSessionSnapshot();
  assert.equal(snapshot.hudTotalNonIdle, 4);
  assert.equal(snapshot.sessions.filter(row => row.focusTarget?.type === "codex-thread").length, 3);
  assert.equal(snapshot.sessions.filter(row => row.focusTarget?.type === "codex-app").length, 1);
  assert.ok(snapshot.sessions.every(row => !row.hiddenFromHud));
});

it("typed metadata rejects wrong scopes and preserves true against unsupported clearing", async t => {
  const h = harness(t);
  for (const fields of [{ hook_source: "codex-jsonl" }, { agent_id: "claude-code" }, { host: "remote" }, { wsl_distro: "Ubuntu" }, { host: "wsl:Ubuntu" }]) {
    const body = { state: "thinking", event: "UserPromptSubmit", agent_id: "codex", hook_source: "codex-official", session_id: raw, codex_internal_thread: "ordinary", codex_client_ephemeral: true, ...fields };
    await h.send(body);
    assert.notEqual(h.state.sessions.get(id)?.codexClientEphemeral, true, JSON.stringify(fields));
  }
  for (const value of ["true", 1, {}, [], null]) assert.equal(readCodexClientEphemeral({ codex_client_ephemeral: value }, true), undefined);
  assert.equal(readCodexClientEphemeral({ codex_client_ephemeral: false }, true), undefined);
  assert.equal(readCodexClientEphemeral({ codex_client_ephemeral: true }, false), undefined);
  assert.equal(readCodexClientEphemeral({ codex_client_ephemeral: false, transcript_path: "not-a-rollout", session_id: raw }, true), undefined);
  assert.equal(mergeCodexClientEphemeral({ codexClientEphemeral: true, rawSessionId: raw }, { agentId: "codex", transcriptPath: "C:/rollout-bbbbbbbb-1111-4111-8111-111111111111.jsonl" }), true);
  assert.equal(mergeCodexClientEphemeral({ codexClientEphemeral: true }, { agentId: "codex", codexClientEphemeral: false }), true);
  assert.equal(mergeCodexClientEphemeral({ codexClientEphemeral: true, rawSessionId: raw }, { agentId: "codex", hookSource: "codex-jsonl", transcriptPath: "C:/rollout-aaaaaaaa-1111-4111-8111-111111111111.jsonl" }), true);
});

it("live persistence facts win over old permission fallbacks and CLI/pane focus stays on its existing route", () => {
  assert.equal(mergeSessionFocusEntry({ ...desktop, codexClientEphemeral: true }, { codexClientEphemeral: false }, id).codexClientEphemeral, true);
  assert.equal(mergeSessionFocusEntry({ ...desktop, codexClientEphemeral: false }, { codexClientEphemeral: true }, id).codexClientEphemeral, false);
  const current = mergeSessionFocusEntry({ ...desktop, codexClientEphemeral: true, sourcePid: 731 }, { codexClientEphemeral: false, sourcePid: 999 }, id);
  assert.equal(current.sourcePid, 731, "old permission process metadata must not replace the live app target");
  assert.equal(mergeSessionFocusEntry({ ...desktop, codexClientEphemeral: true, sourcePid: null }, { sourcePid: 999 }, id).sourcePid, null);
  assert.equal(mergeSessionFocusEntry({ ...desktop, codexClientEphemeral: true }, { orcaPaneKey: "old:leaf", sourcePid: 999 }, id).orcaPaneKey, undefined);
  assert.equal(getDirectSendFocusTarget({ ...desktop, codexOriginator: null, codexClientEphemeral: true, sourcePid: 731 }).canFocus, false);
  const cli = { ...desktop, sourcePid: 731, codexOriginator: "codex-tui" };
  assert.equal(getSessionFocusTarget(cli).type, "terminal");
  assert.equal(getDirectSendFocusTarget(cli).canFocus, true);
  assert.equal(getSessionFocusTarget({ ...desktop, codexClientEphemeral: true, sourcePid: 731, orcaPaneKey: "tab:leaf" }, { osPlatform: "win32" }).type, "terminal");
});

it("explicit CLI identity overrides inherited Desktop environment and malformed persistence cannot restore URI focus", () => {
  const env = { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" };
  assert.equal(codexClientEphemeralClaim({ originator: "codex-tui" }, { env }), undefined);
  for (const source of ["cli", "exec", "mcp"]) {
    assert.equal(codexClientEphemeralClaim({ source }, { env }), undefined);
    assert.equal(readCodexClientEphemeral({ codex_client_ephemeral: true, codex_source: source }, true), undefined);
  }
  assert.equal(readCodexClientEphemeral({ codex_client_ephemeral: true, codex_originator: "codex_cli_rs" }, true), undefined);
  const uuid = raw.slice(6), other = "bbbbbbbb-1111-4111-8111-111111111111";
  assert.equal(isPersistedCodexTranscript(`C:/sessions/rollout-${uuid}_${other}.jsonl`, raw), true);
  assert.equal(isPersistedCodexTranscript(`C:/sessions/rollout-${other}_${uuid}.jsonl`, raw), false);
  assert.equal(isPersistedCodexTranscript(`C:/sessions/rollout-${other}-${uuid}.jsonl`, raw), false);
  assert.equal(isPersistedCodexTranscript(`C:/sessions/rollout-${uuid}.jsonl\n`, raw), false);
});
