"use strict";

// Destructive-action reminder (opt-in, off by default).
//
// The claim this feature makes is narrow: when automatic permission handling
// would have allowed an ordinary tool request by itself, a recognized
// destructive command waits for a human instead. Four properties have to hold
// for that claim to be true, and each has lanes below:
//
//   1. It can only downgrade. Never allow→deny, never ask/deny→allow, and no
//      effect at all on question answering or plan review.
//   2. It reads the request BEFORE display-preview truncation. The lane at
//      "pre-truncation" fails first against entry.toolInput, then passes against
//      the raw input, so the reason the scan input exists is visible in the test
//      rather than only in a comment.
//   3. Three outcomes, not two. A command that never matched is UNMATCHED; a
//      command that matched and is deliberately excused names its exception.
//      Collapsing those two would make "we chose not to hold --force-with-lease"
//      indistinguishable from "the matcher stopped recognizing it".
//   4. Session trust is affected deliberately, not incidentally: the predicate
//      that offers session trust is the same predicate that resolves a sweep.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  SCAN_ERROR_TAG,
  SCAN_MAX,
  buildReminderScanInput,
  evaluatePermissionReminder,
  preparePermissionReminder,
  reminderHolds,
} = require("../src/permission-reminder");
const {
  AUTOMATION_ACTION,
  PERMISSION_AUTOMATION_MODE,
  classifyPermissionInteraction,
  evaluatePermissionAutomation,
} = require("../src/permission-automation-policy");
const { truncateDeep, PREVIEW_MAX } = require("../src/server-permission-utils");
const initPermission = require("../src/permission");

const SRC = path.join(__dirname, "..", "src");

// ---------------------------------------------------------------------------
// 1. Fixture lists -- three of them, on purpose
// ---------------------------------------------------------------------------

// HOLD: automation would have allowed these on its own; the reminder stops them.
const HOLD = [
  ["force push, long flag", "git push --force origin main", "force-push"],
  ["force push, short flag", "git push -f origin main", "force-push"],
  ["remote branch delete", "git push origin --delete feature/x", "remote-delete"],
  ["local branch delete", "git branch -D release/1.2", "branch-delete"],
  ["hard reset", "git reset --hard HEAD~3", "history-rewrite"],
  ["filter-repo", "git filter-repo --path secrets --invert-paths", "history-rewrite"],
  ["bulk delete of source", "rm -rf src", "file-delete"],
  ["git clean", "git clean -fdx", "git-clean"],
  ["npm publish", "npm publish --access public", "publish"],
  ["cargo publish", "cargo publish", "publish"],
  ["repo delete", "gh repo delete acme/widgets", "repo-delete"],
  ["repo go public", "gh repo create acme/widgets --public", "go-public"],
  ["terraform destroy", "terraform destroy -auto-approve", "infra-destroy"],
  ["kubectl delete", "kubectl delete deployment api", "infra-destroy"],
  ["sql drop through a client", "psql -c 'DROP TABLE users'", "db-destroy"],
  ["wrapper does not hide it", "sudo rm -rf /etc/app", "file-delete"],
  ["later segment in a chain", "cd packages/web && npm publish", "publish"],
  ["lease AND a bare force", "git push --force-with-lease --force origin main", "force-push"],
  ["deleting one disposable dir and one that is not", "rm -rf dist src", "file-delete"],
  ["absolute path that ends in a disposable name", "rm -rf /var/tmp", "file-delete"],
  ["parent traversal", "rm -rf ../node_modules", "file-delete"],
  // A single-file delete is still a delete. Deliberately held: `rm -f .env.local`
  // is not recoverable, and the pattern cannot tell it from `rm -f build.log`.
  ["single-file delete", "rm -f package-lock.json", "file-delete"],
  // Globs that are not a disposable directory's own contents stay held.
  ["bare directory glob", "rm -rf */", "file-delete"],
  ["root glob", "rm -rf /*", "file-delete"],
  // -h is psql's HOST flag, so it must never be read as a help flag.
  ["sql drop with a host flag", "psql -h db -c 'DROP TABLE users'", "db-destroy"],
];

// UNMATCHED: the destructive words are there, but nothing destructive runs. These
// must be silent -- an automatic allow, exactly as today.
const UNMATCHED = [
  ["grep for the flag", 'grep -rn "git push --force" .', null],
  ["commit message mentioning a publish", 'git commit -m "docs: how to npm publish"', null],
  ["echoed instruction", "echo npm publish", null],
  ["escaped separator is literal", "echo docs\\; npm publish", null],
  ["plain push", "git push origin main", null],
  ["rm without -r or -f", "rm notes.txt", null],
  ["select, not drop", "psql -c 'SELECT 1'", null],
  ["drop in an echo, no db client", "echo 'DROP TABLE users'", null],
  ["reading a file", "cat package.json", null],
];

// EXCEPTION: a real match that policy deliberately does not hold. Each names the
// exception, so a matcher change that silently stops recognizing the command
// turns this into UNMATCHED and fails the lane.
const EXCEPTION = [
  ["dry-run publish", "npm publish --dry-run", "publish", "dry-run"],
  ["dry-run kubectl", "kubectl delete pod api --dry-run=client", "infra-destroy", "dry-run"],
  ["dry-run force push", "git push --force --dry-run origin main", "force-push", "dry-run"],
  ["lease-guarded force push", "git push --force-with-lease origin main", "force-push", "force-with-lease"],
  ["lease with a ref", "git push --force-with-lease=main origin main", "force-push", "force-with-lease"],
  ["disposable dir", "rm -rf node_modules", "file-delete", "disposable-path"],
  ["disposable dir, dot-slash", "rm -rf ./dist", "file-delete", "disposable-path"],
  ["disposable dir, nested", "rm -rf packages/web/node_modules", "file-delete", "disposable-path"],
  ["two disposable dirs", "rm -rf dist build", "file-delete", "disposable-path"],
  ["disposable dir, quoted", 'rm -rf "node_modules"', "file-delete", "disposable-path"],
  ["disposable dir contents", "rm -rf dist/*", "file-delete", "disposable-path"],
  ["disposable dir contents, dot-slash", "rm -rf ./node_modules/*", "file-delete", "disposable-path"],
  ["asking publish to describe itself", "npm publish --help", "publish", "help"],
  ["asking destroy to describe itself", "terraform destroy --help", "infra-destroy", "help"],
];

describe("destructive reminder — commands that hold for a human", () => {
  for (const [label, command, tag] of HOLD) {
    it(`holds: ${label}`, () => {
      const verdict = evaluatePermissionReminder("Bash", { command });
      assert.ok(verdict, `expected a verdict for: ${command}`);
      assert.equal(verdict.hold, true, command);
      assert.equal(verdict.tag, tag, command);
      assert.equal(reminderHolds(verdict), true, command);
    });
  }

  it("scans every shell tool name automation is willing to allow on its own", () => {
    // The gap this closes: execute_bash, powershell and run_shell_command are names
    // the automation policy treats as ordinary tool approvals, but the shared matcher
    // only knew about bash/shell/run_command, so a force-push sent under one of them
    // was never examined. Deriving the list from the policy's own set means the next
    // name added there fails this lane until someone reviews it.
    const policySource = fs.readFileSync(path.join(SRC, "permission-automation-policy.js"), "utf8");
    const block = policySource.match(/CLAUDE_COMPATIBLE_TOOL_APPROVAL_NAMES = new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(block, "the eligible-tool set must still be readable from the policy");
    const eligible = [...block[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    assert.ok(eligible.length > 20, "sanity: the eligible set should be large");

    const SHELLISH = /(^|_)(bash|shell|powershell|exec|cmd|command|terminal)(_|$)/;
    // Reviewed: shell-shaped names that carry no command line -- two read a running
    // shell's output, one kills a shell by id.
    const CARRIES_NO_COMMAND = new Set(["bashoutput", "bashoutputtool", "kill_shell"]);

    let scanned = 0;
    for (const name of eligible) {
      if (!SHELLISH.test(name)) continue;
      const verdict = evaluatePermissionReminder(name, { command: "git push --force origin main" });
      if (verdict && verdict.hold) { scanned += 1; continue; }
      assert.ok(
        CARRIES_NO_COMMAND.has(name),
        name + " is eligible for an automatic allow and looks like a shell tool, but its command is not scanned"
      );
    }
    assert.ok(scanned >= 6, "expected at least the six known shell tool names, got " + scanned);
  });

  it("holds an explicit delete tool, which carries no command string", () => {
    const verdict = evaluatePermissionReminder("delete_file", { path: "notes.txt" });
    assert.deepEqual(verdict, { hold: true, tag: "file-delete" });
  });
});

describe("destructive reminder — unmatched requests keep today's behavior", () => {
  for (const [label, command] of UNMATCHED) {
    it(`unmatched: ${label}`, () => {
      assert.equal(evaluatePermissionReminder("Bash", { command }), null, command);
    });
  }

  it("an argv array is a supported shape, and command position still decides", () => {
    // Joining argv is a definition, not a guess: it is the text a shell would have
    // received. Command-position anchoring survives the join, so an echoed argument
    // is still quiet.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: ["git", "push", "--force", "origin", "main"] }),
      { hold: true, tag: "force-push" }
    );
    assert.equal(evaluatePermissionReminder("Bash", { command: ["echo", "git push --force"] }), null);
  });

  it("a shape that is not a command line yields no scan input", () => {
    for (const command of [42, { cmd: "rm -rf src" }, [["rm", "-rf", "src"]], null]) {
      assert.equal(evaluatePermissionReminder("Bash", { command }), null, String(command));
    }
  });
});

describe("destructive reminder — deliberate policy exceptions name themselves", () => {
  for (const [label, command, tag, exception] of EXCEPTION) {
    it(`excused (${exception}): ${label}`, () => {
      const verdict = evaluatePermissionReminder("Bash", { command });
      assert.ok(verdict, `expected a verdict for: ${command}`);
      assert.equal(verdict.hold, false, command);
      assert.equal(verdict.tag, tag, command);
      assert.equal(verdict.exception, exception, command);
      assert.equal(reminderHolds(verdict), false, command);
    });
  }

  it("an excused match is not the same value as never having matched", () => {
    const excused = evaluatePermissionReminder("Bash", { command: "npm publish --dry-run" });
    const never = evaluatePermissionReminder("Bash", { command: "echo npm publish" });
    assert.notDeepEqual(excused, never);
    assert.equal(never, null);
  });
});

// ---------------------------------------------------------------------------
// 2. Pre-truncation input, and the inspection budget
// ---------------------------------------------------------------------------

describe("destructive reminder — reads the request before display-preview truncation", () => {
  // Long in characters, short in segments: the destructive part must be past the
  // preview cap and still inside both the character and segment budgets.
  const command = `echo ${"x".repeat(PREVIEW_MAX + 100)} && npm publish`;

  it("the display copy has already lost the destructive part (this is why the scan input exists)", () => {
    assert.ok(command.length > PREVIEW_MAX, "fixture must exceed the preview cap");
    assert.ok(command.split("&&").length <= 50, "fixture must stay inside the segment budget");
    const displayCopy = truncateDeep({ command });
    assert.ok(!displayCopy.command.includes("npm publish"),
      "truncateDeep must cut the tail -- otherwise this lane proves nothing");
    assert.equal(evaluatePermissionReminder("Bash", displayCopy), null,
      "scanning the display copy cannot see it: the fail-before half of this lane");
  });

  it("scanning the raw input still holds it", () => {
    const verdict = evaluatePermissionReminder("Bash", { command });
    assert.deepEqual(verdict, { hold: true, tag: "publish" });
  });

  it("the scan input is bounded to one command field of SCAN_MAX characters", () => {
    const huge = "x".repeat(SCAN_MAX * 4);
    const scanInput = buildReminderScanInput({ command: huge, script: huge, unrelated: huge });
    assert.deepEqual(Object.keys(scanInput), ["command"]);
    assert.equal(scanInput.command.length, SCAN_MAX);
  });

  it("beyond the budget is a documented miss, not a hidden one", () => {
    const command = `echo ${"x".repeat(SCAN_MAX + 100)} && npm publish`;
    assert.ok(command.length > SCAN_MAX);
    assert.equal(evaluatePermissionReminder("Bash", { command }), null);
  });

  it("a megabyte of input stays fast", () => {
    const command = `${"a".repeat(1024 * 1024)} && rm -rf src`;
    const started = process.hrtime.bigint();
    evaluatePermissionReminder("Bash", { command });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 250, `scan took ${elapsedMs}ms`);
  });
});

describe("destructive reminder — a scan that cannot complete ends at the human", () => {
  it("a throwing property accessor holds instead of allowing", () => {
    const verdict = evaluatePermissionReminder("Bash", {
      get command() { throw new Error("hostile getter"); },
    });
    assert.deepEqual(verdict, { hold: true, tag: SCAN_ERROR_TAG });
  });

  it("the display hint keeps the opposite direction, and they share one pattern list", () => {
    // bubble-format's wrapper must stay quiet on a surprise: a hint that throws
    // would break the bubble, which is what blocks tool execution.
    const { detectIrreversible, detectIrreversibleStrict } = require("../src/bubble-format");
    const hostile = { get command() { throw new Error("hostile getter"); } };
    assert.equal(detectIrreversible("Bash", hostile), null);
    assert.throws(() => detectIrreversibleStrict("Bash", hostile));
    assert.equal(
      fs.readFileSync(path.join(SRC, "permission-reminder.js"), "utf8").includes("detectIrreversibleStrict"),
      true,
      "the reminder must reuse the display matcher rather than carry a second pattern list"
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Downgrade-only, at the policy layer
// ---------------------------------------------------------------------------

describe("destructive reminder — the policy layer can only downgrade", () => {
  const toolApproval = classifyPermissionInteraction({ agentId: "claude-code", toolName: "Bash" });
  const question = classifyPermissionInteraction({ agentId: "claude-code", toolName: "AskUserQuestion" });
  const planReview = classifyPermissionInteraction({ agentId: "claude-code", toolName: "ExitPlanMode" });

  it("turns an automatic allow into a human decision", () => {
    for (const mode of [PERMISSION_AUTOMATION_MODE.AUTO_TOOLS, PERMISSION_AUTOMATION_MODE.UNATTENDED]) {
      assert.equal(
        evaluatePermissionAutomation({ mode, interaction: toolApproval }),
        AUTOMATION_ACTION.AUTO_ALLOW,
        mode
      );
      assert.equal(
        evaluatePermissionAutomation({ mode, interaction: toolApproval, reminderHold: true }),
        AUTOMATION_ACTION.DEFER,
        mode
      );
    }
  });

  it("never turns a deferred request into an allow", () => {
    assert.equal(
      evaluatePermissionAutomation({
        mode: PERMISSION_AUTOMATION_MODE.OFF,
        interaction: toolApproval,
        reminderHold: true,
      }),
      AUTOMATION_ACTION.DEFER
    );
    assert.equal(
      evaluatePermissionAutomation({
        mode: PERMISSION_AUTOMATION_MODE.OFF,
        interaction: toolApproval,
        reminderHold: false,
      }),
      AUTOMATION_ACTION.DEFER
    );
  });

  it("leaves question answering and plan review exactly as they were", () => {
    assert.equal(
      evaluatePermissionAutomation({
        mode: PERMISSION_AUTOMATION_MODE.UNATTENDED,
        interaction: question,
        reminderHold: true,
      }),
      AUTOMATION_ACTION.AUTO_ANSWER
    );
    assert.equal(
      evaluatePermissionAutomation({
        mode: PERMISSION_AUTOMATION_MODE.UNATTENDED,
        interaction: planReview,
        reminderHold: true,
      }),
      AUTOMATION_ACTION.AUTO_ALLOW
    );
  });

  it("callers that do not pass the flag are unaffected", () => {
    assert.equal(
      evaluatePermissionAutomation({
        mode: PERMISSION_AUTOMATION_MODE.AUTO_TOOLS,
        interaction: toolApproval,
      }),
      AUTOMATION_ACTION.AUTO_ALLOW
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The runtime: hold, session sweep, session trust, and the card reason
// ---------------------------------------------------------------------------

// A response an allow can actually be written to, so "was it consumed?" is
// observable rather than an exception from an incomplete double.
function liveResponse() {
  const captured = { statusCode: null, headers: null, body: "" };
  return {
    captured,
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    headersSent: false,
    writeHead(statusCode, headers) {
      captured.statusCode = statusCode;
      captured.headers = headers || null;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) captured.body += String(chunk);
      this.writableEnded = true;
      this.writableFinished = true;
    },
    destroy() { this.destroyed = true; },
    on() {},
    once() {},
    removeListener() {},
    emit() {},
  };
}

function makeRuntime(ctxOverrides = {}, entryOverrides = {}) {
  const ctx = {
    doNotDisturb: false,
    lang: "en",
    sessions: new Map(),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    isCodexPermissionInterceptEnabled: () => true,
    getPermissionAutomationMode: () => "auto-tools",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    sendPermissionResponse: () => {},
    win: null,
    ...ctxOverrides,
  };
  const permission = initPermission(ctx);
  const rawInput = entryOverrides.rawInput || { command: "git push --force origin main" };
  const entry = {
    res: liveResponse(),
    sessionId: "session-reminder",
    agentId: "claude-code",
    toolName: "Bash",
    toolInput: truncateDeep(rawInput),
    ...preparePermissionReminder("Bash", rawInput),
    interaction: classifyPermissionInteraction({ agentId: "claude-code", toolName: "Bash" }),
    sessionAutomationIdentity: Object.freeze({ eligible: true, reason: "eligible" }),
    ...entryOverrides,
  };
  permission.pendingPermissions.push(entry);
  return { ctx, permission, entry };
}

describe("destructive reminder — runtime behavior", () => {
  it("off: a destructive request is still allowed automatically, as today", () => {
    const { permission, entry } = makeRuntime();          // no ctx getter at all
    assert.equal(entry.permissionReminder.hold, true, "the stamp is present either way");
    // With win: null a bubble cannot be built, so reaching the window code
    // proves the entry was NOT consumed. No throw means it was.
    assert.doesNotThrow(() => permission.showPermissionBubble(entry));
    assert.equal(permission.pendingPermissions.indexOf(entry), -1);
  });

  it("off by an explicit false: same", () => {
    const { permission, entry } = makeRuntime({ isDestructiveReminderEnabled: () => false });
    assert.doesNotThrow(() => permission.showPermissionBubble(entry));
    assert.equal(permission.pendingPermissions.indexOf(entry), -1);
  });

  it("on: the request is held, and nothing was sent", () => {
    const sent = [];
    const { permission, entry } = makeRuntime({
      isDestructiveReminderEnabled: () => true,
      sendPermissionResponse: (...args) => sent.push(args),
    });
    assert.throws(() => permission.showPermissionBubble(entry));
    assert.equal(permission.pendingPermissions.indexOf(entry), 0,
      "entry must still be pending: the reminder did not consume it");
    assert.deepEqual(sent, [], "no response may be sent before a human decides");
    assert.equal(entry.res.writableEnded, false);
    assert.equal(entry.res.destroyed, false);
  });

  it("on: an ordinary request is untouched", () => {
    const { permission, entry } = makeRuntime(
      { isDestructiveReminderEnabled: () => true },
      { rawInput: { command: "npm test" } }
    );
    assert.equal(entry.permissionReminder, null);
    assert.doesNotThrow(() => permission.showPermissionBubble(entry));
    assert.equal(permission.pendingPermissions.indexOf(entry), -1);
  });

  it("on: an excused match is untouched", () => {
    const { permission, entry } = makeRuntime(
      { isDestructiveReminderEnabled: () => true },
      { rawInput: { command: "git push --force-with-lease origin main" } }
    );
    assert.equal(entry.permissionReminder.hold, false);
    assert.doesNotThrow(() => permission.showPermissionBubble(entry));
    assert.equal(permission.pendingPermissions.indexOf(entry), -1);
  });

  it("a session grant does not sweep a held request", () => {
    // This predicate IS the session sweep's gate, and -- see the source lane
    // below -- it is also how session trust is offered.
    const held = makeRuntime({ isDestructiveReminderEnabled: () => true });
    assert.equal(
      held.permission.canAutoResolvePendingPermission(held.entry, { sessionOnly: true, mode: "auto-tools" }),
      false,
      "a granted session must not release a held request"
    );
    const ordinary = makeRuntime(
      { isDestructiveReminderEnabled: () => true },
      { rawInput: { command: "npm test" } }
    );
    assert.equal(
      ordinary.permission.canAutoResolvePendingPermission(ordinary.entry, { sessionOnly: true, mode: "auto-tools" }),
      true,
      "an ordinary sibling in the same sweep still resolves"
    );
  });

  it("the session-trust offer is the same predicate, so a held card does not offer it", () => {
    const coordinator = fs.readFileSync(path.join(SRC, "session-automation-coordinator.js"), "utf8");
    assert.match(
      coordinator,
      /function canOfferSessionTrust\(entry\) \{\s*return canResolve\(entry, \{ sessionOnly: true, mode: MODE_AUTO_TOOLS \}\);/,
      "if this shape changes, the reminder's effect on the trust offer must be re-decided, not inherited"
    );
  });

  it("a held card does not offer session trust, and an ordinary one still does", () => {
    // The source lane above pins the DEFINITION; this pins the BEHAVIOR, composed
    // the way main.js composes it. Without this, changing how the payload computes
    // the flag would leave the regex green and the product changed.
    function runtimeWithTrust(rawInput) {
      const holder = {};
      const rt = makeRuntime({
        isDestructiveReminderEnabled: () => true,
        // main.js routes this through the coordinator, whose canOfferSessionTrust is
        // exactly canResolve(entry, { sessionOnly: true, mode: MODE_AUTO_TOOLS }).
        canOfferSessionTrust: (entry) => holder.permission
          .canAutoResolvePendingPermission(entry, { sessionOnly: true, mode: "auto-tools" }),
      }, rawInput ? { rawInput } : {});
      holder.permission = rt.permission;
      return rt;
    }
    const held = runtimeWithTrust(null);
    assert.equal(held.permission.buildPermissionBubblePayload(held.entry).canOfferSessionTrust, false);
    const ordinary = runtimeWithTrust({ command: "npm test" });
    assert.equal(ordinary.permission.buildPermissionBubblePayload(ordinary.entry).canOfferSessionTrust, true);
  });

  it("the no-decision path is untouched by a held entry", () => {
    const { permission, entry } = makeRuntime({ isDestructiveReminderEnabled: () => true });
    assert.throws(() => permission.showPermissionBubble(entry));      // held
    permission.resolvePermissionEntry(entry, "no-decision", "Auto-closed");
    assert.equal(permission.pendingPermissions.indexOf(entry), -1);
    assert.equal(entry.res.captured.body, "", "a no-decision must not become an allow");
    assert.equal(entry.res.captured.statusCode, null);
  });

  it("a question card never shows a reminder reason, even with the route's safety net stamped", () => {
    // The route stamps { hold: true, tag: "not-inspected" } for any entry that
    // reached it without a derived view. Elicitation entries are answered on their
    // own path, so the consult is scoped to tool approvals and that stamp must not
    // reach a question card as a reason.
    const { permission, entry } = makeRuntime({ isDestructiveReminderEnabled: () => true }, {
      toolName: "AskUserQuestion",
      interaction: classifyPermissionInteraction({
        agentId: "claude-code",
        toolName: "AskUserQuestion",
      }),
      permissionReminder: { hold: true, tag: "not-inspected" },
    });
    assert.equal(entry.interaction.intent, "human-question");
    assert.equal(permission.buildPermissionBubblePayload(entry).reminderTag, null);
  });

  it("an unreadable setting holds a match and leaves everything else alone", () => {
    const held = makeRuntime({
      isDestructiveReminderEnabled: () => { throw new Error("settings unavailable"); },
    });
    assert.throws(() => held.permission.showPermissionBubble(held.entry));
    assert.equal(held.permission.pendingPermissions.indexOf(held.entry), 0);

    const ordinary = makeRuntime(
      { isDestructiveReminderEnabled: () => { throw new Error("settings unavailable"); } },
      { rawInput: { command: "npm test" } }
    );
    assert.doesNotThrow(() => ordinary.permission.showPermissionBubble(ordinary.entry));
    assert.equal(ordinary.permission.pendingPermissions.indexOf(ordinary.entry), -1);
  });

  it("a human Allow resolves only the request it was given", () => {
    const { permission, entry } = makeRuntime({ isDestructiveReminderEnabled: () => true });
    const sibling = {
      res: liveResponse(),
      sessionId: entry.sessionId,
      agentId: "claude-code",
      toolName: "Bash",
      toolInput: truncateDeep({ command: "gh repo delete acme/widgets" }),
      ...preparePermissionReminder("Bash", { command: "gh repo delete acme/widgets" }),
      interaction: classifyPermissionInteraction({ agentId: "claude-code", toolName: "Bash" }),
      sessionAutomationIdentity: Object.freeze({ eligible: true, reason: "eligible" }),
    };
    permission.pendingPermissions.push(sibling);
    assert.equal(permission.pendingPermissions.length, 2);

    // resolvePermissionEntry is the single path every decision funnels through:
    // the card's Allow, a remote Allow, and the hotkey all reach it.
    permission.resolvePermissionEntry(entry, "allow");

    assert.equal(permission.pendingPermissions.indexOf(entry), -1, "the answered one is gone");
    assert.equal(permission.pendingPermissions.indexOf(sibling), 0, "the other stays held");
    assert.equal(sibling.res.writableEnded, false, "and was never answered");
    assert.equal(sibling.res.captured.body, "");
    assert.equal(entry.res.captured.statusCode, 200, "the answered one did get its allow");
  });

  it("the card carries the matched reason, and only when it is the reason the card exists", () => {
    const on = makeRuntime({ isDestructiveReminderEnabled: () => true });
    assert.equal(on.permission.buildPermissionBubblePayload(on.entry).reminderTag, "force-push");

    const off = makeRuntime({ isDestructiveReminderEnabled: () => false });
    assert.equal(off.permission.buildPermissionBubblePayload(off.entry).reminderTag, null);
  });

  it("with automation off the card shows no reminder reason -- it did not stop anything", () => {
    // Every request reaches a human when automation is off, so claiming the reminder
    // held this one would be false. The ordinary destructive-action hint still
    // renders there, exactly as it did before this change.
    const off = makeRuntime({
      isDestructiveReminderEnabled: () => true,
      getPermissionAutomationMode: () => "off",
    });
    assert.equal(off.entry.permissionReminder.hold, true, "the view still says hold");
    assert.equal(
      off.permission.buildPermissionBubblePayload(off.entry).reminderTag,
      null,
      "but the card must not claim the reminder is why it is here"
    );
    const on = makeRuntime({ isDestructiveReminderEnabled: () => true });
    assert.equal(on.permission.buildPermissionBubblePayload(on.entry).reminderTag, "force-push");
  });

  it("the remote card shows the same reason, so a remote-only operator is told as much", () => {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        requests.push(payload);
        return new Promise(() => {});            // never settles: we only inspect the card
      },
    };
    const on = makeRuntime({
      isDestructiveReminderEnabled: () => true,
      getTelegramApprovalClient: () => client,
    });
    assert.equal(on.permission.maybeStartRemoteApproval(on.entry), true);
    assert.equal(requests.length, 1);
    assert.match(requests[0].detail, /force-push/);
    assert.ok(
      requests[0].fields.some((field) => /force-push/.test(field.value)),
      "the reason must be a field, not only buried in the detail blob"
    );

    const off = makeRuntime({
      isDestructiveReminderEnabled: () => false,
      getTelegramApprovalClient: () => client,
    });
    assert.equal(off.permission.maybeStartRemoteApproval(off.entry), true);
    assert.doesNotMatch(requests[1].detail, /force-push/);
  });
});

// ---------------------------------------------------------------------------
// 5. Wiring: every accepted request is stamped, and the renderer reads the stamp
// ---------------------------------------------------------------------------

describe("destructive reminder — wiring", () => {
  it("the route keeps a safety net for a path that derives no view", () => {
    // Totality is asserted at runtime in test/server-route-permission.test.js
    // ("carries a view ..." x2), because a source-text count cannot see a path
    // that spreads neither helper -- which is how the remote-only path came to
    // have no reminder at all. This lane only keeps the net itself from being
    // deleted: an entry that reaches the funnel without a view must hold.
    const route = fs.readFileSync(path.join(SRC, "server-route-permission.js"), "utf8");
    assert.match(route, /permEntry\.permissionReminder === undefined/);
    assert.match(route, /permissionReminder = \{ hold: true, tag: NOT_INSPECTED_TAG \}/);
  });

  it("the renderer reads the main process's reason rather than re-deriving it", () => {
    const renderer = fs.readFileSync(path.join(SRC, "bubble-renderer.js"), "utf8");
    assert.match(renderer, /data\.reminderTag/);
    assert.match(renderer, /reminderHeldHint/);
  });

  it("the settings row carries its limits on the second description line", () => {
    // Rendered in Electron, the single-description version was 669 characters --
    // the longest blurb on the General tab by a factor of three against a 240
    // maximum. The limits moved to the descExtraKey slot the agent rows already
    // use, which keeps both lines inside the tab's own range.
    const tab = fs.readFileSync(path.join(SRC, "settings-tab-general.js"), "utf8");
    assert.match(tab, /descKey: "rowDestructiveActionReminderDesc"/);
    assert.match(tab, /descExtraKey: "rowDestructiveActionReminderNote"/);
    const i18n = fs.readFileSync(path.join(SRC, "settings-i18n.js"), "utf8");
    const count = (needle) => i18n.split(needle).length - 1;
    assert.equal(count("rowDestructiveActionReminderDesc:"), 7, "one per locale");
    assert.equal(count("rowDestructiveActionReminderNote:"), 7, "one per locale");
    for (const line of i18n.split("\n")) {
      const m = line.match(/^\s+rowDestructiveActionReminder(Desc|Note): "(.*)",$/);
      if (!m) continue;
      assert.ok(
        m[2].length <= 260,
        `${m[1]} is ${m[2].length} characters; the General tab's longest existing description is 240`
      );
    }
  });

  it("the setting exists, defaults to off, and is writable through the ordinary path", () => {
    const prefs = fs.readFileSync(path.join(SRC, "prefs.js"), "utf8");
    assert.match(prefs, /destructiveActionReminder: \{ type: "boolean", default: false \}/);
    const actions = fs.readFileSync(path.join(SRC, "settings-actions.js"), "utf8");
    assert.match(actions, /destructiveActionReminder: requireBoolean\("destructiveActionReminder"\)/);
    // Unlike the automation mode itself, this key narrows what runs unattended,
    // so it is deliberately absent from the command-only gate list.
    const ipc = fs.readFileSync(path.join(SRC, "settings-ipc.js"), "utf8");
    const gate = ipc.slice(ipc.indexOf("permission automation is gated") - 900, ipc.indexOf("permission automation is gated"));
    assert.ok(!gate.includes("destructiveActionReminder"));
  });
});
