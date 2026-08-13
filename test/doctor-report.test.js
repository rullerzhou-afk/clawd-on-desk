const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  redact,
  redactDoctorResult,
  formatAgentDetail,
  formatDiagnosticReport,
  normalizeDisplayPathSeparators,
} = require("../src/doctor-report");

describe("doctor report redaction", () => {
  it("redacts home paths across common platforms", () => {
    const text = [
      "C:\\Users\\Alice\\AppData\\Roaming",
      "/Users/bob/.codex/hooks.json",
      "/home/carol/.config/opencode/opencode.json",
    ].join("\n");

    const out = redact(text, { homeDir: "C:\\Users\\Alice" });
    assert.ok(!out.includes("Alice"));
    assert.ok(!out.includes("/Users/bob"));
    assert.ok(!out.includes("/home/carol"));
    assert.ok(out.includes("~/"));
  });

  it("redacts common secret shapes and non-loopback IP addresses", () => {
    const out = redact([
      "sk-abcdefghijklmnopqrstuvwxyz",
      "Bearer secret-token",
      "xoxb-123-secret",
      "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
      "github_pat_abc123",
      "AKIA1234567890ABCDEF",
      '"password": "secret"',
      '"api_key": "secret"',
      "10.0.0.12",
      "127.0.0.1",
    ].join("\n"));

    assert.ok(!out.includes("secret-token"));
    assert.ok(!out.includes("10.0.0.12"));
    assert.ok(out.includes("127.0.0.1"));
    assert.ok(out.includes("[IP]"));
    assert.ok(out.includes("[REDACTED]"));
  });

  it("redacts configured Clawd app roots without consuming the rest of the path", () => {
    const out = redact([
      "D:/animation/hooks/opencode-plugin",
      "D:\\animation\\hooks\\codex-hook.js",
      "D:/other/hooks/opencode-plugin",
    ].join("\n"), {
      appRoot: "D:\\animation",
    });

    assert.ok(!out.includes("D:/animation"));
    assert.ok(!out.includes("D:\\animation"));
    assert.ok(out.includes("[APP]/hooks/opencode-plugin"));
    assert.ok(out.includes("[APP]/hooks/codex-hook.js"));
    assert.ok(out.includes("D:/other/hooks/opencode-plugin"));
  });

  it("normalizes redacted display path separators", () => {
    assert.strictEqual(
      normalizeDisplayPathSeparators("~/.claude\\settings.json and [APP]\\hooks\\opencode-plugin"),
      "~/.claude/settings.json and [APP]/hooks/opencode-plugin"
    );
    assert.strictEqual(
      redact("C:\\Users\\Alice\\.claude\\settings.json", { homeDir: "C:\\Users\\Alice" }),
      "~/.claude/settings.json"
    );
  });

  it("redacts nested doctor results before they are sent to the Settings UI", () => {
    const result = redactDoctorResult({
      checks: [{
        id: "agent-integrations",
        detail: "C:\\Users\\Alice\\.clawd\\runtime.json",
        details: [{
          agentName: "Cursor Agent",
          detail: "C:\\Users\\Alice\\.cursor\\hooks.json missing",
          opencodeEntry: "/Users/bob/.config/opencode/opencode.json",
          appEntry: "D:/animation/hooks/opencode-plugin",
        }],
      }],
    }, { homeDir: "C:\\Users\\Alice", appRoot: "D:\\animation" });

    const text = JSON.stringify(result);
    assert.ok(!text.includes("Alice"));
    assert.ok(!text.includes("/Users/bob"));
    assert.ok(!text.includes("D:/animation"));
    assert.ok(text.includes("~/.cursor"));
    assert.ok(text.includes("~/.config/opencode"));
    assert.ok(text.includes("[APP]/hooks/opencode-plugin"));
    assert.ok(!text.includes("~/.cursor\\hooks.json"));
  });
});

describe("formatDiagnosticReport", () => {
  it("formats structured agent diagnostics into visible detail text", () => {
    const detail = formatAgentDetail({
      detail: "hook registered",
      permissionBubbleDetail: "permission bubbles disabled for this agent",
      supplementary: {
        key: "hooks",
        value: "uncertain",
        detail: "config missing",
      },
      codexHookTrust: {
        key: "codex_hook_trust",
        value: "needs-review",
        detail: "2/2 Clawd Codex hook(s) need Codex /hooks review: PermissionRequest, Stop",
      },
      kiroScan: {
        fullyValidFiles: ["clawd.json"],
        brokenFiles: ["custom.json"],
        noMarkerFiles: ["other.json"],
        corruptFiles: ["bad.json"],
      },
      opencodeEntryIssue: "directory-missing",
      opencodeEntry: "C:\\Users\\Alice\\opencode-plugin",
    });

    assert.match(detail, /permission bubbles disabled/);
    assert.match(detail, /hooks=uncertain/);
    assert.match(detail, /codex_hook_trust=needs-review/);
    assert.match(detail, /PermissionRequest, Stop/);
    assert.match(detail, /valid=clawd\.json/);
    assert.match(detail, /broken=custom\.json/);
    assert.match(detail, /corrupt=bad\.json/);
    assert.match(detail, /no-marker=1/);
    assert.match(detail, /plugin issue: directory-missing/);
    assert.match(detail, /plugin entry:/);
  });

  it("formats Gemini supplementary diagnostics into visible detail text", () => {
    const detail = formatAgentDetail({
      detail: "Gemini hooks are disabled in settings.json; Clawd preserves this user setting and will not receive hook events",
      supplementary: {
        key: "gemini_hooks",
        value: "disabled-global",
        detail: "hooksConfig.enabled is false",
      },
    });

    assert.match(detail, /gemini_hooks=disabled-global/);
    assert.match(detail, /hooksConfig\.enabled is false/);
  });

  it("formats summary and agent integration details", () => {
    const report = formatDiagnosticReport({
      generatedAt: "2026-04-28T14:32:00.000Z",
      overall: { status: "warning", issueCount: 1 },
      checks: [
        { id: "local-server", status: "pass", level: null, detail: "Listening on 127.0.0.1:23333" },
        {
          id: "agent-integrations",
          status: "warning",
          level: "warning",
          detail: "1 warning",
          details: [
            {
              agentId: "cursor-agent",
              agentName: "Cursor Agent",
              eventSource: "hook",
              status: "not-connected",
              detail: "C:\\Users\\Alice\\.cursor\\hooks.json missing",
              permissionBubbleDetail: "permission bubbles disabled for this agent",
              supplementary: {
                key: "hooks",
                value: "uncertain",
                detail: "config missing",
              },
              kiroScan: {
                fullyValidFiles: ["clawd.json"],
                brokenFiles: [],
                noMarkerFiles: [],
                corruptFiles: [],
              },
              opencodeEntryIssue: "directory-missing",
              opencodeEntry: "D:/animation/hooks/opencode-plugin",
            },
          ],
        },
      ],
      connectionTest: {
        status: "http-dropped",
        level: "warning",
        detail: "HTTP works but events were dropped",
        events: [{
          agentId: "codex",
          route: "permission",
          outcome: "dropped-by-dnd",
          eventType: "PermissionRequest",
        }],
        fileActivity: [{
          agentId: "codex",
          source: "file-mtime",
          count: 1,
        }],
      },
    }, {
      version: "0.6.2",
      platform: "win32",
      release: "10.0.26200",
      locale: "zh",
      homeDir: "C:\\Users\\Alice",
      appRoot: "D:\\animation",
    });

    assert.match(report, /# Clawd Diagnostic Report/);
    assert.match(report, /Overall: WARNING/);
    assert.match(report, /Cursor Agent/);
    assert.match(report, /permission bubbles disabled/);
    assert.match(report, /hooks=uncertain/);
    assert.match(report, /valid=clawd\.json/);
    assert.match(report, /plugin issue: directory-missing/);
    assert.match(report, /\[APP\]\/hooks\/opencode-plugin/);
    assert.match(report, /## Connection Test/);
    assert.match(report, /HTTP works but events were dropped/);
    assert.match(report, /dropped-by-dnd/);
    assert.match(report, /Fallback file activity also observed: codex \(1\)\./);
    assert.doesNotMatch(report, /\| gemini-cli \| file-mtime \| 1 \|/);
    assert.ok(!report.includes("Alice"));
    assert.ok(!report.includes("D:/animation"));
    assert.ok(report.includes("~/.cursor"));
    assert.ok(!report.includes("~/.cursor\\hooks.json"));
  });

  it("keeps the fallback file table when no HTTP event reached Clawd", () => {
    const report = formatDiagnosticReport({
      generatedAt: "2026-04-28T14:32:00.000Z",
      overall: { status: "warning", issueCount: 1 },
      checks: [],
      connectionTest: {
        status: "http-blocked",
        level: "warning",
        detail: "File activity changed, but no HTTP hook event reached Clawd.",
        events: [],
        fileActivity: [{
          agentId: "codex",
          source: "file-mtime",
          count: 2,
        }],
      },
    });

    assert.match(report, /## Connection Test/);
    assert.match(report, /\| codex \| file-mtime \| 2 \|/);
    assert.doesNotMatch(report, /Fallback file activity also observed/);
  });

  it("reports pending Codex hook review without claiming HTTP was blocked", () => {
    const report = formatDiagnosticReport({
      generatedAt: "2026-08-11T00:00:00.000Z",
      overall: { status: "warning", issueCount: 1 },
      checks: [],
      connectionTest: {
        status: "hooks-need-review",
        level: "warning",
        detail: "Codex activity was detected. Run /hooks in Codex CLI, then test again.",
        events: [],
        fileActivity: [{
          agentId: "codex",
          source: "file-mtime",
          count: 1,
        }],
      },
    });

    assert.match(report, /HOOKS-NEED-REVIEW/);
    assert.match(report, /\/hooks/);
    assert.match(report, /\| codex \| file-mtime \| 1 \|/);
    assert.doesNotMatch(report, /HTTP-BLOCKED|Firewall, EDR|proxy interception is likely/);
  });
});
