"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const {
  resolveRemoteRuntimeLayout,
  collectRemoteLayoutPathSet,
} = require("../src/remote-ssh-layout");
const serverConfig = require("../hooks/server-config");
const claudeInstall = require("../hooks/install");
const codexInstall = require("../hooks/codex-install-utils");
const copilotInstall = require("../hooks/copilot-install");
const { __test: statuslineTest } = require("../hooks/claude-statusline");
const { __test: monitorTest } = require("../hooks/codex-remote-monitor");
const recoveryLease = require("../hooks/session-recovery-lease");
const { __test: deployTest } = require("../src/remote-ssh-deploy");

const REPO_ROOT = path.join(__dirname, "..");

test("synthetic isolated env resolves every mutable hook path away from poison HOME", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-path-isolation-"));
  const poison = path.join(temp, "poison-home");
  const remoteHome = path.join(temp, "remote-home");
  const layout = resolveRemoteRuntimeLayout({
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_a",
    remoteHome,
  });
  const env = {
    HOME: poison,
    CLAUDE_CONFIG_DIR: layout.claudeConfigDir,
    CODEX_HOME: layout.codexHome,
    COPILOT_HOME: layout.copilotHome,
    CLAWD_REMOTE: "1",
    CLAWD_SSH_REMOTE: "1",
    CLAWD_REMOTE_IDENTITY_PATH: layout.identityFile,
    CLAWD_SSH_SECURE_MARKER_PATH: layout.secureMarkerFile,
    CLAWD_HOST_PREFIX_PATH: layout.hostPrefixFile,
    CLAWD_REMOTE_LAST_LOG_PATH: layout.lastLogFile,
    CLAWD_STATUSLINE_SIDECAR_PATH: layout.statuslineSidecarFile,
  };
  try {
    assert.equal(claudeInstall.resolveClaudeHome({ env, homeDir: poison }), layout.claudeConfigDir);
    assert.equal(codexInstall.resolveCodexHome({ env, homeDir: poison }), layout.codexHome);
    assert.equal(copilotInstall.resolveCopilotHome({ env, homeDir: poison }), layout.copilotHome);
    assert.equal(monitorTest.resolveCodexSessionDir({ env, homeDir: poison }), layout.codexSessionsDir);
    assert.equal(statuslineTest.resolveChainSidecarPath({ env }), layout.statuslineSidecarFile);
    assert.equal(serverConfig.resolveRemoteIdentityPath({ env }), layout.identityFile);
    assert.equal(serverConfig.resolveSshSecureMarkerPath({ env }), layout.secureMarkerFile);
    assert.equal(serverConfig.resolveRemoteLastLogPath({ env }), layout.lastLogFile);

    fs.mkdirSync(layout.claudeHooksDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(layout.hostPrefixFile, "runtime-a\n", { mode: 0o600 });
    assert.equal(serverConfig.readHostPrefix({ env }), "runtime-a");
    assert.equal(serverConfig.recordSecureTransportFailure("state-delivery-failed", {
      env,
      now: () => 1_700_000_000_000,
    }), true);
    assert.equal(fs.existsSync(layout.lastLogFile), true);

    const lease = recoveryLease.updateRecoveryLeaseFromStateBody({
      agent_id: "claude-code",
      session_id: "session-a",
      state: "working",
      event: "PreToolUse",
    }, {
      remote: true,
      recoveryDir: path.join(poison, ".clawd", "session-recovery-v1"),
    });
    assert.deepEqual(lease, { written: false, reason: "remote-filesystem" });
    assert.equal(fs.existsSync(poison), false);

    const envPrefix = deployTest.buildRemoteInstallerEnv(layout, "path");
    for (const expected of [
      "CLAWD_REMOTE=1",
      "CLAWD_SSH_REMOTE=1",
      layout.claudeConfigDir,
      layout.codexHome,
      layout.copilotHome,
      layout.identityFile,
      layout.secureMarkerFile,
      layout.hostPrefixFile,
      layout.lastLogFile,
      layout.statuslineSidecarFile,
    ]) {
      assert.match(envPrefix, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.doesNotMatch(envPrefix, new RegExp(poison.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("remote hook modules execute in a fresh process without reading or writing poison HOME", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-path-child-"));
  const poison = path.join(temp, "poison-home");
  const remoteHome = path.join(temp, "remote-home");
  const layout = resolveRemoteRuntimeLayout({
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_child",
    remoteHome,
  });
  const env = {
    ...process.env,
    HOME: poison,
    CLAUDE_CONFIG_DIR: layout.claudeConfigDir,
    CODEX_HOME: layout.codexHome,
    COPILOT_HOME: layout.copilotHome,
    CLAWD_REMOTE: "1",
    CLAWD_SSH_REMOTE: "1",
    CLAWD_REMOTE_IDENTITY_PATH: layout.identityFile,
    CLAWD_SSH_SECURE_MARKER_PATH: layout.secureMarkerFile,
    CLAWD_HOST_PREFIX_PATH: layout.hostPrefixFile,
    CLAWD_REMOTE_LAST_LOG_PATH: layout.lastLogFile,
    CLAWD_STATUSLINE_SIDECAR_PATH: layout.statuslineSidecarFile,
  };
  try {
    fs.mkdirSync(layout.claudeHooksDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(layout.hostPrefixFile, "runtime-child\n", { mode: 0o600 });
    fs.writeFileSync(layout.secureMarkerFile, "clawd-ssh-secure-v1\n", { mode: 0o600 });
    fs.writeFileSync(layout.identityFile, JSON.stringify({
      version: 2,
      layoutVersion: layout.layoutVersion,
      runtimeKey: layout.runtimeKey,
      profileId: "profile-child",
      installId: "a".repeat(64),
      remotePort: 23334,
      routingNonce: "b".repeat(32),
      deployedAt: 1,
    }), { mode: 0o600 });

    const script = [
      "const path=require('path');",
      `const serverConfig=require(${JSON.stringify(path.join(REPO_ROOT, "hooks", "server-config.js"))});`,
      `const statusline=require(${JSON.stringify(path.join(REPO_ROOT, "hooks", "claude-statusline.js"))}).__test;`,
      `const monitor=require(${JSON.stringify(path.join(REPO_ROOT, "hooks", "codex-remote-monitor.js"))}).__test;`,
      `const recovery=require(${JSON.stringify(path.join(REPO_ROOT, "hooks", "session-recovery-lease.js"))});`,
      "const identity=serverConfig.readRemoteIdentity({env:process.env});",
      "if(!identity.ok)process.exit(11);",
      "if(serverConfig.readHostPrefix({env:process.env})!=='runtime-child')process.exit(12);",
      "if(!serverConfig.recordSecureTransportFailure('child-process-audit',{env:process.env,now:()=>1700000000000}))process.exit(13);",
      "const lease=recovery.updateRecoveryLeaseFromStateBody({agent_id:'claude-code',session_id:'s',state:'working',event:'PreToolUse'},{remote:true,recoveryDir:path.join(process.env.HOME,'.clawd','session-recovery-v1')});",
      "console.log(JSON.stringify({identity:identity.filePath,lastLog:serverConfig.resolveRemoteLastLogPath({env:process.env}),sidecar:statusline.resolveChainSidecarPath({env:process.env}),sessions:monitor.resolveCodexSessionDir({env:process.env,homeDir:process.env.HOME}),lease}));",
    ].join("");
    const result = childProcess.spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      identity: layout.identityFile,
      lastLog: layout.lastLogFile,
      sidecar: layout.statuslineSidecarFile,
      sessions: layout.codexSessionsDir,
      lease: { written: false, reason: "remote-filesystem" },
    });
    assert.equal(fs.existsSync(layout.lastLogFile), true);
    assert.equal(fs.existsSync(poison), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("two isolated layouts expose disjoint complete live path sets, including wrapper evidence", () => {
  const layouts = ["runtime_a", "runtime_b"].map((runtimeKey) => (
    resolveRemoteRuntimeLayout({
      runtimeMode: "profile-isolated",
      runtimeKey,
      remoteHome: "/home/shared",
    })
  ));
  const sets = layouts.map(collectRemoteLayoutPathSet);
  assert.deepEqual([...sets[0]].filter((item) => sets[1].has(item)), []);
  for (const layout of layouts) {
    for (const required of [
      "identityFile",
      "secureMarkerFile",
      "hostPrefixFile",
      "statuslineSidecarFile",
      "lastLogFile",
      "deployLockDir",
      "deployStagingDir",
      "monitorPidFile",
      "claudeSettingsFile",
      "codexSessionsDir",
      "wrapperEvidenceDir",
      "claudeWrapperEvidenceFile",
      "codexWrapperEvidenceFile",
      "copilotWrapperEvidenceFile",
    ]) {
      assert.equal(sets[layouts.indexOf(layout)].has(layout[required]), true, required);
    }
    assert.equal(layout.legacyMonitorPidFile, null);
  }
});

test("remote-capable modules resolve mutable HOME paths at call time, never module load", () => {
  const files = [
    "hooks/server-config.js",
    "hooks/install.js",
    "hooks/codex-install-utils.js",
    "hooks/copilot-install.js",
    "hooks/codex-remote-monitor.js",
    "hooks/claude-statusline.js",
    "hooks/session-recovery-lease.js",
    "src/remote-ssh-layout.js",
    "src/remote-ssh-runtime.js",
    "src/remote-ssh-deploy.js",
  ];
  const moduleConstant = /^\s*(?:const|let|var)\s+[A-Z0-9_]*(?:HOME|DIR|PATH|FILE)[A-Z0-9_]*\s*=.*(?:os\.)?homedir\(\)/m;
  for (const relative of files) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
    assert.doesNotMatch(source, moduleConstant, relative);
  }
});
