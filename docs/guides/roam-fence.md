# Roam Fence — limit where free roam wanders

When Free Roam is on, the pet periodically walks to a random spot on the
screen. The roam fence keeps those walks inside a rectangle you choose — for
example the bottom-right quarter of the screen, or a strip above the dock.

## Choose an area in Settings

Open **Settings → General → Behavior & position → Free roam**, expand the
section, then choose **Activity area → Choose area…**. Clawd opens an overlay
on the display where the pet currently sits. Drag a rectangle and confirm it;
the change applies without restarting Clawd.

The picker verifies that the entire pet window fits inside the selected
rectangle on the current display. On a multi-display setup, Clawd stores the
rectangle as proportions and applies the same proportions to each display's
work area. Display shapes and proportional pet scaling can differ, so a very
narrow area that works on one display may pause roaming on another until the
pet or area is resized. Choose **Remove custom area** to remove the limit.

Settings and external tools share the file below. The Settings UI is the
normal user workflow; direct file editing remains available for automation.

## The file

Create `~/.clawd/roam-area.json`:

```json
{
  "enabled": true,
  "left": 0.5,
  "top": 0.5,
  "right": 1.0,
  "bottom": 1.0
}
```

That example confines roaming to the bottom-right quarter of the work area.

| Field | Meaning |
| --- | --- |
| `enabled` | Must be exactly `true` or `false` (a real JSON boolean). `false` disables the fence without deleting the file. |
| `left`, `top`, `right`, `bottom` | Fractions of the work area (`0` = left/top edge, `1` = right/bottom edge). Each is optional; a missing edge defaults to the full range. |

Rules: every present edge must be a finite number with
`0 <= left < right <= 1` and `0 <= top < bottom <= 1`. Strings (`"0.5"`),
reversed intervals, and out-of-range values make the file invalid.

Containment is whole-window: the entire pet must fit inside the rectangle.
A corridor exactly the pet's size is fine (the pet then only moves along the
other axis), but a fence narrower or shorter than the pet in either dimension
has no valid position at all — roaming stops entirely until the fence is
enlarged, disabled, or removed. A fence that only barely exceeds the pet can
also remain still because roam ignores tiny, jitter-like hops. Fences placed
against a screen edge work: on an axis it actually narrows, an explicit fence
takes precedence over the default keep-away-from-the-edges margin when they
conflict. A full-range axis does not override an already-impossible normal
margin band during ordinary roaming; if the pet is currently outside an active
fence, recovery temporarily uses the fence's own containment range instead.

Delete the file (or set `"enabled": false`) to return to the normal default
roam behavior, including its keep-away-from-the-edges margin. Settings uses
the explicit `enabled: false` form so the change can be confirmed in one
refresh.

## When changes apply

The file is re-read in the background when each walk's pause is armed. Because
that read is asynchronous, a save around or after arming may affect the pending
walk if the in-flight read observes it; otherwise the cached fence remains and
a later scheduled refresh retries. There is no fixed wall-clock guarantee. No
restart needed.

## Failure behavior (by design, the fence never "falls open")

- A malformed or half-saved file keeps the **previous** fence until a valid
  save lands, and logs one deduplicated warning.
- Deleting the file counts only after it stays gone for two consecutive
  checks, so atomic replace-style saves can't flash the fence off.
- Until the loader has confirmed a first status (valid file, or confirmed
  missing), roam holds its rounds instead of wandering the full area.
- If the pet starts outside the fence on one axis, its next walk brings that
  axis back inside. In axis-constrained mode, if both axes are outside, it
  recovers over two walks — one axis per walk — so every step still moves
  along a single axis.
