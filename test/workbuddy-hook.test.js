const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { createSpawnedHookHarness } = require("./helpers/spawned-hook");
const { loadSharedProcessWithMock } = require("./helpers/load-shared-process-with-mock");
const {
  HOOK_MAP,
  stdoutForEvent,
  deriveSessionTitle,
  SESSION_TITLE_MAX,
  WORKBUDDY_AGENT_NAMES,
  isWorkBuddyCliCommand,
  isWorkBuddyMainProcessCommand,
  getWorkBuddyPlatformConfig,
  getWorkBuddyPidResolverOptions,
} = require("../hooks/workbuddy-hook");
const { normalizePosixProcessName } = require("../hooks/shared-process");

describe("WorkBuddy hook runtime", () => {
  it("maps lifecycle events to idle / thinking / sleeping", () => {
    assert.strictEqual(HOOK_MAP.SessionStart.state, "idle");
    assert.strictEqual(HOOK_MAP.UserPromptSubmit.state, "thinking");
    assert.strictEqual(HOOK_MAP.SessionEnd.state, "sleeping");
  });

  it("maps tool-boundary events to working", () => {
    assert.strictEqual(HOOK_MAP.PreToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUse.state, "working");
  });

  it("maps Stop to attention and Notification to notification", () => {
    assert.strictEqual(HOOK_MAP.Stop.state, "attention");
    assert.strictEqual(HOOK_MAP.Notification.state, "notification");
  });

  it("returns no decision for every event so WorkBuddy keeps native control", () => {
    assert.strictEqual(stdoutForEvent("PreToolUse"), "{}");
    assert.strictEqual(stdoutForEvent("UserPromptSubmit"), "{}");
    assert.strictEqual(stdoutForEvent("Stop"), "{}");
  });
});

describe("WorkBuddy macOS process-name contract", () => {
  it("matches current and legacy normalized helpers, but not raw case or bare Electron", () => {
    const macNames = WORKBUDDY_AGENT_NAMES.mac;
    const aiHelper = normalizePosixProcessName("/Applications/WorkBuddy AI.app/Contents/Frameworks/WorkBuddy AI Helper");
    const aiRenderer = normalizePosixProcessName("/Applications/WorkBuddy AI.app/Contents/Frameworks/WorkBuddy AI Helper (Renderer)");
    const helper = normalizePosixProcessName("/Applications/WorkBuddy.app/Contents/Frameworks/WorkBuddy Helper");
    const renderer = normalizePosixProcessName("/Applications/WorkBuddy.app/Contents/Frameworks/WorkBuddy Helper (Renderer)");
    const electron = normalizePosixProcessName("/Applications/WorkBuddy AI.app/Contents/MacOS/Electron");

    assert.strictEqual(aiHelper, "workbuddy ai helper");
    assert.strictEqual(aiRenderer, "workbuddy ai helper (renderer)");
    assert.strictEqual(helper, "workbuddy helper");
    assert.strictEqual(renderer, "workbuddy helper (renderer)");
    assert.strictEqual(macNames.has(aiHelper), true);
    assert.strictEqual(macNames.has(aiRenderer), true);
    assert.strictEqual(macNames.has(helper), true);
    assert.strictEqual(macNames.has(renderer), true);
    assert.strictEqual(macNames.has("WorkBuddy AI Helper"), false, "raw mixed case must be normalized first");
    assert.strictEqual(macNames.has(electron), false, "bare Electron would false-positive on unrelated apps");
  });

  it("recognizes verified packed/unpacked per-task CLI runners", () => {
    const current = "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron /Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy --serve --session-id abc-123 --port 60000";
    const packed = "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron /Applications/WorkBuddy AI.app/Contents/Resources/app.asar/cli/bin/codebuddy --serve --session-id=abc-123";
    const legacy = "/Applications/WorkBuddy.app/Contents/MacOS/Electron /Applications/WorkBuddy.app/Contents/Resources/app.asar/cli/bin/codebuddy --serve --session-id legacy-1";

    assert.strictEqual(isWorkBuddyCliCommand(current), true);
    assert.strictEqual(isWorkBuddyCliCommand(packed), true);
    assert.strictEqual(isWorkBuddyCliCommand(legacy), true);
  });

  it("rejects main, daemon, sidecar, persistent server, and unrelated processes", () => {
    assert.strictEqual(
      isWorkBuddyCliCommand("/Applications/WorkBuddy AI.app/Contents/MacOS/Electron"),
      false,
      "the main app is not a task runner"
    );
    assert.strictEqual(
      isWorkBuddyCliCommand("/Applications/WorkBuddy AI.app/Contents/MacOS/Electron /Applications/WorkBuddy AI.app/Contents/Resources/app.asar/main/daemon-app-server-entry.js --stdio"),
      false,
      "the daemon is not a task runner"
    );
    assert.strictEqual(
      isWorkBuddyCliCommand("/Applications/WorkBuddy AI.app/Contents/MacOS/Electron /Applications/WorkBuddy AI.app/Contents/Resources/app.asar/main/sidecar-entry.js --token redacted"),
      false,
      "the sidecar is not a task runner"
    );
    assert.strictEqual(
      isWorkBuddyCliCommand("/Applications/WorkBuddy AI.app/Contents/MacOS/Electron /Applications/WorkBuddy AI.app/Contents/Resources/app.asar/cli/bin/codebuddy --serve --port 60000"),
      false,
      "the persistent server has no per-task session id"
    );
    assert.strictEqual(
      isWorkBuddyCliCommand("/usr/local/bin/node /Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy --serve --session-id fake"),
      false,
      "the signed Electron executable is required"
    );
    assert.strictEqual(
      isWorkBuddyCliCommand("/Applications/Another.app/Contents/MacOS/Electron /Applications/Another.app/Contents/Resources/app.asar/cli/bin/codebuddy --serve --session-id fake"),
      false
    );
  });
});

// issue #655: Windows WorkBuddy 5.6.2 runs each turn in a prewarmed CLI host
// that exits seconds after Stop. Every role shares the same WorkBuddy.exe, so
// agent_pid must be resolved from the command line (the long-lived GUI main
// process), not from the process name (the per-turn host).
describe("issue #655: WorkBuddy Windows agent_pid", () => {
  const WB = "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe";
  const MAIN = `"${WB}"`;
  const DAEMON = `"${WB}" "C:\\Program Files\\WorkBuddy\\resources\\app.asar\\main\\daemon-app-server-entry.js" --stdio`;
  const TURN_HOST = `"${WB}" "C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy" --prewarm --prewarm-id wb-pool-1791205819681-fed118`;
  const SIDECAR = `"${WB}" "C:\\Program Files\\WorkBuddy\\resources\\app.asar\\main\\sidecar-entry.js" --token redacted --control-pipe-uuid redacted`;
  const EDGE_SYNC = `"${WB}" "C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\resources\\extensions\\edge-sync\\server\\index.cjs"`;
  const RENDERER = `"${WB}" --type=renderer --user-data-dir="C:\\Users\\t\\AppData\\Roaming\\WorkBuddy"`;
  const RENDERER_QUOTED = `"${WB}" "--type=renderer"`;
  // 5.2.6 shape (the exact arguments were not captured; this is the inferred
  // form): a per-conversation process under the unpacked CLI with --session-id.
  const CONVERSATION = `"${WB}" "C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy" --session-id 1234-5678`;

  function snapshotJson(procs) {
    return JSON.stringify(procs.map((p) => ({
      ProcessId: p.pid,
      Name: p.name,
      ParentProcessId: p.ppid,
      CommandLine: typeof p.cmd === "string" ? p.cmd : null,
    })));
  }

  // Runs the REAL shared-process resolver over a mock Windows process snapshot,
  // built from the SAME options the hook ships (getWorkBuddyPidResolverOptions).
  function resolveWindowsChain(procs, startPid) {
    const { mod, cleanup } = loadSharedProcessWithMock({
      execFileSyncMock: () => snapshotJson(procs),
      platform: "win32",
    });
    const cfg = getWorkBuddyPlatformConfig(mod.getPlatformConfig);
    const resolve = mod.createPidResolver({
      ...getWorkBuddyPidResolverOptions(cfg, "win32"),
      startPid,
      readRuntimeIdentity: () => ({ ok: true, reason: null, port: 23333, ownerPid: process.pid }),
      env: {},
    });
    return { resolve, cleanup };
  }

  it("issue #655: classifies command lines by their app.asar script and --type= role markers", () => {
    assert.strictEqual(isWorkBuddyMainProcessCommand(MAIN), true);
    for (const cmd of [DAEMON, SIDECAR, EDGE_SYNC, TURN_HOST, RENDERER, RENDERER_QUOTED, CONVERSATION]) {
      assert.strictEqual(isWorkBuddyMainProcessCommand(cmd), false, `must not be the main process: ${cmd}`);
    }
    assert.strictEqual(isWorkBuddyMainProcessCommand(""), false);
    assert.strictEqual(isWorkBuddyMainProcessCommand(null), false);
  });

  it("issue #655: credits the GUI main process, not the per-turn host or daemon, on the 5.6.2 chain", () => {
    const { resolve, cleanup } = resolveWindowsChain([
      { pid: 10, name: "sometemp.exe", ppid: 20, cmd: null },
      { pid: 20, name: "WorkBuddy.exe", ppid: 30, cmd: TURN_HOST },
      { pid: 30, name: "WorkBuddy.exe", ppid: 40, cmd: DAEMON },
      { pid: 40, name: "WorkBuddy.exe", ppid: 50, cmd: MAIN },
      { pid: 50, name: "explorer.exe", ppid: 0, cmd: null },
    ], 10);
    try {
      const r = resolve();
      assert.strictEqual(r.agentPid, 40, "agent_pid is the long-lived main process");
      assert.notStrictEqual(r.agentPid, 20, "never the per-turn host");
      assert.notStrictEqual(r.agentPid, 30, "never the daemon");
      assert.strictEqual(r.stablePid, 40, "source_pid lands on the topmost WorkBuddy.exe");
    } finally { cleanup(); }
  });

  it("issue #655: credits the main process on the 5.2.6 conversation chain", () => {
    const { resolve, cleanup } = resolveWindowsChain([
      { pid: 10, name: "WorkBuddy.exe", ppid: 40, cmd: CONVERSATION },
      { pid: 40, name: "WorkBuddy.exe", ppid: 50, cmd: MAIN },
      { pid: 50, name: "explorer.exe", ppid: 0, cmd: null },
    ], 10);
    try {
      assert.strictEqual(resolve().agentPid, 40);
    } finally { cleanup(); }
  });

  it("issue #655: skips a quoted --type= renderer ancestor and still credits the main process", () => {
    const { resolve, cleanup } = resolveWindowsChain([
      { pid: 10, name: "WorkBuddy.exe", ppid: 40, cmd: RENDERER_QUOTED },
      { pid: 40, name: "WorkBuddy.exe", ppid: 50, cmd: MAIN },
      { pid: 50, name: "explorer.exe", ppid: 0, cmd: null },
    ], 10);
    try {
      assert.strictEqual(resolve().agentPid, 40, "the quoted helper must not become agent_pid");
    } finally { cleanup(); }
  });

  it("issue #655: never credits daemon, sidecar, edge-sync, per-turn host, renderer, or an unreadable line", () => {
    for (const cmd of [DAEMON, SIDECAR, EDGE_SYNC, TURN_HOST, RENDERER, null]) {
      const { resolve, cleanup } = resolveWindowsChain([
        { pid: 10, name: "WorkBuddy.exe", ppid: 50, cmd },
        { pid: 50, name: "explorer.exe", ppid: 0, cmd: null },
      ], 10);
      try {
        assert.strictEqual(resolve().agentPid, null, `must not credit: ${cmd}`);
      } finally { cleanup(); }
    }
  });

  it("issue #655: leaves agent_pid empty when the chain never reaches the main process", () => {
    const { resolve, cleanup } = resolveWindowsChain([
      { pid: 10, name: "sometemp.exe", ppid: 20, cmd: null },
      { pid: 20, name: "WorkBuddy.exe", ppid: 30, cmd: TURN_HOST },
      { pid: 30, name: "WorkBuddy.exe", ppid: 50, cmd: DAEMON },
      { pid: 50, name: "explorer.exe", ppid: 0, cmd: null },
    ], 10);
    try {
      assert.strictEqual(resolve().agentPid, null, "no main process means no agent_pid, not a fallback");
    } finally { cleanup(); }
  });

  it("issue #655: selects the main-process predicate on win32 and the CLI predicate elsewhere", () => {
    const cfg = {};
    assert.strictEqual(
      getWorkBuddyPidResolverOptions(cfg, "win32").agentCmdlineCheck,
      isWorkBuddyMainProcessCommand,
    );
    assert.strictEqual(
      getWorkBuddyPidResolverOptions(cfg, "darwin").agentCmdlineCheck,
      isWorkBuddyCliCommand,
    );
    assert.strictEqual(
      getWorkBuddyPidResolverOptions(cfg, "linux").agentCmdlineCheck,
      isWorkBuddyCliCommand,
    );
  });

  it("issue #655: no longer matches WorkBuddy.exe by name on Windows; it probes the command line instead", () => {
    assert.strictEqual(WORKBUDDY_AGENT_NAMES.win.has("workbuddy.exe"), false);
    const opts = getWorkBuddyPidResolverOptions({}, "win32");
    assert.ok(opts.agentCmdlineNames.has("workbuddy.exe"));
    assert.ok(opts.agentCmdlineNames.has("electron"));
  });
});

// issue #655: 5.6.x delivers UserPromptSubmit ~0.1s before SessionStart on
// every turn; without preserve_state that late idle SessionStart would flip a
// running turn back to idle.
describe("issue #655: WorkBuddy SessionStart preserve_state", () => {
  const HOOK = path.resolve(__dirname, "..", "hooks", "workbuddy-hook.js");
  let hookHarness;

  before(() => {
    hookHarness = createSpawnedHookHarness({ prefix: "wb-preserve-state-" });
  });

  after(() => hookHarness.cleanup());

  function runHook(payload) {
    return hookHarness.run({
      script: HOOK,
      payload,
      httpContract: "expect-attempt",
      // Block real process queries (e.g. `ps`): this contract is about the POST
      // body, not about the machine's live process tree.
      probeProcessSpawns: true,
      // The recorder only captures the POST body when it plays a success
      // response; without this the body would be undefined.
      env: { CLAWD_POST_RECORDER_SUCCEED: "1" },
    });
  }

  function postedStateBody(result) {
    const request = (result.attempts || []).find((a) => a.kind === "request" && a.body);
    assert.ok(request, `expected a state POST; attempts=${JSON.stringify(result.attempts)}`);
    return JSON.parse(request.body);
  }

  it("issue #655: sets preserve_state on every turn's SessionStart so a late start cannot flip a running turn to idle", () => {
    const r = runHook({ hook_event_name: "SessionStart", session_id: "wb-655", cwd: "/tmp/repo" });
    assert.strictEqual(r.status, 0, r.stderr);
    const body = postedStateBody(r);
    assert.strictEqual(body.event, "SessionStart");
    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.preserve_state, true);
  });

  it("issue #655: does not send preserve_state on UserPromptSubmit or Stop", () => {
    for (const event of ["UserPromptSubmit", "Stop"]) {
      const r = runHook({ hook_event_name: event, session_id: "wb-655", cwd: "/tmp/repo" });
      assert.strictEqual(r.status, 0, r.stderr);
      const body = postedStateBody(r);
      assert.strictEqual(body.event, event);
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(body, "preserve_state"),
        false,
        `${event} must not carry preserve_state`,
      );
    }
  });
});

describe("WorkBuddy hook session title (#648)", () => {
  it("prefers an explicit payload.session_title over the prompt", () => {
    const title = deriveSessionTitle("UserPromptSubmit", {
      session_title: "  Rename me  ",
      prompt: "ignored first line",
    });
    assert.strictEqual(title, "Rename me");
  });

  it("uses the first non-blank line of the prompt on UserPromptSubmit", () => {
    const title = deriveSessionTitle("UserPromptSubmit", {
      prompt: "\n   \nFix the login bug\nmore context here",
    });
    assert.strictEqual(title, "Fix the login bug");
  });

  it("truncates long titles to SESSION_TITLE_MAX with an ellipsis", () => {
    const long = "x".repeat(200);
    const title = deriveSessionTitle("UserPromptSubmit", { session_title: long });
    assert.strictEqual(title.length, SESSION_TITLE_MAX);
    assert.ok(title.endsWith("\u2026"));
    assert.strictEqual(title, `${"x".repeat(SESSION_TITLE_MAX - 1)}\u2026`);
    const prompt = "A longer readable prompt ".repeat(10);
    assert.strictEqual(deriveSessionTitle("UserPromptSubmit", { prompt }), `${prompt.slice(0, SESSION_TITLE_MAX - 1)}\u2026`);
  });

  it("does not expose secret-looking fallback lines, including after the truncation boundary", () => {
    assert.strictEqual(deriveSessionTitle("UserPromptSubmit", { prompt: "Check my token ghp_abcdefghijklmnopqrstuvwx" }), null);
    assert.strictEqual(deriveSessionTitle("UserPromptSubmit", { prompt: `${"Readable text ".repeat(10)}password=hidden` }), null);
  });

  it("does not derive a prompt title on non-UserPromptSubmit events", () => {
    // A prompt field on e.g. PreToolUse must not become the title — only
    // UserPromptSubmit is a high-quality source.
    assert.strictEqual(deriveSessionTitle("PreToolUse", { prompt: "not a title" }), null);
    assert.strictEqual(deriveSessionTitle("Stop", { prompt: "not a title" }), null);
  });

  it("returns null when no high-quality source exists (server falls back to cwd)", () => {
    // Crucially we do NOT fall back to cwd/session_id here: a low-quality value
    // would overwrite a good title via the server's sticky `||` chain.
    assert.strictEqual(deriveSessionTitle("UserPromptSubmit", {}), null);
    assert.strictEqual(deriveSessionTitle("UserPromptSubmit", { prompt: "   \n  " }), null);
    assert.strictEqual(deriveSessionTitle("SessionStart", { cwd: "/home/me/project" }), null);
  });
});

// A function-level assertion on stdoutForEvent() cannot see this: the filter
// lives in the async run() body, and the bug it prevents (a phantom "default"
// session + an exit-timing POST) only shows up when the REAL script consumes
// stdin and either does or does not reach out to Clawd. The Windows P0 proved
// exit-timing bugs are invisible to unit tests, so this runs the shipped hook in
// a subprocess and asserts the three things that matter: exit code, exact
// stdout bytes, and the number of outbound HTTP attempts.
describe("WorkBuddy hook session_id filter (#618 / #648) — real subprocess", () => {
  const HOOK = path.resolve(__dirname, "..", "hooks", "workbuddy-hook.js");
  let hookHarness;

  before(() => {
    hookHarness = createSpawnedHookHarness({ prefix: "wb-sessfilter-" });
  });

  after(() => hookHarness.cleanup());

  function runHook(payload, httpContract) {
    return hookHarness.run({
      script: HOOK,
      payload,
      httpContract,
    });
  }

  it("marks fallback provenance and forwards the transcript for native names", () => {
    for (const explicit of [false, true]) {
      const r = hookHarness.run({ script: HOOK, httpContract: "expect-attempt",
        env: { CLAWD_POST_RECORDER_SUCCEED: "1", CLAWD_REMOTE: "1" },
        payload: { hook_event_name: "UserPromptSubmit", session_id: "s-title", prompt: "Prompt text",
          transcript_path: "/workbuddy/projects/project/s-title.jsonl", ...(explicit ? { session_title: "Actual chat name" } : {}) } });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(r.stdout, "{}\n");
      const post = r.attempts.find((attempt) => attempt.path === "/state" && attempt.method === "POST");
      assert.ok(post, "the shipped adapter must send a real state payload");
      const body = JSON.parse(post.body);
      assert.strictEqual(body.session_title, explicit ? "Actual chat name" : "Prompt text");
      assert.strictEqual(body.session_title_from_prompt, !explicit);
      assert.strictEqual(body.transcript_path, "/workbuddy/projects/project/s-title.jsonl");
      assert.strictEqual(body.agent_id, "workbuddy");
    }
  });

  it("forwards nothing and produces no placeholder session when session_id is absent", () => {
    const r = runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "do a thing", cwd: "/tmp/repo" },
      "expect-none",
    );

    assert.strictEqual(r.status, 0, `must exit 0; stderr=${r.stderr}`);
    assert.strictEqual(r.stderr, "", "must not surface an error to WorkBuddy");
    assert.strictEqual(r.stdout, "{}\n", "UserPromptSubmit still gets a valid empty-JSON answer");
    assert.ok(Array.isArray(r.attempts), `hook did not exit cleanly — status=${r.status}, stderr=${r.stderr}`);
    assert.deepStrictEqual(r.attempts, [],
      `no session_id must mean zero contact with Clawd — got ${JSON.stringify(r.attempts)}`);
  });

  it("also short-circuits when session_id is blank / whitespace", () => {
    const r = runHook(
      { hook_event_name: "PreToolUse", session_id: "   ", cwd: "/tmp/repo" },
      "expect-none",
    );

    assert.strictEqual(r.status, 0, `must exit 0; stderr=${r.stderr}`);
    assert.strictEqual(r.stdout, "{}\n",
      "PreToolUse keeps native control even when the event is dropped");
    assert.deepStrictEqual(r.attempts, [], "blank session_id is treated as absent — zero POST");
  });

  // VACUITY GUARD. "Zero attempts" only proves the filter works if the SAME
  // hook, given a real session_id, would otherwise have reached out. Without
  // this a hook that never posts at all would pass the case above for the wrong
  // reason (the exact class of bug #681's guard was written to catch).
  it("attempts to reach Clawd when session_id IS present (so the case above is not vacuous)", () => {
    const r = runHook(
      { hook_event_name: "PreToolUse", session_id: "s-618", cwd: "/tmp/repo" },
      "expect-attempt",
    );

    assert.strictEqual(r.status, 0, `must exit 0; stderr=${r.stderr}`);
    assert.strictEqual(r.stdout, "{}\n");
    assert.ok(Array.isArray(r.attempts), `hook did not exit cleanly — stderr=${r.stderr}`);
    assert.ok(r.attempts.length >= 1,
      "a real session_id must make the hook try to contact Clawd — zero here would mean the "
      + "filter test above proves nothing");
  });
});
