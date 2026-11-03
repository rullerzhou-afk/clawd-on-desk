# APT source maintenance

The source is an opt-in distribution channel for existing official `amd64` release assets. Its contract is `stable/main`, Debian 12/13 and Ubuntu 22.04/24.04. See [user migration](apt-setup.md) and the [reviewed plan](../plans/2026-10-24-apt-linux-updates.md).

## Activation record

**Activated 2026-10-31: the key was provisioned, the first production publication succeeded, and the live acceptance below passed. v1.5.0, the first app release through the source, was published the same day and its release-event publication passed. Still to verify: the "Update with APT" button on a real Linux desktop.**

- Primary fingerprint: `B315327BEFF98206ECC682875AC75344D51B2887` (RSA 4096, certification only, expires 2036-10-28).
- Signing subkey: `B9BC4B583AB5651BEDCA5EB91757F4700BC2A311` (RSA 4096, expires 2029-10-30). Renew it by 2029-04-30, because installed sources only learn about new keys by upgrading `clawd-apt-source`.
- Public bundle: `distribution/apt/archive-key.asc`. The primary secret and revocation certificate are kept offline in an encrypted disk image. Only the signing subkey is in the `apt-production` environment.
- Preview run: [41150329833](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/41150329833).
- First production run (`publish=true`, `initial=true`, main `8b9a54bc`): [41155483770](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/41155483770). Total 53 seconds, deploy job 20 seconds.
- Published: Clawd 1.4.0, 1.3.0, 1.2.0 and `clawd-apt-source` 1.0.0. The 112,008,612-byte 1.4.0 package is served with the same size and SHA-256 as the release asset.
- Host: `https://apt.clawdondesk.com/`. The certificate was issued before the first deployment, HTTPS is enforced and the domain is verified. The old `rullerzhou-afk.github.io/clawd-on-desk/` address returns 301 to the new host.
- Headers: `server: GitHub.com`, `cache-control: max-age=600`, `x-cache` HIT/MISS, HTTP/2.
- Live acceptance: [41155929686](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/41155929686). Each system followed the guide: checksum check of the source package, `apt install`, `apt update --error-on=any`, candidate check, upgrade, later-update commands, `apt remove` keeps the source, `apt purge` removes source and key, and Clawd stays installed.

| System | apt / verifier | Upgrade 1.3.0 to 1.4.0 | Profile kept | Sandbox | App answered `/state` |
|---|---|---|---|---|---|
| Ubuntu 22.04.5 VM | 2.4.14 / gpgv 2.2.27 | pass | yes | root 755, AppArmor enabled | yes |
| Ubuntu 24.04.5 VM | 2.8.3 / gpgv 2.4.4 | pass | yes | root 755, AppArmor profile installed | yes |
| Debian 12 container | 2.6.1 / gpgv 2.2.40 | pass | yes | root 4755 | not run |
| Debian 13 container | 3.0.3 / sqv | pass | yes | root 4755 | not run |

- Tagged-build gate on the `ubuntu-latest` image (Ubuntu 26.04.1): `APT ready: authenticated repository and guide; version 1.4.0`.

First app release (v1.5.0):

- Second publication, rehearsed before tagging (`publish=true`, `initial=false`, main `e752627d`, same packages): [41170253019](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/41170253019), 63 seconds. The acceptance above passed again: [41170380140](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/41170380140).
- Publish request from the tag (`gh workflow run publish-apt.yml --ref v1.5.0 -f publish=true`): [41173233652](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/41173233652). Both jobs were skipped and the site did not change.
- Release event: `Request APT publication` [41173720229](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/41173720229) started the publisher [41173727453](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/41173727453), and 1.5.0 was live about 75 seconds after the release. The source keeps 1.5.0, 1.4.0 and 1.3.0 and retired 1.2.0. The previous `Packages.gz` stayed available by hash after the index changed.
- A 1.3.0 to 1.5.0 upgrade through the source passed on the same four systems: [41173899467](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/41173899467).

**Still to verify** (not yet done):

- On a real Linux desktop: the update notification, the "Update with APT" button, and opening the guide.

Never put secret-key material in the checkout, logs or artifacts.

The source's address is `https://apt.clawdondesk.com/`: a DNS-only Cloudflare CNAME to `rullerzhou-afk.github.io`, with the files on this repository's Pages site. The hostname is written into every installed source, so it is one we own: hosting can later move by repointing DNS, without touching installed sources. Keep the record DNS-only, because GitHub cannot issue the certificate behind Cloudflare's proxy, and keep `clawdondesk.com` on auto-renew, because a lapsed domain breaks every installed source. This setup does not alter clawdondesk.com hosting.

## First activation, in order

1. Review and merge the implementation. The release dispatcher must enter `main` **before** the next tag is created; release events read the YAML in the tag, not the latest default branch.
2. Protect `main`. Create an `apt-production` Actions environment that permits deployments from **only the `main` branch**, not release tags. Use this environment for both signing and Pages deployment. Add approval requirements if desired. Add the DNS-only `apt` CNAME in Cloudflare and verify `clawdondesk.com` under the account's Pages settings, so that nobody else can claim the subdomain. Keep the verification TXT record in place, and if the domain has CAA records, one must allow `letsencrypt.org`. Configure Pages to use GitHub Actions with custom domain `apt.clawdondesk.com`, and enforce HTTPS once the certificate is issued. Publication fails until then: a TLS error is not the 404 that `initial` permits.
3. Generate a dedicated RSA 3072-bit or stronger OpenPGP certification primary and signing subkey using GnuPG on a trusted administrative machine. Keep the primary secret offline with an encrypted backup and revocation certificate. Give the signing subkey a documented expiry and set an operational renewal reminder outside the app. Test the public key on the oldest supported APT before publishing.
4. Commit the armored public bundle and full primary fingerprint in this activation record. Export **only the signing secret subkey** (GnuPG `--export-secret-subkeys PRIMARY_FINGERPRINT`) into environment secret `APT_SIGNING_SUBKEY`. The export must contain a stub, not usable primary secret material. CI checks `sec` availability before signing. Use a dedicated CI subkey without an interactive passphrase; the Actions secret/environment supplies access control. Put the uppercase 40-character primary fingerprint in environment variable `APT_FINGERPRINT`. The secret is never a repository-wide secret.
5. Run **Publish APT source** with `publish=false`. This uses a disposable key and uploads a preview artifact, never production secrets or Pages. Inspect the generated guide, source package, package list and size. Do not install a preview source package on a normal machine.
6. On `main`, run the same workflow with `publish=true`, `initial=true` exactly for the first activation. It publishes the latest existing stable releases (currently 1.4.0, 1.3.0, 1.2.0); no new app release is required. `initial` permits only a 404 for the previous InRelease. Other prior-site, authentication and validation errors still fail.
7. Verify the deployed HTTPS URL and public key fingerprint. On a disposable supported amd64 system, follow the guide verbatim, confirm `apt update` authenticates, `apt-cache policy` selects the expected release, and install/upgrade an older real Clawd package. Confirm profile retention, sandbox permissions, AppArmor behavior and startup. Record deployment duration, cache headers, and a subsequent complete-snapshot transition with old by-hash URLs still working.
8. Test the release dispatcher invokes the main workflow and that a tag ref cannot enter `apt-production`. Future publication can be recovered with manual `publish=true`, `initial=false`. Only after the source and guide work should an app version containing the APT button be released.

Tagged app builds enforce this ordering with `repository.py verify-live`: the reviewed production public key must exist, the live repository must authenticate with it, and the guide must be reachable. Manual validation builds remain available before activation. If this gate fails, restore or activate the source before retrying the release; do not publish an app pointing users at a missing guide.

## Publication contract

`apt-release-dispatch.yml` has `actions:write` only; it has no checkout, secrets or Pages permission and passes no release target. `publish-apt.yml` resolves targets itself, runs serially without canceling an active publish, and permits production only from the canonical main workflow and protected environment. The environment restriction must actually be configured; a YAML name alone is not protection.

The builder:

- Resolves all stable numeric `vMAJOR.MINOR.PATCH` releases and selects the three highest versions. Drafts/prereleases and GitHub's mutable latest pointer are not authority for sorting.
- Requires exact official amd64 asset name, bounded size, and a GitHub-provided SHA-256 digest. Downloads must match size/hash. `dpkg-deb` verifies package name/version/architecture. Assets are not rebuilt.
- Authenticates previous `InRelease`, its manifest and indexes before reuse. A signed history prevents replacing already published `(name, version, architecture)` bytes; downgrading the highest app version is rejected. Key/config changes require a new bootstrap version. There is no automatic rollback override.
- Builds `Packages`, `Packages.gz`, `Release`, `InRelease`, `Release.gpg`, by-hash paths and a bilingual guide as one snapshot. The current and previous generation of indexes are retained. Three app releases and the previous source-package version remain available; stale indexes beyond that window require `apt update`.
- Uses `gpgv` with the exact public key extracted from the delivered source package to verify both signature forms. Signing uses SHA-256. Only public artifacts leave the temporary signing directory, which is removed on success/failure.
- Rejects a site larger than 700 MiB. A final fresh API lookup rejects a snapshot overtaken by another stable release. Only the completed verified Pages artifact is deployed; failed build/sign/validation leaves the last site intact.

The final API lookup is a pre-deployment freshness check, not an atomic transaction with release publication. A newer release published immediately afterward will enqueue another serialized run; the current run can briefly expose its previous latest version, but cannot overwrite a newer completed deployment from this workflow. GitHub concurrency may replace a queued request; each eventual run resolves latest again.

Keep `Origin`, `Label`, `Suite`, `Codename`, architectures and components stable. Changing identity fields makes APT request explicit confirmation and is rejected by the builder. `Acquire-By-Hash: yes` plus the previous generation limits CDN transition races. A prior signed snapshot too old for retained package URLs needs a fresh index.

No short `Valid-Until` is used: infrequent application releases should not expire a healthy repository. This means signatures establish integrity/authenticity but not repository freshness; an attacker replaying an older signed snapshot is not detected by a new client solely from metadata. The publication ledger detects rollback relative to the authenticated site seen by the publisher, not an independently stored transparency log.

## Bootstrap ownership and changes

`clawd-apt-source` has no maintainer scripts and owns exactly these conffiles:

- `/etc/apt/keyrings/clawd-on-desk.asc`
- `/etc/apt/sources.list.d/clawd-on-desk.sources`
- `/etc/apt/preferences.d/clawd-on-desk.pref`

The `/etc` key location intentionally differs from the usual package-owned `/usr/share/keyrings`: plain dpkg remove must retain key and source together. `apt remove` leaves the source active in rc state and stops bootstrap key updates; `apt purge` is the documented removal operation. Keep the source and preference templates unchanged unless a migration is necessary. Normal dpkg semantics preserve edits, `Enabled: no`, and deleted files. A user-edited keyring may require manual conffile resolution during key updates; never force replacement.

The pin permits the two named packages at priority 500 and all others at -1 using `origin "apt.clawdondesk.com"`. It applies to that **whole host**, so keep the hostname dedicated to this source. Tests place a higher-version unrelated `bash` package in a signed fixture and assert it has no install candidate.

`bootstrap_version` and `source_date_epoch` are reviewed inputs in `distribution/apt/config.json`. The same version must reproduce the same bytes. Bump the version for every key/template/control change; if a dpkg toolchain change affects archive bytes, bump the version rather than weakening the immutable package check.

## Key renewal and rotation

Renew well before expiry. Keep offline primary/backup ownership documented, and verify exported public/subkey fingerprints before changing Actions secrets.

For a new primary key, first publish a bumped source package containing **both old and new public keys**, still signing repository metadata with the old valid signing key. Allow users time to receive the overlap. Then switch the signing subkey and `APT_FINGERPRINT` to the new key; keep both public keys so prior metadata remains verifiable. The public bundle bytes can remain identical for that switch. Remove the old key only in another versioned bootstrap after a documented migration window; expired or compromised clients may need manual HTTPS bootstrap recovery. Never silently replace key bytes under the same bootstrap version.

A compromised signing key requires revocation/incident handling and a new reviewed trust path. Do not use an unsigned fallback, `apt-key`, `trusted=yes`, or `--allow-unauthenticated`.

## First app release and old-user notice

Retain `.deb` in `latest-linux.yml`; old installations with a functioning privileged updater can still bootstrap into the new app. Do not rewrite already published 1.4.0 notes. Include this text in the first release containing the new app behavior, with the source already live:

> **Linux `.deb` updates now use APT.** Existing users can add the official source once using the [migration guide](https://apt.clawdondesk.com/), even if the old in-app update failed. Quit Clawd before updating, then reopen it. AppImage keeps its in-app updater.

> **Linux `.deb` 改用 APT 更新。** 旧用户可按[迁移指南](https://apt.clawdondesk.com/#chinese)接入一次官方软件源，无需先修好旧版应用内更新。更新前请退出 Clawd，完成后重新打开。AppImage 保留应用内更新。

README and setup/limitations links are included in this change. A response to issue #1221 is a separate external communication and is not posted by the build or this implementation.

## Capacity and recovery

GitHub Pages allows a published site up to 1 GB and has an approximately 100 GB/month soft bandwidth limit; at around 112 MB per app package this is roughly 900 complete downloads. The 700 MiB build cap protects site size, not bandwidth. Track distribution traffic operationally and move to dedicated static hosting/CDN if adoption outgrows Pages. Repointing the `apt` record is enough when the new host serves the same paths. Changing the hostname itself needs a versioned source/pin migration; preserve old hosting during the transition.

On a failed run, inspect validation output and retry after fixing the cause. The existing site remains available. If deployment succeeds but serving is unhealthy, redeploy the last known good Pages artifact as an explicit maintainer recovery and document it; normal publication intentionally rejects version rollback. Do not mutate a public package in place.

## Validation scope

`APT validation` tests real APT/GPG/dpkg behavior on the supported distro matrix, builds current Linux package artifacts, and upgrades real previously published Clawd packages on a disposable amd64 runner. Tests cover authentication, tampering, package pinning, bootstrap reproducibility, configuration lifecycle, prior by-hash reuse, immutable bytes and rollback rejection.

Container/runner success does not claim desktop GUI acceptance, actual running-app replacement behavior, AppImage Download/Restart Now/Later on a real desktop, or live Pages/CDN transition acceptance. Those must be recorded separately before the corresponding release/production acceptance.

References: [Debian third-party repositories](https://wiki.debian.org/DebianRepository/UseThirdParty), [repository format](https://wiki.debian.org/DebianRepository/Format), [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
