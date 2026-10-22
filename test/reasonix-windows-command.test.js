"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { __test, unregisterReasonixHooks } = require("../hooks/reasonix-install");
const { commandMatchesMarker, decodeWindowsEncodedCommand, extractExistingNodeBinFromCommands } = require("../hooks/json-utils");

const { validateHookCommand } = require("../src/doctor-detectors/agent-node-bin-parser");

const nodePath = "C:\\Program Files\\nodejs\\node.exe";
const hookPath = "D:\\Clawd & %PATH%! 中文\\hooks\\reasonix-hook.js";
const shortNode = "C:\\PROGRA~1\\nodejs\\node.exe";
const shortHook = "D:\\CLAWD&~1\\hooks\\REASON~1.JS";
const file = (ino, regular = true) => ({ dev: 1n, ino: BigInt(ino), isFile: () => regular });

function fixture(overrides = {}) {
  const stats = new Map([[nodePath, file(1)], [hookPath, file(2)], [shortNode, file(1)], [shortHook, file(2)]]);
  const calls = [];
  const options = {
    platform: "win32",
    fs: { statSync: (name) => { if (!stats.has(name)) throw new Error("ENOENT"); return stats.get(name); } },
    execFileSync: (exe, args, spawnOptions) => {
      calls.push({ exe, args, spawnOptions });
      return `"${shortNode}" \r\n"${shortHook}"\r\n`;
    },
    ...overrides,
  };
  return { stats, calls, options, build: () => __test.buildReasonixHookCommand(nodePath, hookPath, options) };
}

function assertEncodedFallback(command) {
  const decoded = decodeWindowsEncodedCommand(command);
  assert.ok(decoded && decoded.includes(nodePath) && decoded.includes(hookPath), "fallback must retain both original paths");
}

describe("Reasonix Windows direct command", () => {
  it("does not query or replace already-safe absolute paths", () => {
    const command = __test.buildReasonixHookCommand("D:\\node\\node.exe", "D:\\clawd\\hooks\\reasonix-hook.js", {
      platform: "win32", execFileSync: () => { throw new Error("unexpected query"); },
    });
    assert.equal(command, "D:\\node\\node.exe D:\\clawd\\hooks\\reasonix-hook.js --clawd-reasonix-hook=reasonix-hook.js");
  });

  it("queries aliases once, verifies both file identities, and preserves ownership and Node recovery", () => {
    const f = fixture();
    const command = f.build();
    assert.equal(command, `${shortNode} D:\\CLAWD^&~1\\hooks\\REASON~1.JS --clawd-reasonix-hook=reasonix-hook.js`);
    assert.ok(!command.includes("PowerShell") && !command.includes("-EncodedCommand"));
    assert.equal(f.calls.length, 1);
    const { args, spawnOptions } = f.calls[0];
    assert.ok(args.includes("/d") && args.includes("/v:off"));
    assert.equal(spawnOptions.windowsVerbatimArguments, true);
    assert.equal(spawnOptions.env.CLAWD_REASONIX_PATH_0, nodePath);
    assert.equal(spawnOptions.env.CLAWD_REASONIX_PATH_1, hookPath);
    assert.ok(!args.at(-1).includes(hookPath), "file paths must be passed as data, not interpolated into cmd source");
    assert.ok(commandMatchesMarker(command, "reasonix-hook.js"));
    assert.equal(extractExistingNodeBinFromCommands([command], "reasonix-hook.js"), shortNode);
  });

  it("lets Doctor validate the script alias instead of the ownership argument", () => {
    const f = fixture();
    const checked = validateHookCommand(f.build(), {
      platform: "win32", fs: { existsSync: (name) => f.stats.has(name) },
    });
    assert.deepEqual(checked, { ok: true, nodeBin: shortNode, scriptPath: shortHook });
    const plain = __test.buildReasonixHookCommand("C:\\node\\node.exe", "D:\\hooks\\reasonix-hook.js", { platform: "win32" });
    assert.equal(validateHookCommand(plain, { platform: "win32", fs: { existsSync: () => true } }).ok, true);
  });

  it("does not let Doctor treat malformed cmd syntax as the direct command shape", () => {
    const command = fixture().build();
    for (const invalid of [command.replace("^&", "&"), command.replace("^&", "^x"), `${command} extra`]) {
      assert.equal(validateHookCommand(invalid, { platform: "win32", fs: { existsSync: () => true } }).ok, false);
    }
  });

  it("does not switch an unresolved PATH-node fallback to cmd's current-directory lookup", () => {
    const command = __test.buildReasonixHookCommand("node", "D:\\clawd\\hooks\\reasonix-hook.js", fixture().options);
    assert.ok(decodeWindowsEncodedCommand(command)?.includes("'node'"));
  });

  it("keeps the encoded launcher when an alias identifies a different file", () => {
    const f = fixture();
    f.stats.set(shortHook, file(99));
    assertEncodedFallback(f.build());
  });

  it("does not query missing files, directories, or files with no usable identity", () => {
    for (const invalid of [null, file(2, false), file(0)]) {
      const f = fixture();
      if (invalid) f.stats.set(hookPath, invalid); else f.stats.delete(hookPath);
      assertEncodedFallback(f.build());
      assert.equal(f.calls.length, 0);
    }
  });

  it("keeps the encoded launcher if aliases are unavailable or still require unsafe expansion", () => {
    for (const candidate of [hookPath, "D:\\A%PATH%\\REASON~1.JS", "D:\\A!B\\REASON~1.JS", "D:\\space path\\REASON~1.JS"]) {
      const f = fixture({ execFileSync: () => `"${shortNode}"\r\n"${candidate}"\r\n` });
      f.stats.set(candidate, file(2));
      assertEncodedFallback(f.build());
    }
  });

  it("keeps the encoded launcher on query errors and malformed output", () => {
    const outputs = ["", `"${shortNode}"`, `"${shortNode}"\n"${shortHook}"\nextra`, `${shortNode}\n${shortHook}`];
    for (const output of outputs) assertEncodedFallback(fixture({ execFileSync: () => output }).build());
    assertEncodedFallback(fixture({ execFileSync: () => { throw new Error("ETIMEDOUT"); } }).build());
  });

  it("executes literal shell characters through the Windows command host", { skip: process.platform !== "win32" }, (t) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-rx-command-"));
    const hook = path.join(homeDir, "A&^()$'@#{}", "reasonix-hook.js");
    try {
      fs.mkdirSync(path.dirname(hook));
      fs.writeFileSync(hook, "process.stdout.write(JSON.stringify({ path: __filename, args: process.argv.slice(2) }));");
      const command = __test.buildReasonixHookCommand(process.execPath, hook);
      if (decodeWindowsEncodedCommand(command)) return t.skip("No safe absolute Node/script aliases on this volume");
      const output = require("node:child_process").execFileSync(
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
        ["/d", "/v:off", "/c", command],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      assert.equal(validateHookCommand(command).ok, true, "Doctor must accept the actual generated command");
      const receipt = JSON.parse(output);
      assert.equal(fs.realpathSync(receipt.path), fs.realpathSync(hook));
      assert.deepEqual(receipt.args, ["--clawd-reasonix-hook=reasonix-hook.js"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uninstalls a short script alias without removing a user's hook", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reasonix-short-command-"));
    const settingsPath = path.join(homeDir, ".reasonix", "settings.json");
    try {
      fs.mkdirSync(path.dirname(settingsPath));
      const foreign = { match: "*", command: "echo user-hook" };
      fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ match: "*", command: fixture().build() }, foreign] } }));
      const result = unregisterReasonixHooks({ homeDir, silent: true });
      assert.equal(result.removed, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")).hooks.Stop, [foreign]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
