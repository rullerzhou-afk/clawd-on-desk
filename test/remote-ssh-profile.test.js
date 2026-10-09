"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  REMOTE_FORWARD_PORTS,
  REMOTE_LAYOUT_VERSION,
  REMOTE_IDENTITY_STEP_NAMES,
  isValidHost,
  isValidPort,
  isValidRemoteForwardPort,
  isValidIdentityFile,
  isValidHostPrefix,
  isValidLabel,
  isValidId,
  isValidDetectedRemoteNodeBin,
  validateProfile,
  sanitizeProfile,
  normalizeRemoteSsh,
  getDefaults,
  sanitizeIdentityTxn,
  sanitizeRuntimeModeTxn,
  isValidSshTransportMode,
  sanitizeSshTransportHint,
  remoteOwnershipDomainKey,
} = require("../src/remote-ssh-profile");

test("SSH transport mode defaults to auto and validates serialized override", () => {
  assert.equal(isValidSshTransportMode("auto"), true);
  assert.equal(isValidSshTransportMode("serialized"), true);
  assert.equal(isValidSshTransportMode("parallel"), false);
  assert.equal(sanitizeProfile(basicProfile()).sshTransportMode, "auto");
  assert.equal(sanitizeProfile(basicProfile({ sshTransportMode: "serialized" })).sshTransportMode, "serialized");
  assert.equal(validateProfile(basicProfile({ sshTransportMode: "parallel" })).status, "error");
});

test("historical SSH transport hints are strict and local-only data", () => {
  const codespace = sanitizeSshTransportHint({
    version: 1,
    mode: "serialized",
    kind: "codespaces-stdio",
    keyId: "codespace:fuzzy-space",
  });
  assert.deepEqual(codespace, {
    version: 1,
    mode: "serialized",
    kind: "codespaces-stdio",
    keyId: "codespace:fuzzy-space",
  });
  assert.equal(sanitizeSshTransportHint({ ...codespace, keyId: "codespace:../bad" }), null);
  assert.equal(sanitizeSshTransportHint({ ...codespace, mode: "parallel" }), null);
  assert.equal(sanitizeSshTransportHint({
    version: 1,
    mode: "serialized",
    kind: "explicit-serialized",
    keyId: `destination-sha256:${"a".repeat(64)}`,
  }).kind, "explicit-serialized");
});

// ── remoteForwardPort ↔ SERVER_PORTS invariant ──

// Secure remote hooks pin one exact port. Keep the profile validator aligned
// with server-config's historical range so migration/downgrade diagnostics
// stay deterministic.
test("REMOTE_FORWARD_PORTS stays equal to hooks/server-config SERVER_PORTS", () => {
  const { SERVER_PORTS } = require("../hooks/server-config");
  assert.deepEqual(REMOTE_FORWARD_PORTS, SERVER_PORTS);
});

test("remote ownership domains share account-default but separate isolated runtime keys", () => {
  const account = {
    host: "user@example.test",
    port: 22,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
  };
  assert.equal(
    remoteOwnershipDomainKey(account),
    remoteOwnershipDomainKey({ ...account, profileId: "another-profile" }),
  );
  assert.notEqual(
    remoteOwnershipDomainKey({
      ...account,
      runtimeMode: "profile-isolated",
      runtimeKey: "runtime_a",
    }),
    remoteOwnershipDomainKey({
      ...account,
      runtimeMode: "profile-isolated",
      runtimeKey: "runtime_b",
    }),
  );
});

// ── isValidHost ──

test("isValidHost accepts bare hostname", () => {
  for (const h of ["pi", "raspberry.local", "host-1", "abc_123", "a.b.c"]) {
    assert.equal(isValidHost(h), true, `expected ${h} valid`);
  }
});

test("isValidHost accepts user@host (single @)", () => {
  for (const h of ["user@host", "me@pi.local", "u_n@h-1"]) {
    assert.equal(isValidHost(h), true, h);
  }
});

test("isValidHost rejects multiple @", () => {
  assert.equal(isValidHost("a@b@c"), false);
  assert.equal(isValidHost("user@@host"), false);
});

test("isValidHost rejects leading dash (defeats ssh option injection)", () => {
  assert.equal(isValidHost("-oProxyCommand=evil"), false);
  assert.equal(isValidHost("-rm"), false);
});

test("isValidHost rejects control chars / newlines / spaces", () => {
  assert.equal(isValidHost("host\nname"), false);
  assert.equal(isValidHost("host name"), false);
  assert.equal(isValidHost("host\tname"), false);
  assert.equal(isValidHost("host\0name"), false);
});

test("isValidHost rejects empty / non-string / too long", () => {
  assert.equal(isValidHost(""), false);
  assert.equal(isValidHost(null), false);
  assert.equal(isValidHost(123), false);
  assert.equal(isValidHost("a".repeat(256)), false);
});

test("isValidHost rejects non-ASCII (forces explicit alias in ssh config)", () => {
  assert.equal(isValidHost("树莓派"), false);
});

// ── isValidPort ──

test("isValidPort accepts integer in [1, 65535]", () => {
  assert.equal(isValidPort(22), true);
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(65535), true);
});

test("isValidPort rejects out-of-range / non-integer", () => {
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(22.5), false);
  assert.equal(isValidPort("22"), false);
  assert.equal(isValidPort(-1), false);
});

// ── isValidRemoteForwardPort ──

test("isValidRemoteForwardPort accepts only SERVER_PORTS range 23333-23337", () => {
  for (const p of REMOTE_FORWARD_PORTS) {
    assert.equal(isValidRemoteForwardPort(p), true);
  }
});

test("isValidRemoteForwardPort rejects outside SERVER_PORTS", () => {
  assert.equal(isValidRemoteForwardPort(23332), false);
  assert.equal(isValidRemoteForwardPort(23338), false);
  assert.equal(isValidRemoteForwardPort(8080), false);
  assert.equal(isValidRemoteForwardPort(0), false);
});

// ── isValidIdentityFile ──

test("isValidIdentityFile accepts absolute Unix path", () => {
  assert.equal(isValidIdentityFile("/home/me/.ssh/id_rsa"), true);
});

test("isValidIdentityFile accepts absolute Windows path", () => {
  assert.equal(isValidIdentityFile("C:\\Users\\me\\.ssh\\id_rsa"), path.isAbsolute("C:\\Users\\me\\.ssh\\id_rsa"));
});

test("isValidIdentityFile rejects relative path", () => {
  assert.equal(isValidIdentityFile("./key"), false);
  assert.equal(isValidIdentityFile("key"), false);
  assert.equal(isValidIdentityFile("../key"), false);
});

test("isValidIdentityFile rejects leading dash (ssh option injection)", () => {
  assert.equal(isValidIdentityFile("-oProxyCommand=evil"), false);
});

test("isValidIdentityFile rejects control chars / newlines", () => {
  assert.equal(isValidIdentityFile("/home/me\nkey"), false);
  assert.equal(isValidIdentityFile("/home/me\tkey"), false);
  assert.equal(isValidIdentityFile("/home/me\0key"), false);
});

test("isValidIdentityFile accepts paths with spaces (legitimate)", () => {
  // Spaces are allowed in real filesystems — quoting at the consumer side handles them.
  assert.equal(isValidIdentityFile("/home/me/My Keys/id_rsa"), true);
});

// ── isValidHostPrefix ──

test("isValidHostPrefix accepts plain ASCII labels", () => {
  assert.equal(isValidHostPrefix("raspberrypi"), true);
  assert.equal(isValidHostPrefix("home-mac"), true);
  assert.equal(isValidHostPrefix("树莓派"), true);
});

test("isValidHostPrefix rejects single quote", () => {
  assert.equal(isValidHostPrefix("o'brien"), false);
});

test("isValidHostPrefix rejects double quote", () => {
  assert.equal(isValidHostPrefix('say "hi"'), false);
});

test("isValidHostPrefix rejects backtick", () => {
  assert.equal(isValidHostPrefix("`whoami`"), false);
});

test("isValidHostPrefix rejects dollar", () => {
  assert.equal(isValidHostPrefix("$HOME"), false);
});

test("isValidHostPrefix rejects backslash", () => {
  assert.equal(isValidHostPrefix("a\\b"), false);
});

test("isValidHostPrefix rejects exclamation (bash history)", () => {
  assert.equal(isValidHostPrefix("!cmd"), false);
});

test("isValidHostPrefix rejects newlines / control chars", () => {
  assert.equal(isValidHostPrefix("a\nb"), false);
  assert.equal(isValidHostPrefix("a\rb"), false);
  assert.equal(isValidHostPrefix("a\0b"), false);
});

// ── isValidLabel ──

test("isValidLabel accepts user-friendly names with spaces", () => {
  assert.equal(isValidLabel("My Raspberry Pi"), true);
  assert.equal(isValidLabel("树莓派"), true);
  assert.equal(isValidLabel("Home Mac (M1)"), true);
});

test("isValidLabel rejects empty / too long", () => {
  assert.equal(isValidLabel(""), false);
  assert.equal(isValidLabel("a".repeat(101)), false);
});

test("isValidLabel rejects newlines", () => {
  assert.equal(isValidLabel("line1\nline2"), false);
});

// ── isValidId ──

test("isValidId accepts alnum / underscore / dash", () => {
  assert.equal(isValidId("abc"), true);
  assert.equal(isValidId("a_1-b"), true);
});

test("isValidId rejects empty / too long / special chars", () => {
  assert.equal(isValidId(""), false);
  assert.equal(isValidId("local"), false);
  assert.equal(isValidId("a".repeat(65)), false);
  assert.equal(isValidId("has space"), false);
  assert.equal(isValidId("dot.id"), false);
});

test("isValidDetectedRemoteNodeBin accepts only absolute POSIX paths without controls", () => {
  assert.equal(isValidDetectedRemoteNodeBin("/home/me/.nvm/versions/node/v22/bin/node"), true);
  assert.equal(isValidDetectedRemoteNodeBin("/Users/me/My Tools/node"), true);
  assert.equal(isValidDetectedRemoteNodeBin("node"), false);
  assert.equal(isValidDetectedRemoteNodeBin("/tmp/no\nnode"), false);
});

// ── validateProfile ──

function basicProfile(over = {}) {
  return {
    id: "p1",
    label: "My Pi",
    host: "user@pi.local",
    remoteForwardPort: 23333,
    autoStartCodexMonitor: false,
    connectOnLaunch: false,
    ...over,
  };
}

function revocableProfile(over = {}) {
  return basicProfile({
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: REMOTE_LAYOUT_VERSION,
    routingNonce: "a".repeat(32),
    previousNonce: "9".repeat(32),
    previousExpiresAt: Date.now() + 60_000,
    ...over,
  });
}

function verifiedIsolatedProfile(over = {}) {
  const runtimeKey = "runtime_A7";
  const runtimeRoot = `/home/shared/.clawd/profiles/${runtimeKey}`;
  const absentCapability = {
    present: false,
    versionVerified: false,
    artifactVerified: false,
    wrapperInvoked: false,
  };
  return sanitizeProfile(basicProfile({
    runtimeMode: "profile-isolated",
    runtimeKey,
    layoutVersion: REMOTE_LAYOUT_VERSION,
    remoteHome: "/home/shared",
    isolatedRuntime: {
      runtimeRoot,
      binDir: `${runtimeRoot}/bin`,
      active: true,
      verifiedAt: 1,
      capabilities: {
        claude: {
          present: true,
          versionVerified: true,
          artifactVerified: true,
          wrapperInvoked: true,
          executablePath: "/opt/tools/claude",
          wrapperPath: `${runtimeRoot}/bin/claude`,
          version: "2.1.211",
        },
        codex: absentCapability,
        copilot: absentCapability,
      },
    },
    ...over,
  }));
}

test("validateProfile accepts minimal valid profile", () => {
  assert.equal(validateProfile(basicProfile()).status, "ok");
});

test("validateProfile rejects missing id", () => {
  const p = basicProfile();
  delete p.id;
  assert.equal(validateProfile(p).status, "error");
});

test("validateProfile rejects bad host", () => {
  assert.equal(validateProfile(basicProfile({ host: "-evil" })).status, "error");
  assert.equal(validateProfile(basicProfile({ host: "a@b@c" })).status, "error");
});

test("validateProfile rejects out-of-range remoteForwardPort", () => {
  assert.equal(validateProfile(basicProfile({ remoteForwardPort: 22 })).status, "error");
  assert.equal(validateProfile(basicProfile({ remoteForwardPort: 23338 })).status, "error");
});

test("validateProfile rejects relative identityFile", () => {
  const p = basicProfile({ identityFile: "./key" });
  assert.equal(validateProfile(p).status, "error");
});

test("validateProfile rejects identityFile starting with dash", () => {
  const p = basicProfile({ identityFile: "-oProxyCommand=evil" });
  assert.equal(validateProfile(p).status, "error");
});

test("validateProfile rejects hostPrefix with shell metacharacters", () => {
  for (const bad of ["o'brien", '"hi"', "`x`", "$HOME", "a\\b", "!run"]) {
    const r = validateProfile(basicProfile({ hostPrefix: bad }));
    assert.equal(r.status, "error", `expected reject: ${JSON.stringify(bad)}`);
  }
});

test("validateProfile accepts safe hostPrefix values", () => {
  for (const ok of ["raspberrypi", "home-mac", "pi.local", "树莓派"]) {
    const r = validateProfile(basicProfile({ hostPrefix: ok }));
    assert.equal(r.status, "ok", `expected accept: ${JSON.stringify(ok)}`);
  }
});

test("validateProfile accepts lastDeployedAt as positive finite number", () => {
  assert.equal(validateProfile(basicProfile({ lastDeployedAt: Date.now() })).status, "ok");
});

test("validateProfile accepts profiles without lastDeployedAt (fresh / never deployed)", () => {
  const p = basicProfile();
  delete p.lastDeployedAt;
  assert.equal(validateProfile(p).status, "ok");
});

test("validateProfile rejects negative / zero / non-finite lastDeployedAt", () => {
  assert.equal(validateProfile(basicProfile({ lastDeployedAt: -1 })).status, "error");
  assert.equal(validateProfile(basicProfile({ lastDeployedAt: 0 })).status, "error");
  assert.equal(validateProfile(basicProfile({ lastDeployedAt: NaN })).status, "error");
  assert.equal(validateProfile(basicProfile({ lastDeployedAt: Infinity })).status, "error");
  assert.equal(validateProfile(basicProfile({ lastDeployedAt: "today" })).status, "error");
});

test("sanitizeProfile preserves valid lastDeployedAt; drops invalid", () => {
  const ts = Date.now();
  const ok = sanitizeProfile({ ...basicProfile(), lastDeployedAt: ts });
  assert.equal(ok.lastDeployedAt, ts);
  // Invalid values are dropped (becomes undefined → omitted from JSON).
  const bad = sanitizeProfile({ ...basicProfile(), lastDeployedAt: -5 });
  assert.equal(Object.prototype.hasOwnProperty.call(bad, "lastDeployedAt"), false);
});

test("validateProfile accepts detected remote Node metadata", () => {
  const r = validateProfile(basicProfile({
    detectedRemoteNodeBin: "/home/me/.nvm/versions/node/v22/bin/node",
    detectedRemoteNodeVersion: "v22.1.0",
    detectedRemoteNodeSource: "shell:/bin/bash",
    detectedRemoteNodeAt: 12345,
  }));
  assert.equal(r.status, "ok");
});

test("validateProfile rejects invalid detected remote Node metadata", () => {
  assert.equal(validateProfile(basicProfile({ detectedRemoteNodeBin: "node" })).status, "error");
  assert.equal(validateProfile(basicProfile({ detectedRemoteNodeVersion: "22.1.0" })).status, "error");
  assert.equal(validateProfile(basicProfile({ detectedRemoteNodeSource: "bad\nsource" })).status, "error");
  assert.equal(validateProfile(basicProfile({ detectedRemoteNodeAt: 0 })).status, "error");
});

test("sanitizeProfile preserves valid detected remote Node metadata; drops invalid", () => {
  const ok = sanitizeProfile({
    ...basicProfile(),
    detectedRemoteNodeBin: "/opt/homebrew/bin/node",
    detectedRemoteNodeVersion: "v20.10.0",
    detectedRemoteNodeSource: "candidate",
    detectedRemoteNodeAt: 12345,
  });
  assert.equal(ok.detectedRemoteNodeBin, "/opt/homebrew/bin/node");
  assert.equal(ok.detectedRemoteNodeVersion, "v20.10.0");
  assert.equal(ok.detectedRemoteNodeSource, "candidate");
  assert.equal(ok.detectedRemoteNodeAt, 12345);

  const bad = sanitizeProfile({
    ...basicProfile(),
    detectedRemoteNodeBin: "node",
    detectedRemoteNodeVersion: "v20.10.0",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(bad, "detectedRemoteNodeBin"), false);
});

test("validateProfile rejects non-boolean autoStartCodexMonitor / connectOnLaunch", () => {
  assert.equal(validateProfile(basicProfile({ autoStartCodexMonitor: "true" })).status, "error");
  assert.equal(validateProfile(basicProfile({ connectOnLaunch: 1 })).status, "error");
});

// ── sanitizeProfile ──

test("sanitizeProfile fills createdAt and strips unknown fields", () => {
  const out = sanitizeProfile({
    id: "p1",
    label: "My Pi",
    host: "user@pi",
    remoteForwardPort: 23333,
    autoStartCodexMonitor: false,
    connectOnLaunch: false,
    randomGarbage: "ignore me",
  });
  assert.ok(out);
  assert.equal(out.id, "p1");
  assert.ok(Number.isFinite(out.createdAt));
  assert.equal(Object.prototype.hasOwnProperty.call(out, "randomGarbage"), false);
});

test("sanitizeProfile returns null on invalid input", () => {
  assert.equal(sanitizeProfile(null), null);
  assert.equal(sanitizeProfile({}), null);
  assert.equal(sanitizeProfile({ id: "p1" }), null);
});

test("sanitizeProfile migrates old profiles into the account-default layout domain", () => {
  const out = sanitizeProfile(basicProfile());
  assert.equal(out.runtimeMode, "account-default");
  assert.equal(out.runtimeKey, "account-default");
  assert.equal(out.layoutVersion, REMOTE_LAYOUT_VERSION);
  assert.equal(out.isolatedActive, false);
});

test("sanitizeProfile validates profile-isolated runtime keys", () => {
  const ok = sanitizeProfile(basicProfile({
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_A7",
  }));
  assert.equal(ok.runtimeKey, "runtime_A7");
  assert.equal(sanitizeProfile(basicProfile({
    runtimeMode: "profile-isolated",
    runtimeKey: "../escape",
  })), null);
  assert.equal(sanitizeProfile(basicProfile({
    runtimeMode: "profile-isolated",
    runtimeKey: "account-default",
  })), null);
});

test("sanitizeProfile derives isolated activation only from matching verified evidence", () => {
  const raw = basicProfile({
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_A7",
    remoteHome: "/home/shared",
    isolatedActive: true,
  });
  assert.equal(sanitizeProfile(raw).isolatedActive, false);

  const runtimeRoot = "/home/shared/.clawd/profiles/runtime_A7";
  const capabilities = {
    claude: {
      present: true,
      versionVerified: true,
      artifactVerified: true,
      wrapperInvoked: true,
      executablePath: "/opt/tools/claude",
      wrapperPath: `${runtimeRoot}/bin/claude`,
      version: "2.1.211",
    },
    codex: {
      present: false,
      versionVerified: false,
      artifactVerified: false,
      wrapperInvoked: false,
    },
    copilot: {
      present: false,
      versionVerified: false,
      artifactVerified: false,
      wrapperInvoked: false,
    },
  };
  const matching = sanitizeProfile({
    ...raw,
    isolatedRuntime: {
      runtimeRoot,
      binDir: `${runtimeRoot}/bin`,
      active: true,
      verifiedAt: 1,
      capabilities,
    },
  });
  assert.equal(matching.isolatedActive, true);

  const mismatched = sanitizeProfile({
    ...raw,
    isolatedRuntime: {
      runtimeRoot: "/home/shared/.clawd/profiles/another_runtime",
      binDir: "/home/shared/.clawd/profiles/another_runtime/bin",
      active: true,
      verifiedAt: 1,
      capabilities,
    },
  });
  assert.equal(mismatched.isolatedActive, false);
});

test("normalizeRemoteSsh blocks duplicate isolated runtime keys without dropping profiles", () => {
  const out = normalizeRemoteSsh({
    profiles: [
      basicProfile({
        id: "a",
        runtimeMode: "profile-isolated",
        runtimeKey: "same_root",
        isolatedActive: true,
      }),
      basicProfile({
        id: "b",
        runtimeMode: "profile-isolated",
        runtimeKey: "same_root",
        isolatedActive: true,
      }),
    ],
  });
  assert.equal(out.profiles.length, 2);
  for (const profile of out.profiles) {
    assert.equal(profile.isolatedActive, false);
    assert.equal(profile.runtimeKeyConflict, true);
  }
});

test("identity transaction is layout-bound and requires evidence for N/A steps", () => {
  const steps = Object.fromEntries(
    REMOTE_IDENTITY_STEP_NAMES.map((name) => [name, { status: "pending" }]),
  );
  steps.installCopilot = { status: "not-applicable", evidence: "agent-not-installed" };
  const raw = {
    runtimeKey: "account-default",
    layoutVersion: REMOTE_LAYOUT_VERSION,
    phase: "rotating",
    fromNonce: null,
    toNonce: "a".repeat(32),
    startedAt: 1000,
    previousExpiresAt: 901000,
    steps,
  };
  assert.ok(sanitizeIdentityTxn(raw, {
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: REMOTE_LAYOUT_VERSION,
  }));
  const invalid = structuredClone(raw);
  invalid.steps.installCopilot = { status: "not-applicable" };
  assert.equal(sanitizeIdentityTxn(invalid, {
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: REMOTE_LAYOUT_VERSION,
  }), null);
});

test("runtime mode transaction is layout-bound, survives normalization, and rejects target drift", () => {
  const txn = {
    fromMode: "account-default",
    fromKey: "account-default",
    toMode: "profile-isolated",
    toKey: "rt_resume",
    layoutVersion: 1,
    phase: "cleanup-done",
    startedAt: 123,
  };
  assert.deepEqual(sanitizeRuntimeModeTxn(txn), txn);
  const profile = sanitizeProfile(basicProfile({ runtimeModeTxn: txn }));
  assert.deepEqual(profile.runtimeModeTxn, txn);
  assert.equal(sanitizeRuntimeModeTxn({ ...txn, toKey: "../escape" }), null);
  assert.equal(sanitizeRuntimeModeTxn({ ...txn, phase: "invented" }), null);
  assert.equal(
    sanitizeProfile(basicProfile({
      runtimeMode: "profile-isolated",
      runtimeKey: "different",
      runtimeModeTxn: txn,
    })).runtimeModeTxn,
    undefined,
  );
});

// ── normalizeRemoteSsh (load path) ──

test("normalizeRemoteSsh drops invalid profiles silently", () => {
  const cleaned = normalizeRemoteSsh({
    profiles: [
      basicProfile(),
      { id: "bad-host", label: "x", host: "-evil", remoteForwardPort: 23333,
        autoStartCodexMonitor: false, connectOnLaunch: false },
      basicProfile({ id: "p2", host: "pi2" }),
    ],
  });
  assert.equal(cleaned.profiles.length, 2);
  assert.deepEqual(cleaned.profiles.map((p) => p.id), ["p1", "p2"]);
});

test("normalizeRemoteSsh dedups by id (first wins)", () => {
  const cleaned = normalizeRemoteSsh({
    profiles: [
      basicProfile({ id: "p1", host: "pi1" }),
      basicProfile({ id: "p1", host: "pi2" }),
    ],
  });
  assert.equal(cleaned.profiles.length, 1);
  assert.equal(cleaned.profiles[0].host, "pi1");
});

test("normalizeRemoteSsh returns defaults for non-object", () => {
  assert.deepEqual(normalizeRemoteSsh(null), getDefaults());
  assert.deepEqual(normalizeRemoteSsh([]), getDefaults());
  assert.deepEqual(normalizeRemoteSsh("nope"), getDefaults());
});

// ── settings-actions: command registry ──

const { commandRegistry, updateRegistry } = require("../src/settings-actions");

test("settings-actions: remoteSsh validator accepts empty profiles list", () => {
  const r = updateRegistry.remoteSsh({ profiles: [] });
  assert.equal(r.status, "ok");
});

test("settings-actions: remoteSsh validator rejects bad profile in list", () => {
  const r = updateRegistry.remoteSsh({ profiles: [basicProfile({ host: "-evil" })] });
  assert.equal(r.status, "error");
  assert.match(r.message, /profiles\[0\]/);
});

test("settings-actions: remoteSsh validator rejects non-object", () => {
  assert.equal(updateRegistry.remoteSsh(null).status, "error");
  assert.equal(updateRegistry.remoteSsh({ profiles: "no" }).status, "error");
});

test("settings-actions: remoteSsh.add inserts new profile and returns commit", () => {
  const cmd = commandRegistry["remoteSsh.add"];
  const r = cmd(basicProfile(), { snapshot: { remoteSsh: { profiles: [] } } });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.commit.remoteSsh.profiles.map((p) => p.id), ["p1"]);
});

test("settings-actions: remoteSsh.add cannot manufacture deployment ownership", () => {
  const cmd = commandRegistry["remoteSsh.add"];
  const r = cmd(basicProfile({
    lastDeployedAt: 12345,
    managedDeployTargets: [{
      host: "user@victim",
      remoteForwardPort: 23333,
      deployedAt: 12345,
    }],
  }), { snapshot: { remoteSsh: { profiles: [] } } });
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.profiles[0].lastDeployedAt, undefined);
  assert.equal(r.commit.remoteSsh.profiles[0].managedDeployTargets, undefined);
});

test("settings-actions: remoteSsh.add rejects duplicate id", () => {
  const cmd = commandRegistry["remoteSsh.add"];
  const r = cmd(basicProfile(), {
    snapshot: { remoteSsh: { profiles: [basicProfile()] } },
  });
  assert.equal(r.status, "error");
  assert.match(r.message, /already exists/);
});

test("settings-actions: remoteSsh.add rejects invalid input", () => {
  const cmd = commandRegistry["remoteSsh.add"];
  const r = cmd({ id: "bad", label: "x", host: "-evil",
                  remoteForwardPort: 23333,
                  autoStartCodexMonitor: false, connectOnLaunch: false },
                { snapshot: { remoteSsh: { profiles: [] } } });
  assert.equal(r.status, "error");
});

test("settings-actions: remoteSsh.forceRevoke all creates a schema-valid C transaction", () => {
  const cmd = commandRegistry["remoteSsh.forceRevoke"];
  const current = revocableProfile({ lastDeployedAt: 12345 });
  const r = cmd({ id: "p1", mode: "all", confirmed: true }, {
    snapshot: { remoteSsh: { profiles: [current] } },
  });
  const updated = r.commit.remoteSsh.profiles[0];

  assert.equal(r.status, "ok");
  assert.equal(validateProfile(updated).status, "ok");
  assert.ok(sanitizeIdentityTxn(updated.identityTxn, updated));
  assert.ok(updated.identityTxn.previousExpiresAt > updated.identityTxn.startedAt);
  assert.equal(updated.routingNonce, undefined);
  assert.equal(updated.previousNonce, undefined);
  assert.equal(updated.previousExpiresAt, undefined);
});

// ── deployTargetFingerprint / deployTargetDrift ──

const {
  deployTargetFingerprint,
  deployTargetDrift,
  DEPLOY_TARGET_FIELDS,
} = require("../src/remote-ssh-profile");

test("deployTargetFingerprint normalizes port 22 to undefined (matches UI omit-default)", () => {
  const a = deployTargetFingerprint({ host: "pi", port: 22, remoteForwardPort: 23333 });
  const b = deployTargetFingerprint({ host: "pi", remoteForwardPort: 23333 });
  assert.equal(a.port, undefined);
  assert.equal(b.port, undefined);
  assert.equal(deployTargetDrift(a, b), null, "port 22 ≡ undefined must not drift");
});

test("deployTargetFingerprint preserves non-default port", () => {
  const fp = deployTargetFingerprint({ host: "pi", port: 2222, remoteForwardPort: 23333 });
  assert.equal(fp.port, 2222);
});

test("deployTargetFingerprint normalizes empty optional strings to undefined", () => {
  const fp1 = deployTargetFingerprint({
    host: "pi", remoteForwardPort: 23333,
    identityFile: "", hostPrefix: "",
  });
  const fp2 = deployTargetFingerprint({
    host: "pi", remoteForwardPort: 23333,
  });
  assert.equal(fp1.identityFile, undefined);
  assert.equal(fp1.hostPrefix, undefined);
  assert.equal(deployTargetDrift(fp1, fp2), null);
});

test("deployTargetDrift detects each field change deterministically", () => {
  const base = { host: "pi", port: 22, remoteForwardPort: 23333 };
  const baseFp = deployTargetFingerprint(base);
  for (const f of DEPLOY_TARGET_FIELDS) {
    const changed = { ...base };
    let comparisonBase = baseFp;
    if (f === "host") changed.host = "pi2";
    else if (f === "port") changed.port = 2222;
    else if (f === "identityFile") changed.identityFile = "/k";
    else if (f === "remoteForwardPort") changed.remoteForwardPort = 23335;
    else if (f === "hostPrefix") changed.hostPrefix = "pi-prefix";
    else if (f === "chainStatusline") changed.chainStatusline = true;
    else if (f === "runtimeMode") {
      changed.runtimeMode = "profile-isolated";
      changed.runtimeKey = "runtime_changed";
    } else if (f === "runtimeKey") {
      changed.runtimeMode = "profile-isolated";
      changed.runtimeKey = "runtime_changed";
      comparisonBase = deployTargetFingerprint({
        ...base,
        runtimeMode: "profile-isolated",
        runtimeKey: "runtime_base",
      });
    } else if (f === "layoutVersion") {
      changed.layoutVersion = 2;
    }
    const drift = deployTargetDrift(comparisonBase, deployTargetFingerprint(changed));
    assert.equal(drift, f, `expected drift on ${f}`);
  }
});

test("deployTargetDrift returns null when fingerprints match across normalization quirks", () => {
  // Same target, different surface representation.
  const a = deployTargetFingerprint({
    host: "pi", port: 22, identityFile: "", hostPrefix: "",
    remoteForwardPort: 23333,
  });
  const b = deployTargetFingerprint({
    host: "pi", remoteForwardPort: 23333,
  });
  assert.equal(deployTargetDrift(a, b), null);
});

test("deployTargetFingerprint rejects nullish input", () => {
  assert.equal(deployTargetFingerprint(null), null);
  assert.equal(deployTargetFingerprint(undefined), null);
  assert.equal(deployTargetFingerprint("nope"), null);
});

// ── markDeployed: avoids deploy/edit lost-update race ──

test("settings-actions: remoteSsh.markDeployed stamps lastDeployedAt without touching other fields", () => {
  const cmd = commandRegistry["remoteSsh.markDeployed"];
  const original = basicProfile({ label: "Pi" });
  const r = cmd({ id: "p1", deployedAt: 12345 }, {
    snapshot: { remoteSsh: { installId: "a".repeat(64), profiles: [original] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.installId, "a".repeat(64));
  assert.equal(r.commit.remoteSsh.profiles[0].lastDeployedAt, 12345);
  // Other fields preserved.
  assert.equal(r.commit.remoteSsh.profiles[0].label, "Pi");
  assert.equal(r.commit.remoteSsh.profiles[0].host, "user@pi.local");
});

test("settings-actions: remoteSsh.markDeployed can persist detected remote Node metadata", () => {
  const cmd = commandRegistry["remoteSsh.markDeployed"];
  const r = cmd({
    id: "p1",
    deployedAt: 12345,
    remoteNode: {
      nodeBin: "/home/me/.nvm/versions/node/v22/bin/node",
      version: "v22.1.0",
      source: "shell:/bin/bash",
    },
  }, {
    snapshot: { remoteSsh: { profiles: [basicProfile()] } },
  });
  assert.equal(r.status, "ok");
  const profile = r.commit.remoteSsh.profiles[0];
  assert.equal(profile.lastDeployedAt, 12345);
  assert.equal(profile.detectedRemoteNodeBin, "/home/me/.nvm/versions/node/v22/bin/node");
  assert.equal(profile.detectedRemoteNodeVersion, "v22.1.0");
  assert.equal(profile.detectedRemoteNodeSource, "shell:/bin/bash");
  assert.equal(profile.detectedRemoteNodeAt, 12345);
});

test("settings-actions: remoteSsh.markDeployed survives concurrent edit (lost-update fix)", () => {
  // Caller captures pre-deploy snapshot at T=0 with label "Pi".
  // T=10s: user edits label to "树莓派" via remoteSsh.update — settings-controller commits.
  // T=30s: deploy IPC handler calls markDeployed with id only.
  // markDeployed reads CURRENT profile (label="树莓派"), not the stale snapshot.
  // Result: lastDeployedAt stamped, label edit survives.
  const cmd = commandRegistry["remoteSsh.markDeployed"];
  const editedProfile = basicProfile({ label: "树莓派" });  // post-edit state
  const r = cmd({ id: "p1", deployedAt: 12345 }, {
    snapshot: { remoteSsh: { profiles: [editedProfile] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.profiles[0].label, "树莓派",
    "label edit must survive — markDeployed must not write a stale snapshot");
  assert.equal(r.commit.remoteSsh.profiles[0].lastDeployedAt, 12345);
});

test("settings-actions: remoteSsh.markDeployed noop when profile deleted mid-deploy", () => {
  const cmd = commandRegistry["remoteSsh.markDeployed"];
  const r = cmd({ id: "p1", deployedAt: 12345 }, {
    snapshot: { remoteSsh: { profiles: [] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.noop, true);
  assert.equal(r.reason, "profile_deleted");
  assert.equal(r.commit, undefined);
});

test("settings-actions: remoteSsh.markDeployed noop when expectedTarget host drifted", () => {
  const cmd = commandRegistry["remoteSsh.markDeployed"];
  const editedProfile = basicProfile({ host: "newpi.local" });  // user changed host mid-deploy
  const r = cmd(
    {
      id: "p1",
      deployedAt: 12345,
      expectedTarget: {
        host: "user@pi.local",  // pre-edit target — what we deployed to
        port: undefined,
        identityFile: undefined,
        remoteForwardPort: 23333,
        hostPrefix: undefined,
      },
    },
    { snapshot: { remoteSsh: { installId: "a".repeat(64), profiles: [editedProfile] } } }
  );
  // Current-target stamp is still a no-op: deploy landed on old host, but the
  // ownership ledger must retain that old host so delete can clean it later.
  assert.equal(r.status, "ok");
  assert.equal(r.noop, true);
  assert.equal(r.reason, "target_drift");
  assert.equal(r.targetDrift, "host");
  assert.equal(r.commit.remoteSsh.installId, "a".repeat(64));
  assert.equal(r.commit.remoteSsh.profiles[0].lastDeployedAt, undefined);
  assert.equal(r.commit.remoteSsh.profiles[0].managedDeployTargets[0].host, "user@pi.local");
  assert.equal(editedProfile.lastDeployedAt, undefined,
    "profile must remain un-stamped when target drifted");
});

test("settings-actions: remoteSsh.markDeployed allows expectedTarget that fully matches", () => {
  const cmd = commandRegistry["remoteSsh.markDeployed"];
  const profile = basicProfile({ remoteForwardPort: 23335, host: "pi" });
  const r = cmd(
    {
      id: "p1",
      deployedAt: 99999,
      expectedTarget: {
        host: "pi",
        port: undefined,
        identityFile: undefined,
        remoteForwardPort: 23335,
        hostPrefix: undefined,
      },
    },
    { snapshot: { remoteSsh: { profiles: [profile] } } }
  );
  assert.equal(r.status, "ok");
  assert.equal(r.noop, undefined);
  assert.equal(r.commit.remoteSsh.profiles[0].lastDeployedAt, 99999);
});

test("settings-actions: remoteSsh.markDeployed validates inputs", () => {
  const cmd = commandRegistry["remoteSsh.markDeployed"];
  assert.equal(cmd(null, { snapshot: {} }).status, "error");
  assert.equal(cmd({ id: "" }, { snapshot: {} }).status, "error");
  assert.equal(cmd({ id: "p1" }, { snapshot: {} }).status, "error", "deployedAt required");
  assert.equal(cmd({ id: "p1", deployedAt: -1 }, { snapshot: {} }).status, "error");
  assert.equal(cmd({ id: "p1", deployedAt: NaN }, { snapshot: {} }).status, "error");
});

test("settings-actions: remoteSsh.markRemoteNode stamps detected node without touching other fields", () => {
  const cmd = commandRegistry["remoteSsh.markRemoteNode"];
  const original = basicProfile({ label: "Pi" });
  const r = cmd({
    id: "p1",
    nodeBin: "/usr/local/bin/node",
    version: "v20.10.0",
    source: "path",
    detectedAt: 555,
  }, {
    snapshot: { remoteSsh: { installId: "a".repeat(64), profiles: [original] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.installId, "a".repeat(64));
  const profile = r.commit.remoteSsh.profiles[0];
  assert.equal(profile.label, "Pi");
  assert.equal(profile.detectedRemoteNodeBin, "/usr/local/bin/node");
  assert.equal(profile.detectedRemoteNodeVersion, "v20.10.0");
  assert.equal(profile.detectedRemoteNodeSource, "path");
  assert.equal(profile.detectedRemoteNodeAt, 555);
});

test("settings-actions: remoteSsh.markRemoteNode noops when target drifted", () => {
  const cmd = commandRegistry["remoteSsh.markRemoteNode"];
  const r = cmd({
    id: "p1",
    nodeBin: "/usr/local/bin/node",
    detectedAt: 555,
    expectedTarget: {
      host: "old-host",
      remoteForwardPort: 23333,
    },
  }, {
    snapshot: { remoteSsh: { profiles: [basicProfile({ host: "new-host" })] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.noop, true);
  assert.equal(r.reason, "target_drift");
  assert.equal(r.commit, undefined);
});

// ── update: preserves lastDeployedAt on cosmetic edits ──

test("settings-actions: remoteSsh.update preserves lastDeployedAt when only cosmetic fields change", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const stamped = basicProfile({ label: "Pi", lastDeployedAt: 12345 });
  const cosmeticEdit = basicProfile({ label: "树莓派" });  // only label changed
  const r = cmd(cosmeticEdit, {
    snapshot: { remoteSsh: { profiles: [stamped] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.profiles[0].label, "树莓派");
  assert.equal(r.commit.remoteSsh.profiles[0].lastDeployedAt, 12345,
    "cosmetic edit must keep deploy stamp");
});

test("settings-actions: remoteSsh.update preserves isolated runtime identity and evidence when UI omits hidden fields", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const current = verifiedIsolatedProfile({
    label: "Isolated Pi",
    lastDeployedAt: 12345,
    detectedRemoteNodeBin: "/usr/local/bin/node",
    detectedRemoteNodeVersion: "v22.1.0",
  });
  const uiEdit = {
    id: current.id,
    label: "Renamed Pi",
    host: current.host,
    remoteForwardPort: current.remoteForwardPort,
    autoStartCodexMonitor: current.autoStartCodexMonitor,
    chainStatusline: current.chainStatusline,
    connectOnLaunch: current.connectOnLaunch,
    createdAt: current.createdAt,
  };
  const r = cmd(uiEdit, {
    snapshot: { remoteSsh: { profiles: [current] } },
  });
  const updated = r.commit.remoteSsh.profiles[0];

  assert.equal(r.status, "ok");
  assert.equal(updated.runtimeMode, "profile-isolated");
  assert.equal(updated.runtimeKey, current.runtimeKey);
  assert.equal(updated.layoutVersion, current.layoutVersion);
  assert.equal(updated.isolatedActive, true);
  assert.deepEqual(updated.isolatedRuntime, current.isolatedRuntime);
  assert.equal(updated.lastDeployedAt, 12345);
  assert.equal(updated.detectedRemoteNodeBin, "/usr/local/bin/node");
  assert.equal(updated.label, "Renamed Pi");
});

test("settings-actions: remoteSsh.update ignores forged runtime identity in both directions", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const isolated = verifiedIsolatedProfile({ lastDeployedAt: 12345 });
  const forgedDisable = basicProfile({
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: REMOTE_LAYOUT_VERSION,
  });
  const keptIsolated = cmd(forgedDisable, {
    snapshot: { remoteSsh: { profiles: [isolated] } },
  }).commit.remoteSsh.profiles[0];
  assert.equal(keptIsolated.runtimeMode, "profile-isolated");
  assert.equal(keptIsolated.runtimeKey, isolated.runtimeKey);
  assert.equal(keptIsolated.lastDeployedAt, 12345);

  const accountDefault = sanitizeProfile(basicProfile({ lastDeployedAt: 67890 }));
  const forgedEnable = basicProfile({
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_attacker",
    layoutVersion: REMOTE_LAYOUT_VERSION,
  });
  const keptDefault = cmd(forgedEnable, {
    snapshot: { remoteSsh: { profiles: [accountDefault] } },
  }).commit.remoteSsh.profiles[0];
  assert.equal(keptDefault.runtimeMode, "account-default");
  assert.equal(keptDefault.runtimeKey, "account-default");
  assert.equal(keptDefault.lastDeployedAt, 67890);
});

test("settings-actions: remoteSsh.update ignores renderer-supplied deployment ownership", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const owned = {
    host: "user@pi.local",
    remoteForwardPort: 23333,
    deployedAt: 12345,
  };
  const current = basicProfile({
    lastDeployedAt: 12345,
    managedDeployTargets: [owned],
  });
  const forgedEdit = basicProfile({
    label: "树莓派",
    lastDeployedAt: 99999,
    managedDeployTargets: [{
      host: "user@victim",
      remoteForwardPort: 23333,
      deployedAt: 99999,
    }],
  });
  const r = cmd(forgedEdit, {
    snapshot: { remoteSsh: { profiles: [current] } },
  });
  const profile = r.commit.remoteSsh.profiles[0];
  assert.equal(profile.lastDeployedAt, 12345);
  assert.deepEqual(profile.managedDeployTargets, [{ ...owned, chainStatusline: false }]);

  const fresh = cmd(forgedEdit, {
    snapshot: { remoteSsh: { profiles: [basicProfile()] } },
  }).commit.remoteSsh.profiles[0];
  assert.equal(fresh.lastDeployedAt, undefined);
  assert.equal(fresh.managedDeployTargets, undefined);
});

test("settings-actions: remoteSsh.update preserves detected remote Node on cosmetic edits", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const stamped = basicProfile({
    label: "Pi",
    detectedRemoteNodeBin: "/home/me/.nvm/versions/node/v22/bin/node",
    detectedRemoteNodeVersion: "v22.1.0",
    detectedRemoteNodeSource: "shell:/bin/bash",
    detectedRemoteNodeAt: 12345,
  });
  const cosmeticEdit = basicProfile({ label: "树莓派" });
  const r = cmd(cosmeticEdit, {
    snapshot: { remoteSsh: { profiles: [stamped] } },
  });
  const profile = r.commit.remoteSsh.profiles[0];
  assert.equal(profile.label, "树莓派");
  assert.equal(profile.detectedRemoteNodeBin, "/home/me/.nvm/versions/node/v22/bin/node");
  assert.equal(profile.detectedRemoteNodeVersion, "v22.1.0");
  assert.equal(profile.detectedRemoteNodeSource, "shell:/bin/bash");
  assert.equal(profile.detectedRemoteNodeAt, 12345);
});

test("settings-actions: remoteSsh.update CLEARS lastDeployedAt when host changes (target drift)", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const stamped = basicProfile({ host: "pi", lastDeployedAt: 12345 });
  const targetEdit = basicProfile({ host: "newpi" });  // host changed
  const r = cmd(targetEdit, {
    snapshot: { remoteSsh: { profiles: [stamped] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.profiles[0].host, "newpi");
  assert.equal(r.commit.remoteSsh.profiles[0].lastDeployedAt, undefined,
    "host change must clear deploy stamp (UI re-warns 'never deployed')");
});

test("settings-actions: active serialized transport blocks target and transport-mode edits", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const current = basicProfile({ host: "pi", sshTransportMode: "auto" });
  const deps = {
    snapshot: { remoteSsh: { profiles: [current] } },
    isRemoteSshTransportBusy: () => true,
  };
  const hostEdit = cmd(basicProfile({ host: "newpi", sshTransportMode: "auto" }), deps);
  assert.equal(hostEdit.status, "error");
  assert.equal(hostEdit.reason, "serialized_transport_busy");
  const modeEdit = cmd(basicProfile({ host: "pi", sshTransportMode: "serialized" }), deps);
  assert.equal(modeEdit.status, "error");
  assert.equal(modeEdit.reason, "serialized_transport_busy");
  const labelEdit = cmd(basicProfile({ host: "pi", label: "Cosmetic", sshTransportMode: "auto" }), deps);
  assert.equal(labelEdit.status, "ok");
});

test("settings-actions: remoteSsh.update clears detected remote Node when host changes", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const stamped = basicProfile({
    host: "pi",
    detectedRemoteNodeBin: "/usr/local/bin/node",
    detectedRemoteNodeVersion: "v20.10.0",
  });
  const targetEdit = basicProfile({ host: "newpi" });
  const r = cmd(targetEdit, {
    snapshot: { remoteSsh: { profiles: [stamped] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.profiles[0].detectedRemoteNodeBin, undefined);
});

test("settings-actions: remoteSsh.update clears lastDeployedAt on remoteForwardPort change", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const stamped = basicProfile({ remoteForwardPort: 23333, lastDeployedAt: 12345 });
  const portEdit = basicProfile({ remoteForwardPort: 23335 });
  const r = cmd(portEdit, {
    snapshot: { remoteSsh: { profiles: [stamped] } },
  });
  assert.equal(r.commit.remoteSsh.profiles[0].lastDeployedAt, undefined);
});

test("settings-actions: A to B to A port edits never revive historical deployment readiness", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const deployedA = basicProfile({
    remoteForwardPort: 23333,
    lastDeployedAt: 12345,
    remoteHome: "/home/user",
    routingNonce: "a".repeat(32),
    managedDeployTargets: [{
      host: "user@pi.local",
      remoteForwardPort: 23333,
      deployedAt: 12345,
    }],
  });
  const movedToB = cmd(basicProfile({ remoteForwardPort: 23334 }), {
    snapshot: { remoteSsh: { profiles: [deployedA] } },
  }).commit.remoteSsh.profiles[0];
  assert.equal(movedToB.lastDeployedAt, undefined);
  assert.equal(movedToB.remoteHome, undefined);
  assert.equal(movedToB.managedDeployTargets.length, 1);

  const movedBackToA = cmd(basicProfile({ remoteForwardPort: 23333 }), {
    snapshot: { remoteSsh: { profiles: [movedToB] } },
  }).commit.remoteSsh.profiles[0];
  assert.equal(movedBackToA.lastDeployedAt, undefined);
  assert.equal(movedBackToA.remoteHome, undefined);
  assert.equal(movedBackToA.managedDeployTargets.length, 1,
    "historical ownership remains cleanup-only and must not restore active deployment evidence");
});

test("settings-actions: remoteSsh.update preserves lastDeployedAt when prev had port:22 and edit omits port (UI default-omit case)", () => {
  // Real bug from codex review #9: prev.port = 22, payload omits port (UI
  // saveBtn skips port when value === 22). Naive prev[f] === profile[f] would
  // see 22 vs undefined and false-flag drift, clearing lastDeployedAt on a
  // pure label edit.
  const cmd = commandRegistry["remoteSsh.update"];
  const stamped = basicProfile({ port: 22, label: "Pi", lastDeployedAt: 12345 });
  const cosmeticEditNoPort = basicProfile({ label: "树莓派" });  // port omitted entirely
  delete cosmeticEditNoPort.port;
  const r = cmd(cosmeticEditNoPort, {
    snapshot: { remoteSsh: { profiles: [stamped] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.profiles[0].lastDeployedAt, 12345,
    "port 22 ≡ port undefined must not trip target drift");
});

test("settings-actions: remoteSsh.markDeployed treats expectedTarget.port=22 same as missing", () => {
  const cmd = commandRegistry["remoteSsh.markDeployed"];
  const profile = basicProfile({ host: "pi", remoteForwardPort: 23333 });
  // Caller captured expectedTarget with explicit port:22; current profile has no port.
  const r = cmd(
    {
      id: "p1",
      deployedAt: 99999,
      expectedTarget: {
        host: "pi",
        port: 22,
        remoteForwardPort: 23333,
      },
    },
    { snapshot: { remoteSsh: { profiles: [profile] } } }
  );
  assert.equal(r.status, "ok");
  assert.equal(r.noop, undefined,
    "port-22 vs undefined must not be considered drift");
  assert.equal(r.commit.remoteSsh.profiles[0].lastDeployedAt, 99999);
});

test("settings-actions: remoteSsh.update preserves lastDeployedAt when toggling autoStartCodexMonitor", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const stamped = basicProfile({ autoStartCodexMonitor: false, lastDeployedAt: 12345 });
  const toggle = basicProfile({ autoStartCodexMonitor: true });
  const r = cmd(toggle, {
    snapshot: { remoteSsh: { profiles: [stamped] } },
  });
  assert.equal(r.commit.remoteSsh.profiles[0].lastDeployedAt, 12345,
    "agent toggle is not a deploy target change");
});

test("settings-actions: remoteSsh.update overwrites existing profile + preserves createdAt", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const original = basicProfile({ createdAt: 12345 });
  const r = cmd(
    basicProfile({ host: "newhost" }),
    { snapshot: { remoteSsh: { profiles: [original] } } }
  );
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.profiles[0].host, "newhost");
  // createdAt preserved (caller didn't pass a new one).
  assert.equal(r.commit.remoteSsh.profiles[0].createdAt, 12345);
});

test("settings-actions: remoteSsh.update fails on unknown id", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const r = cmd(basicProfile({ id: "ghost" }), {
    snapshot: { remoteSsh: { profiles: [] } },
  });
  assert.equal(r.status, "error");
  assert.match(r.message, /not found/);
});

test("settings-actions: remoteSsh.delete removes profile", () => {
  const cmd = commandRegistry["remoteSsh.delete"];
  const r = cmd("p1", {
    snapshot: { remoteSsh: { profiles: [basicProfile()] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.profiles.length, 0);
});

test("settings-actions: remoteSsh.delete is noop on unknown id (no error)", () => {
  const cmd = commandRegistry["remoteSsh.delete"];
  const r = cmd("ghost", {
    snapshot: { remoteSsh: { profiles: [basicProfile()] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.noop, true);
  assert.equal(r.commit, undefined);
});

test("settings-actions: remoteSsh.delete rejects empty / non-string id", () => {
  const cmd = commandRegistry["remoteSsh.delete"];
  assert.equal(cmd("", { snapshot: {} }).status, "error");
  assert.equal(cmd(null, { snapshot: {} }).status, "error");
  assert.equal(cmd({}, { snapshot: {} }).status, "error");
});

test("settings-actions: remoteSsh.delete rejects an active identity transaction", () => {
  const cmd = commandRegistry["remoteSsh.delete"];
  const r = cmd("p1", {
    snapshot: {
      remoteSsh: {
        profiles: [basicProfile({
          identityTxn: {
            runtimeKey: "account-default",
            layoutVersion: 1,
            phase: "rotating",
            fromNonce: null,
            toNonce: "b".repeat(32),
            startedAt: 1,
            previousExpiresAt: 100,
            steps: {},
          },
        })],
      },
    },
  });
  assert.equal(r.status, "error");
  assert.match(r.message, /identity transaction/i);
});

// ── prefs.js: schema integration ──

test("prefs.getDefaults includes remoteSsh.profiles=[]", () => {
  const { getDefaults: prefsDefaults } = require("../src/prefs");
  const d = prefsDefaults();
  assert.ok(d.remoteSsh, "remoteSsh field must be in defaults");
  assert.ok(Array.isArray(d.remoteSsh.profiles));
  assert.equal(d.remoteSsh.profiles.length, 0);
});

test("prefs.validate normalizes invalid remoteSsh into defaults", () => {
  const { validate } = require("../src/prefs");
  const out = validate({ remoteSsh: { profiles: "no" } });
  // schema validate runs normalize first → drops bad profiles → empty list.
  assert.deepEqual(out.remoteSsh, { profiles: [] });
});

test("prefs.validate keeps valid remoteSsh profiles", () => {
  const { validate } = require("../src/prefs");
  const profile = basicProfile();
  const out = validate({ remoteSsh: { profiles: [profile] } });
  assert.equal(out.remoteSsh.profiles.length, 1);
  assert.equal(out.remoteSsh.profiles[0].id, "p1");
});

test("real controller: remoteSsh.forceRevoke all persists a schema-valid C transaction", async () => {
  const { createSettingsController } = require("../src/settings-controller");
  const prefs = require("../src/prefs");
  const ctrl = createSettingsController({
    loadResult: {
      snapshot: {
        ...prefs.getDefaults(),
        remoteSsh: { profiles: [revocableProfile()] },
      },
      locked: false,
    },
  });

  const result = await ctrl.applyCommand("remoteSsh.forceRevoke", {
    id: "p1",
    mode: "all",
    confirmed: true,
  });
  const updated = ctrl.getSnapshot().remoteSsh.profiles[0];

  assert.equal(result.status, "ok");
  assert.equal(validateProfile(updated).status, "ok");
  assert.ok(updated.identityTxn.previousExpiresAt > updated.identityTxn.startedAt);
  assert.equal(updated.routingNonce, undefined);
  assert.equal(updated.previousNonce, undefined);
});

// ── Integration: real controller serializes remoteSsh.* commands ──
//
// These tests run against the actual settings-controller (not just the
// command registry as pure functions) to verify the .lockKey wiring
// actually causes serialization at runtime. Without lockKey, update +
// markDeployed can race and the later-committing one would stomp.

test("real controller: update + markDeployed serialize via shared lockKey", async () => {
  const { createSettingsController } = require("../src/settings-controller");
  const path = require("path");
  const fs = require("fs");
  const os = require("os");
  const tmp = path.join(os.tmpdir(), `clawd-prefs-race-${Date.now()}.json`);
  try {
    const startProfile = basicProfile({ label: "Pi" });
    const ctrl = createSettingsController({
      prefsPath: tmp,
      loadResult: {
        snapshot: {
          ...require("../src/prefs").getDefaults(),
          remoteSsh: { profiles: [startProfile] },
        },
        locked: false,
      },
    });
    // T=0: kick off slow update (label change). Use a slow validator path
    // by chaining an applyCommand that we make wait via setTimeout — but
    // simpler: fire two commands back to back; lockKey serialization means
    // the second sees the committed result of the first.
    const updatePromise = ctrl.applyCommand("remoteSsh.update", basicProfile({ label: "树莓派" }));
    const stampPromise = ctrl.applyCommand("remoteSsh.markDeployed", {
      id: "p1",
      deployedAt: 99999,
    });
    const [updateRes, stampRes] = await Promise.all([updatePromise, stampPromise]);
    assert.equal(updateRes.status, "ok");
    assert.equal(stampRes.status, "ok");
    const finalProfiles = ctrl.getSnapshot().remoteSsh.profiles;
    assert.equal(finalProfiles[0].label, "树莓派",
      "update's label edit must survive — lockKey serialization makes markDeployed read post-update snapshot");
    assert.equal(finalProfiles[0].lastDeployedAt, 99999,
      "markDeployed must apply (since target didn't drift)");
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test("real controller: delete + markDeployed serialize (no resurrected profile)", async () => {
  const { createSettingsController } = require("../src/settings-controller");
  const path = require("path");
  const fs = require("fs");
  const os = require("os");
  const tmp = path.join(os.tmpdir(), `clawd-prefs-race-del-${Date.now()}.json`);
  try {
    const startProfile = basicProfile();
    const ctrl = createSettingsController({
      prefsPath: tmp,
      loadResult: {
        snapshot: {
          ...require("../src/prefs").getDefaults(),
          remoteSsh: { profiles: [startProfile] },
        },
        locked: false,
      },
    });
    // delete + concurrent markDeployed: without lockKey, markDeployed could
    // read pre-delete snapshot, recompute newProfiles still containing p1,
    // and commit — resurrecting the deleted profile.
    const delPromise = ctrl.applyCommand("remoteSsh.delete", "p1");
    const stampPromise = ctrl.applyCommand("remoteSsh.markDeployed", {
      id: "p1",
      deployedAt: 12345,
    });
    const [delRes, stampRes] = await Promise.all([delPromise, stampPromise]);
    assert.equal(delRes.status, "ok");
    assert.equal(stampRes.status, "ok");
    // Stamp must have run AFTER delete (serialized) — sees no profile, no-ops.
    assert.equal(stampRes.noop, true);
    assert.equal(stampRes.reason, "profile_deleted");
    const finalProfiles = ctrl.getSnapshot().remoteSsh.profiles;
    assert.equal(finalProfiles.length, 0,
      "delete must win — no resurrected profile");
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});
