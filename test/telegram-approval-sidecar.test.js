"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const {
  TelegramApprovalSidecar,
  parseHandshakeLine,
  buildSidecarEnv,
  resolveSidecarBinary,
  resolveSidecarBinaryPath,
  resolveOverrideBinaryPath,
  sidecarExecutableName,
  sidecarPlatformArchDir,
  sidecarResourceRelativePath,
  devSidecarFetchHint,
  defaultConfigPath,
  defaultTokenEnvFilePath,
  redactText,
  SIDECAR_ENV_CONFIG,
  SIDECAR_ENV_TOKEN_FILE,
  SIDECAR_PATH_ENV,
} = require("../src/telegram-approval-sidecar");
const { TARGETS: SIDECAR_FETCH_TARGETS } = require("../scripts/fetch-sidecar-binaries");

class FakeStream extends EventEmitter {
  setEncoding(value) {
    this.encoding = value;
  }
}

class FakeChild extends EventEmitter {
  constructor({ exitOnKill = true } = {}) {
    super();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.killed = false;
    this.killCalls = [];
    this.exitOnKill = exitOnKill;
  }

  kill(signal) {
    this.killed = true;
    this.killCalls.push(signal);
    if (this.exitOnKill) {
      queueMicrotask(() => this.emit("exit", null, signal || "SIGTERM"));
    }
    return true;
  }

  emitHandshake(port = 34567, token = "a".repeat(64)) {
    this.stdout.emit("data", `SIDECAR_LISTEN=127.0.0.1:${port} SIDECAR_TOKEN=${token}\n`);
  }
}

function makeSpawn(children) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = children.length ? children.shift() : new FakeChild();
    calls.push({ bin, args, opts, child });
    return child;
  };
  return { spawn, calls };
}

test("parseHandshakeLine accepts only local sidecar handshakes", () => {
  assert.deepEqual(parseHandshakeLine(`SIDECAR_LISTEN=127.0.0.1:23333 SIDECAR_TOKEN=${"f".repeat(64)}`), {
    listen: "127.0.0.1:23333",
    token: "f".repeat(64),
  });
  assert.equal(parseHandshakeLine(`SIDECAR_LISTEN=0.0.0.0:23333 SIDECAR_TOKEN=${"f".repeat(64)}`), null);
  assert.equal(parseHandshakeLine("hello"), null);
  assert.equal(parseHandshakeLine(`SIDECAR_LISTEN=127.0.0.1:70000 SIDECAR_TOKEN=${"f".repeat(64)}`), null);
});

test("buildSidecarEnv uses an allowlist and does not inherit unrelated secrets", () => {
  const env = buildSidecarEnv({
    platform: "win32",
    baseEnv: {
      PATH: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      OPENAI_API_KEY: "sk-should-not-inherit",
      RANDOM_SECRET: "nope",
      // Sidecar must read the token from the env-file at SIDECAR_ENV_TOKEN_FILE,
      // never inherit it from Clawd's process.env. If a stray CLAWD_TG_BOT_TOKEN
      // leaks into Clawd's environment (e.g. shell export), it MUST NOT be
      // forwarded to the child.
      CLAWD_TG_BOT_TOKEN: "123:should-not-inherit",
    },
    configPath: "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk\\cc-connect-clawd\\clawd-bridge.toml",
    tokenEnvFilePath: "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk\\telegram-approval.env",
  });
  assert.equal(env.PATH, "C:\\Windows");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.RANDOM_SECRET, undefined);
  assert.equal(env[SIDECAR_ENV_CONFIG].endsWith("clawd-bridge.toml"), true);
  assert.equal(env[SIDECAR_ENV_TOKEN_FILE].endsWith("telegram-approval.env"), true);
  assert.equal(env.CLAWD_TG_BOT_TOKEN, undefined);
});

test("buildSidecarEnv ignores any botToken option — token must come from the env-file", () => {
  // Defensive: even if a future caller mistakenly passes a token through the
  // options bag, buildSidecarEnv must not put it in the child env.
  const env = buildSidecarEnv({
    platform: "linux",
    baseEnv: { PATH: "/usr/bin" },
    configPath: "/userdata/cc-connect-clawd/clawd-bridge.toml",
    tokenEnvFilePath: "/userdata/telegram-approval.env",
    botToken: "123:caller-tried-to-pass-a-token",
  });
  assert.equal(env.CLAWD_TG_BOT_TOKEN, undefined);
});

test("sidecar manager parses handshake and creates a client", async () => {
  const child = new FakeChild();
  const { spawn, calls } = makeSpawn([child]);
  const sidecar = new TelegramApprovalSidecar({
    spawn,
    binaryPath: "D:\\tmp\\cc-connect-clawd\\cc-connect-clawd.exe",
    userDataDir: "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk",
    baseEnv: { PATH: "C:\\Windows", OPENAI_API_KEY: "sk-nope" },
    startupTimeoutMs: 100,
  });

  const ready = sidecar.start();
  child.emitHandshake(24444, "b".repeat(64));
  const client = await ready;

  assert.equal(sidecar.getStatus().status, "running");
  assert.equal(sidecar.getStatus().binaryPathSource, "explicit");
  assert.equal(sidecar.getStatus().listen, "127.0.0.1:24444");
  assert.equal(client.isEnabled(), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    "--config",
    defaultConfigPath("C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk"),
    "--env-file",
    defaultTokenEnvFilePath("C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk"),
  ]);
  assert.equal(calls[0].opts.env.OPENAI_API_KEY, undefined);
});

test("sidecar manager times out malformed startup and kills child", async () => {
  const child = new FakeChild({ exitOnKill: false });
  const { spawn } = makeSpawn([child]);
  const sidecar = new TelegramApprovalSidecar({
    spawn,
    binaryPath: "sidecar.exe",
    startupTimeoutMs: 10,
    autoRestart: false,
  });

  const promise = sidecar.start();
  child.stdout.emit("data", "not a handshake\n");
  await assert.rejects(promise, /timed out/);
  assert.equal(child.killed, true);
  assert.equal(sidecar.getStatus().status, "failed");
});

test("sidecar manager redacts stderr before logging", async () => {
  const child = new FakeChild();
  const logs = [];
  const { spawn } = makeSpawn([child]);
  const sidecar = new TelegramApprovalSidecar({
    spawn,
    binaryPath: "sidecar.exe",
    redactionSecrets: ["telegram:123456789", "987654321"],
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const ready = sidecar.start();
  child.stderr.emit(
    "data",
    "failed for telegram:123456789 user 987654321 token=123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi\n"
  );
  child.emitHandshake();
  await ready;

  const text = logs.map((entry) => entry.meta && entry.meta.text).join("\n");
  // Sanity: the redacted line is actually logged (regression guard — earlier
  // implementations would silently drop everything if the line buffer wasn't
  // flushed).
  assert.match(text, /failed for/);
  assert.equal(text.includes("telegram:123456789"), false);
  assert.equal(text.includes("987654321"), false);
  assert.equal(text.includes("123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"), false);
});

test("sidecar manager redacts stderr tokens that span chunk boundaries", async () => {
  const child = new FakeChild();
  const logs = [];
  const { spawn } = makeSpawn([child]);
  const sidecar = new TelegramApprovalSidecar({
    spawn,
    binaryPath: "sidecar.exe",
    redactionSecrets: ["telegram:123456789"],
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const ready = sidecar.start();
  // Simulate Node TCP splitting a single panic log in the middle of a token.
  // Without line buffering, the chunk-level regex would miss both halves and
  // the rebuilt log would contain the full token.
  child.stderr.emit("data", "panic: failed for chat telegram:1234");
  child.stderr.emit("data", "56789 token=123:ABCDEFGHIJKLMNOPQRSTU");
  child.stderr.emit("data", "VWXYZabcdefghi end\n");
  child.emitHandshake();
  await ready;

  const text = logs.map((entry) => entry.meta && entry.meta.text).join("\n");
  assert.match(text, /panic: failed for chat/);
  assert.equal(text.includes("telegram:123456789"), false);
  assert.equal(text.includes("123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"), false);
});

test("sidecar manager flushes any trailing partial stderr line on exit", async () => {
  const child = new FakeChild({ exitOnKill: false });
  const logs = [];
  const { spawn } = makeSpawn([child]);
  const sidecar = new TelegramApprovalSidecar({
    spawn,
    binaryPath: "sidecar.exe",
    autoRestart: false,
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const ready = sidecar.start();
  child.emitHandshake();
  await ready;
  // Crash log without a trailing newline — the line stays in stderrBuffer
  // until exit drains it.
  child.stderr.emit("data", "panic without newline 123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
  child.emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const text = logs.map((entry) => entry.meta && entry.meta.text).join("\n");
  assert.match(text, /panic without newline/);
  assert.equal(text.includes("123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"), false);
});

test("sidecar manager stop terminates child and marks stopped", async () => {
  const child = new FakeChild();
  const { spawn } = makeSpawn([child]);
  const sidecar = new TelegramApprovalSidecar({ spawn, binaryPath: "sidecar.exe" });
  const ready = sidecar.start();
  child.emitHandshake();
  await ready;

  await sidecar.stop();
  assert.equal(child.killCalls[0], "SIGTERM");
  assert.equal(sidecar.getStatus().status, "stopped");
});

test("sidecar manager restarts unexpected exits with a rate limit", async () => {
  const first = new FakeChild();
  const second = new FakeChild();
  const third = new FakeChild();
  const { spawn, calls } = makeSpawn([first, second, third]);
  const sidecar = new TelegramApprovalSidecar({
    spawn,
    binaryPath: "sidecar.exe",
    restartBackoffMs: 1,
    restartLimit: 1,
    restartWindowMs: 60000,
  });

  const firstReady = sidecar.start();
  first.emitHandshake(20001);
  await firstReady;
  first.emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 2);

  const secondReady = sidecar.start();
  second.emitHandshake(20002);
  await secondReady;
  second.emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 2, "restart rate limit should block a third spawn");
  assert.equal(sidecar.getStatus().status, "failed");
  assert.match(sidecar.getStatus().message, /rate limit/);
});

test("resolveSidecarBinaryPath honors explicit and env executable paths", () => {
  assert.equal(resolveSidecarBinaryPath({ binaryPath: "explicit.exe" }), "explicit.exe");
  assert.equal(resolveSidecarBinaryPath({
    env: { [SIDECAR_PATH_ENV]: "env.exe" },
  }), "env.exe");
});

test("resolveOverrideBinaryPath accepts a directory override for dev builds", () => {
  const fakeFs = {
    statSync: () => ({ isDirectory: () => true }),
  };
  assert.equal(
    resolveOverrideBinaryPath("D:\\tmp\\cc-connect-clawd", { platform: "win32", fs: fakeFs }),
    path.join("D:\\tmp\\cc-connect-clawd", "cc-connect-clawd.exe")
  );
});

test("resolveSidecarBinaryPath uses packaged resources path by platform and arch", () => {
  assert.equal(resolveSidecarBinaryPath({
    resourcesPath: "C:\\resources",
    platform: "win32",
    arch: "arm64",
    isPackaged: true,
  }), path.join("C:\\resources", "sidecars", "cc-connect-clawd", "windows-arm64", "cc-connect-clawd.exe"));
});

test("resolveSidecarBinaryPath ignores resourcesPath in source mode and falls back to repo bin", () => {
  const resolved = resolveSidecarBinary({
    resourcesPath: "C:\\resources",
    platform: "linux",
    arch: "x64",
    isPackaged: false,
  });
  assert.equal(resolved.source, "dev");
  assert.equal(
    resolved.path,
    path.join(__dirname, "..", "bin", "cc-connect-clawd", "linux-x64", "cc-connect-clawd")
  );
});

test("resolveSidecarBinaryPath treats resourcesPath without packaged mode as source fallback", () => {
  const resolved = resolveSidecarBinary({
    resourcesPath: "C:\\resources",
    platform: "win32",
    arch: "x64",
  });
  assert.equal(resolved.source, "dev");
  assert.equal(
    resolved.path,
    path.join(__dirname, "..", "bin", "cc-connect-clawd", "windows-x64", "cc-connect-clawd.exe")
  );
});

test("sidecar binary names are stable across packaged platforms", () => {
  assert.equal(sidecarExecutableName("win32"), "cc-connect-clawd.exe");
  assert.equal(sidecarExecutableName("darwin"), "cc-connect-clawd");
  assert.equal(sidecarExecutableName("linux"), "cc-connect-clawd");
  assert.equal(sidecarPlatformArchDir({ platform: "win32", arch: "x64" }), "windows-x64");
  assert.equal(sidecarPlatformArchDir({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
  assert.equal(
    sidecarResourceRelativePath({ platform: "linux", arch: "x64" }),
    path.join("sidecars", "cc-connect-clawd", "linux-x64", "cc-connect-clawd")
  );
});

test("source fetch hints cover every pinned fetch target", () => {
  const platformMap = { windows: "win32", darwin: "darwin", linux: "linux" };
  for (const target of SIDECAR_FETCH_TARGETS) {
    const hint = devSidecarFetchHint({ platform: platformMap[target.platform], arch: target.arch });
    assert.match(hint, new RegExp(`npm run fetch:sidecars -- --target ${target.dir}`));
  }
});

test("sidecar manager reports a clear missing binary error for resolved paths", async () => {
  const sidecar = new TelegramApprovalSidecar({
    env: {},
    baseEnv: {},
    platform: "win32",
    arch: "x64",
    isPackaged: true,
    resourcesPath: "C:\\resources",
    fs: { existsSync: () => false },
  });

  await assert.rejects(sidecar.start(), /sidecar binary not found/);
  assert.equal(sidecar.getStatus().status, "failed");
  assert.match(sidecar.getStatus().message, /windows-x64/);
});

test("sidecar manager reports a clear missing binary error for source-mode fallback", async () => {
  const sidecar = new TelegramApprovalSidecar({
    env: {},
    baseEnv: {},
    platform: "linux",
    arch: "x64",
    isPackaged: false,
    fs: { existsSync: () => false },
  });

  await assert.rejects(sidecar.start(), /sidecar binary not found/);
  assert.equal(sidecar.getStatus().status, "failed");
  assert.equal(sidecar.getStatus().binaryPathSource, "dev");
  assert.match(sidecar.getStatus().message, /linux-x64/);
  assert.match(sidecar.getStatus().message, /npm run fetch:sidecars -- --target linux-x64/);
});

test("sidecar manager does not suggest an unsupported source fetch target", async () => {
  const sidecar = new TelegramApprovalSidecar({
    env: {},
    baseEnv: {},
    platform: "linux",
    arch: "arm64",
    isPackaged: false,
    fs: { existsSync: () => false },
  });

  await assert.rejects(sidecar.start(), /sidecar binary not found/);
  assert.equal(sidecar.getStatus().status, "failed");
  assert.equal(sidecar.getStatus().binaryPathSource, "dev");
  assert.match(sidecar.getStatus().message, /No pinned Telegram approval sidecar is available for linux-arm64/);
  assert.match(sidecar.getStatus().message, /CLAWD_CC_CONNECT_CLAWD_PATH/);
  assert.doesNotMatch(sidecar.getStatus().message, /npm run fetch:sidecars -- --target linux-arm64/);
});

test("sidecar manager fails closed when binary availability cannot be checked", async () => {
  const sidecar = new TelegramApprovalSidecar({
    env: {},
    baseEnv: {},
    platform: "win32",
    arch: "x64",
    isPackaged: false,
    fs: {},
  });

  await assert.rejects(sidecar.start(), /availability check is unavailable/);
  assert.equal(sidecar.getStatus().status, "failed");
});

test("redactText masks known Telegram identifiers and token-like values", () => {
  const redacted = redactText("chat telegram:123456789 user 987654321 bot 123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", [
    "telegram:123456789",
  ]);
  assert.equal(redacted.includes("telegram:123456789"), false);
  assert.equal(redacted.includes("987654321"), false);
  assert.equal(redacted.includes("123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"), false);
});
