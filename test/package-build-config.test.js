const assert = require("node:assert");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { minimatch } = require("minimatch");

const pkg = require("../package.json");
const ROOT = path.join(__dirname, "..");

function matchedByAnyGlob(globs, target) {
  return globs.some((g) => minimatch(target, g));
}

describe("package build config", () => {
  it("ships project window icons in packaged builds", () => {
    assert.ok(
      pkg.build.files.includes("assets/icons/**/*"),
      "build.files should include assets/icons/**/*"
    );
  });

  it("ships agent session icons in packaged builds", () => {
    assert.ok(
      pkg.build.files.includes("assets/icons/agents/**/*"),
      "build.files should include assets/icons/agents/**/*"
    );
  });

  it("ships third-party notices in packaged builds", () => {
    assert.ok(
      pkg.build.files.includes("NOTICE.md"),
      "build.files should include NOTICE.md"
    );
  });

  it("unpacks built-in theme assets so the folder can be opened from settings", () => {
    assert.ok(
      pkg.build.asarUnpack.includes("assets/svg/**/*"),
      "asarUnpack should include assets/svg/**/*"
    );
    assert.ok(
      pkg.build.asarUnpack.includes("themes/**/*"),
      "asarUnpack should include themes/**/*"
    );
  });

  describe("Windows architecture targets", () => {
    function getWindowsNsisTarget() {
      const targets = pkg.build.win && pkg.build.win.target;
      return Array.isArray(targets) ? targets.find((target) => target && target.target === "nsis") : null;
    }

    it("builds native Windows installers for x64 and arm64", () => {
      const target = getWindowsNsisTarget();
      assert.ok(target, "build.win.target should include an nsis target");
      assert.deepStrictEqual(
        target.arch.slice().sort(),
        ["x64", "arm64"].slice().sort(),
        "Windows NSIS builds should publish both x64 and ARM64 installers"
      );
    });

    it("uses architecture-specific Windows installer names", () => {
      const artifactName = pkg.build.win && pkg.build.win.artifactName;
      assert.strictEqual(
        typeof artifactName,
        "string",
        "build.win.artifactName should be a string"
      );
      assert.match(
        artifactName,
        /\$\{arch\}/,
        "Windows artifactName must include ${arch} so x64 and ARM64 installers cannot collide"
      );
    });

    it("exposes explicit Windows architecture build scripts", () => {
      assert.strictEqual(pkg.scripts["build:win:x64"], "electron-builder --win nsis:x64");
      assert.strictEqual(pkg.scripts["build:win:arm64"], "electron-builder --win nsis:arm64");
      assert.strictEqual(pkg.scripts["build:win:all"], "electron-builder --win nsis:x64 nsis:arm64");
    });

    it("does not emit a redundant universal Windows installer", () => {
      assert.strictEqual(
        pkg.build.nsis && pkg.build.nsis.buildUniversalInstaller,
        false,
        "Windows releases should publish explicit x64/ARM64 installers, not an extra universal NSIS installer"
      );
    });
  });

  // getWindowsShellIconPath has a three-step fallback:
  //   1. resourcesPath/icon.ico            ← extraResources copy
  //   2. resourcesPath/app.asar.unpacked/assets/icon.ico
  //   3. resourcesPath/app.asar/assets/icon.ico
  // Fallback 1 only works if extraResources actually copies icon.ico, and
  // fallback 3 only works if icon.ico is inside build.files. Guard both so a
  // future refactor to either array can't silently drop the shell icon.
  describe("Windows shell icon fallback chain", () => {
    it("has the source icon.ico on disk", () => {
      const src = path.join(ROOT, "assets", "icon.ico");
      assert.ok(fs.existsSync(src), "assets/icon.ico must exist for build.win.icon + extraResources");
    });

    it("copies icon.ico into resourcesPath via extraResources", () => {
      const extra = pkg.build.extraResources || [];
      const copied = extra.some(
        (e) => e && e.from === "assets/icon.ico" && e.to === "icon.ico"
      );
      assert.ok(copied, "build.extraResources must copy assets/icon.ico → icon.ico (shell fallback 1)");
    });

    it("wires win.icon to the same source file", () => {
      assert.strictEqual(
        pkg.build.win && pkg.build.win.icon,
        "assets/icon.ico",
        "build.win.icon should point at the same file the shell icon chain expects"
      );
    });

    it("packs icon.ico into the asar so fallback 3 resolves", () => {
      // getWindowsShellIconPath's third fallback reads
      // resourcesPath/app.asar/assets/icon.ico — which only exists if the
      // file survives the build.files glob filter. Earlier versions listed
      // only assets/icons/**/* (subdir), which does NOT match assets/icon.ico
      // at the root, so fallback 3 was dead. Guard against that regression.
      assert.ok(
        matchedByAnyGlob(pkg.build.files, "assets/icon.ico"),
        "build.files must include a glob covering assets/icon.ico (fallback 3)"
      );
    });
  });

  describe("Telegram approval sidecar packaging", () => {
    it("preflights sidecar binaries before source launches", () => {
      assert.match(pkg.scripts.start, /node scripts\/ensure-sidecar-binaries\.js && node launch\.js/);
    });

    it("copies cc-connect-clawd sidecars into packaged resources", () => {
      const extra = pkg.build.extraResources || [];
      const copied = extra.some(
        (e) => e && e.from === "bin/cc-connect-clawd" && e.to === "sidecars/cc-connect-clawd"
      );
      assert.ok(
        copied,
        "build.extraResources must copy bin/cc-connect-clawd -> sidecars/cc-connect-clawd"
      );
    });

    it("documents the expected sidecar binary names in the README", () => {
      const readme = path.join(ROOT, "bin", "cc-connect-clawd", "README.md");
      assert.ok(fs.existsSync(readme), "bin/cc-connect-clawd/README.md should document release binary names");
      const text = fs.readFileSync(readme, "utf8");
      assert.match(text, /windows-x64\/cc-connect-clawd\.exe/);
      assert.match(text, /darwin-arm64\/cc-connect-clawd/);
      assert.match(text, /linux-x64\/cc-connect-clawd/);
    });

    it("fetches and verifies pinned sidecars before release builds", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      assertWorkflowOrder(
        workflow,
        "npm run fetch:sidecars -- --target windows-x64,windows-arm64",
        "node scripts/verify-sidecar-binaries.js prebuild:win:all",
        "npx electron-builder --win --publish never"
      );
      assertWorkflowOrder(
        workflow,
        "npm run fetch:sidecars -- --target darwin-x64,darwin-arm64",
        "node scripts/verify-sidecar-binaries.js prebuild:mac",
        "npx electron-builder --mac --publish never"
      );
      assertWorkflowOrder(
        workflow,
        "npm run fetch:sidecars -- --target linux-x64",
        "node scripts/verify-sidecar-binaries.js prebuild:linux",
        "npx electron-builder --linux --publish never"
      );
    });

    it("publishes GitHub releases only for version tags", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      const releaseIndex = findWorkflowJobIndex(workflow, "release");
      assert.ok(releaseIndex >= 0, "workflow should define a release job");
      const releaseGateIndex = workflow.indexOf("if: startsWith(github.ref, 'refs/tags/v')", releaseIndex);
      const bodyPathIndex = workflow.indexOf("body_path: docs/releases/release-${{ github.ref_name }}.md", releaseIndex);
      assert.ok(releaseGateIndex >= 0, "release job should be gated to v* tags");
      assert.ok(bodyPathIndex >= 0, "release job should still use tag-specific release notes");
      assert.ok(releaseGateIndex < bodyPathIndex, "release job gate should run before release publication");
    });

    it("creates tag releases as drafts for final asset inspection", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      const releaseIndex = findWorkflowJobIndex(workflow, "release");
      assert.ok(releaseIndex >= 0, "workflow should define a release job");
      const actionIndex = workflow.indexOf("softprops/action-gh-release@v2", releaseIndex);
      const draftIndex = workflow.indexOf("draft: true", actionIndex);
      const prereleaseIndex = workflow.indexOf("prerelease: ${{ contains(github.ref_name, '-') }}", actionIndex);
      assert.ok(actionIndex >= 0, "release job should use the GitHub release action");
      assert.ok(draftIndex > actionIndex, "tag releases should be created as drafts first");
      assert.ok(prereleaseIndex > actionIndex, "hyphenated tags should be marked prerelease");
    });
  });
});

function findWorkflowJobIndex(workflow, jobName) {
  const match = String(workflow || "").match(new RegExp(`(?:^|\\r?\\n)  ${jobName}:\\r?\\n`));
  return match ? match.index : -1;
}

function assertWorkflowOrder(workflow, fetchCommand, verifyCommand, buildCommand) {
  const fetchIndex = workflow.indexOf(fetchCommand);
  const verifyIndex = workflow.indexOf(verifyCommand);
  const buildIndex = workflow.indexOf(buildCommand);
  assert.ok(fetchIndex >= 0, `workflow should run: ${fetchCommand}`);
  assert.ok(verifyIndex >= 0, `workflow should run: ${verifyCommand}`);
  assert.ok(buildIndex >= 0, `workflow should run: ${buildCommand}`);
  assert.ok(fetchIndex < verifyIndex, `${fetchCommand} should run before ${verifyCommand}`);
  assert.ok(verifyIndex < buildIndex, `${verifyCommand} should run before ${buildCommand}`);
}
