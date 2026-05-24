cc-connect-clawd sidecar binaries
=================================

Electron packaged builds copy this directory to:

  resources/sidecars/cc-connect-clawd/

Place built sidecar binaries in platform/architecture directories:

  windows-x64/cc-connect-clawd.exe
  windows-arm64/cc-connect-clawd.exe
  darwin-x64/cc-connect-clawd
  darwin-arm64/cc-connect-clawd
  linux-x64/cc-connect-clawd
  linux-arm64/cc-connect-clawd

Clawd release builds fetch the pinned public fork release with:

  npm run fetch:sidecars

Source checkouts run a lightweight preflight before `npm start`. It downloads
the current platform's pinned sidecar when missing, verifies the downloaded
archive and extracted binary against SHA256 values pinned in
`scripts/fetch-sidecar-binaries.js`, and then continues launching Clawd. To skip that network preflight, set
`CLAWD_SKIP_SIDECAR_FETCH=1`. Setting `CLAWD_CC_CONNECT_CLAWD_PATH` to an
existing executable or containing directory also skips the preflight fetch.

The fetch script downloads release archives from
`rullerzhou-afk/cc-connect-clawd`, verifies the source-pinned checksums, and
extracts the binaries into this directory layout. Do not use upstream latest
artifacts.

Upstream `chenhg5/cc-connect` updates are not consumed automatically. To update
the sidecar dependency, sync the public `cc-connect-clawd` fork from upstream,
review and test the Clawd bridge changes, publish a new fixed sidecar release
tag such as `clawd-sidecar-v0.1.1`, then update the pinned tag in
`scripts/fetch-sidecar-binaries.js` and run the sidecar fetch/verify tests.

The resolver uses Go-style OS names (`windows`, `darwin`, `linux`) and
Electron/Node architecture names (`x64`, `arm64`). Source runs use this same
layout under the repo-local `bin/cc-connect-clawd/` directory.

For development, `CLAWD_CC_CONNECT_CLAWD_PATH` takes precedence. It may point
directly to a sidecar executable, or to a directory containing
`cc-connect-clawd` / `cc-connect-clawd.exe`.
