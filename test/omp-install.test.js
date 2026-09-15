"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ompInstall = require("../hooks/omp-install");
const piInstall = require("../hooks/pi-install");

describe("omp-install", () => {
  let parentDir;
  let extensionsDir;
  let extensionDir;

  beforeEach(() => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-omp-install-"));
    extensionsDir = path.join(parentDir, "extensions");
    extensionDir = path.join(extensionsDir, "clawd-on-desk");
    fs.mkdirSync(extensionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  const install = (options = {}) =>
    ompInstall.registerOmpExtension({ parentDir, silent: true, ...options });
  const uninstall = (options = {}) =>
    ompInstall.unregisterOmpExtension({ parentDir, silent: true, ...options });
  const readMarker = () =>
    JSON.parse(fs.readFileSync(path.join(extensionDir, ompInstall.MARKER_FILE), "utf8"));

  describe("paths", () => {
    it("installs under ~/.omp, never ~/.pi", () => {
      assert.ok(ompInstall.DEFAULT_PARENT_DIR.endsWith(path.join(".omp", "agent")));
      assert.notStrictEqual(ompInstall.DEFAULT_PARENT_DIR, piInstall.DEFAULT_PARENT_DIR);
      assert.notStrictEqual(ompInstall.DEFAULT_EXTENSION_DIR, piInstall.DEFAULT_EXTENSION_DIR);
      assert.strictEqual(ompInstall.CORE_FILE, "omp-extension-core.js");
    });
  });

  describe("install", () => {
    it("writes the extension, its core and a managed marker", () => {
      const result = install();
      assert.strictEqual(result.installed, true);
      assert.strictEqual(result.updated, true);

      assert.deepStrictEqual(
        fs.readdirSync(extensionDir).sort(),
        [ompInstall.MARKER_FILE, ompInstall.CORE_FILE, ompInstall.EXTENSION_FILE].sort()
      );
      const marker = readMarker();
      assert.strictEqual(marker.integration, "omp");
      assert.strictEqual(marker.managed, true);

      // The installed entry point must pull in the OMP core, not Pi's.
      const entry = fs.readFileSync(path.join(extensionDir, ompInstall.EXTENSION_FILE), "utf8");
      assert.ok(entry.includes("omp-extension-core.js"));
      assert.ok(!entry.includes("pi-extension-core.js"));
      assert.ok(entry.includes("@oh-my-pi/pi-coding-agent"));
    });

    it("is idempotent", () => {
      install();
      const second = install();
      assert.strictEqual(second.installed, true);
      assert.strictEqual(second.updated, false, "an unchanged reinstall is not an update");
    });

    it("reports an update when the shipped source changes", () => {
      install();
      fs.writeFileSync(path.join(extensionDir, ompInstall.EXTENSION_FILE), "// stale\n");
      assert.strictEqual(install().updated, true);
    });

    it("skips when OMP is not installed and no extensions tree exists", () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-omp-absent-"));
      try {
        const result = ompInstall.registerOmpExtension({
          parentDir: path.join(empty, "agent"),
          silent: true,
          ompCommandAvailable: false,
        });
        assert.strictEqual(result.installed, false);
        assert.strictEqual(result.reason, "omp-not-found");
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  // The community bridge (github.com/Crosery/clawd-on-desk-omp) is a single
  // sibling file reporting the same events through the custom-application
  // channel. Installing alongside it would make OMP load both and POST twice.
  describe("community bridge", () => {
    const bridgePath = () => path.join(extensionsDir, ompInstall.STANDALONE_BRIDGE_FILE);

    it("refuses to install next to it", () => {
      fs.writeFileSync(bridgePath(), "// clawd-on-desk-omp\n");
      const result = install();
      assert.strictEqual(result.installed, false);
      assert.strictEqual(result.reason, "standalone-bridge-present");
      assert.strictEqual(result.standaloneBridge, bridgePath());
      assert.ok(!fs.existsSync(extensionDir), "nothing may be written while it is present");
    });

    it("installs once it is removed", () => {
      fs.writeFileSync(bridgePath(), "// clawd-on-desk-omp\n");
      assert.strictEqual(install().installed, false);
      fs.unlinkSync(bridgePath());
      assert.strictEqual(install().installed, true);
    });

    it("finds it only as a direct sibling of the extension directory", () => {
      assert.strictEqual(ompInstall.findStandaloneBridge({ parentDir }), null);
      fs.writeFileSync(bridgePath(), "// bridge\n");
      assert.strictEqual(ompInstall.findStandaloneBridge({ parentDir }), bridgePath());
    });

    // The other order: Clawd installs first and the bridge arrives later. Both
    // report the same events, so the copy Clawd wrote has to go.
    it("retires Clawd's own copy when the bridge appears afterwards", () => {
      assert.strictEqual(install().installed, true);
      const installedEntry = fs.readFileSync(path.join(extensionDir, ompInstall.EXTENSION_FILE), "utf8");

      fs.writeFileSync(bridgePath(), "// clawd-on-desk-omp\n");
      const result = install();

      assert.strictEqual(result.reason, "standalone-bridge-present");
      assert.strictEqual(result.removedOwnCopy, true);
      assert.ok(!fs.existsSync(extensionDir),
        "OMP would load both copies and POST twice for every event");
      assert.ok(fs.existsSync(bridgePath()), "the user's bridge must be left alone");
      assert.ok(installedEntry.length > 0);
    });

    it("leaves a foreign directory in place when the bridge is present", () => {
      // Not ours: Clawd must not delete files it did not write, even though the
      // duplicate-reporting hazard is the same.
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "index.ts"), "// someone else's\n");
      fs.writeFileSync(bridgePath(), "// clawd-on-desk-omp\n");

      const result = install();

      assert.strictEqual(result.reason, "standalone-bridge-present");
      assert.strictEqual(result.removedOwnCopy, false);
      assert.strictEqual(
        fs.readFileSync(path.join(extensionDir, "index.ts"), "utf8"),
        "// someone else's\n"
      );
    });
  });

  describe("ownership", () => {
    it("never clobbers an extension directory Clawd does not own", () => {
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "index.ts"), "// someone else's\n");

      const result = install();
      assert.strictEqual(result.installed, false);
      assert.strictEqual(result.reason, "unmanaged-existing-extension");
      assert.strictEqual(
        fs.readFileSync(path.join(extensionDir, "index.ts"), "utf8"),
        "// someone else's\n"
      );
    });

    it("does not accept Pi's marker as its own", () => {
      assert.strictEqual(ompInstall.isManagedMarker(ompInstall.buildMarker()), true);
      assert.strictEqual(
        ompInstall.isManagedMarker(piInstall.buildMarker()),
        false,
        "a Pi-managed directory must not be treated as OMP's"
      );
      assert.strictEqual(piInstall.isManagedMarker(ompInstall.buildMarker()), false);
    });
  });

  describe("uninstall", () => {
    it("removes a Clawd-managed extension", () => {
      install();
      const result = uninstall();
      assert.strictEqual(result.removed, true);
      assert.ok(!fs.existsSync(extensionDir));
    });

    it("leaves an unmanaged directory alone", () => {
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "index.ts"), "// someone else's\n");
      const result = uninstall();
      assert.strictEqual(result.removed, false);
      assert.strictEqual(result.reason, "unmanaged-existing-extension");
      assert.ok(fs.existsSync(path.join(extensionDir, "index.ts")));
    });

    it("reports a missing extension without failing", () => {
      const result = uninstall();
      assert.strictEqual(result.removed, false);
      assert.strictEqual(result.reason, "missing");
    });
  });

  // OMP resolves the extension directory through the ACTIVE agent directory, so
  // a fixed path installs "successfully" into a tree no OMP session reads.
  describe("agent directory resolution", () => {
    let homeDir;
    beforeEach(() => {
      homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-omp-home-"));
    });
    afterEach(() => {
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    const resolve = (env) => ompInstall.resolveOmpAgentDir({ homeDir, env });
    const extensionDirFor = (env) => ompInstall.resolveExtensionDir({ homeDir, env });

    it("defaults to <home>/.omp/agent with no environment", () => {
      assert.strictEqual(resolve({}), path.join(homeDir, ".omp", "agent"));
      assert.strictEqual(
        extensionDirFor({}),
        path.join(homeDir, ".omp", "agent", "extensions", "clawd-on-desk")
      );
    });

    it("follows PI_CODING_AGENT_DIR when no profile is active", () => {
      const elsewhere = path.join(homeDir, "custom-agent-dir");
      assert.strictEqual(resolve({ PI_CODING_AGENT_DIR: elsewhere }), elsewhere);
      assert.strictEqual(extensionDirFor({ PI_CODING_AGENT_DIR: elsewhere }),
        path.join(elsewhere, "extensions", "clawd-on-desk"));
    });

    it("follows a named profile, and derives it from PI_PROFILE when OMP_PROFILE is unset", () => {
      assert.strictEqual(
        resolve({ OMP_PROFILE: "work" }),
        path.join(homeDir, ".omp", "profiles", "work", "agent")
      );
      assert.strictEqual(
        resolve({ PI_PROFILE: "work" }),
        path.join(homeDir, ".omp", "profiles", "work", "agent")
      );
      assert.strictEqual(
        resolve({ OMP_PROFILE: "omp-one", PI_PROFILE: "pi-one" }),
        path.join(homeDir, ".omp", "profiles", "omp-one", "agent"),
        "OMP_PROFILE outranks PI_PROFILE"
      );
    });

    it("ignores PI_CODING_AGENT_DIR while a profile is active", () => {
      // OMP's own resolver returns no agentDirOverride when a profile is set,
      // so the profile's directory wins over the override.
      const elsewhere = path.join(homeDir, "custom-agent-dir");
      assert.strictEqual(
        resolve({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: elsewhere }),
        path.join(homeDir, ".omp", "profiles", "work", "agent")
      );
    });

    it("moves the config root with PI_CONFIG_DIR, keeping it under the home directory", () => {
      assert.strictEqual(resolve({ PI_CONFIG_DIR: "omp-alt" }), path.join(homeDir, "omp-alt", "agent"));
      assert.strictEqual(
        resolve({ PI_CONFIG_DIR: "omp-alt", OMP_PROFILE: "work" }),
        path.join(homeDir, "omp-alt", "profiles", "work", "agent")
      );
      // OMP joins the value under the home directory even when it looks
      // absolute, so a configured path must never escape it.
      assert.strictEqual(
        resolve({ PI_CONFIG_DIR: path.join(path.sep, "abs", "escape") }),
        path.join(homeDir, "abs", "escape", "agent")
      );
    });

    it("ignores a profile name OMP itself would reject", () => {
      const defaultDir = path.join(homeDir, ".omp", "agent");
      for (const invalid of ["..", ".", "work.", "Work", "with space", "con", "LPT1", "-leading"]) {
        assert.strictEqual(resolve({ OMP_PROFILE: invalid }), defaultDir, `profile ${invalid}`);
      }
    });

    it("installs into the resolved directory, not the default one", () => {
      const result = ompInstall.registerOmpExtension({
        homeDir,
        env: { OMP_PROFILE: "work" },
        silent: true,
        ompCommandAvailable: true,
      });

      assert.strictEqual(result.installed, true);
      const profileExtensionDir = path.join(
        homeDir, ".omp", "profiles", "work", "agent", "extensions", "clawd-on-desk"
      );
      assert.strictEqual(result.extensionDir, profileExtensionDir);
      assert.ok(fs.existsSync(path.join(profileExtensionDir, ompInstall.EXTENSION_FILE)));
      assert.ok(!fs.existsSync(path.join(homeDir, ".omp", "agent")),
        "the default tree must not be created when a profile is active");
    });

    it("names the other profiles it does not manage", () => {
      const profilesDir = path.join(homeDir, ".omp", "profiles");
      for (const name of ["work", "personal"]) {
        fs.mkdirSync(path.join(profilesDir, name, "agent"), { recursive: true });
      }
      // A profiles entry without an agent directory is not an install target.
      fs.mkdirSync(path.join(profilesDir, "empty"), { recursive: true });

      assert.deepStrictEqual(
        ompInstall.listOtherOmpProfileAgentDirs({ homeDir, env: {} })
          .map((entry) => entry.profile),
        ["personal", "work"]
      );
      // The profile Clawd resolved for itself is not "other".
      assert.deepStrictEqual(
        ompInstall.listOtherOmpProfileAgentDirs({ homeDir, env: { OMP_PROFILE: "work" } })
          .map((entry) => entry.profile),
        ["personal"]
      );
    });

    it("reports no other profiles when none exist", () => {
      assert.deepStrictEqual(ompInstall.listOtherOmpProfileAgentDirs({ homeDir, env: {} }), []);
    });
  });
});
