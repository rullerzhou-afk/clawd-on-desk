const assert = require("node:assert");
const { describe, it } = require("node:test");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pkg = require("../package.json");
const { SERVER_PORTS } = require("../hooks/server-config");

const ROOT = path.join(__dirname, "..");
const NSIS_INCLUDE = path.join(ROOT, "build", "installer.nsh");
const CLEANUP_SCRIPT = path.join(ROOT, "build", "uninstall-claude-hooks.ps1");

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeUtf8Bom(filePath, text) {
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(text, "utf8"),
  ]));
}

function writeUtf16LeBom(filePath, text) {
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(text, "utf16le"),
  ]));
}

function makeFixture(settingsText, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-uninstall-"));
  const home = path.join(root, "User With Space 中文");
  const claudeDir = path.join(home, ".claude");
  const installDir = path.join(root, "Clawd Install Dir");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  const markerPath = path.join(installDir, ".clawd-install-user-home");
  if (options.markerEncoding === "utf16le-bom") {
    writeUtf16LeBom(markerPath, home);
  } else {
    fs.writeFileSync(markerPath, home, "utf8");
  }

  const settingsPath = path.join(claudeDir, "settings.json");
  if (settingsText !== undefined) {
    if (options.settingsEncoding === "utf8-bom") {
      writeUtf8Bom(settingsPath, settingsText);
    } else {
      fs.writeFileSync(settingsPath, settingsText, "utf8");
    }
  }

  return {
    root,
    home,
    claudeDir,
    installDir,
    settingsPath,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function runCleanup(fixture) {
  const result = childProcess.spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    CLEANUP_SCRIPT,
    "-InstallDir",
    fixture.installDir,
  ], { encoding: "utf8" });

  assert.strictEqual(
    result.status,
    0,
    `cleanup failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertNoUtf8Bom(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.notDeepStrictEqual(
    Array.from(buffer.subarray(0, 3)),
    [0xef, 0xbb, 0xbf],
    `${filePath} should be UTF-8 without BOM`
  );
}

describe("Windows NSIS Claude hook uninstall cleanup", () => {
  it("wires the NSIS include and cleanup script into package config", () => {
    assert.strictEqual(pkg.build.nsis && pkg.build.nsis.include, "build/installer.nsh");
    assert.ok(fs.existsSync(NSIS_INCLUDE), "build/installer.nsh should exist");
    assert.ok(fs.existsSync(CLEANUP_SCRIPT), "build/uninstall-claude-hooks.ps1 should exist");

    const nsis = readText(NSIS_INCLUDE);
    assert.match(nsis, /!macro customInstall/);
    assert.match(nsis, /!macro customUnInstall/);
    assert.match(nsis, /File "\/oname=\$INSTDIR\\uninstall-claude-hooks\.ps1"/);
    assert.match(nsis, /FileWrite \$0 "\$PROFILE"/);
    assert.match(nsis, /FileRead \$0 \$1/);
    assert.match(nsis, /ELECTRON_RUN_AS_NODE/);
    assert.match(nsis, /resources\\app\.asar\.unpacked\\hooks\\cleanup-integrations\.js/);
    assert.match(nsis, /--apply --user-home "\$1" --source nsis --fail-open/);
    assert.match(nsis, /nsExec::ExecToLog 'powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\$INSTDIR\\uninstall-claude-hooks\.ps1" -InstallDir "\$INSTDIR"'/);
  });

  it("issue #1293: skips both integration cleanups during NSIS upgrades", () => {
    const nsis = readText(NSIS_INCLUDE).replace(/\r\n/g, "\n");
    const uninstall = nsis.match(/!macro customUnInstall\n([\s\S]*?)!macroend/);
    assert.ok(uninstall, "customUnInstall should exist");

    const guarded = uninstall[1].match(/\$\{ifNot\} \$\{isUpdated\}\n([\s\S]*?)\n\s*\$\{endIf\}/);
    assert.ok(guarded, "customUnInstall should guard cleanup with ${ifNot} ${isUpdated}");
    assert.match(guarded[1], /FileRead \$0 \$1/);
    assert.match(guarded[1], /nsExec::ExecToLog '[^\n]*cleanup-integrations\.js/);
    assert.match(guarded[1], /nsExec::ExecToLog 'powershell\.exe [^\n]*uninstall-claude-hooks\.ps1/);
  });

  it("keeps the PowerShell permission port list in sync with SERVER_PORTS", () => {
    const script = readText(CLEANUP_SCRIPT);
    const match = script.match(/\$ClawdPermissionPorts\s*=\s*@\(([^)]*)\)/);
    assert.ok(match, "PowerShell script should use an explicit @(...) permission port literal");

    const ports = match[1]
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value));

    assert.deepStrictEqual(ports, SERVER_PORTS);
    assert.strictEqual(ports.length, SERVER_PORTS.length);
  });

  it("contains PowerShell 5.1 JSON hardening requirements", () => {
    const script = readText(CLEANUP_SCRIPT);
    assert.match(script, /New-Object System\.Text\.UTF8Encoding -ArgumentList \$false/);
    assert.match(script, /\.TrimStart\(\[char\]0xFEFF\)\.Trim\(\)/);
    assert.match(script, /\$rawSettings = \$rawSettings\.TrimStart\(\[char\]0xFEFF\)/);
    assert.match(script, /\[System\.IO\.File\]::ReadAllText\(\$settingsPath, \$Utf8NoBom\)/);
    assert.match(script, /\[System\.IO\.File\]::WriteAllText\(\$settingsPath, \$json \+ \[Environment\]::NewLine, \$Utf8NoBom\)/);
    assert.match(script, /ConvertTo-Json -InputObject \$settings -Depth 100/);
    assert.match(script, /\.PSObject\.Properties/);
    assert.match(script, /\[object\[\]\]\$nextEntries\.ToArray\(\)/);
  });

  it("issue #1293: fallback cleanup checks exec args[0] before legacy command markers", () => {
    const script = readText(CLEANUP_SCRIPT);
    const helper = script.slice(script.indexOf("function Test-ClawdCommandHook"), script.indexOf("function Test-ClawdPermissionUrl"));
    assert.match(helper, /Get-JsonProperty \$Hook "args"/);
    assert.match(helper, /\$argsProperty\.Value -is \[System\.Array\]/);
    assert.match(helper, /\$argsProperty\.Value\[0\]/);
    assert.match(helper, /\$ClawdCommandMarkers -ccontains \$scriptName/);
    assert.match(script, /Test-ClawdCommandHook \$entry/);
    assert.match(script, /Test-ClawdCommandHook \$hook/);
  });

  it("issue #1293: PowerShell removes exec state and auto-start hooks, preserving foreign args and basenames", {
    skip: process.platform !== "win32" ? "requires Windows PowerShell" : false,
  }, () => {
    const command = "C:\\Program Files\\nodejs\\node.exe";
    const exec = (script, ...args) => ({ type: "command", command, args: [script, ...args] });
    const foreign = [exec("C:/foreign.js", "clawd-hook.js"), exec("C:/clawd-hook.js.bak"),
      exec("C:/foreign.js", "auto-start.js"), exec("C:/auto-start.js.bak")];
    const fixture = makeFixture(JSON.stringify({ hooks: {
      Stop: [exec("C:/Clawd/clawd-hook.js", "Stop"), { hooks: [exec("C:\\Clawd\\clawd-hook.js", "Stop"), ...foreign] }],
      SessionStart: [{ hooks: [exec("C:/Clawd/auto-start.js"), exec("C:/Clawd/auto-start.sh")] }],
    } }));
    try {
      runCleanup(fixture);
      assert.deepStrictEqual(readJson(fixture.settingsPath).hooks, { Stop: [{ hooks: foreign }] });
      const backups = fs.readdirSync(fixture.claudeDir).filter((name) => name.endsWith(".bak"));
      runCleanup(fixture);
      assert.deepStrictEqual(fs.readdirSync(fixture.claudeDir).filter((name) => name.endsWith(".bak")), backups);
    } finally {
      fixture.cleanup();
    }
  });

  it("removes only Clawd hooks while preserving third-party hooks and array shape", {
    skip: process.platform !== "win32" ? "requires Windows PowerShell" : false,
  }, () => {
    const fixture = makeFixture(JSON.stringify({
      metadata: { note: "non-ascii 中文 path" },
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: '& "node" "C:\\Clawd\\hooks\\auto-start.js"' }],
          },
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "C:\\third-party.js" SessionStart' }],
          },
        ],
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: '& "node" "C:\\Clawd\\hooks\\clawd-hook.js" Stop' }],
          },
        ],
        PreToolUse: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: 'node "C:\\third-party.js" PreToolUse' },
              { type: "command", command: '& "node" "C:\\Clawd\\hooks\\clawd-hook.js" PreToolUse' },
            ],
          },
        ],
        PermissionRequest: [
          {
            matcher: "",
            hooks: [
              { type: "http", url: "http://127.0.0.1:23337/permission", timeout: 600 },
              { type: "http", url: "http://127.0.0.1:8080/permission", timeout: 100 },
            ],
          },
          {
            type: "http",
            url: "http://localhost:8080/permission",
            timeout: 100,
          },
        ],
      },
    }, null, 2));

    try {
      runCleanup(fixture);
      const settings = readJson(fixture.settingsPath);

      assert.strictEqual(settings.metadata.note, "non-ascii 中文 path");
      assert.ok(!Object.prototype.hasOwnProperty.call(settings.hooks, "Stop"));
      assert.ok(Array.isArray(settings.hooks.SessionStart));
      assert.strictEqual(settings.hooks.SessionStart.length, 1);
      assert.ok(Array.isArray(settings.hooks.SessionStart[0].hooks));
      assert.strictEqual(settings.hooks.SessionStart[0].hooks.length, 1);
      assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, 'node "C:\\third-party.js" SessionStart');

      assert.ok(Array.isArray(settings.hooks.PreToolUse));
      assert.strictEqual(settings.hooks.PreToolUse.length, 1);
      assert.ok(Array.isArray(settings.hooks.PreToolUse[0].hooks));
      assert.strictEqual(settings.hooks.PreToolUse[0].hooks.length, 1);
      assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, 'node "C:\\third-party.js" PreToolUse');

      assert.ok(Array.isArray(settings.hooks.PermissionRequest));
      assert.strictEqual(settings.hooks.PermissionRequest.length, 2);
      assert.deepStrictEqual(
        settings.hooks.PermissionRequest[0].hooks.map((hook) => hook.url),
        ["http://127.0.0.1:8080/permission"]
      );
      assert.strictEqual(settings.hooks.PermissionRequest[1].url, "http://localhost:8080/permission");

      const backups = fs.readdirSync(fixture.claudeDir).filter((name) => /^settings\.json\.clawd-uninstall-.*\.bak$/.test(name));
      assert.strictEqual(backups.length, 1);
      assertNoUtf8Bom(fixture.settingsPath);
    } finally {
      fixture.cleanup();
    }
  });

  it("reads an NSIS-style UTF-16LE BOM user-home marker", {
    skip: process.platform !== "win32" ? "requires Windows PowerShell" : false,
  }, () => {
    const fixture = makeFixture(JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: '& "node" "C:\\Clawd\\hooks\\clawd-hook.js" Stop' }],
          },
        ],
      },
    }, null, 2), { markerEncoding: "utf16le-bom" });

    try {
      runCleanup(fixture);
      const settings = readJson(fixture.settingsPath);
      assert.deepStrictEqual(settings.hooks, {});
    } finally {
      fixture.cleanup();
    }
  });

  it("cleans a UTF-8 BOM settings.json and rewrites it without BOM", {
    skip: process.platform !== "win32" ? "requires Windows PowerShell" : false,
  }, () => {
    const fixture = makeFixture(JSON.stringify({
      hooks: {
        PermissionRequest: [
          {
            matcher: "",
            hooks: [
              { type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 },
              { type: "http", url: "http://127.0.0.1:8080/permission", timeout: 100 },
            ],
          },
        ],
      },
    }, null, 2), { settingsEncoding: "utf8-bom" });

    try {
      runCleanup(fixture);
      const settings = readJson(fixture.settingsPath);
      assert.deepStrictEqual(
        settings.hooks.PermissionRequest[0].hooks.map((hook) => hook.url),
        ["http://127.0.0.1:8080/permission"]
      );
      assertNoUtf8Bom(fixture.settingsPath);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps command marker matching case-sensitive to match JS cleanup semantics", {
    skip: process.platform !== "win32" ? "requires Windows PowerShell" : false,
  }, () => {
    const fixture = makeFixture(JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: '& "node" "C:\\User\\Clawd-Hook.js" Stop' }],
          },
        ],
      },
    }, null, 2));

    try {
      runCleanup(fixture);
      const settings = readJson(fixture.settingsPath);
      assert.strictEqual(settings.hooks.Stop[0].hooks[0].command, '& "node" "C:\\User\\Clawd-Hook.js" Stop');
    } finally {
      fixture.cleanup();
    }
  });

  it("leaves malformed settings untouched", {
    skip: process.platform !== "win32" ? "requires Windows PowerShell" : false,
  }, () => {
    const malformed = "{ not valid json\n";
    const fixture = makeFixture(malformed);

    try {
      runCleanup(fixture);
      assert.strictEqual(fs.readFileSync(fixture.settingsPath, "utf8"), malformed);
      const backups = fs.readdirSync(fixture.claudeDir).filter((name) => name.includes("clawd-uninstall"));
      assert.deepStrictEqual(backups, []);
    } finally {
      fixture.cleanup();
    }
  });

  it("treats missing settings.json as a silent no-op", {
    skip: process.platform !== "win32" ? "requires Windows PowerShell" : false,
  }, () => {
    const fixture = makeFixture(undefined);

    try {
      runCleanup(fixture);
      assert.strictEqual(fs.existsSync(fixture.settingsPath), false);
      const files = fs.readdirSync(fixture.claudeDir);
      assert.deepStrictEqual(files, []);
    } finally {
      fixture.cleanup();
    }
  });
});
