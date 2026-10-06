"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { checkAgentIntegrations } = require("../src/doctor-detectors/agent-integrations");
const {
  BRIDGE_PACKAGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  MANAGED_OWNER,
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSION,
  refreshDshDesktopDiscovery,
  __test: dshInstallTest,
} = require("../hooks/dsh-install");

const DSH_BRIDGE_SOURCE_DIR = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");

const NO_DESKTOP = Object.freeze({
  status: "not-found",
  appRoot: null,
  launcherPath: null,
  staticVersion: null,
  checkedPaths: [],
  reason: null,
});

function desktopFound(staticVersion = SUPPORTED_DSH_VERSION) {
  return {
    status: "found",
    appRoot: "/fake/DeepSeek Harness.app",
    launcherPath: "/fake/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
    staticVersion,
    checkedPaths: [],
    reason: null,
  };
}

function makeHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-doctor-"));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    homeDir: path.join(root, "home"),
    dshHome: path.join(root, "home", ".dsh"),
    managedRoot: path.join(root, "managed"),
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

// Real POSIX reads, plus a fake Windows filesystem for the registry roots so a
// win32 snapshot can be verified on a non-Windows host.
function hybridFs(winFiles) {
  const map = new Map();
  for (const [key, value] of Object.entries(winFiles)) {
    map.set(path.win32.resolve(key).toLowerCase(), value);
  }
  return {
    readFileSync(filePath, ...args) {
      const key = path.win32.resolve(String(filePath)).toLowerCase();
      if (map.has(key)) return map.get(key);
      return fs.readFileSync(filePath, ...args);
    },
    statSync(filePath, ...args) {
      const key = path.win32.resolve(String(filePath)).toLowerCase();
      if (map.has(key)) return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
      return fs.statSync(filePath, ...args);
    },
    readdirSync: fs.readdirSync.bind(fs),
    lstatSync: fs.lstatSync.bind(fs),
    cpSync: fs.cpSync.bind(fs),
  };
}

function dshDescriptor(harness) {
  const parentDir = harness.dshHome;
  return {
    agentId: "deepseek-harness",
    agentName: "DeepSeek Harness",
    eventSource: "plugin-event",
    parentDir,
    configPath: path.join(parentDir, "profiles", "web"),
    configMode: "dsh-plugin",
    autoInstall: true,
    dshManagedRoot: harness.managedRoot,
  };
}

// mode: "healthy" | "absent" | "foreign" | "missing" (no file at all)
function writeDshProfile(harness, profile, mode) {
  const profileDir = path.join(harness.dshHome, "profiles", profile);
  const manifestPath = path.join(profileDir, "package.json");
  if (mode === "missing") {
    fs.rmSync(manifestPath, { force: true });
    return;
  }
  const manifest = {
    name: `dsh-profile-${profile}`,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  };
  const pluginDir = path.join(profileDir, "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
  const bundleHash = dshInstallTest.hashBridgeDirectorySync(fs, DSH_BRIDGE_SOURCE_DIR);
  const generationDir = path.join(harness.managedRoot, "generations", bundleHash);
  if (mode !== "absent") {
    manifest.dependencies[BRIDGE_PACKAGE_NAME] = mode === "healthy" ? `file:${generationDir}` : `file:${pluginDir}`;
    manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
  }
  writeJson(manifestPath, manifest);
  if (mode === "healthy") {
    fs.cpSync(DSH_BRIDGE_SOURCE_DIR, pluginDir, { recursive: true });
    fs.cpSync(DSH_BRIDGE_SOURCE_DIR, generationDir, { recursive: true });
    const marker = {
      owner: MANAGED_OWNER,
      schemaVersion: 1,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      bundleHash,
      supportedDshRange: SUPPORTED_DSH_RANGE,
      installedDshVersion: SUPPORTED_DSH_VERSION,
    };
    writeJson(path.join(pluginDir, "clawd-manifest.json"), marker);
    writeJson(path.join(generationDir, "clawd-manifest.json"), marker);
  } else if (mode === "foreign") {
    writeJson(path.join(pluginDir, "package.json"), { name: BRIDGE_PACKAGE_NAME, version: "0.0.0" });
  }
}

function runDsh(harness, options = {}) {
  const hasDesktopInjection = Object.prototype.hasOwnProperty.call(options, "dshDesktopDiscovery");
  return checkAgentIntegrations({
    fs: options.fs || fs,
    platform: options.platform || process.platform,
    env: options.env || {},
    homeDir: harness.homeDir,
    prefs: { agents: { "deepseek-harness": { integrationInstalled: true, enabled: true } } },
    descriptors: [dshDescriptor(harness)],
    dshInstallRoot: null,
    dshManagedRoot: harness.managedRoot,
    dshDesktopDiscovery: hasDesktopInjection ? options.dshDesktopDiscovery : NO_DESKTOP,
    windowsRegistrySnapshot: options.windowsRegistrySnapshot,
  }).details[0];
}

test("both sides healthy shows ok with no fix and both details", (t) => {
  const harness = makeHarness(t);
  writeDshProfile(harness, "web", "healthy");
  writeDshProfile(harness, "desktop", "healthy");
  const detail = runDsh(harness, { dshDesktopDiscovery: desktopFound() });
  assert.strictEqual(detail.status, "ok");
  assert.strictEqual(detail.fixAction, undefined);
  assert.match(detail.detail, /^web: /);
  assert.match(detail.detail, /desktop: managed bridge verified on disk/);
  assert.strictEqual(detail.bridgeHealth, "healthy");
  assert.ok(detail.pluginPath);
  assert.strictEqual(detail.dshTargets.web.status, "ok");
  assert.strictEqual(detail.dshTargets.desktop.status, "ok");
});

test("web healthy and desktop present but unregistered shows not-connected with a fix", (t) => {
  const harness = makeHarness(t);
  writeDshProfile(harness, "web", "healthy");
  writeDshProfile(harness, "desktop", "absent");
  const detail = runDsh(harness, { dshDesktopDiscovery: desktopFound() });
  assert.strictEqual(detail.status, "not-connected");
  assert.strictEqual(detail.bridgeHealth, "absent");
  assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "deepseek-harness" });
  assert.strictEqual(detail.dshTargets.desktop.status, "not-connected");
});

test("a foreign desktop and a disconnected web keep the fix for the web side", (t) => {
  const harness = makeHarness(t);
  writeDshProfile(harness, "web", "absent");
  writeDshProfile(harness, "desktop", "foreign");
  const detail = runDsh(harness, { dshDesktopDiscovery: desktopFound() });
  assert.strictEqual(detail.status, "needs-review");
  assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "deepseek-harness" });
  assert.strictEqual(detail.dshTargets.desktop.status, "needs-review");
  assert.strictEqual(detail.dshTargets.web.status, "not-connected");
});

test("a foreign desktop and a healthy web show needs-review without a fix", (t) => {
  const harness = makeHarness(t);
  writeDshProfile(harness, "web", "healthy");
  writeDshProfile(harness, "desktop", "foreign");
  const detail = runDsh(harness, { dshDesktopDiscovery: desktopFound() });
  assert.strictEqual(detail.status, "needs-review");
  assert.strictEqual(detail.fixAction, undefined);
  assert.strictEqual(detail.bridgeHealth, "profile-entry-foreign-or-conflicting");
});

test("web resolved by the manual fallback is shown from disk and repairable", (t) => {
  const harness = makeHarness(t);
  writeDshProfile(harness, "web", "healthy");
  const ok = runDsh(harness);
  assert.strictEqual(ok.status, "ok");
  assert.strictEqual(ok.dshTargets.web.role, "diagnose");
  assert.strictEqual(ok.dshTargets.web.status, "ok");

  const harness2 = makeHarness(t);
  writeDshProfile(harness2, "web", "absent");
  const absent = runDsh(harness2);
  assert.strictEqual(absent.status, "not-connected");
  assert.deepStrictEqual(absent.fixAction, { type: "agent-integration", agentId: "deepseek-harness" });
});

test("an uninitialized desktop is not counted and hints at opening the app", (t) => {
  const harness = makeHarness(t);
  writeDshProfile(harness, "web", "absent");
  writeDshProfile(harness, "desktop", "missing");
  const detail = runDsh(harness, { dshDesktopDiscovery: desktopFound() });
  assert.strictEqual(detail.dshTargets.desktop.status, null);
  assert.strictEqual(detail.dshTargets.desktop.reason, "desktop-profile-uninitialized");
  assert.match(detail.detail, /desktop: open the DeepSeek Harness desktop app once to initialize its profile/);
  assert.strictEqual(detail.status, "not-connected");
});

test("a missing desktop app with a surviving registration shows needs-review", (t) => {
  const harness = makeHarness(t);
  writeDshProfile(harness, "web", "absent");
  writeDshProfile(harness, "desktop", "healthy");
  const detail = runDsh(harness);
  assert.strictEqual(detail.status, "needs-review");
  assert.strictEqual(detail.dshTargets.desktop.reason, "carrier-unavailable");
  assert.match(detail.detail, /desktop: The DeepSeek Harness desktop app was not found/);
});

test("neither side applicable still reports not-connected without a fix", (t) => {
  const harness = makeHarness(t);
  const detail = runDsh(harness);
  assert.strictEqual(detail.status, "not-connected");
  assert.strictEqual(detail.level, "warning");
  assert.strictEqual(detail.fixAction, undefined);
  assert.match(detail.detail, /web: not used/);
  assert.match(detail.detail, /desktop: desktop app not installed/);
  assert.strictEqual(detail.dshTargets.web.status, null);
  assert.strictEqual(detail.dshTargets.desktop.status, null);
});

test("concurrent Windows registry reads for the same key share one PowerShell", async (t) => {
  dshInstallTest.resetWindowsRegistryCache();
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { code: 0, stdout: JSON.stringify({ uninstall: [], commandDirectory: null }) };
  };
  const env = { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\single\\AppData\\Local" };

  const [a, b] = await Promise.all([
    refreshDshDesktopDiscovery({ platform: "win32", env, runCommand }),
    refreshDshDesktopDiscovery({ platform: "win32", env, runCommand }),
  ]);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(a, b);

  const env2 = { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\other\\AppData\\Local" };
  await refreshDshDesktopDiscovery({ platform: "win32", env: env2, runCommand });
  assert.strictEqual(calls, 2);

  // Injected discovery is returned verbatim and never runs the registry read.
  let injectedCalls = 0;
  const injected = desktopFound();
  const direct = await refreshDshDesktopDiscovery({
    platform: "win32",
    env,
    desktopDiscovery: injected,
    runCommand: async () => { injectedCalls += 1; return { code: 0, stdout: "{}" }; },
  });
  assert.deepStrictEqual(direct, injected);
  assert.strictEqual(injectedCalls, 0);
  dshInstallTest.resetWindowsRegistryCache();
});

test("a Windows pending snapshot reports needs-review until a snapshot is present", (t) => {
  const harness = makeHarness(t);
  writeDshProfile(harness, "web", "absent");
  writeDshProfile(harness, "desktop", "absent");
  const pending = runDsh(harness, { platform: "win32", dshDesktopDiscovery: undefined });
  assert.strictEqual(pending.dshTargets.desktop.reason, "desktop-unverifiable");
  assert.strictEqual(pending.status, "needs-review");

  // A verified registry root upgrades the same state from "cannot verify" to
  // the real desktop status.
  const appRoot = "C:\\Tools\\DeepSeek Harness";
  const winFiles = {
    [path.win32.join(appRoot, "DeepSeek Harness.exe")]: "exe",
    [path.win32.join(appRoot, "resources", "runtime", "cli", "bin", "dsh.cmd")]: "cmd",
    [path.win32.join(appRoot, "resources", "app.asar")]: "asar",
  };
  const snapshot = {
    uninstall: [{ installLocation: appRoot, displayVersion: SUPPORTED_DSH_VERSION }],
  };
  const warmed = runDsh(harness, {
    platform: "win32",
    fs: hybridFs(winFiles),
    dshDesktopDiscovery: undefined,
    windowsRegistrySnapshot: snapshot,
    env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
  });
  assert.strictEqual(warmed.dshTargets.desktop.role, "mutable");
  assert.strictEqual(warmed.dshTargets.desktop.status, "not-connected");
});
