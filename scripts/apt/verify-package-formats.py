#!/usr/bin/env python3
"""Assert the install markers in final archives, not shared linux-unpacked."""
import argparse
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--dist", required=True, type=Path)
args = parser.parse_args()
debs, images = list(args.dist.glob("*.deb")), list(args.dist.glob("*.AppImage"))
if len(debs) != 1 or len(images) != 1:
    raise SystemExit("Expected one amd64 deb and one AppImage")
with tempfile.TemporaryDirectory(prefix="clawd-format-check-") as folder:
    root = Path(folder)
    subprocess.run(["dpkg-deb", "--extract", str(debs[0]), str(root / "deb")], check=True)
    markers = list((root / "deb").glob("opt/*/resources/package-type"))
    assert len(markers) == 1 and markers[0].read_text().strip() == "deb", "deb marker missing"
    # The AppImage runtime's extract option does not start Electron or AppRun.
    subprocess.run([str(images[0].resolve()), "--appimage-extract", "resources/package-type"], cwd=root, check=True, stdout=subprocess.DEVNULL)
    assert not (root / "squashfs-root/resources/package-type").exists(), "deb marker leaked into AppImage"
print("PASS: final deb identifies itself; final AppImage has no package-type marker")
