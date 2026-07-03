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
