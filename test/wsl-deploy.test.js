"use strict";

// Unit tests for src/wsl-deploy.js (agent install script mapping, hooks dir resolution)
// Does NOT require Windows or WSL.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const {
  getAgentInstallScriptName,
  resolveHooksDir,
} = require("../src/wsl-deploy");

describe("wsl-deploy", () => {
  describe("getAgentInstallScriptName", () => {
    it("maps claude-code to install.js", () => {
      assert.strictEqual(getAgentInstallScriptName("claude-code"), "install.js");
    });

    it("maps codex to codex-install.js", () => {
      assert.strictEqual(getAgentInstallScriptName("codex"), "codex-install.js");
    });

    it("maps copilot-cli to copilot-install.js", () => {
      assert.strictEqual(getAgentInstallScriptName("copilot-cli"), "copilot-install.js");
    });

    it("maps gemini-cli to gemini-install.js", () => {
      assert.strictEqual(getAgentInstallScriptName("gemini-cli"), "gemini-install.js");
    });

    it("maps cursor-agent to cursor-install.js", () => {
      assert.strictEqual(getAgentInstallScriptName("cursor-agent"), "cursor-install.js");
    });

    it("returns null for unsupported agents", () => {
      assert.strictEqual(getAgentInstallScriptName("unknown-agent"), null);
      assert.strictEqual(getAgentInstallScriptName(""), null);
    });

    it("excludes agents whose install scripts need non-.js assets", () => {
      // The stdin file pipe only transfers flat .js files; these installers
      // need pi-extension.ts / *-plugin/ directories. See AGENT_INSTALL_SCRIPT.
      assert.strictEqual(getAgentInstallScriptName("pi"), null);
      assert.strictEqual(getAgentInstallScriptName("hermes"), null);
      assert.strictEqual(getAgentInstallScriptName("opencode"), null);
      assert.strictEqual(getAgentInstallScriptName("openclaw"), null);
    });
  });

  describe("getAgentUninstallCommand", () => {
    const { getAgentUninstallCommand } = require("../src/wsl-deploy");

    it("uses uninstall.js for claude-code (install.js has no --uninstall flag)", () => {
      assert.strictEqual(getAgentUninstallCommand("claude-code"), "uninstall.js");
    });

    it("uses <install-script> --uninstall for other agents", () => {
      assert.strictEqual(getAgentUninstallCommand("codex"), "codex-install.js --uninstall");
      assert.strictEqual(getAgentUninstallCommand("kimi-cli"), "kimi-install.js --uninstall");
    });

    it("returns null for unsupported agents", () => {
      assert.strictEqual(getAgentUninstallCommand("unknown-agent"), null);
      assert.strictEqual(getAgentUninstallCommand("pi"), null);
    });
  });

  describe("parseConnectivityProbe", () => {
    const { parseConnectivityProbe } = require("../src/wsl-deploy");

    it("parses REACHABLE with port", () => {
      assert.deepStrictEqual(
        parseConnectivityProbe("REACHABLE 23333\n"),
        { reachable: true, port: 23333 }
      );
    });

    it("ignores login-shell noise around the marker", () => {
      assert.deepStrictEqual(
        parseConnectivityProbe("bash: warning\nREACHABLE 23334\n"),
        { reachable: true, port: 23334 }
      );
    });

    it("parses UNREACHABLE", () => {
      assert.deepStrictEqual(
        parseConnectivityProbe("UNREACHABLE\n"),
        { reachable: false, port: null }
      );
    });

    it("returns unknown for garbage, empty, or missing output", () => {
      assert.deepStrictEqual(parseConnectivityProbe(""), { reachable: null, port: null });
      assert.deepStrictEqual(parseConnectivityProbe(undefined), { reachable: null, port: null });
      assert.deepStrictEqual(parseConnectivityProbe("node: command not found"), { reachable: null, port: null });
    });
  });

  describe("resolveHooksDir", () => {
    it("returns dev path when not packaged", () => {
      const dir = resolveHooksDir({ isPackaged: false });
      assert.ok(dir.endsWith(path.join("src", "..", "hooks")) || dir.endsWith("hooks"));
    });

    it("defaults to dev path when no options", () => {
      const dir = resolveHooksDir();
      assert.ok(typeof dir === "string" && dir.length > 0);
    });
  });
});
