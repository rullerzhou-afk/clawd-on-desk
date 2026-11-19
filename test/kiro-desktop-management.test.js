"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { registerKiroDesktopHooks } = require("../hooks/kiro-desktop-install");
const { getAgentDescriptor } = require("../src/doctor-detectors/agent-descriptors");
const { checkAgentIntegrations } = require("../src/doctor-detectors/agent-integrations");
const { detectAgentInstallation } = require("../src/agent-installation-detector");
const { createIntegrationSyncRuntime } = require("../src/integration-sync");
const { cleanupIntegrations, AGENT_CLEANERS, buildCleanupOptionsForHome } = require("../hooks/cleanup-integrations");
const prefs = require("../src/prefs");

// Keep management, Doctor and detection checks inside an isolated home.
function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-desktop-management-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const options = { homeDir, nodeBin: process.execPath, platform: process.platform };
  const hooksPath = path.join(homeDir, ".kiro", "hooks", "clawd-on-desk.json");
  const descriptor = {
    ...getAgentDescriptor("kiro-desktop"),
    parentDir: path.join(homeDir, ".kiro"),
    configPath: hooksPath,
  };
  const snapshot = prefs.getDefaults();
  Object.assign(snapshot.agents["kiro-desktop"], { integrationInstalled: true, enabled: true });
  const doctor = () => checkAgentIntegrations({
    descriptors: [descriptor],
    prefs: snapshot,
    homeDir,
    platform: options.platform,
    env: {},
    fs,
  }).details[0];
  return { homeDir, options, hooksPath, descriptor, snapshot, doctor };
}

test("kiro-desktop: defaults keep integration opt-in and reminder enabled", () => {
  assert.deepEqual(prefs.getDefaults().agents["kiro-desktop"], {
    integrationInstalled: false,
    enabled: false,
    permissionsEnabled: true,
  });
});

test("kiro-desktop: Doctor validates five triggers, exact ownership and real script paths", t => {
  const f = fixture(t);
  registerKiroDesktopHooks(f.options);
  assert.equal(f.doctor().status, "ok");
  f.snapshot.agents["kiro-desktop"].permissionsEnabled = false;
  assert.match(f.doctor().permissionBubbleDetail, /Kiro IDE.*关闭/);
  let doc = JSON.parse(fs.readFileSync(f.hooksPath));
  doc.hooks.pop();
  fs.writeFileSync(f.hooksPath, JSON.stringify(doc));
  assert.equal(f.doctor().status, "not-connected");
  assert.deepEqual(f.doctor().missingHookEvents, ["Stop"]);
  registerKiroDesktopHooks(f.options);
  doc = JSON.parse(fs.readFileSync(f.hooksPath));
  doc.hooks[0].action.command += " --extra";
  fs.writeFileSync(f.hooksPath, JSON.stringify(doc));
  assert.equal(f.doctor().status, "not-connected");
  registerKiroDesktopHooks({ ...f.options, scriptPath: path.join(f.homeDir, "missing", "kiro-desktop-hook.js") });
  assert.equal(f.doctor().status, "broken-path");
  fs.writeFileSync(f.hooksPath, "{");
  assert.equal(f.doctor().status, "config-corrupt");
});

test("kiro-desktop: product detection ignores the shared Kiro home and recognizes sessions or Mac apps", t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.homeDir, ".kiro"));
  const detect = () => detectAgentInstallation(f.descriptor, { homeDir: f.homeDir, platform: "linux", env: {} });
  assert.equal(detect().detectedInstalled, false);
  fs.mkdirSync(path.join(f.homeDir, ".kiro", "sessions"));
  assert.equal(detect().confidence, "medium");
  const mac = detectAgentInstallation(f.descriptor, {
    homeDir: f.homeDir,
    platform: "darwin",
    env: {},
    fs: {
      ...fs,
      statSync(filename) {
        if (filename === path.join(f.homeDir, "Applications", "Kiro.app")) {
          return { isDirectory: () => true, isFile: () => false };
        }
        if (filename === "/Applications/Kiro.app") {
          const err = new Error("missing");
          err.code = "ENOENT";
          throw err;
        }
        return fs.statSync(filename);
      },
    },
  });
  assert.equal(mac.confidence, "high");
});

test("kiro-desktop: idempotent count sync becomes ok and exports a direct sync method", t => {
  const f = fixture(t);
  registerKiroDesktopHooks(f.options);
  const sync = createIntegrationSyncRuntime({ ctx: { syncKiroDesktopHooksImpl: undefined } });
  const installer = require("../hooks/kiro-desktop-install");
  const original = installer.registerKiroDesktopHooks;
  installer.registerKiroDesktopHooks = () => original(f.options);
  try {
    assert.equal(sync.syncIntegrationForAgent("kiro-desktop").status, "ok");
    assert.equal(sync.syncKiroDesktopHooks().status, "ok");
  } finally {
    installer.registerKiroDesktopHooks = original;
  }
});

test("kiro-desktop: aggregate cleanup passes the isolated home and preserves foreign data", async t => {
  const f = fixture(t);
  registerKiroDesktopHooks(f.options);
  const plan = buildCleanupOptionsForHome(f.homeDir, { env: {} });
  assert.equal(plan.byAgent["kiro-desktop"].homeDir, f.homeDir);
  assert.equal(AGENT_CLEANERS["kiro-desktop"](plan.byAgent["kiro-desktop"]).removed, 5);
  assert.equal(fs.existsSync(f.hooksPath), false);
  registerKiroDesktopHooks(f.options);
  const result = await cleanupIntegrations({ homeDir: f.homeDir, env: {}, silent: true, agentIds: ["kiro-desktop"] });
  const entry = result.agents.find(agent => agent.agentId === "kiro-desktop");
  assert.equal(entry.registrationRemoved, true);
  assert.equal(fs.existsSync(f.hooksPath), false);
  fs.writeFileSync(f.hooksPath, "{");
  const failed = await cleanupIntegrations({ homeDir: f.homeDir, env: {}, silent: true, agentIds: ["kiro-desktop"] });
  const failure = failed.agents.find(agent => agent.agentId === "kiro-desktop");
  assert.equal(failure.status, "failed");
  assert.equal(failure.registrationRemoved, null);
  assert.equal(fs.readFileSync(f.hooksPath, "utf8"), "{");
});
