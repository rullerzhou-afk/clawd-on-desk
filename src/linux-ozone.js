"use strict";

// ── Linux / Wayland: default to XWayland (issue #441) ──
//
// Native Wayland forbids two things this desktop pet depends on:
//   1. Client-side window positioning — the BrowserWindow x/y and later
//      setBounds() calls are ignored by the compositor, so the pet spawns
//      centered and can't be dragged by following the cursor.
//   2. Global cursor queries — screen.getCursorScreenPoint() is unsupported,
//      so there is no mouse tracking.
//
// Forcing XWayland (--ozone-platform=x11) restores window positioning (drag
// works again), matching the workaround reporters find by hand. Cursor
// tracking stays limited to X11 surfaces: an ordinary client cannot see the
// pointer over native Wayland windows. KDE Plasma 6 is the exception for eye
// follow, via a KWin script (src/linux-kwin-cursor.js, #1410); elsewhere that
// needs a real X11 session (Xorg login).
//
// Since Electron 38 / Chromium 140 the default is --ozone-platform-hint=auto, so
// an out-of-the-box app runs as a NATIVE WAYLAND client on a Wayland session —
// exactly the broken state above. The backend can't be switched from JS (Electron
// picks Ozone in C++ before the main script runs), so planXWaylandRelaunch below
// relaunches the process with --ozone-platform=x11 on argv. This resolver only
// decides the DESIRED backend ("x11" | "wayland" | null=leave default).
//
// Effective precedence (planXWaylandRelaunch checks argv itself, BEFORE calling
// this resolver, so it always passes userOzonePlatform=null):
//   • An explicit --ozone-platform you pass yourself → always honored as-is
//     (Chromium reads it directly; we never relaunch over it).
//   • Else CLAWD_OZONE_PLATFORM governs the automatic relaunch:
//        x11            → relaunch into XWayland
//        wayland / auto → stay on the native-Wayland default
//   • Else auto-detect: x11 when on a Wayland session AND an X server (DISPLAY)
//     is present for XWayland.
//
// The DISPLAY guard matters: forcing x11 with no reachable X server makes the
// Chromium X11 Ozone backend abort at platform init with a native fatal/CHECK
// ("Missing X server or $DISPLAY") — not a catchable JS exception, and it
// happens before app.whenReady. DISPLAY only proves the variable is set, not
// that the server is reachable, but it is the cheap signal that keeps us from
// turning "pet can't drag" into "app won't launch" on a Wayland-only box; the
// CLAWD_OZONE_PLATFORM escape hatch covers the rest.
//
// `userOzonePlatform` is the value the user put on argv for --ozone-platform
// (or null/empty), passed in by the caller so this stays a pure, testable
// function. Returns the value the app should run with ("x11" | "wayland"), or
// null to leave the command line untouched.
function resolveLinuxOzonePlatform(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") return null;

  const env = options.env || process.env;

  // 1. Explicit env override wins over everything (including a user argv
  //    switch — the caller removes/replaces the command-line switch to match).
  const override = String(env.CLAWD_OZONE_PLATFORM || "").trim().toLowerCase();
  if (override === "x11") return "x11";
  if (override === "wayland") return "wayland";
  if (override === "auto") return null;

  // 2. No env override → respect an explicit --ozone-platform the user passed
  //    on the real command line.
  const user = String(options.userOzonePlatform || "").trim().toLowerCase();
  if (user) return null;

  // 3. Auto-detect: force XWayland on a Wayland session when XWayland is
  //    actually reachable (DISPLAY present).
  const sessionType = String(env.XDG_SESSION_TYPE || "").trim().toLowerCase();
  const underWayland = sessionType === "wayland" || !!String(env.WAYLAND_DISPLAY || "").trim();
  const xwaylandAvailable = !!String(env.DISPLAY || "").trim();

  return underWayland && xwaylandAvailable ? "x11" : null;
}

// Parse the user's explicit --ozone-platform from the REAL process argv.
//
// We deliberately read argv rather than Electron's app.commandLine: since
// Chromium 140 the browser materializes its OWN resolved default onto the
// command line (it appends --ozone-platform=wayland on a Wayland session), so
// app.commandLine.hasSwitch("ozone-platform") cannot tell "the user asked for
// wayland" apart from "Chromium defaulted to wayland" — and mistaking the
// latter for the former is exactly what suppressed the v1 fix. process.argv
// only ever contains what the launcher/user actually passed.
//
// Accepts Chromium's canonical --ozone-platform=VALUE and the space-separated
// --ozone-platform VALUE form; stops at the "--" end-of-flags marker. Returns
// the raw (trimmed) value if the flag is present, else null.
function parseOzonePlatformFromArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const FLAG = "--ozone-platform";
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] == null ? "" : args[i]);
    if (a === "--") break;
    if (a === FLAG) {
      const next = String(args[i + 1] == null ? "" : args[i + 1]);
      // Only treat the next token as the value if it isn't itself a flag.
      return next.startsWith("-") ? "" : next.trim();
    }
    if (a.startsWith(FLAG + "=")) {
      return a.slice(FLAG.length + 1).trim();
    }
  }
  return null;
}

// Decide whether THIS Linux process must relaunch itself under XWayland to make
// the pet draggable (issue #441), and with what argv.
//
// Why relaunch instead of app.commandLine.appendSwitch: Electron selects AND
// instantiates the Ozone backend in C++ PreEarlyInitialization
// (ui::SetOzonePlatformForLinuxIfNeeded + ui::OzonePlatform::PreEarlyInitialization)
// BEFORE the main script runs (PostEarlyInitialization → JoinAppCode), so
// flipping --ozone-platform from JS is too late for this process. But
// SetOzonePlatformForLinuxIfNeeded HONORS a --ozone-platform already present on
// the command line, so a second process launched with --ozone-platform=x11 on
// its real argv boots straight into XWayland.
//
// Returns null when no relaunch is needed/safe, or { args } — the replacement's
// argv after argv[0], carrying --ozone-platform=x11. The caller hands it to
// child_process.spawn, NOT app.relaunch: under AppImage the relauncher helper
// runs from the FUSE mount and waits for this process to die, but our death
// also takes down the AppImage runtime (the FUSE daemon), so the helper loses
// its code pages and dies before launching anything. Three loop guards:
// (a) an --ozone-platform already on argv — the PRIMARY guard, since the
// relaunched process always carries the flag, and it is checked before resolve()
// so even CLAWD_OZONE_PLATFORM=x11 can't spin; (b) the CLAWD_OZONE_RELAUNCHED
// sentinel — a backstop for the rare case where the spawn args fail to
// round-trip; (c) the resolved target (only x11 relaunches; Wayland is default).
function planXWaylandRelaunch(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const argv = Array.isArray(options.argv) ? options.argv : [];

  // Guard 1: already relaunched once → never loop.
  if (String(env.CLAWD_OZONE_RELAUNCHED || "").trim() === "1") return null;

  // Guard 2: an explicit --ozone-platform already on the real argv (the
  // relaunched process, or a deliberate user/packager choice) → honor it.
  if (parseOzonePlatformFromArgv(argv) !== null) return null;

  // Guard 3: only XWayland needs a relaunch; native Wayland is already default.
  const target = resolveLinuxOzonePlatform({ platform, env, userOzonePlatform: null });
  if (target !== "x11") return null;

  // Build the child argv: keep the user's args and add --ozone-platform=x11 as a
  // real switch. It MUST go BEFORE any "--" end-of-flags marker, otherwise
  // Chromium treats it as a positional and ignores it. Everything from "--" on is
  // preserved verbatim (those are app args, not switches we should touch).
  const rest = argv.slice(1).map((a) => String(a == null ? "" : a));
  const isOzone = (a) => /^--ozone-platform(=|$)/.test(a);
  const FLAG = "--ozone-platform=x11";
  const dd = rest.indexOf("--");
  const args =
    dd === -1
      ? rest.filter((a) => !isOzone(a)).concat(FLAG)
      : rest.slice(0, dd).filter((a) => !isOzone(a)).concat(FLAG, rest.slice(dd));
  return { args };
}

module.exports = {
  resolveLinuxOzonePlatform,
  parseOzonePlatformFromArgv,
  planXWaylandRelaunch,
};
