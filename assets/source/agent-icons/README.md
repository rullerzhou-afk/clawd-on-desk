# Agent Icon Sources

Runtime agent icons live in `assets/icons/agents/` and should be exported as 64x64 PNG files named with the agent id, for example `kiro-cli.png`.

This directory stores editable or higher-resolution source assets used to generate those runtime PNG files. Prefer official SVG or high-resolution sources. When an official source is not available yet, keep the best existing asset here as a fallback and replace it when a better source is available.

If both PNG and SVG sources exist for the same agent, the export script uses the PNG source first because Electron's SVG rasterization support is limited. Keep the SVG next to it as the editable source of record. After editing the SVG, refresh the same-name PNG source first, then run `npm run export-agent-icons -- --accept-svg-sources`. The script checks `source-manifest.json` hashes so stale raster sources do not silently ship.

Run the export script after changing sources:

```bash
npm run export-agent-icons
```

The runtime folder should not mix canonical source SVGs with generated PNGs. SVG files belong here unless a future runtime requirement needs them in `assets/icons/agents/`.
