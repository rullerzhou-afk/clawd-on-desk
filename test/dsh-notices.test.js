"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");

const {
  noticesPath,
  readDshNotices,
  applyDshNoticeOutcome,
  acknowledgeDshNotice,
  clearDshNotices,
} = require("../hooks/dsh-notices");
const {
  BRIDGE_PACKAGE_NAME,
  DSH_VERSION_FAMILIES,
  installDeepSeekHarnessBridge,
  uninstallDeepSeekHarnessBridge,
  readDeepSeekHarnessNotices,
  acknowledgeDeepSeekHarnessNotice,
} = require("../hooks/dsh-install");
const { desktopFound: platformDesktopFound, symlinkDir } = require("./dsh-desktop-fixtures");

const SOURCE_DIR = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");
const FAMILY = DSH_VERSION_FAMILIES[0];
const FAMILY_VERSION = FAMILY.minVersion;

const NO_DESKTOP = Object.freeze({
  status: "not-found",
  appRoot: null,
  launcherPath: null,
  staticVersion: null,
  checkedPaths: [],
  reason: null,
});

function desktopFound(harness) {
  return platformDesktopFound(harness.root);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-notices-"));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function packageDir(dshHome, profile) {
  return path.join(dshHome, "profiles", profile, "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
}

function makeHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-notice-orch-"));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "dsh"), "#!/bin/sh\n");
  return { root, dshHome: path.join(root, ".dsh"), managedRoot: path.join(root, "managed"), binDir };
}

function writeProfile(harness, profile) {
  writeJson(path.join(harness.dshHome, "profiles", profile, "package.json"), {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  });
}

function makeCli(harness) {
  const runDshCommand = async (args) => {
    const profile = args[args.indexOf("--profile") + 1];
    const action = args[3];
    const manifestPath = path.join(harness.dshHome, "profiles", profile, "package.json");
    const manifest = fs.existsSync(manifestPath)
      ? readJson(manifestPath)
      : { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
    if (action === "remove") {
      delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => n !== BRIDGE_PACKAGE_NAME);
      writeJson(manifestPath, manifest);
      fs.rmSync(packageDir(harness.dshHome, profile), { recursive: true, force: true });
      return { code: 0 };
    }
    if (action === "add") {
      const generationDir = args[4];
      manifest.dependencies ||= {};
      manifest.dsh ||= { profile: { bundles: [] } };
      manifest.dsh.profile ||= { bundles: [] };
      manifest.dsh.profile.bundles ||= [];
      manifest.dependencies[BRIDGE_PACKAGE_NAME] = `file:${generationDir}`;
      if (!manifest.dsh.profile.bundles.includes(BRIDGE_PACKAGE_NAME)) {
        manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
      }
      writeJson(manifestPath, manifest);
      const target = packageDir(harness.dshHome, profile);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(generationDir, target, { recursive: true });
      return { code: 0 };
    }
    return { code: 1, stderr: "unexpected" };
  };
  return { runDshCommand };
}

function orchOptions(harness, cli, overrides = {}) {
  return {
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    sourceDir: SOURCE_DIR,
    dshInstalled: true,
    pnpmAvailable: true,
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
    runDshCommand: cli.runDshCommand,
    clawdVersion: "1.2.3",
    dshVersion: FAMILY_VERSION,
    dshInstallRoot: null,
    silent: true,
    env: { PATH: harness.binDir },
    desktopDiscovery: NO_DESKTOP,
    ...overrides,
  };
}

function desktopOptions(harness, cli, overrides = {}) {
  return orchOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
    env: { PATH: "" },
    desktopDiscovery: desktopFound(harness),
    ...overrides,
  });
}

function updatedSource(harness, label) {
  const dir = path.join(harness.root, `${label}-source`);
  fs.cpSync(SOURCE_DIR, dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "lib", "index.js"), `\n// ${label} bridge source\n`, "utf8");
  return dir;
}

function noticesFor(root, profile) {
  return readDshNotices(root, profile).then((read) => read.notices);
}

// ---------------------------------------------------------------------------
// Module read/write
// ---------------------------------------------------------------------------

test("notices written and read back in priority order", async (t) => {
  const root = makeRoot(t);
  writeJson(noticesPath(root, "web"), {
    owner: "clawd-on-desk",
    schemaVersion: 1,
    notices: [
      { id: "first-install:f", kind: "first-install", profile: "web", bundleHash: "f", payload: {}, createdAt: "2026-01-01T00:00:04.000Z", acknowledged: false },
      { id: "manual-command:g", kind: "manual-command", profile: "web", bundleHash: "g", payload: { commands: ["a"] }, createdAt: "2026-01-01T00:00:03.000Z", acknowledged: false },
      { id: "failed-target:x:1", kind: "failed-target", profile: "web", payload: { reason: "x" }, createdAt: "2026-01-01T00:00:02.000Z", acknowledged: false },
      { id: "restart-required:r", kind: "restart-required", profile: "web", bundleHash: "r", payload: {}, createdAt: "2026-01-01T00:00:01.000Z", acknowledged: false },
    ],
  });
  const { notices, error } = await readDshNotices(root, "web");
  assert.strictEqual(error, null);
  assert.deepStrictEqual(notices.map((n) => n.kind), [
    "restart-required",
    "failed-target",
    "manual-command",
    "first-install",
  ]);
});

test("a foreign notices file is neither overwritten nor deleted", async (t) => {
  const root = makeRoot(t);
  const filePath = noticesPath(root, "web");
  writeJson(filePath, { owner: "someone-else", schemaVersion: 1, notices: [] });
  const before = fs.readFileSync(filePath);
  const read = await readDshNotices(root, "web");
  assert.ok(read.error);
  assert.deepStrictEqual(read.notices, []);
  const applied = await applyDshNoticeOutcome(root, "web", { operation: "install", status: "ok", bundleHash: "x" });
  assert.ok(applied.error);
  assert.deepStrictEqual(fs.readFileSync(filePath), before);
});

test("an unparseable notices file is left in place", async (t) => {
  const root = makeRoot(t);
  const filePath = noticesPath(root, "web");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{ not-json", "utf8");
  const read = await readDshNotices(root, "web");
  assert.ok(read.error);
  assert.strictEqual(fs.readFileSync(filePath, "utf8"), "{ not-json");
});

test("a failed notice write leaves the original file unchanged", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "keep" } });
  const filePath = noticesPath(root, "web");
  const before = fs.readFileSync(filePath);
  const applied = await applyDshNoticeOutcome(root, "web",
    { operation: "install", failure: { reason: "replace" } },
    { writeFile: async (target) => { fs.writeFileSync(target, "partial", "utf8"); throw new Error("disk full"); } });
  assert.ok(applied.error);
  assert.deepStrictEqual(fs.readFileSync(filePath), before);
});

test("acknowledge only marks the matching id and reports unknown ids", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "web", { operation: "install", status: "ok", restartRequired: true, bundleHash: "h" });
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "one" } });
  const notices = await noticesFor(root, "web");
  const failure = notices.find((n) => n.kind === "failed-target");
  const restart = notices.find((n) => n.kind === "restart-required");
  const missing = await acknowledgeDshNotice(root, "web", "no-such-id");
  assert.strictEqual(missing.found, false);
  const found = await acknowledgeDshNotice(root, "web", restart.id);
  assert.strictEqual(found.found, true);
  const after = await noticesFor(root, "web");
  assert.strictEqual(after.find((n) => n.id === restart.id).acknowledged, true);
  assert.strictEqual(after.find((n) => n.id === failure.id).acknowledged, false);
});

test("clearDshNotices empties a profile and tolerates a missing file", async (t) => {
  const root = makeRoot(t);
  await clearDshNotices(root, "web");
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "x" } });
  const cleared = await clearDshNotices(root, "web");
  assert.strictEqual(cleared.error, null);
  assert.deepStrictEqual(await noticesFor(root, "web"), []);
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

test("restart-required survives a weaker update and a failure; a new generation replaces it", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "desktop", { operation: "install", status: "ok", restartRequired: true, bundleHash: "h1" });
  // `updated: false` re-verifies and a failure must not clear or weaken it.
  await applyDshNoticeOutcome(root, "desktop", { operation: "install", status: "ok", restartRequired: false, bundleHash: "h1" });
  await applyDshNoticeOutcome(root, "desktop", { operation: "install", failure: { reason: "boom" } });
  let notices = await noticesFor(root, "desktop");
  const restart = notices.find((n) => n.kind === "restart-required");
  assert.ok(restart);
  assert.strictEqual(restart.bundleHash, "h1");
  // A repeat of the same generation keeps the id, createdAt and acknowledgement.
  await acknowledgeDshNotice(root, "desktop", restart.id);
  await applyDshNoticeOutcome(root, "desktop", { operation: "install", status: "ok", restartRequired: true, bundleHash: "h1" });
  notices = await noticesFor(root, "desktop");
  assert.strictEqual(notices.filter((n) => n.kind === "restart-required").length, 1);
  assert.strictEqual(notices.find((n) => n.kind === "restart-required").acknowledged, true);
  // A new generation replaces the old one; only one restart notice at a time.
  await applyDshNoticeOutcome(root, "desktop", { operation: "install", status: "ok", restartRequired: true, bundleHash: "h2" });
  notices = await noticesFor(root, "desktop");
  const restarts = notices.filter((n) => n.kind === "restart-required");
  assert.strictEqual(restarts.length, 1);
  assert.strictEqual(restarts[0].bundleHash, "h2");
  assert.strictEqual(restarts[0].acknowledged, false);
});

test("a failure with a different reason replaces the old one with a new id", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "one" } });
  const first = (await noticesFor(root, "web")).find((n) => n.kind === "failed-target");
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "two" } });
  const failures = (await noticesFor(root, "web")).filter((n) => n.kind === "failed-target");
  assert.strictEqual(failures.length, 1);
  assert.strictEqual(failures[0].payload.reason, "two");
  assert.strictEqual(failures[0].payload.operation, "install");
  assert.notStrictEqual(failures[0].id, first.id);
});

test("the same failure is refreshed and a later failure gets a new id after a success", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "web", { operation: "startup-sync", failure: { reason: "plugin-disabled-in-dsh", message: "m1" } });
  await applyDshNoticeOutcome(root, "web", { operation: "startup-sync", failure: { reason: "plugin-disabled-in-dsh", message: "m2" } });
  let notices = await noticesFor(root, "web");
  assert.strictEqual(notices.filter((n) => n.kind === "failed-target").length, 1);
  const first = notices.find((n) => n.kind === "failed-target");
  assert.strictEqual(first.payload.message, "m2");
  assert.strictEqual(first.payload.operation, "install");
  await acknowledgeDshNotice(root, "web", first.id);
  await applyDshNoticeOutcome(root, "web", { operation: "startup-sync", failure: { reason: "plugin-disabled-in-dsh", message: "m3" } });
  notices = await noticesFor(root, "web");
  assert.strictEqual(notices[0].acknowledged, true);

  // Success clears the failure; the next same failure is a brand new id.
  await applyDshNoticeOutcome(root, "web", { operation: "install", status: "ok" });
  assert.deepStrictEqual(await noticesFor(root, "web"), []);
  await applyDshNoticeOutcome(root, "web", { operation: "startup-sync", failure: { reason: "plugin-disabled-in-dsh", message: "again" } });
  notices = await noticesFor(root, "web");
  assert.strictEqual(notices.length, 1);
  assert.match(notices[0].id, /failed-target:plugin-disabled-in-dsh:2$/);
  assert.strictEqual(readJson(noticesPath(root, "web")).failedSequence, 2);
});

test("failures of different categories keep separate ids despite the same reason", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "cli-unavailable" } });
  const installed = (await noticesFor(root, "web")).find((n) => n.kind === "failed-target");
  assert.strictEqual(installed.payload.operation, "install");
  await applyDshNoticeOutcome(root, "web", { operation: "uninstall", failure: { reason: "cli-unavailable" } });
  const uninstalled = (await noticesFor(root, "web")).find((n) => n.kind === "failed-target");
  assert.strictEqual(uninstalled.payload.operation, "uninstall");
  assert.notStrictEqual(uninstalled.id, installed.id);
});

test("a manual command is keyed by content and removed on a web success", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "web", { operation: "install", status: "error", manualCommands: ["old"], manualBundleHash: "g1" });
  let manuals = (await noticesFor(root, "web")).filter((n) => n.kind === "manual-command");
  assert.strictEqual(manuals.length, 1);
  const firstId = manuals[0].id;
  await acknowledgeDshNotice(root, "web", firstId);
  // Same command content: same id, acknowledgement kept.
  await applyDshNoticeOutcome(root, "web", { operation: "install", status: "error", manualCommands: ["old"], manualBundleHash: "g1" });
  manuals = (await noticesFor(root, "web")).filter((n) => n.kind === "manual-command");
  assert.strictEqual(manuals.length, 1);
  assert.strictEqual(manuals[0].id, firstId);
  assert.strictEqual(manuals[0].acknowledged, true);
  // Different content: replaced by a fresh, unacknowledged record.
  await applyDshNoticeOutcome(root, "web", { operation: "install", status: "error", manualCommands: ["a", "b"], manualBundleHash: "g2" });
  manuals = (await noticesFor(root, "web")).filter((n) => n.kind === "manual-command");
  assert.strictEqual(manuals.length, 1);
  assert.deepStrictEqual(manuals[0].payload.commands, ["a", "b"]);
  assert.notStrictEqual(manuals[0].id, firstId);
  assert.strictEqual(manuals[0].acknowledged, false);
  // A web success clears it.
  await applyDshNoticeOutcome(root, "web", { operation: "install", status: "ok" });
  manuals = (await noticesFor(root, "web")).filter((n) => n.kind === "manual-command");
  assert.strictEqual(manuals.length, 0);
});

test("uninstall clears the confirmed side and keeps a failed side", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "cli-unavailable" } });
  assert.strictEqual((await noticesFor(root, "web")).length, 1);
  await applyDshNoticeOutcome(root, "web", { operation: "uninstall", removedOk: true });
  assert.deepStrictEqual(await noticesFor(root, "web"), []);
  await applyDshNoticeOutcome(root, "desktop", { operation: "uninstall", failure: { reason: "carrier-unavailable" } });
  const desktop = await noticesFor(root, "desktop");
  const failed = desktop.find((n) => n.kind === "failed-target");
  assert.strictEqual(failed.payload.operation, "uninstall");
});

test("an uninstall that drops an install-side manual command records the remove command", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "web", { operation: "install", status: "error", manualCommands: ["add generation"], manualBundleHash: "g1" });
  await applyDshNoticeOutcome(root, "web", {
    operation: "uninstall",
    failure: { reason: "cli-unavailable" },
    manualCommands: ["remove bridge"],
    manualBundleHash: "g1",
  });
  const manuals = (await noticesFor(root, "web")).filter((n) => n.kind === "manual-command");
  assert.strictEqual(manuals.length, 1);
  assert.deepStrictEqual(manuals[0].payload.commands, ["remove bridge"]);
  const failed = (await noticesFor(root, "web")).find((n) => n.kind === "failed-target");
  assert.strictEqual(failed.payload.operation, "uninstall");
});

test("an uninstall failure without a manual command still drops the old add command", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "web", { operation: "install", status: "error", manualCommands: ["add generation"], manualBundleHash: "g1" });
  await applyDshNoticeOutcome(root, "web", { operation: "uninstall", failure: { reason: "ownership-not-proven" } });
  assert.strictEqual((await noticesFor(root, "web")).some((n) => n.kind === "manual-command"), false);
});

test("a never-installed side is cleared when its uninstall is skipped", async (t) => {
  const harness = makeHarness(t);
  await applyDshNoticeOutcome(harness.managedRoot, "web", { operation: "install", failure: { reason: "plugin-add-failed" } });
  assert.strictEqual((await noticesFor(harness.managedRoot, "web")).length, 1);
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, makeCli(harness)));
  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.reason, "bridge-not-installed");
  assert.deepStrictEqual(await noticesFor(harness.managedRoot, "web"), []);
});

test("a not-applicable install clears a stale failed-target", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "desktop", { operation: "install", failure: { reason: "carrier-unavailable" } });
  await applyDshNoticeOutcome(root, "desktop", { operation: "install", notApplicable: true });
  assert.deepStrictEqual(await noticesFor(root, "desktop"), []);
});

test("a not-applicable uninstall clears the whole profile", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "desktop", { operation: "install", failure: { reason: "carrier-unavailable" } });
  await applyDshNoticeOutcome(root, "desktop", { operation: "install", status: "ok", restartRequired: true, bundleHash: "h" });
  await applyDshNoticeOutcome(root, "desktop", { operation: "uninstall", notApplicable: true });
  assert.deepStrictEqual(await noticesFor(root, "desktop"), []);
});

test("clearing keeps the failed sequence so ids are never reused", async (t) => {
  const root = makeRoot(t);
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "one" } });
  await clearDshNotices(root, "web");
  assert.strictEqual(readJson(noticesPath(root, "web")).failedSequence, 1);
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "two" } });
  const next = (await noticesFor(root, "web")).find((n) => n.kind === "failed-target");
  assert.match(next.id, /failed-target:two:2$/);
  // An uninstall-confirmed clear keeps the sequence too.
  await applyDshNoticeOutcome(root, "desktop", { operation: "install", failure: { reason: "one" } });
  await applyDshNoticeOutcome(root, "desktop", { operation: "uninstall", removedOk: true });
  assert.strictEqual(readJson(noticesPath(root, "desktop")).failedSequence, 1);
});

test("nothing is written when the content did not change", async (t) => {
  const root = makeRoot(t);
  const writes = [];
  const deps = {
    writeFile: async (target, data, opts) => { writes.push(target); return fsp.writeFile(target, data, opts); },
  };
  // A profile with nothing to say does not get a file.
  await applyDshNoticeOutcome(root, "desktop", { operation: "startup-sync", status: "ok" }, deps);
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(fs.existsSync(noticesPath(root, "desktop")), false);
  // A repeated identical outcome does not rewrite the file.
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "one" } });
  const before = fs.readFileSync(noticesPath(root, "web"));
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "one" } }, deps);
  assert.strictEqual(writes.length, 0);
  assert.deepStrictEqual(fs.readFileSync(noticesPath(root, "web")), before);
});

// ---------------------------------------------------------------------------
// Orchestrator integration
// ---------------------------------------------------------------------------

test("an install writes a first-install notice for desktop and the uninstall clears it", async (t) => {
  const harness = makeHarness(t);
  writeProfile(harness, "desktop");
  await installDeepSeekHarnessBridge(desktopOptions(harness, makeCli(harness)));
  const state = await readDeepSeekHarnessNotices({ dshHome: harness.dshHome, managedRoot: harness.managedRoot, desktopDiscovery: desktopFound(harness) });
  assert.ok(state.desktop.some((n) => n.kind === "first-install"));
  await uninstallDeepSeekHarnessBridge(desktopOptions(harness, makeCli(harness)));
  const after = await readDeepSeekHarnessNotices({ dshHome: harness.dshHome, managedRoot: harness.managedRoot, desktopDiscovery: desktopFound(harness) });
  assert.deepStrictEqual(after.desktop, []);
});

test("startup sync records a disabled plugin as a failed-target notice", async (t) => {
  const harness = makeHarness(t);
  const profileDir = path.join(harness.dshHome, "profiles", "web");
  // Dependency present but no bundle row: DSH disabled.
  const bundleHash = require("../hooks/dsh-install").__test.hashBridgeDirectorySync(fs, SOURCE_DIR, {
    supportedDshRange: FAMILY.range,
  });
  const generationDir = path.join(harness.managedRoot, "generations", bundleHash);
  fs.mkdirSync(generationDir, { recursive: true });
  fs.cpSync(SOURCE_DIR, generationDir, { recursive: true });
  writeJson(path.join(generationDir, "clawd-manifest.json"), {
    owner: "clawd-on-desk",
    schemaVersion: 1,
    protocolVersion: 1,
    packageName: BRIDGE_PACKAGE_NAME,
    bundleHash,
    sourceClawdVersion: "1.2.3",
    supportedDshRange: FAMILY.range,
    installedDshVersion: FAMILY_VERSION,
  });
  writeJson(path.join(profileDir, "package.json"), {
    name: "dsh-profile-web",
    private: true,
    dependencies: { [BRIDGE_PACKAGE_NAME]: `file:${generationDir}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  });
  await installDeepSeekHarnessBridge(orchOptions(harness, makeCli(harness), { operation: "startup-sync" }));
  const state = await readDeepSeekHarnessNotices({ dshHome: harness.dshHome, managedRoot: harness.managedRoot });
  const failed = state.web.find((n) => n.kind === "failed-target");
  assert.ok(failed);
  assert.strictEqual(failed.payload.reason, "plugin-disabled-in-dsh");
});

test("a healthy web manual fallback clears the failed notices", async (t) => {
  const harness = makeHarness(t);
  writeProfile(harness, "web");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  // A stale failure from an earlier attempt; the fallback success must clear it.
  await applyDshNoticeOutcome(harness.managedRoot, "web", { operation: "install", failure: { reason: "cli-unavailable" } });
  assert.strictEqual((await noticesFor(harness.managedRoot, "web")).length, 1);

  const noCli = { commandInfo: null, dshCommand: false, env: { PATH: "" } };
  const verified = await installDeepSeekHarnessBridge(orchOptions(harness, cli, noCli));
  assert.strictEqual(verified.status, "ok");
  assert.strictEqual(verified.targets.web.role, "diagnose");
  assert.strictEqual(verified.targets.web.result.status, "ok");
  assert.deepStrictEqual(await noticesFor(harness.managedRoot, "web"), []);
});

test("a confirmed manual web removal clears the side's notices without a CLI", async (t) => {
  const harness = makeHarness(t);
  writeProfile(harness, "web");
  // Upstream `dsh plugin add` resolves the dependency as a link; its remove
  // leaves that link behind, which is the residue the uninstall has to clean.
  const linkedCli = {
    runDshCommand: async (args) => {
      const profile = args[args.indexOf("--profile") + 1];
      const manifestPath = path.join(harness.dshHome, "profiles", profile, "package.json");
      const manifest = readJson(manifestPath);
      if (args[3] !== "add") return { code: 1, stderr: "unexpected" };
      manifest.dependencies[BRIDGE_PACKAGE_NAME] = `link:${args[4]}`;
      if (!manifest.dsh.profile.bundles.includes(BRIDGE_PACKAGE_NAME)) {
        manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
      }
      writeJson(manifestPath, manifest);
      const target = packageDir(harness.dshHome, profile);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      symlinkDir(args[4], target);
      return { code: 0 };
    },
  };
  await installDeepSeekHarnessBridge(orchOptions(harness, linkedCli));
  await applyDshNoticeOutcome(harness.managedRoot, "web", { operation: "install", failure: { reason: "cli-unavailable" } });
  assert.strictEqual((await noticesFor(harness.managedRoot, "web")).length, 1);

  // The user runs the manual remove: dependency and bundle row go, link stays.
  const manifestPath = path.join(harness.dshHome, "profiles", "web", "package.json");
  const manifest = readJson(manifestPath);
  delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => n !== BRIDGE_PACKAGE_NAME);
  writeJson(manifestPath, manifest);

  const noCli = { commandInfo: null, dshCommand: false, env: { PATH: "" } };
  const removed = await uninstallDeepSeekHarnessBridge(orchOptions(harness, linkedCli, noCli));
  assert.strictEqual(removed.status, "ok");
  assert.strictEqual(removed.registrationRemoved, true);
  assert.strictEqual(removed.targets.web.result.registrationAfter, "removed");
  assert.deepStrictEqual(await noticesFor(harness.managedRoot, "web"), []);
});

test("a CLI-less repair records the failure and the manual command together", async (t) => {
  const harness = makeHarness(t);
  writeProfile(harness, "web");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  // A changed source forces a repair; with no CLI it stages a manual add.
  const noCli = { commandInfo: null, dshCommand: false, env: { PATH: "" }, sourceDir: updatedSource(harness, "updated") };
  const repair = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { ...noCli, operation: "explicit-repair" }));
  assert.strictEqual(repair.status, "error");
  assert.strictEqual(repair.reason, "cli-unavailable");
  assert.ok(repair.manualCommand);

  let state = await readDeepSeekHarnessNotices({ dshHome: harness.dshHome, managedRoot: harness.managedRoot });
  const failed = state.web.find((n) => n.kind === "failed-target");
  const manual = state.web.find((n) => n.kind === "manual-command");
  assert.ok(failed, "the failure is recorded");
  assert.ok(manual, "the manual command is recorded");
  assert.deepStrictEqual(manual.payload.commands, repair.manualCommand.split("\n"));
  assert.strictEqual(failed.payload.operation, "install");
  const failedId = failed.id;
  const manualId = manual.id;

  // Re-running the same repair keeps both ids; an acknowledgement sticks.
  await acknowledgeDshNotice(harness.managedRoot, "web", manualId);
  const again = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { ...noCli, operation: "explicit-repair" }));
  assert.strictEqual(again.reason, "cli-unavailable");
  state = await readDeepSeekHarnessNotices({ dshHome: harness.dshHome, managedRoot: harness.managedRoot });
  assert.strictEqual(state.web.find((n) => n.kind === "manual-command").id, manualId);
  assert.strictEqual(state.web.find((n) => n.kind === "manual-command").acknowledged, true);
  assert.strictEqual(state.web.find((n) => n.kind === "failed-target").id, failedId);

  // A CLI-less uninstall swaps in the remove command and an uninstall failure.
  const removed = await uninstallDeepSeekHarnessBridge(orchOptions(harness, cli, {
    commandInfo: null, dshCommand: false, env: { PATH: "" },
  }));
  assert.strictEqual(removed.reason, "cli-unavailable");
  assert.match(removed.manualCommand, /'remove'/);
  state = await readDeepSeekHarnessNotices({ dshHome: harness.dshHome, managedRoot: harness.managedRoot });
  const manualAfter = state.web.find((n) => n.kind === "manual-command");
  const failedAfter = state.web.find((n) => n.kind === "failed-target");
  assert.ok(manualAfter.payload.commands.every((line) => line.includes("remove")));
  assert.strictEqual(failedAfter.payload.operation, "uninstall");
  assert.notStrictEqual(failedAfter.id, failedId);
  assert.strictEqual(failedAfter.acknowledged, false);
});

test("an add failure that discards its generation reports no manual command", async (t) => {
  const harness = makeHarness(t);
  writeProfile(harness, "web");
  let addCalls = 0;
  const failAdd = {
    runDshCommand: async (args) => {
      if (args[3] === "add") { addCalls += 1; return { code: 1, stderr: "add failed" }; }
      return { code: 1, stderr: "unexpected" };
    },
  };
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, failAdd));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "plugin-add-failed");
  assert.strictEqual(addCalls, 1);
  assert.strictEqual(result.manualCommand, undefined);
  // The freshly staged generation was discarded, so nothing remains.
  const generations = path.join(harness.managedRoot, "generations");
  const entries = fs.existsSync(generations) ? fs.readdirSync(generations) : [];
  assert.deepStrictEqual(entries, []);
  const notices = await noticesFor(harness.managedRoot, "web");
  assert.ok(notices.some((n) => n.kind === "failed-target"));
  assert.strictEqual(notices.some((n) => n.kind === "manual-command"), false);
});

test("a notice write failure only adds a warning", async (t) => {
  const harness = makeHarness(t);
  writeJson(noticesPath(harness.managedRoot, "web"), { owner: "someone-else", schemaVersion: 1, notices: [] });
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, makeCli(harness)));
  assert.strictEqual(result.status, "ok");
  assert.ok(result.warnings.some((line) => line.includes("notice write skipped")));
});

test("acknowledge waits for an in-flight operation instead of racing it", async (t) => {
  const harness = makeHarness(t);
  const root = harness.managedRoot;
  writeProfile(harness, "web");
  await applyDshNoticeOutcome(root, "web", { operation: "install", failure: { reason: "plugin-add-failed", message: "seed" } });
  const seeded = (await noticesFor(root, "web")).find((n) => n.kind === "failed-target");

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const blocking = {
    runDshCommand: async (args) => {
      if (args[3] === "add") { markStarted(); await gate; return { code: 1, stderr: "add failed" }; }
      return { code: 1, stderr: "unexpected" };
    },
  };
  const install = installDeepSeekHarnessBridge(orchOptions(harness, blocking));
  await started;

  let ackFinished = false;
  const ack = acknowledgeDeepSeekHarnessNotice(
    { dshHome: harness.dshHome, managedRoot: root },
    { profile: "web", id: seeded.id }
  ).then((value) => { ackFinished = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.strictEqual(ackFinished, false, "the acknowledgement must wait for the operation");

  release();
  await install;
  const result = await ack;
  assert.strictEqual(result.found, true);
  const after = (await noticesFor(root, "web")).find((n) => n.id === seeded.id);
  assert.strictEqual(after.acknowledged, true);
});

test("both profiles install, change generation, and clear on uninstall", async (t) => {
  const harness = makeHarness(t);
  writeProfile(harness, "web");
  writeProfile(harness, "desktop");
  const cli = makeCli(harness);
  const both = { desktopDiscovery: desktopFound(harness) };

  await installDeepSeekHarnessBridge(orchOptions(harness, cli, both));

  // A new source replaces the previous generation on both profiles.
  await installDeepSeekHarnessBridge(orchOptions(harness, cli, { ...both, sourceDir: updatedSource(harness, "updated") }));
  let state = await readDeepSeekHarnessNotices({ dshHome: harness.dshHome, managedRoot: harness.managedRoot, desktopDiscovery: desktopFound(harness) });
  const restarts = state.desktop.filter((n) => n.kind === "restart-required");
  assert.strictEqual(restarts.length, 1);
  assert.strictEqual(state.web.some((n) => n.kind === "manual-command"), false);

  await uninstallDeepSeekHarnessBridge(orchOptions(harness, cli, both));
  state = await readDeepSeekHarnessNotices({ dshHome: harness.dshHome, managedRoot: harness.managedRoot, desktopDiscovery: desktopFound(harness) });
  assert.deepStrictEqual(state.web, []);
  assert.deepStrictEqual(state.desktop, []);
});

test("readDeepSeekHarnessNotices returns both profiles", async (t) => {
  const harness = makeHarness(t);
  const state = await readDeepSeekHarnessNotices({ dshHome: harness.dshHome, managedRoot: harness.managedRoot });
  assert.deepStrictEqual(state.web, []);
  assert.deepStrictEqual(state.desktop, []);
});
