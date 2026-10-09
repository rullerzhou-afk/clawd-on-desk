const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  COPILOT_HOOK_EVENTS,
  COPILOT_STATE_HOOK_EVENTS,
  COPILOT_PERMISSION_HOOK_EVENTS,
  TIMEOUT_SEC,
  STATE_TIMEOUT_SEC,
  PERMISSION_TIMEOUT_SEC,
  buildCopilotHookCommands,
  buildCopilotHookEntry,
  registerCopilotHooks,
  resolveCopilotHome,
  resolveCopilotHooksPath,
  unregisterCopilotHooks,
  isCopilotPermissionRegistrable,
  hasUserPermissionHookInOtherFiles,
  hasUserPermissionHookInSettingsJson,
  timeoutSecForCopilotEvent,
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

function listCleanupBackups(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes(".clawd-cleanup-") && name.endsWith(".bak"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("COPILOT_HOOK_EVENTS", () => {
  it("state events stay exactly 10 (Clawd EVENT_TO_STATE coverage)", () => {
    assert.strictEqual(COPILOT_STATE_HOOK_EVENTS.length, 10);
    for (const event of [
      "sessionStart", "userPromptSubmitted", "preToolUse", "postToolUse", "sessionEnd",
      "errorOccurred", "agentStop", "subagentStart", "subagentStop", "preCompact",
    ]) {
      assert.ok(COPILOT_STATE_HOOK_EVENTS.includes(event), `missing state event ${event}`);
    }
  });

  it("permission events include permissionRequest", () => {
    assert.ok(COPILOT_PERMISSION_HOOK_EVENTS.includes("permissionRequest"));
  });

  it("combined COPILOT_HOOK_EVENTS = state + permission (11 entries)", () => {
    assert.strictEqual(COPILOT_HOOK_EVENTS.length, 11);
    for (const event of [...COPILOT_STATE_HOOK_EVENTS, ...COPILOT_PERMISSION_HOOK_EVENTS]) {
      assert.ok(COPILOT_HOOK_EVENTS.includes(event), `missing combined event ${event}`);
    }
  });

  it("permission events do not overlap with state events", () => {
    for (const event of COPILOT_PERMISSION_HOOK_EVENTS) {
      assert.ok(!COPILOT_STATE_HOOK_EVENTS.includes(event), `${event} cannot be both state and permission`);
    }
  });
});

describe("timeoutSecForCopilotEvent", () => {
  it("returns STATE_TIMEOUT_SEC (5) for every state event", () => {
    for (const event of COPILOT_STATE_HOOK_EVENTS) {
      assert.strictEqual(timeoutSecForCopilotEvent(event), STATE_TIMEOUT_SEC);
    }
    assert.strictEqual(STATE_TIMEOUT_SEC, 5);
  });

  it("returns PERMISSION_TIMEOUT_SEC (600) for permissionRequest", () => {
    assert.strictEqual(timeoutSecForCopilotEvent("permissionRequest"), PERMISSION_TIMEOUT_SEC);
    assert.strictEqual(PERMISSION_TIMEOUT_SEC, 600);
  });

  it("TIMEOUT_SEC is preserved as a backward-compat alias of STATE_TIMEOUT_SEC", () => {
    assert.strictEqual(TIMEOUT_SEC, STATE_TIMEOUT_SEC);
  });
});

describe("isCopilotPermissionRegistrable", () => {
  it("allows registration when permission event has no entries yet", () => {
    assert.strictEqual(isCopilotPermissionRegistrable([]), true);
    assert.strictEqual(isCopilotPermissionRegistrable(undefined), true);
  });

  it("allows update when only Clawd-managed entries are present", () => {
    const arr = [
      { type: "command", bash: "node \"path/copilot-hook.js\" \"permissionRequest\"", powershell: "..." },
    ];
    assert.strictEqual(isCopilotPermissionRegistrable(arr), true);
  });

  it("refuses registration when a non-Clawd entry exists (safe-v1)", () => {
    const arr = [
      { type: "command", bash: "/usr/bin/user-audit-hook --deny-dangerous", powershell: "..." },
    ];
    assert.strictEqual(isCopilotPermissionRegistrable(arr), false);
  });

  it("refuses registration even if a Clawd entry sits alongside a user entry", () => {
    const arr = [
      { type: "command", bash: "node \"path/copilot-hook.js\" \"permissionRequest\"" },
      { type: "command", bash: "/usr/bin/user-audit-hook" },
    ];
    assert.strictEqual(isCopilotPermissionRegistrable(arr), false);
  });
});

describe("hasUserPermissionHookInOtherFiles", () => {
  // Copilot CLI loads every *.json in ~/.copilot/hooks/, not just hooks.json.
  // Safe-v1 must inspect siblings so a Clawd "allow" can't override a user
  // deny that lives in security-audit.json. See plan v2.2 + codex-review-1.

  function makeTmpHooksDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-copilot-other-hooks-"));
    const hooksDir = path.join(root, "hooks");
    fs.mkdirSync(hooksDir);
    return { root, hooksDir, hooksPath: path.join(hooksDir, "hooks.json") };
  }

  it("returns false when the directory has only hooks.json", () => {
    const { root, hooksDir, hooksPath } = makeTmpHooksDir();
    try {
      fs.writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: { permissionRequest: [{}] } }));
      assert.strictEqual(hasUserPermissionHookInOtherFiles(hooksDir, hooksPath), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns false when sibling files have no permissionRequest", () => {
    const { root, hooksDir, hooksPath } = makeTmpHooksDir();
    try {
      fs.writeFileSync(path.join(hooksDir, "my-team.json"), JSON.stringify({
        version: 1, hooks: { preToolUse: [{ type: "command", bash: "echo state" }] },
      }));
      assert.strictEqual(hasUserPermissionHookInOtherFiles(hooksDir, hooksPath), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns true when ANY sibling file declares a permissionRequest", () => {
    const { root, hooksDir, hooksPath } = makeTmpHooksDir();
    try {
      fs.writeFileSync(path.join(hooksDir, "security-audit.json"), JSON.stringify({
        version: 1, hooks: { permissionRequest: [{ type: "command", bash: "/usr/bin/audit" }] },
      }));
      assert.strictEqual(hasUserPermissionHookInOtherFiles(hooksDir, hooksPath), true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("treats Clawd-marker sibling entries as user-authored (Clawd never writes outside hooks.json)", () => {
    // If a Clawd marker shows up in another file the user must have copy/pasted
    // it — treat conservatively, do not assume we can re-register safely.
    const { root, hooksDir, hooksPath } = makeTmpHooksDir();
    try {
      fs.writeFileSync(path.join(hooksDir, "backup.json"), JSON.stringify({
        version: 1, hooks: { permissionRequest: [{ type: "command", bash: "node copilot-hook.js permissionRequest" }] },
      }));
      assert.strictEqual(hasUserPermissionHookInOtherFiles(hooksDir, hooksPath), true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("ignores non-json files in the hooks directory", () => {
    const { root, hooksDir, hooksPath } = makeTmpHooksDir();
    try {
      fs.writeFileSync(path.join(hooksDir, "README.md"), "permissionRequest: [{}]");
      fs.writeFileSync(path.join(hooksDir, "log.txt"), "ignored");
      assert.strictEqual(hasUserPermissionHookInOtherFiles(hooksDir, hooksPath), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns false when sibling JSON is malformed (transient FS hiccup must not block Clawd)", () => {
    const { root, hooksDir, hooksPath } = makeTmpHooksDir();
    try {
      fs.writeFileSync(path.join(hooksDir, "broken.json"), "{ not valid json");
      assert.strictEqual(hasUserPermissionHookInOtherFiles(hooksDir, hooksPath), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns false when the directory does not exist", () => {
    const result = hasUserPermissionHookInOtherFiles(path.join(os.tmpdir(), "clawd-nope-" + Date.now()), "hooks.json");
    assert.strictEqual(result, false);
  });

  it("parses sibling JSON with a UTF-8 BOM (PowerShell Set-Content default)", () => {
    // Regression: PowerShell's `Set-Content -Encoding utf8` prepends a BOM,
    // which Node's JSON.parse rejects. hasUserPermissionHookInOtherFiles must
    // strip it before parsing so a user-authored sibling file written in
    // PowerShell still triggers safe-v1 instead of silently failing to parse.
    const { root, hooksDir, hooksPath } = makeTmpHooksDir();
    try {
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const body = Buffer.from(JSON.stringify({
        version: 1,
        hooks: { permissionRequest: [{ type: "command", bash: "/usr/local/bin/user-audit" }] },
      }));
      fs.writeFileSync(path.join(hooksDir, "security-audit.json"), Buffer.concat([bom, body]));
      assert.strictEqual(hasUserPermissionHookInOtherFiles(hooksDir, hooksPath), true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("treats an empty permissionRequest array in a sibling as 'no hook' (registrable still allowed)", () => {
    const { root, hooksDir, hooksPath } = makeTmpHooksDir();
    try {
      fs.writeFileSync(path.join(hooksDir, "extras.json"), JSON.stringify({
        version: 1, hooks: { permissionRequest: [] },
      }));
      assert.strictEqual(hasUserPermissionHookInOtherFiles(hooksDir, hooksPath), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("hasUserPermissionHookInSettingsJson", () => {
  // Codex review 3 — Copilot CLI merges inline `hooks` from
  // ~/.copilot/settings.json into the same chain as hooks/*.json. Safe-v1
  // must see those too.
  function makeTmpSettings() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-copilot-settings-"));
    return { root, settingsPath: path.join(root, "settings.json") };
  }

  it("returns false when settings.json is missing", () => {
    const { root, settingsPath } = makeTmpSettings();
    try {
      assert.strictEqual(hasUserPermissionHookInSettingsJson(settingsPath), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns false when settings.json has no inline hooks block", () => {
    const { root, settingsPath } = makeTmpSettings();
    try {
      fs.writeFileSync(settingsPath, JSON.stringify({ disableAllHooks: false }));
      assert.strictEqual(hasUserPermissionHookInSettingsJson(settingsPath), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns false when hooks block has no permissionRequest", () => {
    const { root, settingsPath } = makeTmpSettings();
    try {
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: { preToolUse: [{ type: "command", bash: "echo p" }] },
      }));
      assert.strictEqual(hasUserPermissionHookInSettingsJson(settingsPath), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns true when an inline permissionRequest hook exists", () => {
    const { root, settingsPath } = makeTmpSettings();
    try {
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: { permissionRequest: [{ type: "command", bash: "/usr/bin/audit" }] },
      }));
      assert.strictEqual(hasUserPermissionHookInSettingsJson(settingsPath), true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("parses settings.json written with a UTF-8 BOM", () => {
    const { root, settingsPath } = makeTmpSettings();
    try {
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const body = Buffer.from(JSON.stringify({
        hooks: { permissionRequest: [{ type: "command", bash: "/usr/bin/audit" }] },
      }));
      fs.writeFileSync(settingsPath, Buffer.concat([bom, body]));
      assert.strictEqual(hasUserPermissionHookInSettingsJson(settingsPath), true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns false for malformed settings.json (transient FS hiccup must not block Clawd)", () => {
    const { root, settingsPath } = makeTmpSettings();
    try {
      fs.writeFileSync(settingsPath, "{ not valid json");
      assert.strictEqual(hasUserPermissionHookInSettingsJson(settingsPath), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("treats an empty permissionRequest array as 'no hook'", () => {
    const { root, settingsPath } = makeTmpSettings();
    try {
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: { permissionRequest: [] },
      }));
      assert.strictEqual(hasUserPermissionHookInSettingsJson(settingsPath), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("resolveCopilotHome", () => {
  it("prefers options.copilotHome (trimmed) over env and homeDir", () => {
    const result = resolveCopilotHome({
      copilotHome: "  /opt/custom-copilot  ",
      env: { COPILOT_HOME: "/env/copilot" },
      homeDir: "/home/u",
    });
    assert.strictEqual(result, "/opt/custom-copilot");
  });

  it("uses env.COPILOT_HOME (trimmed) when options.copilotHome is absent", () => {
    const result = resolveCopilotHome({
      env: { COPILOT_HOME: "  /env/copilot  " },
      homeDir: "/home/u",
    });
    assert.strictEqual(result, "/env/copilot");
  });

  it("falls back to homeDir/.copilot when env.COPILOT_HOME is empty string", () => {
    const result = resolveCopilotHome({ env: { COPILOT_HOME: "" }, homeDir: "/home/u" });
    assert.strictEqual(result, path.join("/home/u", ".copilot"));
  });

  it("falls back to homeDir/.copilot when env.COPILOT_HOME is whitespace-only", () => {
    const result = resolveCopilotHome({ env: { COPILOT_HOME: "   \t  " }, homeDir: "/home/u" });
    assert.strictEqual(result, path.join("/home/u", ".copilot"));
  });

  it("falls back to homeDir/.copilot when env is missing", () => {
    const result = resolveCopilotHome({ env: {}, homeDir: "/home/u" });
    assert.strictEqual(result, path.join("/home/u", ".copilot"));
  });
});

describe("resolveCopilotHooksPath", () => {
  it("appends hooks/hooks.json to the resolved copilot home", () => {
    const result = resolveCopilotHooksPath({
      env: { COPILOT_HOME: "/custom" },
      homeDir: "/home/u",
    });
    assert.strictEqual(result, path.join("/custom", "hooks", "hooks.json"));
  });
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
      { remote: true, sshRemote: true }
    );
    assert.strictEqual(
      bash,
      'CLAWD_REMOTE=1 CLAWD_SSH_REMOTE=1 "/usr/bin/node" "/home/u/.claude/hooks/copilot-hook.js" "sessionStart"'
    );
    assert.strictEqual(
      powershell,
      '$env:CLAWD_REMOTE=\'1\'; $env:CLAWD_SSH_REMOTE=\'1\'; & "/usr/bin/node" "/home/u/.claude/hooks/copilot-hook.js" "sessionStart"'
    );
  });

  it("keeps legacy WSL --remote free of SSH secure identity variables", () => {
    const { bash, powershell } = buildCopilotHookCommands(
      "/usr/bin/node",
      "/home/u/.claude/hooks/copilot-hook.js",
      "sessionStart",
      { remote: true, env: {} },
    );
    assert.match(bash, /^CLAWD_REMOTE=1 /);
    assert.doesNotMatch(bash, /CLAWD_SSH_REMOTE|CLAWD_REMOTE_IDENTITY_PATH/);
    assert.match(powershell, /^\$env:CLAWD_REMOTE='1'; & /);
    assert.doesNotMatch(powershell, /CLAWD_SSH_REMOTE|CLAWD_REMOTE_IDENTITY_PATH/);
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
  it("creates hooks.json from scratch with all events on first install", () => {
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
      assert.strictEqual(entry.timeoutSec, timeoutSecForCopilotEvent(event),
        `timeoutSec mismatch for ${event}`);
      assert.ok(entry.bash.includes("/usr/local/bin/node"));
      assert.ok(entry.bash.includes("/srv/clawd/hooks/copilot-hook.js"));
      assert.ok(entry.bash.includes(event));
      assert.ok(entry.powershell.startsWith("& "));
      assert.ok(entry.powershell.includes(event));
    }
    // State events all use STATE_TIMEOUT_SEC.
    for (const event of COPILOT_STATE_HOOK_EVENTS) {
      assert.strictEqual(settings.hooks[event][0].timeoutSec, STATE_TIMEOUT_SEC);
    }
    // permissionRequest uses PERMISSION_TIMEOUT_SEC (long blocking timeout).
    assert.strictEqual(settings.hooks.permissionRequest[0].timeoutSec, PERMISSION_TIMEOUT_SEC);
  });

  it("registers remote hooks with CLAWD_REMOTE in both platform commands", () => {
    const { homeDir, hooksPath } = makeTempHomeWithCopilot();

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
      remote: true,
      sshRemote: true,
    });

    assert.strictEqual(result.added, COPILOT_HOOK_EVENTS.length);

    const settings = readJson(hooksPath);
    for (const event of COPILOT_HOOK_EVENTS) {
      const entry = settings.hooks[event][0];
      assert.ok(entry.bash.startsWith("CLAWD_REMOTE=1 CLAWD_SSH_REMOTE=1 "));
      assert.ok(entry.bash.includes(event));
      assert.ok(entry.powershell.startsWith("$env:CLAWD_REMOTE='1'; $env:CLAWD_SSH_REMOTE='1'; & "));
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

    assert.deepStrictEqual(result, {
      added: 0,
      updated: 0,
      skipped: 0,
      configChanged: false,
      permissionSkippedDueToUserHook: false,
    });
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

  it("recognizes legacy entries that only use the command field (regression: no double-append)", () => {
    // Doctor's findCopilotHookCommandsForEvent already accepts the `command`
    // field (some old configs / SDK ports wrote it instead of bash+powershell).
    // The installer must match that contract or it would append a fresh
    // bash/powershell entry beside the legacy command entry, causing two
    // HTTP posts per Copilot event.
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: "command",
            command: '"/usr/bin/node" "/old/copilot-hook.js" "sessionStart"',
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

    // sessionStart legacy entry recognized → updated (not appended)
    assert.strictEqual(result.updated, 1, "legacy command entry should be updated, not appended");
    // Other 9 events still get added fresh
    assert.strictEqual(result.added, COPILOT_HOOK_EVENTS.length - 1);

    const sessionStart = readJson(hooksPath).hooks.sessionStart;
    assert.strictEqual(sessionStart.length, 1, "no duplicate Clawd entries");
    assert.ok(sessionStart[0].bash.includes("/new/copilot-hook.js"));
    assert.ok(sessionStart[0].powershell.includes("/new/copilot-hook.js"));
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

  it("writes to env.COPILOT_HOME when set, not homeDir/.copilot", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-copilot-home-env-"));
    tempDirs.push(tmpDir);
    const customCopilot = path.join(tmpDir, "custom-cli");
    fs.mkdirSync(path.join(customCopilot, "hooks"), { recursive: true });

    const fakeHome = path.join(tmpDir, "fake-home");
    fs.mkdirSync(fakeHome, { recursive: true });

    const result = registerCopilotHooks({
      silent: true,
      homeDir: fakeHome,
      env: { COPILOT_HOME: customCopilot },
      nodeBin: "node",
      hookScript: "/x/copilot-hook.js",
    });

    assert.strictEqual(result.added, COPILOT_HOOK_EVENTS.length);
    // Hook written into the env-redirected path
    assert.ok(fs.existsSync(path.join(customCopilot, "hooks", "hooks.json")));
    // Not into the default fallback path
    assert.strictEqual(fs.existsSync(path.join(fakeHome, ".copilot", "hooks", "hooks.json")), false);
  });

  it("options.copilotHome wins over env.COPILOT_HOME and homeDir", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-copilot-opt-"));
    tempDirs.push(tmpDir);
    const optHome = path.join(tmpDir, "opt-copilot");
    fs.mkdirSync(path.join(optHome, "hooks"), { recursive: true });
    const envHome = path.join(tmpDir, "env-copilot");
    fs.mkdirSync(path.join(envHome, "hooks"), { recursive: true });
    const fakeHome = path.join(tmpDir, "fake-home");
    fs.mkdirSync(fakeHome, { recursive: true });

    registerCopilotHooks({
      silent: true,
      copilotHome: optHome,
      env: { COPILOT_HOME: envHome },
      homeDir: fakeHome,
      nodeBin: "node",
      hookScript: "/x/copilot-hook.js",
    });

    assert.ok(fs.existsSync(path.join(optHome, "hooks", "hooks.json")));
    assert.strictEqual(fs.existsSync(path.join(envHome, "hooks", "hooks.json")), false);
    assert.strictEqual(fs.existsSync(path.join(fakeHome, ".copilot")), false);
  });

  it("env.COPILOT_HOME='' (empty) falls back to homeDir/.copilot", () => {
    const { homeDir, hooksPath } = makeTempHomeWithCopilot();

    registerCopilotHooks({
      silent: true,
      homeDir,
      env: { COPILOT_HOME: "" },
      nodeBin: "node",
      hookScript: "/x/copilot-hook.js",
    });

    assert.ok(fs.existsSync(hooksPath), "should fall back to default ~/.copilot path");
  });

  it("skips registration when env.COPILOT_HOME points at a missing directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-copilot-env-missing-"));
    tempDirs.push(tmpDir);
    const fakeHome = path.join(tmpDir, "fake-home");
    fs.mkdirSync(fakeHome, { recursive: true });
    const nonexistent = path.join(tmpDir, "nope-copilot");

    const result = registerCopilotHooks({
      silent: true,
      homeDir: fakeHome,
      env: { COPILOT_HOME: nonexistent },
    });

    assert.deepStrictEqual(result, {
      added: 0,
      updated: 0,
      skipped: 0,
      configChanged: false,
      permissionSkippedDueToUserHook: false,
    });
    assert.strictEqual(fs.existsSync(nonexistent), false);
  });

  it("unregister removes stale Clawd markers from any Copilot event", () => {
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: {
        permissionRequest: [
          {
            type: "command",
            bash: '"node" "/x/copilot-hook.js" "permissionRequest"',
            powershell: '& "node" "/x/copilot-hook.js" "permissionRequest"',
            timeoutSec: 600,
          },
          {
            type: "command",
            bash: '"node" "/user/keep.js" "permissionRequest"',
            powershell: '& "node" "/user/keep.js" "permissionRequest"',
            timeoutSec: 600,
          },
        ],
        sessionStart: [
          {
            type: "command",
            bash: '"node" "/x/copilot-hook.js" "sessionStart"',
            powershell: '& "node" "/x/copilot-hook.js" "sessionStart"',
            timeoutSec: TIMEOUT_SEC,
          },
        ],
        userPromptSubmitted: [
          {
            type: "command",
            bash: '"node" "/user/keep.js" "userPromptSubmitted"',
            powershell: '& "node" "/user/keep.js" "userPromptSubmitted"',
            timeoutSec: TIMEOUT_SEC,
          },
        ],
      },
    });

    const result = unregisterCopilotHooks({ silent: true, homeDir, backup: true });
    const settings = readJson(hooksPath);

    assert.strictEqual(result.removed, 2);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(settings.hooks.sessionStart, undefined);
    assert.strictEqual(settings.hooks.permissionRequest.length, 1);
    assert.ok(settings.hooks.permissionRequest[0].bash.includes("/user/keep.js"));
    assert.strictEqual(settings.hooks.userPromptSubmitted.length, 1);
    assert.ok(settings.hooks.userPromptSubmitted[0].bash.includes("/user/keep.js"));
    assert.strictEqual(listCleanupBackups(path.dirname(hooksPath)).length, 1);
  });

  it("safe-v1: leaves permissionRequest untouched when a non-Clawd hook exists", () => {
    const userPermissionHook = {
      type: "command",
      bash: "/usr/local/bin/user-audit-hook.sh",
      powershell: "& 'C:\\tools\\user-audit-hook.ps1'",
      timeoutSec: 30,
    };
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: {
        permissionRequest: [userPermissionHook],
      },
    });

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
    });

    // State events still register fully (10 added). permissionRequest is
    // skipped because of the user-authored entry.
    assert.strictEqual(result.added, COPILOT_STATE_HOOK_EVENTS.length);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.permissionSkippedDueToUserHook, true);

    const settings = readJson(hooksPath);
    assert.strictEqual(settings.hooks.permissionRequest.length, 1);
    assert.deepStrictEqual(settings.hooks.permissionRequest[0], userPermissionHook,
      "user permission hook must be preserved byte-for-byte");
  });

  it("safe-v1: skips permissionRequest when a sibling *.json declares the same event", () => {
    // Cross-file safe-v1: even with an empty (or pure-Clawd) permissionRequest
    // array in hooks.json, the presence of a user hook in any sibling file
    // means appending Clawd here would still inject into the merged hook
    // chain Copilot executes. See codex-review-1 alongside Phase 6 follow-up.
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: {},
    });
    const hooksDir = path.dirname(hooksPath);
    fs.writeFileSync(
      path.join(hooksDir, "security-audit.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          permissionRequest: [{
            type: "command",
            bash: "/usr/local/bin/user-audit-hook.sh",
            timeoutSec: 30,
          }],
        },
      }, null, 2),
      "utf8",
    );

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
    });

    assert.strictEqual(result.added, COPILOT_STATE_HOOK_EVENTS.length);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.permissionSkippedDueToUserHook, true,
      "cross-file safe-v1 must trigger the same skip flag as in-file safe-v1");

    const settings = readJson(hooksPath);
    assert.ok(
      !Array.isArray(settings.hooks.permissionRequest) || settings.hooks.permissionRequest.length === 0,
      "hooks.json permissionRequest array must remain empty when a sibling owns the event",
    );
  });

  it("safe-v1: removes an existing Clawd permissionRequest entry when a user hook appears in hooks.json", () => {
    // Regression for codex-review-2: a previous run left a Clawd entry in
    // hooks.json. The user then added their own deny hook. We must strip
    // the leftover Clawd entry so it can't override the user deny via the
    // "later output wins" semantics. The user entry must be preserved.
    const userHook = {
      type: "command",
      bash: "/usr/local/bin/user-audit.sh",
      timeoutSec: 30,
    };
    const oldClawd = {
      type: "command",
      bash: "\"/old/node\" \"/old/copilot-hook.js\" \"permissionRequest\"",
      powershell: "& \"/old/node\" \"/old/copilot-hook.js\" \"permissionRequest\"",
      timeoutSec: 60,
    };
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: { permissionRequest: [oldClawd, userHook] },
    });

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
    });

    assert.strictEqual(result.permissionSkippedDueToUserHook, true);

    const settings = readJson(hooksPath);
    assert.strictEqual(settings.hooks.permissionRequest.length, 1,
      "the legacy Clawd entry must be removed; only the user entry survives");
    assert.deepStrictEqual(settings.hooks.permissionRequest[0], userHook,
      "user hook must be preserved byte-for-byte");
  });

  it("safe-v1: removes an existing Clawd permissionRequest entry when a sibling *.json declares the event", () => {
    // Same as above but the conflict comes from a different file. The
    // Clawd entry in hooks.json must still be removed because Copilot
    // merges all *.json in the hooks directory.
    const oldClawd = {
      type: "command",
      bash: "\"/old/node\" \"/old/copilot-hook.js\" \"permissionRequest\"",
      powershell: "& \"/old/node\" \"/old/copilot-hook.js\" \"permissionRequest\"",
      timeoutSec: 60,
    };
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: { permissionRequest: [oldClawd] },
    });
    const hooksDir = path.dirname(hooksPath);
    fs.writeFileSync(
      path.join(hooksDir, "security-audit.json"),
      JSON.stringify({
        version: 1,
        hooks: { permissionRequest: [{ type: "command", bash: "/usr/local/bin/user-audit.sh" }] },
      }, null, 2),
      "utf8",
    );

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
    });

    assert.strictEqual(result.permissionSkippedDueToUserHook, true);
    const settings = readJson(hooksPath);
    assert.strictEqual(
      Array.isArray(settings.hooks.permissionRequest) ? settings.hooks.permissionRequest.length : 0,
      0,
      "Clawd entry must be stripped from hooks.json when a sibling file owns the event",
    );
  });

  it("parses hooks.json with a UTF-8 BOM (PowerShell Set-Content default) and applies safe-v1", () => {
    // Regression for codex-review-2 + Phase 9 M10: PowerShell's default
    // `Set-Content -Encoding utf8` prepends a BOM. JSON.parse rejected it,
    // syncCopilotHooks silently swallowed the throw, and the Clawd entry
    // stayed in hooks.json even though safe-v1 should have stripped it.
    const userHook = {
      type: "command",
      bash: "/usr/local/bin/user-audit.sh",
      timeoutSec: 30,
    };
    const oldClawd = {
      type: "command",
      bash: "\"/old/node\" \"/old/copilot-hook.js\" \"permissionRequest\"",
      powershell: "& \"/old/node\" \"/old/copilot-hook.js\" \"permissionRequest\"",
      timeoutSec: 60,
    };
    const { homeDir, hooksPath } = makeTempHomeWithCopilot(undefined);
    // Write hooks.json WITH a BOM, mimicking PowerShell.
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const body = Buffer.from(JSON.stringify({
      version: 1,
      hooks: { permissionRequest: [userHook, oldClawd] },
    }, null, 2));
    fs.writeFileSync(hooksPath, Buffer.concat([bom, body]));

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
    });

    assert.strictEqual(result.permissionSkippedDueToUserHook, true,
      "BOM must not block safe-v1 from triggering");
    const settings = readJson(hooksPath);
    assert.strictEqual(settings.hooks.permissionRequest.length, 1,
      "old Clawd entry must be stripped despite the BOM");
    assert.deepStrictEqual(settings.hooks.permissionRequest[0], userHook);
  });

  it("safe-v1: skips permissionRequest when settings.json declares an inline hook", () => {
    // Codex review 3 — settings.json `hooks` block participates in Copilot's
    // merged hook chain. Installer + doctor must both treat it as user-owned
    // and refuse to register Clawd permissionRequest.
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: {}, // hooks.json clean
    });
    const settingsPath = path.join(homeDir, ".copilot", "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { permissionRequest: [{ type: "command", bash: "/usr/local/bin/inline-audit" }] },
    }, null, 2), "utf8");

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
    });

    assert.strictEqual(result.permissionSkippedDueToUserHook, true,
      "settings.json inline hook must trigger the same skip flag as in-file/sibling safe-v1");
    const settings = readJson(hooksPath);
    assert.ok(
      !Array.isArray(settings.hooks.permissionRequest) || settings.hooks.permissionRequest.length === 0,
      "hooks.json permissionRequest array must remain empty when settings.json owns the event",
    );
  });

  it("safe-v1: strips a leftover Clawd entry when settings.json inline hook appears later", () => {
    const oldClawd = {
      type: "command",
      bash: "\"/old/node\" \"/old/copilot-hook.js\" \"permissionRequest\"",
      powershell: "& \"/old/node\" \"/old/copilot-hook.js\" \"permissionRequest\"",
      timeoutSec: 60,
    };
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: { permissionRequest: [oldClawd] },
    });
    const settingsPath = path.join(homeDir, ".copilot", "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { permissionRequest: [{ type: "command", bash: "/usr/local/bin/inline-audit" }] },
    }, null, 2), "utf8");

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
    });

    assert.strictEqual(result.permissionSkippedDueToUserHook, true);
    const settings = readJson(hooksPath);
    assert.strictEqual(
      Array.isArray(settings.hooks.permissionRequest) ? settings.hooks.permissionRequest.length : 0,
      0,
      "Clawd entry in hooks.json must be stripped when settings.json owns the event",
    );
  });

  it("safe-v1: still updates Clawd-managed permissionRequest entry in place", () => {
    const existingClawd = {
      type: "command",
      bash: "\"/old/node\" \"/old/copilot-hook.js\" \"permissionRequest\"",
      powershell: "& \"/old/node\" \"/old/copilot-hook.js\" \"permissionRequest\"",
      timeoutSec: 60,
    };
    const { homeDir, hooksPath } = makeTempHomeWithCopilot({
      version: 1,
      hooks: { permissionRequest: [existingClawd] },
    });

    const result = registerCopilotHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
      hookScript: "/srv/clawd/hooks/copilot-hook.js",
    });

    assert.strictEqual(result.permissionSkippedDueToUserHook, false);
    const settings = readJson(hooksPath);
    assert.strictEqual(settings.hooks.permissionRequest.length, 1);
    assert.ok(settings.hooks.permissionRequest[0].bash.includes("/usr/local/bin/node"));
    assert.strictEqual(settings.hooks.permissionRequest[0].timeoutSec, PERMISSION_TIMEOUT_SEC);
  });
});
