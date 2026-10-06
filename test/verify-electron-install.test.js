"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ISSUE_URL,
  MAC_HELPER_APPS,
  expectedPlatformPath,
  verifyElectronInstall,
  formatElectronInstallFailure,
  runCli,
} = require("../scripts/verify-electron-install");

const temporaryRoots = new Set();

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-electron-verify-"));
  temporaryRoots.add(root);
  return root;
}

function writeFile(filePath, contents, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  if (mode != null) fs.chmodSync(filePath, mode);
}

function createFixture(platform = "darwin") {
  const rootDir = temporaryRoot();
  const packageRoot = path.join(rootDir, "node_modules", "electron");
  const distRoot = path.join(packageRoot, "dist");
  const platformPath = expectedPlatformPath(platform);
  fs.mkdirSync(packageRoot, { recursive: true });
  writeFile(path.join(rootDir, "package.json"), JSON.stringify({ devDependencies: { electron: "^41.10.2" } }));
  writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ version: "41.10.2" }));
  writeFile(path.join(packageRoot, "path.txt"), platformPath);
  writeFile(path.join(distRoot, platformPath), "binary", platform === "win32" ? undefined : 0o755);

  writeFile(path.join(distRoot, "version"), "41.10.2");

  if (platform === "darwin") {
    const frameworksRoot = path.join(distRoot, "Electron.app", "Contents", "Frameworks");
    writeFile(
      path.join(frameworksRoot, "Electron Framework.framework", "Versions", "A", "Electron Framework"),
      "framework"
    );
    for (const appName of MAC_HELPER_APPS) {
      fs.mkdirSync(path.join(frameworksRoot, appName), { recursive: true });
    }
  }

  return { rootDir, packageRoot, distRoot, platformPath };
}

function verifyFixture(fixture, platform = "darwin", options = {}) {
  return verifyElectronInstall({
    rootDir: fixture.rootDir,
    platform,
    arch: platform === "darwin" ? "arm64" : "x64",
    env: {},
    ...options,
  });
}

function captureStream() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    value() { return value; },
  };
}

test.afterEach(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
    temporaryRoots.delete(root);
  }
});

test("complete macOS fixture passes", () => {
  const fixture = createFixture("darwin");
  const result = verifyFixture(fixture);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, []);
});

test("dist/version accepts one leading v", () => {
  const fixture = createFixture("darwin");
  writeFile(path.join(fixture.distRoot, "version"), "v41.10.2");
  assert.equal(verifyFixture(fixture).ok, true);
});

test("missing path.txt fails", () => {
  const fixture = createFixture("darwin");
  const target = path.join(fixture.packageRoot, "path.txt");
  fs.rmSync(target);
  assert.deepEqual(verifyFixture(fixture).missing, [target]);
});

test("path.txt must match Electron's exact no-newline value", () => {
  const fixture = createFixture("darwin");
  const target = path.join(fixture.packageRoot, "path.txt");
  writeFile(target, `${fixture.platformPath}\n`);
  const result = verifyFixture(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.invalid[0].path, target);
  assert.match(result.invalid[0].reason, /exact contents/);
});

test("missing executable fails", () => {
  const fixture = createFixture("darwin");
  const target = path.join(fixture.distRoot, fixture.platformPath);
  fs.rmSync(target);
  assert.ok(verifyFixture(fixture).missing.includes(target));
});

test("non-executable launcher fails on POSIX", () => {
  const fixture = createFixture("linux");
  const target = path.join(fixture.distRoot, fixture.platformPath);
  fs.chmodSync(target, 0o644);
  const result = verifyFixture(fixture, "linux", { hostPlatform: "linux" });
  assert.equal(result.ok, false);
  assert.match(result.invalid[0].reason, /executable mode/);
});

test("missing macOS Frameworks directory fails even when require path looks valid", () => {
  const fixture = createFixture("darwin");
  const frameworksRoot = path.join(fixture.distRoot, "Electron.app", "Contents", "Frameworks");
  fs.rmSync(frameworksRoot, { recursive: true, force: true });
  const result = verifyFixture(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes(frameworksRoot));
  assert.ok(!result.missing.includes(path.join(fixture.packageRoot, "path.txt")));
});

test("missing Electron Framework binary fails", () => {
  const fixture = createFixture("darwin");
  const target = path.join(
    fixture.distRoot,
    "Electron.app",
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Electron Framework"
  );
  fs.rmSync(target);
  assert.ok(verifyFixture(fixture).missing.includes(target));
});

for (const appName of MAC_HELPER_APPS) {
  test(`missing ${appName} is reported`, () => {
    const fixture = createFixture("darwin");
    const target = path.join(fixture.distRoot, "Electron.app", "Contents", "Frameworks", appName);
    fs.rmSync(target, { recursive: true, force: true });
    assert.ok(verifyFixture(fixture).missing.includes(target));
  });
}

test("dist/version mismatch fails", () => {
  const fixture = createFixture("darwin");
  const target = path.join(fixture.distRoot, "version");
  writeFile(target, "41.0.2");
  const result = verifyFixture(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.invalid[0].path, target);
});

for (const platform of ["win32", "linux"]) {
  test(`${platform} also rejects a dist/version mismatch`, () => {
    const fixture = createFixture(platform);
    const target = path.join(fixture.distRoot, "version");
    writeFile(target, "41.0.2");
    const result = verifyFixture(fixture, platform);
    assert.equal(result.ok, false);
    assert.ok(result.invalid.some((item) => item.path === target));
  });
}

test("installed Electron must satisfy the project's declared range", () => {
  const fixture = createFixture("win32");
  const projectPackage = path.join(fixture.rootDir, "package.json");
  writeFile(projectPackage, JSON.stringify({ devDependencies: { electron: "^42.0.0" } }));
  const result = verifyFixture(fixture, "win32");
  assert.equal(result.ok, false);
  assert.ok(result.invalid.some((item) => item.path === projectPackage));
});

test("complete Windows and Linux fixtures pass without macOS checks", () => {
  const windows = createFixture("win32");
  const linux = createFixture("linux");
  assert.equal(verifyFixture(windows, "win32").ok, true);
  assert.equal(verifyFixture(linux, "linux").ok, true);
});

test("unsupported platform returns a clear result instead of throwing", () => {
  const rootDir = temporaryRoot();
  const result = verifyElectronInstall({ rootDir, platform: "aix", arch: "ppc64", env: {} });
  assert.equal(result.ok, false);
  assert.match(result.invalid[0].reason, /unsupported platform: aix/);
});

test("postinstall explicitly skips intentional download suppression", () => {
  const rootDir = temporaryRoot();
  const result = verifyElectronInstall({
    rootDir,
    context: "postinstall",
    env: { ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "electron-download-skipped");
});

test("postinstall skips when dev dependencies are omitted", () => {
  const rootDir = temporaryRoot();
  const result = verifyElectronInstall({ rootDir, context: "postinstall", env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "electron-dev-dependency-absent");
});

test("postinstall skips a custom Electron distribution", () => {
  const rootDir = temporaryRoot();
  const result = verifyElectronInstall({
    rootDir,
    context: "postinstall",
    env: { ELECTRON_OVERRIDE_DIST_PATH: "/custom/electron" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "custom-electron-dist");
});

test("launch validates the effective ELECTRON_OVERRIDE_DIST_PATH", () => {
  const fixture = createFixture("darwin");
  const overrideRoot = path.join(fixture.rootDir, "custom-electron");
  fs.renameSync(fixture.distRoot, overrideRoot);
  const passing = verifyFixture(fixture, "darwin", {
    context: "launch",
    env: { ELECTRON_OVERRIDE_DIST_PATH: overrideRoot },
  });
  assert.equal(passing.ok, true);

  const frameworksRoot = path.join(overrideRoot, "Electron.app", "Contents", "Frameworks");
  fs.rmSync(frameworksRoot, { recursive: true, force: true });
  const failing = verifyFixture(fixture, "darwin", {
    context: "launch",
    env: { ELECTRON_OVERRIDE_DIST_PATH: overrideRoot },
  });
  assert.equal(failing.ok, false);
  assert.ok(failing.missing.includes(frameworksRoot));
});

test("Linux launch override mirrors Electron's path.txt-free executable fallback", () => {
  const fixture = createFixture("linux");
  const overrideRoot = path.join(fixture.rootDir, "custom-electron");
  fs.renameSync(fixture.distRoot, overrideRoot);
  fs.rmSync(path.join(fixture.packageRoot, "path.txt"));

  const result = verifyFixture(fixture, "linux", {
    context: "launch",
    env: { ELECTRON_OVERRIDE_DIST_PATH: overrideRoot },
  });

  assert.equal(result.ok, true);
  assert.equal(result.executablePath, path.join(overrideRoot, "electron"));
});

test("Linux launch override reports the exact fallback executable when it is missing", () => {
  const fixture = createFixture("linux");
  const overrideRoot = path.join(fixture.rootDir, "custom-electron");
  fs.renameSync(fixture.distRoot, overrideRoot);
  fs.rmSync(path.join(fixture.packageRoot, "path.txt"));
  const executablePath = path.join(overrideRoot, "electron");
  fs.rmSync(executablePath);

  const result = verifyFixture(fixture, "linux", {
    context: "launch",
    env: { ELECTRON_OVERRIDE_DIST_PATH: overrideRoot },
  });

  assert.equal(result.ok, false);
  assert.ok(result.missing.includes(executablePath));
  assert.ok(!result.missing.includes(path.join(fixture.packageRoot, "path.txt")));
});

test("Linux override fallback applies only to launch context", () => {
  const fixture = createFixture("linux");
  const overrideRoot = path.join(fixture.rootDir, "custom-electron");
  fs.renameSync(fixture.distRoot, overrideRoot);
  const pathFile = path.join(fixture.packageRoot, "path.txt");
  fs.rmSync(pathFile);

  const result = verifyFixture(fixture, "linux", {
    context: "verify",
    env: { ELECTRON_OVERRIDE_DIST_PATH: overrideRoot },
  });

  assert.equal(result.ok, false);
  assert.ok(result.missing.includes(pathFile));
});

test("macOS and Windows overrides retain their exact path.txt requirement", () => {
  for (const platform of ["darwin", "win32"]) {
    const fixture = createFixture(platform);
    const overrideRoot = path.join(fixture.rootDir, `custom-electron-${platform}`);
    fs.renameSync(fixture.distRoot, overrideRoot);
    const pathFile = path.join(fixture.packageRoot, "path.txt");
    fs.rmSync(pathFile);

    const result = verifyFixture(fixture, platform, {
      context: "launch",
      env: { ELECTRON_OVERRIDE_DIST_PATH: overrideRoot },
    });

    assert.equal(result.ok, false, platform);
    assert.ok(result.missing.includes(pathFile), platform);
  }
});

test("failure output explains the false green and safe recovery", () => {
  const fixture = createFixture("darwin");
  fs.rmSync(path.join(fixture.distRoot, "Electron.app", "Contents", "Frameworks"), {
    recursive: true,
    force: true,
  });
  const output = formatElectronInstallFailure(verifyFixture(fixture));
  assert.match(output, /install\.js exit status is not sufficient/);
  assert.match(output, /only path\.txt does not restore/);
  assert.match(output, /delete node_modules\/electron completely/);
  assert.match(output, new RegExp(ISSUE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("CLI returns non-zero and prints exact missing paths", () => {
  const fixture = createFixture("darwin");
  const target = path.join(fixture.packageRoot, "path.txt");
  fs.rmSync(target);
  const stdout = captureStream();
  const stderr = captureStream();
  const outcome = runCli([], {
    rootDir: fixture.rootDir,
    platform: "darwin",
    arch: "arm64",
    env: {},
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(outcome.exitCode, 1);
  assert.equal(stdout.value(), "");
  assert.match(stderr.value(), new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("CLI success is concise", () => {
  const fixture = createFixture("darwin");
  const stdout = captureStream();
  const outcome = runCli([], {
    rootDir: fixture.rootDir,
    platform: "darwin",
    arch: "arm64",
    env: {},
    stdout: stdout.stream,
    stderr: captureStream().stream,
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(stdout.value(), "Verified Electron 41.10.2 installation.\n");
});

test("package lifecycle and launch wiring cover install and development entry points", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.scripts["verify:electron"], "node scripts/verify-electron-install.js");
  assert.equal(pkg.scripts.postinstall, "node scripts/verify-electron-install.js --context postinstall");
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name.startsWith("prebuild")) {
      assert.doesNotMatch(command, /verify-electron-install/, `${name} must not gate the builder distribution`);
    }
  }

  const launchSource = fs.readFileSync(path.join(__dirname, "..", "launch.js"), "utf8");
  const verifierIndex = launchSource.indexOf("verifyElectronInstall({ context: \"launch\" })");
  const electronRequireIndex = launchSource.indexOf('const electron = require("electron")');
  assert.notEqual(verifierIndex, -1, "launch verifier wiring must exist");
  assert.notEqual(electronRequireIndex, -1, "Electron module resolution wiring must exist");
  assert.ok(
    verifierIndex < electronRequireIndex,
    "launch verifier must run before Electron module resolution"
  );
});

test("repository and CI use the supported Node contract", () => {
  const rootDir = path.join(__dirname, "..");
  const pkg = require("../package.json");
  assert.equal(pkg.engines.node, ">=22.12.0");
  assert.equal(fs.readFileSync(path.join(rootDir, ".nvmrc"), "utf8").trim(), "24.18.0");

  for (const workflowPath of [
    ".github/workflows/build.yml",
    ".github/workflows/wayland-smoke.yml",
  ]) {
    const workflow = fs.readFileSync(path.join(rootDir, workflowPath), "utf8");
    assert.match(workflow, /node-version-file:\s*\.nvmrc/);
    assert.doesNotMatch(workflow, /node-version:\s*20/);
  }
});
