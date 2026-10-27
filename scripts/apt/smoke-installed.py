#!/usr/bin/env python3
"""Actual package upgrade in an explicitly disposable amd64 CI machine only."""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import threading
import types
import repository as repo


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--preview-output", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or os.environ.get("CLAWD_APT_DISPOSABLE") != "1" or platform.machine() != "x86_64":
        raise SystemExit("Requires an explicitly disposable root amd64 CI machine")
    with tempfile.TemporaryDirectory(prefix="clawd-installed-apt-") as folder:
        work = Path(folder)
        work.chmod(0o755)
        gpg_home = work / "gnupg"
        gpg_home.mkdir(mode=0o700)
        os.environ["GNUPGHOME"] = str(gpg_home)
        os.environ["DEBIAN_FRONTEND"] = "noninteractive"
        repo.run("gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "Clawd CI <ci@example.invalid>", "rsa3072", "sign", "1d")
        keys = repo.run("gpg", "--with-colons", "--list-keys").decode()
        fingerprint = next(line.split(":")[9] for line in keys.splitlines() if line.startswith("fpr:"))
        public = work / "public.asc"
        public.write_bytes(repo.run("gpg", "--armor", "--export", fingerprint))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(work)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            cfg = json.loads((repo.ROOT / "distribution/apt/config.json").read_text())
            cfg["uri"] = f"http://127.0.0.1:{server.server_port}/site/apt"
            config = work / "config.json"
            config.write_text(json.dumps(cfg))
            repo.build(types.SimpleNamespace(config=config, input=args.input, output=work / "site",
                public_key=public, signing_key=fingerprint, previous_url=None, allow_initial=False))
            if args.preview_output:
                args.preview_output.mkdir(parents=True, exist_ok=False)
                for name in ("index.html", "clawd-on-desk.asc", "dists/stable/manifest.json"):
                    source = work / "site/apt" / name
                    shutil.copyfile(source, args.preview_output / source.name)
            packages = sorted(json.loads((args.input / "manifest.json").read_text()), key=lambda p: repo.version(p["version"]))
            if len(packages) < 2:
                raise ValueError("Real upgrade requires two published app versions")
            old, new = packages[-2:]
            profile = Path("/home/clawd-apt-smoke/.config/Clawd on Desk")
            profile.mkdir(parents=True)
            settings = profile / "clawd-prefs.json"
            settings.write_text('{"aptSmokeSentinel":"preserve"}\n')
            expected = settings.read_bytes()
            subprocess.run(["apt-get", "update"], check=True)
            subprocess.run(["apt-get", "install", "-y", str((args.input / old["file"]).resolve())], check=True)
            bootstrap = work / "site/apt/pool/main" / f"clawd-apt-source_{cfg['bootstrap_version']}_all.deb"
            subprocess.run(["apt-get", "install", "-y", str(bootstrap)], check=True)
            subprocess.run(["apt-get", "update", "--error-on=any"], check=True)
            subprocess.run(["apt-get", "install", "-y", "--only-upgrade", "clawd-on-desk"], check=True)
            actual = repo.run("dpkg-query", "-W", "-f=${Version}", "clawd-on-desk").decode()
            assert actual == new["version"], (actual, new["version"])
            assert settings.read_bytes() == expected
            files = repo.run("dpkg-query", "-L", "clawd-on-desk").decode().splitlines()
            sandbox = Path(next(p for p in files if p.endswith("/chrome-sandbox")))
            user_namespaces = Path("/proc/self/ns/user").is_symlink() and subprocess.run(
                ["unshare", "--user", "true"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            expected_mode = 0o755 if user_namespaces else 0o4755
            assert sandbox.stat().st_uid == 0 and sandbox.stat().st_mode & 0o7777 == expected_mode
            apparmor = Path(next(p for p in files if p.endswith("/resources/apparmor-profile")))
            enabled = subprocess.run(["apparmor_status", "--enabled"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            if enabled and subprocess.run(["apparmor_parser", "--skip-kernel-load", "--debug", str(apparmor)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                assert Path("/etc/apparmor.d/clawd-on-desk").read_bytes() == apparmor.read_bytes()
            print(f"Sandbox: root-owned mode {expected_mode:o}; AppArmor enabled={enabled}")
            subprocess.run(["apt-get", "remove", "-y", "clawd-apt-source"], check=True)
            subprocess.run(["apt-get", "update", "--error-on=any"], check=True)
            subprocess.run(["apt-get", "purge", "-y", "clawd-apt-source"], check=True)
            assert not Path("/etc/apt/sources.list.d/clawd-on-desk.sources").exists()
            print(f"PASS actual Clawd {old['version']} -> {new['version']}; profile retained; sandbox/AppArmor payload verified; remove refresh and purge passed")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
            repo.run("gpgconf", "--kill", "gpg-agent")


if __name__ == "__main__":
    main()
