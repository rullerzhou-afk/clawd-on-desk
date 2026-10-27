"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPermissionIngressHarness, postPermission, waitUntil } = require("./helpers/permission-ingress-harness");

test("Auto keeps automatic and human approval sockets independent", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-routing-http-"));
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  fs.mkdirSync(path.join(home, "sessions"));
  const sidA = "01a119d3-1893-7f42-aadc-fa33ca4166a8";
  const sidB = "019d23d4-f1a9-7633-b9c7-758327137228";
  const turn = "01a119d7-24b5-7010-9da2-d8791ff8a1d1";
  function body(sid, reviewer) {
    const file = path.join(home, "sessions", "rollout-" + sid + ".jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ type: "session_meta", payload: { id: sid } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: turn,
        approvals_reviewer: reviewer, approval_policy: "on-request" } }),
    ].join("\n") + "\n");
    return { agent_id: "codex", hook_source: "codex-official", session_id: "codex:" + sid,
      turn_id: turn, permission_mode: "default", transcript_path: file,
      tool_name: "Bash", tool_input: { command: "echo harmless" } };
  }
  const h = await createPermissionIngressHarness({ ctxOverrides: {
    getCodexPermissionMode: () => "auto",
  } });
  t.after(async () => {
    await h.close();
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const human = postPermission(h.port, body(sidA, "user"));
  await waitUntil(() => h.permission.pendingPermissions.length === 1, "human request not mirrored");
  const entry = h.permission.pendingPermissions[0];
  assert.equal(entry.codexAutoManual, true);
  assert.equal(human.settled, false);
  const automatic = postPermission(h.port, body(sidB, "auto_review"));
  const native = await automatic.response;
  assert.equal(native.status, 204);
  assert.equal(native.body, "");
  assert.equal(h.permission.pendingPermissions.length, 1);
  assert.equal(h.shown.length, 1);
  assert.equal(human.settled, false);
  h.permission.resolvePermissionEntry(entry, "allow");
  const result = await human.response;
  assert.equal(JSON.parse(result.body).hookSpecificOutput.decision.behavior, "allow");
  assert.equal(h.permission.pendingPermissions.length, 0);
});

// #1186: Auto hands WSL requests back to Codex, which silently disabled the
// user's global auto-allow for them. Global automation now claims them again.
test("Auto lets global automation allow a WSL Bash request", async (t) => {
  let mode = "auto-tools";
  const h = await createPermissionIngressHarness({ render: true, ctxOverrides: {
    getCodexPermissionMode: () => "auto",
    getEffectivePermissionAutomationMode: () => mode,
  } });
  t.after(() => h.close());
  const body = (command) => ({ agent_id: "codex", hook_source: "codex-official",
    session_id: "codex:01a119d3-1893-7f42-aadc-fa33ca4166a8", wsl_distro: "Ubuntu",
    turn_id: "01a119d7-24b5-7010-9da2-d8791ff8a1d1", permission_mode: "default",
    tool_name: "Bash", tool_input: { command } });

  const allowed = await postPermission(h.port, body("ssh box uptime")).response;
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(allowed.body).hookSpecificOutput.decision.behavior, "allow");

  const mcp = await postPermission(h.port, { ...body("x"), tool_name: "mcp__github__get_issue",
    tool_input: { number: 1 } }).response;
  assert.equal(mcp.status, 204);

  mode = "off";
  const native = await postPermission(h.port, body("ssh box uptime")).response;
  assert.equal(native.status, 204);
  assert.equal(native.body, "");
  assert.equal(h.permission.pendingPermissions.length, 0);
});

test("external review is skipped before Codex native fallbacks", async (t) => {
  const cases = [
    {
      label: "mcp",
      body: {
        agent_id: "codex", hook_source: "codex-official",
        session_id: "codex:review-mcp", tool_name: "mcp__github__get_issue",
        tool_input: { number: 1 },
      },
      expectedNotificationUpdates: 1,
    },
    {
      label: "bubble-gate",
      body: {
        agent_id: "codex", hook_source: "codex-official",
        session_id: "codex:review-bubble", wsl_distro: "Ubuntu",
        tool_name: "Bash", tool_input: { command: "echo bubble" },
      },
      ctxOverrides: {
        getBubblePolicy: () => ({ enabled: false, autoCloseMs: 0 }),
      },
    },
    {
      label: "intercept-bubble-gate",
      body: {
        agent_id: "codex", hook_source: "codex-official",
        session_id: "codex:review-intercept-bubble", wsl_distro: "Ubuntu",
        tool_name: "Bash", tool_input: { command: "echo intercept bubble" },
      },
      ctxOverrides: {
        getCodexPermissionMode: () => "intercept",
        getBubblePolicy: () => ({ enabled: false, autoCloseMs: 0 }),
      },
      expectedNotificationUpdates: 0,
    },
    {
      label: "agent-gate",
      body: {
        agent_id: "codex", hook_source: "codex-official",
        session_id: "codex:review-agent-gate", wsl_distro: "Ubuntu",
        tool_name: "Bash", tool_input: { command: "echo agent gate" },
      },
      ctxOverrides: {
        isAgentPermissionsEnabled: (id) => id !== "codex",
      },
    },
  ];
  const originalCodexHome = process.env.CODEX_HOME;
  t.after(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  // A local automatic reviewer is an explicit Codex owner, so it gets its own
  // transcript fixture rather than relying on the WSL/nonlocal claim shape.
  const localHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-local-"));
  fs.mkdirSync(path.join(localHome, "sessions"));
  const localSession = "01a119d3-1893-7f42-aadc-fa33ca4166a8";
  const localTurn = "01a119d7-24b5-7010-9da2-d8791ff8a1d1";
  const localTranscript = path.join(localHome, "sessions", `rollout-${localSession}.jsonl`);
  fs.writeFileSync(localTranscript, [
    JSON.stringify({ type: "session_meta", payload: { id: localSession } }),
    JSON.stringify({ type: "turn_context", payload: {
      turn_id: localTurn, approvals_reviewer: "auto_review", approval_policy: "on-request",
    } }),
  ].join("\n") + "\n");
  cases.push({
    label: "local-reviewer",
    body: {
      agent_id: "codex", hook_source: "codex-official",
      session_id: `codex:${localSession}`, turn_id: localTurn,
      transcript_path: localTranscript, permission_mode: "default",
      tool_name: "Bash", tool_input: { command: "echo local" },
    },
    useHome: localHome,
  });

  for (const testCase of cases) {
    const home = testCase.useHome || fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-skip-"));
    const marker = path.join(home, `${testCase.label}.reviewed`);
    process.env.CODEX_HOME = home;
    const h = await createPermissionIngressHarness({
      render: true,
      ctxOverrides: {
        getCodexPermissionMode: () => "auto",
        getEffectivePermissionAutomationMode: () => "auto-tools",
        getPermissionReviewConfig: () => ({
          command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "called");process.exit(0);`],
          timeoutMs: 5000,
        }),
        ...(testCase.ctxOverrides || {}),
      },
    });
    try {
      const response = await postPermission(h.port, testCase.body).response;
      assert.equal(response.status, 204, testCase.label);
      assert.equal(response.body, "", testCase.label);
      assert.equal(fs.existsSync(marker), false, `${testCase.label} must not spawn the review command`);
      assert.equal(h.permission.pendingPermissions.length, 0, testCase.label);
      if (typeof testCase.expectedNotificationUpdates === "number") {
        assert.equal(
          h.updates.filter((args) => args[1] === "notification" && args[2] === "PermissionRequest").length,
          testCase.expectedNotificationUpdates,
          `${testCase.label} notification update count`
        );
      }
    } finally {
      await h.close();
      if (!testCase.useHome) fs.rmSync(home, { recursive: true, force: true });
    }
  }
  fs.rmSync(localHome, { recursive: true, force: true });
});

test("external review can claim a WSL Bash request, but held/error results return it to Codex", async (t) => {
  const originalCodexHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-claim-"));
  t.after(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.CODEX_HOME = home;
  const body = {
    agent_id: "codex", hook_source: "codex-official",
    session_id: "codex:01a119d3-1893-7f42-aadc-fa33ca4166a8",
    wsl_distro: "Ubuntu", tool_name: "Bash", tool_input: { command: "echo reviewed" },
  };
  const reviewCases = [
    {
      label: "allow",
      config: (marker) => ({
        command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "called");process.exit(0);`],
        timeoutMs: 5000,
      }),
      expected: 200,
    },
    {
      label: "exit-1",
      config: (marker) => ({
        command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "called");process.exit(1);`],
        timeoutMs: 5000,
      }),
      expected: 204,
    },
    {
      label: "timeout",
      config: (marker) => ({
        command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "called");setTimeout(() => {}, 10000);`],
        timeoutMs: 100,
      }),
      expected: 204,
    },
    {
      label: "settings-error",
      config: () => { throw new Error("settings unavailable"); },
      expected: 204,
    },
  ];

  for (const testCase of reviewCases) {
    const marker = path.join(home, `${testCase.label}.reviewed`);
    const h = await createPermissionIngressHarness({
      render: true,
      ctxOverrides: {
        getCodexPermissionMode: () => "auto",
        getEffectivePermissionAutomationMode: () => "auto-tools",
        getPermissionReviewConfig: () => testCase.config(marker),
      },
    });
    try {
      const response = await postPermission(h.port, body).response;
      assert.equal(response.status, testCase.expected, testCase.label);
      if (testCase.label === "allow") {
        assert.equal(JSON.parse(response.body).hookSpecificOutput.decision.behavior, "allow");
      } else {
        assert.equal(response.body, "", testCase.label);
      }
      if (testCase.label === "settings-error") {
        assert.equal(fs.existsSync(marker), false);
      } else {
        assert.equal(fs.existsSync(marker), true, testCase.label);
      }
      assert.equal(h.permission.pendingPermissions.length, 0, testCase.label);
    } finally {
      await h.close();
    }
  }
});

test("Auto keeps a local automatic reviewer in charge even with global automation on", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-routing-http-"));
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  fs.mkdirSync(path.join(home, "sessions"));
  const sid = "01a119d3-1893-7f42-aadc-fa33ca4166a8";
  const turn = "01a119d7-24b5-7010-9da2-d8791ff8a1d1";
  const file = path.join(home, "sessions", "rollout-" + sid + ".jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "session_meta", payload: { id: sid } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: turn,
      approvals_reviewer: "auto_review", approval_policy: "on-request" } }),
  ].join("\n") + "\n");
  const h = await createPermissionIngressHarness({ render: true, ctxOverrides: {
    getCodexPermissionMode: () => "auto",
    getEffectivePermissionAutomationMode: () => "auto-tools",
  } });
  t.after(async () => {
    await h.close();
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const native = await postPermission(h.port, { agent_id: "codex", hook_source: "codex-official",
    session_id: "codex:" + sid, turn_id: turn, permission_mode: "default", transcript_path: file,
    tool_name: "Bash", tool_input: { command: "echo harmless" } }).response;
  assert.equal(native.status, 204);
  assert.equal(native.body, "");
  assert.equal(h.permission.pendingPermissions.length, 0);
});
