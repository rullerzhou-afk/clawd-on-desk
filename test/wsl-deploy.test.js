"use strict";

// Unit tests for src/wsl-deploy.js (agent install script mapping, hooks dir resolution)
// Does NOT require Windows or WSL.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("path");
const { builtinModules } = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  HERMES_RESULT_SENTINEL,
  HERMES_TEMP_SENTINEL,
  HERMES_WSL_FILES,
  collectAgentWslFiles,
  createHermesTempDir,
  deployToWsl,
  getAgentInstallArgs,
  getAgentInstallScriptName,
  parseHermesInstallerResult,
  parseHermesTempDir,
  pipeFileToWsl,
  removeFromWsl,
  resolveHooksDir,
  validateDeployRelativePath,
} = require("../src/wsl-deploy");

const HOOKS_DIR = path.join(__dirname, "..", "hooks");

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

    it("supports Hermes without enabling other unvalidated asset-backed agents", () => {
      assert.strictEqual(getAgentInstallScriptName("pi"), null);
      assert.strictEqual(getAgentInstallScriptName("hermes"), "hermes-install.js");
      assert.strictEqual(getAgentInstallScriptName("opencode"), null);
      assert.strictEqual(getAgentInstallScriptName("openclaw"), null);
    });

    it("excludes workbuddy (no standalone Linux/WSL runtime)", () => {
      // WorkBuddy ships only as a macOS/Windows Electron desktop app, so there
      // is no in-WSL settings.json to deploy hooks into. See AGENT_INSTALL_SCRIPT.
      assert.strictEqual(getAgentInstallScriptName("workbuddy"), null);
    });

    it("excludes qwenwork (macOS/Windows desktop-only, no Linux client)", () => {
      // #843: https://qwenwork.cn/download offers macOS 14+, Windows 10+ and
      // HarmonyOS 6.1+ — no Linux build, and the PR's own verification covered
      // macOS and Windows only. Mapping it would expose a WSL Pair entry that
      // writes ~/.QwenWorkCN/settings.json inside the distro HOME, which the
      // Windows QwenWork desktop app never reads: hooks that can never fire,
      // and an Unpair the user has to discover on their own.
      const { getAgentUninstallCommand } = require("../src/wsl-deploy");
      assert.strictEqual(getAgentInstallScriptName("qwenwork"), null);
      assert.strictEqual(getAgentUninstallCommand("qwenwork"), null);
      // QoderWork (the integration this one was modeled on) stays supported —
      // this is a QwenWork-specific platform boundary, not a category rule.
      assert.strictEqual(getAgentInstallScriptName("qoderwork"), "qoderwork-install.js");
    });
  });

  describe("getAgentInstallArgs", () => {
    it("keeps the in-app Claude WSL deploy transcript-only (no automatic statusline)", () => {
      assert.strictEqual(getAgentInstallArgs("claude-code"), "");
    });

    it("explicitly preserves CodeBuddy's existing permission target", () => {
      assert.strictEqual(getAgentInstallArgs("codebuddy"), "--permission-url preserve");
      assert.strictEqual(getAgentInstallArgs("codex"), "");
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
      assert.strictEqual(getAgentUninstallCommand("hermes"), "hermes-install.js --uninstall");
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

    it("accepts an injected packaged resources path", () => {
      assert.strictEqual(
        resolveHooksDir({ isPackaged: true, resourcesPath: "C:\\Clawd\\resources" }),
        path.join("C:\\Clawd\\resources", "app.asar.unpacked", "hooks")
      );
    });
  });

  describe("Hermes exact WSL payload", () => {
    it("contains exactly the audited six files as Buffers", () => {
      const entries = collectAgentWslFiles(HOOKS_DIR, "hermes");
      assert.deepStrictEqual(entries.map((entry) => entry.relativePath), [...HERMES_WSL_FILES]);
      assert.ok(entries.every((entry) => Buffer.isBuffer(entry.content)));
    });

    it("matches the installer managed-file manifest", () => {
      const { MANAGED_PLUGIN_FILES } = require("../hooks/hermes-install");
      const pluginFiles = HERMES_WSL_FILES
        .filter((name) => name.startsWith("hermes-plugin/"))
        .map((name) => path.posix.basename(name));
      assert.deepStrictEqual(pluginFiles.sort(), [...MANAGED_PLUGIN_FILES].sort());
    });

    it("is transitively closed over relative requires and uses only Node builtins", () => {
      const deployed = new Set(HERMES_WSL_FILES);
      const builtinRoots = new Set(builtinModules.map((name) => name.replace(/^node:/, "").split("/")[0]));
      for (const relativePath of HERMES_WSL_FILES.filter((name) => name.endsWith(".js"))) {
        const source = fs.readFileSync(path.join(HOOKS_DIR, ...relativePath.split("/")), "utf8");
        for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
          const specifier = match[1];
          if (specifier.startsWith(".")) {
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier));
            const withExtension = resolved.endsWith(".js") ? resolved : `${resolved}.js`;
            assert.ok(deployed.has(withExtension), `${relativePath} requires missing ${withExtension}`);
          } else {
            const root = specifier.replace(/^node:/, "").split("/")[0];
            assert.ok(builtinRoots.has(root), `${relativePath} requires non-builtin ${specifier}`);
          }
        }
      }
    });

    it("rejects unsafe relative paths", () => {
      for (const value of ["", "/tmp/x", "../x", "a/../x", "a\\x", "a\0x", "a//x"]) {
        assert.throws(() => validateDeployRelativePath(value));
      }
      assert.strictEqual(validateDeployRelativePath("hermes-plugin/plugin.yaml"), "hermes-plugin/plugin.yaml");
    });

    it("pipes nested payload bytes without text conversion", async () => {
      const calls = [];
      const payload = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
      const spawn = (_command, args) => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stderr = new PassThrough();
        const chunks = [];
        child.stdin.on("data", (chunk) => chunks.push(chunk));
        child.stdin.on("finish", () => {
          calls.push({ args, content: Buffer.concat(chunks) });
          queueMicrotask(() => child.emit("close", 0));
        });
        child.kill = () => {};
        return child;
      };

      const result = await pipeFileToWsl(
        "Ubuntu",
        "/tmp/clawd-hermes-Ab12Cd34",
        "hermes-plugin/plugin.yaml",
        payload,
        { spawn, timeout: 1000 }
      );

      assert.strictEqual(result.ok, true);
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].content, payload);
      assert.match(calls[0].args.at(-1), /mkdir -p -- '\/tmp\/clawd-hermes-Ab12Cd34\/hermes-plugin'/);
      assert.match(calls[0].args.at(-1), /cat > '\/tmp\/clawd-hermes-Ab12Cd34\/hermes-plugin\/plugin.yaml'/);
    });
  });

  describe("Hermes staging/result parsing", () => {
    it("accepts only the fixed /tmp template result", () => {
      assert.strictEqual(
        parseHermesTempDir(`${HERMES_TEMP_SENTINEL}/tmp/clawd-hermes-Ab12Cd34\n`),
        "/tmp/clawd-hermes-Ab12Cd34"
      );
      for (const output of [
        "",
        `${HERMES_TEMP_SENTINEL}/`,
        `${HERMES_TEMP_SENTINEL}/home/tester`,
        `${HERMES_TEMP_SENTINEL}/var/tmp/clawd-hermes-Ab12Cd34`,
        `${HERMES_TEMP_SENTINEL}/tmp/wrong-Ab12Cd34`,
        `noise\n${HERMES_TEMP_SENTINEL}/tmp/clawd-hermes-Ab12Cd34`,
      ]) assert.strictEqual(parseHermesTempDir(output), null);
    });

    it("parses one versioned installer result and rejects ambiguity", () => {
      const wire = { schemaVersion: 1, operation: "install", status: "warning", message: "partial" };
      const parsed = parseHermesInstallerResult(`${HERMES_RESULT_SENTINEL}${JSON.stringify(wire)}\n`, "install");
      assert.strictEqual(parsed.ok, true);
      assert.deepStrictEqual(parsed.result, wire);
      assert.strictEqual(parseHermesInstallerResult("", "install").ok, false);
      assert.strictEqual(
        parseHermesInstallerResult(`${HERMES_RESULT_SENTINEL}${JSON.stringify(wire)}\n${HERMES_RESULT_SENTINEL}${JSON.stringify(wire)}`, "install").ok,
        false
      );
    });

    it("creates staging without a shell-local variable that wsl.exe can pre-expand", async () => {
      let command = null;
      const result = await createHermesTempDir("Ubuntu", {
        execInWsl: async (_distro, value) => {
          command = value;
          return { code: 0, stdout: `${HERMES_TEMP_SENTINEL}/tmp/clawd-hermes-Ab12Cd34\n`, stderr: "" };
        },
      });
      assert.strictEqual(result.ok, true);
      assert.doesNotMatch(command, /\$[A-Za-z_]/);
      assert.match(command, /set -o pipefail/);
      assert.match(command, /mktemp -d \/tmp\/clawd-hermes-XXXXXXXX/);
    });
  });

  describe("Hermes ephemeral orchestration", () => {
    it("pairs and unpairs from fresh private staging without resolving WSL home", async () => {
      const calls = [];
      const uploads = [];
      const execInWsl = async (_distro, command) => {
        calls.push(command);
        if (command.includes("mktemp -d")) {
          return { code: 0, stdout: `${HERMES_TEMP_SENTINEL}/tmp/clawd-hermes-Ab12Cd34\n`, stderr: "" };
        }
        if (command.includes("--uninstall --json")) {
          return { code: 0, stdout: `${HERMES_RESULT_SENTINEL}{"schemaVersion":1,"operation":"uninstall","status":"ok","message":"removed"}\n`, stderr: "" };
        }
        if (command.includes("hermes-install.js --json")) {
          return { code: 0, stdout: `${HERMES_RESULT_SENTINEL}{"schemaVersion":1,"operation":"install","status":"ok","message":"installed"}\n`, stderr: "" };
        }
        if (command.includes("wsl-connectivity-probe.js")) return { code: 0, stdout: "REACHABLE 23333\n", stderr: "" };
        if (command.startsWith("rm -rf --")) return { code: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected command: ${command}`);
      };
      const common = {
        agentId: "hermes",
        hooksDir: HOOKS_DIR,
        isWindows: () => true,
        execInWsl,
        getWslHomeDir: async () => { throw new Error("Hermes must not resolve shared WSL home staging"); },
        pipeFileToWsl: async (_distro, targetDir, relativePath, content) => {
          uploads.push({ targetDir, relativePath, content });
          return { ok: true, fileName: relativePath };
        },
      };

      const paired = await deployToWsl("Ubuntu", common);
      assert.strictEqual(paired.ok, true);
      assert.strictEqual(paired.connectivity, true);
      assert.strictEqual(paired.stagingRemoved, true);
      assert.strictEqual(uploads.length, HERMES_WSL_FILES.length);
      assert.ok(uploads.every((entry) => entry.targetDir === "/tmp/clawd-hermes-Ab12Cd34"));
      assert.ok(uploads.every((entry) => Buffer.isBuffer(entry.content)));
      assert.ok(calls.every((command) => !command.includes("/.claude/hooks")));

      uploads.length = 0;
      const removed = await removeFromWsl("Ubuntu", common);
      assert.strictEqual(removed.ok, true);
      assert.strictEqual(removed.stagingRemoved, true);
      assert.strictEqual(uploads.length, HERMES_WSL_FILES.length);
      assert.ok(calls.some((command) => command.includes("--uninstall --json")));
    });

    it("fails missing assets before any WSL mutation", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-wsl-hermes-missing-"));
      try {
        fs.writeFileSync(path.join(tempDir, "hermes-install.js"), "", "utf8");
        let mutated = false;
        const result = await deployToWsl("Ubuntu", {
          agentId: "hermes",
          hooksDir: tempDir,
          isWindows: () => true,
          execInWsl: async () => { mutated = true; return { code: 0, stdout: "", stderr: "" }; },
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.step, "verify-files");
        assert.strictEqual(mutated, false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("turns cleanup failure into a warning without hiding successful install", async () => {
      const execInWsl = async (_distro, command) => {
        if (command.includes("mktemp -d")) return { code: 0, stdout: `${HERMES_TEMP_SENTINEL}/tmp/clawd-hermes-Ab12Cd34\n`, stderr: "" };
        if (command.includes("hermes-install.js --json")) return { code: 0, stdout: `${HERMES_RESULT_SENTINEL}{"schemaVersion":1,"operation":"install","status":"ok","message":"installed"}\n`, stderr: "" };
        if (command.includes("wsl-connectivity-probe.js")) return { code: 1, stdout: "UNREACHABLE\n", stderr: "" };
        if (command.startsWith("rm -rf --")) return { code: 1, stdout: "", stderr: "busy" };
        throw new Error(`unexpected command: ${command}`);
      };
      const result = await deployToWsl("Ubuntu", {
        agentId: "hermes",
        hooksDir: HOOKS_DIR,
        isWindows: () => true,
        execInWsl,
        pipeFileToWsl: async () => ({ ok: true }),
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.stagingRemoved, false);
      assert.match(result.warning, /cleanup failed/i);
    });

    it("surfaces structured Hermes warning detail instead of only the summary", async () => {
      const execInWsl = async (_distro, command) => {
        if (command.includes("mktemp -d")) return { code: 0, stdout: `${HERMES_TEMP_SENTINEL}/tmp/clawd-hermes-Ab12Cd34\n`, stderr: "" };
        if (command.includes("--uninstall --json")) {
          return {
            code: 0,
            stdout: `${HERMES_RESULT_SENTINEL}{"schemaVersion":1,"operation":"uninstall","status":"warning","message":"removed with warnings","warning":"profile disable failed"}\n`,
            stderr: "",
          };
        }
        if (command.startsWith("rm -rf --")) return { code: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected command: ${command}`);
      };
      const result = await removeFromWsl("Ubuntu", {
        agentId: "hermes",
        hooksDir: HOOKS_DIR,
        isWindows: () => true,
        execInWsl,
        pipeFileToWsl: async () => ({ ok: true }),
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.warning, "profile disable failed");
      assert.strictEqual(result.message, "removed with warnings");
    });
  });
});
