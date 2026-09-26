"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const os = require("node:os");
const { prepareAppImageLauncher } = require("../scripts/prepare-appimage-launcher");

const {
  REVIEWED_PATH_EXPORTS,
  validateAppRunContent,
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
