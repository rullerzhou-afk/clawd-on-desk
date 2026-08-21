const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  MARKER,
  CLAUDE_MARKER,
  ZCODE_HOOK_EVENTS,
  buildZcodeHookCommand,
  buildZcodeProcessHook,
  matcherForZcodeEvent,
  registerZcodeHooks,
  unregisterZcodeHooks,
  timeoutMsForZcodeEvent,
} = require("../hooks/zcode-install");
const { decodeWindowsEncodedCommand } = require("../hooks/json-utils");

const tempDirs = [];

function makeTempConfigFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-zcode-"));
  const settingsPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return settingsPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listCleanupBackups(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.clawd-cleanup-`));
}

// On win32 the installer wraps commands in PowerShell -EncodedCommand (mirrors
// the Qwen cmd /s quote-stripping fix). Tests that assert on substrings inside
// the command must decode first.
function commandPayload(command) {
  return decodeWindowsEncodedCommand(command) || command;
}

function hookPayload(hook) {
  if (!hook || typeof hook !== "object") return "";
  if (Array.isArray(hook.args)) return [hook.command, ...hook.args].join(" ");
  return commandPayload(hook.command);
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("ZCode hook installer", () => {
  it("registers all supported events under hooks.events with enabled:true and no matcher", () => {
    const settingsPath = makeTempConfigFile({
      model: "GLM-5.2",
      env: { KEEP: "me" },
    });
    const result = registerZcodeHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.added, ZCODE_HOOK_EVENTS.length);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 0);

    const settings = readJson(settingsPath);
    // Preserves unrelated top-level keys (zcode config.json also holds plugins/mcp).
    assert.strictEqual(settings.model, "GLM-5.2");
    assert.deepStrictEqual(settings.env, { KEEP: "me" });
    // Config-file hooks require hooks.enabled: true (disabled by default).
    assert.strictEqual(settings.hooks.enabled, true);
    // Events nest under hooks.events.* (NOT hooks.* — that fails config load).
    assert.ok(settings.hooks.events, "hooks.events must exist");
    for (const event of ZCODE_HOOK_EVENTS) {
      const entry = settings.hooks.events[event][0];
      // State-only hooks omit the optional match-all matcher because no event
      // needs tool filtering.
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(entry, "matcher"),
        false,
        `${event}: canonical match-all entry should omit matcher`
      );
      assert.strictEqual(entry.hooks.length, 1);
      // ZCode's hook schema is strict: a "name" key makes config.json fail to
      // load. Clawd's entries must NOT carry "name".
      assert.ok(!("name" in entry.hooks[0]), `${event}: hook must not carry "name" (zcode rejects it)`);
      assert.strictEqual(entry.hooks[0].type, "process");
      // timeoutMs (ms), NOT timeout (seconds). `timeout: 30000` would be 8.3h.
      assert.strictEqual(entry.hooks[0].timeoutMs, timeoutMsForZcodeEvent(event));
      const payload = hookPayload(entry.hooks[0]);
      assert.ok(payload.includes(MARKER), `${event}: ${payload}`);
      assert.ok(payload.includes("/usr/local/bin/node"), `${event}: ${payload}`);
      assert.deepStrictEqual(entry.hooks[0].args.slice(-1), [event]);
    }
  });

  it("is idempotent on second run", () => {
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const before = fs.readFileSync(settingsPath, "utf8");

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, ZCODE_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), before);
  });

  it("gives PermissionRequest the long blocking budget while state events stay short", () => {
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.events.PermissionRequest[0].hooks[0].timeoutMs, 600000);
    for (const event of ZCODE_HOOK_EVENTS.filter((e) => e !== "PermissionRequest")) {
      assert.strictEqual(
        settings.hooks.events[event][0].hooks[0].timeoutMs,
        8000,
        `${event}: state hooks keep the 8s budget`
      );
    }
  });

  it("upgrades a Phase 1 install by adding only PermissionRequest, leaving state events untouched", () => {
    // Build the Phase 1 state with the REAL script paths: register once, then
    // delete the PermissionRequest entry the way a Phase 1 install never had it.
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const phase1 = readJson(settingsPath);
    delete phase1.hooks.events.PermissionRequest;
    fs.writeFileSync(settingsPath, JSON.stringify(phase1, null, 2), "utf8");
    const before = fs.readFileSync(settingsPath, "utf8");

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 1);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 6);
    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.events.PermissionRequest[0].hooks[0].timeoutMs, 600000);
    // The six pre-existing state events are byte-identical apart from the new
    // key; re-serialize without PermissionRequest to compare.
    const withoutPermission = readJson(settingsPath);
    delete withoutPermission.hooks.events.PermissionRequest;
    assert.strictEqual(JSON.stringify(withoutPermission, null, 2), before);
  });

  it("rewrites a PermissionRequest entry carrying the stale state timeout to the blocking budget", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          PermissionRequest: [{
            // Simulates a hand-edited or pre-Phase-2 entry: correct shape but
            // the 8s state budget, which would kill the bubble wait early.
            hooks: [buildZcodeProcessHook("/usr/local/bin/node", "/app/hooks/zcode-hook.js", "PermissionRequest")],
          }],
        },
      },
    });
    // Force the stale 8000 explicitly (buildZcodeProcessHook already writes
    // the per-event 600000, so overwrite it the way an old install would).
    const raw = readJson(settingsPath);
    raw.hooks.events.PermissionRequest[0].hooks[0].timeoutMs = 8000;
    fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2), "utf8");

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.updated, 1);
    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.events.PermissionRequest[0].hooks[0].timeoutMs, 600000);
  });

  it("inherits enabled:false for PermissionRequest when every Phase 1 state hook is explicitly disabled", () => {
    // Build the real Phase 1 state (canonical script paths), then disable all
    // six managed state hooks the way the explicit opt-out does.
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const phase1 = readJson(settingsPath);
    delete phase1.hooks.events.PermissionRequest;
    for (const event of Object.keys(phase1.hooks.events)) {
      phase1.hooks.events[event][0].hooks[0].enabled = false;
    }
    fs.writeFileSync(settingsPath, JSON.stringify(phase1, null, 2), "utf8");

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    // The new blocking hook must NOT silently re-enter the loop enabled.
    assert.strictEqual(result.added, 1);
    const settings = readJson(settingsPath);
    const permissionHook = settings.hooks.events.PermissionRequest[0].hooks[0];
    assert.strictEqual(permissionHook.enabled, false);
    assert.strictEqual(permissionHook.timeoutMs, 600000);
    // The six state hooks stay disabled too.
    for (const event of Object.keys(phase1.hooks.events)) {
      assert.strictEqual(settings.hooks.events[event][0].hooks[0].enabled, false, event);
    }
    assert.ok(
      result.warnings.some((w) => w.includes("remain disabled") && w.includes("PermissionRequest")),
      `expected a disabled-events warning covering PermissionRequest, got: ${JSON.stringify(result.warnings)}`
    );
  });

  it("does NOT inherit the opt-out when any Phase 1 state hook is still enabled", () => {
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const phase1 = readJson(settingsPath);
    delete phase1.hooks.events.PermissionRequest;
    for (const event of Object.keys(phase1.hooks.events)) {
      phase1.hooks.events[event][0].hooks[0].enabled = false;
    }
    // One state hook stays enabled → the strict opt-out condition fails.
    phase1.hooks.events.Stop[0].hooks[0].enabled = undefined;
    delete phase1.hooks.events.Stop[0].hooks[0].enabled;
    fs.writeFileSync(settingsPath, JSON.stringify(phase1, null, 2), "utf8");

    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.notStrictEqual(settings.hooks.events.PermissionRequest[0].hooks[0].enabled, false);
  });

  it("does NOT infer a six-event opt-out from a partial Phase 1 install", () => {
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const phase1 = readJson(settingsPath);
    delete phase1.hooks.events.PermissionRequest;
    for (const event of Object.keys(phase1.hooks.events)) {
      phase1.hooks.events[event][0].hooks[0].enabled = false;
    }
    // A missing managed event means this is not the complete Phase 1 opt-out
    // signature. Sync repairs that state event as enabled, so the new blocking
    // hook must also stay enabled.
    delete phase1.hooks.events.PostToolUseFailure;
    fs.writeFileSync(settingsPath, JSON.stringify(phase1, null, 2), "utf8");

    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.notStrictEqual(
      settings.hooks.events.PermissionRequest[0].hooks[0].enabled,
      false
    );
    assert.notStrictEqual(
      settings.hooks.events.PostToolUseFailure[0].hooks[0].enabled,
      false
    );
  });

  it("disables an already-installed PermissionRequest when the user later opts out of all state hooks", () => {
    // The opt-out must hold in both directions: state hooks disabled AFTER the
    // blocking hook was installed must also disable that installed hook.
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const config = readJson(settingsPath);
    for (const event of Object.keys(config.hooks.events)) {
      if (event === "PermissionRequest") continue;
      config.hooks.events[event][0].hooks[0].enabled = false;
    }
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2), "utf8");

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.events.PermissionRequest[0].hooks[0].enabled, false);
    assert.ok(
      result.warnings.some((w) => w.includes("remain disabled") && w.includes("PermissionRequest")),
      `expected the disabled-events warning to cover PermissionRequest, got: ${JSON.stringify(result.warnings)}`
    );

    // Idempotent: a second run leaves the disabled hook untouched.
    const before = fs.readFileSync(settingsPath, "utf8");
    const rerun = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), before);
    assert.strictEqual(rerun.updated, 0);
  });

  it("never registers the blocking hook over a foreign PermissionRequest hook (last-wins deny override)", () => {
    const foreignEntry = {
      // A user's own security hook that returns deny for dangerous tools.
      hooks: [{ type: "process", command: "/usr/local/bin/node", args: ["/Users/dev/security-hook.js", "PermissionRequest"], timeoutMs: 30000 }],
    };
    const settingsPath = makeTempConfigFile({
      hooks: { enabled: true, events: { PermissionRequest: [foreignEntry] } },
    });

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    // Clawd's blocking hook was NOT added next to the foreign hook: ZCode runs
    // same-event hooks serially with last-wins decisions, so a later Clawd
    // allow would override the security hook's deny. The six state events are
    // still registered normally.
    assert.deepStrictEqual(settings.hooks.events.PermissionRequest, [foreignEntry]);
    assert.ok(Array.isArray(settings.hooks.events.SessionStart));
    assert.ok(
      result.warnings.some((w) => w.includes("foreign PermissionRequest hook") && w.includes("NOT registered")),
      `expected the conflict warning, got: ${JSON.stringify(result.warnings)}`
    );
  });

  it("treats a nested non-command PermissionRequest hook as a foreign owner", () => {
    const foreignEntry = {
      hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 }],
    };
    const settingsPath = makeTempConfigFile({
      hooks: { enabled: true, events: { PermissionRequest: [foreignEntry] } },
    });

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.deepStrictEqual(settings.hooks.events.PermissionRequest, [foreignEntry]);
    assert.ok(
      result.warnings.some((w) => w.includes("foreign PermissionRequest hook") && w.includes("NOT registered")),
      `expected the conflict warning, got: ${JSON.stringify(result.warnings)}`
    );
  });

  it("removes Clawd's managed hook when a foreign PermissionRequest hook appears later", () => {
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const config = readJson(settingsPath);
    config.hooks.events.PermissionRequest.push({
      hooks: [{ type: "process", command: "/usr/local/bin/node", args: ["/Users/dev/security-hook.js", "PermissionRequest"], timeoutMs: 30000 }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2), "utf8");

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.events.PermissionRequest.length, 1);
    assert.strictEqual(
      settings.hooks.events.PermissionRequest[0].hooks[0].args[0],
      "/Users/dev/security-hook.js"
    );
    assert.ok(
      result.warnings.some((w) => w.includes("removed Clawd's blocking permission hook")),
      `expected the fail-closed removal warning, got: ${JSON.stringify(result.warnings)}`
    );
  });

  it("preserves an explicit hooks.enabled:false and warns instead of enabling all user hooks", () => {
    const settingsPath = makeTempConfigFile({ hooks: { enabled: false } });

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.enabled, false);
    assert.strictEqual(Object.keys(settings.hooks.events).length, ZCODE_HOOK_EVENTS.length);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /hooks\.enabled=false/);
  });

  it("preserves nested enabled:false while repairing a stale managed hook", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{
            hooks: [{
              type: "command",
              command: '"/old/node" "/old/path/zcode-hook.js" "PreToolUse"',
              timeout: 30000,
              enabled: false,
            }],
          }],
        },
      },
    });

    const result = registerZcodeHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    const settings = readJson(settingsPath);
    const hook = settings.hooks.events.PreToolUse[0].hooks[0];
    assert.strictEqual(hook.enabled, false);
    assert.strictEqual(hook.timeoutMs, timeoutMsForZcodeEvent());
    assert.strictEqual(hook.type, "process");
    assert.strictEqual(hook.command, "/usr/local/bin/node");
    assert.ok(hook.args[0].includes(MARKER));
    assert.ok(result.warnings.some((warning) => /PreToolUse/.test(warning)));
  });

  it("removes invalid entry-level enabled:false instead of treating it as a supported opt-out", () => {
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const settings = readJson(settingsPath);
    settings.hooks.events.PreToolUse[0].enabled = false;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    const result = registerZcodeHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    const repaired = readJson(settingsPath).hooks.events.PreToolUse[0];
    assert.strictEqual(Object.prototype.hasOwnProperty.call(repaired, "enabled"), false);
    assert.notStrictEqual(repaired.hooks[0].enabled, false);
    assert.ok(result.updated >= 1);
  });

  it("keeps a managed event enabled when any duplicate was still enabled", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          Stop: [
            {
              hooks: [{
                type: "command",
                command: '"/old/node" "/old/path/zcode-hook.js" "Stop"',
                enabled: false,
              }],
            },
            {
              hooks: [{
                type: "command",
                command: '"/old/node" "/old/path/zcode-hook.js" "Stop"',
              }],
            },
          ],
        },
      },
    });

    const result = registerZcodeHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    const settings = readJson(settingsPath);
    const managed = settings.hooks.events.Stop
      .flatMap((entry) => entry.hooks || [])
      .filter((hook) => hookPayload(hook).includes(MARKER));
    assert.strictEqual(managed.length, 1);
    assert.notStrictEqual(managed[0].enabled, false);
    assert.ok(!result.warnings.some((warning) => /remain disabled/.test(warning)));
  });

  it("splits Clawd out of shared matcher entries under hooks.events", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [
              { type: "command", command: "other-tool", name: "other" },
              { type: "command", command: '"/old/node" "/old/path/zcode-hook.js" "PreToolUse"', name: "clawd" },
            ],
          }],
        },
      },
    });

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.ok(result.updated >= 1);
    const settings = readJson(settingsPath);
    // The user's matcher-scoped entry is preserved without Clawd.
    assert.deepStrictEqual(settings.hooks.events.PreToolUse[0], {
      matcher: "Bash",
      hooks: [{ type: "command", command: "other-tool", name: "other" }],
    });
    // Clawd's own entry omits the matcher (state-only = match all).
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(settings.hooks.events.PreToolUse[1], "matcher"),
      false
    );
    assert.ok(hookPayload(settings.hooks.events.PreToolUse[1].hooks[0]).includes("/usr/local/bin/node"));
  });

  it("preserves existing absolute node path when detection fails", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          Stop: [{
            hooks: [{
              type: "command",
              command: '"/home/user/.nvm/versions/node/v22/bin/node" "/old/path/zcode-hook.js" "Stop"',
              name: "clawd",
            }],
          }],
        },
      },
    });

    registerZcodeHooks({ silent: true, settingsPath, nodeBin: null });

    const settings = readJson(settingsPath);
    assert.strictEqual(
      settings.hooks.events.Stop[0].hooks[0].command,
      "/home/user/.nvm/versions/node/v22/bin/node"
    );
  });

  it("refuses a fresh install when no absolute Node executable can be resolved", () => {
    const settingsPath = makeTempConfigFile({});

    assert.throws(
      () => registerZcodeHooks({ silent: true, settingsPath, nodeBin: null }),
      /absolute Node executable path is required/
    );
    assert.deepStrictEqual(readJson(settingsPath), {});
  });

  it("skips startup auto-sync when ~/.zcode does not exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-zcode-home-"));
    tempDirs.push(tmpDir);

    const result = registerZcodeHooks({ silent: true, homeDir: tmpDir, nodeBin: "/usr/local/bin/node" });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0, warnings: [] });
    assert.strictEqual(fs.existsSync(path.join(tmpDir, ".zcode", "cli", "config.json")), false);
  });

  it("builds Windows process hooks with direct argv and no shell quoting", () => {
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const hook = buildZcodeProcessHook(
      nodeBin,
      "D:/clawd/hooks/zcode-hook.js",
      "Stop"
    );

    assert.deepStrictEqual(hook, {
      type: "process",
      command: nodeBin,
      args: ["D:/clawd/hooks/zcode-hook.js", "Stop"],
      timeoutMs: 8000,
    });
  });

  it("rewrites legacy bare-quoted Windows commands into process form on re-run", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{
            matcher: "*",
            hooks: [{
              name: "clawd",
              type: "command",
              command: '"C:\\Program Files\\nodejs\\node.exe" "D:/animation/hooks/zcode-hook.js" "PreToolUse"',
              timeout: 30000,
            }],
          }],
        },
      },
    });

    const result = registerZcodeHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    assert.ok(result.updated >= 1, "legacy bare command must be replaced");
    const settings = readJson(settingsPath);
    const entry = settings.hooks.events.PreToolUse[0].hooks[0];
    assert.strictEqual(entry.type, "process");
    assert.strictEqual(entry.command, "C:\\Program Files\\nodejs\\node.exe");
    assert.ok(entry.args[0].includes(MARKER));
    assert.strictEqual(entry.args[1], "PreToolUse");
    // Migration: the pre-fix form carried `name` + `timeout: 30000` (8.3h under
    // zcode's seconds-semantics). A re-run must strip `name` (zcode rejects it)
    // and rewrite to `timeoutMs` (ms).
    assert.ok(!("name" in entry), "legacy `name` key must be stripped on rewrite");
    assert.strictEqual(entry.timeoutMs, timeoutMsForZcodeEvent());
    assert.ok(!("timeout" in entry), "legacy `timeout` (seconds) must be removed in favor of `timeoutMs`");
  });

  it("rewrites a legacy EncodedCommand in place without leaving a duplicate", () => {
    const legacy = buildZcodeHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "D:/animation/hooks/zcode-hook.js",
      "Stop",
      {
        platform: "win32",
        powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      }
    );
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          Stop: [{
            hooks: [{
              type: "command",
              command: legacy,
              timeoutMs: 30000,
            }],
          }],
        },
      },
    });

    const result = registerZcodeHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
    });

    assert.ok(result.updated >= 1);
    const managed = readJson(settingsPath).hooks.events.Stop
      .flatMap((entry) => entry.hooks || [])
      .filter((hook) => hookPayload(hook).includes(MARKER));
    assert.strictEqual(managed.length, 1);
    assert.deepStrictEqual(managed[0], {
      type: "process",
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [managed[0].args[0], "Stop"],
      timeoutMs: 8000,
    });
  });

  it("preserves an existing Windows absolute node path through process migration", () => {
    // First install pins a Windows node path. A second run with nodeBin:null
    // must reuse that path (not fall back to "node") via the events-aware
    // extractor. Uses the current desired form so the entry is skipped intact.
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "C:\\Tools\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    const before = readJson(settingsPath);
    const stopBefore = before.hooks.events.Stop[0].hooks[0];
    assert.strictEqual(stopBefore.command, "C:\\Tools\\node.exe");
    assert.strictEqual(stopBefore.type, "process");

    const result = registerZcodeHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: null,
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    assert.strictEqual(result.skipped, ZCODE_HOOK_EVENTS.length);
    const after = readJson(settingsPath);
    assert.strictEqual(after.hooks.events.Stop[0].hooks[0].command, "C:\\Tools\\node.exe");
  });

  it("unregister removes encoded Clawd commands while preserving user hooks", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{
            matcher: "*",
            hooks: [
              {
                name: "clawd",
                type: "command",
                command: buildZcodeHookCommand(
                  "C:\\Tools\\node.exe",
                  "D:/clawd/hooks/zcode-hook.js",
                  "PreToolUse",
                  { platform: "win32" }
                ),
                timeoutMs: 30000,
              },
              { name: "user", type: "command", command: "echo keep", timeout: 30 },
            ],
          }],
          Stop: [{
            hooks: [{ name: "user", type: "command", command: "echo stop", timeout: 30 }],
          }],
        },
      },
    });

    const result = unregisterZcodeHooks({ silent: true, settingsPath, backup: true });

    assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.changed, true);
    const settings = readJson(settingsPath);
    // PreToolUse keeps the user hook (Clawd removed).
    assert.deepStrictEqual(settings.hooks.events.PreToolUse, [{
      matcher: "*",
      hooks: [{ name: "user", type: "command", command: "echo keep", timeout: 30 }],
    }]);
    // Stop's user hook untouched.
    assert.deepStrictEqual(settings.hooks.events.Stop, [{
      hooks: [{ name: "user", type: "command", command: "echo stop", timeout: 30 }],
    }]);
    // enabled flag preserved (other config-file hooks remain).
    assert.strictEqual(settings.hooks.enabled, true);
    assert.strictEqual(listCleanupBackups(settingsPath).length, 1);
  });

  it("unregister removes a process hook from a shared wrapper and preserves the user hook", () => {
    const managed = buildZcodeProcessHook(
      "C:\\Program Files\\nodejs\\node.exe",
      "D:/clawd/hooks/zcode-hook.js",
      "PreToolUse"
    );
    const userHook = { name: "user", type: "command", command: "echo keep", timeout: 30 };
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{
            matcher: "*",
            hooks: [managed, userHook],
          }],
        },
      },
    });

    const result = unregisterZcodeHooks({ silent: true, settingsPath });

    assert.strictEqual(result.removed, 1);
    assert.deepStrictEqual(readJson(settingsPath).hooks.events.PreToolUse, [{
      matcher: "*",
      hooks: [userHook],
    }]);
  });

  it("unregister drops the empty hooks wrapper when Clawd was the only source", () => {
    const settingsPath = makeTempConfigFile({
      plugins: { "keep-me": { enabled: true } },
    });
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const result = unregisterZcodeHooks({ silent: true, settingsPath });

    assert.ok(result.changed);
    const settings = readJson(settingsPath);
    // hooks wrapper fully cleaned up (no stale enabled/events), unrelated keys kept.
    assert.strictEqual(settings.hooks, undefined);
    assert.deepStrictEqual(settings.plugins, { "keep-me": { enabled: true } });
  });

  it("unregister preserves the user's explicit global disabled setting", () => {
    const settingsPath = makeTempConfigFile({
      hooks: { enabled: false },
      plugins: { "keep-me": { enabled: true } },
    });
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const result = unregisterZcodeHooks({ silent: true, settingsPath });

    assert.ok(result.changed);
    const settings = readJson(settingsPath);
    assert.deepStrictEqual(settings.hooks, { enabled: false });
    assert.deepStrictEqual(settings.plugins, { "keep-me": { enabled: true } });
  });
});

// #734: if a user imports their Claude config into ZCode (via ZCode's Hooks
// settings), Clawd's Claude hook (clawd-hook.js) lands in ~/.zcode/cli/config.json.
// Because clawd-hook.js hardcodes agent_id="claude-code", a real ZCode session
// would then ALSO spawn a mis-attributed Claude-Code session. The installer must
// strip ONLY those Clawd-owned Claude entries, preserve third-party hooks, and
// never touch ~/.claude/settings.json.
describe("ZCode #734 — strip Claude-config hooks migrated into zcode config", () => {
  // A Claude-imported clawd-hook.js entry (the form install.js writes, minus the
  // zcode-specific wrapper). It carries the "clawd-hook.js" marker.
  function claudeHookCommand(event) {
    return `"/usr/local/bin/node" "/some/path/clawd-hook.js" ${event}`;
  }

  it("removes a dedicated clawd-hook.js entry and reports it, leaving zcode-hook.js as the only Clawd hook", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: claudeHookCommand("SessionStart") }] }],
        },
      },
    });

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.migratedClaudeHooks, 1, "must report the stripped Claude hook");
    const settings = readJson(settingsPath);
    // SessionStart now holds only the zcode hook (the dedicated Claude entry was removed).
    const hooks = settings.hooks.events.SessionStart.flatMap((e) => e.hooks);
    assert.strictEqual(hooks.length, 1);
    assert.ok(hookPayload(hooks[0]).includes(MARKER));
    assert.ok(!hookPayload(hooks[0]).includes(CLAUDE_MARKER));
  });

  it("splits a shared entry: drops clawd-hook.js, keeps a third-party hook, then adds the zcode hook", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [
              { type: "command", command: "echo third-party" },
              { type: "command", command: claudeHookCommand("PreToolUse") },
            ],
          }],
        },
      },
    });

    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    const entries = settings.hooks.events.PreToolUse;
    // The user's matcher-scoped third-party hook survives, minus clawd-hook.js.
    assert.deepStrictEqual(entries[0], {
      matcher: "Bash",
      hooks: [{ type: "command", command: "echo third-party" }],
    });
    // The zcode hook is added as its own matcherless entry.
    const zcodeEntry = entries.find((e) => !e.matcher);
    assert.ok(zcodeEntry, "zcode hook entry must exist");
    assert.ok(hookPayload(zcodeEntry.hooks[0]).includes(MARKER));
    // No clawd-hook.js remains anywhere under events.
    const allCommands = JSON.stringify(settings.hooks.events);
    assert.ok(!allCommands.includes(CLAUDE_MARKER), "no clawd-hook.js must remain");
  });

  it("strips a Windows EncodedCommand clawd-hook.js entry migrated from Claude", () => {
    // Reuse the Windows wrapper to build an encoded clawd-hook.js command.
    const encodedClaudeCommand = buildZcodeHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "D:/claude/hooks/clawd-hook.js", // NOTE: claude marker, not zcode
      "Stop",
      { platform: "win32", powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }
    );
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          Stop: [{ hooks: [{ type: "command", command: encodedClaudeCommand }] }],
        },
      },
    });

    const result = registerZcodeHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    assert.ok(result.migratedClaudeHooks >= 1);
    const settings = readJson(settingsPath);
    const allCommands = JSON.stringify(settings.hooks.events);
    assert.ok(!decodeWindowsEncodedCommand(allCommands) || !allCommands.includes("clawd-hook.js"));
    // zcode hook present.
    const stopHooks = settings.hooks.events.Stop.flatMap((e) => e.hooks);
    assert.ok(stopHooks.some((hook) => hookPayload(hook).includes(MARKER)));
  });

  it("does not touch ~/.claude/settings.json (only the zcode config is modified)", () => {
    // Sanity: the installer takes a single settingsPath scoped to the zcode
    // config; it has no path to ~/.claude. Encode that as a structural check:
    // a Claude marker in an unrelated top-level key is left alone.
    const settingsPath = makeTempConfigFile({
      hooks: { enabled: true, events: {} },
      // An unrelated reference to the claude marker that is NOT a hook command
      // must not be touched (only hook commands under hooks.events.* are scoped).
      notes: "see clawd-hook.js docs",
    });

    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.notes, "see clawd-hook.js docs");
  });

  it("unregister also removes migrated clawd-hook.js entries", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          SessionStart: [
            { hooks: [{ type: "command", command: claudeHookCommand("SessionStart") }] },
            { hooks: [{ type: "command", command: "echo keep" }] },
          ],
        },
      },
    });

    const result = unregisterZcodeHooks({ silent: true, settingsPath });

    assert.ok(result.changed);
    assert.ok(result.removed >= 1, "the migrated Claude hook counts as removed");
    const settings = readJson(settingsPath);
    // Third-party hook preserved; clawd-hook.js gone.
    const sessionCommands = settings.hooks.events.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
    assert.deepStrictEqual(sessionCommands, ["echo keep"]);
  });
});
