const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  HOOK_GROUP_ID,
  MARKER,
  ANTIGRAVITY_HOOK_EVENTS,
  registerAntigravityHooks,
  __test,
} = require("../hooks/antigravity-install");

const tempDirs = [];

function makeTempHome({ withConfig = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-antigravity-home-"));
  tempDirs.push(home);
  if (withConfig) fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
  return home;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function decodeEncodedCommand(command) {
  const encoded = command.split(/\s+/).at(-1);
  return Buffer.from(encoded, "base64").toString("utf16le");
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Antigravity hook installer", () => {
  it("installs a managed global hooks file with all hook events", () => {
    const homeDir = makeTempHome();
    const result = registerAntigravityHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
    });

    const configPath = path.join(homeDir, ".gemini", "config", "hooks.json");
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.added, 4);

    const hooks = readJson(configPath);
    assert.ok(hooks[HOOK_GROUP_ID]);
    for (const event of ANTIGRAVITY_HOOK_EVENTS) {
      assert.ok(Array.isArray(hooks[HOOK_GROUP_ID][event]), `missing ${event}`);
      const commands = [];
      for (const entry of hooks[HOOK_GROUP_ID][event]) {
        if (entry.command) commands.push(entry.command);
        if (Array.isArray(entry.hooks)) commands.push(...entry.hooks.map((hook) => hook.command));
      }
      assert.strictEqual(commands.length, 1);
      const commandText = commands[0].includes("-EncodedCommand ")
        ? decodeEncodedCommand(commands[0])
        : commands[0];
      assert.ok(commandText.includes(MARKER));
      assert.ok(commandText.includes(event));
    }
    // D2: PreToolUse intentionally NOT registered.
    assert.strictEqual(hooks[HOOK_GROUP_ID].PreToolUse, undefined);
    assert.strictEqual(hooks[HOOK_GROUP_ID].PostToolUse[0].matcher, "*");
    assert.strictEqual(hooks[HOOK_GROUP_ID].PostToolUse[0].hooks[0].timeout, 10);
  });

  it("is idempotent on second run", () => {
    const homeDir = makeTempHome();
    registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    const result = registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 4);
  });

  it("skips when Antigravity config is absent", () => {
    const homeDir = makeTempHome({ withConfig: false });

    const result = registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.installed, false);
    assert.strictEqual(fs.existsSync(path.join(homeDir, ".gemini", "config")), false);
  });

  it("preserves other hook groups in hooks.json", () => {
    const homeDir = makeTempHome();
    const configPath = path.join(homeDir, ".gemini", "config", "hooks.json");
    fs.writeFileSync(configPath, JSON.stringify({
      existing: {
        PreInvocation: [{ type: "command", command: "echo existing" }],
      },
    }));

    registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    const hooks = readJson(configPath);
    assert.strictEqual(hooks.existing.PreInvocation[0].command, "echo existing");
    assert.ok(hooks[HOOK_GROUP_ID]);
  });

  it("preserves a manually disabled Clawd hook group (enabled:false carries over)", () => {
    const homeDir = makeTempHome();
    const configPath = path.join(homeDir, ".gemini", "config", "hooks.json");
    fs.writeFileSync(configPath, JSON.stringify({ [HOOK_GROUP_ID]: { enabled: false } }));

    registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    const group = readJson(configPath)[HOOK_GROUP_ID];
    assert.strictEqual(group.enabled, false);
    // The flag must carry over, AND the 4 state-only events must still be
    // written so re-enabling later does not require manual hook authoring.
    assert.ok(Array.isArray(group.PreInvocation));
    assert.ok(Array.isArray(group.PostToolUse));
    assert.ok(Array.isArray(group.PostInvocation));
    assert.ok(Array.isArray(group.Stop));
  });

  it("strips a legacy PreToolUse entry even when 4 state hooks already match exactly (D2 migration count edge case)", () => {
    // Non-intuitive path: every state-event entry is byte-identical to what
    // registerAntigravityHooks would write, but the group also carries a
    // legacy PreToolUse. Counts report added=0/updated=0/skipped=4 because
    // ANTIGRAVITY_HOOK_EVENTS no longer includes PreToolUse and is not
    // iterated for it; the overall group JSON still differs, so the writer
    // overwrites the file and the orphan PreToolUse gets removed.
    const homeDir = makeTempHome();
    const configPath = path.join(homeDir, ".gemini", "config", "hooks.json");
    // Seed by first running register so the 4 state events are canonical.
    registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });
    const canonical = readJson(configPath);
    // Inject a legacy PreToolUse alongside the canonical state hooks.
    canonical[HOOK_GROUP_ID].PreToolUse = [{
      matcher: "*",
      hooks: [{ type: "command", command: "& 'node' 'X/antigravity-hook.js' 'PreToolUse'", timeout: 600 }],
    }];
    fs.writeFileSync(configPath, JSON.stringify(canonical));

    const result = registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 4);
    const group = readJson(configPath)[HOOK_GROUP_ID];
    assert.strictEqual(group.PreToolUse, undefined, "legacy PreToolUse must be stripped");
    assert.ok(Array.isArray(group.PreInvocation));
    assert.ok(Array.isArray(group.PostToolUse));
    assert.ok(Array.isArray(group.PostInvocation));
    assert.ok(Array.isArray(group.Stop));
  });

  it("strips a legacy PreToolUse entry on auto-sync (D2 migration)", () => {
    // Simulates a user who installed Clawd before the D2 decision. Their
    // hooks.json has a Clawd-owned PreToolUse entry. Next startup sync
    // must rewrite the clawd group to the new 4-event shape, removing
    // the orphan PreToolUse without manual action.
    const homeDir = makeTempHome();
    const configPath = path.join(homeDir, ".gemini", "config", "hooks.json");
    fs.writeFileSync(configPath, JSON.stringify({
      [HOOK_GROUP_ID]: {
        PreInvocation: [{ type: "command", command: "& 'node' 'X/antigravity-hook.js' 'PreInvocation'", timeout: 10 }],
        PreToolUse: [{
          matcher: "*",
          hooks: [{ type: "command", command: "& 'node' 'X/antigravity-hook.js' 'PreToolUse'", timeout: 600 }],
        }],
        PostToolUse: [{
          matcher: "*",
          hooks: [{ type: "command", command: "& 'node' 'X/antigravity-hook.js' 'PostToolUse'", timeout: 10 }],
        }],
        PostInvocation: [{ type: "command", command: "& 'node' 'X/antigravity-hook.js' 'PostInvocation'", timeout: 10 }],
        Stop: [{ type: "command", command: "& 'node' 'X/antigravity-hook.js' 'Stop'", timeout: 10 }],
      },
    }));

    registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    const group = readJson(configPath)[HOOK_GROUP_ID];
    assert.strictEqual(group.PreToolUse, undefined, "legacy PreToolUse must be removed");
    assert.ok(Array.isArray(group.PreInvocation));
    assert.ok(Array.isArray(group.PostToolUse));
    assert.ok(Array.isArray(group.PostInvocation));
    assert.ok(Array.isArray(group.Stop));
  });

  it("builds Windows PowerShell bridge commands with the event argv", () => {
    const command = __test.buildAntigravityHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "D:/clawd/hooks/antigravity-hook.js",
      "PreToolUse",
      { platform: "win32", powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }
    );

    assert.ok(command.startsWith("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "));
    assert.strictEqual(
      decodeEncodedCommand(command),
      "& 'C:\\Program Files\\nodejs\\node.exe' 'D:/clawd/hooks/antigravity-hook.js' 'PreToolUse'"
    );
  });

  it("uses an absolute node.exe for Windows Antigravity hooks", () => {
    const homeDir = makeTempHome();
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";

    registerAntigravityHooks({
      silent: true,
      homeDir,
      platform: "win32",
      execPath: nodeBin,
      accessSync: (candidate) => {
        if (candidate !== nodeBin) throw new Error(`unexpected access: ${candidate}`);
      },
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    const hooks = readJson(path.join(homeDir, ".gemini", "config", "hooks.json"));
    assert.strictEqual(
      decodeEncodedCommand(hooks[HOOK_GROUP_ID].PreInvocation[0].command),
      `& '${nodeBin}' '${path.resolve(__dirname, "..", "hooks", "antigravity-hook.js").replace(/\\/g, "/")}' 'PreInvocation'`
    );
  });

  it("finds node.exe with where.exe when the installer runs from Electron", () => {
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const resolved = __test.resolveAntigravityNodeBin({
      platform: "win32",
      execPath: "C:\\Program Files\\Clawd\\Clawd.exe",
      execFileSync: () => `${nodeBin}\r\n`,
      accessSync: (candidate) => {
        if (candidate !== nodeBin) throw new Error(`unexpected access: ${candidate}`);
      },
    });

    assert.strictEqual(resolved, nodeBin);
  });

  it("ignores Windows scoop shims through the shared node resolver", () => {
    const resolved = __test.resolveAntigravityNodeBin({
      platform: "win32",
      execPath: "C:\\Program Files\\Clawd\\Clawd.exe",
      execFileSync: () => "C:\\Users\\me\\scoop\\shims\\node.exe\r\n",
      accessSync: () => {},
      env: {
        SystemRoot: "C:\\Windows",
      },
    });

    assert.strictEqual(resolved, null);
  });

  it("preserves an existing Windows node.exe path when detection fails later", () => {
    const homeDir = makeTempHome();
    const nodeBin = "C:\\Tools\\node.exe";
    const options = {
      silent: true,
      homeDir,
      platform: "win32",
      nodeBin,
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    };
    registerAntigravityHooks(options);

    const result = registerAntigravityHooks({
      silent: true,
      homeDir,
      platform: "win32",
      execPath: "C:\\Program Files\\Clawd\\Clawd.exe",
      execFileSync: () => { throw new Error("where failed"); },
      accessSync: () => { throw new Error("missing"); },
      powerShellBin: options.powerShellBin,
    });

    const hooks = readJson(path.join(homeDir, ".gemini", "config", "hooks.json"));
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 4);
    assert.match(decodeEncodedCommand(hooks[HOOK_GROUP_ID].PreInvocation[0].command), /C:\\Tools\\node\.exe/);
  });
});
