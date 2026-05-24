"use strict";

const assert = require("node:assert");
const path = require("node:path");
const test = require("node:test");

const ensure = require("../scripts/ensure-sidecar-binaries");

function makeStream() {
  let text = "";
  return {
    write(chunk) {
      text += String(chunk);
    },
    text() {
      return text;
    },
  };
}

test("runtimeSidecarTarget maps supported runtime platforms to pinned sidecar targets", () => {
  assert.equal(ensure.runtimeSidecarTarget({ platform: "win32", arch: "x64" }).dir, "windows-x64");
  assert.equal(ensure.runtimeSidecarTarget({ platform: "darwin", arch: "arm64" }).dir, "darwin-arm64");
  assert.equal(ensure.runtimeSidecarTarget({ platform: "linux", arch: "x64" }).dir, "linux-x64");
  assert.equal(ensure.runtimeSidecarTarget({ platform: "linux", arch: "arm64" }), null);
});

test("ensureCurrentPlatformSidecar skips when the current binary already exists", async () => {
  const calls = [];
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "win32",
    arch: "x64",
    rootDir: "D:\\repo",
    env: {},
    fs: {
      existsSync: () => true,
      statSync: () => ({ isFile: () => true }),
    },
    fetchSidecarBinaries: () => {
      calls.push("fetch");
      throw new Error("should not fetch");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.existing, true);
  assert.equal(result.target, "windows-x64");
  assert.deepEqual(calls, []);
});

test("ensureCurrentPlatformSidecar fetches only the current platform target when missing", async () => {
  const fetchCalls = [];
  const stdout = makeStream();
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "win32",
    arch: "x64",
    rootDir: "D:\\repo",
    env: {},
    stdout,
    fs: {
      existsSync: () => false,
    },
    fetchSidecarBinaries: async (options) => {
      fetchCalls.push(options);
      return { ok: true, installed: [] };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.fetched, true);
  assert.equal(result.target, "windows-x64");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].target, "windows-x64");
  assert.equal(fetchCalls[0].rootDir, "D:\\repo");
  assert.equal(fetchCalls[0].requestTimeoutMs, ensure.DEFAULT_PREFLIGHT_REQUEST_TIMEOUT_MS);
  assert.match(stdout.text(), /fetching pinned binary/);
});

test("ensureCurrentPlatformSidecar reports fetch failures without throwing", async () => {
  const stderr = makeStream();
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "darwin",
    arch: "arm64",
    rootDir: "/repo",
    env: {},
    stdout: makeStream(),
    stderr,
    fs: {
      existsSync: () => false,
    },
    fetchSidecarBinaries: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.command, "npm run fetch:sidecars -- --target darwin-arm64");
  assert.match(stderr.text(), /could not be fetched automatically/);
  assert.match(stderr.text(), /npm run fetch:sidecars -- --target darwin-arm64/);
  assert.match(stderr.text(), /Set CLAWD_SKIP_SIDECAR_FETCH=1 before running npm start/);
});

test("ensureCurrentPlatformSidecar honors skip and valid override env vars", async () => {
  const fetchSidecarBinaries = () => {
    throw new Error("should not fetch");
  };
  assert.deepEqual(await ensure.ensureCurrentPlatformSidecar({
    env: { CLAWD_SKIP_SIDECAR_FETCH: "1" },
    fetchSidecarBinaries,
  }), { ok: true, skipped: true, reason: "env-skip" });
  const overrideDir = path.join("D:\\tools", "sidecar");
  const overrideExe = path.join(overrideDir, "cc-connect-clawd.exe");
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "win32",
    env: { CLAWD_CC_CONNECT_CLAWD_PATH: overrideDir },
    fs: {
      existsSync: (filePath) => filePath === overrideExe,
      statSync: (filePath) => {
        if (filePath === overrideDir) return { isDirectory: () => true, isFile: () => false };
        if (filePath === overrideExe) return { isDirectory: () => false, isFile: () => true };
        throw new Error(`unexpected path: ${filePath}`);
      },
    },
    fetchSidecarBinaries,
  });
  assert.deepEqual(result, { ok: true, skipped: true, reason: "override-path", path: overrideExe });
});

test("ensureCurrentPlatformSidecar reports a missing override path without fetching", async () => {
  const stderr = makeStream();
  const result = await ensure.ensureCurrentPlatformSidecar({
    env: { CLAWD_CC_CONNECT_CLAWD_PATH: "/tmp/missing-sidecar" },
    stderr,
    fs: {
      existsSync: () => false,
      statSync: () => {
        throw new Error("missing");
      },
    },
    fetchSidecarBinaries: () => {
      throw new Error("should not fetch");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "override-path-missing");
  assert.match(result.path, /missing-sidecar/);
  assert.match(stderr.text(), /CLAWD_CC_CONNECT_CLAWD_PATH is set but no sidecar executable was found/);
  assert.match(stderr.text(), /Clawd will still launch/);
});

test("ensureCurrentPlatformSidecar reports strict override failures accurately", async () => {
  const stderr = makeStream();
  const result = await ensure.ensureCurrentPlatformSidecar({
    strict: true,
    env: { CLAWD_CC_CONNECT_CLAWD_PATH: "/tmp/missing-sidecar" },
    stderr,
    fs: {
      existsSync: () => false,
      statSync: () => {
        throw new Error("missing");
      },
    },
    fetchSidecarBinaries: () => {
      throw new Error("should not fetch");
    },
  });

  assert.equal(result.ok, false);
  assert.match(stderr.text(), /Strict mode will stop launch/);
});

test("resolveOverridePath appends the runtime executable for directory-like values", () => {
  assert.equal(
    ensure.resolveOverridePath("D:\\tools\\sidecar\\", { platform: "win32", fs: { statSync: () => { throw new Error("skip"); } } }),
    path.join("D:\\tools\\sidecar\\", "cc-connect-clawd.exe")
  );
});

test("sidecarFetchCommand gives the manual recovery command", () => {
  assert.equal(
    ensure.sidecarFetchCommand("windows-x64"),
    "npm run fetch:sidecars -- --target windows-x64"
  );
});
