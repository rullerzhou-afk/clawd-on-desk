"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { CLAUDE_CORE_HOOK_EVENTS } = require("../hooks/install");
const { buildWindowsEncodedNodeHookCommand } = require("../hooks/json-utils");
const {
  inspectClaudeHookHealth,
  buildClaudeRepairSignature,
  hasNoAutomaticRepairWork,
  reportHasUnparseableCommand,
  isExplicitRepairVerified,
} = require("../src/claude-hook-health");

const EXPECTED_HOOK_SCRIPT_PATH = "C:/app/resources/app.asar.unpacked/hooks/clawd-hook.js";
const EXPECTED_AUTO_START_SCRIPT_PATH = "C:/app/resources/app.asar.unpacked/hooks/auto-start.js";
const EXPECTED_PERMISSION_URL = "http://127.0.0.1:23333/permission";
const OLD_TEMP_SCRIPT_PATH = "C:/Users/tester/AppData/Local/Temp/clawd-on-desk/hooks/clawd-hook.js";

function makeFakeFs(existingPaths) {
  const set = new Set(existingPaths || []);
  return {
    existsSync: (p) => set.has(p),
    accessSync: (p) => {
      if (!set.has(p)) throw new Error("ENOENT");
    },
    writeFileSync: () => { throw new Error("inspectClaudeHookHealth must never write"); },
    renameSync: () => { throw new Error("inspectClaudeHookHealth must never write"); },
  };
}

function coreCommandHook(event, scriptPath, nodeBin = "node") {
  return {
    matcher: "",
    hooks: [{ type: "command", shell: "powershell", command: `& "${nodeBin}" "${scriptPath}" ${event}` }],
  };
}

function autoStartHook(scriptPath, nodeBin = "node") {
  return {
    matcher: "",
    hooks: [{ type: "command", shell: "powershell", command: `& "${nodeBin}" "${scriptPath}"` }],
  };
}

function permissionHook(url) {
  return { matcher: "", hooks: [{ type: "http", url, timeout: 600 }] };
}

function buildHealthySettings({
  scriptPath = EXPECTED_HOOK_SCRIPT_PATH,
  permissionUrl = EXPECTED_PERMISSION_URL,
  events = CLAUDE_CORE_HOOK_EVENTS,
  nodeBin = "node",
} = {}) {
  const hooks = {};
  for (const event of events) hooks[event] = [coreCommandHook(event, scriptPath, nodeBin)];
  if (permissionUrl) hooks.PermissionRequest = [permissionHook(permissionUrl)];
  return { hooks };
}

function baseOptions(overrides = {}) {
  return {
    platform: "win32",
    fs: makeFakeFs([EXPECTED_HOOK_SCRIPT_PATH, EXPECTED_AUTO_START_SCRIPT_PATH]),
    expectedPermissionUrl: EXPECTED_PERMISSION_URL,
    expectedHookScriptPath: EXPECTED_HOOK_SCRIPT_PATH,
    expectedAutoStartScriptPath: EXPECTED_AUTO_START_SCRIPT_PATH,
    coreEvents: CLAUDE_CORE_HOOK_EVENTS,
    requireAutoStart: false,
    ...overrides,
  };
}

describe("inspectClaudeHookHealth", () => {
  it("reports healthy for current Windows PowerShell commands pointing at an existing script", () => {
    const raw = JSON.stringify(buildHealthySettings());
    const report = inspectClaudeHookHealth(raw, baseOptions());

    assert.strictEqual(report.status, "healthy");
    assert.strictEqual(report.repairable, false);
    assert.deepStrictEqual(report.issues, []);
    assert.strictEqual(report.managedCoreEventCount, CLAUDE_CORE_HOOK_EVENTS.length);
  });

  it("does not misreport slash/case differences on Windows as a stale path", () => {
    const mixedCasePath = "C:\\App\\Resources\\App.asar.unpacked\\hooks\\clawd-hook.js";
    const raw = JSON.stringify(buildHealthySettings({ scriptPath: mixedCasePath }));
    const options = baseOptions({ fs: makeFakeFs([mixedCasePath, EXPECTED_HOOK_SCRIPT_PATH]) });

    const report = inspectClaudeHookHealth(raw, options);

    assert.strictEqual(report.status, "healthy");
    assert.deepStrictEqual(report.issues, []);
  });

  it("flags a deleted old %TEMP% script path as script-path-missing and repairable", () => {
    const raw = JSON.stringify(buildHealthySettings({ scriptPath: OLD_TEMP_SCRIPT_PATH }));
    // Old temp path is NOT registered as existing; only the current source is.
    const options = baseOptions();

    const report = inspectClaudeHookHealth(raw, options);

    assert.strictEqual(report.status, "unhealthy");
    assert.strictEqual(report.repairable, true);
    assert.ok(report.issues.some((issue) => issue.code === "script-path-missing"), JSON.stringify(report.issues));
  });

  it("flags an old %TEMP% script path that still exists as stale-script-path and repairable", () => {
    const raw = JSON.stringify(buildHealthySettings({ scriptPath: OLD_TEMP_SCRIPT_PATH }));
    const options = baseOptions({
      fs: makeFakeFs([EXPECTED_HOOK_SCRIPT_PATH, EXPECTED_AUTO_START_SCRIPT_PATH, OLD_TEMP_SCRIPT_PATH]),
    });

    const report = inspectClaudeHookHealth(raw, options);

    assert.strictEqual(report.status, "unhealthy");
    assert.strictEqual(report.repairable, true);
    assert.ok(report.issues.some((issue) => issue.code === "stale-script-path"), JSON.stringify(report.issues));
  });

  it("flags a stale duplicate command even when a healthy command coexists in the same event", () => {
    const settings = buildHealthySettings();
    // Stop already has one healthy command from buildHealthySettings(); add a
    // second, stale Clawd-owned duplicate under the same event — e.g. left
    // behind by a botched prior sync. Every Clawd-owned command must be
    // checked, not just whichever one is found first.
    settings.hooks.Stop.push({
      matcher: "",
      hooks: [{ type: "command", shell: "powershell", command: `& "node" "${OLD_TEMP_SCRIPT_PATH}" Stop` }],
    });
    const options = baseOptions({
      fs: makeFakeFs([EXPECTED_HOOK_SCRIPT_PATH, EXPECTED_AUTO_START_SCRIPT_PATH, OLD_TEMP_SCRIPT_PATH]),
    });

    const report = inspectClaudeHookHealth(JSON.stringify(settings), options);

    assert.strictEqual(report.repairable, true);
    assert.ok(
      report.issues.some((issue) => issue.code === "stale-script-path" && issue.event === "Stop"),
      `a stale duplicate must be flagged even when a healthy sibling command exists: ${JSON.stringify(report.issues)}`
    );
  });

  it("reports source-script-missing (not repairable) when the current packaged source is gone", () => {
    const raw = JSON.stringify(buildHealthySettings());
    const options = baseOptions({ fs: makeFakeFs([]) }); // expected source itself absent

    const report = inspectClaudeHookHealth(raw, options);

    assert.strictEqual(report.status, "source-script-missing");
    assert.strictEqual(report.repairable, false);
    assert.deepStrictEqual(report.issues, [{ code: "source-script-missing", automaticRepairable: false }]);
  });

  it("reports source-script-missing when only the auto-start source script is gone and auto-start is required", () => {
    const raw = JSON.stringify(buildHealthySettings());
    // Core script exists; auto-start.js does not. A repair that only checks
    // the core script would happily rewrite a SessionStart command to point
    // at this missing auto-start.js — this must be refused the same way a
    // missing core script is refused.
    const options = baseOptions({
      requireAutoStart: true,
      fs: makeFakeFs([EXPECTED_HOOK_SCRIPT_PATH]),
    });

    const report = inspectClaudeHookHealth(raw, options);

    assert.strictEqual(report.status, "source-script-missing");
    assert.strictEqual(report.repairable, false);
    assert.ok(report.issues.every((issue) => issue.automaticRepairable === false), JSON.stringify(report.issues));
  });

  it("does not require the auto-start source script when requireAutoStart is false", () => {
    const raw = JSON.stringify(buildHealthySettings());
    // auto-start.js is absent, but this caller never writes a SessionStart
    // auto-start command, so its absence must not block an otherwise-healthy
    // core hook report.
    const options = baseOptions({
      requireAutoStart: false,
      fs: makeFakeFs([EXPECTED_HOOK_SCRIPT_PATH]),
    });

    const report = inspectClaudeHookHealth(raw, options);

    assert.strictEqual(report.status, "healthy");
  });

  it("flags totally missing managed core hooks as missing-managed-core-hooks and repairable", () => {
    const raw = JSON.stringify({ hooks: { PermissionRequest: [permissionHook(EXPECTED_PERMISSION_URL)] } });
    const options = baseOptions();

    const report = inspectClaudeHookHealth(raw, options);

    assert.strictEqual(report.repairable, true);
    assert.ok(report.issues.some((issue) => issue.code === "missing-managed-core-hooks"));
  });

  it("does not treat a single missing core event as automatically repairable", () => {
    const settings = buildHealthySettings();
    delete settings.hooks.Stop;
    const options = baseOptions();

    const report = inspectClaudeHookHealth(JSON.stringify(settings), options);

    assert.strictEqual(report.repairable, false);
    assert.ok(report.issues.some((issue) => issue.code === "missing-core-event" && issue.event === "Stop"));
    assert.ok(!report.issues.some((issue) => issue.automaticRepairable === true));
  });

  it("flags a Permission URL pointing at a stale port as repairable", () => {
    const raw = JSON.stringify(buildHealthySettings({ permissionUrl: "http://127.0.0.1:23335/permission" }));
    const options = baseOptions();

    const report = inspectClaudeHookHealth(raw, options);

    assert.strictEqual(report.repairable, true);
    assert.ok(report.issues.some((issue) => issue.code === "permission-url-mismatch"));
  });

  it("ignores versioned event breakage entirely — it is out of scope for periodic repair", () => {
    const settings = buildHealthySettings();
    settings.hooks.PreCompact = [coreCommandHook("PreCompact", "/this/does/not/exist.js")];
    const options = baseOptions(); // coreEvents does not include PreCompact

    const report = inspectClaudeHookHealth(JSON.stringify(settings), options);

    assert.strictEqual(report.status, "healthy");
    assert.deepStrictEqual(report.issues, []);
  });

  it("requires a valid auto-start command only when requireAutoStart is true", () => {
    const healthySettings = buildHealthySettings();
    healthySettings.hooks.SessionStart.push(autoStartHook(EXPECTED_AUTO_START_SCRIPT_PATH));
    const raw = JSON.stringify(healthySettings);

    const withAutoStart = inspectClaudeHookHealth(raw, baseOptions({ requireAutoStart: true }));
    assert.strictEqual(withAutoStart.status, "healthy");

    const rawWithout = JSON.stringify(buildHealthySettings());
    const autoStartNotRequired = inspectClaudeHookHealth(rawWithout, baseOptions({ requireAutoStart: false }));
    assert.strictEqual(autoStartNotRequired.status, "healthy");

    const autoStartMissingButRequired = inspectClaudeHookHealth(rawWithout, baseOptions({ requireAutoStart: true }));
    assert.strictEqual(autoStartMissingButRequired.repairable, true);
    assert.ok(autoStartMissingButRequired.issues.some((issue) => issue.code === "auto-start-path-missing"));
  });

  it("third-party commands that fail to parse do not affect Clawd health", () => {
    const settings = buildHealthySettings();
    settings.hooks.Stop.push({
      matcher: "",
      hooks: [{ type: "command", command: "not a real command at all $$$" }],
    });
    const options = baseOptions();

    const report = inspectClaudeHookHealth(JSON.stringify(settings), options);

    assert.strictEqual(report.status, "healthy");
  });

  it("returns a clear command-unparseable issue instead of throwing on a broken Clawd command", () => {
    const raw = JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: '"clawd-hook.js"' }] }],
        PermissionRequest: [permissionHook(EXPECTED_PERMISSION_URL)],
      },
    });
    const options = baseOptions({ coreEvents: ["Stop"] });

    const report = inspectClaudeHookHealth(raw, options);

    assert.strictEqual(report.repairable, false);
    assert.ok(report.issues.some((issue) => issue.code === "command-unparseable" && issue.event === "Stop"));
  });

  it("recognizes a Clawd command hidden inside a PowerShell -EncodedCommand wrapper", () => {
    const encoded = buildWindowsEncodedNodeHookCommand("node", EXPECTED_HOOK_SCRIPT_PATH, ["Stop"]);
    const raw = JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: encoded }] }],
        PermissionRequest: [permissionHook(EXPECTED_PERMISSION_URL)],
      },
    });
    const options = baseOptions({ coreEvents: ["Stop"] });

    const report = inspectClaudeHookHealth(raw, options);

    assert.strictEqual(report.status, "healthy");
  });

  it("flags an invalid Node binary as repairable", () => {
    const raw = JSON.stringify(buildHealthySettings({ nodeBin: "/usr/bin/node", events: ["Stop"] }));
    const options = baseOptions({
      platform: "linux",
      coreEvents: ["Stop"],
      // /usr/bin/node deliberately absent from the fake fs's existing set.
      fs: makeFakeFs([EXPECTED_HOOK_SCRIPT_PATH, EXPECTED_AUTO_START_SCRIPT_PATH]),
    });

    const report = inspectClaudeHookHealth(raw, options);

    assert.strictEqual(report.repairable, true);
    assert.ok(report.issues.some((issue) => issue.code === "node-bin-invalid"));
  });

  for (const [label, raw] of [["empty string", ""], ["non-JSON text", "not json"], ["null", "null"], ["array", "[]"]]) {
    it(`treats ${label} settings content as unreadable without writing anything`, () => {
      const report = inspectClaudeHookHealth(raw, baseOptions());
      assert.strictEqual(report.status, "unreadable");
      assert.strictEqual(report.repairable, false);
      assert.deepStrictEqual(report.issues, []);
    });
  }
});

describe("buildClaudeRepairSignature", () => {
  it("is null when there are no issues, or none are automatically repairable", () => {
    assert.strictEqual(buildClaudeRepairSignature([]), null);
    assert.strictEqual(buildClaudeRepairSignature(undefined), null);
    assert.strictEqual(
      buildClaudeRepairSignature([{ code: "missing-core-event", automaticRepairable: false }]),
      null
    );
    assert.strictEqual(
      buildClaudeRepairSignature([{ code: "command-unparseable", automaticRepairable: false }]),
      null
    );
    assert.strictEqual(
      buildClaudeRepairSignature([{ code: "source-script-missing", automaticRepairable: false }]),
      null
    );
  });

  it("collapses issue codes into stable, sorted repair classes", () => {
    const a = buildClaudeRepairSignature([
      { code: "script-path-missing", event: "Stop", automaticRepairable: true },
      { code: "node-bin-invalid", event: "SessionStart", automaticRepairable: true },
    ]);
    const b = buildClaudeRepairSignature([
      { code: "node-bin-invalid", event: "PreToolUse", automaticRepairable: true },
      { code: "stale-script-path", event: "Notification", automaticRepairable: true },
    ]);

    assert.strictEqual(a, "v1:core-script-path,node-bin");
    assert.strictEqual(a, b);
  });

  it("is insensitive to issue ordering and to which events/paths carried the same repair class", () => {
    const first = [
      { code: "script-path-missing", event: "Stop", scriptPath: "/a", automaticRepairable: true },
      { code: "stale-script-path", event: "SessionStart", scriptPath: "/b", automaticRepairable: true },
      { code: "permission-url-mismatch", event: "PermissionRequest", automaticRepairable: true },
    ];
    const reorderedWithDifferentPaths = [
      { code: "permission-url-mismatch", event: "PermissionRequest", automaticRepairable: true },
      { code: "stale-script-path", event: "Notification", scriptPath: "/completely/different", automaticRepairable: true },
    ];

    assert.strictEqual(
      buildClaudeRepairSignature(first),
      buildClaudeRepairSignature(reorderedWithDifferentPaths)
    );
  });

  it("changes only when the repairable class set actually changes", () => {
    const withNodeBin = buildClaudeRepairSignature([{ code: "node-bin-invalid", automaticRepairable: true }]);
    const withPermissionUrl = buildClaudeRepairSignature([{ code: "permission-url-mismatch", automaticRepairable: true }]);
    assert.notStrictEqual(withNodeBin, withPermissionUrl);
  });

  it("ignores non-repairable issues mixed in with repairable ones", () => {
    const withNoise = buildClaudeRepairSignature([
      { code: "missing-core-event", event: "Elicitation", automaticRepairable: false },
      { code: "node-bin-invalid", automaticRepairable: true },
    ]);
    const clean = buildClaudeRepairSignature([{ code: "node-bin-invalid", automaticRepairable: true }]);
    assert.strictEqual(withNoise, clean);
  });
});

describe("hasNoAutomaticRepairWork / isExplicitRepairVerified", () => {
  function healthyReport() {
    return inspectClaudeHookHealth(JSON.stringify(buildHealthySettings()), baseOptions());
  }

  // Same fixture as "returns a clear command-unparseable issue instead of
  // throwing on a broken Clawd command" above: a Clawd-owned command that
  // fails to parse is the one case where "nothing left for auto-repair to
  // attempt" and "actually healthy" must diverge.
  function unparseableOnlyReport() {
    const raw = JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: '"clawd-hook.js"' }] }],
        PermissionRequest: [permissionHook(EXPECTED_PERMISSION_URL)],
      },
    });
    return inspectClaudeHookHealth(raw, baseOptions({ coreEvents: ["Stop"] }));
  }

  function autoRepairableReport() {
    const raw = JSON.stringify(buildHealthySettings({ permissionUrl: "http://127.0.0.1:23335/permission" }));
    return inspectClaudeHookHealth(raw, baseOptions());
  }

  it("both agree a genuinely healthy report is verified", () => {
    const report = healthyReport();
    assert.strictEqual(hasNoAutomaticRepairWork(report), true);
    assert.strictEqual(reportHasUnparseableCommand(report), false);
    assert.strictEqual(isExplicitRepairVerified(report), true);
  });

  it("a command-unparseable-only report has nothing left for auto-repair, but is not explicitly verified healthy", () => {
    const report = unparseableOnlyReport();
    assert.strictEqual(report.status, "unhealthy");
    assert.strictEqual(buildClaudeRepairSignature(report.issues), null);

    assert.strictEqual(
      hasNoAutomaticRepairWork(report),
      true,
      "nothing automatically repairable remains, so the periodic supervisor must stop retrying"
    );
    assert.strictEqual(reportHasUnparseableCommand(report), true);
    assert.strictEqual(
      isExplicitRepairVerified(report),
      false,
      "an explicit Install/Fix must not report success while a Clawd-owned command is unparseable"
    );
  });

  it("neither helper treats a report with real automatic repair work remaining as verified", () => {
    const report = autoRepairableReport();
    assert.strictEqual(hasNoAutomaticRepairWork(report), false);
    assert.strictEqual(isExplicitRepairVerified(report), false);
  });

  it("neither helper treats unreadable or source-script-missing statuses as verified", () => {
    const unreadable = inspectClaudeHookHealth("not json", baseOptions());
    const sourceMissing = inspectClaudeHookHealth(
      JSON.stringify(buildHealthySettings()),
      baseOptions({ fs: makeFakeFs([]) })
    );

    for (const report of [unreadable, sourceMissing]) {
      assert.strictEqual(hasNoAutomaticRepairWork(report), false, report.status);
      assert.strictEqual(isExplicitRepairVerified(report), false, report.status);
    }
  });

  it("both helpers are false for a missing report", () => {
    assert.strictEqual(hasNoAutomaticRepairWork(null), false);
    assert.strictEqual(isExplicitRepairVerified(undefined), false);
    assert.strictEqual(reportHasUnparseableCommand(null), false);
  });
});
