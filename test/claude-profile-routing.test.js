"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SERVER_PORTS,
  claudeProfileRuntimeConfigPath,
  claudeProfileRuntimeKey,
  getPortCandidates,
  postStateToRunningServer,
  resolveClaudeProfileRuntimeOptions,
  writeRuntimeConfig,
} = require("../hooks/server-config");
const { getRecoveryDirForRuntimeConfig } = require("../hooks/session-recovery-lease");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-profile-routing-"));
}

const PROFILE_DIR = path.join(os.tmpdir(), "claude-profile-routing", ".claude-work");

function writeProfileRuntime(homeDir, port, ownerPid) {
  const runtimeConfigPath = claudeProfileRuntimeConfigPath(PROFILE_DIR, { homeDir });
  assert.ok(writeRuntimeConfig(port, { runtimeConfigPath, ownerPid }));
  return runtimeConfigPath;
}

test("profile runtime key is stable and ignores trailing separators", () => {
  assert.strictEqual(
    claudeProfileRuntimeKey(PROFILE_DIR),
    claudeProfileRuntimeKey(`${PROFILE_DIR}${path.sep}`)
  );
  assert.match(claudeProfileRuntimeKey(PROFILE_DIR), /^[a-f0-9]{16}$/);
  assert.strictEqual(
    claudeProfileRuntimeKey("C:\\Users\\Me\\.claude-work", { platform: "win32" }),
    claudeProfileRuntimeKey("c:\\users\\me\\.CLAUDE-WORK", { platform: "win32" })
  );
  assert.strictEqual(claudeProfileRuntimeKey("relative/dir"), null);
});

test("Claude hooks keep shared routing when CLAUDE_CONFIG_DIR is unset", () => {
  const homeDir = tempHome();
  assert.deepStrictEqual(resolveClaudeProfileRuntimeOptions({ env: {}, homeDir }), {});
  assert.deepStrictEqual(resolveClaudeProfileRuntimeOptions({ env: { CLAUDE_CONFIG_DIR: "" }, homeDir }), {});
});

test("Claude hooks keep shared routing when no pet runs for their profile", () => {
  const homeDir = tempHome();
  const env = { CLAUDE_CONFIG_DIR: PROFILE_DIR };
  assert.deepStrictEqual(resolveClaudeProfileRuntimeOptions({ env, homeDir }), {});
  // A crashed profile pet leaves its file; a dead owner must not capture events.
  writeProfileRuntime(homeDir, SERVER_PORTS[1], 424242);
  assert.deepStrictEqual(
    resolveClaudeProfileRuntimeOptions({ env, homeDir, isProcessAlive: () => false }),
    {}
  );
});

test("Claude hooks route to a live profile pet exclusively", () => {
  const homeDir = tempHome();
  const runtimeConfigPath = writeProfileRuntime(homeDir, SERVER_PORTS[2], process.pid);
  const options = resolveClaudeProfileRuntimeOptions({
    env: { CLAUDE_CONFIG_DIR: PROFILE_DIR },
    homeDir,
  });
  assert.deepStrictEqual(options, { runtimeConfigPath, runtimeExclusive: true });
  assert.deepStrictEqual(getPortCandidates(undefined, options), [SERVER_PORTS[2]]);
  assert.strictEqual(
    getRecoveryDirForRuntimeConfig(runtimeConfigPath),
    path.join(path.dirname(runtimeConfigPath), "session-recovery-v1")
  );
});

test("remote hooks never use local profile routing", () => {
  const homeDir = tempHome();
  writeProfileRuntime(homeDir, SERVER_PORTS[2], process.pid);
  assert.deepStrictEqual(
    resolveClaudeProfileRuntimeOptions({
      env: { CLAUDE_CONFIG_DIR: PROFILE_DIR, CLAWD_REMOTE: "1" },
      homeDir,
    }),
    {}
  );
});

test("shared routing still scans every server port", () => {
  assert.deepStrictEqual(getPortCandidates(undefined, { runtimePort: SERVER_PORTS[3] }), [
    SERVER_PORTS[3],
    ...SERVER_PORTS.filter((port) => port !== SERVER_PORTS[3]),
  ]);
});

test("an exclusive profile post never falls back to other ports", (_t, done) => {
  const tried = [];
  postStateToRunningServer("{}", {
    runtimePort: SERVER_PORTS[2],
    runtimeExclusive: true,
    postStateToPort: (port, _payload, _timeout, callback) => {
      tried.push(port);
      callback(false, port);
    },
    probePort: (port, _timeout, callback) => {
      tried.push(port);
      callback(false, port);
    },
  }, (posted) => {
    assert.strictEqual(posted, false);
    assert.deepStrictEqual(tried, [SERVER_PORTS[2]]);
    done();
  });
});
