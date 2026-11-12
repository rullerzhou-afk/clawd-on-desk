"use strict";

// ── Linux / Wayland: native Wayland is the default; XWayland is opt-in ──
//
// Historically (issue #441) this resolver force-relaunched the app under
// XWayland (--ozone-platform=x11) on any Wayland session with a DISPLAY,
// because native Wayland blocks the two things the pet needs: client-side
// window positioning and global cursor queries.
//
// That limitation is now handled natively: src/linux-wayland.js +
// src/linux-wayland-shim.js restore placement, click-through, all-workspace
// pinning, focus control and cursor tracking through the compositor's
// privileged IPC (full support on Hyprland; graceful no-op degradation
// elsewhere). So the auto-detection below no longer forces x11 — an
// out-of-the-box launch stays on Chromium's native-Wayland default
// (--ozone-platform-hint=auto since Electron 38).
//
// XWayland remains available as an explicit opt-in for compositors where the
// native path degrades too far:
//   • CLAWD_OZONE_PLATFORM=x11 → planXWaylandRelaunch below relaunches the
//     process with --ozone-platform=x11 on argv (the backend cannot be
//     switched from JS: Electron picks Ozone in C++ before the main script
//     runs).
//   • --ozone-platform=… on the real argv → honored as-is, never relaunched
//     over.
//
// Effective precedence (planXWaylandRelaunch checks argv itself, BEFORE
// calling this resolver, so it always passes userOzonePlatform=null):
//   • An explicit --ozone-platform you pass yourself → always honored as-is.
//   • Else CLAWD_OZONE_PLATFORM governs:
//        x11            → relaunch into XWayland
//        wayland / auto → stay on the native-Wayland default
//   • Else → null: leave Chromium's own default (native Wayland on a
//     Wayland session, X11 on an X session).
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

  // 3. No override, no user switch → leave Chromium's default alone. Native
  //    Wayland runs as a first-class backend (src/linux-wayland*.js); the
  //    #441 auto-relaunch into XWayland is gone.
  return null;
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

// Decide whether THIS Linux process must relaunch itself under XWayland, and
// with what argv. Since native Wayland became a first-class backend
// (src/linux-wayland*.js), this only ever fires for the explicit
// CLAWD_OZONE_PLATFORM=x11 opt-in — never from auto-detection.
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
