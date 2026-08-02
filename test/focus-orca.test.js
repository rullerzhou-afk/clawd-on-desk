// test/focus-orca.test.js — Orca window raise + pane-level focus switching
const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const { loadFocusWithMock } = require("./helpers/load-focus-with-mock");

const { orcaPaneKeyFromEnv, applyOrcaPaneKey, NESTED_TERMINAL_ENV } = require("../hooks/shared-process");

const PANE_KEY = "8ce1fff7-tab:9813824b-leaf";
const CWD = "D:\\Repos\\Apps\\clawd-on-desk";
const LIVE_HANDLE = "term_63323b46";
const STALE_HANDLE = "term_4602ecfa";
// Orca packages its terminal daemon inside the app bundle, so extractMacAppBundlePath
// resolves an Orca-hosted session straight to Orca.app — which is what lets the
// generic macOS raise activate the IDE without consulting the pane switch at all.
const ORCA_DAEMON_COMM = "/Applications/Orca.app/Contents/Resources/app/bin/orca-terminal-daemon";

function terminalListPayload(terminals) {
  return JSON.stringify({ ok: true, result: { terminals } });
}

const DEFAULT_TERMINALS = [
  {
    handle: LIVE_HANDLE,
    tabId: "8ce1fff7-tab",
    leafId: "9813824b-leaf",
    worktreePath: "D:/Repos/Apps/clawd-on-desk",
  },
  {
    handle: "term_other",
    tabId: "other-tab",
    leafId: "other-leaf",
    worktreePath: "D:\\Repos\\Apps\\Brainstorm",
  },
];

// execFile mock speaking the `orca ... --json` contract. `switchResults` is
// consumed one entry per `terminal switch` so a stale-then-fresh retry can be
// scripted.
function mockOrcaCli(opts = {}) {
  const {
    terminals = DEFAULT_TERMINALS,
    listPayload = null,
    switchResults = [{ ok: true }],
    missingBinaries = [],
    timeoutOn = [],
    macBundles = ["/Applications/Orca.app"],
    // `ps -o pid=,comm=` output for the legacy macOS raise. Orca's terminal daemon
    // lives inside the app bundle, so a real Orca session makes resolveMacAppBundle
    // hand the generic path Orca.app itself.
    psComm = null,
    switchDelayMs = 0,
  } = opts;
  const calls = [];
  let switchIdx = 0;

  const mock = function (cmd, args, options, cb) {
    if (typeof options === "function") { cb = options; options = {}; }
    calls.push({ cmd, args: [...args] });

    if (cmd === "ps" && psComm && args[1] === "pid=,comm=") {
      const pids = String(args[3] || "").split(",").filter(Boolean);
      if (cb) cb(null, pids.map((pid) => `${pid} ${psComm}`).join("\n"), "");
      return;
    }

    if (missingBinaries.includes(cmd)) {
      const err = new Error(`spawn ${cmd} ENOENT`);
      err.code = "ENOENT";
      if (cb) cb(err, "", "");
      return;
    }

    // `open <bundle>` is how the macOS raise probes for Orca: an absent bundle
    // exits non-zero rather than activating something else, which is the whole
    // reason the raise names a path instead of an app name.
    if (cmd === "/usr/bin/open") {
      if (macBundles.includes(args[0])) {
        if (cb) cb(null, "", "");
      } else {
        const err = new Error(`Unable to find application ${args[0]}`);
        err.code = 1;
        if (cb) cb(err, "", "");
      }
      return;
    }

    // Window-raise helpers used off Windows; they carry no payload.
    if (cmd === "wmctrl" || cmd === "xdotool") {
      if (cb) cb(null, "", "");
      return;
    }

    const joined = args.join(" ");
    if (timeoutOn.some((prefix) => joined.startsWith(prefix))) {
      // execFile's own timeout kill: non-zero exit, empty stdout, killed set.
      const err = new Error(`spawn ${cmd} ETIMEDOUT`);
      err.killed = true;
      if (cb) cb(err, "", "");
      return;
    }
    if (joined.startsWith("terminal list")) {
      if (cb) cb(null, listPayload !== null ? listPayload : terminalListPayload(terminals), "");
      return;
    }
    if (joined.startsWith("terminal switch")) {
      const result = switchResults[Math.min(switchIdx, switchResults.length - 1)];
      switchIdx += 1;
      const answer = () => {
        if (result.ok) {
          if (cb) cb(null, JSON.stringify({ ok: true, result: { focus: { handle: args[3] } } }), "");
        } else {
          // A failing `--json` command still prints its envelope on stdout and
          // exits non-zero, so the error and the payload arrive together.
          if (cb) cb(new Error("exit 1"), JSON.stringify({ ok: false, error: { code: result.code } }), "");
        }
      };
      if (switchDelayMs > 0) setTimeout(answer, switchDelayMs);
      else answer();
      return;
    }
    if (cb) cb(new Error(`unexpected args: ${joined}`), "", "");
  };

  return { mock, calls, switchCalls: () => calls.filter(c => c.args.join(" ").startsWith("terminal switch")) };
}

function withFocus(opts, fn) {
  const cliMock = mockOrcaCli(opts);
  const logs = [];
  const { initFocus, cleanup } = loadFocusWithMock(cliMock.mock, { platform: opts.platform || "darwin" });
  try {
    const api = initFocus({ focusLog: (m) => logs.push(String(m)) });
    return fn(api.__test, cliMock, logs, api);
  } finally {
    cleanup();
  }
}

// scheduleOrcaPaneFocus defers by ORCA_PANE_FOCUS_DELAY_MS and then runs one or
// two async CLI hops; give it a generous multiple so the assertions are stable.
function settle(t) {
  return new Promise((resolve) => setTimeout(resolve, t.ORCA_PANE_FOCUS_DELAY_MS + 250));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("orcaPaneKeyFromEnv / applyOrcaPaneKey", () => {
  it("reads the pane key only when TERM_PROGRAM confirms Orca", () => {
    assert.strictEqual(orcaPaneKeyFromEnv({ TERM_PROGRAM: "Orca", ORCA_PANE_KEY: PANE_KEY }), PANE_KEY);
    // A shell launched from an Orca terminal inherits ORCA_PANE_KEY; without the
    // TERM_PROGRAM confirmation it would claim a pane it does not own.
    assert.strictEqual(orcaPaneKeyFromEnv({ ORCA_PANE_KEY: PANE_KEY }), null);
    assert.strictEqual(orcaPaneKeyFromEnv({ TERM_PROGRAM: "tmux", ORCA_PANE_KEY: PANE_KEY }), null);
    assert.strictEqual(orcaPaneKeyFromEnv({ TERM_PROGRAM: "Orca", ORCA_PANE_KEY: "junk" }), null);
    assert.strictEqual(orcaPaneKeyFromEnv({ TERM_PROGRAM: "Orca" }), null);
    assert.strictEqual(orcaPaneKeyFromEnv({
      CLAWD_REMOTE: "1",
      CLAWD_SSH_REMOTE: "1",
      ORCA_PANE_KEY: PANE_KEY,
    }), PANE_KEY);
    assert.strictEqual(orcaPaneKeyFromEnv({
      CLAWD_REMOTE: "1",
      ORCA_PANE_KEY: PANE_KEY,
    }), null);
    assert.strictEqual(orcaPaneKeyFromEnv({}), null);
    assert.strictEqual(orcaPaneKeyFromEnv(null), null);
  });

  it("rejects a pane key inherited by a terminal launched inside the pane", () => {
    // Launch a terminal from inside an Orca pane and the child inherits
    // TERM_PROGRAM and ORCA_PANE_KEY while living in its own window. A pane key
    // outranks every other signal in the focus script, so that copy would raise
    // Orca instead of the terminal the agent is really in.
    assert.ok(NESTED_TERMINAL_ENV.length >= 10, "expected the full nested-terminal marker list");
    for (const marker of NESTED_TERMINAL_ENV) {
      const env = { TERM_PROGRAM: "Orca", ORCA_PANE_KEY: PANE_KEY, [marker]: "1" };
      assert.strictEqual(orcaPaneKeyFromEnv(env), null, `${marker} must veto the pane key`);
      assert.deepStrictEqual(applyOrcaPaneKey({ a: 1 }, env), { a: 1 });
    }

    // tmux is on the list rather than exempt from it: the server outlives the pane
    // it was started from, so re-attaching the session from another terminal would
    // carry a stale key. tmux >= 3.2 also sets TERM_PROGRAM=tmux, which the
    // TERM_PROGRAM check rejects on its own.
    assert.ok(NESTED_TERMINAL_ENV.includes("TMUX"));
    assert.strictEqual(orcaPaneKeyFromEnv({
      CLAWD_REMOTE: "1",
      CLAWD_SSH_REMOTE: "1",
      ORCA_PANE_KEY: PANE_KEY,
      TMUX: "/tmp/tmux.sock,1,0",
    }), null);
  });

  it("adds orca_pane_key to a body only when the env supplies one", () => {
    assert.deepStrictEqual(
      applyOrcaPaneKey({ a: 1 }, { TERM_PROGRAM: "Orca", ORCA_PANE_KEY: PANE_KEY }),
      { a: 1, orca_pane_key: PANE_KEY }
    );
    assert.deepStrictEqual(applyOrcaPaneKey({ a: 1 }, {}), { a: 1 });
  });

  // The pane key is read per body rather than added to the resolver result: the
  // #674 no-arg red line freezes that shape (defended by the NO_ARG_FIELDS
  // assertion in test/pid-resolver-context.test.js), and reading it per body also
  // survives a cache hit and a failed snapshot, neither of which has room for it.
  // The cost is that every producer needs its own line, so check them by source.
  it("is carried by every producer that reports a process chain for focus", () => {
    const fs = require("fs");
    const hooksDir = path.join(__dirname, "..", "hooks");
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs|py)$/.test(entry.name)) files.push(full);
      }
    };
    walk(hooksDir);

    // AGENTS.md:155 — OpenClaw's Phase 1 integration is state-only, with no
    // permission bubble and no terminal focus, so it has nothing to focus.
    const stateOnly = new Set([path.join("openclaw-plugin", "index.js")]);

    const missing = [];
    for (const file of files) {
      if (stateOnly.has(path.relative(hooksDir, file))) continue;
      const src = fs.readFileSync(file, "utf8");
      // pid_chain, not tmux_client: a producer that reports a process chain is one
      // whose sessions can be focus targets, whether or not it ever grew tmux
      // support.
      if (!/["']?pid_chain["']?\s*[:=]/.test(src)) continue;
      // A CALL, not a mention: matching the bare name meant the `applyOrcaPaneKey`
      // in a producer's require destructure satisfied this on its own, so deleting
      // the actual call left an unused import and a green suite — and there is no
      // linter here to flag the orphan.
      if (!src.includes("orca_pane_key") && !/applyOrcaPaneKey\s*\(/.test(src)) {
        missing.push(path.relative(hooksDir, file));
      }
    }
    assert.deepStrictEqual(missing, [], "focus-capable producers missing orca_pane_key");
  });

  it("is copied before every focus-capable producer leaves through its remote branch", () => {
    const fs = require("fs");
    const hooksDir = path.join(__dirname, "..", "hooks");
    const files = fs.readdirSync(hooksDir)
      .filter((name) => name.endsWith("-hook.js"))
      .map((name) => path.join(hooksDir, name))
      .filter((file) => /["']?pid_chain["']?\s*[:=]/.test(fs.readFileSync(file, "utf8")));
    const missing = [];
    let checked = 0;

    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!/^\s*if \((?:process\.env\.CLAWD_REMOTE|options\.remote|remote)\) \{\s*$/.test(lines[i])) continue;
        const nearby = lines.slice(i, i + 8);
        if (!nearby.some((line) => /body\.host\s*=/.test(line))) continue;
        checked += 1;
        const boundary = nearby.findIndex((line, offset) =>
          offset > 0 && (/^\s*\}\s*else\b/.test(line) || /^\s*return body;\s*$/.test(line))
        );
        const branch = nearby.slice(0, boundary >= 0 ? boundary + 1 : nearby.length).join("\n");
        if (!/applyOrcaPaneKey\s*\(\s*body\b/.test(branch)) {
          missing.push(`${path.basename(file)}:${i + 1}`);
        }
      }
    }

    assert.ok(checked >= 18, `expected all remote body branches, checked ${checked}`);
    assert.deepStrictEqual(missing, [], "remote focus producers drop ORCA_PANE_KEY");
  });
});

describe("Orca pane key validator copies", () => {
  const fs = require("fs");
  const repo = path.join(__dirname, "..");
  // Duplicated rather than shared because pi-extension-core.js and the
  // opencode-family plugin each ship standalone, and the tmux siblings set that
  // precedent. Nothing but this test keeps the copies in step.
  const jsCopies = [
    "hooks/shared-process.js",
    "hooks/pi-extension-core.js",
    "hooks/opencode-family-plugin/core.mjs",
    "src/server-route-state.js",
    "src/server-route-permission.js",
    "src/focus.js",
    "src/session-focus.js",
  ];

  it("shares one pattern across every copy", () => {
    for (const rel of jsCopies) {
      const src = fs.readFileSync(path.join(repo, rel), "utf8");
      const at = src.indexOf("/^[\\w-]+:[\\w-]+$/");
      assert.ok(at > 0, `${rel} must use the canonical pane-key pattern`);
      // Scoped to the validator: these files carry unrelated .trim() calls, so a
      // whole-file match would pass no matter what the validator itself did.
      const validatorPrefix = src.slice(Math.max(0, at - 500), at);
      const trimsDirectly = validatorPrefix.includes(".trim()");
      const trimsViaNormalizer = /normalizeString\([^)]*\)/.test(validatorPrefix)
        && /function normalizeString\([^)]*\)\s*\{[\s\S]{0,120}\.trim\(\)/.test(src);
      assert.ok(trimsDirectly || trimsViaNormalizer,
        `${rel} must trim before matching`);
    }
    const py = fs.readFileSync(path.join(repo, "hooks/hermes-plugin/__init__.py"), "utf8");
    assert.ok(py.includes(String.raw`r"[\w-]+:[\w-]+"`), "the Python copy must use the same pattern");
    assert.ok(/re\.fullmatch\(r"\[\\w-\]\+:\[\\w-\]\+", pane_key, re\.ASCII\)/.test(py),
      "the Python copy must pin \\w to ASCII so it is not laxer than the JS copies");
  });

  // This gate is what decides whether Clawd hijacks focus to Orca. A marker added
  // to shared-process.js alone would leave the standalone copies trusting an
  // inherited key, with the wrong window reported as a successful focus.
  it("keeps the nested-terminal marker list in step across every copy", () => {
    for (const rel of ["hooks/pi-extension-core.js", "hooks/opencode-family-plugin/core.mjs",
      "hooks/hermes-plugin/__init__.py"]) {
      const src = fs.readFileSync(path.join(repo, rel), "utf8");
      const match = /NESTED_TERMINAL_ENV\s*=\s*[[(]/.exec(src);
      assert.ok(match, `${rel} must declare the nested-terminal marker list`);
      const list = src.slice(match.index, match.index + 400);
      for (const marker of NESTED_TERMINAL_ENV) {
        assert.ok(list.includes(`"${marker}"`), `${rel} is missing ${marker} from the list`);
      }
    }
  });
});

describe("Orca window raise", () => {
  // Windows raises inside the generated PowerShell ($orcaProcessNames), so that path
  // must spawn nothing but the `orca` CLI. Linux has no raise at all: WM_CLASS
  // "orca" is a substring match that also hits GNOME's screen reader and OrcaSlicer,
  // so a miss would activate an unrelated window and log it as a success.
  for (const platform of ["win32", "linux"]) {
    it(`spawns only the orca CLI on ${platform}`, async () => {
      await withFocus({ platform }, async (t, cli) => {
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        const strays = cli.calls.filter((c) => !/(^|[\\/])orca(\.exe)?$/i.test(c.cmd));
        assert.deepStrictEqual(strays.map((c) => c.cmd), [],
          `no window-raise helper may be spawned from Node: ${JSON.stringify(cli.calls)}`);
        assert.ok(cli.switchCalls().length > 0, "the pane switch still runs");
      });
    });
  }

  it("activates the Orca bundle by absolute path on macOS", async () => {
    await withFocus({ platform: "darwin", macBundles: ["/Applications/Orca.app"] }, async (t, cli) => {
      t.orcaHandleCache.clear();
      const outcome = await t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
      const opens = cli.calls.filter((c) => c.cmd === "/usr/bin/open");
      // An absolute bundle path cannot resolve to OrcaSlicer the way `open -a Orca`
      // can, needs no Automation consent, and reopens a minimized window.
      assert.deepStrictEqual(opens.map((c) => c.args), [["/Applications/Orca.app"]]);
      assert.strictEqual(outcome.ok, true);
    });
  });

  it("raises only after the switch has succeeded, so a miss never steals focus", async () => {
    for (const opts of [
      { terminals: [] },
      { switchResults: [{ ok: false, code: "terminal_not_writable" }] },
    ]) {
      await withFocus({ platform: "darwin", macBundles: ["/Applications/Orca.app"], ...opts },
        async (t, cli) => {
          t.orcaHandleCache.clear();
          const outcome = await t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
          assert.strictEqual(outcome.ok, false);
          assert.deepStrictEqual(cli.calls.filter((c) => c.cmd === "/usr/bin/open"), [],
            "a failed switch must not pull Orca forward");
        });
    }
  });

  it("reports a missing Orca bundle instead of guessing by name", async () => {
    await withFocus({ platform: "darwin", macBundles: [] }, async (t, cli, logs) => {
      t.orcaHandleCache.clear();
      const outcome = await t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
      // Every candidate is tried and every one is refused, so nothing is activated.
      assert.ok(cli.calls.filter((c) => c.cmd === "/usr/bin/open").length > 0);
      assert.ok(logs.some((l) => l.includes("reason=orca-app-not-found")), logs.join("|"));
      assert.ok(!logs.some((l) => l.includes("reason=orca-app-raised")), logs.join("|"));
      // The tab did move, so the switch outcome stays true: only the raise is lost,
      // which is the same shape as orca-window-ambiguous on Windows.
      assert.strictEqual(outcome.ok, true);
    });
  });

  it("falls through to the per-user Applications folder", async () => {
    const home = require("os").homedir();
    const userBundle = path.posix.join(home.replace(/\\/g, "/"), "Applications", "Orca.app");
    await withFocus({ platform: "darwin", macBundles: [userBundle] }, async (t, cli, logs) => {
      t.orcaHandleCache.clear();
      await t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
      const opens = cli.calls.filter((c) => c.cmd === "/usr/bin/open").map((c) => c.args[0]);
      assert.deepStrictEqual(opens, ["/Applications/Orca.app", userBundle]);
      assert.ok(logs.some((l) => l.includes("reason=orca-app-raised")), logs.join("|"));
    });
  });
});

describe("Orca pane key normalization", () => {
  it("accepts a tabId:leafId pair and rejects anything else", () => {
    withFocus({}, (t) => {
      assert.strictEqual(t.normalizeOrcaPaneKey(PANE_KEY), PANE_KEY);
      assert.strictEqual(t.normalizeOrcaPaneKey(`  ${PANE_KEY}  `), PANE_KEY);
      assert.strictEqual(t.normalizeOrcaPaneKey("no-colon"), null);
      assert.strictEqual(t.normalizeOrcaPaneKey("tab:"), null);
      assert.strictEqual(t.normalizeOrcaPaneKey(":leaf"), null);
      assert.strictEqual(t.normalizeOrcaPaneKey("tab:leaf:extra"), null);
      assert.strictEqual(t.normalizeOrcaPaneKey("tab leaf:x"), null);
      assert.strictEqual(t.normalizeOrcaPaneKey(""), null);
      assert.strictEqual(t.normalizeOrcaPaneKey(null), null);
      assert.strictEqual(t.normalizeOrcaPaneKey(`${"a".repeat(300)}:b`), null);
    });
  });

  it("normalizes separators and trailing slash, folding case only where the filesystem does", () => {
    withFocus({ platform: "win32" }, (t) => {
      assert.strictEqual(
        t.normalizeOrcaWorktreePath("D:\\Repos\\Apps\\clawd-on-desk\\"),
        t.normalizeOrcaWorktreePath("d:/repos/apps/clawd-on-desk")
      );
    });
    withFocus({ platform: "linux" }, (t) => {
      // Here these are two different directories, and folding them would make the
      // worktree fallback pick whichever pane happens to be listed first.
      assert.notStrictEqual(
        t.normalizeOrcaWorktreePath("/home/kai/work/Repo"),
        t.normalizeOrcaWorktreePath("/home/kai/work/repo")
      );
      assert.strictEqual(
        t.normalizeOrcaWorktreePath("/home/kai/work/repo/"),
        t.normalizeOrcaWorktreePath("/home/kai/work/repo")
      );
      assert.strictEqual(t.normalizeOrcaWorktreePath("   "), null);
      assert.strictEqual(t.normalizeOrcaWorktreePath(null), null);
    });
  });

  it("falls back to the worktree when the agent's cwd sits below its root", async () => {
    await withFocus({ platform: "linux" }, async (t, cli) => {
      // Routine shape: the pane is gone and the agent's cwd is a subdirectory of
      // the worktree, which an exact match would report as orca-pane-not-found.
      t.scheduleOrcaPaneFocus("gone-tab:gone-leaf", "D:\\Repos\\Apps\\clawd-on-desk\\src\\hooks");
      await settle(t);
      const switches = cli.switchCalls();
      assert.strictEqual(switches.length, 1, "expected the worktree fallback to switch");
      assert.strictEqual(switches[0].args[3], LIVE_HANDLE);
    });
  });

  it("carries orcaPaneKey through normalizeFocusRequest in both casings", () => {
    withFocus({}, (t) => {
      const fromCamel = t.normalizeFocusRequest({ sourcePid: 10, orcaPaneKey: PANE_KEY });
      const fromSnake = t.normalizeFocusRequest({ sourcePid: 10, orca_pane_key: PANE_KEY });
      const fromMeta = t.normalizeFocusRequest(10, CWD, null, null, { orca_pane_key: PANE_KEY });
      assert.strictEqual(fromCamel.orcaPaneKey, PANE_KEY);
      assert.strictEqual(fromSnake.orcaPaneKey, PANE_KEY);
      assert.strictEqual(fromMeta.orcaPaneKey, PANE_KEY);
      assert.strictEqual(t.normalizeFocusRequest({ sourcePid: 10, orcaPaneKey: "junk" }).orcaPaneKey, null);
    });
  });

  it("leaves the editor allowlist untouched so the VS Code tab route cannot misfire", () => {
    withFocus({}, (t) => {
      // scheduleTerminalTabFocus POSTs to the extension ports for any truthy
      // editor, so "orca" must never become an editor value.
      assert.strictEqual(t.normalizeFocusRequest({ sourcePid: 10, editor: "orca" }).editor, null);
      assert.strictEqual(t.normalizeFocusRequest({ sourcePid: 10, editor: "code" }).editor, "code");
      assert.strictEqual(t.normalizeFocusRequest({ sourcePid: 10, editor: "cursor" }).editor, "cursor");
    });
  });
});

describe("Orca CLI discovery", () => {
  it("prefers PATH and adds the known install path on Windows", () => {
    const prev = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = "C:\\Users\\t\\AppData\\Local";
    try {
      withFocus({ platform: "win32" }, (t) => {
        const candidates = t.orcaCliCandidates();
        assert.strictEqual(candidates[0], "orca");
        assert.ok(candidates.some(c => c === path.join(
          "C:\\Users\\t\\AppData\\Local", "Programs", "orca", "resources", "bin", "orca.exe")));
      });
    } finally {
      if (prev === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prev;
    }
  });

  it("adds Homebrew and app-bundled install locations on macOS", () => {
    withFocus({ platform: "darwin" }, (t) => {
      const candidates = t.orcaCliCandidates();
      assert.strictEqual(candidates[0], "orca");
      assert.ok(candidates.includes("/opt/homebrew/bin/orca"));
      assert.ok(candidates.includes("/usr/local/bin/orca"));
      assert.ok(candidates.includes("/Applications/Orca.app/Contents/Resources/bin/orca"));
      assert.ok(candidates.includes(path.posix.join(
        os.homedir().replace(/\\/g, "/"), "Applications", "Orca.app", "Contents", "Resources", "bin", "orca"
      )));
      assert.ok(candidates.includes(path.posix.join(
        os.homedir().replace(/\\/g, "/"), ".local", "bin", "orca"
      )));
    });
  });

  it("keeps the posix install locations off the Windows list", () => {
    const prev = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = "C:\\Users\\t\\AppData\\Local";
    try {
      withFocus({ platform: "win32" }, (t) => {
        assert.ok(!t.orcaCliCandidates().includes("/usr/local/bin/orca"));
      });
    } finally {
      if (prev === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prev;
    }
  });
});

describe("resolveOrcaHandle", () => {
  const resolveHandle = (t, key, cwd) => new Promise((resolve) => {
    t.resolveOrcaHandle(key, cwd, (result) => resolve(result));
  });

  it("resolves the live handle from the pane key", async () => {
    await withFocus({}, async (t) => {
      const res = await resolveHandle(t, PANE_KEY, CWD);
      assert.strictEqual(res.handle, LIVE_HANDLE);
      // Only an exact pane match is precise enough for Direct Send to paste into.
      assert.strictEqual(res.match, "exact");
    });
  });

  it("falls back to the worktree path when the pane is gone", async () => {
    await withFocus({}, async (t) => {
      const res = await resolveHandle(t, "dead-tab:dead-leaf", CWD);
      assert.strictEqual(res.handle, LIVE_HANDLE);
      assert.strictEqual(res.match, "cwd");
    });
  });

  it("prefers the longest matching worktree so a nested session keeps its own tab", async () => {
    const terminals = [
      { handle: "term_outer", tabId: "outer", leafId: "leaf", worktreePath: "D:/Repos/Apps" },
      { handle: "term_inner", tabId: "inner", leafId: "leaf", worktreePath: "D:/Repos/Apps/clawd-on-desk" },
    ];
    await withFocus({ terminals }, async (t) => {
      const res = await resolveHandle(t, "gone-tab:gone-leaf", `${CWD}\\src`);
      // Both worktrees are prefixes of the cwd and the outer one is listed first;
      // taking it would switch a different session's tab and still log a success.
      assert.strictEqual(res.handle, "term_inner");
      assert.strictEqual(res.match, "cwd");
    });
  });

  it("fails as ambiguous when two terminals share the best worktree match", async () => {
    // One worktree open in two Orca panes. The old strict > kept whichever Orca
    // listed first and logged a successful switch, so a Direct Send reply could
    // land in the other pane's composer.
    const terminals = [
      { handle: "term_first", tabId: "a", leafId: "leaf", worktreePath: "D:/Repos/Apps/clawd-on-desk" },
      { handle: "term_second", tabId: "b", leafId: "leaf", worktreePath: "D:\\Repos\\Apps\\clawd-on-desk" },
    ];
    await withFocus({ terminals }, async (t) => {
      const res = await resolveHandle(t, "gone-tab:gone-leaf", `${CWD}\\src`);
      assert.strictEqual(res.handle, null);
      assert.strictEqual(res.match, null);
      assert.strictEqual(res.failure, "orca-pane-ambiguous");
    });
  });

  it("still resolves an exact pane key while other terminals tie on the worktree", async () => {
    // The tie only decides the fallback; an exact key is never ambiguous.
    const terminals = [
      { handle: "term_first", tabId: "a", leafId: "leaf", worktreePath: "D:/Repos/Apps/clawd-on-desk" },
      { handle: LIVE_HANDLE, tabId: "8ce1fff7-tab", leafId: "9813824b-leaf", worktreePath: "D:/Repos/Apps/clawd-on-desk" },
    ];
    await withFocus({ terminals }, async (t) => {
      const res = await resolveHandle(t, PANE_KEY, CWD);
      assert.strictEqual(res.handle, LIVE_HANDLE);
      assert.strictEqual(res.match, "exact");
    });
  });

  it("returns null when neither the pane nor the worktree matches", async () => {
    await withFocus({}, async (t) => {
      const res = await resolveHandle(t, "dead-tab:dead-leaf", "D:\\Repos\\Apps\\Unknown");
      assert.strictEqual(res.handle, null);
      assert.strictEqual(res.match, null);
    });
  });

  it("returns null on an ok:false envelope or unparseable output", async () => {
    await withFocus({ listPayload: JSON.stringify({ ok: false, error: { code: "runtime_unavailable" } }) },
      async (t) => {
        const res = await resolveHandle(t, PANE_KEY, CWD);
        assert.strictEqual(res.handle, null);
        assert.strictEqual(res.match, null);
      });

    await withFocus({ listPayload: "not json" }, async (t) => {
      const res = await resolveHandle(t, PANE_KEY, CWD);
      assert.strictEqual(res.handle, null);
      assert.strictEqual(res.match, null);
    });
  });
});

describe("scheduleOrcaPaneFocus", () => {
  it("resolves then switches on a cold cache and remembers the handle", async () => {
    await withFocus({}, async (t, cli, logs) => {
      t.orcaHandleCache.clear();
      t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
      await settle(t);
      assert.deepStrictEqual(cli.switchCalls().map(c => c.args[3]), [LIVE_HANDLE]);
      assert.ok(logs.some(l => l.includes("branch=orca reason=orca-pane-switched")), logs.join("|"));
      assert.strictEqual(t.orcaHandleCache.get(PANE_KEY), LIVE_HANDLE);
    });
  });

  it("re-resolves exactly once when a cached handle has gone stale", async () => {
    await withFocus({ switchResults: [{ ok: false, code: "terminal_handle_stale" }, { ok: true }] },
      async (t, cli, logs) => {
        t.orcaHandleCache.clear();
        t.orcaHandleCache.set(PANE_KEY, STALE_HANDLE);
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        // Stale cached handle first, then the freshly resolved one — and no third try.
        assert.deepStrictEqual(cli.switchCalls().map(c => c.args[3]), [STALE_HANDLE, LIVE_HANDLE]);
        assert.ok(logs.some(l => l.includes("reason=orca-pane-switched")), logs.join("|"));
        assert.strictEqual(t.orcaHandleCache.get(PANE_KEY), LIVE_HANDLE);
      });
  });

  it("does not retry when a freshly resolved handle is itself rejected as stale", async () => {
    await withFocus({ switchResults: [{ ok: false, code: "terminal_handle_stale" }] },
      async (t, cli, logs) => {
        t.orcaHandleCache.clear();
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        assert.strictEqual(cli.switchCalls().length, 1);
        assert.ok(logs.some(l => l.includes("reason=orca-handle-stale")), logs.join("|"));
        assert.strictEqual(t.orcaHandleCache.has(PANE_KEY), false);
      });
  });

  it("reports a non-stale switch failure without caching the handle", async () => {
    await withFocus({ switchResults: [{ ok: false, code: "terminal_not_writable" }] },
      async (t, cli, logs) => {
        t.orcaHandleCache.clear();
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        assert.ok(logs.some(l => l.includes("reason=orca-switch-failed")), logs.join("|"));
        assert.strictEqual(t.orcaHandleCache.has(PANE_KEY), false);
      });
  });

  it("reports pane-not-found instead of switching a guessed terminal", async () => {
    await withFocus({ terminals: [] }, async (t, cli, logs) => {
      t.orcaHandleCache.clear();
      t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
      await settle(t);
      assert.strictEqual(cli.switchCalls().length, 0);
      assert.ok(logs.some(l => l.includes("reason=orca-pane-not-found")), logs.join("|"));
    });
  });

  it("degrades quietly when the orca CLI is not installed", async () => {
    const prev = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      // Every candidate has to be absent. Leaving one reachable makes this fixture
      // exercise a successful switch under a name that claims the opposite.
      const noOrcaAnywhere = [
        "orca",
        "/opt/homebrew/bin/orca",
        "/usr/local/bin/orca",
        "/Applications/Orca.app/Contents/Resources/bin/orca",
        path.posix.join(
          os.homedir().replace(/\\/g, "/"), "Applications", "Orca.app", "Contents", "Resources", "bin", "orca"
        ),
        path.posix.join(os.homedir().replace(/\\/g, "/"), ".local", "bin", "orca"),
      ];
      await withFocus({ platform: "darwin", missingBinaries: noOrcaAnywhere }, async (t, cli, logs) => {
        t.orcaHandleCache.clear();
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        assert.strictEqual(cli.switchCalls().length, 0);
        // Not orca-pane-not-found: "Orca is not installed / not on PATH" and
        // "that pane is gone" need different fixes, and focus-debug.log is the
        // only place anyone will see the difference.
        assert.ok(logs.some(l => l.includes("reason=orca-cli-not-found")), logs.join("|"));
      });
    } finally {
      if (prev !== undefined) process.env.LOCALAPPDATA = prev;
    }
  });

  it("is a no-op without a pane key", async () => {
    await withFocus({}, async (t, cli, logs) => {
      t.scheduleOrcaPaneFocus(null, CWD);
      t.scheduleOrcaPaneFocus("", CWD);
      await settle(t);
      assert.strictEqual(cli.calls.length, 0);
      assert.strictEqual(logs.length, 0);
    });
  });
});

describe("scheduleOrcaPaneFocus outcome", () => {
  // The switch used to be fire-and-forget, so Telegram Direct Send waited a fixed
  // 1200ms and pressed Ctrl+V whatever happened. A cold CLI outlasts that wait,
  // and the reply then lands in whichever pane was previously active — reported as
  // delivered. The outcome below is what lets Direct Send wait for the real answer.
  it("reports an exact pane match once the switch succeeds", async () => {
    await withFocus({ platform: "win32" }, async (t) => {
      t.orcaHandleCache.clear();
      const outcome = await t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
      assert.deepStrictEqual(outcome, { ok: true, match: "exact", reason: "orca-pane-switched" });
    });
  });

  it("reports the worktree fallback as a non-exact match", async () => {
    await withFocus({ platform: "win32" }, async (t) => {
      t.orcaHandleCache.clear();
      const outcome = await t.scheduleOrcaPaneFocus("gone-tab:gone-leaf", `${CWD}\\src`);
      assert.strictEqual(outcome.ok, true);
      assert.strictEqual(outcome.match, "cwd");
    });
  });

  it("never caches a handle found only by the worktree fallback", async () => {
    await withFocus({ platform: "win32" }, async (t) => {
      t.orcaHandleCache.clear();
      await t.scheduleOrcaPaneFocus("gone-tab:gone-leaf", `${CWD}\\src`);
      // Caching a guess would replay it as a cache hit, and a cache hit cannot tell
      // Direct Send whether the pane was ever really identified.
      assert.strictEqual(t.orcaHandleCache.has("gone-tab:gone-leaf"), false);
    });
  });

  it("resolves rather than rejects when there is no pane key", async () => {
    await withFocus({ platform: "win32" }, async (t) => {
      const outcome = await t.scheduleOrcaPaneFocus(null, CWD);
      assert.deepStrictEqual(outcome, { ok: false, match: null, reason: "no-pane-key" });
    });
  });

  for (const [label, opts, key, reason] of [
    ["a missing pane", { terminals: [] }, PANE_KEY, "orca-pane-not-found"],
    ["a CLI that never answers", { timeoutOn: ["terminal list"] }, PANE_KEY, "orca-cli-timeout"],
    ["a rejected switch", { switchResults: [{ ok: false, code: "terminal_not_writable" }] }, PANE_KEY, "orca-switch-failed"],
    ["an ambiguous worktree", {
      terminals: [
        { handle: "term_first", tabId: "a", leafId: "leaf", worktreePath: "D:/Repos/Apps/clawd-on-desk" },
        { handle: "term_second", tabId: "b", leafId: "leaf", worktreePath: "D:/Repos/Apps/clawd-on-desk" },
      ],
    }, "gone-tab:gone-leaf", "orca-pane-ambiguous"],
  ]) {
    it(`reports ${label} as a failed outcome`, async () => {
      await withFocus({ platform: "win32", ...opts }, async (t) => {
        t.orcaHandleCache.clear();
        const outcome = await t.scheduleOrcaPaneFocus(key, CWD);
        assert.strictEqual(outcome.ok, false, `expected a failure for ${label}`);
        assert.strictEqual(outcome.match, null);
        assert.strictEqual(outcome.reason, reason);
      });
    });
  }
});

describe("Windows Orca window fallback", () => {
  it("gates the Orca branch on the orcaHosted flag", () => {
    withFocus({ platform: "win32" }, (t) => {
      const off = t.makeFocusCmd(4242, ["clawd-on-desk"], null, null, "tok");
      const on = t.makeFocusCmd(4242, ["clawd-on-desk"], null, null, "tok", ["clawd-on-desk"], true);
      // Sixth-arg callers must keep working — the flag defaults to off.
      assert.match(off, /\$orcaHosted = \$false/);
      assert.match(on, /\$orcaHosted = \$true/);
      for (const script of [off, on]) {
        assert.match(script, /\$orcaProcessNames = @\('Orca'\)/);
        assert.match(script, /function Get-ClawdOrcaWindows/);
        assert.match(script, /if \(\$orcaHosted\) \{/);
        assert.match(script, /\$reason = 'orca-window'/);
        assert.match(script, /\$reason = 'orca-window-ambiguous'/);
        assert.match(script, /\$reason = 'orca-window-missing'/);
      }
    });
  });

  it("tries the Orca window before every other branch in the script", () => {
    withFocus({ platform: "win32" }, (t) => {
      const script = t.makeFocusCmd(4242, ["clawd-on-desk"], "key", 4660, "tok", ["clawd-on-desk"], true);
      const orcaAt = script.indexOf("if ($orcaHosted) {");
      const cacheAt = script.indexOf("$reason = 'cached-window'");
      const wtHwndAt = script.indexOf("$reason = 'wt-hwnd-from-hook'");
      const walkAt = script.indexOf("for ($i = 0; $i -lt 8; $i++)");
      // Anchor on the assignment, not the bare reason string — the explanatory
      // comment above the Orca branch mentions that reason by name too.
      const wtFallbackAt = script.indexOf("$reason = 'wt-title-mismatch-single-wt-window'");
      assert.ok(orcaAt > 0 && cacheAt > 0 && wtHwndAt > 0 && walkAt > 0 && wtFallbackAt > 0);
      for (const [label, at] of [["cached-window", cacheAt], ["wt-hwnd-from-hook", wtHwndAt],
        ["the process-tree walk", walkAt], ["the WT title fallbacks", wtFallbackAt]]) {
        assert.ok(orcaAt < at, `Orca branch must precede ${label}`);
      }
    });
  });

  it("keeps a recorded wt_hwnd and a stale cache from pre-empting an Orca session", () => {
    withFocus({ platform: "win32" }, (t) => {
      // Both fields ride the same request: wt_hwnd is whatever happened to be
      // foreground when the hook fired (hooks/shared-process.js foregroundWtHwnd),
      // and src/state.js makes it sticky, so one SessionStart next to a Windows
      // Terminal window would otherwise focus that terminal for the rest of the
      // session — and report it as a success.
      const script = t.makeFocusCmd(4242, ["clawd-on-desk"], "key", 4660, "tok", ["clawd-on-desk"], true);
      assert.match(script, /\$wtHwndFromHook = \[IntPtr\]\(\[int64\]4660\)/);
      assert.match(script, /\$orcaHosted = \$true/);
      assert.ok(script.includes("if (-not $focused -and -not $orcaHosted) {"),
        "the window cache must be gated off for Orca sessions");
      // Get-ClawdCachedWindow evicts the stored entry on a validation miss, so it
      // has to be read inside that gate rather than before it — otherwise an Orca
      // focus drops another path's cache entry as a side effect.
      const cacheGateAt = script.indexOf("if (-not $focused -and -not $orcaHosted) {");
      const cacheReadAt = script.indexOf("$cachedHwnd = Get-ClawdCachedWindow");
      assert.ok(cacheGateAt > 0 && cacheReadAt > cacheGateAt,
        "the cache must not be read, and evicted, ahead of the Orca gate");
      assert.ok(script.includes("if (-not $focused -and -not $orcaHosted -and $wtHwndFromHook -ne [IntPtr]::Zero)"),
        "the recorded wt_hwnd must be gated off for Orca sessions");
      // On orca-window-missing the reason must stay negative rather than being
      // overwritten by a fallback that focused an unrelated window.
      assert.strictEqual(t.isPositiveFocusReason("orca-window-missing"), false);

      // Gating those two off must not also lock out the console recovery further
      // down, which is an identity signal rather than a guess: its reason
      // whitelist has to accept the Orca branch's negative outcomes.
      const conhostGate = script.slice(script.indexOf("$pendingConsoleHwnd -ne [IntPtr]::Zero) {"));
      assert.match(conhostGate, /\$reason -eq 'orca-window-missing'/);
      assert.match(conhostGate, /\$reason -eq 'orca-window-ambiguous'/);
      // The WT title guess stays locked out, though — for an Orca session it can
      // only ever name an unrelated terminal.
      assert.ok(script.includes("if (-not $focused -and $reason -eq 'no-parent-window') {"),
        "the WT title fallback must stay gated on no-parent-window alone");
    });
  });

  it("never caches the Orca window, whose title cannot satisfy the cache check", () => {
    withFocus({ platform: "win32" }, (t) => {
      const script = t.makeFocusCmd(4242, ["clawd-on-desk"], "key", null, "tok", ["clawd-on-desk"], true);
      const block = script.slice(
        script.indexOf("if ($orcaHosted) {"),
        script.indexOf("$cachedHwnd = Get-ClawdCachedWindow")
      );
      assert.ok(block.length > 0);
      assert.ok(!block.includes("Save-ClawdFocusCache"),
        "the Orca window title is just 'Orca', so a cached entry would fail Test-ClawdWindowTitleMatch");
    });
  });

  it("counts orca-window as a successful focus but not its ambiguous siblings", () => {
    withFocus({ platform: "win32" }, (t) => {
      assert.strictEqual(t.isPositiveFocusReason("orca-window"), true);
      assert.strictEqual(t.isPositiveFocusReason("orca-window-ambiguous"), false);
      assert.strictEqual(t.isPositiveFocusReason("orca-window-missing"), false);
    });
  });
});

describe("Orca CLI that never answers", () => {
  // Warm round-trips are ~400ms, but the first call after Orca has been idle can
  // exceed the timeout and get killed. Reporting that as a missing pane sends
  // whoever reads focus-debug.log looking in entirely the wrong place.
  for (const step of ["terminal list", "terminal switch"]) {
    it(`reports a killed \`${step}\` as a timeout rather than a missing pane`, async () => {
      await withFocus({ platform: "win32", timeoutOn: [step] }, async (t, cli, logs) => {
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        assert.ok(logs.some((l) => l.includes("reason=orca-cli-timeout")),
          `expected orca-cli-timeout, got ${JSON.stringify(logs)}`);
        assert.ok(!logs.some((l) => /orca-pane-not-found|orca-switch-failed/.test(l)),
          `a timeout must not be reported as pane-not-found or switch-failed: ${JSON.stringify(logs)}`);
      });
    });
  }
});

describe("Orca focus wiring", () => {
  // The Windows dispatch itself is driven through the public focusTerminalWindow in
  // test/focus-windows.test.js, which mocks spawn so the real helper never starts.
  it("is dispatched from the Windows and macOS branches, never Linux", () => {
    const fs = require("fs");
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "focus.js"), "utf8");
    const calls = src.match(/scheduleOrcaPaneFocus\(request\./g) || [];
    assert.strictEqual(calls.length, 2, "expected one dispatch per supported platform");
    // Linux still has no raise it can trust — WM_CLASS "orca" also matches GNOME's
    // screen reader — so a pane switch there would move a tab in a window that never
    // comes forward, which is worse than doing nothing.
    const linuxBranch = src.slice(src.indexOf("branch=linux-command-submitted") - 800);
    assert.ok(!/scheduleOrcaPaneFocus/.test(linuxBranch.slice(0, 800)),
      "the Linux branch must not dispatch the pane switch");
  });

  it("reaches the pane switch and the raise through the public macOS focus call", async () => {
    // The source guard above cannot see whether the dispatch is actually reachable:
    // the mac branch sits behind a throttle and an in-flight queue.
    await withFocus({ platform: "darwin" }, async (t, cli, logs, focus) => {
      t.orcaHandleCache.clear();
      focus.focusTerminalWindow({
        sourcePid: 3333,
        cwd: CWD,
        sessionId: "session-orca-mac",
        agentId: "claude-code",
        orcaPaneKey: PANE_KEY,
      });
      await settle(t);
      assert.strictEqual(cli.switchCalls().length, 1, JSON.stringify(cli.calls));
      assert.deepStrictEqual(
        cli.calls.filter((c) => c.cmd === "/usr/bin/open").map((c) => c.args),
        [["/Applications/Orca.app"]]
      );
      assert.ok(logs.some((l) => l.includes("reason=orca-pane-switched")), logs.join("|"));
    });
  });

  it("focuses an Orca-managed SSH pane on macOS without a local source PID", async () => {
    await withFocus({ platform: "darwin" }, async (t, cli, logs, focus) => {
      t.orcaHandleCache.clear();
      focus.focusTerminalWindow({
        cwd: "/remote/worktree",
        sessionId: "remote:session-orca-mac",
        agentId: "codex",
        orcaPaneKey: PANE_KEY,
      });
      await settle(t);
      assert.strictEqual(cli.switchCalls().length, 1, JSON.stringify(cli.calls));
      assert.deepStrictEqual(
        cli.calls.filter((c) => c.cmd === "/usr/bin/open").map((c) => c.args),
        [["/Applications/Orca.app"]]
      );
      assert.ok(!logs.some((l) => l.includes("reason=no-source-pid")), logs.join("|"));
    });
  });

  // The three tests below drive the public path with `ps` reporting the packaged
  // daemon, which is the fixture the suite was missing: without psComm the generic
  // raise finds no bundle and silently skips `open`, hiding the ordering entirely.
  it("never raises Orca on macOS when the pane is gone", async () => {
    await withFocus({ platform: "darwin", terminals: [], psComm: ORCA_DAEMON_COMM }, async (t, cli, logs, focus) => {
      t.orcaHandleCache.clear();
      focus.focusTerminalWindow({
        sourcePid: 3333,
        cwd: CWD,
        sessionId: "session-orca-mac-gone",
        agentId: "claude-code",
        orcaPaneKey: PANE_KEY,
      });
      await settle(t);
      // `open` launches Orca, and the terminal daemon outlives its window, so a
      // sticky key pointing at a dead session would cold-start the IDE on a click.
      assert.deepStrictEqual(cli.calls.filter((c) => c.cmd === "/usr/bin/open").map((c) => c.args), []);
      assert.ok(logs.some((l) => l.includes("reason=orca-pane-not-found")), logs.join("|"));
    });
  });

  it("completes the pane switch before raising Orca on macOS", async () => {
    await withFocus({ platform: "darwin", psComm: ORCA_DAEMON_COMM }, async (t, cli, logs, focus) => {
      t.orcaHandleCache.clear();
      focus.focusTerminalWindow({
        sourcePid: 3333,
        cwd: CWD,
        sessionId: "session-orca-mac-order",
        agentId: "claude-code",
        orcaPaneKey: PANE_KEY,
      });
      await settle(t);
      // Exactly one raise: the generic path must not have contributed a second.
      assert.deepStrictEqual(
        cli.calls.filter((c) => c.cmd === "/usr/bin/open").map((c) => c.args),
        [["/Applications/Orca.app"]]
      );
      const switchAt = cli.calls.findIndex((c) => c.args.join(" ").startsWith("terminal switch"));
      const openAt = cli.calls.findIndex((c) => c.cmd === "/usr/bin/open");
      assert.ok(switchAt >= 0 && openAt > switchAt, JSON.stringify(cli.calls));
    });
  });

  it("holds the macOS in-flight guard until the Orca CLI sequence settles", async () => {
    await withFocus({
      platform: "darwin",
      psComm: ORCA_DAEMON_COMM,
      switchDelayMs: 2000,
    }, async (t, cli, logs, focus) => {
      t.orcaHandleCache.clear();
      const request = (sourcePid, sessionId) => focus.focusTerminalWindow({
        sourcePid, cwd: CWD, sessionId, agentId: "claude-code", orcaPaneKey: PANE_KEY,
      });
      // Counted by `terminal switch`, not `terminal list`: the second request hits the
      // handle cache the first one populated and never lists at all.
      const switches = () => cli.switchCalls().length;

      request(3333, "session-orca-mac-first");
      // Deliberately past MAC_FOCUS_THROTTLE_MS: inside it the throttle would defer
      // the second request on its own and prove nothing about the in-flight guard.
      await wait(1700);
      request(4444, "session-orca-mac-second");
      await wait(200);
      assert.strictEqual(switches(), 1, JSON.stringify(cli.calls));

      // A guard that never releases would deadlock the queue, which the assertion
      // above cannot tell apart from a working one.
      await wait(1200);
      assert.strictEqual(switches(), 2, JSON.stringify(cli.calls));
    });
  });

  it("carries the pane key through every focus-entry builder", () => {
    const fs = require("fs");
    const repo = path.join(__dirname, "..");
    // These assignments are the only thing putting the pane key on the entries that
    // reach normalizeFocusRequest and the Direct Send paste delay, and the
    // permission bubble's "go to terminal" is the gesture the whole feature exists
    // for. No fixture in test/permission-*.test.js sets a pane key, so deleting one
    // of these lines otherwise fails nothing. The snapshot entry is a whitelist:
    // omit it there and the field silently never reaches Telegram Direct Send.
    const sites = [
      ["src/main.js", "if (entry.orcaPaneKey) focusEntry.orcaPaneKey = entry.orcaPaneKey;"],
      ["src/main.js", "orcaPaneKey: session.orcaPaneKey,"],
      ["src/main.js", "if (!session || (!session.sourcePid && !session.orcaPaneKey)) return false;"],
      ["src/permission.js", "if (perm.orcaPaneKey) focusEntry.orcaPaneKey = perm.orcaPaneKey;"],
      ["src/state-session-snapshot.js", "orcaPaneKey: (session && session.orcaPaneKey) || null,"],
    ];
    for (const [rel, needle] of sites) {
      const src = fs.readFileSync(path.join(repo, rel), "utf8");
      assert.ok(src.includes(needle), `${rel} must carry the pane key: ${needle}`);
    }
  });
});
