const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  COPILOT_HOOK_EVENTS,
  TIMEOUT_SEC,
  buildCopilotHookCommands,
  buildCopilotHookEntry,
  registerCopilotHooks,
} = require("../hooks/copilot-install");

const MARKER = "copilot-hook.js";
const tempDirs = [];

function makeTempHomeWithCopilot(initialJson) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-copilot-install-"));
  const copilotDir = path.join(tmpDir, ".copilot");
  const hooksDir = path.join(copilotDir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  if (initialJson !== undefined) {
    fs.writeFileSync(path.join(hooksDir, "hooks.json"), JSON.stringify(initialJson, null, 2), "utf8");
  }
  tempDirs.push(tmpDir);
  return { homeDir: tmpDir, hooksPath: path.join(hooksDir, "hooks.json") };
}

function makeTempHomeWithoutCopilot() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-copilot-install-no-"));
  tempDirs.push(tmpDir);
  return { homeDir: tmpDir };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("buildCopilotHookCommands", () => {
  it("quotes node binary, hook script, and event name in both fields", () => {
    const { bash, powershell } = buildCopilotHookCommands(
      "/usr/bin/node",
      "/home/u/.claude/hooks/copilot-hook.js",
      "sessionStart"
    );
    assert.strictEqual(
      bash,
      '"/usr/bin/node" "/home/u/.claude/hooks/copilot-hook.js" "sessionStart"'
    );
    assert.strictEqual(
      powershell,
      '& "/usr/bin/node" "/home/u/.claude/hooks/copilot-hook.js" "sessionStart"'
    );
  });

  it("escapes embedded double quotes safely", () => {
    const { bash } = buildCopilotHookCommands('node"', "/p/copilot-hook.js", "preToolUse");
    assert.ok(bash.includes('"node\\""'));
  });

  it("adds CLAWD_REMOTE env prefixes for remote hook commands", () => {
    const { bash, powershell } = buildCopilotHookCommands(
      "/usr/bin/node",
      "/home/u/.claude/hooks/copilot-hook.js",
      "sessionStart",
      { remote: true }
    );
    assert.strictEqual(
      bash,
      'CLAWD_REMOTE=1 "/usr/bin/node" "/home/u/.claude/hooks/copilot-hook.js" "sessionStart"'
    );
    assert.strictEqual(
      powershell,
      '$env:CLAWD_REMOTE=\'1\'; & "/usr/bin/node" "/home/u/.claude/hooks/copilot-hook.js" "sessionStart"'
    );
  });
});

describe("buildCopilotHookEntry", () => {
  it("produces a stable entry with type/timeoutSec metadata", () => {
    const entry = buildCopilotHookEntry("node", "/x/copilot-hook.js", "postToolUse");
    assert.strictEqual(entry.type, "command");
    assert.strictEqual(entry.timeoutSec, TIMEOUT_SEC);
    assert.ok(entry.bash.includes("postToolUse"));
    assert.ok(entry.powershell.startsWith("& "));
  });
});

describe("registerCopilotHooks", () => {
  it("creates hooks.json from scratch with all 5 events on first install", () => {
    // makeTempHomeWithCopilot() with no arg leaves hooks.json absent,
    // exercising the ENOENT branch in registerCopilotHooks.
    const { homeDir, hooksPath } = makeTempHomeWithCopilot();
    assert.strictEqual(fs.existsSync(hooksPath), false);

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
    });

    assert.strictEqual(result.added, COPILOT_HOOK_EVENTS.length);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.configChanged, true);

    const settings = readJson(hooksPath);
    assert.strictEqual(settings.version, 1);
    for (const event of COPILOT_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]), `missing ${event}`);
      assert.strictEqual(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      assert.strictEqual(entry.type, "command");
      assert.strictEqual(entry.timeoutSec, TIMEOUT_SEC);
      assert.ok(entry.bash.includes("/usr/local/bin/node"));
      assert.ok(entry.bash.includes("/srv/clawd/hooks/copilot-hook.js"));
      assert.ok(entry.bash.includes(event));
      assert.ok(entry.powershell.startsWith("& "));
      assert.ok(entry.powershell.includes(event));
    }
  });

  it("registers remote hooks with CLAWD_REMOTE in both platform commands", () => {
    const { homeDir, hooksPath } = makeTempHomeWithCopilot();

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
      remote: true,
    });

    assert.strictEqual(result.added, COPILOT_HOOK_EVENTS.length);

    const settings = readJson(hooksPath);
    for (const event of COPILOT_HOOK_EVENTS) {
      const entry = settings.hooks[event][0];
      assert.ok(entry.bash.startsWith("CLAWD_REMOTE=1 "));
      assert.ok(entry.bash.includes(event));
      assert.ok(entry.powershell.startsWith("$env:CLAWD_REMOTE='1'; & "));
      assert.ok(entry.powershell.includes(event));
    }
  });

  it("remote install defaults to the current Node executable instead of bare node", () => {
    const { homeDir, hooksPath } = makeTempHomeWithCopilot();

    registerCopilotHooks({
      silent: true,
      homeDir,
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
      remote: true,
    });

    const entry = readJson(hooksPath).hooks.sessionStart[0];
    assert.ok(entry.bash.includes(`"${process.execPath.replace(/"/g, '\\"')}"`));
    assert.ok(!entry.bash.startsWith('CLAWD_REMOTE=1 "node" '));
  });

  it("is idempotent on second run (no rewrite when state matches)", () => {
    const { homeDir, hooksPath } = makeTempHomeWithCopilot();
    registerCopilotHooks({ silent: true, homeDir, nodeBin: "node", hookScript: "/p/copilot-hook.js" });
    const before = fs.readFileSync(hooksPath, "utf8");
    const beforeMtime = fs.statSync(hooksPath).mtimeMs;

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "node",
      hookScript: "/p/copilot-hook.js",
    });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, COPILOT_HOOK_EVENTS.length);
    assert.strictEqual(result.configChanged, false);
    assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
    // configChanged false → writeJsonAtomic skipped → mtime preserved
    assert.strictEqual(fs.statSync(hooksPath).mtimeMs, beforeMtime);
  });

  it("updates the Clawd entry when the hook script path changes (no append)", () => {
    const { homeDir, hooksPath } = makeTempHomeWithCopilot();
    registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "node",
      hookScript: "/old/copilot-hook.js",
    });

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "node",
      hookScript: "/new/copilot-hook.js",
    });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, COPILOT_HOOK_EVENTS.length);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.configChanged, true);

    const settings = readJson(hooksPath);
    for (const event of COPILOT_HOOK_EVENTS) {
      assert.strictEqual(settings.hooks[event].length, 1, `${event} should not be appended`);
      const entry = settings.hooks[event][0];
      assert.ok(entry.bash.includes("/new/copilot-hook.js"));
      assert.ok(!entry.bash.includes("/old/copilot-hook.js"));
    }
  });

  it("preserves user-authored entries that don't reference copilot-hook.js", () => {
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: {
        sessionStart: [
          { type: "command", bash: "echo my-custom-hook", powershell: "echo my-custom-hook" },
        ],
        userPromptSubmitted: [
          { type: "command", bash: "/usr/bin/say hello", powershell: "Write-Host hello" },
        ],
      },
    });

    registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "node",
      hookScript: "/x/copilot-hook.js",
    });

    const settings = readJson(hooksPath);
    // User entries preserved, Clawd entry appended
    assert.strictEqual(settings.hooks.sessionStart.length, 2);
    assert.ok(settings.hooks.sessionStart.some((e) => e.bash === "echo my-custom-hook"));
    assert.ok(settings.hooks.sessionStart.some((e) => e.bash.includes(MARKER)));

    assert.strictEqual(settings.hooks.userPromptSubmitted.length, 2);
    assert.ok(settings.hooks.userPromptSubmitted.some((e) => e.bash === "/usr/bin/say hello"));
    assert.ok(settings.hooks.userPromptSubmitted.some((e) => e.bash.includes(MARKER)));
  });

  it("updates the existing Clawd entry in place when other entries are present", () => {
    const customSession = { type: "command", bash: "echo custom", powershell: "echo custom" };
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: {
        sessionStart: [
          customSession,
          {
            type: "command",
            bash: '"node" "/old/copilot-hook.js" "sessionStart"',
            powershell: '& "node" "/old/copilot-hook.js" "sessionStart"',
            timeoutSec: 5,
          },
        ],
      },
    });

    registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "node",
      hookScript: "/new/copilot-hook.js",
    });

    const settings = readJson(hooksPath);
    assert.strictEqual(settings.hooks.sessionStart.length, 2);
    // Custom entry untouched and still first
    assert.deepStrictEqual(settings.hooks.sessionStart[0], customSession);
    // Clawd entry updated in place at index 1, not appended at index 2
    assert.ok(settings.hooks.sessionStart[1].bash.includes("/new/copilot-hook.js"));
    assert.ok(!settings.hooks.sessionStart[1].bash.includes("/old/copilot-hook.js"));
  });

  it("skips registration when ~/.copilot does not exist on the target machine", () => {
    const { homeDir } = makeTempHomeWithoutCopilot();
    const result = registerCopilotHooks({ silent: true, homeDir });

    assert.deepStrictEqual(result, { added: 0, updated: 0, skipped: 0, configChanged: false });
    // No ~/.copilot/ dir was created as a side effect
    assert.strictEqual(fs.existsSync(path.join(homeDir, ".copilot")), false);
  });

  it("normalizes invalid pre-existing settings shapes (non-object hooks, missing version)", () => {
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      hooks: "not-an-object",
    });

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "node",
      hookScript: "/p/copilot-hook.js",
    });

    assert.strictEqual(result.added, COPILOT_HOOK_EVENTS.length);
    const settings = readJson(hooksPath);
    assert.strictEqual(settings.version, 1);
    assert.strictEqual(typeof settings.hooks, "object");
    for (const event of COPILOT_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]));
      assert.strictEqual(settings.hooks[event].length, 1);
    }
  });

  it("repairs schema drift on the Clawd entry (e.g., missing powershell, wrong timeoutSec)", () => {
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: "command",
            bash: '"node" "/p/copilot-hook.js" "sessionStart"',
            // powershell missing
            timeoutSec: 99, // wrong timeout
          },
        ],
      },
    });

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "node",
      hookScript: "/p/copilot-hook.js",
    });

    // sessionStart updated; the other 4 events are added
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(result.added, COPILOT_HOOK_EVENTS.length - 1);

    const entry = readJson(hooksPath).hooks.sessionStart[0];
    assert.strictEqual(entry.timeoutSec, TIMEOUT_SEC);
    assert.ok(typeof entry.powershell === "string" && entry.powershell.length > 0);
  });

  it("recognizes legacy entries that only use the powershell field", () => {
    // Edge case: someone wrote a Windows-only entry; we still detect+normalize it.
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: "command",
            powershell: '& "node" "/old/copilot-hook.js" "sessionStart"',
            timeoutSec: 5,
          },
        ],
      },
    });

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "node",
      hookScript: "/new/copilot-hook.js",
    });

    assert.strictEqual(result.updated, 1);
    const entry = readJson(hooksPath).hooks.sessionStart[0];
    assert.ok(entry.bash.includes("/new/copilot-hook.js"));
    assert.ok(entry.powershell.includes("/new/copilot-hook.js"));
  });

  it("throws a wrapped error when hooks.json is unreadable for non-ENOENT reasons", () => {
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({});
    fs.writeFileSync(hooksPath, "{ invalid json"); // syntax error

    assert.throws(
      () => registerCopilotHooks({ silent: true, homeDir }),
      /Failed to read hooks\.json/
    );
  });
});
