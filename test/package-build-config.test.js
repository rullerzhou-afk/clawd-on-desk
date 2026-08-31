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

function sliceWorkflowBlock(workflow, startMarker, endMarker) {
  const start = workflow.indexOf(startMarker);
  assert.ok(start >= 0, `workflow should contain ${startMarker.trim()}`);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `workflow should contain ${endMarker.trim()} after ${startMarker.trim()}`);
  return workflow.slice(start, end);
}

function sliceWorkflowJob(workflow, jobName) {
  const normalized = workflow.replace(/\r\n/g, "\n");
  const marker = `\n  ${jobName}:\n`;
  const markerIndex = normalized.indexOf(marker);
  assert.ok(markerIndex >= 0, `workflow should contain the ${jobName} job`);
  const start = markerIndex + 1;
  const remainder = normalized.slice(start + marker.length - 1);
  const nextJob = remainder.search(/\n  [a-zA-Z0-9_-]+:\n/);
  return nextJob === -1
    ? normalized.slice(start)
    : normalized.slice(start, start + marker.length - 1 + nextJob);
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
      for (const testFile of [
        "test/mac-dock-icon-runtime.test.js",
        "test/mac-dock-visibility.test.js",
        "test/mac-tray-icon-assets.test.js",
        "test/main-mac-dock-icon.test.js",
        "test/menu-hide-pet.test.js",
        "test/tray-flash-icon.test.js",
      ]) {
        assert.ok(workflow.includes(testFile), `repository asset audit should run ${testFile}`);
      }
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
    function getMacTarget(name) {
      const targets = pkg.build.mac && pkg.build.mac.target;
      return Array.isArray(targets) ? targets.find((target) => target && target.target === name) : null;
    }

    it("builds native macOS DMGs for x64 and arm64", () => {
      const target = getMacTarget("dmg");
      assert.ok(target, "build.mac.target should include a dmg target");
      assert.deepStrictEqual(
        target.arch.slice().sort(),
        ["x64", "arm64"].slice().sort(),
        "macOS builds should publish both x64 and ARM64 DMGs"
      );
    });

    it("builds native macOS updater ZIPs for x64 and arm64", () => {
      const target = getMacTarget("zip");
      assert.ok(target, "build.mac.target should include a zip target");
      assert.deepStrictEqual(
        target.arch.slice().sort(),
        ["x64", "arm64"].slice().sort(),
        "macOS builds should publish both x64 and ARM64 updater ZIPs"
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
      const adHocVerification = sliceWorkflowBlock(
        workflow,
        "      - name: Verify macOS ad-hoc hardened signatures",
        "      - name: Assert retired Telegram sidecar is absent",
      );
      assert.match(adHocVerification, /^\s+if: steps\.mac-signing\.outputs\.mode == 'adhoc'$/m);
      assert.match(adHocVerification, /dist\/mac\/Clawd on Desk\.app/);
      assert.match(adHocVerification, /dist\/mac-arm64\/Clawd on Desk\.app/);
      assert.match(adHocVerification, /Signature=adhoc/);
      assert.match(adHocVerification, /adhoc,runtime/);
      assert.match(adHocVerification, /codesign --verify --deep --strict/);
      for (const entitlement of [
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
        "com.apple.security.cs.disable-library-validation",
      ]) {
        assert.match(adHocVerification, new RegExp(entitlement.replace(/\./g, "\\.")));
      }
      assert.match(adHocVerification, /entitlement_key="\$\{entitlement\/\/\.\/\\\\\.\}"/);
      assert.match(adHocVerification, /\/usr\/bin\/plutil -extract "\$entitlement_key" raw -o -/);
      assert.match(adHocVerification, /!= "true"/);
    });

    it("fails closed for tag releases unless all Developer ID secrets are present", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      const prepareSigning = sliceWorkflowBlock(
        workflow,
        "      - name: Prepare macOS signing credentials",
        "      - name: Build macOS (Developer ID signed and notarized)",
      );
      const developerBuild = sliceWorkflowBlock(
        workflow,
        "      - name: Build macOS (Developer ID signed and notarized)",
        "      - name: Build macOS (ad-hoc manual validation only)",
      );
      assert.match(
        workflow,
        /^permissions:\r?\n  contents: read$/m,
        "build jobs should not receive a write-capable token alongside signing secrets",
      );
      for (const secret of [
        "CSC_LINK",
        "CSC_KEY_PASSWORD",
        "APPLE_API_KEY",
        "APPLE_API_KEY_ID",
        "APPLE_API_ISSUER",
      ]) {
        assert.match(workflow, new RegExp(`secrets\\.${secret}`));
      }
      assert.match(prepareSigning, /present != 5/);
      assert.match(
        prepareSigning,
        /if \[\[ "\$GITHUB_EVENT_NAME" == "push" && "\$GITHUB_REF" == refs\/tags\/v\* \]\]; then\s+echo "::error::A tag release requires all macOS signing and notarization secrets\.[^"]*"\s+exit 1\s+fi/,
        "a pushed v* tag without signing secrets must terminate before the ad-hoc fallback",
      );
      assert.match(prepareSigning, /Incomplete macOS signing configuration/);
      assert.match(prepareSigning, /openssl pkey -in "\$api_key_path" -noout/);
      assert.match(prepareSigning, /has_non_whitespace\(\)/);
      assert.match(prepareSigning, /APPLE_API_KEY_ID must not contain spaces or line breaks/);
      assert.match(prepareSigning, /APPLE_API_ISSUER must not contain spaces or line breaks/);
      assert.match(prepareSigning, /EXPECTED_APPLE_TEAM_ID: \$\{\{ vars\.APPLE_TEAM_ID \}\}/);
      assert.match(prepareSigning, /EXPECTED_APPLE_TEAM_ID.*\^\[A-Z0-9\]\{10\}\$/);
      const keyPathOutput = prepareSigning.indexOf('echo "api_key_path=$api_key_path" >> "$GITHUB_OUTPUT"');
      const keyDecode = prepareSigning.indexOf("base64 --decode");
      assert.ok(keyPathOutput >= 0 && keyPathOutput < keyDecode, "cleanup path must be published before decoding can fail");
      assert.match(developerBuild, /-c\.mac\.identity="Developer ID Application"/);
      assert.match(developerBuild, /-c\.forceCodeSigning=true/);
      assert.match(developerBuild, /APPLE_API_KEY: \$\{\{ steps\.mac-signing\.outputs\.api_key_path \}\}/);
    });

    it("always removes the decoded notarization key before artifact verification", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      const keyCleanup = sliceWorkflowBlock(
        workflow,
        "      - name: Remove decoded notarization key",
        "      - name: Verify macOS Developer ID artifacts",
      );
      assert.match(
        keyCleanup,
        /^\s+if: \$\{\{ always\(\) && steps\.mac-signing\.outputs\.api_key_path != '' \}\}$/m,
      );
      assert.match(keyCleanup, /APPLE_API_KEY_FILE: \$\{\{ steps\.mac-signing\.outputs\.api_key_path \}\}/);
      assert.match(keyCleanup, /run: rm -f -- "\$APPLE_API_KEY_FILE"/);
    });

    it("verifies the notarized app inside each final DMG without post-build DMG mutation", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      const developerVerification = sliceWorkflowBlock(
        workflow,
        "      - name: Verify macOS Developer ID artifacts",
        "      - name: Verify macOS ad-hoc hardened signatures",
      );
      assert.match(developerVerification, /^\s+if: steps\.mac-signing\.outputs\.mode == 'developer-id'$/m);
      assert.match(developerVerification, /Authority=Developer ID Application:/);
      assert.ok(
        developerVerification.includes('^Authority=Developer ID Application: .+ \\($EXPECTED_APPLE_TEAM_ID\\)$'),
        "Developer ID verification should lock the Authority suffix to the expected team",
      );
      assert.match(developerVerification, /TeamIdentifier=\$EXPECTED_APPLE_TEAM_ID/);
      assert.match(developerVerification, /entitlement_key="\$\{entitlement\/\/\.\/\\\\\.\}"/);
      assert.match(developerVerification, /\/usr\/bin\/plutil -extract "\$entitlement_key" raw -o -/);
      assert.match(developerVerification, /!= "true"/);
      assert.match(developerVerification, /spctl --assess --type execute/);
      assert.match(developerVerification, /xcrun stapler validate "\$app"/);
      assert.strictEqual(
        (developerVerification.match(/^\s+verify_signed_app "dist\/mac\/Clawd on Desk\.app"$/gm) || []).length,
        1,
        "Developer ID verification must inspect the unpacked x64 app exactly once",
      );
      assert.strictEqual(
        (developerVerification.match(/^\s+verify_signed_app "dist\/mac-arm64\/Clawd on Desk\.app"$/gm) || []).length,
        1,
        "Developer ID verification must inspect the unpacked arm64 app exactly once",
      );
      assert.match(developerVerification, /for arch in x64 arm64/);
      assert.match(developerVerification, /hdiutil verify "\$dmg"/);
      assert.match(developerVerification, /hdiutil attach -readonly -nobrowse -mountpoint/);
      assert.match(developerVerification, /verify_signed_app "\$active_mount\/Clawd on Desk\.app"/);
      assert.doesNotMatch(workflow, /notarytool submit[^\n]*\.dmg/);
      assert.doesNotMatch(workflow, /stapler staple[^\n]*\.dmg/);
    });

    it("verifies ZIP payloads and gates every required macOS release file twice", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      const zipVerification = sliceWorkflowBlock(
        workflow,
        "      - name: Verify macOS ZIP payloads",
        "      - name: Assert retired Telegram sidecar is absent",
      );
      assert.match(zipVerification, /ditto -x -k/);
      assert.match(zipVerification, /ZIP must contain exactly Clawd on Desk\.app at its root/);
      assert.match(zipVerification, /codesign --verify --deep --strict/);
      assert.match(zipVerification, /spctl --assess --type execute/);
      assert.match(zipVerification, /xcrun stapler validate/);
      assert.match(zipVerification, /scripts\/audit-packaged-native\.js/);

      const buildGate = sliceWorkflowBlock(
        workflow,
        "      - name: Assert macOS updater release files",
        "      - name: Verify macOS updater metadata",
      );
      const releaseGate = sliceWorkflowBlock(
        workflow,
        "      - name: Assert macOS release files before draft creation",
        "      - uses: softprops/action-gh-release@v2",
      );
      for (const filename of [
        "Clawd-on-Desk-$version-x64.dmg",
        "Clawd-on-Desk-$version-arm64.dmg",
        "Clawd-on-Desk-$version-x64.zip",
        "Clawd-on-Desk-$version-arm64.zip",
        "Clawd-on-Desk-$version-x64.zip.blockmap",
        "Clawd-on-Desk-$version-arm64.zip.blockmap",
        "latest-mac.yml",
      ]) {
        assert.ok(buildGate.includes(`\"${filename}\"`), `build gate must require ${filename}`);
        assert.ok(releaseGate.includes(`\"${filename}\"`), `release gate must require ${filename}`);
      }
      assert.match(buildGate, /if \(\( \$\{#actual_files\[@\]\} != 7 \)\); then/);
      assert.match(releaseGate, /if \(\( \$\{#actual_files\[@\]\} != 7 \)\); then/);

      const installerUpload = sliceWorkflowBlock(
        workflow,
        "          name: mac-installer",
        "      - uses: actions/upload-artifact@v4",
      );
      assert.match(installerUpload, /dist\/\*\.dmg/);
      assert.match(installerUpload, /dist\/\*\.zip$/m);
      assert.match(installerUpload, /dist\/\*\.zip\.blockmap/);
      assert.match(installerUpload, /dist\/latest-mac\.yml/);
      assert.match(installerUpload, /if-no-files-found: error/);
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
      assert.strictEqual(pkg.scripts["build:mac:x64"], "electron-builder --mac dmg:x64 zip:x64");
      assert.strictEqual(pkg.scripts["build:mac:arm64"], "electron-builder --mac dmg:arm64 zip:arm64");
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
      const workflow = fs
        .readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8")
        .replace(/\r\n/g, "\n");
      assert.match(workflow, /artifact_validation_only:/);
      const getJobBlock = (jobName) => {
        const marker = `  ${jobName}:\n`;
        const start = workflow.indexOf(marker);
        assert.notStrictEqual(start, -1, `${jobName} should exist`);
        const remainder = workflow.slice(start + marker.length);
        const nextJob = remainder.search(/\n  [a-zA-Z0-9_-]+:\n/);
        return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
      };

      for (const [label, jobName, fullCommand, focusedPrefix] of [
        ["Windows", "build-windows", "npm test", "node --test"],
        ["macOS", "build-mac", "npm test", "node --test"],
        ["Linux", "build-linux", "xvfb-run -a npm test", "xvfb-run -a node --test"],
      ]) {
        const job = getJobBlock(jobName);
        assert.ok(
          job.includes([
            `      - run: ${fullCommand}`,
            "        if: ${{ github.event_name != 'workflow_dispatch' || !inputs.artifact_validation_only }}",
          ].join("\n")),
          `${label} must keep its full test command for tag pushes and normal manual runs`
        );
        assert.ok(
          job.includes([
            "      - name: Run package validation tests",
            "        if: ${{ github.event_name == 'workflow_dispatch' && inputs.artifact_validation_only }}",
            "        run: ",
          ].join("\n")),
          `${label} must substitute focused tests only in evidence mode`
        );
        const focusedLine = job
          .split(/\r?\n/)
          .find((line) => line.includes("node --test test/assert-no-retired"));
        assert.ok(focusedLine, `${label} evidence mode should retain its focused test command`);
        assert.ok(focusedLine.includes(focusedPrefix), `${label} should use the expected focused-test wrapper`);
        for (const testFile of [
          "after-pack-koffi.test.js",
          "audit-packaged-native.test.js",
          "koffi-lockfile.test.js",
          "native-package-target.test.js",
          "package-koffi-smoke.test.js",
          "verify-updater-metadata.test.js",
        ]) {
          assert.ok(focusedLine.includes(`test/${testFile}`));
        }
      }
    });

    it("builds and uploads all five target artifacts in pull-request and release CI", () => {
      const workflowPath = path.join(ROOT, ".github", "workflows", "telegram-retirement-package-audit.yml");
      assert.ok(fs.existsSync(workflowPath), "five-target package audit workflow should exist");
      const workflow = fs.readFileSync(workflowPath, "utf8");
      assert.match(workflow, /workflow_call:/);
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
      assert.match(workflow, /- "src\/recap-\*\.js"/);
      assert.match(workflow, /- "src\/settings-ui-core\.js"/);
      assert.match(workflow, /- "src\/settings-tab-recap\.js"/);
      assert.match(workflow, /- "test\/recap\*\.test\.js"/);
      assert.match(workflow, /- "test\/fixtures\/recap-private-permissions-\*\.js"/);
      assert.match(workflow, /- "test\/settings-recap\.test\.js"/);
      assert.match(workflow, /name: Run recap unit tests[\s\S]*?test\/recap\*\.test\.js[\s\S]*?test\/settings-recap\.test\.js/);
      const packageJob = sliceWorkflowJob(workflow, "package");
      assert.match(packageJob, /runs-on: \$\{\{ matrix\.runner \}\}/);
      assert.match(packageJob, /name: Run Windows recap ACL tests\s+if: runner\.os == 'Windows'/);
      for (const testFile of [
        "test/recap-private-permissions.test.js",
        "test/recap-private-permissions-electron.test.js",
        "test/recap-runtime.test.js",
        "test/recap-store.test.js",
      ]) {
        assert.ok(packageJob.includes(testFile), `Windows package job should run ${testFile}`);
      }
      assert.doesNotMatch(workflow, /fetch:sidecars|verify-sidecar|assert:packaged-sidecar/);
      assert.match(workflow, /Clawd-on-Desk-\*-x86_64\.AppImage/);
      assert.match(workflow, /Clawd-on-Desk-\*-amd64\.deb/);
    });

    it("gates release artifacts on native payload, packaged calls, and updater metadata", () => {
      const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
      assert.match(workflow, /native-package-audit:\s+needs: validate-release\s+uses: \.\/\.github\/workflows\/telegram-retirement-package-audit\.yml/);
      assert.match(workflow, /needs: \[build-windows, build-mac, build-linux, native-package-audit\]/);
      assert.strictEqual((workflow.match(/scripts\/audit-packaged-native\.js/g) || []).length, 6);
      assert.strictEqual((workflow.match(/scripts\/run-packaged-koffi-smoke\.js/g) || []).length, 3);
      assert.strictEqual((workflow.match(/scripts\/verify-updater-metadata\.js/g) || []).length, 3);
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
