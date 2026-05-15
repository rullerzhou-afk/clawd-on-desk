"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");

const {
  HOOK_FILES,
  resolveHooksDir,
  deploy,
  startCodexMonitor,
  stopCodexMonitor,
} = require("../src/remote-ssh-deploy");
const { clearRemoteNodeCache } = require("../src/remote-ssh-node");

const REPO_ROOT = path.join(__dirname, "..");

afterEach(() => {
  clearRemoteNodeCache();
});

// ── Manifest consistency: HOOK_FILES vs scripts/remote-deploy.sh FILES=() ──
//
// Strict regex parser per v6/v7 — expects each line inside FILES=( ... ) to
// be exactly `"$HOOKS_DIR/<basename>"`. Anything else (comments, vars,
// continuations) fails the test, forcing maintainers to update either the
// parser or the manifest deliberately.
test("HOOK_FILES matches scripts/remote-deploy.sh FILES=() array exactly", () => {
  const sh = fs.readFileSync(path.join(REPO_ROOT, "scripts", "remote-deploy.sh"), "utf8");
  const m = sh.match(/^FILES=\(([\s\S]*?)^\)/m);
  assert.ok(m, "FILES=() array not found in remote-deploy.sh");
  const block = m[1];
  const lines = block.split("\n");
  const lineRegex = /^\s*"\$HOOKS_DIR\/([^"]+)"\s*$/;
  const shellNames = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const lm = line.match(lineRegex);
    assert.ok(lm, `Unexpected FILES line (must match ^\\s*"\\$HOOKS_DIR/<name>"\\s*$): ${JSON.stringify(line)}`);
    shellNames.push(lm[1]);
  }
  // Set equality — order doesn't matter, but both lists must agree.
  const a = [...HOOK_FILES].sort();
  const b = [...shellNames].sort();
  assert.deepEqual(a, b, "HOOK_FILES (Node) and FILES=() (shell) must list the same hook files");
});

test("HOOK_FILES entries all exist in hooks/", () => {
  for (const name of HOOK_FILES) {
    const full = path.join(REPO_ROOT, "hooks", name);
    assert.ok(fs.existsSync(full), `missing on disk: hooks/${name}`);
  }
});

// ── resolveHooksDir ──

test("resolveHooksDir dev path → ../hooks", () => {
  const dir = resolveHooksDir({ isPackaged: false });
  assert.ok(dir.endsWith(path.join("animation", "hooks")) || dir.endsWith("hooks"));
  assert.equal(fs.existsSync(dir), true);
});

test("resolveHooksDir packaged path → process.resourcesPath/app.asar.unpacked/hooks", () => {
  const original = process.resourcesPath;
  Object.defineProperty(process, "resourcesPath", {
    value: "/fake/resources",
    configurable: true,
    writable: true,
  });
  try {
    const dir = resolveHooksDir({ isPackaged: true });
    assert.equal(dir, path.join("/fake/resources", "app.asar.unpacked", "hooks"));
  } finally {
    Object.defineProperty(process, "resourcesPath", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
});

// ── deploy: mocked spawn ──

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end(data) { child._stdin = (child._stdin || "") + (data || ""); },
  };
  child.kill = () => {};
  return child;
}

function makeRecordingSpawn(handlers) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = makeFakeChild();
    calls.push({ command, args, opts, child });
    // Look up handler by index (first call → handler[0], etc.)
    const idx = calls.length - 1;
    const handler = Array.isArray(handlers) ? handlers[idx] : handlers;
    if (typeof handler === "function") {
      queueMicrotask(() => handler(child, { command, args, opts }));
    } else if (handler && typeof handler === "object") {
      queueMicrotask(() => {
        if (handler.stdout) child.stdout.emit("data", Buffer.from(handler.stdout));
        if (handler.stderr) child.stderr.emit("data", Buffer.from(handler.stderr));
        child.emit("exit", handler.code != null ? handler.code : 0, handler.signal || null);
      });
    } else {
      queueMicrotask(() => child.emit("exit", 0, null));
    }
    return child;
  };
  return { spawn, calls };
}

function makeRuntimeStub() {
  const events = [];
  return {
    emit: (event, payload) => events.push({ event, payload }),
    events,
  };
}

function nodeProbeStdout(nodeBin = "/usr/bin/node", version = "v20.10.0", source = "path") {
  return [
    `CLAWD_REMOTE_NODE_BIN=${nodeBin}`,
    `CLAWD_REMOTE_NODE_VERSION=${version}`,
    `CLAWD_REMOTE_NODE_SOURCE=${source}`,
  ].join("\n");
}

test("deploy: full happy path emits expected progress sequence", async () => {
  // Use real hooks dir so file existence check passes.
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "user@pi",
    remoteForwardPort: 23333,
  };
  const { spawn } = makeRecordingSpawn([
    { code: 0 }, // mkdir
    { code: 0, stdout: nodeProbeStdout() }, // check-node
    { code: 0 }, // scp
    { code: 0 }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.remoteNode, {
    nodeBin: "/usr/bin/node",
    version: "v20.10.0",
    source: "path",
  });

  const steps = runtime.events.map((e) => `${e.payload.step}:${e.payload.status}`);
  assert.deepEqual(steps, [
    "verify:ok",
    "mkdir:start", "mkdir:ok",
    "check-node:start", "check-node:ok",
    "scp:start", "scp:ok",
    "install-claude:start", "install-claude:ok",
    "install-codex:start", "install-codex:ok",
    "install-copilot:start", "install-copilot:ok",
  ]);
});

test("deploy: reuses resolved absolute Node path for all remote installers", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "user@pi",
    remoteForwardPort: 23333,
  };
  const nodeBin = "/home/me/.nvm/versions/node/v22.1.0/bin/node";
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 }, // mkdir
    { code: 0, stdout: nodeProbeStdout(nodeBin, "v22.1.0", "shell:/bin/bash") },
    { code: 0 }, // scp
    { code: 0 }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir } });
  assert.equal(result.ok, true);

  const installCommands = calls.slice(3, 6).map((c) => c.args[c.args.length - 1]);
  assert.deepEqual(installCommands, [
    `'${nodeBin}' "$HOME/.claude/hooks/install.js" '--remote'`,
    `'${nodeBin}' "$HOME/.claude/hooks/codex-install.js" '--remote'`,
    `'${nodeBin}' "$HOME/.claude/hooks/copilot-install.js" '--remote'`,
  ]);
  for (const command of installCommands) {
    assert.equal(command.includes(" node "), false);
    assert.equal(command.startsWith("node "), false);
  }
});

test("deploy: verifies stale persisted Node metadata before using it", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "user@pi",
    remoteForwardPort: 23333,
    detectedRemoteNodeBin: "/stale/node",
    detectedRemoteNodeVersion: "v20.10.0",
    detectedRemoteNodeSource: "profile",
  };
  const nodeBin = "/home/me/.nvm/versions/node/v22.1.0/bin/node";
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 }, // mkdir
    { code: 127, stderr: "/stale/node: not found" }, // cached node verification
    { code: 0, stdout: nodeProbeStdout(nodeBin, "v22.1.0", "shell:/bin/bash") }, // full probe
    { code: 0 }, // scp
    { code: 0 }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir } });
  assert.equal(result.ok, true);
  assert.equal(result.remoteNode.nodeBin, nodeBin);
  assert.ok(calls[1].args[calls[1].args.length - 1].includes("/stale/node"));
  assert.ok(calls[4].args[calls[4].args.length - 1].startsWith(`'${nodeBin}'`));
});

test("deploy: with hostPrefix triggers host-prefix step via ssh stdin", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "pi",
    remoteForwardPort: 23333,
    hostPrefix: "raspberry",
  };
  let capturedStdin = null;
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 }, // mkdir
    { code: 0, stdout: nodeProbeStdout("/usr/bin/node", "v20.0.0") },
    { code: 0 }, // scp
    (child) => {
      // host-prefix step: capture stdin
      queueMicrotask(() => {
        capturedStdin = child._stdin;
        child.emit("exit", 0, null);
      });
    },
    { code: 0 }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir } });
  assert.equal(result.ok, true);
  assert.equal(capturedStdin, "raspberry");
  // The 4th call (index 3) must be the host-prefix ssh: cat > ~/.claude/hooks/clawd-host-prefix
  const hpCall = calls[3];
  assert.equal(hpCall.command, "ssh");
  const remoteCmd = hpCall.args[hpCall.args.length - 1];
  assert.equal(remoteCmd, "cat > ~/.claude/hooks/clawd-host-prefix");
  // Must NOT contain printf / echo of the hostPrefix value (no shell interp).
  for (const arg of hpCall.args) {
    assert.equal(arg.includes("raspberry"), false, "hostPrefix value must NOT appear in ssh args");
  }
});

test("deploy: scp uses CAPITAL -P for non-default port", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "pi",
    port: 2222,
    remoteForwardPort: 23333,
  };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 },
    { code: 0, stdout: nodeProbeStdout("/usr/bin/node", "v20") },
    { code: 0 },
    { code: 0 },
    { code: 0 },
  ]);
  const runtime = makeRuntimeStub();
  await deploy({ profile, runtime, deps: { spawn, hooksDir } });
  const scpCall = calls[2];
  assert.equal(scpCall.command, "scp");
  assert.ok(scpCall.args.includes("-P"), "scp must use -P for port (not -p)");
  assert.equal(scpCall.args.includes("-p"), false);
});

test("deploy: ssh and scp inject -i identityFile when set", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "pi",
    identityFile: "/home/me/.ssh/id_rsa",
    remoteForwardPort: 23333,
  };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 },
    { code: 0, stdout: nodeProbeStdout("/usr/bin/node", "v20") },
    { code: 0 },
    { code: 0 },
    { code: 0 },
  ]);
  const runtime = makeRuntimeStub();
  await deploy({ profile, runtime, deps: { spawn, hooksDir } });
  for (const c of calls) {
    const i = c.args.indexOf("-i");
    assert.ok(i >= 0, `every ssh/scp call must have -i: ${c.command} ${c.args.join(" ")}`);
    assert.equal(c.args[i + 1], "/home/me/.ssh/id_rsa");
  }
});

test("deploy: aborts when local hook file is missing", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-ssh-deploy-"));
  try {
    // Write only one file — the rest are missing.
    fs.writeFileSync(path.join(tmpDir, HOOK_FILES[0]), "// stub");
    const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
    const { spawn } = makeRecordingSpawn([]);
    const runtime = makeRuntimeStub();
    const result = await deploy({ profile, runtime, deps: { spawn, hooksDir: tmpDir } });
    assert.equal(result.ok, false);
    assert.equal(result.step, "verify");
    assert.match(result.message, /Missing files/);
    // No spawn calls — abort happened before networking.
    assert.equal(runtime.events[0].payload.status, "fail");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("deploy: aborts on mkdir failure", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
  const { spawn } = makeRecordingSpawn([
    { code: 255, stderr: "ssh: Permission denied" },
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir } });
  assert.equal(result.ok, false);
  assert.equal(result.step, "mkdir");
  assert.match(result.message, /Permission denied/);
});

test("deploy: aborts on missing remote node", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
  const { spawn } = makeRecordingSpawn([
    { code: 0 }, // mkdir ok
    { code: 1, stdout: "" }, // remote Node probe fails
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir } });
  assert.equal(result.ok, false);
  assert.equal(result.step, "check-node");
});

test("deploy: install-claude failure is non-fatal (best-effort)", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
  const { spawn } = makeRecordingSpawn([
    { code: 0 },
    { code: 0, stdout: nodeProbeStdout("/usr/bin/node", "v20") },
    { code: 0 },
    { code: 1, stderr: "install.js failed" }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir } });
  // ok=true even though install-claude failed
  assert.equal(result.ok, true);
  const steps = runtime.events.map((e) => `${e.payload.step}:${e.payload.status}`);
  assert.ok(steps.includes("install-claude:fail"));
  assert.ok(steps.includes("install-codex:ok"));
  assert.ok(steps.includes("install-copilot:ok"));
});

// ── Codex monitor PID management ──

test("startCodexMonitor pre-cleans then launches new monitor", async () => {
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23335 };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 }, // pre-clean
    { code: 0 }, // launch
  ]);
  const r = await startCodexMonitor({ profile, deps: { spawn, nodeBin: "/usr/bin/node" } });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  // First call: pre-clean (kill old PID + rm)
  const cleanCmd = calls[0].args[calls[0].args.length - 1];
  assert.match(cleanCmd, /\.clawd-codex-monitor\.pid/);
  assert.match(cleanCmd, /kill \$\(cat .*\.pid\) 2>\/dev\/null/);
  assert.match(cleanCmd, /rm -f .*\.pid/);
  assert.match(cleanCmd, /;\s*true\s*$/, "must terminate with `; true` so exit code is 0 even on missing pid");
  // Second call: launch with port + writes new PID file
  const startCmd = calls[1].args[calls[1].args.length - 1];
  assert.match(startCmd, /nohup '\/usr\/bin\/node' "\$HOME\/\.claude\/hooks\/codex-remote-monitor\.js" '--port' '23335'/);
  assert.match(startCmd, /echo \$! > ~\/\.clawd-codex-monitor\.pid/);
});

test("startCodexMonitor verifies stale persisted Node metadata before launch", async () => {
  const profile = {
    id: "p1",
    host: "pi",
    remoteForwardPort: 23335,
    detectedRemoteNodeBin: "/stale/node",
    detectedRemoteNodeVersion: "v20.10.0",
    detectedRemoteNodeSource: "profile",
  };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 127, stderr: "/stale/node: not found" },
    { code: 0, stdout: nodeProbeStdout("/usr/local/bin/node", "v22.1.0", "path") },
    { code: 0 }, // pre-clean
    { code: 0 }, // launch
  ]);
  const r = await startCodexMonitor({ profile, deps: { spawn } });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 4);
  assert.ok(calls[0].args[calls[0].args.length - 1].includes("/stale/node"));
  const startCmd = calls[3].args[calls[3].args.length - 1];
  assert.match(startCmd, /nohup '\/usr\/local\/bin\/node'/);
});

test("stopCodexMonitor kills PID and removes pid file (best-effort)", async () => {
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23335 };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 },
  ]);
  const r = await stopCodexMonitor({ profile, deps: { spawn } });
  assert.equal(r.ok, true);
  const cmd = calls[0].args[calls[0].args.length - 1];
  assert.match(cmd, /kill \$\(cat .*\.pid\)/);
  assert.match(cmd, /rm -f .*\.pid/);
});

test("deploy: registers each spawned child with runtime so cleanup can kill it", async () => {
  // Verifies the v7 follow-up: child processes spawned during Deploy must be
  // tracked by runtime.registerChild so before-quit cleanup() can kill them
  // if the user closes the app mid-Deploy.
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
  const registered = [];
  const unregistered = [];
  const runtime = {
    emit: () => {},
    registerChild: (c) => registered.push(c),
    unregisterChild: (c) => unregistered.push(c),
  };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 },
    { code: 0, stdout: nodeProbeStdout("/usr/bin/node", "v20") },
    { code: 0 },
    { code: 0 },
    { code: 0 },
  ]);
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir } });
  assert.equal(result.ok, true);
  // Each spawned child is registered exactly once and unregistered exactly once.
  assert.equal(registered.length, calls.length);
  assert.equal(unregistered.length, calls.length);
  // Same child object each time (set semantics).
  for (let i = 0; i < calls.length; i++) {
    assert.strictEqual(registered[i], calls[i].child);
    assert.strictEqual(unregistered[i], calls[i].child);
  }
});

test("startCodexMonitor / stopCodexMonitor register children with runtime when provided", async () => {
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23335 };
  const registered = [];
  const unregistered = [];
  const runtime = {
    registerChild: (c) => registered.push(c),
    unregisterChild: (c) => unregistered.push(c),
  };
  const { spawn } = makeRecordingSpawn([{ code: 0 }, { code: 0 }]);
  await startCodexMonitor({ profile, runtime, deps: { spawn, nodeBin: "/usr/bin/node" } });
  assert.equal(registered.length, 2);
  assert.equal(unregistered.length, 2);

  const stopRecorder = makeRecordingSpawn([{ code: 0 }]);
  await stopCodexMonitor({ profile, runtime, deps: { spawn: stopRecorder.spawn } });
  assert.equal(registered.length, 3);
  assert.equal(unregistered.length, 3);
});

test("stopCodexMonitor swallows failures (best-effort cleanup)", async () => {
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23335 };
  const { spawn } = makeRecordingSpawn([
    { code: 1, stderr: "no such file" },
  ]);
  const r = await stopCodexMonitor({ profile, deps: { spawn } });
  // Even on failure, returns ok:true — caller doesn't surface this.
  assert.equal(r.ok, true);
});
