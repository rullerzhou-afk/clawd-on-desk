"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DSH_VERSION_FAMILIES,
  discoverDshDesktopSync,
  discoverDshDesktop,
  refreshDshDesktopDiscovery,
  desktopCommandInfo,
  probeDshCarrier,
  resolveDshCommand,
  runDshCommand,
  resolveDshTargets,
} = require("../hooks/dsh-install");
const { __test: dshInstallTest } = require("../hooks/dsh-install");
const { desktopFound: platformDesktopFound, DSH_CMD_TEMPLATE } = require("./dsh-desktop-fixtures");

const FAMILY_VERSION = DSH_VERSION_FAMILIES[0].minVersion;
const SOURCE_DIR = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");

const WIN_BIN = "D:\\软件\\DeepSeek Harness\\resources\\runtime\\cli\\bin";
const WIN_CMD = `${WIN_BIN}\\dsh.cmd`;
const WIN_EXE = "D:\\软件\\DeepSeek Harness\\DeepSeek Harness.exe";
const WIN_CLI = "D:\\软件\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js";

function templateText(newline = "\n", suffix = "") {
  return `${DSH_CMD_TEMPLATE.join(newline)}${newline}${suffix}`;
}

// Case-insensitive fake fs for the win32 code paths; keys are normalized with
// path.win32 so a host that is not Windows can exercise them.
function winFs(files) {
  const map = new Map();
  for (const [key, value] of Object.entries(files)) {
    map.set(path.win32.resolve(key).toLowerCase(), value);
  }
  const missing = () => {
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    return err;
  };
  return {
    readFileSync(filePath) {
      const key = path.win32.resolve(String(filePath)).toLowerCase();
      if (!map.has(key)) throw missing();
      return map.get(key);
    },
    statSync(filePath) {
      const key = path.win32.resolve(String(filePath)).toLowerCase();
      if (!map.has(key)) throw missing();
      return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
    },
  };
}

const MAC_PLIST = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<plist version=\"1.0\"><dict>",
  "<key>CFBundleIdentifier</key><string>com.deepseek.dsh</string>",
  "<key>CFBundleShortVersionString</key><string>0.2.0-rc.2</string>",
  "</dict></plist>",
].join("");

// macOS fake fs: each appRoot is a directory with a valid bundle id and the
// bundled launcher, matching what discoverDshDesktopSync verifies. An optional
// realpath map makes a symlinked location resolve onto its real bundle.
function macFs(appRoots, options = {}) {
  const dirs = new Set(appRoots.map((root) => path.resolve(root)));
  const files = new Map();
  for (const root of appRoots) {
    files.set(path.resolve(path.join(root, "Contents", "Info.plist")), MAC_PLIST);
    files.set(
      path.resolve(path.join(root, "Contents", "Resources", "runtime", "cli", "bin", "dsh")),
      "launcher"
    );
  }
  const missing = () => {
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    return err;
  };
  const fsImpl = {
    statSync(filePath) {
      const key = path.resolve(String(filePath));
      if (dirs.has(key)) return { isDirectory: () => true, isFile: () => false };
      if (files.has(key)) return { isDirectory: () => false, isFile: () => true };
      throw missing();
    },
    readFileSync(filePath) {
      const key = path.resolve(String(filePath));
      if (files.has(key)) return files.get(key);
      throw missing();
    },
  };
  if (options.realpath instanceof Map) {
    fsImpl.realpathSync = (filePath) => {
      const key = path.resolve(String(filePath));
      return options.realpath.has(key) ? options.realpath.get(key) : key;
    };
  }
  return fsImpl;
}

const MAC_UNREADABLE = "__EACCES__";

function macBundlePaths(root) {
  return {
    plist: path.join(root, "Contents", "Info.plist"),
    launcher: path.join(root, "Contents", "Resources", "runtime", "cli", "bin", "dsh"),
  };
}

// A lower-level macOS fake fs for edge cases: choose which dirs exist, which
// files exist (or throw EACCES on read), and which dirs fail statSync.
function macFsRaw({ dirs = [], files = {}, statErrors = {} } = {}) {
  const dirSet = new Set(dirs.map((dir) => path.resolve(dir)));
  const fileMap = new Map(Object.entries(files).map(([key, value]) => [path.resolve(key), value]));
  const statErrorMap = new Map(Object.entries(statErrors).map(([key, value]) => [path.resolve(key), value]));
  const missing = (code = "ENOENT") => {
    const err = new Error(code);
    err.code = code;
    return err;
  };
  return {
    statSync(filePath) {
      const key = path.resolve(String(filePath));
      if (statErrorMap.has(key)) throw missing(statErrorMap.get(key));
      if (dirSet.has(key)) return { isDirectory: () => true, isFile: () => false };
      if (fileMap.has(key)) return { isDirectory: () => false, isFile: () => true };
      throw missing();
    },
    readFileSync(filePath) {
      const key = path.resolve(String(filePath));
      if (!fileMap.has(key)) throw missing();
      const value = fileMap.get(key);
      if (value === MAC_UNREADABLE) throw missing("EACCES");
      return value;
    },
  };
}

function macValidFiles(root) {
  const { plist, launcher } = macBundlePaths(root);
  return { [plist]: MAC_PLIST, [launcher]: "launcher" };
}

function winDesktopFiles(root) {
  return {
    [path.win32.join(root, "DeepSeek Harness.exe")]: "exe",
    [path.win32.join(root, "resources", "runtime", "cli", "bin", "dsh.cmd")]: "cmd",
    [path.win32.join(root, "resources", "app.asar")]: "asar",
  };
}

// A win32 fake fs whose statSync reports a chosen kind per path, so a test can
// simulate Electron (app.asar is a directory) or plain Node (a file), as well
// as reject a directory where a file is required.
function winStatFs(entries) {
  const map = new Map();
  for (const [entryPath, kind] of entries) {
    map.set(path.win32.resolve(entryPath).toLowerCase(), kind);
  }
  const missing = () => {
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    return err;
  };
  return {
    statSync(filePath) {
      const key = path.win32.resolve(String(filePath)).toLowerCase();
      if (!map.has(key)) throw missing();
      const kind = map.get(key);
      return { isFile: () => kind === "file", isDirectory: () => kind === "dir", isSymbolicLink: () => false };
    },
    readFileSync() {
      throw missing();
    },
  };
}

function windowsDesktopEntries(root, asarKind) {
  return [
    [path.win32.join(root, "DeepSeek Harness.exe"), "file"],
    [path.win32.join(root, "resources", "runtime", "cli", "bin", "dsh.cmd"), "file"],
    [path.win32.join(root, "resources", "app.asar"), asarKind],
  ];
}

function makeHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-carriers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dshHome: path.join(root, ".dsh"), managedRoot: path.join(root, "managed") };
}

function writeProfile(dshHome, profile, manifest) {
  const profileDir = path.join(dshHome, "profiles", profile);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "package.json"),
    `${JSON.stringify(manifest || {
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, null, 2)}\n`,
    "utf8"
  );
  return profileDir;
}

function desktopFound(launcherPath = "D:\\app\\resources\\runtime\\cli\\bin\\dsh.cmd") {
  return {
    status: "found",
    appRoot: path.win32.dirname(path.win32.dirname(path.win32.dirname(path.win32.dirname(launcherPath)))),
    launcherPath,
    staticVersion: null,
    checkedPaths: [launcherPath],
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// dsh.cmd parsing
// ---------------------------------------------------------------------------

test("the Windows dsh.cmd template parses to its exe and cli paths", () => {
  const fsImpl = winFs({ [WIN_CMD]: templateText(), [WIN_EXE]: "exe" });
  const parsed = dshInstallTest.parseDesktopDshCmd(WIN_CMD, { platform: "win32", fs: fsImpl });
  assert.strictEqual(parsed.reason, null);
  assert.strictEqual(parsed.commandInfo.command, WIN_EXE);
  assert.deepStrictEqual(parsed.commandInfo.prefixArgs, ["--expose-internals", WIN_CLI]);
  assert.strictEqual(parsed.commandInfo.kind, "desktop");
  assert.strictEqual(parsed.commandInfo.bundledPackageManager, true);
});

test("the Windows dsh.cmd template parses with CRLF line endings", () => {
  const fsImpl = winFs({ [WIN_CMD]: templateText("\r\n"), [WIN_EXE]: "exe" });
  const parsed = dshInstallTest.parseDesktopDshCmd(WIN_CMD, { platform: "win32", fs: fsImpl });
  assert.strictEqual(parsed.reason, null);
  assert.strictEqual(parsed.commandInfo.command, WIN_EXE);
});

test("an install directory with spaces and non-ASCII characters resolves", () => {
  const fsImpl = winFs({ [WIN_CMD]: templateText(), [WIN_EXE]: "exe" });
  const parsed = dshInstallTest.parseDesktopDshCmd(WIN_CMD, { platform: "win32", fs: fsImpl });
  assert.strictEqual(parsed.commandInfo.command, "D:\\软件\\DeepSeek Harness\\DeepSeek Harness.exe");
});

test("a template with an extra line is not recognized", () => {
  const fsImpl = winFs({ [WIN_CMD]: templateText("\n", "rem extra\n"), [WIN_EXE]: "exe" });
  const parsed = dshInstallTest.parseDesktopDshCmd(WIN_CMD, { platform: "win32", fs: fsImpl });
  assert.strictEqual(parsed.commandInfo, null);
  assert.strictEqual(parsed.reason, "launcher-unrecognized");
});

test("a template missing a line is not recognized", () => {
  const lines = DSH_CMD_TEMPLATE.filter((line) => !line.startsWith("setlocal"));
  const fsImpl = winFs({ [WIN_CMD]: `${lines.join("\n")}\n`, [WIN_EXE]: "exe" });
  const parsed = dshInstallTest.parseDesktopDshCmd(WIN_CMD, { platform: "win32", fs: fsImpl });
  assert.strictEqual(parsed.commandInfo, null);
  assert.strictEqual(parsed.reason, "launcher-unrecognized");
});

test("a template with a different exe name is not recognized", () => {
  const lines = [...DSH_CMD_TEMPLATE];
  lines[3] = lines[3].replace("DeepSeek Harness.exe", "Other App.exe");
  const fsImpl = winFs({ [WIN_CMD]: `${lines.join("\n")}\n`, [WIN_EXE]: "exe" });
  const parsed = dshInstallTest.parseDesktopDshCmd(WIN_CMD, { platform: "win32", fs: fsImpl });
  assert.strictEqual(parsed.commandInfo, null);
  assert.strictEqual(parsed.reason, "launcher-unrecognized");
});

test("a template with modified arguments is not recognized", () => {
  const lines = [...DSH_CMD_TEMPLATE];
  lines[3] = `${lines[3]} & calc`;
  const fsImpl = winFs({ [WIN_CMD]: `${lines.join("\n")}\n`, [WIN_EXE]: "exe" });
  const parsed = dshInstallTest.parseDesktopDshCmd(WIN_CMD, { platform: "win32", fs: fsImpl });
  assert.strictEqual(parsed.commandInfo, null);
  assert.strictEqual(parsed.reason, "launcher-unrecognized");
});

test("an unreadable launcher is not recognized", () => {
  const parsed = dshInstallTest.parseDesktopDshCmd(WIN_CMD, { platform: "win32", fs: winFs({}) });
  assert.strictEqual(parsed.commandInfo, null);
  assert.strictEqual(parsed.reason, "launcher-unrecognized");
});

test("a launcher whose exe is missing reports the target as missing", () => {
  const fsImpl = winFs({ [WIN_CMD]: templateText() });
  const parsed = dshInstallTest.parseDesktopDshCmd(WIN_CMD, { platform: "win32", fs: fsImpl });
  assert.strictEqual(parsed.commandInfo, null);
  assert.strictEqual(parsed.reason, "launcher-target-missing");
});

test("desktopCommandInfo recognizes a Windows dsh.cmd", () => {
  const fsImpl = winFs({ [WIN_CMD]: templateText(), [WIN_EXE]: "exe" });
  const result = desktopCommandInfo(desktopFound(WIN_CMD), { platform: "win32", fs: fsImpl });
  assert.strictEqual(result.reason, null);
  assert.strictEqual(result.commandInfo.command, WIN_EXE);
});

test("desktopCommandInfo returns the macOS launcher directly", () => {
  const launcher = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
  const result = desktopCommandInfo({ status: "found", launcherPath: launcher }, {
    platform: "darwin",
    homeDir: "/Users/me",
    env: { DSH_HOME: "/Users/me/.dsh" },
  });
  assert.strictEqual(result.commandInfo.command, launcher);
  assert.deepStrictEqual(result.commandInfo.prefixArgs, []);
  assert.strictEqual(result.commandInfo.cwd, "/Users/me");
  assert.strictEqual(result.commandInfo.kind, "desktop");
});

// ---------------------------------------------------------------------------
// Child environment and cwd
// ---------------------------------------------------------------------------

test("desktop env drops ELECTRON_* and NODE_OPTIONS case-insensitively on Windows", () => {
  const env = dshInstallTest.buildDesktopCommandEnv({
    platform: "win32",
    env: {
      ELECTRON_FOO: "1",
      electron_lower: "2",
      NODE_OPTIONS: "3",
      Node_Options: "4",
      DSH_HOME: "/dsh",
      PATH: "p",
    },
  });
  assert.strictEqual(env.ELECTRON_FOO, undefined);
  assert.strictEqual(env.electron_lower, undefined);
  assert.strictEqual(env.NODE_OPTIONS, undefined);
  assert.strictEqual(env.Node_Options, undefined);
  assert.strictEqual(env.DSH_HOME, "/dsh");
  assert.strictEqual(env.PATH, "p");
  assert.strictEqual(env.ELECTRON_RUN_AS_NODE, "1");
});

test("POSIX desktop env removal stays case-sensitive", () => {
  const env = dshInstallTest.buildDesktopCommandEnv({
    platform: "darwin",
    env: { ELECTRON_FOO: "1", electron_lower: "2", NODE_OPTIONS: "3", DSH_HOME: "/dsh" },
  });
  assert.strictEqual(env.ELECTRON_FOO, undefined);
  assert.strictEqual(env.electron_lower, "2");
  assert.strictEqual(env.NODE_OPTIONS, undefined);
  assert.strictEqual(env.DSH_HOME, "/dsh");
  assert.strictEqual(env.ELECTRON_RUN_AS_NODE, "1");
});

test("a desktop command cwd reaches runCommand unless the caller overrides it", async () => {
  const commandInfo = { command: "dsh", prefixArgs: [], kind: "desktop", env: { A: "1" }, cwd: "/home/me" };
  const seen = [];
  const runCommand = async (_command, _args, options) => {
    seen.push(options);
    return { code: 0, stdout: `${FAMILY_VERSION}\n` };
  };
  await probeDshCarrier(commandInfo, { runCommand });
  await probeDshCarrier(commandInfo, { runCommand, cwd: "/override" });
  assert.strictEqual(seen[0].cwd, "/home/me");
  assert.strictEqual(seen[0].env.A, "1");
  assert.strictEqual(seen[1].cwd, "/override");
});

test("the final desktop child env is sanitized, not merged with the caller's", async () => {
  for (const platform of ["darwin", "win32"]) {
    const callerEnv = {
      DSH_HOME: "/dsh",
      ELECTRON_EXTRA: "sentinel",
      NODE_OPTIONS: "sentinel",
      ...(platform === "win32" ? { Node_Options: "lower", electron_extra: "lower" } : {}),
    };
    const commandInfo = {
      command: "dsh",
      prefixArgs: [],
      kind: "desktop",
      env: dshInstallTest.buildDesktopCommandEnv({ platform, env: callerEnv }),
    };
    const seen = [];
    const runCommand = async (_command, _args, options) => {
      seen.push(options.env);
      return { code: 0, stdout: `${FAMILY_VERSION}\n` };
    };
    await probeDshCarrier(commandInfo, { platform, env: callerEnv, runCommand });
    await runDshCommand(["plugin", "--profile", "desktop", "add", "/gen"], {
      platform,
      env: callerEnv,
      commandInfo,
      runCommand,
    });
    assert.strictEqual(seen.length, 2);
    for (const env of seen) {
      assert.strictEqual(env.ELECTRON_RUN_AS_NODE, "1");
      assert.strictEqual(env.DSH_HOME, "/dsh");
      for (const key of Object.keys(env)) {
        const normalized = platform === "win32" ? key.toUpperCase() : key;
        assert.ok(normalized !== "NODE_OPTIONS", `inherited key returned: ${key}`);
        assert.ok(
          !(normalized.startsWith("ELECTRON_") && normalized !== "ELECTRON_RUN_AS_NODE"),
          `inherited key returned: ${key}`
        );
      }
    }
  }
});

test("interleaved registry cache keys keep single flight per key", async () => {
  dshInstallTest.resetWindowsRegistryCache();
  const releases = [];
  let calls = 0;
  const common = {
    platform: "win32",
    fs: { statSync() { const err = new Error("missing"); err.code = "ENOENT"; throw err; } },
    runCommand: async () => {
      calls += 1;
      await new Promise((resolve) => releases.push(resolve));
      return { code: 0, stdout: JSON.stringify({ uninstall: [], commandDirectory: null }) };
    },
  };
  const a = { ...common, env: { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\A" } };
  const b = { ...common, env: { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\B" } };

  const first = refreshDshDesktopDiscovery(a);
  const second = refreshDshDesktopDiscovery(b);
  const third = refreshDshDesktopDiscovery(a);
  for (const release of releases) release();
  await Promise.all([first, second, third]);

  assert.strictEqual(calls, 2);
  dshInstallTest.resetWindowsRegistryCache();
});

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

test("version probes use 5s for npm and 15s for desktop", async () => {
  const seen = [];
  const runCommand = async (_command, _args, options) => {
    seen.push(options.timeoutMs);
    return { code: 0, stdout: `${FAMILY_VERSION}\n` };
  };
  await probeDshCarrier({ command: "dsh", prefixArgs: [] }, { runCommand });
  await probeDshCarrier({ command: "dsh", prefixArgs: [], kind: "desktop" }, { runCommand });
  assert.deepStrictEqual(seen, [5000, 15000]);
});

test("plugin writes default to 300s and honor an explicit timeout", async () => {
  const seen = [];
  const runCommand = async (_command, _args, options) => {
    seen.push(options.timeoutMs);
    return { code: 0 };
  };
  await runDshCommand(["plugin", "--profile", "web", "add", "/gen"], {
    commandInfo: { command: "dsh", prefixArgs: [] },
    runCommand,
  });
  await runDshCommand(["plugin", "--profile", "web", "remove", "pkg"], {
    commandInfo: { command: "dsh", prefixArgs: [] },
    timeoutMs: 1234,
    runCommand,
  });
  assert.deepStrictEqual(seen, [300000, 1234]);
});

test("readDshVersion also chooses the timeout by carrier kind", async () => {
  const seen = [];
  const runCommand = async (_command, _args, options) => {
    seen.push(options.timeoutMs);
    return { code: 0, stdout: `${FAMILY_VERSION}\n` };
  };
  await dshInstallTest.readDshVersion({ command: "dsh", prefixArgs: [] }, { runCommand });
  await dshInstallTest.readDshVersion({ command: "dsh", prefixArgs: [], kind: "desktop" }, { runCommand });
  assert.deepStrictEqual(seen, [5000, 15000]);
});

// ---------------------------------------------------------------------------
// Carrier probe
// ---------------------------------------------------------------------------

test("a successful probe reports the version", async () => {
  const result = await probeDshCarrier({ command: "dsh", prefixArgs: [] }, {
    runCommand: async () => ({ code: 0, stdout: `${FAMILY_VERSION}\n` }),
  });
  assert.deepStrictEqual(result, { status: "available", version: FAMILY_VERSION });
});

test("a probe with a non-zero exit is carrier-failed", async () => {
  const result = await probeDshCarrier({ command: "dsh", prefixArgs: [] }, {
    runCommand: async () => ({ code: 1, stderr: "boom" }),
  });
  assert.strictEqual(result.status, "failed");
  assert.strictEqual(result.reason, "carrier-failed");
});

test("a probe that times out is carrier-failed", async () => {
  const result = await probeDshCarrier({ command: "dsh", prefixArgs: [] }, {
    runCommand: async () => ({ code: 1, timedOut: true }),
  });
  assert.strictEqual(result.reason, "carrier-failed");
});

test("a probe killed by a signal is carrier-failed", async () => {
  const result = await probeDshCarrier({ command: "dsh", prefixArgs: [] }, {
    runCommand: async () => ({ code: null, signal: "SIGKILL" }),
  });
  assert.strictEqual(result.reason, "carrier-failed");
});

test("a probe with unusable output is version-invalid", async () => {
  const result = await probeDshCarrier({ command: "dsh", prefixArgs: [] }, {
    runCommand: async () => ({ code: 0, stdout: "not a version\n" }),
  });
  assert.strictEqual(result.status, "failed");
  assert.strictEqual(result.reason, "version-invalid");
});

test("a probe with a family-external version is version-unsupported", async () => {
  const result = await probeDshCarrier({ command: "dsh", prefixArgs: [] }, {
    runCommand: async () => ({ code: 0, stdout: "0.9.0\n" }),
  });
  assert.strictEqual(result.status, "failed");
  assert.strictEqual(result.reason, "version-unsupported");
  assert.strictEqual(result.version, "0.9.0");
});

// ---------------------------------------------------------------------------
// PATH recognition
// ---------------------------------------------------------------------------

test("Windows resolves the desktop carrier when the first shim is dsh.cmd", async () => {
  const fsImpl = winFs({ [WIN_CMD]: templateText(), [WIN_EXE]: "exe" });
  const command = await resolveDshCommand({
    platform: "win32",
    fs: fsImpl,
    nodeBin: "C:\\node\\node.exe",
    runCommand: async (program) => (program === "where.exe"
      ? { code: 0, stdout: `${WIN_CMD}\r\n` }
      : { code: 1 }),
  });
  assert.strictEqual(command.kind, "desktop");
  assert.strictEqual(command.command, WIN_EXE);
});

test("Windows only trusts the first PATH shim, not a later desktop dsh.cmd", async () => {
  const npmShim = "C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd";
  const fsImpl = winFs({ [WIN_CMD]: templateText(), [WIN_EXE]: "exe" });
  const command = await resolveDshCommand({
    platform: "win32",
    fs: fsImpl,
    nodeBin: "C:\\node\\node.exe",
    runCommand: async (program) => (program === "where.exe"
      ? { code: 0, stdout: `${npmShim}\r\n${WIN_CMD}\r\n` }
      : { code: 1 }),
  });
  assert.notStrictEqual(command && command.kind, "desktop");
});

test("macOS PATH dsh pointing at the app launcher reuses the desktop carrier", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, "DeepSeek Harness.app");
  fs.mkdirSync(path.join(appRoot, "Contents"), { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n`
      + `<key>CFBundleIdentifier</key><string>com.deepseek.dsh</string>\n`
      + `<key>CFBundleShortVersionString</key><string>${FAMILY_VERSION}</string>\n`
      + `</dict></plist>\n`,
    "utf8"
  );
  const launcher = path.join(appRoot, "Contents", "Resources", "runtime", "cli", "bin", "dsh");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "#!/bin/sh\n");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const symlink = path.join(binDir, "dsh");
  fs.symlinkSync(launcher, symlink);

  const command = await resolveDshCommand({
    platform: process.platform,
    env: { SHELL: "/bin/sh" },
    nodeBin: "/usr/bin/node",
    access: async () => {},
    runCommand: async (_program, args) => (args.some((arg) => String(arg).includes("command -v dsh"))
      ? { code: 0, stdout: `${symlink}\n` }
      : { code: 1 }),
  });
  assert.strictEqual(command.kind, "desktop");
  assert.strictEqual(command.command, fs.realpathSync(launcher));
});

test("macOS PATH dsh inside a non-DSH bundle stays generic", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, "Fake.app");
  fs.mkdirSync(path.join(appRoot, "Contents"), { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n`
      + `<key>CFBundleIdentifier</key><string>com.example.fake</string>\n`
      + `</dict></plist>\n`,
    "utf8"
  );
  const launcher = path.join(appRoot, "Contents", "Resources", "runtime", "cli", "bin", "dsh");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "#!/bin/sh\n");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const symlink = path.join(binDir, "dsh");
  fs.symlinkSync(launcher, symlink);

  const command = await resolveDshCommand({
    platform: process.platform,
    env: { SHELL: "/bin/sh" },
    nodeBin: "/usr/bin/node",
    access: async () => {},
    runCommand: async (_program, args) => (args.some((arg) => String(arg).includes("command -v dsh"))
      ? { code: 0, stdout: `${symlink}\n` }
      : { code: 1 }),
  });
  assert.notStrictEqual(command && command.kind, "desktop");
});

test("a desktop carrier skips the global pnpm check", async () => {
  const desktop = desktopCommandInfo(
    { status: "found", launcherPath: "/fake/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" },
    { platform: "darwin", env: { DSH_HOME: "/dsh" } }
  );
  let called = false;
  const runtime = await dshInstallTest.resolvePnpmRuntime(desktop.commandInfo, {
    env: { PATH: "/nonexistent" },
    runCommand: async () => { called = true; return { code: 1 }; },
  });
  assert.strictEqual(runtime.available, true);
  assert.strictEqual(called, false);
});

test("a desktop carrier stays available even when pnpm is reported missing", async () => {
  const desktop = desktopCommandInfo(
    { status: "found", launcherPath: "/fake/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" },
    { platform: "darwin", env: { DSH_HOME: "/dsh" } }
  );
  const runtime = await dshInstallTest.resolvePnpmRuntime(desktop.commandInfo, { pnpmAvailable: false });
  assert.strictEqual(runtime.available, true);
});

// ---------------------------------------------------------------------------
// Windows discovery
// ---------------------------------------------------------------------------

test("an Uninstall entry yields the desktop root and its DisplayVersion", () => {
  const root = "C:\\Program Files\\DeepSeek Harness";
  const result = discoverDshDesktopSync({
    platform: "win32",
    fs: winFs(winDesktopFiles(root)),
    windowsRegistrySnapshot: {
      uninstall: [{
        guid: "{1111}",
        displayName: "DeepSeek Harness 0.2.0-rc.2",
        displayVersion: FAMILY_VERSION,
        installLocation: root,
        guidInstallLocation: null,
      }],
      commandDirectory: null,
    },
  });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, root);
  assert.strictEqual(result.launcherPath, path.win32.join(root, "resources", "runtime", "cli", "bin", "dsh.cmd"));
  assert.strictEqual(result.staticVersion, FAMILY_VERSION);
});

test("a custom Windows install directory with spaces and non-ASCII resolves", () => {
  const root = "D:\\软件\\DeepSeek Harness";
  const result = discoverDshDesktopSync({
    platform: "win32",
    fs: winFs(winDesktopFiles(root)),
    windowsRegistrySnapshot: {
      uninstall: [{ installLocation: root, displayVersion: FAMILY_VERSION }],
      commandDirectory: null,
    },
  });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, root);
  assert.strictEqual(result.staticVersion, FAMILY_VERSION);
});

test("a GUID-scoped InstallLocation is a valid fallback with unknown static version", () => {
  const root = "C:\\Tools\\DeepSeek Harness";
  const result = discoverDshDesktopSync({
    platform: "win32",
    fs: winFs(winDesktopFiles(root)),
    windowsRegistrySnapshot: {
      uninstall: [{ guid: "{2222}", guidInstallLocation: root }],
      commandDirectory: null,
    },
  });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.staticVersion, null);
});

test("Command\\Directory four levels up is the install root", () => {
  const root = "C:\\Tools\\DeepSeek Harness";
  const result = discoverDshDesktopSync({
    platform: "win32",
    fs: winFs(winDesktopFiles(root)),
    windowsRegistrySnapshot: {
      uninstall: [],
      commandDirectory: path.win32.join(root, "resources", "runtime", "cli", "bin"),
    },
  });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, root);
  assert.strictEqual(result.staticVersion, null);
});

test("the default per-user install directory is a last candidate", () => {
  const localAppData = "C:\\Users\\me\\AppData\\Local";
  const root = path.win32.join(localAppData, "Programs", "DeepSeek Harness");
  const result = discoverDshDesktopSync({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", LOCALAPPDATA: localAppData },
    fs: winFs(winDesktopFiles(root)),
    windowsRegistrySnapshot: { uninstall: [], commandDirectory: null },
  });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, root);
});

test("a candidate whose files are gone is skipped", () => {
  const result = discoverDshDesktopSync({
    platform: "win32",
    fs: winFs({}),
    windowsRegistrySnapshot: {
      uninstall: [{ installLocation: "C:\\Gone" }],
      commandDirectory: null,
    },
  });
  assert.strictEqual(result.status, "not-found");
  assert.ok(result.checkedPaths.includes("C:\\Gone"));
});

test("two different valid Windows roots fail closed as ambiguous", () => {
  const first = "C:\\One\\DeepSeek Harness";
  const second = "D:\\Two\\DeepSeek Harness";
  const result = discoverDshDesktopSync({
    platform: "win32",
    fs: winFs({
      ...winDesktopFiles(first),
      ...winDesktopFiles(second),
    }),
    windowsRegistrySnapshot: {
      uninstall: [
        { installLocation: first },
        { installLocation: second },
      ],
      commandDirectory: null,
    },
  });
  assert.strictEqual(result.status, "ambiguous");
  assert.strictEqual(result.reason, "multiple-desktop-installs");
  assert.strictEqual(result.candidates.length, 2);
});

test("the same Windows root in different case counts once", () => {
  const root = "C:\\Tools\\DeepSeek Harness";
  const result = discoverDshDesktopSync({
    platform: "win32",
    fs: winFs(winDesktopFiles(root)),
    windowsRegistrySnapshot: {
      uninstall: [{ installLocation: root, guidInstallLocation: root.toLowerCase() }],
      commandDirectory: null,
    },
  });
  assert.strictEqual(result.status, "found");
});

test("an unreadable registry is unknown and does not guess the default directory", () => {
  const localAppData = "C:\\Users\\me\\AppData\\Local";
  const root = path.win32.join(localAppData, "Programs", "DeepSeek Harness");
  const result = discoverDshDesktopSync({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", LOCALAPPDATA: localAppData },
    fs: winFs(winDesktopFiles(root)),
    windowsRegistrySnapshot: new Error("registry unavailable"),
  });
  assert.strictEqual(result.status, "unknown");
  assert.strictEqual(result.reason, "registry-unreadable");
});

// ---------------------------------------------------------------------------
// macOS discovery uniqueness
// ---------------------------------------------------------------------------

test("macOS returns the first valid install by default, ignoring later candidates", () => {
  const first = "/Applications/DeepSeek Harness.app";
  const second = "/Users/me/Applications/DeepSeek Harness.app";
  const result = discoverDshDesktopSync({
    platform: "darwin",
    fs: macFs([first, second]),
    desktopAppPaths: [first, second],
  });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, first);
  assert.deepStrictEqual(result.checkedPaths, [first]);
});

test("macOS requireUniqueApp reports two valid installs as ambiguous", () => {
  const first = "/Applications/DeepSeek Harness.app";
  const second = "/Users/me/Applications/DeepSeek Harness.app";
  const result = discoverDshDesktopSync({
    platform: "darwin",
    fs: macFs([first, second]),
    desktopAppPaths: [first, second],
    requireUniqueApp: true,
  });
  assert.strictEqual(result.status, "ambiguous");
  assert.strictEqual(result.reason, "multiple-desktop-installs");
  assert.strictEqual(result.appRoot, null);
  assert.strictEqual(result.candidates.length, 2);
  assert.deepStrictEqual(result.checkedPaths, [first, second]);
});

test("a macOS install symlinked into both locations is still one install", () => {
  const real = "/Applications/DeepSeek Harness.app";
  const link = "/Users/me/Applications/DeepSeek Harness.app";
  const result = discoverDshDesktopSync({
    platform: "darwin",
    fs: macFs([real, link], {
      realpath: new Map([[path.resolve(link), path.resolve(real)]]),
    }),
    desktopAppPaths: [real, link],
    requireUniqueApp: true,
  });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, real);
});

test("macOS requireUniqueApp still finds a single valid install", () => {
  const root = "/Applications/DeepSeek Harness.app";
  const result = discoverDshDesktopSync({
    platform: "darwin",
    fs: macFs([root]),
    desktopAppPaths: [root],
    requireUniqueApp: true,
  });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, root);
  assert.strictEqual(result.reason, null);
});

test("macOS uniqueness reports an unreadable second candidate as unknown", () => {
  const first = "/Applications/DeepSeek Harness.app";
  const second = "/Users/me/Applications/DeepSeek Harness.app";
  const fs = macFsRaw({
    dirs: [first, second],
    files: { ...macValidFiles(first), [macBundlePaths(second).plist]: MAC_UNREADABLE },
  });

  const unique = discoverDshDesktopSync({
    platform: "darwin",
    fs,
    desktopAppPaths: [first, second],
    requireUniqueApp: true,
  });
  assert.strictEqual(unique.status, "unknown");
  assert.strictEqual(unique.reason, "app-bundle-unconfirmed");
  assert.strictEqual(unique.appRoot, null);

  // Without the uniqueness check the first valid candidate is still returned.
  const firstHit = discoverDshDesktopSync({ platform: "darwin", fs, desktopAppPaths: [first, second] });
  assert.strictEqual(firstHit.status, "found");
  assert.strictEqual(firstHit.appRoot, first);
});

test("macOS uniqueness reports a binary second plist as unknown", () => {
  const first = "/Applications/DeepSeek Harness.app";
  const second = "/Users/me/Applications/DeepSeek Harness.app";
  const fs = macFsRaw({
    dirs: [first, second],
    files: { ...macValidFiles(first), [macBundlePaths(second).plist]: "bplist00...." },
  });

  const unique = discoverDshDesktopSync({
    platform: "darwin",
    fs,
    desktopAppPaths: [first, second],
    requireUniqueApp: true,
  });
  assert.strictEqual(unique.status, "unknown");
  assert.strictEqual(unique.reason, "app-bundle-unconfirmed");

  const firstHit = discoverDshDesktopSync({ platform: "darwin", fs, desktopAppPaths: [first, second] });
  assert.strictEqual(firstHit.status, "found");
  assert.strictEqual(firstHit.appRoot, first);
});

test("macOS uniqueness reports a launcher-less second bundle as unknown", () => {
  const first = "/Applications/DeepSeek Harness.app";
  const second = "/Users/me/Applications/DeepSeek Harness.app";
  const fs = macFsRaw({
    dirs: [first, second],
    files: { ...macValidFiles(first), [macBundlePaths(second).plist]: MAC_PLIST },
  });

  const unique = discoverDshDesktopSync({
    platform: "darwin",
    fs,
    desktopAppPaths: [first, second],
    requireUniqueApp: true,
  });
  assert.strictEqual(unique.status, "unknown");
  assert.strictEqual(unique.reason, "launcher-missing");

  const firstHit = discoverDshDesktopSync({ platform: "darwin", fs, desktopAppPaths: [first, second] });
  assert.strictEqual(firstHit.status, "found");
  assert.strictEqual(firstHit.appRoot, first);
});

test("macOS uniqueness reports a non-ENOENT second stat failure as unknown", () => {
  const first = "/Applications/DeepSeek Harness.app";
  const second = "/Users/me/Applications/DeepSeek Harness.app";
  const fs = macFsRaw({
    dirs: [first],
    files: macValidFiles(first),
    statErrors: { [second]: "EACCES" },
  });

  const unique = discoverDshDesktopSync({
    platform: "darwin",
    fs,
    desktopAppPaths: [first, second],
    requireUniqueApp: true,
  });
  assert.strictEqual(unique.status, "unknown");
  assert.strictEqual(unique.reason, "app-bundle-unconfirmed");

  const firstHit = discoverDshDesktopSync({ platform: "darwin", fs, desktopAppPaths: [first, second] });
  assert.strictEqual(firstHit.status, "found");
  assert.strictEqual(firstHit.appRoot, first);
});

test("macOS uniqueness ignores a genuinely missing second path and a foreign app", () => {
  const first = "/Applications/DeepSeek Harness.app";
  const missing = "/Users/me/Applications/DeepSeek Harness.app";
  const foreignPlist = MAC_PLIST.replace("com.deepseek.dsh", "com.example.other");
  const fs = macFsRaw({
    dirs: [first, missing],
    files: { ...macValidFiles(first), [macBundlePaths(missing).plist]: foreignPlist },
  });

  const unique = discoverDshDesktopSync({
    platform: "darwin",
    fs,
    desktopAppPaths: [first, missing],
    requireUniqueApp: true,
  });
  assert.strictEqual(unique.status, "found");
  assert.strictEqual(unique.appRoot, first);

  const absent = macFsRaw({ dirs: [first], files: macValidFiles(first) });
  const absentResult = discoverDshDesktopSync({
    platform: "darwin",
    fs: absent,
    desktopAppPaths: [first, missing],
    requireUniqueApp: true,
  });
  assert.strictEqual(absentResult.status, "found");
  assert.strictEqual(absentResult.appRoot, first);
});

test("the registry read runs the encoded PowerShell script with a 10s timeout", async () => {
  dshInstallTest.resetWindowsRegistryCache();
  let captured = null;
  const runCommand = async (command, args, options) => {
    captured = { command, args, options };
    return { code: 0, stdout: JSON.stringify({ uninstall: [], commandDirectory: null }) };
  };
  await discoverDshDesktop({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\L" },
    runCommand,
  });
  assert.strictEqual(captured.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepStrictEqual(
    captured.args.slice(0, 5),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]
  );
  assert.strictEqual(
    Buffer.from(captured.args[5], "base64").toString("utf16le"),
    dshInstallTest.DSH_WINDOWS_REGISTRY_SCRIPT
  );
  assert.strictEqual(captured.options.timeoutMs, 10000);
  dshInstallTest.resetWindowsRegistryCache();
});

test("the registry script fails closed and uses literal paths", () => {
  const script = dshInstallTest.DSH_WINDOWS_REGISTRY_SCRIPT;
  assert.match(script, /\$ErrorActionPreference = 'Stop'/);
  assert.match(script, /\btry \{/);
  assert.match(script, /\bcatch \{/);
  assert.match(script, /exit 0/);
  assert.match(script, /exit 1/);
  assert.match(script, /-LiteralPath/);
  assert.match(script, /-is \[string\]/);
});

test("static Windows discovery is pending until an async read primes it", async () => {
  dshInstallTest.resetWindowsRegistryCache();
  const env = { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\cache-me\\AppData\\Local" };
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return { code: 0, stdout: JSON.stringify({ uninstall: [], commandDirectory: null }) };
  };
  const before = discoverDshDesktopSync({ platform: "win32", env, runCommand });
  assert.strictEqual(before.status, "unknown");
  assert.strictEqual(before.reason, "windows-discovery-pending");
  assert.strictEqual(calls, 0);

  const primed = await discoverDshDesktop({ platform: "win32", env, runCommand });
  const after = discoverDshDesktopSync({ platform: "win32", env, runCommand });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(after, primed);
  dshInstallTest.resetWindowsRegistryCache();
});

test("the cached snapshot never expires on its own", async () => {
  dshInstallTest.resetWindowsRegistryCache();
  const env = { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\no-expiry\\AppData\\Local" };
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return { code: 0, stdout: JSON.stringify({ uninstall: [], commandDirectory: null }) };
  };
  const primed = await discoverDshDesktop({ platform: "win32", env, runCommand });
  const muchLater = discoverDshDesktopSync({ platform: "win32", env, runCommand, now: 10 ** 9 });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(muchLater, primed);
  dshInstallTest.resetWindowsRegistryCache();
});

test("refreshDshDesktopDiscovery primes the static cache", async () => {
  dshInstallTest.resetWindowsRegistryCache();
  const env = { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\preheat-me\\AppData\\Local" };
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return { code: 0, stdout: JSON.stringify({ uninstall: [], commandDirectory: null }) };
  };
  assert.strictEqual(
    discoverDshDesktopSync({ platform: "win32", env }).reason,
    "windows-discovery-pending"
  );
  await refreshDshDesktopDiscovery({ platform: "win32", env, runCommand });
  assert.notStrictEqual(
    discoverDshDesktopSync({ platform: "win32", env }).reason,
    "windows-discovery-pending"
  );
  assert.strictEqual(calls, 1);
  dshInstallTest.resetWindowsRegistryCache();
});

test("a cached snapshot is re-verified against the current files", async () => {
  dshInstallTest.resetWindowsRegistryCache();
  const env = { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\reverify-me\\AppData\\Local" };
  const root = "C:\\Tools\\DeepSeek Harness";
  const runCommand = async () => ({
    code: 0,
    stdout: JSON.stringify({ uninstall: [{ installLocation: root, displayVersion: FAMILY_VERSION }], commandDirectory: null }),
  });
  const primed = await discoverDshDesktop({
    platform: "win32",
    env,
    fs: winFs(winDesktopFiles(root)),
    runCommand,
  });
  assert.strictEqual(primed.status, "found");

  const removed = discoverDshDesktopSync({ platform: "win32", env, fs: winFs({}) });
  assert.strictEqual(removed.status, "not-found");
  dshInstallTest.resetWindowsRegistryCache();
});

test("the async Windows entry re-reads the registry every time", async () => {
  dshInstallTest.resetWindowsRegistryCache();
  const env = { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\async-me\\AppData\\Local" };
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return { code: 0, stdout: JSON.stringify({ uninstall: [], commandDirectory: null }) };
  };
  await discoverDshDesktop({ platform: "win32", env, runCommand });
  await discoverDshDesktop({ platform: "win32", env, runCommand });
  assert.strictEqual(calls, 2);
  dshInstallTest.resetWindowsRegistryCache();
});

test("the async Windows entry honors an injected snapshot and an Error", async () => {
  const root = "C:\\Tools\\DeepSeek Harness";
  const found = await discoverDshDesktop({
    platform: "win32",
    fs: winFs(winDesktopFiles(root)),
    windowsRegistrySnapshot: { uninstall: [{ installLocation: root }], commandDirectory: null },
  });
  assert.strictEqual(found.status, "found");
  const broken = await discoverDshDesktop({
    platform: "win32",
    windowsRegistrySnapshot: new Error("nope"),
  });
  assert.strictEqual(broken.status, "unknown");
  assert.strictEqual(broken.reason, "registry-unreadable");
});

test("Windows discovery accepts app.asar reported as a directory (Electron fs)", () => {
  const root = "C:\\Tools\\DeepSeek Harness";
  const result = discoverDshDesktopSync({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    fs: winStatFs(windowsDesktopEntries(root, "dir")),
    windowsRegistrySnapshot: {
      uninstall: [{ installLocation: root, displayVersion: FAMILY_VERSION }],
      commandDirectory: null,
    },
  });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, root);
  assert.strictEqual(result.staticVersion, FAMILY_VERSION);
});

test("Windows discovery accepts app.asar reported as a file (plain Node fs)", () => {
  const root = "C:\\Tools\\DeepSeek Harness";
  const result = discoverDshDesktopSync({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    fs: winStatFs(windowsDesktopEntries(root, "file")),
    windowsRegistrySnapshot: {
      uninstall: [{ installLocation: root, displayVersion: FAMILY_VERSION }],
      commandDirectory: null,
    },
  });
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.appRoot, root);
});

test("Windows discovery rejects a root without app.asar", () => {
  const root = "C:\\Tools\\DeepSeek Harness";
  const entries = windowsDesktopEntries(root, "file")
    .filter(([entryPath]) => !entryPath.endsWith("app.asar"));
  const result = discoverDshDesktopSync({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    fs: winStatFs(entries),
    windowsRegistrySnapshot: {
      uninstall: [{ installLocation: root, displayVersion: FAMILY_VERSION }],
      commandDirectory: null,
    },
  });
  assert.strictEqual(result.status, "not-found");
  assert.ok(result.checkedPaths.includes(root));
});

test("Windows discovery rejects a root whose exe or launcher is a directory", () => {
  const root = "C:\\Tools\\DeepSeek Harness";
  const exeAsDir = windowsDesktopEntries(root, "file");
  exeAsDir[0][1] = "dir";
  assert.strictEqual(
    discoverDshDesktopSync({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      fs: winStatFs(exeAsDir),
      windowsRegistrySnapshot: {
        uninstall: [{ installLocation: root, displayVersion: FAMILY_VERSION }],
        commandDirectory: null,
      },
    }).status,
    "not-found"
  );

  const cmdAsDir = windowsDesktopEntries(root, "file");
  cmdAsDir[1][1] = "dir";
  assert.strictEqual(
    discoverDshDesktopSync({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      fs: winStatFs(cmdAsDir),
      windowsRegistrySnapshot: {
        uninstall: [{ installLocation: root, displayVersion: FAMILY_VERSION }],
        commandDirectory: null,
      },
    }).status,
    "not-found"
  );
});

// ---------------------------------------------------------------------------
// Operation-mode target resolution
// ---------------------------------------------------------------------------

test("a mutable web target with an available carrier keeps its version", async (t) => {
  const env = makeHome(t);
  writeProfile(env.dshHome, "web");
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "dsh"), "#!/bin/sh\n");
  let probed = false;
  const result = await resolveDshTargets({
    dshHome: env.dshHome,
    managedRoot: env.managedRoot,
    sourceDir: SOURCE_DIR,
    dshInstallRoot: null,
    env: { PATH: bin },
    desktopDiscovery: { status: "not-found", appRoot: null, launcherPath: null, staticVersion: null, checkedPaths: [], reason: null },
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
    runCommand: async (_command, args) => {
      probed = args.includes("--version");
      return { code: 0, stdout: `${FAMILY_VERSION}\n` };
    },
  }, { operation: "startup-sync" });
  assert.strictEqual(probed, true);
  assert.strictEqual(result.web.role, "mutable");
  assert.strictEqual(result.web.carrier.status, "available");
  assert.strictEqual(result.web.carrier.version, FAMILY_VERSION);
  assert.ok(result.web.carrier.commandInfo);
});

test("operation probes report the three failure reasons separately", async (t) => {
  const cases = [
    { runCommand: async () => ({ code: 1 }), reason: "carrier-failed" },
    { runCommand: async () => ({ code: 0, stdout: "garbage\n" }), reason: "version-invalid" },
    { runCommand: async () => ({ code: 0, stdout: "0.9.0\n" }), reason: "version-unsupported" },
  ];
  for (const entry of cases) {
    const env = makeHome(t);
    writeProfile(env.dshHome, "web");
    const bin = path.join(env.root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "dsh"), "#!/bin/sh\n");
    const result = await resolveDshTargets({
      dshHome: env.dshHome,
      managedRoot: env.managedRoot,
      sourceDir: SOURCE_DIR,
      dshInstallRoot: null,
      env: { PATH: bin },
      desktopDiscovery: { status: "not-found", appRoot: null, launcherPath: null, staticVersion: null, checkedPaths: [], reason: null },
      commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
      runCommand: entry.runCommand,
    }, { operation: "startup-sync" });
    assert.strictEqual(result.web.role, "diagnose");
    assert.strictEqual(result.web.reason, entry.reason);
  }
});

test("a desktop carrier that cannot be recognized is diagnosed", async () => {
  const staticTarget = {
    profile: "desktop",
    role: "mutable",
    evidence: {},
    carrier: {},
    discovery: null,
    manualFallback: false,
    initializesProfile: false,
  };
  const result = await dshInstallTest.resolveDshTargetCarrier(
    staticTarget,
    "desktop",
    { platform: "win32", fs: winFs({ [WIN_CMD]: "not the template\n", [WIN_EXE]: "exe" }) },
    "install",
    desktopFound(WIN_CMD)
  );
  assert.strictEqual(result.role, "diagnose");
  assert.strictEqual(result.reason, "launcher-unrecognized");
});

test("a mutable web target with no command falls back to the no-command decision", async () => {
  const staticTarget = {
    profile: "web",
    role: "mutable",
    evidence: { manifest: "present", registration: "none", manualReference: "none", latch: "none" },
    carrier: {},
    discovery: null,
    manualFallback: false,
    initializesProfile: false,
  };
  const result = await dshInstallTest.resolveDshWebTarget(
    staticTarget,
    { dshCommand: false },
    "startup-sync"
  );
  assert.strictEqual(result.role, "diagnose");
  assert.strictEqual(result.reason, "cli-unavailable");
  assert.strictEqual(result.manualFallback, true);
});

test("a static diagnose target is not probed in operation mode", async () => {
  const staticTarget = {
    profile: "desktop",
    role: "diagnose",
    reason: "foreign-package",
    evidence: {},
    carrier: {},
    discovery: null,
    manualFallback: false,
    initializesProfile: false,
  };
  let called = false;
  const result = await dshInstallTest.resolveDshTargetCarrier(
    staticTarget,
    "desktop",
    { runCommand: async () => { called = true; return { code: 0 }; } },
    "install",
    desktopFound()
  );
  assert.deepStrictEqual(result, staticTarget);
  assert.strictEqual(called, false);
});

test("an ambiguous desktop install is diagnosed and not probed", async (t) => {
  const env = makeHome(t);
  writeProfile(env.dshHome, "desktop");
  let called = false;
  const result = await resolveDshTargets({
    dshHome: env.dshHome,
    managedRoot: env.managedRoot,
    sourceDir: SOURCE_DIR,
    dshInstallRoot: null,
    env: { PATH: "" },
    desktopDiscovery: {
      status: "ambiguous",
      appRoot: null,
      launcherPath: null,
      staticVersion: null,
      checkedPaths: [],
      reason: "multiple-desktop-installs",
      candidates: [],
    },
    runCommand: async (_program, args) => {
      if (args.includes("--version")) called = true;
      return { code: 0 };
    },
  }, { operation: "install" });
  assert.strictEqual(result.desktop.role, "diagnose");
  assert.strictEqual(result.desktop.reason, "multiple-desktop-installs");
  assert.strictEqual(called, false);
});

test("a mutable desktop target with an available carrier is probed", async (t) => {
  const env = makeHome(t);
  writeProfile(env.dshHome, "desktop");
  let probed = false;
  const result = await resolveDshTargets({
    dshHome: env.dshHome,
    managedRoot: env.managedRoot,
    sourceDir: SOURCE_DIR,
    dshInstallRoot: null,
    env: { PATH: "" },
    desktopDiscovery: platformDesktopFound(env.root),
    runCommand: async (_command, args) => {
      probed = args.includes("--version");
      return { code: 0, stdout: `${FAMILY_VERSION}\n` };
    },
  }, { operation: "install" });
  assert.strictEqual(probed, true);
  assert.strictEqual(result.desktop.role, "mutable");
  assert.strictEqual(result.desktop.carrier.kind, "desktop");
  assert.strictEqual(result.desktop.carrier.version, FAMILY_VERSION);
});
