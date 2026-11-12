// test/linux-ozone.test.js — Unit tests for src/linux-ozone.js
// Native Wayland is the default backend; XWayland is an explicit opt-in
// (CLAWD_OZONE_PLATFORM=x11) that relaunches the process with the flag.
const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  resolveLinuxOzonePlatform,
  parseOzonePlatformFromArgv,
  planXWaylandRelaunch,
} = require("../src/linux-ozone");

// resolve(platform, env, userOzonePlatform)
const resolve = (platform, env, user) =>
  resolveLinuxOzonePlatform({ platform, env, userOzonePlatform: user });

describe("resolveLinuxOzonePlatform()", () => {
  it("returns null on non-Linux platforms regardless of env", () => {
    const waylandEnv = { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" };
    assert.strictEqual(resolve("darwin", waylandEnv), null);
    assert.strictEqual(resolve("win32", waylandEnv), null);
  });

  describe("explicit CLAWD_OZONE_PLATFORM override (highest priority)", () => {
    it("=x11 forces XWayland", () => {
      assert.strictEqual(resolve("linux", { CLAWD_OZONE_PLATFORM: "x11" }), "x11");
    });

    it("=x11 wins even with no DISPLAY (user asked for it explicitly)", () => {
      assert.strictEqual(
        resolve("linux", { CLAWD_OZONE_PLATFORM: "x11", XDG_SESSION_TYPE: "wayland" }),
        "x11"
      );
    });

    it("=wayland forces native Wayland", () => {
      assert.strictEqual(resolve("linux", { CLAWD_OZONE_PLATFORM: "wayland" }), "wayland");
    });

    it("=wayland overrides a differing --ozone-platform the user passed on argv", () => {
      assert.strictEqual(
        resolve("linux", { CLAWD_OZONE_PLATFORM: "wayland", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, "x11"),
        "wayland"
      );
    });

    it("=auto leaves things untouched, even with a user argv switch", () => {
      assert.strictEqual(
        resolve("linux", { CLAWD_OZONE_PLATFORM: "auto", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }),
        null
      );
      // auto must NOT erase a user's explicit argv choice
      assert.strictEqual(resolve("linux", { CLAWD_OZONE_PLATFORM: "auto" }, "wayland"), null);
    });

    it("is case-insensitive and trims surrounding whitespace", () => {
      assert.strictEqual(resolve("linux", { CLAWD_OZONE_PLATFORM: "  X11 " }), "x11");
      assert.strictEqual(resolve("linux", { CLAWD_OZONE_PLATFORM: " WAYLAND " }), "wayland");
    });

    it("ignores an unrecognized override value and falls back to the default", () => {
      // No auto-relaunch anymore: an unrecognized value means "no opinion",
      // which leaves Chromium's native-Wayland default alone.
      assert.strictEqual(
        resolve("linux", { CLAWD_OZONE_PLATFORM: "garbage", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }),
        null
      );
    });
  });

  describe("explicit user --ozone-platform on argv (no env override)", () => {
    it("is respected — never relaunched over", () => {
      assert.strictEqual(
        resolve("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, "wayland"),
        null
      );
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, "x11"), null);
    });

    it("blank/whitespace user value is treated as absent → default (null)", () => {
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, "  "), null);
    });
  });

  describe("auto-detection (no override, no user switch)", () => {
    it("stays on native Wayland on a Wayland session, even with DISPLAY present", () => {
      // The historical #441 auto-relaunch into XWayland is gone: native
      // Wayland is a first-class backend now (src/linux-wayland*.js).
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }), null);
    });

    it("detects Wayland via WAYLAND_DISPLAY when XDG_SESSION_TYPE is unset", () => {
      assert.strictEqual(resolve("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }), null);
    });

    it("does NOT force x11 on Wayland when no DISPLAY", () => {
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "wayland" }), null);
      assert.strictEqual(resolve("linux", { WAYLAND_DISPLAY: "wayland-0" }), null);
    });

    it("treats whitespace-only DISPLAY / WAYLAND_DISPLAY as absent", () => {
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: "   " }), null);
      assert.strictEqual(resolve("linux", { WAYLAND_DISPLAY: "  ", DISPLAY: ":0" }), null);
    });

    it("leaves a native X11 session alone (already positionable)", () => {
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), null);
    });

    it("returns null when there are no Wayland signals at all", () => {
      assert.strictEqual(resolve("linux", {}), null);
      assert.strictEqual(resolve("linux", { DISPLAY: ":0" }), null);
    });
  });

  it("respects a user --ozone-platform parsed from a real argv array", () => {
    const env = { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" };
    // user explicitly asked for wayland → nothing to do
    const user = parseOzonePlatformFromArgv(["/app/Clawd", "--ozone-platform=wayland"]);
    assert.strictEqual(resolve("linux", env, user), null);
    // no user switch → default is native Wayland (null), NOT a forced x11
    const none = parseOzonePlatformFromArgv(["/app/Clawd", "--some-other-flag"]);
    assert.strictEqual(resolve("linux", env, none), null);
  });
});

describe("parseOzonePlatformFromArgv()", () => {
  it("reads the canonical --ozone-platform=VALUE form", () => {
    assert.strictEqual(parseOzonePlatformFromArgv(["/app", "--ozone-platform=x11"]), "x11");
    assert.strictEqual(parseOzonePlatformFromArgv(["/app", "--ozone-platform=wayland"]), "wayland");
  });

  it("reads the space-separated --ozone-platform VALUE form", () => {
    assert.strictEqual(parseOzonePlatformFromArgv(["/app", "--ozone-platform", "x11"]), "x11");
  });

  it("returns null when the flag is absent", () => {
    assert.strictEqual(parseOzonePlatformFromArgv(["/app", "--foo", "bar"]), null);
    assert.strictEqual(parseOzonePlatformFromArgv([]), null);
    assert.strictEqual(parseOzonePlatformFromArgv(undefined), null);
    assert.strictEqual(parseOzonePlatformFromArgv(null), null);
  });

  it("stops scanning at the -- end-of-flags marker", () => {
    assert.strictEqual(parseOzonePlatformFromArgv(["/app", "--", "--ozone-platform=x11"]), null);
  });

  it("does not consume a following flag as the value (space form)", () => {
    assert.strictEqual(parseOzonePlatformFromArgv(["/app", "--ozone-platform", "--other"]), "");
  });

  it("trims surrounding whitespace in the value", () => {
    assert.strictEqual(parseOzonePlatformFromArgv(["/app", "--ozone-platform= x11 "]), "x11");
  });

  it("returns empty string for the flag with no value (treated as absent by resolve)", () => {
    assert.strictEqual(parseOzonePlatformFromArgv(["/app", "--ozone-platform="]), "");
    assert.strictEqual(parseOzonePlatformFromArgv(["/app", "--ozone-platform"]), "");
  });

  it("returns the FIRST occurrence when the flag is repeated", () => {
    assert.strictEqual(
      parseOzonePlatformFromArgv(["/app", "--ozone-platform=x11", "--ozone-platform=wayland"]),
      "x11"
    );
  });
});

describe("planXWaylandRelaunch()", () => {
  const ARGV0 = "/opt/Clawd/clawd"; // process.argv[0]
  const plan = (platform, env, argv) => planXWaylandRelaunch({ platform, env, argv });

  it("relaunches with --ozone-platform=x11 when CLAWD_OZONE_PLATFORM=x11", () => {
    assert.deepStrictEqual(
      plan("linux", { CLAWD_OZONE_PLATFORM: "x11", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, [ARGV0]),
      { args: ["--ozone-platform=x11"] }
    );
  });

  it("does NOT relaunch on a plain Wayland session (native Wayland is default)", () => {
    assert.strictEqual(
      plan("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, [ARGV0]),
      null
    );
    assert.strictEqual(
      plan("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, [ARGV0]),
      null
    );
  });

  it("preserves passthrough args and appends our flag last", () => {
    assert.deepStrictEqual(
      plan("linux", { CLAWD_OZONE_PLATFORM: "x11" }, [ARGV0, "--foo", "bar"]),
      { args: ["--foo", "bar", "--ozone-platform=x11"] }
    );
  });

  it("inserts the flag BEFORE a -- marker and preserves app args after it", () => {
    assert.deepStrictEqual(
      plan("linux", { CLAWD_OZONE_PLATFORM: "x11" },
        [ARGV0, "--enable-foo", "--", "positional", "--ozone-platform=appdoc"]),
      { args: ["--enable-foo", "--ozone-platform=x11", "--", "positional", "--ozone-platform=appdoc"] }
    );
  });

  it("inserts the flag before -- even when -- leads the passthrough", () => {
    assert.deepStrictEqual(
      plan("linux", { CLAWD_OZONE_PLATFORM: "x11" }, [ARGV0, "--", "doc"]),
      { args: ["--ozone-platform=x11", "--", "doc"] }
    );
  });

  it("relaunches when CLAWD_OZONE_PLATFORM=x11, even off a Wayland session", () => {
    assert.deepStrictEqual(
      plan("linux", { CLAWD_OZONE_PLATFORM: "x11" }, [ARGV0]),
      { args: ["--ozone-platform=x11"] }
    );
  });

  // ── loop guards ──
  it("guard 1: does NOT relaunch once CLAWD_OZONE_RELAUNCHED=1 is set", () => {
    assert.strictEqual(
      plan("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0", CLAWD_OZONE_RELAUNCHED: "1" }, [ARGV0]),
      null
    );
    // backstop: even CLAWD_OZONE_PLATFORM=x11 can't loop once the sentinel is set
    assert.strictEqual(
      plan("linux", { CLAWD_OZONE_PLATFORM: "x11", CLAWD_OZONE_RELAUNCHED: "1" }, [ARGV0]),
      null
    );
  });

  it("guard 2: does NOT relaunch when --ozone-platform is already on argv", () => {
    assert.strictEqual(
      plan("linux", { CLAWD_OZONE_PLATFORM: "x11", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" },
        [ARGV0, "--ozone-platform=x11"]),
      null
    );
  });

  it("guard 3: does NOT relaunch when XWayland is not the target", () => {
    // native X11 session — already positionable
    assert.strictEqual(plan("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, [ARGV0]), null);
    // plain Wayland session — native Wayland is the default now
    assert.strictEqual(plan("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, [ARGV0]), null);
    // CLAWD_OZONE_PLATFORM=wayland — native Wayland is already the default
    assert.strictEqual(
      plan("linux", { CLAWD_OZONE_PLATFORM: "wayland", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, [ARGV0]),
      null
    );
  });

  it("honors a user's explicit --ozone-platform=wayland (no relaunch)", () => {
    assert.strictEqual(
      plan("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, [ARGV0, "--ozone-platform=wayland"]),
      null
    );
  });

  it("does NOT relaunch on non-Linux platforms", () => {
    const env = { CLAWD_OZONE_PLATFORM: "x11", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" };
    assert.strictEqual(plan("darwin", env, [ARGV0]), null);
    assert.strictEqual(plan("win32", env, [ARGV0]), null);
  });
});
