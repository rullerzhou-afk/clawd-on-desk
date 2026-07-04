const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildPortableStatuslineCommand, extractExistingNodeBin, extractExistingNodeBinFromCommands, formatNodeHookCommand, writeJsonAtomicAsync, createBackup, writeJsonAtomicWithBackup, writeJsonAtomicWithBackupAsync, pruneOldBackups, pruneOldBackupsAsync, DEFAULT_BACKUP_KEEP } = require("../hooks/json-utils");

// Hook command format depends on real-environment WSL signals; clear them so
// assertions stay deterministic when the suite itself runs inside WSL.
delete process.env.CLAWD_WSL_DISTRO;
delete process.env.WSL_DISTRO_NAME;

describe("extractExistingNodeBin", () => {
  it("extracts node path from flat command format", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"/usr/local/bin/node" "/path/to/cursor-hook.js"' }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "cursor-hook.js"),
      "/usr/local/bin/node"
    );
  });

  it("extracts node path from nested format with { nested: true }", () => {
    const settings = {
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/opt/homebrew/bin/node" "/path/to/codebuddy-hook.js"' }],
        }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "codebuddy-hook.js", { nested: true }),
      "/opt/homebrew/bin/node"
    );
  });

  it("returns null for nested format without { nested: true }", () => {
    const settings = {
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/opt/homebrew/bin/node" "/path/to/codebuddy-hook.js"' }],
        }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "codebuddy-hook.js"),
      null
    );
  });

  it("returns null for empty or missing settings", () => {
    assert.strictEqual(extractExistingNodeBin({}, "cursor-hook.js"), null);
    assert.strictEqual(extractExistingNodeBin(null, "cursor-hook.js"), null);
    assert.strictEqual(extractExistingNodeBin({ hooks: {} }, "cursor-hook.js"), null);
  });

  it("returns null when first quoted token is not an absolute path", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"node" "/path/to/cursor-hook.js"' }],
      },
    };
    assert.strictEqual(extractExistingNodeBin(settings, "cursor-hook.js"), null);
  });

  it("skips when first quoted token is the marker itself", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"/path/to/cursor-hook.js"' }],
      },
    };
    assert.strictEqual(extractExistingNodeBin(settings, "cursor-hook.js"), null);
  });

  it("extracts node path from Windows cmd wrapper format", () => {
    const settings = {
      hooks: {
        stop: [{
          command: 'cmd /d /s /c ""C:\\Program Files\\nodejs\\node.exe" "D:/animation/hooks/cursor-hook.js""',
        }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "cursor-hook.js"),
      "C:\\Program Files\\nodejs\\node.exe"
    );
  });

  it("extracts node path with forward-slash Windows mixed style", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"C:/Program Files/nodejs/node.exe" "D:/animation/hooks/cursor-hook.js"' }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "cursor-hook.js"),
      "C:/Program Files/nodejs/node.exe"
    );
  });

  it("extracts node path from a UNC share", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"\\\\fileserver\\tools\\nodejs\\node.exe" "C:\\Clawd\\cursor-hook.js"' }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "cursor-hook.js"),
      "\\\\fileserver\\tools\\nodejs\\node.exe"
    );
  });
});

describe("extractExistingNodeBinFromCommands", () => {
  it("extracts the first absolute path that is not the hook script", () => {
    const commands = ['"/usr/local/bin/node" "/path/to/kimi-hook.js"'];
    assert.strictEqual(extractExistingNodeBinFromCommands(commands, "kimi-hook.js"), "/usr/local/bin/node");
  });

  it("returns Windows drive paths verbatim", () => {
    const commands = ['"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\.kimi\\hooks\\kimi-hook.js"'];
    assert.strictEqual(
      extractExistingNodeBinFromCommands(commands, "kimi-hook.js"),
      "C:\\Program Files\\nodejs\\node.exe"
    );
  });

  it("returns UNC paths", () => {
    const commands = ['"\\\\fileserver\\tools\\node.exe" "C:\\hooks\\kimi-hook.js"'];
    assert.strictEqual(
      extractExistingNodeBinFromCommands(commands, "kimi-hook.js"),
      "\\\\fileserver\\tools\\node.exe"
    );
  });

  it("skips bare 'node' and returns null when nothing absolute is found", () => {
    const commands = ['"node" "/path/to/kimi-hook.js"'];
    assert.strictEqual(extractExistingNodeBinFromCommands(commands, "kimi-hook.js"), null);
  });

  it("walks past commands that begin with the marker itself", () => {
    const commands = [
      '"/path/to/kimi-hook.js"',
      '"/usr/bin/node" "/path/to/kimi-hook.js"',
    ];
    assert.strictEqual(extractExistingNodeBinFromCommands(commands, "kimi-hook.js"), "/usr/bin/node");
  });

  it("returns null for non-array or missing inputs", () => {
    assert.strictEqual(extractExistingNodeBinFromCommands([], "kimi-hook.js"), null);
    assert.strictEqual(extractExistingNodeBinFromCommands(null, "kimi-hook.js"), null);
    assert.strictEqual(extractExistingNodeBinFromCommands(["something"], ""), null);
  });

  it("ignores non-string entries in the commands array", () => {
    const commands = [null, 42, '"/usr/bin/node" "/hooks/kimi-hook.js"'];
    assert.strictEqual(extractExistingNodeBinFromCommands(commands, "kimi-hook.js"), "/usr/bin/node");
  });
});

describe("formatNodeHookCommand", () => {
  it("formats POSIX commands as quoted node + script", () => {
    assert.strictEqual(
      formatNodeHookCommand("/usr/local/bin/node", "/app/hooks/codex-debug-hook.js", {
        platform: "linux",
        wslDistro: null,
      }),
      '"/usr/local/bin/node" "/app/hooks/codex-debug-hook.js"'
    );
  });

  it("formats WSL commands as plain (unquoted) node + script", () => {
    // Quoted-without-shell breaks naive-split hook runners on WSL — the
    // quotes become part of the executable name (silent hook failure).
    assert.strictEqual(
      formatNodeHookCommand("/usr/bin/node", "/home/u/.claude/hooks/gemini-hook.js", {
        platform: "linux",
        wslDistro: "Ubuntu",
        args: ["Stop"],
      }),
      "/usr/bin/node /home/u/.claude/hooks/gemini-hook.js Stop"
    );
  });

  it("ignores wslDistro on win32 — Windows wrappers keep their quoting", () => {
    assert.strictEqual(
      formatNodeHookCommand("C:\\nodejs\\node.exe", "D:/app/hooks/kiro-hook.js", {
        platform: "win32",
        windowsWrapper: "powershell",
        wslDistro: "Ubuntu",
      }),
      '& "C:\\nodejs\\node.exe" "D:/app/hooks/kiro-hook.js"'
    );
  });

  it("formats Windows PowerShell commands with call operator", () => {
    assert.strictEqual(
      formatNodeHookCommand("C:\\Program Files\\nodejs\\node.exe", "D:/app/hooks/kiro-hook.js", {
        platform: "win32",
        windowsWrapper: "powershell",
      }),
      '& "C:\\Program Files\\nodejs\\node.exe" "D:/app/hooks/kiro-hook.js"'
    );
  });

  it("formats Windows cmd-wrapped commands", () => {
    assert.strictEqual(
      formatNodeHookCommand("C:\\Program Files\\nodejs\\node.exe", "D:/app/hooks/codex-debug-hook.js", {
        platform: "win32",
        windowsWrapper: "cmd",
      }),
      'cmd /d /s /c ""C:\\Program Files\\nodejs\\node.exe" "D:/app/hooks/codex-debug-hook.js""'
    );
  });
});

// statusLine settings have no `shell` field, so unlike hook commands the
// string must parse under Git Bash AND PowerShell (Claude Code picks per
// machine) and ideally cmd (Antigravity). The load-bearing property: the
// command token is never quoted and never prefixed with `&`.
describe("buildPortableStatuslineCommand", () => {
  it("falls back to bare node when the node path contains spaces (default Program Files install)", () => {
    assert.strictEqual(
      buildPortableStatuslineCommand("C:\\Program Files\\nodejs\\node.exe", "D:/app/hooks/claude-statusline.js", {
        platform: "win32",
      }),
      'node "D:/app/hooks/claude-statusline.js"'
    );
  });

  it("uses an unquoted forward-slash absolute path when it needs no quoting (nvm/portable installs)", () => {
    assert.strictEqual(
      buildPortableStatuslineCommand("C:\\nvm\\v20.11.0\\node.exe", "D:/app/hooks/claude-statusline.js", {
        platform: "win32",
      }),
      'C:/nvm/v20.11.0/node.exe "D:/app/hooks/claude-statusline.js"'
    );
  });

  it("keeps the script path double-quoted with forward slashes", () => {
    assert.strictEqual(
      buildPortableStatuslineCommand("node", "C:\\Users\\My Name\\app\\hooks\\claude-statusline.js", {
        platform: "win32",
      }),
      'node "C:/Users/My Name/app/hooks/claude-statusline.js"'
    );
  });

  it("falls back to bare node for null nodeBin and for paths with shell-special characters", () => {
    for (const nodeBin of [null, "", "C:\\tools (x86)\\node.exe", "C:\\nvm&stuff\\node.exe", "C:\\it's\\node.exe"]) {
      const command = buildPortableStatuslineCommand(nodeBin, "D:/app/hooks/claude-statusline.js", { platform: "win32" });
      assert.strictEqual(command, 'node "D:/app/hooks/claude-statusline.js"', `nodeBin=${JSON.stringify(nodeBin)}`);
    }
  });

  it("never emits a PowerShell call operator or a quoted command token on win32", () => {
    for (const nodeBin of ["C:\\Program Files\\nodejs\\node.exe", "C:\\nvm\\node.exe", null]) {
      const command = buildPortableStatuslineCommand(nodeBin, "D:/app/hooks/claude-statusline.js", { platform: "win32" });
      assert.ok(!command.startsWith("& "), command);
      assert.ok(!command.startsWith('"'), command);
    }
  });

  it("formats POSIX commands as quoted node + script", () => {
    assert.strictEqual(
      buildPortableStatuslineCommand("/usr/local/bin/node", "/app/hooks/claude-statusline.js", {
        platform: "darwin",
      }),
      '"/usr/local/bin/node" "/app/hooks/claude-statusline.js"'
    );
  });
});

describe("writeJsonAtomicAsync", () => {
  it("writes pretty JSON atomically and cleans up tmp files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-json-utils-"));
    const filePath = path.join(tmpDir, "settings.json");
    try {
      await writeJsonAtomicAsync(filePath, { hooks: { Stop: [] } });
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.deepStrictEqual(parsed, { hooks: { Stop: [] } });
      const leftovers = fs.readdirSync(tmpDir).filter((name) => name.includes(".tmp"));
      assert.deepStrictEqual(leftovers, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("backup pruning", () => {
  const PREFIX = "settings.json.clawd-cleanup-";
  // 17-digit, lexically-increasing creation stamp (matches YYYYMMDDHHMMSSmmm width).
  const stampAt = (i) => `20260630000000${String(i).padStart(3, "0")}`;
  const bakOf = (stamp, suffix) => `${PREFIX}${stamp}${suffix != null ? "." + suffix : ""}.bak`;

  // Seed a backup file. `mtimeSec` lets a test set an mtime that disagrees with
  // the filename order (mimicking copyFileSync inheriting the source's mtime).
  function seedBak(dir, stamp, opts = {}) {
    const name = bakOf(stamp, opts.suffix);
    const p = path.join(dir, name);
    fs.writeFileSync(p, opts.content != null ? opts.content : "{}", "utf8");
    if (opts.mtimeSec != null) fs.utimesSync(p, opts.mtimeSec, opts.mtimeSec);
    return name;
  }
  function bakNames(dir) {
    return fs.readdirSync(dir).filter((n) => n.startsWith(PREFIX) && n.endsWith(".bak")).sort();
  }
  function withTmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-prune-"));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  async function withTmpAsync(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-prune-"));
    try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  it("keeps the oldest (original) snapshot plus the most recent N-1", () => {
    withTmp((dir) => {
      const settingsPath = path.join(dir, "settings.json");
      for (let i = 1; i <= 8; i++) seedBak(dir, stampAt(i));
      pruneOldBackups(settingsPath, { backupKeep: 3 });
      // oldest (1) kept as the original snapshot, plus the two most recent (7, 8)
      assert.deepStrictEqual(bakNames(dir), [bakOf(stampAt(1)), bakOf(stampAt(7)), bakOf(stampAt(8))]);
    });
  });

  it("orders by filename stamp, not by mtime (copyFileSync inherits source mtime)", () => {
    withTmp((dir) => {
      const settingsPath = path.join(dir, "settings.json");
      // mtimes deliberately REVERSED vs filename order: the oldest filename gets
      // the newest mtime. A mtime-based prune would keep the wrong set.
      for (let i = 1; i <= 6; i++) seedBak(dir, stampAt(i), { mtimeSec: 1_700_000_000 + (6 - i) });
      pruneOldBackups(settingsPath, { backupKeep: 3 });
      assert.deepStrictEqual(bakNames(dir), [bakOf(stampAt(1)), bakOf(stampAt(5)), bakOf(stampAt(6))]);
    });
  });

  it("never deletes the freshly-created backup, even when the source mtime is old", () => {
    // This is the core regression: on Windows fs.copyFileSync gives the new
    // backup the SOURCE file's (old) mtime, so an mtime-based prune deletes the
    // backup it just wrote and returns a path that no longer exists.
    withTmp((dir) => {
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(settingsPath, JSON.stringify({ user: "config" }), "utf8");
      const weekAgo = 1_700_000_000;
      fs.utimesSync(settingsPath, weekAgo, weekAgo); // source looks old
      // 5 pre-existing backups that look "newer" by mtime
      for (let i = 1; i <= 5; i++) seedBak(dir, stampAt(i), { mtimeSec: 1_800_000_000 + i });
      const created = writeJsonAtomicWithBackup(settingsPath, { user: "config", clawd: true }, { backup: true, backupKeep: 5 });
      assert.ok(created, "should return a backup path");
      assert.ok(fs.existsSync(created), "the just-written backup must NOT be pruned away");
      assert.ok(bakNames(dir).includes(path.basename(created)), "new backup is among survivors");
      assert.strictEqual(bakNames(dir).length, 5, "total still capped at keep");
    });
  });

  it("orders same-stamp collisions by suffix (bare .bak is older than .1.bak)", () => {
    withTmp((dir) => {
      const settingsPath = path.join(dir, "settings.json");
      seedBak(dir, stampAt(1));                 // oldest overall
      seedBak(dir, stampAt(5));                  // bare: first within stamp5
      seedBak(dir, stampAt(5), { suffix: 1 });    // .1: next
      seedBak(dir, stampAt(5), { suffix: 2 });    // .2: newest
      pruneOldBackups(settingsPath, { backupKeep: 3 });
      // oldest(1) + the two most recent of the collision group (.1, .2); bare stamp5 dropped
      assert.deepStrictEqual(bakNames(dir), [bakOf(stampAt(1)), bakOf(stampAt(5), 1), bakOf(stampAt(5), 2)]);
    });
  });

  it("defaults to keeping DEFAULT_BACKUP_KEEP when backupKeep is absent", () => {
    withTmp((dir) => {
      const settingsPath = path.join(dir, "settings.json");
      for (let i = 1; i <= DEFAULT_BACKUP_KEEP + 4; i++) seedBak(dir, stampAt(i));
      pruneOldBackups(settingsPath);
      assert.strictEqual(bakNames(dir).length, DEFAULT_BACKUP_KEEP);
    });
  });

  it("falls back to the default for invalid backupKeep and never deletes everything", () => {
    for (const bad of [0, -1, 1.5, "3", null, NaN]) {
      withTmp((dir) => {
        const settingsPath = path.join(dir, "settings.json");
        for (let i = 1; i <= 9; i++) seedBak(dir, stampAt(i));
        pruneOldBackups(settingsPath, { backupKeep: bad });
        assert.strictEqual(bakNames(dir).length, DEFAULT_BACKUP_KEEP, `backupKeep=${String(bad)} should fall back to default`);
      });
    }
  });

  it("is a no-op under the cap and safe on a missing directory", () => {
    withTmp((dir) => {
      const settingsPath = path.join(dir, "settings.json");
      for (let i = 1; i <= 2; i++) seedBak(dir, stampAt(i));
      pruneOldBackups(settingsPath, { backupKeep: 5 }); // fewer than cap → no-op
      assert.strictEqual(bakNames(dir).length, 2);
      assert.doesNotThrow(() => pruneOldBackups(path.join(dir, "nope", "settings.json")));
    });
  });

  it("scopes pruning to the target file and leaves other files alone", () => {
    withTmp((dir) => {
      const settingsPath = path.join(dir, "settings.json");
      for (let i = 1; i <= 6; i++) seedBak(dir, stampAt(i));
      const otherBak = path.join(dir, `other.json.clawd-cleanup-${stampAt(1)}.bak`);
      fs.writeFileSync(otherBak, "{}", "utf8");
      fs.writeFileSync(settingsPath, "{}", "utf8");
      pruneOldBackups(settingsPath, { backupKeep: 2 });
      assert.strictEqual(bakNames(dir).length, 2, "own backups capped");
      assert.ok(fs.existsSync(otherBak), "a different file's backup is untouched");
      assert.ok(fs.existsSync(settingsPath), "the live file is untouched");
    });
  });

  it("does not prune when a caller-specified backupPath is used", () => {
    withTmp((dir) => {
      const settingsPath = path.join(dir, "settings.json");
      for (let i = 1; i <= 6; i++) seedBak(dir, stampAt(i));
      pruneOldBackups(settingsPath, { backupKeep: 2, backupPath: path.join(dir, "explicit.bak") });
      assert.strictEqual(bakNames(dir).length, 6, "explicit backupPath disables pruning");
    });
  });

  it("prunes on the async path with the same policy, keeping the fresh backup", async () => {
    await withTmpAsync(async (dir) => {
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(settingsPath, JSON.stringify({ a: 1 }), "utf8");
      fs.utimesSync(settingsPath, 1_700_000_000, 1_700_000_000); // old source mtime
      for (let i = 1; i <= 5; i++) seedBak(dir, stampAt(i), { mtimeSec: 1_800_000_000 + i });
      const created = await writeJsonAtomicWithBackupAsync(settingsPath, { a: 2 }, { backup: true, backupKeep: 4 });
      assert.ok(created && fs.existsSync(created), "async: the fresh backup survives its own prune");
      assert.strictEqual(bakNames(dir).length, 4, "async: capped at keep");
    });
  });

  it("never overwrites an existing backup when auto-naming (COPYFILE_EXCL + retry)", () => {
    withTmp((dir) => {
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(settingsPath, JSON.stringify({ v: 2 }), "utf8");
      // Pin the stamp so we know the first name createBackup will try, then occupy it.
      const now = () => new Date("2026-06-30T12:00:00.000Z");
      const firstName = `${PREFIX}20260630120000000.bak`;
      fs.writeFileSync(path.join(dir, firstName), "SENTINEL", "utf8");
      const created = createBackup(settingsPath, { backup: true, now });
      assert.notStrictEqual(path.basename(created), firstName, "must not reuse the occupied name");
      assert.strictEqual(fs.readFileSync(path.join(dir, firstName), "utf8"), "SENTINEL", "the occupied backup is left intact");
      assert.ok(fs.existsSync(created), "a fresh backup is written under a different name");
    });
  });
});
