#!/usr/bin/env python3
"""Generate enlarged Discord Rich Presence sprites from the shared pet GIFs.

The presence sets `large_image` to one of these GIFs. Discord scales the square
source into a fixed box but never crops transparent padding, so the source art —
a small sprite floating in a 302x300 canvas — renders tiny (the idle crab fills
~34% of the width). This crops each sprite to its content, centers it in a square
with a thin margin, and upscales it so the sprite fills the Discord card.

Canonical assets in assets/gif/ are left untouched; output goes to a separate
folder so the desktop pet and other themes keep their original framing.

Dev-time only. Needs Pillow (`pip install Pillow`); not an app dependency.
Run from the repo root: `python tools/build-discord-presence-gifs.py`
"""
import os
from PIL import Image, ImageSequence

SRC_DIR = os.path.join("assets", "gif")
OUT_DIR = os.path.join("assets", "discord-presence")

# Mirror the SVG_GIF targets in src/discord-presence-rpc.js — keep in sync.
FILES = [
    "clawd-idle.gif",
    "clawd-sleeping.gif",
    "clawd-thinking.gif",
    "clawd-typing.gif",
    "clawd-juggling.gif",
    "clawd-happy.gif",
    "clawd-error.gif",
    "clawd-bubble.gif",
    "clawd-idle-reading.gif",
    "clawd-building.gif",
    "clawd-debugger.gif",
    "clawd-sweeping.gif",
    "clawd-carrying.gif",
    "clawd-notification.gif",
    "clawd-headphones-groove.gif",
    "clawd-mini-idle.gif",
    "clawd-mini-alert.gif",
    "clawd-mini-happy.gif",
    "clawd-mini-enter.gif",
    "clawd-mini-peek.gif",
    "clawd-mini-crabwalk.gif",
]

MARGIN = 0.08   # breathing room so Discord's rounded corners never clip the sprite
TARGET = 300    # served square size; NEAREST keeps pixel-art edges crisp
TRANSPARENT_INDEX = 255


def load_frames(path):
    im = Image.open(path)
    frames, durations = [], []
    for fr in ImageSequence.Iterator(im):
        frames.append(fr.convert("RGBA"))  # seeking composites GIF disposal
        durations.append(fr.info.get("duration", 100))
    return frames, durations


def union_bbox(frames):
    box = None
    for f in frames:
        b = f.getbbox()
        if not b:
            continue
        box = list(b) if box is None else [
            min(box[0], b[0]), min(box[1], b[1]),
            max(box[2], b[2]), max(box[3], b[3]),
        ]
    return tuple(box)


def build_master_palette(frames):
    """One palette shared by every frame so colors can't shift between frames."""
    w, h = frames[0].size
    strip = Image.new("RGB", (w, h * len(frames)), (0, 0, 0))
    for i, f in enumerate(frames):
        strip.paste(f.convert("RGB"), (0, i * h))
    # 255 colors leaves index 255 free for transparency
    return strip.quantize(colors=255, method=Image.MEDIANCUT)


def to_indexed(rgba, master):
    p = rgba.convert("RGB").quantize(palette=master, dither=Image.Dither.NONE)
    transparent = rgba.split()[3].point(lambda a: 255 if a < 128 else 0)
    p.paste(TRANSPARENT_INDEX, transparent)
    return p


def enlarge(path):
    frames, durations = load_frames(path)
    bb = union_bbox(frames)
    bw, bh = bb[2] - bb[0], bb[3] - bb[1]
    side = max(bw, bh)
    box = side + 2 * round(side * MARGIN)

    squared = []
    for f in frames:
        crop = f.crop(bb)
        canvas = Image.new("RGBA", (box, box), (0, 0, 0, 0))
        canvas.paste(crop, ((box - bw) // 2, (box - bh) // 2), crop)
        squared.append(canvas.resize((TARGET, TARGET), Image.NEAREST))

    master = build_master_palette(squared)
    indexed = [to_indexed(f, master) for f in squared]
    return indexed, durations, (bw, bh, box)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"{'file':22} {'content':>9}  {'->square':>8}  {'fill W%xH%':>11}  frames  KB")
    for name in FILES:
        indexed, durations, (bw, bh, box) = enlarge(os.path.join(SRC_DIR, name))
        out = os.path.join(OUT_DIR, name)
        indexed[0].save(
            out, save_all=True, append_images=indexed[1:],
            duration=durations, loop=0,
            transparency=TRANSPARENT_INDEX, disposal=2, optimize=False,
        )
        fw, fh = bw / box * 100, bh / box * 100
        kb = os.path.getsize(out) // 1024
        print(f"{name:22} {bw:>3}x{bh:<3}  {box:>5}px  {fw:>4.0f}%x{fh:<4.0f}%  "
              f"{len(indexed):>5}  {kb:>3}")
    print(f"\nWrote {len(FILES)} sprites to {OUT_DIR}/")


if __name__ == "__main__":
    main()
