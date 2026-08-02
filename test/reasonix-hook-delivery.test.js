"use strict";

// Delivery-level tests for hooks/reasonix-hook.js: not just "silent exit 0",
// but what actually reaches the Clawd server, under the timing and platform
// conditions that used to silently drop events. Helpers:
//   hook-http-recorder.js  — answers http as a healthy Clawd server, records bodies
//   reasonix-hook-snapshot-fake.js — plants a reasonix.exe ancestor in the WMI snapshot
//   reasonix-hook-platform-probe.js — fakes POSIX and records forbidden sync spawns
//   hook-orca-spy.js       — spies on applyOrcaPaneKey, stubs the resolver
//   hook-http-blocker.js   — fails all http (existing)

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pidCache = require("../hooks/pid-cache");
const { __test: reasonixInstallTest } = require("../hooks/reasonix-install");

const HOOK_PATH = path.resolve(__dirname, "..", "hooks", "reasonix-hook.js");
const RECORDER_PATH = path.resolve(__dirname, "hook-http-recorder.js");
const SNAPSHOT_FAKE_PATH = path.resolve(__dirname, "reasonix-hook-snapshot-fake.js");
const PLATFORM_PROBE_PATH = path.resolve(__dirname, "reasonix-hook-platform-probe.js");
const ORCA_SPY_PATH = path.resolve(__dirname, "hook-orca-spy.js");
const BLOCKER_PATH = path.resolve(__dirname, "hook-http-blocker.js");
const HANGER_PATH = path.resolve(__dirname, "hook-http-hanger.js");
const HANGER_NODE_OPTIONS_PATH = HANGER_PATH.replace(/\\/g, "/");

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reasonix-delivery-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function hookEnv(homeDir, extra = {}) {
  const tempDir = path.join(homeDir, "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    TEMP: tempDir,
    TMP: tempDir,
    ...extra,
  };
}

// A well-formed Clawd runtime identity owned by this (living) test runner, so
// the resolver's #681 zero-spawn gate opens inside spawned hooks.
function writeRuntimeIdentity(homeDir) {
  const clawdDir = path.join(homeDir, ".clawd");
  fs.mkdirSync(clawdDir, { recursive: true });
  fs.writeFileSync(
    path.join(clawdDir, "runtime.json"),
    JSON.stringify({ app: "clawd-on-desk", port: 23333, ownerPid: process.pid })
  );
}

function readRecords(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function spawnHook({ preload = [], payload, env = {}, home, timeout = 30000 }) {
  const homeDir = home || makeTempDir();
  return spawnSync(process.execPath, [...preload.flatMap((p) => ["--require", p]), HOOK_PATH], {
    input: JSON.stringify(payload) + "\n",
    encoding: "utf8",
    env: hookEnv(homeDir, env),
    windowsHide: true,
    timeout,
  });
}

describe("reasonix hook delivery", () => {
  it("still posts after a delayed (1800ms) stdin flush", async () => {
    const home = makeTempDir();
    const record = path.join(home, "http.jsonl");
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["--require", RECORDER_PATH, HOOK_PATH], {
      env: hookEnv(home, { CLAWD_HOOK_HTTP_RECORD: record }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const code = await new Promise((resolve) => {
      setTimeout(() => {
        child.stdin.end(
          JSON.stringify({ event: "UserPromptSubmit", sessionId: "s-1", cwd: "D:/proj", turn: 1 }) + "\n"
        );
      }, 1800);
      child.on("exit", resolve);
    });

    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, "");
    assert.strictEqual(stderr, "");
    assert.ok(Date.now() - startedAt >= 1800, "hook must actually wait for the late payload");
    const posts = readRecords(record).filter((entry) => entry.method === "POST");
    assert.strictEqual(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.strictEqual(body.event, "UserPromptSubmit");
    assert.strictEqual(body.state, "thinking");
    assert.strictEqual(body.session_id, "reasonix:s-1");
  });

  it("attaches PID metadata on non-SessionStart events too", () => {
    const home = makeTempDir();
    writeRuntimeIdentity(home);
    const record = path.join(home, "http.jsonl");
    const result = spawnHook({
      preload: [RECORDER_PATH, SNAPSHOT_FAKE_PATH],
      // PostToolUse is non-blocking, so a cache miss may safely take the fresh
      // snapshot that repairs a missed SessionStart / mid-session Clawd launch.
      payload: { event: "PostToolUse", sessionId: "native-pid", toolName: "bash", cwd: "D:/proj" },
      env: { CLAWD_HOOK_HTTP_RECORD: record },
      home,
    });

    assert.strictEqual(result.status, 0);
    const posts = readRecords(record).filter((entry) => entry.method === "POST");
    assert.strictEqual(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.strictEqual(body.event, "PostToolUse");
    // Planted by reasonix-hook-snapshot-fake.js: reasonix.exe at pid 4000,
    // the direct parent of the hook's own parent.
    assert.strictEqual(body.agent_pid, 4000);
    assert.ok(Number.isInteger(body.source_pid) && body.source_pid > 0);
    assert.ok(Array.isArray(body.pid_chain) && body.pid_chain.includes(4000));
  });

  it("keeps legacy snake_case session ids ahead of the native camelCase field", () => {
    const home = makeTempDir();
    const record = path.join(home, "http.jsonl");
    const result = spawnHook({
      preload: [RECORDER_PATH],
      payload: {
        event: "Stop",
        session_id: "legacy-session",
        sessionId: "native-session",
        cwd: "D:/proj",
      },
      env: { CLAWD_HOOK_HTTP_RECORD: record },
      home,
    });

    assert.strictEqual(result.status, 0);
    const posts = readRecords(record).filter((entry) => entry.method === "POST");
    assert.strictEqual(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.strictEqual(body.session_id, "reasonix:legacy-session");
  });

  it("posts a delayed blocking event without entering a cold synchronous WMI walk", { skip: process.platform !== "win32" }, async () => {
    const home = makeTempDir();
    writeRuntimeIdentity(home);
    const httpRecord = path.join(home, "http.jsonl");
    const snapshotRecord = path.join(home, "snapshot.jsonl");
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      ["--require", RECORDER_PATH, "--require", SNAPSHOT_FAKE_PATH, HOOK_PATH],
      {
        env: hookEnv(home, {
          CLAWD_HOOK_HTTP_RECORD: httpRecord,
          CLAWD_TEST_REASONIX_SNAPSHOT_RECORD: snapshotRecord,
          // A regression into resolve(event) blocks the JS timer for 3s and
          // pushes this 1800ms-late event beyond Reasonix's 5s outer budget.
          CLAWD_TEST_REASONIX_SNAPSHOT_DELAY_MS: "3000",
        }),
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const code = await new Promise((resolve) => {
      setTimeout(() => {
        child.stdin.end(JSON.stringify({
          event: "PreToolUse",
          sessionId: "native-blocking",
          cwd: "D:/proj",
          toolName: "bash",
        }) + "\n");
      }, 1800);
      child.on("exit", resolve);
    });
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, "");
    assert.strictEqual(stderr, "");
    assert.ok(elapsed >= 1800, `test must exercise delayed stdin (${elapsed}ms)`);
    assert.ok(elapsed < 4000, `blocking hook must leave wrapper headroom (${elapsed}ms)`);
    assert.deepStrictEqual(readRecords(snapshotRecord), [], "blocking cache miss must not start WMI");
    const posts = readRecords(httpRecord).filter((entry) => entry.method === "POST");
    assert.strictEqual(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.strictEqual(body.event, "PreToolUse");
    assert.strictEqual(body.session_id, "reasonix:native-blocking");
  });

  it("restores cached PID metadata for native camelCase blocking events without WMI", { skip: process.platform !== "win32" }, () => {
    const home = makeTempDir();
    const cacheDir = path.join(home, "tmp");
    fs.mkdirSync(cacheDir, { recursive: true });
    const rawSessionId = "native-cache-hit";
    const sessionId = `reasonix:${rawSessionId}`;
    const cwd = "D:/proj";
    const httpRecord = path.join(home, "http.jsonl");
    const snapshotRecord = path.join(home, "snapshot.jsonl");

    pidCache.__setCacheDirForTests(cacheDir);
    try {
      assert.strictEqual(pidCache.writePidCacheV2("reasonix", sessionId, cwd, {
        stablePid: process.pid,
        agentPid: process.pid,
        headless: false,
        detectedEditor: "vscode",
      }), true);

      const result = spawnHook({
        preload: [RECORDER_PATH, SNAPSHOT_FAKE_PATH],
        payload: { event: "PreToolUse", sessionId: rawSessionId, cwd, toolName: "bash" },
        env: {
          TEMP: cacheDir,
          TMP: cacheDir,
          CLAWD_HOOK_HTTP_RECORD: httpRecord,
          CLAWD_TEST_REASONIX_SNAPSHOT_RECORD: snapshotRecord,
        },
        home,
      });

      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, "");
      assert.strictEqual(result.stderr, "");
      assert.deepStrictEqual(readRecords(snapshotRecord), [], "cache hit must not start WMI");
      const posts = readRecords(httpRecord).filter((entry) => entry.method === "POST");
      assert.strictEqual(posts.length, 1);
      const body = JSON.parse(posts[0].body);
      assert.strictEqual(body.session_id, sessionId);
      assert.strictEqual(body.source_pid, process.pid);
      assert.strictEqual(body.agent_pid, process.pid);
      assert.strictEqual(body.editor, "vscode");
    } finally {
      pidCache.dropPidCacheV2("reasonix", sessionId, cwd);
      pidCache.__setCacheDirForTests(null);
    }
  });

  it("exits inside the blocking budget when stdin never arrives", async () => {
    const home = makeTempDir();
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["--require", BLOCKER_PATH, HOOK_PATH], {
      env: hookEnv(home),
    });
    // Never write and never close stdin: readStdinJsonDetailed's 2s window must
    // settle and fail open inside the 4s in-process deadline, leaving another
    // second for Reasonix's outer PowerShell/cmd wrapper.
    const code = await new Promise((resolve) => child.on("exit", resolve));
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(code, 0);
    assert.ok(elapsed >= 1800, `hook should wait out most of the stdin window (${elapsed}ms)`);
    assert.ok(elapsed < 4000, `hook must leave outer-wrapper headroom (${elapsed}ms)`);
  });

  it("keeps the real Windows EncodedCommand wrapper below Reasonix's 5s timeout", { skip: process.platform !== "win32" }, () => {
    const home = makeTempDir();
    const command = reasonixInstallTest.buildReasonixHookCommand(process.execPath, HOOK_PATH, {
      platform: "win32",
    });
    const startedAt = Date.now();
    const result = spawnSync("cmd.exe", ["/d", "/c", command], {
      input: JSON.stringify({
        event: "PreToolUse",
        sessionId: "native-wrapper",
        cwd: "D:/proj",
        toolName: "bash",
      }) + "\n",
      encoding: "utf8",
      env: hookEnv(home, { NODE_OPTIONS: `--require="${HANGER_NODE_OPTIONS_PATH}"` }),
      windowsHide: true,
      timeout: 6500,
    });
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(result.error, undefined, `wrapper timeout/error: ${result.error && result.error.message}`);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
    assert.ok(elapsed >= 3000, `HTTP hanger must reach the hook safety timer (${elapsed}ms)`);
    assert.ok(elapsed < 5000, `wrapper must finish before Reasonix blocks the turn (${elapsed}ms)`);
  });

  it("never starts a POSIX process walk from blocking events", () => {
    for (const platform of ["darwin", "linux"]) {
      const home = makeTempDir();
      const httpRecord = path.join(home, `${platform}-http.jsonl`);
      const spawnRecord = path.join(home, `${platform}-spawns.json`);
      const result = spawnHook({
        preload: [PLATFORM_PROBE_PATH, RECORDER_PATH],
        payload: {
          event: "PreToolUse",
          sessionId: `native-${platform}`,
          cwd: "/tmp/proj",
          toolName: "bash",
        },
        env: {
          CLAWD_TEST_PLATFORM: platform,
          CLAWD_TEST_SYNC_SPAWN_RECORD: spawnRecord,
          CLAWD_HOOK_HTTP_RECORD: httpRecord,
        },
        home,
      });

      assert.strictEqual(result.status, 0, `${platform} exit`);
      assert.strictEqual(result.stdout, "", `${platform} stdout`);
      assert.strictEqual(result.stderr, "", `${platform} stderr`);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(spawnRecord, "utf8")), [], `${platform} sync spawns`);
      const posts = readRecords(httpRecord).filter((entry) => entry.method === "POST");
      assert.strictEqual(posts.length, 1, `${platform} POST`);

      // Vacuity guard: prove that the synthetic platform took effect and that
      // the probe would catch the POSIX walk if this event were non-blocking.
      const nonBlockingHttpRecord = path.join(home, `${platform}-nonblocking-http.jsonl`);
      const nonBlockingSpawnRecord = path.join(home, `${platform}-nonblocking-spawns.json`);
      const nonBlockingResult = spawnHook({
        preload: [PLATFORM_PROBE_PATH, RECORDER_PATH],
        payload: {
          event: "PostToolUse",
          sessionId: `native-${platform}-nonblocking`,
          cwd: "/tmp/proj",
          toolName: "bash",
        },
        env: {
          CLAWD_TEST_PLATFORM: platform,
          CLAWD_TEST_SYNC_SPAWN_RECORD: nonBlockingSpawnRecord,
          CLAWD_HOOK_HTTP_RECORD: nonBlockingHttpRecord,
        },
        home,
      });

      assert.strictEqual(nonBlockingResult.status, 0, `${platform} non-blocking exit`);
      assert.strictEqual(nonBlockingResult.stdout, "", `${platform} non-blocking stdout`);
      assert.strictEqual(nonBlockingResult.stderr, "", `${platform} non-blocking stderr`);
      const nonBlockingSpawns = JSON.parse(fs.readFileSync(nonBlockingSpawnRecord, "utf8"));
      assert.strictEqual(nonBlockingSpawns.length, 1, `${platform} vacuity-guard spawn count`);
      assert.strictEqual(nonBlockingSpawns[0].file, "ps", `${platform} vacuity-guard executable`);
      const nonBlockingPosts = readRecords(nonBlockingHttpRecord).filter((entry) => entry.method === "POST");
      assert.strictEqual(nonBlockingPosts.length, 1, `${platform} non-blocking POST`);
    }
  });

  it("resolver name set covers the Linux comm-truncated reasonix-deskto", () => {
    // Linux /proc comm is capped at TASK_COMM_LEN(16)-1 = 15 chars, so
    // "reasonix-desktop" shows up as "reasonix-deskto" in ps/pgrep output.
    // Resolver matching is plain Set membership, so the truncated form must
    // be in the set. This runner is Windows (no linux ps walk available), so
    // pin the set at the source.
    const source = fs.readFileSync(HOOK_PATH, "utf8");
    assert.match(source, /linux:\s*new Set\(\[[^\]]*"reasonix-deskto"/);
  });

  it("keeps applyOrcaPaneKey on both local and remote paths", () => {
    for (const remote of [false, true]) {
      const home = makeTempDir();
      const record = path.join(home, "orca.jsonl");
      const result = spawnHook({
        preload: [ORCA_SPY_PATH, RECORDER_PATH],
        payload: { event: "PreToolUse", toolName: "bash", cwd: "D:/proj" },
        env: {
          CLAWD_TEST_ORCA_RECORD: record,
          CLAWD_HOOK_HTTP_RECORD: path.join(home, "http.jsonl"),
          ...(remote ? { CLAWD_REMOTE: "1" } : {}),
        },
        home,
      });

      const label = remote ? "remote" : "local";
      assert.strictEqual(result.status, 0, `${label} exit`);
      const calls = readRecords(record);
      assert.strictEqual(calls.length, 1, `${label} must call applyOrcaPaneKey exactly once`);
      assert.strictEqual(calls[0].event, "PreToolUse");
    }
  });

  it("posts the expected body for a real Reasonix native payload", () => {
    const home = makeTempDir();
    const record = path.join(home, "http.jsonl");
    const result = spawnHook({
      preload: [RECORDER_PATH],
      payload: {
        event: "UserPromptSubmit",
        sessionId: "9f1c2a",
        cwd: "D:/proj",
        prompt: "你好",
        turn: 3,
      },
      env: { CLAWD_HOOK_HTTP_RECORD: record },
      home,
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    const posts = readRecords(record).filter((entry) => entry.method === "POST");
    assert.strictEqual(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.deepStrictEqual(
      {
        state: body.state,
        event: body.event,
        agent_id: body.agent_id,
        session_id: body.session_id,
        cwd: body.cwd,
      },
      {
        state: "thinking",
        event: "UserPromptSubmit",
        agent_id: "reasonix",
        session_id: "reasonix:9f1c2a",
        cwd: "D:/proj",
      }
    );
  });
});
