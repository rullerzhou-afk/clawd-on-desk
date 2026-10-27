#!/usr/bin/env python3
"""Build a bounded signed APT snapshot from unmodified GitHub release assets.

Python standard library + dpkg-deb/dpkg-scanpackages/gpg/gpgv. No publication
or system APT changes: failed builds leave only their disposable output.
"""
import argparse
import datetime
import email.utils
import gzip
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

REPO = "rullerzhou-afk/clawd-on-desk"
ROOT = Path(__file__).resolve().parents[2]
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")
MAX_DEB = 180 * 1024 * 1024
IDENTITY = ("Origin", "Label", "Suite", "Codename", "Architectures", "Components")


def run(*args, cwd=None, env=None, data=None):
    return subprocess.run(args, cwd=cwd, env=env, input=data, check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def version(value):
    if not VERSION.fullmatch(value):
        raise ValueError(f"Not a stable numeric version: {value}")
    return tuple(map(int, value.split(".")))


def fetch(url, limit, *, api=False):
    headers = {"User-Agent": "clawd-apt-publisher", "Accept": "application/vnd.github+json" if api else "*/*"}
    if api and os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as response:
        if not api and "github.io" in urllib.parse.urlsplit(url).netloc:
            if urllib.parse.urlsplit(response.url).netloc != urllib.parse.urlsplit(url).netloc:
                raise ValueError("Pages redirects to a different host; review APT URI/pin before activation")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"Oversized response: {url}")
    return data


def releases():
    found = []
    for page in range(1, 11):
        items = json.loads(fetch(f"https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}", 8 * 1024 * 1024, api=True))
        for item in items:
            tag = item.get("tag_name", "")
            if not item.get("draft") and not item.get("prerelease") and tag.startswith("v") and VERSION.fullmatch(tag[1:]):
                found.append(item)
        if len(items) < 100:
            break
    else:
        raise ValueError("Release pagination exceeded bound")
    found.sort(key=lambda item: version(item["tag_name"][1:]), reverse=True)
    if not found:
        raise ValueError("No stable releases")
    if len({item["tag_name"] for item in found}) != len(found):
        raise ValueError("Duplicate stable release versions")
    return found


def download_releases(destination):
    destination.mkdir(parents=True, exist_ok=False)
    packages = []
    for release in releases()[:3]:
        app_version = release["tag_name"][1:]
        expected_name = f"Clawd-on-Desk-{app_version}-amd64.deb"
        assets = [asset for asset in release["assets"] if asset["name"] == expected_name]
        if len(assets) != 1:
            raise ValueError(f"Expected one amd64 deb for {app_version}")
        asset = assets[0]
        expected_hash = asset.get("digest", "")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", expected_hash):
            raise ValueError(f"Missing authoritative SHA-256 digest for {expected_name}")
        url = f"https://github.com/{REPO}/releases/download/v{app_version}/{expected_name}"
        if asset["browser_download_url"] != url or not 0 < asset["size"] <= MAX_DEB:
            raise ValueError("Unexpected release asset URL/size")
        data = fetch(url, MAX_DEB)
        if len(data) != asset["size"] or digest(data) != expected_hash[7:]:
            raise ValueError("Release asset digest/size mismatch")
        (destination / expected_name).write_bytes(data)
        packages.append({"version": app_version, "file": expected_name, "sha256": digest(data)})
    (destination / "manifest.json").write_text(json.dumps(packages, indent=2) + "\n")


def paragraphs(data):
    result = []
    for block in data.decode().strip().split("\n\n"):
        record = {}
        key = None
        for line in block.splitlines():
            if line.startswith(" ") and key:
                record[key] += "\n" + line
            else:
                key, value = line.split(":", 1)
                if key in record:
                    raise ValueError("Duplicate metadata field")
                record[key] = value.strip()
        result.append(record)
    return result


def checksums(release):
    result = {}
    for line in release["SHA256"].splitlines():
        if not line.strip():
            continue
        sha, size, name = line.split()
        if not re.fullmatch(r"[a-f0-9]{64}", sha) or name.startswith("/") or ".." in name.split("/") or name in result:
            raise ValueError("Invalid Release checksum entry")
        result[name] = (sha, int(size))
    return result


def keyring(public_key, destination):
    run("gpg", "--batch", "--yes", "--dearmor", "--output", str(destination), str(public_key))


def validate_signing_subkey(fingerprint):
    if not re.fullmatch(r"[A-F0-9]{40}", fingerprint):
        raise ValueError("Expected a full uppercase primary fingerprint")
    keys = [line.split(":") for line in run("gpg", "--batch", "--with-colons", "--list-secret-keys", fingerprint).decode().splitlines()]
    primaries = [key for key in keys if key[0] == "sec"]
    primary_fingerprint = next((key[9] for key in keys if key[0] == "fpr"), None)
    if primary_fingerprint != fingerprint:
        raise ValueError("Use the primary fingerprint, not a signing-subkey fingerprint")
    if len(primaries) != 1 or primaries[0][14] != "#":
        raise ValueError("Production requires a secret subkey only; keep the primary secret offline")
    if not any(key[0] == "ssb" and "s" in key[11] and key[14] != "#" and key[1] not in ("r", "e", "d") for key in keys):
        raise ValueError("Missing usable signing subkey")


def verify_signed(inrelease, trusted_key, directory):
    signed = directory / "verify.InRelease"
    clear = directory / "verify.Release"
    clear.unlink(missing_ok=True)
    signed.write_bytes(inrelease)
    run("gpgv", "--keyring", str(trusted_key), "--output", str(clear), str(signed))
    return paragraphs(clear.read_bytes())[0]


def previous_snapshot(url, trusted_key, cfg, directory, allow_initial):
    if not url:
        return None
    try:
        signed = fetch(url.rstrip("/") + "/dists/stable/InRelease", 1024 * 1024)
    except urllib.error.HTTPError as error:
        if allow_initial and error.code == 404:
            return None
        raise
    release = verify_signed(signed, trusted_key, directory)
    if any(release.get(key) != value for key, value in release_identity(cfg).items()):
        raise ValueError("Published Release identity changed; requires a reviewed migration")
    entries = checksums(release)
    def authenticated(name, limit):
        sha, size = entries[name]
        if size > limit:
            raise ValueError("Prior index exceeds limit")
        parent = str(Path(name).parent)
        data = fetch(url.rstrip("/") + f"/dists/stable/{parent}/by-hash/SHA256/{sha}", limit)
        if len(data) != size or digest(data) != sha:
            raise ValueError("Prior index checksum mismatch")
        return data
    manifest = json.loads(authenticated("manifest.json", 2 * 1024 * 1024))
    indexes = {name: authenticated(name, 2 * 1024 * 1024) for name in (
        "main/binary-amd64/Packages", "main/binary-amd64/Packages.gz", "manifest.json")}
    return {"manifest": manifest, "indexes": indexes, "url": url.rstrip("/")}


def release_identity(cfg):
    return dict(zip(IDENTITY, [cfg["origin"], cfg["label"], cfg["suite"], cfg["codename"], cfg["architecture"], cfg["component"]]))


def verify_live(config, public_key):
    cfg = json.loads(config.read_text())
    if not public_key.is_file():
        raise ValueError("APT is not activated: review and commit the production public key before releasing the app")
    with tempfile.TemporaryDirectory(prefix="clawd-apt-live-") as temp:
        work = Path(temp)
        trust = work / "trusted.gpg"
        keyring(public_key, trust)
        previous = previous_snapshot(cfg["uri"], trust, cfg, work, allow_initial=False)
        guide = fetch(cfg["uri"].rstrip("/") + "/", 1024 * 1024)
        if not guide.strip():
            raise ValueError("APT guide is empty")
        print("APT ready: authenticated repository and guide; version " + previous["manifest"]["latest"])


def source_templates(cfg):
    host = urllib.parse.urlsplit(cfg["uri"]).hostname
    return {
        "etc/apt/sources.list.d/clawd-on-desk.sources":
            f"Types: deb\nURIs: {cfg['uri']}/\nSuites: stable\nComponents: main\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/clawd-on-desk.asc\n",
        "etc/apt/preferences.d/clawd-on-desk.pref":
            f'Package: clawd-on-desk clawd-apt-source\nPin: origin "{host}"\nPin-Priority: 500\n\nPackage: *\nPin: origin "{host}"\nPin-Priority: -1\n',
    }


def bootstrap(cfg, public_key, destination, directory):
    root = directory / "bootstrap"
    files = source_templates(cfg)
    files["etc/apt/keyrings/clawd-on-desk.asc"] = public_key.read_text()
    for name, data in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data)
    control = root / "DEBIAN"
    control.mkdir()
    (control / "control").write_text(
        f"Package: clawd-apt-source\nVersion: {cfg['bootstrap_version']}\nArchitecture: all\n"
        "Maintainer: Clawd on Desk <rullerzhou-afk@users.noreply.github.com>\n"
        "Section: admin\nPriority: optional\nDepends: apt (>= 2.4)\n"
        "Description: Official Clawd on Desk APT source and scoped signing key\n"
        " Use apt purge clawd-apt-source to remove this source and its trust key.\n"
    )
    (control / "conffiles").write_text("".join("/" + name + "\n" for name in sorted(files)))
    for path in [root, *root.rglob("*")]:
        path.chmod(0o755 if path.is_dir() else 0o644)
        os.utime(path, (cfg["source_date_epoch"], cfg["source_date_epoch"]))
    package = destination / f"clawd-apt-source_{cfg['bootstrap_version']}_all.deb"
    run("dpkg-deb", "--root-owner-group", "-Zxz", "--build", str(root), str(package),
        env={**os.environ, "SOURCE_DATE_EPOCH": str(cfg["source_date_epoch"]), "TZ": "UTC"})
    extracted = directory / "extracted"
    run("dpkg-deb", "--extract", str(package), str(extracted))
    return package, extracted / "etc/apt/keyrings/clawd-on-desk.asc"


def package_record(package, site):
    record = paragraphs(run("dpkg-deb", "--field", str(package), "Package", "Version", "Architecture"))[0]
    name, ver, arch = (record[key] for key in ("Package", "Version", "Architecture"))
    version(ver)
    if (name, arch) not in [("clawd-on-desk", "amd64"), ("clawd-apt-source", "all")]:
        raise ValueError("Unexpected package identity")
    data = package.read_bytes()
    return {"package": name, "version": ver, "architecture": arch, "filename": package.relative_to(site).as_posix(), "sha256": digest(data), "size": len(data)}


def build(args):
    cfg = json.loads(args.config.read_text())
    version(cfg["bootstrap_version"])
    if any("\n" in str(value) for value in cfg.values()):
        raise ValueError("Invalid multiline configuration")
    args.output.mkdir(parents=True, exist_ok=False)
    site = args.output / "apt"
    pool = site / "pool/main"
    pool.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="clawd-apt-") as temp:
        work = Path(temp)
        trust = work / "trusted.gpg"
        keyring(args.public_key, trust)
        previous = previous_snapshot(args.previous_url, trust, cfg, work, args.allow_initial)
        manifest_input = json.loads((args.input / "manifest.json").read_text())
        if not 1 <= len(manifest_input) <= 3:
            raise ValueError("Expected 1-3 stable app packages")
        records = []
        for item in manifest_input:
            version(item["version"])
            if Path(item["file"]).name != item["file"]:
                raise ValueError("Invalid input package filename")
            source = args.input / item["file"]
            if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_DEB:
                raise ValueError("Invalid input package file")
            if digest(source.read_bytes()) != item["sha256"]:
                raise ValueError("Input package checksum mismatch")
            target = pool / f"clawd-on-desk_{item['version']}_amd64.deb"
            if target.exists():
                raise ValueError("Duplicate app version")
            shutil.copyfile(source, target)
            record = package_record(target, site)
            if record["package"] != "clawd-on-desk" or record["version"] != item["version"]:
                raise ValueError("Release and deb identity disagree")
            records.append(record)
        latest = max((r["version"] for r in records), key=version)
        source_package, extracted_key = bootstrap(cfg, args.public_key, pool, work)
        records.append(package_record(source_package, site))
        history = dict(previous["manifest"]["history"]) if previous else {}
        if previous:
            if version(latest) < version(previous["manifest"]["latest"]):
                raise ValueError("Refusing published version rollback")
            old_sources = [r for r in previous["manifest"]["packages"] if r["package"] == "clawd-apt-source"]
            if any(version(r["version"]) > version(cfg["bootstrap_version"]) for r in old_sources):
                raise ValueError("Refusing published bootstrap version rollback")
            prior_sources = [r for r in old_sources if r["version"] != cfg["bootstrap_version"]]
            for record in sorted(prior_sources, key=lambda r: version(r["version"]), reverse=True)[:1]:
                filename = f"pool/main/clawd-apt-source_{record['version']}_all.deb"
                if filename != record["filename"] or record["size"] > 1024 * 1024:
                    raise ValueError("Invalid prior bootstrap")
                data = fetch(previous["url"] + "/" + filename, 1024 * 1024)
                if len(data) != record["size"] or digest(data) != record["sha256"]:
                    raise ValueError("Prior bootstrap checksum mismatch")
                (site / filename).write_bytes(data)
                records.append(record)
        for record in records:
            identity = "/".join(record[k] for k in ("package", "version", "architecture"))
            if identity in history and history[identity] != record["sha256"]:
                raise ValueError(f"Published package bytes changed: {identity}; bump the version")
            history[identity] = record["sha256"]
        distribution = site / "dists/stable"
        binary = distribution / "main/binary-amd64"
        binary.mkdir(parents=True)
        packages = run("dpkg-scanpackages", "--multiversion", "pool", "/dev/null", cwd=site)
        (binary / "Packages").write_bytes(packages)
        (binary / "Packages.gz").write_bytes(gzip.compress(packages, mtime=0))
        manifest = {"latest": latest, "packages": records, "history": history}
        (distribution / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        indexes = {name: (distribution / name).read_bytes() for name in ["main/binary-amd64/Packages", "main/binary-amd64/Packages.gz", "manifest.json"]}
        for generation in [previous["indexes"] if previous else {}, indexes]:
            for name, data in generation.items():
                hashed = distribution / Path(name).parent / "by-hash/SHA256" / digest(data)
                hashed.parent.mkdir(parents=True, exist_ok=True)
                hashed.write_bytes(data)
        release = "".join(f"{key}: {value}\n" for key, value in release_identity(cfg).items())
        release += "Date: " + email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc), usegmt=True) + "\nAcquire-By-Hash: yes\nSHA256:\n"
        release += "".join(f" {digest(data)} {len(data)} {name}\n" for name, data in sorted(indexes.items()))
        (distribution / "Release").write_text(release)
        for target, mode in [("InRelease", "--clearsign"), ("Release.gpg", "--detach-sign")]:
            run("gpg", "--batch", "--yes", "--digest-algo", "SHA256", "--local-user", args.signing_key,
                "--output", str(distribution / target), mode, str(distribution / "Release"))
        delivered_trust = work / "delivered.gpg"
        keyring(extracted_key, delivered_trust)
        verify_signed((distribution / "InRelease").read_bytes(), delivered_trust, work)
        run("gpgv", "--keyring", str(delivered_trust), str(distribution / "Release.gpg"), str(distribution / "Release"))
        fingerprints = run("gpg", "--batch", "--show-keys", "--with-colons", str(extracted_key)).decode()
        primary = args.signing_key
        public_records = [line.split(":") for line in fingerprints.splitlines()]
        public_primaries = [public_records[i + 1][9] for i, entry in enumerate(public_records[:-1])
                            if entry[0] == "pub" and public_records[i + 1][0] == "fpr"]
        if not re.fullmatch(r"[A-F0-9]{40}", primary) or primary not in public_primaries:
            raise ValueError("Expected signing fingerprint missing from delivered public key")
        replacements = {"VERSION": latest, "FINGERPRINT": primary, "BOOTSTRAP": source_package.name,
                        "BOOTSTRAP_SHA256": digest(source_package.read_bytes()), "URI": cfg["uri"]}
        template = (ROOT / "distribution/apt/index.html").read_text()
        for key, value in replacements.items():
            template = template.replace("{{" + key + "}}", html.escape(value))
        if "{{" in template:
            raise ValueError("Unresolved guide template")
        (site / "index.html").write_text(template)
        shutil.copyfile(extracted_key, site / "clawd-on-desk.asc")
        (args.output / "index.html").write_text('<!doctype html><meta http-equiv="refresh" content="0;url=apt/"><a href="apt/">Clawd APT</a>')
        (args.output / ".nojekyll").touch()
        total = sum(p.stat().st_size for p in args.output.rglob("*") if p.is_file())
        if total > cfg["site_limit_bytes"]:
            raise ValueError(f"Site size {total} exceeds limit")
        print(json.dumps({"latest": latest, "site_bytes": total, "bootstrap_sha256": replacements["BOOTSTRAP_SHA256"], "fingerprint": primary}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("download")
    download.add_argument("--output", required=True, type=Path)
    commands.add_parser("latest")
    signing = commands.add_parser("validate-signing-key")
    signing.add_argument("--fingerprint", required=True)
    live = commands.add_parser("verify-live")
    live.add_argument("--config", type=Path, default=ROOT / "distribution/apt/config.json")
    live.add_argument("--public-key", type=Path, default=ROOT / "distribution/apt/archive-key.asc")
    stage = commands.add_parser("build")
    stage.add_argument("--input", type=Path, required=True)
    stage.add_argument("--output", type=Path, required=True)
    stage.add_argument("--config", type=Path, default=ROOT / "distribution/apt/config.json")
    stage.add_argument("--public-key", type=Path, required=True)
    stage.add_argument("--signing-key", required=True)
    stage.add_argument("--previous-url")
    stage.add_argument("--allow-initial", action="store_true")
    args = parser.parse_args()
    if args.command == "download":
        download_releases(args.output.resolve())
    elif args.command == "latest":
        print(releases()[0]["tag_name"][1:])
    elif args.command == "validate-signing-key":
        validate_signing_subkey(args.fingerprint)
    elif args.command == "verify-live":
        verify_live(args.config, args.public_key)
    else:
        args.input = args.input.resolve()
        args.output = args.output.resolve()
        args.public_key = args.public_key.resolve()
        build(args)


if __name__ == "__main__":
    main()
