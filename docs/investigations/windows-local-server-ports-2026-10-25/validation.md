# Windows local-server fallback validation — #1248

Date: 2026-10-25. Baseline: `82cb92637134242f8a7d462f3db6028fccd2dde4`.

## Automated coverage

- Full `npm test`: **13,418 passed, 74 skipped, 0 failed** (13,492 tests, 1,189 suites). The skipped platform/environment tests remain skipped; they are not counted as successful runtime validation.
- `test/local-server-fallback.test.js`: EACCES / EADDRINUSE fallback, initial and later synchronous throws, actual address port, persistent-hint reuse/drift, dynamic publication failure, bounded diagnostics, late-error settlement, local URL ownership and remote-port boundaries.
- `test/local-port-clients.test.js`: actual loopback HTTP delivery from CJS, OpenCode v1/v2, MiMo, OpenClaw, DSH, Pi and OMP, including the first request after a stale cached port. OpenCode strict permission targets retain live-owner checks. Hermes state/permission retry and cache behavior use its actual Python module with a controlled HTTP transport.
- The same JSON value table runs through all deployed JS/TS/Python runtime readers. Malformed values, foreign app markers and noncanonical strings are rejected. Numeric JSON forms with equal parsed values agree across languages.
- Claude and CodeBuddy install/uninstall migrate legacy → dynamic → different dynamic → legacy URLs while preserving a third-party plain dynamic `/permission` endpoint. Remote ingress rejects the local marker even with a valid nonce. Local Origin/Host/Content-Type guards apply to the new path.

## Windows runtime evidence

Windows build **10.0.26200**, Node **24.12.0**. No service, firewall, proxy, port reservation, or network configuration was changed. The test package ran in a dedicated temporary checkout with an isolated HOME / USERPROFILE / APPDATA / LOCALAPPDATA / HOMEDRIVE / HOMEPATH. The process asserted its effective home and runtime path before importing the server. Runtime and hint IO were explicitly injected; startup integration sync was captured, not executed.

The machine's normal Clawd range was not excluded. Read-only `netsh interface ipv4 show excludedportrange protocol=tcp` showed **50060–50159** naturally excluded. The test injected **50060–50064** as the server's candidates, exercising real Windows bind failures without changing system reservations. This is not an exact reproduction of the reporter's 23240–23339 exclusion on build 10.0.26300.

`test/fixtures/windows-local-port-smoke.js` observed:

1. All five injected ports returned **EACCES**, then `listen(0)` bound **59824**.
2. Runtime publication, health response port, Doctor pass and a real state POST succeeded.
3. Normal cleanup removed runtime; the private hint retained 59824. Restart reused **59824**.
4. A test-owned listener occupied 59824. Restart observed **EADDRINUSE**, then bound **50767**.
5. Injected runtime publication failure closed the dynamic listener, returned null and scheduled no integration sync.

The seven cross-language/client tests also passed on this Windows host. Real **PowerShell 5.1.26100.9711** ran the production NSIS fallback script against isolated settings: it removed the two owned URLs and preserved all **nine** foreign variants, including plain dynamic `/permission`, trailing slash, query, fragment, dot segment, doubled slash, case variation and trailing newline/carriage return.

## macOS real Claude approval

Tested commit `104c268ebc61dfb35cdc6a1d891cc81cc1acec0a` on **macOS 26.6.2 arm64**, **Electron 41.10.4**, **Claude Code 2.1.296 / claude-opus-5-5**. Claude used the existing logged-in account through its normal configuration home; no credentials were copied. A temporary per-invocation settings file directed only this test session's Bash PermissionRequest to the test listener.

The production server and permission modules ran with the actual `bubble.html`, preload and permission IPC handlers in a separate Electron harness. The harness supplied window geometry and disabled integration sync and runtime/hint file writes, so this validates the real approval round trip and rendering, not full packaged-app startup or persistence.

1. The OS selected local port **65469**, outside the five legacy ports.
2. Real Claude sent `POST /permission/clawd-on-desk` and waited. The production bubble visibly showed the exact Bash command to write one proof file in the dedicated temporary working directory.
3. Codex expanded the details and clicked **Approve** through native desktop controls. No test helper or direct IPC call resolved the permission.
4. The request completed with **HTTP 200**; Claude created the expected proof file with content `approved`, returned `APPROVAL_TEST_DONE`, and exited **0** with no permission denials. The bubble closed and no request remained pending.

The screenshot and bounded observation record are retained locally. The test Electron instance was closed afterward; the existing desktop pet and its integration settings were not changed. The earlier separate-home CLI probe that stopped at login is superseded for this approval-interaction check.

## macOS full-app startup and restart

Tested commit `1b08b25ee65db9f80c5ba053e11ac4c9bcde18da` with the unchanged production `src/main.js` in Electron, using a temporary home and application profile. The bootstrap only redirected filesystem paths and asserted source mode; the server, runtime/hint persistence, installers and startup integration sync were not stubbed. Only the isolated Claude integration was enabled.

1. Port 23333 was already occupied; test-owned listeners occupied 23334–23337 without disturbing the existing listener. Full-app startup selected **57830**, published the real runtime record and saved the port hint.
2. Actual startup sync replaced the isolated legacy Claude HTTP hook with `http://127.0.0.1:57830/permission/clawd-on-desk`. The state endpoint returned **200**, and native desktop inspection confirmed the rendered pet.
3. A normal quit through the application menu exited **0**, removed runtime and retained the port hint.
4. The second full-app launch reused **57830** and the same approval URL; the state endpoint returned **200** again. A normal quit through the pet menu again exited **0**, removed runtime and retained the hint.
5. The user's daily Claude settings and Clawd runtime files had unchanged hashes throughout both launches. Test-owned listeners were closed and the temporary Electron app copy was removed after completion.

The supervisor reported **PASS** for both launches and exits. Screenshots, startup logs and the bounded result record are retained locally. This verifies full source-app startup, real integration sync and normal restart persistence; it does not claim packaged-distribution validation or in-flight CLI hook reload.

## Acceptance limits

- The reporter's exact machine and excluded default range remain untested.
- Full packaged Electron UI remains unverified. The separate checks above cover the real Claude approval round trip and full source-app startup/restart, respectively.
- In-flight CLI HTTP-hook configuration reload after a forced port change remains unverified. The saved port hint reduces normal restart drift, and the documentation states that an existing CLI session may need reload/restart.
- Separate-home WSL dynamic-port discovery, Mobile Preview fallback and older-version cleanup are explicitly outside this change's supported scope.

## Implementation review

Claude reviewed the plan in two rounds and then reviewed implementation commit `e8952063f6ccbcff8a28e7446f5855d4f79fe507`: **PASS WITH NOTES**, with no evidenced P1/P2 blocker. This was a read-only review; the automated and Windows test results above were run by Codex.

Codex independently confirmed and fixed both nonblocking notes: preserve logging of server errors after startup without restarting the bind loop, and let the Wayland smoke script read a dynamic runtime port and include that port in teardown checks and diagnostics. Follow-up validation: **57 targeted tests passed, 0 failed**, shell syntax passed, and isolated shell-function checks covered 11 runtime validation cases plus dynamic/legacy teardown detection. This does not constitute a packaged Wayland run.

The evidence is limited to the checks described above. Packaged-distribution testing and forced-port-change hook reload were not included in the agreed final smoke test. Full review exports and independent adjudications are retained locally; only this bounded validation record is published with the code.
