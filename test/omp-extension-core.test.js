"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const core = require("../hooks/omp-extension-core");
const piCore = require("../hooks/pi-extension-core");
const { NESTED_TERMINAL_ENV } = require("../hooks/shared-process");

function makeCtx(overrides = {}) {
  return {
    hasUI: true,
    cwd: "/work/project",
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionName: () => null,
    },
    ...overrides,
  };
}

// Minimal stand-in for the OMP extension API: records handlers so a test can
// fire a lifecycle event and inspect what reached postState.
function makeOmp() {
  const handlers = new Map();
  return {
    on(name, handler) { handlers.set(name, handler); },
    handlers,
    fire(name, nativeEvent, ctx) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`no handler registered for ${name}`);
      return handler(nativeEvent, ctx);
    },
  };
}

// Deliveries are chained per session, so a post completes on a microtask
// rather than synchronously inside fire().
const flush = () => new Promise((resolve) => setImmediate(resolve));

function attachRecorder(omp, options = {}) {
  const posted = [];
  const attached = core.attach(omp, {
    postState: (payload) => { posted.push(payload); return true; },
    ...options,
  });
  return { posted, attached };
}

describe("omp-extension-core", () => {
  describe("reporting gate", () => {
    it("detects non-interactive OMP modes from argv", () => {
      assert.strictEqual(core.parseMode(["node", "omp"]), "interactive");
      assert.strictEqual(core.parseMode(["node", "omp", "-p"]), "print");
      assert.strictEqual(core.parseMode(["node", "omp", "--mode", "rpc"]), "rpc");
      assert.strictEqual(core.parseMode(["node", "omp", "--mode=json"]), "json");
    });

    it("uses ctx.hasUI when OMP provides it", () => {
      assert.strictEqual(core.shouldReport({ hasUI: true }), true);
      assert.strictEqual(core.shouldReport({ hasUI: false }), false);
    });

    it("does not report for a session without a UI", () => {
      const omp = makeOmp();
      const { posted } = attachRecorder(omp);
      omp.fire("session_start", {}, makeCtx({ hasUI: false }));
      assert.deepStrictEqual(posted, []);
    });
  });

  describe("payload", () => {
    it("builds a Clawd /state payload with OMP session and pid fields", () => {
      const payload = core.buildPayload({
        state: "working",
        event: "PreToolUse",
        ctx: makeCtx(),
        metadata: { cwd: "/work/project", sourcePid: 4242, pidChain: [1, 2, 3], editor: "cursor" },
        agentPid: 99,
        nativeEvent: { toolName: "Bash", toolCallId: "call-7" },
        env: {},
      });
      assert.strictEqual(payload.agent_id, "omp");
      assert.strictEqual(payload.hook_source, "omp-extension");
      assert.strictEqual(payload.session_id, "omp:session-1");
      assert.strictEqual(payload.cwd, "/work/project");
      assert.strictEqual(payload.agent_pid, 99);
      assert.strictEqual(payload.source_pid, 4242);
      assert.deepStrictEqual(payload.pid_chain, [1, 2, 3]);
      assert.strictEqual(payload.editor, "cursor");
      assert.strictEqual(payload.tool_name, "Bash");
      assert.strictEqual(payload.tool_use_id, "call-7");
    });

    it("falls back to a default session id when OMP metadata is unavailable", () => {
      const payload = core.buildPayload({
        state: "idle",
        event: "SessionStart",
        ctx: { hasUI: true, cwd: "/w", sessionManager: {} },
        env: {},
      });
      assert.strictEqual(payload.session_id, "omp:default");
    });

    it("carries the Orca pane key from the injected env, and vetoes an inherited one", () => {
      const base = { state: "idle", event: "SessionStart", ctx: makeCtx() };
      const owned = core.buildPayload({
        ...base,
        env: { TERM_PROGRAM: "Orca", ORCA_PANE_KEY: "win-1:pane-2" },
      });
      assert.strictEqual(owned.orca_pane_key, "win-1:pane-2");

      // A nested terminal inherited the key; the pane no longer owns the window.
      for (const key of NESTED_TERMINAL_ENV) {
        const inherited = core.buildPayload({
          ...base,
          env: { TERM_PROGRAM: "Orca", ORCA_PANE_KEY: "win-1:pane-2", [key]: "1" },
        });
        assert.strictEqual(inherited.orca_pane_key, undefined, key);
      }
    });
  });

  // Several interactive OMP sessions legitimately share one working directory.
  // Without a title Clawd falls back to the folder name and every row in the
  // list reads the same, which also makes the jump targets indistinguishable.
  describe("session titles", () => {
    it("prefers OMP's own session name", () => {
      const payload = core.buildPayload({
        state: "idle",
        event: "SessionStart",
        ctx: makeCtx({ sessionManager: {
          getSessionId: () => "s1",
          getSessionName: () => "  Rework the parser  ",
        } }),
        env: {},
      });
      assert.strictEqual(payload.session_title, "OMP · Rework the parser");
    });

    it("falls back to the working directory's basename", () => {
      assert.strictEqual(core.readSessionTitle(makeCtx({ cwd: "/work/thunderstone" })), "OMP · thunderstone");
      assert.strictEqual(core.readSessionTitle({ cwd: "" }), "OMP");
    });

    it("survives a session manager that throws", () => {
      const title = core.readSessionTitle(makeCtx({
        cwd: "/work/proj",
        sessionManager: { getSessionName: () => { throw new Error("nope"); } },
      }));
      assert.strictEqual(title, "OMP · proj");
    });
  });

  describe("lifecycle bindings", () => {
    it("registers OMP lifecycle handlers and maps them to Clawd events", async () => {
      const omp = makeOmp();
      const { posted } = attachRecorder(omp);
      const ctx = makeCtx();

      const cases = [
        ["session_start", "SessionStart", "idle"],
        ["before_agent_start", "UserPromptSubmit", "thinking"],
        ["session_before_compact", "PreCompact", "sweeping"],
        ["session_compact", "PostCompact", "attention"],
      ];
      for (const [native, event, state] of cases) {
        posted.length = 0;
        omp.fire(native, {}, ctx);
        await flush();
        assert.strictEqual(posted.length, 1, native);
        assert.strictEqual(posted[0].event, event, native);
        assert.strictEqual(posted[0].state, state, native);
      }
    });

    // The reason this core exists separately from pi-extension-core: OMP fires
    // agent_end at every agent-loop boundary, including scheduling pauses with
    // work still in flight. Binding completion to it makes Clawd play the
    // finish chime mid-turn. session_stop is the settled turn.
    it("takes completion from session_stop and never from agent_end", async () => {
      const bound = core.DEFAULT_EVENT_BINDINGS.map(([native]) => native);
      assert.ok(bound.includes("session_stop"));
      assert.ok(!bound.includes("agent_end"), "agent_end must not be a completion source");

      const omp = makeOmp();
      const { posted } = attachRecorder(omp);
      assert.ok(!omp.handlers.has("agent_end"), "no handler may be registered for agent_end");

      await omp.fire("session_stop", {}, makeCtx());
      assert.strictEqual(posted.length, 1);
      assert.strictEqual(posted[0].event, "Stop");
      assert.strictEqual(posted[0].state, "attention");
    });

    it("treats a session switch or branch as a new session start", async () => {
      for (const native of ["session_switch", "session_branch"]) {
        const omp = makeOmp();
        const { posted } = attachRecorder(omp);
        omp.fire(native, {}, makeCtx());
        await flush();
        assert.strictEqual(posted.length, 1, native);
        assert.strictEqual(posted[0].event, "SessionStart", native);
      }
    });

    it("reports mutating tool calls as state only and never asks for permission", async () => {
      const omp = makeOmp();
      const { posted } = attachRecorder(omp);
      const result = omp.fire("tool_call", { toolName: "Bash", toolCallId: "c1" }, makeCtx());
      assert.strictEqual(result, undefined, "tool_call must not return a decision");
      await flush();
      assert.strictEqual(posted.length, 1);
      assert.strictEqual(posted[0].event, "PreToolUse");
      assert.strictEqual(posted[0].state, "working");
    });

    it("maps tool_result errors separately from successful tool results", async () => {
      const omp = makeOmp();
      const { posted } = attachRecorder(omp);
      const ctx = makeCtx();

      omp.fire("tool_result", { isError: false, toolName: "Read" }, ctx);
      await flush();
      assert.strictEqual(posted.at(-1).event, "PostToolUse");
      assert.strictEqual(posted.at(-1).state, "working");

      await omp.fire("tool_result", { isError: true, toolName: "Bash" }, ctx);
      assert.strictEqual(posted.at(-1).event, "PostToolUseFailure");
      assert.strictEqual(posted.at(-1).state, "error");
    });

    it("does not block OMP tools if state reporting fails", () => {
      const omp = makeOmp();
      core.attach(omp, { postState: () => { throw new Error("clawd is down"); } });
      assert.doesNotThrow(() => omp.fire("tool_call", { toolName: "Bash" }, makeCtx()));
      assert.doesNotThrow(() => omp.fire("session_start", {}, makeCtx()));
    });
  });

  // session_switch / session_branch move the terminal to another conversation
  // with no shutdown for the one being left behind.
  describe("retiring the session that was switched away from", () => {
    it("emits a synthetic SessionEnd for the previous session", async () => {
      const omp = makeOmp();
      const { posted } = attachRecorder(omp);

      omp.fire("session_start", {}, makeCtx({ sessionManager: { getSessionId: () => "first" } }));
      await flush();
      posted.length = 0;
      omp.fire("session_switch", {}, makeCtx({ sessionManager: { getSessionId: () => "second" } }));
      await flush();

      assert.strictEqual(posted.length, 2, "the old session is retired before the new one starts");
      assert.strictEqual(posted[0].session_id, "omp:first");
      assert.strictEqual(posted[0].event, "SessionEnd");
      assert.strictEqual(posted[0].state, "sleeping");
      assert.strictEqual(posted[1].session_id, "omp:second");
      assert.strictEqual(posted[1].event, "SessionStart");
    });

    it("does not retire anything when the session is unchanged", async () => {
      const omp = makeOmp();
      const { posted } = attachRecorder(omp);
      omp.fire("session_start", {}, makeCtx());
      omp.fire("before_agent_start", {}, makeCtx());
      await flush();
      assert.deepStrictEqual(posted.map((p) => p.event), ["SessionStart", "UserPromptSubmit"]);
    });

    it("does not follow a real shutdown with a synthetic one", async () => {
      const omp = makeOmp();
      const { posted } = attachRecorder(omp);
      omp.fire("session_start", {}, makeCtx());
      await omp.fire("session_shutdown", {}, makeCtx());
      posted.length = 0;

      omp.fire("session_start", {}, makeCtx({ sessionManager: { getSessionId: () => "next" } }));
      await flush();
      assert.strictEqual(posted.length, 1, "a shut-down session must not be retired twice");
      assert.strictEqual(posted[0].event, "SessionStart");
    });
  });

  describe("delivery", () => {
    it("preserves per-session ordering for awaited posts", async () => {
      const omp = makeOmp();
      const order = [];
      core.attach(omp, {
        postState: (payload) => new Promise((resolve) => {
          const delay = payload.event === "UserPromptSubmit" ? 20 : 0;
          setTimeout(() => { order.push(payload.event); resolve(true); }, delay);
        }),
      });
      const ctx = makeCtx();
      omp.fire("before_agent_start", {}, ctx);
      await omp.fire("session_stop", {}, ctx);
      assert.deepStrictEqual(order, ["UserPromptSubmit", "Stop"]);
    });

    // A switch retires the session being left on that session's own chain.
    // Awaiting only the shutting-down session's chain lets a shutdown resolve —
    // and the process exit — while the retirement is still queued behind a slow
    // post on the other chain, so Clawd keeps a live row for a conversation
    // nothing will ever report on again.
    it("drains the other session's tail before a shutdown resolves", async () => {
      const omp = makeOmp();
      const order = [];
      let releaseRetirement = null;
      core.attach(omp, {
        postState: (payload) => {
          if (payload.event === "SessionEnd" && payload.session_id === "omp:first") {
            return new Promise((resolve) => {
              releaseRetirement = () => { order.push(payload.event); resolve(true); };
            });
          }
          order.push(payload.event);
          return true;
        },
      });

      const first = makeCtx({ sessionManager: { getSessionId: () => "first" } });
      const second = makeCtx({ sessionManager: { getSessionId: () => "second" } });
      omp.fire("session_start", {}, first);
      await flush();
      omp.fire("session_switch", {}, second);
      await flush();
      assert.strictEqual(typeof releaseRetirement, "function", "the retirement must still be in flight");

      let shutdownSettled = false;
      const shutdown = omp.fire("session_shutdown", {}, second).then(() => { shutdownSettled = true; });
      await flush();
      assert.strictEqual(shutdownSettled, false, "shutdown must not resolve while another chain is still owed");

      releaseRetirement();
      await shutdown;
      assert.deepStrictEqual(order, ["SessionStart", "SessionStart", "SessionEnd", "SessionEnd"]);
    });
  });

  // The two cores solve the same problem for forks of the same agent. Keeping
  // the shared surface identical is what makes the diff between them readable.
  describe("parity with pi-extension-core", () => {
    it("exposes the same shared API", () => {
      const shared = ["attach", "buildPayload", "isInteractiveMode", "parseMode", "shouldReport"];
      for (const key of shared) {
        assert.strictEqual(typeof core[key], typeof piCore[key], key);
      }
      assert.strictEqual(core.OMP_AGENT_ID, "omp");
      assert.strictEqual(piCore.PI_AGENT_ID, "pi");
    });

    it("namespaces its session ids away from Pi's", () => {
      const ctx = makeCtx();
      const ompPayload = core.buildPayload({ state: "idle", event: "SessionStart", ctx, env: {} });
      const piPayload = piCore.buildPayload({ state: "idle", event: "SessionStart", ctx, env: {} });
      assert.notStrictEqual(ompPayload.session_id, piPayload.session_id);
      assert.ok(ompPayload.session_id.startsWith("omp:"));
    });
  });
});
