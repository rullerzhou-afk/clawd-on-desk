#!/usr/bin/env python3
"""Real APT/GPG/dpkg tests; all state is disposable, no system source changes."""
import contextlib
import functools
import gzip
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("repository", ROOT / "scripts/apt/repository.py")
repo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repo)


def command(*args, env=None, cwd=None, success=True):
    result = subprocess.run(args, env=env, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if success and result.returncode:
        raise AssertionError(f"{args[0]} failed ({result.returncode}):\n{result.stdout.decode()}")
    return result


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # These tests mutate signed fixtures within one filesystem timestamp
        # second; force retrieval instead of a misleading conditional 304.
        if "If-Modified-Since" in self.headers:
            del self.headers["If-Modified-Since"]
        super().do_GET()

    def log_message(self, *_):
        pass


class AptRepository(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="clawd-apt-tests-")
        cls.base = Path(cls.temp.name)
        cls.old_env = dict(os.environ)
        home = cls.base / "gnupg"
        home.mkdir(mode=0o700)
        os.environ["GNUPGHOME"] = str(home)
        os.environ["PATH"] += ":/usr/sbin:/sbin"
        command("gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "Clawd disposable test <test@example.invalid>", "rsa3072", "cert", "1d")
        keys = command("gpg", "--with-colons", "--list-keys").stdout.decode()
        cls.fingerprint = next(line.split(":")[9] for line in keys.splitlines() if line.startswith("fpr:"))
        command("gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-add-key", cls.fingerprint, "rsa3072", "sign", "1d")
        try:
            repo.validate_signing_subkey(cls.fingerprint)
        except ValueError:
            pass
        else:
            raise AssertionError("Full primary secret must be rejected for production")
        cls.public = cls.base / "public.asc"
        cls.public.write_bytes(command("gpg", "--armor", "--export", cls.fingerprint).stdout)
        subkeys = command("gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--export-secret-subkeys", cls.fingerprint).stdout
        command("gpgconf", "--kill", "gpg-agent")
        signing_home = cls.base / "signing-only"
        signing_home.mkdir(mode=0o700)
        os.environ["GNUPGHOME"] = str(signing_home)
        repo.run("gpg", "--batch", "--import", data=subkeys)
        repo.validate_signing_subkey(cls.fingerprint)
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(cls.base)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.cfg = json.loads((ROOT / "distribution/apt/config.json").read_text())
        cls.cfg["uri"] = cls.url + "/published/apt"
        cls.config = cls.base / "config.json"
        cls.config.write_text(json.dumps(cls.cfg))
        cls.inputs = cls.base / "inputs"
        cls.inputs.mkdir()
        cls.make_package(cls.inputs, "clawd-on-desk", "1.3.0")
        cls.make_package(cls.inputs, "clawd-on-desk", "1.4.0")
        cls.write_manifest(cls.inputs)
        cls.published = cls.base / "published"
        cls.stage(cls.published)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        command("gpgconf", "--kill", "gpg-agent", success=False)
        os.environ.clear()
        os.environ.update(cls.old_env)
        cls.temp.cleanup()

    @staticmethod
    def make_package(destination, name, ver, payload="fixture"):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "DEBIAN").mkdir()
            (root / "DEBIAN/control").write_text(f"Package: {name}\nVersion: {ver}\nArchitecture: amd64\nMaintainer: Test <test@example.invalid>\nDescription: disposable test\n")
            (root / "usr/share").mkdir(parents=True)
            (root / "usr/share" / name).write_text(payload)
            package = destination / f"{name}_{ver}_amd64.deb"
            command("dpkg-deb", "--root-owner-group", "--build", str(root), str(package))
            return package

    @staticmethod
    def write_manifest(directory):
        items = [{"version": p.name.split("_")[1], "file": p.name, "sha256": repo.digest(p.read_bytes())} for p in directory.glob("*.deb")]
        (directory / "manifest.json").write_text(json.dumps(items))

    @classmethod
    def stage(cls, output, previous=None, inputs=None, config=None):
        with contextlib.redirect_stdout(None):
            repo.build(types.SimpleNamespace(config=config or cls.config, input=inputs or cls.inputs,
                output=output, public_key=cls.public, signing_key=cls.fingerprint,
                previous_url=previous, allow_initial=False))

    def setUp(self):
        self.work = Path(tempfile.mkdtemp(dir=self.base, prefix="case-"))

    def client(self, site=None):
        root = self.work / "client"
        for name in ("etc/apt/sources.list.d", "etc/apt/preferences.d", "etc/apt/keyrings", "var/lib/apt/lists/partial", "var/lib/dpkg", "var/cache/apt/archives/partial", "downloads"):
            (root / name).mkdir(parents=True)
        (root / "var/lib/dpkg/status").touch()
        (root / "etc/apt/keyrings/clawd-on-desk.asc").write_bytes(self.public.read_bytes())
        uri = self.url + "/" + (site or self.published).relative_to(self.base).as_posix() + "/apt"
        templates = repo.source_templates({**self.cfg, "uri": uri})
        for name, content in templates.items():
            content = content.replace("/etc/apt/keyrings/", str(root) + "/etc/apt/keyrings/")
            (root / name).write_text(content)
        config = root / "isolated.conf"
        config.write_text(f'Dir "{root}";\nDir::Etc "{root}/etc/apt";\nDir::Etc::parts "-";\nDir::Etc::main "-";\nAPT::Architecture "amd64";\nAPT::Architectures {{ "amd64"; "i386"; }};\nAPT::Sandbox::User "{os.environ.get("USER", "root")}";\nAcquire::Languages "none";\n')
        env = {**os.environ, "APT_CONFIG": str(config)}
        return root, env

    def test_apt_refresh_candidates_and_package_checksum(self):
        root, env = self.client()
        update = command("apt-get", "update", "--error-on=any", env=env)
        self.assertNotIn("doesn't support architecture", update.stdout.decode())
        policy = command("apt-cache", "policy", "clawd-on-desk", "clawd-apt-source", env=env).stdout.decode()
        self.assertIn("Candidate: 1.4.0", policy)
        self.assertIn("Candidate: 1.0.0", policy)
        command("apt-get", "download", "clawd-on-desk", env=env, cwd=root / "downloads")
        package = self.published / "apt/pool/main/clawd-on-desk_1.4.0_amd64.deb"
        original = package.read_bytes()
        try:
            package.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
            for p in (root / "downloads").glob("*"):
                p.unlink()
            failed = command("apt-get", "download", "clawd-on-desk", env=env, cwd=root / "downloads", success=False)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("Hash Sum mismatch", failed.stdout.decode())
        finally:
            package.write_bytes(original)

    def test_signature_tampering_rejected_without_discarding_last_good_index(self):
        root, env = self.client()
        command("apt-get", "update", "--error-on=any", env=env)
        signed = self.published / "apt/dists/stable/InRelease"
        original = signed.read_bytes()
        try:
            signed.write_bytes(original.replace(b"Label: Clawd", b"Label: Forged", 1))
            with self.assertRaises(subprocess.CalledProcessError):
                self.stage(self.work / "forged-prior", self.url + "/published/apt")
            result = command("apt-get", "update", "--error-on=any", env=env, success=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Candidate: 1.4.0", command("apt-cache", "policy", "clawd-on-desk", env=env).stdout.decode())
        finally:
            signed.write_bytes(original)

    def test_wrong_key_cannot_authenticate_source(self):
        other_home = self.work / "other-key"
        other_home.mkdir(mode=0o700)
        other_env = {**os.environ, "GNUPGHOME": str(other_home)}
        command("gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "Other test <other@example.invalid>", "rsa3072", "sign", "1d", env=other_env)
        try:
            wrong_key = command("gpg", "--armor", "--export", env=other_env).stdout
            root, env = self.client()
            (root / "etc/apt/keyrings/clawd-on-desk.asc").write_bytes(wrong_key)
            result = command("apt-get", "update", "--error-on=any", env=env, success=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("Candidate: 1.4.0", command("apt-cache", "policy", "clawd-on-desk", env=env).stdout.decode())
        finally:
            command("gpgconf", "--kill", "gpg-agent", env=other_env)

    def test_unrelated_higher_version_is_pinned_out(self):
        site = self.work / "hostile"
        shutil.copytree(self.published, site)
        self.make_package(site / "apt/pool/main", "bash", "99.0.0")
        dist = site / "apt/dists/stable"
        data = repo.run("dpkg-scanpackages", "--multiversion", "pool", "/dev/null", cwd=site / "apt")
        (dist / "main/binary-amd64/Packages").write_bytes(data)
        (dist / "main/binary-amd64/Packages.gz").write_bytes(gzip.compress(data, mtime=0))
        release = (dist / "Release").read_text().split("SHA256:\n")[0] + "SHA256:\n"
        for name in ("main/binary-amd64/Packages", "main/binary-amd64/Packages.gz", "manifest.json"):
            data = (dist / name).read_bytes()
            sha = repo.digest(data)
            (dist / Path(name).parent / "by-hash/SHA256" / sha).write_bytes(data)
            release += f" {sha} {len(data)} {name}\n"
        (dist / "Release").write_text(release)
        command("gpg", "--batch", "--yes", "--local-user", self.fingerprint, "--output", str(dist / "InRelease"), "--clearsign", str(dist / "Release"))
        root, env = self.client(site)
        command("apt-get", "update", "--error-on=any", env=env)
        policy = command("apt-cache", "policy", "bash", env=env).stdout.decode()
        self.assertIn("Candidate: (none)", policy)
        self.assertIn("99.0.0 -1", policy)
        self.assertNotEqual(command("apt-get", "--simulate", "install", "bash", env=env, success=False).returncode, 0)

    def test_reproducible_bootstrap_and_authenticated_prior_indexes(self):
        with contextlib.redirect_stdout(None):
            repo.verify_live(self.config, self.public)
        with self.assertRaisesRegex(ValueError, "not activated"):
            repo.verify_live(self.config, self.work / "missing-public.asc")
        target = self.work / "next"
        self.stage(target, self.url + "/published/apt")
        package = "apt/pool/main/clawd-apt-source_1.0.0_all.deb"
        self.assertEqual((target / package).read_bytes(), (self.published / package).read_bytes())
        old = self.published / "apt/dists/stable/main/binary-amd64/Packages"
        self.assertEqual((target / "apt/dists/stable/main/binary-amd64/by-hash/SHA256" / repo.digest(old.read_bytes())).read_bytes(), old.read_bytes())

    def test_rejects_same_version_changed_bytes_rollback_and_identity_change(self):
        inputs = self.work / "input"
        shutil.copytree(self.inputs, inputs)
        self.make_package(inputs, "clawd-on-desk", "1.4.0", "changed")
        self.write_manifest(inputs)
        with self.assertRaisesRegex(ValueError, "bytes changed"):
            self.stage(self.work / "changed", self.url + "/published/apt", inputs)
        (inputs / "clawd-on-desk_1.4.0_amd64.deb").unlink()
        self.write_manifest(inputs)
        with self.assertRaisesRegex(ValueError, "rollback"):
            self.stage(self.work / "rollback", self.url + "/published/apt", inputs)
        cfg = self.work / "changed.json"
        cfg.write_text(json.dumps({**self.cfg, "origin": "Changed"}))
        with self.assertRaisesRegex(ValueError, "identity changed"):
            self.stage(self.work / "identity", self.url + "/published/apt", config=cfg)
        cfg.write_text(json.dumps({**self.cfg, "bootstrap_version": "0.9.0"}))
        with self.assertRaisesRegex(ValueError, "bootstrap version rollback"):
            self.stage(self.work / "old-bootstrap", self.url + "/published/apt", config=cfg)
        self.assertEqual((self.published / "apt/dists/stable/main/binary-amd64/Packages").read_bytes(),
                         repo.run("dpkg-scanpackages", "--multiversion", "pool", "/dev/null", cwd=self.published / "apt"))

    def test_republication_retains_the_previous_bootstrap_version(self):
        cfg = self.work / "upgrade.json"
        cfg.write_text(json.dumps({**self.cfg, "bootstrap_version": "1.0.1"}))
        upgraded = self.work / "upgraded"
        self.stage(upgraded, self.url + "/published/apt", config=cfg)
        repeated = self.work / "repeated"
        previous_url = self.url + "/" + upgraded.relative_to(self.base).as_posix() + "/apt"
        self.stage(repeated, previous_url, config=cfg)
        for ver in ("1.0.0", "1.0.1"):
            path = f"apt/pool/main/clawd-apt-source_{ver}_all.deb"
            self.assertEqual((repeated / path).read_bytes(), (upgraded / path).read_bytes())
        root, env = self.client(repeated)
        command("apt-get", "update", "--error-on=any", env=env)
        policy = command("apt-cache", "policy", "clawd-apt-source", env=env).stdout.decode()
        self.assertIn("Candidate: 1.0.1", policy)
        command("apt-get", "download", "clawd-apt-source=1.0.0", env=env, cwd=root / "downloads")

    def test_bootstrap_conffile_lifecycle_in_disposable_dpkg_root(self):
        root = self.work / "dpkg-root"
        (root / "var/lib/dpkg").mkdir(parents=True)
        # Supply installed apt dependency metadata only; never run its scripts.
        shutil.copyfile("/var/lib/dpkg/status", root / "var/lib/dpkg/status")
        package = self.published / "apt/pool/main/clawd-apt-source_1.0.0_all.deb"
        dpkg = ["dpkg", "--root=" + str(root)]
        if os.geteuid() != 0:
            dpkg.append("--force-not-root")
        command(*dpkg, "--install", str(package))
        names = ["etc/apt/keyrings/clawd-on-desk.asc", *repo.source_templates(self.cfg)]
        for name in names:
            self.assertTrue((root / name).is_file())
        source = root / "etc/apt/sources.list.d/clawd-on-desk.sources"
        source.write_text(source.read_text() + "Enabled: no\n")
        pref = root / "etc/apt/preferences.d/clawd-on-desk.pref"
        pref.unlink()
        config = {**self.cfg, "bootstrap_version": "1.0.1"}
        stage = self.work / "upgrade"
        stage.mkdir()
        upgrade, _ = repo.bootstrap(config, self.public, stage, stage)
        installed = command(*dpkg, "--install", str(upgrade))
        self.assertNotIn("Configuration file", installed.stdout.decode())
        self.assertIn("Enabled: no", source.read_text())
        self.assertFalse(pref.exists())
        command(*dpkg, "--remove", "clawd-apt-source")
        self.assertTrue(source.exists())
        self.assertTrue((root / names[0]).exists())
        command(*dpkg, "--purge", "clawd-apt-source")
        for name in names:
            self.assertFalse((root / name).exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
