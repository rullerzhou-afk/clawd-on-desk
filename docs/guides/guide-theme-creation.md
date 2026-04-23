# Theme Creation Guide

Create your own Clawd desktop pet theme with custom characters and animations.

## Quick Start

1. Scaffold a theme:
   ```bash
   node scripts/create-theme.js my-theme
   ```
   The script writes to your Clawd user themes directory by default:
   - Windows: `%APPDATA%/clawd-on-desk/themes/my-theme/`
   - macOS: `~/Library/Application Support/clawd-on-desk/themes/my-theme/`
   - Linux: `~/.config/clawd-on-desk/themes/my-theme/`
   - No argument also works: it creates the next available `my-theme` scaffold automatically

2. (Optional) Customize the generated metadata:
   ```bash
   node scripts/create-theme.js pixel-cat --name "Pixel Cat" --author "Your Name"
   ```

3. Edit `theme.json` — set your theme name, author, and file mappings

4. Create your assets in the `assets/` folder

5. Restart Clawd → right-click → Theme → select your theme

6. (Optional) Validate:
   ```bash
   node scripts/validate-theme.js ~/.config/clawd-on-desk/themes/my-theme
   ```

If you prefer the manual route, copying `themes/template/` yourself still works. The scaffold script just automates the same starting point and patches `name` / `author` for you.

## Theme Directory Structure

```
my-theme/
  theme.json              ← Configuration (required)
  assets/
    idle-follow.svg       ← Idle animation with eye tracking (SVG required only if idle is in eyeTracking.states)
    thinking.gif          ← Any format: SVG, GIF, APNG, WebP, PNG, JPG, JPEG
    typing.gif
    error.gif
    happy.gif
    notification.gif
    sleeping.gif
    waking.gif
    ...                   ← Additional animations for reactions, tiers, etc.
```

## Creation Tiers

### Beginner: Swap Art + GIF Animations (Hours)

**Minimum viable theme depends on your capability switches.**

1. Start from `themes/template/`
2. Choose whether you want eye tracking:
   - `eyeTracking.enabled: true` → your `idle` asset must be SVG and include `#eyes-js`
   - `eyeTracking.enabled: false` → idle can also be GIF / APNG / WebP / PNG / JPG / JPEG
3. Create simple frame animations (4-12 frames) for other states using [Piskel](https://www.piskelapp.com/) (free, browser-based) or [Aseprite](https://www.aseprite.org/) (paid, pixel art pro tool)
4. Export as APNG / WebP / GIF, or use single-frame PNG / JPG / JPEG for static poses
5. Update `theme.json` to point to your files

**Recommended workflow for character art:**
- AI image generation (Midjourney, Stable Diffusion) → transparent PNG
- Or hand-draw in any pixel art editor
- Remove background with [remove.bg](https://www.remove.bg/) or `rembg` (Python CLI)

### Intermediate: Full Animation Set (1-2 Days)

Everything from beginner, plus:
- Custom working tiers (typing → juggling → building)
- Click reactions (poke left/right, double-click flail)
- Idle random animations (reading, looking around)
- Sleep sequence (yawning → collapsing → sleeping)
- Mini mode support (8 additional mini animations)

### Advanced: Full SVG + CSS Animations (Unlimited)

Skip the template entirely. Author all animations as SVG with CSS `@keyframes`:
- Infinite scalability (no pixelation at any zoom level)
- CSS animation control (timing, easing, iteration)
- SVG filter effects (blur, glow, drop-shadow)
- Reference `assets/svg/clawd-*.svg` in the repo for examples

## theme.json Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `1` | Must be `1` |
| `name` | string | Display name |
| `version` | string | Semver (e.g. `"1.0.0"`) |
| `viewBox` | object | `{ x, y, width, height }` — logical canvas in SVG units |
| `states` | object | Maps state names to file arrays or `{ files, fallbackTo }` objects (see below) |

### Common Metadata

These fields are optional, but commonly useful:

| Field | Type | Description |
|-------|------|-------------|
| `author` | string | Display name for the theme author |
| `description` | string | Short summary shown to users |
| `license` | string | Freeform display metadata only. Use it only for assets you own; it does not override the actual rights for bundled artwork by itself. |

### Required States

Current validator/runtime baseline requires these core states:

| State | When | Notes |
|-------|------|-------|
| `idle` | No agent activity | Must have real files. Must be SVG only when idle is listed in `eyeTracking.states` |
| `thinking` | User submitted prompt | Must have real files |
| `working` | Agent using tools | Must have real files. Base working file for single-session fallback |
| `sleeping` | After sleep sequence | Must exist with either real files or `fallbackTo` |
| `waking` | Mouse wakes from sleep | Required only when `sleepSequence.mode` is `full` |

### Additional Common States

These are common optional states you can add when you want distinct visuals for those events:

| State | When | Notes |
|-------|------|-------|
| `yawning` | Sleep sequence start | |
| `dozing` | After yawning | Use SVG only if `dozing` is listed in `eyeTracking.states` |
| `collapsing` | Falling asleep | |
| `error` | Tool failure | |
| `attention` | Task completed | |
| `notification` | Permission / alert | |
| `sweeping` | Context compaction | |
| `carrying` | Worktree creation | |
| `juggling` | Subagent active | Declare this and/or `jugglingTiers` if you want a distinct juggling visual |

### Optional Update Visuals

Themes may optionally declare updater-specific visuals without introducing new runtime states:

```json
"updateVisuals": {
  "checking": "checking-special.svg"
}
```

- `updateVisuals.checking` is optional
- when present, it overrides the visual used during update `checking`
- when omitted, update checking falls back to the theme's `thinking` state
- when a new version is found, updater uses the theme's `notification` state
- download / success / error still use the normal `carrying` / `attention` / `error` state bindings

If `sleepSequence.mode` is `full` (the default), `yawning`, `dozing`, `collapsing`, and `waking` also need real files. If `sleepSequence.mode` is `direct`, those extra sleep-sequence files are optional and the pet can go straight to `sleeping`.

### Eye Tracking

Eye tracking makes the character follow the user's cursor. It requires the idle SVG to contain specific element IDs.

```json
"eyeTracking": {
  "enabled": true,
  "states": ["idle"],
  "ids": {
    "eyes": "eyes-js",
    "body": "body-js",
    "shadow": "shadow-js"
  }
}
```

**How it works:**
- `#eyes-js` — receives `translate(dx, dy)` to follow cursor (max 3px)
- `#body-js` — receives a smaller translate for subtle body lean (optional)
- `#shadow-js` — receives translate + scaleX for shadow stretch toward cursor (optional)

**To disable eye tracking:** set `"enabled": false`. All states can then use any format (SVG, GIF, APNG, WebP, PNG, JPG, JPEG). Your idle animation will just loop without cursor following.

### Capability Switches

The existing schema fields are the only runtime truth. They already act as the theme's capability switches:

| Field | Current meaning |
|-------|-----------------|
| `eyeTracking.enabled` | Global eye-tracking on/off switch. When `false`, states do not need SVG just for cursor tracking. |
| `eyeTracking.states` | Per-state whitelist for eye tracking. Only listed states must be SVG and will use the object channel. |
| `miniMode.supported` | Enables mini mode for this theme. When `false`, Mini Mode is gated off in the menu/tray and edge-snap path. |
| `idleAnimations` | Optional idle random pool. Omit or leave empty to keep idle on `states.idle[0]`. |
| `reactions` | Optional click/drag reaction block. Omit it to disable click and drag reactions entirely. |
| `workingTiers` | Optional multi-session working overrides. Omit to fall back to `states.working[0]`. |
| `jugglingTiers` | Optional subagent juggling overrides. Omit to fall back to `states.juggling[0]` if you provide that state. |

The loader also derives read-only metadata such as `idleMode` (`tracked` / `animated` / `static`) from these fields, but that metadata is not a second schema authority.

### State Visual Fallback

State bindings accept the legacy array form, or an object with `files` and optional `fallbackTo`:

```json
"states": {
  "attention": ["happy.gif"],
  "error": { "fallbackTo": "attention" },
  "carrying": { "fallbackTo": "working" },
  "sleeping": { "files": ["sleeping.gif"] }
}
```

- `files` — the state's own assets
- `fallbackTo` — visual-only fallback target inside `states`
- Supported `fallbackTo` source states: `error`, `attention`, `notification`, `sweeping`, `carrying`, `sleeping`
- Fallback does **not** skip the logical state. Timers, hitboxes, and state transitions still run as the original state.

### Sleep Sequence

Use `sleepSequence.mode` to choose between the full sleep path and the new direct-sleep path:

```json
"sleepSequence": {
  "mode": "full"
}
```

- `full` — default. Runtime keeps `yawning -> dozing -> collapsing -> sleeping`, and `waking` should have real files.
- `direct` — after `mouseSleepTimeout`, runtime goes straight to `sleeping`. On wake, if `waking` has real files it plays once; otherwise the pet returns straight to idle/current display state.

### Working Tiers

Different animations based on how many agent sessions are running concurrently:

```json
"workingTiers": [
  { "minSessions": 3, "file": "building.gif" },
  { "minSessions": 2, "file": "juggling.gif" },
  { "minSessions": 1, "file": "typing.gif" }
]
```

### Reactions

Click and drag response animations:

```json
"reactions": {
  "drag":       { "file": "react-drag.gif" },
  "clickLeft":  { "file": "react-left.gif",  "duration": 2500 },
  "clickRight": { "file": "react-right.gif", "duration": 2500 },
  "annoyed":    { "file": "react-annoyed.gif", "duration": 3500 },
  "double":     { "files": ["react-double.gif"], "duration": 3500 }
}
```

- `drag` — plays while being dragged (no duration, loops until released)
- `clickLeft` / `clickRight` — double-click reaction, direction-aware
- `annoyed` — 50% chance on double-click instead of directional
- `double` — 4-click rapid reaction, `files` array for random selection

Omit the entire `reactions` block to disable all click and drag reactions.

### Idle Animations

Random animations played during idle periods:

```json
"idleAnimations": [
  { "file": "idle-look.gif", "duration": 6500 },
  { "file": "idle-reading.gif", "duration": 14000 }
]
```

Omit `idleAnimations` or use an empty array if you want idle to stay on `states.idle[0]` with no random pool.

### Hit Boxes

Clickable area in viewBox units. Only the `default` hitbox is required:

```json
"hitBoxes": {
  "default":  { "x": -1, "y": 5, "w": 17, "h": 12 },
  "sleeping": { "x": -2, "y": 9, "w": 19, "h": 7 },
  "wide":     { "x": -3, "y": 3, "w": 21, "h": 14 }
},
"sleepingHitboxFiles": ["sleeping.gif"],
"wideHitboxFiles": ["error.gif", "notification.gif"]
```

### Mini Mode

Mini mode hides the character at the screen edge. Set `"supported": false` or omit the block to skip:

```json
"miniMode": {
  "supported": true,
  "offsetRatio": 0.486,
  "states": {
    "mini-idle":   ["mini-idle.svg"],
    "mini-enter":  ["mini-enter.gif"],
    "mini-peek":   ["mini-peek.gif"],
    "mini-alert":  ["mini-alert.gif"],
    "mini-happy":  ["mini-happy.gif"],
    "mini-sleep":  ["mini-sleep.gif"],
    "mini-crabwalk": ["mini-crabwalk.gif"],
    "mini-enter-sleep": ["mini-enter-sleep.gif"]
  }
}
```

If `miniMode.supported` is `true`, the validator expects all 8 mini states shown above. `mini-idle` only needs to be SVG when `mini-idle` is listed in `eyeTracking.states`.

### Timings

All values in milliseconds. Omit any to use defaults:

```json
"timings": {
  "mouseIdleTimeout": 20000,
  "mouseSleepTimeout": 60000,
  "yawnDuration": 3000,
  "wakeDuration": 1500,
  "deepSleepTimeout": 600000,
  "minDisplay": {
    "attention": 4000,
    "error": 5000,
    "working": 1000
  },
  "autoReturn": {
    "attention": 4000,
    "error": 5000
  }
}
```

### Object Scale

Fine-tune rendered size relative to viewBox. Defaults work for most themes:

```json
"objectScale": {
  "widthRatio": 1.9,
  "heightRatio": 1.3,
  "offsetX": -0.45,
  "offsetY": -0.25
}
```

### Layout Normalization

If two themes have very different visible body heights even though the window size is the same, add a `layout` block. This lets Clawd align the character by visible body area and baseline instead of the raw file canvas:

```json
"layout": {
  "contentBox": { "x": -4, "y": -3, "width": 23, "height": 20 },
  "centerX": 7.5,
  "baselineY": 17,
  "visibleHeightRatio": 0.58,
  "baselineBottomRatio": 0.05
}
```

- `contentBox` — the visible body area in viewBox units, not the whole exported canvas
- `centerX` — the horizontal anchor inside the viewBox
- `baselineY` — the standing baseline inside the viewBox
- `visibleHeightRatio` — how tall the visible body should be relative to the window height
- `baselineBottomRatio` — distance from the baseline to the bottom of the window

Mini mode still uses the existing `objectScale` + per-file offsets, so this is mainly for normal mode alignment.

## Asset Guidelines

### Supported Formats

| Format | Best for | Eye tracking | Notes |
|--------|----------|-------------|-------|
| SVG | Idle states, all animations | Yes (with IDs) | Infinite scale, CSS animations |
| APNG | Frame animations | No | Best quality, alpha channel |
| GIF | Pixel art animations | No | Binary transparency only |
| WebP | Photo-style animations | No | Good compression |
| PNG | Static poses | No | Good for single-frame non-tracked states |
| JPG / JPEG | Static poses without transparency | No | Fine for opaque or composited artwork |

### Minimal Static Theme Example

If you only have still artwork, that is fine. A theme with single-frame PNG / WebP / JPG / JPEG files is a first-class path now. The simplest authoring recipe is:

- set `eyeTracking.enabled` to `false`
- set `miniMode.supported` to `false` unless you really drew all 8 mini states
- use one real file each for `idle`, `thinking`, `working`, and `sleeping`
- add `sleepSequence.mode: "direct"` if you do not want to draw `yawning` / `dozing` / `collapsing` / `waking`
- use `fallbackTo` on interruption states when one still image is enough

Example:

```json
"eyeTracking": {
  "enabled": false,
  "states": []
},
"sleepSequence": {
  "mode": "direct"
},
"states": {
  "idle": ["idle.jpg"],
  "thinking": ["thinking.jpg"],
  "working": ["working.jpg"],
  "attention": ["happy.jpg"],
  "error": { "fallbackTo": "attention" },
  "notification": { "fallbackTo": "attention" },
  "sleeping": ["sleeping.jpg"]
},
"miniMode": {
  "supported": false
}
```

See `themes/static-test/theme.json` in this repo for a fuller built-in JPG sample that also exercises `transitions`, `objectScale`, file offsets, and sleep hitboxes.

### Canvas Size

All assets should share the same logical canvas defined by `viewBox`. For raster formats (GIF/APNG/WebP):
- Export at 2x-3x the viewBox dimensions for crisp rendering
- Example: viewBox 45x45 → export GIFs at 90x90 or 135x135 pixels
- Keep the character positioned consistently across all frames

### SVG Eye Tracking Structure

For SVGs that need eye tracking, include these groups with exact IDs:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-15 -25 45 45">
  <!-- Bottom layer: shadow (optional) -->
  <g id="shadow-js" style="transform-origin: 7.5px 15px">
    <ellipse cx="7.5" cy="16" rx="6" ry="1.5" fill="rgba(0,0,0,0.15)"/>
  </g>

  <!-- Middle layer: character body (optional, enables lean effect) -->
  <g id="body-js">
    <!-- Your character body here -->
  </g>

  <!-- Top layer: eyes (required for eye tracking) -->
  <g id="eyes-js">
    <!-- Your character eyes here -->
  </g>
</svg>
```

## Validation

Run the validator before distributing your theme:

```bash
node scripts/validate-theme.js path/to/your-theme
```

The validator checks:
- `theme.json` schema (required fields, types, schemaVersion)
- Asset file existence (all referenced files)
- Eye tracking SVG structure (required IDs)
- Mini mode completeness when `miniMode.supported=true`
- Hit box configuration

## Debugging Tips

- **Theme not appearing in menu?** Check that `theme.json` is valid JSON (no trailing commas, no comments — use `_comment` fields instead)
- **Assets not loading?** Check file names match exactly (case-sensitive on Linux/macOS)
- **Eye tracking not working?** Verify your SVG has `id="eyes-js"` on the eye group, and `eyeTracking.enabled` is `true`
- **Character jumping between states?** Ensure all assets share the same canvas size and character position
- **Animation not looping?** GIF/APNG must be set to loop; SVG CSS `@keyframes` need `infinite` iteration

## Distribution

### As a GitHub repository
1. Create a repo with your theme folder structure
2. Users clone/download to their themes directory
3. Include a screenshot or GIF preview in your README

### As a zip file
1. Zip the theme folder (the folder containing `theme.json`)
2. Users extract to `{userData}/themes/`
   - Windows: `%APPDATA%/clawd-on-desk/themes/`
   - macOS: `~/Library/Application Support/clawd-on-desk/themes/`
   - Linux: `~/.config/clawd-on-desk/themes/`

## Theme Installation (User Side)

1. Download/clone the theme to the themes directory (see paths above)
2. In `Settings…` → `Theme`, check the capability badges (`Tracked idle`, `Animated idle`, `Static theme`, `Mini`, `Direct sleep`, `No reactions`) to confirm what the theme supports
3. Restart Clawd or switch theme via right-click → Theme menu
4. The theme appears in the menu by its `name` field from `theme.json`

> **Security note:** Third-party SVG files are automatically sanitized — `<script>`, event handlers, and `javascript:` URLs are stripped before rendering.
