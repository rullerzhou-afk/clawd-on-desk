"use strict";

const assert = require("node:assert/strict");
const { it } = require("node:test");
const { harness, uuid } = require("./helpers/codex-dual-ingress");

const MAIN_TURN = "main-turn";
const CHILD_TURN = "child-turn";
const NEXT_TURN = "next-turn";
const DESKTOP_ENV = { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" };
const AMBIENT_PROMPT = "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: /repo";
const TOOL = { tool_name: "exec_command" };

function expectRow(h, n, state, event, {
  badge = state === "idle" ? "idle" : "running",
  headless = false,
  children,
  complete = 0,
} = {}) {
  const label = `thread ${n} at ${event}`;
  const row = h.row(n);
  const snapshot = h.snapshotRow(n);
  assert.ok(row, `${label}: session row exists`);
  assert.ok(snapshot, `${label}: snapshot row exists`);
  assert.equal(row.state, state, `${label}: row state`);
  assert.equal(snapshot.badge, badge, `${label}: badge`);
  assert.equal(row.headless, headless, `${label}: row headless`);
  assert.equal(snapshot.headless, headless, `${label}: snapshot headless`);
  assert.equal(h.hudVisible(n), !headless, `${label}: HUD visibility`);
  if (!headless || children !== undefined) {
    assert.equal(h.parentCount(n), children ?? 0, `${label}: active subagent count`);
  }
  assert.equal(snapshot.lastEvent?.rawEvent, event, `${label}: last event`);
  assert.deepEqual(h.cues(), { complete, flashes: complete }, `${label}: completion cues`);
}

function expectNoRow(h, n, after) {
  const label = `thread ${n} after ${after}`;
  assert.equal(h.row(n), undefined, `${label}: no session row`);
  assert.equal(h.snapshotRow(n), undefined, `${label}: no snapshot row`);
  assert.equal(h.hudVisible(n), false, `${label}: HUD visibility`);
  assert.deepEqual(h.cues(), { complete: 0, flashes: 0 }, `${label}: completion cues`);
}

function appendDesktop(h) {
  h.append(1, "session_meta", {
    id: uuid(1), source: "vscode", originator: "Codex Desktop", thread_source: "user",
  });
}

function appendChild(h) {
  h.append(2, "session_meta", {
    id: uuid(2), source: { subagent: { thread_spawn: { parent_thread_id: uuid(1), depth: 1 } } },
    thread_source: "subagent",
  });
}

function appendEvent(h, n, type, turnId, fields = {}) {
  h.append(n, "event_msg", { type, turn_id: turnId, ...fields });
}

function appendToolCall(h, turnId = MAIN_TURN) {
  h.append(1, "response_item", {
    type: "function_call", name: TOOL.tool_name, arguments: "{}", call_id: "call-fixture", turn_id: turnId,
  });
}

function desktopHook(h, event, fields = {}) {
  return h.hook(1, event, { transcript_path: h.rollout(1), turn_id: MAIN_TURN, ...fields });
}

function childHook(h, event, fields = {}) {
  return h.hook(2, event, { transcript_path: h.rollout(2), turn_id: CHILD_TURN, ...fields });
}

async function openDesktopTurn(h, { sessionStart = false } = {}) {
  appendDesktop(h);
  h.poll();
  expectRow(h, 1, "idle", "session_meta");

  if (sessionStart) {
    await desktopHook(h, "SessionStart", { turn_id: undefined });
    expectRow(h, 1, "idle", "SessionStart");
  }

  await desktopHook(h, "UserPromptSubmit", { prompt: "Check this project." });
  expectRow(h, 1, "thinking", "UserPromptSubmit");
}

async function startDesktopWork(h) {
  await openDesktopTurn(h, { sessionStart: true });
  appendEvent(h, 1, "task_started", MAIN_TURN);
  h.poll();
  expectRow(h, 1, "thinking", "UserPromptSubmit");

  await desktopHook(h, "PreToolUse", TOOL);
  expectRow(h, 1, "working", "PreToolUse");
  await desktopHook(h, "PostToolUse", TOOL);
  expectRow(h, 1, "working", "PostToolUse");

  appendToolCall(h);
  h.poll();
  expectRow(h, 1, "working", "PostToolUse");
}

function expectChild(h, state, event, children, childOptions = {}) {
  expectRow(h, 1, "thinking", "UserPromptSubmit", { children });
  assert.equal(h.snapshotRow(1).effectiveState, children ? "juggling" : "thinking", "parent effective state");
  expectRow(h, 2, state, event, { headless: true, ...childOptions });
}

async function finishChildThroughJsonl(h) {
  await openDesktopTurn(h);
  appendChild(h);
  h.poll();
  expectChild(h, "idle", "session_meta", 0);

  appendEvent(h, 2, "task_started", CHILD_TURN);
  h.poll();
  expectChild(h, "thinking", "event_msg:task_started", 1);

  await childHook(h, "PreToolUse", TOOL);
  expectChild(h, "working", "PreToolUse", 1);
  await childHook(h, "PostToolUse", TOOL);
  expectChild(h, "working", "PostToolUse", 1);

  appendEvent(h, 2, "task_complete", CHILD_TURN);
  h.poll();
  expectChild(h, "idle", "event_msg:task_complete", 0, { badge: "done" });

  h.advance(60_000);
  h.poll();
  expectChild(h, "idle", "event_msg:task_complete", 0, { badge: "done" });
}

it("Codex dual ingress: S1 persistent desktop turn completes through the official Stop first", async t => {
  // Desktop rollout and official tool hooks open one turn; Stop precedes the JSONL completion.
  const h = harness(t);
  await startDesktopWork(h);
  assert.equal(h.sessionCount(), 1);

  await desktopHook(h, "Stop");
  expectRow(h, 1, "idle", "Stop", { badge: "done", complete: 1 });
  const completed = structuredClone(h.row(1));

  appendEvent(h, 1, "task_complete", MAIN_TURN);
  h.poll();
  expectRow(h, 1, "idle", "Stop", { badge: "done", complete: 1 });
  assert.deepEqual(h.row(1), completed, "late JSONL completion leaves the official row intact");
  assert.equal(h.sessionCount(), 1);
});

it("Codex dual ingress: S2a JSONL assistant text triggers completion cues before the official Stop", async t => {
  // The official prompt opens a tool-free turn; JSONL delivers assistant text and completion before Stop.
  const h = harness(t);
  await openDesktopTurn(h);

  appendEvent(h, 1, "task_started", MAIN_TURN);
  h.poll();
  expectRow(h, 1, "thinking", "UserPromptSubmit");

  const message = "The check passed.";
  appendEvent(h, 1, "agent_message", MAIN_TURN, { message });
  h.poll();
  expectRow(h, 1, "thinking", "UserPromptSubmit");

  appendEvent(h, 1, "task_complete", MAIN_TURN);
  h.poll();
  expectRow(h, 1, "idle", "event_msg:task_complete", { badge: "done", complete: 1 });
  assert.equal(h.snapshotRow(1).assistantLastOutput, message, "completion shows the rollout's assistant text");

  await desktopHook(h, "Stop");
  expectRow(h, 1, "idle", "event_msg:task_complete", { badge: "done", complete: 1 });
});

it("Codex dual ingress: S2b a suppressed JSONL tool update still supplies evidence for completion cues", async t => {
  // Official tools own the visible phase; the monitor records the rollout tool call and completes before Stop.
  const h = harness(t);
  await startDesktopWork(h);

  appendEvent(h, 1, "task_complete", MAIN_TURN);
  h.poll();
  // The monitor records tool use even when the runtime suppresses the working update.
  expectRow(h, 1, "idle", "event_msg:task_complete", { badge: "done", complete: 1 });

  await desktopHook(h, "Stop");
  expectRow(h, 1, "idle", "event_msg:task_complete", { badge: "done", complete: 1 });
});

it("Codex dual ingress: S2c JSONL completion without tool or text evidence shows done silently", async t => {
  // The official prompt opens the turn; JSONL only starts and completes it before the late Stop.
  const h = harness(t);
  await openDesktopTurn(h);

  appendEvent(h, 1, "task_started", MAIN_TURN);
  h.poll();
  expectRow(h, 1, "thinking", "UserPromptSubmit");

  appendEvent(h, 1, "task_complete", MAIN_TURN);
  h.poll();
  // Known gap: the badge shows done silently. Unified completion should use the same evidence for the badge and cues.
  expectRow(h, 1, "idle", "event_msg:task_complete", { badge: "done", complete: 0 });

  await desktopHook(h, "Stop");
  expectRow(h, 1, "idle", "event_msg:task_complete", { badge: "done", complete: 0 });
});

it("Codex dual ingress: S3 codex exec completes a JSONL-only tool turn", t => {
  // The exec rollout supplies metadata, start, tool use and completion without official hooks.
  const h = harness(t);
  h.append(1, "session_meta", {
    id: uuid(1), source: "exec", originator: "codex_exec", thread_source: "user",
  });
  h.poll();
  expectRow(h, 1, "idle", "session_meta");

  appendEvent(h, 1, "task_started", MAIN_TURN);
  h.poll();
  expectRow(h, 1, "thinking", "event_msg:task_started");

  appendToolCall(h);
  h.poll();
  expectRow(h, 1, "working", "response_item:function_call");

  appendEvent(h, 1, "task_complete", MAIN_TURN);
  h.poll();
  expectRow(h, 1, "idle", "event_msg:task_complete", { badge: "done", complete: 1 });
});

it("Codex dual ingress: S4 JSONL-first child completion releases the parent and settles the child idle", async t => {
  // Child rollout opens work, official tools take over its row, and JSONL finishes within the official window.
  const h = harness(t);
  await finishChildThroughJsonl(h);
});

it("Codex dual ingress: S5 late same-turn official Stop preserves the child's JSONL completion", async t => {
  // After the JSONL-first child terminal and the one-minute observation, deliver the matching Stop.
  const h = harness(t);
  await finishChildThroughJsonl(h);
  const completed = structuredClone(h.row(2));

  await childHook(h, "Stop");
  expectChild(h, "idle", "event_msg:task_complete", 0, { badge: "done" });
  assert.deepEqual(structuredClone(h.row(2)), completed, "late Stop leaves the completed child row intact");
});

it("Codex dual ingress: S4b official tool and Stop create and finish the headless child first", async t => {
  // Write the child's transcript before PreToolUse; only then poll the metadata and start, followed by Stop and JSONL completion.
  const h = harness(t);
  await openDesktopTurn(h);
  appendChild(h);
  expectNoRow(h, 2, "unpolled session_meta");
  expectRow(h, 1, "thinking", "UserPromptSubmit");

  await childHook(h, "PreToolUse", TOOL);
  expectChild(h, "working", "PreToolUse", 0);

  appendEvent(h, 2, "task_started", CHILD_TURN);
  h.poll();
  expectChild(h, "working", "PreToolUse", 1);

  await childHook(h, "Stop");
  expectChild(h, "idle", "Stop", 0, { badge: "done" });
  const completed = structuredClone(h.row(2));

  appendEvent(h, 2, "task_complete", CHILD_TURN);
  h.poll();
  expectChild(h, "idle", "Stop", 0, { badge: "done" });
  assert.deepEqual(h.row(2), completed, "late JSONL completion leaves the official child row intact");
});

it("Codex dual ingress: S6 JSONL-only Guardian stays headless and never counts as a delegated child", async t => {
  // A live parent precedes Guardian metadata, task start, assessment and completion, all from JSONL for Guardian.
  const h = harness(t);
  await openDesktopTurn(h);
  h.append(2, "session_meta", {
    id: uuid(2), parent_thread_id: uuid(1), source: { subagent: { other: "guardian" } },
    thread_source: "guardian_review", originator: "Codex Desktop",
  });
  h.poll();
  // Guardian presentation should use thread_source at JSONL ingestion once thread rules are unified.
  expectChild(h, "idle", "session_meta", 0);

  appendEvent(h, 2, "task_started", CHILD_TURN);
  h.poll();
  expectChild(h, "thinking", "event_msg:task_started", 0);

  appendEvent(h, 2, "guardian_assessment", CHILD_TURN);
  h.poll();
  expectChild(h, "working", "event_msg:guardian_assessment", 0);

  appendEvent(h, 2, "task_complete", CHILD_TURN);
  h.poll();
  expectChild(h, "idle", "event_msg:task_complete", 0, { badge: "done" });
});

it("Codex dual ingress: S7 official-only desktop side chat opens on prompt and is removed on SessionEnd", async t => {
  // No transcript: the ephemeral SessionStart posts nothing, then Prompt, Interrupt and SessionEnd post in order.
  const h = harness(t);
  const options = { env: DESKTOP_ENV };
  await h.hook(1, "SessionStart", {}, { ...options, expectPost: false });
  expectNoRow(h, 1, "ephemeral SessionStart");

  await h.hook(1, "UserPromptSubmit", { turn_id: MAIN_TURN, prompt: "Check this project." }, options);
  expectRow(h, 1, "thinking", "UserPromptSubmit");
  assert.equal(h.row(1).codexClientEphemeral, true);
  assert.equal(h.snapshotRow(1).codexClientEphemeral, true);

  await h.hook(1, "Interrupt", { turn_id: MAIN_TURN }, options);
  expectRow(h, 1, "idle", "Interrupt");
  assert.equal(h.row(1).codexClientEphemeral, true);
  assert.equal(h.snapshotRow(1).codexClientEphemeral, true);

  await h.hook(1, "SessionEnd", {}, options);
  expectNoRow(h, 1, "ephemeral SessionEnd");
});

it("Codex dual ingress: S8 ambient suppression precedes a rollout that still opens a visible row", async t => {
  // The official ambient prompt is recognized first; the same-ID rollout is synthetic.
  const h = harness(t);
  await h.hook(1, "UserPromptSubmit", { turn_id: MAIN_TURN, prompt: AMBIENT_PROMPT }, { env: DESKTOP_ENV });
  expectNoRow(h, 1, "official ambient prompt");

  appendDesktop(h);
  h.poll();
  // Unified thread rules should suppress both JSONL events for this identified ambient thread.
  expectRow(h, 1, "idle", "session_meta");

  appendEvent(h, 1, "task_started", MAIN_TURN);
  h.poll();
  expectRow(h, 1, "thinking", "event_msg:task_started");
});

it("Codex dual ingress: S8b late ambient recognition removes an existing rollout row", async t => {
  // A synthetic same-ID rollout opens first, then the official ambient prompt and a late tool hook arrive.
  const h = harness(t);
  appendDesktop(h);
  h.poll();
  expectRow(h, 1, "idle", "session_meta");

  appendEvent(h, 1, "task_started", MAIN_TURN);
  h.poll();
  expectRow(h, 1, "thinking", "event_msg:task_started");

  await h.hook(1, "UserPromptSubmit", { turn_id: MAIN_TURN, prompt: AMBIENT_PROMPT }, { env: DESKTOP_ENV });
  expectNoRow(h, 1, "late official ambient prompt");

  await h.hook(1, "PostToolUse", { turn_id: MAIN_TURN, ...TOOL }, { env: DESKTOP_ENV });
  expectNoRow(h, 1, "late official ambient PostToolUse");
});

it("Codex dual ingress: S9 official SessionEnd blocks old rollout tails and the next turn can reopen", async t => {
  // SessionEnd retires the open turn; an immediate abort and an old tool call eleven minutes later precede a fresh JSONL turn.
  const h = harness(t);
  await openDesktopTurn(h);
  await desktopHook(h, "SessionEnd", { turn_id: undefined });
  expectNoRow(h, 1, "official SessionEnd");

  appendEvent(h, 1, "turn_aborted", MAIN_TURN);
  h.poll();
  expectNoRow(h, 1, "same-turn JSONL abort");

  h.advance(11 * 60_000);
  appendToolCall(h);
  h.poll();
  expectNoRow(h, 1, "old JSONL tool call beyond the official window");

  appendEvent(h, 1, "task_started", NEXT_TURN);
  h.poll();
  expectRow(h, 1, "thinking", "event_msg:task_started");
});

it("Codex dual ingress: S9b same-turn official tool tail recreates a row after SessionEnd", async t => {
  // Synthetic sequence: an open turn receives SessionEnd before a same-turn official PreToolUse.
  const h = harness(t);
  await openDesktopTurn(h);
  await desktopHook(h, "SessionEnd", { turn_id: undefined });
  expectNoRow(h, 1, "official SessionEnd");

  await desktopHook(h, "PreToolUse", TOOL);
  // Unified teardown should keep the same-turn official tail from recreating this row.
  expectRow(h, 1, "working", "PreToolUse");
});

it("Codex dual ingress: S10 an isolated JSONL abort opens an idle row", t => {
  // The first poll sees only turn_aborted in a new rollout, with no session_meta to create a row.
  const h = harness(t);
  expectNoRow(h, 1, "monitor startup");
  appendEvent(h, 1, "turn_aborted", MAIN_TURN);
  h.poll();
  expectRow(h, 1, "idle", "event_msg:turn_aborted");
});

it("Codex dual ingress: S10b an isolated official Interrupt closes the turn without creating a row", async t => {
  // A missing row receives Interrupt, a late same-turn tool hook and finally a fresh prompt.
  const h = harness(t);
  expectNoRow(h, 1, "monitor startup");
  await h.hook(1, "Interrupt", { turn_id: MAIN_TURN });
  expectNoRow(h, 1, "orphan official Interrupt");

  await h.hook(1, "PreToolUse", { turn_id: MAIN_TURN, ...TOOL });
  expectNoRow(h, 1, "same-turn official PreToolUse");

  await h.hook(1, "UserPromptSubmit", { turn_id: NEXT_TURN, prompt: "Start a new turn." });
  expectRow(h, 1, "thinking", "UserPromptSubmit");
});
