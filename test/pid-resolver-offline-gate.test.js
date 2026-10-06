// test/pid-resolver-offline-gate.test.js — #681 Slice A1.
//
// The contract under test: when Clawd is not running, a leftover CLI hook must
// not snapshot the machine's process list. Before this, resolve() spawned a
// PowerShell that read ProcessId/ParentProcessId/Name/CommandLine for EVERY
// process, and only afterwards discovered nobody was listening — so a user who
// had quit Clawd hours ago still paid a hidden PowerShell per hook event, which
// is what their security software flagged (#681).
//
// Two separate guarantees, tested separately:
//   1. GATE      — Clawd offline ⇒ zero spawn, and structurally so (the gate
//                  runs before child_process is even required).
//   2. NO-DEGRADE — the snapshot ran but produced nothing ⇒ report nothing,
//                  rather than the ephemeral hook wrapper's process.ppid.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSharedProcessWithMock } = require("./helpers/load-shared-process-with-mock");

const AGENT_OPTS = {
  agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
  agentCmdlineCheck: (c) => c.includes("claude-code"),
};

const LIVE_IDENTITY = { ok: true, reason: null, port: 23333, ownerPid: process.pid };

function snapshotJson(procs) {
  return JSON.stringify(procs.map((p) => ({
    ProcessId: p.pid, Name: p.name, ParentProcessId: p.ppid,
    CommandLine: typeof p.cmd === "string" ? p.cmd : null,
  })));
}
const LIVE_TREE = () => snapshotJson([
  { pid: 500, name: "node.exe", ppid: 600, cmd: "node C:/x/claude-code/cli.js" },
  { pid: 600, name: "windowsterminal.exe", ppid: 0 },
]);

// Builds a resolver over a mock-loaded shared-process and counts every
// execFileSync. `identity` is what the injected gate reads; `env` drives
// CLAWD_REMOTE. Nothing here reads the real ~/.clawd/runtime.json.
function mk({ platform = "win32", identity = LIVE_IDENTITY, env = {}, snapshot, startPid = 500, alive } = {}) {
  let spawns = 0;
  let identityReads = 0;
  const execFileSyncMock = (...args) => {
    spawns++;
    if (typeof snapshot === "function") return snapshot(...args);
    return snapshot !== undefined ? snapshot : LIVE_TREE();
  };
  const { mod, cleanup } = loadSharedProcessWithMock({ execFileSyncMock, platform, env });
  const resolve = mod.createPidResolver({
    ...AGENT_OPTS,
    platformConfig: mod.getPlatformConfig(),
    startPid,
    readRuntimeIdentity: () => { identityReads++; return identity; },
    env,
    ...(alive ? { } : {}),
  });
  return { mod, resolve, cleanup, spawns: () => spawns, identityReads: () => identityReads };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The gate: Clawd offline ⇒ zero spawn
// ═══════════════════════════════════════════════════════════════════════════

describe("#681 offline gate — Windows resolver refuses to spawn when Clawd is gone", () => {
  // Each row is a distinct way "Clawd is not usefully running" presents on disk.
  const OFFLINE_IDENTITIES = [
    ["runtime.json missing (the normal case — Quit deletes it)",
      { ok: false, reason: "runtime-missing", port: null, ownerPid: null }],
    ["app mismatch (some other tool's file at that path)",
      { ok: false, reason: "runtime-app-mismatch", port: null, ownerPid: null }],
    ["port outside the bindable range",
      { ok: false, reason: "runtime-port-invalid", port: null, ownerPid: null }],
    ["no ownerPid (a pre-#681 Clawd wrote it) — fail closed, do not guess",
      { ok: false, reason: "runtime-owner-invalid", port: 23333, ownerPid: null }],
  ];

  for (const [label, identity] of OFFLINE_IDENTITIES) {
    it(`zero spawn + unavailable shape: ${label}`, () => {
      const h = mk({ identity });
      try {
        const r = h.resolve();
        assert.strictEqual(h.spawns(), 0, "MUST NOT spawn PowerShell — this is the whole point of #681");
        assert.strictEqual(h.identityReads(), 1, "the gate reads the identity exactly once");
        assert.strictEqual(r.attempted, false, "we never tried");
        assert.strictEqual(r.skipReason, "clawd-offline");
        assert.strictEqual(r.snapshotOk, false);
        assert.strictEqual(r.stablePid, null);
        assert.strictEqual(r.terminalPid, null);
        assert.strictEqual(r.agentPid, null);
        assert.strictEqual(r.agentCommandLine, "");
        assert.strictEqual(r.detectedEditor, null);
        assert.deepStrictEqual(r.pidChain, []);
        assert.strictEqual(r.foregroundWtHwnd, null);
        assert.strictEqual(r.tmuxSocket, null);
        assert.strictEqual(r.tmuxClient, null);
      } finally { h.cleanup(); }
    });
  }

  it("zero spawn when the runtime file is stale: owner PID is dead (crash, not Quit)", () => {
    // A crash leaves runtime.json behind. File existence alone would say
    // "online" — the ownerPid liveness check is what catches this.
    const deadPid = 2147483646;
    const h = mk({ identity: { ok: true, reason: null, port: 23333, ownerPid: deadPid } });
    try {
      const r = h.resolve();
      assert.strictEqual(h.spawns(), 0, "a dead owner must not spawn — file presence is not liveness");
      assert.strictEqual(r.skipReason, "clawd-offline");
      assert.strictEqual(r.attempted, false);
      assert.strictEqual(r.stablePid, null);
    } finally { h.cleanup(); }
  });

  it("CLAWD_REMOTE never resolves the local tree, even when the local runtime is perfectly live", () => {
    // A remote hook's parents are on the REMOTE box. Resolving the local tree
    // would attribute this machine's terminal to a session that isn't here.
    const h = mk({ identity: LIVE_IDENTITY, env: { CLAWD_REMOTE: "1" } });
    try {
      const r = h.resolve();
      assert.strictEqual(h.spawns(), 0);
      assert.strictEqual(r.skipReason, "clawd-remote", "distinct from clawd-offline: Clawd IS running, just not for us");
      assert.strictEqual(r.attempted, false);
      assert.strictEqual(r.stablePid, null);
      assert.deepStrictEqual(r.pidChain, []);
    } finally { h.cleanup(); }
  });

  it("CLAWD_REMOTE=0 / false are not remote (matches isRemoteHookMode)", () => {
    for (const value of ["0", "false", "FALSE"]) {
      const h = mk({ env: { CLAWD_REMOTE: value } });
      try {
        const r = h.resolve();
        assert.strictEqual(h.spawns(), 1, `CLAWD_REMOTE=${value} must NOT suppress the local walk`);
        assert.strictEqual(r.stablePid, 600);
      } finally { h.cleanup(); }
    }
  });

  it("the gate short-circuits: a failing gate never reads the identity twice, and memoizes", () => {
    const h = mk({ identity: { ok: false, reason: "runtime-missing", port: null, ownerPid: null } });
    try {
      const r1 = h.resolve();
      const r2 = h.resolve();
      assert.strictEqual(r1, r2, "the unavailable result is memoized like any other");
      assert.strictEqual(h.spawns(), 0);
      assert.strictEqual(h.identityReads(), 1, "one hook process asks once");
    } finally { h.cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Online success is untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("#681 gate — a live Clawd leaves the online success path exactly as it was", () => {
  it("live runtime + live owner ⇒ the walk runs and every field survives", () => {
    const h = mk({ identity: LIVE_IDENTITY });
    try {
      const r = h.resolve();
      assert.strictEqual(h.spawns(), 1, "exactly one snapshot, as before");
      assert.strictEqual(r.snapshotOk, true);
      assert.strictEqual(r.stablePid, 600);
      assert.strictEqual(r.terminalPid, 600);
      assert.strictEqual(r.agentPid, 500);
      assert.strictEqual(r.agentCommandLine, "node C:/x/claude-code/cli.js");
      assert.deepStrictEqual(r.pidChain, [500, 600]);
    } finally { h.cleanup(); }
  });

  it("the online success shape stays the pre-#681 10 fields — no attempted/skipReason leak", () => {
    // The 12 unmigrated adapters destructure this object. Growing it on the
    // SUCCESS path is what the #674 no-arg red line forbids; #681 only adds
    // fields to the unavailable shape.
    const h = mk({ identity: LIVE_IDENTITY });
    try {
      assert.deepStrictEqual(Object.keys(h.resolve()).sort(), [
        "agentCommandLine", "agentPid", "detectedEditor", "foregroundWtHwnd", "pidChain",
        "snapshotOk", "stablePid", "terminalPid", "tmuxClient", "tmuxSocket",
      ]);
    } finally { h.cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. No degraded PID when the snapshot itself fails
// ═══════════════════════════════════════════════════════════════════════════

describe("#681 no-degraded — an attempted-but-failed snapshot reports nothing, not process.ppid", () => {
  const FAILURES = [
    ["empty stdout", () => ""],
    ["whitespace-only stdout", () => "   \n  "],
    ["unparseable stdout", () => "Get-CimInstance : Access denied"],
    ["execFileSync throws (spawn blocked)", () => { throw new Error("EPERM: spawn blocked"); }],
    ["execFileSync times out", () => { throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }); }],
    ["valid JSON, but an empty process list", () => "[]"],
  ];

  for (const [label, snapshot] of FAILURES) {
    it(`${label} ⇒ null pids, pidChain [], attempted true`, () => {
      const h = mk({ identity: LIVE_IDENTITY, snapshot, startPid: 4242 });
      try {
        const r = h.resolve();
        assert.strictEqual(h.spawns(), 1, "we DID try — the gate let us through");
        assert.strictEqual(r.attempted, true, "distinguishes 'tried and failed' from 'never tried'");
        assert.strictEqual(r.skipReason, "snapshot-failed");
        assert.strictEqual(r.snapshotOk, false);
        assert.strictEqual(r.stablePid, null, "must NOT be startPid — that is the per-event hook wrapper");
        assert.notStrictEqual(r.stablePid, 4242);
        assert.notStrictEqual(r.stablePid, process.ppid);
        assert.strictEqual(r.terminalPid, null);
        assert.strictEqual(r.agentPid, null);
        assert.deepStrictEqual(r.pidChain, []);
        assert.strictEqual(r.foregroundWtHwnd, null);
      } finally { h.cleanup(); }
    });
  }

  // The sharper half of the no-degrade contract, and the one an "is the snapshot
  // empty?" check misses entirely: the snapshot is perfectly healthy, it just
  // does not contain US. snapshotOk is true, the walk still reads nothing, and
  // `terminalPid || lastGoodPid` hands back the untouched startPid.
  //
  // Shipping that is worse than shipping nothing. src/state.js merges
  // `sourcePid || existing.sourcePid`, so a truthy-but-wrong pid OVERWRITES the
  // correct one the server already learned — see
  // test/state-source-pid-merge.test.js, which proves a null is absorbed and a
  // real pid wins.
  it("snapshot is FULL but lacks startPid ⇒ unavailable, not the unverified startPid", () => {
    const h = mk({
      identity: LIVE_IDENTITY,
      startPid: 424242, // never appears in the snapshot below
      snapshot: () => snapshotJson([
        { pid: 1000, name: "explorer.exe", ppid: 0 },
        { pid: 1001, name: "chrome.exe", ppid: 1000 },
        { pid: 1002, name: "windowsterminal.exe", ppid: 1000 },
      ]),
    });
    try {
      const r = h.resolve();
      assert.strictEqual(h.spawns(), 1, "the snapshot ran and succeeded — this is not the empty case");
      assert.strictEqual(r.stablePid, null, "must NOT echo back the unverified startPid");
      assert.notStrictEqual(r.stablePid, 424242);
      assert.strictEqual(r.attempted, true);
      assert.strictEqual(r.skipReason, "snapshot-self-not-found",
        "distinct from snapshot-failed: the snapshot worked, our process just was not in it");
      assert.strictEqual(r.snapshotOk, false, "no usable data, whatever the raw row count was");
      assert.strictEqual(r.agentPid, null);
      assert.deepStrictEqual(r.pidChain, []);
      assert.strictEqual(r.foregroundWtHwnd, null,
        "with no located process there is no session to attach a foreground window to");
    } finally { h.cleanup(); }
  });

  it("a foreground WT handle in an otherwise-unusable snapshot is dropped, not guessed onto a session", () => {
    // A non-empty snapshot CAN produce a real foregroundWtHwnd even when our own
    // process is absent — the empty-snapshot case never could. Attaching it to a
    // session we failed to identify would mis-attribute whatever window happens
    // to be in front of the user.
    const h = mk({
      identity: LIVE_IDENTITY,
      startPid: 424242,
      snapshot: () => JSON.stringify({
        processes: [{ ProcessId: 1002, Name: "windowsterminal.exe", ParentProcessId: 0, CommandLine: null }],
        foreground: { hwnd: "987654", pid: 1002, className: "CASCADIA_HOSTING_WINDOW_CLASS" },
      }),
    });
    try {
      const r = h.resolve();
      assert.strictEqual(r.foregroundWtHwnd, null, "a real handle, deliberately discarded");
      assert.strictEqual(r.stablePid, null);
      assert.strictEqual(r.skipReason, "snapshot-self-not-found");
    } finally { h.cleanup(); }
  });

  it("finding only ourselves is enough to report — one verified row is not a guess", () => {
    // The boundary of the rule above: pidChain.length > 0 means the walk really
    // read a row. Even a chain of exactly one is verified information, not the
    // untouched startPid default, so it must NOT be swallowed.
    const h = mk({
      identity: LIVE_IDENTITY,
      startPid: 500,
      snapshot: () => snapshotJson([{ pid: 500, name: "node.exe", ppid: 0, cmd: "node C:/x/claude-code/cli.js" }]),
    });
    try {
      const r = h.resolve();
      assert.strictEqual(r.stablePid, 500, "verified in the snapshot — reportable");
      assert.deepStrictEqual(r.pidChain, [500]);
      assert.strictEqual(r.snapshotOk, true);
      assert.strictEqual(r.skipReason, undefined, "success keeps the pre-#681 10-field shape");
    } finally { h.cleanup(); }
  });

  it("a walk that finds the tree but no terminal still reports the real ancestor (not a regression)", () => {
    // Guard against over-reach: no-degrade must only fire when the snapshot is
    // EMPTY. A snapshot that resolves real ancestors but never hits a terminal
    // name still legitimately falls back to lastGoodPid.
    const h = mk({
      identity: LIVE_IDENTITY,
      startPid: 500,
      snapshot: () => snapshotJson([
        { pid: 500, name: "node.exe", ppid: 600, cmd: "node C:/x/claude-code/cli.js" },
        { pid: 600, name: "mystery-host.exe", ppid: 0 },
      ]),
    });
    try {
      const r = h.resolve();
      assert.strictEqual(r.snapshotOk, true, "the snapshot worked — it just had no terminal in it");
      assert.strictEqual(r.terminalPid, null);
      assert.strictEqual(r.stablePid, 600, "lastGoodPid is a REAL walked ancestor here, not startPid");
      assert.strictEqual(r.agentPid, 500);
    } finally { h.cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. POSIX is untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("#681 — POSIX never consults the runtime gate", () => {
  for (const platform of ["darwin", "linux"]) {
    it(`${platform}: resolves via ps with the runtime file missing and CLAWD_REMOTE unset`, () => {
      let identityReads = 0;
      const { mod, cleanup } = loadSharedProcessWithMock({
        execFileSyncMock: (cmd, args) => {
          const key = `${cmd} ${args.join(" ")}`;
          if (key === "ps -o ppid= -p 500") return "600\n";
          if (key === "ps -o comm= -p 500") return "/usr/bin/node\n";
          if (key === "ps -o ppid= -p 600") return "1\n";
          if (key === "ps -o comm= -p 600") return "/Applications/iTerm2\n";
          throw Object.assign(new Error("ENOENT " + key), { code: "ENOENT" });
        },
        platform,
        env: { TMUX: undefined, TMUX_PANE: undefined },
      });
      try {
        const resolve = mod.createPidResolver({
          ...AGENT_OPTS,
          platformConfig: mod.getPlatformConfig(),
          startPid: 500,
          // Deliberately hostile: if POSIX ever consulted the gate, this
          // "offline" identity would blank the walk and the assertions below
          // would fail loudly rather than silently.
          readRuntimeIdentity: () => {
            identityReads++;
            return { ok: false, reason: "runtime-missing", port: null, ownerPid: null };
          },
          env: {},
        });
        const r = resolve();
        assert.strictEqual(identityReads, 0, "POSIX must not read runtime identity at all");
        assert.strictEqual(r.snapshotOk, true, "no snapshot step on POSIX — trivially true");
        assert.strictEqual(r.stablePid, 600);
        assert.deepStrictEqual(r.pidChain, [500, 600]);
        assert.strictEqual(r.attempted, undefined, "POSIX success keeps the pre-#681 shape");
        assert.strictEqual(r.skipReason, undefined);
      } finally { cleanup(); }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. processAlive semantics the gate leans on
// ═══════════════════════════════════════════════════════════════════════════

describe("#681 — processAlive is the gate's liveness primitive (and only that)", () => {
  const { processAlive } = require("../hooks/shared-process");

  it("ESRCH ⇒ false (no such process)", () => {
    assert.strictEqual(processAlive(2147483646), false);
  });

  it("EPERM ⇒ true — the PID EXISTS, which is all we may conclude", () => {
    // EPERM means "you may not signal it", not "it isn't there". Treating it as
    // dead would gate off a Clawd running as another user in the same session.
    // Treating it as ALIVE is deliberately permissive, and is NOT an ownership
    // proof: it does not show the PID is still Clawd (plan §14.1).
    const origKill = process.kill;
    try {
      process.kill = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
      assert.strictEqual(processAlive(1234), true);
    } finally { process.kill = origKill; }
  });

  it("true for this very process; false for junk input", () => {
    assert.strictEqual(processAlive(process.pid), true);
    for (const junk of [0, -1, null, undefined, NaN, "abc", {}]) {
      assert.strictEqual(processAlive(junk), false, `${JSON.stringify(junk)} must not read as alive`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The ordering the gate depends on — asserted against the source
// ═══════════════════════════════════════════════════════════════════════════

describe("#681 — the gate structurally precedes child_process", () => {
  // No runtime mock can observe this: by the time a test runs, child_process is
  // long since loaded into the require cache, so "zero execFileSync calls"
  // cannot distinguish "gated before the require" from "gated after it". The
  // requirement is about the SOURCE, so assert on the source. This is what stops
  // a later edit from drifting the execFileSync call back above the gate.
  // Comments in this region legitimately mention require("child_process"), so
  // match the actual binding statement rather than the bare string.
  const CP_REQUIRE = /^\s*const\s*\{\s*execFileSync\s*\}\s*=\s*require\("child_process"\);/m;

  it("computeFreshSnapshot checks the gate before it requires child_process", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "hooks", "shared-process.js"), "utf8");
    const fnStart = src.indexOf("function computeFreshSnapshot()");
    assert.ok(fnStart > 0, "computeFreshSnapshot must exist");
    const body = src.slice(fnStart);

    const gateAt = body.indexOf("windowsSkipReason()");
    const requireMatch = body.match(CP_REQUIRE);
    assert.ok(gateAt > 0, "the gate must be called inside computeFreshSnapshot");
    assert.ok(requireMatch, "child_process must still be required lazily inside the function");
    assert.ok(gateAt < requireMatch.index,
      "the runtime gate MUST come before require(\"child_process\") — otherwise a clean offline "
      + "is merely fast rather than structurally spawn-free (#681)");
  });

  it("the module never requires child_process at load time", () => {
    // Module scope in this file is column 0; every lazy require sits indented
    // inside a function. A column-0 binding would load child_process for all 13
    // hooks on every event, gate or no gate.
    const src = fs.readFileSync(path.join(__dirname, "..", "hooks", "shared-process.js"), "utf8");
    for (const line of src.split("\n")) {
      if (line.trimStart().startsWith("//")) continue;
      assert.ok(
        !/^(const|let|var|require)\b.*require\("child_process"\)/.test(line),
        `child_process must stay lazily required inside functions, found at module scope: ${line.trim()}`
      );
    }
  });
});
