const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const serverConfig = require("../hooks/server-config");

const tempDirs = [];

function makeTempHome() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-server-config-"));
  tempDirs.push(tmpDir);
  return tmpDir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// runtime.json identity (#681)
// ═══════════════════════════════════════════════════════════════════════════
//
// Every case injects runtimeConfigPath — nothing here may touch the real
// ~/.clawd/runtime.json, whose contents depend on whether Clawd is running.

describe("runtime.json identity (#681)", () => {
  function writeRuntime(contents) {
    const dir = makeTempHome();
    const file = path.join(dir, "runtime.json");
    fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
    return file;
  }
  const missingPath = () => path.join(makeTempHome(), "does-not-exist", "runtime.json");

  describe("readRuntimeIdentity — the strict resolver gate", () => {
    it("ok for a well-formed file with app + port + ownerPid", () => {
      const file = writeRuntime({ app: "clawd-on-desk", port: 23334, ownerPid: 4242 });
      assert.deepStrictEqual(serverConfig.readRuntimeIdentity({ runtimeConfigPath: file }), {
        ok: true, reason: null, port: 23334, ownerPid: 4242,
      });
    });

    it("rejects a missing file", () => {
      const r = serverConfig.readRuntimeIdentity({ runtimeConfigPath: missingPath() });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, "runtime-missing");
      assert.strictEqual(r.ownerPid, null);
    });

    it("rejects unparseable JSON", () => {
      const r = serverConfig.readRuntimeIdentity({ runtimeConfigPath: writeRuntime("{not json") });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, "runtime-missing");
    });

    it("rejects a foreign app — another tool's runtime.json is not Clawd's", () => {
      const file = writeRuntime({ app: "some-other-app", port: 23333, ownerPid: 4242 });
      const r = serverConfig.readRuntimeIdentity({ runtimeConfigPath: file });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, "runtime-app-mismatch");
    });

    it("rejects a port outside the bindable range", () => {
      for (const port of [0, 80, 23332, 23338, null, undefined, "nope", {}]) {
        const file = writeRuntime({ app: "clawd-on-desk", port, ownerPid: 4242 });
        const r = serverConfig.readRuntimeIdentity({ runtimeConfigPath: file });
        assert.strictEqual(r.ok, false, `port ${JSON.stringify(port)} must be rejected`);
        assert.strictEqual(r.reason, "runtime-port-invalid");
      }
    });

    it("accepts a numeric-string port — normalizePort has always coerced, and the writer is ours", () => {
      const file = writeRuntime({ app: "clawd-on-desk", port: "23333", ownerPid: 4242 });
      const r = serverConfig.readRuntimeIdentity({ runtimeConfigPath: file });
      assert.strictEqual(r.ok, true, "documenting existing normalizePort behavior, not endorsing new writers");
      assert.strictEqual(r.port, 23333, "and it is normalized to a number");
    });

    it("fail-closes on a legacy file with no ownerPid (pre-#681 shape)", () => {
      const file = writeRuntime({ app: "clawd-on-desk", port: 23333 });
      const r = serverConfig.readRuntimeIdentity({ runtimeConfigPath: file });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, "runtime-owner-invalid");
      assert.strictEqual(r.port, 23333, "the port is still reported — only the gate fails closed");
    });

    it("rejects a non-positive / non-integer ownerPid", () => {
      for (const ownerPid of [0, -1, 1.5, "4242", null, {}]) {
        const file = writeRuntime({ app: "clawd-on-desk", port: 23333, ownerPid });
        const r = serverConfig.readRuntimeIdentity({ runtimeConfigPath: file });
        assert.strictEqual(r.ok, false, `ownerPid ${JSON.stringify(ownerPid)} must be rejected`);
        assert.strictEqual(r.reason, "runtime-owner-invalid");
      }
    });
  });

  describe("readRuntimePort — stays permissive so POSTs keep routing", () => {
    it("returns the port for a legacy file with no ownerPid", () => {
      const file = writeRuntime({ app: "clawd-on-desk", port: 23336 });
      assert.strictEqual(serverConfig.readRuntimePort({ runtimeConfigPath: file }), 23336,
        "a legacy runtime must keep routing state/permission POSTs even though the gate fail-closes");
    });

    it("returns the port when ownerPid is present", () => {
      const file = writeRuntime({ app: "clawd-on-desk", port: 23337, ownerPid: 999 });
      assert.strictEqual(serverConfig.readRuntimePort({ runtimeConfigPath: file }), 23337);
    });

    it("now requires a matching app (every Clawd that wrote this file stamped one)", () => {
      const file = writeRuntime({ app: "not-clawd", port: 23333, ownerPid: 1 });
      assert.strictEqual(serverConfig.readRuntimePort({ runtimeConfigPath: file }), null);
    });

    it("returns null for a missing file", () => {
      assert.strictEqual(serverConfig.readRuntimePort({ runtimeConfigPath: missingPath() }), null);
    });
  });

  describe("writeRuntimeConfig — boolean contract, never throws (#681)", () => {
    it("writes app + port + ownerPid and round-trips through readRuntimeIdentity", () => {
      const file = path.join(makeTempHome(), "nested", "runtime.json");
      assert.strictEqual(serverConfig.writeRuntimeConfig(23335, { runtimeConfigPath: file, ownerPid: 777 }), true);

      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
        app: "clawd-on-desk", port: 23335, ownerPid: 777,
      });
      assert.deepStrictEqual(serverConfig.readRuntimeIdentity({ runtimeConfigPath: file }), {
        ok: true, reason: null, port: 23335, ownerPid: 777,
      });
    });

    it("defaults ownerPid to the writing process", () => {
      const file = path.join(makeTempHome(), "runtime.json");
      serverConfig.writeRuntimeConfig(23333, { runtimeConfigPath: file });
      assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).ownerPid, process.pid);
    });

    // The regression this exists for: mkdirSync used to sit OUTSIDE the try, so
    // an EACCES on ~/.clawd escaped as an exception instead of returning false —
    // and src/server.js's 'listening' handler called this BEFORE settle(), so
    // the throw stranded startHttpServer's promise forever.
    it("returns false (not throws) when mkdirSync fails with EACCES", () => {
      const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      let result;
      assert.doesNotThrow(() => {
        result = serverConfig.writeRuntimeConfig(23333, {
          runtimeConfigPath: path.join(makeTempHome(), "runtime.json"),
          fs: {
            mkdirSync: () => { throw eacces; },
            writeFileSync: () => assert.fail("must not reach writeFileSync"),
            renameSync: () => assert.fail("must not reach renameSync"),
            unlinkSync: () => {},
          },
        });
      });
      assert.strictEqual(result, false);
    });

    it("returns false and best-effort removes the temp file when the rename fails", () => {
      const unlinked = [];
      const written = [];
      const result = serverConfig.writeRuntimeConfig(23333, {
        runtimeConfigPath: path.join(makeTempHome(), "runtime.json"),
        fs: {
          mkdirSync: () => {},
          writeFileSync: (p) => { written.push(p); },
          renameSync: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); },
          unlinkSync: (p) => { unlinked.push(p); },
        },
      });
      assert.strictEqual(result, false);
      assert.strictEqual(unlinked.length, 1, "the temp file must not linger");
      assert.deepStrictEqual(unlinked, written, "and the cleaned-up path is the one we wrote");
    });

    it("does not throw even when the temp cleanup itself fails", () => {
      let result;
      assert.doesNotThrow(() => {
        result = serverConfig.writeRuntimeConfig(23333, {
          runtimeConfigPath: path.join(makeTempHome(), "runtime.json"),
          fs: {
            mkdirSync: () => {},
            writeFileSync: () => { throw new Error("ENOSPC"); },
            renameSync: () => {},
            unlinkSync: () => { throw new Error("cleanup also failed"); },
          },
        });
      });
      assert.strictEqual(result, false);
    });

    it("returns false for an unbindable port without touching the filesystem", () => {
      const result = serverConfig.writeRuntimeConfig(9999, {
        runtimeConfigPath: path.join(makeTempHome(), "runtime.json"),
        fs: { mkdirSync: () => assert.fail("must reject the port before any fs call") },
      });
      assert.strictEqual(result, false);
    });
  });
});

describe("server-config helpers", () => {
  it("clearRuntimeConfig removes runtime.json when present", () => {
    const tmpHome = makeTempHome();
    const runtimeDir = path.join(tmpHome, ".clawd");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const runtimePath = path.join(runtimeDir, "runtime.json");
    fs.writeFileSync(runtimePath, JSON.stringify({ app: "clawd-on-desk", port: 23333 }));

    assert.strictEqual(serverConfig.clearRuntimeConfig(runtimePath), true);
    assert.strictEqual(fs.existsSync(runtimePath), false);
  });

  it("clearRuntimeConfig removes a file this process owns", () => {
    const runtimeDir = path.join(makeTempHome(), ".clawd");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const runtimePath = path.join(runtimeDir, "runtime.json");
    fs.writeFileSync(runtimePath, JSON.stringify({ app: "clawd-on-desk", port: 23333, ownerPid: process.pid }));

    assert.strictEqual(serverConfig.clearRuntimeConfig(runtimePath), true);
    assert.strictEqual(fs.existsSync(runtimePath), false);
  });

  it("clearRuntimeConfig refuses to remove another instance's identity (#681 P2-2)", () => {
    // Installed + dev builds hold different user-data-dir singleton locks, so
    // both can run while sharing this one file. The LAST writer owns the bytes;
    // an earlier instance quitting later must leave them alone — post-gate,
    // deleting them would blind every Windows hook until the survivor restarts.
    // The guard keys on pid inequality alone (no liveness check), so any
    // foreign pid must be refused, dead or alive.
    const runtimeDir = path.join(makeTempHome(), ".clawd");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const runtimePath = path.join(runtimeDir, "runtime.json");
    fs.writeFileSync(runtimePath, JSON.stringify({ app: "clawd-on-desk", port: 23334, ownerPid: process.pid + 1 }));

    assert.strictEqual(serverConfig.clearRuntimeConfig(runtimePath), false);
    assert.strictEqual(fs.existsSync(runtimePath), true, "the survivor's identity must stay on disk");
  });

  it("clearRuntimeConfig still removes a corrupt runtime.json (residue, not identity)", () => {
    const runtimeDir = path.join(makeTempHome(), ".clawd");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const runtimePath = path.join(runtimeDir, "runtime.json");
    fs.writeFileSync(runtimePath, "not-json{");

    assert.strictEqual(serverConfig.clearRuntimeConfig(runtimePath), true);
    assert.strictEqual(fs.existsSync(runtimePath), false);
  });

  it("splitPortCandidates prioritizes preferred and runtime ports", () => {
    const result = serverConfig.splitPortCandidates(23335, { runtimePort: 23334 });
    assert.deepStrictEqual(result.direct, [23335, 23334]);
    assert.ok(result.fallback.includes(23333));
    assert.ok(!result.fallback.includes(23334));
    assert.ok(!result.fallback.includes(23335));
  });

  it("probePort recognizes signed Clawd responses", async () => {
    await new Promise((resolve, reject) => {
      const req = {
        on(event, handler) {
          if (event === "error" || event === "timeout") this[`_${event}`] = handler;
        },
        destroy() {},
      };

      serverConfig.probePort(23337, 100, (ok) => {
        try {
          assert.strictEqual(ok, true);
          resolve();
        } catch (err) {
          reject(err);
        }
      }, {
        httpGet(_options, onResponse) {
          const res = {
            headers: { "x-clawd-server": "clawd-on-desk" },
            setEncoding() {},
            on(event, handler) {
              if (event === "data") handler("");
              if (event === "end") handler();
            },
          };
          onResponse(res);
          return req;
        },
      });
    });
  });

  describe("resolveNodeBin on Windows", () => {
    const WIN_ENV = {
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      USERPROFILE: "C:\\Users\\tester",
    };

    it("returns options.execPath when it points at node.exe", () => {
      const result = serverConfig.resolveNodeBin({
        platform: "win32",
        env: WIN_ENV,
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        accessSync(candidate) {
          if (candidate === "C:\\Program Files\\nodejs\\node.exe") return;
          throw new Error("ENOENT");
        },
        execFileSync() { throw new Error("where.exe should not run when execPath is node.exe"); },
      });
      assert.strictEqual(result, "C:\\Program Files\\nodejs\\node.exe");
    });

    it("rejects the packaged Clawd Electron host as execPath", () => {
      const wherePath = "C:\\Program Files\\nodejs\\node.exe";
      const result = serverConfig.resolveNodeBin({
        platform: "win32",
        env: WIN_ENV,
        execPath: "C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe",
        accessSync(candidate) {
          if (candidate === wherePath) return;
          throw new Error("ENOENT");
        },
        execFileSync() { return `${wherePath}\r\n`; },
      });
      assert.strictEqual(result, wherePath);
    });

    it("iterates every where.exe line and skips scoop shims", () => {
      const realNode = "C:\\Program Files\\nodejs\\node.exe";
      const shim = "C:\\Users\\tester\\scoop\\shims\\node.exe";
      const result = serverConfig.resolveNodeBin({
        platform: "win32",
        env: WIN_ENV,
        execPath: "C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe",
        accessSync(candidate) {
          if (candidate === realNode) return;
          throw new Error("ENOENT");
        },
        execFileSync() { return `${shim}\r\n${realNode}\r\n`; },
      });
      assert.strictEqual(result, realNode);
    });

    it("falls back to common install paths when where.exe fails", () => {
      const probed = [];
      const result = serverConfig.resolveNodeBin({
        platform: "win32",
        env: WIN_ENV,
        execPath: "C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe",
        accessSync(candidate) {
          probed.push(candidate);
          if (candidate === "C:\\Program Files\\nodejs\\node.exe") return;
          throw new Error("ENOENT");
        },
        execFileSync() { throw new Error("where.exe not found"); },
      });
      assert.strictEqual(result, "C:\\Program Files\\nodejs\\node.exe");
      assert.ok(probed.includes("C:\\Program Files\\nodejs\\node.exe"));
    });

    it("resolves the Scoop real app path, not the shim path", () => {
      const realScoop = "C:\\Users\\tester\\scoop\\apps\\nodejs\\current\\node.exe";
      const result = serverConfig.resolveNodeBin({
        platform: "win32",
        env: WIN_ENV,
        execPath: "C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe",
        accessSync(candidate) {
          if (candidate === realScoop) return;
          throw new Error("ENOENT");
        },
        execFileSync() { throw new Error("where failed"); },
      });
      assert.strictEqual(result, realScoop);
    });

    it("rejects Clawd on Desk.exe even when accessSync says it exists", () => {
      // accessSync only succeeds for the Clawd.exe path so validator rejection
      // is the only thing standing between us and a wrong return value.
      const clawdExe = "C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe";
      const result = serverConfig.resolveNodeBin({
        platform: "win32",
        env: WIN_ENV,
        execPath: clawdExe,
        accessSync(candidate) {
          if (candidate === clawdExe) return;
          throw new Error("ENOENT");
        },
        execFileSync() { return ""; },
      });
      assert.strictEqual(result, null);
    });

    it("does not spawn PowerShell as part of the default detection chain", () => {
      const calls = [];
      serverConfig.resolveNodeBin({
        platform: "win32",
        env: WIN_ENV,
        execPath: "C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe",
        accessSync() { throw new Error("ENOENT"); },
        execFileSync(cmd, args) {
          calls.push({ cmd, args });
          throw new Error("not found");
        },
      });
      const lowered = calls.map((c) => String(c.cmd).toLowerCase());
      assert.ok(lowered.every((c) => !c.includes("powershell")), "PowerShell should not be spawned");
    });

    it("returns null when every detection step fails", () => {
      const result = serverConfig.resolveNodeBin({
        platform: "win32",
        env: WIN_ENV,
        execPath: "C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe",
        accessSync() { throw new Error("ENOENT"); },
        execFileSync() { throw new Error("where failed"); },
      });
      assert.strictEqual(result, null);
    });

    it("validateWindowsNodeCandidate rejects Clawd, Electron, scoop shims, and non-node basenames", () => {
      const v = serverConfig.validateWindowsNodeCandidate;
      assert.strictEqual(v("C:\\Program Files\\nodejs\\node.exe"), "C:\\Program Files\\nodejs\\node.exe");
      assert.strictEqual(v("C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe"), null);
      assert.strictEqual(v("C:\\Windows\\System32\\Electron.exe"), null);
      assert.strictEqual(v("C:\\Users\\tester\\scoop\\shims\\node.exe"), null);
      assert.strictEqual(v("C:\\Users\\TESTER\\Scoop\\Shims\\node.exe"), null);
      assert.strictEqual(v("not absolute"), null);
      assert.strictEqual(v("C:\\bin\\python.exe"), null);
    });

    it("validateWindowsNodeCandidate parses Windows paths regardless of host platform", () => {
      // Regression: an earlier draft used the default `path` module, which on
      // POSIX treats `C:\Program Files\nodejs\node.exe` as one big filename.
      // path.basename returned the whole string, isWindowsNodeBasename failed,
      // and every Windows resolver test silently passed only because it ran on
      // a Windows host. Force the win32 path semantics by using path.win32.*
      // everywhere — this assertion fails on Linux/macOS if anyone reverts.
      const v = serverConfig.validateWindowsNodeCandidate;
      assert.strictEqual(v("C:\\Program Files\\nodejs\\node.exe"), "C:\\Program Files\\nodejs\\node.exe");
      assert.strictEqual(v("\\\\fileserver\\share\\node.exe"), "\\\\fileserver\\share\\node.exe");
    });

    it("getWindowsCommonNodePaths emits backslash-joined Windows paths on any host", () => {
      // Same risk class as the validator regression: path.join on POSIX would
      // splice the env var with forward slashes, producing paths that never
      // exist on Windows and never match the scoop-shim/normalize checks.
      const result = serverConfig.resolveNodeBin({
        platform: "win32",
        env: { ProgramFiles: "C:\\Program Files" },
        execPath: "C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe",
        execFileSync() { throw new Error("where failed"); },
        accessSync(candidate) {
          assert.ok(candidate.includes("\\"), `expected backslash in ${candidate}`);
          assert.ok(!candidate.includes("/"), `expected no forward slash in ${candidate}`);
          if (candidate === "C:\\Program Files\\nodejs\\node.exe") return;
          throw new Error("ENOENT");
        },
      });
      assert.strictEqual(result, "C:\\Program Files\\nodejs\\node.exe");
    });

    it("async resolver mirrors sync (execPath, where.exe, common paths, scoop shim skip)", async () => {
      const realNode = "C:\\Program Files\\nodejs\\node.exe";
      const shim = "C:\\Users\\tester\\scoop\\shims\\node.exe";

      const fromExecPath = await serverConfig.resolveNodeBinAsync({
        platform: "win32",
        env: WIN_ENV,
        execPath: realNode,
        async access(candidate) {
          if (candidate === realNode) return;
          throw new Error("ENOENT");
        },
        async execFile() { throw new Error("where should not run when execPath wins"); },
      });
      assert.strictEqual(fromExecPath, realNode);

      const fromWhere = await serverConfig.resolveNodeBinAsync({
        platform: "win32",
        env: WIN_ENV,
        execPath: "C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe",
        async access(candidate) {
          if (candidate === realNode) return;
          throw new Error("ENOENT");
        },
        async execFile() { return { stdout: `${shim}\r\n${realNode}\r\n` }; },
      });
      assert.strictEqual(fromWhere, realNode);

      const fromCommon = await serverConfig.resolveNodeBinAsync({
        platform: "win32",
        env: WIN_ENV,
        execPath: "C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe",
        async access(candidate) {
          if (candidate === realNode) return;
          throw new Error("ENOENT");
        },
        async execFile() { throw new Error("where failed"); },
      });
      assert.strictEqual(fromCommon, realNode);

      const none = await serverConfig.resolveNodeBinAsync({
        platform: "win32",
        env: WIN_ENV,
        execPath: "C:\\Program Files\\Clawd on Desk\\Clawd on Desk.exe",
        async access() { throw new Error("ENOENT"); },
        async execFile() { throw new Error("where failed"); },
      });
      assert.strictEqual(none, null);
    });
  });

  it("resolveNodeBin returns process.execPath when not in Electron", () => {
    const result = serverConfig.resolveNodeBin({
      platform: "darwin",
      isElectron: false,
      execPath: "/opt/homebrew/bin/node",
    });
    assert.strictEqual(result, "/opt/homebrew/bin/node");
  });

  it("resolveNodeBin finds node from well-known paths in Electron", () => {
    const result = serverConfig.resolveNodeBin({
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      accessSync(candidate) {
        if (candidate === "/opt/homebrew/bin/node") return;
        throw new Error("ENOENT");
      },
    });
    assert.strictEqual(result, "/opt/homebrew/bin/node");
  });

  it("resolveNodeBin falls back to login shell when no well-known paths exist", () => {
    const nodePath = "/Users/tester/.nvm/versions/node/v20.11.0/bin/node";
    const result = serverConfig.resolveNodeBin({
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      accessSync(candidate) {
        if (candidate === nodePath) return;
        throw new Error("ENOENT");
      },
      execFileSync(shell, args) {
        if (shell === "/bin/zsh") return `${nodePath}\n`;
        throw new Error("not found");
      },
    });
    assert.strictEqual(result, nodePath);
  });

  it("resolveNodeBin extracts node path from noisy interactive shell output", () => {
    const nodePath = "/Users/tester/.nvm/versions/node/v22.0.0/bin/node";
    const result = serverConfig.resolveNodeBin({
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      accessSync(candidate) {
        if (candidate === nodePath) return;
        throw new Error("ENOENT");
      },
      execFileSync(shell, args) {
        if (shell === "/bin/zsh") {
          // Simulates Oh My Zsh / Powerlevel10k / neofetch output before `which node`
          return "[oh-my-zsh] Would you like to check for updates? [Y/n]\n" +
                 "\n" +
                 `${nodePath}\n`;
        }
        throw new Error("not found");
      },
    });
    assert.strictEqual(result, nodePath);
  });

  it("resolveNodeBin scans nvm versions before falling back to shell probing", () => {
    const root = "/Users/tester/.nvm/versions/node";
    const expected = `${root}/v22.3.0/bin/node`;
    const result = serverConfig.resolveNodeBin({
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      accessSync(candidate) {
        if (candidate === expected) return;
        throw new Error("ENOENT");
      },
      readdirSync(dir) {
        if (dir === root) return ["v18.19.1", "not-node", "v22.3.0", "v20.11.0"];
        throw new Error("ENOENT");
      },
      execFileSync() {
        throw new Error("shell probing should not run when nvm node is found");
      },
    });

    assert.strictEqual(result, expected);
  });

  it("resolveNodeBin prefers versioned binaries over asdf shims", () => {
    const root = "/Users/tester/.asdf/installs/nodejs";
    const versionedNode = `${root}/20.11.1/bin/node`;
    const shimNode = "/Users/tester/.asdf/shims/node";
    const attempted = [];
    const result = serverConfig.resolveNodeBin({
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      accessSync(candidate) {
        attempted.push(candidate);
        if (candidate === versionedNode || candidate === shimNode) return;
        throw new Error("ENOENT");
      },
      readdirSync(dir) {
        if (dir === root) return ["20.11.1"];
        throw new Error("ENOENT");
      },
      execFileSync() {
        throw new Error("shell probing should not run when asdf node is found");
      },
    });

    assert.strictEqual(result, versionedNode);
    assert.ok(attempted.includes(versionedNode));
    assert.ok(!attempted.includes(shimNode));
  });

  it("resolveNodeBin keeps shell fallback when command -v returns a non-path token", () => {
    const nodePath = "/Users/tester/.nvm/versions/node/v20.11.0/bin/node";
    const result = serverConfig.resolveNodeBin({
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      accessSync(candidate) {
        if (candidate === nodePath) return;
        throw new Error("ENOENT");
      },
      readdirSync() { throw new Error("ENOENT"); },
      execFileSync(shell, args) {
        assert.deepStrictEqual(args, ["-lic", "command -v node 2>/dev/null; which node 2>/dev/null; true"]);
        if (shell === "/bin/zsh") return `node\n${nodePath}\n`;
        throw new Error("not found");
      },
    });

    assert.strictEqual(result, nodePath);
  });

  it("resolveNodeBin ignores shell function body lines that look like absolute paths", () => {
    const nodePath = "/Users/tester/.nvm/versions/node/v20.11.0/bin/node";
    const functionBodyLine = '/opt/homebrew/bin/node "$@"';
    const attempted = [];
    const result = serverConfig.resolveNodeBin({
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      accessSync(candidate) {
        attempted.push(candidate);
        if (candidate === nodePath) return;
        throw new Error("ENOENT");
      },
      readdirSync() { throw new Error("ENOENT"); },
      execFileSync(shell, args) {
        assert.deepStrictEqual(args, ["-lic", "command -v node 2>/dev/null; which node 2>/dev/null; true"]);
        if (shell === "/bin/zsh") return `${nodePath}\n${functionBodyLine}\n`;
        throw new Error("not found");
      },
    });

    assert.strictEqual(result, nodePath);
    assert.ok(!attempted.includes(functionBodyLine));
  });

  it("resolveNodeBin finds node on Linux via well-known paths in Electron", () => {
    const result = serverConfig.resolveNodeBin({
      platform: "linux",
      isElectron: true,
      homeDir: "/home/tester",
      accessSync(candidate) {
        if (candidate === "/usr/bin/node") return;
        throw new Error("ENOENT");
      },
    });
    assert.strictEqual(result, "/usr/bin/node");
  });

  it("resolveNodeBin returns null when nothing is found on macOS/Linux", () => {
    const result = serverConfig.resolveNodeBin({
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      accessSync() { throw new Error("ENOENT"); },
      execFileSync() { throw new Error("not found"); },
    });
    assert.strictEqual(result, null);
  });

  it("resolveNodeBinAsync finds node from well-known paths without sync probes", async () => {
    const result = await serverConfig.resolveNodeBinAsync({
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      async access(candidate) {
        if (candidate === "/opt/homebrew/bin/node") return;
        throw new Error("ENOENT");
      },
      async execFile() {
        throw new Error("shell probing should not run after a well-known path succeeds");
      },
      accessSync() {
        throw new Error("sync access should not run");
      },
      execFileSync() {
        throw new Error("sync exec should not run");
      },
    });

    assert.strictEqual(result, "/opt/homebrew/bin/node");
  });

  it("resolveNodeBinAsync falls back to async login shell output", async () => {
    const nodePath = "/Users/tester/.nvm/versions/node/v22.0.0/bin/node";
    const result = await serverConfig.resolveNodeBinAsync({
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      async access(candidate) {
        if (candidate === nodePath) return;
        throw new Error("ENOENT");
      },
      async execFile(shell, args) {
        assert.deepStrictEqual(args, ["-lic", "command -v node 2>/dev/null; which node 2>/dev/null; true"]);
        if (shell === "/bin/zsh") {
          return {
            stdout: `[oh-my-zsh]\n${nodePath}\n`,
          };
        }
        throw new Error("not found");
      },
      accessSync() {
        throw new Error("sync access should not run");
      },
      execFileSync() {
        throw new Error("sync exec should not run");
      },
    });

    assert.strictEqual(result, nodePath);
  });

  it("resolveNodeBinAsync scans fnm versions without sync probes", async () => {
    const root = "/Users/tester/.fnm/node-versions";
    const expected = `${root}/v21.7.3/installation/bin/node`;
    const result = await serverConfig.resolveNodeBinAsync({
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      async access(candidate) {
        if (candidate === expected) return;
        throw new Error("ENOENT");
      },
      async readdir(dir) {
        if (dir === root) return ["v18.20.0", "v21.7.3"];
        throw new Error("ENOENT");
      },
      async execFile() {
        throw new Error("shell probing should not run when fnm node is found");
      },
      accessSync() {
        throw new Error("sync access should not run");
      },
      execFileSync() {
        throw new Error("sync exec should not run");
      },
    });

    assert.strictEqual(result, expected);
  });

  it("postStateToRunningServer probes fallback ports before posting", async () => {
    const probes = [];
    const posts = [];

    await new Promise((resolve, reject) => {
      serverConfig.postStateToRunningServer(
        JSON.stringify({ state: "idle" }),
        {
          timeoutMs: 50,
          preferredPort: 23335,
          runtimePort: 23334,
          probePort(port, _timeoutMs, cb) {
            probes.push(port);
            cb(port === 23336);
          },
          postStateToPort(port, _payload, _timeoutMs, cb) {
            posts.push(port);
            cb(port === 23336, port);
          },
        },
        (ok, port) => {
          try {
            assert.strictEqual(ok, true);
            assert.strictEqual(port, 23336);
            assert.deepStrictEqual(posts, [23335, 23334, 23336]);
            assert.deepStrictEqual(probes, [23333, 23336]);
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });

  it("postStateToRunningServer raises short timeouts in CLAWD_REMOTE mode", async () => {
    const timeouts = [];

    await new Promise((resolve, reject) => {
      serverConfig.postStateToRunningServer(
        JSON.stringify({ state: "thinking" }),
        {
          timeoutMs: 100,
          preferredPort: 23333,
          env: { CLAWD_REMOTE: "1" },
          postStateToPort(port, _payload, timeoutMs, cb) {
            timeouts.push(timeoutMs);
            cb(true, port);
          },
        },
        (ok, port) => {
          try {
            assert.strictEqual(ok, true);
            assert.strictEqual(port, 23333);
            assert.deepStrictEqual(timeouts, [serverConfig.REMOTE_HOOK_HTTP_TIMEOUT_MS]);
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });

  it("postStateToRunningServer treats explicit remote option like remote hook mode", async () => {
    const timeouts = [];

    await new Promise((resolve, reject) => {
      serverConfig.postStateToRunningServer(
        JSON.stringify({ state: "working" }),
        {
          timeoutMs: 100,
          preferredPort: 23333,
          remote: true,
          postStateToPort(port, _payload, timeoutMs, cb) {
            timeouts.push(timeoutMs);
            cb(true, port);
          },
        },
        (ok, port) => {
          try {
            assert.strictEqual(ok, true);
            assert.strictEqual(port, 23333);
            assert.deepStrictEqual(timeouts, [serverConfig.REMOTE_HOOK_HTTP_TIMEOUT_MS]);
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });

  it("postStateToRunningServer lets remote false override CLAWD_REMOTE env", async () => {
    const timeouts = [];

    await new Promise((resolve, reject) => {
      serverConfig.postStateToRunningServer(
        JSON.stringify({ state: "working" }),
        {
          timeoutMs: 100,
          preferredPort: 23333,
          remote: false,
          env: { CLAWD_REMOTE: "1" },
          postStateToPort(port, _payload, timeoutMs, cb) {
            timeouts.push(timeoutMs);
            cb(true, port);
          },
        },
        (ok, port) => {
          try {
            assert.strictEqual(ok, true);
            assert.strictEqual(port, 23333);
            assert.deepStrictEqual(timeouts, [100]);
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });

  it("postPermissionToRunningServer raises discovery timeout in CLAWD_REMOTE mode", async () => {
    let capturedTimeout = null;

    await new Promise((resolve, reject) => {
      serverConfig.postPermissionToRunningServer(
        JSON.stringify({ tool_name: "bash" }),
        {
          probeTimeoutMs: 100,
          env: { CLAWD_REMOTE: "1" },
          discoverClawdPort(options, cb) {
            capturedTimeout = options.timeoutMs;
            cb(null);
          },
        },
        (ok, port) => {
          try {
            assert.strictEqual(ok, false);
            assert.strictEqual(port, null);
            assert.strictEqual(capturedTimeout, serverConfig.REMOTE_HOOK_HTTP_TIMEOUT_MS);
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });

  it("postPermissionToRunningServer raises preferred-port discovery timeout with explicit remote option", async () => {
    let capturedTimeout = null;
    let capturedPreferredPort = null;

    await new Promise((resolve, reject) => {
      serverConfig.postPermissionToRunningServer(
        JSON.stringify({ tool_name: "bash" }),
        {
          probeTimeoutMs: 100,
          preferredPort: 23335,
          remote: true,
          discoverClawdPort(options, cb) {
            capturedTimeout = options.timeoutMs;
            capturedPreferredPort = options.preferredPort;
            cb(23335);
          },
          postPermissionToPort(port, _payload, _timeoutMs, cb) {
            cb(true, port, "{}", 200);
          },
        },
        (ok, port) => {
          try {
            assert.strictEqual(ok, true);
            assert.strictEqual(port, 23335);
            assert.strictEqual(capturedPreferredPort, 23335);
            assert.strictEqual(capturedTimeout, serverConfig.REMOTE_HOOK_HTTP_TIMEOUT_MS);
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });

});
