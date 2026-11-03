const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  registerHooks, registerHooksAsync, unregisterHooks, unregisterHooksAsync,
  unregisterAutoStart, isAutoStartRegistered, CLAUDE_CORE_HOOK_EVENTS, __test,
} = require("../hooks/install");
const {
  getClaudeHookCommand, claudeHookHasMarker, findHookCommands, extractExistingNodeBin, findManagedClaudeEnvNodeBinCandidates,
} = require("../hooks/json-utils");
const {
  entriesContainCommandMarker, settingsNeedClaudeHookResync, countAllHooks, countThirdPartyHooks,
} = require("../src/claude-settings-watcher");
const { inspectClaudeHookHealth } = require("../src/claude-hook-health");
const { checkAgentIntegrations } = require("../src/doctor-detectors/agent-integrations");
const { getAgentDescriptor } = require("../src/doctor-detectors/agent-descriptors");
const { detectAgentInstallation } = require("../src/agent-installation-detector");
const { AGENT_CLEANERS, buildCleanupOptionsForHome } = require("../hooks/cleanup-integrations");

// Match install.test.js: ambient WSL deployment hints must not override the
// explicit platform/location inputs in these command-format tests.
delete process.env.CLAWD_WSL_DISTRO;
delete process.env.WSL_DISTRO_NAME;

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const SCRIPT = "C:/Program Files/Clawd ' $ & 中文/resources/app.asar.unpacked/hooks/clawd-hook.js";
const AUTO = SCRIPT.replace("clawd-hook.js", "auto-start.js");
const URL = "http://127.0.0.1:23333/permission/clawd-on-desk";
const known = (version = "2.1.289") => ({ status: "known", version, source: "test" });
const unknown = { status: "unknown", version: null, source: null };
const execHook = (script = SCRIPT, event = "Stop") => ({
  type: "command", command: NODE, args: [script, ...(event ? [event] : [])], async: true, timeout: 5,
});
const wrap = (...hooks) => ({ matcher: "", hooks });
const permission = wrap({ type: "http", url: URL, timeout: 600 });

function fixture(t, settings = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-exec-test-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  return { homeDir, settingsPath, platform: "win32", env: {}, wslDistro: null,
    nodeBin: NODE, claudeVersionInfo: known(), silent: true, autoStart: true,
    sourcePaths: { state: SCRIPT, autoStart: AUTO } };
}
const read = (options) => JSON.parse(fs.readFileSync(options.settingsPath, "utf8"));
const leaves = (settings, event) => (settings.hooks[event] || []).flatMap((entry) => [
  ...(typeof entry.command === "string" ? [entry] : []), ...(entry.hooks || []),
]);
const managed = (settings, event, marker = "clawd-hook.js") => leaves(settings, event)
  .filter((hook) => (getClaudeHookCommand(hook, marker) || "").includes(marker));
const backupNames = (options) => fs.readdirSync(path.dirname(options.settingsPath)).filter((name) => name.endsWith(".bak"));

it("issue #1293: exec selection gates platform, location, version, executable and unknown-version stickiness", (t) => {
  const { homeDir } = fixture(t);
  const select = (node = NODE, settings = {}, version = known(), options = {}) => __test.shouldUseClaudeExecForm(
    node, settings, version, { platform: "win32", homeDir, env: {}, ...options });
  assert.equal(select(), true);
  for (const version of ["2.1.160", "2.1.161", "2.1.276", "2.1.289", "2.1.296", "2.2.0"]) {
    assert.equal(select(NODE, {}, known(version)), true, version);
  }
  for (const version of ["2.1.139", "2.1.159", "1.9.999"]) {
    assert.equal(select(NODE, {}, known(version)), false, version);
  }
  for (const options of [{ platform: "darwin" }, { platform: "linux" }, { remote: true }, { wslDistro: "Ubuntu" }]) {
    assert.equal(select(NODE, {}, known(), options), false, JSON.stringify(options));
  }
  for (const node of ["node", "node.exe", "C:\\bin\\node.cmd", "C:\\bin\\node.bat", "C:node.exe", "\\node.exe", "/usr/bin/node"]) {
    assert.equal(select(node), false, node);
  }
  assert.equal(select("\\\\server\\share\\node.exe"), true);
  assert.equal(select("D:/Node/NODE.EXE"), true);
  assert.equal(select(NODE, {}, unknown), false);
  assert.equal(select(NODE, { hooks: { Stop: [wrap(execHook())] } }, unknown), true);
  assert.equal(select(NODE, { hooks: { SessionStart: [execHook(AUTO, "")] } }, unknown), true);
  assert.equal(select(NODE, { hooks: { Stop: [execHook()] } }, known("2.1.159")), false);
  assert.equal(select(NODE, { hooks: { Stop: [execHook("C:/foreign.js", "clawd-hook.js")] } }, unknown), false);
});

for (const register of [registerHooks, registerHooksAsync]) {
  it(`issue #1293: ${register.name} uses PowerShell when either Grok home exists`, async (t) => {
    for (const location of ["default", "env"]) {
      const options = fixture(t);
      options.env.GROK_HOME = path.join(options.homeDir, "custom-grok");
      const grokHome = location === "default" ? path.join(options.homeDir, ".grok") : options.env.GROK_HOME;
      fs.mkdirSync(grokHome);
      await register(options);
      for (const event of Object.keys(read(options).hooks)) {
        for (const hook of leaves(read(options), event).filter((hook) => hook.type === "command")) {
          assert.equal(hook.shell, "powershell");
          assert.equal("args" in hook, false);
        }
      }
    }
  });

  it(`issue #1293: ${register.name} migrates hooks for Grok and defers unknown-version events until detection succeeds`, async (t) => {
    for (const location of ["default", "env"]) {
      for (const claudeVersionInfo of [known(), unknown]) {
        const options = fixture(t);
        options.env.GROK_HOME = path.join(options.homeDir, "custom-grok");
        await register(options);
        assert.deepEqual(managed(read(options), "Stop")[0].args, [SCRIPT, "Stop"]);
        fs.mkdirSync(location === "default" ? path.join(options.homeDir, ".grok") : options.env.GROK_HOME);
        await register({ ...options, claudeVersionInfo });
        const settings = read(options);
        const events = [...CLAUDE_CORE_HOOK_EVENTS, "PreCompact", "PostCompact", "StopFailure", "UserPromptExpansion", "PostToolBatch"];
        for (const event of events) {
          const hooks = managed(settings, event);
          assert.equal(hooks.length, 1);
          if (claudeVersionInfo.status === "unknown" && !CLAUDE_CORE_HOOK_EVENTS.includes(event)) {
            assert.deepEqual(hooks[0], execHook(SCRIPT, event));
            continue;
          }
          assert.equal(hooks[0].shell, "powershell", event);
          assert.equal(hooks[0].command, `& "${NODE}" "${SCRIPT}" ${event}`);
          assert.equal("args" in hooks[0], false);
        }
        const auto = managed(settings, "SessionStart", "auto-start.js");
        assert.equal(auto.length, 1);
        assert.equal(auto[0].shell, "powershell");
        assert.equal("args" in auto[0], false);
        const before = fs.readFileSync(options.settingsPath);
        const second = await register({ ...options, claudeVersionInfo });
        assert.equal(second.added, 0);
        assert.equal(second.updated, 0);
        assert.equal(second.removed, 0);
        assert.equal(second.backupPath, null);
        assert.deepEqual(fs.readFileSync(options.settingsPath), before);
        if (claudeVersionInfo.status === "unknown") {
          await register(options);
          for (const event of events) {
            const hooks = managed(read(options), event);
            assert.equal(hooks.length, 1);
            assert.equal(hooks[0].shell, "powershell", event);
            assert.equal("args" in hooks[0], false);
          }
        }
      }
    }
  });

  it(`issue #1293: ${register.name} registers 16 exec state hooks and auto-start, then performs no write or backup`, async (t) => {
    const options = fixture(t);
    assert.ok((await register(options)).added > 0);
    const settings = read(options);
    const events = [...CLAUDE_CORE_HOOK_EVENTS, "PreCompact", "PostCompact", "StopFailure", "UserPromptExpansion", "PostToolBatch"];
    assert.equal(events.length, 16);
    for (const event of events) assert.deepEqual(managed(settings, event), [execHook(SCRIPT, event)]);
    const auto = managed(settings, "SessionStart", "auto-start.js");
    assert.equal(auto.length, 1);
    assert.equal(auto[0].command, NODE);
    assert.deepEqual(auto[0].args, [AUTO]);
    assert.equal(auto[0].timeout, 15);
    assert.equal(auto[0].async, true);
    for (const hook of Object.keys(settings.hooks).flatMap((event) => leaves(settings, event))) assert.equal("shell" in hook, false);
    const before = fs.readFileSync(options.settingsPath);
    const backups = backupNames(options);
    const second = await register(options);
    assert.equal(second.updated, 0);
    assert.equal(second.added, 0);
    assert.equal(second.removed, 0);
    assert.equal(second.backupPath, null);
    assert.deepEqual(backupNames(options), backups);
    assert.deepEqual(fs.readFileSync(options.settingsPath), before);
  });

  it(`issue #1293: ${register.name} keeps the full PowerShell shape for shims, bare Node and unknown fresh hosts`, async (t) => {
    for (const input of [
      { nodeBin: "C:\\bin\\node.cmd", claudeVersionInfo: known() },
      { nodeBin: "C:\\bin\\node.bat", claudeVersionInfo: known() },
      { nodeBin: "node", claudeVersionInfo: known() },
      { nodeBin: NODE, claudeVersionInfo: unknown },
    ]) {
      const options = { ...fixture(t), ...input };
      await register(options);
      assert.equal(JSON.stringify(managed(read(options), "Stop")[0]), JSON.stringify({
        type: "command", shell: "powershell", command: `& "${input.nodeBin}" "${SCRIPT}" Stop`, async: true, timeout: 5,
      }));
      assert.equal(JSON.stringify(managed(read(options), "SessionStart", "auto-start.js")[0]), JSON.stringify({
        type: "command", shell: "powershell", command: `& "${input.nodeBin}" "${AUTO}"`, async: true, timeout: 15,
      }));
    }
  });

  it(`issue #1293: ${register.name} migrates both ways and preserves each format when version is unknown`, async (t) => {
    const options = fixture(t);
    await register({ ...options, claudeVersionInfo: known("2.1.159") });
    const oldBytes = fs.readFileSync(options.settingsPath);
    await register({ ...options, claudeVersionInfo: unknown });
    assert.deepEqual(fs.readFileSync(options.settingsPath), oldBytes);
    await register(options);
    const execBytes = fs.readFileSync(options.settingsPath);
    await register({ ...options, claudeVersionInfo: unknown });
    assert.deepEqual(fs.readFileSync(options.settingsPath), execBytes);
    await register({ ...options, claudeVersionInfo: known("2.1.159") });
    assert.deepEqual(read(options), JSON.parse(oldBytes));
    for (const event of Object.keys(read(options).hooks)) {
      for (const hook of leaves(read(options), event)) assert.equal("args" in hook, false);
    }
  });

  it(`issue #1293: ${register.name} preserves legacy command bytes on macOS, Linux, remote and WSL`, async (t) => {
    const cases = [
      { platform: "darwin", nodeBin: "/opt/node", prefix: '"/opt/node"', quoted: true },
      { platform: "linux", nodeBin: "/usr/bin/node", prefix: '"/usr/bin/node"', quoted: true },
      { platform: "linux", remote: true, nodeBin: "/remote/node", prefix: 'CLAWD_REMOTE=1 "/remote/node"', quoted: true },
      { platform: "win32", remote: true, nodeBin: NODE, prefix: `CLAWD_REMOTE=1 "${NODE}"`, quoted: true },
      { platform: "linux", wslDistro: "Ubuntu", nodeBin: "/usr/bin/node", prefix: "/usr/bin/node", quoted: false },
      { platform: "win32", wslDistro: "Ubuntu", nodeBin: NODE, prefix: `& "${NODE}"`, quoted: true },
    ];
    for (const item of cases) {
      const options = { ...fixture(t), ...item, sourcePaths: { state: "/app/hooks/clawd-hook.js", autoStart: "/app/hooks/auto-start.js" } };
      await register(options);
      const settings = read(options);
      const state = managed(settings, "Stop")[0];
      assert.equal(state.command, `${item.prefix} ${item.quoted ? '"/app/hooks/clawd-hook.js"' : "/app/hooks/clawd-hook.js"} Stop`);
      assert.equal(state.timeout, item.remote ? 10 : 5);
      assert.equal(state.async, true);
      assert.equal(JSON.stringify(state), JSON.stringify({
        type: "command",
        ...(item.platform === "win32" && !item.remote ? { shell: "powershell" } : {}),
        command: `${item.prefix} ${item.quoted ? '\"/app/hooks/clawd-hook.js\"' : "/app/hooks/clawd-hook.js"} Stop`,
        async: true, timeout: item.remote ? 10 : 5,
      }));
      assert.equal("args" in state, false);
      const auto = managed(settings, "SessionStart", "auto-start.js")[0];
      const autoPrefix = item.remote ? (item.platform === "win32" ? `& "${item.nodeBin}"` : `"${item.nodeBin}"`) : item.prefix;
      assert.equal(auto.command, `${autoPrefix} ${item.quoted ? '"/app/hooks/auto-start.js"' : "/app/hooks/auto-start.js"}`);
      assert.equal(JSON.stringify(auto), JSON.stringify({
        type: "command",
        ...(item.platform === "win32" ? { shell: "powershell" } : {}),
        command: `${autoPrefix} ${item.quoted ? '\"/app/hooks/auto-start.js\"' : "/app/hooks/auto-start.js"}`,
        async: true, timeout: 15,
      }));
      assert.equal("args" in auto, false);
    }
  });

  it(`issue #1293: ${register.name} folds mixed state forms, strips obsolete exec hooks and preserves foreign leaves`, async (t) => {
    const foreign = [execHook("C:/foreign.js", "clawd-hook.js"), execHook(`${SCRIPT}.bak`), execHook("C:/auto-start.js.bak", "auto-start.js")];
    const staleShell = { type: "command", command: `& "${NODE}" "C:/old/clawd-hook.js" Stop`, shell: "powershell" };
    const settings = { hooks: {
      Stop: [staleShell, wrap(...foreign, execHook())],
      WorktreeCreate: [wrap(execHook(SCRIPT, "WorktreeCreate"), foreign[0])],
      PermissionRequest: [wrap(execHook(SCRIPT, "PermissionRequest"), foreign[0])],
      SessionStart: [wrap(execHook(AUTO.replace(".js", ".sh"), ""), execHook(AUTO, ""), foreign[2])],
    } };
    const options = fixture(t, settings);
    const result = await register(options);
    assert.ok(result.removed >= 4);
    const after = read(options);
    assert.equal(managed(after, "Stop").length, 1);
    assert.deepEqual(managed(after, "Stop")[0], execHook());
    assert.ok(after.hooks.Stop.every((entry) => !("args" in entry)), "removed flat hook fields must not leak onto wrapper");
    assert.deepEqual(leaves(after, "Stop").filter((hook) => !managed(after, "Stop").includes(hook)), foreign);
    assert.deepEqual(after.hooks.WorktreeCreate, [wrap(foreign[0])]);
    assert.equal(managed(after, "PermissionRequest").length, 0);
    assert.equal(managed(after, "SessionStart", "auto-start.sh").length, 0);
    assert.deepEqual(leaves(after, "SessionStart").find((hook) => hook.args && hook.args[0] === foreign[2].args[0]), foreign[2]);
  });

  it(`issue #1293: ${register.name} removes unsupported versioned exec hooks on downgrade`, async (t) => {
    const foreign = execHook("C:/foreign.js", "clawd-hook.js");
    const options = fixture(t, { hooks: { PostToolBatch: [wrap(execHook(SCRIPT, "PostToolBatch"), foreign)] } });
    await register({ ...options, claudeVersionInfo: known("2.1.279") });
    assert.deepEqual(read(options).hooks.PostToolBatch, [wrap(foreign)]);
  });

  it(`issue #1293: ${register.name} retains Node from exec form when normal resolution fails`, async (t) => {
    const options = fixture(t, { hooks: { Stop: [wrap(execHook())] } });
    const calls = [];
    await register({ ...options, nodeBin: null, access: async (...args) => calls.push(args) });
    assert.equal(managed(read(options), "Stop")[0].command, NODE);
    if (register === registerHooksAsync) assert.deepEqual(calls, [[NODE, fs.constants.F_OK]]);
  });

  it(`issue #1293: ${register.name} prefers the value-equal exec survivor and clears args when removing a flat duplicate`, async (t) => {
    const canonical = { ...execHook(), keep: "canonical" };
    const options = fixture(t, { hooks: { Stop: [{ ...execHook("C:/old/clawd-hook.js"), hooks: [{ type: "command", command: "foreign" }] }, wrap(canonical)] } });
    await register(options);
    assert.equal(managed(read(options), "Stop")[0].keep, "canonical");
    assert.deepEqual(read(options).hooks.Stop[0], { hooks: [{ type: "command", command: "foreign" }] });
  });
}

it("issue #1293: Claude command readers require the exact first argument and other agents retain their own rules", () => {
  for (const script of [SCRIPT, "C:\\Clawd\\clawd-hook.js", "clawd-hook.js"]) {
    const hook = execHook(script);
    assert.ok(getClaudeHookCommand(hook, "clawd-hook.js").includes("clawd-hook.js"));
    assert.equal(claudeHookHasMarker(hook, "clawd-hook.js"), true);
    const settings = { hooks: { Stop: [hook, wrap(hook)] } };
    assert.equal(findHookCommands(settings, "clawd-hook.js", { nested: true, claude: true }).length, 2);
    assert.equal(extractExistingNodeBin(settings, "clawd-hook.js", { nested: true, claude: true }), NODE);
    assert.equal(__test.removeMatchingCommandHooks(settings.hooks.Stop, (command) => command.includes("clawd-hook.js")).removed, 2);
    assert.deepEqual(findHookCommands(settings, "clawd-hook.js", { nested: true }), []);
  }
  for (const hook of [execHook("C:/foreign.js", SCRIPT), execHook(`${SCRIPT}.bak`), execHook(`${SCRIPT}/`),
    { ...execHook(), args: [] }, { ...execHook(), args: "clawd-hook.js" }, { ...execHook(), args: [null, SCRIPT] },
    { ...execHook(), command: "C:/clawd-hook.js/node.exe", args: ["C:/foreign.js"] }]) {
    assert.equal(getClaudeHookCommand(hook), null);
    assert.equal(claudeHookHasMarker(hook, "clawd-hook.js"), false);
    const settings = { hooks: { Stop: [hook, wrap(hook)] } };
    assert.deepEqual(findHookCommands(settings, "clawd-hook.js", { nested: true, claude: true }), []);
    assert.equal(__test.removeMatchingCommandHooks(settings.hooks.Stop, () => true).removed, 0);
    assert.equal(extractExistingNodeBin(settings, "clawd-hook.js", { nested: true, claude: true }), null);
  }
});

for (const unregister of [unregisterHooks, unregisterHooksAsync]) {
  it(`issue #1293: ${unregister.name} removes flat and nested exec hooks, keeping third-party arguments and siblings`, async (t) => {
    const foreign = [execHook("C:/foreign.js", SCRIPT), execHook(`${SCRIPT}.bak`), execHook("C:/foreign.js", AUTO), execHook(`${AUTO}.bak`)];
    const options = fixture(t, { hooks: {
      Stop: [execHook(), wrap(execHook(), ...foreign)],
      SessionStart: [execHook(AUTO, ""), wrap(execHook(AUTO.replace(".js", ".sh"), ""))],
    } });
    assert.equal(isAutoStartRegistered(options), true);
    const result = await unregister(options);
    assert.equal(result.removed, 4);
    assert.deepEqual(read(options).hooks, { Stop: [wrap(...foreign)] });
    assert.equal(isAutoStartRegistered(options), false);
    assert.equal((await unregister(options)).changed, false);
  });
}

it("issue #1293: auto-start check/removal and cleanup-integrations understand exec ownership", (t) => {
  const foreign = execHook(`${AUTO}.bak`, "auto-start.js");
  const options = fixture(t, { hooks: { SessionStart: [wrap(foreign, execHook(AUTO, ""))] } });
  assert.equal(isAutoStartRegistered(options), true);
  assert.equal(unregisterAutoStart(options), true);
  assert.equal(isAutoStartRegistered(options), false);
  assert.deepEqual(read(options).hooks.SessionStart, [wrap(foreign)]);
  fs.writeFileSync(options.settingsPath, JSON.stringify({ hooks: { Stop: [execHook()], SessionStart: [wrap(execHook(AUTO, ""), foreign)] } }));
  const plan = buildCleanupOptionsForHome(options.homeDir, { platform: "win32", env: {}, backup: true });
  const result = AGENT_CLEANERS["claude-code"](plan.byAgent["claude-code"]);
  assert.equal(result.removed, 2);
  assert.deepEqual(read(options).hooks, { SessionStart: [wrap(foreign)] });
});

it("issue #1293: watcher accepts exec state plus permission, excludes managed hooks and counts marker lookalikes as third-party", () => {
  for (const nested of [true, false]) {
    const state = execHook();
    const auto = execHook(AUTO, "");
    const foreign = [execHook("C:/foreign.js", SCRIPT), execHook(`${SCRIPT}.bak`), execHook("C:/foreign.js", AUTO)];
    const hooks = { Stop: nested ? [wrap(state, auto, ...foreign)] : [state, auto, ...foreign], PermissionRequest: [permission] };
    assert.equal(entriesContainCommandMarker(hooks.Stop, "clawd-hook.js"), true);
    assert.equal(settingsNeedClaudeHookResync(JSON.stringify({ hooks }), URL), false);
    assert.equal(countAllHooks(hooks), 5);
    assert.equal(countThirdPartyHooks(hooks, { hooks }), 3);
    assert.equal(entriesContainCommandMarker([wrap(...foreign)], "clawd-hook.js"), false);
    assert.equal(settingsNeedClaudeHookResync(JSON.stringify({ hooks: { Stop: [wrap(...foreign)], PermissionRequest: [permission] } }), URL), true);
  }
});

function health(settings, missing = []) {
  const existing = new Set([NODE, SCRIPT, AUTO, "C:/old/clawd-hook.js", "C:/old/auto-start.js"].filter((p) => !missing.includes(p)));
  return inspectClaudeHookHealth(JSON.stringify(settings), {
    platform: "win32", fs: { existsSync: (p) => existing.has(p) }, coreEvents: ["Stop"],
    expectedPermissionUrl: URL, expectedHookScriptPath: SCRIPT, expectedAutoStartScriptPath: AUTO,
    requireAutoStart: true,
  });
}
const healthy = () => ({ hooks: { Stop: [wrap(execHook())], SessionStart: [wrap(execHook(AUTO, ""))], PermissionRequest: [permission] } });

it("issue #1293: health parses exec paths, detects stale/missing paths, missing Node and mixed duplicates", () => {
  assert.equal(health(healthy()).status, "healthy");
  for (const nested of [false, true]) {
    const settings = healthy();
    settings.hooks.Stop = nested ? [wrap(execHook("C:/old/clawd-hook.js"))] : [execHook("C:/old/clawd-hook.js")];
    settings.hooks.SessionStart = nested ? [wrap(execHook("C:/old/auto-start.js", ""))] : [execHook("C:/old/auto-start.js", "")];
    assert.ok(health(settings).issues.some((issue) => issue.code === "stale-script-path"));
    assert.ok(health(settings).issues.some((issue) => issue.code === "auto-start-stale-path"));
    assert.ok(health(settings, ["C:/old/clawd-hook.js"]).issues.some((issue) => issue.code === "script-path-missing"));
    assert.ok(health(settings, ["C:/old/auto-start.js"]).issues.some((issue) => issue.code === "auto-start-path-missing"));
  }
  assert.ok(health(healthy(), [NODE]).issues.some((issue) => issue.code === "node-bin-invalid"));
  const duplicate = healthy();
  duplicate.hooks.Stop.push(wrap({ type: "command", command: `& "${NODE}" "${SCRIPT}" Stop` }));
  assert.ok(health(duplicate).issues.some((issue) => issue.code === "duplicate-managed-state-hook"));
  const foreign = healthy();
  foreign.hooks.Stop = [wrap(execHook(`${SCRIPT}.bak`), execHook("C:/foreign.js", SCRIPT))];
  assert.ok(health(foreign).issues.some((issue) => issue.code === "missing-managed-core-hooks"));
});

it("issue #1293: Doctor and installation detection read exec form; generic reader stays Claude-only", (t) => {
  const options = fixture(t, healthy());
  const descriptor = { ...getAgentDescriptor("claude-code"), parentDir: path.dirname(options.settingsPath), configPath: options.settingsPath };
  for (const missing of [null, NODE, SCRIPT]) {
    const fsImpl = { ...fs, existsSync: (p) => p !== missing && ([NODE, SCRIPT, AUTO].includes(p) || fs.existsSync(p)) };
    const result = checkAgentIntegrations({ descriptors: [descriptor],
      platform: "win32", homeDir: options.homeDir, env: {}, fs: fsImpl, prefs: {},
    }).details[0];
    assert.equal(result.status, missing ? "broken-path" : "ok", JSON.stringify(result));
    if (missing) assert.equal(result.hookCommandIssue, missing === NODE ? "nodeBin-invalid" : "scriptPath-missing");
  }
  const installation = detectAgentInstallation(getAgentDescriptor("claude-code"), { fs, platform: "win32", homeDir: options.homeDir, env: {} });
  assert.equal(installation.clawdIntegration.detected, true);
  fs.writeFileSync(options.settingsPath, JSON.stringify({ hooks: { Stop: [wrap(execHook("C:/foreign.js", SCRIPT), execHook(`${SCRIPT}.bak`))] } }));
  assert.equal(checkAgentIntegrations({ descriptors: [descriptor], platform: "win32", homeDir: options.homeDir, env: {}, fs, prefs: {} }).details[0].status, "not-connected");
  const other = { ...descriptor, agentId: "codebuddy" };
  fs.writeFileSync(options.settingsPath, JSON.stringify(healthy()));
  assert.equal(checkAgentIntegrations({ descriptors: [other], platform: "win32", homeDir: options.homeDir, env: {}, fs, prefs: {} }).details[0].status, "not-connected");
});

it("issue #1293: exec hooks cannot masquerade as an env-indirected shell command", () => {
  const settings = { env: { CLAWD_HOOK_PATH: "/app/clawd-hook.js", CLAWD_NODE_BIN: "/opt/node" },
    hooks: { Stop: [wrap({ type: "command", command: '\"$CLAWD_NODE_BIN\" \"$CLAWD_HOOK_PATH\" Stop', args: ["/foreign.js"] })] } };
  assert.deepEqual(findManagedClaudeEnvNodeBinCandidates(settings), []);
});

it("issue #1293: UNC Node/script paths survive diagnostic parsing and raw Node preservation", (t) => {
  const nodeBin = "\\\\server\\Node With Space\\node.exe";
  const script = "\\\\server\\Clawd 中文\\clawd-hook.js";
  const hook = { ...execHook(script), command: nodeBin };
  const settings = { hooks: { Stop: [hook, wrap(hook)] } };
  const { validateHookCommand } = require("../src/doctor-detectors/agent-node-bin-parser");
  const fsImpl = { existsSync: (p) => [nodeBin, script].includes(p) };
  assert.deepEqual(validateHookCommand(getClaudeHookCommand(hook), { platform: "win32", fs: fsImpl }), { ok: true, nodeBin, scriptPath: script });
  assert.equal(extractExistingNodeBin(settings, "clawd-hook.js", { nested: true, claude: true }), nodeBin);
  const options = fixture(t, settings);
  registerHooks({ ...options, nodeBin: null });
  assert.equal(managed(read(options), "Stop")[0].command, nodeBin);
});

it("issue #1293: extended Windows paths keep the original Node and script fields in health and Doctor", (t) => {
  const nodeBin = String.raw`\\?\C:\Program Files\nodejs\node.EXE`;
  const script = String.raw`\\?\C:\Clawd 中文\hooks\clawd-hook.js`;
  const hook = { ...execHook(script), command: nodeBin };
  const settings = { hooks: { Stop: [wrap(hook)], PermissionRequest: [permission] } };
  const options = fixture(t, settings);
  const fsImpl = { ...fs, existsSync: (p) => [nodeBin, script].includes(p) || fs.existsSync(p) };
  const { validateHookCommand } = require("../src/doctor-detectors/agent-node-bin-parser");
  assert.deepEqual(validateHookCommand(getClaudeHookCommand(hook), { platform: "win32", fs: fsImpl }), {
    ok: true, nodeBin, scriptPath: script,
  });
  assert.equal(__test.shouldUseClaudeExecForm(nodeBin, settings, known(), options), true);
  assert.equal(inspectClaudeHookHealth(JSON.stringify(settings), {
    platform: "win32", fs: fsImpl, coreEvents: ["Stop"], expectedPermissionUrl: URL,
    expectedHookScriptPath: script,
  }).status, "healthy");
  const descriptor = { ...getAgentDescriptor("claude-code"), parentDir: path.dirname(options.settingsPath), configPath: options.settingsPath };
  const result = checkAgentIntegrations({ descriptors: [descriptor], platform: "win32", fs: fsImpl,
    homeDir: options.homeDir, env: {}, prefs: {},
    validateCommand: (command, validateOptions) => {
      const parsed = validateHookCommand(command, validateOptions);
      assert.deepEqual(parsed, { ok: true, nodeBin, scriptPath: script });
      return parsed;
    },
  }).details[0];
  assert.equal(result.status, "ok");
  assert.equal(result.scriptPath, script);
  assert.equal(extractExistingNodeBin(settings, "clawd-hook.js", { nested: true, claude: true }), nodeBin);
});
