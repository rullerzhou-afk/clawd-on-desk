const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOKS = path.join(__dirname, "..", "hooks");
const ALL_FILES = fs.readdirSync(HOOKS).filter((name) => name.endsWith(".js"));
// Historical #901 payload, deliberately independent of the corrected guide.
const OLD_FILES = [
  "server-config", "json-utils", "shared-process", "clawd-hook", "install",
  "codex-hook", "codex-install", "codex-install-utils", "codex-remote-monitor",
  "codex-session-index", "codex-subagent-fields", "copilot-hook", "copilot-install",
].map((name) => `${name}.js`);

function fixture(t, files = ALL_FILES) {
  // Space also exercises source-path handling; this does not execute the
  // generated WSL command, whose unquoted paths have a separate limitation.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, ".claude");
  const hooks = path.join(config, "hooks");
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const name of files) fs.copyFileSync(path.join(HOOKS, name), path.join(hooks, name));
  if (process.platform !== "win32") {
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nprintf '2.1.235 (Claude Code)\\n'\n", { mode: 0o700 });
  }
  const env = {
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    PATH: [bin, path.dirname(process.execPath), ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(path.delimiter),
    TMPDIR: home, TMP: home, TEMP: home,
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const settings = path.join(config, "settings.json");
  return {
    home, hooks, settings,
    read: () => JSON.parse(fs.readFileSync(settings, "utf8")),
    run: (args = [], extraEnv = {}) => {
      const result = spawnSync(process.execPath, [path.join(hooks, "install.js"), ...args], {
        cwd: home, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 20000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    },
  };
}

function snapshot(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true }).sort().map((name) => {
    const file = path.join(root, name);
    return [name, fs.statSync(file).isDirectory() ? null : fs.readFileSync(file).toString("base64")];
  }));
}
function refused(f, args, expected, env) {
  const before = snapshot(f.home);
  const result = f.run(args, env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(snapshot(f.home), before, "preflight must not write config, backups, sidecars, or hook files");
  assert.doesNotMatch(result.stdout, /hooks installed|statusline.*updated/);
  if (expected) assert.match(result.stderr, expected);
  return result;
}

describe("Claude installer CLI dependency preflight", () => {
  for (const args of [[], ["--remote"]]) {
    it(`rejects the old documented subset before creating settings (${args.join(" ") || "no flags"})`, (t) => {
      const f = fixture(t, OLD_FILES);
      const result = refused(f, args, /state-payload-size\.js/);
      assert.equal(fs.existsSync(f.settings), false);
      if (args.length) assert.match(result.stderr, /claude-statusline\.js/);
    });
  }
  it("leaves pre-existing user config and a chain sidecar byte-for-byte unchanged", (t) => {
    const f = fixture(t, OLD_FILES);
    fs.writeFileSync(f.settings, '{\n "theme":"user", "hooks":{"Stop":[{"hooks":[{"type":"command","command":"my-hook"}]}]}, "statusLine":{"type":"command","command":"my-status"}\n}\n');
    fs.writeFileSync(path.join(f.hooks, "clawd-statusline-chain.json"), '{"user":"original"}\n');
    refused(f, ["--remote", "--chain-existing"], /refusing to install/);
  });
  for (const args of [[], ["--remote"], ["--statusline"]]) {
    it(`installs the full payload with ${args.join(" ") || "no flags"}`, (t) => {
      const f = fixture(t);
      const result = f.run(args);
      assert.equal(result.status, 0, result.stderr);
      const settings = f.read();
      assert.ok(settings.hooks.UserPromptSubmit.some((e) => e.hooks.some((h) => h.command.includes("clawd-hook.js"))));
      if (args.length) {
        assert.ok(settings.statusLine.command.includes("claude-statusline.js"));
        assert.ok(fs.existsSync(path.join(f.hooks, "claude-statusline.js")));
        if (args[0] === "--statusline") assert.doesNotMatch(settings.statusLine.command, /CLAWD_REMOTE=/);
      } else assert.equal(settings.statusLine, undefined);
    });
  }
  it("checks statusline only when requested, before writing any state hooks", (t) => {
    for (const args of [["--remote"], ["--statusline"], []]) {
      const f = fixture(t, ALL_FILES.filter((n) => n !== "claude-statusline.js"));
      if (args.length) refused(f, args, /claude-statusline\.js/);
      else assert.equal(f.run().status, 0);
    }
  });
  it("rejects a missing transitive dependency", (t) => {
    const f = fixture(t, ALL_FILES.filter((n) => n !== "pid-cache.js"));
    refused(f, [], /pid-cache\.js.*required by shared-process\.js/);
  });
  it("does not require the opt-in auto-start entry", (t) => {
    const f = fixture(t, ALL_FILES.filter((n) => n !== "auto-start.js"));
    assert.equal(f.run(["--remote"]).status, 0);
  });
  it("rejects a directory in place of a script on every platform", (t) => {
    const f = fixture(t, ALL_FILES.filter((n) => n !== "clawd-hook.js"));
    fs.mkdirSync(path.join(f.hooks, "clawd-hook.js"));
    refused(f, [], /clawd-hook\.js.*NOT_FILE/);
  });
  it("rejects an unreadable dependency when the OS enforces its mode", (t) => {
    if (process.platform === "win32" || (process.getuid && process.getuid() === 0)) return t.skip("POSIX non-root permission check only");
    const f = fixture(t);
    const target = path.join(f.hooks, "context-usage.js");
    fs.chmodSync(target, 0);
    try {
      try { fs.readFileSync(target); return t.skip("file remains readable on this filesystem"); } catch (err) { assert.equal(err.code, "EACCES"); }
      // snapshot cannot read the deliberately unreadable file.
      const result = f.run(["--remote"]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /context-usage\.js.*EACCES/);
      assert.equal(fs.existsSync(f.settings), false);
      assert.deepEqual(fs.readdirSync(path.dirname(f.settings)), ["hooks"]);
    } finally { fs.chmodSync(target, 0o600); }
  });
  it("fails without writes when the installer's own bootstrap dependency is absent", (t) => {
    refused(fixture(t, ALL_FILES.filter((n) => n !== "json-utils.js")), [], /MODULE_NOT_FOUND/);
  });
  for (const key of ["CLAWD_WSL_DISTRO", "WSL_DISTRO_NAME"]) {
    it(`covers the no-flag WSL configuration with ${key}`, (t) => {
      if (key === "WSL_DISTRO_NAME" && process.platform !== "linux") return t.skip("native WSL detection is Linux-only");
      const f = fixture(t);
      assert.equal(f.run([], { [key]: "Fixture" }).status, 0);
      assert.equal(f.read().statusLine, undefined);
      const commands = f.read().hooks.UserPromptSubmit.flatMap((e) => e.hooks);
      assert.ok(commands.every((h) => !h.command.includes("CLAWD_REMOTE=")));
      refused(fixture(t, OLD_FILES), [], /state-payload-size\.js/, { [key]: "Fixture" });
    });
  }
});
