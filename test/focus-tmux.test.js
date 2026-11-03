// test/focus-tmux.test.js — Mocked unit tests for scheduleTmuxPaneFocus().
//
// The reviewer flagged that focus-cmux's "no ps -o comm= on non-macOS" check
// was a brittle proxy for "no tmux work happened." We now exercise the tmux
// helper directly through __test.__setTmuxBin so a host with or without tmux
// installed produces the same behavior in CI.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { loadFocusWithMock } = require("./helpers/load-focus-with-mock");

function makeMock(handlers) {
  const calls = [];
  function mock(cmd, args, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    calls.push({ cmd, args: [...args] });
    const handler = handlers[cmd];
    if (handler) {
      handler(args, cb);
      return;
    }
    if (cb) cb(null, "", "");
  }
  return { calls, mock };
}

describe("scheduleTmuxPaneFocus", () => {
  it("issues switch-client + select-window + select-pane when chain crosses tmux", (t, done) => {
    const { calls, mock } = makeMock({
      ps: (args, cb) => {
        if (args.join(" ").includes("pid=,comm=")) {
          cb(null, "100 zsh\n200 tmux\n300 alacritty\n", "");
          return;
        }
        cb(null, "", "");
      },
      "/usr/bin/tmux": (args, cb) => {
        if (args.includes("list-panes")) {
          cb(null, "100 @3 %7 work\n", "");
          return;
        }
        cb(null, "", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const focusInstance = initFocus({});
    focusInstance.__test.__setTmuxBin("/usr/bin/tmux");
    focusInstance.__test.scheduleTmuxPaneFocus([100, 200, 300], "/tmp/tmux-1000/default", "/dev/pts/7");

    setTimeout(() => {
      cleanup();
      const tmuxCalls = calls.filter(c => c.cmd === "/usr/bin/tmux");
      const switchClient = tmuxCalls.find(c => c.args.includes("switch-client"));
      const selectWindow = tmuxCalls.find(c => c.args.includes("select-window"));
      const selectPane = tmuxCalls.find(c => c.args.includes("select-pane"));
      assert.ok(switchClient, "switch-client should run");
      assert.deepStrictEqual(switchClient.args.slice(0, 2), ["-S", "/tmp/tmux-1000/default"], "switch-client uses full socket path");
      assert.ok(switchClient.args.includes("-c"), "switch-client should specify target client");
      assert.ok(switchClient.args.includes("/dev/pts/7"), "switch-client -c client tty");
      assert.ok(switchClient.args.includes("work"), "switch-client -t work");
      assert.ok(selectWindow, "select-window should run");
      assert.ok(selectWindow.args.includes("@3"), "select-window -t @3");
      assert.ok(selectPane, "select-pane should run");
      assert.ok(selectPane.args.includes("%7"), "select-pane -t %7");
      done();
    }, 700);
  });

  it("Linux tmux server title: issues switch-client + select-window + select-pane", (t, done) => {
    const { calls, mock } = makeMock({
      ps: (args, cb) => {
        if (args.join(" ").includes("pid=,comm=")) {
          cb(null, "100 zsh\n200 tmux: server\n300 alacritty\n", "");
          return;
        }
        cb(null, "", "");
      },
      "/usr/bin/tmux": (args, cb) => {
        if (args.includes("list-panes")) {
          cb(null, "100 @3 %7 work\n", "");
          return;
        }
        cb(null, "", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const focusInstance = initFocus({});
    focusInstance.__test.__setTmuxBin("/usr/bin/tmux");
    focusInstance.__test.scheduleTmuxPaneFocus([100, 200, 300], "/tmp/tmux-1000/default", "/dev/pts/7");

    setTimeout(() => {
      cleanup();
      const tmuxCalls = calls.filter(c => c.cmd === "/usr/bin/tmux");
      const switchClient = tmuxCalls.find(c => c.args.includes("switch-client"));
      const selectWindow = tmuxCalls.find(c => c.args.includes("select-window"));
      const selectPane = tmuxCalls.find(c => c.args.includes("select-pane"));
      assert.ok(switchClient, "switch-client should run");
      assert.deepStrictEqual(switchClient.args.slice(0, 2), ["-S", "/tmp/tmux-1000/default"], "switch-client uses full socket path");
      assert.ok(switchClient.args.includes("-c"), "switch-client should specify target client");
      assert.ok(switchClient.args.includes("/dev/pts/7"), "switch-client -c client tty");
      assert.ok(switchClient.args.includes("work"), "switch-client -t work");
      assert.ok(selectWindow, "select-window should run");
      assert.ok(selectWindow.args.includes("@3"), "select-window -t @3");
      assert.ok(selectPane, "select-pane should run");
      assert.ok(selectPane.args.includes("%7"), "select-pane -t %7");
      done();
    }, 700);
  });

  it("macOS tmux path: issues switch-client + select-window + select-pane with an indented ps row", (t, done) => {
    const { calls, mock } = makeMock({
      ps: (args, cb) => {
        if (args.join(" ").includes("pid=,comm=")) {
          cb(null, "100 /bin/zsh\n  200 /opt/homebrew/bin/tmux\n300 alacritty\n", "");
          return;
        }
        cb(null, "", "");
      },
      "/opt/homebrew/bin/tmux": (args, cb) => {
        if (args.includes("list-panes")) {
          cb(null, "100 @3 %7 work\n", "");
          return;
        }
        cb(null, "", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "darwin" });
    const focusInstance = initFocus({});
    focusInstance.__test.__setTmuxBin("/opt/homebrew/bin/tmux");
    focusInstance.__test.scheduleTmuxPaneFocus([100, 200, 300], "/tmp/tmux-1000/default", "/dev/ttys007");

    setTimeout(() => {
      cleanup();
      const tmuxCalls = calls.filter(c => c.cmd === "/opt/homebrew/bin/tmux");
      const switchClient = tmuxCalls.find(c => c.args.includes("switch-client"));
      const selectWindow = tmuxCalls.find(c => c.args.includes("select-window"));
      const selectPane = tmuxCalls.find(c => c.args.includes("select-pane"));
      assert.ok(switchClient, "switch-client should run");
      assert.deepStrictEqual(switchClient.args.slice(0, 2), ["-S", "/tmp/tmux-1000/default"], "switch-client uses full socket path");
      assert.ok(switchClient.args.includes("-c"), "switch-client should specify target client");
      assert.ok(switchClient.args.includes("/dev/ttys007"), "switch-client -c client tty");
      assert.ok(switchClient.args.includes("work"), "switch-client -t work");
      assert.ok(selectWindow, "select-window should run");
      assert.ok(selectWindow.args.includes("@3"), "select-window -t @3");
      assert.ok(selectPane, "select-pane should run");
      assert.ok(selectPane.args.includes("%7"), "select-pane -t %7");
      done();
    }, 700);
  });

  it("does nothing when process names only contain tmux", (t, done) => {
    const { calls, mock } = makeMock({
      ps: (args, cb) => cb(null, "100 zsh\n200 tmuxinator\n300 not-tmux: x\n", ""),
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const focusInstance = initFocus({});
    focusInstance.__test.__setTmuxBin("/usr/bin/tmux");
    focusInstance.__test.scheduleTmuxPaneFocus([100, 200, 300]);

    setTimeout(() => {
      cleanup();
      const tmuxCalls = calls.filter(c => c.cmd === "/usr/bin/tmux");
      assert.strictEqual(tmuxCalls.length, 0, "No tmux CLI calls for tmuxinator or not-tmux: x");
      done();
    }, 700);
  });

  it("does nothing when ps reports no tmux processes in chain", (t, done) => {
    const { calls, mock } = makeMock({
      ps: (args, cb) => cb(null, "100 zsh\n200 bash\n", ""),
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const focusInstance = initFocus({});
    focusInstance.__test.__setTmuxBin("/usr/bin/tmux");
    focusInstance.__test.scheduleTmuxPaneFocus([100, 200]);

    setTimeout(() => {
      cleanup();
      const tmuxCalls = calls.filter(c => c.cmd === "/usr/bin/tmux");
      assert.strictEqual(tmuxCalls.length, 0, "No tmux CLI calls when chain has no tmux");
      done();
    }, 700);
  });

  it("does not select when no list-panes row matches the pane pid", (t, done) => {
    const { calls, mock } = makeMock({
      ps: (args, cb) => cb(null, "100 zsh\n200 tmux\n", ""),
      "/usr/bin/tmux": (args, cb) => {
        if (args.includes("list-panes")) {
          cb(null, "999 @1 %1 other\n", "");
          return;
        }
        cb(null, "", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const focusInstance = initFocus({});
    focusInstance.__test.__setTmuxBin("/usr/bin/tmux");
    focusInstance.__test.scheduleTmuxPaneFocus([100, 200]);

    setTimeout(() => {
      cleanup();
      const tmuxCalls = calls.filter(c => c.cmd === "/usr/bin/tmux");
      assert.ok(tmuxCalls.some(c => c.args.includes("list-panes")), "list-panes ran");
      assert.ok(!tmuxCalls.some(c => c.args.includes("select-window")), "no select-window");
      assert.ok(!tmuxCalls.some(c => c.args.includes("select-pane")), "no select-pane");
      assert.ok(!tmuxCalls.some(c => c.args.includes("switch-client")), "no switch-client");
      done();
    }, 700);
  });

  it("is a no-op when tmux binary is not resolved", (t, done) => {
    const { calls, mock } = makeMock({});
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const focusInstance = initFocus({});
    focusInstance.__test.__setTmuxBin("");
    focusInstance.__test.scheduleTmuxPaneFocus([100, 200]);

    setTimeout(() => {
      cleanup();
      assert.strictEqual(calls.length, 0, "No ps or tmux calls when bin missing");
      done();
    }, 700);
  });

  it("prepends -S <socket path> to every tmux invocation when a full socket path is given", (t, done) => {
    const { calls, mock } = makeMock({
      ps: (args, cb) => cb(null, "100 zsh\n200 tmux\n", ""),
      "/usr/bin/tmux": (args, cb) => {
        if (args.includes("list-panes")) {
          cb(null, "100 @1 %1 work\n", "");
          return;
        }
        cb(null, "", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const focusInstance = initFocus({});
    focusInstance.__test.__setTmuxBin("/usr/bin/tmux");
    focusInstance.__test.scheduleTmuxPaneFocus([100, 200], "/tmp/custom/work.sock");

    setTimeout(() => {
      cleanup();
      const tmuxCalls = calls.filter(c => c.cmd === "/usr/bin/tmux");
      assert.ok(tmuxCalls.length > 0, "tmux ran at least once");
      for (const c of tmuxCalls) {
        assert.strictEqual(c.args[0], "-S", "every tmux call leads with -S");
        assert.strictEqual(c.args[1], "/tmp/custom/work.sock", "socket path passed");
      }
      done();
    }, 700);
  });

  it("keeps legacy -L <socket-name> compatibility for old session metadata", (t, done) => {
    const { calls, mock } = makeMock({
      ps: (args, cb) => cb(null, "100 zsh\n200 tmux\n", ""),
      "/usr/bin/tmux": (args, cb) => {
        if (args.includes("list-panes")) {
          cb(null, "100 @1 %1 work\n", "");
          return;
        }
        cb(null, "", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const focusInstance = initFocus({});
    focusInstance.__test.__setTmuxBin("/usr/bin/tmux");
    focusInstance.__test.scheduleTmuxPaneFocus([100, 200], "work-socket");

    setTimeout(() => {
      cleanup();
      const tmuxCalls = calls.filter(c => c.cmd === "/usr/bin/tmux");
      assert.ok(tmuxCalls.length > 0, "tmux ran at least once");
      for (const c of tmuxCalls) {
        assert.strictEqual(c.args[0], "-L", "legacy socket names still use -L");
        assert.strictEqual(c.args[1], "work-socket", "socket name passed");
      }
      done();
    }, 700);
  });
});
