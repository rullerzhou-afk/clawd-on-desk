# Official APT distribution and Linux update migration

Status: revised after Claude review and independently accepted for implementation. Owner: 云宝. Requested by 鹿鹿, 2026-10-24. Baseline: `6573eab7`. Review and adjudication: `docs/investigations/apt-linux-updates-2026-10-24/`.

## Goal and product behavior

Deliver a maintained official APT source, release publication automation, and a one-time migration path for existing `.deb` users. Preserve AppImage in-app updates and existing Windows/macOS/source behavior. Issue #1221 reports `pkexec` exit 127 during installation; the exact authentication failure is unconfirmed. This work moves Debian package installation to APT; it does not promise password-free installation or enable unattended upgrades.

Users of packaged `.deb` receive update notifications and an **Update with APT** action opening a first-party setup/update guide. The app never invokes privileged package installation, downloads through DebUpdater, or installs on quit. The guide covers both already-configured users (`sudo apt update`, `sudo apt install --only-upgrade clawd-on-desk`) and users still needing the source. Legacy 1.3/1.4 users can follow the same guide without first successfully updating the app.

## Distribution design

1. Host a static repository at `https://rullerzhou-afk.github.io/clawd-on-desk/apt/` using GitHub Pages Actions deployments. Repository Pages currently returns 404; no existing Pages website will be replaced. A custom domain is optional and outside the initial implementation. Existing clawdondesk.com hosting is untouched.
2. Initially support Debian 12/13 and Ubuntu 22.04/24.04, `amd64` only. A `stable/main` APT suite indexes architecture-independent source-setup packages and amd64 app packages in `binary-amd64`. Publish existing release assets byte-for-byte; require and verify the GitHub asset SHA-256 digest and validate package name, version, architecture, and regular file type using dpkg tooling before indexing. Do not rebuild the application during APT publication. Test older/newer APT consumers with a dedicated RSA 3072+ signing key.
3. Use `Packages`/`Packages.gz`, a checksum-bearing `Release`, and OpenPGP-signed `InRelease`/`Release.gpg`. Public key is scoped with `Signed-By`, never `apt-key` or `trusted=yes`. Keep a dedicated APT signing identity, separate from Apple credentials; public key/fingerprint are reviewed inputs, private material is a protected Actions secret. Document backup, renewal, and overlapping key rotation. Do not print/export private material into artifacts or logs.
4. Build one complete site artifact and deploy only after verification. Retain three newest stable application packages (current .deb is about 112 MB, so ~336 MB total), plus source-setup packages and small metadata, with a 700 MiB site size cap. Enable Acquire-By-Hash and retain authenticated prior-generation indexes. Authenticate prior InRelease and index hashes before reuse; fail on unexpected prior-site errors, package identity/hash changes, or version rollback. Sort strict numeric stable versions, not GitHub's latest pointer. Do not write binary payloads into Git history. A failed build/sign/test leaves the last published site intact. Serialize publication and recheck latest stable before deploying. A stale queued release requests a fresh latest snapshot, never its own old tag. Old client indexes outside retention require apt update. GitHub Pages' roughly 100 GB/month soft bandwidth allowance is only about 900 full app downloads: monitor manually and migrate the same repository contract to dedicated static hosting/CDN if required.
5. A repository `Release` will not initially have a short `Valid-Until`: infrequent app releases must not strand users behind expired metadata. This has the usual replay freshness limitation of third-party archives; signed checksums authenticate content, not freshness. Key expiration/rotation remains a maintenance obligation.

## One-time setup and old-user migration

- Publish a small `clawd-apt-source_<version>_all.deb` bootstrap package alongside the repository, with a stable download entry on the guide. It owns only its own keyring, deb822 `.sources`, and an APT pin restricting this origin to `clawd-on-desk` and `clawd-apt-source`. It is also indexed in the source for future key/config updates.
- Users explicitly download/install the bootstrap package using the system package manager, then run `apt update` and install/upgrade Clawd. New installs use the same setup path. The app package itself does not silently add a source or edit system update policy. No curl-to-shell and no new root helper in Electron.
- Bootstrap has no maintainer scripts and owns three conffiles under `/etc`: `apt/keyrings/clawd-on-desk.asc`, `apt/sources.list.d/clawd-on-desk.sources`, and `apt/preferences.d/clawd-on-desk.pref`. This deliberately differs from `/usr/share/keyrings` so dpkg remove retains both trust key and source. `apt remove` leaves the source active and stops bootstrap updates; **only `apt purge clawd-apt-source` removes the source**. Preserve edited/disabled/deleted configuration. Freeze source and pin templates; bump bootstrap version for any configuration/key change and build reproducibly. Pin the hostname (all paths on that host), permit only Clawd/bootstrap at priority 500 and reject other packages at -1. Test a hostile higher-version unrelated package. Never alter foreign sources or update policy.
- Guide is available as static HTML (English/Chinese) at `/apt/` and as checked-in documentation. Include public fingerprint verification, exact commands, distro/architecture scope, migration, removal, key renewal, and temporary source outage recovery. Tell users to quit Clawd before upgrading and reopen afterward; old versions may still ask to install a previously downloaded update on quit, which they should cancel before using APT. Do not tell users to disable authentication.
- App notifications link to a fixed first-party URL, not URLs supplied by release content. Manual and scheduled flows, tray/About entry points, and silent mode must agree. Notification must not claim the new version is installed or immediately available through APT if source publication is still catching up; the guide explains `apt-cache policy`/retry/manual fallback.

## App routing

- Add a small testable install-format classifier. First prove an AppImage mount: absolute APPIMAGE and APPDIR, with resourcesPath contained in APPDIR (not equal or a sibling prefix). Explicitly construct the exported AppImageUpdater class. Otherwise accept `resources/package-type` equal to `deb` for APT; all other packaged Linux formats get a fixed manual release fallback. An inherited foreign APPIMAGE is never enough. Source runs remain on the existing Git path. Add artifact checks for deb marker presence and AppImage marker absence; verified AppImage ownership remains decisive even if a shared build directory leaked the marker.
- For `.deb`, do not construct/register DebUpdater at startup; bypass all download/ready/install handlers, including `autoInstallOnAppQuit`. Use the existing GitHub release lookup and reminder scheduler for version discovery; continue to expose accurate available state.
- Keep AppImage in-app download/restart behavior and existing error diagnostics. Add localizations for all seven supported languages and avoid adding new persistent settings just for routing.

## Release workflow and deployment boundary

- Add a minimal release dispatcher (`released`, actions:write only, no checkout/secrets) that requests the publish workflow on main. The actual workflow uses workflow_dispatch and computes its own latest stable target; serialize with cancel-in-progress:false. Follow the existing release flow: tags create a draft, maintainer publication makes it eligible. Ignore prereleases/drafts and validate strict numeric stable versions.
- Signing/deployment run only from the canonical repository's main workflow and a protected environment limited to main, backed by branch protection. Import only a dedicated signing subkey into an ephemeral GNUPGHOME. Pull-request tests use disposable test keys and never production secrets. Verify with gpgv and the exact key bytes extracted from the generated bootstrap. Freeze Release Origin/Label/Suite/Codename. Test the dispatcher chain during initial activation; it must enter main before future release tags are made.
- Provide prepare-only/manual dry-run output before enabling publication. Missing production key, fingerprint, or Pages configuration is a clear setup failure, not a successful no-op or unsigned publish. Required inputs and exact initialization sequence go into maintainer docs.
- Production Pages/key configuration is prepared after code and acceptance checks. Any final approval needed for publishing is requested only with reviewable artifacts ready; do not merge or publish a new app release implicitly.
- Initial activation order: verify the account Pages site has no custom domain, publish existing stable binaries plus guide, verify HTTPS/APT/CDN, then release the app route change. The account Pages API also returned 404 on 2026-10-24. Provide migration links in all six READMEs, English/Chinese setup and limitations guides, runtime/release docs, and release-note instructions. Keep deb in latest-linux.yml so old versions that can update still self-bootstrap. A reply to #1221 is prepared but not posted without authorization.

## Implementation sequence

1. Claude reviews this plan read-only; 云宝 independently adjudicates findings and revises before code changes.
2. Implement repository generation and source-bootstrap packaging with deterministic inputs, bounded validation, signing verification, and docs/site generation; avoid introducing a general-purpose package hosting service.
3. Implement app format routing and localized APT notification flow.
4. Add release publication workflow, maintainer initialization instructions, migration docs, and focused tests.
5. Run local focused tests. Run Linux integration in isolated CI runners/containers: signed source refresh, bootstrap setup, old-to-new package upgrade, edited/disabled-source preservation, removal/purge, tampering/wrong key rejection, and failed publication preservation. Also exercise the actual released Clawd .deb in the Linux validation environment; a toy package alone is not proof of application packaging compatibility.
6. Independently review diff and evidence, use the same Claude session for implementation follow-up if a substantive design question remains, prepare a draft PR and attach it. Do not claim GUI/AppImage runtime acceptance without actual evidence.

## Acceptance and known initialization gaps

- Existing .deb 1.3/1.4 installation can adopt the source and upgrade while retaining its normal user profile; new installs work; no automatic source enrollment.
- `apt update` authenticates the official source, upgrade selects expected version/architecture, forged metadata/package bytes fail, and source setup/removal is reversible without altering unrelated repositories.
- Release publication is repeatable, stable-only, serialized, and deploys a verified complete snapshot; documented recovery retains the last good site and package versions.
- All .deb app update entry points avoid DebUpdater/root work and link to usable migration guidance. AppImage route stays on electron-updater; Windows/macOS/source tests remain green.
- Current machine has Node/Python but no discovered Docker/GPG CLI; Linux APT and production signing setup need an isolated Linux runner or a prepared toolchain. GitHub currently has Apple signing secrets only. Record any deployment or real-machine validation still pending instead of reporting it as finished.

## References

- `src/updater.js`, `src/i18n.js`, `test/updater.test.js`
- `.github/workflows/build.yml`, `.github/workflows/winget.yml`, `docs/project/release-process.md`
- https://wiki.debian.org/DebianRepository/UseThirdParty
- https://wiki.debian.org/DebianRepository/Format
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- https://code.visualstudio.com/docs/setup/linux
- https://ubuntu.com/server/docs/how-to/software/automatic-updates/
