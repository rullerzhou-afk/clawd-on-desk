"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { PREFIX, prepareAppImageLauncher } = require("../scripts/prepare-appimage-launcher");

const {
  REVIEWED_PATH_EXPORTS,
  validateAppRunContent,
  verifyArtifact,
} = require("../scripts/verify-appimage-apprun");

const ROOT = path.join(__dirname, "..");
const FIXTURE_ROOT = path.join(__dirname, "fixtures", "appimage-apprun");
const SAFE_FIXTURE = fs.readFileSync(
  path.join(FIXTURE_ROOT, "electron-builder-26.15.7.AppRun"),
  "utf8"
);
const VULNERABLE_FIXTURE = fs.readFileSync(
  path.join(FIXTURE_ROOT, "electron-builder-26.8.1.AppRun"),
  "utf8"
);

function workflowJob(workflow, jobName) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`  ${jobName}:`);
  assert.notStrictEqual(start, -1, `workflow must define the ${jobName} job`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function assertAppearsBefore(content, earlier, later, label) {
  const earlierIndex = content.indexOf(earlier);
  const laterIndex = content.indexOf(later);
  assert.notStrictEqual(earlierIndex, -1, `${label} must contain ${earlier}`);
  assert.notStrictEqual(laterIndex, -1, `${label} must contain ${later}`);
  assert.ok(earlierIndex < laterIndex, `${earlier} must run before ${later} in ${label}`);
}

test("accepts the reviewed electron-builder 26.15.7 AppRun assignments", () => {
  const result = validateAppRunContent(SAFE_FIXTURE);
  assert.deepStrictEqual(Object.keys(result), [...REVIEWED_PATH_EXPORTS]);
  for (const variableName of REVIEWED_PATH_EXPORTS) {
    assert.match(result[variableName].inheritedUnset, /^\//);
    assert.match(result[variableName].inheritedSet, /^\//);
  }
});

test("rejects the vulnerable electron-builder 26.8.1 AppRun assignments", () => {
  assert.throws(
    () => validateAppRunContent(VULNERABLE_FIXTURE),
    /exactly one top-level export|empty search-path|non-absolute|unreviewed shell syntax/
  );
});

test("rejects a relative literal path component", () => {
  const changed = SAFE_FIXTURE.replace(
    "${APPDIR}/usr/share/",
    "./share/"
  );
  assert.throws(() => validateAppRunContent(changed), /non-absolute/);
});

test("rejects an empty path element", () => {
  const changed = SAFE_FIXTURE.replace(
    "${APPDIR}/usr/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}",
    "${APPDIR}/usr/lib::${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
  );
  assert.throws(() => validateAppRunContent(changed), /empty search-path/);
});

test("rejects command substitution in a reviewed export", () => {
  const changed = SAFE_FIXTURE.replace(
    "${APPDIR}:${APPDIR}/usr/sbin",
    "${APPDIR}:$(id):${APPDIR}/usr/sbin"
  );
  assert.throws(() => validateAppRunContent(changed), /unreviewed shell syntax/);
});

test("rejects a duplicate reviewed top-level export", () => {
  const changed = `${SAFE_FIXTURE}\nexport PATH="\${APPDIR}"\n`;
  assert.throws(() => validateAppRunContent(changed), /exactly one top-level export/);
});

test("rejects whitespace-prefixed export assignments that the shell would execute", async (t) => {
  for (const indentation of ["  ", "\t"]) {
    await t.test(JSON.stringify(indentation), () => {
      const changed = SAFE_FIXTURE.replace(
        "export LD_LIBRARY_PATH=",
        `${indentation}export LD_LIBRARY_PATH=`
      );
      assert.throws(() => validateAppRunContent(changed), /unsupported export syntax/);
    });
  }
});

test("does not count command-prefix LD_LIBRARY_PATH assignments", () => {
  const result = validateAppRunContent(SAFE_FIXTURE);
  assert.strictEqual(result.LD_LIBRARY_PATH.line > 0, true);
});

test("rejects a fifth unreviewed top-level path-list export", () => {
  const changed = `${SAFE_FIXTURE}\nexport PYTHONPATH="\${APPDIR}/python\${PYTHONPATH:+:\${PYTHONPATH}}"\n`;
  assert.throws(() => validateAppRunContent(changed), /top-level exports changed/);
});

test("rejects a fifth unreviewed top-level export without a colon", () => {
  const changed = `${SAFE_FIXTURE}\nexport LD_PRELOAD="/tmp/unreviewed.so"\n`;
  assert.throws(() => validateAppRunContent(changed), /top-level exports changed/);
});

test("release and Wayland workflows gate the final AppImage before artifact handoff", () => {
  const release = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
  const wayland = fs.readFileSync(path.join(ROOT, ".github", "workflows", "wayland-smoke.yml"), "utf8");
  const releaseLinux = workflowJob(release, "build-linux");
  const releaseJob = workflowJob(release, "release");
  const waylandBuild = workflowJob(wayland, "build-appimage");
  const gateCommand = "node scripts/verify-appimage-apprun.js --artifact dist/*.AppImage";
  const uploadAction = "uses: actions/upload-artifact@v4";

  assertAppearsBefore(releaseLinux, gateCommand, uploadAction, "build-linux");
  assertAppearsBefore(waylandBuild, gateCommand, uploadAction, "build-appimage");
  assert.match(releaseLinux, /uses: actions\/upload-artifact@v4\n\s+if: always\(\)/);
  assert.doesNotMatch(waylandBuild, /^\s+if: always\(\)\s*$/m);
  assert.match(
    releaseJob,
    /needs: \[build-windows, build-mac, build-linux, native-package-audit\]/,
  );
});

test("Wayland smoke PR paths cover the hook closure by pattern instead of a drifting hand list", () => {
  const wayland = fs.readFileSync(path.join(ROOT, ".github", "workflows", "wayland-smoke.yml"), "utf8");
  const start = wayland.indexOf("  pull_request:");
  const end = wayland.indexOf("\npermissions:");
  assert.ok(start !== -1 && end > start, "pull_request paths block present");
  const pathsBlock = wayland.slice(start, end);

  assert.match(pathsBlock, /- hooks\/\*\*/, "hooks/** must trigger the packaged gate");
  for (const required of [
    "src/claude-hook-health.js",
    "src/claude-settings-watcher.js",
    "src/claude-hook-operations.js",
    "src/prefs.js",
    "src/integration-sync.js",
    "src/server.js",
    "src/remote-ssh-deploy.js",
  ]) {
    assert.ok(pathsBlock.includes(`- ${required}`), `${required} must trigger the packaged gate`);
  }
  // A hand-enumerated hook file would silently miss a newly added dependency.
  assert.doesNotMatch(pathsBlock, /- hooks\/[^/*\s]+\.js/, "hook files must be covered by hooks/**");
});


test("packaged launcher keeps reviewed exports and hands off before mounted paths enter the environment", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-apprun-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = {
    electronPlatformName: "linux", appOutDir: root,
    packager: { config: { linux: {} }, executableName: "clawd-on-desk",
      appInfo: { productName: "Clawd on Desk", productFilename: "Clawd on Desk" } },
  };
  prepareAppImageLauncher(context);
  const content = fs.readFileSync(path.join(root, "AppRun"), "utf8");
  validateAppRunContent(content);
  assertAppearsBefore(content, "clawd-appimage-supervisor", "export LD_LIBRARY_PATH=", "protected AppRun");
  assert.equal(fs.readFileSync(path.join(root, "clawd-appimage-launcher.sh"), "utf8"),
    fs.readFileSync(path.join(ROOT, "build/appimage-launcher.sh"), "utf8"));
  assert.equal(prepareAppImageLauncher({ electronPlatformName: "darwin" }), null);
  assert.equal(prepareAppImageLauncher({ electronPlatformName: "win32" }), null);
});

// The guard reads `command -p stat`, which bypasses PATH, so the only way to
// make it deterministic is to shadow the `command` builtin with a function
// that simulates the filesystem magic for a stat invocation and transparently
// forwards every other command.
const guard = { skip: process.platform === "win32", timeout: 15000 };
const FUSE_SUPER_MAGIC = "65735546";
const FUSECTL_SUPER_MAGIC = "65735543";

function commandInterceptor() {
  return [
    "command() {",
    '  if [[ "${1-}" == "-p" && "${2-}" == "stat" ]]; then',
    "    shift 2",
    // One line per argument so a quoting regression shows up as extra args.
    '    printf \'ARG %s\\n\' "$@" >> "$TEST_STAT_LOG"',
    '    [[ -z "${FAKE_STAT_FAIL:-}" ]] || return 1',
    '    if [[ "$*" == *%T* ]]; then',
    '      printf \'%s\\n\' "${FAKE_FSTYPE_NAME:-ext2/ext3}"',
    "    else",
    '      printf \'%s\\n\' "${FAKE_FSTYPE_MAGIC:-ef53}"',
    "    fi",
    "    return 0",
    "  fi",
    '  builtin command "$@"',
    "}",
  ].join("\n");
}

function parseStatArgs(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => line.slice("ARG ".length));
}

function parseLaunch(text) {
  const parsed = { arg0: null, args: [] };
  for (const line of text.split("\n")) {
    if (line.startsWith("arg0=")) parsed.arg0 = line.slice("arg0=".length);
    else if (line.startsWith("arg=")) parsed.args.push(line.slice("arg=".length));
  }
  return parsed;
}

function runGuard(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, "app dir");
  fs.mkdirSync(appDir);
  const appImage = path.join(root, "clawd.AppImage");
  fs.writeFileSync(
    path.join(appDir, "clawd-appimage-launcher.sh"),
    [
      "#!/bin/bash",
      'printf \'arg0=%s\\n\' "$0" > "$TEST_LAUNCH_RESULT"',
      'for __arg in "$@"; do printf \'arg=%s\\n\' "$__arg" >> "$TEST_LAUNCH_RESULT"; done',
    ].join("\n"),
    { mode: 0o755 }
  );

  const statLog = path.join(root, "stat.log");
  const launchResult = path.join(root, "launch.txt");
  const fallthrough = path.join(root, "fallthrough.txt");
  // The real AppRun runs this prefix between `set -e` and the supervisor exec.
  const script = [
    "set -e",
    commandInterceptor(),
    PREFIX,
    'printf \'fallthrough\\n\' > "$TEST_FALLTHROUGH"',
  ].join("\n");

  const env = {
    ...process.env,
    TEST_STAT_LOG: statLog,
    TEST_LAUNCH_RESULT: launchResult,
    TEST_FALLTHROUGH: fallthrough,
  };
  delete env.APPDIR;
  delete env.APPIMAGE;
  delete env.FAKE_FSTYPE_NAME;
  delete env.FAKE_FSTYPE_MAGIC;
  delete env.FAKE_STAT_FAIL;
  if (options.appDir === undefined) env.APPDIR = appDir;
  else if (options.appDir !== null) env.APPDIR = options.appDir;
  if (options.appimage === undefined) env.APPIMAGE = appImage;
  else if (options.appimage !== null) env.APPIMAGE = options.appimage;
  if (options.name !== undefined) env.FAKE_FSTYPE_NAME = options.name;
  if (options.magic !== undefined) env.FAKE_FSTYPE_MAGIC = options.magic;
  if (options.statFail) env.FAKE_STAT_FAIL = "1";

  const result = spawnSync("/bin/bash", ["-c", script, "guard-harness", ...(options.args || [])], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  return { appDir, appImage, statLog, launchResult, fallthrough, result };
}

function assertSupervisor(t, harness, args) {
  assert.strictEqual(harness.result.status, 0, harness.result.stderr);
  assert.equal(fs.existsSync(harness.fallthrough), false, "guard must not fall through");
  const launch = fs.existsSync(harness.launchResult)
    ? parseLaunch(fs.readFileSync(harness.launchResult, "utf8"))
    : null;
  assert.ok(launch, "the supervisor must have been executed");
  assert.strictEqual(launch.arg0, "clawd-appimage-supervisor");
  assert.deepEqual(launch.args, [harness.appDir, harness.appImage, ...args]);
}

function assertFallthrough(harness) {
  assert.strictEqual(harness.result.status, 0, harness.result.stderr);
  assert.equal(fs.existsSync(harness.launchResult), false, "the supervisor must not run");
  assert.equal(fs.existsSync(harness.fallthrough), true, "the guard must fall through");
}

test("issue #1048: guard takes over for coreutils >= 9.6 reporting the FUSE type as fuse", guard, (t) => {
  const args = ["--flag", "a b", ""];
  const harness = runGuard(t, { name: "fuse", magic: FUSE_SUPER_MAGIC, args });
  assertSupervisor(t, harness, args);
});

test("issue #1048: guard takes over for coreutils <= 9.4 reporting the FUSE type as fuseblk", guard, (t) => {
  const args = ["--flag", "a b"];
  const harness = runGuard(t, { name: "fuseblk", magic: FUSE_SUPER_MAGIC, args });
  assertSupervisor(t, harness, args);
});

test("issue #1048: guard falls through for non-FUSE filesystems", guard, (t) => {
  for (const [name, magic] of [["ext2/ext3", "ef53"], ["tmpfs", "1021994"]]) {
    const harness = runGuard(t, { name, magic });
    assertFallthrough(harness);
  }
});

test("issue #1048: guard falls through for fusectl, which is not a FUSE data mount", guard, (t) => {
  const harness = runGuard(t, { name: "fusectl", magic: FUSECTL_SUPER_MAGIC });
  assertFallthrough(harness);
});

test("issue #1048: guard does not inspect anything when APPIMAGE or APPDIR is absent", guard, (t) => {
  const missingImage = runGuard(t, { appimage: null, name: "fuse", magic: FUSE_SUPER_MAGIC });
  assertFallthrough(missingImage);
  assert.equal(fs.existsSync(missingImage.statLog), false, "stat must not run without APPIMAGE");
  const missingAppDir = runGuard(t, { appDir: null, name: "fuse", magic: FUSE_SUPER_MAGIC });
  assertFallthrough(missingAppDir);
  assert.equal(fs.existsSync(missingAppDir.statLog), false, "stat must not run without APPDIR");
});

test("issue #1048: guard inspects APPDIR with stat -f -c %t and keeps it one argument", guard, (t) => {
  const harness = runGuard(t, { name: "fuse", magic: FUSE_SUPER_MAGIC });
  assert.deepEqual(parseStatArgs(harness.statLog), ["-f", "-c", "%t", "--", harness.appDir]);
});

test("issue #1048: guard exits when the stat call fails", guard, (t) => {
  const harness = runGuard(t, { name: "fuse", magic: FUSE_SUPER_MAGIC, statFail: true });
  assert.strictEqual(harness.result.status, 1, harness.result.stderr);
  assert.equal(fs.existsSync(harness.launchResult), false, "the supervisor must not run");
  assert.equal(fs.existsSync(harness.fallthrough), false, "a failed stat must not fall through");
});

// A synthetic AppImage whose `--appimage-extract <name>` copies the staged
// reviewed files, so verifyArtifact() can be exercised without a real artifact.
function makeStagedArtifact(t, mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-verify-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, "stage");
  fs.mkdirSync(stage);
  prepareAppImageLauncher({
    electronPlatformName: "linux",
    appOutDir: stage,
    packager: {
      config: { linux: {} },
      executableName: "clawd-on-desk",
      appInfo: { productName: "Clawd on Desk", productFilename: "Clawd on Desk" },
    },
  });
  if (mutate) {
    const appRunPath = path.join(stage, "AppRun");
    fs.writeFileSync(appRunPath, mutate(fs.readFileSync(appRunPath, "utf8")));
  }
  const artifact = path.join(root, "clawd-test.AppImage");
  fs.writeFileSync(artifact, [
    "#!/bin/bash",
    'name=""',
    'if [[ "${1-}" == "--appimage-extract" ]]; then name="${2-}"; fi',
    "mkdir -p squashfs-root",
    `cp -- '${stage}'/"$name" "squashfs-root/$name"`,
  ].join("\n"), { mode: 0o755 });
  return { artifact };
}

const disableGuard = (content) =>
  content.replace('if [[ -n "${APPIMAGE:-}" && -n "${APPDIR:-}" ]]; then', "if false; then");
const legacyGuard = (content) => content.replace(
  [
    'clawd_fs_magic=$(command -p stat -f -c %t -- "$APPDIR") || exit 1',
    '  if [[ "$clawd_fs_magic" == 65735546 ]]; then',
  ].join("\n"),
  [
    'clawd_fs_type=$(command -p stat -f -c %T -- "$APPDIR") || exit 1',
    '  if [[ "$clawd_fs_type" == fuseblk ]]; then',
  ].join("\n")
);
const removeGuard = (content) => content.replace(PREFIX, "");
const moveGuardAfterExports = (content) => `${removeGuard(content)}\n${PREFIX}`;

test("issue #1048: verifier accepts the staged lifetime guard", guard, (t) => {
  const { artifact } = makeStagedArtifact(t);
  assert.equal(verifyArtifact(artifact).runtimeSupervisorSha256.length, 64);
});

test("issue #1048: verifier rejects disabled, legacy, moved or removed guards", guard, (t) => {
  for (const mutate of [disableGuard, legacyGuard, moveGuardAfterExports, removeGuard]) {
    const { artifact } = makeStagedArtifact(t, mutate);
    assert.throws(() => verifyArtifact(artifact), /lifetime guard/);
  }
});

test("issue #1048: verifier CLI accepts the clean guard and rejects the legacy guard", guard, (t) => {
  const cli = path.join(ROOT, "scripts", "verify-appimage-apprun.js");
  const accepted = makeStagedArtifact(t);
  const acceptedRun = spawnSync(process.execPath, [cli, "--artifact", accepted.artifact], { encoding: "utf8" });
  assert.strictEqual(acceptedRun.status, 0, acceptedRun.stderr);
  assert.doesNotMatch(acceptedRun.stderr, /circular dependency/);
  const legacy = makeStagedArtifact(t, legacyGuard);
  const legacyRun = spawnSync(process.execPath, [cli, "--artifact", legacy.artifact], { encoding: "utf8" });
  assert.notStrictEqual(legacyRun.status, 0, legacyRun.stdout);
  assert.match(legacyRun.stderr, /lifetime guard/);
});
