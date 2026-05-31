#!/bin/bash
# Sync SVG assets from desktop (assets/svg/) to watch app.
# Only copies SVGs that the watch ThemeConfig actually references.
# Run from repo root: ./scripts/sync-watch-svgs.sh
shopt -s nullglob

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/assets/svg"
DST="$REPO_ROOT/watch-app/android/app/src/main/assets/svg"

if [ ! -d "$SRC" ]; then
  echo "Source not found: $SRC"
  exit 1
fi

mkdir -p "$DST"

# Extract SVG filenames referenced in ThemeConfig.kt
THEME_CONFIG="$REPO_ROOT/watch-app/android/app/src/main/kotlin/com/clawd/watch/domain/ThemeConfig.kt"
if [ ! -f "$THEME_CONFIG" ]; then
  echo "ThemeConfig.kt not found"
  exit 1
fi

REFERENCED=$(grep -oE 'clawd-[a-z0-9-]+\.svg' "$THEME_CONFIG" | sort -u)

added=0
updated=0
skipped=0

for svg in $REFERENCED; do
  src_file="$SRC/$svg"
  dst_file="$DST/$svg"
  if [ ! -f "$src_file" ]; then
    echo "  SKIP $svg (not in desktop assets)"
    skipped=$((skipped + 1))
    continue
  fi
  if [ -f "$dst_file" ] && cmp -s "$src_file" "$dst_file"; then
    continue
  fi
  if [ -f "$dst_file" ]; then
    echo "  UPDATE $svg"
    updated=$((updated + 1))
  else
    echo "  ADD $svg"
    added=$((added + 1))
  fi
  cp "$src_file" "$dst_file"
done

# Report orphan SVGs in watch that are not referenced
for f in "$DST"/*.svg; do
  base=$(basename "$f")
  if ! echo "$REFERENCED" | grep -qx "$base"; then
    echo "  ORPHAN $base (in watch but not in ThemeConfig)"
  fi
done

echo "Done: $added added, $updated updated, $skipped not found in desktop"
