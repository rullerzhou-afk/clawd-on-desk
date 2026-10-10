// test/focus-herdr.test.js — herdr pane focus (#1139): hook-side capture of
// HERDR_PANE_ID and the `herdr agent focus <pane>` call on click.
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { loadFocusWithMock } = require("./helpers/load-focus-with-mock");

const { herdrPaneFromEnv, applyOrcaPaneKey } = require("../hooks/shared-process");

const PANE_ID = "w5:p4";
const SOCKET = "/Users/me/.config/herdr/herdr.sock";

// execFile mock for the herdr CLI. `missing` lists binaries that ENOENT, so the
// candidate walk can be exercised; `result` is what the first present one returns.
function mockHerdrCli({ missing = [], result = { err: null }, psComm = null } = {}) {
  const calls = [];
  const mock = function (cmd, args, options, cb) {
    if (typeof options === "function") { cb = options; options = {}; }
    calls.push({ cmd, args: [...args], options });
    if (cmd === "ps" && psComm && args[1] === "pid=,comm=") {
      const pids = String(args[3] || "").split(",").filter(Boolean);
      if (cb) cb(null, pids.map((pid) => `${pid} ${psComm}`).join("\n"), "");
      return;
    }
    if (missing.includes(cmd)) {
      const err = new Error(`spawn ${cmd} ENOENT`);
      err.code = "ENOENT";
      if (cb) cb(err, "", "");
      return;
    }
    if (String(cmd).endsWith("herdr")) {
      if (cb) cb(result.err, result.stdout || "", result.stderr || "");
      return;
    }
    if (cb) cb(null, "", "");
  };
  return { mock, calls };
}

function withFocus(cli, fn, platform = "darwin") {
  const logs = [];
  const { initFocus, cleanup } = loadFocusWithMock(cli.mock, { platform });
  try {
    const api = initFocus({ focusLog: (m) => logs.push(String(m)) });
    return fn(api.__test, logs, api);
  } finally {
    cleanup();
  }
}

describe("herdrPaneFromEnv (hook side)", () => {
  it("captures the pane id and socket inside a herdr pane", () => {
    assert.deepStrictEqual(
      herdrPaneFromEnv({ HERDR_ENV: "1", HERDR_PANE_ID: PANE_ID, HERDR_SOCKET_PATH: SOCKET, TERM_PROGRAM: "ghostty" }),
      { paneId: PANE_ID, socket: SOCKET }
    );
  });

  it("requires HERDR_ENV=1 and a well-formed pane id", () => {
    assert.strictEqual(herdrPaneFromEnv({ HERDR_PANE_ID: PANE_ID }), null);
    assert.strictEqual(herdrPaneFromEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w5 p4; rm" }), null);
    assert.strictEqual(herdrPaneFromEnv({ HERDR_ENV: "1" }), null);
  });

  it("drops a relative socket path instead of shipping it", () => {
    assert.deepStrictEqual(
      herdrPaneFromEnv({ HERDR_ENV: "1", HERDR_PANE_ID: PANE_ID, HERDR_SOCKET_PATH: "herdr.sock" }),
      { paneId: PANE_ID, socket: null }
    );
  });

  it("vetoes a multiplexer or terminal nested inside the pane", () => {
    for (const key of ["TMUX", "ZELLIJ", "STY", "KITTY_WINDOW_ID", "WEZTERM_PANE"]) {
      assert.strictEqual(
        herdrPaneFromEnv({ HERDR_ENV: "1", HERDR_PANE_ID: PANE_ID, [key]: "x" }),
        null,
        key
      );
    }
  });

  it("never ships from a remote hook", () => {
    assert.strictEqual(
      herdrPaneFromEnv({ HERDR_ENV: "1", HERDR_PANE_ID: PANE_ID, CLAWD_REMOTE: "1", CLAWD_SSH_REMOTE: "1" }),
      null
    );
  });

  it("applyOrcaPaneKey adds herdr fields to the body and leaves others alone", () => {
    const body = applyOrcaPaneKey({ state: "working" }, { HERDR_ENV: "1", HERDR_PANE_ID: PANE_ID, HERDR_SOCKET_PATH: SOCKET });
    assert.deepStrictEqual(body, { state: "working", herdr_pane_id: PANE_ID, herdr_socket: SOCKET });
    assert.deepStrictEqual(applyOrcaPaneKey({ state: "idle" }, {}), { state: "idle" });
  });
});

describe("scheduleHerdrPaneFocus (focus side)", () => {
  it("runs `herdr agent focus <pane>` with the captured socket", async () => {
    const cli = mockHerdrCli();
    await withFocus(cli, async (t, logs) => {
      const res = await t.scheduleHerdrPaneFocus(PANE_ID, SOCKET);
      assert.deepStrictEqual(res, { ok: true, reason: "herdr-pane-focused" });
      const call = cli.calls.find((c) => c.cmd === "herdr");
      assert.deepStrictEqual(call.args, ["agent", "focus", PANE_ID]);
      assert.strictEqual(call.options.env.HERDR_SOCKET_PATH, SOCKET);
      assert.ok(logs.some((l) => l.includes("branch=herdr reason=herdr-pane-focused")), JSON.stringify(logs));
    });
  });

  it("falls through PATH to the Homebrew binary on a Finder-launched app", async () => {
    const cli = mockHerdrCli({ missing: ["herdr"] });
    await withFocus(cli, async (t) => {
      const res = await t.scheduleHerdrPaneFocus(PANE_ID, null);
      assert.strictEqual(res.ok, true);
      const ran = cli.calls.filter((c) => String(c.cmd).endsWith("herdr")).map((c) => c.cmd);
      assert.deepStrictEqual(ran, ["herdr", "/opt/homebrew/bin/herdr"]);
    });
  });

  it("reports a missing CLI, a timeout and a failed focus distinctly", async () => {
    const candidates = withFocus(mockHerdrCli(), (t) => t.herdrCliCandidates());
    const notFound = mockHerdrCli({ missing: candidates });
    await withFocus(notFound, async (t) => {
      assert.strictEqual((await t.scheduleHerdrPaneFocus(PANE_ID)).reason, "herdr-cli-not-found");
    });

    const timeout = Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" });
    await withFocus(mockHerdrCli({ result: { err: timeout } }), async (t) => {
      assert.strictEqual((await t.scheduleHerdrPaneFocus(PANE_ID)).reason, "herdr-cli-timeout");
    });

    const failed = Object.assign(new Error("exit 1"), { code: 1 });
    await withFocus(mockHerdrCli({ result: { err: failed, stderr: "agent_not_found\n" } }), async (t, logs) => {
      assert.strictEqual((await t.scheduleHerdrPaneFocus(PANE_ID)).reason, "herdr-focus-failed");
      assert.ok(logs.some((l) => l.includes("reason=herdr-focus-failed code=1 detail=agent_not_found")), JSON.stringify(logs));
    });
  });

  it("does nothing without a valid pane id, and refuses one that reads as a flag", async () => {
    const cli = mockHerdrCli();
    await withFocus(cli, async (t) => {
      assert.strictEqual((await t.scheduleHerdrPaneFocus(null)).reason, "no-pane-id");
      assert.strictEqual((await t.scheduleHerdrPaneFocus("--help:x")).reason, "no-pane-id");
      assert.ok(!cli.calls.some((c) => String(c.cmd).endsWith("herdr")));
    });
  });

  it("a macOS click switches the pane and still runs the generic raise", async () => {
    const cli = mockHerdrCli({ psComm: "/Applications/Ghostty.app/Contents/MacOS/ghostty" });
    await withFocus(cli, async (_t, logs, api) => {
      api.focusTerminalWindow({
        sourcePid: 900,
        pidChain: [100, 150, 200, 920, 910, 900],
        cwd: "/Users/me/repo",
        herdrPaneId: PANE_ID,
        herdrSocket: SOCKET,
        sessionId: "s1",
        agentId: "claude-code",
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(cli.calls.some((c) => c.cmd === "herdr" && c.args.join(" ") === `agent focus ${PANE_ID}`));
      assert.ok(cli.calls.some((c) => c.cmd === "/usr/bin/open" && c.args[0] === "/Applications/Ghostty.app"),
        "the raise is not suppressed the way Orca's is");
      assert.ok(logs.some((l) => l.includes(`herdrPane=`) && !l.includes("herdrPane=-")), JSON.stringify(logs));
    });
  });
});
