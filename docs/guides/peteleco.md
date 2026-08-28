# Peteleco — flick the pet across the desk

Peteleco is a billiards-style gesture: hold a modifier, press on the pet, and
pull **away** from where you want it to go. The pet holds still while you aim —
it is the cue ball, not the cue — and a projection shows exactly where the shot
will land. Release, and the pet flies there.

The feature is **off by default**, and while it is off the modifier drag keeps
its old behavior (an ordinary drag).

## Turn it on

**Settings → General → Behavior & position → Flick**.

"Peteleco" is the internal name — module files, pref keys, this document. In the
UI the feature is localized: **Flick** (en), **Peteleco** (pt-BR), **Papirotazo**
(es), **弹指** / **彈指** (zh / zh-TW), **튕기기** (ko), **デコピン** (ja).

The **Flick intensity** slider only appears while the feature is on — it has no
meaning otherwise.

## The gesture

| Platform | Modifier |
| --- | --- |
| Windows / Linux | `Ctrl` + drag |
| macOS | `Option` + drag |

macOS uses Option because `Ctrl`-click is the system right-click gesture there:
Chromium synthesizes a context menu from it, which would pop a menu over the
projection. `Cmd`-click is already the Dashboard shortcut, so Option is the free
modifier.

A modifier **click** that never moves is still a plain modifier click — on
Windows and Linux, `Ctrl`-click keeps opening the Dashboard. Only an actual pull
(more than a few pixels) is treated as a shot.

While aiming:

- the cursor becomes a crosshair,
- the pet does not follow the mouse,
- free roam stands down,
- releasing the mouse launches the pet; losing the window, pressing Escape's
  equivalent (any capture loss) or switching the feature off cancels it with the
  pet untouched.

The projection is a single white dashed line — no landing ring, no arrowhead.
The far end of the line **is** the landing spot. It starts clear of the sprite
so it does not cover the character, and it is drawn from the avatar's own
middle rather than the window's: the pet window is a rectangle sized for the
widest pose a theme has, and clawd's art sits about 16% of the window height
below the window's centre. On release the line stays up and dissolves over the
launch instead of popping out at mouse-up; a cancelled aim clears it at once.

## Intensity

Intensity (1–100) caps how far a single flick can travel — roughly 60 px at the
minimum and 520 px at the maximum. Pulling the cursor further than the cap
allows does not throw the pet further; it just means "full power". That cap is
also what keeps the projection short: the line drawn on screen is always the
real trajectory, never a promise the shot cannot keep.

The shot itself is deliberately unhurried — it leaves fast and spends the back
half of the animation bleeding off the last few pixels, so the pet settles
rather than stops.

Two consequences worth knowing:

- The projection **shortens** when the pet is aimed at the edge of the work
  area, because the landing spot is clamped exactly the way a drag would be. A
  pet already pinned against that edge draws no projection at all.
- A hard flick **can carry the pet onto another monitor**. The landing spot is
  clamped exactly the way a drag is — from the target's own position — so the
  shot reaches wherever a drag could, seams included. The projection window
  stretches to contain both ends so the line stays drawn across the crossing.
  The one exception is a neighbour whose display scaling differs from the launch
  monitor's: a single window renders its pixels at one scale factor, so the far
  half of the line would land in the wrong place. On such a desk the line is
  clipped at the seam while the pet still crosses.
- A flick can land the pet on an edge, but it never snaps it into mini mode.
  Shots routinely end up exactly on an edge, so snapping there would turn most
  hard flicks into an accidental mini mode. Drag the pet to an edge as usual if
  that is what you want.

Peteleco is unavailable in mini mode.

## Where it lives in the code

| File | Role |
| --- | --- |
| `src/peteleco-geometry.js` | All the math: pull → direction, intensity → reach, landing spot, easing. Pure, no Electron. |
| `src/peteleco.js` | Main-process runtime: aim lifecycle and the launch animation. |
| `src/peteleco-overlay-window.js` | The transparent, click-through window the projection is drawn in. |
| `src/peteleco-overlay.html` / `-renderer.js` | The projection itself — a pure view, it decides nothing. |
| `src/hit-renderer.js` | Gesture detection (which modifier, when it is a shot vs a click). |
| `src/pet-geometry-main.js` | `getPetVisualCenter` — where the avatar's middle is, from the theme's own `layout.centerX` / `contentBox` (the same declaration the accessory frames use). |

The geometry module is shared between the runtime and the overlay on purpose:
the line you see and the position the pet flies to are computed once, so they
cannot disagree.
