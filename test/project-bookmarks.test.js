"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("node:test");
const {
  MAX_PROJECT_BOOKMARKS,
  normalizeProjectBookmark,
  normalizeProjectBookmarks,
  validateProjectBookmarks,
  createProjectBookmarkLauncher,
} = require("../src/project-bookmarks");

const WIN_CWD = "C:\\Projects\\a space & $literal 'quote' !percent%";
const WIN_CLI = "C:\\Tools\\a space & $literal 'quote'\\codex.exe";
const POSIX_CWD = "/projects/a space 'quote' \"double\" $(touch nope);&";
const POSIX_CLI = "/tools/a space 'quote' $(touch nope);&/codex";

function bookmark(launchMode = "folder", cwd = WIN_CWD, extra = {}) {
  return { id: "project-1", name: "Project 1", cwd, launchMode, ...extra };
}

function fakeFs(folders = [WIN_CWD], files = []) {
  const all = new Map([...folders.map((target) => [target, "dir"]), ...files.map((target) => [target, "file"])]);
  return {
    existsSync: (target) => all.has(target),
    statSync(target) {
      if (!all.has(target)) throw Object.assign(new Error("unavailable"), { code: "ENOENT" });
      return { isDirectory: () => all.get(target) === "dir", isFile: () => all.get(target) === "file" };
    },
    accessSync(target) { if (!all.has(target)) throw new Error("not executable"); },
  };
}

describe("project bookmark data boundaries", () => {
  it("loads pure normalizers without loading launch or child-process dependencies", () => {
    const Module = require("node:module");
    const filename = require.resolve("../src/project-bookmarks");
    const savedCache = require.cache[filename];
    const originalLoad = Module._load;
    delete require.cache[filename];
    try {
      Module._load = function (request, ...args) {
        if (request === "./launch-claude" || /^(node:)?child_process$/.test(request)) throw new Error("runtime dependency loaded by prefs normalizer");
        return originalLoad.call(this, request, ...args);
      };
      const pure = require("../src/project-bookmarks");
      assert.equal(pure.validateProjectBookmarks([bookmark()], { platform: "win32" }).ok, true);
    } finally {
      Module._load = originalLoad;
      require.cache[filename] = savedCache;
    }
  });
  it("normalizes known fields without modifying the original", () => {
    const value = bookmark("folder", "C:/Projects/one/../two", { id: "  uuid_1-2  ", name: "  项目  " });
    const result = normalizeProjectBookmark(value, { platform: "win32" });
    assert.deepEqual(result, { id: "uuid_1-2", name: "项目", cwd: "C:\\Projects\\two", launchMode: "folder" });
    assert.equal(value.id, "  uuid_1-2  ");
  });

  it("accepts all four modes and local root folders", () => {
    for (const launchMode of ["folder", "terminal", "claude", "codex"]) {
      assert.equal(normalizeProjectBookmark(bookmark(launchMode, "C:\\"), { platform: "win32" }).launchMode, launchMode);
      assert.equal(normalizeProjectBookmark(bookmark(launchMode, "/"), { platform: "linux" }).cwd, "/");
    }
  });

  it("keeps POSIX quotes, dollar signs, shell syntax and trailing spaces literal", () => {
    const cwd = POSIX_CWD + "  ";
    assert.equal(normalizeProjectBookmark(bookmark("folder", cwd), { platform: "linux" }).cwd, cwd);
  });

  it("rejects relative, network, device, URL and wrong-platform paths", () => {
    for (const cwd of ["relative", "C:relative", "\\rooted", "\\\\server\\share", "\\\\?\\C:\\project", "file:///C:/project", "/projects", "C:\\a\" & calc", "C:\\a?", "C:\\a:stream"]) {
      assert.equal(normalizeProjectBookmark(bookmark("folder", cwd), { platform: "win32" }), null, cwd);
    }
    for (const cwd of ["relative", "C:\\project", "//server/share", "ssh://host/project", "~/project"]) {
      assert.equal(normalizeProjectBookmark(bookmark("folder", cwd), { platform: "linux" }), null, cwd);
    }
  });

  it("rejects controls, oversized text, arbitrary commands and automatic startup", () => {
    for (const extra of [
      { id: "bad id" }, { name: "\nname" }, { name: "x".repeat(81) },
      { cwd: "C:\\a\0b" }, { cwd: "C:\\" + "x".repeat(2048) }, { launchMode: "dangerous" },
      { launchMode: "resume" }, { command: "calc.exe" }, { autoStart: true }, { args: ["--yolo"] },
      { launchMode: "codex --dangerously-bypass-approvals-and-sandbox" },
    ]) {
      assert.equal(normalizeProjectBookmark(bookmark("folder", WIN_CWD, extra), { platform: "win32" }), null);
    }
  });

  it("bounds normalizing work and rejects oversized edits", () => {
    const records = Array.from({ length: MAX_PROJECT_BOOKMARKS }, (_, index) => bookmark("folder", `C:\\p${index}`, { id: `id-${index}`, name: `Name ${index}` }));
    records.push({ get id() { throw new Error("must not scan beyond 32"); } });
    assert.equal(normalizeProjectBookmarks(records, { platform: "win32" }).length, 32);
    assert.equal(validateProjectBookmarks(records, { platform: "win32" }).ok, false);
  });

  it("deduplicates IDs and names case-insensitively and Windows normalized folders", () => {
    const records = [bookmark(), bookmark("folder", "C:\\new", { id: "PROJECT-1", name: "Other" }),
      bookmark("folder", "C:\\another", { id: "id-2", name: "PROJECT 1" }),
      bookmark("codex", WIN_CWD.toLowerCase(), { id: "id-3", name: "Three" })];
    assert.equal(normalizeProjectBookmarks(records, { platform: "win32" }).length, 1);
    assert.equal(validateProjectBookmarks(records, { platform: "win32" }).ok, false);
  });

  it("keeps POSIX folders case-sensitive and validates exact normalized output", () => {
    const records = [bookmark("folder", "/Case"), bookmark("folder", "/case", { id: "id-2", name: "Two" })];
    assert.deepEqual(validateProjectBookmarks(records, { platform: "darwin" }), { ok: true, value: records });
    assert.deepEqual(normalizeProjectBookmarks(null), []);
    assert.equal(validateProjectBookmarks({}).ok, false);
    assert.deepEqual(validateProjectBookmarks([], { platform: "linux" }), { ok: true, value: [] });
  });

  it("does not treat trailing separators as distinct project folders", () => {
    for (const [platform, cwd, alternate] of [["win32", "C:\\project", "C:/project/"], ["linux", "/project", "/project/"]]) {
      const records = [bookmark("folder", cwd), bookmark("codex", alternate, { id: "second", name: "Second" })];
      assert.equal(normalizeProjectBookmarks(records, { platform }).length, 1);
      assert.equal(validateProjectBookmarks(records, { platform }).ok, false);
    }
  });
});

describe("project bookmark launcher", () => {
  it("cancels without probing when the initiating owner is already closed", async () => {
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: { statSync() { throw new Error("must not probe"); } } });
    assert.deepEqual(await launcher.launch(bookmark(), { canLaunch: () => false }), { ok: false, code: "CANCELLED" });
    assert.deepEqual(await launcher.launch(bookmark(), { canLaunch: () => { throw new Error("disposed"); } }), { ok: false, code: "CANCELLED" });
  });

  it("rechecks the owner after an asynchronous directory probe", async () => {
    let stillOpen = true, releaseProbe;
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: { promises: { stat: async () => new Promise((resolve) => { releaseProbe = resolve; }) } }, shell: { openPath() { throw new Error("closed owner must not open folder"); } } });
    const pending = launcher.launch(bookmark(), { canLaunch: () => stillOpen });
    stillOpen = false;
    releaseProbe({ isDirectory: () => true });
    assert.deepEqual(await pending, { ok: false, code: "CANCELLED" });
  });

  it("rechecks a deleted bookmark after either CLI lookup awaits", async () => {
    for (const mode of ["claude", "codex"]) {
      let present = true, releaseLookup, pending;
      const cli = "C:\\Tools\\" + mode + ".exe";
      const lookupStarted = new Promise((resolve) => {
        const finder = async () => new Promise((done) => { releaseLookup = done; resolve(); });
        const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs([WIN_CWD], [cli]),
          findClaudeCmd: finder, findCodexCmd: finder, tryLaunch: async () => { throw new Error("deleted bookmark must not launch"); } });
        pending = launcher.launch(bookmark(mode), { canLaunch: () => present });
      });
      await lookupStarted;
      present = false;
      releaseLookup(cli);
      assert.deepEqual(await pending, { ok: false, code: "CANCELLED" });
    }
  });

  it("checks again between terminal fallback attempts for all launch modes", async () => {
    for (const [mode, platform, cwd, cli] of [
      ["terminal", "win32", WIN_CWD, WIN_CLI], ["claude", "win32", WIN_CWD, WIN_CLI],
      ["codex", "win32", WIN_CWD, WIN_CLI], ["claude", "linux", POSIX_CWD, POSIX_CLI],
    ]) {
      let stillOpen = true;
      const calls = [];
      const launcher = createProjectBookmarkLauncher({ platform, fs: fakeFs([cwd], [cli]), findClaudeCmd: async () => cli, findCodexCmd: async () => cli,
        tryLaunch: async (bin) => { calls.push(bin); stillOpen = false; return { ok: false, error: new Error("missing terminal") }; } });
      assert.deepEqual(await launcher.launch(bookmark(mode, cwd), { canLaunch: () => stillOpen }), { ok: false, code: "CANCELLED" });
      assert.equal(calls.length, 1, mode + platform);
    }
  });

  it("rejects an asynchronous or malformed guard rather than treating it as approval", async () => {
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs() });
    for (const canLaunch of [true, () => Promise.resolve(true)]) {
      assert.deepEqual(await launcher.launch(bookmark(), { canLaunch }), { ok: false, code: "CANCELLED" });
    }
  });
  it("does no filesystem probing or launching on construction or normalization", () => {
    const unexpected = () => { throw new Error("automatic action"); };
    createProjectBookmarkLauncher({ fs: { statSync: unexpected }, tryLaunch: unexpected, execFileAsync: unexpected });
    normalizeProjectBookmarks([bookmark()], { platform: "win32" });
  });

  it("rejects invalid input before filesystem access", async () => {
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: { statSync() { throw new Error("must not probe"); } } });
    assert.equal((await launcher.launch(bookmark("folder", WIN_CWD, { command: "calc" }))).code, "BOOKMARK_INVALID");
  });

  it("checks current directory availability before any external action", async () => {
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs([], [WIN_CWD]), shell: { openPath() { throw new Error("must not open"); } } });
    assert.equal((await launcher.launch(bookmark())).code, "FOLDER_UNAVAILABLE");
    assert.equal((await launcher.launch(bookmark("codex", "C:\\missing"))).code, "FOLDER_UNAVAILABLE");
  });

  it("opens an existing folder as a literal native path", async () => {
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs(), shell: { async openPath(cwd) { calls.push(cwd); return ""; } } });
    assert.deepEqual(await launcher.launch(bookmark()), { ok: true });
    assert.deepEqual(calls, [WIN_CWD]);
  });

  it("reports file-browser and thrown launch failures for UI", async () => {
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs(), shell: { async openPath() { return "The system could not open this folder."; } } });
    assert.equal((await launcher.launch(bookmark())).code, "FOLDER_OPEN_FAILED");
    const throwing = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs(), shell: { async openPath() { throw new Error("OS failed"); } } });
    assert.deepEqual(await throwing.launch(bookmark()), { ok: false, code: "LAUNCH_FAILED", message: "OS failed" });
  });

  it("reuses the plain-terminal launcher with exactly the saved directory", async () => {
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs(), openTerminalAt: async (cwd, deps) => { calls.push([cwd, deps.platform()]); return { ok: true, terminal: "wt.exe" }; } });
    assert.deepEqual(await launcher.launch(bookmark("terminal")), { ok: true, terminal: "wt.exe" });
    assert.deepEqual(calls, [[WIN_CWD, "win32"]]);
  });

  it("keeps percent-containing directories away from the existing cmd fallback", async () => {
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs(), tryLaunch: async (bin, args, options) => { calls.push({ bin, args, options }); return bin === "powershell.exe" ? { ok: true } : { ok: false, error: new Error("unavailable") }; } });
    assert.equal((await launcher.launch(bookmark("terminal"))).ok, true);
    assert.deepEqual(calls.map((call) => call.bin), ["wt.exe", "powershell.exe"]);
    assert.equal(calls[1].options.cwd, WIN_CWD);
    assert.match(calls[1].args.at(-1), /^Set-Location -LiteralPath '/);
  });

  it("does not open a terminal when either CLI is missing", async () => {
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs(), findClaudeCmd: async () => "claude", execFileAsync: async (bin, args, options) => { calls.push({ bin, args, options }); return { stdout: "" }; }, tryLaunch: async () => { throw new Error("must not spawn"); } });
    assert.equal((await launcher.launch(bookmark("claude"))).code, "CLI_NOT_FOUND");
    assert.equal((await launcher.launch(bookmark("codex"))).code, "CLI_NOT_FOUND");
    assert.equal(calls[0].bin, "where.exe");
    assert.deepEqual(calls[0].args, ["codex"]);
    assert.equal(calls[0].options.timeout, 5000);
  });

  it("prefers a verified native Windows Codex binary over npm shims", async () => {
    const shim = "C:\\Tools\\codex.cmd";
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs([WIN_CWD], [shim, WIN_CLI]), execFileAsync: async () => ({ stdout: shim + "\r\n" + WIN_CLI + "\r\n" }), tryLaunch: async (bin, args, options) => { calls.push({ bin, args, options }); return { ok: true }; } });
    assert.deepEqual(await launcher.launch(bookmark("codex")), { ok: true, terminal: "powershell.exe", launched: "terminal" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "powershell.exe");
    assert.deepEqual(calls[0].args, ["-NoProfile", "-NoExit", "-Command", "& 'C:\\Tools\\a space & $literal ''quote''\\codex.exe'"]);
    assert.equal(calls[0].options.cwd, WIN_CWD);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide, false);
    assert.ok(!calls[0].args.join(" ").includes(WIN_CWD));
  });

  it("probes a launchable sibling when where reports an extensionless npm shim", async () => {
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs([WIN_CWD], ["C:\\npm\\codex.cmd"]), execFileAsync: async () => ({ stdout: "C:\\npm\\codex\r\n" }), tryLaunch: async (bin, args) => { calls.push(args); return { ok: true }; } });
    assert.equal((await launcher.launch(bookmark("codex"))).ok, true);
    assert.equal(calls[0].at(-1), "& 'C:\\npm\\codex.cmd'");
  });

  it("fails closed for batch-file paths with cmd variable expansion", async () => {
    for (const cli of ["C:\\%USERNAME%\\codex.cmd", "C:\\!USERNAME!\\claude.bat"]) {
      const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs([WIN_CWD], [cli]), findCodexCmd: async () => cli, findClaudeCmd: async () => cli, tryLaunch: async () => { throw new Error("must not spawn"); } });
      assert.equal((await launcher.launch(bookmark("codex"))).code, "CLI_NOT_FOUND");
      assert.equal((await launcher.launch(bookmark("claude"))).code, "CLI_NOT_FOUND");
    }
  });

  it("allows percent and dollar characters in native executables literally", async () => {
    const cli = "C:\\%literal%!$'\\codex.exe";
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs([WIN_CWD], [cli]), findCodexCmd: async () => cli, tryLaunch: async (bin, args) => { calls.push(args); return { ok: true }; } });
    assert.equal((await launcher.launch(bookmark("codex"))).ok, true);
    assert.equal(calls[0].at(-1), "& 'C:\\%literal%!$''\\codex.exe'");
  });

  it("uses the existing Claude launcher with normal mode and safe Windows candidates", async () => {
    const cli = "C:\\Tools\\claude.exe";
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs([WIN_CWD], [cli]), findClaudeCmd: async () => cli, tryLaunch: async (bin, args, options) => { calls.push({ bin, args, options }); return { ok: true }; } });
    assert.deepEqual(await launcher.launch(bookmark("claude")), { ok: true, terminal: "powershell.exe", launched: "terminal" });
    assert.deepEqual(calls.map((call) => call.bin), ["powershell.exe"]);
    assert.deepEqual(calls[0].args, ["-NoProfile", "-NoExit", "-Command", "& 'C:\\Tools\\claude.exe'"]);
    assert.equal(calls[0].options.cwd, WIN_CWD);
    assert.ok(!calls[0].args.join(" ").includes("dangerous"));
  });

  it("never passes a resume ID, profile, prompt or approval flag to Claude", async () => {
    const cli = "C:\\Tools\\claude.exe";
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs([WIN_CWD], [cli]), findClaudeCmd: async () => cli, launchClaudeSession: async (...args) => { calls.push(args); return { ok: true, terminal: "test" }; } });
    assert.equal((await launcher.launch(bookmark("claude"))).ok, true);
    assert.equal(calls[0][0], "normal");
    assert.equal(calls[0][1], WIN_CWD);
    assert.equal(calls[0][2], undefined);
    assert.equal(calls[0].length, 4);
  });

  it("falls back to pwsh and reports terminal failure without opening repeated terminals", async () => {
    const cli = "C:\\Tools\\claude.exe";
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "win32", fs: fakeFs([WIN_CWD], [cli]), findClaudeCmd: async () => cli, tryLaunch: async (bin) => { calls.push(bin); return { ok: false, error: new Error("not available") }; } });
    assert.equal((await launcher.launch(bookmark("claude"))).code, "TERMINAL_UNAVAILABLE");
    assert.deepEqual(calls, ["powershell.exe", "pwsh.exe"]);
  });

  it("checks effective execution access on POSIX before opening a terminal", async () => {
    const deniedFs = fakeFs([POSIX_CWD], [POSIX_CLI]);
    deniedFs.accessSync = () => { throw new Error("EACCES"); };
    const launcher = createProjectBookmarkLauncher({ platform: "linux", fs: deniedFs, findCodexCmd: async () => POSIX_CLI });
    assert.equal((await launcher.launch(bookmark("codex", POSIX_CWD))).code, "CLI_NOT_FOUND");
  });

  it("quotes POSIX CLI text while passing the project directory through cwd", async () => {
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "linux", fs: fakeFs([POSIX_CWD], [POSIX_CLI]), findCodexCmd: async () => POSIX_CLI, tryLaunch: async (bin, args, options) => { calls.push({ bin, args, options }); return { ok: true }; } });
    assert.equal((await launcher.launch(bookmark("codex", POSIX_CWD))).launched, "terminal");
    assert.deepEqual(calls[0].args.slice(0, 3), ["-e", "bash", "-c"]);
    assert.equal(calls[0].args[3], "'/tools/a space '\\''quote'\\'' $(touch nope);&/codex'; exec bash");
    assert.equal(calls[0].options.cwd, POSIX_CWD);
    assert.equal(calls[0].options.shell, false);
  });

  it("quotes both AppleScript and POSIX layers for Terminal.app", async () => {
    const calls = [];
    const launcher = createProjectBookmarkLauncher({ platform: "darwin", fs: fakeFs([POSIX_CWD], [POSIX_CLI]), findCodexCmd: async () => POSIX_CLI, tryLaunch: async (bin, args, options) => { calls.push({ bin, args, options }); return { ok: true }; } });
    assert.equal((await launcher.launch(bookmark("codex", POSIX_CWD))).ok, true);
    assert.equal(calls[0].bin, "osascript");
    assert.deepEqual(calls[0].args.slice(0, 1), ["-e"]);
    assert.match(calls[0].args[1], /^tell application "Terminal" to do script "cd -- '/);
    assert.ok(calls[0].args[1].includes('\\"double\\"'));
    assert.ok(calls[0].args[1].includes("$(touch nope)"));
    assert.equal(calls[0].options.cwd, POSIX_CWD);
  });

  it("supports async filesystem checks and verifies real directories without opening a session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-bookmark-test-"));
    const cwd = path.join(root, "space & $literal 'quote' %value%");
    try {
      fs.mkdirSync(cwd);
      const calls = [];
      const launcher = createProjectBookmarkLauncher({ shell: { async openPath(target) { calls.push(target); return ""; } } });
      assert.equal((await launcher.launch(bookmark("folder", cwd))).ok, true);
      fs.rmdirSync(cwd);
      assert.equal((await launcher.launch(bookmark("folder", cwd))).code, "FOLDER_UNAVAILABLE");
      assert.deepEqual(calls, [cwd]);
    } finally {
      if (fs.existsSync(cwd)) fs.rmdirSync(cwd);
      fs.rmdirSync(root);
    }
  });

  it("round-trips the fixed PowerShell invocation with a harmless test-owned npm shim", { skip: process.platform !== "win32" }, async () => {
    // This runs a tiny echo fixture in a hidden noninteractive shell, not an
    // Agent, a user's CLI, or a detached terminal. Every file is owned here.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-bookmark-ps-"));
    const toolDir = path.join(root, "tools & $literal 'quote'");
    const cwd = path.join(root, "project & $literal 'quote' %value% 目录");
    const cli = path.join(toolDir, "codex.cmd");
    try {
      fs.mkdirSync(toolDir);
      fs.mkdirSync(cwd);
      fs.writeFileSync(cli, '@echo off\r\necho CLI-LITERAL-ONLY\r\necho "%CD%"\r\n');
      const calls = [];
      const launcher = createProjectBookmarkLauncher({ findCodexCmd: async () => cli, tryLaunch: async (bin, args, options) => { calls.push({ bin, args, options }); return { ok: true }; } });
      assert.equal((await launcher.launch(bookmark("codex", cwd))).ok, true);
      // Capture native CMD output as UTF-8, including non-ASCII temp paths.
      const command = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); " + calls[0].args.at(-1);
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        cwd: calls[0].options.cwd, encoding: "utf8", windowsHide: true, timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      const lines = result.stdout.trim().split(/\r?\n/);
      assert.equal(lines.length, 2);
      assert.equal(lines[0], "CLI-LITERAL-ONLY");
      assert.match(lines[1], /^".+"$/);
      // Windows temp paths may contain 8.3 aliases (e.g. RUNNER~1), while
      // PowerShell/cmd expands them in %CD%. Verify the same real directory
      // without weakening the literal quoting or exact-output checks.
      assert.equal(fs.realpathSync.native(lines[1].slice(1, -1)), fs.realpathSync.native(cwd));
    } finally {
      if (fs.existsSync(cli)) fs.unlinkSync(cli);
      if (fs.existsSync(toolDir)) fs.rmdirSync(toolDir);
      if (fs.existsSync(cwd)) fs.rmdirSync(cwd);
      fs.rmdirSync(root);
    }
  });
});
