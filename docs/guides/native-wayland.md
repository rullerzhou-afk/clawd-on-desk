# Native Wayland backend

Original work by xingguangcuican6666.

Clawd on Desk runs as a **native Wayland client** by default. Before this
backend existed, a Wayland session forced an automatic relaunch under XWayland
(issue #441) because Wayland gives an ordinary application no way to place its
own windows, query the global cursor, or let clicks pass through its
transparent areas. Those three limitations are now solved through the
compositor's privileged IPC on **Hyprland**; other compositors still run
natively, with the modern-Wayland behaviour (the compositor places the pet and
clicks land on its window).

## Entry points

| Module | Role |
| --- | --- |
| `src/linux-ozone.js` | Decides the Ozone platform. Native Wayland is the default; `CLAWD_OZONE_PLATFORM=x11` (or an explicit `--ozone-platform=x11`) relaunches into XWayland. |
| `src/linux-wayland.js` | Hyprland backend: synchronous IPC client (`query`, `clients`, `activeWindow`, `cursorPoint`, `moveWindow`, `focusWindow`, `focusLastWindow`, `setWindowPin`, `raiseWindow`, `moveCursor`, `defineWindowRule`, `setWindowRuleEnabled`) plus the `screen.getCursorScreenPoint()` replacement. |
| `src/linux-wayland-shim.js` | Patches `BaseWindow.prototype` once so every window gets the documented Electron contract back: geometry truth, rule-driven placement, verified maps, click-through, focus, pinning. |
| `src/pet-window-runtime.js`, `src/menu.js` | Call the shim instead of the X11-only entry points (`setVisibleOnAllWorkspaces`, `setIgnoreMouseEvents`, `setShape`) and skip the X11 reconcile loops that cannot converge on Wayland. |

Everything is wired from the `_linuxWayland` bootstrap in `src/main.js` and
degrades to no-ops when there is no Hyprland socket (non-Hyprland compositors).

## Measured Electron-41-on-Wayland behaviour (design inputs)

All of the following were measured on Electron 41 / Hyprland 0.57 and drive the
shim's design:

- `getBounds()`/`getPosition()`/`getContentBounds()` return `x=0, y=0` once a
  window is mapped; `setBounds()`/`setPosition()` update the native size but the
  position never reaches the compositor.
- `setSize()` resizes around the window centre, so the top-left drifts.
- A hide→show remap frequently never maps at all; `isVisible()` still reports
  true. `j/clients` (which only lists mapped windows) is the ground truth.
- `show()`/`focus()` cannot activate a toplevel; only the compositor can.
- `setIgnoreMouseEvents()` and `setShape()` are no-ops; click-through needs a
  `no_focus` window rule, toggled live through the rule's `enabled` flag.
- `setVisibleOnAllWorkspaces()` is a no-op; the equivalent is the `pin` rule
  effect (plus a `pin` dispatcher for an already-mapped window).
- The context menu opens fine from a native-Wayland `BrowserWindow` owner, but
  the owner must be the active toplevel or the menu closes immediately, and the
  menu anchors on the owner's rect — so the owner must be moved by the
  compositor before the pop.
- Hyprland's IPC socket broadcasts every client's command to every listener, so
  a read can return another client's reply. JSON queries validate and retry.
- Window rules match `initialTitle`, which is frozen at map time. The shim
  keeps a zero-width marker in the title and re-asserts it immediately before
  every native show.

## Window identity

Each adopted window gets an invisible title prefix (`Clawd` + zero-width bits
encoding pid and window id). Rules match `initial_title = "^<marker>.*"`.
`getTitle()` strips the marker, `setTitle()` composes it, and
`page-title-updated` is prevented on the WINDOW object (Electron only skips its
own `SetTitle` when the window-level emit is defaultPrevented).

A window that was already visible when it was adopted mapped under the
constructor title, and `initialTitle` never changes for that toplevel. Those are
recognised through `j/clients` by pid and claimed once, and — only for titles
Electron itself gives our windows (`Electron`, empty) — also get a
constructor-title placement rule.

## Testing

- `test/linux-wayland.test.js` — backend, marker encoding, Lua payloads.
- `test/linux-wayland-shim.test.js` — shim against a fake compositor that
  mirrors the measured behaviour above.
- `test/pet-window-runtime.test.js` — the "native Wayland gating" suite.
- `ci/wayland-smoke.sh` — packaged contracts (see `.github/workflows/wayland-smoke.yml`).
