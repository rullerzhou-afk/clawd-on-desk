# Agent Icon Sources

Runtime agent icons live in `assets/icons/agents/` and should be exported as 64x64 PNG files named with the agent id, for example `kiro-cli.png`.

This directory stores editable or higher-resolution source assets used to generate those runtime PNG files. Prefer official SVG or high-resolution sources. When an official source is not available yet, keep the best existing asset here as a fallback and replace it when a better source is available.

If both PNG and SVG sources exist for the same agent, the export script uses the PNG source first because Electron's SVG rasterization support is limited. Keep the SVG next to it as the editable source of record. After editing the SVG, refresh the same-name PNG source first, then run `npm run export-agent-icons -- --accept-svg-sources`. The script checks both the selected source hashes and the normalized SVG hashes in `source-manifest.json`, so stale or replaced sources do not silently ship.

The exporter preserves aspect ratio and centers visible artwork inside a 56x56 safe area on a transparent 64x64 canvas. Transparent sources are cropped to their alpha bounds before fitting. Opaque sources keep their complete canvas; the exporter never guesses at background removal.

Sources that would disappear against one of the application's light or dark surfaces use a recorded neutral contrast tile. Their artwork is fitted inside a 40x40 area on a centered 56x56 tile so the same runtime PNG remains identifiable in both color schemes.

An explicitly approved legacy fallback may use `passthrough` export mode to preserve its existing 64x64 PNG byte-for-byte. This exception must be recorded in `source-manifest.json` and covered by an exact-hash test.

When a legacy fallback is selected instead of newly supplied artwork, keep the new canonical PNG/SVG candidates in this directory and record them under the selected source's `archivedSources` manifest entry.

Each generated runtime file is bound to its selected source through `outputs` records in `source-manifest.json`. The exporter records both the runtime SHA-256 and the selected source SHA-256 only after every Agent icon has generated successfully.

Run the export script after changing sources:

```bash
npm run export-agent-icons
```

The runtime folder should not mix canonical source SVGs with generated PNGs. SVG files belong here unless a future runtime requirement needs them in `assets/icons/agents/`.
