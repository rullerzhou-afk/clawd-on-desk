# Linux APT setup and migration

Clawd's official APT source supports **Debian 12/13 and Ubuntu 22.04/24.04, amd64**. It is optional. AppImage retains its in-app download/restart updater; Homebrew-managed installations should use `brew upgrade --cask clawd-on-desk`.

The [APT setup page](https://apt.clawdondesk.com/) supplies the current source package, checksum and public-key fingerprint. If the source has not been activated or is temporarily unavailable, use the [official release `.deb`](https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest) manually.

## Existing `.deb` users, including 1.3 and 1.4

You can adopt APT directly; a successful update through the old app is **not** required. Clawd's existing user profile is retained.

1. Confirm `dpkg --print-architecture` returns `amd64`.
2. Quit Clawd. If an older app asks to install an already downloaded update on quit, cancel that authorization prompt.
3. Open the [setup page](https://apt.clawdondesk.com/), download its `clawd-apt-source_<version>_all.deb`, and verify the exact SHA-256 shown there. For additional first-install verification, compare the public fingerprint against the [maintainer activation record](apt-maintenance.md#activation-record).
4. In the download directory, install the exact filename you downloaded:

```sh
sudo apt install ./clawd-apt-source_<version>_all.deb
sudo apt update
sudo apt install clawd-on-desk
```

5. Reopen Clawd. The same instructions install Clawd on a new machine.

The source package contains no maintainer scripts. It owns only its key, deb822 source and pin under `/etc/apt`. Adding the source does not change unattended-upgrade policy. The HTTPS setup page is the initial trust entry point; a checksum from the same site is not an independent defense against compromise of the entire site.

## Later updates

Quit Clawd, update, then reopen:

```sh
sudo apt update
sudo apt install --only-upgrade clawd-on-desk clawd-apt-source
```

The `.deb` app shows release notifications and opens the APT guide; it does not run a privileged installer or install updates on exit. A notification can precede source publication. Inspect `apt-cache policy clawd-on-desk` and retry `apt update` after a few minutes. APT may replace files while an app runs, so always quit first.

## Disable or remove the source

To pause, add `Enabled: no` to `/etc/apt/sources.list.d/clawd-on-desk.sources`. Updates preserve administrator edits and deliberate deletion of conffiles.

To remove the source and its trust key while keeping Clawd installed:

```sh
sudo apt purge clawd-apt-source
sudo apt update
```

Use **purge**. Plain `apt remove` keeps the configuration, key and pin: the source remains active, but the removed source package no longer receives key updates. All three files are conffiles, so removal never leaves an enabled source referring to a missing key.

The pin permits only `clawd-on-desk` and `clawd-apt-source` from `apt.clawdondesk.com`. This is a hostname-wide restriction, including other paths on the same host. The public key is scoped through `Signed-By`, never installed as a globally trusted APT key.

## Recovery

- **Old index or missing retained package:** run `sudo apt update`. The source retains three app releases, not the full historical archive.
- **Signature error or expired key:** stop and check the official setup page/repository. Before expiry, a normal source-package upgrade can deliver overlapping keys. After expiry, verify and install the newly versioned source package from the HTTPS page. Never disable authentication or use `trusted=yes`.
- **Unavailable source:** keep the current app or temporarily disable the source. Manual `.deb` installation remains supported: quit Clawd and run `sudo apt install ./Clawd-on-Desk-VERSION-amd64.deb` using the matching official release file.

[中文指南](apt-setup.zh-CN.md) · [Maintenance and release automation](apt-maintenance.md)
