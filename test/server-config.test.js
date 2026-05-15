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

  it("resolveNodeBin returns bare node on Windows", () => {
    const result = serverConfig.resolveNodeBin({ platform: "win32" });
    assert.strictEqual(result, "node");
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

});
