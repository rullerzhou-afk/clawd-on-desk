const assert = require("node:assert");
const { describe, it } = require("node:test");
const childProcess = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const NSIS_INCLUDE = path.join(ROOT, "build", "installer.nsh");
const TEMPLATE = path.join(
  ROOT, "node_modules", "app-builder-lib", "templates", "nsis", "include", "allowOnlyOneInstallerInstance.nsh"
);
const SYNC_MESSAGE = "electron-builder NSIS template changed; resync build/installer.nsh with it";
// 32-bit PowerShell cold start can take over 30s on a loaded CI runner.
const POWERSHELL_WARMUP_TIMEOUT_MS = 120000;
const POWERSHELL_TIMEOUT_MS = 60000;
// count 0 runs one call; count 1 runs two (template + fixed); count 2 runs one.
const POWERSHELL_CALLS_PER_CASE = 4;
const CASE_MARGIN_MS = 60000;
const PROCESS_CASE_TIMEOUT_MS =
  POWERSHELL_WARMUP_TIMEOUT_MS + POWERSHELL_CALLS_PER_CASE * POWERSHELL_TIMEOUT_MS + CASE_MARGIN_MS;

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
}

function getMacroBody(text, name) {
  const pattern = new RegExp(`^!macro ${name}(?:[ \\t]+[^\\n]*)?\\n([\\s\\S]*?)^!macroend\\b`, "m");
  const macro = text.match(pattern);
  assert.ok(macro, `${SYNC_MESSAGE} (${name})`);
  return macro[1].trim();
}

function getPowerShellCommand(macro, installDir) {
  const command = macro.match(/^\s*nsExec::Exec `"\$PowerShellPath" -C "([^"\n]+)"`\s*$/m);
  assert.ok(command, `${SYNC_MESSAGE} (PowerShell command)`);
  return command[1]
    .replace(/\$\$/g, "$")
    .replace(/\$INSTDIR/g, () => installDir);
}

function runPowerShell(executable, macro, installDir) {
  return childProcess.spawnSync(executable, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    getPowerShellCommand(macro, installDir),
  ], { encoding: "utf8", windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS });
}

describe("Windows NSIS running app check", {
  // The two PowerShell cases run sequentially; the global --test-timeout must
  // not cancel the whole suite before they finish.
  timeout: 2 * PROCESS_CASE_TIMEOUT_MS + CASE_MARGIN_MS,
}, () => {
  const template = readText(TEMPLATE);
  const installer = readText(NSIS_INCLUDE);

  it("issue #882: keeps the running-app flow identical to the electron-builder template", () => {
    const upstream = getMacroBody(template, "_CHECK_APP_RUNNING");
    assert.strictEqual(
      getMacroBody(installer, "CLAWD_CHECK_APP_RUNNING"),
      upstream.replace(/!insertmacro FIND_PROCESS\b/g, "!insertmacro CLAWD_FIND_PROCESS"),
      SYNC_MESSAGE
    );
  });

  it("issue #882: changes only the PowerShell single-process count in FIND_PROCESS", () => {
    const upstream = getMacroBody(template, "FIND_PROCESS");
    assert.strictEqual((upstream.match(/\(Get-CimInstance/g) || []).length, 1, SYNC_MESSAGE);
    assert.strictEqual(
      getMacroBody(installer, "CLAWD_FIND_PROCESS"),
      upstream.replace("(Get-CimInstance", "@(Get-CimInstance"),
      SYNC_MESSAGE
    );
  });

  it("issue #882: keeps the CHECK_APP_RUNNING wrapper and fallback in sync with the custom check", () => {
    const upstream = getMacroBody(template, "CHECK_APP_RUNNING");
    const fallback = upstream.match(/^  !else\n([\s\S]*?)^  !endif$/m);
    assert.ok(fallback, SYNC_MESSAGE);

    assert.strictEqual(
      upstream.replace(fallback[0], "  !else\n  !endif"),
      String.raw`Var /GLOBAL CmdPath
  Var /GLOBAL PowerShellPath
  StrCpy $CmdPath "$SYSDIR\cmd.exe"
  StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  !ifmacrodef customCheckAppRunning
    !insertmacro customCheckAppRunning
  !else
  !endif`,
      SYNC_MESSAGE
    );

    // The template fallback is nested two spaces deeper than the custom macro.
    assert.strictEqual(
      getMacroBody(installer, "customCheckAppRunning")
        .replace(/^[ \t]*;[^\n]*\n/gm, "")
        .replace(/\n  !ifndef BUILD_UNINSTALLER\n    !insertmacro CLAWD_CHECK_OLD_INSTALL_REMOVABLE\n  !endif$/, "")
        .replace(/\n/g, "\n  "),
      fallback[1].replace(/\b_CHECK_APP_RUNNING\b/g, "CLAWD_CHECK_APP_RUNNING").trim(),
      SYNC_MESSAGE
    );
  });

  it("issue #882: supplies the dependencies that the custom check disables in the template", () => {
    assert.match(
      template,
      /^!ifmacrondef customCheckAppRunning\n  !include "getProcessInfo.nsh"\n  Var pid\n!endif$/m,
      SYNC_MESSAGE
    );
    assert.match(
      installer,
      /^(?:;[^\n]*\n|\n)*!include "getProcessInfo.nsh"\nVar pid\n/,
      SYNC_MESSAGE
    );
  });

  for (const systemDirectory of ["System32", "SysWOW64"]) {
    it(`issue #882: detects zero, one and two install-directory processes with ${systemDirectory} PowerShell`, {
      skip: process.platform !== "win32" ? "requires Windows PowerShell 5.1" : false,
      timeout: PROCESS_CASE_TIMEOUT_MS,
    }, async (t) => {
      assert.ok(process.env.SystemRoot, "SystemRoot should identify the Windows directory");
      const powershell = path.join(
        process.env.SystemRoot, systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"
      );
      if (systemDirectory === "SysWOW64" && !fs.existsSync(powershell)) {
        t.skip("32-bit Windows PowerShell is not installed");
        return;
      }
      assert.ok(fs.existsSync(powershell), `${powershell} should exist`);

      // Warm up the executable so the detection calls don't pay the slow cold start.
      const warmup = childProcess.spawnSync(powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "exit 0",
      ], { encoding: "utf8", windowsHide: true, timeout: POWERSHELL_WARMUP_TIMEOUT_MS });
      assert.strictEqual(
        warmup.status,
        0,
        `${systemDirectory}: PowerShell warm-up failed: error=${warmup.error?.message || "none"}, ` +
        `signal=${warmup.signal}`
      );

      const root = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "clawd-installer-check-"))
      );
      const installDir = path.join(root, "Clawd Install Dir");
      const children = [];
      try {
        fs.mkdirSync(installDir);
        const executable = path.join(installDir, "node.exe");
        fs.copyFileSync(process.execPath, executable);
        const upstream = getMacroBody(template, "FIND_PROCESS");
        const fixed = getMacroBody(installer, "CLAWD_FIND_PROCESS");

        for (const processCount of [0, 1, 2]) {
          if (processCount > 0) {
            const child = childProcess.spawn(executable, ["-e", "setInterval(() => {}, 1000)"], {
              stdio: "ignore",
              windowsHide: true,
            });
            children.push(child);
            await once(child, "spawn");
          }

          if (processCount === 1) {
            const original = runPowerShell(powershell, upstream, installDir);
            t.diagnostic(
              `${systemDirectory}, ${processCount} process(es): template exit=${original.status}, ` +
              `error=${original.error?.message || "none"}\nstdout:\n${original.stdout}\nstderr:\n${original.stderr}`
            );
          }

          const result = runPowerShell(powershell, fixed, installDir);
          assert.strictEqual(
            result.status,
            processCount === 0 ? 1 : 0,
            `${systemDirectory}, ${processCount} process(es): error=${result.error?.message || "none"}, ` +
            `signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
          );
        }
      } finally {
        await Promise.all(children.map(async (child) => {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            const closed = once(child, "close");
            child.kill();
            await closed;
          }
        }));
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
});
