"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BRIDGE_PACKAGE_NAME,
  DSH_VERSION_FAMILIES,
  DESKTOP_PROFILE_NAME,
  WEB_PROFILE_NAME,
  discoverDshDesktopSync,
  inspectDeepSeekHarnessDiskSync,
  inspectDeepSeekHarnessIntegration,
  inspectDshTargetsSync,
  resolveDshProfileDir,
} = require("../hooks/dsh-install");
const { __test: dshInstallTest } = require("../hooks/dsh-install");
const { symlinkDir } = require("./dsh-desktop-fixtures");

const SOURCE_DIR = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");
const FAMILY = DSH_VERSION_FAMILIES[0];
const FAMILY_RANGE = FAMILY.range;
const FAMILY_VERSION = FAMILY.minVersion;
const DESKTOP_LAUNCHER_RELATIVE = path.join("Contents", "Resources", "runtime", "cli", "bin", "dsh");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-targets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dshHome: path.join(root, ".dsh"),
    managedRoot: path.join(root, "managed"),
  };
}

function writeProfileManifest(dshHome, profile, manifest) {
  const profileDir = path.join(dshHome, "profiles", profile);
  fs.mkdirSync(profileDir, { recursive: true });
  writeJson(path.join(profileDir, "package.json"), manifest || {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  });
  return profileDir;
}

function bridgePackageDir(profileDir) {
  return path.join(profileDir, "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
}

function writeMarker(dir, { bundleHash, range = FAMILY_RANGE, version = FAMILY_VERSION }) {
  writeJson(path.join(dir, "clawd-manifest.json"), {
    owner: "clawd-on-desk",
    schemaVersion: 1,
    protocolVersion: 1,
    packageName: BRIDGE_PACKAGE_NAME,
    bundleHash,
    sourceClawdVersion: "1.2.3",
    supportedDshRange: range,
    installedDshVersion: version,
    installedDshVersionAssumedAtStaging: false,
    sourceAuditBaselineCommit: "47f943859bef60e4160492346772ded9b24f765a",
    installedAt: "2026-01-01T00:00:00.000Z",
  });
}

function installedBundleHash(range = FAMILY_RANGE) {
  return dshInstallTest.hashBridgeDirectorySync(fs, SOURCE_DIR, { supportedDshRange: range });
}

// A fully healthy profile: managed generation plus profile-local copy and the
// dependency/bundle entry pointing at it.
function writeHealthyProfile(env, profile) {
  const bundleHash = installedBundleHash();
  const generationDir = path.join(env.managedRoot, "generations", bundleHash);
  if (!fs.existsSync(path.join(generationDir, "clawd-manifest.json"))) {
    fs.mkdirSync(generationDir, { recursive: true });
    fs.cpSync(SOURCE_DIR, generationDir, { recursive: true });
    writeMarker(generationDir, { bundleHash });
  }
  const profileDir = writeProfileManifest(env.dshHome, profile, {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: { [BRIDGE_PACKAGE_NAME]: `file:${generationDir}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", BRIDGE_PACKAGE_NAME] } },
  });
  const local = bridgePackageDir(profileDir);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.cpSync(generationDir, local, { recursive: true });
  return { generationDir, bundleHash, profileDir };
}

function writeHealthyWebProfile(env) {
  return writeHealthyProfile(env, WEB_PROFILE_NAME);
}

function writeForeignProfile(env, profile) {
  const profileDir = writeProfileManifest(env.dshHome, profile, {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: { [BRIDGE_PACKAGE_NAME]: "^1.0.0" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", BRIDGE_PACKAGE_NAME] } },
  });
  const local = bridgePackageDir(profileDir);
  fs.mkdirSync(local, { recursive: true });
  writeJson(path.join(local, "package.json"), { name: BRIDGE_PACKAGE_NAME, version: "9.9.9" });
  return profileDir;
}

function writeDamagedProfile(env, profile) {
  const tamperDir = path.join(env.root, `tampered-${profile}`);
  fs.mkdirSync(tamperDir, { recursive: true });
  fs.cpSync(SOURCE_DIR, tamperDir, { recursive: true });
  writeMarker(tamperDir, { bundleHash: "f".repeat(64) });
  const profileDir = writeProfileManifest(env.dshHome, profile, {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: { [BRIDGE_PACKAGE_NAME]: `file:${tamperDir}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", BRIDGE_PACKAGE_NAME] } },
  });
  const local = bridgePackageDir(profileDir);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.cpSync(tamperDir, local, { recursive: true });
  return profileDir;
}

function writeLatch(env, profile, content) {
  const fileName = profile === DESKTOP_PROFILE_NAME
    ? "inspection-required-desktop.json"
    : "inspection-required.json";
  writeJson(path.join(env.managedRoot, fileName), content || {
    owner: "clawd-on-desk",
    schemaVersion: 1,
    reason: "aborted",
    detail: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return path.join(env.managedRoot, fileName);
}

function writeResidue(env, profile, name = "dsh-clawd-bridge.clawd-removing-test") {
  const linkDir = bridgePackageDir(path.join(env.dshHome, "profiles", profile));
  const residue = path.join(path.dirname(linkDir), name);
  fs.mkdirSync(residue, { recursive: true });
  return residue;
}

// Match the realpath flavor and case folding the code uses when it resolves a
// path: realpathSync.native, then lowercased on win32, so an injected fs can
// recognize the path the code will read.
function canonicalPathSync(value) {
  let cursor = path.resolve(String(value));
  const suffix = [];
  while (true) {
    try {
      const realpath = fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor);
      return comparablePath(path.join(realpath, ...suffix));
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return comparablePath(path.resolve(String(value)));
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function comparablePath(value) {
  if (process.platform !== "win32") return value;
  return value.replace(/^\\\\\?\\/, "").toLowerCase();
}

function fsFailingRead(targetPath) {
  const target = canonicalPathSync(targetPath);
  return {
    ...fs,
    readFileSync: (p, ...rest) => {
      if (canonicalPathSync(p) === target) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return fs.readFileSync(p, ...rest);
    },
  };
}

function fsFailingReaddir(targetPath) {
  const target = canonicalPathSync(targetPath);
  return {
    ...fs,
    readdirSync: (p, ...rest) => {
      if (canonicalPathSync(p) === target) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return fs.readdirSync(p, ...rest);
    },
  };
}

const NO_DESKTOP = Object.freeze({
  status: "not-found",
  appRoot: null,
  launcherPath: null,
  staticVersion: null,
  checkedPaths: [],
  reason: null,
});

function desktopFound(staticVersion = FAMILY_VERSION) {
  return {
    status: "found",
    appRoot: "/fake/DeepSeek Harness.app",
    launcherPath: "/fake/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
    staticVersion,
    checkedPaths: ["/fake/DeepSeek Harness.app"],
    reason: null,
  };
}

function targetOptions(env, overrides = {}) {
  return {
    dshHome: env.dshHome,
    managedRoot: env.managedRoot,
    sourceDir: SOURCE_DIR,
    env: { PATH: "" },
    desktopDiscovery: NO_DESKTOP,
    ...overrides,
  };
}

function inspectWeb(env, operation, overrides = {}) {
  return inspectDshTargetsSync(targetOptions(env, overrides), { operation }).web;
}

function inspectDesktop(env, operation, overrides = {}) {
  return inspectDshTargetsSync(targetOptions(env, overrides), { operation }).desktop;
}

function makeApp(root, name, options = {}) {
  const {
    bundleId = "com.deepseek.dsh",
    version = FAMILY_VERSION,
    xml = true,
    launcher = true,
  } = options;
  const appRoot = path.join(root, name);
  fs.mkdirSync(path.join(appRoot, "Contents"), { recursive: true });
  const plist = xml
    ? `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
      + `<plist version="1.0"><dict>\n`
      + `<key>CFBundleIdentifier</key><string>${bundleId}</string>\n`
      + `<key>CFBundleShortVersionString</key><string>${version}</string>\n`
      + `</dict></plist>\n`
    : "bplist00\u0000\u0001binary";
  fs.writeFileSync(path.join(appRoot, "Contents", "Info.plist"), plist, "utf8");
  if (launcher) {
    const launcherPath = path.join(appRoot, DESKTOP_LAUNCHER_RELATIVE);
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, "#!/bin/sh\n");
  }
  return appRoot;
}

// ---------------------------------------------------------------------------
// Profile isolation
// ---------------------------------------------------------------------------

test("a desktop inspection latch does not fence the web profile", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME);
  writeLatch(env, DESKTOP_PROFILE_NAME);
  const base = { dshHome: env.dshHome, managedRoot: env.managedRoot, dshInstallRoot: null };
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({ ...base, profile: WEB_PROFILE_NAME }).status, "absent");
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({ ...base, profile: DESKTOP_PROFILE_NAME }).status, "inspection-required");
});

test("a web inspection latch does not fence the desktop profile", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME);
  writeLatch(env, WEB_PROFILE_NAME);
  const base = { dshHome: env.dshHome, managedRoot: env.managedRoot, dshInstallRoot: null };
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({ ...base, profile: WEB_PROFILE_NAME }).status, "inspection-required");
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({ ...base, profile: DESKTOP_PROFILE_NAME }).status, "absent");
});

test("a removal residue only shows up on the profile that owns it", (t) => {
  const env = makeHome(t);
  writeResidue(env, DESKTOP_PROFILE_NAME);
  assert.strictEqual(inspectWeb(env, "doctor").evidence.residue, "none");
  assert.strictEqual(inspectDesktop(env, "doctor").evidence.residue, "present");
});

test("web residue does not leak into the desktop target", (t) => {
  const env = makeHome(t);
  writeResidue(env, WEB_PROFILE_NAME);
  assert.strictEqual(inspectWeb(env, "doctor").evidence.residue, "present");
  assert.strictEqual(inspectDesktop(env, "doctor").evidence.residue, "none");
});

test("desktop inspection never reads the npm dsh install root", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME, {
    name: "dsh-profile-desktop",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });
  const npmRoot = path.join(env.root, "npm-dsh");
  writeJson(path.join(npmRoot, "package.json"), { name: "@deepseek-ai/dsh", version: "0.9.0" });
  fs.mkdirSync(bridgePackageDir(npmRoot), { recursive: true });
  const health = inspectDeepSeekHarnessDiskSync({
    dshHome: env.dshHome,
    managedRoot: env.managedRoot,
    profile: DESKTOP_PROFILE_NAME,
    dshInstallRoot: npmRoot,
    hostVersion: null,
  });
  assert.strictEqual(health.installationResolved, null);
  assert.notStrictEqual(health.status, "host-version-unsupported");
});

test("a desktop hostVersion outside every family reports host-version-unsupported", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME);
  const base = { dshHome: env.dshHome, managedRoot: env.managedRoot, profile: DESKTOP_PROFILE_NAME };
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({ ...base, hostVersion: "0.9.0" }).status, "host-version-unsupported");
  assert.notStrictEqual(inspectDeepSeekHarnessDiskSync({ ...base, hostVersion: null }).status, "host-version-unsupported");
});

test("an unknown profile name is rejected", () => {
  assert.throws(() => inspectDeepSeekHarnessDiskSync({ profile: "staging" }), /Unsupported DeepSeek Harness profile/);
  assert.throws(() => resolveDshProfileDir("/tmp/x", "staging"), /Unsupported DeepSeek Harness profile/);
});

// ---------------------------------------------------------------------------
// Desktop discovery
// ---------------------------------------------------------------------------

test("a valid macOS app bundle is found with its launcher and version", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = makeApp(root, "DeepSeek Harness.app");
  const result = discoverDshDesktopSync({ platform: "darwin", desktopAppPaths: [appRoot] });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, appRoot);
  assert.strictEqual(result.staticVersion, FAMILY_VERSION);
  assert.strictEqual(result.launcherPath, path.join(appRoot, DESKTOP_LAUNCHER_RELATIVE));
});

test("an app bundle with the wrong identifier is not DeepSeek Harness", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = makeApp(root, "DeepSeek Harness.app", { bundleId: "com.example.other" });
  const result = discoverDshDesktopSync({ platform: "darwin", desktopAppPaths: [appRoot] });
  assert.strictEqual(result.status, "not-found");
});

test("a matching bundle id without the bundled launcher is unknown, not found", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = makeApp(root, "DeepSeek Harness.app", { launcher: false });
  const result = discoverDshDesktopSync({ platform: "darwin", desktopAppPaths: [appRoot] });
  assert.strictEqual(result.status, "unknown");
  assert.strictEqual(result.reason, "launcher-missing");
  assert.deepStrictEqual(result.checkedPaths, [appRoot]);
});

test("the first valid app location wins", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = makeApp(path.join(root, "system"), "DeepSeek Harness.app");
  const second = makeApp(path.join(root, "user"), "DeepSeek Harness.app");
  const result = discoverDshDesktopSync({ platform: "darwin", desktopAppPaths: [first, second] });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, first);
});

test("an unreadable binary Info.plist makes the only candidate unknown", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = makeApp(root, "DeepSeek Harness.app", { xml: false });
  const result = discoverDshDesktopSync({ platform: "darwin", desktopAppPaths: [appRoot] });
  assert.strictEqual(result.status, "unknown");
  assert.deepStrictEqual(result.checkedPaths, [appRoot]);
});

test("no candidate reports not-found with the checked paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = [path.join(root, "a", "DeepSeek Harness.app"), path.join(root, "b", "DeepSeek Harness.app")];
  const result = discoverDshDesktopSync({ platform: "darwin", desktopAppPaths: missing });
  assert.strictEqual(result.status, "not-found");
  assert.deepStrictEqual(result.checkedPaths, missing);
});

test("an invalid bundle version leaves staticVersion unknown but keeps the candidate", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = makeApp(root, "DeepSeek Harness.app", { version: "not-a-version" });
  const result = discoverDshDesktopSync({ platform: "darwin", desktopAppPaths: [appRoot] });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.staticVersion, null);
});

test("a user Applications path under homeDir is discovered on macOS", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = makeApp(path.join(root, "Applications"), "DeepSeek Harness.app");
  const result = discoverDshDesktopSync({
    platform: "darwin",
    homeDir: root,
    desktopAppPaths: [appRoot],
  });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, appRoot);
});

test("an unreadable Windows registry is unknown, not a false not-found", () => {
  const result = discoverDshDesktopSync({
    platform: "win32",
    windowsRegistrySnapshot: new Error("registry unavailable"),
  });
  assert.strictEqual(result.status, "unknown");
  assert.strictEqual(result.reason, "registry-unreadable");
});

test("Linux desktop discovery is unsupported", () => {
  const result = discoverDshDesktopSync({ platform: "linux" });
  assert.strictEqual(result.status, "not-found");
  assert.strictEqual(result.reason, "unsupported-platform");
});

// ---------------------------------------------------------------------------
// Role: shared rows 1-9
// ---------------------------------------------------------------------------

test("a corrupt profile manifest is diagnosed", (t) => {
  const env = makeHome(t);
  const profileDir = path.join(env.dshHome, "profiles", WEB_PROFILE_NAME);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "package.json"), "{ not json", "utf8");
  const target = inspectWeb(env, "doctor");
  assert.strictEqual(target.evidence.manifest, "corrupt");
  assert.strictEqual(target.role, "diagnose");
  assert.strictEqual(target.reason, "profile-corrupt");
});

test("an unreadable profile manifest is diagnosed", (t) => {
  const env = makeHome(t);
  const profileDir = writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  const manifestPath = path.join(profileDir, "package.json");
  const target = inspectWeb(env, "doctor", { fs: fsFailingRead(manifestPath) });
  assert.strictEqual(target.evidence.manifest, "unreadable");
  assert.strictEqual(target.reason, "profile-unreadable");
});

test("a symlinked profile directory is diagnosed", (t) => {
  const env = makeHome(t);
  const realDir = path.join(env.root, "real-web");
  writeJson(path.join(realDir, "package.json"), {
    name: "dsh-profile-web",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });
  const linkDir = path.join(env.dshHome, "profiles", WEB_PROFILE_NAME);
  fs.mkdirSync(path.dirname(linkDir), { recursive: true });
  symlinkDir(realDir, linkDir);
  const target = inspectWeb(env, "doctor");
  assert.strictEqual(target.evidence.manifest, "symlink");
  assert.strictEqual(target.reason, "profile-symlink");
});

test("an interrupted removal residue is diagnosed before anything else", (t) => {
  const env = makeHome(t);
  writeResidue(env, WEB_PROFILE_NAME);
  const target = inspectWeb(env, "doctor");
  assert.strictEqual(target.evidence.residue, "present");
  assert.strictEqual(target.reason, "removal-residue");
});

test("an unreadable residue directory is diagnosed", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  const linkDir = path.dirname(bridgePackageDir(path.join(env.dshHome, "profiles", WEB_PROFILE_NAME)));
  const target = inspectWeb(env, "doctor", { fs: fsFailingReaddir(linkDir) });
  assert.strictEqual(target.evidence.residue, "unknown");
  assert.strictEqual(target.reason, "residue-unreadable");
});

test("an invalid inspection latch is diagnosed", (t) => {
  const env = makeHome(t);
  writeLatch(env, WEB_PROFILE_NAME, { owner: "someone-else", schemaVersion: 1 });
  const target = inspectWeb(env, "doctor");
  assert.strictEqual(target.evidence.latch, "invalid");
  assert.strictEqual(target.reason, "latch-invalid");
});

test("an unreadable inspection latch is diagnosed", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  const latchPath = writeLatch(env, WEB_PROFILE_NAME);
  const target = inspectWeb(env, "doctor", { fs: fsFailingRead(latchPath) });
  assert.strictEqual(target.evidence.latch, "unknown");
  assert.strictEqual(target.reason, "latch-unreadable");
});

test("an unreadable web manual reference is diagnosed", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  const target = inspectWeb(env, "doctor", { fs: fsFailingReaddir(env.managedRoot) });
  assert.strictEqual(target.evidence.manualReference, "unknown");
  assert.strictEqual(target.reason, "manual-reference-unreadable");
});

test("a web host outside every family without our registration is version-unsupported", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  const npmRoot = path.join(env.root, "npm-dsh");
  writeJson(path.join(npmRoot, "package.json"), { name: "@deepseek-ai/dsh", version: "0.9.0" });
  const target = inspectWeb(env, "doctor", { dshInstallRoot: npmRoot });
  assert.strictEqual(target.evidence.manifest, "present");
  assert.strictEqual(target.evidence.registration, "none");
  assert.strictEqual(target.role, "diagnose");
  assert.strictEqual(target.reason, "version-unsupported");
});

test("a foreign package is diagnosed", (t) => {
  const env = makeHome(t);
  writeForeignProfile(env, WEB_PROFILE_NAME);
  const target = inspectWeb(env, "doctor");
  assert.strictEqual(target.evidence.registration, "foreign");
  assert.strictEqual(target.reason, "foreign-package");
});

test("a damaged generation is diagnosed", (t) => {
  const env = makeHome(t);
  writeDamagedProfile(env, WEB_PROFILE_NAME);
  const target = inspectWeb(env, "doctor");
  assert.strictEqual(target.evidence.registration, "damaged");
  assert.strictEqual(target.reason, "integrity-failed");
});

test("an invalid web manual reference is diagnosed", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  writeJson(path.join(env.managedRoot, "manual-generation-reference.json"), {
    owner: "someone-else",
    schemaVersion: 1,
    packageName: BRIDGE_PACKAGE_NAME,
  });
  const target = inspectWeb(env, "doctor");
  assert.strictEqual(target.evidence.manualReference, "invalid");
  assert.strictEqual(target.reason, "manual-reference-invalid");
});

test("a web host outside every family is version-unsupported", (t) => {
  const env = makeHome(t);
  writeHealthyWebProfile(env);
  const npmRoot = path.join(env.root, "npm-dsh");
  writeJson(path.join(npmRoot, "package.json"), { name: "@deepseek-ai/dsh", version: "0.9.0" });
  const target = inspectWeb(env, "doctor", { dshInstallRoot: npmRoot });
  assert.strictEqual(target.reason, "version-unsupported");
});

test("a desktop host outside every family is version-unsupported", (t) => {
  const env = makeHome(t);
  const target = inspectDesktop(env, "doctor", { desktopDiscovery: desktopFound("0.9.0") });
  assert.strictEqual(target.reason, "version-unsupported");
});

test("startup sync defers to an outstanding inspection latch", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  writeLatch(env, WEB_PROFILE_NAME);
  assert.strictEqual(inspectWeb(env, "startup-sync").reason, "inspection-required");
  assert.notStrictEqual(inspectWeb(env, "doctor").reason, "inspection-required");
});

// ---------------------------------------------------------------------------
// Role: desktop step 10
// ---------------------------------------------------------------------------

test("a missing desktop app with our registration still present is carrier-unavailable", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME);
  writeLatch(env, DESKTOP_PROFILE_NAME);
  const target = inspectDesktop(env, "doctor");
  assert.strictEqual(target.role, "diagnose");
  assert.strictEqual(target.reason, "carrier-unavailable");
});

test("a missing desktop app with no evidence is not applicable", (t) => {
  const env = makeHome(t);
  const target = inspectDesktop(env, "doctor");
  assert.strictEqual(target.role, "not-applicable");
  assert.strictEqual(target.reason, "desktop-not-installed");
});

test("a leftover desktop profile with no desktop app and no registration is not applicable", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME, {
    name: "dsh-profile-desktop",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });
  const target = inspectDesktop(env, "doctor");
  assert.strictEqual(target.role, "not-applicable");
  assert.strictEqual(target.reason, "desktop-not-installed");
});

test("an unverifiable desktop app with a surviving manifest is diagnosed", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME, {
    name: "dsh-profile-desktop",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });
  const target = inspectDesktop(env, "doctor", {
    desktopDiscovery: { ...NO_DESKTOP, status: "unknown", reason: "registry-unreadable" },
  });
  assert.strictEqual(target.role, "diagnose");
  assert.strictEqual(target.reason, "desktop-unverifiable");
});

test("an unverifiable desktop app with no evidence is not applicable", (t) => {
  const env = makeHome(t);
  const target = inspectDesktop(env, "doctor", {
    desktopDiscovery: { ...NO_DESKTOP, status: "unknown", reason: "registry-unreadable" },
  });
  assert.strictEqual(target.role, "not-applicable");
  assert.strictEqual(target.reason, "desktop-not-installed");
});

test("a found desktop app with an uninitialized profile asks the user to open it", (t) => {
  const env = makeHome(t);
  const target = inspectDesktop(env, "install", { desktopDiscovery: desktopFound() });
  assert.strictEqual(target.role, "not-applicable");
  assert.strictEqual(target.reason, "desktop-profile-uninitialized");
});

test("a found desktop app with an absent profile but an outstanding latch is diagnosed", (t) => {
  const env = makeHome(t);
  writeLatch(env, DESKTOP_PROFILE_NAME);
  const target = inspectDesktop(env, "install", { desktopDiscovery: desktopFound() });
  assert.strictEqual(target.role, "diagnose");
  assert.strictEqual(target.reason, "inspection-required");
});

test("a found desktop app with an initialized profile is mutable", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME, {
    name: "dsh-profile-desktop",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });
  const target = inspectDesktop(env, "install", { desktopDiscovery: desktopFound() });
  assert.strictEqual(target.role, "mutable");
  assert.strictEqual(target.reason, null);
  assert.strictEqual(target.carrier.status, "unverified");
  assert.strictEqual(target.carrier.kind, "desktop");
});

// ---------------------------------------------------------------------------
// Role: web step 10
// ---------------------------------------------------------------------------

test("a web command with an initialized profile is mutable", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "dsh"), "#!/bin/sh\n");
  const target = inspectWeb(env, "startup-sync", { env: { PATH: bin } });
  assert.strictEqual(target.role, "mutable");
  assert.strictEqual(target.carrier.status, "unverified");
  assert.strictEqual(target.carrier.kind, "npm");
});

test("a web command with an absent profile may initialize it on install", (t) => {
  const env = makeHome(t);
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "dsh"), "#!/bin/sh\n");
  const target = inspectWeb(env, "install", { env: { PATH: bin } });
  assert.strictEqual(target.role, "mutable");
  assert.strictEqual(target.initializesProfile, true);
});

test("a web command with an absent profile diagnoses startup sync", (t) => {
  const env = makeHome(t);
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "dsh"), "#!/bin/sh\n");
  const target = inspectWeb(env, "startup-sync", { env: { PATH: bin } });
  assert.strictEqual(target.role, "diagnose");
  assert.strictEqual(target.reason, "web-profile-uninitialized");
});

test("a web command with an absent profile is mutable for uninstall", (t) => {
  const env = makeHome(t);
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "dsh"), "#!/bin/sh\n");
  const target = inspectWeb(env, "uninstall", { env: { PATH: bin } });
  assert.strictEqual(target.role, "mutable");
  assert.strictEqual(target.initializesProfile, false);
});

test("no web command with a surviving manifest keeps the manual fallback", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  const target = inspectWeb(env, "install");
  assert.strictEqual(target.role, "diagnose");
  assert.strictEqual(target.reason, "cli-unavailable");
  assert.strictEqual(target.manualFallback, true);
});

test("no web command and no evidence is not applicable", (t) => {
  const env = makeHome(t);
  const target = inspectWeb(env, "install");
  assert.strictEqual(target.role, "not-applicable");
  assert.strictEqual(target.reason, "web-not-used");
});

// ---------------------------------------------------------------------------
// Matrix scenarios
// ---------------------------------------------------------------------------

test("only web is applicable when no desktop trace exists", (t) => {
  const env = makeHome(t);
  writeHealthyWebProfile(env);
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "dsh"), "#!/bin/sh\n");
  const targets = inspectDshTargetsSync(targetOptions(env, { env: { PATH: bin } }), { operation: "startup-sync" });
  assert.strictEqual(targets.web.role, "mutable");
  assert.strictEqual(targets.desktop.role, "not-applicable");
  assert.strictEqual(targets.desktop.reason, "desktop-not-installed");
});

test("only desktop is applicable when web was never used", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME, {
    name: "dsh-profile-desktop",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });
  const targets = inspectDshTargetsSync(targetOptions(env, { desktopDiscovery: desktopFound() }), { operation: "install" });
  assert.strictEqual(targets.web.role, "not-applicable");
  assert.strictEqual(targets.web.reason, "web-not-used");
  assert.strictEqual(targets.desktop.role, "mutable");
});

test("a desktop removal residue is diagnosed even when the app is gone", (t) => {
  const env = makeHome(t);
  writeResidue(env, DESKTOP_PROFILE_NAME, "dsh-clawd-bridge.clawd-removing-x");
  const targets = inspectDshTargetsSync(targetOptions(env), { operation: "doctor" });
  assert.strictEqual(targets.desktop.evidence.residue, "present");
  assert.strictEqual(targets.desktop.reason, "removal-residue");
});

// ---------------------------------------------------------------------------
// web unchanged
// ---------------------------------------------------------------------------

test("inspectDeepSeekHarnessDiskSync without a profile matches an explicit web profile", (t) => {
  const env = makeHome(t);
  writeHealthyWebProfile(env);
  const base = { dshHome: env.dshHome, managedRoot: env.managedRoot, sourceDir: SOURCE_DIR, dshInstallRoot: null };
  const withoutProfile = inspectDeepSeekHarnessDiskSync({ ...base });
  const explicitWeb = inspectDeepSeekHarnessDiskSync({ ...base, profile: WEB_PROFILE_NAME });
  assert.deepStrictEqual(withoutProfile, explicitWeb);
  assert.strictEqual(withoutProfile.profile, WEB_PROFILE_NAME);
  assert.strictEqual(withoutProfile.status, "healthy");
});

test("inspectDeepSeekHarnessIntegration without a profile matches an explicit web profile", async (t) => {
  const env = makeHome(t);
  writeHealthyWebProfile(env);
  const base = {
    dshHome: env.dshHome,
    managedRoot: env.managedRoot,
    sourceDir: SOURCE_DIR,
    resolveCommandForInspection: false,
  };
  const withoutProfile = await inspectDeepSeekHarnessIntegration({ ...base });
  const explicitWeb = await inspectDeepSeekHarnessIntegration({ ...base, profile: WEB_PROFILE_NAME });
  assert.deepStrictEqual(withoutProfile, explicitWeb);
  assert.strictEqual(withoutProfile.profile, WEB_PROFILE_NAME);
});

test("the default profile is web, not desktop, when a desktop manifest exists", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME, {
    name: "dsh-profile-desktop",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });
  const health = inspectDeepSeekHarnessDiskSync({ dshHome: env.dshHome, managedRoot: env.managedRoot, dshInstallRoot: null });
  assert.strictEqual(health.profile, WEB_PROFILE_NAME);
  assert.strictEqual(health.status, "profile-missing");
});

test("the desktop target ignores any npm install root passed to it", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME, {
    name: "dsh-profile-desktop",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });
  const npmRoot = path.join(env.root, "npm-dsh");
  writeJson(path.join(npmRoot, "package.json"), { name: "@deepseek-ai/dsh", version: "0.9.0" });
  const targets = inspectDshTargetsSync(
    targetOptions(env, { desktopDiscovery: desktopFound(null), dshInstallRoot: npmRoot }),
    { operation: "doctor" }
  );
  assert.strictEqual(targets.desktop.health.installationResolved, null);
  assert.notStrictEqual(targets.desktop.health.status, "host-version-unsupported");
});

// ---------------------------------------------------------------------------
// Rework additions
// ---------------------------------------------------------------------------

test("doctor is treated as an explicit repair", (t) => {
  const env = makeHome(t);
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "dsh"), "#!/bin/sh\n");
  const withDoctor = inspectDshTargetsSync(targetOptions(env, { env: { PATH: bin } }), { operation: "doctor" });
  const withRepair = inspectDshTargetsSync(targetOptions(env, { env: { PATH: bin } }), { operation: "explicit-repair" });
  assert.strictEqual(withDoctor.web.role, "mutable");
  assert.strictEqual(withDoctor.web.initializesProfile, true);
  assert.deepStrictEqual(withDoctor, withRepair);
});

test("an inspection latch does not block an explicit install", (t) => {
  const env = makeHome(t);
  writeHealthyWebProfile(env);
  writeLatch(env, WEB_PROFILE_NAME);
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "dsh"), "#!/bin/sh\n");
  const target = inspectWeb(env, "install", { env: { PATH: bin } });
  assert.strictEqual(target.evidence.latch, "present");
  assert.strictEqual(target.evidence.registration, "owned");
  assert.strictEqual(target.role, "mutable");
  assert.strictEqual(target.reason, null);
});

test("an unavailable plugin source is diagnosed for web", (t) => {
  const env = makeHome(t);
  writeHealthyWebProfile(env);
  const target = inspectWeb(env, "doctor", { expectedHashes: null });
  assert.strictEqual(target.health.status, "source-unavailable");
  assert.strictEqual(target.role, "diagnose");
  assert.strictEqual(target.reason, "source-unavailable");
});

test("an unavailable plugin source is diagnosed for desktop", (t) => {
  const env = makeHome(t);
  writeHealthyProfile(env, DESKTOP_PROFILE_NAME);
  const target = inspectDesktop(env, "doctor", { expectedHashes: null, desktopDiscovery: desktopFound() });
  assert.strictEqual(target.health.status, "source-unavailable");
  assert.strictEqual(target.role, "diagnose");
  assert.strictEqual(target.reason, "source-unavailable");
});

test("a manual reference residue is diagnosed instead of read as missing", (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, WEB_PROFILE_NAME);
  fs.mkdirSync(env.managedRoot, { recursive: true });
  fs.writeFileSync(
    path.join(env.managedRoot, "manual-generation-reference.json.clearing-abc"),
    "{}",
    "utf8"
  );
  const target = inspectWeb(env, "doctor");
  assert.strictEqual(target.evidence.manualReference, "invalid");
  assert.strictEqual(target.reason, "manual-reference-invalid");
});

test("async desktop inspection never reads the npm dsh install root", async (t) => {
  const env = makeHome(t);
  writeProfileManifest(env.dshHome, DESKTOP_PROFILE_NAME, {
    name: "dsh-profile-desktop",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });
  const npmRoot = path.join(env.root, "npm-dsh");
  writeJson(path.join(bridgePackageDir(npmRoot), "package.json"), {
    name: BRIDGE_PACKAGE_NAME,
    version: "9.9.9",
  });
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: env.dshHome,
    managedRoot: env.managedRoot,
    profile: DESKTOP_PROFILE_NAME,
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: npmRoot },
    resolveCommandForInspection: false,
  });
  assert.strictEqual(health.installationResolved, null);
});

test("an unknown target operation is rejected", (t) => {
  const env = makeHome(t);
  assert.throws(
    () => inspectDshTargetsSync(targetOptions(env), { operation: "frobnicate" }),
    /Unsupported DeepSeek Harness target operation/
  );
  assert.throws(
    () => inspectDshTargetsSync(targetOptions(env), {}),
    /Unsupported DeepSeek Harness target operation/
  );
  assert.throws(
    () => inspectDshTargetsSync(targetOptions(env)),
    /Unsupported DeepSeek Harness target operation/
  );
});

test("both target records expose the same fields", (t) => {
  const env = makeHome(t);
  const targets = inspectDshTargetsSync(
    targetOptions(env, { desktopDiscovery: desktopFound() }),
    { operation: "doctor" }
  );
  assert.strictEqual(targets.web.discovery, null);
  assert.strictEqual(targets.desktop.manualFallback, false);
  assert.deepStrictEqual(Object.keys(targets.web).sort(), Object.keys(targets.desktop).sort());
});
