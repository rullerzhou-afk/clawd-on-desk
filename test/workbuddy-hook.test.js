const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { createSpawnedHookHarness } = require("./helpers/spawned-hook");
const {
  HOOK_MAP,
  stdoutForEvent,
  deriveSessionTitle,
  SESSION_TITLE_MAX,
  WORKBUDDY_AGENT_NAMES,
  isWorkBuddyCliCommand,
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
    const title = deriveSessionTitle("UserPromptSubmit", { prompt: long });
    assert.strictEqual(title.length, SESSION_TITLE_MAX);
    assert.ok(title.endsWith("\u2026"));
    assert.strictEqual(title, `${"x".repeat(SESSION_TITLE_MAX - 1)}\u2026`);
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
