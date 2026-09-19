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
//   5. An exception covers the decision it was written for, not the request it
//      appeared in. `npm publish --dry-run && rm -rf /` is two decisions, and
//      the excused one does not speak for the other.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  SCAN_ERROR_TAG,
  SCAN_MAX,
  ARGV_MAX,
  buildReminderScanInput,
  evaluatePermissionReminder,
  preparePermissionReminder,
  reminderHolds,
  joinArgvBounded,
} = require("../src/permission-reminder");
const {
  AUTOMATION_ACTION,
  PERMISSION_AUTOMATION_MODE,
  classifyPermissionInteraction,
  evaluatePermissionAutomation,
} = require("../src/permission-automation-policy");
const { truncateDeep, PREVIEW_MAX } = require("../src/server-permission-utils");
const initPermission = require("../src/permission");
const { formatReminderReason } = require("../src/bubble-format");
const { createSessionAutomationStore } = require("../src/session-automation-store");
const { createSessionAutomationCoordinator } = require("../src/session-automation-coordinator");

const SRC = path.join(__dirname, "..", "src");
const EN_FORCE_PUSH_REASON = formatReminderReason("force-push", "en");

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

// KNOWN_MISS: distinct from UNMATCHED on purpose. UNMATCHED means "nothing
// destructive runs here, so silence is correct." These commands ARE
// destructive, but the matcher misses them anyway, because
// IRREVERSIBLE_PATTERNS (bubble-format.js) is Unix-shaped only and has no
// PowerShell/cmd-native rule. #1021 review (6): `powershell` was added to
// SHELL_TOOLS so a PowerShell-shaped request is now SCANNED, which reads as
// "PowerShell coverage" unless the boundary is pinned explicitly -- these
// lanes are that pin. A future PR that adds real PowerShell/cmd patterns
// should MOVE these into HOLD, not delete them: the failure mode this list
// exists to catch is the coverage claim growing back silently while the
// matcher stays the same.
const KNOWN_MISS = [
  ["powershell delete, canonical cmdlet", "powershell", "Remove-Item -Recurse -Force C:\\repo\\src"],
  ["powershell delete, flags reordered", "powershell", "Remove-Item C:\\repo\\src -Recurse -Force"],
  ["cmd.exe recursive delete", "bash", "cmd /c rmdir /s /q C:\\repo\\src"],
  ["cmd.exe file delete", "shell", "del /f /q C:\\repo\\src\\secret.txt"],
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
  ["asking cargo publish to describe itself", "cargo publish --help", "publish", "help"],
  ["asking kubectl delete to describe itself", "kubectl delete pod api --help", "infra-destroy", "help"],
  ["asking a force push to describe itself", "git push --force --help", "force-push", "help"],
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

  it("a present command field with an unreadable shape fails closed", () => {
    for (const command of [42, { cmd: "rm -rf src" }, null]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: true, tag: SCAN_ERROR_TAG },
        String(command)
      );
    }
    assert.throws(
      () => buildReminderScanInput({ command: 42, script: "rm -rf /etc" }),
      /unsupported command field/,
      "an unreadable higher-priority key must fail closed instead of falling through"
    );
  });

  it("does not treat an unrelated non-shell command field as a failed shell scan", () => {
    for (const toolName of ["Read", "mcp__example__run", "unknown_tool"]) {
      assert.equal(evaluatePermissionReminder(toolName, { command: { nested: true } }), null, toolName);
    }
    assert.deepEqual(
      evaluatePermissionReminder("delete_file", { command: null }),
      { hold: true, tag: "file-delete" },
      "an explicit destructive tool is classified by its tool identity, not an unrelated field shape"
    );
  });

  it("a malformed argv fails closed from its first inspected element", () => {
    for (const command of [
      [["rm", "-rf", "src"]],
      [5, "&&", "rm", "-rf", "/etc"],
    ]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: true, tag: SCAN_ERROR_TAG }
      );
    }
  });
});

describe("destructive reminder — known misses: PowerShell/cmd is scanned but not recognized (#1021 review 6)", () => {
  for (const [label, tool, command] of KNOWN_MISS) {
    it(`known miss: ${label}`, () => {
      // Pinned as a MISS, not asserted as correct: this documents the
      // boundary (best-effort, Unix-shaped patterns only) rather than
      // claiming Windows destructive-command coverage. If this ever starts
      // returning a real verdict, move the case to HOLD above -- do not
      // just update this assertion to expect a match, or the record of what
      // changed and why is lost.
      assert.equal(evaluatePermissionReminder(tool, { command }), null, command);
    });
  }

  it("control: the SAME destructive intent, expressed as a Unix command under the same PowerShell tool name, IS caught", () => {
    // Isolates the miss to PATTERN SHAPE, not to the `powershell` tool name:
    // powershell is scanned like any other SHELL_TOOLS entry (that is the
    // point of #1021 review's own fix), it just has no rule for its OWN
    // native syntax.
    assert.deepEqual(
      evaluatePermissionReminder("powershell", { command: "git push --force origin main" }),
      { hold: true, tag: "force-push" }
    );
  });

  it("an accidental match is not the same thing as real PowerShell coverage", () => {
    // `rm -Recurse -Force` is the PowerShell "rm" ALIAS for Remove-Item,
    // written with PowerShell-style flag names. It matches file-delete's
    // Unix regex (/^rm\s+-[a-zA-Z]*[rf]/) purely because "Recurse" happens to
    // contain a lowercase "r" for [a-zA-Z]*[rf] to backtrack onto -- not
    // because any pattern here understands PowerShell flags. Pinned so a
    // reader does not mistake this coincidence for intentional coverage: the
    // canonical cmdlet form above (Remove-Item -Recurse -Force, no "rm"
    // alias) gets no such accident and is a clean miss.
    const verdict = evaluatePermissionReminder("powershell", { command: "rm -Recurse -Force C:\\repo\\src" });
    assert.deepEqual(verdict, { hold: true, tag: "file-delete" },
      "matches today, by accident of spelling -- not a claim that this is designed PowerShell support");
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
// 1-b. An exception covers its own decision, not the request it appeared in
// ---------------------------------------------------------------------------

// Every row in EXCEPTION above carries exactly one effective destructive
// decision. That is why none of them could see this class: an exception
// evaluated against the first match only had become an exception for the whole
// request, and the command that rode through is one the matcher recognizes
// perfectly well on its own -- `rm -rf /` is held when it stands alone. A miss
// would be a matcher gap; this was a composition gap, and the fixtures could
// not express it.
const COMPOSED_HOLDS = [
  ["an excused publish, then a root delete", "npm publish --dry-run && rm -rf /", "file-delete"],
  ["an excused disposable delete, then a force push", "rm -rf node_modules; git push --force origin main", "force-push"],
  ["an excused lease push, then a hard reset", "git push --force-with-lease && git reset --hard HEAD^", "history-rewrite"],
  ["an excused help, then a publish", "terraform destroy --help ; npm publish", "publish"],
  ["an excused help, then a repo delete", "npm publish --help && gh repo delete me/repo", "repo-delete"],
  ["an excused disposable delete, then an absolute one", "rm -rf dist/* && rm -rf /etc", "file-delete"],
  ["an excused kubectl dry run, then a real one", "kubectl delete --dry-run=client po x && kubectl delete ns prod", "infra-destroy"],
  // Same segment, not a later one: the pattern loop stopped at its first hit
  // too, so the remote-delete inside a lease-guarded push was never reached.
  ["a lease-guarded push that also deletes the remote branch", "git push --force-with-lease --delete origin main", "remote-delete"],
];

// The other direction, which is the one that decides whether this is a fix or
// just a wider net: a request whose decisions are ALL excused still passes.
// Holding these would teach people to click through, which is the failure this
// feature is trying not to cause.
const COMPOSED_EXCUSED = [
  ["two dry runs", "npm publish --dry-run && npm publish --dry-run", "publish", "dry-run"],
  ["two disposable deletes", "rm -rf dist && rm -rf build", "file-delete", "disposable-path"],
];

describe("destructive reminder — one excused decision does not excuse the request", () => {
  for (const [label, command, tag] of COMPOSED_HOLDS) {
    it(`holds: ${label}`, () => {
      const verdict = evaluatePermissionReminder("Bash", { command });
      assert.deepEqual(verdict, { hold: true, tag }, command);
      assert.equal(reminderHolds(verdict), true, command);
    });
  }

  for (const [label, command, tag, exception] of COMPOSED_EXCUSED) {
    it(`still excused: ${label}`, () => {
      const verdict = evaluatePermissionReminder("Bash", { command });
      assert.deepEqual(verdict, { hold: false, tag, exception }, command);
    });
  }

  it("the command that rides through is one the matcher holds on its own", () => {
    // Without this pair the lane above could pass because the matcher stopped
    // recognizing `rm -rf /`, which is a different defect with the same colour.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "rm -rf /" }),
      { hold: true, tag: "file-delete" }
    );
  });
});

// ---------------------------------------------------------------------------
// 1-c. --dry-run is excused by what it MEANS, not by having a value
// ---------------------------------------------------------------------------

// `--dry-run=none` is kubectl's way of spelling out "actually do it", so a
// matcher that accepts any value after `=` turned the most explicit statement
// of intent into the exception that waved it through. Unknown values are not
// assumed harmless either: this exception is shared across commands, so a value
// it cannot vouch for fails closed.
const DRY_RUN_EXECUTES = [
  ["none disables kubectl's dry run", "kubectl delete namespace prod --dry-run=none", "infra-destroy"],
  ["false", "kubectl delete namespace prod --dry-run=false", "infra-destroy"],
  ["zero", "kubectl delete namespace prod --dry-run=0", "infra-destroy"],
  ["an unknown value is not assumed to be non-executing", "kubectl delete namespace prod --dry-run=bogus", "infra-destroy"],
  ["an empty value", "kubectl delete namespace prod --dry-run=", "infra-destroy"],
  ["a non-executing value does not cover an executing one beside it", "kubectl delete ns prod --dry-run=client --dry-run=none", "infra-destroy"],
  ["kubectl's missing dry-run value is not positively allow-listed", "kubectl delete namespace prod --dry-run", "infra-destroy"],
];

const DRY_RUN_PERFORMS_NOTHING = [
  ["the bare flag", "npm publish --dry-run", "publish"],
  ["pnpm", "pnpm publish --dry-run", "publish"],
  ["yarn", "yarn publish --dry-run", "publish"],
  ["cargo", "cargo publish --dry-run", "publish"],
  ["npm after an ordinary value option", "npm publish --access public --dry-run", "publish"],
  ["kubectl client-side", "kubectl delete po x --dry-run=client", "infra-destroy"],
  ["kubectl after an ordinary value option", "kubectl delete -f prod.yaml --dry-run=client", "infra-destroy"],
  ["kubectl server-side", "kubectl delete po x --dry-run=server", "infra-destroy"],
  ["git after an ordinary value option", "git push --push-option ci.skip --dry-run origin main --force", "force-push"],
];

// A bare `--` ends option parsing: what follows is a positional argument, or an
// argument list bound for something else. `npm publish -- --dry-run` publishes.
const AFTER_OPTION_TERMINATOR = [
  ["a dry-run token after -- is not this command's flag", "npm publish -- --dry-run", "publish"],
  ["and neither is a help token", "gh repo delete me/repo -- --help", "repo-delete"],
];

describe("destructive reminder — a dry run has to actually perform nothing", () => {
  it("npm's boolean spelling is non-executing too", () => {
    // `dry-run` is a boolean config; `--dry-run=true` performs nothing, so an
    // allow-list of only bare/client/server held a real dry run.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "npm publish --dry-run=true" }),
      { hold: false, tag: "publish", exception: "dry-run" }
    );
    // The pair that keeps that from becoming "accept anything truthy-looking":
    // a value we cannot name still fails closed.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "npm publish --dry-run=yes" }),
      { hold: true, tag: "publish" }
    );
  });

  for (const [label, command, tag] of DRY_RUN_EXECUTES) {
    it(`holds: ${label}`, () => {
      assert.deepEqual(evaluatePermissionReminder("Bash", { command }), { hold: true, tag }, command);
    });
  }

  for (const [label, command, tag] of DRY_RUN_PERFORMS_NOTHING) {
    it(`still excused: ${label}`, () => {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: false, tag, exception: "dry-run" },
        command
      );
    });
  }

  for (const [label, command, tag] of AFTER_OPTION_TERMINATOR) {
    it(`holds: ${label}`, () => {
      assert.deepEqual(evaluatePermissionReminder("Bash", { command }), { hold: true, tag }, command);
    });
  }
});

// ---------------------------------------------------------------------------
// 1-d. An option is read from argv, not from the raw text
// ---------------------------------------------------------------------------

// The shell removes quoting before a program sees its arguments, so the same
// four characters are an option in one spelling and data in another. A matcher
// reading raw text is wrong in BOTH directions, and both directions are here:
// it excused real destruction, and it held ordinary shell. The second half is
// not cosmetic -- a reminder that fires on `npm publish "--dry-run"` is a
// reminder people learn to click through.
const QUOTING_HOLDS = [
  // A wholly quoted flag NAME is held — see the bare-name lane for why, and for
  // the control that keeps a quoted VALUE working.
  ["a wholly quoted flag name is not a flag this command acts on", 'npm publish "--dry-run"', "publish"],
  ["a quoted end-of-options marker still ends options", "rm -rf src '--' --dry-run", "file-delete"],
  ["an escaped one does too", "rm -rf src \\-- --dry-run", "file-delete"],
  ["and the same for --help", "rm -rf src '--' --help", "file-delete"],
  ["a flag inside a quoted SQL string is data, not an option", 'psql -c "DROP TABLE users; --dry-run "', "db-destroy"],
  ["a quoted bare force is still a bare force", 'git push --force-with-lease "--force" origin main', "force-push"],
  ["an escaped one is too", "git push --force-with-lease \\--force origin main", "force-push"],
];

const QUOTING_EXCUSED = [
  ["a quoted VALUE is still that value", 'kubectl delete pod api --dry-run="client"', "infra-destroy", "dry-run"],
  ["a -- inside a quoted path does not end options", 'npm publish "./foo -- bar" --dry-run', "publish", "dry-run"],
];

describe("destructive reminder — an option is argv, not text", () => {
  for (const [label, command, tag] of QUOTING_HOLDS) {
    it(`holds: ${label}`, () => {
      assert.deepEqual(evaluatePermissionReminder("Bash", { command }), { hold: true, tag }, command);
    });
  }
  for (const [label, command, tag, exception] of QUOTING_EXCUSED) {
    it(`still excused: ${label}`, () => {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: false, tag, exception },
        command
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 1-e. A lone `&` separates commands
// ---------------------------------------------------------------------------

describe("destructive reminder — shell context decides whether a word is a command", () => {
  it("a flag's NAME must be written bare", () => {
    // `-c` takes its argument as SQL, so the quoted word is DATA and the DROP
    // runs; reading it as a flag excused a real destructive command. What tells
    // that apart from a genuine flag is not quoting but WHERE the quoting
    // starts: here the whole name is quoted, so it is not a flag at all.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "psql -c '--dry-run' -c 'DROP TABLE t'" }),
      { hold: true, tag: "db-destroy" }
    );
    // A here-string operand is likewise data, not an option.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "psql -c 'DROP TABLE t' <<< '--dry-run'" }),
      { hold: true, tag: "db-destroy" }
    );
    // The control that keeps this from swallowing real flags: the NAME is bare
    // and only the VALUE is quoted, which is an ordinary invocation.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: 'kubectl delete pod api --dry-run="client"' }),
      { hold: false, tag: "infra-destroy", exception: "dry-run" }
    );
    // DECLARED consequence: a wholly quoted flag name is held. That matches the
    // behaviour before this change -- the old regex needed whitespace in front
    // of the flag and a quote is not whitespace -- so it is a pre-existing
    // over-block left standing, in the safe direction, not a regression.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: 'npm publish "--dry-run"' }),
      { hold: true, tag: "publish" }
    );
  });

  it("a redirection operand is removed before the option terminator is found", () => {
    // In `npm publish > -- --dry-run` the `--` is the redirection's FILE NAME.
    // Searching for the terminator first truncated the command at a filename and
    // lost the flag that actually applies.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "npm publish > -- --dry-run" }),
      { hold: false, tag: "publish", exception: "dry-run" }
    );
  });

  it("quoting removes an operator but not an argument", () => {
    // These read quoting in OPPOSITE directions, which is why the tokens carry
    // whether they were bare. `>` is syntax: quote it and it is just a word, so
    // the --dry-run after it is still npm's option. `--` is an argument the
    // program interprets, so quoting it does NOT stop it ending the options.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: 'npm publish ">" --dry-run' }),
      { hold: false, tag: "publish", exception: "dry-run" }
    );
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "npm publish \\> --dry-run" }),
      { hold: false, tag: "publish", exception: "dry-run" }
    );
    // A wholly quoted flag NAME is a separate question and is held -- see the
    // bare-name lane. Only the operator/argument distinction is tested here.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "rm -rf src '--' --dry-run" }),
      { hold: true, tag: "file-delete" }
    );
  });

  it("a redirection target is a file name, not an option", () => {
    // `rm -rf ./d > "--dry-run"` writes a file called --dry-run and deletes for
    // real. Reading tokens is what made this reachable: the old regex could not
    // see the quoted spelling at all, so the operand has to be dropped.
    for (const command of [
      'rm -rf ./d > "--dry-run"',
      'rm -rf ./d > "--help"',
      'rm -rf ./d 2> "--dry-run"',
      'rm -rf ./d >> "--dry-run"',
    ]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: true, tag: "file-delete" },
        command
      );
    }
    // The control that keeps the rule from swallowing real exceptions: a genuine
    // dry run whose output happens to be redirected is still excused.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "npm publish --dry-run > out.txt" }),
      { hold: false, tag: "publish", exception: "dry-run" }
    );
  });

  it("an escaped character ends the word start, with nothing in front of it", () => {
    // Both spellings escape a space, but only one of them exercises the bug: in
    // `echo foo\\ #` the `foo` has already cleared the word-start flag, so the
    // branch that forgets to clear it still gets the right answer. With nothing
    // between the command and the backslash, the flag is still set and the `#`
    // was read as a comment -- hiding a delete the shell runs.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "echo \\ #; rm -rf ./d" }),
      { hold: true, tag: "file-delete" }
    );
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "echo foo\\ # & rm -rf x" }),
      { hold: true, tag: "file-delete" }
    );
  });

  it("a carriage return does not start a word", () => {
    // Bash's default IFS is space, tab and newline. Treating \\r as whitespace put
    // the following `#` at a word start and hid a delete that really runs.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "echo safe\\r#; rm -rf ./data" }),
      { hold: true, tag: "file-delete" }
    );
  });

  it("KNOWN MISS: a heredoc body is read as command positions", () => {
    // A heredoc body is DATA, so `rm -rf` inside one is text being written to a
    // file. This splitter reports it as a command anyway. The class is
    // pre-existing -- `;` produced the same false hold before a lone `&` was
    // added to the separator set -- and the direction is a false HOLD, which
    // costs a human glance rather than an unreviewed deletion.
    //
    // A skip was written and REVERTED. It traded this cheap failure for three
    // expensive ones, all measured: a `;` on the opener's own line was
    // swallowed, `<<E'OF'` parsed the delimiter as `E`, and `$((1<<2))` read an
    // arithmetic left-shift as a heredoc opener -- each hiding a command the
    // shell runs. These lanes pin the current behaviour so that a future skip
    // has to come back through them.
    for (const command of [
      "cat <<'EOF'\necho safe & rm -rf ./data\nEOF",
      "cat <<'EOF'\necho safe; rm -rf /\nEOF",
    ]) {
      const verdict = evaluatePermissionReminder("Bash", { command });
      assert.equal(verdict && verdict.hold, true, command);
    }
    // The three inputs the reverted skip got wrong. They are ordinary shell and
    // the shell really does run the delete, so they must hold.
    for (const command of [
      "cat <<'EOF' ; rm -rf ./data",
      "cat <<E'OF'\nharmless\nEOF\nrm -rf ./data\nE",
      "echo $((1<<2))\nrm -rf ./data\n2",
    ]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: true, tag: "file-delete" },
        command
      );
    }
  });

  it("a subshell is a command position", () => {
    // `echo safe; (rm -rf ./d)` left a segment starting with `(`, which the
    // anchored patterns cannot match while the shell runs the delete.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "echo safe; (rm -rf ./d)" }),
      { hold: true, tag: "file-delete" }
    );
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "(rm -rf /)" }),
      { hold: true, tag: "file-delete" }
    );
    // `((` is arithmetic, not a command position -- the control that keeps the
    // two lines above from being a blanket "strip every paren".
    assert.equal(evaluatePermissionReminder("Bash", { command: "echo $((1 & 2))" }), null);
  });

  it("a brace group is a command position too", () => {
    // `(` was handled and `{` was not, so the SAME delete allowed or held purely
    // by which grouping keyword was typed. Measured in review round 14: the brace
    // spelling ALLOWED while the paren spelling HELD -- the review's composition
    // class in a different syntax.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: ":; { rm -rf ./d; }" }),
      { hold: true, tag: "file-delete" }
    );
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "{ rm -rf ./d; }" }),
      { hold: true, tag: "file-delete" }
    );
    // Controls -- the shell needs a BLANK after `{` for the group keyword, so a
    // brace EXPANSION and a parameter expansion must not be stripped. Without
    // these two lines the fix above is "strip every brace", which would turn
    // `${RM} -rf x` into a fake command position.
    assert.equal(evaluatePermissionReminder("Bash", { command: "echo {a,b}" }), null);
    assert.equal(evaluatePermissionReminder("Bash", { command: "echo ${HOME}" }), null);
  });

  it("a command substitution body is a command position", () => {
    // The quote-aware split cannot reach these by construction: the double quote
    // swallows the whole string, so the only segment is `echo ...`. Both
    // spellings allowed a delete in review round 14 while the plain form held.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: 'echo "$(rm -rf ./d)"' }),
      { hold: true, tag: "file-delete" }
    );
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "echo `rm -rf ./d`" }),
      { hold: true, tag: "file-delete" }
    );
    // Nested one level -- the depth cap is 3, so this must still be seen.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: 'echo "$(echo "$(rm -rf ./d)")"' }),
      { hold: true, tag: "file-delete" }
    );
    // Controls. `$((` is arithmetic, and SINGLE quotes suppress substitution --
    // without them the additive pass would invent command positions out of
    // ordinary text, which is the false-positive direction this pass must not take.
    assert.equal(evaluatePermissionReminder("Bash", { command: "echo $((3 * 4))" }), null);
    assert.equal(evaluatePermissionReminder("Bash", { command: "echo 'rm -rf ./d'" }), null);
    assert.equal(evaluatePermissionReminder("Bash", { command: "echo \\$(ls)" }), null);
  });

  it("a line continuation is removed, so what follows it is a command", () => {
    // The shell DELETES `\\<newline>` before parsing. Keeping it left the segment
    // after `;` beginning `\\<newline>rm`, which the anchored `^rm` pattern cannot
    // match -- so a delete the shell really runs was invisible. This one predates
    // the word-start work; it is closed by removing the continuation outright.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "echo safe;\\\nrm -rf ./d" }),
      { hold: true, tag: "file-delete" }
    );
  });

  it("a line continuation is transparent to word start", () => {
    // Bash removes `\\<newline>` entirely, so the `;` before it is what decides:
    // the `#` is at a word start and comments out the rm.
    assert.equal(
      evaluatePermissionReminder("Bash", { command: "echo safe;\\\n# harmless; rm -rf ./d" }),
      null
    );
  });

  it("models closing delimiters inside comments in dollar substitutions", () => {
    // The direct segment pass still reads a command-looking body after `$(`# as
    // command positions, a known false-hold direction. Keep it explicit while
    // ensuring a `)` inside that comment cannot truncate a quoted substitution
    // and hide the real command on the next line.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "echo $(# harmless; rm -rf ./d\n echo ok)" }),
      { hold: true, tag: "file-delete" }
    );
    assert.deepEqual(
      evaluatePermissionReminder("Bash", {
        command: `echo "$(echo ok # ) don't close\n rm -rf /etc)"`,
      }),
      { hold: true, tag: "file-delete" }
    );
    // Control: the same text with no substitution really is a comment.
    assert.equal(
      evaluatePermissionReminder("Bash", { command: "echo ok # harmless; rm -rf ./d" }),
      null
    );
  });

  it("word start is a parser state, not the previous character", () => {
    // `echo foo\\ # & rm -rf x`: the space is ESCAPED, so `foo #` is one word and
    // `#` opens nothing -- bash runs the rm. Reading the raw previous character
    // saw a space, called it a comment, and discarded a command that executes.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "echo foo\\ # & rm -rf x" }),
      { hold: true, tag: "file-delete" }
    );
    // `echo safe;# & rm -rf x`: no space at all, and `#` after `;` IS a comment.
    // The same raw-character test missed this one in the other direction.
    assert.equal(
      evaluatePermissionReminder("Bash", { command: "echo safe;# & rm -rf x" }),
      null
    );
    // Controls for both edges of the word-start rule.
    assert.equal(evaluatePermissionReminder("Bash", { command: "echo a#b" }), null);
    assert.equal(evaluatePermissionReminder("Bash", { command: "# rm -rf /" }), null);
  });

  it("a comment is not a command position", () => {
    // `#` at the start of a word comments out the rest of the line, so the rm
    // never runs. Splitting on the `&` without knowing that invented a command.
    assert.equal(
      evaluatePermissionReminder("Bash", { command: "echo safe # & rm -rf important" }),
      null
    );
  });

  it("an escaped > is an argument, so the & after it still separates", () => {
    // One backslash: the `>` is a literal argument to echo, so `&` separates and
    // the delete is a real command position.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "echo \\>& rm -rf important" }),
      { hold: true, tag: "file-delete" }
    );
    // Two backslashes: an escaped backslash followed by a REAL redirection, so
    // the `&` is part of `>&` and separates nothing. The pair is what makes the
    // line above a measurement rather than a coincidence.
    assert.equal(
      evaluatePermissionReminder("Bash", { command: "echo \\\\>& rm -rf important" }),
      null
    );
  });

  it("a backslash in double quotes is literal unless it escapes $ ` \" or itself", () => {
    // `"\\--"` is the two characters \\-- , not the end-of-options marker, so the
    // real --dry-run after it still excuses the publish.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: 'npm publish "\\\\--" --dry-run' }),
      { hold: false, tag: "publish", exception: "dry-run" }
    );
  });
});

describe("destructive reminder — a lone & starts a new command", () => {
  it("holds: an excused publish backgrounded, then a delete", () => {
    // `&` was not a separator, so this was ONE segment: the publish matched, its
    // dry-run excused it, and the delete was never a command position at all.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "npm publish --dry-run & rm -rf ./important-data" }),
      { hold: true, tag: "file-delete" }
    );
  });

  it("a redirection is not a separator", () => {
    // `&>` and `2>&1` carry an ampersand that separates nothing. Splitting there
    // would invent a command position out of a redirection target.
    assert.equal(evaluatePermissionReminder("Bash", { command: "ls -la &> out.txt" }), null);
    assert.equal(evaluatePermissionReminder("Bash", { command: "ls -la 2>&1" }), null);
  });
});

// ---------------------------------------------------------------------------
// 1-f. KNOWN MISSES — the inspection budget, asserted so the boundary is visible
// ---------------------------------------------------------------------------

// These are NOT fixed, and the lanes pin the CURRENT behavior on purpose. The
// 4KB / 50-segment caps are deliberate (the scan input is attacker-influenced,
// so the cost has to be bounded by construction), and a command that exhausts
// one is not inspected past that point. That is a real way past this reminder.
// It is written down rather than left for a reader to discover, and if anyone
// later makes an exhausted budget hold, these lanes fail and say so instead of
// the change landing silently.
describe("destructive reminder — known misses at the inspection budget", () => {
  it("KNOWN MISS: a destructive command past the segment cap is not reached", () => {
    const command = new Array(51).fill(":").join(" ; ") + " ; rm -rf /";
    assert.equal(
      evaluatePermissionReminder("Bash", { command }),
      null,
      "documented budget boundary, not a matcher gap — see this block's comment"
    );
    // The control that makes the line above a boundary rather than a matcher
    // miss: the same command, inside the cap, is held.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: ": ; rm -rf /" }),
      { hold: true, tag: "file-delete" }
    );
  });

  it("a syntax fragment beyond the segment cap remains a budget miss, not scan-error", () => {
    const exhausted = new Array(50).fill(":").join(" ; ") + ' ; echo "unterminated';
    const inside = new Array(49).fill(":").join(" ; ") + ' ; echo "unterminated';
    assert.equal(evaluatePermissionReminder("Bash", { command: exhausted }), null);
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: inside }),
      { hold: true, tag: SCAN_ERROR_TAG },
      "the same malformed segment inside the budget must still fail closed"
    );
  });

  it("KNOWN MISS: an excused match before the character cap can remain the whole verdict", () => {
    const command = `git push --force-with-lease origin main && echo ${"x".repeat(SCAN_MAX)} && rm -rf /etc`;
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command }),
      { hold: false, tag: "force-push", exception: "force-with-lease" },
      "the remainder is outside the explicit character budget and was not inspected"
    );
  });

  it("KNOWN FALSE HOLD: heredoc bodies are not parsed as data", () => {
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "cat <<EOF\nit's fine\nEOF" }),
      { hold: true, tag: SCAN_ERROR_TAG },
      "heredoc parsing remains outside this repair's shell-scanner scope"
    );
  });

  it("KNOWN MISS: a destructive command past the scan cap is not reached", () => {
    const command = "echo " + "x".repeat(SCAN_MAX) + " ; rm -rf /";
    assert.equal(evaluatePermissionReminder("Bash", { command }), null);
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "echo x ; rm -rf /" }),
      { hold: true, tag: "file-delete" }
    );
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

  it("a budget cut inside a quote remains a documented miss, not scan-error", () => {
    for (const command of [
      `git commit -m "${"x".repeat(SCAN_MAX + 100)}"`,
      `curl -d '{"a":"${"x".repeat(SCAN_MAX + 100)}"}' http://x`,
      `echo "${"x".repeat(SCAN_MAX + 100)}"`,
    ]) {
      assert.equal(evaluatePermissionReminder("Bash", { command }), null, command.slice(0, 40));
    }
    assert.equal(
      evaluatePermissionReminder("Bash", { command: ["echo", `"${"x".repeat(SCAN_MAX + 100)}"`] }),
      null,
      "argv truncation must carry the same budget provenance as a command string"
    );

    assert.deepEqual(
      evaluatePermissionReminder("Bash", {
        command: `rm -rf /etc && echo "${"x".repeat(SCAN_MAX + 100)}"`,
      }),
      { hold: true, tag: "file-delete" },
      "a known match inside the inspected prefix must survive a later budget cut"
    );
    assert.deepEqual(
      evaluatePermissionReminder("Bash", {
        command: ["rm", "-rf", "/etc", "&&", "echo", `"${"x".repeat(SCAN_MAX + 100)}"`],
      }),
      { hold: true, tag: "file-delete" },
      "an argv match inside the inspected prefix must survive a later budget cut"
    );
  });

  it("a megabyte of input stays fast", () => {
    const command = `${"a".repeat(1024 * 1024)} && rm -rf src`;
    const started = process.hrtime.bigint();
    evaluatePermissionReminder("Bash", { command });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 250, `scan took ${elapsedMs}ms`);
  });

  // #1021 review (4): the STRING shape above was already bounded before this
  // review (boundCommandString runs on the raw command directly). The ARGV
  // shape was not: parts.join(" ") ran on the FULL array before
  // boundCommandString ever saw the result, so ARGV_MAX (which bounds
  // element COUNT) did nothing to bound total bytes joined. A final-length
  // assertion alone cannot see this bug -- the old code also returned a
  // SCAN_MAX-length string, just after doing unbounded work to get there.
  // These lanes observe the PRE-SCAN allocation/throw boundary instead.
  describe("the argv shape is bounded the same way, before the join, not after (review 4)", () => {
    it("256 elements at the ARGV_MAX cap, each far bigger than any reasonable request, does not throw", () => {
      // Each element alone is bigger than V8's max string length once
      // multiplied by 256 (~2.56GB combined) -- Array.prototype.join over
      // the unbounded array throws RangeError: Invalid string length at
      // this size (reproduced against the pre-fix code: 256 x 4MB (~1GB
      // combined) already throws there). A join that is bounded BEFORE it
      // walks the array can never reach that error, regardless of how large
      // any single element is, because it stops as soon as it has SCAN_MAX
      // characters.
      const hugeArgv = new Array(ARGV_MAX).fill(0).map(() => "x".repeat(10_000_000)); // ~2.56GB unbounded
      let scanInput;
      assert.doesNotThrow(() => {
        scanInput = buildReminderScanInput({ command: hugeArgv });
      }, "a budget-respecting join must never approach V8's max string length");
      assert.equal(scanInput.command.length, SCAN_MAX);
      assert.equal(
        scanInput.command,
        hugeArgv[0].slice(0, SCAN_MAX),
        "the first element alone already exceeds the budget, so the bounded join must equal its own prefix"
      );
    });

    it("a wide, deep argv (many elements, each large) still scans fast", () => {
      // Companion to "a megabyte of input stays fast" above, for the shape
      // that lane does not cover. 256 x 1MB = 256MB of accepted input --
      // comfortably inside what an HTTP body limit would allow through --
      // and the reminder must not do work proportional to that 256MB.
      const wideArgv = new Array(ARGV_MAX).fill(0).map(() => "a".repeat(1024 * 1024));
      wideArgv[ARGV_MAX - 1] += " && rm -rf src"; // a real destructive tail, so this also proves detection still works
      const started = process.hrtime.bigint();
      const verdict = evaluatePermissionReminder("Bash", { command: wideArgv });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(elapsedMs < 250, `scan took ${elapsedMs}ms for a 256MB argv`);
      // The destructive tail sits past SCAN_MAX (256MB in), so it is a
      // documented miss (same policy as "beyond the budget is a documented
      // miss" above) -- this lane is about SPEED, not about extending reach
      // past the existing budget.
      assert.equal(verdict, null);
    });

    it("within budget, the bounded join is byte-for-byte the same as join-then-slice", () => {
      // Proves the fix is a performance change, not a behavior change, for
      // every shape that was already well-behaved before this review.
      const cases = [
        [],
        ["a"],
        ["a", "b", "c"],
        ["git", "push", "--force", "origin", "main"],
        ["aaaa", "bbbb"], // exercises a mid-element cut when max < combined length
        [""],
        ["", "x", ""],
      ];
      for (const parts of cases) {
        for (const max of [1, 4, 6, 4096]) {
          const oldWay = parts.join(" ").slice(0, max);
          const newWay = joinArgvBounded(parts, max);
          assert.equal(newWay, oldWay, `mismatch for parts=${JSON.stringify(parts)} max=${max}`);
        }
      }
    });
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
    const {
      detectIrreversible,
      detectIrreversibleStrict,
      detectIrreversibleMatches,
    } = require("../src/bubble-format");
    const hostile = { get command() { throw new Error("hostile getter"); } };
    assert.equal(detectIrreversible("Bash", hostile), null);
    assert.throws(() => detectIrreversibleStrict("Bash", hostile));
    assert.equal(
      fs.readFileSync(path.join(SRC, "permission-reminder.js"), "utf8").includes("detectIrreversibleMatches"),
      true,
      "the reminder must reuse the display matcher rather than carry a second pattern list"
    );
    // The badge takes one decision and the gate takes all of them, but they are
    // the same walk over the same list: pinning that by behavior rather than by
    // the presence of a symbol name means a future second pattern list fails
    // here even if it is spelled the same way.
    const both = { command: "npm publish --dry-run && rm -rf /" };
    const every = detectIrreversibleMatches("Bash", both);
    assert.equal(every.length, 2, "both decisions in the request are returned");
    assert.deepEqual(detectIrreversibleStrict("Bash", both), every[0], "the hint is the first of them");
  });
});

// ---------------------------------------------------------------------------
// 2-b. Maintainer takeover regressions found after PR review
// ---------------------------------------------------------------------------

describe("destructive reminder — takeover fail-closed regressions", () => {
  it("does not let an option operand masquerade as this invocation's safety flag", () => {
    const cases = [
      ["psql -c --dry-run -c 'DROP TABLE users'", "db-destroy"],
      ["psql -c --help -c 'DROP TABLE users'", "db-destroy"],
      ["npm publish --otp --dry-run", "publish"],
      ["npm publish --workspace --help", "publish"],
      ["git push --force --push-option --dry-run origin main", "force-push"],
      ["git push --force --repo --dry-run origin main", "force-push"],
      ["git push --force --exec --dry-run origin main", "force-push"],
      ["git push --force -o --dry-run origin main", "force-push"],
      ["kubectl delete --raw --dry-run=client namespace prod", "infra-destroy"],
      ["cargo publish --token --help", "publish"],
      ["kubectl delete --raw --help namespace prod", "infra-destroy"],
      ["git push --force --push-option --help origin main", "force-push"],
    ];
    for (const [command, tag] of cases) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: true, tag },
        command
      );
    }
  });

  it("never grants generic safety exceptions to any matched database client", () => {
    for (const command of [
      "mysql -e --dry-run -e 'DROP TABLE users'",
      "mysqlsh --sql -e --help -e 'DROP TABLE users'",
      "mongosh --eval --dry-run --eval 'DROP TABLE users'",
      "sqlite3 --cmd --help app.db 'DROP TABLE users'",
    ]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: true, tag: "db-destroy" },
        command
      );
    }
  });

  it("reads a plain force inside a git short-option cluster", () => {
    for (const command of [
      "git push --force-with-lease -fu origin main",
      "git push --force-with-lease -uf origin main",
    ]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: true, tag: "force-push" },
        command
      );
    }
    // `--` ends Git's option scope. A later word that looks like --force is a
    // refspec/operand, not cancellation evidence for the lease exception.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", {
        command: "git push --force-with-lease origin main -- --force",
      }),
      { hold: false, tag: "force-push", exception: "force-with-lease" }
    );
    // Conversely, a force-looking push-option VALUE is data, not cancellation
    // evidence. The command-specific parser must not swing too far and turn a
    // value operand into a real `-f`.
    assert.deepEqual(
      evaluatePermissionReminder("Bash", {
        command: "git push --force-with-lease -o --force origin main",
      }),
      { hold: false, tag: "force-push", exception: "force-with-lease" }
    );
  });

  it("does not let quotes truncate command-substitution coverage", () => {
    const cases = [
      [`echo "it's $(rm -rf /etc)"`, "file-delete"],
      [`echo "don't $(rm -rf /etc) won't"`, "file-delete"],
      [`echo "can't" ; echo "$(rm -rf /etc)"`, "file-delete"],
      [`git commit -m "don't" && echo \`rm -rf /etc\``, "file-delete"],
      [
        `echo "$(git push --force-with-lease origin main)" ; echo "can't $(rm -rf /etc)"`,
        "file-delete",
      ],
      [
        `echo "$(git push --force-with-lease origin main && printf ')' && git reset --hard HEAD^)"`,
        "history-rewrite",
      ],
    ];
    for (const [command, tag] of cases) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: true, tag },
        command
      );
    }
  });

  it("ignores substitutions and apostrophes inside real trailing comments", () => {
    for (const command of [
      "echo ok # don't",
      "npm install # it's fine",
      `git commit -m "ok" # don't push`,
      "echo ok # $(rm -rf /etc)",
      "echo $(echo ok # don't\n)",
      `echo "$(echo ok # don't\n)"`,
    ]) {
      assert.equal(evaluatePermissionReminder("Bash", { command }), null, command);
    }
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "rm -rf /etc # don't" }),
      { hold: true, tag: "file-delete" },
      "a real command before the comment must retain its reason rather than becoming scan-error"
    );
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: `echo "safe # $(rm -rf /etc)"` }),
      { hold: true, tag: "file-delete" },
      "# inside double quotes is literal and must not hide an executing substitution"
    );
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command: "echo word# don't" }),
      { hold: true, tag: SCAN_ERROR_TAG },
      "# inside a word is literal, so the unmatched apostrophe remains real syntax"
    );
  });

  it("keeps comment and separator characters literal inside double quotes", () => {
    for (const command of [
      'git commit -m "fix #123"',
      'echo "a # b"',
      'echo "a; # b"',
      'echo "a| # b"',
      'echo "a& # b"',
    ]) {
      assert.equal(evaluatePermissionReminder("Bash", { command }), null, command);
    }

    for (const command of [
      `npm publish --dry-run ; echo "a # $(rm -rf /etc) b\nc"`,
      `npm publish --dry-run ; echo "a # \`rm -rf /etc\` b\nc"`,
      'npm publish --dry-run ; echo "a; # $(rm -rf /etc)"',
      'npm publish --dry-run ; echo "a| # $(rm -rf /etc)"',
      'npm publish --dry-run ; echo "a& # $(rm -rf /etc)"',
    ]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: true, tag: "file-delete" },
        command
      );
    }
  });

  it("treats incomplete substitution syntax differently in the gate and display hint", () => {
    const {
      detectIrreversible,
      detectIrreversibleStrict,
    } = require("../src/bubble-format");
    for (const command of [
      'echo "$(rm -rf /etc)',
      "echo $(rm -rf /etc",
      "echo `rm -rf /etc",
    ]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: true, tag: SCAN_ERROR_TAG },
        command
      );
      assert.equal(detectIrreversible("Bash", { command }), null, command);
      assert.throws(() => detectIrreversibleStrict("Bash", { command }), command);
    }
  });

  it("keeps argv inspection character-bounded without a lossy element cap", () => {
    const command = [...new Array(300).fill("x"), "&&", "rm", "-rf", "/etc"];
    assert.ok(command.join(" ").length < SCAN_MAX, "the destructive tail must be inside the character budget");
    assert.deepEqual(
      evaluatePermissionReminder("Bash", { command }),
      { hold: true, tag: "file-delete" }
    );
  });

  it("fails closed on a malformed argv inside the inspected prefix", () => {
    for (const rawInput of [
      { command: ["rm", "-rf", "/etc", 5] },
      { command: ["rm", "-rf", "/etc", null] },
      { command: ["rm", "-rf", "/etc", 5], script: "echo hi" },
    ]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", rawInput),
        { hold: true, tag: SCAN_ERROR_TAG }
      );
    }
  });

  it("keeps disposable-path exceptions through ordinary output redirection", () => {
    for (const command of [
      "rm -rf dist 2>/dev/null",
      "rm -rf dist > /dev/null",
      "rm -rf dist > /dev/null 2>&1",
      "rm -rf node_modules >>cleanup.log",
    ]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: false, tag: "file-delete", exception: "disposable-path" },
        command
      );
    }
  });

  it("never excuses a disposable path when redirection parsing hides a later target", () => {
    for (const command of [
      "rm -rf dist <&0 /etc",
      "rm -rf dist <&1 important",
      "rm -rf dist 2<&0 /var/lib",
      "rm -rf dist >| out /etc",
      "rm -rf dist <&0 /etc /var",
      "rm -rf dist >",
      "rm -rf dist <",
      "rm -rf dist 2>",
    ]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: true, tag: "file-delete" },
        command
      );
    }
  });

  it("keeps complete fd and noclobber redirections on disposable-only deletes excused", () => {
    for (const command of [
      "rm -rf dist <&0",
      "rm -rf dist 2<&1",
      "rm -rf dist >| cleanup.log",
    ]) {
      assert.deepEqual(
        evaluatePermissionReminder("Bash", { command }),
        { hold: false, tag: "file-delete", exception: "disposable-path" },
        command
      );
    }
  });

  it("pins the remaining depth and wrapper coverage limits explicitly", () => {
    assert.equal(
      evaluatePermissionReminder("Bash", { command: "$($($($(rm -rf /etc))))" }),
      null,
      "fourth-level substitution is an explicit known miss in this takeover"
    );
    assert.equal(
      evaluatePermissionReminder("Bash", {
        command: "command command command command command command rm -rf /etc",
      }),
      null,
      "a sixth wrapper normalization pass is an explicit known miss in this takeover"
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

// The rendered strings are the contract a human reads on the card, so the
// lanes below assert them verbatim rather than by substring.
const { i18n: RUNTIME_I18N, SUPPORTED_LANGS } = require("../src/i18n.js");
const EN = RUNTIME_I18N.en;

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
    assert.match(requests[0].detail, /Automatic approval paused: force push/);
    assert.doesNotMatch(requests[0].detail, /force-push/,
      "the stable diagnostic tag must not leak into user-visible copy");
    assert.ok(
      requests[0].fields.some((field) => /Automatic approval paused: force push/.test(field.value)),
      "the reason must be a field, not only buried in the detail blob"
    );

    const off = makeRuntime({
      isDestructiveReminderEnabled: () => false,
      getTelegramApprovalClient: () => client,
    });
    assert.equal(off.permission.maybeStartRemoteApproval(off.entry), true);
    assert.doesNotMatch(requests[1].detail, /Automatic approval paused: force push/);
    assert.doesNotMatch(requests[1].detail, /force-push/,
      "the internal tag must stay absent when the reminder setting is off");
  });

  // Field-measured 2026-09-16 (real machine, Telegram, bubbles off): the card
  // above carries the reason only when the reminder is why the request is
  // pending. In remote-only operation it never is -- the request reaches a
  // human regardless -- so that card shipped with NO reason line at all, twice
  // reproduced. The lane above did not catch it because its name says
  // "remote-only" while its fixture leaves bubbles ON, so it only ever
  // exercised the held case. This is the arm it was missing.
  //
  // The local card degrades to the weaker irreversible hint here; before this
  // lane the remote card degraded to silence, and a remote-only operator has
  // no local badge to fall back on.
  it("remote-only: a matched request still names its pattern, in weaker wording", () => {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        requests.push(payload);
        return new Promise(() => {});
      },
    };
    // Automation off => the request was reaching a human anyway => the reminder
    // is NOT why it is pending. One of the three cases the comment on
    // reminderIsWhyThisIsPending() names by hand.
    const remoteOnly = makeRuntime({
      isDestructiveReminderEnabled: () => true,
      getPermissionAutomationMode: () => "off",
      getBubblePolicy: () => ({ enabled: false, autoCloseMs: 0 }),
      getTelegramApprovalClient: () => client,
    });
    assert.equal(remoteOnly.permission.maybeStartRemoteApproval(remoteOnly.entry), true);
    assert.equal(requests.length, 1);

    // Pin the LINE, not the tag. Both cross-family reviewers flagged that
    // /force-push/ could match the command text instead of the reminder field
    // and let this pass for the wrong reason. The mutant run refutes that for
    // this fixture (the command reads "--force", never the hyphenated tag, and
    // reverting the fix fails on exactly this assertion) -- but a later fixture
    // edit could make it true, so the assertion names the field and its exact
    // rendered value instead of relying on a substring.
    const reminderField = (req) =>
      req.fields.find((f) => f.label === EN.approvalDetailReminder) || null;
    const weak = reminderField(requests[0]);
    assert.ok(weak, "a remote-only operator must get the reminder FIELD, not just a blob");
    assert.equal(
      weak.value,
      EN.approvalDetailIrreversibleValue.replace("{reason}", EN_FORCE_PUSH_REASON),
      "tier 2 must render the weaker irreversible wording, verbatim"
    );
    assert.match(requests[0].detail, /Potentially destructive action: force push/,
      "and the same line must reach the plain-text detail");

    // Tier 2 must not borrow tier 1's wording: nothing stopped this request,
    // so claiming Clawd held it would be false on a card a human acts from.
    const held = makeRuntime({
      isDestructiveReminderEnabled: () => true,
      getTelegramApprovalClient: () => client,
    });
    assert.equal(held.permission.maybeStartRemoteApproval(held.entry), true);
    const strong = reminderField(requests[1]);
    assert.ok(strong, "the held case still carries the field");
    assert.equal(
      strong.value,
      EN.approvalDetailReminderValue.replace("{reason}", EN_FORCE_PUSH_REASON),
      "tier 1 keeps the held wording"
    );
    assert.doesNotMatch(weak.value, /Automatic approval paused/,
      "tier 2 must never claim Clawd stopped a request it did not stop");

    // The arm a cross-family reviewer named as missing: automation is ON, but
    // THIS request was never auto-allowable anyway (an ineligible session), so
    // the reminder still changed nothing and tier 2 is still the honest line.
    // Without it, a predicate that dropped its "would otherwise auto-allow"
    // half would keep every other lane green.
    const ineligible = makeRuntime({
      isDestructiveReminderEnabled: () => true,
      getPermissionAutomationMode: () => "auto-tools",
      getBubblePolicy: () => ({ enabled: false, autoCloseMs: 0 }),
      getTelegramApprovalClient: () => client,
    }, {
      // The lever is the INTERACTION, not the session: evaluatePermissionAutomation()
      // reads only (mode, interaction). zcode is a real adapter classified
      // tool-approval with automationEligibility.autoTools === false, so
      // automation is on and this request is still not auto-allowable.
      // (A first attempt used sessionAutomationIdentity and rendered tier 1 --
      // the arm was asserting a lever that does not reach this predicate.)
      agentId: "zcode",
      interaction: classifyPermissionInteraction({ agentId: "zcode", toolName: "Bash" }),
    });
    assert.equal(ineligible.permission.maybeStartRemoteApproval(ineligible.entry), true);
    const ineligibleField = reminderField(requests[2]);
    assert.ok(ineligibleField, "an ineligible session still gets the field");
    assert.equal(
      ineligibleField.value,
      EN.approvalDetailIrreversibleValue.replace("{reason}", EN_FORCE_PUSH_REASON),
      "automation on but inapplicable is still tier 2, not tier 1"
    );

    // Known-negative: with the setting off, neither tier may appear.
    const disabled = makeRuntime({
      isDestructiveReminderEnabled: () => false,
      getPermissionAutomationMode: () => "off",
      getBubblePolicy: () => ({ enabled: false, autoCloseMs: 0 }),
      getTelegramApprovalClient: () => client,
    });
    assert.equal(disabled.permission.maybeStartRemoteApproval(disabled.entry), true);
    assert.equal(reminderField(requests[3]), null,
      "the setting off means no reminder field at all, in either tier");
    assert.doesNotMatch(requests[3].detail, /may not be recoverable/);
  });
});

// ---------------------------------------------------------------------------
// 4b. Tier 1 must require the SAME gates sweep()/session-grant flows use
// ---------------------------------------------------------------------------

describe("destructive reminder — tier 1 requires the same gates sweep uses (#1021 review 3)", () => {
  // reminderIsWhyThisIsPending() used to re-evaluate automation policy with a
  // PARTIAL copy of canAutoResolvePendingPermission()'s entry-level gates, so
  // it could answer "yes, the reminder is why this is pending" (tier 1:
  // "Automatic approval paused") even when Codex permission intercept or the
  // subagent automation gate was already going to hold the request regardless of the
  // reminder. sweep()/canOfferSessionTrust() -- via
  // canAutoResolvePendingPermission() -- would never have resolved that
  // entry, so tier 2 ("Potentially destructive action") is the honest line.
  //
  // The lanes above named "remote-only" never set entry.remoteOnly = true and
  // never created a real session-automation grant, so they never modelled
  // this shape. These lanes build a REAL session-automation-coordinator +
  // store (the same wiring main.js uses, src/main.js ~1970-1972) and a REAL
  // remoteOnly: true entry.
  function makeSessionGrantRuntime(ctxOverrides = {}, entryOverrides = {}) {
    const ctx = {
      doNotDisturb: false,
      lang: "en",
      sessions: new Map([["session-grant-1", { cwd: "/repo", displayTitle: "remote" }]]),
      isAgentEnabled: () => true,
      isAgentPermissionsEnabled: () => true,
      isAgentSubagentPermissionsEnabled: () => true,
      isCodexPermissionInterceptEnabled: () => true,
      // Global automation OFF: only the session grant below may auto-allow,
      // which is what makes this a "remote-only + session grant" shape.
      getPermissionAutomationMode: () => "off",
      isDestructiveReminderEnabled: () => true,
      getBubblePolicy: () => ({ enabled: false, autoCloseMs: 0 }),
      ...ctxOverrides,
    };
    const permission = initPermission(ctx);
    const store = createSessionAutomationStore();
    const coordinator = createSessionAutomationCoordinator({
      store,
      getSession: (sid) => ctx.sessions.get(sid) || null,
      listPending: () => permission.pendingPermissions,
      getGlobalMode: () => ctx.getPermissionAutomationMode(),
      canAutoResolvePendingPermission: permission.canAutoResolvePendingPermission,
      resolvePermissionEntry: permission.resolvePermissionEntry,
    });
    ctx.getEffectivePermissionAutomationMode = (entry, options) => coordinator.getEffectiveMode(entry, options);
    ctx.hasSessionAutomationOverride = (entry) => !!coordinator.getRecordForEntry(entry);
    ctx.canOfferSessionTrust = (entry) => coordinator.canOfferSessionTrust(entry);

    const identity = { agentId: "claude-code", sessionId: "session-grant-1" };
    const grant = store.compareAndSet(identity, "auto-tools", {
      expectedGrantId: null,
      nextGrantId: "grant-1",
      displayLabel: "remote",
    });
    assert.equal(grant.status, "applied", "test setup: the session grant itself must succeed");

    const rawInput = entryOverrides.rawInput || { command: "git push --force origin main" };
    const entry = {
      res: liveResponse(),
      sessionId: identity.sessionId,
      agentId: identity.agentId,
      toolName: "Bash",
      toolInput: truncateDeep(rawInput),
      ...preparePermissionReminder("Bash", rawInput),
      interaction: classifyPermissionInteraction({ agentId: identity.agentId, toolName: "Bash" }),
      sessionAutomationIdentity: Object.freeze({ eligible: true, reason: "eligible" }),
      remoteOnly: true, // the real field -- this is what "remote-only" must mean
      ...entryOverrides,
    };
    permission.pendingPermissions.push(entry);
    return { ctx, permission, coordinator, store, entry, identity };
  }

  const reminderField = (req) => req.fields.find((f) => f.label === EN.approvalDetailReminder) || null;

  function remoteFieldValue(rt) {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => { requests.push(payload); return new Promise(() => {}); },
    };
    rt.ctx.getTelegramApprovalClient = () => client;
    assert.equal(rt.permission.maybeStartRemoteApproval(rt.entry), true);
    const field = reminderField(requests[0]);
    return field ? field.value : null;
  }

  // Ground truth for "would sweep/session-grant resolve this if the reminder
  // weren't the reason" cannot be read off canAutoResolvePendingPermission()
  // on the LIVE entry directly: the reminder's own hold (this fixture always
  // matches force-push) makes that predicate return false regardless of the
  // Codex/subagent gate, which would mask exactly the signal these lanes
  // need. So the oracle is a SEPARATE instance, identical in every gate
  // except the destructiveActionReminder SETTING, which is off -- that
  // forces permissionReminderHolds() to false without touching any other
  // gate, which is the same "neutralize only the reminder hold" view
  // reminderIsWhyThisIsPending() is supposed to compute.
  function oracleWouldSweepResolve(gateOverrides, entryOverrides) {
    const oracle = makeSessionGrantRuntime(
      { ...gateOverrides, isDestructiveReminderEnabled: () => false },
      entryOverrides
    );
    return oracle.permission.canAutoResolvePendingPermission(
      oracle.entry, { sessionOnly: true, mode: "auto-tools" }
    );
  }

  it("Codex intercept off: sweep would never resolve this, so the card must be tier 2, not tier 1", () => {
    const gates = { isCodexPermissionInterceptEnabled: () => false };
    const entryShape = { isCodex: true };

    // Ground truth: the SAME predicate sweep()/session-grant flows call,
    // with only the reminder's own hold neutralized.
    assert.equal(
      oracleWouldSweepResolve(gates, entryShape),
      false,
      "sweep must never resolve this entry while Codex intercept is off"
    );

    const rt = makeSessionGrantRuntime(gates, entryShape);
    assert.equal(
      rt.permission.buildPermissionBubblePayload(rt.entry).reminderTag,
      null,
      "the local card must not claim tier 1 (reminderTag null means: not the reason)"
    );
    assert.equal(
      remoteFieldValue(rt),
      EN.approvalDetailIrreversibleValue.replace("{reason}", EN_FORCE_PUSH_REASON),
      'the remote card must render tier 2 wording, not "Automatic approval paused"'
    );
  });

  it("control: Codex intercept ON -- tier 1 is correct here, and still renders", () => {
    const gates = { isCodexPermissionInterceptEnabled: () => true };
    const entryShape = { isCodex: true };

    assert.equal(
      oracleWouldSweepResolve(gates, entryShape),
      true,
      "sanity: with the gate on, sweep DOES resolve this entry (the control must discriminate)"
    );

    const rt = makeSessionGrantRuntime(gates, entryShape);
    assert.equal(rt.permission.buildPermissionBubblePayload(rt.entry).reminderTag, "force-push");
    assert.equal(
      remoteFieldValue(rt),
      EN.approvalDetailReminderValue.replace("{reason}", EN_FORCE_PUSH_REASON),
      "tier 1 wording"
    );
  });

  it("subagent automation gate off: sweep would never resolve this, so the card must be tier 2", () => {
    const gates = { isAgentSubagentPermissionsEnabled: () => false };
    const entryShape = { subagentId: "sub-1" };

    assert.equal(
      oracleWouldSweepResolve(gates, entryShape),
      false,
      "sweep must never resolve a subagent entry while its automation gate is off"
    );

    const rt = makeSessionGrantRuntime(gates, entryShape);
    assert.equal(rt.permission.buildPermissionBubblePayload(rt.entry).reminderTag, null);
    assert.equal(
      remoteFieldValue(rt),
      EN.approvalDetailIrreversibleValue.replace("{reason}", EN_FORCE_PUSH_REASON)
    );
  });

  it("control: subagent automation gate ON -- tier 1 is correct here, and still renders", () => {
    const gates = { isAgentSubagentPermissionsEnabled: () => true };
    const entryShape = { subagentId: "sub-1" };

    assert.equal(
      oracleWouldSweepResolve(gates, entryShape),
      true,
      "sanity: with the gate on, sweep DOES resolve this entry (the control must discriminate)"
    );

    const rt = makeSessionGrantRuntime(gates, entryShape);
    assert.equal(rt.permission.buildPermissionBubblePayload(rt.entry).reminderTag, "force-push");
    assert.equal(
      remoteFieldValue(rt),
      EN.approvalDetailReminderValue.replace("{reason}", EN_FORCE_PUSH_REASON)
    );
  });
});

// ---------------------------------------------------------------------------
// 4c. The setting is read eagerly, and a pending entry's decision is frozen
//     against it being toggled mid-flight (#1021 review 5)
// ---------------------------------------------------------------------------

describe("destructive reminder — the setting is scanned eagerly and pinned per pending entry (#1021 review 5)", () => {
  it("the scan runs and stamps a verdict on the entry regardless of the setting (this module has no ctx)", () => {
    // preparePermissionReminder()/evaluatePermissionReminder() take no ctx and
    // so cannot read destructiveActionReminder at all -- "when it is off,
    // nothing reads it" describes the DECISION/UI, not this call. This lane
    // pins that the stamp is present unconditionally, so a future change that
    // tried to make the scan itself conditional would have to touch a
    // function signature this test grips.
    const rawInput = { command: "git push --force origin main" };
    const view = preparePermissionReminder("Bash", rawInput);
    assert.deepEqual(view, { permissionReminder: { hold: true, tag: "force-push" } });
  });

  it("a request held while the setting is ON stays held after the setting is turned OFF mid-flight", () => {
    // TOCTOU: the stamp is computed once, at accept time. Whether it HOLDS
    // used to re-read the live setting on every call -- including from
    // canAutoResolvePendingPermission(), which sweep()/session-grant flows
    // call much later than accept time. That let an already-pending, already
    // displayed "Automatic approval paused" request become sweep-resolvable the
    // instant the operator turned the setting off, with no human action on
    // THIS request and no re-render of the card that was already shown.
    let reminderEnabled = true;
    const { permission, entry } = makeRuntime({ isDestructiveReminderEnabled: () => reminderEnabled });
    assert.equal(entry.permissionReminder.hold, true, "fixture must actually match");

    // At accept time (setting ON): a session grant must not sweep this.
    assert.equal(
      permission.canAutoResolvePendingPermission(entry, { sessionOnly: true, mode: "auto-tools" }),
      false,
      "held at accept time"
    );
    assert.equal(permission.buildPermissionBubblePayload(entry).reminderTag, "force-push");

    // The operator turns the setting off. No human decision was made on
    // this request, and nothing re-rendered its card.
    reminderEnabled = false;

    assert.equal(
      permission.canAutoResolvePendingPermission(entry, { sessionOnly: true, mode: "auto-tools" }),
      false,
      "must STILL be held: the request's own decision was pinned at accept time, not re-read live"
    );
    assert.equal(
      permission.buildPermissionBubblePayload(entry).reminderTag,
      "force-push",
      "the tag must stay stable too, so a late re-render (if one ever happens) agrees with the pinned decision"
    );
  });

  it("control: a request that never matched the reminder is unaffected by the setting flipping either way", () => {
    let reminderEnabled = false;
    const { permission, entry } = makeRuntime(
      { isDestructiveReminderEnabled: () => reminderEnabled },
      { rawInput: { command: "npm test" } }
    );
    assert.equal(entry.permissionReminder, null, "fixture must not match anything");
    assert.equal(
      permission.canAutoResolvePendingPermission(entry, { sessionOnly: true, mode: "auto-tools" }),
      true,
      "an unmatched request resolves normally"
    );
    reminderEnabled = true; // flips the OTHER way after the fact
    assert.equal(
      permission.canAutoResolvePendingPermission(entry, { sessionOnly: true, mode: "auto-tools" }),
      true,
      "still resolves -- there was never a stamp for the setting to act on, so pinning changes nothing here"
    );
  });

  it("a request accepted while the setting is OFF stays unresolvable-by-reminder even if the setting is turned ON later", () => {
    // The symmetric direction: pinning must not accidentally make the OTHER
    // toggle direction newly hold something it had already committed to
    // resolving as an ordinary automatic allow.
    let reminderEnabled = false;
    const { permission, entry } = makeRuntime({ isDestructiveReminderEnabled: () => reminderEnabled });
    assert.equal(entry.permissionReminder.hold, true, "fixture must actually match (the STAMP does not care about the setting)");

    // Setting OFF at accept time: sweep must resolve it like any ordinary request.
    assert.equal(
      permission.canAutoResolvePendingPermission(entry, { sessionOnly: true, mode: "auto-tools" }),
      true,
      "setting off at accept time: not held"
    );

    reminderEnabled = true; // operator turns it ON while this request is still pending

    assert.equal(
      permission.canAutoResolvePendingPermission(entry, { sessionOnly: true, mode: "auto-tools" }),
      true,
      "must STILL resolve: pinned at accept time as not-held, so turning the setting on later does not retroactively grab this request"
    );
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

  it("explains the safety action without exposing matcher jargon in any locale", () => {
    const renderer = fs.readFileSync(path.join(SRC, "bubble-renderer.js"), "utf8");
    const expected = {
      en: ["Automatic approval paused: {reason}", "Potentially destructive action: {reason}"],
      zh: ["已暂停自动批准：{reason}", "可能的破坏性操作：{reason}"],
      "zh-TW": ["已暫停自動允許：{reason}", "可能的破壞性操作：{reason}"],
      ko: ["자동 승인을 일시 중지했습니다: {reason}", "파괴적일 수 있는 작업: {reason}"],
      ja: ["自動承認を一時停止しました：{reason}", "破壊的な可能性がある操作：{reason}"],
      "pt-BR": ["A aprovação automática foi pausada: {reason}", "Ação potencialmente destrutiva: {reason}"],
      es: ["Aprobación automática pausada: {reason}", "Acción potencialmente destructiva: {reason}"],
    };
    const legacyJargon = [
      "matched: {reason}",
      "匹配：{reason}",
      "符合：{reason}",
      "일치: {reason}",
      "一致: {reason}",
      "correspondeu: {reason}",
      "coincidencia: {reason}",
    ];

    for (const lang of SUPPORTED_LANGS) {
      const [held, destructive] = expected[lang];
      assert.equal(RUNTIME_I18N[lang].approvalDetailReminderValue, held, `${lang} tier 1`);
      assert.equal(RUNTIME_I18N[lang].approvalDetailIrreversibleValue, destructive, `${lang} tier 2`);
      assert.ok(
        renderer.includes(`reminderHeldHint: "${held}"`),
        `${lang} local bubble must use the same action-oriented tier-1 copy`
      );
    }
    for (const phrase of legacyJargon) {
      assert.ok(!renderer.includes(phrase), `local bubble still exposes matcher jargon: ${phrase}`);
      for (const lang of SUPPORTED_LANGS) {
        assert.ok(
          !`${RUNTIME_I18N[lang].approvalDetailReminderValue}\n${RUNTIME_I18N[lang].approvalDetailIrreversibleValue}`.includes(phrase),
          `${lang} remote approval still exposes matcher jargon: ${phrase}`
        );
      }
    }
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
