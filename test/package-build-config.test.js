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
  describe("repository asset audit", () => {
    it("exposes a Windows-compatible npm audit command", () => {
      assert.strictEqual(
        pkg.scripts["audit:assets"],
        "node scripts/audit-repository-assets.js"
      );
    });

    it("does not match retained source artwork with package globs", () => {
      assert.strictEqual(
        matchedByAnyGlob(pkg.build.files, "assets/source/dock-icon-fullbleed.png"),
        false,
        "assets/source/** must stay outside build.files"
      );
    });

    it("runs in pull-request CI and uploads stable JSON manifests", () => {
      const workflowPath = path.join(ROOT, ".github", "workflows", "repository-asset-audit.yml");
      assert.ok(fs.existsSync(workflowPath), "repository asset audit workflow should exist");
      const workflow = fs.readFileSync(workflowPath, "utf8");
      assert.match(workflow, /pull_request:/);
      assert.match(workflow, /npm run audit:assets/);
      assert.match(workflow, /test\/preload-settings\.test\.js/);
      assert.match(workflow, /test\/state-agent-icons\.test\.js/);
      assert.match(workflow, /dist\/repository-asset-audit\/\*\.json/);
      assert.match(
        workflow,
        /^permissions:\r?\n\s+contents: read$/m,
        "repository asset audit should use a read-only GitHub token",
      );
    });
  });

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
      pkg.build.files.includes("assets/accessories/**/*"),
      "build.files should include assets/accessories/**/*"
    );
    assert.ok(
      pkg.build.asarUnpack.includes("assets/accessories/**/*"),
      "asarUnpack should include assets/accessories/**/*"
    );
    assert.ok(
      pkg.build.asarUnpack.includes("themes/**/*"),
      "asarUnpack should include themes/**/*"
    );
  });

  it("ships and unpacks runtime files required by external hook scripts", () => {
    assert.ok(
      pkg.build.files.includes("hooks/**/*"),
      "build.files should include hooks/**/*"
    );
    assert.ok(
      pkg.build.files.includes("extensions/**/*"),
      "build.files should include extensions/**/*"
    );
    assert.ok(
      pkg.build.files.includes("agents/**/*"),
      "build.files should include agents/**/*"
    );
    assert.ok(
      pkg.build.asarUnpack.includes("agents/**/*"),
      "asarUnpack should include agents/**/*"
    );
    assert.ok(
      pkg.build.asarUnpack.includes("hooks/**/*"),
      "asarUnpack should include hooks/**/*"
    );
    assert.ok(
      pkg.build.asarUnpack.includes("extensions/**/*"),
      "asarUnpack should include extensions/**/*"
    );
  });

  it("unpacks jsonc-parser for NSIS cleanup scripts executed outside app.asar", () => {
    assert.ok(
      pkg.build.asarUnpack.includes("node_modules/jsonc-parser/**/*"),
      "NSIS runs cleanup-integrations.js from app.asar.unpacked, so MiMo JSONC cleanup needs an unpacked dependency"
    );
  });

  describe("target-native Koffi packaging", () => {
    it("pins the reviewed Koffi line and prunes only through the afterPack hook", () => {
      assert.strictEqual(pkg.dependencies.koffi, "2.16.3");
      assert.strictEqual(pkg.build.afterPack, "scripts/after-pack-koffi.js");
      assert.strictEqual(pkg.scripts["audit:native-package"], "node scripts/audit-packaged-native.js");
      assert.strictEqual(pkg.scripts["verify:updater-metadata"], "node scripts/verify-updater-metadata.js");
    });

    it("uses reproducible installs in release and five-target package CI", () => {
      const release = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      const packageAudit = fs.readFileSync(
        path.join(ROOT, ".github", "workflows", "telegram-retirement-package-audit.yml"),
        "utf8",
      );
      assert.strictEqual((release.match(/      - run: npm ci/g) || []).length, 3);
      assert.strictEqual((packageAudit.match(/      - run: npm ci/g) || []).length, 2);
      assert.doesNotMatch(release, /      - run: npm install(?:\s|$)/m);
      assert.doesNotMatch(packageAudit, /      - run: npm install(?:\s|$)/m);
    });
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

  describe("macOS architecture targets", () => {
    function getMacDmgTarget() {
      const targets = pkg.build.mac && pkg.build.mac.target;
      return Array.isArray(targets) ? targets.find((target) => target && target.target === "dmg") : null;
    }

    it("builds native macOS DMGs for x64 and arm64", () => {
      const target = getMacDmgTarget();
      assert.ok(target, "build.mac.target should include a dmg target");
      assert.deepStrictEqual(
        target.arch.slice().sort(),
        ["x64", "arm64"].slice().sort(),
        "macOS builds should publish both x64 and ARM64 DMGs"
      );
    });

    it("requests explicit ad-hoc signing without disabling hardened runtime", () => {
      assert.strictEqual(
        pkg.build.mac && pkg.build.mac.identity,
        "-",
        "macOS x64 and ARM64 packages must express ad-hoc signing intent; CI gates the final signatures"
      );
      assert.notStrictEqual(
        pkg.build.mac && pkg.build.mac.hardenedRuntime,
        false,
        "do not silence the ad-hoc signing warning by disabling hardened runtime"
      );
    });

    it("gates both packaged apps on ad-hoc hardened signatures and required entitlements", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      assert.match(workflow, /name: Verify macOS ad-hoc hardened signatures/);
      assert.match(workflow, /dist\/mac\/Clawd on Desk\.app/);
      assert.match(workflow, /dist\/mac-arm64\/Clawd on Desk\.app/);
      assert.match(workflow, /Signature=adhoc/);
      assert.match(workflow, /adhoc,runtime/);
      assert.match(workflow, /codesign --verify --deep --strict/);
      for (const entitlement of [
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
        "com.apple.security.cs.disable-library-validation",
      ]) {
        assert.match(workflow, new RegExp(entitlement.replace(/\./g, "\\.")));
      }
    });

    it("uses architecture-specific macOS DMG names without spaces", () => {
      const artifactName = pkg.build.mac && pkg.build.mac.artifactName;
      assert.strictEqual(
        typeof artifactName,
        "string",
        "build.mac.artifactName should be a string"
      );
      assert.match(
        artifactName,
        /\$\{arch\}/,
        "macOS artifactName must include ${arch} so x64 and ARM64 DMGs cannot collide"
      );
      assert.doesNotMatch(
        artifactName,
        /\s/,
        "macOS artifactName should not contain spaces so latest-mac.yml URLs match uploaded DMG assets"
      );
    });
  });

  describe("Linux artifact targets", () => {
    it("uses Linux artifact names without spaces so latest-linux.yml URLs match uploaded assets", () => {
      const artifactName = pkg.build.linux && pkg.build.linux.artifactName;
      assert.strictEqual(
        typeof artifactName,
        "string",
        "build.linux.artifactName should be a string"
      );
      assert.match(
        artifactName,
        /\$\{arch\}/,
        "Linux artifactName should include ${arch} so architecture-specific assets stay explicit"
      );
      assert.doesNotMatch(
        artifactName,
        /\s/,
        "Linux artifactName should not contain spaces so latest-linux.yml URLs match uploaded assets"
      );
    });
  });

  // Windows shell consumers need a physical icon resource outside app.asar.
  // extraResources provides that canonical runtime copy; the packaged EXE
  // embeds the same build.win.icon and is the fallback if the copy is missing.
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
      for (const key of ["installerIcon", "uninstallerIcon", "installerHeaderIcon"]) {
        assert.strictEqual(
          pkg.build.nsis && pkg.build.nsis[key],
          "assets/icon.ico",
          `build.nsis.${key} should use the canonical Windows icon`
        );
      }
    });

    it("does not duplicate the shell icon inside app.asar", () => {
      assert.strictEqual(
        matchedByAnyGlob(pkg.build.files, "assets/icon.ico"),
        false,
        "assets/icon.ico should be packaged only once via extraResources"
      );
    });
  });

  describe("Telegram legacy retirement packaging", () => {
    it("starts directly without fetching a retired executable", () => {
      assert.strictEqual(pkg.scripts.start, "node launch.js");
    });

    it("contains no retired scripts, prebuild hooks, or extraResources", () => {
      for (const key of [
        "fetch:sidecars",
        "verify:sidecars",
        "assert:packaged-sidecar",
        "prebuild",
        "prebuild:win:x64",
        "prebuild:win:arm64",
        "prebuild:win:all",
        "prebuild:mac",
        "prebuild:linux",
        "prebuild:all",
      ]) {
        assert.equal(pkg.scripts[key], undefined, key);
      }
      for (const platform of ["win", "mac", "linux"]) {
        const entries = pkg.build[platform] && pkg.build[platform].extraResources;
        assert.equal(entries, undefined, `${platform} should not package a Telegram sidecar`);
      }
      assert.deepEqual(pkg.build.extraResources, [{ from: "assets/icon.ico", to: "icon.ico" }]);
    });

    it("declares the asar inspector directly and keeps five target build commands", () => {
      assert.match(pkg.devDependencies["@electron/asar"], /^\^3\./);
      assert.strictEqual(pkg.scripts["build:mac:x64"], "electron-builder --mac dmg:x64");
      assert.strictEqual(pkg.scripts["build:mac:arm64"], "electron-builder --mac dmg:arm64");
      assert.strictEqual(pkg.scripts["build:linux:x64"], "electron-builder --linux AppImage:x64 deb:x64");
    });

    it("release builds assert the retired sidecar is absent from every unpacked tree", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      for (const root of [
        "dist/win-unpacked/resources",
        "dist/win-arm64-unpacked/resources",
        "dist/mac/Clawd on Desk.app/Contents/Resources",
        "dist/mac-arm64/Clawd on Desk.app/Contents/Resources",
        "dist/linux-unpacked/resources",
      ]) {
        assert.match(workflow, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      assert.doesNotMatch(workflow, /fetch:sidecars|verify-sidecar|assert:packaged-sidecar/);
    });

    it("keeps full tag tests while allowing a manual packaging-only evidence run", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      assert.match(workflow, /artifact_validation_only:/);
      assert.strictEqual(
        (workflow.match(/github\.event_name != 'workflow_dispatch' \|\| !inputs\.artifact_validation_only/g) || []).length,
        1,
        "the Windows release job must keep npm test for tag pushes and normal manual runs"
      );
      assert.strictEqual(
        (workflow.match(/github\.event_name == 'workflow_dispatch' && inputs\.artifact_validation_only/g) || []).length,
        1,
        "only the Windows job should substitute the package-validation tests in evidence mode"
      );
      assert.strictEqual(
        (workflow.match(/name: Run package validation tests/g) || []).length,
        1,
      );
      const focusedLine = workflow.split(/\r?\n/).find((line) => line.includes("node --test test/assert-no-retired"));
      assert.ok(focusedLine, "Windows evidence mode should retain its focused test command");
      for (const testFile of [
        "after-pack-koffi.test.js",
        "audit-packaged-native.test.js",
        "koffi-lockfile.test.js",
        "native-package-target.test.js",
        "package-koffi-smoke.test.js",
        "verify-updater-metadata.test.js",
      ]) {
        assert.match(focusedLine, new RegExp(`test/${testFile.replace(/\./g, "\\.")}`));
      }
      assert.strictEqual(
        (workflow.match(/      - run: npm test/g) || []).length,
        3,
        "Windows, macOS, and Linux release jobs must all retain their npm test step"
      );
    });

    it("builds and uploads all five target artifacts in pull-request CI", () => {
      const workflowPath = path.join(ROOT, ".github", "workflows", "telegram-retirement-package-audit.yml");
      assert.ok(fs.existsSync(workflowPath), "five-target package audit workflow should exist");
      const workflow = fs.readFileSync(workflowPath, "utf8");
      assert.match(workflow, /pull_request:/);
      assert.match(workflow, /name: Assert installer exists/);
      assert.match(workflow, /Missing built artifact:/);
      assert.match(workflow, /if-no-files-found: error/);
      for (const target of [
        "windows-x64",
        "windows-arm64",
        "darwin-x64",
        "darwin-arm64",
        "linux-x64",
      ]) {
        assert.match(workflow, new RegExp(`target: ${target}`));
      }
      assert.match(workflow, /name: package-audit-\$\{\{ matrix\.target \}\}/);
      assert.match(workflow, /scripts\/assert-no-retired-telegram-sidecar\.js/);
      assert.match(workflow, /scripts\/audit-packaged-native\.js/);
      assert.match(workflow, /scripts\/run-packaged-koffi-smoke\.js/);
      assert.match(workflow, /name: Configure Linux Chromium sandbox/);
      assert.match(workflow, /if: matrix\.target == 'linux-x64'/);
      assert.match(workflow, /sudo chown root:root dist\/linux-unpacked\/chrome-sandbox/);
      assert.match(workflow, /sudo chmod 4755 dist\/linux-unpacked\/chrome-sandbox/);
      assert.match(workflow, /dist\/koffi-prune-manifests\/\*\.json/);
      assert.match(workflow, /dist\/native-package-manifests\/\*\.json/);
      assert.match(workflow, /runner: windows-11-arm/);
      assert.match(workflow, /runner: macos-15-intel/);
      assert.doesNotMatch(workflow, /fetch:sidecars|verify-sidecar|assert:packaged-sidecar/);
      assert.match(workflow, /Clawd-on-Desk-\*-x86_64\.AppImage/);
      assert.match(workflow, /Clawd-on-Desk-\*-amd64\.deb/);
    });

    it("gates release artifacts on native payload, packaged calls, and updater metadata", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      assert.strictEqual((workflow.match(/scripts\/audit-packaged-native\.js/g) || []).length, 5);
      assert.strictEqual((workflow.match(/scripts\/run-packaged-koffi-smoke\.js/g) || []).length, 3);
      assert.strictEqual((workflow.match(/scripts\/verify-updater-metadata\.js/g) || []).length, 3);
      assert.strictEqual((workflow.match(/if-no-files-found: error/g) || []).length, 3);
      assert.strictEqual((workflow.match(/name: Configure Linux Chromium sandbox/g) || []).length, 1);
      assert.match(workflow, /sudo chown root:root dist\/linux-unpacked\/chrome-sandbox/);
      assert.match(workflow, /sudo chmod 4755 dist\/linux-unpacked\/chrome-sandbox/);
      for (const contract of ["windows", "mac", "linux"]) {
        assert.match(workflow, new RegExp(`--contract ${contract}`));
      }
    });

    it("publishes GitHub releases only for pushed version tags", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      const releaseIndex = findWorkflowJobIndex(workflow, "release");
      assert.ok(releaseIndex >= 0, "workflow should define a release job");
      const releaseGateIndex = workflow.indexOf(
        "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
        releaseIndex,
      );
      const bodyPathIndex = workflow.indexOf("body_path: docs/releases/release-${{ github.ref_name }}.md", releaseIndex);
      assert.ok(releaseGateIndex >= 0, "release job should be gated to pushed v* tags");
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
