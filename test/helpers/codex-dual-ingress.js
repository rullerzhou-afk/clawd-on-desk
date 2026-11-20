"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const CodexLogMonitor = require("../../agents/codex-log-monitor");
const { runCodexHook } = require("../../hooks/codex-hook");
const createRuntime = require("../../src/agent-runtime-main");
const { handleStatePost } = require("../../src/server-route-state");
const { isHudSession } = require("../../src/session-hud").__test;
const { resolveSessionIdentity } = require("../../src/session-key");
const createState = require("../../src/state");
const themeLoader = require("../../src/theme-loader");

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const raw = n => `codex:${uuid(n)}`;
const key = n => resolveSessionIdentity(raw(n), "local").sessionId;
const noop = () => {};
const STATE_SVGS = Object.fromEntries(
  ["idle", "thinking", "working", "attention", "sleeping", "codex-turn-end"]
    .map(state => [state, `${state}.svg`])
);

function harness(t) {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: new Date(2026, 10, 20, 12),
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-dual-ingress-"));
  const remoteEnv = ["CLAWD_REMOTE", "CLAWD_SSH_REMOTE", "CLAWD_WSL_DISTRO", "WSL_DISTRO_NAME"];
  const previousEnv = ["CODEX_HOME", ...remoteEnv].map(key => [key, process.env[key]]);
  let state;
  let runtime;
  t.after(() => {
    try {
      runtime?.cleanup();
    } finally {
      try {
        state?.cleanup();
      } finally {
        for (const [key, value] of previousEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });
  process.env.CODEX_HOME = home;
  for (const key of remoteEnv) delete process.env[key];

  const sessionDir = path.join(home, "sessions");
  themeLoader.init(path.join(__dirname, "../../src"));
  const theme = structuredClone(themeLoader.loadTheme("clawd"));
  theme.timings.minDisplay = {};
  theme.timings.autoReturn = { attention: 5, "mini-happy": 5 };
  const sounds = [];
  const flashes = [];
  const pendingPermissions = [];
  state = createState({
    theme, lang: "en", doNotDisturb: false, miniMode: false, pendingPermissions,
    t: k => k, focusHostPlatform: "darwin", processKill: () => true,
    getStaleConfig: () => ({ sessionStaleMs: 0 }),
    playSound: sound => sounds.push(sound),
    flashTaskbar: () => flashes.push(Date.now()),
    sendToRenderer: noop, syncHitWin: noop, sendToHitWin: noop,
    buildContextMenu: noop, buildTrayMenu: noop,
  });

  class Monitor extends CodexLogMonitor {
    constructor(config, callback, options) {
      super({ ...config, logConfig: { ...config.logConfig, sessionDir } }, callback, {
        ...options, now: () => Date.now(),
      });
      this._findCodexWriterPid = () => null;
    }

    start() { this._poll(); }
  }
  runtime = createRuntime({
    loadCodexLogMonitor: () => Monitor,
    now: () => Date.now(),
    getStateRuntime: () => state,
    updateSession: state.updateSession,
  });
  const monitor = runtime.startCodexLogMonitor();
  assert.ok(monitor, "Codex rollout monitor started");

  const routeOptions = {
    ctx: {
      STATE_SVGS, pendingPermissions, sessions: state.sessions,
      isAgentEnabled: () => true,
      codexSubagentClassifier: runtime.getCodexSubagentClassifier(),
      updateSession: runtime.updateSessionFromServer,
      shouldSuppressCodexArchive: runtime.shouldSuppressCodexArchive,
      setState: noop, resolvePermissionEntry: noop, permLog: noop,
    },
    shouldDropForDnd: () => false,
    codexOfficialTurns: new Map(),
    createRequestHookRecorder: () => ({
      acceptedUnlessDnd: noop, droppedByDisabled: noop, droppedByDnd: noop,
      droppedInvalidAgent: noop, droppedUnsupported: noop,
    }),
  };

  async function hook(n, event, fields = {}, { env = {}, expectPost = true } = {}) {
    const responses = [];
    await runCodexHook({ ...fields, hook_event_name: event, session_id: uuid(n) }, {
      env: { ...env, CODEX_HOME: home },
      platform: "darwin",
      resolveWslDistro: () => null,
      resolvePid: () => ({ stablePid: null, agentPid: null, pidChain: [] }),
      readCodexAutoStartGate: () => false,
      postState(body, _options, done) {
        const req = new EventEmitter();
        req.headers = {};
        let statusCode;
        let responseBody;
        const res = {
          writeHead(code) { statusCode = code; },
          end(body) { responseBody = body; },
        };
        handleStatePost(req, res, routeOptions);
        req.emit("data", Buffer.from(body));
        req.emit("end");
        responses.push({ statusCode, responseBody });
        done(statusCode === 200);
      },
    });
    assert.equal(responses.length, expectPost ? 1 : 0, `${event}: number of /state posts`);
    for (const { statusCode, responseBody } of responses) {
      assert.equal(statusCode, 200, `${event}: /state response ${responseBody}`);
    }
  }

  const date = new Date();
  const day = path.join(sessionDir, String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
  const rollout = n => path.join(day, `rollout-2026-11-20T12-00-00-${uuid(n)}.jsonl`);
  const files = new Set();
  function append(n, type, payload) {
    const file = rollout(n);
    const now = new Date();
    fs.mkdirSync(day, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ timestamp: now.toISOString(), type, payload }) + "\n");
    fs.utimesSync(file, now, now);
    files.add(file);
  }

  function advance(ms) {
    t.mock.timers.tick(ms);
    const now = new Date();
    for (const file of files) fs.utimesSync(file, now, now);
  }

  const snapshotRow = n => state.buildSessionSnapshot().sessions.find(row => row.id === key(n));
  return {
    hook, append, rollout, advance,
    poll: () => monitor._poll(),
    row: n => state.sessions.get(key(n)),
    sessionCount: () => state.sessions.size,
    snapshotRow,
    hudVisible: n => isHudSession(snapshotRow(n)),
    parentCount: n => snapshotRow(n)?.activeSubagentCount,
    cues: () => ({
      complete: sounds.filter(sound => sound === "complete").length,
      flashes: flashes.length,
    }),
  };
}

module.exports = { harness, uuid };
