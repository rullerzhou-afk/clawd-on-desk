"use strict";

// Doctor coverage for Copilot CLI's configMode: "copilot-hooks" path.
// Exercises findCopilotHookCommandsForEvent (bash/powershell/command scan),
// validateCopilotHookEvents (per-event "any command ok" semantics, disableAllHooks
// short-circuit with not-connected + supplementary), and the Fix-button
// suppression for disabled states.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { checkAgentIntegrations } = require("../src/doctor-detectors/agent-integrations");
const { COPILOT_HOOK_EVENTS, MARKER } = require("../hooks/copilot-install");

const tempDirs = [];

function makeTempCopilotHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-copilot-doctor-"));
  const parentDir = path.join(root, ".copilot");
  fs.mkdirSync(path.join(parentDir, "hooks"), { recursive: true });
  tempDirs.push(root);
  return parentDir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function buildEntryFor(event, marker, { withBash = true, withPowershell = true, withCommand = false } = {}) {
  const entry = { type: "command", timeoutSec: 5 };
  if (withBash) entry.bash = `"/usr/bin/node" "/app/hooks/${marker}" "${event}"`;
  if (withPowershell) entry.powershell = `& "/usr/bin/node" "/app/hooks/${marker}" "${event}"`;
  if (withCommand) entry.command = `"/usr/bin/node" "/app/hooks/${marker}" "${event}"`;
  return entry;
}

function copilotHooksConfig(eventList, opts = {}) {
  const hooks = {};
  for (const event of eventList) {
    hooks[event] = [buildEntryFor(event, MARKER, opts)];
  }
  return { version: 1, hooks };
}

function copilotDescriptor(parentDir, overrides = {}) {
  return {
    agentId: "copilot-cli",
    agentName: "Copilot CLI",
    eventSource: "hook",
    parentDir,
    configPath: path.join(parentDir, "hooks", "hooks.json"),
    settingsPath: path.join(parentDir, "settings.json"),
    configMode: "copilot-hooks",
    autoInstall: true,
    marker: MARKER,
    hookEvents: COPILOT_HOOK_EVENTS,
    scriptPath: "/app/hooks/copilot-hook.js",
    ...overrides,
  };
}

function runOne(descriptor, options = {}) {
  return checkAgentIntegrations({
    fs,
    prefs: options.prefs || {},
    descriptors: [descriptor],
    validateCommand: options.validateCommand || (() => ({
      ok: true,
      nodeBin: "/usr/bin/node",
      scriptPath: "/app/hooks/copilot-hook.js",
    })),
  }).details[0];
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("Copilot doctor — happy path", () => {
  it("ok when all 13 events register Clawd hook in bash field (12 state + permissionRequest)", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    writeJson(descriptor.configPath, copilotHooksConfig(COPILOT_HOOK_EVENTS));

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
    assert.match(detail.detail, /registered for 13 events/);
    assert.ok(!("fixAction" in detail), "ok should not carry a Fix button");
  });

  it("scans powershell field when bash is absent (Windows-only entries)", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    writeJson(descriptor.configPath, copilotHooksConfig(COPILOT_HOOK_EVENTS, {
      withBash: false,
      withPowershell: true,
    }));

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
  });

  it("scans command field too for entries that only set it (forward compat)", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    writeJson(descriptor.configPath, copilotHooksConfig(COPILOT_HOOK_EVENTS, {
      withBash: false,
      withPowershell: false,
      withCommand: true,
    }));

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
  });
});

describe("Copilot doctor — missing / broken paths", () => {
  it("not-installed when parent dir is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-copilot-doctor-empty-"));
    tempDirs.push(root);
    const descriptor = copilotDescriptor(path.join(root, "absent"));

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-installed");
  });

  it("not-connected when hooks.json file is missing", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    // intentionally no writeJson() — hooks.json absent

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.match(detail.detail, /missing/);
    // autoInstall: true → Fix button SHOULD be attached
    assert.ok(detail.fixAction);
    assert.strictEqual(detail.fixAction.agentId, "copilot-cli");
  });

  it("not-connected listing missing events when hooks.json is partial", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    // Only register 3 of the 13 events
    writeJson(descriptor.configPath, copilotHooksConfig(["sessionStart", "preToolUse", "sessionEnd"]));

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.ok(Array.isArray(detail.missingCopilotHookEvents));
    assert.ok(detail.missingCopilotHookEvents.includes("preCompact"));
    assert.ok(!detail.missingCopilotHookEvents.includes("sessionStart"));
    assert.ok(detail.fixAction, "auto-install should offer Fix on missing-events case");
  });

  it("reports notification and postToolUseFailure missing from an existing 11-event config", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    const oldEvents = [
      "sessionStart", "userPromptSubmitted", "preToolUse", "postToolUse", "sessionEnd",
      "errorOccurred", "agentStop", "subagentStart", "subagentStop", "preCompact", "permissionRequest",
    ];
    writeJson(descriptor.configPath, copilotHooksConfig(oldEvents));

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.deepStrictEqual(detail.missingCopilotHookEvents, ["postToolUseFailure", "notification"]);
    assert.strictEqual(detail.fixAction.agentId, "copilot-cli");
  });

  it("reports only postToolUseFailure missing from an existing 12-event config", () => {
    const descriptor = copilotDescriptor(makeTempCopilotHome());
    writeJson(descriptor.configPath, copilotHooksConfig(COPILOT_HOOK_EVENTS.filter(event => event !== "postToolUseFailure")));
    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.deepStrictEqual(detail.missingCopilotHookEvents, ["postToolUseFailure"]);
    assert.strictEqual(detail.fixAction.agentId, "copilot-cli");
  });

  it("broken-path only when every command in an event fails validation", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    writeJson(descriptor.configPath, copilotHooksConfig(COPILOT_HOOK_EVENTS));

    // Validator marks every command for `preToolUse` as failed, others ok.
    let calls = 0;
    const validate = (command) => {
      calls += 1;
      if (command.includes('"preToolUse"')) {
        return { ok: false, issue: "node-bin-missing", fragment: command.slice(0, 32) };
      }
      return { ok: true, nodeBin: "/usr/bin/node", scriptPath: "/app/hooks/copilot-hook.js" };
    };

    const detail = runOne(descriptor, { validateCommand: validate });
    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.brokenCopilotHookEvent, "preToolUse");
    assert.ok(calls >= COPILOT_HOOK_EVENTS.length, "validator should run for every event");
  });

  it("ok when at least one command (e.g., powershell) per event validates, even if bash fails", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    writeJson(descriptor.configPath, copilotHooksConfig(COPILOT_HOOK_EVENTS));

    // Validator fails bash but passes powershell for every event.
    const validate = (command) => command.startsWith('& ')
      ? { ok: true, nodeBin: "/usr/bin/node", scriptPath: "/app/hooks/copilot-hook.js" }
      : { ok: false, issue: "node-bin-missing", fragment: command.slice(0, 32) };

    const detail = runOne(descriptor, { validateCommand: validate });
    assert.strictEqual(detail.status, "ok", `expected ok, got ${detail.status} (detail: ${detail.detail})`);
  });
});

describe("Copilot doctor — disableAllHooks", () => {
  it("not-connected + level:warning + disabled-file when hooks.json sets disableAllHooks", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    const cfg = copilotHooksConfig(COPILOT_HOOK_EVENTS);
    cfg.disableAllHooks = true;
    writeJson(descriptor.configPath, cfg);

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.ok(detail.supplementary);
    assert.strictEqual(detail.supplementary.key, "copilot_hooks");
    assert.strictEqual(detail.supplementary.value, "disabled-file");
    // Fix button MUST be suppressed: user explicitly disabled hooks.
    assert.ok(!("fixAction" in detail),
      `Fix button should not appear when disableAllHooks=true; got: ${JSON.stringify(detail.fixAction)}`);
  });

  it("not-connected + level:warning + disabled-global when settings.json sets disableAllHooks", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    writeJson(descriptor.configPath, copilotHooksConfig(COPILOT_HOOK_EVENTS));
    writeJson(descriptor.settingsPath, { disableAllHooks: true });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.supplementary.key, "copilot_hooks");
    assert.strictEqual(detail.supplementary.value, "disabled-global");
    assert.ok(!("fixAction" in detail));
  });

  it("file-level disableAllHooks takes precedence over settings.json", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    const cfg = copilotHooksConfig(COPILOT_HOOK_EVENTS);
    cfg.disableAllHooks = true;
    writeJson(descriptor.configPath, cfg);
    writeJson(descriptor.settingsPath, { disableAllHooks: true });

    const detail = runOne(descriptor);
    // file-level check runs first
    assert.strictEqual(detail.supplementary.value, "disabled-file");
  });

  it("ignores parse errors in settings.json and falls through to hook validation", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    writeJson(descriptor.configPath, copilotHooksConfig(COPILOT_HOOK_EVENTS));
    fs.writeFileSync(descriptor.settingsPath, "{ invalid", "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
  });
});

describe("Copilot doctor — coexistence with user hooks", () => {
  it("user entries without copilot-hook.js marker do not affect validation", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    const cfg = copilotHooksConfig(COPILOT_HOOK_EVENTS);
    // Mix in user-authored hooks per event
    for (const event of COPILOT_HOOK_EVENTS) {
      cfg.hooks[event].unshift({
        type: "command",
        bash: "echo my-user-hook",
        powershell: "Write-Host my-user-hook",
        timeoutSec: 3,
      });
    }
    writeJson(descriptor.configPath, cfg);

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
  });

  it("config-corrupt when hooks.json is malformed", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    fs.writeFileSync(descriptor.configPath, "{ not valid json", "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "config-corrupt");
  });
});

describe("Copilot doctor — safe-v1 permission-user-hook signal", () => {
  // The installer's safe-v1 silently skips permissionRequest when a user
  // hook is present anywhere in the hooks/ directory. The doctor must
  // mirror that signal so the UI doesn't:
  //   1. show "missing permissionRequest" + a Fix button that does nothing.
  //   2. quietly report ok while a sibling user hook owns the event.

  it("annotates ok + supplementary when a non-Clawd entry sits alongside Clawd in hooks.json", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    const cfg = copilotHooksConfig(COPILOT_HOOK_EVENTS);
    cfg.hooks.permissionRequest.unshift({
      type: "command",
      bash: "/usr/local/bin/user-audit.sh",
      timeoutSec: 30,
    });
    writeJson(descriptor.configPath, cfg);

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.supplementary && detail.supplementary.key, "copilot_hooks");
    assert.strictEqual(detail.supplementary.value, "permission-user-hook");
    assert.ok(!("fixAction" in detail), "Fix must be suppressed when a user hook owns permissionRequest");
  });

  it("annotates ok + supplementary when a sibling *.json declares permissionRequest", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    // hooks.json: Clawd state hooks only, no permissionRequest entry
    const stateOnly = COPILOT_HOOK_EVENTS.filter((e) => e !== "permissionRequest");
    writeJson(descriptor.configPath, copilotHooksConfig(stateOnly));
    // sibling file: user permission hook
    fs.writeFileSync(
      path.join(parentDir, "hooks", "security-audit.json"),
      JSON.stringify({
        version: 1,
        hooks: { permissionRequest: [{ type: "command", bash: "/usr/local/bin/user-audit.sh" }] },
      }, null, 2),
      "utf8",
    );

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok",
      `expected ok with sibling permission-user-hook annotation, got ${detail.status} (${detail.detail})`);
    assert.strictEqual(detail.supplementary && detail.supplementary.value, "permission-user-hook");
    assert.ok(!("fixAction" in detail), "Fix must be suppressed for cross-file safe-v1");
  });

  it("annotates ok + supplementary when settings.json declares an inline permissionRequest hook", () => {
    // Codex review 3 — settings.json `hooks` block merges into Copilot's
    // hook chain. Doctor must mirror the installer's safe-v1 detection.
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    // Only state events in hooks.json — no permissionRequest.
    const stateOnly = COPILOT_HOOK_EVENTS.filter((e) => e !== "permissionRequest");
    writeJson(descriptor.configPath, copilotHooksConfig(stateOnly));
    // Inline hook in settings.json.
    writeJson(descriptor.settingsPath, {
      hooks: { permissionRequest: [{ type: "command", bash: "/usr/local/bin/inline-audit" }] },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok",
      `expected ok with settings-inline annotation, got ${detail.status} (${detail.detail})`);
    assert.strictEqual(detail.supplementary && detail.supplementary.value, "permission-user-hook");
    assert.ok(!("fixAction" in detail), "Fix must be suppressed for inline settings hook");
  });

  it("does not mistake an empty sibling permissionRequest array for a user hook", () => {
    const parentDir = makeTempCopilotHome();
    const descriptor = copilotDescriptor(parentDir);
    writeJson(descriptor.configPath, copilotHooksConfig(COPILOT_HOOK_EVENTS));
    fs.writeFileSync(
      path.join(parentDir, "hooks", "empty-extras.json"),
      JSON.stringify({ version: 1, hooks: { permissionRequest: [] } }, null, 2),
      "utf8",
    );

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
    assert.ok(!detail.supplementary || detail.supplementary.value !== "permission-user-hook");
  });
});
